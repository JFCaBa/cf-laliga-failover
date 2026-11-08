import { describe, it, expect } from "vitest";
import { ejecutarVigilancia, type DepsVigilancia } from "../src/ejecutar";
import { estadoInicial, type EstadoFailover } from "../src/estado";
import { parsearListaBloqueo, type ListaBloqueo } from "../src/lista";
import { ErrorCloudflare, type ClienteCloudflare, type RegistroDns } from "../src/cloudflare-api";
import type { Alerta } from "../src/decidir";

const T0 = new Date("2026-10-21T18:00:00.000Z");
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

const APEX = "example.es";
const WWW = "www.example.es";
const CANARIO = "cf-canary.example.es";
const TURNSTILE = "challenges.cloudflare.com";
const IPS_CF = ["188.114.96.11", "188.114.97.11"];
const IPS_TS = ["104.18.94.41"];

type Opciones = {
  modoInicial?: "naranja" | "gris";
  estado?: Partial<EstadoFailover>;
  lista?: string[] | null;
};

function crearMundo(o: Opciones = {}) {
  const proxied = (o.modoInicial ?? "naranja") === "naranja";
  const registros: RegistroDns[] = [
    { id: "1", name: APEX, type: "A", proxied },
    { id: "2", name: WWW, type: "CNAME", proxied },
    { id: "3", name: CANARIO, type: "A", proxied: true },
  ];
  const m = {
    reloj: T0,
    estado: o.estado ? { ...estadoInicial(), ...o.estado } : (null as EstadoFailover | null),
    escritos: [] as EstadoFailover[],
    alertas: [] as Alerta[],
    pings: [] as ("ok" | "fail")[],
    resueltos: [] as string[],
    patches: [] as { name: string; proxied: boolean }[],
    lecturasRegistros: 0,
    lista: (o.lista === undefined ? [] : o.lista) as string[] | null,
    // hooks
    alLeerRegistros: null as null | ((n: number) => void),
    alFijar: null as null | ((r: RegistroDns, p: boolean, n: number) => void),
    ignorarPatchDe: null as string | null,
    falloResolver: new Set<string>(),
    falloEnviar: false,
    colgarEnvio: false,
    registros,
  };

  const cloudflare: ClienteCloudflare = {
    async registros(nombres) {
      m.lecturasRegistros += 1;
      m.alLeerRegistros?.(m.lecturasRegistros);
      return m.registros.filter((r) => nombres.includes(r.name)).map((r) => ({ ...r }));
    },
    async fijarProxied(r, p) {
      m.patches.push({ name: r.name, proxied: p });
      m.alFijar?.(r, p, m.patches.length);
      if (r.name === m.ignorarPatchDe) return;
      const real = m.registros.find((x) => x.id === r.id);
      if (real) real.proxied = p;
    },
  };

  const deps: DepsVigilancia = {
    ahora: () => m.reloj,
    leerEstado: async () => (m.estado ? structuredClone(m.estado) : estadoInicial()),
    escribirEstado: async (e) => {
      m.estado = structuredClone(e);
      m.escritos.push(structuredClone(e));
    },
    cloudflare,
    nombres: [APEX, WWW],
    resolver: async (nombre) => {
      m.resueltos.push(nombre);
      if (m.falloResolver.has(nombre)) throw new Error(`timeout ${nombre}`);
      if (nombre === TURNSTILE) return IPS_TS;
      return IPS_CF;
    },
    canario: CANARIO,
    turnstileHost: TURNSTILE,
    leerLista: async (): Promise<ListaBloqueo | null> =>
      m.lista === null ? null : parsearListaBloqueo(m.lista.join("\n"), "text/plain"),
    enviarAlerta: async (a) => {
      if (m.colgarEnvio) return new Promise<void>(() => {}); // simula proceso muerto
      if (m.falloEnviar) throw new Error("SMTP caído");
      m.alertas.push(a);
    },
    ping: async (r) => {
      m.pings.push(r);
    },
    log: () => {},
  };
  return { m, deps };
}

const APLICAR = { aplicar: true, actuarDns: true, simularBloqueo: false };
const gestionados = (m: { registros: RegistroDns[] }) =>
  m.registros.filter((r) => r.name !== CANARIO).map((r) => r.proxied);

describe("ejecutarVigilancia", () => {
  it("sin aplicar no escribe, no alerta, no toca DNS", async () => {
    const { m, deps } = crearMundo({ lista: [IPS_CF[0]] });
    const r = await ejecutarVigilancia(deps, { aplicar: false, actuarDns: true, simularBloqueo: false });
    expect(r).toEqual({ accion: "a-gris", actuo: false });
    expect(m.escritos).toEqual([]);
    expect(m.alertas).toEqual([]);
    expect(m.pings).toEqual([]);
    expect(m.patches).toEqual([]);
  });

  it("flag apagada con aplicar: escribe estado y no toca DNS", async () => {
    const { m, deps } = crearMundo({ lista: [IPS_CF[0]] });
    const r = await ejecutarVigilancia(deps, { aplicar: true, actuarDns: false, simularBloqueo: false });
    expect(r).toEqual({ accion: "a-gris", actuo: false });
    expect(m.escritos.length).toBeGreaterThan(0);
    expect(m.estado?.sitioBloqueado).toBe(true);
    expect(m.estado?.transicion).toBeNull();
    expect(m.patches).toEqual([]);
    expect(m.pings).toEqual(["ok"]);
  });

  it("a-gris: persiste transicion antes de tocar DNS", async () => {
    const { m, deps } = crearMundo({ lista: [IPS_CF[0]] });
    const vistos: (string | undefined)[] = [];
    m.alFijar = () => vistos.push(m.estado?.transicion?.haciaModo);
    await ejecutarVigilancia(deps, APLICAR);
    expect(vistos).toEqual(["gris", "gris"]);
  });

  it("a-gris verificado: modo gris, alerta cambio, ping", async () => {
    const { m, deps } = crearMundo({
      lista: [IPS_CF[0]],
      estado: { modo: "naranja", fallosApiConsecutivos: 2 },
    });
    const r = await ejecutarVigilancia(deps, APLICAR);
    expect(r).toEqual({ accion: "a-gris", actuo: true });
    expect(gestionados(m)).toEqual([false, false]);
    expect(m.estado).toMatchObject({
      modo: "gris",
      transicion: null,
      ultimoCambioEn: T0.toISOString(),
      fallosApiConsecutivos: 0,
      comprobacionesLimpias: 0,
    });
    const cambio = m.alertas.find((a) => a.tipo === "cambio");
    expect(cambio?.asunto).toBe("[failover] Paso a gris");
    expect(cambio?.texto).toContain(IPS_CF[0]);
    expect(cambio?.texto).toContain("21/10/2026");
    expect(cambio?.texto).toContain("20:00"); // 18:00Z = 20:00 Madrid (CEST)
    expect(m.estado?.alertas.cambio).toBe(T0.toISOString());
    expect(m.pings).toEqual(["ok"]);
  });

  it("gris y vuelta a naranja en menos de 1 h mandan dos emails de cambio (sin dedup) y el de vuelta incluye la duración", async () => {
    const { m, deps } = crearMundo({ lista: [IPS_CF[0]] });
    await ejecutarVigilancia(deps, APLICAR);
    m.lista = [];
    const acciones = [];
    for (const t of [10, 20, 35]) {
      m.reloj = min(t);
      acciones.push((await ejecutarVigilancia(deps, APLICAR)).accion);
    }
    expect(acciones).toEqual([null, null, "a-naranja"]);
    expect(gestionados(m)).toEqual([true, true]);
    const cambios = m.alertas.filter((a) => a.tipo === "cambio");
    expect(cambios.map((a) => a.asunto)).toEqual([
      "[failover] Paso a gris",
      "[failover] Vuelta a naranja",
    ]);
    expect(cambios[1].texto).toContain("35 min");
    expect(m.estado).toMatchObject({ modo: "naranja", transicion: null, ultimoCambioEn: min(35).toISOString() });
  });

  it("verificación con registros mal deja transicion, alerta mixto y ping fail", async () => {
    const { m, deps } = crearMundo({ lista: [IPS_CF[0]] });
    m.ignorarPatchDe = WWW;
    const r = await ejecutarVigilancia(deps, APLICAR);
    expect(r.actuo).toBe(true);
    expect(m.estado?.transicion?.haciaModo).toBe("gris");
    expect(m.alertas.map((a) => a.tipo)).toContain("mixto");
    expect(m.alertas.map((a) => a.tipo)).not.toContain("cambio");
    expect(m.pings).toEqual(["fail"]);
  });

  it("el segundo PATCH lanza: conserva transicion, suma fallo API, persiste, ping fail", async () => {
    const { m, deps } = crearMundo({ lista: [IPS_CF[0]] });
    m.alFijar = (_r, _p, n) => {
      if (n === 2) throw new ErrorCloudflare("Cloudflare 500");
    };
    const r = await ejecutarVigilancia(deps, APLICAR);
    expect(r.actuo).toBe(true);
    expect(m.estado?.transicion?.haciaModo).toBe("gris");
    expect(m.estado?.fallosApiConsecutivos).toBe(1);
    expect(m.alertas.map((a) => a.tipo)).not.toContain("api");
    expect(m.pings).toEqual(["fail"]);
  });

  it("la relectura lanza: igual que el anterior", async () => {
    const { m, deps } = crearMundo({ lista: [IPS_CF[0]] });
    m.alLeerRegistros = (n) => {
      if (n === 2) throw new ErrorCloudflare("Cloudflare red: TimeoutError");
    };
    await ejecutarVigilancia(deps, APLICAR);
    expect(m.patches).toHaveLength(2);
    expect(m.estado?.transicion?.haciaModo).toBe("gris");
    expect(m.estado?.fallosApiConsecutivos).toBe(1);
    expect(m.pings).toEqual(["fail"]);
  });

  it("error de API al leer registros: suma fallo; al 3º alerta api y ping fail", async () => {
    const { m, deps } = crearMundo();
    m.alLeerRegistros = () => {
      throw new ErrorCloudflare("Cloudflare 503");
    };
    for (const t of [0, 5, 10]) {
      m.reloj = min(t);
      const r = await ejecutarVigilancia(deps, APLICAR);
      expect(r).toEqual({ accion: null, actuo: false });
    }
    expect(m.estado?.fallosApiConsecutivos).toBe(3);
    expect(m.alertas.map((a) => a.tipo)).toEqual(["api"]);
    expect(m.alertas[0].texto).toContain("Cloudflare 503");
    expect(m.pings).toEqual(["ok", "ok", "fail"]);
    expect(m.resueltos).toEqual([]);
    // 4º fallo en menos de 1 h: alerta api deduplicada
    m.reloj = min(15);
    await ejecutarVigilancia(deps, APLICAR);
    expect(m.alertas.map((a) => a.tipo)).toEqual(["api"]);
    // Lectura correcta: el contador vuelve a 0
    m.alLeerRegistros = null;
    m.reloj = min(20);
    await ejecutarVigilancia(deps, APLICAR);
    expect(m.estado?.fallosApiConsecutivos).toBe(0);
    expect(m.pings.at(-1)).toBe("ok");
  });

  it("error de configuración (falta un registro) cuenta como fallo de API con el motivo en la alerta", async () => {
    const { m, deps } = crearMundo({ estado: { fallosApiConsecutivos: 2 } });
    m.registros = m.registros.filter((r) => r.name !== WWW);
    await ejecutarVigilancia(deps, APLICAR);
    expect(m.estado?.fallosApiConsecutivos).toBe(3);
    expect(m.alertas[0].tipo).toBe("api");
    expect(m.alertas[0].texto).toContain(`Falta el registro gestionado ${WWW}`);
    expect(m.pings).toEqual(["fail"]);
  });

  it("una excepción inesperada se propaga sin ping", async () => {
    const { m, deps } = crearMundo();
    m.alLeerRegistros = () => {
      throw new TypeError("bug");
    };
    await expect(ejecutarVigilancia(deps, APLICAR)).rejects.toThrow("bug");
    expect(m.pings).toEqual([]);
  });

  it("lista inválida 1ª y 2ª vez: ping ok; 3ª: ping fail y nunca ok en esa ejecución", async () => {
    const { m, deps } = crearMundo({ lista: null });
    for (const t of [0, 5]) {
      m.reloj = min(t);
      await ejecutarVigilancia(deps, APLICAR);
    }
    expect(m.pings).toEqual(["ok", "ok"]);
    m.reloj = min(10);
    await ejecutarVigilancia(deps, APLICAR);
    expect(m.pings).toEqual(["ok", "ok", "fail"]);
    expect(m.alertas.map((a) => a.tipo)).toEqual(["lectura"]);
  });

  it("enviarAlerta lanza: no marca la alerta, la ejecución sigue y hace ping fail con un cambio pendiente", async () => {
    const { m, deps } = crearMundo({ lista: [IPS_CF[0]] });
    m.falloEnviar = true;
    const r = await ejecutarVigilancia(deps, APLICAR);
    expect(r).toEqual({ accion: "a-gris", actuo: true });
    expect(m.estado?.modo).toBe("gris");
    expect(m.estado?.alertas).toEqual({});
    expect(m.estado?.alertasPendientes.map((a) => a.asunto)).toEqual(["[failover] Paso a gris"]);
    expect(m.pings).toEqual(["fail"]);
    // Al enviarse el pendiente, el heartbeat vuelve a ok.
    m.falloEnviar = false;
    m.reloj = min(5);
    await ejecutarVigilancia(deps, APLICAR);
    expect(m.estado?.alertasPendientes).toEqual([]);
    expect(m.pings).toEqual(["fail", "ok"]);
  });

  it("cambio no enviado se reintenta en la siguiente ejecución y se borra al enviarse", async () => {
    const { m, deps } = crearMundo({ lista: [IPS_CF[0]] });
    m.falloEnviar = true;
    await ejecutarVigilancia(deps, APLICAR);
    expect(m.estado?.alertasPendientes).toHaveLength(1);
    // Sigue caído: se conserva, sin duplicar.
    m.reloj = min(5);
    await ejecutarVigilancia(deps, APLICAR);
    expect(m.estado?.alertasPendientes).toHaveLength(1);
    expect(m.alertas).toEqual([]);
    // Vuelve el SMTP: se envía y se borra.
    m.falloEnviar = false;
    m.reloj = min(10);
    await ejecutarVigilancia(deps, APLICAR);
    expect(m.alertas.map((a) => a.asunto)).toEqual(["[failover] Paso a gris"]);
    expect(m.estado?.alertasPendientes).toEqual([]);
    expect(m.estado?.alertas.cambio).toBe(min(10).toISOString());
  });

  it("si el proceso muere tras persistir el cambio, el email queda en alertasPendientes y se envía en la siguiente ejecución", async () => {
    const { m, deps } = crearMundo({ lista: [IPS_CF[0]], estado: { modo: "naranja" } });
    m.colgarEnvio = true;
    void ejecutarVigilancia(deps, APLICAR); // nunca termina: el "proceso" muere en el envío
    await new Promise((r) => setTimeout(r, 20));
    // La escritura que registra el cambio completado ya lleva el email en la cola.
    const primeraCompletada = m.escritos.find((e) => e.modo === "gris" && e.transicion === null);
    expect(primeraCompletada?.alertasPendientes.map((a) => a.asunto)).toEqual(["[failover] Paso a gris"]);
    expect(m.pings).toEqual([]);
    // Siguiente ejecución (proceso nuevo): envía desde la cola y la vacía.
    m.colgarEnvio = false;
    m.lista = [];
    m.reloj = min(5);
    await ejecutarVigilancia(deps, APLICAR);
    expect(m.alertas.map((a) => a.asunto)).toEqual(["[failover] Paso a gris"]);
    expect(m.estado?.alertasPendientes).toEqual([]);
    expect(m.pings).toEqual(["ok"]);
  });

  it("las alertas cambio pendientes se limitan a las 10 más recientes", async () => {
    const viejas = Array.from({ length: 10 }, (_, i) => ({
      tipo: "cambio" as const,
      asunto: `vieja ${i}`,
      texto: "",
    }));
    const { m, deps } = crearMundo({ lista: [IPS_CF[0]], estado: { modo: "naranja", alertasPendientes: viejas } });
    m.falloEnviar = true;
    await ejecutarVigilancia(deps, APLICAR);
    const asuntos = m.estado?.alertasPendientes.map((a) => a.asunto);
    expect(asuntos).toHaveLength(10);
    expect(asuntos?.[0]).toBe("vieja 1");
    expect(asuntos?.at(-1)).toBe("[failover] Paso a gris");
  });

  it("dos limpias, fallo de API, una limpia → sigue en gris (la racha se rompe)", async () => {
    const { m, deps } = crearMundo({
      modoInicial: "gris",
      estado: { modo: "gris", ultimoCambioEn: min(-120).toISOString() },
    });
    const acciones = [];
    for (const t of [0, 5]) {
      m.reloj = min(t);
      acciones.push((await ejecutarVigilancia(deps, APLICAR)).accion);
    }
    expect(m.estado?.comprobacionesLimpias).toBe(2);
    m.alLeerRegistros = () => {
      throw new ErrorCloudflare("Cloudflare 503");
    };
    m.reloj = min(10);
    acciones.push((await ejecutarVigilancia(deps, APLICAR)).accion);
    expect(m.estado?.comprobacionesLimpias).toBe(0);
    m.alLeerRegistros = null;
    m.reloj = min(15);
    acciones.push((await ejecutarVigilancia(deps, APLICAR)).accion);
    expect(acciones).toEqual([null, null, null, null]);
    expect(gestionados(m)).toEqual([false, false]);
    expect(m.estado?.comprobacionesLimpias).toBe(1);
    // Hacen falta otras dos limpias seguidas.
    for (const t of [20, 25]) {
      m.reloj = min(t);
      acciones.push((await ejecutarVigilancia(deps, APLICAR)).accion);
    }
    expect(acciones.at(-1)).toBe("a-naranja");
  });

  it("resolver Turnstile lanza: igual pasa a gris si el canario está bloqueado", async () => {
    const { m, deps } = crearMundo({ lista: [IPS_CF[0]] });
    m.falloResolver.add(TURNSTILE);
    const r = await ejecutarVigilancia(deps, APLICAR);
    expect(r).toEqual({ accion: "a-gris", actuo: true });
    expect(m.estado?.modo).toBe("gris");
    expect(m.estado?.fallosLecturaConsecutivos).toBe(0);
  });

  it("resolver el canario lanza: observación inválida, sin cambio", async () => {
    const { m, deps } = crearMundo({ lista: [IPS_CF[0]] });
    m.falloResolver.add(CANARIO);
    const r = await ejecutarVigilancia(deps, APLICAR);
    expect(r).toEqual({ accion: null, actuo: false });
    expect(m.estado?.fallosLecturaConsecutivos).toBe(1);
    expect(m.patches).toEqual([]);
  });

  it("simularBloqueo provoca a-gris con lista vacía", async () => {
    const { m, deps } = crearMundo({ lista: [] });
    const r = await ejecutarVigilancia(deps, { ...APLICAR, simularBloqueo: true });
    expect(r).toEqual({ accion: "a-gris", actuo: true });
    expect(gestionados(m)).toEqual([false, false]);
  });

  it("en gris no resuelve apex/www", async () => {
    const { m, deps } = crearMundo({
      modoInicial: "gris",
      estado: { modo: "gris", ultimoCambioEn: T0.toISOString() },
    });
    await ejecutarVigilancia(deps, APLICAR);
    expect(m.resueltos).not.toContain(APEX);
    expect(m.resueltos).not.toContain(WWW);
    expect(m.resueltos).toContain(CANARIO);
  });

  it("transición pendiente con DNS ya en gris: se da por completada sin acción y con una sola alerta", async () => {
    const { m, deps } = crearMundo({
      modoInicial: "gris",
      estado: { modo: "gris", transicion: { haciaModo: "gris", iniciadaEn: min(-5).toISOString() } },
    });
    const r = await ejecutarVigilancia(deps, APLICAR);
    expect(r).toEqual({ accion: null, actuo: false });
    expect(m.patches).toEqual([]);
    expect(m.estado).toMatchObject({ modo: "gris", transicion: null, ultimoCambioEn: T0.toISOString() });
    expect(m.alertas.map((a) => a.tipo)).toEqual(["mixto"]);
    expect(m.pings).toEqual(["ok"]);
  });

  it("transición pendiente hacia naranja con DNS ya naranja: completada, sin revertir a gris", async () => {
    const { m, deps } = crearMundo({
      modoInicial: "naranja",
      estado: {
        modo: "gris",
        ultimoCambioEn: min(-60).toISOString(),
        transicion: { haciaModo: "naranja", iniciadaEn: min(-5).toISOString() },
      },
    });
    const r = await ejecutarVigilancia(deps, APLICAR);
    expect(r).toEqual({ accion: null, actuo: false });
    expect(m.patches).toEqual([]);
    expect(m.estado).toMatchObject({ modo: "naranja", transicion: null, ultimoCambioEn: T0.toISOString() });
    expect(m.alertas.map((a) => a.tipo)).toEqual(["mixto"]);
    expect(m.pings).toEqual(["ok"]);
  });

  it("transición hacia naranja ya aplicada + bloqueo en la misma ejecución → a-gris", async () => {
    const { m, deps } = crearMundo({
      modoInicial: "naranja",
      lista: [IPS_CF[0]],
      estado: {
        modo: "gris",
        ultimoCambioEn: min(-60).toISOString(),
        transicion: { haciaModo: "naranja", iniciadaEn: min(-5).toISOString() },
      },
    });
    const r = await ejecutarVigilancia(deps, APLICAR);
    expect(r).toEqual({ accion: "a-gris", actuo: true });
    expect(gestionados(m)).toEqual([false, false]);
    expect(m.estado).toMatchObject({ modo: "gris", transicion: null });
    // El cambio sale primero: se envía desde la cola (outbox).
    expect(m.alertas.map((a) => a.tipo)).toEqual(["cambio", "mixto"]);
  });

  describe("pool de IPs de la zona (dos juegos de IPs, prod 21-oct)", () => {
    const PAR_A = ["104.21.32.62", "172.67.184.60"];
    const PAR_B = ["188.114.96.2", "188.114.97.2"];
    function mundo() {
      const w = crearMundo({ estado: { modo: "naranja" } });
      const respuestas: Record<string, string[]> = { [CANARIO]: PAR_A, [APEX]: PAR_B, [WWW]: PAR_B };
      w.deps.resolver = async (nombre) => (nombre === TURNSTILE ? IPS_TS : respuestas[nombre]);
      return { ...w, respuestas };
    }

    it("canario y sitio con juegos distintos: ningún aviso, pool con ambos", async () => {
      const { m, deps } = mundo();
      await ejecutarVigilancia(deps, APLICAR);
      m.reloj = min(2 * 60);
      await ejecutarVigilancia(deps, APLICAR);
      expect(m.alertas).toEqual([]);
      expect(m.pings).toEqual(["ok", "ok"]);
      expect(Object.keys(m.estado?.poolZona ?? {}).sort()).toEqual([...PAR_A, ...PAR_B].sort());
    });

    it("bloqueo de una IP del pool no vista en esta ejecución → gris, el email la lista", async () => {
      const { m, deps, respuestas } = mundo();
      await ejecutarVigilancia(deps, APLICAR);
      // Ahora todos los nombres salen con el par A; la lista bloquea el par B.
      for (const n of [CANARIO, APEX, WWW]) respuestas[n] = PAR_A;
      m.lista = [PAR_B[1]];
      m.reloj = min(5);
      const r = await ejecutarVigilancia(deps, APLICAR);
      expect(r).toEqual({ accion: "a-gris", actuo: true });
      expect(gestionados(m)).toEqual([false, false]);
      const cambio = m.alertas.find((a) => a.tipo === "cambio");
      expect(cambio?.texto).toContain(`IPs del pool de la zona bloqueadas: ${PAR_B[1]}`);
    });
  });
});

describe("correcciones de la revisión por consenso", () => {
  it("canario ausente: errorConfig (el CLI sale con 2, no con 0)", async () => {
    const { m, deps } = crearMundo();
    m.registros.splice(2, 1); // sin canario
    const r = await ejecutarVigilancia(deps, APLICAR);
    expect(r).toEqual({ accion: null, actuo: false, errorConfig: true });
  });

  it("error de API (no de configuración): sin errorConfig", async () => {
    const { m, deps } = crearMundo();
    m.alLeerRegistros = () => {
      throw new ErrorCloudflare("Cloudflare 500");
    };
    const r = await ejecutarVigilancia(deps, APLICAR);
    expect(r.errorConfig).toBeUndefined();
  });

  it("alerta que no es de cambio y falla al enviar: heartbeat fail", async () => {
    // Transición pendiente cuyo destino ya es el modo real → alerta `mixto`, que no se encola.
    const { m, deps } = crearMundo({
      modoInicial: "gris",
      estado: { modo: "naranja", transicion: { haciaModo: "gris", iniciadaEn: min(-5).toISOString() } },
    });
    m.falloEnviar = true;
    await ejecutarVigilancia(deps, APLICAR);
    expect(m.pings.at(-1)).toBe("fail");
  });
});
