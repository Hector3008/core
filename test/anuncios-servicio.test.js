// No necesita base de datos: prueba el servicio de anuncios contra almacenes falsos en memoria (5.48).
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { crearServicioAnuncios } from "../src/anuncios/index.js";
import { montarRutasAnuncios } from "../src/anuncios/rutas.js";
import { ErrorAnuncio } from "../src/anuncios/errores.js";
import { ErrorAuth } from "../src/auth/errores.js";
import { conEmpresa, empresaActual } from "../src/tenancy.js";

const E1 = "aaaaaaaaaaaaaaaaaaaaaaa1";
const E2 = "aaaaaaaaaaaaaaaaaaaaaaa2";
const ADM = { usuarioId: "0123456789abcdef01234567", permisos: ["*"] };
const LECTOR = { usuarioId: "0123456789abcdef01234568", permisos: ["anuncio:leer"] };
const MESERO = { usuarioId: "0123456789abcdef01234569", permisos: ["fidelizacion:canjear"] };
// Jueves 22 de octubre de 2026, 20:00 en Lima (ya es 23 en UTC)
const JUEVES_20H = "2026-10-23T01:00:00Z";

const rechaza = (p, codigo, status) =>
  assert.rejects(p, (e) => e instanceof ErrorAnuncio && e.codigo === codigo && (status === undefined || e.status === status));
const evento = (o = {}) => ({ titulo: "Concierto de jazz", tipo: "evento", fecha: "2026-11-07", hora: "21:00", ...o });
const aviso = (o = {}) => ({ titulo: "Happy hour doble", tipo: "publicidad", ...o });

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
  const Anuncio = {
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
  const Empresa = { findById: (id) => consulta(() => empresas[id] ?? null) };
  const auth = {
    exigirCsrf(req) {
      if (req.method !== "GET" && !req.headers?.["x-requested-with"]) throw new ErrorAuth("CSRF", "falta la cabecera x-requested-with");
    },
  };
  const servicio = crearServicioAnuncios({ Empresa, Anuncio }, auth);
  const en = (id, fn) => conEmpresa(id, fn);
  return { servicio, Anuncio, empresas, en, crear: (o = {}, actor = ADM, e = E1) => en(e, () => servicio.crear({ empresaId: e, actor, ...o })) };
}

describe("anuncios de la empresa", () => {
  let m;
  beforeEach(() => (m = crearMundo()));
  const ed = (actor, cambios, id, e = E1) => m.en(e, () => m.servicio.editar({ empresaId: e, actor, anuncioId: id, ...cambios }));

  it("crear exige anuncio:gestionar y devuelve el anuncio completo", async () => {
    await rechaza(m.crear(evento(), LECTOR), "PERMISO_INSUFICIENTE", 403);
    await rechaza(m.crear(evento(), MESERO), "PERMISO_INSUFICIENTE", 403);
    await rechaza(m.crear(evento(), null), "PERMISO_INSUFICIENTE", 403);
    const a = await m.crear(evento({ lugar: "Terraza" }));
    assert.deepEqual([a.titulo, a.tipo, a.fecha, a.hora, a.lugar, a.activo], ["Concierto de jazz", "evento", "2026-11-07", "21:00", "Terraza", true]);
    assert.match(a.id, /^[0-9a-f]{24}$/);
  });

  it("un dato malo es DATOS_INVALIDOS y no guarda nada", async () => {
    await rechaza(m.crear(evento({ hora: "9pm" })), "DATOS_INVALIDOS", 400);
    assert.equal(m.Anuncio._filas.length, 0);
  });

  it("listar: ven quienes leen o gestionan, solo su empresa, activos primero y los nuevos arriba", async () => {
    await m.crear(aviso({ titulo: "A" }));
    const b = await m.crear(aviso({ titulo: "B" }));
    await m.crear(aviso({ titulo: "C" }));
    await ed(ADM, { activo: false }, b.id);
    await m.crear(aviso({ titulo: "Ajeno" }), ADM, E2);
    const lista = await m.en(E1, () => m.servicio.listar({ empresaId: E1, actor: LECTOR }));
    assert.deepEqual(lista.map((a) => a.titulo), ["C", "A", "B"]);
    await rechaza(m.en(E1, () => m.servicio.listar({ empresaId: E1, actor: MESERO })), "PERMISO_INSUFICIENTE", 403);
  });

  it("editar: cambia lo enviado, pausa sin borrar, exige gestionar y no toca lo de otra empresa", async () => {
    const a = await m.crear(evento());
    await rechaza(ed(LECTOR, { activo: false }, a.id), "PERMISO_INSUFICIENTE", 403);
    const r = await ed(ADM, { hora: "22:00", lugar: "Patio" }, a.id);
    assert.deepEqual([r.hora, r.lugar, r.fecha], ["22:00", "Patio", "2026-11-07"]);
    assert.equal((await ed(ADM, { activo: false }, a.id)).activo, false);
    assert.equal(m.Anuncio._filas.length, 1, "nunca se borra");
    await rechaza(ed(ADM, { tipo: "publicidad" }, a.id), "DATOS_INVALIDOS");
    await rechaza(ed(ADM, { titulo: "x" }, "bbbbbbbbbbbbbbbbbbbbbbb9"), "NO_ENCONTRADO", 404);
    await rechaza(ed(ADM, { titulo: "x" }, "no-es-un-id"), "DATOS_INVALIDOS", 400);
    const ajeno = await m.crear(aviso(), ADM, E2);
    await rechaza(ed(ADM, { titulo: "x" }, ajeno.id), "NO_ENCONTRADO", 404);
  });

  it("hasta 50 activos: el 51 se rechaza; pausar libera un lugar y reactivar también lo cuenta", async () => {
    const ids = [];
    for (let i = 0; i < 50; i++) ids.push((await m.crear(aviso({ titulo: `a${i}` }))).id);
    await rechaza(m.crear(aviso()), "LIMITE_ALCANZADO", 409);
    await m.crear(aviso({ activo: false })); // uno pausado no cuenta
    await ed(ADM, { activo: false }, ids[0]);
    const nuevo = await m.crear(aviso({ titulo: "nuevo" }));
    await rechaza(ed(ADM, { activo: true }, ids[0]), "LIMITE_ALCANZADO", 409);
    await ed(ADM, { titulo: "otro título" }, ids[1]); // editar uno activo no pide cupo
    assert.ok(nuevo.id);
  });

  it("empresa inexistente: NO_ENCONTRADO", async () => {
    await rechaza(m.crear(aviso(), ADM, "cccccccccccccccccccccccc"), "NO_ENCONTRADO", 404);
  });
});

describe("vigentes: lo que ve el público", () => {
  let m;
  beforeEach(() => (m = crearMundo()));
  const ver = (ahora = JUEVES_20H, e = E1) => m.en(e, () => m.servicio.vigentes({ empresaId: e, ahora: new Date(ahora) }));

  it("eventos: el más próximo primero; el del día de hoy sale; el de ayer no (hora de la empresa, no UTC)", async () => {
    await m.crear(evento({ titulo: "Lejano", fecha: "2026-12-01", hora: "20:00" }));
    await m.crear(evento({ titulo: "Hoy tarde", fecha: "2026-10-22", hora: "23:00" }));
    await m.crear(evento({ titulo: "Hoy temprano", fecha: "2026-10-22", hora: "18:00" }));
    await m.crear(evento({ titulo: "Ayer", fecha: "2026-10-21", hora: "21:00" }));
    const v = await ver();
    assert.equal(v.hoy, "2026-10-22"); // en UTC ya sería el 23
    assert.equal(v.zona, "America/Lima");
    assert.deepEqual(v.eventos.map((e) => e.titulo), ["Hoy temprano", "Hoy tarde", "Lejano"]);
  });

  it("publicidad: respeta vigencia desde/hasta; sin fechas siempre; la más reciente primero", async () => {
    await m.crear(aviso({ titulo: "Siempre" }));
    await m.crear(aviso({ titulo: "Vencida", vigencia: { hasta: "2026-10-21" } }));
    await m.crear(aviso({ titulo: "Hasta hoy", vigencia: { hasta: "2026-10-22" } }));
    await m.crear(aviso({ titulo: "Futura", vigencia: { desde: "2026-10-23" } }));
    await m.crear(aviso({ titulo: "Desde hoy", vigencia: { desde: "2026-10-22" } }));
    const v = await ver();
    assert.deepEqual(v.publicidad.map((a) => a.titulo), ["Desde hoy", "Hasta hoy", "Siempre"]);
  });

  it("los pausados no salen; los de otra empresa tampoco", async () => {
    const a = await m.crear(aviso({ titulo: "Pausado" }));
    await m.en(E1, () => m.servicio.editar({ empresaId: E1, actor: ADM, anuncioId: a.id, activo: false }));
    await m.crear(aviso({ titulo: "Ajeno" }), ADM, E2);
    await m.crear(aviso({ titulo: "Visible" }));
    assert.deepEqual((await ver()).publicidad.map((x) => x.titulo), ["Visible"]);
  });

  it("solo salen campos públicos (nada de quién lo creó ni fechas internas)", async () => {
    await m.crear(evento({ fecha: "2026-11-07", imagen: "https://img.example.com/a.jpg", descripcion: "Jazz en vivo" }));
    const [e] = (await ver()).eventos;
    assert.deepEqual(Object.keys(e).sort(), ["descripcion", "fecha", "hora", "id", "imagen", "lugar", "tipo", "titulo", "vigencia"]);
    assert.equal(e.imagen, "https://img.example.com/a.jpg");
  });

  it("empresa inexistente o inactiva: NO_ENCONTRADO", async () => {
    await rechaza(ver(JUEVES_20H, "cccccccccccccccccccccccc"), "NO_ENCONTRADO", 404);
    m.empresas[E1].activa = false;
    await rechaza(ver(), "NO_ENCONTRADO", 404);
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

  it("POST crear: exige x-requested-with y gestionar; 201 con el anuncio", async () => {
    assert.equal((await llamar("crear", req({ method: "POST", ...auth(), body: aviso() }))).body.codigo, "CSRF");
    assert.equal((await llamar("crear", req({ method: "POST", headers: X, ...auth(LECTOR), body: aviso() }))).statusCode, 403);
    assert.equal((await llamar("crear", req({ method: "POST", headers: X, ...auth(), body: evento({ hora: "x" }) }))).statusCode, 400);
    const ok = await llamar("crear", req({ method: "POST", headers: X, ...auth(), body: aviso() }));
    assert.equal(ok.statusCode, 201);
    assert.equal(ok.body.titulo, "Happy hour doble");
  });

  it("GET listar y PUT editar", async () => {
    const c = await llamar("crear", req({ method: "POST", headers: X, ...auth(), body: aviso() }));
    const lista = await llamar("listar", req({ ...auth(LECTOR) }));
    assert.equal(lista.body.anuncios.length, 1);
    const ed = await llamar("editar", req({ method: "PUT", headers: X, ...auth(), params: { anuncioId: c.body.id }, body: { activo: false } }));
    assert.equal(ed.body.activo, false);
    const no = await llamar("editar", req({ method: "PUT", headers: X, ...auth(), params: { anuncioId: "bbbbbbbbbbbbbbbbbbbbbbb9" }, body: { activo: true } }));
    assert.equal(no.statusCode, 404);
  });

  it("las rutas: tres, con sus permisos", () => {
    const rutas = [];
    const pedidos = [];
    const reg = (metodo) => (path, ...fns) => rutas.push({ metodo, path, n: fns.length });
    const router = { get: reg("get"), post: reg("post"), put: reg("put") };
    const h = new Proxy({}, { get: () => () => {} });
    montarRutasAnuncios(router, { anuncios: { manejadores: h }, autenticar: () => () => {}, requierePermiso: (p) => (pedidos.push(p), () => {}) });
    assert.deepEqual(rutas.map((r) => `${r.metodo} ${r.path}`), ["get /", "post /", "put /:anuncioId"]);
    assert.ok(rutas.every((r) => r.n === 3));
    assert.deepEqual(pedidos, ["anuncio:leer", "anuncio:gestionar"]);
  });
});
