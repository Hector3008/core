import { ErrorAuth } from "./errores.js";
import { CAMPOS_DATOS, datosDe, emisorDe, validarDatos } from "../datos-empresa.js";

// Datos de la empresa para sus comprobantes (5.34): leerlos y cambiarlos desde la administración.
// Mismo patrón que la marca (./marca.js): rutas en `/auth`, sin obligar al gateway a montar nada nuevo.

export function crearServicioDatos({ Empresa }, { responderError, exigirCsrf }) {
  async function empresaOrError(empresaId) {
    const e = await Empresa.findById(empresaId).lean();
    if (!e || e.activa === false) throw new ErrorAuth("NO_ENCONTRADO", "empresa no encontrada");
    return e;
  }

  const respuesta = (empresa) => ({ datos: datosDe(empresa), vista: emisorDe(empresa) });

  /** `datos`: lo guardado (cada campo o null); `vista`: cómo se imprime en un recibo (con el nombre y el logo). */
  async function leerDatos({ empresaId }) {
    return respuesta(await empresaOrError(empresaId));
  }

  async function guardarDatos({ empresaId, cambios }) {
    const empresa = await empresaOrError(empresaId);
    const nuevos = validarDatos(cambios, datosDe(empresa));
    const set = {};
    const unset = {};
    for (const c of CAMPOS_DATOS) (nuevos[c] === null ? unset : set)[`datos.${c}`] = nuevos[c] === null ? "" : nuevos[c];
    await Empresa.updateOne({ _id: empresaId }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    return leerDatos({ empresaId });
  }

  const envolver = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (e) {
      responderError(res, e, next);
    }
  };

  return {
    api: { leerDatos, guardarDatos },
    manejadores: {
      leerDatos: envolver(async (req, res) => res.status(200).json(await leerDatos({ empresaId: req.auth.empresaId }))),
      guardarDatos: envolver(async (req, res) => {
        exigirCsrf(req);
        res.status(200).json(await guardarDatos({ empresaId: req.auth.empresaId, cambios: req.body }));
      }),
    },
  };
}
