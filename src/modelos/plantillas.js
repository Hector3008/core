// Plantillas de rol por servicio. Se copian a cada empresa al crearla.
export const PLANTILLAS = {
  base: {
    admin: ["*"],
  },
  restaurante: {
    mesero: [
      "estacion:creacion",
      "estacion:carta",
      "documento:crear",
      "documento:leer",
      "documento:editar",
      "catalogo:leer",
      "cliente:leer",
      "cliente:crear",
    ],
    cocina: ["estacion:cocina", "documento:leer", "documento:editar"],
    delivery: [
      "estacion:delivery",
      "documento:leer",
      "documento:editar",
      "cliente:leer",
    ],
  },
  siscore: {
    vendedor: [
      "estacion:creacion",
      "documento:crear",
      "documento:leer",
      "documento:editar",
      "catalogo:leer",
      "cliente:*",
    ],
    almacen: [
      "estacion:produccion",
      "documento:leer",
      "documento:editar",
      "catalogo:leer",
    ],
    revisor: [
      "estacion:revision",
      "estacion:bandeja",
      "documento:leer",
      "documento:editar",
    ],
  },
};

export function plantillasPara(servicios) {
  const out = { ...PLANTILLAS.base };
  for (const s of servicios) Object.assign(out, PLANTILLAS[s] ?? {});
  return out;
}
