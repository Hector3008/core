// Requiere una MongoDB real: MONGODB_URI=mongodb://localhost:27017 node --test
// ESCRITA SIN PODER CORRERLA en el entorno donde se desarrolló (no había MongoDB): su resultado no está confirmado.
// La lógica de vales se prueba sin base de datos en beneficios-servicio.test.js; aquí van los dos puntos que
// dependen de MongoDB: la actualización atómica del vale y el saldo que no queda negativo con canjes simultáneos.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { createCore } from "../src/index.js";

const uri = process.env.MONGODB_URI;
const opts = { skip: uri ? false : "define MONGODB_URI para correr esta prueba" };
const COLECCIONES = ["empresas", "usuarios", "roles", "membresias", "clientes", "documentos", "documento_versiones", "contadores", "eventos", "puntos_movimientos", "sesiones_cliente", "beneficios", "tickets", "retos", "catalogo_items"];
const ADM = { usuarioId: "0123456789abcdef01234567", permisos: ["*"] };

describe("vales contra MongoDB", opts, () => {
  let conn, core, e, c, ben;
  before(async () => {
    conn = await mongoose.createConnection(uri, { dbName: "core-test-vales" }).asPromise();
    for (const col of COLECCIONES) await conn.db.dropCollection(col).catch(() => {});
    core = createCore({ connection: conn });
    await Promise.all([core.clientes.listo(), core.fidelizacion.listo(), core.documentos.listo(), conn.model("Ticket").init()]);
    e = await core.empresas.crearEmpresa({ nombre: "Cafe Vales", slug: "vales", servicios: ["tobt"] });
    c = await core.clientes.crear({ empresaId: e._id, actor: ADM, nombre: "Ana", telefono: "987654321" });
    await core.clientes.otorgarConsentimiento({ empresaId: e._id, actor: ADM, clienteId: c.id, finalidad: "programaPuntos", medio: "presencial" });
    ben = await core.fidelizacion.beneficios.crear({ empresaId: e._id, actor: ADM, nombre: "Café gratis", puntos: 100, tipo: "item_gratis", itemCodigo: "CAFE" });
  });
  after(async () => {
    for (const col of COLECCIONES) await conn.db.dropCollection(col).catch(() => {});
    await conn.close();
  });

  it("varias cajas con el mismo código: solo una lo consume", async () => {
    await core.fidelizacion.ajustar({ empresaId: e._id, actor: ADM, clienteId: c.id, puntos: 500, detalle: "carga de prueba" });
    const { ticket } = await core.fidelizacion.tickets.emitirMio({ empresaId: e._id, clienteId: c.id, beneficioId: ben.id });
    const r = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((i) => core.fidelizacion.tickets.consumir({ empresaId: e._id, actor: ADM, codigo: ticket.codigo, uso: { itemCode: `DOC_ITEM-${i}` } })),
    );
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  });

  it("canjes simultáneos con saldo para uno: el saldo nunca queda negativo", async () => {
    const saldo0 = await core.fidelizacion.saldo({ empresaId: e._id, clienteId: c.id });
    // deja el saldo justo en 100
    if (saldo0 > 100) await core.fidelizacion.canjear({ empresaId: e._id, actor: ADM, clienteId: c.id, puntos: saldo0 - 100 });
    const r = await Promise.allSettled(
      [1, 2, 3].map(() => core.fidelizacion.tickets.emitirMio({ empresaId: e._id, clienteId: c.id, beneficioId: ben.id })),
    );
    assert.ok(r.filter((x) => x.status === "fulfilled").length <= 1);
    assert.ok((await core.fidelizacion.saldo({ empresaId: e._id, clienteId: c.id })) >= 0);
  });

  it("los vales de una empresa no se ven desde otra", async () => {
    const otra = await core.empresas.crearEmpresa({ nombre: "Otro", slug: "otro", servicios: ["tobt"] });
    const [t] = await core.fidelizacion.tickets.de({ empresaId: e._id, clienteId: c.id });
    await assert.rejects(core.fidelizacion.tickets.consultar({ empresaId: otra._id, actor: ADM, codigo: t.codigo }), { codigo: "NO_ENCONTRADO" });
  });

  it("retos: dos pagos a la vez que completan el reto dejan un solo vale (índice único)", async () => {
    await core.catalogo.crear({ empresaId: e._id, actor: ADM, codigo: "LATTE", nombre: "Latte", categoria: "Cafés", precio: 10 });
    await core.catalogo.crear({ empresaId: e._id, actor: ADM, codigo: "MOKA", nombre: "Moka", categoria: "Cafés", precio: 12 });
    await core.fidelizacion.retos.crear({ empresaId: e._id, actor: ADM, nombre: "Catador", categoria: "Cafés", tipo: "descuento_porcentaje", valor: 100 });
    const ts = new Date();
    const MovimientoPuntos = conn.model("MovimientoPuntos");
    const { conEmpresa } = await import("../src/index.js");
    await conEmpresa(e._id, async () => {
      for (const [i, codigo] of ["LATTE", "MOKA"].entries())
        await MovimientoPuntos.create({ clienteId: c.id, tipo: "acumulo", puntos: 10, itemCodigo: codigo, documentoCode: `RETO-${i}`, ts });
    });
    await Promise.all([1, 2, 3].map(() => core.fidelizacion.retos.evaluar({ empresaId: e._id, clienteId: c.id })));
    const vales = (await core.fidelizacion.tickets.de({ empresaId: e._id, clienteId: c.id })).filter((t) => t.origen === "reto");
    assert.equal(vales.length, 1);
    assert.equal(vales[0].puntos, 0);
  });
});
