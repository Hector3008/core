# Fidelización: puntos (`core.fidelizacion`)

Libro de movimientos de **solo inserción** (`movimientos_puntos`, con tenancy): `{ clienteId, documentoCode, tipo: acumulo | canje | ajuste | vencimiento, puntos (entero con signo, no 0), detalle, creadoPor, ts }`. El saldo es la suma de los movimientos. Índice único parcial `{ empresaId, documentoCode, tipo }` (solo con `documentoCode` texto): reprocesar un documento no suma dos veces.

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
`saldo`, `resumen({ empresaId, clienteId, limite })`, `canjear` (permiso `fidelizacion:canjear`, lo autoriza el personal), `ajustar` y `guardarConfig` (`fidelizacion:gestionar`), `leerConfig`, `manejadores.{puntos, canjear}`. Rutas (en `/clientes`): `GET /:id/puntos` (`cliente:leer`), `POST /:id/puntos/canjear` (`{ puntos, detalle }`).

## Límites conocidos
La comprobación de saldo en un canje no es atómica (dos canjes simultáneos podrían dejar el saldo negativo); no hay vencimiento automático ni catálogo de beneficios (el canje solo descuenta puntos).
