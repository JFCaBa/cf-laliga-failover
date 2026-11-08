// API pública: piezas reutilizables sin el CLI.
export { decidir, actualizarPool, ipsBloqueadasPool, marcarAlertaEnviada } from "./decidir.js";
export type { Alerta, Observacion } from "./decidir.js";
export { estadoInicial } from "./estado.js";
export type { EstadoFailover, ModoDns } from "./estado.js";
export { parsearListaBloqueo } from "./lista.js";
export type { ListaBloqueo } from "./lista.js";
export { leerListaBloqueo } from "./fuente-bloqueo.js";
export { resolverAutoritativo } from "./dns.js";
export { crearClienteCloudflare } from "./cloudflare-api.js";
export type { ClienteCloudflare, RegistroDns } from "./cloudflare-api.js";
export { ejecutarVigilancia } from "./ejecutar.js";
export type { DepsVigilancia } from "./ejecutar.js";
export { enviarWebhook } from "./notificar.js";
