import { ErrorKardex } from "./errores.js";

// Lógica pura del kardex (arquitectura 5.75): validación y costo promedio. Sin base de datos.
//
// Todo el kardex se lleva en la UNIDAD BASE del insumo (g, ml, unidad…). Las presentaciones (paquete, caja, bidón)
// solo existen al registrar: «3 paquetes» se convierte a unidad base con el factor de la presentación.
//
// Costo promedio ponderado:
//   - una entrada (compra, inventario inicial, reversa) recalcula el promedio; si no había existencia (o era negativa),
//     el promedio pasa a ser el costo de esa entrada;
//   - una salida (consumo, merma, ajuste a la baja) sale al promedio vigente y no lo cambia;
//   - un ajuste al alza entra al promedio vigente (no lo cambia).

export const TIPOS_MOVIMIENTO = Object.freeze(["inventario_inicial", "compra", "consumo", "reversa", "merma", "ajuste", "anulacion"]);
// Lo que el personal puede anular (5.84). Un consumo se devuelve anulando el ítem del pedido (reversa); una anulación no se anula.
export const TIPOS_ANULABLES = Object.freeze(["inventario_inicial", "compra", "merma", "ajuste"]);
export const MAX_INSUMOS = 2000;
export const MAX_PRESENTACIONES = 10;
export const MAX_CANTIDAD = 1e9;
export const MAX_DETALLE = 200;

const CODIGO = /^[A-Za-z0-9._\-/]{1,40}$/;
const UNIDAD = /^[\p{L}\p{N}.]{1,12}$/u;
const malo = (m) => new ErrorKardex("DATOS_INVALIDOS", m);

export const redondear = (n, decimales) => {
  const f = 10 ** decimales;
  return Math.round((n + Number.EPSILON) * f) / f;
};
const decimalesDe = (n) => {
  const s = String(n);
  if (s.includes("e-")) return 99;
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
};

export function validarNumero(v, nombre, { decimales, minimo = 0, exclusivo = true, maximo = MAX_CANTIDAD }) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw malo(`${nombre}: un número`);
  if (exclusivo ? v <= minimo : v < minimo) throw malo(`${nombre}: debe ser ${exclusivo ? "mayor que" : "al menos"} ${minimo}`);
  if (v > maximo) throw malo(`${nombre}: demasiado grande`);
  if (decimalesDe(v) > decimales) throw malo(`${nombre}: como máximo ${decimales} decimales`);
  return v;
}

/** Cantidad de un movimiento (en la unidad en que se escribe). `permitirCero` solo para el conteo físico. */
export const validarCantidad = (v, nombre = "cantidad", { permitirCero = false } = {}) =>
  validarNumero(v, nombre, { decimales: 3, minimo: 0, exclusivo: !permitirCero });

export const validarCosto = (v, nombre = "costo") => validarNumero(v, nombre, { decimales: 6, minimo: 0, exclusivo: false });

export function validarDetalle(v, { obligatorio = false, nombre = "detalle" } = {}) {
  if (v === undefined || v === null || v === "") {
    if (obligatorio) throw malo(`${nombre}: obligatorio`);
    return null;
  }
  if (typeof v !== "string") throw malo(`${nombre}: un texto`);
  const t = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) {
    if (obligatorio) throw malo(`${nombre}: obligatorio`);
    return null;
  }
  if (t.length > MAX_DETALLE) throw malo(`${nombre}: máximo ${MAX_DETALLE} caracteres`);
  return t;
}

export const claveDeCodigo = (codigo) => String(codigo).toLowerCase();

function validarPresentaciones(v, unidad) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw malo("presentaciones: una lista de { nombre, factor }");
  if (v.length > MAX_PRESENTACIONES) throw malo(`presentaciones: máximo ${MAX_PRESENTACIONES}`);
  const vistos = new Set([unidad.toLowerCase()]);
  return v.map((p, i) => {
    if (!p || typeof p !== "object" || Array.isArray(p)) throw malo(`presentaciones[${i}]: { nombre, factor }`);
    const extra = Object.keys(p).filter((k) => !["nombre", "factor"].includes(k));
    if (extra.length) throw malo(`presentaciones[${i}]: campos no admitidos (${extra.join(", ")})`);
    const nombre = typeof p.nombre === "string" ? p.nombre.trim() : "";
    if (!nombre || nombre.length > 30) throw malo(`presentaciones[${i}].nombre: de 1 a 30 caracteres`);
    const clave = nombre.toLowerCase();
    if (vistos.has(clave)) throw malo(`presentaciones: «${nombre}» está repetida o es igual a la unidad base`);
    vistos.add(clave);
    const factor = validarNumero(p.factor, `presentaciones[${i}].factor`, { decimales: 3, minimo: 0 });
    return { nombre, factor };
  });
}

const CAMPOS = ["codigo", "nombre", "unidad", "stockMinimo", "presentaciones", "activo"];

/**
 * Valida un alta (sin `actual`) o un cambio (con `actual`, el insumo ya guardado). Devuelve solo lo que hay que guardar.
 * El código y la unidad base no cambian nunca: los movimientos ya guardados están escritos en esa unidad.
 */
export function validarInsumo(datos, actual = null) {
  if (!datos || typeof datos !== "object" || Array.isArray(datos)) throw malo("se esperaba un objeto");
  const extra = Object.keys(datos).filter((k) => !CAMPOS.includes(k));
  if (extra.length) throw malo(`campos no admitidos: ${extra.join(", ")}`);
  const r = {};

  if (!actual || datos.codigo !== undefined) {
    if (typeof datos.codigo !== "string" || !CODIGO.test(datos.codigo.trim()))
      throw malo("codigo: de 1 a 40 caracteres (letras, números, punto, guion, guion bajo y barra)");
    const codigo = datos.codigo.trim();
    if (actual && claveDeCodigo(codigo) !== claveDeCodigo(actual.codigo)) throw malo("codigo: no se puede cambiar");
    if (!actual) r.codigo = codigo;
  }
  if (!actual || datos.unidad !== undefined) {
    const u = typeof datos.unidad === "string" ? datos.unidad.trim() : "";
    if (!UNIDAD.test(u)) throw malo("unidad: de 1 a 12 letras o números (por ejemplo g, ml, unidad)");
    if (actual && u.toLowerCase() !== String(actual.unidad).toLowerCase()) throw malo("unidad: no se puede cambiar (los movimientos están en esa unidad)");
    if (!actual) r.unidad = u;
  }
  if (!actual || datos.nombre !== undefined) {
    const n = typeof datos.nombre === "string" ? datos.nombre.replace(/\s+/g, " ").trim() : "";
    if (!n || n.length > 120) throw malo("nombre: de 1 a 120 caracteres");
    r.nombre = n;
  }
  if (datos.stockMinimo !== undefined || !actual) {
    r.stockMinimo = datos.stockMinimo === undefined || datos.stockMinimo === null ? 0 : validarNumero(datos.stockMinimo, "stockMinimo", { decimales: 3, minimo: 0, exclusivo: false });
  }
  const unidad = actual?.unidad ?? r.unidad;
  if (datos.presentaciones !== undefined || !actual) r.presentaciones = validarPresentaciones(datos.presentaciones, unidad);
  if (datos.activo !== undefined) {
    if (typeof datos.activo !== "boolean") throw malo("activo: verdadero o falso");
    r.activo = datos.activo;
  } else if (!actual) r.activo = true;
  return r;
}

/** Cuántas unidades base vale una unidad de la presentación elegida (null o la propia unidad base = 1). */
export function factorDe(insumo, presentacion) {
  if (presentacion === undefined || presentacion === null || presentacion === "") return { nombre: null, factor: 1 };
  if (typeof presentacion !== "string") throw malo("presentacion: un texto");
  const clave = presentacion.trim().toLowerCase();
  if (clave === String(insumo.unidad).toLowerCase()) return { nombre: null, factor: 1 };
  const p = (insumo.presentaciones ?? []).find((x) => x.nombre.toLowerCase() === clave);
  if (!p) throw malo(`presentacion: «${presentacion}» no está definida para este insumo`);
  return { nombre: p.nombre, factor: p.factor };
}

/**
 * Pasa lo que escribe la persona a unidad base. `cantidad` y `costo` vienen en la presentación elegida
 * (o en la unidad base): «3 paquetes a 40» → 1500 g a 0,08 el gramo. `costoTotal` es la alternativa: lo pagado en total.
 */
export function aUnidadBase(insumo, { cantidad, presentacion, costo, costoTotal }, { exigirCosto = false, permitirCero = false } = {}) {
  const { nombre, factor } = factorDe(insumo, presentacion);
  const cant = validarCantidad(cantidad, "cantidad", { permitirCero });
  const base = redondear(cant * factor, 3);
  if (!permitirCero && base <= 0) throw malo("cantidad: demasiado pequeña");
  let costoUnitario = null;
  if (costo !== undefined && costo !== null && costoTotal !== undefined && costoTotal !== null)
    throw malo("costo y costoTotal: indica solo uno");
  if (costo !== undefined && costo !== null) costoUnitario = redondear(validarCosto(costo, "costo") / factor, 6);
  else if (costoTotal !== undefined && costoTotal !== null) costoUnitario = redondear(validarCosto(costoTotal, "costoTotal") / base, 6);
  if (exigirCosto && costoUnitario === null) throw malo("costo: indica el costo (por unidad de compra) o el costoTotal");
  return { base, costoUnitario, presentacion: nombre ? { nombre, cantidad: cant, factor } : null };
}

/**
 * Aplica un movimiento al estado { existencia, costoPromedio }. `signo` +1 entra, -1 sale; `cantidad` siempre positiva (en base).
 * Devuelve { existencia, costoPromedio, costoUnitario, negativo }.
 */
export function aplicarMovimiento(estado, { signo, cantidad, costoUnitario }) {
  const existencia0 = estado?.existencia ?? 0;
  const promedio0 = estado?.costoPromedio ?? 0;
  if (signo < 0) {
    const existencia = redondear(existencia0 - cantidad, 3);
    return { existencia, costoPromedio: promedio0, costoUnitario: promedio0, negativo: existencia < 0 };
  }
  // Entrada. Sin costo explícito (ajuste al alza) entra al promedio vigente.
  const costo = costoUnitario ?? promedio0;
  const existencia = redondear(existencia0 + cantidad, 3);
  let costoPromedio;
  if (costoUnitario === null || costoUnitario === undefined) costoPromedio = promedio0;
  else if (existencia0 <= 0) costoPromedio = costo;
  else costoPromedio = redondear((existencia0 * promedio0 + cantidad * costo) / existencia, 6);
  return { existencia, costoPromedio, costoUnitario: costo, negativo: existencia < 0 };
}

/**
 * Deshace un movimiento ya guardado (5.84) con otro de signo contrario al mismo costo con que se hizo. `original` trae
 * `cantidad` con signo y `costoUnitario`. Devuelve { signo, cantidad, ...estado nuevo } como `aplicarMovimiento`.
 *   - Si el original entró (compra, inicial, ajuste al alza), se quita su valor del inventario: el promedio vuelve a lo que
 *     era sin él (las salidas que hubo entre tanto salieron al promedio y no lo movieron, así que la cuenta es exacta).
 *     Si no queda existencia, el promedio no cambia.
 *   - Si el original salió (merma, ajuste a la baja), vuelve a entrar al costo con que salió, como una reversa.
 */
/** `previo`: el saldo justo antes del original; solo se pasa si el original es el último del libro (así el promedio vuelve exacto, sin deriva de redondeo). */
export function deshacerMovimiento(estado, original, previo = null) {
  const q = Number(original.cantidad);
  const costo = Number(original.costoUnitario);
  const cantidad = Math.abs(q);
  if (q < 0) return { signo: 1, cantidad, ...aplicarMovimiento(estado, { signo: 1, cantidad, costoUnitario: costo }) };
  const existencia0 = estado?.existencia ?? 0;
  const promedio0 = estado?.costoPromedio ?? 0;
  const existencia = redondear(existencia0 - cantidad, 3);
  let costoPromedio = promedio0;
  if (previo && existencia === redondear(previo.existencia, 3)) return { signo: -1, cantidad, existencia, costoPromedio: previo.costoPromedio, costoUnitario: costo, negativo: existencia < 0 };
  if (existencia > 0 && existencia0 > 0) costoPromedio = Math.max(0, redondear((existencia0 * promedio0 - cantidad * costo) / existencia, 6));
  return { signo: -1, cantidad, existencia, costoPromedio, costoUnitario: costo, negativo: existencia < 0 };
}
