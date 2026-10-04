// Requiere una MongoDB real: MONGODB_URI=mongodb://localhost:27017 node --test
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { createCore, conEmpresa } from "../src/index.js";

const uri = process.env.MONGODB_URI;
const opts = {
  skip: uri ? false : "define MONGODB_URI para correr esta prueba",
};

// Reglas de prueba (no son las de siscore: los motivos reales se deciden después)
const PROFORMA = {
  tipo: "proforma",
  prefijo: "DP",
  estadoInicial: "borrador",
  transiciones: {
    borrador: ["cotizacion", "orden_salida", "descartado"],
    cotizacion: ["orden_salida", "rechazada", "vencida"],
    orden_salida: ["en_revision"],
    en_revision: ["cerrada", "orden_salida"],
  },
  permisos: { en_revision: "estacion:revision", cerrada: "estacion:revision" },
  motivos: {
    rechazada: ["precio", "stock", "otro"],
    descartado: ["error", "duplicado", "otro"],
  },
};

const oid = () => new mongoose.Types.ObjectId();
const COLECCIONES = ["documentos", "documento_versiones", "contadores"];

describe("motor de documentos", opts, () => {
  let conn, core, docs;
  const A = oid();
  const B = oid();
  const u = oid();
  const enA = (fn) => conEmpresa(A, fn);
  const enB = (fn) => conEmpresa(B, fn);
  const codigo = (e) => (err) => err?.codigo === e;

  // Lleva un documento hasta `estado` por el camino feliz
  async function hasta(estado, extra = {}) {
    const d = await docs.crear({ tipo: "proforma", doc: { lineas: [1] }, usuarioId: u });
    const camino = {
      borrador: [],
      cotizacion: ["cotizacion"],
      orden_salida: ["orden_salida"],
      en_revision: ["orden_salida", "en_revision"],
    }[estado];
    for (const a of camino)
      await docs.transicionar({ code: d.code, a, usuarioId: u, permisos: ["*"], ...extra });
    return d.code;
  }

  before(async () => {
    conn = await mongoose
      .createConnection(uri, { dbName: "core-test-documentos" })
      .asPromise();
    // Se limpia ANTES de crear el núcleo para que los índices únicos se creen en limpio
    for (const c of COLECCIONES) await conn.db.dropCollection(c).catch(() => {});
    core = createCore({ connection: conn });
    docs = core.documentos;
    docs.registrarTipo(PROFORMA);
    await docs.listo();
  });

  after(async () => {
    for (const c of COLECCIONES) await conn.db.dropCollection(c).catch(() => {});
    await conn.close();
  });

  it("numera de forma atómica, aunque se cree en paralelo", async () => {
    const creados = await enA(async () =>
      Promise.all(Array.from({ length: 20 }, () => docs.crear({ tipo: "proforma" }))),
    );
    const codes = creados.map((d) => d.code).sort();
    assert.equal(new Set(codes).size, 20);
    assert.equal(codes[0], "DP-0000001");
    assert.equal(codes[19], "DP-0000020");
  });

  it("cada empresa lleva su propia numeración", async () => {
    const d = await enB(async () => await docs.crear({ tipo: "proforma" }));
    assert.equal(d.code, "DP-0000001");
  });

  it("crear: estado inicial, versión 1, historial y evento", async () => {
    const eventos = [];
    const f = (e) => eventos.push(e);
    docs.on("creado", f);
    const d = await enA(
      async () =>
        await docs.crear({ tipo: "proforma", snapshot: { cliente: "X" }, doc: { n: 1 }, usuarioId: u }),
    );
    docs.off("creado", f);
    assert.equal(d.estado, "borrador");
    assert.equal(d.version, 1);
    assert.deepEqual(d.payload.doc, { n: 1 });
    assert.deepEqual(d.snapshot, { cliente: "X" });
    assert.equal(d.historial.length, 1);
    assert.equal(d.historial[0].de, null);
    assert.equal(eventos.length, 1);
    assert.equal(eventos[0].documentoCode, d.code);
    assert.equal(eventos[0].tipoDocumento, "proforma");
  });

  it("transicionar: cambia el estado sin crear versión y deja historial y evento", async () => {
    await enA(async () => {
      const code = await hasta("borrador");
      const eventos = [];
      const f = (e) => eventos.push(e);
      docs.on("estado", f);
      const d = await docs.transicionar({ code, a: "cotizacion", usuarioId: u });
      docs.off("estado", f);
      assert.equal(d.estado, "cotizacion");
      assert.equal(d.version, 1);
      assert.equal(d.historial.length, 2);
      assert.equal(d.historial[1].de, "borrador");
      assert.equal(eventos.length, 1);
      assert.equal(eventos[0].datos.a, "cotizacion");
      assert.ok(eventos[0].datos.msEnEstadoAnterior >= 0);
    });
  });

  it("rechaza una transición no declarada", async () => {
    await enA(async () => {
      const code = await hasta("borrador");
      await assert.rejects(
        async () => await docs.transicionar({ code, a: "cerrada", usuarioId: u }),
        codigo("TRANSICION_INVALIDA"),
      );
    });
  });

  it("exige un motivo válido en los estados que lo declaran", async () => {
    await enA(async () => {
      const code = await hasta("cotizacion");
      await assert.rejects(
        async () => await docs.transicionar({ code, a: "rechazada", usuarioId: u }),
        codigo("MOTIVO_REQUERIDO"),
      );
      await assert.rejects(
        async () =>
          await docs.transicionar({ code, a: "rechazada", usuarioId: u, motivo: { codigo: "inventado" } }),
        codigo("MOTIVO_INVALIDO"),
      );
      const d = await docs.transicionar({
        code,
        a: "rechazada",
        usuarioId: u,
        motivo: { codigo: "precio", detalle: "pidió 10% de descuento" },
      });
      assert.equal(d.estado, "rechazada");
      assert.deepEqual(d.historial.at(-1).motivo, {
        codigo: "precio",
        detalle: "pidió 10% de descuento",
      });
    });
  });

  it("un estado final no admite más transiciones ni ediciones", async () => {
    await enA(async () => {
      const code = await hasta("borrador");
      await docs.transicionar({ code, a: "descartado", usuarioId: u, motivo: { codigo: "error" } });
      await assert.rejects(
        async () => await docs.transicionar({ code, a: "cotizacion", usuarioId: u }),
        codigo("TRANSICION_INVALIDA"),
      );
      await assert.rejects(
        async () => await docs.nuevaVersion({ code, doc: { x: 1 }, usuarioId: u }),
        codigo("ESTADO_NO_EDITABLE"),
      );
    });
  });

  it("verifica el permiso del estado destino; el sistema lo puede saltar", async () => {
    await enA(async () => {
      const code = await hasta("orden_salida");
      const intento = (permisos, extra = {}) =>
        docs.transicionar({ code, a: "en_revision", usuarioId: u, permisos, ...extra });

      await assert.rejects(async () => await intento(undefined), codigo("PERMISO_INSUFICIENTE"));
      await assert.rejects(async () => await intento(["documento:*"]), codigo("PERMISO_INSUFICIENTE"));
      const d = await intento(["estacion:revision"]);
      assert.equal(d.estado, "en_revision");

      const otro = await hasta("orden_salida");
      const s = await docs.transicionar({ code: otro, a: "en_revision", usuarioId: null, sistema: true });
      assert.equal(s.estado, "en_revision");
      assert.equal(s.historial.at(-1).sistema, true);
    });
  });

  it("nuevaVersion: guarda la anterior, sube la versión y emite el evento", async () => {
    await enA(async () => {
      const code = await hasta("cotizacion");
      const eventos = [];
      const f = (e) => eventos.push(e);
      docs.on("version", f);
      const d = await docs.nuevaVersion({ code, doc: { lineas: [1, 2] }, usuarioId: u, esperaVersion: 1 });
      docs.off("version", f);

      assert.equal(d.version, 2);
      assert.equal(d.estado, "cotizacion");
      assert.deepEqual(d.payload.doc, { lineas: [1, 2] });
      assert.equal(d.historial.length, 2); // editar no agrega movimientos de estado

      const v1 = await docs.obtener({ code, version: 1 });
      assert.deepEqual(v1.payload.doc, { lineas: [1] });
      assert.equal(eventos[0].datos.versionAnterior, 1);
      assert.equal(eventos[0].datos.versionNueva, 2);
    });
  });

  it("detecta conflicto de versión (esperaVersion y ediciones simultáneas)", async () => {
    await enA(async () => {
      const code = await hasta("cotizacion");
      await docs.nuevaVersion({ code, doc: { a: 1 }, usuarioId: u, esperaVersion: 1 });
      await assert.rejects(
        async () => await docs.nuevaVersion({ code, doc: { a: 2 }, usuarioId: u, esperaVersion: 1 }),
        codigo("CONFLICTO_VERSION"),
      );

      // Dos transiciones simultáneas desde el mismo estado: solo una puede ganar
      const code2 = await hasta("borrador");
      const r = await Promise.allSettled([
        docs.transicionar({ code: code2, a: "orden_salida", usuarioId: u }),
        docs.transicionar({ code: code2, a: "descartado", usuarioId: u, motivo: { codigo: "error" } }),
      ]);
      assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
      const perdio = r.find((x) => x.status === "rejected");
      assert.ok(["CONFLICTO_VERSION", "TRANSICION_INVALIDA"].includes(perdio.reason.codigo));
      const final = await docs.obtener({ code: code2 });
      assert.equal(final.historial.length, 2); // el perdedor no dejó rastro
    });
  });

  it("transicionar con doc: edita y cambia de estado en una sola operación", async () => {
    await enA(async () => {
      const code = await hasta("en_revision");
      const orden = [];
      const f1 = () => orden.push("version");
      const f2 = () => orden.push("estado");
      docs.on("version", f1).on("estado", f2);
      const d = await docs.transicionar({
        code,
        a: "cerrada",
        usuarioId: u,
        permisos: ["estacion:revision"],
        doc: { lineas: [1], revisado: true },
        esperaVersion: 1,
      });
      docs.off("version", f1).off("estado", f2);

      assert.equal(d.estado, "cerrada");
      assert.equal(d.version, 2);
      assert.deepEqual(d.payload.doc, { lineas: [1], revisado: true });
      assert.deepEqual(orden, ["version", "estado"]);
      assert.deepEqual((await docs.obtener({ code, version: 1 })).payload.doc, { lineas: [1] });
    });
  });

  it("si la validación falla no se guarda ninguna versión", async () => {
    await enA(async () => {
      const code = await hasta("orden_salida");
      await assert.rejects(
        async () => await docs.transicionar({ code, a: "en_revision", usuarioId: u, permisos: [], doc: { x: 1 } }),
        codigo("PERMISO_INSUFICIENTE"),
      );
      const d = await docs.obtener({ code });
      assert.equal(d.version, 1);
      assert.equal(await docs.obtener({ code, version: 1 }).then((v) => v.version), 1);
    });
  });

  it("listar filtra por tipo y estado", async () => {
    await enA(async () => {
      const cotizadas = await docs.listar({ estado: "cotizacion" });
      assert.ok(cotizadas.length > 0);
      assert.ok(cotizadas.every((d) => d.estado === "cotizacion"));
      const varias = await docs.listar({ estado: ["rechazada", "descartado"] });
      assert.ok(varias.every((d) => ["rechazada", "descartado"].includes(d.estado)));
    });
  });

  it("aísla las empresas y exige empresa activa", async () => {
    const code = await enA(async () => await hasta("borrador"));
    await enB(async () => {
      assert.equal(await docs.obtener({ code }), null);
      await assert.rejects(
        async () => await docs.transicionar({ code, a: "cotizacion", usuarioId: u }),
        codigo("DOCUMENTO_NO_ENCONTRADO"),
      );
    });
    await assert.rejects(async () => await docs.obtener({ code }), /empresa activa/);
  });

  it("un escucha que falla no rompe la operación", async () => {
    const original = console.error;
    console.error = () => {};
    const f = () => {
      throw new Error("escucha roto");
    };
    docs.on("creado", f);
    try {
      const d = await enA(async () => await docs.crear({ tipo: "proforma" }));
      assert.ok(d.code);
    } finally {
      docs.off("creado", f);
      console.error = original;
    }
  });
});
