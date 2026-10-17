import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calcularDescuento,
  estadoEfectivo,
  generarCodigo,
  normalizarCodigo,
  textoBeneficio,
  validarBeneficio,
} from "../src/fidelizacion/beneficios.js";
import { ErrorFidelizacion } from "../src/fidelizacion/errores.js";

const rechaza = (fn, re) => assert.throws(fn, (e) => e instanceof ErrorFidelizacion && e.codigo && (!re || re.test(e.message)));

describe("validarBeneficio", () => {
  const base = { nombre: " Café gratis ", puntos: 100, tipo: "item_gratis", itemCodigo: "CAFE" };
  it("normaliza y completa los valores por defecto", () => {
    assert.deepEqual(validarBeneficio(base), {
      nombre: "Café gratis", descripcion: null, puntos: 100, tipo: "item_gratis", valor: null, itemCodigo: "CAFE", vigenciaDias: 30, activo: true,
    });
  });
  it("porcentaje: 1 a 100; monto: mayor que 0 con 2 decimales", () => {
    assert.equal(validarBeneficio({ nombre: "10%", puntos: 50, tipo: "descuento_porcentaje", valor: 10 }).valor, 10);
    rechaza(() => validarBeneficio({ nombre: "x", puntos: 50, tipo: "descuento_porcentaje", valor: 101 }));
    rechaza(() => validarBeneficio({ nombre: "x", puntos: 50, tipo: "descuento_porcentaje", valor: 0 }));
    assert.equal(validarBeneficio({ nombre: "5", puntos: 50, tipo: "descuento_monto", valor: 5.5 }).valor, 5.5);
    rechaza(() => validarBeneficio({ nombre: "x", puntos: 50, tipo: "descuento_monto", valor: 5.555 }));
    rechaza(() => validarBeneficio({ nombre: "x", puntos: 50, tipo: "descuento_monto" }));
  });
  it("item_gratis exige el código del plato y descarta el valor", () => {
    rechaza(() => validarBeneficio({ nombre: "x", puntos: 5, tipo: "item_gratis" }));
    assert.equal(validarBeneficio({ ...base, valor: 9 }).valor, null);
  });
  it("rechaza nombre vacío o largo, puntos no enteros, campos extra y vigencia fuera de rango", () => {
    rechaza(() => validarBeneficio({ ...base, nombre: "  " }));
    rechaza(() => validarBeneficio({ ...base, nombre: "a".repeat(81) }));
    rechaza(() => validarBeneficio({ ...base, puntos: 0 }));
    rechaza(() => validarBeneficio({ ...base, puntos: 1.5 }));
    rechaza(() => validarBeneficio({ ...base, tipo: "otro" }));
    rechaza(() => validarBeneficio({ ...base, vigenciaDias: 366 }));
    rechaza(() => validarBeneficio({ ...base, vigenciaDias: 0 }));
    rechaza(() => validarBeneficio({ ...base, empresaId: "x" }), /no admitidos/);
    rechaza(() => validarBeneficio({ ...base, descripcion: "d".repeat(201) }));
    rechaza(() => validarBeneficio({ ...base, activo: "si" }));
  });
  it("al editar valida el conjunto: cambiar el tipo exige su valor", () => {
    const actual = validarBeneficio(base);
    assert.equal(validarBeneficio({ puntos: 80 }, actual).puntos, 80);
    rechaza(() => validarBeneficio({ tipo: "descuento_monto" }, actual));
    const m = validarBeneficio({ tipo: "descuento_monto", valor: 3 }, actual);
    assert.equal(m.itemCodigo, null);
    assert.equal(m.valor, 3);
    rechaza(() => validarBeneficio({}, actual), /nada que cambiar/);
    assert.equal(validarBeneficio({ activo: false }, actual).activo, false);
  });
});

describe("calcularDescuento", () => {
  it("porcentaje sobre el subtotal, en centavos, con tope", () => {
    assert.equal(calcularDescuento({ tipo: "descuento_porcentaje", valor: 10 }, { subtotal: 25.5 }), 2.55);
    assert.equal(calcularDescuento({ tipo: "descuento_porcentaje", valor: 33.33 }, { subtotal: 10 }), 3.33);
    assert.equal(calcularDescuento({ tipo: "descuento_porcentaje", valor: 100 }, { subtotal: 7.9 }), 7.9);
  });
  it("monto fijo con tope en el subtotal", () => {
    assert.equal(calcularDescuento({ tipo: "descuento_monto", valor: 5 }, { subtotal: 12 }), 5);
    assert.equal(calcularDescuento({ tipo: "descuento_monto", valor: 50 }, { subtotal: 12 }), 12);
  });
  it("ítem gratis: una unidad del plato indicado", () => {
    const b = { tipo: "item_gratis", itemCodigo: "CAFE" };
    assert.equal(calcularDescuento(b, { codigo: "CAFE", precio: 4.5, cantidad: 3, subtotal: 13.5 }), 4.5);
    rechaza(() => calcularDescuento(b, { codigo: "TE", precio: 4.5, cantidad: 1, subtotal: 4.5 }), /CAFE/);
    rechaza(() => calcularDescuento(b, { codigo: "CAFE", precio: null, cantidad: 1, subtotal: 4.5 }));
  });
  it("un ítem sin precio no admite el vale", () => {
    rechaza(() => calcularDescuento({ tipo: "descuento_monto", valor: 1 }, { subtotal: null }));
    rechaza(() => calcularDescuento({ tipo: "descuento_monto", valor: 1 }, { subtotal: 0 }));
  });
});

describe("códigos de vale", () => {
  it("se generan con el alfabeto sin ambiguos y largo 6", () => {
    for (let i = 0; i < 200; i++) assert.match(generarCodigo(), /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  });
  it("se normalizan: mayúsculas, sin espacios ni guiones", () => {
    assert.equal(normalizarCodigo(" k7m-2qx "), "K7M2QX");
    assert.equal(normalizarCodigo("K7M 2QX"), "K7M2QX");
    assert.equal(normalizarCodigo("K7M2Q"), null);
    assert.equal(normalizarCodigo("K7M2Q0"), null); // el 0 no existe en el alfabeto
    assert.equal(normalizarCodigo(undefined), null);
  });
});

describe("estadoEfectivo y textoBeneficio", () => {
  const ahora = new Date("2026-10-17T12:00:00Z");
  it("un vale activo vencido se muestra vencido; los demás estados no cambian", () => {
    assert.equal(estadoEfectivo({ estado: "activo", venceTs: "2026-10-17T11:59:59Z" }, ahora), "vencido");
    assert.equal(estadoEfectivo({ estado: "activo", venceTs: "2026-10-18T00:00:00Z" }, ahora), "activo");
    assert.equal(estadoEfectivo({ estado: "usado", venceTs: "2026-01-01T00:00:00Z" }, ahora), "usado");
  });
  it("texto legible", () => {
    assert.match(textoBeneficio({ tipo: "descuento_porcentaje", valor: 15 }), /15%/);
    assert.match(textoBeneficio({ tipo: "item_gratis", itemCodigo: "CAFE" }), /CAFE/);
  });
});
