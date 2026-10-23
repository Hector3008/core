import mongoose from "mongoose";
import { tenancyPlugin } from "../tenancy.js";
import { EFECTOS, TIPOS } from "./validacion.js";

const selector = { _id: false, itemCodigo: { type: String, default: null }, categoria: { type: String, default: null } };

// Promociones de la empresa (5.40): descuentos automáticos sobre lo que lleva un pedido. Nunca se borran: se desactivan.
// La validación vive en validacion.js; aquí solo la forma de lo ya validado.
export const promocionSchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true },
    descripcion: { type: String, default: null },
    activa: { type: Boolean, default: true },
    prioridad: { type: Number, default: 100 }, // menor = se evalúa antes
    acumulable: { type: Boolean, default: false },
    tipo: { type: String, enum: TIPOS, required: true },
    objetivo: { type: selector, default: null },
    disparador: { type: selector, default: null },
    n: { type: Number, default: null },
    m: { type: Number, default: null },
    efecto: { type: String, enum: [...EFECTOS, null], default: null },
    valor: { type: Number, default: null },
    vigencia: { type: { _id: false, desde: { type: String, default: null }, hasta: { type: String, default: null } }, default: null },
    dias: { type: [Number], default: undefined },
    horario: { type: { _id: false, desde: String, hasta: String }, default: null },
    creadoPor: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, minimize: false },
);
promocionSchema.plugin(tenancyPlugin);
promocionSchema.index({ empresaId: 1, activa: 1, prioridad: 1 });
