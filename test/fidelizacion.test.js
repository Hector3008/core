// Requiere una MongoDB real: MONGODB_URI=mongodb://localhost:27017 node --test
// (el índice único parcial de idempotencia no existe en FerretDB: ver arquitectura 5.9)
// ESCRITA SIN PODER CORRERLA en el entorno donde se desarrolló (no había MongoDB): su resultado no está confirmado.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { createCore, conEmpresa } from "../src/index.js";

const uri = process.env.MONGODB_URI;
const opts = { skip: uri ? false : "define MONGODB_URI para correr esta prueba" };
const COLECCIONES = ["empresas", "usuarios", "roles", "membresias", "clientes", "documentos", "documento_versiones", "contadores", "eventos", "puntos_movimientos", "sesiones_cliente"];
const ADM = { usuarioId: "0123456789abcdef01234567", permisos: ["*"] };

describe("fidelización contra MongoDB", opts, () => {
  let conn, core, e1, e2, c1, c2;
  before(async () => {
    conn = await mongoose.createConnection(uri, { dbName: "core-test-fidelizacion" }).asPromise();
    for (const c of COLECCIONES) await conn.db.dropCollection(c).catch(() => {});
    core = createCore({ connection: conn });
    await Promise.all([core.clientes.listo(), core.fidelizacion.listo(), core.documentos.listo()]);
    e1 = await core.empresas.crearEmpresa({ nombre: "Cafe Uno", slug: "uno", servicios: ["tobt"] });
    e2 = await core.empresas.crearEmpresa({ nombre: "Cafe Dos", slug: "dos", servicios: ["tobt"] });
    c1 = await core.clientes.crear({ empresaId: e1._id, actor: ADM, nombre: "Ana", telefono: "987654321" });
    c2 = await core.clientes.crear({ empresaId: e2._id, actor: ADM, nombre: "Ana otra", telefono: "987654321" });
    await core.clientes.otorgarConsentimiento({ empresaId: e1._id, actor: ADM, clienteId: c1.id, finalidad: "programaPuntos", medio: "presencial" });
    await core.clientes.otorgarConsentimiento({ empresaId: e2._id, actor: ADM, clienteId: c2.id, finalidad: "programaPuntos", medio: "presencial" });
    core.documentos.registrarTipo({
      tipo: "pedido_prueba",
      prefijo: "PP",
      estadoInicial: "abierto",
      transiciones: { abierto: ["pagado"] },
    });
    core.fidelizacion.registrarFuente({
      tipo: "pedido_prueba",
      estado: "pagado",
      extraer: (d) => ({ clienteId: d.snapshot?.cliente?.clienteId, monto: d.payload?.doc?.total }),
    });
  });
  after(async () => {
    for (const c of COLECCIONES) await conn.db.dropCollection(c).catch(() => {});
    await conn.close();
  });

  const pagar = (empresa, clienteId, total) =>
    conEmpresa(empresa._id, async () => {
      const d = await core.documentos.crear({ tipo: "pedido_prueba", snapshot: { cliente: { clienteId } }, doc: { total } });
      await core.documentos.transicionar({ code: d.code, a: "pagado" });
      return d.code;
    });
  const esperar = () => new Promise((r) => setTimeout(r, 300));

  it("al pagar, el escucha del motor acumula; reprocesar no duplica (índice único)", async () => {
    const code = await pagar(e1, c1.id, 30.5);
    await esperar();
    assert.equal(await core.fidelizacion.saldo({ empresaId: e1._id, clienteId: c1.id }), 30);
    const otra = await core.fidelizacion.acumularPorDocumento({ empresaId: e1._id, code });
    assert.equal(otra.yaRegistrado, true);
    assert.equal(await core.fidelizacion.saldo({ empresaId: e1._id, clienteId: c1.id }), 30);
    const n = await conEmpresa(e1._id, async () => await core.modelos.MovimientoPuntos.countDocuments({ documentoCode: code }));
    assert.equal(n, 1);
  });

  it("acumulaciones simultáneas del mismo documento: una sola gana (E11000 traducido)", async () => {
    const code = await pagar(e1, c1.id, 10);
    await esperar();
    const antes = await core.fidelizacion.saldo({ empresaId: e1._id, clienteId: c1.id });
    const rs = await Promise.all(Array.from({ length: 6 }, () => core.fidelizacion.acumularPorDocumento({ empresaId: e1._id, code })));
    assert.ok(rs.every((r) => r.acumulados === 10));
    assert.equal(await core.fidelizacion.saldo({ empresaId: e1._id, clienteId: c1.id }), antes);
  });

  it("el saldo y los movimientos son por empresa (tenancy en el aggregate)", async () => {
    assert.equal(await core.fidelizacion.saldo({ empresaId: e2._id, clienteId: c2.id }), 0);
    await pagar(e2, c2.id, 7);
    await esperar();
    assert.equal(await core.fidelizacion.saldo({ empresaId: e2._id, clienteId: c2.id }), 7);
    assert.equal(await core.fidelizacion.saldo({ empresaId: e1._id, clienteId: c2.id }), 0, "un cliente de otra empresa no suma aquí");
  });

  it("canje y ajuste afectan el saldo; el libro rechaza actualizar y borrar", async () => {
    const antes = await core.fidelizacion.saldo({ empresaId: e1._id, clienteId: c1.id });
    await core.fidelizacion.canjear({ empresaId: e1._id, actor: ADM, clienteId: c1.id, puntos: 5, detalle: "Café" });
    assert.equal(await core.fidelizacion.saldo({ empresaId: e1._id, clienteId: c1.id }), antes - 5);
    await assert.rejects(
      conEmpresa(e1._id, async () => await core.modelos.MovimientoPuntos.updateMany({}, { $set: { puntos: 999 } })),
      /solo de inserción/,
    );
    await assert.rejects(conEmpresa(e1._id, async () => await core.modelos.MovimientoPuntos.deleteMany({})), /solo de inserción/);
  });

  it("existe el índice único parcial de idempotencia", async () => {
    const idx = await conn.db.collection("puntos_movimientos").indexes();
    const u = idx.find((i) => i.unique && i.key.documentoCode === 1 && i.key.tipo === 1);
    assert.ok(u, "índice único { empresaId, documentoCode, tipo }");
  });
});
