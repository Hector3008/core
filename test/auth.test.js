// Requiere una MongoDB real: MONGODB_URI=mongodb://localhost:27017 node --test
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { createCore, ErrorAuth } from "../src/index.js";
import { hashToken } from "../src/auth/tokens.js";

const uri = process.env.MONGODB_URI;
const opts = { skip: uri ? false : "define MONGODB_URI para correr esta prueba" };
const COLECCIONES = ["empresas", "usuarios", "roles", "membresias", "sesiones"];
const HORA = 3_600_000;

// req/res mínimos para probar middleware y manejadores sin levantar Express.
const req = (o = {}) => ({ method: "GET", headers: {}, body: {}, ip: "1.1.1.1", ...o });
const res = () => ({
  statusCode: 200, headers: {}, body: undefined,
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});
const cookieDe = (r) => String(r.headers["Set-Cookie"]).split(";")[0]; // "sid=token"
const corre = async (mw, rq) => {
  const rs = res();
  let siguio = false;
  await mw(rq, rs, (e) => { if (e) throw e; siguio = true; });
  return { rs, siguio };
};

describe("auth", opts, () => {
  let conn, core, auth, reloj;
  let u1, u2, u3, e1, e2;
  const PASS = "clave-segura-1";

  before(async () => {
    conn = await mongoose.createConnection(uri, { dbName: "core-test-auth" }).asPromise();
    for (const c of COLECCIONES) await conn.db.dropCollection(c).catch(() => {});
    reloj = Date.now();
    core = createCore({ connection: conn, auth: { ahora: () => reloj, intentosPorCuenta: 3 } });
    auth = core.auth;
    await auth.listo();
    e1 = await core.empresas.crearEmpresa({ nombre: "Cafe Uno", slug: "uno", servicios: ["restaurante"] });
    e2 = await core.empresas.crearEmpresa({ nombre: "Cafe Dos", slug: "dos", servicios: ["restaurante"] });
    u1 = await core.empresas.crearUsuario({ correo: "ana@x.com", password: PASS, nombre: "Ana" });
    u2 = await core.empresas.crearUsuario({ correo: "beto@x.com", password: PASS });
    u3 = await core.empresas.crearUsuario({ correo: "sin@x.com", password: PASS });
    const rol = "mesero"; // plantilla de restaurante: tiene documento:crear, no documento:borrar
    await core.empresas.agregarMiembro({ empresaId: e1._id, usuarioId: u1._id, rol });
    await core.empresas.agregarMiembro({ empresaId: e1._id, usuarioId: u2._id, rol });
    await core.empresas.agregarMiembro({ empresaId: e2._id, usuarioId: u2._id, rol });
  });
  after(async () => {
    for (const c of COLECCIONES) await conn.db.dropCollection(c).catch(() => {});
    await conn.close();
  });

  it("login correcto: una sola empresa queda activa; guarda el hash, no el token", async () => {
    const r = await auth.login({ correo: " ANA@x.com ", password: PASS, ip: "9.9.9.1" });
    assert.equal(r.empresaActivaId, String(e1._id));
    assert.equal(r.usuario.correo, "ana@x.com");
    assert.equal(r.empresas.length, 1);
    assert.equal(r.empresas[0].permisos, undefined);
    const guardada = await core.modelos.Sesion.findOne({ tokenHash: hashToken(r.token) }).lean();
    assert.ok(guardada);
    assert.ok(!JSON.stringify(guardada).includes(r.token));
    assert.equal(guardada.metodo, "password");
  });

  it("varias empresas: no hay activa hasta elegir; cambiarEmpresa valida la membresía", async () => {
    const r = await auth.login({ correo: "beto@x.com", password: PASS, ip: "9.9.9.2" });
    assert.equal(r.empresaActivaId, null);
    assert.equal(r.empresas.length, 2);
    await auth.cambiarEmpresa({ token: r.token, empresaId: String(e2._id) });
    const s = await auth.obtenerSesion(r.token);
    assert.equal(String(s.empresaActivaId), String(e2._id));
    const ana = await auth.login({ correo: "ana@x.com", password: PASS, ip: "9.9.9.3" });
    await assert.rejects(
      auth.cambiarEmpresa({ token: ana.token, empresaId: String(e2._id) }),
      (e) => e instanceof ErrorAuth && e.codigo === "SIN_ACCESO_EMPRESA" && e.status === 403,
    );
  });

  it("usuario sin empresas puede entrar pero sin empresa activa", async () => {
    const r = await auth.login({ correo: "sin@x.com", password: PASS, ip: "9.9.9.4" });
    assert.deepEqual(r.empresas, []);
    assert.equal(r.empresaActivaId, null);
  });

  it("credenciales malas: mismo error para correo inexistente, contraseña errónea y suspendido", async () => {
    const msgs = [];
    for (const [correo, password] of [["nadie@x.com", PASS], ["ana@x.com", "mala"]]) {
      await assert.rejects(auth.login({ correo, password, ip: "8.8.8.8" }), (e) => {
        msgs.push(e.message);
        return e.codigo === "CREDENCIALES_INVALIDAS" && e.status === 401;
      });
    }
    await core.modelos.Usuario.updateOne({ _id: u3._id }, { estado: "suspendido" });
    await assert.rejects(auth.login({ correo: "sin@x.com", password: PASS, ip: "8.8.8.7" }), (e) => {
      msgs.push(e.message);
      return e.codigo === "CREDENCIALES_INVALIDAS";
    });
    assert.equal(new Set(msgs).size, 1);
    await core.modelos.Usuario.updateOne({ _id: u3._id }, { estado: "activo" });
  });

  it("limita intentos: tras 3 fallos bloquea incluso con la contraseña correcta", async () => {
    for (let i = 0; i < 3; i++)
      await auth.login({ correo: "ana@x.com", password: "mala", ip: "7.7.7.7" }).catch(() => {});
    await assert.rejects(
      auth.login({ correo: "ana@x.com", password: PASS, ip: "7.7.7.7" }),
      (e) => e.codigo === "DEMASIADOS_INTENTOS" && e.status === 429 && e.detalle.reintentarEnSeg > 0,
    );
    // otra IP no está bloqueada
    await auth.login({ correo: "ana@x.com", password: PASS, ip: "7.7.7.8" });
  });

  it("datos inválidos: tipos raros no llegan a la base de datos", async () => {
    for (const body of [{}, { correo: { $ne: null }, password: PASS }, { correo: "a@x.com", password: "" }])
      await assert.rejects(auth.login(body), (e) => e.codigo === "DATOS_INVALIDOS");
  });

  it("caduca por inactividad, se renueva al usarla y respeta el tope absoluto", async () => {
    const { token } = await auth.login({ correo: "ana@x.com", password: PASS, ip: "6.6.6.1" });
    reloj += 11 * HORA;
    assert.ok(await auth.obtenerSesion(token)); // renueva (pasaron más de 5 min)
    reloj += 11 * HORA; // 22 h desde el login, 11 h desde el último uso
    assert.ok(await auth.obtenerSesion(token));
    reloj += 13 * HORA; // 13 h sin usarla
    assert.equal(await auth.obtenerSesion(token), null);
    assert.equal(await core.modelos.Sesion.countDocuments({ tokenHash: hashToken(token) }), 0);

    const b = await auth.login({ correo: "ana@x.com", password: PASS, ip: "6.6.6.2" });
    for (let i = 0; i < 70; i++) { // 70 x 11 h = 32 días
      reloj += 11 * HORA;
      if (!(await auth.obtenerSesion(b.token))) break;
    }
    assert.equal(await auth.obtenerSesion(b.token), null); // pasó 30 días aunque la usara
  });

  it("cerrarSesion y cerrarSesionesDe revocan al instante", async () => {
    const a = await auth.login({ correo: "ana@x.com", password: PASS, ip: "5.5.5.1" });
    const b = await auth.login({ correo: "ana@x.com", password: PASS, ip: "5.5.5.2" });
    assert.equal(await auth.cerrarSesion(a.token), true);
    assert.equal(await auth.obtenerSesion(a.token), null);
    assert.ok(await auth.obtenerSesion(b.token));
    assert.ok((await auth.cerrarSesionesDe(u1._id)) >= 1);
    assert.equal(await auth.obtenerSesion(b.token), null);
  });

  it("un usuario suspendido pierde la sesión sin que nadie la revoque", async () => {
    const r = await auth.login({ correo: "ana@x.com", password: PASS, ip: "4.4.4.1" });
    await core.modelos.Usuario.updateOne({ _id: u1._id }, { estado: "suspendido" });
    assert.equal(await auth.obtenerSesion(r.token), null);
    await core.modelos.Usuario.updateOne({ _id: u1._id }, { estado: "activo" });
  });

  it("autenticar: 401 sin cookie, 409 sin empresa, CSRF en POST, y deja req.auth", async () => {
    const mw = auth.autenticar();
    let { rs, siguio } = await corre(mw, req());
    assert.equal(rs.statusCode, 401);
    assert.equal(siguio, false);
    assert.match(rs.headers["Set-Cookie"], /Max-Age=0/);

    const l = res();
    await auth.manejadores.login(req({ method: "POST", headers: { "x-requested-with": "fetch" },
      body: { correo: "beto@x.com", password: PASS }, ip: "3.3.3.1" }), l, assert.ifError);
    assert.equal(l.statusCode, 200);
    assert.equal(l.body.empresaActivaId, null);
    assert.equal(JSON.stringify(l.body).includes(cookieDe(l).slice(4)), false); // el token no va en el cuerpo
    assert.match(l.headers["Set-Cookie"], /HttpOnly/);
    const headers = { cookie: cookieDe(l) };

    ({ rs, siguio } = await corre(mw, req({ headers })));
    assert.equal(rs.statusCode, 409);
    assert.equal(rs.body.codigo, "EMPRESA_NO_SELECCIONADA");
    ({ siguio } = await corre(auth.autenticar({ requiereEmpresa: false }), req({ headers })));
    assert.ok(siguio);

    ({ rs } = await corre(mw, req({ method: "POST", headers })));
    assert.equal(rs.statusCode, 403);
    assert.equal(rs.body.codigo, "CSRF");

    const e = res();
    await auth.manejadores.empresa(req({ method: "POST", headers: { ...headers, "x-requested-with": "fetch" },
      body: { empresaId: String(e1._id) } }), e, assert.ifError);
    assert.equal(e.statusCode, 200);
    assert.equal(e.body.empresaActivaId, String(e1._id));
    assert.ok(Array.isArray(e.body.permisos) && e.body.permisos.length > 0);

    const rq = req({ headers });
    ({ siguio } = await corre(mw, rq));
    assert.ok(siguio);
    assert.deepEqual(rq.auth, { usuarioId: String(u2._id), empresaId: String(e1._id) });
    assert.equal(rq.sesionAuth.metodo, "password");
  });

  it("encadena con requierePermiso: 200 con permiso y 403 sin él; logout cierra la sesión", async () => {
    const l = res();
    await auth.manejadores.login(req({ method: "POST", headers: { "x-requested-with": "fetch" },
      body: { correo: "ana@x.com", password: PASS }, ip: "2.2.2.1" }), l, assert.ifError);
    const headers = { cookie: cookieDe(l) };
    const rq = req({ headers });
    let { siguio } = await corre(auth.autenticar(), rq);
    assert.ok(siguio);
    const ok = await corre(core.requierePermiso("documento:crear"), req({ headers, auth: rq.auth }));
    assert.ok(ok.siguio);
    const r2 = await corre(core.requierePermiso("documento:borrar"), req({ headers, auth: rq.auth }));
    assert.equal(r2.rs.statusCode, 403);
    assert.equal(r2.rs.body.error, "permiso insuficiente");

    const y = res();
    await auth.manejadores.yo(req({ headers }), y, assert.ifError);
    assert.equal(y.body.usuario.correo, "ana@x.com");

    const o = res();
    await auth.manejadores.logout(req({ method: "POST", headers: { ...headers, "x-requested-with": "fetch" } }), o, assert.ifError);
    assert.equal(o.statusCode, 200);
    const despues = await corre(auth.autenticar(), req({ headers }));
    assert.equal(despues.rs.statusCode, 401);
  });
});
