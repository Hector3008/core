# Autenticación: cómo funciona (sesiones opacas)

Guía para entender el módulo `core.auth` viniendo de JWT. Código en `src/auth/`.

## 1. La idea en una frase

Al iniciar sesión, el servidor **apunta en su base de datos** que "esta persona entró" y le entrega al navegador un **número de ticket** aleatorio. En cada petición el navegador muestra el ticket y el servidor lo busca en su libreta. Si no está en la libreta, no entras.

## 2. Comparación con JWT

| | JWT (lo que conoces) | Sesión opaca (esto) |
|---|---|---|
| Qué viaja en la cookie | Un token con datos dentro (usuario, expiración), firmado | Un número aleatorio sin significado |
| Dónde vive el estado | En el token | En la colección `sesiones` (servidor) |
| ¿Quién valida? | Se verifica la firma, sin consultar la base de datos | El servidor busca el ticket en la base de datos |
| Cerrar sesión de verdad | No se puede: el token vale hasta que caduque | Se borra el registro y deja de valer al instante |
| Suspender a un trabajador | Sigue entrando hasta que caduque su token | Se corta en la siguiente petición |
| Costo | Ninguna lectura extra | Una lectura por petición (barata) |

Por eso se eligió: en un restaurante hay tablets compartidas y trabajadores que se van; poder cortar un acceso en el momento importa más que ahorrar una lectura.

## 3. Qué hay en cada lado

**En el navegador:** una cookie `sid` con el token (43 caracteres aleatorios). Es `HttpOnly`: el JavaScript de la página no puede leerla, solo el navegador la reenvía.

**En MongoDB** (colección `sesiones`, un registro por sesión):

```
tokenHash        sha256 del token (nunca el token en claro)
usuarioId        quién es
empresaActivaId  en qué empresa está trabajando ahora (o null)
metodo           cómo entró ("password"; "pin" más adelante)
dispositivoId    null por ahora (lo usará el acceso por PIN)
creadaTs · ultimoUsoTs
expiraTs         caduca si no se usa (se renueva al usarla)
venceAbsolutoTs  tope de vida, no se renueva
ip · agente      para auditar
```

Se guarda el **hash** del token porque, si alguien copiara la colección, no podría fabricar cookies válidas con ella. (Igual que no guardamos contraseñas, sino su hash.)

## 4. El recorrido completo

**Login** (`POST /auth/login`, cuerpo `{ correo, password }`):
1. Se valida que sean textos (así no se cuelan objetos tipo `{ "$ne": null }`).
2. Se consulta el limitador de intentos (sección 6).
3. Se busca el usuario y se verifica la contraseña con scrypt. Si el correo no existe se verifica contra un hash falso, para que tarde lo mismo y no se pueda averiguar qué correos están registrados.
4. Se buscan sus membresías activas. Si tiene **una sola empresa**, queda como activa; si tiene varias, `empresaActivaId` queda `null` hasta que elija.
5. Se crea el token, se guarda su hash y se responde con `Set-Cookie`. El token **nunca** va en el cuerpo de la respuesta.

**Cada petición protegida** (`core.autenticar()`):
1. Lee la cookie y busca `tokenHash` en `sesiones`.
2. Revisa que no haya caducado (inactividad y tope absoluto) y que el usuario siga activo.
3. Si pasaron más de 5 minutos desde el último uso, renueva `expiraTs` (sin superar el tope).
4. Deja `req.auth = { usuarioId, empresaId }`.
5. Después viene `core.requierePermiso(...)`, que vuelve a comprobar membresía y rol en esa empresa.

**Logout** (`POST /auth/logout`): borra el registro y la cookie. Desde ese instante, aunque alguien tenga copiado el token, no sirve.

## 5. Empresa activa

Una persona puede trabajar en varias empresas. La sesión recuerda en cuál. Cambiar de empresa (`POST /auth/empresa`, cuerpo `{ empresaId }`) solo actualiza `empresaActivaId`, y solo se permite si tiene membresía activa allí. Aun así, `requierePermiso` comprueba la membresía en cada petición: la sesión sola nunca da acceso a una empresa.

`GET /auth/yo` devuelve usuario, empresas, empresa activa y los **permisos** de esa empresa: con eso el front sabe qué estaciones mostrar.

## 6. Protecciones incluidas

- **Intentos limitados:** 5 fallos por (IP + correo) y 30 por IP en 15 minutos; después responde 429 con `Retry-After`. Está en memoria: se reinicia con el servidor.
- **Mensaje único:** correo inexistente, contraseña errónea y usuario suspendido dan el mismo error.
- **CSRF:** las peticiones POST/PUT/DELETE deben llevar la cabecera `x-requested-with`. Otro sitio web no puede añadirla a una petición hacia el tuyo. Además la cookie es `SameSite=Lax`. **El front debe enviar esa cabecera en todos sus POST.**
- **Cookie:** `HttpOnly`, `SameSite=Lax`, y `Secure` automático cuando `NODE_ENV=production`.
- **Caducidad:** 12 h sin uso, 30 días como máximo; MongoDB borra las caducadas por sí solo (índice TTL).

## 7. Lo que NO hace todavía

Recuperar contraseña por correo, verificar correo, cambiar la contraseña desde la interfaz, dos factores, y la identidad del cliente final (será un `req.cliente` separado, en la pieza de clientes). El acceso por PIN sí está hecho: ver la sección 12.

## 8. Una sola puerta para crear sesiones

`crearSesion({ usuarioId, empresaActivaId, metodo, dispositivoId, inactividadMs, maximoMs })` es la única función por la que nace una sesión. `login` la usa tras validar la contraseña y el PIN la usa tras validar el PIN (`metodo: "pin"`). Todo lo demás (`autenticar`, caducidad, revocación, `requierePermiso`) es idéntico para los dos caminos.

## 9. Configuración

`createCore({ connection, auth: { ... } })`:

| Opción | Por defecto | Qué hace |
|---|---|---|
| `inactividadMs` | 12 h | Tiempo sin usar antes de caducar |
| `maximoMs` | 30 días | Vida máxima de una sesión |
| `toqueMs` | 5 min | Cada cuánto se renueva la caducidad |
| `protegerCsrf` | `true` | Exige `x-requested-with` en métodos no seguros |
| `intentosPorCuenta` / `intentosPorIp` | 5 / 30 | Fallos permitidos por ventana |
| `ventanaIntentosMs` | 15 min | Ventana del limitador |
| `cookie` | `{ nombre: "sid", secure: NODE_ENV==="production", sameSite: "Lax" }` | Ajustes de la cookie |
| `pinPimienta` | (ninguna) | Secreto del servidor que se mezcla con cada PIN antes del hash (ver sección 12) |
| `cookieDispositivo` / `dispositivoMaxMs` | `"did"` / 365 días | Cookie de la tablet emparejada |
| `intentosCodigoPorIp` / `intentosPorDispositivo` | 10 / 20 | Fallos permitidos por ventana al emparejar y al entrar con PIN desde una tablet |
| `ahora` | `Date.now` | Reloj (se cambia en pruebas) |

## 10. Errores y códigos HTTP

`DATOS_INVALIDOS` 400 · `CREDENCIALES_INVALIDAS` 401 · `SIN_SESION` 401 (borra la cookie) · `CSRF` 403 · `SIN_ACCESO_EMPRESA` 403 · `EMPRESA_NO_SELECCIONADA` 409 · `DEMASIADOS_INTENTOS` 429.

Del PIN: `PIN_INVALIDO` 400 · `CODIGO_INVALIDO` 401 · `DISPOSITIVO_INVALIDO` 401 (borra la cookie de la tablet) · `PIN_INCORRECTO` 401 · `PIN_NO_HABILITADO` 403 · `NO_ENCONTRADO` 404 · `PIN_BLOQUEADO` 423 (con `Retry-After`).

## 11. Trampas habituales

- **Detrás de un proxy** (Railway, Render, nginx) hay que poner `app.set("trust proxy", 1)` en el gateway; si no, `req.ip` es la del proxy y el limitador trata a todo el mundo como una sola persona.
- **Cookies en desarrollo:** `Secure` solo se activa en producción; con `http://localhost` funciona. En producción, solo por HTTPS.
- **Front en otro origen** (por ejemplo Vite en otro puerto): la cookie necesita CORS con credenciales. Sirviendo el front desde el mismo gateway no hace falta.
- **Cambió la contraseña o se perdió un dispositivo:** llamar a `core.auth.cerrarSesionesDe(usuarioId)`.
- **Baja de un trabajador:** desactivar su membresía ya lo bloquea (`requierePermiso`); además conviene `cerrarSesionesDe`.

## 12. Acceso por PIN en tablets

### La idea

En una cocina nadie va a escribir una contraseña larga con las manos mojadas. El PIN es otra forma de **crear la misma sesión**: la tablet ya está autorizada, la persona elige su nombre y escribe su PIN, y recibe una sesión normal con los permisos de su rol.

Hay **dos secretos** y los dos hacen falta:

| Secreto | Quién lo tiene | Qué demuestra |
|---|---|---|
| Cookie `did` (la tablet) | La tablet, un año | Este aparato lo autorizó un administrador |
| PIN (4 a 6 dígitos) | La persona | Soy quien dice mi nombre |

Un PIN de 4 dígitos son solo 10.000 combinaciones; si funcionara desde cualquier aparato se adivinaría fácil. Por eso solo vale en tablets emparejadas.

### El recorrido

1. **La empresa lo activa** (`PUT /auth/seguridad`). Viene apagado por defecto. Aquí se ajustan las opciones (sección "Opciones de cada empresa").
2. **Se fija el PIN de cada persona.** La propia persona (`PUT /auth/pin`, con su contraseña o su PIN actual) o un administrador (`PUT /auth/usuarios/:usuarioId/pin`).
3. **Se empareja la tablet.** Un administrador, ya autenticado, pide un código (`POST /auth/dispositivos/codigo`): 8 caracteres como `4A62-HYNW`, de un solo uso, que vence en 10 minutos (sin I, O, 0 ni 1 para no confundirlos). Se escribe en la tablet (`POST /auth/dispositivo/emparejar`) y el servidor le deja la cookie `did`. En la base de datos se guarda solo el hash del código y el del token de la tablet.
4. **Cada persona entra.** La tablet pide `GET /auth/dispositivo/personas` (los nombres de quienes tienen PIN), la persona toca el suyo y escribe el PIN (`POST /auth/dispositivo/entrar`). Nace una sesión `metodo: "pin"` ligada a esa tablet.
5. **Cambiar de persona** es volver a la lista de nombres: al entrar otra persona se cierra la sesión anterior. Si nadie toca la tablet, la sesión se cierra sola a los minutos que defina la empresa.

### Seguridad

- **Bloqueo por persona:** tras `maxIntentos` fallos seguidos el PIN de esa persona se bloquea `bloqueoMin` minutos, **también con el PIN correcto**. La cuenta de fallos y el bloqueo están en la base de datos (no se pierden al reiniciar) y valen para todas las tablets. Un acierto reinicia la cuenta; restablecer el PIN desbloquea. Efecto secundario aceptado: alguien podría bloquear a un compañero a propósito; el administrador lo desbloquea restableciendo su PIN.
- **Límites extra:** 20 fallos por tablet y 10 intentos de código por IP, cada 15 minutos.
- **PIN flojos rechazados:** `1111`, `1234`, `4321`, etc. Solo dígitos, y se envía como texto (`"0123"`, no el número 123).
- **Mismo error** para PIN malo, persona sin PIN o de otra empresa, y verificación contra un hash falso para igualar tiempos.
- **Pimienta:** un PIN corto se adivinaría en segundos si alguien copiara la base de datos (hay pocas combinaciones). Con `auth: { pinPimienta }` el PIN se mezcla con un secreto del servidor antes del hash, así la base de datos sola no basta. Guárdalo en una variable de entorno (por ejemplo `AUTH_PIN_PIMIENTA`) y no lo cambies: cambiarlo invalida todos los PIN.
- **Revocación inmediata:** revocar una tablet (`DELETE /auth/dispositivos/:id`) cierra todas sus sesiones y la deja inservible; la tablet recibe `DISPOSITIVO_INVALIDO`, se le borra la cookie y debe mostrar la pantalla de emparejar. Cambiar o quitar el PIN de una persona cierra sus sesiones de PIN abiertas.

### Qué puede hacer una sesión de PIN

**Lo mismo que el rol de esa persona** (decisión de diseño). Consecuencia: una tablet de cocina dejada abierta alcanza todo lo que el rol de quien entró permita. Recomendación práctica: que los roles que usan PIN no tengan permisos de administración, y que el administrador no deje su sesión de PIN abierta en una tablet compartida. `req.sesionAuth.metodo` permite a una ruta distinguir contraseña de PIN si algún día hace falta exigir contraseña para algo delicado.

### Opciones de cada empresa (`Empresa.seguridad.pin`)

| Opción | Por defecto | Rango | Qué hace |
|---|---|---|---|
| `habilitado` | `false` | | Activa el PIN y el emparejamiento |
| `largoMin` / `largoMax` | 4 / 6 | 4 a 6 | Largo permitido del PIN |
| `maxIntentos` | 5 | 3 a 10 | Fallos seguidos antes del bloqueo |
| `bloqueoMin` | 15 | 1 a 1440 | Minutos de bloqueo |
| `inactividadMin` | 10 | 1 a 120 | Minutos sin usar la tablet antes de cerrar la sesión |
| `sesionMaxHoras` | 12 | 1 a 24 | Vida máxima de una sesión de PIN |
| `codigoVigenciaMin` | 10 | 1 a 60 | Cuánto dura un código de emparejamiento |

Los cambios solo afectan a lo que se haga después (un PIN ya guardado con 4 dígitos sigue valiendo aunque luego se exijan 5). Cada petición de la tablet relee la configuración, así que un cambio del administrador rige de inmediato.

### Rutas (todas las monta `core.auth.montarRutas(router)`)

| Ruta | Quién | Permiso |
|---|---|---|
| `GET` / `PUT /seguridad` | Administración | `empresa:seguridad` |
| `POST /dispositivos/codigo` · `GET /dispositivos` · `DELETE /dispositivos/:id` | Administración | `dispositivo:gestionar` |
| `GET /usuarios` · `PUT` / `DELETE /usuarios/:usuarioId/pin` | Administración | `usuario:gestionar` |
| `PUT /pin` | La propia persona | sesión iniciada |
| `POST /dispositivo/emparejar` · `GET /dispositivo/personas` · `POST /dispositivo/entrar` | La tablet | cookie `did` (emparejar: código) |

El rol `admin` (`*`) ya tiene los tres permisos nuevos; otros roles los reciben cuando se les añadan.

### Para el front de la tablet

- Todos los POST/PUT/DELETE llevan `x-requested-with`.
- Si `GET /auth/dispositivo/personas` responde 401 `DISPOSITIVO_INVALIDO`, mostrar la pantalla de emparejar.
- Si `POST /auth/dispositivo/entrar` responde 423, mostrar el tiempo de espera (`reintentarEnSeg`).
- `GET /auth/dispositivo/personas` devuelve también `largoMin`, `largoMax` e `inactividadMin`, para dibujar el teclado y el temporizador de bloqueo.
