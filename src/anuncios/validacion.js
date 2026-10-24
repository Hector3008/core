import { ErrorAnuncio } from "./errores.js";
import { urlLogoSegura, MAX_LOGO } from "../marca.js";

// Reglas de un anuncio (arquitectura 5.48). Lógica pura, sin base de datos.
//   evento:     algo que pasa un día y a una hora (un concierto, una noche de karaoke). Lleva fecha y hora, y lugar si no es el local.
//   publicidad: un aviso con vigencia opcional (desde/hasta), sin fecha de evento.

export const TIPOS = Object.freeze(["evento", "publicidad"]);
export const MAX_ANUNCIOS_ACTIVOS = 50;
export const MAX_TITULO = 80;
export const MAX_DESCRIPCION = 300;
export const MAX_LUGAR = 80;

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;
const COMUNES = ["titulo", "descripcion", "activo", "tipo", "imagen"];
const POR_TIPO = {
  evento: ["fecha", "hora", "lugar"],
  publicidad: ["vigencia"],
};
const malo = (m) => new ErrorAnuncio("DATOS_INVALIDOS", m);

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

function textoOpcional(v, nombre, max) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") throw malo(`${nombre}: un texto de hasta ${max} caracteres`);
  const t = v.trim().replace(/\s+/g, " ");
  if (t.length > max) throw malo(`${nombre}: un texto de hasta ${max} caracteres`);
  return t || null;
}

/**
 * Valida un anuncio y devuelve todos sus campos normalizados (los que no aplican a su tipo, en null).
 * `base` es el anuncio actual al editar: `datos` se superpone y se valida el conjunto. Lo que `datos` trae de más
 * para su tipo se rechaza (no se ignora en silencio). El tipo no se puede cambiar al editar.
 */
export function validarAnuncio(datos, base = null) {
  if (!datos || typeof datos !== "object" || Array.isArray(datos)) throw malo("el anuncio debe ser un objeto");
  if (base && !Object.keys(datos).length) throw malo("no hay nada que cambiar");
  if (base && datos.tipo !== undefined && datos.tipo !== base.tipo) throw malo("tipo: no se puede cambiar (crea otro anuncio)");
  const d = { descripcion: null, activo: true, imagen: null, ...(base ?? {}), ...datos };

  if (!TIPOS.includes(d.tipo)) throw malo(`tipo: uno de ${TIPOS.join(", ")}`);
  const permitidos = [...COMUNES, ...POR_TIPO[d.tipo]];
  const extra = Object.keys(datos).filter((k) => !permitidos.includes(k));
  if (extra.length) throw malo(`campos no admitidos para el tipo «${d.tipo}» (${extra.join(", ")})`);

  const titulo = typeof d.titulo === "string" ? d.titulo.trim().replace(/\s+/g, " ") : "";
  if (!titulo || titulo.length > MAX_TITULO) throw malo(`titulo: un texto de hasta ${MAX_TITULO} caracteres`);
  if (typeof d.activo !== "boolean") throw malo("activo: verdadero o falso");

  let imagen = null;
  if (d.imagen !== null && d.imagen !== undefined && d.imagen !== "") {
    imagen = typeof d.imagen === "string" ? urlLogoSegura(d.imagen) : null;
    if (!imagen) throw malo(`imagen: una dirección https:// válida, sin usuario ni contraseña y de hasta ${MAX_LOGO} caracteres`);
  }

  const r = {
    titulo,
    descripcion: textoOpcional(d.descripcion, "descripcion", MAX_DESCRIPCION),
    activo: d.activo,
    tipo: d.tipo,
    imagen,
    fecha: null,
    hora: null,
    lugar: null,
    vigencia: null,
  };

  if (d.tipo === "evento") {
    r.fecha = validarFecha(d.fecha, "fecha");
    if (typeof d.hora !== "string" || !HORA.test(d.hora)) throw malo("hora: HH:MM (24 horas)");
    r.hora = d.hora;
    r.lugar = textoOpcional(d.lugar, "lugar", MAX_LUGAR);
  } else {
    r.vigencia = validarVigencia(d.vigencia);
  }
  return r;
}
