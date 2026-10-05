import { ErrorEvento } from "./errores.js";

export const MAX_LOTE = 200;
export const MAX_BYTES_DATOS = 4096;
export const VENTANA_TS_MS = 24 * 60 * 60 * 1000; // un ts más viejo que esto se reemplaza por la hora de recepción

// Los tipos que emite el servidor no los puede enviar la interfaz (nadie los falsifica)
export const PREFIJOS_RESERVADOS = ["documento.", "sistema."];

const RE_TIPO = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const RE_ESTACION = /^[a-z][a-z0-9_]{0,31}$/;
const RE_SESION = /^[A-Za-z0-9_-]{8,64}$/;
const RE_CODE = /^[A-Za-z0-9_-]{1,40}$/;

const invalido = (mensaje, detalle) =>
  new ErrorEvento("EVENTO_INVALIDO", mensaje, detalle);

const esObjetoPlano = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export function validarSesionId(sesionId) {
  if (sesionId == null) return null;
  if (typeof sesionId !== "string" || !RE_SESION.test(sesionId))
    throw invalido("sesionId inválido (8 a 64 caracteres: letras, números, _ y -)");
  return sesionId;
}

export function validarEstacion(estacion) {
  if (estacion == null) return null;
  if (typeof estacion !== "string" || !RE_ESTACION.test(estacion))
    throw invalido("estacion inválida (minúsculas, números y _)");
  return estacion;
}

// Claves con $ o con punto dan problemas en MongoDB y en los reportes
function revisarClaves(v, profundidad = 0) {
  if (profundidad > 6) throw invalido("datos demasiado anidados");
  if (Array.isArray(v)) return v.forEach((x) => revisarClaves(x, profundidad + 1));
  if (!esObjetoPlano(v)) return;
  for (const [k, x] of Object.entries(v)) {
    if (k.startsWith("$") || k.includes("."))
      throw invalido(`clave no permitida en datos: '${k}'`);
    revisarClaves(x, profundidad + 1);
  }
}

export function validarDatos(datos) {
  if (datos === undefined) return {};
  if (!esObjetoPlano(datos)) throw invalido("datos debe ser un objeto");
  let json;
  try {
    json = JSON.stringify(datos);
  } catch {
    throw invalido("datos no se puede serializar");
  }
  if (Buffer.byteLength(json) > MAX_BYTES_DATOS)
    throw invalido(`datos supera ${MAX_BYTES_DATOS} bytes`);
  revisarClaves(datos);
  return datos;
}

// `ts` del cliente: se acepta si es una fecha válida, no futura y no más vieja que la
// ventana. Si no, se usa la hora de recepción (los relojes de los dispositivos fallan).
export function resolverTs(ts, recibidoTs) {
  if (ts === undefined || ts === null) return recibidoTs;
  const d = new Date(ts);
  const ms = d.getTime();
  if (Number.isNaN(ms)) return recibidoTs;
  if (ms > recibidoTs.getTime()) return recibidoTs;
  if (recibidoTs.getTime() - ms > VENTANA_TS_MS) return recibidoTs;
  return d;
}

/**
 * Evento enviado por la interfaz → fila de la colección.
 * `estacion`, `sesionId` y `usuarioId` los fija el servidor, nunca el cuerpo del cliente.
 */
export function normalizarEventoInterfaz(
  e,
  { estacion, sesionId, usuarioId, recibidoTs },
) {
  if (!esObjetoPlano(e)) throw invalido("cada evento debe ser un objeto");
  const { tipo, documentoCode, version, ts, datos } = e;

  if (
    typeof tipo !== "string" ||
    tipo.length > 64 ||
    !RE_TIPO.test(tipo)
  )
    throw invalido("tipo inválido (minúsculas, números, _ y puntos; máx. 64)");
  if (PREFIJOS_RESERVADOS.some((p) => tipo.startsWith(p)))
    throw invalido(`el tipo '${tipo}' está reservado para el servidor`);

  if (documentoCode != null && (typeof documentoCode !== "string" || !RE_CODE.test(documentoCode)))
    throw invalido("documentoCode inválido");
  if (version != null && (!Number.isInteger(version) || version < 1))
    throw invalido("version debe ser un entero positivo");
  if (version != null && documentoCode == null)
    throw invalido("version requiere documentoCode");

  return {
    usuarioId,
    sesionId,
    estacion,
    documentoCode: documentoCode ?? null,
    version: version ?? null,
    tipo,
    origen: "interfaz",
    ts: resolverTs(ts, recibidoTs),
    recibidoTs,
    datos: validarDatos(datos),
  };
}
