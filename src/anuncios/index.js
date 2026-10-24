import { conEmpresa } from "../tenancy.js";
import { permite } from "../permisos.js";
import { ErrorAuth } from "../auth/errores.js";
import { momentoLocal, zonaDeEmpresa } from "../zona.js";
import { ErrorAnuncio } from "./errores.js";
import { MAX_ANUNCIOS_ACTIVOS, validarAnuncio } from "./validacion.js";

const ID = /^[0-9a-f]{24}$/i;

/**
 * Anuncios: eventos y publicidad que el restaurante muestra en su carta pública (arquitectura 5.48).
 *
 * Hasta 50 activos por empresa. Un evento (concierto, noche de karaoke) lleva fecha y hora y sale hasta que pasa su día;
 * una publicidad es un aviso con vigencia opcional. El núcleo guarda y valida; qué servicio los muestra lo decide el servicio.
 *
 * Permisos (la operación los comprueba aunque la ruta no lo haga):
 *   anuncio:leer       → ver los anuncios (todos, también los pausados y vencidos)
 *   anuncio:gestionar  → crearlos, editarlos, pausarlos
 */
export function crearServicioAnuncios({ Empresa, Anuncio }, auth) {
  const sinActor = () => new ErrorAnuncio("PERMISO_INSUFICIENTE", "se requiere quién realiza la operación");
  const exigir = (actor, permiso) => {
    if (!actor || !Array.isArray(actor.permisos)) throw sinActor();
    if (!permite(actor.permisos, permiso)) throw new ErrorAnuncio("PERMISO_INSUFICIENTE", `permiso insuficiente (${permiso})`);
  };
  const exigirVer = (actor) => {
    if (!actor || !Array.isArray(actor.permisos)) throw sinActor();
    if (!permite(actor.permisos, "anuncio:leer") && !permite(actor.permisos, "anuncio:gestionar"))
      throw new ErrorAnuncio("PERMISO_INSUFICIENTE", "permiso insuficiente (anuncio:leer)");
  };

  const dto = (a) => ({
    id: String(a._id ?? a.id),
    titulo: a.titulo,
    descripcion: a.descripcion ?? null,
    activo: a.activo !== false,
    tipo: a.tipo,
    imagen: a.imagen ?? null,
    fecha: a.fecha ?? null,
    hora: a.hora ?? null,
    lugar: a.lugar ?? null,
    vigencia: a.vigencia && (a.vigencia.desde || a.vigencia.hasta) ? { desde: a.vigencia.desde ?? null, hasta: a.vigencia.hasta ?? null } : null,
    creadoTs: a.createdAt ?? null,
    actualizadoTs: a.updatedAt ?? null,
  });

  async function empresaDe(empresaId) {
    const e = await Empresa.findById(empresaId).lean();
    if (!e || e.activa === false) throw new ErrorAnuncio("NO_ENCONTRADO", "empresa no encontrada");
    return e;
  }

  async function cargar(empresaId, anuncioId) {
    if (!ID.test(String(anuncioId ?? ""))) throw new ErrorAnuncio("DATOS_INVALIDOS", "anuncioId inválido");
    const a = await conEmpresa(empresaId, async () => await Anuncio.findOne({ _id: anuncioId }).lean());
    if (!a) throw new ErrorAnuncio("NO_ENCONTRADO", "anuncio no encontrado");
    return dto(a);
  }

  async function exigirCupo(empresaId) {
    const n = await conEmpresa(empresaId, async () => await Anuncio.countDocuments({ activo: true }));
    if (n >= MAX_ANUNCIOS_ACTIVOS)
      throw new ErrorAnuncio("LIMITE_ALCANZADO", `ya hay ${MAX_ANUNCIOS_ACTIVOS} anuncios activos: pausa alguno para activar otro`);
  }

  /** Los anuncios de la empresa: activos primero, los más recientes arriba. */
  async function listar({ empresaId, actor }) {
    exigirVer(actor);
    const lista = await conEmpresa(empresaId, async () => await Anuncio.find({}).sort({ activo: -1, _id: -1 }).lean());
    return lista.map(dto);
  }

  async function crear({ empresaId, actor, ...datos }) {
    exigir(actor, "anuncio:gestionar");
    const r = validarAnuncio(datos);
    await empresaDe(empresaId);
    if (r.activo) await exigirCupo(empresaId);
    const nuevo = await conEmpresa(empresaId, async () => await Anuncio.create({ ...r, creadoPor: actor.usuarioId ?? null }));
    return dto(nuevo.toObject());
  }

  /** Cambia un anuncio. Para pausarlo, `activo: false`; nunca se borra. */
  async function editar({ empresaId, actor, anuncioId, ...cambios }) {
    exigir(actor, "anuncio:gestionar");
    const actual = await cargar(empresaId, anuncioId);
    const r = validarAnuncio(cambios, actual);
    if (r.activo && !actual.activo) await exigirCupo(empresaId);
    await conEmpresa(empresaId, async () => await Anuncio.updateOne({ _id: anuncioId }, { $set: r }));
    return await cargar(empresaId, anuncioId);
  }

  /**
   * Lo que un cliente ve en la carta pública: los anuncios activos, a la hora de la empresa. Sin actor (lectura pública).
   *  - eventos: hasta que pasa su día (el día del evento aún sale), el más próximo primero.
   *  - publicidad: dentro de su vigencia (sin fechas = siempre), la más reciente primero.
   * Nunca salen quién lo creó ni fechas internas.
   */
  async function vigentes({ empresaId, ahora = new Date() }) {
    const empresa = await empresaDe(empresaId);
    const zona = zonaDeEmpresa(empresa);
    const hoy = momentoLocal(ahora, zona).fecha;
    const lista = (await conEmpresa(empresaId, async () => await Anuncio.find({ activo: true }).sort({ _id: -1 }).lean())).map(dto);
    const publico = (a) => ({
      id: a.id, tipo: a.tipo, titulo: a.titulo, descripcion: a.descripcion, imagen: a.imagen,
      fecha: a.fecha, hora: a.hora, lugar: a.lugar, vigencia: a.vigencia,
    });
    const eventos = lista
      .filter((a) => a.tipo === "evento" && a.fecha >= hoy)
      .sort((x, y) => (x.fecha + x.hora < y.fecha + y.hora ? -1 : x.fecha + x.hora > y.fecha + y.hora ? 1 : 0))
      .map(publico);
    const publicidad = lista
      .filter((a) => a.tipo === "publicidad" && !(a.vigencia?.desde && a.vigencia.desde > hoy) && !(a.vigencia?.hasta && a.vigencia.hasta < hoy))
      .map(publico);
    return { zona, hoy, eventos, publicidad };
  }

  // ---------- manejadores HTTP ----------
  const responder = (res, e, next) => {
    if (e instanceof ErrorAnuncio || e instanceof ErrorAuth) return res.status(e.status).json({ error: e.message, codigo: e.codigo });
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
    /** GET /anuncios → { anuncios } (anuncio:leer) */
    listar: envolver(false, async (req, res) => res.status(200).json({ anuncios: await listar({ ...base(req) }) })),
    /** POST /anuncios { titulo, tipo, … } → 201 (anuncio:gestionar) */
    crear: envolver(true, async (req, res) => res.status(201).json(await crear({ ...base(req), ...(req.body ?? {}) }))),
    /** PUT /anuncios/:anuncioId { …cambios } (anuncio:gestionar) */
    editar: envolver(true, async (req, res) =>
      res.status(200).json(await editar({ ...base(req), anuncioId: req.params?.anuncioId, ...(req.body ?? {}) })),
    ),
  };

  return { listar, crear, editar, vigentes, manejadores };
}
