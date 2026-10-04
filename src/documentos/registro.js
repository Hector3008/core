import { ErrorDocumento } from "./errores.js";

const esTexto = (x) => typeof x === "string" && x.length > 0;

// Valida la declaración de un tipo y la deja en una forma lista para consultar.
function normalizar(def) {
  const {
    tipo,
    prefijo,
    estadoInicial,
    transiciones = {},
    permisos = {},
    motivos = {},
    editables,
  } = def ?? {};

  if (!esTexto(tipo)) throw new Error("registrarTipo: falta 'tipo'");
  if (!/^[A-Z0-9]{1,6}$/.test(prefijo ?? ""))
    throw new Error(
      `registrarTipo(${tipo}): 'prefijo' va en mayúsculas y números, de 1 a 6 caracteres (ej. "DP")`,
    );
  if (!esTexto(estadoInicial))
    throw new Error(`registrarTipo(${tipo}): falta 'estadoInicial'`);

  // Los estados son todos los que aparecen como origen o destino de una transición
  const estados = new Set([estadoInicial]);
  for (const [de, hacia] of Object.entries(transiciones)) {
    if (!Array.isArray(hacia) || !hacia.every(esTexto))
      throw new Error(
        `registrarTipo(${tipo}): transiciones.${de} debe ser una lista de estados`,
      );
    estados.add(de);
    hacia.forEach((e) => estados.add(e));
  }

  for (const [estado, permiso] of Object.entries(permisos)) {
    if (!estados.has(estado))
      throw new Error(`registrarTipo(${tipo}): permisos.${estado}: estado desconocido`);
    if (!esTexto(permiso))
      throw new Error(`registrarTipo(${tipo}): permisos.${estado} debe ser un texto`);
  }

  for (const [estado, lista] of Object.entries(motivos)) {
    if (!estados.has(estado))
      throw new Error(`registrarTipo(${tipo}): motivos.${estado}: estado desconocido`);
    if (!Array.isArray(lista) || !lista.length || !lista.every(esTexto))
      throw new Error(
        `registrarTipo(${tipo}): motivos.${estado} debe ser una lista no vacía de códigos`,
      );
  }

  const conSalida = (e) => (transiciones[e]?.length ?? 0) > 0;
  const todos = [...estados];

  // Por defecto se puede editar mientras el documento no esté en un estado final
  const editablesFinal = editables ?? todos.filter(conSalida);
  if (!Array.isArray(editablesFinal) || !editablesFinal.every((e) => estados.has(e)))
    throw new Error(`registrarTipo(${tipo}): 'editables' tiene estados desconocidos`);

  return Object.freeze({
    tipo,
    prefijo,
    estadoInicial,
    estados: todos,
    finales: todos.filter((e) => !conSalida(e)),
    transiciones: Object.fromEntries(
      Object.entries(transiciones).map(([k, v]) => [k, [...v]]),
    ),
    permisos: { ...permisos },
    motivos: Object.fromEntries(
      Object.entries(motivos).map(([k, v]) => [k, [...v]]),
    ),
    editables: [...editablesFinal],
  });
}

// Las reglas de cada tipo viven en memoria: cada servicio las registra al arrancar.
export function crearRegistroTipos() {
  const tipos = new Map();

  return {
    registrar(def) {
      const nuevo = normalizar(def);
      const previo = tipos.get(nuevo.tipo);
      if (previo) {
        // Idempotente (el gateway puede montar un servicio dos veces); distinto, no.
        if (JSON.stringify(previo) === JSON.stringify(nuevo)) return previo;
        throw new Error(
          `registrarTipo: el tipo '${nuevo.tipo}' ya está registrado con otras reglas`,
        );
      }
      for (const t of tipos.values())
        if (t.prefijo === nuevo.prefijo)
          throw new Error(
            `registrarTipo: el prefijo '${nuevo.prefijo}' ya lo usa el tipo '${t.tipo}'`,
          );
      tipos.set(nuevo.tipo, nuevo);
      return nuevo;
    },

    obtener(tipo) {
      const def = tipos.get(tipo);
      if (!def)
        throw new ErrorDocumento(
          "TIPO_NO_REGISTRADO",
          `El tipo de documento '${tipo}' no está registrado`,
        );
      return def;
    },

    listar: () => [...tipos.values()],
  };
}
