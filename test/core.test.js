import test from "node:test";
import assert from "node:assert";
import mongoose from "mongoose";
import { createCore } from "../src/index.js";

test("rechaza si no hay conexión", () => {
  assert.throws(() => createCore({}), /Connection de Mongoose/);
  assert.throws(() => createCore({ connection: {} }), /Connection de Mongoose/);
});

test("acepta una conexión (aunque no esté abierta) y reporta estado", async () => {
  const connection = mongoose.createConnection();
  const core = createCore({ connection });
  assert.strictEqual(core.estado(), "desconectado");
  assert.deepStrictEqual(await core.ping(), {
    ok: false,
    estado: "desconectado",
  });
});

test("model() es idempotente y aplica plugins registrados", () => {
  const connection = mongoose.createConnection();
  const core = createCore({ connection });
  let aplicado = 0;
  core.use(() => {
    aplicado += 1;
  });

  const A = core.model("Prueba", new mongoose.Schema({ x: String }));
  const B = core.model("Prueba", new mongoose.Schema({ x: String }));
  assert.strictEqual(A, B);
  assert.strictEqual(aplicado, 1);
});
