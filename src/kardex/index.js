import { conEmpresa } from "../tenancy.js";
import { permite } from "../permisos.js";
import { ErrorAuth } from "../auth/errores.js";
import { ErrorKardex } from "./errores.js";
import {
  TIPOS_MOVIMIENTO, MAX_INSUMOS, aUnidadBase, aplicarMovimiento, claveDeCodigo, redondear,
  validarCantidad, validarDetalle, validarInsumo,
} from "./calculo.js";

const ID = /^[0-9a-f]{24}$/i;
const REINTENTOS = 8;
const MAX_LISTA = 200;

/**
 * Kardex: libro de movimientos de insumos con saldo y costo promedio (arquitectura 5.75).
 *
 * El núcleo no sabe nada de recetas ni de pedidos: guarda insumos, movimientos y saldos. Un servicio (tobt) decide
 * qué platos gastan qué insumos y llama a `consumirVarios` / `revertir` con la referencia del documento.
 *
 * Permisos (cada operación los comprueba aunque la ruta no lo haga):
 *   kardex:leer       → ver insumos, saldos, movimientos y valorización
 *   kardex:registrar  → compras y mermas
 *   kardex:gestionar  → insumos y presentaciones, inventario inicial, conteo físico, reparar saldos
 * Los consumos que salen de un pedido los pide el servicio, sin actor (son del sistema).
 */
export function crearServicioKardex({ Empresa, Insumo, MovimientoKardex }, auth) {
  const sinActor = () => new ErrorKardex("PERMISO_INSUFICIENTE", "se requiere quién realiza la operación");
  const exigir = (actor, permiso) => {
    if (!actor || !Array.isArray(actor.permisos)) throw sinActor();
    if (!permite(actor.permisos, permiso)) throw new ErrorKardex("PERMISO_INSUFICIENTE", `permiso insuficiente (${permiso})`);
  };
  const exigirVer = (actor) => {
    if (!actor || !Array.isArray(actor.permisos)) throw sinActor();
    if (!["kardex:leer", "kardex:registrar", "kardex:gestionar"].some((p) => permite(actor.permisos, p)))
      throw new ErrorKardex("PERMISO_INSUFICIENTE", "permiso insuficiente (kardex:leer)");
  };
  const idValido = (id, nombre) => {
    if (!ID.test(String(id ?? ""))) throw new ErrorKardex("DATOS_INVALIDOS", `${nombre} inválido`);
    return String(id);
  };

  const dto = (i) => {
    const existencia = i.existencia ?? 0;
    const costoPromedio = i.costoPromedio ?? 0;
    return {
      id: String(i._id ?? i.id),
      codigo: i.codigo,
      nombre: i.nombre,
      unidad: i.unidad,
      presentaciones: (i.presentaciones ?? []).map((p) => ({ nombre: p.nombre, factor: p.factor })),
      stockMinimo: i.stockMinimo ?? 0,
      activo: i.activo !== false,
      existencia,
      costoPromedio,
      valor: redondear(existencia * costoPromedio, 2),
      bajoMinimo: (i.stockMinimo ?? 0) > 0 && existencia <= i.stockMinimo,
      creadoTs: i.createdAt ?? null,
    };
  };
  const dtoMov = (m) => ({
    id: String(m._id ?? m.id),
    insumoId: String(m.insumoId),
    secuencia: m.secuencia,
    tipo: m.tipo,
    cantidad: m.cantidad,
    costoUnitario: m.costoUnitario,
    valor: m.valor,
    existenciaDespues: m.existenciaDespues,
    costoPromedioDespues: m.costoPromedioDespues,
    presentacion: m.presentacion ?? null,
    referencia: m.referencia ?? null,
    detalle: m.detalle ?? null,
    creadoPor: m.creadoPor ? String(m.creadoPor) : null,
    ts: m.ts,
  });

  async function empresaDe(empresaId) {
    const e = await Empresa.findById(empresaId).lean();
    if (!e || e.activa === false) throw new ErrorKardex("NO_ENCONTRADO", "empresa no encontrada");
    return e;
  }
  async function cargarInsumo(empresaId, insumoId) {
    idValido(insumoId, "insumoId");
    const i = await conEmpresa(empresaId, async () => await Insumo.findOne({ _id: insumoId }).lean());
    if (!i) throw new ErrorKardex("NO_ENCONTRADO", "insumo no encontrado");
    return i;
  }

  // ---------- insumos ----------
  async function crearInsumo({ empresaId, actor, ...datos }) {
    exigir(actor, "kardex:gestionar");
    const r = validarInsumo(datos);
    await empresaDe(empresaId);
    const n = await conEmpresa(empresaId, async () => await Insumo.countDocuments({}));
    if (n >= MAX_INSUMOS) throw new ErrorKardex("ESTADO_INVALIDO", `ya hay ${MAX_INSUMOS} insumos: desactiva alguno`);
    try {
      const nuevo = await conEmpresa(empresaId, async () =>
        await Insumo.create({ ...r, codigoClave: claveDeCodigo(r.codigo), creadoPor: actor.usuarioId ?? null }),
      );
      return dto(nuevo.toObject());
    } catch (e) {
      if (e?.code === 11000)
        throw new ErrorKardex("INSUMO_DUPLICADO", `ya hay un insumo con el código «${r.codigo}»`, { campo: "codigo" });
      throw e;
    }
  }

  /** Cambia nombre, stock mínimo, presentaciones o estado. Código y unidad base no cambian. Nunca se borra: se desactiva. */
  async function editarInsumo({ empresaId, actor, insumoId, ...cambios }) {
    exigir(actor, "kardex:gestionar");
    const actual = await cargarInsumo(empresaId, insumoId);
    const r = validarInsumo(cambios, actual);
    if (Object.keys(r).length)
      await conEmpresa(empresaId, async () => await Insumo.updateOne({ _id: insumoId }, { $set: r }));
    return dto(await cargarInsumo(empresaId, insumoId));
  }

  async function obtenerInsumo({ empresaId, actor, insumoId }) {
    exigirVer(actor);
    return dto(await cargarInsumo(empresaId, insumoId));
  }

  /** Lista con saldo. `texto` busca por comienzo del código o parte del nombre; `bajoMinimo` deja solo los que están en alerta. */
  async function listarInsumos({ empresaId, actor, texto, bajoMinimo = false, incluirInactivos = false, limite = 100, saltar = 0 }) {
    exigirVer(actor);
    const todos = (await conEmpresa(empresaId, async () => await Insumo.find({}).sort({ nombre: 1 }).lean())).map(dto);
    const t = typeof texto === "string" ? texto.trim().toLowerCase() : "";
    let lista = todos.filter((i) => incluirInactivos || i.activo);
    if (t) lista = lista.filter((i) => i.codigo.toLowerCase().startsWith(t) || i.nombre.toLowerCase().includes(t));
    if (bajoMinimo) lista = lista.filter((i) => i.bajoMinimo);
    const lim = Math.min(Math.max(Number(limite) || 100, 1), MAX_LISTA);
    const sal = Math.max(Number(saltar) || 0, 0);
    return { total: lista.length, insumos: lista.slice(sal, sal + lim) };
  }

  /** Lo que hay guardado en el kardex y cuánto vale: por insumo y en total (existencia × costo promedio). */
  async function valorizacion({ empresaId, actor }) {
    exigirVer(actor);
    const todos = (await conEmpresa(empresaId, async () => await Insumo.find({}).sort({ nombre: 1 }).lean())).map(dto);
    const con = todos.filter((i) => i.activo || i.existencia !== 0);
    return {
      total: redondear(con.reduce((s, i) => s + i.valor, 0), 2),
      insumos: con.map((i) => ({ id: i.id, codigo: i.codigo, nombre: i.nombre, unidad: i.unidad, existencia: i.existencia, costoPromedio: i.costoPromedio, valor: i.valor })),
      bajoMinimo: con.filter((i) => i.bajoMinimo).map((i) => ({ id: i.id, codigo: i.codigo, nombre: i.nombre, existencia: i.existencia, stockMinimo: i.stockMinimo })),
      negativos: con.filter((i) => i.existencia < 0).map((i) => ({ id: i.id, codigo: i.codigo, nombre: i.nombre, existencia: i.existencia })),
    };
  }

  // ---------- movimientos ----------
  const esDuplicado = (e) => e?.code === 11000;
  const esDeReferencia = (e) =>
    Boolean(e?.keyPattern && "referencia" in e.keyPattern) || /referencia_unica/.test(String(e?.message ?? ""));

  async function ultimoMovimiento(empresaId, insumoId) {
    return await conEmpresa(empresaId, async () => await MovimientoKardex.findOne({ insumoId }).sort({ secuencia: -1 }).lean());
  }
  const estadoDe = (ultimo) =>
    ultimo ? { existencia: ultimo.existenciaDespues, costoPromedio: ultimo.costoPromedioDespues } : { existencia: 0, costoPromedio: 0 };

  /**
   * Inserta un movimiento en la cuenta del insumo. La secuencia siguiente la reserva el índice único: si otro movimiento
   * llegó antes, se reintenta con el estado nuevo. Con `referencia`, repetir no hace nada (`yaRegistrado`).
   * `cantidad` es positiva y en unidad base; `signo` dice si entra o sale.
   */
  async function aplicar({ empresaId, insumoId, tipo, signo, cantidad, costoUnitario = null, detalle = null, referencia = null, presentacion = null, creadoPor = null, ahora = new Date() }) {
    if (!TIPOS_MOVIMIENTO.includes(tipo)) throw new ErrorKardex("DATOS_INVALIDOS", `tipo de movimiento desconocido: ${tipo}`);
    if (referencia) {
      const previo = await conEmpresa(empresaId, async () => await MovimientoKardex.findOne({ insumoId, referencia, tipo }).lean());
      if (previo) return { yaRegistrado: true, movimiento: dtoMov(previo) };
    }
    for (let intento = 0; intento < REINTENTOS; intento += 1) {
      const ultimo = await ultimoMovimiento(empresaId, insumoId);
      const secuencia = (ultimo?.secuencia ?? 0) + 1;
      const nuevo = aplicarMovimiento(estadoDe(ultimo), { signo, cantidad, costoUnitario });
      const doc = {
        insumoId, secuencia, tipo,
        cantidad: signo * cantidad,
        costoUnitario: nuevo.costoUnitario,
        valor: redondear(signo * cantidad * nuevo.costoUnitario, 4),
        existenciaDespues: nuevo.existencia,
        costoPromedioDespues: nuevo.costoPromedio,
        presentacion, referencia, detalle, creadoPor, ts: ahora,
      };
      let creado;
      try {
        creado = await conEmpresa(empresaId, async () => await MovimientoKardex.create(doc));
      } catch (e) {
        if (!esDuplicado(e)) throw e;
        if (esDeReferencia(e)) {
          const previo = await conEmpresa(empresaId, async () => await MovimientoKardex.findOne({ insumoId, referencia, tipo }).lean());
          if (previo) return { yaRegistrado: true, movimiento: dtoMov(previo) };
        }
        continue; // otro movimiento tomó esa secuencia: se recalcula con el estado nuevo
      }
      // Copia del saldo en el insumo: solo avanza (nunca retrocede si llegan fuera de orden). No es la fuente de verdad.
      try {
        await conEmpresa(empresaId, async () =>
          await Insumo.updateOne(
            { _id: insumoId, ultimaSecuencia: { $lt: secuencia } },
            { $set: { existencia: nuevo.existencia, costoPromedio: nuevo.costoPromedio, ultimaSecuencia: secuencia } },
          ),
        );
      } catch {
        /* la copia se rehace con repararSaldo; el movimiento ya quedó guardado */
      }
      return { yaRegistrado: false, movimiento: dtoMov(creado.toObject ? creado.toObject() : creado), negativo: nuevo.negativo };
    }
    throw new ErrorKardex("CONFLICTO", "demasiados cambios a la vez en este insumo: inténtalo de nuevo");
  }

  const respuesta = (insumo, r) => ({
    movimiento: r.movimiento,
    existencia: r.movimiento.existenciaDespues,
    costoPromedio: r.movimiento.costoPromedioDespues,
    negativo: r.movimiento.existenciaDespues < 0,
    bajoMinimo: (insumo.stockMinimo ?? 0) > 0 && r.movimiento.existenciaDespues <= insumo.stockMinimo,
    yaRegistrado: r.yaRegistrado,
  });

  /** Saldo inicial de un insumo recién cargado. Solo si todavía no tiene movimientos (después, se corrige con un conteo). */
  async function inventarioInicial({ empresaId, actor, insumoId, detalle, ...q }) {
    exigir(actor, "kardex:gestionar");
    const insumo = await cargarInsumo(empresaId, insumoId);
    const { base, costoUnitario, presentacion } = aUnidadBase(insumo, q, { exigirCosto: true });
    if (await ultimoMovimiento(empresaId, insumoId))
      throw new ErrorKardex("ESTADO_INVALIDO", "el insumo ya tiene movimientos: corrige el saldo con un conteo físico");
    const r = await aplicar({
      empresaId, insumoId, tipo: "inventario_inicial", signo: 1, cantidad: base, costoUnitario,
      detalle: validarDetalle(detalle), presentacion, creadoPor: actor.usuarioId ?? null,
    });
    return respuesta(insumo, r);
  }

  /** Ingreso de mercadería. `cantidad` y `costo` en la presentación elegida (o en la unidad base); o `costoTotal`. */
  async function registrarCompra({ empresaId, actor, insumoId, detalle, referencia, ...q }) {
    exigir(actor, "kardex:registrar");
    const insumo = await cargarInsumo(empresaId, insumoId);
    if (insumo.activo === false) throw new ErrorKardex("ESTADO_INVALIDO", "el insumo está desactivado");
    const { base, costoUnitario, presentacion } = aUnidadBase(insumo, q, { exigirCosto: true });
    const r = await aplicar({
      empresaId, insumoId, tipo: "compra", signo: 1, cantidad: base, costoUnitario,
      detalle: validarDetalle(detalle), referencia: referencia ? validarDetalle(referencia, { nombre: "referencia" }) : null,
      presentacion, creadoPor: actor.usuarioId ?? null,
    });
    return respuesta(insumo, r);
  }

  /** Pérdida (se venció, se cayó, se desperdició). El motivo es obligatorio. Sale al costo promedio. */
  async function registrarMerma({ empresaId, actor, insumoId, detalle, ...q }) {
    exigir(actor, "kardex:registrar");
    const insumo = await cargarInsumo(empresaId, insumoId);
    const { base, presentacion } = aUnidadBase(insumo, q);
    const r = await aplicar({
      empresaId, insumoId, tipo: "merma", signo: -1, cantidad: base,
      detalle: validarDetalle(detalle, { obligatorio: true, nombre: "detalle (motivo de la merma)" }),
      presentacion, creadoPor: actor.usuarioId ?? null,
    });
    return respuesta(insumo, r);
  }

  /**
   * Conteo físico: la persona dice cuánto hay y el sistema registra la diferencia como ajuste (al costo promedio).
   * Sin diferencia no se guarda nada. El motivo es obligatorio.
   */
  async function contar({ empresaId, actor, insumoId, detalle, ...q }) {
    exigir(actor, "kardex:gestionar");
    const insumo = await cargarInsumo(empresaId, insumoId);
    const { base, presentacion } = aUnidadBase(insumo, q, { permitirCero: true });
    const det = validarDetalle(detalle, { obligatorio: true, nombre: "detalle (motivo del ajuste)" });
    for (let intento = 0; intento < REINTENTOS; intento += 1) {
      const ultimo = await ultimoMovimiento(empresaId, insumoId);
      const actualExistencia = estadoDe(ultimo).existencia;
      const diferencia = redondear(base - actualExistencia, 3);
      if (diferencia === 0) return { sinDiferencia: true, existencia: actualExistencia, movimiento: null };
      const r = await aplicar({
        empresaId, insumoId, tipo: "ajuste", signo: diferencia > 0 ? 1 : -1, cantidad: Math.abs(diferencia),
        detalle: det, presentacion, creadoPor: actor.usuarioId ?? null,
      });
      // Si entre leer y guardar entró otro movimiento, el saldo ya no es el que se contó: se vuelve a calcular.
      if (r.movimiento.existenciaDespues === base) return { sinDiferencia: false, ...respuesta(insumo, r) };
    }
    throw new ErrorKardex("CONFLICTO", "el saldo cambió mientras se contaba: vuelve a contar");
  }

  /**
   * Gasto de insumos por un documento (lo llama el servicio, sin actor). Cada línea sale al costo promedio.
   * Nunca bloquea: un insumo que falta o que queda en negativo se informa pero no impide el pedido.
   * Idempotente por `referencia` e insumo. Devuelve { aplicados, yaRegistrados, errores }.
   */
  async function consumirVarios({ empresaId, referencia, lineas, detalle = null, ahora = new Date() }) {
    if (typeof referencia !== "string" || !referencia.trim()) throw new ErrorKardex("DATOS_INVALIDOS", "referencia: obligatoria");
    if (!Array.isArray(lineas)) throw new ErrorKardex("DATOS_INVALIDOS", "lineas: una lista de { insumoId, cantidad }");
    const suma = new Map();
    for (const l of lineas) {
      if (!l || !ID.test(String(l.insumoId ?? ""))) throw new ErrorKardex("DATOS_INVALIDOS", "lineas: insumoId inválido");
      suma.set(String(l.insumoId), (suma.get(String(l.insumoId)) ?? 0) + Number(l.cantidad));
    }
    const salida = { aplicados: [], yaRegistrados: [], errores: [] };
    for (const [insumoId, total] of suma) {
      try {
        const cantidad = redondear(total, 3);
        validarCantidad(cantidad, "cantidad");
        const insumo = await cargarInsumo(empresaId, insumoId);
        if (insumo.activo === false) throw new ErrorKardex("ESTADO_INVALIDO", "el insumo está desactivado");
        const r = await aplicar({ empresaId, insumoId, tipo: "consumo", signo: -1, cantidad, detalle, referencia: referencia.trim(), ahora });
        if (r.yaRegistrado) salida.yaRegistrados.push(insumoId);
        else {
          const x = respuesta(insumo, r);
          salida.aplicados.push({ insumoId, codigo: insumo.codigo, nombre: insumo.nombre, cantidad, existencia: x.existencia, negativo: x.negativo, bajoMinimo: x.bajoMinimo });
        }
      } catch (e) {
        if (!(e instanceof ErrorKardex)) throw e;
        salida.errores.push({ insumoId, codigo: e.codigo, mensaje: e.message });
      }
    }
    return salida;
  }

  /** Devuelve al stock lo que consumió un documento (por ejemplo un ítem anulado), al costo con que salió. Idempotente. */
  async function revertir({ empresaId, referencia, detalle = "Reversa", ahora = new Date() }) {
    if (typeof referencia !== "string" || !referencia.trim()) throw new ErrorKardex("DATOS_INVALIDOS", "referencia: obligatoria");
    const consumos = await conEmpresa(empresaId, async () => await MovimientoKardex.find({ referencia: referencia.trim(), tipo: "consumo" }).lean());
    const salida = { aplicados: [], yaRegistrados: [], errores: [] };
    for (const c of consumos) {
      const insumoId = String(c.insumoId);
      try {
        const r = await aplicar({
          empresaId, insumoId, tipo: "reversa", signo: 1, cantidad: Math.abs(c.cantidad), costoUnitario: c.costoUnitario,
          detalle, referencia: referencia.trim(), ahora,
        });
        if (r.yaRegistrado) salida.yaRegistrados.push(insumoId);
        else salida.aplicados.push({ insumoId, cantidad: Math.abs(c.cantidad), existencia: r.movimiento.existenciaDespues });
      } catch (e) {
        if (!(e instanceof ErrorKardex)) throw e;
        salida.errores.push({ insumoId, codigo: e.codigo, mensaje: e.message });
      }
    }
    return salida;
  }

  /** Movimientos, del más reciente al más antiguo. Filtros: insumo, tipo, referencia y rango de fechas. Máximo 200. */
  async function movimientos({ empresaId, actor, insumoId, tipo, referencia, desde, hasta, limite = 50, saltar = 0 }) {
    exigirVer(actor);
    const f = {};
    if (insumoId) f.insumoId = idValido(insumoId, "insumoId");
    if (tipo) {
      if (!TIPOS_MOVIMIENTO.includes(tipo)) throw new ErrorKardex("DATOS_INVALIDOS", "tipo: desconocido");
      f.tipo = tipo;
    }
    if (referencia) f.referencia = String(referencia);
    const fecha = (v, nombre) => {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw new ErrorKardex("DATOS_INVALIDOS", `${nombre}: una fecha válida`);
      return d;
    };
    if (desde || hasta) {
      f.ts = {};
      if (desde) f.ts.$gte = fecha(desde, "desde");
      if (hasta) f.ts.$lte = fecha(hasta, "hasta");
    }
    const lim = Math.min(Math.max(Number(limite) || 50, 1), MAX_LISTA);
    const sal = Math.max(Number(saltar) || 0, 0);
    const lista = await conEmpresa(empresaId, async () =>
      await MovimientoKardex.find(f).sort({ ts: -1, secuencia: -1 }).skip(sal).limit(lim).lean(),
    );
    return lista.map(dtoMov);
  }

  /** Rehace la copia del saldo de un insumo desde su último movimiento (si alguna vez quedó desfasada). */
  async function repararSaldo({ empresaId, actor, insumoId }) {
    exigir(actor, "kardex:gestionar");
    await cargarInsumo(empresaId, insumoId);
    const ultimo = await ultimoMovimiento(empresaId, insumoId);
    const e = estadoDe(ultimo);
    await conEmpresa(empresaId, async () =>
      await Insumo.updateOne({ _id: insumoId }, { $set: { existencia: e.existencia, costoPromedio: e.costoPromedio, ultimaSecuencia: ultimo?.secuencia ?? 0 } }),
    );
    return dto(await cargarInsumo(empresaId, insumoId));
  }

  // ---------- manejadores HTTP ----------
  const responder = (res, e, next) => {
    if (e instanceof ErrorKardex || e instanceof ErrorAuth) return res.status(e.status).json({ error: e.message, codigo: e.codigo, ...(e.detalle ? { detalle: e.detalle } : {}) });
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
  const base = (req) => ({ empresaId: req.auth.empresaId, actor: { usuarioId: req.auth.usuarioId, permisos: req.rol?.permisos ?? [] } });
  const cuerpo = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});
  const id = (req) => req.params?.insumoId;

  const manejadores = {
    /** GET /kardex/insumos?q=&bajoMinimo=1&inactivos=1&limite=&saltar= → { total, insumos } (kardex:leer) */
    listarInsumos: envolver(false, async (req, res) =>
      res.status(200).json(await listarInsumos({ ...base(req), texto: req.query?.q, bajoMinimo: req.query?.bajoMinimo === "1", incluirInactivos: req.query?.inactivos === "1", limite: req.query?.limite, saltar: req.query?.saltar })),
    ),
    /** POST /kardex/insumos { codigo, nombre, unidad, presentaciones?, stockMinimo? } → 201 (kardex:gestionar) */
    crearInsumo: envolver(true, async (req, res) => res.status(201).json(await crearInsumo({ ...base(req), ...cuerpo(req) }))),
    /** GET /kardex/insumos/:insumoId (kardex:leer) */
    obtenerInsumo: envolver(false, async (req, res) => res.status(200).json(await obtenerInsumo({ ...base(req), insumoId: id(req) }))),
    /** PUT /kardex/insumos/:insumoId (kardex:gestionar) */
    editarInsumo: envolver(true, async (req, res) => res.status(200).json(await editarInsumo({ ...base(req), insumoId: id(req), ...cuerpo(req) }))),
    /** POST /kardex/insumos/:insumoId/inicial { cantidad, presentacion?, costo | costoTotal } → 201 (kardex:gestionar) */
    inventarioInicial: envolver(true, async (req, res) => res.status(201).json(await inventarioInicial({ ...base(req), insumoId: id(req), ...cuerpo(req) }))),
    /** POST /kardex/insumos/:insumoId/compra { cantidad, presentacion?, costo | costoTotal, detalle? } → 201 (kardex:registrar) */
    compra: envolver(true, async (req, res) => res.status(201).json(await registrarCompra({ ...base(req), insumoId: id(req), ...cuerpo(req) }))),
    /** POST /kardex/insumos/:insumoId/merma { cantidad, presentacion?, detalle } → 201 (kardex:registrar) */
    merma: envolver(true, async (req, res) => res.status(201).json(await registrarMerma({ ...base(req), insumoId: id(req), ...cuerpo(req) }))),
    /** POST /kardex/insumos/:insumoId/conteo { cantidad, presentacion?, detalle } (kardex:gestionar) */
    conteo: envolver(true, async (req, res) => {
      const r = await contar({ ...base(req), insumoId: id(req), ...cuerpo(req) });
      res.status(r.sinDiferencia ? 200 : 201).json(r);
    }),
    /** POST /kardex/insumos/:insumoId/reparar (kardex:gestionar) */
    reparar: envolver(true, async (req, res) => res.status(200).json(await repararSaldo({ ...base(req), insumoId: id(req) }))),
    /** GET /kardex/movimientos?insumoId=&tipo=&referencia=&desde=&hasta=&limite=&saltar= → { movimientos } (kardex:leer) */
    movimientos: envolver(false, async (req, res) => res.status(200).json({ movimientos: await movimientos({ ...base(req), ...(req.query ?? {}) }) })),
    /** GET /kardex/valorizacion (kardex:leer) */
    valorizacion: envolver(false, async (req, res) => res.status(200).json(await valorizacion({ ...base(req) }))),
  };

  return {
    crearInsumo, editarInsumo, obtenerInsumo, listarInsumos, valorizacion, inventarioInicial, registrarCompra, registrarMerma,
    contar, consumirVarios, revertir, movimientos, repararSaldo, manejadores,
  };
}
