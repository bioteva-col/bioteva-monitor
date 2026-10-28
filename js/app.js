/*
 * BioTeva Monitor — aplicación (interfaz, cámara, ciclo de lectura).
 * Funciona igual como página local, app instalada (PWA) y extensión de Chrome.
 */
(function () {
  "use strict";

  const L = window.MonLogic, Seg = window.MonSeg;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const HOUR = 3600000, DAY = 24 * HOUR;
  const SIM_W = 960, SIM_H = 540;

  const App = {
    store: null,
    settings: L.validateSettings({}).value,
    sensors: [L.defaultSensor("A"), L.defaultSensor("B")],
    running: false,
    nextAt: 0,
    lastCycleAt: null,
    busy: false,
    view: "dashboard",
    latest: {},
    prevThumbs: {},
    cam: { devices: [], streams: [], status: "off", error: "" },
    still: null,
    sim: { simulator: L.createSimulator(Date.now() % 100000), anomalies: {}, frame: null, frameAt: 0 },
    cal: { sensorId: "A", frozen: null, draft: null, field: "tempIn", drag: null, lastFrame: null, lastRect: null, candidates: null, candidatesAt: 0 },
    track: { state: {}, lastPersist: 0, lastPreview: 0, tplRefreshed: {} },
    lastPurge: 0,
    wakeLock: null,
    installPrompt: null,
    isExtension: location.protocol === "chrome-extension:",
    chartRange: { preset: "24h", from: null, to: null, metric: "control", sensors: { A: true, B: true }, limits: true },
    histFilter: { from: null, to: null, sensor: "", page: 0 },
  };
  window.BioTevaMonitor = App; // depuración desde la consola

  // ─────────────────────────── utilidades ───────────────────────────

  function toast(msg, kind) {
    const host = $("#toasts");
    const el = document.createElement("div");
    el.className = "toast " + (kind || "");
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), kind === "crit" ? 12000 : 6000);
  }

  const pad2 = (n) => (n < 10 ? "0" : "") + n;
  const fmtClock = (ms) => { const d = new Date(ms); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()); };
  const toDateInput = (ms) => L.dayKey(ms);
  const sensorById = (id) => App.sensors.find((s) => s.id === id);
  const sevClass = (sev) => (sev === "CRITICAL" ? "crit" : sev === "WARNING" ? "warn" : "info");

  // Íconos del sistema de diseño: el estado nunca se comunica solo con color (color + ícono + palabra).
  const ICONS = {
    ok: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    warn: '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.2v.1"/>',
    crit: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.2v.1"/>',
    off: '<path d="M6 12h12"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.1"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    flat: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    lamp: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z"/>',
  };
  const ico = (name, size) => '<svg width="' + (size || 18) + '" height="' + (size || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || "") + "</svg>";

  const STATUS_UI = {
    NORMAL: { cls: "ok", box: "ok", icon: "ok", label: "Normal" },
    ATENCION: { cls: "warn", box: "warn", icon: "warn", label: "Atención" },
    FUERA_DE_RANGO: { cls: "crit", box: "crit", icon: "crit", label: "Fuera de límites" },
    SIN_DATOS: { cls: "off", box: "dashed", icon: "off", label: "Sin datos" },
    LECTURA_INCIERTA: { cls: "warn", box: "warn", icon: "warn", label: "Lectura dudosa" },
    CAMARA_DESCONECTADA: { cls: "crit", box: "crit", icon: "crit", label: "Cámara desconectada" },
    SENSOR_NO_DETECTADO: { cls: "crit", box: "crit", icon: "crit", label: "Sensor no visible" },
  };
  function statusChip(code) {
    const ui = STATUS_UI[code] || STATUS_UI.SIN_DATOS;
    return '<span class="chip ' + ui.cls + '">' + ico(ui.icon, 16) + esc(ui.label) + "</span>";
  }

  // ── formatos: coma decimal por defecto, horas «3:47 p. m.», tiempos «hace 2 min» ──
  App.ui = { decimal: "," };
  const fmt = (v, d) => { const s = L.num(v, d); return App.ui.decimal === "," ? s.replace(".", ",") : s; };
  /** Textos armados por la lógica («31.2 °C») con el separador decimal elegido. */
  const decTxt = (t) => (App.ui.decimal === "," ? String(t == null ? "" : t).replace(/(\d)\.(\d)/g, "$1,$2") : String(t == null ? "" : t));
  const fmtHour = (ms) => new Date(ms).toLocaleTimeString("es-CO", { hour: "numeric", minute: "2-digit" });
  const fmtDay = (ms) => {
    const k = L.dayKey(ms), now = Date.now();
    if (k === L.dayKey(now)) return "Hoy";
    if (k === L.dayKey(now - DAY)) return "Ayer";
    return new Date(ms).toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long" });
  };
  const fmtWhen = (ms) => (L.dayKey(ms) === L.dayKey(Date.now()) ? fmtHour(ms) : fmtDay(ms).toLowerCase() + ", " + fmtHour(ms));
  const fmtDur = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? m + " min" : Math.floor(m / 60) + " h" + (m % 60 ? " " + (m % 60) + " min" : ""); };
  const fmtAgo = (ms) => { const d = Date.now() - ms; return d < 60000 ? "hace un momento" : d < DAY ? "hace " + fmtDur(d) : fmtWhen(ms); };
  const parseNum = (s) => { const n = Number(String(s == null ? "" : s).trim().replace(",", ".")); return String(s == null ? "" : s).trim() === "" || !isFinite(n) ? null : n; };
  function sevChip(sev) {
    const icon = sev === "CRITICAL" ? "⬣" : sev === "WARNING" ? "▲" : "i";
    return '<span class="chip ' + sevClass(sev) + '"><span class="chip-icon" aria-hidden="true">' + icon + "</span>" + esc(sev) + "</span>";
  }

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  function stamp() { const d = new Date(); return L.dayKey(d.getTime()) + "_" + pad2(d.getHours()) + pad2(d.getMinutes()); }

  async function saveSettings(patch) {
    const res = L.validateSettings(Object.assign({}, App.settings, patch));
    if (!res.ok) throw new Error(res.errors.join(" · "));
    App.settings = res.value;
    await App.store.setKV("settings", App.settings);
    return App.settings;
  }
  async function saveSensors() { await App.store.setKV("sensors", App.sensors); }

  // ayudas que usa el módulo de control térmico (js/termico-ui.js, se carga después)
  App.helpers = { esc, toast, $, $$, download };
  App.renderView = () => renderView();

  // ─────────────────────────── cámara ───────────────────────────

  function setCamStatus(status, error) {
    App.cam.status = status;
    App.cam.error = error || "";
    renderHeader();
    const msg = $("#camMsg");
    if (msg) {
      msg.textContent = error || (status === "active" ? "Cámara activa." : status === "starting" ? "Solicitando la cámara…" : "");
      msg.className = "msg " + (status === "error" ? "crit" : status === "active" ? "good" : "");
    }
  }

  function cameraErrorMessage(e) {
    const n = e && e.name;
    if (n === "NotAllowedError" || n === "SecurityError") return "Permiso de cámara denegado. Pulsa el ícono de la cámara en la barra de direcciones de Chrome, elige «Permitir» y vuelve a activar.";
    if (n === "NotFoundError" || n === "OverconstrainedError") return "No se encontró la cámara seleccionada. Conéctala, pulsa «Buscar cámaras» o elige otra.";
    if (n === "NotReadableError" || n === "AbortError") return "La cámara está en uso por otra aplicación (Zoom, Teams, Meet…) o no responde. Ciérrala e intenta de nuevo.";
    return "No se pudo abrir la cámara: " + (e && e.message ? e.message : String(e));
  }

  async function refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      App.cam.devices = all.filter((d) => d.kind === "videoinput").map((d, i) => ({ deviceId: d.deviceId, label: d.label || "Camera " + (i + 1) }));
    } catch (e) { App.cam.devices = []; }
    renderCameraForm();
  }

  function wantedDeviceIds() {
    const S = App.settings;
    if (S.cameraMode === "dual") {
      const ids = [sensorById("A"), sensorById("B")].filter((s) => s && s.enabled).map((s) => s.cameraDeviceId || null);
      return ids.filter((v, i) => ids.indexOf(v) === i);
    }
    return [S.cameraDeviceId || null];
  }

  function stopCameras() {
    App.cam.streams.forEach((e) => e.stream.getTracks().forEach((t) => t.stop()));
    App.cam.streams = [];
    setCamStatus("off");
  }

  async function startCameras() {
    if (!window.isSecureContext) return setCamStatus("error", "La cámara solo funciona en un origen seguro: ábrela como extensión, en http://localhost o por https.");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return setCamStatus("error", "Este navegador no permite usar la cámara (getUserMedia no disponible).");
    stopCameras();
    App.cam.lastTry = Date.now();
    setCamStatus("starting");
    const [w, h] = App.settings.resolution.split("x").map(Number);
    try {
      for (const id of wantedDeviceIds()) {
        const constraints = (dev) => ({
          audio: false,
          video: { deviceId: dev ? { exact: dev } : undefined, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: App.settings.fps } },
        });
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints(id));
        } catch (e) {
          if (!id || (e.name !== "OverconstrainedError" && e.name !== "NotFoundError")) throw e;
          // La cámara elegida ya no está: seguir con la predeterminada en vez de quedar sin lecturas.
          stream = await navigator.mediaDevices.getUserMedia(constraints(null));
          toast("La cámara configurada no está disponible; se usa la cámara predeterminada.", "warn");
        }
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await video.play();
        const track = stream.getVideoTracks()[0];
        const real = (track.getSettings && track.getSettings().deviceId) || id;
        track.addEventListener("ended", () => setCamStatus("error", "La cámara se desconectó o dejó de enviar imagen (" + track.label + ")."));
        App.cam.streams.push({ requested: id, deviceId: real, label: track.label || "Cámara", stream, video, canvas: document.createElement("canvas") });
        if (!id && App.settings.cameraMode === "single") await saveSettings({ cameraDeviceId: real || null });
      }
      setCamStatus("active");
      await refreshDevices();
    } catch (e) {
      stopCameras();
      setCamStatus("error", cameraErrorMessage(e));
    }
  }

  function streamFor(sensor) {
    const S = App.settings, list = App.cam.streams;
    if (!list.length) return null;
    const wanted = S.cameraMode === "dual" ? sensor.cameraDeviceId : S.cameraDeviceId;
    return list.find((e) => e.deviceId === wanted || e.requested === wanted) || (S.cameraMode === "single" || !wanted ? list[0] : null);
  }

  // ─────────────────────────── fotogramas ───────────────────────────

  function simAnomaliesFor(id) {
    const a = App.sim.anomalies, out = {};
    if (id === "A" && a.drop) out.drop = true;
    if (id === "B" && a.rise) out.rise = true;
    if (a.humidityJump) out.humidityJump = 15;
    if (id === "B" && a.freeze) out.freeze = true;
    return out;
  }

  /** Escena simulada: dos displays tipo HTC-2 en las posiciones de calibración por defecto. */
  function renderSimFrame(now) {
    const a = App.sim.anomalies;
    const layout = L.defaultCalibration("A").fields;
    const sensors = ["A", "B"].map((id) => {
      const v = App.sim.simulator.valuesAt(id, now, simAnomaliesFor(id));
      // Escena simulada: dos HTC-2 pequeños sobre una caja, como en el cuarto de cría.
      const k = id === "A" ? 0 : 1, t = now / 1000;
      let cx = (0.36 + k * 0.28) * SIM_W, cy = 0.56 * SIM_H, ang = ((k ? 3 : -6) * Math.PI) / 180;
      if (a.move) { cx += Math.sin(t / 9 + k) * SIM_W * 0.07; cy += Math.cos(t / 13 + k * 2) * SIM_H * 0.08; ang += Math.sin(t / 11 + k) * 0.12; }
      const w = SIM_W * 0.15, h = w * 0.76, c = Math.cos(ang), sn = Math.sin(ang);
      const quad = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => ({ x: cx + x * c - y * sn, y: cy + x * sn + y * c }));
      return {
        quad,
        fields: layout,
        slantDeg: 6,
        hidden: id === "B" && a.hideB,
        blank: id === "A" && a.blankA,
        values: { tempIn: v.tempIn.toFixed(1), tempOut: v.tempOut.toFixed(1), humidity: String(v.humidity), time: v.time },
      };
    });
    const gray = Seg.makeSimFrame(SIM_W, SIM_H, sensors, { noise: a.noise ? 70 : 6, seed: (now / 1000) | 0 });
    const canvas = document.createElement("canvas");
    canvas.width = SIM_W; canvas.height = SIM_H;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(SIM_W, SIM_H);
    Seg.toRGBA(gray, img.data);
    ctx.putImageData(img, 0, 0);
    return { gray, canvas, label: "Simulación" };
  }

  /** fresh: lienzo propio (ciclo de lectura / imagen congelada) para que la vista previa no lo sobrescriba. */
  function grabFromVideo(entry, fresh) {
    const v = entry.video, track = entry.stream.getVideoTracks()[0];
    if (!track || track.readyState !== "live") return { error: "La cámara no está activa (" + entry.label + ")" };
    if (v.readyState < 2 || !v.videoWidth) return { error: "La cámara aún no entrega imagen (" + entry.label + ")" };
    const c = fresh ? document.createElement("canvas") : entry.canvas;
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(v, 0, 0);
    // La conversión a gris (~40 ms en HD) solo se hace si alguien la necesita: las vistas previas solo dibujan.
    let gray = null;
    return { canvas: c, label: entry.label, get gray() { return gray || (gray = Seg.fromRGBA(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height)); } };
  }

  /** Fotograma para un sensor según la fuente configurada. cache: comparte el frame entre sensores. */
  function grabFrame(sensor, cache, now, fresh) {
    const src = App.settings.frameSource;
    if (src === "simulation") {
      if (App.sim.anomalies.cameraFail) return { error: "Simulación: cámara sin señal" };
      if (!cache.sim) cache.sim = renderSimFrame(now);
      return cache.sim;
    }
    if (src === "image") return App.still || { error: "No hay imagen cargada (Cámara → Imagen estática)" };
    const entry = streamFor(sensor);
    if (!entry) return { error: App.cam.status === "error" ? App.cam.error : "La cámara no está activada" };
    const key = "cam:" + entry.deviceId;
    if (!cache[key]) cache[key] = grabFromVideo(entry, fresh);
    return cache[key];
  }

  /** Fotograma para vistas previas (la simulación se regenera cada 2 s como máximo). */
  function previewFrame(sensor) {
    const src = App.settings.frameSource;
    if (src === "simulation") {
      const now = Date.now();
      if (!App.sim.frame || now - App.sim.frameAt > 2000) { App.sim.frame = App.sim.anomalies.cameraFail ? { error: "Simulación: cámara sin señal" } : renderSimFrame(now); App.sim.frameAt = now; }
      return App.sim.frame;
    }
    return grabFrame(sensor || sensorById("A"), {}, Date.now());
  }

  // ─────────────────────────── análisis de un sensor ───────────────────────────

  function quadPx(cal, w, h) { return cal.quad.map((p) => ({ x: p.x * w, y: p.y * h })); }

  /** Rectifica, preprocesa y lee los campos de un sensor en un fotograma. */
  function analyzeSensor(sensor, gray, cal, updateThumb) {
    cal = cal || sensor.calibration;
    const q = quadPx(cal, gray.w, gray.h);
    const lcd = Seg.prepareLcd(gray, q, 480);
    const size = lcd.size, raw = lcd.raw, clean = lcd.img;
    const fields = {}, details = {};
    const contrast = lcd.contrast; // contraste REAL del LCD (sirve para detectar pantalla apagada)
    L.FIELD_KEYS.forEach((key) => {
      const f = cal.fields[key];
      if (!f || !f.enabled) return;
      const roi = { x: f.x * size.w, y: f.y * size.h, w: f.w * size.w, h: f.h * size.h };
      const r = Seg.decodeField(clean, roi, { digits: f.digits, decimals: f.decimals, slantDeg: cal.slantDeg, lightSegments: cal.lightSegments, format: key === "time" ? "time" : "number" });
      fields[key] = { text: r.text, confidence: r.confidence };
      details[key] = r;
    });
    const thumb = Seg.thumbnail(raw);
    const prev = App.prevThumbs[sensor.id];
    const ref = Seg.b64ToThumb(cal.reference);
    if (updateThumb) App.prevThumbs[sensor.id] = thumb;
    return {
      capture: {
        captureStatus: "ok",
        fields,
        contrast,
        imageChangeScore: prev ? Seg.thumbDiff(prev, thumb, false) : undefined,
        referenceDiffScore: ref ? Seg.thumbDiff(ref, thumb, true) : undefined,
      },
      raw,
      clean,
      size,
      details,
      thumb,
    };
  }

  // ─────────────────────────── seguimiento de pantallas ───────────────────────────

  const normQuad = (q, w, h) => q.map((p) => ({ x: p.x / w, y: p.y / h }));
  const pxQuad = (q, w, h) => q.map((p) => ({ x: p.x * w, y: p.y * h }));
  const isTracking = (s) => !!(s.calibration.track && s.calibration.track.enabled === true);

  /** Fija un sensor sobre una pantalla (LCD, px): esquinas + plantilla para seguirla + referencia. */
  function lockSensorOn(sensor, gray, quadPxLcd, fields, slantDeg) {
    const cal = sensor.calibration;
    cal.quad = normQuad(quadPxLcd, gray.w, gray.h);
    if (fields) cal.fields = fields;
    if (slantDeg != null) cal.slantDeg = slantDeg;
    cal.track = { enabled: !!(cal.track && cal.track.enabled === true), tpl: Seg.makeTemplate(gray, quadPxLcd) };
    const a = analyzeSensor(sensor, gray, cal, false);
    cal.reference = Seg.thumbToB64(a.thumb);
    App.prevThumbs[sensor.id] = null;
    App.track.state[sensor.id] = { ok: true, score: 1, how: "ubicada", at: Date.now() };
    App.track.tplRefreshed[sensor.id] = Date.now();
  }

  /**
   * Pantallas HTC-2 en toda la imagen: primero por su patrón de dígitos (sirve aunque
   * el LCD no tenga marco oscuro) y, si faltan, por el marco; solo se aceptan
   * candidatos con dígitos (verificados), nunca camisas, cajas u otros objetos.
   */
  function findScreens(gray, need) {
    const base = App.sensors[0].calibration.fields, opts = { slantDeg: App.sensors[0].calibration.slantDeg, need };
    const found = Seg.detectHtc2(gray, base, opts);
    if (found.length < need) {
      Seg.detectLcds(gray).forEach((c) => {
        if (found.some((f) => Seg.pointInQuad(f.quad, Seg.quadCenter(c.quad)))) return;
        const sn = Seg.snapHtc2(gray, c.quad.map((p, i, q) => { const cc = Seg.quadCenter(q); return { x: cc.x + (p.x - cc.x) * 1.15, y: cc.y + (p.y - cc.y) * 1.15 }; }), base, opts);
        if (sn && sn.score >= 0.22) found.push({ quad: sn.quad, fields: sn.fields, slantDeg: sn.slantDeg, area: Seg.quadArea(sn.quad), score: sn.score * 1000, kind: "marco" });
      });
    }
    return found.slice(0, 6);
  }

  /** Detecta pantallas en toda la imagen y asigna las que falten (izquierda → A, derecha → B). */
  function autoAssign(gray, sensors, force) {
    const found = findScreens(gray, sensors.length);
    App.cal.candidates = { list: found, w: gray.w, h: gray.h };
    App.cal.candidatesAt = Date.now();
    const targets = sensors.filter((s) => force || !(s.calibration.track && s.calibration.track.tpl));
    const taken = sensors.filter((s) => !targets.includes(s)).map((s) => pxQuad(s.calibration.quad, gray.w, gray.h));
    const free = found.filter((f) => !taken.some((t) => Seg.pointInQuad(t, Seg.quadCenter(f.quad))));
    const pick = free.slice(0, targets.length).sort((a, b) => Seg.quadCenter(a.quad).x - Seg.quadCenter(b.quad).x);
    targets.sort((a, b) => (a.id < b.id ? -1 : 1)).forEach((s, i) => { if (pick[i]) lockSensorOn(s, gray, pick[i].quad, pick[i].fields, pick[i].slantDeg); });
    return { found: found.length, assigned: Math.min(pick.length, targets.length) };
  }

  /** Reubica (si se movieron) los sensores que usan este fotograma. */
  function trackOnFrame(gray, sensors) {
    const list = sensors.filter(isTracking);
    if (!list.length) return;
    // sensores que nunca se ubicaron → reconocimiento automático (como mucho cada 30 s: es costoso)
    if (list.some((s) => !s.calibration.track.tpl) && Date.now() - (App.track.lastAuto || 0) > 30000) {
      App.track.lastAuto = Date.now();
      autoAssign(gray, list, false);
    }
    const ready = list.filter((s) => s.calibration.track.tpl);
    if (!ready.length) return;
    const res = Seg.trackScreens(gray, ready.map((s) => ({ id: s.id, tpl: s.calibration.track.tpl, last: pxQuad(s.calibration.quad, gray.w, gray.h), fields: s.calibration.fields })), { slantDeg: ready[0].calibration.slantDeg });
    const now = Date.now();
    let changed = false;
    ready.forEach((s) => {
      const r = res[s.id];
      if (r && r.quad) {
        const q = normQuad(r.quad, gray.w, gray.h), old = s.calibration.quad;
        if (Math.hypot(q[0].x - old[0].x, q[0].y - old[0].y) > 0.004) changed = true;
        s.calibration.quad = q;
        App.track.state[s.id] = { ok: true, score: r.score, how: r.how, at: now };
        // renovar la plantilla cada tanto (la luz cambia durante el día) si la coincidencia es buena
        if (r.score > 0.8 && now - (App.track.tplRefreshed[s.id] || 0) > 10 * 60000) {
          s.calibration.track.tpl = Seg.makeTemplate(gray, r.quad) || s.calibration.track.tpl;
          App.track.tplRefreshed[s.id] = now;
          changed = true;
        }
      } else {
        App.track.state[s.id] = { ok: false, score: r ? r.score : 0, how: "no encontrada", at: now };
      }
    });
    if (changed && now - App.track.lastPersist > 30000) { App.track.lastPersist = now; saveSensors(); }
  }

  /** Agrupa sensores por fotograma y ejecuta el seguimiento una vez por fotograma. */
  function trackFrames(getFrame) {
    const byFrame = new Map();
    App.sensors.filter((s) => s.enabled).forEach((s) => {
      const fr = getFrame(s);
      if (fr && !fr.error) byFrame.set(fr, (byFrame.get(fr) || []).concat(s));
    });
    byFrame.forEach((list, fr) => { try { trackOnFrame(fr.gray, list); } catch (e) { console.warn("seguimiento", e); } });
  }

  // ─────────────────────────── ciclo de lectura ───────────────────────────

  function canvasToJpeg(canvas) {
    const max = 960, scale = Math.min(1, max / canvas.width);
    const c = document.createElement("canvas");
    c.width = Math.round(canvas.width * scale); c.height = Math.round(canvas.height * scale);
    c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/jpeg", 0.72));
  }

  async function runCycle(reason) {
    if (App.busy) return;
    App.busy = true;
    const now = Date.now(), S = App.settings, cache = {}, results = [];
    try {
      const active = App.sensors.filter((s) => s.enabled);
      const frames = new Map(active.map((s) => [s.id, grabFrame(s, cache, now, true)]));
      trackFrames((s) => frames.get(s.id));
      for (const sensor of active) {
        const fr = frames.get(sensor.id);
        let capture;
        if (!fr || fr.error) capture = { captureStatus: "camera_error", fields: {}, error: (fr && fr.error) || "Sin imagen" };
        else {
          capture = analyzeSensor(sensor, fr.gray, null, true).capture;
          capture.cameraLabel = fr.label;
          const tk = App.track.state[sensor.id];
          const readable = Object.keys(capture.fields).some((k) => capture.fields[k] && capture.fields[k].confidence >= 50);
          if (isTracking(sensor) && tk && !tk.ok && !readable) {
            capture.referenceDiffScore = 100; // pantalla no encontrada y nada legible → SENSOR NO DETECTADO
            capture.error = "La pantalla del sensor no se encontró en la imagen (seguimiento).";
          }
        }
        const lookback = Math.max(3 * HOUR, S.changeWindowMin * 60000 * 1.5, (S.staleCycles + 2) * S.intervalSec * 1000);
        const history = (await App.store.readingsRange(now - lookback, now, sensor.id)).sort((a, b) => a.ts - b.ts);
        if (!history.length) {
          const last = await App.store.lastReading(sensor.id);
          if (last) history.push(last); // permite detectar periodos largos sin datos
        }
        const recentEvents = await App.store.eventsRange(now - DAY, now, sensor.id);
        const res = L.processCycle({ now, settings: S, sensor, capture, source: S.frameSource, history, recentEvents });
        const important = res.events.some((e) => e.severity !== "INFO");
        if (fr && fr.canvas && (S.saveSnapshots === "all" || (S.saveSnapshots === "events" && important))) {
          try { res.reading.snapshotId = await App.store.addSnapshot(await canvasToJpeg(fr.canvas), { ts: now, sensorId: sensor.id, readingId: res.reading.id }); } catch (e) { /* la evidencia es opcional */ }
        }
        await App.store.saveCycle([res.reading], res.events);
        App.latest[sensor.id] = res.reading;
        results.push(res);
      }
      App.lastCycleAt = now;
      await App.store.setKV("lastCycleAt", now);
      if (now - App.lastPurge > HOUR) {
        App.lastPurge = now;
        await App.store.purgeSnapshots(now - S.snapshotRetentionDays * DAY);
      }
      notifyEvents(results.flatMap((r) => r.events));
      if (window.MonThermalUI) window.MonThermalUI.onCycle(results); // temperatura de caja → gateway térmico
    } catch (e) {
      toast("Error en el ciclo de lectura: " + (e && e.message ? e.message : e), "crit");
    } finally {
      App.busy = false;
      if (App.running) App.nextAt = now + S.intervalSec * 1000;
      renderHeader();
      if (["dashboard", "historico", "alertas", "graficas"].indexOf(App.view) >= 0) renderView();
      else updateAlertCount();
    }
    return results;
  }

  function notifyEvents(events) {
    events.filter((e) => e.severity !== "INFO").forEach((e) => {
      toast(e.severity + " · " + (L.EVENT_LABELS[e.type] || e.type) + ": " + e.description, e.severity === "CRITICAL" ? "crit" : "warn");
      if (App.settings.notifications && "Notification" in window && Notification.permission === "granted") {
        try { new Notification("BioTeva · " + (L.EVENT_LABELS[e.type] || e.type), { body: e.description, icon: "icons/icon-128.png", tag: e.sensorId + e.type }); } catch (err) { /* opcional */ }
      }
    });
  }

  async function setRunning(on) {
    App.running = on;
    await App.store.setKV("running", on);
    extensionSync();
    if (on) {
      if (App.settings.frameSource === "camera" && App.cam.status !== "active") await startCameras();
      App.nextAt = Date.now();
      try { if ("wakeLock" in navigator) App.wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { App.wakeLock = null; }
    } else {
      App.nextAt = 0;
      if (App.wakeLock) { App.wakeLock.release().catch(() => {}); App.wakeLock = null; }
    }
    renderHeader();
  }

  // Dentro de la extensión: la pestaña no se descarta por ahorro de memoria y el
  // service worker sabe si debe reabrir la app cuando Chrome se inicia.
  function extensionSync() {
    if (!App.isExtension || typeof chrome === "undefined") return;
    try { chrome.storage && chrome.storage.local.set({ running: !!App.running }); } catch (e) { /* opcional */ }
    try {
      chrome.tabs && chrome.tabs.getCurrent((tab) => {
        if (tab && tab.id != null) chrome.tabs.update(tab.id, { autoDiscardable: false }, () => void chrome.runtime.lastError);
      });
    } catch (e) { /* opcional */ }
  }

  function tick() {
    if (window.MonThermalUI) window.MonThermalUI.poll(false);
    // Si la cámara se desconectó o falló, reintentar sola cada 30 s mientras el monitoreo siga en curso.
    if (App.running && App.settings.frameSource === "camera" && (App.cam.status === "error" || App.cam.status === "off") &&
        Date.now() - (App.cam.lastTry || 0) > 30000) startCameras();
    if (App.running && !App.busy && Date.now() >= App.nextAt) runCycle("timer");
    renderHeader();
  }

  // ─────────────────────────── cabecera ───────────────────────────

  function nextIn() {
    if (!App.running || !App.nextAt) return "";
    const s = Math.max(0, Math.round((App.nextAt - Date.now()) / 1000));
    return s < 60 ? s + " s" : Math.ceil(s / 60) + " min";
  }

  function renderHeader() {
    const S = App.settings, pill = $("#statusPill");
    let cls = "", text = "Detenido";
    const camBad = S.frameSource === "camera" && App.cam.status === "error";
    if (camBad) { cls = "crit"; text = "La cámara no responde"; }
    else if (App.running && App.busy) { cls = "info"; text = "Leyendo…"; }
    else if (App.running) { cls = "good"; text = "Monitoreando · próxima lectura en " + nextIn(); }
    if (S.frameSource === "simulation") text += " · simulación";
    pill.className = "status-pill " + cls;
    pill.title = camBad ? App.cam.error || "" : App.lastCycleAt ? "Última lectura: " + fmtWhen(App.lastCycleAt) : "";
    if ($("#statusText").textContent !== text) $("#statusText").textContent = text;
    const btn = $("#runBtn"), label = App.running ? "Pausar" : "▶ Iniciar monitoreo";
    if (btn.textContent !== label) btn.textContent = label;
    btn.classList.toggle("primary", !App.running);
    const dn = $("#dashNext");
    if (dn) dn.textContent = App.running ? nextIn() || "ahora" : "detenido";
  }

  /** Episodios de alerta de los últimos días (los «Activos» son los que cuenta el globo rojo). */
  async function loadEpisodes(days) {
    const now = Date.now();
    const [evs, rs] = await Promise.all([App.store.eventsRange(now - days * DAY, now), App.store.readingsRange(now - Math.min(days, 7) * DAY, now)]);
    return L.alertEpisodes(evs, rs, App.sensors, App.settings, now);
  }

  async function updateAlertCount() {
    const now = Date.now();
    const evs = await App.store.eventsRange(now - 7 * DAY, now);
    const n = L.alertEpisodes(evs, [], App.sensors, App.settings, now).filter((e) => e.status === "Activa").length;
    ["#alertCount", "#alertCount2"].forEach((sel) => { const el = $(sel); if (!el) return; el.textContent = n; el.classList.toggle("hot", n > 0); el.hidden = !n; });
  }

  async function renderBanners() {
    const out = [];
    if (App.settings.frameSource === "simulation") out.push('<div class="banner info">' + ico("info", 20) + '<span><b>Modo simulación.</b> Los valores son de prueba y quedan marcados como «simulación». Cámbialo en <b>Ajustes → Lecturas y cámara</b>.</span></div>');
    else if (await App.store.hasSimulated()) out.push('<div class="banner info">' + ico("info", 20) + '<span>Hay datos de prueba (simulación) guardados junto con los reales. Están marcados y puedes borrarlos en <b>Ajustes → Avanzado</b>.</span></div>');
    if (!window.isSecureContext) out.push('<div class="banner warn">Esta página no está en un origen seguro: Chrome no permitirá la cámara. Ábrela como extensión, en http://localhost o por https.</div>');
    if (App.running && App.settings.frameSource === "camera") out.push('<div class="banner muted">Mantén esta ventana abierta y el equipo encendido: si se cierra, se suspende o se apaga, las lecturas se detienen y se registrará un periodo sin datos.</div>');
    $("#banners").innerHTML = out.join("");
  }

  // ─────────────────────────── navegación ───────────────────────────

  // 4 secciones principales; todo lo demás vive dentro de «Ajustes» (menú lateral).
  const GROUP = (v) => (v === "dashboard" || v === "caja" || v === "alertas" ? v : "ajustes");

  function showView(name) {
    if (name === "ajustes") name = App.lastSettings || "sensores";
    if (!$('main > section[data-view="' + name + '"]')) name = "dashboard";
    if (name === "calibracion" && App.view !== "calibracion") App.cal.step = 1;
    App.view = name;
    const g = GROUP(name), inSettings = g === "ajustes" && name !== "calibracion";
    if (g === "ajustes" && name !== "calibracion") App.lastSettings = name;
    $$("#tabs .tab, #bottomNav button").forEach((t) => t.setAttribute("aria-selected", t.dataset.view === g ? "true" : "false"));
    $$("#sideNav button").forEach((b) => (b.dataset.view === name ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
    $("#sideNav").hidden = !inSettings;
    $("#main").classList.toggle("settings-mode", inSettings);
    $$("main > section").forEach((s) => (s.hidden = s.dataset.view !== name));
    if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
    window.scrollTo(0, 0);
    renderView();
  }

  function renderView() {
    renderBanners();
    updateAlertCount();
    switch (App.view) {
      case "dashboard": return renderDashboard();
      case "caja": return renderCaja();
      case "datos": return renderDatos();
      case "camara": return renderCameraForm();
      case "calibracion": return openCalibration();
      case "termico": return window.MonThermalUI ? window.MonThermalUI.render() : null;
      case "sensores": return renderSensors();
      case "historico": return renderHistory();
      case "graficas": return renderCharts();
      case "alertas": return renderAlerts();
      case "reportes": return renderReports();
      case "configuracion": return renderSettings();
      case "ayuda": return null; // guía estática (index.html)
      case "plan": return null; // hoja de ruta estática (index.html); el botón se enlaza en init
    }
  }

  // ─────────────────────────── INICIO ───────────────────────────

  /** Valor de una lectura: el confiable, o el dudoso aparte (se muestra tachado y no se usa). */
  function shownValue(last, k) {
    if (!last) return { v: null, doubt: null };
    if (last[k] != null) return { v: last[k], doubt: null };
    const raw = last.fields && last.fields[k];
    return { v: null, doubt: raw && raw.value != null ? raw.value : null };
  }
  const outOf = (v, mn, mx) => v != null && ((mx != null && v > mx) || (mn != null && v < mn));

  /** Desde cuándo la serie está fuera de los límites (racha final), o null. */
  function outSince(rows, k, mn, mx) {
    let since = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const v = rows[i][k];
      if (v == null) continue;
      if (outOf(v, mn, mx)) since = rows[i].ts; else break;
    }
    return since;
  }

  function trendHtml(rows, k, unit) {
    const sl = L.slopePerMin(rows.map((r) => ({ ts: r.ts, v: r[k] })));
    if (sl == null) return "";
    const perH = sl * 60, dir = Math.abs(perH) < 0.2 ? "flat" : perH > 0 ? "up" : "down";
    return "<b>" + ico(dir, 18) + esc(dir === "flat" ? "Estable" : (dir === "up" ? "Subiendo " : "Bajando ") + fmt(Math.abs(perH)) + " " + unit + "/h") + "</b>";
  }

  function rangeHtml(v, mn, mx, unit, dec) {
    if (mn == null || mx == null) return "";
    const span = mx - mn || 1;
    let lo = mn - span * 0.6, hi = mx + span * 0.6;
    if (v != null) { lo = Math.min(lo, v - span * 0.15); hi = Math.max(hi, v + span * 0.15); }
    const pos = (x) => (((x - lo) / (hi - lo)) * 100).toFixed(1);
    return '<div class="range" aria-hidden="true"><div class="range-bar"><div class="range-ok" style="left:' + pos(mn) + "%;width:" + (pos(mx) - pos(mn)).toFixed(1) + '%"></div>' +
      (v != null ? '<div class="range-mark' + (outOf(v, mn, mx) ? " crit" : "") + '" style="left:' + pos(v) + '%"></div>' : "") + "</div>" +
      '<div class="range-labels"><span style="left:' + pos(mn) + '%">' + fmt(mn, dec) + '</span><span style="left:' + pos(mx) + '%">' + fmt(mx, dec) + " " + unit + "</span></div></div>";
  }

  function thermalStatus() { return window.MonThermalUI && window.MonThermalUI.getStatus ? window.MonThermalUI.getStatus() : null; }
  function thermalBoxFor(sensorId) {
    const st = thermalStatus();
    return st && st.boxes ? st.boxes.find((b) => b.enabled && b.sensorId === sensorId) || null : null;
  }
  const MODE_TXT = { AUTO: "Automático", MANUAL_ON: "Manual · encendida", MANUAL_OFF: "Manual · apagada" };
  function lampLine(bx) {
    if (!bx) return "";
    const stt = bx.state || {};
    if (stt.safety) return '<div class="lamp-line crit">' + ico("crit") + "<b>Lámpara apagada por seguridad</b><span>se calentó de más</span></div>";
    if (bx.device === "UNREACHABLE" || stt.heater === "UNREACHABLE") return '<div class="lamp-line crit">' + ico("crit") + "<b>Sin comunicación con el enchufe</b></div>";
    const on = stt.heater === "ON";
    return '<div class="lamp-line' + (on ? " on" : "") + '">' + ico("lamp") + "<b>Lámpara " + (on ? "encendida" : "apagada") + "</b><span>· " + esc(MODE_TXT[bx.mode] || bx.mode || "") + (on && stt.onSince ? " · desde " + esc(fmtHour(stt.onSince)) : "") + "</span></div>";
  }

  function boxCard(s, last, st, todayRows, hourRows) {
    const ui = STATUS_UI[st.code] || STATUS_UI.SIN_DATOS;
    const ck = L.controlKey(s), other = ck === "tempOut" ? "tempIn" : "tempOut";
    const noData = st.code === "SIN_DATOS";
    const t = shownValue(last, ck), h = shownValue(last, "humidity"), o = shownValue(last, other);
    const tOut = outOf(t.v, s.tempMin, s.tempMax);
    let hero;
    if (noData || (t.v == null && t.doubt == null)) hero = '<span class="hero-num off" aria-label="sin dato">– –</span>';
    else if (t.v == null) hero = '<span class="hero-num struck" title="Lectura dudosa: no se usa">' + fmt(t.doubt) + "<small>°C</small></span>";
    else hero = '<span class="hero-num' + (tOut ? " crit" : "") + '">' + fmt(t.v) + "<small>°C</small></span>";
    let note = "";
    if (noData) note = '<p class="range-note off">' + esc(st.note || "Sin lecturas") + "</p>";
    else if (t.v == null && t.doubt != null) note = '<p class="range-note warn">La app no está segura de este número y no lo usa. Si pasa seguido, calibra de nuevo.</p>';
    else if (s.tempMin == null && s.tempMax == null) note = '<p class="range-note off">Sin límites configurados · <a href="#sensores" data-go="sensores">Poner límites</a></p>';
    else if (tOut) {
      const since = outSince(todayRows, ck, s.tempMin, s.tempMax);
      const d = s.tempMax != null && t.v > s.tempMax ? fmt(t.v - s.tempMax) + " °C sobre el máximo" : fmt(s.tempMin - t.v) + " °C bajo el mínimo";
      note = '<p class="range-note crit">' + esc(d) + (since ? " · fuera desde " + esc(fmtWhen(since)) : "") + "</p>";
    } else if (t.v != null) note = '<p class="range-note">Dentro de tus límites</p>';
    const kvv = (x, unit, dec, crit) =>
      x.v != null ? '<span class="v md' + (crit ? " crit" : "") + '">' + fmt(x.v, dec) + " " + unit + "</span>"
      : x.doubt != null ? '<span class="v md struck" title="Lectura dudosa">' + fmt(x.doubt, dec) + " " + unit + "</span>"
      : '<span class="v md">– –</span>';
    const humLim = s.humMin == null && s.humMax == null ? "sin límites" : "tus límites " + (s.humMin != null ? fmt(s.humMin, 0) : "–") + "–" + (s.humMax != null ? fmt(s.humMax, 0) : "–") + " %";
    return '<article class="box ' + ui.box + '">' +
      '<div class="box-head"><h2>' + esc(s.name) + (s.enabled ? "" : " (apagado)") + "</h2>" + statusChip(st.code) + "</div>" +
      '<div class="box-body">' +
        '<span class="box-label">' + (ck === "tempOut" ? "Temperatura de la caja (OUT)" : "Temperatura (IN)") + "</span>" +
        '<div class="hero">' + hero + '<div class="trend">' + (noData ? "" : trendHtml(hourRows, ck, "°C")) + "<span>" + (last ? esc(fmtAgo(last.ts)) : "aún sin lecturas") + (last && last.source === "simulation" ? ' · <span class="tag">simulación</span>' : "") + "</span></div></div>" +
        (noData ? "" : rangeHtml(t.v, s.tempMin, s.tempMax, "°C", 1)) + note +
        '<div class="duo"><div class="kv"><span>Humedad</span>' + kvv(noData ? {} : h, "%", 0, outOf(h.v, s.humMin, s.humMax)) + '<span class="s">' + esc(humLim) + "</span></div>" +
        '<div class="kv"><span>' + (other === "tempIn" ? "Temp. del cuarto (IN)" : "Temp. de la caja (OUT)") + "</span>" + kvv(noData ? {} : o, "°C", 1, false) + "</div></div>" +
        lampLine(thermalBoxFor(s.id)) +
      "</div>" +
      '<button class="box-foot" type="button" data-caja="' + esc(s.id) + '">Ver gráfica de hoy <span aria-hidden="true">→</span></button>' +
    "</article>";
  }

  const ACT_LVL = { crit: "YA", warn: "PRONTO", info: "INFO", good: "OK" };
  const ACT_KIND = { manejo: "Manejo", accidente: "Riesgo", sistema: "Sistema" };
  /** Botón de la tarjeta «Qué hacer ahora»: [texto, acción, destino]. */
  function actButton(t) {
    if (t.level === "good") return null;
    if (/leyendo bien/.test(t.title)) return ["Ir a calibrar", "go", "calibracion"];
    if (/sin límites/.test(t.title)) return ["Poner límites", "go", "sensores"];
    if (/no llegan lecturas/.test(t.title)) return App.running ? ["Revisar la cámara", "go", "camara"] : ["▶ Iniciar monitoreo", "run", ""];
    if (t.kind === "accidente") return ["Ver lámparas", "go", "termico"];
    if (t.sensorId) return ["Ver gráfica", "caja", t.sensorId];
    return null;
  }

  /** «Últimos registros»: las lecturas guardadas más recientes (también tras apagar el equipo). */
  function lastRecordsHtml(rows) {
    const last = rows.slice().sort((a, b) => b.ts - a.ts).slice(0, 12);
    const cell = (r, k, dec) => {
      if (r[k] != null) return esc(fmt(r[k], dec));
      const f = r.fields && r.fields[k];
      return f && f.value != null ? '<span class="doubt" title="Lectura dudosa: no se usa">' + esc(fmt(f.value, dec)) + "?</span>" : "–";
    };
    return '<div class="panel" style="margin-top:20px"><header><h2>Últimos registros</h2><div class="spacer"></div><a class="btn ghost small" href="#historico" data-go="historico">Ver historial →</a></header>' +
      (last.length
        ? '<div class="table-scroll"><table><thead><tr><th>Cuándo</th><th>Caja</th><th>Temp. IN (arriba)</th><th>Temp. OUT (abajo)</th><th>Humedad</th><th>Estado</th></tr></thead><tbody>' +
          last.map((r) => { const s = sensorById(r.sensorId); return "<tr><td>" + esc(fmtWhen(r.ts)) + (r.source === "simulation" ? ' <span class="tag">simulación</span>' : "") + "</td><td>" + esc(s ? s.name : r.sensorId) + "</td><td>" + cell(r, "tempIn", 1) + " °C</td><td>" + cell(r, "tempOut", 1) + " °C</td><td>" + cell(r, "humidity", 0) + " %</td><td>" + statusChip(r.status) + "</td></tr>"; }).join("") +
          "</tbody></table></div>"
        : '<div class="panel-body"><p class="muted-text">Aún no hay registros en los últimos 7 días. Toca «▶ Iniciar monitoreo» para empezar a guardar lecturas.</p></div>') +
      "</div>";
  }

  async function renderDashboard() {
    const host = $('section[data-view="dashboard"]');
    const now = Date.now(), S = App.settings;
    const dayStart = L.dayBounds(L.dayKey(now)).from;
    const [today, recent3h, events24h] = await Promise.all([App.store.readingsRange(dayStart, now), App.store.readingsRange(now - 3 * HOUR, now), App.store.eventsRange(now - DAY, now)]);
    today.sort((a, b) => a.ts - b.ts);
    const thermal = thermalStatus();
    const todo = L.actionItems({ sensors: App.sensors, readings: recent3h, events: events24h, thermal, running: App.running, now, settings: S });

    const cards = [], resumen = [];
    for (const s of App.sensors) {
      const last = App.latest[s.id] || (await App.store.lastReading(s.id));
      if (last) App.latest[s.id] = last;
      const st = L.currentStatus(s, last, now, S);
      const mine = today.filter((r) => r.sensorId === s.id);
      const hour = recent3h.filter((r) => r.sensorId === s.id && r.ts >= now - HOUR);
      cards.push(boxCard(s, last, st, mine, hour));
      if (!s.enabled) continue;
      const ck = L.controlKey(s), d = L.describe(mine.map((r) => r[ck]));
      const o = L.minutesOutOfRange(mine, s, now, S), outMin = o.tempHigh + o.tempLow, outH = o.humHigh + o.humLow;
      const hasLim = s.tempMin != null || s.tempMax != null || s.humMin != null || s.humMax != null;
      resumen.push('<div class="kv"><span>' + esc(s.name) + "</span>" +
        (d.n ? '<span class="v sm">' + fmt(d.min) + " – " + fmt(d.max) + " °C</span>" : '<span class="v sm">– –</span>') +
        '<span class="s">' + (!d.n ? "sin lecturas hoy" : !hasLim ? "sin límites configurados" : outMin + outH ? "fuera de límites: " + esc(fmtDur(outMin * 60000)) + " temp. · " + esc(fmtDur(outH * 60000)) + " humedad" : "todo el día dentro de tus límites") + "</span></div>");
    }

    const todoHtml = '<aside class="todo-col col"><div class="todo-head"><h2>Qué hacer ahora</h2><span class="muted-text">' + esc(fmtHour(now)) + "</span></div>" +
      todo.map((t, i) => {
        const b = actButton(t);
        return '<div class="act ' + t.level + '"><div class="act-meta"><span class="lvl">' + ACT_LVL[t.level] + "</span>" + (t.level !== "good" ? '<span class="kind">' + esc(ACT_KIND[t.kind] || "") + "</span>" : "") + "</div>" +
          '<div class="act-title">' + esc(decTxt(t.title)) + "</div><p>" + esc(decTxt(t.action)) + "</p>" +
          (b ? '<div><button class="btn on-act" type="button" data-act="' + i + '">' + esc(b[0]) + "</button></div>" : "") + "</div>";
      }).join("") + "</aside>";

    const boxes = thermal && thermal.boxes ? thermal.boxes.filter((b) => b.enabled) : [];
    const lampsHtml = '<div class="panel"><header><h2>Lámparas</h2><div class="spacer"></div><a class="btn ghost small" href="#termico" data-go="termico">Abrir →</a></header><div class="panel-body">' +
      (boxes.length
        ? boxes.map((b) => { const on = b.state && b.state.heater === "ON"; return '<div class="lamp-row"><b>' + esc(b.name) + '</b><span class="chip soft ' + (on ? "warn" : "") + '">' + ico("lamp", 16) + (on ? "Encendida" : "Apagada") + '</span><span class="muted-text">' + esc(MODE_TXT[b.mode] || b.mode || "") + "</span></div>"; }).join("")
        : '<p class="muted-text">' + (window.MonThermalUI && window.MonThermalUI.online === false ? "El control de lámparas no está conectado en este computador. La lectura de los sensores sigue funcionando." : "No hay lámparas configuradas.") + "</p>") +
      "</div></div>";
    const srcTxt = { camera: { active: "Cámara activa", starting: "Encendiendo la cámara…", error: "La cámara no responde", off: "Cámara apagada" }[App.cam.status] || "Cámara apagada", image: "Imagen de prueba", simulation: "Simulación (datos de prueba)" }[S.frameSource];
    const camHtml = '<div class="panel"><header><h2>Cámara</h2></header><div class="panel-body"><div class="cam-mini"><canvas id="dashPreview" width="1280" height="720" aria-label="Vista previa de la cámara"></canvas>' +
      '<div class="col" style="gap:6px"><b>' + esc(srcTxt) + '</b><span class="muted-text">Lee cada ' + esc(intervalLabel(S.intervalSec)) + ' · próxima: <b id="dashNext">' + esc(App.running ? nextIn() || "ahora" : "detenido") + "</b></span>" +
      '<div class="row-actions"><button class="btn small" type="button" id="dashNow">Leer ahora</button><a class="btn ghost small" href="#calibracion" data-go="calibracion">Calibrar</a></div></div></div></div></div>';

    host.innerHTML =
      '<div class="home"><div class="boxes">' + cards.join("") + "</div>" + todoHtml + "</div>" +
      '<div class="trio">' +
        '<div class="panel"><header><h2>Hoy en resumen</h2></header><div class="panel-body col">' + (resumen.join("") || '<p class="muted-text">No hay sensores activos.</p>') +
          '<button class="btn small" id="askToday" type="button">¿Hubo cambios importantes hoy?</button><div id="todayAnswer" class="answer" hidden></div></div></div>' +
        lampsHtml + camHtml +
      "</div>" + lastRecordsHtml(await App.store.readingsRange(now - 7 * DAY, now));

    $$("[data-caja]", host).forEach((b) => b.addEventListener("click", () => { App.caja.sensor = b.dataset.caja; App.caja.period = "today"; showView("caja"); }));
    $$("[data-act]", host).forEach((btn) => btn.addEventListener("click", () => {
      const b = actButton(todo[Number(btn.dataset.act)]);
      if (!b) return;
      if (b[1] === "run") setRunning(true).then(renderDashboard);
      else if (b[1] === "caja") { App.caja.sensor = b[2]; App.caja.period = "today"; showView("caja"); }
      else { if (b[2] === "calibracion") App.cal.step = 1; showView(b[2]); }
    }));
    $("#askToday").addEventListener("click", async () => {
      const b = L.dayBounds(L.dayKey(Date.now()));
      const [rs, es] = await Promise.all([App.store.readingsRange(b.from, b.to), App.store.eventsRange(b.from, b.to)]);
      const el = $("#todayAnswer");
      el.hidden = false;
      el.textContent = decTxt(L.changesReport(rs, es, App.sensors, App.settings, b.from, b.to).text);
    });
    $("#dashNow").addEventListener("click", () => $("#nowBtn").click());
    bindGo(host);
    drawPreview();
  }

  function trackText(s) {
    if (!isTracking(s)) return "fija (calibración manual)";
    if (!s.calibration.track.tpl) return "se detectará sola en la próxima lectura";
    const tk = App.track.state[s.id];
    if (!tk) return "seguimiento activo";
    return tk.ok ? "seguimiento activo · coincidencia " + Math.round(tk.score * 100) + " %" : "no encontrada en la imagen — ¿se movió fuera del encuadre?";
  }

  function fmtMinutes(m) { return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + (m % 60) + " min"; }

  function intervalLabel(sec) { return sec < 60 ? sec + " segundos" : sec / 60 + (sec === 60 ? " minuto" : " minutos"); }

  function eventItem(e) {
    const s = sensorById(e.sensorId);
    return '<li class="ev ' + sevClass(e.severity) + '">' + sevChip(e.severity) +
      '<div><b>' + esc(L.EVENT_LABELS[e.type] || e.type) + "</b> · " + esc(s ? s.name : "—") + ' · <span class="mono">' + esc(L.fmtDateTime(e.ts)) + "</span>" +
      (e.source === "simulation" ? ' <span class="tag">simulación</span>' : "") + "<p>" + esc(e.description) + "</p></div></li>";
  }

  function bindGo(host) {
    $$("[data-go]", host).forEach((a) => a.addEventListener("click", (ev) => { ev.preventDefault(); showView(a.dataset.go); }));
  }

  // ─────────────────────────── vista previa ───────────────────────────

  function drawOverlay(ctx, w, h, sensors, selectedId, draftQuad) {
    sensors.forEach((s) => {
      const quad = s.id === selectedId && draftQuad ? draftQuad : s.calibration.quad;
      const q = quad.map((p) => ({ x: p.x * w, y: p.y * h }));
      const sel = s.id === selectedId;
      ctx.lineWidth = Math.max(2, w / (sel ? 320 : 520));
      ctx.strokeStyle = s.id === "A" ? "#2a78d6" : "#eb6834";
      ctx.beginPath();
      q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
      const fs = Math.max(14, Math.round(w / 55));
      ctx.font = "600 " + fs + "px system-ui, sans-serif";
      const tk = App.track.state[s.id], tracking = isTracking(s);
      const label = "SENSOR " + s.id + (tracking && tk ? (tk.ok ? " ↻" : " ✕ NO ENCONTRADA") : "");
      if (tracking && tk && !tk.ok) { ctx.setLineDash([10, 8]); ctx.strokeStyle = "#e34948"; ctx.stroke(); ctx.setLineDash([]); }
      const tw = ctx.measureText(label).width + 12;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillRect(q[0].x, q[0].y - fs - 8, tw, fs + 8);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, q[0].x + 6, q[0].y - 7);
      if (sel && draftQuad) {
        q.forEach((p) => { ctx.fillStyle = "#fff"; ctx.strokeStyle = "#1b4d2e"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(7, w / 150), 0, Math.PI * 2); ctx.fill(); ctx.stroke(); });
      }
    });
  }

  function paintFrame(canvas, fr, sensors, selectedId, draftQuad) {
    const ctx = canvas.getContext("2d");
    if (!fr || fr.error) {
      canvas.width = 1280; canvas.height = 720;
      ctx.fillStyle = "#222"; ctx.fillRect(0, 0, 1280, 720);
      ctx.fillStyle = "#ddd"; ctx.font = "28px system-ui, sans-serif"; ctx.textAlign = "center";
      ctx.fillText(fr && fr.error ? fr.error : "Sin imagen — activa la cámara, carga una imagen o usa la simulación", 640, 360);
      ctx.textAlign = "start";
      return;
    }
    if (canvas.width !== fr.canvas.width || canvas.height !== fr.canvas.height) { canvas.width = fr.canvas.width; canvas.height = fr.canvas.height; }
    ctx.drawImage(fr.canvas, 0, 0);
    drawOverlay(ctx, canvas.width, canvas.height, sensors, selectedId, draftQuad);
  }

  function drawPreview() {
    const c1 = $("#previewCanvas"), c2 = $("#dashPreview");
    const wantPreview = App.view === "camara" && c1, wantDash = App.view === "dashboard" && c2;
    if (!wantPreview && !wantDash) return;
    const fr = previewFrame();
    if (wantPreview) paintFrame(c1, fr, App.sensors.filter((s) => s.enabled));
    if (wantDash) paintFrame(c2, fr, App.sensors.filter((s) => s.enabled));
  }

  function previewLoop() {
    if (!document.hidden) {
      if ((App.view === "camara" || App.view === "dashboard") && !App.busy && Date.now() - App.track.lastPreview > 2500) {
        App.track.lastPreview = Date.now();
        trackFrames((s) => previewFrame(s));
      }
      if (App.view === "camara" || App.view === "dashboard") drawPreview();
      // Calibración en vivo: máximo 2 veces por segundo y solo si el fotograma cambió.
      if (App.view === "calibracion" && !App.cal.frozen && Date.now() - (App.cal.drawnAt || 0) >= 500) {
        const fr = previewFrame(sensorById(App.cal.sensorId));
        if (fr !== App.cal.lastFrame || fr.error) { App.cal.drawnAt = Date.now(); drawCalibration(true, fr); }
      }
      const dn = $("#dashNext");
      if (dn) dn.textContent = App.running && App.nextAt ? (() => { const s = Math.max(0, Math.round((App.nextAt - Date.now()) / 1000)); return pad2(Math.floor(s / 60)) + ":" + pad2(s % 60); })() : "detenido";
    }
    const fps = App.settings.frameSource === "camera" ? Math.min(App.settings.fps, 8) : 1;
    setTimeout(previewLoop, 1000 / fps);
  }

  // ─────────────────────────── CÁMARA (vista) ───────────────────────────

  function renderCameraForm() {
    const S = App.settings;
    $$('input[name="frameSource"]').forEach((r) => (r.checked = r.value === S.frameSource));
    $("#srcCamera").hidden = S.frameSource !== "camera";
    $("#srcImage").hidden = S.frameSource !== "image";
    $("#srcSim").hidden = S.frameSource !== "simulation";
    $("#camMode").value = S.cameraMode;
    $$(".single-only").forEach((e) => (e.hidden = S.cameraMode !== "single"));
    $$(".dual-only").forEach((e) => (e.hidden = S.cameraMode !== "dual"));
    const opts = (cur) =>
      (App.cam.devices.length ? "" : '<option value="">(activa la cámara para ver la lista)</option>') +
      App.cam.devices.map((d) => '<option value="' + esc(d.deviceId) + '"' + (d.deviceId === cur ? " selected" : "") + ">" + esc(d.label) + "</option>").join("");
    $("#camSelect").innerHTML = opts(S.cameraDeviceId);
    $("#camSelA").innerHTML = opts(sensorById("A").cameraDeviceId);
    $("#camSelB").innerHTML = opts(sensorById("B").cameraDeviceId);
    $("#camRes").value = S.resolution;
    $("#camFps").value = S.fps;
    $("#secureHint").textContent = window.isSecureContext ? "" : "⚠ Origen no seguro: Chrome bloqueará la cámara aquí.";
    $$("#simAnoms input").forEach((i) => (i.checked = !!App.sim.anomalies[i.dataset.anom]));
    setCamStatus(App.cam.status, App.cam.error);
    drawPreview();
  }

  function bindCameraView() {
    $$('input[name="frameSource"]').forEach((r) =>
      r.addEventListener("change", async () => {
        await saveSettings({ frameSource: r.value });
        if (r.value !== "camera") stopCameras();
        App.prevThumbs = {};
        renderCameraForm();
        renderHeader();
        renderBanners();
      }),
    );
    $("#camMode").addEventListener("change", async (e) => { await saveSettings({ cameraMode: e.target.value }); renderCameraForm(); if (App.cam.status === "active") startCameras(); });
    $("#camSelect").addEventListener("change", async (e) => { await saveSettings({ cameraDeviceId: e.target.value || null }); if (App.cam.status === "active") startCameras(); });
    ["A", "B"].forEach((id) =>
      $("#camSel" + id).addEventListener("change", async (e) => { sensorById(id).cameraDeviceId = e.target.value || null; await saveSensors(); if (App.cam.status === "active") startCameras(); }),
    );
    $("#camRes").addEventListener("change", async (e) => { await saveSettings({ resolution: e.target.value }); if (App.cam.status === "active") startCameras(); });
    $("#camFps").addEventListener("change", async (e) => {
      try { await saveSettings({ fps: Number(e.target.value) }); if (App.cam.status === "active") startCameras(); } catch (err) { toast(err.message, "warn"); renderCameraForm(); }
    });
    $("#camStart").addEventListener("click", startCameras);
    $("#camStop").addEventListener("click", async () => { if (App.running) await setRunning(false); stopCameras(); });
    $("#camRefresh").addEventListener("click", refreshDevices);
    $("#imgFile").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        App.still = { gray: Seg.fromRGBA(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height), canvas: c, label: "Imagen: " + f.name };
        URL.revokeObjectURL(img.src);
        App.prevThumbs = {};
        toast("Imagen cargada (" + c.width + " × " + c.height + "). Calibra las regiones en «Calibración».");
        renderHeader();
        drawPreview();
      };
      img.onerror = () => toast("No se pudo abrir la imagen.", "warn");
      img.src = URL.createObjectURL(f);
    });
    $$("#simAnoms input").forEach((i) => i.addEventListener("change", () => { App.sim.anomalies[i.dataset.anom] = i.checked; App.sim.frameAt = 0; drawPreview(); }));
    $("#testCapture").addEventListener("click", testCapture);
  }

  /** Captura de prueba: lee los sensores SIN guardar nada. */
  function testCapture() {
    const out = [], cache = {}, now = Date.now();
    App.sensors.filter((s) => s.enabled).forEach((s) => {
      const fr = grabFrame(s, cache, now);
      if (!fr || fr.error) { out.push("<tr><th>" + esc(s.name) + '</th><td colspan="5" class="crit-text">' + esc((fr && fr.error) || "Sin imagen") + "</td></tr>"); return; }
      const a = analyzeSensor(s, fr.gray, null, false);
      const cells = ["tempIn", "tempOut", "humidity", "time"].map((k) => {
        const f = a.capture.fields[k];
        if (!f) return "<td>—</td>";
        const v = L.validateField(k, f, { settings: App.settings, roi: s.calibration.fields[k] });
        return '<td><b class="mono">' + esc(f.text || "∅") + '</b><br><span class="small-text">' + esc(L.num(f.confidence, 0)) + " % · " + esc(L.LEVEL_LABELS[v.level]) + "</span>" + (v.note ? '<br><span class="small-text warn-text">' + esc(v.note) + "</span>" : "") + "</td>";
      });
      out.push("<tr><th>" + esc(s.name) + "</th>" + cells.join("") + '<td class="mono small-text">contraste ' + esc(L.num(a.capture.contrast, 0)) + (a.capture.referenceDiffScore != null ? "<br>dif. calibración " + esc(L.num(a.capture.referenceDiffScore, 0)) : "") + "</td></tr>");
    });
    $("#testResult").innerHTML = '<div class="table-scroll"><table class="compact"><thead><tr><th>Sensor</th><th>Temp. IN</th><th>Temp. OUT</th><th>Humedad</th><th>Hora</th><th>Imagen</th></tr></thead><tbody>' + out.join("") + "</tbody></table></div><p class=\"hint\">Captura de prueba: no se guarda en el histórico.</p>";
  }

  // ─────────────────────────── CALIBRACIÓN ───────────────────────────

  const clone = (o) => JSON.parse(JSON.stringify(o));

  function openCalibration() {
    const s = sensorById(App.cal.sensorId);
    if (!App.cal.draft || App.cal.draftFor !== s.id) { App.cal.draft = clone(s.calibration); App.cal.draftFor = s.id; App.cal.snapped = false; }
    $$('input[name="calField"]').forEach((r) => (r.checked = r.value === App.cal.field));
    $("#calSlant").value = App.cal.draft.slantDeg;
    $("#calSlantOut").textContent = App.cal.draft.slantDeg + "°";
    $("#calLight").checked = !!App.cal.draft.lightSegments;
    $("#calTrack").checked = !!(App.cal.draft.track && App.cal.draft.track.enabled);
    $("#calMsg").textContent = "";
    buildCalTable();
    setCalStep(App.cal.step || 1);
    // Si ningún sensor está ubicado todavía, la app busca sola las pantallas al abrir la
    // calibración (una vez por sesión; tarda unos segundos), sin esperar a que la persona lo pida.
    if (!App.cal.autoTried && App.sensors.filter((x) => x.enabled).every((x) => !x.calibration.accepted)) {
      App.cal.autoTried = true;
      calMsg("Buscando las pantallas de los sensores en la imagen…");
      setTimeout(() => { const b = $("#calDetect"); if (App.view === "calibracion" && b && App.cal.lastFrame && !App.cal.lastFrame.error) b.click(); }, 1500);
    }
    drawCalibration(true);
  }

  // Asistente de calibración por sensor: 1 Encuadra → 2 Compara → 3 Acepta → (siguiente sensor) → listo.
  const CAL_STEPS = ["Encuadra", "Compara", "Acepta"];
  // mismo orden que la pantalla del HTC-2: IN arriba, OUT abajo, luego humedad y hora
  const CMP_KEYS = [["tempIn", "#exIn", 1], ["tempOut", "#exOut", 1], ["humidity", "#exHum", 0], ["time", "#exTime", null]];
  /** ¿El texto leído tiene forma de valor del HTC-2? (no se aceptan «2.8», «L1.9», «7H»…) */
  function plausibleRead(k, t) {
    t = String(t || "").trim();
    if (k === "time") return /^([01]?\d|2[0-3]):[0-5]\d$/.test(t);
    if (k === "humidity") return /^\d{2}$/.test(t) && +t >= 5 && +t <= 99;
    return /^-?\d{1,2}\.\d$/.test(t) && +t >= -10 && +t <= 60 && !/^-?0\d/.test(t) && Math.abs(+t) >= 5;
  }

  // Autoguardado: todo ajuste de la calibración (pantalla, zonas, inclinación) queda guardado en
  // el sensor al instante; antes solo se guardaba al terminar los 3 pasos y se perdía al cambiar
  // de sensor (2026-10-28).
  let persistTimer = null;
  function persistDraft() {
    const s = sensorById(App.cal.sensorId), d = App.cal.draft;
    if (!s || !d) return;
    const prev = s.calibration;
    s.calibration = Object.assign(clone(d), { accepted: prev.accepted || null, reference: d.reference || prev.reference || null });
    App.prevThumbs[s.id] = null;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
      await saveSensors();
      $$(".cal-saved").forEach((el) => (el.textContent = "✓ Ubicación de " + s.name + " guardada (" + fmtHour(Date.now()) + ")"));
    }, 300);
  }

  function nextUncalibrated(exceptId) { return App.sensors.find((x) => x.enabled && x.id !== exceptId && !x.calibration.accepted); }

  function renderCalProgress() {
    const host = $("#calProgress"), step = App.cal.step;
    const list = App.sensors.filter((x) => x.enabled);
    let html = "";
    list.forEach((x, i) => {
      if (i) html += '<li class="sep" aria-hidden="true">›</li>';
      if (x.id === App.cal.sensorId && step !== "done") {
        html += '<li class="cur"><span class="d">' + esc(x.id) + "</span>" + esc(x.name) + "</li>";
        CAL_STEPS.forEach((w, k) => { html += '<li data-calstep="' + (k + 1) + '" class="' + (k + 1 < step ? "done" : k + 1 === step ? "cur" : "") + '"' + (k + 1 === step ? ' aria-current="step"' : "") + '><span class="d">' + (k + 1 < step ? "✓" : k + 1) + "</span>" + w + "</li>"; });
      } else {
        const ok = !!x.calibration.accepted;
        html += '<li data-calsensor="' + esc(x.id) + '" style="cursor:pointer" class="' + (ok ? "done" : "") + '"><span class="d">' + (ok ? "✓" : esc(x.id)) + "</span>" + esc(x.name) + (ok ? " · lista" : " · pendiente") + "</li>";
      }
    });
    host.innerHTML = html;
  }

  function setCalStep(step) {
    App.cal.step = step;
    const s = sensorById(App.cal.sensorId);
    $("#calStep1").hidden = step !== 1;
    $("#calStep2").hidden = step !== 2;
    $("#calStep3").hidden = step !== 3;
    $("#calDone").hidden = step !== "done";
    $$("[data-step-n]").forEach((el) => (el.textContent = "Paso " + step + " de 3 · " + s.name));
    $$("[data-sensor-letter]").forEach((el) => (el.textContent = s.id));
    if (step === 2) {
      CMP_KEYS.forEach(([, sel]) => { const i = $(sel); i.value = ""; delete i.dataset.touched; i.classList.remove("bad"); });
      $("#calMismatch").hidden = true;
      $("#exMsg").textContent = "";
    }
    if (step === 3) {
      const a = App.cal.lastRect;
      $("#calSummary").innerHTML = CMP_KEYS.map(([k, , dec]) => {
        const d = a && a.details[k];
        return '<div class="kv"><span>' + esc(L.FIELD_LABELS[k]) + '</span><span class="v md">' + esc(d && plausibleRead(k, d.text) ? showRead(d.text, dec) : k === "time" ? "no se lee" : "– –") + "</span></div>";
      }).join("");
      const next = nextUncalibrated(s.id);
      $("#calSave").textContent = next ? "Aceptar y seguir con " + next.name : "Aceptar y terminar";
    }
    renderCalProgress();
    if (step === 1 || step === 2) drawCalibration(false);
  }

  /** Texto leído por la app con el separador decimal elegido. */
  const showRead = (text, dec) => (dec && App.ui.decimal === "," ? String(text).replace(".", ",") : String(text));
  /** ¿Lo que la persona escribió coincide con lo que la app lee? */
  function sameRead(k, typed, read) {
    if (k === "time") return String(typed).trim().replace(/^0(\d:)/, "$1") === String(read || "").trim().replace(/^0(\d:)/, "$1");
    const a = parseNum(typed), b = parseNum(read);
    return a != null && b != null && Math.abs(a - b) < 0.05;
  }

  /** Encaja el cuadrilátero (px del frame) a la pantalla del HTC-2 y ubica los campos sobre sus números. */
  function snapDraft(quadPx) {
    const fr = App.cal.lastFrame;
    if (!fr || fr.error) return false;
    const d = App.cal.draft, s = sensorById(App.cal.sensorId);
    let sn = Seg.snapHtc2(fr.gray, quadPx, d.fields, { slantDeg: d.slantDeg, lightSegments: d.lightSegments });
    // solo vale si lo que lee tiene forma de temperatura y humedad (no se inventan lecturas)
    if (sn && Seg.plausibleHtc2(fr.gray, sn) < 2) sn = null;
    if (!sn) {
      d.quad = normQuad(quadPx, fr.gray.w, fr.gray.h);
      drawCalibration(false);
      calMsg("No se reconocieron los números de un HTC-2 en esa zona: quedó el recuadro que dibujaste (guardado). Puedes afinar las esquinas a mano, acercar la cámara o mejorar la luz.", "crit");
      persistDraft();
      return false;
    }
    d.quad = normQuad(sn.quad, fr.gray.w, fr.gray.h);
    d.fields = sn.fields;
    App.cal.snapped = true;
    if (sn.slantDeg != null) { d.slantDeg = sn.slantDeg; $("#calSlant").value = sn.slantDeg; $("#calSlantOut").textContent = sn.slantDeg + "°"; }
    drawCalibration(false);
    const r = App.cal.lastRect, txt = r ? ["tempIn", "tempOut", "humidity"].map((k) => r.details[k] ? L.FIELD_LABELS[k] + " " + (r.details[k].text || "∅") : null).filter(Boolean).join(" · ") : "";
    calMsg("Pantalla de " + s.name + " ajustada: " + txt + ". Si se ve bien, toca «Listo, se ve bien».", "good");
    persistDraft();
    return true;
  }

  function drawCalibration(grab, given) {
    const canvas = $("#calCanvas");
    if (!canvas || App.view !== "calibracion") return;
    let fr = App.cal.frozen;
    if (!fr && grab) fr = given || previewFrame(sensorById(App.cal.sensorId));
    if (!fr) fr = App.cal.lastFrame;
    App.cal.lastFrame = fr;
    paintFrame(canvas, fr, App.sensors, App.cal.sensorId, App.cal.draft.quad);
    const cands = App.cal.candidates;
    if (cands && Date.now() - App.cal.candidatesAt < 8000 && fr && !fr.error) {
      const ctx = canvas.getContext("2d"), kx = canvas.width / cands.w, ky = canvas.height / cands.h;
      ctx.save();
      ctx.setLineDash([8, 6]); ctx.lineWidth = Math.max(2, canvas.width / 500); ctx.strokeStyle = "#eda100";
      ctx.font = "700 " + Math.max(14, Math.round(canvas.width / 60)) + "px system-ui, sans-serif"; ctx.fillStyle = "#eda100";
      cands.list.forEach((c, i) => {
        ctx.beginPath();
        c.quad.forEach((p, j) => (j ? ctx.lineTo(p.x * kx, p.y * ky) : ctx.moveTo(p.x * kx, p.y * ky)));
        ctx.closePath(); ctx.stroke();
        ctx.fillText("#" + (i + 1), c.quad[3].x * kx, c.quad[3].y * ky + 18);
      });
      ctx.restore();
    }
    const rc = $("#rectCanvas");
    const tbody = $("#calFields");
    if (!fr || fr.error) {
      rc.getContext("2d").clearRect(0, 0, rc.width, rc.height);
      tbody.innerHTML = "<tr><td>Sin imagen para calibrar.</td></tr>";
      return;
    }
    const s = sensorById(App.cal.sensorId);
    const a = analyzeSensor(s, fr.gray, App.cal.draft, false);
    App.cal.lastRect = a;
    const disp = Seg.normalize(a.clean);
    rc.width = a.size.w; rc.height = a.size.h;
    const ctx = rc.getContext("2d");
    const id = ctx.createImageData(a.size.w, a.size.h);
    Seg.toRGBA(disp, id.data);
    ctx.putImageData(id, 0, 0);
    const tan = Math.tan((App.cal.draft.slantDeg * Math.PI) / 180);
    L.FIELD_KEYS.forEach((k) => {
      const f = App.cal.draft.fields[k];
      const x = f.x * a.size.w, y = f.y * a.size.h, w = f.w * a.size.w, h = f.h * a.size.h;
      const sel = k === App.cal.field;
      ctx.setLineDash(f.enabled ? [] : [5, 4]);
      ctx.lineWidth = sel ? 3 : 1.5;
      ctx.strokeStyle = sel ? "#e34948" : "#1baf7a";
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      // guías de celdas de dígitos (con la inclinación)
      ctx.lineWidth = 1;
      ctx.strokeStyle = sel ? "rgba(227,73,72,.55)" : "rgba(27,175,122,.45)";
      for (let i = 1; i < f.digits; i++) {
        const cx = x + (w / f.digits) * i;
        ctx.beginPath(); ctx.moveTo(cx + 0.5 * h * tan, y); ctx.lineTo(cx - 0.5 * h * tan, y + h); ctx.stroke();
      }
      ctx.font = "600 12px system-ui, sans-serif";
      ctx.fillStyle = sel ? "#e34948" : "#138a60";
      ctx.fillText(L.FIELD_LABELS[k] + (f.enabled ? "" : " (off)"), x + 2, Math.max(12, y - 3));
    });
    // lectura en grande: lo que la app está leyendo ahora con esta ubicación
    // paso 2: «La app lee» junto a «Tú ves» (lo que escribe la persona; vacío = coincide)
    if (App.cal.step === 2) {
      const bad = [];
      CMP_KEYS.forEach(([k, sel, dec]) => {
        const d = a.details[k], raw = d && d.text ? d.text : "", ok = plausibleRead(k, raw);
        const read = ok ? raw : "", inp = $(sel);
        const shown = ok ? showRead(read, dec) : raw ? "no se lee" : "– –";
        const cell = $("#calApp_" + k);
        if (cell.textContent !== shown) cell.textContent = shown;
        cell.classList.toggle("doubt", !ok);
        inp.placeholder = ok ? showRead(read, dec) : "escribe";
        const typed = inp.value.trim(), off = typed !== "" && !sameRead(k, typed, read);
        inp.classList.toggle("bad", off);
        if (off) bad.push(L.FIELD_LABELS[k] + ": la app lee «" + (read ? showRead(read, dec) : "nada") + "» y tú ves «" + typed + "»");
      });
      const mm = $("#calMismatch");
      mm.hidden = !bad.length;
      if (bad.length) mm.textContent = bad.join(" · ") + ". Toca «Ajustar y seguir» y la app se corrige sola.";
    }
    if (!tbody.querySelector("[data-read]")) buildCalTable();
    L.FIELD_KEYS.forEach((k) => {
      const d = a.details[k];
      tbody.querySelector('[data-read="' + k + '"]').textContent = d ? d.text || "∅" : "—";
      tbody.querySelector('[data-conf="' + k + '"]').textContent = d ? L.num(d.confidence, 0) + " %" : "—";
    });
  }

  /** Tabla de campos: se construye una vez (la vista en vivo solo actualiza lectura y confianza). */
  function buildCalTable() {
    const tbody = $("#calFields");
    tbody.innerHTML =
      "<thead><tr><th>Valor</th><th>Leer</th><th>Dígitos</th><th>Decimales</th><th>Lectura</th><th>Confianza</th></tr></thead><tbody>" +
      L.FIELD_KEYS.map((k) => {
        const f = App.cal.draft.fields[k];
        return "<tr><td>" + esc(L.FIELD_LABELS[k]) + '</td><td><input type="checkbox" data-fe="' + k + '" ' + (f.enabled ? "checked" : "") + ' aria-label="Leer ' + esc(L.FIELD_LABELS[k]) + '"></td>' +
          '<td><input type="number" min="1" max="6" data-fd="' + k + '" value="' + f.digits + '" class="tiny" aria-label="Dígitos de ' + esc(L.FIELD_LABELS[k]) + '"></td>' +
          '<td><input type="number" min="0" max="3" data-fdec="' + k + '" value="' + f.decimals + '" class="tiny" aria-label="Decimales de ' + esc(L.FIELD_LABELS[k]) + '" ' + (k === "time" ? "disabled" : "") + "></td>" +
          '<td class="mono"><b data-read="' + k + '">—</b></td><td data-conf="' + k + '">—</td></tr>';
      }).join("") + "</tbody>";
    $$("[data-fe]", tbody).forEach((i) => i.addEventListener("change", () => { App.cal.draft.fields[i.dataset.fe].enabled = i.checked; drawCalibration(false); }));
    $$("[data-fd]", tbody).forEach((i) => i.addEventListener("change", () => { App.cal.draft.fields[i.dataset.fd].digits = Math.max(1, Math.min(6, Number(i.value) || 1)); drawCalibration(false); }));
    $$("[data-fdec]", tbody).forEach((i) => i.addEventListener("change", () => { App.cal.draft.fields[i.dataset.fdec].decimals = Math.max(0, Math.min(3, Number(i.value) || 0)); drawCalibration(false); }));
  }

  function calMsg(text, kind) {
    const el = $("#calMsg");
    el.textContent = text;
    el.className = "msg " + (kind || "");
  }

  /** Clic sobre la pantalla del sensor: se busca el bisel alrededor del clic y se ajusta el LCD. */
  function fitAtClick(x, y) {
    const fr = App.cal.lastFrame;
    if (!fr || fr.error) return;
    const W = fr.gray.w, H = fr.gray.h;
    // tamaño esperado: el del otro sensor ya ubicado (son iguales) o ~1/5 del ancho
    const other = App.sensors.find((o) => o.id !== App.cal.sensorId && o.calibration.accepted);
    const oq = other ? pxQuad(other.calibration.quad, W, H) : null;
    const lw = oq ? Math.hypot(oq[1].x - oq[0].x, oq[1].y - oq[0].y) : W * 0.16;
    // varias ventanas alrededor del clic: gana la que lee más valores plausibles (y con más confianza)
    let best = null;
    // (también corridas arriba/abajo: el clic rara vez cae justo en el centro del LCD); para
    // en cuanto una lee los tres valores
    const tries = [];
    [0, -0.15, 0.15].forEach((dy) => [1.3, 1.6, 2.0].forEach((k) => tries.push([k, dy])));
    for (const [k, dy] of tries) {
      if (best && best.sc >= 3000) break;
      const hw = (lw * k) / 2, hh = (lw * k * 0.85) / 2, cy = y + dy * 2 * hh;
      const q = [{ x: x - hw, y: cy - hh }, { x: x + hw, y: cy - hh }, { x: x + hw, y: cy + hh }, { x: x - hw, y: cy + hh }];
      const sn = Seg.snapHtc2(fr.gray, q, App.cal.draft.fields, { slantDeg: App.cal.draft.slantDeg, lightSegments: App.cal.draft.lightSegments });
      if (!sn || !Seg.pointInQuad(sn.quad, { x, y })) continue;
      const ok = Seg.plausibleHtc2(fr.gray, sn), sc = ok * 1000 + sn.meanConf;
      if (ok >= 2 && (!best || sc > best.sc)) best = { sc, q };
    }
    if (best) return snapDraft(best.q);
    const inner = Seg.fitLcdAt(fr.gray, { x, y });
    if (inner) return snapDraft(inner.map((p, i, qq) => { const c = Seg.quadCenter(qq); return { x: c.x + (p.x - c.x) * 1.2, y: c.y + (p.y - c.y) * 1.3 }; }));
    calMsg("No se reconoció una pantalla en ese punto. Haz clic en el centro de la pantalla del sensor, o arrastra un rectángulo alrededor de ella.", "crit");
  }

  function canvasPoint(canvas, ev) {
    const r = canvas.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) / r.width) * canvas.width, y: ((ev.clientY - r.top) / r.height) * canvas.height, scale: canvas.width / r.width };
  }

  function transformQuad(quad, fn) {
    const cx = quad.reduce((a, p) => a + p.x, 0) / 4, cy = quad.reduce((a, p) => a + p.y, 0) / 4;
    return quad.map((p) => fn(p, cx, cy));
  }

  function bindCalibration() {
    const canvas = $("#calCanvas"), rc = $("#rectCanvas");
    $$('input[name="calField"]').forEach((r) => r.addEventListener("change", () => { App.cal.field = r.value; drawCalibration(false); }));
    $("#calSlant").addEventListener("input", (e) => { App.cal.draft.slantDeg = Number(e.target.value); $("#calSlantOut").textContent = e.target.value + "°"; drawCalibration(false); persistDraft(); });
    $("#calLight").addEventListener("change", (e) => { App.cal.draft.lightSegments = e.target.checked; drawCalibration(false); persistDraft(); });
    // inclinación de los dígitos con botones (más fácil que el deslizador)
    $$("[data-slant]").forEach((b) => b.addEventListener("click", () => {
      const v = Math.max(-20, Math.min(20, (App.cal.draft.slantDeg || 0) + Number(b.dataset.slant)));
      App.cal.draft.slantDeg = v; $("#calSlant").value = v; $("#calSlantOut").textContent = v + "°";
      drawCalibration(false); persistDraft();
      calMsg("Inclinación de los dígitos: " + v + "°", "good");
    }));
    $("#calForce").addEventListener("click", () => { persistDraft(); $("#calForce").hidden = true; setCalStep(3); });
    $("#calFreeze").addEventListener("click", (e) => {
      const lf = App.cal.lastFrame;
      if (App.cal.frozen || !lf || lf.error) App.cal.frozen = null;
      else {
        // copia fija: el lienzo de la cámara se reutiliza en cada fotograma
        const c = document.createElement("canvas");
        c.width = lf.canvas.width; c.height = lf.canvas.height;
        c.getContext("2d").drawImage(lf.canvas, 0, 0);
        App.cal.frozen = { canvas: c, gray: lf.gray, label: lf.label };
      }
      e.target.setAttribute("aria-pressed", App.cal.frozen ? "true" : "false");
      e.target.textContent = App.cal.frozen ? "Reanudar imagen en vivo" : "Congelar imagen";
      drawCalibration(true);
    });
    $$("[data-cal]").forEach((b) =>
      b.addEventListener("click", () => {
        const d = App.cal.draft, fr = App.cal.lastFrame, act = b.dataset.cal;
        const aspect = fr && fr.gray ? fr.gray.w / fr.gray.h : 16 / 9;
        if (act === "reset") { App.cal.draft = clone(L.defaultCalibration(App.cal.sensorId)); openCalibration(); return; }
        if (act === "snap") {
          if (!fr || !fr.gray) return calMsg("No hay imagen: activa la cámara.", "crit");
          // un poco más grande que el cuadro actual, por si quedó corto
          return snapDraft(transformQuad(pxQuad(d.quad, fr.gray.w, fr.gray.h), (p, cx, cy) => ({ x: cx + (p.x - cx) * 1.15, y: cy + (p.y - cy) * 1.2 })));
        }
        if (act === "rot-" || act === "rot+") {
          const ang = ((act === "rot+" ? 1 : -1) * Math.PI) / 180, c = Math.cos(ang), s = Math.sin(ang);
          d.quad = transformQuad(d.quad, (p, cx, cy) => { const dx = (p.x - cx) * aspect, dy = p.y - cy; return { x: cx + (dx * c - dy * s) / aspect, y: cy + dx * s + dy * c }; });
        } else {
          const k = act === "scale+" ? 1.03 : 1 / 1.03;
          d.quad = transformQuad(d.quad, (p, cx, cy) => ({ x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k }));
        }
        drawCalibration(false);
        persistDraft();
      }),
    );

    // Cuadrilátero del sensor: arrastrar esquina o dibujar rectángulo nuevo.
    canvas.addEventListener("pointerdown", (ev) => {
      const fr = App.cal.lastFrame;
      if (!fr || fr.error) return;
      const p = canvasPoint(canvas, ev), W = canvas.width, H = canvas.height;
      const q = App.cal.draft.quad.map((o) => ({ x: o.x * W, y: o.y * H }));
      const hitR = 16 * p.scale;
      const corner = q.findIndex((c) => Math.hypot(c.x - p.x, c.y - p.y) < hitR);
      // mover el recuadro solo si ya está ubicado; si no, arrastrar dibuja uno nuevo
      const placed = App.cal.snapped || sensorById(App.cal.sensorId).calibration.accepted;
      const inside = placed && corner < 0 && Seg.pointInQuad(q, p);
      App.cal.drag = corner >= 0 ? { mode: "corner", i: corner } : inside ? { mode: "move", x0: p.x, y0: p.y, q0: App.cal.draft.quad.map((o) => ({ x: o.x, y: o.y })) } : { mode: "rect", x0: p.x, y0: p.y };
      canvas.setPointerCapture(ev.pointerId);
    });
    canvas.addEventListener("pointermove", (ev) => {
      const dr = App.cal.drag;
      if (!dr) return;
      const p = canvasPoint(canvas, ev), W = canvas.width, H = canvas.height;
      const nx = Math.max(0, Math.min(1, p.x / W)), ny = Math.max(0, Math.min(1, p.y / H));
      if (dr.mode === "corner") App.cal.draft.quad[dr.i] = { x: nx, y: ny };
      else if (dr.mode === "move") {
        const dx = (p.x - dr.x0) / W, dy = (p.y - dr.y0) / H;
        if (Math.abs(dx) * W > 3 || Math.abs(dy) * H > 3) dr.moved = true;
        App.cal.draft.quad = dr.q0.map((o) => ({ x: o.x + dx, y: o.y + dy }));
      } else {
        const x0 = dr.x0 / W, y0 = dr.y0 / H;
        if (Math.abs(nx - x0) * W < 10 || Math.abs(ny - y0) * H < 10) return;
        dr.moved = true;
        const l = Math.min(x0, nx), r = Math.max(x0, nx), t = Math.min(y0, ny), b = Math.max(y0, ny);
        App.cal.draft.quad = [{ x: l, y: t }, { x: r, y: t }, { x: r, y: b }, { x: l, y: b }];
      }
      drawCalibration(false);
    });
    const end = () => { App.cal.drag = null; };
    canvas.addEventListener("pointerup", () => {
      const dr = App.cal.drag;
      App.cal.drag = null;
      if (dr && dr.mode === "rect" && !dr.moved) fitAtClick(dr.x0, dr.y0);
      else if (dr && dr.mode === "move" && !dr.moved) fitAtClick(dr.x0, dr.y0);
      else if (dr && dr.mode === "rect" && dr.moved) { const fr = App.cal.lastFrame; if (fr && fr.gray) snapDraft(pxQuad(App.cal.draft.quad, fr.gray.w, fr.gray.h)); }
      // lo que la persona ubicó a mano (esquinas o mover) se respeta y queda guardado
      if (dr && dr.moved && (dr.mode === "corner" || dr.mode === "move")) { App.cal.snapped = true; persistDraft(); }
      else if (dr && dr.mode === "corner") persistDraft();
    });
    canvas.addEventListener("pointercancel", end);

    // Zonas de lectura en la vista rectificada: arrastrar un cuadro lo MUEVE, su esquina inferior
    // derecha lo AGRANDA o achica, y arrastrar en un espacio vacío dibuja de nuevo la zona elegida.
    // Todo cambio queda guardado en el sensor al soltar.
    let fdrag = null;
    const fieldAt = (p, W, H) => {
      const order = [App.cal.field].concat(L.FIELD_KEYS.filter((k) => k !== App.cal.field)); // la elegida primero
      for (const k of order) {
        const f = App.cal.draft.fields[k], x = f.x * W, y = f.y * H, w = f.w * W, h = f.h * H, grip = 14 * p.scale;
        if (Math.abs(p.x - (x + w)) < grip && Math.abs(p.y - (y + h)) < grip) return { k, mode: "resize" };
        if (p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h) return { k, mode: "move" };
      }
      return null;
    };
    rc.addEventListener("pointerdown", (ev) => {
      const p = canvasPoint(rc, ev), hit = fieldAt(p, rc.width, rc.height);
      if (hit) { App.cal.field = hit.k; $$('input[name="calField"]').forEach((r) => (r.checked = r.value === hit.k)); }
      const f = App.cal.draft.fields[App.cal.field];
      fdrag = { x0: p.x, y0: p.y, mode: hit ? hit.mode : "draw", f0: { x: f.x, y: f.y, w: f.w, h: f.h } };
      rc.setPointerCapture(ev.pointerId);
      drawCalibration(false);
    });
    rc.addEventListener("pointermove", (ev) => {
      if (!fdrag) return;
      const p = canvasPoint(rc, ev), W = rc.width, H = rc.height, f = App.cal.draft.fields[App.cal.field], f0 = fdrag.f0;
      const dx = (p.x - fdrag.x0) / W, dy = (p.y - fdrag.y0) / H;
      if (Math.abs(p.x - fdrag.x0) < 3 && Math.abs(p.y - fdrag.y0) < 3) return;
      fdrag.moved = true;
      if (fdrag.mode === "move") {
        f.x = Math.max(0, Math.min(1 - f0.w, f0.x + dx));
        f.y = Math.max(0, Math.min(1 - f0.h, f0.y + dy));
      } else if (fdrag.mode === "resize") {
        f.w = Math.max(0.05, Math.min(1 - f0.x, f0.w + dx));
        f.h = Math.max(0.05, Math.min(1 - f0.y, f0.h + dy));
      } else {
        if (Math.abs(p.x - fdrag.x0) < 6 || Math.abs(p.y - fdrag.y0) < 6) return;
        f.x = Math.max(0, Math.min(fdrag.x0, p.x) / W);
        f.y = Math.max(0, Math.min(fdrag.y0, p.y) / H);
        f.w = Math.min(1 - f.x, Math.abs(p.x - fdrag.x0) / W);
        f.h = Math.min(1 - f.y, Math.abs(p.y - fdrag.y0) / H);
      }
      f.enabled = true;
      drawCalibration(false);
    });
    rc.addEventListener("pointerup", () => { const moved = fdrag && fdrag.moved; fdrag = null; if (moved) { persistDraft(); $("#exMsg").textContent = ""; } });
    rc.addEventListener("pointercancel", () => (fdrag = null));

    $("#calTrack").addEventListener("change", (e) => {
      App.cal.draft.track = Object.assign({ enabled: true, tpl: null }, App.cal.draft.track || {}, { enabled: e.target.checked });
    });
    $("#calDetect").addEventListener("click", async () => {
      const fr = App.cal.lastFrame;
      if (!fr || fr.error) return calMsg("No hay imagen: activa la cámara o elige una fuente en «Cámara».", "crit");
      calMsg("Buscando pantallas (puede tardar unos segundos)…");
      await new Promise((r) => setTimeout(r, 30));
      const res = autoAssign(fr.gray, App.sensors.filter((x) => x.enabled), true);
      await saveSensors();
      App.cal.draft = null;
      openCalibration();
      if (!res.found) calMsg("No se detectaron pantallas. Haz clic sobre la pantalla de cada sensor o arrastra un rectángulo alrededor (o acerca la cámara / mejora la luz).", "crit");
      else calMsg("Se detectaron " + res.found + " pantalla(s) (en amarillo); se asignaron " + res.assigned + ". Revisa las lecturas de cada sensor, usa «Intercambiar A ↔ B» si están al revés y sigue con «Listo, se ve bien».", "good");
    });
    $("#calSwap").addEventListener("click", async () => {
      const a = sensorById("A").calibration, b = sensorById("B").calibration;
      ["quad", "track", "reference", "fields", "accepted"].forEach((k) => { const t = a[k]; a[k] = b[k]; b[k] = t; });
      await saveSensors();
      App.cal.draft = null;
      openCalibration();
      calMsg("Sensor A y Sensor B intercambiados.", "good");
    });
    $("#calCopy").addEventListener("click", async () => {
      const other = App.sensors.find((x) => x.id !== App.cal.sensorId);
      other.calibration.fields = clone(App.cal.draft.fields);
      other.calibration.slantDeg = App.cal.draft.slantDeg;
      other.calibration.lightSegments = App.cal.draft.lightSegments;
      await saveSensors();
      calMsg("Regiones de valores, inclinación y tipo de segmentos copiados a " + other.name + ".", "good");
    });

    $("#calSave").addEventListener("click", async () => {
      const a = App.cal.lastRect;
      const s = sensorById(App.cal.sensorId);
      if (!a) return toast("No hay imagen para guardar la calibración.", "warn");
      const draft = clone(App.cal.draft);
      draft.reference = Seg.thumbToB64(a.thumb); // referencia para detectar sensor movido / fuera de encuadre
      s.calibration = draft;
      const fr = App.cal.lastFrame;
      if (isTracking(s) && fr && fr.gray) lockSensorOn(s, fr.gray, pxQuad(draft.quad, fr.gray.w, fr.gray.h));
      s.calibration.accepted = Date.now();
      App.cal.draft = clone(s.calibration);
      App.prevThumbs[s.id] = null;
      await saveSensors();
      const next = nextUncalibrated(s.id);
      if (next) {
        App.cal.sensorId = next.id;
        App.cal.draft = null;
        App.cal.step = 1;
        openCalibration();
        calMsg("✓ " + s.name + " listo. Ahora encuadra la pantalla de " + next.name + ".", "good");
      } else setCalStep("done");
    });
    // Paso 2: compara lo que lee la app con lo que ve la persona; si algo no coincide, se ajusta sola.
    $("#exFit").addEventListener("click", async () => {
      const fr = App.cal.lastFrame, d = App.cal.draft, msg = $("#exMsg"), a = App.cal.lastRect;
      if (!fr || !fr.gray) { msg.textContent = "No hay imagen de la cámara."; msg.className = "msg crit"; return; }
      const want = {}, typedAny = [];
      CMP_KEYS.forEach(([k, sel]) => {
        const typed = $(sel).value.trim(), raw = a && a.details[k] ? a.details[k].text : "", read = plausibleRead(k, raw) ? raw : "";
        if (typed && !sameRead(k, typed, read)) typedAny.push(k);
        // solo se usa como ejemplo lo que la persona escribió o una lectura con forma válida
        const v = typed || read;
        if (v) want[k] = k === "time" ? v.replace(/^0(\d:)/, "$1") : k === "humidity" ? String(parseNum(v) == null ? v : Math.round(parseNum(v))) : String(v).replace(",", ".");
      });
      // sin nada escrito, solo se acepta si la app lee temperaturas y humedad con forma válida (la hora es opcional)
      const unread = CMP_KEYS.filter(([k, sel]) => k !== "time" && !$(sel).value.trim() && !(a && a.details[k] && plausibleRead(k, a.details[k].text))).map(([k]) => L.FIELD_LABELS[k]);
      if (!a || unread.length) {
        msg.textContent = "La app no logra leer: " + (unread.join(", ") || "la pantalla") + ". Escribe esos valores tal como los ves en el sensor y toca de nuevo «Ajustar y seguir»: la app mueve sola sus cuadros hasta leerlos.";
        msg.className = "msg warn";
        if (!typedAny.length) return;
      }
      if (!typedAny.length) { persistDraft(); return setCalStep(3); }
      msg.textContent = "Ajustando (unos segundos)…"; msg.className = "msg";
      $("#exFit").disabled = true;
      await new Promise((r) => setTimeout(r, 30));
      try {
        const res = Seg.fitToExample(fr.gray, pxQuad(d.quad, fr.gray.w, fr.gray.h), d.fields, want, { lightSegments: d.lightSegments });
        d.fields = res.fields; d.slantDeg = res.slantDeg;
        $("#calSlant").value = res.slantDeg; $("#calSlantOut").textContent = res.slantDeg + "°";
        drawCalibration(false);
        persistDraft();
        // la hora es opcional: si solo falla la hora, se sigue igual
        const bad = Object.keys(res.result).filter((k) => !res.result[k].ok && k !== "time");
        if (!bad.length) { $("#calForce").hidden = true; toast("Listo: la app ya lee lo mismo que tú."); setCalStep(3); }
        else {
          msg.textContent = "Casi: todavía no lee bien " + bad.map((k) => L.FIELD_LABELS[k] + " (lee «" + (res.result[k].text || "nada") + "»)").join(", ") + ". Arrastra ese cuadro encima de su número, gira la pantalla o acerca la cámara, y vuelve a tocar «Ajustar y seguir».";
          msg.className = "msg warn";
          $("#calForce").hidden = false;
        }
      } finally { $("#exFit").disabled = false; }
    });
    $$("#calCmp input").forEach((i) => i.addEventListener("input", () => { i.dataset.touched = "1"; drawCalibration(false); }));
    $("#calNext1").addEventListener("click", () => {
      const fr = App.cal.lastFrame;
      if (!fr || fr.error) return calMsg("No hay imagen de la cámara. Actívala en Ajustes → Lecturas y cámara.", "crit");
      persistDraft(); // la ubicación de la pantalla queda guardada desde ya
      setCalStep(2);
    });
    $("#calBack2").addEventListener("click", () => setCalStep(1));
    $("#calBack3").addEventListener("click", () => setCalStep(2));
    $("#calStartMon").addEventListener("click", async () => { if (!App.running) await setRunning(true); showView("dashboard"); });
    $("#calRestart").addEventListener("click", () => { const f = App.sensors.find((x) => x.enabled) || App.sensors[0]; App.cal.sensorId = f.id; App.cal.draft = null; App.cal.step = 1; openCalibration(); });
    $("#calExit").addEventListener("click", () => showView(App.lastSettings || "sensores"));
    $("#calProgress").addEventListener("click", (ev) => {
      const li = ev.target.closest("li");
      if (!li) return;
      if (li.dataset.calstep && Number(li.dataset.calstep) < App.cal.step) setCalStep(Number(li.dataset.calstep)); // volver a un paso ya hecho
      else if (li.dataset.calsensor) { App.cal.sensorId = li.dataset.calsensor; App.cal.draft = null; App.cal.step = 1; openCalibration(); }
    });
    $("#calShot").addEventListener("click", () => {
      const fr = App.cal.lastFrame;
      if (!fr || fr.error || !fr.canvas) return calMsg("No hay imagen de la cámara para descargar.", "crit");
      fr.canvas.toBlob((b) => b && download(b, "bioteva-camara-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".png"), "image/png");
    });
  }

  // ─────────────────────────── SENSORES (límites) ───────────────────────────

  function renderSensors() {
    const host = $('section[data-view="sensores"]');
    const inp = (s, k, step, min, max) => '<input name="' + s.id + "_" + k + '" type="text" inputmode="decimal" class="tiny" aria-label="' + esc(s.name + " " + k) + '" placeholder="–" value="' + (s[k] == null ? "" : esc(fmt(s[k], k.indexOf("hum") === 0 ? 0 : 1))) + '">';
    host.innerHTML =
      '<div class="page-head"><h1>Sensores y límites</h1></div>' +
      '<form class="panel" id="sensForm"><header><h2>Tus límites por caja</h2><div class="spacer"></div><button class="btn primary" type="submit">Guardar</button></header><div class="panel-body col">' +
        '<p class="muted-text">La app <b>no propone</b> rangos para los grillos: escribe los de tu protocolo. Un campo vacío = sin límite (no genera alertas de rango).</p>' +
        '<div class="table-scroll"><table class="limits"><thead><tr><th>Caja</th><th>Activa</th><th>Temperatura que manda</th><th>Temp. mín (°C)</th><th>Temp. máx (°C)</th><th>Humedad mín (%)</th><th>Humedad máx (%)</th><th>Calibración</th></tr></thead><tbody>' +
        App.sensors.map((s) =>
          "<tr><td><input name=\"" + s.id + '_name" required maxlength="60" value="' + esc(s.name) + '" aria-label="Nombre de la caja ' + s.id + '"></td>' +
          '<td><input type="checkbox" name="' + s.id + '_enabled"' + (s.enabled ? " checked" : "") + ' aria-label="' + esc(s.name) + ' activa"></td>' +
          '<td><select name="' + s.id + '_controlTemp" aria-label="Temperatura que manda en ' + esc(s.name) + '"><option value="out"' + (s.controlTemp === "out" ? " selected" : "") + '>OUT · caja</option><option value="in"' + (s.controlTemp === "in" ? " selected" : "") + ">IN · cuarto</option></select></td>" +
          "<td>" + inp(s, "tempMin") + "</td><td>" + inp(s, "tempMax") + "</td><td>" + inp(s, "humMin") + "</td><td>" + inp(s, "humMax") + "</td>" +
          '<td class="cal">' + (s.calibration.accepted ? '<span class="chip soft good">' + ico("ok", 14) + "Lista</span> " : '<span class="chip soft warn">' + ico("warn", 14) + "Falta</span> ") + '<a class="btn ghost small" href="#calibracion" data-cal-go="' + esc(s.id) + '">Calibrar</a></td></tr>',
        ).join("") +
        '</tbody></table></div><p class="form-err" hidden></p>' +
      "</div></form>";
    $("#sensForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target), errs = [], next = [];
      App.sensors.forEach((s) => {
        const g = (k) => { const v = String(fd.get(s.id + "_" + k) || "").trim(); return v === "" ? "" : String(parseNum(v) == null ? v : parseNum(v)); };
        const cand = { tempMin: g("tempMin"), tempMax: g("tempMax"), humMin: g("humMin"), humMax: g("humMax") };
        const e = L.validateSensorLimits(cand);
        if (e.length) errs.push(s.name + ": " + e.join(" · "));
        next.push([s, cand, String(fd.get(s.id + "_name") || s.name).trim() || s.name, fd.get(s.id + "_controlTemp") === "out" ? "out" : "in", fd.get(s.id + "_enabled") === "on"]);
      });
      const err = $(".form-err", ev.target);
      if (errs.length) { err.hidden = false; err.textContent = errs.join(" — "); return; }
      err.hidden = true;
      next.forEach(([s, cand, name, ct, en]) => Object.assign(s, cand, { name, controlTemp: ct, enabled: en }));
      await saveSensors();
      toast("Límites guardados.");
      renderSensors();
    });
    $$("[data-cal-go]", host).forEach((a) => a.addEventListener("click", (ev) => { ev.preventDefault(); App.cal.sensorId = a.dataset.calGo; App.cal.draft = null; showView("calibracion"); }));
  }

  // ─────────────────────────── HISTÓRICO ───────────────────────────

  const PAGE = 100;

  async function renderHistory() {
    const host = $('section[data-view="historico"]');
    const F = App.histFilter, now = Date.now();
    if (!F.from) { F.from = toDateInput(now - 6 * DAY); F.to = toDateInput(now); }
    const from = L.dayBounds(F.from).from, to = L.dayBounds(F.to).to;
    let rows = (await App.store.readingsRange(from, to)).filter((r) => !F.sensor || r.sensorId === F.sensor).sort((a, b) => b.ts - a.ts);
    const evs = await App.store.eventsRange(from, to);
    const byReading = {};
    evs.forEach((e) => { if (e.readingId) (byReading[e.readingId] = byReading[e.readingId] || []).push(e); });
    const total = rows.length, pages = Math.max(1, Math.ceil(total / PAGE));
    F.page = Math.min(F.page, pages - 1);
    rows = rows.slice(F.page * PAGE, F.page * PAGE + PAGE);
    const cell = (r, k, dec) => {
      if (r[k] != null) return L.num(r[k], dec);
      const f = r.fields && r.fields[k];
      return f && f.value != null ? '<span class="doubt" title="' + esc(L.LEVEL_LABELS[f.level]) + '">' + esc(L.num(f.value, dec)) + "?</span>" : "—";
    };
    host.innerHTML =
      '<div class="panel"><header><h2>Histórico de lecturas</h2><div class="spacer"></div><button class="btn" id="histXlsx" type="button">⤓ Exportar Excel (este rango)</button></header>' +
      '<div class="panel-body"><form class="filters" id="histForm">' +
        '<label class="f"><span>Desde</span><input type="date" name="from" value="' + esc(F.from) + '"></label>' +
        '<label class="f"><span>Hasta</span><input type="date" name="to" value="' + esc(F.to) + '"></label>' +
        '<label class="f"><span>Sensor</span><select name="sensor"><option value="">Todos</option>' + App.sensors.map((s) => '<option value="' + s.id + '"' + (F.sensor === s.id ? " selected" : "") + ">" + esc(s.name) + "</option>").join("") + "</select></label>" +
        '<button class="btn" type="submit">Aplicar</button>' +
      '</form><p class="muted-text">' + total + " lecturas · página " + (F.page + 1) + " de " + pages + ". Los valores con «?» no son confiables y no se usan en gráficas ni estadísticas.</p></div>" +
      '<div class="table-scroll"><table><thead><tr><th>Fecha y hora</th><th>Sensor</th><th>Temp IN</th><th>Temp OUT</th><th>Humedad</th><th>Δ temp</th><th>Confianza</th><th>Estado</th><th>Eventos</th><th>Fuente</th><th>Evidencia</th></tr></thead><tbody>' +
      (rows.length
        ? rows.map((r) => {
            const s = sensorById(r.sensorId);
            const ev = (byReading[r.id] || []).filter((e) => e.type !== "READING_UNCHANGED");
            return '<tr><td class="mono">' + esc(L.fmtDateTime(r.ts)) + "</td><td>" + esc(s ? s.name : r.sensorId) + '</td><td class="mono">' + cell(r, "tempIn", 1) + '</td><td class="mono">' + cell(r, "tempOut", 1) + '</td><td class="mono">' + cell(r, "humidity", 0) + '</td><td class="mono">' + (r.deltaTemp == null ? "—" : esc(L.signed(r.deltaTemp))) +
              '</td><td class="mono">' + (r.confidence == null ? "—" : esc(L.num(r.confidence, 0)) + " %") + "</td><td>" + statusChip(r.status) + "</td><td>" +
              ev.map((e) => '<span class="chip ' + sevClass(e.severity) + '" title="' + esc(e.description) + '">' + esc(L.EVENT_LABELS[e.type] || e.type) + "</span>").join(" ") +
              "</td><td>" + (r.source === "simulation" ? '<span class="tag">simulación</span>' : r.source === "image" ? "imagen" : "cámara") + "</td><td>" +
              (r.snapshotId ? '<button class="btn ghost small" data-snap="' + esc(r.snapshotId) + '" data-title="' + esc((s ? s.name : "") + " · " + L.fmtDateTime(r.ts)) + '">Ver</button>' : "") + "</td></tr>";
          }).join("")
        : '<tr><td colspan="11" class="muted-text">Sin lecturas en este rango.</td></tr>') +
      "</tbody></table></div>" +
      '<div class="row-actions pager"><button class="btn" id="prevPage" ' + (F.page ? "" : "disabled") + '>← Más recientes</button><button class="btn" id="nextPage" ' + (F.page < pages - 1 ? "" : "disabled") + ">Más antiguas →</button></div></div>";
    $("#histForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      F.from = fd.get("from") || F.from; F.to = fd.get("to") || F.to; F.sensor = fd.get("sensor"); F.page = 0;
      if (F.from > F.to) { const t = F.from; F.from = F.to; F.to = t; }
      renderHistory();
    });
    $("#prevPage").addEventListener("click", () => { F.page--; renderHistory(); });
    $("#nextPage").addEventListener("click", () => { F.page++; renderHistory(); });
    $("#histXlsx").addEventListener("click", () => exportExcel(from, to));
    $$("[data-snap]", host).forEach((b) => b.addEventListener("click", () => showSnapshot(b.dataset.snap, b.dataset.title)));
  }

  async function showSnapshot(id, title) {
    const snap = await App.store.getSnapshot(id);
    if (!snap) return toast("La evidencia ya no está disponible (se eliminó por la retención configurada).", "warn");
    const img = $("#snapImg");
    if (img.src) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(snap.blob);
    $("#snapTitle").textContent = "Evidencia · " + (title || "");
    $("#snapDialog").showModal();
  }

  // ─────────────────────────── GRÁFICAS ───────────────────────────

  function chartBounds() {
    const R = App.chartRange, now = Date.now();
    if (R.preset === "24h") return { from: now - DAY, to: now };
    if (R.preset === "7d") return { from: now - 7 * DAY, to: now };
    if (R.preset === "30d") return { from: now - 30 * DAY, to: now };
    if (R.preset === "today") { const b = L.dayBounds(L.dayKey(now)); return { from: b.from, to: Math.min(b.to, now) }; }
    const f = R.from || toDateInput(now - 2 * DAY), t = R.to || toDateInput(now);
    return { from: L.dayBounds(f).from, to: Math.min(L.dayBounds(t).to, now) };
  }

  async function renderCharts() {
    const host = $('section[data-view="graficas"]');
    const R = App.chartRange, b = chartBounds();
    host.innerHTML =
      '<form class="filters panel-body panel" id="chartForm">' +
        '<div class="seg small" role="radiogroup" aria-label="Periodo">' +
          [["today", "Hoy"], ["24h", "Últimas 24 h"], ["7d", "7 días"], ["30d", "30 días"], ["custom", "Personalizado"]].map((p) => '<label><input type="radio" name="preset" value="' + p[0] + '"' + (R.preset === p[0] ? " checked" : "") + "> <span>" + p[1] + "</span></label>").join("") +
        "</div>" +
        '<label class="f custom-only"' + (R.preset === "custom" ? "" : " hidden") + '><span>Desde</span><input type="date" name="from" value="' + esc(R.from || toDateInput(Date.now() - 2 * DAY)) + '"></label>' +
        '<label class="f custom-only"' + (R.preset === "custom" ? "" : " hidden") + '><span>Hasta</span><input type="date" name="to" value="' + esc(R.to || toDateInput(Date.now())) + '"></label>' +
        '<label class="f"><span>Temperatura</span><select name="metric"><option value="control"' + (R.metric === "control" ? " selected" : "") + '>De control (según sensor)</option><option value="tempIn"' + (R.metric === "tempIn" ? " selected" : "") + '>IN</option><option value="tempOut"' + (R.metric === "tempOut" ? " selected" : "") + ">OUT</option></select></label>" +
        App.sensors.map((s) => '<label class="f inline"><input type="checkbox" name="s_' + s.id + '"' + (R.sensors[s.id] ? " checked" : "") + "> <span>" + esc(s.name) + "</span></label>").join("") +
        '<label class="f inline"><input type="checkbox" name="limits"' + (R.limits ? " checked" : "") + "> <span>Mostrar límites</span></label>" +
      "</form>" +
      '<div class="panel"><header><h2>Temperatura durante el periodo</h2></header><div class="panel-body"><div class="chart" id="chartTemp"></div></div></div>' +
      '<div class="panel"><header><h2>Humedad relativa</h2></header><div class="panel-body"><div class="chart" id="chartHum"></div></div></div>' +
      '<p class="muted-text">Solo se grafican lecturas confiables (confianza alta o media). La línea se interrumpe donde no hubo datos. Usa el cursor o las flechas del teclado sobre la gráfica para ver cada valor; la tabla completa está en <a href="#historico" data-go="historico">Histórico</a>.</p>';
    const form = $("#chartForm");
    form.addEventListener("change", () => {
      const fd = new FormData(form);
      R.preset = fd.get("preset");
      R.from = fd.get("from") || R.from; R.to = fd.get("to") || R.to;
      R.metric = fd.get("metric");
      App.sensors.forEach((s) => (R.sensors[s.id] = fd.get("s_" + s.id) === "on"));
      R.limits = fd.get("limits") === "on";
      renderCharts();
    });
    bindGo(host);
    const readings = await App.store.readingsRange(b.from, b.to);
    const vis = App.sensors.filter((s) => R.sensors[s.id]);
    const cssVar = (id) => (id === "A" ? "--series-a" : "--series-b");
    const tempKey = (s) => (R.metric === "control" ? L.controlKey(s) : R.metric);
    const tempSeries = vis.map((s) => ({ id: s.id, label: s.name + " · " + (tempKey(s) === "tempOut" ? "OUT" : "IN"), cssVar: cssVar(s.id), points: L.series(readings, s.id, tempKey(s), b.from, b.to, 700) }));
    const humSeries = vis.map((s) => ({ id: s.id, label: s.name, cssVar: cssVar(s.id), points: L.series(readings, s.id, "humidity", b.from, b.to, 700) }));
    const limits = (kind) => {
      if (!R.limits) return [];
      const out = [];
      vis.forEach((s) => {
        const mn = kind === "t" ? s.tempMin : s.humMin, mx = kind === "t" ? s.tempMax : s.humMax;
        if (mn != null) out.push({ value: mn, label: s.id + " mín " + mn });
        if (mx != null) out.push({ value: mx, label: s.id + " máx " + mx });
      });
      return out;
    };
    MonCharts.render($("#chartTemp"), { series: tempSeries, unit: "°C", decimals: 1, from: b.from, to: b.to, limits: limits("t"), ariaLabel: "Temperatura por sensor en el periodo" });
    MonCharts.render($("#chartHum"), { series: humSeries, unit: "%", decimals: 0, from: b.from, to: b.to, limits: limits("h"), ariaLabel: "Humedad relativa por sensor en el periodo" });
  }

  // ─────────────────────────── ALERTAS (por episodio) ───────────────────────────

  App.alertTab = "all";
  const EP_TITLE = {
    tempHigh: (ep) => "Temperatura sobre tu máximo" + (ep.limit != null ? " (" + fmt(ep.limit) + " °C)" : ""),
    tempLow: (ep) => "Temperatura bajo tu mínimo" + (ep.limit != null ? " (" + fmt(ep.limit) + " °C)" : ""),
    humHigh: (ep) => "Humedad sobre tu máximo" + (ep.limit != null ? " (" + fmt(ep.limit, 0) + " %)" : ""),
    humLow: (ep) => "Humedad bajo tu mínimo" + (ep.limit != null ? " (" + fmt(ep.limit, 0) + " %)" : ""),
    tempChange: () => "Cambio brusco de temperatura",
    humChange: () => "Cambio brusco de humedad",
    noData: () => "No llegaron lecturas",
    camera: () => "La cámara no vio el sensor",
    reading: () => "La app no pudo leer bien los números",
    stale: () => "La lectura no cambia",
  };

  function episodeCard(ep) {
    const s = sensorById(ep.sensorId), act = ep.status === "Activa", w = ep.severity !== "CRITICAL" ? " w" : "";
    const metric = /^(temp|hum)/.test(ep.family), hum = /^hum/.test(ep.family);
    const st = ep.status.toLowerCase();
    const third = ep.peak
      ? '<span class="k">' + (ep.peak.kind === "max" ? "Llegó a" : "Bajó a") + '</span><span class="v">' + fmt(ep.peak.v, hum ? 0 : 1) + (hum ? " %" : " °C") + "</span>"
      : '<span class="k">Avisos</span><span class="v">' + ep.count + "</span>";
    const fix = ep.family === "reading" ? ["calibracion", "Revisar calibración"] : ep.family === "noData" || ep.family === "stale" || ep.family === "camera" ? ["camara", "Revisar la cámara"] : null;
    return '<article class="ep' + (act ? " activa" + w : "") + '">' +
      '<div class="ep-top"><div class="ep-tags"><span class="ep-st ' + st + (act ? w : "") + '">' + (act ? ico(ep.severity === "CRITICAL" ? "crit" : "warn", 14) + " " : "") + esc(ep.status) + '</span><span class="chip line">' + esc(ep.kind) + '</span><span class="chip line">' + esc(s ? s.name : ep.sensorId) + "</span>" + (ep.source === "simulation" ? '<span class="tag">simulación</span>' : "") + "</div>" +
      '<span class="muted-text">' + esc(fmtHour(ep.start)) + "</span></div>" +
      '<div class="ep-title">' + esc((EP_TITLE[ep.family] || (() => ep.text))(ep)) + "</div>" +
      (ep.text ? '<p class="muted-text">' + esc(decTxt(ep.text)) + "</p>" : "") +
      '<div class="ep-stats"><div><span class="k">Desde</span><span class="v">' + esc(fmtHour(ep.start)) + '</span></div><div><span class="k">Duración</span><span class="v">' + esc(ep.count === 1 && ep.end - ep.start < 60000 ? "un momento" : fmtDur(ep.end - ep.start)) + (act ? " y sigue" : "") + "</span></div><div>" + third + "</div></div>" +
      '<div class="ep-actions">' +
        (ep.status !== "Reconocida" ? '<button class="btn" type="button" data-ack-ep="' + esc(ep.id) + '">' + ico("ok", 16) + "Reconocer</button>" : '<span class="muted-text" style="align-self:center">Ya la viste</span>') +
        (metric ? '<button class="btn" type="button" data-ep-chart="' + esc(ep.id) + '">Ver gráfica</button>' : fix ? '<a class="btn" href="#' + fix[0] + '" data-go="' + fix[0] + '">' + fix[1] + "</a>" : "") +
      "</div></article>";
  }

  async function renderAlerts() {
    const host = $('section[data-view="alertas"]');
    const now = Date.now(), S = App.settings;
    const eps = await loadEpisodes(30);
    const nAct = eps.filter((e) => e.status === "Activa").length;
    const shown = eps.filter((e) => (App.alertTab === "active" ? e.status === "Activa" : App.alertTab === "closed" ? e.status !== "Activa" : true)).slice(0, 200);
    const live = App.running ? App.sensors.filter((s) => s.enabled).map((s) => ({ s, st: L.currentStatus(s, App.latest[s.id], now, S) })).filter((x) => x.st.code === "SIN_DATOS") : [];
    let list = "", day = "";
    shown.forEach((ep) => {
      const d = fmtDay(ep.start);
      if (d !== day) { day = d; list += '<h3 class="ep-day">' + esc(d) + "</h3>"; }
      list += episodeCard(ep);
    });
    host.innerHTML =
      '<div class="page-head"><h1>Alertas</h1><div class="row-actions">' +
        '<div class="segbtn" role="group" aria-label="Filtro">' + [["all", "Todas"], ["active", "Activas (" + nAct + ")"], ["closed", "Cerradas"]].map((f) => '<button type="button" data-atab="' + f[0] + '" aria-pressed="' + (App.alertTab === f[0]) + '">' + f[1] + "</button>").join("") + "</div>" +
        (eps.some((e) => e.status !== "Reconocida") ? '<button class="btn" id="ackAll" type="button">Reconocer todas</button>' : "") +
      "</div></div>" +
      (live.length ? '<div class="banner warn">' + ico("warn", 20) + "<span><b>Ahora mismo no llegan lecturas de " + esc(live.map((x) => x.s.name).join(" y ")) + ".</b> Revisa que la cámara esté activa y la ventana de la app abierta. La app no sabe la causa.</span></div>" : "") +
      '<p class="muted-text">Varias alertas iguales seguidas se juntan en un solo episodio. «Activa» = sigue pasando; «Resuelta» = volvió a la normalidad; «Reconocida» = ya la viste.</p>' +
      (shown.length ? '<div class="ep-list">' + list + "</div>"
        : '<div class="empty">' + ico("ok", 28) + "<b>" + (App.alertTab === "active" ? "No hay alertas activas" : "No hay alertas") + '</b><span class="muted-text">En los últimos 30 días.</span></div>') +
      '<p class="hint">Cuándo avisa la app: cambio de ±' + esc(fmt(S.tempChangeThreshold)) + " °C o ±" + esc(fmt(S.humidityChangeThreshold, 1)) + " % en " + S.changeWindowMin + " min · " + S.confirmReadings + " lecturas seguidas para confirmar un valor fuera de tus límites · sin datos tras " + S.noDataCycles + ' lecturas perdidas. <a href="#configuracion" data-go="configuracion">Cambiar</a>.</p>';
    const byId = {};
    eps.forEach((e) => (byId[e.id] = e));
    $$("[data-atab]", host).forEach((b) => b.addEventListener("click", () => { App.alertTab = b.dataset.atab; renderAlerts(); }));
    const ackAll = $("#ackAll");
    if (ackAll) ackAll.addEventListener("click", async () => { const n = await App.store.ackAll(); toast(n ? "Listo: todas las alertas quedaron reconocidas." : "No había alertas por reconocer."); renderAlerts(); });
    $$("[data-ack-ep]", host).forEach((b) => b.addEventListener("click", async () => {
      const ep = byId[b.dataset.ackEp];
      for (const id of ep.eventIds) await App.store.ackEvent(id);
      renderAlerts();
    }));
    $$("[data-ep-chart]", host).forEach((b) => b.addEventListener("click", () => {
      const ep = byId[b.dataset.epChart];
      App.caja.sensor = ep.sensorId;
      App.caja.period = L.dayKey(ep.start) === L.dayKey(Date.now()) ? "today" : Date.now() - ep.start < DAY ? "24h" : "7d";
      showView("caja");
    }));
    bindGo(host);
  }

  // ─────────────────────────── CAJA (detalle y gráfica) ───────────────────────────

  App.caja = { sensor: "A", period: "today", compare: false };

  function cajaBounds() {
    const now = Date.now(), P = App.caja.period;
    if (P === "7d") return { from: now - 7 * DAY, to: now };
    if (P === "24h") return { from: now - DAY, to: now };
    return { from: L.dayBounds(L.dayKey(now)).from, to: now };
  }

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1))), m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  }

  /**
   * Gráfica SVG de una variable: zona de tus límites, tramos fuera de límites en rojo grueso,
   * huecos sin datos rayados, máximo y mínimo marcados y la línea de «ahora».
   * o: { pts:[{t,v}], cmp:[{t,v}]|null, from, to, mn, mx, unit, dec, gapMs, label, minSpan }
   */
  function boxChartSvg(o) {
    if (!o.pts.length) return '<div class="empty">' + ico("off", 28) + "<b>Sin lecturas en este periodo</b><span class=\"muted-text\">Cuando la app lea el sensor, aquí aparece la gráfica.</span></div>";
    const W = 900, H = o.h || 300, pl = 56, pr = 18, pt = 22, pb = 36;
    const vals = o.pts.map((p) => p.v).concat(o.cmp ? o.cmp.map((p) => p.v) : []);
    if (o.mn != null) vals.push(o.mn);
    if (o.mx != null) vals.push(o.mx);
    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const minSpan = o.minSpan || 2;
    if (hi - lo < minSpan) { const c = (hi + lo) / 2; lo = c - minSpan / 2; hi = c + minSpan / 2; }
    const padv = (hi - lo) * 0.1; lo -= padv; hi += padv;
    const X = (t) => pl + ((t - o.from) / (o.to - o.from)) * (W - pl - pr);
    const Y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
    const f1 = (n) => n.toFixed(1);
    let s = '<defs><pattern id="hatch' + o.id + '" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" style="stroke:var(--muted);stroke-width:2;opacity:.45"/></pattern></defs>';
    // rejilla horizontal
    const step = niceStep((hi - lo) / 4);
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
      s += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + f1(Y(v)) + '" y2="' + f1(Y(v)) + '" style="stroke:var(--line);stroke-width:1"/>' +
        '<text x="' + (pl - 8) + '" y="' + f1(Y(v) + 5) + '" text-anchor="end" style="fill:var(--muted);font-size:14px">' + esc(fmt(v, step < 1 ? 1 : 0)) + "</text>";
    }
    // zona de tus límites
    if (o.mn != null && o.mx != null) s += '<rect x="' + pl + '" y="' + f1(Y(o.mx)) + '" width="' + (W - pl - pr) + '" height="' + f1(Y(o.mn) - Y(o.mx)) + '" style="fill:var(--ok-bg);stroke:var(--ok);stroke-dasharray:6 5;opacity:.9"/>';
    [o.mn, o.mx].forEach((v) => { if (v != null && (o.mn == null || o.mx == null)) s += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + f1(Y(v)) + '" y2="' + f1(Y(v)) + '" style="stroke:var(--ok);stroke-width:2;stroke-dasharray:6 5"/>'; });
    // marcas de tiempo
    const span = o.to - o.from, ticks = [];
    if (span > 2 * DAY) {
      const d = new Date(o.from); d.setHours(0, 0, 0, 0);
      for (let t = d.getTime() + DAY; t < o.to; t += DAY) ticks.push([t, new Date(t).toLocaleDateString("es-CO", { weekday: "short", day: "numeric" })]);
    } else {
      const d = new Date(o.from); d.setMinutes(0, 0, 0);
      const every = span > 12 * HOUR ? 3 : span > 6 * HOUR ? 2 : 1;
      for (let t = d.getTime() + HOUR; t < o.to; t += HOUR) if (new Date(t).getHours() % every === 0) ticks.push([t, new Date(t).toLocaleTimeString("es-CO", { hour: "numeric" })]);
    }
    ticks.forEach(([t, lab]) => {
      s += '<line x1="' + f1(X(t)) + '" x2="' + f1(X(t)) + '" y1="' + pt + '" y2="' + (H - pb) + '" style="stroke:var(--line);stroke-width:1;opacity:.6"/>' +
        '<text x="' + f1(X(t)) + '" y="' + (H - pb + 22) + '" text-anchor="middle" style="fill:var(--muted);font-size:14px">' + esc(lab) + "</text>";
    });
    // huecos sin datos (rayados)
    const gaps = [];
    if (o.pts[0].t - o.from > o.gapMs) gaps.push([o.from, o.pts[0].t]);
    for (let i = 1; i < o.pts.length; i++) if (o.pts[i].t - o.pts[i - 1].t > o.gapMs) gaps.push([o.pts[i - 1].t, o.pts[i].t]);
    if (o.to - o.pts[o.pts.length - 1].t > o.gapMs) gaps.push([o.pts[o.pts.length - 1].t, o.to]);
    gaps.forEach(([a, b]) => { s += '<rect x="' + f1(X(a)) + '" y="' + pt + '" width="' + f1(Math.max(1, X(b) - X(a))) + '" height="' + (H - pt - pb) + '" fill="url(#hatch' + o.id + ')"/>'; });
    const path = (pts) => {
      let d = "";
      pts.forEach((p, i) => { d += (i && p.t - pts[i - 1].t <= o.gapMs ? "L" : "M") + f1(X(p.t)) + " " + f1(Y(p.v)); });
      return d;
    };
    if (o.cmp && o.cmp.length) s += '<path d="' + path(o.cmp) + '" style="fill:none;stroke:var(--info);stroke-width:2.5;stroke-dasharray:7 6"/>';
    s += '<path d="' + path(o.pts) + '" style="fill:none;stroke:var(--strong);stroke-width:2.5;stroke-linejoin:round"/>';
    // tramos fuera de tus límites
    let od = "";
    for (let i = 1; i < o.pts.length; i++) {
      const a = o.pts[i - 1], b = o.pts[i];
      if (b.t - a.t > o.gapMs) continue;
      if (outOf(a.v, o.mn, o.mx) || outOf(b.v, o.mn, o.mx)) od += "M" + f1(X(a.t)) + " " + f1(Y(a.v)) + "L" + f1(X(b.t)) + " " + f1(Y(b.v));
    }
    if (od) s += '<path d="' + od + '" style="fill:none;stroke:var(--crit);stroke-width:6;stroke-linecap:round"/>';
    // máximo y mínimo
    let pMax = o.pts[0], pMin = o.pts[0];
    o.pts.forEach((p) => { if (p.v > pMax.v) pMax = p; if (p.v < pMin.v) pMin = p; });
    const mark = (p, word, up) => {
      const x = X(p.t), y = Y(p.v), anchor = x > W - 120 ? "end" : x < pl + 60 ? "start" : "middle";
      return '<circle cx="' + f1(x) + '" cy="' + f1(y) + '" r="5" style="fill:var(--surface);stroke:var(--strong);stroke-width:2.5"/>' +
        '<text x="' + f1(x) + '" y="' + f1(up ? y - 11 : y + 21) + '" text-anchor="' + anchor + '" style="fill:var(--strong);font-size:14px;font-weight:700">' + esc(word + " " + fmt(p.v, o.dec)) + "</text>";
    };
    if (pMax.v !== pMin.v) s += mark(pMax, "máx", true) + mark(pMin, "mín", false);
    // ahora
    const now = Date.now();
    if (now >= o.from && now <= o.to + 1000) {
      const x = X(Math.min(now, o.to));
      s += '<line x1="' + f1(x) + '" x2="' + f1(x) + '" y1="' + (pt - 6) + '" y2="' + (H - pb) + '" style="stroke:var(--brand);stroke-width:2;stroke-dasharray:3 4"/>' +
        '<text x="' + f1(x - 4) + '" y="' + (pt - 8) + '" text-anchor="end" style="fill:var(--brand);font-size:13px;font-weight:700">ahora</text>';
    }
    return '<svg class="boxchart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(o.label) + '">' + s + "</svg>";
  }

  async function renderCaja() {
    const host = $('section[data-view="caja"]');
    const C = App.caja, S = App.settings, now = Date.now();
    let s = sensorById(C.sensor);
    if (!s) { s = App.sensors[0]; C.sensor = s.id; }
    const other = App.sensors.find((x) => x.id !== s.id && x.enabled);
    const b = cajaBounds();
    const all = await App.store.readingsRange(b.from - HOUR, b.to);
    all.sort((x, y) => x.ts - y.ts);
    const mine = all.filter((r) => r.sensorId === s.id && r.ts >= b.from);
    const ck = L.controlKey(s), ok = ck === "tempOut" ? "OUT" : "IN";
    const dT = L.describe(mine.map((r) => r[ck])), dH = L.describe(mine.map((r) => r.humidity));
    const at = (v) => { const r = mine.find((x) => x[ck] === v); return r ? (C.period === "7d" ? fmtWhen(r.ts) : "a las " + fmtHour(r.ts)) : ""; };
    const o = L.minutesOutOfRange(mine, s, now, S), outT = o.tempHigh + o.tempLow, outH = o.humHigh + o.humLow;
    const hasLim = s.tempMin != null || s.tempMax != null || s.humMin != null || s.humMax != null;
    const bx = thermalBoxFor(s.id);
    const last = App.latest[s.id] || (await App.store.lastReading(s.id));
    const st = L.currentStatus(s, last, now, S);
    const t = shownValue(last, ck), h = shownValue(last, "humidity");
    const maxPts = 700, bucket = (b.to - b.from) / maxPts;
    const gapMs = Math.max(3 * S.intervalSec * 1000, 2.5 * bucket, 5 * 60000);
    const pts = L.series(mine, s.id, ck, b.from, b.to, maxPts).map((p) => ({ t: p.t, v: p.v }));
    const cmp = C.compare && other ? L.series(all, other.id, L.controlKey(other), b.from, b.to, maxPts).map((p) => ({ t: p.t, v: p.v })) : null;
    const hum = L.series(mine, s.id, "humidity", b.from, b.to, maxPts).map((p) => ({ t: p.t, v: p.v }));
    const periodTxt = { today: "hoy", "24h": "en las últimas 24 h", "7d": "en los últimos 7 días" }[C.period];
    const lim = (mn, mx, dec, unit) => (mn == null && mx == null ? "no configurado" : (mn != null ? fmt(mn, dec) : "–") + " a " + (mx != null ? fmt(mx, dec) : "–") + " " + unit);

    host.innerHTML =
      '<div class="page-head"><h1>' + esc(s.name) + "</h1>" +
        '<div class="row-actions">' +
          '<div class="segbtn" role="group" aria-label="Caja">' + App.sensors.map((x) => '<button type="button" data-csensor="' + x.id + '" aria-pressed="' + (x.id === s.id) + '">' + esc(x.name) + "</button>").join("") + "</div>" +
          '<div class="segbtn" role="group" aria-label="Periodo">' + [["today", "Hoy"], ["24h", "24 h"], ["7d", "7 días"]].map((p) => '<button type="button" data-cperiod="' + p[0] + '" aria-pressed="' + (C.period === p[0]) + '">' + p[1] + "</button>").join("") + "</div>" +
        "</div></div>" +
      '<div class="kpis">' +
        '<div class="kpi' + (outT ? " crit" : "") + '"><span>Fuera de límites</span><span class="v">' + (hasLim ? esc(fmtDur(outT * 60000)) : "–") + '</span><span class="s">' + (hasLim ? "temperatura " + periodTxt + (outH ? " · humedad " + esc(fmtDur(outH * 60000)) : "") : "sin límites configurados") + "</span></div>" +
        '<div class="kpi"><span>Máxima</span><span class="v">' + (dT.n ? fmt(dT.max) + " °C" : "–") + '</span><span class="s">' + esc(dT.n ? at(dT.max) : "sin datos") + "</span></div>" +
        '<div class="kpi"><span>Mínima</span><span class="v">' + (dT.n ? fmt(dT.min) + " °C" : "–") + '</span><span class="s">' + esc(dT.n ? at(dT.min) : "sin datos") + "</span></div>" +
        '<div class="kpi"><span>Promedio</span><span class="v">' + (dT.n ? fmt(dT.mean) + " °C" : "–") + '</span><span class="s">' + (dH.n ? "humedad " + fmt(dH.mean, 0) + " %" : "sin datos de humedad") + "</span></div>" +
        '<div class="kpi"><span>Lámpara encendida</span><span class="v">' + (bx && C.period === "today" ? esc(fmtDur((bx.onMinutesToday || 0) * 60000)) : "–") + '</span><span class="s">' + (bx ? (C.period === "today" ? "hoy" : "solo se cuenta el día de hoy") : "sin control de lámparas") + "</span></div>" +
      "</div>" +
      '<div class="caja-grid"><div class="caja-main col">' +
        '<div class="panel"><header><h2>Temperatura de la caja (' + ok + ")</h2><div class=\"spacer\"></div>" +
          (other ? '<label class="f inline"><input type="checkbox" id="cajaCmp"' + (C.compare ? " checked" : "") + "> <span>Comparar con " + esc(other.name) + "</span></label>" : "") + "</header>" +
          '<div class="panel-body col">' +
            '<div class="legend"><span><i class="lg-line"></i>' + esc(s.name) + "</span>" + (cmp ? '<span><i class="lg-dash"></i>' + esc(other.name) + "</span>" : "") + (s.tempMin != null && s.tempMax != null ? '<span><i class="lg-zone"></i>Tus límites</span><span><i class="lg-out"></i>Fuera de límites</span>' : "") + '<span><i class="lg-gap"></i>Sin datos</span></div>' +
            boxChartSvg({ id: "t", pts, cmp, from: b.from, to: b.to, mn: s.tempMin, mx: s.tempMax, unit: "°C", dec: 1, gapMs, minSpan: 2, label: "Temperatura de " + s.name + " " + periodTxt }) +
          "</div></div>" +
        '<div class="panel"><header><h2>Humedad</h2></header><div class="panel-body">' +
          boxChartSvg({ id: "h", pts: hum, cmp: null, from: b.from, to: b.to, mn: s.humMin, mx: s.humMax, unit: "%", dec: 0, gapMs, minSpan: 10, h: 220, label: "Humedad de " + s.name + " " + periodTxt }) +
        "</div></div>" +
        '<p class="muted-text">Solo se grafican lecturas confiables. Para otros periodos y la tabla completa: <a href="#graficas" data-go="graficas">gráficas por periodo</a> · <a href="#historico" data-go="historico">historial</a>.</p>' +
      "</div>" +
      '<aside class="caja-side">' +
        '<div class="panel"><header><h2>Ahora</h2><div class="spacer"></div>' + statusChip(st.code) + '</header><div class="panel-body quad">' +
          '<div class="kv"><span>Temperatura (' + ok + ")</span>" + (t.v != null ? '<span class="v' + (outOf(t.v, s.tempMin, s.tempMax) ? " crit" : "") + '">' + fmt(t.v) + " °C</span>" : '<span class="v">– –</span>') + "</div>" +
          '<div class="kv"><span>Humedad</span>' + (h.v != null ? '<span class="v' + (outOf(h.v, s.humMin, s.humMax) ? " crit" : "") + '">' + fmt(h.v, 0) + " %</span>" : '<span class="v">– –</span>') + "</div>" +
          '<span class="muted-text" style="grid-column:1/-1">' + (last ? "Última lectura " + esc(fmtAgo(last.ts)) : "Aún no hay lecturas") + "</span>" +
        "</div></div>" +
        '<div class="panel"><header><h2>Tus límites</h2></header><div class="panel-body col">' +
          '<div class="kv"><span>Temperatura</span><span class="v sm">' + esc(lim(s.tempMin, s.tempMax, 1, "°C")) + "</span></div>" +
          '<div class="kv"><span>Humedad</span><span class="v sm">' + esc(lim(s.humMin, s.humMax, 0, "%")) + "</span></div>" +
          '<p class="muted-text">Los pones tú según tu protocolo; la app no propone rangos.</p>' +
          '<a class="btn" href="#sensores" data-go="sensores">Cambiar límites</a>' +
        "</div></div>" +
        '<div class="panel"><header><h2>Lámpara</h2></header><div class="panel-body col">' +
          (bx
            ? lampLine(bx) + '<div class="segbtn full" role="group" aria-label="Modo de la lámpara">' + [["AUTO", "Automático"], ["MANUAL_ON", "Encender"], ["MANUAL_OFF", "Apagar"]].map((m) => '<button type="button" data-box="' + esc(bx.id) + '" data-mode="' + m[0] + '" aria-pressed="' + (bx.mode === m[0]) + '">' + m[1] + "</button>").join("") + "</div>" +
              '<p class="muted-text">En «Automático» la lámpara se enciende y apaga sola según tu perfil. En manual no se apaga por temperatura (sí por seguridad).</p>'
            : '<p class="muted-text">Esta caja no tiene control de lámpara conectado.</p><a class="btn" href="#termico" data-go="termico">Configurar lámparas</a>') +
        "</div></div>" +
        '<button class="btn" type="button" id="cajaXlsx">Descargar Excel de este periodo</button>' +
      "</aside></div>";

    $$("[data-csensor]", host).forEach((x) => x.addEventListener("click", () => { C.sensor = x.dataset.csensor; renderCaja(); }));
    $$("[data-cperiod]", host).forEach((x) => x.addEventListener("click", () => { C.period = x.dataset.cperiod; renderCaja(); }));
    const cc = $("#cajaCmp");
    if (cc) cc.addEventListener("change", () => { C.compare = cc.checked; renderCaja(); });
    $("#cajaXlsx").addEventListener("click", () => exportExcel(b.from, b.to));
    if (window.MonThermalUI) window.MonThermalUI.bindModeButtons(host);
    bindGo(host);
  }

  // ─────────────────────────── DATOS Y CONEXIONES ───────────────────────────

  async function renderDatos() {
    const host = $('section[data-view="datos"]');
    const [nRead, nSnap] = await Promise.all([App.store.countReadings(), App.store.countSnapshots()]);
    const th = window.MonThermalUI;
    const thOn = !!thermalStatus();
    host.innerHTML =
      '<div class="page-head"><h1>Datos y conexiones</h1></div>' +
      '<div class="panel"><header><h2>Llevar tus datos a otros sistemas</h2></header><div class="panel-body">' +
        '<div class="conn-row"><div><b>Excel</b><span class="muted-text">Lecturas, alertas y resumen por día, listo para abrir en Excel.</span></div>' +
          '<select id="dXlsxDays" aria-label="Periodo del Excel"><option value="1">Hoy</option><option value="7">7 días</option><option value="30" selected>30 días</option></select>' +
          '<button class="btn primary" type="button" id="dXlsx">Descargar Excel</button></div>' +
        '<div class="conn-row"><div><b>Resumen para el panel de seguimiento</b><span class="muted-text">Últimas 24 h: valores, promedios por hora y alertas (sin imágenes). Súbelo en el panel → <b>Monitoreo</b>. Nada se envía solo: tú decides cuándo.</span></div>' +
          '<button class="btn" type="button" id="dSumCopy">Copiar</button><button class="btn primary" type="button" id="dSumDl">Descargar</button></div>' +
        '<div class="conn-row"><div><b>Copia de respaldo</b><span class="muted-text">' + nRead + " lecturas · " + nSnap + " imágenes guardadas en este navegador. Úsala para pasar los datos a otro computador.</span></div>" +
          '<button class="btn" type="button" id="dBkExport">Crear copia</button><label class="btn">Restaurar<input type="file" id="dBkImport" accept="application/json,.json" hidden></label></div>' +
        '<div class="conn-row"><div><b>Control de lámparas</b><span class="muted-text">' + (thOn ? "Conectado en este computador." : th && th.online === false ? "No conectado: el servicio local de las lámparas no responde." : "Comprobando…") + "</span></div>" +
          '<span class="chip ' + (thOn ? "ok" : "off") + '">' + ico(thOn ? "ok" : "off", 16) + (thOn ? "Conectado" : "Sin conexión") + '</span><a class="btn ghost" href="#termico" data-go="termico">Abrir lámparas</a></div>' +
      "</div></div>" +
      '<div class="panel"><header><h2>Formato de los números</h2></header><div class="panel-body">' +
        '<div class="conn-row"><div><b>Separador decimal</b><span class="muted-text">Cómo se muestran los decimales en la app (p. ej. 28,3 °C o 28.3 °C).</span></div>' +
          '<div class="segbtn" role="group" aria-label="Separador decimal">' + [[",", "Coma (28,3)"], [".", "Punto (28.3)"]].map((d) => '<button type="button" data-dec="' + d[0] + '" aria-pressed="' + (App.ui.decimal === d[0]) + '">' + d[1] + "</button>").join("") + "</div></div>" +
      "</div></div>";

    $("#dXlsx").addEventListener("click", () => { const d = Number($("#dXlsxDays").value); const now = Date.now(); exportExcel(d === 1 ? L.dayBounds(L.dayKey(now)).from : now - d * DAY, now); });
    const summary = async () => {
      const now = Date.now();
      const [rs, es] = await Promise.all([App.store.readingsRange(now - 2 * DAY, now), App.store.eventsRange(now - 7 * DAY, now)]);
      return L.buildSummary(rs, es, App.sensors, App.settings, now);
    };
    $("#dSumDl").addEventListener("click", async () => {
      download(new Blob([JSON.stringify(await summary(), null, 1)], { type: "application/json" }), "bioteva-resumen_" + stamp() + ".json");
      toast("Resumen descargado: súbelo en el panel → Monitoreo.");
    });
    $("#dSumCopy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(JSON.stringify(await summary())); toast("Resumen copiado. Pégalo en el panel → Monitoreo."); }
      catch (e) { toast("No se pudo copiar; usa «Descargar».", "warn"); }
    });
    $("#dBkExport").addEventListener("click", async () => {
      const data = await App.store.exportBackup();
      download(new Blob([JSON.stringify(data)], { type: "application/json" }), "bioteva-monitor-respaldo_" + stamp() + ".json");
    });
    $("#dBkImport").addEventListener("change", async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const res = await App.store.importBackup(JSON.parse(await f.text()));
        await loadConfig();
        toast("Copia restaurada: " + res.readings + " lecturas, " + res.events + " eventos.");
        renderDatos();
      } catch (err) { toast("No se pudo restaurar: " + err.message, "crit"); }
    });
    $$("[data-dec]", host).forEach((b) => b.addEventListener("click", async () => {
      App.ui.decimal = b.dataset.dec;
      await App.store.setKV("ui", App.ui);
      toast("Listo: los decimales se muestran con " + (App.ui.decimal === "," ? "coma" : "punto") + ".");
      renderDatos();
    }));
    bindGo(host);
  }

  // ─────────────────────────── REPORTES ───────────────────────────

  let reportDate = null;

  async function renderReports() {
    const host = $('section[data-view="reportes"]');
    reportDate = reportDate || toDateInput(Date.now());
    const reports = await App.store.listReports();
    host.innerHTML =
      '<div class="panel"><header><h2>Reportes</h2></header><div class="panel-body col">' +
        '<div class="filters"><label class="f"><span>Fecha</span><input type="date" id="repDate" value="' + esc(reportDate) + '"></label>' +
        '<button class="btn" id="repChanges" type="button">¿Hubo cambios importantes este día?</button>' +
        '<button class="btn primary" id="repGen" type="button">Generar reporte diario</button>' +
        '<button class="btn" id="repXlsx" type="button">⤓ Excel de este día</button></div>' +
        '<div class="row-actions"><button class="btn" id="repPanel" type="button">⤓ Resumen para el panel de seguimiento</button>' +
        '<span class="hint">Últimas 24 h: valores, promedios por hora y alertas (sin imágenes). Súbelo en el panel → <b>Monitoreo</b>.</span></div>' +
        '<div id="repOut"></div>' +
      "</div></div>" +
      '<div class="panel"><header><h2>Reportes guardados</h2></header><div class="panel-body">' +
        (reports.length
          ? '<ul class="plain">' + reports.slice(0, 60).map((r) => '<li><span class="mono">' + esc(r.date) + '</span> · generado ' + esc(L.fmtDateTime(r.generatedAt)) + ' <button class="btn ghost small" data-rep="' + esc(r.id) + '">Abrir</button></li>').join("") + "</ul>"
          : '<p class="muted-text">Aún no hay reportes.</p>') +
      "</div></div>";
    $("#repDate").addEventListener("change", (e) => (reportDate = e.target.value || reportDate));
    $("#repPanel").addEventListener("click", async () => {
      const now = Date.now();
      const [rs, es] = await Promise.all([App.store.readingsRange(now - 2 * DAY, now), App.store.eventsRange(now - 7 * DAY, now)]);
      const doc = L.buildSummary(rs, es, App.sensors, App.settings, now);
      download(new Blob([JSON.stringify(doc, null, 1)], { type: "application/json" }), "bioteva-resumen_" + stamp() + ".json");
      toast("Resumen descargado: súbelo en el panel → Monitoreo.");
    });
    const dayData = async () => {
      const b = L.dayBounds(reportDate);
      const [rs, es] = await Promise.all([App.store.readingsRange(b.from, b.to), App.store.eventsRange(b.from, b.to)]);
      return { b, rs, es };
    };
    $("#repChanges").addEventListener("click", async () => {
      const { b, rs, es } = await dayData();
      $("#repOut").innerHTML = '<div class="answer"></div>';
      $("#repOut .answer").textContent = L.changesReport(rs, es, App.sensors, App.settings, b.from, b.to).text;
    });
    $("#repGen").addEventListener("click", async () => {
      const { rs, es } = await dayData();
      const md = L.dailyReport(reportDate, rs, es, App.sensors, App.settings);
      const rep = { id: L.uid(), date: reportDate, generatedAt: Date.now(), content: md };
      await App.store.addReport(rep);
      showReport(rep);
      renderReportsListOnly();
    });
    $("#repXlsx").addEventListener("click", async () => { const b = L.dayBounds(reportDate); exportExcel(b.from, b.to); });
    $$("[data-rep]", host).forEach((b) => b.addEventListener("click", async () => showReport(await App.store.getReport(b.dataset.rep))));
  }
  async function renderReportsListOnly() { const out = $("#repOut").innerHTML; await renderReports(); $("#repOut").innerHTML = out; bindReportButtons(); }
  function bindReportButtons() {
    const dl = $("#repDl");
    if (dl) dl.addEventListener("click", () => download(new Blob([dl.dataset.content || $("#repText").textContent], { type: "text/markdown;charset=utf-8" }), "reporte-ambiental_" + dl.dataset.date + ".md"));
    const cp = $("#repCopy");
    if (cp) cp.addEventListener("click", () => navigator.clipboard.writeText($("#repText").textContent).then(() => toast("Reporte copiado.")));
  }
  function showReport(rep) {
    if (!rep) return;
    $("#repOut").innerHTML = '<div class="row-actions"><button class="btn" id="repDl" type="button" data-date="' + esc(rep.date) + '">⤓ Descargar .md</button><button class="btn ghost" id="repCopy" type="button">Copiar</button></div><pre class="report" id="repText"></pre>';
    $("#repText").textContent = rep.content;
    bindReportButtons();
  }

  // ─────────────────────────── EXCEL ───────────────────────────

  async function exportExcel(from, to) {
    try {
      const [readings, events] = await Promise.all([App.store.readingsRange(from, to), App.store.eventsRange(from, to)]);
      readings.sort((a, b) => a.ts - b.ts || (a.sensorId < b.sensorId ? -1 : 1));
      events.sort((a, b) => a.ts - b.ts);
      const bytes = await buildWorkbook(readings, events, App.sensors, App.settings, from, to);
      download(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "bioteva-monitoreo_" + stamp() + ".xlsx");
      toast("Excel generado: " + readings.length + " lecturas y " + events.length + " eventos (" + L.dayKey(from) + " a " + L.dayKey(to) + ").");
    } catch (e) {
      toast("No se pudo generar el Excel: " + e.message, "crit");
    }
  }

  const buildWorkbook = (...args) => MonWorkbook.build(...args);

  // ─────────────────────────── CONFIGURACIÓN ───────────────────────────

  async function renderSettings() {
    const host = $('section[data-view="configuracion"]');
    const S = App.settings;
    const n = (label, key, step, help) => '<label class="f"><span>' + esc(label) + '</span><input type="number" name="' + key + '" step="' + (step || 1) + '" value="' + esc(S[key]) + '">' + (help ? "<small>" + esc(help) + "</small>" : "") + "</label>";
    const counts = await Promise.all([App.store.countReadings(), App.store.countSnapshots()]);
    let quota = "";
    try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); quota = (e.usage / 1048576).toFixed(1) + " MB usados de " + (e.quota / 1073741824).toFixed(1) + " GB disponibles"; } } catch (e) { /* opcional */ }
    let persisted = null;
    try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch (e) { /* opcional */ }
    host.innerHTML =
      '<form class="panel" id="setForm"><header><h2>Lectura y alertas</h2><div class="spacer"></div><button class="btn primary" type="submit">Guardar</button></header><div class="panel-body col">' +
        "<h3 class=\"sub-h\">Frecuencia</h3><div class=\"grid-form\">" +
          '<label class="f"><span>Leer cada</span><select name="intervalSec">' + L.INTERVAL_OPTIONS.map((v) => '<option value="' + v + '"' + (v === S.intervalSec ? " selected" : "") + ">" + esc(intervalLabel(v)) + "</option>").join("") + "</select></label>" +
        "</div>" +
        '<h3 class="sub-h">Confianza del OCR</h3><div class="grid-form">' +
          n("Confianza mínima (%)", "minConfidence", 1, "Por debajo: LOW CONFIDENCE, no se usa como dato") +
          n("Confianza alta desde (%)", "highConfidence", 1) +
        "</div>" +
        '<h3 class="sub-h">Umbrales de alerta</h3><div class="grid-form">' +
          n("Cambio de temperatura (°C)", "tempChangeThreshold", 0.1) +
          n("Cambio de humedad (%HR)", "humidityChangeThreshold", 0.5) +
          n("Ventana de comparación (min)", "changeWindowMin", 1) +
          n("Lecturas para confirmar fuera de rango", "confirmReadings", 1) +
          n("Ciclos sin lectura → sin datos", "noDataCycles", 1) +
          n("Lecturas idénticas → sin cambios", "staleCycles", 1) +
          n("Silencio entre alertas repetidas (min)", "eventCooldownMin", 1) +
        "</div>" +
        '<h3 class="sub-h">Detección de imagen</h3><div class="grid-form">' +
          n("Imagen «idéntica» si cambia menos de (0–100)", "staleImageThreshold", 0.1) +
          n("Sensor movido si difiere de la calibración más de (0–100)", "notDetectedRefDiff", 1) +
          n("Contraste mínimo del display (0–100)", "minContrast", 1) +
        "</div>" +
        '<h3 class="sub-h">Validación física de la lectura (no son límites de producción)</h3><div class="grid-form">' +
          n("Temperatura plausible mínima (°C)", "plausibleTempMin", 1) +
          n("Temperatura plausible máxima (°C)", "plausibleTempMax", 1) +
          n("Salto máximo creíble de temperatura (°C)", "maxTempJump", 0.1) +
          n("Salto máximo creíble de humedad (%)", "maxHumidityJump", 1) +
        "</div>" +
        '<h3 class="sub-h">Evidencia (snapshots)</h3><div class="grid-form">' +
          '<label class="f"><span>Guardar snapshots</span><select name="saveSnapshots"><option value="off"' + (S.saveSnapshots === "off" ? " selected" : "") + '>OFF</option><option value="events"' + (S.saveSnapshots === "events" ? " selected" : "") + '>Solo lecturas con alerta</option><option value="all"' + (S.saveSnapshots === "all" ? " selected" : "") + ">Todas las lecturas</option></select></label>" +
          n("Conservar snapshots (días)", "snapshotRetentionDays", 1) +
        "</div>" +
        '<label class="f inline"><input type="checkbox" name="notifications"' + (S.notifications ? " checked" : "") + '> <span>Notificaciones del sistema para WARNING y CRITICAL (pide permiso a Chrome)</span></label>' +
        '<p class="form-err" hidden></p>' +
      "</div></form>" +

      '<div class="panel"><header><h2>Simulación</h2></header><div class="panel-body col">' +
        '<p class="hint">Genera un histórico ficticio (caída brusca de temperatura, periodo sin datos, errores de OCR, falla de cámara y valores congelados) procesado por la misma validación y detección de eventos, para probar gráficas, Excel, alertas y reportes. Queda marcado como <b>simulación</b>.</p>' +
        '<div class="filters"><label class="f"><span>Horas a generar</span><select id="simHours"><option value="6">6 h</option><option value="24" selected>24 h</option><option value="72">3 días</option><option value="168">7 días</option></select></label>' +
        '<button class="btn primary" id="simGen" type="button">Generar histórico simulado</button>' +
        '<button class="btn" id="simDel" type="button">Borrar datos simulados</button></div>' +
      "</div></div>" +

      '<div class="panel"><header><h2>Datos y respaldo</h2></header><div class="panel-body col">' +
        "<p>" + counts[0] + " lecturas guardadas · " + counts[1] + " snapshots" + (quota ? " · " + esc(quota) : "") + (persisted === true ? " · almacenamiento persistente ✓" : persisted === false ? " · el navegador podría liberar espacio si el disco se llena" : "") + "</p>" +
        '<p class="hint">Los datos viven en este navegador (IndexedDB) y funcionan sin internet. Cada forma de abrir la app (página local, app instalada o extensión) guarda su propia base: usa el respaldo para moverlos.</p>' +
        '<div class="row-actions"><button class="btn" id="bkExport" type="button">⤓ Descargar respaldo (JSON)</button><label class="btn">⤒ Restaurar respaldo<input type="file" id="bkImport" accept="application/json,.json" hidden></label></div>' +
      "</div></div>" +

      '<div class="panel"><header><h2>Instalación</h2></header><div class="panel-body col install">' + installHelp() + "</div></div>";

    $("#setForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target), patch = {};
      fd.forEach((v, k) => { patch[k] = k === "saveSnapshots" ? v : Number(v); });
      patch.notifications = fd.get("notifications") === "on";
      const err = $(".form-err", ev.target);
      if (patch.notifications && "Notification" in window && Notification.permission !== "granted") {
        const p = await Notification.requestPermission();
        if (p !== "granted") { patch.notifications = false; toast("Chrome no concedió permiso de notificaciones.", "warn"); }
      }
      try {
        await saveSettings(patch);
        err.hidden = true;
        if (App.running) App.nextAt = Math.min(App.nextAt, Date.now() + App.settings.intervalSec * 1000);
        toast("Configuración guardada.");
        renderSettings();
      } catch (e) { err.hidden = false; err.textContent = e.message; }
    });
    $("#simGen").addEventListener("click", async (e) => {
      e.target.disabled = true;
      e.target.textContent = "Generando…";
      await new Promise((r) => setTimeout(r, 30));
      try {
        const res = L.simulateHistory({ settings: App.settings, sensors: App.sensors, hours: Number($("#simHours").value), now: Date.now() - 60000, seed: Date.now() % 9973 });
        await App.store.saveCycle(res.readings, res.events);
        toast("Histórico simulado: " + res.readings.length + " lecturas y " + res.events.length + " eventos (cada " + res.stepSec + " s).");
      } catch (err) { toast("Error al simular: " + err.message, "crit"); }
      renderSettings();
      renderBanners();
    });
    $("#simDel").addEventListener("click", async () => {
      if (!confirm("¿Borrar TODAS las lecturas y eventos marcados como simulación? Los datos reales no se tocan.")) return;
      const n = await App.store.deleteSimulated();
      App.latest = {};
      toast("Eliminados: " + n.readings + " lecturas y " + n.events + " eventos simulados.");
      renderSettings();
      renderBanners();
    });
    $("#bkExport").addEventListener("click", async () => {
      const data = await App.store.exportBackup();
      download(new Blob([JSON.stringify(data)], { type: "application/json" }), "bioteva-monitor-respaldo_" + stamp() + ".json");
    });
    $("#bkImport").addEventListener("change", async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const res = await App.store.importBackup(JSON.parse(await f.text()));
        await loadConfig();
        toast("Respaldo restaurado: " + res.readings + " lecturas, " + res.events + " eventos.");
        renderSettings();
      } catch (err) { toast("No se pudo restaurar: " + err.message, "crit"); }
    });
    const ib = $("#installBtn2");
    if (ib) ib.addEventListener("click", promptInstall);
  }

  function installHelp() {
    const origin = location.origin;
    const parts = [];
    if (App.isExtension) {
      parts.push("<p>✓ Estás usando la <b>extensión de Chrome</b>. Ábrela desde el ícono de BioTeva en la barra de extensiones (fíjala con el ícono de la pieza de rompecabezas).</p>");
    } else {
      parts.push('<p><b>Instalar en este computador (app de escritorio):</b> ' + (App.installPrompt ? '<button class="btn primary small" id="installBtn2" type="button">⊕ Instalar ahora</button>' : "en Chrome abre el menú ⋮ → <i>Transmitir, guardar y compartir</i> → <i>Instalar página como app</i> (o el ícono ⊕ de la barra de direcciones).") + " Se abre en su propia ventana, con ícono en el escritorio y el menú Inicio, y funciona sin internet.</p>");
      parts.push('<p><b>Extensión de Chrome:</b> <a href="download/bioteva-monitor-extension.zip" download>descargar la extensión (.zip)</a>. Chrome <b>no</b> la instala desde el .zip: primero «Extraer todo» en una carpeta que no vayas a borrar (p. ej. <span class="mono">Documentos\BioTeva\extension</span>), luego abre <span class="mono">chrome://extensions</span>, activa <i>Modo de desarrollador</i> y pulsa <i>Cargar descomprimida</i> sobre esa carpeta (la que contiene <span class="mono">manifest.json</span>). Si luego borras o mueves la carpeta, la extensión deja de funcionar. Instrucciones completas en <span class="mono">INSTALAR.txt</span> dentro del .zip.</p>');
      parts.push('<p class="hint">Dirección actual: <span class="mono">' + esc(origin + location.pathname) + "</span></p>");
    }
    return parts.join("");
  }

  async function promptInstall() {
    if (!App.installPrompt) return toast("Usa el menú ⋮ de Chrome → Instalar página como app.");
    App.installPrompt.prompt();
    await App.installPrompt.userChoice.catch(() => null);
    App.installPrompt = null;
    $("#installBtn").hidden = true;
  }

  // ─────────────────────────── arranque ───────────────────────────

  async function loadConfig() {
    const saved = await App.store.getKV("settings");
    if (saved && !saved.cfgV) {
      if (saved.minContrast === 12) saved.minContrast = 4; // umbral anterior, demasiado alto para LCD reales
      saved.cfgV = 2;
    }
    App.migrateOut = !!(saved && (saved.cfgV || 0) < 3);
    // v4: la cámara queda fija → el seguimiento automático pasa a estar apagado (se puede activar)
    App.migrateTrack = !!(saved && (saved.cfgV || 0) < 4);
    if (saved) saved.cfgV = 4;
    App.settings = L.validateSettings(saved || {}).value;
    const sensors = await App.store.getKV("sensors");
    if (Array.isArray(sensors) && sensors.length) {
      App.sensors = ["A", "B"].map((id) => {
        const s = sensors.find((x) => x.id === id);
        const base = L.defaultSensor(id);
        if (!s) return base;
        const merged = Object.assign(base, s);
        merged.calibration = Object.assign(L.defaultCalibration(id), s.calibration || {});
        merged.calibration.fields = Object.assign(L.defaultCalibration(id).fields, (s.calibration || {}).fields || {});
        merged.calibration.track = Object.assign({ enabled: false, tpl: null }, (s.calibration || {}).track || {});
        if (App.migrateTrack) merged.calibration.track.enabled = false;
        if (App.migrateOut && merged.controlTemp === "in") merged.controlTemp = "out"; // OUT = caja (sonda)
        // distribución antigua (genérica) → la real del HTC-2
        if (JSON.stringify(merged.calibration.fields) === L.OLD_FIELDS_JSON) {
          merged.calibration.fields = L.HTC2_FIELDS();
          if (!merged.calibration.slantDeg) merged.calibration.slantDeg = 6;
        }
        return merged;
      });
    }
    App.lastCycleAt = (await App.store.getKV("lastCycleAt")) || null;
    const ui = await App.store.getKV("ui");
    if (ui && (ui.decimal === "," || ui.decimal === ".")) App.ui.decimal = ui.decimal;
  }

  function bindTheme() {
    const order = ["system", "light", "dark"];
    const btn = $("#themeBtn");
    let cur = "system";
    try { cur = localStorage.getItem("mon-theme") || "system"; } catch (e) { /* opcional */ }
    const label = { system: "Tema: automático", light: "Tema: claro", dark: "Tema: oscuro" };
    const set = (m) => { if (m === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", m); btn.title = label[m] + " (toca para cambiar)"; btn.setAttribute("aria-label", label[m] + ". Toca para cambiar"); };
    set(cur);
    btn.addEventListener("click", () => { cur = order[(order.indexOf(cur) + 1) % 3]; try { localStorage.setItem("mon-theme", cur); } catch (e) { /* opcional */ } set(cur); });
  }

  function startTicker() {
    try {
      // Un Worker no sufre el estrangulamiento de temporizadores de las pestañas en segundo plano.
      const w = new Worker("js/ticker.js");
      w.onmessage = tick;
      w.onerror = () => setInterval(tick, 1000);
    } catch (e) {
      setInterval(tick, 1000);
    }
  }

  async function init() {
    bindTheme();
    App.renderView = renderView;
    try {
      App.store = await MonStore.open();
    } catch (e) {
      window.BioTevaMonitorReady = true;
      $("#bootMsg").hidden = true;
      $("main").innerHTML = '<div class="panel"><div class="panel-body"><b>No se pudo abrir el almacenamiento local.</b><p>' + esc(e.message) + "</p></div></div>";
      return;
    }
    await loadConfig();
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* opcional */ }

    $$("#tabs .tab, #bottomNav button, #sideNav button").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));
    $$("[data-nav]").forEach((a) => a.addEventListener("click", (ev) => { ev.preventDefault(); showView(a.dataset.nav); }));
    window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if (v && v !== App.view && (v === "ajustes" || $('main > section[data-view="' + v + '"]'))) showView(v); });
    $("#runBtn").addEventListener("click", () => setRunning(!App.running));
    $("#nowBtn").addEventListener("click", async () => {
      if (App.settings.frameSource === "camera" && App.cam.status !== "active") await startCameras();
      const res = await runCycle("manual");
      if (res && res.length) toast("Lectura registrada: " + res.map((r) => sensorById(r.reading.sensorId).name + " " + (L.STATUS_LABELS[r.reading.status] || r.reading.status)).join(" · "));
    });
    $("#installBtn").addEventListener("click", promptInstall);
    // Plan tecnológico: copiar el prompt para Claude Code
    $("#planCopy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText($("#planPrompt").textContent); toast("Prompt copiado. Pégalo en Claude Code."); }
      catch (e) { toast("No se pudo copiar: abre «Ver el prompt» y cópialo a mano.", "warn"); }
    });
    bindGo($('section[data-view="plan"]'));
    window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); App.installPrompt = e; $("#installBtn").hidden = false; });
    window.addEventListener("appinstalled", () => { $("#installBtn").hidden = true; toast("BioTeva Monitor quedó instalado en este computador."); });
    document.addEventListener("visibilitychange", async () => {
      if (!document.hidden && App.running && !App.wakeLock && "wakeLock" in navigator) { try { App.wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { /* opcional */ } }
    });
    let rz;
    window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (App.view === "graficas") renderCharts(); }, 250); });
    // cada minuto se refrescan los «hace X min» de Inicio (sin tocar formularios)
    setInterval(() => { if (App.view === "dashboard" && !document.hidden) renderDashboard(); }, 60000);

    bindCameraView();
    bindCalibration();
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener("devicechange", async () => {
        await refreshDevices();
        if (App.cam.status === "active" && App.cam.streams.some((e) => e.stream.getVideoTracks()[0].readyState !== "live")) setCamStatus("error", "Una cámara se desconectó.");
      });
    }
    refreshDevices();

    // Manifiesto PWA solo por http(s): abierta desde el archivo (file://) Chrome no lo admite.
    if (/^https?:$/.test(location.protocol)) { const m = document.createElement("link"); m.rel = "manifest"; m.href = "manifest.webmanifest"; document.head.appendChild(m); }
    if (!App.isExtension && "serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register("sw.js").catch(() => { /* sin modo offline */ });
    }
    $("#footMode").textContent = App.isExtension ? "· Extensión de Chrome" : window.matchMedia("(display-mode: standalone)").matches ? "· App instalada" : "";

    const v = location.hash.slice(1);
    showView(v && (v === "ajustes" || $('main > section[data-view="' + v + '"]')) ? v : "dashboard");
    window.BioTevaMonitorReady = true;
    $("#bootMsg").hidden = true;
    renderHeader();
    startTicker();
    previewLoop();

    extensionSync();
    // Reanudar tras un reinicio de la app si el monitoreo estaba en curso.
    if (await App.store.getKV("running")) {
      toast("Reanudando el monitoreo que estaba en curso…");
      await setRunning(true);
    }
  }

  init();
})();
