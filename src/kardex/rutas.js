/**
 * Rutas del kardex (arquitectura 5.75). Cada una sale con sus middlewares en orden
 * (autenticar → requierePermiso → handler). El gateway pone `express.json()` antes:
 *
 *   const kardex = express.Router();
 *   kardex.use(express.json());
 *   core.kardex.montarRutas(kardex);
 *   gateway.use("/kardex", kardex);
 *
 *   GET  /insumos                       kardex:leer       ?q= &bajoMinimo=1 &inactivos=1 &limite= &saltar= → { total, insumos }
 *   POST /insumos                       kardex:gestionar  { codigo, nombre, unidad, presentaciones?, stockMinimo? } → 201
 *   GET  /insumos/:insumoId             kardex:leer
 *   PUT  /insumos/:insumoId             kardex:gestionar  { nombre?, stockMinimo?, presentaciones?, activo? }
 *   POST /insumos/:insumoId/inicial     kardex:gestionar  { cantidad, presentacion?, costo | costoTotal } → 201
 *   POST /insumos/:insumoId/compra      kardex:registrar  { cantidad, presentacion?, costo | costoTotal, detalle? } → 201
 *   POST /insumos/:insumoId/merma       kardex:registrar  { cantidad, presentacion?, detalle } → 201
 *   POST /insumos/:insumoId/conteo      kardex:gestionar  { cantidad, presentacion?, detalle } → 201 (200 si no había diferencia)
 *   POST /insumos/:insumoId/reparar     kardex:gestionar
 *   GET  /movimientos                   kardex:leer       ?insumoId= &tipo= &referencia= &desde= &hasta= &limite= &saltar=
 *   POST /movimientos/:movimientoId/anular  kardex:gestionar  { detalle } → 201 (compras, mermas, ajustes e inventario inicial; deja el movimiento marcado como anulado)
 *   GET  /valorizacion                  kardex:leer
 */
export function montarRutasKardex(router, { kardex, autenticar, requierePermiso }) {
  const m = kardex.manejadores;
  const leer = [autenticar(), requierePermiso("kardex:leer")];
  const registrar = [autenticar(), requierePermiso("kardex:registrar")];
  const gestionar = [autenticar(), requierePermiso("kardex:gestionar")];

  router.get("/insumos", ...leer, m.listarInsumos);
  router.post("/insumos", ...gestionar, m.crearInsumo);
  router.get("/insumos/:insumoId", ...leer, m.obtenerInsumo);
  router.put("/insumos/:insumoId", ...gestionar, m.editarInsumo);
  router.post("/insumos/:insumoId/inicial", ...gestionar, m.inventarioInicial);
  router.post("/insumos/:insumoId/compra", ...registrar, m.compra);
  router.post("/insumos/:insumoId/merma", ...registrar, m.merma);
  router.post("/insumos/:insumoId/conteo", ...gestionar, m.conteo);
  router.post("/insumos/:insumoId/reparar", ...gestionar, m.reparar);
  router.get("/movimientos", ...leer, m.movimientos);
  router.post("/movimientos/:movimientoId/anular", ...gestionar, m.anular);
  router.get("/valorizacion", ...leer, m.valorizacion);

  return router;
}
