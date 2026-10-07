import mongoose from "mongoose";
import { tenancyPlugin } from "../tenancy.js";

export const membresiaSchema = new mongoose.Schema(
  {
    usuarioId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    rolId: { type: mongoose.Schema.Types.ObjectId, required: true }, // un solo rol
    activa: { type: Boolean, default: true },
    // PIN de acceso rápido (por persona y por empresa). Se guarda con hash, nunca en claro.
    pinHash: { type: String, select: false, default: null },
    pinFallos: { type: Number, default: 0 },
    pinBloqueadoHasta: { type: Date, default: null },
    pinActualizadoTs: { type: Date, default: null },
  },
  { timestamps: true },
);
membresiaSchema.plugin(tenancyPlugin);
membresiaSchema.index({ empresaId: 1, usuarioId: 1 }, { unique: true });
