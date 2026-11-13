// Servicio del kardex (5.75) contra almacenes falsos en memoria que imitan los dos índices únicos del libro.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { crearServicioKardex } from "../src/kardex/index.js";
import { montarRutasKardex } from "../src/kardex/rutas.js";
import { ErrorKardex } from "../src/kardex/errores.js";
import { ErrorAuth } from "../src/auth/errores.js";
import { conEmpresa, empresaActual } from "../src/tenancy.js";

const E1 = "aaaaaaaaaaaaaaaaaaaaaaa1";
const E2 = "aaaaaaaaaaaaaaaaaaaaaaa2";
const ADM = { usuarioId: "0123456789abcdef01234567", permisos: ["*"] };
const LECTOR = { usuarioId: "0123456789abcdef01234568", permisos: ["kardex:leer"] };
const COMPRADOR = { usuarioId: "0123456789abcdef01234569", permisos: ["kardex:registrar"] };
const MESERO = { usuarioId: "0123456789abcdef0123456a", permisos: ["fidelizacion:canjear"] };
const rechaza = (p, codigo, status) =>
  assert.rejects(p, (e) => e instanceof ErrorKardex && e.codigo === codigo && (status === undefined || e.status === status));

const cmp = (d, k, v) => {
  if (v && typeof v === "object" && !(v instanceof Date)) {
    return Object.entries(v).every(([op, x]) => (op === "$lt" ? d[k] < x : op === "$gte" ? d[k] >= x : op === "$lte" ? d[k] <= x : false));
  }
  return String(d[k]) === String(v);
};
const coincide = (d, f) => Object.entries(f).every(([k, v]) => cmp(d, k, v));

function almacen(filas, { unicos = [], alCrear, defectos = {} } = {}) {
  let n = 0;
  const propias = () => filas.filter((p) => p.empresaId === empresaActual());
  const consulta = (fn) => {
    const q = { _orden: null, _skip: 0, _limit: Infinity };
    q.lean = () => q;
    q.sort = (o) => ((q._orden = o), q);
    q.skip = (x) => ((q._skip = x), q);
    q.limit = (x) => ((q._limit = x), q);
    q.then = (ok, ko) =>
      Promise.resolve()
        .then(() => {
          let r = fn();
          if (Array.isArray(r)) {
            if (q._orden) {
              const claves = Object.entries(q._orden);
              r = [...r].sort((a, b) => {
                for (const [k, dir] of claves) {
                  if (a[k] === b[k]) continue;
                  return (a[k] < b[k] ? -1 : 1) * dir;
                }
                return 0;
              });
            }
            r = r.slice(q._skip, q._skip + q._limit);
          }
          return structuredClone(r);
        })
        .then(ok, ko);
    return q;
  };
  return {
    _filas: filas,
    find: (f = {}) => consulta(() => propias().filter((p) => coincide(p, f))),
    findOne: (f) => {
      const q = consulta(() => propias().filter((p) => coincide(p, f)));
      const entonces = q.then;
      q.then = (ok, ko) => entonces((r) => r[0] ?? null).then(ok, ko);
      return q;
    },
    async countDocuments(f = {}) {
      return propias().filter((p) => coincide(p, f)).length;
    },
    async create(doc) {
      if (alCrear) await alCrear(doc, filas);
      for (const { campos, nombre, soloSi } of unicos) {
        if (soloSi && !soloSi(doc)) continue;
        if (propias().some((p) => campos.every((c) => String(p[c]) === String(doc[c])))) {
          throw Object.assign(new Error(`E11000 ${nombre}`), { code: 11000, keyPattern: Object.fromEntries(campos.map((c) => [c, 1])) });
        }
      }
      const p = { _id: String(++n).padStart(24, "0"), empresaId: empresaActual(), createdAt: new Date(), ...defectos, ...structuredClone(doc) };
      filas.push(p);
      return { toObject: () => structuredClone(p) };
    },
    async updateOne(f, cambio) {
      const p = propias().find((x) => coincide(x, f));
      if (!p) return { matchedCount: 0 };
      Object.assign(p, structuredClone(cambio.$set));
      return { matchedCount: 1 };
    },
  };
}

function crearMundo({ alCrearMov } = {}) {
  const insumos = almacen([], { unicos: [{ campos: ["codigoClave"], nombre: "codigo" }], defectos: { existencia: 0, costoPromedio: 0, ultimaSecuencia: 0, stockMinimo: 0, activo: true } });
  const movs = almacen([], {
    alCrear: alCrearMov,
    unicos: [
      { campos: ["insumoId", "secuencia"], nombre: "secuencia_unica" },
      { campos: ["insumoId", "referencia", "tipo"], nombre: "referencia_unica", soloSi: (d) => typeof d.referencia === "string" },
    ],
  });
  const Empresa = { findById: (id) => ({ lean: () => Promise.resolve({ _id: id }) }) };
  const auth = {
    exigirCsrf(req) {
      if (req.method !== "GET" && !req.headers?.["x-requested-with"]) throw new ErrorAuth("CSRF", "falta la cabecera x-requested-with");
    },
  };
  const k = crearServicioKardex({ Empresa, Insumo: insumos, MovimientoKardex: movs }, auth);
  const en = (e, fn) => conEmpresa(e, fn);
  const crearInsumo = (o = {}, actor = ADM, e = E1) =>
    en(e, () => k.crearInsumo({ empresaId: e, actor, codigo: "CAFE", nombre: "Café", unidad: "g", presentaciones: [{ nombre: "paquete", factor: 500 }], ...o }));
  const op = (nombre, o, actor = ADM, e = E1) => en(e, () => k[nombre]({ empresaId: e, actor, ...o }));
  return { k, insumos, movs, en, crearInsumo, op };
}

describe("insumos", () => {
  let m;
  beforeEach(() => (m = crearMundo()));

  it("crear exige gestionar; el código no se repite (sin mayúsculas) y es por empresa", async () => {
    await rechaza(m.crearInsumo({}, LECTOR), "PERMISO_INSUFICIENTE", 403);
    await rechaza(m.crearInsumo({}, null), "PERMISO_INSUFICIENTE", 403);
    const i = await m.crearInsumo();
    assert.deepEqual([i.codigo, i.existencia, i.activo], ["CAFE", 0, true]);
    await rechaza(m.crearInsumo({ codigo: "cafe" }), "INSUMO_DUPLICADO", 409);
    await m.crearInsumo({}, ADM, E2);
    await rechaza(m.crearInsumo({ nombre: "" , codigo: "X"}), "DATOS_INVALIDOS", 400);
  });

  it("editar cambia lo enviado, no la unidad, y desactivar no borra", async () => {
    const i = await m.crearInsumo();
    const r = await m.op("editarInsumo", { insumoId: i.id, nombre: "Café molido", stockMinimo: 200 });
    assert.deepEqual([r.nombre, r.stockMinimo], ["Café molido", 200]);
    await rechaza(m.op("editarInsumo", { insumoId: i.id, unidad: "kg" }), "DATOS_INVALIDOS");
    assert.equal((await m.op("editarInsumo", { insumoId: i.id, activo: false })).activo, false);
    assert.equal(m.insumos._filas.length, 1);
    await rechaza(m.op("editarInsumo", { insumoId: "bbbbbbbbbbbbbbbbbbbbbbb9", nombre: "x" }), "NO_ENCONTRADO", 404);
    await rechaza(m.op("editarInsumo", { insumoId: i.id, nombre: "x" }, LECTOR), "PERMISO_INSUFICIENTE", 403);
  });

  it("listar: permisos, búsqueda, inactivos y solo la propia empresa", async () => {
    await m.crearInsumo();
    await m.crearInsumo({ codigo: "LECHE", nombre: "Leche entera", unidad: "ml", presentaciones: [] });
    const viejo = await m.crearInsumo({ codigo: "TE", nombre: "Té", unidad: "g", presentaciones: [] });
    await m.op("editarInsumo", { insumoId: viejo.id, activo: false });
    await m.crearInsumo({ codigo: "AJENO" }, ADM, E2);
    assert.equal((await m.op("listarInsumos", {}, LECTOR)).total, 2);
    assert.equal((await m.op("listarInsumos", { incluirInactivos: true })).total, 3);
    assert.deepEqual((await m.op("listarInsumos", { texto: "lec" })).insumos.map((x) => x.codigo), ["LECHE"]);
    await rechaza(m.op("listarInsumos", {}, MESERO), "PERMISO_INSUFICIENTE", 403);
  });
});

describe("movimientos manuales", () => {
  let m;
  let cafe;
  beforeEach(async () => {
    m = crearMundo();
    cafe = await m.crearInsumo({ stockMinimo: 300 });
  });
  const compra = (o, actor = COMPRADOR) => m.op("registrarCompra", { insumoId: cafe.id, ...o }, actor);

  it("compra en presentación: convierte, valoriza y promedia", async () => {
    const r = await compra({ cantidad: 2, presentacion: "paquete", costo: 40 });
    assert.deepEqual([r.existencia, r.costoPromedio, r.negativo, r.bajoMinimo], [1000, 0.08, false, false]);
    assert.deepEqual(r.movimiento.presentacion, { nombre: "paquete", cantidad: 2, factor: 500 });
    const r2 = await compra({ cantidad: 1000, costoTotal: 120 });
    assert.deepEqual([r2.existencia, r2.costoPromedio], [2000, 0.1]);
    const ins = await m.op("obtenerInsumo", { insumoId: cafe.id }, LECTOR);
    assert.deepEqual([ins.existencia, ins.costoPromedio, ins.valor], [2000, 0.1, 200]);
  });

  it("permisos: comprar y mermar con registrar; contar e inicial con gestionar; leer no escribe", async () => {
    await rechaza(compra({ cantidad: 1, costo: 1 }, LECTOR), "PERMISO_INSUFICIENTE", 403);
    await rechaza(m.op("contar", { insumoId: cafe.id, cantidad: 1, detalle: "x" }, COMPRADOR), "PERMISO_INSUFICIENTE", 403);
    await rechaza(m.op("inventarioInicial", { insumoId: cafe.id, cantidad: 1, costo: 1 }, COMPRADOR), "PERMISO_INSUFICIENTE", 403);
    await compra({ cantidad: 100, costo: 1 });
    await m.op("registrarMerma", { insumoId: cafe.id, cantidad: 10, detalle: "se cayó" }, COMPRADOR);
  });

  it("merma exige motivo, sale al promedio y avisa del mínimo", async () => {
    await compra({ cantidad: 400, costo: 0.5 });
    await rechaza(m.op("registrarMerma", { insumoId: cafe.id, cantidad: 10 }, COMPRADOR), "DATOS_INVALIDOS");
    const r = await m.op("registrarMerma", { insumoId: cafe.id, cantidad: 150, detalle: "humedad" }, COMPRADOR);
    assert.deepEqual([r.existencia, r.movimiento.cantidad, r.movimiento.costoUnitario, r.movimiento.valor, r.bajoMinimo], [250, -150, 0.5, -75, true]);
  });

  it("inventario inicial solo si no hay movimientos", async () => {
    const r = await m.op("inventarioInicial", { insumoId: cafe.id, cantidad: 3, presentacion: "paquete", costoTotal: 90 });
    assert.deepEqual([r.existencia, r.costoPromedio, r.movimiento.tipo], [1500, 0.06, "inventario_inicial"]);
    await rechaza(m.op("inventarioInicial", { insumoId: cafe.id, cantidad: 1, costo: 1 }), "ESTADO_INVALIDO", 409);
  });

  it("conteo registra la diferencia como ajuste, sin movimiento si coincide", async () => {
    await compra({ cantidad: 1000, costo: 0.1 });
    await rechaza(m.op("contar", { insumoId: cafe.id, cantidad: 900 }), "DATOS_INVALIDOS");
    const baja = await m.op("contar", { insumoId: cafe.id, cantidad: 900, detalle: "conteo semanal" });
    assert.deepEqual([baja.movimiento.tipo, baja.movimiento.cantidad, baja.existencia], ["ajuste", -100, 900]);
    const alza = await m.op("contar", { insumoId: cafe.id, cantidad: 1, presentacion: "paquete", detalle: "hallé uno" });
    assert.deepEqual([alza.movimiento.cantidad, alza.existencia, alza.costoPromedio], [-400, 500, 0.1]);
    const igual = await m.op("contar", { insumoId: cafe.id, cantidad: 500, detalle: "otra vez" });
    assert.equal(igual.sinDiferencia, true);
    const n = m.movs._filas.length;
    assert.equal(n, 3);
  });

  it("el kardex no mezcla empresas ni insumos desactivados para comprar", async () => {
    await rechaza(m.op("registrarCompra", { insumoId: cafe.id, cantidad: 1, costo: 1 }, COMPRADOR, E2), "NO_ENCONTRADO", 404);
    await m.op("editarInsumo", { insumoId: cafe.id, activo: false });
    await rechaza(compra({ cantidad: 1, costo: 1 }), "ESTADO_INVALIDO", 409);
  });
});

describe("consumo desde pedidos", () => {
  let m;
  let cafe;
  let leche;
  beforeEach(async () => {
    m = crearMundo();
    cafe = await m.crearInsumo({ stockMinimo: 100 });
    leche = await m.crearInsumo({ codigo: "LECHE", nombre: "Leche", unidad: "ml", presentaciones: [{ nombre: "caja", factor: 1000 }] });
    await m.op("registrarCompra", { insumoId: cafe.id, cantidad: 500, costo: 0.1 }, COMPRADOR);
    await m.op("registrarCompra", { insumoId: leche.id, cantidad: 2, presentacion: "caja", costo: 5 }, COMPRADOR);
  });
  const consumir = (ref, lineas) => m.en(E1, () => m.k.consumirVarios({ empresaId: E1, referencia: ref, lineas }));
  const revertir = (ref) => m.en(E1, () => m.k.revertir({ empresaId: E1, referencia: ref, detalle: "anulado" }));

  it("descuenta, suma líneas repetidas del mismo insumo y avisa del mínimo", async () => {
    const r = await consumir("DOC_ITEM-1", [{ insumoId: cafe.id, cantidad: 15 }, { insumoId: cafe.id, cantidad: 395 }, { insumoId: leche.id, cantidad: 200 }]);
    assert.equal(r.errores.length, 0);
    const c = r.aplicados.find((x) => x.codigo === "CAFE");
    assert.deepEqual([c.cantidad, c.existencia, c.bajoMinimo, c.negativo], [410, 90, true, false]);
    assert.equal(r.aplicados.find((x) => x.codigo === "LECHE").existencia, 1800);
  });

  it("es idempotente por referencia", async () => {
    await consumir("DOC_ITEM-2", [{ insumoId: cafe.id, cantidad: 10 }]);
    const r = await consumir("DOC_ITEM-2", [{ insumoId: cafe.id, cantidad: 10 }]);
    assert.deepEqual([r.aplicados.length, r.yaRegistrados], [0, [cafe.id]]);
    assert.equal((await m.op("obtenerInsumo", { insumoId: cafe.id }, LECTOR)).existencia, 490);
  });

  it("nunca bloquea: queda en negativo y lo informa; insumo inexistente o inactivo va a errores", async () => {
    const r = await consumir("DOC_ITEM-3", [{ insumoId: cafe.id, cantidad: 700 }, { insumoId: "bbbbbbbbbbbbbbbbbbbbbbb9", cantidad: 1 }]);
    assert.equal(r.aplicados[0].negativo, true);
    assert.equal(r.aplicados[0].existencia, -200);
    assert.equal(r.errores[0].codigo, "NO_ENCONTRADO");
    const v = await m.op("valorizacion", {}, LECTOR);
    assert.deepEqual(v.negativos.map((x) => x.codigo), ["CAFE"]);
    await m.op("editarInsumo", { insumoId: leche.id, activo: false });
    const r2 = await consumir("DOC_ITEM-4", [{ insumoId: leche.id, cantidad: 1 }]);
    assert.equal(r2.errores[0].codigo, "ESTADO_INVALIDO");
  });

  it("revertir devuelve al costo original y es idempotente", async () => {
    await consumir("DOC_ITEM-5", [{ insumoId: cafe.id, cantidad: 100 }, { insumoId: leche.id, cantidad: 300 }]);
    await m.op("registrarCompra", { insumoId: cafe.id, cantidad: 100, costo: 0.5 }, COMPRADOR); // sube el promedio
    const r = await revertir("DOC_ITEM-5");
    assert.equal(r.aplicados.length, 2);
    const rev = (await m.op("movimientos", { insumoId: cafe.id, tipo: "reversa" }, LECTOR))[0];
    assert.deepEqual([rev.cantidad, rev.costoUnitario], [100, 0.1]);
    const otra = await revertir("DOC_ITEM-5");
    assert.deepEqual([otra.aplicados.length, otra.yaRegistrados.length], [0, 2]);
    assert.equal((await m.op("obtenerInsumo", { insumoId: leche.id }, LECTOR)).existencia, 2000);
  });

  it("datos malos de consumo", async () => {
    await assert.rejects(consumir("", []), (e) => e.codigo === "DATOS_INVALIDOS");
    await assert.rejects(consumir("R", [{ insumoId: "x", cantidad: 1 }]), (e) => e.codigo === "DATOS_INVALIDOS");
  });
});

describe("concurrencia y reparación", () => {
  it("dos movimientos simultáneos no pierden ninguno: la secuencia se reintenta", async () => {
    const m = crearMundo();
    const i = await m.crearInsumo();
    await m.op("registrarCompra", { insumoId: i.id, cantidad: 1000, costo: 1 }, COMPRADOR);
    const rs = await Promise.all(Array.from({ length: 6 }, (_, n) => m.k.consumirVarios({ empresaId: E1, referencia: `R${n}`, lineas: [{ insumoId: i.id, cantidad: 10 }] })));
    // consumirVarios llama sin contexto de empresa propio: lo da conEmpresa dentro del servicio
    assert.equal(rs.flatMap((r) => r.errores).length, 0);
    const secs = m.movs._filas.map((f) => f.secuencia).sort((a, b) => a - b);
    assert.deepEqual(secs, [1, 2, 3, 4, 5, 6, 7]);
    assert.equal((await m.op("obtenerInsumo", { insumoId: i.id }, LECTOR)).existencia, 940);
  });

  it("si otro se adelanta con la secuencia, reintenta con el estado nuevo", async () => {
    let inyectado = false;
    const m = crearMundo({
      alCrearMov: async (doc, filas) => {
        if (!inyectado && doc.secuencia === 2) {
          inyectado = true;
          filas.push({ _id: "f".repeat(24), empresaId: E1, insumoId: doc.insumoId, secuencia: 2, tipo: "compra", cantidad: 100, costoUnitario: 1, valor: 100, existenciaDespues: 1100, costoPromedioDespues: 1, ts: new Date() });
        }
      },
    });
    const i = await m.crearInsumo();
    await m.op("registrarCompra", { insumoId: i.id, cantidad: 1000, costo: 1 }, COMPRADOR);
    const r = await m.op("registrarMerma", { insumoId: i.id, cantidad: 50, detalle: "x" }, COMPRADOR);
    assert.equal(r.movimiento.secuencia, 3);
    assert.equal(r.existencia, 1050);
  });

  it("repararSaldo rehace la copia del insumo desde el libro", async () => {
    const m = crearMundo();
    const i = await m.crearInsumo();
    await m.op("registrarCompra", { insumoId: i.id, cantidad: 100, costo: 2 }, COMPRADOR);
    Object.assign(m.insumos._filas[0], { existencia: 5, costoPromedio: 9, ultimaSecuencia: 0 });
    const r = await m.op("repararSaldo", { insumoId: i.id });
    assert.deepEqual([r.existencia, r.costoPromedio], [100, 2]);
    await rechaza(m.op("repararSaldo", { insumoId: i.id }, LECTOR), "PERMISO_INSUFICIENTE", 403);
  });

  it("movimientos: filtros, orden reciente primero y límite", async () => {
    const m = crearMundo();
    const i = await m.crearInsumo();
    for (let n = 0; n < 5; n++) await m.op("registrarCompra", { insumoId: i.id, cantidad: 10, costo: 1 }, COMPRADOR);
    await m.op("registrarMerma", { insumoId: i.id, cantidad: 1, detalle: "x" }, COMPRADOR);
    const todos = await m.op("movimientos", { insumoId: i.id }, LECTOR);
    assert.equal(todos[0].tipo, "merma");
    assert.equal((await m.op("movimientos", { tipo: "compra", limite: 2 }, LECTOR)).length, 2);
    await rechaza(m.op("movimientos", { tipo: "raro" }, LECTOR), "DATOS_INVALIDOS");
    await rechaza(m.op("movimientos", { desde: "no-fecha" }, LECTOR), "DATOS_INVALIDOS");
    await rechaza(m.op("movimientos", {}, MESERO), "PERMISO_INSUFICIENTE", 403);
  });
});

describe("manejadores HTTP y rutas", () => {
  it("monta las 11 rutas con su permiso", () => {
    const pedidos = [];
    const rutas = [];
    const router = {};
    for (const v of ["get", "post", "put"]) router[v] = (ruta, ...hs) => rutas.push(`${v.toUpperCase()} ${ruta}`) && hs;
    const h = new Proxy({}, { get: () => () => {} });
    montarRutasKardex(router, { kardex: { manejadores: h }, autenticar: () => () => {}, requierePermiso: (p) => (pedidos.push(p), () => {}) });
    assert.equal(rutas.length, 11);
    assert.deepEqual([...new Set(pedidos)].sort(), ["kardex:gestionar", "kardex:leer", "kardex:registrar"]);
  });

  it("escritura sin cabecera CSRF se rechaza; con ella responde 201 y los errores salen con su status", async () => {
    const m = crearMundo();
    const llamar = async (nombre, req) => {
      const out = { status: null, body: null, status_(s) { this.status = s; return this; } };
      const res = { status(s) { out.status = s; return this; }, json(b) { out.body = b; return this; } };
      const base = { auth: { empresaId: E1, usuarioId: ADM.usuarioId }, rol: { permisos: ["*"] }, headers: {}, query: {}, params: {}, body: {}, ...req };
      await conEmpresa(E1, () => m.k.manejadores[nombre](base, res, (e) => { throw e; }));
      return out;
    };
    const sin = await llamar("crearInsumo", { method: "POST", body: { codigo: "A", nombre: "A", unidad: "g" } });
    assert.equal(sin.status, 403);
    assert.equal(sin.body?.codigo, "CSRF");
    const ok = await llamar("crearInsumo", { method: "POST", headers: { "x-requested-with": "x" }, body: { codigo: "A", nombre: "A", unidad: "g" } });
    assert.equal(ok.status, 201);
    const dup = await llamar("crearInsumo", { method: "POST", headers: { "x-requested-with": "x" }, body: { codigo: "a", nombre: "A", unidad: "g" } });
    assert.equal(dup.status, 409);
    const lista = await llamar("listarInsumos", { method: "GET" });
    assert.equal(lista.body.total, 1);
  });
});
