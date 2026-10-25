# Cuentas del cliente final (`core.cuentasCliente`)

La cuenta de un cliente vive en su ficha `Cliente` de **cada empresa** (campo `cuenta`): no es un `Usuario`, no comparte sesión con el personal y nunca alcanza permisos de personal. El mismo correo o teléfono puede tener ficha en varias empresas, cada una con su contraseña y sus puntos.

## Sesión propia
- Colección `sesiones_cliente` (con tenancy): hash SHA-256 del token, `clienteId`, caducidad por inactividad (7 días) y máxima (30 días, TTL).
- Cookie `cs_<slug-de-la-empresa>` (`HttpOnly`, `SameSite=Lax`, `Secure` en producción). Una cookie por empresa.
- `core.cuentasCliente.autenticarCliente({ empresaDe })` es el middleware para rutas del cliente: deja `req.cliente = { clienteId, empresaId, sesionId }` y **nunca** `req.auth`.
- `empresaDe(req)` lo pone el servicio que monta las rutas: devuelve `{ id, slug }` o lanza un error con `status` y `codigo` (tobt lo saca del slug de la ruta).

## Cómo nace una cuenta
1. **El personal la crea** (`POST /clientes/:id/cuenta`, permiso `cliente:cuenta`): `{ generarPassword: true }` o `{ password }`. Devuelve `passwordTemporal` **una sola vez** (`Cache-Control: no-store`); `debeCambiarPassword` queda en `true`. Restablecer: `POST /clientes/:id/cuenta/password`.
2. **El cliente se registra** (`manejadores.registro`): `{ nombre, telefono|correo, password, quierePuntos }`. Si ya existe una ficha con ese teléfono o correo responde `REGISTRO_BLOQUEADO` (409) sin decir de quién: se pide ir al personal. Sin verificación de teléfono ni correo (no hay servicio de envío). Límite: 10 registros por hora por IP (en memoria). `quierePuntos` registra el consentimiento `programaPuntos` con medio `formulario`.

3. **Con Google** (`manejadores.google`, 5.51): ver «Entrar con Google» abajo.

## Entrar y contraseña
- Usuario = correo o teléfono (normalizado con el país de la empresa). Mismo error para cuenta inexistente, contraseña errónea y ficha dada de baja; verificación contra un hash falso para igualar tiempos. Límites: 5 intentos por cuenta y 30 por IP cada 15 min (en memoria).
- Con contraseña temporal la sesión solo puede cambiarla o salir (`CAMBIO_PASSWORD_REQUERIDO`). Cambiarla cierra las demás sesiones.
- Desactivar o anonimizar al cliente cierra sus sesiones y la anonimización borra la cuenta.

## Entrar con Google (5.51)
El botón de Google entrega un **ID token** (JWT). `crearVerificadorGoogle` (`src/cuentas/google.js`, sin librerías) comprueba la firma RS256 con las claves públicas de Google (`/oauth2/v3/certs`, en caché una hora), el emisor, que `aud` sea **nuestro** Client ID, que no haya caducado (±1 min de reloj) y que el correo venga **verificado por Google**. De ahí sale solo `{ sub, correo, nombre }`.
- **Configuración**: variable de entorno `GOOGLE_CLIENT_ID` (o `opciones.google.clientId`). Sin ella la función no existe (`GOOGLE_NO_DISPONIBLE` 503) y la carta no muestra el botón. El Client ID es público; no hay secreto.
- **`entrarConGoogle({ empresaId, credencial, quierePuntos?, codigoReferido? })`**: (1) ficha ya vinculada a ese `sub` → entra; (2) ficha con ese correo → se le vincula Google (sin cuenta: se le crea una sin contraseña, `origen: "google"`; con cuenta: conserva su contraseña); una ficha ya vinculada a **otra** cuenta de Google no se pisa (`ESTADO_INVALIDO` 409); (3) sin ficha → se crea con el nombre y el correo de Google. `quierePuntos` y `codigoReferido` solo valen en una ficha nueva. Ficha desactivada o anonimizada: no entra.
- Aquí sí se puede unir a una ficha existente (a diferencia del registro con contraseña) porque Google comprueba que el correo es de la persona.
- **Datos**: `cuenta.identidades: [{ proveedor: "google", sub, correo, vinculadaTs }]`, único por empresa (`cuenta.identidades.sub`). `cuenta.passwordHash` ya no es obligatorio: una cuenta solo-Google no entra por contraseña y `cambiarPassword` responde `SIN_PASSWORD` (409). El personal puede darle una contraseña con `restablecerPassword`.
- **Límites de intentos**: 20 tokens inválidos por IP cada 15 min (`opciones.googleFallosPorIp`).
- Manejador `POST .../google { credencial, quierePuntos?, codigoReferido? }` → 201 (cuenta nueva) o 200 y abre la sesión. `yo` sin sesión añade `google: { clientId }` solo si está activado. Errores: `GOOGLE_INVALIDO` 401, `GOOGLE_NO_DISPONIBLE` 503, `DEMASIADOS_INTENTOS` 429.
- Límites: una ficha que solo tiene teléfono no se une por esta vía; el correo de la ficha lo pudo escribir el personal (si estaba mal, la dueña de ese Gmail entraría a esa ficha); no hay «desvincular Google» ni mostrar el método en la ficha.

## Manejadores (`core.cuentasCliente.manejadores({ empresaDe })`)
`registro`, `login`, `google`, `logout`, `yo` (GET: `{ sesion: false }` o `{ sesion: true, cliente, puntos }`), `password`, `consentimiento` (PUT `{ otorgado }`). Los que escriben exigen `x-requested-with`. Del personal: `manejadoresPersonal.{crearCuenta, restablecerPassword}`, montados por `core.clientes.montarRutas`.

## Límites conocidos
Sin verificación de contacto ni recuperación por correo o teléfono (la restablece el personal); límites de intentos en memoria; `registrar` (ficha + cuenta) no es una sola operación; que un registro sea bloqueado revela que existe una ficha con ese dato (mitigado por el límite por IP).
