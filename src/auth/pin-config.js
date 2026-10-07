import { ErrorAuth } from "./errores.js";

// Opciones del acceso por PIN que cada empresa puede ajustar (Empresa.seguridad.pin).
export const PIN_POR_DEFECTO = {
  habilitado: false, // se activa a propósito: una empresa sin tablets no necesita PIN
  largoMin: 4,
  largoMax: 6,
  maxIntentos: 5, // fallos seguidos antes de bloquear a esa persona
  bloqueoMin: 15, // minutos de bloqueo
  inactividadMin: 10, // minutos sin usar la tablet antes de cerrar la sesión de PIN
  sesionMaxHoras: 12, // vida máxima de una sesión de PIN
  codigoVigenciaMin: 10, // cuánto dura un código de emparejamiento
};

// [mínimo, máximo] permitidos. El PIN siempre es de 4 a 6 dígitos.
export const LIMITES_PIN = {
  largoMin: [4, 6],
  largoMax: [4, 6],
  maxIntentos: [3, 10],
  bloqueoMin: [1, 1440],
  inactividadMin: [1, 120],
  sesionMaxHoras: [1, 24],
  codigoVigenciaMin: [1, 60],
};

/** Configuración efectiva: lo guardado en la empresa sobre los valores por defecto. */
export function configPinDe(empresa) {
  const guardada = empresa?.seguridad?.pin ?? {};
  const limpia = Object.fromEntries(
    Object.entries(guardada).filter(([k, v]) => k in PIN_POR_DEFECTO && v !== null && v !== undefined),
  );
  return { ...PIN_POR_DEFECTO, ...limpia };
}

/** Valida los cambios pedidos (parciales) y devuelve solo los que se van a guardar. */
export function validarConfigPin(entrada, actual = PIN_POR_DEFECTO) {
  if (!entrada || typeof entrada !== "object" || Array.isArray(entrada))
    throw new ErrorAuth("DATOS_INVALIDOS", "se esperaba un objeto con las opciones del PIN");
  const nueva = {};
  for (const [k, v] of Object.entries(entrada)) {
    if (k === "habilitado") {
      if (typeof v !== "boolean") throw new ErrorAuth("DATOS_INVALIDOS", "habilitado debe ser verdadero o falso");
      nueva[k] = v;
      continue;
    }
    const lim = LIMITES_PIN[k];
    if (!lim) throw new ErrorAuth("DATOS_INVALIDOS", `opción desconocida: ${k}`);
    if (!Number.isInteger(v) || v < lim[0] || v > lim[1])
      throw new ErrorAuth("DATOS_INVALIDOS", `${k} debe ser un entero entre ${lim[0]} y ${lim[1]}`);
    nueva[k] = v;
  }
  const final = { ...actual, ...nueva };
  if (final.largoMin > final.largoMax)
    throw new ErrorAuth("DATOS_INVALIDOS", "largoMin no puede ser mayor que largoMax");
  return nueva;
}
