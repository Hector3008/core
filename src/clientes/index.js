import { conEmpresa } from "../tenancy.js";
import { permite } from "../permisos.js";
import { ErrorAuth } from "../auth/errores.js";
import { PAIS_POR_DEFECTO, normalizarTelefono } from "../telefono.js";
import { ErrorCliente } from "./errores.js";
import { REDES_SOPORTADAS } from "./redes.js";
import {
  FINALIDADES,
  idValido,
  prepararDatos,
  validarFinalidad,
  validarMedio,
} from "./validacion.js";

const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CAMPOS_INSTANTANEA = ["nombre", "telefono", "correo", "redes", "identificacion", "direccion", "preferencias"];
const CAMPOS_POR_DEFECTO = ["nombre", "telefono", "identificacion", "direccion", "preferencias"];
const MAX_HISTORIAL = 100;

/**
 * Gestión de clientes de una empresa: ficha, búsqueda, baja, consentimientos y anonimización.
 *
 * Es la gestión que hace el PERSONAL. El cliente final no inicia sesión aquí (su identidad es otra
 * cosa y se diseña aparte, ver arquitectura 5.13). Toda operación que cambia algo recibe
 * `actor = { usuarioId, permisos }` y comprueba su permiso: las rutas llevan `requierePermiso`,
 * pero estas reglas protegen aunque alguien monte una ruta sin él.
 *   cliente:leer      → ver y buscar (lo comprueban las rutas; las lecturas internas no piden actor)
 *   cliente:crear     → dar de alta
 *   cliente:editar    → corregir la ficha
 *   cliente:gestionar → baja, reactivar, consentimientos y anonimizar
 */
export function crearServicioClientes({ Empresa, Cliente }, auth) {
  // ---------- ayudas ----------
  const exigir = (actor, permiso) => {
    if (!actor || !Array.isArray(actor.permisos))
      throw new ErrorCliente("PERMISO_INSUFICIENTE", "se requiere quién realiza la operación");
    if (!permite(actor.permisos, permiso))
      throw new ErrorCliente("PERMISO_INSUFICIENTE", `permiso insuficiente (${permiso})`);
  };

  // País de la empresa: fija el código telefónico por defecto. Las empresas anteriores al campo asumen PE.
  async function paisDe(empresaId) {
    const e = await Empresa.findById(empresaId).lean();
    if (!e || e.activa === false) throw new ErrorCliente("NO_ENCONTRADO", "empresa no encontrada");
    return e.pais ?? PAIS_POR_DEFECTO;
  }

  async function cargar(empresaId, clienteId) {
    idValido(clienteId, "clienteId");
    const c = await conEmpresa(empresaId, async () => await Cliente.findById(clienteId).lean());
    if (!c) throw new ErrorCliente("NO_ENCONTRADO", "cliente no encontrado");
    return c;
  }

  const limpiarRedes = (redes) =>
    Object.fromEntries(Object.entries(redes ?? {}).filter(([, v]) => typeof v === "string" && v));

  function consentimientosDto(c) {
    return Object.fromEntries(
      FINALIDADES.map((f) => {
        const k = c.consentimientos?.[f];
        return [
          f,
          k
            ? { otorgado: k.otorgado, ts: k.ts, medio: k.medio, registradoPor: k.registradoPor ? String(k.registradoPor) : null }
            : { otorgado: false, ts: null, medio: null, registradoPor: null },
        ];
      }),
    );
  }

  function dto(c, completo = false) {
    return {
      id: String(c._id),
      nombre: c.nombre,
      telefono: c.telefono ?? null,
      telefonoPais: c.telefonoPais ?? null,
      correo: c.correo ?? null,
      redes: limpiarRedes(c.redes),
      identificacion: c.identificacion ? { tipo: c.identificacion.tipo, numero: c.identificacion.numero } : null,
      direccion: c.direccion ?? null,
      preferencias: c.preferencias ?? {},
      consentimientos: consentimientosDto(c),
      activo: c.activo !== false,
      anonimizado: !!c.anonimizadoTs,
      creadoTs: c.createdAt ?? null,
      actualizadoTs: c.updatedAt ?? null,
      ...(completo
        ? {
            historialConsentimientos: (c.historialConsentimientos ?? []).map((h) => ({
              finalidad: h.finalidad,
              otorgado: h.otorgado,
              ts: h.ts,
              medio: h.medio,
              registradoPor: h.registradoPor ? String(h.registradoPor) : null,
            })),
          }
        : {}),
    };
  }

  // Un 11000 de MongoDB se convierte en CLIENTE_DUPLICADO, diciendo qué dato choca y con qué cliente.
  async function traducirDuplicado(e, empresaId, datos) {
    if (e?.code !== 11000) return e;
    const claves = Object.keys(e.keyPattern ?? {});
    const campos = ["telefono", "correo"].filter((k) =>
      claves.length ? claves.includes(k) : typeof datos[k] === "string",
    );
    for (const campo of campos) {
      const otro = await conEmpresa(empresaId, async () => await Cliente.findOne({ [campo]: datos[campo] }).select("_id").lean());
      if (otro)
        return new ErrorCliente("CLIENTE_DUPLICADO", `ya existe un cliente con ese ${campo}`, {
          campo,
          clienteId: String(otro._id),
        });
    }
    return new ErrorCliente("CLIENTE_DUPLICADO", "ya existe un cliente con esos datos");
  }

  // ---------- ficha ----------
  async function crear({ empresaId, actor, ...entrada }) {
    exigir(actor, "cliente:crear");
    const paisEmpresa = await paisDe(empresaId); // también comprueba que la empresa exista y esté activa
    const d = prepararDatos(entrada, { crear: true, paisEmpresa });
    const doc = { nombre: d.nombre, creadoPor: actor.usuarioId ?? null };
    for (const k of ["telefono", "telefonoPais", "correo", "identificacion", "direccion", "preferencias"])
      if (d[k] !== undefined) doc[k] = d[k];
    const redes = limpiarRedes(d.redes);
    if (Object.keys(redes).length) doc.redes = redes;
    try {
      const c = await conEmpresa(empresaId, () => Cliente.create(doc));
      return dto(c.toObject());
    } catch (e) {
      throw await traducirDuplicado(e, empresaId, d);
    }
  }

  async function obtener({ empresaId, clienteId }) {
    return dto(await cargar(empresaId, clienteId), true);
  }

  /**
   * Corrige la ficha. Cada campo: `undefined` no se toca, `null` (o "") se quita.
   * `redes` se combina red por red; `preferencias` e `identificacion` se reemplazan completas.
   */
  async function actualizar({ empresaId, actor, clienteId, ...entrada }) {
    exigir(actor, "cliente:editar");
    const actual = await cargar(empresaId, clienteId);
    if (actual.anonimizadoTs) throw new ErrorCliente("ESTADO_INVALIDO", "el cliente está anonimizado");
    const paisEmpresa = entrada.telefono ? await paisDe(empresaId) : undefined;
    const d = prepararDatos(entrada, { crear: false, paisEmpresa });
    const $set = {};
    const $unset = {};
    for (const k of ["nombre", "telefono", "telefonoPais", "correo", "identificacion", "direccion", "preferencias"])
      if (d[k] !== undefined) $set[k] = d[k];
    for (const [red, valor] of Object.entries(d.redes ?? {})) {
      if (valor === null) $unset[`redes.${red}`] = "";
      else $set[`redes.${red}`] = valor;
    }
    if (!Object.keys($set).length && !Object.keys($unset).length)
      throw new ErrorCliente("DATOS_INVALIDOS", "no hay nada que cambiar");
    const upd = {};
    if (Object.keys($set).length) upd.$set = $set;
    if (Object.keys($unset).length) upd.$unset = $unset;
    try {
      const r = await conEmpresa(empresaId, async () => await Cliente.updateOne({ _id: clienteId, anonimizadoTs: null }, upd));
      if (!r.matchedCount) throw new ErrorCliente("ESTADO_INVALIDO", "el cliente está anonimizado");
    } catch (e) {
      throw await traducirDuplicado(e, empresaId, d);
    }
    return obtener({ empresaId, clienteId });
  }

  // ---------- búsqueda ----------
  // Qué se busca según lo que escribió la persona: @usuario (red), correo, teléfono (completo o los
  // últimos dígitos) o parte del nombre.
  function filtroTexto(texto, paisEmpresa) {
    const t = typeof texto === "string" ? texto.trim() : "";
    if (!t || t.length > 80) throw new ErrorCliente("DATOS_INVALIDOS", "texto de búsqueda requerido (máximo 80 caracteres)");
    if (t.startsWith("@")) {
      const u = t.slice(1).toLowerCase();
      if (!/^[a-z0-9._]{1,50}$/.test(u)) throw new ErrorCliente("DATOS_INVALIDOS", "usuario de red inválido");
      return { $or: REDES_SOPORTADAS.map((r) => ({ [`redes.${r}`]: u })) };
    }
    if (CORREO.test(t)) return { correo: t.toLowerCase() };
    const digitos = t.replace(/\D/g, "");
    if (/^[0-9+()\-. ]+$/.test(t) && digitos.length >= 4) {
      try {
        return { telefono: normalizarTelefono(t, paisEmpresa).telefono };
      } catch {
        return { telefono: { $regex: esc(digitos) } };
      }
    }
    return {
      $or: [
        { nombre: { $regex: esc(t), $options: "i" } },
        ...REDES_SOPORTADAS.map((r) => ({ [`redes.${r}`]: t.toLowerCase() })),
      ],
    };
  }

  /** Lista (o busca, si llega `texto`) por nombre. Máximo 200 por llamada. */
  async function listar({ empresaId, texto, incluirInactivos = false, limite = 50, saltar = 0 }) {
    const paisEmpresa = await paisDe(empresaId);
    const filtro = texto === undefined ? {} : filtroTexto(texto, paisEmpresa);
    if (!incluirInactivos) filtro.activo = true;
    const lim = Math.min(Math.max(Math.trunc(Number(limite)) || 50, 1), 200);
    const sal = Math.max(Math.trunc(Number(saltar)) || 0, 0);
    const cs = await conEmpresa(empresaId, async () =>
      await Cliente.find(filtro).sort({ nombre: 1, _id: 1 }).skip(sal).limit(lim).lean(),
    );
    return cs.map((c) => dto(c));
  }
  const buscar = async ({ texto, ...resto }) => {
    if (texto === undefined) throw new ErrorCliente("DATOS_INVALIDOS", "texto de búsqueda requerido");
    return listar({ ...resto, texto });
  };

  // ---------- baja ----------
  /** Nunca se borra a nadie: los documentos y eventos guardan su id. */
  async function desactivar({ empresaId, actor, clienteId }) {
    exigir(actor, "cliente:gestionar");
    const c = await cargar(empresaId, clienteId);
    if (!c.activo) throw new ErrorCliente("ESTADO_INVALIDO", "el cliente ya está desactivado");
    await conEmpresa(empresaId, async () =>
      await Cliente.updateOne({ _id: clienteId, activo: true }, { activo: false, desactivadoTs: new Date() }),
    );
    return obtener({ empresaId, clienteId });
  }

  async function reactivar({ empresaId, actor, clienteId }) {
    exigir(actor, "cliente:gestionar");
    const c = await cargar(empresaId, clienteId);
    if (c.anonimizadoTs) throw new ErrorCliente("ESTADO_INVALIDO", "el cliente está anonimizado: no se puede reactivar");
    if (c.activo) throw new ErrorCliente("ESTADO_INVALIDO", "el cliente ya está activo");
    await conEmpresa(empresaId, async () =>
      await Cliente.updateOne({ _id: clienteId, activo: false }, { activo: true, desactivadoTs: null }),
    );
    return obtener({ empresaId, clienteId });
  }

  // ---------- consentimientos ----------
  /**
   * Otorga o retira el consentimiento para una finalidad. Queda el estado actual y una entrada en el
   * historial (cuándo, cómo y quién lo registró). Repetir el mismo estado no hace nada. Retirarlo
   * siempre se permite, aunque el cliente esté desactivado; otorgarlo exige que esté activo.
   */
  async function cambiarConsentimiento({ empresaId, actor, clienteId, finalidad, otorgado, medio }) {
    exigir(actor, "cliente:gestionar");
    validarFinalidad(finalidad);
    if (typeof otorgado !== "boolean") throw new ErrorCliente("DATOS_INVALIDOS", "otorgado debe ser true o false");
    validarMedio(medio);
    const c = await cargar(empresaId, clienteId);
    if (c.anonimizadoTs) throw new ErrorCliente("ESTADO_INVALIDO", "el cliente está anonimizado");
    if (otorgado && !c.activo) throw new ErrorCliente("ESTADO_INVALIDO", "el cliente está desactivado");
    if (otorgado === !!c.consentimientos?.[finalidad]?.otorgado) return dto(c, true);
    const registro = { otorgado, ts: new Date(), medio, registradoPor: actor.usuarioId ?? null };
    await conEmpresa(empresaId, async () =>
      await Cliente.updateOne(
        {
          _id: clienteId,
          anonimizadoTs: null,
          ...(otorgado ? { activo: true } : {}),
          [`consentimientos.${finalidad}.otorgado`]: { $ne: otorgado },
        },
        {
          $set: { [`consentimientos.${finalidad}`]: registro },
          $push: { historialConsentimientos: { $each: [{ finalidad, ...registro }], $slice: -MAX_HISTORIAL } },
        },
      ),
    );
    return obtener({ empresaId, clienteId });
  }
  const otorgarConsentimiento = (p) => cambiarConsentimiento({ ...p, otorgado: true });
  const retirarConsentimiento = (p) => cambiarConsentimiento({ ...p, otorgado: false });

  /** ¿Puede el sistema hacer esto con este cliente? Lo usarán fidelización y redes sociales. */
  async function tieneConsentimiento({ empresaId, clienteId, finalidad }) {
    validarFinalidad(finalidad);
    const c = await cargar(empresaId, clienteId);
    return c.activo !== false && !c.anonimizadoTs && c.consentimientos?.[finalidad]?.otorgado === true;
  }

  // ---------- para los servicios ----------
  /**
   * Los datos del cliente que se copian al `snapshot` de un documento al crearlo. Por minimización de
   * datos, por defecto no incluye correo ni redes: cada servicio pide solo lo que necesita (`campos`).
   * Solo de clientes activos y no anonimizados.
   */
  async function instantanea({ empresaId, clienteId, campos = CAMPOS_POR_DEFECTO }) {
    if (!Array.isArray(campos) || campos.some((k) => !CAMPOS_INSTANTANEA.includes(k)))
      throw new ErrorCliente("DATOS_INVALIDOS", `campos inválidos (admitidos: ${CAMPOS_INSTANTANEA.join(", ")})`);
    const c = await cargar(empresaId, clienteId);
    if (c.anonimizadoTs || c.activo === false)
      throw new ErrorCliente("ESTADO_INVALIDO", "el cliente está desactivado o anonimizado");
    const d = dto(c);
    const snap = { clienteId: d.id };
    for (const k of campos) snap[k] = structuredClone(d[k]);
    return snap;
  }

  // ---------- anonimizar ----------
  /**
   * Pedido de supresión de datos: borra los datos personales y deja solo el id, para que los
   * documentos y eventos que lo referencian sigan siendo coherentes. No se puede deshacer. Los
   * `snapshot` ya guardados dentro de documentos NO se tocan (ver arquitectura 5.15).
   */
  async function anonimizar({ empresaId, actor, clienteId }) {
    exigir(actor, "cliente:gestionar");
    const c = await cargar(empresaId, clienteId);
    if (c.anonimizadoTs) throw new ErrorCliente("ESTADO_INVALIDO", "el cliente ya está anonimizado");
    const ts = new Date();
    const registradoPor = actor.usuarioId ?? null;
    const retiros = FINALIDADES.filter((f) => c.consentimientos?.[f]?.otorgado).map((finalidad) => ({
      finalidad,
      otorgado: false,
      ts,
      medio: "anonimizacion",
      registradoPor,
    }));
    const $set = {
      nombre: "Cliente anonimizado",
      telefono: null,
      telefonoPais: null,
      correo: null,
      identificacion: null,
      direccion: null,
      preferencias: {},
      activo: false,
      desactivadoTs: c.desactivadoTs ?? ts,
      anonimizadoTs: ts,
    };
    for (const r of retiros)
      $set[`consentimientos.${r.finalidad}`] = { otorgado: false, ts, medio: r.medio, registradoPor };
    const upd = { $set, $unset: { redes: "" } };
    if (retiros.length) upd.$push = { historialConsentimientos: { $each: retiros, $slice: -MAX_HISTORIAL } };
    const r = await conEmpresa(empresaId, async () => await Cliente.updateOne({ _id: clienteId, anonimizadoTs: null }, upd));
    if (!r.matchedCount) throw new ErrorCliente("ESTADO_INVALIDO", "el cliente ya está anonimizado");
    return obtener({ empresaId, clienteId });
  }

  // ---------- Express ----------
  const responder = (res, e, next) => {
    if (e instanceof ErrorCliente) return res.status(e.status).json({ error: e.message, codigo: e.codigo, ...(e.detalle ?? {}) });
    if (e instanceof ErrorAuth) return res.status(e.status).json({ error: e.message, codigo: e.codigo });
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
  const ficha = (b = {}) => ({
    nombre: b.nombre,
    telefono: b.telefono,
    paisTelefono: b.paisTelefono,
    correo: b.correo,
    redes: b.redes,
    identificacion: b.identificacion,
    direccion: b.direccion,
    preferencias: b.preferencias,
  });

  const manejadores = {
    listar: envolver(false, async (req, res) => {
      const q = req.query ?? {};
      const clientes = await listar({
        empresaId: req.auth.empresaId,
        texto: q.q === undefined || q.q === "" ? undefined : String(q.q),
        incluirInactivos: q.inactivos === "1",
        limite: q.limite,
        saltar: q.saltar,
      });
      res.status(200).json({ clientes });
    }),
    obtener: envolver(false, async (req, res) =>
      res.status(200).json(await obtener({ empresaId: req.auth.empresaId, clienteId: req.params?.clienteId })),
    ),
    crear: envolver(true, async (req, res) => res.status(201).json(await crear({ ...base(req), ...ficha(req.body) }))),
    actualizar: envolver(true, async (req, res) =>
      res.status(200).json(await actualizar({ ...base(req), clienteId: req.params?.clienteId, ...ficha(req.body) })),
    ),
    consentimiento: envolver(true, async (req, res) =>
      res.status(200).json(
        await cambiarConsentimiento({
          ...base(req),
          clienteId: req.params?.clienteId,
          finalidad: req.params?.finalidad,
          otorgado: req.body?.otorgado,
          medio: req.body?.medio,
        }),
      ),
    ),
    desactivar: envolver(true, async (req, res) =>
      res.status(200).json(await desactivar({ ...base(req), clienteId: req.params?.clienteId })),
    ),
    reactivar: envolver(true, async (req, res) =>
      res.status(200).json(await reactivar({ ...base(req), clienteId: req.params?.clienteId })),
    ),
    anonimizar: envolver(true, async (req, res) =>
      res.status(200).json(await anonimizar({ ...base(req), clienteId: req.params?.clienteId })),
    ),
  };

  return {
    crear,
    obtener,
    actualizar,
    listar,
    buscar,
    desactivar,
    reactivar,
    cambiarConsentimiento,
    otorgarConsentimiento,
    retirarConsentimiento,
    tieneConsentimiento,
    instantanea,
    anonimizar,
    manejadores,
    listo: () => Cliente.init(), // espera a que existan los índices únicos de teléfono y correo
  };
}

export { ErrorCliente } from "./errores.js";
