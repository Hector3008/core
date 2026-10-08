// No necesita base de datos.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizarTelefono, normalizarPais, PAIS_POR_DEFECTO } from "../src/telefono.js";

describe("teléfonos por país", () => {
  it("sin código de país usa el de la empresa (Perú por defecto)", () => {
    assert.equal(PAIS_POR_DEFECTO, "PE");
    assert.deepEqual(normalizarTelefono("987654321"), { telefono: "+51987654321", pais: "PE" });
    assert.deepEqual(normalizarTelefono("987 654 321", "PE"), { telefono: "+51987654321", pais: "PE" });
    assert.equal(normalizarTelefono("(01) 234-5678", "PE").telefono, "+5112345678"); // fijo de Lima
  });

  it("si la empresa es de Argentina, el mismo formato nacional toma +54", () => {
    assert.deepEqual(normalizarTelefono("11 2345-6789", "AR"), { telefono: "+541123456789", pais: "AR" });
  });

  it("con + (o 00) el país sale del número, sin importar el de la empresa", () => {
    assert.deepEqual(normalizarTelefono("+51 987 654 321", "AR"), { telefono: "+51987654321", pais: "PE" });
    assert.deepEqual(normalizarTelefono("00 51 987654321", "AR"), { telefono: "+51987654321", pais: "PE" });
    assert.deepEqual(normalizarTelefono("+54 9 11 2345-6789", "PE"), { telefono: "+5491123456789", pais: "AR" });
    assert.equal(normalizarTelefono("+1 202 555 0123", "PE").pais, "US");
  });

  it("rechaza números inválidos con un mensaje que sugiere el código de país", () => {
    assert.throws(() => normalizarTelefono("888888888", "PE"), /inválido para PE.*\+54/);
    assert.throws(() => normalizarTelefono("12345", "PE"), /inválido/);
    assert.throws(() => normalizarTelefono("abc", "PE"), /inválido/);
    assert.throws(() => normalizarTelefono(987654321, "PE"), /inválido/);
    assert.throws(() => normalizarTelefono("987654321", "ZZ"), /país inválido/);
  });

  it("normalizarPais: 2 letras, mayúsculas y existente", () => {
    assert.equal(normalizarPais(" ar "), "AR");
    assert.throws(() => normalizarPais("ARG"), /país inválido/);
    assert.throws(() => normalizarPais("ZZ"), /país inválido/);
    assert.throws(() => normalizarPais(null), /país inválido/);
  });
});
