# Solicitudes de empresa (5.65)

`core.solicitudes` guarda las solicitudes de una empresa nueva y hace las altas cuando el **operador** de la plataforma aprueba. No tiene rutas HTTP ni permisos de empresa: el formulario, los correos y las páginas viven en el gateway (`src/solicitudes/`). Las colecciones son de la plataforma (modelos globales): `solicitudes_empresa` y `tokens_password`.

## Operaciones

| Operación | Qué hace |
|---|---|
| `crear({ nombre, slug, servicios, pais, moneda, telefono, adminNombre, adminCorreo, aceptoTerminos: { terminos, privacidad }, serviciosPermitidos? })` | Valida todo junto (`DATOS_INVALIDOS` con `detalle.campos`), comprueba que el slug esté libre (empresas y solicitudes vigentes), que el correo no tenga otra solicitud vigente y el tope de pendientes (50). Devuelve `{ solicitud, token }`: el `token` es el secreto del enlace del operador y no se puede volver a leer. **No crea la empresa.** |
| `ver(token)` | Los datos de la solicitud para quien abre el enlace. No cambia nada. |
| `aprobar(token)` | Crea la empresa (con las plantillas de rol de sus servicios) y a su primer admin. Correo nuevo: cuenta con contraseña aleatoria que nadie conoce + `tokenAcceso` (enlace de un solo uso, 14 días) para que la persona elija la suya. Correo que ya tiene cuenta activa: solo la afilia. Atómica: dos aprobaciones a la vez crean una empresa. Si falla a la mitad queda `incompleta` y reintentar la reanuda sin duplicar. |
| `rechazar(token)` | Cierra la solicitud; el enlace deja de servir y la dirección web queda libre. |
| `verAcceso(token)` / `establecerPassword({ token, password })` | El enlace para elegir la contraseña: se gasta antes de guardar, aplica la política de contraseñas y no se puede repetir. |

## Reglas

- Los enlaces son de 256 bits (`randomBytes(32)` en base64url). En la base solo está su hash sha-256; la solicitud vigente dura 14 días y el enlace de contraseña otros 14 (se borra a los 30 días de vencer).
- El `slug` va en direcciones públicas: 3 a 60 caracteres, minúsculas, números y guiones, sin guiones dobles ni en los extremos, y fuera de una lista de palabras reservadas de la plataforma.
- Los `servicios` deben tener plantillas de rol en el núcleo (`modelos/plantillas.js`) y, si el despliegue pasa `serviciosPermitidos`, estar en esa lista.
- Nombres y datos de texto se guardan en una sola línea, sin caracteres de control (van a correos).
- Errores: `ErrorSolicitud` con `codigo` y `status` (`DATOS_INVALIDOS` 400, `ENLACE_INVALIDO` 404, `ENLACE_VENCIDO` 410, `SLUG_OCUPADO` / `ESTADO_INVALIDO` / `CUENTA_SUSPENDIDA` 409, `DEMASIADAS_SOLICITUDES` 429).
- El gateway llama a `core.solicitudes.listo()` solo si quiere esperar los índices; los modelos crean los suyos al conectar.

## Operador y recuperación de contraseña (5.66 y 5.67)

La identidad del operador la decide el gateway (enlace al correo `OPERADOR_CORREO`); el núcleo no tiene permisos de empresa para esto y **no expone nada por HTTP**: son funciones para que el gateway las llame.

| Función | Qué hace |
|---|---|
| `listar({estado, limite, saltar})` | Solicitudes de la más nueva a la más vieja. `estado`: `pendiente` (incluye `procesando` e `incompleta`), `aprobada`, `rechazada`; sin él, todas. Marca `vencida`. Límite 1–200. |
| `contarPendientes()` | Pendientes o a medias que todavía no vencieron. |
| `aprobarPorId(id)` / `rechazarPorId(id)` | Lo mismo que `aprobar(token)` / `rechazar(token)` (misma lógica atómica y reanudable). Un id mal formado da `DATOS_INVALIDOS`; uno inexistente, `ENLACE_INVALIDO`. |
| `listarEmpresas({texto, limite, saltar})` | Empresas de la más nueva a la más vieja con sus administradores activos. `texto` busca por nombre (como texto literal, no como expresión regular) o por dirección web exacta. |
| `fijarActiva({empresaId, activa})` | Suspende (`false`) o reactiva (`true`) una empresa. No borra nada. |
| `reenviarAcceso({empresaId, usuarioId})` | Enlace nuevo de contraseña (tipo `acceso`, 14 días) para un **administrador activo de esa empresa**; anula los enlaces sin usar de esa persona. Devuelve `{correo, nombre, empresa, token, vence}`; el token solo existe en esa respuesta. |
| `solicitarRecuperacion({correo})` | «Olvidé mi contraseña». Con una cuenta activa emite un enlace de **1 hora** (tipo `recuperacion`) y devuelve `{correo, nombre, token, vence}`; si el correo no existe, está mal formado, la cuenta está suspendida o ya hubo un pedido hace menos de 1 minuto, devuelve `null`. Quien llama debe responder **igual** en todos los casos. |

`verAcceso(token)` ahora devuelve también `tipo` (`acceso` | `recuperacion`). `establecerPassword` además **cierra todas las sesiones** de esa persona (también las de tablet) y devuelve `sesionesCerradas`; si la política de contraseña falla no gasta el enlace ni cierra nada.

Modelo: `tokens_password` suma `tipo` (por omisión `acceso`) y `createdAt` explícito.
