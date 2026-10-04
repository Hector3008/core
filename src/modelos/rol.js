import mongoose from "mongoose";
import { tenancyPlugin } from "../tenancy.js";

export const rolSchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true, trim: true },
    permisos: { type: [String], default: [] },
  },
  { timestamps: true },
);
rolSchema.plugin(tenancyPlugin);
rolSchema.index({ empresaId: 1, nombre: 1 }, { unique: true });
