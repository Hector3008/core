// Requiere una MongoDB real: MONGODB_URI=mongodb://localhost:27017 node --test
// Cubre lo que depende de MongoDB de verdad: el índice único del código, el upsert de la importación,
// el aggregate de categorías y el aislamiento entre empresas. La lógica fina está en catalogo-logica.test.js.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { createCore } from "../src/index.js";

const uri = process.env.MONGODB_URI;
const opts = { skip: uri ? false : "define MONGODB_URI para correr esta prueba" };
const COLECCIONES = ["empresas", "usuarios", "roles", "membresias", "catalogo_items"];

const rechaza = (p, codigo, status) =>
  assert.rejects(p, (e) => e.codigo === codigo && (status === undefined || e.status === status));

describe("catálogo (MongoDB real)", opts, () => {
  let conn, core, cat, e1, e2, e3;
  const ADM = { usuarioId: "0123456789abcdef01234567", permisos: ["*"] };
  const EDITOR = { usuarioId: "0123456789abcdef01234568", permisos: ["catalogo:leer", "catalogo:crear", "catalogo:editar"] };

  before(async () => {
    conn = await mongoose.createConnection(uri, { dbName: "core-test-catalogo" }).asPromise();
    for (const c of COLECCIONES) await conn.db.dropCollection(c).catch(() => {});
    core = createCore({ connection: conn });
    cat = core.catalogo;
    await cat.listo();
    e1 = await core.empresas.crearEmpresa({ nombre: "Cafe Uno", slug: "uno", servicios: ["restaurante"] });
    e2 = await core.empresas.crearEmpresa({ nombre: "Repuestos Dos", slug: "dos", servicios: ["siscore"], moneda: "usd" });
    e3 = await core.empresas.crearEmpresa({ nombre: "Cafe Tres", slug: "tres", servicios: ["restaurante"] });
  });
  after(async () => {
    for (const c of COLECCIONES) await conn.db.dropCollection(c).catch(() => {});
    await conn.close();
  });

  const nuevo = (extra = {}, empresa = e1, actor = ADM) =>
    cat.crear({ empresaId: empresa._id, actor, codigo: "CAF-01", nombre: "Café americano", ...extra });

  it("moneda de la empresa: PEN por defecto, la indicada si se da, fijarla después y empresas sin el campo", async () => {
    assert.equal(e1.moneda, "PEN");
    assert.equal(e2.moneda, "USD");
    await assert.rejects(core.empresas.crearEmpresa({ nombre: "X", slug: "x-m", moneda: "ZZZ" }), /moneda inválida/);
    assert.equal(await cat.moneda({ empresaId: e2._id }), "USD");
    await core.empresas.fijarMoneda({ empresaId: e3._id, moneda: "ars" });
    assert.equal(await cat.moneda({ empresaId: e3._id }), "ARS");
    await assert.rejects(core.empresas.fijarMoneda({ empresaId: e3._id, moneda: "ZZZ" }), /moneda inválida/);
    await core.modelos.Empresa.collection.updateOne({ _id: e3._id }, { $unset: { moneda: "" } });
    assert.equal(await cat.moneda({ empresaId: e3._id }), "PEN");
  });

  it("crear: solo código y nombre; categoría y precio opcionales; precio con 2 decimales", async () => {
    const a = await nuevo();
    assert.equal(a.precio, null);
    assert.equal(a.categoria, null);
    const b = await nuevo({ codigo: "CAF-02", nombre: "Cappuccino", categoria: "Bebidas", precio: 7.9, atributos: { TAMANO: "grande" } });
    assert.equal(b.precio, 7.9);
    assert.deepEqual(b.atributos, { TAMANO: "grande" });
    await rechaza(nuevo({ codigo: "CAF-03", precio: 1.999 }), "DATOS_INVALIDOS");
  });

  it("código único por empresa sin distinguir mayúsculas: el índice de MongoDB lo hace valer y el 409 dice con quién choca", async () => {
    const a = await nuevo({ codigo: "ZM-100", nombre: "Uno" });
    await assert.rejects(nuevo({ codigo: "zm-100", nombre: "Otro" }), (e) => {
      assert.equal(e.codigo, "ITEM_DUPLICADO");
      assert.equal(e.status, 409);
      assert.equal(e.detalle.campo, "codigo");
      assert.equal(e.detalle.itemId, a.id);
      return true;
    });
    await assert.doesNotReject(nuevo({ codigo: "ZM-100", nombre: "En otra empresa" }, e2));
  });

  it("creaciones simultáneas del mismo código: una sola gana", async () => {
    const r = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => nuevo({ codigo: "PAR-1", nombre: `Intento ${i}` })));
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    assert.ok(r.filter((x) => x.status === "rejected").every((x) => x.reason.codigo === "ITEM_DUPLICADO"));
  });

  it("obtener por código sin mayúsculas; actualizar combina atributos; el código no cambia", async () => {
    const i = await nuevo({ codigo: "ZM-200", nombre: "Filtro", atributos: { A: 1, B: 2 } });
    assert.equal((await cat.obtener({ empresaId: e1._id, codigo: "zm-200" })).id, i.id);
    const r = await cat.actualizar({ empresaId: e1._id, actor: EDITOR, itemId: i.id, atributos: { B: null, C: 3 }, precio: 10 });
    assert.deepEqual(r.atributos, { A: 1, C: 3 });
    assert.equal(r.precio, 10);
    await rechaza(cat.actualizar({ empresaId: e1._id, actor: EDITOR, itemId: i.id, codigo: "ZM-201" }), "DATOS_INVALIDOS");
  });

  it("listar, buscar por código o nombre y categorías (aggregate con la empresa activa)", async () => {
    await nuevo({ codigo: "BEB-1", nombre: "Limonada", categoria: "Bebidas" });
    await nuevo({ codigo: "POS-1", nombre: "Torta tres leches", categoria: "Postres" });
    const cods = (await cat.buscar({ empresaId: e1._id, texto: "beb-" })).map((i) => i.codigo);
    assert.deepEqual(cods, ["BEB-1"]);
    assert.ok((await cat.buscar({ empresaId: e1._id, texto: "leches" })).some((i) => i.codigo === "POS-1"));
    const cs = await cat.categorias({ empresaId: e1._id });
    assert.ok(cs.some((c) => c.categoria === "Postres" && c.cantidad === 1));
    assert.ok(cs.some((c) => c.categoria === "Bebidas" && c.cantidad >= 2));
    // la otra empresa no ve estas categorías
    assert.deepEqual(await cat.categorias({ empresaId: e3._id }), []);
  });

  it("aislamiento: una empresa no ve ni toca los ítems de otra", async () => {
    const i = await nuevo({ codigo: "SOLO-E1", nombre: "Privado" });
    await rechaza(cat.obtener({ empresaId: e3._id, itemId: i.id }), "NO_ENCONTRADO");
    await rechaza(cat.actualizar({ empresaId: e3._id, actor: ADM, itemId: i.id, nombre: "Hackeado" }), "NO_ENCONTRADO");
    await rechaza(cat.instantanea({ empresaId: e3._id, items: ["SOLO-E1"] }), "ITEM_NO_DISPONIBLE");
    assert.equal((await cat.obtener({ empresaId: e1._id, itemId: i.id })).nombre, "Privado");
  });

  it("desactivar y reactivar", async () => {
    const i = await nuevo({ codigo: "BAJA-1", nombre: "Para baja" });
    await cat.desactivar({ empresaId: e1._id, actor: ADM, itemId: i.id });
    assert.ok(!(await cat.listar({ empresaId: e1._id, texto: "baja-1" })).length);
    assert.equal((await cat.listar({ empresaId: e1._id, texto: "baja-1", incluirInactivos: true })).length, 1);
    await rechaza(cat.instantanea({ empresaId: e1._id, items: ["BAJA-1"] }), "ITEM_NO_DISPONIBLE");
    await cat.reactivar({ empresaId: e1._id, actor: ADM, itemId: i.id });
    assert.equal((await cat.instantanea({ empresaId: e1._id, items: ["BAJA-1"] })).length, 1);
  });

  it("instantanea: ítems del catálogo y líneas libres (siscore), sin guardar las libres", async () => {
    await cat.crear({ empresaId: e2._id, actor: ADM, codigo: "ZM-9600025", nombre: "Filtro de aceite", categoria: "Filtros", precio: 25.9, atributos: { MARCA: "Bosch", EQUIVALENTES: [{ codigo: "ZM-2", stock: 3 }] } });
    const antes = (await cat.listar({ empresaId: e2._id, incluirInactivos: true, limite: 200 })).length;
    const r = await cat.instantanea({
      empresaId: e2._id,
      items: [{ codigo: "zm-9600025", cantidad: 2 }, { libre: { nombre: "Empaquetadura aún sin código", precio: 12.5, atributos: { MARCA: "Victor" } } }],
    });
    assert.equal(r[0].origen, "catalogo");
    assert.equal(r[0].codigo, "ZM-9600025");
    assert.deepEqual(r[0].atributos.EQUIVALENTES, [{ codigo: "ZM-2", stock: 3 }]);
    assert.deepEqual({ origen: r[1].origen, itemId: r[1].itemId, codigo: r[1].codigo, precio: r[1].precio }, { origen: "libre", itemId: null, codigo: null, precio: 12.5 });
    assert.equal((await cat.listar({ empresaId: e2._id, incluirInactivos: true, limite: 200 })).length, antes, "la línea libre no se guarda en el catálogo");
    await rechaza(cat.instantanea({ empresaId: e2._id, items: [{ libre: { nombre: "Copia", codigo: "ZM-9600025" } }] }), "CODIGO_EN_CATALOGO", 409);
  });

  it("importar: crea y actualiza por código con upsert, es idempotente y no pisa lo que no viene", async () => {
    await cat.crear({ empresaId: e2._id, actor: ADM, codigo: "IMP-1", nombre: "Viejo", categoria: "X", precio: 1, atributos: { K: 1 } });
    const filas = [
      { codigo: "imp-1", precio: 2.5, atributos: { J: 2 } },
      { codigo: "IMP-2", nombre: "Nuevo", categoria: "Y", precio: 4 },
      { codigo: "IMP-3", nombre: "Sin precio", atributos: { L: null, M: 1 } },
    ];
    const sim = await cat.importar({ empresaId: e2._id, actor: ADM, filas, simular: true });
    assert.deepEqual({ c: sim.creados, a: sim.actualizados }, { c: 2, a: 1 });
    await rechaza(cat.obtener({ empresaId: e2._id, codigo: "IMP-2" }), "NO_ENCONTRADO"); // simular no escribió
    const r = await cat.importar({ empresaId: e2._id, actor: ADM, filas });
    assert.deepEqual({ c: r.creados, a: r.actualizados, o: r.omitidos }, { c: 2, a: 1, o: [] });
    const a1 = await cat.obtener({ empresaId: e2._id, codigo: "IMP-1" });
    assert.deepEqual({ n: a1.nombre, c: a1.categoria, p: a1.precio, a: a1.atributos }, { n: "Viejo", c: "X", p: 2.5, a: { K: 1, J: 2 } });
    const i3 = await cat.obtener({ empresaId: e2._id, codigo: "IMP-3" });
    assert.deepEqual({ p: i3.precio, c: i3.categoria, a: i3.atributos, act: i3.activo }, { p: null, c: null, a: { M: 1 }, act: true });
    const r2 = await cat.importar({ empresaId: e2._id, actor: ADM, filas });
    assert.deepEqual({ c: r2.creados, a: r2.actualizados }, { c: 0, a: 3 });
    const todos = await cat.listar({ empresaId: e2._id, texto: "imp-", limite: 200 });
    assert.equal(todos.length, 3, "no se duplicó ningún ítem");
  });

  it("importar: todo o nada ante una fila inválida", async () => {
    const antes = (await cat.listar({ empresaId: e1._id, incluirInactivos: true, limite: 200 })).length;
    await assert.rejects(
      cat.importar({ empresaId: e1._id, actor: ADM, filas: [{ codigo: "TON-1", nombre: "Bien" }, { codigo: "TON-2", nombre: "Mal", precio: 1.234 }] }),
      (e) => e.codigo === "IMPORTACION_INVALIDA" && e.status === 400 && e.detalle.errores[0].fila === 2,
    );
    assert.equal((await cat.listar({ empresaId: e1._id, incluirInactivos: true, limite: 200 })).length, antes);
  });

  it("importar: no reactiva los desactivados", async () => {
    const i = await cat.crear({ empresaId: e2._id, actor: ADM, codigo: "IMP-BAJA", nombre: "x" });
    await cat.desactivar({ empresaId: e2._id, actor: ADM, itemId: i.id });
    const r = await cat.importar({ empresaId: e2._id, actor: ADM, filas: [{ codigo: "IMP-BAJA", precio: 3 }] });
    assert.deepEqual(r.inactivos, ["IMP-BAJA"]);
    const d = await cat.obtener({ empresaId: e2._id, itemId: i.id });
    assert.deepEqual({ p: d.precio, a: d.activo }, { p: 3, a: false });
  });

  it("esquema de atributos: valida por tipo contra la base real", async () => {
    cat.registrarEsquema({ campos: { STOCK_MIN: "numero" } });
    await rechaza(nuevo({ codigo: "ESQ-1", atributos: { STOCK_MIN: "mucho" } }), "DATOS_INVALIDOS");
    const i = await nuevo({ codigo: "ESQ-2", atributos: { STOCK_MIN: 5 } });
    assert.equal(i.atributos.STOCK_MIN, 5);
  });
});
