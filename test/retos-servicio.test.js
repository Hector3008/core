// Corre sin MongoDB: modelos falsos en memoria (5.31). Prueban cuándo un reto emite su vale y que sea una sola vez;
// el índice único real y la concurrencia de MongoDB se prueban en fidelizacion-vales.test.js (requiere MONGODB_URI).
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
const CARTA = [
  { codigo: "LATTE", nombre: "Latte" },
  { codigo: "MOKA", nombre: "Moka" },
  { codigo: "CORTADO", nombre: "Cortado" },
];

function montar({ consiente = true, habilitada = true } = {}) {
  const Movimiento = modeloFalso();
  Movimiento.unico = (d, filas) => d.documentoCode && filas.some((x) => x.documentoCode === d.documentoCode && x.tipo === d.tipo);
  const Beneficio = modeloFalso();
  const Reto = modeloFalso();
  const Ticket = modeloFalso();
  Ticket.unico = (d, filas) =>
    filas.some((x) => x.codigo === d.codigo) || (d.retoId && filas.some((x) => String(x.clienteId) === String(d.clienteId) && String(x.retoId) === String(d.retoId)));
  const estado = { consiente, carta: [...CARTA], docs: new Map() };
  const Empresa = { findById: () => ({ lean: async () => ({ _id: EMP, activa: true, fidelizacion: { habilitada, puntosPorUnidad: 1 } }) }), updateOne: async () => {} };
  const clientes = {
    obtener: async () => ({ id: CLI, nombre: "Ana", activo: true, anonimizado: false }),
    tieneConsentimiento: async () => estado.consiente,
  };
  const catalogo = { listar: async ({ categoria }) => (categoria === "Cafés" ? estado.carta : []) };
  const documentos = { on() {}, obtener: async ({ code }) => estado.docs.get(code) };
  const f = crearServicioFidelizacion({ Empresa, MovimientoPuntos: Movimiento, Beneficio, Ticket, Reto }, documentos, clientes, {}, catalogo);
  f.registrarFuente({
    tipo: "doc_item",
    estado: "pagado",
    extraer: (d) => ({ clienteId: CLI, monto: d.monto, detalle: "Pedido pagado", itemCodigo: d.itemCodigo }),
  });
  let n = 0;
  // Paga un ítem: crea el documento y acumula, como lo hace el escucha del motor.
  const pagar = async (itemCodigo, monto = 10) => {
    const code = `DI-${++n}`;
    estado.docs.set(code, { code, tipo: "doc_item", estado: "pagado", monto, itemCodigo });
    return f.acumularPorDocumento({ empresaId: EMP, code });
  };
  return { f, Movimiento, Reto, Ticket, estado, pagar };
}
const RETO = { nombre: "Catador", categoria: "Cafés", tipo: "item_gratis", itemCodigo: "LATTE", vigenciaDias: 15, descripcion: "Probaste todos los cafés" };
const rechaza = async (p, codigo) => assert.rejects(p, (e) => e instanceof ErrorFidelizacion && e.codigo === codigo);

describe("retos (servicio): administración", () => {
  it("solo gestionar crea y edita; canjear los lista", async () => {
    const { f } = montar();
    const r = await f.retos.crear({ empresaId: EMP, actor: ADM, ...RETO });
    assert.equal(r.activo, true);
    assert.equal(r.categoria, "Cafés");
    assert.equal(r.texto, "Un LATTE gratis");
    assert.equal((await f.retos.listar({ empresaId: EMP, actor: MESERO })).length, 1);
    await rechaza(f.retos.crear({ empresaId: EMP, actor: MESERO, ...RETO }), "PERMISO_INSUFICIENTE");
    await rechaza(f.retos.editar({ empresaId: EMP, actor: MESERO, retoId: r.id, activo: false }), "PERMISO_INSUFICIENTE");
    await rechaza(f.retos.listar({ empresaId: EMP, actor: { usuarioId: oid(), permisos: ["documento:leer"] } }), "PERMISO_INSUFICIENTE");
    const e = await f.retos.editar({ empresaId: EMP, actor: ADM, retoId: r.id, vigenciaDias: 7 });
    assert.equal(e.vigenciaDias, 7);
    assert.equal(e.nombre, "Catador");
    await rechaza(f.retos.editar({ empresaId: EMP, actor: ADM, retoId: oid() }), "NO_ENCONTRADO");
  });
});

describe("retos (servicio): emisión automática", () => {
  let s;
  beforeEach(async () => {
    s = montar();
    await s.f.retos.crear({ empresaId: EMP, actor: ADM, ...RETO });
  });

  it("el movimiento de acumulo guarda el ítem pagado", async () => {
    await s.pagar("LATTE");
    assert.equal(s.Movimiento.filas[0].itemCodigo, "LATTE");
  });

  it("emite el vale al pagar el último ítem que faltaba, sin costo en puntos", async () => {
    assert.equal((await s.pagar("LATTE")).retosGanados, undefined);
    assert.equal((await s.pagar("MOKA")).retosGanados, undefined);
    const r = await s.pagar("CORTADO");
    assert.equal(r.retosGanados.length, 1);
    assert.equal(r.retosGanados[0].nombre, "Catador");
    assert.match(r.retosGanados[0].codigo, /^[A-Z2-9]{6}$/);
    assert.equal(r.saldo, 30); // el vale no descontó nada
    const [t] = s.Ticket.filas;
    assert.equal(t.origen, "reto");
    assert.equal(t.puntos, 0);
    assert.equal(t.estado, "activo");
    assert.equal(t.beneficio.itemCodigo, "LATTE");
    assert.ok(new Date(t.venceTs) > new Date(Date.now() + 14 * 86_400_000));
  });

  it("es una sola vez: seguir comprando o evaluar de nuevo no repite el vale", async () => {
    for (const c of ["LATTE", "MOKA", "CORTADO"]) await s.pagar(c);
    const otra = await s.pagar("LATTE");
    assert.equal(otra.retosGanados, undefined);
    assert.deepEqual(await s.f.retos.evaluar({ empresaId: EMP, clienteId: CLI }), []);
    assert.equal(s.Ticket.filas.length, 1);
  });

  it("dos evaluaciones a la vez dejan un solo vale", async () => {
    for (const c of ["LATTE", "MOKA"]) await s.pagar(c);
    // Se guarda el último consumo sin evaluar, para evaluar a mano en paralelo.
    await s.Movimiento.create({ clienteId: CLI, tipo: "acumulo", puntos: 10, itemCodigo: "CORTADO", documentoCode: "X", ts: new Date() });
    const rs = await Promise.all([s.f.retos.evaluar({ empresaId: EMP, clienteId: CLI }), s.f.retos.evaluar({ empresaId: EMP, clienteId: CLI })]);
    assert.equal(s.Ticket.filas.length, 1);
    assert.equal(rs.flat().length >= 1, true);
  });

  it("repetir un mismo ítem no completa el reto", async () => {
    await s.pagar("LATTE");
    await s.pagar("LATTE");
    await s.pagar("MOKA");
    assert.equal(s.Ticket.filas.length, 0);
  });

  it("no emite si el cliente retiró su consentimiento, si el programa está apagado o si el reto está inactivo", async () => {
    await s.pagar("LATTE");
    await s.pagar("MOKA");
    s.estado.consiente = false;
    await s.Movimiento.create({ clienteId: CLI, tipo: "acumulo", puntos: 10, itemCodigo: "CORTADO", documentoCode: "Y", ts: new Date() });
    assert.deepEqual(await s.f.retos.evaluar({ empresaId: EMP, clienteId: CLI }), []);
    s.estado.consiente = true;
    const [reto] = await s.f.retos.listar({ empresaId: EMP, actor: ADM });
    await s.f.retos.editar({ empresaId: EMP, actor: ADM, retoId: reto.id, activo: false });
    assert.deepEqual(await s.f.retos.evaluar({ empresaId: EMP, clienteId: CLI }), []);
    await s.f.retos.editar({ empresaId: EMP, actor: ADM, retoId: reto.id, activo: true });
    assert.equal((await s.f.retos.evaluar({ empresaId: EMP, clienteId: CLI })).length, 1);

    const apagado = montar({ habilitada: false });
    await apagado.f.retos.crear({ empresaId: EMP, actor: ADM, ...RETO });
    for (const c of ["LATTE", "MOKA", "CORTADO"]) await apagado.Movimiento.create({ clienteId: CLI, tipo: "acumulo", puntos: 1, itemCodigo: c, documentoCode: `Z${c}`, ts: new Date() });
    assert.deepEqual(await apagado.f.retos.evaluar({ empresaId: EMP, clienteId: CLI }), []);
  });

  it("un fallo al evaluar no impide acumular los puntos", async () => {
    s.Ticket.create = async () => { throw new Error("falla de base de datos"); };
    const silencio = console.error;
    console.error = () => {};
    try {
      await s.pagar("LATTE");
      await s.pagar("MOKA");
      const r = await s.pagar("CORTADO");
      assert.equal(r.acumulados, 10);
      assert.equal(r.saldo, 30);
      assert.equal(r.retosGanados, undefined);
    } finally {
      console.error = silencio;
    }
  });

  it("un ítem libre o sin código no cuenta", async () => {
    await s.pagar(undefined);
    await s.pagar(null);
    assert.equal(s.Movimiento.filas.every((m) => m.itemCodigo === null), true);
  });
});

describe("retos (servicio): avance y vales", () => {
  it("el progreso lista lo que falta y, al ganar, muestra el vale", async () => {
    const s = montar();
    await s.f.retos.crear({ empresaId: EMP, actor: ADM, ...RETO });
    await s.pagar("LATTE");
    let [p] = await s.f.retos.progreso({ empresaId: EMP, clienteId: CLI });
    assert.equal(p.total, 3);
    assert.equal(p.logrados, 1);
    assert.deepEqual(p.faltan.map((i) => i.nombre), ["Moka", "Cortado"]);
    assert.equal(p.completo, false);
    assert.equal(p.vale, null);
    await s.pagar("MOKA");
    await s.pagar("CORTADO");
    [p] = await s.f.retos.progreso({ empresaId: EMP, clienteId: CLI });
    assert.equal(p.completo, true);
    assert.equal(p.vale.estado, "activo");
    // Se agrega un café a la carta: el reto ya ganado sigue como completado y no se vuelve a emitir.
    s.estado.carta.push({ codigo: "FLAT", nombre: "Flat white" });
    [p] = await s.f.retos.progreso({ empresaId: EMP, clienteId: CLI });
    assert.equal(p.completo, true);
    assert.equal(p.faltan.length, 1);
    assert.equal(s.Ticket.filas.length, 1);
  });

  it("si la carta crece antes de ganarlo, hay que probar también lo nuevo", async () => {
    const s = montar();
    await s.f.retos.crear({ empresaId: EMP, actor: ADM, ...RETO });
    await s.pagar("LATTE");
    await s.pagar("MOKA");
    s.estado.carta.push({ codigo: "FLAT", nombre: "Flat white" });
    assert.equal((await s.pagar("CORTADO")).retosGanados, undefined);
    assert.equal((await s.pagar("FLAT")).retosGanados.length, 1);
  });

  it("el resumen del cliente incluye sus retos y el vale sale con origen reto", async () => {
    const s = montar();
    await s.f.retos.crear({ empresaId: EMP, actor: ADM, ...RETO });
    for (const c of ["LATTE", "MOKA", "CORTADO"]) await s.pagar(c);
    const r = await s.f.resumen({ empresaId: EMP, clienteId: CLI });
    assert.equal(r.retos.length, 1);
    assert.equal(r.retos[0].completo, true);
    const [t] = await s.f.tickets.de({ empresaId: EMP, clienteId: CLI });
    assert.equal(t.origen, "reto");
    assert.equal(t.puntos, 0);
  });

  it("el cliente no puede cancelar un vale de reto (no costó puntos)", async () => {
    const s = montar();
    await s.f.retos.crear({ empresaId: EMP, actor: ADM, ...RETO });
    for (const c of ["LATTE", "MOKA", "CORTADO"]) await s.pagar(c);
    const [t] = await s.f.tickets.de({ empresaId: EMP, clienteId: CLI });
    await rechaza(s.f.tickets.cancelarMio({ empresaId: EMP, clienteId: CLI, codigo: t.codigo }), "ESTADO_INVALIDO");
    assert.equal(s.Ticket.filas[0].estado, "activo");
    assert.equal(s.Movimiento.filas.filter((m) => m.tipo === "ajuste").length, 0);
  });

  it("el vale de un reto se consulta y se consume como cualquier otro", async () => {
    const s = montar();
    await s.f.retos.crear({ empresaId: EMP, actor: ADM, ...RETO });
    for (const c of ["LATTE", "MOKA", "CORTADO"]) await s.pagar(c);
    const { codigo } = (await s.f.tickets.de({ empresaId: EMP, clienteId: CLI }))[0];
    const v = await s.f.tickets.consultar({ empresaId: EMP, actor: MESERO, codigo });
    assert.equal(v.beneficioCompleto.itemCodigo, "LATTE");
    const usado = await s.f.tickets.consumir({ empresaId: EMP, actor: MESERO, codigo, uso: { pedidoCode: "PD-1", itemCode: "DI-9", descuento: 4 } });
    assert.equal(usado.estado, "usado");
  });

  it("sin retos o sin catálogo todo sigue funcionando", async () => {
    const s = montar();
    assert.deepEqual(await s.f.retos.progreso({ empresaId: EMP, clienteId: CLI }), []);
    assert.equal((await s.pagar("LATTE")).retosGanados, undefined);
  });
});
