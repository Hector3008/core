import { ErrorCatalogo } from "./errores.js";

/**
 * Atributos: el bloque flexible de cada ítem (PROVEEDOR, MARCA, UBICACION en repuestos; modificadores
 * en platos). El núcleo no sabe qué significan, pero cuida que sean datos estructurados (arquitectura 5.5):
 * números como números, listas como listas.
 *
 * Cada servicio declara al arrancar los campos que conoce con `core.catalogo.registrarEsquema`:
 *   { MARCA: "texto", EQUIVALENTES: "lista", STOCK_MINIMO: "numero" }
 * Un campo declarado se valida por tipo. Un campo no declarado se acepta (cualquier valor simple, lista u
 * objeto), con las mismas reglas de seguridad. La obligatoriedad NO se declara aquí: una empresa tiene un
 * solo catálogo y varios servicios, así que cada servicio exige lo suyo al armar sus documentos.
 */
export const TIPOS_ATRIBUTO = ["texto", "numero", "booleano", "lista"];
export const MAX_BYTES_ATRIBUTOS = 4096;
const MAX_NIVELES = 6;
const MAX_TEXTO = 500;
const NOMBRE_CAMPO = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** Registro (en memoria) de los campos conocidos. Viaja con el código de cada servicio, como los tipos de documento. */
export function crearRegistroEsquemas() {
  const campos = new Map();
  return {
    /** Idempotente con el mismo tipo; un tipo distinto para un campo ya declarado falla. */
    registrar(entrada) {
      const def = entrada && typeof entrada === "object" ? entrada.campos : undefined;
      if (!def || typeof def !== "object" || Array.isArray(def) || !Object.keys(def).length)
        throw new ErrorCatalogo("ESQUEMA_INVALIDO", "registrarEsquema requiere { campos: { NOMBRE: tipo } }");
      const nuevos = [];
      for (const [nombre, tipo] of Object.entries(def)) {
        if (!NOMBRE_CAMPO.test(nombre))
          throw new ErrorCatalogo("ESQUEMA_INVALIDO", `nombre de campo inválido: ${nombre.slice(0, 20)}`);
        if (!TIPOS_ATRIBUTO.includes(tipo))
          throw new ErrorCatalogo("ESQUEMA_INVALIDO", `${nombre}: tipo inválido (admitidos: ${TIPOS_ATRIBUTO.join(", ")})`);
        const previo = campos.get(nombre);
        if (previo && previo !== tipo)
          throw new ErrorCatalogo("ESQUEMA_INVALIDO", `${nombre} ya está declarado como ${previo}`);
        nuevos.push([nombre, tipo]);
      }
      for (const [n, t] of nuevos) campos.set(n, t); // todo o nada
    },
    tipoDe: (nombre) => campos.get(nombre),
    campos: () => Object.fromEntries(campos),
  };
}

function revisarClaves(v, nivel) {
  if (nivel > MAX_NIVELES)
    throw new ErrorCatalogo("DATOS_INVALIDOS", `atributos: demasiado anidado (máximo ${MAX_NIVELES} niveles)`);
  if (Array.isArray(v)) return v.forEach((x) => revisarClaves(x, nivel + 1));
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) {
      if (k.startsWith("$") || k.includes(".") || k === "__proto__")
        throw new ErrorCatalogo("DATOS_INVALIDOS", `atributos: clave no permitida: ${k.slice(0, 20)}`);
      revisarClaves(v[k], nivel + 1);
    }
  }
}

function revisarValor(v, nivel = 1) {
  if (v === null || typeof v === "boolean") return;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new ErrorCatalogo("DATOS_INVALIDOS", "atributos: número inválido");
    return;
  }
  if (typeof v === "string") {
    if (v.length > MAX_TEXTO) throw new ErrorCatalogo("DATOS_INVALIDOS", `atributos: texto demasiado largo (máximo ${MAX_TEXTO})`);
    return;
  }
  if (Array.isArray(v)) return v.forEach((x) => revisarValor(x, nivel + 1));
  if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype)
    return Object.values(v).forEach((x) => revisarValor(x, nivel + 1));
  throw new ErrorCatalogo("DATOS_INVALIDOS", "atributos: solo texto, números, booleanos, listas y objetos simples");
}

const COMPRUEBA = {
  texto: (v) => typeof v === "string",
  numero: (v) => typeof v === "number" && Number.isFinite(v),
  booleano: (v) => typeof v === "boolean",
  lista: (v) => Array.isArray(v),
};

/**
 * Valida un bloque de atributos. `undefined` = no tocar. `null` = quitar todos (en un cambio parcial). Dentro
 * del objeto, un valor `null` significa "quitar esa clave" y se deja pasar sin comprobar su tipo.
 * No comprueba el tamaño total: eso se hace sobre el resultado final con `exigirTamano`.
 */
export function validarAtributos(a, registro) {
  if (a === undefined) return undefined;
  if (a === null) return null;
  if (typeof a !== "object" || Array.isArray(a) || Object.getPrototypeOf(a) !== Object.prototype)
    throw new ErrorCatalogo("DATOS_INVALIDOS", "atributos debe ser un objeto");
  revisarClaves(a, 1);
  for (const [k, v] of Object.entries(a)) {
    if (v === null) continue;
    revisarValor(v);
    const tipo = registro?.tipoDe(k);
    if (tipo && !COMPRUEBA[tipo](v))
      throw new ErrorCatalogo("DATOS_INVALIDOS", `atributos: ${k} debe ser ${tipo}`);
  }
  return a;
}

/** Quita las claves con valor null (para un ítem nuevo no hay nada que quitar). */
export const sinNulos = (a) =>
  Object.fromEntries(Object.entries(a ?? {}).filter(([, v]) => v !== null));

/** Aplica un cambio parcial sobre los atributos actuales (null quita la clave). */
export function fusionar(actual, parcial) {
  const r = { ...(actual ?? {}) };
  for (const [k, v] of Object.entries(parcial ?? {})) {
    if (v === null) delete r[k];
    else r[k] = v;
  }
  return r;
}

export function exigirTamano(a) {
  if (Buffer.byteLength(JSON.stringify(a ?? {})) > MAX_BYTES_ATRIBUTOS)
    throw new ErrorCatalogo("DATOS_INVALIDOS", `atributos: máximo ${MAX_BYTES_ATRIBUTOS} bytes`);
  return a;
}
