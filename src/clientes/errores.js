// Errores de la gestión de clientes. `codigo` identifica el caso y `status` es el HTTP que le toca.
//   DATOS_INVALIDOS 400
//   PERMISO_INSUFICIENTE 403
//   NO_ENCONTRADO 404
//   CLIENTE_DUPLICADO 409 (trae `detalle: { campo, clienteId }`)   ESTADO_INVALIDO 409
const STATUS = {
  DATOS_INVALIDOS: 400,
  PERMISO_INSUFICIENTE: 403,
  NO_ENCONTRADO: 404,
  CLIENTE_DUPLICADO: 409,
  ESTADO_INVALIDO: 409,
};

export class ErrorCliente extends Error {
  constructor(codigo, mensaje, detalle) {
    super(mensaje);
    this.name = "ErrorCliente";
    this.codigo = codigo;
    this.status = STATUS[codigo] ?? 400;
    if (detalle) this.detalle = detalle;
  }
}
