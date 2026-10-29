import { createHash, randomBytes } from "node:crypto";
import { hashPassword } from "../password.js";
import { validarPassword } from "../auth/politica-password.js";
import { ErrorAuth } from "../auth/errores.js";
import { ErrorSolicitud } from "./errores.js";
import { validarSolicitud } from "./validacion.js";

const DIA = 24 * 60 * 60 * 1000;
export const VIGENCIA_SOLICITUD_MS = 14 * DIA; // el operador tiene 14 días para aprobar
export const VIGENCIA_ACCESO_MS = 14 * DIA; // y la persona 14 días para elegir su contraseña
export const MAX_PENDIENTES = 50; // tope de solicitudes pendientes en toda la plataforma (evita llenar la bandeja del operador)

const nuevoToken = () => randomBytes(32).toString("base64url");
const hashDe = (t) => createHash("sha256").update(String(t)).digest("hex");
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Solicitudes de empresa nueva (5.65): una persona llena un formulario público, el OPERADOR de la plataforma recibe un
 * correo con un enlace y la empresa solo se crea cuando él lo aprueba. Sin rutas HTTP aquí: las páginas y el correo
 * viven en el gateway; el núcleo solo guarda el estado y hace las altas. Nada de esto usa permisos de empresa.
 *
 * Los enlaces son secretos de 256 bits de un solo uso; en la base solo queda su hash. Ver `docs/solicitudes.md`.
 */
export function crearServicioSolicitudes({ SolicitudEmpresa, TokenPassword, Empresa, Usuario }, empresas, { ahora = () => new Date() } = {}) {
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
  async function aprobar(token) {
    const previa = await buscar(token);
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
        await TokenPassword.create({ usuarioId, tokenHash: hashDe(tokenAcceso), expira: new Date(ahora().getTime() + VIGENCIA_ACCESO_MS) });
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

  async function rechazar(token) {
    const s = await buscar(token);
    exigirVigente(s);
    const r = await SolicitudEmpresa.updateOne({ _id: s._id, estado: "pendiente" }, { $set: { estado: "rechazada", resueltaTs: ahora() }, $unset: { tokenHash: "" } });
    if (!r.matchedCount) throw new ErrorSolicitud("ESTADO_INVALIDO", "esta solicitud ya no está pendiente");
    return { id: String(s._id), nombre: s.nombre, adminNombre: s.adminNombre, adminCorreo: s.adminCorreo };
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
    return { correo: u.correo, nombre: u.nombre ?? null };
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
    return { correo: u.correo };
  }

  return {
    crear,
    ver,
    aprobar,
    rechazar,
    verAcceso,
    establecerPassword,
    listo: async () => {
      await SolicitudEmpresa.init();
      await TokenPassword.init();
    },
  };
}

export { ErrorSolicitud } from "./errores.js";
