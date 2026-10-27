import { ErrorResena } from "./errores.js";

// Lógica pura de las reseñas (5.62): solo estrellas y texto (sin imágenes ni video, decisión de producto desde 5.25).
export const MAX_TEXTO = 500;
const malo = (m) => new ErrorResena("DATOS_INVALIDOS", m);

/** Mismo criterio del catálogo: los códigos no distinguen mayúsculas. */
export const claveDe = (codigo) => String(codigo ?? "").trim().toLowerCase();

/** `{ estrellas, texto? }` → `{ estrellas, texto|null }`. Estrellas: entero de 1 a 5. El texto es opcional (hasta 500). */
export function validarResena(datos) {
  if (!datos || typeof datos !== "object" || Array.isArray(datos)) throw malo("la reseña debe ser un objeto");
  const extra = Object.keys(datos).filter((k) => !["estrellas", "texto"].includes(k));
  if (extra.length) throw malo(`campos no admitidos (${extra.join(", ")})`);
  if (!Number.isInteger(datos.estrellas) || datos.estrellas < 1 || datos.estrellas > 5)
    throw malo("estrellas: un número entero de 1 a 5");
  let texto = null;
  if (datos.texto !== undefined && datos.texto !== null) {
    if (typeof datos.texto !== "string") throw malo("texto: debe ser texto");
    // eslint-disable-next-line no-control-regex
    const limpio = datos.texto.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
    if (limpio.length > MAX_TEXTO) throw malo(`texto: hasta ${MAX_TEXTO} caracteres`);
    texto = limpio || null;
  }
  return { estrellas: datos.estrellas, texto };
}

/**
 * Cómo se muestra el autor: primer nombre + inicial del último apellido («María del Carmen Pérez» → «María P.»).
 * Una ficha anonimizada o sin nombre sale como «Anónimo».
 */
export function nombrePublico(nombre) {
  const partes = String(nombre ?? "").trim().split(/\s+/).filter(Boolean);
  if (!partes.length || /^cliente anonimizado$/i.test(partes.join(" "))) return "Anónimo";
  if (partes.length === 1) return partes[0];
  const inicial = [...partes.at(-1)][0].toLocaleUpperCase("es");
  return `${partes[0]} ${inicial}.`;
}

/** Promedio con un decimal, o null si no hay reseñas. */
export const promedioDe = (suma, total) => (total > 0 ? Math.round((suma / total) * 10) / 10 : null);
