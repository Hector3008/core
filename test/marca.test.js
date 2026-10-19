import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ErrorAuth } from "../src/auth/errores.js";
import { contraste, luminancia, marcaDe, marcaPublica, mezclar, normalizarColor, paletaDe, urlLogoSegura, validarMarca } from "../src/marca.js";

const malo = (fn, re) => assert.throws(fn, (e) => e instanceof ErrorAuth && e.codigo === "DATOS_INVALIDOS" && (!re || re.test(e.message)));

describe("colores", () => {
  it("normaliza a #rrggbb en minúsculas y rechaza lo que no es un hexadecimal", () => {
    assert.equal(normalizarColor("#ABC"), "#aabbcc");
    assert.equal(normalizarColor("  #1F5F4A "), "#1f5f4a");
    for (const v of ["1f5f4a", "#12", "#12345", "#gggggg", "rgb(1,2,3)", "red", "", null, 12, "#1f5f4a;"]) malo(() => normalizarColor(v, "colorPrincipal"), /colorPrincipal/);
  });
  it("luminancia y contraste siguen WCAG", () => {
    assert.equal(luminancia("#000000"), 0);
    assert.equal(luminancia("#ffffff"), 1);
    assert.equal(Math.round(contraste("#000000", "#ffffff")), 21);
    assert.equal(contraste("#777777", "#777777"), 1);
    assert.equal(contraste("#ffffff", "#000000"), contraste("#000000", "#ffffff"));
  });
  it("mezclar va del primero al segundo", () => {
    assert.equal(mezclar("#000000", "#ffffff", 0), "#000000");
    assert.equal(mezclar("#000000", "#ffffff", 1), "#ffffff");
    assert.equal(mezclar("#000000", "#ffffff", 0.5), "#808080");
  });
});

describe("logo", () => {
  it("solo https absoluto y sin credenciales", () => {
    assert.equal(urlLogoSegura("https://ejemplo.com/logo.png"), "https://ejemplo.com/logo.png");
    for (const v of ["http://ejemplo.com/a.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "/logo.png", "https://u:p@ejemplo.com/a.png", `https://e.com/${"a".repeat(500)}`, 5, null])
      assert.equal(urlLogoSegura(v), null);
  });
});

describe("paletaDe", () => {
  it("sin colores no hay paleta: la carta sigue la apariencia por defecto", () => {
    assert.equal(paletaDe(marcaDe(null)), null);
    assert.equal(paletaDe({ logo: "https://e.com/a.png", eslogan: "Hola" }), null);
  });
  it("con un color de marca el fondo es el claro por defecto y se derivan el resto de colores", () => {
    const p = paletaDe({ colorPrincipal: "#8b1e3f" });
    assert.equal(p.tema, "claro");
    assert.equal(p.colores["--color-principal"], "#8b1e3f");
    assert.equal(p.colores["--color-principal-texto"], "#ffffff");
    assert.equal(p.colores["--color-fondo"], "#f4f1ea");
    assert.equal(p.colores["--color-texto"], "#1d211f");
    assert.equal(p.colores["--color-secundario"], "#c8873a");
    assert.deepEqual(Object.keys(p.colores).sort(), [
      "--color-borde", "--color-error", "--color-error-fondo", "--color-fondo", "--color-principal", "--color-principal-texto",
      "--color-secundario", "--color-superficie", "--color-texto", "--color-texto-suave",
    ]);
    for (const v of Object.values(p.colores)) assert.match(v, /^#[0-9a-f]{6}$/);
  });
  it("un fondo oscuro da tema oscuro, texto claro y valores por defecto claros para los colores sin definir", () => {
    const p = paletaDe({ colorFondo: "#101418" });
    assert.equal(p.tema, "oscuro");
    assert.equal(p.colores["--color-texto"], "#eceee9");
    assert.equal(p.colores["--color-principal"], "#4fb08f");
    assert.ok(contraste(p.colores["--color-texto"], p.colores["--color-fondo"]) >= 7);
  });
  it("el texto del botón se elige por contraste con el color principal", () => {
    assert.equal(paletaDe({ colorPrincipal: "#f2c94c", colorFondo: "#101418" }).colores["--color-principal-texto"], "#111111");
    assert.equal(paletaDe({ colorPrincipal: "#1f3a8a" }).colores["--color-principal-texto"], "#ffffff");
  });
  it("rechaza un color que se confunde con el fondo, y dice cuál", () => {
    malo(() => paletaDe({ colorPrincipal: "#f0ede4" }), /colorPrincipal.*contraste/);
    malo(() => paletaDe({ colorSecundario: "#f5f2ea" }), /colorSecundario/);
    malo(() => paletaDe({ colorPrincipal: "#1a1a1a", colorFondo: "#101418" }), /colorPrincipal/);
  });
  it("rechaza un fondo de tono medio que no deja leer el texto", () => {
    malo(() => paletaDe({ colorFondo: "#808080" }), /colorFondo/);
  });
  it("con fondo oscuro el principal por defecto sirve y uno oscuro no", () => {
    assert.doesNotThrow(() => paletaDe({ colorFondo: "#0b0b0b", colorPrincipal: "#e6b800" }));
    malo(() => paletaDe({ colorFondo: "#0b0b0b", colorPrincipal: "#222222" }), /colorPrincipal/);
  });
});

describe("validarMarca", () => {
  it("valida un cambio parcial y devuelve la marca completa", () => {
    const m = validarMarca({ logo: " https://e.com/l.png ", eslogan: "  Café   de  origen ", colorPrincipal: "#8B1E3F" });
    assert.deepEqual(m, { logo: "https://e.com/l.png", eslogan: "Café de origen", colorPrincipal: "#8b1e3f", colorSecundario: null, colorFondo: null });
  });
  it("superpone sobre lo guardado y quita con null o vacío", () => {
    const actual = validarMarca({ logo: "https://e.com/l.png", colorPrincipal: "#8b1e3f" });
    const m = validarMarca({ eslogan: "Hola", colorPrincipal: null, logo: "" }, actual);
    assert.deepEqual(m, { logo: null, eslogan: "Hola", colorPrincipal: null, colorSecundario: null, colorFondo: null });
  });
  it("rechaza lo que no es un objeto, campos desconocidos, cuerpo vacío y datos mal formados", () => {
    for (const v of [null, "x", [], 5]) malo(() => validarMarca(v), /objeto/);
    malo(() => validarMarca({ tema: "oscuro" }), /no admitidos \(tema\)/);
    malo(() => validarMarca({}), /nada que cambiar/);
    malo(() => validarMarca({ logo: "http://e.com/a.png" }), /logo/);
    malo(() => validarMarca({ logo: 12 }), /logo/);
    malo(() => validarMarca({ eslogan: "a".repeat(81) }), /eslogan/);
    assert.equal(validarMarca({ eslogan: "uno\ndos" }).eslogan, "uno dos"); // los saltos de línea se vuelven espacios
    malo(() => validarMarca({ eslogan: "uno\u0007dos" }), /eslogan/);
    malo(() => validarMarca({ eslogan: 5 }), /eslogan/);
    malo(() => validarMarca({ colorFondo: "azul" }), /colorFondo/);
  });
  it("revisa la paleta del conjunto: cambiar solo el fondo puede dejar ilegible un principal ya guardado", () => {
    const actual = validarMarca({ colorPrincipal: "#1f3a8a" });
    malo(() => validarMarca({ colorFondo: "#101418" }, actual), /colorPrincipal/);
  });
  it("un eslogan o un logo solos no piden colores", () => {
    assert.equal(validarMarca({ eslogan: "Desde 1999" }).colorPrincipal, null);
  });
});

describe("marcaPublica", () => {
  it("null si la empresa no personalizó nada", () => {
    assert.equal(marcaPublica({}), null);
    assert.equal(marcaPublica({ marca: {} }), null);
    assert.equal(marcaPublica(null), null);
  });
  it("devuelve logo, eslogan, tema y colores ya calculados", () => {
    const m = marcaPublica({ marca: { logo: "https://e.com/l.png", eslogan: "Hola", colorPrincipal: "#8b1e3f" } });
    assert.equal(m.logo, "https://e.com/l.png");
    assert.equal(m.eslogan, "Hola");
    assert.equal(m.tema, "claro");
    assert.equal(m.colores["--color-principal"], "#8b1e3f");
  });
  it("sin colores: tema y colores en null (la carta sigue el modo del dispositivo)", () => {
    const m = marcaPublica({ marca: { eslogan: "Hola" } });
    assert.deepEqual(m, { logo: null, eslogan: "Hola", tema: null, colores: null });
  });
  it("una marca guardada que ya no sirve se ignora en vez de romper la carta", () => {
    const m = marcaPublica({ marca: { logo: "javascript:alert(1)", eslogan: "Hola", colorPrincipal: "#f0ede4" } });
    assert.deepEqual(m, { logo: null, eslogan: "Hola", tema: null, colores: null });
    assert.equal(marcaPublica({ marca: { logo: "javascript:alert(1)" } }), null);
  });
  it("un color guardado mal formado se ignora y uno en mayúsculas se normaliza", () => {
    assert.equal(marcaDe({ marca: { colorPrincipal: "#8B1E3F", colorFondo: "red", colorSecundario: "#abc" } }).colorPrincipal, "#8b1e3f");
    assert.equal(marcaDe({ marca: { colorFondo: "red", colorSecundario: "#abc" } }).colorFondo, null);
    assert.equal(marcaDe({ marca: { colorSecundario: "#abc" } }).colorSecundario, "#aabbcc");
    assert.equal(marcaPublica({ marca: { colorPrincipal: "no-es-un-color" } }), null);
  });
  it("los valores guardados que no son texto se tratan como vacíos", () => {
    assert.deepEqual(marcaDe({ marca: { logo: 5, colorPrincipal: {}, eslogan: "" } }), { logo: null, eslogan: null, colorPrincipal: null, colorSecundario: null, colorFondo: null });
  });
});
