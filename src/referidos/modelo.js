import mongoose from "mongoose";
import { tenancyPlugin } from "../tenancy.js";

const { ObjectId } = mongoose.Schema.Types;

export const ESTADOS_REFERIDO = ["pendiente", "premiado", "sin_cupo"];
export const ORIGENES_REFERIDO = ["registro", "personal"];

// Un referido (5.45): «el cliente A trajo al cliente B». Una ficha solo puede ser referida una vez.
//   pendiente → todavía no hace su primer consumo pagado (o no llegó al mínimo)
//   premiado  → se dieron los puntos (los que se dieron, en puntosReferente/puntosReferido; 0 si alguien no podía recibirlos)
//   sin_cupo  → al consumir, quien refirió ya había alcanzado su tope: no hay premio para nadie
export const referidoSchema = new mongoose.Schema(
  {
    referenteId: { type: ObjectId, required: true },
    referidoId: { type: ObjectId, required: true },
    estado: { type: String, enum: ESTADOS_REFERIDO, default: "pendiente" },
    origen: { type: String, enum: ORIGENES_REFERIDO, required: true },
    ts: { type: Date, required: true },
    premiadoTs: { type: Date, default: null },
    puntosReferente: { type: Number, default: 0 },
    puntosReferido: { type: Number, default: 0 },
    documentoCode: { type: String, default: null }, // el pago que lo premió
    creadoPor: { type: ObjectId, default: null }, // usuario del personal que lo vinculó; null = el propio cliente
  },
  { versionKey: false },
);
referidoSchema.plugin(tenancyPlugin);
referidoSchema.index({ empresaId: 1, referidoId: 1 }, { unique: true }); // referida una sola vez
referidoSchema.index({ empresaId: 1, referenteId: 1, estado: 1 });
