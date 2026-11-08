import { describe, it, expect } from "vitest";
import { parsearListaBloqueo } from "../src/lista";

describe("parsearListaBloqueo", () => {
  it("cuerpo vacío con text/plain es lista limpia", () => {
    const l = parsearListaBloqueo("", "text/plain; charset=utf-8");
    expect(l).not.toBeNull();
    expect(l!.tamano).toBe(0);
    expect(l!.contiene("188.114.96.11")).toBe(false);
  });

  it("IPv4, IPv6 y CIDR", () => {
    const l = parsearListaBloqueo(
      "188.114.96.11\n2a06:98c1:3120::b\n104.16.0.0/13\n# comentario\n",
      "text/plain",
    );
    expect(l).not.toBeNull();
    expect(l!.tamano).toBe(3);
    expect(l!.contiene("188.114.96.11")).toBe(true);
    expect(l!.contiene("2a06:98c1:3120::b")).toBe(true);
    expect(l!.contiene("104.16.1.1")).toBe(true);
    expect(l!.contiene("1.1.1.1")).toBe(false);
    expect(l!.contiene("no-es-ip")).toBe(false);
  });

  it("acepta CRLF, espacios y CIDR IPv6", () => {
    const l = parsearListaBloqueo("  1.2.3.4  \r\n\r\n2606:4700::/32\r\n", "TEXT/PLAIN");
    expect(l).not.toBeNull();
    expect(l!.contiene("1.2.3.4")).toBe(true);
    expect(l!.contiene("2606:4700::1")).toBe(true);
  });

  it("línea basura → null", () => {
    expect(parsearListaBloqueo("188.114.96.11\n<html>\n", "text/plain")).toBeNull();
  });

  it("prefijo CIDR fuera de rango → null", () => {
    expect(parsearListaBloqueo("104.16.0.0/33\n", "text/plain")).toBeNull();
    expect(parsearListaBloqueo("2a06::/129\n", "text/plain")).toBeNull();
    expect(parsearListaBloqueo("104.16.0.0/\n", "text/plain")).toBeNull();
    expect(parsearListaBloqueo("999.16.0.0/8\n", "text/plain")).toBeNull();
  });

  it("content-type text/html → null", () => {
    expect(parsearListaBloqueo("188.114.96.11\n", "text/html")).toBeNull();
  });

  it("contentType null con IPs válidas es lista válida (hayahora no manda Content-Type)", () => {
    const l = parsearListaBloqueo("188.114.96.11\n", null);
    expect(l).not.toBeNull();
    expect(l!.contiene("188.114.96.11")).toBe(true);
    expect(parsearListaBloqueo("", null)?.tamano).toBe(0);
  });

  it("contentType null con cuerpo HTML → null (las líneas no parsean)", () => {
    expect(parsearListaBloqueo("<!doctype html>\n<html><body>Error</body></html>\n", null)).toBeNull();
  });

  it("content-type no textual → null", () => {
    expect(parsearListaBloqueo("188.114.96.11\n", "application/octet-stream")).toBeNull();
    expect(parsearListaBloqueo("188.114.96.11\n", "application/json")).toBeNull();
  });
});
