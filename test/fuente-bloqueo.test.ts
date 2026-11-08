import { describe, expect, it, vi } from "vitest";
import { leerListaBloqueo } from "../src/fuente-bloqueo";

const txt = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/plain" } });

describe("leerListaBloqueo", () => {
  it("devuelve la lista parseada", async () => {
    const f = vi.fn(async () => txt("1.2.3.4\n"));
    const l = await leerListaBloqueo({ url: "https://h/x", userAgent: "ua", fetch: f as unknown as typeof fetch });
    expect(l?.contiene("1.2.3.4")).toBe(true);
  });

  it("sin cabecera Content-Type (como hayahora) pasa null y la lista es válida", async () => {
    // Cuerpo binario: un string haría que Response añadiera text/plain solo.
    const res = new Response(new TextEncoder().encode("1.2.3.4\n"), { status: 200 });
    expect(res.headers.get("content-type")).toBeNull();
    const f = vi.fn(async () => res);
    const l = await leerListaBloqueo({ url: "https://h/x", userAgent: "ua", fetch: f as unknown as typeof fetch });
    expect(l?.contiene("1.2.3.4")).toBe(true);
  });

  it("text/html → null", async () => {
    const f = vi.fn(async () => new Response("1.2.3.4\n", { status: 200, headers: { "content-type": "text/html" } }));
    expect(await leerListaBloqueo({ url: "https://h/x", userAgent: "ua", fetch: f as unknown as typeof fetch })).toBeNull();
  });

  it("500 → null", async () => {
    const f = vi.fn(async () => txt("x", 500));
    expect(await leerListaBloqueo({ url: "https://h/x", userAgent: "ua", fetch: f as unknown as typeof fetch })).toBeNull();
  });

  it("timeout → null", async () => {
    const f = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(await leerListaBloqueo({ url: "https://h/x", userAgent: "ua", fetch: f as unknown as typeof fetch })).toBeNull();
  });

  it("manda el User-Agent", async () => {
    const f = vi.fn(async () => txt(""));
    await leerListaBloqueo({ url: "https://h/x", userAgent: "mi-agente", fetch: f as unknown as typeof fetch });
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe("mi-agente");
  });
});
