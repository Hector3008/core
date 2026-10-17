/**
 * Rutas de gestión de clientes. Cada una sale con sus middlewares en orden
 * (autenticar → requierePermiso → handler). El gateway pone `express.json()` antes:
 *
 *   const clientes = express.Router();
 *   clientes.use(express.json());
 *   core.clientes.montarRutas(clientes);
 *   gateway.use("/clientes", clientes);
 *
 * Búsqueda: GET /?q=texto (nombre, teléfono, correo o @usuario de una red), &inactivos=1, &limite=, &saltar=
 *
 * Cuenta y puntos del cliente (arquitectura 5.25), si el núcleo trae esos servicios:
 *   POST /:clienteId/cuenta           cliente:cuenta          { password? | generarPassword: true } → contraseña temporal (una vez)
 *   POST /:clienteId/cuenta/password  cliente:cuenta          restablece la contraseña (se le olvidó)
 *   GET  /:clienteId/puntos           cliente:leer            saldo y últimos movimientos
 *   POST /:clienteId/puntos/canjear   fidelizacion:canjear    { puntos, detalle? }
 *
 * Beneficios y vales (arquitectura 5.30):
 *   GET  /beneficios                  fidelizacion:canjear    { beneficios }
 *   POST /beneficios                  fidelizacion:gestionar  { nombre, puntos, tipo, valor?, itemCodigo?, descripcion?, vigenciaDias? }
 *   PUT  /beneficios/:beneficioId     fidelizacion:gestionar  { …cambios, activo? }
 *   GET  /retos                       fidelizacion:canjear    { retos } (5.31: prueba toda una categoría y gana un vale)
 *   POST /retos                       fidelizacion:gestionar  { nombre, categoria, tipo, valor?, itemCodigo?, descripcion?, vigenciaDias? }
 *   PUT  /retos/:retoId               fidelizacion:gestionar  { …cambios, activo? }
 *   GET  /fidelizacion/config         fidelizacion:canjear    { habilitada, puntosPorUnidad }
 *   PUT  /fidelizacion/config         fidelizacion:gestionar  { habilitada?, puntosPorUnidad? }
 *   GET  /tickets/:codigo             fidelizacion:canjear    el vale, su beneficio y su cliente
 *   POST /:clienteId/tickets          fidelizacion:canjear    { beneficioId } → emite el vale por el cliente
 */
export function montarRutasClientes(router, { clientes, autenticar, requierePermiso, cuentasCliente, fidelizacion }) {
  const m = clientes.manejadores;
  const leer = [autenticar(), requierePermiso("cliente:leer")];
  const crear = [autenticar(), requierePermiso("cliente:crear")];
  const editar = [autenticar(), requierePermiso("cliente:editar")];
  const gestionar = [autenticar(), requierePermiso("cliente:gestionar")];

  // Beneficios y vales (5.30): van antes de `/:clienteId` para que «beneficios», «tickets» y «fidelizacion» no se tomen por un id.
  if (fidelizacion) {
    const canjear = [autenticar(), requierePermiso("fidelizacion:canjear")];
    const gestionarPuntos = [autenticar(), requierePermiso("fidelizacion:gestionar")];
    const f = fidelizacion.manejadores;
    router.get("/beneficios", ...canjear, f.beneficios);
    router.post("/beneficios", ...gestionarPuntos, f.crearBeneficio);
    router.put("/beneficios/:beneficioId", ...gestionarPuntos, f.editarBeneficio);
    router.get("/retos", ...canjear, f.retos);
    router.post("/retos", ...gestionarPuntos, f.crearReto);
    router.put("/retos/:retoId", ...gestionarPuntos, f.editarReto);
    router.get("/fidelizacion/config", ...canjear, f.config);
    router.put("/fidelizacion/config", ...gestionarPuntos, f.guardarConfig);
    router.get("/tickets/:codigo", ...canjear, f.ticket);
  }

  router.get("/", ...leer, m.listar);
  router.post("/", ...crear, m.crear);
  router.get("/:clienteId", ...leer, m.obtener);
  router.put("/:clienteId", ...editar, m.actualizar);
  router.put("/:clienteId/consentimientos/:finalidad", ...gestionar, m.consentimiento);
  router.post("/:clienteId/desactivar", ...gestionar, m.desactivar);
  router.post("/:clienteId/reactivar", ...gestionar, m.reactivar);
  router.post("/:clienteId/anonimizar", ...gestionar, m.anonimizar);

  if (cuentasCliente) {
    const cuenta = [autenticar(), requierePermiso("cliente:cuenta")];
    router.post("/:clienteId/cuenta", ...cuenta, cuentasCliente.manejadoresPersonal.crearCuenta);
    router.post("/:clienteId/cuenta/password", ...cuenta, cuentasCliente.manejadoresPersonal.restablecerPassword);
  }
  if (fidelizacion) {
    router.get("/:clienteId/puntos", ...leer, fidelizacion.manejadores.puntos);
    router.post("/:clienteId/puntos/canjear", autenticar(), requierePermiso("fidelizacion:canjear"), fidelizacion.manejadores.canjear);
    router.post("/:clienteId/tickets", autenticar(), requierePermiso("fidelizacion:canjear"), fidelizacion.manejadores.emitirTicket);
  }

  return router;
}
