# Reseñas de platos (`core.resenas`, 5.62)

Estrellas (1 a 5) y texto (hasta 500 caracteres, opcional) de un cliente con cuenta sobre un plato del catálogo **que ya pagó**. Sin imágenes ni video.

## Reglas
- **Quién opina:** solo quien tiene el plato en un pedido pagado. El núcleo no conoce los pedidos: el servicio que los lleva registra la comprobación con `core.resenas.definirFuenteConsumo(async ({ empresaId, clienteId, itemCodigo }) => boolean)`. Sin esa función nadie puede reseñar (falla cerrado, `ESTADO_INVALIDO`).
- **Una por cliente y plato** (índice único `empresaId + itemClave + clienteId`); enviar de nuevo la edita. El cliente puede borrarla.
- **Se publica al instante.** Un cliente con cuenta puede reportar la de otro (una vez; no la propia). El personal con `resena:gestionar` la **oculta** (nunca se borra) o la vuelve a mostrar (esto limpia sus reportes). Una reseña oculta sigue oculta aunque su autor la edite. Su autor aún la ve marcada como oculta.
- **Autor:** «María P.» (primer nombre + inicial del último apellido), calculado al leer desde la ficha: un nombre editado o una ficha anonimizada («Anónimo») se reflejan solos.
- El código del plato no distingue mayúsculas (igual que el catálogo). Un plato dado de baja no se reseña, y sus reseñas anteriores se siguen mostrando.

## Operaciones
| Operación | Quién | Qué |
|---|---|---|
| `guardarMia({empresaId, clienteId, itemCodigo, estrellas, texto?})` | cliente (id de la sesión) | crea o edita; `NO_PERMITIDO` si no lo pagó |
| `borrarMia({empresaId, clienteId, itemCodigo})` | cliente | borra la suya |
| `reportar({empresaId, clienteId, resenaId})` | cliente | suma un reporte |
| `deItem({empresaId, itemCodigo, clienteId?, limite=20, saltar=0})` | público | `{ total, promedio, resenas: [{id, autor, estrellas, texto, ts, mia}], mia }` (solo visibles; `mia` incluye la propia aunque esté oculta) |
| `listar({empresaId, actor, filtro, limite, saltar})` | `resena:leer` | todas, `reportadas` u `ocultas`; con reportes primero |
| `moderar({empresaId, actor, resenaId, oculta})` | `resena:gestionar` | oculta o muestra |

Las operaciones del cliente no llevan actor: el servicio que las monta debe pasar el `clienteId` de la **sesión**, nunca uno del cuerpo.

## Permisos y rutas (personal)
`resena:leer`, `resena:gestionar` (los cubre `*`). `core.resenas.montarRutas(router)`: `GET /` (`?filtro=todas|reportadas|ocultas&limite=&saltar=`) y `PUT /:resenaId/visibilidad` `{ oculta }` (CSRF).

## Errores (`ErrorResena`)
`DATOS_INVALIDOS` 400, `PERMISO_INSUFICIENTE` 403, `NO_PERMITIDO` 403, `NO_ENCONTRADO` 404, `ESTADO_INVALIDO` 409.

Pruebas: `test/resenas-servicio.test.js` (24, sin base de datos).
