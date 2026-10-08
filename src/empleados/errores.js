// Errores de la gestión de empleados. `codigo` identifica el caso y `status` es el HTTP que le toca.
//   DATOS_INVALIDOS 400   PERMISO_INVALIDO 400
//   SIN_ALCANCE 403       ROL_PROTEGIDO 403
//   NO_ENCONTRADO 404
//   YA_ES_MIEMBRO 409     ROL_DUPLICADO 409   ROL_EN_USO 409   ULTIMO_ADMIN 409
//   COMPARTIDO 409        ESTADO_INVALIDO 409
const STATUS = {
  DATOS_INVALIDOS: 400,
  PERMISO_INVALIDO: 400,
  SIN_ALCANCE: 403,
  ROL_PROTEGIDO: 403,
  NO_ENCONTRADO: 404,
  YA_ES_MIEMBRO: 409,
  ROL_DUPLICADO: 409,
  ROL_EN_USO: 409,
  ULTIMO_ADMIN: 409,
  COMPARTIDO: 409,
  ESTADO_INVALIDO: 409,
};

export class ErrorEmpleado extends Error {
  constructor(codigo, mensaje) {
    super(mensaje);
    this.name = "ErrorEmpleado";
    this.codigo = codigo;
    this.status = STATUS[codigo] ?? 400;
  }
}
