import { AsyncLocalStorage } from "node:async_hooks";
import mongoose from "mongoose";

const als = new AsyncLocalStorage();
const globales = new WeakSet();

export const conEmpresa = (empresaId, fn) =>
  als.run({ empresaId: String(empresaId) }, fn);
export const empresaActual = () => als.getStore()?.empresaId;
export const marcarGlobal = (schema) => (globales.add(schema), schema);

const OPS = [
  "find",
  "findOne",
  "countDocuments",
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
  "findOneAndUpdate",
  "findOneAndDelete",
  "findOneAndReplace",
  "replaceOne",
];

function exigirEmpresa() {
  const id = empresaActual();
  if (!id)
    throw new Error(
      "Consulta sin empresa activa (use conEmpresa o sinEmpresa)",
    );
  return new mongoose.Types.ObjectId(id);
}

export function tenancyPlugin(schema) {
  if (globales.has(schema)) return;

  schema.add({
    empresaId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
  });

  schema.pre(OPS, function () {
    if (this.getOptions().sinEmpresa) return;
    this.where({ empresaId: exigirEmpresa() });
  });

  schema.pre("validate", function () {
    if (this.isNew && !this.empresaId) this.empresaId = exigirEmpresa();
  });

  // Mongoose 9: sin callback next, recibe los docs
  schema.pre("insertMany", function (docs) {
    const id = exigirEmpresa();
    for (const d of docs) d.empresaId ??= id;
  });

  schema.pre("aggregate", function () {
    if (this.options?.sinEmpresa) return;
    this.pipeline().unshift({ $match: { empresaId: exigirEmpresa() } });
  });
}
