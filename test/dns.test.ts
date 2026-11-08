import { beforeEach, describe, expect, it, vi } from "vitest";

// Respuesta de cada IP de NS: lista de IPs (A y AAAA juntas) o error.
const porServidor = new Map<string, string[] | Error>();
// Fallo solo de AAAA en un servidor (la A contesta).
const falloAaaa = new Set<string>();

vi.mock("node:dns", () => {
  class Resolver {
    servidor = "";
    setServers(s: string[]) {
      this.servidor = s[0];
    }
    private respuesta(v6: boolean): string[] {
      const r = porServidor.get(this.servidor);
      if (r instanceof Error) throw r;
      return (r ?? []).filter((ip) => ip.includes(":") === v6);
    }
    async resolve4() {
      return this.respuesta(false);
    }
    async resolve6() {
      if (falloAaaa.has(this.servidor)) throw new Error("ETIMEOUT aaaa");
      return this.respuesta(true);
    }
  }
  const promises = {
    Resolver,
    resolveNs: async () => ["ns1.cf.com", "ns2.cf.com"],
    resolve4: async (ns: string) => (ns === "ns1.cf.com" ? ["10.0.0.1"] : ["10.0.0.2"]),
  };
  return { promises, default: { promises } };
});

const { resolverAutoritativo } = await import("../src/dns");

const PAR_A = ["104.21.32.62", "2606:4700:3036::ac43:b83c"];
const PAR_B = ["188.114.96.2", "2a06:98c1:3120::2"];

beforeEach(() => {
  porServidor.clear();
  falloAaaa.clear();
});

describe("resolverAutoritativo", () => {
  it("pregunta a cada NS por separado y devuelve la unión", async () => {
    porServidor.set("10.0.0.1", PAR_A);
    porServidor.set("10.0.0.2", PAR_B);
    const r = await resolverAutoritativo("cf-canary.x.com", "x.com");
    expect(r.sort()).toEqual([...PAR_A, ...PAR_B].sort());
  });

  it("basta con que conteste un NS", async () => {
    porServidor.set("10.0.0.1", new Error("ETIMEOUT"));
    porServidor.set("10.0.0.2", PAR_B);
    expect((await resolverAutoritativo("x.com", "x.com")).sort()).toEqual([...PAR_B].sort());
  });

  it("A válida de un NS cuya AAAA falla no se pierde aunque otro NS conteste", async () => {
    porServidor.set("10.0.0.1", ["188.114.96.2"]);
    falloAaaa.add("10.0.0.1");
    porServidor.set("10.0.0.2", PAR_A);
    const r = await resolverAutoritativo("x.com", "x.com");
    expect(r.sort()).toEqual(["188.114.96.2", ...PAR_A].sort());
  });

  it("si fallan todos los NS, lanza", async () => {
    porServidor.set("10.0.0.1", new Error("ETIMEOUT 1"));
    porServidor.set("10.0.0.2", new Error("ETIMEOUT 2"));
    await expect(resolverAutoritativo("x.com", "x.com")).rejects.toThrow("ETIMEOUT 1");
  });

  it("contestan pero sin registros → ENOTFOUND", async () => {
    porServidor.set("10.0.0.1", []);
    porServidor.set("10.0.0.2", []);
    await expect(resolverAutoritativo("x.com", "x.com")).rejects.toMatchObject({ code: "ENOTFOUND" });
  });
});
