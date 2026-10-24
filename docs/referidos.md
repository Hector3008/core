# Referidos (`core.referidos`, 5.45)

«Trae a un amigo y los dos ganan puntos.» La recompensa son **puntos** (movimientos `bono` en el libro de fidelización), no dinero ni vales.

## Reglas (configurables, `PUT /clientes/fidelizacion/config { referidos: {…} }`)
| campo | por defecto | qué hace |
|---|---|---|
| `habilitada` | `false` | el programa está apagado hasta que la empresa lo active |
| `puntosReferente` | 50 | puntos para quien refiere (0 = nada) |
| `puntosReferido` | 25 | puntos para el amigo (0 = nada) |
| `consumoMinimo` | 0 | monto mínimo del pago para premiar (0 = ninguno); un pago menor deja el referido pendiente y el siguiente que llegue premia |
| `maxPorCliente` | 20 | referidos premiados por cliente; al pasar el tope el referido queda `sin_cupo` y nadie gana |
| `cuentaParaNiveles` | `true` | los `bono` suman al acumulado de niveles e insignias de puntos (nunca cuentan como consumos ni avanzan retos) |

## Flujo
1. Cada cliente tiene un **código** (7 caracteres sin 0/O/1/I), único por empresa; se crea la primera vez que se pide (`codigoDe`, `mio`).
2. Una **ficha nueva** se vincula a quien la refirió: al registrarse (`registrar({ codigoReferido })`; un código inválido se rechaza antes de crear nada y, con el programa apagado, se ignora) o porque el personal lo anota (`POST /clientes/:id/referente { codigo }`, permiso `cliente:editar`).
   - Solo fichas nuevas: sin referente anterior (índice único `{empresaId, referidoId}`) y sin ningún consumo que haya dado puntos. Nadie se refiere a sí mismo; el referente debe estar activo.
3. En el **primer pago** del referido que dé puntos (`fidelizacion.alAcumular`), si llega al mínimo y hay cupo, los dos reciben su `bono` y el referido pasa a `premiado`. Si quien refirió no tiene `programaPuntos`, solo gana el referido (queda `puntosReferente: 0`).
4. Idempotente: cada premio usa la clave `referido:<id>:referente|referido` como `documentoCode` del libro; reprocesar o reintentar tras un corte no duplica. Un fallo del observador no rompe la acumulación del pago.

## API
`codigoDe`, `buscarPorCodigo`, `vincular({ empresaId, referidoId, codigo, origen, creadoPor })`, `mio({ empresaId, clienteId })` (código, reglas, cupo y nombres abreviados «Beto R.»), `listar({ empresaId, estado, limite, saltar })`, `config`.
Rutas en `/clientes`: `GET /referidos` (`fidelizacion:gestionar`, `{ total, resumen, referidos }`), `GET /:id/referidos` (`cliente:leer`), `POST /:id/referente`. La cuenta del cliente (`yo`) trae `referidos` (lo mismo que `mio`).

## Límites conocidos
- Con dos referidos del mismo cliente pagando a la vez, el tope puede excederse en uno (el conteo no es transaccional).
- El mínimo se compara con el monto del pago, no con lo acumulado en varios pagos.
- Anonimizar a un cliente libera su código; sus referidos premiados quedan en la lista con el nombre anonimizado.
