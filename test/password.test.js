import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verificarPassword } from "../src/password.js";

test("verifica la contraseña correcta y rechaza la incorrecta", async () => {
  const h = await hashPassword("secreto123");
  assert.equal(await verificarPassword("secreto123", h), true);
  assert.equal(await verificarPassword("otra", h), false);
});
test("dos hashes de la misma clave son distintos (sal)", async () => {
  assert.notEqual(await hashPassword("x"), await hashPassword("x"));
});
test("formato inválido devuelve false", async () => {
  assert.equal(await verificarPassword("x", "basura"), false);
});
