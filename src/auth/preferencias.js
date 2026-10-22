import { ErrorAuth } from "./errores.js";

// El id de la página principal nombra un destino del front (por ejemplo "tobt.pedidos").
// Nunca es una URL: el núcleo solo cuida el formato; qué destinos existen lo sabe el front.
// Hasta 3 segmentos separados por punto; cada uno en minúsculas, números y "_", empezando por letra.
const ID_PAGINA = /^[a-z][a-z0-9_]{0,29}(\.[a-z][a-z0-9_]{0,29}){0,2}$/;

/** Valida `paginaPrincipal`. `null` (o "") la quita; devuelve el valor a guardar. */
export function validarPaginaPrincipal(valor) {
  if (valor === null || valor === "") return null;
  if (typeof valor !== "string" || valor.length > 64 || !ID_PAGINA.test(valor))
    throw new ErrorAuth(
      "DATOS_INVALIDOS",
      "paginaPrincipal debe ser el id de un destino (por ejemplo tobt.pedidos) o null",
    );
  return valor;
}
