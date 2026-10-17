import { ErrorFidelizacion } from "./errores.js";
import { VIGENCIA_POR_DEFECTO_DIAS, validarBeneficio } from "./beneficios.js";

// Retos de colección (arquitectura 5.31). Lógica pura, sin base de datos.
//
// Un reto dice «prueba todo lo de una categoría de la carta y te regalamos esto». Cuando un cliente que participa en
// el programa de puntos ha comprado (pagado) cada ítem activo de esa categoría, el sistema le emite solo un vale
// sin costo en puntos, una sola vez por reto. El avance se calcula siempre desde el libro de puntos: cada
// movimiento `acumulo` lleva el código del ítem pagado (`itemCodigo`), así que no hay nada aparte que sincronizar.

const CAMPOS = ["nombre", "descripcion", "categoria", "tipo", "valor", "itemCodigo", "vigenciaDias", "activo"];
const malo = (m) => new ErrorFidelizacion("DATOS_INVALIDOS", m);

/** Mismo criterio del catálogo: los códigos no distinguen mayúsculas. */
export const claveItem = (codigo) => String(codigo ?? "").trim().toLowerCase();

/**
 * Valida un reto. El premio (tipo, valor, itemCodigo, vigenciaDias) sigue las mismas reglas que un beneficio, sin costo
 * en puntos. `base` es el reto actual al editar: `datos` se superpone y se valida el conjunto.
 */
export function validarReto(datos, base = null) {
  if (!datos || typeof datos !== "object" || Array.isArray(datos)) throw malo("el reto debe ser un objeto");
  const extra = Object.keys(datos).filter((k) => !CAMPOS.includes(k));
  if (extra.length) throw malo(`campos no admitidos (${extra.join(", ")})`);
  if (base && !Object.keys(datos).length) throw malo("no hay nada que cambiar");
  const d = { descripcion: null, valor: null, itemCodigo: null, vigenciaDias: VIGENCIA_POR_DEFECTO_DIAS, activo: true, ...(base ?? {}), ...datos };

  const categoria = typeof d.categoria === "string" ? d.categoria.trim() : "";
  if (!categoria || categoria.length > 60) throw malo("categoria: el nombre de una categoría del catálogo (hasta 60 caracteres)");
  // El premio se valida como un beneficio (los puntos no aplican: el vale del reto no cuesta nada).
  const premio = validarBeneficio(
    {
      nombre: d.nombre,
      descripcion: d.descripcion ?? null,
      puntos: 1,
      tipo: d.tipo,
      valor: d.valor ?? null,
      itemCodigo: d.itemCodigo ?? null,
      vigenciaDias: d.vigenciaDias,
      activo: d.activo,
    },
    null,
  );
  const { puntos: _puntos, ...resto } = premio;
  return { ...resto, categoria };
}

/**
 * Avance de un cliente en un reto.
 *   `requeridos`: los ítems activos de la categoría, [{ codigo, nombre }]
 *   `movimientos`: el libro del cliente ({ tipo, itemCodigo }); solo cuentan los `acumulo` con `itemCodigo`
 * Devuelve { total, logrados, faltan: [{ codigo, nombre }], completo }. Un reto sin ítems nunca está completo.
 * Lo comprado de un ítem que ya no está en la carta no suma ni resta: solo cuentan los ítems de hoy.
 */
export function calcularProgreso({ requeridos, movimientos }) {
  const comprados = new Set(
    (Array.isArray(movimientos) ? movimientos : [])
      .filter((m) => m?.tipo === "acumulo" && m.itemCodigo)
      .map((m) => claveItem(m.itemCodigo)),
  );
  const lista = Array.isArray(requeridos) ? requeridos : [];
  const faltan = lista.filter((i) => !comprados.has(claveItem(i.codigo))).map((i) => ({ codigo: i.codigo, nombre: i.nombre ?? i.codigo }));
  const total = lista.length;
  return { total, logrados: total - faltan.length, faltan, completo: total > 0 && faltan.length === 0 };
}
