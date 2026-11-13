// Errores del kardex (5.75). `codigo` identifica el caso y `status` es el HTTP que le toca.
//   DATOS_INVALIDOS 400   PERMISO_INSUFICIENTE 403   NO_ENCONTRADO 404
//   INSUMO_DUPLICADO 409 (ya hay un insumo con ese código)   ESTADO_INVALIDO 409   CONFLICTO 409 (demasiados cambios a la vez)
const STATUS = {
  DATOS_INVALIDOS: 400,
  PERMISO_INSUFICIENTE: 403,
  NO_ENCONTRADO: 404,
  INSUMO_DUPLICADO: 409,
  ESTADO_INVALIDO: 409,
  CONFLICTO: 409,
};

export class ErrorKardex extends Error {
  constructor(codigo, mensaje, detalle) {
    super(mensaje);
    this.name = "ErrorKardex";
    this.codigo = codigo;
    this.status = STATUS[codigo] ?? 400;
    if (detalle) this.detalle = detalle;
  }
}
