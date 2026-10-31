// Errores de autenticación. `codigo` identifica el caso y `status` es el HTTP que le toca.
//   DATOS_INVALIDOS 400        CREDENCIALES_INVALIDAS 401   SIN_SESION 401
//   CSRF 403                   SIN_ACCESO_EMPRESA 403
//   EMPRESA_NO_SELECCIONADA 409                             DEMASIADOS_INTENTOS 429
// PIN y dispositivos:
//   PIN_INVALIDO 400   CODIGO_INVALIDO 401   DISPOSITIVO_INVALIDO 401   PIN_INCORRECTO 401
//   PIN_NO_HABILITADO 403   NO_ENCONTRADO 404   PIN_BLOQUEADO 423
// Entrar con Google (5.51):
//   GOOGLE_INVALIDO 401   GOOGLE_NO_DISPONIBLE 503 (no está configurado o Google no responde)
//   GOOGLE_SIN_CUENTA 403 (5.69: el personal no tiene una cuenta activa con ese correo; un solo error para todos los casos)
// Contraseña temporal:
//   CAMBIO_PASSWORD_REQUERIDO 403   SESION_NO_PERMITIDA 403   SIN_PASSWORD 409 (la cuenta entra con Google)
const STATUS = {
  DATOS_INVALIDOS: 400,
  CREDENCIALES_INVALIDAS: 401,
  SIN_SESION: 401,
  CSRF: 403,
  SIN_ACCESO_EMPRESA: 403,
  EMPRESA_NO_SELECCIONADA: 409,
  DEMASIADOS_INTENTOS: 429,
  PIN_INVALIDO: 400,
  CODIGO_INVALIDO: 401,
  DISPOSITIVO_INVALIDO: 401,
  PIN_INCORRECTO: 401,
  PIN_NO_HABILITADO: 403,
  NO_ENCONTRADO: 404,
  PIN_BLOQUEADO: 423,
  CAMBIO_PASSWORD_REQUERIDO: 403,
  SESION_NO_PERMITIDA: 403,
  GOOGLE_INVALIDO: 401,
  GOOGLE_NO_DISPONIBLE: 503,
  GOOGLE_SIN_CUENTA: 403,
  SIN_PASSWORD: 409,
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
