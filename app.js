/* ==========================================================================
   VientoBQ Live — Lógica
   --------------------------------------------------------------------------
   1. Configuración y constantes físicas (SI)
   2. Motor físico: potencia eólica, descomposición del viento, arrastre
   3. Utilidades y clasificación semántica (verde / amarillo / rojo)
   4. Capa de datos (Open-Meteo)
   5. Túnel de viento virtual (canvas + SVG)
   6. Renderizado de telemetría, timeline y hora óptima
   7. Exportación CSV, ciclo de actualización y arranque
   Regla: el estado interno es SI (m/s, N, W). km/h sólo se muestra en pantalla.
   ========================================================================== */

(() => {
  "use strict";

  /* ------------------------------------------------------------------
     1. CONFIGURACIÓN
     ------------------------------------------------------------------ */
  const CONFIG = Object.freeze({
    API_URL: "https://api.open-meteo.com/v1/forecast",
    TIMEZONE: "America/Bogota",
    REFRESH_MS: 5 * 60 * 1000,
    TIMEOUT_MS: 15000,
    HORIZON_H: 12,
    RIDER_SPEED_KMH: 25,
    RIDER_HEADING_DEG: 0,      // el ciclista apunta al Norte (marco de referencia del túnel)
    LEVELS: { SPEED_WARN_KMH: 15, SPEED_DANGER_KMH: 25, GUST_WARN_KMH: 30, GUST_DANGER_KMH: 40 },
    GAUGE_MAX_KMH: 40,
    DEPARTURES: [
      { offset: 0, label: "AHORA" },
      { offset: 1, label: "+1 H" },
      { offset: 3, label: "+3 H" },
    ],
    STORAGE_KEY: "vientobq:location",
  });

  const PHYSICS = Object.freeze({
    RHO: 1.18,   // densidad del aire [kg/m³]
    CDA: 0.32,   // área frontal efectiva × coef. de arrastre, ciclista en ruta [m²]
    G: 9.81,
    CRR: 0.005,          // coef. de rodadura, neumático de ruta sobre asfalto
    RIDER_KG: 75,        // masa estándar del ciclista [kg]
    BIKE_KG: 10,         // masa estándar de la bicicleta [kg]
  });

  const LOCATIONS = Object.freeze([
    { id: "cuc",        name: "Campus CUC",            short: "CUC",              lat: 10.9935, lon: -74.7935 },
    { id: "malecon",    name: "Gran Malecón",          short: "Gran Malecón",     lat: 11.0250, lon: -74.7960 },
    { id: "mallorquin", name: "Ciénaga de Mallorquín", short: "Mallorquín",       lat: 11.0380, lon: -74.8500 },
    { id: "bocas",      name: "Bocas de Ceniza",       short: "Bocas de Ceniza",  lat: 11.1070, lon: -74.8520 },
    { id: "puerto",     name: "Puerto Colombia",       short: "Puerto Colombia",  lat: 10.9880, lon: -74.9540 },
  ]);

  // Destino de ejemplo (coordenadas del humedal / alternativa si el origen es Mallorquín)
  const DESTINATION = Object.freeze({ name: "Ciénaga de Mallorquín", short: "Mallorquín", lat: 11.0380, lon: -74.8500 });
  const ALT_DESTINATION = Object.freeze({ name: "Puerto Colombia", short: "Puerto Colombia", lat: 10.9880, lon: -74.9540 });

  /* ------------------------------------------------------------------
     2. MOTOR FÍSICO
     ------------------------------------------------------------------ */
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  const Physics = {
    kmhToMs: (kmh) => kmh / 3.6,
    msToKmh: (ms) => ms * 3.6,

    /** Densidad de potencia eólica  P/A = ½ · ρ · v³  [W/m²], v en m/s */
    windPowerDensity: (vMs, rho = PHYSICS.RHO) => 0.5 * rho * vMs * vMs * vMs,

    /**
     * Descompone el viento en el marco del ciclista.
     * dirDeg = procedencia meteorológica (de dónde sopla). El viento viaja hacia dirDeg+180.
     * head > 0: viento de frente · cross > 0: viento que llega desde la derecha.
     */
    components(vMs, dirDeg, headingDeg = CONFIG.RIDER_HEADING_DEG) {
      const rel = rad(dirDeg - headingDeg);
      return { head: vMs * Math.cos(rel), cross: vMs * Math.sin(rel) };
    },

    /** Fuerza de arrastre con signo:  F = ½ ρ CdA · v·|v|  (negativa = empuje a favor) */
    dragForce(vAirMs, cda = PHYSICS.CDA, rho = PHYSICS.RHO) {
      return 0.5 * rho * cda * vAirMs * Math.abs(vAirMs);
    },

    /**
     * Carga aerodinámica sobre el ciclista que avanza a `riderMs`.
     * Velocidad del aire respecto a la bici a lo largo de la marcha: u + v_frontal.
     */
    cyclistLoad(windMs, dirDeg, riderMs = Physics.kmhToMs(CONFIG.RIDER_SPEED_KMH), headingDeg = CONFIG.RIDER_HEADING_DEG, massKg = totalMassKg()) {
      const { head, cross } = Physics.components(windMs, dirDeg, headingDeg);
      const along = riderMs + head;
      const force = Physics.dragForce(along);
      const calm = Physics.dragForce(riderMs);
      const rolling = PHYSICS.CRR * massKg * PHYSICS.G;   // F_r = μ · m · g (terreno plano)
      const total = force + rolling;
      const power = Math.max(0, total) * riderMs;          // P = F · v
      return {
        head, cross,
        force, calm, rolling, total, massKg,
        deltaForce: force - calm,
        ratio: force / calm,
        power,
        wPerKg: power / massKg,
        apparentSpeed: Math.hypot(cross, along),     // |v_aparente|
        apparentAngle: (deg(Math.atan2(cross, along)) + 360) % 360,
      };
    },

    /** Distancia de círculo máximo [m] */
    haversine(lat1, lon1, lat2, lon2) {
      const R = 6371000;
      const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(a));
    },
  };

  /* ------------------------------------------------------------------
     3. UTILIDADES Y SEMÁNTICA
     ------------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);
  const nf = (d) => new Intl.NumberFormat("es-CO", { minimumFractionDigits: d, maximumFractionDigits: d });
  const f0 = nf(0), f1 = nf(1), f2 = nf(2);
  const pad2 = (n) => String(n).padStart(2, "0");
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const normDeg = (d) => ((d % 360) + 360) % 360;
  const TAU = Math.PI * 2;

  /**
   * Limitador de frecuencia de ejecución (Throttle: leading + trailing edge).
   * Desvincula cálculos de alta frecuencia (como orientación a 60-120Hz o GPS)
   * limitando la ejecución a un máximo de 2 veces por segundo (500ms).
   */
  function throttle(func, waitMs = 500) {
    let timeout = null;
    let previous = 0;
    let lastArgs = null;
    let lastThis = null;

    return function (...args) {
      const now = Date.now();
      const remaining = waitMs - (now - previous);
      lastArgs = args;
      lastThis = this;

      if (remaining <= 0 || remaining > waitMs) {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        previous = now;
        func.apply(lastThis, lastArgs);
      } else if (!timeout) {
        timeout = setTimeout(() => {
          previous = Date.now();
          timeout = null;
          func.apply(lastThis, lastArgs);
        }, remaining);
      }
    };
  }

  const CARD = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const cardinalOf = (d) => CARD[Math.round(normDeg(d) / 22.5) % 16];
  const bearingText = (d) => `${pad2(Math.round(normDeg(d))).padStart(3, "0")}° ${cardinalOf(d)}`;

  const RANK = { ok: 0, warn: 1, danger: 2 };

  /** Verde < 15 km/h · Amarillo 15–25 · Rojo > 25 */
  function speedLevel(kmh) {
    const L = CONFIG.LEVELS;
    return kmh < L.SPEED_WARN_KMH ? "ok" : kmh <= L.SPEED_DANGER_KMH ? "warn" : "danger";
  }
  function gustLevel(kmh) {
    const L = CONFIG.LEVELS;
    return kmh < L.GUST_WARN_KMH ? "ok" : kmh < L.GUST_DANGER_KMH ? "warn" : "danger";
  }

  /** Estado general de la ruta a partir de velocidad sostenida y ráfaga. */
  function routeStatus(p) {
    const vK = Physics.msToKmh(p.speedMs), gK = Physics.msToKmh(p.gustMs);
    const sl = speedLevel(vK), gl = gustLevel(gK);
    const level = RANK[sl] >= RANK[gl] ? sl : gl;
    let text;
    if (level === "ok") text = "Ruta despejada";
    else if (level === "warn") text = RANK[gl] > RANK[sl] ? "Precaución: ráfagas moderadas" : "Precaución: viento moderado";
    else text = gl === "danger" ? "Peligro: ráfagas fuertes" : "Peligro: viento fuerte";

    const { head } = Physics.components(p.speedMs, p.dirDeg);
    const tag = head >= 0 ? "de frente" : "a favor";
    const detail = `${f1.format(vK)} km/h · ráfaga ${f1.format(gK)} km/h · ${f1.format(Math.abs(head))} m/s ${tag}`;
    return { level, text, detail };
  }

  function setText(id, value, animate = false) {
    const el = $(id);
    if (!el) return;
    if (el.textContent === value) return;
    el.textContent = value;
    if (animate) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
  }
  const setLevel = (el, level) => { if (el) el.dataset.level = level; };

  const timeFmt = new Intl.DateTimeFormat("es-CO", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: CONFIG.TIMEZONE });
  const dateFmt = new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "short", timeZone: CONFIG.TIMEZONE });

  /* ------------------------------------------------------------------
     4. CAPA DE DATOS
     ------------------------------------------------------------------ */
  const state = {
    location: LOCATIONS[0],
    series: [],          // 0..12 h desde ahora, en SI
    selected: 0,         // índice fijado con el slider
    hover: null,         // índice previsualizado con el cursor
    lastSuccess: null,
    nextRefreshAt: null,
    seq: 0,
    controller: null,
    timer: null,
    isWatchMode: false,
    watchHeading: 0,
    watchSpeedKmh: CONFIG.RIDER_SPEED_KMH,
    riderKg: null,       // null = usar valor estándar
    bikeKg: null,
  };

  /** Masa total del sistema ciclista + bici [kg]; vacío/inválido → estándar. */
  function validMass(v, lo, hi) { return Number.isFinite(v) && v >= lo && v <= hi ? v : null; }
  function totalMassKg() {
    return (state.riderKg ?? PHYSICS.RIDER_KG) + (state.bikeKg ?? PHYSICS.BIKE_KG);
  }

  const viewIndex = () => (state.hover ?? state.selected);
  const viewPoint = () => state.series[viewIndex()] || null;

  function buildUrl({ lat, lon }) {
    const q = new URLSearchParams({
      latitude: lat.toFixed(4),
      longitude: lon.toFixed(4),
      current: "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
      hourly: "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
      wind_speed_unit: "ms",              // SI directo: sin conversiones intermedias
      timezone: CONFIG.TIMEZONE,
      forecast_days: "2",
    });
    return `${CONFIG.API_URL}?${q}`;
  }

  async function fetchWeather(location, signal) {
    const res = await fetch(buildUrl(location), { signal, cache: "no-store" });
    let body = null;
    try { body = await res.json(); } catch { /* sin JSON */ }
    if (!res.ok || body?.error) throw new Error(body?.reason || `HTTP ${res.status}`);
    if (!body?.current || !body?.hourly?.time?.length) throw new Error("Respuesta sin datos de viento.");
    return body;
  }

  /** Serie de 13 puntos (ahora + 12 h). El punto 0 usa `current`; el resto, `hourly`. */
  function processPayload(data) {
    const c = data.current, h = data.hourly;
    const key = `${c.time.slice(0, 13)}:00`;
    let idx = h.time.indexOf(key);
    if (idx < 0) idx = h.time.reduce((acc, t, i) => (t <= c.time ? i : acc), 0);

    const series = [];
    for (let off = 0; off <= CONFIG.HORIZON_H; off++) {
      const i = idx + off;
      if (i >= h.time.length) break;
      const iso = off === 0 ? c.time : h.time[i];
      const speed = off === 0 ? c.wind_speed_10m : h.wind_speed_10m[i];
      const gust = off === 0 ? c.wind_gusts_10m : h.wind_gusts_10m[i];
      const dir = off === 0 ? c.wind_direction_10m : h.wind_direction_10m[i];
      if (speed == null || dir == null) continue;
      series.push({
        offset: off,
        iso,
        hhmm: iso.slice(11, 16),
        speedMs: Number(speed),
        gustMs: gust != null ? Number(gust) : Number(speed),
        dirDeg: Number(dir),
      });
    }
    if (!series.length) throw new Error("No hay horas de pronóstico disponibles.");
    return series;
  }

  /* ------------------------------------------------------------------
     5. TÚNEL DE VIENTO VIRTUAL
     Canvas (partículas) entre dos capas SVG (instrumentación y ciclista).
     Las partículas nacen en el borde de barlovento, viajan con el viento
     y se desvían alrededor de la silueta del ciclista.
     ------------------------------------------------------------------ */
  const Tunnel = (() => {
    const R = 262;                      // radio útil (unidades del viewBox)
    const BX = 17, BY = 72;             // semiejes de la silueta (ciclista a escala 1.25)
    const QMAX = 5;                     // zona de influencia (múltiplos de la silueta)
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    let canvas, ctx, arrow, cssSize = 0, dpr = 1;
    let particles = [];
    let last = 0, running = false;
    const cur = { theta: 0, speed: 0, rgb: [113, 113, 122] };
    const tgt = { theta: 0, speed: 0, rgb: [113, 113, 122] };
    let palette = null;

    const hexToRgb = (hex) => {
      const h = hex.replace("#", "").trim();
      const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    function readPalette() {
      const s = getComputedStyle(document.documentElement);
      const get = (v, fb) => hexToRgb(s.getPropertyValue(v) || fb);
      palette = { ok: get("--ok", "#22c55e"), warn: get("--warn", "#eab308"), danger: get("--danger", "#ef4444"), idle: get("--idle", "#71717a") };
    }

    function spawn(p, initial, d, pp) {
      const isMapMode = document.getElementById("tunnel-wrap")?.getAttribute("data-view") === "map";
      const currentR = isMapMode ? 1200 : R;
      if (initial) {
        const r = currentR * Math.sqrt(Math.random()), t = Math.random() * TAU;
        p.x = r * Math.cos(t); p.y = r * Math.sin(t);
      } else {
        const l = (Math.random() * 2 - 1) * currentR * 0.985;
        const a = -Math.sqrt(currentR * currentR - l * l);
        p.x = a * d.x + l * pp.x; p.y = a * d.y + l * pp.y;
      }
      p.trail = [];
      p.k = 0.8 + Math.random() * 0.45;     // factor individual de velocidad
      p.sgn = Math.random() < 0.5 ? -1 : 1; // lado de desvío en el punto de estancamiento
      p.stuck = 0;
      return p;
    }

    function resize() {
      cssSize = Math.max(canvas.clientWidth, canvas.clientHeight); // Usar dimensión máxima para evitar recortes
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      const k = (Math.min(canvas.clientWidth, canvas.clientHeight) * dpr) / 600;
      ctx.setTransform(k, 0, 0, k, (canvas.clientWidth * dpr) / 2, (canvas.clientHeight * dpr) / 2);
    }

    function buildTicks() {
      const g = $("tunnel-ticks");
      const NS = "http://www.w3.org/2000/svg";
      const frag = document.createDocumentFragment();
      for (let a = 0; a < 360; a += 5) {
        const major = a % 30 === 0;
        const r = rad(a - 90), r1 = 266, r2 = major ? 250 : 258;
        const ln = document.createElementNS(NS, "line");
        ln.setAttribute("x1", (r1 * Math.cos(r)).toFixed(2)); ln.setAttribute("y1", (r1 * Math.sin(r)).toFixed(2));
        ln.setAttribute("x2", (r2 * Math.cos(r)).toFixed(2)); ln.setAttribute("y2", (r2 * Math.sin(r)).toFixed(2));
        if (major) ln.setAttribute("class", "major");
        frag.appendChild(ln);
        if (major && a % 90 !== 0) {
          const t = document.createElementNS(NS, "text");
          t.setAttribute("x", (236 * Math.cos(r)).toFixed(2)); t.setAttribute("y", (236 * Math.sin(r)).toFixed(2));
          t.textContent = pad2(a).padStart(3, "0");
          frag.appendChild(t);
        }
      }
      g.appendChild(frag);
    }

    function frame(now) {
      if (!running) return;
      const dt = Math.min((now - last) / 1000 || 0.016, 0.05);
      last = now;

      // Suavizado hacia el objetivo (giro por el camino más corto)
      const kS = reduced ? 1 : Math.min(1, dt * 4);
      const dTheta = ((tgt.theta - cur.theta + 540) % 360) - 180;
      cur.theta = normDeg(cur.theta + dTheta * kS);
      cur.speed += (tgt.speed - cur.speed) * kS;
      for (let i = 0; i < 3; i++) cur.rgb[i] += (tgt.rgb[i] - cur.rgb[i]) * Math.min(1, dt * 6);

      arrow.setAttribute("transform", `rotate(${cur.theta.toFixed(2)})`);
      arrow.style.color = `rgb(${cur.rgb.map(Math.round).join(",")})`;

      // Geometría del flujo: e_up apunta de dónde viene el viento; d = hacia dónde viaja
      const th = rad(cur.theta);
      const d = { x: -Math.sin(th), y: Math.cos(th) };
      const pp = { x: Math.cos(th), y: Math.sin(th) };

      // Densidad dinámica de partículas:
      // Exclusivo de Modo Reloj (Smartwatch): reduce en 65% para optimizar GPU en la vista de reloj.
      // En modo normal / web: mantiene el 100% de las partículas originales intactas.
      const wanted = state.isWatchMode
        ? Math.round((70 + clamp(cur.speed, 0, 12) * 11) * 0.35)
        : Math.round(70 + clamp(cur.speed, 0, 12) * 11);
      while (particles.length < wanted) particles.push(spawn({}, false, d, pp));
      if (particles.length > wanted) particles.length = wanted;

      const speedPx = 40 + 58 * cur.speed;       // unidades/s
      const trailMax = Math.round(clamp(6 + cur.speed * 1.4, 6, 20));
      const [cr, cg, cb] = cur.rgb.map(Math.round);

      const isMapMode = document.getElementById("tunnel-wrap")?.getAttribute("data-view") === "map";
      const currentR = isMapMode ? 1200 : R;

      ctx.clearRect(-1500, -1500, 3000, 3000);
      ctx.save();
      if (!isMapMode) {
        ctx.beginPath(); ctx.arc(0, 0, R + 4, 0, TAU); ctx.clip();
      }
      ctx.lineCap = "round";
      ctx.lineWidth = 1.8;
      
      // Efecto Glow (Neon) para partículas: desactivado solo en Modo Reloj para optimizar GPU
      ctx.shadowColor = `rgb(${cr},${cg},${cb})`;
      ctx.shadowBlur = state.isWatchMode ? 0 : 6;

      for (const p of particles) {
        let vx = d.x * speedPx * p.k, vy = d.y * speedPx * p.k;

        // Desvío alrededor de la silueta (campo repulsivo + deslizamiento tangencial)
        const q = isMapMode ? 10 : (p.x / BX) ** 2 + (p.y / BY) ** 2;
        if (q < QMAX) {
          const gx = p.x / (BX * BX), gy = p.y / (BY * BY);
          const gl = Math.hypot(gx, gy) || 1;
          const nx = gx / gl, ny = gy / gl;
          const s = (QMAX - q) / QMAX;
          const vn = vx * nx + vy * ny;
          if (vn < 0) { const k = Math.min(1, s * 1.5); vx -= nx * vn * k; vy -= ny * vn * k; }
          let tx = -ny, ty = nx;
          const dotT = tx * d.x + ty * d.y;
          if (Math.abs(dotT) < 0.25) { tx *= p.sgn; ty *= p.sgn; }
          else if (dotT < 0) { tx = -tx; ty = -ty; }
          vx += (nx * 0.45 + tx * 0.7) * speedPx * s;
          vy += (ny * 0.45 + ty * 0.7) * speedPx * s;
          p.stuck = q < 1.3 ? p.stuck + dt : 0;
        } else p.stuck = 0;

        if (!reduced) {
          p.x += vx * dt; p.y += vy * dt;
          const last = p.trail[p.trail.length - 1];
          if (!last || Math.hypot(p.x - last[0], p.y - last[1]) > 4) {
            p.trail.push([p.x, p.y]);
            if (p.trail.length > trailMax) p.trail.shift();
          }
        }

        // Reaparición en barlovento al salir del disco o quedar atrapada
        const a = p.x * d.x + p.y * d.y;
        const l = p.x * pp.x + p.y * pp.y;
        const edge = Math.sqrt(Math.max(currentR * currentR - l * l, 0));
        if (a > edge + 6 || p.stuck > 0.5) { spawn(p, false, d, pp); continue; }

        // Dibujo: trazo con cola degradada
        const dist = Math.hypot(p.x, p.y);
        const fade = isMapMode ? 1 : clamp((R - dist) / 45, 0, 1) * clamp(1 - (a - edge + 40) / 40, 0, 1);
        const pts = reduced ? [[p.x - d.x * (10 + cur.speed * 6), p.y - d.y * (10 + cur.speed * 6)], [p.x, p.y]] : p.trail;
        const n = pts.length;
        if (n < 1) continue;
        for (let i = 1; i < n; i++) {
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${(0.85 * (i / n) * fade).toFixed(3)})`;
          ctx.beginPath(); ctx.moveTo(pts[i - 1][0], pts[i - 1][1]); ctx.lineTo(pts[i][0], pts[i][1]); ctx.stroke();
        }
        if (!reduced && n >= 1) {
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${(0.85 * fade).toFixed(3)})`;
          ctx.beginPath(); ctx.moveTo(pts[n - 1][0], pts[n - 1][1]); ctx.lineTo(p.x, p.y); ctx.stroke();
        }
      }
      ctx.restore();
      requestAnimationFrame(frame);
    }

    return {
      init() {
        canvas = $("wind-canvas"); ctx = canvas.getContext("2d"); arrow = $("wind-arrow");
        readPalette(); buildTicks(); resize();
        new ResizeObserver(resize).observe(canvas);
        document.addEventListener("visibilitychange", () => { last = performance.now(); });
        const d0 = { x: 0, y: 1 }, p0 = { x: 1, y: 0 };
        particles = Array.from({ length: 90 }, () => spawn({}, true, d0, p0));
        running = true; last = performance.now();
        requestAnimationFrame(frame);
      },
      /** Fija el estado objetivo; `snap` evita la transición (primera carga). */
      setTarget(speedMs, dirDeg, level, snap = false) {
        if (!palette) readPalette();
        tgt.theta = normDeg(dirDeg); tgt.speed = speedMs; tgt.rgb = [...palette[level]];
        if (snap) { cur.theta = tgt.theta; cur.speed = tgt.speed; cur.rgb = [...tgt.rgb]; }
      },
    };
  })();

  /* ------------------------------------------------------------------
     6. RENDERIZADO
     ------------------------------------------------------------------ */
  const getDestination = () => (state.location.id === "mallorquin" ? ALT_DESTINATION : DESTINATION);
  const dist_m = () => {
    const dest = getDestination();
    return Physics.haversine(state.location.lat, state.location.lon, dest.lat, dest.lon);
  };

  function renderLocationOptions() {
    const sel = $("location-select");
    sel.innerHTML = LOCATIONS.map((l) => `<option value="${l.id}">${l.name}</option>`).join("");
    sel.value = state.location.id;
  }

  function renderRoute() {
    const dest = getDestination();
    setText("route-origin", state.location.short);
    setText("route-dest", dest.name);
    setText("route-dist", `${f1.format(dist_m() / 1000)} km`);
  }

  /** Vista actual: telemetría + túnel + estado, según el punto seleccionado/previsualizado. */
  function renderView(snap = false) {
    const p = viewPoint();
    if (!p) return;
    const vK = Physics.msToKmh(p.speedMs), gK = Physics.msToKmh(p.gustMs);
    const sl = speedLevel(vK), gl = gustLevel(gK);

    // Velocidad y Ráfaga
    setText("speed-val", f1.format(vK), true);
    setLevel($("card-speed"), sl);
    $("speed-meter").style.width = `${clamp(vK / CONFIG.GAUGE_MAX_KMH, 0, 1) * 100}%`;

    setText("gust-val", f1.format(gK), true);
    setLevel($("gust-badge"), gl);

    // Potencia eólica  P/A = 0.5 · 1.18 · v³  (v en m/s)
    const power = Physics.windPowerDensity(p.speedMs);
    setText("power-wm2", f1.format(power), true);
    setText("power-v", f2.format(p.speedMs));
    setText("power-v3", f2.format(p.speedMs ** 3));
    setLevel($("card-power"), sl);

    // Carga sobre el ciclista
    const L = Physics.cyclistLoad(p.speedMs, p.dirDeg);
    const headTag = L.head >= 0 ? "frente" : "favor";
    const headKmh = Physics.msToKmh(Math.abs(L.head));
    const crossKmh = Physics.msToKmh(Math.abs(L.cross));
    const appKmh = Physics.msToKmh(L.apparentSpeed);
    
    $("t-head").innerHTML = `${f1.format(headKmh)} km/h<em>${headTag}</em>`;
    $("t-cross").innerHTML = `${f1.format(crossKmh)} km/h<em>${L.cross >= 0 ? "der." : "izq."}</em>`;
    $("t-app").innerHTML = `${f1.format(appKmh)} km/h<em>${f0.format(L.apparentAngle)}°</em>`;
    setText("t-force", `${f2.format(L.force)} N`);
    const pct = (L.ratio - 1) * 100;
    const dEl = $("t-delta");
    dEl.innerHTML = `${L.deltaForce >= 0 ? "+" : "−"}${f2.format(Math.abs(L.deltaForce))} N<em>${pct >= 0 ? "+" : "−"}${f0.format(Math.abs(pct))}%</em>`;
    dEl.dataset.level = pct < 10 ? "ok" : pct < 40 ? "warn" : "danger";
    setText("t-power", `${f0.format(L.power)} W`);
    setText("t-power-sub", `${f2.format(L.wPerKg)} W/kg · ${f0.format(L.massKg)} kg`);
    setText("t-work", `${f1.format((Math.max(0, L.total) * dist_m()) / 1000)} kJ`);

    // Estado general
    const st = routeStatus(p);
    const stEl = $("status");
    stEl.dataset.level = st.level;
    setText("status-text", p.offset === 0 ? st.text : `${st.text} (+${p.offset} h)`);
    setText("status-detail", st.detail);

    // Túnel y lecturas
    if (state.isWatchMode) {
      renderWatchView();
    } else {
      const cardinals = document.querySelector(".cardinals");
      if (cardinals) cardinals.removeAttribute("transform");
      Tunnel.setTarget(p.speedMs, p.dirDeg, RANK[sl] >= RANK[gl] ? sl : gl, snap);
      setText("ro-dir", `${bearingText(p.dirDeg)} · ${f1.format(vK)} km/h`);
      setText("ro-time", p.offset === 0 ? `AHORA · ${p.hhmm}` : `+${p.offset} h · ${p.hhmm}`);
    }

    // Timeline: selección / previsualización
    $("tl-cols").querySelectorAll(".tl__col").forEach((el) => {
      const i = +el.dataset.i;
      el.classList.toggle("is-selected", i === state.selected);
      el.classList.toggle("is-preview", state.hover !== null && i === state.hover && i !== state.selected);
    });
    const slider = $("tl-slider");
    slider.dataset.level = speedLevel(Physics.msToKmh(state.series[state.selected].speedMs));
    slider.setAttribute("aria-valuetext", state.selected === 0 ? "Ahora" : `En ${state.selected} horas, ${state.series[state.selected].hhmm}`);
  }

  function renderTimeline() {
    const cols = $("tl-cols");
    cols.innerHTML = state.series.map((p, i) => {
      const vK = Physics.msToKmh(p.speedMs), gK = Physics.msToKmh(p.gustMs);
      const h = clamp(vK / CONFIG.GAUGE_MAX_KMH, 0, 1) * 100;
      const gh = clamp(gK / CONFIG.GAUGE_MAX_KMH, 0, 1) * 100;
      const flow = normDeg(p.dirDeg + 180);
      return `<button type="button" class="tl__col" data-i="${i}" data-level="${speedLevel(vK)}"
        aria-label="${i === 0 ? "Ahora" : `+${i} h`}, ${p.hhmm}: ${f1.format(vK)} km/h desde ${cardinalOf(p.dirDeg)}">
        <span class="tl__val">${f0.format(vK)}</span>
        <span class="tl__barwrap"><span class="tl__bar" style="height:${Math.max(h, 3)}%"></span><span class="tl__gust" style="bottom:${gh}%"></span></span>
        <svg class="tl__dir" viewBox="-6 -6 12 12" style="rotate:${flow}deg" aria-hidden="true"><path d="M0 -5 L3.6 4 L0 2 L-3.6 4 Z"/></svg>
        <span class="tl__hour">${i === 0 ? "NOW" : p.hhmm.slice(0, 2) + "h"}</span>
      </button>`;
    }).join("");
    const slider = $("tl-slider");
    slider.max = String(state.series.length - 1);
    slider.value = String(state.selected);
  }

  /** Widget "Hora óptima": compara F aerodinámica al salir ahora / +1 h / +3 h. */
  function renderOptimal() {
    const box = $("opt-bars");
    const opts = CONFIG.DEPARTURES
      .map((d) => ({ ...d, p: state.series[d.offset] }))
      .filter((o) => o.p)
      .map((o) => ({ ...o, L: Physics.cyclistLoad(o.p.speedMs, o.p.dirDeg) }));
    if (!opts.length) { box.innerHTML = ""; return; }

    const calm = opts[0].L.calm;
    const maxF = Math.max(calm * 2, ...opts.map((o) => o.L.force));
    const best = opts.reduce((m, o) => (o.L.force < m.L.force ? o : m), opts[0]);
    const now = opts[0];

    box.innerHTML = opts.map((o) => {
      const ratio = o.L.ratio;
      const level = ratio < 1.15 ? "ok" : ratio < 1.6 ? "warn" : "danger";
      const h = clamp(o.L.force / maxF, 0.02, 1) * 100;
      const vsNow = ((o.L.force - now.L.force) / Math.abs(now.L.force)) * 100;
      return `<div class="opt__col${o === best ? " is-best" : ""}" data-level="${level}">
        ${o === best ? '<span class="opt__tag">ÓPTIMA</span>' : ""}
        <div class="opt__plot">
          <span class="opt__bar" style="height:${h}%"></span>
          <span class="opt__ref" style="bottom:${(calm / maxF) * 100}%" title="Aire en calma"></span>
        </div>
        <span class="opt__name">${o.label}</span>
        <span class="opt__val">${f2.format(o.L.force)} N</span>
        <span class="opt__sub">${f0.format(o.L.power)} W · ${o.offset === 0 ? "ref." : (vsNow >= 0 ? "+" : "−") + f0.format(Math.abs(vsNow)) + "%"}</span>
      </div>`;
    }).join("");

    const v = $("opt-verdict");
    if (best === now) {
      v.innerHTML = `<strong>Salir ahora</strong> es la opción de menor resistencia (${f2.format(now.L.force)} N).`;
    } else {
      const gain = (1 - best.L.force / now.L.force) * 100;
      v.innerHTML = `Salir <strong>${best.label.toLowerCase()}</strong> (${best.p.hhmm}) reduce la resistencia aerodinámica un <strong>${f0.format(gain)}%</strong> frente a salir ahora.`;
    }
  }

  function renderLive() {
    if (!state.lastSuccess) return;
    const el = $("last-updated");
    el.dateTime = state.lastSuccess.toISOString();
    el.textContent = `${dateFmt.format(state.lastSuccess)} ${timeFmt.format(state.lastSuccess)}`;
  }

  function setLive(kind, label) {
    $("live-indicator").dataset.state = kind;
    setText("live-label", label);
  }

  function renderCountdown() {
    const el = $("next-refresh");
    if (!state.nextRefreshAt) { el.textContent = "—"; return; }
    const s = Math.max(0, Math.round((state.nextRefreshAt - Date.now()) / 1000));
    el.textContent = `próxima consulta en ${Math.floor(s / 60)}:${pad2(s % 60)}`;
  }

  function showError(msg) {
    $("error-text").textContent = state.series.length ? `${msg} Se muestran los últimos datos válidos.` : msg;
    $("error-banner").hidden = false;
  }

  /* ------------------------------------------------------------------
     7. ACTUALIZACIÓN Y ARRANQUE
     ------------------------------------------------------------------ */

  function scheduleRefresh() {
    clearTimeout(state.timer);
    state.nextRefreshAt = Date.now() + CONFIG.REFRESH_MS;
    state.timer = setTimeout(() => refresh("auto"), CONFIG.REFRESH_MS);
    renderCountdown();
  }

  async function refresh(reason = "manual") {
    const seq = ++state.seq;
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    let timedOut = false;
    const to = setTimeout(() => { timedOut = true; controller.abort(); }, CONFIG.TIMEOUT_MS);

    const first = !state.series.length;
    setLive("loading", reason === "location" ? "CAMBIANDO" : "SYNC");
    $("refresh-btn").classList.add("is-spinning");

    try {
      const data = await fetchWeather(state.location, controller.signal);
      if (seq !== state.seq) return;
      const series = processPayload(data);
      state.series = series;
      state.selected = reason === "location" ? 0 : clamp(state.selected, 0, series.length - 1);
      state.hover = null;
      state.lastSuccess = new Date();

      $("main").setAttribute("aria-busy", "false");
      renderRoute();
      renderTimeline();
      renderOptimal();
      renderView(first || reason === "location");
      renderLive();
      setLive("live", "EN VIVO");
      $("error-banner").hidden = true;
      $("sr-status").textContent = `${state.location.name}: ${f1.format(Physics.msToKmh(series[0].speedMs))} km/h desde el ${cardinalOf(series[0].dirDeg)}.`;
      document.dispatchEvent(new CustomEvent("vientobq:update", { detail: window.VientoBQ.getSnapshot() }));
    } catch (err) {
      if (seq !== state.seq) return;
      if (err.name === "AbortError" && !timedOut) return;
      console.error("[VientoBQ]", err);
      setLive("error", "SIN ENLACE");
      showError(timedOut ? "La API tardó demasiado en responder." : `No se pudo obtener el viento (${err.message}).`);
      if (first) $("main").setAttribute("aria-busy", "false");
    } finally {
      clearTimeout(to);
      if (seq === state.seq) { $("refresh-btn").classList.remove("is-spinning"); scheduleRefresh(); }
    }
  }

  function setLocation(id) {
    const loc = LOCATIONS.find((l) => l.id === id);
    if (!loc || loc === state.location) return;
    state.location = loc;
    try { localStorage.setItem(CONFIG.STORAGE_KEY, id); } catch { /* sin storage */ }
    renderRoute();
    if (AppMap.flyTo) AppMap.flyTo(loc);
    refresh("location"); // fetch inmediato con las nuevas coordenadas
  }

  function wireTimeline() {
    const cols = $("tl-cols"), slider = $("tl-slider");

    cols.addEventListener("pointerover", (e) => {
      if (e.pointerType !== "mouse") return;
      const col = e.target.closest(".tl__col");
      if (!col || !state.series.length) return;
      const i = +col.dataset.i;
      if (state.hover !== i) { state.hover = i; renderView(); }
    });
    cols.addEventListener("pointerleave", () => {
      if (state.hover !== null) { state.hover = null; renderView(); }
    });
    cols.addEventListener("click", (e) => {
      const col = e.target.closest(".tl__col");
      if (!col) return;
      state.selected = +col.dataset.i; state.hover = null;
      slider.value = String(state.selected);
      renderView();
    });
    slider.addEventListener("input", () => {
      state.selected = +slider.value; state.hover = null;
      renderView();
    });
    slider.addEventListener("change", () => {
      state.selected = +slider.value; state.hover = null;
      renderView();
    });
  }

  const AppMap = (() => {
    let map = null;
    let markers = {};

    return {
      init() {
        if (!window.L) return;
        map = L.map('leaflet-map', { zoomControl: false }).setView([state.location.lat, state.location.lon], 13);
        
        // Esri WorldTopoMap para look claro estilo Windy
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
          attribution: '&copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
          maxZoom: 19
        }).addTo(map);

        // Marcadores
        LOCATIONS.forEach(loc => {
          const icon = L.divIcon({
            className: 'map-pin',
            html: `<span>${loc.short}</span>`,
            iconSize: [100, 24],
            iconAnchor: [50, 12]
          });
          const marker = L.marker([loc.lat, loc.lon], { icon }).addTo(map);
          marker.on('click', () => {
            $("location-select").value = loc.id;
            setLocation(loc.id);
          });
          markers[loc.id] = marker;
        });

        // Controles de vista
        const btnMap = $("btn-view-map");
        const btnTunnel = $("btn-view-tunnel");
        const btnSafety = $("btn-view-safety");
        const tw = $("tunnel-wrap");

        function setView(view) {
          btnMap.classList.toggle("is-active", view === "map");
          btnTunnel.classList.toggle("is-active", view === "tunnel");
          btnSafety.classList.toggle("is-active", view === "safety");
          tw.setAttribute("data-view", view);
          Tunnel.setView?.(view);
          if (view === "map") setTimeout(() => map.invalidateSize(), 300);
        }

        btnMap.addEventListener("click", () => setView("map"));
        btnTunnel.addEventListener("click", () => setView("tunnel"));
        btnSafety.addEventListener("click", () => setView("safety"));

        // Lógica exclusiva del acordeón
        const accItems = document.querySelectorAll('#safety-accordion details');
        accItems.forEach(item => {
          item.addEventListener('toggle', (e) => {
            if (item.open) {
              accItems.forEach(other => {
                if (other !== item && other.open) other.open = false;
              });
            }
          });
        });
      },
      flyTo(loc) {
        if (!map) return;
        map.flyTo([loc.lat, loc.lon], 13, { duration: 1 });
      }
    };
  })();

  /* API pública para el simulador cinemático (SI) */
  window.VientoBQ = Object.freeze({
    physics: Physics,
    constants: PHYSICS,
    getSnapshot() {
      if (!state.series.length) return null;
      return {
        location: { ...state.location },
        timestamp: state.lastSuccess?.toISOString() ?? null,
        view: viewPoint(),
        hourly: state.series.map((p) => ({ ...p, powerDensityWm2: Physics.windPowerDensity(p.speedMs), load: Physics.cyclistLoad(p.speedMs, p.dirDeg) })),
      };
    },
    refresh: () => refresh("manual"),
  });

  /* ------------------------------------------------------------------
     8. MODO SMARTWATCH ("WATCH MODE" OLED)
     ------------------------------------------------------------------ */
  let watchGeoId = null;
  let takeoverTimer = null;
  let lastAlertTs = 0;
  let lastAlertType = null;
  const ALERT_COOLDOWN_MS = 14000;

  // Renderizadores throttled a 500ms (máx 2 veces por segundo) para no saturar CPU/GPU en móviles
  const throttledRenderWatchView = throttle(renderWatchView, 500);
  const throttledRenderView = throttle(renderView, 500);

  function toggleWatchMode(enable) {
    state.isWatchMode = enable !== undefined ? enable : !state.isWatchMode;
    document.body.classList.toggle("watch-mode", state.isWatchMode);

    if (state.isWatchMode) {
      const tw = $("tunnel-wrap");
      if (tw) {
        tw.setAttribute("data-view", "tunnel");
        Tunnel.setView?.("tunnel");
      }
      startWatchGeolocation();
      renderWatchView();
    } else {
      stopWatchGeolocation();
      dismissTacticalTakeover();
      renderView();
    }
  }

  function startWatchGeolocation() {
    if (!("geolocation" in navigator)) return;
    try {
      watchGeoId = navigator.geolocation.watchPosition(
        (pos) => {
          if (!state.isWatchMode) return;
          const c = pos.coords;
          if (typeof c.heading === "number" && !isNaN(c.heading)) {
            state.watchHeading = Math.round(c.heading);
            const sld = $("watch-heading-slider");
            if (sld) sld.value = String(state.watchHeading);
          }
          if (typeof c.speed === "number" && !isNaN(c.speed) && c.speed > 0) {
            state.watchSpeedKmh = c.speed * 3.6;
          }
          // Throttle de la telemetría a 2 Hz (500ms)
          throttledRenderWatchView();
        },
        (err) => console.warn("[Watch Geolocation]", err.message),
        { enableHighAccuracy: true, maximumAge: 1500, timeout: 12000 }
      );
    } catch (e) {
      console.warn("[Watch Geolocation error]", e);
    }

    if (window.DeviceOrientationEvent) {
      window.addEventListener("deviceorientation", handleDeviceOrientation, true);
    }
  }

  function handleDeviceOrientation(e) {
    if (!state.isWatchMode) return;
    let heading = null;
    if (e.webkitCompassHeading !== undefined) {
      heading = e.webkitCompassHeading;
    } else if (e.alpha !== undefined && e.absolute) {
      heading = (360 - e.alpha) % 360;
    }
    if (heading !== null && !isNaN(heading)) {
      state.watchHeading = Math.round(heading);
      const sld = $("watch-heading-slider");
      if (sld) sld.value = String(state.watchHeading);
      // Brújula y fórmulas físicas throttled a un máximo de 2 Hz (500ms)
      throttledRenderWatchView();
    }
  }

  function stopWatchGeolocation() {
    if (watchGeoId !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(watchGeoId);
      watchGeoId = null;
    }
    window.removeEventListener("deviceorientation", handleDeviceOrientation, true);
  }

  function renderWatchView() {
    if (!state.isWatchMode) return;
    const p = viewPoint();
    if (!p) return;

    const hd = state.watchHeading;
    const speedKmh = state.watchSpeedKmh || CONFIG.RIDER_SPEED_KMH;
    const riderMs = Physics.kmhToMs(speedKmh);

    // Ángulo de ataque del viento relativo al rumbo del ciclista
    const relWindDeg = ((p.dirDeg - hd) % 360 + 360) % 360;

    // Cálculo aerodinámico considerando rumbo real del ciclista
    const L = Physics.cyclistLoad(p.speedMs, p.dirDeg, riderMs, hd);
    const headKmh = Physics.msToKmh(L.head);
    const crossKmh = Physics.msToKmh(Math.abs(L.cross));

    // Cabecera del reloj
    setText("watch-heading-text", `${pad2(hd).padStart(3, "0")}° ${cardinalOf(hd)}`);
    setText("watch-heading-deg", `${pad2(hd).padStart(3, "0")}° ${cardinalOf(hd)}`);
    setText("watch-speed-text", `${f1.format(speedKmh)} km/h`);

    // Métrica masiva de Fuerza
    setText("watch-force-num", f1.format(L.force));

    // Badge de ataque
    let attackTag = "VIENTO FRONTAL";
    if (relWindDeg > 45 && relWindDeg <= 135) attackTag = "LATERAL DERECHO";
    else if (relWindDeg > 135 && relWindDeg <= 225) attackTag = "VIENTO A FAVOR";
    else if (relWindDeg > 225 && relWindDeg <= 315) attackTag = "LATERAL IZQUIERDO";
    setText("watch-attack-tag", attackTag);
    setText("watch-attack-angle", `${f0.format(relWindDeg)}° rel.`);

    // Telemetría inferior
    setText("watch-head-comp", `${f1.format(Math.abs(headKmh))} km/h ${headKmh >= 0 ? "contra" : "favor"}`);
    setText("watch-cross-comp", `${f1.format(crossKmh)} km/h ${L.cross >= 0 ? "der." : "izq."}`);
    setText("watch-power-extra", `${f0.format(L.power)} W`);

    // Rota el túnel dinámicamente según el ángulo de ataque relativo
    const vK = Physics.msToKmh(p.speedMs), gK = Physics.msToKmh(p.gustMs);
    const sl = speedLevel(vK), gl = gustLevel(gK);
    Tunnel.setTarget(p.speedMs, relWindDeg, RANK[sl] >= RANK[gl] ? sl : gl, false);

    // Rosa de vientos rotada (Norte apunta a su posición real)
    const cardinals = document.querySelector(".cardinals");
    if (cardinals) cardinals.setAttribute("transform", `rotate(${-hd})`);

    // Evaluación en segundo plano de alertas tácticas automáticas
    evaluateTacticalAlerts(crossKmh, headKmh, L);
  }

  function evaluateTacticalAlerts(crossKmh, headKmh, L) {
    if (!state.isWatchMode) return;

    // Condición 1: Viento cruzado (lateral) > 20 km/h
    if (crossKmh > 20) {
      triggerTacticalTakeover({
        type: "crosswind",
        severity: crossKmh > 30 ? "danger" : "warn",
        badge: "⚠️ VIENTO CRUZADO CRÍTICO",
        title: "¡FUERTE RÁFAGA LATERAL!",
        value: `${f1.format(crossKmh)} km/h desde la ${L.cross >= 0 ? "derecha" : "izquierda"}`,
        action: "SUJETA FIRME EL MANILLAR",
        hint: "Riesgo inminente de inestabilidad lateral. Mantén agarre firme y baja centro de gravedad.",
        iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 14l6-6 4 4 6-6"/><path d="M14 6h6v6"/><circle cx="12" cy="18" r="3"/></svg>`,
      });
      return;
    }

    // Condición 2: Viento en contra masivo (> 20 km/h de frente o carga extrema)
    if (headKmh > 20 || L.force > 26) {
      triggerTacticalTakeover({
        type: "headwind",
        severity: "danger",
        badge: "🛑 RESISTENCIA EXTREMA",
        title: "¡FUERTE VIENTO DE FRENTE!",
        value: `${f1.format(headKmh)} km/h contra ciclista · ${f1.format(L.force)} N`,
        action: "BAJA EL TORSO · REDUCE MARCHA",
        hint: "Gasto de potencia masivo. Flexiona codos hacia los drops y aumenta cadencia para proteger rodillas.",
        iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/><path d="M5 21h14"/></svg>`,
      });
    }
  }

  function triggerTacticalTakeover(data) {
    if (!state.isWatchMode) return;
    const now = Date.now();
    if (now - lastAlertTs < ALERT_COOLDOWN_MS && lastAlertType === data.type) return;

    lastAlertTs = now;
    lastAlertType = data.type;

    // Vibración en Smartwatch si soportada por el navegador
    if ("vibrate" in navigator) {
      try { navigator.vibrate([200, 100, 200]); } catch (e) { /* ignore */ }
    }

    const takeover = $("watch-takeover");
    const tunnel = $("tunnel");
    if (!takeover || !tunnel) return;

    takeover.dataset.severity = data.severity;
    setText("watch-takeover-tag", data.badge);
    setText("watch-takeover-title", data.title);
    setText("watch-takeover-val", data.value);
    setText("watch-takeover-action", data.action);
    setText("watch-takeover-hint", data.hint);
    const iconBox = $("watch-takeover-icon");
    if (iconBox) iconBox.innerHTML = data.iconSvg;

    // Ocultar túnel cenital y mostrar takeover a pantalla completa
    tunnel.classList.add("is-hidden-by-alert");
    takeover.hidden = false;

    // Reiniciar animación del temporizador de 4s
    const bar = takeover.querySelector(".watch-takeover__timer-fill");
    if (bar) {
      bar.style.animation = "none";
      void bar.offsetHeight;
      bar.style.animation = "takeoverCountdown 4s linear forwards";
    }

    clearTimeout(takeoverTimer);
    takeoverTimer = setTimeout(() => {
      dismissTacticalTakeover();
    }, 4000); // 4 segundos exactos
  }

  function dismissTacticalTakeover() {
    const takeover = $("watch-takeover");
    const tunnel = $("tunnel");
    if (takeover) takeover.hidden = true;
    if (tunnel) tunnel.classList.remove("is-hidden-by-alert");
    clearTimeout(takeoverTimer);
  }

  /** Campos de peso: vacío o fuera de rango → valor estándar (se muestra como placeholder). */
  function wireMassInputs() {
    const rider = $("in-rider-kg"), bike = $("in-bike-kg"), reset = $("mass-reset");
    if (!rider || !bike) return;
    const apply = () => {
      const r = rider.value.trim() === "" ? null : validMass(Number(rider.value.replace(",", ".")), 30, 200);
      const b = bike.value.trim() === "" ? null : validMass(Number(bike.value.replace(",", ".")), 3, 40);
      state.riderKg = r; state.bikeKg = b;
      rider.setAttribute("aria-invalid", String(rider.value.trim() !== "" && r === null));
      bike.setAttribute("aria-invalid", String(bike.value.trim() !== "" && b === null));
      const usingDefault = r === null && b === null;
      setText("mass-note", usingDefault ? `Usando valores estándar (${PHYSICS.RIDER_KG} + ${PHYSICS.BIKE_KG} kg)` : `Masa total: ${f1.format(totalMassKg())} kg`);
      if (state.series.length) { renderView(); renderOptimal(); }
    };
    rider.addEventListener("input", apply);
    bike.addEventListener("input", apply);
    if (reset) reset.addEventListener("click", () => { rider.value = ""; bike.value = ""; apply(); });
    apply();
  }

  function init() {
    let saved = null;
    try { saved = localStorage.getItem(CONFIG.STORAGE_KEY); } catch { /* sin storage */ }
    state.location = LOCATIONS.find((l) => l.id === saved) || LOCATIONS[0];

    renderLocationOptions();
    renderRoute();
    setText("rider-ref", `${CONFIG.RIDER_SPEED_KMH} km/h · CdA ${PHYSICS.CDA}`);
    setText("ro-rider", `▲ ${bearingText(CONFIG.RIDER_HEADING_DEG)} · ${CONFIG.RIDER_SPEED_KMH} km/h`);
    Tunnel.init();
    AppMap.init();
    wireTimeline();

    $("location-select").addEventListener("change", (e) => setLocation(e.target.value));
    $("refresh-btn").addEventListener("click", () => refresh("manual"));
    $("retry-btn").addEventListener("click", () => refresh("manual"));
    wireMassInputs();

    // Controles de Watch Mode
    const watchBtn = $("watch-btn");
    if (watchBtn) watchBtn.addEventListener("click", () => toggleWatchMode(true));
    const watchExitBtn = $("watch-exit-btn");
    if (watchExitBtn) watchExitBtn.addEventListener("click", () => toggleWatchMode(false));
    const takeoverEl = $("watch-takeover");
    if (takeoverEl) takeoverEl.addEventListener("click", dismissTacticalTakeover);

    const hdSlider = $("watch-heading-slider");
    if (hdSlider) {
      hdSlider.addEventListener("input", (e) => {
        state.watchHeading = Number(e.target.value);
        throttledRenderWatchView();
      });
      hdSlider.addEventListener("change", (e) => {
        state.watchHeading = Number(e.target.value);
        renderWatchView();
      });
    }

    document.querySelectorAll(".btn-quick-hd").forEach((btn) => {
      btn.addEventListener("click", () => {
        const d = Number(btn.dataset.deg);
        state.watchHeading = d;
        if (hdSlider) hdSlider.value = String(d);
        renderWatchView();
      });
    });

    const testAlertBtn = $("watch-test-alert-btn");
    if (testAlertBtn) {
      testAlertBtn.addEventListener("click", () => {
        lastAlertTs = 0; // bypass cooldown para prueba
        triggerTacticalTakeover({
          type: "test",
          severity: "warn",
          badge: "⚠️ PRUEBA DE ALERTA TÁCTICA",
          title: "¡ALERTA TÁCTICA DE PRUEBA!",
          value: "26.4 km/h viento lateral simulado",
          action: "SUJETA FIRME EL MANILLAR",
          hint: "Demostración de Takeover a pantalla completa (4s con vibración háptica).",
          iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
        });
      });
    }

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.isWatchMode) toggleWatchMode(false);
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && state.nextRefreshAt && Date.now() >= state.nextRefreshAt) refresh("auto");
    });
    window.addEventListener("online", () => refresh("auto"));

    setInterval(renderCountdown, 1000);
    refresh("initial");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
