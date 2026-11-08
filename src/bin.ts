#!/usr/bin/env node
// Watchdog del failover Cloudflare/LaLiga. Ver README.
//
//   cf-laliga-failover                                  # dry-run: mide e imprime, no escribe nada
//   cf-laliga-failover --apply                          # bajo flock + timeout: estado, alertas, heartbeat
//   cf-laliga-failover --apply --cambiar-dns            # además conmuta DNS naranja <-> gris
//   cf-laliga-failover --apply --simular-bloqueo        # simulacro: trata el canario como bloqueado
//
// Con --apply se re-ejecuta como
//   flock -n <dir>/cf-failover.lock timeout -k 10s 120s node <script> <args>
// Requiere `flock` (util-linux): en macOS --apply sale con 2.
//
// Salida: 0 ok; 1 error de API de Cloudflare, lista inválida o fallo no
// controlado (y `flock -n` ocupado); 2 configuración (sin flock, faltan variables).

import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crearClienteCloudflare, type ClienteCloudflare } from "./cloudflare-api.js";
import { resolverAutoritativo } from "./dns.js";
import { leerListaBloqueo } from "./fuente-bloqueo.js";
import { leerEstado, escribirEstado } from "./almacen.js";
import { pingHeartbeat } from "./heartbeat.js";
import { enviarWebhook } from "./notificar.js";
import { ejecutarVigilancia } from "./ejecutar.js";
import {
  codigoSalidaHijo,
  comandoBajoLock,
  dirFailover,
  leerConfig,
  parsearArgs,
  TURNSTILE_HOST,
  URL_LISTA,
  ZONA_TURNSTILE,
} from "./cli.js";

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/** Re-ejecución bajo flock + timeout. Devuelve el código de salida del padre. */
function reejecutarBajoLock(dir: string, argv: string[]): number {
  // flock no crea directorios: sin él, la primera ejecución falla.
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error(`[failover] no se pudo crear ${dir}: ${(e as Error).message}`);
    return 2;
  }
  const script = fileURLToPath(import.meta.url);
  const { cmd, args } = comandoBajoLock(dir, process.execPath, script, argv);
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, CF_FAILOVER_BAJO_LOCK: "1", CF_FAILOVER_DIR: dir },
  });
  if (r.error) {
    if ((r.error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(
        "[failover] --apply necesita `flock` (util-linux) y no está instalado en este sistema " +
          "(macOS no lo trae). Usa el dry-run (sin --apply) en local; --apply solo en el servidor.",
      );
      return 2;
    }
    console.error("[failover] no se pudo lanzar flock:", r.error.message);
    return 1;
  }
  if (r.status === 1) log("[failover] salida 1 (incluye: lock ocupado por otra ejecución)");
  if (r.status === 124 || r.status === 137) log("[failover] la ejecución superó el timeout de 120 s");
  return codigoSalidaHijo(r.status);
}

export async function main(argv: string[]): Promise<number> {
  const args = parsearArgs(argv);
  const dir = dirFailover(process.env);

  if (args.apply && process.env.CF_FAILOVER_BAJO_LOCK !== "1") {
    return reejecutarBajoLock(dir, argv);
  }

  const cfg = leerConfig(process.env);
  if (!cfg.ok) {
    console.error(
      `[failover] faltan ${cfg.faltan.join(", ")} en el entorno: sin ellas no se pueden ` +
        "leer los registros de Cloudflare. Ver README §Configuración.",
    );
    return 2;
  }
  const c = cfg.config;

  const aplicar = args.apply;
  const actuarDns = aplicar && args.cambiarDns;
  log(
    `[failover] modo=${aplicar ? "APPLY" : "DRY-RUN"} cambiarDns=${actuarDns} ` +
      `simularBloqueo=${args.simularBloqueo} dir=${c.dir} registros=${c.nombres.join(",")} canario=${c.canario}`,
  );

  // Rastreo de errores para el código de salida.
  let errorApi = false;
  let listaInvalida = false;

  const base = crearClienteCloudflare({ token: c.token, zoneId: c.zoneId });
  const cloudflare: ClienteCloudflare = {
    async registros(nombres) {
      try {
        const rs = await base.registros(nombres);
        for (const r of rs) log(`[failover] registro ${r.name} ${r.type} proxied=${r.proxied}`);
        return rs;
      } catch (e) {
        errorApi = true;
        throw e;
      }
    },
    async fijarProxied(r, proxied) {
      try {
        await base.fijarProxied(r, proxied);
      } catch (e) {
        errorApi = true;
        throw e;
      }
    },
  };

  const r = await ejecutarVigilancia(
    {
      ahora: () => new Date(),
      leerEstado: () => leerEstado(c.dir),
      escribirEstado: (e) => escribirEstado(c.dir, e),
      cloudflare,
      nombres: c.nombres,
      canario: c.canario,
      turnstileHost: TURNSTILE_HOST,
      resolver: async (nombre) => {
        const zona = nombre === TURNSTILE_HOST ? ZONA_TURNSTILE : c.zona;
        const ips = await resolverAutoritativo(nombre, zona);
        log(`[failover] DNS ${nombre} → ${ips.join(", ")}`);
        return ips;
      },
      leerLista: async () => {
        const lista = await leerListaBloqueo({ url: URL_LISTA, userAgent: c.userAgent });
        if (!lista) listaInvalida = true;
        else log(`[failover] lista ${URL_LISTA}: ${lista.tamano} entradas`);
        return lista;
      },
      enviarAlerta: async (a) => {
        if (!c.webhookUrl) {
          console.warn(`[failover] sin CF_FAILOVER_WEBHOOK_URL; alerta solo en el log: ${a.asunto}\n${a.texto}`);
          return;
        }
        const texto =
          a.tipo === "cambio"
            ? { ...a, texto: `${a.texto}\nLista: ${URL_LISTA} (observación de hayahora.futbol, no oficial)` }
            : a;
        await enviarWebhook(c.webhookUrl, texto);
        log(`[failover] alerta enviada: ${a.asunto}`);
      },
      ping: (resultado) => pingHeartbeat(c.heartbeatUrl, resultado),
      log,
    },
    { aplicar, actuarDns, simularBloqueo: args.simularBloqueo },
  );

  log(`[failover] accion=${r.accion ?? "ninguna"} actuo=${r.actuo}`);
  if (r.errorConfig) {
    log("[failover] configuración de Cloudflare incorrecta (canario, registros): exit 2");
    return 2;
  }
  if (errorApi || listaInvalida) {
    const motivos = [errorApi && "error de API de Cloudflare", listaInvalida && "lista inválida"].filter(Boolean);
    log(`[failover] terminó con ${motivos.join(" y ")}: exit 1`);
    return 1;
  }
  return 0;
}

// Solo corre como CLI (también a través del symlink de node_modules/.bin).
function esEjecucionDirecta(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (esEjecucionDirecta()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error("[failover] fatal:", err);
      process.exitCode = 1;
    });
}
