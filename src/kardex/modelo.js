import mongoose from "mongoose";
import { tenancyPlugin } from "../tenancy.js";
import { ErrorKardex } from "./errores.js";
import { TIPOS_MOVIMIENTO } from "./calculo.js";

const { ObjectId } = mongoose.Schema.Types;

// Insumo (ingrediente o producto que se guarda y se gasta). Lleva una copia de su saldo (existencia y costo promedio)
// para listar rápido; la fuente de verdad es el libro de movimientos (un fallo al actualizar la copia no pierde nada:
// `repararSaldo` la rehace desde el libro).
export const insumoSchema = new mongoose.Schema(
  {
    codigo: { type: String, required: true },
    codigoClave: { type: String, required: true }, // el código en minúsculas: identifica sin distinguir mayúsculas
    nombre: { type: String, required: true },
    unidad: { type: String, required: true },
    presentaciones: { type: [{ _id: false, nombre: String, factor: Number }], default: [] },
    stockMinimo: { type: Number, default: 0 },
    activo: { type: Boolean, default: true },
    existencia: { type: Number, default: 0 },
    costoPromedio: { type: Number, default: 0 },
    ultimaSecuencia: { type: Number, default: 0 },
    creadoPor: { type: ObjectId, default: null },
  },
  { timestamps: true, minimize: false },
);
insumoSchema.plugin(tenancyPlugin);
insumoSchema.index({ empresaId: 1, codigoClave: 1 }, { unique: true });

// Libro del kardex: solo inserción. Cada insumo lleva su propia cuenta con `secuencia` 1, 2, 3…: el índice único
// {insumo, secuencia} es lo que ordena los movimientos simultáneos (el segundo en llegar reintenta con la secuencia siguiente),
// y {insumo, referencia, tipo} hace idempotente lo que sale de un documento (un ítem consume una sola vez).
export const movimientoKardexSchema = new mongoose.Schema(
  {
    insumoId: { type: ObjectId, required: true },
    secuencia: { type: Number, required: true },
    tipo: { type: String, enum: TIPOS_MOVIMIENTO, required: true },
    cantidad: { type: Number, required: true }, // en unidad base, con signo (entra +, sale −)
    costoUnitario: { type: Number, required: true },
    valor: { type: Number, required: true }, // cantidad × costoUnitario, con signo
    existenciaDespues: { type: Number, required: true },
    costoPromedioDespues: { type: Number, required: true },
    presentacion: { type: { _id: false, nombre: String, cantidad: Number, factor: Number }, default: null }, // lo que se escribió, si fue en otra presentación
    anulaA: { type: ObjectId, default: null }, // en una anulación: el movimiento que deshace (su referencia es ANUL-<id>)
    referencia: { type: String, default: null }, // el documento que originó el movimiento (por ejemplo DOC_ITEM-0000123)
    detalle: { type: String, default: null },
    creadoPor: { type: ObjectId, default: null }, // null = el sistema
    ts: { type: Date, required: true },
  },
  { versionKey: false },
);
movimientoKardexSchema.plugin(tenancyPlugin);
movimientoKardexSchema.index({ empresaId: 1, insumoId: 1, secuencia: 1 }, { unique: true, name: "secuencia_unica" });
movimientoKardexSchema.index(
  { empresaId: 1, insumoId: 1, referencia: 1, tipo: 1 },
  { unique: true, name: "referencia_unica", partialFilterExpression: { referencia: { $type: "string" } } },
);
movimientoKardexSchema.index({ empresaId: 1, referencia: 1 });
movimientoKardexSchema.index({ empresaId: 1, ts: -1 });

const OPS_PROHIBIDAS = ["updateOne", "updateMany", "deleteOne", "deleteMany", "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace", "replaceOne"];
const prohibido = () => {
  throw new ErrorKardex("ESTADO_INVALIDO", "El kardex es solo de inserción");
};
movimientoKardexSchema.pre(OPS_PROHIBIDAS, prohibido);
movimientoKardexSchema.pre("save", function () {
  if (!this.isNew) prohibido();
});
