/**
 * Registra todas las rutas de autenticación en un Router de Express.
 * Cada ruta sale ya con sus middlewares en el orden correcto (autenticar → requierePermiso → handler),
 * así el gateway no puede olvidarse de proteger una. El gateway pone `express.json()` antes.
 *
 *   const auth = express.Router();
 *   auth.use(express.json());
 *   core.auth.montarRutas(auth);
 *   app.use("/auth", auth);
 */
export function montarRutas(router, { auth, autenticar, requierePermiso }) {
  const m = auth.manejadores;
  const con = (permiso) => [autenticar(), requierePermiso(permiso)];

  // Sesión con contraseña
  router.post("/login", m.login);
  router.post("/logout", m.logout);
  router.get("/yo", m.yo);
  router.post("/empresa", m.empresa);

  // Mi propio PIN (hace falta estar autenticado en una empresa)
  router.put("/pin", autenticar(), m.cambiarMiPin);

  // Administración (cada una pide su permiso)
  router.get("/seguridad", ...con("empresa:seguridad"), m.leerSeguridad);
  router.put("/seguridad", ...con("empresa:seguridad"), m.guardarSeguridad);
  router.post("/dispositivos/codigo", ...con("dispositivo:gestionar"), m.crearCodigo);
  router.get("/dispositivos", ...con("dispositivo:gestionar"), m.listarDispositivos);
  router.delete("/dispositivos/:id", ...con("dispositivo:gestionar"), m.revocarDispositivo);
  router.get("/usuarios", ...con("usuario:gestionar"), m.listarUsuarios);
  router.put("/usuarios/:usuarioId/pin", ...con("usuario:gestionar"), m.establecerPin);
  router.delete("/usuarios/:usuarioId/pin", ...con("usuario:gestionar"), m.quitarPin);

  // La tablet (no hay sesión de persona: solo la cookie del dispositivo)
  router.post("/dispositivo/emparejar", m.emparejar);
  router.get("/dispositivo/personas", m.personas);
  router.post("/dispositivo/entrar", m.entrar);

  return router;
}
