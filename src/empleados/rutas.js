/**
 * Rutas de gestión de empleados y roles. Cada una sale con sus middlewares en orden
 * (autenticar → requierePermiso → handler). El gateway pone `express.json()` antes:
 *
 *   const empleados = express.Router();
 *   empleados.use(express.json());
 *   core.empleados.montarRutas(empleados);
 *   app.use("/empleados", empleados);
 *
 * Las de /roles van antes que /:usuarioId para que "roles" no se tome por un id.
 */
export function montarRutasEmpleados(router, { empleados, autenticar, requierePermiso }) {
  const m = empleados.manejadores;
  const personas = [autenticar(), requierePermiso("usuario:gestionar")];
  const roles = [autenticar(), requierePermiso("rol:gestionar")];

  router.get("/roles", ...roles, m.listarRoles);
  router.post("/roles", ...roles, m.crearRol);
  router.put("/roles/:rolId", ...roles, m.editarRol);
  router.delete("/roles/:rolId", ...roles, m.eliminarRol);

  router.get("/", ...personas, m.listar);
  router.post("/", ...personas, m.crear);
  router.get("/:usuarioId", ...personas, m.obtener);
  router.put("/:usuarioId", ...personas, m.actualizar);
  router.put("/:usuarioId/rol", ...personas, m.cambiarRol);
  router.post("/:usuarioId/desactivar", ...personas, m.desactivar);
  router.post("/:usuarioId/reactivar", ...personas, m.reactivar);
  router.post("/:usuarioId/password", ...personas, m.restablecerPassword);
  router.put("/:usuarioId/pin", ...personas, m.establecerPin);
  router.delete("/:usuarioId/pin", ...personas, m.quitarPin);

  return router;
}
