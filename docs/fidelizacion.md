# Fidelización: puntos (`core.fidelizacion`)

Libro de movimientos de **solo inserción** (`movimientos_puntos`, con tenancy): `{ clienteId, documentoCode, tipo: acumulo | canje | ajuste | vencimiento | bono (5.45), puntos (entero con signo, no 0), detalle, creadoPor, ts }`. El saldo es la suma de los movimientos. Índice único parcial `{ empresaId, documentoCode, tipo }` (solo con `documentoCode` texto): reprocesar un documento no suma dos veces.

## Cuándo acumula
El núcleo no sabe de pedidos: cada servicio declara su fuente.

```js
core.fidelizacion.registrarFuente({
  tipo: "pedido", estado: "pagado",
  extraer: (doc) => ({ clienteId, monto, detalle? }),
});
```
Un escucha de `core.documentos.on("estado")` llama a `acumularPorDocumento({ empresaId, code })` al llegar el documento a ese estado. También se puede llamar a mano (idempotente). Devuelve `{ acumulados, clienteId, saldo }`, `{ ..., yaRegistrado: true }` o `{ acumulados: 0, motivo }` con motivo `sin_regla`, `deshabilitada`, `sin_cliente`, `sin_monto`, `sin_puntos`, `cliente_no_encontrado`, `cliente_inactivo` o `sin_consentimiento`.

- **Solo con consentimiento** `programaPuntos` vigente. No es retroactivo: lo consumido antes de aceptar no da puntos.
- Puntos = `floor(monto × puntosPorUnidad)` calculado en centavos.
- Configuración por empresa (`Empresa.fidelizacion`): `{ habilitada, puntosPorUnidad }`; por defecto habilitada con 1 punto por unidad de moneda (**supuesto por confirmar**).

## Operaciones
`saldo`, `resumen({ empresaId, clienteId, limite })`, `canjear` (permiso `fidelizacion:canjear`, lo autoriza el personal), `ajustar` y `guardarConfig` (`fidelizacion:gestionar`), `leerConfig`, `manejadores.{puntos, canjear, ajustar}`. Rutas (en `/clientes`): `GET /:id/puntos` (`cliente:leer`), `POST /:id/puntos/canjear` (`{ puntos, detalle }`), `POST /:id/puntos/ajustar` (`fidelizacion:gestionar`, `{ puntos, detalle }`, 5.39). El ajuste es un movimiento `ajuste`: suma o resta al saldo, pero no cuenta como consumo (ni para nivel, ni para insignias, ni para retos). El motivo es obligatorio y no admite dejar el saldo en negativo. No tiene `documentoCode`, así que **no es idempotente**: enviarlo dos veces suma dos veces.

## Límites conocidos
- No hay vencimiento automático de los puntos.
- Un vale vencido sin usar **no devuelve** los puntos (el cliente puede cancelarlo antes, y entonces sí).
- Un vale aplicado a un ítem no se puede quitar: se anula el ítem y el vale queda gastado.
- `logros` lee todo el libro del cliente cada vez (suficiente a esta escala).
- El saldo ya no queda negativo con canjes simultáneos (se inserta, se vuelve a comprobar y, si hace falta, se revierte), pero con dos canjes a la vez puede fallar uno de más.

## Beneficios y vales (5.30)
Colecciones `beneficios` y `tickets` (con tenancy).

- **Beneficio** (lo define la empresa, `fidelizacion:gestionar`): `{ nombre, descripcion, puntos, tipo, valor, itemCodigo, vigenciaDias, activo }`. Tipos: `descuento_porcentaje` (valor 1–100), `descuento_monto` (valor > 0, 2 decimales) e `item_gratis` (`itemCodigo`: el plato del catálogo; descuenta UNA unidad).
- **Vale (ticket)**: lo emite el cliente desde su cuenta (`tickets.emitirMio`, exige consentimiento de puntos) o el personal por él (`tickets.emitir`, `fidelizacion:canjear`). Al emitir se descuentan los puntos y el vale lleva una **copia** del beneficio y un código de 6 caracteres (sin I, L, O, 0, 1). Vigencia en días desde que se emite.
- **Consumo**: `tickets.consultar` (mirar sin gastar) y `tickets.consumir` (de `activo` a `usado` con una actualización atómica: con el mismo código en dos cajas gana una). `tickets.liberar` lo deja activo si no se llegó a aplicar. `tickets.cancelarMio`: el cliente cancela un vale activo y recupera los puntos.
- `tickets.calcularDescuento(beneficio, item)` (también exportada como `calcularDescuento`): descuento en centavos enteros, nunca más que el subtotal del ítem.
- Rutas (en `/clientes`): `GET/POST /beneficios`, `PUT /beneficios/:id`, `GET/PUT /fidelizacion/config`, `GET /tickets/:codigo`, `POST /:clienteId/tickets`.

## Niveles e insignias (5.30)
Se calculan siempre desde el libro (`resumen().logros`, `logros()`); no se guarda nada aparte.

- **Puntos acumulados** = suma de los movimientos `acumulo`. No bajan al canjear; los ajustes y las devoluciones no cuentan.
- **Niveles**: `Empresa.fidelizacion.niveles = [{ nombre, desde }]` (hasta 10, de menor a mayor). `nivelDe` da el actual, el siguiente, lo que falta y el progreso. Sin niveles: `nivel: null`.
- **Insignias** (catálogo fijo en `logros.js`): primer consumo, 10 y 25 consumos, 100/500/1.000/5.000 puntos, primer canje y 6 meses desde el primer consumo. Cada una trae `obtenida`, `obtenidaTs` (el momento en que se cumplió) y `actual`/`meta`.

## Retos de colección (5.31)
«Prueba todo lo de una categoría de la carta y gana esto» (por ejemplo, cada café). Colección `retos` (con tenancy); el avance se calcula desde el libro, sin guardar nada aparte.

- **Reto** (`fidelizacion:gestionar`): `{ nombre, descripcion, categoria, tipo, valor, itemCodigo, vigenciaDias, activo }`. El premio se valida igual que un beneficio (mismos tipos) pero **no cuesta puntos**.
- **Qué cuenta:** cada movimiento `acumulo` guarda `itemCodigo`, el plato del catálogo que se pagó (el servicio lo devuelve en `extraer`; las líneas libres no). El reto pide haber pagado **cada ítem activo de la categoría** (`catalogo.listar`, hasta 200). Repetir un plato no suma; un ítem retirado de la carta ya no se exige; un ítem nuevo sí.
- **Emisión automática:** al acumular los puntos de un ítem (`acumularPorDocumento`), `retos.evaluar` emite el vale de cada reto activo que el cliente acaba de completar (`origen: "reto"`, `puntos: 0`, copia del premio). Es **una sola vez por cliente y reto**: índice único parcial `{ empresaId, clienteId, retoId }` en `tickets`. Solo si el programa está activo y el cliente mantiene el consentimiento. Un fallo al evaluar no impide acumular: el siguiente pago lo reintenta.
- **Vale del reto:** se consulta y se consume como cualquier vale. El cliente **no lo puede cancelar** (no costó puntos). `ticketDto.origen` es `"reto"` o `"canje"`.
- **Avance:** `retos.progreso({ empresaId, clienteId })` (y `resumen().retos`): por reto, `{ id, nombre, descripcion, categoria, texto, total, logrados, faltan: [{ codigo, nombre }], completo, vale }`. Un reto ya ganado sigue «completo» aunque la carta cambie después.
- Operaciones: `retos.{listar, crear, editar, progreso, evaluar}`. Rutas (en `/clientes`): `GET /retos` (`fidelizacion:canjear`), `POST /retos`, `PUT /retos/:retoId` (`fidelizacion:gestionar`).
- **Límites:** solo cuentan los consumos pagados desde 5.31 (los movimientos anteriores no guardan el plato); el reto es por categoría, no por lista de ítems; si el reto se crea cuando el cliente ya lo había completado, el vale sale en su siguiente pago.
