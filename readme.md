# core

Núcleo común y flexible sobre el que se montan varios servicios (restaurante/cafetería, siscore y otros), para escribir el código una sola vez y mantenerlo más fácil.

> **Estado:** pieza 1 (conexión). Las piezas siguientes (empresas, usuarios y permisos, motor de documentos, eventos) se irán agregando.

## Principios

- **No crea conexiones.** El núcleo se inicializa con la conexión de Mongoose que ya abrió el gateway. Nunca la abre ni la cierra.
- **Mongoose es el estándar.** Se declara como `peerDependency` para que el gateway y el núcleo compartan una sola instancia. Si hace falta el driver nativo (por ejemplo para la colección `eventos`), está disponible en `connection.db`.
- **Cada servicio recibe lo que necesita.** Los servicios exportan una función fábrica y el gateway la llama con el núcleo ya creado.

## Requisitos

- Node.js 18 o superior (el paquete usa ES modules: `"type": "module"`)
- Mongoose 8 (lo instala el proyecto que usa el núcleo, no el núcleo)

## Instalación

Desde el proyecto que lo usa (por ejemplo `Mi-Servidor`):

```bash
npm install github:Hector3008/core mongoose
```

> Ajusta `Hector3008/core` al nombre real del repositorio.

## Uso

```js
import mongoose from 'mongoose';
import { createCore } from 'core';

const connection = await mongoose.createConnection(process.env.MONGO_URI).asPromise();
const core = createCore({ connection });

// Ruta de salud del gateway
app.get('/servidor', async (_req, res) => res.json(await core.ping()));

// Registrar un modelo sobre la conexión del gateway
const Producto = core.model('Producto', new mongoose.Schema({ codigo: String }));
```

## API

### `createCore({ connection, plugins? })`

| Parámetro | Tipo | Descripción |
| --- | --- | --- |
| `connection` | `mongoose.Connection` | Obligatorio. Conexión ya creada. Si no es una `Connection` de Mongoose, lanza un error. |
| `plugins` | `Function[]` | Opcional. Plugins de Mongoose que se aplican a todos los modelos registrados con `core.model`. |

Devuelve un objeto con:

| Miembro | Descripción |
| --- | --- |
| `connection` | La misma conexión que se recibió. |
| `model(nombre, schema, coleccion?)` | Registra un modelo sobre la conexión. Es idempotente: si el modelo ya existe, devuelve el existente en vez de fallar con `OverwriteModelError`. |
| `use(plugin)` | Agrega un plugin global. Se aplica solo a los modelos registrados **después** de llamarlo. |
| `estado()` | Devuelve `'desconectado'`, `'conectado'`, `'conectando'` o `'desconectando'`. |
| `ping()` | Devuelve `{ ok, estado }`. Si hay conexión, hace un ping real a MongoDB. Pensado para la ruta de salud. |

## Pruebas

```bash
npm install
npm test
```

Las pruebas no necesitan una base de datos real: comprueban la validación de la conexión, `estado()`/`ping()` sin conexión abierta, y que `model()` sea idempotente y aplique los plugins.

## Estructura

```
core/
├── package.json
├── README.md
├── src/
│   ├── index.js      # createCore
│   └── registry.js   # registro de modelos y plugins
└── test/
    └── core.test.js
```

## Hoja de ruta

| # | Pieza | Estado |
| --- | --- | --- |
| 1 | Conexión | Hecha (falta probarla contra el MongoDB real desde el gateway) |
| 2 | Empresas, usuarios, membresías, roles y permisos | Pendiente |
| 3 | Motor de documentos (sobre, estados, versiones, numeración) | Pendiente |
| 4 | Eventos | Pendiente |
| 5 | Servicio restaurante | Pendiente |
| 6 | Migración de siscore | Pendiente |

## Decisiones de diseño

- Toda colección llevará `empresaId` (multiempresa). Un plugin de Mongoose, que se enganchará con `use()`, agregará el filtro a cada consulta.
- El documento vive en `payload.doc` dentro de un sobre; `tipo` y `estado` van separados.
- Los eventos capturados por la interfaz y por el servidor van en una colección aparte, solo de inserción.