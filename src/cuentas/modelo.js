import mongoose from "mongoose";
import { tenancyPlugin } from "../tenancy.js";

const { ObjectId } = mongoose.Schema.Types;

// Sesión del cliente final. Es una colección distinta de `sesiones` (la del personal): la cookie, la colección y
// el middleware son otros, así que una sesión de cliente nunca llega a permisos de personal (arquitectura 5.13).
// Es de la empresa (con tenancy): la cuenta del cliente vive en su ficha de cada empresa (5.25).
export const sesionClienteSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  clienteId: { type: ObjectId, required: true, index: true },
  creadaTs: { type: Date, required: true },
  ultimoUsoTs: { type: Date, required: true },
  expiraTs: { type: Date, required: true }, // por inactividad; se renueva al usarla
  venceAbsolutoTs: { type: Date, required: true }, // tope: no se renueva nunca
  ip: { type: String, default: null },
  agente: { type: String, default: null },
});
sesionClienteSchema.plugin(tenancyPlugin);
// MongoDB borra solo las sesiones cuya fecha `expiraTs` ya pasó (índice TTL).
sesionClienteSchema.index({ expiraTs: 1 }, { expireAfterSeconds: 0 });
