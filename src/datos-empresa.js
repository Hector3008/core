import { ErrorAuth } from "./auth/errores.js";
import { marcaDe, urlLogoSegura } from "./marca.js";

// Datos de la empresa para sus comprobantes (arquitectura 5.34): razón social, identificación fiscal (RUC),
// dirección, teléfono y un pie de página. Lógica pura, sin base de datos. Son datos que la empresa escribe para
// que salgan impresos: no se verifican contra ninguna autoridad ni hacen del recibo un comprobante fiscal.

export const CAMPOS_DATOS = ["razonSocial", "idFiscal", "direccion", "telefono", "pie"];
export const LIMITES_DATOS = { razonSocial: 80, idFiscal: 20, direccion: 120, telefono: 30, pie: 120 };
const ETIQUETAS = {
  razonSocial: "razonSocial: el nombre legal de la empresa",
  idFiscal: "idFiscal: el RUC o la identificación fiscal (letras, números, punto, guion o barra)",
  direccion: "direccion: la dirección del local",
  telefono: "telefono: números, espacios y + - ( )",
  pie: "pie: una línea al final del recibo",
};

const malo = (m) => new ErrorAuth("DATOS_INVALIDOS", m);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function normalizar(campo, valor) {
  if (typeof valor !== "string") throw malo(ETIQUETAS[campo]);
  const t = valor.trim().replace(/\s+/g, " ");
  if (CONTROL.test(t) || t.length > LIMITES_DATOS[campo]) throw malo(`${campo}: hasta ${LIMITES_DATOS[campo]} caracteres y sin caracteres de control`);
  if (campo === "idFiscal" && (t.length < 5 || !/^[A-Za-z0-9][A-Za-z0-9./-]*$/.test(t))) throw malo(ETIQUETAS.idFiscal + ", de 5 a 20 caracteres");
  if (campo === "telefono" && !/^[0-9+][0-9 ()+-]*$/.test(t)) throw malo(ETIQUETAS.telefono);
  return campo === "idFiscal" ? t.toUpperCase() : t;
}

/** Los datos guardados, con todos los campos (los vacíos o mal guardados en null). */
export function datosDe(empresa) {
  const d = empresa?.datos ?? {};
  return Object.fromEntries(
    CAMPOS_DATOS.map((c) => {
      if (typeof d[c] !== "string" || !d[c]) return [c, null];
      try {
        return [c, normalizar(c, d[c])];
      } catch {
        return [c, null]; // un valor guardado a mano y mal formado se ignora
      }
    }),
  );
}

/**
 * Valida los cambios pedidos (parciales) sobre los datos `actual`. Un campo en `null` o vacío se quita.
 * Devuelve los datos completos resultantes; lanza ErrorAuth si algo es inválido.
 */
export function validarDatos(entrada, actual = datosDe(null)) {
  if (!entrada || typeof entrada !== "object" || Array.isArray(entrada)) throw malo("se esperaba un objeto con los cambios de los datos");
  const extra = Object.keys(entrada).filter((k) => !CAMPOS_DATOS.includes(k));
  if (extra.length) throw malo(`campos no admitidos (${extra.join(", ")})`);
  if (!Object.keys(entrada).length) throw malo("no hay nada que cambiar");
  const nuevos = { ...datosDe({ datos: actual }) };
  for (const [k, v] of Object.entries(entrada)) nuevos[k] = v === null || (typeof v === "string" && !v.trim()) ? null : normalizar(k, v);
  return nuevos;
}

/**
 * Lo que sale en el encabezado de un recibo o una cuenta: nombre, datos y logo de la empresa en este momento.
 * Nunca lanza error. La etiqueta de la identificación fiscal ("RUC" o "ID fiscal") depende del país de la empresa.
 */
export function emisorDe(empresa) {
  const d = datosDe(empresa);
  const logo = marcaDe(empresa).logo;
  const pais = typeof empresa?.pais === "string" && empresa.pais ? empresa.pais.toUpperCase() : "PE";
  return {
    nombre: typeof empresa?.nombre === "string" ? empresa.nombre : "",
    razonSocial: d.razonSocial,
    idFiscal: d.idFiscal,
    etiquetaIdFiscal: pais === "PE" ? "RUC" : "ID fiscal",
    direccion: d.direccion,
    telefono: d.telefono,
    pie: d.pie,
    logo: logo ? urlLogoSegura(logo) : null,
  };
}
