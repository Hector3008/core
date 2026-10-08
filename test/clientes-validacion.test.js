// No necesita base de datos.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ErrorCliente } from "../src/clientes/errores.js";
import { REDES_SOPORTADAS, normalizarUsuarioRed, validarRedes } from "../src/clientes/redes.js";
import {
  validarNombre,
  validarCorreo,
  validarDireccion,
  validarIdentificacion,
  validarPreferencias,
  validarTelefono,
  validarFinalidad,
  validarMedio,
  prepararDatos,
  idValido,
} from "../src/clientes/validacion.js";
import { montarRutasClientes } from "../src/clientes/rutas.js";

const rechaza = (fn, codigo, status) =>
  assert.throws(fn, (e) => e instanceof ErrorCliente && e.codigo === codigo && (status === undefined || e.status === status));

describe("redes sociales del cliente", () => {
  it("redes admitidas", () => {
    assert.deepEqual(REDES_SOPORTADAS, ["instagram", "tiktok", "facebook", "x"]);
  });

  it("deja solo el usuario: sin @, sin enlace, en minúsculas", () => {
    assert.equal(normalizarUsuarioRed("instagram", "@Ana.Perez"), "ana.perez");
    assert.equal(normalizarUsuarioRed("instagram", "https://www.instagram.com/Ana.Perez/?hl=es"), "ana.perez");
    assert.equal(normalizarUsuarioRed("instagram", "instagram.com/ana_p"), "ana_p");
    assert.equal(normalizarUsuarioRed("tiktok", "https://www.tiktok.com/@ana.perez"), "ana.perez");
    assert.equal(normalizarUsuarioRed("x", "https://twitter.com/anaperez"), "anaperez");
    assert.equal(normalizarUsuarioRed("facebook", "https://fb.com/ana.perez.12"), "ana.perez.12");
  });

  it("rechaza lo que no es un usuario de esa red", () => {
    rechaza(() => normalizarUsuarioRed("instagram", "https://evil.com/ana"), "DATOS_INVALIDOS", 400);
    rechaza(() => normalizarUsuarioRed("instagram", "a".repeat(31)), "DATOS_INVALIDOS");
    rechaza(() => normalizarUsuarioRed("x", "demasiado_largo_para_x"), "DATOS_INVALIDOS");
    rechaza(() => normalizarUsuarioRed("instagram", "con espacio"), "DATOS_INVALIDOS");
    rechaza(() => normalizarUsuarioRed("instagram", 42), "DATOS_INVALIDOS");
    rechaza(() => normalizarUsuarioRed("myspace", "ana"), "DATOS_INVALIDOS");
  });

  it("bloque redes: opcional, varias a la vez, null quita, red desconocida se rechaza", () => {
    assert.equal(validarRedes(undefined), undefined);
    assert.deepEqual(validarRedes({ instagram: "@Ana", tiktok: "ana.pe" }), { instagram: "ana", tiktok: "ana.pe" });
    assert.deepEqual(validarRedes({ instagram: null, x: "" }), { instagram: null, x: null });
    assert.deepEqual(validarRedes({}), {});
    rechaza(() => validarRedes({ snapchat: "ana" }), "DATOS_INVALIDOS");
    rechaza(() => validarRedes({ __proto__x: "a", constructor: "a" }), "DATOS_INVALIDOS");
    rechaza(() => validarRedes("ana"), "DATOS_INVALIDOS");
    rechaza(() => validarRedes(["ana"]), "DATOS_INVALIDOS");
    rechaza(() => validarRedes(null), "DATOS_INVALIDOS");
  });
});

describe("validación de la ficha del cliente", () => {
  it("nombre, correo, dirección e identificación", () => {
    assert.equal(validarNombre("  Ana  "), "Ana");
    rechaza(() => validarNombre(""), "DATOS_INVALIDOS");
    rechaza(() => validarNombre("x".repeat(81)), "DATOS_INVALIDOS");
    assert.equal(validarCorreo(" Ana@Mail.COM "), "ana@mail.com");
    assert.equal(validarCorreo(undefined), undefined);
    assert.equal(validarCorreo(null), null);
    assert.equal(validarCorreo(""), null);
    rechaza(() => validarCorreo("sin-arroba"), "DATOS_INVALIDOS");
    rechaza(() => validarCorreo({ $ne: "" }), "DATOS_INVALIDOS");
    assert.equal(validarDireccion(" Av. Lima 123 "), "Av. Lima 123");
    assert.equal(validarDireccion(""), null);
    rechaza(() => validarDireccion("x".repeat(201)), "DATOS_INVALIDOS");
    assert.deepEqual(validarIdentificacion({ tipo: "ruc", numero: "20123456789" }), { tipo: "RUC", numero: "20123456789" });
    assert.equal(validarIdentificacion(null), null);
    rechaza(() => validarIdentificacion({ tipo: "RUC" }), "DATOS_INVALIDOS");
    rechaza(() => validarIdentificacion({ tipo: "R", numero: "1" }), "DATOS_INVALIDOS");
    rechaza(() => validarIdentificacion("20123456789"), "DATOS_INVALIDOS");
    rechaza(() => validarIdentificacion({ tipo: "RUC", numero: { $ne: 1 } }), "DATOS_INVALIDOS");
  });

  it("teléfono: el país de la empresa, el de este número o el del propio +", () => {
    assert.equal(validarTelefono(undefined), undefined);
    assert.deepEqual(validarTelefono(null), { telefono: null, telefonoPais: null });
    assert.deepEqual(validarTelefono("987654321", { paisEmpresa: "PE" }), { telefono: "+51987654321", telefonoPais: "PE" });
    assert.deepEqual(validarTelefono("11 2345-6789", { paisEmpresa: "AR" }), { telefono: "+541123456789", telefonoPais: "AR" });
    // un número escrito en formato argentino en una empresa peruana: se indica el país de ese número
    assert.deepEqual(validarTelefono("11 2345-6789", { paisEmpresa: "PE", paisTelefono: "ar" }), {
      telefono: "+541123456789",
      telefonoPais: "AR",
    });
    assert.deepEqual(validarTelefono("+54 9 11 2345-6789", { paisEmpresa: "PE" }), { telefono: "+5491123456789", telefonoPais: "AR" });
    rechaza(() => validarTelefono("123", { paisEmpresa: "PE" }), "DATOS_INVALIDOS", 400);
    rechaza(() => validarTelefono("987654321", { paisEmpresa: "PE", paisTelefono: "ZZ" }), "DATOS_INVALIDOS");
  });

  it("preferencias: objeto acotado y sin claves peligrosas", () => {
    assert.equal(validarPreferencias(undefined), undefined);
    assert.deepEqual(validarPreferencias(null), {});
    assert.deepEqual(validarPreferencias({ entrega: "delivery", agencia: { nombre: "X" } }), {
      entrega: "delivery",
      agencia: { nombre: "X" },
    });
    rechaza(() => validarPreferencias([1]), "DATOS_INVALIDOS");
    rechaza(() => validarPreferencias({ $set: 1 }), "DATOS_INVALIDOS");
    rechaza(() => validarPreferencias({ "a.b": 1 }), "DATOS_INVALIDOS");
    rechaza(() => validarPreferencias(JSON.parse('{"__proto__": {"x": 1}}')), "DATOS_INVALIDOS");
    rechaza(() => validarPreferencias({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }), "DATOS_INVALIDOS");
    rechaza(() => validarPreferencias({ nota: "x".repeat(5000) }), "DATOS_INVALIDOS");
  });

  it("finalidades, medios e ids", () => {
    assert.equal(validarFinalidad("programaPuntos"), "programaPuntos");
    rechaza(() => validarFinalidad("otra"), "DATOS_INVALIDOS");
    assert.equal(validarMedio("qr"), "qr");
    rechaza(() => validarMedio("anonimizacion"), "DATOS_INVALIDOS"); // lo pone solo el sistema
    assert.equal(idValido("0123456789abcdef01234567"), "0123456789abcdef01234567");
    rechaza(() => idValido("x"), "DATOS_INVALIDOS");
    rechaza(() => idValido({ $ne: 1 }), "DATOS_INVALIDOS");
  });

  it("prepararDatos: el nombre es obligatorio solo al crear", () => {
    rechaza(() => prepararDatos({}, { crear: true, paisEmpresa: "PE" }), "DATOS_INVALIDOS");
    const d = prepararDatos(
      { nombre: " Ana ", telefono: "987654321", correo: "A@b.co", redes: { instagram: "@ana" } },
      { crear: true, paisEmpresa: "PE" },
    );
    assert.equal(d.nombre, "Ana");
    assert.equal(d.telefono, "+51987654321");
    assert.equal(d.telefonoPais, "PE");
    assert.equal(d.correo, "a@b.co");
    assert.deepEqual(d.redes, { instagram: "ana" });
    assert.equal(d.direccion, undefined);
    const parcial = prepararDatos({ direccion: "Av. 1" }, { crear: false });
    assert.equal(parcial.nombre, undefined);
    assert.equal(parcial.direccion, "Av. 1");
  });
});

describe("rutas de clientes", () => {
  it("cada ruta lleva autenticar + requierePermiso + handler, con el permiso que toca", () => {
    const rutas = [];
    const reg = (metodo) => (path, ...fns) => rutas.push({ metodo, path, n: fns.length });
    const router = { get: reg("get"), post: reg("post"), put: reg("put"), delete: reg("delete") };
    const pedidos = [];
    const h = new Proxy({}, { get: () => () => {} });
    montarRutasClientes(router, {
      clientes: { manejadores: h },
      autenticar: () => () => {},
      requierePermiso: (p) => (pedidos.push(p), () => {}),
    });
    assert.equal(rutas.length, 8);
    assert.ok(rutas.every((r) => r.n === 3));
    assert.deepEqual(
      [...new Set(pedidos)].sort(),
      ["cliente:crear", "cliente:editar", "cliente:gestionar", "cliente:leer"],
    );
  });
});
