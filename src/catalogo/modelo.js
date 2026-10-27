import mongoose from "mongoose";
import { tenancyPlugin } from "../tenancy.js";

export const itemSchema = new mongoose.Schema(
  {
    codigo: { type: String, required: true, trim: true }, // como lo escribió la persona; no cambia
    codigoClave: { type: String, required: true }, // el código en minúsculas: identifica al ítem sin distinguir mayúsculas
    nombre: { type: String, required: true, trim: true }, // la descripción del ítem
    categoria: { type: String, default: null }, // opcional, texto libre
    precio: { type: Number, default: null }, // opcional, 2 decimales; la moneda es la de la empresa
    atributos: { type: mongoose.Schema.Types.Mixed, default: {} }, // lo propio de cada servicio (ver atributos.js)
    activo: { type: Boolean, default: true },
    desactivadoTs: { type: Date, default: null },
    // Disponibilidad del día (5.60): cocina marca «agotado» lo que no hay hoy. No es una baja: el ítem sigue en el
    // catálogo y se puede pedir; solo avisa. Quién y cuándo lo marcó se guarda para saber a quién preguntar.
    agotado: { type: Boolean, default: false },
    agotadoTs: { type: Date, default: null },
    agotadoPor: { type: mongoose.Schema.Types.ObjectId, default: null },
    creadoPor: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, minimize: false },
);
itemSchema.plugin(tenancyPlugin);

itemSchema.index({ empresaId: 1, codigoClave: 1 }, { unique: true });
itemSchema.index({ empresaId: 1, nombre: 1 });
itemSchema.index({ empresaId: 1, categoria: 1, nombre: 1 });
