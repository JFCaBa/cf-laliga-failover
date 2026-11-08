import { POOL_RETENCION_MS, type EstadoFailover, type ModoDns, type TipoAlerta } from "./estado.js";
import type { ListaBloqueo } from "./lista.js";

/**
 * Máquina de estados pura del watchdog (pasos 3-6 y alertas).
 * Sin I/O y sin reloj: `ahora` llega como parámetro.
 *
 * - Dice qué haría (`accion`); no conoce `--cambiar-dns` ni `--apply`.
 * - No fija el modo destino ni `ultimoCambioEn` en `a-gris`/`a-naranja`: eso lo
 *   hace el orquestador tras verificar el cambio en la API. Excepciones:
 *   estado mixto, transición pendiente y gris sin historia fiable reinician
 *   `ultimoCambioEn = ahora` para que vuelva a correr la espera de 30 min.
 *   Una transición pendiente cuyo destino ya coincide con el modo real se da
 *   por completada (modo = modoDns) y después se evalúa la observación actual.
 * - Propone alertas deduplicadas (1 h) pero NO las marca: solo
 *   `marcarAlertaEnviada`, tras un envío correcto, actualiza `alertas[tipo]`.
 *   Las alertas `cambio` las emite el orquestador.
 * - Pool de la zona: Cloudflare contesta cada nombre de la zona con uno de
 *   varios juegos de IPs, al azar por consulta. La detección no mira la
 *   respuesta de esta ejecución sino el POOL (`estado.poolZona`): toda IP vista
 *   en el canario (siempre) o en apex/www (en naranja) en los últimos 7 días.
 *   Una sola IP del pool en la lista = bloqueado; una ejecución solo es limpia
 *   si ninguna IP del pool está en la lista.
 */

export interface Observacion {
  lista: ListaBloqueo;
  ipsCanario: string[];
  ipsSitio: string[];
  ipsTurnstile: string[] | null; // null = no se pudo resolver: no invalida la observación del sitio
}

export interface Alerta {
  tipo: TipoAlerta;
  asunto: string;
  texto: string;
}

export const LIMPIAS_PARA_NARANJA = 3;
export const ESPERA_MIN_NARANJA_MS = 30 * 60_000;
export const GRIS_SIN_DATOS_MS = 30 * 60_000;
export const FALLOS_PARA_ALERTA = 3;
export const DEDUP_ALERTA_MS = 60 * 60_000;

/** IP normalizada (cubre variantes de texto IPv6 en mayúsculas/espacios). */
function normIp(ip: string): string {
  return ip.trim().toLowerCase();
}

/**
 * Pool tras esta ejecución: añade/refresca `vistas` con `ahora` y poda las
 * entradas sin ver desde hace más de `POOL_RETENCION_MS` (o con fecha ilegible).
 */
export function actualizarPool(
  pool: Record<string, string>,
  vistas: string[],
  ahora: Date,
): Record<string, string> {
  const ahoraIso = ahora.toISOString();
  const s: Record<string, string> = {};
  for (const [ip, visto] of Object.entries(pool)) {
    const t = Date.parse(visto);
    if (!Number.isNaN(t) && ahora.getTime() - t <= POOL_RETENCION_MS) s[ip] = visto;
  }
  for (const ip of vistas) {
    const n = normIp(ip);
    if (n) s[n] = ahoraIso;
  }
  return s;
}

/** IPs del pool que están en la lista de bloqueo (ordenadas). */
export function ipsBloqueadasPool(pool: Record<string, string>, bl: ListaBloqueo): string[] {
  return Object.keys(pool)
    .filter((ip) => bl.contiene(ip))
    .sort();
}

function msDesde(iso: string | null, ahora: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : ahora.getTime() - t;
}

/** Dedup de alertas (1 h por tipo). Compartida con el orquestador. */
export function puedeAlertar(e: EstadoFailover, tipo: TipoAlerta, ahora: Date): boolean {
  const ms = msDesde(e.alertas[tipo] ?? null, ahora);
  return ms === null || ms >= DEDUP_ALERTA_MS;
}

export function decidir(e: {
  estado: EstadoFailover;
  ahora: Date;
  modoDns: ModoDns;
  observacion: Observacion | null;
}): { estado: EstadoFailover; accion: "a-gris" | "a-naranja" | null; alertas: Alerta[] } {
  const { ahora, modoDns, observacion } = e;
  const ahoraIso = ahora.toISOString();
  const s: EstadoFailover = {
    ...e.estado,
    transicion: e.estado.transicion ? { ...e.estado.transicion } : null,
    poolZona: { ...e.estado.poolZona },
    ipsTurnstile: [...e.estado.ipsTurnstile],
    alertas: { ...e.estado.alertas },
    ultimaEjecucionEn: ahoraIso,
  };
  const alertas: Alerta[] = [];
  const proponer = (a: Alerta) => {
    if (puedeAlertar(s, a.tipo, ahora)) alertas.push(a);
  };

  const modoGuardado = e.estado.modo;

  // ── Paso 3/4: observación ────────────────────────────────────────────────
  if (observacion) {
    const { lista: bl, ipsCanario, ipsSitio, ipsTurnstile } = observacion;
    // apex/www solo son IPs de Cloudflare en naranja (en gris resuelven al origen).
    s.poolZona = actualizarPool(
      s.poolZona,
      modoDns === "naranja" ? [...ipsCanario, ...ipsSitio] : ipsCanario,
      ahora,
    );
    s.sitioBloqueado = ipsBloqueadasPool(s.poolZona, bl).length > 0;

    if (ipsTurnstile !== null) {
      s.ipsTurnstile = [...ipsTurnstile];
      s.turnstileBloqueado = ipsTurnstile.some((ip) => bl.contiene(ip));
    }

    s.ultimaObservacionValidaEn = ahoraIso;
    s.fallosLecturaConsecutivos = 0;
    s.comprobacionesLimpias = s.sitioBloqueado ? 0 : s.comprobacionesLimpias + 1;
  } else {
    s.comprobacionesLimpias = 0;
    s.fallosLecturaConsecutivos += 1;
    if (s.fallosLecturaConsecutivos >= FALLOS_PARA_ALERTA) {
      proponer({
        tipo: "lectura",
        asunto: "[failover] No se puede leer la lista de bloqueo",
        texto:
          `${s.fallosLecturaConsecutivos} lecturas consecutivas fallidas de blocked-any.txt ` +
          "(red, HTTP, Content-Type o formato). Sin observación válida no se cambia de modo.\n" +
          `Última observación válida: ${s.ultimaObservacionValidaEn ?? "nunca"}`,
      });
    }
  }

  // ── Paso 6: decisión ─────────────────────────────────────────────────────
  // Transición pendiente cuyo destino ya es el modo real: los PATCH llegaron y
  // lo que falló fue la lectura de verificación. Se da por completada sin
  // tocar DNS (revertirla a gris sería deshacer un cambio correcto) y se sigue
  // evaluando la observación actual: naranja + bloqueo → a-gris en esta misma
  // ejecución. Nunca a-naranja: `ultimoCambioEn = ahora` reinicia la espera.
  if (modoDns !== "mixto" && s.transicion !== null && s.transicion.haciaModo === modoDns) {
    const t = s.transicion;
    s.transicion = null;
    s.modo = modoDns;
    s.ultimoCambioEn = ahoraIso;
    proponer({
      tipo: "mixto",
      asunto: "[failover] Transición completada tras verificación fallida",
      texto:
        `Quedó pendiente una transición hacia ${t.haciaModo} (iniciada ${t.iniciadaEn}) ` +
        `y los registros ya están en ${modoDns}: se da por completada tras una ` +
        "verificación fallida. No se toca DNS.",
    });
  }

  // Estado mixto o transición pendiente hacia otro modo: converger a gris (estado seguro).
  if (modoDns === "mixto" || s.transicion !== null) {
    if (modoDns !== "mixto") s.modo = modoDns;
    s.ultimoCambioEn = ahoraIso;
    s.comprobacionesLimpias = 0;
    proponer({
      tipo: "mixto",
      asunto:
        modoDns === "mixto"
          ? "[failover] Registros DNS en estado mixto"
          : "[failover] Transición incompleta",
      texto:
        modoDns === "mixto"
          ? "Unos registros gestionados están en gris y otros en naranja. Se converge a gris."
          : `Quedó pendiente una transición hacia ${s.transicion?.haciaModo} ` +
            `(iniciada ${s.transicion?.iniciadaEn}). Se converge a gris.`,
    });
    return { estado: s, accion: "a-gris", alertas };
  }

  s.modo = modoDns;

  if (modoDns === "naranja") {
    if (observacion && s.sitioBloqueado) {
      s.comprobacionesLimpias = 0;
      return { estado: s, accion: "a-gris", alertas };
    }
    return { estado: s, accion: null, alertas };
  }

  // Gris. Sin historia fiable de cuándo se entró en gris: la espera empieza ahora.
  if (modoGuardado !== "gris" || msDesde(s.ultimoCambioEn, ahora) === null) {
    s.ultimoCambioEn = ahoraIso;
  }

  if (!observacion) {
    const sinDatos = msDesde(s.ultimaObservacionValidaEn ?? s.ultimoCambioEn, ahora);
    if (sinDatos !== null && sinDatos > GRIS_SIN_DATOS_MS) {
      proponer({
        tipo: "gris-sin-datos",
        asunto: "[failover] PRIORITARIO: en gris sin datos de bloqueo",
        texto:
          `El sitio está en gris y no hay observación válida de la lista desde hace ` +
          `${Math.floor(sinDatos / 60_000)} min. No se vuelve a naranja a ciegas: decide a mano ` +
          "(ver README, «Salir a mano»).",
      });
    }
    return { estado: s, accion: null, alertas };
  }

  const enGris = msDesde(s.ultimoCambioEn, ahora) ?? 0;
  if (
    !s.sitioBloqueado &&
    s.comprobacionesLimpias >= LIMPIAS_PARA_NARANJA &&
    enGris >= ESPERA_MIN_NARANJA_MS
  ) {
    return { estado: s, accion: "a-naranja", alertas };
  }
  return { estado: s, accion: null, alertas };
}

/** Marca una alerta como enviada (llamar solo tras un envío correcto). */
export function marcarAlertaEnviada(
  e: EstadoFailover,
  alerta: { tipo: TipoAlerta },
  ahora: Date,
): EstadoFailover {
  return { ...e, alertas: { ...e.alertas, [alerta.tipo]: ahora.toISOString() } };
}
