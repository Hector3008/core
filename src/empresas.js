import { conEmpresa } from "./tenancy.js";
import { plantillasPara } from "./modelos/plantillas.js";
import { hashPassword } from "./password.js";
import { normalizarPais, PAIS_POR_DEFECTO } from "./telefono.js";

export function crearServicioEmpresas({ Empresa, Usuario, Rol, Membresia }) {
  return {
    // Crea la empresa y copia las plantillas de rol de sus servicios
    async crearEmpresa({ nombre, slug, servicios = [], pais = PAIS_POR_DEFECTO }) {
      const empresa = await Empresa.create({
        nombre,
        slug,
        pais: normalizarPais(pais),
        servicios: servicios.map((codigo) => ({ codigo })),
      });
      const plantillas = plantillasPara(servicios);
      await conEmpresa(empresa._id, () =>
        Rol.insertMany(
          Object.entries(plantillas).map(([n, permisos]) => ({
            nombre: n,
            permisos,
          })),
        ),
      );
      return empresa;
    },

    // Cambia el país de la empresa. Solo afecta a los teléfonos que se escriban sin código de país
    // de ahí en adelante: los ya guardados están en formato internacional y no cambian.
    async fijarPais({ empresaId, pais }) {
      const r = await Empresa.updateOne({ _id: empresaId }, { pais: normalizarPais(pais) });
      if (!r.matchedCount) throw new Error("empresa no encontrada");
      return { ok: true };
    },

    async crearUsuario({ correo, password, nombre }) {
      return Usuario.create({
        correo,
        nombre,
        passwordHash: await hashPassword(password),
      });
    },

    // Un usuario, una empresa, un rol
    async agregarMiembro({ empresaId, usuarioId, rol }) {
      return conEmpresa(empresaId, async () => {
        const r = await Rol.findOne({ nombre: rol });
        if (!r) throw new Error(`Rol inexistente en esta empresa: ${rol}`);
        return Membresia.create({ usuarioId, rolId: r._id });
      });
    },
  };
}
