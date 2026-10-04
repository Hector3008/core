# core

Núcleo común sobre el que se montan los servicios (restaurante, siscore, etc.). Se escribe una sola vez y cada servicio lo usa como dependencia.

El núcleo **no abre ni cierra conexiones**: usa la conexión de Mongoose que le entrega el gateway.

## Estado

| Pieza | Estado |
|---|---|
| 1. Conexión | Hecha |
| 2. Empresas, usuarios, membresías, roles y permisos | Hecha |
| 3. Motor de documentos | Pendiente |
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
| `core.modelos` | `Empresa`, `Usuario`, `Rol`, `Membresia`. |
| `core.empresas` | `crearEmpresa`, `crearUsuario`, `agregarMiembro`. |
| `core.requierePermiso(permiso)` | Middleware de Express que verifica el permiso del usuario en su empresa. |

También se exportan: `conEmpresa`, `empresaActual`, `tenancyPlugin`, `marcarGlobal`, `permite`, `hashPassword` y `verificarPassword`.

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

## Convenciones

- ES modules (`"type": "module"`); los imports relativos llevan extensión (`./registry.js`).
- Nombres de archivo en minúscula.
- Mongoose como estándar; el driver nativo (`connection.db`) solo para salidas puntuales.