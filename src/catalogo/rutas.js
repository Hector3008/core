/**
 * Rutas del catálogo. Cada una sale con sus middlewares en orden
 * (autenticar → requierePermiso → handler). El gateway pone `express.json()` antes; el límite sube a 1 MB
 * porque una importación admite hasta 500 filas:
 *
 *   const catalogo = express.Router();
 *   catalogo.use(express.json({ limit: "1mb" }));
 *   core.catalogo.montarRutas(catalogo);
 *   gateway.use("/catalogo", catalogo);
 *
 * Búsqueda: GET /?q=texto (comienzo del código o parte del nombre), &categoria=, &inactivos=1, &limite=, &saltar=
 * Las rutas fijas (/categorias, /codigo/:codigo, /importar) van antes que /:itemId.
 */
export function montarRutasCatalogo(router, { catalogo, autenticar, requierePermiso }) {
  const m = catalogo.manejadores;
  const leer = [autenticar(), requierePermiso("catalogo:leer")];
  const crear = [autenticar(), requierePermiso("catalogo:crear")];
  const editar = [autenticar(), requierePermiso("catalogo:editar")];
  const gestionar = [autenticar(), requierePermiso("catalogo:gestionar")];

  router.get("/", ...leer, m.listar);
  router.get("/categorias", ...leer, m.categorias);
  router.get("/codigo/:codigo", ...leer, m.porCodigo);
  router.get("/:itemId", ...leer, m.obtener);
  router.post("/", ...crear, m.crear);
  router.post("/importar", ...gestionar, m.importar);
  router.put("/:itemId", ...editar, m.actualizar);
  router.post("/:itemId/desactivar", ...gestionar, m.desactivar);
  router.post("/:itemId/reactivar", ...gestionar, m.reactivar);

  return router;
}
