import mongoose from "mongoose";
import { conEmpresa } from "../tenancy.js";
import { permite } from "../permisos.js";
import { ErrorAuth } from "../auth/errores.js";
import { ErrorCliente } from "../clientes/errores.js";
import { ErrorFidelizacion } from "./errores.js";
import { calcularPuntos, configDe, validarConfig, validarDetalle, validarPuntos } from "./config.js";

const ID = /^[0-9a-f]{24}$/i;
const MAX_MOVIMIENTOS = 100;

/**
 * Fidelización: puntos de los clientes (arquitectura 5.11 y 5.25).
 *
 * Un libro de movimientos de solo inserción por empresa; el saldo se calcula sumándolos. Los puntos se acumulan
 * cuando un documento llega a su estado de cobro (en el restaurante, el pedido `pagado`), escuchando el evento
 * `estado` del motor, y solo si el cliente dio su consentimiento de `programaPuntos`. Es idempotente: un documento
 * acumula una sola vez (índice único por `{ empresaId, documentoCode, tipo }`).
 *
 * El núcleo no sabe de pedidos: cada servicio dice cuándo y de dónde salen los puntos con `registrarFuente`.
 *   core.fidelizacion.registrarFuente({
 *     tipo: "pedido", estado: "pagado",
 *     extraer: (doc) => ({ clienteId, monto, detalle? }),   // doc = lo que devuelve core.documentos.obtener
 *   });
 *
 * Toda operación que cambia algo recibe `actor = { usuarioId, permisos }` y comprueba su permiso:
 *   fidelizacion:canjear    → descontar puntos canjeados (los autoriza el personal, por ejemplo el mesero)
 *   fidelizacion:gestionar  → ajustes manuales y la configuración de la empresa
 */
export function crearServicioFidelizacion({ Empresa, MovimientoPuntos }, documentos, clientes, auth) {
  const fuentes = new Map(); // "tipo:estado" -> { tipo, estado, extraer }

  // ---------- ayudas ----------
  const exigir = (actor, permiso) => {
    if (!actor || !Array.isArray(actor.permisos))
      throw new ErrorFidelizacion("PERMISO_INSUFICIENTE", "se requiere quién realiza la operación");
    if (!permite(actor.permisos, permiso))
      throw new ErrorFidelizacion("PERMISO_INSUFICIENTE", `permiso insuficiente (${permiso})`);
  };

  const idValido = (v, nombre) => {
    if (!ID.test(String(v ?? ""))) throw new ErrorFidelizacion("DATOS_INVALIDOS", `${nombre} inválido`);
    return String(v);
  };

  async function empresaDe(empresaId) {
    const e = await Empresa.findById(empresaId).lean();
    if (!e || e.activa === false) throw new ErrorFidelizacion("NO_ENCONTRADO", "empresa no encontrada");
    return e;
  }

  const movimientoDto = (m) => ({
    id: String(m._id),
    tipo: m.tipo,
    puntos: m.puntos,
    ts: m.ts,
    detalle: m.detalle ?? null,
    documentoCode: m.documentoCode ?? null,
  });

  // El cliente debe existir (de esta empresa) y estar activo. `clientes.obtener` ya lanza NO_ENCONTRADO.
  async function clienteActivo(empresaId, clienteId) {
    try {
      const c = await clientes.obtener({ empresaId, clienteId });
      if (!c.activo || c.anonimizado) throw new ErrorFidelizacion("ESTADO_INVALIDO", "el cliente está desactivado o anonimizado");
      return c;
    } catch (e) {
      if (e instanceof ErrorCliente) throw new ErrorFidelizacion(e.codigo === "NO_ENCONTRADO" ? "NO_ENCONTRADO" : "DATOS_INVALIDOS", e.message);
      throw e;
    }
  }

  // ---------- configuración de la empresa ----------
  async function leerConfig({ empresaId }) {
    return configDe(await empresaDe(empresaId));
  }

  async function guardarConfig({ empresaId, actor, ...cambios }) {
    exigir(actor, "fidelizacion:gestionar");
    const c = validarConfig(cambios);
    await empresaDe(empresaId);
    const $set = Object.fromEntries(Object.entries(c).map(([k, v]) => [`fidelizacion.${k}`, v]));
    await Empresa.updateOne({ _id: empresaId }, { $set });
    return leerConfig({ empresaId });
  }

  // ---------- saldo y movimientos ----------
  async function saldo({ empresaId, clienteId }) {
    idValido(clienteId, "clienteId");
    return await conEmpresa(empresaId, async () => {
      const r = await MovimientoPuntos.aggregate([
        { $match: { clienteId: new mongoose.Types.ObjectId(String(clienteId)) } },
        { $group: { _id: null, total: { $sum: "$puntos" } } },
      ]);
      return r[0]?.total ?? 0;
    });
  }

  /** El saldo y los últimos movimientos de un cliente (más recientes primero). */
  async function resumen({ empresaId, clienteId, limite = 20 }) {
    idValido(clienteId, "clienteId");
    const lim = Math.min(Math.max(Math.trunc(Number(limite)) || 20, 1), MAX_MOVIMIENTOS);
    const movs = await conEmpresa(empresaId, async () =>
      await MovimientoPuntos.find({ clienteId }).sort({ ts: -1, _id: -1 }).limit(lim).lean(),
    );
    const config = configDe(await empresaDe(empresaId));
    return { habilitada: config.habilitada, saldo: await saldo({ empresaId, clienteId }), movimientos: movs.map(movimientoDto) };
  }

  async function insertar({ empresaId, clienteId, tipo, puntos, detalle, documentoCode = null, creadoPor = null }) {
    return await conEmpresa(empresaId, async () =>
      await MovimientoPuntos.create({ clienteId, tipo, puntos, detalle, documentoCode, creadoPor, ts: new Date() }),
    );
  }

  // ---------- acumular ----------
  /** Un servicio declara cuándo un documento da puntos y de dónde salen el cliente y el monto. */
  function registrarFuente({ tipo, estado, extraer } = {}) {
    if (typeof tipo !== "string" || !tipo || typeof estado !== "string" || !estado || typeof extraer !== "function")
      throw new Error("registrarFuente: se requiere { tipo, estado, extraer }");
    fuentes.set(`${tipo}:${estado}`, { tipo, estado, extraer });
  }

  /**
   * Acumula los puntos de un documento que ya llegó a su estado de cobro. Idempotente: si el documento ya
   * acumuló, devuelve lo registrado con `yaRegistrado: true`. Nunca falla por falta de cliente, de consentimiento
   * o de monto: devuelve `{ acumulados: 0, motivo }` (`sin_regla`, `deshabilitada`, `sin_cliente`, `sin_monto`,
   * `sin_puntos`, `cliente_no_encontrado`, `cliente_inactivo`, `sin_consentimiento`).
   */
  async function acumularPorDocumento({ empresaId, code }) {
    return await conEmpresa(empresaId, async () => {
      const d = await documentos.obtener({ code });
      if (!d) throw new ErrorFidelizacion("NO_ENCONTRADO", "documento no encontrado");
      const fuente = fuentes.get(`${d.tipo}:${d.estado}`);
      if (!fuente) return { acumulados: 0, motivo: "sin_regla" };

      const previo = await MovimientoPuntos.findOne({ documentoCode: code, tipo: "acumulo" }).lean();
      if (previo)
        return { acumulados: previo.puntos, yaRegistrado: true, clienteId: String(previo.clienteId), saldo: await saldo({ empresaId, clienteId: previo.clienteId }) };

      const config = configDe(await empresaDe(empresaId));
      if (!config.habilitada) return { acumulados: 0, motivo: "deshabilitada" };
      const { clienteId, monto, detalle } = fuente.extraer(d) ?? {};
      if (!clienteId || !ID.test(String(clienteId))) return { acumulados: 0, motivo: "sin_cliente" };
      if (typeof monto !== "number" || monto <= 0) return { acumulados: 0, motivo: "sin_monto" };
      const puntos = calcularPuntos(monto, config.puntosPorUnidad);
      if (puntos < 1) return { acumulados: 0, motivo: "sin_puntos" };

      let consiente;
      try {
        consiente = await clientes.tieneConsentimiento({ empresaId, clienteId, finalidad: "programaPuntos" });
      } catch (e) {
        if (e instanceof ErrorCliente && e.codigo === "NO_ENCONTRADO") return { acumulados: 0, motivo: "cliente_no_encontrado" };
        throw e;
      }
      if (!consiente) {
        // Distingue «no consintió» de «el cliente ya no está activo» para que el personal sepa qué decirle.
        const c = await clientes.obtener({ empresaId, clienteId });
        return { acumulados: 0, motivo: !c.activo || c.anonimizado ? "cliente_inactivo" : "sin_consentimiento", clienteId: String(clienteId) };
      }

      try {
        await insertar({
          empresaId,
          clienteId,
          tipo: "acumulo",
          puntos,
          detalle: validarDetalle(detalle ?? "Pedido pagado"),
          documentoCode: code,
        });
      } catch (e) {
        // Otro proceso (el escucha del motor y la propia operación) lo registró a la vez: es lo mismo.
        if (e?.code !== 11000) throw e;
        return { acumulados: puntos, yaRegistrado: true, clienteId: String(clienteId), saldo: await saldo({ empresaId, clienteId }) };
      }
      return { acumulados: puntos, clienteId: String(clienteId), saldo: await saldo({ empresaId, clienteId }) };
    });
  }

  // El motor emite `estado` después de guardar. Un fallo aquí no rompe la operación del usuario: se registra y
  // `acumularPorDocumento` se puede repetir (es idempotente).
  documentos.on("estado", async (ev) => {
    if (!fuentes.has(`${ev.tipoDocumento}:${ev.datos?.a}`)) return;
    try {
      await acumularPorDocumento({ empresaId: ev.empresaId, code: ev.documentoCode });
    } catch (e) {
      console.error(`fidelizacion: no se pudieron acumular los puntos de ${ev.documentoCode}`, e);
    }
  });

  // ---------- canjear y ajustar ----------
  /**
   * Descuenta puntos canjeados por un beneficio. Los autoriza el personal; el beneficio en sí (un descuento, un
   * plato de regalo) lo aplica quien atiende. Límite conocido: comprobar el saldo y escribir no es atómico; dos
   * canjes simultáneos del mismo cliente podrían dejarlo en negativo.
   */
  async function canjear({ empresaId, actor, clienteId, puntos, detalle }) {
    exigir(actor, "fidelizacion:canjear");
    validarPuntos(puntos);
    const det = validarDetalle(detalle) ?? "Canje de beneficio";
    await clienteActivo(empresaId, clienteId);
    const actual = await saldo({ empresaId, clienteId });
    if (actual < puntos)
      throw new ErrorFidelizacion("SALDO_INSUFICIENTE", `saldo insuficiente (${actual} puntos)`, { saldo: actual });
    await insertar({ empresaId, clienteId, tipo: "canje", puntos: -puntos, detalle: det, creadoPor: actor.usuarioId ?? null });
    return { saldo: actual - puntos };
  }

  /** Corrección manual del saldo (positiva o negativa). El motivo es obligatorio: queda en el libro. */
  async function ajustar({ empresaId, actor, clienteId, puntos, detalle }) {
    exigir(actor, "fidelizacion:gestionar");
    if (!Number.isInteger(puntos) || puntos === 0 || Math.abs(puntos) > 1_000_000)
      throw new ErrorFidelizacion("DATOS_INVALIDOS", "puntos: un entero distinto de 0 (hasta 1.000.000, con signo)");
    const det = validarDetalle(detalle, { obligatorio: true });
    await clienteActivo(empresaId, clienteId);
    const actual = await saldo({ empresaId, clienteId });
    if (actual + puntos < 0)
      throw new ErrorFidelizacion("SALDO_INSUFICIENTE", `el ajuste dejaría el saldo en negativo (${actual} puntos)`, { saldo: actual });
    await insertar({ empresaId, clienteId, tipo: "ajuste", puntos, detalle: det, creadoPor: actor.usuarioId ?? null });
    return { saldo: actual + puntos };
  }

  // ---------- Express ----------
  const responder = (res, e, next) => {
    if (e instanceof ErrorFidelizacion || e instanceof ErrorCliente || e instanceof ErrorAuth)
      return res.status(e.status).json({ error: e.message, codigo: e.codigo, ...(e.detalle?.saldo !== undefined ? { saldo: e.detalle.saldo } : {}) });
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
  const base = (req) => ({
    empresaId: req.auth.empresaId,
    actor: { usuarioId: req.auth.usuarioId, permisos: req.rol?.permisos ?? [] },
  });

  const manejadores = {
    /** GET /clientes/:clienteId/puntos */
    puntos: envolver(false, async (req, res) => {
      const clienteId = idValido(req.params?.clienteId, "clienteId");
      await clientes.obtener({ empresaId: req.auth.empresaId, clienteId }); // 404 si no existe
      res.status(200).json(await resumen({ empresaId: req.auth.empresaId, clienteId, limite: req.query?.limite }));
    }),
    /** POST /clientes/:clienteId/puntos/canjear { puntos, detalle? } */
    canjear: envolver(true, async (req, res) =>
      res.status(200).json(
        await canjear({ ...base(req), clienteId: req.params?.clienteId, puntos: req.body?.puntos, detalle: req.body?.detalle }),
      ),
    ),
  };

  return {
    registrarFuente,
    fuentes: () => [...fuentes.values()].map(({ tipo, estado }) => ({ tipo, estado })),
    acumularPorDocumento,
    saldo,
    resumen,
    canjear,
    ajustar,
    leerConfig,
    guardarConfig,
    manejadores,
    listo: () => MovimientoPuntos.init(), // espera a que exista el índice único de idempotencia
  };
}

export { ErrorFidelizacion } from "./errores.js";
