import mongoose from "mongoose";
import { tenancyPlugin } from "../tenancy.js";
import { ErrorEvento } from "./errores.js";

const { Mixed, ObjectId } = mongoose.Schema.Types;

export const eventoSchema = new mongoose.Schema(
  {
    usuarioId: { type: ObjectId, default: null },
    sesionId: { type: String, default: null },
    documentoCode: { type: String, default: null },
    tipoDocumento: { type: String, default: null }, // solo en eventos del motor
    version: { type: Number, default: null },
    estacion: { type: String, default: null },
    tipo: { type: String, required: true },
    origen: { type: String, enum: ["servidor", "interfaz"], required: true },
    ts: { type: Date, required: true }, // cuándo ocurrió
    recibidoTs: { type: Date, required: true }, // cuándo llegó al servidor
    datos: { type: Mixed, default: {} },
  },
  { minimize: false, versionKey: false },
);
eventoSchema.plugin(tenancyPlugin);
eventoSchema.index({ empresaId: 1, documentoCode: 1, ts: 1 });
eventoSchema.index({ empresaId: 1, tipo: 1, ts: 1 });
eventoSchema.index({ empresaId: 1, estacion: 1, ts: 1 });

// Solo inserción: ninguna actualización ni borrado pasa por Mongoose.
// (Una purga por retención se haría con el driver nativo, de forma explícita.)
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
  throw new ErrorEvento("SOLO_INSERCION", "La colección de eventos es solo de inserción");
};
eventoSchema.pre(OPS_PROHIBIDAS, prohibido);
eventoSchema.pre("save", function () {
  if (!this.isNew) prohibido();
});
