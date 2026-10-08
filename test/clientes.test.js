// Requiere una MongoDB real: MONGODB_URI=mongodb://localhost:27017 node --test
// (los índices únicos parciales de teléfono y correo no existen en FerretDB: ver arquitectura 5.9)
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { createCore, conEmpresa } from "../src/index.js";

const uri = process.env.MONGODB_URI;
const opts = { skip: uri ? false : "define MONGODB_URI para correr esta prueba" };
const COLECCIONES = ["empresas", "usuarios", "roles", "membresias", "clientes"];

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

describe("gestión de clientes", opts, () => {
  let conn, core, cl, e1, e2, e3;
  const ADM = { usuarioId: "0123456789abcdef01234567", permisos: ["*"] };
  const MESERO = { usuarioId: "0123456789abcdef01234568", permisos: ["cliente:leer", "cliente:crear"] };
  const SOLO_LEER = { usuarioId: "0123456789abcdef01234569", permisos: ["cliente:leer"] };

  before(async () => {
    conn = await mongoose.createConnection(uri, { dbName: "core-test-clientes" }).asPromise();
    for (const c of COLECCIONES) await conn.db.dropCollection(c).catch(() => {});
    core = createCore({ connection: conn });
    cl = core.clientes;
    await cl.listo();
    e1 = await core.empresas.crearEmpresa({ nombre: "Cafe Uno", slug: "uno", servicios: ["restaurante"] });
    e2 = await core.empresas.crearEmpresa({ nombre: "Cafe Argentino", slug: "ar", servicios: ["restaurante"], pais: "ar" });
    e3 = await core.empresas.crearEmpresa({ nombre: "Cafe Tres", slug: "tres", servicios: ["restaurante"] });
  });
  after(async () => {
    for (const c of COLECCIONES) await conn.db.dropCollection(c).catch(() => {});
    await conn.close();
  });

  const nuevo = (extra = {}, empresa = e1, actor = ADM) =>
    cl.crear({ empresaId: empresa._id, actor, nombre: "Ana Pérez", ...extra });

  it("país de la empresa: PE por defecto, AR si se indica; fijarlo después y empresas sin el campo", async () => {
    assert.equal(e1.pais, "PE");
    assert.equal(e2.pais, "AR");
    await assert.rejects(core.empresas.crearEmpresa({ nombre: "X", slug: "x-zz", pais: "ZZ" }), /país inválido/);
    const e4 = await core.empresas.crearEmpresa({ nombre: "Cafe Cuatro", slug: "cuatro" });
    await core.empresas.fijarPais({ empresaId: e4._id, pais: "cl" });
    assert.equal((await core.modelos.Empresa.findById(e4._id).lean()).pais, "CL");
    await assert.rejects(core.empresas.fijarPais({ empresaId: e4._id, pais: "ZZ" }), /país inválido/);
    // una empresa creada antes de existir el campo no lo tiene: se asume PE
    await core.modelos.Empresa.collection.updateOne({ _id: e3._id }, { $unset: { pais: "" } });
    const c = await nuevo({ nombre: "Sin país", telefono: "987654322" }, e3);
    assert.equal(c.telefono, "+51987654322");
  });

  it("crear: ficha completa con teléfono normalizado, redes e identificación", async () => {
    const c = await nuevo({
      telefono: "987 654 321",
      correo: " Ana@Mail.COM ",
      redes: { instagram: "@Ana.Perez", tiktok: "https://www.tiktok.com/@ana.pe", facebook: "ana.perez.12", x: "anaperez" },
      identificacion: { tipo: "dni", numero: "12345678" },
      direccion: "Av. Lima 123",
      preferencias: { entrega: "delivery", comprobante: "boleta" },
    });
    assert.match(c.id, /^[0-9a-f]{24}$/);
    assert.equal(c.nombre, "Ana Pérez");
    assert.equal(c.telefono, "+51987654321");
    assert.equal(c.telefonoPais, "PE");
    assert.equal(c.correo, "ana@mail.com");
    assert.deepEqual(c.redes, { instagram: "ana.perez", tiktok: "ana.pe", facebook: "ana.perez.12", x: "anaperez" });
    assert.deepEqual(c.identificacion, { tipo: "DNI", numero: "12345678" });
    assert.equal(c.direccion, "Av. Lima 123");
    assert.deepEqual(c.preferencias, { entrega: "delivery", comprobante: "boleta" });
    assert.equal(c.activo, true);
    assert.equal(c.anonimizado, false);
    assert.deepEqual(c.consentimientos.programaPuntos, { otorgado: false, ts: null, medio: null, registradoPor: null });
    const leido = await cl.obtener({ empresaId: e1._id, clienteId: c.id });
    assert.equal(leido.telefono, "+51987654321");
    assert.deepEqual(leido.historialConsentimientos, []);
  });

  it("crear: solo el nombre alcanza; Instagram y las demás redes son opcionales", async () => {
    const c = await nuevo({ nombre: "Mesa 4" });
    assert.equal(c.telefono, null);
    assert.equal(c.correo, null);
    assert.deepEqual(c.redes, {});
    assert.equal(c.identificacion, null);
    assert.deepEqual(c.preferencias, {});
    const solo = await nuevo({ nombre: "Solo tiktok", redes: { tiktok: "solo.tiktok" } });
    assert.deepEqual(solo.redes, { tiktok: "solo.tiktok" });
    await rechaza(nuevo({ nombre: undefined }), "DATOS_INVALIDOS", 400);
    await rechaza(nuevo({ redes: { snapchat: "ana" } }), "DATOS_INVALIDOS");
    await rechaza(nuevo({ telefono: "123" }), "DATOS_INVALIDOS");
  });

  it("teléfono: +51 en una empresa de Perú, +54 en una de Argentina, o el del propio +", async () => {
    const pe = await nuevo({ nombre: "Peruano", telefono: "912345678" });
    assert.equal(pe.telefono, "+51912345678");
    const ar = await nuevo({ nombre: "Argentino", telefono: "11 2345-6789" }, e2);
    assert.equal(ar.telefono, "+541123456789");
    assert.equal(ar.telefonoPais, "AR");
    // en la empresa argentina, un cliente peruano se escribe con su código...
    const dePeruEnAr = await nuevo({ nombre: "Peruano en AR", telefono: "+51 987 000 111" }, e2);
    assert.equal(dePeruEnAr.telefono, "+51987000111");
    assert.equal(dePeruEnAr.telefonoPais, "PE");
    // ...o se indica el país de ese número
    const otro = await nuevo({ nombre: "Peruano en AR 2", telefono: "987 000 222", paisTelefono: "PE" }, e2);
    assert.equal(otro.telefono, "+51987000222");
    // un número argentino en una empresa de Perú
    const arEnPe = await nuevo({ nombre: "Argentino en PE", telefono: "11 2345-1111", paisTelefono: "AR" });
    assert.equal(arEnPe.telefono, "+541123451111");
    await rechaza(nuevo({ telefono: "11 2345-6789" }), "DATOS_INVALIDOS"); // formato argentino sin decir el país
  });

  it("permisos: crear pide cliente:crear, editar cliente:editar, gestionar cliente:gestionar", async () => {
    const c = await nuevo({ nombre: "Con mesero" }, e1, MESERO);
    await rechaza(nuevo({ nombre: "No" }, e1, SOLO_LEER), "PERMISO_INSUFICIENTE", 403);
    await rechaza(cl.crear({ empresaId: e1._id, nombre: "Sin actor" }), "PERMISO_INSUFICIENTE", 403);
    await rechaza(cl.crear({ empresaId: e1._id, actor: { permisos: "*" }, nombre: "Mal actor" }), "PERMISO_INSUFICIENTE");
    await rechaza(cl.actualizar({ empresaId: e1._id, actor: MESERO, clienteId: c.id, nombre: "X" }), "PERMISO_INSUFICIENTE", 403);
    await rechaza(cl.desactivar({ empresaId: e1._id, actor: MESERO, clienteId: c.id }), "PERMISO_INSUFICIENTE");
    await rechaza(cl.anonimizar({ empresaId: e1._id, actor: MESERO, clienteId: c.id }), "PERMISO_INSUFICIENTE");
    await rechaza(
      cl.otorgarConsentimiento({ empresaId: e1._id, actor: MESERO, clienteId: c.id, finalidad: "programaPuntos", medio: "presencial" }),
      "PERMISO_INSUFICIENTE",
    );
    // los comodines de recurso valen (como la plantilla de siscore: cliente:*)
    const vendedor = { usuarioId: ADM.usuarioId, permisos: ["cliente:*"] };
    await cl.actualizar({ empresaId: e1._id, actor: vendedor, clienteId: c.id, direccion: "Calle 1" });
    // la plantilla de mesero trae cliente:leer y cliente:crear
    const rol = await conEmpresa(e1._id, async () => await core.modelos.Rol.findOne({ nombre: "mesero" }).lean());
    assert.ok(rol.permisos.includes("cliente:crear") && rol.permisos.includes("cliente:leer"));
    assert.ok(!rol.permisos.includes("cliente:editar"));
  });

  it("duplicados: un teléfono o un correo identifica a un solo cliente por empresa", async () => {
    const a = await nuevo({ nombre: "Dup A", telefono: "955 111 222", correo: "dup@x.com" });
    // el mismo número escrito de otra forma
    await assert.rejects(nuevo({ nombre: "Dup B", telefono: "+51955111222" }), (e) => {
      assert.equal(e.codigo, "CLIENTE_DUPLICADO");
      assert.equal(e.status, 409);
      assert.equal(e.detalle.campo, "telefono");
      assert.equal(e.detalle.clienteId, a.id);
      return true;
    });
    await assert.rejects(nuevo({ nombre: "Dup C", correo: "DUP@x.com" }), (e) => e.codigo === "CLIENTE_DUPLICADO" && e.detalle.campo === "correo" && e.detalle.clienteId === a.id);
    // sin teléfono ni correo, varios clientes conviven
    await nuevo({ nombre: "Sin datos 1" });
    await nuevo({ nombre: "Sin datos 2" });
    // en otra empresa el mismo número es otro cliente
    const otra = await nuevo({ nombre: "Dup en otra empresa", telefono: "955 111 222" }, e3);
    assert.equal(otra.telefono, "+51955111222");
    // corregir la ficha tampoco puede chocar con otro cliente
    const b = await nuevo({ nombre: "Dup D", telefono: "955 333 444" });
    await assert.rejects(
      cl.actualizar({ empresaId: e1._id, actor: ADM, clienteId: b.id, telefono: "955111222" }),
      (e) => e.codigo === "CLIENTE_DUPLICADO" && e.detalle.clienteId === a.id,
    );
    assert.equal((await cl.obtener({ empresaId: e1._id, clienteId: b.id })).telefono, "+51955333444");
  });

  it("duplicados: altas simultáneas con el mismo teléfono dejan un solo cliente", async () => {
    const intentos = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => nuevo({ nombre: `Carrera ${i}`, telefono: "944 555 666" })),
    );
    assert.equal(intentos.filter((x) => x.status === "fulfilled").length, 1);
    assert.ok(intentos.filter((x) => x.status === "rejected").every((x) => x.reason.codigo === "CLIENTE_DUPLICADO"));
  });

  it("actualizar: redes se combinan por red, null quita; preferencias e identificación se reemplazan", async () => {
    const c = await nuevo({ nombre: "Edita", redes: { instagram: "edita" }, preferencias: { a: 1, b: 2 }, telefono: "933 111 000" });
    let r = await cl.actualizar({ empresaId: e1._id, actor: ADM, clienteId: c.id, redes: { tiktok: "@edita.tt" } });
    assert.deepEqual(r.redes, { instagram: "edita", tiktok: "edita.tt" });
    r = await cl.actualizar({ empresaId: e1._id, actor: ADM, clienteId: c.id, redes: { instagram: null } });
    assert.deepEqual(r.redes, { tiktok: "edita.tt" });
    r = await cl.actualizar({ empresaId: e1._id, actor: ADM, clienteId: c.id, preferencias: { c: 3 }, identificacion: { tipo: "ruc", numero: "20123456789" } });
    assert.deepEqual(r.preferencias, { c: 3 });
    assert.deepEqual(r.identificacion, { tipo: "RUC", numero: "20123456789" });
    r = await cl.actualizar({ empresaId: e1._id, actor: ADM, clienteId: c.id, nombre: "Edita Nueva", telefono: null, correo: "e@x.com", identificacion: null });
    assert.equal(r.nombre, "Edita Nueva");
    assert.equal(r.telefono, null);
    assert.equal(r.telefonoPais, null);
    assert.equal(r.identificacion, null);
    assert.deepEqual(r.redes, { tiktok: "edita.tt" }); // no se tocó
    r = await cl.actualizar({ empresaId: e1._id, actor: ADM, clienteId: c.id, telefono: "933 111 000" });
    assert.equal(r.telefono, "+51933111000");
    await rechaza(cl.actualizar({ empresaId: e1._id, actor: ADM, clienteId: c.id }), "DATOS_INVALIDOS", 400);
    await rechaza(cl.actualizar({ empresaId: e1._id, actor: ADM, clienteId: c.id, redes: { x: "demasiado_largo_para_x" } }), "DATOS_INVALIDOS");
    await rechaza(cl.actualizar({ empresaId: e1._id, actor: ADM, clienteId: "0123456789abcdef01234500", nombre: "No" }), "NO_ENCONTRADO", 404);
    await rechaza(cl.actualizar({ empresaId: e1._id, actor: ADM, clienteId: "no-es-id", nombre: "No" }), "DATOS_INVALIDOS");
  });

  it("listar y buscar: por nombre, teléfono, correo o @red; aislados por empresa", async () => {
    const bus = await nuevo({
      nombre: "Zoe Busquedas",
      telefono: "922 333 444",
      correo: "zoe@busca.com",
      redes: { instagram: "zoe.busca", x: "zoebusca" },
    });
    const id = (r) => r.map((c) => c.id);
    const E = e1._id;
    assert.deepEqual(id(await cl.buscar({ empresaId: E, texto: "zoe bus" })), [
      bus.id,
    ]);
    assert.deepEqual(id(await cl.buscar({ empresaId: E, texto: "ZOE" })), [
      bus.id,
    ]);
    assert.deepEqual(
      id(await cl.buscar({ empresaId: E, texto: "922 333 444" })),
      [bus.id],
    ); // nacional
    assert.deepEqual(
      id(await cl.buscar({ empresaId: E, texto: "+51922333444" })),
      [bus.id],
    );
    assert.deepEqual(
      id(await cl.buscar({ empresaId: E, texto: "2 333 444" })),
      [bus.id],
    ); // últimos dígitos
    assert.deepEqual(
      id(await cl.buscar({ empresaId: E, texto: "ZOE@busca.com" })),
      [bus.id],
    );
    assert.deepEqual(
      id(await cl.buscar({ empresaId: E, texto: "@Zoe.Busca" })),
      [bus.id],
    );
    assert.deepEqual(
      id(await cl.buscar({ empresaId: E, texto: "@zoebusca" })),
      [bus.id],
    ); // la red X
    assert.deepEqual(
      id(await cl.buscar({ empresaId: E, texto: "zoe.busca" })),
      [bus.id],
    );
    assert.deepEqual(
      await cl.buscar({ empresaId: E, texto: "no existe nadie así" }),
      [],
    );
    // los caracteres de regex se toman literales
    assert.deepEqual(await cl.buscar({ empresaId: E, texto: ".*" }), []);
    await rechaza(cl.buscar({ empresaId: E, texto: "" }), "DATOS_INVALIDOS");
    await rechaza(
      cl.buscar({ empresaId: E, texto: "x".repeat(81) }),
      "DATOS_INVALIDOS",
    );
    await rechaza(cl.buscar({ empresaId: E }), "DATOS_INVALIDOS");
    // otra empresa no lo ve
    assert.deepEqual(await cl.buscar({ empresaId: e2._id, texto: "zoe" }), []);
    assert.deepEqual(
      await cl.buscar({ empresaId: e2._id, texto: "922 333 444" }),
      [],
    );
    // listar: ordenado por nombre, con límite y salto
    const todos = await cl.listar({ empresaId: E });
    assert.ok(todos.length > 5);
    const nombres = todos.map((c) => c.nombre);
    assert.deepEqual(nombres, [...nombres].sort());
    const p1 = await cl.listar({ empresaId: E, limite: 2 });
    const p2 = await cl.listar({ empresaId: E, limite: 2, saltar: 2 });
    assert.equal(p1.length, 2);
    assert.deepEqual(id(p2), id(todos.slice(2, 4)));
    assert.equal(
      (await cl.listar({ empresaId: E, limite: 100000 })).length,
      todos.length,
    );
  });

  it("aislamiento: sin empresa activa el modelo no responde y una empresa no ve los clientes de otra", async () => {
    await assert.rejects(core.modelos.Cliente.find({}), /sin empresa activa/i);
    const c = await nuevo({ nombre: "Solo de e1" });
    await rechaza(cl.obtener({ empresaId: e2._id, clienteId: c.id }), "NO_ENCONTRADO", 404);
    await rechaza(cl.actualizar({ empresaId: e2._id, actor: ADM, clienteId: c.id, nombre: "Intruso" }), "NO_ENCONTRADO");
    await rechaza(cl.desactivar({ empresaId: e2._id, actor: ADM, clienteId: c.id }), "NO_ENCONTRADO");
    await rechaza(cl.instantanea({ empresaId: e2._id, clienteId: c.id }), "NO_ENCONTRADO");
    assert.equal((await cl.obtener({ empresaId: e1._id, clienteId: c.id })).nombre, "Solo de e1");
    await rechaza(nuevo({ nombre: "Empresa fantasma" }, { _id: "0123456789abcdef01234599" }), "NO_ENCONTRADO");
  });

  it("baja y reactivación: no se borra, deja de salir en la lista y vuelve con su historial", async () => {
    const c = await nuevo({ nombre: "Baja Prueba", telefono: "911 222 333" });
    const d = await cl.desactivar({ empresaId: e1._id, actor: ADM, clienteId: c.id });
    assert.equal(d.activo, false);
    assert.equal(d.anonimizado, false);
    assert.equal((await cl.buscar({ empresaId: e1._id, texto: "Baja Prueba" })).length, 0);
    assert.equal((await cl.buscar({ empresaId: e1._id, texto: "Baja Prueba", incluirInactivos: true })).length, 1);
    await rechaza(cl.desactivar({ empresaId: e1._id, actor: ADM, clienteId: c.id }), "ESTADO_INVALIDO", 409);
    // su teléfono sigue reservado: no se puede dar de alta otro con él
    await rechaza(nuevo({ nombre: "Otro", telefono: "911222333" }), "CLIENTE_DUPLICADO");
    const r = await cl.reactivar({ empresaId: e1._id, actor: ADM, clienteId: c.id });
    assert.equal(r.activo, true);
    assert.equal(r.telefono, "+51911222333");
    await rechaza(cl.reactivar({ empresaId: e1._id, actor: ADM, clienteId: c.id }), "ESTADO_INVALIDO");
  });

  it("consentimientos: se otorgan y se retiran con historial, y repetir no hace nada", async () => {
    const c = await nuevo({ nombre: "Con consentimiento" });
    const A = { empresaId: e1._id, actor: ADM, clienteId: c.id, finalidad: "programaPuntos" };
    assert.equal(await cl.tieneConsentimiento({ empresaId: e1._id, clienteId: c.id, finalidad: "programaPuntos" }), false);
    let r = await cl.otorgarConsentimiento({ ...A, medio: "presencial" });
    assert.equal(r.consentimientos.programaPuntos.otorgado, true);
    assert.equal(r.consentimientos.programaPuntos.medio, "presencial");
    assert.equal(r.consentimientos.programaPuntos.registradoPor, ADM.usuarioId);
    assert.ok(r.consentimientos.programaPuntos.ts);
    assert.equal(r.consentimientos.etiquetadoRedes.otorgado, false);
    assert.equal(r.historialConsentimientos.length, 1);
    assert.equal(await cl.tieneConsentimiento({ empresaId: e1._id, clienteId: c.id, finalidad: "programaPuntos" }), true);
    assert.equal(await cl.tieneConsentimiento({ empresaId: e1._id, clienteId: c.id, finalidad: "etiquetadoRedes" }), false);
    r = await cl.otorgarConsentimiento({ ...A, medio: "qr" }); // ya estaba otorgado: sin cambios
    assert.equal(r.historialConsentimientos.length, 1);
    assert.equal(r.consentimientos.programaPuntos.medio, "presencial");
    r = await cl.retirarConsentimiento({ ...A, medio: "telefono" });
    assert.equal(r.consentimientos.programaPuntos.otorgado, false);
    assert.equal(r.consentimientos.programaPuntos.medio, "telefono");
    assert.deepEqual(r.historialConsentimientos.map((h) => [h.finalidad, h.otorgado, h.medio]), [
      ["programaPuntos", true, "presencial"],
      ["programaPuntos", false, "telefono"],
    ]);
    assert.equal(await cl.tieneConsentimiento({ empresaId: e1._id, clienteId: c.id, finalidad: "programaPuntos" }), false);
    r = await cl.retirarConsentimiento({ ...A, medio: "telefono" }); // nada que retirar
    assert.equal(r.historialConsentimientos.length, 2);
    await rechaza(cl.otorgarConsentimiento({ ...A, finalidad: "otra", medio: "qr" }), "DATOS_INVALIDOS");
    await rechaza(cl.otorgarConsentimiento({ ...A, medio: "telepatia" }), "DATOS_INVALIDOS");
    await rechaza(cl.otorgarConsentimiento({ ...A }), "DATOS_INVALIDOS"); // el medio es obligatorio
    await rechaza(cl.cambiarConsentimiento({ ...A, otorgado: "si", medio: "qr" }), "DATOS_INVALIDOS");
  });

  it("consentimientos: con el cliente desactivado se puede retirar, no otorgar", async () => {
    const c = await nuevo({ nombre: "Baja con consentimiento" });
    const A = { empresaId: e1._id, actor: ADM, clienteId: c.id, finalidad: "etiquetadoRedes" };
    await cl.otorgarConsentimiento({ ...A, medio: "formulario" });
    await cl.desactivar({ empresaId: e1._id, actor: ADM, clienteId: c.id });
    assert.equal(await cl.tieneConsentimiento({ empresaId: e1._id, clienteId: c.id, finalidad: "etiquetadoRedes" }), false); // desactivado
    const r = await cl.retirarConsentimiento({ ...A, medio: "mensaje" });
    assert.equal(r.consentimientos.etiquetadoRedes.otorgado, false);
    await rechaza(cl.otorgarConsentimiento({ ...A, medio: "mensaje" }), "ESTADO_INVALIDO", 409);
  });

  it("instantanea: lo que se copia al documento, sin correo ni redes salvo que se pidan", async () => {
    const c = await nuevo({
      nombre: "Para documento", telefono: "966 777 888", correo: "doc@x.com", redes: { instagram: "para.doc" },
      identificacion: { tipo: "RUC", numero: "20999999999" }, direccion: "Jr. Uno 1", preferencias: { entrega: { tipo: "agencia" } },
    });
    const s = await cl.instantanea({ empresaId: e1._id, clienteId: c.id });
    assert.deepEqual(s, {
      clienteId: c.id, nombre: "Para documento", telefono: "+51966777888",
      identificacion: { tipo: "RUC", numero: "20999999999" }, direccion: "Jr. Uno 1", preferencias: { entrega: { tipo: "agencia" } },
    });
    const s2 = await cl.instantanea({ empresaId: e1._id, clienteId: c.id, campos: ["nombre", "correo", "redes"] });
    assert.deepEqual(s2, { clienteId: c.id, nombre: "Para documento", correo: "doc@x.com", redes: { instagram: "para.doc" } });
    s.preferencias.entrega.tipo = "cambiado"; // es una copia: no toca al cliente
    assert.equal((await cl.obtener({ empresaId: e1._id, clienteId: c.id })).preferencias.entrega.tipo, "agencia");
    await rechaza(cl.instantanea({ empresaId: e1._id, clienteId: c.id, campos: ["nombre", "consentimientos"] }), "DATOS_INVALIDOS");
    await cl.desactivar({ empresaId: e1._id, actor: ADM, clienteId: c.id });
    await rechaza(cl.instantanea({ empresaId: e1._id, clienteId: c.id }), "ESTADO_INVALIDO", 409);
  });

  it("anonimizar: borra los datos personales, retira los consentimientos y no se puede deshacer", async () => {
    const c = await nuevo({
      nombre: "Quiere Olvido", telefono: "977 888 999", correo: "olvido@x.com", redes: { instagram: "olvido", tiktok: "olvido.tt" },
      identificacion: { tipo: "DNI", numero: "87654321" }, direccion: "Calle Secreta 9", preferencias: { entrega: "casa" },
    });
    await cl.otorgarConsentimiento({ empresaId: e1._id, actor: ADM, clienteId: c.id, finalidad: "programaPuntos", medio: "presencial" });
    const r = await cl.anonimizar({ empresaId: e1._id, actor: ADM, clienteId: c.id });
    assert.equal(r.anonimizado, true);
    assert.equal(r.activo, false);
    assert.equal(r.nombre, "Cliente anonimizado");
    assert.equal(r.telefono, null);
    assert.equal(r.telefonoPais, null);
    assert.equal(r.correo, null);
    assert.deepEqual(r.redes, {});
    assert.equal(r.identificacion, null);
    assert.equal(r.direccion, null);
    assert.deepEqual(r.preferencias, {});
    assert.equal(r.consentimientos.programaPuntos.otorgado, false);
    assert.equal(r.consentimientos.programaPuntos.medio, "anonimizacion");
    assert.equal(r.historialConsentimientos.at(-1).medio, "anonimizacion");
    assert.equal(r.historialConsentimientos.length, 2); // otorgado + retirado por la anonimización
    const crudo = JSON.stringify(await conEmpresa(e1._id, async () => await core.modelos.Cliente.findById(c.id).lean()));
    for (const dato of ["Quiere Olvido", "olvido@x.com", "977", "Calle Secreta", "87654321", "olvido.tt"])
      assert.ok(!crudo.includes(dato), `quedó rastro de ${dato} en la base`);
    await rechaza(cl.anonimizar({ empresaId: e1._id, actor: ADM, clienteId: c.id }), "ESTADO_INVALIDO", 409);
    await rechaza(cl.actualizar({ empresaId: e1._id, actor: ADM, clienteId: c.id, nombre: "Vuelve" }), "ESTADO_INVALIDO");
    await rechaza(cl.reactivar({ empresaId: e1._id, actor: ADM, clienteId: c.id }), "ESTADO_INVALIDO");
    await rechaza(cl.otorgarConsentimiento({ empresaId: e1._id, actor: ADM, clienteId: c.id, finalidad: "programaPuntos", medio: "qr" }), "ESTADO_INVALIDO");
    await rechaza(cl.instantanea({ empresaId: e1._id, clienteId: c.id }), "ESTADO_INVALIDO");
    assert.equal(await cl.tieneConsentimiento({ empresaId: e1._id, clienteId: c.id, finalidad: "programaPuntos" }), false);
    // su teléfono queda libre para otro cliente, y varios anonimizados conviven
    const otro = await nuevo({ nombre: "Hereda número", telefono: "977 888 999" });
    assert.equal(otro.telefono, "+51977888999");
    const c2 = await nuevo({ nombre: "Otro anonimizado", telefono: "977 000 001" });
    await cl.anonimizar({ empresaId: e1._id, actor: ADM, clienteId: c2.id });
  });

  it("HTTP: manejadores con sus códigos, el cuerpo de error y la cabecera x-requested-with", async () => {
    const auth = { usuarioId: ADM.usuarioId, empresaId: String(e1._id) };
    const base = (o) => req({ auth, rol: { permisos: ["*"] }, headers: X, ...o });
    const m = cl.manejadores;

    const r1 = res();
    await m.crear(base({ method: "POST", body: { nombre: "Http Uno", telefono: "988 100 200", redes: { instagram: "http.uno" }, actor: { permisos: ["*"] } } }), r1, () => {});
    assert.equal(r1.statusCode, 201);
    assert.equal(r1.body.telefono, "+51988100200");
    const id = r1.body.id;

    const r2 = res();
    await m.crear(base({ method: "POST", body: { nombre: "Http Dos", telefono: "988100200" } }), r2, () => {});
    assert.equal(r2.statusCode, 409);
    assert.equal(r2.body.codigo, "CLIENTE_DUPLICADO");
    assert.equal(r2.body.clienteId, id);
    assert.equal(r2.body.campo, "telefono");

    const r3 = res();
    await m.crear(base({ method: "POST", headers: {}, body: { nombre: "Sin csrf" } }), r3, () => {});
    assert.equal(r3.body.codigo, "CSRF");
    assert.ok(r3.statusCode >= 400);

    const r4 = res();
    await m.crear(base({ method: "POST", body: { nombre: "" } }), r4, () => {});
    assert.equal(r4.statusCode, 400);

    const r5 = res();
    await m.obtener(base({ params: { clienteId: id } }), r5, () => {});
    assert.equal(r5.statusCode, 200);
    assert.equal(r5.body.nombre, "Http Uno");
    const r6 = res();
    await m.obtener(base({ params: { clienteId: "0123456789abcdef01234500" } }), r6, () => {});
    assert.equal(r6.statusCode, 404);

    const r7 = res();
    await m.listar(base({ query: { q: "@http.uno" } }), r7, () => {});
    assert.deepEqual(r7.body.clientes.map((c) => c.id), [id]);
    const r8 = res();
    await m.listar(base({ query: { limite: "2" } }), r8, () => {});
    assert.equal(r8.body.clientes.length, 2);

    const r9 = res();
    await m.actualizar(base({ method: "PUT", params: { clienteId: id }, body: { direccion: "Av. Http 1", redes: { tiktok: "http.tt" } } }), r9, () => {});
    assert.equal(r9.statusCode, 200);
    assert.deepEqual(r9.body.redes, { instagram: "http.uno", tiktok: "http.tt" });

    const r10 = res();
    await m.consentimiento(base({ method: "PUT", params: { clienteId: id, finalidad: "etiquetadoRedes" }, body: { otorgado: true, medio: "formulario" } }), r10, () => {});
    assert.equal(r10.statusCode, 200);
    assert.equal(r10.body.consentimientos.etiquetadoRedes.otorgado, true);
    const r11 = res();
    await m.consentimiento(base({ method: "PUT", params: { clienteId: id, finalidad: "etiquetadoRedes" }, body: { otorgado: "si", medio: "formulario" } }), r11, () => {});
    assert.equal(r11.statusCode, 400);

    // sin el permiso, el servicio rechaza aunque la ruta se hubiera montado sin requierePermiso
    const r12 = res();
    await m.anonimizar(base({ method: "POST", rol: { permisos: ["cliente:leer"] }, params: { clienteId: id } }), r12, () => {});
    assert.equal(r12.statusCode, 403);
    assert.equal(r12.body.codigo, "PERMISO_INSUFICIENTE");

    const r13 = res();
    await m.desactivar(base({ method: "POST", params: { clienteId: id } }), r13, () => {});
    assert.equal(r13.statusCode, 200);
    assert.equal(r13.body.activo, false);
    const r14 = res();
    await m.reactivar(base({ method: "POST", params: { clienteId: id } }), r14, () => {});
    assert.equal(r14.body.activo, true);
    const r15 = res();
    await m.anonimizar(base({ method: "POST", params: { clienteId: id } }), r15, () => {});
    assert.equal(r15.body.anonimizado, true);

    // un error que no es del módulo se pasa a next (lo atiende Express)
    let paso;
    await m.obtener(base({ auth: null }), res(), (e) => (paso = e));
    assert.ok(paso instanceof Error);
  });
});
