// No necesita base de datos.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ErrorCatalogo } from "../src/catalogo/errores.js";
import {
  crearRegistroEsquemas,
  validarAtributos,
  fusionar,
  sinNulos,
  exigirTamano,
  MAX_BYTES_ATRIBUTOS,
} from "../src/catalogo/atributos.js";
import {
  validarCodigo,
  claveDe,
  validarNombre,
  validarCategoria,
  validarPrecio,
  validarLineaLibre,
  prepararDatos,
  idValido,
} from "../src/catalogo/validacion.js";
import { montarRutasCatalogo } from "../src/catalogo/rutas.js";
import { normalizarMoneda } from "../src/moneda.js";

const rechaza = (fn, codigo, status) =>
  assert.throws(fn, (e) => e instanceof ErrorCatalogo && e.codigo === codigo && (status === undefined || e.status === status));

describe("código, nombre y categoría", () => {
  it("el código se conserva como se escribió y se compara sin mayúsculas", () => {
    assert.equal(validarCodigo("  ZM-9600025 "), "ZM-9600025");
    assert.equal(validarCodigo("cafe.01/a_b"), "cafe.01/a_b");
    assert.equal(claveDe("ZM-9600025"), "zm-9600025");
  });

  it("rechaza códigos vacíos, con espacios o símbolos, o muy largos", () => {
    for (const c of ["", "   ", "ZM 1", "ZM#1", "ñandú", "A".repeat(41), null, undefined, 12])
      rechaza(() => validarCodigo(c), "DATOS_INVALIDOS", 400);
    assert.equal(validarCodigo("A".repeat(40)).length, 40);
  });

  it("el nombre es obligatorio y admite hasta 200 caracteres", () => {
    assert.equal(validarNombre("  Cappuccino doble "), "Cappuccino doble");
    for (const n of ["", "  ", null, undefined, 5, "x".repeat(201)]) rechaza(() => validarNombre(n), "DATOS_INVALIDOS");
    assert.equal(validarNombre("x".repeat(200)).length, 200);
  });

  it("la categoría es opcional: undefined no toca, null o vacío quita", () => {
    assert.equal(validarCategoria(undefined), undefined);
    assert.equal(validarCategoria(null), null);
    assert.equal(validarCategoria(""), null);
    assert.equal(validarCategoria(" Bebidas "), "Bebidas");
    rechaza(() => validarCategoria("   "), "DATOS_INVALIDOS");
    rechaza(() => validarCategoria(5), "DATOS_INVALIDOS");
    rechaza(() => validarCategoria("x".repeat(61)), "DATOS_INVALIDOS");
  });

  it("idValido exige 24 hexadecimales", () => {
    assert.equal(idValido("0123456789abcdef01234567"), "0123456789abcdef01234567");
    rechaza(() => idValido("abc"), "DATOS_INVALIDOS");
    rechaza(() => idValido(undefined, "itemId"), "DATOS_INVALIDOS");
  });
});

describe("precio", () => {
  it("opcional: undefined no toca y null deja sin precio", () => {
    assert.equal(validarPrecio(undefined), undefined);
    assert.equal(validarPrecio(null), null);
  });

  it("admite hasta 2 decimales, incluidos los que la coma flotante representa mal", () => {
    assert.equal(validarPrecio(0), 0);
    assert.equal(validarPrecio(12), 12);
    assert.equal(validarPrecio(12.5), 12.5);
    assert.equal(validarPrecio(19.99), 19.99);
    assert.equal(validarPrecio(0.07), 0.07);
    assert.equal(validarPrecio(1.15), 1.15);
    assert.equal(validarPrecio(1234567.89), 1234567.89);
  });

  it("rechaza más de 2 decimales en vez de redondear en silencio", () => {
    for (const p of [1.005, 0.001, 10.999, 3.14159]) rechaza(() => validarPrecio(p), "DATOS_INVALIDOS");
  });

  it("rechaza negativos, no numéricos, texto y valores enormes", () => {
    for (const p of [-1, -0.01, NaN, Infinity, "12.50", true, {}, [], 1e10]) rechaza(() => validarPrecio(p), "DATOS_INVALIDOS");
  });
});

describe("atributos y esquemas", () => {
  it("registrar es idempotente con el mismo tipo y falla con otro distinto", () => {
    const r = crearRegistroEsquemas();
    r.registrar({ campos: { MARCA: "texto", EQUIVALENTES: "lista" } });
    r.registrar({ campos: { MARCA: "texto", STOCK_MINIMO: "numero" } });
    assert.deepEqual(r.campos(), { MARCA: "texto", EQUIVALENTES: "lista", STOCK_MINIMO: "numero" });
    rechaza(() => r.registrar({ campos: { MARCA: "numero" } }), "ESQUEMA_INVALIDO", 400);
  });

  it("un registro inválido no deja nada a medias", () => {
    const r = crearRegistroEsquemas();
    r.registrar({ campos: { A: "texto" } });
    rechaza(() => r.registrar({ campos: { B: "texto", C: "fecha" } }), "ESQUEMA_INVALIDO");
    assert.deepEqual(r.campos(), { A: "texto" });
  });

  it("rechaza esquemas mal formados", () => {
    const r = crearRegistroEsquemas();
    for (const def of [undefined, null, {}, [], "x", { campos: {} }, { campos: { "1x": "texto" } }, { campos: { "a.b": "texto" } }, { campos: { A: "otro" } }])
      rechaza(() => r.registrar(def), "ESQUEMA_INVALIDO");
  });

  it("un campo declarado se valida por tipo; uno no declarado se acepta", () => {
    const r = crearRegistroEsquemas();
    r.registrar({ campos: { MARCA: "texto", STOCK: "numero", ACTIVO: "booleano", EQUIVALENTES: "lista" } });
    const ok = { MARCA: "Bosch", STOCK: 4, ACTIVO: true, EQUIVALENTES: [{ codigo: "ZM-1", stock: 2 }], LIBRE: { a: 1 } };
    assert.deepEqual(validarAtributos(ok, r), ok);
    rechaza(() => validarAtributos({ STOCK: "4" }, r), "DATOS_INVALIDOS");
    rechaza(() => validarAtributos({ MARCA: 5 }, r), "DATOS_INVALIDOS");
    rechaza(() => validarAtributos({ EQUIVALENTES: "ZM-1" }, r), "DATOS_INVALIDOS");
    rechaza(() => validarAtributos({ ACTIVO: "si" }, r), "DATOS_INVALIDOS");
  });

  it("undefined no toca, null los quita todos, y un null dentro quita esa clave sin comprobar el tipo", () => {
    const r = crearRegistroEsquemas();
    r.registrar({ campos: { STOCK: "numero" } });
    assert.equal(validarAtributos(undefined, r), undefined);
    assert.equal(validarAtributos(null, r), null);
    assert.deepEqual(validarAtributos({ STOCK: null }, r), { STOCK: null });
  });

  it("rechaza lo que no es un objeto simple, las claves peligrosas y los valores raros", () => {
    for (const a of ["x", 5, [], [1], new Date(), new Map()]) rechaza(() => validarAtributos(a), "DATOS_INVALIDOS");
    rechaza(() => validarAtributos({ $set: 1 }), "DATOS_INVALIDOS");
    rechaza(() => validarAtributos({ "a.b": 1 }), "DATOS_INVALIDOS");
    rechaza(() => validarAtributos({ a: { $gt: 1 } }), "DATOS_INVALIDOS");
    rechaza(() => validarAtributos(JSON.parse('{"__proto__": {"x": 1}}')), "DATOS_INVALIDOS");
    rechaza(() => validarAtributos({ a: NaN }), "DATOS_INVALIDOS");
    rechaza(() => validarAtributos({ a: () => 1 }), "DATOS_INVALIDOS");
    rechaza(() => validarAtributos({ a: undefined }), "DATOS_INVALIDOS");
    rechaza(() => validarAtributos({ a: "x".repeat(501) }), "DATOS_INVALIDOS");
    rechaza(() => validarAtributos({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }), "DATOS_INVALIDOS");
  });

  it("el tamaño total se comprueba sobre el resultado final (4 KB)", () => {
    assert.doesNotThrow(() => exigirTamano({ a: "x".repeat(400) }));
    const grande = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "x".repeat(300)]));
    assert.ok(Buffer.byteLength(JSON.stringify(grande)) > MAX_BYTES_ATRIBUTOS);
    rechaza(() => exigirTamano(grande), "DATOS_INVALIDOS");
  });

  it("fusionar combina clave por clave y null quita; sinNulos limpia los nulos", () => {
    assert.deepEqual(fusionar({ a: 1, b: 2 }, { b: null, c: 3 }), { a: 1, c: 3 });
    assert.deepEqual(fusionar(undefined, { a: 1 }), { a: 1 });
    assert.deepEqual(sinNulos({ a: 1, b: null }), { a: 1 });
    assert.deepEqual(sinNulos(undefined), {});
  });
});

describe("prepararDatos", () => {
  it("crear exige código y nombre; categoría, precio y atributos son opcionales", () => {
    const d = prepararDatos({ codigo: "A1", nombre: "Café" }, { crear: true });
    assert.deepEqual(d, { codigo: "A1", nombre: "Café", categoria: undefined, precio: undefined, atributos: undefined });
    rechaza(() => prepararDatos({ nombre: "Café" }, { crear: true }), "DATOS_INVALIDOS");
    rechaza(() => prepararDatos({ codigo: "A1" }, { crear: true }), "DATOS_INVALIDOS");
  });

  it("crear quita las claves nulas de los atributos", () => {
    const d = prepararDatos({ codigo: "A1", nombre: "Café", atributos: { a: 1, b: null } }, { crear: true });
    assert.deepEqual(d.atributos, { a: 1 });
  });

  it("actualizar solo valida lo que llega", () => {
    const d = prepararDatos({ precio: 5.5, categoria: null }, { crear: false });
    assert.equal(d.precio, 5.5);
    assert.equal(d.categoria, null);
    assert.equal(d.nombre, undefined);
    assert.equal(d.codigo, undefined);
    assert.equal(d.atributos, undefined);
  });

  it("valida con el registro de esquemas", () => {
    const r = crearRegistroEsquemas();
    r.registrar({ campos: { STOCK: "numero" } });
    rechaza(() => prepararDatos({ codigo: "A1", nombre: "x", atributos: { STOCK: "mucho" } }, { crear: true, registro: r }), "DATOS_INVALIDOS");
  });
});

describe("línea libre", () => {
  it("solo el nombre es obligatorio; lo demás queda en null o vacío", () => {
    assert.deepEqual(validarLineaLibre({ nombre: " Filtro de aceite " }), {
      codigo: null,
      nombre: "Filtro de aceite",
      precio: null,
      categoria: null,
      atributos: {},
    });
  });

  it("acepta código, precio, categoría y atributos", () => {
    const l = validarLineaLibre({ codigo: "NUEVO-1", nombre: "Bujía", precio: 12.9, categoria: "Motor", atributos: { MARCA: "NGK", x: null } });
    assert.deepEqual(l, { codigo: "NUEVO-1", nombre: "Bujía", precio: 12.9, categoria: "Motor", atributos: { MARCA: "NGK" } });
  });

  it("un código vacío cuenta como sin código", () => {
    assert.equal(validarLineaLibre({ codigo: "", nombre: "x" }).codigo, null);
    assert.equal(validarLineaLibre({ codigo: null, nombre: "x" }).codigo, null);
  });

  it("rechaza campos que no son de un ítem (para cazar errores de escritura)", () => {
    rechaza(() => validarLineaLibre({ nombre: "x", cantidad: 2 }), "DATOS_INVALIDOS");
    rechaza(() => validarLineaLibre({ nombre: "x", activo: false }), "DATOS_INVALIDOS");
    rechaza(() => validarLineaLibre({ nombre: "x", empresaId: "1" }), "DATOS_INVALIDOS");
  });

  it("rechaza lo que no es un objeto, sin nombre, o con precio o atributos inválidos", () => {
    for (const l of [undefined, null, "x", [], 5]) rechaza(() => validarLineaLibre(l), "DATOS_INVALIDOS");
    rechaza(() => validarLineaLibre({}), "DATOS_INVALIDOS");
    rechaza(() => validarLineaLibre({ nombre: "x", precio: 1.234 }), "DATOS_INVALIDOS");
    rechaza(() => validarLineaLibre({ nombre: "x", codigo: "con espacio" }), "DATOS_INVALIDOS");
    rechaza(() => validarLineaLibre({ nombre: "x", atributos: { $a: 1 } }), "DATOS_INVALIDOS");
  });

  it("valida los atributos por tipo con el registro, sin exigir ninguno", () => {
    const r = crearRegistroEsquemas();
    r.registrar({ campos: { STOCK: "numero" } });
    assert.doesNotThrow(() => validarLineaLibre({ nombre: "x" }, r));
    rechaza(() => validarLineaLibre({ nombre: "x", atributos: { STOCK: "7" } }, r), "DATOS_INVALIDOS");
  });
});

describe("moneda", () => {
  it("normaliza a mayúsculas y solo admite códigos ISO conocidos", () => {
    assert.equal(normalizarMoneda("pen"), "PEN");
    assert.equal(normalizarMoneda(" usd "), "USD");
    assert.equal(normalizarMoneda("ARS"), "ARS");
    for (const m of ["", "ZZZ", "PE", "SOLES", null, undefined, 5]) assert.throws(() => normalizarMoneda(m), /moneda inválida/);
  });
});

describe("rutas del catálogo", () => {
  it("cada ruta lleva autenticar + requierePermiso + handler, con el permiso que toca", () => {
    const rutas = [];
    const reg = (metodo) => (path, ...fns) => rutas.push({ metodo, path, n: fns.length });
    const router = { get: reg("get"), post: reg("post"), put: reg("put"), delete: reg("delete") };
    const pedidos = [];
    const h = new Proxy({}, { get: () => () => {} });
    montarRutasCatalogo(router, {
      catalogo: { manejadores: h },
      autenticar: () => () => {},
      requierePermiso: (p) => (pedidos.push(p), () => {}),
    });
    assert.equal(rutas.length, 9);
    assert.ok(rutas.every((r) => r.n === 3));
    assert.deepEqual([...new Set(pedidos)].sort(), ["catalogo:crear", "catalogo:editar", "catalogo:gestionar", "catalogo:leer"]);
  });

  it("las rutas fijas van antes que /:itemId para que no las capture", () => {
    const orden = [];
    const reg = (metodo) => (path) => orden.push(`${metodo} ${path}`);
    const router = { get: reg("get"), post: reg("post"), put: reg("put"), delete: reg("delete") };
    const h = new Proxy({}, { get: () => () => {} });
    montarRutasCatalogo(router, { catalogo: { manejadores: h }, autenticar: () => () => {}, requierePermiso: () => () => {} });
    const idx = (s) => orden.indexOf(s);
    assert.ok(idx("get /categorias") < idx("get /:itemId"));
    assert.ok(idx("get /codigo/:codigo") < idx("get /:itemId"));
    assert.ok(orden.includes("post /importar"));
  });
});
