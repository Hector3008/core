import { randomBytes, createHash } from "node:crypto";

// El token es un número aleatorio de 256 bits: imposible de adivinar. No lleva
// información dentro (a diferencia de un JWT): es solo una llave para buscar la sesión.
export const generarToken = () => randomBytes(32).toString("base64url");

// En la base de datos se guarda solo el hash del token. Si alguien copiara la colección
// `sesiones`, no podría usar esos hashes para entrar. SHA-256 basta porque el token ya es
// aleatorio y largo (no hace falta un hash lento como el de las contraseñas).
export const hashToken = (token) =>
  createHash("sha256").update(String(token)).digest("hex");
