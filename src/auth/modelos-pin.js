import mongoose from "mongoose";
import { tenancyPlugin } from "../tenancy.js";

// Una tablet emparejada con una empresa. Guarda solo el hash del token que lleva su cookie `did`.
// Es de la empresa (tenancy). Para reconocerla en el servidor se busca por tokenHash "de plataforma".
export const dispositivoSchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true, trim: true, maxlength: 60 },
    estacion: { type: String, default: null, trim: true, maxlength: 40 }, // informativa: la tablet de "cocina"
    activo: { type: Boolean, default: true },
    tokenHash: { type: String, required: true, unique: true },
    creadoPor: { type: mongoose.Schema.Types.ObjectId, default: null },
    creadoTs: { type: Date, required: true },
    ultimoUsoTs: { type: Date, default: null },
    revocadoTs: { type: Date, default: null },
    revocadoPor: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: false },
);
dispositivoSchema.plugin(tenancyPlugin);
dispositivoSchema.index({ empresaId: 1, activo: 1 });

// Código de un solo uso con el que se empareja una tablet. Se guarda su hash y caduca solo.
export const codigoSchema = new mongoose.Schema(
  {
    codigoHash: { type: String, required: true, unique: true },
    nombre: { type: String, required: true, trim: true, maxlength: 60 },
    estacion: { type: String, default: null, trim: true, maxlength: 40 },
    creadoPor: { type: mongoose.Schema.Types.ObjectId, default: null },
    expiraTs: { type: Date, required: true },
  },
  { timestamps: false },
);
codigoSchema.plugin(tenancyPlugin);
codigoSchema.index({ expiraTs: 1 }, { expireAfterSeconds: 0 });
