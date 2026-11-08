import { describe, expect, it, vi } from "vitest";
import { enviarWebhook } from "../src/notificar";

const alerta = { tipo: "cambio" as const, asunto: "[failover] Paso a gris", texto: "detalle" };

describe("enviarWebhook", () => {
  it("sin URL no hace nada", async () => {
    const f = vi.fn();
    await enviarWebhook(undefined, alerta, f as unknown as typeof fetch);
    expect(f).not.toHaveBeenCalled();
  });

  it("POST JSON con text y content (Slack y Discord)", async () => {
    const f = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    await enviarWebhook("https://hook/x", alerta, f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://hook/x");
    const body = JSON.parse(init.body);
    expect(body.text).toBe("[failover] Paso a gris\ndetalle");
    expect(body.content).toBe(body.text);
    expect(body.tipo).toBe("cambio");
  });

  it("HTTP no OK lanza (la alerta se reintenta)", async () => {
    const f = vi.fn().mockResolvedValue(new Response("no", { status: 500 }));
    await expect(enviarWebhook("https://hook/x", alerta, f as unknown as typeof fetch)).rejects.toThrow(/500/);
  });
});
