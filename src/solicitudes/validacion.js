import { normalizarPais, normalizarTelefono } from "../telefono.js";
import { normalizarMoneda } from "../moneda.js";
import { PLANTILLAS } from "../modelos/plantillas.js";
import { ErrorSolicitud } from "./errores.js";

const CORREO = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,200}\.[^\s@<>"']{2,}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;
const CODIGO_SERVICIO = /^[a-z][a-z0-9_]{1,29}$/;
const sinControl = (s) => /[\u0000-\u001f\u007f]/.test(s);

// El slug sale en direcciones públicas (`/tobt/catalogo/<slug>`) y comparte espacio con las rutas de la plataforma.
export const SLUGS_RESERVADOS = new Set([
  "admin", "api", "auth", "cuenta", "tobt", "prueba", "legal", "terminos", "privacidad", "servidor", "crear-empresa",
  "solicitud", "acceso", "catalogo", "clientes", "empleados", "publico", "resenas", "promociones", "anuncios", "iconos",
  "favicon", "static", "assets", "www", "ilnapo", "operador", "soporte", "ayuda", "info", "test", "demo",
]);
export const MAX_SERVICIOS = 5;

/** Texto de una línea: sin saltos ni caracteres de control, con espacios colapsados. */
function linea(v, { min = 0, max, campo, etiqueta }) {
  const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  if (t.length < min || t.length > max || sinControl(t))
    throw new ErrorSolicitud("DATOS_INVALIDOS", `${etiqueta}: ${min ? `entre ${min} y ${max} caracteres` : `hasta ${max} caracteres`}`, { campos: { [campo]: etiqueta } });
  return t;
}

function campo(fn, nombre, mensaje, errores) {
  try {
    return fn();
  } catch (e) {
    if (!(e instanceof ErrorSolicitud)) errores[nombre] = mensaje ?? e.message;
    else errores[nombre] = e.message;
    return undefined;
  }
}

/**
 * Valida el formulario de solicitud de empresa. Junta TODOS los problemas (`detalle.campos`) para poder mostrarlos a la vez.
 * `serviciosPermitidos`: los códigos que el despliegue ofrece; además deben tener plantillas de rol en el núcleo.
 */
export function validarSolicitud(e, { serviciosPermitidos } = {}) {
  const errores = {};
  const out = {};
  out.nombre = campo(() => linea(e?.nombre, { min: 2, max: 80, campo: "nombre", etiqueta: "El nombre del negocio debe tener entre 2 y 80 caracteres" }), "nombre", null, errores);
  out.slug = campo(() => {
    const s = typeof e?.slug === "string" ? e.slug.trim().toLowerCase() : "";
    if (!SLUG.test(s)) throw new ErrorSolicitud("DATOS_INVALIDOS", "La dirección web: de 3 a 60 caracteres, solo minúsculas, números y guiones (sin empezar ni terminar con guion)");
    if (s.includes("--")) throw new ErrorSolicitud("DATOS_INVALIDOS", "La dirección web no puede tener dos guiones seguidos");
    if (SLUGS_RESERVADOS.has(s)) throw new ErrorSolicitud("DATOS_INVALIDOS", "Esa dirección web está reservada: elige otra");
    return s;
  }, "slug", null, errores);
  out.servicios = campo(() => {
    const l = Array.isArray(e?.servicios) ? [...new Set(e.servicios.map((x) => (typeof x === "string" ? x.trim() : "")))] : [];
    if (!l.length || l.length > MAX_SERVICIOS) throw new ErrorSolicitud("DATOS_INVALIDOS", `Elige al menos un servicio (hasta ${MAX_SERVICIOS})`);
    for (const c of l) {
      if (!CODIGO_SERVICIO.test(c) || !Object.hasOwn(PLANTILLAS, c) || c === "base" || (serviciosPermitidos && !serviciosPermitidos.includes(c)))
        throw new ErrorSolicitud("DATOS_INVALIDOS", "Elige un servicio de la lista");
    }
    return l;
  }, "servicios", null, errores);
  out.pais = campo(() => normalizarPais(e?.pais), "pais", "Elige el país", errores);
  out.moneda = campo(() => normalizarMoneda(e?.moneda), "moneda", "Elige la moneda", errores);
  out.adminNombre = campo(() => linea(e?.adminNombre, { min: 2, max: 80, campo: "adminNombre", etiqueta: "Tu nombre debe tener entre 2 y 80 caracteres" }), "adminNombre", null, errores);
  out.adminCorreo = campo(() => {
    const c = typeof e?.adminCorreo === "string" ? e.adminCorreo.trim().toLowerCase() : "";
    if (c.length > 254 || !CORREO.test(c)) throw new ErrorSolicitud("DATOS_INVALIDOS", "Escribe un correo válido");
    return c;
  }, "adminCorreo", null, errores);
  // Sin país válido el teléfono se valida con el de por defecto (la persona verá los dos errores a la vez).
  out.telefono = campo(() => normalizarTelefono(e?.telefono, out.pais ?? "PE").telefono, "telefono", "Escribe un teléfono válido (si es de otro país, con su código: +54…)", errores);
  out.aceptacion = campo(() => {
    const t = e?.aceptoTerminos;
    if (!t || typeof t.terminos !== "string" || !t.terminos || typeof t.privacidad !== "string" || !t.privacidad)
      throw new ErrorSolicitud("DATOS_INVALIDOS", "Debes aceptar los términos y la política de privacidad");
    return { terminos: t.terminos.slice(0, 40), privacidad: t.privacidad.slice(0, 40) };
  }, "aceptoTerminos", null, errores);
  if (Object.keys(errores).length) throw new ErrorSolicitud("DATOS_INVALIDOS", "Revisa los datos del formulario", { campos: errores });
  return out;
}
