import { conEmpresa } from "../tenancy.js";
import { hashPassword, verificarPassword } from "../password.js";
import { ErrorAuth } from "./errores.js";
import { generarToken, hashToken } from "./tokens.js";
import { leerCookie, serializarCookie } from "./cookies.js";
import { crearLimitador } from "./limitador.js";

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;
const METODOS_SEGUROS = new Set(["GET", "HEAD", "OPTIONS"]);
const ID = /^[0-9a-f]{24}$/i;

/**
 * Autenticación con sesiones opacas.
 *
 * Idea: al entrar, el servidor crea un registro en `sesiones` y le da al navegador una cookie con
 * un token aleatorio. En cada request busca ese registro. Todo el estado vive en el servidor, por
 * eso una sesión se puede cerrar o revocar en cualquier momento (con JWT no).
 *
 * Deja `req.auth = { usuarioId, empresaId }`, que es lo que espera `core.requierePermiso`.
 */
export function crearServicioAuth({ Usuario, Membresia, Rol, Empresa, Sesion }, opciones = {}) {
  const cfg = {
    inactividadMs: opciones.inactividadMs ?? 12 * HORA, // sin usarla, la sesión caduca
    maximoMs: opciones.maximoMs ?? 30 * DIA, // vida máxima aunque se use siempre
    toqueMs: opciones.toqueMs ?? 5 * MIN, // cada cuánto se renueva (evita una escritura por request)
    protegerCsrf: opciones.protegerCsrf ?? true,
    ahora: opciones.ahora ?? Date.now,
    cookie: {
      nombre: "sid",
      secure: process.env.NODE_ENV === "production",
      sameSite: "Lax",
      ...opciones.cookie,
    },
  };
  const ventanaMs = opciones.ventanaIntentosMs ?? 15 * MIN;
  const porCuenta = crearLimitador({ max: opciones.intentosPorCuenta ?? 5, ventanaMs, ahora: cfg.ahora });
  const porIp = crearLimitador({ max: opciones.intentosPorIp ?? 30, ventanaMs, ahora: cfg.ahora });

  // Hash de mentira para gastar el mismo tiempo cuando el correo no existe (ver login).
  let hashFalso = null;
  const falso = () => (hashFalso ??= hashPassword("contraseña-que-nadie-tiene"));

  const cookieNombre = () => cfg.cookie.nombre;
  const cookieDe = (token) =>
    serializarCookie(cookieNombre(), token, {
      maxAgeSeg: cfg.maximoMs / 1000,
      secure: cfg.cookie.secure,
      sameSite: cfg.cookie.sameSite,
    });
  const cookieBorrada = () =>
    serializarCookie(cookieNombre(), "", {
      maxAgeSeg: 0,
      secure: cfg.cookie.secure,
      sameSite: cfg.cookie.sameSite,
    });

  // ---------- empresas de un usuario ----------
  // Membresia y Rol tienen tenancy; aquí se consultan "de plataforma" (todas las empresas del usuario).
  async function membresiasDe(usuarioId) {
    const ms = await Membresia.find({ usuarioId, activa: true })
      .setOptions({ sinEmpresa: true })
      .lean();
    if (!ms.length) return [];
    const [empresas, roles] = await Promise.all([
      Empresa.find({ _id: { $in: ms.map((m) => m.empresaId) }, activa: true }).lean(),
      Rol.find({ _id: { $in: ms.map((m) => m.rolId) } })
        .setOptions({ sinEmpresa: true })
        .lean(),
    ]);
    const rolPorId = new Map(roles.map((r) => [String(r._id), r]));
    return empresas.map((e) => {
      const m = ms.find((x) => String(x.empresaId) === String(e._id));
      const rol = rolPorId.get(String(m.rolId));
      return {
        id: String(e._id),
        nombre: e.nombre,
        slug: e.slug,
        rol: rol?.nombre ?? null,
        permisos: rol?.permisos ?? [],
      };
    });
  }
  const sinPermisos = ({ permisos, ...resto }) => resto;

  // ---------- sesiones ----------
  /**
   * Crea la sesión y devuelve el token en claro (única vez que existe fuera del navegador).
   * La usa `login` y la usará el acceso por PIN: por eso `metodo` y `dispositivoId` ya existen.
   */
  async function crearSesion({
    usuarioId,
    empresaActivaId = null,
    metodo = "password",
    dispositivoId = null,
    ip = null,
    agente = null,
  }) {
    const token = generarToken();
    const t = cfg.ahora();
    const sesion = await Sesion.create({
      tokenHash: hashToken(token),
      usuarioId,
      empresaActivaId,
      metodo,
      dispositivoId,
      creadaTs: new Date(t),
      ultimoUsoTs: new Date(t),
      expiraTs: new Date(t + cfg.inactividadMs),
      venceAbsolutoTs: new Date(t + cfg.maximoMs),
      ip,
      agente: agente ? String(agente).slice(0, 200) : null,
    });
    return { token, sesion };
  }

  /** Devuelve la sesión vigente (y la renueva) o null. Nunca lanza por un token inválido. */
  async function obtenerSesion(token) {
    if (typeof token !== "string" || !token || token.length > 200) return null;
    const s = await Sesion.findOne({ tokenHash: hashToken(token) });
    if (!s) return null;
    const t = cfg.ahora();
    if (s.expiraTs.getTime() <= t || s.venceAbsolutoTs.getTime() <= t) {
      await Sesion.deleteOne({ _id: s._id });
      return null;
    }
    // Defensa en profundidad: si el usuario se suspendió, sus sesiones dejan de valer al instante.
    const u = await Usuario.findById(s.usuarioId).select("estado").lean();
    if (!u || u.estado !== "activo") {
      await Sesion.deleteMany({ usuarioId: s.usuarioId });
      return null;
    }
    if (t - s.ultimoUsoTs.getTime() >= cfg.toqueMs) {
      const expiraTs = new Date(Math.min(t + cfg.inactividadMs, s.venceAbsolutoTs.getTime()));
      await Sesion.updateOne({ _id: s._id }, { ultimoUsoTs: new Date(t), expiraTs });
      s.ultimoUsoTs = new Date(t);
      s.expiraTs = expiraTs;
    }
    return s;
  }

  async function cerrarSesion(token) {
    if (typeof token !== "string" || !token) return false;
    const r = await Sesion.deleteOne({ tokenHash: hashToken(token) });
    return r.deletedCount > 0;
  }

  /** Cierra todas las sesiones de un usuario (contraseña cambiada, dispositivo perdido, baja). */
  async function cerrarSesionesDe(usuarioId, { exceptoSesionId } = {}) {
    const filtro = { usuarioId };
    if (exceptoSesionId) filtro._id = { $ne: exceptoSesionId };
    const r = await Sesion.deleteMany(filtro);
    return r.deletedCount;
  }

  // ---------- login y empresa activa ----------
  async function login({ correo, password, ip = null, agente = null } = {}) {
    if (
      typeof correo !== "string" || typeof password !== "string" ||
      !correo.trim() || !password || correo.length > 254 || password.length > 1024
    )
      throw new ErrorAuth("DATOS_INVALIDOS", "correo y contraseña requeridos");
    const correoNorm = correo.trim().toLowerCase();
    const claveCuenta = `${ip ?? "?"}|${correoNorm}`;

    const espera = Math.max(porCuenta.espera(claveCuenta), ip ? porIp.espera(ip) : 0);
    if (espera > 0)
      throw new ErrorAuth("DEMASIADOS_INTENTOS", "demasiados intentos, espera un momento", {
        reintentarEnSeg: espera,
      });

    const usuario = await Usuario.findOne({ correo: correoNorm }).select("+passwordHash");
    // Se verifica siempre una contraseña (aunque el correo no exista) para que el tiempo de
    // respuesta no revele qué correos están registrados.
    const correcta = await verificarPassword(password, usuario?.passwordHash ?? (await falso()));
    if (!usuario || !correcta || usuario.estado !== "activo") {
      porCuenta.fallo(claveCuenta);
      if (ip) porIp.fallo(ip);
      // Mismo mensaje en los tres casos: no se dice cuál falló.
      throw new ErrorAuth("CREDENCIALES_INVALIDAS", "correo o contraseña incorrectos");
    }
    porCuenta.exito(claveCuenta);

    const empresas = await membresiasDe(usuario._id);
    const empresaActivaId = empresas.length === 1 ? empresas[0].id : null;
    const { token, sesion } = await crearSesion({
      usuarioId: usuario._id,
      empresaActivaId,
      ip,
      agente,
    });
    return {
      token,
      sesion: { id: String(sesion._id), expiraTs: sesion.expiraTs },
      usuario: { id: String(usuario._id), correo: usuario.correo, nombre: usuario.nombre ?? null },
      empresas: empresas.map(sinPermisos),
      empresaActivaId,
    };
  }

  async function cambiarEmpresa({ token, empresaId }) {
    const s = await obtenerSesion(token);
    if (!s) throw new ErrorAuth("SIN_SESION", "no autenticado");
    if (!ID.test(String(empresaId ?? "")))
      throw new ErrorAuth("DATOS_INVALIDOS", "empresaId inválido");
    const empresas = await membresiasDe(s.usuarioId);
    if (!empresas.some((e) => e.id === String(empresaId)))
      throw new ErrorAuth("SIN_ACCESO_EMPRESA", "sin acceso a esta empresa");
    await Sesion.updateOne({ _id: s._id }, { empresaActivaId: empresaId });
    return { empresaActivaId: String(empresaId) };
  }

  // Lo que el front necesita saber de la sesión actual (incluye los permisos de la empresa activa).
  async function contexto(s) {
    const [usuario, empresas] = await Promise.all([
      Usuario.findById(s.usuarioId).lean(),
      membresiasDe(s.usuarioId),
    ]);
    const activa = empresas.find((e) => e.id === String(s.empresaActivaId)) ?? null;
    return {
      usuario: { id: String(usuario._id), correo: usuario.correo, nombre: usuario.nombre ?? null },
      empresas: empresas.map(sinPermisos),
      empresaActivaId: activa?.id ?? null,
      permisos: activa?.permisos ?? [],
      metodo: s.metodo,
    };
  }

  // ---------- Express ----------
  // Una página de otro sitio no puede añadir cabeceras propias a una petición hacia el nuestro
  // (el navegador la bloquearía), así que exigir una en los POST/PUT/DELETE frena el CSRF.
  function exigirCsrf(req) {
    if (!cfg.protegerCsrf || METODOS_SEGUROS.has(req.method)) return;
    if (!req.headers?.["x-requested-with"])
      throw new ErrorAuth("CSRF", "falta la cabecera x-requested-with");
  }

  async function sesionDe(req, { requiereEmpresa }) {
    exigirCsrf(req);
    const token = leerCookie(req.headers?.cookie, cookieNombre());
    const s = await obtenerSesion(token);
    if (!s) throw new ErrorAuth("SIN_SESION", "no autenticado");
    if (requiereEmpresa && !s.empresaActivaId)
      throw new ErrorAuth("EMPRESA_NO_SELECCIONADA", "elige una empresa");
    return { sesion: s, token };
  }

  function responderError(res, e, next) {
    if (!(e instanceof ErrorAuth)) return next(e);
    if (e.codigo === "SIN_SESION") res.setHeader("Set-Cookie", cookieBorrada());
    if (e.codigo === "DEMASIADOS_INTENTOS" && e.detalle?.reintentarEnSeg)
      res.setHeader("Retry-After", String(e.detalle.reintentarEnSeg));
    return res.status(e.status).json({ error: e.message, codigo: e.codigo });
  }

  /**
   * Middleware: exige sesión y deja req.auth = { usuarioId, empresaId } (lo que espera requierePermiso).
   * Con { requiereEmpresa: false } deja pasar sesiones que aún no eligieron empresa.
   */
  const autenticar =
    ({ requiereEmpresa = true } = {}) =>
    async (req, res, next) => {
      try {
        const { sesion } = await sesionDe(req, { requiereEmpresa });
        req.auth = {
          usuarioId: String(sesion.usuarioId),
          empresaId: sesion.empresaActivaId ? String(sesion.empresaActivaId) : null,
        };
        req.sesionAuth = {
          id: String(sesion._id),
          metodo: sesion.metodo,
          dispositivoId: sesion.dispositivoId ? String(sesion.dispositivoId) : null,
        };
        next();
      } catch (e) {
        responderError(res, e, next);
      }
    };

  /** Manejadores listos para montar en el gateway (el gateway pone express.json()). */
  const manejadores = {
    async login(req, res, next) {
      try {
        exigirCsrf(req);
        const r = await login({
          correo: req.body?.correo,
          password: req.body?.password,
          ip: req.ip ?? null,
          agente: req.headers?.["user-agent"] ?? null,
        });
        res.setHeader("Set-Cookie", cookieDe(r.token));
        res.status(200).json({
          usuario: r.usuario,
          empresas: r.empresas,
          empresaActivaId: r.empresaActivaId,
        });
      } catch (e) {
        responderError(res, e, next);
      }
    },
    async logout(req, res, next) {
      try {
        exigirCsrf(req);
        await cerrarSesion(leerCookie(req.headers?.cookie, cookieNombre()));
        res.setHeader("Set-Cookie", cookieBorrada());
        res.status(200).json({ ok: true });
      } catch (e) {
        responderError(res, e, next);
      }
    },
    async yo(req, res, next) {
      try {
        const { sesion } = await sesionDe(req, { requiereEmpresa: false });
        res.status(200).json(await contexto(sesion));
      } catch (e) {
        responderError(res, e, next);
      }
    },
    async empresa(req, res, next) {
      try {
        const { token } = await sesionDe(req, { requiereEmpresa: false });
        await cambiarEmpresa({ token, empresaId: req.body?.empresaId });
        const s = await obtenerSesion(token);
        res.status(200).json(await contexto(s));
      } catch (e) {
        responderError(res, e, next);
      }
    },
  };

  return {
    login,
    crearSesion,
    obtenerSesion,
    cerrarSesion,
    cerrarSesionesDe,
    cambiarEmpresa,
    autenticar,
    manejadores,
    listo: () => Sesion.init().then(() => undefined),
  };
}
