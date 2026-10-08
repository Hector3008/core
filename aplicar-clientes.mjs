// Edita los archivos EXISTENTES de core para la gestión de clientes. Es idempotente: si una edición ya está, la salta.
// Uso, desde la carpeta de core:  node aplicar-clientes.mjs
import { readFileSync, writeFileSync } from "node:fs";

const ediciones = [
  ["src/modelos/index.js", [
    ['import { dispositivoSchema, codigoSchema } from "../auth/modelos-pin.js";',
     'import { dispositivoSchema, codigoSchema } from "../auth/modelos-pin.js";\nimport { clienteSchema } from "../clientes/modelo.js";'],
    ['CodigoEmparejamiento: core.model("CodigoEmparejamiento", codigoSchema, "codigos_emparejamiento"),',
     'CodigoEmparejamiento: core.model("CodigoEmparejamiento", codigoSchema, "codigos_emparejamiento"),\n    Cliente: core.model("Cliente", clienteSchema, "clientes"),'],
  ]],
  ["src/modelos/empresa.js", [
    ['      activa: { type: Boolean, default: true },\n',
     '      activa: { type: Boolean, default: true },\n      // País de la empresa (ISO de 2 letras). Fija el código telefónico por defecto de sus clientes.\n      // Las empresas anteriores a este campo no lo tienen: se asume PE (ver telefono.js).\n      pais: { type: String, default: "PE", uppercase: true, trim: true },\n'],
  ]],
  ["src/modelos/plantillas.js", [
    ['      "catalogo:leer",\n      "cliente:leer",\n    ],\n    cocina',
     '      "catalogo:leer",\n      "cliente:leer",\n      "cliente:crear",\n    ],\n    cocina'],
  ]],
  ["src/empresas.js", [
    ['import { hashPassword } from "./password.js";',
     'import { hashPassword } from "./password.js";\nimport { normalizarPais, PAIS_POR_DEFECTO } from "./telefono.js";'],
    ['async crearEmpresa({ nombre, slug, servicios = [] }) {\n      const empresa = await Empresa.create({\n        nombre,\n        slug,',
     'async crearEmpresa({ nombre, slug, servicios = [], pais = PAIS_POR_DEFECTO }) {\n      const empresa = await Empresa.create({\n        nombre,\n        slug,\n        pais: normalizarPais(pais),'],
    ['    async crearUsuario(',
     '    // Cambia el país de la empresa. Solo afecta a los teléfonos que se escriban sin código de país\n    // de ahí en adelante: los ya guardados están en formato internacional y no cambian.\n    async fijarPais({ empresaId, pais }) {\n      const r = await Empresa.updateOne({ _id: empresaId }, { pais: normalizarPais(pais) });\n      if (!r.matchedCount) throw new Error("empresa no encontrada");\n      return { ok: true };\n    },\n\n    async crearUsuario('],
  ]],
  ["src/index.js", [
    ['import { montarRutasEmpleados } from "./empleados/rutas.js";',
     'import { montarRutasEmpleados } from "./empleados/rutas.js";\nimport { crearServicioClientes } from "./clientes/index.js";\nimport { montarRutasClientes } from "./clientes/rutas.js";'],
    ['export { ErrorEmpleado } from "./empleados/errores.js";',
     'export { ErrorEmpleado } from "./empleados/errores.js";\nexport { ErrorCliente } from "./clientes/errores.js";'],
    ['  core.auth.montarRutas = (router) => montarRutas(router, core);',
     '  core.clientes = crearServicioClientes(core.modelos, core.auth);\n  core.auth.montarRutas = (router) => montarRutas(router, core);'],
    ['  core.empleados.montarRutas = (router) => montarRutasEmpleados(router, core);',
     '  core.empleados.montarRutas = (router) => montarRutasEmpleados(router, core);\n  core.clientes.montarRutas = (router) => montarRutasClientes(router, core);'],
  ]],
];

let fallos = 0;
for (const [archivo, cambios] of ediciones) {
  let texto = readFileSync(archivo, "utf8");
  const crlf = texto.includes("\r\n");
  let s = crlf ? texto.replace(/\r\n/g, "\n") : texto;
  for (const [antes, despues] of cambios) {
    if (s.includes(despues)) { console.log(`= ${archivo}: ya estaba`); continue; }
    if (!s.includes(antes)) { console.log(`✗ ${archivo}: no encuentro este texto, edítalo a mano:\n${antes}\n`); fallos++; continue; }
    s = s.replace(antes, despues);
    console.log(`✔ ${archivo}`);
  }
  writeFileSync(archivo, crlf ? s.replace(/\n/g, "\r\n") : s);
}
console.log(fallos ? `\n${fallos} edición(es) manual(es) pendiente(s).` : "\nListo. Ahora: npm install libphonenumber-js");
process.exit(fallos ? 1 : 0);
