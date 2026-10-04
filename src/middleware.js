import { conEmpresa } from "./tenancy.js";
import { permite } from "./permisos.js";

// Espera req.auth = { usuarioId, empresaId } (lo deja quien autentique)
export function crearMiddlewarePermisos({ Membresia, Rol }) {
  return (requerido) => async (req, res, next) => {
    const { usuarioId, empresaId } = req.auth ?? {};
    if (!usuarioId || !empresaId)
      return res.status(401).json({ error: "no autenticado" });

    let resultado;
    try {
      resultado = await conEmpresa(empresaId, async () => {
        const m = await Membresia.findOne({ usuarioId, activa: true });
        if (!m) return { codigo: 403, error: "sin acceso a esta empresa" };
        const rol = await Rol.findById(m.rolId).lean();
        if (!rol || !permite(rol.permisos, requerido))
          return { codigo: 403, error: "permiso insuficiente" };
        return { membresia: m, rol };
      });
    } catch (e) {
      return next(e);
    }

    if (resultado.error)
      return res.status(resultado.codigo).json({ error: resultado.error });
    req.membresia = resultado.membresia;
    req.rol = resultado.rol;
    conEmpresa(empresaId, next); // el resto de la request queda dentro de la empresa
  };
}
