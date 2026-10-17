import mongoose from "mongoose";
import { conEmpresa } from "../tenancy.js";
import { permite } from "../permisos.js";
import { ErrorAuth } from "../auth/errores.js";
import { ErrorCliente } from "../clientes/errores.js";
import { ErrorFidelizacion } from "./errores.js";
import { calcularPuntos, configDe, validarConfig, validarDetalle, validarPuntos } from "./config.js";
import { calcularLogros } from "./logros.js";
import { calcularProgreso, validarReto } from "./retos.js";
import { calcularDescuento, estadoEfectivo, generarCodigo, normalizarCodigo, textoBeneficio, validarBeneficio } from "./beneficios.js";

const ID = /^[0-9a-f]{24}$/i;
const MAX_MOVIMIENTOS = 100;

/**
 * Fidelización: puntos de los clientes (arquitectura 5.11 y 5.25).
 *
 * Un libro de movimientos de solo inserción por empresa; el saldo se calcula sumándolos. Los puntos se acumulan
 * cuando un documento llega a su estado de cobro (en el restaurante, el pedido `pagado`), escuchando el evento
 * `estado` del motor, y solo si el cliente dio su consentimiento de `programaPuntos`. Es idempotente: un documento
 * acumula una sola vez (índice único por `{ empresaId, documentoCode, tipo }`).
 *
 * El núcleo no sabe de pedidos: cada servicio dice cuándo y de dónde salen los puntos con `registrarFuente`.
 *   core.fidelizacion.registrarFuente({
 *     tipo: "pedido", estado: "pagado",
 *     extraer: (doc) => ({ clienteId, monto, detalle? }),   // doc = lo que devuelve core.documentos.obtener
 *   });
 *
 * Toda operación que cambia algo recibe `actor = { usuarioId, permisos }` y comprueba su permiso:
 *   fidelizacion:canjear    → descontar puntos canjeados (los autoriza el personal, por ejemplo el mesero)
 *   fidelizacion:gestionar  → ajustes manuales, la configuración y los beneficios de la empresa
 *
 * Beneficios y vales (5.30): la empresa define beneficios (un costo en puntos y lo que dan); el cliente canjea puntos
 * por un vale con código; el personal lo valida y lo consume una sola vez al aplicarlo en un pedido.
 *
 * Retos de colección (5.31): «prueba todo lo de una categoría de la carta y te regalamos esto». Cada `acumulo` guarda el
 * código del ítem pagado (`extraer` puede devolver `itemCodigo`); al acumular, si el cliente ya compró cada ítem
 * activo de la categoría, se le emite solo un vale sin costo en puntos, una vez por reto (índice único).
 */
export function crearServicioFidelizacion({ Empresa, MovimientoPuntos, Beneficio, Ticket, Reto }, documentos, clientes, auth, catalogo = null) {
  const fuentes = new Map(); // "tipo:estado" -> { tipo, estado, extraer }

  // ---------- ayudas ----------
  const exigir = (actor, permiso) => {
    if (!actor || !Array.isArray(actor.permisos))
      throw new ErrorFidelizacion("PERMISO_INSUFICIENTE", "se requiere quién realiza la operación");
    if (!permite(actor.permisos, permiso))
      throw new ErrorFidelizacion("PERMISO_INSUFICIENTE", `permiso insuficiente (${permiso})`);
  };

  const idValido = (v, nombre) => {
    if (!ID.test(String(v ?? ""))) throw new ErrorFidelizacion("DATOS_INVALIDOS", `${nombre} inválido`);
    return String(v);
  };

  async function empresaDe(empresaId) {
    const e = await Empresa.findById(empresaId).lean();
    if (!e || e.activa === false) throw new ErrorFidelizacion("NO_ENCONTRADO", "empresa no encontrada");
    return e;
  }

  const movimientoDto = (m) => ({
    id: String(m._id),
    tipo: m.tipo,
    puntos: m.puntos,
    ts: m.ts,
    detalle: m.detalle ?? null,
    documentoCode: m.documentoCode ?? null,
  });

  // El cliente debe existir (de esta empresa) y estar activo. `clientes.obtener` ya lanza NO_ENCONTRADO.
  async function clienteActivo(empresaId, clienteId) {
    try {
      const c = await clientes.obtener({ empresaId, clienteId });
      if (!c.activo || c.anonimizado) throw new ErrorFidelizacion("ESTADO_INVALIDO", "el cliente está desactivado o anonimizado");
      return c;
    } catch (e) {
      if (e instanceof ErrorCliente) throw new ErrorFidelizacion(e.codigo === "NO_ENCONTRADO" ? "NO_ENCONTRADO" : "DATOS_INVALIDOS", e.message);
      throw e;
    }
  }

  // ---------- configuración de la empresa ----------
  async function leerConfig({ empresaId }) {
    return configDe(await empresaDe(empresaId));
  }

  async function guardarConfig({ empresaId, actor, ...cambios }) {
    exigir(actor, "fidelizacion:gestionar");
    const c = validarConfig(cambios);
    await empresaDe(empresaId);
    const $set = Object.fromEntries(Object.entries(c).map(([k, v]) => [`fidelizacion.${k}`, v]));
    await Empresa.updateOne({ _id: empresaId }, { $set });
    return leerConfig({ empresaId });
  }

  // ---------- saldo y movimientos ----------
  async function saldo({ empresaId, clienteId }) {
    idValido(clienteId, "clienteId");
    return await conEmpresa(empresaId, async () => {
      const r = await MovimientoPuntos.aggregate([
        { $match: { clienteId: new mongoose.Types.ObjectId(String(clienteId)) } },
        { $group: { _id: null, total: { $sum: "$puntos" } } },
      ]);
      return r[0]?.total ?? 0;
    });
  }

  /** El saldo y los últimos movimientos de un cliente (más recientes primero). */
  async function resumen({ empresaId, clienteId, limite = 20 }) {
    idValido(clienteId, "clienteId");
    const lim = Math.min(Math.max(Math.trunc(Number(limite)) || 20, 1), MAX_MOVIMIENTOS);
    const movs = await conEmpresa(empresaId, async () =>
      await MovimientoPuntos.find({ clienteId }).sort({ ts: -1, _id: -1 }).limit(lim).lean(),
    );
    const config = configDe(await empresaDe(empresaId));
    return {
      habilitada: config.habilitada,
      saldo: await saldo({ empresaId, clienteId }),
      movimientos: movs.map(movimientoDto),
      logros: await logros({ empresaId, clienteId, config }),
      retos: await progresoRetos({ empresaId, clienteId }),
    };
  }

  /**
   * Nivel e insignias de un cliente (5.30), calculados desde su libro de puntos. `acumulado` es lo ganado por
   * consumir (los canjes y los ajustes no lo bajan ni lo suben). Límite conocido: lee todo el libro del cliente.
   */
  async function logros({ empresaId, clienteId, config }) {
    idValido(clienteId, "clienteId");
    const cfg = config ?? configDe(await empresaDe(empresaId));
    const libro = await conEmpresa(empresaId, async () => await MovimientoPuntos.find({ clienteId }).sort({ ts: 1 }).lean());
    return calcularLogros({ movimientos: libro, niveles: cfg.niveles });
  }

  async function insertar({ empresaId, clienteId, tipo, puntos, detalle, documentoCode = null, itemCodigo = null, creadoPor = null }) {
    return await conEmpresa(empresaId, async () =>
      await MovimientoPuntos.create({ clienteId, tipo, puntos, detalle, documentoCode, itemCodigo, creadoPor, ts: new Date() }),
    );
  }

  // ---------- acumular ----------
  /** Un servicio declara cuándo un documento da puntos y de dónde salen el cliente y el monto. */
  function registrarFuente({ tipo, estado, extraer } = {}) {
    if (typeof tipo !== "string" || !tipo || typeof estado !== "string" || !estado || typeof extraer !== "function")
      throw new Error("registrarFuente: se requiere { tipo, estado, extraer }");
    fuentes.set(`${tipo}:${estado}`, { tipo, estado, extraer });
  }

  /**
   * Acumula los puntos de un documento que ya llegó a su estado de cobro. Idempotente: si el documento ya
   * acumuló, devuelve lo registrado con `yaRegistrado: true`. Nunca falla por falta de cliente, de consentimiento
   * o de monto: devuelve `{ acumulados: 0, motivo }` (`sin_regla`, `deshabilitada`, `sin_cliente`, `sin_monto`,
   * `sin_puntos`, `cliente_no_encontrado`, `cliente_inactivo`, `sin_consentimiento`).
   */
  async function acumularPorDocumento({ empresaId, code }) {
    return await conEmpresa(empresaId, async () => {
      const d = await documentos.obtener({ code });
      if (!d) throw new ErrorFidelizacion("NO_ENCONTRADO", "documento no encontrado");
      const fuente = fuentes.get(`${d.tipo}:${d.estado}`);
      if (!fuente) return { acumulados: 0, motivo: "sin_regla" };

      const previo = await MovimientoPuntos.findOne({ documentoCode: code, tipo: "acumulo" }).lean();
      if (previo)
        return { acumulados: previo.puntos, yaRegistrado: true, clienteId: String(previo.clienteId), saldo: await saldo({ empresaId, clienteId: previo.clienteId }) };

      const config = configDe(await empresaDe(empresaId));
      if (!config.habilitada) return { acumulados: 0, motivo: "deshabilitada" };
      const { clienteId, monto, detalle, itemCodigo } = fuente.extraer(d) ?? {};
      if (!clienteId || !ID.test(String(clienteId))) return { acumulados: 0, motivo: "sin_cliente" };
      if (typeof monto !== "number" || monto <= 0) return { acumulados: 0, motivo: "sin_monto" };
      const puntos = calcularPuntos(monto, config.puntosPorUnidad);
      if (puntos < 1) return { acumulados: 0, motivo: "sin_puntos" };

      let consiente;
      try {
        consiente = await clientes.tieneConsentimiento({ empresaId, clienteId, finalidad: "programaPuntos" });
      } catch (e) {
        if (e instanceof ErrorCliente && e.codigo === "NO_ENCONTRADO") return { acumulados: 0, motivo: "cliente_no_encontrado" };
        throw e;
      }
      if (!consiente) {
        // Distingue «no consintió» de «el cliente ya no está activo» para que el personal sepa qué decirle.
        const c = await clientes.obtener({ empresaId, clienteId });
        return { acumulados: 0, motivo: !c.activo || c.anonimizado ? "cliente_inactivo" : "sin_consentimiento", clienteId: String(clienteId) };
      }

      try {
        await insertar({
          empresaId,
          clienteId,
          tipo: "acumulo",
          puntos,
          detalle: validarDetalle(detalle ?? "Pedido pagado"),
          documentoCode: code,
          itemCodigo: typeof itemCodigo === "string" && itemCodigo.trim() ? itemCodigo.trim() : null,
        });
      } catch (e) {
        // Otro proceso (el escucha del motor y la propia operación) lo registró a la vez: es lo mismo.
        if (e?.code !== 11000) throw e;
        return { acumulados: puntos, yaRegistrado: true, clienteId: String(clienteId), saldo: await saldo({ empresaId, clienteId }) };
      }
      // Un reto completado con este pago da su vale ahora. Si algo falla no se pierde nada: el siguiente pago lo vuelve a evaluar.
      let retosGanados = [];
      try {
        retosGanados = await evaluarRetos({ empresaId, clienteId });
      } catch (e) {
        console.error(`fidelizacion: no se pudieron evaluar los retos de ${clienteId}`, e);
      }
      return {
        acumulados: puntos,
        clienteId: String(clienteId),
        saldo: await saldo({ empresaId, clienteId }),
        ...(retosGanados.length ? { retosGanados } : {}),
      };
    });
  }

  // El motor emite `estado` después de guardar. Un fallo aquí no rompe la operación del usuario: se registra y
  // `acumularPorDocumento` se puede repetir (es idempotente).
  documentos.on("estado", async (ev) => {
    if (!fuentes.has(`${ev.tipoDocumento}:${ev.datos?.a}`)) return;
    try {
      await acumularPorDocumento({ empresaId: ev.empresaId, code: ev.documentoCode });
    } catch (e) {
      console.error(`fidelizacion: no se pudieron acumular los puntos de ${ev.documentoCode}`, e);
    }
  });

  // ---------- canjear y ajustar ----------
  // Descuenta puntos con una comprobación que no deja el saldo negativo aunque dos canjes lleguen a la vez: se
  // inserta el canje y se vuelve a calcular el saldo; si quedó negativo se inserta una reversa (el libro es de
  // solo inserción) y se rechaza. Con dos canjes simultáneos puede fallar uno de más, nunca pasar uno de más.
  async function descontar({ empresaId, clienteId, puntos, detalle, creadoPor = null }) {
    const actual = await saldo({ empresaId, clienteId });
    if (actual < puntos) throw new ErrorFidelizacion("SALDO_INSUFICIENTE", `saldo insuficiente (${actual} puntos)`, { saldo: actual });
    await insertar({ empresaId, clienteId, tipo: "canje", puntos: -puntos, detalle, creadoPor });
    const despues = await saldo({ empresaId, clienteId });
    if (despues < 0) {
      await insertar({ empresaId, clienteId, tipo: "ajuste", puntos, detalle: "Reversa: saldo insuficiente", creadoPor });
      throw new ErrorFidelizacion("SALDO_INSUFICIENTE", `saldo insuficiente (${despues + puntos} puntos)`, { saldo: despues + puntos });
    }
    return despues;
  }

  /**
   * Descuenta puntos canjeados por algo que el personal entrega a mano. Los autoriza el personal. Para los
   * beneficios con vale (el cliente canjea y el mesero lo aplica) ver `emitirTicket`.
   */
  async function canjear({ empresaId, actor, clienteId, puntos, detalle }) {
    exigir(actor, "fidelizacion:canjear");
    validarPuntos(puntos);
    const det = validarDetalle(detalle) ?? "Canje de beneficio";
    await clienteActivo(empresaId, clienteId);
    return { saldo: await descontar({ empresaId, clienteId, puntos, detalle: det, creadoPor: actor.usuarioId ?? null }) };
  }

  /** Corrección manual del saldo (positiva o negativa). El motivo es obligatorio: queda en el libro. */
  async function ajustar({ empresaId, actor, clienteId, puntos, detalle }) {
    exigir(actor, "fidelizacion:gestionar");
    if (!Number.isInteger(puntos) || puntos === 0 || Math.abs(puntos) > 1_000_000)
      throw new ErrorFidelizacion("DATOS_INVALIDOS", "puntos: un entero distinto de 0 (hasta 1.000.000, con signo)");
    const det = validarDetalle(detalle, { obligatorio: true });
    await clienteActivo(empresaId, clienteId);
    const actual = await saldo({ empresaId, clienteId });
    if (actual + puntos < 0)
      throw new ErrorFidelizacion("SALDO_INSUFICIENTE", `el ajuste dejaría el saldo en negativo (${actual} puntos)`, { saldo: actual });
    await insertar({ empresaId, clienteId, tipo: "ajuste", puntos, detalle: det, creadoPor: actor.usuarioId ?? null });
    return { saldo: actual + puntos };
  }

  // ---------- beneficios ----------
  const beneficioDto = (b) => ({
    id: String(b._id),
    nombre: b.nombre,
    descripcion: b.descripcion ?? null,
    puntos: b.puntos,
    tipo: b.tipo,
    valor: b.valor ?? null,
    itemCodigo: b.itemCodigo ?? null,
    vigenciaDias: b.vigenciaDias,
    activo: b.activo,
    texto: textoBeneficio(b),
  });

  async function cargarBeneficio(empresaId, beneficioId, { soloActivo = false } = {}) {
    idValido(beneficioId, "beneficioId");
    const b = await conEmpresa(empresaId, async () => await Beneficio.findOne({ _id: beneficioId }).lean());
    if (!b || (soloActivo && !b.activo)) throw new ErrorFidelizacion("NO_ENCONTRADO", "beneficio no encontrado");
    return b;
  }

  /** Los beneficios de la empresa. El personal que canjea o gestiona los ve todos (activos primero). */
  async function listarBeneficios({ empresaId, actor, incluirInactivos = true }) {
    if (!actor || !Array.isArray(actor.permisos)) throw new ErrorFidelizacion("PERMISO_INSUFICIENTE", "se requiere quién realiza la operación");
    if (!permite(actor.permisos, "fidelizacion:canjear") && !permite(actor.permisos, "fidelizacion:gestionar"))
      throw new ErrorFidelizacion("PERMISO_INSUFICIENTE", "permiso insuficiente (fidelizacion:canjear)");
    const filtro = incluirInactivos ? {} : { activo: true };
    const lista = await conEmpresa(empresaId, async () => await Beneficio.find(filtro).sort({ activo: -1, puntos: 1, _id: 1 }).lean());
    return lista.map(beneficioDto);
  }

  /** Lo que ve el cliente: solo los beneficios activos, del más barato al más caro. */
  async function beneficiosActivos({ empresaId }) {
    const lista = await conEmpresa(empresaId, async () => await Beneficio.find({ activo: true }).sort({ puntos: 1, _id: 1 }).lean());
    return lista.map(beneficioDto);
  }

  async function crearBeneficio({ empresaId, actor, ...datos }) {
    exigir(actor, "fidelizacion:gestionar");
    const b = validarBeneficio(datos);
    await empresaDe(empresaId);
    const nuevo = await conEmpresa(empresaId, async () => await Beneficio.create(b));
    return beneficioDto(nuevo.toObject());
  }

  /** Cambia un beneficio. Los vales ya emitidos conservan su copia: no cambian. Para retirarlo, `activo: false`. */
  async function editarBeneficio({ empresaId, actor, beneficioId, ...cambios }) {
    exigir(actor, "fidelizacion:gestionar");
    const actual = await cargarBeneficio(empresaId, beneficioId);
    const b = validarBeneficio(cambios, actual);
    await conEmpresa(empresaId, async () => await Beneficio.updateOne({ _id: beneficioId }, { $set: b }));
    return beneficioDto(await cargarBeneficio(empresaId, beneficioId));
  }

  // ---------- vales ----------
  const ticketDto = (t, ahora = new Date()) => ({
    id: String(t._id),
    codigo: t.codigo,
    estado: estadoEfectivo(t, ahora),
    origen: t.retoId ? "reto" : "canje", // `reto`: lo ganó solo, no costó puntos (5.31)
    beneficio: {
      nombre: t.beneficio?.nombre ?? "",
      descripcion: t.beneficio?.descripcion ?? null,
      tipo: t.beneficio?.tipo ?? null,
      valor: t.beneficio?.valor ?? null,
      itemCodigo: t.beneficio?.itemCodigo ?? null,
      texto: t.beneficio ? textoBeneficio(t.beneficio) : "",
    },
    puntos: t.puntos,
    ts: t.ts,
    venceTs: t.venceTs,
    usadoTs: t.usadoTs ?? null,
    uso: t.uso?.itemCode ? { pedidoCode: t.uso.pedidoCode ?? null, itemCode: t.uso.itemCode, descuento: t.uso.descuento ?? null } : null,
  });

  function codigoValido(codigo) {
    const c = normalizarCodigo(codigo);
    if (!c) throw new ErrorFidelizacion("DATOS_INVALIDOS", "código de vale inválido");
    return c;
  }

  // Devuelve los puntos de un vale que no llegó a usarse (el cliente lo canceló).
  async function devolverPuntos({ empresaId, clienteId, puntos, detalle, creadoPor = null }) {
    await insertar({ empresaId, clienteId, tipo: "ajuste", puntos, detalle, creadoPor });
  }

  async function emitir({ empresaId, clienteId, beneficioId, emitidoPor }) {
    idValido(clienteId, "clienteId");
    const config = configDe(await empresaDe(empresaId));
    if (!config.habilitada) throw new ErrorFidelizacion("ESTADO_INVALIDO", "el programa de puntos no está activo");
    await clienteActivo(empresaId, clienteId);
    if (!(await clientes.tieneConsentimiento({ empresaId, clienteId, finalidad: "programaPuntos" })))
      throw new ErrorFidelizacion("ESTADO_INVALIDO", "el cliente no participa en el programa de puntos");
    const b = await cargarBeneficio(empresaId, beneficioId, { soloActivo: true });
    await descontar({ empresaId, clienteId, puntos: b.puntos, detalle: `Vale: ${b.nombre}`, creadoPor: emitidoPor });

    const ahora = new Date();
    const datos = {
      clienteId,
      beneficioId: b._id,
      beneficio: { nombre: b.nombre, descripcion: b.descripcion ?? null, tipo: b.tipo, valor: b.valor ?? null, itemCodigo: b.itemCodigo ?? null },
      puntos: b.puntos,
      estado: "activo",
      ts: ahora,
      venceTs: new Date(ahora.getTime() + b.vigenciaDias * 86_400_000),
      emitidoPor,
    };
    try {
      for (let intento = 0; ; intento++) {
        try {
          const t = await conEmpresa(empresaId, async () => await Ticket.create({ ...datos, codigo: generarCodigo() }));
          return { ticket: ticketDto(t.toObject()), saldo: await saldo({ empresaId, clienteId }) };
        } catch (e) {
          if (e?.code !== 11000 || intento >= 5) throw e; // código repetido: se prueba con otro
        }
      }
    } catch (e) {
      // No se pudo emitir: los puntos vuelven al cliente.
      await devolverPuntos({ empresaId, clienteId, puntos: b.puntos, detalle: `Reversa: no se pudo emitir el vale «${b.nombre}»`, creadoPor: emitidoPor });
      throw e;
    }
  }

  /** El propio cliente canjea puntos por un vale (sesión de cliente). Exige que participe en el programa de puntos. */
  async function emitirMiTicket({ empresaId, clienteId, beneficioId }) {
    return await emitir({ empresaId, clienteId, beneficioId, emitidoPor: null });
  }

  /** El personal emite el vale por un cliente (por ejemplo, a quien no usa la cuenta en línea). */
  async function emitirTicket({ empresaId, actor, clienteId, beneficioId }) {
    exigir(actor, "fidelizacion:canjear");
    return await emitir({ empresaId, clienteId, beneficioId, emitidoPor: actor.usuarioId ?? null });
  }

  /** Los vales de un cliente (más recientes primero). */
  async function ticketsDe({ empresaId, clienteId, limite = 50 }) {
    idValido(clienteId, "clienteId");
    const lim = Math.min(Math.max(Math.trunc(Number(limite)) || 50, 1), MAX_MOVIMIENTOS);
    const lista = await conEmpresa(empresaId, async () => await Ticket.find({ clienteId }).sort({ ts: -1, _id: -1 }).limit(lim).lean());
    const ahora = new Date();
    return lista.map((t) => ticketDto(t, ahora));
  }

  /** El cliente cancela un vale suyo que sigue activo: recupera los puntos. */
  async function cancelarMiTicket({ empresaId, clienteId, codigo }) {
    idValido(clienteId, "clienteId");
    const c = codigoValido(codigo);
    const t = await conEmpresa(empresaId, async () =>
      await Ticket.findOneAndUpdate(
        { codigo: c, clienteId, retoId: null, estado: "activo", venceTs: { $gt: new Date() } }, // los vales de un reto no se cancelan: no costaron puntos
        { $set: { estado: "cancelado", canceladoTs: new Date() } },
        { new: true },
      ).lean(),
    );
    if (!t) throw new ErrorFidelizacion("ESTADO_INVALIDO", "el vale no existe o ya no se puede cancelar");
    await devolverPuntos({ empresaId, clienteId, puntos: t.puntos, detalle: `Vale cancelado: ${t.beneficio?.nombre ?? ""}`.trim() });
    return { ticket: ticketDto(t), saldo: await saldo({ empresaId, clienteId }) };
  }

  async function cargarTicket(empresaId, codigo) {
    const c = codigoValido(codigo);
    const t = await conEmpresa(empresaId, async () => await Ticket.findOne({ codigo: c }).lean());
    if (!t) throw new ErrorFidelizacion("NO_ENCONTRADO", "vale no encontrado");
    return t;
  }

  /** El personal mira un vale por su código: qué beneficio es, de quién y si sirve. No cambia nada. */
  async function consultarTicket({ empresaId, actor, codigo }) {
    exigir(actor, "fidelizacion:canjear");
    const t = await cargarTicket(empresaId, codigo);
    let cliente = null;
    try {
      const c = await clientes.obtener({ empresaId, clienteId: String(t.clienteId) });
      cliente = { id: String(t.clienteId), nombre: c.nombre };
    } catch {
      cliente = { id: String(t.clienteId), nombre: "" };
    }
    return { ...ticketDto(t), cliente, beneficioCompleto: { tipo: t.beneficio?.tipo, valor: t.beneficio?.valor ?? null, itemCodigo: t.beneficio?.itemCodigo ?? null } };
  }

  /**
   * Consume el vale: de `activo` a `usado`, en una sola actualización atómica (dos meseros con el mismo código:
   * gana uno). `uso` anota dónde se aplicó. Si lo que sigue falla, `liberarTicket` lo deja activo otra vez.
   */
  async function consumirTicket({ empresaId, actor, codigo, uso = {} }) {
    exigir(actor, "fidelizacion:canjear");
    const c = codigoValido(codigo);
    const ahora = new Date();
    const t = await conEmpresa(empresaId, async () =>
      await Ticket.findOneAndUpdate(
        { codigo: c, estado: "activo", venceTs: { $gt: ahora } },
        {
          $set: {
            estado: "usado",
            usadoTs: ahora,
            usadoPor: actor.usuarioId ?? null,
            "uso.pedidoCode": uso.pedidoCode ?? null,
            "uso.itemCode": uso.itemCode ?? null,
            "uso.descuento": uso.descuento ?? null,
          },
        },
        { new: true },
      ).lean(),
    );
    if (t) return ticketDto(t, ahora);
    const actual = await cargarTicket(empresaId, c); // NO_ENCONTRADO si no existe
    const estado = estadoEfectivo(actual, ahora);
    const motivo = { usado: "el vale ya fue usado", cancelado: "el vale fue cancelado", vencido: "el vale está vencido" }[estado] ?? "el vale no se puede usar";
    throw new ErrorFidelizacion("ESTADO_INVALIDO", motivo);
  }

  /** Deshace `consumirTicket` cuando no se llegó a aplicar el descuento (solo si lo consumió ese mismo uso). */
  async function liberarTicket({ empresaId, actor, codigo, itemCode }) {
    exigir(actor, "fidelizacion:canjear");
    const c = codigoValido(codigo);
    await conEmpresa(empresaId, async () =>
      await Ticket.updateOne(
        { codigo: c, estado: "usado", "uso.itemCode": itemCode ?? null },
        { $set: { estado: "activo", usadoTs: null, usadoPor: null, "uso.pedidoCode": null, "uso.itemCode": null, "uso.descuento": null } },
      ),
    );
  }


  // ---------- retos de colección (5.31) ----------
  const retoDto = (r) => ({
    id: String(r._id),
    nombre: r.nombre,
    descripcion: r.descripcion ?? null,
    categoria: r.categoria,
    tipo: r.tipo,
    valor: r.valor ?? null,
    itemCodigo: r.itemCodigo ?? null,
    vigenciaDias: r.vigenciaDias,
    activo: r.activo,
    texto: textoBeneficio(r),
  });

  async function cargarReto(empresaId, retoId) {
    idValido(retoId, "retoId");
    const r = await conEmpresa(empresaId, async () => await Reto.findOne({ _id: retoId }).lean());
    if (!r) throw new ErrorFidelizacion("NO_ENCONTRADO", "reto no encontrado");
    return r;
  }

  /** Los retos de la empresa (activos primero). Los ven quienes canjean o gestionan. */
  async function listarRetos({ empresaId, actor }) {
    if (!actor || !Array.isArray(actor.permisos)) throw new ErrorFidelizacion("PERMISO_INSUFICIENTE", "se requiere quién realiza la operación");
    if (!permite(actor.permisos, "fidelizacion:canjear") && !permite(actor.permisos, "fidelizacion:gestionar"))
      throw new ErrorFidelizacion("PERMISO_INSUFICIENTE", "permiso insuficiente (fidelizacion:canjear)");
    const lista = await conEmpresa(empresaId, async () => await Reto.find({}).sort({ activo: -1, _id: 1 }).lean());
    return lista.map(retoDto);
  }

  async function crearReto({ empresaId, actor, ...datos }) {
    exigir(actor, "fidelizacion:gestionar");
    const r = validarReto(datos);
    await empresaDe(empresaId);
    const nuevo = await conEmpresa(empresaId, async () => await Reto.create(r));
    return retoDto(nuevo.toObject());
  }

  /** Cambia un reto. Los vales ya ganados conservan su copia. Para retirarlo, `activo: false`. */
  async function editarReto({ empresaId, actor, retoId, ...cambios }) {
    exigir(actor, "fidelizacion:gestionar");
    const actual = await cargarReto(empresaId, retoId);
    const r = validarReto(cambios, actual);
    await conEmpresa(empresaId, async () => await Reto.updateOne({ _id: retoId }, { $set: r }));
    return retoDto(await cargarReto(empresaId, retoId));
  }

  // Los ítems activos de la categoría: lo que hay que probar hoy. Si la carta cambia, el reto se ajusta solo.
  async function requeridosDe(empresaId, categoria) {
    if (!catalogo?.listar) return [];
    const items = await catalogo.listar({ empresaId, categoria, limite: 200 });
    return items.map((i) => ({ codigo: i.codigo, nombre: i.nombre }));
  }

  async function movimientosDeConsumo(empresaId, clienteId) {
    return await conEmpresa(empresaId, async () => await MovimientoPuntos.find({ clienteId, tipo: "acumulo" }).lean());
  }
  async function ticketsDeRetos(empresaId, clienteId) {
    const todos = await conEmpresa(empresaId, async () => await Ticket.find({ clienteId }).lean());
    return new Map(todos.filter((t) => t.retoId).map((t) => [String(t.retoId), t]));
  }

  /**
   * El avance de un cliente en cada reto activo, para mostrárselo: { id, nombre, descripcion, texto, categoria,
   * total, logrados, faltan, completo, vale }. `vale` es el vale ganado ({ codigo, estado, venceTs }) o null.
   * Un reto cuyo premio ya se ganó sigue apareciendo como completado, aunque la carta cambie después.
   */
  async function progresoRetos({ empresaId, clienteId }) {
    idValido(clienteId, "clienteId");
    if (!Reto) return [];
    const retos = await conEmpresa(empresaId, async () => await Reto.find({ activo: true }).sort({ _id: 1 }).lean());
    if (!retos.length) return [];
    const [movs, ganados] = await Promise.all([movimientosDeConsumo(empresaId, clienteId), ticketsDeRetos(empresaId, clienteId)]);
    const ahora = new Date();
    const salida = [];
    for (const r of retos) {
      const p = calcularProgreso({ requeridos: await requeridosDe(empresaId, r.categoria), movimientos: movs });
      const t = ganados.get(String(r._id));
      salida.push({
        ...(({ id, nombre, descripcion, categoria, texto }) => ({ id, nombre, descripcion, categoria, texto }))(retoDto(r)),
        ...p,
        completo: p.completo || Boolean(t),
        vale: t ? { codigo: t.codigo, estado: estadoEfectivo(t, ahora), venceTs: t.venceTs } : null,
      });
    }
    return salida;
  }

  /**
   * Emite el vale de cada reto activo que el cliente acaba de completar y todavía no ganó. Idempotente: el índice
   * único `{ cliente, reto }` impide un segundo vale aunque dos pagos lleguen a la vez. Devuelve los vales emitidos
   * ({ retoId, nombre, codigo }). No hace nada si el programa está apagado o el cliente retiró su consentimiento.
   */
  async function evaluarRetos({ empresaId, clienteId }) {
    idValido(clienteId, "clienteId");
    if (!Reto) return [];
    const retos = await conEmpresa(empresaId, async () => await Reto.find({ activo: true }).sort({ _id: 1 }).lean());
    if (!retos.length) return [];
    const config = configDe(await empresaDe(empresaId));
    if (!config.habilitada) return [];
    if (!(await clientes.tieneConsentimiento({ empresaId, clienteId, finalidad: "programaPuntos" }))) return [];

    const [movs, ganados] = await Promise.all([movimientosDeConsumo(empresaId, clienteId), ticketsDeRetos(empresaId, clienteId)]);
    const emitidos = [];
    for (const r of retos) {
      if (ganados.has(String(r._id))) continue;
      const p = calcularProgreso({ requeridos: await requeridosDe(empresaId, r.categoria), movimientos: movs });
      if (!p.completo) continue;

      const ahora = new Date();
      const datos = {
        clienteId,
        beneficioId: r._id, // no hay beneficio del catálogo: se guarda el reto que lo originó
        retoId: r._id,
        origen: "reto",
        beneficio: { nombre: r.nombre, descripcion: r.descripcion ?? null, tipo: r.tipo, valor: r.valor ?? null, itemCodigo: r.itemCodigo ?? null },
        puntos: 0,
        estado: "activo",
        ts: ahora,
        venceTs: new Date(ahora.getTime() + r.vigenciaDias * 86_400_000),
        emitidoPor: null,
      };
      for (let intento = 0; ; intento++) {
        try {
          const t = await conEmpresa(empresaId, async () => await Ticket.create({ ...datos, codigo: generarCodigo() }));
          emitidos.push({ retoId: String(r._id), nombre: r.nombre, codigo: t.codigo });
          break;
        } catch (e) {
          if (e?.code !== 11000) throw e;
          // ¿Lo emitió otro pago a la vez? Entonces ya está. Si no, fue un código repetido: se prueba con otro.
          if ((await ticketsDeRetos(empresaId, clienteId)).has(String(r._id))) break;
          if (intento >= 5) throw e;
        }
      }
    }
    return emitidos;
  }

  // ---------- Express ----------
  const responder = (res, e, next) => {
    if (e instanceof ErrorFidelizacion || e instanceof ErrorCliente || e instanceof ErrorAuth)
      return res.status(e.status).json({ error: e.message, codigo: e.codigo, ...(e.detalle?.saldo !== undefined ? { saldo: e.detalle.saldo } : {}) });
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
    /** GET /clientes/beneficios → { beneficios } (fidelizacion:canjear) */
    beneficios: envolver(false, async (req, res) =>
      res.status(200).json({ beneficios: await listarBeneficios({ ...base(req) }) }),
    ),
    /** POST /clientes/beneficios { nombre, puntos, tipo, valor?, itemCodigo?, descripcion?, vigenciaDias? } (fidelizacion:gestionar) */
    crearBeneficio: envolver(true, async (req, res) => res.status(201).json(await crearBeneficio({ ...base(req), ...(req.body ?? {}) }))),
    /** PUT /clientes/beneficios/:beneficioId { …cambios } (fidelizacion:gestionar) */
    editarBeneficio: envolver(true, async (req, res) =>
      res.status(200).json(await editarBeneficio({ ...base(req), beneficioId: req.params?.beneficioId, ...(req.body ?? {}) })),
    ),
    /** GET /clientes/retos → { retos } (fidelizacion:canjear) */
    retos: envolver(false, async (req, res) => res.status(200).json({ retos: await listarRetos({ ...base(req) }) })),
    /** POST /clientes/retos { nombre, categoria, tipo, valor?, itemCodigo?, descripcion?, vigenciaDias? } (fidelizacion:gestionar) */
    crearReto: envolver(true, async (req, res) => res.status(201).json(await crearReto({ ...base(req), ...(req.body ?? {}) }))),
    /** PUT /clientes/retos/:retoId { …cambios } (fidelizacion:gestionar) */
    editarReto: envolver(true, async (req, res) =>
      res.status(200).json(await editarReto({ ...base(req), retoId: req.params?.retoId, ...(req.body ?? {}) })),
    ),
    /** GET /clientes/fidelizacion/config (fidelizacion:canjear) */
    config: envolver(false, async (req, res) => res.status(200).json(await leerConfig({ empresaId: req.auth.empresaId }))),
    /** PUT /clientes/fidelizacion/config { habilitada?, puntosPorUnidad? } (fidelizacion:gestionar) */
    guardarConfig: envolver(true, async (req, res) => res.status(200).json(await guardarConfig({ ...base(req), ...(req.body ?? {}) }))),
    /** GET /clientes/tickets/:codigo → el vale con su beneficio y su cliente (fidelizacion:canjear) */
    ticket: envolver(false, async (req, res) => res.status(200).json(await consultarTicket({ ...base(req), codigo: req.params?.codigo }))),
    /** POST /clientes/:clienteId/tickets { beneficioId } → 201 (fidelizacion:canjear): el personal emite el vale por el cliente */
    emitirTicket: envolver(true, async (req, res) =>
      res.status(201).json(await emitirTicket({ ...base(req), clienteId: req.params?.clienteId, beneficioId: req.body?.beneficioId })),
    ),
    /** GET /clientes/:clienteId/puntos */
    puntos: envolver(false, async (req, res) => {
      const clienteId = idValido(req.params?.clienteId, "clienteId");
      await clientes.obtener({ empresaId: req.auth.empresaId, clienteId }); // 404 si no existe
      res.status(200).json(await resumen({ empresaId: req.auth.empresaId, clienteId, limite: req.query?.limite }));
    }),
    /** POST /clientes/:clienteId/puntos/canjear { puntos, detalle? } */
    canjear: envolver(true, async (req, res) =>
      res.status(200).json(
        await canjear({ ...base(req), clienteId: req.params?.clienteId, puntos: req.body?.puntos, detalle: req.body?.detalle }),
      ),
    ),
  };

  return {
    registrarFuente,
    fuentes: () => [...fuentes.values()].map(({ tipo, estado }) => ({ tipo, estado })),
    acumularPorDocumento,
    saldo,
    resumen,
    logros,
    canjear,
    ajustar,
    beneficios: { listar: listarBeneficios, activos: beneficiosActivos, crear: crearBeneficio, editar: editarBeneficio },
    tickets: {
      emitir: emitirTicket,
      emitirMio: emitirMiTicket,
      de: ticketsDe,
      cancelarMio: cancelarMiTicket,
      consultar: consultarTicket,
      consumir: consumirTicket,
      liberar: liberarTicket,
      calcularDescuento,
    },
    retos: { listar: listarRetos, crear: crearReto, editar: editarReto, progreso: progresoRetos, evaluar: evaluarRetos },
    leerConfig,
    guardarConfig,
    manejadores,
    listo: () => MovimientoPuntos.init(), // espera a que exista el índice único de idempotencia
  };
}

export { ErrorFidelizacion } from "./errores.js";
