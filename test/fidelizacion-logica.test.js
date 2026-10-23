// No necesita base de datos: prueba la lógica de la fidelización contra almacenes falsos en memoria.
// Lo que depende de MongoDB de verdad (índice único de idempotencia, aggregate, tenancy) lo cubre fidelizacion.test.js.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { EventEmitter } from "node:events";
import { crearServicioFidelizacion } from "../src/fidelizacion/index.js";
import { ErrorFidelizacion } from "../src/fidelizacion/errores.js";
import { ErrorCliente } from "../src/clientes/errores.js";
import { ErrorAuth } from "../src/auth/errores.js";
import { calcularPuntos, configDe, validarConfig, validarDetalle, validarPuntos } from "../src/fidelizacion/config.js";
import { movimientoPuntosSchema } from "../src/fidelizacion/modelo.js";
import { conEmpresa, empresaActual } from "../src/tenancy.js";

const E1 = "aaaaaaaaaaaaaaaaaaaaaaa1";
const C1 = "bbbbbbbbbbbbbbbbbbbbbbb1";
const C2 = "bbbbbbbbbbbbbbbbbbbbbbb2";
const ADM = { usuarioId: "0123456789abcdef01234567", permisos: ["*"] };
const MESERO = { usuarioId: "0123456789abcdef01234568", permisos: ["fidelizacion:canjear", "cliente:leer"] };
const SIN_PERMISOS = { usuarioId: "0123456789abcdef01234569", permisos: ["cliente:leer"] };

const rechaza = (p, codigo, status) =>
  assert.rejects(p, (e) => e instanceof ErrorFidelizacion && e.codigo === codigo && (status === undefined || e.status === status));

// ---------- almacenes falsos ----------
function crearMundo({ empresa = {}, clientesBD } = {}) {
  const movs = [];
  let n = 0;
  const propios = () => movs.filter((m) => m.empresaId === empresaActual());
  const coincide = (d, f) => Object.entries(f).every(([k, v]) => String(d[k]) === String(v));

  const consulta = (fn) => {
    const q = { _sort: null, _lim: Infinity };
    q.lean = () => q;
    q.sort = () => ((q._sort = true), q);
    q.limit = (l) => ((q._lim = l), q);
    q.then = (ok, ko) =>
      Promise.resolve()
        .then(() => {
          let r = fn();
          if (Array.isArray(r) && q._sort) r = [...r].sort((a, b) => b.ts - a.ts || String(b._id).localeCompare(String(a._id)));
          if (Array.isArray(r)) r = r.slice(0, q._lim);
          return structuredClone(r);
        })
        .then(ok, ko);
    return q;
  };

  const MovimientoPuntos = {
    _movs: movs,
    find: (f) => consulta(() => propios().filter((m) => coincide(m, f))),
    findOne: (f) => consulta(() => propios().find((m) => coincide(m, f)) ?? null),
    async create(doc) {
      // el índice único parcial { empresaId, documentoCode, tipo }
      if (doc.documentoCode && propios().some((m) => m.documentoCode === doc.documentoCode && m.tipo === doc.tipo))
        throw Object.assign(new Error("E11000"), { code: 11000 });
      await Promise.resolve(); // cede el turno: así dos creaciones "simultáneas" se intercalan de verdad
      if (doc.documentoCode && propios().some((m) => m.documentoCode === doc.documentoCode && m.tipo === doc.tipo))
        throw Object.assign(new Error("E11000"), { code: 11000 });
      const m = { _id: String(++n).padStart(24, "0"), empresaId: empresaActual(), detalle: null, documentoCode: null, creadoPor: null, ...structuredClone(doc) };
      movs.push(m);
      return m;
    },
    async aggregate(pipeline) {
      const match = pipeline[0].$match;
      const filas = propios().filter((m) => String(m.clienteId) === String(match.clienteId));
      if (!filas.length) return [];
      return [{ _id: null, total: filas.reduce((s, m) => s + m.puntos, 0) }];
    },
    init: async () => {},
  };

  const emp = { _id: E1, activa: true, ...empresa };
  const Empresa = {
    findById: (id) => consulta(() => (String(id) === E1 ? emp : null)),
    async updateOne(f, u) {
      for (const [k, v] of Object.entries(u.$set ?? {})) {
        const [a, b] = k.split(".");
        emp[a] = { ...(emp[a] ?? {}), [b]: v };
      }
      return { matchedCount: 1 };
    },
  };

  // clientes falsos: { id: { nombre, activo, anonimizado, consiente } }
  const bd = clientesBD ?? { [C1]: { nombre: "Ana", activo: true, anonimizado: false, consiente: true } };
  const clientes = {
    async obtener({ clienteId }) {
      if (!/^[0-9a-f]{24}$/i.test(String(clienteId))) throw new ErrorCliente("DATOS_INVALIDOS", "clienteId inválido");
      const c = bd[clienteId];
      if (!c) throw new ErrorCliente("NO_ENCONTRADO", "cliente no encontrado");
      return { id: clienteId, nombre: c.nombre, activo: c.activo, anonimizado: c.anonimizado };
    },
    async tieneConsentimiento({ clienteId }) {
      const c = bd[clienteId];
      if (!c) throw new ErrorCliente("NO_ENCONTRADO", "cliente no encontrado");
      return c.activo && !c.anonimizado && c.consiente;
    },
  };

  // documentos falsos: el servicio real los lee con `obtener` y se suscribe con `on`
  const docs = new Map();
  const emisor = new EventEmitter();
  const documentos = {
    async obtener({ code }) {
      return docs.get(code) ?? null;
    },
    on: (nombre, fn) => emisor.on(nombre, fn),
  };

  const auth = {
    exigirCsrf(req) {
      if (req.method !== "GET" && !req.headers?.["x-requested-with"]) throw new ErrorAuth("CSRF", "falta la cabecera x-requested-with");
    },
  };

  const servicio = crearServicioFidelizacion({ Empresa, MovimientoPuntos }, documentos, clientes, auth);
  servicio.registrarFuente({
    tipo: "pedido",
    estado: "pagado",
    extraer: (d) => ({ clienteId: d.snapshot?.cliente?.clienteId ?? null, monto: d.payload?.doc?.total ?? null, detalle: "Pedido pagado" }),
  });

  const pedido = (code, { estado = "pagado", clienteId = C1, total = 45.9, tipo = "pedido", sinSnapshot = false } = {}) => {
    docs.set(code, {
      code,
      tipo,
      estado,
      payload: { doc: { total } },
      snapshot: sinSnapshot ? {} : { cliente: clienteId ? { clienteId } : null },
    });
    return code;
  };
  return { servicio, movs, emp, bd, docs, emisor, pedido };
}

const acumular = (m, code) => conEmpresa(E1, () => m.servicio.acumularPorDocumento({ empresaId: E1, code }));
const saldo = (m, c = C1) => m.servicio.saldo({ empresaId: E1, clienteId: c });

describe("reglas de puntos (config.js)", () => {
  it("calcularPuntos: por unidad de moneda, hacia abajo, sin errores de coma flotante", () => {
    assert.equal(calcularPuntos(45.9, 1), 45);
    assert.equal(calcularPuntos(45.9, 2), 91);
    assert.equal(calcularPuntos(10, 0.5), 5);
    assert.equal(calcularPuntos(0.4, 1), 0);
    assert.equal(calcularPuntos(0.29, 100), 29); // 0.29 * 100 en coma flotante da 28.999...
    assert.equal(calcularPuntos(19.99, 1), 19);
    assert.equal(calcularPuntos(0, 1), 0);
    assert.equal(calcularPuntos(-5, 1), 0);
    assert.equal(calcularPuntos(null, 1), 0);
    assert.equal(calcularPuntos("10", 1), 0);
  });

  it("configDe: lo guardado sobre los valores por defecto (empresas anteriores al campo)", () => {
    assert.deepEqual(configDe({}), { habilitada: true, puntosPorUnidad: 1, niveles: [] });
    assert.deepEqual(configDe(null), { habilitada: true, puntosPorUnidad: 1, niveles: [] });
    assert.deepEqual(configDe({ fidelizacion: { habilitada: false } }), { habilitada: false, puntosPorUnidad: 1, niveles: [] });
    assert.deepEqual(configDe({ fidelizacion: { puntosPorUnidad: 2 } }), { habilitada: true, puntosPorUnidad: 2, niveles: [] });
    assert.deepEqual(configDe({ fidelizacion: { puntosPorUnidad: -3 } }), { habilitada: true, puntosPorUnidad: 1, niveles: [] });
  });

  it("validarConfig: parcial, tipos y rangos, y campos desconocidos se rechazan", () => {
    assert.deepEqual(validarConfig({ habilitada: false }), { habilitada: false });
    assert.deepEqual(validarConfig({ puntosPorUnidad: 0.5, habilitada: true }), { puntosPorUnidad: 0.5, habilitada: true });
    for (const malo of [{}, null, [], { habilitada: "si" }, { puntosPorUnidad: 0 }, { puntosPorUnidad: -1 }, { puntosPorUnidad: 1001 }, { puntosPorUnidad: "2" }, { otro: 1 }])
      assert.throws(() => validarConfig(malo), (e) => e instanceof ErrorFidelizacion && e.codigo === "DATOS_INVALIDOS");
  });

  it("validarPuntos y validarDetalle", () => {
    assert.equal(validarPuntos(5), 5);
    for (const m of [0, -1, 1.5, "5", 1_000_001, NaN, null])
      assert.throws(() => validarPuntos(m), (e) => e.codigo === "DATOS_INVALIDOS");
    assert.equal(validarDetalle("  hola "), "hola");
    assert.equal(validarDetalle(""), null);
    assert.equal(validarDetalle(undefined), null);
    assert.throws(() => validarDetalle("x".repeat(201)), (e) => e.codigo === "DATOS_INVALIDOS");
    assert.throws(() => validarDetalle("", { obligatorio: true }), (e) => e.codigo === "DATOS_INVALIDOS");
    assert.throws(() => validarDetalle(5), (e) => e.codigo === "DATOS_INVALIDOS");
  });
});

describe("libro de puntos: solo inserción", () => {
  it("el modelo rechaza actualizar o borrar movimientos", async () => {
    const conn = mongoose.createConnection(); // sin conectar: los ganchos rechazan antes de tocar la base
    const M = conn.model("MovPrueba", movimientoPuntosSchema, "puntos_movimientos_prueba");
    await conEmpresa(E1, async () => {
      for (const op of [
        () => M.updateOne({ clienteId: C1 }, { $set: { puntos: 99 } }),
        () => M.updateMany({}, { $set: { puntos: 99 } }),
        () => M.deleteOne({ clienteId: C1 }),
        () => M.deleteMany({}),
        () => M.findOneAndUpdate({ clienteId: C1 }, { $set: { puntos: 1 } }),
        () => M.replaceOne({ clienteId: C1 }, { puntos: 1 }),
      ])
        await assert.rejects(op(), (e) => e instanceof ErrorFidelizacion && /solo de inserción/.test(e.message));
    });
  });

  it("puntos: entero distinto de 0", () => {
    const conn = mongoose.createConnection();
    const M = conn.model("MovPrueba2", movimientoPuntosSchema, "puntos_movimientos_prueba2");
    const ok = new M({ empresaId: E1, clienteId: C1, tipo: "acumulo", puntos: 5, ts: new Date() });
    assert.equal(ok.validateSync(), undefined);
    for (const p of [0, 1.5, NaN]) {
      const mal = new M({ empresaId: E1, clienteId: C1, tipo: "acumulo", puntos: p, ts: new Date() });
      assert.ok(mal.validateSync()?.errors?.puntos, `puntos ${p} debería rechazarse`);
    }
    assert.ok(new M({ empresaId: E1, clienteId: C1, tipo: "regalo", puntos: 1, ts: new Date() }).validateSync()?.errors?.tipo);
  });
});

describe("acumular puntos al pagar", () => {
  let m;
  beforeEach(() => {
    m = crearMundo();
  });

  it("suma floor(total) con 1 punto por unidad, con consentimiento, y deja el saldo", async () => {
    m.pedido("PD-0000001");
    const r = await acumular(m, "PD-0000001");
    assert.deepEqual(r, { acumulados: 45, clienteId: C1, saldo: 45 });
    assert.equal(m.movs.length, 1);
    assert.deepEqual(
      { tipo: m.movs[0].tipo, puntos: m.movs[0].puntos, documentoCode: m.movs[0].documentoCode, detalle: m.movs[0].detalle },
      { tipo: "acumulo", puntos: 45, documentoCode: "PD-0000001", detalle: "Pedido pagado" },
    );
    assert.equal(await saldo(m), 45);
  });

  it("respeta la regla de la empresa (puntos por unidad)", async () => {
    m = crearMundo({ empresa: { fidelizacion: { puntosPorUnidad: 2 } } });
    m.pedido("PD-0000001", { total: 10 });
    assert.equal((await acumular(m, "PD-0000001")).acumulados, 20);
  });

  it("es idempotente: reprocesar el mismo documento no suma otra vez", async () => {
    m.pedido("PD-0000001");
    await acumular(m, "PD-0000001");
    const otra = await acumular(m, "PD-0000001");
    assert.equal(otra.yaRegistrado, true);
    assert.equal(otra.acumulados, 45);
    assert.equal(otra.saldo, 45);
    assert.equal(m.movs.length, 1);
  });

  it("dos procesos a la vez (el escucha del motor y la propia operación): un solo movimiento", async () => {
    m.pedido("PD-0000001");
    const [a, b] = await Promise.all([acumular(m, "PD-0000001"), acumular(m, "PD-0000001")]);
    assert.equal(m.movs.length, 1);
    assert.equal(a.acumulados, 45);
    assert.equal(b.acumulados, 45);
    assert.ok(a.yaRegistrado || b.yaRegistrado, "uno de los dos encuentra que ya estaba registrado");
    assert.equal(await saldo(m), 45);
  });

  it("no acumula sin motivo: cada caso dice por qué", async () => {
    m.pedido("A1", { estado: "abierto" });
    assert.equal((await acumular(m, "A1")).motivo, "sin_regla"); // aún no está pagado
    m.pedido("A2", { tipo: "doc_item" });
    assert.equal((await acumular(m, "A2")).motivo, "sin_regla"); // otro tipo de documento
    m.pedido("A3", { clienteId: null });
    assert.equal((await acumular(m, "A3")).motivo, "sin_cliente");
    m.pedido("A4", { sinSnapshot: true });
    assert.equal((await acumular(m, "A4")).motivo, "sin_cliente");
    m.pedido("A5", { total: null });
    assert.equal((await acumular(m, "A5")).motivo, "sin_monto"); // un ítem sin precio dejó el total en null
    m.pedido("A6", { total: 0.4 });
    assert.equal((await acumular(m, "A6")).motivo, "sin_puntos");
    m.pedido("A7", { clienteId: "bbbbbbbbbbbbbbbbbbbbbbb9" });
    assert.equal((await acumular(m, "A7")).motivo, "cliente_no_encontrado");
    assert.equal(m.movs.length, 0);
  });

  it("sin consentimiento no acumula; con el cliente desactivado lo dice distinto", async () => {
    m.bd[C1].consiente = false;
    m.pedido("PD-0000001");
    const r = await acumular(m, "PD-0000001");
    assert.equal(r.motivo, "sin_consentimiento");
    assert.equal(r.acumulados, 0);
    m.bd[C1].consiente = true;
    m.bd[C1].activo = false;
    assert.equal((await acumular(m, "PD-0000001")).motivo, "cliente_inactivo");
    assert.equal(m.movs.length, 0);
  });

  it("con la fidelización apagada en la empresa no acumula", async () => {
    m = crearMundo({ empresa: { fidelizacion: { habilitada: false } } });
    m.pedido("PD-0000001");
    assert.equal((await acumular(m, "PD-0000001")).motivo, "deshabilitada");
  });

  it("un documento que no existe da NO_ENCONTRADO", async () => {
    await rechaza(acumular(m, "PD-0000099"), "NO_ENCONTRADO", 404);
  });

  it("registrarFuente valida lo que recibe", () => {
    assert.throws(() => m.servicio.registrarFuente({ tipo: "x" }), /registrarFuente/);
    assert.throws(() => m.servicio.registrarFuente({ tipo: "x", estado: "y", extraer: 5 }), /registrarFuente/);
    assert.deepEqual(m.servicio.fuentes(), [{ tipo: "pedido", estado: "pagado" }]);
  });
});

describe("el escucha del motor", () => {
  let m;
  beforeEach(() => {
    m = crearMundo();
  });
  const esperar = () => new Promise((r) => setTimeout(r, 20));
  const evento = (code, a = "pagado", tipoDocumento = "pedido") => ({ empresaId: E1, documentoCode: code, tipoDocumento, datos: { a } });

  it("al llegar un pedido a `pagado` acumula solo", async () => {
    m.pedido("PD-0000001");
    m.emisor.emit("estado", evento("PD-0000001"));
    await esperar();
    assert.equal(m.movs.length, 1);
    assert.equal(m.movs[0].puntos, 45);
  });

  it("ignora otros estados y otros tipos", async () => {
    m.pedido("PD-0000001", { estado: "anulado" });
    m.emisor.emit("estado", evento("PD-0000001", "anulado"));
    m.pedido("DOC_ITEM-0000001", { tipo: "doc_item", estado: "entregado" });
    m.emisor.emit("estado", evento("DOC_ITEM-0000001", "entregado", "doc_item"));
    await esperar();
    assert.equal(m.movs.length, 0);
  });

  it("si falla, no lanza: lo registra (y se puede repetir con acumularPorDocumento)", async () => {
    const errores = [];
    const original = console.error;
    console.error = (...a) => errores.push(a);
    try {
      m.emisor.emit("estado", evento("PD-0000404")); // el documento no existe
      await esperar();
    } finally {
      console.error = original;
    }
    assert.equal(errores.length, 1);
    assert.match(String(errores[0][0]), /no se pudieron acumular los puntos de PD-0000404/);
  });

  it("el escucha y la operación explícita a la vez no duplican", async () => {
    m.pedido("PD-0000001");
    m.emisor.emit("estado", evento("PD-0000001"));
    const r = await acumular(m, "PD-0000001");
    await esperar();
    assert.equal(r.acumulados, 45);
    assert.equal(m.movs.length, 1);
  });
});

describe("canjear y ajustar", () => {
  let m;
  const dar = async (puntos) => conEmpresa(E1, () => m.servicio.ajustar({ empresaId: E1, actor: ADM, clienteId: C1, puntos, detalle: "carga inicial" }));
  const canjear = (actor, p = {}) =>
    conEmpresa(E1, () => m.servicio.canjear({ empresaId: E1, actor, clienteId: C1, puntos: 20, ...p }));
  beforeEach(async () => {
    m = crearMundo();
    await dar(100);
  });

  it("canjear descuenta con signo negativo, deja quién lo hizo y devuelve el saldo", async () => {
    const r = await canjear(MESERO, { detalle: "Café gratis" });
    assert.deepEqual(r, { saldo: 80 });
    const mov = m.movs.at(-1);
    assert.equal(mov.tipo, "canje");
    assert.equal(mov.puntos, -20);
    assert.equal(mov.detalle, "Café gratis");
    assert.equal(mov.creadoPor, MESERO.usuarioId);
    assert.equal(await saldo(m), 80);
  });

  it("detalle por defecto", async () => {
    await canjear(MESERO);
    assert.equal(m.movs.at(-1).detalle, "Canje de beneficio");
  });

  it("pide permiso: quien solo lee no canjea", async () => {
    await rechaza(canjear(SIN_PERMISOS), "PERMISO_INSUFICIENTE", 403);
    await rechaza(canjear(undefined), "PERMISO_INSUFICIENTE", 403);
    assert.equal(await saldo(m), 100);
  });

  it("saldo insuficiente no descuenta y dice cuánto hay", async () => {
    await assert.rejects(canjear(MESERO, { puntos: 101 }), (e) => e.codigo === "SALDO_INSUFICIENTE" && e.status === 409 && e.detalle.saldo === 100);
    assert.equal(await saldo(m), 100);
  });

  it("puntos inválidos", async () => {
    for (const p of [0, -5, 2.5, "10", undefined]) await rechaza(canjear(MESERO, { puntos: p }), "DATOS_INVALIDOS", 400);
  });

  it("un cliente desactivado o inexistente no canjea", async () => {
    m.bd[C1].activo = false;
    await rechaza(canjear(MESERO), "ESTADO_INVALIDO", 409);
    await rechaza(
      conEmpresa(E1, () => m.servicio.canjear({ empresaId: E1, actor: MESERO, clienteId: "bbbbbbbbbbbbbbbbbbbbbbb9", puntos: 5 })),
      "NO_ENCONTRADO",
      404,
    );
    await rechaza(conEmpresa(E1, () => m.servicio.canjear({ empresaId: E1, actor: MESERO, clienteId: "x", puntos: 5 })), "DATOS_INVALIDOS");
  });

  it("ajustar: exige gestionar y un motivo, admite signo y no deja el saldo en negativo", async () => {
    const aj = (actor, p) => conEmpresa(E1, () => m.servicio.ajustar({ empresaId: E1, actor, clienteId: C1, ...p }));
    await rechaza(aj(MESERO, { puntos: 5, detalle: "x" }), "PERMISO_INSUFICIENTE", 403);
    await rechaza(aj(ADM, { puntos: 5 }), "DATOS_INVALIDOS");
    await rechaza(aj(ADM, { puntos: 0, detalle: "x" }), "DATOS_INVALIDOS");
    await rechaza(aj(ADM, { puntos: 1.5, detalle: "x" }), "DATOS_INVALIDOS");
    assert.deepEqual(await aj(ADM, { puntos: -30, detalle: "error de carga" }), { saldo: 70 });
    await rechaza(aj(ADM, { puntos: -71, detalle: "x" }), "SALDO_INSUFICIENTE", 409);
    assert.equal(await saldo(m), 70);
  });

  it("el saldo suma todo el libro: acumulos, canjes y ajustes", async () => {
    m.pedido("PD-0000001", { total: 10 });
    await acumular(m, "PD-0000001");
    await canjear(MESERO, { puntos: 30 });
    assert.equal(await saldo(m), 100 + 10 - 30);
    const r = await conEmpresa(E1, () => m.servicio.resumen({ empresaId: E1, clienteId: C1 }));
    assert.equal(r.saldo, 80);
    assert.equal(r.habilitada, true);
    assert.equal(r.movimientos.length, 3);
    assert.deepEqual(r.movimientos.map((x) => x.tipo).sort(), ["acumulo", "ajuste", "canje"]);
    assert.ok(r.movimientos.every((x) => !("creadoPor" in x) && !("clienteId" in x)), "el resumen no expone ids internos");
    // 5.30: nivel e insignias salen del mismo libro; el ajuste de 100 y el canje no cuentan como puntos acumulados
    assert.equal(r.logros.acumulado, 10);
    assert.equal(r.logros.canjes, 1);
    assert.equal(r.logros.nivel, null); // la empresa no configuró niveles
    assert.equal(r.logros.insignias.find((i) => i.id === "primera_vez").obtenida, true);
  });

  it("el saldo de otro cliente no se mezcla", async () => {
    assert.equal(await saldo(m, C2), 0);
  });
});

describe("configuración de la empresa", () => {
  it("leer da los valores por defecto; guardar exige gestionar y valida", async () => {
    const m = crearMundo();
    const cfg = (a) => conEmpresa(E1, () => m.servicio.guardarConfig({ empresaId: E1, actor: a, ...a.cambio }));
    assert.deepEqual(await m.servicio.leerConfig({ empresaId: E1 }), { habilitada: true, puntosPorUnidad: 1, niveles: [] });
    await rechaza(m.servicio.guardarConfig({ empresaId: E1, actor: MESERO, puntosPorUnidad: 2 }), "PERMISO_INSUFICIENTE", 403);
    await rechaza(m.servicio.guardarConfig({ empresaId: E1, actor: ADM, puntosPorUnidad: 0 }), "DATOS_INVALIDOS");
    const r = await m.servicio.guardarConfig({ empresaId: E1, actor: ADM, puntosPorUnidad: 2 });
    assert.deepEqual(r, { habilitada: true, puntosPorUnidad: 2, niveles: [] });
    m.pedido("PD-0000001", { total: 10 });
    assert.equal((await acumular(m, "PD-0000001")).acumulados, 20);
    assert.deepEqual(await m.servicio.guardarConfig({ empresaId: E1, actor: ADM, habilitada: false }), { habilitada: false, puntosPorUnidad: 2, niveles: [] });
    void cfg;
  });

  it("una empresa inexistente da NO_ENCONTRADO", async () => {
    const m = crearMundo();
    await rechaza(m.servicio.leerConfig({ empresaId: "aaaaaaaaaaaaaaaaaaaaaaa7" }), "NO_ENCONTRADO", 404);
  });
});

describe("manejadores HTTP de los puntos", () => {
  const req = (o = {}) => ({ method: "GET", headers: {}, body: {}, params: {}, query: {}, ...o });
  const res = () => ({
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  });
  const auth = (rol = ADM) => ({ auth: { empresaId: E1, usuarioId: rol.usuarioId }, rol: { permisos: rol.permisos } });
  const X = { "x-requested-with": "fetch" };

  it("GET puntos: saldo y movimientos; 404 si el cliente no existe", async () => {
    const m = crearMundo();
    await conEmpresa(E1, () => m.servicio.ajustar({ empresaId: E1, actor: ADM, clienteId: C1, puntos: 40, detalle: "inicio" }));
    const r = res();
    await m.servicio.manejadores.puntos(req({ ...auth(), params: { clienteId: C1 } }), r, (e) => {
      throw e;
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.saldo, 40);
    const r2 = res();
    await m.servicio.manejadores.puntos(req({ ...auth(), params: { clienteId: "bbbbbbbbbbbbbbbbbbbbbbb9" } }), r2, (e) => {
      throw e;
    });
    assert.equal(r2.statusCode, 404);
    assert.equal(r2.body.codigo, "NO_ENCONTRADO");
  });

  it("POST canjear: exige x-requested-with, traduce SALDO_INSUFICIENTE a 409 con el saldo", async () => {
    const m = crearMundo();
    await conEmpresa(E1, () => m.servicio.ajustar({ empresaId: E1, actor: ADM, clienteId: C1, puntos: 10, detalle: "inicio" }));
    const sinCsrf = res();
    await m.servicio.manejadores.canjear(req({ method: "POST", ...auth(MESERO), params: { clienteId: C1 }, body: { puntos: 5 } }), sinCsrf, (e) => {
      throw e;
    });
    assert.equal(sinCsrf.statusCode, 403);
    assert.equal(sinCsrf.body.codigo, "CSRF");
    const ok = res();
    await m.servicio.manejadores.canjear(
      req({ method: "POST", headers: X, ...auth(MESERO), params: { clienteId: C1 }, body: { puntos: 4, detalle: "Postre" } }),
      ok,
      (e) => {
        throw e;
      },
    );
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.body, { saldo: 6 });
    const mucho = res();
    await m.servicio.manejadores.canjear(
      req({ method: "POST", headers: X, ...auth(MESERO), params: { clienteId: C1 }, body: { puntos: 50 } }),
      mucho,
      (e) => {
        throw e;
      },
    );
    assert.equal(mucho.statusCode, 409);
    assert.equal(mucho.body.codigo, "SALDO_INSUFICIENTE");
    assert.equal(mucho.body.saldo, 6);
  });

  it("POST ajustar (5.39): exige x-requested-with, gestionar y motivo; suma al saldo sin contar como consumo", async () => {
    const m = crearMundo();
    const llamar = async (actor, body, headers = X) => {
      const r = res();
      await m.servicio.manejadores.ajustar(req({ method: "POST", headers, ...auth(actor), params: { clienteId: C1 }, body }), r, (e) => {
        throw e;
      });
      return r;
    };
    assert.equal((await llamar(ADM, { puntos: 50, detalle: "migración" }, {})).body.codigo, "CSRF");
    const sinPermiso = await llamar(MESERO, { puntos: 50, detalle: "migración" });
    assert.equal(sinPermiso.statusCode, 403);
    assert.equal(sinPermiso.body.codigo, "PERMISO_INSUFICIENTE");
    assert.equal((await llamar(ADM, { puntos: 50 })).statusCode, 400);
    const ok = await llamar(ADM, { puntos: 50, detalle: "Saldo migrado del sistema anterior" });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.body, { saldo: 50 });
    const r = await conEmpresa(E1, () => m.servicio.resumen({ empresaId: E1, clienteId: C1 }));
    assert.equal(r.saldo, 50);
    assert.deepEqual(r.movimientos.map((x) => x.tipo), ["ajuste"]);
    assert.equal(r.logros.acumulado, 0, "un ajuste no cuenta como consumo");
    assert.equal(r.logros.consumos, 0);
    assert.equal(r.logros.insignias.find((i) => i.id === "puntos_100").obtenida, false);
  });
});
