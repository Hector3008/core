// Sin base de datos: tokens, cookies y limitador.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generarToken, hashToken } from "../src/auth/tokens.js";
import { leerCookie, serializarCookie } from "../src/auth/cookies.js";
import { crearLimitador } from "../src/auth/limitador.js";

describe("tokens", () => {
  it("son largos, distintos entre sí, y el hash es estable y distinto del token", () => {
    const a = generarToken();
    const b = generarToken();
    assert.notEqual(a, b);
    assert.ok(a.length >= 43);
    assert.equal(hashToken(a), hashToken(a));
    assert.notEqual(hashToken(a), a);
    assert.match(hashToken(a), /^[0-9a-f]{64}$/);
  });
});

describe("cookies", () => {
  it("lee una cookie entre varias y devuelve null si falta", () => {
    assert.equal(leerCookie("a=1; sid=xyz; b=2", "sid"), "xyz");
    assert.equal(leerCookie("a=1", "sid"), null);
    assert.equal(leerCookie(undefined, "sid"), null);
    assert.equal(leerCookie("sid=%E0%A4%A", "sid"), null);
  });
  it("serializa con HttpOnly y SameSite; Secure solo si se pide", () => {
    const c = serializarCookie("sid", "abc", { maxAgeSeg: 60 });
    assert.match(c, /^sid=abc; Path=\/; HttpOnly; SameSite=Lax; Max-Age=60$/);
    assert.ok(!c.includes("Secure"));
    assert.match(serializarCookie("sid", "abc", { secure: true }), /; Secure/);
  });
});

describe("limitador", () => {
  it("bloquea tras max fallos, libera al pasar la ventana y se reinicia con éxito", () => {
    let t = 0;
    const l = crearLimitador({ max: 3, ventanaMs: 60_000, ahora: () => t });
    for (let i = 0; i < 3; i++) {
      assert.equal(l.espera("k"), 0);
      l.fallo("k");
    }
    assert.equal(l.espera("k"), 60);
    t = 30_000;
    assert.equal(l.espera("k"), 30);
    t = 60_000;
    assert.equal(l.espera("k"), 0);
    l.fallo("k");
    l.fallo("k");
    l.exito("k");
    l.fallo("k");
    assert.equal(l.espera("k"), 0);
  });
  it("las claves son independientes", () => {
    const l = crearLimitador({ max: 1, ventanaMs: 1000 });
    l.fallo("a");
    assert.ok(l.espera("a") > 0);
    assert.equal(l.espera("b"), 0);
  });
});
