import { AsyncLocalStorage } from "node:async_hooks";

// Contexto de la interacción en curso: { estacion, sesionId, usuarioId }.
// Es independiente de conEmpresa. El motor de documentos emite sus eventos de forma
// síncrona dentro de la llamada, así que el registrador lee este contexto al recibirlos.
const als = new AsyncLocalStorage();

export const conContexto = (ctx, fn) => als.run({ ...ctx }, fn);
export const contextoActual = () => als.getStore();
