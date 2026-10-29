// Topes de usos de las promociones (5.44). Sin base de datos: evaluador puro y servicio contra almacenes falsos.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { evaluarPromociones } from "../src/promociones/evaluador.js";
import { validarPromocion } from "../src/promociones/validacion.js";
import { crearServicioPromociones } from "../src/promociones/index.js";
import { ErrorAuth } from "../src/auth/errores.js";
import { conEmpresa, empresaActual } from "../src/tenancy.js";

const L = (codigo, cantidad, precio, categoria = null, id = codigo) => ({ id, codigo, categoria, cantidad, precio });
const item = (codigo) => ({ itemCodigo: codigo, categoria: null });
const P = (o) => ({
  id: "p1", nombre: "Promo", activa: true, prioridad: 100, acumulable: false, descripcion: null, objetivo: null, disparador: null,
  n: null, m: null, efecto: null, valor: null, vigencia: null, dias: null, horario: null, topes: null, ...o,
});
const AHORA = new Date("2026-10-23T01:00:00Z"); // jueves 22 de octubre, 20:00 en Lima
const ev = (lineas, promociones, cupos = {}) => evaluarPromociones({ lineas, promociones, ahora: AHORA, zona: "America/Lima", cupos });

describe("evaluador: tope por pedido y cupos", () => {
  it("directo: el tope por pedido limita cuántas unidades se rebajan y lo avisa", () => {
    const p = P({ tipo: "directo", objetivo: item("X"), efecto: "porcentaje", valor: 50, topes: { porPedido: 2, diario: null, porCliente: null } });
    const r = ev([L("X", 5, 10)], [p]);
    assert.equal(r.descuentoTotal, 10);
    assert.equal(r.aplicadas[0].veces, 2);
    assert.deepEqual(r.topadas, [{ id: "p1", nombre: "Promo", motivo: "pedido" }]);
  });

  it("sin tope o con tope que no se alcanza: sin aviso", () => {
    const p = P({ tipo: "directo", objetivo: item("X"), efecto: "gratis", topes: { porPedido: 5, diario: null, porCliente: null } });
    const r = ev([L("X", 3, 10)], [p]);
    assert.equal(r.descuentoTotal, 30);
    assert.deepEqual(r.topadas, []);
  });

  it("nxm: con tope 1, de cuatro lattes en 2x1 solo una sale gratis", () => {
    const p = P({ tipo: "nxm", n: 2, m: 1, objetivo: item("L"), topes: { porPedido: 1, diario: null, porCliente: null } });
    const r = ev([L("L", 4, 10)], [p]);
    assert.equal(r.descuentoTotal, 10);
    assert.equal(r.topadas.length, 1);
  });

  it("combo: el tope corta las aplicaciones", () => {
    const p = P({ tipo: "combo", disparador: item("S"), objetivo: item("C"), efecto: "gratis", topes: { porPedido: 1, diario: null, porCliente: null } });
    const r = ev([L("S", 3, 20), L("C", 3, 8)], [p]);
    assert.equal(r.descuentoTotal, 8);
  });

  it("los cupos de día/cliente mandan si son más chicos que el tope por pedido, con su motivo", () => {
    const p = P({ tipo: "directo", objetivo: item("X"), efecto: "gratis", topes: { porPedido: 4, diario: 10, porCliente: null } });
    const r = ev([L("X", 6, 10)], [p], { p1: { max: 1, motivo: "dia" } });
    assert.equal(r.descuentoTotal, 10);
    assert.equal(r.topadas[0].motivo, "dia");
    const r2 = ev([L("X", 6, 10)], [p], { p1: { max: 9, motivo: "dia" } });
    assert.equal(r2.descuentoTotal, 40);
    assert.equal(r2.topadas[0].motivo, "pedido");
  });

  it("cupo 0: la promoción no se aplica y avisa", () => {
    const p = P({ tipo: "directo", objetivo: item("X"), efecto: "gratis", topes: { porPedido: null, diario: null, porCliente: 2 } });
    const r = ev([L("X", 2, 10)], [p], { p1: { max: 0, motivo: "sin_cliente" } });
    assert.equal(r.descuentoTotal, 0);
    assert.equal(r.topadas[0].motivo, "sin_cliente");
  });
});

describe("validación de topes", () => {
  const base = { nombre: "D", tipo: "directo", objetivo: item("X"), efecto: "gratis" };
  it("sin topes es null; con alguno se normalizan los tres", () => {
    assert.equal(validarPromocion(base).topes, null);
    assert.deepEqual(validarPromocion({ ...base, topes: { diario: 50 } }).topes, { diario: 50, porPedido: null, porCliente: null });
    assert.equal(validarPromocion({ ...base, topes: { diario: null, porPedido: "", porCliente: undefined } }).topes, null);
  });
  it("rechaza no enteros, cero, negativos, excesos y claves ajenas", () => {
    for (const t of [{ diario: 0 }, { diario: -1 }, { porPedido: 1.5 }, { porCliente: "3x" }, { diario: 100001 }, { raro: 1 }, [1]]) {
      assert.throws(() => validarPromocion({ ...base, topes: t }), /tope/i, JSON.stringify(t));
    }
  });
});

// ---------- servicio con contadores falsos ----------
const E1 = "aaaaaaaaaaaaaaaaaaaaaaa1";
const E2 = "aaaaaaaaaaaaaaaaaaaaaaa2";
const ADM = { usuarioId: "0123456789abcdef01234567", permisos: ["*"] };

function crearMundo() {
  const propias = (filas) => filas.filter((f) => f.empresaId === empresaActual());
  const cumple = (d, f) =>
    Object.entries(f).every(([k, v]) => {
      if (v && typeof v === "object" && !(v instanceof Date)) {
        if ("$lte" in v && !(d[k] <= v.$lte)) return false;
        if ("$gte" in v && !(d[k] >= v.$gte)) return false;
        return true;
      }
      return String(d[k] ?? null) === String(v ?? null);
    });
  const q = (fn) => {
    const o = { lean: () => o, sort: () => o, then: (ok, ko) => Promise.resolve().then(() => structuredClone(fn())).then(ok, ko) };
    return o;
  };
  const almacen = (claveUnica) => {
    const filas = [];
    const fallos = { siguiente: null };
    return {
      _filas: filas,
      fallos,
      find: (f = {}) => q(() => propias(filas).filter((d) => cumple(d, f))),
      findOne: (f) => q(() => propias(filas).find((d) => cumple(d, f)) ?? null),
      async deleteOne(f) {
        const i = filas.findIndex((d) => d.empresaId === empresaActual() && cumple(d, f));
        if (i >= 0) filas.splice(i, 1);
      },
      async updateOne(f, cambio, op = {}) {
        if (fallos.siguiente) {
          const e = fallos.siguiente;
          fallos.siguiente = null;
          throw e;
        }
        const d = propias(filas).find((x) => cumple(x, f));
        const inc = cambio.$inc ?? {};
        if (d) {
          Object.assign(d, structuredClone(cambio.$set ?? {}));
          for (const [k, v] of Object.entries(inc)) d[k] = (d[k] ?? 0) + v;
          return { matchedCount: 1 };
        }
        if (!op.upsert) return { matchedCount: 0 };
        const clave = Object.fromEntries(claveUnica.map((k) => [k, f[k] ?? null]));
        if (propias(filas).some((x) => claveUnica.every((k) => String(x[k] ?? null) === String(clave[k])))) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
        const nuevo = { empresaId: empresaActual(), usos: 0, ...clave, ...structuredClone(cambio.$set ?? {}), ...structuredClone(cambio.$setOnInsert ?? {}) };
        for (const [k, v] of Object.entries(inc)) nuevo[k] = (nuevo[k] ?? 0) + v;
        filas.push(nuevo);
        return { upsertedCount: 1 };
      },
    };
  };
  const promos = [];
  const Promocion = {
    find: (f = {}) => q(() => propias(promos).filter((d) => cumple(d, f))),
    findOne: (f) => q(() => propias(promos).find((d) => cumple(d, f)) ?? null),
    async countDocuments() { return propias(promos).length; },
    async create(doc) {
      const p = { _id: String(promos.length + 1).padStart(24, "0"), empresaId: empresaActual(), createdAt: new Date(), updatedAt: new Date(), ...structuredClone(doc) };
      promos.push(p);
      return { toObject: () => structuredClone(p) };
    },
    async updateOne(f, c) {
      const p = propias(promos).find((x) => cumple(x, f));
      if (p) Object.assign(p, structuredClone(c.$set));
    },
  };
  const UsoPromocion = almacen(["promocionId", "dia", "clienteId"]);
  const ReservaPromocion = almacen(["promocionId", "referencia"]);
  const Empresa = { findById: () => q(() => ({ _id: E1, pais: "PE" })) };
  const auth = { exigirCsrf() {} };
  const servicio = crearServicioPromociones({ Empresa, Promocion, UsoPromocion, ReservaPromocion }, auth);
  const en = (fn, e = E1) => conEmpresa(e, fn);
  return {
    servicio, UsoPromocion, ReservaPromocion, promos, en,
    crear: (o) => en(() => servicio.crear({ empresaId: E1, actor: ADM, ...o })),
    cupos: (o) => en(() => servicio.cupos({ empresaId: E1, ahora: AHORA, ...o })),
    confirmar: (o) => en(() => servicio.confirmarUsos({ empresaId: E1, ahora: AHORA, ...o })),
    liberar: (o) => en(() => servicio.liberarUsos({ empresaId: E1, ahora: AHORA, ...o })),
    contador: (id, cliente = null) => UsoPromocion._filas.find((f) => String(f.promocionId) === id && f.clienteId === cliente)?.usos ?? 0,
  };
}
const dir = (o = {}) => ({ nombre: "Gratis", tipo: "directo", objetivo: item("X"), efecto: "gratis", ...o });

describe("contadores: cupos, confirmar y liberar", () => {
  let m, id;
  beforeEach(async () => {
    m = crearMundo();
    id = (await m.crear(dir({ topes: { diario: 3 } }))).id;
  });

  it("cupos: sin uso queda el tope entero; las promociones sin tope diario/cliente no aparecen", async () => {
    await m.crear(dir({ nombre: "Libre" }));
    await m.crear(dir({ nombre: "Solo pedido", topes: { porPedido: 2 } }));
    assert.deepEqual(await m.cupos({ referencia: "PD-1" }), { [id]: { max: 3, motivo: "dia" } });
  });

  it("confirmar toma usos, es idempotente al repetir y recalcular sube o baja la diferencia", async () => {
    assert.equal((await m.confirmar({ referencia: "PD-1", usos: { [id]: 2 } })).ok, true);
    assert.equal(m.contador(id), 2);
    await m.confirmar({ referencia: "PD-1", usos: { [id]: 2 } });
    assert.equal(m.contador(id), 2);
    await m.confirmar({ referencia: "PD-1", usos: { [id]: 3 } });
    assert.equal(m.contador(id), 3);
    await m.confirmar({ referencia: "PD-1", usos: { [id]: 1 } });
    assert.equal(m.contador(id), 1);
    assert.equal(m.ReservaPromocion._filas.length, 1);
  });

  it("otro pedido ve lo que queda; el propio pedido ve lo suyo más lo libre", async () => {
    await m.confirmar({ referencia: "PD-1", usos: { [id]: 2 } });
    assert.equal((await m.cupos({ referencia: "PD-2" }))[id].max, 1);
    assert.equal((await m.cupos({ referencia: "PD-1" }))[id].max, 3);
  });

  it("no deja pasar el tope: el segundo pedido que pide de más recibe ok:false y no cambia nada", async () => {
    await m.confirmar({ referencia: "PD-1", usos: { [id]: 2 } });
    const r = await m.confirmar({ referencia: "PD-2", usos: { [id]: 2 } });
    assert.equal(r.ok, false);
    assert.equal(m.contador(id), 2);
    assert.equal(m.ReservaPromocion._filas.length, 1);
  });

  it("carrera: dos pedidos que leyeron el mismo cupo no pueden pasarse (el filtro condicionado manda)", async () => {
    const a = m.cupos({ referencia: "PD-A" });
    const b = m.cupos({ referencia: "PD-B" });
    assert.equal((await a)[id].max, 3);
    assert.equal((await b)[id].max, 3);
    const rs = await Promise.all([m.confirmar({ referencia: "PD-A", usos: { [id]: 2 } }), m.confirmar({ referencia: "PD-B", usos: { [id]: 2 } })]);
    assert.deepEqual(rs.map((r) => r.ok).sort(), [false, true]);
    assert.equal(m.contador(id), 2);
  });

  it("liberar devuelve todo y borra la reserva; liberar dos veces no resta de más", async () => {
    await m.confirmar({ referencia: "PD-1", usos: { [id]: 2 } });
    await m.confirmar({ referencia: "PD-2", usos: { [id]: 1 } });
    await m.liberar({ referencia: "PD-1" });
    assert.equal(m.contador(id), 1);
    await m.liberar({ referencia: "PD-1" });
    assert.equal(m.contador(id), 1);
    assert.equal(m.ReservaPromocion._filas.length, 1);
  });

  it("el día es el de la primera reserva: un pedido que cruza la medianoche sigue en su día", async () => {
    await m.confirmar({ referencia: "PD-1", usos: { [id]: 1 } });
    const manana = new Date(AHORA.getTime() + 24 * 3600 * 1000);
    await m.confirmar({ referencia: "PD-1", usos: { [id]: 2 }, ahora: manana });
    assert.equal(m.UsoPromocion._filas.length, 1);
    assert.equal(m.contador(id), 2);
    assert.equal((await m.cupos({ referencia: "PD-9", ahora: manana }))[id].max, 3, "mañana otro pedido tiene el cupo entero");
  });

  it("reducir un tope por debajo de lo ya tomado no quita lo concedido", async () => {
    await m.confirmar({ referencia: "PD-1", usos: { [id]: 3 } });
    await m.en(() => m.servicio.editar({ empresaId: E1, actor: ADM, promocionId: id, topes: { diario: 1 } }));
    assert.equal((await m.cupos({ referencia: "PD-1" }))[id].max, 3);
    assert.equal((await m.cupos({ referencia: "PD-2" }))[id].max, 0);
  });

  it("un fallo de base en medio deshace lo ya tomado", async () => {
    const id2 = (await m.crear(dir({ nombre: "Otra", topes: { diario: 5 } }))).id;
    // el primer updateOne funciona, el segundo falla
    const orig = m.UsoPromocion.updateOne.bind(m.UsoPromocion);
    let n = 0;
    m.UsoPromocion.updateOne = (...a) => (++n === 2 ? Promise.reject(new Error("caída")) : orig(...a));
    await assert.rejects(m.confirmar({ referencia: "PD-1", usos: { [id]: 1, [id2]: 1 } }), /caída/);
    m.UsoPromocion.updateOne = orig;
    assert.equal(m.contador(id) + m.contador(id2), 0);
  });

  it("aislado por empresa", async () => {
    await m.confirmar({ referencia: "PD-1", usos: { [id]: 3 } });
    const otra = await m.en(() => m.servicio.cupos({ empresaId: E2, referencia: "PD-1", ahora: AHORA }), E2).catch(() => ({}));
    assert.deepEqual(otra, {});
  });
});

describe("tope por cliente", () => {
  let m, id;
  beforeEach(async () => {
    m = crearMundo();
    id = (await m.crear(dir({ topes: { porCliente: 2 } }))).id;
  });

  it("sin cliente la promoción no aplica (cupo 0, «sin_cliente»); con cliente rige su cupo", async () => {
    assert.deepEqual((await m.cupos({ referencia: "PD-1" }))[id], { max: 0, motivo: "sin_cliente" });
    assert.deepEqual((await m.cupos({ referencia: "PD-1", clienteId: "c1" }))[id], { max: 2, motivo: "cliente" });
    assert.equal((await m.confirmar({ referencia: "PD-1", usos: { [id]: 1 } })).ok, false);
  });

  it("cada cliente tiene su contador; el tope se agota por cliente y por día", async () => {
    await m.confirmar({ referencia: "PD-1", clienteId: "c1", usos: { [id]: 2 } });
    assert.equal((await m.cupos({ referencia: "PD-2", clienteId: "c1" }))[id].max, 0);
    assert.equal((await m.cupos({ referencia: "PD-2", clienteId: "c2" }))[id].max, 2);
    assert.equal((await m.confirmar({ referencia: "PD-2", clienteId: "c1", usos: { [id]: 1 } })).ok, false);
    const manana = new Date(AHORA.getTime() + 24 * 3600 * 1000);
    assert.equal((await m.cupos({ referencia: "PD-3", clienteId: "c1", ahora: manana }))[id].max, 2);
  });

  it("si el pedido cambia de cliente, el uso se muda de contador", async () => {
    await m.confirmar({ referencia: "PD-1", clienteId: "c1", usos: { [id]: 2 } });
    await m.confirmar({ referencia: "PD-1", clienteId: "c2", usos: { [id]: 2 } });
    assert.equal(m.contador(id, "c1"), 0);
    assert.equal(m.contador(id, "c2"), 2);
  });

  it("diario y por cliente a la vez: manda el más chico y cuenta en los dos", async () => {
    const m2 = crearMundo();
    const id2 = (await m2.crear(dir({ topes: { diario: 3, porCliente: 2 } }))).id;
    await m2.confirmar({ referencia: "PD-1", clienteId: "c1", usos: { [id2]: 2 } });
    assert.equal(m2.contador(id2), 2);
    assert.equal(m2.contador(id2, "c1"), 2);
    assert.deepEqual((await m2.cupos({ referencia: "PD-2", clienteId: "c2" }))[id2], { max: 1, motivo: "dia" });
    assert.equal((await m2.confirmar({ referencia: "PD-2", clienteId: "c2", usos: { [id2]: 2 } })).ok, false);
    assert.equal(m2.contador(id2, "c2"), 0, "el contador del cliente también se deshace");
  });
});

describe("servicio: topes en el DTO", () => {
  it("la promoción devuelve sus topes; sin topes, null; vigentes no los expone", async () => {
    const m = crearMundo();
    const p = await m.crear(dir({ topes: { diario: 10, porCliente: 1 } }));
    assert.deepEqual(p.topes, { diario: 10, porPedido: null, porCliente: 1 });
    assert.equal((await m.crear(dir({ nombre: "B" }))).topes, null);
    const v = await m.en(() => m.servicio.vigentes({ empresaId: E1, ahora: AHORA }));
    assert.ok(JSON.stringify(v).indexOf("topes") === -1);
  });
});
