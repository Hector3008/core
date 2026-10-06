// Lectura y escritura de cookies sin dependencias.

export function leerCookie(cabecera, nombre) {
  if (!cabecera || typeof cabecera !== "string") return null;
  for (const par of cabecera.split(";")) {
    const i = par.indexOf("=");
    if (i < 0) continue;
    if (par.slice(0, i).trim() !== nombre) continue;
    try {
      return decodeURIComponent(par.slice(i + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * HttpOnly: el JavaScript de la página no puede leerla (protege contra robo por XSS).
 * SameSite=Lax: el navegador no la manda en peticiones POST que vengan de otro sitio.
 * Secure: solo viaja por HTTPS (se activa en producción).
 */
export function serializarCookie(
  nombre,
  valor,
  { maxAgeSeg, secure = false, sameSite = "Lax", path = "/" } = {},
) {
  const partes = [`${nombre}=${encodeURIComponent(valor)}`, `Path=${path}`, "HttpOnly"];
  partes.push(`SameSite=${sameSite}`);
  if (secure) partes.push("Secure");
  if (maxAgeSeg !== undefined) partes.push(`Max-Age=${Math.floor(maxAgeSeg)}`);
  return partes.join("; ");
}
