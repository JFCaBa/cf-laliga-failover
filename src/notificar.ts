import type { Alerta } from "./decidir.js";

/**
 * Notificación por webhook (POST JSON). El cuerpo lleva `text` (Slack, Mattermost,
 * Rocket.Chat) y `content` (Discord) con el mismo mensaje, más `asunto` y `tipo`
 * por si quieres tu propio receptor. Sin URL no hace nada. Lanza si falla, para
 * que el orquestador reintente la alerta.
 */
export async function enviarWebhook(
  url: string | undefined,
  a: Alerta,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (!url) return;
  const mensaje = `${a.asunto}\n${a.texto}`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: mensaje, content: mensaje, asunto: a.asunto, tipo: a.tipo }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
}
