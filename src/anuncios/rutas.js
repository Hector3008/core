/**
 * Rutas de los anuncios (arquitectura 5.48). Cada una sale con sus middlewares en orden
 * (autenticar → requierePermiso → handler). El gateway pone `express.json()` antes:
 *
 *   const anuncios = express.Router();
 *   anuncios.use(express.json());
 *   core.anuncios.montarRutas(anuncios);
 *   gateway.use("/anuncios", anuncios);
 *
 *   GET  /               anuncio:leer       { anuncios }
 *   POST /               anuncio:gestionar  { titulo, tipo, … } → 201
 *   PUT  /:anuncioId     anuncio:gestionar  { …cambios, activo? }
 */
export function montarRutasAnuncios(router, { anuncios, autenticar, requierePermiso }) {
  const m = anuncios.manejadores;
  const leer = [autenticar(), requierePermiso("anuncio:leer")];
  const gestionar = [autenticar(), requierePermiso("anuncio:gestionar")];

  router.get("/", ...leer, m.listar);
  router.post("/", ...gestionar, m.crear);
  router.put("/:anuncioId", ...gestionar, m.editar);

  return router;
}
