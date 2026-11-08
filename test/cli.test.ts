import { describe, expect, it } from "vitest";
import {
  codigoSalidaHijo,
  comandoBajoLock,
  dirFailover,
  leerConfig,
  parsearArgs,
} from "../src/cli";

describe("parsearArgs", () => {
  it("dry-run por defecto", () => {
    expect(parsearArgs([])).toEqual({ apply: false, cambiarDns: false, simularBloqueo: false });
  });
  it("--apply y --simular-bloqueo", () => {
    expect(parsearArgs(["--apply", "--simular-bloqueo"])).toEqual({ apply: true, cambiarDns: false, simularBloqueo: true });
  });
  it("--cambiar-dns exige --apply", () => {
    expect(parsearArgs(["--apply", "--cambiar-dns"])).toEqual({ apply: true, cambiarDns: true, simularBloqueo: false });
    expect(() => parsearArgs(["--cambiar-dns"])).toThrow(/--apply/);
  });
  it("flag desconocida lanza", () => {
    expect(() => parsearArgs(["--aply"])).toThrow(/desconocida/);
  });
});

describe("dirFailover", () => {
  it("default /var/lib/cf-laliga-failover; vacío cuenta como ausente", () => {
    expect(dirFailover({})).toBe("/var/lib/cf-laliga-failover");
    expect(dirFailover({ CF_FAILOVER_DIR: "  " })).toBe("/var/lib/cf-laliga-failover");
    expect(dirFailover({ CF_FAILOVER_DIR: "/tmp/x" })).toBe("/tmp/x");
  });
});

describe("comandoBajoLock", () => {
  it("flock -n <dir>/cf-failover.lock timeout -k 10s 120s node <script> <args>", () => {
    expect(comandoBajoLock("/data/", "/usr/bin/node", "/repo/dist/bin.js", ["--apply", "--simular-bloqueo"])).toEqual({
      cmd: "flock",
      args: [
        "-n",
        "/data/cf-failover.lock",
        "timeout",
        "-k",
        "10s",
        "120s",
        "/usr/bin/node",
        "/repo/dist/bin.js",
        "--apply",
        "--simular-bloqueo",
      ],
    });
  });
});

describe("codigoSalidaHijo", () => {
  it("propaga el status; señal (status null) → 1", () => {
    expect(codigoSalidaHijo(0)).toBe(0);
    expect(codigoSalidaHijo(124)).toBe(124);
    expect(codigoSalidaHijo(null)).toBe(1);
  });
});

describe("leerConfig", () => {
  it("sin token, zona de Cloudflare ni dominio → faltan los tres", () => {
    expect(leerConfig({})).toEqual({
      ok: false,
      faltan: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ZONE_ID", "CF_FAILOVER_ZONA"],
    });
    expect(leerConfig({ CLOUDFLARE_API_TOKEN: "  ", CLOUDFLARE_ZONE_ID: "z", CF_FAILOVER_ZONA: "example.es" })).toEqual({
      ok: false,
      faltan: ["CLOUDFLARE_API_TOKEN"],
    });
  });

  it("defaults derivados de la zona", () => {
    const r = leerConfig({ CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ZONE_ID: "z", CF_FAILOVER_ZONA: "Example.es" });
    expect(r).toEqual({
      ok: true,
      config: {
        token: "t",
        zoneId: "z",
        zona: "example.es",
        nombres: ["example.es", "www.example.es"],
        canario: "cf-canary.example.es",
        dir: "/var/lib/cf-laliga-failover",
        heartbeatUrl: undefined,
        webhookUrl: undefined,
        userAgent: "cf-laliga-failover/1.0",
      },
    });
  });

  it("overrides, normaliza y deduplica registros, UA con contacto", () => {
    const r = leerConfig({
      CLOUDFLARE_API_TOKEN: "t",
      CLOUDFLARE_ZONE_ID: "z",
      CF_FAILOVER_ZONA: "a.com",
      CF_FAILOVER_REGISTROS: " A.com , www.a.com,a.com,",
      CF_FAILOVER_CANARIO: "Canary.a.com",
      CF_FAILOVER_DIR: "/d",
      CF_FAILOVER_HEARTBEAT_URL: "https://hc/x",
      CF_FAILOVER_WEBHOOK_URL: "https://hook/y",
      CF_FAILOVER_CONTACTO: "ops@example.com",
    });
    expect(r.ok && r.config).toEqual({
      token: "t",
      zoneId: "z",
      zona: "a.com",
      nombres: ["a.com", "www.a.com"],
      canario: "canary.a.com",
      dir: "/d",
      heartbeatUrl: "https://hc/x",
      webhookUrl: "https://hook/y",
      userAgent: "cf-laliga-failover/1.0 (+mailto:ops@example.com)",
    });
  });
});
