import { randomInt } from "node:crypto";
import { permite } from "../permisos.js";
import { ErrorEmpleado } from "./errores.js";

const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TELEFONO = /^[0-9+()\- ]{6,20}$/;
// recurso:accion (o "*"). Solo minúsculas, números y "_" ; la acción puede ser "*".
const PERMISO = /^(\*|[a-z][a-z0-9_]{0,31}:([a-z][a-z0-9_]{0,31}|\*))$/;
// Sin I, O, 0, 1, l para que nadie confunda caracteres al dictar la contraseña temporal.
const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

export const MAX_PERMISOS = 100;

export function validarNombre(nombre) {
  if (typeof nombre !== "string" || !nombre.trim() || nombre.trim().length > 80)
    throw new ErrorEmpleado("DATOS_INVALIDOS", "nombre requerido (máximo 80 caracteres)");
  return nombre.trim();
}

export function validarCorreo(correo) {
  if (typeof correo !== "string" || correo.length > 254 || !CORREO.test(correo.trim()))
    throw new ErrorEmpleado("DATOS_INVALIDOS", "correo inválido");
  return correo.trim().toLowerCase();
}

/** El teléfono es opcional: undefined = no tocar, null o "" = quitarlo. */
export function validarTelefono(telefono) {
  if (telefono === undefined) return undefined;
  if (telefono === null || telefono === "") return null;
  if (typeof telefono !== "string" || !TELEFONO.test(telefono.trim()))
    throw new ErrorEmpleado("DATOS_INVALIDOS", "teléfono inválido");
  return telefono.trim();
}

export function validarNombreRol(nombre) {
  if (typeof nombre !== "string" || !nombre.trim() || nombre.trim().length > 40)
    throw new ErrorEmpleado("DATOS_INVALIDOS", "nombre del rol requerido (máximo 40 caracteres)");
  const limpio = nombre.trim();
  if (limpio.toLowerCase() === "admin")
    throw new ErrorEmpleado("ROL_PROTEGIDO", "el nombre «admin» está reservado");
  return limpio;
}

/** Valida el formato `recurso:accion` de cada permiso, quita repetidos y devuelve la lista limpia. */
export function validarPermisos(permisos) {
  if (!Array.isArray(permisos) || permisos.length > MAX_PERMISOS)
    throw new ErrorEmpleado("DATOS_INVALIDOS", `permisos debe ser una lista de hasta ${MAX_PERMISOS}`);
  for (const p of permisos)
    if (typeof p !== "string" || !PERMISO.test(p))
      throw new ErrorEmpleado("PERMISO_INVALIDO", `permiso inválido: ${String(p).slice(0, 40)} (formato recurso:accion)`);
  return [...new Set(permisos)];
}

/** ¿Alguien con `permisosActor` puede conceder (o tocar) todos los permisos de `permisosObjetivo`? */
export const alcanza = (permisosActor, permisosObjetivo) =>
  permisosObjetivo.every((p) => permite(permisosActor, p));

export const esAdmin = (permisos) => permisos.includes("*");

export function generarPasswordTemporal(largo = 12) {
  return Array.from({ length: largo }, () => ALFABETO[randomInt(ALFABETO.length)]).join("");
}
