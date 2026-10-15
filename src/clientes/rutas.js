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
 */
export function montarRutasClientes(router, { clientes, autenticar, requierePermiso, cuentasCliente, fidelizacion }) {
  const m = clientes.manejadores;
  const leer = [autenticar(), requierePermiso("cliente:leer")];
  const crear = [autenticar(), requierePermiso("cliente:crear")];
  const editar = [autenticar(), requierePermiso("cliente:editar")];
  const gestionar = [autenticar(), requierePermiso("cliente:gestionar")];

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
  }

  return router;
}
