import { ErrorCliente } from "./errores.js";
import { prepararDatos } from "./validacion.js";

export const MAX_FILAS_IMPORTACION = 500;
export const MAX_ERRORES_IMPORTACION = 50;
// Lo único que una importación puede cargar. Las preferencias y los consentimientos NO se importan:
// un consentimiento se otorga con la persona delante (o por su propio medio), nunca desde una hoja.
const CAMPOS = ["nombre", "telefono", "paisTelefono", "correo", "redes", "identificacion", "direccion"];

const vacio = (v) => v === undefined || v === null || (typeof v === "string" && !v.trim());

/** Quita lo que viene vacío (una celda en blanco no borra nada) y todo lo que no sea un campo de la ficha. */
export function limpiarFila(f) {
  if (!f || typeof f !== "object" || Array.isArray(f)) throw new ErrorCliente("DATOS_INVALIDOS", "la fila debe ser un objeto");
  const s = {};
  for (const k of CAMPOS) {
    const v = f[k];
    if (k === "redes" || k === "identificacion") {
      if (v === undefined || v === null) continue;
      if (typeof v !== "object" || Array.isArray(v)) throw new ErrorCliente("DATOS_INVALIDOS", `${k} debe ser un objeto`);
      const o = Object.fromEntries(Object.entries(v).filter(([, x]) => !vacio(x)));
      if (Object.keys(o).length) s[k] = o;
    } else if (!vacio(v)) s[k] = v;
  }
  return s;
}

/**
 * Valida todas las filas y las cruza con los clientes que ya existen (por teléfono o por correo).
 * Función pura: `existentes` son las fichas de la empresa cuyo teléfono o correo aparece en el lote
 * (ver `claves`). Devuelve `{ plan, errores }`; el plan solo vale si `errores` está vacío.
 *  - Una fila exige teléfono o correo (con eso se reconoce a la persona en la próxima carga) y, si es nueva, nombre.
 *  - Si el teléfono de la fila es de un cliente y su correo de otro, es un conflicto: no se adivina.
 *  - Un teléfono o un correo repetido dentro del mismo archivo se rechaza.
 */
export function planificar(filas, { paisEmpresa, existentes = [] }) {
  const errores = [];
  const falla = (fila, e) => errores.push({ fila, error: e.message ?? String(e) });
  const porTel = new Map(existentes.filter((c) => c.telefono).map((c) => [c.telefono, c]));
  const porCorreo = new Map(existentes.filter((c) => c.correo).map((c) => [c.correo, c]));
  const vistos = { telefono: new Map(), correo: new Map() };
  const plan = [];
  filas.forEach((f, idx) => {
    const fila = idx + 1;
    try {
      const d = prepararDatos(limpiarFila(f), { crear: false, paisEmpresa });
      if (typeof d.telefono !== "string" && typeof d.correo !== "string")
        throw new ErrorCliente("DATOS_INVALIDOS", "falta el teléfono o el correo (con eso se reconoce al cliente)");
      for (const campo of ["telefono", "correo"]) {
        if (typeof d[campo] !== "string") continue;
        if (vistos[campo].has(d[campo])) throw new ErrorCliente("DATOS_INVALIDOS", `${campo} repetido (también en la fila ${vistos[campo].get(d[campo])})`);
        vistos[campo].set(d[campo], fila);
      }
      const a = typeof d.telefono === "string" ? porTel.get(d.telefono) : undefined;
      const b = typeof d.correo === "string" ? porCorreo.get(d.correo) : undefined;
      if (a && b && String(a._id) !== String(b._id))
        throw new ErrorCliente("DATOS_INVALIDOS", "el teléfono es de un cliente y el correo de otro: corrige la fila o fusiónalos a mano");
      const previo = a ?? b ?? null;
      if (!previo && d.nombre === undefined) throw new ErrorCliente("DATOS_INVALIDOS", "cliente nuevo: falta el nombre");
      plan.push({ fila, d, previo });
    } catch (e) {
      if (!(e instanceof ErrorCliente)) throw e;
      falla(fila, e);
    }
  });
  return { plan, errores };
}

/** Teléfonos y correos que hay que buscar en la base para este lote, ya normalizados (sin las filas inválidas). */
export function clavesDe(filas, paisEmpresa) {
  const telefonos = [];
  const correos = [];
  for (const f of filas) {
    try {
      const d = prepararDatos(limpiarFila(f), { crear: false, paisEmpresa });
      if (typeof d.telefono === "string") telefonos.push(d.telefono);
      if (typeof d.correo === "string") correos.push(d.correo);
    } catch {
      /* la fila inválida se reporta al planificar */
    }
  }
  return { telefonos, correos };
}
