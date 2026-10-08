import { parsePhoneNumberFromString, isSupportedCountry } from "libphonenumber-js/max";

// País que se asume si la empresa no tiene uno fijado (empresas creadas antes de existir el campo).
export const PAIS_POR_DEFECTO = "PE";

const FORMATO = /^[0-9+()\-. ]{6,30}$/;

/** Código de país ISO de 2 letras ("PE", "AR"...). Lanza Error si no existe en la librería. */
export function normalizarPais(pais) {
  const p = typeof pais === "string" ? pais.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(p) || !isSupportedCountry(p))
    throw new Error(`país inválido: ${String(pais).slice(0, 10)} (usa el código de 2 letras, por ejemplo PE o AR)`);
  return p;
}

/**
 * Normaliza un teléfono a formato internacional E.164 (+51987654321).
 *  - Con "+" (o "00") delante, el país sale del propio número.
 *  - Sin él, se interpreta como número nacional del `paisPorDefecto` (el de la empresa).
 * Devuelve `{ telefono, pais }` o lanza Error con un mensaje claro.
 */
export function normalizarTelefono(valor, paisPorDefecto = PAIS_POR_DEFECTO) {
  if (typeof valor !== "string" || !FORMATO.test(valor.trim()))
    throw new Error("teléfono inválido");
  const pais = normalizarPais(paisPorDefecto);
  const n = parsePhoneNumberFromString(valor.trim(), pais);
  if (!n || !n.isValid())
    throw new Error(
      `teléfono inválido para ${pais}: si es de otro país escríbelo con su código (por ejemplo +54...)`,
    );
  return { telefono: n.number, pais: n.country ?? null };
}
