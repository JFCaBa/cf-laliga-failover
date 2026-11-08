import { describe, it, expect } from "vitest";
import { actualizarPool, decidir, marcarAlertaEnviada, type Observacion } from "../src/decidir";
import { estadoInicial, POOL_RETENCION_MS, type EstadoFailover, type ModoDns } from "../src/estado";
import { parsearListaBloqueo } from "../src/lista";

const T0 = new Date("2026-10-21T18:00:00.000Z");
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

const CANARIO = ["188.114.96.11", "188.114.97.11"];
const TURNSTILE = ["104.18.94.41"];

function obs(
  bloqueadas: string[],
  o: Partial<Omit<Observacion, "lista">> = {},
): Observacion {
  const lista = parsearListaBloqueo(bloqueadas.join("\n"), "text/plain");
  if (!lista) throw new Error("lista de prueba inválida");
  return {
    lista,
    ipsCanario: o.ipsCanario ?? CANARIO,
    ipsSitio: o.ipsSitio ?? [],
    ipsTurnstile: o.ipsTurnstile === undefined ? TURNSTILE : o.ipsTurnstile,
  };
}

function estado(p: Partial<EstadoFailover> = {}): EstadoFailover {
  return { ...estadoInicial(), ...p };
}

const gris = (p: Partial<EstadoFailover> = {}) =>
  estado({ modo: "gris", ultimoCambioEn: T0.toISOString(), ...p });

function run(
  e: EstadoFailover,
  modoDns: ModoDns,
  observacion: Observacion | null,
  ahora: Date = T0,
) {
  return decidir({ estado: e, ahora, modoDns, observacion });
}

const tipos = (r: { alertas: { tipo: string }[] }) => r.alertas.map((a) => a.tipo);

describe("decidir — naranja", () => {
  it("naranja + IP del canario bloqueada → a-gris, limpias a 0", () => {
    const r = run(
      estado({ modo: "naranja", comprobacionesLimpias: 7 }),
      "naranja",
      obs(["188.114.96.11"], { ipsSitio: CANARIO }),
    );
    expect(r.accion).toBe("a-gris");
    expect(r.estado.comprobacionesLimpias).toBe(0);
    expect(r.estado.sitioBloqueado).toBe(true);
    expect(r.estado.ultimaObservacionValidaEn).toBe(T0.toISOString());
    // decidir no fija el modo destino: lo hace el orquestador tras verificar.
    expect(r.estado.modo).toBe("naranja");
    expect(r.estado.ultimoCambioEn).toBeNull();
    expect(tipos(r)).toEqual([]);
  });

  it("naranja + IP de apex bloqueada aunque el canario no → a-gris", () => {
    const r = run(
      estado({ modo: "naranja" }),
      "naranja",
      obs(["104.21.1.1"], { ipsSitio: ["104.21.1.1"] }),
    );
    expect(r.accion).toBe("a-gris");
    expect(r.estado.sitioBloqueado).toBe(true);
  });

  it("naranja con canario y apex de juegos distintos → sin alerta, ambos al pool", () => {
    const r = run(
      estado({ modo: "naranja" }),
      "naranja",
      obs([], { ipsSitio: ["104.21.1.1", "172.67.1.1"] }),
    );
    expect(r.accion).toBeNull();
    expect(tipos(r)).toEqual([]);
    expect(Object.keys(r.estado.poolZona).sort()).toEqual(
      ["104.21.1.1", "172.67.1.1", ...CANARIO].sort(),
    );
    expect(r.estado.comprobacionesLimpias).toBe(1);
  });

  it("naranja limpia → null y sincroniza el modo desde la API", () => {
    const r = run(estadoInicial(), "naranja", obs([], { ipsSitio: CANARIO }));
    expect(r.accion).toBeNull();
    expect(r.estado.modo).toBe("naranja");
    expect(r.estado.ultimaEjecucionEn).toBe(T0.toISOString());
  });
});

describe("decidir — gris", () => {
  it("gris no añade al pool las IPs de apex/www (resuelven al origen)", () => {
    const r = run(gris(), "gris", obs([], { ipsSitio: ["51.0.0.1"] }), min(5));
    expect(Object.keys(r.estado.poolZona).sort()).toEqual([...CANARIO].sort());
  });

  it("gris + 3 limpias + 30 min → a-naranja", () => {
    const r = run(gris({ comprobacionesLimpias: 2 }), "gris", obs([]), min(30));
    expect(r.estado.comprobacionesLimpias).toBe(3);
    expect(r.accion).toBe("a-naranja");
    expect(r.estado.modo).toBe("gris");
    expect(r.estado.ultimoCambioEn).toBe(T0.toISOString());
  });

  it("gris + 3 limpias + 29 min → null", () => {
    const r = run(gris({ comprobacionesLimpias: 2 }), "gris", obs([]), min(29));
    expect(r.estado.comprobacionesLimpias).toBe(3);
    expect(r.accion).toBeNull();
  });

  it("gris + 2 limpias + 2 h → null", () => {
    const r = run(gris({ comprobacionesLimpias: 1 }), "gris", obs([]), min(120));
    expect(r.estado.comprobacionesLimpias).toBe(2);
    expect(r.accion).toBeNull();
  });

  it("lista con contenido seguida de 3 vacías válidas vuelve a naranja", () => {
    let e = gris();
    let r = run(e, "gris", obs(["188.114.96.11"]), min(25));
    expect(r.accion).toBeNull();
    e = r.estado;
    r = run(e, "gris", obs([]), min(30));
    expect(r.accion).toBeNull();
    e = r.estado;
    r = run(e, "gris", obs([]), min(35));
    expect(r.accion).toBeNull();
    e = r.estado;
    r = run(e, "gris", obs([]), min(40));
    expect(r.accion).toBe("a-naranja");
  });

  it("gris sin observación válida > 30 min → alerta gris-sin-datos y nunca a-naranja", () => {
    const e = gris({
      comprobacionesLimpias: 5,
      ultimaObservacionValidaEn: T0.toISOString(),
    });
    const r30 = run(e, "gris", null, min(30));
    expect(r30.accion).toBeNull();
    expect(tipos(r30)).not.toContain("gris-sin-datos");

    const r31 = run(e, "gris", null, min(31));
    expect(r31.accion).toBeNull();
    expect(tipos(r31)).toContain("gris-sin-datos");
    expect(r31.estado.comprobacionesLimpias).toBe(0);

    const r10h = run(e, "gris", null, min(600));
    expect(r10h.accion).toBeNull();
    expect(tipos(r10h)).toContain("gris-sin-datos");
  });

  it("gris-sin-datos sin ninguna observación válida previa cuenta desde ultimoCambioEn", () => {
    const r = run(gris(), "gris", null, min(45));
    expect(tipos(r)).toContain("gris-sin-datos");
  });

  it("gris sin ultimoCambioEn fija ahora y espera 30 min", () => {
    const r1 = run(
      estado({ modo: "gris", ultimoCambioEn: null, comprobacionesLimpias: 5 }),
      "gris",
      obs([]),
      T0,
    );
    expect(r1.estado.ultimoCambioEn).toBe(T0.toISOString());
    expect(r1.accion).toBeNull();

    const r2 = run(r1.estado, "gris", obs([]), min(29));
    expect(r2.accion).toBeNull();
    const r3 = run(r2.estado, "gris", obs([]), min(30));
    expect(r3.accion).toBe("a-naranja");
  });

  it("gris encontrado por la API sin historia de gris → reinicia la espera", () => {
    const r = run(
      estado({ modo: "naranja", ultimoCambioEn: min(-600).toISOString(), comprobacionesLimpias: 9 }),
      "gris",
      obs([]),
      T0,
    );
    expect(r.estado.modo).toBe("gris");
    expect(r.estado.ultimoCambioEn).toBe(T0.toISOString());
    expect(r.accion).toBeNull();
  });
});

describe("decidir — observación inválida y alertas de lectura", () => {
  it("observación inválida pone limpias a 0, no toca ultimaObservacionValidaEn y suma fallo", () => {
    const antes = min(-5).toISOString();
    const r = run(
      gris({ comprobacionesLimpias: 2, ultimaObservacionValidaEn: antes, sitioBloqueado: true }),
      "gris",
      null,
      min(40),
    );
    expect(r.estado.comprobacionesLimpias).toBe(0);
    expect(r.estado.ultimaObservacionValidaEn).toBe(antes);
    expect(r.estado.fallosLecturaConsecutivos).toBe(1);
    expect(r.estado.sitioBloqueado).toBe(true);
    expect(r.accion).toBeNull();
  });

  it("observación válida reinicia el contador de fallos de lectura", () => {
    const r = run(estado({ modo: "naranja", fallosLecturaConsecutivos: 4 }), "naranja", obs([]));
    expect(r.estado.fallosLecturaConsecutivos).toBe(0);
  });

  it("naranja + observación inválida → nunca a-gris", () => {
    const r = run(estado({ modo: "naranja" }), "naranja", null);
    expect(r.accion).toBeNull();
  });

  it("3er fallo de lectura → alerta lectura; 4º dentro de la hora → sin alerta; a la 1 h → recordatorio", () => {
    let e = estado({ modo: "naranja" });
    let r = run(e, "naranja", null, min(0));
    expect(tipos(r)).toEqual([]);
    r = run(r.estado, "naranja", null, min(5));
    expect(tipos(r)).toEqual([]);
    r = run(r.estado, "naranja", null, min(10));
    expect(r.estado.fallosLecturaConsecutivos).toBe(3);
    expect(tipos(r)).toEqual(["lectura"]);
    expect(r.alertas[0].asunto.startsWith("[failover]")).toBe(true);
    e = marcarAlertaEnviada(r.estado, { tipo: "lectura" }, min(10));

    r = run(e, "naranja", null, min(15));
    expect(tipos(r)).toEqual([]);
    r = run(r.estado, "naranja", null, min(69));
    expect(tipos(r)).toEqual([]);
    r = run(r.estado, "naranja", null, min(70));
    expect(tipos(r)).toEqual(["lectura"]);
  });
});

describe("decidir — mixto y transición pendiente", () => {
  it("mixto → a-gris, ultimoCambioEn = ahora, alerta mixto", () => {
    const r = run(
      estado({ modo: "naranja", ultimoCambioEn: min(-600).toISOString(), comprobacionesLimpias: 4 }),
      "mixto",
      obs([]),
    );
    expect(r.accion).toBe("a-gris");
    expect(r.estado.ultimoCambioEn).toBe(T0.toISOString());
    expect(r.estado.comprobacionesLimpias).toBe(0);
    expect(tipos(r)).toEqual(["mixto"]);
  });

  it("mixto con observación inválida → a-gris igualmente", () => {
    const r = run(estado({ modo: "gris" }), "mixto", null);
    expect(r.accion).toBe("a-gris");
  });

  it("transicion pendiente hacia otro modo → a-gris, ultimoCambioEn = ahora", () => {
    const r = run(
      estado({
        modo: "naranja",
        ultimoCambioEn: min(-600).toISOString(),
        transicion: { haciaModo: "gris", iniciadaEn: min(-5).toISOString() },
        comprobacionesLimpias: 3,
      }),
      "naranja",
      obs([], { ipsSitio: CANARIO }),
    );
    expect(r.accion).toBe("a-gris");
    expect(r.estado.ultimoCambioEn).toBe(T0.toISOString());
    expect(r.estado.comprobacionesLimpias).toBe(0);
    expect(r.estado.transicion).not.toBeNull();
    expect(tipos(r)).toEqual(["mixto"]);
  });

  it("transición hacia naranja con DNS ya naranja se da por completada sin acción", () => {
    const r = run(
      gris({
        ultimoCambioEn: min(-600).toISOString(),
        transicion: { haciaModo: "naranja", iniciadaEn: min(-5).toISOString() },
        comprobacionesLimpias: 3,
      }),
      "naranja",
      obs([], { ipsSitio: CANARIO }),
    );
    expect(r.accion).toBeNull();
    expect(r.estado.transicion).toBeNull();
    expect(r.estado.modo).toBe("naranja");
    expect(r.estado.ultimoCambioEn).toBe(T0.toISOString());
    expect(tipos(r)).toEqual(["mixto"]);
    expect(r.alertas[0].asunto).toMatch(/completada/);
  });

  it("transición hacia gris con DNS ya gris se da por completada", () => {
    const r = run(
      estado({
        modo: "naranja",
        ultimoCambioEn: min(-600).toISOString(),
        transicion: { haciaModo: "gris", iniciadaEn: min(-5).toISOString() },
      }),
      "gris",
      obs([]),
    );
    expect(r.accion).toBeNull();
    expect(r.estado.transicion).toBeNull();
    expect(r.estado.modo).toBe("gris");
    expect(r.estado.ultimoCambioEn).toBe(T0.toISOString());
    expect(tipos(r)).toEqual(["mixto"]);
  });

  it("transición hacia naranja ya aplicada + bloqueo en la misma ejecución → a-gris", () => {
    const r = run(
      gris({
        ultimoCambioEn: min(-600).toISOString(),
        transicion: { haciaModo: "naranja", iniciadaEn: min(-5).toISOString() },
        comprobacionesLimpias: 3,
      }),
      "naranja",
      obs(["188.114.96.11"], { ipsSitio: CANARIO }),
    );
    expect(r.accion).toBe("a-gris");
    expect(r.estado.transicion).toBeNull();
    expect(r.estado.modo).toBe("naranja");
    expect(r.estado.sitioBloqueado).toBe(true);
    expect(r.estado.comprobacionesLimpias).toBe(0);
    expect(tipos(r)).toEqual(["mixto"]);
  });

  it("transición hacia gris ya aplicada nunca da a-naranja en la misma ejecución", () => {
    const r = run(
      estado({
        modo: "gris",
        ultimoCambioEn: min(-600).toISOString(),
        transicion: { haciaModo: "gris", iniciadaEn: min(-5).toISOString() },
        comprobacionesLimpias: 10,
      }),
      "gris",
      obs([]),
    );
    expect(r.accion).toBeNull();
    expect(r.estado.ultimoCambioEn).toBe(T0.toISOString());
    expect(r.estado.comprobacionesLimpias).toBe(11);
  });

  it("transición completada respeta el dedup de la alerta mixto", () => {
    const r = run(
      estado({
        modo: "naranja",
        transicion: { haciaModo: "gris", iniciadaEn: min(-5).toISOString() },
        alertas: { mixto: min(-10).toISOString() },
      }),
      "gris",
      obs([]),
    );
    expect(r.estado.transicion).toBeNull();
    expect(tipos(r)).toEqual([]);
  });
});

describe("decidir — Turnstile", () => {
  it("turnstileBloqueado refleja la lista y no provoca acción", () => {
    const r = run(
      estado({ modo: "naranja" }),
      "naranja",
      obs(["104.18.94.41"], { ipsSitio: CANARIO }),
    );
    expect(r.estado.turnstileBloqueado).toBe(true);
    expect(r.estado.ipsTurnstile).toEqual(TURNSTILE);
    expect(r.estado.sitioBloqueado).toBe(false);
    expect(r.accion).toBeNull();

    const limpio = run(r.estado, "naranja", obs([], { ipsSitio: CANARIO }), min(5));
    expect(limpio.estado.turnstileBloqueado).toBe(false);
  });

  it("ipsTurnstile null no impide pasar a gris y conserva turnstileBloqueado", () => {
    const r = run(
      estado({ modo: "naranja", turnstileBloqueado: true, ipsTurnstile: TURNSTILE }),
      "naranja",
      obs(["188.114.97.11"], { ipsSitio: CANARIO, ipsTurnstile: null }),
    );
    expect(r.accion).toBe("a-gris");
    expect(r.estado.turnstileBloqueado).toBe(true);
    expect(r.estado.ipsTurnstile).toEqual(TURNSTILE);
  });
});

describe("decidir — pureza y marcado de alertas", () => {
  it("decidir no marca alertas; marcarAlertaEnviada sí", () => {
    const e = estado({ modo: "naranja", fallosLecturaConsecutivos: 2 });
    const r1 = run(e, "naranja", null, T0);
    expect(tipos(r1)).toEqual(["lectura"]);
    expect(r1.estado.alertas).toEqual({});

    const r2 = run(r1.estado, "naranja", null, min(5));
    expect(tipos(r2)).toEqual(["lectura"]);

    const marcado = marcarAlertaEnviada(r2.estado, { tipo: "lectura" }, min(5));
    expect(marcado.alertas.lectura).toBe(min(5).toISOString());
    expect(r2.estado.alertas).toEqual({});
    const r3 = run(marcado, "naranja", null, min(10));
    expect(tipos(r3)).toEqual([]);
  });

  it("no muta el estado de entrada", () => {
    const e = gris({ comprobacionesLimpias: 2, poolZona: { "104.21.1.1": T0.toISOString() } });
    const copia = structuredClone(e);
    run(e, "gris", obs([]), min(30));
    run(e, "mixto", null, min(30));
    expect(e).toEqual(copia);
  });
});

describe("decidir — pool de IPs de la zona", () => {
  // Prod 21-oct: cada nombre de la zona sale con uno de dos juegos, al azar por consulta.
  const PAR_A = ["104.21.32.62", "172.67.184.60", "2606:4700:3036::ac43:b83c"];
  const PAR_B = ["188.114.96.2", "188.114.97.2", "2a06:98c1:3120::2"];
  const naranja = (p: Partial<EstadoFailover> = {}) => estado({ modo: "naranja", ...p });

  it("pool acumula IPs vistas en ejecuciones distintas", () => {
    const r1 = run(naranja(), "naranja", obs([], { ipsCanario: PAR_A, ipsSitio: PAR_A }), T0);
    const r2 = run(r1.estado, "naranja", obs([], { ipsCanario: PAR_B, ipsSitio: PAR_B }), min(5));
    expect(Object.keys(r2.estado.poolZona).sort()).toEqual([...PAR_A, ...PAR_B].sort());
    expect(r2.estado.poolZona[PAR_A[0]]).toBe(T0.toISOString());
    expect(r2.estado.poolZona[PAR_B[0]]).toBe(min(5).toISOString());
  });

  it("pool poda entradas de más de 7 días", () => {
    const viejo = new Date(T0.getTime() - POOL_RETENCION_MS - 1).toISOString();
    const justo = new Date(T0.getTime() - POOL_RETENCION_MS).toISOString();
    const pool = { "1.1.1.1": viejo, "2.2.2.2": justo, "3.3.3.3": "basura" };
    expect(actualizarPool(pool, ["4.4.4.4"], T0)).toEqual({
      "2.2.2.2": justo,
      "4.4.4.4": T0.toISOString(),
    });
    const r = run(naranja({ poolZona: pool }), "naranja", obs([], { ipsCanario: PAR_A, ipsSitio: PAR_A }));
    expect(r.estado.poolZona["1.1.1.1"]).toBeUndefined();
  });

  it("IP podada del pool ya no bloquea", () => {
    const viejo = new Date(T0.getTime() - POOL_RETENCION_MS - 60_000).toISOString();
    const r = run(
      naranja({ poolZona: { "188.114.96.2": viejo } }),
      "naranja",
      obs(["188.114.96.2"], { ipsCanario: PAR_A, ipsSitio: PAR_A }),
    );
    expect(r.estado.sitioBloqueado).toBe(false);
    expect(r.accion).toBeNull();
  });

  it("bloqueo de una IP del pool no vista en esta ejecución → a-gris", () => {
    const r1 = run(naranja(), "naranja", obs([], { ipsCanario: PAR_B, ipsSitio: PAR_B }), T0);
    // Esta ejecución todos los nombres salen con el par A; el bloqueado es el B.
    const r2 = run(
      r1.estado,
      "naranja",
      obs(["188.114.97.2"], { ipsCanario: PAR_A, ipsSitio: PAR_A }),
      min(5),
    );
    expect(r2.estado.sitioBloqueado).toBe(true);
    expect(r2.accion).toBe("a-gris");
  });

  it("en gris, ejecución que no ve la IP bloqueada no cuenta como limpia (pool)", () => {
    const e = gris({
      poolZona: Object.fromEntries([...PAR_A, ...PAR_B].map((ip) => [ip, T0.toISOString()])),
      comprobacionesLimpias: 2,
    });
    const r = run(e, "gris", obs(["188.114.96.2"], { ipsCanario: PAR_A }), min(60));
    expect(r.estado.sitioBloqueado).toBe(true);
    expect(r.estado.comprobacionesLimpias).toBe(0);
    expect(r.accion).toBeNull();
  });

  it("vuelta a naranja solo con el pool entero limpio 3 veces y 30 min", () => {
    const BLOQ = ["188.114.96.2"];
    let e = gris({
      poolZona: Object.fromEntries([...PAR_A, ...PAR_B].map((ip) => [ip, T0.toISOString()])),
    });
    // El canario solo ve el par A, pero el B (en el pool) sigue bloqueado: nunca limpia.
    for (const m of [10, 20, 30, 40, 50]) {
      const r = run(e, "gris", obs(BLOQ, { ipsCanario: PAR_A }), min(m));
      expect(r.estado.comprobacionesLimpias).toBe(0);
      expect(r.accion).toBeNull();
      e = r.estado;
    }
    // La lista se vacía: 3 limpias seguidas (y > 30 min en gris) → a-naranja.
    let r = run(e, "gris", obs([], { ipsCanario: PAR_A }), min(55));
    expect(r.accion).toBeNull();
    r = run(r.estado, "gris", obs([], { ipsCanario: PAR_B }), min(60));
    expect(r.accion).toBeNull();
    r = run(r.estado, "gris", obs([], { ipsCanario: PAR_A }), min(65));
    expect(r.estado.comprobacionesLimpias).toBe(3);
    expect(r.accion).toBe("a-naranja");
  });
});
