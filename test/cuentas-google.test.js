// Entrar con Google (5.51). No necesita base de datos ni red: el token se firma con una clave RSA de prueba y las
// «claves públicas de Google» las sirve un fetch falso. Los almacenes son falsos en memoria.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { crearServicioCuentasCliente } from "../src/cuentas/index.js";
import { crearVerificadorGoogle } from "../src/cuentas/google.js";
import { ErrorCliente } from "../src/clientes/errores.js";
import { ErrorAuth } from "../src/auth/errores.js";
import { conEmpresa, empresaActual } from "../src/tenancy.js";

const E1 = "aaaaaaaaaaaaaaaaaaaaaaa1";
const E2 = "aaaaaaaaaaaaaaaaaaaaaaa2";
const CLIENT_ID = "1234-prueba.apps.googleusercontent.com";
const MESERO = { usuarioId: "0123456789abcdef01234568", permisos: ["cliente:leer", "cliente:crear", "cliente:cuenta"] };
const X = { "x-requested-with": "fetch" };

const rechaza = (p, Clase, codigo, status) =>
  assert.rejects(p, (e) => e instanceof Clase && e.codigo === codigo && (status === undefined || e.status === status), `${Clase.name} ${codigo}`);

// ---------- «Google» de mentira ----------
const par = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const otro = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwkDe = (p, kid) => ({ ...p.publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** Un ID token como el de Google; `claves` se firma con la clave de prueba (o con `firmarCon`). */
function token(ahora, extra = {}, { kid = "k1", firmarCon = par, alg = "RS256" } = {}) {
  const t = Math.floor(ahora / 1000);
  const datos = {
    iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "g-111", email: "ana@gmail.com", email_verified: true,
    name: "Ana Pérez", iat: t, exp: t + 3600, ...extra,
  };
  const cuerpo = `${b64({ alg, kid, typ: "JWT" })}.${b64(datos)}`;
  const firma = crypto.sign("RSA-SHA256", Buffer.from(cuerpo), firmarCon.privateKey).toString("base64url");
  return `${cuerpo}.${firma}`;
}

function googleFalso(claves = [jwkDe(par, "k1")]) {
  const g = { llamadas: 0, caido: false, claves };
  g.fetch = async () => {
    g.llamadas++;
    if (g.caido) throw new Error("sin red");
    return { ok: true, json: async () => ({ keys: g.claves }) };
  };
  return g;
}

const AHORA = 1_800_000_000_000;

// ---------- el verificador solo ----------
describe("verificador del token de Google", () => {
  let g, v;
  beforeEach(() => {
    g = googleFalso();
    v = crearVerificadorGoogle({ clientId: CLIENT_ID, fetch: g.fetch, ahora: () => AHORA });
  });
  const mal = (cred, codigo = "GOOGLE_INVALIDO") => rechaza(v.verificar(cred), ErrorAuth, codigo);

  it("acepta un token bueno y devuelve solo sub, correo (en minúsculas) y nombre", async () => {
    assert.deepEqual(await v.verificar(token(AHORA, { email: "Ana@Gmail.com" })), { sub: "g-111", correo: "ana@gmail.com", nombre: "Ana Pérez" });
    assert.deepEqual(await v.verificar(token(AHORA, { name: undefined })), { sub: "g-111", correo: "ana@gmail.com", nombre: null });
  });
  it("las claves de Google se piden una vez y se reutilizan", async () => {
    await v.verificar(token(AHORA));
    await v.verificar(token(AHORA));
    assert.equal(g.llamadas, 1);
  });
  it("rechaza una firma ajena, un token alterado y uno sin forma de JWT", async () => {
    await mal(token(AHORA, {}, { firmarCon: otro }));
    const [h, p, s] = token(AHORA).split(".");
    await mal(`${h}.${b64({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "g-999", email: "otro@gmail.com", email_verified: true, exp: AHORA / 1000 + 99 })}.${s}`);
    for (const basura of ["", "a.b", "a.b.c", "x".repeat(5000), null, undefined, 42]) await mal(basura);
  });
  it("rechaza el algoritmo «none»/HS256 (no se confía en la cabecera)", async () => {
    await mal(token(AHORA, {}, { alg: "none" }));
    await mal(token(AHORA, {}, { alg: "HS256" }));
  });
  it("rechaza emisor, audiencia, caducidad y correo no verificado", async () => {
    await mal(token(AHORA, { iss: "https://evil.example.com" }));
    await mal(token(AHORA, { aud: "otra-app.apps.googleusercontent.com" }));
    await mal(token(AHORA, { exp: Math.floor(AHORA / 1000) - 3600 }));
    await mal(token(AHORA, { iat: Math.floor(AHORA / 1000) + 3600 }));
    await mal(token(AHORA, { email_verified: false }));
    await mal(token(AHORA, { email_verified: undefined }));
    await mal(token(AHORA, { email: undefined }));
    await mal(token(AHORA, { sub: "" }));
  });
  it("acepta el emisor sin https y tolera un minuto de desfase del reloj", async () => {
    assert.equal((await v.verificar(token(AHORA, { iss: "accounts.google.com" }))).sub, "g-111");
    assert.equal((await v.verificar(token(AHORA, { exp: Math.floor(AHORA / 1000) - 30 }))).sub, "g-111");
  });
  it("un kid desconocido no hace una petición a Google por cada intento", async () => {
    await mal(token(AHORA, {}, { kid: "inventado" }));
    await mal(token(AHORA, {}, { kid: "inventado-2" }));
    await mal(token(AHORA, {}, { kid: "inventado-3" }));
    assert.ok(g.llamadas <= 2, `llamadas: ${g.llamadas}`);
  });
  it("si Google rota sus claves, el kid nuevo se aprende; si Google no responde, GOOGLE_NO_DISPONIBLE", async () => {
    await v.verificar(token(AHORA)); // caché con k1
    g.claves = [jwkDe(par, "k1"), jwkDe(otro, "k2")];
    assert.equal((await v.verificar(token(AHORA, {}, { kid: "k2", firmarCon: otro }))).sub, "g-111");
    const v2 = crearVerificadorGoogle({ clientId: CLIENT_ID, fetch: g.fetch, ahora: () => AHORA });
    g.caido = true;
    await rechaza(v2.verificar(token(AHORA)), ErrorAuth, "GOOGLE_NO_DISPONIBLE", 503);
  });
  it("sin Client ID no se puede crear", () => assert.throws(() => crearVerificadorGoogle({ clientId: " " })));
});

// ---------- el servicio ----------
function crearMundo({ referidos = null, google = true, ...opciones } = {}) {
  let ahora = AHORA;
  let n = 0;
  const docs = [];
  const sesiones = [];
  const propios = (arr) => arr.filter((d) => d.empresaId === empresaActual());
  // Camino con puntos: una lista en medio del camino se recorre («cuenta.identidades.sub»).
  const valores = (d, k) => k.split(".").reduce((os, p) => os.flatMap((o) => (Array.isArray(o?.[p]) ? o[p] : [o?.[p]])), [d]);
  const coincide = (d, f) =>
    Object.entries(f).every(([k, v]) => {
      const xs = valores(d, k);
      if (v && typeof v === "object" && !(v instanceof Date) && "$ne" in v) return xs.every((x) => (x ?? null) !== v.$ne);
      if (v === null) return xs.every((x) => x === null || x === undefined);
      return xs.some((x) => String(x) === String(v));
    });
  const poner = (d, k, v) => {
    const ps = k.split(".");
    let o = d;
    for (const p of ps.slice(0, -1)) o = o[p] ??= {};
    o[ps.at(-1)] = v;
  };
  const consulta = (fn) => {
    const q = { _sel: "" };
    q.lean = () => q;
    q.select = (s) => ((q._sel = s), q);
    q.then = (ok, ko) =>
      Promise.resolve()
        .then(() => {
          const r = fn();
          if (!r) return r;
          const c = structuredClone(r);
          if (c.cuenta && !q._sel.includes("+cuenta.passwordHash")) delete c.cuenta.passwordHash;
          return c;
        })
        .then(ok, ko);
    return q;
  };
  const Cliente = {
    docs,
    findById: (id) => consulta(() => propios(docs).find((d) => d._id === String(id)) ?? null),
    findOne: (f) => consulta(() => propios(docs).find((d) => coincide(d, f)) ?? null),
    async updateOne(f, u) {
      const d = propios(docs).find((x) => coincide(x, f));
      if (!d) return { matchedCount: 0 };
      for (const [k, v] of Object.entries(u.$set ?? {})) poner(d, k, structuredClone(v));
      for (const [k, v] of Object.entries(u.$push ?? {})) (valores(d, k.split(".").slice(0, -1).join(".")) , (d.cuenta.identidades ??= []).push(structuredClone(v)));
      return { matchedCount: 1 };
    },
  };
  const SesionCliente = {
    docs: sesiones,
    async create(doc) {
      const s = { _id: String(++n).padStart(24, "s"), empresaId: empresaActual(), ...structuredClone(doc) };
      sesiones.push(s);
      return { ...s };
    },
    init: async () => {},
  };
  const Empresa = { findById: (id) => consulta(() => ({ _id: String(id), activa: true, pais: "PE" })) };
  const clientes = {
    async crear({ empresaId, actor, nombre, telefono, correo }) {
      if (!actor.permisos.includes("cliente:crear")) throw new ErrorCliente("PERMISO_INSUFICIENTE", "sin permiso");
      return conEmpresa(empresaId, async () => {
        const mail = correo ? correo.trim().toLowerCase() : null;
        const tel = telefono ? `+51${telefono.replace(/\D/g, "")}` : null;
        for (const d of propios(docs)) {
          if (mail && d.correo === mail) throw new ErrorCliente("CLIENTE_DUPLICADO", "ya existe un cliente con ese correo");
          if (tel && d.telefono === tel) throw new ErrorCliente("CLIENTE_DUPLICADO", "ya existe un cliente con ese telefono");
        }
        const d = { _id: String(++n).padStart(24, "c"), empresaId, nombre: nombre.trim(), telefono: tel, correo: mail, activo: true, anonimizadoTs: null, cuenta: null, consentimientos: { programaPuntos: null } };
        docs.push(d);
        return { id: d._id, nombre: d.nombre, telefono: tel, correo: mail };
      });
    },
    async obtener({ empresaId, clienteId }) {
      const d = docs.find((x) => x._id === String(clienteId) && x.empresaId === String(empresaId));
      return { id: d._id, nombre: d.nombre, correo: d.correo, telefono: d.telefono, consentimientos: { programaPuntos: { otorgado: !!d.consentimientos.programaPuntos?.otorgado } } };
    },
    async cambiarConsentimiento({ clienteId, finalidad, otorgado, medio }) {
      docs.find((x) => x._id === String(clienteId)).consentimientos[finalidad] = { otorgado, medio };
    },
  };
  const fidelizacion = { resumen: async () => ({ habilitada: true, saldo: 0, movimientos: [] }) };
  const auth = { exigirCsrf: (req) => { if (req.method !== "GET" && !req.headers?.["x-requested-with"]) throw new ErrorAuth("CSRF", "falta la cabecera x-requested-with"); } };
  const g = googleFalso();
  const servicio = crearServicioCuentasCliente({ Empresa, Cliente, SesionCliente }, auth, clientes, fidelizacion, {
    ahora: () => ahora,
    ...(google ? { google: { clientId: CLIENT_ID, verificador: crearVerificadorGoogle({ clientId: CLIENT_ID, fetch: g.fetch, ahora: () => ahora }) } } : {}),
    ...opciones,
  }, referidos);
  const entrar = (extra = {}, claims = {}, e = E1) =>
    conEmpresa(e, () => servicio.entrarConGoogle({ empresaId: e, credencial: token(ahora, claims), ip: "1.1.1.1", ...extra }));
  return { servicio, Cliente, SesionCliente, clientes, g, entrar, avanzar: (ms) => (ahora += ms), ficha: (extra = {}) => clientes.crear({ empresaId: E1, actor: MESERO, nombre: "Ana Pérez", correo: "ana@gmail.com", ...extra }) };
}

describe("entrar con Google: ficha nueva", () => {
  let m;
  beforeEach(() => (m = crearMundo()));

  it("crea la ficha con el nombre y el correo de Google, una cuenta sin contraseña y abre la sesión", async () => {
    const r = await m.entrar();
    assert.equal(r.creada, true);
    assert.equal(r.cliente.nombre, "Ana Pérez");
    assert.match(r.token, /\S{20,}/);
    assert.equal(m.SesionCliente.docs.length, 1);
    const c = m.Cliente.docs[0];
    assert.equal(c.correo, "ana@gmail.com");
    assert.equal(c.cuenta.origen, "google");
    assert.equal(c.cuenta.passwordHash, undefined, "sin contraseña");
    assert.deepEqual(c.cuenta.identidades.map((i) => [i.proveedor, i.sub, i.correo]), [["google", "g-111", "ana@gmail.com"]]);
    assert.equal(c.consentimientos.programaPuntos, null, "sin consentimiento si no lo pidió");
  });
  it("sin nombre en Google usa la parte local del correo", async () => {
    await m.entrar({}, { name: undefined, email: "juan.perez@gmail.com", sub: "g-2" });
    assert.equal(m.Cliente.docs[0].nombre, "juan.perez");
  });
  it("un nombre de Google más largo que el máximo de la ficha (80) se recorta en vez de impedir entrar", async () => {
    await m.entrar({}, { name: "A".repeat(100) });
    assert.equal(m.Cliente.docs[0].nombre, "A".repeat(80));
  });
  it("quierePuntos registra el consentimiento de programaPuntos", async () => {
    await m.entrar({ quierePuntos: true });
    assert.equal(m.Cliente.docs[0].consentimientos.programaPuntos.otorgado, true);
  });
  it("la segunda vez entra a la misma ficha (no la duplica) aunque Google cambie el correo", async () => {
    const a = await m.entrar();
    const b = await m.entrar({}, { email: "ana.nueva@gmail.com" });
    assert.equal(b.creada, false);
    assert.equal(b.cliente.id, a.cliente.id);
    assert.equal(m.Cliente.docs.length, 1);
    assert.equal(m.Cliente.docs[0].correo, "ana@gmail.com", "el correo de la ficha no lo cambia Google");
  });
  it("cada empresa tiene sus propias fichas: el mismo Google en otra empresa es otra cuenta", async () => {
    await m.entrar();
    const r = await m.entrar({}, {}, E2);
    assert.equal(r.creada, true);
    assert.equal(m.Cliente.docs.length, 2);
  });
});

describe("entrar con Google: ficha que ya existe", () => {
  let m;
  beforeEach(() => (m = crearMundo()));

  it("une la ficha con ese correo (sin cuenta): le crea la cuenta sin tocar su nombre ni su consentimiento", async () => {
    const f = await m.ficha({ nombre: "Ana P." });
    const r = await m.entrar({ quierePuntos: true });
    assert.equal(r.creada, false);
    assert.equal(r.cliente.id, f.id);
    const c = m.Cliente.docs[0];
    assert.equal(c.nombre, "Ana P.");
    assert.equal(c.cuenta.origen, "google");
    assert.equal(c.consentimientos.programaPuntos, null, "un clic en el botón no cambia el consentimiento de una ficha existente");
    assert.equal(m.Cliente.docs.length, 1);
  });
  it("si ya tenía cuenta con contraseña, la conserva y suma Google", async () => {
    const f = await m.ficha();
    await conEmpresa(E1, () => m.servicio.crearCuenta({ empresaId: E1, actor: MESERO, clienteId: f.id, generarPassword: true }));
    const antes = m.Cliente.docs[0].cuenta.passwordHash;
    await m.entrar();
    const c = m.Cliente.docs[0];
    assert.equal(c.cuenta.passwordHash, antes);
    assert.equal(c.cuenta.origen, "personal");
    assert.equal(c.cuenta.identidades.length, 1);
  });
  it("una ficha vinculada a OTRA cuenta de Google no se pisa", async () => {
    await m.ficha();
    await m.entrar();
    await rechaza(m.entrar({}, { sub: "g-OTRO" }), ErrorCliente, "ESTADO_INVALIDO", 409);
    assert.equal(m.Cliente.docs[0].cuenta.identidades.length, 1);
    assert.equal(m.Cliente.docs[0].cuenta.identidades[0].sub, "g-111");
  });
  it("una ficha desactivada o anonimizada no entra ni se reutiliza", async () => {
    await m.ficha();
    const desactivada = (e) => e instanceof ErrorCliente && e.codigo === "ESTADO_INVALIDO" && /desactivada/.test(e.message);
    m.Cliente.docs[0].activo = false;
    await assert.rejects(m.entrar(), desactivada);
    m.Cliente.docs[0].activo = true;
    m.Cliente.docs[0].anonimizadoTs = new Date();
    await assert.rejects(m.entrar(), desactivada);
    assert.equal(m.SesionCliente.docs.length, 0);
    assert.equal(m.Cliente.docs.length, 1, "no crea otra ficha encima");
  });
  it("una ficha que solo tiene teléfono no se une por Google: se crea otra con el correo", async () => {
    await m.ficha({ correo: undefined, telefono: "987654321" });
    const r = await m.entrar();
    assert.equal(r.creada, true);
    assert.equal(m.Cliente.docs.length, 2);
  });
});

describe("entrar con Google: seguridad", () => {
  it("sin configurar no está disponible (503) y la carta no ve el botón", async () => {
    const m = crearMundo({ google: false });
    const prev = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    try {
      const m2 = crearMundo({ google: false });
      await rechaza(m2.entrar(), ErrorAuth, "GOOGLE_NO_DISPONIBLE", 503);
      assert.equal(m2.servicio.googleDisponible(), false);
    } finally {
      if (prev !== undefined) process.env.GOOGLE_CLIENT_ID = prev;
    }
    assert.ok(m);
  });
  it("un token falso o de otra aplicación es 401 y no crea ni ficha ni sesión", async () => {
    const m = crearMundo();
    await rechaza(m.entrar({ credencial: "basura" }), ErrorAuth, "GOOGLE_INVALIDO", 401);
    await rechaza(m.entrar({ credencial: token(AHORA, { aud: "otra" }) }), ErrorAuth, "GOOGLE_INVALIDO", 401);
    await rechaza(m.entrar({ credencial: token(AHORA, { email_verified: false }) }), ErrorAuth, "GOOGLE_INVALIDO", 401);
    assert.equal(m.Cliente.docs.length, 0);
    assert.equal(m.SesionCliente.docs.length, 0);
  });
  it("un correo sin verificar NO se une a la ficha existente (nadie se apropia de los puntos de otro)", async () => {
    const m = crearMundo();
    await m.ficha();
    await rechaza(m.entrar({ credencial: token(AHORA, { email_verified: false }) }), ErrorAuth, "GOOGLE_INVALIDO");
    assert.equal(m.Cliente.docs[0].cuenta, null);
  });
  it("demasiados tokens inválidos desde una IP la bloquean (429); los buenos de otra IP siguen", async () => {
    const m = crearMundo({ googleFallosPorIp: 3 });
    for (let i = 0; i < 3; i++) await rechaza(m.entrar({ credencial: "basura" }), ErrorAuth, "GOOGLE_INVALIDO");
    await rechaza(m.entrar({ credencial: token(AHORA) }), ErrorAuth, "DEMASIADOS_INTENTOS", 429);
    assert.equal((await m.entrar({ ip: "2.2.2.2" })).creada, true);
  });
  it("una cuenta que solo entra con Google no puede entrar con contraseña, ni cambiarla", async () => {
    const m = crearMundo();
    const r = await m.entrar();
    for (const password of ["", "cualquiera-123", "undefined", "null"])
      await rechaza(conEmpresa(E1, () => m.servicio.login({ empresaId: E1, usuario: "ana@gmail.com", password: password || "x", ip: "9.9.9.9" })), ErrorAuth, "CREDENCIALES_INVALIDAS", 401);
    await rechaza(conEmpresa(E1, () => m.servicio.cambiarPassword({ empresaId: E1, clienteId: r.cliente.id, passwordActual: "algo-largo-123", passwordNueva: "otra-larga-456" })), ErrorAuth, "SIN_PASSWORD", 409);
  });
  it("dos primeras entradas simultáneas crean una sola ficha", async () => {
    const m = crearMundo();
    const [a, b] = await Promise.all([m.entrar(), m.entrar()]);
    assert.equal(m.Cliente.docs.length, 1);
    assert.equal(a.cliente.id, b.cliente.id);
  });
});

describe("entrar con Google: referidos", () => {
  const referidosFalso = (habilitada = true) => ({
    config: async () => ({ habilitada }),
    buscarPorCodigo: async ({ codigo }) => (codigo === "ABC2345" ? { id: "ref" } : null),
    vincular: async function (a) { this.llamadas.push(a); },
    llamadas: [],
  });
  it("un código válido en una ficha nueva vincula al referido; uno inválido avisa antes de crear nada", async () => {
    const referidos = referidosFalso();
    const m = crearMundo({ referidos });
    await rechaza(m.entrar({ codigoReferido: "NOEXISTE" }), ErrorCliente, "DATOS_INVALIDOS", 400);
    assert.equal(m.Cliente.docs.length, 0);
    await m.entrar({ codigoReferido: "ABC2345" });
    assert.equal(referidos.llamadas.length, 1);
    assert.equal(referidos.llamadas[0].origen, "registro");
  });
  it("una ficha que ya existía no recibe referente por un código en el botón", async () => {
    const referidos = referidosFalso();
    const m = crearMundo({ referidos });
    await m.ficha();
    await m.entrar({ codigoReferido: "ABC2345" });
    assert.equal(referidos.llamadas.length, 0);
  });
});

describe("manejador HTTP y yo", () => {
  const req = (o = {}) => ({ method: "POST", headers: { ...X }, body: {}, ip: "1.1.1.1", ...o });
  const res = () => ({ statusCode: 200, headers: {}, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } });
  const llamar = async (m, nombre, r) => {
    const out = res();
    await m.servicio.manejadores({ empresaDe: async () => ({ id: E1, slug: "cafe" }) })[nombre](r, out, (e) => { throw e; });
    return out;
  };

  it("POST google: 201 con la cuenta nueva y cookie de sesión; 200 al volver; exige x-requested-with", async () => {
    const m = crearMundo();
    const sinCsrf = await llamar(m, "google", req({ headers: {}, body: { credencial: token(AHORA) } }));
    assert.equal(sinCsrf.body.codigo, "CSRF");
    const a = await llamar(m, "google", req({ body: { credencial: token(AHORA), quierePuntos: true } }));
    assert.equal(a.statusCode, 201);
    assert.match(a.headers["Set-Cookie"], /^cs_cafe=/);
    assert.equal(a.body.sesion, true);
    assert.equal(a.body.cliente.correo, "ana@gmail.com");
    assert.equal(a.body.cliente.programaPuntos, true);
    assert.equal((await llamar(m, "google", req({ body: { credencial: token(AHORA) } }))).statusCode, 200);
    const mala = await llamar(m, "google", req({ body: { credencial: "x" } }));
    assert.deepEqual([mala.statusCode, mala.body.codigo], [401, "GOOGLE_INVALIDO"]);
  });
  it("sin sesión, `yo` dice el Client ID solo si Google está activado", async () => {
    const con = await llamar(crearMundo(), "yo", req({ method: "GET", headers: {} }));
    assert.deepEqual(con.body, { sesion: false, google: { clientId: CLIENT_ID } });
    const prev = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    try {
      const sin = await llamar(crearMundo({ google: false }), "yo", req({ method: "GET", headers: {} }));
      assert.deepEqual(sin.body, { sesion: false });
    } finally {
      if (prev !== undefined) process.env.GOOGLE_CLIENT_ID = prev;
    }
  });
});
