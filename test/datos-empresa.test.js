import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ErrorAuth } from "../src/auth/errores.js";
import { crearServicioDatos } from "../src/auth/datos.js";
import { datosDe, emisorDe, validarDatos } from "../src/datos-empresa.js";

const malo = (fn, re) => assert.throws(fn, (e) => e instanceof ErrorAuth && e.codigo === "DATOS_INVALIDOS" && (!re || re.test(e.message)));
const VACIOS = { razonSocial: null, idFiscal: null, direccion: null, telefono: null, pie: null };

describe("validarDatos", () => {
  it("normaliza espacios, pone el RUC en mayúsculas y devuelve todos los campos", () => {
    const d = validarDatos({ razonSocial: "  Café   Central S.A.C. ", idFiscal: "20123456789", direccion: " Av. Siempre Viva 123 ", telefono: "+51 987 654 321", pie: "Gracias por tu visita" });
    assert.deepEqual(d, { razonSocial: "Café Central S.A.C.", idFiscal: "20123456789", direccion: "Av. Siempre Viva 123", telefono: "+51 987 654 321", pie: "Gracias por tu visita" });
    assert.equal(validarDatos({ idFiscal: "ab-1234.5/6" }).idFiscal, "AB-1234.5/6");
  });
  it("superpone sobre lo guardado y quita con null o vacío", () => {
    const actual = validarDatos({ direccion: "Calle 1", pie: "Hola" });
    assert.deepEqual(validarDatos({ pie: null, direccion: "  " }, actual), VACIOS);
    assert.equal(validarDatos({ telefono: "999 111 222" }, actual).direccion, "Calle 1");
  });
  it("rechaza lo que no es un objeto, campos desconocidos, cuerpo vacío y valores mal formados", () => {
    for (const v of [null, "x", [], 3]) malo(() => validarDatos(v), /objeto/);
    malo(() => validarDatos({ web: "x" }), /no admitidos \(web\)/);
    malo(() => validarDatos({}), /nada que cambiar/);
    malo(() => validarDatos({ razonSocial: 5 }), /razonSocial/);
    malo(() => validarDatos({ razonSocial: "a".repeat(81) }), /razonSocial/);
    malo(() => validarDatos({ idFiscal: "123" }), /idFiscal/);
    malo(() => validarDatos({ idFiscal: "12 345 678" }), /idFiscal/);
    malo(() => validarDatos({ idFiscal: "a".repeat(21) }), /idFiscal/);
    malo(() => validarDatos({ telefono: "llamar al 999" }), /telefono/);
    malo(() => validarDatos({ pie: "uno\u0007dos" }), /pie/);
    malo(() => validarDatos({ direccion: "d".repeat(121) }), /direccion/);
  });
  it("los saltos de línea se vuelven espacios", () => {
    assert.equal(validarDatos({ pie: "uno\ndos" }).pie, "uno dos");
  });
});

describe("datosDe y emisorDe", () => {
  it("una empresa sin datos devuelve todo en null y un valor guardado mal formado se ignora", () => {
    assert.deepEqual(datosDe(null), VACIOS);
    assert.deepEqual(datosDe({ datos: { idFiscal: "1", telefono: "x", pie: 5, direccion: "Calle 1" } }), { ...VACIOS, direccion: "Calle 1" });
  });
  it("el emisor junta nombre, datos y logo, con la etiqueta fiscal según el país", () => {
    const e = { nombre: "Café Central", pais: "pe", datos: { razonSocial: "Café Central SAC", idFiscal: "20123456789", pie: "Gracias" }, marca: { logo: "https://e.com/l.png" } };
    assert.deepEqual(emisorDe(e), { nombre: "Café Central", razonSocial: "Café Central SAC", idFiscal: "20123456789", etiquetaIdFiscal: "RUC", direccion: null, telefono: null, pie: "Gracias", logo: "https://e.com/l.png" });
    assert.equal(emisorDe({ ...e, pais: "AR" }).etiquetaIdFiscal, "ID fiscal");
    assert.equal(emisorDe({ nombre: "X" }).etiquetaIdFiscal, "RUC"); // sin país se asume PE
  });
  it("un logo que no es https no sale, y nunca lanza", () => {
    assert.equal(emisorDe({ nombre: "X", marca: { logo: "javascript:alert(1)" } }).logo, null);
    assert.deepEqual(emisorDe(null).nombre, "");
  });
});

describe("datos de la empresa (servicio y manejadores)", () => {
  function montar(inicial) {
    const e = { _id: "E1", activa: true, nombre: "Café Central", ...inicial };
    const Empresa = {
      findById: (id) => ({ lean: async () => (id === e._id ? structuredClone(e) : null) }),
      updateOne: async (f, c) => {
        e.datos ??= {};
        for (const [k, v] of Object.entries(c.$set ?? {})) e.datos[k.replace("datos.", "")] = v;
        for (const k of Object.keys(c.$unset ?? {})) delete e.datos[k.replace("datos.", "")];
      },
    };
    const base = {
      responderError: (res, err, next) => (err instanceof ErrorAuth ? res.status(err.status).json({ error: err.message, codigo: err.codigo }) : next(err)),
      exigirCsrf: (req) => {
        if (!req.headers?.["x-requested-with"]) throw new ErrorAuth("CSRF", "falta x-requested-with");
      },
    };
    return { svc: crearServicioDatos({ Empresa }, base), e };
  }
  const res = () => {
    const r = { codigo: null, cuerpo: null, status(c) { r.codigo = c; return r; }, json(b) { r.cuerpo = b; return r; } };
    return r;
  };

  it("guarda, quita y devuelve lo guardado y la vista del recibo", async () => {
    const { svc, e } = montar({});
    let r = await svc.api.guardarDatos({ empresaId: "E1", cambios: { idFiscal: "20123456789", pie: "Gracias" } });
    assert.equal(r.datos.idFiscal, "20123456789");
    assert.equal(r.vista.nombre, "Café Central");
    assert.equal(r.vista.etiquetaIdFiscal, "RUC");
    r = await svc.api.guardarDatos({ empresaId: "E1", cambios: { pie: null } });
    assert.deepEqual(e.datos, { idFiscal: "20123456789" });
    assert.equal(r.datos.pie, null);
  });
  it("un cambio inválido no guarda nada, y una empresa inexistente da NO_ENCONTRADO", async () => {
    const { svc, e } = montar({ datos: { pie: "Antes" } });
    await assert.rejects(() => svc.api.guardarDatos({ empresaId: "E1", cambios: { pie: "Nuevo", idFiscal: "1" } }), (err) => err.codigo === "DATOS_INVALIDOS");
    assert.deepEqual(e.datos, { pie: "Antes" });
    await assert.rejects(() => svc.api.leerDatos({ empresaId: "otra" }), (err) => err.codigo === "NO_ENCONTRADO");
  });
  it("PUT exige x-requested-with; un dato inválido responde 400", async () => {
    const { svc, e } = montar({});
    const sin = res();
    await svc.manejadores.guardarDatos({ method: "PUT", headers: {}, auth: { empresaId: "E1" }, body: { pie: "Hola" } }, sin, assert.fail);
    assert.equal(sin.codigo, 403);
    assert.equal(e.datos, undefined);
    const mal = res();
    await svc.manejadores.guardarDatos({ method: "PUT", headers: { "x-requested-with": "fetch" }, auth: { empresaId: "E1" }, body: { idFiscal: "1" } }, mal, assert.fail);
    assert.equal(mal.codigo, 400);
    const ok = res();
    await svc.manejadores.guardarDatos({ method: "PUT", headers: { "x-requested-with": "fetch" }, auth: { empresaId: "E1" }, body: { pie: "Hola" } }, ok, assert.fail);
    assert.equal(ok.codigo, 200);
    const lee = res();
    await svc.manejadores.leerDatos({ auth: { empresaId: "E1" } }, lee, assert.fail);
    assert.equal(lee.cuerpo.datos.pie, "Hola");
  });
});
