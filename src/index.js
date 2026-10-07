import { createModelRegistry } from "./registry.js";
import { registrarModelos } from "./modelos/index.js";
import { crearServicioEmpresas } from "./empresas.js";
import { crearMiddlewarePermisos } from "./middleware.js";
import { crearServicioDocumentos } from "./documentos/index.js";
import { crearServicioEventos } from "./eventos/index.js";
import { crearServicioAuth } from "./auth/index.js";
import { montarRutas } from "./auth/rutas.js";

export {
  conEmpresa,
  empresaActual,
  tenancyPlugin,
  marcarGlobal,
} from "./tenancy.js";
export { permite } from "./permisos.js";
export { ErrorDocumento } from "./documentos/index.js";
export { ErrorEvento, conContexto, contextoActual } from "./eventos/index.js";
export { ErrorAuth } from "./auth/index.js";
export { hashPassword, verificarPassword } from "./password.js";

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
 * @param {{ connection: import('mongoose').Connection, plugins?: Function[], auth?: object }} opts
 */
export function createCore({ connection, plugins = [], auth = {} } = {}) {
  if (!esConexionMongoose(connection)) {
    throw new Error(
      "createCore: se requiere { connection } (una Connection de Mongoose ya creada)",
    );
  }

  const registry = createModelRegistry(connection, plugins);

  const core = {
    connection,
    model: registry.model,
    use: registry.use,
    estado: () => ESTADOS[connection.readyState],
    async ping() {
      if (connection.readyState !== 1)
        return { ok: false, estado: ESTADOS[connection.readyState] };
      await connection.db.admin().ping();
      return { ok: true, estado: "conectado" };
    },
  };

  core.modelos = registrarModelos(core);
  core.empresas = crearServicioEmpresas(core.modelos);
  core.requierePermiso = crearMiddlewarePermisos(core.modelos);
  core.documentos = crearServicioDocumentos(core.modelos);
  core.eventos = crearServicioEventos(core.modelos, core.documentos);
  core.auth = crearServicioAuth(core.modelos, auth);
  core.autenticar = core.auth.autenticar;
  core.auth.montarRutas = (router) => montarRutas(router, core);

  return core;
}
