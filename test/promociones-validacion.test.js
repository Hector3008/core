// Validación de promociones y zona horaria (5.40): lógica pura.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validarPromocion, MAX_PROMOCIONES_ACTIVAS } from "../src/promociones/validacion.js";
import { ErrorPromocion } from "../src/promociones/errores.js";
import { ZONAS, zonaDeEmpresa, zonaValida } from "../src/zona.js";

const malo = (fn, texto) => assert.throws(fn, (e) => e instanceof ErrorPromocion && e.codigo === "DATOS_INVALIDOS" && (!texto || e.message.includes(texto)));
const item = (c) => ({ itemCodigo: c });
const dos = { nombre: "2x1 en lattes", tipo: "nxm", n: 2, m: 1, objetivo: item("LATTE") };

describe("validarPromocion", () => {
  it("un 2x1 válido sale completo y normalizado", () => {
    assert.deepEqual(validarPromocion({ ...dos, nombre: "  2x1 en lattes  " }), {
      nombre: "2x1 en lattes", descripcion: null, activa: true, prioridad: 100, acumulable: false, tipo: "nxm",
      objetivo: { itemCodigo: "LATTE", categoria: null }, disparador: null, n: 2, m: 1, efecto: null, valor: null,
      vigencia: null, dias: null, horario: null,
    });
  });

  it("combo y directo piden su efecto y su valor", () => {
    const combo = { nombre: "Combo", tipo: "combo", disparador: item("SAND"), objetivo: { categoria: "Cafés" }, efecto: "porcentaje", valor: 50 };
    const r = validarPromocion(combo);
    assert.deepEqual([r.disparador, r.objetivo, r.efecto, r.valor], [{ itemCodigo: "SAND", categoria: null }, { itemCodigo: null, categoria: "Cafés" }, "porcentaje", 50]);
    assert.equal(validarPromocion({ nombre: "Gratis", tipo: "directo", objetivo: item("X"), efecto: "gratis" }).valor, null);
    malo(() => validarPromocion({ ...combo, disparador: undefined }), "disparador");
    malo(() => validarPromocion({ ...combo, efecto: undefined }), "efecto");
    malo(() => validarPromocion({ ...combo, valor: undefined }), "valor");
  });

  it("efecto y valor: porcentaje hasta 100, monto positivo, gratis sin valor, hasta 2 decimales", () => {
    const d = { nombre: "D", tipo: "directo", objetivo: item("X") };
    malo(() => validarPromocion({ ...d, efecto: "porcentaje", valor: 101 }), "100");
    malo(() => validarPromocion({ ...d, efecto: "porcentaje", valor: 0 }));
    malo(() => validarPromocion({ ...d, efecto: "monto", valor: -1 }));
    malo(() => validarPromocion({ ...d, efecto: "monto", valor: 1.234 }), "2 decimales");
    malo(() => validarPromocion({ ...d, efecto: "gratis", valor: 5 }), "gratis");
    malo(() => validarPromocion({ ...d, efecto: "regalo", valor: 5 }), "efecto");
    malo(() => validarPromocion({ ...d, efecto: "monto", valor: "5" }));
    assert.equal(validarPromocion({ ...d, efecto: "porcentaje", valor: 12.5 }).valor, 12.5);
  });

  it("nxm: n de 2 a 10 y m menor que n", () => {
    malo(() => validarPromocion({ ...dos, n: 1 }), "n");
    malo(() => validarPromocion({ ...dos, n: 11 }), "n");
    malo(() => validarPromocion({ ...dos, m: 0 }), "m");
    malo(() => validarPromocion({ ...dos, n: 3, m: 3 }), "menor que n");
    malo(() => validarPromocion({ ...dos, n: 2.5 }));
    assert.equal(validarPromocion({ ...dos, n: 3, m: 2 }).m, 2);
  });

  it("el selector lleva un ítem o una categoría, uno solo y bien escrito", () => {
    malo(() => validarPromocion({ ...dos, objetivo: undefined }), "objetivo");
    malo(() => validarPromocion({ ...dos, objetivo: {} }), "ni ninguno");
    malo(() => validarPromocion({ ...dos, objetivo: { itemCodigo: "A", categoria: "B" } }), "no los dos");
    malo(() => validarPromocion({ ...dos, objetivo: { itemCodigo: "tiene espacios" } }), "itemCodigo");
    malo(() => validarPromocion({ ...dos, objetivo: { categoria: "x".repeat(61) } }), "categoria");
    malo(() => validarPromocion({ ...dos, objetivo: { sku: "A" } }), "no admitidos");
  });

  it("nombre, descripción, prioridad y banderas", () => {
    malo(() => validarPromocion({ ...dos, nombre: "  " }), "nombre");
    malo(() => validarPromocion({ ...dos, nombre: "x".repeat(81) }), "nombre");
    malo(() => validarPromocion({ ...dos, descripcion: "x".repeat(201) }), "descripcion");
    malo(() => validarPromocion({ ...dos, prioridad: -1 }), "prioridad");
    malo(() => validarPromocion({ ...dos, prioridad: 1001 }), "prioridad");
    malo(() => validarPromocion({ ...dos, activa: "si" }), "activa");
    malo(() => validarPromocion({ ...dos, acumulable: 1 }), "acumulable");
    malo(() => validarPromocion({ ...dos, tipo: "regalo" }), "tipo");
  });

  it("rechaza campos que no son de su tipo, en vez de ignorarlos", () => {
    malo(() => validarPromocion({ ...dos, efecto: "gratis" }), "efecto");
    malo(() => validarPromocion({ nombre: "D", tipo: "directo", objetivo: item("X"), efecto: "gratis", n: 2 }), "n");
    malo(() => validarPromocion({ ...dos, descuento: 10 }), "descuento");
    malo(() => validarPromocion([]), "objeto");
  });

  it("vigencia: fechas reales y en orden", () => {
    assert.deepEqual(validarPromocion({ ...dos, vigencia: { desde: "2026-11-01", hasta: "2026-11-15" } }).vigencia, { desde: "2026-11-01", hasta: "2026-11-15" });
    assert.deepEqual(validarPromocion({ ...dos, vigencia: { desde: "2026-11-01" } }).vigencia, { desde: "2026-11-01", hasta: null });
    assert.equal(validarPromocion({ ...dos, vigencia: {} }).vigencia, null);
    malo(() => validarPromocion({ ...dos, vigencia: { desde: "2026-02-30" } }), "fecha real");
    malo(() => validarPromocion({ ...dos, vigencia: { desde: "01/11/2026" } }), "AAAA-MM-DD");
    malo(() => validarPromocion({ ...dos, vigencia: { desde: "2026-11-15", hasta: "2026-11-01" } }), "antes");
    malo(() => validarPromocion({ ...dos, vigencia: { inicio: "2026-11-15" } }), "no admitidos");
  });

  it("días: enteros de 0 a 6, sin repetir y ordenados", () => {
    assert.deepEqual(validarPromocion({ ...dos, dias: [5, 1, 5, 3] }).dias, [1, 3, 5]);
    assert.equal(validarPromocion({ ...dos, dias: [] }).dias, null);
    malo(() => validarPromocion({ ...dos, dias: [7] }), "dias");
    malo(() => validarPromocion({ ...dos, dias: "lunes" }), "dias");
  });

  it("horario: HH:MM de 24 horas, distintos", () => {
    assert.deepEqual(validarPromocion({ ...dos, horario: { desde: "18:00", hasta: "20:30" } }).horario, { desde: "18:00", hasta: "20:30" });
    assert.ok(validarPromocion({ ...dos, horario: { desde: "22:00", hasta: "02:00" } }).horario, "cruzar la medianoche es válido");
    malo(() => validarPromocion({ ...dos, horario: { desde: "18:00", hasta: "18:00" } }), "iguales");
    malo(() => validarPromocion({ ...dos, horario: { desde: "6pm", hasta: "20:00" } }), "HH:MM");
    malo(() => validarPromocion({ ...dos, horario: { desde: "24:00", hasta: "20:00" } }), "HH:MM");
    malo(() => validarPromocion({ ...dos, horario: { desde: "18:00" } }), "HH:MM");
  });

  it("editar: lo que no se envía se conserva y se valida el conjunto", () => {
    const base = validarPromocion({ ...dos, dias: [1] });
    assert.equal(validarPromocion({ activa: false }, base).activa, false);
    assert.deepEqual(validarPromocion({ activa: false }, base).dias, [1]);
    assert.equal(validarPromocion({ dias: null }, base).dias, null, "null quita el campo");
    malo(() => validarPromocion({}, base), "nada que cambiar");
    malo(() => validarPromocion({ m: 5 }, base), "menor que n");
  });

  it("editar: cambiar de tipo exige lo propio del tipo nuevo, y cambiar de efecto no arrastra el valor viejo", () => {
    const base = validarPromocion({ nombre: "D", tipo: "directo", objetivo: item("X"), efecto: "porcentaje", valor: 10 });
    malo(() => validarPromocion({ tipo: "combo", efecto: "porcentaje" }, base), "disparador");
    assert.equal(validarPromocion({ tipo: "nxm", n: 2, m: 1 }, base).efecto, null);
    const gratis = validarPromocion({ efecto: "gratis" }, base);
    assert.deepEqual([gratis.efecto, gratis.valor], ["gratis", null]);
  });

  it("el tope de promociones activas es 100", () => assert.equal(MAX_PROMOCIONES_ACTIVAS, 100));
});

describe("zona horaria de la empresa", () => {
  it("zonaValida acepta nombres IANA y rechaza el resto", () => {
    for (const z of ["America/Lima", "Europe/Madrid", "UTC"]) assert.equal(zonaValida(z), true, z);
    for (const z of ["Lima", "UTC-5", "", "  ", null, undefined, 5, "x".repeat(65)]) assert.equal(zonaValida(z), false, String(z));
  });

  it("manda la que fijó la empresa, luego la del país, luego UTC", () => {
    assert.equal(zonaDeEmpresa({ pais: "PE" }), "America/Lima");
    assert.equal(zonaDeEmpresa({}), "America/Lima", "sin país se asume PE");
    assert.equal(zonaDeEmpresa({ pais: "mx" }), "America/Mexico_City");
    assert.equal(zonaDeEmpresa({ pais: "PE", zonaHoraria: "America/Bogota" }), "America/Bogota");
    assert.equal(zonaDeEmpresa({ pais: "PE", zonaHoraria: "Lima" }), "America/Lima", "una zona inválida se ignora");
    assert.equal(zonaDeEmpresa({ pais: "ZZ" }), "UTC");
    assert.equal(ZONAS.PE, "America/Lima");
  });
});
