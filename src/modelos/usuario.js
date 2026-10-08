import mongoose from "mongoose";
import { marcarGlobal } from "../tenancy.js";

export const usuarioSchema = marcarGlobal(
  new mongoose.Schema(
    {
      correo: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
      },
      passwordHash: { type: String, required: true, select: false },
      nombre: { type: String, trim: true },
      estado: {
        type: String,
        enum: ["activo", "suspendido"],
        default: "activo",
      },
      paginaPrincipal: { type: String }, // preferencia del usuario
      // Contraseña temporal dada por un administrador: hasta cambiarla, la sesión solo sirve para cambiarla.
      debeCambiarPassword: { type: Boolean, default: false },
    },
    { timestamps: true },
  ),
);
