import { parsearListaBloqueo, type ListaBloqueo } from "./lista.js";

/** Descarga la lista de hayahora. Cualquier error, timeout o no-200 → `null` (observación inválida). */
export async function leerListaBloqueo(cfg: {
  url: string;
  userAgent: string;
  fetch?: typeof fetch;
}): Promise<ListaBloqueo | null> {
  const f = cfg.fetch ?? fetch;
  try {
    const res = await f(cfg.url, {
      headers: { "User-Agent": cfg.userAgent },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status !== 200) return null;
    const cuerpo = await res.text();
    // Cabecera ausente (o vacía) → null: hayahora no manda Content-Type.
    return parsearListaBloqueo(cuerpo, res.headers.get("content-type") || null);
  } catch {
    return null;
  }
}
