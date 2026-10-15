import { ErrorFidelizacion } from "./errores.js";

// Reglas de puntos de una empresa. Viven en `Empresa.fidelizacion`; las empresas anteriores al campo
// (o sin tocarlo) usan estos valores. Los puntos se ganan de todos modos solo con consentimiento del cliente.
export const CONFIG_POR_DEFECTO = Object.freeze({ habilitada: true, puntosPorUnidad: 1 });
export const MAX_PUNTOS_POR_UNIDAD = 1000;

const malo = (m) => new ErrorFidelizacion("DATOS_INVALIDOS", m);

/** La configuración efectiva: lo guardado en la empresa sobre los valores por defecto. */
export function configDe(empresa) {
  const g = empresa?.fidelizacion ?? {};
  return {
    habilitada: typeof g.habilitada === "boolean" ? g.habilitada : CONFIG_POR_DEFECTO.habilitada,
    puntosPorUnidad:
      typeof g.puntosPorUnidad === "number" && g.puntosPorUnidad > 0 ? g.puntosPorUnidad : CONFIG_POR_DEFECTO.puntosPorUnidad,
  };
}

/** Valida un cambio parcial de configuración; devuelve solo lo que cambia. */
export function validarConfig(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) throw malo("la configuración debe ser un objeto");
  const extra = Object.keys(c).filter((k) => !["habilitada", "puntosPorUnidad"].includes(k));
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
