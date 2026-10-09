// Humo de la gestión de clientes contra el gateway en marcha (HTTP real).
// Uso (PowerShell), con el gateway arrancado SIN --watch:
//   $env:BASE="http://localhost:3000"; $env:ADMIN_CORREO="admin@prueba.com"; $env:ADMIN_PASSWORD="clave-prueba-1"; node humo-clientes.mjs
// Requiere haber corrido crear-datos-humo-pin.mjs (admin en la empresa de prueba) y que el gateway monte /clientes y /empleados.
import assert from "node:assert/strict";

const BASE = process.env.BASE ?? "http://localhost:3000";
const { ADMIN_CORREO, ADMIN_PASSWORD } = process.env;
if (!ADMIN_CORREO || !ADMIN_PASSWORD) throw new Error("define ADMIN_CORREO y ADMIN_PASSWORD");

const navegador = () => {
  const cookies = new Map();
  return async (metodo, ruta, cuerpo) => {
    const r = await fetch(BASE + ruta, {
      method: metodo,
      headers: {
        "x-requested-with": "fetch",
        "content-type": "application/json",
        ...(cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
      },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    for (const c of r.headers.getSetCookie()) {
      const [par, ...attrs] = c.split(";");
      const [nombre, valor] = [par.slice(0, par.indexOf("=")), par.slice(par.indexOf("=") + 1)];
      if (/Max-Age=0/i.test(attrs.join(";"))) cookies.delete(nombre);
      else cookies.set(nombre, valor);
    }
    return { status: r.status, cuerpo: await r.json().catch(() => null) };
  };
};
const admin = navegador();
const mesero = navegador();
const paso = (n, txt) => console.log(`${n}. ${txt}`);

// Números peruanos distintos en cada corrida (9 + 8 dígitos): el humo se puede repetir.
const aleatorio = () => "9" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
const tel1 = aleatorio();
const tel2 = aleatorio();
const marca = Date.now().toString(36);

let r = await admin("POST", "/auth/login", { correo: ADMIN_CORREO, password: ADMIN_PASSWORD });
assert.equal(r.status, 200, "login del admin");
paso(1, "admin entra con contraseña ✔");

r = await admin("POST", "/clientes", {
  nombre: `Ana Humo ${marca}`,
  telefono: tel1,
  correo: `ana.${marca}@humo.com`,
  redes: { instagram: "@Ana.Humo", tiktok: "https://www.tiktok.com/@ana.humo" },
  identificacion: { tipo: "dni", numero: "12345678" },
  preferencias: { entrega: "delivery" },
});
assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
assert.equal(r.cuerpo.telefono, "+51" + tel1);
assert.equal(r.cuerpo.telefonoPais, "PE");
assert.deepEqual(r.cuerpo.redes, { instagram: "ana.humo", tiktok: "ana.humo" });
const ana = r.cuerpo.id;
paso(2, `alta: teléfono ${tel1} → ${r.cuerpo.telefono}, redes limpias ✔`);

r = await admin("POST", "/clientes", { nombre: "Repetida", telefono: `${tel1.slice(0, 3)} ${tel1.slice(3, 6)} ${tel1.slice(6)}` });
assert.equal(r.status, 409);
assert.equal(r.cuerpo.codigo, "CLIENTE_DUPLICADO");
assert.equal(r.cuerpo.clienteId, ana);
paso(3, "mismo teléfono escrito con espacios → 409 CLIENTE_DUPLICADO con el id del existente ✔");

r = await admin("POST", "/clientes", { nombre: "Argentino de paso", telefono: "+54 9 11 2345-6789", redes: {} });
assert.ok([201, 409].includes(r.status));
if (r.status === 201) assert.equal(r.cuerpo.telefonoPais, "AR");
r = await admin("POST", "/clientes", { nombre: "Mal", telefono: "123" });
assert.equal(r.status, 400);
r = await admin("POST", "/clientes", { nombre: "Mal red", redes: { snapchat: "x" } });
assert.equal(r.status, 400);
paso(4, "número con + de otro país se acepta (AR); teléfono o red inválidos → 400 ✔");

r = await admin("GET", `/clientes?q=${encodeURIComponent("@ana.humo")}`);
assert.equal(r.status, 200);
assert.ok(r.cuerpo.clientes.some((c) => c.id === ana));
r = await admin("GET", `/clientes?q=${encodeURIComponent(tel1)}`);
assert.ok(r.cuerpo.clientes.some((c) => c.id === ana));
r = await admin("GET", `/clientes?q=${encodeURIComponent(`Ana Humo ${marca}`)}`);
assert.ok(r.cuerpo.clientes.some((c) => c.id === ana));
paso(5, "búsqueda por @red, por teléfono y por nombre ✔");

r = await admin("PUT", `/clientes/${ana}`, { redes: { instagram: null, x: "anahumo" }, direccion: "Av. Humo 1" });
assert.equal(r.status, 200);
assert.deepEqual(r.cuerpo.redes, { tiktok: "ana.humo", x: "anahumo" });
paso(6, "corregir la ficha: una red se quita y otra se agrega sin tocar las demás ✔");

r = await admin("PUT", `/clientes/${ana}/consentimientos/programaPuntos`, { otorgado: true, medio: "presencial" });
assert.equal(r.status, 200);
assert.equal(r.cuerpo.consentimientos.programaPuntos.otorgado, true);
r = await admin("PUT", `/clientes/${ana}/consentimientos/programaPuntos`, { otorgado: false, medio: "telefono" });
assert.equal(r.cuerpo.historialConsentimientos.length, 2);
r = await admin("PUT", `/clientes/${ana}/consentimientos/otra`, { otorgado: true, medio: "qr" });
assert.equal(r.status, 400);
paso(7, "consentimiento otorgado y retirado, con historial; finalidad inválida → 400 ✔");

// Las empresas creadas antes de la plantilla nueva tienen un mesero sin `cliente:crear`: el admin se lo da
// editando el rol (así se arregla una empresa existente). Si ya lo tiene, no cambia nada.
r = await admin("GET", "/empleados/roles");
assert.equal(r.status, 200);
const rolMesero = r.cuerpo.roles.find((x) => x.nombre === "mesero");
assert.ok(rolMesero, "la empresa de prueba no tiene rol mesero");
const permisosMesero = [...new Set([...rolMesero.permisos, "cliente:leer", "cliente:crear"])];
if (permisosMesero.length !== rolMesero.permisos.length) {
  r = await admin("PUT", `/empleados/roles/${rolMesero.id}`, { permisos: permisosMesero });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  paso("8a", "rol mesero de esta empresa: se le agregó cliente:crear (empresa anterior a la plantilla nueva) ✔");
}

// Un mesero (solo leer y crear): alta por /empleados con contraseña temporal, que cambia al entrar.
const correoMesero = `mesero.${marca}@humo.com`;
r = await admin("POST", "/empleados", { nombre: "Mesero Humo", correo: correoMesero, rol: "mesero", password: "temporal-12345" });
assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
r = await mesero("POST", "/auth/login", { correo: correoMesero, password: "temporal-12345" });
assert.equal(r.status, 200);
r = await mesero("POST", "/auth/password", { passwordActual: "temporal-12345", passwordNueva: "nueva-clave-larga-1" });
assert.equal(r.status, 200);
r = await mesero("POST", "/clientes", { nombre: "Cliente del mesero", telefono: tel2 });
assert.equal(r.status, 201, "el mesero puede dar de alta");
const delMesero = r.cuerpo.id;
r = await mesero("GET", `/clientes/${delMesero}`);
assert.equal(r.status, 200);
r = await mesero("PUT", `/clientes/${delMesero}`, { nombre: "Cambiado" });
assert.equal(r.status, 403, "el mesero no edita");
r = await mesero("POST", `/clientes/${delMesero}/anonimizar`);
assert.equal(r.status, 403, "el mesero no anonimiza");
r = await mesero("PUT", `/clientes/${delMesero}/consentimientos/programaPuntos`, { otorgado: true, medio: "qr" });
assert.equal(r.status, 403, "el mesero no registra consentimientos");
paso(8, "mesero: crea y lee (201/200); editar, consentimientos y anonimizar → 403 ✔");

const sinSesion = navegador();
r = await sinSesion("GET", "/clientes");
assert.equal(r.status, 401);
paso(9, "sin sesión → 401 ✔");

r = await admin("POST", `/clientes/${ana}/desactivar`);
assert.equal(r.status, 200);
r = await admin("GET", `/clientes?q=${encodeURIComponent(tel1)}`);
assert.equal(r.cuerpo.clientes.length, 0);
r = await admin("GET", `/clientes?q=${encodeURIComponent(tel1)}&inactivos=1`);
assert.equal(r.cuerpo.clientes.length, 1);
r = await admin("POST", `/clientes/${ana}/reactivar`);
assert.equal(r.cuerpo.activo, true);
paso(10, "baja y reactivación ✔");

r = await admin("POST", `/clientes/${ana}/anonimizar`);
assert.equal(r.status, 200);
assert.equal(r.cuerpo.anonimizado, true);
assert.equal(r.cuerpo.telefono, null);
assert.equal(JSON.stringify(r.cuerpo).includes("ana.humo"), false);
r = await admin("PUT", `/clientes/${ana}`, { nombre: "Vuelve" });
assert.equal(r.status, 409);
paso(11, "anonimizar borra los datos personales y bloquea la edición ✔");

console.log(`\nHumo de clientes: todo bien. (Clientes de prueba con marca ${marca} quedan en la base del gateway.)`);
