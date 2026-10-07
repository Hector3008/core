// Sin base de datos: reglas de las opciones del PIN por empresa.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PIN_POR_DEFECTO, configPinDe, validarConfigPin } from "../src/auth/pin-config.js";

describe("opciones del PIN por empresa", () => {
  it("sin nada guardado rige lo por defecto (PIN apagado, 4 a 6 dígitos)", () => {
    const c = configPinDe({});
    assert.deepEqual(c, PIN_POR_DEFECTO);
    assert.equal(c.habilitado, false);
    assert.equal(c.largoMin, 4);
    assert.equal(c.largoMax, 6);
  });
  it("lo guardado pisa lo por defecto y los null se ignoran", () => {
    const c = configPinDe({ seguridad: { pin: { habilitado: true, maxIntentos: 3, bloqueoMin: null } } });
    assert.equal(c.habilitado, true);
    assert.equal(c.maxIntentos, 3);
    assert.equal(c.bloqueoMin, PIN_POR_DEFECTO.bloqueoMin);
  });
  it("acepta cambios válidos y devuelve solo los pedidos", () => {
    assert.deepEqual(validarConfigPin({ largoMin: 5, bloqueoMin: 30 }), { largoMin: 5, bloqueoMin: 30 });
  });
  it("rechaza fuera de rango, opciones desconocidas, tipos raros y largoMin > largoMax", () => {
    for (const malo of [
      { largoMin: 3 }, { largoMax: 7 }, { maxIntentos: 2 }, { maxIntentos: 11 }, { bloqueoMin: 0 },
      { inactividadMin: 121 }, { sesionMaxHoras: 25 }, { codigoVigenciaMin: 61 },
      { maxIntentos: "5" }, { maxIntentos: 4.5 }, { habilitado: "si" }, { inventada: 1 },
      { largoMin: 6, largoMax: 4 }, null, [], "x",
    ])
      assert.throws(() => validarConfigPin(malo), (e) => e.codigo === "DATOS_INVALIDOS" && e.status === 400);
    // largoMin se valida contra el largoMax ya guardado
    assert.throws(() => validarConfigPin({ largoMin: 6 }, { ...PIN_POR_DEFECTO, largoMax: 5 }));
  });
});
