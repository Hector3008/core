import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const LARGO = 64;

export async function hashPassword(plano) {
  const sal = randomBytes(16);
  const hash = await scryptAsync(plano, sal, LARGO);
  return `scrypt$${sal.toString("hex")}$${hash.toString("hex")}`;
}

export async function verificarPassword(plano, guardado) {
  const [algo, salHex, hashHex] = String(guardado).split("$");
  if (algo !== "scrypt" || !salHex || !hashHex) return false;
  const esperado = Buffer.from(hashHex, "hex");
  const obtenido = await scryptAsync(
    plano,
    Buffer.from(salHex, "hex"),
    esperado.length,
  );
  return timingSafeEqual(esperado, obtenido);
}
