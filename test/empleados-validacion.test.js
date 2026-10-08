// No necesita base de datos.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validarNombre,
  validarCorreo,
  validarTelefono,
  validarNombreRol,
  validarPermisos,
  alcanza,
  generarPasswordTemporal,
} from "../src/empleados/validacion.js";
import { validarPassword } from "../src/auth/politica-password.js";
import { ErrorEmpleado } from "../src/empleados/errores.js";
import { montarRutasEmpleados } from "../src/empleados/rutas.js";

const rechaza = (fn, codigo, status) =>
  assert.throws(fn, (e) => e.codigo === codigo && (status === undefined || e.status === status));

describe("validación de empleados", () => {
  it("nombre, correo y teléfono", () => {
    assert.equal(validarNombre("  Ana  "), "Ana");
    rechaza(() => validarNombre(""), "DATOS_INVALIDOS", 400);
    rechaza(() => validarNombre("x".repeat(81)), "DATOS_INVALIDOS");
    rechaza(() => validarNombre(42), "DATOS_INVALIDOS");
    assert.equal(validarCorreo("  Cocina1@MiCafe.com "), "cocina1@micafe.com");
    rechaza(() => validarCorreo("sin-arroba"), "DATOS_INVALIDOS");
    rechaza(() => validarCorreo({ $ne: "" }), "DATOS_INVALIDOS");
    assert.equal(validarTelefono(undefined), undefined);
    assert.equal(validarTelefono(null), null);
    assert.equal(validarTelefono(""), null);
    assert.equal(validarTelefono(" +51 987-654-321 "), "+51 987-654-321");
    rechaza(() => validarTelefono("abc"), "DATOS_INVALIDOS");
  });

  it("permisos: formato recurso:accion, sin repetidos, con tope", () => {
    assert.deepEqual(validarPermisos(["documento:crear", "documento:crear", "estacion:cocina", "documento:*"]), [
      "documento:crear",
      "estacion:cocina",
      "documento:*",
    ]);
    assert.deepEqual(validarPermisos(["*"]), ["*"]);
    for (const malo of ["Documento:crear", "documento", "documento:", ":crear", "*:crear", "a b:c", "documento:crear:x", 5, null])
      rechaza(() => validarPermisos([malo]), "PERMISO_INVALIDO", 400);
    rechaza(() => validarPermisos("documento:crear"), "DATOS_INVALIDOS");
    rechaza(() => validarPermisos(Array.from({ length: 101 }, (_, i) => `r${i}:a`)), "DATOS_INVALIDOS");
  });

  it("nombre de rol: «admin» está reservado", () => {
    assert.equal(validarNombreRol(" encargado "), "encargado");
    rechaza(() => validarNombreRol("Admin"), "ROL_PROTEGIDO", 403);
    rechaza(() => validarNombreRol(""), "DATOS_INVALIDOS");
  });

  it("alcanza: nadie concede lo que no tiene", () => {
    assert.ok(alcanza(["*"], ["documento:crear", "*"]));
    assert.ok(alcanza(["documento:*"], ["documento:crear", "documento:editar"]));
    assert.ok(!alcanza(["documento:crear"], ["documento:*"]));
    assert.ok(!alcanza(["documento:*"], ["*"]));
    assert.ok(!alcanza(["documento:crear"], ["catalogo:leer"]));
    assert.ok(alcanza(["documento:crear"], []));
  });

  it("política de contraseña y contraseña temporal generada", () => {
    validarPassword("una-clave-larga");
    for (const mala of ["corta", "          ", undefined, 12345678901, "x".repeat(1025)])
      assert.throws(() => validarPassword(mala), (e) => e.codigo === "DATOS_INVALIDOS");
    const p = generarPasswordTemporal();
    assert.equal(p.length, 12);
    assert.match(p, /^[A-Za-z2-9]+$/);
    assert.doesNotMatch(p, /[IOl01]/);
    assert.notEqual(generarPasswordTemporal(), generarPasswordTemporal());
    validarPassword(p);
  });

  it("ErrorEmpleado trae su status", () => {
    assert.equal(new ErrorEmpleado("ULTIMO_ADMIN", "x").status, 409);
    assert.equal(new ErrorEmpleado("NO_ENCONTRADO", "x").status, 404);
    assert.equal(new ErrorEmpleado("SIN_ALCANCE", "x").status, 403);
  });

  it("las rutas se registran con permiso y /roles antes que /:usuarioId", () => {
    const rutas = [];
    const router = Object.fromEntries(
      ["get", "post", "put", "delete"].map((m) => [m, (path, ...fns) => rutas.push({ m, path, n: fns.length })]),
    );
    const h = new Proxy({}, { get: () => () => {} });
    montarRutasEmpleados(router, {
      empleados: { manejadores: h },
      autenticar: () => () => {},
      requierePermiso: () => () => {},
    });
    assert.equal(rutas.length, 14);
    assert.ok(rutas.every((r) => r.n === 3), "cada ruta lleva autenticar + requierePermiso + handler");
    const iRoles = rutas.findIndex((r) => r.path === "/roles");
    const iId = rutas.findIndex((r) => r.path === "/:usuarioId");
    assert.ok(iRoles >= 0 && iRoles < iId);
  });
});
