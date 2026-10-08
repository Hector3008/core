// Requiere una MongoDB real: MONGODB_URI=mongodb://localhost:27017 node --test
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { createCore } from "../src/index.js";

const uri = process.env.MONGODB_URI;
const opts = { skip: uri ? false : "define MONGODB_URI para correr esta prueba" };
const COLECCIONES = ["empresas", "usuarios", "roles", "membresias", "sesiones", "dispositivos", "codigos_emparejamiento"];

const req = (o = {}) => ({ method: "GET", headers: {}, body: {}, params: {}, query: {}, ip: "2.2.2.2", ...o });
const res = () => ({
  statusCode: 200, headers: {}, body: undefined,
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});
const X = { "x-requested-with": "fetch" };
const rechaza = (p, codigo, status) =>
  assert.rejects(p, (e) => e.codigo === codigo && (status === undefined || e.status === status));

describe("gestión de empleados", opts, () => {
  let conn, core, a, emp;
  let e1, e2, e3;
  let admin, admin2, enc, coc, otroDe2, solo3;
  const PASS = "clave-segura-1";
  const ADM = (u) => ({ usuarioId: String(u._id), permisos: ["*"] });
  let AD; // actor admin de e1
  let ENC; // actor encargado de e1

  before(async () => {
    conn = await mongoose.createConnection(uri, { dbName: "core-test-empleados" }).asPromise();
    for (const c of COLECCIONES) await conn.db.dropCollection(c).catch(() => {});
    core = createCore({ connection: conn, auth: { pinPimienta: "pimienta-de-prueba" } });
    a = core.auth;
    emp = core.empleados;
    await a.listo();
    e1 = await core.empresas.crearEmpresa({ nombre: "Cafe Uno", slug: "uno", servicios: ["restaurante"] });
    e2 = await core.empresas.crearEmpresa({ nombre: "Cafe Dos", slug: "dos", servicios: ["restaurante"] });
    e3 = await core.empresas.crearEmpresa({ nombre: "Cafe Tres", slug: "tres", servicios: ["restaurante"] });
    const mk = (correo, nombre) => core.empresas.crearUsuario({ correo, password: PASS, nombre });
    admin = await mk("admin@x.com", "Admin");
    admin2 = await mk("admin2@x.com", "Admin Dos");
    enc = await mk("enc@x.com", "Encargada");
    coc = await mk("coc@x.com", "Carla Cocina");
    otroDe2 = await mk("otro2@x.com", "Otro de Dos");
    solo3 = await mk("solo3@x.com", "Unico Admin");
    await core.empresas.agregarMiembro({ empresaId: e1._id, usuarioId: admin._id, rol: "admin" });
    await core.empresas.agregarMiembro({ empresaId: e1._id, usuarioId: admin2._id, rol: "admin" });
    await core.empresas.agregarMiembro({ empresaId: e1._id, usuarioId: coc._id, rol: "cocina" });
    await core.empresas.agregarMiembro({ empresaId: e2._id, usuarioId: otroDe2._id, rol: "mesero" });
    await core.empresas.agregarMiembro({ empresaId: e3._id, usuarioId: solo3._id, rol: "admin" });
    AD = ADM(admin);
    await a.guardarSeguridad({ empresaId: e1._id, pin: { habilitado: true } });
    // un rol de encargado creado por el admin, y una persona con él
    await emp.crearRol({
      empresaId: e1._id, actor: AD, nombre: "encargado",
      permisos: ["usuario:gestionar", "rol:gestionar", "estacion:cocina", "estacion:carta", "documento:*"],
    });
    await emp.crearEmpleado({
      empresaId: e1._id, actor: AD, nombre: "Encargada", correo: "enc.nueva@x.com", rol: "encargado", password: PASS + "xx",
    });
    // se usa la cuenta `enc` ya creada: se añade como encargada
    await emp.crearEmpleado({ empresaId: e1._id, actor: AD, correo: "enc@x.com", rol: "encargado" });
    ENC = { usuarioId: String(enc._id), permisos: ["usuario:gestionar", "rol:gestionar", "estacion:cocina", "estacion:carta", "documento:*"] };
  });
  after(async () => {
    for (const c of COLECCIONES) await conn.db.dropCollection(c).catch(() => {});
    await conn.close();
  });

  // ---------- alta ----------
  it("alta con contraseña temporal: entra, queda obligada a cambiarla y después ya opera", async () => {
    const r = await emp.crearEmpleado({
      empresaId: e1._id, actor: AD, nombre: "Beto Mesero", correo: "Beto@X.com", telefono: "987 654 321",
      rol: "mesero", password: "temporal-12345",
    });
    assert.equal(r.correo, "beto@x.com");
    assert.equal(r.rol, "mesero");
    assert.equal(r.usuarioExistente, false);
    assert.equal(r.passwordTemporal, null, "una contraseña que dio el admin no se devuelve");
    const f = await emp.obtener({ empresaId: e1._id, usuarioId: r.usuarioId });
    assert.equal(f.telefono, "987 654 321");
    assert.equal(f.passwordTemporalPendiente, true);

    const l = res();
    await a.manejadores.login(req({ method: "POST", headers: X, body: { correo: "beto@x.com", password: "temporal-12345" } }), l, () => {});
    assert.equal(l.statusCode, 200);
    assert.equal(l.body.debeCambiarPassword, true);
    const cookie = String(l.headers["Set-Cookie"]).split(";")[0];

    // Una ruta normal queda bloqueada
    const r1 = res();
    let paso = false;
    await core.autenticar()(req({ headers: { cookie } }), r1, () => (paso = true));
    assert.equal(paso, false);
    assert.equal(r1.statusCode, 403);
    assert.equal(r1.body.codigo, "CAMBIO_PASSWORD_REQUERIDO");
    // /yo sí responde y lo avisa
    const yo = res();
    await a.manejadores.yo(req({ headers: { cookie } }), yo, () => {});
    assert.equal(yo.statusCode, 200);
    assert.equal(yo.body.debeCambiarPassword, true);
    // contraseña actual mal, nueva floja
    const m1 = res();
    await a.manejadores.cambiarPassword(req({ method: "POST", headers: { ...X, cookie }, body: { passwordActual: "mala", passwordNueva: "nueva-clave-larga" } }), m1, () => {});
    assert.equal(m1.body.codigo, "CREDENCIALES_INVALIDAS");
    const m2 = res();
    await a.manejadores.cambiarPassword(req({ method: "POST", headers: { ...X, cookie }, body: { passwordActual: "temporal-12345", passwordNueva: "corta" } }), m2, () => {});
    assert.equal(m2.body.codigo, "DATOS_INVALIDOS");
    // sin cabecera CSRF
    const m3 = res();
    await a.manejadores.cambiarPassword(req({ method: "POST", headers: { cookie }, body: { passwordActual: "temporal-12345", passwordNueva: "nueva-clave-larga" } }), m3, () => {});
    assert.equal(m3.body.codigo, "CSRF");
    // cambio correcto
    const m4 = res();
    await a.manejadores.cambiarPassword(req({ method: "POST", headers: { ...X, cookie }, body: { passwordActual: "temporal-12345", passwordNueva: "nueva-clave-larga" } }), m4, () => {});
    assert.equal(m4.statusCode, 200);
    // ahora la misma sesión ya pasa
    let paso2 = false;
    await core.autenticar()(req({ headers: { cookie } }), res(), () => (paso2 = true));
    assert.equal(paso2, true);
    // la contraseña vieja ya no sirve; la nueva sí
    await rechaza(a.login({ correo: "beto@x.com", password: "temporal-12345", ip: "9.9.9.1" }), "CREDENCIALES_INVALIDAS");
    const nuevo = await a.login({ correo: "beto@x.com", password: "nueva-clave-larga", ip: "9.9.9.2" });
    assert.equal(nuevo.debeCambiarPassword, false);
    assert.equal((await emp.obtener({ empresaId: e1._id, usuarioId: r.usuarioId })).passwordTemporalPendiente, false);
  });

  it("cambiar la contraseña cierra las demás sesiones pero no la actual", async () => {
    const u = await core.empresas.crearUsuario({ correo: "multi@x.com", password: PASS, nombre: "Multi" });
    await core.empresas.agregarMiembro({ empresaId: e1._id, usuarioId: u._id, rol: "mesero" });
    const s1 = await a.login({ correo: "multi@x.com", password: PASS, ip: "9.9.8.1" });
    const s2 = await a.login({ correo: "multi@x.com", password: PASS, ip: "9.9.8.2" });
    const ses = await a.obtenerSesion(s1.token);
    const r = await a.cambiarPassword({ usuarioId: u._id, passwordActual: PASS, passwordNueva: "otra-clave-larga-1", sesionId: ses._id });
    assert.equal(r.sesionesCerradas, 1);
    assert.ok(await a.obtenerSesion(s1.token));
    assert.equal(await a.obtenerSesion(s2.token), null);
    await rechaza(a.cambiarPassword({ usuarioId: u._id, passwordActual: "otra-clave-larga-1", passwordNueva: "otra-clave-larga-1" }), "DATOS_INVALIDOS");
  });

  it("alta con contraseña generada: se devuelve una vez y funciona", async () => {
    const r = await emp.crearEmpleado({ empresaId: e1._id, actor: AD, nombre: "Gen", correo: "gen@x.com", rol: "cocina", generarPassword: true });
    assert.equal(r.passwordTemporal.length, 12);
    const l = await a.login({ correo: "gen@x.com", password: r.passwordTemporal, ip: "9.9.7.1" });
    assert.equal(l.debeCambiarPassword, true);
    await rechaza(
      emp.crearEmpleado({ empresaId: e1._id, actor: AD, nombre: "X", correo: "x1@x.com", rol: "cocina", generarPassword: true, password: "otra-clave-larga" }),
      "DATOS_INVALIDOS",
    );
  });

  it("alta solo con PIN: no hay contraseña utilizable y entra por la tablet", async () => {
    const r = await emp.crearEmpleado({ empresaId: e1._id, actor: AD, nombre: "Pedro Pin", correo: "pedro.pin@x.com", rol: "cocina", pin: "2580" });
    assert.equal(r.tienePin, true);
    assert.equal(r.passwordTemporal, null);
    const f = await emp.obtener({ empresaId: e1._id, usuarioId: r.usuarioId });
    assert.equal(f.tienePin, true);
    assert.equal(f.passwordTemporalPendiente, false);
    await rechaza(a.login({ correo: "pedro.pin@x.com", password: "", ip: "9.9.6.1" }), "DATOS_INVALIDOS");
    await rechaza(a.login({ correo: "pedro.pin@x.com", password: "cualquier-cosa-1", ip: "9.9.6.1" }), "CREDENCIALES_INVALIDAS");
    // tablet
    const { codigo } = await a.crearCodigoEmparejamiento({ empresaId: e1._id, usuarioId: admin._id, nombre: "Tablet cocina" });
    const t = await a.emparejar({ codigo, ip: "9.9.6.2" });
    const contexto = await a.dispositivoDe({ headers: { cookie: `did=${t.token}` } });
    const ses = await a.entrarConPin({ contexto, usuarioId: r.usuarioId, pin: "2580" });
    assert.ok(ses.token);
    assert.equal(ses.empresaActivaId, String(e1._id));
  });

  it("alta con las dos: contraseña temporal y PIN", async () => {
    const r = await emp.crearEmpleado({
      empresaId: e1._id, actor: AD, nombre: "Dos Vías", correo: "dosvias@x.com", rol: "mesero", password: "temporal-dos-vias", pin: "1357",
    });
    assert.equal(r.tienePin, true);
    const f = await emp.obtener({ empresaId: e1._id, usuarioId: r.usuarioId });
    assert.equal(f.tienePin, true);
    assert.equal(f.passwordTemporalPendiente, true);
    assert.ok(await a.login({ correo: "dosvias@x.com", password: "temporal-dos-vias", ip: "9.9.5.1" }));
  });

  it("alta: validaciones previas, sin dejar nada a medias", async () => {
    const A = (o) => emp.crearEmpleado({ empresaId: e1._id, actor: AD, nombre: "Z", rol: "mesero", password: "temporal-12345", ...o });
    await rechaza(A({ correo: "no-es-correo" }), "DATOS_INVALIDOS", 400);
    await rechaza(A({ correo: "z1@x.com", nombre: "" }), "DATOS_INVALIDOS");
    await rechaza(A({ correo: "z2@x.com", password: "corta" }), "DATOS_INVALIDOS");
    await rechaza(emp.crearEmpleado({ empresaId: e1._id, actor: AD, nombre: "Z", correo: "z3@x.com", rol: "mesero" }), "DATOS_INVALIDOS"); // sin forma de entrar
    await rechaza(A({ correo: "z4@x.com", rol: "no-existe" }), "NO_ENCONTRADO", 404);
    await rechaza(A({ correo: "z5@x.com", pin: "1234" }), "PIN_INVALIDO"); // secuencia
    await rechaza(A({ correo: "z6@x.com", pin: "12" }), "PIN_INVALIDO");
    await rechaza(A({ correo: "z7@x.com", telefono: "abc" }), "DATOS_INVALIDOS");
    await rechaza(emp.crearEmpleado({ empresaId: e2._id, actor: ADM(admin), nombre: "Z", correo: "z8@x.com", rol: "mesero", pin: "2580" }), "PIN_NO_HABILITADO", 403);
    await rechaza(emp.crearEmpleado({ empresaId: e1._id, nombre: "Z", correo: "z9@x.com", rol: "mesero", password: "temporal-12345" }), "SIN_ALCANCE");
    for (const c of ["z1", "z2", "z3", "z4", "z5", "z6", "z7", "z8", "z9", "no-es-correo"])
      assert.equal(await core.modelos.Usuario.countDocuments({ correo: `${c}@x.com` }), 0, `${c} no debe haberse creado`);
    // ya es empleado
    await rechaza(A({ correo: "coc@x.com" }), "DATOS_INVALIDOS"); // existe: no se le fija contraseña
    await rechaza(emp.crearEmpleado({ empresaId: e1._id, actor: AD, correo: "coc@x.com", rol: "mesero" }), "YA_ES_MIEMBRO", 409);
  });

  it("correo que ya existe en otra empresa: se añade con su cuenta, sin tocar su contraseña ni su nombre", async () => {
    const antes = await core.modelos.Usuario.findById(otroDe2._id).select("+passwordHash").lean();
    const r = await emp.crearEmpleado({ empresaId: e1._id, actor: AD, nombre: "Nombre Distinto", correo: "otro2@x.com", rol: "mesero", telefono: "999 111 222" });
    assert.equal(r.usuarioExistente, true);
    assert.equal(r.nombre, "Otro de Dos", "no se pisa el nombre global");
    const despues = await core.modelos.Usuario.findById(otroDe2._id).select("+passwordHash").lean();
    assert.equal(despues.passwordHash, antes.passwordHash);
    assert.equal(despues.debeCambiarPassword ?? false, false);
    assert.ok(await a.login({ correo: "otro2@x.com", password: PASS, ip: "9.9.4.1" }), "su contraseña de siempre sigue valiendo");
    // el teléfono es de esta empresa; la otra no lo ve
    assert.equal((await emp.obtener({ empresaId: e1._id, usuarioId: String(otroDe2._id) })).telefono, "999 111 222");
    assert.equal((await emp.obtener({ empresaId: e2._id, usuarioId: String(otroDe2._id) })).telefono, null);
    // con PIN sí se puede (es por empresa)
    await emp.establecerPin({ empresaId: e1._id, actor: AD, usuarioId: String(otroDe2._id), pin: "2468" });
    assert.equal((await emp.obtener({ empresaId: e1._id, usuarioId: String(otroDe2._id) })).tienePin, true);
    assert.equal((await emp.obtener({ empresaId: e2._id, usuarioId: String(otroDe2._id) })).tienePin, false);
  });

  it("lo compartido entre empresas no se toca desde una sola: nombre y contraseña", async () => {
    const id = String(otroDe2._id);
    await rechaza(emp.actualizar({ empresaId: e1._id, actor: AD, usuarioId: id, nombre: "Cambiado" }), "COMPARTIDO", 409);
    await rechaza(emp.restablecerPassword({ empresaId: e1._id, actor: AD, usuarioId: id, generarPassword: true }), "COMPARTIDO", 409);
    const f = await emp.actualizar({ empresaId: e1._id, actor: AD, usuarioId: id, telefono: "999 000 111" });
    assert.equal(f.telefono, "999 000 111");
    assert.equal(f.nombre, "Otro de Dos");
  });

  // ---------- listar, ficha, actualizar ----------
  it("listar: solo la empresa activa; ficha sin datos de otras empresas", async () => {
    const l1 = await emp.listar({ empresaId: e1._id });
    const l2 = await emp.listar({ empresaId: e2._id });
    assert.ok(l1.some((f) => f.correo === "coc@x.com" && f.rol === "cocina"));
    assert.ok(!l1.some((f) => f.correo === "solo3@x.com"));
    assert.deepEqual(l2.map((f) => f.correo), ["otro2@x.com"]);
    assert.ok(l1.every((f) => !("passwordHash" in f) && !("pinHash" in f)));
    await rechaza(emp.obtener({ empresaId: e2._id, usuarioId: String(coc._id) }), "NO_ENCONTRADO", 404);
    await rechaza(emp.obtener({ empresaId: e1._id, usuarioId: "no-es-id" }), "DATOS_INVALIDOS");
    // ordenados por nombre
    const nombres = l1.map((f) => f.nombre ?? f.correo);
    assert.deepEqual(nombres, [...nombres].sort((x, y) => x.localeCompare(y)));
  });

  it("actualizar nombre (persona de una sola empresa) y teléfono", async () => {
    const f = await emp.actualizar({ empresaId: e1._id, actor: AD, usuarioId: String(coc._id), nombre: "Carla C.", telefono: "955 111 222" });
    assert.equal(f.nombre, "Carla C.");
    assert.equal(f.telefono, "955 111 222");
    assert.equal((await emp.actualizar({ empresaId: e1._id, actor: AD, usuarioId: String(coc._id), telefono: null })).telefono, null);
    await rechaza(emp.actualizar({ empresaId: e1._id, actor: AD, usuarioId: String(coc._id) }), "DATOS_INVALIDOS");
  });

  // ---------- alcance: nadie toca lo que no tiene ----------
  it("un encargado no puede ascenderse ni tocar a un admin", async () => {
    const A1 = String(admin._id);
    await rechaza(emp.crearEmpleado({ empresaId: e1._id, actor: ENC, nombre: "N", correo: "n1@x.com", rol: "admin", password: "temporal-12345" }), "SIN_ALCANCE", 403);
    await rechaza(emp.cambiarRol({ empresaId: e1._id, actor: ENC, usuarioId: String(coc._id), rol: "admin" }), "SIN_ALCANCE");
    await rechaza(emp.cambiarRol({ empresaId: e1._id, actor: ENC, usuarioId: A1, rol: "mesero" }), "SIN_ALCANCE");
    await rechaza(emp.cambiarRol({ empresaId: e1._id, actor: ENC, usuarioId: String(enc._id), rol: "mesero" }), "SIN_ALCANCE"); // el suyo
    await rechaza(emp.establecerPin({ empresaId: e1._id, actor: ENC, usuarioId: A1, pin: "2580" }), "SIN_ALCANCE");
    await rechaza(emp.quitarPin({ empresaId: e1._id, actor: ENC, usuarioId: A1 }), "SIN_ALCANCE");
    await rechaza(emp.restablecerPassword({ empresaId: e1._id, actor: ENC, usuarioId: A1, generarPassword: true }), "SIN_ALCANCE");
    await rechaza(emp.desactivar({ empresaId: e1._id, actor: ENC, usuarioId: A1 }), "SIN_ALCANCE");
    await rechaza(emp.actualizar({ empresaId: e1._id, actor: ENC, usuarioId: A1, telefono: "999 999 999" }), "SIN_ALCANCE");
    // «mesero» trae permisos que el encargado no tiene (catalogo:leer, cliente:leer): tampoco puede darlo
    await rechaza(emp.cambiarRol({ empresaId: e1._id, actor: ENC, usuarioId: String(coc._id), rol: "mesero" }), "SIN_ALCANCE");
    // lo que sí puede: asignar un rol cuyos permisos él tiene
    await emp.crearRol({ empresaId: e1._id, actor: AD, nombre: "apoyo", permisos: ["estacion:cocina", "documento:leer"] });
    const f = await emp.cambiarRol({ empresaId: e1._id, actor: ENC, usuarioId: String(coc._id), rol: "apoyo" });
    assert.equal(f.rol, "apoyo");
    await emp.cambiarRol({ empresaId: e1._id, actor: AD, usuarioId: String(coc._id), rol: "cocina" });
  });

  it("cambiar de rol rige de inmediato en requierePermiso", async () => {
    const id = String(coc._id);
    const pide = async (permiso) => {
      const r = res();
      let paso = false;
      await core.requierePermiso(permiso)({ auth: { usuarioId: id, empresaId: String(e1._id) } }, r, () => (paso = true));
      return paso;
    };
    assert.equal(await pide("estacion:cocina"), true);
    assert.equal(await pide("estacion:carta"), false);
    await emp.cambiarRol({ empresaId: e1._id, actor: AD, usuarioId: id, rol: "mesero" });
    assert.equal(await pide("estacion:cocina"), false);
    assert.equal(await pide("estacion:carta"), true);
    await emp.cambiarRol({ empresaId: e1._id, actor: AD, usuarioId: id, rol: "cocina" });
  });

  // ---------- roles ----------
  it("roles propios: validación, alcance, protección del admin", async () => {
    const R = (actor, o) => emp.crearRol({ empresaId: e1._id, actor, ...o });
    const ok = await R(AD, { nombre: "barista", permisos: ["estacion:carta", "documento:leer", "documento:leer"] });
    assert.deepEqual(ok.permisos, ["estacion:carta", "documento:leer"]);
    assert.equal(ok.protegido, false);
    await rechaza(R(AD, { nombre: "barista", permisos: [] }), "ROL_DUPLICADO", 409);
    await rechaza(R(AD, { nombre: "Admin", permisos: ["*"] }), "ROL_PROTEGIDO");
    await rechaza(R(AD, { nombre: "malo", permisos: ["Documento:Crear"] }), "PERMISO_INVALIDO", 400);
    await rechaza(R(AD, { nombre: "malo", permisos: "documento:crear" }), "DATOS_INVALIDOS");
    // el encargado no da lo que no tiene
    await rechaza(R(ENC, { nombre: "poderoso", permisos: ["*"] }), "SIN_ALCANCE", 403);
    await rechaza(R(ENC, { nombre: "poderoso", permisos: ["catalogo:escribir"] }), "SIN_ALCANCE");
    await rechaza(R(ENC, { nombre: "poderoso", permisos: ["empresa:seguridad"] }), "SIN_ALCANCE");
    const delEnc = await R(ENC, { nombre: "runner", permisos: ["estacion:cocina", "documento:leer"] });
    assert.equal(delEnc.nombre, "runner");
    // el admin no se edita ni se borra
    const roles = await emp.listarRoles({ empresaId: e1._id });
    const rolAdmin = roles.find((r) => r.nombre === "admin");
    assert.equal(rolAdmin.protegido, true);
    assert.equal(rolAdmin.empleados, 2);
    await rechaza(emp.editarRol({ empresaId: e1._id, actor: AD, rolId: rolAdmin.id, permisos: ["documento:leer"] }), "ROL_PROTEGIDO", 403);
    await rechaza(emp.editarRol({ empresaId: e1._id, actor: AD, rolId: rolAdmin.id, nombre: "jefe" }), "ROL_PROTEGIDO");
    await rechaza(emp.eliminarRol({ empresaId: e1._id, actor: AD, rolId: rolAdmin.id }), "ROL_PROTEGIDO");
    // editar y borrar
    const barista = roles.find((r) => r.nombre === "barista");
    const ed = await emp.editarRol({ empresaId: e1._id, actor: AD, rolId: barista.id, nombre: "barista senior", permisos: ["estacion:carta"] });
    assert.equal(ed.nombre, "barista senior");
    assert.deepEqual(ed.permisos, ["estacion:carta"]);
    await rechaza(emp.editarRol({ empresaId: e1._id, actor: AD, rolId: barista.id, nombre: "mesero" }), "ROL_DUPLICADO");
    await rechaza(emp.editarRol({ empresaId: e1._id, actor: AD, rolId: barista.id }), "DATOS_INVALIDOS");
    await rechaza(emp.editarRol({ empresaId: e1._id, actor: AD, rolId: "no-es-id", nombre: "x" }), "DATOS_INVALIDOS");
    // el encargado no edita un rol con permisos que no tiene
    const rolMesero = roles.find((r) => r.nombre === "mesero");
    await emp.editarRol({ empresaId: e1._id, actor: AD, rolId: rolMesero.id, permisos: [...rolMesero.permisos, "catalogo:escribir"] });
    await rechaza(emp.editarRol({ empresaId: e1._id, actor: ENC, rolId: rolMesero.id, permisos: ["documento:leer"] }), "SIN_ALCANCE");
    await emp.editarRol({ empresaId: e1._id, actor: AD, rolId: rolMesero.id, permisos: rolMesero.permisos });
    // en uso no se borra; libre sí
    const rolCocina = roles.find((r) => r.nombre === "cocina");
    await rechaza(emp.eliminarRol({ empresaId: e1._id, actor: AD, rolId: rolCocina.id }), "ROL_EN_USO", 409);
    assert.deepEqual(await emp.eliminarRol({ empresaId: e1._id, actor: AD, rolId: barista.id }), { ok: true });
    await rechaza(emp.eliminarRol({ empresaId: e1._id, actor: AD, rolId: barista.id }), "NO_ENCONTRADO", 404);
    // los roles son por empresa
    assert.ok(!(await emp.listarRoles({ empresaId: e2._id })).some((r) => r.nombre === "runner"));
  });

  // ---------- último admin ----------
  it("la empresa siempre conserva un admin activo", async () => {
    const OTRO = { usuarioId: String(admin._id), permisos: ["*"] }; // quien pide no es el objetivo
    const id = String(solo3._id);
    await rechaza(emp.desactivar({ empresaId: e3._id, actor: OTRO, usuarioId: id }), "ULTIMO_ADMIN", 409);
    await rechaza(emp.cambiarRol({ empresaId: e3._id, actor: OTRO, usuarioId: id, rol: "cocina" }), "ULTIMO_ADMIN");
    // con dos admins, uno puede irse
    const r = await emp.crearEmpleado({ empresaId: e3._id, actor: ADM(solo3), nombre: "Segundo", correo: "segundo3@x.com", rol: "admin", password: "temporal-12345" });
    await emp.desactivar({ empresaId: e3._id, actor: ADM(solo3), usuarioId: r.usuarioId });
    await rechaza(emp.desactivar({ empresaId: e3._id, actor: OTRO, usuarioId: id }), "ULTIMO_ADMIN");
    // y nadie se da de baja a sí mismo
    await rechaza(emp.desactivar({ empresaId: e1._id, actor: AD, usuarioId: String(admin._id) }), "SIN_ALCANCE");
  });

  // ---------- baja y reactivación ----------
  it("baja: cierra sesiones, quita el PIN, conserva al empleado; reactivar lo devuelve", async () => {
    const al = await emp.crearEmpleado({ empresaId: e1._id, actor: AD, nombre: "Baja Prueba", correo: "baja@x.com", rol: "cocina", password: "temporal-12345", pin: "2580" });
    const id = al.usuarioId;
    const s = await a.login({ correo: "baja@x.com", password: "temporal-12345", ip: "9.9.3.1" });
    assert.equal(s.empresaActivaId, String(e1._id));
    const { codigo } = await a.crearCodigoEmparejamiento({ empresaId: e1._id, usuarioId: admin._id, nombre: "Tablet baja" });
    const t = await a.emparejar({ codigo, ip: "9.9.3.2" });
    const contexto = await a.dispositivoDe({ headers: { cookie: `did=${t.token}` } });
    const sp = await a.entrarConPin({ contexto, usuarioId: id, pin: "2580" });
    assert.ok(await a.obtenerSesion(s.token));
    assert.ok(await a.obtenerSesion(sp.token));

    const r = await emp.desactivar({ empresaId: e1._id, actor: AD, usuarioId: id });
    assert.equal(r.sesionesCerradas, 2);
    assert.equal(await a.obtenerSesion(s.token), null);
    assert.equal(await a.obtenerSesion(sp.token), null);
    await rechaza(a.entrarConPin({ contexto, usuarioId: id, pin: "2580" }), "PIN_INCORRECTO");
    // la membresía inactiva corta el acceso
    const q = res();
    let paso = false;
    await core.requierePermiso("estacion:cocina")({ auth: { usuarioId: id, empresaId: String(e1._id) } }, q, () => (paso = true));
    assert.equal(paso, false);
    assert.equal(q.statusCode, 403);
    // no sale en la lista normal; sí con inactivos; la cuenta sigue existiendo (documentos y eventos la referencian)
    assert.ok(!(await emp.listar({ empresaId: e1._id })).some((f) => f.usuarioId === id));
    const inact = (await emp.listar({ empresaId: e1._id, incluirInactivos: true })).find((f) => f.usuarioId === id);
    assert.equal(inact.activa, false);
    assert.equal(inact.tienePin, false);
    assert.ok(await core.modelos.Usuario.findById(id));
    await rechaza(emp.desactivar({ empresaId: e1._id, actor: AD, usuarioId: id }), "ESTADO_INVALIDO", 409);
    await rechaza(emp.cambiarRol({ empresaId: e1._id, actor: AD, usuarioId: id, rol: "mesero" }), "ESTADO_INVALIDO");
    await rechaza(emp.crearEmpleado({ empresaId: e1._id, actor: AD, correo: "baja@x.com", rol: "cocina" }), "YA_ES_MIEMBRO");

    const re = await emp.reactivar({ empresaId: e1._id, actor: AD, usuarioId: id });
    assert.equal(re.activa, true);
    assert.equal(re.rol, "cocina");
    assert.equal(re.tienePin, false, "el PIN se quitó en la baja y hay que fijarlo de nuevo");
    assert.ok(await a.login({ correo: "baja@x.com", password: "temporal-12345", ip: "9.9.3.3" }));
    await rechaza(emp.reactivar({ empresaId: e1._id, actor: AD, usuarioId: id }), "ESTADO_INVALIDO");
  });

  it("la baja en una empresa no cierra la sesión de la misma persona en otra", async () => {
    const id = String(otroDe2._id);
    const s = await a.login({ correo: "otro2@x.com", password: PASS, ip: "9.9.2.1" });
    await a.cambiarEmpresa({ token: s.token, empresaId: String(e2._id) });
    await emp.desactivar({ empresaId: e1._id, actor: AD, usuarioId: id });
    assert.ok(await a.obtenerSesion(s.token), "su sesión de e2 sigue viva");
    await emp.reactivar({ empresaId: e1._id, actor: AD, usuarioId: id });
  });

  // ---------- restablecer contraseña ----------
  it("restablecer contraseña: temporal nueva, sesiones cerradas, obligada a cambiarla", async () => {
    const id = String(coc._id);
    const s = await a.login({ correo: "coc@x.com", password: PASS, ip: "9.9.1.1" });
    const r = await emp.restablecerPassword({ empresaId: e1._id, actor: AD, usuarioId: id, generarPassword: true });
    assert.equal(r.passwordTemporal.length, 12);
    assert.ok(r.sesionesCerradas >= 1);
    assert.equal(await a.obtenerSesion(s.token), null);
    await rechaza(a.login({ correo: "coc@x.com", password: PASS, ip: "9.9.1.2" }), "CREDENCIALES_INVALIDAS");
    const l = await a.login({ correo: "coc@x.com", password: r.passwordTemporal, ip: "9.9.1.3" });
    assert.equal(l.debeCambiarPassword, true);
    const r2 = await emp.restablecerPassword({ empresaId: e1._id, actor: AD, usuarioId: id, password: "otra-temporal-larga" });
    assert.equal(r2.passwordTemporal, null);
    await rechaza(emp.restablecerPassword({ empresaId: e1._id, actor: AD, usuarioId: id, password: "corta" }), "DATOS_INVALIDOS");
    await rechaza(emp.restablecerPassword({ empresaId: e1._id, actor: AD, usuarioId: id }), "DATOS_INVALIDOS");
    await rechaza(emp.restablecerPassword({ empresaId: e1._id, actor: AD, usuarioId: String(admin._id), generarPassword: true }), "SIN_ALCANCE"); // la propia: /auth/password
  });

  it("una sesión de PIN no puede cambiar la contraseña", async () => {
    const al = await emp.crearEmpleado({ empresaId: e1._id, actor: AD, nombre: "Solo Pin", correo: "solopin@x.com", rol: "cocina", pin: "2580" });
    const { codigo } = await a.crearCodigoEmparejamiento({ empresaId: e1._id, usuarioId: admin._id, nombre: "Tablet 9" });
    const t = await a.emparejar({ codigo, ip: "9.9.0.1" });
    const contexto = await a.dispositivoDe({ headers: { cookie: `did=${t.token}` } });
    const sp = await a.entrarConPin({ contexto, usuarioId: al.usuarioId, pin: "2580" });
    const r = res();
    await a.manejadores.cambiarPassword(
      req({ method: "POST", headers: { ...X, cookie: `sid=${sp.token}` }, body: { passwordActual: "x", passwordNueva: "una-clave-larga-1" } }),
      r, () => {},
    );
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.codigo, "SESION_NO_PERMITIDA");
  });

  // ---------- HTTP ----------
  it("manejadores HTTP: 201, secreto sin caché, CSRF, errores con su status", async () => {
    const rq = (o) => req({ method: "POST", headers: X, auth: { usuarioId: String(admin._id), empresaId: String(e1._id) }, rol: { permisos: ["*"] }, ...o });
    const m = emp.manejadores;
    const c = res();
    await m.crear(rq({ body: { nombre: "Http Uno", correo: "http1@x.com", rol: "mesero", generarPassword: true, pin: "2580" } }), c, () => {});
    assert.equal(c.statusCode, 201);
    assert.equal(c.headers["Cache-Control"], "no-store");
    assert.equal(c.body.passwordTemporal.length, 12);
    // sin cabecera CSRF
    const x = res();
    await m.crear(rq({ headers: {}, body: { nombre: "N", correo: "http2@x.com", rol: "mesero", generarPassword: true } }), x, () => {});
    assert.equal(x.statusCode, 403);
    assert.equal(x.body.codigo, "CSRF");
    // datos inválidos, rol inexistente, sin alcance
    const d = res();
    await m.crear(rq({ body: { nombre: "N", correo: "mal", rol: "mesero", generarPassword: true } }), d, () => {});
    assert.equal(d.statusCode, 400);
    const n = res();
    await m.crear(rq({ body: { nombre: "N", correo: "http3@x.com", rol: "no-existe", generarPassword: true } }), n, () => {});
    assert.equal(n.statusCode, 404);
    const s = res();
    await m.crear(rq({ rol: { permisos: ["usuario:gestionar"] }, body: { nombre: "N", correo: "http4@x.com", rol: "admin", generarPassword: true } }), s, () => {});
    assert.equal(s.statusCode, 403);
    assert.equal(s.body.codigo, "SIN_ALCANCE");
    // un error que no es nuestro va a next
    let siguiente;
    await m.obtener(req({ auth: { empresaId: "no-es-id" }, params: { usuarioId: c.body.usuarioId } }), res(), (e) => (siguiente = e));
    assert.ok(siguiente);
    // listar y roles
    const l = res();
    await m.listar(req({ auth: { empresaId: String(e1._id) } }), l, () => {});
    assert.equal(l.statusCode, 200);
    assert.ok(l.body.empleados.some((f) => f.correo === "http1@x.com"));
    const ro = res();
    await m.crearRol(rq({ body: { nombre: "http-rol", permisos: ["estacion:carta"] } }), ro, () => {});
    assert.equal(ro.statusCode, 201);
    const ro2 = res();
    await m.editarRol(rq({ method: "PUT", params: { rolId: ro.body.id }, body: { permisos: ["estacion:cocina"] } }), ro2, () => {});
    assert.deepEqual(ro2.body.permisos, ["estacion:cocina"]);
    const ro3 = res();
    await m.eliminarRol(rq({ method: "DELETE", params: { rolId: ro.body.id } }), ro3, () => {});
    assert.equal(ro3.statusCode, 200);
    // PIN y baja por HTTP
    const p = res();
    await m.establecerPin(rq({ method: "PUT", params: { usuarioId: c.body.usuarioId }, body: { pin: "1470" } }), p, () => {});
    assert.equal(p.statusCode, 200);
    const b = res();
    await m.desactivar(rq({ params: { usuarioId: c.body.usuarioId } }), b, () => {});
    assert.equal(b.statusCode, 200);
    const rr = res();
    await m.reactivar(rq({ params: { usuarioId: c.body.usuarioId } }), rr, () => {});
    assert.equal(rr.body.activa, true);
  });
});
