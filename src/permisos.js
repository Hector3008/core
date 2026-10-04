// "*" todo · "documento:*" todo el recurso · "documento:crear" exacto
export function permite(permisos, requerido) {
  const [recurso] = requerido.split(":");
  return permisos.some(
    (p) => p === "*" || p === requerido || p === `${recurso}:*`,
  );
}
