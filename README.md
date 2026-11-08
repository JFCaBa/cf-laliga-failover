# cf-laliga-failover

Watchdog que **pasa tu web de Cloudflare naranja (proxied) a gris (DNS-only) cuando LaLiga bloquea las IPs de Cloudflare en España**, y la devuelve a naranja cuando el bloqueo termina.

Pensado para webs que sirven a público en España y están detrás de Cloudflare.

## El problema

Durante los partidos de LaLiga, algunos operadores españoles bloquean por orden judicial IPs compartidas de Cloudflare. Tu web puede dejar de abrir para parte de tus usuarios aunque tu servidor y Cloudflare estén perfectamente.

[hayahora.futbol](https://hayahora.futbol) publica la lista de IPs bloqueadas. Este proyecto la lee cada pocos minutos, comprueba si las IPs con las que Cloudflare sirve **tu zona** están en esa lista y, si lo están, pone tus registros en gris: el tráfico va directo a tu servidor, sin pasar por las IPs bloqueadas.

## Antes de usarlo, lee esto

**Gris significa sin Cloudflare.** Mientras tu web está en gris:

- Se expone la IP real de tu servidor.
- No hay WAF, protección DDoS, caché ni reglas de Cloudflare (redirecciones, Page Rules, Transform Rules…).
- Tu servidor tiene que servir un **certificado TLS válido** para esos nombres (Cloudflare ya no pone el suyo).
- Si usas Turnstile, el widget puede no cargar si `challenges.cloudflare.com` también está bloqueado.

Si eso es inaceptable para tu caso, no lo uses. Si lo aceptas, prepara el origen **antes** (ver [Requisitos](#requisitos-previos)).

**La lista de hayahora.futbol es una observación de un tercero, no una fuente oficial.** Una IP en la lista es un indicio fuerte, no la prueba de que un usuario concreto no llegue. Un cambio de formato de su fichero se trata como observación *inválida*, nunca como «lista limpia»: si no se puede leer, no se cambia nada.

## Cómo funciona

Cada ejecución (pensada para cron cada 5 min):

1. Lee de la API de Cloudflare el modo real de tus registros (naranja, gris o mixto).
2. Resuelve el **canario** y tus registros contra los **NS autoritativos** de tu zona, preguntando a cada NS por separado y uniendo las respuestas.
3. Mantiene un **pool de IPs de la zona**. Cloudflare reparte los nombres de tu zona entre varios juegos de IPs al azar por consulta, así que una respuesta suelta enseña solo una parte. El pool recuerda cada IP vista durante 7 días.
4. Descarga la lista de bloqueo. **Una sola IP del pool en la lista = bloqueado.**
5. Decide:
   - Naranja y bloqueado → **gris**.
   - Gris y **3 observaciones limpias seguidas** y **≥ 30 min** desde el cambio → **naranja**.
   - Sin observación válida (lista ilegible, DNS caído) → no cambia nada; en gris más de 30 min sin datos manda una alerta prioritaria (no vuelve a ciegas).
6. Guarda el estado (JSON, escritura atómica), manda alertas y hace ping a un heartbeat.

Detalles de diseño:

- **Intención primero**: antes de tocar DNS escribe la transición pendiente; si algo falla a medias, la siguiente ejecución converge a gris (el estado seguro).
- **Verifica** releyendo la API tras el cambio.
- **Un solo proceso a la vez**: con `--apply` se re-ejecuta bajo `flock -n` + `timeout`.
- **Dead man's switch**: el ping de heartbeat sirve para que te enteres si el propio watchdog muere o el email falla.
- Solo cambia `proxied` y `ttl` (60 s en gris, automático en naranja). Nunca toca el contenido de los registros.

## Requisitos previos

1. **Node ≥ 20** y `flock` (util-linux; Linux). En macOS el dry-run funciona; `--apply` no.
2. **Certificado válido en el origen** para cada nombre gestionado, comprobado con validación completa:

   ```bash
   curl -sS -o /dev/null -w "%{http_code} %{ssl_verify_result}\n" \
     --resolve tudominio.es:443:IP_DEL_ORIGEN https://tudominio.es/
   ```

   Esperado: un código HTTP y `0`.
3. **Registro canario**: un nombre extra (por defecto `cf-canary.<tu-zona>`) → A a tu origen, **siempre naranja**. No necesita vhost. Sirve para seguir viendo las IPs de Cloudflare de tu zona mientras tus registros reales están en gris. Si falta o está en gris, el watchdog lo trata como error de configuración y no actúa.
4. **Token de API de Cloudflare** con **solo** `Zone → DNS → Edit`, limitado a tu zona.
5. Si tienes un **AAAA propio** en esos nombres, en gris se publicará tal cual: tiene que responder con certificado válido.
6. Revisa las reglas de Cloudflare que **dejan de aplicar en gris** (redirecciones `www` → apex, cabeceras…): lo imprescindible debe estar también en tu servidor.

## Instalación

```bash
git clone https://github.com/JFCaBa/cf-laliga-failover.git
cd cf-laliga-failover
npm ci
npm run build
```

Sin dependencias en tiempo de ejecución (solo Node). Binario: `node dist/bin.js` (o `npx cf-laliga-failover` si lo instalas como paquete).

## Configuración

Todo por variables de entorno.

| Variable | Obligatoria | Qué es |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | sí | Token con `Zone → DNS → Edit`. |
| `CLOUDFLARE_ZONE_ID` | sí | ID de la zona (página Overview en Cloudflare). |
| `CF_FAILOVER_ZONA` | sí | Tu dominio (p. ej. `example.es`); sus NS autoritativos se consultan por DNS. |
| `CF_FAILOVER_REGISTROS` | no | Nombres a conmutar, separados por comas. Defecto: `<zona>,www.<zona>`. |
| `CF_FAILOVER_CANARIO` | no | Registro canario. Defecto: `cf-canary.<zona>`. |
| `CF_FAILOVER_DIR` | no | Directorio del estado y del lock. Defecto: `/var/lib/cf-laliga-failover`. |
| `CF_FAILOVER_WEBHOOK_URL` | no | Webhook para alertas (Slack, Discord, Mattermost…). Sin él, las alertas van al log. |
| `CF_FAILOVER_HEARTBEAT_URL` | no | URL de heartbeat (healthchecks.io, Better Stack, Uptime Kuma). Manda `<url>/fail` si hay problemas. |
| `CF_FAILOVER_CONTACTO` | no | Email que se añade al User-Agent al descargar la lista (buena educación con su servidor). |

Ejemplo en [`examples/env.example`](examples/env.example).

## Uso: tres niveles, de menos a más riesgo

```bash
# 1. Dry-run: mide e imprime. No escribe nada, no toca DNS. Funciona en cualquier sistema.
node dist/bin.js

# 2. Modo medición: guarda estado, manda alertas y heartbeat, pero NO toca DNS.
node dist/bin.js --apply

# 3. Failover real: además conmuta DNS naranja <-> gris.
node dist/bin.js --apply --cambiar-dns
```

**Recomendado**: deja el modo 2 corriendo **al menos una jornada con partido** y mira `cf-failover-state.json` antes de pasar al 3: `ultimaObservacionValidaEn` reciente, fallos a 0, `poolZona` con las IPs de tu zona y qué pasó con `sitioBloqueado` durante el partido.

### Simulacro

Fuera de jornada, con `--cambiar-dns`:

```bash
node dist/bin.js --apply --cambiar-dns --simular-bloqueo
```

Trata las IPs del canario como bloqueadas: tus registros pasan a gris. Luego, con ejecuciones normales, tras 3 limpias seguidas y ≥ 30 min vuelven a naranja solos. Comprueba que el origen responde directo y que llegan las dos alertas.

### Cron

```cron
*/5 * * * * cd /opt/cf-laliga-failover && set -a && . ./.env && set +a && node dist/bin.js --apply --cambiar-dns >> /var/log/cf-laliga-failover.log 2>&1
```

Ver también un servicio + timer de systemd en [`examples/systemd`](examples/systemd).

El directorio de estado se crea solo si no existe (con systemd, `StateDirectory=` ya lo hace).

Códigos de salida: `0` ok; `1` error de la API de Cloudflare, lista inválida, fallo no controlado o lock ocupado; `2` configuración (faltan variables, no hay `flock`, canario o registros mal puestos en Cloudflare).

## Salir a mano

**Antes de cambiar DNS a mano, detén el cron o ejecútalo sin `--cambiar-dns`.** Si no, el watchdog revierte tu intervención.

1. Quita `--cambiar-dns` del cron (o páralo).
2. Espera a que acabe la ejecución en curso: `until flock -n $CF_FAILOVER_DIR/cf-failover.lock true; do sleep 5; done`.
3. Pon los registros como quieras desde el panel de Cloudflare.
4. Si vuelves a naranja con una `transicion` pendiente guardada, borra el estado **bajo el lock**: `flock $CF_FAILOVER_DIR/cf-failover.lock rm $CF_FAILOVER_DIR/cf-failover-state.json`. La siguiente ejecución arranca sin historia y lee el modo de la API.
5. Vuelve a poner `--cambiar-dns`.

En gris **sin observación válida más de 30 min** llega una alerta prioritaria. **No hay vuelta forzada a naranja por tiempo**: volver a ciegas tumbaría la web si el bloqueo sigue. Comprueba desde una conexión española si las IPs de Cloudflare abren y decide tú.

## Uso como librería

Las piezas son funciones con el I/O inyectado; la máquina de estados es pura y no tiene reloj propio.

```ts
import {
  estadoInicial,
  decidir,
  parsearListaBloqueo,
} from "cf-laliga-failover";

const lista = parsearListaBloqueo("104.21.32.62\n172.67.0.0/16\n", null)!;

const { estado, accion, alertas } = decidir({
  estado: estadoInicial(),
  ahora: new Date(),
  modoDns: "naranja", // lo que diga la API de Cloudflare
  observacion: {
    lista,
    ipsCanario: ["104.21.32.62", "172.67.184.60"],
    ipsSitio: [],
    ipsTurnstile: null,
  },
});

console.log(accion); // "a-gris": el pool tiene una IP que está en la lista
```

Más ejemplos en [`examples/`](examples).

## Limitaciones conocidas

- Depende de un tercero (hayahora.futbol) y de su formato.
- Solo mira IPs de Cloudflare vistas en tu zona; no mide si un usuario concreto llega o no.
- No hay un modo «aceptar Turnstile no disponible»: si `challenges.cloudflare.com` está bloqueado el widget fallará en gris; el estado lo registra (`turnstileBloqueado`).
- Pensado para una zona y unos pocos registros (apex + `www`), no para cientos de nombres.

## Desarrollo

```bash
npm ci
npm test        # vitest
npm run typecheck
npm run build
```

## Licencia

MIT. Origen del proyecto: se extrajo del arreglo que usa [serfuncionario.com](https://serfuncionario.com) en producción.
