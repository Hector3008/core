# Gestión de empleados (`core.empleados`)

Qué resuelve: dar de alta y de baja al equipo de una empresa, cambiar roles y crear roles propios, desde la aplicación y sin tocar código.

## Idea central: nadie da ni toca lo que no tiene

Cada operación que cambia algo recibe `actor = { usuarioId, permisos }`. El servicio comprueba que quien pide tenga todos los permisos de lo que toca (`alcanza`). Por eso un encargado con `usuario:gestionar` no puede ascenderse, ni asignar el rol admin, ni cambiar el rol, el PIN o la contraseña de un admin. Las rutas llevan `requierePermiso`, pero estas reglas protegen aunque alguien monte una ruta sin él.

## Cómo entra un empleado nuevo

- Contraseña temporal: el admin la escribe o pide `generarPassword: true` (se devuelve una sola vez, con `Cache-Control: no-store`). La sesión de contraseña solo puede llamar a `/auth/yo`, `/auth/logout` y `/auth/password` hasta que la persona la cambie.
- PIN: `pin` en el alta (requiere el PIN habilitado en la empresa). Sin contraseña, la cuenta guarda el hash de un secreto aleatorio que nadie conoce.
- Las dos a la vez, o una sola; al menos una para un correo nuevo.
- Si el correo ya tiene cuenta (trabaja en otro local) se añade con su cuenta: no se toca su contraseña ni su nombre; solo se puede darle PIN (es por empresa).

## Qué es de la empresa y qué es global

El nombre y las credenciales son de la persona (global); el teléfono, el rol, el PIN y la baja son de la empresa. Si trabaja en más de una empresa, desde una sola no se puede cambiar su nombre ni restablecer su contraseña (`COMPARTIDO`).

## Baja

Nunca se borra. `desactivar` pone `activa: false`, quita el PIN y cierra las sesiones de esa empresa. `reactivar` la devuelve; el PIN hay que fijarlo de nuevo. No puedes darte de baja a ti mismo ni cambiar tu propio rol, y la empresa conserva siempre un admin activo (`ULTIMO_ADMIN`).

## Roles

`crearRol`, `editarRol`, `eliminarRol`, `listarRoles`. Permisos con formato `recurso:accion`. Los roles con `*` (como `admin`) no se editan ni se borran; un rol con empleados (activos o de baja) no se borra.

## Rutas (`core.empleados.montarRutas(router)`, montadas en `/empleados`)

`usuario:gestionar`: `GET /`, `POST /`, `GET /:usuarioId`, `PUT /:usuarioId`, `PUT /:usuarioId/rol`, `POST /:usuarioId/desactivar`, `POST /:usuarioId/reactivar`, `POST /:usuarioId/password`, `PUT`/`DELETE /:usuarioId/pin`.
`rol:gestionar`: `GET`/`POST /roles`, `PUT`/`DELETE /roles/:rolId`.
Propia: `POST /auth/password` (`passwordActual`, `passwordNueva`). Las rutas `PUT`/`DELETE /auth/usuarios/:id/pin` ahora pasan por la regla de alcance.

## Montaje en el gateway

```js
const empleados = express.Router();
empleados.use(express.json());
core.empleados.montarRutas(empleados);
app.use("/empleados", empleados);
```
