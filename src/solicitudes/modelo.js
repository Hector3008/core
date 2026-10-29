import mongoose from "mongoose";
import { marcarGlobal } from "../tenancy.js";

// Solicitud de una empresa nueva (5.65). Es de la PLATAFORMA, no de una empresa (por eso `marcarGlobal`): existe antes de que haya empresa.
// El enlace que recibe el operador es un secreto de 256 bits: aquí solo se guarda su hash (sha-256).
export const solicitudSchema = marcarGlobal(
  new mongoose.Schema(
    {
      nombre: { type: String, required: true },
      slug: { type: String, required: true, index: true },
      servicios: { type: [String], required: true },
      pais: { type: String, required: true },
      moneda: { type: String, required: true },
      telefono: { type: String, required: true },
      adminNombre: { type: String, required: true },
      adminCorreo: { type: String, required: true, index: true },
      aceptacion: { terminos: String, privacidad: String, ts: Date },
      // pendiente → (procesando) → aprobada | rechazada. `incompleta`: se creó la empresa pero falló el alta del admin; se reanuda al reintentar.
      estado: { type: String, enum: ["pendiente", "procesando", "incompleta", "aprobada", "rechazada"], default: "pendiente", index: true },
      tokenHash: { type: String, unique: true, sparse: true },
      expira: { type: Date, required: true },
      empresaId: { type: mongoose.Schema.Types.ObjectId, default: null },
      resueltaTs: { type: Date, default: null },
      error: { type: String, default: null },
    },
    { timestamps: true },
  ),
);

// Enlace de un solo uso para que la persona elija su contraseña (aprobada su empresa). También solo guarda el hash.
export const tokenPasswordSchema = marcarGlobal(
  new mongoose.Schema(
    {
      usuarioId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
      tipo: { type: String, enum: ["acceso", "recuperacion"], default: "acceso" }, // acceso: lo emite el sistema o el operador; recuperacion: «olvidé mi contraseña»
      tokenHash: { type: String, required: true, unique: true },
      expira: { type: Date, required: true, index: { expireAfterSeconds: 60 * 60 * 24 * 30 } }, // se borra a los 30 días de vencer
      usadoTs: { type: Date, default: null },
    },
    { timestamps: true },
  ),
);
