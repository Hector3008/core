import { empresaSchema } from "./empresa.js";
import { usuarioSchema } from "./usuario.js";
import { rolSchema } from "./rol.js";
import { membresiaSchema } from "./membresia.js";

// core.model(nombre, schema, coleccion?) ya existe en la pieza 1
export function registrarModelos(core) {
  return {
    Empresa: core.model("Empresa", empresaSchema, "empresas"),
    Usuario: core.model("Usuario", usuarioSchema, "usuarios"),
    Rol: core.model("Rol", rolSchema, "roles"),
    Membresia: core.model("Membresia", membresiaSchema, "membresias"),
  };
}
