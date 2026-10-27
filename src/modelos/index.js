import { empresaSchema } from "./empresa.js";
import { usuarioSchema } from "./usuario.js";
import { rolSchema } from "./rol.js";
import { membresiaSchema } from "./membresia.js";
import {
  documentoSchema,
  documentoVersionSchema,
  contadorSchema,
} from "../documentos/modelos.js";
import { eventoSchema } from "../eventos/modelo.js";
import { sesionSchema } from "../auth/modelo.js";
import { dispositivoSchema, codigoSchema } from "../auth/modelos-pin.js";
import { clienteSchema } from "../clientes/modelo.js";
import { itemSchema } from "../catalogo/modelo.js";
import { sesionClienteSchema } from "../cuentas/modelo.js";
import { movimientoPuntosSchema, beneficioSchema, ticketSchema, retoSchema } from "../fidelizacion/modelo.js";
import { promocionSchema } from "../promociones/modelo.js";
import { anuncioSchema } from "../anuncios/modelo.js";
import { resenaSchema } from "../resenas/modelo.js";
import { referidoSchema } from "../referidos/modelo.js";

// core.model(nombre, schema, coleccion?) ya existe en la pieza 1
export function registrarModelos(core) {
  return {
    Empresa: core.model("Empresa", empresaSchema, "empresas"),
    Usuario: core.model("Usuario", usuarioSchema, "usuarios"),
    Rol: core.model("Rol", rolSchema, "roles"),
    Membresia: core.model("Membresia", membresiaSchema, "membresias"),
    Documento: core.model("Documento", documentoSchema, "documentos"),
    DocumentoVersion: core.model(
      "DocumentoVersion",
      documentoVersionSchema,
      "documento_versiones",
    ),
    Contador: core.model("Contador", contadorSchema, "contadores"),
    Evento: core.model("Evento", eventoSchema, "eventos"),
    Sesion: core.model("Sesion", sesionSchema, "sesiones"),
    Dispositivo: core.model("Dispositivo", dispositivoSchema, "dispositivos"),
    CodigoEmparejamiento: core.model("CodigoEmparejamiento", codigoSchema, "codigos_emparejamiento"),
    Cliente: core.model("Cliente", clienteSchema, "clientes"),
    Item: core.model("Item", itemSchema, "catalogo_items"),
    SesionCliente: core.model("SesionCliente", sesionClienteSchema, "sesiones_cliente"),
    MovimientoPuntos: core.model("MovimientoPuntos", movimientoPuntosSchema, "puntos_movimientos"),
    Beneficio: core.model("Beneficio", beneficioSchema, "beneficios"),
    Ticket: core.model("Ticket", ticketSchema, "tickets"),
    Reto: core.model("Reto", retoSchema, "retos"),
    Promocion: core.model("Promocion", promocionSchema, "promociones"),
    Anuncio: core.model("Anuncio", anuncioSchema, "anuncios"),
    Resena: core.model("Resena", resenaSchema, "resenas"),
    Referido: core.model("Referido", referidoSchema, "referidos"),
  };
}
