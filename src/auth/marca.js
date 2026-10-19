import { ErrorAuth } from "./errores.js";
import { CAMPOS_MARCA, marcaDe, marcaPublica, validarMarca } from "../marca.js";

// Marca de la empresa (5.33): leerla y cambiarla desde la administración. La validación y la paleta
// viven en ../marca.js; aquí solo se guarda y se responde. Va junto a la seguridad de la empresa
// porque comparte sus rutas (`/auth`) y, por tanto, no obliga al gateway a montar nada nuevo.

export function crearServicioMarca({ Empresa }, { responderError, exigirCsrf }) {
  async function empresaOrError(empresaId) {
    const e = await Empresa.findById(empresaId).lean();
    if (!e || e.activa === false) throw new ErrorAuth("NO_ENCONTRADO", "empresa no encontrada");
    return e;
  }

  const respuesta = (empresa) => ({ marca: marcaDe(empresa), vista: marcaPublica(empresa) });

  /** `marca`: lo que se guardó (cada campo o null); `vista`: lo que ve el público, con la paleta ya calculada. */
  async function leerMarca({ empresaId }) {
    return respuesta(await empresaOrError(empresaId));
  }

  async function guardarMarca({ empresaId, cambios }) {
    const empresa = await empresaOrError(empresaId);
    const nueva = validarMarca(cambios, marcaDe(empresa));
    const set = {};
    const unset = {};
    for (const c of CAMPOS_MARCA) (nueva[c] === null ? unset : set)[`marca.${c}`] = nueva[c] === null ? "" : nueva[c];
    await Empresa.updateOne({ _id: empresaId }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    return leerMarca({ empresaId });
  }

  const envolver = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (e) {
      responderError(res, e, next);
    }
  };

  return {
    api: { leerMarca, guardarMarca },
    manejadores: {
      leerMarca: envolver(async (req, res) => res.status(200).json(await leerMarca({ empresaId: req.auth.empresaId }))),
      guardarMarca: envolver(async (req, res) => {
        exigirCsrf(req);
        res.status(200).json(await guardarMarca({ empresaId: req.auth.empresaId, cambios: req.body }));
      }),
    },
  };
}
