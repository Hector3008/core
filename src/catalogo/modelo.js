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
    creadoPor: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, minimize: false },
);
itemSchema.plugin(tenancyPlugin);

itemSchema.index({ empresaId: 1, codigoClave: 1 }, { unique: true });
itemSchema.index({ empresaId: 1, nombre: 1 });
itemSchema.index({ empresaId: 1, categoria: 1, nombre: 1 });
