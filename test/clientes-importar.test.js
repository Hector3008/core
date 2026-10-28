// Importación en bloque de clientes (5.64). Sin base de datos: el servicio corre contra un almacén falso en memoria.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { crearServicioClientes } from "../src/clientes/index.js";
import { montarRutasClientes } from "../src/clientes/rutas.js";
import { ErrorCliente } from "../src/clientes/errores.js";
import { limpiarFila, planificar, MAX_FILAS_IMPORTACION } from "../src/clientes/importar.js";
import { empresaActual } from "../src/tenancy.js";

const E1 = "aaaaaaaaaaaaaaaaaaaaaaa1";
const E2 = "aaaaaaaaaaaaaaaaaaaaaaa2";
const ADM = { usuarioId: "0123456789abcdef01234567", permisos: ["*"] };
const MESERO = { usuarioId: "0123456789abcdef01234568", permisos: ["cliente:leer", "cliente:crear", "cliente:editar"] };
const rechaza = (p, codigo) => assert.rejects(p, (e) => e instanceof ErrorCliente && e.codigo === codigo);

function almacen() {
  const filas = [];
  let n = 0;
  const propias = () => filas.filter((c) => c.empresaId === empresaActual());
  const coincide = (c, f) =>
    Object.entries(f).every(([k, v]) => {
      if (k === "$or") return v.some((x) => coincide(c, x));
      if (v && typeof v === "object" && "$in" in v) return v.$in.includes(c[k]);
      if (k === "anonimizadoTs") return (c[k] ?? null) === v;
      return String(c[k]) === String(v);
    });
  const unico = (doc, ignorar) => {
    for (const k of ["telefono", "correo"])
      if (doc[k] && propias().some((c) => c._id !== ignorar && c[k] === doc[k])) {
        const e = new Error("dup");
        e.code = 11000;
        e.keyPattern = { [k]: 1 };
        throw e;
      }
  };
  return {
    filas,
    find: (f) => ({ lean: async () => structuredClone(propias().filter((c) => coincide(c, f))) }),
    create: async (doc) => {
      unico(doc);
      const c = { _id: `c${++n}`, empresaId: empresaActual(), activo: true, anonimizadoTs: null, ...structuredClone(doc) };
      filas.push(c);
      return { toObject: () => structuredClone(c) };
    },
    updateOne: async (f, upd) => {
      const c = propias().find((x) => coincide(x, f));
      if (!c) return { matchedCount: 0 };
      const nuevo = { ...c };
      for (const [k, v] of Object.entries(upd.$set ?? {})) {
        if (k.startsWith("redes.")) nuevo.redes = { ...(nuevo.redes ?? {}), [k.slice(6)]: v };
        else nuevo[k] = v;
      }
      unico(nuevo, c._id);
      Object.assign(c, nuevo);
      return { matchedCount: 1 };
    },
  };
}

describe("importar clientes: filas y plan (puro)", () => {
  it("las celdas vacías y los campos ajenos no pasan", () => {
    assert.deepEqual(limpiarFila({ nombre: " Ana ", telefono: "", correo: null, redes: { instagram: "", tiktok: "ana" }, preferencias: { x: 1 }, consentimientos: {}, activo: false }), {
      nombre: " Ana ",
      redes: { tiktok: "ana" },
    });
    assert.throws(() => limpiarFila([]), ErrorCliente);
    assert.throws(() => limpiarFila({ redes: "x" }), ErrorCliente);
  });

  it("exige teléfono o correo, y nombre si es nuevo", () => {
    const { errores } = planificar([{ nombre: "Sin contacto" }, { telefono: "987654321" }, { nombre: "Ok", telefono: "911222333" }], { paisEmpresa: "PE" });
    assert.deepEqual(errores.map((e) => e.fila), [1, 2]);
    assert.match(errores[0].error, /teléfono o el correo/);
    assert.match(errores[1].error, /falta el nombre/);
  });

  it("repetidos dentro del archivo, aunque se escriban distinto", () => {
    const { errores } = planificar([{ nombre: "A", telefono: "987 654 321" }, { nombre: "B", telefono: "+51987654321" }, { nombre: "C", correo: "X@a.com" }, { nombre: "D", correo: "x@a.com" }], { paisEmpresa: "PE" });
    assert.equal(errores.length, 2);
    assert.match(errores[0].error, /fila 1/);
    assert.match(errores[1].error, /fila 3/);
  });

  it("teléfono de uno y correo de otro es conflicto", () => {
    const existentes = [{ _id: "1", telefono: "+51987654321" }, { _id: "2", correo: "b@a.com" }];
    const { errores } = planificar([{ telefono: "987654321", correo: "b@a.com" }], { paisEmpresa: "PE", existentes });
    assert.match(errores[0].error, /de un cliente y el correo de otro/);
  });
});

describe("core.clientes.importar", () => {
  let Cliente, cl, ctx;
  const A = () => ({ Empresa: { findById: (id) => ({ lean: async () => ({ _id: id, activa: true, pais: "PE" }) }) }, Cliente, SesionCliente: {} });
  const correr = (empresa, fn) => import("../src/tenancy.js").then((t) => t.conEmpresa(empresa, fn));
  const imp = (args, empresa = E1) => correr(empresa, () => cl.importar({ empresaId: empresa, actor: ADM, ...args }));
  beforeEach(() => {
    Cliente = almacen();
    cl = crearServicioClientes(A(), { exigirCsrf() {} });
    ctx = Cliente.filas;
  });

  it("crea los nuevos, normaliza y no otorga consentimientos", async () => {
    const r = await imp({ filas: [{ nombre: "Ana", telefono: "987 654 321", correo: "ANA@x.com", redes: { instagram: "@Ana.P" }, direccion: "Av. 1" }, { nombre: "Beto", correo: "beto@x.com" }] });
    assert.deepEqual([r.creados, r.actualizados, r.inactivos, r.simulado], [2, 0, [], false]);
    assert.equal(ctx[0].telefono, "+51987654321");
    assert.equal(ctx[0].correo, "ana@x.com");
    assert.deepEqual(ctx[0].redes, { instagram: "ana.p" });
    assert.equal(ctx[0].consentimientos, undefined);
    assert.equal(ctx[0].creadoPor, ADM.usuarioId);
  });

  it("repetir el mismo archivo no duplica: actualiza", async () => {
    const filas = [{ nombre: "Ana", telefono: "987654321" }];
    await imp({ filas });
    const r = await imp({ filas });
    assert.deepEqual([r.creados, r.actualizados], [0, 1]);
    assert.equal(ctx.length, 1);
  });

  it("actualiza por teléfono o por correo y solo toca lo que trae", async () => {
    await imp({ filas: [{ nombre: "Ana", telefono: "987654321", correo: "ana@x.com", direccion: "Vieja" }] });
    // una fila la reconoce por el correo y la otra por el teléfono: las dos son la misma persona
    const r = await imp({ filas: [{ nombre: "Ana María", correo: "ana@x.com" }, { telefono: "+51987654321", redes: { tiktok: "anita" } }] });
    assert.deepEqual([r.creados, r.actualizados], [0, 2]);
    assert.equal(ctx[0].nombre, "Ana María");
    assert.equal(ctx[0].direccion, "Vieja");
    assert.equal(ctx[0].redes.tiktok, "anita");
  });

  it("cambiar el teléfono de alguien identificado por su correo", async () => {
    await imp({ filas: [{ nombre: "Ana", correo: "ana@x.com" }] });
    await imp({ filas: [{ telefono: "999111222", correo: "ana@x.com" }] });
    assert.equal(ctx.length, 1);
    assert.equal(ctx[0].telefono, "+51999111222");
  });

  it("todo o nada: una fila inválida no guarda ninguna y lista los problemas", async () => {
    await assert.rejects(
      imp({ filas: [{ nombre: "Ok", telefono: "987654321" }, { nombre: "Mal", telefono: "12" }, { telefono: "911111111" }] }),
      (e) => e.codigo === "IMPORTACION_INVALIDA" && e.status === 400 && e.detalle.total === 2 && e.detalle.errores[0].fila === 2,
    );
    assert.equal(ctx.length, 0);
  });

  it("simular cuenta sin escribir", async () => {
    await imp({ filas: [{ nombre: "Ana", telefono: "987654321" }] });
    const r = await imp({ simular: true, filas: [{ nombre: "Ana", telefono: "987654321" }, { nombre: "Beto", correo: "b@x.com" }] });
    assert.deepEqual([r.creados, r.actualizados, r.simulado], [1, 1, true]);
    assert.equal(ctx.length, 1);
  });

  it("a un desactivado lo actualiza, no lo reactiva, y lo avisa", async () => {
    await imp({ filas: [{ nombre: "Ana", telefono: "987654321" }] });
    ctx[0].activo = false;
    const r = await imp({ filas: [{ nombre: "Ana B", telefono: "987654321" }] });
    assert.deepEqual(r.inactivos, [1]);
    assert.equal(ctx[0].activo, false);
    assert.equal(ctx[0].nombre, "Ana B");
  });

  it("un anonimizado no se reconoce: su teléfono ya no existe, se crea otro", async () => {
    await imp({ filas: [{ nombre: "Ana", telefono: "987654321" }] });
    Object.assign(ctx[0], { telefono: undefined, nombre: "(anonimizado)", anonimizadoTs: new Date() });
    const r = await imp({ filas: [{ nombre: "Ana otra vez", telefono: "987654321" }] });
    assert.equal(r.creados, 1);
  });

  it("aísla por empresa", async () => {
    await imp({ filas: [{ nombre: "Ana", telefono: "987654321" }] });
    const r = await imp({ filas: [{ nombre: "Ana", telefono: "987654321" }] }, E2);
    assert.deepEqual([r.creados, r.actualizados], [1, 0]);
    assert.equal(ctx.length, 2);
  });

  it("choque con la base entre validar y escribir: se omite, no se pisa", async () => {
    const original = Cliente.create;
    Cliente.create = async (doc) => {
      const e = new Error("dup");
      e.code = 11000;
      throw e;
    };
    const r = await imp({ filas: [{ nombre: "Ana", telefono: "987654321" }] });
    assert.deepEqual([r.creados, r.omitidos], [0, [1]]);
    Cliente.create = original;
  });

  it("límites y permisos", async () => {
    await rechaza(imp({ filas: [] }), "DATOS_INVALIDOS");
    await rechaza(imp({ filas: Array.from({ length: MAX_FILAS_IMPORTACION + 1 }, () => ({})) }), "DATOS_INVALIDOS");
    await rechaza(imp({ filas: "x" }), "DATOS_INVALIDOS");
    await rechaza(correr(E1, () => cl.importar({ empresaId: E1, actor: MESERO, filas: [{ nombre: "A", telefono: "987654321" }] })), "PERMISO_INSUFICIENTE");
    await rechaza(correr(E1, () => cl.importar({ empresaId: E1, filas: [{ nombre: "A", telefono: "987654321" }] })), "PERMISO_INSUFICIENTE");
  });

  it("ruta POST /importar con cliente:gestionar, antes de /:clienteId", async () => {
    const rutas = [];
    const r = { get: (...a) => rutas.push(["GET", ...a]), post: (...a) => rutas.push(["POST", ...a]), put: (...a) => rutas.push(["PUT", ...a]) };
    montarRutasClientes(r, { clientes: cl, autenticar: () => "auth", requierePermiso: (p) => `perm:${p}` });
    const i = rutas.findIndex((x) => x[0] === "POST" && x[1] === "/importar");
    assert.ok(i >= 0);
    assert.ok(rutas[i].includes("perm:cliente:gestionar"));
    assert.ok(i < rutas.findIndex((x) => x[1] === "/:clienteId"));
  });

  it("el manejador exige x-requested-with y responde el resumen", async () => {
    let exigido = 0;
    const cl2 = crearServicioClientes(A(), { exigirCsrf: () => exigido++ });
    const res = { status(c) { this.c = c; return this; }, json(b) { this.b = b; return this; } };
    const req = { auth: { empresaId: E1, usuarioId: ADM.usuarioId }, rol: { permisos: ["*"] }, body: { simular: true, filas: [{ nombre: "A", telefono: "987654321" }] } };
    await correr(E1, () => cl2.manejadores.importar(req, res, (e) => { throw e; }));
    assert.equal(exigido, 1);
    assert.equal(res.c, 200);
    assert.equal(res.b.creados, 1);
  });
});
