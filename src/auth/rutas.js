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
export function montarRutas(router, { auth, autenticar, requierePermiso, empleados }) {
  const m = auth.manejadores;
  const con = (permiso) => [autenticar(), requierePermiso(permiso)];

  // Sesión con contraseña
  router.post("/login", m.login);
  router.post("/logout", m.logout);
  router.get("/yo", m.yo);
  router.post("/empresa", m.empresa);
  // Cambiar mi contraseña (también con una contraseña temporal pendiente: ahí está el sentido)
  router.post("/password", m.cambiarPassword);

  // Mi propio PIN (hace falta estar autenticado en una empresa)
  router.put("/pin", autenticar(), m.cambiarMiPin);

  // Administración (cada una pide su permiso)
  router.get("/seguridad", ...con("empresa:seguridad"), m.leerSeguridad);
  router.put("/seguridad", ...con("empresa:seguridad"), m.guardarSeguridad);
  router.post("/dispositivos/codigo", ...con("dispositivo:gestionar"), m.crearCodigo);
  router.get("/dispositivos", ...con("dispositivo:gestionar"), m.listarDispositivos);
  router.delete("/dispositivos/:id", ...con("dispositivo:gestionar"), m.revocarDispositivo);
  router.get("/usuarios", ...con("usuario:gestionar"), m.listarUsuarios);
  // Con la gestión de empleados, el PIN de otra persona pasa por la regla de alcance: un encargado
  // no puede ponerle PIN a un admin (y entrar como él en la tablet).
  router.put("/usuarios/:usuarioId/pin", ...con("usuario:gestionar"), empleados?.manejadores.establecerPin ?? m.establecerPin);
  router.delete("/usuarios/:usuarioId/pin", ...con("usuario:gestionar"), empleados?.manejadores.quitarPin ?? m.quitarPin);

  // La tablet (no hay sesión de persona: solo la cookie del dispositivo)
  router.post("/dispositivo/emparejar", m.emparejar);
  router.get("/dispositivo/personas", m.personas);
  router.post("/dispositivo/entrar", m.entrar);

  return router;
}
