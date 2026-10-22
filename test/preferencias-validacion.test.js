// Sin base de datos: formato del id de la página principal.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ErrorAuth } from "../src/index.js";
import { validarPaginaPrincipal } from "../src/auth/preferencias.js";

describe("validarPaginaPrincipal", () => {
  it("acepta ids de destino con hasta 3 segmentos", () => {
    for (const ok of ["perfil", "tobt.pedidos", "tobt.cocina_hoy", "a.b.c", "siscore2.bandeja"])
      assert.equal(validarPaginaPrincipal(ok), ok);
  });

  it("null y cadena vacía la quitan", () => {
    assert.equal(validarPaginaPrincipal(null), null);
    assert.equal(validarPaginaPrincipal(""), null);
  });

  it("rechaza URLs, rutas, mayúsculas, espacios, tipos raros y largos excesivos", () => {
    const malos = [
      "https://malo.com", "//malo.com", "/tobt/pedidos", "../x", "javascript:alert(1)",
      "Tobt.pedidos", "tobt pedidos", "tobt..pedidos", ".pedidos", "pedidos.",
      "1pedidos", "a.b.c.d", "a".repeat(31), `${"a".repeat(30)}.${"b".repeat(30)}.${"c".repeat(30)}`,
      undefined, 5, true, {}, { $ne: null }, ["a"],
    ];
    for (const malo of malos)
      assert.throws(() => validarPaginaPrincipal(malo), (e) => e instanceof ErrorAuth && e.codigo === "DATOS_INVALIDOS" && e.status === 400, String(malo));
  });
});
