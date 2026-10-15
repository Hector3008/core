import { conEmpresa } from "../tenancy.js";
import { permite } from "../permisos.js";
import { hashPassword, verificarPassword } from "../password.js";
import { normalizarTelefono, PAIS_POR_DEFECTO } from "../telefono.js";
import { ErrorAuth } from "../auth/errores.js";
import { generarToken, hashToken } from "../auth/tokens.js";
import { leerCookie, serializarCookie } from "../auth/cookies.js";
import { crearLimitador } from "../auth/limitador.js";
import { validarPassword } from "../auth/politica-password.js";
import { generarPasswordTemporal } from "../empleados/validacion.js";
import { ErrorCliente } from "../clientes/errores.js";

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;
const ID = /^[0-9a-f]{24}$/i;
const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Actores internos del auto-registro: el cliente no tiene permisos de personal, pero las operaciones de
// `core.clientes` los comprueban. Solo se usan en estas dos operaciones y solo sobre la ficha recién creada
// o la propia (nunca sobre otra persona).
const ACTOR_REGISTRO = Object.freeze({ usuarioId: null, permisos: Object.freeze(["cliente:crear"]) });
const ACTOR_CONSENTIMIENTO_PROPIO = Object.freeze({ usuarioId: null, permisos: Object.freeze(["cliente:gestionar"]) });

const tiene = (v) => typeof v === "string" && v.trim() !== "";

/**
 * Cuentas del cliente final (arquitectura 5.25).
 *
 * La cuenta vive en la ficha `Cliente` de cada empresa (no es un `Usuario` global): el mismo teléfono o correo puede
 * tener ficha, contraseña y puntos separados en cada empresa. El **usuario** es el correo o el teléfono de la ficha.
 * La sesión es propia: colección `sesiones_cliente`, cookie `cs_<slug>` y middleware `autenticarCliente`, que deja
 * `req.cliente`. Nunca produce `req.auth`, así que ninguna ruta del personal la acepta.
 *
 * Dos maneras de tener cuenta:
 *   - El personal la crea (`crearCuenta`, con contraseña temporal que se muestra una vez y cambio obligatorio).
 *   - El propio cliente se registra (`registrar`). Como no hay envío de correo ni SMS, NO se puede verificar que el
 *     teléfono o el correo sean suyos: si ya existe una ficha con ese teléfono o correo, el registro se bloquea y se
 *     le pide acercarse al personal (así nadie se apropia de la ficha ni de los puntos de otro).
 */
export function crearServicioCuentasCliente({ Empresa, Cliente, SesionCliente }, auth, clientes, fidelizacion, opciones = {}) {
  const cfg = {
    inactividadMs: opciones.inactividadMs ?? 7 * DIA,
    maximoMs: opciones.maximoMs ?? 30 * DIA,
    toqueMs: opciones.toqueMs ?? 5 * MIN,
    ahora: opciones.ahora ?? Date.now,
    cookie: { secure: process.env.NODE_ENV === "production", sameSite: "Lax", ...opciones.cookie },
  };
  const ventanaMs = opciones.ventanaIntentosMs ?? 15 * MIN;
  const porCuenta = crearLimitador({ max: opciones.intentosPorCuenta ?? 5, ventanaMs, ahora: cfg.ahora });
  const porIp = crearLimitador({ max: opciones.intentosPorIp ?? 30, ventanaMs, ahora: cfg.ahora });
  const porCambioPassword = crearLimitador({ max: 5, ventanaMs, ahora: cfg.ahora });
  const porRegistro = crearLimitador({ max: opciones.registrosPorIp ?? 10, ventanaMs: HORA, ahora: cfg.ahora });

  // Hash de mentira para gastar el mismo tiempo cuando el usuario no existe (ver login).
  let hashFalso = null;
  const falso = () => (hashFalso ??= hashPassword("contraseña-que-nadie-tiene"));

  // ---------- ayudas ----------
  const exigir = (actor, permiso) => {
    if (!actor || !Array.isArray(actor.permisos))
      throw new ErrorCliente("PERMISO_INSUFICIENTE", "se requiere quién realiza la operación");
    if (!permite(actor.permisos, permiso))
      throw new ErrorCliente("PERMISO_INSUFICIENTE", `permiso insuficiente (${permiso})`);
  };

  const idValido = (v, nombre) => {
    if (!ID.test(String(v ?? ""))) throw new ErrorCliente("DATOS_INVALIDOS", `${nombre} inválido`);
    return String(v);
  };

  async function paisDe(empresaId) {
    const e = await Empresa.findById(empresaId).lean();
    if (!e || e.activa === false) throw new ErrorCliente("NO_ENCONTRADO", "empresa no encontrada");
    return e.pais ?? PAIS_POR_DEFECTO;
  }

  /** `{ campo, valor }` de lo que escribió la persona (un correo o un teléfono) o null si no tiene forma de ninguno. */
  function identificar(usuario, pais) {
    const t = typeof usuario === "string" ? usuario.trim() : "";
    if (!t || t.length > 254) return null;
    if (t.includes("@")) return CORREO.test(t) ? { campo: "correo", valor: t.toLowerCase() } : null;
    try {
      return { campo: "telefono", valor: normalizarTelefono(t, pais).telefono };
    } catch {
      return null;
    }
  }

  const cookieNombre = (slug) => `cs_${slug}`;
  const cookieDe = (slug, token) =>
    serializarCookie(cookieNombre(slug), token, {
      maxAgeSeg: cfg.maximoMs / 1000,
      secure: cfg.cookie.secure,
      sameSite: cfg.cookie.sameSite,
    });
  const cookieBorrada = (slug) =>
    serializarCookie(cookieNombre(slug), "", { maxAgeSeg: 0, secure: cfg.cookie.secure, sameSite: cfg.cookie.sameSite });

  async function cargar(empresaId, clienteId) {
    idValido(clienteId, "clienteId");
    const c = await conEmpresa(empresaId, async () => await Cliente.findById(clienteId).lean());
    if (!c) throw new ErrorCliente("NO_ENCONTRADO", "cliente no encontrado");
    return c;
  }

  // ---------- sesiones ----------
  async function crearSesion({ empresaId, clienteId, ip = null, agente = null }) {
    const token = generarToken();
    const t = cfg.ahora();
    const sesion = await conEmpresa(empresaId, async () =>
      await SesionCliente.create({
        tokenHash: hashToken(token),
        clienteId,
        creadaTs: new Date(t),
        ultimoUsoTs: new Date(t),
        expiraTs: new Date(t + cfg.inactividadMs),
        venceAbsolutoTs: new Date(t + cfg.maximoMs),
        ip,
        agente: agente ? String(agente).slice(0, 200) : null,
      }),
    );
    return { token, sesion };
  }

  /**
   * La sesión vigente (y la renueva) o null. Nunca lanza por un token inválido. Defensa en profundidad: si el cliente
   * se desactivó, se anonimizó o ya no tiene cuenta, sus sesiones dejan de valer al instante.
   */
  async function obtenerSesion({ empresaId, token }) {
    if (typeof token !== "string" || !token || token.length > 200) return null;
    return await conEmpresa(empresaId, async () => {
      const s = await SesionCliente.findOne({ tokenHash: hashToken(token) });
      if (!s) return null;
      const t = cfg.ahora();
      if (s.expiraTs.getTime() <= t || s.venceAbsolutoTs.getTime() <= t) {
        await SesionCliente.deleteOne({ _id: s._id });
        return null;
      }
      const c = await Cliente.findById(s.clienteId).lean();
      if (!c || c.activo === false || c.anonimizadoTs || !c.cuenta) {
        await SesionCliente.deleteMany({ clienteId: s.clienteId });
        return null;
      }
      s.$locals.cliente = c;
      const toque = Math.min(cfg.toqueMs, Math.floor(cfg.inactividadMs / 4));
      if (t - s.ultimoUsoTs.getTime() >= toque) {
        const expiraTs = new Date(Math.min(t + cfg.inactividadMs, s.venceAbsolutoTs.getTime()));
        await SesionCliente.updateOne({ _id: s._id }, { ultimoUsoTs: new Date(t), expiraTs });
        s.ultimoUsoTs = new Date(t);
        s.expiraTs = expiraTs;
      }
      return s;
    });
  }

  async function cerrarSesion({ empresaId, token }) {
    if (typeof token !== "string" || !token) return false;
    const r = await conEmpresa(empresaId, async () => await SesionCliente.deleteOne({ tokenHash: hashToken(token) }));
    return r.deletedCount > 0;
  }

  async function cerrarSesionesDe({ empresaId, clienteId, exceptoSesionId }) {
    const filtro = { clienteId };
    if (exceptoSesionId) filtro._id = { $ne: exceptoSesionId };
    const r = await conEmpresa(empresaId, async () => await SesionCliente.deleteMany(filtro));
    return r.deletedCount;
  }

  // ---------- cuenta creada por el personal ----------
  function contrasenaDeAlta({ password, generarPassword }) {
    if (password !== undefined && generarPassword)
      throw new ErrorCliente("DATOS_INVALIDOS", "da una contraseña o pide que se genere, no las dos cosas");
    if (password === undefined && !generarPassword)
      throw new ErrorCliente("DATOS_INVALIDOS", "da una contraseña temporal o pide que se genere (generarPassword: true)");
    if (generarPassword) return generarPasswordTemporal();
    try {
      validarPassword(password);
    } catch (e) {
      throw new ErrorCliente("DATOS_INVALIDOS", e.message);
    }
    return password;
  }

  /**
   * El personal da una cuenta a un cliente que ya tiene ficha. La contraseña es temporal: se muestra una sola vez
   * (`passwordTemporal`) y el cliente tiene que cambiarla al entrar. Su usuario es su correo o su teléfono.
   */
  async function crearCuenta({ empresaId, actor, clienteId, password, generarPassword = false }) {
    exigir(actor, "cliente:cuenta");
    const plano = contrasenaDeAlta({ password, generarPassword });
    const c = await cargar(empresaId, clienteId);
    if (c.anonimizadoTs || c.activo === false) throw new ErrorCliente("ESTADO_INVALIDO", "el cliente está desactivado o anonimizado");
    if (c.cuenta) throw new ErrorCliente("ESTADO_INVALIDO", "el cliente ya tiene cuenta");
    if (!c.correo && !c.telefono)
      throw new ErrorCliente("DATOS_INVALIDOS", "el cliente necesita un correo o un teléfono: ese es su usuario");
    const cuenta = {
      passwordHash: await hashPassword(plano),
      debeCambiarPassword: true,
      origen: "personal",
      creadaTs: new Date(),
    };
    const r = await conEmpresa(empresaId, async () =>
      await Cliente.updateOne({ _id: clienteId, activo: true, anonimizadoTs: null, cuenta: null }, { $set: { cuenta } }),
    );
    if (!r.matchedCount) throw new ErrorCliente("ESTADO_INVALIDO", "el cliente ya tiene cuenta o dejó de estar activo");
    return { clienteId: String(clienteId), correo: c.correo ?? null, telefono: c.telefono ?? null, passwordTemporal: plano };
  }

  /** El personal fija otra contraseña temporal (se le olvidó): cierra todas sus sesiones y la obliga a cambiarla. */
  async function restablecerPassword({ empresaId, actor, clienteId, password, generarPassword = false }) {
    exigir(actor, "cliente:cuenta");
    const plano = contrasenaDeAlta({ password, generarPassword });
    const c = await cargar(empresaId, clienteId);
    if (c.anonimizadoTs || c.activo === false) throw new ErrorCliente("ESTADO_INVALIDO", "el cliente está desactivado o anonimizado");
    if (!c.cuenta) throw new ErrorCliente("ESTADO_INVALIDO", "el cliente no tiene cuenta");
    const r = await conEmpresa(empresaId, async () =>
      await Cliente.updateOne(
        { _id: clienteId, activo: true, anonimizadoTs: null, cuenta: { $ne: null } },
        { $set: { "cuenta.passwordHash": await hashPassword(plano), "cuenta.debeCambiarPassword": true } },
      ),
    );
    if (!r.matchedCount) throw new ErrorCliente("ESTADO_INVALIDO", "el cliente no tiene cuenta o dejó de estar activo");
    const cerradas = await cerrarSesionesDe({ empresaId, clienteId });
    return { clienteId: String(clienteId), passwordTemporal: plano, sesionesCerradas: cerradas };
  }

  // ---------- auto-registro ----------
  /**
   * El cliente crea su ficha y su cuenta a la vez. Exige teléfono o correo (su usuario). Si ya existe una ficha con
   * ese teléfono o correo, `REGISTRO_BLOQUEADO` (409) sin decir de quién: se le pide acercarse al personal.
   * `quierePuntos: true` registra su consentimiento de `programaPuntos` (medio `formulario`). Deja la sesión abierta.
   * Límite conocido: crear la ficha y su cuenta no es una operación única; si fallara entre las dos, la ficha queda
   * sin cuenta y el personal puede dársela con `crearCuenta`.
   */
  async function registrar({ empresaId, nombre, telefono, correo, paisTelefono, password, quierePuntos = false, ip = null, agente = null }) {
    const clave = ip ?? "?";
    const espera = porRegistro.espera(clave);
    if (espera > 0)
      throw new ErrorAuth("DEMASIADOS_INTENTOS", "demasiados registros, espera un momento", { reintentarEnSeg: espera });
    porRegistro.fallo(clave); // cada intento cuenta: no hay "éxito" que lo perdone
    if (!tiene(telefono) && !tiene(correo))
      throw new ErrorCliente("DATOS_INVALIDOS", "indica tu teléfono o tu correo: es tu usuario");
    try {
      validarPassword(password);
    } catch (e) {
      throw new ErrorCliente("DATOS_INVALIDOS", e.message);
    }
    const passwordHash = await hashPassword(password);

    let c;
    try {
      c = await clientes.crear({
        empresaId,
        actor: ACTOR_REGISTRO,
        nombre,
        telefono: tiene(telefono) ? telefono : undefined,
        paisTelefono,
        correo: tiene(correo) ? correo : undefined,
      });
    } catch (e) {
      if (e instanceof ErrorCliente && e.codigo === "CLIENTE_DUPLICADO")
        throw new ErrorCliente(
          "REGISTRO_BLOQUEADO",
          "Ya existe un registro con ese teléfono o correo. Acércate al personal para activar tu cuenta.",
        );
      throw e;
    }
    await conEmpresa(empresaId, async () =>
      await Cliente.updateOne(
        { _id: c.id },
        { $set: { cuenta: { passwordHash, debeCambiarPassword: false, origen: "autoregistro", creadaTs: new Date() } } },
      ),
    );
    if (quierePuntos === true)
      await clientes.cambiarConsentimiento({
        empresaId,
        actor: ACTOR_CONSENTIMIENTO_PROPIO,
        clienteId: c.id,
        finalidad: "programaPuntos",
        otorgado: true,
        medio: "formulario",
      });
    const { token, sesion } = await crearSesion({ empresaId, clienteId: c.id, ip, agente });
    return { token, sesion: { id: String(sesion._id), expiraTs: sesion.expiraTs }, cliente: { id: c.id, nombre: c.nombre } };
  }

  // ---------- entrar y salir ----------
  async function login({ empresaId, usuario, password, ip = null, agente = null }) {
    if (
      typeof usuario !== "string" || typeof password !== "string" ||
      !usuario.trim() || !password || usuario.length > 254 || password.length > 1024
    )
      throw new ErrorAuth("DATOS_INVALIDOS", "usuario y contraseña requeridos");
    const pais = await paisDe(empresaId);
    const id = identificar(usuario, pais);
    const claveCuenta = `${empresaId}|${ip ?? "?"}|${id ? id.valor : usuario.trim().toLowerCase()}`;
    const espera = Math.max(porCuenta.espera(claveCuenta), ip ? porIp.espera(ip) : 0);
    if (espera > 0)
      throw new ErrorAuth("DEMASIADOS_INTENTOS", "demasiados intentos, espera un momento", { reintentarEnSeg: espera });

    const c = id
      ? await conEmpresa(empresaId, async () => await Cliente.findOne({ [id.campo]: id.valor }).select("+cuenta.passwordHash").lean())
      : null;
    // Se verifica siempre una contraseña (aunque el usuario no exista) para que el tiempo de respuesta no
    // revele qué teléfonos o correos tienen cuenta.
    const hash = c?.cuenta?.passwordHash;
    const correcta = await verificarPassword(password, hash ?? (await falso()));
    if (!c || !hash || !correcta || c.activo === false || c.anonimizadoTs) {
      porCuenta.fallo(claveCuenta);
      if (ip) porIp.fallo(ip);
      throw new ErrorAuth("CREDENCIALES_INVALIDAS", "usuario o contraseña incorrectos");
    }
    porCuenta.exito(claveCuenta);
    await conEmpresa(empresaId, async () =>
      await Cliente.updateOne({ _id: c._id }, { $set: { "cuenta.ultimoAccesoTs": new Date(cfg.ahora()) } }),
    );
    const { token, sesion } = await crearSesion({ empresaId, clienteId: c._id, ip, agente });
    return {
      token,
      sesion: { id: String(sesion._id), expiraTs: sesion.expiraTs },
      cliente: { id: String(c._id), nombre: c.nombre },
      debeCambiarPassword: !!c.cuenta.debeCambiarPassword,
    };
  }

  /**
   * El cliente cambia su propia contraseña (hay que dar la actual). Cierra el resto de sus sesiones; la actual
   * sigue abierta.
   */
  async function cambiarPassword({ empresaId, clienteId, passwordActual, passwordNueva, sesionId = null }) {
    if (typeof passwordActual !== "string" || !passwordActual || passwordActual.length > 1024)
      throw new ErrorAuth("DATOS_INVALIDOS", "contraseña actual requerida");
    validarPassword(passwordNueva);
    if (passwordNueva === passwordActual)
      throw new ErrorAuth("DATOS_INVALIDOS", "la contraseña nueva debe ser distinta de la actual");
    const clave = `${empresaId}|${clienteId}`;
    const espera = porCambioPassword.espera(clave);
    if (espera > 0)
      throw new ErrorAuth("DEMASIADOS_INTENTOS", "demasiados intentos, espera un momento", { reintentarEnSeg: espera });
    const c = await conEmpresa(empresaId, async () => await Cliente.findById(clienteId).select("+cuenta.passwordHash").lean());
    if (!c?.cuenta?.passwordHash || !(await verificarPassword(passwordActual, c.cuenta.passwordHash))) {
      porCambioPassword.fallo(clave);
      throw new ErrorAuth("CREDENCIALES_INVALIDAS", "contraseña actual incorrecta");
    }
    porCambioPassword.exito(clave);
    await conEmpresa(empresaId, async () =>
      await Cliente.updateOne(
        { _id: clienteId },
        { $set: { "cuenta.passwordHash": await hashPassword(passwordNueva), "cuenta.debeCambiarPassword": false } },
      ),
    );
    const cerradas = await cerrarSesionesDe({ empresaId, clienteId, exceptoSesionId: sesionId });
    return { ok: true, sesionesCerradas: cerradas };
  }

  /**
   * El cliente da o retira, él mismo, su consentimiento al programa de puntos. Es sobre su propia ficha (el
   * `clienteId` sale de su sesión, nunca del cuerpo de la petición).
   */
  async function cambiarMiConsentimiento({ empresaId, clienteId, otorgado }) {
    if (typeof otorgado !== "boolean") throw new ErrorCliente("DATOS_INVALIDOS", "otorgado debe ser true o false");
    await clientes.cambiarConsentimiento({
      empresaId,
      actor: ACTOR_CONSENTIMIENTO_PROPIO,
      clienteId,
      finalidad: "programaPuntos",
      otorgado,
      medio: "formulario",
    });
    return { programaPuntos: otorgado };
  }

  /** Lo que ve el cliente de sí mismo: su ficha mínima, su consentimiento, y sus puntos y movimientos. */
  async function yo({ empresaId, clienteId, debeCambiarPassword = false }) {
    const c = await clientes.obtener({ empresaId, clienteId });
    const puntos = await fidelizacion.resumen({ empresaId, clienteId });
    return {
      sesion: true,
      cliente: {
        id: c.id,
        nombre: c.nombre,
        correo: c.correo,
        telefono: c.telefono,
        programaPuntos: c.consentimientos.programaPuntos.otorgado,
        debeCambiarPassword,
      },
      puntos,
    };
  }

  // ---------- Express ----------
  const responder = (res, e, next, slug) => {
    // Cualquier error del núcleo (o del servicio que monta esto) con `status` y `codigo` se traduce igual.
    // Nunca se vuelca `detalle`: podría traer ids internos.
    if (e && Number.isInteger(e.status) && typeof e.codigo === "string") {
      if (e.codigo === "SIN_SESION" && slug) res.setHeader("Set-Cookie", cookieBorrada(slug));
      if (e.codigo === "DEMASIADOS_INTENTOS" && e.detalle?.reintentarEnSeg)
        res.setHeader("Retry-After", String(e.detalle.reintentarEnSeg));
      return res.status(e.status).json({ error: e.message, codigo: e.codigo });
    }
    return next(e);
  };

  /** La sesión de esta petición para esta empresa, o null. Si trae una cookie que ya no vale, se borra. */
  async function sesionOpcional(req, res, empresa) {
    const token = leerCookie(req.headers?.cookie, cookieNombre(empresa.slug));
    if (!token) return null;
    const s = await obtenerSesion({ empresaId: empresa.id, token });
    if (!s) {
      res.setHeader("Set-Cookie", cookieBorrada(empresa.slug));
      return null;
    }
    return { sesion: s, token };
  }

  async function sesionRequerida(req, res, empresa, { permitirCambioPendiente = false } = {}) {
    const r = await sesionOpcional(req, res, empresa);
    if (!r) throw new ErrorAuth("SIN_SESION", "no autenticado");
    const pendiente = !!r.sesion.$locals.cliente.cuenta?.debeCambiarPassword;
    if (!permitirCambioPendiente && pendiente)
      throw new ErrorAuth("CAMBIO_PASSWORD_REQUERIDO", "debes cambiar tu contraseña temporal antes de continuar");
    return { ...r, pendiente };
  }

  /**
   * Middleware: exige la sesión de un cliente de la empresa que dice `empresaDe(req)` y deja
   * `req.cliente = { clienteId, empresaId, sesionId }`. Para las rutas del cliente de cualquier servicio.
   * `empresaDe` devuelve `{ id, slug }` (y lanza si la empresa no existe).
   */
  const autenticarCliente =
    ({ empresaDe, permitirCambioPendiente = false }) =>
    async (req, res, next) => {
      let empresa;
      try {
        empresa = await empresaDe(req);
        auth.exigirCsrf(req);
        const { sesion } = await sesionRequerida(req, res, empresa, { permitirCambioPendiente });
        req.cliente = { clienteId: String(sesion.clienteId), empresaId: String(empresa.id), sesionId: String(sesion._id) };
        conEmpresa(empresa.id, next);
      } catch (e) {
        responder(res, e, next, empresa?.slug);
      }
    };

  /**
   * Manejadores de la cuenta del cliente, listos para montar. `empresaDe(req)` dice de qué empresa es la petición
   * (el servicio que los monta la saca de su ruta, por ejemplo del slug) y devuelve `{ id, slug }`.
   *   registro      POST  { nombre, telefono?, correo?, password, quierePuntos? }   → 201, abre la sesión
   *   login         POST  { usuario, password }                                      → 200, abre la sesión
   *   logout        POST                                                             → 200
   *   yo            GET   → { sesion: false } sin sesión, o { sesion: true, cliente, puntos }
   *   password      POST  { passwordActual, passwordNueva }
   *   consentimiento PUT  { otorgado }   (programa de puntos)
   * Todas las que escriben exigen `x-requested-with`.
   */
  function manejadores({ empresaDe }) {
    const envolver = (escribe, fn) => async (req, res, next) => {
      let empresa;
      try {
        empresa = await empresaDe(req);
        if (escribe) auth.exigirCsrf(req);
        res.setHeader("Cache-Control", "no-store");
        await fn(req, res, empresa);
      } catch (e) {
        responder(res, e, next, empresa?.slug);
      }
    };
    const entrada = (req) => ({ ip: req.ip ?? null, agente: req.headers?.["user-agent"] ?? null });
    return {
      registro: envolver(true, async (req, res, empresa) => {
        const b = req.body ?? {};
        const r = await registrar({
          empresaId: empresa.id,
          nombre: b.nombre,
          telefono: b.telefono,
          correo: b.correo,
          paisTelefono: b.paisTelefono,
          password: b.password,
          quierePuntos: b.quierePuntos === true,
          ...entrada(req),
        });
        res.setHeader("Set-Cookie", cookieDe(empresa.slug, r.token));
        res.status(201).json(await yo({ empresaId: empresa.id, clienteId: r.cliente.id }));
      }),
      login: envolver(true, async (req, res, empresa) => {
        const r = await login({
          empresaId: empresa.id,
          usuario: req.body?.usuario,
          password: req.body?.password,
          ...entrada(req),
        });
        res.setHeader("Set-Cookie", cookieDe(empresa.slug, r.token));
        res.status(200).json(await yo({ empresaId: empresa.id, clienteId: r.cliente.id, debeCambiarPassword: r.debeCambiarPassword }));
      }),
      logout: envolver(true, async (req, res, empresa) => {
        await cerrarSesion({ empresaId: empresa.id, token: leerCookie(req.headers?.cookie, cookieNombre(empresa.slug)) });
        res.setHeader("Set-Cookie", cookieBorrada(empresa.slug));
        res.status(200).json({ ok: true });
      }),
      yo: envolver(false, async (req, res, empresa) => {
        const r = await sesionOpcional(req, res, empresa);
        if (!r) return res.status(200).json({ sesion: false });
        res.status(200).json(
          await yo({ empresaId: empresa.id, clienteId: String(r.sesion.clienteId), debeCambiarPassword: !!r.sesion.$locals.cliente.cuenta?.debeCambiarPassword }),
        );
      }),
      password: envolver(true, async (req, res, empresa) => {
        const { sesion } = await sesionRequerida(req, res, empresa, { permitirCambioPendiente: true });
        res.status(200).json(
          await cambiarPassword({
            empresaId: empresa.id,
            clienteId: String(sesion.clienteId),
            passwordActual: req.body?.passwordActual,
            passwordNueva: req.body?.passwordNueva,
            sesionId: sesion._id,
          }),
        );
      }),
      consentimiento: envolver(true, async (req, res, empresa) => {
        const { sesion } = await sesionRequerida(req, res, empresa);
        res.status(200).json(
          await cambiarMiConsentimiento({ empresaId: empresa.id, clienteId: String(sesion.clienteId), otorgado: req.body?.otorgado }),
        );
      }),
    };
  }

  // Manejadores del PERSONAL (se montan en /clientes junto con los de core.clientes; ver clientes/rutas.js).
  const respuestaPersonal = (res, e, next) => {
    if (e instanceof ErrorCliente || e instanceof ErrorAuth) return res.status(e.status).json({ error: e.message, codigo: e.codigo });
    return next(e);
  };
  const envolverPersonal = (fn) => async (req, res, next) => {
    try {
      auth.exigirCsrf(req);
      await fn(req, res);
    } catch (e) {
      respuestaPersonal(res, e, next);
    }
  };
  const basePersonal = (req) => ({
    empresaId: req.auth.empresaId,
    actor: { usuarioId: req.auth.usuarioId, permisos: req.rol?.permisos ?? [] },
  });
  const manejadoresPersonal = {
    /** POST /clientes/:clienteId/cuenta { password? | generarPassword: true } → 201 con la contraseña temporal (una vez) */
    crearCuenta: envolverPersonal(async (req, res) => {
      const r = await crearCuenta({
        ...basePersonal(req),
        clienteId: req.params?.clienteId,
        password: req.body?.password,
        generarPassword: req.body?.generarPassword === true,
      });
      res.setHeader("Cache-Control", "no-store");
      res.status(201).json(r);
    }),
    /** POST /clientes/:clienteId/cuenta/password { password? | generarPassword: true } */
    restablecerPassword: envolverPersonal(async (req, res) => {
      const r = await restablecerPassword({
        ...basePersonal(req),
        clienteId: req.params?.clienteId,
        password: req.body?.password,
        generarPassword: req.body?.generarPassword === true,
      });
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json(r);
    }),
  };

  return {
    crearCuenta,
    restablecerPassword,
    registrar,
    login,
    cambiarPassword,
    cambiarMiConsentimiento,
    yo,
    crearSesion,
    obtenerSesion,
    cerrarSesion,
    cerrarSesionesDe,
    autenticarCliente,
    manejadores,
    manejadoresPersonal,
    cookie: { nombre: cookieNombre },
    listo: () => SesionCliente.init(), // espera a que existan los índices (token único y TTL)
  };
}
