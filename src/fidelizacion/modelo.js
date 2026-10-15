import mongoose from "mongoose";
import { tenancyPlugin } from "../tenancy.js";
import { ErrorFidelizacion } from "./errores.js";

const { ObjectId } = mongoose.Schema.Types;

export const TIPOS_MOVIMIENTO = ["acumulo", "canje", "ajuste", "vencimiento"];

// Libro de movimientos de puntos: solo inserción. El saldo de un cliente es la suma de sus movimientos
// (acumulo y ajuste positivo suman; canje, vencimiento y ajuste negativo restan: el signo ya va en `puntos`).
export const movimientoPuntosSchema = new mongoose.Schema(
  {
    clienteId: { type: ObjectId, required: true },
    documentoCode: { type: String, default: null }, // el documento que originó los puntos (solo `acumulo`)
    tipo: { type: String, enum: TIPOS_MOVIMIENTO, required: true },
    puntos: {
      type: Number,
      required: true,
      validate: { validator: (n) => Number.isInteger(n) && n !== 0, message: "puntos: un entero distinto de 0" },
    },
    detalle: { type: String, default: null },
    creadoPor: { type: ObjectId, default: null }, // usuario del personal; null = el sistema
    ts: { type: Date, required: true },
  },
  { versionKey: false },
);
movimientoPuntosSchema.plugin(tenancyPlugin);
movimientoPuntosSchema.index({ empresaId: 1, clienteId: 1, ts: -1 });
// Idempotencia (arquitectura 5.11): un documento acumula puntos una sola vez. Reprocesar un evento no suma dos veces.
movimientoPuntosSchema.index(
  { empresaId: 1, documentoCode: 1, tipo: 1 },
  { unique: true, partialFilterExpression: { documentoCode: { $type: "string" } } },
);

// Solo inserción: ninguna actualización ni borrado pasa por Mongoose.
const OPS_PROHIBIDAS = [
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
  "findOneAndUpdate",
  "findOneAndDelete",
  "findOneAndReplace",
  "replaceOne",
];
const prohibido = () => {
  throw new ErrorFidelizacion("ESTADO_INVALIDO", "El libro de puntos es solo de inserción");
};
movimientoPuntosSchema.pre(OPS_PROHIBIDAS, prohibido);
movimientoPuntosSchema.pre("save", function () {
  if (!this.isNew) prohibido();
});
