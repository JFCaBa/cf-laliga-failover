/** Ping a healthchecks.io / Better Stack / Uptime Kuma (o compatible). Sin URL no hace nada; los errores solo se loguean. */
export async function pingHeartbeat(
  url: string | undefined,
  resultado: "ok" | "fail",
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (!url) return;
  const destino = resultado === "fail" ? `${url.replace(/\/+$/, "")}/fail` : url;
  try {
    await fetchFn(destino, { signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    console.error("[failover] heartbeat falló:", e instanceof Error ? e.message : e);
  }
}
