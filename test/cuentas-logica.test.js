// No necesita base de datos: prueba la lógica de las cuentas de cliente contra almacenes falsos en memoria.
// Lo que depende de MongoDB de verdad (select:false del hash, TTL, tenancy) lo cubre cuentas.test.js.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { crearServicioCuentasCliente } from "../src/cuentas/index.js";
import { ErrorCliente } from "../src/clientes/errores.js";
import { ErrorAuth } from "../src/auth/errores.js";
import { conEmpresa, empresaActual } from "../src/tenancy.js";

const E1 = "aaaaaaaaaaaaaaaaaaaaaaa1";
const E2 = "aaaaaaaaaaaaaaaaaaaaaaa2";
const ADM = { usuarioId: "0123456789abcdef01234567", permisos: ["*"] };
const MESERO = { usuarioId: "0123456789abcdef01234568", permisos: ["cliente:leer", "cliente:crear", "cliente:cuenta"] };
const SOLO_LEER = { usuarioId: "0123456789abcdef01234569", permisos: ["cliente:leer", "cliente:crear"] };
const X = { "x-requested-with": "fetch" };

const rechaza = (p, ErrorClase, codigo, status) =>
  assert.rejects(p, (e) => e instanceof ErrorClase && e.codigo === codigo && (status === undefined || e.status === status));
const rechazaCliente = (p, codigo, status) => rechaza(p, ErrorCliente, codigo, status);
const rechazaAuth = (p, codigo, status) => rechaza(p, ErrorAuth, codigo, status);

// ---------- almacenes falsos ----------
function crearMundo({ referidos = null, ...opciones } = {}) {
  let ahora = 1_800_000_000_000;
  let n = 0;
  const clientesDocs = [];
  const sesiones = [];
  const propios = (arr) => arr.filter((d) => d.empresaId === empresaActual());
  const conseguir = (d, k) => k.split(".").reduce((o, p) => o?.[p], d);
  const poner = (d, k, v) => {
    const ps = k.split(".");
    let o = d;
    for (const p of ps.slice(0, -1)) o = o[p] ??= {};
    o[ps.at(-1)] = v;
  };
  const coincide = (d, f) =>
    Object.entries(f).every(([k, v]) => {
      const x = conseguir(d, k);
      if (v && typeof v === "object" && !(v instanceof Date) && "$ne" in v) return (x ?? null) !== v.$ne && String(x ?? null) !== String(v.$ne);
      if (v === null) return x === null || x === undefined;
      return String(x) === String(v);
    });
  const consulta = (fn) => {
    const q = { _sel: "" };
    q.lean = () => q;
    q.select = (s) => ((q._sel = s), q);
    q.then = (ok, ko) =>
      Promise.resolve()
        .then(() => {
          const r = fn();
          if (!r) return r;
          const c = structuredClone(r);
          // select:false del hash: solo sale si se pide con "+cuenta.passwordHash"
          if (c.cuenta && !q._sel.includes("+cuenta.passwordHash")) delete c.cuenta.passwordHash;
          return c;
        })
        .then(ok, ko);
    return q;
  };
  const Cliente = {
    docs: clientesDocs,
    findById: (id) => consulta(() => propios(clientesDocs).find((d) => d._id === String(id)) ?? null),
    findOne: (f) => consulta(() => propios(clientesDocs).find((d) => coincide(d, f)) ?? null),
    async updateOne(f, u) {
      const d = propios(clientesDocs).find((x) => coincide(x, f));
      if (!d) return { matchedCount: 0 };
      for (const [k, v] of Object.entries(u.$set ?? {})) poner(d, k, structuredClone(v));
      return { matchedCount: 1 };
    },
  };
  const SesionCliente = {
    docs: sesiones,
    async create(doc) {
      const s = { _id: String(++n).padStart(24, "s"), empresaId: empresaActual(), ...structuredClone(doc) };
      sesiones.push(s);
      return { ...s };
    },
    findOne(f) {
      return {
        then: (ok, ko) =>
          Promise.resolve()
            .then(() => {
              const s = propios(sesiones).find((d) => coincide(d, f));
              return s ? { ...structuredClone(s), $locals: {} } : null;
            })
            .then(ok, ko),
      };
    },
    async deleteOne(f) {
      const i = sesiones.findIndex((d) => d.empresaId === empresaActual() && coincide(d, f));
      if (i >= 0) sesiones.splice(i, 1);
      return { deletedCount: i >= 0 ? 1 : 0 };
    },
    async deleteMany(f) {
      let c = 0;
      for (let i = sesiones.length - 1; i >= 0; i--) {
        const d = sesiones[i];
        const idNe = f._id?.$ne;
        const ok = d.empresaId === empresaActual() && String(d.clienteId) === String(f.clienteId) && (idNe === undefined || d._id !== String(idNe));
        if (ok) (sesiones.splice(i, 1), c++);
      }
      return { deletedCount: c };
    },
    async updateOne(f, u) {
      const d = propios(sesiones).find((x) => coincide(x, f));
      if (d) Object.assign(d, u);
      return { matchedCount: d ? 1 : 0 };
    },
    init: async () => {},
  };
  const Empresa = {
    findById: (id) =>
      consulta(() => ({ _id: String(id), activa: true, pais: String(id) === E2 ? "AR" : "PE" })),
  };

  // clientes falsos: replican lo justo de core.clientes (crear con duplicado, obtener, consentimiento)
  const clientes = {
    async crear({ empresaId, actor, nombre, telefono, correo }) {
      if (!actor.permisos.includes("cliente:crear")) throw new ErrorCliente("PERMISO_INSUFICIENTE", "sin permiso");
      return conEmpresa(empresaId, async () => {
        const tel = telefono ? (telefono.startsWith("+") ? telefono : `+51${telefono.replace(/\D/g, "")}`) : null;
        const mail = correo ? correo.trim().toLowerCase() : null;
        for (const d of propios(clientesDocs)) {
          if (tel && d.telefono === tel) throw new ErrorCliente("CLIENTE_DUPLICADO", "ya existe un cliente con ese telefono", { campo: "telefono", clienteId: d._id });
          if (mail && d.correo === mail) throw new ErrorCliente("CLIENTE_DUPLICADO", "ya existe un cliente con ese correo", { campo: "correo", clienteId: d._id });
        }
        if (!nombre?.trim()) throw new ErrorCliente("DATOS_INVALIDOS", "nombre requerido (máximo 80 caracteres)");
        const d = {
          _id: String(++n).padStart(24, "c"),
          empresaId,
          nombre: nombre.trim(),
          telefono: tel,
          correo: mail,
          activo: true,
          anonimizadoTs: null,
          cuenta: null,
          consentimientos: { programaPuntos: null },
        };
        clientesDocs.push(d);
        return { id: d._id, nombre: d.nombre, telefono: tel, correo: mail };
      });
    },
    async obtener({ empresaId, clienteId }) {
      const d = clientesDocs.find((x) => x._id === String(clienteId) && x.empresaId === String(empresaId));
      if (!d) throw new ErrorCliente("NO_ENCONTRADO", "cliente no encontrado");
      return {
        id: d._id,
        nombre: d.nombre,
        correo: d.correo,
        telefono: d.telefono,
        activo: d.activo,
        anonimizado: !!d.anonimizadoTs,
        consentimientos: { programaPuntos: { otorgado: !!d.consentimientos.programaPuntos?.otorgado } },
      };
    },
    async cambiarConsentimiento({ empresaId, actor, clienteId, finalidad, otorgado, medio }) {
      if (!actor.permisos.includes("cliente:gestionar")) throw new ErrorCliente("PERMISO_INSUFICIENTE", "sin permiso");
      const d = clientesDocs.find((x) => x._id === String(clienteId) && x.empresaId === String(empresaId));
      d.consentimientos[finalidad] = { otorgado, medio, registradoPor: actor.usuarioId };
    },
  };

  const fidelizacion = {
    async resumen({ clienteId }) {
      return { habilitada: true, saldo: 120, movimientos: [], clienteId };
    },
  };
  const auth = {
    exigirCsrf(req) {
      if (req.method !== "GET" && !req.headers?.["x-requested-with"]) throw new ErrorAuth("CSRF", "falta la cabecera x-requested-with");
    },
  };

  const servicio = crearServicioCuentasCliente({ Empresa, Cliente, SesionCliente }, auth, clientes, fidelizacion, {
    ahora: () => ahora,
    ...opciones,
  }, referidos);
  return {
    servicio,
    Cliente,
    SesionCliente,
    clientes,
    avanzar: (ms) => (ahora += ms),
    ficha: (extra = {}) => clientes.crear({ empresaId: E1, actor: MESERO, nombre: "Ana Pérez", telefono: "987654321", ...extra }),
  };
}

const crear = (m, c, p = {}) =>
  m.servicio.crearCuenta({ empresaId: E1, actor: MESERO, clienteId: c.id, generarPassword: true, ...p });
const login = (m, usuario, password, extra = {}) =>
  m.servicio.login({ empresaId: E1, usuario, password, ip: "1.1.1.1", ...extra });
const sesionDe = (m, token) => m.servicio.obtenerSesion({ empresaId: E1, token });

describe("cuenta creada por el personal", () => {
  let m;
  beforeEach(() => {
    m = crearMundo();
  });

  it("genera una contraseña temporal, obliga a cambiarla y no guarda nada en claro", async () => {
    const c = await m.ficha();
    const r = await crear(m, c);
    assert.match(r.passwordTemporal, /^[A-Za-z0-9]{12}$/);
    assert.equal(r.telefono, "+51987654321");
    const guardado = m.Cliente.docs[0].cuenta;
    assert.equal(guardado.debeCambiarPassword, true);
    assert.equal(guardado.origen, "personal");
    assert.match(guardado.passwordHash, /^scrypt\$/);
    assert.ok(!JSON.stringify(guardado).includes(r.passwordTemporal));
  });

  it("acepta una contraseña dada por el personal (también es temporal) y valida la política", async () => {
    const c = await m.ficha();
    await rechazaCliente(crear(m, c, { generarPassword: false, password: "corta" }), "DATOS_INVALIDOS", 400);
    const r = await crear(m, c, { generarPassword: false, password: "Clave-larga-123" });
    assert.equal(r.passwordTemporal, "Clave-larga-123");
    assert.equal(m.Cliente.docs[0].cuenta.debeCambiarPassword, true);
  });

  it("exige una de las dos formas, no ninguna ni las dos", async () => {
    const c = await m.ficha();
    await rechazaCliente(m.servicio.crearCuenta({ empresaId: E1, actor: MESERO, clienteId: c.id }), "DATOS_INVALIDOS");
    await rechazaCliente(crear(m, c, { password: "Clave-larga-123" }), "DATOS_INVALIDOS");
    assert.equal(m.Cliente.docs[0].cuenta, null);
  });

  it("pide el permiso cliente:cuenta", async () => {
    const c = await m.ficha();
    await rechazaCliente(crear(m, c, { actor: SOLO_LEER }), "PERMISO_INSUFICIENTE", 403);
    await rechazaCliente(crear(m, c, { actor: undefined }), "PERMISO_INSUFICIENTE", 403);
    assert.equal(m.Cliente.docs[0].cuenta, null);
  });

  it("una sola cuenta por cliente; sin correo ni teléfono no hay usuario; desactivado o inexistente no", async () => {
    const c = await m.ficha();
    await crear(m, c);
    await rechazaCliente(crear(m, c), "ESTADO_INVALIDO", 409);
    const sin = await m.clientes.crear({ empresaId: E1, actor: MESERO, nombre: "Sin datos" });
    await rechazaCliente(crear(m, sin), "DATOS_INVALIDOS", 400);
    const otro = await m.ficha({ nombre: "Beto", telefono: "987000111" });
    m.Cliente.docs.find((d) => d._id === otro.id).activo = false;
    await rechazaCliente(crear(m, otro), "ESTADO_INVALIDO", 409);
    await rechazaCliente(crear(m, { id: "bbbbbbbbbbbbbbbbbbbbbbb9" }), "NO_ENCONTRADO", 404);
    await rechazaCliente(crear(m, { id: "no-es-un-id" }), "DATOS_INVALIDOS", 400);
  });

  it("restablecer: nueva temporal, cierra sus sesiones y la obliga a cambiarla", async () => {
    const c = await m.ficha();
    const { passwordTemporal } = await crear(m, c);
    const { token } = await login(m, "987654321", passwordTemporal);
    assert.ok(await sesionDe(m, token));
    const r = await m.servicio.restablecerPassword({ empresaId: E1, actor: MESERO, clienteId: c.id, generarPassword: true });
    assert.equal(r.sesionesCerradas, 1);
    assert.notEqual(r.passwordTemporal, passwordTemporal);
    assert.equal(await sesionDe(m, token), null);
    await rechazaAuth(login(m, "987654321", passwordTemporal), "CREDENCIALES_INVALIDAS", 401);
    const otra = await login(m, "987654321", r.passwordTemporal);
    assert.equal(otra.debeCambiarPassword, true);
  });

  it("restablecer exige cuenta existente y permiso", async () => {
    const c = await m.ficha();
    await rechazaCliente(m.servicio.restablecerPassword({ empresaId: E1, actor: MESERO, clienteId: c.id, generarPassword: true }), "ESTADO_INVALIDO", 409);
    await crear(m, c);
    await rechazaCliente(
      m.servicio.restablecerPassword({ empresaId: E1, actor: SOLO_LEER, clienteId: c.id, generarPassword: true }),
      "PERMISO_INSUFICIENTE",
      403,
    );
  });
});

describe("entrar", () => {
  let m, c, pass;
  beforeEach(async () => {
    m = crearMundo();
    c = await m.ficha({ correo: "Ana@Mail.com" });
    pass = (await crear(m, c)).passwordTemporal;
  });

  it("con el teléfono (como lo escriba) o con el correo (en cualquier mayúscula)", async () => {
    for (const u of ["987654321", "987 654 321", "+51 987 654 321", "ana@mail.com", " ANA@mail.COM "]) {
      const r = await login(m, u, pass);
      assert.equal(r.cliente.id, c.id, `usuario ${u}`);
      assert.equal(r.debeCambiarPassword, true);
      assert.ok(r.token.length >= 40);
    }
  });

  it("el token no se guarda en claro (solo su hash)", async () => {
    const { token } = await login(m, "987654321", pass);
    assert.ok(m.SesionCliente.docs.every((s) => s.tokenHash !== token && !JSON.stringify(s).includes(token)));
    assert.match(m.SesionCliente.docs[0].tokenHash, /^[0-9a-f]{64}$/);
  });

  it("mismo error si la contraseña es mala, el usuario no existe, no tiene forma o la cuenta no existe", async () => {
    const sinCuenta = await m.ficha({ nombre: "Sin cuenta", telefono: "987000222" });
    const mensajes = new Set();
    for (const [u, p] of [
      ["987654321", "mala-contraseña"],
      ["999111222", pass],
      ["no-es-usuario-valido", pass],
      ["otro@mail.com", pass],
      ["987000222", pass],
    ]) {
      await assert.rejects(login(m, u, p), (e) => {
        mensajes.add(`${e.codigo}|${e.status}|${e.message}`);
        return e instanceof ErrorAuth;
      });
    }
    assert.equal(mensajes.size, 1);
    assert.match([...mensajes][0], /^CREDENCIALES_INVALIDAS\|401\|/);
    void sinCuenta;
  });

  it("datos vacíos o enormes: DATOS_INVALIDOS", async () => {
    for (const [u, p] of [["", pass], ["987654321", ""], [5, pass], ["987654321", 5], ["x".repeat(300), pass], ["987654321", "p".repeat(2000)]])
      await rechazaAuth(login(m, u, p), "DATOS_INVALIDOS", 400);
  });

  it("un cliente desactivado o anonimizado no entra, aunque la contraseña sea buena", async () => {
    m.Cliente.docs[0].activo = false;
    await rechazaAuth(login(m, "987654321", pass), "CREDENCIALES_INVALIDAS");
    m.Cliente.docs[0].activo = true;
    m.Cliente.docs[0].anonimizadoTs = new Date();
    await rechazaAuth(login(m, "987654321", pass), "CREDENCIALES_INVALIDAS");
  });

  it("bloquea tras 5 fallos por usuario e IP (y avisa cuánto esperar); un acierto reinicia la cuenta", async () => {
    for (let i = 0; i < 4; i++) await rechazaAuth(login(m, "987654321", "mala"), "CREDENCIALES_INVALIDAS");
    assert.ok((await login(m, "987654321", pass)).token); // acierta antes del tope: reinicia
    for (let i = 0; i < 5; i++) await rechazaAuth(login(m, "987654321", "mala"), "CREDENCIALES_INVALIDAS");
    await assert.rejects(login(m, "987654321", pass), (e) => e.codigo === "DEMASIADOS_INTENTOS" && e.status === 429 && e.detalle.reintentarEnSeg > 0);
    m.avanzar(16 * 60_000); // pasa la ventana
    assert.ok((await login(m, "987654321", pass)).token);
  });

  it("los intentos de una IP se cuentan sobre todos los usuarios (30 por ventana)", async () => {
    for (let i = 0; i < 30; i++) await rechazaAuth(login(m, `99900${String(i).padStart(4, "0")}`, "mala", { ip: "9.9.9.9" }), "CREDENCIALES_INVALIDAS");
    await rechazaAuth(login(m, "987654321", pass, { ip: "9.9.9.9" }), "DEMASIADOS_INTENTOS", 429);
    assert.ok((await login(m, "987654321", pass, { ip: "8.8.8.8" })).token); // otra IP no está afectada
  });

  it("la cuenta es de una empresa: con la misma contraseña no entra en otra", async () => {
    await rechazaAuth(m.servicio.login({ empresaId: E2, usuario: "987654321", password: pass, ip: "1.1.1.1" }), "CREDENCIALES_INVALIDAS");
  });
});

describe("sesión", () => {
  let m, c, pass;
  beforeEach(async () => {
    m = crearMundo();
    c = await m.ficha();
    pass = (await crear(m, c)).passwordTemporal;
  });
  const DIA = 24 * 60 * 60_000;

  it("vale mientras se use, caduca por inactividad y tiene un tope absoluto", async () => {
    const { token } = await login(m, "987654321", pass);
    assert.ok(await sesionDe(m, token));
    m.avanzar(6 * DIA);
    assert.ok(await sesionDe(m, token), "se renueva al usarla");
    m.avanzar(6 * DIA);
    assert.ok(await sesionDe(m, token));
    m.avanzar(6 * DIA);
    assert.ok(await sesionDe(m, token));
    m.avanzar(8 * DIA); // sin usarla más de 7 días
    assert.equal(await sesionDe(m, token), null);
    assert.equal(m.SesionCliente.docs.length, 0, "la caducada se borra");

    const b = await login(m, "987654321", pass);
    for (let i = 0; i < 5; i++) {
      m.avanzar(6 * DIA);
      await sesionDe(m, b.token);
    }
    m.avanzar(1 * DIA); // 31 días desde que entró, aunque la usó siempre
    assert.equal(await sesionDe(m, b.token), null);
  });

  it("tokens inválidos devuelven null, nunca lanzan", async () => {
    for (const t of [undefined, null, "", "x", 5, "a".repeat(300), "token-que-no-existe"]) assert.equal(await sesionDe(m, t), null);
  });

  it("una sesión de otra empresa no vale aquí", async () => {
    const { token } = await login(m, "987654321", pass);
    assert.equal(await m.servicio.obtenerSesion({ empresaId: E2, token }), null);
    assert.ok(await sesionDe(m, token));
  });

  it("al desactivar, anonimizar o quitar la cuenta, la sesión muere al instante", async () => {
    for (const romper of [
      (d) => (d.activo = false),
      (d) => (d.anonimizadoTs = new Date()),
      (d) => (d.cuenta = null),
    ]) {
      const { token } = await login(m, "987654321", pass).catch(async () => {
        // tras romper el estado anterior hay que restaurarlo para volver a entrar
        Object.assign(m.Cliente.docs[0], { activo: true, anonimizadoTs: null });
        m.Cliente.docs[0].cuenta ??= null;
        throw new Error("no se pudo entrar");
      });
      romper(m.Cliente.docs[0]);
      assert.equal(await sesionDe(m, token), null);
      assert.equal(m.SesionCliente.docs.length, 0);
      // restaurar
      Object.assign(m.Cliente.docs[0], { activo: true, anonimizadoTs: null });
      if (!m.Cliente.docs[0].cuenta) {
        const r = await crear(m, c);
        pass = r.passwordTemporal;
      }
    }
  });

  it("cerrarSesion borra solo esa sesión", async () => {
    const a = await login(m, "987654321", pass);
    const b = await login(m, "987654321", pass);
    assert.equal(await m.servicio.cerrarSesion({ empresaId: E1, token: a.token }), true);
    assert.equal(await m.servicio.cerrarSesion({ empresaId: E1, token: a.token }), false);
    assert.equal(await m.servicio.cerrarSesion({ empresaId: E1, token: "" }), false);
    assert.ok(await sesionDe(m, b.token));
  });
});

describe("cambiar la contraseña", () => {
  let m, c, pass;
  beforeEach(async () => {
    m = crearMundo();
    c = await m.ficha();
    pass = (await crear(m, c)).passwordTemporal;
  });
  const cambiar = (p) => m.servicio.cambiarPassword({ empresaId: E1, clienteId: c.id, passwordNueva: "Otra-clave-segura-9", ...p });

  it("quita la marca de temporal, cierra las otras sesiones y deja abierta la actual", async () => {
    const a = await login(m, "987654321", pass);
    const b = await login(m, "987654321", pass);
    const sa = await sesionDe(m, a.token);
    const r = await cambiar({ passwordActual: pass, sesionId: sa._id });
    assert.deepEqual(r, { ok: true, sesionesCerradas: 1 });
    assert.ok(await sesionDe(m, a.token));
    assert.equal(await sesionDe(m, b.token), null);
    assert.equal(m.Cliente.docs[0].cuenta.debeCambiarPassword, false);
    assert.equal((await login(m, "987654321", "Otra-clave-segura-9")).debeCambiarPassword, false);
    await rechazaAuth(login(m, "987654321", pass), "CREDENCIALES_INVALIDAS");
  });

  it("valida la actual, la política y que sea distinta", async () => {
    await rechazaAuth(cambiar({ passwordActual: "mala" }), "CREDENCIALES_INVALIDAS", 401);
    await rechazaAuth(cambiar({ passwordActual: pass, passwordNueva: "corta" }), "DATOS_INVALIDOS", 400);
    await rechazaAuth(cambiar({ passwordActual: pass, passwordNueva: pass }), "DATOS_INVALIDOS", 400);
    await rechazaAuth(cambiar({ passwordActual: "" }), "DATOS_INVALIDOS", 400);
    await rechazaAuth(cambiar({ passwordActual: 5 }), "DATOS_INVALIDOS", 400);
    assert.equal(m.Cliente.docs[0].cuenta.debeCambiarPassword, true, "nada cambió");
  });

  it("limita los intentos (5 por cliente)", async () => {
    for (let i = 0; i < 5; i++) await rechazaAuth(cambiar({ passwordActual: "mala" }), "CREDENCIALES_INVALIDAS");
    await rechazaAuth(cambiar({ passwordActual: pass }), "DEMASIADOS_INTENTOS", 429);
  });
});

describe("auto-registro", () => {
  let m;
  beforeEach(() => {
    m = crearMundo();
  });
  const registrar = (extra = {}) =>
    m.servicio.registrar({ empresaId: E1, nombre: "Luz Ríos", telefono: "987111222", password: "Mi-clave-segura-1", ip: "3.3.3.3", ...extra });

  it("crea la ficha y la cuenta (sin cambio obligatorio), abre la sesión y no da puntos sin pedirlo", async () => {
    const r = await registrar();
    assert.equal(r.cliente.nombre, "Luz Ríos");
    const d = m.Cliente.docs[0];
    assert.equal(d.cuenta.origen, "autoregistro");
    assert.equal(d.cuenta.debeCambiarPassword, false);
    assert.equal(d.consentimientos.programaPuntos, null);
    assert.ok(await sesionDe(m, r.token));
    assert.equal((await login(m, "987111222", "Mi-clave-segura-1")).debeCambiarPassword, false);
  });

  it("con código de referido (5.45): lo vincula; código inválido se avisa antes de crear la ficha; apagado se ignora", async () => {
    const vinculos = [];
    let habilitada = true;
    const referidos = {
      config: async () => ({ habilitada }),
      buscarPorCodigo: async ({ codigo }) => (codigo === "BUENCOD" ? { _id: "x" } : null),
      vincular: async (a) => vinculos.push(a),
    };
    m = crearMundo({ referidos });
    await assert.rejects(registrar({ codigoReferido: "MALCODE" }), (e) => e.codigo === "DATOS_INVALIDOS");
    assert.equal(m.Cliente.docs.length, 0);
    const r = await registrar({ codigoReferido: "BUENCOD" });
    assert.equal(vinculos.length, 1);
    assert.equal(vinculos[0].codigo, "BUENCOD");
    assert.equal(vinculos[0].origen, "registro");
    assert.equal(vinculos[0].referidoId, r.cliente.id);
    habilitada = false;
    await registrar({ telefono: "987333444", codigoReferido: "MALCODE" }); // apagado: no estorba
    assert.equal(vinculos.length, 1);
  });

  it("si el vínculo falla después de crear la cuenta, el registro se conserva", async () => {
    const referidos = { config: async () => ({ habilitada: true }), buscarPorCodigo: async () => ({}), vincular: async () => { throw new Error("boom"); } };
    m = crearMundo({ referidos });
    const orig = console.error;
    console.error = () => {};
    try {
      const r = await registrar({ codigoReferido: "BUENCOD" });
      assert.ok(r.token);
    } finally {
      console.error = orig;
    }
  });

  it("con quierePuntos registra el consentimiento por formulario, a nombre del propio cliente", async () => {
    await registrar({ quierePuntos: true });
    const k = m.Cliente.docs[0].consentimientos.programaPuntos;
    assert.equal(k.otorgado, true);
    assert.equal(k.medio, "formulario");
    assert.equal(k.registradoPor, null);
  });

  it("solo se pasa nombre, teléfono, correo y país: lo demás del cuerpo no llega a la ficha", async () => {
    await registrar({ correo: "luz@mail.com", preferencias: { x: 1 }, activo: false, cuenta: "hack" });
    const d = m.Cliente.docs[0];
    assert.equal(d.correo, "luz@mail.com");
    assert.equal(d.activo, true);
    assert.equal(d.cuenta.origen, "autoregistro");
  });

  it("si ya hay una ficha con ese teléfono o correo se bloquea SIN decir de quién", async () => {
    const existente = await m.ficha({ telefono: "987111222", correo: "ana@mail.com" });
    for (const extra of [{ telefono: "987111222" }, { telefono: undefined, correo: "ANA@mail.com" }]) {
      await assert.rejects(registrar(extra), (e) => {
        assert.ok(e instanceof ErrorCliente);
        assert.equal(e.codigo, "REGISTRO_BLOQUEADO");
        assert.equal(e.status, 409);
        assert.equal(e.detalle, undefined, "no revela el id de la ficha");
        assert.ok(!JSON.stringify(e).includes(existente.id));
        assert.match(e.message, /Acércate al personal/);
        return true;
      });
    }
    assert.equal(m.Cliente.docs.length, 1);
    assert.equal(m.Cliente.docs[0].cuenta, null, "la ficha ajena no se tocó");
    assert.equal(m.SesionCliente.docs.length, 0);
  });

  it("exige teléfono o correo y una contraseña válida", async () => {
    await rechazaCliente(registrar({ telefono: undefined }), "DATOS_INVALIDOS", 400);
    await rechazaCliente(registrar({ telefono: "  ", correo: "" }), "DATOS_INVALIDOS", 400);
    await rechazaCliente(registrar({ password: "corta" }), "DATOS_INVALIDOS", 400);
    await rechazaCliente(registrar({ nombre: "" }), "DATOS_INVALIDOS", 400);
    assert.equal(m.Cliente.docs.length, 0, "ninguna dejó fichas a medias");
  });

  it("limita los registros por IP (10 por hora)", async () => {
    for (let i = 0; i < 10; i++) await registrar({ telefono: `98700${String(i).padStart(4, "0")}` });
    await rechazaAuth(registrar({ telefono: "987999999" }), "DEMASIADOS_INTENTOS", 429);
    await registrar({ telefono: "987999999", ip: "4.4.4.4" }); // otra IP
    m.avanzar(61 * 60_000);
    await registrar({ telefono: "987999998" });
  });
});

describe("consentimiento propio y perfil", () => {
  it("el cliente da y retira su consentimiento de puntos; solo ese, y solo el suyo", async () => {
    const m = crearMundo();
    const r = await m.servicio.registrar({ empresaId: E1, nombre: "Luz", telefono: "987111222", password: "Mi-clave-segura-1" });
    assert.deepEqual(await m.servicio.cambiarMiConsentimiento({ empresaId: E1, clienteId: r.cliente.id, otorgado: true }), { programaPuntos: true });
    assert.equal(m.Cliente.docs[0].consentimientos.programaPuntos.otorgado, true);
    await m.servicio.cambiarMiConsentimiento({ empresaId: E1, clienteId: r.cliente.id, otorgado: false });
    assert.equal(m.Cliente.docs[0].consentimientos.programaPuntos.otorgado, false);
    await rechazaCliente(m.servicio.cambiarMiConsentimiento({ empresaId: E1, clienteId: r.cliente.id, otorgado: "si" }), "DATOS_INVALIDOS");
  });

  it("yo: lo que ve de sí mismo y sus puntos", async () => {
    const m = crearMundo();
    const r = await m.servicio.registrar({ empresaId: E1, nombre: "Luz", telefono: "987111222", correo: "luz@mail.com", password: "Mi-clave-segura-1", quierePuntos: true });
    const y = await m.servicio.yo({ empresaId: E1, clienteId: r.cliente.id });
    assert.equal(y.sesion, true);
    assert.deepEqual(y.cliente, {
      id: r.cliente.id,
      nombre: "Luz",
      correo: "luz@mail.com",
      telefono: "+51987111222",
      programaPuntos: true,
      debeCambiarPassword: false,
    });
    assert.equal(y.puntos.saldo, 120);
  });
});

describe("manejadores HTTP de la cuenta del cliente", () => {
  const req = (o = {}) => ({ method: "GET", headers: {}, body: {}, params: {}, ip: "5.5.5.5", ...o });
  const res = () => ({
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  });
  const sigue = (e) => {
    throw e;
  };
  const cookieDe = (r) => String(r.headers["Set-Cookie"]).split(";")[0];
  let m, h, empresaDe;
  beforeEach(() => {
    m = crearMundo();
    empresaDe = async (req) => {
      if (req.params?.empresa === "no-existe") throw Object.assign(new Error("carta no encontrada"), { codigo: "NO_ENCONTRADO", status: 404 });
      return { id: E1, slug: "cafe-uno" };
    };
    h = m.servicio.manejadores({ empresaDe });
  });
  const entrar = async (usuario, password) => {
    const r = res();
    await h.login(req({ method: "POST", headers: X, body: { usuario, password } }), r, sigue);
    return r;
  };

  it("registro: 201, cookie cs_<slug> HttpOnly SameSite=Lax, y devuelve la vista del cliente", async () => {
    const r = res();
    await h.registro(
      req({ method: "POST", headers: X, body: { nombre: "Luz", telefono: "987111222", password: "Mi-clave-segura-1", quierePuntos: true } }),
      r,
      sigue,
    );
    assert.equal(r.statusCode, 201);
    assert.match(r.headers["Set-Cookie"], /^cs_cafe-uno=[^;]+; Path=\/; HttpOnly; SameSite=Lax/);
    assert.equal(r.headers["Cache-Control"], "no-store");
    assert.equal(r.body.sesion, true);
    assert.equal(r.body.cliente.programaPuntos, true);
    assert.ok(!JSON.stringify(r.body).includes("passwordHash"));
  });

  it("login + yo con la cookie; yo sin cookie dice sesion:false; con cookie vieja la borra", async () => {
    const c = await m.ficha();
    const { passwordTemporal } = await crear(m, c);
    const l = await entrar("987654321", passwordTemporal);
    assert.equal(l.statusCode, 200);
    assert.equal(l.body.cliente.debeCambiarPassword, true);
    const cookie = cookieDe(l);

    const con = res();
    await h.yo(req({ headers: { cookie } }), con, sigue);
    assert.equal(con.body.sesion, true);
    assert.equal(con.body.cliente.nombre, "Ana Pérez");

    const sin = res();
    await h.yo(req(), sin, sigue);
    assert.deepEqual(sin.body, { sesion: false });
    assert.equal(sin.headers["Set-Cookie"], undefined);

    const vieja = res();
    await h.yo(req({ headers: { cookie: "cs_cafe-uno=token-viejo" } }), vieja, sigue);
    assert.deepEqual(vieja.body, { sesion: false });
    assert.match(vieja.headers["Set-Cookie"], /Max-Age=0/);

    const otraEmpresaCookie = res();
    await h.yo(req({ headers: { cookie: "cs_otra=" + cookie.split("=")[1] } }), otraEmpresaCookie, sigue);
    assert.deepEqual(otraEmpresaCookie.body, { sesion: false }, "la cookie de otra empresa no se lee");
  });

  it("login: credenciales malas dan 401 sin pistas; sin x-requested-with, 403", async () => {
    const c = await m.ficha();
    await crear(m, c);
    const mala = await entrar("987654321", "mala");
    assert.equal(mala.statusCode, 401);
    assert.equal(mala.body.codigo, "CREDENCIALES_INVALIDAS");
    assert.equal(mala.headers["Set-Cookie"], undefined);
    const sinCsrf = res();
    await h.login(req({ method: "POST", body: { usuario: "987654321", password: "x" } }), sinCsrf, sigue);
    assert.equal(sinCsrf.statusCode, 403);
    assert.equal(sinCsrf.body.codigo, "CSRF");
  });

  it("429 trae Retry-After", async () => {
    const c = await m.ficha();
    await crear(m, c);
    for (let i = 0; i < 5; i++) await entrar("987654321", "mala");
    const r = await entrar("987654321", "mala");
    assert.equal(r.statusCode, 429);
    assert.ok(Number(r.headers["Retry-After"]) > 0);
    assert.equal(r.body.reintentarEnSeg, undefined, "no se vuelca el detalle");
  });

  it("registro bloqueado: 409 sin ids", async () => {
    const e = await m.ficha({ telefono: "987111222" });
    const r = res();
    await h.registro(req({ method: "POST", headers: X, body: { nombre: "Otra", telefono: "987111222", password: "Mi-clave-segura-1" } }), r, sigue);
    assert.equal(r.statusCode, 409);
    assert.equal(r.body.codigo, "REGISTRO_BLOQUEADO");
    assert.ok(!JSON.stringify(r.body).includes(e.id));
  });

  it("con contraseña temporal pendiente solo se puede ver, cambiar la contraseña o salir", async () => {
    const c = await m.ficha();
    const { passwordTemporal } = await crear(m, c);
    const cookie = cookieDe(await entrar("987654321", passwordTemporal));

    const consent = res();
    await h.consentimiento(req({ method: "PUT", headers: { ...X, cookie }, body: { otorgado: true } }), consent, sigue);
    assert.equal(consent.statusCode, 403);
    assert.equal(consent.body.codigo, "CAMBIO_PASSWORD_REQUERIDO");

    const cambio = res();
    await h.password(
      req({ method: "POST", headers: { ...X, cookie }, body: { passwordActual: passwordTemporal, passwordNueva: "Mi-clave-segura-1" } }),
      cambio,
      sigue,
    );
    assert.equal(cambio.statusCode, 200);

    const ahora = res();
    await h.consentimiento(req({ method: "PUT", headers: { ...X, cookie }, body: { otorgado: true } }), ahora, sigue);
    assert.equal(ahora.statusCode, 200);
    assert.deepEqual(ahora.body, { programaPuntos: true });

    const salir = res();
    await h.logout(req({ method: "POST", headers: { ...X, cookie } }), salir, sigue);
    assert.equal(salir.statusCode, 200);
    assert.match(salir.headers["Set-Cookie"], /Max-Age=0/);
    const despues = res();
    await h.yo(req({ headers: { cookie } }), despues, sigue);
    assert.deepEqual(despues.body, { sesion: false });
  });

  it("password y consentimiento sin sesión: 401 y borra la cookie", async () => {
    for (const [nombre, metodo, body] of [["password", "POST", { passwordActual: "x", passwordNueva: "y" }], ["consentimiento", "PUT", { otorgado: true }]]) {
      const r = res();
      await h[nombre](req({ method: metodo, headers: X, body }), r, sigue);
      assert.equal(r.statusCode, 401, nombre);
      assert.equal(r.body.codigo, "SIN_SESION");
      assert.match(r.headers["Set-Cookie"], /Max-Age=0/);
    }
  });

  it("una empresa que no existe: el error de empresaDe se traduce tal cual (404)", async () => {
    const r = res();
    await h.yo(req({ params: { empresa: "no-existe" } }), r, sigue);
    assert.equal(r.statusCode, 404);
    assert.equal(r.body.codigo, "NO_ENCONTRADO");
  });

  it("un error inesperado pasa a next, no se responde con su texto", async () => {
    const roto = m.servicio.manejadores({ empresaDe: async () => ({ id: E1, slug: "x" }) });
    const original = m.Cliente.findOne;
    m.Cliente.findOne = () => {
      throw new Error("falla interna secreta");
    };
    const r = res();
    let recibido;
    await roto.login(req({ method: "POST", headers: X, body: { usuario: "987654321", password: "x" } }), r, (e) => (recibido = e));
    m.Cliente.findOne = original;
    assert.match(recibido.message, /falla interna secreta/);
    assert.equal(r.body, undefined);
  });
});

describe("autenticarCliente (middleware para rutas del cliente)", () => {
  const empresaDe = async () => ({ id: E1, slug: "cafe-uno" });
  const res = () => ({
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  });

  it("deja req.cliente (y nunca req.auth) y corre el resto dentro de la empresa", async () => {
    const m = crearMundo();
    const c = await m.ficha();
    const { passwordTemporal } = await crear(m, c);
    const { token } = await login(m, "987654321", passwordTemporal);
    const s0 = await sesionDe(m, token);
    await m.servicio.cambiarPassword({ empresaId: E1, clienteId: c.id, passwordActual: passwordTemporal, passwordNueva: "Mi-clave-segura-1", sesionId: s0._id });
    const mw = m.servicio.autenticarCliente({ empresaDe });
    const r = res();
    const req = { method: "GET", headers: { cookie: `cs_cafe-uno=${token}` } };
    let empresaEnNext;
    await mw(req, r, () => (empresaEnNext = empresaActual()));
    assert.equal(req.cliente.clienteId, c.id);
    assert.equal(req.cliente.empresaId, E1);
    assert.equal(req.auth, undefined, "no es una sesión de personal");
    assert.equal(empresaEnNext, E1);
  });

  it("sin sesión 401; con contraseña temporal pendiente 403 salvo que se permita", async () => {
    const m = crearMundo();
    const c = await m.ficha();
    const { passwordTemporal } = await crear(m, c);
    const { token } = await login(m, "987654321", passwordTemporal);
    const sin = res();
    await m.servicio.autenticarCliente({ empresaDe })({ method: "GET", headers: {} }, sin, () => assert.fail("no debía pasar"));
    assert.equal(sin.statusCode, 401);
    const pend = res();
    await m.servicio.autenticarCliente({ empresaDe })({ method: "GET", headers: { cookie: `cs_cafe-uno=${token}` } }, pend, () => assert.fail("no debía pasar"));
    assert.equal(pend.statusCode, 403);
    assert.equal(pend.body.codigo, "CAMBIO_PASSWORD_REQUERIDO");
    let paso = false;
    await m.servicio.autenticarCliente({ empresaDe, permitirCambioPendiente: true })({ method: "GET", headers: { cookie: `cs_cafe-uno=${token}` }, }, res(), () => (paso = true));
    assert.equal(paso, true);
  });

  it("exige x-requested-with en métodos que escriben", async () => {
    const m = crearMundo();
    const r = res();
    await m.servicio.autenticarCliente({ empresaDe })({ method: "POST", headers: {} }, r, () => assert.fail("no debía pasar"));
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.codigo, "CSRF");
  });
});

describe("manejadores del personal", () => {
  const req = (o = {}) => ({ method: "POST", headers: X, body: {}, params: {}, auth: { empresaId: E1, usuarioId: MESERO.usuarioId }, rol: { permisos: MESERO.permisos }, ...o });
  const res = () => ({
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  });
  const sigue = (e) => {
    throw e;
  };

  it("crearCuenta: 201 con la contraseña temporal, sin caché; restablecer: 200", async () => {
    const m = crearMundo();
    const c = await m.ficha();
    const r = res();
    await m.servicio.manejadoresPersonal.crearCuenta(req({ params: { clienteId: c.id }, body: { generarPassword: true } }), r, sigue);
    assert.equal(r.statusCode, 201);
    assert.match(r.body.passwordTemporal, /^[A-Za-z0-9]{12}$/);
    assert.equal(r.headers["Cache-Control"], "no-store");
    const r2 = res();
    await m.servicio.manejadoresPersonal.restablecerPassword(req({ params: { clienteId: c.id }, body: { generarPassword: true } }), r2, sigue);
    assert.equal(r2.statusCode, 200);
    assert.notEqual(r2.body.passwordTemporal, r.body.passwordTemporal);
  });

  it("sin cabecera 403, sin permiso 403, cliente inexistente 404, repetir 409", async () => {
    const m = crearMundo();
    const c = await m.ficha();
    const a = res();
    await m.servicio.manejadoresPersonal.crearCuenta(req({ headers: {}, params: { clienteId: c.id }, body: { generarPassword: true } }), a, sigue);
    assert.equal(a.statusCode, 403);
    assert.equal(a.body.codigo, "CSRF");
    const b = res();
    await m.servicio.manejadoresPersonal.crearCuenta(req({ rol: { permisos: SOLO_LEER.permisos }, params: { clienteId: c.id }, body: { generarPassword: true } }), b, sigue);
    assert.equal(b.statusCode, 403);
    assert.equal(b.body.codigo, "PERMISO_INSUFICIENTE");
    const d = res();
    await m.servicio.manejadoresPersonal.crearCuenta(req({ params: { clienteId: "bbbbbbbbbbbbbbbbbbbbbbb9" }, body: { generarPassword: true } }), d, sigue);
    assert.equal(d.statusCode, 404);
    const e1 = res();
    await m.servicio.manejadoresPersonal.crearCuenta(req({ params: { clienteId: c.id }, body: { generarPassword: true } }), e1, sigue);
    const e2 = res();
    await m.servicio.manejadoresPersonal.crearCuenta(req({ params: { clienteId: c.id }, body: { generarPassword: true } }), e2, sigue);
    assert.equal(e2.statusCode, 409);
  });
});

void ADM;
