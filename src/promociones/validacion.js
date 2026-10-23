import { ErrorPromocion } from "./errores.js";

// Reglas de una promoción (arquitectura 5.40). Lógica pura, sin base de datos.

export const TIPOS = Object.freeze(["nxm", "combo", "directo"]);
export const EFECTOS = Object.freeze(["porcentaje", "monto", "gratis"]);
export const MAX_PROMOCIONES_ACTIVAS = 100;

const CODIGO = /^[A-Za-z0-9._\-/]{1,40}$/; // el mismo formato que el código de un ítem del catálogo
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;
const COMUNES = ["nombre", "descripcion", "activa", "prioridad", "acumulable", "tipo", "vigencia", "dias", "horario"];
const POR_TIPO = {
  nxm: ["objetivo", "n", "m"],
  combo: ["disparador", "objetivo", "efecto", "valor"],
  directo: ["objetivo", "efecto", "valor"],
};
const malo = (m) => new ErrorPromocion("DATOS_INVALIDOS", m);

/** Los códigos de ítem no distinguen mayúsculas (igual que el catálogo). */
export const claveItem = (codigo) => String(codigo ?? "").trim().toLowerCase();
/** Las categorías tampoco, ni espacios de más. */
export const claveCategoria = (c) => String(c ?? "").trim().toLowerCase();

const dosDecimales = (v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;

function entero(v, nombre, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) throw malo(`${nombre}: un entero de ${min} a ${max}`);
  return v;
}

/** `{ itemCodigo }` o `{ categoria }` (uno solo): a qué ítems se refiere la promoción. */
function validarSelector(s, nombre) {
  if (!s || typeof s !== "object" || Array.isArray(s)) throw malo(`${nombre}: { itemCodigo } o { categoria }`);
  const extra = Object.keys(s).filter((k) => !["itemCodigo", "categoria"].includes(k));
  if (extra.length) throw malo(`${nombre}: campos no admitidos (${extra.join(", ")})`);
  const tieneItem = s.itemCodigo !== undefined && s.itemCodigo !== null && s.itemCodigo !== "";
  const tieneCat = s.categoria !== undefined && s.categoria !== null && s.categoria !== "";
  if (tieneItem === tieneCat) throw malo(`${nombre}: indica un ítem (itemCodigo) o una categoría, no los dos ni ninguno`);
  if (tieneItem) {
    const c = typeof s.itemCodigo === "string" ? s.itemCodigo.trim() : "";
    if (!CODIGO.test(c)) throw malo(`${nombre}.itemCodigo: el código de un ítem del catálogo`);
    return { itemCodigo: c, categoria: null };
  }
  const cat = typeof s.categoria === "string" ? s.categoria.trim() : "";
  if (!cat || cat.length > 60) throw malo(`${nombre}.categoria: una categoría del catálogo (hasta 60 caracteres)`);
  return { itemCodigo: null, categoria: cat };
}

function validarFecha(v, nombre) {
  if (typeof v !== "string" || !FECHA.test(v)) throw malo(`${nombre}: una fecha AAAA-MM-DD`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw malo(`${nombre}: no es una fecha real (${v})`);
  return v;
}

function validarVigencia(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw malo("vigencia: { desde?, hasta? } con fechas AAAA-MM-DD");
  const extra = Object.keys(v).filter((k) => !["desde", "hasta"].includes(k));
  if (extra.length) throw malo(`vigencia: campos no admitidos (${extra.join(", ")})`);
  const desde = v.desde ? validarFecha(v.desde, "vigencia.desde") : null;
  const hasta = v.hasta ? validarFecha(v.hasta, "vigencia.hasta") : null;
  if (desde && hasta && hasta < desde) throw malo("vigencia: «hasta» no puede ser antes que «desde»");
  return desde || hasta ? { desde, hasta } : null;
}

function validarDias(v) {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) throw malo("dias: una lista de números de 0 (domingo) a 6 (sábado)");
  const dias = [...new Set(v.map((x) => entero(x, "dias", 0, 6)))].sort((a, b) => a - b);
  return dias.length ? dias : null;
}

function validarHorario(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw malo("horario: { desde, hasta } con horas HH:MM");
  const extra = Object.keys(v).filter((k) => !["desde", "hasta"].includes(k));
  if (extra.length) throw malo(`horario: campos no admitidos (${extra.join(", ")})`);
  if (!HORA.test(String(v.desde ?? "")) || !HORA.test(String(v.hasta ?? ""))) throw malo("horario: «desde» y «hasta» como HH:MM (24 horas)");
  if (v.desde === v.hasta) throw malo("horario: «desde» y «hasta» no pueden ser iguales");
  return { desde: v.desde, hasta: v.hasta };
}

/** efecto + valor: porcentaje (más de 0 y hasta 100), monto (más de 0) o gratis (sin valor). */
function validarEfecto(efecto, valor) {
  if (!EFECTOS.includes(efecto)) throw malo(`efecto: uno de ${EFECTOS.join(", ")}`);
  if (efecto === "gratis") {
    if (valor !== null && valor !== undefined) throw malo("valor: «gratis» no lleva valor");
    return { efecto, valor: null };
  }
  if (typeof valor !== "number" || !Number.isFinite(valor) || valor <= 0 || !dosDecimales(valor))
    throw malo(`valor: un número mayor que 0 con hasta 2 decimales (${efecto === "porcentaje" ? "porcentaje" : "monto"})`);
  if (efecto === "porcentaje" && valor > 100) throw malo("valor: un porcentaje de hasta 100");
  if (efecto === "monto" && valor > 1_000_000) throw malo("valor: un monto de hasta 1.000.000");
  return { efecto, valor };
}

/**
 * Valida una promoción y devuelve todos sus campos ya normalizados (los que no aplican a su tipo, en null).
 * `base` es la promoción actual al editar: `datos` se superpone y se valida el conjunto. Lo que `datos` trae de más
 * para su tipo se rechaza (un `n` en un combo no se ignora en silencio).
 */
export function validarPromocion(datos, base = null) {
  if (!datos || typeof datos !== "object" || Array.isArray(datos)) throw malo("la promoción debe ser un objeto");
  if (base && !Object.keys(datos).length) throw malo("no hay nada que cambiar");
  const d = { descripcion: null, activa: true, prioridad: 100, acumulable: false, ...(base ?? {}), ...datos };
  // Al cambiar de efecto sin decir el valor, el valor del efecto anterior no se arrastra (de «10 %» a «gratis»).
  if (base && datos.efecto !== undefined && datos.efecto !== base.efecto && datos.valor === undefined) d.valor = null;

  if (!TIPOS.includes(d.tipo)) throw malo(`tipo: uno de ${TIPOS.join(", ")}`);
  const permitidos = [...COMUNES, ...POR_TIPO[d.tipo]];
  const extra = Object.keys(datos).filter((k) => !permitidos.includes(k));
  if (extra.length) throw malo(`campos no admitidos para el tipo «${d.tipo}» (${extra.join(", ")})`);

  const nombre = typeof d.nombre === "string" ? d.nombre.trim() : "";
  if (!nombre || nombre.length > 80) throw malo("nombre: un texto de hasta 80 caracteres");
  const descripcion = d.descripcion === null || d.descripcion === undefined || d.descripcion === "" ? null : d.descripcion;
  if (descripcion !== null && (typeof descripcion !== "string" || descripcion.trim().length > 200)) throw malo("descripcion: un texto de hasta 200 caracteres");
  if (typeof d.activa !== "boolean") throw malo("activa: verdadero o falso");
  if (typeof d.acumulable !== "boolean") throw malo("acumulable: verdadero o falso");

  const r = {
    nombre,
    descripcion: descripcion === null ? null : descripcion.trim() || null,
    activa: d.activa,
    prioridad: entero(d.prioridad, "prioridad", 0, 1000),
    acumulable: d.acumulable,
    tipo: d.tipo,
    objetivo: validarSelector(d.objetivo, "objetivo"),
    disparador: null,
    n: null,
    m: null,
    efecto: null,
    valor: null,
    vigencia: validarVigencia(d.vigencia),
    dias: validarDias(d.dias),
    horario: validarHorario(d.horario),
  };

  if (d.tipo === "nxm") {
    r.n = entero(d.n, "n", 2, 10);
    r.m = entero(d.m, "m", 1, 9);
    if (r.m >= r.n) throw malo("m: debe ser menor que n (2x1 = n 2, m 1: lleva 2 y paga 1)");
  } else {
    if (d.tipo === "combo") r.disparador = validarSelector(d.disparador, "disparador");
    Object.assign(r, validarEfecto(d.efecto, d.valor));
  }
  return r;
}
