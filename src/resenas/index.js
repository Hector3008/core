import { conEmpresa } from "../tenancy.js";
import { permite } from "../permisos.js";
import { ErrorAuth } from "../auth/errores.js";
import { ErrorResena } from "./errores.js";
import { claveDe, nombrePublico, promedioDe, validarResena } from "./validacion.js";

const ID = /^[0-9a-f]{24}$/i;
const FILTROS = ["todas", "reportadas", "ocultas"];
const MAX_REPORTES_GUARDADOS = 200;

/**
 * Reseñas de platos (arquitectura 5.62): estrellas y texto, solo de quien ya pagó el plato.
 *
 * Reglas (decisiones de Héctor, 26 de octubre):
 *  - Solo opina quien tiene el plato en un pedido pagado. Quién pagó qué lo sabe el servicio que lleva los pedidos
 *    (tobt), no el núcleo: se le pregunta con `definirFuenteConsumo(async ({ empresaId, clienteId, itemCodigo }) => boolean)`.
 *    Sin esa función no se puede reseñar (falla cerrado).
 *  - Una reseña por cliente y plato, que el cliente puede editar y borrar.
 *  - Se publica al instante. Cualquier cliente con cuenta puede reportar la de otro; el personal con `resena:gestionar`
 *    la oculta (nunca se borra) o la vuelve a mostrar (eso limpia sus reportes). Una oculta no se arregla editándola.
 *  - El autor se muestra como «María P.» y se calcula al leer, desde la ficha del cliente.
 *
 * Permisos del personal (la operación los comprueba aunque la ruta no lo haga):
 *   resena:leer       → ver las reseñas de la empresa, también las ocultas y los reportes
 *   resena:gestionar  → ocultarlas y volver a mostrarlas
 * Las operaciones del cliente (`guardarMia`, `borrarMia`, `reportar`, `deItem`) no llevan actor: el servicio que las
 * monta debe pasar el `clienteId` de la SESIÓN del cliente, nunca uno que mande el cuerpo.
 */
export function crearServicioResenas({ Resena, Cliente, Item }, auth) {
  let fuenteConsumo = null;

  const sinActor = () => new ErrorResena("PERMISO_INSUFICIENTE", "se requiere quién realiza la operación");
  const exigir = (actor, permiso) => {
    if (!actor || !Array.isArray(actor.permisos)) throw sinActor();
    if (!permite(actor.permisos, permiso)) throw new ErrorResena("PERMISO_INSUFICIENTE", `permiso insuficiente (${permiso})`);
  };
  const exigirVer = (actor) => {
    if (!actor || !Array.isArray(actor.permisos)) throw sinActor();
    if (!permite(actor.permisos, "resena:leer") && !permite(actor.permisos, "resena:gestionar"))
      throw new ErrorResena("PERMISO_INSUFICIENTE", "permiso insuficiente (resena:leer)");
  };
  const idValido = (v, nombre) => {
    if (!ID.test(String(v ?? ""))) throw new ErrorResena("DATOS_INVALIDOS", `${nombre} inválido`);
  };
  const codigoValido = (c) => {
    const k = claveDe(c);
    if (!k || k.length > 60) throw new ErrorResena("DATOS_INVALIDOS", "itemCodigo: el código de un plato del catálogo");
    return k;
  };

  /** El servicio de pedidos dice si un cliente pagó un plato. */
  function definirFuenteConsumo(fn) {
    if (typeof fn !== "function") throw new Error("definirFuenteConsumo: se requiere una función");
    fuenteConsumo = fn;
  }

  const propia = (r) => ({
    id: String(r._id ?? r.id),
    itemCodigo: r.itemCodigo,
    estrellas: r.estrellas,
    texto: r.texto ?? null,
    oculta: r.oculta === true,
    ts: r.createdAt ?? null,
    editadaTs: r.updatedAt ?? null,
  });

  /** Nombres públicos de los clientes de un grupo de reseñas, en un solo viaje. */
  async function autoresDe(empresaId, lista) {
    const ids = [...new Set(lista.map((r) => String(r.clienteId)))];
    if (!ids.length) return new Map();
    const fichas = await conEmpresa(empresaId, async () => await Cliente.find({ _id: { $in: ids } }).select("nombre").lean());
    return new Map(fichas.map((c) => [String(c._id), nombrePublico(c.nombre)]));
  }

  // ---------- operaciones del cliente ----------

  /**
   * Crea o cambia la reseña del cliente sobre un plato. Exige que lo haya pagado. Si el personal la ocultó, sigue oculta.
   * Devuelve la reseña propia (con `oculta`).
   */
  async function guardarMia({ empresaId, clienteId, itemCodigo, ...datos }) {
    idValido(clienteId, "clienteId");
    const clave = codigoValido(itemCodigo);
    const r = validarResena(datos);
    if (!fuenteConsumo) throw new ErrorResena("ESTADO_INVALIDO", "las reseñas no están disponibles en este momento");
    const item = await conEmpresa(empresaId, async () => await Item.findOne({ codigoClave: clave, activo: true }).lean());
    if (!item) throw new ErrorResena("NO_ENCONTRADO", "plato no encontrado");
    const pago = await fuenteConsumo({ empresaId, clienteId: String(clienteId), itemCodigo: item.codigo });
    if (pago !== true) throw new ErrorResena("NO_PERMITIDO", "solo puedes opinar de un plato que ya pediste y pagaste");

    const actualizar = async () =>
      await conEmpresa(empresaId, async () => await Resena.updateOne({ itemClave: clave, clienteId }, { $set: r }));
    if ((await actualizar()).matchedCount === 0) {
      try {
        await conEmpresa(empresaId, async () => await Resena.create({ ...r, itemClave: clave, itemCodigo: item.codigo, clienteId }));
      } catch (e) {
        if (e?.code !== 11000) throw e;
        await actualizar(); // dos envíos a la vez: gana el último
      }
    }
    const guardada = await conEmpresa(empresaId, async () => await Resena.findOne({ itemClave: clave, clienteId }).lean());
    return propia(guardada);
  }

  /** El cliente borra su reseña. */
  async function borrarMia({ empresaId, clienteId, itemCodigo }) {
    idValido(clienteId, "clienteId");
    const clave = codigoValido(itemCodigo);
    const r = await conEmpresa(empresaId, async () => await Resena.deleteOne({ itemClave: clave, clienteId }));
    if (!r?.deletedCount) throw new ErrorResena("NO_ENCONTRADO", "no tienes una reseña de este plato");
    return { ok: true };
  }

  /** Un cliente reporta la reseña de otro. Repetirlo no suma. Una oculta ya no se ve, así que no se puede reportar. */
  async function reportar({ empresaId, clienteId, resenaId }) {
    idValido(clienteId, "clienteId");
    idValido(resenaId, "resenaId");
    const r = await conEmpresa(empresaId, async () => await Resena.findOne({ _id: resenaId, oculta: false }).lean());
    if (!r) throw new ErrorResena("NO_ENCONTRADO", "reseña no encontrada");
    if (String(r.clienteId) === String(clienteId)) throw new ErrorResena("ESTADO_INVALIDO", "no puedes reportar tu propia reseña");
    if ((r.reportadoPor ?? []).length < MAX_REPORTES_GUARDADOS)
      await conEmpresa(
        empresaId,
        async () =>
          await Resena.updateOne(
            { _id: resenaId, reportadoPor: { $ne: clienteId } },
            { $addToSet: { reportadoPor: clienteId }, $inc: { reportes: 1 } },
          ),
      );
    return { reportada: true };
  }

  // ---------- lectura pública ----------

  /**
   * Lo que la carta muestra de un plato: total, promedio, las reseñas visibles (las más recientes primero) y, si llega
   * `clienteId`, la reseña propia (también si está oculta). Sin datos del cliente salvo el nombre público.
   */
  async function deItem({ empresaId, itemCodigo, clienteId = null, limite = 20, saltar = 0 }) {
    const clave = codigoValido(itemCodigo);
    const lim = Number.isInteger(limite) && limite >= 1 ? Math.min(limite, 50) : 20;
    const sal = Number.isInteger(saltar) && saltar >= 0 ? saltar : 0;
    const [resumen, lista, mia] = await conEmpresa(empresaId, async () =>
      Promise.all([
        Resena.aggregate([
          { $match: { itemClave: clave, oculta: false } },
          { $group: { _id: null, total: { $sum: 1 }, suma: { $sum: "$estrellas" } } },
        ]),
        Resena.find({ itemClave: clave, oculta: false }).sort({ createdAt: -1, _id: -1 }).skip(sal).limit(lim).lean(),
        clienteId && ID.test(String(clienteId)) ? Resena.findOne({ itemClave: clave, clienteId }).lean() : null,
      ]),
    );
    const autores = await autoresDe(empresaId, lista);
    const total = resumen[0]?.total ?? 0;
    return {
      total,
      promedio: promedioDe(resumen[0]?.suma ?? 0, total),
      resenas: lista.map((r) => ({
        id: String(r._id),
        autor: autores.get(String(r.clienteId)) ?? "Anónimo",
        estrellas: r.estrellas,
        texto: r.texto ?? null,
        ts: r.createdAt ?? null,
        mia: clienteId ? String(r.clienteId) === String(clienteId) : false,
      })),
      mia: mia ? propia(mia) : null,
    };
  }

  // ---------- moderación (personal) ----------

  const fila = (r, autores, nombres) => ({
    id: String(r._id),
    itemCodigo: r.itemCodigo,
    itemNombre: nombres.get(String(r.itemClave)) ?? r.itemCodigo,
    autor: autores.get(String(r.clienteId)) ?? "Anónimo",
    estrellas: r.estrellas,
    texto: r.texto ?? null,
    oculta: r.oculta === true,
    reportes: r.reportes ?? 0,
    ts: r.createdAt ?? null,
    ocultaTs: r.ocultaTs ?? null,
  });

  /** Reseñas de la empresa para moderar. `filtro`: todas (por defecto), reportadas (con reportes) u ocultas. Reportadas primero. */
  async function listar({ empresaId, actor, filtro = "todas", limite = 100, saltar = 0 }) {
    exigirVer(actor);
    if (!FILTROS.includes(filtro)) throw new ErrorResena("DATOS_INVALIDOS", `filtro: ${FILTROS.join(", ")}`);
    const lim = Number.isInteger(limite) && limite >= 1 ? Math.min(limite, 200) : 100;
    const sal = Number.isInteger(saltar) && saltar >= 0 ? saltar : 0;
    const donde = filtro === "reportadas" ? { reportes: { $gt: 0 } } : filtro === "ocultas" ? { oculta: true } : {};
    const lista = await conEmpresa(
      empresaId,
      async () => await Resena.find(donde).sort({ reportes: -1, createdAt: -1, _id: -1 }).skip(sal).limit(lim).lean(),
    );
    const claves = [...new Set(lista.map((r) => r.itemClave))];
    const [autores, items] = await Promise.all([
      autoresDe(empresaId, lista),
      claves.length
        ? conEmpresa(empresaId, async () => await Item.find({ codigoClave: { $in: claves } }).select("codigoClave nombre").lean())
        : [],
    ]);
    const nombres = new Map(items.map((i) => [String(i.codigoClave), i.nombre]));
    return lista.map((r) => fila(r, autores, nombres));
  }

  /** Oculta (`oculta: true`) o vuelve a mostrar una reseña. Al mostrarla se limpian sus reportes. */
  async function moderar({ empresaId, actor, resenaId, oculta }) {
    exigir(actor, "resena:gestionar");
    idValido(resenaId, "resenaId");
    if (typeof oculta !== "boolean") throw new ErrorResena("DATOS_INVALIDOS", "oculta: debe ser verdadero o falso");
    const r = await conEmpresa(empresaId, async () => await Resena.findOne({ _id: resenaId }).lean());
    if (!r) throw new ErrorResena("NO_ENCONTRADO", "reseña no encontrada");
    if ((r.oculta === true) !== oculta) {
      const cambio = oculta
        ? { oculta: true, ocultaPor: actor.usuarioId ?? null, ocultaTs: new Date() }
        : { oculta: false, ocultaPor: null, ocultaTs: null, reportadoPor: [], reportes: 0 };
      await conEmpresa(empresaId, async () => await Resena.updateOne({ _id: resenaId }, { $set: cambio }));
    }
    const [fresca] = await conEmpresa(empresaId, async () => [await Resena.findOne({ _id: resenaId }).lean()]);
    const [autores, items] = await Promise.all([
      autoresDe(empresaId, [fresca]),
      conEmpresa(empresaId, async () => await Item.find({ codigoClave: { $in: [fresca.itemClave] } }).select("codigoClave nombre").lean()),
    ]);
    return fila(fresca, autores, new Map(items.map((i) => [String(i.codigoClave), i.nombre])));
  }

  // ---------- manejadores HTTP del personal ----------
  const responder = (res, e, next) => {
    if (e instanceof ErrorResena || e instanceof ErrorAuth) return res.status(e.status).json({ error: e.message, codigo: e.codigo });
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
  const entero = (v) => (v === undefined ? undefined : /^\d+$/.test(String(v)) ? Number(v) : NaN);

  const manejadores = {
    /** GET /resenas?filtro=&limite=&saltar= → { resenas } (resena:leer) */
    listar: envolver(false, async (req, res) => {
      const q = req.query ?? {};
      const opc = {};
      if (q.filtro !== undefined) opc.filtro = String(q.filtro);
      if (q.limite !== undefined) opc.limite = entero(q.limite);
      if (q.saltar !== undefined) opc.saltar = entero(q.saltar);
      res.status(200).json({ resenas: await listar({ ...base(req), ...opc }) });
    }),
    /** PUT /resenas/:resenaId/visibilidad { oculta } (resena:gestionar) */
    moderar: envolver(true, async (req, res) =>
      res.status(200).json(await moderar({ ...base(req), resenaId: req.params?.resenaId, oculta: req.body?.oculta })),
    ),
  };

  return { definirFuenteConsumo, guardarMia, borrarMia, reportar, deItem, listar, moderar, manejadores };
}
