// Lógica pura del kardex (5.75): validación, presentaciones y costo promedio. Sin base de datos.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aUnidadBase, aplicarMovimiento, validarInsumo, validarCantidad, redondear } from "../src/kardex/calculo.js";
import { ErrorKardex } from "../src/kardex/errores.js";

const malo = (fn) => assert.throws(fn, (e) => e instanceof ErrorKardex && e.codigo === "DATOS_INVALIDOS");
const cafe = { codigo: "CAFE", unidad: "g", presentaciones: [{ nombre: "paquete", factor: 500 }] };

describe("validarInsumo", () => {
  it("alta válida con valores por omisión", () => {
    const r = validarInsumo({ codigo: " CAFE ", nombre: "Café  molido", unidad: "g", presentaciones: [{ nombre: "paquete", factor: 500 }] });
    assert.deepEqual(r, { codigo: "CAFE", unidad: "g", nombre: "Café molido", stockMinimo: 0, presentaciones: [{ nombre: "paquete", factor: 500 }], activo: true });
  });
  it("rechaza datos malos", () => {
    malo(() => validarInsumo({ codigo: "a b", nombre: "x", unidad: "g" }));
    malo(() => validarInsumo({ codigo: "A", nombre: "", unidad: "g" }));
    malo(() => validarInsumo({ codigo: "A", nombre: "x", unidad: "" }));
    malo(() => validarInsumo({ codigo: "A", nombre: "x", unidad: "g", extra: 1 }));
    malo(() => validarInsumo({ codigo: "A", nombre: "x", unidad: "g", stockMinimo: -1 }));
    malo(() => validarInsumo({ codigo: "A", nombre: "x", unidad: "g", presentaciones: [{ nombre: "g", factor: 2 }] }));
    malo(() => validarInsumo({ codigo: "A", nombre: "x", unidad: "g", presentaciones: [{ nombre: "caja", factor: 0 }] }));
    malo(() => validarInsumo({ codigo: "A", nombre: "x", unidad: "g", presentaciones: [{ nombre: "caja", factor: 1 }, { nombre: "CAJA", factor: 2 }] }));
  });
  it("al editar, código y unidad no cambian", () => {
    malo(() => validarInsumo({ unidad: "kg" }, cafe));
    malo(() => validarInsumo({ codigo: "OTRO" }, cafe));
    assert.deepEqual(validarInsumo({ codigo: "cafe", nombre: "Café" }, cafe), { nombre: "Café" });
  });
});

describe("presentaciones", () => {
  it("convierte cantidad y costo a unidad base", () => {
    const r = aUnidadBase(cafe, { cantidad: 3, presentacion: "Paquete", costo: 40 }, { exigirCosto: true });
    assert.equal(r.base, 1500);
    assert.equal(r.costoUnitario, 0.08);
    assert.deepEqual(r.presentacion, { nombre: "paquete", cantidad: 3, factor: 500 });
  });
  it("costoTotal reparte por unidad base; sin presentación va directo", () => {
    assert.equal(aUnidadBase(cafe, { cantidad: 1000, costoTotal: 80 }, { exigirCosto: true }).costoUnitario, 0.08);
    assert.equal(aUnidadBase(cafe, { cantidad: 10, presentacion: "g" }).presentacion, null);
  });
  it("errores", () => {
    malo(() => aUnidadBase(cafe, { cantidad: 1, presentacion: "saco" }));
    malo(() => aUnidadBase(cafe, { cantidad: 1 }, { exigirCosto: true }));
    malo(() => aUnidadBase(cafe, { cantidad: 1, costo: 1, costoTotal: 1 }));
    malo(() => aUnidadBase(cafe, { cantidad: 0 }));
    malo(() => validarCantidad(1.2345));
    assert.equal(aUnidadBase(cafe, { cantidad: 0 }, { permitirCero: true }).base, 0);
  });
});

describe("costo promedio", () => {
  it("entradas ponderan, salidas no cambian el promedio", () => {
    let e = aplicarMovimiento({ existencia: 0, costoPromedio: 0 }, { signo: 1, cantidad: 1000, costoUnitario: 0.08 });
    assert.deepEqual([e.existencia, e.costoPromedio], [1000, 0.08]);
    e = aplicarMovimiento(e, { signo: 1, cantidad: 1000, costoUnitario: 0.12 });
    assert.deepEqual([e.existencia, e.costoPromedio], [2000, 0.1]);
    e = aplicarMovimiento(e, { signo: -1, cantidad: 500 });
    assert.deepEqual([e.existencia, e.costoPromedio, e.costoUnitario, e.negativo], [1500, 0.1, 0.1, false]);
  });
  it("saldo negativo se marca; la próxima compra fija el promedio", () => {
    let e = aplicarMovimiento({ existencia: 10, costoPromedio: 1 }, { signo: -1, cantidad: 25 });
    assert.deepEqual([e.existencia, e.negativo], [-15, true]);
    e = aplicarMovimiento(e, { signo: 1, cantidad: 100, costoUnitario: 2 });
    assert.deepEqual([e.existencia, e.costoPromedio], [85, 2]);
  });
  it("ajuste al alza entra al promedio vigente", () => {
    const e = aplicarMovimiento({ existencia: 10, costoPromedio: 3 }, { signo: 1, cantidad: 5, costoUnitario: null });
    assert.deepEqual([e.existencia, e.costoPromedio, e.costoUnitario], [15, 3, 3]);
  });
  it("redondea", () => assert.equal(redondear(0.1 + 0.2, 3), 0.3));
});
