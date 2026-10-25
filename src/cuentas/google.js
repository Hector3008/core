import crypto from "node:crypto";
import { ErrorAuth } from "../auth/errores.js";

// Verificación del «Iniciar sesión con Google» (arquitectura 5.51): el navegador entrega un ID token (un JWT firmado
// por Google) y aquí se comprueba, sin librerías externas:
//   · firma RS256 con las claves públicas de Google (JWKS, en caché),
//   · iss de Google, aud = nuestro Client ID (un token pensado para otra aplicación no vale), exp vigente,
//   · correo presente y verificado por Google.
// Devuelve solo lo que la cuenta necesita: { sub, correo, nombre }. `sub` es el identificador estable de la persona en
// Google (el correo puede cambiar, el sub no).

export const URL_CLAVES_GOOGLE = "https://www.googleapis.com/oauth2/v3/certs";
const EMISORES = new Set(["https://accounts.google.com", "accounts.google.com"]);
const MAX_TOKEN = 4096;
const TOLERANCIA_MS = 60_000; // desfase de relojes
const CACHE_CLAVES_MS = 60 * 60_000;

const invalido = (m = "no se pudo comprobar la cuenta de Google") => new ErrorAuth("GOOGLE_INVALIDO", m);
const base64url = (s) => Buffer.from(s, "base64url");
const json = (s) => {
  try {
    const v = JSON.parse(base64url(s).toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

export function crearVerificadorGoogle({ clientId, fetch: pedir = globalThis.fetch, ahora = Date.now, urlClaves = URL_CLAVES_GOOGLE } = {}) {
  if (typeof clientId !== "string" || !clientId.trim()) throw new Error("crearVerificadorGoogle: falta el clientId");
  const aud = clientId.trim();
  let claves = null; // { porKid: Map, hasta }

  async function cargarClaves() {
    let r;
    try {
      r = await pedir(urlClaves, { headers: { Accept: "application/json" } });
    } catch {
      throw new ErrorAuth("GOOGLE_NO_DISPONIBLE", "no se pudo contactar a Google, intenta de nuevo");
    }
    if (!r?.ok) throw new ErrorAuth("GOOGLE_NO_DISPONIBLE", "no se pudo contactar a Google, intenta de nuevo");
    const cuerpo = await r.json().catch(() => null);
    const lista = Array.isArray(cuerpo?.keys) ? cuerpo.keys : [];
    const porKid = new Map(lista.filter((k) => k?.kid && k.kty === "RSA").map((k) => [k.kid, k]));
    if (porKid.size === 0) throw new ErrorAuth("GOOGLE_NO_DISPONIBLE", "no se pudo contactar a Google, intenta de nuevo");
    claves = { porKid, hasta: ahora() + CACHE_CLAVES_MS };
    return claves;
  }

  async function claveDe(kid) {
    if (!claves || claves.hasta <= ahora()) await cargarClaves();
    let jwk = claves.porKid.get(kid);
    if (!jwk) {
      // Google rota sus claves: si el kid no está, se vuelve a pedir una vez (no más: un kid inventado no debe
      // provocar una petición a Google por cada intento).
      if (claves.refrescadaEn !== undefined && ahora() - claves.refrescadaEn < 60_000) return null;
      await cargarClaves();
      claves.refrescadaEn = ahora();
      jwk = claves.porKid.get(kid);
    }
    return jwk ?? null;
  }

  /** @returns {Promise<{ sub: string, correo: string, nombre: string|null }>} */
  async function verificar(credencial) {
    if (typeof credencial !== "string" || !credencial || credencial.length > MAX_TOKEN) throw invalido();
    const partes = credencial.split(".");
    if (partes.length !== 3) throw invalido();
    const cabecera = json(partes[0]);
    const datos = json(partes[1]);
    if (!cabecera || !datos || cabecera.alg !== "RS256" || typeof cabecera.kid !== "string") throw invalido();

    const jwk = await claveDe(cabecera.kid);
    if (!jwk) throw invalido();
    let firmaOk = false;
    try {
      firmaOk = crypto.verify("RSA-SHA256", Buffer.from(`${partes[0]}.${partes[1]}`), crypto.createPublicKey({ key: jwk, format: "jwk" }), base64url(partes[2]));
    } catch {
      firmaOk = false;
    }
    if (!firmaOk) throw invalido();

    const t = ahora();
    if (!EMISORES.has(datos.iss)) throw invalido();
    if (datos.aud !== aud) throw invalido("esta cuenta de Google no es para esta aplicación");
    if (!Number.isFinite(datos.exp) || datos.exp * 1000 + TOLERANCIA_MS <= t) throw invalido("la sesión de Google caducó, intenta de nuevo");
    if (Number.isFinite(datos.iat) && datos.iat * 1000 - TOLERANCIA_MS > t) throw invalido();
    if (typeof datos.sub !== "string" || !datos.sub || datos.sub.length > 255) throw invalido();
    const correo = typeof datos.email === "string" ? datos.email.trim().toLowerCase() : "";
    if (!correo || correo.length > 254 || !correo.includes("@")) throw invalido("tu cuenta de Google no tiene correo");
    if (datos.email_verified !== true && datos.email_verified !== "true") throw invalido("tu correo de Google no está verificado");
    const nombre = typeof datos.name === "string" && datos.name.trim() ? datos.name.trim().slice(0, 100) : null;
    return { sub: datos.sub, correo, nombre };
  }

  return { verificar, clientId: aud };
}
