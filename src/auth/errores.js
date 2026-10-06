// Errores de autenticación. `codigo` identifica el caso y `status` es el HTTP que le toca.
//   DATOS_INVALIDOS 400        CREDENCIALES_INVALIDAS 401   SIN_SESION 401
//   CSRF 403                   SIN_ACCESO_EMPRESA 403
//   EMPRESA_NO_SELECCIONADA 409                             DEMASIADOS_INTENTOS 429
const STATUS = {
  DATOS_INVALIDOS: 400,
  CREDENCIALES_INVALIDAS: 401,
  SIN_SESION: 401,
  CSRF: 403,
  SIN_ACCESO_EMPRESA: 403,
  EMPRESA_NO_SELECCIONADA: 409,
  DEMASIADOS_INTENTOS: 429,
};

export class ErrorAuth extends Error {
  constructor(codigo, mensaje, detalle) {
    super(mensaje);
    this.name = "ErrorAuth";
    this.codigo = codigo;
    this.status = STATUS[codigo] ?? 400;
    if (detalle !== undefined) this.detalle = detalle;
  }
}
