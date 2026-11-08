import { promises as dns } from "node:dns";

const SIN_DATOS = new Set(["ENODATA", "ENOTFOUND"]);

async function resolverTipo(
  r: dns.Resolver,
  nombre: string,
  tipo: "A" | "AAAA",
): Promise<string[]> {
  try {
    return tipo === "A" ? await r.resolve4(nombre) : await r.resolve6(nombre);
  } catch (e) {
    // Un tipo vacío no es error. NXDOMAIN del nombre y los timeouts se tratan abajo.
    if (SIN_DATOS.has((e as NodeJS.ErrnoException).code ?? "")) return [];
    throw e;
  }
}

/**
 * Consultas A y AAAA de `nombre` a UN servidor (IP) autoritativo, cada una por
 * separado: que falle la AAAA no tira la respuesta A del mismo servidor.
 */
function consultasEnServidor(ipServidor: string, nombre: string): Promise<string[]>[] {
  const r = new dns.Resolver({ timeout: 5000, tries: 2 });
  r.setServers([ipServidor]);
  return [resolverTipo(r, nombre, "A"), resolverTipo(r, nombre, "AAAA")];
}

/**
 * IPs (A ∪ AAAA) de `nombre` según los NS autoritativos de `zona`, sin pasar por
 * cachés recursivas. Se pregunta a CADA IP de NS por separado y se devuelve la
 * unión: Cloudflare reparte los nombres de la zona entre varios juegos de IPs y
 * cada respuesta enseña solo uno, así una ejecución tiende a ver más de uno.
 * Se une toda consulta (A o AAAA, en cualquier NS) que haya contestado, aunque
 * la otra del mismo NS falle: perder una A válida podría esconder una IP
 * bloqueada. Solo si fallan TODAS las consultas se lanza el primer error.
 * Contestado pero sin A/AAAA (NXDOMAIN) también lanza.
 */
export async function resolverAutoritativo(nombre: string, zona: string): Promise<string[]> {
  const nsNombres = await dns.resolveNs(zona);
  const ips: string[] = [];
  for (const ns of nsNombres) {
    try {
      ips.push(...(await dns.resolve4(ns)));
    } catch {
      // NS sin A: se prueba con el resto
    }
  }
  const servidores = [...new Set(ips)];
  if (servidores.length === 0) throw new Error(`Sin IPs para los NS de ${zona}`);

  const resultados = await Promise.allSettled(servidores.flatMap((ip) => consultasEnServidor(ip, nombre)));
  const ok = resultados.filter((r): r is PromiseFulfilledResult<string[]> => r.status === "fulfilled");
  if (ok.length === 0) {
    throw (resultados[0] as PromiseRejectedResult).reason;
  }
  const todas = [...new Set(ok.flatMap((r) => r.value))];
  if (todas.length === 0) {
    const e = new Error(`NXDOMAIN o sin registros A/AAAA para ${nombre}`) as NodeJS.ErrnoException;
    e.code = "ENOTFOUND";
    throw e;
  }
  return todas;
}
