import { conEmpresa } from "./tenancy.js";
import { plantillasPara } from "./modelos/plantillas.js";
import { hashPassword } from "./password.js";

export function crearServicioEmpresas({ Empresa, Usuario, Rol, Membresia }) {
  return {
    // Crea la empresa y copia las plantillas de rol de sus servicios
    async crearEmpresa({ nombre, slug, servicios = [] }) {
      const empresa = await Empresa.create({
        nombre,
        slug,
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
