// No necesita base de datos
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ErrorEvento } from "../src/index.js";
import {
  normalizarEventoInterfaz,
  resolverTs,
  validarDatos,
  validarSesionId,
  MAX_BYTES_DATOS,
} from "../src/eventos/validacion.js";

const recibidoTs = new Date("2026-10-04T12:00:00Z");
const ctx = { estacion: "revision", sesionId: "abcd1234", usuarioId: "u1", recibidoTs };
const norm = (e) => normalizarEventoInterfaz(e, ctx);
const invalido = (err) => err instanceof ErrorEvento && err.codigo === "EVENTO_INVALIDO";

describe("validación de eventos de la interfaz", () => {
  it("acepta un evento válido y fija estación, sesión y usuario desde el contexto", () => {
    const f = norm({
      tipo: "opcion_elegida",
      documentoCode: "DP-0000008",
      version: 2,
      datos: { linea: 2, vistas: 3, elegida: "ZM-9600025" },
    });
    assert.equal(f.origen, "interfaz");
    assert.equal(f.estacion, "revision");
    assert.equal(f.sesionId, "abcd1234");
    assert.equal(f.usuarioId, "u1");
    assert.equal(f.documentoCode, "DP-0000008");
    assert.deepEqual(f.datos, { linea: 2, vistas: 3, elegida: "ZM-9600025" });
  });

  it("el cliente no puede fijar estación, sesión ni usuario", () => {
    const f = norm({ tipo: "clic", estacion: "cocina", sesionId: "otra-sesion", usuarioId: "u9" });
    assert.equal(f.estacion, "revision");
    assert.equal(f.sesionId, "abcd1234");
    assert.equal(f.usuarioId, "u1");
  });

  it("rechaza tipos mal formados o reservados al servidor", () => {
    for (const tipo of ["", "Clic", "con espacio", "documento.estado", "sistema.x", 5, "a".repeat(65)])
      assert.throws(() => norm({ tipo }), invalido, String(tipo));
  });

  it("valida documentoCode y versión", () => {
    assert.throws(() => norm({ tipo: "clic", documentoCode: "DP 1" }), invalido);
    assert.throws(() => norm({ tipo: "clic", documentoCode: "DP-1", version: 0 }), invalido);
    assert.throws(() => norm({ tipo: "clic", version: 2 }), invalido);
  });

  it("limita tamaño y claves de datos", () => {
    assert.throws(() => validarDatos([1]), invalido);
    assert.throws(() => validarDatos({ x: "a".repeat(MAX_BYTES_DATOS) }), invalido);
    assert.throws(() => validarDatos({ $set: 1 }), invalido);
    assert.throws(() => validarDatos({ a: { "b.c": 1 } }), invalido);
    const ciclo = {};
    ciclo.yo = ciclo;
    assert.throws(() => validarDatos(ciclo), invalido);
    assert.deepEqual(validarDatos(undefined), {});
  });

  it("sesionId: opcional pero, si llega, bien formado", () => {
    assert.equal(validarSesionId(undefined), null);
    assert.equal(validarSesionId("550e8400-e29b-41d4-a716-446655440000"), "550e8400-e29b-41d4-a716-446655440000");
    assert.throws(() => validarSesionId("corto"), invalido);
    assert.throws(() => validarSesionId("con espacios aquí"), invalido);
  });

  it("ts del cliente: se respeta si es razonable; si no, vale la hora de recepción", () => {
    const hace1min = new Date(recibidoTs - 60_000);
    assert.equal(resolverTs(hace1min.toISOString(), recibidoTs).getTime(), hace1min.getTime());
    assert.equal(resolverTs(undefined, recibidoTs), recibidoTs);
    assert.equal(resolverTs("no es fecha", recibidoTs), recibidoTs);
    assert.equal(resolverTs(new Date(recibidoTs.getTime() + 60_000), recibidoTs), recibidoTs); // futuro
    assert.equal(resolverTs(new Date(recibidoTs - 48 * 3600_000), recibidoTs), recibidoTs); // muy viejo
  });
});
