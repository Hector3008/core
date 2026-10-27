// Disponibilidad del día (5.60): cocina marca platos como agotados. Sin base de datos: el servicio corre contra un
// almacén falso en memoria (lo que depende de MongoDB de verdad, como el aislamiento por empresa, lo cubre catalogo.test.js).
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { crearServicioCatalogo } from "../src/catalogo/index.js";
import { montarRutasCatalogo } from "../src/catalogo/rutas.js";
import { ErrorCatalogo } from "../src/catalogo/errores.js";
import { PLANTILLAS, plantillasPara } from "../src/modelos/plantillas.js";
import { permite } from "../src/permisos.js";
import { empresaActual } from "../src/tenancy.js";

// ---------- almacén falso ----------
const E1 = "aaaaaaaaaaaaaaaaaaaaaaa1";
const E2 = "aaaaaaaaaaaaaaaaaaaaaaa2";
const SIN_EMPRESA = "aaaaaaaaaaaaaaaaaaaaaaa9";

function crearFalso() {
  const docs = [];
  let n = 0;
  const propios = () => docs.filter((d) => d.empresaId === empresaActual());
  const conseguir = (d, k) => k.split(".").reduce((o, p) => o?.[p], d);
  const poner = (d, k, v) => {
    const ps = k.split(".");
    let o = d;
    for (const p of ps.slice(0, -1)) o = o[p] ??= {};
    o[ps.at(-1)] = v;
  };
  const quitar = (d, k) => {
    const ps = k.split(".");
    let o = d;
    for (const p of ps.slice(0, -1)) o = o?.[p];
    if (o) delete o[ps.at(-1)];
  };
  const coincide = (d, f) =>
    Object.entries(f).every(([k, v]) => {
      if (k === "$or") return v.some((x) => coincide(d, x));
      const x = conseguir(d, k);
      if (v && typeof v === "object" && "$in" in v) return v.$in.includes(x);
      if (v && typeof v === "object" && "$regex" in v) return typeof x === "string" && new RegExp(v.$regex, v.$options ?? "").test(x);
      if (v && typeof v === "object" && "$type" in v) return typeof x === "string";
      return String(x) === String(v);
    });
  const consulta = (fn) => {
    const q = { _r: fn, _sort: null, _skip: 0, _lim: Infinity };
    q.lean = () => q;
    q.select = () => q;
    q.sort = (s) => ((q._sort = s), q);
    q.skip = (s) => ((q._skip = s), q);
    q.limit = (l) => ((q._lim = l), q);
    q.then = (ok, ko) =>
      Promise.resolve()
        .then(() => {
          let r = q._r();
          if (Array.isArray(r) && q._sort)
            r = [...r].sort((a, b) => Number(b.agotado === true) - Number(a.agotado === true) || String(a.nombre).localeCompare(String(b.nombre)) || String(a._id).localeCompare(String(b._id)));
          if (Array.isArray(r)) r = r.slice(q._skip, q._skip + q._lim);
          return structuredClone(r);
        })
        .then(ok, ko);
    return q;
  };
  const Item = {
    _docs: docs,
    find: (f) => consulta(() => propios().filter((d) => coincide(d, f))),
    findOne: (f) => consulta(() => propios().find((d) => coincide(d, f)) ?? null),
    findById: (id) => consulta(() => propios().find((d) => d._id === String(id)) ?? null),
    async create(doc) {
      if (propios().some((d) => d.codigoClave === doc.codigoClave)) throw Object.assign(new Error("E11000"), { code: 11000 });
      const d = {
        _id: String(++n).padStart(24, "0"),
        empresaId: empresaActual(),
        categoria: null,
        precio: null,
        atributos: {},
        activo: true,
        desactivadoTs: null,
        agotado: false,
        agotadoTs: null,
        agotadoPor: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...structuredClone(doc),
      };
      docs.push(d);
      return { toObject: () => structuredClone(d) };
    },
    async updateOne(f, upd, opts = {}) {
      const d = propios().find((x) => coincide(x, f));
      if (!d) {
        if (!opts.upsert) return { matchedCount: 0, upsertedCount: 0 };
        const nuevo = { _id: String(++n).padStart(24, "0"), empresaId: empresaActual(), codigoClave: f.codigoClave, createdAt: new Date(), updatedAt: new Date() };
        for (const [k, v] of Object.entries(upd.$setOnInsert ?? {})) poner(nuevo, k, structuredClone(v));
        docs.push(nuevo);
        return { matchedCount: 0, upsertedCount: 1 };
      }
      // Como Mongoose: una actualización sin operadores es un $set; $setOnInsert no hace nada si el documento ya existía.
      const conOperadores = Object.keys(upd).some((k) => k.startsWith("$"));
      const $set = conOperadores ? (upd.$set ?? {}) : upd;
      for (const [k, v] of Object.entries($set)) poner(d, k, structuredClone(v));
      for (const k of Object.keys(upd.$unset ?? {})) quitar(d, k);
      d.updatedAt = new Date();
      return { matchedCount: 1, upsertedCount: 0 };
    },
    async aggregate() {
      const cuenta = new Map();
      for (const d of propios().filter((x) => x.activo === true && typeof x.categoria === "string"))
        cuenta.set(d.categoria, (cuenta.get(d.categoria) ?? 0) + 1);
      return [...cuenta].sort(([a], [b]) => a.localeCompare(b)).map(([_id, cantidad]) => ({ _id, cantidad }));
    },
  };
  const Empresa = {
    findById: (id) => consulta(() => ([E1, E2].includes(String(id)) ? { _id: String(id), activa: true } : String(id) === SIN_EMPRESA ? { _id: SIN_EMPRESA, activa: false, moneda: "USD" } : null)),
  };
  return { Item, Empresa };
}

const rechaza = (p, codigo, status) =>
  assert.rejects(p, (e) => e instanceof ErrorCatalogo && e.codigo === codigo && (status === undefined || e.status === status));

const ADM = { usuarioId: "0123456789abcdef01234567", permisos: ["*"] };
const COCINA = { usuarioId: "0123456789abcdef01234570", permisos: PLANTILLAS.tobt.cocina };
const MESERO = { usuarioId: "0123456789abcdef01234571", permisos: PLANTILLAS.tobt.mesero };
const EDITOR = { usuarioId: "0123456789abcdef01234569", permisos: ["catalogo:leer", "catalogo:crear", "catalogo:editar", "catalogo:gestionar"] };

describe("catálogo: disponibilidad (agotados)", () => {
  let falso, cat;
  const nuevo = (codigo, nombre, extra = {}, empresaId = E1) => cat.crear({ empresaId, actor: ADM, codigo, nombre, ...extra });

  beforeEach(() => {
    falso = crearFalso();
    cat = crearServicioCatalogo(falso, { exigirCsrf() {} });
  });

  describe("marcarAgotado", () => {
    it("un ítem nuevo está disponible", async () => {
      const i = await nuevo("CAF-01", "Latte");
      assert.equal(i.agotado, false);
      assert.equal(i.agotadoTs, null);
    });

    it("cocina lo marca agotado: guarda cuándo y quién, y el dto lo muestra en obtener y en listar", async () => {
      const i = await nuevo("CAF-01", "Latte", { precio: 9 });
      const r = await cat.marcarAgotado({ empresaId: E1, actor: COCINA, itemId: i.id, agotado: true });
      assert.equal(r.agotado, true);
      assert.ok(r.agotadoTs instanceof Date);
      assert.equal(falso.Item._docs[0].agotadoPor, COCINA.usuarioId);
      assert.equal((await cat.obtener({ empresaId: E1, codigo: "caf-01" })).agotado, true);
      assert.equal((await cat.listar({ empresaId: E1 }))[0].agotado, true);
      assert.equal((await cat.buscar({ empresaId: E1, texto: "latte" }))[0].agotado, true);
    });

    it("no es una baja: sigue activo, conserva precio y datos, y sigue sirviendo para instantanea", async () => {
      const i = await nuevo("CAF-01", "Latte", { precio: 9, categoria: "Cafés" });
      await cat.marcarAgotado({ empresaId: E1, actor: COCINA, itemId: i.id, agotado: true });
      const r = await cat.obtener({ empresaId: E1, itemId: i.id });
      assert.equal(r.activo, true);
      assert.equal(r.precio, 9);
      assert.equal(r.categoria, "Cafés");
      const [snap] = await cat.instantanea({ empresaId: E1, items: ["CAF-01"] });
      assert.equal(snap.nombre, "Latte");
      assert.equal("agotado" in snap, false); // la copia del documento no guarda la disponibilidad del día
    });

    it("lo vuelve a poner disponible y limpia quién y cuándo", async () => {
      const i = await nuevo("CAF-01", "Latte");
      await cat.marcarAgotado({ empresaId: E1, actor: COCINA, itemId: i.id, agotado: true });
      const r = await cat.marcarAgotado({ empresaId: E1, actor: COCINA, itemId: i.id, agotado: false });
      assert.equal(r.agotado, false);
      assert.equal(r.agotadoTs, null);
      assert.equal(falso.Item._docs[0].agotadoPor, null);
    });

    it("repetir el mismo estado no cambia nada (ni quién ni cuándo)", async () => {
      const i = await nuevo("CAF-01", "Latte");
      const a = await cat.marcarAgotado({ empresaId: E1, actor: COCINA, itemId: i.id, agotado: true });
      const otra = { usuarioId: "0123456789abcdef01234599", permisos: ["catalogo:disponibilidad"] };
      const b = await cat.marcarAgotado({ empresaId: E1, actor: otra, itemId: i.id, agotado: true });
      assert.deepEqual(b.agotadoTs, a.agotadoTs);
      assert.equal(falso.Item._docs[0].agotadoPor, COCINA.usuarioId);
      const libre = await nuevo("CAF-02", "Moka");
      const c = await cat.marcarAgotado({ empresaId: E1, actor: COCINA, itemId: libre.id, agotado: false });
      assert.equal(c.agotado, false);
    });

    it("exige catalogo:disponibilidad: el mesero, el editor del catálogo y quien solo lee no pueden", async () => {
      const i = await nuevo("CAF-01", "Latte");
      for (const actor of [MESERO, EDITOR, { usuarioId: ADM.usuarioId, permisos: ["catalogo:leer"] }])
        await rechaza(cat.marcarAgotado({ empresaId: E1, actor, itemId: i.id, agotado: true }), "PERMISO_INSUFICIENTE", 403);
      await rechaza(cat.marcarAgotado({ empresaId: E1, actor: undefined, itemId: i.id, agotado: true }), "PERMISO_INSUFICIENTE");
      assert.equal((await cat.obtener({ empresaId: E1, itemId: i.id })).agotado, false);
    });

    it("lo permiten catalogo:* y el administrador (*)", async () => {
      const i = await nuevo("CAF-01", "Latte");
      await cat.marcarAgotado({ empresaId: E1, actor: ADM, itemId: i.id, agotado: true });
      const r = await cat.marcarAgotado({ empresaId: E1, actor: { usuarioId: ADM.usuarioId, permisos: ["catalogo:*"] }, itemId: i.id, agotado: false });
      assert.equal(r.agotado, false);
    });

    it("agotado debe ser true o false (texto, número o ausente se rechazan)", async () => {
      const i = await nuevo("CAF-01", "Latte");
      for (const agotado of ["true", 1, null, undefined])
        await rechaza(cat.marcarAgotado({ empresaId: E1, actor: COCINA, itemId: i.id, agotado }), "DATOS_INVALIDOS", 400);
    });

    it("un ítem inexistente es 404, un id mal formado 400 y uno desactivado 409", async () => {
      await rechaza(cat.marcarAgotado({ empresaId: E1, actor: COCINA, itemId: "0123456789abcdef01234999", agotado: true }), "NO_ENCONTRADO", 404);
      await rechaza(cat.marcarAgotado({ empresaId: E1, actor: COCINA, itemId: "xx", agotado: true }), "DATOS_INVALIDOS", 400);
      const i = await nuevo("CAF-01", "Latte");
      await cat.desactivar({ empresaId: E1, actor: ADM, itemId: i.id });
      await rechaza(cat.marcarAgotado({ empresaId: E1, actor: COCINA, itemId: i.id, agotado: true }), "ESTADO_INVALIDO", 409);
    });

    it("no toca a otra empresa", async () => {
      const i = await nuevo("CAF-01", "Latte");
      await rechaza(cat.marcarAgotado({ empresaId: E2, actor: COCINA, itemId: i.id, agotado: true }), "NO_ENCONTRADO", 404);
      assert.equal((await cat.obtener({ empresaId: E1, itemId: i.id })).agotado, false);
    });

    it("editar el ítem (actualizar) no cambia si está agotado", async () => {
      const i = await nuevo("CAF-01", "Latte");
      await cat.marcarAgotado({ empresaId: E1, actor: COCINA, itemId: i.id, agotado: true });
      const r = await cat.actualizar({ empresaId: E1, actor: ADM, itemId: i.id, precio: 10 });
      assert.equal(r.agotado, true);
      assert.equal(r.precio, 10);
    });
  });

  describe("disponibilidad (la lista de cocina)", () => {
    beforeEach(async () => {
      await nuevo("CAF-01", "Latte", { precio: 9, categoria: "Cafés" });
      const moka = await nuevo("CAF-02", "Moka", { precio: 10, categoria: "Cafés" });
      await nuevo("SAN-01", "Sándwich", { precio: 12, categoria: "Comida" });
      await nuevo("OTRA", "Ajeno", {}, E2);
      await cat.marcarAgotado({ empresaId: E1, actor: COCINA, itemId: moka.id, agotado: true });
    });

    it("trae los agotados primero y luego por nombre, sin precio, y solo de la empresa", async () => {
      const l = await cat.disponibilidad({ empresaId: E1 });
      assert.deepEqual(l.map((x) => x.codigo), ["CAF-02", "CAF-01", "SAN-01"]);
      assert.deepEqual(Object.keys(l[0]).sort(), ["agotado", "agotadoTs", "categoria", "codigo", "id", "nombre"]);
      assert.equal(l[0].agotado, true);
      assert.equal(l[1].agotado, false);
      assert.equal(l.some((x) => "precio" in x || "atributos" in x), false);
    });

    it("soloAgotados deja los marcados", async () => {
      const l = await cat.disponibilidad({ empresaId: E1, soloAgotados: true });
      assert.deepEqual(l.map((x) => x.codigo), ["CAF-02"]);
    });

    it("busca por texto como el catálogo (comienzo del código o parte del nombre)", async () => {
      assert.deepEqual((await cat.disponibilidad({ empresaId: E1, texto: "san" })).map((x) => x.codigo), ["SAN-01"]);
      assert.deepEqual((await cat.disponibilidad({ empresaId: E1, texto: "oka" })).map((x) => x.codigo), ["CAF-02"]);
      assert.deepEqual(await cat.disponibilidad({ empresaId: E1, texto: "zzz" }), []);
    });

    it("no lista los desactivados", async () => {
      const [san] = await cat.listar({ empresaId: E1, texto: "SAN" });
      await cat.desactivar({ empresaId: E1, actor: ADM, itemId: san.id });
      assert.deepEqual((await cat.disponibilidad({ empresaId: E1 })).map((x) => x.codigo), ["CAF-02", "CAF-01"]);
    });

    it("respeta el límite y el salto (máximo 200)", async () => {
      assert.equal((await cat.disponibilidad({ empresaId: E1, limite: 1 })).length, 1);
      assert.deepEqual((await cat.disponibilidad({ empresaId: E1, limite: 1, saltar: 1 })).map((x) => x.codigo), ["CAF-01"]);
      assert.equal((await cat.disponibilidad({ empresaId: E1, limite: 9999 })).length, 3);
    });
  });

  describe("agotadosDe (el aviso al armar un pedido)", () => {
    it("devuelve solo los agotados y activos, sin distinguir mayúsculas, sin repetir y con el código guardado", async () => {
      const a = await nuevo("CAF-01", "Latte");
      await nuevo("CAF-02", "Moka");
      const c = await nuevo("CAF-03", "Té");
      await cat.marcarAgotado({ empresaId: E1, actor: COCINA, itemId: a.id, agotado: true });
      await cat.marcarAgotado({ empresaId: E1, actor: COCINA, itemId: c.id, agotado: true });
      await cat.desactivar({ empresaId: E1, actor: ADM, itemId: c.id });
      const r = await cat.agotadosDe({ empresaId: E1, codigos: ["caf-01", "CAF-01", "CAF-02", "CAF-03", "NO-HAY"] });
      assert.deepEqual(r, [{ codigo: "CAF-01", nombre: "Latte" }]);
    });

    it("con entradas raras (vacío, sin lista, números, líneas libres) devuelve [] sin fallar", async () => {
      assert.deepEqual(await cat.agotadosDe({ empresaId: E1, codigos: [] }), []);
      assert.deepEqual(await cat.agotadosDe({ empresaId: E1, codigos: undefined }), []);
      assert.deepEqual(await cat.agotadosDe({ empresaId: E1, codigos: [null, 5, "", "  ", {}] }), []);
    });

    it("solo mira la empresa activa", async () => {
      const a = await nuevo("CAF-01", "Latte");
      await cat.marcarAgotado({ empresaId: E1, actor: COCINA, itemId: a.id, agotado: true });
      assert.deepEqual(await cat.agotadosDe({ empresaId: E2, codigos: ["CAF-01"] }), []);
    });
  });

  describe("plantillas y rutas", () => {
    it("la plantilla de cocina trae catalogo:disponibilidad y nada más del catálogo; el mesero no la trae", () => {
      assert.ok(permite(PLANTILLAS.tobt.cocina, "catalogo:disponibilidad"));
      assert.equal(permite(PLANTILLAS.tobt.cocina, "catalogo:leer"), false);
      assert.equal(permite(PLANTILLAS.tobt.cocina, "catalogo:editar"), false);
      assert.equal(permite(PLANTILLAS.tobt.mesero, "catalogo:disponibilidad"), false);
      assert.ok(plantillasPara(["tobt"]).cocina.includes("catalogo:disponibilidad"));
    });

    it("las rutas nuevas llevan su permiso y van antes de /:itemId", () => {
      const rutas = [];
      const reg = (metodo) => (path, ...fns) => rutas.push({ metodo, path, n: fns.length });
      const router = { get: reg("get"), post: reg("post"), put: reg("put") };
      const pedidos = [];
      montarRutasCatalogo(router, {
        catalogo: { manejadores: new Proxy({}, { get: (_, k) => String(k) }) },
        autenticar: () => "auth",
        requierePermiso: (p) => (pedidos.push(p), p),
      });
      assert.ok(pedidos.includes("catalogo:disponibilidad"));
      const iDisp = rutas.findIndex((r) => r.metodo === "get" && r.path === "/disponibilidad");
      const iObt = rutas.findIndex((r) => r.metodo === "get" && r.path === "/:itemId");
      assert.ok(iDisp >= 0 && iObt >= 0 && iDisp < iObt);
      assert.ok(rutas.some((r) => r.metodo === "put" && r.path === "/:itemId/disponibilidad" && r.n === 3));
    });
  });

  describe("manejadores HTTP", () => {
    const res = () => {
      const s = { statusCode: 200, body: undefined };
      s.status = (c) => ((s.statusCode = c), s);
      s.json = (b) => ((s.body = b), s);
      return s;
    };
    const req = (rol, extra = {}) => ({ auth: { empresaId: E1, usuarioId: rol.usuarioId }, rol: { permisos: rol.permisos }, params: {}, query: {}, body: {}, ...extra });
    const llama = async (nombre, r) => {
      const s = res();
      let err;
      await cat.manejadores[nombre](r, s, (e) => (err = e));
      return { s, err };
    };

    it("PUT marca y desmarca y GET lista; un mesero recibe 403 aunque la ruta no tuviera middleware", async () => {
      const i = await nuevo("CAF-01", "Latte");
      let { s } = await llama("marcarAgotado", req(COCINA, { params: { itemId: i.id }, body: { agotado: true } }));
      assert.equal(s.statusCode, 200);
      assert.equal(s.body.agotado, true);
      ({ s } = await llama("disponibilidad", req(COCINA, { query: { agotados: "1" } })));
      assert.deepEqual(s.body.items.map((x) => x.codigo), ["CAF-01"]);
      ({ s } = await llama("disponibilidad", req(COCINA, { query: { q: "zz" } })));
      assert.deepEqual(s.body.items, []);
      ({ s } = await llama("marcarAgotado", req(MESERO, { params: { itemId: i.id }, body: { agotado: false } })));
      assert.equal(s.statusCode, 403);
      ({ s } = await llama("marcarAgotado", req(COCINA, { params: { itemId: i.id }, body: { agotado: "no" } })));
      assert.equal(s.statusCode, 400);
      ({ s } = await llama("marcarAgotado", req(COCINA, { params: { itemId: i.id }, body: { agotado: false } })));
      assert.equal(s.body.agotado, false);
    });
  });
});
