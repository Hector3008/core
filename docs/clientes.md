# Gestión de clientes (`core.clientes`)

Qué resuelve: llevar la ficha de los clientes de una empresa (alta, búsqueda, corrección, baja), registrar sus consentimientos y atender un pedido de supresión de datos, desde la aplicación y sin tocar código.

Es la gestión que hace el **personal**. El cliente final no inicia sesión aquí: su identidad (cuenta propia, pedido por QR sin cuenta) se diseña aparte.

## La ficha

| Campo | Notas |
|---|---|
| `nombre` | Obligatorio (máximo 80). |
| `telefono`, `telefonoPais` | Se guarda siempre en formato internacional (`+51987654321`); el país se deduce del número. Único por empresa. |
| `correo` | En minúsculas. Único por empresa. |
| `redes` | Objeto opcional: `{ instagram, tiktok, facebook, x }`. Solo el usuario (sin `@` ni enlace). Cada red es opcional. |
| `identificacion` | `{ tipo, numero }` (RUC, DNI, CUIT...). |
| `direccion` | Texto libre (máximo 200). |
| `preferencias` | Bloque flexible de cada servicio (entrega, agencia, forma de pago...). Máximo 4 KB. Se reemplaza completo. |
| `consentimientos` | `programaPuntos`, `etiquetadoRedes`; cada uno `{ otorgado, ts, medio, registradoPor }`. |
| `activo`, `anonimizado` | Estado. |

Un cliente puede tener solo el nombre (por ejemplo, "Mesa 4").

### Teléfono: el país sale de la empresa o del propio número

- `Empresa.pais` (código ISO de 2 letras, `PE` por defecto) decide el código con el que se interpreta un número escrito sin prefijo: `987 654 321` en una empresa de Perú es `+51987654321`; `11 2345-6789` en una empresa de Argentina (`pais: "AR"`) es `+541123456789`.
- Si el número trae `+` (o `00`), manda el del número, sea cual sea el país de la empresa: `+54 9 11 2345-6789` en una empresa peruana queda `+5491123456789`.
- Para un número escrito en formato nacional de otro país, se indica `paisTelefono` en esa llamada (`{ telefono: "11 2345-6789", paisTelefono: "AR" }`).
- El país **no se deduce de la ubicación de la conexión** (IP): una VPN, una tablet o un empleado de viaje darían el código equivocado.
- Cambiar el país de la empresa (`core.empresas.fijarPais`) solo afecta a lo que se escriba después; los teléfonos guardados ya son internacionales.
- Empresas creadas antes de este campo no lo tienen: se asume `PE`.

### Redes

Se admite lo que la persona pegue: `@Ana.Perez`, `ana.perez` o `https://www.instagram.com/Ana.Perez/?hl=es` quedan como `ana.perez`. Se rechaza lo que no sea un usuario válido de esa red. Para agregar otra red basta una entrada en la tabla `REDES` de `src/clientes/redes.js`: el esquema y la validación salen de ella.

## Permisos

| Permiso | Para qué |
|---|---|
| `cliente:leer` | Ver y buscar (lo piden las rutas). |
| `cliente:crear` | Dar de alta. La plantilla de mesero lo trae. |
| `cliente:editar` | Corregir la ficha. |
| `cliente:gestionar` | Baja, reactivar, consentimientos y anonimizar. |

`cliente:*` los incluye todos (la plantilla de siscore ya lo usa). Como en empleados, cada operación que cambia algo recibe `actor = { usuarioId, permisos }` y comprueba su permiso, así que protege aunque una ruta se monte sin `requierePermiso`. Las empresas ya creadas conservan sus roles: para que su mesero pueda crear clientes, hay que editar el rol con `core.empleados.editarRol`.

## Operaciones

`crear`, `obtener`, `actualizar`, `listar` (con `texto` opcional), `buscar`, `desactivar`, `reactivar`, `cambiarConsentimiento` (`otorgarConsentimiento` / `retirarConsentimiento`), `tieneConsentimiento`, `instantanea`, `anonimizar`, `manejadores`, `montarRutas(router)` y `listo()`. Errores: `ErrorCliente` con `codigo` y `status`:

`DATOS_INVALIDOS` 400 · `PERMISO_INSUFICIENTE` 403 · `NO_ENCONTRADO` 404 · `CLIENTE_DUPLICADO` 409 (trae `campo` y `clienteId` del existente) · `ESTADO_INVALIDO` 409.

- **Actualizar:** `undefined` no toca el campo; `null` o `""` lo quita. `redes` se combina red por red (`{ instagram: null }` quita solo esa).
- **Buscar** (`GET /clientes?q=`): `@usuario` busca en las redes, un correo busca por correo, algo con forma de teléfono busca por número (completo, o por los últimos dígitos) y el resto por parte del nombre. Máximo 200 por llamada.
- **Baja:** nunca se borra a nadie (documentos y eventos guardan su id). Un desactivado conserva su teléfono y su correo reservados.
- **Consentimientos:** quedan el estado actual y una entrada en el historial (cuándo, cómo, quién; se conservan las últimas 100). Repetir el mismo estado no hace nada. Retirar siempre se permite; otorgar exige un cliente activo. `tieneConsentimiento` es lo que usarán fidelización y redes sociales antes de actuar.
- **`instantanea({ empresaId, clienteId, campos? })`:** lo que se copia al `snapshot` del documento. Por minimización de datos, por defecto no trae correo ni redes: cada servicio pide solo lo que necesita. Solo de clientes activos.
- **Anonimizar:** borra nombre, teléfono, correo, redes, identificación, dirección y preferencias; deja el id; retira los consentimientos (con medio `anonimizacion`); no se puede deshacer y libera el teléfono y el correo. **Límite:** los `snapshot` ya copiados dentro de documentos no se tocan; el aviso de privacidad debe decirlo.

## Rutas (`core.clientes.montarRutas(router)`, montadas en `/clientes`)

- `cliente:leer`: `GET /` (`?q=`, `&inactivos=1`, `&limite=`, `&saltar=`), `GET /:clienteId`.
- `cliente:crear`: `POST /`.
- `cliente:editar`: `PUT /:clienteId`.
- `cliente:gestionar`: `PUT /:clienteId/consentimientos/:finalidad` (`{ otorgado, medio }`), `POST /:clienteId/desactivar`, `POST /:clienteId/reactivar`, `POST /:clienteId/anonimizar`.

Todas llevan `autenticar → requierePermiso → handler`; las que escriben exigen `x-requested-with`.

## Montaje en el gateway

```js
const clientes = express.Router();
clientes.use(express.json());
core.clientes.montarRutas(clientes);
gateway.use("/clientes", clientes);
```

Y en `db.js`, junto a los otros `listo()`: `await core.clientes.listo();` (crea los índices únicos de teléfono y correo, de los que depende la detección de duplicados).
