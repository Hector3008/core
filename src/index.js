import { createModelRegistry } from "./registry.js";

// readyState de Mongoose: 0 desconectado, 1 conectado, 2 conectando, 3 desconectando
const ESTADOS = {
  0: "desconectado",
  1: "conectado",
  2: "conectando",
  3: "desconectando",
};

function esConexionMongoose(c) {
  return (
    !!c &&
    typeof c.model === "function" &&
    typeof c.readyState === "number" &&
    !!c.base
  );
}

/**
 * El núcleo NO abre ni cierra conexiones: usa la que le pasa el gateway.
 * @param {{ connection: import('mongoose').Connection, plugins?: Function[] }} opts
 */
export function createCore({ connection, plugins = [] } = {}) {
  if (!esConexionMongoose(connection)) {
    throw new Error(
      "createCore: se requiere { connection } (una Connection de Mongoose ya creada)",
    );
  }

  const registry = createModelRegistry(connection, plugins);

  return {
    connection,
    // Registra (o devuelve, si ya existe) un modelo sobre la conexión del gateway.
    model: registry.model,
    // Plugin global que se aplicará a los modelos registrados DESPUÉS de llamarlo
    // (pieza 2 lo usará para el filtro por empresaId).
    use: registry.use,
    estado: () => ESTADOS[connection.readyState],
    // Útil para la ruta de salud del gateway.
    async ping() {
      if (connection.readyState !== 1)
        return { ok: false, estado: ESTADOS[connection.readyState] };
      await connection.db.admin().ping();
      return { ok: true, estado: "conectado" };
    },
  };
}
