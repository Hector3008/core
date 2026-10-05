// Requiere una MongoDB real: MONGODB_URI=mongodb://localhost:27017 node --test
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { createCore, conEmpresa } from "../src/index.js";

const uri = process.env.MONGODB_URI;
const opts = { skip: uri ? false : "define MONGODB_URI para correr esta prueba" };

const PROFORMA = {
  tipo: "proforma",
  prefijo: "DP",
  estadoInicial: "borrador",
  transiciones: { borrador: ["cotizacion", "descartado"], cotizacion: ["orden_salida"] },
  motivos: { descartado: ["error", "otro"] },
};
const oid = () => new mongoose.Types.ObjectId();
const COLECCIONES = ["documentos", "documento_versiones", "contadores", "eventos"];

describe("eventos", opts, () => {
  let conn, core, docs, ev;
  const A = oid();
  const B = oid();
  const u = oid();
  const enA = (fn) => conEmpresa(A, fn);
  const enB = (fn) => conEmpresa(B, fn);
  const sesion = "sesion-0001-abcd";

  before(async () => {
    conn = await mongoose.createConnection(uri, { dbName: "core-test-eventos" }).asPromise();
    for (const c of COLECCIONES) await conn.db.dropCollection(c).catch(() => {});
    core = createCore({ connection: conn });
    docs = core.documentos;
    ev = core.eventos;
    docs.registrarTipo(PROFORMA);
    await docs.listo();
    await ev.listo();
  });

  after(async () => {
    await ev.vaciar();
    for (const c of COLECCIONES) await conn.db.dropCollection(c).catch(() => {});
    await conn.close();
  });

  it("el motor alimenta la colección: creado, estado y versión", async () => {
    const code = await enA(async () => {
      const d = await docs.crear({ tipo: "proforma", doc: { n: 1 }, usuarioId: u });
      await docs.nuevaVersion({ code: d.code, doc: { n: 2 }, usuarioId: u });
      await docs.transicionar({ code: d.code, a: "cotizacion", usuarioId: u });
      return d.code;
    });
    await ev.vaciar();
    const lista = await enA(async () => await ev.listar({ documentoCode: code }));
    assert.deepEqual(lista.map((e) => e.tipo), [
      "documento.creado",
      "documento.version",
      "documento.estado",
    ]);
    assert.ok(lista.every((e) => e.origen === "servidor" && e.tipoDocumento === "proforma"));
    assert.equal(lista[2].datos.a, "cotizacion");
    assert.equal(typeof lista[2].datos.msEnEstadoAnterior, "number");
    assert.equal(String(lista[0].usuarioId), String(u));
  });

  it("el contexto aporta estación y sesión a los eventos del motor", async () => {
    const code = await enA(async () =>
      ev.conContexto({ estacion: "creacion", sesionId: sesion, usuarioId: u }, async () => {
        const d = await docs.crear({ tipo: "proforma" }); // sin usuarioId explícito
        return d.code;
      }),
    );
    await ev.vaciar();
    const [e] = await enA(async () => await ev.listar({ documentoCode: code }));
    assert.equal(e.estacion, "creacion");
    assert.equal(e.sesionId, sesion);
    assert.equal(String(e.usuarioId), String(u));
  });

  it("sin contexto, estación y sesión quedan en null; una tarea del sistema no lleva usuario", async () => {
    const code = await enA(async () => {
      const d = await docs.crear({ tipo: "proforma", usuarioId: u });
      await docs.transicionar({ code: d.code, a: "cotizacion", sistema: true });
      return d.code;
    });
    await ev.vaciar();
    const lista = await enA(async () => await ev.listar({ documentoCode: code }));
    assert.equal(lista[0].estacion, null);
    assert.equal(lista[0].sesionId, null);
    assert.equal(lista[1].usuarioId, null);
    assert.equal(lista[1].datos.sistema, true);
  });

  it("registrarLote guarda eventos de la interfaz con lo que fija el servidor", async () => {
    const r = await enA(async () =>
      ev.registrarLote({
        estacion: "revision",
        sesionId: sesion,
        usuarioId: u,
        eventos: [
          { tipo: "opcion_vista", documentoCode: "DP-0000008", version: 2, datos: { linea: 2 } },
          { tipo: "opcion_elegida", documentoCode: "DP-0000008", version: 2, datos: { linea: 2, elegida: "ZM-9600025" } },
        ],
      }),
    );
    assert.equal(r.guardados, 2);
    const lista = await enA(async () => await ev.listar({ documentoCode: "DP-0000008", estacion: "revision" }));
    assert.equal(lista.length, 2);
    assert.ok(lista.every((e) => e.origen === "interfaz" && e.sesionId === sesion));
  });

  it("un lote con un evento inválido no guarda ninguno e indica cuál", async () => {
    await assert.rejects(
      enA(async () =>
        ev.registrarLote({
          estacion: "revision",
          sesionId: sesion,
          usuarioId: u,
          eventos: [{ tipo: "ok_1", documentoCode: "DP-LOTE" }, { tipo: "documento.estado" }],
        }),
      ),
      (e) => e.codigo === "EVENTO_INVALIDO" && e.detalle.errores[0].indice === 1,
    );
    const lista = await enA(async () => await ev.listar({ documentoCode: "DP-LOTE" }));
    assert.equal(lista.length, 0);
  });

  it("límites de lote", async () => {
    const mk = (n) => Array.from({ length: n }, () => ({ tipo: "clic" }));
    const args = { estacion: "revision", sesionId: sesion, usuarioId: u };
    await assert.rejects(enA(async () => ev.registrarLote({ ...args, eventos: [] })), (e) => e.codigo === "LOTE_INVALIDO");
    await assert.rejects(enA(async () => ev.registrarLote({ ...args, eventos: mk(201) })), (e) => e.codigo === "LOTE_INVALIDO");
    assert.equal((await enA(async () => ev.registrarLote({ ...args, eventos: mk(200) }))).guardados, 200);
  });

  it("es solo de inserción: no se actualiza ni se borra por Mongoose", async () => {
    const { Evento } = core.modelos;
    await enA(async () => {
      await assert.rejects(Evento.updateMany({}, { $set: { tipo: "x" } }), (e) => e.codigo === "SOLO_INSERCION");
      await assert.rejects(Evento.deleteMany({}), (e) => e.codigo === "SOLO_INSERCION");
      await assert.rejects(Evento.findOneAndUpdate({}, { $set: { tipo: "x" } }), (e) => e.codigo === "SOLO_INSERCION");
      const uno = await Evento.findOne();
      uno.tipo = "otro";
      await assert.rejects(uno.save(), (e) => e.codigo === "SOLO_INSERCION");
    });
  });

  it("aislamiento entre empresas", async () => {
    await enB(async () =>
      ev.registrarLote({ estacion: "revision", sesionId: sesion, usuarioId: u, eventos: [{ tipo: "solo_b", documentoCode: "DP-0000008" }] }),
    );
    const enALista = await enA(async () => await ev.listar({ tipo: "solo_b" }));
    const enBLista = await enB(async () => await ev.listar({ tipo: "solo_b" }));
    assert.equal(enALista.length, 0);
    assert.equal(enBLista.length, 1);
  });

  it("sin empresa activa, falla", async () => {
    await assert.rejects(ev.listar(), /sin empresa activa/);
  });

  it("manejadorLote: 201 con datos válidos, 400 con inválidos, 401 sin autenticar", async () => {
    const h = ev.manejadorLote({ estacion: "revision" });
    const res = () => {
      const r = { codigo: null, cuerpo: null };
      r.status = (c) => ((r.codigo = c), r);
      r.json = (b) => ((r.cuerpo = b), r);
      return r;
    };
    const req = (body, auth = { usuarioId: u, empresaId: A }) => ({ auth, body, get: () => sesion });

    let r = res();
    await h(req({ eventos: [{ tipo: "clic" }] }), r, (e) => { throw e; });
    assert.equal(r.codigo, 201);
    assert.equal(r.cuerpo.guardados, 1);

    r = res();
    await h(req({ eventos: [{ tipo: "Mal Tipo" }] }), r, (e) => { throw e; });
    assert.equal(r.codigo, 400);
    assert.equal(r.cuerpo.codigo, "EVENTO_INVALIDO");

    r = res();
    await h(req({ eventos: [{ tipo: "clic" }] }, null), r, () => {});
    assert.equal(r.codigo, 401);
  });
});
