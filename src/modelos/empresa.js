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
      // Opciones de seguridad que ajusta cada empresa. Los valores por defecto y los límites
      // viven en auth/pin-config.js (no en el esquema) para validarlos con mensajes claros.
      seguridad: {
        pin: {
          habilitado: Boolean,
          largoMin: Number,
          largoMax: Number,
          maxIntentos: Number,
          bloqueoMin: Number,
          inactividadMin: Number,
          sesionMaxHoras: Number,
          codigoVigenciaMin: Number,
        },
      },
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
