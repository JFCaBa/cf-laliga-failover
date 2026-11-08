import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leerEstado, escribirEstado } from "../src/almacen";
import { estadoInicial } from "../src/estado";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cf-failover-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("almacén de estado", () => {
  it("ausente devuelve estadoInicial", async () => {
    expect(await leerEstado(dir)).toEqual(estadoInicial());
  });

  it("escribe y relee igual", async () => {
    const e = { ...estadoInicial(), modo: "gris" as const, poolZona: { "1.2.3.4": "2026-10-21T18:00:00.000Z" } };
    await escribirEstado(dir, e);
    expect(await leerEstado(dir)).toEqual(e);
  });

  it("no deja .tmp tras escribir", async () => {
    await escribirEstado(dir, estadoInicial());
    expect(await readdir(dir)).toEqual(["cf-failover-state.json"]);
  });

  it("estado parcial se completa con los valores iniciales", async () => {
    await writeFile(
      path.join(dir, "cf-failover-state.json"),
      JSON.stringify({ modo: "gris", ultimoCambioEn: "2026-10-21T18:00:00.000Z" }),
    );
    expect(await leerEstado(dir)).toEqual({
      ...estadoInicial(),
      modo: "gris",
      ultimoCambioEn: "2026-10-21T18:00:00.000Z",
    });
  });

  it("estado antiguo con firmaDiscrepanciaCanario/alertas.canario carga y siembra el pool", async () => {
    const OBS = "2026-10-21T22:00:00.000Z";
    await writeFile(
      path.join(dir, "cf-failover-state.json"),
      JSON.stringify({
        ...estadoInicial(),
        poolZona: undefined,
        modo: "gris",
        ultimaObservacionValidaEn: OBS,
        ipsCanario: ["104.21.32.62"],
        ipsSitioNaranja: ["188.114.96.2", "104.21.32.62"],
        firmaDiscrepanciaCanario: "104.21.99.99",
        alertas: { canario: OBS, lectura: OBS },
      }),
    );
    const e = await leerEstado(dir);
    expect(e.poolZona).toEqual({ "188.114.96.2": OBS, "104.21.32.62": OBS });
    expect(e.alertas).toEqual({ lectura: OBS });
    expect(e).not.toHaveProperty("ipsCanario");
    expect(e).not.toHaveProperty("ipsSitioNaranja");
    expect(e).not.toHaveProperty("firmaDiscrepanciaCanario");
    expect(e.modo).toBe("gris");
  });

  it("pool ya presente: no se resiembra con los campos antiguos", async () => {
    const pool = { "1.1.1.1": "2026-10-21T18:00:00.000Z" };
    await writeFile(
      path.join(dir, "cf-failover-state.json"),
      JSON.stringify({ poolZona: pool, ipsSitioNaranja: ["2.2.2.2"] }),
    );
    expect((await leerEstado(dir)).poolZona).toEqual(pool);
  });

  it("corrupto lanza", async () => {
    await writeFile(path.join(dir, "cf-failover-state.json"), "{no json");
    await expect(leerEstado(dir)).rejects.toThrow();
  });
});
