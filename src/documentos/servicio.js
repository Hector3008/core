import { EventEmitter } from "node:events";
import { empresaActual } from "../tenancy.js";
import { permite } from "../permisos.js";
import { ErrorDocumento } from "./errores.js";
import { crearRegistroTipos } from "./registro.js";

const EVENTOS = ["creado", "estado", "version"];
const LIMITE_MAX = 200;
const DUPLICADO = 11000; // E11000: violación de índice único

const formatearCodigo = (prefijo, n) =>
  `${prefijo}-${String(n).padStart(7, "0")}`;

function limpiarMotivo(motivo) {
  if (!motivo?.codigo) return undefined;
  const m = { codigo: motivo.codigo };
  if (motivo.detalle) m.detalle = motivo.detalle;
  return m;
}

/**
 * Motor de documentos. Todas las operaciones corren dentro de la empresa activa
 * (conEmpresa) y deben ejecutarse con `await` dentro de una función `async`.
 */
export function crearServicioDocumentos({
  Documento,
  DocumentoVersion,
  Contador,
}) {
  const registro = crearRegistroTipos();

  // captureRejections: un escucha async que falle no tumba el proceso
  const emisor = new EventEmitter({ captureRejections: true });
  emisor.on("error", (e) =>
    console.error("documentos: falló un escucha de eventos", e),
  );

  function exigirEmpresa() {
    if (!empresaActual())
      throw new Error("documentos: sin empresa activa (use conEmpresa)");
  }

  // Un escucha que falle nunca debe romper la operación que ya se guardó
  function emitir(nombre, doc, usuarioId, datos) {
    const evento = {
      empresaId: empresaActual(),
      usuarioId: usuarioId ?? null,
      documentoCode: doc.code,
      tipoDocumento: doc.tipo,
      version: doc.version,
      ts: new Date(),
      datos,
    };
    try {
      emisor.emit(nombre, evento);
    } catch (e) {
      console.error(`documentos: falló un escucha de '${nombre}'`, e);
    }
  }

  // Contador atómico. Si dos llamadas crean el contador a la vez, una choca con
  // el índice único (E11000) y se reintenta.
  async function siguienteNumero(tipo) {
    for (let intento = 0; ; intento++) {
      try {
        const c = await Contador.findOneAndUpdate(
          { tipo },
          { $inc: { valor: 1 } },
          { upsert: true, returnDocument: "after", lean: true },
        );
        return c.valor;
      } catch (e) {
        if (e?.code !== DUPLICADO || intento >= 3) throw e;
      }
    }
  }

  async function cargar(code) {
    const doc = await Documento.findOne({ code }).lean();
    if (!doc)
      throw new ErrorDocumento(
        "DOCUMENTO_NO_ENCONTRADO",
        `No existe el documento ${code}`,
      );
    return doc;
  }

  const conflicto = (code, esperada, real) =>
    new ErrorDocumento(
      "CONFLICTO_VERSION",
      `El documento ${code} cambió mientras se trabajaba en él; vuelve a cargarlo`,
      { esperada, real },
    );

  // Guarda la versión que se va a reemplazar. Si ya estaba (reintento tras un
  // conflicto) el contenido es el mismo, así que el duplicado se ignora.
  async function guardarCopia(actual) {
    try {
      await DocumentoVersion.create({
        tipo: actual.tipo,
        code: actual.code,
        version: actual.version,
        estado: actual.estado,
        snapshot: actual.snapshot,
        payload: actual.payload,
        usuarioId: actual.versionPor ?? null,
        ts: actual.versionTs ?? actual.createdAt,
      });
    } catch (e) {
      if (e?.code !== DUPLICADO) throw e;
    }
  }

  // Núcleo común de transicionar y nuevaVersion: una sola actualización condicionada
  // por { code, version, estado }, de modo que dos usuarios no se pisan.
  async function modificar(
    code,
    { a, doc, snapshot, usuarioId = null, permisos, sistema = false, motivo, esperaVersion },
  ) {
    exigirEmpresa();
    const actual = await cargar(code);
    const def = registro.obtener(actual.tipo);
    const cambiaContenido = doc !== undefined || snapshot !== undefined;

    if (esperaVersion !== undefined && esperaVersion !== actual.version)
      throw conflicto(code, esperaVersion, actual.version);

    if (cambiaContenido && !def.editables.includes(actual.estado))
      throw new ErrorDocumento(
        "ESTADO_NO_EDITABLE",
        `Un documento '${actual.tipo}' en estado '${actual.estado}' no se puede editar`,
      );

    const motivoLimpio = limpiarMotivo(motivo);
    if (a !== undefined) {
      if (!def.transiciones[actual.estado]?.includes(a))
        throw new ErrorDocumento(
          "TRANSICION_INVALIDA",
          `No se puede pasar de '${actual.estado}' a '${a}' (${actual.tipo})`,
        );

      const requerido = def.permisos[a];
      if (
        requerido &&
        !sistema &&
        !(Array.isArray(permisos) && permite(permisos, requerido))
      )
        throw new ErrorDocumento(
          "PERMISO_INSUFICIENTE",
          `Se requiere el permiso '${requerido}' para pasar a '${a}'`,
        );

      const validos = def.motivos[a];
      if (validos) {
        if (!motivoLimpio)
          throw new ErrorDocumento(
            "MOTIVO_REQUERIDO",
            `Pasar a '${a}' exige un motivo`,
            { validos },
          );
        if (!validos.includes(motivoLimpio.codigo))
          throw new ErrorDocumento(
            "MOTIVO_INVALIDO",
            `Motivo '${motivoLimpio.codigo}' no válido para '${a}'`,
            { validos },
          );
      }
    }

    const ahora = new Date();
    const set = {};
    const update = { $set: set };

    if (cambiaContenido) {
      await guardarCopia(actual);
      if (doc !== undefined) set["payload.doc"] = doc;
      if (snapshot !== undefined) set.snapshot = snapshot;
      set.versionPor = usuarioId;
      set.versionTs = ahora;
      update.$inc = { version: 1 };
    }
    if (a !== undefined) {
      set.estado = a;
      update.$push = {
        historial: {
          de: actual.estado,
          a,
          usuarioId,
          sistema,
          ts: ahora,
          ...(motivoLimpio && { motivo: motivoLimpio }),
        },
      };
    }

    const nuevo = await Documento.findOneAndUpdate(
      { code, version: actual.version, estado: actual.estado },
      update,
      { returnDocument: "after", lean: true },
    );
    if (!nuevo) throw conflicto(code, actual.version, undefined);

    if (cambiaContenido)
      emitir("version", nuevo, usuarioId, {
        versionAnterior: actual.version,
        versionNueva: nuevo.version,
        cambio: { doc: doc !== undefined, snapshot: snapshot !== undefined },
      });
    if (a !== undefined) {
      const desde = actual.historial?.at(-1)?.ts ?? actual.createdAt;
      emitir("estado", nuevo, usuarioId, {
        de: actual.estado,
        a,
        motivo: motivoLimpio ?? null,
        sistema,
        msEnEstadoAnterior: ahora - desde,
      });
    }
    return nuevo;
  }

  const servicio = {
    registrarTipo: (def) => registro.registrar(def),
    tipos: () => registro.listar(),

    // Espera a que existan los índices únicos (numeración y versiones dependen de ellos)
    listo: () =>
      Promise.all([
        Documento.init(),
        DocumentoVersion.init(),
        Contador.init(),
      ]).then(() => undefined),

    async crear({ tipo, snapshot = {}, doc = {}, usuarioId = null } = {}) {
      exigirEmpresa();
      const def = registro.obtener(tipo);
      const n = await siguienteNumero(tipo);
      const ahora = new Date();
      const creado = await Documento.create({
        tipo,
        code: formatearCodigo(def.prefijo, n),
        estado: def.estadoInicial,
        version: 1,
        snapshot,
        payload: { doc },
        creadoPor: usuarioId,
        versionPor: usuarioId,
        versionTs: ahora,
        historial: [
          { de: null, a: def.estadoInicial, usuarioId, sistema: false, ts: ahora },
        ],
      });
      const resultado = creado.toObject();
      emitir("creado", resultado, usuarioId, { estado: def.estadoInicial });
      return resultado;
    },

    // Sin `version` devuelve el documento actual; con `version` anterior, la copia
    // guardada de esa versión. null si no existe.
    async obtener({ code, version } = {}) {
      exigirEmpresa();
      const actual = await Documento.findOne({ code }).lean();
      if (!actual) return null;
      if (version === undefined || version === actual.version) return actual;
      return (await DocumentoVersion.findOne({ code, version }).lean()) ?? null;
    },

    async listar({ tipo, estado, limite = 50, saltar = 0 } = {}) {
      exigirEmpresa();
      const filtro = {};
      if (tipo) filtro.tipo = tipo;
      if (estado) filtro.estado = Array.isArray(estado) ? { $in: estado } : estado;
      return await Documento.find(filtro)
        .sort({ createdAt: -1 })
        .skip(saltar)
        .limit(Math.min(limite, LIMITE_MAX))
        .lean();
    },

    // Cambia de estado. Con `doc` o `snapshot` también edita, en la misma actualización.
    async transicionar({ code, a, ...resto } = {}) {
      if (!a) throw new TypeError("transicionar: falta 'a' (estado destino)");
      return await modificar(code, { a, ...resto });
    },

    // Edita el contenido sin cambiar de estado: crea una versión nueva.
    async nuevaVersion({ code, doc, snapshot, usuarioId, esperaVersion } = {}) {
      if (doc === undefined && snapshot === undefined)
        throw new TypeError("nuevaVersion: falta 'doc' o 'snapshot'");
      return await modificar(code, { doc, snapshot, usuarioId, esperaVersion });
    },

    // Eventos: "creado" | "estado" | "version"
    on(nombre, fn) {
      if (!EVENTOS.includes(nombre))
        throw new Error(`documentos.on: evento desconocido '${nombre}'`);
      emisor.on(nombre, fn);
      return servicio;
    },
    off(nombre, fn) {
      emisor.off(nombre, fn);
      return servicio;
    },
  };

  return servicio;
}
