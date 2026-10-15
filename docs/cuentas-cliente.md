# Cuentas del cliente final (`core.cuentasCliente`)

La cuenta de un cliente vive en su ficha `Cliente` de **cada empresa** (campo `cuenta`): no es un `Usuario`, no comparte sesión con el personal y nunca alcanza permisos de personal. El mismo correo o teléfono puede tener ficha en varias empresas, cada una con su contraseña y sus puntos.

## Sesión propia
- Colección `sesiones_cliente` (con tenancy): hash SHA-256 del token, `clienteId`, caducidad por inactividad (7 días) y máxima (30 días, TTL).
- Cookie `cs_<slug-de-la-empresa>` (`HttpOnly`, `SameSite=Lax`, `Secure` en producción). Una cookie por empresa.
- `core.cuentasCliente.autenticarCliente({ empresaDe })` es el middleware para rutas del cliente: deja `req.cliente = { clienteId, empresaId, sesionId }` y **nunca** `req.auth`.
- `empresaDe(req)` lo pone el servicio que monta las rutas: devuelve `{ id, slug }` o lanza un error con `status` y `codigo` (el restaurante lo saca del slug de la ruta).

## Cómo nace una cuenta
1. **El personal la crea** (`POST /clientes/:id/cuenta`, permiso `cliente:cuenta`): `{ generarPassword: true }` o `{ password }`. Devuelve `passwordTemporal` **una sola vez** (`Cache-Control: no-store`); `debeCambiarPassword` queda en `true`. Restablecer: `POST /clientes/:id/cuenta/password`.
2. **El cliente se registra** (`manejadores.registro`): `{ nombre, telefono|correo, password, quierePuntos }`. Si ya existe una ficha con ese teléfono o correo responde `REGISTRO_BLOQUEADO` (409) sin decir de quién: se pide ir al personal. Sin verificación de teléfono ni correo (no hay servicio de envío). Límite: 10 registros por hora por IP (en memoria). `quierePuntos` registra el consentimiento `programaPuntos` con medio `formulario`.

## Entrar y contraseña
- Usuario = correo o teléfono (normalizado con el país de la empresa). Mismo error para cuenta inexistente, contraseña errónea y ficha dada de baja; verificación contra un hash falso para igualar tiempos. Límites: 5 intentos por cuenta y 30 por IP cada 15 min (en memoria).
- Con contraseña temporal la sesión solo puede cambiarla o salir (`CAMBIO_PASSWORD_REQUERIDO`). Cambiarla cierra las demás sesiones.
- Desactivar o anonimizar al cliente cierra sus sesiones y la anonimización borra la cuenta.

## Manejadores (`core.cuentasCliente.manejadores({ empresaDe })`)
`registro`, `login`, `logout`, `yo` (GET: `{ sesion: false }` o `{ sesion: true, cliente, puntos }`), `password`, `consentimiento` (PUT `{ otorgado }`). Los que escriben exigen `x-requested-with`. Del personal: `manejadoresPersonal.{crearCuenta, restablecerPassword}`, montados por `core.clientes.montarRutas`.

## Límites conocidos
Sin verificación de contacto ni recuperación por correo o teléfono (la restablece el personal); límites de intentos en memoria; `registrar` (ficha + cuenta) no es una sola operación; que un registro sea bloqueado revela que existe una ficha con ese dato (mitigado por el límite por IP).
