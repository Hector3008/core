// Errores de las solicitudes de empresa. `codigo` identifica el caso y `status` es el HTTP que le toca.
//   DATOS_INVALIDOS 400 (trae `detalle: { campos: { campo: mensaje } }`)   SLUG_OCUPADO 409
//   ENLACE_INVALIDO 404   ENLACE_VENCIDO 410   ESTADO_INVALIDO 409   CUENTA_SUSPENDIDA 409
//   DEMASIADAS_SOLICITUDES 429   SERVICIO_NO_DISPONIBLE 409
const STATUS = {
  DATOS_INVALIDOS: 400,
  SLUG_OCUPADO: 409,
  ENLACE_INVALIDO: 404,
  ENLACE_VENCIDO: 410,
  ESTADO_INVALIDO: 409,
  CUENTA_SUSPENDIDA: 409,
  DEMASIADAS_SOLICITUDES: 429,
  SERVICIO_NO_DISPONIBLE: 409,
};

export class ErrorSolicitud extends Error {
  constructor(codigo, mensaje, detalle) {
    super(mensaje);
    this.name = "ErrorSolicitud";
    this.codigo = codigo;
    this.status = STATUS[codigo] ?? 400;
    if (detalle) this.detalle = detalle;
  }
}
