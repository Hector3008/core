import mongoose from "mongoose";
import { tenancyPlugin } from "../tenancy.js";

// Reseñas de platos (5.62): estrellas y texto de un cliente con cuenta sobre un plato del catálogo que ya pagó.
// Una por cliente y plato (editable). Nunca se borran por moderación: se ocultan. El autor no se guarda: se calcula
// al leer desde la ficha del cliente (así el nombre editado o una anonimización se reflejan solos).
export const resenaSchema = new mongoose.Schema(
  {
    itemClave: { type: String, required: true }, // código del plato en minúsculas
    itemCodigo: { type: String, required: true }, // el código tal como está en el catálogo
    clienteId: { type: mongoose.Schema.Types.ObjectId, required: true },
    estrellas: { type: Number, required: true, min: 1, max: 5 },
    texto: { type: String, default: null },
    oculta: { type: Boolean, default: false },
    ocultaPor: { type: mongoose.Schema.Types.ObjectId, default: null },
    ocultaTs: { type: Date, default: null },
    reportadoPor: { type: [mongoose.Schema.Types.ObjectId], default: [] }, // clientes que la reportaron (sin repetir)
    reportes: { type: Number, default: 0 },
  },
  { timestamps: true, minimize: false },
);
resenaSchema.plugin(tenancyPlugin);
resenaSchema.index({ empresaId: 1, itemClave: 1, clienteId: 1 }, { unique: true });
resenaSchema.index({ empresaId: 1, itemClave: 1, oculta: 1, createdAt: -1 });
resenaSchema.index({ empresaId: 1, reportes: -1, createdAt: -1 });
