import { ErrorCatalogo } from "./errores.js";
import { exigirTamano, sinNulos, validarAtributos } from "./atributos.js";

const ID = /^[0-9a-f]{24}$/i;
const CODIGO = /^[A-Za-z0-9._\-/]{1,40}$/;
const PRECIO_MAX = 1_000_000_000;

export const MAX_ITEMS_INSTANTANEA = 500;
export const MAX_FILAS_IMPORTACION = 500;
export const CAMPOS_ITEM = ["nombre", "precio", "categoria", "atributos"];
const CAMPOS_LIBRE = ["codigo", "nombre", "precio", "categoria", "atributos"];

export const idValido = (v, nombre = "id") => {
  if (!ID.test(String(v ?? ""))) throw new ErrorCatalogo("DATOS_INVALIDOS", `${nombre} inválido`);
  return String(v);
};

/**
 * El código se guarda como lo escribió la persona (sin cambiar mayúsculas), pero identifica al ítem sin
 * distinguirlas: "zm-1" y "ZM-1" son el mismo (ver `claveDe`). No se puede cambiar después de crearlo.
 */
export function validarCodigo(codigo) {
  const c = typeof codigo === "string" ? codigo.trim() : "";
  if (!CODIGO.test(c))
    throw new ErrorCatalogo(
      "DATOS_INVALIDOS",
      "código inválido (1 a 40 caracteres: letras, números, punto, guion, guion bajo o barra)",
    );
  return c;
}
export const claveDe = (codigo) => codigo.toLowerCase();

/** El nombre es la descripción del ítem: lo que se ve en la carta, la proforma o la etiqueta. */
export function validarNombre(nombre) {
  if (typeof nombre !== "string" || !nombre.trim() || nombre.trim().length > 200)
    throw new ErrorCatalogo("DATOS_INVALIDOS", "nombre requerido (máximo 200 caracteres)");
  return nombre.trim();
}

/** undefined = no tocar; null o "" = quitar. */
export function validarCategoria(categoria) {
  if (categoria === undefined) return undefined;
  if (categoria === null || categoria === "") return null;
  if (typeof categoria !== "string" || !categoria.trim() || categoria.trim().length > 60)
    throw new ErrorCatalogo("DATOS_INVALIDOS", "categoría inválida (máximo 60 caracteres)");
  return categoria.trim();
}

/**
 * Número con 2 decimales como máximo. Más decimales se rechazan en vez de redondear en silencio: con
 * dinero, es mejor que alguien lo vea. undefined = no tocar; null = sin precio.
 */
export function validarPrecio(precio) {
  if (precio === undefined) return undefined;
  if (precio === null) return null;
  if (typeof precio !== "number" || !Number.isFinite(precio) || precio < 0 || precio > PRECIO_MAX)
    throw new ErrorCatalogo("DATOS_INVALIDOS", "precio inválido (un número, de 0 en adelante)");
  const centimos = precio * 100;
  if (Math.abs(Math.round(centimos) - centimos) > 1e-6)
    throw new ErrorCatalogo("DATOS_INVALIDOS", "precio inválido: máximo 2 decimales");
  return Math.round(centimos) / 100;
}

/**
 * Valida los campos de un ítem. `crear: true` exige código y nombre (y quita las claves nulas de los
 * atributos). Devuelve los cambios ya limpios; `null` significa "quitar" y `undefined` "no tocar".
 */
export function prepararDatos(e, { crear = false, registro } = {}) {
  const atributos = validarAtributos(e.atributos, registro);
  if (crear && atributos) exigirTamano(sinNulos(atributos));
  return {
    codigo: crear || e.codigo !== undefined ? validarCodigo(e.codigo) : undefined,
    nombre: crear || e.nombre !== undefined ? validarNombre(e.nombre) : undefined,
    categoria: validarCategoria(e.categoria),
    precio: validarPrecio(e.precio),
    atributos: crear && atributos ? sinNulos(atributos) : atributos,
  };
}

/**
 * Una línea libre: un elemento que todavía no está en el catálogo y se monta igual en un documento
 * (por ejemplo, un repuesto de siscore que aún no se sube). Solo se admiten los campos de un ítem; el
 * código es opcional, pero si se pone no puede ser el de un ítem del catálogo (eso lo comprueba el servicio).
 * Los atributos se validan por tipo, sin exigir ninguno.
 */
export function validarLineaLibre(libre, registro) {
  if (!libre || typeof libre !== "object" || Array.isArray(libre))
    throw new ErrorCatalogo("DATOS_INVALIDOS", "libre debe ser un objeto { nombre, ... }");
  const raros = Object.keys(libre).filter((k) => !CAMPOS_LIBRE.includes(k));
  if (raros.length)
    throw new ErrorCatalogo(
      "DATOS_INVALIDOS",
      `línea libre: campo no admitido: ${raros[0].slice(0, 20)} (admitidos: ${CAMPOS_LIBRE.join(", ")})`,
    );
  const atributos = validarAtributos(libre.atributos, registro);
  const a = sinNulos(atributos ?? {});
  exigirTamano(a);
  return {
    codigo: libre.codigo === undefined || libre.codigo === null || libre.codigo === "" ? null : validarCodigo(libre.codigo),
    nombre: validarNombre(libre.nombre),
    precio: validarPrecio(libre.precio) ?? null,
    categoria: validarCategoria(libre.categoria) ?? null,
    atributos: a,
  };
}
