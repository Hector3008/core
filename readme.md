# core

Núcleo común sobre el que se montan los servicios (restaurante, siscore, etc.). Se escribe una sola vez y cada servicio lo usa como dependencia.

El núcleo **no abre ni cierra conexiones**: usa la conexión de Mongoose que le entrega el gateway.

## Estado

| Pieza | Estado |
|---|---|
| 1. Conexión | Hecha |
| 2. Empresas, usuarios, membresías, roles y permisos | Hecha |
| 3. Motor de documentos | Hecha |
| 4. Eventos | Pendiente |

## Instalación

```bash
npm install github:Hector3008/core
```

`mongoose` es `peerDependency` (`^8.0.0 || ^9.0.0`): lo instala el proyecto que usa el núcleo, para que exista una sola instancia.

## Uso

```js
import mongoose from "mongoose";
import { createCore } from "core";

const connection = await mongoose.createConnection(uri, { dbName: "mi-servidor" }).asPromise();
const core = createCore({ connection });

await core.ping(); // { ok: true, estado: "conectado" }
```

## API

| Miembro | Descripción |
|---|---|
| `createCore({ connection, plugins? })` | Valida que reciba una `Connection` de Mongoose y registra los modelos de la pieza 2. |
| `core.model(nombre, schema, coleccion?)` | Registra un modelo sobre la conexión. Es idempotente. |
| `core.use(plugin)` | Plugin global; se aplica a los modelos registrados después de llamarlo. |
| `core.estado()` | `desconectado`, `conectado`, `conectando` o `desconectando`. |
| `core.ping()` | `{ ok, estado }`; con la conexión abierta hace ping real a MongoDB. |
| `core.modelos` | `Empresa`, `Usuario`, `Rol`, `Membresia`, `Documento`, `DocumentoVersion`, `Contador`. |
| `core.empresas` | `crearEmpresa`, `crearUsuario`, `agregarMiembro`. |
| `core.requierePermiso(permiso)` | Middleware de Express que verifica el permiso del usuario en su empresa. |
| `core.documentos` | Motor de documentos: tipos, estados, versiones, numeración y eventos (ver más abajo). |

También se exportan: `conEmpresa`, `empresaActual`, `tenancyPlugin`, `marcarGlobal`, `permite`, `hashPassword`, `verificarPassword` y `ErrorDocumento`.

## Multiempresa

Toda colección de negocio lleva `empresaId`. El plugin `tenancyPlugin` filtra automáticamente cada consulta por la empresa activa, que se fija con `conEmpresa`:

```js
import { conEmpresa } from "core";

await conEmpresa(empresaId, async () => {
  return await Rol.find(); // solo roles de esa empresa
});
```

- Sin empresa activa, la consulta **lanza error** (en vez de filtrar mal).
- Para tareas de plataforma: `.setOptions({ sinEmpresa: true })`.
- `Empresa` y `Usuario` son globales (`marcarGlobal`) y no llevan `empresaId`.

**Regla importante:** la consulta debe ejecutarse *dentro* de `conEmpresa`, con `await` en una función `async`. Si se devuelve la consulta sin ejecutar, corre fuera del contexto y falla.

```js
conEmpresa(id, () => Modelo.find());              // mal
conEmpresa(id, async () => await Modelo.find());  // bien
```

## Usuarios, roles y permisos

- **Usuario:** identidad global (correo, contraseña con hash `scrypt`). Puede estar en varias empresas.
- **Membresía:** `{ usuarioId, empresaId, rolId, activa }`. Un solo rol por membresía.
- **Rol:** `{ empresaId, nombre, permisos[] }`, por empresa. Al crear una empresa se copian las plantillas de rol de sus servicios (`src/modelos/plantillas.js`).
- **Permisos:** formato `recurso:accion`. `*` es todo, `documento:*` es todo el recurso y `documento:crear` es exacto. Las estaciones son permisos: `estacion:cocina`, `estacion:revision`.

```js
router.post("/pedidos", core.requierePermiso("documento:crear"), crearPedido);
```

El middleware espera `req.auth = { usuarioId, empresaId }`, que debe dejar quien autentique (el login aún no forma parte del núcleo). Responde:

| Código | Motivo |
|---|---|
| 401 | no autenticado |
| 403 | sin acceso a esta empresa (sin membresía o membresía inactiva) |
| 403 | permiso insuficiente |

Si pasa, deja `req.membresia` y `req.rol`, y el resto de la request corre dentro de `conEmpresa`.

## Documentos

El motor no sabe nada de restaurante ni de siscore: aplica las reglas que cada servicio le registra al arrancar. Las reglas viven en memoria (viajan con el código del servicio); los documentos, en MongoDB.

```js
core.documentos.registrarTipo({
  tipo: "proforma",
  prefijo: "DP",                    // códigos DP-0000001, un contador por empresa y tipo
  estadoInicial: "borrador",
  transiciones: {
    borrador:     ["cotizacion", "orden_salida", "descartado"],
    cotizacion:   ["orden_salida", "rechazada", "vencida"],
    orden_salida: ["en_revision"],
    en_revision:  ["cerrada", "orden_salida"],
  },
  permisos: { en_revision: "estacion:revision" }, // permiso para ENTRAR a ese estado
  motivos:  { rechazada: ["precio", "stock", "otro"] }, // exige motivo al entrar
  editables: ["borrador", "cotizacion", "en_revision"], // opcional
});
```

- Los estados se deducen de las transiciones. Un estado sin salidas es **final**.
- `editables` (opcional): estados en los que se puede editar el contenido. Por defecto, todos los no finales.
- Registrar dos veces el mismo tipo con las mismas reglas no hace nada; con reglas distintas, falla. Dos tipos no pueden compartir prefijo.

### Operaciones

Todas corren dentro de la empresa activa (`conEmpresa`; el middleware de permisos ya la fija en cada request). En scripts o tareas programadas hay que envolverlas: `conEmpresa(id, async () => await core.documentos.listar())`.

| Método | Qué hace |
|---|---|
| `crear({ tipo, snapshot?, doc?, usuarioId? })` | Crea el documento en el estado inicial, con número asignado y versión 1. |
| `obtener({ code, version? })` | El documento actual, o la copia de una versión anterior. `null` si no existe. |
| `listar({ tipo?, estado?, limite?, saltar? })` | `estado` puede ser un texto o una lista. Máximo 200 por llamada. |
| `transicionar({ code, a, usuarioId?, permisos?, motivo?, doc?, snapshot?, esperaVersion?, sistema? })` | Cambia de estado. Si llega `doc` o `snapshot`, también edita, en una sola actualización. |
| `nuevaVersion({ code, doc?, snapshot?, usuarioId?, esperaVersion? })` | Edita el contenido sin cambiar de estado. |
| `registrarTipo(def)` · `tipos()` | Declara o lista los tipos. |
| `on(evento, fn)` · `off(evento, fn)` | Escucha `creado`, `estado` o `version`. |
| `listo()` | Espera a que existan los índices únicos (conviene `await` al arrancar). |

```js
await core.documentos.transicionar({
  code: "DP-0000008",
  a: "cerrada",
  usuarioId,
  permisos: req.rol.permisos,        // los deja requierePermiso
  doc: { ...docRevisado },           // opcional: edita y cierra a la vez
  esperaVersion: 2,                  // opcional: falla si alguien lo cambió antes
});
```

### Reglas

- **Versión = contenido.** Solo cambia `payload.doc` o `snapshot`. Un cambio de estado no crea versión: queda en `historial` y como evento. Antes de reemplazar una versión se guarda su copia en `documento_versiones`.
- **Permisos:** si el tipo declara un permiso para el estado destino, `transicionar` lo verifica con `permite(permisos, requerido)`. Sin `permisos`, falla. Las tareas del sistema (por ejemplo, vencer cotizaciones) pasan `sistema: true`, que se salta la comprobación y queda marcado en el historial.
- **Motivos:** si el tipo declara `motivos` para un estado, el motivo (`{ codigo, detalle? }`) es obligatorio y el código debe estar en la lista. El `codigo` es lo que se agrupa en reportes; el `detalle` es texto libre.
- **Concurrencia:** cada actualización se condiciona por `{ code, version, estado }`. Dos usuarios que actúan a la vez sobre el mismo documento no se pisan: uno gana y el otro recibe `CONFLICTO_VERSION`. El estado va en la condición porque una transición de estado no cambia la versión.
- **Numeración:** contador atómico (`$inc` con `upsert`) por empresa y tipo. Un `crear` que falla después de numerar deja un hueco en la numeración.
- Las validaciones corren antes de guardar nada: si fallan, no se crea ninguna versión.

### Errores

Los errores son `ErrorDocumento` con un `codigo`:

| Código | Sugerencia HTTP |
|---|---|
| `DOCUMENTO_NO_ENCONTRADO` | 404 |
| `CONFLICTO_VERSION` | 409 |
| `PERMISO_INSUFICIENTE` | 403 |
| `TRANSICION_INVALIDA`, `MOTIVO_REQUERIDO`, `MOTIVO_INVALIDO`, `ESTADO_NO_EDITABLE`, `TIPO_NO_REGISTRADO` | 400 |

### Eventos

`on("creado" | "estado" | "version", fn)` entrega:

```js
{
  empresaId, usuarioId, documentoCode: "DP-0000008", tipoDocumento: "proforma",
  version: 2, ts: Date,
  datos: { ... }
}
```

| Evento | `datos` |
|---|---|
| `creado` | `{ estado }` |
| `estado` | `{ de, a, motivo, sistema, msEnEstadoAnterior }` |
| `version` | `{ versionAnterior, versionNueva, cambio: { doc, snapshot } }` |

Una operación que edita y cambia de estado emite `version` y luego `estado`. Los eventos se emiten después de guardar; si un escucha falla, se registra el error y la operación no se rompe. Son la fuente para la pieza 4 (colección `eventos`).

## Estructura

```
src/
  index.js        createCore
  registry.js     registro de modelos y plugins
  tenancy.js      contexto de empresa y plugin de Mongoose
  permisos.js     permite(permisos, requerido)
  password.js     hash y verificación (scrypt)
  empresas.js     crearEmpresa, crearUsuario, agregarMiembro
  middleware.js   requierePermiso
  modelos/        empresa, usuario, rol, membresia, plantillas
  documentos/     errores, registro (tipos), modelos, servicio (core.documentos)
test/
```

## Pruebas

```bash
npm test
```

Usa el ejecutor de Node (`node --test`). La prueba de aislamiento entre empresas necesita una MongoDB real y se omite si no se define la variable:

```powershell
$env:MONGODB_URI="mongodb://localhost:27017"
node --test test/tenancy.test.js
```

Trabaja en la base `core-test-tenancy` y borra su colección al terminar.

`test/documentos.test.js` también necesita MongoDB real (base `core-test-documentos`, borra sus colecciones al terminar). Incluye numeración en paralelo y dos transiciones simultáneas, que **solo son válidas contra MongoDB real**: algunos servidores compatibles (por ejemplo FerretDB con SQLite) no garantizan actualizaciones atómicas y hacen fallar esas pruebas. `test/documentos-registro.test.js` no necesita base de datos.

## Convenciones

- ES modules (`"type": "module"`); los imports relativos llevan extensión (`./registry.js`).
- Nombres de archivo en minúscula.
- Mongoose como estándar; el driver nativo (`connection.db`) solo para salidas puntuales.