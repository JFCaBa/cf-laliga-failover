import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { estadoInicial, type EstadoFailover } from "./estado.js";

const FICHERO = "cf-failover-state.json";

/**
 * Fichero ausente → estado inicial. JSON corrupto → lanza (no se adivina).
 * Campos ausentes (fichero editado a mano o de una versión anterior) se
 * completan con los valores iniciales para que `decidir` no reviente.
 */
export async function leerEstado(dir: string): Promise<EstadoFailover> {
  let texto: string;
  try {
    texto = await readFile(path.join(dir, FICHERO), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return estadoInicial();
    throw e;
  }
  const parsed = JSON.parse(texto) as Partial<EstadoFailover> & CamposAntiguos;
  return migrar(parsed);
}

/** Campos de versiones anteriores del estado (ya no se usan; se descartan al leer). */
interface CamposAntiguos {
  ipsCanario?: unknown;
  ipsSitioNaranja?: unknown;
  firmaDiscrepanciaCanario?: unknown;
}

function ipsDe(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Completa campos ausentes y descarta los antiguos. Si el pool de la zona está
 * vacío, se siembra con las IPs que guardaban las versiones anteriores
 * (`ipsSitioNaranja`, `ipsCanario`), fechadas en la última observación válida:
 * así un gris en curso no pierde las IPs que lo provocaron.
 */
function migrar(parsed: Partial<EstadoFailover> & CamposAntiguos): EstadoFailover {
  const { ipsCanario, ipsSitioNaranja, ...resto } = parsed;
  delete resto.firmaDiscrepanciaCanario;
  const e: EstadoFailover = { ...estadoInicial(), ...resto };
  const alertas: Record<string, string> = { ...e.alertas };
  delete alertas.canario; // tipo de alerta retirado
  e.alertas = alertas;
  e.poolZona = { ...(e.poolZona ?? {}) };
  if (Object.keys(e.poolZona).length === 0) {
    const visto = e.ultimaObservacionValidaEn ?? e.ultimaEjecucionEn ?? new Date().toISOString();
    for (const ip of [...ipsDe(ipsSitioNaranja), ...ipsDe(ipsCanario)]) e.poolZona[ip] = visto;
  }
  return e;
}

/** Escritura atómica: tmp en el mismo directorio + rename. */
export async function escribirEstado(dir: string, e: EstadoFailover): Promise<void> {
  const destino = path.join(dir, FICHERO);
  const tmp = `${destino}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(e, null, 2) + "\n", "utf8");
  await rename(tmp, destino);
}
