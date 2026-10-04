// Requiere una MongoDB real: MONGODB_URI=mongodb://localhost:27017 node --test
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { tenancyPlugin, conEmpresa } from "../src/tenancy.js";

const uri = process.env.MONGODB_URI;
const opts = {
  skip: uri ? false : "define MONGODB_URI para correr esta prueba",
};

test("aislamiento entre empresas", opts, async (t) => {
  const conn = await mongoose
    .createConnection(uri, { dbName: "core-test-tenancy" })
    .asPromise();

  // Borra solo la colección de prueba (no requiere permiso de dropDatabase)
  const limpiar = async () => {
    try {
      await conn.db.dropCollection("cosas");
    } catch {
      /* no existía */
    }
  };
  t.after(async () => {
    await limpiar();
    await conn.close();
  });
  await limpiar(); // arranca limpio aunque una corrida anterior haya fallado

  const schema = new mongoose.Schema({ nombre: String });
  schema.plugin(tenancyPlugin);
  const Cosa = conn.model("Cosa", schema);
  const A = new mongoose.Types.ObjectId();
  const B = new mongoose.Types.ObjectId();

  await conEmpresa(A, async () => await Cosa.create({ nombre: "de A" }));
  await conEmpresa(B, async () => await Cosa.create({ nombre: "de B" }));

  // sin empresa activa debe fallar
  await assert.rejects(async () => await Cosa.find(), /sin empresa activa/);

  // find solo ve lo de su empresa
  const deA = await conEmpresa(A, async () => await Cosa.find().lean());
  assert.deepEqual(
    deA.map((d) => d.nombre),
    ["de A"],
  );

  // updateMany desde A no toca a B
  await conEmpresa(
    A,
    async () => await Cosa.updateMany({}, { nombre: "tocado" }),
  );
  const deB = await conEmpresa(B, async () => await Cosa.find().lean());
  assert.equal(deB[0].nombre, "de B");

  // aggregate también queda filtrado
  const agg = await conEmpresa(
    B,
    async () => await Cosa.aggregate([{ $count: "n" }]),
  );
  assert.equal(agg[0].n, 1);

  // la salida explícita para tareas de plataforma ve ambas empresas
  const todas = await Cosa.find().setOptions({ sinEmpresa: true }).lean();
  assert.equal(todas.length, 2);
});
