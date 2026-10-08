import mongoose from "mongoose";
import { tenancyPlugin } from "../tenancy.js";
import { REDES_SOPORTADAS } from "./redes.js";
import { FINALIDADES } from "./validacion.js";

// Un consentimiento: estado actual de una finalidad. El historial completo va aparte (solo se agrega).
const consentimientoSchema = new mongoose.Schema(
  {
    otorgado: { type: Boolean, required: true },
    ts: { type: Date, required: true },
    medio: { type: String, required: true },
    registradoPor: { type: mongoose.Schema.Types.ObjectId, default: null }, // usuario del personal
  },
  { _id: false },
);

const historialSchema = new mongoose.Schema(
  {
    finalidad: { type: String, required: true },
    otorgado: { type: Boolean, required: true },
    ts: { type: Date, required: true },
    medio: { type: String, required: true },
    registradoPor: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { _id: false },
);

const identificacionSchema = new mongoose.Schema(
  { tipo: { type: String, required: true }, numero: { type: String, required: true } },
  { _id: false },
);

// Salen de las tablas de redes.js y validacion.js: agregar una red o una finalidad no toca este archivo.
const redes = Object.fromEntries(REDES_SOPORTADAS.map((r) => [r, { type: String }]));
const consentimientos = Object.fromEntries(
  FINALIDADES.map((f) => [f, { type: consentimientoSchema, default: null }]),
);

export const clienteSchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true, trim: true },
    telefono: { type: String, default: null }, // siempre en formato internacional (+51987654321)
    telefonoPais: { type: String, default: null }, // país del número (PE, AR...), deducido de él
    correo: { type: String, default: null }, // en minúsculas
    redes, // { instagram, tiktok, facebook, x }: solo el usuario, sin @ ni enlace
    identificacion: { type: identificacionSchema, default: null }, // { tipo: "RUC", numero }
    direccion: { type: String, default: null },
    preferencias: { type: mongoose.Schema.Types.Mixed, default: {} }, // se copia al documento al crearlo
    consentimientos,
    historialConsentimientos: { type: [historialSchema], default: [] }, // últimos 100 cambios
    activo: { type: Boolean, default: true },
    desactivadoTs: { type: Date, default: null },
    anonimizadoTs: { type: Date, default: null },
    creadoPor: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, minimize: false },
);
clienteSchema.plugin(tenancyPlugin);

// Un teléfono o un correo identifica a un solo cliente por empresa. Los índices son parciales:
// los clientes sin teléfono (o sin correo) no chocan entre sí.
clienteSchema.index(
  { empresaId: 1, telefono: 1 },
  { unique: true, partialFilterExpression: { telefono: { $type: "string" } } },
);
clienteSchema.index(
  { empresaId: 1, correo: 1 },
  { unique: true, partialFilterExpression: { correo: { $type: "string" } } },
);
clienteSchema.index({ empresaId: 1, nombre: 1 });
