import { createHash, randomBytes } from "node:crypto";
import { conEmpresa } from "../tenancy.js";
import { hashPassword } from "../password.js";
import { validarPassword } from "../auth/politica-password.js";
import { ErrorAuth } from "../auth/errores.js";
import { ErrorSolicitud } from "./errores.js";
import { validarSolicitud } from "./validacion.js";

const DIA = 24 * 60 * 60 * 1000;
export const VIGENCIA_SOLICITUD_MS = 14 * DIA; // el operador tiene 14 días para aprobar
export const VIGENCIA_ACCESO_MS = 14 * DIA; // y la persona 14 días para elegir su contraseña
export const VIGENCIA_RECUPERACION_MS = 60 * 60 * 1000; // el enlace de «olvidé mi contraseña» dura 1 hora
export const ESPERA_RECUPERACION_MS = 60 * 1000; // y no se emite otro antes de 1 minuto (no se puede usar para llenar la bandeja de alguien)
export const MAX_PENDIENTES = 50; // tope de solicitudes pendientes en toda la plataforma (evita llenar la bandeja del operador)

const nuevoToken = () => randomBytes(32).toString("base64url");
const hashDe = (t) => createHash("sha256").update(String(t)).digest("hex");
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CORREO = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,200}\.[^\s@<>"']{2,}$/;
const ID = /^[A-Za-z0-9]{1,40}$/;
/** Id de documento: solo letras y dígitos. Un id que Mongo no pueda convertir (CastError) se trata como «no existe». */
const noExiste = (e) => {
  if (e?.name === "CastError") return new ErrorSolicitud("ENLACE_INVALIDO", "no encontrado");
  return e;
};
const idValido = (id) => {
  if (typeof id !== "string" || !ID.test(id)) throw new ErrorSolicitud("DATOS_INVALIDOS", "id inválido");
  return id;
};

/**
 * Solicitudes de empresa nueva (5.65): una persona llena un formulario público, el OPERADOR de la plataforma recibe un
 * correo con un enlace y la empresa solo se crea cuando él lo aprueba. Sin rutas HTTP aquí: las páginas y el correo
 * viven en el gateway; el núcleo solo guarda el estado y hace las altas. Nada de esto usa permisos de empresa.
 *
 * Los enlaces son secretos de 256 bits de un solo uso; en la base solo queda su hash. Ver `docs/solicitudes.md`.
 */
export function crearServicioSolicitudes({ SolicitudEmpresa, TokenPassword, Empresa, Usuario, Sesion, Rol, Membresia }, empresas, { ahora = () => new Date() } = {}) {
  const buscar = async (token) => {
    if (typeof token !== "string" || !TOKEN.test(token)) throw new ErrorSolicitud("ENLACE_INVALIDO", "enlace inválido");
    const s = await SolicitudEmpresa.findOne({ tokenHash: hashDe(token) }).lean();
    if (!s) throw new ErrorSolicitud("ENLACE_INVALIDO", "enlace inválido o ya usado");
    return s;
  };

  const vista = (s) => ({
    id: String(s._id),
    nombre: s.nombre,
    slug: s.slug,
    servicios: [...s.servicios],
    pais: s.pais,
    moneda: s.moneda,
    telefono: s.telefono,
    adminNombre: s.adminNombre,
    adminCorreo: s.adminCorreo,
    estado: s.estado,
    creadaTs: s.createdAt ?? null,
    expira: s.expira,
  });

  const exigirVigente = (s, { reanudable = false } = {}) => {
    const ok = s.estado === "pendiente" || (reanudable && s.estado === "incompleta");
    if (!ok) {
      const t = { aprobada: "ya fue aprobada", rechazada: "ya fue rechazada", procesando: "se está procesando en este momento" }[s.estado] ?? "ya no está pendiente";
      throw new ErrorSolicitud("ESTADO_INVALIDO", `esta solicitud ${t}`, { estado: s.estado });
    }
    if (new Date(s.expira) <= ahora()) throw new ErrorSolicitud("ENLACE_VENCIDO", "la solicitud venció");
  };

  /**
   * Registra la solicitud. Devuelve `{ solicitud, token }`: `token` es el secreto del enlace del operador y NO se vuelve a poder leer.
   * Comprueba que la dirección web esté libre (empresas y otras solicitudes vigentes) y los topes de pendientes.
   */
  async function crear({ serviciosPermitidos, ...entrada }) {
    const d = validarSolicitud(entrada, { serviciosPermitidos });
    const t = ahora();
    if (await Empresa.findOne({ slug: d.slug }).select("_id").lean())
      throw new ErrorSolicitud("SLUG_OCUPADO", "Esa dirección web ya está en uso: elige otra", { campos: { slug: "Esa dirección web ya está en uso: elige otra" } });
    const vigentes = { estado: { $in: ["pendiente", "procesando", "incompleta"] }, expira: { $gt: t } };
    if (await SolicitudEmpresa.findOne({ slug: d.slug, ...vigentes }).select("_id").lean())
      throw new ErrorSolicitud("SLUG_OCUPADO", "Esa dirección web ya tiene una solicitud en revisión: elige otra", { campos: { slug: "Esa dirección web ya tiene una solicitud en revisión: elige otra" } });
    if (await SolicitudEmpresa.findOne({ adminCorreo: d.adminCorreo, ...vigentes }).select("_id").lean())
      throw new ErrorSolicitud("DEMASIADAS_SOLICITUDES", "Ya tienes una solicitud en revisión con ese correo. Te escribiremos cuando se resuelva.");
    if ((await SolicitudEmpresa.countDocuments({ estado: "pendiente", expira: { $gt: t } })) >= MAX_PENDIENTES)
      throw new ErrorSolicitud("DEMASIADAS_SOLICITUDES", "Hay muchas solicitudes en revisión en este momento. Vuelve a intentarlo en unos días.");
    const token = nuevoToken();
    const s = await SolicitudEmpresa.create({
      nombre: d.nombre,
      slug: d.slug,
      servicios: d.servicios,
      pais: d.pais,
      moneda: d.moneda,
      telefono: d.telefono,
      adminNombre: d.adminNombre,
      adminCorreo: d.adminCorreo,
      aceptacion: { ...d.aceptacion, ts: t },
      estado: "pendiente",
      tokenHash: hashDe(token),
      expira: new Date(t.getTime() + VIGENCIA_SOLICITUD_MS),
    });
    return { solicitud: vista(s.toObject ? s.toObject() : s), token };
  }

  /** Lo que ve el operador al abrir su enlace (no cambia nada). Lanza si el enlace no existe, venció o ya se resolvió. */
  async function ver(token) {
    const s = await buscar(token);
    exigirVigente(s, { reanudable: true });
    return vista(s);
  }

  /**
   * Aprueba: crea la empresa (con las plantillas de rol de sus servicios) y a su primer admin. Si el correo ya tiene una cuenta
   * activa, solo la afilia (no toca su contraseña); si no, crea la cuenta con una contraseña que nadie conoce y devuelve
   * `tokenAcceso`, el enlace de un solo uso para que la persona elija la suya. El enlace de aprobación deja de servir.
   * Si falla a la mitad, la solicitud queda `incompleta` y volver a aprobar la reanuda sin duplicar la empresa.
   */
  async function aprobarSolicitud(previa) {
    exigirVigente(previa, { reanudable: true });
    // Reclama la solicitud de forma atómica: dos clics a la vez no crean dos empresas.
    const s = await SolicitudEmpresa.findOneAndUpdate(
      { _id: previa._id, estado: { $in: ["pendiente", "incompleta"] } },
      { $set: { estado: "procesando" } },
      { new: false },
    ).lean();
    if (!s) throw new ErrorSolicitud("ESTADO_INVALIDO", "esta solicitud se está procesando en este momento", { estado: "procesando" });
    const volver = (estado, error = null) => SolicitudEmpresa.updateOne({ _id: s._id }, { $set: { estado, error: error ? String(error).slice(0, 300) : null } });
    let empresaId = s.empresaId ?? null;
    try {
      const existente = await Usuario.findOne({ correo: s.adminCorreo }).lean();
      if (existente && existente.estado === "suspendido") throw new ErrorSolicitud("CUENTA_SUSPENDIDA", "la cuenta de ese correo está suspendida: no se puede crear la empresa con ella");
      if (!empresaId) {
        if (await Empresa.findOne({ slug: s.slug }).select("_id").lean()) throw new ErrorSolicitud("SLUG_OCUPADO", "ya existe una empresa con esa dirección web");
        const e = await empresas.crearEmpresa({ nombre: s.nombre, slug: s.slug, servicios: s.servicios, pais: s.pais, moneda: s.moneda });
        empresaId = e._id;
        await SolicitudEmpresa.updateOne({ _id: s._id }, { $set: { empresaId } }); // por si falla lo que sigue: se reanuda sin duplicar
      }
      let usuarioId;
      let usuarioNuevo = false;
      let tokenAcceso = null;
      if (existente) usuarioId = existente._id;
      else {
        const u = await empresas.crearUsuario({ correo: s.adminCorreo, nombre: s.adminNombre, password: randomBytes(32).toString("hex") });
        usuarioId = u._id;
        usuarioNuevo = true;
      }
      await empresas.agregarMiembro({ empresaId, usuarioId, rol: "admin" });
      if (usuarioNuevo) {
        tokenAcceso = nuevoToken();
        await TokenPassword.create({ usuarioId, tipo: "acceso", tokenHash: hashDe(tokenAcceso), expira: new Date(ahora().getTime() + VIGENCIA_ACCESO_MS), createdAt: ahora() });
      }
      await SolicitudEmpresa.updateOne({ _id: s._id }, { $set: { estado: "aprobada", resueltaTs: ahora(), error: null }, $unset: { tokenHash: "" } });
      return {
        empresa: { id: String(empresaId), nombre: s.nombre, slug: s.slug, servicios: [...s.servicios] },
        admin: { correo: s.adminCorreo, nombre: s.adminNombre, nuevo: usuarioNuevo },
        tokenAcceso,
        venceAcceso: usuarioNuevo ? new Date(ahora().getTime() + VIGENCIA_ACCESO_MS) : null,
      };
    } catch (e) {
      // Con empresa ya creada queda `incompleta` (reanudable); sin ella vuelve a `pendiente`.
      await volver(empresaId ? "incompleta" : "pendiente", e?.message).catch(() => {});
      throw e;
    }
  }

  const aprobar = async (token) => aprobarSolicitud(await buscar(token));

  async function rechazarSolicitud(s) {
    exigirVigente(s);
    const r = await SolicitudEmpresa.updateOne({ _id: s._id, estado: "pendiente" }, { $set: { estado: "rechazada", resueltaTs: ahora() }, $unset: { tokenHash: "" } });
    if (!r.matchedCount) throw new ErrorSolicitud("ESTADO_INVALIDO", "esta solicitud ya no está pendiente");
    return { id: String(s._id), nombre: s.nombre, adminNombre: s.adminNombre, adminCorreo: s.adminCorreo };
  }
  const rechazar = async (token) => rechazarSolicitud(await buscar(token));

  // ---------- el operador (la identidad del operador la decide el gateway; aquí no hay permisos de empresa) ----------
  const porId = async (id) => {
    let s;
    try {
      s = await SolicitudEmpresa.findOne({ _id: idValido(id) }).lean();
    } catch (e) {
      throw noExiste(e);
    }
    if (!s) throw new ErrorSolicitud("ENLACE_INVALIDO", "solicitud no encontrada");
    return s;
  };
  const aprobarPorId = async (id) => aprobarSolicitud(await porId(id));
  const rechazarPorId = async (id) => rechazarSolicitud(await porId(id));

  const ESTADOS = ["pendiente", "aprobada", "rechazada"];
  /** Solicitudes de la más nueva a la más vieja. `estado`: pendiente (incluye las a medias), aprobada o rechazada; sin él, todas. */
  async function listar({ estado, limite = 50, saltar = 0 } = {}) {
    if (estado !== undefined && !ESTADOS.includes(estado)) throw new ErrorSolicitud("DATOS_INVALIDOS", "estado inválido");
    const filtro = estado === "pendiente" ? { estado: { $in: ["pendiente", "procesando", "incompleta"] } } : estado ? { estado } : {};
    const lim = Math.min(Math.max(Number.parseInt(limite, 10) || 50, 1), 200);
    const skip = Math.max(Number.parseInt(saltar, 10) || 0, 0);
    const filas = await SolicitudEmpresa.find(filtro).sort({ createdAt: -1 }).skip(skip).limit(lim).lean();
    return filas.map((s) => ({ ...vista(s), vencida: ["pendiente", "incompleta"].includes(s.estado) && new Date(s.expira) <= ahora(), empresaId: s.empresaId ? String(s.empresaId) : null, resueltaTs: s.resueltaTs ?? null, error: s.error ?? null }));
  }

  /** Cuántas hay por esperar: las pendientes que todavía no vencieron. */
  async function contarPendientes() {
    return SolicitudEmpresa.countDocuments({ estado: { $in: ["pendiente", "incompleta"] }, expira: { $gt: ahora() } });
  }

  async function adminsDe(empresaId) {
    return conEmpresa(empresaId, async () => {
      const rol = await Rol.findOne({ nombre: "admin" }).lean();
      if (!rol) return [];
      const ms = await Membresia.find({ rolId: rol._id, activa: true }).lean();
      const us = ms.length ? await Usuario.find({ _id: { $in: ms.map((m) => m.usuarioId) } }).lean() : [];
      return us.map((u) => ({ id: String(u._id), correo: u.correo, nombre: u.nombre ?? null, suspendido: u.estado === "suspendido" }));
    });
  }

  /** Empresas de la más nueva a la más vieja, con sus administradores (solo lectura). `texto` busca por nombre o dirección web. */
  async function listarEmpresas({ texto, limite = 50, saltar = 0 } = {}) {
    const t = typeof texto === "string" ? texto.trim().slice(0, 60) : "";
    const filtro = t ? { $or: [{ nombre: { $regex: t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }, { slug: t.toLowerCase() }] } : {};
    const lim = Math.min(Math.max(Number.parseInt(limite, 10) || 50, 1), 200);
    const skip = Math.max(Number.parseInt(saltar, 10) || 0, 0);
    const es = await Empresa.find(filtro).sort({ createdAt: -1 }).skip(skip).limit(lim).lean();
    return Promise.all(
      es.map(async (e) => ({
        id: String(e._id),
        nombre: e.nombre,
        slug: e.slug,
        servicios: (e.servicios ?? []).filter((x) => x.activa !== false).map((x) => x.codigo),
        pais: e.pais ?? null,
        moneda: e.moneda ?? null,
        activa: e.activa !== false,
        creadaTs: e.createdAt ?? null,
        admins: await adminsDe(e._id),
      })),
    );
  }

  /** Suspende (`false`) o reactiva (`true`) una empresa. Suspendida: no sale al elegir empresa, su carta pública da 404 y sus sesiones abiertas se quedan sin permisos. No borra nada. */
  async function fijarActiva({ empresaId, activa }) {
    if (typeof activa !== "boolean") throw new ErrorSolicitud("DATOS_INVALIDOS", "activa debe ser verdadero o falso");
    let r;
    try {
      r = await Empresa.updateOne({ _id: idValido(String(empresaId)) }, { $set: { activa } });
    } catch (e) {
      throw noExiste(e);
    }
    if (!r.matchedCount) throw new ErrorSolicitud("ENLACE_INVALIDO", "empresa no encontrada");
    return { ok: true, activa };
  }

  // ---------- enlace para elegir la contraseña ----------
  const buscarAcceso = async (token) => {
    if (typeof token !== "string" || !TOKEN.test(token)) throw new ErrorSolicitud("ENLACE_INVALIDO", "enlace inválido");
    const t = await TokenPassword.findOne({ tokenHash: hashDe(token) }).lean();
    if (!t || t.usadoTs) throw new ErrorSolicitud("ENLACE_INVALIDO", "enlace inválido o ya usado");
    if (new Date(t.expira) <= ahora()) throw new ErrorSolicitud("ENLACE_VENCIDO", "el enlace venció");
    return t;
  };

  /** Quién es la persona de un enlace de contraseña (para mostrar el formulario). No cambia nada. */
  async function verAcceso(token) {
    const t = await buscarAcceso(token);
    const u = await Usuario.findOne({ _id: t.usuarioId }).lean();
    if (!u || u.estado === "suspendido") throw new ErrorSolicitud("ENLACE_INVALIDO", "enlace inválido");
    return { correo: u.correo, nombre: u.nombre ?? null, tipo: t.tipo ?? "acceso" };
  }

  /** Fija la contraseña con el enlace (un solo uso). Aplica la política de contraseñas del núcleo. */
  async function establecerPassword({ token, password }) {
    const t = await buscarAcceso(token);
    try {
      validarPassword(password);
    } catch (e) {
      if (e instanceof ErrorAuth) throw new ErrorSolicitud("DATOS_INVALIDOS", e.message, { campos: { password: e.message } });
      throw e;
    }
    // Se gasta el enlace ANTES de guardar la contraseña: un doble envío no la cambia dos veces.
    const gastado = await TokenPassword.updateOne({ _id: t._id, usadoTs: null }, { $set: { usadoTs: ahora() } });
    if (!gastado.matchedCount) throw new ErrorSolicitud("ENLACE_INVALIDO", "enlace inválido o ya usado");
    const u = await Usuario.findOne({ _id: t.usuarioId }).lean();
    if (!u || u.estado === "suspendido") throw new ErrorSolicitud("ENLACE_INVALIDO", "enlace inválido");
    await Usuario.updateOne({ _id: t.usuarioId }, { $set: { passwordHash: await hashPassword(password), debeCambiarPassword: false } });
    await TokenPassword.updateMany({ usuarioId: t.usuarioId, usadoTs: null }, { $set: { usadoTs: ahora() } }); // cualquier otro enlace pendiente
    // Con la contraseña nueva, nadie que tuviera una sesión abierta con la anterior sigue dentro (también las de tablet).
    const sesionesCerradas = (await Sesion.deleteMany({ usuarioId: t.usuarioId })).deletedCount ?? 0;
    return { correo: u.correo, sesionesCerradas };
  }

  // ---------- recuperar o reenviar el acceso ----------
  /** Emite un enlace nuevo para elegir la contraseña y anula los anteriores sin usar. Devuelve el secreto (una sola vez). */
  async function emitirEnlace(usuarioId, { tipo, vigenciaMs }) {
    await TokenPassword.updateMany({ usuarioId, usadoTs: null }, { $set: { usadoTs: ahora() } });
    const token = nuevoToken();
    const t = ahora();
    await TokenPassword.create({ usuarioId, tipo, tokenHash: hashDe(token), expira: new Date(t.getTime() + vigenciaMs), createdAt: t });
    return { token, vence: new Date(t.getTime() + vigenciaMs) };
  }

  /**
   * «Olvidé mi contraseña»: si el correo tiene una cuenta activa, emite un enlace de 1 hora y lo devuelve junto a quién es;
   * si no existe, está suspendida o se pidió otro hace menos de 1 minuto, devuelve `null`. Quien llama debe responder IGUAL en
   * todos los casos (no revelar qué correos existen) y enviar el correo solo cuando no sea `null`.
   */
  async function solicitarRecuperacion({ correo }) {
    const c = typeof correo === "string" ? correo.trim().toLowerCase() : "";
    if (!c || c.length > 254 || !CORREO.test(c)) return null;
    const u = await Usuario.findOne({ correo: c }).lean();
    if (!u || u.estado === "suspendido") return null;
    const reciente = await TokenPassword.findOne({ usuarioId: u._id, tipo: "recuperacion", usadoTs: null, createdAt: { $gt: new Date(ahora().getTime() - ESPERA_RECUPERACION_MS) } }).lean();
    if (reciente) return null;
    const e = await emitirEnlace(u._id, { tipo: "recuperacion", vigenciaMs: VIGENCIA_RECUPERACION_MS });
    return { correo: u.correo, nombre: u.nombre ?? null, token: e.token, vence: e.vence };
  }

  /**
   * El operador reenvía el acceso a un administrador de una empresa (enlace de 14 días). La persona tiene que ser miembro
   * activo con rol `admin` de ESA empresa: no sirve para generar enlaces de cuentas cualesquiera.
   */
  async function reenviarAcceso({ empresaId, usuarioId }) {
    const admins = await adminsDe(idValido(String(empresaId)));
    const a = admins.find((x) => x.id === String(usuarioId));
    if (!a) throw new ErrorSolicitud("ENLACE_INVALIDO", "esa persona no es administradora de la empresa");
    if (a.suspendido) throw new ErrorSolicitud("CUENTA_SUSPENDIDA", "la cuenta de esa persona está suspendida");
    const e = await emitirEnlace(a.id, { tipo: "acceso", vigenciaMs: VIGENCIA_ACCESO_MS });
    const emp = await Empresa.findOne({ _id: idValido(String(empresaId)) }).lean();
    return { correo: a.correo, nombre: a.nombre, empresa: emp?.nombre ?? null, token: e.token, vence: e.vence };
  }

  return {
    crear,
    ver,
    aprobar,
    rechazar,
    aprobarPorId,
    rechazarPorId,
    listar,
    contarPendientes,
    listarEmpresas,
    fijarActiva,
    reenviarAcceso,
    solicitarRecuperacion,
    verAcceso,
    establecerPassword,
    listo: async () => {
      await SolicitudEmpresa.init();
      await TokenPassword.init();
    },
  };
}

export { ErrorSolicitud } from "./errores.js";
