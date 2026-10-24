// No necesita base de datos: prueba el servicio de promociones contra almacenes falsos en memoria (5.40).
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { crearServicioPromociones } from "../src/promociones/index.js";
import { montarRutasPromociones } from "../src/promociones/rutas.js";
import { ErrorPromocion } from "../src/promociones/errores.js";
import { ErrorAuth } from "../src/auth/errores.js";
import { crearServicioEmpresas } from "../src/empresas.js";
import { conEmpresa, empresaActual } from "../src/tenancy.js";

const E1 = "aaaaaaaaaaaaaaaaaaaaaaa1";
const E2 = "aaaaaaaaaaaaaaaaaaaaaaa2";
const ADM = { usuarioId: "0123456789abcdef01234567", permisos: ["*"] };
const LECTOR = { usuarioId: "0123456789abcdef01234568", permisos: ["promocion:leer"] };
const MESERO = { usuarioId: "0123456789abcdef01234569", permisos: ["fidelizacion:canjear"] };
// Jueves 22 de octubre de 2026, 20:00 en Lima
const JUEVES_20H = "2026-10-23T01:00:00Z";

const rechaza = (p, codigo, status) =>
  assert.rejects(p, (e) => e instanceof ErrorPromocion && e.codigo === codigo && (status === undefined || e.status === status));
const dos = (o = {}) => ({ nombre: "2x1 en lattes", tipo: "nxm", n: 2, m: 1, objetivo: { itemCodigo: "LATTE" }, ...o });

function crearMundo({ empresas = { [E1]: { _id: E1, pais: "PE" }, [E2]: { _id: E2, pais: "PE" } } } = {}) {
  const filas = [];
  let n = 0;
  const propias = () => filas.filter((p) => p.empresaId === empresaActual());
  const coincide = (d, f) => Object.entries(f).every(([k, v]) => String(d[k]) === String(v));
  const consulta = (fn) => {
    const q = { _orden: null };
    q.lean = () => q;
    q.sort = (o) => ((q._orden = o), q);
    q.then = (ok, ko) =>
      Promise.resolve()
        .then(() => {
          let r = fn();
          if (Array.isArray(r) && q._orden) {
            const claves = Object.entries(q._orden);
            r = [...r].sort((a, b) => {
              for (const [k, dir] of claves) {
                const x = a[k];
                const y = b[k];
                if (x === y) continue;
                return (x < y ? -1 : 1) * dir;
              }
              return 0;
            });
          }
          return structuredClone(r);
        })
        .then(ok, ko);
    return q;
  };
  const Promocion = {
    _filas: filas,
    find: (f = {}) => consulta(() => propias().filter((p) => coincide(p, f))),
    findOne: (f) => consulta(() => propias().find((p) => coincide(p, f)) ?? null),
    async countDocuments(f = {}) {
      return propias().filter((p) => coincide(p, f)).length;
    },
    async create(doc) {
      const p = { _id: String(++n).padStart(24, "0"), empresaId: empresaActual(), createdAt: new Date(), updatedAt: new Date(), ...structuredClone(doc) };
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
  const Empresa = {
    findById: (id) => consulta(() => empresas[id] ?? null),
    updateOne: async (f, cambio) => {
      const e = empresas[f._id];
      if (!e) return { matchedCount: 0 };
      Object.assign(e, cambio);
      return { matchedCount: 1 };
    },
  };
  const auth = {
    exigirCsrf(req) {
      if (req.method !== "GET" && !req.headers?.["x-requested-with"]) throw new ErrorAuth("CSRF", "falta la cabecera x-requested-with");
    },
  };
  const servicio = crearServicioPromociones({ Empresa, Promocion }, auth);
  const en = (id, fn) => conEmpresa(id, fn);
  return { servicio, Promocion, Empresa, empresas, en, crear: (o = {}, actor = ADM, e = E1) => en(e, () => servicio.crear({ empresaId: e, actor, ...o })) };
}

describe("reglas de la empresa", () => {
  let m;
  beforeEach(() => (m = crearMundo()));

  it("crear exige promocion:gestionar y devuelve la promoción completa", async () => {
    await rechaza(m.crear(dos(), LECTOR), "PERMISO_INSUFICIENTE", 403);
    await rechaza(m.crear(dos(), MESERO), "PERMISO_INSUFICIENTE", 403);
    await rechaza(m.crear(dos(), null), "PERMISO_INSUFICIENTE", 403);
    const p = await m.crear(dos(), ADM);
    assert.equal(p.nombre, "2x1 en lattes");
    assert.deepEqual([p.tipo, p.n, p.m, p.activa, p.prioridad], ["nxm", 2, 1, true, 100]);
    assert.deepEqual(p.objetivo, { itemCodigo: "LATTE", categoria: null });
    assert.match(p.id, /^[0-9a-f]{24}$/);
  });

  it("valida con el mismo criterio: un dato malo es DATOS_INVALIDOS y no guarda nada", async () => {
    await rechaza(m.crear(dos({ n: 1 })), "DATOS_INVALIDOS", 400);
    assert.equal(m.Promocion._filas.length, 0);
  });

  it("listar: ven quienes leen o gestionan, y solo las de su empresa (activas primero, por prioridad)", async () => {
    await m.crear(dos({ nombre: "B", prioridad: 20 }));
    await m.crear(dos({ nombre: "A", prioridad: 10 }));
    const pausada = await m.crear(dos({ nombre: "Pausada", prioridad: 1 }));
    await m.en(E1, () => m.servicio.editar({ empresaId: E1, actor: ADM, promocionId: pausada.id, activa: false }));
    await m.crear(dos({ nombre: "De otra empresa" }), ADM, E2);
    const lista = await m.en(E1, () => m.servicio.listar({ empresaId: E1, actor: LECTOR }));
    assert.deepEqual(lista.map((p) => p.nombre), ["A", "B", "Pausada"]);
    await rechaza(m.en(E1, () => m.servicio.listar({ empresaId: E1, actor: MESERO })), "PERMISO_INSUFICIENTE", 403);
  });

  it("editar: cambia lo que se envía, pausa sin borrar, y exige gestionar", async () => {
    const p = await m.crear(dos());
    const ed = (actor, cambios, id = p.id) => m.en(E1, () => m.servicio.editar({ empresaId: E1, actor, promocionId: id, ...cambios }));
    await rechaza(ed(LECTOR, { activa: false }), "PERMISO_INSUFICIENTE", 403);
    const r = await ed(ADM, { nombre: "3x2", n: 3, m: 2 });
    assert.deepEqual([r.nombre, r.n, r.m, r.tipo], ["3x2", 3, 2, "nxm"]);
    assert.equal((await ed(ADM, { activa: false })).activa, false);
    assert.equal(m.Promocion._filas.length, 1, "nunca se borra");
    await rechaza(ed(ADM, { m: 9 }), "DATOS_INVALIDOS");
    await rechaza(ed(ADM, { nombre: "x" }, "bbbbbbbbbbbbbbbbbbbbbbb9"), "NO_ENCONTRADO", 404);
    await rechaza(ed(ADM, { nombre: "x" }, "no-es-un-id"), "DATOS_INVALIDOS", 400);
  });

  it("no se puede editar la promoción de otra empresa", async () => {
    const ajena = await m.crear(dos(), ADM, E2);
    await rechaza(m.en(E1, () => m.servicio.editar({ empresaId: E1, actor: ADM, promocionId: ajena.id, nombre: "x" })), "NO_ENCONTRADO", 404);
  });

  it("hasta 100 activas: la 101 se rechaza, pausar libera un lugar y reactivar también lo cuenta", async () => {
    const ids = [];
    for (let i = 0; i < 100; i++) ids.push((await m.crear(dos({ nombre: `P${i}` }))).id);
    await rechaza(m.crear(dos({ nombre: "P100" })), "LIMITE_ALCANZADO", 409);
    await m.crear(dos({ nombre: "Otra empresa" }), ADM, E2); // el tope es por empresa
    const ed = (id, c) => m.en(E1, () => m.servicio.editar({ empresaId: E1, actor: ADM, promocionId: id, ...c }));
    await ed(ids[0], { activa: false });
    const nueva = await m.crear(dos({ nombre: "P100" }));
    await rechaza(ed(ids[0], { activa: true }), "LIMITE_ALCANZADO", 409);
    await m.crear(dos({ nombre: "Pausada de nacimiento", activa: false })); // crear pausada no consume cupo
    await ed(nueva.id, { nombre: "P100 editada" }); // editar una activa no cuenta de nuevo
    assert.equal((await m.en(E1, () => m.servicio.listar({ empresaId: E1, actor: ADM }))).length, 102);
  });

  it("crear en una empresa que no existe es NO_ENCONTRADO", async () => {
    await rechaza(m.crear(dos(), ADM, "aaaaaaaaaaaaaaaaaaaaaaa9"), "NO_ENCONTRADO", 404);
  });
});

describe("evaluar y simular", () => {
  let m;
  beforeEach(() => (m = crearMundo()));
  const lineas = [{ id: "l1", codigo: "LATTE", categoria: "Cafés", cantidad: 2, precio: 10 }];

  it("evaluar usa las promociones activas de la empresa, a su hora", async () => {
    await m.crear(dos({ horario: { desde: "18:00", hasta: "21:00" } }));
    await m.crear(dos({ nombre: "Pausada", activa: false, objetivo: { categoria: "Cafés" } }));
    const dentro = await m.en(E1, () => m.servicio.evaluar({ empresaId: E1, lineas, ahora: new Date(JUEVES_20H) }));
    assert.equal(dentro.descuentoTotal, 10);
    const fuera = await m.en(E1, () => m.servicio.evaluar({ empresaId: E1, lineas, ahora: new Date("2026-10-22T15:00:00Z") })); // 10:00 en Lima
    assert.equal(fuera.descuentoTotal, 0);
    const otra = await m.en(E2, () => m.servicio.evaluar({ empresaId: E2, lineas, ahora: new Date(JUEVES_20H) }));
    assert.equal(otra.descuentoTotal, 0, "las promociones de E1 no valen en E2");
  });

  it("la zona fijada por la empresa manda sobre la de su país", async () => {
    await m.crear(dos({ horario: { desde: "18:00", hasta: "21:00" } }));
    const ev = () => m.en(E1, () => m.servicio.evaluar({ empresaId: E1, lineas, ahora: new Date(JUEVES_20H) }));
    assert.equal((await ev()).descuentoTotal, 10);
    m.empresas[E1].zonaHoraria = "Europe/Madrid"; // 03:00 en Madrid
    assert.equal((await ev()).descuentoTotal, 0);
  });

  it("simular: pide promocion:leer, valida el pedido de ejemplo y no guarda nada", async () => {
    await m.crear(dos());
    const sim = (c, actor = LECTOR) => m.en(E1, () => m.servicio.simular({ empresaId: E1, actor, ahora: JUEVES_20H, ...c }));
    const r = await sim({ items: [{ codigo: "LATTE", cantidad: 2, precio: 10 }] });
    assert.deepEqual([r.totalBase, r.descuentoTotal, r.total], [20, 10, 10]);
    assert.equal(m.Promocion._filas.length, 1);
    await rechaza(sim({ items: [{ codigo: "LATTE", cantidad: 2, precio: 10 }] }, MESERO), "PERMISO_INSUFICIENTE", 403);
    for (const items of [[], "x", [{ codigo: "", cantidad: 1, precio: 1 }], [{ codigo: "A", cantidad: 0, precio: 1 }], [{ codigo: "A", cantidad: 1.5, precio: 1 }], [{ codigo: "A", cantidad: 1, precio: -1 }], [{ codigo: "A", cantidad: 1, precio: "1" }], [null]])
      await rechaza(sim({ items }), "DATOS_INVALIDOS", 400);
    await rechaza(sim({ items: [{ codigo: "A", cantidad: 99, precio: 1 }, ...Array(5).fill({ codigo: "B", cantidad: 99, precio: 1 })] }), "DATOS_INVALIDOS");
    await rechaza(sim({ items: [{ codigo: "LATTE", cantidad: 2, precio: 10 }], ahora: "ayer" }), "DATOS_INVALIDOS");
  });

  it("simular con un borrador: se suma a las guardadas, o se evalúa solo", async () => {
    await m.crear(dos({ nombre: "Guardada", objetivo: { itemCodigo: "LATTE" } }));
    const items = [{ codigo: "LATTE", cantidad: 2, precio: 10 }, { codigo: "TORTA", cantidad: 1, precio: 20 }];
    const borrador = { nombre: "Torta 10%", tipo: "directo", objetivo: { itemCodigo: "TORTA" }, efecto: "porcentaje", valor: 10 };
    const sim = (c) => m.en(E1, () => m.servicio.simular({ empresaId: E1, actor: LECTOR, ahora: JUEVES_20H, items, ...c }));
    const juntas = await sim({ borrador });
    assert.equal(juntas.descuentoTotal, 12);
    assert.deepEqual(juntas.aplicadas.map((a) => a.id).includes("borrador"), true);
    const sola = await sim({ borrador, soloBorrador: true });
    assert.equal(sola.descuentoTotal, 2);
    await rechaza(sim({ borrador: { nombre: "mala", tipo: "nxm" } }), "DATOS_INVALIDOS");
    await rechaza(sim({ soloBorrador: true }), "DATOS_INVALIDOS");
    assert.equal(m.Promocion._filas.length, 1, "el borrador no se guarda");
  });

  it("un borrador pausado en su JSON se evalúa igual (es una prueba)", async () => {
    const r = await m.en(E1, () =>
      m.servicio.simular({ empresaId: E1, actor: LECTOR, ahora: JUEVES_20H, items: [{ codigo: "LATTE", cantidad: 2, precio: 10 }], borrador: { ...dos(), activa: false }, soloBorrador: true }),
    );
    assert.equal(r.descuentoTotal, 10);
  });
});

describe("zona horaria en empresas", () => {
  it("fijarZonaHoraria valida el nombre, acepta null para volver a la del país y exige que la empresa exista", async () => {
    const m = crearMundo();
    const empresas = crearServicioEmpresas({ Empresa: m.Empresa });
    await empresas.fijarZonaHoraria({ empresaId: E1, zonaHoraria: " America/Bogota " });
    assert.equal(m.empresas[E1].zonaHoraria, "America/Bogota");
    await empresas.fijarZonaHoraria({ empresaId: E1, zonaHoraria: null });
    assert.equal(m.empresas[E1].zonaHoraria, null);
    await assert.rejects(empresas.fijarZonaHoraria({ empresaId: E1, zonaHoraria: "Lima" }), /zona horaria inválida/);
    await assert.rejects(empresas.fijarZonaHoraria({ empresaId: E1, zonaHoraria: "" }), /zona horaria inválida/);
    await assert.rejects(empresas.fijarZonaHoraria({ empresaId: "no", zonaHoraria: "America/Lima" }), /empresa no encontrada/);
  });
});

describe("manejadores HTTP y rutas", () => {
  let m;
  beforeEach(() => (m = crearMundo()));
  const req = (o = {}) => ({ method: "GET", headers: {}, body: {}, params: {}, query: {}, ...o });
  const res = () => ({
    statusCode: 200,
    body: undefined,
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
  const llamar = async (nombre, r) => {
    const out = res();
    await m.servicio.manejadores[nombre](r, out, (e) => {
      throw e;
    });
    return out;
  };

  it("POST crear: exige x-requested-with y gestionar; 201 con la promoción", async () => {
    const sinCsrf = await llamar("crear", req({ method: "POST", ...auth(), body: dos() }));
    assert.equal(sinCsrf.statusCode, 403);
    assert.equal(sinCsrf.body.codigo, "CSRF");
    const sinPermiso = await llamar("crear", req({ method: "POST", headers: X, ...auth(LECTOR), body: dos() }));
    assert.equal(sinPermiso.statusCode, 403);
    assert.equal(sinPermiso.body.codigo, "PERMISO_INSUFICIENTE");
    const malo = await llamar("crear", req({ method: "POST", headers: X, ...auth(), body: dos({ n: 1 }) }));
    assert.equal(malo.statusCode, 400);
    const ok = await llamar("crear", req({ method: "POST", headers: X, ...auth(), body: dos() }));
    assert.equal(ok.statusCode, 201);
    assert.equal(ok.body.nombre, "2x1 en lattes");
  });

  it("GET listar, PUT editar y POST simular", async () => {
    const c = await llamar("crear", req({ method: "POST", headers: X, ...auth(), body: dos() }));
    const lista = await llamar("listar", req({ ...auth(LECTOR) }));
    assert.equal(lista.statusCode, 200);
    assert.equal(lista.body.promociones.length, 1);
    const ed = await llamar("editar", req({ method: "PUT", headers: X, ...auth(), params: { promocionId: c.body.id }, body: { activa: false } }));
    assert.equal(ed.statusCode, 200);
    assert.equal(ed.body.activa, false);
    const noExiste = await llamar("editar", req({ method: "PUT", headers: X, ...auth(), params: { promocionId: "bbbbbbbbbbbbbbbbbbbbbbb9" }, body: { activa: true } }));
    assert.equal(noExiste.statusCode, 404);
    // simular no escribe: no pide x-requested-with
    await llamar("editar", req({ method: "PUT", headers: X, ...auth(), params: { promocionId: c.body.id }, body: { activa: true } }));
    const sim = await llamar("simular", req({ method: "POST", ...auth(LECTOR), body: { items: [{ codigo: "LATTE", cantidad: 2, precio: 10 }], ahora: JUEVES_20H } }));
    assert.equal(sim.statusCode, 200);
    assert.equal(sim.body.descuentoTotal, 10);
    const simMala = await llamar("simular", req({ method: "POST", ...auth(LECTOR), body: { items: [] } }));
    assert.equal(simMala.statusCode, 400);
  });

  it("las rutas: cuatro, con sus permisos, y /simular antes que /:promocionId", () => {
    const rutas = [];
    const pedidos = [];
    const reg = (metodo) => (path, ...fns) => rutas.push({ metodo, path, n: fns.length });
    const router = { get: reg("get"), post: reg("post"), put: reg("put") };
    const h = new Proxy({}, { get: () => () => {} });
    montarRutasPromociones(router, { promociones: { manejadores: h }, autenticar: () => () => {}, requierePermiso: (p) => (pedidos.push(p), () => {}) });
    assert.deepEqual(rutas.map((r) => `${r.metodo} ${r.path}`), ["get /", "post /", "post /simular", "put /:promocionId"]);
    assert.ok(rutas.every((r) => r.n === 3));
    assert.deepEqual(pedidos, ["promocion:leer", "promocion:gestionar"]);
  });
});

describe("vigentes: lo que ve el público (5.43)", () => {
  let m;
  beforeEach(() => (m = crearMundo()));
  const ver = (ahora = JUEVES_20H, e = E1) => m.en(e, () => m.servicio.vigentes({ empresaId: e, ahora: new Date(ahora) }));

  it("solo las activas, con vigenteAhora según día y horario en la hora de la empresa", async () => {
    await m.crear(dos({ dias: [4, 5], horario: { desde: "18:00", hasta: "21:00" } })); // jueves y viernes de 18 a 21
    await m.crear(dos({ nombre: "Lunes", dias: [1] }));
    await m.crear(dos({ nombre: "Pausada", activa: false }));
    const r = await ver(); // jueves 20:00 en Lima
    assert.equal(r.zona, "America/Lima");
    assert.equal(r.hoy, "2026-10-22");
    assert.deepEqual(r.promociones.map((p) => [p.nombre, p.vigenteAhora]), [["2x1 en lattes", true], ["Lunes", false]]);
    assert.equal((await ver("2026-10-23T05:00:00Z")).promociones[0].vigenteAhora, false, "viernes 00:00 en Lima: fuera del horario");
  });

  it("las vencidas no salen; las que aún no empiezan sí, como no vigentes", async () => {
    await m.crear(dos({ nombre: "Vencida", vigencia: { hasta: "2026-10-21" } }));
    await m.crear(dos({ nombre: "Hoy es el último día", vigencia: { hasta: "2026-10-22" } }));
    await m.crear(dos({ nombre: "Próxima", vigencia: { desde: "2026-11-01", hasta: "2026-11-30" } }));
    assert.deepEqual((await ver()).promociones.map((p) => [p.nombre, p.vigenteAhora]), [["Hoy es el último día", true], ["Próxima", false]]);
  });

  it("no expone datos internos ni mezcla empresas; no pide actor", async () => {
    await m.crear(dos({ prioridad: 5, acumulable: true }));
    await m.crear(dos({ nombre: "De otra empresa" }), ADM, E2);
    const r = await ver();
    assert.equal(r.promociones.length, 1);
    const claves = Object.keys(r.promociones[0]);
    for (const interno of ["prioridad", "acumulable", "activa", "creadaTs", "actualizadaTs", "creadoPor"]) assert.equal(claves.includes(interno), false, interno);
    await rechaza(ver(JUEVES_20H, "aaaaaaaaaaaaaaaaaaaaaaa7"), "NO_ENCONTRADO", 404);
  });

  it("sin promociones: lista vacía", async () => {
    assert.deepEqual((await ver()).promociones, []);
  });
});
