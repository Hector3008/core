// Errores de los anuncios (5.48). `codigo` identifica el caso y `status` es el HTTP que le toca.
//   DATOS_INVALIDOS 400   PERMISO_INSUFICIENTE 403   NO_ENCONTRADO 404   LIMITE_ALCANZADO 409 (ya hay 50 anuncios activos)
const STATUS = {
  DATOS_INVALIDOS: 400,
  PERMISO_INSUFICIENTE: 403,
  NO_ENCONTRADO: 404,
  LIMITE_ALCANZADO: 409,
};

export class ErrorAnuncio extends Error {
  constructor(codigo, mensaje, detalle) {
    super(mensaje);
    this.name = "ErrorAnuncio";
    this.codigo = codigo;
    this.status = STATUS[codigo] ?? 400;
    if (detalle) this.detalle = detalle;
  }
}
