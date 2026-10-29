import { ErrorPromocion } from "./errores.js";
import { claveCategoria, claveItem } from "./validacion.js";
import { momentoLocal } from "../zona.js";

// Evaluador de promociones (arquitectura 5.40). Lógica pura: sin base de datos, sin reloj propio, sin zona implícita.
// Todo el cálculo va en centavos enteros, como `calcularPuntos`; solo al final se devuelve en la unidad de la moneda.
//
//   evaluarPromociones({ lineas, promociones, ahora, zona })
//     lineas:       [{ id?, codigo, categoria?, cantidad, precio, ahora? }]   precio = de UNA unidad (sin promociones)
//                   `ahora` (opcional, ISO o Date): cuándo se pidió esa línea. Su vigencia, día y horario se miran a esa
//                   hora y no a la global: un ítem pedido en el happy hour lo conserva aunque el pedido se recalcule después.
//     promociones:  las de la empresa, ya validadas ({ id, nombre, activa, prioridad, acumulable, tipo, objetivo,
//                   disparador, n, m, efecto, valor, vigencia, dias, horario })
//     ahora:        el instante (Date); zona: el nombre IANA de la empresa
//     cupos:        (5.44, opcional) { [idPromocion]: { max, motivo } } cuántas unidades PUEDE todavía rebajar cada promoción
//                   en este cálculo por los topes que dependen de usos anteriores (diario, por cliente); `motivo` dice cuál
//                   manda («dia», «cliente», «sin_cliente»). El tope por pedido (`promo.topes.porPedido`) se aplica aquí mismo.
//
// Cómo decide, en una frase: se mira cada promoción vigente por orden de prioridad, y reparte su descuento entre las
// unidades (no entre las líneas) que le corresponden; cada unidad recibe a lo sumo una promoción, salvo que ambas
// sean `acumulable`.

/** Tope de unidades por evaluación: protege el cálculo de un pedido absurdo. */
export const MAX_UNIDADES = 500;

const aMinutos = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * ¿Rige la promoción en este momento? Mira `activa`, la vigencia (fechas, ambas incluidas), los días de la semana
 * y el horario. Un horario que cruza la medianoche (22:00 a 02:00) rige hasta la madrugada; el día de la semana se
 * mira siempre al momento de cobrar, así que una promo «viernes 22:00 a 02:00» no rige el sábado a la 01:00.
 */
export function estaVigente(promo, momento) {
  if (promo.activa === false) return false;
  const v = promo.vigencia;
  if (v?.desde && momento.fecha < v.desde) return false;
  if (v?.hasta && momento.fecha > v.hasta) return false;
  if (promo.dias?.length && !promo.dias.includes(momento.dia)) return false;
  const h = promo.horario;
  if (h?.desde && h?.hasta) {
    const d = aMinutos(h.desde);
    const a = aMinutos(h.hasta);
    const dentro = d < a ? momento.minutos >= d && momento.minutos < a : momento.minutos >= d || momento.minutos < a;
    if (!dentro) return false;
  }
  return true;
}

const coincide = (selector, linea) => {
  if (!selector) return false;
  if (selector.itemCodigo) return claveItem(linea.codigo) === claveItem(selector.itemCodigo);
  if (selector.categoria) return claveCategoria(linea.categoria) === claveCategoria(selector.categoria);
  return false;
};

/** Cuánto descuenta un efecto sobre una unidad que hoy cuesta `actual` centavos. Nunca más que lo que cuesta. */
function montoDe(efecto, valor, actual) {
  if (efecto === "gratis") return actual;
  if (efecto === "porcentaje") return Math.min(actual, Math.round((actual * valor) / 100 + 1e-9));
  return Math.min(actual, Math.round(valor * 100 + 1e-9));
}

const aMoneda = (centavos) => Math.round(centavos) / 100;

export function evaluarPromociones({ lineas, promociones, ahora = new Date(), zona = "UTC", cupos = {} }) {
  if (!Array.isArray(lineas)) throw new ErrorPromocion("DATOS_INVALIDOS", "lineas: una lista");
  const momento = momentoLocal(ahora, zona);

  // 1. Las líneas pasan a unidades sueltas: una promoción reparte descuento por unidad, no por línea.
  const unidades = [];
  lineas.forEach((l, li) => {
    const cantidad = Number(l?.cantidad);
    const precio = Number(l?.precio);
    if (!Number.isInteger(cantidad) || cantidad < 1 || l?.precio === null || l?.precio === undefined || !Number.isFinite(precio) || precio < 0) return;
    const centavos = Math.round(precio * 100);
    for (let k = 0; k < cantidad; k++) unidades.push({ li, orden: unidades.length, base: centavos, actual: centavos, aplicadas: [], soloAcumulables: true });
  });
  if (unidades.length > MAX_UNIDADES) throw new ErrorPromocion("DATOS_INVALIDOS", `demasiadas unidades en un pedido (hasta ${MAX_UNIDADES})`);

  // 2. Promociones vigentes, por prioridad (menor primero); a igual prioridad, el orden en que llegaron.
  // Si alguna línea trae su propia hora (`ahora`), la vigencia se decide por unidad, a la hora de su línea; si no, es la
  // de siempre: solo entran las vigentes ahora.
  const momentos = lineas.map((l) => {
    if (l?.ahora === undefined || l?.ahora === null) return momento;
    const d = new Date(l.ahora);
    if (Number.isNaN(d.getTime())) throw new ErrorPromocion("DATOS_INVALIDOS", "lineas: `ahora` debe ser una fecha y hora válida");
    return momentoLocal(d, zona);
  });
  const horaPropia = lineas.some((l) => l?.ahora !== undefined && l?.ahora !== null);
  const vigentesAhora = new Set(promociones.filter((p) => estaVigente(p, momento)));
  const ordenadas = promociones
    .map((p, orden) => ({ p, orden }))
    .filter(({ p }) => (horaPropia ? p.activa !== false : vigentesAhora.has(p)))
    .sort((a, b) => (a.p.prioridad ?? 100) - (b.p.prioridad ?? 100) || a.orden - b.orden)
    .map(({ p }) => p);
  const vigentes = ordenadas;
  const rigeCache = new Map();
  const rige = (promo, li) => {
    if (!horaPropia) return true;
    let porLinea = rigeCache.get(promo);
    if (!porLinea) rigeCache.set(promo, (porLinea = new Map()));
    if (!porLinea.has(li)) porLinea.set(li, estaVigente(promo, momentos[li]));
    return porLinea.get(li);
  };

  // Una unidad que ya tiene una promoción solo admite otra si ambas son acumulables.
  const libre = (u, promo) => u.aplicadas.length === 0 || (promo.acumulable === true && u.soloAcumulables);
  const aplicar = (u, promo, monto) => {
    if (monto <= 0) return;
    u.actual -= monto;
    u.aplicadas.push({ promo, monto });
    u.soloAcumulables = u.soloAcumulables && promo.acumulable === true;
  };
  const deLinea = (selector) => (u) => coincide(selector, lineas[u.li]);

  // Topes de usos (5.44): cada unidad rebajada es un uso. El tope por pedido sale de la propia promoción; los de día y
  // cliente los calcula quien llama (necesitan contadores) y llegan en `cupos`. Manda el más chico.
  const usosPorPromo = new Map();
  const topadas = new Map();
  const limiteDe = (promo) => {
    let mejor = null;
    const pedido = promo.topes?.porPedido;
    if (Number.isInteger(pedido)) mejor = { max: pedido, motivo: "pedido" };
    const c = cupos?.[promo.id];
    if (c && Number.isInteger(c.max) && (!mejor || c.max < mejor.max)) mejor = { max: Math.max(0, c.max), motivo: c.motivo ?? "dia" };
    return mejor;
  };
  /** ¿Cabe una unidad más de esta promoción? Si no, queda anotado que el tope la frenó. */
  const cabe = (promo) => {
    const lim = limiteDe(promo);
    if (!lim || (usosPorPromo.get(promo.id) ?? 0) < lim.max) return true;
    if (!topadas.has(promo.id)) topadas.set(promo.id, { id: promo.id, nombre: promo.nombre, motivo: lim.motivo });
    return false;
  };
  const aplicarConTope = (u, promo, monto) => {
    aplicar(u, promo, monto);
    if (monto > 0) usosPorPromo.set(promo.id, (usosPorPromo.get(promo.id) ?? 0) + 1);
  };

  for (const promo of vigentes) {
    if (promo.tipo === "directo") {
      for (const u of unidades) {
        if (deLinea(promo.objetivo)(u) && rige(promo, u.li) && libre(u, promo)) {
          if (!cabe(promo)) break;
          aplicarConTope(u, promo, montoDe(promo.efecto, promo.valor, u.actual));
        }
      }
    } else if (promo.tipo === "nxm") {
      // Lleva n, paga m: en cada grupo de n unidades (de las más caras a las más baratas), las n−m más baratas son gratis.
      const candidatas = unidades.filter((u) => deLinea(promo.objetivo)(u) && rige(promo, u.li) && libre(u, promo)).sort((a, b) => b.actual - a.actual || a.orden - b.orden);
      const grupos = Math.floor(candidatas.length / promo.n);
      let parar = false;
      for (let g = 0; g < grupos && !parar; g++) {
        for (const u of candidatas.slice(g * promo.n, (g + 1) * promo.n).slice(promo.m)) {
          if (!cabe(promo)) {
            parar = true;
            break;
          }
          aplicarConTope(u, promo, u.actual);
        }
      }
    } else if (promo.tipo === "combo") {
      // Por cada unidad del disparador, una del objetivo (la más barata primero) lleva el descuento. Una misma unidad
      // no es a la vez disparador y objetivo de la misma aplicación: con «lleva 2 cafés, el 2.º a mitad» hacen falta dos.
      const objetivos = unidades.filter((u) => deLinea(promo.objetivo)(u) && rige(promo, u.li) && libre(u, promo)).sort((a, b) => a.actual - b.actual || a.orden - b.orden);
      const disparadores = unidades.filter((u) => deLinea(promo.disparador)(u) && rige(promo, u.li)).sort((a, b) => b.base - a.base || a.orden - b.orden);
      const usadas = new Set();
      for (const t of objetivos) {
        if (usadas.has(t)) continue;
        const d = disparadores.find((x) => x !== t && !usadas.has(x));
        if (!d) break;
        if (!cabe(promo)) break;
        usadas.add(t);
        usadas.add(d);
        aplicarConTope(t, promo, montoDe(promo.efecto, promo.valor, t.actual));
      }
    }
  }

  // 3. Resultado: por línea, y por promoción.
  const porLinea = lineas.map(() => ({ centavos: 0, promos: new Map() }));
  const porPromo = new Map();
  for (const u of unidades) {
    for (const { promo, monto } of u.aplicadas) {
      const l = porLinea[u.li];
      l.centavos += monto;
      const x = l.promos.get(promo.id) ?? { id: promo.id, nombre: promo.nombre, monto: 0, unidades: 0 };
      x.monto += monto;
      x.unidades += 1;
      l.promos.set(promo.id, x);
      const t = porPromo.get(promo.id) ?? { id: promo.id, nombre: promo.nombre, veces: 0, monto: 0 };
      t.veces += 1;
      t.monto += monto;
      porPromo.set(promo.id, t);
    }
  }

  const resultadoLineas = lineas.map((l, i) => {
    const valida = unidades.some((u) => u.li === i);
    const base = valida ? Math.round(Number(l.precio) * 100) * Number(l.cantidad) : 0;
    const desc = porLinea[i].centavos;
    return {
      id: l?.id ?? null,
      subtotalBase: aMoneda(base),
      descuento: aMoneda(desc),
      subtotal: aMoneda(base - desc),
      promociones: [...porLinea[i].promos.values()].map((x) => ({ ...x, monto: aMoneda(x.monto) })),
    };
  });
  const totalBase = unidades.reduce((n, u) => n + u.base, 0);
  const descuentoTotal = unidades.reduce((n, u) => n + u.base - u.actual, 0);
  return {
    momento,
    vigentes: vigentes.map((p) => p.id),
    lineas: resultadoLineas,
    aplicadas: [...porPromo.values()].map((x) => ({ ...x, monto: aMoneda(x.monto) })),
    topadas: [...topadas.values()], // promociones que un tope de usos frenó (5.44): [{ id, nombre, motivo }]
    totalBase: aMoneda(totalBase),
    descuentoTotal: aMoneda(descuentoTotal),
    total: aMoneda(totalBase - descuentoTotal),
  };
}
