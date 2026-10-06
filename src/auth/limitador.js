/**
 * Limitador de intentos fallidos en memoria (ventana fija).
 * Tras `max` fallos dentro de `ventanaMs`, la clave queda bloqueada hasta que termine la ventana.
 * Límite conocido: vive en la memoria del proceso; se reinicia al reiniciar el servidor y no se
 * comparte entre varias instancias. Para un solo gateway alcanza.
 */
export function crearLimitador({ max, ventanaMs, ahora = Date.now }) {
  const mapa = new Map(); // clave -> { n, desde }

  const podar = (t) => {
    if (mapa.size < 5000) return;
    for (const [k, e] of mapa) if (t - e.desde >= ventanaMs) mapa.delete(k);
  };

  return {
    /** Segundos que faltan para poder reintentar; 0 si no está bloqueada. */
    espera(clave) {
      const t = ahora();
      const e = mapa.get(clave);
      if (!e || t - e.desde >= ventanaMs) return 0;
      return e.n >= max ? Math.ceil((e.desde + ventanaMs - t) / 1000) : 0;
    },
    fallo(clave) {
      const t = ahora();
      podar(t);
      const e = mapa.get(clave);
      if (!e || t - e.desde >= ventanaMs) mapa.set(clave, { n: 1, desde: t });
      else e.n += 1;
    },
    exito(clave) {
      mapa.delete(clave);
    },
  };
}
