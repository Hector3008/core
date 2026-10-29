# Promociones (5.40)

Descuentos **automáticos** sobre lo que lleva un pedido: 2x1, «si lleva A, B con descuento», descuento directo. El núcleo guarda las reglas y sabe calcularlas; **no sabe de pedidos**: un servicio le pasa las líneas y decide qué hacer con el resultado (en `tobt`, el parche 5.42).

## Reglas (`Promocion`, colección `promociones`, con tenancy)

`nombre`, `descripcion?`, `activa`, `prioridad` (0 a 1000, menor primero), `acumulable`, `tipo`, y según el tipo:

| `tipo` | Qué hace | Campos |
|---|---|---|
| `nxm` | Lleva `n`, paga `m`. En cada grupo de `n` unidades (de las más caras a las más baratas) las `n − m` más baratas son gratis. | `objetivo`, `n` (2 a 10), `m` (1 a `n − 1`) |
| `combo` | Por cada unidad del `disparador`, una del `objetivo` (la más barata primero) lleva el descuento. Una unidad no es disparador y objetivo a la vez. | `disparador`, `objetivo`, `efecto`, `valor` |
| `directo` | Descuento en todo lo que coincide con el `objetivo`. | `objetivo`, `efecto`, `valor` |

- `objetivo` y `disparador`: `{ itemCodigo }` **o** `{ categoria }` (uno solo). El código y la categoría no distinguen mayúsculas.
- `efecto`: `porcentaje` (más de 0 y hasta 100), `monto` (más de 0, por unidad) o `gratis` (sin `valor`). Hasta 2 decimales. Un descuento nunca supera lo que cuesta la unidad.
- **Cuándo rige** (todo opcional): `vigencia { desde, hasta }` (AAAA-MM-DD, ambas incluidas), `dias` (0 domingo a 6 sábado), `horario { desde, hasta }` (HH:MM; el inicio cuenta y el final no; puede cruzar la medianoche).
- Los campos que no son de su tipo se **rechazan**, no se ignoran.
- Hasta **100 promociones activas por empresa** (`LIMITE_ALCANZADO`, 409). Nunca se borran: se pausan con `activa: false`. El tope es blando: dos altas simultáneas podrían pasarse por una.

## Hora de la empresa

Días y horarios se leen en la **zona horaria de la empresa**: `Empresa.zonaHoraria` (un nombre IANA, `America/Lima`) si la fijó (`core.empresas.fijarZonaHoraria`, `null` la quita); si no, la de su país (`zona.js`, `PE` → `America/Lima`); si no, UTC. Es la misma tabla que usa `tobt` para agrupar los reportes. Límite: el día de la semana se mira al momento de cobrar, así que «viernes 22:00 a 02:00» no rige el sábado a la 01:00.

## Cómo decide el evaluador

`evaluarPromociones({ lineas, promociones, ahora, zona })` es una función **pura** (sin base de datos ni reloj). `lineas`: `[{ id?, codigo, categoria?, cantidad, precio }]` (precio de **una** unidad, sin promociones).

**Hora propia de cada línea (5.42).** Una línea puede traer `ahora` (cuándo se pidió). Entonces vigencia, día y horario se miran **por unidad, a la hora de su línea**, y no a la hora global: un ítem pedido en el happy hour lo conserva aunque el pedido se recalcule después. En un `nxm` solo cuentan las unidades pedidas mientras regía; en un `combo`, tanto el disparador como el objetivo. Sin `ahora` en ninguna línea el comportamiento es el de siempre (solo entran las promociones vigentes en el `ahora` global). Un `ahora` que no es una fecha válida da `DATOS_INVALIDOS`.

1. Las líneas pasan a unidades sueltas (hasta 500): el descuento se reparte por unidad y cae en la línea que la tiene.
2. Se toman las promociones vigentes por `prioridad` (a igual prioridad, el orden de llegada).
3. Una unidad recibe **una sola promoción**, salvo que ambas sean `acumulable` (la segunda se calcula sobre lo que queda).
4. Todo en centavos enteros. Devuelve `{ momento, vigentes, lineas: [{ id, subtotalBase, descuento, subtotal, promociones }], aplicadas, totalBase, descuentoTotal, total }`.

Es determinista y no modifica sus entradas.

## Operaciones (`core.promociones`)

`listar`, `crear`, `editar` (con `actor = { usuarioId, permisos }`), `evaluar({ empresaId, lineas, ahora? })` (interna, sin actor: la usa un servicio con las promociones activas de la empresa) y `simular`.

## Permisos

`promocion:leer` (ver y simular) y `promocion:gestionar` (crear, editar, pausar). El administrador (`*`) los tiene; la plantilla de mesero no los necesita. Las rutas piden uno u otro por separado: un rol que gestione también debe poder leer (`promocion:*`).

## Rutas (montadas por el gateway en `/promociones`)

```js
const promociones = express.Router();
promociones.use(express.json());
core.promociones.montarRutas(promociones);
gateway.use("/promociones", promociones);
```

| Ruta | Permiso | |
|---|---|---|
| `GET /` | `promocion:leer` | `{ promociones }` |
| `POST /` | `promocion:gestionar` | crea → 201 |
| `PUT /:promocionId` | `promocion:gestionar` | cambia o pausa |
| `POST /simular` | `promocion:leer` | `{ items, ahora?, borrador?, soloBorrador? }` → el cálculo sobre un pedido de ejemplo; no escribe y no pide `x-requested-with` |

`simular` usa `items: [{ codigo, categoria?, cantidad, precio }]` (hasta 50 líneas), `ahora` ISO para probar un horario, y un `borrador` (promoción sin guardar) que se suma a las activas, o se evalúa solo con `soloBorrador`.

## Límites conocidos

- **No cambia ningún pedido.** Quien lo hace es el servicio (en `tobt`, 5.42).
- Sin topes, una promoción puede aplicarse sin límite de veces. `simular` solo aplica el tope por pedido (no mira ni toca los contadores).
- El catálogo de tipos es cerrado; uno nuevo es una entrada más en `validacion.js` y en el evaluador.
- `simular` y `evaluar` no comprueban que los códigos existan en el catálogo.

## Lo que ve el público (5.43)
`vigentes({ empresaId, ahora? })` (sin actor: lectura pública) devuelve `{ zona, hoy, promociones }` con las promociones **activas que aún no vencieron** (la fecha `hasta` incluida), cada una con los datos de su regla (`tipo`, `objetivo`, `disparador`, `n`, `m`, `efecto`, `valor`, `vigencia`, `dias`, `horario`) y `vigenteAhora` (día, horario y fechas, a la hora de la empresa). Las que empiezan más adelante salen con `vigenteAhora: false`. Nunca expone `prioridad`, `acumulable`, `topes` ni datos de quién la creó. La carta de `tobt` la usa para mostrar «Promociones» a los clientes.

## Topes de usos (5.44)
Un **uso** es una unidad con descuento (un 2x1 aplicado a 4 lattes son 2 usos). Campo opcional `topes: { diario, porPedido, porCliente }`, cada uno un entero 1–100000 o `null`:

- `porPedido`: máximo de unidades rebajadas en un mismo pedido. Lo resuelve el evaluador solo.
- `diario`: máximo en toda la empresa por día (día de la zona de la empresa).
- `porCliente`: máximo por cliente y por día. Un pedido **sin cliente** no recibe esta promoción (aviso `sin_cliente`).

Al evaluar, el evaluador recibe `cupos: { [idPromocion]: { max, motivo } }`, aplica el más chico y devuelve `topadas: [{ id, nombre, motivo }]` con lo que un tope frenó (`pedido`, `dia`, `cliente`, `sin_cliente`).

Contadores (`UsoPromocion`, `usos_promocion`) y reservas por pedido (`ReservaPromocion`, `reservas_promocion`), ambos con tenancy y TTL de 3 días. Flujo de un servicio cada vez que recalcula un pedido abierto:

1. `core.promociones.cupos({ empresaId, referencia, clienteId, ahora })` → cupos de lo que el pedido aún puede tomar (lo ya reservado por él + lo libre).
2. `evaluar({ …, cupos })`.
3. `confirmarUsos({ empresaId, referencia, clienteId, usos: { [id]: unidades }, ahora })` deja la reserva del pedido en esos usos. Cada contador se mueve con un `$inc` condicionado al tope, así dos pedidos simultáneos no se pasan; si no cabe devuelve `{ ok: false }` sin cambiar nada (se repite desde 1). Devuelve `previo` para restaurar si luego no se pudo guardar el pedido.
4. `liberarUsos({ empresaId, referencia })` al anular el pedido.

Reglas: la reserva fija su día en la primera vez (un pedido que cruza la medianoche sigue en su día); si el pedido cambia de cliente, el uso pasa de contador; bajar un tope no quita lo ya concedido; el uso se mantiene aunque el pedido se cobre (no se libera). `confirmarUsos` es idempotente.
