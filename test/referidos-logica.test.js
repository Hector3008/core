// Sin base de datos: referidos (5.45) contra almacenes falsos. El índice único real lo simulan los falsos.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { crearServicioFidelizacion } from "../src/fidelizacion/index.js";
import { crearServicioReferidos, normalizarCodigoReferido } from "../src/referidos/index.js";
import { ErrorFidelizacion } from "../src/fidelizacion/errores.js";
import { ErrorCliente } from "../src/clientes/errores.js";
import { configDe, validarConfig, validarReferidos } from "../src/fidelizacion/config.js";
import { calcularLogros } from "../src/fidelizacion/logros.js";
import { conEmpresa } from "../src/tenancy.js";

const E1 = "aaaaaaaaaaaaaaaaaaaaaaa1";
const ids = (n) => `bbbbbbbbbbbbbbbbbbbbbb${String(n).padStart(2, "0")}`;
const ANA = ids(1), BETO = ids(2), CARLA = ids(3), DANI = ids(4);
const ADM = { usuarioId: "0123456789abcdef01234567", permisos: ["*"] };
const rechaza = (p, codigo) => assert.rejects(p, (e) => e instanceof ErrorFidelizacion && e.codigo === codigo);

const coincide = (d, f) =>
  Object.entries(f).every(([k, v]) => (v && typeof v === "object" && v.$in ? v.$in.map(String).includes(String(d[k])) : String(d[k] ?? null) === String(v ?? null)));
function coleccion(unicos = []) {
  const filas = [];
  let n = 0;
  const q = (fn) => {
    const o = { _s: null, _skip: 0, _lim: Infinity, lean: () => o, select: () => o, sort: () => ((o._s = true), o), skip: (k) => ((o._skip = k), o), limit: (l) => ((o._lim = l), o) };
    o.then = (ok, ko) => Promise.resolve().then(() => {
      let r = fn();
      if (Array.isArray(r)) { if (o._s) r = [...r].reverse(); r = r.slice(o._skip, o._skip + o._lim); }
      return structuredClone(r);
    }).then(ok, ko);
    return o;
  };
  const choca = (doc) => unicos.some((cols) => doc[cols[0]] != null && filas.some((f) => cols.every((c) => String(f[c]) === String(doc[c]))));
  return {
    filas,
    findById: (id) => q(() => filas.find((f) => String(f._id) === String(id)) ?? null),
    findOne: (f) => q(() => filas.find((x) => coincide(x, f)) ?? null),
    find: (f = {}) => q(() => filas.filter((x) => coincide(x, f))),
    countDocuments: async (f = {}) => filas.filter((x) => coincide(x, f)).length,
    async create(doc) {
      if (choca(doc)) throw Object.assign(new Error("E11000"), { code: 11000 });
      const d = { _id: String(++n).padStart(24, "c"), ...structuredClone(doc) };
      filas.push(d);
      return d;
    },
    async updateOne(f, u) {
      const d = filas.find((x) => coincide(x, f));
      if (!d) return { matchedCount: 0, modifiedCount: 0 };
      const nuevo = { ...d, ...u.$set };
      if (u.$set && unicos.some((cols) => cols.some((c) => c in u.$set) && filas.some((x) => x !== d && cols.every((c) => nuevo[c] != null && String(x[c]) === String(nuevo[c]))))) throw Object.assign(new Error("E11000"), { code: 11000 });
      Object.assign(d, u.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async aggregate(p) {
      const m = filas.filter((x) => String(x.clienteId) === String(p[0].$match.clienteId));
      return m.length ? [{ _id: null, total: m.reduce((s, x) => s + x.puntos, 0) }] : [];
    },
    init: async () => {},
  };
}

function mundo({ referidos = {}, clientesInit } = {}) {
  const Cliente = coleccion([["codigoReferido"]]);
  const Referido = coleccion([["referidoId"]]);
  const MovimientoPuntos = coleccion([["documentoCode", "tipo"]]);
  const base = clientesInit ?? { [ANA]: "Ana Pérez", [BETO]: "Beto Ruiz", [CARLA]: "Carla Soto", [DANI]: "Dani Vega" };
  for (const [id, nombre] of Object.entries(base)) Cliente.filas.push({ _id: id, nombre, activo: true, anonimizadoTs: null, codigoReferido: null, consiente: true });
  const emp = { _id: E1, activa: true, fidelizacion: { referidos: { habilitada: true, ...referidos } } };
  const Empresa = { findById: () => ({ lean: async () => structuredClone(emp) }), updateOne: async () => ({}) };
  const clientes = {
    async obtener({ clienteId }) {
      const c = Cliente.filas.find((x) => x._id === clienteId);
      if (!c) throw new ErrorCliente("NO_ENCONTRADO", "cliente no encontrado");
      return { id: c._id, nombre: c.nombre, activo: c.activo, anonimizado: !!c.anonimizadoTs };
    },
    async tieneConsentimiento({ clienteId }) {
      const c = Cliente.filas.find((x) => x._id === clienteId);
      if (!c) throw new ErrorCliente("NO_ENCONTRADO", "cliente no encontrado");
      return c.activo && !c.anonimizadoTs && c.consiente;
    },
  };
  const docs = new Map();
  const documentos = { obtener: async ({ code }) => docs.get(code) ?? null, on: (n, fn) => new EventEmitter().on(n, fn) };
  const fid = crearServicioFidelizacion({ Empresa, MovimientoPuntos }, documentos, clientes, { exigirCsrf() {} });
  fid.registrarFuente({ tipo: "pedido", estado: "pagado", extraer: (d) => ({ clienteId: d.clienteId, monto: d.total }) });
  const ref = crearServicioReferidos({ Empresa, Cliente, Referido, MovimientoPuntos }, fid, clientes, { exigirCsrf() {} });
  const paga = (clienteId, total, code) => {
    code ??= `P${docs.size + 1}`;
    docs.set(code, { code, tipo: "pedido", estado: "pagado", clienteId, total });
    return conEmpresa(E1, () => fid.acumularPorDocumento({ empresaId: E1, code }));
  };
  const saldo = (id) => conEmpresa(E1, () => fid.saldo({ empresaId: E1, clienteId: id }));
  const codigo = (id) => conEmpresa(E1, () => ref.codigoDe({ empresaId: E1, clienteId: id }));
  const vincula = (referidoId, cod, extra = {}) => conEmpresa(E1, () => ref.vincular({ empresaId: E1, referidoId, codigo: cod, ...extra }));
  return { Cliente, Referido, MovimientoPuntos, emp, fid, ref, paga, saldo, codigo, vincula, bd: Cliente.filas };
}

describe("config de referidos", () => {
  it("por defecto apagado, con los valores acordados", () => {
    assert.deepEqual(configDe({}).referidos, { habilitada: false, puntosReferente: 50, puntosReferido: 25, consumoMinimo: 0, maxPorCliente: 20, cuentaParaNiveles: true });
  });
  it("configDe ignora valores inválidos guardados", () => {
    assert.equal(configDe({ fidelizacion: { referidos: { maxPorCliente: 0, puntosReferente: -1 } } }).referidos.maxPorCliente, 20);
    assert.equal(configDe({ fidelizacion: { referidos: { puntosReferente: 0 } } }).referidos.puntosReferente, 0);
  });
  it("validarReferidos: parcial, rangos y campos desconocidos", () => {
    assert.deepEqual(validarReferidos({ habilitada: true, puntosReferido: 0, consumoMinimo: 15.5, maxPorCliente: 5 }), { habilitada: true, puntosReferido: 0, consumoMinimo: 15.5, maxPorCliente: 5 });
    for (const m of [{}, null, [], { otro: 1 }, { habilitada: "si" }, { puntosReferente: -1 }, { puntosReferente: 1.5 }, { consumoMinimo: -1 }, { consumoMinimo: 1.234 }, { maxPorCliente: 0 }, { maxPorCliente: 10_001 }, { cuentaParaNiveles: 1 }])
      assert.throws(() => validarReferidos(m), (e) => e instanceof ErrorFidelizacion && e.codigo === "DATOS_INVALIDOS");
  });
  it("validarConfig acepta `referidos` y lo valida", () => {
    assert.deepEqual(validarConfig({ referidos: { habilitada: true } }), { referidos: { habilitada: true } });
    assert.throws(() => validarConfig({ referidos: { maxPorCliente: 0 } }), (e) => e.codigo === "DATOS_INVALIDOS");
  });
});

describe("logros: los bonos solo suman si la empresa lo decide", () => {
  const movs = [
    { tipo: "acumulo", puntos: 100, ts: "2026-01-01" },
    { tipo: "bono", puntos: 450, ts: "2026-01-05" },
  ];
  const niveles = [{ nombre: "Oro", desde: 500 }];
  it("con incluirBonos suman a nivel e insignias, pero no son consumos", () => {
    const l = calcularLogros({ movimientos: movs, niveles, incluirBonos: true, ahora: new Date("2026-02-01") });
    assert.equal(l.acumulado, 550);
    assert.equal(l.consumos, 1);
    assert.equal(l.nivel?.nombre ?? l.nivel?.actual?.nombre, "Oro");
    assert.equal(l.insignias.find((i) => i.id === "puntos_500").obtenida, true);
  });
  it("sin incluirBonos no cuentan", () => {
    const l = calcularLogros({ movimientos: movs, niveles, ahora: new Date("2026-02-01") });
    assert.equal(l.acumulado, 100);
    assert.equal(l.insignias.find((i) => i.id === "puntos_500").obtenida, false);
  });
});

describe("códigos", () => {
  it("normalizar: mayúsculas, sin espacios ni guiones", () => {
    assert.equal(normalizarCodigoReferido(" ab3-k 9x "), "AB3K9X");
    assert.equal(normalizarCodigoReferido(5), "");
  });
  it("codigoDe crea uno estable y distinto por cliente", async () => {
    const m = mundo();
    const a = await m.codigo(ANA);
    assert.match(a, /^[A-HJ-NP-Z2-9]{7}$/);
    assert.equal(await m.codigo(ANA), a);
    assert.notEqual(await m.codigo(BETO), a);
  });
  it("codigoDe falla con cliente inexistente o desactivado", async () => {
    const m = mundo();
    await rechaza(m.codigo(ids(9)), "NO_ENCONTRADO");
    m.bd[0].activo = false;
    await rechaza(m.codigo(ANA), "ESTADO_INVALIDO");
  });
  it("si hay un código repetido, reintenta con otro", async () => {
    const m = mundo();
    const ya = await m.codigo(ANA);
    const orig = m.Cliente.updateOne;
    let primera = true;
    m.Cliente.updateOne = (f, u) => { if (primera) { primera = false; return orig(f, { $set: { codigoReferido: ya } }); } return orig(f, u); };
    const b = await m.codigo(BETO);
    assert.notEqual(b, ya);
  });
});

describe("vincular", () => {
  it("anota quién refirió a una ficha nueva", async () => {
    const m = mundo();
    const r = await m.vincula(BETO, await m.codigo(ANA));
    assert.equal(r.estado, "pendiente");
    assert.equal(r.referente.id, ANA);
  });
  it("acepta el código escrito a mano (minúsculas, guiones)", async () => {
    const m = mundo();
    const c = (await m.codigo(ANA)).toLowerCase();
    await m.vincula(BETO, `${c.slice(0, 3)}-${c.slice(3)}`);
  });
  it("programa apagado: ESTADO_INVALIDO", async () => {
    const m = mundo({ referidos: { habilitada: false } });
    await rechaza(m.vincula(BETO, "ABCDEFG"), "ESTADO_INVALIDO");
  });
  it("código inexistente: NO_ENCONTRADO; vacío: DATOS_INVALIDOS", async () => {
    const m = mundo();
    await rechaza(m.vincula(BETO, "ZZZZZZZ"), "NO_ENCONTRADO");
    await rechaza(m.vincula(BETO, ""), "DATOS_INVALIDOS");
    await rechaza(m.vincula("x", "ABCDEFG"), "DATOS_INVALIDOS");
  });
  it("no a uno mismo", async () => {
    const m = mundo();
    await rechaza(m.vincula(ANA, await m.codigo(ANA)), "ESTADO_INVALIDO");
  });
  it("una ficha se refiere una sola vez", async () => {
    const m = mundo();
    await m.vincula(CARLA, await m.codigo(ANA));
    await rechaza(m.vincula(CARLA, await m.codigo(BETO)), "ESTADO_INVALIDO");
  });
  it("solo fichas nuevas: quien ya consumió con puntos no puede ser referido", async () => {
    const m = mundo();
    await m.paga(BETO, 20);
    await rechaza(m.vincula(BETO, await m.codigo(ANA)), "ESTADO_INVALIDO");
  });
  it("el referente debe estar activo; el referido también", async () => {
    const m = mundo();
    const c = await m.codigo(ANA);
    m.bd[0].activo = false;
    await rechaza(m.vincula(BETO, c), "NO_ENCONTRADO");
    m.bd[0].activo = true;
    m.bd[1].activo = false;
    await rechaza(m.vincula(BETO, c), "ESTADO_INVALIDO");
  });
});

describe("premio al primer consumo", () => {
  it("los dos ganan sus puntos al primer pago; queda premiado", async () => {
    const m = mundo({ referidos: { puntosReferente: 50, puntosReferido: 25 } });
    await m.vincula(BETO, await m.codigo(ANA));
    const r = await m.paga(BETO, 30);
    assert.equal(r.acumulados, 30);
    assert.equal(await m.saldo(ANA), 50);
    assert.equal(await m.saldo(BETO), 30 + 25);
    const f = m.Referido.filas[0];
    assert.equal(f.estado, "premiado");
    assert.equal(f.puntosReferente, 50);
    assert.equal(f.puntosReferido, 25);
    assert.equal(f.documentoCode, "P1");
    assert.deepEqual(m.MovimientoPuntos.filas.filter((x) => x.tipo === "bono").map((x) => x.puntos).sort(), [25, 50]);
  });
  it("solo una vez: el segundo pago no premia otra vez", async () => {
    const m = mundo();
    await m.vincula(BETO, await m.codigo(ANA));
    await m.paga(BETO, 30);
    await m.paga(BETO, 30);
    assert.equal(await m.saldo(ANA), 50);
    assert.equal(m.MovimientoPuntos.filas.filter((x) => x.tipo === "bono").length, 2);
  });
  it("reprocesar el mismo pago no duplica nada", async () => {
    const m = mundo();
    await m.vincula(BETO, await m.codigo(ANA));
    await m.paga(BETO, 30, "P1");
    await m.paga(BETO, 30, "P1");
    assert.equal(await m.saldo(ANA), 50);
    assert.equal(await m.saldo(BETO), 55);
  });
  it("si se cayó entre los bonos y el estado, el siguiente paso termina sin duplicar", async () => {
    const m = mundo();
    await m.vincula(BETO, await m.codigo(ANA));
    await m.paga(BETO, 30);
    m.Referido.filas[0].estado = "pendiente"; // simula el corte
    const r = await conEmpresa(E1, () => m.ref.alAcumular({ empresaId: E1, clienteId: BETO, monto: 30, code: "P1" }));
    assert.equal(r.premiado, true);
    assert.equal(m.MovimientoPuntos.filas.filter((x) => x.tipo === "bono").length, 2);
    assert.equal(await m.saldo(ANA), 50);
  });
  it("consumo mínimo: un pago menor lo deja pendiente; uno que llega, premia", async () => {
    const m = mundo({ referidos: { consumoMinimo: 40 } });
    await m.vincula(BETO, await m.codigo(ANA));
    await m.paga(BETO, 39.99);
    assert.equal(m.Referido.filas[0].estado, "pendiente");
    assert.equal(await m.saldo(ANA), 0);
    await m.paga(BETO, 40);
    assert.equal(m.Referido.filas[0].estado, "premiado");
    assert.equal(await m.saldo(ANA), 50);
  });
  it("sin mínimo (0): cualquier pago que dé puntos premia", async () => {
    const m = mundo();
    await m.vincula(BETO, await m.codigo(ANA));
    await m.paga(BETO, 1);
    assert.equal(m.Referido.filas[0].estado, "premiado");
  });
  it("tope por cliente: al pasar el cupo queda sin_cupo y nadie gana", async () => {
    const m = mundo({ referidos: { maxPorCliente: 1 } });
    const c = await m.codigo(ANA);
    await m.vincula(BETO, c);
    await m.vincula(CARLA, c);
    await m.paga(BETO, 10);
    await m.paga(CARLA, 10);
    assert.deepEqual(m.Referido.filas.map((f) => f.estado), ["premiado", "sin_cupo"]);
    assert.equal(await m.saldo(ANA), 50);
    assert.equal(await m.saldo(CARLA), 10);
  });
  it("puntos en 0 para uno de los dos: solo gana el otro", async () => {
    const m = mundo({ referidos: { puntosReferente: 0, puntosReferido: 25 } });
    await m.vincula(BETO, await m.codigo(ANA));
    await m.paga(BETO, 10);
    assert.equal(await m.saldo(ANA), 0);
    assert.equal(await m.saldo(BETO), 35);
    assert.equal(m.Referido.filas[0].estado, "premiado");
  });
  it("si quien refirió no tiene el programa de puntos, solo gana el referido", async () => {
    const m = mundo();
    await m.vincula(BETO, await m.codigo(ANA));
    m.bd[0].consiente = false;
    await m.paga(BETO, 10);
    assert.equal(await m.saldo(ANA), 0);
    assert.equal(await m.saldo(BETO), 35);
    assert.equal(m.Referido.filas[0].puntosReferente, 0);
  });
  it("si el programa se apaga antes del consumo, no se premia y sigue pendiente", async () => {
    const m = mundo();
    await m.vincula(BETO, await m.codigo(ANA));
    m.emp.fidelizacion.referidos.habilitada = false;
    await m.paga(BETO, 10);
    assert.equal(m.Referido.filas[0].estado, "pendiente");
    assert.equal(await m.saldo(ANA), 0);
  });
  it("si el referido no consiente puntos, no hay consumo con puntos y no se premia", async () => {
    const m = mundo();
    await m.vincula(BETO, await m.codigo(ANA));
    m.bd[1].consiente = false;
    const r = await m.paga(BETO, 10);
    assert.equal(r.motivo, "sin_consentimiento");
    assert.equal(m.Referido.filas[0].estado, "pendiente");
  });
  it("un cliente sin referente no dispara nada", async () => {
    const m = mundo();
    await m.paga(BETO, 10);
    assert.equal(m.MovimientoPuntos.filas.filter((x) => x.tipo === "bono").length, 0);
  });
  it("un fallo en el observador no rompe la acumulación", async () => {
    const m = mundo();
    await m.vincula(BETO, await m.codigo(ANA));
    m.Referido.countDocuments = async () => { throw new Error("boom"); };
    const orig = console.error;
    console.error = () => {};
    try {
      const r = await m.paga(BETO, 10);
      assert.equal(r.acumulados, 10);
    } finally {
      console.error = orig;
    }
  });
  it("cuentaParaNiveles: el libro guarda `bono` y los logros respetan la config", async () => {
    const m = mundo({ referidos: { puntosReferente: 600, cuentaParaNiveles: true } });
    await m.vincula(BETO, await m.codigo(ANA));
    await m.paga(BETO, 10);
    assert.equal((await conEmpresa(E1, () => m.fid.logros({ empresaId: E1, clienteId: ANA }))).acumulado, 600);
    m.emp.fidelizacion.referidos.cuentaParaNiveles = false;
    assert.equal((await conEmpresa(E1, () => m.fid.logros({ empresaId: E1, clienteId: ANA }))).acumulado, 0);
  });
  it("el saldo de bonos se puede canjear como cualquier punto", async () => {
    const m = mundo();
    await m.vincula(BETO, await m.codigo(ANA));
    await m.paga(BETO, 10);
    const r = await conEmpresa(E1, () => m.fid.canjear({ empresaId: E1, actor: ADM, clienteId: ANA, puntos: 30, detalle: "café" }));
    assert.equal(r.saldo, 20);
  });
});

describe("otorgarBono", () => {
  it("idempotente por clave y exige consentimiento", async () => {
    const m = mundo();
    const dar = () => conEmpresa(E1, () => m.fid.otorgarBono({ empresaId: E1, clienteId: ANA, puntos: 10, detalle: "x", clave: "k1" }));
    assert.deepEqual(await dar(), { otorgado: true });
    assert.equal((await dar()).yaRegistrado, true);
    assert.equal(await m.saldo(ANA), 10);
    m.bd[0].consiente = false;
    assert.equal((await conEmpresa(E1, () => m.fid.otorgarBono({ empresaId: E1, clienteId: ANA, puntos: 10, clave: "k2" }))).motivo, "sin_consentimiento");
    await rechaza(conEmpresa(E1, () => m.fid.otorgarBono({ empresaId: E1, clienteId: ANA, puntos: 0, clave: "k3" })), "DATOS_INVALIDOS");
    await rechaza(conEmpresa(E1, () => m.fid.otorgarBono({ empresaId: E1, clienteId: ANA, puntos: 5, clave: "" })), "DATOS_INVALIDOS");
  });
});

describe("mio y listar", () => {
  it("apagado: sin código ni lista", async () => {
    const m = mundo({ referidos: { habilitada: false } });
    const r = await conEmpresa(E1, () => m.ref.mio({ empresaId: E1, clienteId: ANA }));
    assert.equal(r.habilitada, false);
    assert.equal(r.codigo, null);
    assert.equal(m.bd[0].codigoReferido, null); // no se crea código si no hay programa
  });
  it("activo: código, reglas, cupo y nombres abreviados", async () => {
    const m = mundo({ referidos: { maxPorCliente: 3 } });
    const c = await m.codigo(ANA);
    await m.vincula(BETO, c);
    await m.vincula(CARLA, c);
    await m.paga(BETO, 10);
    const r = await conEmpresa(E1, () => m.ref.mio({ empresaId: E1, clienteId: ANA }));
    assert.equal(r.codigo, c);
    assert.equal(r.premiados, 1);
    assert.equal(r.pendientes, 1);
    assert.equal(r.cupoRestante, 2);
    assert.deepEqual(r.referidos.map((x) => x.nombre).sort(), ["Beto R.", "Carla S."]);
    assert.equal(JSON.stringify(r).includes("Ruiz"), false);
    assert.equal((await conEmpresa(E1, () => m.ref.mio({ empresaId: E1, clienteId: BETO }))).fueReferido, true);
  });
  it("listar: resumen, nombres completos y filtro por estado", async () => {
    const m = mundo();
    const c = await m.codigo(ANA);
    await m.vincula(BETO, c);
    await m.vincula(CARLA, c);
    await m.paga(BETO, 10);
    const t = await conEmpresa(E1, () => m.ref.listar({ empresaId: E1 }));
    assert.equal(t.total, 2);
    assert.deepEqual(t.resumen, { premiados: 1, pendientes: 1 });
    assert.equal(t.referidos[0].referente.nombre, "Ana Pérez");
    const p = await conEmpresa(E1, () => m.ref.listar({ empresaId: E1, estado: "pendiente" }));
    assert.equal(p.referidos.length, 1);
    assert.equal(p.referidos[0].referido.nombre, "Carla Soto");
    await assert.rejects(conEmpresa(E1, () => m.ref.listar({ empresaId: E1, estado: "otro" })), (e) => e.codigo === "DATOS_INVALIDOS");
  });
});

describe("guardar la config de referidos", () => {
  it("escribe campo a campo (un cambio parcial no borra el resto) y exige gestionar", async () => {
    const m = mundo();
    const sets = [];
    m.fid; // el servicio real usa Empresa.updateOne: lo reemplazamos para ver el $set
    const Empresa = { findById: () => ({ lean: async () => ({ _id: E1, activa: true, fidelizacion: {} }) }), updateOne: async (f, u) => (sets.push(u.$set), {}) };
    const fid = crearServicioFidelizacion({ Empresa, MovimientoPuntos: m.MovimientoPuntos }, { obtener: async () => null, on() {} }, {}, { exigirCsrf() {} });
    await fid.guardarConfig({ empresaId: E1, actor: ADM, habilitada: false, referidos: { habilitada: true, maxPorCliente: 5 } });
    assert.deepEqual(sets[0], { "fidelizacion.habilitada": false, "fidelizacion.referidos.habilitada": true, "fidelizacion.referidos.maxPorCliente": 5 });
    await assert.rejects(fid.guardarConfig({ empresaId: E1, actor: { usuarioId: ADM.usuarioId, permisos: [] }, referidos: { habilitada: true } }), (e) => e.codigo === "PERMISO_INSUFICIENTE");
  });
});
