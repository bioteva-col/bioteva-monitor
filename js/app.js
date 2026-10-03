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

  const STATUS_UI = {
    NORMAL: { icon: "✓", cls: "good" },
    ATENCION: { icon: "!", cls: "warn" },
    FUERA_DE_RANGO: { icon: "▲", cls: "crit" },
    SIN_DATOS: { icon: "∅", cls: "muted" },
    LECTURA_INCIERTA: { icon: "?", cls: "warn" },
    CAMARA_DESCONECTADA: { icon: "✕", cls: "crit" },
    SENSOR_NO_DETECTADO: { icon: "⌖", cls: "crit" },
  };
  function statusChip(code) {
    const ui = STATUS_UI[code] || STATUS_UI.SIN_DATOS;
    return '<span class="chip ' + ui.cls + '"><span class="chip-icon" aria-hidden="true">' + ui.icon + "</span>" + esc((L.STATUS_LABELS[code] || code).toUpperCase()) + "</span>";
  }
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
    setCamStatus("starting");
    const [w, h] = App.settings.resolution.split("x").map(Number);
    try {
      for (const id of wantedDeviceIds()) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { deviceId: id ? { exact: id } : undefined, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: App.settings.fps } },
        });
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
  const isTracking = (s) => !!(s.calibration.track && s.calibration.track.enabled !== false);

  /** Fija un sensor sobre una pantalla (LCD, px): esquinas + plantilla para seguirla + referencia. */
  function lockSensorOn(sensor, gray, quadPxLcd) {
    const cal = sensor.calibration;
    cal.quad = normQuad(quadPxLcd, gray.w, gray.h);
    cal.track = { enabled: cal.track ? cal.track.enabled !== false : true, tpl: Seg.makeTemplate(gray, quadPxLcd) };
    const a = analyzeSensor(sensor, gray, cal, false);
    cal.reference = Seg.thumbToB64(a.thumb);
    App.prevThumbs[sensor.id] = null;
    App.track.state[sensor.id] = { ok: true, score: 1, how: "ubicada", at: Date.now() };
    App.track.tplRefreshed[sensor.id] = Date.now();
  }

  /** Detecta pantallas en toda la imagen y asigna las que falten (izquierda → A, derecha → B). */
  function autoAssign(gray, sensors, force) {
    const raw = Seg.detectLcds(gray);
    // los sensores son del mismo tamaño aprox.: se descartan marcas mucho más pequeñas que la mejor
    const found = raw.filter((c) => c.area >= raw[0].area * 0.3).slice(0, 6);
    App.cal.candidates = { list: found, w: gray.w, h: gray.h };
    App.cal.candidatesAt = Date.now();
    const targets = sensors.filter((s) => force || !(s.calibration.track && s.calibration.track.tpl));
    const taken = sensors.filter((s) => !targets.includes(s)).map((s) => pxQuad(s.calibration.quad, gray.w, gray.h));
    const free = found.filter((f) => !taken.some((t) => Seg.pointInQuad(t, Seg.quadCenter(f.quad))));
    const pick = free.slice(0, targets.length).sort((a, b) => Seg.quadCenter(a.quad).x - Seg.quadCenter(b.quad).x);
    targets.sort((a, b) => (a.id < b.id ? -1 : 1)).forEach((s, i) => { if (pick[i]) lockSensorOn(s, gray, pick[i].quad); });
    return { found: found.length, assigned: Math.min(pick.length, targets.length) };
  }

  /** Reubica (si se movieron) los sensores que usan este fotograma. */
  function trackOnFrame(gray, sensors) {
    const list = sensors.filter(isTracking);
    if (!list.length) return;
    // sensores que nunca se ubicaron → reconocimiento automático
    if (list.some((s) => !s.calibration.track.tpl)) autoAssign(gray, list, false);
    const ready = list.filter((s) => s.calibration.track.tpl);
    if (!ready.length) return;
    const res = Seg.trackScreens(gray, ready.map((s) => ({ id: s.id, tpl: s.calibration.track.tpl, last: pxQuad(s.calibration.quad, gray.w, gray.h) })));
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
          if (isTracking(sensor) && tk && !tk.ok) {
            capture.referenceDiffScore = 100; // pantalla no encontrada → SENSOR NO DETECTADO
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

  function tick() {
    if (window.MonThermalUI) window.MonThermalUI.poll(false);
    if (App.running && !App.busy && Date.now() >= App.nextAt) runCycle("timer");
    renderHeader();
  }

  // ─────────────────────────── cabecera ───────────────────────────

  function renderHeader() {
    const S = App.settings;
    const cam = $("#camPill");
    if (S.frameSource === "simulation") { cam.textContent = "SIMULACIÓN"; cam.className = "pill info"; }
    else if (S.frameSource === "image") { cam.textContent = App.still ? "IMAGEN ESTÁTICA" : "SIN IMAGEN"; cam.className = "pill " + (App.still ? "info" : "warn"); }
    else {
      const map = { off: ["CAMERA OFF", "muted"], starting: ["CAMERA STARTING", "warn"], active: ["CAMERA ACTIVE", "good"], error: ["CAMERA ERROR", "crit"] };
      const m = map[App.cam.status] || map.off;
      cam.textContent = m[0];
      cam.className = "pill " + m[1];
      cam.title = App.cam.error || "";
    }
    const run = $("#runPill");
    run.textContent = App.running ? (App.busy ? "LEYENDO…" : "MONITOREO EN CURSO") : "DETENIDO";
    run.className = "pill " + (App.running ? "good" : "muted");
    $("#lastPill").textContent = "LAST READING: " + (App.lastCycleAt ? fmtClock(App.lastCycleAt) : "—");
    if (App.running && App.nextAt) {
      const s = Math.max(0, Math.round((App.nextAt - Date.now()) / 1000));
      $("#nextPill").textContent = "NEXT READING: " + pad2(Math.floor(s / 60)) + ":" + pad2(s % 60);
    } else $("#nextPill").textContent = "NEXT READING: —";
    const btn = $("#runBtn");
    btn.textContent = App.running ? "■ Detener monitoreo" : "▶ Iniciar monitoreo";
    btn.classList.toggle("primary", !App.running);
  }

  async function updateAlertCount() {
    const now = Date.now();
    const evs = await App.store.eventsRange(now - 30 * DAY, now);
    const n = evs.filter((e) => e.severity !== "INFO" && !e.ack).length;
    const el = $("#alertCount");
    el.textContent = n;
    el.classList.toggle("hot", n > 0);
  }

  async function renderBanners() {
    const out = [];
    if (App.settings.frameSource === "simulation") out.push('<div class="banner info"><b>Modo simulación activo.</b> Los valores son ficticios y quedan marcados como «simulación». Cámbialo en <b>Cámara → Fuente de imagen</b>.</div>');
    else if (await App.store.hasSimulated()) out.push('<div class="banner info">Hay datos simulados guardados junto con los reales. Se identifican en la columna «Fuente» y puedes borrarlos en <b>Configuración → Simulación</b>.</div>');
    if (!window.isSecureContext) out.push('<div class="banner warn">Esta página no está en un origen seguro: Chrome no permitirá la cámara. Ábrela como extensión, en http://localhost o por https.</div>');
    if (App.running && App.settings.frameSource === "camera") out.push('<div class="banner muted">Mantén esta ventana abierta y el equipo encendido: si se cierra, se suspende o se apaga, las lecturas se detienen y se registrará un periodo sin datos.</div>');
    $("#banners").innerHTML = out.join("");
  }

  // ─────────────────────────── navegación ───────────────────────────

  function showView(name) {
    App.view = name;
    $$("#tabs .tab").forEach((t) => t.setAttribute("aria-selected", t.dataset.view === name ? "true" : "false"));
    $$("main > section").forEach((s) => (s.hidden = s.dataset.view !== name));
    if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
    renderView();
  }

  function renderView() {
    renderBanners();
    updateAlertCount();
    switch (App.view) {
      case "dashboard": return renderDashboard();
      case "camara": return renderCameraForm();
      case "calibracion": return openCalibration();
      case "termico": return window.MonThermalUI ? window.MonThermalUI.render() : null;
      case "sensores": return renderSensors();
      case "historico": return renderHistory();
      case "graficas": return renderCharts();
      case "alertas": return renderAlerts();
      case "reportes": return renderReports();
      case "configuracion": return renderSettings();
    }
  }

  // ─────────────────────────── DASHBOARD ───────────────────────────

  async function renderDashboard() {
    const host = $('section[data-view="dashboard"]');
    const now = Date.now(), S = App.settings;
    const dayStart = L.dayBounds(L.dayKey(now)).from;
    const today = await App.store.readingsRange(dayStart, now);
    const cards = [];
    for (const s of App.sensors) {
      const last = App.latest[s.id] || (await App.store.lastReading(s.id));
      if (last) App.latest[s.id] = last;
      const st = L.currentStatus(s, last, now, S);
      const ck = L.controlKey(s);
      const mine = today.filter((r) => r.sensorId === s.id);
      const dT = L.describe(mine.map((r) => r[ck])), dH = L.describe(mine.map((r) => r.humidity));
      const hour = mine.filter((r) => r.ts >= now - HOUR);
      const hT = L.describe(hour.map((r) => r[ck])), hH = L.describe(hour.map((r) => r.humidity));
      const val = (k, unit, dec) => {
        const v = last ? last[k] : null;
        const raw = last && last.fields && last.fields[k];
        const shown = v != null ? L.num(v, dec) : raw && raw.value != null ? L.num(raw.value, dec) : "—";
        const doubt = v == null && raw && raw.value != null;
        return '<span class="v' + (doubt ? " doubt" : "") + '">' + esc(shown) + (shown !== "—" ? " <small>" + unit + "</small>" : "") + "</span>" + (doubt ? '<span class="sub warn">no confiable (' + esc(L.LEVEL_LABELS[raw.level]) + ")</span>" : "");
      };
      const delta = (d, unit) => (d == null ? "" : '<span class="sub">' + esc(L.signed(d)) + " " + unit + " vs anterior</span>");
      const limT = s.tempMin == null && s.tempMax == null ? null : (s.tempMin != null ? L.num(s.tempMin) : "—") + "–" + (s.tempMax != null ? L.num(s.tempMax) : "—") + " °C";
      const limH = s.humMin == null && s.humMax == null ? null : (s.humMin != null ? L.num(s.humMin, 0) : "—") + "–" + (s.humMax != null ? L.num(s.humMax, 0) : "—") + " %";
      cards.push(
        '<article class="sensor-card ' + (STATUS_UI[st.code] || {}).cls + '">' +
          "<header><h2>" + esc(s.name) + (s.enabled ? "" : " (desactivado)") + '</h2><div class="spacer"></div>' + statusChip(st.code) + "</header>" +
          '<div class="vals">' +
            '<div class="val"><span class="k">IN · ambiente' + (ck === "tempIn" ? " · control" : "") + "</span>" + val("tempIn", "°C", 1) + (ck === "tempIn" && last ? delta(last.deltaTemp, "°C") : "") + "</div>" +
            '<div class="val"><span class="k">OUT · caja' + (ck === "tempOut" ? " · control" : "") + "</span>" + val("tempOut", "°C", 1) + (ck === "tempOut" && last ? delta(last.deltaTemp, "°C") : "") + "</div>" +
            '<div class="val"><span class="k">Humidity</span>' + val("humidity", "%", 0) + (last ? delta(last.deltaHum, "%") : "") + "</div>" +
            '<div class="val"><span class="k">Hora del display</span><span class="v small">' + esc((last && last.displayTime) || "—") + "</span></div>" +
          "</div>" +
          (st.note ? '<p class="note warn">' + esc(st.note) + "</p>" : "") +
          '<dl class="meta">' +
            "<div><dt>Última lectura</dt><dd>" + (last ? esc(L.fmtDateTime(last.ts)) + (last.source === "simulation" ? ' <span class="tag">simulación</span>' : "") : "—") + "</dd></div>" +
            "<div><dt>Confianza OCR</dt><dd>" + (last && last.confidence != null ? esc(L.num(last.confidence, 0)) + " % · " + esc(L.LEVEL_LABELS[last.level]) : "—") + "</dd></div>" +
            "<div><dt>Hoy (" + (ck === "tempOut" ? "OUT" : "IN") + ")</dt><dd>" + (dT.n ? "mín " + L.num(dT.min) + " · máx " + L.num(dT.max) + " · prom " + L.num(dT.mean) + " °C" : "sin datos") + "</dd></div>" +
            "<div><dt>Hoy (humedad)</dt><dd>" + (dH.n ? L.num(dH.min, 0) + "–" + L.num(dH.max, 0) + " % · prom " + L.num(dH.mean) + " %" : "sin datos") + "</dd></div>" +
            "<div><dt>Última hora</dt><dd>" + (hT.n ? "prom " + L.num(hT.mean) + " °C · " + L.num(hH.mean) + " %" : "sin datos") + "</dd></div>" +
            "<div><dt>Ubicación de la pantalla</dt><dd>" + esc(trackText(s)) + "</dd></div>" +
            "<div><dt>Límites</dt><dd>" + (limT || limH ? esc([limT && "Temp. " + limT, limH && "Hum. " + limH].filter(Boolean).join(" · ")) : '<a href="#sensores" data-go="sensores">sin límites configurados</a>') + "</dd></div>" +
          "</dl>" +
        "</article>",
      );
    }

    const evs = (await App.store.eventsRange(now - 7 * DAY, now)).filter((e) => e.severity !== "INFO" && !e.ack).sort((a, b) => b.ts - a.ts).slice(0, 6);
    host.innerHTML =
      '<div class="dash-top">' +
        '<div class="panel next"><div class="panel-body"><span class="k">NEXT READING</span><span class="big mono" id="dashNext">—</span>' +
        '<span class="sub">Cada ' + esc(intervalLabel(S.intervalSec)) + " · fuente: " + esc({ camera: "cámara", image: "imagen estática", simulation: "simulación" }[S.frameSource]) + "</span></div></div>" +
        '<div class="panel preview-mini"><canvas id="dashPreview" width="1280" height="720" aria-label="Vista previa en vivo"></canvas></div>' +
      "</div>" +
      '<div class="sensor-grid">' + cards.join("") + "</div>" +
      (window.MonThermalUI ? window.MonThermalUI.dashboardHtml() : "") +
      '<div class="panel"><header><h2>¿Hubo cambios importantes hoy?</h2><div class="spacer"></div><button class="btn" id="askToday" type="button">Analizar hoy</button></header><div class="panel-body"><div id="todayAnswer" class="answer muted-text">Pulsa «Analizar hoy» para revisar cambios bruscos, tendencias, valores fuera de rango, periodos sin datos y lecturas sospechosas.</div></div></div>' +
      '<div class="panel"><header><h2>Alertas sin reconocer</h2><div class="spacer"></div><a class="btn ghost" href="#alertas" data-go="alertas">Ver todas</a></header><div class="panel-body">' +
        (evs.length ? '<ul class="events">' + evs.map(eventItem).join("") + "</ul>" : '<p class="muted-text">Sin alertas pendientes.</p>') +
      "</div></div>";
    $("#askToday").addEventListener("click", async () => {
      const b = L.dayBounds(L.dayKey(Date.now()));
      const [rs, es] = await Promise.all([App.store.readingsRange(b.from, b.to), App.store.eventsRange(b.from, b.to)]);
      $("#todayAnswer").textContent = L.changesReport(rs, es, App.sensors, App.settings, b.from, b.to).text;
      $("#todayAnswer").classList.remove("muted-text");
    });
    bindGo(host);
    if (window.MonThermalUI) window.MonThermalUI.bindModeButtons(host);
    drawPreview();
  }

  function trackText(s) {
    if (!isTracking(s)) return "fija (calibración manual)";
    if (!s.calibration.track.tpl) return "se detectará sola en la próxima lectura";
    const tk = App.track.state[s.id];
    if (!tk) return "seguimiento activo";
    return tk.ok ? "seguimiento activo · coincidencia " + Math.round(tk.score * 100) + " %" : "no encontrada en la imagen — ¿se movió fuera del encuadre?";
  }

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
    if (!App.cal.draft || App.cal.draftFor !== s.id) { App.cal.draft = clone(s.calibration); App.cal.draftFor = s.id; }
    $$('input[name="calSensor"]').forEach((r) => (r.checked = r.value === s.id));
    $$('input[name="calField"]').forEach((r) => (r.checked = r.value === App.cal.field));
    $("#calSlant").value = App.cal.draft.slantDeg;
    $("#calSlantOut").textContent = App.cal.draft.slantDeg + "°";
    $("#calLight").checked = !!App.cal.draft.lightSegments;
    $("#calTrack").checked = !App.cal.draft.track || App.cal.draft.track.enabled !== false;
    $("#calMsg").textContent = "";
    buildCalTable();
    drawCalibration(true);
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
    const inner = Seg.fitLcdAt(fr.gray, { x, y });
    if (!inner) return calMsg("No se reconoció una pantalla en ese punto. Haz clic en el centro de la pantalla del sensor, o arrastra un rectángulo a mano.", "crit");
    App.cal.draft.quad = normQuad(inner, fr.gray.w, fr.gray.h);
    drawCalibration(false);
    calMsg("Pantalla de " + sensorById(App.cal.sensorId).name + " ajustada. Revisa la lectura de prueba y pulsa «Guardar calibración».", "good");
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
    $$('input[name="calSensor"]').forEach((r) => r.addEventListener("change", () => { App.cal.sensorId = r.value; App.cal.draft = null; openCalibration(); }));
    $$('input[name="calField"]').forEach((r) => r.addEventListener("change", () => { App.cal.field = r.value; drawCalibration(false); }));
    $("#calSlant").addEventListener("input", (e) => { App.cal.draft.slantDeg = Number(e.target.value); $("#calSlantOut").textContent = e.target.value + "°"; drawCalibration(false); });
    $("#calLight").addEventListener("change", (e) => { App.cal.draft.lightSegments = e.target.checked; drawCalibration(false); });
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
        if (act === "rot-" || act === "rot+") {
          const ang = ((act === "rot+" ? 1 : -1) * Math.PI) / 180, c = Math.cos(ang), s = Math.sin(ang);
          d.quad = transformQuad(d.quad, (p, cx, cy) => { const dx = (p.x - cx) * aspect, dy = p.y - cy; return { x: cx + (dx * c - dy * s) / aspect, y: cy + dx * s + dy * c }; });
        } else {
          const k = act === "scale+" ? 1.03 : 1 / 1.03;
          d.quad = transformQuad(d.quad, (p, cx, cy) => ({ x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k }));
        }
        drawCalibration(false);
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
      App.cal.drag = corner >= 0 ? { mode: "corner", i: corner } : { mode: "rect", x0: p.x, y0: p.y };
      canvas.setPointerCapture(ev.pointerId);
    });
    canvas.addEventListener("pointermove", (ev) => {
      const dr = App.cal.drag;
      if (!dr) return;
      const p = canvasPoint(canvas, ev), W = canvas.width, H = canvas.height;
      const nx = Math.max(0, Math.min(1, p.x / W)), ny = Math.max(0, Math.min(1, p.y / H));
      if (dr.mode === "corner") App.cal.draft.quad[dr.i] = { x: nx, y: ny };
      else {
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
    });
    canvas.addEventListener("pointercancel", end);

    // Región de un campo en la vista rectificada.
    let fdrag = null;
    rc.addEventListener("pointerdown", (ev) => { const p = canvasPoint(rc, ev); fdrag = { x0: p.x, y0: p.y }; rc.setPointerCapture(ev.pointerId); });
    rc.addEventListener("pointermove", (ev) => {
      if (!fdrag) return;
      const p = canvasPoint(rc, ev), W = rc.width, H = rc.height;
      if (Math.abs(p.x - fdrag.x0) < 6 || Math.abs(p.y - fdrag.y0) < 6) return;
      const f = App.cal.draft.fields[App.cal.field];
      f.x = Math.max(0, Math.min(fdrag.x0, p.x) / W);
      f.y = Math.max(0, Math.min(fdrag.y0, p.y) / H);
      f.w = Math.min(1 - f.x, Math.abs(p.x - fdrag.x0) / W);
      f.h = Math.min(1 - f.y, Math.abs(p.y - fdrag.y0) / H);
      f.enabled = true;
      drawCalibration(false);
    });
    rc.addEventListener("pointerup", () => (fdrag = null));
    rc.addEventListener("pointercancel", () => (fdrag = null));

    $("#calTrack").addEventListener("change", (e) => {
      App.cal.draft.track = Object.assign({ enabled: true, tpl: null }, App.cal.draft.track || {}, { enabled: e.target.checked });
    });
    $("#calDetect").addEventListener("click", async () => {
      const fr = App.cal.lastFrame;
      if (!fr || fr.error) return calMsg("No hay imagen: activa la cámara o elige una fuente en «Cámara».", "crit");
      calMsg("Buscando pantallas…");
      await new Promise((r) => setTimeout(r, 20));
      const res = autoAssign(fr.gray, App.sensors.filter((x) => x.enabled), true);
      await saveSensors();
      App.cal.draft = null;
      openCalibration();
      if (!res.found) calMsg("No se detectaron pantallas. Haz clic sobre la pantalla de cada sensor (o acerca la cámara / mejora la luz).", "crit");
      else calMsg("Se detectaron " + res.found + " pantalla(s) (#1, #2… en amarillo); se asignaron " + res.assigned + ". Revisa que Sensor A y B sean los correctos; si están al revés, usa «Intercambiar A ↔ B».", "good");
    });
    $("#calSwap").addEventListener("click", async () => {
      const a = sensorById("A").calibration, b = sensorById("B").calibration;
      ["quad", "track", "reference"].forEach((k) => { const t = a[k]; a[k] = b[k]; b[k] = t; });
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
      App.cal.draft = clone(draft);
      App.prevThumbs[s.id] = null;
      await saveSensors();
      $("#calMsg").textContent = "Calibración de " + s.name + " guardada (" + new Date().toLocaleTimeString("es-CO") + ").";
      $("#calMsg").className = "msg good";
    });
  }

  // ─────────────────────────── SENSORES (límites) ───────────────────────────

  function renderSensors() {
    const host = $('section[data-view="sensores"]');
    host.innerHTML =
      '<div class="banner muted">El sistema <b>no propone</b> rangos óptimos para los grillos. Ingresa los límites definidos por tu protocolo de producción; un campo vacío significa «no configurado» y no genera alertas de rango.</div>' +
      '<div class="sensor-grid">' +
      App.sensors.map((s) =>
        '<form class="panel" data-sensor="' + esc(s.id) + '"><header><h2>' + esc(s.name) + '</h2><div class="spacer"></div><label class="f inline"><input type="checkbox" name="enabled" ' + (s.enabled ? "checked" : "") + "> <span>Activo</span></label></header>" +
        '<div class="panel-body"><div class="grid-form">' +
          '<label class="f"><span>Nombre</span><input name="name" required maxlength="60" value="' + esc(s.name) + '"></label>' +
          '<label class="f"><span>Temperatura de control (para límites y alertas)</span><select name="controlTemp"><option value="out"' + (s.controlTemp === "out" ? " selected" : "") + '>OUT · temperatura de caja (sonda)</option><option value="in"' + (s.controlTemp === "in" ? " selected" : "") + ">IN · ambiente</option></select></label>" +
          '<label class="f"><span>Temperatura mínima (°C) — target_min</span><input name="tempMin" type="number" step="0.1" placeholder="no configurado" value="' + (s.tempMin == null ? "" : s.tempMin) + '"></label>' +
          '<label class="f"><span>Temperatura máxima (°C) — target_max</span><input name="tempMax" type="number" step="0.1" placeholder="no configurado" value="' + (s.tempMax == null ? "" : s.tempMax) + '"></label>' +
          '<label class="f"><span>Humedad mínima (%)</span><input name="humMin" type="number" step="1" min="0" max="100" placeholder="no configurado" value="' + (s.humMin == null ? "" : s.humMin) + '"></label>' +
          '<label class="f"><span>Humedad máxima (%)</span><input name="humMax" type="number" step="1" min="0" max="100" placeholder="no configurado" value="' + (s.humMax == null ? "" : s.humMax) + '"></label>' +
        '</div><p class="form-err" hidden></p><div class="row-actions"><button class="btn primary" type="submit">Guardar</button><a class="btn ghost" href="#calibracion" data-cal-go="' + esc(s.id) + '">Calibrar</a></div></div></form>',
      ).join("") + "</div>";
    $$("form[data-sensor]", host).forEach((f) =>
      f.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const s = sensorById(f.dataset.sensor);
        const fd = new FormData(f);
        const cand = { tempMin: fd.get("tempMin"), tempMax: fd.get("tempMax"), humMin: fd.get("humMin"), humMax: fd.get("humMax") };
        const errors = L.validateSensorLimits(cand);
        const err = $(".form-err", f);
        if (errors.length) { err.hidden = false; err.textContent = errors.join(" · "); return; }
        err.hidden = true;
        Object.assign(s, cand, { name: String(fd.get("name") || s.name).trim() || s.name, controlTemp: fd.get("controlTemp") === "out" ? "out" : "in", enabled: fd.get("enabled") === "on" });
        await saveSensors();
        toast(s.name + " guardado.");
        renderSensors();
      }),
    );
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

  // ─────────────────────────── ALERTAS ───────────────────────────

  const alertFilter = { sev: "alerts", pending: true, sensor: "" };

  async function renderAlerts() {
    const host = $('section[data-view="alertas"]');
    const now = Date.now(), S = App.settings;
    const live = App.sensors.filter((s) => s.enabled).map((s) => ({ s, st: L.currentStatus(s, App.latest[s.id], now, S) })).filter((x) => x.st.code === "SIN_DATOS");
    let evs = (await App.store.eventsRange(now - 30 * DAY, now)).sort((a, b) => b.ts - a.ts);
    if (alertFilter.sev === "alerts") evs = evs.filter((e) => e.severity !== "INFO");
    if (alertFilter.sev === "CRITICAL") evs = evs.filter((e) => e.severity === "CRITICAL");
    if (alertFilter.pending) evs = evs.filter((e) => !e.ack);
    if (alertFilter.sensor) evs = evs.filter((e) => e.sensorId === alertFilter.sensor);
    host.innerHTML =
      (live.length ? '<div class="panel"><header><h2>Ahora</h2></header><div class="panel-body"><ul class="events">' + live.map((x) => '<li class="ev warn">' + sevChip("WARNING") + "<div><b>Sin lecturas</b> · " + esc(x.s.name) + "<p>" + esc(x.st.note) + ". Lecturas no actualizadas: verificar que el monitoreo está en curso y la cámara conectada.</p></div></li>").join("") + "</ul></div></div>" : "") +
      '<div class="panel"><header><h2>Alertas y eventos (30 días)</h2><div class="spacer"></div><button class="btn" id="ackAll" type="button">Reconocer todas</button></header>' +
      '<div class="panel-body"><form class="filters" id="alertForm">' +
        '<label class="f"><span>Severidad</span><select name="sev"><option value="alerts"' + (alertFilter.sev === "alerts" ? " selected" : "") + '>WARNING y CRITICAL</option><option value="CRITICAL"' + (alertFilter.sev === "CRITICAL" ? " selected" : "") + '>Solo CRITICAL</option><option value="all"' + (alertFilter.sev === "all" ? " selected" : "") + ">Todos (incluye INFO)</option></select></label>" +
        '<label class="f"><span>Sensor</span><select name="sensor"><option value="">Todos</option>' + App.sensors.map((s) => '<option value="' + s.id + '"' + (alertFilter.sensor === s.id ? " selected" : "") + ">" + esc(s.name) + "</option>").join("") + "</select></label>" +
        '<label class="f inline"><input type="checkbox" name="pending"' + (alertFilter.pending ? " checked" : "") + "> <span>Solo sin reconocer</span></label>" +
      "</form>" +
      (evs.length
        ? '<ul class="events">' + evs.slice(0, 300).map((e) => eventItem(e).replace("</div></li>", (e.severity !== "INFO" && !e.ack ? '<button class="btn small" data-ack="' + esc(e.id) + '">Reconocer</button>' : e.ack ? '<span class="small-text muted-text">reconocida ' + esc(L.fmtDateTime(e.ack)) + "</span>" : "") + "</div></li>")).join("") + "</ul>"
        : '<p class="muted-text">Sin eventos con estos filtros.</p>') +
      '<p class="hint">Umbrales actuales: cambio de ±' + S.tempChangeThreshold + " °C o ±" + S.humidityChangeThreshold + " %HR en " + S.changeWindowMin + " min · " + S.confirmReadings + " lecturas confiables para confirmar un valor fuera de rango · sin datos tras " + S.noDataCycles + " ciclos · confianza mínima " + S.minConfidence + ' %. <a href="#configuracion" data-go="configuracion">Cambiar</a>.</p>' +
      "</div></div>";
    $("#alertForm").addEventListener("change", (e) => {
      const fd = new FormData(e.currentTarget);
      alertFilter.sev = fd.get("sev"); alertFilter.sensor = fd.get("sensor"); alertFilter.pending = fd.get("pending") === "on";
      renderAlerts();
    });
    $("#ackAll").addEventListener("click", async () => { const n = await App.store.ackAll(); toast(n + " alerta(s) reconocidas."); renderAlerts(); });
    $$("[data-ack]", host).forEach((b) => b.addEventListener("click", async () => { await App.store.ackEvent(b.dataset.ack); renderAlerts(); }));
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
        '<div id="repOut"></div>' +
      "</div></div>" +
      '<div class="panel"><header><h2>Reportes guardados</h2></header><div class="panel-body">' +
        (reports.length
          ? '<ul class="plain">' + reports.slice(0, 60).map((r) => '<li><span class="mono">' + esc(r.date) + '</span> · generado ' + esc(L.fmtDateTime(r.generatedAt)) + ' <button class="btn ghost small" data-rep="' + esc(r.id) + '">Abrir</button></li>').join("") + "</ul>"
          : '<p class="muted-text">Aún no hay reportes.</p>') +
      "</div></div>";
    $("#repDate").addEventListener("change", (e) => (reportDate = e.target.value || reportDate));
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
      parts.push('<p><b>Extensión de Chrome:</b> <a href="download/bioteva-monitor-extension.zip" download>descargar la extensión (.zip)</a>. Descomprímela, abre <span class="mono">chrome://extensions</span>, activa <i>Modo de desarrollador</i> y pulsa <i>Cargar descomprimida</i> sobre la carpeta.</p>');
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
    if (saved) saved.cfgV = 3;
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
        merged.calibration.track = Object.assign({ enabled: true, tpl: null }, (s.calibration || {}).track || {});
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
  }

  function bindTheme() {
    const order = ["system", "light", "dark"], glyph = { system: "◐", light: "○", dark: "●" };
    const btn = $("#themeBtn");
    let cur = "system";
    try { cur = localStorage.getItem("mon-theme") || "system"; } catch (e) { /* opcional */ }
    const set = (m) => { if (m === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", m); btn.textContent = glyph[m]; };
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

    $$("#tabs .tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));
    window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if (v && v !== App.view && $('main > section[data-view="' + v + '"]')) showView(v); });
    $("#runBtn").addEventListener("click", () => setRunning(!App.running));
    $("#nowBtn").addEventListener("click", async () => {
      if (App.settings.frameSource === "camera" && App.cam.status !== "active") await startCameras();
      const res = await runCycle("manual");
      if (res && res.length) toast("Lectura registrada: " + res.map((r) => sensorById(r.reading.sensorId).name + " " + (L.STATUS_LABELS[r.reading.status] || r.reading.status)).join(" · "));
    });
    $("#xlsxBtn").addEventListener("click", () => exportExcel(Date.now() - 30 * DAY, Date.now()));
    $("#installBtn").addEventListener("click", promptInstall);
    window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); App.installPrompt = e; $("#installBtn").hidden = false; });
    window.addEventListener("appinstalled", () => { $("#installBtn").hidden = true; toast("BioTeva Monitor quedó instalado en este computador."); });
    document.addEventListener("visibilitychange", async () => {
      if (!document.hidden && App.running && !App.wakeLock && "wakeLock" in navigator) { try { App.wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { /* opcional */ } }
    });
    let rz;
    window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (App.view === "graficas") renderCharts(); }, 250); });

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
    showView(v && $('main > section[data-view="' + v + '"]') ? v : "dashboard");
    window.BioTevaMonitorReady = true;
    $("#bootMsg").hidden = true;
    renderHeader();
    startTicker();
    previewLoop();

    // Reanudar tras un reinicio de la app si el monitoreo estaba en curso.
    if (await App.store.getKV("running")) {
      toast("Reanudando el monitoreo que estaba en curso…");
      await setRunning(true);
    }
  }

  init();
})();
