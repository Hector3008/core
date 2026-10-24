import { ErrorFidelizacion } from "./errores.js";
import { validarNiveles } from "./logros.js";

// Reglas de puntos de una empresa. Viven en `Empresa.fidelizacion`; las empresas anteriores al campo
// (o sin tocarlo) usan estos valores. Los puntos se ganan de todos modos solo con consentimiento del cliente.
export const CONFIG_POR_DEFECTO = Object.freeze({ habilitada: true, puntosPorUnidad: 1, niveles: Object.freeze([]) });
export const MAX_PUNTOS_POR_UNIDAD = 1000;

// Referidos (5.45): premio en puntos por traer amigos. Apagado hasta que la empresa lo active.
export const REFERIDOS_POR_DEFECTO = Object.freeze({
  habilitada: false,
  puntosReferente: 50, // para quien refiere
  puntosReferido: 25, // para el amigo referido
  consumoMinimo: 0, // monto mínimo del primer consumo pagado para que el premio se dé (0 = ninguno)
  maxPorCliente: 20, // referidos premiados por cliente (tope)
  cuentaParaNiveles: true, // los puntos `bono` suman al acumulado de niveles e insignias de puntos
});
const CAMPOS_REFERIDOS = Object.keys(REFERIDOS_POR_DEFECTO);

const malo = (m) => new ErrorFidelizacion("DATOS_INVALIDOS", m);

/** La configuración efectiva: lo guardado en la empresa sobre los valores por defecto. */
export function configDe(empresa) {
  const g = empresa?.fidelizacion ?? {};
  return {
    habilitada: typeof g.habilitada === "boolean" ? g.habilitada : CONFIG_POR_DEFECTO.habilitada,
    puntosPorUnidad:
      typeof g.puntosPorUnidad === "number" && g.puntosPorUnidad > 0 ? g.puntosPorUnidad : CONFIG_POR_DEFECTO.puntosPorUnidad,
    // Niveles por puntos acumulados (5.30): una lista de { nombre, desde } de menor a mayor. Vacía = no usa niveles.
    niveles: Array.isArray(g.niveles) ? g.niveles.map((n) => ({ nombre: n.nombre, desde: n.desde })) : [],
    referidos: referidosDe(g.referidos),
  };
}

/** La configuración efectiva de referidos: lo guardado sobre los valores por defecto. */
export function referidosDe(r) {
  const x = r ?? {};
  const d = REFERIDOS_POR_DEFECTO;
  const num = (v, def) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : def);
  return {
    habilitada: typeof x.habilitada === "boolean" ? x.habilitada : d.habilitada,
    puntosReferente: Number.isInteger(x.puntosReferente) && x.puntosReferente >= 0 ? x.puntosReferente : d.puntosReferente,
    puntosReferido: Number.isInteger(x.puntosReferido) && x.puntosReferido >= 0 ? x.puntosReferido : d.puntosReferido,
    consumoMinimo: num(x.consumoMinimo, d.consumoMinimo),
    maxPorCliente: Number.isInteger(x.maxPorCliente) && x.maxPorCliente >= 1 ? x.maxPorCliente : d.maxPorCliente,
    cuentaParaNiveles: typeof x.cuentaParaNiveles === "boolean" ? x.cuentaParaNiveles : d.cuentaParaNiveles,
  };
}

/** Valida un cambio parcial de referidos; devuelve solo los campos que cambian. */
export function validarReferidos(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) throw malo("referidos debe ser un objeto");
  const extra = Object.keys(r).filter((k) => !CAMPOS_REFERIDOS.includes(k));
  if (extra.length) throw malo(`referidos: campos no admitidos (${extra.join(", ")})`);
  const c = {};
  for (const k of ["habilitada", "cuentaParaNiveles"]) {
    if (r[k] === undefined) continue;
    if (typeof r[k] !== "boolean") throw malo(`referidos.${k} debe ser true o false`);
    c[k] = r[k];
  }
  for (const k of ["puntosReferente", "puntosReferido"]) {
    if (r[k] === undefined) continue;
    if (!Number.isInteger(r[k]) || r[k] < 0 || r[k] > 1_000_000) throw malo(`referidos.${k}: un entero de 0 a 1.000.000`);
    c[k] = r[k];
  }
  if (r.consumoMinimo !== undefined) {
    const v = r.consumoMinimo;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1_000_000 || Math.abs(Math.round(v * 100) / 100 - v) > 1e-9)
      throw malo("referidos.consumoMinimo: un monto de 0 a 1.000.000 (hasta 2 decimales)");
    c.consumoMinimo = v;
  }
  if (r.maxPorCliente !== undefined) {
    if (!Number.isInteger(r.maxPorCliente) || r.maxPorCliente < 1 || r.maxPorCliente > 10_000)
      throw malo("referidos.maxPorCliente: un entero de 1 a 10.000");
    c.maxPorCliente = r.maxPorCliente;
  }
  if (!Object.keys(c).length) throw malo("referidos: no hay nada que cambiar");
  return c;
}

/** Valida un cambio parcial de configuración; devuelve solo lo que cambia. */
export function validarConfig(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) throw malo("la configuración debe ser un objeto");
  const extra = Object.keys(c).filter((k) => !["habilitada", "puntosPorUnidad", "niveles", "referidos"].includes(k));
  if (extra.length) throw malo(`campos no admitidos (${extra.join(", ")})`);
  const cambio = {};
  if (c.habilitada !== undefined) {
    if (typeof c.habilitada !== "boolean") throw malo("habilitada debe ser true o false");
    cambio.habilitada = c.habilitada;
  }
  if (c.puntosPorUnidad !== undefined) {
    const v = c.puntosPorUnidad;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > MAX_PUNTOS_POR_UNIDAD)
      throw malo(`puntosPorUnidad: un número mayor que 0 y de hasta ${MAX_PUNTOS_POR_UNIDAD}`);
    cambio.puntosPorUnidad = v;
  }
  if (c.niveles !== undefined) cambio.niveles = validarNiveles(c.niveles);
  if (c.referidos !== undefined) cambio.referidos = validarReferidos(c.referidos);
  if (!Object.keys(cambio).length) throw malo("no hay nada que cambiar");
  return cambio;
}

/**
 * Puntos que gana un monto: `puntosPorUnidad` por cada unidad de la moneda, redondeado hacia abajo.
 * El cálculo va en centavos enteros para no arrastrar errores de coma flotante.
 */
export function calcularPuntos(monto, puntosPorUnidad) {
  if (typeof monto !== "number" || !Number.isFinite(monto) || monto <= 0) return 0;
  return Math.floor((Math.round(monto * 100) * puntosPorUnidad) / 100 + 1e-9);
}

export function validarPuntos(p, nombre = "puntos") {
  if (!Number.isInteger(p) || p < 1 || p > 1_000_000) throw malo(`${nombre}: un entero de 1 a 1.000.000`);
  return p;
}

export function validarDetalle(d, { obligatorio = false } = {}) {
  if (d === undefined || d === null || d === "") {
    if (obligatorio) throw malo("detalle requerido");
    return null;
  }
  if (typeof d !== "string" || d.trim().length > 200) throw malo("detalle: texto de hasta 200 caracteres");
  return d.trim() || null;
}
