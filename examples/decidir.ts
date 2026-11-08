// Ejemplo: la máquina de estados pura, sin red ni disco.
// Ejecuta con: npx tsx examples/decidir.ts
import { decidir, estadoInicial, parsearListaBloqueo } from "../src/index";

const lista = parsearListaBloqueo("104.21.32.62\n", null);
if (!lista) throw new Error("lista inválida");

const ahora = new Date();

// 1. Naranja y el pool contiene una IP bloqueada → a gris.
const r1 = decidir({
  estado: estadoInicial(),
  ahora,
  modoDns: "naranja",
  observacion: { lista, ipsCanario: ["104.21.32.62"], ipsSitio: [], ipsTurnstile: null },
});
console.log("1.", r1.accion); // "a-gris"

// 2. Ya en gris, lista limpia: hacen falta 3 limpias seguidas y 30 min.
let estado = { ...r1.estado, modo: "gris" as const, ultimoCambioEn: ahora.toISOString() };
const limpia = parsearListaBloqueo("", null)!;
for (let i = 1; i <= 7; i++) {
  const t = new Date(ahora.getTime() + i * 5 * 60_000);
  const r = decidir({
    estado,
    ahora: t,
    modoDns: "gris",
    observacion: { lista: limpia, ipsCanario: ["172.67.184.60"], ipsSitio: [], ipsTurnstile: null },
  });
  console.log(`2. +${i * 5} min`, r.accion, `limpias=${r.estado.comprobacionesLimpias}`);
  estado = r.estado;
}
