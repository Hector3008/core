import { conEmpresa } from "../tenancy.js";
import { permite } from "../permisos.js";
import { ErrorAuth } from "../auth/errores.js";
import { MONEDA_POR_DEFECTO } from "../moneda.js";
import { ErrorCatalogo } from "./errores.js";
import { crearRegistroEsquemas, exigirTamano, fusionar, sinNulos } from "./atributos.js";
import {
  CAMPOS_ITEM,
  MAX_FILAS_IMPORTACION,
  MAX_ITEMS_INSTANTANEA,
  claveDe,
  idValido,
  prepararDatos,
  validarCodigo,
  validarLineaLibre,
} from "./validacion.js";

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MAX_ERRORES_IMPORTACION = 50;

/**
 * Catálogo de una empresa: lo que se puede vender o pedir (platos, bebidas, repuestos...).
 *
 * El núcleo no sabe nada de restaurante ni de siscore: guarda código, nombre, categoría y precio (los dos
 * últimos opcionales) y un bloque de atributos que cada servicio declara con `registrarEsquema`. Toda
 * operación que cambia algo recibe `actor = { usuarioId, permisos }` y comprueba su permiso, como en
 * empleados y clientes: las rutas llevan `requierePermiso`, pero estas reglas protegen aunque alguien monte
 * una ruta sin él.
 *   catalogo:leer      → ver y buscar (lo comprueban las rutas; las lecturas internas no piden actor)
 *   catalogo:crear     → dar de alta un ítem
 *   catalogo:editar    → corregir nombre, categoría, precio y atributos
 *   catalogo:gestionar → baja, reactivar e importar en bloque
 *
 * Un ítem nunca se borra: los documentos y eventos lo mencionan. Se desactiva, y deja de poder agregarse a
 * documentos nuevos (`instantanea`) pero sigue consultable.
 */
export function crearServicioCatalogo({ Empresa, Item }, auth) {
  const registro = crearRegistroEsquemas();

  // ---------- ayudas ----------
  const exigir = (actor, permiso) => {
    if (!actor || !Array.isArray(actor.permisos))
      throw new ErrorCatalogo("PERMISO_INSUFICIENTE", "se requiere quién realiza la operación");
    if (!permite(actor.permisos, permiso))
      throw new ErrorCatalogo("PERMISO_INSUFICIENTE", `permiso insuficiente (${permiso})`);
  };

  async function empresaActiva(empresaId) {
    const e = await Empresa.findById(empresaId).lean();
    if (!e || e.activa === false) throw new ErrorCatalogo("NO_ENCONTRADO", "empresa no encontrada");
    return e;
  }

  async function cargar(empresaId, itemId) {
    idValido(itemId, "itemId");
    const i = await conEmpresa(empresaId, async () => await Item.findById(itemId).lean());
    if (!i) throw new ErrorCatalogo("NO_ENCONTRADO", "ítem no encontrado");
    return i;
  }

  async function cargarPorCodigo(empresaId, codigo) {
    const clave = claveDe(validarCodigo(codigo));
    const i = await conEmpresa(empresaId, async () => await Item.findOne({ codigoClave: clave }).lean());
    if (!i) throw new ErrorCatalogo("NO_ENCONTRADO", "ítem no encontrado");
    return i;
  }

  function dto(i) {
    return {
      id: String(i._id),
      codigo: i.codigo,
      nombre: i.nombre,
      categoria: i.categoria ?? null,
      precio: i.precio ?? null,
      atributos: structuredClone(i.atributos ?? {}),
      activo: i.activo !== false,
      creadoTs: i.createdAt ?? null,
      actualizadoTs: i.updatedAt ?? null,
    };
  }

  // Un 11000 de MongoDB se convierte en ITEM_DUPLICADO, con el id del ítem que ya tiene ese código.
  async function traducirDuplicado(e, empresaId, codigo) {
    if (e?.code !== 11000) return e;
    const otro = await conEmpresa(empresaId, async () =>
      await Item.findOne({ codigoClave: claveDe(codigo) }).select("_id").lean(),
    );
    if (otro)
      return new ErrorCatalogo("ITEM_DUPLICADO", "ya existe un ítem con ese código", {
        campo: "codigo",
        itemId: String(otro._id),
      });
    return new ErrorCatalogo("ITEM_DUPLICADO", "ya existe un ítem con ese código");
  }

  // ---------- esquemas y moneda ----------
  /** Cada servicio declara al arrancar los atributos que conoce: `{ campos: { MARCA: "texto", ... } }`. */
  const registrarEsquema = (def) => registro.registrar(def);
  const esquemas = () => registro.campos();

  /** Moneda de los precios de la empresa (las empresas anteriores al campo asumen PEN). */
  async function moneda({ empresaId }) {
    return (await empresaActiva(empresaId)).moneda ?? MONEDA_POR_DEFECTO;
  }

  // ---------- ficha ----------
  async function crear({ empresaId, actor, ...entrada }) {
    exigir(actor, "catalogo:crear");
    await empresaActiva(empresaId);
    const d = prepararDatos(entrada, { crear: true, registro });
    const doc = { codigo: d.codigo, codigoClave: claveDe(d.codigo), nombre: d.nombre, creadoPor: actor.usuarioId ?? null };
    for (const k of ["categoria", "precio"]) if (d[k] !== undefined) doc[k] = d[k];
    if (d.atributos) doc.atributos = d.atributos;
    try {
      const i = await conEmpresa(empresaId, () => Item.create(doc));
      return dto(i.toObject());
    } catch (e) {
      throw await traducirDuplicado(e, empresaId, d.codigo);
    }
  }

  /** Por `itemId` o por `codigo` (el que escanea o escribe el personal). */
  async function obtener({ empresaId, itemId, codigo }) {
    if ((itemId === undefined) === (codigo === undefined))
      throw new ErrorCatalogo("DATOS_INVALIDOS", "indica itemId o codigo (uno solo)");
    return dto(itemId !== undefined ? await cargar(empresaId, itemId) : await cargarPorCodigo(empresaId, codigo));
  }

  /**
   * Corrige un ítem. Cada campo: `undefined` no se toca, `null` quita (categoría y precio) y `atributos` se
   * combina clave por clave (un valor `null` quita esa clave; `atributos: null` los quita todos).
   * El código no se puede cambiar: los documentos y eventos ya lo mencionan.
   */
  async function actualizar({ empresaId, actor, itemId, ...entrada }) {
    exigir(actor, "catalogo:editar");
    const actual = await cargar(empresaId, itemId);
    const d = prepararDatos(entrada, { crear: false, registro });
    if (d.codigo !== undefined && claveDe(d.codigo) !== actual.codigoClave)
      throw new ErrorCatalogo("DATOS_INVALIDOS", "el código de un ítem no se puede cambiar");
    if (d.nombre === null) throw new ErrorCatalogo("DATOS_INVALIDOS", "el nombre no se puede quitar");

    const $set = {};
    const $unset = {};
    for (const k of ["nombre", "categoria", "precio"]) if (d[k] !== undefined) $set[k] = d[k];
    if (d.atributos === null) $set.atributos = {};
    else if (d.atributos) {
      exigirTamano(fusionar(actual.atributos, d.atributos));
      for (const [k, v] of Object.entries(d.atributos)) {
        if (v === null) $unset[`atributos.${k}`] = "";
        else $set[`atributos.${k}`] = v;
      }
    }
    if (!Object.keys($set).length && !Object.keys($unset).length)
      throw new ErrorCatalogo("DATOS_INVALIDOS", "no hay nada que cambiar");
    const upd = {};
    if (Object.keys($set).length) upd.$set = $set;
    if (Object.keys($unset).length) upd.$unset = $unset;
    await conEmpresa(empresaId, async () => await Item.updateOne({ _id: itemId }, upd));
    return obtener({ empresaId, itemId });
  }

  // ---------- búsqueda ----------
  // `texto` busca por el comienzo del código (sin distinguir mayúsculas) o por parte del nombre.
  function filtroTexto(texto) {
    const t = typeof texto === "string" ? texto.trim() : "";
    if (!t || t.length > 80) throw new ErrorCatalogo("DATOS_INVALIDOS", "texto de búsqueda requerido (máximo 80 caracteres)");
    return {
      $or: [
        { codigoClave: { $regex: `^${esc(t.toLowerCase())}` } },
        { nombre: { $regex: esc(t), $options: "i" } },
      ],
    };
  }

  /** Lista (o busca, si llega `texto`). Por nombre. Máximo 200 por llamada. */
  async function listar({ empresaId, texto, categoria, incluirInactivos = false, limite = 50, saltar = 0 }) {
    const filtro = texto === undefined ? {} : filtroTexto(texto);
    if (categoria !== undefined) {
      if (typeof categoria !== "string" || !categoria.trim() || categoria.length > 60)
        throw new ErrorCatalogo("DATOS_INVALIDOS", "categoría inválida");
      filtro.categoria = categoria.trim();
    }
    if (!incluirInactivos) filtro.activo = true;
    const lim = Math.min(Math.max(Math.trunc(Number(limite)) || 50, 1), 200);
    const sal = Math.max(Math.trunc(Number(saltar)) || 0, 0);
    const is = await conEmpresa(empresaId, async () =>
      await Item.find(filtro).sort({ nombre: 1, _id: 1 }).skip(sal).limit(lim).lean(),
    );
    return is.map(dto);
  }
  const buscar = async ({ texto, ...resto }) => {
    if (texto === undefined) throw new ErrorCatalogo("DATOS_INVALIDOS", "texto de búsqueda requerido");
    return listar({ ...resto, texto });
  };

  /** Las categorías que ya se usan (de ítems activos), con cuántos ítems tiene cada una. Sirve para filtros. */
  async function categorias({ empresaId }) {
    const filas = await conEmpresa(empresaId, async () =>
      await Item.aggregate([
        { $match: { activo: true, categoria: { $type: "string" } } },
        { $group: { _id: "$categoria", cantidad: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
    );
    return filas.map((f) => ({ categoria: f._id, cantidad: f.cantidad }));
  }

  // ---------- baja ----------
  async function desactivar({ empresaId, actor, itemId }) {
    exigir(actor, "catalogo:gestionar");
    const i = await cargar(empresaId, itemId);
    if (i.activo === false) throw new ErrorCatalogo("ESTADO_INVALIDO", "el ítem ya está desactivado");
    await conEmpresa(empresaId, async () =>
      await Item.updateOne({ _id: itemId, activo: true }, { activo: false, desactivadoTs: new Date() }),
    );
    return obtener({ empresaId, itemId });
  }

  async function reactivar({ empresaId, actor, itemId }) {
    exigir(actor, "catalogo:gestionar");
    const i = await cargar(empresaId, itemId);
    if (i.activo !== false) throw new ErrorCatalogo("ESTADO_INVALIDO", "el ítem ya está activo");
    await conEmpresa(empresaId, async () =>
      await Item.updateOne({ _id: itemId, activo: false }, { activo: true, desactivadoTs: null }),
    );
    return obtener({ empresaId, itemId });
  }

  // ---------- para los servicios ----------
  /**
   * Lo que se copia al `snapshot` de un documento al armarlo (arquitectura 5.3): una entrada por elemento,
   * en el mismo orden en que llegaron. Cada elemento puede ser:
   *   "ZM-9600025" o { codigo: "ZM-9600025" }   → un ítem del catálogo (activo)
   *   { libre: { nombre, codigo?, precio?, categoria?, atributos? } }   → una línea libre
   * Los demás campos de un elemento (cantidad, notas...) los ignora: son del servicio, que une el resultado
   * con sus líneas por posición.
   *
   * Línea libre: un elemento que todavía no está en el catálogo y se monta igual (siscore). No se guarda en
   * el catálogo; queda solo en el documento, marcada con `origen: "libre"`. Si trae código, no puede ser el
   * de un ítem del catálogo (activo o no): si ya existe, se usa el del catálogo.
   *
   * Si algún código del catálogo no existe o está desactivado, falla todo con ITEM_NO_DISPONIBLE y la lista.
   * `campos` elige qué más se copia (por defecto, todos): nombre, precio, categoria, atributos.
   */
  async function instantanea({ empresaId, items, campos = CAMPOS_ITEM }) {
    if (!Array.isArray(campos) || campos.some((k) => !CAMPOS_ITEM.includes(k)))
      throw new ErrorCatalogo("DATOS_INVALIDOS", `campos inválidos (admitidos: ${CAMPOS_ITEM.join(", ")})`);
    if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS_INSTANTANEA)
      throw new ErrorCatalogo("DATOS_INVALIDOS", `items: una lista de 1 a ${MAX_ITEMS_INSTANTANEA} elementos`);

    const pedidos = items.map((e) => {
      if (typeof e === "string") return { catalogo: validarCodigo(e) };
      if (e && typeof e === "object" && !Array.isArray(e)) {
        if (e.libre !== undefined) {
          if (e.codigo !== undefined)
            throw new ErrorCatalogo("DATOS_INVALIDOS", "un elemento es del catálogo (codigo) o libre (libre), no las dos cosas");
          return { libre: validarLineaLibre(e.libre, registro) };
        }
        return { catalogo: validarCodigo(e.codigo) };
      }
      throw new ErrorCatalogo("DATOS_INVALIDOS", "cada elemento es un código o { codigo } o { libre: {...} }");
    });

    const claves = [...new Set(pedidos.map((p) => claveDe(p.catalogo ?? p.libre.codigo ?? "")).filter(Boolean))];
    const encontrados = claves.length
      ? await conEmpresa(empresaId, async () => await Item.find({ codigoClave: { $in: claves } }).lean())
      : [];
    const porClave = new Map(encontrados.map((i) => [i.codigoClave, i]));

    const choques = [...new Set(pedidos.filter((p) => p.libre?.codigo && porClave.has(claveDe(p.libre.codigo))).map((p) => p.libre.codigo))];
    if (choques.length)
      throw new ErrorCatalogo(
        "CODIGO_EN_CATALOGO",
        `el código ya está en el catálogo (${choques.join(", ")}): agrégalo como ítem del catálogo, no como línea libre`,
        { codigos: choques },
      );

    const noEncontrados = [];
    const inactivos = [];
    for (const p of pedidos) {
      if (!p.catalogo) continue;
      const i = porClave.get(claveDe(p.catalogo));
      if (!i) noEncontrados.push(p.catalogo);
      else if (i.activo === false) inactivos.push(i.codigo);
    }
    if (noEncontrados.length || inactivos.length)
      throw new ErrorCatalogo(
        "ITEM_NO_DISPONIBLE",
        `hay ítems que no se pueden usar: ${[...new Set([...noEncontrados, ...inactivos])].join(", ")}`,
        { noEncontrados: [...new Set(noEncontrados)], inactivos: [...new Set(inactivos)] },
      );

    return pedidos.map((p) => {
      const fuente = p.catalogo ? porClave.get(claveDe(p.catalogo)) : p.libre;
      const snap = p.catalogo
        ? { origen: "catalogo", itemId: String(fuente._id), codigo: fuente.codigo }
        : { origen: "libre", itemId: null, codigo: fuente.codigo };
      for (const k of campos) snap[k] = structuredClone(k === "atributos" ? (fuente.atributos ?? {}) : (fuente[k] ?? null));
      return snap;
    });
  }

  // ---------- importar ----------
  /**
   * Carga en bloque (por ejemplo desde una hoja de cálculo): crea los ítems nuevos y actualiza los que ya
   * existen, buscándolos por código. Hasta 500 filas por llamada. `{ codigo, nombre, categoria?, precio?, atributos? }`:
   *  - Fila nueva: exige código y nombre. Fila existente: solo cambia lo que traiga (como `actualizar`).
   *  - No reactiva ítems desactivados: los actualiza y los lista en `inactivos`.
   *  - Se valida TODO antes de escribir: si una fila es inválida no se guarda ninguna y el error
   *    (IMPORTACION_INVALIDA) lista las filas con su problema (número de fila desde 1).
   *  - `simular: true` valida y cuenta sin escribir.
   * Las escrituras no son una transacción: si la base de datos fallara a mitad, repetir la importación es
   * seguro (el resultado es el mismo).
   */
  async function importar({ empresaId, actor, filas, simular = false }) {
    exigir(actor, "catalogo:gestionar");
    await empresaActiva(empresaId);
    if (!Array.isArray(filas) || !filas.length || filas.length > MAX_FILAS_IMPORTACION)
      throw new ErrorCatalogo("DATOS_INVALIDOS", `filas: una lista de 1 a ${MAX_FILAS_IMPORTACION} filas`);

    const errores = [];
    const falla = (fila, codigo, e) => errores.push({ fila, codigo: codigo ?? null, error: e.message ?? String(e) });
    const limpias = [];
    const vistos = new Map();
    filas.forEach((f, idx) => {
      const fila = idx + 1;
      try {
        if (!f || typeof f !== "object" || Array.isArray(f)) throw new ErrorCatalogo("DATOS_INVALIDOS", "la fila debe ser un objeto");
        const d = prepararDatos({ ...f, codigo: validarCodigo(f.codigo) }, { crear: false, registro });
        if (d.nombre === null) throw new ErrorCatalogo("DATOS_INVALIDOS", "el nombre no se puede quitar");
        const clave = claveDe(d.codigo);
        if (vistos.has(clave)) throw new ErrorCatalogo("DATOS_INVALIDOS", `código repetido (también en la fila ${vistos.get(clave)})`);
        vistos.set(clave, fila);
        limpias.push({ fila, clave, d });
      } catch (e) {
        if (!(e instanceof ErrorCatalogo)) throw e;
        falla(fila, f?.codigo, e);
      }
    });

    const existentes = limpias.length
      ? await conEmpresa(empresaId, async () => await Item.find({ codigoClave: { $in: limpias.map((l) => l.clave) } }).lean())
      : [];
    const porClave = new Map(existentes.map((i) => [i.codigoClave, i]));

    const plan = [];
    for (const { fila, clave, d } of limpias) {
      const previo = porClave.get(clave);
      try {
        if (!previo) {
          if (d.nombre === undefined) throw new ErrorCatalogo("DATOS_INVALIDOS", "ítem nuevo: falta el nombre");
          const atributos = sinNulos(d.atributos ?? {});
          exigirTamano(atributos);
          plan.push({ nuevo: true, d, clave, atributos });
        } else {
          if (d.atributos) exigirTamano(fusionar(previo.atributos, d.atributos));
          plan.push({ nuevo: false, d, clave, previo });
        }
      } catch (e) {
        if (!(e instanceof ErrorCatalogo)) throw e;
        falla(fila, d.codigo, e);
      }
    }

    if (errores.length) {
      errores.sort((a, b) => a.fila - b.fila);
      throw new ErrorCatalogo("IMPORTACION_INVALIDA", `${errores.length} fila(s) inválida(s): no se guardó nada`, {
        total: errores.length,
        errores: errores.slice(0, MAX_ERRORES_IMPORTACION),
      });
    }

    const inactivos = plan.filter((p) => !p.nuevo && p.previo.activo === false).map((p) => p.previo.codigo);
    const resumen = { creados: plan.filter((p) => p.nuevo).length, actualizados: plan.filter((p) => !p.nuevo).length, inactivos, simulado: !!simular };
    if (simular) return resumen;

    let creados = 0;
    const omitidos = [];
    await conEmpresa(empresaId, async () => {
      for (const p of plan) {
        if (p.nuevo) {
          // Con upsert y solo $setOnInsert: si otra persona creó el mismo código entre la validación y ahora,
          // no se pisa su ítem (queda en `omitidos`).
          const r = await Item.updateOne(
            { codigoClave: p.clave },
            {
              $setOnInsert: {
                codigo: p.d.codigo,
                nombre: p.d.nombre,
                categoria: p.d.categoria ?? null,
                precio: p.d.precio ?? null,
                atributos: p.atributos,
                activo: true,
                desactivadoTs: null,
                creadoPor: actor.usuarioId ?? null,
              },
            },
            { upsert: true, setDefaultsOnInsert: false },
          );
          if (r.upsertedCount) creados++;
          else omitidos.push(p.d.codigo);
        } else {
          const $set = {};
          const $unset = {};
          for (const k of ["nombre", "categoria", "precio"]) if (p.d[k] !== undefined) $set[k] = p.d[k];
          if (p.d.atributos === null) $set.atributos = {};
          else if (p.d.atributos)
            for (const [k, v] of Object.entries(p.d.atributos)) {
              if (v === null) $unset[`atributos.${k}`] = "";
              else $set[`atributos.${k}`] = v;
            }
          const upd = {};
          if (Object.keys($set).length) upd.$set = $set;
          if (Object.keys($unset).length) upd.$unset = $unset;
          if (Object.keys(upd).length) await Item.updateOne({ _id: p.previo._id }, upd);
        }
      }
    });
    return { ...resumen, creados, omitidos };
  }

  // ---------- Express ----------
  const responder = (res, e, next) => {
    if (e instanceof ErrorCatalogo) return res.status(e.status).json({ error: e.message, codigo: e.codigo, ...(e.detalle ?? {}) });
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
    codigo: b.codigo,
    nombre: b.nombre,
    categoria: b.categoria,
    precio: b.precio,
    atributos: b.atributos,
  });

  const manejadores = {
    listar: envolver(false, async (req, res) => {
      const q = req.query ?? {};
      const items = await listar({
        empresaId: req.auth.empresaId,
        texto: q.q === undefined || q.q === "" ? undefined : String(q.q),
        categoria: q.categoria === undefined || q.categoria === "" ? undefined : String(q.categoria),
        incluirInactivos: q.inactivos === "1",
        limite: q.limite,
        saltar: q.saltar,
      });
      res.status(200).json({ items });
    }),
    categorias: envolver(false, async (req, res) =>
      res.status(200).json({ categorias: await categorias({ empresaId: req.auth.empresaId }) }),
    ),
    obtener: envolver(false, async (req, res) =>
      res.status(200).json(await obtener({ empresaId: req.auth.empresaId, itemId: req.params?.itemId })),
    ),
    porCodigo: envolver(false, async (req, res) =>
      res.status(200).json(await obtener({ empresaId: req.auth.empresaId, codigo: req.params?.codigo })),
    ),
    crear: envolver(true, async (req, res) => res.status(201).json(await crear({ ...base(req), ...ficha(req.body) }))),
    actualizar: envolver(true, async (req, res) =>
      res.status(200).json(await actualizar({ ...base(req), itemId: req.params?.itemId, ...ficha(req.body) })),
    ),
    desactivar: envolver(true, async (req, res) =>
      res.status(200).json(await desactivar({ ...base(req), itemId: req.params?.itemId })),
    ),
    reactivar: envolver(true, async (req, res) =>
      res.status(200).json(await reactivar({ ...base(req), itemId: req.params?.itemId })),
    ),
    importar: envolver(true, async (req, res) =>
      res.status(200).json(await importar({ ...base(req), filas: req.body?.filas, simular: req.body?.simular === true })),
    ),
  };

  return {
    crear,
    obtener,
    actualizar,
    listar,
    buscar,
    categorias,
    desactivar,
    reactivar,
    instantanea,
    importar,
    registrarEsquema,
    esquemas,
    moneda,
    manejadores,
    listo: () => Item.init(), // espera a que exista el índice único del código
  };
}

export { ErrorCatalogo } from "./errores.js";
