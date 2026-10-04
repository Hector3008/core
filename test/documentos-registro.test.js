// No necesita MongoDB: solo valida la declaración de tipos.
import test from "node:test";
import assert from "node:assert/strict";
import { crearRegistroTipos } from "../src/documentos/registro.js";
import { ErrorDocumento } from "../src/documentos/errores.js";

const base = () => ({
  tipo: "proforma",
  prefijo: "DP",
  estadoInicial: "borrador",
  transiciones: {
    borrador: ["cotizacion", "descartado"],
    cotizacion: ["orden_salida", "rechazada"],
    orden_salida: ["cerrada"],
  },
});

test("deduce estados, finales y editables", () => {
  const t = crearRegistroTipos().registrar(base());
  assert.deepEqual(t.estados.sort(), [
    "borrador",
    "cerrada",
    "cotizacion",
    "descartado",
    "orden_salida",
    "rechazada",
  ]);
  assert.deepEqual(t.finales.sort(), ["cerrada", "descartado", "rechazada"]);
  assert.deepEqual(t.editables.sort(), ["borrador", "cotizacion", "orden_salida"]);
});

test("rechaza declaraciones inválidas", () => {
  const r = crearRegistroTipos();
  assert.throws(() => r.registrar({ ...base(), prefijo: "dp" }), /prefijo/);
  assert.throws(() => r.registrar({ ...base(), estadoInicial: "" }), /estadoInicial/);
  assert.throws(
    () => r.registrar({ ...base(), transiciones: { borrador: "cotizacion" } }),
    /lista de estados/,
  );
  assert.throws(
    () => r.registrar({ ...base(), permisos: { fantasma: "x:y" } }),
    /estado desconocido/,
  );
  assert.throws(
    () => r.registrar({ ...base(), motivos: { rechazada: [] } }),
    /lista no vacía/,
  );
  assert.throws(
    () => r.registrar({ ...base(), editables: ["fantasma"] }),
    /editables/,
  );
});

test("registrar es idempotente con las mismas reglas y falla con otras", () => {
  const r = crearRegistroTipos();
  r.registrar(base());
  assert.doesNotThrow(() => r.registrar(base()));
  assert.throws(
    () => r.registrar({ ...base(), transiciones: { borrador: ["x"] } }),
    /otras reglas/,
  );
});

test("el prefijo no se puede repetir entre tipos", () => {
  const r = crearRegistroTipos();
  r.registrar(base());
  assert.throws(() => r.registrar({ ...base(), tipo: "otro" }), /ya lo usa/);
});

test("tipo no registrado lanza ErrorDocumento", () => {
  const r = crearRegistroTipos();
  assert.throws(
    () => r.obtener("nada"),
    (e) => e instanceof ErrorDocumento && e.codigo === "TIPO_NO_REGISTRADO",
  );
});
