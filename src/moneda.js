// Moneda en la que una empresa maneja los precios de su catálogo.
// Código ISO 4217 de 3 letras ("PEN", "ARS", "USD"...). Las empresas anteriores al campo asumen PEN.
export const MONEDA_POR_DEFECTO = "PEN";

const SOPORTADAS = new Set(Intl.supportedValuesOf("currency"));

/** "pen" → "PEN". Lanza Error si no es una moneda ISO conocida. */
export function normalizarMoneda(moneda) {
  const m = typeof moneda === "string" ? moneda.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(m) || !SOPORTADAS.has(m))
    throw new Error(
      `moneda inválida: ${String(moneda).slice(0, 10)} (usa el código de 3 letras, por ejemplo PEN, ARS o USD)`,
    );
  return m;
}
