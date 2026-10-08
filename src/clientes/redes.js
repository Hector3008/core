import { ErrorCliente } from "./errores.js";

/**
 * Redes sociales que admite la ficha del cliente (`redes: { instagram, tiktok, ... }`).
 * Para agregar una red nueva basta una entrada aquí: el esquema y la validación salen de esta tabla.
 *  - `hosts`: dominios de los que se acepta un enlace pegado (se extrae el usuario).
 *  - `formato`: cómo debe quedar el usuario ya limpio (sin @, en minúsculas).
 */
export const REDES = {
  instagram: { etiqueta: "Instagram", hosts: ["instagram.com", "instagr.am"], formato: /^[a-z0-9._]{1,30}$/ },
  tiktok: { etiqueta: "TikTok", hosts: ["tiktok.com"], formato: /^[a-z0-9._]{2,24}$/ },
  facebook: { etiqueta: "Facebook", hosts: ["facebook.com", "fb.com", "fb.me"], formato: /^[a-z0-9.]{5,50}$/ },
  x: { etiqueta: "X", hosts: ["x.com", "twitter.com"], formato: /^[a-z0-9_]{1,15}$/ },
};

export const REDES_SOPORTADAS = Object.keys(REDES);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "https://www.instagram.com/Ana.Perez/?hl=es", "@Ana.Perez" o "ana.perez" → "ana.perez" */
export function normalizarUsuarioRed(red, valor) {
  const def = REDES[red];
  if (!def || !Object.hasOwn(REDES, red)) throw new ErrorCliente("DATOS_INVALIDOS", `red no soportada: ${String(red).slice(0, 20)}`);
  if (typeof valor !== "string") throw new ErrorCliente("DATOS_INVALIDOS", `${def.etiqueta}: usuario inválido`);
  let u = valor.trim();
  const hosts = def.hosts.map(esc).join("|");
  const enlace = u.match(new RegExp(`^(?:https?:\\/\\/)?(?:www\\.|m\\.)?(?:${hosts})\\/(.+)$`, "i"));
  if (enlace) u = enlace[1].split(/[/?#]/)[0];
  u = u.replace(/^@/, "").toLowerCase();
  if (!def.formato.test(u))
    throw new ErrorCliente("DATOS_INVALIDOS", `${def.etiqueta}: usuario inválido (escribe solo el nombre de usuario, sin enlace)`);
  return u;
}

/**
 * Valida el bloque `redes` de una entrada. Devuelve `undefined` si no vino, o un objeto
 * `{ instagram: "ana" | null, ... }` donde `null` significa "quitar esa red".
 */
export function validarRedes(redes) {
  if (redes === undefined) return undefined;
  if (redes === null || typeof redes !== "object" || Array.isArray(redes))
    throw new ErrorCliente("DATOS_INVALIDOS", "redes debe ser un objeto, por ejemplo { instagram: \"ana\" }");
  const salida = {};
  for (const k of Object.keys(redes)) {
    if (!Object.hasOwn(REDES, k))
      throw new ErrorCliente("DATOS_INVALIDOS", `red no soportada: ${k.slice(0, 20)} (admitidas: ${REDES_SOPORTADAS.join(", ")})`);
    const v = redes[k];
    salida[k] = v === null || v === "" ? null : normalizarUsuarioRed(k, v);
  }
  return salida;
}
