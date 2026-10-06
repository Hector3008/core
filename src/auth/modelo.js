import mongoose from "mongoose";
import { marcarGlobal } from "../tenancy.js";

// Una sesión es global (como Usuario): la persona entra a la plataforma y después elige empresa.
// Por eso el campo se llama `empresaActivaId` y no `empresaId`: no es el campo del plugin de tenancy.
export const sesionSchema = marcarGlobal(
  new mongoose.Schema({
    tokenHash: { type: String, required: true, unique: true },
    usuarioId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    empresaActivaId: { type: mongoose.Schema.Types.ObjectId, default: null },
    // Cómo se autenticó. Hoy solo "password"; el acceso por PIN agregará "pin" (y usará dispositivoId).
    metodo: { type: String, enum: ["password"], default: "password" },
    dispositivoId: { type: mongoose.Schema.Types.ObjectId, default: null },
    creadaTs: { type: Date, required: true },
    ultimoUsoTs: { type: Date, required: true },
    expiraTs: { type: Date, required: true }, // por inactividad; se renueva al usarla
    venceAbsolutoTs: { type: Date, required: true }, // tope: no se renueva nunca
    ip: { type: String, default: null },
    agente: { type: String, default: null },
  }),
);
// MongoDB borra solo los documentos cuya fecha `expiraTs` ya pasó (índice TTL).
sesionSchema.index({ expiraTs: 1 }, { expireAfterSeconds: 0 });
