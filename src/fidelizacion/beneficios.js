import { randomInt } from "node:crypto";
import { ErrorFidelizacion } from "./errores.js";

// Beneficios canjeables y vales (arquitectura 5.30). Lógica pura: sin base de datos, para probarla sola.

export const TIPOS_BENEFICIO = ["descuento_porcentaje", "descuento_monto", "item_gratis"];
export const ORIGENES_TICKET = ["canje", "reto"];
export const ESTADOS_TICKET = ["activo", "usado", "cancelado"]; // `vencido` no se guarda: se deduce de `venceTs`
export const VIGENCIA_POR_DEFECTO_DIAS = 30;
export const MAX_VIGENCIA_DIAS = 365;

const CAMPOS = ["nombre", "descripcion", "puntos", "tipo", "valor", "itemCodigo", "vigenciaDias", "activo"];
const malo = (m) => new ErrorFidelizacion("DATOS_INVALIDOS", m);
const enCentavos = (n) => Math.round(n * 100);
const dosDecimales = (n) => Math.abs(enCentavos(n) / 100 - n) < 1e-9;

/**
 * Valida un beneficio. `base` es el beneficio actual al editar: `datos` se superpone y se valida el conjunto, así un
 * cambio de tipo no deja un valor que ya no corresponde. Devuelve el beneficio completo y normalizado.
 */
export function validarBeneficio(datos, base = null) {
  if (!datos || typeof datos !== "object" || Array.isArray(datos)) throw malo("el beneficio debe ser un objeto");
  const extra = Object.keys(datos).filter((k) => !CAMPOS.includes(k));
  if (extra.length) throw malo(`campos no admitidos (${extra.join(", ")})`);
  if (base && !Object.keys(datos).length) throw malo("no hay nada que cambiar");
  const d = { ...(base ?? { descripcion: null, valor: null, itemCodigo: null, vigenciaDias: VIGENCIA_POR_DEFECTO_DIAS, activo: true }), ...datos };

  const nombre = typeof d.nombre === "string" ? d.nombre.trim() : "";
  if (!nombre || nombre.length > 80) throw malo("nombre: texto de 1 a 80 caracteres");
  let descripcion = d.descripcion ?? null;
  if (descripcion !== null) {
    if (typeof descripcion !== "string" || descripcion.trim().length > 200) throw malo("descripcion: texto de hasta 200 caracteres");
    descripcion = descripcion.trim() || null;
  }
  if (!Number.isInteger(d.puntos) || d.puntos < 1 || d.puntos > 1_000_000) throw malo("puntos: un entero de 1 a 1.000.000");
  if (!TIPOS_BENEFICIO.includes(d.tipo)) throw malo(`tipo: uno de ${TIPOS_BENEFICIO.join(", ")}`);
  if (!Number.isInteger(d.vigenciaDias) || d.vigenciaDias < 1 || d.vigenciaDias > MAX_VIGENCIA_DIAS)
    throw malo(`vigenciaDias: un entero de 1 a ${MAX_VIGENCIA_DIAS}`);
  if (typeof d.activo !== "boolean") throw malo("activo debe ser true o false");

  let valor = null;
  let itemCodigo = null;
  if (d.tipo === "item_gratis") {
    if (typeof d.itemCodigo !== "string" || !d.itemCodigo.trim() || d.itemCodigo.trim().length > 60)
      throw malo("itemCodigo: el código del plato del catálogo (hasta 60 caracteres)");
    itemCodigo = d.itemCodigo.trim();
  } else {
    if (typeof d.valor !== "number" || !Number.isFinite(d.valor) || d.valor <= 0 || !dosDecimales(d.valor))
      throw malo("valor: un número mayor que 0 (hasta 2 decimales)");
    if (d.tipo === "descuento_porcentaje" && d.valor > 100) throw malo("valor: un porcentaje de hasta 100");
    if (d.tipo === "descuento_monto" && d.valor > 10_000_000) throw malo("valor: un monto de hasta 10.000.000");
    valor = d.valor;
  }
  return { nombre, descripcion, puntos: d.puntos, tipo: d.tipo, valor, itemCodigo, vigenciaDias: d.vigenciaDias, activo: d.activo };
}

/** Texto corto de lo que da un beneficio, para mostrarlo junto al nombre. */
export function textoBeneficio(b) {
  if (b.tipo === "descuento_porcentaje") return `${b.valor}% de descuento en un ítem`;
  if (b.tipo === "descuento_monto") return `${b.valor} de descuento en un ítem`;
  return `Un ${b.itemCodigo} gratis`;
}

/**
 * Cuánto descuenta un beneficio sobre un ítem del pedido. Trabaja en centavos enteros y nunca pasa del subtotal.
 *   porcentaje: valor % del subtotal del ítem (todas sus unidades)
 *   monto:      el monto fijo (tope: el subtotal)
 *   item_gratis: el precio de UNA unidad (el ítem debe ser el plato del beneficio)
 * `ítem` = { subtotal, precio, cantidad, codigo }. Devuelve el descuento en la moneda (2 decimales).
 */
export function calcularDescuento(beneficio, item) {
  const sub = item?.subtotal;
  if (typeof sub !== "number" || !Number.isFinite(sub) || sub <= 0)
    throw new ErrorFidelizacion("ESTADO_INVALIDO", "el ítem no tiene un precio al que aplicar el vale");
  const subC = enCentavos(sub);
  let c;
  if (beneficio.tipo === "descuento_porcentaje") c = Math.round((subC * beneficio.valor) / 100);
  else if (beneficio.tipo === "descuento_monto") c = enCentavos(beneficio.valor);
  else if (beneficio.tipo === "item_gratis") {
    if (item.codigo !== beneficio.itemCodigo)
      throw new ErrorFidelizacion("ESTADO_INVALIDO", `este vale es para «${beneficio.itemCodigo}»`);
    if (typeof item.precio !== "number" || item.precio <= 0)
      throw new ErrorFidelizacion("ESTADO_INVALIDO", "el ítem no tiene un precio al que aplicar el vale");
    c = enCentavos(item.precio);
  } else throw malo("tipo de beneficio desconocido");
  return Math.min(c, subC) / 100;
}

// ---------- códigos de vale ----------
// Sin I, L, O, 0 ni 1: el cliente lo lee en voz alta o lo copia a mano.
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const LARGO_CODIGO = 6;

export function generarCodigo() {
  let s = "";
  for (let i = 0; i < LARGO_CODIGO; i++) s += ALFABETO[randomInt(ALFABETO.length)];
  return s;
}

/** Acepta mayúsculas o minúsculas, con espacios o guiones («k7m-2qx»). Devuelve el código o null si no es válido. */
export function normalizarCodigo(texto) {
  const t = String(texto ?? "").toUpperCase().replace(/[\s-]+/g, "");
  return new RegExp(`^[${ALFABETO}]{${LARGO_CODIGO}}$`).test(t) ? t : null;
}

/** El estado que ve la gente: un vale activo cuya fecha pasó está `vencido`. */
export function estadoEfectivo(ticket, ahora = new Date()) {
  if (ticket.estado === "activo" && new Date(ticket.venceTs) <= ahora) return "vencido";
  return ticket.estado;
}
