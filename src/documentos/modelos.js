import mongoose from "mongoose";
import { tenancyPlugin } from "../tenancy.js";

const { Mixed, ObjectId } = mongoose.Schema.Types;

const motivoSchema = new mongoose.Schema(
  { codigo: { type: String, required: true }, detalle: String },
  { _id: false },
);

// Una entrada por cada cambio de estado (la primera es la creación: de = null)
const movimientoSchema = new mongoose.Schema(
  {
    de: { type: String, default: null },
    a: { type: String, required: true },
    usuarioId: { type: ObjectId, default: null },
    sistema: { type: Boolean, default: false },
    ts: { type: Date, required: true },
    motivo: { type: motivoSchema, default: undefined },
  },
  { _id: false },
);

// El registro es un sobre: el documento vive en payload.doc
export const documentoSchema = new mongoose.Schema(
  {
    tipo: { type: String, required: true },
    code: { type: String, required: true },
    estado: { type: String, required: true },
    version: { type: Number, required: true, default: 1 },
    snapshot: { type: Mixed, default: {} }, // copia del cliente y productos al crear
    payload: { type: Mixed, default: {} },
    creadoPor: { type: ObjectId, default: null },
    versionPor: { type: ObjectId, default: null }, // quién hizo la versión actual
    versionTs: { type: Date }, // cuándo se hizo la versión actual
    historial: { type: [movimientoSchema], default: [] },
  },
  { timestamps: true, minimize: false },
);
documentoSchema.plugin(tenancyPlugin);
documentoSchema.index({ empresaId: 1, code: 1 }, { unique: true });
documentoSchema.index({ empresaId: 1, tipo: 1, estado: 1 });

// Copia de cada versión que fue reemplazada (fuera del documento: límite de 16 MB)
export const documentoVersionSchema = new mongoose.Schema(
  {
    tipo: { type: String, required: true },
    code: { type: String, required: true },
    version: { type: Number, required: true },
    estado: String, // estado en que estaba cuando fue reemplazada
    snapshot: { type: Mixed, default: {} },
    payload: { type: Mixed, default: {} },
    usuarioId: { type: ObjectId, default: null }, // quién hizo esta versión
    ts: Date, // cuándo se hizo esta versión
  },
  { minimize: false },
);
documentoVersionSchema.plugin(tenancyPlugin);
documentoVersionSchema.index(
  { empresaId: 1, code: 1, version: 1 },
  { unique: true },
);

// Contador atómico por empresa y tipo. Sin default en `valor`: el $inc lo crea.
export const contadorSchema = new mongoose.Schema({
  tipo: { type: String, required: true },
  valor: Number,
});
contadorSchema.plugin(tenancyPlugin);
contadorSchema.index({ empresaId: 1, tipo: 1 }, { unique: true });
