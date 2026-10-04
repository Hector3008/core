import mongoose from "mongoose";
import { marcarGlobal } from "../tenancy.js";

export const empresaSchema = marcarGlobal(
  new mongoose.Schema(
    {
      nombre: { type: String, required: true, trim: true },
      slug: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
      },
      activa: { type: Boolean, default: true },
      servicios: [
        {
          _id: false,
          codigo: { type: String, required: true },
          activa: { type: Boolean, default: true },
        },
      ],
    },
    { timestamps: true },
  ),
);
