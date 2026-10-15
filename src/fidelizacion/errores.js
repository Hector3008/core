// Errores de la fidelización (puntos). `codigo` identifica el caso y `status` es el HTTP que le toca.
//   DATOS_INVALIDOS 400   PERMISO_INSUFICIENTE 403   NO_ENCONTRADO 404
//   SALDO_INSUFICIENTE 409   ESTADO_INVALIDO 409
const STATUS = {
  DATOS_INVALIDOS: 400,
  PERMISO_INSUFICIENTE: 403,
  NO_ENCONTRADO: 404,
  SALDO_INSUFICIENTE: 409,
  ESTADO_INVALIDO: 409,
};

export class ErrorFidelizacion extends Error {
  constructor(codigo, mensaje, detalle) {
    super(mensaje);
    this.name = "ErrorFidelizacion";
    this.codigo = codigo;
    this.status = STATUS[codigo] ?? 400;
    if (detalle) this.detalle = detalle;
  }
}
