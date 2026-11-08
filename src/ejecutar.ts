import {
  ErrorCloudflare,
  ErrorConfiguracion,
  modoDns as calcularModoDns,
  validarRegistros,
  type ClienteCloudflare,
  type RegistroDns,
} from "./cloudflare-api.js";
import {
  decidir,
  FALLOS_PARA_ALERTA,
  ipsBloqueadasPool,
  marcarAlertaEnviada,
  puedeAlertar,
  type Alerta,
  type Observacion,
} from "./decidir.js";
import {
  MAX_ALERTAS_PENDIENTES,
  type AlertaPendiente,
  type EstadoFailover,
  type ModoDns,
} from "./estado.js";
import type { ListaBloqueo } from "./lista.js";

/**
 * Orquestador de una ejecución del watchdog (pasos 1-7).
 * Todo el I/O llega inyectado; el reloj es `deps.ahora()`.
 */
export interface DepsVigilancia {
  ahora: () => Date;
  leerEstado: () => Promise<EstadoFailover>;
  escribirEstado: (e: EstadoFailover) => Promise<void>;
  cloudflare: ClienteCloudflare;
  nombres: string[]; // registros gestionados
  resolver: (nombre: string) => Promise<string[]>; // ya ligado a su zona
  canario: string;
  turnstileHost: string;
  leerLista: () => Promise<ListaBloqueo | null>;
  enviarAlerta: (a: Alerta) => Promise<void>;
  ping: (resultado: "ok" | "fail") => Promise<void>;
  log: (msg: string) => void;
}

type Accion = "a-gris" | "a-naranja" | null;

const FORMATO_HORA = new Intl.DateTimeFormat("es-ES", {
  timeZone: "Europe/Madrid",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function horaMadrid(d: Date): string {
  return FORMATO_HORA.format(d);
}

function duracion(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

function listaIps(ips: string[]): string {
  return ips.length ? ips.join(", ") : "(ninguna)";
}

function mensaje(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Lee canario + gestionados y los valida. Lanza ErrorCloudflare / ErrorConfiguracion. */
async function leerRegistros(
  deps: DepsVigilancia,
): Promise<{ gestionados: RegistroDns[]; modo: ModoDns }> {
  const todos = await deps.cloudflare.registros([...deps.nombres, deps.canario]);
  const canario = todos.filter((r) => r.name === deps.canario);
  const gestionados = validarRegistros(todos, deps.nombres, canario);
  return { gestionados, modo: calcularModoDns(gestionados) };
}

function esErrorApi(e: unknown): boolean {
  return e instanceof ErrorCloudflare || e instanceof ErrorConfiguracion;
}

export async function ejecutarVigilancia(
  deps: DepsVigilancia,
  opts: { aplicar: boolean; actuarDns: boolean; simularBloqueo: boolean },
): Promise<{ accion: Accion; actuo: boolean; errorConfig?: true }> {
  const ahora = deps.ahora();
  const ahoraIso = ahora.toISOString();
  const leido = await deps.leerEstado();

  const alertaApi = (s: EstadoFailover, error: unknown): Alerta | null => {
    if (s.fallosApiConsecutivos < FALLOS_PARA_ALERTA || !puedeAlertar(s, "api", ahora)) return null;
    const config = error instanceof ErrorConfiguracion;
    return {
      tipo: "api",
      asunto: config
        ? "[failover] Configuración de Cloudflare incorrecta"
        : "[failover] Fallos de la API de Cloudflare",
      texto:
        `${s.fallosApiConsecutivos} ejecuciones consecutivas con error de ` +
        `${config ? "configuración" : "la API de Cloudflare"}: ${mensaje(error)}\n` +
        (s.transicion
          ? `Transición pendiente hacia ${s.transicion.haciaModo}: se reintenta en el siguiente ciclo.`
          : "Se reintenta en el siguiente ciclo."),
    };
  };

  // ── Paso 5: modo real desde la API ───────────────────────────────────────
  let gestionados: RegistroDns[];
  let modo: ModoDns;
  try {
    ({ gestionados, modo } = await leerRegistros(deps));
  } catch (e) {
    if (!esErrorApi(e)) throw e;
    deps.log(`[failover] error leyendo registros: ${mensaje(e)}`);
    // Sin observación en esta ejecución: la racha de limpias CONSECUTIVAS se rompe.
    const s: EstadoFailover = {
      ...leido,
      ultimaEjecucionEn: ahoraIso,
      fallosApiConsecutivos: leido.fallosApiConsecutivos + 1,
      comprobacionesLimpias: 0,
    };
    const a = alertaApi(s, e);
    if (!opts.aplicar) {
      deps.log("[failover] dry-run: no se persiste ni se alerta");
      return e instanceof ErrorConfiguracion
        ? { accion: null, actuo: false, errorConfig: true }
        : { accion: null, actuo: false };
    }
    await cerrar(deps, s, a ? [a] : [], ahora);
    return e instanceof ErrorConfiguracion
      ? { accion: null, actuo: false, errorConfig: true }
      : { accion: null, actuo: false };
  }

  // ── Pasos 1-2: observación ───────────────────────────────────────────────
  let observacion: Observacion | null = null;
  let ipsCanario: string[] = [];
  let ipsSitio: string[] = [];
  let lecturaOk = true;
  try {
    ipsCanario = await deps.resolver(deps.canario);
    if (modo === "naranja") {
      const porNombre = await Promise.all(deps.nombres.map((n) => deps.resolver(n)));
      ipsSitio = [...new Set(porNombre.flat())];
    }
  } catch (e) {
    lecturaOk = false;
    deps.log(`[failover] DNS: no se pudo resolver el canario o el sitio: ${mensaje(e)}`);
  }

  let ipsTurnstile: string[] | null = null;
  try {
    ipsTurnstile = await deps.resolver(deps.turnstileHost);
  } catch (e) {
    deps.log(`[failover] DNS: no se pudo resolver ${deps.turnstileHost}: ${mensaje(e)}`);
  }

  if (lecturaOk) {
    const base = await deps.leerLista();
    if (!base) {
      deps.log("[failover] lista de bloqueo inválida");
    } else {
      const simuladas = new Set(opts.simularBloqueo ? ipsCanario.map((ip) => ip.trim().toLowerCase()) : []);
      const lista: ListaBloqueo = opts.simularBloqueo
        ? { tamano: base.tamano + simuladas.size, contiene: (ip) => simuladas.has(ip) || base.contiene(ip) }
        : base;
      observacion = { lista, ipsCanario, ipsSitio, ipsTurnstile };
    }
  }

  // ── Paso 6: decidir ──────────────────────────────────────────────────────
  const d = decidir({ estado: leido, ahora, modoDns: modo, observacion });
  let s = d.estado;
  const alertas = [...d.alertas];
  const accion = d.accion;

  // IPs del pool de la zona (no solo las vistas en esta ejecución) que están en la lista.
  const bloqueadas = observacion ? ipsBloqueadasPool(s.poolZona, observacion.lista) : [];

  deps.log(
    `[failover] modo DNS=${modo} observación=${observacion ? "válida" : "inválida"} ` +
      `sitioBloqueado=${s.sitioBloqueado} turnstileBloqueado=${s.turnstileBloqueado} ` +
      `limpias=${s.comprobacionesLimpias} pool=${Object.keys(s.poolZona).length} ` +
      `bloqueadas=${bloqueadas.join(",") || "-"} acción=${accion ?? "ninguna"}`,
  );

  if (!opts.aplicar) {
    deps.log("[failover] dry-run: no se toca DNS, ni estado, ni alertas, ni heartbeat");
    return { accion, actuo: false };
  }

  let huboFalloApi = false;
  let actuo = false;

  if (accion && !opts.actuarDns) {
    deps.log(`[failover] sin --cambiar-dns: se registraría ${accion}, no se toca DNS`);
  } else if (accion) {
    actuo = true;
    const destino = accion === "a-naranja" ? "naranja" : "gris";
    const proxied = destino === "naranja";
    const ultimoCambioPrevio = s.ultimoCambioEn;
    const habiaTransicion = s.transicion;

    // Intención primero: si algo falla a mitad, el siguiente ciclo converge.
    s = { ...s, transicion: { haciaModo: destino, iniciadaEn: ahoraIso } };
    await deps.escribirEstado(s);

    try {
      for (const r of gestionados) {
        if (r.proxied !== proxied) await deps.cloudflare.fijarProxied(r, proxied);
      }
      const verificados = (await leerRegistros(deps)).gestionados;
      const mal = verificados.filter((r) => r.proxied !== proxied);

      if (mal.length === 0) {
        s = {
          ...s,
          modo: destino,
          ultimoCambioEn: ahoraIso,
          transicion: null,
          fallosApiConsecutivos: 0,
        };
        const hora = horaMadrid(ahora);
        const motivo = habiaTransicion
          ? `Se completa una transición pendiente (hacia ${habiaTransicion.haciaModo}, iniciada ${habiaTransicion.iniciadaEn}).\n`
          : modo === "mixto"
            ? "Los registros estaban en estado mixto; se convergen a gris.\n"
            : "";
        if (destino === "gris") {
          alertas.push({
            tipo: "cambio",
            asunto: "[failover] Paso a gris",
            texto:
              `${deps.nombres.join(", ")} pasan a DNS-only (gris) a las ${hora} (Europe/Madrid).\n` +
              motivo +
              `IPs del pool de la zona bloqueadas: ${listaIps(bloqueadas)}\n` +
              `IPs de Turnstile bloqueadas: ${s.turnstileBloqueado ? "sí" : "no"}`,
          });
        } else {
          const enGris = ultimoCambioPrevio ? ahora.getTime() - Date.parse(ultimoCambioPrevio) : NaN;
          alertas.push({
            tipo: "cambio",
            asunto: "[failover] Vuelta a naranja",
            texto:
              `${deps.nombres.join(", ")} vuelven a proxied (naranja) a las ${hora} (Europe/Madrid).\n` +
              `Tiempo en gris: ${Number.isNaN(enGris) ? "desconocido" : duracion(enGris)}\n` +
              `Comprobaciones limpias consecutivas: ${s.comprobacionesLimpias}`,
          });
        }
        deps.log(`[failover] cambio verificado: ${destino}`);
      } else {
        deps.log(`[failover] verificación fallida: ${mal.map((r) => r.name).join(", ")}`);
        if (!alertas.some((a) => a.tipo === "mixto") && puedeAlertar(s, "mixto", ahora)) {
          alertas.push({
            tipo: "mixto",
            asunto: "[failover] Transición incompleta",
            texto:
              `Tras pedir el paso a ${destino}, estos registros siguen sin estar en ${destino}: ` +
              `${mal.map((r) => `${r.name} (${r.type})`).join(", ")}. Se reintenta en el siguiente ciclo.`,
          });
        }
      }
    } catch (e) {
      // Conserva `transicion`: el siguiente ciclo converge por la regla de transición pendiente.
      huboFalloApi = true;
      s = { ...s, fallosApiConsecutivos: s.fallosApiConsecutivos + 1 };
      deps.log(`[failover] error al cambiar/verificar DNS: ${mensaje(e)}`);
      const a = alertaApi(s, e);
      if (a) alertas.push(a);
    }
  }

  if (!huboFalloApi) s = { ...s, fallosApiConsecutivos: 0 };

  await cerrar(deps, s, alertas, ahora);
  return { accion, actuo };
}

/**
 * Paso 7: persistir, enviar alertas (cada una en su try) y heartbeat.
 * Outbox para los emails de `cambio`: se encolan en `alertasPendientes` en la
 * MISMA escritura que registra el cambio completado, antes de intentar ningún
 * envío. Así, si el proceso muere (timeout) tras persistir, el email no se
 * pierde: la cola se envía (más antiguos primero) en esta ejecución o en la
 * siguiente, y cada entrada se borra solo tras un envío correcto. El resto de
 * tipos no se encola: si fallan, se vuelven a proponer en el ciclo siguiente.
 */
async function cerrar(
  deps: DepsVigilancia,
  estado: EstadoFailover,
  alertas: Alerta[],
  ahora: Date,
): Promise<void> {
  const cambios: AlertaPendiente[] = alertas
    .filter((a) => a.tipo === "cambio")
    .map((a) => ({ tipo: "cambio", asunto: a.asunto, texto: a.texto }));
  const otras = alertas.filter((a) => a.tipo !== "cambio");
  // Un envío fallido (también de alertas que no se encolan) pone el heartbeat en /fail:
  // es el canal independiente para cuando el aviso principal no llega.
  let envioFallido = false;
  let s: EstadoFailover = {
    ...estado,
    alertasPendientes: [...(estado.alertasPendientes ?? []), ...cambios].slice(-MAX_ALERTAS_PENDIENTES),
  };
  await deps.escribirEstado(s);

  for (const p of [...s.alertasPendientes]) {
    try {
      await deps.enviarAlerta(p);
    } catch (e) {
      deps.log(`[failover] no se pudo enviar la alerta pendiente ${p.tipo}: ${mensaje(e)}`);
      envioFallido = true;
      continue;
    }
    s = { ...s, alertasPendientes: s.alertasPendientes.filter((x) => x !== p) };
    s = marcarAlertaEnviada(s, { tipo: p.tipo }, ahora);
    await deps.escribirEstado(s);
  }

  for (const a of otras) {
    try {
      await deps.enviarAlerta(a);
    } catch (e) {
      deps.log(`[failover] no se pudo enviar la alerta ${a.tipo}: ${mensaje(e)}`);
      envioFallido = true;
      continue;
    }
    s = marcarAlertaEnviada(s, a, ahora);
    await deps.escribirEstado(s);
  }

  const fallo =
    envioFallido ||
    s.transicion !== null ||
    s.fallosLecturaConsecutivos >= FALLOS_PARA_ALERTA ||
    s.fallosApiConsecutivos >= FALLOS_PARA_ALERTA ||
    // El heartbeat es el canal independiente para cuando el email está caído.
    s.alertasPendientes.length > 0;
  await deps.ping(fallo ? "fail" : "ok");
}
