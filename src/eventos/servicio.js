import { conEmpresa, empresaActual } from "../tenancy.js";
import { ErrorEvento } from "./errores.js";
import { conContexto, contextoActual } from "./contexto.js";
import {
  MAX_LOTE,
  normalizarEventoInterfaz,
  validarEstacion,
  validarSesionId,
} from "./validacion.js";

const EVENTOS_MOTOR = ["creado", "estado", "version"];
const LIMITE_MAX = 500;

/**
 * Eventos: colección append-only con dos fuentes.
 *  - servidor: se suscribe al motor de documentos y guarda cada `creado`, `estado` y `version`.
 *  - interfaz: lotes enviados por el front (registrarLote / manejadorLote).
 */
export function crearServicioEventos({ Evento }, documentos) {
  const pendientes = new Set();

  function exigirEmpresa() {
    if (!empresaActual())
      throw new Error("eventos: sin empresa activa (use conEmpresa)");
  }

  // Los eventos del servidor se guardan después de responder: si fallan, se registra
  // el error y la operación del usuario ya está hecha (igual que los escuchas del motor).
  function enSegundoPlano(promesa) {
    const p = promesa
      .catch((e) => console.error("eventos: no se pudo guardar un evento", e))
      .finally(() => pendientes.delete(p));
    pendientes.add(p);
  }

  // Se ejecuta de forma síncrona dentro del emit del motor, por eso aún ve el
  // contexto (estación, sesión) de la interacción que originó el cambio.
  function registrarDelMotor(nombre, ev) {
    const ctx = contextoActual();
    const doc = {
      usuarioId:
        ev.usuarioId ?? (ev.datos?.sistema ? null : (ctx?.usuarioId ?? null)),
      sesionId: ctx?.sesionId ?? null,
      documentoCode: ev.documentoCode,
      tipoDocumento: ev.tipoDocumento,
      version: ev.version,
      estacion: ctx?.estacion ?? null,
      tipo: `documento.${nombre}`,
      origen: "servidor",
      ts: ev.ts,
      recibidoTs: new Date(),
      datos: ev.datos ?? {},
    };
    enSegundoPlano(
      conEmpresa(ev.empresaId, async () => await Evento.create(doc)),
    );
  }

  for (const nombre of EVENTOS_MOTOR)
    documentos.on(nombre, (ev) => registrarDelMotor(nombre, ev));

  const servicio = {
    // Espera a que existan los índices
    listo: () => Evento.init().then(() => undefined),

    // Espera a que terminen las escrituras en segundo plano (pruebas y cierre ordenado)
    async vaciar() {
      while (pendientes.size) await Promise.allSettled([...pendientes]);
    },

    conContexto,
    contextoActual,

    /**
     * Middleware de Express. Deja { estacion, sesionId, usuarioId } para todo lo que
     * corra después en la request, de modo que los eventos del motor los lleven.
     * Va después de la autenticación (necesita req.auth). La sesión llega en el
     * encabezado `x-sesion-id`, que genera el front (un UUID por pestaña).
     */
    middleware({ estacion } = {}) {
      validarEstacion(estacion);
      return (req, res, next) => {
        let sesionId = null;
        try {
          sesionId = validarSesionId(req.get("x-sesion-id"));
        } catch {
          // Un encabezado mal formado no tumba la request: el evento queda sin sesión
        }
        conContexto(
          { estacion: estacion ?? null, sesionId, usuarioId: req.auth?.usuarioId ?? null },
          next,
        );
      };
    },

    /**
     * Guarda un lote de eventos de la interfaz. Todo o nada: si uno es inválido,
     * no se guarda ninguno y el error indica cuáles.
     * `estacion`, `sesionId` y `usuarioId` los fija quien llama (el servidor), no el cliente.
     */
    async registrarLote({ eventos, estacion, sesionId, usuarioId } = {}) {
      exigirEmpresa();
      if (!Array.isArray(eventos) || eventos.length === 0)
        throw new ErrorEvento("LOTE_INVALIDO", "eventos debe ser una lista no vacía");
      if (eventos.length > MAX_LOTE)
        throw new ErrorEvento("LOTE_INVALIDO", `un lote admite como máximo ${MAX_LOTE} eventos`);
      if (!usuarioId)
        throw new ErrorEvento("LOTE_INVALIDO", "falta usuarioId");

      const ctx = {
        estacion: validarEstacion(estacion),
        sesionId: validarSesionId(sesionId),
        usuarioId,
        recibidoTs: new Date(),
      };
      const filas = [];
      const errores = [];
      eventos.forEach((e, i) => {
        try {
          filas.push(normalizarEventoInterfaz(e, ctx));
        } catch (err) {
          if (!(err instanceof ErrorEvento)) throw err;
          errores.push({ indice: i, error: err.message });
        }
      });
      if (errores.length)
        throw new ErrorEvento("EVENTO_INVALIDO", "hay eventos inválidos en el lote", { errores });

      await Evento.insertMany(filas, { ordered: false });
      return { guardados: filas.length };
    },

    /**
     * Manejador de Express para POST de lotes: body { eventos: [...] }.
     * La estación la fija la ruta, no el cliente. Se monta detrás de la autenticación
     * y de requierePermiso("estacion:<nombre>"), y necesita express.json():
     *   router.post("/eventos", core.requierePermiso("estacion:revision"),
     *               core.eventos.manejadorLote({ estacion: "revision" }));
     */
    manejadorLote({ estacion } = {}) {
      validarEstacion(estacion);
      if (!estacion) throw new TypeError("manejadorLote: falta { estacion }");
      return async (req, res, next) => {
        const { usuarioId, empresaId } = req.auth ?? {};
        if (!usuarioId || !empresaId)
          return res.status(401).json({ error: "no autenticado" });
        try {
          const r = await conEmpresa(empresaId, async () =>
            servicio.registrarLote({
              eventos: req.body?.eventos,
              estacion,
              sesionId: req.get("x-sesion-id") ?? req.body?.sesionId,
              usuarioId,
            }),
          );
          res.status(201).json(r);
        } catch (e) {
          if (e instanceof ErrorEvento)
            return res
              .status(400)
              .json({ error: e.message, codigo: e.codigo, detalle: e.detalle });
          next(e);
        }
      };
    },

    // Orden cronológico (ts ascendente). Máximo 500 por llamada.
    async listar({
      documentoCode,
      tipo,
      estacion,
      usuarioId,
      sesionId,
      desde,
      hasta,
      limite = 100,
      saltar = 0,
    } = {}) {
      exigirEmpresa();
      const filtro = {};
      if (documentoCode) filtro.documentoCode = documentoCode;
      if (tipo) filtro.tipo = Array.isArray(tipo) ? { $in: tipo } : tipo;
      if (estacion) filtro.estacion = estacion;
      if (usuarioId) filtro.usuarioId = usuarioId;
      if (sesionId) filtro.sesionId = sesionId;
      if (desde || hasta) {
        filtro.ts = {};
        if (desde) filtro.ts.$gte = new Date(desde);
        if (hasta) filtro.ts.$lt = new Date(hasta);
      }
      return await Evento.find(filtro)
        .sort({ ts: 1, _id: 1 })
        .skip(saltar)
        .limit(Math.min(limite, LIMITE_MAX))
        .lean();
    },
  };

  return servicio;
}
