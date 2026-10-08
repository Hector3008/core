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
      // País de la empresa (ISO de 2 letras). Fija el código telefónico por defecto de sus clientes.
      // Las empresas anteriores a este campo no lo tienen: se asume PE (ver telefono.js).
      pais: { type: String, default: "PE", uppercase: true, trim: true },
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
