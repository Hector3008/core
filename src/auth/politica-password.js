import { ErrorAuth } from "./errores.js";

export const PASSWORD_MIN = 10;

/** Política para las contraseñas nuevas (temporales y cambios). No se aplica a las que ya existen. */
export function validarPassword(p) {
  if (typeof p !== "string" || p.length < PASSWORD_MIN || p.length > 1024)
    throw new ErrorAuth("DATOS_INVALIDOS", `la contraseña debe tener al menos ${PASSWORD_MIN} caracteres`);
  if (!p.trim()) throw new ErrorAuth("DATOS_INVALIDOS", "la contraseña no puede ser solo espacios");
}
