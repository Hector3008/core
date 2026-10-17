// Corre sin MongoDB: modelos falsos en memoria que implementan solo lo que usa el servicio de fidelización.
// Prueban la lógica de canje, vales y su consumo único; los índices y la concurrencia real de MongoDB se
// prueban en fidelizacion.test.js (requiere MONGODB_URI).
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { crearServicioFidelizacion } from "../src/fidelizacion/index.js";
import { ErrorFidelizacion } from "../src/fidelizacion/errores.js";

let seq = 0;
const oid = () => (++seq).toString(16).padStart(24, "0");
const coincide = (doc, filtro) =>
  Object.entries(filtro).every(([k, v]) => {
    const real = k.includes(".") ? k.split(".").reduce((a, x) => a?.[x], doc) : doc[k];
    if (v && typeof v === "object" && !(v instanceof Date) && "$gt" in v) return new Date(real) > new Date(v.$gt);
    return String(real ?? null) === String(v ?? null);
  });
const fijar = (doc, set) => {
  for (const [k, v] of Object.entries(set)) {
    if (!k.includes(".")) doc[k] = v;
    else {
      const [a, b] = k.split(".");
      doc[a] = { ...(doc[a] ?? {}), [b]: v };
    }
  }
};
function consulta(filas) {
  let r = [...filas];
  const q = {
    sort(o) {
      const [[k, d]] = Object.entries(o);
      r.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * d);
      return q;
    },
    limit(n) { r = r.slice(0, n); return q; },
    lean() { return q; },
    then(ok, ko) { return Promise.resolve(r).then(ok, ko); },
  };
  return q;
}
function modeloFalso(extra = {}) {
  const filas = [];
  const M = {
    filas,
    async create(d) {
      const unico = M.unico?.(d, filas);
      if (unico) throw Object.assign(new Error("dup"), { code: 11000 });
      const doc = { _id: oid(), ...d };
      filas.push(doc);
      return { ...doc, toObject: () => doc };
    },
    find: (f = {}) => consulta(filas.filter((x) => coincide(x, f))),
    findOne: (f = {}) => consulta(filas.filter((x) => coincide(x, f)).slice(0, 1)).then((a) => a[0] ?? null) && {
      lean: async () => filas.find((x) => coincide(x, f)) ?? null,
      then: (ok, ko) => Promise.resolve(filas.find((x) => coincide(x, f)) ?? null).then(ok, ko),
    },
    findOneAndUpdate(f, u) {
      const d = filas.find((x) => coincide(x, f));
      if (d) fijar(d, u.$set);
      return { lean: async () => (d ? { ...d } : null) };
    },
    async updateOne(f, u) {
      const d = filas.find((x) => coincide(x, f));
      if (d) fijar(d, u.$set);
    },
    async aggregate(p) {
      const m = p.find((x) => x.$match)?.$match ?? {};
      const total = filas.filter((x) => coincide(x, m)).reduce((n, x) => n + x.puntos, 0);
      return filas.some((x) => coincide(x, m)) ? [{ _id: null, total }] : [];
    },
    ...extra,
  };
  return M;
}

const EMP = oid();
const CLI = oid();
const ADM = { usuarioId: oid(), permisos: ["*"] };
const MESERO = { usuarioId: oid(), permisos: ["fidelizacion:canjear"] };

function montar({ consiente = true, activo = true } = {}) {
  const Movimiento = modeloFalso();
  const Beneficio = modeloFalso();
  const Ticket = modeloFalso();
  Ticket.unico = (d, filas) => filas.some((x) => x.codigo === d.codigo);
  const Empresa = { findById: () => ({ lean: async () => ({ _id: EMP, activa: true }) }), updateOne: async () => {} };
  const clientes = {
    obtener: async () => ({ id: CLI, nombre: "Ana", activo, anonimizado: false }),
    tieneConsentimiento: async () => consiente,
  };
  const documentos = { on() {} };
  const f = crearServicioFidelizacion({ Empresa, MovimientoPuntos: Movimiento, Beneficio, Ticket }, documentos, clientes, {});
  return { f, Movimiento, Beneficio, Ticket };
}
const ponerPuntos = (Movimiento, n) => Movimiento.create({ clienteId: CLI, tipo: "acumulo", puntos: n, ts: new Date() });
const rechaza = async (p, codigo, re) =>
  assert.rejects(p, (e) => e instanceof ErrorFidelizacion && e.codigo === codigo && (!re || re.test(e.message)));

describe("beneficios (servicio)", () => {
  it("solo gestionar crea y edita; canjear los lista", async () => {
    const { f } = montar();
    const b = await f.beneficios.crear({ empresaId: EMP, actor: ADM, nombre: "10%", puntos: 50, tipo: "descuento_porcentaje", valor: 10 });
    assert.equal(b.activo, true);
    assert.equal((await f.beneficios.listar({ empresaId: EMP, actor: MESERO })).length, 1);
    await rechaza(f.beneficios.crear({ empresaId: EMP, actor: MESERO, nombre: "x", puntos: 5, tipo: "descuento_monto", valor: 1 }), "PERMISO_INSUFICIENTE");
    await rechaza(f.beneficios.listar({ empresaId: EMP, actor: { usuarioId: oid(), permisos: ["documento:leer"] } }), "PERMISO_INSUFICIENTE");
    const e = await f.beneficios.editar({ empresaId: EMP, actor: ADM, beneficioId: b.id, activo: false });
    assert.equal(e.activo, false);
    assert.equal((await f.beneficios.activos({ empresaId: EMP })).length, 0);
  });
});

describe("vales (servicio)", () => {
  let s, ben;
  beforeEach(async () => {
    s = montar();
    ben = await s.f.beneficios.crear({ empresaId: EMP, actor: ADM, nombre: "Café gratis", puntos: 100, tipo: "item_gratis", itemCodigo: "CAFE", vigenciaDias: 10 });
  });

  it("canjear descuenta los puntos y entrega un vale con código", async () => {
    await ponerPuntos(s.Movimiento, 250);
    const r = await s.f.tickets.emitirMio({ empresaId: EMP, clienteId: CLI, beneficioId: ben.id });
    assert.match(r.ticket.codigo, /^[A-Z2-9]{6}$/);
    assert.equal(r.ticket.estado, "activo");
    assert.equal(r.saldo, 150);
    assert.equal(await s.f.saldo({ empresaId: EMP, clienteId: CLI }), 150);
    const dias = (new Date(r.ticket.venceTs) - new Date(r.ticket.ts)) / 86_400_000;
    assert.equal(Math.round(dias), 10);
  });

  it("sin saldo suficiente no emite ni descuenta", async () => {
    await ponerPuntos(s.Movimiento, 99);
    await rechaza(s.f.tickets.emitirMio({ empresaId: EMP, clienteId: CLI, beneficioId: ben.id }), "SALDO_INSUFICIENTE");
    assert.equal(s.Ticket.filas.length, 0);
    assert.equal(await s.f.saldo({ empresaId: EMP, clienteId: CLI }), 99);
  });

  it("si otro canje se coló y el saldo quedó negativo, se revierte", async () => {
    await ponerPuntos(s.Movimiento, 150);
    // Simula una carrera: justo después de nuestro canje aparece otro que deja el saldo en negativo.
    const crear = s.Movimiento.create.bind(s.Movimiento);
    let n = 0;
    s.Movimiento.create = async (d) => {
      const r = await crear(d);
      if (d.tipo === "canje" && n++ === 0) await crear({ clienteId: CLI, tipo: "canje", puntos: -100, ts: new Date() });
      return r;
    };
    await rechaza(s.f.tickets.emitirMio({ empresaId: EMP, clienteId: CLI, beneficioId: ben.id }), "SALDO_INSUFICIENTE");
    assert.equal(s.Ticket.filas.length, 0);
    assert.equal(await s.f.saldo({ empresaId: EMP, clienteId: CLI }), 50); // 150 - 100 del otro; el nuestro se revirtió
  });

  it("exige consentimiento, cliente activo y beneficio activo", async () => {
    await ponerPuntos(s.Movimiento, 500);
    const sin = montar({ consiente: false });
    const b2 = await sin.f.beneficios.crear({ empresaId: EMP, actor: ADM, nombre: "x", puntos: 1, tipo: "descuento_monto", valor: 1 });
    await ponerPuntos(sin.Movimiento, 10);
    await rechaza(sin.f.tickets.emitirMio({ empresaId: EMP, clienteId: CLI, beneficioId: b2.id }), "ESTADO_INVALIDO", /no participa/);
    const inactivo = montar({ activo: false });
    const b3 = await inactivo.f.beneficios.crear({ empresaId: EMP, actor: ADM, nombre: "x", puntos: 1, tipo: "descuento_monto", valor: 1 });
    await rechaza(inactivo.f.tickets.emitirMio({ empresaId: EMP, clienteId: CLI, beneficioId: b3.id }), "ESTADO_INVALIDO");
    await s.f.beneficios.editar({ empresaId: EMP, actor: ADM, beneficioId: ben.id, activo: false });
    await rechaza(s.f.tickets.emitirMio({ empresaId: EMP, clienteId: CLI, beneficioId: ben.id }), "NO_ENCONTRADO");
    await rechaza(s.f.tickets.emitirMio({ empresaId: EMP, clienteId: CLI, beneficioId: "no-es-un-id" }), "DATOS_INVALIDOS");
  });

  it("el vale lleva una copia del beneficio: editarlo después no lo cambia", async () => {
    await ponerPuntos(s.Movimiento, 500);
    const { ticket } = await s.f.tickets.emitirMio({ empresaId: EMP, clienteId: CLI, beneficioId: ben.id });
    await s.f.beneficios.editar({ empresaId: EMP, actor: ADM, beneficioId: ben.id, nombre: "Otro", puntos: 999 });
    const v = await s.f.tickets.consultar({ empresaId: EMP, actor: MESERO, codigo: ticket.codigo.toLowerCase() });
    assert.equal(v.beneficio.nombre, "Café gratis");
    assert.equal(v.puntos, 100);
    assert.equal(v.cliente.nombre, "Ana");
  });

  it("se consume una sola vez, con el permiso de canjear", async () => {
    await ponerPuntos(s.Movimiento, 500);
    const { ticket } = await s.f.tickets.emitirMio({ empresaId: EMP, clienteId: CLI, beneficioId: ben.id });
    await rechaza(
      s.f.tickets.consumir({ empresaId: EMP, actor: { usuarioId: oid(), permisos: ["documento:leer"] }, codigo: ticket.codigo }),
      "PERMISO_INSUFICIENTE",
    );
    const u = await s.f.tickets.consumir({ empresaId: EMP, actor: MESERO, codigo: ticket.codigo, uso: { pedidoCode: "PD-1", itemCode: "DOC_ITEM-1", descuento: 4.5 } });
    assert.equal(u.estado, "usado");
    assert.deepEqual(u.uso, { pedidoCode: "PD-1", itemCode: "DOC_ITEM-1", descuento: 4.5 });
    await rechaza(s.f.tickets.consumir({ empresaId: EMP, actor: MESERO, codigo: ticket.codigo }), "ESTADO_INVALIDO", /ya fue usado/);
    await rechaza(s.f.tickets.consumir({ empresaId: EMP, actor: MESERO, codigo: "ZZZZZZ" }), "NO_ENCONTRADO");
    await rechaza(s.f.tickets.consumir({ empresaId: EMP, actor: MESERO, codigo: "abc" }), "DATOS_INVALIDOS");
  });

  it("un vale vencido no se consume", async () => {
    await ponerPuntos(s.Movimiento, 500);
    const { ticket } = await s.f.tickets.emitirMio({ empresaId: EMP, clienteId: CLI, beneficioId: ben.id });
    s.Ticket.filas[0].venceTs = new Date(Date.now() - 1000);
    await rechaza(s.f.tickets.consumir({ empresaId: EMP, actor: MESERO, codigo: ticket.codigo }), "ESTADO_INVALIDO", /vencido/);
    assert.equal((await s.f.tickets.de({ empresaId: EMP, clienteId: CLI }))[0].estado, "vencido");
  });

  it("liberar deja el vale activo otra vez solo si lo consumió ese uso", async () => {
    await ponerPuntos(s.Movimiento, 500);
    const { ticket } = await s.f.tickets.emitirMio({ empresaId: EMP, clienteId: CLI, beneficioId: ben.id });
    await s.f.tickets.consumir({ empresaId: EMP, actor: MESERO, codigo: ticket.codigo, uso: { itemCode: "DOC_ITEM-1" } });
    await s.f.tickets.liberar({ empresaId: EMP, actor: MESERO, codigo: ticket.codigo, itemCode: "DOC_ITEM-9" });
    assert.equal(s.Ticket.filas[0].estado, "usado");
    await s.f.tickets.liberar({ empresaId: EMP, actor: MESERO, codigo: ticket.codigo, itemCode: "DOC_ITEM-1" });
    assert.equal(s.Ticket.filas[0].estado, "activo");
    assert.equal(s.Ticket.filas[0].uso.itemCode, null);
  });

  it("el cliente cancela un vale activo y recupera los puntos; una sola vez", async () => {
    await ponerPuntos(s.Movimiento, 500);
    const { ticket } = await s.f.tickets.emitirMio({ empresaId: EMP, clienteId: CLI, beneficioId: ben.id });
    const r = await s.f.tickets.cancelarMio({ empresaId: EMP, clienteId: CLI, codigo: ticket.codigo });
    assert.equal(r.saldo, 500);
    assert.equal(r.ticket.estado, "cancelado");
    await rechaza(s.f.tickets.cancelarMio({ empresaId: EMP, clienteId: CLI, codigo: ticket.codigo }), "ESTADO_INVALIDO");
    await rechaza(s.f.tickets.consumir({ empresaId: EMP, actor: MESERO, codigo: ticket.codigo }), "ESTADO_INVALIDO", /cancelado/);
    assert.equal(await s.f.saldo({ empresaId: EMP, clienteId: CLI }), 500);
  });

  it("no se cancela un vale ya usado ni el de otro cliente", async () => {
    await ponerPuntos(s.Movimiento, 500);
    const { ticket } = await s.f.tickets.emitirMio({ empresaId: EMP, clienteId: CLI, beneficioId: ben.id });
    await rechaza(s.f.tickets.cancelarMio({ empresaId: EMP, clienteId: oid(), codigo: ticket.codigo }), "ESTADO_INVALIDO");
    await s.f.tickets.consumir({ empresaId: EMP, actor: MESERO, codigo: ticket.codigo });
    await rechaza(s.f.tickets.cancelarMio({ empresaId: EMP, clienteId: CLI, codigo: ticket.codigo }), "ESTADO_INVALIDO");
  });

  it("el personal puede emitir por el cliente (permiso canjear)", async () => {
    await ponerPuntos(s.Movimiento, 500);
    const r = await s.f.tickets.emitir({ empresaId: EMP, actor: MESERO, clienteId: CLI, beneficioId: ben.id });
    assert.equal(r.saldo, 400);
    await rechaza(
      s.f.tickets.emitir({ empresaId: EMP, actor: { usuarioId: oid(), permisos: [] }, clienteId: CLI, beneficioId: ben.id }),
      "PERMISO_INSUFICIENTE",
    );
  });

  it("canjear (a mano) ya no deja el saldo negativo", async () => {
    await ponerPuntos(s.Movimiento, 30);
    await rechaza(s.f.canjear({ empresaId: EMP, actor: MESERO, clienteId: CLI, puntos: 31 }), "SALDO_INSUFICIENTE");
    assert.deepEqual(await s.f.canjear({ empresaId: EMP, actor: MESERO, clienteId: CLI, puntos: 30 }), { saldo: 0 });
  });
});
