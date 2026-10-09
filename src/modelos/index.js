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
  };
}
