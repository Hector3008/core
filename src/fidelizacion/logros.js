import { ErrorFidelizacion } from "./errores.js";

// Niveles e insignias (arquitectura 5.30, etapa 2). Lógica pura: se calcula siempre desde el libro de puntos, sin
// guardar nada aparte. Así no hay nada que sincronizar ni que se pueda desfasar: si el libro cambia, los logros también.
//
// «Puntos acumulados» = la suma de los movimientos `acumulo` (lo ganado por consumir). No bajan al canjear, y los
// ajustes manuales y las devoluciones de un vale cancelado no cuentan: un nivel se gana consumiendo.

export const MAX_NIVELES = 10;
const DIA_MS = 86_400_000;
const malo = (m) => new ErrorFidelizacion("DATOS_INVALIDOS", m);

/** Valida la lista de niveles de una empresa: hasta 10, con nombre y puntos de entrada estrictamente crecientes. */
export function validarNiveles(niveles) {
  if (!Array.isArray(niveles)) throw malo("niveles debe ser una lista");
  if (niveles.length > MAX_NIVELES) throw malo(`niveles: hasta ${MAX_NIVELES}`);
  const limpios = niveles.map((n, i) => {
    if (!n || typeof n !== "object" || Array.isArray(n)) throw malo(`niveles[${i}]: debe ser un objeto`);
    const extra = Object.keys(n).filter((k) => !["nombre", "desde"].includes(k));
    if (extra.length) throw malo(`niveles[${i}]: campos no admitidos (${extra.join(", ")})`);
    const nombre = typeof n.nombre === "string" ? n.nombre.trim() : "";
    if (!nombre || nombre.length > 40) throw malo(`niveles[${i}].nombre: texto de 1 a 40 caracteres`);
    if (!Number.isInteger(n.desde) || n.desde < 0 || n.desde > 10_000_000) throw malo(`niveles[${i}].desde: un entero de 0 a 10.000.000`);
    return { nombre, desde: n.desde };
  });
  for (let i = 1; i < limpios.length; i++)
    if (limpios[i].desde <= limpios[i - 1].desde) throw malo("niveles: los puntos de entrada deben ir de menor a mayor, sin repetirse");
  return limpios;
}

/**
 * En qué nivel está quien lleva `acumulado` puntos. `niveles` ya ordenados de menor a mayor.
 * Devuelve { actual, siguiente, faltan, progreso }: `actual` y `siguiente` son { nombre, desde } o null (sin nivel
 * todavía / ya en el más alto); `faltan` los puntos que le faltan para el siguiente; `progreso` (0 a 1) lo avanzado
 * dentro del tramo actual. Sin niveles configurados devuelve null: la empresa no usa niveles.
 */
export function nivelDe(niveles, acumulado) {
  if (!Array.isArray(niveles) || !niveles.length) return null;
  const pts = Math.max(0, Number(acumulado) || 0);
  let actual = null;
  for (const n of niveles) if (pts >= n.desde) actual = n;
  const siguiente = niveles.find((n) => n.desde > pts) ?? null;
  const base = actual?.desde ?? 0;
  const progreso = siguiente ? Math.min(1, Math.max(0, (pts - base) / (siguiente.desde - base))) : 1;
  return {
    actual: actual ? { nombre: actual.nombre, desde: actual.desde } : null,
    siguiente: siguiente ? { nombre: siguiente.nombre, desde: siguiente.desde } : null,
    faltan: siguiente ? siguiente.desde - pts : 0,
    progreso: Math.round(progreso * 1000) / 1000,
  };
}

// Catálogo fijo de insignias (hitos). Cada una dice cómo se mide: `puntos` (acumulados), `consumos` (movimientos de
// acumulación: uno por cada ítem pagado), `canjes` (vales o canjes hechos) o `dias` (desde el primer consumo).
export const INSIGNIAS = Object.freeze([
  { id: "primera_vez", nombre: "Primera vez", descripcion: "Tu primer consumo con puntos", medida: "consumos", meta: 1 },
  { id: "consumos_10", nombre: "De confianza", descripcion: "10 consumos con puntos", medida: "consumos", meta: 10 },
  { id: "consumos_25", nombre: "De la casa", descripcion: "25 consumos con puntos", medida: "consumos", meta: 25 },
  { id: "puntos_100", nombre: "100 puntos", descripcion: "Acumulaste 100 puntos", medida: "puntos", meta: 100 },
  { id: "puntos_500", nombre: "500 puntos", descripcion: "Acumulaste 500 puntos", medida: "puntos", meta: 500 },
  { id: "puntos_1000", nombre: "1.000 puntos", descripcion: "Acumulaste 1.000 puntos", medida: "puntos", meta: 1000 },
  { id: "puntos_5000", nombre: "5.000 puntos", descripcion: "Acumulaste 5.000 puntos", medida: "puntos", meta: 5000 },
  { id: "primer_canje", nombre: "Primer canje", descripcion: "Canjeaste tus puntos por primera vez", medida: "canjes", meta: 1 },
  { id: "antiguedad_180", nombre: "6 meses contigo", descripcion: "Medio año desde tu primer consumo", medida: "dias", meta: 180 },
]);

/**
 * Los logros de un cliente a partir de su libro. `movimientos`: { tipo, puntos, ts } en cualquier orden.
 * Devuelve { acumulado, consumos, canjes, nivel, insignias }. Cada insignia trae `obtenida` y, si la tiene,
 * `obtenidaTs` (el momento en que se cumplió, no cuándo se miró); si no, `actual` y `meta` para mostrar el avance.
 */
export function calcularLogros({ movimientos, niveles = [], ahora = new Date() }) {
  const lista = (Array.isArray(movimientos) ? movimientos : [])
    .map((m) => ({ tipo: m.tipo, puntos: m.puntos, ts: new Date(m.ts) }))
    .filter((m) => !Number.isNaN(m.ts.getTime()))
    .sort((a, b) => a.ts - b.ts);

  const consumos = lista.filter((m) => m.tipo === "acumulo");
  const canjes = lista.filter((m) => m.tipo === "canje");
  const acumulado = consumos.reduce((n, m) => n + m.puntos, 0);

  // El momento en que el acumulado (o la cuenta de consumos) llegó a la meta.
  const cuando = (lista, meta, valor) => {
    let corrido = 0;
    for (const m of lista) {
      corrido += valor(m);
      if (corrido >= meta) return m.ts;
    }
    return null;
  };
  const primerConsumo = consumos[0]?.ts ?? null;

  const insignias = INSIGNIAS.map((def) => {
    let actual;
    let ts = null;
    if (def.medida === "puntos") {
      actual = acumulado;
      ts = cuando(consumos, def.meta, (m) => m.puntos);
    } else if (def.medida === "consumos") {
      actual = consumos.length;
      ts = cuando(consumos, def.meta, () => 1);
    } else if (def.medida === "canjes") {
      actual = canjes.length;
      ts = cuando(canjes, def.meta, () => 1);
    } else {
      actual = primerConsumo ? Math.max(0, Math.floor((ahora - primerConsumo) / DIA_MS)) : 0;
      ts = primerConsumo && actual >= def.meta ? new Date(primerConsumo.getTime() + def.meta * DIA_MS) : null;
    }
    const obtenida = ts !== null;
    return {
      id: def.id,
      nombre: def.nombre,
      descripcion: def.descripcion,
      obtenida,
      obtenidaTs: obtenida ? ts : null,
      actual: Math.min(actual, def.meta),
      meta: def.meta,
    };
  });

  return { acumulado, consumos: consumos.length, canjes: canjes.length, nivel: nivelDe(niveles, acumulado), insignias };
}
