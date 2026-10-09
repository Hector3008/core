// Edita los archivos EXISTENTES de core para el catálogo. Es idempotente: si una edición ya está, la salta.
// Uso, desde la carpeta de core:  node aplicar-catalogo.mjs
// (los archivos NUEVOS —src/catalogo/*, src/moneda.js, test/catalogo*.test.js, docs/catalogo.md— se copian aparte)
import { readFileSync, writeFileSync } from "node:fs";

const ediciones = [
  ["src/modelos/index.js", [
    ['import { clienteSchema } from "../clientes/modelo.js";',
     'import { clienteSchema } from "../clientes/modelo.js";\nimport { itemSchema } from "../catalogo/modelo.js";'],
    ['    Cliente: core.model("Cliente", clienteSchema, "clientes"),',
     '    Cliente: core.model("Cliente", clienteSchema, "clientes"),\n    Item: core.model("Item", itemSchema, "catalogo_items"),'],
  ]],
  ["src/modelos/empresa.js", [
    ['      // Opciones de seguridad',
     '      // Moneda de los precios del catálogo (ISO 4217 de 3 letras). Las empresas anteriores al campo asumen PEN.\n      moneda: { type: String, default: "PEN", uppercase: true, trim: true },\n      // Opciones de seguridad'],
  ]],
  ["src/empresas.js", [
    ['import { normalizarPais, PAIS_POR_DEFECTO } from "./telefono.js";',
     'import { normalizarPais, PAIS_POR_DEFECTO } from "./telefono.js";\nimport { normalizarMoneda, MONEDA_POR_DEFECTO } from "./moneda.js";'],
    ['async crearEmpresa({ nombre, slug, servicios = [], pais = PAIS_POR_DEFECTO }) {',
     'async crearEmpresa({ nombre, slug, servicios = [], pais = PAIS_POR_DEFECTO, moneda = MONEDA_POR_DEFECTO }) {'],
    ['        pais: normalizarPais(pais),\n',
     '        pais: normalizarPais(pais),\n        moneda: normalizarMoneda(moneda),\n'],
    ['    async crearUsuario(',
     '    // Cambia la moneda de la empresa. No convierte nada: los precios del catálogo y los de los documentos\n    // ya creados quedan como están, solo cambia la moneda con que se leen. Úsalo antes de cargar precios.\n    async fijarMoneda({ empresaId, moneda }) {\n      const r = await Empresa.updateOne({ _id: empresaId }, { moneda: normalizarMoneda(moneda) });\n      if (!r.matchedCount) throw new Error("empresa no encontrada");\n      return { ok: true };\n    },\n\n    async crearUsuario('],
  ]],
  ["src/index.js", [
    ['import { montarRutasClientes } from "./clientes/rutas.js";',
     'import { montarRutasClientes } from "./clientes/rutas.js";\nimport { crearServicioCatalogo } from "./catalogo/index.js";\nimport { montarRutasCatalogo } from "./catalogo/rutas.js";'],
    ['export { ErrorCliente } from "./clientes/errores.js";',
     'export { ErrorCliente } from "./clientes/errores.js";\nexport { ErrorCatalogo } from "./catalogo/errores.js";'],
    ['  core.auth.montarRutas = (router) => montarRutas(router, core);',
     '  core.catalogo = crearServicioCatalogo(core.modelos, core.auth);\n  core.auth.montarRutas = (router) => montarRutas(router, core);'],
    ['  core.clientes.montarRutas = (router) => montarRutasClientes(router, core);',
     '  core.clientes.montarRutas = (router) => montarRutasClientes(router, core);\n  core.catalogo.montarRutas = (router) => montarRutasCatalogo(router, core);'],
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
console.log(fallos ? `\n${fallos} edición(es) manual(es) pendiente(s).` : "\nListo. Ahora: node --test");
process.exit(fallos ? 1 : 0);
