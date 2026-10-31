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
  // Entrar con Google (5.69): `GET /google/config` dice si está activado (y con qué Client ID); `POST /google` abre la sesión
  router.get("/google/config", m.googleConfig);
  router.post("/google", m.google);
  router.post("/logout", m.logout);
  router.get("/yo", m.yo);
  router.post("/empresa", m.empresa);
  // Cambiar mi contraseña (también con una contraseña temporal pendiente: ahí está el sentido)
  router.post("/password", m.cambiarPassword);
  // Preferencias de la persona (hoy: paginaPrincipal, el id del destino que se abre al entrar)
  router.put("/preferencias", m.preferencias);

  // Mi propio PIN (hace falta estar autenticado en una empresa)
  router.put("/pin", autenticar(), m.cambiarMiPin);

  // Administración (cada una pide su permiso)
  router.get("/seguridad", ...con("empresa:seguridad"), m.leerSeguridad);
  router.put("/seguridad", ...con("empresa:seguridad"), m.guardarSeguridad);
  // Marca de la empresa (5.33): logo, eslogan y colores de la carta pública
  router.get("/marca", ...con("empresa:marca"), m.leerMarca);
  router.put("/marca", ...con("empresa:marca"), m.guardarMarca);
  // Datos de la empresa para sus comprobantes (5.34): razón social, RUC, dirección, teléfono y pie
  router.get("/datos-empresa", ...con("empresa:datos"), m.leerDatos);
  router.put("/datos-empresa", ...con("empresa:datos"), m.guardarDatos);
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
