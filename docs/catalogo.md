# Catálogo (`core.catalogo`)

Qué resuelve: llevar la lista de lo que una empresa vende o sirve (platos y bebidas en un restaurante, repuestos en siscore) con su código, nombre, categoría y precio; buscarla; corregirla; darla de baja sin perder la historia; cargarla en bloque desde una hoja de cálculo; y entregarles a los servicios, al armar un documento, la copia de los datos que quedará en él.

El núcleo **no sabe nada de restaurante ni de siscore**: guarda lo común y deja un bloque de `atributos` que cada servicio declara. El catálogo es **uno por empresa**, aunque la empresa tenga contratados varios servicios.

## El ítem

| Campo | Notas |
|---|---|
| `codigo` | Obligatorio. 1 a 40 caracteres: letras, números, punto, guion, guion bajo y barra. Se guarda como se escribió, pero identifica al ítem **sin distinguir mayúsculas** (`zm-1` y `ZM-1` son el mismo). Único por empresa. **No se puede cambiar** después de crearlo. |
| `nombre` | Obligatorio (máximo 200). Es la descripción del ítem: lo que se ve en la carta, la proforma o la etiqueta. No hay un campo `descripcion` aparte. |
| `categoria` | Opcional (máximo 60), texto libre. |
| `precio` | Opcional. Un número de 0 en adelante con **2 decimales como máximo**. Más decimales se rechazan en vez de redondear en silencio. `null` es «sin precio». |
| `atributos` | Opcional. Bloque flexible de cada servicio (ver más abajo). Hasta 4 KB. |
| `activo` | Estado. Un ítem nunca se borra: se desactiva. |

### Código: por qué no distingue mayúsculas

Si el código distinguiera mayúsculas, `zm-1` y `ZM-1` serían dos ítems y alguien acabaría vendiendo el equivocado. Internamente se guarda además `codigoClave` (el código en minúsculas) con el índice único. `obtener({ codigo: "zm-1" })` y la búsqueda por código funcionan con cualquier mayúscula.

### Precio y moneda

La moneda es **de la empresa**, no del ítem: `Empresa.moneda` (código ISO de 3 letras, `PEN` por defecto). Se fija con `core.empresas.crearEmpresa({ ..., moneda })` y se cambia con `core.empresas.fijarMoneda` (no convierte nada: úsalo antes de cargar precios). Las empresas anteriores al campo asumen `PEN`. `core.catalogo.moneda({ empresaId })` la devuelve.

## Atributos y esquemas

Lo propio de cada servicio va en `atributos`: `PROVEEDOR`, `MARCA`, `UBICACION` en repuestos; modificadores en platos. El núcleo cuida que sean **datos estructurados**: números como números, listas como listas.

Cada servicio declara al arrancar los campos que conoce:

```js
core.catalogo.registrarEsquema({
  campos: { MARCA: "texto", STOCK_MINIMO: "numero", EQUIVALENTES: "lista" },
});
```

Tipos: `texto`, `numero`, `booleano`, `lista`. Un campo declarado se valida por tipo (`STOCK_MINIMO: "4"` se rechaza). Un campo no declarado se acepta con las mismas reglas de seguridad. Registrar lo mismo dos veces no hace nada; declarar otro tipo para un campo ya declarado falla (`ESQUEMA_INVALIDO`).

**La obligatoriedad no se declara aquí.** Una empresa tiene un solo catálogo y varios servicios: lo que es obligatorio para uno no lo es para otro, así que cada servicio exige lo suyo al armar sus documentos.

Reglas de los atributos: un objeto simple; claves sin `$` ni punto; hasta 6 niveles de anidación; textos de hasta 500 caracteres; solo texto, números, booleanos, listas y objetos simples; hasta 4 KB en total (se mide sobre el resultado final, no sobre el cambio).

## Líneas libres: montar lo que aún no está en el catálogo

En siscore una proforma puede cargarse con elementos del catálogo, pero también con elementos que **todavía no se han subido** y que deben poder montarse sin agregarlos al catálogo. Para eso existe la **línea libre**:

```js
const lineas = await core.catalogo.instantanea({
  empresaId,
  items: [
    { codigo: "ZM-9600025", cantidad: 2 },                       // del catálogo
    { libre: { nombre: "Empaquetadura nueva", precio: 12.5,      // libre
               atributos: { MARCA: "Victor" } }, cantidad: 1 },
  ],
});
```

- Una línea libre admite los campos de un ítem: `nombre` (obligatorio), `codigo`, `precio`, `categoria` y `atributos` (todos opcionales). Cualquier otro campo se rechaza, para cazar errores de escritura.
- **No se guarda en el catálogo.** Queda solo en el `snapshot` del documento, marcada con `origen: "libre"` e `itemId: null`. Los ítems del catálogo salen con `origen: "catalogo"` y su `itemId`. Así, después, se puede listar qué líneas libres se vendieron para subirlas al catálogo.
- Si trae `codigo`, **no puede ser el de un ítem del catálogo** (activo o no): falla con `CODIGO_EN_CATALOGO` (409) y la lista de códigos. Si ya existe, se usa el del catálogo. Dos líneas libres sí pueden compartir un código provisional.
- Sus atributos se validan por tipo con el esquema, sin exigir ninguno.

## `instantanea`: lo que se copia al documento

`instantanea({ empresaId, items, campos? })` devuelve **una entrada por elemento, en el mismo orden**. Cada elemento es un código (`"ZM-1"`), `{ codigo }` o `{ libre: {...} }`; los demás campos del elemento (cantidad, notas) los ignora: son del servicio, que une el resultado con sus líneas por posición. Hasta 500 elementos.

Cada entrada trae `origen`, `itemId`, `codigo` (el guardado en el catálogo, aunque se pidiera con otras mayúsculas) y, por defecto, `nombre`, `precio`, `categoria` y `atributos`; `campos` elige cuáles de esos cuatro se copian.

Si algún código del catálogo **no existe o está desactivado**, falla todo con `ITEM_NO_DISPONIBLE` (409) y la lista (`noEncontrados`, `inactivos`): un documento no se arma a medias. Lo copiado es independiente del catálogo: cambiar un precio después no cambia el documento ya hecho (arquitectura 5.3).

No tiene ruta HTTP: la usan los servicios desde el código.

## Permisos

| Permiso | Para qué |
|---|---|
| `catalogo:leer` | Ver y buscar (lo piden las rutas). Las plantillas de mesero, almacén y vendedor ya lo traen. |
| `catalogo:crear` | Dar de alta un ítem. |
| `catalogo:editar` | Corregir nombre, categoría, precio y atributos. |
| `catalogo:gestionar` | Baja, reactivar e importar en bloque. |

`catalogo:*` los incluye todos. No se agregó ningún rol a las plantillas: cada empresa crea el suyo (por ejemplo «encargado de carta») con `core.empleados.crearRol`. Como en empleados y clientes, cada operación que cambia algo recibe `actor = { usuarioId, permisos }` y comprueba su permiso, así que protege aunque una ruta se monte sin `requierePermiso`.

## Operaciones

`crear`, `obtener` (por `itemId` o por `codigo`), `actualizar`, `listar` (con `texto` y `categoria` opcionales), `buscar`, `categorias`, `desactivar`, `reactivar`, `instantanea`, `importar`, `registrarEsquema`, `esquemas`, `moneda`, `manejadores`, `montarRutas(router)` y `listo()`. Errores: `ErrorCatalogo` con `codigo` y `status`:

`DATOS_INVALIDOS` 400 · `ESQUEMA_INVALIDO` 400 · `IMPORTACION_INVALIDA` 400 (trae `total` y `errores`) · `PERMISO_INSUFICIENTE` 403 · `NO_ENCONTRADO` 404 · `ITEM_DUPLICADO` 409 (trae `campo` e `itemId` del existente) · `ESTADO_INVALIDO` 409 · `ITEM_NO_DISPONIBLE` 409 · `CODIGO_EN_CATALOGO` 409.

- **Actualizar:** `undefined` no toca el campo; `null` quita la categoría y el precio; el nombre no se puede quitar. `atributos` se combina clave por clave (un valor `null` quita esa clave; `atributos: null` los quita todos). El código no se puede cambiar: los documentos y eventos ya lo mencionan.
- **Buscar** (`GET /catalogo?q=`): por el **comienzo del código** (sin distinguir mayúsculas) o por **parte del nombre**. `&categoria=` filtra por categoría exacta. Máximo 200 por llamada, ordenado por nombre.
- **Categorías:** `categorias()` devuelve las que están en uso (solo de ítems activos) con su cantidad. Sirve para armar filtros; no hay una colección de categorías.
- **Baja:** nunca se borra un ítem. Desactivado deja de listarse (salvo `incluirInactivos`) y de poder usarse en `instantanea`, pero sigue consultable.

## Importar en bloque

`importar({ empresaId, actor, filas, simular? })` crea los ítems nuevos y actualiza los existentes buscándolos por código. Es lo que usará la integración con Google Sheets sin tocar el núcleo. Hasta 500 filas por llamada, cada una `{ codigo, nombre, categoria?, precio?, atributos? }`.

- **Fila nueva:** exige código y nombre. **Fila existente:** solo cambia lo que trae (como `actualizar`); lo que no viene no se pisa.
- **Todo o nada en la validación:** se valida todo antes de escribir. Si una fila es inválida (o un código se repite en el lote), no se guarda ninguna y el error `IMPORTACION_INVALIDA` lista las filas con su problema, numeradas desde 1 (hasta 50).
- **`simular: true`** valida y cuenta sin escribir.
- **No reactiva** los ítems desactivados: los actualiza y los lista en `inactivos`.
- **Resultado:** `{ creados, actualizados, inactivos, simulado, omitidos }`. `omitidos` son códigos que otra persona creó entre la validación y la escritura: no se pisan.
- **Límite conocido:** las escrituras no son una transacción. Si la base de datos fallara a mitad, repetir la importación es seguro: el resultado es el mismo.

## Rutas (`core.catalogo.montarRutas(router)`, montadas en `/catalogo`)

- `catalogo:leer`: `GET /` (`?q=`, `&categoria=`, `&inactivos=1`, `&limite=`, `&saltar=`), `GET /categorias`, `GET /codigo/:codigo`, `GET /:itemId`.
- `catalogo:crear`: `POST /`.
- `catalogo:editar`: `PUT /:itemId`.
- `catalogo:gestionar`: `POST /importar` (`{ filas, simular? }`), `POST /:itemId/desactivar`, `POST /:itemId/reactivar`.

Todas llevan `autenticar → requierePermiso → handler`; las que escriben exigen `x-requested-with`. Las rutas fijas (`/categorias`, `/codigo/:codigo`, `/importar`) se registran antes que `/:itemId`.

## Montaje en el gateway

```js
const catalogo = express.Router();
catalogo.use(express.json({ limit: "1mb" })); // una importación admite hasta 500 filas
core.catalogo.montarRutas(catalogo);
gateway.use("/catalogo", catalogo);
```

Y en `db.js`, junto a los otros `listo()`: `await core.catalogo.listo();` (crea el índice único del código, del que depende la detección de duplicados).

## Pruebas

- `catalogo-validacion.test.js` (30) y `catalogo-logica.test.js` (55): sin base de datos. La segunda corre el servicio contra un almacén falso en memoria.
- `catalogo.test.js`: requiere MongoDB real (`MONGODB_URI`). Cubre lo que depende de MongoDB de verdad: el índice único sin distinguir mayúsculas, creaciones simultáneas del mismo código, el upsert de la importación, el `aggregate` de categorías con la empresa activa y el aislamiento entre empresas. En FerretDB no es fiable (arquitectura 5.9).
- `humo-catalogo.mjs` (en `test/` del gateway): recorre las rutas por HTTP real contra el gateway en marcha.
