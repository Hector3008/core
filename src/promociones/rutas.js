/**
 * Rutas de las promociones (arquitectura 5.40). Cada una sale con sus middlewares en orden
 * (autenticar → requierePermiso → handler). El gateway pone `express.json()` antes:
 *
 *   const promociones = express.Router();
 *   promociones.use(express.json());
 *   core.promociones.montarRutas(promociones);
 *   gateway.use("/promociones", promociones);
 *
 *   GET  /                    promocion:leer       { promociones }
 *   POST /                    promocion:gestionar  { nombre, tipo, objetivo, … } → 201
 *   POST /simular             promocion:leer       { items, ahora?, borrador?, soloBorrador? } → el cálculo sobre un pedido de ejemplo
 *   PUT  /:promocionId        promocion:gestionar  { …cambios, activa? }
 */
export function montarRutasPromociones(router, { promociones, autenticar, requierePermiso }) {
  const m = promociones.manejadores;
  const leer = [autenticar(), requierePermiso("promocion:leer")];
  const gestionar = [autenticar(), requierePermiso("promocion:gestionar")];

  router.get("/", ...leer, m.listar);
  router.post("/", ...gestionar, m.crear);
  // `/simular` va antes de `/:promocionId` para que «simular» no se tome por un id.
  router.post("/simular", ...leer, m.simular);
  router.put("/:promocionId", ...gestionar, m.editar);

  return router;
}
