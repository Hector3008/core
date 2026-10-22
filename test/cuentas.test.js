// Requiere una MongoDB real: MONGODB_URI=mongodb://localhost:27017 node --test
// ESCRITA SIN PODER CORRERLA en el entorno donde se desarrolló (no había MongoDB): su resultado no está confirmado.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { createCore, conEmpresa } from "../src/index.js";

const uri = process.env.MONGODB_URI;
const opts = { skip: uri ? false : "define MONGODB_URI para correr esta prueba" };
const COLECCIONES = ["empresas", "usuarios", "roles", "membresias", "clientes", "sesiones_cliente", "puntos_movimientos"];
const ADM = { usuarioId: "0123456789abcdef01234567", permisos: ["*"] };

describe("cuentas de cliente contra MongoDB", opts, () => {
  let conn, core, e1, e2, cc;
  before(async () => {
    conn = await mongoose.createConnection(uri, { dbName: "core-test-cuentas" }).asPromise();
    for (const c of COLECCIONES) await conn.db.dropCollection(c).catch(() => {});
    core = createCore({ connection: conn });
    cc = core.cuentasCliente;
    await Promise.all([core.clientes.listo(), cc.listo(), core.fidelizacion.listo()]);
    e1 = await core.empresas.crearEmpresa({ nombre: "Cafe Uno", slug: "uno", servicios: ["tobt"] });
    e2 = await core.empresas.crearEmpresa({ nombre: "Cafe Dos", slug: "dos", servicios: ["tobt"] });
  });
  after(async () => {
    for (const c of COLECCIONES) await conn.db.dropCollection(c).catch(() => {});
    await conn.close();
  });

  it("el hash de la contraseña no sale en ninguna consulta normal (select:false) ni en el dto", async () => {
    const f = await core.clientes.crear({ empresaId: e1._id, actor: ADM, nombre: "Ana", telefono: "987654321" });
    await cc.crearCuenta({ empresaId: e1._id, actor: ADM, clienteId: f.id, generarPassword: true });
    const c = await conEmpresa(e1._id, async () => await core.modelos.Cliente.findById(f.id).lean());
    assert.ok(c.cuenta, "tiene cuenta");
    assert.equal(c.cuenta.passwordHash, undefined);
    const conHash = await conEmpresa(e1._id, async () => await core.modelos.Cliente.findById(f.id).select("+cuenta.passwordHash").lean());
    assert.match(conHash.cuenta.passwordHash, /^scrypt\$/);
    const dto = await core.clientes.obtener({ empresaId: e1._id, clienteId: f.id });
    assert.equal(dto.tieneCuenta, true);
    assert.ok(!JSON.stringify(dto).includes("scrypt"));
  });

  it("registro, login con teléfono, sesión y aislamiento entre empresas", async () => {
    const r = await cc.registrar({ empresaId: e1._id, nombre: "Luz", telefono: "987111222", password: "Mi-clave-segura-1", quierePuntos: true, ip: "7.7.7.7" });
    assert.ok(await cc.obtenerSesion({ empresaId: e1._id, token: r.token }));
    assert.equal(await cc.obtenerSesion({ empresaId: e2._id, token: r.token }), null);
    await assert.rejects(cc.login({ empresaId: e2._id, usuario: "987111222", password: "Mi-clave-segura-1" }), (e) => e.codigo === "CREDENCIALES_INVALIDAS");
    assert.ok((await cc.login({ empresaId: e1._id, usuario: "987 111 222", password: "Mi-clave-segura-1" })).token);
    // el mismo teléfono puede tener otra cuenta en otra empresa
    const r2 = await cc.registrar({ empresaId: e2._id, nombre: "Luz otra", telefono: "987111222", password: "Otra-clave-segura-2", ip: "7.7.7.8" });
    assert.notEqual(r2.cliente.id, r.cliente.id);
  });

  it("registro con un teléfono ya fichado: bloqueado, sin ids (el índice único manda)", async () => {
    await assert.rejects(
      cc.registrar({ empresaId: e1._id, nombre: "Otra", telefono: "987111222", password: "Mi-clave-segura-1", ip: "7.7.7.9" }),
      (e) => e.codigo === "REGISTRO_BLOQUEADO" && e.detalle === undefined,
    );
  });

  it("registros simultáneos con el mismo teléfono: uno crea, los demás se bloquean", async () => {
    const rs = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        cc.registrar({ empresaId: e1._id, nombre: "Carrera", telefono: "987333444", password: "Mi-clave-segura-1", ip: `8.8.8.${i}` }),
      ),
    );
    assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
    assert.ok(rs.filter((r) => r.status === "rejected").every((r) => r.reason.codigo === "REGISTRO_BLOQUEADO"));
  });

  it("anonimizar mata la cuenta y las sesiones", async () => {
    const r = await cc.registrar({ empresaId: e1._id, nombre: "Borrar", correo: "borrar@mail.com", password: "Mi-clave-segura-1", ip: "6.6.6.6" });
    await core.clientes.anonimizar({ empresaId: e1._id, actor: ADM, clienteId: r.cliente.id });
    assert.equal(await cc.obtenerSesion({ empresaId: e1._id, token: r.token }), null);
    await assert.rejects(cc.login({ empresaId: e1._id, usuario: "borrar@mail.com", password: "Mi-clave-segura-1" }), (e) => e.codigo === "CREDENCIALES_INVALIDAS");
    const n = await conEmpresa(e1._id, async () => await core.modelos.SesionCliente.countDocuments({ clienteId: r.cliente.id }));
    assert.equal(n, 0);
  });

  it("existen el índice TTL de sesiones y el único del token", async () => {
    const idx = await conn.db.collection("sesiones_cliente").indexes();
    assert.ok(idx.find((i) => i.key.expiraTs === 1 && i.expireAfterSeconds === 0), "TTL en expiraTs");
    assert.ok(idx.find((i) => i.unique && i.key.tokenHash === 1), "token único");
  });
});
