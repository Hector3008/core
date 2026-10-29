import mongoose from "mongoose";
import { tenancyPlugin } from "../tenancy.js";
import { EFECTOS, TIPOS } from "./validacion.js";

const selector = { _id: false, itemCodigo: { type: String, default: null }, categoria: { type: String, default: null } };

// Promociones de la empresa (5.40): descuentos automáticos sobre lo que lleva un pedido. Nunca se borran: se desactivan.
// La validación vive en validacion.js; aquí solo la forma de lo ya validado.
export const promocionSchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true },
    descripcion: { type: String, default: null },
    activa: { type: Boolean, default: true },
    prioridad: { type: Number, default: 100 }, // menor = se evalúa antes
    acumulable: { type: Boolean, default: false },
    tipo: { type: String, enum: TIPOS, required: true },
    objetivo: { type: selector, default: null },
    disparador: { type: selector, default: null },
    n: { type: Number, default: null },
    m: { type: Number, default: null },
    efecto: { type: String, enum: [...EFECTOS, null], default: null },
    valor: { type: Number, default: null },
    vigencia: { type: { _id: false, desde: { type: String, default: null }, hasta: { type: String, default: null } }, default: null },
    dias: { type: [Number], default: undefined },
    horario: { type: { _id: false, desde: String, hasta: String }, default: null },
    topes: { type: { _id: false, diario: { type: Number, default: null }, porPedido: { type: Number, default: null }, porCliente: { type: Number, default: null } }, default: null },
    creadoPor: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, minimize: false },
);
promocionSchema.plugin(tenancyPlugin);
promocionSchema.index({ empresaId: 1, activa: 1, prioridad: 1 });

// Topes de usos (5.44). Dos colecciones propias de la empresa:
//  · `usos_promocion`: contadores. Uno por promoción y día (`clienteId: null`, el tope diario) y uno por promoción, día y
//    cliente (el tope por cliente). `usos` solo sube con un `$inc` condicionado al tope, así dos pedidos a la vez no se pasan.
//  · `reservas_promocion`: cuántos usos tiene tomados cada pedido (`referencia`) de cada promoción. Es lo que permite
//    recalcular (subir, bajar o liberar) sin contar dos veces. Se borran solas a los 3 días: un tope diario no necesita más.
export const usoPromocionSchema = new mongoose.Schema(
  {
    promocionId: { type: mongoose.Schema.Types.ObjectId, required: true },
    dia: { type: String, required: true }, // AAAA-MM-DD en la zona de la empresa
    clienteId: { type: String, default: null },
    usos: { type: Number, default: 0 },
    expira: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { minimize: false },
);
usoPromocionSchema.plugin(tenancyPlugin);
usoPromocionSchema.index({ empresaId: 1, promocionId: 1, dia: 1, clienteId: 1 }, { unique: true });

export const reservaPromocionSchema = new mongoose.Schema(
  {
    promocionId: { type: mongoose.Schema.Types.ObjectId, required: true },
    referencia: { type: String, required: true }, // el pedido (en tobt, su código PD-…)
    dia: { type: String, required: true },
    clienteId: { type: String, default: null }, // el cliente al que se le contó `usosCliente`
    usosDiario: { type: Number, default: 0 }, // lo que este pedido aporta al contador del día
    usosCliente: { type: Number, default: 0 }, // lo que aporta al contador de ese cliente
    expira: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { minimize: false },
);
reservaPromocionSchema.plugin(tenancyPlugin);
reservaPromocionSchema.index({ empresaId: 1, promocionId: 1, referencia: 1 }, { unique: true });
reservaPromocionSchema.index({ empresaId: 1, referencia: 1 });
