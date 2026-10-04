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
  },
  { timestamps: true },
);
membresiaSchema.plugin(tenancyPlugin);
membresiaSchema.index({ empresaId: 1, usuarioId: 1 }, { unique: true });
