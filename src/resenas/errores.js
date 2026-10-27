// Errores de las reseñas (5.62). `codigo` identifica el caso y `status` es el HTTP que le toca.
//   DATOS_INVALIDOS 400   PERMISO_INSUFICIENTE 403   NO_PERMITIDO 403 (el cliente no pidió ni pagó ese plato)
//   NO_ENCONTRADO 404     ESTADO_INVALIDO 409 (reseñas sin configurar o acción que no corresponde)
const STATUS = {
  DATOS_INVALIDOS: 400,
  PERMISO_INSUFICIENTE: 403,
  NO_PERMITIDO: 403,
  NO_ENCONTRADO: 404,
  ESTADO_INVALIDO: 409,
};

export class ErrorResena extends Error {
  constructor(codigo, mensaje, detalle) {
    super(mensaje);
    this.name = "ErrorResena";
    this.codigo = codigo;
    this.status = STATUS[codigo] ?? 400;
    if (detalle) this.detalle = detalle;
  }
}
