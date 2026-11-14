# Kardex (5.75)

Libro de movimientos de insumos con saldo y costo promedio. Módulo `src/kardex/`. El núcleo no conoce recetas ni pedidos: guarda insumos, movimientos y saldos; el servicio (tobt, 5.76) decide qué plato gasta qué insumo y llama a `consumirVarios` / `revertir`.

## Unidades y presentaciones
- Cada insumo tiene una **unidad base** (g, ml, unidad…). Todo el kardex se guarda en esa unidad. No cambia nunca (ni el código).
- Tiene hasta 10 **presentaciones** con su equivalencia: café `paquete`=500 g; leche `caja`=1000 ml, `bidón`=5000 ml; huevo `docena`=12 unidad.
- Al registrar se puede escribir en una presentación: «3 paquetes a 40» → 1500 g a 0,08 el gramo. O dar `costoTotal` en lugar de `costo`.
- Cantidades: máximo 3 decimales. Costos: máximo 6.

## Movimientos (libro solo de inserción)
| tipo | signo | costo | quién |
|---|---|---|---|
| `inventario_inicial` | + | el indicado; solo si el insumo no tiene movimientos | `kardex:gestionar` |
| `compra` | + | el indicado; recalcula el promedio | `kardex:registrar` |
| `merma` | − | promedio vigente; motivo obligatorio | `kardex:registrar` |
| `ajuste` (conteo físico) | ± | promedio vigente; motivo obligatorio; la diferencia se calcula sola | `kardex:gestionar` |
| `consumo` | − | promedio vigente | el servicio, sin actor |
| `reversa` | + | el costo con que salió el consumo | el servicio, sin actor |
| `anulacion` | ± | el costo con que se hizo el movimiento que anula; motivo obligatorio | `kardex:gestionar` |

Costo promedio ponderado: las entradas lo recalculan (si no había existencia, pasa a ser el costo de la entrada); las salidas no lo cambian. **Nunca bloquea**: un consumo que deja el saldo en negativo se registra y se informa (`negativo`, `bajoMinimo`).

## Corregir un movimiento (5.84)
El libro no se edita. Para corregir una compra, merma, ajuste o saldo inicial mal puesto se **anula** (`POST /kardex/movimientos/:movimientoId/anular` con `{ detalle }`, `kardex:gestionar`) y se registra de nuevo el correcto. La anulación es otro movimiento de signo contrario al mismo costo: si el original entró, se quita su valor del inventario y el promedio vuelve a lo que era sin él; si salió, vuelve a entrar al costo con que salió. El original queda en el libro marcado `anulado` (`GET /movimientos` lo informa). Un movimiento se anula una sola vez; no se anula una anulación; un consumo se devuelve anulando el ítem del pedido. Si la anulación deja el saldo en negativo se registra igual y se avisa.

## Seguridad de los datos
- Cada insumo lleva su cuenta con `secuencia` 1, 2, 3… El índice único `{insumo, secuencia}` ordena lo simultáneo: el que llega segundo reintenta con el saldo nuevo (hasta 8 veces, luego `CONFLICTO`).
- Índice único `{insumo, referencia, tipo}`: un documento consume (o revierte) una sola vez por insumo. Repetir devuelve `yaRegistrado`.
- `existencia` y `costoPromedio` en el insumo son una copia; la verdad es el libro. `repararSaldo` la rehace.
- Los movimientos no se editan ni se borran (los hooks lo impiden).

## API del núcleo
```
core.kardex.crearInsumo / editarInsumo / obtenerInsumo / listarInsumos   kardex:gestionar (leer: leer)
core.kardex.inventarioInicial / contar / repararSaldo                    kardex:gestionar
core.kardex.registrarCompra / registrarMerma                             kardex:registrar
core.kardex.anularMovimiento                                          kardex:gestionar
core.kardex.movimientos / valorizacion                                   kardex:leer
core.kardex.consumirVarios({ empresaId, referencia, lineas:[{insumoId, cantidad}] }) → { aplicados, yaRegistrados, errores }
core.kardex.revertir({ empresaId, referencia, detalle })                 → { aplicados, yaRegistrados, errores }
```
Máximo 2000 insumos por empresa. Colecciones: `kardex_insumos`, `kardex_movimientos`.

## Rutas (el gateway las monta en `/kardex`)
```js
const kardex = express.Router();
kardex.use(express.json());
core.kardex.montarRutas(kardex);
gateway.use("/kardex", kardex);
```
`GET/POST /insumos`, `GET/PUT /insumos/:insumoId`, `POST /insumos/:insumoId/{inicial,compra,merma,conteo,reparar}`, `POST /movimientos/:movimientoId/anular`, `GET /movimientos`, `GET /valorizacion`. Escrituras con cabecera CSRF.

Índices: Mongoose los crea al arrancar (`autoIndex`) o con `Modelo.syncIndexes()`; no hace falta migración.
