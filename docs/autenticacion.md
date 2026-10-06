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

Recuperar contraseña por correo, verificar correo, cambiar contraseña desde la interfaz, dos factores, el acceso por PIN, y la identidad del cliente final (será un `req.cliente` separado, en la pieza de clientes).

## 8. Preparado para el acceso por PIN

`crearSesion({ usuarioId, empresaActivaId, metodo, dispositivoId })` es la única puerta por la que nace una sesión; `login` solo la usa tras validar la contraseña. El PIN será otro camino que llama a la misma función con `metodo: "pin"` y un `dispositivoId` (la tablet autorizada por un administrador). Todo lo demás (`autenticar`, caducidad, revocación, `requierePermiso`) funciona igual. Ya existen los campos `metodo` y `dispositivoId` en la sesión, y `req.sesionAuth` los expone a las rutas.

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
| `ahora` | `Date.now` | Reloj (se cambia en pruebas) |

## 10. Errores y códigos HTTP

`DATOS_INVALIDOS` 400 · `CREDENCIALES_INVALIDAS` 401 · `SIN_SESION` 401 (borra la cookie) · `CSRF` 403 · `SIN_ACCESO_EMPRESA` 403 · `EMPRESA_NO_SELECCIONADA` 409 · `DEMASIADOS_INTENTOS` 429.

## 11. Trampas habituales

- **Detrás de un proxy** (Railway, Render, nginx) hay que poner `app.set("trust proxy", 1)` en el gateway; si no, `req.ip` es la del proxy y el limitador trata a todo el mundo como una sola persona.
- **Cookies en desarrollo:** `Secure` solo se activa en producción; con `http://localhost` funciona. En producción, solo por HTTPS.
- **Front en otro origen** (por ejemplo Vite en otro puerto): la cookie necesita CORS con credenciales. Sirviendo el front desde el mismo gateway no hace falta.
- **Cambió la contraseña o se perdió un dispositivo:** llamar a `core.auth.cerrarSesionesDe(usuarioId)`.
- **Baja de un trabajador:** desactivar su membresía ya lo bloquea (`requierePermiso`); además conviene `cerrarSesionesDe`.
