/**
 * Rutas de moderación de las reseñas (arquitectura 5.62). Cada una sale con sus middlewares en orden
 * (autenticar → requierePermiso → handler). El gateway pone `express.json()` antes:
 *
 *   const resenas = express.Router();
 *   resenas.use(express.json());
 *   core.resenas.montarRutas(resenas);
 *   gateway.use("/resenas", resenas);
 *
 *   GET  /                          resena:leer       ?filtro=todas|reportadas|ocultas&q=&limite=&saltar=  { resenas }
 *   PUT  /:resenaId/visibilidad     resena:gestionar  { oculta: boolean }
 */
export function montarRutasResenas(router, { resenas, autenticar, requierePermiso }) {
  const m = resenas.manejadores;
  router.get("/", autenticar(), requierePermiso("resena:leer"), m.listar);
  router.put("/:resenaId/visibilidad", autenticar(), requierePermiso("resena:gestionar"), m.moderar);
  return router;
}
