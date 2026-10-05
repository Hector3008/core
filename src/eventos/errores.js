// Errores de eventos. `codigo` permite a las rutas decidir el HTTP:
//   EVENTO_INVALIDO → 400    LOTE_INVALIDO → 400    SOLO_INSERCION → (error de programación)
export class ErrorEvento extends Error {
  constructor(codigo, mensaje, detalle) {
    super(mensaje);
    this.name = "ErrorEvento";
    this.codigo = codigo;
    if (detalle !== undefined) this.detalle = detalle;
  }
}
