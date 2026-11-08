/**
 * Helpers puros del CLI (argumentos, env, re-ejecución bajo lock).
 * Sin I/O: `bin.ts` los compone.
 */

export const DIR_POR_DEFECTO = "/var/lib/cf-laliga-failover";
export const TURNSTILE_HOST = "challenges.cloudflare.com";
export const ZONA_TURNSTILE = "cloudflare.com";
export const URL_LISTA = "https://hayahora.futbol/estado/blocked-any.txt";
export const FICHERO_LOCK = "cf-failover.lock";
/** Límite total de una ejecución bajo lock (`timeout -k 10s 120s`). */
export const TIMEOUT_EJECUCION = "120s";
export const TIMEOUT_KILL = "10s";

type Env = Record<string, string | undefined>;

export interface ArgsVigilancia {
  apply: boolean;
  cambiarDns: boolean;
  simularBloqueo: boolean;
}

export function parsearArgs(argv: string[]): ArgsVigilancia {
  const args: ArgsVigilancia = { apply: false, cambiarDns: false, simularBloqueo: false };
  for (const a of argv) {
    if (a === "--apply") args.apply = true;
    else if (a === "--cambiar-dns") args.cambiarDns = true;
    else if (a === "--simular-bloqueo") args.simularBloqueo = true;
    else throw new Error(`flag desconocida: ${a}`);
  }
  if (args.cambiarDns && !args.apply) {
    throw new Error("--cambiar-dns solo tiene sentido con --apply");
  }
  return args;
}

function noVacio(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/** Directorio del estado y del lock. */
export function dirFailover(env: Env): string {
  return noVacio(env.CF_FAILOVER_DIR) ?? DIR_POR_DEFECTO;
}

/**
 * Comando para re-ejecutarse bajo `flock -n` + `timeout`: un único proceso
 * node bajo `timeout`, para que el kill lo alcance y el SO libere el lock.
 */
export function comandoBajoLock(
  dir: string,
  nodePath: string,
  script: string,
  args: string[],
): { cmd: string; args: string[] } {
  return {
    cmd: "flock",
    args: [
      "-n",
      `${dir.replace(/\/+$/, "")}/${FICHERO_LOCK}`,
      "timeout",
      "-k",
      TIMEOUT_KILL,
      TIMEOUT_EJECUCION,
      nodePath,
      script,
      ...args,
    ],
  };
}

/** Código de salida del padre a partir del hijo: su status; muerto por señal (status null) → 1. */
export function codigoSalidaHijo(status: number | null): number {
  return typeof status === "number" ? status : 1;
}

export interface ConfigVigilancia {
  token: string;
  zoneId: string;
  /** Zona DNS del sitio (p. ej. `example.es`), para preguntar a sus NS autoritativos. */
  zona: string;
  nombres: string[];
  canario: string;
  dir: string;
  heartbeatUrl: string | undefined;
  webhookUrl: string | undefined;
  userAgent: string;
}

export function listaNombres(v: string): string[] {
  return [
    ...new Set(
      v
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function userAgent(env: Env): string {
  const contacto = noVacio(env.CF_FAILOVER_CONTACTO);
  return contacto ? `cf-laliga-failover/1.0 (+mailto:${contacto})` : "cf-laliga-failover/1.0";
}

/**
 * Config desde el env. Obligatorias: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`
 * y `CF_FAILOVER_ZONA`. Los registros por defecto son `<zona>` y `www.<zona>`;
 * el canario, `cf-canary.<zona>`.
 */
export function leerConfig(
  env: Env,
): { ok: true; config: ConfigVigilancia } | { ok: false; faltan: string[] } {
  const token = noVacio(env.CLOUDFLARE_API_TOKEN);
  const zoneId = noVacio(env.CLOUDFLARE_ZONE_ID);
  const zona = noVacio(env.CF_FAILOVER_ZONA)?.toLowerCase();
  const faltan = [
    ...(token ? [] : ["CLOUDFLARE_API_TOKEN"]),
    ...(zoneId ? [] : ["CLOUDFLARE_ZONE_ID"]),
    ...(zona ? [] : ["CF_FAILOVER_ZONA"]),
  ];
  if (!token || !zoneId || !zona) return { ok: false, faltan };
  return {
    ok: true,
    config: {
      token,
      zoneId,
      zona,
      nombres: listaNombres(noVacio(env.CF_FAILOVER_REGISTROS) ?? `${zona},www.${zona}`),
      canario: (noVacio(env.CF_FAILOVER_CANARIO) ?? `cf-canary.${zona}`).toLowerCase(),
      dir: dirFailover(env),
      heartbeatUrl: noVacio(env.CF_FAILOVER_HEARTBEAT_URL),
      webhookUrl: noVacio(env.CF_FAILOVER_WEBHOOK_URL),
      userAgent: userAgent(env),
    },
  };
}
