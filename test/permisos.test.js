import test from "node:test";
import assert from "node:assert/strict";
import { permite } from "../src/permisos.js";

test("comodín total", () => assert.equal(permite(["*"], "catalogo:editar"), true));
test("comodín de recurso", () => {
  assert.equal(permite(["documento:*"], "documento:crear"), true);
  assert.equal(permite(["documento:*"], "catalogo:leer"), false);
});
test("permiso exacto", () => {
  assert.equal(permite(["documento:leer"], "documento:leer"), true);
  assert.equal(permite(["documento:leer"], "documento:crear"), false);
});
test("sin permisos", () => assert.equal(permite([], "documento:leer"), false));