// No necesita base de datos: prueba la lógica del servicio contra un almacén falso en memoria.
// Lo que depende de MongoDB de verdad (índice único, upsert, aggregate, tenancy) lo cubre catalogo.test.js.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { crearServicioCatalogo } from "../src/catalogo/index.js";
import { ErrorCatalogo } from "../src/catalogo/errores.js";
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
            r = [...r].sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)) || String(a._id).localeCompare(String(b._id)));
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
const SOLO_LEER = { usuarioId: "0123456789abcdef01234568", permisos: ["catalogo:leer"] };
const EDITOR = { usuarioId: "0123456789abcdef01234569", permisos: ["catalogo:leer", "catalogo:crear", "catalogo:editar"] };

describe("catálogo: lógica del servicio", () => {
  let falso, cat;
  const nuevo = (extra = {}, empresaId = E1, actor = ADM) => cat.crear({ empresaId, actor, codigo: "CAF-01", nombre: "Café americano", ...extra });

  beforeEach(() => {
    falso = crearFalso();
    cat = crearServicioCatalogo(falso, { exigirCsrf() {} });
  });

  describe("crear y obtener", () => {
    it("crea con solo código y nombre: categoría y precio quedan sin valor", async () => {
      const i = await nuevo();
      assert.match(i.id, /^[0-9a-f]{24}$/);
      assert.equal(i.codigo, "CAF-01");
      assert.equal(i.nombre, "Café americano");
      assert.equal(i.categoria, null);
      assert.equal(i.precio, null);
      assert.deepEqual(i.atributos, {});
      assert.equal(i.activo, true);
    });

    it("crea con todo: categoría, precio con 2 decimales y atributos sin claves nulas", async () => {
      const i = await nuevo({ categoria: " Bebidas ", precio: 7.5, atributos: { TAMANO: "grande", x: null } });
      assert.equal(i.categoria, "Bebidas");
      assert.equal(i.precio, 7.5);
      assert.deepEqual(i.atributos, { TAMANO: "grande" });
    });

    it("el mismo código con otras mayúsculas es un duplicado y dice con qué ítem choca", async () => {
      const a = await nuevo({ codigo: "ZM-100" });
      await assert.rejects(nuevo({ codigo: "zm-100", nombre: "Otro" }), (e) => {
        assert.equal(e.codigo, "ITEM_DUPLICADO");
        assert.equal(e.status, 409);
        assert.equal(e.detalle.campo, "codigo");
        assert.equal(e.detalle.itemId, a.id);
        return true;
      });
    });

    it("dos empresas pueden usar el mismo código", async () => {
      await nuevo({ codigo: "X1" }, E1);
      await assert.doesNotReject(nuevo({ codigo: "X1" }, E2));
    });

    it("comprueba el permiso de quien llama, aunque la ruta no lo haga", async () => {
      await rechaza(nuevo({}, E1, SOLO_LEER), "PERMISO_INSUFICIENTE", 403);
      await rechaza(cat.crear({ empresaId: E1, codigo: "A", nombre: "x" }), "PERMISO_INSUFICIENTE", 403);
      await rechaza(cat.crear({ empresaId: E1, actor: { permisos: "*" }, codigo: "A", nombre: "x" }), "PERMISO_INSUFICIENTE", 403);
      assert.equal(falso.Item._docs.length, 0);
    });

    it("rechaza una empresa que no existe o está desactivada", async () => {
      await rechaza(nuevo({}, "bbbbbbbbbbbbbbbbbbbbbbbb"), "NO_ENCONTRADO", 404);
      await rechaza(nuevo({}, SIN_EMPRESA), "NO_ENCONTRADO", 404);
    });

    it("valida antes de guardar (nada queda a medias)", async () => {
      await rechaza(nuevo({ precio: 1.234 }), "DATOS_INVALIDOS", 400);
      await rechaza(nuevo({ codigo: "con espacio" }), "DATOS_INVALIDOS");
      await rechaza(nuevo({ nombre: "" }), "DATOS_INVALIDOS");
      assert.equal(falso.Item._docs.length, 0);
    });

    it("obtiene por id y por código (sin distinguir mayúsculas), pero no con los dos ni con ninguno", async () => {
      const i = await nuevo({ codigo: "ZM-9" });
      assert.equal((await cat.obtener({ empresaId: E1, itemId: i.id })).codigo, "ZM-9");
      assert.equal((await cat.obtener({ empresaId: E1, codigo: "zm-9" })).id, i.id);
      await rechaza(cat.obtener({ empresaId: E1, itemId: i.id, codigo: "ZM-9" }), "DATOS_INVALIDOS");
      await rechaza(cat.obtener({ empresaId: E1 }), "DATOS_INVALIDOS");
      await rechaza(cat.obtener({ empresaId: E1, codigo: "NO-EXISTE" }), "NO_ENCONTRADO", 404);
      await rechaza(cat.obtener({ empresaId: E1, itemId: "cccccccccccccccccccccccc" }), "NO_ENCONTRADO");
      await rechaza(cat.obtener({ empresaId: E1, itemId: "abc" }), "DATOS_INVALIDOS");
    });

    it("una empresa no ve los ítems de otra", async () => {
      const i = await nuevo({ codigo: "SOLO-E1" }, E1);
      await rechaza(cat.obtener({ empresaId: E2, itemId: i.id }), "NO_ENCONTRADO");
      await rechaza(cat.obtener({ empresaId: E2, codigo: "SOLO-E1" }), "NO_ENCONTRADO");
      assert.deepEqual(await cat.listar({ empresaId: E2 }), []);
    });
  });

  describe("actualizar", () => {
    it("cambia nombre, precio y categoría; lo que no llega no se toca", async () => {
      const i = await nuevo({ categoria: "Bebidas", precio: 5, atributos: { A: 1 } });
      const r = await cat.actualizar({ empresaId: E1, actor: EDITOR, itemId: i.id, nombre: "Café largo", precio: 5.5 });
      assert.equal(r.nombre, "Café largo");
      assert.equal(r.precio, 5.5);
      assert.equal(r.categoria, "Bebidas");
      assert.deepEqual(r.atributos, { A: 1 });
    });

    it("null quita la categoría y el precio", async () => {
      const i = await nuevo({ categoria: "Bebidas", precio: 5 });
      const r = await cat.actualizar({ empresaId: E1, actor: EDITOR, itemId: i.id, categoria: null, precio: null });
      assert.equal(r.categoria, null);
      assert.equal(r.precio, null);
    });

    it("los atributos se combinan clave por clave; un null quita esa clave", async () => {
      const i = await nuevo({ atributos: { A: 1, B: 2, C: 3 } });
      const r = await cat.actualizar({ empresaId: E1, actor: EDITOR, itemId: i.id, atributos: { B: null, D: 4, C: 30 } });
      assert.deepEqual(r.atributos, { A: 1, C: 30, D: 4 });
    });

    it("atributos null los quita todos", async () => {
      const i = await nuevo({ atributos: { A: 1 } });
      const r = await cat.actualizar({ empresaId: E1, actor: EDITOR, itemId: i.id, atributos: null });
      assert.deepEqual(r.atributos, {});
    });

    it("el código no se puede cambiar (repetir el mismo, aunque con otras mayúsculas, no molesta)", async () => {
      const i = await nuevo({ codigo: "ZM-5" });
      await rechaza(cat.actualizar({ empresaId: E1, actor: EDITOR, itemId: i.id, codigo: "ZM-6", nombre: "x" }), "DATOS_INVALIDOS");
      const r = await cat.actualizar({ empresaId: E1, actor: EDITOR, itemId: i.id, codigo: "zm-5", nombre: "Nuevo" });
      assert.equal(r.codigo, "ZM-5");
      assert.equal(r.nombre, "Nuevo");
    });

    it("el nombre no se puede quitar y sin cambios es un error", async () => {
      const i = await nuevo();
      await rechaza(cat.actualizar({ empresaId: E1, actor: EDITOR, itemId: i.id, nombre: null }), "DATOS_INVALIDOS");
      await rechaza(cat.actualizar({ empresaId: E1, actor: EDITOR, itemId: i.id }), "DATOS_INVALIDOS");
    });

    it("exige catalogo:editar", async () => {
      const i = await nuevo();
      await rechaza(cat.actualizar({ empresaId: E1, actor: SOLO_LEER, itemId: i.id, nombre: "x" }), "PERMISO_INSUFICIENTE", 403);
    });

    it("el tamaño de los atributos se mide sobre el resultado combinado", async () => {
      const i = await nuevo({ atributos: { A: "x".repeat(400), B: "x".repeat(400), C: "x".repeat(400), D: "x".repeat(400), E: "x".repeat(400), F: "x".repeat(400), G: "x".repeat(400), H: "x".repeat(400), I: "x".repeat(400) } });
      await rechaza(cat.actualizar({ empresaId: E1, actor: EDITOR, itemId: i.id, atributos: { J: "x".repeat(400), K: "x".repeat(400), L: "x".repeat(400) } }), "DATOS_INVALIDOS");
    });
  });

  describe("esquemas de atributos", () => {
    it("un servicio declara sus campos y el núcleo valida por tipo en crear y actualizar", async () => {
      cat.registrarEsquema({ campos: { MARCA: "texto", STOCK: "numero", EQUIVALENTES: "lista" } });
      assert.deepEqual(cat.esquemas(), { MARCA: "texto", STOCK: "numero", EQUIVALENTES: "lista" });
      await rechaza(nuevo({ atributos: { STOCK: "4" } }), "DATOS_INVALIDOS");
      const i = await nuevo({ atributos: { MARCA: "Bosch", STOCK: 4, EQUIVALENTES: [{ codigo: "ZM-2", stock: 1 }] } });
      assert.deepEqual(i.atributos.EQUIVALENTES, [{ codigo: "ZM-2", stock: 1 }]);
      await rechaza(cat.actualizar({ empresaId: E1, actor: EDITOR, itemId: i.id, atributos: { EQUIVALENTES: "ZM-2" } }), "DATOS_INVALIDOS");
    });
  });

  describe("listar, buscar y categorías", () => {
    beforeEach(async () => {
      await nuevo({ codigo: "CAF-01", nombre: "Café americano", categoria: "Bebidas" });
      await nuevo({ codigo: "CAF-02", nombre: "Cappuccino", categoria: "Bebidas" });
      await nuevo({ codigo: "POS-01", nombre: "Torta de chocolate", categoria: "Postres" });
      await nuevo({ codigo: "SIN-CAT", nombre: "Servicio de mesa" });
    });

    it("lista por nombre", async () => {
      const r = await cat.listar({ empresaId: E1 });
      assert.deepEqual(r.map((i) => i.codigo), ["CAF-01", "CAF-02", "SIN-CAT", "POS-01"]); // Café, Cappuccino, Servicio, Torta
    });

    it("busca por el comienzo del código (sin mayúsculas) o por parte del nombre", async () => {
      assert.deepEqual((await cat.buscar({ empresaId: E1, texto: "caf-0" })).map((i) => i.codigo).sort(), ["CAF-01", "CAF-02"]);
      assert.deepEqual((await cat.buscar({ empresaId: E1, texto: "chocolate" })).map((i) => i.codigo), ["POS-01"]);
      assert.deepEqual((await cat.buscar({ empresaId: E1, texto: "TORTA" })).map((i) => i.codigo), ["POS-01"]);
      assert.deepEqual(await cat.buscar({ empresaId: E1, texto: "-01" }), []); // el código se busca por el comienzo, no por el medio
    });

    it("el texto de búsqueda no se interpreta como expresión regular", async () => {
      assert.deepEqual(await cat.buscar({ empresaId: E1, texto: ".*" }), []);
      assert.deepEqual(await cat.buscar({ empresaId: E1, texto: "(" }), []);
    });

    it("rechaza una búsqueda vacía o demasiado larga", async () => {
      await rechaza(cat.buscar({ empresaId: E1 }), "DATOS_INVALIDOS");
      await rechaza(cat.buscar({ empresaId: E1, texto: "  " }), "DATOS_INVALIDOS");
      await rechaza(cat.buscar({ empresaId: E1, texto: "x".repeat(81) }), "DATOS_INVALIDOS");
    });

    it("filtra por categoría", async () => {
      assert.deepEqual((await cat.listar({ empresaId: E1, categoria: "Postres" })).map((i) => i.codigo), ["POS-01"]);
      await rechaza(cat.listar({ empresaId: E1, categoria: "" }), "DATOS_INVALIDOS");
    });

    it("pagina con límite y saltar (máximo 200)", async () => {
      assert.equal((await cat.listar({ empresaId: E1, limite: 2 })).length, 2);
      assert.equal((await cat.listar({ empresaId: E1, limite: 2, saltar: 3 })).length, 1);
      assert.equal((await cat.listar({ empresaId: E1, limite: 99999 })).length, 4);
    });

    it("las categorías en uso, con su cantidad, solo de ítems activos", async () => {
      assert.deepEqual(await cat.categorias({ empresaId: E1 }), [
        { categoria: "Bebidas", cantidad: 2 },
        { categoria: "Postres", cantidad: 1 },
      ]);
      const pos = await cat.obtener({ empresaId: E1, codigo: "POS-01" });
      await cat.desactivar({ empresaId: E1, actor: ADM, itemId: pos.id });
      assert.deepEqual(await cat.categorias({ empresaId: E1 }), [{ categoria: "Bebidas", cantidad: 2 }]);
    });
  });

  describe("baja y reactivación", () => {
    it("desactivar oculta el ítem de las listas pero sigue consultable; reactivar lo devuelve", async () => {
      const i = await nuevo();
      const d = await cat.desactivar({ empresaId: E1, actor: ADM, itemId: i.id });
      assert.equal(d.activo, false);
      assert.deepEqual(await cat.listar({ empresaId: E1 }), []);
      assert.equal((await cat.listar({ empresaId: E1, incluirInactivos: true })).length, 1);
      assert.equal((await cat.obtener({ empresaId: E1, itemId: i.id })).activo, false);
      const r = await cat.reactivar({ empresaId: E1, actor: ADM, itemId: i.id });
      assert.equal(r.activo, true);
      assert.equal((await cat.listar({ empresaId: E1 })).length, 1);
    });

    it("repetir una baja o una reactivación es un error de estado", async () => {
      const i = await nuevo();
      await rechaza(cat.reactivar({ empresaId: E1, actor: ADM, itemId: i.id }), "ESTADO_INVALIDO", 409);
      await cat.desactivar({ empresaId: E1, actor: ADM, itemId: i.id });
      await rechaza(cat.desactivar({ empresaId: E1, actor: ADM, itemId: i.id }), "ESTADO_INVALIDO", 409);
    });

    it("exige catalogo:gestionar", async () => {
      const i = await nuevo();
      await rechaza(cat.desactivar({ empresaId: E1, actor: EDITOR, itemId: i.id }), "PERMISO_INSUFICIENTE", 403);
      await rechaza(cat.reactivar({ empresaId: E1, actor: EDITOR, itemId: i.id }), "PERMISO_INSUFICIENTE", 403);
    });
  });

  describe("instantanea (lo que se copia al documento)", () => {
    beforeEach(async () => {
      await nuevo({ codigo: "ZM-1", nombre: "Filtro de aceite", categoria: "Filtros", precio: 25.9, atributos: { MARCA: "Bosch", EQUIVALENTES: [{ codigo: "ZM-2", stock: 3 }] } });
      await nuevo({ codigo: "ZM-2", nombre: "Filtro de aire", precio: 31 });
      await nuevo({ codigo: "ZM-3", nombre: "Bujía", precio: 8.5 });
    });

    it("copia nombre, precio, categoría y atributos de ítems del catálogo, marcados con su origen", async () => {
      const [a] = await cat.instantanea({ empresaId: E1, items: ["ZM-1"] });
      assert.equal(a.origen, "catalogo");
      assert.match(a.itemId, /^[0-9a-f]{24}$/);
      assert.deepEqual({ ...a, itemId: undefined }, {
        origen: "catalogo",
        itemId: undefined,
        codigo: "ZM-1",
        nombre: "Filtro de aceite",
        precio: 25.9,
        categoria: "Filtros",
        atributos: { MARCA: "Bosch", EQUIVALENTES: [{ codigo: "ZM-2", stock: 3 }] },
      });
    });

    it("una línea libre se monta sin estar en el catálogo, marcada como libre y sin guardarse", async () => {
      const antes = falso.Item._docs.length;
      const [l] = await cat.instantanea({
        empresaId: E1,
        items: [{ libre: { nombre: "Empaquetadura nueva", codigo: "PROV-77", precio: 12.5, atributos: { MARCA: "Victor" } } }],
      });
      assert.deepEqual(l, {
        origen: "libre",
        itemId: null,
        codigo: "PROV-77",
        nombre: "Empaquetadura nueva",
        precio: 12.5,
        categoria: null,
        atributos: { MARCA: "Victor" },
      });
      assert.equal(falso.Item._docs.length, antes, "la línea libre no debe agregarse al catálogo");
    });

    it("una línea libre puede venir solo con el nombre", async () => {
      const [l] = await cat.instantanea({ empresaId: E1, items: [{ libre: { nombre: "Repuesto sin código" } }] });
      assert.equal(l.origen, "libre");
      assert.equal(l.codigo, null);
      assert.equal(l.precio, null);
      assert.deepEqual(l.atributos, {});
    });

    it("mezcla ítems del catálogo y líneas libres, y conserva el orden y las repeticiones", async () => {
      const r = await cat.instantanea({
        empresaId: E1,
        items: ["ZM-3", { libre: { nombre: "Cosa nueva" } }, { codigo: "zm-1" }, "ZM-3"],
      });
      assert.deepEqual(r.map((x) => [x.origen, x.codigo]), [["catalogo", "ZM-3"], ["libre", null], ["catalogo", "ZM-1"], ["catalogo", "ZM-3"]]);
    });

    it("ignora los otros campos de cada elemento (cantidad, notas): son del servicio", async () => {
      const r = await cat.instantanea({ empresaId: E1, items: [{ codigo: "ZM-1", cantidad: 2 }, { libre: { nombre: "Cosa" }, cantidad: 5 }] });
      assert.equal(r.length, 2);
      assert.ok(!("cantidad" in r[0]) && !("cantidad" in r[1]));
    });

    it("el código del catálogo se devuelve como está guardado, aunque se pida con otras mayúsculas", async () => {
      const [a] = await cat.instantanea({ empresaId: E1, items: ["zm-1"] });
      assert.equal(a.codigo, "ZM-1");
    });

    it("`campos` limita lo que se copia (origen, itemId y código van siempre)", async () => {
      const [a, l] = await cat.instantanea({ empresaId: E1, items: ["ZM-1", { libre: { nombre: "x", precio: 1 } }], campos: ["nombre", "precio"] });
      assert.deepEqual(Object.keys(a).sort(), ["codigo", "itemId", "nombre", "origen", "precio"]);
      assert.deepEqual(Object.keys(l).sort(), ["codigo", "itemId", "nombre", "origen", "precio"]);
      await rechaza(cat.instantanea({ empresaId: E1, items: ["ZM-1"], campos: ["nombre", "stock"] }), "DATOS_INVALIDOS");
    });

    it("un código que no existe o está desactivado hace fallar todo, con la lista de los que no sirven", async () => {
      const zm3 = await cat.obtener({ empresaId: E1, codigo: "ZM-3" });
      await cat.desactivar({ empresaId: E1, actor: ADM, itemId: zm3.id });
      await assert.rejects(cat.instantanea({ empresaId: E1, items: ["ZM-1", "ZM-3", "NO-HAY", "NO-HAY", { libre: { nombre: "ok" } }] }), (e) => {
        assert.equal(e.codigo, "ITEM_NO_DISPONIBLE");
        assert.equal(e.status, 409);
        assert.deepEqual(e.detalle, { noEncontrados: ["NO-HAY"], inactivos: ["ZM-3"] });
        return true;
      });
    });

    it("una línea libre no puede usar el código de un ítem del catálogo (activo o no)", async () => {
      await assert.rejects(cat.instantanea({ empresaId: E1, items: [{ libre: { nombre: "Otro filtro", codigo: "zm-1" } }, { libre: { nombre: "Otra", codigo: "ZM-2" } }] }), (e) => {
        assert.equal(e.codigo, "CODIGO_EN_CATALOGO");
        assert.equal(e.status, 409);
        assert.deepEqual(e.detalle.codigos.sort(), ["ZM-2", "zm-1"]);
        return true;
      });
      const zm3 = await cat.obtener({ empresaId: E1, codigo: "ZM-3" });
      await cat.desactivar({ empresaId: E1, actor: ADM, itemId: zm3.id });
      await rechaza(cat.instantanea({ empresaId: E1, items: [{ libre: { nombre: "Bujía otra", codigo: "ZM-3" } }] }), "CODIGO_EN_CATALOGO");
    });

    it("el mismo código libre puede repetirse si no está en el catálogo", async () => {
      const r = await cat.instantanea({ empresaId: E1, items: [{ libre: { nombre: "A", codigo: "TMP-1" } }, { libre: { nombre: "A", codigo: "TMP-1" } }] });
      assert.equal(r.length, 2);
    });

    it("no ve el catálogo de otra empresa", async () => {
      await rechaza(cat.instantanea({ empresaId: E2, items: ["ZM-1"] }), "ITEM_NO_DISPONIBLE");
    });

    it("rechaza entradas mal formadas", async () => {
      for (const items of [undefined, null, [], "ZM-1", {}, Array(501).fill("ZM-1")])
        await rechaza(cat.instantanea({ empresaId: E1, items }), "DATOS_INVALIDOS");
      for (const e of [5, null, [], {}, { codigo: "con espacio" }, { libre: {} }, { libre: { nombre: "x", cantidad: 1 } }, { libre: { nombre: "x" }, codigo: "ZM-1" }])
        await rechaza(cat.instantanea({ empresaId: E1, items: [e] }), "DATOS_INVALIDOS");
    });

    it("las líneas libres se validan con el esquema de atributos", async () => {
      cat.registrarEsquema({ campos: { STOCK: "numero" } });
      await rechaza(cat.instantanea({ empresaId: E1, items: [{ libre: { nombre: "x", atributos: { STOCK: "siete" } } }] }), "DATOS_INVALIDOS");
    });

    it("lo copiado es independiente del catálogo (cambiarlo después no cambia el snapshot ya tomado)", async () => {
      const [a] = await cat.instantanea({ empresaId: E1, items: ["ZM-1"] });
      const i = await cat.obtener({ empresaId: E1, codigo: "ZM-1" });
      await cat.actualizar({ empresaId: E1, actor: EDITOR, itemId: i.id, precio: 99, atributos: { MARCA: "Otra" } });
      assert.equal(a.precio, 25.9);
      assert.equal(a.atributos.MARCA, "Bosch");
    });
  });

  describe("importar", () => {
    it("crea los ítems nuevos y actualiza los existentes por código", async () => {
      await nuevo({ codigo: "A-1", nombre: "Viejo", precio: 1, categoria: "X", atributos: { K: 1 } });
      const r = await cat.importar({
        empresaId: E1,
        actor: ADM,
        filas: [
          { codigo: "a-1", precio: 2.5, atributos: { J: 2 } },
          { codigo: "B-2", nombre: "Nuevo", categoria: "Y", precio: 4 },
          { codigo: "C-3", nombre: "Sin precio" },
        ],
      });
      assert.deepEqual(r, { creados: 2, actualizados: 1, inactivos: [], simulado: false, omitidos: [] });
      const a1 = await cat.obtener({ empresaId: E1, codigo: "A-1" });
      assert.equal(a1.nombre, "Viejo");
      assert.equal(a1.precio, 2.5);
      assert.equal(a1.categoria, "X");
      assert.deepEqual(a1.atributos, { K: 1, J: 2 });
      const b2 = await cat.obtener({ empresaId: E1, codigo: "B-2" });
      assert.deepEqual({ n: b2.nombre, c: b2.categoria, p: b2.precio, a: b2.activo }, { n: "Nuevo", c: "Y", p: 4, a: true });
      const c3 = await cat.obtener({ empresaId: E1, codigo: "C-3" });
      assert.deepEqual({ c: c3.categoria, p: c3.precio, a: c3.atributos }, { c: null, p: null, a: {} });
    });

    it("es idempotente: repetir la misma importación deja el mismo resultado", async () => {
      const filas = [{ codigo: "B-2", nombre: "Nuevo", precio: 4 }];
      await cat.importar({ empresaId: E1, actor: ADM, filas });
      const r = await cat.importar({ empresaId: E1, actor: ADM, filas });
      assert.deepEqual({ creados: r.creados, actualizados: r.actualizados }, { creados: 0, actualizados: 1 });
      assert.equal((await cat.listar({ empresaId: E1 })).length, 1);
    });

    it("simular cuenta sin escribir", async () => {
      const r = await cat.importar({ empresaId: E1, actor: ADM, simular: true, filas: [{ codigo: "A", nombre: "x" }, { codigo: "B", nombre: "y" }] });
      assert.deepEqual(r, { creados: 2, actualizados: 0, inactivos: [], simulado: true });
      assert.equal(falso.Item._docs.length, 0);
    });

    it("todo o nada: si una fila es inválida no se guarda ninguna y el error lista las filas", async () => {
      await assert.rejects(
        cat.importar({
          empresaId: E1,
          actor: ADM,
          filas: [
            { codigo: "OK-1", nombre: "Bien" },
            { codigo: "MAL 2", nombre: "Código con espacio" },
            { codigo: "OK-3", nombre: "Precio raro", precio: 1.234 },
            { codigo: "OK-4" },
            "no es objeto",
            { codigo: "ok-1", nombre: "Repetido" },
          ],
        }),
        (e) => {
          assert.equal(e.codigo, "IMPORTACION_INVALIDA");
          assert.equal(e.status, 400);
          assert.equal(e.detalle.total, 5);
          assert.deepEqual(e.detalle.errores.map((x) => x.fila), [2, 3, 4, 5, 6]);
          assert.ok(e.detalle.errores.every((x) => typeof x.error === "string" && x.error.length > 0));
          assert.match(e.detalle.errores[4].error, /fila 1/);
          return true;
        },
      );
      assert.equal(falso.Item._docs.length, 0);
    });

    it("una fila nueva sin nombre es inválida; una existente sin nombre no", async () => {
      await rechaza(cat.importar({ empresaId: E1, actor: ADM, filas: [{ codigo: "NUEVO" }] }), "IMPORTACION_INVALIDA");
      await nuevo({ codigo: "YA" });
      await assert.doesNotReject(cat.importar({ empresaId: E1, actor: ADM, filas: [{ codigo: "YA", precio: 3 }] }));
    });

    it("no reactiva los ítems desactivados: los actualiza y los lista", async () => {
      const i = await nuevo({ codigo: "BAJA", precio: 1 });
      await cat.desactivar({ empresaId: E1, actor: ADM, itemId: i.id });
      const r = await cat.importar({ empresaId: E1, actor: ADM, filas: [{ codigo: "BAJA", precio: 9 }] });
      assert.deepEqual(r.inactivos, ["BAJA"]);
      const despues = await cat.obtener({ empresaId: E1, itemId: i.id });
      assert.equal(despues.precio, 9);
      assert.equal(despues.activo, false);
    });

    it("los atributos de una fila nueva se limpian de nulos y se validan con el esquema", async () => {
      cat.registrarEsquema({ campos: { STOCK: "numero" } });
      await cat.importar({ empresaId: E1, actor: ADM, filas: [{ codigo: "N1", nombre: "x", atributos: { STOCK: 3, otro: null } }] });
      assert.deepEqual((await cat.obtener({ empresaId: E1, codigo: "N1" })).atributos, { STOCK: 3 });
      await rechaza(cat.importar({ empresaId: E1, actor: ADM, filas: [{ codigo: "N2", nombre: "x", atributos: { STOCK: "tres" } }] }), "IMPORTACION_INVALIDA");
    });

    it("exige catalogo:gestionar y de 1 a 500 filas", async () => {
      await rechaza(cat.importar({ empresaId: E1, actor: EDITOR, filas: [{ codigo: "A", nombre: "x" }] }), "PERMISO_INSUFICIENTE", 403);
      for (const filas of [undefined, [], "x", Array.from({ length: 501 }, (_, i) => ({ codigo: `C${i}`, nombre: "x" }))])
        await rechaza(cat.importar({ empresaId: E1, actor: ADM, filas }), "DATOS_INVALIDOS");
    });

    it("importa en la empresa indicada y no toca a las demás", async () => {
      await cat.importar({ empresaId: E2, actor: ADM, filas: [{ codigo: "SOLO-E2", nombre: "x" }] });
      assert.deepEqual(await cat.listar({ empresaId: E1 }), []);
      assert.equal((await cat.listar({ empresaId: E2 })).length, 1);
    });
  });

  describe("moneda", () => {
    it("PEN por defecto cuando la empresa no la tiene; si la tiene, la suya", async () => {
      assert.equal(await cat.moneda({ empresaId: E1 }), "PEN");
      await rechaza(cat.moneda({ empresaId: SIN_EMPRESA }), "NO_ENCONTRADO");
    });
  });

  describe("manejadores HTTP", () => {
    const res = () => ({
      statusCode: 200,
      body: undefined,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
    });
    const req = (o = {}) => ({ headers: {}, body: {}, params: {}, query: {}, auth: { empresaId: E1, usuarioId: ADM.usuarioId }, rol: { permisos: ["*"] }, ...o });
    const llama = async (m, r) => {
      const s = res();
      let err;
      await cat.manejadores[m](r, s, (e) => (err = e));
      return { s, err };
    };

    it("crear responde 201; duplicado 409 con el id; datos malos 400; sin permiso 403", async () => {
      let { s } = await llama("crear", req({ body: { codigo: "H-1", nombre: "Uno", precio: 3 } }));
      assert.equal(s.statusCode, 201);
      assert.equal(s.body.codigo, "H-1");
      const id = s.body.id;
      ({ s } = await llama("crear", req({ body: { codigo: "h-1", nombre: "Otro" } })));
      assert.equal(s.statusCode, 409);
      assert.equal(s.body.codigo, "ITEM_DUPLICADO");
      assert.equal(s.body.itemId, id);
      ({ s } = await llama("crear", req({ body: { codigo: "H-2", nombre: "Mal", precio: 1.234 } })));
      assert.equal(s.statusCode, 400);
      ({ s } = await llama("crear", req({ body: { codigo: "H-3", nombre: "Sin permiso" }, rol: { permisos: ["catalogo:leer"] } })));
      assert.equal(s.statusCode, 403);
      ({ s } = await llama("crear", req({ body: { codigo: "H-4", nombre: "Sin rol" }, rol: undefined })));
      assert.equal(s.statusCode, 403);
    });

    it("listar, categorías, obtener y por código", async () => {
      const { s: c } = await llama("crear", req({ body: { codigo: "H-1", nombre: "Uno", categoria: "A" } }));
      let { s } = await llama("listar", req({ query: { q: "uno" } }));
      assert.equal(s.statusCode, 200);
      assert.equal(s.body.items.length, 1);
      ({ s } = await llama("categorias", req()));
      assert.deepEqual(s.body.categorias, [{ categoria: "A", cantidad: 1 }]);
      ({ s } = await llama("obtener", req({ params: { itemId: c.body.id } })));
      assert.equal(s.body.codigo, "H-1");
      ({ s } = await llama("porCodigo", req({ params: { codigo: "h-1" } })));
      assert.equal(s.body.id, c.body.id);
      ({ s } = await llama("porCodigo", req({ params: { codigo: "no-hay" } })));
      assert.equal(s.statusCode, 404);
    });

    it("actualizar con un código distinto es 400; importar responde el resumen; un error inesperado va a next", async () => {
      const { s: c } = await llama("crear", req({ body: { codigo: "H-1", nombre: "Uno" } }));
      let { s } = await llama("actualizar", req({ params: { itemId: c.body.id }, body: { codigo: "H-9", nombre: "x" } }));
      assert.equal(s.statusCode, 400);
      ({ s } = await llama("importar", req({ body: { filas: [{ codigo: "I-1", nombre: "x" }], simular: true } })));
      assert.equal(s.statusCode, 200);
      assert.equal(s.body.simulado, true);
      ({ s } = await llama("importar", req({ body: { filas: [{ codigo: "mal codigo" }] } })));
      assert.equal(s.statusCode, 400);
      assert.equal(s.body.codigo, "IMPORTACION_INVALIDA");
      assert.equal(s.body.errores[0].fila, 1);
      const roto = crearServicioCatalogo({ Empresa: { findById: () => { throw new Error("boom"); } }, Item: falso.Item }, { exigirCsrf() {} });
      const salida = res();
      let err;
      await roto.manejadores.crear(req({ body: { codigo: "Z", nombre: "z" } }), salida, (e) => (err = e));
      assert.equal(err.message, "boom");
    });
  });
});
