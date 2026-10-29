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
export function crearServicioPromociones({ Empresa, Promocion, UsoPromocion, ReservaPromocion }, auth) {
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
    topes: p.topes && (p.topes.diario || p.topes.porPedido || p.topes.porCliente) ? { diario: p.topes.diario ?? null, porPedido: p.topes.porPedido ?? null, porCliente: p.topes.porCliente ?? null } : null,
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
  async function evaluar({ empresaId, lineas, ahora = new Date(), solo = null, cupos = {} }) {
    const empresa = await empresaDe(empresaId);
    const promociones =
      solo ?? (await conEmpresa(empresaId, async () => await Promocion.find({ activa: true }).sort({ prioridad: 1, _id: 1 }).lean())).map(dto);
    return evaluarPromociones({ lineas, promociones, ahora, zona: zonaDeEmpresa(empresa), cupos });
  }


  // ---------- topes de usos (5.44) ----------
  //
  // Un USO es una unidad con descuento. Tres topes opcionales por promoción: `diario` (toda la empresa, por día),
  // `porPedido` (lo resuelve el evaluador) y `porCliente` (por cliente y por día; el pedido debe tener cliente).
  // Flujo de un servicio (tobt, 5.44) cada vez que recalcula un pedido abierto:
  //   1. `cupos(...)`          → cuántas unidades PUEDE rebajar cada promoción con tope de día o de cliente;
  //   2. `evaluar({ cupos })`  → el descuento ya recortado a esos cupos;
  //   3. `confirmarUsos(...)`  → toma esos usos de los contadores con un `$inc` condicionado al tope (dos pedidos a la vez
  //                              no pueden pasarse); si otro se llevó el último cupo, devuelve `ok: false` y se repite desde 1;
  //   4. si no se pudo guardar el pedido, `confirmarUsos` con el `previo` lo deja como estaba; si se anula, `liberarUsos`.
  // Cada pedido tiene su RESERVA por promoción (`referencia`): así recalcular sube o baja la diferencia y nunca cuenta dos veces.
  const DURACION_MS = 3 * 24 * 3600 * 1000;
  const claveDia = (empresa, ahora) => momentoLocal(ahora, zonaDeEmpresa(empresa)).fecha;
  const expiraDe = (ahora) => new Date(ahora.getTime() + DURACION_MS);
  const cl = (v) => (v === undefined || v === null || v === "" ? null : String(v));

  class Denegado extends Error {}

  /** Suma `delta` a un contador. Si sube, solo si no pasa del tope (`$inc` condicionado; el 11000 es «ya existe y no cabe»). */
  async function mover({ promocionId, dia, clienteId }, delta, tope, ahora, hechos) {
    if (!delta) return;
    const clave = { promocionId, dia, clienteId };
    if (delta > 0) {
      if (tope !== null && delta > tope) throw new Denegado();
      const filtro = tope === null ? clave : { ...clave, usos: { $lte: tope - delta } };
      try {
        await UsoPromocion.updateOne(filtro, { $inc: { usos: delta }, $setOnInsert: { expira: expiraDe(ahora) } }, { upsert: true });
      } catch (e) {
        if (e?.code === 11000) throw new Denegado();
        throw e;
      }
    } else {
      await UsoPromocion.updateOne({ ...clave, usos: { $gte: -delta } }, { $inc: { usos: delta } });
    }
    hechos.push({ clave, delta });
  }
  async function deshacer(hechos, ahora) {
    for (const { clave, delta } of [...hechos].reverse()) {
      try {
        if (delta > 0) await UsoPromocion.updateOne({ ...clave, usos: { $gte: delta } }, { $inc: { usos: -delta } });
        else await UsoPromocion.updateOne(clave, { $inc: { usos: -delta }, $setOnInsert: { expira: expiraDe(ahora) } }, { upsert: true });
      } catch {
        /* un contador que no se pudo devolver se corrige solo al día siguiente: la peor consecuencia es un cupo de menos */
      }
    }
  }

  const conTopes = (p) => p.topes && (p.topes.diario || p.topes.porCliente);

  /**
   * Cuántas unidades más puede rebajar cada promoción con tope de día o de cliente en ESTE pedido (`referencia`): lo que el
   * pedido ya tiene tomado más lo que queda libre. Nunca baja de lo ya tomado (rebajar un tope no quita descuentos concedidos).
   * Devuelve `{ [idPromocion]: { max, motivo } }`; `motivo`: «dia», «cliente» o «sin_cliente» (el tope por cliente exige uno).
   */
  async function cupos({ empresaId, referencia, clienteId = null, ahora = new Date() }) {
    const empresa = await empresaDe(empresaId);
    const hoy = claveDia(empresa, ahora);
    const cli = cl(clienteId);
    return await conEmpresa(empresaId, async () => {
      const promos = (await Promocion.find({ activa: true }).lean()).map(dto).filter(conTopes);
      if (!promos.length) return {};
      const reservas = await ReservaPromocion.find({ referencia: String(referencia) }).lean();
      const salida = {};
      for (const p of promos) {
        const r = reservas.find((x) => String(x.promocionId) === p.id) ?? null;
        const dia = r?.dia ?? hoy;
        let max = Infinity;
        let motivo = "dia";
        if (p.topes.diario) {
          const c = await UsoPromocion.findOne({ promocionId: p.id, dia, clienteId: null }).lean();
          max = (r?.usosDiario ?? 0) + Math.max(0, p.topes.diario - (c?.usos ?? 0));
        }
        if (p.topes.porCliente) {
          let tope;
          if (!cli) tope = 0;
          else {
            const c = await UsoPromocion.findOne({ promocionId: p.id, dia, clienteId: cli }).lean();
            const mio = r?.clienteId === cli ? r.usosCliente ?? 0 : 0;
            tope = mio + Math.max(0, p.topes.porCliente - (c?.usos ?? 0));
          }
          if (tope < max) {
            max = tope;
            motivo = cli ? "cliente" : "sin_cliente";
          }
        }
        salida[p.id] = { max, motivo };
      }
      return salida;
    });
  }

  /**
   * Deja la reserva de este pedido en `usos` ({ [idPromocion]: unidades con descuento }). Atómico por promoción y con
   * vuelta atrás si alguna no cabe: `{ ok: false, promocionId }` sin haber cambiado nada. `forzar` omite los topes
   * (para descuentos YA concedidos que se deben seguir contando). Devuelve `previo` para poder restaurar.
   */
  async function confirmarUsos({ empresaId, referencia, clienteId = null, usos = {}, ahora = new Date(), forzar = false }) {
    const empresa = await empresaDe(empresaId);
    const hoy = claveDia(empresa, ahora);
    const cli = cl(clienteId);
    const ref = String(referencia);
    return await conEmpresa(empresaId, async () => {
      const promos = (await Promocion.find({}).lean()).map(dto);
      const reservas = await ReservaPromocion.find({ referencia: ref }).lean();
      const ids = new Set([...promos.filter((p) => p.activa && conTopes(p)).map((p) => p.id), ...reservas.map((r) => String(r.promocionId))]);
      const hechos = [];
      const previo = {};
      const hechas = [];
      try {
        for (const id of ids) {
          const p = promos.find((x) => x.id === id) ?? null;
          const r = reservas.find((x) => String(x.promocionId) === id) ?? null;
          const n = Math.max(0, Math.trunc(Number(usos[id]) || 0));
          if (!r && n === 0) continue;
          const dia = r?.dia ?? hoy;
          const topeDia = p?.activa && p.topes?.diario ? p.topes.diario : null;
          const topeCli = p?.activa && p.topes?.porCliente ? p.topes.porCliente : null;
          // Contadores a los que esta reserva aporta: el del día (si hay tope diario) y el del cliente (si hay tope por cliente y cliente).
          const objDia = topeDia ? n : 0;
          const objCli = topeCli && cli ? n : 0;
          if (topeCli && !cli && n > 0 && !forzar) throw new Denegado();
          const heldDia = r?.usosDiario ?? 0;
          await mover({ promocionId: id, dia, clienteId: null }, objDia - heldDia, forzar ? null : topeDia, ahora, hechos);
          if (r?.clienteId && r.usosCliente && r.clienteId !== cli) await mover({ promocionId: id, dia, clienteId: r.clienteId }, -r.usosCliente, null, ahora, hechos);
          const heldCli = r?.clienteId === cli ? r.usosCliente ?? 0 : 0;
          if (cli) await mover({ promocionId: id, dia, clienteId: cli }, objCli - heldCli, forzar ? null : topeCli, ahora, hechos);
          previo[id] = r ? { usos: Math.max(r.usosDiario ?? 0, r.usosCliente ?? 0) } : { usos: 0 };
          hechas.push({ id, r, dia, objDia, objCli, cli });
        }
      } catch (e) {
        await deshacer(hechos, ahora);
        if (e instanceof Denegado) return { ok: false };
        throw e;
      }
      for (const { id, r, dia, objDia, objCli, cli: c } of hechas) {
        if (objDia === 0 && objCli === 0) {
          if (r) await ReservaPromocion.deleteOne({ promocionId: id, referencia: ref });
        } else {
          await ReservaPromocion.updateOne(
            { promocionId: id, referencia: ref },
            { $set: { dia, clienteId: objCli ? c : null, usosDiario: objDia, usosCliente: objCli, expira: expiraDe(ahora) } },
            { upsert: true },
          );
        }
      }
      return { ok: true, previo };
    });
  }

  /** El pedido se anuló: devuelve todos sus usos. */
  async function liberarUsos({ empresaId, referencia, ahora = new Date() }) {
    return await confirmarUsos({ empresaId, referencia, clienteId: null, usos: {}, ahora });
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

  return { listar, crear, editar, evaluar, vigentes, simular, cupos, confirmarUsos, liberarUsos, manejadores };
}
