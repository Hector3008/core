import { randomBytes } from "node:crypto";
import { conEmpresa } from "../tenancy.js";
import { hashPassword } from "../password.js";
import { ErrorAuth } from "../auth/errores.js";
import { validarPassword } from "../auth/politica-password.js";
import { configPinDe } from "../auth/pin-config.js";
import { validarFormatoPin } from "../auth/pin.js";
import { ErrorEmpleado } from "./errores.js";
import {
  validarNombre,
  validarCorreo,
  validarTelefono,
  validarNombreRol,
  validarPermisos,
  alcanza,
  esAdmin,
  generarPasswordTemporal,
} from "./validacion.js";

const ID = /^[0-9a-f]{24}$/i;
const idValido = (v, nombre) => {
  if (!ID.test(String(v ?? ""))) throw new ErrorEmpleado("DATOS_INVALIDOS", `${nombre} inválido`);
  return String(v);
};
const duplicado = (e) => e?.code === 11000;

/**
 * Gestión del equipo de una empresa: alta, ficha, cambio de rol, baja y roles propios.
 *
 * Toda operación que cambia algo recibe `actor = { usuarioId, permisos }` (quien la pide) y aplica
 * una regla de fondo: nadie puede conceder ni tocar algo que él mismo no tiene. Así, un encargado
 * con `usuario:gestionar` no puede ascenderse, ni cambiar el rol, el PIN o la contraseña de un admin.
 * Las rutas protegen con `requierePermiso`; estas reglas protegen aunque alguien se olvide de ellas.
 */
export function crearServicioEmpleados({ Empresa, Usuario, Rol, Membresia, Sesion }, auth) {
  // ---------- ayudas ----------
  const actorDe = (actor) => {
    if (!actor || !Array.isArray(actor.permisos))
      throw new ErrorEmpleado("SIN_ALCANCE", "se requiere quién realiza la operación");
    return actor;
  };
  const esElMismo = (actor, usuarioId) => String(actor.usuarioId ?? "") === String(usuarioId);

  async function empresaOrError(empresaId) {
    const e = await Empresa.findById(empresaId).lean();
    if (!e || e.activa === false) throw new ErrorEmpleado("NO_ENCONTRADO", "empresa no encontrada");
    return e;
  }

  // La membresía y el rol de una persona (corre dentro de la empresa).
  async function objetivo(empresaId, usuarioId) {
    idValido(usuarioId, "usuarioId");
    return conEmpresa(empresaId, async () => {
      const m = await Membresia.findOne({ usuarioId }).lean();
      if (!m) throw new ErrorEmpleado("NO_ENCONTRADO", "esa persona no es empleada de esta empresa");
      const rol = await Rol.findById(m.rolId).lean();
      return { m, rol };
    });
  }

  const exigirAlcanceSobre = (actor, rol) => {
    if (!alcanza(actor.permisos, rol?.permisos ?? []))
      throw new ErrorEmpleado("SIN_ALCANCE", "esa persona tiene más permisos que tú");
  };

  async function contarAdminsActivos(empresaId) {
    return conEmpresa(empresaId, async () => {
      const roles = await Rol.find({ permisos: "*" }).select("_id").lean();
      if (!roles.length) return 0;
      return Membresia.countDocuments({ activa: true, rolId: { $in: roles.map((r) => r._id) } });
    });
  }
  async function exigirOtroAdmin(empresaId) {
    if ((await contarAdminsActivos(empresaId)) <= 1)
      throw new ErrorEmpleado("ULTIMO_ADMIN", "la empresa debe conservar al menos un administrador activo");
  }

  // Las credenciales y el nombre son globales (una persona puede trabajar en varias empresas):
  // solo se tocan desde aquí si la persona no tiene ninguna otra membresía.
  async function trabajaEnOtras(empresaId, usuarioId) {
    const n = await Membresia.countDocuments({ usuarioId, empresaId: { $ne: empresaId } }).setOptions({
      sinEmpresa: true,
    });
    return n > 0;
  }

  const rolDto = (r, empleados) => ({
    id: String(r._id),
    nombre: r.nombre,
    permisos: r.permisos,
    protegido: r.nombre === "admin" || esAdmin(r.permisos),
    ...(empleados === undefined ? {} : { empleados }),
  });

  function ficha(m, u, rol) {
    const t = Date.now();
    return {
      usuarioId: String(m.usuarioId),
      nombre: u?.nombre ?? null,
      correo: u?.correo ?? null,
      telefono: m.telefono ?? null,
      rol: rol?.nombre ?? null,
      rolId: String(m.rolId),
      activa: m.activa,
      tienePin: !!m.pinHash,
      bloqueadoHasta: m.pinBloqueadoHasta && m.pinBloqueadoHasta.getTime() > t ? m.pinBloqueadoHasta : null,
      passwordTemporalPendiente: !!u?.debeCambiarPassword,
    };
  }

  // ---------- empleados ----------
  async function listar({ empresaId, incluirInactivos = false }) {
    const { ms, roles } = await conEmpresa(empresaId, async () => {
      const ms = await Membresia.find(incluirInactivos ? {} : { activa: true }).select("+pinHash").lean();
      const roles = await Rol.find({ _id: { $in: ms.map((m) => m.rolId) } }).lean();
      return { ms, roles };
    });
    const usuarios = await Usuario.find({ _id: { $in: ms.map((m) => m.usuarioId) } }).lean();
    return ms
      .map((m) =>
        ficha(
          m,
          usuarios.find((u) => String(u._id) === String(m.usuarioId)),
          roles.find((r) => String(r._id) === String(m.rolId)),
        ),
      )
      .sort((a, b) => String(a.nombre ?? a.correo).localeCompare(String(b.nombre ?? b.correo)));
  }

  async function obtener({ empresaId, usuarioId }) {
    idValido(usuarioId, "usuarioId");
    const { m, rol } = await conEmpresa(empresaId, async () => {
      const m = await Membresia.findOne({ usuarioId }).select("+pinHash").lean();
      if (!m) throw new ErrorEmpleado("NO_ENCONTRADO", "esa persona no es empleada de esta empresa");
      return { m, rol: await Rol.findById(m.rolId).lean() };
    });
    const u = await Usuario.findById(usuarioId).lean();
    return ficha(m, u, rol);
  }

  /**
   * Alta. Dos formas de entrar (se puede dar una o las dos):
   *  - contraseña temporal (`password`, o `generarPassword: true` para que el servidor la genere y
   *    la devuelva una sola vez): la persona debe cambiarla en su primer ingreso;
   *  - PIN (`pin`) para la tablet.
   * Si el correo ya tiene cuenta, se añade a esta empresa con su cuenta de siempre: no se toca su
   * contraseña ni su nombre (solo se puede dar un PIN, que es por empresa).
   */
  async function crearEmpleado({ empresaId, actor, nombre, correo, telefono, rol, password, generarPassword = false, pin }) {
    actorDe(actor);
    const correoNorm = validarCorreo(correo);
    const tel = validarTelefono(telefono);
    if (typeof rol !== "string" || !rol.trim()) throw new ErrorEmpleado("DATOS_INVALIDOS", "rol requerido");
    const empresa = await empresaOrError(empresaId);
    const existente = await Usuario.findOne({ correo: correoNorm }).lean();

    let nombreFinal = existente?.nombre ?? null;
    if (existente) {
      if (password !== undefined || generarPassword)
        throw new ErrorEmpleado(
          "DATOS_INVALIDOS",
          "ese correo ya tiene cuenta en la plataforma: su contraseña no se puede fijar desde aquí",
        );
    } else {
      nombreFinal = validarNombre(nombre);
      if (password !== undefined && generarPassword)
        throw new ErrorEmpleado("DATOS_INVALIDOS", "elige una contraseña o que se genere, no las dos");
      if (password === undefined && !generarPassword && pin === undefined)
        throw new ErrorEmpleado("DATOS_INVALIDOS", "indica al menos una forma de entrar: contraseña temporal o PIN");
      if (password !== undefined) validarPassword(password);
    }
    if (pin !== undefined) {
      const config = configPinDe(empresa);
      if (!config.habilitado)
        throw new ErrorAuth("PIN_NO_HABILITADO", "el acceso por PIN no está habilitado en esta empresa");
      validarFormatoPin(pin, config);
    }

    const rolElegido = await conEmpresa(empresaId, async () => {
      const r = await Rol.findOne({ nombre: rol.trim() }).lean();
      if (!r) throw new ErrorEmpleado("NO_ENCONTRADO", `rol inexistente en esta empresa: ${rol}`);
      if (!alcanza(actor.permisos, r.permisos))
        throw new ErrorEmpleado("SIN_ALCANCE", "no puedes asignar un rol con más permisos que los tuyos");
      if (existente) {
        const m = await Membresia.findOne({ usuarioId: existente._id }).lean();
        if (m)
          throw new ErrorEmpleado(
            "YA_ES_MIEMBRO",
            m.activa ? "esa persona ya es empleada de esta empresa" : "esa persona está dada de baja: reactívala",
          );
      }
      return r;
    });

    let usuario = existente;
    let passwordTemporal = null;
    if (!existente) {
      const plano = generarPassword ? generarPasswordTemporal() : password;
      if (generarPassword) passwordTemporal = plano;
      const usaPassword = plano !== undefined;
      // Sin contraseña (solo PIN) se guarda un hash de algo que nadie conoce: no se puede entrar con él.
      const passwordHash = await hashPassword(usaPassword ? plano : randomBytes(32).toString("hex"));
      try {
        usuario = await Usuario.create({
          correo: correoNorm,
          nombre: nombreFinal,
          passwordHash,
          debeCambiarPassword: usaPassword,
        });
      } catch (e) {
        if (duplicado(e)) throw new ErrorEmpleado("ESTADO_INVALIDO", "ese correo se acaba de registrar: inténtalo de nuevo");
        throw e;
      }
    }
    try {
      await conEmpresa(empresaId, () =>
        Membresia.create({ usuarioId: usuario._id, rolId: rolElegido._id, telefono: tel ?? null }),
      );
    } catch (e) {
      if (!existente) await Usuario.deleteOne({ _id: usuario._id }); // no dejar una cuenta huérfana
      if (duplicado(e)) throw new ErrorEmpleado("YA_ES_MIEMBRO", "esa persona ya es empleada de esta empresa");
      throw e;
    }
    if (pin !== undefined) await auth.establecerPin({ empresaId, usuarioId: String(usuario._id), pin });

    return {
      usuarioId: String(usuario._id),
      nombre: nombreFinal,
      correo: correoNorm,
      telefono: tel ?? null,
      rol: rolElegido.nombre,
      usuarioExistente: !!existente,
      tienePin: pin !== undefined,
      passwordTemporal, // solo si se pidió generarla; no se vuelve a poder ver
    };
  }

  async function actualizar({ empresaId, actor, usuarioId, nombre, telefono }) {
    actorDe(actor);
    const tel = validarTelefono(telefono);
    const nom = nombre === undefined ? undefined : validarNombre(nombre);
    if (nom === undefined && tel === undefined) throw new ErrorEmpleado("DATOS_INVALIDOS", "no hay nada que cambiar");
    const { rol } = await objetivo(empresaId, usuarioId);
    exigirAlcanceSobre(actor, rol);
    if (nom !== undefined) {
      if (await trabajaEnOtras(empresaId, usuarioId))
        throw new ErrorEmpleado("COMPARTIDO", "esa persona trabaja en más de una empresa: su nombre lo cambia ella");
      await Usuario.updateOne({ _id: usuarioId }, { nombre: nom });
    }
    if (tel !== undefined) await conEmpresa(empresaId, async () => await Membresia.updateOne({ usuarioId }, { telefono: tel }));
    return obtener({ empresaId, usuarioId });
  }

  async function cambiarRol({ empresaId, actor, usuarioId, rol }) {
    actorDe(actor);
    idValido(usuarioId, "usuarioId");
    if (typeof rol !== "string" || !rol.trim()) throw new ErrorEmpleado("DATOS_INVALIDOS", "rol requerido");
    if (esElMismo(actor, usuarioId)) throw new ErrorEmpleado("SIN_ALCANCE", "no puedes cambiar tu propio rol");
    const { m, rol: actual } = await objetivo(empresaId, usuarioId);
    if (!m.activa) throw new ErrorEmpleado("ESTADO_INVALIDO", "esa persona está dada de baja: reactívala primero");
    const nuevo = await conEmpresa(empresaId, async () => await Rol.findOne({ nombre: rol.trim() }).lean());
    if (!nuevo) throw new ErrorEmpleado("NO_ENCONTRADO", `rol inexistente en esta empresa: ${rol}`);
    exigirAlcanceSobre(actor, actual);
    if (!alcanza(actor.permisos, nuevo.permisos))
      throw new ErrorEmpleado("SIN_ALCANCE", "no puedes asignar un rol con más permisos que los tuyos");
    if (esAdmin(actual?.permisos ?? []) && !esAdmin(nuevo.permisos)) await exigirOtroAdmin(empresaId);
    // Los permisos se leen del rol en cada request: el cambio rige de inmediato, sin cerrar sesiones.
    await conEmpresa(empresaId, async () => await Membresia.updateOne({ usuarioId }, { rolId: nuevo._id }));
    return obtener({ empresaId, usuarioId });
  }

  /** Baja: nunca se borra a nadie (documentos y eventos guardan su usuarioId). */
  async function desactivar({ empresaId, actor, usuarioId }) {
    actorDe(actor);
    idValido(usuarioId, "usuarioId");
    if (esElMismo(actor, usuarioId)) throw new ErrorEmpleado("SIN_ALCANCE", "no puedes darte de baja a ti mismo");
    const { m, rol } = await objetivo(empresaId, usuarioId);
    if (!m.activa) throw new ErrorEmpleado("ESTADO_INVALIDO", "esa persona ya está dada de baja");
    exigirAlcanceSobre(actor, rol);
    if (esAdmin(rol?.permisos ?? [])) await exigirOtroAdmin(empresaId);
    await conEmpresa(empresaId, async () =>
      await Membresia.updateOne(
        { usuarioId },
        { activa: false, pinHash: null, pinFallos: 0, pinBloqueadoHasta: null, pinActualizadoTs: new Date() },
      ),
    );
    const r = await Sesion.deleteMany({ usuarioId, empresaActivaId: empresaId });
    return { ok: true, sesionesCerradas: r.deletedCount };
  }

  /** Reactivar conserva el historial; el PIN se quitó en la baja y hay que fijarlo de nuevo. */
  async function reactivar({ empresaId, actor, usuarioId }) {
    actorDe(actor);
    const { m, rol } = await objetivo(empresaId, usuarioId);
    if (m.activa) throw new ErrorEmpleado("ESTADO_INVALIDO", "esa persona ya está activa");
    exigirAlcanceSobre(actor, rol);
    await conEmpresa(empresaId, async () => await Membresia.updateOne({ usuarioId }, { activa: true }));
    return obtener({ empresaId, usuarioId });
  }

  /** El administrador da una contraseña temporal nueva (la persona la cambia al entrar). */
  async function restablecerPassword({ empresaId, actor, usuarioId, password, generarPassword = false }) {
    actorDe(actor);
    idValido(usuarioId, "usuarioId");
    if (esElMismo(actor, usuarioId))
      throw new ErrorEmpleado("SIN_ALCANCE", "para cambiar tu propia contraseña usa /auth/password");
    if (password !== undefined && generarPassword)
      throw new ErrorEmpleado("DATOS_INVALIDOS", "elige una contraseña o que se genere, no las dos");
    if (password === undefined && !generarPassword)
      throw new ErrorEmpleado("DATOS_INVALIDOS", "indica la contraseña temporal o pide que se genere");
    if (password !== undefined) validarPassword(password);
    const { m, rol } = await objetivo(empresaId, usuarioId);
    if (!m.activa) throw new ErrorEmpleado("ESTADO_INVALIDO", "esa persona está dada de baja");
    exigirAlcanceSobre(actor, rol);
    if (await trabajaEnOtras(empresaId, usuarioId))
      throw new ErrorEmpleado(
        "COMPARTIDO",
        "esa persona trabaja en más de una empresa: su contraseña no se puede restablecer desde aquí",
      );
    const plano = generarPassword ? generarPasswordTemporal() : password;
    await Usuario.updateOne(
      { _id: usuarioId },
      { passwordHash: await hashPassword(plano), debeCambiarPassword: true },
    );
    const cerradas = await auth.cerrarSesionesDe(usuarioId);
    return { ok: true, passwordTemporal: generarPassword ? plano : null, sesionesCerradas: cerradas };
  }

  // PIN de otra persona: el mismo mecanismo de auth, con la regla de alcance por delante.
  async function establecerPinDe({ empresaId, actor, usuarioId, pin }) {
    actorDe(actor);
    const { m, rol } = await objetivo(empresaId, usuarioId);
    exigirAlcanceSobre(actor, rol);
    if (!m.activa) throw new ErrorEmpleado("ESTADO_INVALIDO", "esa persona está dada de baja");
    return auth.establecerPin({ empresaId, usuarioId, pin });
  }
  async function quitarPinDe({ empresaId, actor, usuarioId }) {
    actorDe(actor);
    const { rol } = await objetivo(empresaId, usuarioId);
    exigirAlcanceSobre(actor, rol);
    return auth.quitarPin({ empresaId, usuarioId });
  }

  // ---------- roles ----------
  async function listarRoles({ empresaId }) {
    const { roles, ms } = await conEmpresa(empresaId, async () => ({
      roles: await Rol.find({}).sort({ nombre: 1 }).lean(),
      ms: await Membresia.find({ activa: true }).select("rolId").lean(),
    }));
    return roles.map((r) => rolDto(r, ms.filter((m) => String(m.rolId) === String(r._id)).length));
  }

  async function crearRol({ empresaId, actor, nombre, permisos }) {
    actorDe(actor);
    const n = validarNombreRol(nombre);
    const p = validarPermisos(permisos ?? []);
    if (!alcanza(actor.permisos, p))
      throw new ErrorEmpleado("SIN_ALCANCE", "no puedes dar permisos que tú no tienes");
    try {
      const r = await conEmpresa(empresaId, () => Rol.create({ nombre: n, permisos: p }));
      return rolDto(r.toObject(), 0);
    } catch (e) {
      if (duplicado(e)) throw new ErrorEmpleado("ROL_DUPLICADO", "ya existe un rol con ese nombre");
      throw e;
    }
  }

  // Los roles con acceso total (como «admin») no se editan ni se borran.
  async function rolEditable(empresaId, actor, rolId) {
    idValido(rolId, "rolId");
    const r = await conEmpresa(empresaId, async () => await Rol.findById(rolId).lean());
    if (!r) throw new ErrorEmpleado("NO_ENCONTRADO", "rol no encontrado");
    if (r.nombre === "admin" || esAdmin(r.permisos))
      throw new ErrorEmpleado("ROL_PROTEGIDO", "los roles con acceso total no se pueden modificar");
    if (!alcanza(actor.permisos, r.permisos))
      throw new ErrorEmpleado("SIN_ALCANCE", "ese rol tiene permisos que tú no tienes");
    return r;
  }

  async function editarRol({ empresaId, actor, rolId, nombre, permisos }) {
    actorDe(actor);
    const cambios = {};
    if (nombre !== undefined) cambios.nombre = validarNombreRol(nombre);
    if (permisos !== undefined) {
      cambios.permisos = validarPermisos(permisos);
      if (!alcanza(actor.permisos, cambios.permisos))
        throw new ErrorEmpleado("SIN_ALCANCE", "no puedes dar permisos que tú no tienes");
    }
    if (!Object.keys(cambios).length) throw new ErrorEmpleado("DATOS_INVALIDOS", "no hay nada que cambiar");
    await rolEditable(empresaId, actor, rolId);
    if (cambios.nombre) {
      const otro = await conEmpresa(empresaId, async () => await Rol.findOne({ nombre: cambios.nombre, _id: { $ne: rolId } }).lean());
      if (otro) throw new ErrorEmpleado("ROL_DUPLICADO", "ya existe un rol con ese nombre");
    }
    try {
      const r = await conEmpresa(empresaId, async () =>
        await Rol.findOneAndUpdate({ _id: rolId }, cambios, { returnDocument: "after", lean: true }),
      );
      return rolDto(r);
    } catch (e) {
      if (duplicado(e)) throw new ErrorEmpleado("ROL_DUPLICADO", "ya existe un rol con ese nombre");
      throw e;
    }
  }

  async function eliminarRol({ empresaId, actor, rolId }) {
    actorDe(actor);
    await rolEditable(empresaId, actor, rolId);
    // Cuenta también las membresías dadas de baja: reactivarlas necesita su rol.
    const usos = await conEmpresa(empresaId, async () => await Membresia.countDocuments({ rolId }));
    if (usos > 0) throw new ErrorEmpleado("ROL_EN_USO", "hay empleados con ese rol: cámbiales el rol antes de borrarlo");
    await conEmpresa(empresaId, async () => await Rol.deleteOne({ _id: rolId }));
    return { ok: true };
  }

  // ---------- Express ----------
  const responder = (res, e, next) => {
    if (e instanceof ErrorEmpleado || e instanceof ErrorAuth)
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
  const base = (req) => ({
    empresaId: req.auth.empresaId,
    actor: { usuarioId: req.auth.usuarioId, permisos: req.rol?.permisos ?? [] },
  });
  const secreto = (res) => res.setHeader("Cache-Control", "no-store"); // la respuesta puede traer una contraseña

  const manejadores = {
    listar: envolver(false, async (req, res) =>
      res.status(200).json({
        empleados: await listar({ empresaId: req.auth.empresaId, incluirInactivos: req.query?.inactivos === "1" }),
      }),
    ),
    obtener: envolver(false, async (req, res) =>
      res.status(200).json(await obtener({ empresaId: req.auth.empresaId, usuarioId: req.params?.usuarioId })),
    ),
    crear: envolver(true, async (req, res) => {
      const b = req.body ?? {};
      const r = await crearEmpleado({
        ...base(req),
        nombre: b.nombre,
        correo: b.correo,
        telefono: b.telefono,
        rol: b.rol,
        password: b.password,
        generarPassword: b.generarPassword === true,
        pin: b.pin,
      });
      secreto(res);
      res.status(201).json(r);
    }),
    actualizar: envolver(true, async (req, res) =>
      res.status(200).json(
        await actualizar({
          ...base(req),
          usuarioId: req.params?.usuarioId,
          nombre: req.body?.nombre,
          telefono: req.body?.telefono,
        }),
      ),
    ),
    cambiarRol: envolver(true, async (req, res) =>
      res.status(200).json(
        await cambiarRol({ ...base(req), usuarioId: req.params?.usuarioId, rol: req.body?.rol }),
      ),
    ),
    desactivar: envolver(true, async (req, res) =>
      res.status(200).json(await desactivar({ ...base(req), usuarioId: req.params?.usuarioId })),
    ),
    reactivar: envolver(true, async (req, res) =>
      res.status(200).json(await reactivar({ ...base(req), usuarioId: req.params?.usuarioId })),
    ),
    restablecerPassword: envolver(true, async (req, res) => {
      const r = await restablecerPassword({
        ...base(req),
        usuarioId: req.params?.usuarioId,
        password: req.body?.password,
        generarPassword: req.body?.generarPassword === true,
      });
      secreto(res);
      res.status(200).json(r);
    }),
    establecerPin: envolver(true, async (req, res) =>
      res.status(200).json(
        await establecerPinDe({ ...base(req), usuarioId: req.params?.usuarioId, pin: req.body?.pin }),
      ),
    ),
    quitarPin: envolver(true, async (req, res) =>
      res.status(200).json(await quitarPinDe({ ...base(req), usuarioId: req.params?.usuarioId })),
    ),
    listarRoles: envolver(false, async (req, res) =>
      res.status(200).json({ roles: await listarRoles({ empresaId: req.auth.empresaId }) }),
    ),
    crearRol: envolver(true, async (req, res) =>
      res.status(201).json(
        await crearRol({ ...base(req), nombre: req.body?.nombre, permisos: req.body?.permisos }),
      ),
    ),
    editarRol: envolver(true, async (req, res) =>
      res.status(200).json(
        await editarRol({
          ...base(req),
          rolId: req.params?.rolId,
          nombre: req.body?.nombre,
          permisos: req.body?.permisos,
        }),
      ),
    ),
    eliminarRol: envolver(true, async (req, res) =>
      res.status(200).json(await eliminarRol({ ...base(req), rolId: req.params?.rolId })),
    ),
  };

  return {
    listar,
    obtener,
    crearEmpleado,
    actualizar,
    cambiarRol,
    desactivar,
    reactivar,
    restablecerPassword,
    establecerPin: establecerPinDe,
    quitarPin: quitarPinDe,
    listarRoles,
    crearRol,
    editarRol,
    eliminarRol,
    manejadores,
  };
}

export { ErrorEmpleado } from "./errores.js";
