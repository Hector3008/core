// Reseñas de platos (5.62). Sin base de datos: el servicio corre contra almacenes falsos en memoria.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { crearServicioResenas } from "../src/resenas/index.js";
import { montarRutasResenas } from "../src/resenas/rutas.js";
import { ErrorResena } from "../src/resenas/errores.js";
import { validarResena, nombrePublico, promedioDe, MAX_TEXTO } from "../src/resenas/validacion.js";
import { ErrorAuth } from "../src/auth/errores.js";
import { conEmpresa, empresaActual } from "../src/tenancy.js";

const E1 = "aaaaaaaaaaaaaaaaaaaaaaa1";
const E2 = "aaaaaaaaaaaaaaaaaaaaaaa2";
const C1 = "bbbbbbbbbbbbbbbbbbbbbbb1";
const C2 = "bbbbbbbbbbbbbbbbbbbbbbb2";
const C3 = "bbbbbbbbbbbbbbbbbbbbbbb3";
const ADM = { usuarioId: "0123456789abcdef01234567", permisos: ["*"] };
const LECTOR = { usuarioId: "0123456789abcdef01234568", permisos: ["resena:leer"] };
const MESERO = { usuarioId: "0123456789abcdef01234569", permisos: ["catalogo:leer"] };

const rechaza = (p, codigo, status) =>
  assert.rejects(p, (e) => e instanceof ErrorResena && e.codigo === codigo && (status === undefined || e.status === status));

// ---------- almacén falso ----------
function almacen(unico = null) {
  const filas = [];
  let n = 0;
  const propias = () => filas.filter((p) => p.empresaId === empresaActual());
  const valor = (d, k) => d[k];
  const coincide = (d, f) =>
    Object.entries(f).every(([k, v]) => {
      const x = valor(d, k);
      if (v && typeof v === "object" && !Array.isArray(v)) {
        if ("$in" in v) return v.$in.map(String).includes(String(x));
        if ("$gt" in v) return x > v.$gt;
        if ("$ne" in v) return Array.isArray(x) ? !x.map(String).includes(String(v.$ne)) : String(x) !== String(v.$ne);
      }
      return String(x) === String(v);
    });
  const consulta = (fn) => {
    const q = { _o: null, _s: 0, _l: Infinity };
    q.lean = () => q;
    q.select = () => q;
    q.sort = (o) => ((q._o = o), q);
    q.skip = (s) => ((q._s = s), q);
    q.limit = (l) => ((q._l = l), q);
    q.then = (ok, ko) =>
      Promise.resolve()
        .then(() => {
          let r = fn();
          if (Array.isArray(r)) {
            if (q._o) {
              const claves = Object.entries(q._o);
              r = [...r].sort((a, b) => {
                for (const [k, dir] of claves) {
                  const x = k === "createdAt" ? a.createdAt.getTime() : a[k];
                  const y = k === "createdAt" ? b.createdAt.getTime() : b[k];
                  if (x === y) continue;
                  return (x < y ? -1 : 1) * dir;
                }
                return 0;
              });
            }
            r = r.slice(q._s, q._s + q._l);
          }
          return structuredClone(r);
        })
        .then(ok, ko);
    return q;
  };
  return {
    filas,
    find: (f = {}) => consulta(() => propias().filter((p) => coincide(p, f))),
    findOne: (f) => consulta(() => propias().find((p) => coincide(p, f)) ?? null),
    async create(doc) {
      if (unico && propias().some((p) => unico.every((k) => String(p[k]) === String(doc[k])))) throw Object.assign(new Error("dup"), { code: 11000 });
      n += 1;
      const p = {
        _id: String(n).padStart(24, "0"), empresaId: empresaActual(), createdAt: new Date(Date.UTC(2026, 9, 20, 12, 0, n)), updatedAt: new Date(),
        oculta: false, reportadoPor: [], reportes: 0, ocultaPor: null, ocultaTs: null, ...structuredClone(doc),
      };
      filas.push(p);
      return { toObject: () => structuredClone(p) };
    },
    async updateOne(f, cambio) {
      const p = propias().find((x) => coincide(x, f));
      if (!p) return { matchedCount: 0 };
      if (cambio.$set) Object.assign(p, structuredClone(cambio.$set));
      for (const [k, v] of Object.entries(cambio.$addToSet ?? {})) if (!p[k].map(String).includes(String(v))) p[k].push(v);
      for (const [k, v] of Object.entries(cambio.$inc ?? {})) p[k] = (p[k] ?? 0) + v;
      p.updatedAt = new Date(p.updatedAt.getTime() + 1000);
      return { matchedCount: 1 };
    },
    async deleteOne(f) {
      const i = filas.findIndex((x) => x.empresaId === empresaActual() && coincide(x, f));
      if (i < 0) return { deletedCount: 0 };
      filas.splice(i, 1);
      return { deletedCount: 1 };
    },
    // Solo la forma que usa deItem: $match + $group de total y suma de estrellas
    aggregate(pipeline) {
      return consulta(() => {
        const sel = propias().filter((p) => coincide(p, pipeline[0].$match));
        return sel.length ? [{ _id: null, total: sel.length, suma: sel.reduce((s, p) => s + p.estrellas, 0) }] : [];
      });
    },
  };
}

function crearMundo() {
  const Resena = almacen(["itemClave", "clienteId"]);
  const Cliente = almacen();
  const Item = almacen();
  const auth = {
    exigirCsrf(req) {
      if (req.method !== "GET" && !req.headers?.["x-requested-with"]) throw new ErrorAuth("CSRF", "falta la cabecera x-requested-with");
    },
  };
  const servicio = crearServicioResenas({ Resena, Cliente, Item }, auth);
  const pagados = new Set(); // "empresa|cliente|codigo"
  servicio.definirFuenteConsumo(async ({ empresaId, clienteId, itemCodigo }) => pagados.has(`${empresaId}|${clienteId}|${itemCodigo}`));
  const en = (e, fn) => conEmpresa(e, fn);
  const sembrar = async () => {
    for (const e of [E1, E2]) {
      await en(e, () => Item.create({ codigo: "Moka", codigoClave: "moka", nombre: "Moka", activo: true }));
      await en(e, () => Item.create({ codigo: "Latte", codigoClave: "latte", nombre: "Latte", activo: true }));
    }
    for (const [id, nombre] of [[C1, "María del Carmen Pérez"], [C2, "Diego"], [C3, "Cliente anonimizado"]]) {
      await en(E1, async () => {
        const c = await Cliente.create({ nombre });
        c.toObject; // eslint-disable-line no-unused-expressions
      });
      // los ids de cliente de la prueba son fijos: se reasignan
      const f = Cliente.filas.filter((x) => x.empresaId === E1 && x.nombre === nombre);
      f[0]._id = id;
    }
  };
  const guardar = (c, datos, e = E1, codigo = "Moka") => en(e, () => servicio.guardarMia({ empresaId: e, clienteId: c, itemCodigo: codigo, ...datos }));
  return { servicio, Resena, Cliente, Item, pagados, en, sembrar, guardar };
}

describe("validación y nombre público", () => {
  it("estrellas enteras de 1 a 5 y texto opcional con tope", () => {
    assert.deepEqual(validarResena({ estrellas: 5 }), { estrellas: 5, texto: null });
    assert.deepEqual(validarResena({ estrellas: 3, texto: "  rico \n" }), { estrellas: 3, texto: "rico" });
    assert.equal(validarResena({ estrellas: 4, texto: "   " }).texto, null);
    for (const e of [0, 6, 3.5, "5", null, undefined]) assert.throws(() => validarResena({ estrellas: e }), ErrorResena);
    assert.throws(() => validarResena({ estrellas: 5, texto: "x".repeat(MAX_TEXTO + 1) }), ErrorResena);
    assert.doesNotThrow(() => validarResena({ estrellas: 5, texto: "x".repeat(MAX_TEXTO) }));
    assert.throws(() => validarResena({ estrellas: 5, texto: 7 }), ErrorResena);
    assert.throws(() => validarResena({ estrellas: 5, clienteId: "x" }), /no admitidos/);
    assert.throws(() => validarResena(null), ErrorResena);
  });
  it("quita caracteres de control pero conserva saltos de línea", () => {
    assert.equal(validarResena({ estrellas: 5, texto: "a\u0000b\nc\u0007" }).texto, "ab\nc");
  });
  it("autor: primer nombre + inicial; anonimizado o vacío = Anónimo", () => {
    assert.equal(nombrePublico("María del Carmen Pérez"), "María P.");
    assert.equal(nombrePublico("  diego   ñandú "), "diego Ñ.");
    assert.equal(nombrePublico("Diego"), "Diego");
    assert.equal(nombrePublico("Cliente anonimizado"), "Anónimo");
    assert.equal(nombrePublico(""), "Anónimo");
    assert.equal(nombrePublico(null), "Anónimo");
  });
  it("promedio con un decimal", () => {
    assert.equal(promedioDe(14, 3), 4.7);
    assert.equal(promedioDe(0, 0), null);
  });
});

describe("reseñas: cliente", () => {
  let m;
  beforeEach(async () => {
    m = crearMundo();
    await m.sembrar();
    m.pagados.add(`${E1}|${C1}|Moka`);
    m.pagados.add(`${E1}|${C2}|Moka`);
  });

  it("solo opina quien pagó el plato", async () => {
    await rechaza(m.guardar(C3, { estrellas: 5 }), "NO_PERMITIDO", 403);
    await rechaza(m.guardar(C1, { estrellas: 5 }, E1, "Latte"), "NO_PERMITIDO", 403); // pagó Moka, no Latte
    const r = await m.guardar(C1, { estrellas: 5, texto: "Muy rico" });
    assert.equal(r.estrellas, 5);
    assert.equal(r.oculta, false);
    assert.equal(m.Resena.filas.length, 1);
  });
  it("el código no distingue mayúsculas y se guarda el del catálogo", async () => {
    const r = await m.guardar(C1, { estrellas: 4 }, E1, "  MOKA ");
    assert.equal(r.itemCodigo, "Moka");
    assert.equal(m.Resena.filas[0].itemClave, "moka");
  });
  it("lo pagado en otra empresa no vale", async () => {
    m.pagados.add(`${E2}|${C3}|Moka`);
    await rechaza(m.guardar(C3, { estrellas: 5 }, E1), "NO_PERMITIDO");
  });
  it("una por cliente y plato: volver a enviar la edita", async () => {
    await m.guardar(C1, { estrellas: 5, texto: "a" });
    const r = await m.guardar(C1, { estrellas: 2, texto: "b" });
    assert.equal(m.Resena.filas.length, 1);
    assert.equal(r.estrellas, 2);
    assert.equal(r.texto, "b");
  });
  it("datos inválidos, plato inexistente, id inválido y sin fuente de consumo", async () => {
    await rechaza(m.guardar(C1, { estrellas: 9 }), "DATOS_INVALIDOS", 400);
    await rechaza(m.guardar(C1, { estrellas: 5 }, E1, "nope"), "NO_ENCONTRADO", 404);
    await rechaza(m.guardar("x", { estrellas: 5 }), "DATOS_INVALIDOS");
    await rechaza(m.guardar(C1, { estrellas: 5 }, E1, ""), "DATOS_INVALIDOS");
    const sin = crearServicioResenas({ Resena: m.Resena, Cliente: m.Cliente, Item: m.Item }, {});
    await rechaza(m.en(E1, () => sin.guardarMia({ empresaId: E1, clienteId: C1, itemCodigo: "Moka", estrellas: 5 })), "ESTADO_INVALIDO", 409);
  });
  it("un plato dado de baja ya no se reseña", async () => {
    m.Item.filas.find((i) => i.codigoClave === "moka" && i.empresaId === E1).activo = false;
    await rechaza(m.guardar(C1, { estrellas: 5 }), "NO_ENCONTRADO");
  });
  it("borrar la propia; sin reseña da NO_ENCONTRADO", async () => {
    await m.guardar(C1, { estrellas: 5 });
    await m.en(E1, () => m.servicio.borrarMia({ empresaId: E1, clienteId: C1, itemCodigo: "moka" }));
    assert.equal(m.Resena.filas.length, 0);
    await rechaza(m.en(E1, () => m.servicio.borrarMia({ empresaId: E1, clienteId: C1, itemCodigo: "moka" })), "NO_ENCONTRADO");
  });
  it("una reseña oculta por el personal sigue oculta si el cliente la edita", async () => {
    const r = await m.guardar(C1, { estrellas: 1, texto: "ofensivo" });
    await m.en(E1, () => m.servicio.moderar({ empresaId: E1, actor: ADM, resenaId: r.id, oculta: true }));
    const otra = await m.guardar(C1, { estrellas: 1, texto: "ofensivo otra vez" });
    assert.equal(otra.oculta, true);
  });
});

describe("reseñas: lectura pública", () => {
  let m;
  const ver = (o = {}, e = E1) => m.en(e, () => m.servicio.deItem({ empresaId: e, itemCodigo: "moka", ...o }));
  beforeEach(async () => {
    m = crearMundo();
    await m.sembrar();
    m.pagados.add(`${E1}|${C1}|Moka`);
    m.pagados.add(`${E1}|${C2}|Moka`);
  });

  it("sin reseñas: total 0 y promedio null", async () => {
    const r = await ver();
    assert.deepEqual([r.total, r.promedio, r.resenas.length, r.mia], [0, null, 0, null]);
  });
  it("total, promedio, autor público y la más reciente primero; sin ids de cliente", async () => {
    await m.guardar(C1, { estrellas: 5, texto: "primera" });
    await m.guardar(C2, { estrellas: 4 });
    const r = await ver();
    assert.equal(r.total, 2);
    assert.equal(r.promedio, 4.5);
    assert.deepEqual(r.resenas.map((x) => x.autor), ["Diego", "María P."]);
    assert.equal(r.resenas[1].texto, "primera");
    assert.ok(!JSON.stringify(r).includes(C1));
    assert.equal(r.mia, null);
  });
  it("`mia` y la marca mia solo salen para el cliente que mira", async () => {
    await m.guardar(C1, { estrellas: 5 });
    await m.guardar(C2, { estrellas: 3 });
    const r = await ver({ clienteId: C1 });
    assert.equal(r.mia.estrellas, 5);
    assert.deepEqual(r.resenas.map((x) => x.mia), [false, true]);
    const anonimo = await ver();
    assert.deepEqual(anonimo.resenas.map((x) => x.mia), [false, false]);
  });
  it("las ocultas no cuentan ni se ven, pero su autor aún ve la suya marcada", async () => {
    const a = await m.guardar(C1, { estrellas: 1 });
    await m.guardar(C2, { estrellas: 5 });
    await m.en(E1, () => m.servicio.moderar({ empresaId: E1, actor: ADM, resenaId: a.id, oculta: true }));
    const r = await ver({ clienteId: C1 });
    assert.equal(r.total, 1);
    assert.equal(r.promedio, 5);
    assert.equal(r.resenas.length, 1);
    assert.equal(r.mia.oculta, true);
  });
  it("una ficha anonimizada sale como Anónimo", async () => {
    m.pagados.add(`${E1}|${C3}|Moka`);
    await m.guardar(C3, { estrellas: 4 });
    assert.equal((await ver()).resenas[0].autor, "Anónimo");
  });
  it("aislada por empresa y paginada", async () => {
    await m.guardar(C1, { estrellas: 5 });
    await m.guardar(C2, { estrellas: 4 });
    assert.equal((await ver({}, E2)).total, 0);
    const p = await ver({ limite: 1 });
    assert.equal(p.resenas.length, 1);
    assert.equal(p.total, 2);
    const q = await ver({ limite: 1, saltar: 1 });
    assert.equal(q.resenas[0].autor, "María P.");
  });
});

describe("reseñas: reportar y moderar", () => {
  let m;
  let r1;
  const rep = (c, id) => m.en(E1, () => m.servicio.reportar({ empresaId: E1, clienteId: c, resenaId: id }));
  const mod = (actor, id, oculta) => m.en(E1, () => m.servicio.moderar({ empresaId: E1, actor, resenaId: id, oculta }));
  const lista = (actor, o = {}) => m.en(E1, () => m.servicio.listar({ empresaId: E1, actor, ...o }));
  beforeEach(async () => {
    m = crearMundo();
    await m.sembrar();
    for (const c of [C1, C2, C3]) m.pagados.add(`${E1}|${c}|Moka`);
    r1 = await m.guardar(C1, { estrellas: 1, texto: "mala" });
    await m.guardar(C2, { estrellas: 5 });
  });

  it("reportar suma una vez por cliente; no la propia; no una oculta o inexistente", async () => {
    await rep(C2, r1.id);
    await rep(C2, r1.id);
    assert.equal(m.Resena.filas[0].reportes, 1);
    await rep(C3, r1.id);
    assert.equal(m.Resena.filas[0].reportes, 2);
    await rechaza(rep(C1, r1.id), "ESTADO_INVALIDO", 409);
    await rechaza(rep(C2, "0".repeat(24).replace(/0$/, "9")), "NO_ENCONTRADO", 404);
    await rechaza(rep(C2, "zz"), "DATOS_INVALIDOS");
    await mod(ADM, r1.id, true);
    await rechaza(rep(C3, r1.id), "NO_ENCONTRADO");
  });
  it("listar exige resena:leer (o gestionar); la reportada va primero y trae el nombre del plato", async () => {
    await rep(C2, r1.id);
    await rechaza(lista(MESERO), "PERMISO_INSUFICIENTE", 403);
    await rechaza(lista(null), "PERMISO_INSUFICIENTE");
    const todas = await lista(LECTOR);
    assert.equal(todas.length, 2);
    assert.equal(todas[0].id, r1.id);
    assert.equal(todas[0].reportes, 1);
    assert.equal(todas[0].itemNombre, "Moka");
    assert.equal(todas[0].autor, "María P.");
    assert.deepEqual((await lista(LECTOR, { filtro: "reportadas" })).map((x) => x.id), [r1.id]);
    await rechaza(lista(LECTOR, { filtro: "otra" }), "DATOS_INVALIDOS");
  });
  it("ocultar exige resena:gestionar; el lector no puede", async () => {
    await rechaza(mod(LECTOR, r1.id, true), "PERMISO_INSUFICIENTE", 403);
    const r = await mod(ADM, r1.id, true);
    assert.equal(r.oculta, true);
    assert.equal(m.Resena.filas[0].ocultaPor, ADM.usuarioId);
    assert.deepEqual((await lista(LECTOR, { filtro: "ocultas" })).map((x) => x.id), [r1.id]);
  });
  it("mostrarla de nuevo limpia los reportes; repetir una acción no cambia nada; valida entradas", async () => {
    await rep(C2, r1.id);
    await mod(ADM, r1.id, true);
    const r = await mod(ADM, r1.id, false);
    assert.equal(r.oculta, false);
    assert.equal(r.reportes, 0);
    assert.equal(m.Resena.filas[0].ocultaTs, null);
    await mod(ADM, r1.id, false);
    await rechaza(mod(ADM, r1.id, "si"), "DATOS_INVALIDOS");
    await rechaza(mod(ADM, "nope", true), "DATOS_INVALIDOS");
    await rechaza(mod(ADM, "f".repeat(24), true), "NO_ENCONTRADO");
  });
});

describe("rutas y manejadores", () => {
  it("rutas del personal en orden y con su permiso", () => {
    const rutas = [];
    const router = { get: (...a) => rutas.push(["GET", ...a]), put: (...a) => rutas.push(["PUT", ...a]) };
    const pedidos = [];
    montarRutasResenas(router, {
      resenas: { manejadores: { listar: "L", moderar: "M" } },
      autenticar: () => "auth",
      requierePermiso: (p) => (pedidos.push(p), `perm:${p}`),
    });
    assert.deepEqual(pedidos, ["resena:leer", "resena:gestionar"]);
    assert.deepEqual(rutas.map((r) => [r[0], r[1]]), [["GET", "/"], ["PUT", "/:resenaId/visibilidad"]]);
    assert.deepEqual(rutas[0].slice(2), ["auth", "perm:resena:leer", "L"]);
  });

  it("manejadores: listar con query, moderar con CSRF y errores con su status", async () => {
    const m = crearMundo();
    await m.sembrar();
    m.pagados.add(`${E1}|${C1}|Moka`);
    const r1 = await m.guardar(C1, { estrellas: 2 });
    const res = () => {
      const o = { cuerpo: null };
      o.status = (c) => ((o.codigo = c), o);
      o.json = (b) => ((o.cuerpo = b), o);
      return o;
    };
    const req = (extra = {}) => ({ method: "GET", headers: {}, auth: { empresaId: E1, usuarioId: ADM.usuarioId }, rol: { permisos: ["*"] }, ...extra });
    const a = res();
    await m.en(E1, () => m.servicio.manejadores.listar(req({ query: { filtro: "todas", limite: "5" } }), a, (e) => { throw e; }));
    assert.equal(a.codigo, 200);
    assert.equal(a.cuerpo.resenas.length, 1);
    const b = res();
    await m.en(E1, () => m.servicio.manejadores.moderar(req({ method: "PUT", params: { resenaId: r1.id }, body: { oculta: true } }), b, (e) => { throw e; }));
    assert.equal(b.codigo, 403); // sin x-requested-with
    const c = res();
    await m.en(E1, () => m.servicio.manejadores.moderar(req({ method: "PUT", headers: { "x-requested-with": "x" }, params: { resenaId: r1.id }, body: { oculta: true } }), c, (e) => { throw e; }));
    assert.equal(c.codigo, 200);
    assert.equal(c.cuerpo.oculta, true);
    const d = res();
    await m.en(E1, () => m.servicio.manejadores.listar(req({ rol: { permisos: [] }, query: {} }), d, (e) => { throw e; }));
    assert.equal(d.codigo, 403);
    const e = res();
    await m.en(E1, () => m.servicio.manejadores.listar(req({ query: { limite: "abc" } }), e, (x) => { throw x; }));
    assert.equal(e.codigo, 200); // un límite raro vuelve al valor por defecto
  });
});
