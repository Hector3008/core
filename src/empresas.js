import { conEmpresa } from "./tenancy.js";
import { plantillasPara } from "./modelos/plantillas.js";
import { hashPassword } from "./password.js";
import { normalizarPais, PAIS_POR_DEFECTO } from "./telefono.js";
import { normalizarMoneda, MONEDA_POR_DEFECTO } from "./moneda.js";
import { zonaValida } from "./zona.js";

export function crearServicioEmpresas({ Empresa, Usuario, Rol, Membresia }) {
  return {
    // Crea la empresa y copia las plantillas de rol de sus servicios
    async crearEmpresa({ nombre, slug, servicios = [], pais = PAIS_POR_DEFECTO, moneda = MONEDA_POR_DEFECTO }) {
      const empresa = await Empresa.create({
        nombre,
        slug,
        pais: normalizarPais(pais),
        moneda: normalizarMoneda(moneda),
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

    // Cambia la moneda de la empresa. No convierte nada: los precios del catálogo y los de los documentos
    // ya creados quedan como están, solo cambia la moneda con que se leen. Úsalo antes de cargar precios.
    async fijarMoneda({ empresaId, moneda }) {
      const r = await Empresa.updateOne({ _id: empresaId }, { moneda: normalizarMoneda(moneda) });
      if (!r.matchedCount) throw new Error("empresa no encontrada");
      return { ok: true };
    },

    // Fija la zona horaria de la empresa (un nombre IANA como America/Lima) o la quita (null: vuelve a la de su país).
    // Es la hora con la que se leen los días y horarios de las promociones.
    async fijarZonaHoraria({ empresaId, zonaHoraria }) {
      if (zonaHoraria !== null && !zonaValida(zonaHoraria))
        throw new Error("zona horaria inválida (un nombre como America/Lima)");
      const r = await Empresa.updateOne({ _id: empresaId }, { zonaHoraria: zonaHoraria === null ? null : zonaHoraria.trim() });
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
