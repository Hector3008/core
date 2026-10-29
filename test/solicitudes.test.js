// Solicitudes de empresa (5.65). Sin base de datos: almacenes falsos en memoria.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { crearServicioSolicitudes, MAX_PENDIENTES, VIGENCIA_SOLICITUD_MS, VIGENCIA_ACCESO_MS } from "../src/solicitudes/index.js";
import { ErrorSolicitud } from "../src/solicitudes/errores.js";
import { validarSolicitud } from "../src/solicitudes/validacion.js";
import { verificarPassword } from "../src/password.js";
import { empresaActual } from "../src/tenancy.js";

// ---------- almacén falso ----------
function coleccion() {
  const filas = [];
  let n = 0;
  const igual = (a, b) => String(a) === String(b);
  const coincide = (d, f) =>
    Object.entries(f).every(([k, v]) => {
      if (k === "$or") return v.some((g) => coincide(d, g));
      const x = d[k];
      if (v && typeof v === "object" && !(v instanceof Date)) {
        if ("$in" in v) return v.$in.some((y) => igual(x, y));
        if ("$gt" in v) return x > v.$gt;
        if ("$regex" in v) return new RegExp(v.$regex, v.$options).test(x ?? "");
      }
      return v === null ? x === null || x === undefined : igual(x, v);
    });
  const aplicar = (d, upd) => {
    for (const [k, v] of Object.entries(upd.$set ?? {})) d[k] = v;
    for (const k of Object.keys(upd.$unset ?? {})) delete d[k];
  };
  const q = (fn) => {
    const o = { select: () => o, lean: () => o, then: (ok, ko) => Promise.resolve().then(() => structuredClone(fn())).then(ok, ko) };
    return o;
  };
  const lista = (f) => {
    let r = filas.filter((d) => coincide(d, f)), ord = null, sk = 0, lim = Infinity;
    const o = {
      sort: (x) => ((ord = x), o),
      skip: (n) => ((sk = n), o),
      limit: (n) => ((lim = n), o),
      lean: () => o,
      then: (ok, ko) =>
        Promise.resolve()
          .then(() => {
            if (ord) { const [[k, dir]] = Object.entries(ord); r = [...r].sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * dir); }
            return structuredClone(r.slice(sk, sk + lim));
          })
          .then(ok, ko),
    };
    return o;
  };
  return {
    filas,
    find: lista,
    deleteMany: async (f) => {
      const l = filas.filter((d) => coincide(d, f));
      l.forEach((d) => filas.splice(filas.indexOf(d), 1));
      return { deletedCount: l.length };
    },
    findOne: (f) => q(() => filas.find((d) => coincide(d, f)) ?? null),
    countDocuments: async (f) => filas.filter((d) => coincide(d, f)).length,
    create: async (doc) => {
      for (const k of ["tokenHash", "slug", "correo"]) if (doc[k] !== undefined && k !== "slug" && filas.some((d) => d[k] === doc[k])) throw Object.assign(new Error("dup"), { code: 11000 });
      const d = { _id: `id${++n}`, createdAt: new Date(), ...structuredClone(doc) };
      filas.push(d);
      return { ...structuredClone(d), toObject: () => structuredClone(d) };
    },
    updateOne: async (f, upd) => {
      const d = filas.find((x) => coincide(x, f));
      if (d) aplicar(d, upd);
      return { matchedCount: d ? 1 : 0 };
    },
    updateMany: async (f, upd) => {
      const l = filas.filter((x) => coincide(x, f));
      l.forEach((d) => aplicar(d, upd));
      return { matchedCount: l.length };
    },
    findOneAndUpdate: (f, upd) => q(() => {
      const d = filas.find((x) => coincide(x, f));
      if (!d) return null;
      const antes = structuredClone(d);
      aplicar(d, upd);
      return antes;
    }),
  };
}

const VALIDA = {
  nombre: "Café Aurora",
  slug: "cafe-aurora",
  servicios: ["tobt"],
  pais: "pe",
  moneda: "pen",
  adminNombre: "Ana Quispe",
  adminCorreo: "Ana@CafeAurora.example",
  telefono: "987 654 321",
  aceptoTerminos: { terminos: "2026-10-26", privacidad: "2026-10-26" },
};
const rechaza = (p, codigo, status) => assert.rejects(p, (e) => e instanceof ErrorSolicitud && e.codigo === codigo && (status === undefined || e.status === status));
const hashDe = (t) => createHash("sha256").update(t).digest("hex");

describe("validación del formulario", () => {
  it("normaliza: slug, país, moneda, correo y teléfono", () => {
    const d = validarSolicitud({ ...VALIDA, nombre: "  Café   Aurora ", slug: " Cafe-Aurora " });
    assert.deepEqual([d.nombre, d.slug, d.pais, d.moneda, d.adminCorreo, d.telefono], ["Café Aurora", "cafe-aurora", "PE", "PEN", "ana@cafeaurora.example", "+51987654321"]);
    assert.deepEqual(d.aceptacion, { terminos: "2026-10-26", privacidad: "2026-10-26" });
  });

  it("junta TODOS los problemas por campo", () => {
    try {
      validarSolicitud({ nombre: "x", slug: "A B", servicios: [], pais: "ZZ", moneda: "xx", adminNombre: "", adminCorreo: "no", telefono: "1", aceptoTerminos: null });
      assert.fail();
    } catch (e) {
      assert.equal(e.codigo, "DATOS_INVALIDOS");
      assert.deepEqual(Object.keys(e.detalle.campos).sort(), ["aceptoTerminos", "adminCorreo", "adminNombre", "moneda", "nombre", "pais", "servicios", "slug", "telefono"]);
    }
  });

  it("slug: reservados, guiones dobles, extremos y largo", () => {
    for (const s of ["cuenta", "tobt", "admin", "a-", "-a", "ab", "a--b", "x".repeat(61), "caf é", "café", "a/b", "a.b"])
      assert.throws(() => validarSolicitud({ ...VALIDA, slug: s }), (e) => !!e.detalle.campos.slug, s);
    assert.equal(validarSolicitud({ ...VALIDA, slug: "mi-cafe-2" }).slug, "mi-cafe-2");
  });

  it("servicios: solo los ofrecidos y con plantillas; sin repetidos", () => {
    assert.deepEqual(validarSolicitud({ ...VALIDA, servicios: ["tobt", "tobt"] }).servicios, ["tobt"]);
    for (const s of [["base"], ["inventado"], ["__proto__"], ["siscore"], "tobt", [1], ["tobt", "siscore", "a1", "b2", "c3", "d4"]])
      assert.throws(() => validarSolicitud({ ...VALIDA, servicios: s }, { serviciosPermitidos: ["tobt"] }), (e) => !!e.detalle.campos.servicios, JSON.stringify(s));
    assert.deepEqual(validarSolicitud({ ...VALIDA, servicios: ["siscore", "tobt"] }, { serviciosPermitidos: ["tobt", "siscore"] }).servicios, ["siscore", "tobt"]);
  });

  it("nombre y datos con saltos de línea o control se rechazan (no van a un correo)", () => {
    assert.ok(!/[\r\n]/.test(validarSolicitud({ ...VALIDA, nombre: "Café\r\nBcc: x@y.z" }).nombre)); // los saltos se vuelven espacios
    assert.throws(() => validarSolicitud({ ...VALIDA, adminNombre: "Ana\u0000" }), (e) => !!e.detalle.campos.adminNombre);
    assert.throws(() => validarSolicitud({ ...VALIDA, adminCorreo: "a@b.com\nBcc: x@y.z" }), (e) => !!e.detalle.campos.adminCorreo);
  });

  it("teléfono de otro país con su código", () => {
    assert.equal(validarSolicitud({ ...VALIDA, telefono: "+54 9 11 2345-6789" }).telefono, "+5491123456789");
  });
});

describe("core.solicitudes", () => {
  let c, svc, ahora, empresasLog;
  const reloj = () => ahora;
  const T0 = new Date("2026-10-27T12:00:00Z");
  beforeEach(() => {
    ahora = new Date(T0);
    c = { SolicitudEmpresa: coleccion(), TokenPassword: coleccion(), Empresa: coleccion(), Usuario: coleccion(), Sesion: coleccion(), Rol: coleccion(), Membresia: coleccion() };
    // Rol y Membresia son de cada empresa: igual que el plugin de tenencia, sus consultas se acotan a la empresa activa.
    for (const n of ["Rol", "Membresia"]) {
      for (const m of ["find", "findOne"]) {
        const orig = c[n][m];
        c[n][m] = (f) => orig({ ...f, empresaId: empresaActual() });
      }
    }
    empresasLog = [];
    const empresas = {
      crearEmpresa: async (d) => {
        if (empresas.fallaEmpresa) throw new Error("falla empresa");
        const e = await c.Empresa.create({ ...d, activa: true });
        empresasLog.push(["empresa", d.slug, d.servicios, d.pais, d.moneda]);
        return e;
      },
      crearUsuario: async ({ correo, nombre, password }) => {
        const { hashPassword } = await import("../src/password.js");
        empresasLog.push(["usuario", correo]);
        return c.Usuario.create({ correo, nombre, passwordHash: await hashPassword(password), estado: "activo", debeCambiarPassword: false });
      },
      agregarMiembro: async ({ empresaId, usuarioId, rol }) => {
        if (empresas.fallaMiembro) throw new Error("falla miembro");
        empresasLog.push(["miembro", String(empresaId), String(usuarioId), rol]);
        let r = c.Rol.filas.find((x) => x.nombre === rol && String(x.empresaId) === String(empresaId));
        r ??= await c.Rol.create({ nombre: rol, empresaId });
        await c.Membresia.create({ empresaId, usuarioId, rolId: r._id, activa: true });
      },
    };
    svc = crearServicioSolicitudes(c, empresas, { ahora: reloj });
    svc._empresas = empresas;
  });

  it("crear guarda la solicitud con el hash del enlace, nunca el enlace", async () => {
    const { solicitud, token } = await svc.crear({ ...VALIDA });
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const fila = c.SolicitudEmpresa.filas[0];
    assert.equal(fila.tokenHash, hashDe(token));
    assert.ok(!JSON.stringify(fila).includes(token));
    assert.equal(fila.estado, "pendiente");
    assert.equal(fila.adminCorreo, "ana@cafeaurora.example");
    assert.equal(fila.aceptacion.terminos, "2026-10-26");
    assert.equal(new Date(fila.expira) - T0, VIGENCIA_SOLICITUD_MS);
    assert.equal(solicitud.slug, "cafe-aurora");
    assert.equal(c.Empresa.filas.length, 0); // crear NO crea la empresa
  });

  it("no acepta un slug de una empresa existente ni de otra solicitud vigente, ni dos del mismo correo", async () => {
    await c.Empresa.create({ slug: "ocupado" });
    await rechaza(svc.crear({ ...VALIDA, slug: "ocupado" }), "SLUG_OCUPADO", 409);
    await svc.crear({ ...VALIDA });
    await rechaza(svc.crear({ ...VALIDA, adminCorreo: "otra@x.com" }), "SLUG_OCUPADO");
    await rechaza(svc.crear({ ...VALIDA, slug: "otro-slug" }), "DEMASIADAS_SOLICITUDES", 429);
    ahora = new Date(T0.getTime() + VIGENCIA_SOLICITUD_MS + 1000); // vencida: ya no bloquea
    await svc.crear({ ...VALIDA, slug: "otro-slug" });
  });

  it("tope de solicitudes pendientes en la plataforma", async () => {
    for (let i = 0; i < MAX_PENDIENTES; i++) await svc.crear({ ...VALIDA, slug: `negocio-${i}`, adminCorreo: `p${i}@x.com` });
    await rechaza(svc.crear({ ...VALIDA, slug: "uno-mas", adminCorreo: "nuevo@x.com" }), "DEMASIADAS_SOLICITUDES");
  });

  it("ver: solo con el enlace correcto; basura y enlaces inventados dan ENLACE_INVALIDO", async () => {
    const { token } = await svc.crear({ ...VALIDA });
    assert.equal((await svc.ver(token)).nombre, "Café Aurora");
    for (const t of ["", "x", null, undefined, 123, "a".repeat(43), token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"), { $ne: 1 }])
      await rechaza(svc.ver(t), "ENLACE_INVALIDO", 404);
  });

  it("aprobar crea la empresa, la cuenta con contraseña desconocida y el enlace de acceso", async () => {
    const { token } = await svc.crear({ ...VALIDA });
    const r = await svc.aprobar(token);
    assert.deepEqual([r.empresa.slug, r.empresa.servicios, r.admin.correo, r.admin.nuevo], ["cafe-aurora", ["tobt"], "ana@cafeaurora.example", true]);
    assert.deepEqual(empresasLog.map((x) => x[0]), ["empresa", "usuario", "miembro"]);
    assert.deepEqual(empresasLog[0].slice(1), ["cafe-aurora", ["tobt"], "PE", "PEN"]);
    assert.equal(empresasLog[2][3], "admin");
    assert.match(r.tokenAcceso, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(c.TokenPassword.filas[0].tokenHash, hashDe(r.tokenAcceso));
    assert.equal(new Date(c.TokenPassword.filas[0].expira) - T0, VIGENCIA_ACCESO_MS);
    // nadie puede entrar todavía: la contraseña inicial es un secreto aleatorio que no se devolvió a nadie
    const u = c.Usuario.filas[0];
    assert.ok(!(await verificarPassword("", u.passwordHash)));
    const s = c.SolicitudEmpresa.filas[0];
    assert.equal(s.estado, "aprobada");
    assert.equal(s.tokenHash, undefined); // el enlace de aprobación ya no sirve
    assert.equal(String(s.empresaId), String(c.Empresa.filas[0]._id));
    await rechaza(svc.aprobar(token), "ENLACE_INVALIDO");
  });

  it("aprobar con un correo que ya tiene cuenta: la afilia y no toca su contraseña ni genera enlace", async () => {
    const previo = await c.Usuario.create({ correo: "ana@cafeaurora.example", nombre: "Ana", passwordHash: "scrypt$a$b", estado: "activo" });
    const { token } = await svc.crear({ ...VALIDA });
    const r = await svc.aprobar(token);
    assert.deepEqual([r.admin.nuevo, r.tokenAcceso], [false, null]);
    assert.equal(c.Usuario.filas.length, 1);
    assert.equal(c.Usuario.filas[0].passwordHash, "scrypt$a$b");
    assert.equal(c.TokenPassword.filas.length, 0);
    assert.deepEqual(empresasLog.map((x) => x[0]), ["empresa", "miembro"]);
    assert.equal(empresasLog[1][2], String(previo._id));
  });

  it("cuenta suspendida: no se crea nada y la solicitud sigue pendiente", async () => {
    await c.Usuario.create({ correo: "ana@cafeaurora.example", passwordHash: "x", estado: "suspendido" });
    const { token } = await svc.crear({ ...VALIDA });
    await rechaza(svc.aprobar(token), "CUENTA_SUSPENDIDA");
    assert.equal(c.Empresa.filas.length, 0);
    assert.equal(c.SolicitudEmpresa.filas[0].estado, "pendiente");
  });

  it("dos aprobaciones a la vez crean UNA empresa", async () => {
    const { token } = await svc.crear({ ...VALIDA });
    const r = await Promise.allSettled([svc.aprobar(token), svc.aprobar(token)]);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(c.Empresa.filas.length, 1);
  });

  it("si falla el alta del admin queda `incompleta` y reintentar reanuda sin duplicar la empresa", async () => {
    const { token } = await svc.crear({ ...VALIDA });
    svc._empresas.fallaMiembro = true;
    await assert.rejects(svc.aprobar(token), /falla miembro/);
    assert.equal(c.SolicitudEmpresa.filas[0].estado, "incompleta");
    assert.equal(c.Empresa.filas.length, 1);
    svc._empresas.fallaMiembro = false;
    // en la vida real el usuario ya quedó creado en el primer intento: el segundo lo afilia
    const r = await svc.aprobar(token);
    assert.equal(c.Empresa.filas.length, 1);
    assert.equal(c.SolicitudEmpresa.filas[0].estado, "aprobada");
    assert.equal(r.empresa.slug, "cafe-aurora");
  });

  it("si falla antes de crear la empresa vuelve a pendiente", async () => {
    const { token } = await svc.crear({ ...VALIDA });
    svc._empresas.fallaEmpresa = true;
    await assert.rejects(svc.aprobar(token), /falla empresa/);
    assert.equal(c.SolicitudEmpresa.filas[0].estado, "pendiente");
    svc._empresas.fallaEmpresa = false;
    await svc.aprobar(token);
    assert.equal(c.Empresa.filas.length, 1);
  });

  it("si alguien tomó el slug mientras tanto, no se pisa", async () => {
    const { token } = await svc.crear({ ...VALIDA });
    await c.Empresa.create({ slug: "cafe-aurora" });
    await rechaza(svc.aprobar(token), "SLUG_OCUPADO");
    assert.equal(c.Empresa.filas.length, 1);
    assert.equal(c.SolicitudEmpresa.filas[0].estado, "pendiente");
  });

  it("una solicitud vencida no se aprueba ni se rechaza", async () => {
    const { token } = await svc.crear({ ...VALIDA });
    ahora = new Date(T0.getTime() + VIGENCIA_SOLICITUD_MS + 1);
    await rechaza(svc.aprobar(token), "ENLACE_VENCIDO", 410);
    await rechaza(svc.rechazar(token), "ENLACE_VENCIDO");
    await rechaza(svc.ver(token), "ENLACE_VENCIDO");
    assert.equal(c.Empresa.filas.length, 0);
  });

  it("rechazar cierra la solicitud y el enlace deja de servir", async () => {
    const { token } = await svc.crear({ ...VALIDA });
    const r = await svc.rechazar(token);
    assert.equal(r.adminCorreo, "ana@cafeaurora.example");
    assert.equal(c.SolicitudEmpresa.filas[0].estado, "rechazada");
    await rechaza(svc.aprobar(token), "ENLACE_INVALIDO");
    assert.equal(c.Empresa.filas.length, 0);
    // y la dirección web vuelve a quedar libre
    await svc.crear({ ...VALIDA });
  });

  describe("enlace de contraseña", () => {
    let acceso;
    beforeEach(async () => {
      const { token } = await svc.crear({ ...VALIDA });
      acceso = (await svc.aprobar(token)).tokenAcceso;
    });

    it("verAcceso muestra a quién es; con basura, ENLACE_INVALIDO", async () => {
      assert.deepEqual(await svc.verAcceso(acceso), { correo: "ana@cafeaurora.example", nombre: "Ana Quispe", tipo: "acceso" });
      await rechaza(svc.verAcceso("x"), "ENLACE_INVALIDO");
      await rechaza(svc.verAcceso("a".repeat(43)), "ENLACE_INVALIDO");
    });

    it("establecerPassword fija la contraseña, gasta el enlace y no se puede repetir", async () => {
      await svc.establecerPassword({ token: acceso, password: "una-clave-larga-1" });
      const u = c.Usuario.filas[0];
      assert.ok(await verificarPassword("una-clave-larga-1", u.passwordHash));
      assert.equal(u.debeCambiarPassword, false);
      await rechaza(svc.establecerPassword({ token: acceso, password: "otra-clave-larga-2" }), "ENLACE_INVALIDO");
      await rechaza(svc.verAcceso(acceso), "ENLACE_INVALIDO");
      assert.ok(await verificarPassword("una-clave-larga-1", c.Usuario.filas[0].passwordHash));
    });

    it("la política de contraseñas aplica y NO gasta el enlace", async () => {
      await assert.rejects(svc.establecerPassword({ token: acceso, password: "corta" }), (e) => e.codigo === "DATOS_INVALIDOS" && !!e.detalle.campos.password);
      await svc.establecerPassword({ token: acceso, password: "una-clave-larga-1" });
    });

    it("dos envíos a la vez: gana uno", async () => {
      const r = await Promise.allSettled([svc.establecerPassword({ token: acceso, password: "clave-numero-uno" }), svc.establecerPassword({ token: acceso, password: "clave-numero-dos" })]);
      assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    });

    it("vence", async () => {
      ahora = new Date(T0.getTime() + VIGENCIA_ACCESO_MS + 1);
      await rechaza(svc.establecerPassword({ token: acceso, password: "una-clave-larga-1" }), "ENLACE_VENCIDO", 410);
      await rechaza(svc.verAcceso(acceso), "ENLACE_VENCIDO");
    });

    it("una cuenta suspendida después no puede usarlo", async () => {
      c.Usuario.filas[0].estado = "suspendido";
      await rechaza(svc.establecerPassword({ token: acceso, password: "una-clave-larga-1" }), "ENLACE_INVALIDO");
    });
  });

  describe("el operador (5.66)", () => {
    const aprobada = async (v = {}) => {
      const { token } = await svc.crear({ ...VALIDA, ...v });
      return svc.aprobar(token);
    };

    it("listar filtra por estado, la más nueva primero, y marca las vencidas", async () => {
      const a = await svc.crear({ ...VALIDA });
      await svc.crear({ ...VALIDA, slug: "otra-uno", adminCorreo: "b@x.example" });
      c.SolicitudEmpresa.filas[0].createdAt = new Date(T0.getTime() - 1000);
      await svc.rechazar(a.token);
      assert.equal((await svc.listar()).length, 2);
      assert.deepEqual((await svc.listar({ estado: "pendiente" })).map((x) => x.slug), ["otra-uno"]);
      assert.deepEqual((await svc.listar({ estado: "rechazada" })).map((x) => x.slug), ["cafe-aurora"]);
      await rechaza(svc.listar({ estado: "cualquiera" }), "DATOS_INVALIDOS");
      ahora = new Date(T0.getTime() + VIGENCIA_SOLICITUD_MS + 1);
      assert.equal((await svc.listar({ estado: "pendiente" }))[0].vencida, true);
      assert.equal(await svc.contarPendientes(), 0);
    });

    it("aprobarPorId y rechazarPorId hacen lo mismo que el enlace del correo", async () => {
      await svc.crear({ ...VALIDA });
      const id = c.SolicitudEmpresa.filas[0]._id;
      const r = await svc.aprobarPorId(id);
      assert.match(r.tokenAcceso, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(c.Empresa.filas.length, 1);
      await rechaza(svc.rechazarPorId(id), "ESTADO_INVALIDO");
      await rechaza(svc.aprobarPorId("no es un id!"), "DATOS_INVALIDOS");
      await rechaza(svc.aprobarPorId("a".repeat(24)), "ENLACE_INVALIDO");
      await svc.crear({ ...VALIDA, slug: "dos-uno", adminCorreo: "b@x.example" });
      const r2 = await svc.rechazarPorId(c.SolicitudEmpresa.filas[1]._id);
      assert.equal(r2.adminCorreo, "b@x.example");
    });

    it("listarEmpresas muestra empresa y administradores; busca por nombre o dirección", async () => {
      await aprobada();
      await aprobada({ nombre: "Panadería Sol", slug: "panaderia-sol", adminCorreo: "luis@sol.example", adminNombre: "Luis" });
      const todas = await svc.listarEmpresas();
      assert.equal(todas.length, 2);
      const sol = todas.find((e) => e.slug === "panaderia-sol");
      assert.deepEqual(sol.admins.map((a) => a.correo), ["luis@sol.example"]);
      assert.equal(todas.find((e) => e.slug === "cafe-aurora").admins[0].correo, "ana@cafeaurora.example");
      assert.deepEqual((await svc.listarEmpresas({ texto: "pan" })).map((e) => e.slug), ["panaderia-sol"]);
      assert.deepEqual((await svc.listarEmpresas({ texto: "cafe-aurora" })).map((e) => e.slug), ["cafe-aurora"]);
      assert.equal((await svc.listarEmpresas({ texto: ".*" })).length, 0); // el texto no es una expresión regular
      assert.equal((await svc.listarEmpresas({ limite: 1 })).length, 1);
    });

    it("fijarActiva suspende y reactiva; exige booleano y empresa real", async () => {
      await aprobada();
      const id = c.Empresa.filas[0]._id;
      await svc.fijarActiva({ empresaId: id, activa: false });
      assert.equal(c.Empresa.filas[0].activa, false);
      assert.equal((await svc.listarEmpresas())[0].activa, false);
      await svc.fijarActiva({ empresaId: id, activa: true });
      assert.equal(c.Empresa.filas[0].activa, true);
      await rechaza(svc.fijarActiva({ empresaId: id, activa: "no" }), "DATOS_INVALIDOS");
      await rechaza(svc.fijarActiva({ empresaId: "b".repeat(24), activa: false }), "ENLACE_INVALIDO");
    });

    it("reenviarAcceso: enlace nuevo de 14 días, anula el anterior y solo vale para administradores de ESA empresa", async () => {
      const r = await aprobada();
      const e = c.Empresa.filas[0]._id, u = c.Usuario.filas[0]._id;
      const n = await svc.reenviarAcceso({ empresaId: e, usuarioId: u });
      assert.equal(n.correo, "ana@cafeaurora.example");
      assert.equal(n.vence - T0, VIGENCIA_ACCESO_MS);
      assert.equal(n.empresa, "Café Aurora");
      await rechaza(svc.verAcceso(r.tokenAcceso), "ENLACE_INVALIDO"); // el anterior ya no sirve
      assert.equal((await svc.verAcceso(n.token)).tipo, "acceso");
      // otra empresa: Ana no es su administradora
      await aprobada({ slug: "otra-emp", adminCorreo: "z@z.example" });
      const otra = c.Empresa.filas[1]._id;
      await rechaza(svc.reenviarAcceso({ empresaId: otra, usuarioId: u }), "ENLACE_INVALIDO");
      await rechaza(svc.reenviarAcceso({ empresaId: e, usuarioId: "c".repeat(24) }), "ENLACE_INVALIDO");
      c.Usuario.filas[0].estado = "suspendido";
      await rechaza(svc.reenviarAcceso({ empresaId: e, usuarioId: u }), "CUENTA_SUSPENDIDA");
    });
  });

  describe("recuperar la contraseña (5.67)", () => {
    let u;
    beforeEach(async () => {
      const { token } = await svc.crear({ ...VALIDA });
      const r = await svc.aprobar(token);
      await svc.establecerPassword({ token: r.tokenAcceso, password: "clave-original-1" });
      u = c.Usuario.filas[0];
    });

    it("con un correo conocido emite un enlace de 1 hora; el correo se normaliza", async () => {
      const r = await svc.solicitarRecuperacion({ correo: "  ANA@cafeaurora.example " });
      assert.match(r.token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(r.correo, "ana@cafeaurora.example");
      assert.equal(r.vence - T0, 60 * 60 * 1000);
      const fila = c.TokenPassword.filas.at(-1);
      assert.equal(fila.tipo, "recuperacion");
      assert.equal(fila.tokenHash, hashDe(r.token));
      assert.ok(!JSON.stringify(c.TokenPassword.filas).includes(r.token));
      assert.equal((await svc.verAcceso(r.token)).tipo, "recuperacion");
    });

    it("sin cuenta, suspendida, con basura o un segundo pedido en menos de un minuto: null (quien llama responde igual)", async () => {
      assert.equal(await svc.solicitarRecuperacion({ correo: "nadie@x.example" }), null);
      for (const malo of [undefined, null, 5, "", "sin-arroba", "a@b", "x".repeat(300) + "@a.example", { $ne: "" }]) assert.equal(await svc.solicitarRecuperacion({ correo: malo }), null);
      assert.ok(await svc.solicitarRecuperacion({ correo: "ana@cafeaurora.example" }));
      assert.equal(await svc.solicitarRecuperacion({ correo: "ana@cafeaurora.example" }), null); // espera de 1 minuto
      ahora = new Date(T0.getTime() + 61 * 1000);
      assert.ok(await svc.solicitarRecuperacion({ correo: "ana@cafeaurora.example" }));
      u.estado = "suspendido";
      ahora = new Date(T0.getTime() + 10 * 60 * 1000);
      assert.equal(await svc.solicitarRecuperacion({ correo: "ana@cafeaurora.example" }), null);
    });

    it("un enlace nuevo anula el anterior; vence a la hora", async () => {
      const a = await svc.solicitarRecuperacion({ correo: "ana@cafeaurora.example" });
      ahora = new Date(T0.getTime() + 2 * 60 * 1000);
      const b = await svc.solicitarRecuperacion({ correo: "ana@cafeaurora.example" });
      await rechaza(svc.verAcceso(a.token), "ENLACE_INVALIDO");
      ahora = new Date(T0.getTime() + 2 * 60 * 1000 + 60 * 60 * 1000 + 1);
      await rechaza(svc.verAcceso(b.token), "ENLACE_VENCIDO");
    });

    it("cambiar la contraseña cierra TODAS las sesiones de esa persona y solo las suyas", async () => {
      await c.Sesion.create({ usuarioId: u._id, tokenHash: "s1" });
      await c.Sesion.create({ usuarioId: u._id, tokenHash: "s2" });
      await c.Sesion.create({ usuarioId: "otro", tokenHash: "s3" });
      const r = await svc.solicitarRecuperacion({ correo: "ana@cafeaurora.example" });
      const res = await svc.establecerPassword({ token: r.token, password: "clave-nueva-larga-2" });
      assert.equal(res.sesionesCerradas, 2);
      assert.deepEqual(c.Sesion.filas.map((x) => x.tokenHash), ["s3"]);
      assert.ok(await verificarPassword("clave-nueva-larga-2", c.Usuario.filas[0].passwordHash));
      await rechaza(svc.establecerPassword({ token: r.token, password: "otra-clave-larga-3" }), "ENLACE_INVALIDO"); // un solo uso
    });

    it("una política de contraseña incumplida no gasta el enlace ni cierra sesiones", async () => {
      await c.Sesion.create({ usuarioId: u._id, tokenHash: "s1" });
      const r = await svc.solicitarRecuperacion({ correo: "ana@cafeaurora.example" });
      await rechaza(svc.establecerPassword({ token: r.token, password: "corta" }), "DATOS_INVALIDOS");
      assert.equal(c.Sesion.filas.length, 1);
      assert.ok(await svc.verAcceso(r.token));
    });
  });
});
