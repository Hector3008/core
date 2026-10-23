// Zona horaria de una empresa (5.40). Las promociones se leen por día de la semana y por horario («happy hour de
// 18:00 a 20:00»): hay que mirarlos en la hora de la empresa, no en la del servidor.
//
// País (ISO de 2 letras) → zona horaria. Un país con varias zonas usa la de su capital; uno que no está aquí cae en UTC.
// Una empresa puede fijar la suya (`Empresa.zonaHoraria`, un nombre IANA como `America/Lima`), que manda sobre el país.
// La misma tabla que usa `tobt` para agrupar los reportes por día.
export const ZONAS = Object.freeze({
  PE: "America/Lima",
  EC: "America/Guayaquil",
  CO: "America/Bogota",
  BO: "America/La_Paz",
  CL: "America/Santiago",
  AR: "America/Argentina/Buenos_Aires",
  UY: "America/Montevideo",
  PY: "America/Asuncion",
  MX: "America/Mexico_City",
  ES: "Europe/Madrid",
  US: "America/New_York",
});

/** ¿Es un nombre de zona que el entorno conoce? («America/Lima» sí; «Lima» o «UTC-5» no.) */
export function zonaValida(zona) {
  if (typeof zona !== "string" || !zona.trim() || zona.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zona.trim() });
    return true;
  } catch {
    return false;
  }
}

/** La zona de una empresa: la que fijó, si no la de su país, si no UTC. */
export function zonaDeEmpresa(empresa) {
  const fijada = empresa?.zonaHoraria;
  if (fijada && zonaValida(fijada)) return fijada.trim();
  return ZONAS[String(empresa?.pais ?? "PE").toUpperCase()] ?? "UTC";
}

const DIAS_EN = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Un instante visto en una zona: { fecha: "YYYY-MM-DD", dia: 0 (domingo) a 6, minutos: desde las 00:00 }. */
export function momentoLocal(ahora, zona) {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: zona,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(ahora);
  const p = Object.fromEntries(partes.map((x) => [x.type, x.value]));
  return {
    fecha: `${p.year}-${p.month}-${p.day}`,
    dia: DIAS_EN[p.weekday],
    minutos: Number(p.hour) * 60 + Number(p.minute),
  };
}
