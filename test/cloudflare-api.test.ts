import { describe, expect, it, vi } from "vitest";
import {
  crearClienteCloudflare,
  ErrorCloudflare,
  ErrorConfiguracion,
  modoDns,
  validarRegistros,
  type RegistroDns,
} from "../src/cloudflare-api";

const reg = (name: string, proxied: boolean, type: RegistroDns["type"] = "A", id = name): RegistroDns => ({
  id,
  name,
  type,
  proxied,
});

function respuesta(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function ok(result: unknown[], page = 1, total_pages = 1) {
  return { success: true, errors: [], result, result_info: { page, total_pages } };
}

describe("cliente Cloudflare", () => {
  it("registros filtra por nombre y tipos A/AAAA/CNAME", async () => {
    const f = vi.fn(async () =>
      respuesta(
        ok([
          { id: "1", name: "www.x.es", type: "A", proxied: true },
          { id: "2", name: "www.x.es", type: "TXT", proxied: false },
          { id: "3", name: "otro.x.es", type: "A", proxied: true },
          { id: "4", name: "x.es", type: "CNAME", proxied: false },
          { id: "5", name: "x.es", type: "AAAA", proxied: true },
        ]),
      ),
    );
    const c = crearClienteCloudflare({ token: "t", zoneId: "z", fetch: f as unknown as typeof fetch });
    const r = await c.registros(["www.x.es", "x.es"]);
    expect(r.map((x) => x.id)).toEqual(["1", "4", "5"]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/zones/z/dns_records");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t");
  });

  it("registros recorre todas las páginas", async () => {
    const f = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return respuesta(ok([{ id: `p${page}`, name: "x.es", type: "A", proxied: true }], page, 3));
    });
    const c = crearClienteCloudflare({ token: "t", zoneId: "z", fetch: f as unknown as typeof fetch });
    const r = await c.registros(["x.es"]);
    expect(r.map((x) => x.id)).toEqual(["p1", "p2", "p3"]);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("fijarProxied(false) manda ttl 60", async () => {
    const f = vi.fn(async () => respuesta({ success: true, errors: [], result: {} }));
    const c = crearClienteCloudflare({ token: "t", zoneId: "z", fetch: f as unknown as typeof fetch });
    await c.fijarProxied(reg("x.es", true, "A", "abc"), false);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/zones/z/dns_records/abc");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ proxied: false, ttl: 60 });
  });

  it("fijarProxied(true) manda ttl 1", async () => {
    const f = vi.fn(async () => respuesta({ success: true, errors: [], result: {} }));
    const c = crearClienteCloudflare({ token: "t", zoneId: "z", fetch: f as unknown as typeof fetch });
    await c.fijarProxied(reg("x.es", false), true);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ proxied: true, ttl: 1 });
  });

  it("success:false lanza ErrorCloudflare", async () => {
    const f = vi.fn(async () => respuesta({ success: false, errors: [{ code: 1, message: "mal" }], result: [] }));
    const c = crearClienteCloudflare({ token: "t", zoneId: "z", fetch: f as unknown as typeof fetch });
    await expect(c.registros(["x.es"])).rejects.toBeInstanceOf(ErrorCloudflare);
  });

  it("timeout/red de fetch lanza ErrorCloudflare sin filtrar el token", async () => {
    const f = vi.fn(async () => {
      throw new DOMException("secret-token https://x", "TimeoutError");
    });
    const c = crearClienteCloudflare({ token: "secret-token", zoneId: "z", fetch: f as unknown as typeof fetch });
    const p = c.registros(["x.es"]);
    await expect(p).rejects.toBeInstanceOf(ErrorCloudflare);
    await expect(p).rejects.toThrow("Cloudflare red: TimeoutError");
    await expect(p).rejects.not.toThrow(/secret-token/);
  });

  it("200 con cuerpo no JSON lanza ErrorCloudflare", async () => {
    const f = vi.fn(async () => new Response("not json", { status: 200 }));
    const c = crearClienteCloudflare({ token: "t", zoneId: "z", fetch: f as unknown as typeof fetch });
    await expect(c.registros(["x.es"])).rejects.toBeInstanceOf(ErrorCloudflare);
  });

  it("no-2xx lanza ErrorCloudflare", async () => {
    const f = vi.fn(async () => respuesta({}, 403));
    const c = crearClienteCloudflare({ token: "t", zoneId: "z", fetch: f as unknown as typeof fetch });
    await expect(c.fijarProxied(reg("x.es", true), false)).rejects.toBeInstanceOf(ErrorCloudflare);
  });
});

describe("modoDns", () => {
  it("modoDns cuenta CNAME proxied", () => {
    expect(modoDns([reg("a", true, "CNAME"), reg("b", true)])).toBe("naranja");
    expect(modoDns([reg("a", false, "CNAME"), reg("b", false)])).toBe("gris");
  });
  it("modoDns mixto", () => {
    expect(modoDns([reg("a", true), reg("b", false)])).toBe("mixto");
  });
  it("modoDns vacío lanza", () => {
    expect(() => modoDns([])).toThrow();
  });
});

describe("validarRegistros", () => {
  const nombres = ["x.es", "www.x.es"];
  const canario = [reg("canario.x.es", true)];

  it("devuelve solo los gestionados", () => {
    const r = validarRegistros([reg("x.es", true), reg("www.x.es", true), reg("canario.x.es", true)], nombres, canario);
    expect(r.map((x) => x.name)).toEqual(["x.es", "www.x.es"]);
  });

  it("validarRegistros: falta www → lanza", () => {
    expect(() => validarRegistros([reg("x.es", true)], nombres, canario)).toThrow(ErrorConfiguracion);
  });

  it("validarRegistros: canario gris → lanza", () => {
    expect(() =>
      validarRegistros([reg("x.es", true), reg("www.x.es", true)], nombres, [reg("canario.x.es", false)]),
    ).toThrow(ErrorConfiguracion);
  });

  it("canario inexistente → lanza", () => {
    expect(() => validarRegistros([reg("x.es", true), reg("www.x.es", true)], nombres, [])).toThrow(
      ErrorConfiguracion,
    );
  });

  it("validarRegistros: canario entre los gestionados → lanza", () => {
    expect(() =>
      validarRegistros([reg("x.es", true), reg("www.x.es", true)], nombres, [reg("www.x.es", true)]),
    ).toThrow(ErrorConfiguracion);
  });
});
