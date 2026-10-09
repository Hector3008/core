// Errores del catálogo. `codigo` identifica el caso y `status` es el HTTP que le toca.
//   DATOS_INVALIDOS 400   ESQUEMA_INVALIDO 400   IMPORTACION_INVALIDA 400 (trae `detalle: { total, errores }`)
//   PERMISO_INSUFICIENTE 403
//   NO_ENCONTRADO 404
//   ITEM_DUPLICADO 409 (trae `detalle: { campo, itemId }`)   ESTADO_INVALIDO 409
//   ITEM_NO_DISPONIBLE 409 (trae `detalle: { noEncontrados, inactivos }`)
//   CODIGO_EN_CATALOGO 409 (trae `detalle: { codigos }`): una línea libre usa el código de un ítem del catálogo
const STATUS = {
  DATOS_INVALIDOS: 400,
  ESQUEMA_INVALIDO: 400,
  IMPORTACION_INVALIDA: 400,
  PERMISO_INSUFICIENTE: 403,
  NO_ENCONTRADO: 404,
  ITEM_DUPLICADO: 409,
  ESTADO_INVALIDO: 409,
  ITEM_NO_DISPONIBLE: 409,
  CODIGO_EN_CATALOGO: 409,
};

export class ErrorCatalogo extends Error {
  constructor(codigo, mensaje, detalle) {
    super(mensaje);
    this.name = "ErrorCatalogo";
    this.codigo = codigo;
    this.status = STATUS[codigo] ?? 400;
    if (detalle) this.detalle = detalle;
  }
}
