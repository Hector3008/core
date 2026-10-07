import { randomInt, createHmac } from "node:crypto";
import { conEmpresa } from "../tenancy.js";
import { hashPassword, verificarPassword } from "../password.js";
import { ErrorAuth } from "./errores.js";
import { generarToken, hashToken } from "./tokens.js";
import { leerCookie } from "./cookies.js";
import { crearLimitador } from "./limitador.js";
import { configPinDe, validarConfigPin } from "./pin-config.js";

const MIN = 60_000;
const HORA = 60 * MIN;
const ID = /^[0-9a-f]{24}$/i;
// Sin I, O, 0 ni 1 para que nadie confunda letras con números al dictar el código.
const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const generarCodigo = () => Array.from({ length: 8 }, () => ALFABETO[randomInt(ALFABETO.length)]).join("");
const formatearCodigo = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
const normalizarCodigo = (c) => String(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

const esSecuencia = (p) => {
  let asc = true;
  let desc = true;
  for (let i = 1; i < p.length; i++) {
    const d = p.charCodeAt(i) - p.charCodeAt(i - 1);
    if (d !== 1) asc = false;
    if (d !== -1) desc = false;
  }
  return asc || desc;
};

function validarFormatoPin(pin, { largoMin, largoMax }) {
  if (typeof pin !== "string" || !/^\d+$/.test(pin))
    throw new ErrorAuth("PIN_INVALIDO", "el PIN debe ser un texto de solo dígitos");
  if (pin.length < largoMin || pin.length > largoMax)
    throw new ErrorAuth("PIN_INVALIDO", `el PIN debe tener entre ${largoMin} y ${largoMax} dígitos`);
  if (/^(\d)\1+$/.test(pin) || esSecuencia(pin))
    throw new ErrorAuth("PIN_INVALIDO", "PIN demasiado fácil de adivinar (repetido o en secuencia)");
}

const idValido = (v, nombre) => {
  if (!ID.test(String(v ?? ""))) throw new ErrorAuth("DATOS_INVALIDOS", `${nombre} inválido`);
  return String(v);
};

/**
 * Acceso por PIN en tablets emparejadas.
 *
 * Tres piezas: (1) la empresa activa el PIN y fija sus reglas; (2) un administrador empareja una
 * tablet con un código de un solo uso; (3) en la tablet, cada persona elige su nombre y escribe su
 * PIN, y recibe una sesión normal (metodo "pin"). Todo lo demás (autenticar, requierePermiso,
 * revocación) es el mismo mecanismo que ya usa la contraseña.
 */
export function crearServicioPin(
  { Usuario, Membresia, Rol, Empresa, Sesion, Dispositivo, CodigoEmparejamiento },
  base,
) {
  const { cfg, opciones, crearSesion, cerrarSesion, responderError, exigirCsrf } = base;
  const ahoraMs = () => cfg.ahora();

  const porIpCodigo = crearLimitador({
    max: opciones.intentosCodigoPorIp ?? 10,
    ventanaMs: opciones.ventanaIntentosMs ?? 15 * MIN,
    ahora: cfg.ahora,
  });
  const porDispositivo = crearLimitador({
    max: opciones.intentosPorDispositivo ?? 20,
    ventanaMs: opciones.ventanaIntentosMs ?? 15 * MIN,
    ahora: cfg.ahora,
  });
  const porUsuarioCambio = crearLimitador({ max: 5, ventanaMs: 15 * MIN, ahora: cfg.ahora });

  // Con "pimienta" (un secreto del servidor, fuera de la base de datos) el PIN se mezcla antes
  // del hash: si alguien copia la base de datos no puede adivinar los PIN sin ese secreto.
  const preparar = (pin) =>
    opciones.pinPimienta ? createHmac("sha256", opciones.pinPimienta).update(pin).digest("hex") : pin;
  const hashPin = (pin) => hashPassword(preparar(pin));
  const comprobarPin = (pin, hash) => verificarPassword(preparar(pin), hash);
  let hashFalso = null;
  const falso = () => (hashFalso ??= hashPassword("0000-falso"));

  const empresaOrError = async (empresaId) => {
    const e = await Empresa.findById(empresaId).lean();
    if (!e || e.activa === false) throw new ErrorAuth("NO_ENCONTRADO", "empresa no encontrada");
    return e;
  };
  const exigirHabilitado = (config) => {
    if (!config.habilitado) throw new ErrorAuth("PIN_NO_HABILITADO", "el acceso por PIN no está habilitado en esta empresa");
  };

  // ---------- opciones de la empresa ----------
  async function leerSeguridad({ empresaId }) {
    return { pin: configPinDe(await empresaOrError(empresaId)) };
  }

  async function guardarSeguridad({ empresaId, pin }) {
    const empresa = await empresaOrError(empresaId);
    const nueva = validarConfigPin(pin, configPinDe(empresa));
    if (Object.keys(nueva).length) {
      const set = Object.fromEntries(Object.entries(nueva).map(([k, v]) => [`seguridad.pin.${k}`, v]));
      await Empresa.updateOne({ _id: empresaId }, { $set: set });
    }
    return leerSeguridad({ empresaId });
  }

  // ---------- emparejar una tablet ----------
  async function crearCodigoEmparejamiento({ empresaId, usuarioId, nombre, estacion = null }) {
    if (typeof nombre !== "string" || !nombre.trim() || nombre.trim().length > 60)
      throw new ErrorAuth("DATOS_INVALIDOS", "nombre del dispositivo requerido (máximo 60 caracteres)");
    if (estacion !== null && (typeof estacion !== "string" || !/^[a-z0-9_-]{1,40}$/i.test(estacion)))
      throw new ErrorAuth("DATOS_INVALIDOS", "estacion inválida");
    const config = configPinDe(await empresaOrError(empresaId));
    exigirHabilitado(config);
    const codigo = generarCodigo();
    const expiraTs = new Date(ahoraMs() + config.codigoVigenciaMin * MIN);
    await conEmpresa(empresaId, () =>
      CodigoEmparejamiento.create({
        codigoHash: hashToken(codigo),
        nombre: nombre.trim(),
        estacion,
        creadoPor: usuarioId ?? null,
        expiraTs,
      }),
    );
    return { codigo: formatearCodigo(codigo), expiraTs };
  }

  async function emparejar({ codigo, ip = null }) {
    const espera = ip ? porIpCodigo.espera(ip) : 0;
    if (espera > 0)
      throw new ErrorAuth("DEMASIADOS_INTENTOS", "demasiados intentos, espera un momento", { reintentarEnSeg: espera });
    const limpio = normalizarCodigo(codigo);
    // Se consume de forma atómica: dos tablets con el mismo código no pueden ganar las dos.
    const registro =
      limpio.length === 8
        ? await CodigoEmparejamiento.findOneAndDelete({
            codigoHash: hashToken(limpio),
            expiraTs: { $gt: new Date(ahoraMs()) },
          }).setOptions({ sinEmpresa: true })
        : null;
    if (!registro) {
      if (ip) porIpCodigo.fallo(ip);
      throw new ErrorAuth("CODIGO_INVALIDO", "código inválido o vencido");
    }
    const empresa = await empresaOrError(registro.empresaId);
    exigirHabilitado(configPinDe(empresa));
    const token = generarToken();
    const t = new Date(ahoraMs());
    const dispositivo = await conEmpresa(registro.empresaId, () =>
      Dispositivo.create({
        nombre: registro.nombre,
        estacion: registro.estacion,
        tokenHash: hashToken(token),
        creadoPor: registro.creadoPor,
        creadoTs: t,
      }),
    );
    return {
      token,
      dispositivo: { id: String(dispositivo._id), nombre: dispositivo.nombre, estacion: dispositivo.estacion },
      empresa: { id: String(empresa._id), nombre: empresa.nombre, slug: empresa.slug },
    };
  }

  async function listarDispositivos({ empresaId }) {
    const ds = await conEmpresa(empresaId, async () => await Dispositivo.find({}).sort({ creadoTs: -1 }).lean());
    return ds.map((d) => ({
      id: String(d._id),
      nombre: d.nombre,
      estacion: d.estacion,
      activo: d.activo,
      creadoTs: d.creadoTs,
      ultimoUsoTs: d.ultimoUsoTs,
      revocadoTs: d.revocadoTs,
    }));
  }

  async function revocarDispositivo({ empresaId, id, usuarioId = null }) {
    idValido(id, "id");
    const d = await conEmpresa(empresaId, async () =>
      Dispositivo.findOneAndUpdate(
        { _id: id, activo: true },
        { activo: false, revocadoTs: new Date(ahoraMs()), revocadoPor: usuarioId },
        { returnDocument: "after", lean: true },
      ),
    );
    if (!d) throw new ErrorAuth("NO_ENCONTRADO", "dispositivo no encontrado");
    const r = await Sesion.deleteMany({ dispositivoId: id });
    return { ok: true, sesionesCerradas: r.deletedCount };
  }

  // ---------- PIN de cada persona ----------
  async function listarUsuarios({ empresaId }) {
    const filas = await conEmpresa(empresaId, async () => {
      const ms = await Membresia.find({ activa: true }).select("+pinHash").lean();
      const roles = await Rol.find({ _id: { $in: ms.map((m) => m.rolId) } }).lean();
      return { ms, roles };
    });
    const usuarios = await Usuario.find({ _id: { $in: filas.ms.map((m) => m.usuarioId) } }).lean();
    const t = ahoraMs();
    return filas.ms.map((m) => {
      const u = usuarios.find((x) => String(x._id) === String(m.usuarioId));
      const rol = filas.roles.find((r) => String(r._id) === String(m.rolId));
      return {
        usuarioId: String(m.usuarioId),
        nombre: u?.nombre ?? null,
        correo: u?.correo ?? null,
        rol: rol?.nombre ?? null,
        tienePin: !!m.pinHash,
        bloqueadoHasta: m.pinBloqueadoHasta && m.pinBloqueadoHasta.getTime() > t ? m.pinBloqueadoHasta : null,
      };
    });
  }

  async function establecerPin({ empresaId, usuarioId, pin }) {
    idValido(usuarioId, "usuarioId");
    const config = configPinDe(await empresaOrError(empresaId));
    exigirHabilitado(config);
    validarFormatoPin(pin, config);
    const pinHash = await hashPin(pin);
    const r = await conEmpresa(empresaId, async () =>
      Membresia.updateOne(
        { usuarioId, activa: true },
        { pinHash, pinFallos: 0, pinBloqueadoHasta: null, pinActualizadoTs: new Date(ahoraMs()) },
      ),
    );
    if (!r.matchedCount) throw new ErrorAuth("NO_ENCONTRADO", "esa persona no es miembro de la empresa");
    // Con un PIN nuevo, las sesiones abiertas con el PIN anterior dejan de valer.
    await Sesion.deleteMany({ usuarioId, metodo: "pin", empresaActivaId: empresaId });
    return { ok: true };
  }

  async function quitarPin({ empresaId, usuarioId }) {
    idValido(usuarioId, "usuarioId");
    const r = await conEmpresa(empresaId, async () =>
      Membresia.updateOne(
        { usuarioId },
        { pinHash: null, pinFallos: 0, pinBloqueadoHasta: null, pinActualizadoTs: new Date(ahoraMs()) },
      ),
    );
    if (!r.matchedCount) throw new ErrorAuth("NO_ENCONTRADO", "esa persona no es miembro de la empresa");
    await Sesion.deleteMany({ usuarioId, metodo: "pin", empresaActivaId: empresaId });
    return { ok: true };
  }

  // Comprueba un PIN contra la membresía y lleva la cuenta de fallos y el bloqueo (guardados en la
  // base de datos: sobreviven a reinicios y valen para todas las tablets). Corre dentro de conEmpresa.
  async function verificarPinDeUsuario({ usuarioId, pin, config }) {
    const m = await Membresia.findOne({ usuarioId, activa: true }).select("+pinHash");
    const t = ahoraMs();
    if (m?.pinBloqueadoHasta && m.pinBloqueadoHasta.getTime() > t)
      throw bloqueo(m.pinBloqueadoHasta, t);
    // Se verifica siempre algo (aunque no haya PIN) para que tarde igual y no delate nada.
    const correcto = await comprobarPin(String(pin), m?.pinHash ?? (await falso()));
    if (!m || !m.pinHash || !correcto) {
      if (m) {
        // $inc es atómico; el valor se lee después. Si dos fallos llegan a la vez, quien lea el
        // último valor ve el tope y bloquea (bloquear dos veces es inofensivo; no bloquear, no ocurre).
        await Membresia.updateOne({ _id: m._id }, { $inc: { pinFallos: 1 } });
        const r = await Membresia.findOne({ _id: m._id }).select("pinFallos").lean();
        if (r && r.pinFallos >= config.maxIntentos) {
          const hasta = new Date(t + config.bloqueoMin * MIN);
          await Membresia.updateOne({ _id: m._id }, { pinFallos: 0, pinBloqueadoHasta: hasta });
          throw bloqueo(hasta, t);
        }
      }
      throw new ErrorAuth("PIN_INCORRECTO", "PIN incorrecto");
    }
    if (m.pinFallos > 0) await Membresia.updateOne({ _id: m._id }, { pinFallos: 0 });
    return m;
  }
  const bloqueo = (hasta, t) =>
    new ErrorAuth("PIN_BLOQUEADO", "PIN bloqueado temporalmente", {
      hastaTs: hasta,
      reintentarEnSeg: Math.max(1, Math.ceil((hasta.getTime() - t) / 1000)),
    });

  async function cambiarMiPin({ empresaId, usuarioId, pin, password, pinActual }) {
    const config = configPinDe(await empresaOrError(empresaId));
    exigirHabilitado(config);
    validarFormatoPin(pin, config);
    const clave = String(usuarioId);
    const espera = porUsuarioCambio.espera(clave);
    if (espera > 0)
      throw new ErrorAuth("DEMASIADOS_INTENTOS", "demasiados intentos, espera un momento", { reintentarEnSeg: espera });
    // Para cambiar el PIN hay que demostrar quién eres: con la contraseña o con el PIN actual.
    if (typeof password === "string" && password) {
      const u = await Usuario.findById(usuarioId).select("+passwordHash");
      if (!u || !(await verificarPassword(password, u.passwordHash))) {
        porUsuarioCambio.fallo(clave);
        throw new ErrorAuth("CREDENCIALES_INVALIDAS", "contraseña incorrecta");
      }
    } else if (typeof pinActual === "string" && pinActual) {
      await conEmpresa(empresaId, () => verificarPinDeUsuario({ usuarioId, pin: pinActual, config }));
    } else {
      throw new ErrorAuth("DATOS_INVALIDOS", "indica tu contraseña o tu PIN actual");
    }
    porUsuarioCambio.exito(clave);
    return establecerPin({ empresaId, usuarioId, pin });
  }

  // ---------- en la tablet ----------
  async function dispositivoDe(req) {
    const token = leerCookie(req.headers?.cookie, cfg.cookieDispositivo);
    if (typeof token !== "string" || !token || token.length > 200)
      throw new ErrorAuth("DISPOSITIVO_INVALIDO", "dispositivo no emparejado");
    const d = await Dispositivo.findOne({ tokenHash: hashToken(token), activo: true }).setOptions({ sinEmpresa: true });
    const empresa = d ? await Empresa.findById(d.empresaId).lean() : null;
    if (!d || !empresa || empresa.activa === false)
      throw new ErrorAuth("DISPOSITIVO_INVALIDO", "dispositivo no emparejado");
    const t = ahoraMs();
    if (!d.ultimoUsoTs || t - d.ultimoUsoTs.getTime() >= 5 * MIN)
      await Dispositivo.updateOne({ _id: d._id }, { ultimoUsoTs: new Date(t) }).setOptions({ sinEmpresa: true });
    return { dispositivo: d, empresa, config: configPinDe(empresa) };
  }

  async function personasDe({ dispositivo, empresa, config }) {
    exigirHabilitado(config);
    const ms = await conEmpresa(dispositivo.empresaId, async () =>
      await Membresia.find({ activa: true, pinHash: { $ne: null } }).select("+pinHash usuarioId").lean(),
    );
    const usuarios = await Usuario.find({ _id: { $in: ms.map((m) => m.usuarioId) }, estado: "activo" }).lean();
    return {
      personas: usuarios
        .map((u) => ({ usuarioId: String(u._id), nombre: u.nombre ?? u.correo.split("@")[0] }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre)),
      config: {
        largoMin: config.largoMin,
        largoMax: config.largoMax,
        inactividadMin: config.inactividadMin,
      },
      dispositivo: { id: String(dispositivo._id), nombre: dispositivo.nombre, estacion: dispositivo.estacion },
      empresa: { nombre: empresa.nombre, slug: empresa.slug },
    };
  }

  async function entrar({ contexto, usuarioId, pin, ip = null, agente = null, tokenAnterior = null }) {
    const { dispositivo, config } = contexto;
    exigirHabilitado(config);
    idValido(usuarioId, "usuarioId");
    if (typeof pin !== "string" || pin.length > 12)
      throw new ErrorAuth("DATOS_INVALIDOS", "PIN requerido");
    const clave = String(dispositivo._id);
    const espera = porDispositivo.espera(clave);
    if (espera > 0)
      throw new ErrorAuth("DEMASIADOS_INTENTOS", "demasiados intentos en este dispositivo", { reintentarEnSeg: espera });
    let usuario;
    try {
      await conEmpresa(dispositivo.empresaId, () => verificarPinDeUsuario({ usuarioId, pin, config }));
      usuario = await Usuario.findById(usuarioId).select("nombre correo estado").lean();
      if (!usuario || usuario.estado !== "activo") throw new ErrorAuth("PIN_INCORRECTO", "PIN incorrecto");
    } catch (e) {
      if (e instanceof ErrorAuth && (e.codigo === "PIN_INCORRECTO" || e.codigo === "PIN_BLOQUEADO"))
        porDispositivo.fallo(clave);
      throw e;
    }
    if (tokenAnterior) await cerrarSesion(tokenAnterior); // cambio de persona en la misma tablet
    const { token } = await crearSesion({
      usuarioId,
      empresaActivaId: dispositivo.empresaId,
      metodo: "pin",
      dispositivoId: dispositivo._id,
      ip,
      agente,
      inactividadMs: config.inactividadMin * MIN,
      maximoMs: config.sesionMaxHoras * HORA,
    });
    return {
      token,
      usuario: { id: String(usuario._id), nombre: usuario.nombre ?? null },
      empresaActivaId: String(dispositivo.empresaId),
    };
  }

  // ---------- Express ----------
  const envolver = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (e) {
      responderError(res, e, next);
    }
  };
  const empresaDe = (req) => req.auth.empresaId;

  const manejadores = {
    leerSeguridad: envolver(async (req, res) => res.status(200).json(await leerSeguridad({ empresaId: empresaDe(req) }))),
    guardarSeguridad: envolver(async (req, res) => {
      exigirCsrf(req);
      res.status(200).json(await guardarSeguridad({ empresaId: empresaDe(req), pin: req.body?.pin }));
    }),
    crearCodigo: envolver(async (req, res) => {
      exigirCsrf(req);
      const r = await crearCodigoEmparejamiento({
        empresaId: empresaDe(req),
        usuarioId: req.auth.usuarioId,
        nombre: req.body?.nombre,
        estacion: req.body?.estacion ?? null,
      });
      res.status(201).json(r);
    }),
    listarDispositivos: envolver(async (req, res) =>
      res.status(200).json({ dispositivos: await listarDispositivos({ empresaId: empresaDe(req) }) })),
    revocarDispositivo: envolver(async (req, res) => {
      exigirCsrf(req);
      res.status(200).json(
        await revocarDispositivo({ empresaId: empresaDe(req), id: req.params?.id, usuarioId: req.auth.usuarioId }),
      );
    }),
    listarUsuarios: envolver(async (req, res) =>
      res.status(200).json({ usuarios: await listarUsuarios({ empresaId: empresaDe(req) }) })),
    establecerPin: envolver(async (req, res) => {
      exigirCsrf(req);
      res.status(200).json(await establecerPin({ empresaId: empresaDe(req), usuarioId: req.params?.usuarioId, pin: req.body?.pin }));
    }),
    quitarPin: envolver(async (req, res) => {
      exigirCsrf(req);
      res.status(200).json(await quitarPin({ empresaId: empresaDe(req), usuarioId: req.params?.usuarioId }));
    }),
    cambiarMiPin: envolver(async (req, res) => {
      exigirCsrf(req);
      res.status(200).json(
        await cambiarMiPin({
          empresaId: empresaDe(req),
          usuarioId: req.auth.usuarioId,
          pin: req.body?.pin,
          password: req.body?.password,
          pinActual: req.body?.pinActual,
        }),
      );
    }),
    // Las tres siguientes las usa la tablet: no hay sesión de persona, solo la cookie del dispositivo.
    emparejar: envolver(async (req, res) => {
      exigirCsrf(req);
      const r = await emparejar({ codigo: req.body?.codigo, ip: req.ip ?? null });
      res.setHeader("Set-Cookie", base.cookieDispositivoDe(r.token));
      res.status(201).json({ dispositivo: r.dispositivo, empresa: r.empresa });
    }),
    personas: envolver(async (req, res) => res.status(200).json(await personasDe(await dispositivoDe(req)))),
    entrar: envolver(async (req, res) => {
      exigirCsrf(req);
      const contexto = await dispositivoDe(req);
      const r = await entrar({
        contexto,
        usuarioId: req.body?.usuarioId,
        pin: req.body?.pin,
        ip: req.ip ?? null,
        agente: req.headers?.["user-agent"] ?? null,
        tokenAnterior: leerCookie(req.headers?.cookie, cfg.cookie.nombre),
      });
      res.setHeader("Set-Cookie", base.cookieDe(r.token));
      res.status(200).json({ usuario: r.usuario, empresaActivaId: r.empresaActivaId });
    }),
  };

  return {
    api: {
      leerSeguridad,
      guardarSeguridad,
      crearCodigoEmparejamiento,
      emparejar,
      listarDispositivos,
      revocarDispositivo,
      listarUsuarios,
      establecerPin,
      quitarPin,
      cambiarMiPin,
      entrarConPin: entrar,
      dispositivoDe,
      personasDe,
    },
    manejadores,
  };
}
