// Lógica pura del evaluador de promociones (5.40): no necesita base de datos.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluarPromociones, estaVigente, MAX_UNIDADES } from "../src/promociones/evaluador.js";
import { ErrorPromocion } from "../src/promociones/errores.js";
import { momentoLocal } from "../src/zona.js";

const L = (codigo, cantidad, precio, categoria = null, id = codigo) => ({ id, codigo, categoria, cantidad, precio });
let seq = 0;
const P = (o) => ({
  id: o.id ?? `p${++seq}`, nombre: "Promo", activa: true, prioridad: 100, acumulable: false, descripcion: null,
  objetivo: null, disparador: null, n: null, m: null, efecto: null, valor: null, vigencia: null, dias: null, horario: null, ...o,
});
const item = (codigo) => ({ itemCodigo: codigo, categoria: null });
const cat = (categoria) => ({ itemCodigo: null, categoria });
const dos = (p) => P({ tipo: "nxm", n: 2, m: 1, ...p });

// Jueves 22 de octubre de 2026, 20:00 en Lima (UTC-5) = 23 de octubre 01:00 UTC
const JUEVES_20H = new Date("2026-10-23T01:00:00Z");
const ev = (lineas, promociones, ahora = JUEVES_20H, zona = "America/Lima") => evaluarPromociones({ lineas, promociones, ahora, zona });
const desc = (r, id) => r.lineas.find((l) => l.id === id).descuento;

describe("2x1 y compañía (nxm)", () => {
  it("2x1: lleva 2 y paga 1", () => {
    const r = ev([L("LATTE", 2, 10)], [dos({ objetivo: item("LATTE") })]);
    assert.equal(r.descuentoTotal, 10);
    assert.equal(r.total, 10);
    assert.equal(r.totalBase, 20);
    assert.deepEqual(r.aplicadas.map((a) => [a.veces, a.monto]), [[1, 10]]);
  });

  it("con una sola unidad no hay descuento; con 3 hay una gratis; con 4, dos", () => {
    const p = dos({ objetivo: item("LATTE") });
    assert.equal(ev([L("LATTE", 1, 10)], [p]).descuentoTotal, 0);
    assert.equal(ev([L("LATTE", 3, 10)], [p]).descuentoTotal, 10);
    assert.equal(ev([L("LATTE", 4, 10)], [p]).descuentoTotal, 20);
  });

  it("3x2 y el código no distingue mayúsculas", () => {
    const p = P({ tipo: "nxm", n: 3, m: 2, objetivo: item("latte") });
    assert.equal(ev([L("LATTE", 3, 9)], [p]).descuentoTotal, 9);
    assert.equal(ev([L("Latte", 5, 9)], [p]).descuentoTotal, 9);
    assert.equal(ev([L("LATTE", 6, 9)], [p]).descuentoTotal, 18);
  });

  it("por categoría: la unidad más barata es la gratis, y cae en su propia línea", () => {
    const r = ev([L("LATTE", 1, 12, "Cafés"), L("MOKA", 1, 8, "Cafés"), L("TE", 1, 5, "Tés")], [dos({ objetivo: cat("cafés") })]);
    assert.equal(r.descuentoTotal, 8);
    assert.equal(desc(r, "MOKA"), 8);
    assert.equal(desc(r, "LATTE"), 0);
    assert.equal(desc(r, "TE"), 0);
  });

  it("agrupa de las más caras a las más baratas: con 10, 8, 6 y 5 salen gratis 8 y 5", () => {
    const lineas = [L("A", 1, 10, "X"), L("B", 1, 8, "X"), L("C", 1, 6, "X"), L("D", 1, 5, "X")];
    const r = ev(lineas, [dos({ objetivo: cat("X") })]);
    assert.equal(r.descuentoTotal, 13);
    assert.deepEqual(["A", "B", "C", "D"].map((i) => desc(r, i)), [0, 8, 0, 5]);
  });

  it("cuenta unidades entre líneas distintas del mismo plato", () => {
    const r = ev([L("LATTE", 1, 10, null, "l1"), L("LATTE", 1, 10, null, "l2")], [dos({ objetivo: item("LATTE") })]);
    assert.equal(r.descuentoTotal, 10);
    assert.equal(desc(r, "l1") + desc(r, "l2"), 10);
  });
});

describe("combo: si lleva A, B con descuento", () => {
  const combo = (o = {}) => P({ tipo: "combo", disparador: item("SAND"), objetivo: item("CAFE"), efecto: "porcentaje", valor: 50, ...o });

  it("un café con descuento por cada sándwich", () => {
    assert.equal(ev([L("SAND", 1, 15), L("CAFE", 2, 8)], [combo()]).descuentoTotal, 4);
    assert.equal(ev([L("SAND", 2, 15), L("CAFE", 2, 8)], [combo()]).descuentoTotal, 8);
    assert.equal(ev([L("SAND", 3, 15), L("CAFE", 2, 8)], [combo()]).descuentoTotal, 8);
  });

  it("sin el disparador no hay descuento, y el disparador solo no descuenta nada", () => {
    assert.equal(ev([L("CAFE", 2, 8)], [combo()]).descuentoTotal, 0);
    assert.equal(ev([L("SAND", 2, 15)], [combo()]).descuentoTotal, 0);
  });

  it("el efecto puede ser gratis o un monto fijo (sin pasarse de lo que cuesta)", () => {
    assert.equal(ev([L("SAND", 1, 15), L("CAFE", 1, 8)], [combo({ efecto: "gratis", valor: null })]).descuentoTotal, 8);
    assert.equal(ev([L("SAND", 1, 15), L("CAFE", 1, 8)], [combo({ efecto: "monto", valor: 3 })]).descuentoTotal, 3);
    assert.equal(ev([L("SAND", 1, 15), L("CAFE", 1, 2)], [combo({ efecto: "monto", valor: 3 })]).descuentoTotal, 2);
  });

  it("el descuento va a la unidad más barata del objetivo", () => {
    const r = ev([L("SAND", 1, 15), L("CAFE", 1, 10, null, "caro"), L("CAFE", 1, 6, null, "barato")], [combo()]);
    assert.equal(desc(r, "barato"), 3);
    assert.equal(desc(r, "caro"), 0);
  });

  it("disparador y objetivo pueden ser categorías", () => {
    const p = combo({ disparador: cat("Comidas"), objetivo: cat("Bebidas") });
    assert.equal(ev([L("SAND", 1, 15, "Comidas"), L("COLA", 1, 6, "Bebidas")], [p]).descuentoTotal, 3);
  });

  it("si el disparador y el objetivo son lo mismo, hacen falta dos unidades: «lleva 2, el 2.º a mitad»", () => {
    const p = combo({ disparador: item("CAFE"), objetivo: item("CAFE") });
    assert.equal(ev([L("CAFE", 1, 10)], [p]).descuentoTotal, 0);
    assert.equal(ev([L("CAFE", 2, 10)], [p]).descuentoTotal, 5);
    assert.equal(ev([L("CAFE", 3, 10)], [p]).descuentoTotal, 5);
    assert.equal(ev([L("CAFE", 4, 10)], [p]).descuentoTotal, 10);
  });
});

describe("descuento directo", () => {
  const directo = (o) => P({ tipo: "directo", objetivo: item("TORTA"), ...o });

  it("porcentaje, monto y gratis", () => {
    assert.equal(ev([L("TORTA", 1, 25.5)], [directo({ efecto: "porcentaje", valor: 10 })]).descuentoTotal, 2.55);
    assert.equal(ev([L("TORTA", 2, 25.5)], [directo({ efecto: "monto", valor: 4 })]).descuentoTotal, 8);
    assert.equal(ev([L("TORTA", 2, 25.5)], [directo({ efecto: "gratis" })]).total, 0);
  });

  it("un monto fijo nunca supera lo que cuesta la unidad", () => {
    const r = ev([L("TORTA", 2, 3)], [directo({ efecto: "monto", valor: 5 })]);
    assert.equal(r.descuentoTotal, 6);
    assert.equal(r.total, 0);
  });

  it("redondea en centavos: 33,33 % de 10,01", () => {
    const r = ev([L("TORTA", 1, 10.01)], [directo({ efecto: "porcentaje", valor: 33.33 })]);
    assert.equal(r.descuentoTotal, 3.34);
    assert.equal(r.total, 6.67);
  });

  it("por categoría y solo en lo que coincide", () => {
    const r = ev([L("TORTA", 1, 20, "Postres"), L("FLAN", 1, 10, "Postres"), L("CAFE", 1, 8, "Cafés")], [directo({ objetivo: cat("postres"), efecto: "porcentaje", valor: 10 })]);
    assert.equal(r.descuentoTotal, 3);
    assert.equal(desc(r, "CAFE"), 0);
  });
});

describe("cuándo rige: vigencia, días y horario, a la hora de la empresa", () => {
  const base = { tipo: "directo", objetivo: item("TORTA"), efecto: "porcentaje", valor: 10 };
  const aplica = (extra, ahora = JUEVES_20H, zona = "America/Lima") => ev([L("TORTA", 1, 10)], [P({ ...base, ...extra })], ahora, zona).descuentoTotal > 0;

  it("momentoLocal ve el día de la empresa, no el del servidor", () => {
    assert.deepEqual(momentoLocal(JUEVES_20H, "America/Lima"), { fecha: "2026-10-22", dia: 4, minutos: 1200 });
    assert.deepEqual(momentoLocal(JUEVES_20H, "UTC"), { fecha: "2026-10-23", dia: 5, minutos: 60 });
  });

  it("vigencia: ambas fechas incluidas, vistas en la zona de la empresa", () => {
    assert.equal(aplica({ vigencia: { desde: "2026-10-22", hasta: "2026-10-22" } }), true);
    assert.equal(aplica({ vigencia: { desde: "2026-10-23", hasta: null } }), false, "en Lima todavía es 22");
    assert.equal(aplica({ vigencia: { desde: "2026-10-23", hasta: null } }, JUEVES_20H, "UTC"), true, "en UTC ya es 23");
    assert.equal(aplica({ vigencia: { desde: null, hasta: "2026-10-21" } }), false);
  });

  it("días de la semana (0 = domingo)", () => {
    assert.equal(aplica({ dias: [4] }), true);
    assert.equal(aplica({ dias: [1, 2, 3] }), false);
    assert.equal(aplica({ dias: [5] }), false, "en Lima es jueves");
    assert.equal(aplica({ dias: [5] }, JUEVES_20H, "UTC"), true, "en UTC ya es viernes");
  });

  it("horario: el inicio cuenta, el final no", () => {
    assert.equal(aplica({ horario: { desde: "18:00", hasta: "21:00" } }), true);
    assert.equal(aplica({ horario: { desde: "20:00", hasta: "21:00" } }), true);
    assert.equal(aplica({ horario: { desde: "19:00", hasta: "20:00" } }), false);
    assert.equal(aplica({ horario: { desde: "08:00", hasta: "12:00" } }), false);
  });

  it("un horario que cruza la medianoche rige hasta la madrugada", () => {
    const noche = { horario: { desde: "22:00", hasta: "02:00" } };
    assert.equal(aplica(noche), false, "20:00");
    assert.equal(aplica(noche, new Date("2026-10-23T04:30:00Z")), true, "23:30 en Lima");
    assert.equal(aplica(noche, new Date("2026-10-23T06:00:00Z")), true, "01:00 en Lima");
    assert.equal(aplica(noche, new Date("2026-10-23T07:00:00Z")), false, "02:00 en Lima");
  });

  it("una promoción pausada no rige, y `vigentes` dice cuáles rigen", () => {
    const pausada = P({ ...base, activa: false });
    const activa = P({ ...base, id: "viva" });
    const r = ev([L("TORTA", 1, 10)], [pausada, activa]);
    assert.deepEqual(r.vigentes, ["viva"]);
    assert.equal(estaVigente(pausada, r.momento), false);
  });
});

describe("prioridad, choques y acumulables", () => {
  const directo = (o) => P({ tipo: "directo", objetivo: item("TORTA"), efecto: "porcentaje", valor: 10, ...o });

  it("una unidad recibe una sola promoción: gana la de menor prioridad", () => {
    const a = directo({ id: "a", prioridad: 50, valor: 10 });
    const b = directo({ id: "b", prioridad: 10, valor: 50 });
    const r = ev([L("TORTA", 1, 100)], [a, b]);
    assert.equal(r.descuentoTotal, 50);
    assert.deepEqual(r.aplicadas.map((x) => x.id), ["b"]);
  });

  it("a igual prioridad, la que llegó primero", () => {
    const r = ev([L("TORTA", 1, 100)], [directo({ id: "a", valor: 10 }), directo({ id: "b", valor: 50 })]);
    assert.deepEqual(r.aplicadas.map((x) => x.id), ["a"]);
  });

  it("dos promociones acumulables se suman, la segunda sobre lo que queda", () => {
    const r = ev([L("TORTA", 1, 100)], [directo({ id: "a", acumulable: true }), directo({ id: "b", acumulable: true })]);
    assert.equal(r.descuentoTotal, 19);
    assert.equal(r.total, 81);
  });

  it("si una de las dos no es acumulable, no se suman (en cualquier orden)", () => {
    const x = ev([L("TORTA", 1, 100)], [directo({ id: "a", acumulable: true }), directo({ id: "b", acumulable: false })]);
    const y = ev([L("TORTA", 1, 100)], [directo({ id: "a", acumulable: false }), directo({ id: "b", acumulable: true })]);
    assert.equal(x.descuentoTotal, 10);
    assert.equal(y.descuentoTotal, 10);
  });

  it("una unidad ya rebajada no entra en un 2x1 posterior", () => {
    const r = ev([L("TORTA", 2, 10)], [directo({ id: "d", prioridad: 1, valor: 10 }), dos({ id: "x", prioridad: 2, objetivo: item("TORTA") })]);
    assert.equal(r.descuentoTotal, 2);
    assert.deepEqual(r.aplicadas.map((a) => a.id), ["d"]);
  });

  it("el 2x1 sigue pudiendo usar las unidades que otra promoción no tocó", () => {
    const r = ev([L("TORTA", 3, 10)], [directo({ id: "d", prioridad: 1, objetivo: cat("Nada"), valor: 10 }), dos({ id: "x", objetivo: item("TORTA") })]);
    assert.equal(r.descuentoTotal, 10);
  });
});

describe("entradas raras y propiedades", () => {
  const promos = () => [dos({ id: "x", objetivo: item("LATTE") }), P({ id: "y", tipo: "directo", objetivo: cat("Postres"), efecto: "porcentaje", valor: 15 })];

  it("ignora líneas sin precio o con cantidad inválida, sin romper las demás", () => {
    const r = ev([L("LATTE", 2, null), L("LATTE", 0, 10), L("LATTE", 1.5, 10), L("LATTE", 2, 10, null, "bien")], promos());
    assert.equal(r.totalBase, 20);
    assert.equal(r.descuentoTotal, 10);
    assert.equal(r.lineas[0].subtotalBase, 0);
  });

  it("sin promociones o sin líneas devuelve ceros", () => {
    assert.equal(ev([L("LATTE", 2, 10)], []).descuentoTotal, 0);
    const r = ev([], promos());
    assert.deepEqual([r.totalBase, r.descuentoTotal, r.total], [0, 0, 0]);
  });

  it("es determinista, no modifica sus entradas y los totales cuadran con las líneas", () => {
    const lineas = [L("LATTE", 3, 12, "Cafés"), L("TORTA", 2, 18.9, "Postres"), L("FLAN", 1, 7.3, "Postres")];
    const ps = promos();
    const copia = structuredClone({ lineas, ps });
    const a = ev(lineas, ps);
    assert.deepEqual(a, ev(lineas, ps));
    assert.deepEqual({ lineas, ps }, copia);
    const sumaLineas = Math.round(a.lineas.reduce((n, l) => n + l.descuento * 100, 0));
    assert.equal(sumaLineas, Math.round(a.descuentoTotal * 100));
    assert.equal(Math.round(a.aplicadas.reduce((n, p) => n + p.monto * 100, 0)), Math.round(a.descuentoTotal * 100));
    for (const l of a.lineas) assert.equal(Math.round(l.subtotal * 100), Math.round((l.subtotalBase - l.descuento) * 100));
    assert.equal(Math.round(a.total * 100), Math.round((a.totalBase - a.descuentoTotal) * 100));
  });

  it("nunca deja un subtotal negativo", () => {
    const r = ev([L("TORTA", 3, 1)], [P({ tipo: "directo", objetivo: item("TORTA"), efecto: "monto", valor: 999 }), dos({ objetivo: item("TORTA"), prioridad: 1 })]);
    for (const l of r.lineas) assert.ok(l.subtotal >= 0);
    assert.ok(r.total >= 0);
  });

  it("rechaza un pedido con demasiadas unidades", () => {
    assert.throws(() => ev([L("LATTE", MAX_UNIDADES + 1, 1)], promos()), (e) => e instanceof ErrorPromocion && e.codigo === "DATOS_INVALIDOS");
    assert.doesNotThrow(() => ev([L("LATTE", MAX_UNIDADES, 1)], promos()));
  });
});

describe("hora propia de cada línea (5.42)", () => {
  // Happy hour: de 18:00 a 21:00 en Lima. Jueves 20:00 = JUEVES_20H; jueves 21:30 = 02:30 UTC del viernes.
  const HAPPY = P({ tipo: "directo", objetivo: item("LATTE"), efecto: "porcentaje", valor: 50, horario: { desde: "18:00", hasta: "21:00" } });
  const T2000 = "2026-10-23T01:00:00Z";
  const T2130 = "2026-10-23T02:30:00Z";
  const con = (l, ahora) => ({ ...l, ahora });

  it("una línea pedida dentro del horario lo conserva aunque se evalúe después, fuera de horario", () => {
    const r = ev([con(L("LATTE", 1, 10, null, "a"), T2000), con(L("LATTE", 1, 10, null, "b"), T2130)], [HAPPY], new Date(T2130));
    assert.equal(desc(r, "a"), 5);
    assert.equal(desc(r, "b"), 0);
  });

  it("sin hora propia, el comportamiento no cambia: se mira la hora global", () => {
    assert.equal(ev([L("LATTE", 1, 10)], [HAPPY], new Date(T2130)).descuentoTotal, 0);
    assert.equal(ev([L("LATTE", 1, 10)], [HAPPY], new Date(T2000)).descuentoTotal, 5);
  });

  it("mezcla: una línea con hora propia y otra sin ella (esa usa la global)", () => {
    const r = ev([con(L("LATTE", 1, 10, null, "a"), T2000), L("LATTE", 1, 10, null, "b")], [HAPPY], new Date(T2130));
    assert.equal(desc(r, "a"), 5);
    assert.equal(desc(r, "b"), 0);
  });

  it("2x1: solo cuentan las unidades pedidas mientras regía", () => {
    const dosPorUno = dos({ objetivo: item("LATTE"), horario: { desde: "18:00", hasta: "21:00" } });
    const dentro = ev([con(L("LATTE", 1, 10, null, "a"), T2000), con(L("LATTE", 1, 10, null, "b"), T2000)], [dosPorUno], new Date(T2130));
    assert.equal(dentro.descuentoTotal, 10);
    const mezcla = ev([con(L("LATTE", 1, 10, null, "a"), T2000), con(L("LATTE", 1, 10, null, "b"), T2130)], [dosPorUno], new Date(T2130));
    assert.equal(mezcla.descuentoTotal, 0);
  });

  it("combo: tanto el disparador como el objetivo deben haberse pedido mientras regía", () => {
    const combo = P({ tipo: "combo", disparador: item("TORTA"), objetivo: item("LATTE"), efecto: "gratis", horario: { desde: "18:00", hasta: "21:00" } });
    const ok = ev([con(L("TORTA", 1, 8, null, "t"), T2000), con(L("LATTE", 1, 10, null, "l"), T2000)], [combo], new Date(T2130));
    assert.equal(desc(ok, "l"), 10);
    const tarde = ev([con(L("TORTA", 1, 8, null, "t"), T2000), con(L("LATTE", 1, 10, null, "l"), T2130)], [combo], new Date(T2130));
    assert.equal(tarde.descuentoTotal, 0);
    const disparadorTarde = ev([con(L("TORTA", 1, 8, null, "t"), T2130), con(L("LATTE", 1, 10, null, "l"), T2000)], [combo], new Date(T2130));
    assert.equal(disparadorTarde.descuentoTotal, 0);
  });

  it("la vigencia por fechas también se mira a la hora de la línea", () => {
    const hasta = P({ tipo: "directo", objetivo: item("LATTE"), efecto: "gratis", vigencia: { desde: null, hasta: "2026-10-22" } });
    // Jueves 22 a las 20:00 en Lima entra; al día siguiente (viernes 23) ya no
    const r = ev([con(L("LATTE", 1, 10, null, "a"), T2000), con(L("LATTE", 1, 10, null, "b"), "2026-10-24T01:00:00Z")], [hasta], new Date("2026-10-24T01:00:00Z"));
    assert.equal(desc(r, "a"), 10);
    assert.equal(desc(r, "b"), 0);
  });

  it("una promoción pausada no se aplica aunque la línea traiga su hora", () => {
    const r = ev([con(L("LATTE", 1, 10), T2000)], [{ ...HAPPY, activa: false }], new Date(T2000));
    assert.equal(r.descuentoTotal, 0);
  });

  it("una hora propia inválida se rechaza", () => {
    assert.throws(() => ev([con(L("LATTE", 1, 10), "no-es-fecha")], [HAPPY]), (e) => e instanceof ErrorPromocion && e.codigo === "DATOS_INVALIDOS");
  });
});
