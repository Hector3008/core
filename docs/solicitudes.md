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
