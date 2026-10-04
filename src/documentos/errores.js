// Errores del motor de documentos. `codigo` permite a las rutas decidir el HTTP:
//   DOCUMENTO_NO_ENCONTRADO → 404      CONFLICTO_VERSION → 409
//   PERMISO_INSUFICIENTE    → 403      el resto           → 400
export class ErrorDocumento extends Error {
  constructor(codigo, mensaje, detalle) {
    super(mensaje);
    this.name = "ErrorDocumento";
    this.codigo = codigo;
    if (detalle !== undefined) this.detalle = detalle;
  }
}
