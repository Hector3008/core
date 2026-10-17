import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calcularProgreso, claveItem, validarReto } from "../src/fidelizacion/retos.js";
import { ErrorFidelizacion } from "../src/fidelizacion/errores.js";

const malo = (fn, re) => assert.throws(fn, (e) => e instanceof ErrorFidelizacion && e.codigo === "DATOS_INVALIDOS" && (!re || re.test(e.message)));
const base = { nombre: "Catador", categoria: "Cafés", tipo: "item_gratis", itemCodigo: "LATTE", vigenciaDias: 30 };

describe("validarReto", () => {
  it("normaliza un reto válido y no trae puntos", () => {
    const r = validarReto({ ...base, nombre: "  Catador  ", categoria: " Cafés " });
    assert.deepEqual(r, { nombre: "Catador", descripcion: null, categoria: "Cafés", tipo: "item_gratis", valor: null, itemCodigo: "LATTE", vigenciaDias: 30, activo: true });
    assert.equal("puntos" in r, false);
  });
  it("exige categoría y valida el premio como un beneficio", () => {
    malo(() => validarReto({ ...base, categoria: "" }), /categoria/);
    malo(() => validarReto({ ...base, categoria: undefined }), /categoria/);
    malo(() => validarReto({ ...base, tipo: "descuento_porcentaje", itemCodigo: undefined, valor: 150 }), /porcentaje/);
    malo(() => validarReto({ ...base, tipo: "item_gratis", itemCodigo: "" }), /itemCodigo/);
    malo(() => validarReto({ ...base, tipo: "inventado" }), /tipo/);
    malo(() => validarReto({ ...base, vigenciaDias: 0 }), /vigenciaDias/);
    malo(() => validarReto({ ...base, puntos: 10 }), /no admitidos/);
  });
  it("al editar superpone los cambios y revalida el conjunto", () => {
    const actual = validarReto(base);
    const r = validarReto({ tipo: "descuento_monto", valor: 5 }, actual);
    assert.equal(r.tipo, "descuento_monto");
    assert.equal(r.itemCodigo, null);
    malo(() => validarReto({}, actual), /nada que cambiar/);
    malo(() => validarReto({ tipo: "descuento_monto" }, actual), /valor/);
    assert.equal(validarReto({ activo: false }, actual).activo, false);
  });
});

describe("calcularProgreso", () => {
  const carta = [{ codigo: "LATTE", nombre: "Latte" }, { codigo: "MOKA", nombre: "Moka" }, { codigo: "CORTADO", nombre: "Cortado" }];
  const acu = (itemCodigo, tipo = "acumulo") => ({ tipo, itemCodigo });

  it("cuenta los ítems distintos comprados, sin distinguir mayúsculas ni repeticiones", () => {
    const p = calcularProgreso({ requeridos: carta, movimientos: [acu("latte"), acu("LATTE"), acu("Moka")] });
    assert.equal(p.total, 3);
    assert.equal(p.logrados, 2);
    assert.deepEqual(p.faltan, [{ codigo: "CORTADO", nombre: "Cortado" }]);
    assert.equal(p.completo, false);
  });
  it("completo cuando no falta ninguno", () => {
    const p = calcularProgreso({ requeridos: carta, movimientos: [acu("LATTE"), acu("MOKA"), acu("CORTADO"), acu("TÉ")] });
    assert.equal(p.completo, true);
    assert.equal(p.logrados, 3);
    assert.deepEqual(p.faltan, []);
  });
  it("solo cuentan los acumulos con ítem: canjes, ajustes y consumos viejos sin ítem no", () => {
    const p = calcularProgreso({ requeridos: carta, movimientos: [acu("LATTE", "canje"), acu("MOKA", "ajuste"), { tipo: "acumulo", itemCodigo: null }, { tipo: "acumulo" }] });
    assert.equal(p.logrados, 0);
  });
  it("una carta vacía nunca completa; un ítem retirado de la carta no suma", () => {
    assert.equal(calcularProgreso({ requeridos: [], movimientos: [acu("LATTE")] }).completo, false);
    const p = calcularProgreso({ requeridos: [carta[0]], movimientos: [acu("MOKA")] });
    assert.equal(p.logrados, 0);
  });
  it("si se agrega un ítem a la carta, el avance baja y el reto deja de estar completo", () => {
    const comprados = [acu("LATTE"), acu("MOKA"), acu("CORTADO")];
    assert.equal(calcularProgreso({ requeridos: carta, movimientos: comprados }).completo, true);
    assert.equal(calcularProgreso({ requeridos: [...carta, { codigo: "FLAT", nombre: "Flat white" }], movimientos: comprados }).completo, false);
  });
  it("entradas inválidas no rompen", () => {
    assert.deepEqual(calcularProgreso({ requeridos: null, movimientos: null }), { total: 0, logrados: 0, faltan: [], completo: false });
    assert.equal(claveItem("  LaTte "), "latte");
  });
});
