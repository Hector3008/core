// Entrar con Google el personal (5.69). Sin base de datos ni red: el token se firma con una clave RSA de prueba, las claves
// «de Google» las sirve un fetch falso y los almacenes son falsos en memoria.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { crearServicioAuth } from "../src/auth/servicio.js";
import { crearVerificadorGoogle } from "../src/cuentas/google.js";
import { hashPassword, verificarPassword } from "../src/password.js";
import { ErrorAuth } from "../src/auth/errores.js";
import { hashToken } from "../src/auth/tokens.js";

const CLIENT_ID = "1234-prueba.apps.googleusercontent.com";
const AHORA = 1_800_000_000_000;
const E1 = "aaaaaaaaaaaaaaaaaaaaaaa1";
const E2 = "aaaaaaaaaaaaaaaaaaaaaaa2";
const R1 = "bbbbbbbbbbbbbbbbbbbbbbb1";
const U = (n) => `cccccccccccccccccccccc0${n}`;

// ---------- «Google» de mentira ----------
const par = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(extra = {}, { firmarCon = par } = {}) {
  const t = Math.floor(AHORA / 1000);
  const datos = { iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "g-111", email: "ana@gmail.com", email_verified: true, name: "Ana", iat: t, exp: t + 3600, ...extra };
  const cuerpo = `${b64({ alg: "RS256", kid: "k1", typ: "JWT" })}.${b64(datos)}`;
  return `${cuerpo}.${crypto.sign("RSA-SHA256", Buffer.from(cuerpo), firmarCon.privateKey).toString("base64url")}`;
}
const verificador = () =>
  crearVerificadorGoogle({
    clientId: CLIENT_ID,
    ahora: () => AHORA,
    fetch: async () => ({ ok: true, json: async () => ({ keys: [{ ...par.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] }) }),
  });

// ---------- almacenes falsos ----------
function mundo() {
  const usuarios = [];
  const sesiones = [];
  let n = 0;
  const leer = (d, k) => k.split(".").reduce((o, p) => o?.[p], d);
  const cumple = (d, f) =>
    Object.entries(f).every(([k, v]) => {
      const x = leer(d, k);
      if (v && typeof v === "object" && "$exists" in v) return (x !== undefined) === v.$exists;
      if (v && typeof v === "object" && "$in" in v) return v.$in.map(String).includes(String(x));
      return String(x) === String(v);
    });
  const consulta = (fn) => {
    const q = { select: () => q, lean: () => q, setOptions: () => q };
    q.then = (ok, ko) => Promise.resolve().then(fn).then(ok, ko);
    return q;
  };
  const copia = (d) => (d ? structuredClone(d) : null);
  const mundo = { usuarios, sesiones, antesDeActualizar: null };
  const Usuario = {
    findOne: (f) => consulta(() => copia(usuarios.find((d) => cumple(d, f)))),
    findById: (id) => consulta(() => copia(usuarios.find((d) => d._id === String(id)))),
    async updateOne(f, cambio) {
      mundo.antesDeActualizar?.(f, cambio);
      const d = usuarios.find((x) => cumple(x, f));
      if (!d) return { matchedCount: 0, modifiedCount: 0 };
      const set = cambio.$set ?? cambio;
      if (set.google?.sub && usuarios.some((x) => x !== d && x.google?.sub === set.google.sub)) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
      Object.assign(d, structuredClone(set));
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  const Membresia = {
    find: (f) => consulta(() => mundo.membresias.filter((m) => cumple(m, f) && m.activa)),
    findOne: () => consulta(() => null),
  };
  const Empresa = {
    find: (f) => consulta(() => mundo.empresas.filter((e) => cumple(e, f))),
    findById: (id) => consulta(() => mundo.empresas.find((e) => e._id === String(id)) ?? null),
  };
  const Rol = { find: () => consulta(() => [{ _id: R1, nombre: "mesero", permisos: ["documento:leer"] }]) };
  const Sesion = {
    async create(doc) {
      const s = { _id: `ss${++n}`, ...doc };
      sesiones.push(s);
      return s;
    },
    async findOne({ tokenHash }) {
      const s = sesiones.find((x) => x.tokenHash === tokenHash);
      return s ? Object.assign(s, { $locals: {} }) : null;
    },
    async updateOne() {},
    async deleteOne() {},
    async deleteMany(f) {
      for (let i = sesiones.length - 1; i >= 0; i--) if (cumple(sesiones[i], f)) sesiones.splice(i, 1);
    },
  };
  const Dispositivo = { findOne: () => consulta(() => null), init: async () => {} };
  Object.assign(mundo, {
    empresas: [{ _id: E1, nombre: "Café Uno", slug: "uno", activa: true, servicios: [{ codigo: "tobt", activa: true }] }, { _id: E2, nombre: "Café Dos", slug: "dos", activa: true, servicios: [] }],
    membresias: [],
    modelos: { Usuario, Membresia, Rol, Empresa, Sesion, Dispositivo, CodigoEmparejamiento: { init: async () => {} } },
  });
  mundo.usuario = async (correo, extra = {}) => {
    const u = { _id: U(usuarios.length + 1), correo, nombre: correo.split("@")[0], estado: "activo", debeCambiarPassword: false, passwordHash: await hashPassword("clave-segura-1"), ...extra };
    usuarios.push(u);
    return u;
  };
  mundo.afiliar = (u, empresaId = E1) => mundo.membresias.push({ usuarioId: u._id, empresaId, rolId: R1, activa: true });
  return mundo;
}

const req = (o = {}) => ({ method: "GET", headers: { "x-requested-with": "t" }, body: {}, ip: "1.1.1.1", ...o });
const res = () => ({ statusCode: 200, headers: {}, body: undefined, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
const rechaza = (p, codigo, status) => assert.rejects(p, (e) => e instanceof ErrorAuth && e.codigo === codigo && (status === undefined || e.status === status), codigo);

describe("entrar con Google (personal)", () => {
  let m, auth;
  const montar = (google = { verificador: verificador(), clientId: CLIENT_ID }) => (auth = crearServicioAuth(m.modelos, { ahora: () => AHORA, google }));
  const entrar = (extra, ip = "1.1.1.1") => auth.entrarConGoogle({ credencial: token(extra), ip });
  beforeEach(async () => {
    m = mundo();
    montar();
  });

  it("entra quien ya existe: abre una sesión de Google, vincula el sub y una sola empresa queda activa", async () => {
    const u = await m.usuario("ana@gmail.com");
    m.afiliar(u);
    const r = await entrar();
    assert.equal(r.usuario.correo, "ana@gmail.com");
    assert.equal(r.empresaActivaId, E1);
    assert.equal(r.debeCambiarPassword, false);
    assert.equal(m.usuarios[0].google.sub, "g-111");
    assert.equal(m.sesiones.length, 1);
    assert.equal(m.sesiones[0].metodo, "google");
    assert.equal(m.sesiones[0].tokenHash, hashToken(r.token));
  });

  it("el correo de Google se compara sin importar mayúsculas", async () => {
    const u = await m.usuario("ana@gmail.com");
    m.afiliar(u);
    await entrar({ email: "ANA@Gmail.com" });
    assert.equal(m.sesiones.length, 1);
  });

  it("con varias empresas no elige ninguna: la persona la escoge después", async () => {
    const u = await m.usuario("ana@gmail.com");
    m.afiliar(u, E1);
    m.afiliar(u, E2);
    const r = await entrar();
    assert.equal(r.empresaActivaId, null);
    assert.equal(r.empresas.length, 2);
  });

  it("Google NO crea usuarios: un correo sin cuenta no entra y no deja nada", async () => {
    await rechaza(entrar({ email: "nadie@gmail.com" }), "GOOGLE_SIN_CUENTA", 403);
    assert.equal(m.usuarios.length, 0);
    assert.equal(m.sesiones.length, 0);
  });

  it("suspendido, sin empresas o con la empresa desactivada: el mismo error que sin cuenta (no se cuenta por qué)", async () => {
    const mensajes = new Set();
    const prueba = async (correo) => {
      const e = await entrar({ email: correo }).catch((x) => x);
      assert.ok(e instanceof ErrorAuth && e.codigo === "GOOGLE_SIN_CUENTA", correo);
      mensajes.add(e.message);
    };
    const s = await m.usuario("susp@gmail.com", { estado: "suspendido" });
    m.afiliar(s);
    await m.usuario("sinempresa@gmail.com");
    const d = await m.usuario("desact@gmail.com");
    m.membresias.push({ usuarioId: d._id, empresaId: "dddddddddddddddddddddddd", rolId: R1, activa: true });
    await prueba("susp@gmail.com");
    await prueba("sinempresa@gmail.com");
    await prueba("desact@gmail.com");
    await prueba("nadie@gmail.com");
    assert.equal(mensajes.size, 1);
    assert.equal(m.sesiones.length, 0);
  });

  it("una membresía dada de baja no cuenta", async () => {
    const u = await m.usuario("ana@gmail.com");
    m.membresias.push({ usuarioId: u._id, empresaId: E1, rolId: R1, activa: false });
    await rechaza(entrar(), "GOOGLE_SIN_CUENTA");
  });

  it("vinculado a una cuenta de Google, solo ella entra: otra con el mismo correo no", async () => {
    const u = await m.usuario("ana@gmail.com", { google: { sub: "g-original" } });
    m.afiliar(u);
    await rechaza(entrar({ sub: "g-otro" }), "GOOGLE_SIN_CUENTA");
    assert.equal(m.usuarios[0].google.sub, "g-original", "no se pisa");
    await entrar({ sub: "g-original" });
    assert.equal(m.sesiones.length, 1);
  });

  it("después de vincular se entra por el sub aunque el correo de Google haya cambiado", async () => {
    const u = await m.usuario("ana@gmail.com", { google: { sub: "g-111" } });
    m.afiliar(u);
    const r = await entrar({ email: "ana.nueva@gmail.com" });
    assert.equal(r.usuario.correo, "ana@gmail.com");
  });

  it("un sub que ya es de otro usuario nunca se reasigna (carrera: otro lo vincula justo antes)", async () => {
    const a = await m.usuario("a@gmail.com");
    const b = await m.usuario("b@gmail.com");
    m.afiliar(a);
    m.afiliar(b);
    // b entra con g-nuevo, pero justo antes de guardar, a se queda con ese sub
    m.antesDeActualizar = (f) => {
      if (f._id === b._id) a.google = { sub: "g-nuevo" };
    };
    await rechaza(entrar({ email: "b@gmail.com", sub: "g-nuevo" }), "GOOGLE_SIN_CUENTA");
    assert.equal(b.google, undefined);
    assert.equal(m.sesiones.length, 0);
  });

  it("carrera sobre el mismo usuario: si otra cuenta de Google lo vinculó justo antes, esta no lo pisa ni entra", async () => {
    const u = await m.usuario("ana@gmail.com");
    m.afiliar(u);
    m.antesDeActualizar = (f) => {
      if (f._id === u._id && f["google.sub"]) u.google = { sub: "g-primero" };
    };
    await rechaza(entrar({ sub: "g-segundo" }), "GOOGLE_SIN_CUENTA");
    assert.equal(u.google.sub, "g-primero");
    assert.equal(m.sesiones.length, 0);
    // y si la que llegó antes es esta misma cuenta de Google, entra normal
    m.antesDeActualizar = null;
    await entrar({ sub: "g-primero" });
    assert.equal(m.sesiones.length, 1);
  });

  it("no pasan: token de otra aplicación, correo sin verificar, caducado, firma ajena y basura", async () => {
    const u = await m.usuario("ana@gmail.com");
    m.afiliar(u);
    const otra = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    for (const t of [
      token({ aud: "otra.apps.googleusercontent.com" }),
      token({ email_verified: false }),
      token({ exp: Math.floor(AHORA / 1000) - 3600 }),
      token({}, { firmarCon: otra }),
      "abc",
      undefined,
      42,
    ])
      await rechaza(auth.entrarConGoogle({ credencial: t, ip: "2.2.2.2" }), "GOOGLE_INVALIDO", 401);
    assert.equal(m.sesiones.length, 0);
    assert.equal(m.usuarios[0].google, undefined);
  });

  it("muchos intentos fallidos desde una IP la frenan (429), también con un token bueno, y otra IP sigue pudiendo", async () => {
    const u = await m.usuario("ana@gmail.com");
    m.afiliar(u);
    montar({ verificador: verificador(), clientId: CLIENT_ID });
    for (let i = 0; i < 20; i++) await auth.entrarConGoogle({ credencial: "basura", ip: "3.3.3.3" }).catch(() => {});
    await rechaza(auth.entrarConGoogle({ credencial: token(), ip: "3.3.3.3" }), "DEMASIADOS_INTENTOS", 429);
    await entrar({}, "4.4.4.4");
    assert.equal(m.sesiones.length, 1);
  });

  it("los «sin cuenta» también cuentan para el límite (no sirve para probar correos)", async () => {
    for (let i = 0; i < 20; i++) await entrar({ email: `x${i}@gmail.com` }, "5.5.5.5").catch(() => {});
    await rechaza(entrar({ email: "y@gmail.com" }, "5.5.5.5"), "DEMASIADOS_INTENTOS");
  });

  it("sin Client ID configurado no está disponible y el login no ofrece el botón", async () => {
    const saved = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    try {
      auth = crearServicioAuth(m.modelos, { ahora: () => AHORA });
      await rechaza(auth.entrarConGoogle({ credencial: token() }), "GOOGLE_NO_DISPONIBLE", 503);
      const rs = res();
      await auth.manejadores.googleConfig(req(), rs, (e) => { throw e; });
      assert.deepEqual(rs.body, { clientId: null });
    } finally {
      if (saved !== undefined) process.env.GOOGLE_CLIENT_ID = saved;
    }
  });

  it("GET /google/config devuelve el Client ID (público) sin guardarlo en caché", async () => {
    const rs = res();
    await auth.manejadores.googleConfig(req(), rs, (e) => { throw e; });
    assert.deepEqual(rs.body, { clientId: CLIENT_ID });
    assert.equal(rs.headers["Cache-Control"], "no-store");
  });
});

describe("contraseña temporal y sesión de Google", () => {
  let m, auth;
  beforeEach(async () => {
    m = mundo();
    auth = crearServicioAuth(m.modelos, { ahora: () => AHORA, google: { verificador: verificador(), clientId: CLIENT_ID } });
  });

  it("quien tenía una contraseña temporal pendiente entra igual, sin que se la pidan cambiar, y la temporal deja de servir", async () => {
    const u = await m.usuario("ana@gmail.com", { debeCambiarPassword: true });
    m.afiliar(u);
    const r = await auth.entrarConGoogle({ credencial: token(), ip: "1.1.1.1" });
    assert.equal(r.debeCambiarPassword, false);
    assert.equal(m.usuarios[0].debeCambiarPassword, false);
    assert.equal(await verificarPassword("clave-segura-1", m.usuarios[0].passwordHash), false, "la temporal que conocía quien la dio ya no vale");
    await assert.rejects(auth.login({ correo: "ana@gmail.com", password: "clave-segura-1" }), (e) => e.codigo === "CREDENCIALES_INVALIDAS");
  });

  it("sin contraseña temporal, la contraseña de la persona no se toca", async () => {
    const u = await m.usuario("ana@gmail.com");
    m.afiliar(u);
    await auth.entrarConGoogle({ credencial: token(), ip: "1.1.1.1" });
    assert.equal(await verificarPassword("clave-segura-1", m.usuarios[0].passwordHash), true);
  });

  it("por HTTP: la sesión de Google pasa `autenticar` y /yo dice que no debe cambiar contraseña; una de contraseña con temporal sí queda bloqueada", async () => {
    const u = await m.usuario("ana@gmail.com", { debeCambiarPassword: true });
    m.afiliar(u);
    const rs = res();
    await auth.manejadores.google(req({ method: "POST", body: { credencial: token() } }), rs, (e) => { throw e; });
    assert.equal(rs.statusCode, 200);
    assert.equal(rs.body.debeCambiarPassword, false);
    const cookie = String(rs.headers["Set-Cookie"]).split(";")[0];
    assert.match(cookie, /^sid=/);

    const pasa = res();
    let siguio = false;
    await auth.autenticar()(req({ headers: { cookie, "x-requested-with": "t" } }), pasa, (e) => { if (e) throw e; siguio = true; });
    assert.equal(siguio, true);

    const yo = res();
    await auth.manejadores.yo(req({ headers: { cookie } }), yo, (e) => { throw e; });
    assert.equal(yo.body.debeCambiarPassword, false);
    assert.equal(yo.body.metodo, "google");

    // Regresión: la sesión de contraseña de alguien con temporal pendiente sigue bloqueada.
    const u2 = await m.usuario("beto@x.com", { debeCambiarPassword: true });
    m.afiliar(u2);
    const rl = res();
    await auth.manejadores.login(req({ method: "POST", body: { correo: "beto@x.com", password: "clave-segura-1" } }), rl, (e) => { throw e; });
    const cookie2 = String(rl.headers["Set-Cookie"]).split(";")[0];
    const bloqueada = res();
    await auth.autenticar()(req({ headers: { cookie: cookie2, "x-requested-with": "t" } }), bloqueada, () => assert.fail("no debió pasar"));
    assert.equal(bloqueada.statusCode, 403);
    assert.equal(bloqueada.body.codigo, "CAMBIO_PASSWORD_REQUERIDO");
  });

  it("si luego un administrador le pone otra contraseña temporal, la sesión de Google ya abierta no se bloquea", async () => {
    const u = await m.usuario("ana@gmail.com");
    m.afiliar(u);
    const rs = res();
    await auth.manejadores.google(req({ method: "POST", body: { credencial: token() } }), rs, (e) => { throw e; });
    const cookie = String(rs.headers["Set-Cookie"]).split(";")[0];
    u.debeCambiarPassword = true;
    const yo = res();
    await auth.manejadores.yo(req({ headers: { cookie } }), yo, (e) => { throw e; });
    assert.equal(yo.body.debeCambiarPassword, false);
    let siguio = false;
    await auth.autenticar()(req({ headers: { cookie, "x-requested-with": "t" } }), res(), (e) => { if (e) throw e; siguio = true; });
    assert.equal(siguio, true);
  });

  it("el manejador exige la cabecera anti-CSRF y responde con el error del servicio", async () => {
    const rs = res();
    await auth.manejadores.google(req({ method: "POST", headers: {}, body: { credencial: token() } }), rs, (e) => { throw e; });
    assert.equal(rs.statusCode, 403);
    assert.equal(rs.body.codigo, "CSRF");
    const sin = res();
    await auth.manejadores.google(req({ method: "POST", body: { credencial: token({ email: "nadie@gmail.com" }) } }), sin, (e) => { throw e; });
    assert.equal(sin.statusCode, 403);
    assert.equal(sin.body.codigo, "GOOGLE_SIN_CUENTA");
    assert.equal(sin.headers["Set-Cookie"], undefined, "sin sesión no se pone cookie");
  });
});
