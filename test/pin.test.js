// Requiere una MongoDB real: MONGODB_URI=mongodb://localhost:27017 node --test
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { createCore } from "../src/index.js";
import { hashToken } from "../src/auth/tokens.js";

const uri = process.env.MONGODB_URI;
const opts = { skip: uri ? false : "define MONGODB_URI para correr esta prueba" };
const COLECCIONES = ["empresas", "usuarios", "roles", "membresias", "sesiones", "dispositivos", "codigos_emparejamiento"];
const MIN = 60_000;

const req = (o = {}) => ({ method: "GET", headers: {}, body: {}, params: {}, ip: "1.1.1.1", ...o });
const res = () => ({
  statusCode: 200, headers: {}, body: undefined,
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});
const cookieDe = (r) => String(r.headers["Set-Cookie"]).split(";")[0];
const X = { "x-requested-with": "fetch" };
const rechaza = (p, codigo, status) =>
  assert.rejects(p, (e) => e.codigo === codigo && (status === undefined || e.status === status));

describe("PIN y dispositivos", opts, () => {
  let conn, core, a, reloj;
  let e1, e2, admin, coc, mes, otro, suspendido;
  const PASS = "clave-segura-1";
  const E = (id) => String(id);

  before(async () => {
    conn = await mongoose.createConnection(uri, { dbName: "core-test-pin" }).asPromise();
    for (const c of COLECCIONES) await conn.db.dropCollection(c).catch(() => {});
    reloj = Date.now();
    core = createCore({
      connection: conn,
      auth: { ahora: () => reloj, pinPimienta: "pimienta-de-prueba", intentosCodigoPorIp: 3 },
    });
    a = core.auth;
    await a.listo();
    e1 = await core.empresas.crearEmpresa({ nombre: "Cafe Uno", slug: "uno", servicios: ["restaurante"] });
    e2 = await core.empresas.crearEmpresa({ nombre: "Cafe Dos", slug: "dos", servicios: ["restaurante"] });
    const mk = (correo, nombre) => core.empresas.crearUsuario({ correo, password: PASS, nombre });
    admin = await mk("admin@x.com", "Admin");
    coc = await mk("coc@x.com", "Carla Cocina");
    mes = await mk("mes@x.com", "Beto Mesero");
    otro = await mk("otro@x.com", "Otro de Dos");
    suspendido = await mk("susp@x.com", "Susp");
    for (const [u, rol] of [[admin, "admin"], [coc, "cocina"], [mes, "mesero"], [suspendido, "mesero"]])
      await core.empresas.agregarMiembro({ empresaId: e1._id, usuarioId: u._id, rol });
    await core.empresas.agregarMiembro({ empresaId: e2._id, usuarioId: otro._id, rol: "mesero" });
  });
  after(async () => {
    for (const c of COLECCIONES) await conn.db.dropCollection(c).catch(() => {});
    await conn.close();
  });

  // tablet de e1 con cookie did ya emparejada (se rellena en el test de emparejar)
  let token, disp, tabletReq;

  it("apagado por defecto: sin habilitar no hay códigos ni PIN; las opciones se validan y aíslan por empresa", async () => {
    await rechaza(a.crearCodigoEmparejamiento({ empresaId: e1._id, usuarioId: admin._id, nombre: "T" }), "PIN_NO_HABILITADO", 403);
    await rechaza(a.establecerPin({ empresaId: e1._id, usuarioId: coc._id, pin: "4829" }), "PIN_NO_HABILITADO");
    for (const malo of [{ largoMin: 3 }, { maxIntentos: 2 }, { inventada: 1 }, { largoMin: 6, largoMax: 4 }, { habilitado: "si" }])
      await rechaza(a.guardarSeguridad({ empresaId: e1._id, pin: malo }), "DATOS_INVALIDOS", 400);
    const r = await a.guardarSeguridad({
      empresaId: e1._id, pin: { habilitado: true, maxIntentos: 3, bloqueoMin: 15, inactividadMin: 10, sesionMaxHoras: 12 },
    });
    assert.equal(r.pin.habilitado, true);
    assert.equal(r.pin.maxIntentos, 3);
    assert.equal(r.pin.largoMax, 6); // lo no tocado conserva su valor
    assert.equal((await a.leerSeguridad({ empresaId: e2._id })).pin.habilitado, false);
  });

  it("PIN: solo dígitos, largo según la empresa, sin repetidos ni secuencias; se guarda con hash", async () => {
    for (const pin of ["123", "1234567", "12a4", "1111", "1234", "4321", "0000", 4829, "", null])
      await rechaza(a.establecerPin({ empresaId: e1._id, usuarioId: coc._id, pin }), "PIN_INVALIDO", 400);
    await a.guardarSeguridad({ empresaId: e1._id, pin: { largoMin: 5 } });
    await rechaza(a.establecerPin({ empresaId: e1._id, usuarioId: coc._id, pin: "4829" }), "PIN_INVALIDO");
    await a.establecerPin({ empresaId: e1._id, usuarioId: coc._id, pin: "48291" });
    await a.guardarSeguridad({ empresaId: e1._id, pin: { largoMin: 4 } });
    await a.establecerPin({ empresaId: e1._id, usuarioId: coc._id, pin: "4829" });
    await a.establecerPin({ empresaId: e1._id, usuarioId: mes._id, pin: "7305" });
    await a.establecerPin({ empresaId: e1._id, usuarioId: suspendido._id, pin: "9157" });
    await rechaza(a.establecerPin({ empresaId: e1._id, usuarioId: otro._id, pin: "7305" }), "NO_ENCONTRADO", 404);
    const crudo = await core.modelos.Membresia.collection.findOne({ usuarioId: coc._id });
    assert.ok(crudo.pinHash.startsWith("scrypt$"));
    assert.ok(!JSON.stringify(crudo).includes("4829"));
  });

  it("emparejar: código de un solo uso con formato legible; se guarda el hash; caduca; límite por IP", async () => {
    const c = await a.crearCodigoEmparejamiento({ empresaId: e1._id, usuarioId: admin._id, nombre: "Tablet cocina", estacion: "cocina" });
    assert.match(c.codigo, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    const guardado = await core.modelos.CodigoEmparejamiento.collection.findOne({});
    assert.equal(guardado.codigoHash, hashToken(c.codigo.replace("-", "")));
    assert.ok(!JSON.stringify(guardado).includes(c.codigo.replace("-", "")));

    await rechaza(a.emparejar({ codigo: "ZZZZ-ZZZZ", ip: "5.5.5.1" }), "CODIGO_INVALIDO", 401);
    const r = await a.emparejar({ codigo: c.codigo.toLowerCase().replace("-", " "), ip: "5.5.5.1" }); // tolera minúsculas y separadores
    token = r.token;
    disp = r.dispositivo;
    assert.equal(r.empresa.slug, "uno");
    assert.equal(disp.estacion, "cocina");
    const d = await core.modelos.Dispositivo.collection.findOne({});
    assert.equal(d.tokenHash, hashToken(token));
    assert.ok(!JSON.stringify(d).includes(token));
    await rechaza(a.emparejar({ codigo: c.codigo, ip: "5.5.5.1" }), "CODIGO_INVALIDO"); // ya usado

    const v = await a.crearCodigoEmparejamiento({ empresaId: e1._id, usuarioId: admin._id, nombre: "Vieja" });
    reloj += 11 * MIN; // vigencia por defecto: 10 min
    await rechaza(a.emparejar({ codigo: v.codigo, ip: "5.5.5.2" }), "CODIGO_INVALIDO");

    for (let i = 0; i < 3; i++) await a.emparejar({ codigo: "AAAA-AAAA", ip: "5.5.5.3" }).catch(() => {});
    await rechaza(a.emparejar({ codigo: "AAAA-AAAA", ip: "5.5.5.3" }), "DEMASIADOS_INTENTOS", 429);

    tabletReq = (extra = {}) => req({ headers: { cookie: `did=${token}` }, ...extra });
  });

  it("la tablet ve solo a personas activas con PIN, y solo de su empresa", async () => {
    await core.modelos.Usuario.updateOne({ _id: suspendido._id }, { estado: "suspendido" });
    const ctx = await a.dispositivoDe(tabletReq());
    const p = await a.personasDe(ctx);
    assert.deepEqual(p.personas.map((x) => x.nombre), ["Beto Mesero", "Carla Cocina"]);
    assert.equal(p.empresa.slug, "uno");
    assert.deepEqual(p.config, { largoMin: 4, largoMax: 6, inactividadMin: 10 });
    assert.ok(!JSON.stringify(p).includes("@")); // no se exponen correos
    await rechaza(a.dispositivoDe(req({ headers: { cookie: "did=token-falso" } })), "DISPOSITIVO_INVALIDO", 401);
    await rechaza(a.dispositivoDe(req()), "DISPOSITIVO_INVALIDO");
    await core.modelos.Usuario.updateOne({ _id: suspendido._id }, { estado: "activo" });
  });

  it("entrar: sesión de PIN con la tablet y la empresa; errores genéricos; no entra quien no tiene PIN o es de otra empresa", async () => {
    const ctx = await a.dispositivoDe(tabletReq());
    const r = await a.entrarConPin({ contexto: ctx, usuarioId: E(coc._id), pin: "4829" });
    const s = await a.obtenerSesion(r.token);
    assert.equal(s.metodo, "pin");
    assert.equal(E(s.dispositivoId), disp.id);
    assert.equal(E(s.empresaActivaId), E(e1._id));
    assert.equal(s.inactividadMs, 10 * MIN);
    assert.equal(s.venceAbsolutoTs.getTime() - s.creadaTs.getTime(), 12 * 60 * MIN);

    const msgs = new Set();
    for (const [usuarioId, pin] of [[E(coc._id), "0001"], [E(admin._id), "4829"], [E(otro._id), "7305"]])
      await assert.rejects(a.entrarConPin({ contexto: ctx, usuarioId, pin }), (e) => {
        msgs.add(e.message);
        return e.codigo === "PIN_INCORRECTO" && e.status === 401;
      });
    assert.equal(msgs.size, 1); // sin PIN, de otra empresa o PIN malo: mismo mensaje
    await rechaza(a.entrarConPin({ contexto: ctx, usuarioId: "no-es-id", pin: "4829" }), "DATOS_INVALIDOS");
    await rechaza(a.entrarConPin({ contexto: ctx, usuarioId: E(coc._id), pin: 4829 }), "DATOS_INVALIDOS");

    // cambio de persona en la misma tablet: la sesión anterior se cierra
    const b = await a.entrarConPin({ contexto: ctx, usuarioId: E(mes._id), pin: "7305", tokenAnterior: r.token });
    assert.equal(await a.obtenerSesion(r.token), null);
    assert.ok(await a.obtenerSesion(b.token));
  });

  it("bloqueo configurable: tras maxIntentos bloquea (incluso con el PIN correcto), se libera con el tiempo y un acierto reinicia la cuenta", async () => {
    reloj += 20 * MIN; // ventana limpia del limitador por dispositivo
    const ctx = await a.dispositivoDe(tabletReq());
    const uid = E(coc._id);
    const mal = () => a.entrarConPin({ contexto: ctx, usuarioId: uid, pin: "0001" });
    await a.entrarConPin({ contexto: ctx, usuarioId: uid, pin: "4829" }); // parte de cero (la prueba anterior dejó 1 fallo)
    await rechaza(mal(), "PIN_INCORRECTO");
    await rechaza(mal(), "PIN_INCORRECTO");
    await a.entrarConPin({ contexto: ctx, usuarioId: uid, pin: "4829" }); // acierto: reinicia la cuenta
    await rechaza(mal(), "PIN_INCORRECTO");
    await rechaza(mal(), "PIN_INCORRECTO");
    await assert.rejects(mal(), (e) => e.codigo === "PIN_BLOQUEADO" && e.status === 423 && e.detalle.reintentarEnSeg === 900);
    await rechaza(a.entrarConPin({ contexto: ctx, usuarioId: uid, pin: "4829" }), "PIN_BLOQUEADO");
    // otra persona de la misma empresa no se ve afectada
    await a.entrarConPin({ contexto: ctx, usuarioId: E(mes._id), pin: "7305" });
    const lista = await a.listarUsuarios({ empresaId: e1._id });
    assert.ok(lista.find((x) => x.usuarioId === uid).bloqueadoHasta);
    reloj += 16 * MIN;
    await a.entrarConPin({ contexto: ctx, usuarioId: uid, pin: "4829" });
    // el administrador puede cambiar el bloqueo: maxIntentos 3 → 4
    await a.guardarSeguridad({ empresaId: e1._id, pin: { maxIntentos: 4 } });
    const malAhora = async () => // cada request relee la configuración de la empresa
      a.entrarConPin({ contexto: await a.dispositivoDe(tabletReq()), usuarioId: uid, pin: "0001" });
    for (let i = 0; i < 3; i++) await rechaza(malAhora(), "PIN_INCORRECTO"); // con 4 aún no bloquea
    await rechaza(malAhora(), "PIN_BLOQUEADO");
    await a.guardarSeguridad({ empresaId: e1._id, pin: { maxIntentos: 3 } });
    await a.establecerPin({ empresaId: e1._id, usuarioId: coc._id, pin: "4829" }); // restablecer también desbloquea
  });

  it("la sesión de PIN caduca por inactividad corta (según la empresa) y se renueva al usarla", async () => {
    reloj += 20 * MIN;
    const ctx = await a.dispositivoDe(tabletReq());
    const { token: t } = await a.entrarConPin({ contexto: ctx, usuarioId: E(coc._id), pin: "4829" });
    reloj += 9 * MIN;
    assert.ok(await a.obtenerSesion(t));
    reloj += 9 * MIN; // 18 min desde el login, 9 desde el último uso
    assert.ok(await a.obtenerSesion(t));
    reloj += 11 * MIN;
    assert.equal(await a.obtenerSesion(t), null);
    // con otra configuración la empresa cambia la duración
    await a.guardarSeguridad({ empresaId: e1._id, pin: { inactividadMin: 2 } });
    const ctx2 = await a.dispositivoDe(tabletReq()); // en cada request la configuración se lee de nuevo
    const { token: t2 } = await a.entrarConPin({ contexto: ctx2, usuarioId: E(coc._id), pin: "4829" });
    reloj += 3 * MIN;
    assert.equal(await a.obtenerSesion(t2), null);
    await a.guardarSeguridad({ empresaId: e1._id, pin: { inactividadMin: 10 } });
  });

  it("revocar una tablet corta sus sesiones al instante y la deja inservible; no cruza empresas", async () => {
    reloj += 20 * MIN;
    const ctx = await a.dispositivoDe(tabletReq());
    const { token: t } = await a.entrarConPin({ contexto: ctx, usuarioId: E(mes._id), pin: "7305" });
    assert.ok(await a.obtenerSesion(t));

    await a.guardarSeguridad({ empresaId: e2._id, pin: { habilitado: true } });
    const c2 = await a.crearCodigoEmparejamiento({ empresaId: e2._id, usuarioId: otro._id, nombre: "Tablet de Dos" });
    const t2 = await a.emparejar({ codigo: c2.codigo, ip: "6.6.6.1" });
    await rechaza(a.revocarDispositivo({ empresaId: e1._id, id: t2.dispositivo.id }), "NO_ENCONTRADO", 404);

    const r = await a.revocarDispositivo({ empresaId: e1._id, id: disp.id, usuarioId: admin._id });
    assert.ok(r.sesionesCerradas >= 1);
    assert.equal(await a.obtenerSesion(t), null);
    await rechaza(a.dispositivoDe(tabletReq()), "DISPOSITIVO_INVALIDO");
    await rechaza(a.revocarDispositivo({ empresaId: e1._id, id: disp.id }), "NO_ENCONTRADO");
    const lista = await a.listarDispositivos({ empresaId: e1._id });
    assert.equal(lista.length, 1);
    assert.equal(lista[0].activo, false);
    assert.equal(lista[0].tokenHash, undefined);
    assert.equal((await a.listarDispositivos({ empresaId: e2._id })).length, 1);
  });

  it("cambiar mi PIN: pide contraseña o PIN actual, cuenta los fallos y cierra las sesiones de PIN abiertas", async () => {
    reloj += 20 * MIN;
    const c = await a.crearCodigoEmparejamiento({ empresaId: e1._id, usuarioId: admin._id, nombre: "Tablet 2" });
    const nueva = await a.emparejar({ codigo: c.codigo, ip: "7.7.7.1" });
    const ctx = await a.dispositivoDe(req({ headers: { cookie: `did=${nueva.token}` } }));
    const { token: t } = await a.entrarConPin({ contexto: ctx, usuarioId: E(mes._id), pin: "7305" });

    await rechaza(a.cambiarMiPin({ empresaId: e1._id, usuarioId: mes._id, pin: "2468" }), "DATOS_INVALIDOS");
    await rechaza(a.cambiarMiPin({ empresaId: e1._id, usuarioId: mes._id, pin: "2468", password: "mala" }), "CREDENCIALES_INVALIDAS", 401);
    await rechaza(a.cambiarMiPin({ empresaId: e1._id, usuarioId: mes._id, pin: "1111", password: PASS }), "PIN_INVALIDO");
    await a.cambiarMiPin({ empresaId: e1._id, usuarioId: mes._id, pin: "2468", password: PASS });
    assert.equal(await a.obtenerSesion(t), null); // la sesión con el PIN viejo ya no vale
    await rechaza(a.entrarConPin({ contexto: ctx, usuarioId: E(mes._id), pin: "7305" }), "PIN_INCORRECTO");
    await a.cambiarMiPin({ empresaId: e1._id, usuarioId: mes._id, pin: "7305", pinActual: "2468" });
    await a.entrarConPin({ contexto: ctx, usuarioId: E(mes._id), pin: "7305" });
    await a.quitarPin({ empresaId: e1._id, usuarioId: mes._id });
    await rechaza(a.entrarConPin({ contexto: ctx, usuarioId: E(mes._id), pin: "7305" }), "PIN_INCORRECTO");
  });

  it("rutas: cada ruta de administración sale con autenticar y requierePermiso; la tablet no lleva sesión", async () => {
    const tabla = {};
    const router = new Proxy({}, { get: (_, metodo) => (ruta, ...hs) => { tabla[`${metodo.toUpperCase()} ${ruta}`] = hs; } });
    core.auth.montarRutas(router);
    const admin3 = ["GET /seguridad", "PUT /seguridad", "POST /dispositivos/codigo", "GET /dispositivos",
      "DELETE /dispositivos/:id", "GET /usuarios", "PUT /usuarios/:usuarioId/pin", "DELETE /usuarios/:usuarioId/pin"];
    for (const k of admin3) assert.equal(tabla[k]?.length, 3, k);
    assert.equal(tabla["PUT /pin"].length, 2);
    for (const k of ["POST /dispositivo/emparejar", "GET /dispositivo/personas", "POST /dispositivo/entrar", "POST /login", "GET /yo"])
      assert.equal(tabla[k]?.length, 1, k);
  });

  it("manejadores HTTP: emparejar y entrar ponen cookies, CSRF, errores con su código y /yo muestra el método", async () => {
    reloj += 20 * MIN;
    const m = a.manejadores;
    const sinCsrf = res();
    await m.emparejar(req({ method: "POST", body: { codigo: "AAAA-AAAA" } }), sinCsrf, assert.ifError);
    assert.equal(sinCsrf.statusCode, 403);
    assert.equal(sinCsrf.body.codigo, "CSRF");

    const c = res();
    await m.crearCodigo(req({ method: "POST", headers: X, body: { nombre: "Tablet HTTP", estacion: "cocina" },
      auth: { usuarioId: E(admin._id), empresaId: E(e1._id) } }), c, assert.ifError);
    assert.equal(c.statusCode, 201);

    const p = res();
    await m.emparejar(req({ method: "POST", headers: X, body: { codigo: c.body.codigo }, ip: "8.8.8.1" }), p, assert.ifError);
    assert.equal(p.statusCode, 201);
    assert.match(p.headers["Set-Cookie"], /^did=.+HttpOnly/);
    assert.match(p.headers["Set-Cookie"], /Max-Age=31536000/);
    const did = cookieDe(p);

    const l = res();
    await m.personas(req({ headers: { cookie: did } }), l, assert.ifError);
    assert.equal(l.statusCode, 200);
    assert.ok(l.body.personas.some((x) => x.nombre === "Carla Cocina"));

    const en = res();
    await m.entrar(req({ method: "POST", headers: { ...X, cookie: did }, body: { usuarioId: E(coc._id), pin: "4829" } }), en, assert.ifError);
    assert.equal(en.statusCode, 200);
    assert.match(en.headers["Set-Cookie"], /^sid=.+HttpOnly/);
    const sid = cookieDe(en);

    const y = res();
    await m.yo(req({ headers: { cookie: `${sid}; ${did}` } }), y, assert.ifError);
    assert.equal(y.body.metodo, "pin");
    assert.equal(y.body.dispositivo.estacion, "cocina");
    assert.ok(y.body.permisos.includes("estacion:cocina"));

    const mal = res();
    await m.entrar(req({ method: "POST", headers: { ...X, cookie: did }, body: { usuarioId: E(coc._id), pin: "0001" } }), mal, assert.ifError);
    assert.equal(mal.statusCode, 401);
    assert.equal(mal.body.codigo, "PIN_INCORRECTO");

    const falso = res();
    await m.entrar(req({ method: "POST", headers: { ...X, cookie: "did=falso" }, body: { usuarioId: E(coc._id), pin: "4829" } }), falso, assert.ifError);
    assert.equal(falso.statusCode, 401);
    assert.equal(falso.body.codigo, "DISPOSITIVO_INVALIDO");
    assert.match(falso.headers["Set-Cookie"], /^did=;.*Max-Age=0/); // se borra la cookie de una tablet inválida
  });
});
