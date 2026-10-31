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
      // Cuenta de Google vinculada (5.69): `sub` es el identificador estable de la persona en Google (el correo puede cambiar,
      // el sub no). Se guarda la primera vez que entra con Google y desde entonces solo esa cuenta de Google entra como ella.
      google: {
        sub: { type: String },
        vinculadaTs: { type: Date },
      },
    },
    { timestamps: true },
  ),
);
// Un `sub` de Google solo puede estar en un usuario (los usuarios sin Google no cuentan).
usuarioSchema.index({ "google.sub": 1 }, { unique: true, partialFilterExpression: { "google.sub": { $type: "string" } } });
