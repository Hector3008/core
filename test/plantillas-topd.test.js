import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PLANTILLAS, plantillasPara } from "../src/modelos/plantillas.js";
import { permite } from "../src/permisos.js";

describe("plantilla de roles de topd", () => {
  it("cada estación tiene su rol y la bandeja la ven vendedor y revisor", () => {
    const t = PLANTILLAS.topd;
    assert.ok(permite(t.vendedor, "estacion:creacion"));
    assert.ok(permite(t.almacen, "estacion:produccion"));
    assert.ok(permite(t.revisor, "estacion:revision"));
    assert.ok(permite(t.vendedor, "estacion:bandeja"));
    assert.ok(permite(t.revisor, "estacion:bandeja"));
    assert.equal(permite(t.almacen, "estacion:bandeja"), false);
  });

  it("nadie fuera de su estación: el almacén no crea ni cierra, el revisor no vende", () => {
    const t = PLANTILLAS.topd;
    assert.equal(permite(t.almacen, "estacion:revision"), false);
    assert.equal(permite(t.almacen, "documento:crear"), false);
    assert.equal(permite(t.revisor, "estacion:produccion"), false);
    assert.equal(permite(t.revisor, "documento:crear"), false);
    assert.equal(permite(t.vendedor, "estacion:revision"), false);
  });

  it("al contratar topd la empresa recibe admin y los tres roles", () => {
    const r = plantillasPara(["topd"]);
    assert.deepEqual(Object.keys(r).sort(), ["admin", "almacen", "revisor", "vendedor"]);
  });
});
