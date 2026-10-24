import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validarAnuncio } from "../src/anuncios/validacion.js";
import { ErrorAnuncio } from "../src/anuncios/errores.js";

const malo = (datos, base, re) =>
  assert.throws(() => validarAnuncio(datos, base), (e) => e instanceof ErrorAnuncio && e.codigo === "DATOS_INVALIDOS" && (!re || re.test(e.message)));
const evento = (o = {}) => ({ titulo: "Concierto de jazz", tipo: "evento", fecha: "2026-11-07", hora: "21:00", ...o });
const aviso = (o = {}) => ({ titulo: "Happy hour doble", tipo: "publicidad", ...o });

describe("validarAnuncio: evento", () => {
  it("normaliza y deja en null lo que no aplica", () => {
    const r = validarAnuncio(evento({ titulo: "  Concierto   de jazz ", lugar: " Terraza ", imagen: "https://img.example.com/a.jpg" }));
    assert.deepEqual(r, {
      titulo: "Concierto de jazz", descripcion: null, activo: true, tipo: "evento", imagen: "https://img.example.com/a.jpg",
      fecha: "2026-11-07", hora: "21:00", lugar: "Terraza", vigencia: null,
    });
  });
  it("fecha y hora son obligatorias y reales", () => {
    malo(evento({ fecha: undefined }), null, /fecha/);
    malo(evento({ fecha: "2026-02-30" }), null, /real/);
    malo(evento({ fecha: "07/11/2026" }), null, /AAAA-MM-DD/);
    malo(evento({ hora: undefined }), null, /hora/);
    malo(evento({ hora: "25:00" }), null, /hora/);
  });
  it("no admite vigencia (es de publicidad)", () => malo(evento({ vigencia: { hasta: "2026-12-01" } }), null, /vigencia/));
  it("el lugar es opcional y de hasta 80 caracteres", () => {
    assert.equal(validarAnuncio(evento({ lugar: "" })).lugar, null);
    malo(evento({ lugar: "x".repeat(81) }), null, /lugar/);
  });
});

describe("validarAnuncio: publicidad", () => {
  it("vigencia opcional; sin fechas = siempre", () => {
    assert.equal(validarAnuncio(aviso()).vigencia, null);
    assert.equal(validarAnuncio(aviso({ vigencia: {} })).vigencia, null);
    assert.deepEqual(validarAnuncio(aviso({ vigencia: { hasta: "2026-12-01" } })).vigencia, { desde: null, hasta: "2026-12-01" });
  });
  it("«hasta» no antes que «desde» y fechas reales", () => {
    malo(aviso({ vigencia: { desde: "2026-12-02", hasta: "2026-12-01" } }), null, /antes/);
    malo(aviso({ vigencia: { desde: "2026-13-01" } }), null, /real|AAAA/);
  });
  it("no admite fecha, hora ni lugar (son de evento)", () => {
    malo(aviso({ fecha: "2026-11-07" }), null, /no admitidos/);
    malo(aviso({ lugar: "x" }), null, /no admitidos/);
  });
});

describe("validarAnuncio: comunes", () => {
  it("título obligatorio, hasta 80; descripción hasta 300", () => {
    malo(aviso({ titulo: "  " }), null, /titulo/);
    malo(aviso({ titulo: "x".repeat(81) }), null, /titulo/);
    malo(aviso({ descripcion: "x".repeat(301) }), null, /descripcion/);
    assert.equal(validarAnuncio(aviso({ descripcion: "  " })).descripcion, null);
  });
  it("tipo válido; activo booleano; campos desconocidos rechazados", () => {
    malo({ titulo: "x", tipo: "oferta" }, null, /tipo/);
    malo(aviso({ activo: "si" }), null, /activo/);
    malo(aviso({ prioridad: 1 }), null, /no admitidos/);
  });
  it("imagen: solo https sin credenciales", () => {
    for (const u of ["http://x.com/a.png", "javascript:alert(1)", "https://u:p@x.com/a.png", "data:image/png;base64,AAAA", "no-url", "https://x.com/" + "a".repeat(500)])
      malo(aviso({ imagen: u }), null, /imagen/);
    assert.equal(validarAnuncio(aviso({ imagen: "" })).imagen, null);
  });
});

describe("validarAnuncio: al editar", () => {
  const base = { ...validarAnuncio(evento()) };
  it("superpone los cambios y valida el conjunto", () => {
    const r = validarAnuncio({ hora: "22:30" }, base);
    assert.deepEqual([r.hora, r.fecha, r.titulo], ["22:30", "2026-11-07", "Concierto de jazz"]);
    assert.equal(validarAnuncio({ activo: false }, base).activo, false);
  });
  it("no deja cambiar el tipo, ni editar sin cambios, ni mezclar campos de otro tipo", () => {
    malo({ tipo: "publicidad" }, base, /tipo/);
    malo({}, base, /nada que cambiar/);
    malo({ vigencia: { hasta: "2026-12-01" } }, base, /no admitidos/);
  });
  it("se puede quitar la imagen o el lugar con null", () => {
    const con = validarAnuncio({ imagen: "https://x.com/a.png", lugar: "Patio" }, base);
    const sin = validarAnuncio({ imagen: null, lugar: null }, con);
    assert.deepEqual([sin.imagen, sin.lugar], [null, null]);
  });
});
