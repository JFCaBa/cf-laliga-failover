/**
 * Estado persistido del watchdog de failover Cloudflare/LaLiga.
 * Se guarda como JSON en el directorio de estado; aquí solo el tipo y el inicial.
 */

/** Modo real de los registros gestionados, leído de la API de Cloudflare. */
export type ModoDns = "naranja" | "gris" | "mixto";

export type TipoAlerta = "cambio" | "lectura" | "api" | "gris-sin-datos" | "mixto";

export interface EstadoFailover {
  version: 1;
  modo: "naranja" | "gris" | "desconocido";
  transicion: { haciaModo: "naranja" | "gris"; iniciadaEn: string } | null;
  sitioBloqueado: boolean;
  turnstileBloqueado: boolean;
  comprobacionesLimpias: number;
  fallosLecturaConsecutivos: number;
  fallosApiConsecutivos: number;
  ultimaEjecucionEn: string | null;
  ultimaObservacionValidaEn: string | null;
  ultimoCambioEn: string | null;
  /**
   * Pool de IPs de Cloudflare de la zona: ip → ISO de la última vez vista (en el
   * canario siempre; en apex/www mientras están en naranja). Cloudflare reparte
   * los nombres de la zona entre varios juegos de IPs y cada respuesta enseña
   * solo uno: la detección mira el pool entero, no la respuesta de esta
   * ejecución. Se podan las entradas sin ver desde hace más de
   * `POOL_RETENCION_MS`. Ausente en estados antiguos: `leerEstado` lo completa.
   */
  poolZona: Record<string, string>;
  ipsTurnstile: string[];
  alertas: Partial<Record<TipoAlerta, string>>; // ISO de la última alerta enviada
  /** Emails de `cambio` cuyo envío falló: se reintentan en cada ejecución aplicada. */
  alertasPendientes: AlertaPendiente[];
}

export interface AlertaPendiente {
  tipo: TipoAlerta; // en la práctica solo se encola `cambio`
  asunto: string;
  texto: string;
}

/** Una IP del pool sin ver durante más de esto se poda (7 días). */
export const POOL_RETENCION_MS = 7 * 24 * 3600 * 1000;

/** Tope de alertas pendientes guardadas (se conservan las más recientes). */
export const MAX_ALERTAS_PENDIENTES = 10;

/** Sin historia (fichero ausente): el modo se aprende de la API. */
export function estadoInicial(): EstadoFailover {
  return {
    version: 1,
    modo: "desconocido",
    transicion: null,
    sitioBloqueado: false,
    turnstileBloqueado: false,
    comprobacionesLimpias: 0,
    fallosLecturaConsecutivos: 0,
    fallosApiConsecutivos: 0,
    ultimaEjecucionEn: null,
    ultimaObservacionValidaEn: null,
    ultimoCambioEn: null,
    poolZona: {},
    ipsTurnstile: [],
    alertas: {},
    alertasPendientes: [],
  };
}
