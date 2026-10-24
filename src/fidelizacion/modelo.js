import mongoose from "mongoose";
import { tenancyPlugin } from "../tenancy.js";
import { ErrorFidelizacion } from "./errores.js";
import { TIPOS_BENEFICIO, ESTADOS_TICKET, ORIGENES_TICKET } from "./beneficios.js";

const { ObjectId } = mongoose.Schema.Types;

export const TIPOS_MOVIMIENTO = ["acumulo", "canje", "ajuste", "vencimiento", "bono"];

// Libro de movimientos de puntos: solo inserción. El saldo de un cliente es la suma de sus movimientos
// (acumulo, bono —premio por referidos, 5.45— y ajuste positivo suman; canje, vencimiento y ajuste negativo restan: el signo ya va en `puntos`).
export const movimientoPuntosSchema = new mongoose.Schema(
  {
    clienteId: { type: ObjectId, required: true },
    documentoCode: { type: String, default: null }, // el documento que originó los puntos (solo `acumulo`)
    itemCodigo: { type: String, default: null }, // el ítem del catálogo que se pagó (solo `acumulo`; 5.31: avance de los retos)
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

// ---------- beneficios y vales (arquitectura 5.30) ----------

// Catálogo de beneficios que la empresa ofrece a cambio de puntos.
export const beneficioSchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true },
    descripcion: { type: String, default: null },
    puntos: { type: Number, required: true },
    tipo: { type: String, enum: TIPOS_BENEFICIO, required: true },
    valor: { type: Number, default: null },
    itemCodigo: { type: String, default: null },
    vigenciaDias: { type: Number, required: true },
    activo: { type: Boolean, default: true },
  },
  { timestamps: true },
);
beneficioSchema.plugin(tenancyPlugin);
beneficioSchema.index({ empresaId: 1, activo: 1 });

// Vale que el cliente obtiene al canjear un beneficio. Lleva una copia del beneficio (si luego se edita, el vale
// ya emitido no cambia). Se consume una sola vez, con una actualización atómica del estado.
export const ticketSchema = new mongoose.Schema(
  {
    codigo: { type: String, required: true },
    clienteId: { type: ObjectId, required: true },
    beneficioId: { type: ObjectId, required: true },
    beneficio: {
      nombre: String,
      descripcion: { type: String, default: null },
      tipo: String,
      valor: { type: Number, default: null },
      itemCodigo: { type: String, default: null },
    },
    puntos: { type: Number, required: true }, // lo que costó (se devuelve si el cliente lo cancela)
    estado: { type: String, enum: ESTADOS_TICKET, default: "activo" },
    origen: { type: String, enum: ORIGENES_TICKET, default: "canje" }, // `canje`: lo pagó con puntos · `reto`: lo ganó solo (5.31)
    retoId: { type: ObjectId, default: null },
    ts: { type: Date, required: true },
    venceTs: { type: Date, required: true },
    emitidoPor: { type: ObjectId, default: null }, // usuario del personal; null = lo canjeó el propio cliente
    usadoTs: { type: Date, default: null },
    usadoPor: { type: ObjectId, default: null },
    uso: {
      pedidoCode: { type: String, default: null },
      itemCode: { type: String, default: null },
      descuento: { type: Number, default: null },
    },
    canceladoTs: { type: Date, default: null },
  },
  { versionKey: false },
);
ticketSchema.plugin(tenancyPlugin);
ticketSchema.index({ empresaId: 1, codigo: 1 }, { unique: true });
ticketSchema.index({ empresaId: 1, clienteId: 1, ts: -1 });
// Un reto da su vale una sola vez por cliente, aunque dos pagos lleguen a la vez (5.31).
ticketSchema.index(
  { empresaId: 1, clienteId: 1, retoId: 1 },
  { unique: true, partialFilterExpression: { retoId: { $type: "objectId" } } },
);

// Retos de colección (5.31): «prueba todo lo de una categoría y te regalamos esto». El premio se define como un
// beneficio sin costo en puntos; el avance se calcula desde el libro de puntos.
export const retoSchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true },
    descripcion: { type: String, default: null },
    categoria: { type: String, required: true },
    tipo: { type: String, enum: TIPOS_BENEFICIO, required: true },
    valor: { type: Number, default: null },
    itemCodigo: { type: String, default: null },
    vigenciaDias: { type: Number, required: true },
    activo: { type: Boolean, default: true },
  },
  { timestamps: true },
);
retoSchema.plugin(tenancyPlugin);
retoSchema.index({ empresaId: 1, activo: 1 });
