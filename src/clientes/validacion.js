import { normalizarTelefono, normalizarPais } from "../telefono.js";
import { ErrorCliente } from "./errores.js";
import { validarRedes } from "./redes.js";

const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID = /^[0-9a-f]{24}$/i;
const NUMERO_ID = /^[A-Za-z0-9.\-]{1,30}$/;

export const FINALIDADES = ["programaPuntos", "etiquetadoRedes"];
// Cómo se recibió el consentimiento (o su retiro). "anonimizacion" lo pone el sistema.
export const MEDIOS = ["presencial", "telefono", "qr", "formulario", "mensaje"];
export const MAX_BYTES_PREFERENCIAS = 4096;
const MAX_NIVELES = 6;

export const idValido = (v, nombre = "id") => {
  if (!ID.test(String(v ?? ""))) throw new ErrorCliente("DATOS_INVALIDOS", `${nombre} inválido`);
  return String(v);
};

export function validarNombre(nombre) {
  if (typeof nombre !== "string" || !nombre.trim() || nombre.trim().length > 80)
    throw new ErrorCliente("DATOS_INVALIDOS", "nombre requerido (máximo 80 caracteres)");
  return nombre.trim();
}

/** undefined = no tocar; null o "" = quitar. */
export function validarCorreo(correo) {
  if (correo === undefined) return undefined;
  if (correo === null || correo === "") return null;
  if (typeof correo !== "string" || correo.length > 254 || !CORREO.test(correo.trim()))
    throw new ErrorCliente("DATOS_INVALIDOS", "correo inválido");
  return correo.trim().toLowerCase();
}

export function validarDireccion(direccion) {
  if (direccion === undefined) return undefined;
  if (direccion === null || direccion === "") return null;
  if (typeof direccion !== "string" || direccion.trim().length > 200)
    throw new ErrorCliente("DATOS_INVALIDOS", "dirección inválida (máximo 200 caracteres)");
  return direccion.trim();
}

/** `{ tipo, numero }` (RUC, DNI, CUIT...). null o "" = quitar. */
export function validarIdentificacion(ident) {
  if (ident === undefined) return undefined;
  if (ident === null) return null;
  if (typeof ident !== "object" || Array.isArray(ident))
    throw new ErrorCliente("DATOS_INVALIDOS", "identificacion debe ser { tipo, numero }");
  const tipo = typeof ident.tipo === "string" ? ident.tipo.trim().toUpperCase() : "";
  const numero = typeof ident.numero === "string" ? ident.numero.trim() : "";
  if (!/^[A-Z0-9]{2,20}$/.test(tipo) || !NUMERO_ID.test(numero))
    throw new ErrorCliente("DATOS_INVALIDOS", "identificacion inválida (tipo como RUC o DNI y un número)");
  return { tipo, numero };
}

function revisarClaves(v, nivel) {
  if (nivel > MAX_NIVELES) throw new ErrorCliente("DATOS_INVALIDOS", `preferencias: demasiado anidado (máximo ${MAX_NIVELES} niveles)`);
  if (Array.isArray(v)) return v.forEach((x) => revisarClaves(x, nivel + 1));
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) {
      if (k.startsWith("$") || k.includes(".") || k === "__proto__")
        throw new ErrorCliente("DATOS_INVALIDOS", `preferencias: clave no permitida: ${k.slice(0, 20)}`);
      revisarClaves(v[k], nivel + 1);
    }
  }
}

/** Bloque flexible de cada servicio (entrega, agencia, forma de pago...). Se reemplaza completo. */
export function validarPreferencias(p) {
  if (p === undefined) return undefined;
  if (p === null) return {};
  if (typeof p !== "object" || Array.isArray(p))
    throw new ErrorCliente("DATOS_INVALIDOS", "preferencias debe ser un objeto");
  revisarClaves(p, 1);
  if (Buffer.byteLength(JSON.stringify(p)) > MAX_BYTES_PREFERENCIAS)
    throw new ErrorCliente("DATOS_INVALIDOS", `preferencias: máximo ${MAX_BYTES_PREFERENCIAS} bytes`);
  return p;
}

/**
 * Teléfono: si trae "+" el país sale del número; si no, se usa `paisTelefono` (si se indicó para este
 * número) o el país de la empresa. Devuelve `{ telefono, telefonoPais }`, o `{ telefono: null,
 * telefonoPais: null }` para quitarlo, o `undefined` si no se toca.
 */
export function validarTelefono(telefono, { paisTelefono, paisEmpresa } = {}) {
  if (telefono === undefined) return undefined;
  if (telefono === null || telefono === "") return { telefono: null, telefonoPais: null };
  try {
    const pais = paisTelefono !== undefined && paisTelefono !== null ? normalizarPais(paisTelefono) : paisEmpresa;
    const r = normalizarTelefono(telefono, pais);
    return { telefono: r.telefono, telefonoPais: r.pais };
  } catch (e) {
    throw new ErrorCliente("DATOS_INVALIDOS", e.message);
  }
}

export function validarFinalidad(f) {
  if (!FINALIDADES.includes(f))
    throw new ErrorCliente("DATOS_INVALIDOS", `finalidad inválida (admitidas: ${FINALIDADES.join(", ")})`);
  return f;
}

export function validarMedio(m) {
  if (!MEDIOS.includes(m))
    throw new ErrorCliente("DATOS_INVALIDOS", `medio inválido (admitidos: ${MEDIOS.join(", ")})`);
  return m;
}

/**
 * Valida todos los campos de la ficha. `crear: true` exige el nombre.
 * Devuelve los cambios ya limpios; `null` significa "quitar" y `undefined` "no tocar".
 */
export function prepararDatos(e, { crear = false, paisEmpresa } = {}) {
  const t = validarTelefono(e.telefono, { paisTelefono: e.paisTelefono, paisEmpresa });
  const datos = {
    nombre: crear || e.nombre !== undefined ? validarNombre(e.nombre) : undefined,
    telefono: t?.telefono,
    telefonoPais: t?.telefonoPais,
    correo: validarCorreo(e.correo),
    redes: validarRedes(e.redes),
    identificacion: validarIdentificacion(e.identificacion),
    direccion: validarDireccion(e.direccion),
    preferencias: validarPreferencias(e.preferencias),
  };
  return datos;
}
