import { BlockList, isIP } from "node:net";

/**
 * Lista de IPs bloqueadas publicada por hayahora.futbol (`blocked-any.txt`).
 * Puro: sin I/O. La descarga vive en fuente-bloqueo.ts.
 */
export type ListaBloqueo = { contiene(ip: string): boolean; tamano: number };

function familia(ip: string): "ipv4" | "ipv6" | null {
  const v = isIP(ip);
  return v === 4 ? "ipv4" : v === 6 ? "ipv6" : null;
}

/**
 * Content-Type aceptable: ausente o texto que no sea `text/html` (casi siempre
 * una página de error). hayahora sirve `blocked-any.txt` SIN cabecera
 * Content-Type (comprobado 2026-10-21), así que la ausencia no invalida: la
 * validez la decide el parseo línea a línea.
 */
function esContentTypeTexto(contentType: string | null): boolean {
  if (contentType === null) return true;
  const media = contentType.split(";")[0].trim().toLowerCase();
  return media.startsWith("text/") && media !== "text/html";
}

/**
 * Parsea el cuerpo de la lista. Una IP (v4/v6) o CIDR por línea; se ignoran
 * líneas vacías y comentarios (`#`). Cuerpo vacío = lista limpia (lo normal
 * fuera de jornada).
 *
 * Devuelve `null` (observación inválida, NO lista limpia) si el Content-Type
 * viene y no es de texto (o es `text/html`), o si alguna línea no parsea: un
 * cambio de formato no puede confundirse con "no hay bloqueo". Content-Type
 * ausente (`null`) se acepta.
 */
export function parsearListaBloqueo(
  cuerpo: string,
  contentType: string | null,
): ListaBloqueo | null {
  if (!esContentTypeTexto(contentType)) return null;

  const bl = new BlockList();
  let tamano = 0;

  for (const bruta of cuerpo.split(/\r?\n/)) {
    const linea = bruta.trim();
    if (linea === "" || linea.startsWith("#")) continue;

    const barra = linea.indexOf("/");
    if (barra === -1) {
      const fam = familia(linea);
      if (!fam) return null;
      bl.addAddress(linea, fam);
    } else {
      const red = linea.slice(0, barra);
      const prefijoTxt = linea.slice(barra + 1);
      const fam = familia(red);
      if (!fam || !/^\d{1,3}$/.test(prefijoTxt)) return null;
      const prefijo = Number(prefijoTxt);
      if (prefijo > (fam === "ipv4" ? 32 : 128)) return null;
      bl.addSubnet(red, prefijo, fam);
    }
    tamano += 1;
  }

  return {
    tamano,
    contiene(ip: string): boolean {
      const fam = familia(ip);
      return fam ? bl.check(ip, fam) : false;
    },
  };
}
