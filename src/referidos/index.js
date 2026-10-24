import { randomInt } from "node:crypto";
import { conEmpresa } from "../tenancy.js";
import { ErrorAuth } from "../auth/errores.js";
import { ErrorCliente } from "../clientes/errores.js";
import { ErrorFidelizacion } from "../fidelizacion/errores.js";
import { configDe } from "../fidelizacion/config.js";

const ID = /^[0-9a-f]{24}$/i;
const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin 0/O/1/I: se dicta y se copia sin confundirse
const LARGO_CODIGO = 7;
const MAX_LISTA = 100;

/** Normaliza lo que escribe una persona: mayúsculas, sin espacios ni guiones. */
export const normalizarCodigoReferido = (c) => (typeof c === "string" ? c.toUpperCase().replace(/[\s-]/g, "") : "");
export const generarCodigoReferido = () => Array.from({ length: LARGO_CODIGO }, () => ALFABETO[randomInt(ALFABETO.length)]).join("");

/**
 * Referidos (arquitectura 5.45): «trae a un amigo y los dos ganan puntos».
 *
 * Cada cliente tiene un código (se crea al pedirlo). Una ficha NUEVA (sin consumos pagados con puntos y sin referente)
 * se vincula a quien la refirió: al registrarse con el código, o cuando el personal lo anota. El premio se da en el
 * primer consumo pagado del referido (si llega al mínimo configurado): puntos `bono` para los dos, con tope de
 * referidos premiados por cliente. Todo es idempotente: cada premio tiene su clave en el libro de puntos.
 */
export function crearServicioReferidos({ Empresa, Cliente, Referido, MovimientoPuntos }, fidelizacion, clientes, auth) {
  const malo = (codigo, m) => new ErrorFidelizacion(codigo, m);
  const idValido = (v, nombre) => {
    if (!ID.test(String(v ?? ""))) throw malo("DATOS_INVALIDOS", `${nombre} inválido`);
    return String(v);
  };
  const configDeEmpresa = async (empresaId) => {
    const e = await Empresa.findById(empresaId).lean();
    if (!e || e.activa === false) throw malo("NO_ENCONTRADO", "empresa no encontrada");
    return configDe(e).referidos;
  };
  const activo = (c) => c && c.activo !== false && !c.anonimizadoTs;

  // ---------- código ----------
  /** El código de referido de un cliente; lo crea la primera vez. */
  async function codigoDe({ empresaId, clienteId }) {
    idValido(clienteId, "clienteId");
    return await conEmpresa(empresaId, async () => {
      for (let intento = 0; intento < 8; intento++) {
        const c = await Cliente.findById(clienteId).select("codigoReferido activo anonimizadoTs").lean();
        if (!c) throw malo("NO_ENCONTRADO", "cliente no encontrado");
        if (c.codigoReferido) return c.codigoReferido;
        if (!activo(c)) throw malo("ESTADO_INVALIDO", "el cliente está desactivado o anonimizado");
        try {
          await Cliente.updateOne({ _id: clienteId, codigoReferido: null }, { $set: { codigoReferido: generarCodigoReferido() } });
        } catch (e) {
          if (e?.code !== 11000) throw e; // código repetido: se vuelve a intentar con otro
        }
      }
      throw malo("ESTADO_INVALIDO", "no se pudo crear el código de referido");
    });
  }

  /** El cliente dueño de un código (activo), o null. */
  async function buscarPorCodigo({ empresaId, codigo }) {
    const cod = normalizarCodigoReferido(codigo);
    if (cod.length !== LARGO_CODIGO) return null;
    const c = await conEmpresa(empresaId, async () => await Cliente.findOne({ codigoReferido: cod }).select("nombre activo anonimizadoTs").lean());
    return activo(c) ? c : null;
  }

  // ---------- vincular ----------
  /**
   * Anota que `referidoId` llegó por el cliente dueño de `codigo`. Solo fichas nuevas: sin referente anterior y sin
   * consumos que hayan dado puntos. Falla con ESTADO_INVALIDO / NO_ENCONTRADO / DATOS_INVALIDOS.
   */
  async function vincular({ empresaId, referidoId, codigo, origen = "personal", creadoPor = null }) {
    idValido(referidoId, "clienteId");
    if (!["registro", "personal"].includes(origen)) throw malo("DATOS_INVALIDOS", "origen inválido");
    if (!normalizarCodigoReferido(codigo)) throw malo("DATOS_INVALIDOS", "indica el código de referido");
    const cfg = await configDeEmpresa(empresaId);
    if (!cfg.habilitada) throw malo("ESTADO_INVALIDO", "el programa de referidos está desactivado");
    const referente = await buscarPorCodigo({ empresaId, codigo });
    if (!referente) throw malo("NO_ENCONTRADO", "código de referido no válido");
    if (String(referente._id) === String(referidoId)) throw malo("ESTADO_INVALIDO", "un cliente no puede referirse a sí mismo");

    return await conEmpresa(empresaId, async () => {
      const c = await Cliente.findById(referidoId).select("activo anonimizadoTs").lean();
      if (!c) throw malo("NO_ENCONTRADO", "cliente no encontrado");
      if (!activo(c)) throw malo("ESTADO_INVALIDO", "el cliente está desactivado o anonimizado");
      if (await Referido.findOne({ referidoId }).lean()) throw malo("ESTADO_INVALIDO", "este cliente ya tiene quien lo refirió");
      if (await MovimientoPuntos.findOne({ clienteId: referidoId, tipo: "acumulo" }).lean())
        throw malo("ESTADO_INVALIDO", "solo una ficha nueva puede ser referida: este cliente ya consumió");
      try {
        const r = await Referido.create({ referenteId: referente._id, referidoId, origen, estado: "pendiente", ts: new Date(), creadoPor });
        return { id: String(r._id), estado: r.estado, referente: { id: String(referente._id), nombre: referente.nombre } };
      } catch (e) {
        if (e?.code === 11000) throw malo("ESTADO_INVALIDO", "este cliente ya tiene quien lo refirió");
        throw e;
      }
    });
  }

  // ---------- premio ----------
  /**
   * Se llama en cada acumulación de puntos (ver `fidelizacion.alAcumular`). Si el cliente tiene un referido
   * pendiente y su pago llega al mínimo, da los premios. Devuelve `{ premiado, ... }` o `{ premiado: false, motivo }`.
   */
  async function alAcumular({ empresaId, clienteId, monto, code }) {
    return await conEmpresa(empresaId, async () => {
      const r = await Referido.findOne({ referidoId: clienteId, estado: "pendiente" }).lean();
      if (!r) return { premiado: false, motivo: "sin_referido" };
      const cfg = await configDeEmpresa(empresaId);
      if (!cfg.habilitada) return { premiado: false, motivo: "deshabilitado" };
      if (typeof monto !== "number" || monto < cfg.consumoMinimo) return { premiado: false, motivo: "bajo_minimo" };

      const premiados = await Referido.countDocuments({ referenteId: r.referenteId, estado: "premiado" });
      if (premiados >= cfg.maxPorCliente) {
        await Referido.updateOne({ _id: r._id, estado: "pendiente" }, { $set: { estado: "sin_cupo" } });
        return { premiado: false, motivo: "sin_cupo" };
      }

      const dar = async (id, puntos, detalle, clave) => {
        if (puntos < 1) return 0;
        const b = await fidelizacion.otorgarBono({ empresaId, clienteId: id, puntos, detalle, clave });
        return b.otorgado ? puntos : 0;
      };
      const [nombreReferido, nombreReferente] = await Promise.all([
        Cliente.findById(clienteId).select("nombre").lean(),
        Cliente.findById(r.referenteId).select("nombre").lean(),
      ]);
      const aReferente = await dar(r.referenteId, cfg.puntosReferente, `Referido: ${nombreReferido?.nombre ?? "un amigo"} consumió`, `referido:${r._id}:referente`);
      const aReferido = await dar(clienteId, cfg.puntosReferido, `Bienvenida: te invitó ${nombreReferente?.nombre ?? "un amigo"}`, `referido:${r._id}:referido`);
      const ok = await Referido.updateOne(
        { _id: r._id, estado: "pendiente" },
        { $set: { estado: "premiado", premiadoTs: new Date(), puntosReferente: aReferente, puntosReferido: aReferido, documentoCode: code ?? null } },
      );
      return { premiado: ok.modifiedCount !== 0, referenteId: String(r.referenteId), puntosReferente: aReferente, puntosReferido: aReferido };
    });
  }
  fidelizacion.alAcumular(alAcumular);

  // ---------- consultas ----------
  const inicial = (n) => {
    const [a, b] = String(n ?? "").trim().split(/\s+/);
    return b ? `${a} ${b[0].toUpperCase()}.` : (a ?? "");
  };

  /** Lo que ve un cliente (o el personal en su ficha): su código, las reglas y a quiénes ha traído. */
  async function mio({ empresaId, clienteId, incluirCodigoSiempre = false }) {
    idValido(clienteId, "clienteId");
    const cfg = await configDeEmpresa(empresaId);
    const base = { habilitada: cfg.habilitada, puntosReferente: cfg.puntosReferente, puntosReferido: cfg.puntosReferido, consumoMinimo: cfg.consumoMinimo, maxPorCliente: cfg.maxPorCliente };
    if (!cfg.habilitada && !incluirCodigoSiempre) return { ...base, codigo: null, referidos: [], premiados: 0, pendientes: 0, cupoRestante: cfg.maxPorCliente, fueReferido: false };
    const codigo = await codigoDe({ empresaId, clienteId });
    return await conEmpresa(empresaId, async () => {
      const lista = await Referido.find({ referenteId: clienteId }).sort({ ts: -1 }).limit(MAX_LISTA).lean();
      const ids = lista.map((r) => r.referidoId);
      const nombres = new Map((await Cliente.find({ _id: { $in: ids } }).select("nombre").lean()).map((c) => [String(c._id), c.nombre]));
      const premiados = await Referido.countDocuments({ referenteId: clienteId, estado: "premiado" });
      const pendientes = await Referido.countDocuments({ referenteId: clienteId, estado: "pendiente" });
      const fueReferido = !!(await Referido.findOne({ referidoId: clienteId }).lean());
      return {
        ...base,
        codigo,
        referidos: lista.map((r) => ({ nombre: inicial(nombres.get(String(r.referidoId))), estado: r.estado, ts: r.ts, puntos: r.estado === "premiado" ? r.puntosReferente : 0 })),
        premiados,
        pendientes,
        cupoRestante: Math.max(0, cfg.maxPorCliente - premiados),
        fueReferido,
      };
    });
  }

  /** Lista para el personal: todos los referidos de la empresa, con los nombres de los dos. */
  async function listar({ empresaId, estado, limite = 50, saltar = 0 }) {
    if (estado !== undefined && estado !== "" && !["pendiente", "premiado", "sin_cupo"].includes(estado)) throw malo("DATOS_INVALIDOS", "estado inválido");
    const lim = Math.min(Math.max(Math.trunc(Number(limite)) || 50, 1), MAX_LISTA);
    const skip = Math.max(Math.trunc(Number(saltar)) || 0, 0);
    return await conEmpresa(empresaId, async () => {
      const filtro = estado ? { estado } : {};
      const [items, total, premiados, pendientes] = await Promise.all([
        Referido.find(filtro).sort({ ts: -1 }).skip(skip).limit(lim).lean(),
        Referido.countDocuments(filtro),
        Referido.countDocuments({ estado: "premiado" }),
        Referido.countDocuments({ estado: "pendiente" }),
      ]);
      const ids = [...new Set(items.flatMap((r) => [String(r.referenteId), String(r.referidoId)]))];
      const nombres = new Map((await Cliente.find({ _id: { $in: ids } }).select("nombre").lean()).map((c) => [String(c._id), c.nombre]));
      return {
        total,
        resumen: { premiados, pendientes },
        referidos: items.map((r) => ({
          id: String(r._id),
          referente: { id: String(r.referenteId), nombre: nombres.get(String(r.referenteId)) ?? null },
          referido: { id: String(r.referidoId), nombre: nombres.get(String(r.referidoId)) ?? null },
          estado: r.estado,
          origen: r.origen,
          ts: r.ts,
          premiadoTs: r.premiadoTs ?? null,
          puntosReferente: r.puntosReferente ?? 0,
          puntosReferido: r.puntosReferido ?? 0,
        })),
      };
    });
  }

  // ---------- Express ----------
  const responder = (res, e, next) => {
    if (e instanceof ErrorFidelizacion || e instanceof ErrorCliente || e instanceof ErrorAuth)
      return res.status(e.status).json({ error: e.message, codigo: e.codigo });
    return next(e);
  };
  const envolver = (escribe, fn) => async (req, res, next) => {
    try {
      if (escribe) auth.exigirCsrf(req);
      await fn(req, res);
    } catch (e) {
      responder(res, e, next);
    }
  };
  const manejadores = {
    /** GET /clientes/referidos?estado=&limite=&saltar= → { total, resumen, referidos } (fidelizacion:gestionar) */
    listar: envolver(false, async (req, res) =>
      res.status(200).json(await listar({ empresaId: req.auth.empresaId, estado: req.query?.estado, limite: req.query?.limite, saltar: req.query?.saltar })),
    ),
    /** GET /clientes/:clienteId/referidos → su código y a quiénes trajo (cliente:leer) */
    deCliente: envolver(false, async (req, res) => {
      const clienteId = idValido(req.params?.clienteId, "clienteId");
      await clientes.obtener({ empresaId: req.auth.empresaId, clienteId }); // 404 si no existe
      res.status(200).json(await mio({ empresaId: req.auth.empresaId, clienteId, incluirCodigoSiempre: true }));
    }),
    /** POST /clientes/:clienteId/referente { codigo } → 201: anota quién refirió a esta ficha nueva (cliente:editar) */
    vincular: envolver(true, async (req, res) =>
      res.status(201).json(
        await vincular({ empresaId: req.auth.empresaId, referidoId: req.params?.clienteId, codigo: req.body?.codigo, origen: "personal", creadoPor: req.auth.usuarioId }),
      ),
    ),
  };

  return { config: async ({ empresaId }) => await configDeEmpresa(empresaId), codigoDe, buscarPorCodigo, vincular, alAcumular, mio, listar, manejadores, listo: () => Promise.all([Referido.init(), Cliente.init()]) };
}
