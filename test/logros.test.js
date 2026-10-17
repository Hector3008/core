import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calcularLogros, INSIGNIAS, nivelDe, validarNiveles } from "../src/fidelizacion/logros.js";
import { configDe, validarConfig } from "../src/fidelizacion/config.js";
import { ErrorFidelizacion } from "../src/fidelizacion/errores.js";

const rechaza = (fn) => assert.throws(fn, (e) => e instanceof ErrorFidelizacion && e.codigo === "DATOS_INVALIDOS");
const NIVELES = [{ nombre: "Bronce", desde: 0 }, { nombre: "Plata", desde: 500 }, { nombre: "Oro", desde: 2000 }];

describe("validarNiveles", () => {
  it("normaliza y acepta una lista vacía", () => {
    assert.deepEqual(validarNiveles([]), []);
    assert.deepEqual(validarNiveles([{ nombre: " Plata ", desde: 500 }]), [{ nombre: "Plata", desde: 500 }]);
  });
  it("rechaza desorden, repetidos, datos malos y más de 10", () => {
    rechaza(() => validarNiveles([{ nombre: "A", desde: 5 }, { nombre: "B", desde: 5 }]));
    rechaza(() => validarNiveles([{ nombre: "A", desde: 10 }, { nombre: "B", desde: 5 }]));
    rechaza(() => validarNiveles([{ nombre: "", desde: 1 }]));
    rechaza(() => validarNiveles([{ nombre: "x".repeat(41), desde: 1 }]));
    rechaza(() => validarNiveles([{ nombre: "A", desde: -1 }]));
    rechaza(() => validarNiveles([{ nombre: "A", desde: 1.5 }]));
    rechaza(() => validarNiveles([{ nombre: "A", desde: 1, extra: 1 }]));
    rechaza(() => validarNiveles("no"));
    rechaza(() => validarNiveles(Array.from({ length: 11 }, (_, i) => ({ nombre: `N${i}`, desde: i }))));
  });
  it("va por la configuración de la empresa", () => {
    assert.deepEqual(validarConfig({ niveles: [{ nombre: "Plata", desde: 500 }] }), { niveles: [{ nombre: "Plata", desde: 500 }] });
    rechaza(() => validarConfig({ niveles: [{ nombre: "A", desde: 9 }, { nombre: "B", desde: 1 }] }));
    assert.deepEqual(configDe({ fidelizacion: { niveles: [{ nombre: "Plata", desde: 500, _id: "x" }] } }).niveles, [{ nombre: "Plata", desde: 500 }]);
  });
});

describe("nivelDe", () => {
  it("sin niveles configurados no hay nivel", () => {
    assert.equal(nivelDe([], 100), null);
    assert.equal(nivelDe(undefined, 100), null);
  });
  it("el nivel actual, el siguiente y lo que falta", () => {
    const r = nivelDe(NIVELES, 600);
    assert.equal(r.actual.nombre, "Plata");
    assert.equal(r.siguiente.nombre, "Oro");
    assert.equal(r.faltan, 1400);
    assert.equal(r.progreso, 0.067); // (600-500)/(2000-500)
  });
  it("justo en el borde sube de nivel; en el más alto no hay siguiente", () => {
    assert.equal(nivelDe(NIVELES, 500).actual.nombre, "Plata");
    assert.equal(nivelDe(NIVELES, 499).actual.nombre, "Bronce");
    const o = nivelDe(NIVELES, 5000);
    assert.deepEqual([o.actual.nombre, o.siguiente, o.faltan, o.progreso], ["Oro", null, 0, 1]);
  });
  it("antes del primer nivel no tiene ninguno y avanza hacia él", () => {
    const r = nivelDe([{ nombre: "Plata", desde: 500 }], 100);
    assert.deepEqual([r.actual, r.siguiente.nombre, r.faltan, r.progreso], [null, "Plata", 400, 0.2]);
  });
});

describe("calcularLogros", () => {
  const ahora = new Date("2026-10-17T12:00:00Z");
  const acu = (puntos, dia) => ({ tipo: "acumulo", puntos, ts: `2026-0${dia[0]}-${dia.slice(1)}T10:00:00Z` });
  const por = (r, id) => r.insignias.find((i) => i.id === id);

  it("un cliente sin movimientos no tiene nada, pero ve su avance", () => {
    const r = calcularLogros({ movimientos: [], niveles: NIVELES, ahora });
    assert.equal(r.acumulado, 0);
    assert.equal(r.nivel.actual.nombre, "Bronce");
    assert.equal(r.insignias.length, INSIGNIAS.length);
    assert.ok(r.insignias.every((i) => !i.obtenida && i.obtenidaTs === null && i.actual === 0));
  });

  it("el acumulado solo cuenta lo ganado consumiendo: ni canjes, ni ajustes, ni devoluciones", () => {
    const r = calcularLogros({
      movimientos: [acu(300, "801"), { tipo: "canje", puntos: -100, ts: "2026-08-05T10:00:00Z" }, { tipo: "ajuste", puntos: 100, ts: "2026-08-06T10:00:00Z" }, { tipo: "ajuste", puntos: 5000, ts: "2026-08-07T10:00:00Z" }],
      ahora,
    });
    assert.equal(r.acumulado, 300);
    assert.equal(r.canjes, 1);
    assert.equal(por(r, "puntos_100").obtenida, true);
    assert.equal(por(r, "puntos_500").obtenida, false);
    assert.equal(por(r, "puntos_5000").obtenida, false);
  });

  it("canjear no baja el nivel", () => {
    const r = calcularLogros({ movimientos: [acu(600, "801"), { tipo: "canje", puntos: -550, ts: "2026-08-02T10:00:00Z" }], niveles: NIVELES, ahora });
    assert.equal(r.nivel.actual.nombre, "Plata");
  });

  it("la insignia lleva el momento en que se cumplió, no el de hoy, aunque lleguen desordenados", () => {
    const r = calcularLogros({ movimientos: [acu(300, "815"), acu(250, "801"), acu(100, "901")], ahora });
    assert.equal(por(r, "puntos_100").obtenidaTs.toISOString(), "2026-08-01T10:00:00.000Z");
    assert.equal(por(r, "puntos_500").obtenidaTs.toISOString(), "2026-08-15T10:00:00.000Z"); // 250 + 300 = 550 ese día
    assert.equal(por(r, "puntos_1000").obtenida, false);
    assert.deepEqual([por(r, "puntos_1000").actual, por(r, "puntos_1000").meta], [650, 1000]);
  });

  it("consumos: uno por cada movimiento de acumulación", () => {
    const mov = Array.from({ length: 10 }, (_, i) => ({ tipo: "acumulo", puntos: 1, ts: new Date(Date.UTC(2026, 8, i + 1)) }));
    const r = calcularLogros({ movimientos: mov, ahora });
    assert.equal(r.consumos, 10);
    assert.equal(por(r, "primera_vez").obtenida, true);
    assert.equal(por(r, "consumos_10").obtenidaTs.toISOString(), "2026-09-10T00:00:00.000Z");
    assert.equal(por(r, "consumos_25").obtenida, false);
    assert.equal(por(r, "consumos_25").actual, 10);
  });

  it("primer canje y antigüedad desde el primer consumo", () => {
    const r = calcularLogros({ movimientos: [acu(10, "301"), { tipo: "canje", puntos: -5, ts: "2026-04-01T00:00:00Z" }], ahora });
    assert.equal(por(r, "primer_canje").obtenidaTs.toISOString(), "2026-04-01T00:00:00.000Z");
    assert.equal(por(r, "antiguedad_180").obtenida, true);
    assert.equal(por(r, "antiguedad_180").obtenidaTs.toISOString(), "2026-08-28T10:00:00.000Z"); // 1 mar + 180 días
    const reciente = calcularLogros({ movimientos: [{ tipo: "acumulo", puntos: 10, ts: "2026-10-01T10:00:00Z" }], ahora });
    assert.equal(por(reciente, "antiguedad_180").obtenida, false);
    assert.equal(por(reciente, "antiguedad_180").actual, 16);
  });

  it("ignora movimientos con fecha inválida y no se rompe con basura", () => {
    const r = calcularLogros({ movimientos: [{ tipo: "acumulo", puntos: 50, ts: "nada" }, acu(40, "801")], ahora });
    assert.equal(r.acumulado, 40);
    assert.equal(calcularLogros({ movimientos: undefined, ahora }).acumulado, 0);
  });
});
