import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ErrorAuth } from "../src/auth/errores.js";
import { crearServicioMarca } from "../src/auth/marca.js";

// Empresa falsa en memoria: findById().lean() y updateOne con $set / $unset de «marca.campo».
function empresaFalsa(inicial) {
  const e = { _id: "E1", activa: true, ...inicial };
  const Empresa = {
    findById: (id) => ({ lean: async () => (id === e._id ? structuredClone(e) : null) }),
    updateOne: async (filtro, cambios) => {
      assert.equal(filtro._id, "E1");
      e.marca ??= {};
      for (const [k, v] of Object.entries(cambios.$set ?? {})) e.marca[k.replace("marca.", "")] = v;
      for (const k of Object.keys(cambios.$unset ?? {})) delete e.marca[k.replace("marca.", "")];
      return { matchedCount: 1 };
    },
  };
  return { Empresa, e };
}

function montar(inicial) {
  const { Empresa, e } = empresaFalsa(inicial);
  const csrf = [];
  const base = {
    responderError: (res, err, next) => {
      if (!(err instanceof ErrorAuth)) return next(err);
      return res.status(err.status).json({ error: err.message, codigo: err.codigo });
    },
    exigirCsrf: (req) => {
      csrf.push(req.method);
      if (req.headers?.["x-requested-with"] !== "fetch") throw new ErrorAuth("CSRF", "falta x-requested-with");
    },
  };
  return { svc: crearServicioMarca({ Empresa }, base), e, csrf };
}

const res = () => {
  const r = { codigo: null, cuerpo: null, status(c) { r.codigo = c; return r; }, json(b) { r.cuerpo = b; return r; } };
  return r;
};
const req = (cuerpo, extra = {}) => ({ method: "PUT", headers: { "x-requested-with": "fetch" }, auth: { empresaId: "E1" }, body: cuerpo, ...extra });

describe("marca de la empresa (servicio)", () => {
  it("una empresa sin marca devuelve todo en null y sin vista", async () => {
    const { svc } = montar({});
    const r = await svc.api.leerMarca({ empresaId: "E1" });
    assert.deepEqual(r, { marca: { logo: null, eslogan: null, colorPrincipal: null, colorSecundario: null, colorFondo: null }, vista: null });
  });
  it("guarda, devuelve lo guardado y la vista con la paleta", async () => {
    const { svc, e } = montar({});
    const r = await svc.api.guardarMarca({ empresaId: "E1", cambios: { logo: "https://e.com/l.png", colorPrincipal: "#8B1E3F", eslogan: "Hola" } });
    assert.equal(r.marca.colorPrincipal, "#8b1e3f");
    assert.equal(r.vista.colores["--color-principal"], "#8b1e3f");
    assert.deepEqual(e.marca, { logo: "https://e.com/l.png", colorPrincipal: "#8b1e3f", eslogan: "Hola" });
  });
  it("quitar un campo lo borra de la empresa y no toca los demás", async () => {
    const { svc, e } = montar({ marca: { logo: "https://e.com/l.png", colorPrincipal: "#8b1e3f" } });
    const r = await svc.api.guardarMarca({ empresaId: "E1", cambios: { colorPrincipal: null } });
    assert.equal(r.marca.colorPrincipal, null);
    assert.deepEqual(e.marca, { logo: "https://e.com/l.png" });
    assert.equal(r.vista.tema, null);
  });
  it("un cambio inválido no guarda nada", async () => {
    const { svc, e } = montar({ marca: { eslogan: "Antes" } });
    await assert.rejects(() => svc.api.guardarMarca({ empresaId: "E1", cambios: { eslogan: "Nuevo", colorPrincipal: "#f0ede4" } }), (err) => err.codigo === "DATOS_INVALIDOS");
    assert.deepEqual(e.marca, { eslogan: "Antes" });
  });
  it("empresa inexistente o dada de baja: NO_ENCONTRADO", async () => {
    const baja = montar({ activa: false });
    await assert.rejects(() => baja.svc.api.leerMarca({ empresaId: "E1" }), (err) => err.codigo === "NO_ENCONTRADO");
    await assert.rejects(() => montar({}).svc.api.leerMarca({ empresaId: "otra" }), (err) => err.codigo === "NO_ENCONTRADO");
  });
});

describe("marca de la empresa (manejadores)", () => {
  it("GET entrega la marca de la empresa de la sesión", async () => {
    const { svc } = montar({ marca: { eslogan: "Hola" } });
    const r = res();
    await svc.manejadores.leerMarca({ auth: { empresaId: "E1" } }, r, assert.fail);
    assert.equal(r.codigo, 200);
    assert.equal(r.cuerpo.marca.eslogan, "Hola");
  });
  it("PUT exige x-requested-with y guarda", async () => {
    const { svc, e, csrf } = montar({});
    const sin = res();
    await svc.manejadores.guardarMarca(req({ eslogan: "Hola" }, { headers: {} }), sin, assert.fail);
    assert.equal(sin.codigo, 403);
    assert.equal(sin.cuerpo.codigo, "CSRF");
    assert.equal(e.marca, undefined);
    const r = res();
    await svc.manejadores.guardarMarca(req({ eslogan: "Hola" }), r, assert.fail);
    assert.equal(r.codigo, 200);
    assert.equal(e.marca.eslogan, "Hola");
    assert.deepEqual(csrf, ["PUT", "PUT"]);
  });
  it("un dato inválido responde 400 con su mensaje", async () => {
    const { svc } = montar({});
    const r = res();
    await svc.manejadores.guardarMarca(req({ logo: "http://e.com/a.png" }), r, assert.fail);
    assert.equal(r.codigo, 400);
    assert.match(r.cuerpo.error, /logo/);
    assert.equal(r.cuerpo.codigo, "DATOS_INVALIDOS");
  });
  it("un cuerpo que no es un objeto responde 400", async () => {
    const { svc } = montar({});
    const r = res();
    await svc.manejadores.guardarMarca(req(undefined), r, assert.fail);
    assert.equal(r.codigo, 400);
  });
});
