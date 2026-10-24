import mongoose from "mongoose";
import { tenancyPlugin } from "../tenancy.js";
import { TIPOS } from "./validacion.js";

// Anuncios de la empresa (5.48): eventos (un concierto) y publicidad (un aviso) que salen en la carta pública.
// Nunca se borran: se pausan. La validación vive en validacion.js; aquí solo la forma de lo ya validado.
export const anuncioSchema = new mongoose.Schema(
  {
    titulo: { type: String, required: true },
    descripcion: { type: String, default: null },
    activo: { type: Boolean, default: true },
    tipo: { type: String, enum: TIPOS, required: true },
    imagen: { type: String, default: null },
    fecha: { type: String, default: null }, // evento: AAAA-MM-DD en la hora de la empresa
    hora: { type: String, default: null }, // evento: HH:MM
    lugar: { type: String, default: null },
    vigencia: { type: { _id: false, desde: { type: String, default: null }, hasta: { type: String, default: null } }, default: null },
    creadoPor: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, minimize: false },
);
anuncioSchema.plugin(tenancyPlugin);
anuncioSchema.index({ empresaId: 1, activo: 1, tipo: 1 });
