// Requiere una MongoDB real: MONGODB_URI=mongodb://localhost:27017 node --test
// Fija la forma de GET /auth/yo (es el contrato de `cuenta`) y la ruta de preferencias.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { createCore } from "../src/index.js";

const uri = process.env.MONGODB_URI;
const opts = {
  skip: uri ? false : "define MONGODB_URI para correr esta prueba",
};
const COLECCIONES = [
  "empresas",
  "usuarios",
  "roles",
  "membresias",
  "sesiones",
  "dispositivos",
  "codigos_emparejamiento",
];

const req = (o = {}) => ({
  method: "GET",
  headers: {},
  body: {},
  params: {},
  ip: "1.1.1.1",
  ...o,
});
const res = () => ({
  statusCode: 200,
  headers: {},
  body: undefined,
  setHeader(k, v) {
    this.headers[k] = v;
  },
  status(c) {
    this.statusCode = c;
    return this;
  },
  json(b) {
    this.body = b;
    return this;
  },
});
const cookieDe = (r) => String(r.headers["Set-Cookie"]).split(";")[0];
const X = { "x-requested-with": "fetch" };

describe("GET /auth/yo y preferencias", opts, () => {
  let conn, core, a;
  let e1, e2, ana, beto, sinEmpresa;
  const PASS = "clave-segura-1";

  before(async () => {
    conn = await mongoose
      .createConnection(uri, { dbName: "core-test-yo" })
      .asPromise();
    for (const c of COLECCIONES)
      await conn.db.dropCollection(c).catch(() => {});
    core = createCore({
      connection: conn,
      auth: { pinPimienta: "pimienta-de-prueba" },
    });
    a = core.auth;
    await a.listo();
    e1 = await core.empresas.crearEmpresa({
      nombre: "Cafe Uno",
      slug: "uno",
      servicios: ["restaurante"],
    });
    e2 = await core.empresas.crearEmpresa({
      nombre: "Tienda Dos",
      slug: "dos",
      servicios: ["siscore"],
    });
    ana = await core.empresas.crearUsuario({
      correo: "ana@x.com",
      password: PASS,
      nombre: "Ana",
    });
    beto = await core.empresas.crearUsuario({
      correo: "beto@x.com",
      password: PASS,
      nombre: "Beto",
    });
    sinEmpresa = await core.empresas.crearUsuario({
      correo: "sin@x.com",
      password: PASS,
      nombre: "Sin",
    });
    await core.empresas.agregarMiembro({
      empresaId: e1._id,
      usuarioId: ana._id,
      rol: "mesero",
    });
    await core.empresas.agregarMiembro({
      empresaId: e1._id,
      usuarioId: beto._id,
      rol: "mesero",
    });
    await core.empresas.agregarMiembro({
      empresaId: e2._id,
      usuarioId: beto._id,
      rol: "admin",
    });
  });
  after(async () => {
    for (const c of COLECCIONES)
      await conn.db.dropCollection(c).catch(() => {});
    await conn.close();
  });

  async function entrar(correo, ip) {
    const l = res();
    await a.manejadores.login(
      req({ method: "POST", headers: X, body: { correo, password: PASS }, ip }),
      l,
      assert.ifError,
    );
    assert.equal(l.statusCode, 200);
    return cookieDe(l);
  }
  async function yo(cookie) {
    const y = res();
    await a.manejadores.yo(req({ headers: { cookie } }), y, assert.ifError);
    assert.equal(y.statusCode, 200);
    return y.body;
  }
  async function preferencias(cookie, body, headers = X) {
    const p = res();
    await a.manejadores.preferencias(
      req({ method: "PUT", headers: { ...headers, cookie }, body }),
      p,
      assert.ifError,
    );
    return p;
  }

  it("la forma de /yo: lo que el front necesita y nada más (contrato de cuenta)", async () => {
    const cookie = await entrar("ana@x.com", "3.3.3.1");
    const y = await yo(cookie);
    assert.deepEqual(Object.keys(y).sort(), [
      "debeCambiarPassword",
      "dispositivo",
      "empresaActivaId",
      "empresas",
      "metodo",
      "paginaPrincipal",
      "permisos",
      "pinHabilitado",
      "servicios",
      "tienePin",
      "usuario",
    ]);
    assert.equal(y.usuario.correo, "ana@x.com");
    assert.equal(y.empresaActivaId, String(e1._id));
    assert.deepEqual(y.servicios, ["restaurante"]);
    assert.equal(y.paginaPrincipal, null);
    assert.equal(y.pinHabilitado, false);
    assert.equal(y.tienePin, false);
    assert.equal(y.empresas.length, 1);
    assert.equal(y.empresas[0].permisos, undefined); // los permisos solo van de la empresa activa
    assert.ok(y.permisos.includes("documento:crear"));
  });

  it("sin empresa activa: servicios vacíos y sin PIN; con varias, cambia al elegir", async () => {
    const solo = await yo(await entrar("sin@x.com", "3.3.3.2"));
    assert.equal(solo.empresaActivaId, null);
    assert.deepEqual(solo.servicios, []);
    assert.equal(solo.pinHabilitado, false);

    const cookie = await entrar("beto@x.com", "3.3.3.3");
    const antes = await yo(cookie);
    assert.equal(antes.empresaActivaId, null);
    assert.deepEqual(antes.servicios, []);

    const el = res();
    await a.manejadores.empresa(
      req({
        method: "POST",
        headers: { ...X, cookie },
        body: { empresaId: String(e2._id) },
      }),
      el,
      assert.ifError,
    );
    assert.deepEqual(el.body.servicios, ["siscore"]);
    assert.ok(el.body.permisos.includes("*"));
    await a.manejadores.empresa(
      req({
        method: "POST",
        headers: { ...X, cookie },
        body: { empresaId: String(e1._id) },
      }),
      el,
      assert.ifError,
    );
    assert.deepEqual(el.body.servicios, ["restaurante"]);
  });

  it("un servicio desactivado en la empresa no aparece en /yo", async () => {
    await core.modelos.Empresa.updateOne(
      { _id: e2._id },
      {
        servicios: [
          { codigo: "siscore", activa: false },
          { codigo: "restaurante", activa: true },
        ],
      },
    );
    const cookie = await entrar("beto@x.com", "3.3.3.4");
    const el = res();
    await a.manejadores.empresa(
      req({
        method: "POST",
        headers: { ...X, cookie },
        body: { empresaId: String(e2._id) },
      }),
      el,
      assert.ifError,
    );
    assert.deepEqual(el.body.servicios, ["restaurante"]);
    await core.modelos.Empresa.updateOne(
      { _id: e2._id },
      { servicios: [{ codigo: "siscore", activa: true }] },
    );
  });

  it("pinHabilitado y tienePin salen de la empresa activa y de la membresía de la persona", async () => {
    await a.guardarSeguridad({ empresaId: e1._id, pin: { habilitado: true } });
    const cookie = await entrar("ana@x.com", "3.3.3.5");
    let y = await yo(cookie);
    assert.equal(y.pinHabilitado, true);
    assert.equal(y.tienePin, false);
    await a.establecerPin({
      empresaId: e1._id,
      usuarioId: ana._id,
      pin: "4829",
    });
    y = await yo(cookie);
    assert.equal(y.tienePin, true);
    assert.equal(JSON.stringify(y).includes("pinHash"), false); // nunca el hash
    // el PIN es por empresa: Beto, sin PIN en la empresa 1, no hereda el de Ana
    const b = await yo(
      await entrar("beto@x.com", "3.3.3.6").then(async (c) => {
        const el = res();
        await a.manejadores.empresa(
          req({
            method: "POST",
            headers: { ...X, cookie: c },
            body: { empresaId: String(e1._id) },
          }),
          el,
          assert.ifError,
        );
        return c;
      }),
    );
    assert.equal(b.tienePin, false);
  });

  it("guardar paginaPrincipal: queda en /yo, es de la persona (no cambia a otra) y null la quita", async () => {
    const cookie = await entrar("ana@x.com", "3.3.3.7");
    const p = await preferencias(cookie, {
      paginaPrincipal: "restaurante.pedidos",
    });
    assert.equal(p.statusCode, 200);
    assert.deepEqual(p.body, { paginaPrincipal: "restaurante.pedidos" });
    assert.equal((await yo(cookie)).paginaPrincipal, "restaurante.pedidos");

    const otra = await yo(await entrar("sin@x.com", "3.3.3.8"));
    assert.equal(otra.paginaPrincipal, null);

    const q = await preferencias(cookie, { paginaPrincipal: null });
    assert.equal(q.statusCode, 200);
    assert.equal((await yo(cookie)).paginaPrincipal, null);
    const guardado = await core.modelos.Usuario.findById(ana._id).lean();
    assert.equal("paginaPrincipal" in guardado, false); // se quita, no queda en null
  });

  it("rechaza formatos inválidos sin tocar lo guardado, exige x-requested-with y sesión", async () => {
    const cookie = await entrar("ana@x.com", "3.3.3.9");
    await preferencias(cookie, { paginaPrincipal: "perfil" });
    for (const malo of [
      "https://malo.com",
      "/restaurante/pedidos",
      "Perfil",
      7,
      { $ne: null },
      undefined,
    ]) {
      const p = await preferencias(cookie, { paginaPrincipal: malo });
      assert.equal(p.statusCode, 400, String(malo));
      assert.equal(p.body.codigo, "DATOS_INVALIDOS");
    }
    assert.equal((await yo(cookie)).paginaPrincipal, "perfil");

    const sinCabecera = await preferencias(
      cookie,
      { paginaPrincipal: "perfil" },
      {},
    );
    assert.equal(sinCabecera.statusCode, 403);
    assert.equal(sinCabecera.body.codigo, "CSRF");

    const sinSesion = res();
    await a.manejadores.preferencias(
      req({ method: "PUT", headers: X, body: { paginaPrincipal: "perfil" } }),
      sinSesion,
      assert.ifError,
    );
    assert.equal(sinSesion.statusCode, 401);
  });

  it("con contraseña temporal pendiente no se pueden guardar preferencias", async () => {
    await core.modelos.Usuario.updateOne(
      { _id: beto._id },
      { debeCambiarPassword: true },
    );
    const cookie = await entrar("beto@x.com", "3.3.3.10");
    assert.equal((await yo(cookie)).debeCambiarPassword, true); // /yo sí responde: es lo que decide la pantalla
    const p = await preferencias(cookie, { paginaPrincipal: "perfil" });
    assert.equal(p.statusCode, 403);
    assert.equal(p.body.codigo, "CAMBIO_PASSWORD_REQUERIDO");
    await core.modelos.Usuario.updateOne(
      { _id: beto._id },
      { debeCambiarPassword: false },
    );
  });
});
