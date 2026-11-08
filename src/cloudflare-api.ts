import type { ModoDns } from "./estado.js";

/** Adaptador mínimo de la API v4 de Cloudflare para los registros gestionados. */
const BASE = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 15_000;
const TIPOS = new Set(["A", "AAAA", "CNAME"]);

export type RegistroDns = { id: string; name: string; type: "A" | "AAAA" | "CNAME"; proxied: boolean };

export interface ClienteCloudflare {
  registros(nombres: string[]): Promise<RegistroDns[]>;
  fijarProxied(r: RegistroDns, proxied: boolean): Promise<void>;
}

export class ErrorCloudflare extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "ErrorCloudflare";
  }
}

export class ErrorConfiguracion extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "ErrorConfiguracion";
  }
}

type Cuerpo = {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: unknown;
  result_info?: { page?: number; total_pages?: number };
};

export function crearClienteCloudflare(cfg: {
  token: string;
  zoneId: string;
  fetch?: typeof fetch;
}): ClienteCloudflare {
  const f = cfg.fetch ?? fetch;

  async function llamar(url: string, init: RequestInit = {}): Promise<Cuerpo> {
    let res: Response;
    try {
      res = await f(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          Authorization: `Bearer ${cfg.token}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      // Solo el nombre del error: nada de URL, cabeceras ni token.
      throw new ErrorCloudflare(`Cloudflare red: ${e instanceof Error ? e.name : "desconocido"}`);
    }
    let cuerpo: Cuerpo = {};
    try {
      cuerpo = (await res.json()) as Cuerpo;
    } catch {
      // cuerpo no JSON: se decide por el status
    }
    if (!res.ok || cuerpo.success !== true) {
      const detalle = (cuerpo.errors ?? []).map((e) => e.message).filter(Boolean).join("; ");
      throw new ErrorCloudflare(`Cloudflare ${res.status}${detalle ? `: ${detalle}` : ""}`);
    }
    return cuerpo;
  }

  return {
    async registros(nombres) {
      const salida: RegistroDns[] = [];
      for (const nombre of nombres) {
        let page = 1;
        let total = 1;
        do {
          const q = new URLSearchParams({ name: nombre, per_page: "100", page: String(page) });
          const cuerpo = await llamar(`${BASE}/zones/${cfg.zoneId}/dns_records?${q}`);
          const filas = Array.isArray(cuerpo.result) ? (cuerpo.result as Record<string, unknown>[]) : [];
          for (const r of filas) {
            if (r.name === nombre && typeof r.type === "string" && TIPOS.has(r.type)) {
              salida.push({
                id: String(r.id),
                name: String(r.name),
                type: r.type as RegistroDns["type"],
                proxied: r.proxied === true,
              });
            }
          }
          total = cuerpo.result_info?.total_pages ?? 1;
          page += 1;
        } while (page <= total);
      }
      return salida;
    },

    async fijarProxied(r, proxied) {
      await llamar(`${BASE}/zones/${cfg.zoneId}/dns_records/${r.id}`, {
        method: "PATCH",
        body: JSON.stringify(proxied ? { proxied: true, ttl: 1 } : { proxied: false, ttl: 60 }),
      });
    },
  };
}

/**
 * Valida lo leído de la API contra la configuración. Devuelve los registros
 * gestionados. Se usa al leer y al verificar tras el cambio.
 */
export function validarRegistros(
  registros: RegistroDns[],
  nombres: string[],
  canario: RegistroDns[],
): RegistroDns[] {
  const gestionados = new Set(nombres);
  const presentes = new Set(registros.map((r) => r.name));
  for (const n of nombres) {
    if (!presentes.has(n)) throw new ErrorConfiguracion(`Falta el registro gestionado ${n}`);
  }
  if (canario.length === 0) throw new ErrorConfiguracion("El registro canario no existe");
  for (const c of canario) {
    if (gestionados.has(c.name)) {
      throw new ErrorConfiguracion(`El canario ${c.name} está entre los registros gestionados`);
    }
    if (!c.proxied) throw new ErrorConfiguracion(`El canario ${c.name} no está en naranja`);
  }
  return registros.filter((r) => gestionados.has(r.name));
}

export function modoDns(registros: RegistroDns[]): ModoDns {
  if (registros.length === 0) throw new ErrorConfiguracion("Sin registros para determinar el modo");
  const naranjas = registros.filter((r) => r.proxied).length;
  if (naranjas === registros.length) return "naranja";
  if (naranjas === 0) return "gris";
  return "mixto";
}
