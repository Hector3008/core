import { ErrorAuth } from "./auth/errores.js";

// Marca de la empresa (arquitectura 5.33): logo, eslogan y colores que se ven en la carta pública.
// Lógica pura, sin base de datos. El servidor es quien decide qué combinaciones de color se aceptan y
// quien deriva el resto de la paleta, para que ninguna empresa deje su carta ilegible y para que
// el front solo tenga que pintar lo que recibe.

export const MAX_ESLOGAN = 80;
export const MAX_LOGO = 500;
export const CAMPOS_MARCA = ["logo", "eslogan", "colorPrincipal", "colorSecundario", "colorFondo"];
const COLORES = ["colorPrincipal", "colorSecundario", "colorFondo"];

// Valores por defecto de la carta (los mismos de client/src/estilos.css de tobt).
export const FONDO_CLARO = "#f4f1ea";
const PRINCIPAL = { claro: "#1f5f4a", oscuro: "#4fb08f" };
const SECUNDARIO = { claro: "#c8873a", oscuro: "#e0a258" };
const CONTRASTE_MIN = { colorPrincipal: 3, colorSecundario: 2.5 }; // sobre el fondo: el principal pinta puntos, barras y botones; el secundario es un acento (estrellas)
const CONTRASTE_MIN_TEXTO = 7; // el texto sobre el fondo

const malo = (m) => new ErrorAuth("DATOS_INVALIDOS", m);

// ---------- colores ----------
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** "#ABC" o "#aabbcc" → "#aabbcc". Lanza ErrorAuth si no es un color hexadecimal. */
export function normalizarColor(valor, nombre = "color") {
  const t = typeof valor === "string" ? valor.trim() : "";
  if (!HEX.test(t)) throw malo(`${nombre}: un color en hexadecimal, como #1f5f4a`);
  const h = t.slice(1).toLowerCase();
  return `#${h.length === 3 ? [...h].map((c) => c + c).join("") : h}`;
}

const canales = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const aHex = (rgb) => `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;

/** Luminancia relativa (WCAG): 0 negro, 1 blanco. */
export function luminancia(hex) {
  const [r, g, b] = canales(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Razón de contraste (WCAG) entre dos colores: de 1 a 21. */
export function contraste(a, b) {
  const [claro, oscuro] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return (claro + 0.05) / (oscuro + 0.05);
}

/** Mezcla `a` con `b`: t = 0 es `a`, t = 1 es `b`. */
export function mezclar(a, b, t) {
  const [ca, cb] = [canales(a), canales(b)];
  return aHex(ca.map((v, i) => v * (1 - t) + cb[i] * t));
}

// ---------- logo y eslogan ----------
/** Solo URLs https absolutas y sin credenciales (como la foto de un plato): lo demás se descarta. */
export function urlLogoSegura(valor) {
  if (typeof valor !== "string" || valor.length > MAX_LOGO) return null;
  try {
    const u = new URL(valor.trim());
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

function normalizarLogo(v) {
  if (typeof v !== "string") throw malo("logo: la dirección completa de la imagen, que empiece con https://");
  const url = urlLogoSegura(v);
  if (!url) throw malo(`logo: una dirección https:// válida, sin usuario ni contraseña y de hasta ${MAX_LOGO} caracteres`);
  return url;
}

function normalizarEslogan(v) {
  if (typeof v !== "string") throw malo("eslogan: un texto");
  const t = v.trim().replace(/\s+/g, " ");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(t) || t.length > MAX_ESLOGAN) throw malo(`eslogan: hasta ${MAX_ESLOGAN} caracteres y sin caracteres de control`);
  return t;
}

// ---------- paleta ----------
const hayColores = (m) => COLORES.some((c) => m?.[c]);

/**
 * La paleta completa de la carta a partir de los tres colores de la marca (o `null` si no hay ninguno: la carta
 * sigue la apariencia por defecto y el modo claro/oscuro del dispositivo). Con colores propios la carta no cambia
 * con el modo del dispositivo: el fondo lo decide la empresa (por defecto, claro).
 * Devuelve { tema, colores: { "--color-…": "#rrggbb" } }. Lanza ErrorAuth si algo queda ilegible.
 */
export function paletaDe(marca) {
  if (!hayColores(marca)) return null;
  const fondo = marca.colorFondo ?? FONDO_CLARO;
  const oscuro = contraste(fondo, "#ffffff") > contraste(fondo, "#000000");
  const tema = oscuro ? "oscuro" : "claro";
  const texto = oscuro ? "#eceee9" : "#1d211f";
  if (contraste(fondo, texto) < CONTRASTE_MIN_TEXTO)
    throw malo("colorFondo: ese fondo no deja leer el texto; elige uno más claro o más oscuro");
  const superficie = oscuro ? mezclar(fondo, "#ffffff", 0.06) : mezclar(fondo, "#ffffff", 0.7);
  const borde = oscuro ? mezclar(fondo, "#ffffff", 0.14) : mezclar(fondo, "#000000", 0.12);
  const principal = marca.colorPrincipal ?? PRINCIPAL[tema];
  const secundario = marca.colorSecundario ?? SECUNDARIO[tema];
  // Solo se exigen los colores que puso la empresa: los de por defecto ya sirven con el fondo que les toca.
  for (const [nombre, color] of [["colorPrincipal", principal], ["colorSecundario", secundario]]) {
    if (!marca[nombre]) continue;
    const c = Math.min(contraste(color, fondo), contraste(color, superficie));
    if (c < CONTRASTE_MIN[nombre])
      throw malo(`${nombre}: se confunde con el fondo (contraste ${c.toFixed(1)}, hace falta al menos ${CONTRASTE_MIN[nombre]}); elige un tono más ${oscuro ? "claro" : "oscuro"} o cambia el fondo`);
  }
  return {
    tema,
    colores: {
      "--color-principal": principal,
      "--color-principal-texto": contraste(principal, "#ffffff") >= contraste(principal, "#111111") ? "#ffffff" : "#111111",
      "--color-secundario": secundario,
      "--color-fondo": fondo,
      "--color-superficie": superficie,
      "--color-texto": texto,
      "--color-texto-suave": mezclar(texto, fondo, 0.35),
      "--color-borde": borde,
      "--color-error": oscuro ? "#f2b8b5" : "#b3261e",
      "--color-error-fondo": oscuro ? "#3a1f1d" : "#fbe9e7",
    },
  };
}

// ---------- validación ----------
/** La marca guardada, con todos los campos (los vacíos en null). */
export function marcaDe(empresa) {
  const m = empresa?.marca ?? {};
  return Object.fromEntries(
    CAMPOS_MARCA.map((c) => {
      if (typeof m[c] !== "string" || !m[c]) return [c, null];
      if (!COLORES.includes(c)) return [c, m[c]];
      // un color guardado a mano en la base y mal formado se ignora: nunca llega a la paleta
      try {
        return [c, normalizarColor(m[c], c)];
      } catch {
        return [c, null];
      }
    }),
  );
}

/**
 * Valida los cambios pedidos (parciales) sobre la marca `actual`. Un campo en `null` o vacío se quita.
 * Devuelve la marca completa resultante; lanza ErrorAuth si un dato es inválido o la paleta queda ilegible.
 */
export function validarMarca(entrada, actual = marcaDe(null)) {
  if (!entrada || typeof entrada !== "object" || Array.isArray(entrada)) throw malo("se esperaba un objeto con los cambios de la marca");
  const extra = Object.keys(entrada).filter((k) => !CAMPOS_MARCA.includes(k));
  if (extra.length) throw malo(`campos no admitidos (${extra.join(", ")})`);
  if (!Object.keys(entrada).length) throw malo("no hay nada que cambiar");
  const nueva = { ...marcaDe({ marca: actual }) };
  for (const [k, v] of Object.entries(entrada)) {
    if (v === null || (typeof v === "string" && !v.trim())) {
      nueva[k] = null;
      continue;
    }
    if (k === "logo") nueva.logo = normalizarLogo(v);
    else if (k === "eslogan") nueva.eslogan = normalizarEslogan(v);
    else nueva[k] = normalizarColor(v, k);
  }
  paletaDe(nueva); // comprueba que los colores juntos se lean
  return nueva;
}

/**
 * Lo que ve el público: logo (si la dirección es segura), eslogan y paleta ya calculada.
 * `null` si la empresa no personalizó nada. Nunca lanza: una marca guardada que ya no sirve se ignora.
 */
export function marcaPublica(empresa) {
  const m = marcaDe(empresa);
  let paleta = null;
  try {
    paleta = paletaDe(m);
  } catch {
    paleta = null;
  }
  const logo = m.logo ? urlLogoSegura(m.logo) : null;
  if (!logo && !m.eslogan && !paleta) return null;
  return { logo, eslogan: m.eslogan, tema: paleta?.tema ?? null, colores: paleta?.colores ?? null };
}
