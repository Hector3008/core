// Errores de las promociones (5.40). `codigo` identifica el caso y `status` es el HTTP que le toca.
//   DATOS_INVALIDOS 400   PERMISO_INSUFICIENTE 403   NO_ENCONTRADO 404
//   LIMITE_ALCANZADO 409 (ya hay 100 promociones activas)   ESTADO_INVALIDO 409
const STATUS = {
  DATOS_INVALIDOS: 400,
  PERMISO_INSUFICIENTE: 403,
  NO_ENCONTRADO: 404,
  LIMITE_ALCANZADO: 409,
  ESTADO_INVALIDO: 409,
};

export class ErrorPromocion extends Error {
  constructor(codigo, mensaje, detalle) {
    super(mensaje);
    this.name = "ErrorPromocion";
    this.codigo = codigo;
    this.status = STATUS[codigo] ?? 400;
    if (detalle) this.detalle = detalle;
  }
}
