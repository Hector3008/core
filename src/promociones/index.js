import { conEmpresa } from "../tenancy.js";
import { permite } from "../permisos.js";
import { ErrorAuth } from "../auth/errores.js";
import { momentoLocal, zonaDeEmpresa } from "../zona.js";
import { ErrorPromocion } from "./errores.js";
import { estaVigente, evaluarPromociones, MAX_UNIDADES } from "./evaluador.js";
import { MAX_PROMOCIONES_ACTIVAS, validarPromocion } from "./validacion.js";

const ID = /^[0-9a-f]{24}$/i;
const MAX_LINEAS_SIMULACION = 50;

/**
 * Promociones: descuentos automáticos sobre lo que lleva un pedido (arquitectura 5.40).
 *
 * Una empresa define hasta 100 promociones activas (2x1, «si lleva A, B con descuento», descuento directo), con
 * vigencia, días de la semana y horario. El núcleo guarda las reglas y sabe calcularlas; no sabe de pedidos: el
 * servicio le pasa las líneas de un pedido (`evaluar`) y decide qué hacer con el resultado (5.42).
 *
 * Permisos (la operación los comprueba aunque la ruta no lo haga):
 *   promocion:leer       → ver las promociones y simular
 *   promocion:gestionar  → crearlas, editarlas, pausarlas
 */
export function crearServicioPromociones({ Empresa, Promocion }, auth) {
  // ---------- ayudas ----------
  const sinActor = () => new ErrorPromocion("PERMISO_INSUFICIENTE", "se requiere quién realiza la operación");
  const exigir = (actor, permiso) => {
    if (!actor || !Array.isArray(actor.permisos)) throw sinActor();
    if (!permite(actor.permisos, permiso)) throw new ErrorPromocion("PERMISO_INSUFICIENTE", `permiso insuficiente (${permiso})`);
  };
  const exigirVer = (actor) => {
    if (!actor || !Array.isArray(actor.permisos)) throw sinActor();
    if (!permite(actor.permisos, "promocion:leer") && !permite(actor.permisos, "promocion:gestionar"))
      throw new ErrorPromocion("PERMISO_INSUFICIENTE", "permiso insuficiente (promocion:leer)");
  };

  const dto = (p) => ({
    id: String(p._id ?? p.id),
    nombre: p.nombre,
    descripcion: p.descripcion ?? null,
    activa: p.activa !== false,
    prioridad: p.prioridad ?? 100,
    acumulable: p.acumulable === true,
    tipo: p.tipo,
    objetivo: p.objetivo ? { itemCodigo: p.objetivo.itemCodigo ?? null, categoria: p.objetivo.categoria ?? null } : null,
    disparador: p.disparador ? { itemCodigo: p.disparador.itemCodigo ?? null, categoria: p.disparador.categoria ?? null } : null,
    n: p.n ?? null,
    m: p.m ?? null,
    efecto: p.efecto ?? null,
    valor: p.valor ?? null,
    vigencia: p.vigencia ? { desde: p.vigencia.desde ?? null, hasta: p.vigencia.hasta ?? null } : null,
    dias: Array.isArray(p.dias) && p.dias.length ? [...p.dias] : null,
    horario: p.horario?.desde ? { desde: p.horario.desde, hasta: p.horario.hasta } : null,
    creadaTs: p.createdAt ?? null,
    actualizadaTs: p.updatedAt ?? null,
  });

  async function empresaDe(empresaId) {
    const e = await Empresa.findById(empresaId).lean();
    if (!e || e.activa === false) throw new ErrorPromocion("NO_ENCONTRADO", "empresa no encontrada");
    return e;
  }

  async function cargar(empresaId, promocionId) {
    if (!ID.test(String(promocionId ?? ""))) throw new ErrorPromocion("DATOS_INVALIDOS", "promocionId inválido");
    const p = await conEmpresa(empresaId, async () => await Promocion.findOne({ _id: promocionId }).lean());
    if (!p) throw new ErrorPromocion("NO_ENCONTRADO", "promoción no encontrada");
    return dto(p);
  }

  const activas = (empresaId) => conEmpresa(empresaId, async () => await Promocion.countDocuments({ activa: true }));
  async function exigirCupo(empresaId) {
    if ((await activas(empresaId)) >= MAX_PROMOCIONES_ACTIVAS)
      throw new ErrorPromocion("LIMITE_ALCANZADO", `ya hay ${MAX_PROMOCIONES_ACTIVAS} promociones activas: pausa alguna para activar otra`);
  }

  // ---------- reglas de la empresa ----------

  /** Las promociones de la empresa: activas primero, por prioridad. */
  async function listar({ empresaId, actor }) {
    exigirVer(actor);
    const lista = await conEmpresa(empresaId, async () => await Promocion.find({}).sort({ activa: -1, prioridad: 1, _id: 1 }).lean());
    return lista.map(dto);
  }

  async function crear({ empresaId, actor, ...datos }) {
    exigir(actor, "promocion:gestionar");
    const r = validarPromocion(datos);
    await empresaDe(empresaId);
    if (r.activa) await exigirCupo(empresaId);
    const nueva = await conEmpresa(empresaId, async () => await Promocion.create({ ...r, creadoPor: actor.usuarioId ?? null }));
    return dto(nueva.toObject());
  }

  /** Cambia una promoción. Para pausarla, `activa: false`; nunca se borra. */
  async function editar({ empresaId, actor, promocionId, ...cambios }) {
    exigir(actor, "promocion:gestionar");
    const actual = await cargar(empresaId, promocionId);
    const r = validarPromocion(cambios, actual);
    if (r.activa && !actual.activa) await exigirCupo(empresaId);
    await conEmpresa(empresaId, async () => await Promocion.updateOne({ _id: promocionId }, { $set: r }));
    return await cargar(empresaId, promocionId);
  }

  // ---------- evaluar ----------

  /**
   * Evalúa las líneas de un pedido contra las promociones activas de la empresa, a la hora de la empresa. Es lo que
   * usa un servicio (sin actor: es una operación interna, no una ruta). `lineas`: [{ id?, codigo, categoria?, cantidad, precio }].
   */
  async function evaluar({ empresaId, lineas, ahora = new Date(), solo = null }) {
    const empresa = await empresaDe(empresaId);
    const promociones =
      solo ?? (await conEmpresa(empresaId, async () => await Promocion.find({ activa: true }).sort({ prioridad: 1, _id: 1 }).lean())).map(dto);
    return evaluarPromociones({ lineas, promociones, ahora, zona: zonaDeEmpresa(empresa) });
  }

  /**
   * Las promociones que un cliente puede ver (5.43, carta pública): las activas que aún no caducaron, con cada una
   * marcada `vigenteAhora` (según día, horario y fechas, a la hora de la empresa). Sin actor: es una lectura pública.
   * Solo salen los datos de la regla; nunca `prioridad`, `acumulable`, quién la creó ni fechas internas.
   */
  async function vigentes({ empresaId, ahora = new Date() }) {
    const empresa = await empresaDe(empresaId);
    const zona = zonaDeEmpresa(empresa);
    const momento = momentoLocal(ahora, zona);
    const lista = (await conEmpresa(empresaId, async () => await Promocion.find({ activa: true }).sort({ prioridad: 1, _id: 1 }).lean())).map(dto);
    return {
      zona,
      hoy: momento.fecha,
      promociones: lista
        .filter((p) => !(p.vigencia?.hasta && p.vigencia.hasta < momento.fecha)) // las ya vencidas no se muestran
        .map((p) => ({
          id: p.id, nombre: p.nombre, descripcion: p.descripcion, tipo: p.tipo, objetivo: p.objetivo, disparador: p.disparador,
          n: p.n, m: p.m, efecto: p.efecto, valor: p.valor, vigencia: p.vigencia, dias: p.dias, horario: p.horario,
          vigenteAhora: estaVigente(p, momento),
        })),
    };
  }

  /**
   * Prueba las reglas con un pedido de ejemplo, sin tocar ningún pedido. `borrador` (opcional) es una promoción aún sin
   * guardar; con `soloBorrador` se evalúa ella sola. `ahora` (ISO, opcional) sirve para probar un horario.
   */
  async function simular({ empresaId, actor, items, ahora, borrador, soloBorrador = false }) {
    exigirVer(actor);
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_LINEAS_SIMULACION)
      throw new ErrorPromocion("DATOS_INVALIDOS", `items: de 1 a ${MAX_LINEAS_SIMULACION} líneas`);
    const lineas = items.map((x, i) => {
      if (!x || typeof x !== "object") throw new ErrorPromocion("DATOS_INVALIDOS", `items[${i}]: un objeto`);
      const codigo = typeof x.codigo === "string" ? x.codigo.trim() : "";
      if (!codigo || codigo.length > 40) throw new ErrorPromocion("DATOS_INVALIDOS", `items[${i}].codigo: el código del ítem`);
      if (!Number.isInteger(x.cantidad) || x.cantidad < 1 || x.cantidad > 99) throw new ErrorPromocion("DATOS_INVALIDOS", `items[${i}].cantidad: un entero de 1 a 99`);
      if (typeof x.precio !== "number" || !Number.isFinite(x.precio) || x.precio < 0 || x.precio > 1_000_000)
        throw new ErrorPromocion("DATOS_INVALIDOS", `items[${i}].precio: un número desde 0 (el de una unidad)`);
      const categoria = x.categoria === undefined || x.categoria === null || x.categoria === "" ? null : String(x.categoria).trim().slice(0, 60);
      return { id: x.id ?? String(i), codigo, categoria, cantidad: x.cantidad, precio: x.precio };
    });
    if (lineas.reduce((n, l) => n + l.cantidad, 0) > MAX_UNIDADES)
      throw new ErrorPromocion("DATOS_INVALIDOS", `demasiadas unidades (hasta ${MAX_UNIDADES})`);
    let instante = new Date();
    if (ahora !== undefined && ahora !== null) {
      instante = new Date(ahora);
      if (typeof ahora !== "string" || Number.isNaN(instante.getTime())) throw new ErrorPromocion("DATOS_INVALIDOS", "ahora: una fecha y hora ISO (2026-10-23T01:00:00Z)");
    }
    let solo = null;
    let extra = [];
    if (borrador !== undefined && borrador !== null) {
      extra = [{ ...validarPromocion({ ...borrador, activa: true }), id: "borrador" }];
      if (soloBorrador) solo = extra;
    } else if (soloBorrador) {
      throw new ErrorPromocion("DATOS_INVALIDOS", "soloBorrador necesita un borrador");
    }
    if (solo) return await evaluar({ empresaId, lineas, ahora: instante, solo });
    const empresa = await empresaDe(empresaId);
    const guardadas = (await conEmpresa(empresaId, async () => await Promocion.find({ activa: true }).sort({ prioridad: 1, _id: 1 }).lean())).map(dto);
    return evaluarPromociones({ lineas, promociones: [...guardadas, ...extra], ahora: instante, zona: zonaDeEmpresa(empresa) });
  }

  // ---------- manejadores HTTP ----------
  const responder = (res, e, next) => {
    if (e instanceof ErrorPromocion || e instanceof ErrorAuth) return res.status(e.status).json({ error: e.message, codigo: e.codigo });
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
    /** GET /promociones → { promociones } (promocion:leer) */
    listar: envolver(false, async (req, res) => res.status(200).json({ promociones: await listar({ ...base(req) }) })),
    /** POST /promociones { nombre, tipo, … } → 201 (promocion:gestionar) */
    crear: envolver(true, async (req, res) => res.status(201).json(await crear({ ...base(req), ...(req.body ?? {}) }))),
    /** PUT /promociones/:promocionId { …cambios } (promocion:gestionar) */
    editar: envolver(true, async (req, res) =>
      res.status(200).json(await editar({ ...base(req), promocionId: req.params?.promocionId, ...(req.body ?? {}) })),
    ),
    /** POST /promociones/simular { items, ahora?, borrador?, soloBorrador? } (promocion:leer). No escribe: no pide CSRF. */
    simular: envolver(false, async (req, res) =>
      res.status(200).json(await simular({ ...base(req), items: req.body?.items, ahora: req.body?.ahora, borrador: req.body?.borrador, soloBorrador: req.body?.soloBorrador === true })),
    ),
  };

  return { listar, crear, editar, evaluar, vigentes, simular, manejadores };
}
