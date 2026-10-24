# Anuncios (5.48)

Eventos y publicidad que un restaurante muestra en su carta pública («esta noche, jazz en vivo»). Módulo `src/anuncios/`.

## Dos tipos

| tipo | datos propios | cuándo sale en la carta |
|---|---|---|
| `evento` | `fecha` (AAAA-MM-DD), `hora` (HH:MM), `lugar` (opcional, hasta 80) | hasta que pasa su día (el día del evento todavía sale), el más próximo primero |
| `publicidad` | `vigencia` `{ desde?, hasta? }` (opcional) | dentro de su vigencia; sin fechas, siempre. La más reciente primero |

Comunes: `titulo` (hasta 80), `descripcion` (hasta 300, opcional), `imagen` (URL https sin credenciales, hasta 500, opcional; no hay subida de archivos), `activo`.

- El tipo no se cambia al editar (se crea otro anuncio). Un campo de otro tipo se rechaza.
- Nunca se borran: se pausan (`activo: false`). Hasta **50 activos** por empresa.
- «Hoy» se lee en la hora de la empresa (`zonaDeEmpresa`), no en la del servidor.

## API

```
core.anuncios.listar({ empresaId, actor })            anuncio:leer (o gestionar)  → todos, también pausados y vencidos
core.anuncios.crear({ empresaId, actor, ...datos })   anuncio:gestionar
core.anuncios.editar({ empresaId, actor, anuncioId, ...cambios })   anuncio:gestionar
core.anuncios.vigentes({ empresaId, ahora? })         sin actor (lectura pública) → { zona, hoy, eventos, publicidad }
```

`vigentes` solo devuelve `id, tipo, titulo, descripcion, imagen, fecha, hora, lugar, vigencia`.

Rutas (`core.anuncios.montarRutas(router)`): `GET /` (`anuncio:leer`), `POST /` y `PUT /:anuncioId` (`anuncio:gestionar`, con CSRF).
Errores: `ErrorAnuncio` — `DATOS_INVALIDOS` 400, `PERMISO_INSUFICIENTE` 403, `NO_ENCONTRADO` 404, `LIMITE_ALCANZADO` 409.
