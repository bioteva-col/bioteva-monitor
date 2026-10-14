/*
 * BioTeva Monitor — lógica de dominio (sin DOM ni almacenamiento).
 *
 * Validación de lecturas OCR, niveles de confianza, detección de eventos,
 * estados, resúmenes diarios, estadísticas, análisis de cambios y reporte.
 *
 * Reglas que este archivo respeta en todo el código:
 *  - NO inventa límites de producción para los grillos: solo existen si el
 *    usuario los configura (null = no configurado).
 *  - NO afirma causas (apagón, bombillo dañado…): usa "posible evento
 *    ambiental", "se requiere verificación física".
 *  - Una lectura dudosa nunca se usa como dato confiable ni dispara una alerta
 *    crítica: las alertas críticas exigen lecturas confiables consecutivas.
 */
(function (root) {
  "use strict";

  var FIELD_KEYS = ["tempIn", "tempOut", "humidity", "time"];
  var FIELD_LABELS = { tempIn: "Temperatura IN", tempOut: "Temperatura OUT", humidity: "Humedad", time: "Hora del display" };
  var LEVEL_LABELS = { HIGH: "Confianza alta", MEDIUM: "Confianza media", LOW: "Confianza baja", INVALID: "Inválida" };
  var LEVEL_RANK = { INVALID: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
  var STATUS_LABELS = {
    NORMAL: "Normal",
    ATENCION: "Atención",
    FUERA_DE_RANGO: "Fuera de rango",
    SIN_DATOS: "Sin datos",
    LECTURA_INCIERTA: "Lectura incierta",
    CAMARA_DESCONECTADA: "Cámara desconectada",
    SENSOR_NO_DETECTADO: "Sensor no detectado",
  };
  var EVENT_LABELS = {
    TEMPERATURE_INCREASE: "Aumento de temperatura",
    TEMPERATURE_DECREASE: "Disminución de temperatura",
    HUMIDITY_INCREASE: "Aumento de humedad",
    HUMIDITY_DECREASE: "Disminución de humedad",
    TEMPERATURE_ABOVE_LIMIT: "Temperatura sobre el límite",
    TEMPERATURE_BELOW_LIMIT: "Temperatura bajo el límite",
    HUMIDITY_ABOVE_LIMIT: "Humedad sobre el límite",
    HUMIDITY_BELOW_LIMIT: "Humedad bajo el límite",
    RETURN_TO_RANGE: "Regreso al rango",
    READING_UNCHANGED: "Lectura sin cambios",
    POSSIBLE_STALE_READING: "Posible lectura congelada",
    OCR_FAILURE: "Falla de OCR",
    OCR_CORRECTION: "Corrección de OCR",
    OCR_UNCERTAIN: "OCR incierto",
    LOW_CONFIDENCE: "Confianza baja sostenida",
    CAMERA_FAILURE: "Falla de cámara",
    SENSOR_NOT_DETECTED: "Sensor no detectado",
    POSSIBLE_DISCONNECTION: "Posible desconexión / display apagado",
    DATA_GAP: "Periodo sin datos",
  };
  var CHANGE_TYPES = ["TEMPERATURE_INCREASE", "TEMPERATURE_DECREASE", "HUMIDITY_INCREASE", "HUMIDITY_DECREASE"];

  var INTERVAL_OPTIONS = [30, 60, 120, 300, 600, 900];

  /** Parámetros de DETECCIÓN (no son límites biológicos). */
  var DEFAULT_SETTINGS = {
    intervalSec: 60,
    cameraMode: "single",
    cameraDeviceId: null,
    frameSource: "camera",
    resolution: "1920x1080",
    fps: 15,
    saveSnapshots: "events",
    snapshotRetentionDays: 14,
    minConfidence: 70,
    highConfidence: 85,
    tempChangeThreshold: 2,
    humidityChangeThreshold: 10,
    changeWindowMin: 60,
    confirmReadings: 2,
    noDataCycles: 3,
    staleCycles: 5,
    staleImageThreshold: 0.5,
    notDetectedRefDiff: 45,
    minContrast: 4,
    plausibleTempMin: -40,
    plausibleTempMax: 80,
    maxTempJump: 5,
    maxHumidityJump: 20,
    eventCooldownMin: 30,
    notifications: false,
  };

  var NUMERIC_RULES = {
    fps: [1, 30, true],
    snapshotRetentionDays: [1, 365, true],
    minConfidence: [1, 99],
    highConfidence: [2, 100],
    tempChangeThreshold: [0.1, 50],
    humidityChangeThreshold: [0.5, 100],
    changeWindowMin: [5, 360, true],
    confirmReadings: [1, 10, true],
    noDataCycles: [1, 100, true],
    staleCycles: [2, 100, true],
    staleImageThreshold: [0, 100],
    notDetectedRefDiff: [1, 100],
    minContrast: [0, 100],
    plausibleTempMin: [-100, 100],
    plausibleTempMax: [-100, 150],
    maxTempJump: [0.1, 100],
    maxHumidityJump: [0.5, 100],
    eventCooldownMin: [1, 1440, true],
  };

  /** Valida y completa la configuración. { ok, value, errors[] } */
  function validateSettings(input) {
    var s = Object.assign({}, DEFAULT_SETTINGS, input || {}), errors = [];
    Object.keys(NUMERIC_RULES).forEach(function (k) {
      var r = NUMERIC_RULES[k], v = Number(s[k]);
      if (!isFinite(v) || v < r[0] || v > r[1] || (r[2] && Math.round(v) !== v)) errors.push(k + ": debe estar entre " + r[0] + " y " + r[1] + (r[2] ? " (entero)" : ""));
      else s[k] = v;
    });
    s.intervalSec = Number(s.intervalSec);
    if (INTERVAL_OPTIONS.indexOf(s.intervalSec) < 0) errors.push("intervalSec: valor no permitido");
    if (["single", "dual"].indexOf(s.cameraMode) < 0) errors.push("cameraMode inválido");
    if (["camera", "image", "simulation"].indexOf(s.frameSource) < 0) errors.push("frameSource inválido");
    if (["640x480", "1280x720", "1920x1080"].indexOf(s.resolution) < 0) errors.push("resolution inválida");
    if (["off", "events", "all"].indexOf(s.saveSnapshots) < 0) errors.push("saveSnapshots inválido");
    if (s.minConfidence >= s.highConfidence) errors.push("La confianza mínima debe ser menor que la confianza alta");
    if (s.plausibleTempMin >= s.plausibleTempMax) errors.push("Rango de plausibilidad inválido");
    s.notifications = !!s.notifications;
    return { ok: errors.length === 0, value: s, errors: errors };
  }

  function HTC2_FIELDS() {
    return {
      // medido sobre la foto del fabricante y la cámara del usuario (oct-2026), fracciones del LCD
      tempIn: { x: 0.275, y: 0.0, w: 0.505, h: 0.315, digits: 3, decimals: 1, enabled: true },
      tempOut: { x: 0.275, y: 0.337, w: 0.505, h: 0.293, digits: 3, decimals: 1, enabled: true },
      humidity: { x: 0.53, y: 0.655, w: 0.312, h: 0.31, digits: 2, decimals: 0, enabled: true },
      time: { x: 0.095, y: 0.752, w: 0.385, h: 0.19, digits: 4, decimals: 0, enabled: true },
    };
  }
  /** Distribución que traían versiones anteriores (se migra a la del HTC-2). */
  var OLD_FIELDS_JSON = JSON.stringify({
    tempIn: { x: 0.06, y: 0.08, w: 0.6, h: 0.3, digits: 3, decimals: 1, enabled: true },
    tempOut: { x: 0.06, y: 0.46, w: 0.6, h: 0.22, digits: 3, decimals: 1, enabled: true },
    humidity: { x: 0.72, y: 0.08, w: 0.24, h: 0.24, digits: 2, decimals: 0, enabled: true },
    time: { x: 0.06, y: 0.76, w: 0.46, h: 0.18, digits: 4, decimals: 0, enabled: false },
  });

  function defaultCalibration(sensorId) {
    var left = sensorId === "B" ? 0.55 : 0.1;
    return {
      quad: [{ x: left, y: 0.25 }, { x: left + 0.35, y: 0.25 }, { x: left + 0.35, y: 0.75 }, { x: left, y: 0.75 }],
      slantDeg: 6, // los dígitos del HTC-2 son itálicos
      lightSegments: false,
      reference: null,
      /** Seguimiento automático: plantilla de apariencia del equipo (se crea al ubicarlo). */
      track: { enabled: false, tpl: null }, // cámara fija: apagado (se activa si los sensores se mueven)
      // Distribución del LCD del termohigrómetro HTC-2 (fracciones del LCD), medida sobre
      // imágenes reales: fila 1 = temperatura (IN), fila 2 = temperatura (OUT),
      // fila 3 = reloj (izq., pequeño) y humedad relativa (der.).
      fields: HTC2_FIELDS(),
    };
  }

  function defaultSensor(id) {
    return {
      id: id,
      name: "Sensor " + id,
      enabled: true,
      controlTemp: "out", // OUT = sonda dentro de la caja (temperatura de caja)
      tempMin: null,
      tempMax: null,
      humMin: null,
      humMax: null,
      cameraDeviceId: null,
      calibration: defaultCalibration(id),
    };
  }

  /** Valida límites de un sensor; null = no configurado. */
  function validateSensorLimits(s) {
    var errors = [];
    ["tempMin", "tempMax", "humMin", "humMax"].forEach(function (k) {
      if (s[k] === "" || s[k] === undefined) s[k] = null;
      if (s[k] != null) {
        var v = Number(s[k]);
        if (!isFinite(v)) errors.push(k + " no es numérico");
        else s[k] = v;
      }
    });
    if (s.tempMin != null && s.tempMax != null && s.tempMin >= s.tempMax) errors.push("La temperatura mínima debe ser menor que la máxima");
    if (s.humMin != null && s.humMax != null && s.humMin >= s.humMax) errors.push("La humedad mínima debe ser menor que la máxima");
    if (s.humMin != null && (s.humMin < 0 || s.humMin > 100)) errors.push("Humedad mínima fuera de 0–100");
    if (s.humMax != null && (s.humMax < 0 || s.humMax > 100)) errors.push("Humedad máxima fuera de 0–100");
    return errors;
  }

  // ─────────────────────────── formato ───────────────────────────

  var pad2 = function (n) { return (n < 10 ? "0" : "") + n; };
  function fmtTime(ms) { var d = new Date(ms); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }
  function fmtDateTime(ms) {
    var d = new Date(ms);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }
  function dayKey(ms) { var d = new Date(ms); return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function dayBounds(key) {
    var p = key.split("-").map(Number);
    var start = new Date(p[0], p[1] - 1, p[2]).getTime();
    return { from: start, to: new Date(p[0], p[1] - 1, p[2] + 1).getTime() - 1 };
  }
  function fmtDuration(ms) {
    var min = Math.round(ms / 60000);
    if (min < 60) return min + " min";
    var h = Math.floor(min / 60), m = min % 60;
    return h + " h" + (m ? " " + m + " min" : "");
  }
  function num(v, d) { return v == null || !isFinite(v) ? "—" : Number(v).toFixed(d == null ? 1 : d); }
  function signed(v, d) { return (v > 0 ? "+" : v < 0 ? "−" : "±") + Math.abs(v).toFixed(d == null ? 1 : d); }
  var round1 = function (v) { return Math.round(v * 10) / 10; };

  function unitFor(key) { return key === "humidity" ? "%" : "°C"; }
  function metricName(key) { return key === "tempIn" ? "temperatura IN" : key === "tempOut" ? "temperatura OUT" : key === "humidity" ? "humedad" : key; }
  function controlKey(sensor) { return sensor.controlTemp === "out" ? "tempOut" : "tempIn"; }

  function uid() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  // ─────────────────────────── validación ───────────────────────────

  function levelFor(confidence, s) {
    if (confidence >= s.highConfidence) return "HIGH";
    if (confidence >= s.minConfidence) return "MEDIUM";
    return "LOW";
  }
  function isReliable(level) { return level === "HIGH" || level === "MEDIUM"; }

  function plausible(key, v, s) {
    if (key === "humidity") return v >= 0 && v <= 100;
    return v >= s.plausibleTempMin && v <= s.plausibleTempMax;
  }
  function maxJump(key, s) { return key === "humidity" ? s.maxHumidityJump : s.maxTempJump; }

  /**
   * Valida el texto OCR de un campo.
   * ctx: { settings, roi: { digits, decimals }, previous (último valor confiable reciente), previousRaw (valor de la lectura anterior) }
   */
  function validateField(key, ocr, ctx) {
    var s = ctx.settings;
    var base = { key: key, rawText: ocr && ocr.text != null ? String(ocr.text) : "", ocrConfidence: ocr ? ocr.confidence || 0 : 0 };
    function invalid(flags, note) {
      return Object.assign({}, base, { value: null, display: null, confidence: 0, level: "INVALID", flags: flags, note: note });
    }
    var text = base.rawText.trim().replace(/\s+/g, "").replace(",", ".");
    if (!text) return invalid(["EMPTY"], "Sin texto reconocido");
    if (/^-?[LH]{2}/.test(text)) {
      return invalid(["OCR_UNCERTAIN"], "El display muestra \"" + text + "\" (en muchos termohigrómetros indica fuera del rango de medición o sonda desconectada). Verificar físicamente.");
    }
    if (text.indexOf("?") >= 0) return invalid(["OCR_UNCERTAIN"], "Dígito no reconocido en \"" + text + "\"");

    if (key === "time") {
      var digitsOnly = text.replace(/[^0-9]/g, "");
      if (digitsOnly.length < 3 || digitsOnly.length > 4) return invalid(["OCR_UNCERTAIN"], "Hora ilegible \"" + text + "\"");
      var hh = Number(digitsOnly.slice(0, digitsOnly.length - 2)), mm = Number(digitsOnly.slice(-2));
      if (hh > 23 || mm > 59) return invalid(["OCR_UNCERTAIN"], "Hora imposible \"" + text + "\"");
      return Object.assign({}, base, { value: null, display: pad2(hh) + ":" + pad2(mm), confidence: ocr.confidence, level: levelFor(ocr.confidence, s), flags: [] });
    }

    if (!/^-?\d+(\.\d+)?$/.test(text)) return invalid(["OCR_UNCERTAIN"], "Texto no numérico \"" + text + "\"");

    var value = Number(text), confidence = ocr.confidence, flags = [], note;
    var decimals = ctx.roi ? ctx.roi.decimals || 0 : 0;
    var prev = ctx.previous;

    // Punto decimal ausente ("315" en un display que siempre muestra "31.5").
    if (decimals > 0 && text.indexOf(".") < 0) {
      var candidate = Math.round((value / Math.pow(10, decimals)) * Math.pow(10, decimals)) / Math.pow(10, decimals);
      if (prev != null && Math.abs(candidate - prev) <= maxJump(key, s) && plausible(key, candidate, s)) {
        flags.push("OCR_CORRECTION");
        note = "Corrección OCR: \"" + text + "\" interpretado como " + candidate + " (el display muestra " + decimals + " decimal y el valor es coherente con la lectura anterior " + prev + ").";
        value = candidate;
        confidence = Math.min(confidence, (s.minConfidence + s.highConfidence) / 2);
      } else {
        return invalid(["OCR_UNCERTAIN"], "Lectura ambigua \"" + text + "\": falta el punto decimal y no hay una lectura anterior coherente que confirme " + candidate + ".");
      }
    }

    if (!plausible(key, value, s)) return invalid(["OUT_OF_PLAUSIBLE_RANGE"], value + " está fuera del rango físico plausible configurado.");

    if (prev != null && Math.abs(value - prev) > maxJump(key, s)) {
      var confirmedBy = ctx.previousRaw;
      var confirmed = confirmedBy != null && Math.abs(value - confirmedBy) <= maxJump(key, s) / 2;
      if (!confirmed) {
        flags.push("IMPROBABLE_JUMP");
        note = (note ? note + " " : "") + "Salto de " + signed(value - prev) + " respecto a la lectura anterior (" + prev + "); se confirma con la siguiente lectura.";
        confidence = Math.min(confidence, s.minConfidence - 1);
      }
    }

    return Object.assign({}, base, {
      value: round1(value),
      display: text,
      confidence: round1(confidence),
      level: levelFor(confidence, s),
      flags: flags,
      note: note,
    });
  }

  function rangeOf(value, min, max) {
    if (min == null && max == null) return "no_limits";
    if (value == null) return "unknown";
    if (max != null && value > max) return "above";
    if (min != null && value < min) return "below";
    return "in";
  }

  // ─────────────────────────── ciclo de lectura ───────────────────────────

  /**
   * Procesa la captura de UN sensor en un ciclo y devuelve { reading, events }.
   * ctx: { now, settings, sensor, capture, source, history (lecturas previas del sensor, asc), recentEvents }
   *  capture: { captureStatus: "ok"|"camera_error", fields: { key: { text, confidence } }, contrast,
   *             imageChangeScore, referenceDiffScore, cameraLabel, error }
   */
  function processCycle(ctx) {
    var S = ctx.settings, sensor = ctx.sensor, cap = ctx.capture || {}, now = ctx.now, history = ctx.history || [];
    var cal = sensor.calibration, name = sensor.name, intervalMs = S.intervalSec * 1000;
    var prevAny = history.length ? history[history.length - 1] : null;
    var recentWindow = Math.max(15 * 60000, 5 * intervalMs);

    function lastReliable(key, maxAge) {
      for (var i = history.length - 1; i >= 0; i--) {
        var r = history[i];
        if (maxAge != null && now - r.ts > maxAge) return null;
        if (r[key] != null) return r;
      }
      return null;
    }

    var condition = "ok";
    if (cap.captureStatus === "camera_error") condition = "camera_error";
    else if (cap.referenceDiffScore != null && cap.referenceDiffScore >= S.notDetectedRefDiff) condition = "not_detected";
    else if (cap.contrast != null && cap.contrast < S.minContrast) condition = "blank";

    var fields = {};
    if (condition === "ok") {
      FIELD_KEYS.forEach(function (key) {
        var roi = cal.fields[key];
        if (!roi || !roi.enabled) return;
        var prevRel = key === "time" ? null : lastReliable(key, recentWindow);
        var prevRawField = prevAny && prevAny.fields && prevAny.fields[key];
        fields[key] = validateField(key, (cap.fields || {})[key], {
          settings: S,
          roi: roi,
          previous: prevRel ? prevRel[key] : null,
          previousRaw: prevRawField && prevRawField.value != null ? prevRawField.value : null,
        });
      });
    }

    var cKey = controlKey(sensor);
    var mainKeys = [cKey, "humidity"].filter(function (k) { return cal.fields[k] && cal.fields[k].enabled; });
    var valOf = function (k) { return fields[k] && isReliable(fields[k].level) ? fields[k].value : null; };

    var level = "INVALID", confidence = null;
    if (condition === "ok" && mainKeys.length) {
      level = "HIGH";
      mainKeys.forEach(function (k) {
        var f = fields[k];
        var lv = f ? f.level : "INVALID";
        if (LEVEL_RANK[lv] < LEVEL_RANK[level]) level = lv;
        var c = f ? f.confidence : 0;
        confidence = confidence == null ? c : Math.min(confidence, c);
      });
    }

    var reading = {
      id: uid(),
      sensorId: sensor.id,
      ts: now,
      source: ctx.source,
      cameraLabel: cap.cameraLabel || null,
      condition: condition,
      tempIn: valOf("tempIn"),
      tempOut: valOf("tempOut"),
      humidity: valOf("humidity"),
      displayTime: fields.time && fields.time.level !== "INVALID" ? fields.time.display : null,
      confidence: confidence,
      level: level,
      imageQuality: cap.contrast == null ? null : round1(cap.contrast),
      imageChangeScore: cap.imageChangeScore == null ? null : cap.imageChangeScore,
      referenceDiffScore: cap.referenceDiffScore == null ? null : cap.referenceDiffScore,
      fields: fields,
      rawText: condition === "ok"
        ? FIELD_KEYS.filter(function (k) { return fields[k]; }).map(function (k) { return ({ tempIn: "IN", tempOut: "OUT", humidity: "RH", time: "T" })[k] + "=" + (fields[k].rawText || "∅"); }).join(" ")
        : null,
      error: cap.error || null,
      tempRange: "unknown",
      humRange: "unknown",
      rangeConfirmed: false,
      deltaTemp: null,
      deltaHum: null,
      status: "NORMAL",
      snapshotId: null,
    };
    reading.tempRange = rangeOf(reading[cKey], sensor.tempMin, sensor.tempMax);
    reading.humRange = rangeOf(reading.humidity, sensor.humMin, sensor.humMax);

    var events = [];
    var allEvents = (ctx.recentEvents || []).slice();
    function emit(type, severity, metric, value, previousValue, delta, description) {
      var e = {
        id: uid(), sensorId: sensor.id, readingId: reading.id, ts: now, type: type, severity: severity,
        metric: metric || null, value: value == null ? null : value, previousValue: previousValue == null ? null : previousValue,
        delta: delta == null ? null : round1(delta), description: description, source: ctx.source, ack: null,
      };
      events.push(e);
      allEvents.push(e);
    }
    function lastEv(types, metric) {
      var best = null;
      allEvents.forEach(function (e) {
        if (types.indexOf(e.type) < 0) return;
        if (metric && e.metric !== metric) return;
        if (!best || e.ts > best.ts) best = e;
      });
      return best;
    }
    function cooled(type, metric) {
      var l = lastEv([type], metric);
      return !l || now - l.ts >= S.eventCooldownMin * 60000;
    }

    // ---- periodo sin datos ----
    if (prevAny && now - prevAny.ts > (S.noDataCycles + 0.5) * intervalMs) {
      emit("DATA_GAP", "WARNING", null, round1((now - prevAny.ts) / 60000), null, null,
        "Sin lecturas de " + name + " entre " + fmtTime(prevAny.ts) + " y " + fmtTime(now) + " (" + fmtDuration(now - prevAny.ts) + "). Posible interrupción del monitoreo (equipo apagado, suspendido o navegador cerrado). Se requiere verificación.");
    }

    // ---- cámara / sensor ----
    var prevCond = prevAny ? prevAny.condition : null;
    if (condition === "camera_error" && prevCond !== "camera_error") {
      emit("CAMERA_FAILURE", "CRITICAL", null, null, null, null,
        "No se obtuvo imagen de la cámara para " + name + (cap.error ? " (" + cap.error + ")" : "") + ". Revise la conexión y el permiso de la cámara.");
    }
    if (condition === "not_detected" && prevCond !== "not_detected") {
      emit("SENSOR_NOT_DETECTED", "WARNING", null, cap.referenceDiffScore, null, null,
        "La imagen de " + name + " difiere de la calibración (" + num(cap.referenceDiffScore) + "/100). Posible sensor movido, cámara movida, sensor fuera del encuadre o pantalla cubierta. Se requiere verificación física.");
    }
    if (condition === "blank" && prevCond !== "blank") {
      emit("POSSIBLE_DISCONNECTION", "WARNING", null, cap.contrast, null, null,
        "El display de " + name + " no muestra segmentos legibles (contraste " + num(cap.contrast) + "/100). Posible pantalla apagada, sin batería, cubierta o desconectada. Se requiere verificación física.");
    }

    // ---- OCR ----
    function tailCount(pred) {
      var n = 0;
      for (var i = history.length - 1; i >= 0; i--) { if (pred(history[i])) n++; else break; }
      return n;
    }
    if (condition === "ok") {
      var allInvalid = mainKeys.length > 0 && mainKeys.every(function (k) { return !fields[k] || fields[k].level === "INVALID"; });
      if (allInvalid) {
        var nFail = 1 + tailCount(function (r) { return r.condition === "ok" && r.level === "INVALID"; });
        if (nFail === 1) emit("OCR_FAILURE", "INFO", null, null, null, null, "El OCR no pudo leer " + name + " en esta lectura (" + (reading.rawText || "sin texto") + "). No se usa como dato.");
        if (nFail === S.noDataCycles) emit("OCR_FAILURE", "WARNING", null, nFail, null, null, "El OCR no pudo leer " + name + " durante " + nFail + " lecturas consecutivas. Revise enfoque, iluminación, reflejos o la calibración.");
      } else if (level === "LOW") {
        var nLow = 1 + tailCount(function (r) { return r.level === "LOW"; });
        if (nLow === S.noDataCycles) emit("LOW_CONFIDENCE", "WARNING", null, confidence, null, null,
          "La confianza del OCR de " + name + " está por debajo del mínimo (" + S.minConfidence + " %) durante " + nLow + " lecturas consecutivas. Las lecturas no se usan como dato confiable.");
      }
      Object.keys(fields).forEach(function (k) {
        var f = fields[k];
        if (f.flags.indexOf("OCR_CORRECTION") >= 0 && cooled("OCR_CORRECTION", k)) emit("OCR_CORRECTION", "INFO", k, f.value, null, null, name + ": " + f.note);
        if (f.flags.indexOf("OCR_UNCERTAIN") >= 0 && cooled("OCR_UNCERTAIN", k)) emit("OCR_UNCERTAIN", "INFO", k, null, null, null, name + " · " + FIELD_LABELS[k] + ": " + f.note);
      });
    }

    // ---- rangos y cambios ----
    var metrics = [
      { key: cKey, kind: "temp", min: sensor.tempMin, max: sensor.tempMax, rangeField: "tempRange", thr: S.tempChangeThreshold },
      { key: "humidity", kind: "hum", min: sensor.humMin, max: sensor.humMax, rangeField: "humRange", thr: S.humidityChangeThreshold },
    ];
    var pendingOut = false, confirmedOut = false;
    metrics.forEach(function (m) {
      var v = reading[m.key];
      if (v == null) return;
      var unit = unitFor(m.key), mName = metricName(m.key);
      var state = reading[m.rangeField];
      var prevRel = lastReliable(m.key, null);

      if (state === "above" || state === "below") {
        var n = 1;
        for (var i = history.length - 1; i >= 0; i--) {
          var r = history[i];
          if (r[m.key] == null) continue; // se saltan lecturas no confiables
          if (r[m.rangeField] === state) n++; else break;
        }
        if (n >= S.confirmReadings) { confirmedOut = true; reading.rangeConfirmed = true; } else pendingOut = true;
        if (n === S.confirmReadings) {
          var above = state === "above";
          var type = (m.kind === "temp" ? "TEMPERATURE_" : "HUMIDITY_") + (above ? "ABOVE_LIMIT" : "BELOW_LIMIT");
          var lim = above ? m.max : m.min;
          emit(type, "CRITICAL", m.key, v, lim, v - lim,
            name + ": " + mName + " " + num(v) + " " + unit + ", " + (above ? "por encima" : "por debajo") + " del límite configurado (" + num(lim) + " " + unit + ") durante " + n + " lecturas confiables consecutivas. Posible interrupción de condiciones: se requiere verificación física.");
        }
      } else if (state === "in" && prevRel && prevRel.rangeConfirmed && (prevRel[m.rangeField] === "above" || prevRel[m.rangeField] === "below")) {
        emit("RETURN_TO_RANGE", "INFO", m.key, v, prevRel[m.key], v - prevRel[m.key], name + ": " + mName + " regresó al rango configurado (" + num(v) + " " + unit + ").");
      }

      // cambio respecto a la lectura confiable anterior
      if (prevRel) {
        var d = v - prevRel[m.key];
        if (m.kind === "temp") reading.deltaTemp = round1(d); else reading.deltaHum = round1(d);
      }

      // cambio dentro de la ventana (≈ 1 h)
      var w = S.changeWindowMin * 60000, ref = null, bestDist = Infinity;
      history.forEach(function (r) {
        if (r[m.key] == null) return;
        var dist = Math.abs(now - r.ts - w);
        if (dist <= w * 0.25 && dist < bestDist) { bestDist = dist; ref = r; }
      });
      var prefix = m.kind === "temp" ? "TEMPERATURE_" : "HUMIDITY_";
      if (ref) {
        var dw = v - ref[m.key];
        if (Math.abs(dw) >= m.thr) {
          var t1 = prefix + (dw > 0 ? "INCREASE" : "DECREASE");
          if (cooled(t1, m.key)) emit(t1, "WARNING", m.key, v, ref[m.key], dw,
            "Posible evento ambiental: " + mName + " de " + name + " " + (dw > 0 ? "subió" : "bajó") + " " + num(Math.abs(dw)) + " " + unit + " en " + fmtDuration(now - ref.ts) + " (de " + num(ref[m.key]) + " a " + num(v) + " " + unit + ", " + fmtTime(ref.ts) + "–" + fmtTime(now) + "). Se requiere verificación física.");
        }
      }
      // cambio brusco entre lecturas consecutivas (ya confirmado por la validación)
      if (prevRel && now - prevRel.ts <= 3 * intervalMs + 1000) {
        var dc = v - prevRel[m.key];
        if (Math.abs(dc) >= m.thr) {
          var t2 = prefix + (dc > 0 ? "INCREASE" : "DECREASE");
          if (cooled(t2, m.key)) emit(t2, "WARNING", m.key, v, prevRel[m.key], dc,
            "Posible evento ambiental: cambio brusco de " + mName + " en " + name + " entre lecturas consecutivas (" + num(prevRel[m.key]) + " → " + num(v) + " " + unit + ", " + fmtTime(prevRel.ts) + "–" + fmtTime(now) + "). Se requiere verificación física.");
        }
      }
    });

    // ---- valores sin cambios / posible lectura congelada ----
    if (condition === "ok" && reading[cKey] != null && reading.humidity != null) {
      var streak = [reading];
      for (var j = history.length - 1; j >= 0; j--) {
        var h = history[j];
        if (h[cKey] === reading[cKey] && h.humidity === reading.humidity) streak.push(h);
        else break;
      }
      var same = streak.length;
      // El cambio de imagen de la lectura más antigua de la racha compara contra
      // un valor distinto: no cuenta para decidir si la imagen está congelada.
      var scores = streak.slice(0, -1).map(function (x) { return x.imageChangeScore; }).filter(function (x) { return x != null; });
      if (same === S.staleCycles) {
        var frozen = scores.length > 0 && scores.every(function (x) { return x < S.staleImageThreshold; });
        if (frozen) emit("POSSIBLE_STALE_READING", "WARNING", cKey, reading[cKey], null, 0,
          "Los valores de " + name + " (" + num(reading[cKey]) + " °C, " + num(reading.humidity, 0) + " %) no cambian desde hace " + same + " lecturas y la imagen está prácticamente idéntica. Posible lectura congelada (display o cámara detenidos). No se afirma que el sensor esté desconectado: se requiere verificación física.");
        else emit("READING_UNCHANGED", "INFO", cKey, reading[cKey], null, 0,
          name + ": valores estables durante " + same + " lecturas (" + num(reading[cKey]) + " °C, " + num(reading.humidity, 0) + " %); la imagen sí cambia, el display parece actualizarse.");
      }
    }

    // ---- estado ----
    var status = "NORMAL";
    if (condition === "camera_error") status = "CAMARA_DESCONECTADA";
    else if (condition === "not_detected" || condition === "blank") status = "SENSOR_NO_DETECTADO";
    else if (!isReliable(level)) status = "LECTURA_INCIERTA";
    else if (confirmedOut) status = "FUERA_DE_RANGO";
    else {
      var recentWarn = lastEv(CHANGE_TYPES.concat(["POSSIBLE_STALE_READING", "LOW_CONFIDENCE"]));
      var hasWarnNow = events.some(function (e) { return e.severity !== "INFO"; });
      if (pendingOut || hasWarnNow || (recentWarn && now - recentWarn.ts < S.eventCooldownMin * 60000)) status = "ATENCION";
    }
    reading.status = status;
    return { reading: reading, events: events };
  }

  /** Estado actual de un sensor considerando el tiempo transcurrido desde la última lectura. */
  function currentStatus(sensor, last, now, S) {
    if (!sensor.enabled) return { code: "SIN_DATOS", note: "Sensor desactivado" };
    if (!last) return { code: "SIN_DATOS", note: "Aún no hay lecturas" };
    var age = now - last.ts;
    if (age > (S.noDataCycles + 0.5) * S.intervalSec * 1000) return { code: "SIN_DATOS", note: "Sin lecturas desde " + fmtTime(last.ts) + " (" + fmtDuration(age) + ")" };
    return { code: last.status, note: "" };
  }

  // ─────────────────────────── estadística ───────────────────────────

  function describe(values) {
    var v = values.filter(function (x) { return x != null && isFinite(x); }).sort(function (a, b) { return a - b; });
    if (!v.length) return { n: 0, mean: null, sd: null, min: null, max: null, p5: null, median: null, p95: null };
    var n = v.length, mean = v.reduce(function (a, b) { return a + b; }, 0) / n;
    var sd = n > 1 ? Math.sqrt(v.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (n - 1)) : 0;
    var q = function (p) { var i = (n - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return v[lo] + (v[hi] - v[lo]) * (i - lo); };
    return { n: n, mean: mean, sd: sd, min: v[0], max: v[n - 1], p5: q(0.05), median: q(0.5), p95: q(0.95) };
  }

  /** Resumen diario por sensor (fecha local). */
  function dailySummary(readings, events, sensors) {
    var groups = {};
    readings.forEach(function (r) {
      var k = dayKey(r.ts) + "|" + r.sensorId;
      (groups[k] = groups[k] || { date: dayKey(r.ts), sensorId: r.sensorId, readings: [], events: [] }).readings.push(r);
    });
    events.forEach(function (e) {
      if (!e.sensorId) return;
      var k = dayKey(e.ts) + "|" + e.sensorId;
      (groups[k] = groups[k] || { date: dayKey(e.ts), sensorId: e.sensorId, readings: [], events: [] }).events.push(e);
    });
    var byId = {};
    sensors.forEach(function (s) { byId[s.id] = s; });
    return Object.keys(groups).sort().map(function (k) {
      var g = groups[k], s = byId[g.sensorId] || defaultSensor(g.sensorId), ck = controlKey(s);
      var t = describe(g.readings.map(function (r) { return r[ck]; })), h = describe(g.readings.map(function (r) { return r.humidity; }));
      return {
        date: g.date,
        sensorId: g.sensorId,
        sensorName: s.name,
        controlTemp: ck === "tempOut" ? "OUT" : "IN",
        minTemp: t.min, maxTemp: t.max, avgTemp: t.mean,
        minHum: h.min, maxHum: h.max, avgHum: h.mean,
        readings: g.readings.length,
        reliable: g.readings.filter(function (r) { return r[ck] != null; }).length,
        alerts: g.events.filter(function (e) { return e.severity !== "INFO"; }).length,
        ocrErrors: g.readings.filter(function (r) { return r.condition === "ok" && !isReliable(r.level); }).length,
        outOfRange: g.readings.filter(function (r) { return r.rangeConfirmed; }).length,
        changes: g.events.filter(function (e) { return CHANGE_TYPES.indexOf(e.type) >= 0; }).length,
        gaps: g.events.filter(function (e) { return e.type === "DATA_GAP"; }).length,
      };
    });
  }

  /** Estadísticas por sensor y variable para un conjunto de lecturas. */
  function statistics(readings, sensors) {
    var out = [];
    sensors.forEach(function (s) {
      var rs = readings.filter(function (r) { return r.sensorId === s.id; });
      ["tempIn", "tempOut", "humidity"].forEach(function (k) {
        var d = describe(rs.map(function (r) { return r[k]; }));
        var withRange = rs.filter(function (r) {
          var st = k === "humidity" ? r.humRange : k === controlKey(s) ? r.tempRange : null;
          return r[k] != null && (st === "in" || st === "above" || st === "below");
        });
        var inRange = withRange.filter(function (r) { return (k === "humidity" ? r.humRange : r.tempRange) === "in"; }).length;
        out.push({
          sensorId: s.id, sensorName: s.name, metric: k, unit: unitFor(k),
          total: rs.length, n: d.n, reliablePct: rs.length ? (100 * d.n) / rs.length : null,
          mean: d.mean, sd: d.sd, min: d.min, p5: d.p5, median: d.median, p95: d.p95, max: d.max,
          inRangePct: withRange.length ? (100 * inRange) / withRange.length : null,
        });
      });
    });
    return out;
  }

  /** Serie para gráficas: promedios por intervalo de los valores CONFIABLES. */
  function series(readings, sensorId, key, from, to, maxPoints) {
    var span = Math.max(1, to - from), bucket = Math.max(1, Math.ceil(span / (maxPoints || 600)));
    var acc = {};
    readings.forEach(function (r) {
      if (r.sensorId !== sensorId || r[key] == null || r.ts < from || r.ts > to) return;
      var b = Math.floor((r.ts - from) / bucket);
      var a = (acc[b] = acc[b] || { s: 0, n: 0, t: 0 });
      a.s += r[key]; a.n++; a.t += r.ts;
    });
    return Object.keys(acc).map(Number).sort(function (a, b) { return a - b; }).map(function (b) {
      return { t: Math.round(acc[b].t / acc[b].n), v: round1(acc[b].s / acc[b].n) };
    });
  }

  // ─────────────────────────── análisis de cambios ───────────────────────────

  function limitSentence(value, min, max, unit) {
    if (min == null && max == null) return " No hay límites configurados para comparar.";
    if (max != null && value > max) return " Este valor se encuentra por encima del límite configurado de " + num(max) + " " + unit + ".";
    if (min != null && value < min) return " Este valor se encuentra por debajo del límite configurado de " + num(min) + " " + unit + ".";
    return " El valor final está dentro de los límites configurados (" + (min != null ? num(min) : "sin mínimo") + " – " + (max != null ? num(max) : "sin máximo") + " " + unit + ").";
  }

  /** Episodios de cambio dentro de la ventana, no solapados, que superan el umbral. */
  function changeEpisodes(rel, key, windowMs, thr) {
    var cands = [];
    for (var j = 0; j < rel.length; j++) {
      for (var i = j - 1; i >= 0; i--) {
        var dt = rel[j].ts - rel[i].ts;
        if (dt > windowMs * 1.25) break;
        if (dt < windowMs * 0.25) continue;
        var d = rel[j][key] - rel[i][key];
        if (Math.abs(d) >= thr) cands.push({ i: i, j: j, d: d });
      }
    }
    cands.sort(function (a, b) { return Math.abs(b.d) - Math.abs(a.d); });
    var chosen = [];
    cands.forEach(function (c) {
      if (chosen.length >= 4) return;
      var a0 = rel[c.i].ts, a1 = rel[c.j].ts;
      if (chosen.some(function (x) { return !(a1 < rel[x.i].ts || a0 > rel[x.j].ts); })) return;
      chosen.push(c);
    });
    return chosen.sort(function (a, b) { return rel[a.i].ts - rel[b.i].ts; });
  }

  function trendOf(rel, key) {
    if (rel.length < 3) return null;
    var t0 = rel[0].ts, n = rel.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    rel.forEach(function (r) { var x = (r.ts - t0) / 3600000, y = r[key]; sx += x; sy += y; sxx += x * x; sxy += x * y; });
    var den = n * sxx - sx * sx;
    if (!den) return null;
    var slope = (n * sxy - sx * sy) / den, hours = (rel[n - 1].ts - t0) / 3600000;
    return { slopePerHour: slope, total: slope * hours, hours: hours };
  }

  /**
   * "¿Hubo cambios importantes hoy?": describe cambios bruscos, tendencias,
   * valores fuera de rango, periodos sin datos y lecturas sospechosas.
   * Devuelve { items: [{ sensorId, kind, severity, text }], text }.
   */
  function changesReport(readings, events, sensors, S, from, to) {
    var items = [];
    sensors.forEach(function (s) {
      if (!s.enabled) return;
      var rs = readings.filter(function (r) { return r.sensorId === s.id && r.ts >= from && r.ts <= to; }).sort(function (a, b) { return a.ts - b.ts; });
      var evs = events.filter(function (e) { return e.sensorId === s.id && e.ts >= from && e.ts <= to; });
      if (!rs.length) {
        items.push({ sensorId: s.id, kind: "nodata", severity: "WARNING", text: s.name + ": no hay lecturas en el periodo analizado." });
        return;
      }
      [{ key: controlKey(s), min: s.tempMin, max: s.tempMax, thr: S.tempChangeThreshold, range: "tempRange" },
       { key: "humidity", min: s.humMin, max: s.humMax, thr: S.humidityChangeThreshold, range: "humRange" }].forEach(function (m) {
        var unit = unitFor(m.key), mName = metricName(m.key);
        var rel = rs.filter(function (r) { return r[m.key] != null; });
        if (!rel.length) return;
        changeEpisodes(rel, m.key, S.changeWindowMin * 60000, m.thr).forEach(function (c) {
          var a = rel[c.i], b = rel[c.j];
          items.push({
            sensorId: s.id, kind: "change", severity: "WARNING",
            text: "Se detectó " + (c.d < 0 ? "una disminución" : "un aumento") + " de " + num(Math.abs(c.d)) + " " + unit + " entre " + fmtTime(a.ts) + " y " + fmtTime(b.ts) + " en " + s.name + " (" + mName + "). El valor pasó de " + num(a[m.key]) + " " + unit + " a " + num(b[m.key]) + " " + unit + "." + limitSentence(b[m.key], m.min, m.max, unit),
          });
        });
        var tr = trendOf(rel, m.key);
        if (tr && Math.abs(tr.total) >= m.thr && tr.hours >= 2) {
          items.push({
            sensorId: s.id, kind: "trend", severity: "INFO",
            text: "Tendencia en " + s.name + ": la " + mName + " " + (tr.total > 0 ? "aumentó" : "disminuyó") + " de forma sostenida (" + signed(tr.slopePerHour, 2) + " " + unit + "/h durante " + fmtDuration(tr.hours * 3600000) + ").",
          });
        }
        // periodos fuera de rango (lecturas confiables consecutivas confirmadas)
        var period = null;
        var flush = function () {
          if (!period) return;
          if (!period.confirmed) { period = null; return; } // no confirmado por lecturas consecutivas
          items.push({
            sensorId: s.id, kind: "out_of_range", severity: "CRITICAL",
            text: s.name + ": " + mName + " fuera del rango configurado (" + (period.state === "above" ? "por encima de " + num(m.max) : "por debajo de " + num(m.min)) + " " + unit + ") entre " + fmtTime(period.start) + " y " + fmtTime(period.end) + "; valor extremo " + num(period.extreme) + " " + unit + ".",
          });
          period = null;
        };
        rel.forEach(function (r) {
          var st = r[m.range];
          if (st === "above" || st === "below") {
            if (period && period.state === st) {
              period.end = r.ts;
              period.extreme = st === "above" ? Math.max(period.extreme, r[m.key]) : Math.min(period.extreme, r[m.key]);
              if (r.rangeConfirmed) period.confirmed = true;
            } else { flush(); period = { state: st, start: r.ts, end: r.ts, extreme: r[m.key], confirmed: !!r.rangeConfirmed }; }
          } else flush();
        });
        flush();
      });
      // periodos sin datos
      var gapMs = (S.noDataCycles + 0.5) * S.intervalSec * 1000;
      for (var i = 1; i < rs.length; i++) {
        var dt = rs[i].ts - rs[i - 1].ts;
        if (dt > gapMs) items.push({ sensorId: s.id, kind: "gap", severity: "WARNING", text: s.name + ": sin lecturas entre " + fmtTime(rs[i - 1].ts) + " y " + fmtTime(rs[i].ts) + " (" + fmtDuration(dt) + ")." });
      }
      // lecturas sospechosas y problemas de captura
      var uncertain = rs.filter(function (r) { return r.condition === "ok" && !isReliable(r.level); }).length;
      var corrections = evs.filter(function (e) { return e.type === "OCR_CORRECTION"; }).length;
      var camera = rs.filter(function (r) { return r.condition === "camera_error"; }).length;
      var notDet = rs.filter(function (r) { return r.condition === "not_detected" || r.condition === "blank"; }).length;
      var stale = evs.filter(function (e) { return e.type === "POSSIBLE_STALE_READING"; }).length;
      if (uncertain) items.push({ sensorId: s.id, kind: "uncertain", severity: "INFO", text: s.name + ": " + uncertain + " lectura(s) inciertas o de confianza baja (no se usaron como dato confiable)" + (corrections ? "; " + corrections + " corrección(es) de OCR registradas" : "") + "." });
      if (camera) items.push({ sensorId: s.id, kind: "camera", severity: "WARNING", text: s.name + ": " + camera + " ciclo(s) sin imagen de cámara." });
      if (notDet) items.push({ sensorId: s.id, kind: "not_detected", severity: "WARNING", text: s.name + ": " + notDet + " ciclo(s) con sensor no detectado o display ilegible (posible sensor movido, cubierto o apagado)." });
      if (stale) items.push({ sensorId: s.id, kind: "stale", severity: "WARNING", text: s.name + ": " + stale + " aviso(s) de posible lectura congelada (valores e imagen sin cambios)." });
    });

    var notable = items.filter(function (i) { return i.kind !== "trend" && i.kind !== "uncertain"; });
    var head = notable.length
      ? "Sí se registraron cambios o situaciones que requieren revisión:"
      : "No se detectaron cambios que superen los umbrales configurados (±" + S.tempChangeThreshold + " °C / ±" + S.humidityChangeThreshold + " %HR en " + S.changeWindowMin + " min), ni valores fuera de rango ni periodos sin datos.";
    var text = head + (items.length ? "\n\n" + items.map(function (i) { return "• " + i.text; }).join("\n") : "") +
      "\n\nEste análisis describe las lecturas registradas; no establece causas (por ejemplo, cortes de energía o fallas de equipos) ni efectos sobre los grillos. Los eventos requieren verificación física.";
    return { items: items, text: text, hasNotable: notable.length > 0 };
  }

  /** Reporte diario en Markdown. */
  function dailyReport(dateKey, readings, events, sensors, S) {
    var b = dayBounds(dateKey);
    var rs = readings.filter(function (r) { return r.ts >= b.from && r.ts <= b.to; });
    var evs = events.filter(function (e) { return e.ts >= b.from && e.ts <= b.to; });
    var summary = dailySummary(rs, evs, sensors);
    var ch = changesReport(rs, evs, sensors, S, b.from, b.to);
    var simulated = rs.some(function (r) { return r.source === "simulation"; });
    var lines = [];
    lines.push("# Reporte ambiental diario — " + dateKey, "");
    if (simulated) lines.push("> ⚠ Este periodo incluye DATOS SIMULADOS (modo simulación). No corresponden a mediciones reales.", "");
    lines.push("Sensores monitoreados: " + sensors.filter(function (s) { return s.enabled; }).map(function (s) { return s.name + " (temperatura de control: " + (s.controlTemp === "out" ? "OUT" : "IN") + ")"; }).join(", ") + ".", "");
    lines.push("| Indicador | " + summary.map(function (x) { return x.sensorName; }).join(" | ") + " |");
    lines.push("|---|" + summary.map(function () { return "---"; }).join("|") + "|");
    var row = function (label, fn) { lines.push("| " + label + " | " + summary.map(fn).join(" | ") + " |"); };
    row("Número de lecturas", function (x) { return x.readings; });
    row("Lecturas confiables", function (x) { return x.reliable; });
    row("Temperatura mínima (°C)", function (x) { return num(x.minTemp); });
    row("Temperatura máxima (°C)", function (x) { return num(x.maxTemp); });
    row("Temperatura promedio (°C)", function (x) { return num(x.avgTemp); });
    row("Humedad mínima (%)", function (x) { return num(x.minHum, 0); });
    row("Humedad máxima (%)", function (x) { return num(x.maxHum, 0); });
    row("Humedad promedio (%)", function (x) { return num(x.avgHum, 1); });
    row("Cambios relevantes", function (x) { return x.changes; });
    row("Lecturas fuera de rango", function (x) { return x.outOfRange; });
    row("Errores / dudas de OCR", function (x) { return x.ocrErrors; });
    row("Periodos sin lectura", function (x) { return x.gaps; });
    lines.push("");
    lines.push("## Límites configurados", "");
    sensors.forEach(function (s) {
      var t = s.tempMin == null && s.tempMax == null ? "sin límites configurados" : (s.tempMin != null ? num(s.tempMin) : "—") + " a " + (s.tempMax != null ? num(s.tempMax) : "—") + " °C";
      var h = s.humMin == null && s.humMax == null ? "sin límites configurados" : (s.humMin != null ? num(s.humMin, 0) : "—") + " a " + (s.humMax != null ? num(s.humMax, 0) : "—") + " %";
      lines.push("- " + s.name + ": temperatura " + t + "; humedad " + h + ".");
    });
    lines.push("", "## Análisis de cambios", "", ch.text, "");
    lines.push("## Eventos detectados", "");
    var shown = evs.filter(function (e) { return e.type !== "READING_UNCHANGED"; }).sort(function (a, b) { return a.ts - b.ts; });
    if (!shown.length) lines.push("Sin eventos.");
    shown.slice(0, 80).forEach(function (e) {
      var s = sensors.filter(function (x) { return x.id === e.sensorId; })[0];
      lines.push("- " + fmtTime(e.ts) + " · " + e.severity + " · " + (s ? s.name : "—") + " · " + (EVENT_LABELS[e.type] || e.type) + ": " + e.description);
    });
    if (shown.length > 80) lines.push("- … y " + (shown.length - 80) + " eventos más (ver hoja EVENTS del Excel).");
    lines.push("", "## Conclusión", "");
    var total = rs.length, reliable = summary.reduce(function (a, x) { return a + x.reliable; }, 0);
    var mins = summary.map(function (x) { return x.minTemp; }).filter(function (v) { return v != null; });
    var maxs = summary.map(function (x) { return x.maxTemp; }).filter(function (v) { return v != null; });
    var changes = summary.reduce(function (a, x) { return a + x.changes; }, 0), outR = summary.reduce(function (a, x) { return a + x.outOfRange; }, 0);
    var noLimits = sensors.every(function (s) { return s.tempMin == null && s.tempMax == null && s.humMin == null && s.humMax == null; });
    lines.push(
      "Durante el período monitoreado se registraron " + total + " lecturas (" + reliable + " confiables). " +
      (mins.length ? "La temperatura presentó un rango de " + num(Math.min.apply(null, mins)) + " a " + num(Math.max.apply(null, maxs)) + " °C. " : "No hubo lecturas de temperatura confiables. ") +
      "Se detectaron " + changes + " eventos de cambio y " + outR + " lecturas fuera de los límites configurados." +
      (noLimits ? " No hay límites de producción configurados, por lo que no se evaluó el cumplimiento de rangos." : ""),
      "",
      "_Este reporte describe las lecturas registradas por cámara + OCR. No emite diagnósticos biológicos ni afirma que una variación afectó a los grillos; los eventos requieren verificación física._",
      "",
      "Generado: " + fmtDateTime(Date.now()),
    );
    return lines.join("\n");
  }

  // ─────────────────────────── simulación ───────────────────────────

  /**
   * Simulador de valores ambientales (modo SIMULACIÓN). Genera temperatura y
   * humedad con variación diaria, ruido y anomalías activables. Los valores son
   * ficticios: se marcan como source = "simulation" en todo el sistema.
   */
  function createSimulator(seed) {
    var rand = (root.MonSeg && root.MonSeg.rng ? root.MonSeg.rng : fallbackRng)(seed || 42);
    var state = {
      A: { base: 30.5, off: 0.4, hum: 66 },
      B: { base: 29.2, off: 0.3, hum: 71 },
    };
    function valuesAt(sensorId, ms, anomalies) {
      anomalies = anomalies || {};
      var st = state[sensorId] || state.A, d = new Date(ms);
      var hour = d.getHours() + d.getMinutes() / 60;
      var diurnal = Math.sin(((hour - 9) / 24) * 2 * Math.PI) * 1.2;
      var t = st.base + diurnal + (rand() - 0.5) * 0.3;
      if (anomalies.drop) t -= anomalies.dropAmount == null ? 3.5 : anomalies.dropAmount;
      if (anomalies.rise) t += anomalies.riseAmount == null ? 3 : anomalies.riseAmount;
      var h = st.hum - diurnal * 3 + (rand() - 0.5) * 1.5 + (anomalies.humidityJump || 0);
      if (anomalies.freeze && st.frozen) return st.frozen;
      var v = {
        tempIn: round1(t),
        tempOut: round1(t - st.off + (rand() - 0.5) * 0.2),
        humidity: Math.max(1, Math.min(99, Math.round(h))),
        time: d.getHours() + ":" + pad2(d.getMinutes()),
      };
      st.frozen = v;
      return v;
    }
    return { valuesAt: valuesAt, rand: rand };
  }
  function fallbackRng(seed) { var x = seed || 1; return function () { x = (x * 16807) % 2147483647; return (x - 1) / 2147483646; }; }

  function toText(v, decimals) { return v == null ? "" : decimals ? Number(v).toFixed(decimals) : String(Math.round(v)); }

  /**
   * Genera un histórico simulado de `hours` horas hasta `now` pasando por el
   * mismo `processCycle` que las lecturas reales (validación + eventos).
   * Incluye: caída brusca de temperatura, periodo sin datos, errores de OCR,
   * falla de cámara y valores congelados. Devuelve { readings, events }.
   */
  function simulateHistory(opts) {
    var S = opts.settings, sensors = opts.sensors.filter(function (s) { return s.enabled; }), now = opts.now;
    var hours = Math.max(1, Math.min(24 * 30, opts.hours || 24));
    var step = Math.max(S.intervalSec * 1000, Math.ceil((hours * 3600000) / 1500));
    var start = now - hours * 3600000;
    var sim = createSimulator(opts.seed || 11), rand = sim.rand;
    var S2 = Object.assign({}, S, { intervalSec: Math.round(step / 1000) });
    var readings = [], events = [], hist = {}, evHist = {};
    var at = function (frac) { return start + frac * hours * 3600000; };
    var dropFrom = at(0.62), dropTo = at(0.62) + Math.min(2, hours * 0.08) * 3600000;
    var gapFrom = at(0.3), gapTo = at(0.3) + Math.max(step * 5, Math.min(45 * 60000, hours * 0.03 * 3600000));
    var camFrom = at(0.45), camTo = at(0.45) + step * 3;
    var frzFrom = at(0.8), frzTo = at(0.8) + step * (S.staleCycles + 2);
    sensors.forEach(function (s) { hist[s.id] = []; evHist[s.id] = []; });

    for (var t = start; t <= now; t += step) {
      if (t >= gapFrom && t < gapTo) continue;
      sensors.forEach(function (s) {
        var anomalies = {};
        if (s.id === "A" && t >= dropFrom && t < dropTo) anomalies.drop = true;
        if (s.id === "B" && t >= frzFrom && t < frzTo) anomalies.freeze = true;
        var v = sim.valuesAt(s.id, t, anomalies);
        var capture;
        if (t >= camFrom && t < camTo) capture = { captureStatus: "camera_error", fields: {}, error: "simulación: cámara sin señal" };
        else {
          var fields = {};
          FIELD_KEYS.forEach(function (k) {
            var roi = s.calibration.fields[k];
            if (!roi || !roi.enabled) return;
            var txt = k === "time" ? v.time : toText(v[k], roi.decimals);
            var conf = 88 + rand() * 11;
            var r = rand();
            if (r < 0.015) { txt = txt.replace(/\d/, "?"); conf = 20; }
            else if (r < 0.025) conf = 55 + rand() * 10;
            fields[k] = { text: txt, confidence: round1(conf) };
          });
          var frozen = anomalies.freeze;
          capture = { captureStatus: "ok", fields: fields, contrast: 55 + rand() * 8, imageChangeScore: frozen ? 0.1 : 0.8 + rand() * 2, referenceDiffScore: 8 + rand() * 6 };
        }
        var out = processCycle({ now: t, settings: S2, sensor: s, capture: capture, source: "simulation", history: hist[s.id].slice(-400), recentEvents: evHist[s.id] });
        hist[s.id].push(out.reading);
        out.events.forEach(function (e) { evHist[s.id].push(e); });
        readings.push(out.reading);
        events.push.apply(events, out.events);
      });
    }
    return { readings: readings, events: events, stepSec: step / 1000 };
  }

  /**
   * Resumen compacto para la página de seguimiento (panel): último valor, hoy y
   * promedios por hora de las últimas 24 h, más las alertas recientes. Solo números
   * y textos de eventos: nunca imágenes. Las lecturas de simulación se marcan.
   * readings/events: últimas ~24 h (o más); now: ms.
   */
  function buildSummary(readings, events, sensors, S, now) {
    var r = function (v, d) { return v == null || !isFinite(v) ? null : Math.round(v * Math.pow(10, d)) / Math.pow(10, d); };
    var stat = function (vals, d) { var x = describe(vals); return x.n ? { min: r(x.min, d), max: r(x.max, d), mean: r(x.mean, d), n: x.n } : null; };
    var dayStart = dayBounds(dayKey(now)).from, from24 = now - 24 * 3600000;
    return {
      version: 1,
      generatedAt: now,
      intervalSec: S.intervalSec,
      sensors: sensors.map(function (s) {
        var ck = controlKey(s);
        var mine = readings.filter(function (x) { return x.sensorId === s.id; }).sort(function (a, b) { return a.ts - b.ts; });
        var last = mine.length ? mine[mine.length - 1] : null;
        var today = mine.filter(function (x) { return x.ts >= dayStart; });
        var hourly = [];
        for (var h = 23; h >= 0; h--) {
          var h0 = Math.floor((now - h * 3600000) / 3600000) * 3600000;
          var inH = mine.filter(function (x) { return x.ts >= h0 && x.ts < h0 + 3600000; });
          if (!inH.length) continue;
          var c = describe(inH.map(function (x) { return x[ck]; })), hu = describe(inH.map(function (x) { return x.humidity; }));
          hourly.push({ ts: h0, control: r(c.mean, 1), humidity: r(hu.mean, 0), n: inH.length });
        }
        var st = currentStatus(s, last, now, S);
        return {
          id: s.id, name: s.name, enabled: !!s.enabled,
          control: ck === "tempOut" ? "OUT" : "IN",
          status: st.code, statusLabel: STATUS_LABELS[st.code] || st.code, note: st.note || "",
          last: last ? { ts: last.ts, tempIn: r(last.tempIn, 1), tempOut: r(last.tempOut, 1), humidity: r(last.humidity, 0), confidence: r(last.confidence, 0), level: last.level, source: last.source } : null,
          today: { readings: today.length, control: stat(today.map(function (x) { return x[ck]; }), 1), humidity: stat(today.map(function (x) { return x.humidity; }), 0) },
          limits: { tempMin: s.tempMin, tempMax: s.tempMax, humMin: s.humMin, humMax: s.humMax },
          hourly: hourly,
        };
      }),
      alerts: events.filter(function (e) { return e.severity !== "INFO" && e.ts >= from24; }).sort(function (a, b) { return b.ts - a.ts; }).slice(0, 15).map(function (e) {
        return { ts: e.ts, sensorId: e.sensorId, type: e.type, label: EVENT_LABELS[e.type] || e.type, severity: e.severity, description: e.description, ack: !!e.ack, source: e.source };
      }),
      openAlerts: events.filter(function (e) { return e.severity !== "INFO" && !e.ack; }).length,
      simulation: readings.some(function (x) { return x.ts >= from24 && x.source !== "camera"; }),
    };
  }

  // ─────────────────────────── «Qué hacer ahora» ───────────────────────────
  //
  // Convierte el estado actual en acciones concretas y priorizadas. Usa SOLO los
  // límites que la persona configuró (Sensores) y los perfiles térmicos que definió
  // (Control térmico); no inventa rangos para los grillos. Las causas se dicen como
  // posibilidades a revisar, nunca como hechos («no se sabe si fue un corte de luz»).

  /** Pendiente (°C o % por minuto) por mínimos cuadrados de [{ts, v}] (null si hay pocos puntos). */
  function slopePerMin(points) {
    var p = points.filter(function (x) { return x.v != null && isFinite(x.v); });
    if (p.length < 3) return null;
    var t0 = p[0].ts, n = p.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    p.forEach(function (q) { var x = (q.ts - t0) / 60000; sx += x; sy += q.v; sxx += x * x; sxy += x * q.v; });
    var den = n * sxx - sx * sx;
    return den ? (n * sxy - sx * sy) / den : null;
  }

  /** Minutos de hoy fuera de los límites configurados (temperatura de control y humedad). */
  function minutesOutOfRange(readings, sensor, now, S) {
    var ck = controlKey(sensor), mine = readings.filter(function (r) { return r.sensorId === sensor.id; }).sort(function (a, b) { return a.ts - b.ts; });
    var out = { tempHigh: 0, tempLow: 0, humHigh: 0, humLow: 0, covered: 0 };
    var maxGap = (S.intervalSec || 60) * 1000 * 2.5;
    for (var i = 0; i < mine.length; i++) {
      var r = mine[i], next = i + 1 < mine.length ? mine[i + 1].ts : Math.min(now, r.ts + (S.intervalSec || 60) * 1000);
      var dt = Math.min(next - r.ts, maxGap) / 60000;
      if (dt <= 0) continue;
      out.covered += dt;
      var t = r[ck], h = r.humidity;
      if (t != null && sensor.tempMax != null && t > sensor.tempMax) out.tempHigh += dt;
      if (t != null && sensor.tempMin != null && t < sensor.tempMin) out.tempLow += dt;
      if (h != null && sensor.humMax != null && h > sensor.humMax) out.humHigh += dt;
      if (h != null && sensor.humMin != null && h < sensor.humMin) out.humLow += dt;
    }
    Object.keys(out).forEach(function (k) { out[k] = Math.round(out[k]); });
    return out;
  }

  /**
   * ctx: { sensors, readings (≈ últimas 3 h, todas), events (≈ 24 h), thermal (estado del
   * gateway o null), running, now, settings }
   * @returns [{ level: "crit"|"warn"|"info"|"good", title, action, sensorId?, kind: "manejo"|"accidente"|"sistema" }]
   */
  function actionItems(ctx) {
    var S = ctx.settings, now = ctx.now, items = [];
    var push = function (level, kind, title, action, sensorId) { items.push({ level: level, kind: kind, title: title, action: action, sensorId: sensorId || null }); };
    var unit = function (k) { return k === "humidity" ? " %" : " °C"; };
    (ctx.sensors || []).filter(function (s) { return s.enabled; }).forEach(function (s) {
      var ck = controlKey(s), lbl = ck === "tempOut" ? "temp. de la caja (OUT)" : "temp. (IN)";
      var mine = (ctx.readings || []).filter(function (r) { return r.sensorId === s.id; }).sort(function (a, b) { return a.ts - b.ts; });
      var last = mine.length ? mine[mine.length - 1] : null;
      var st = currentStatus(s, last, now, S);
      if (st.code === "SIN_DATOS") {
        if (ctx.running || last) push(ctx.running ? "crit" : "info", "sistema", s.name + ": no llegan lecturas" + (last ? " desde " + fmtTime(last.ts) : ""),
          ctx.running ? "Revisa que la cámara esté activa, que la ventana de la app siga abierta y que nada tape el sensor. (La app no sabe la causa: no afirma que haya sido un corte de luz.)" : "El monitoreo está detenido: toca ▶ Iniciar monitoreo.", s.id);
        return;
      }
      var recent = mine.slice(-3);
      if (recent.length && recent.every(function (r) { return !isReliable(r.level); })) {
        push("warn", "sistema", s.name + ": la app no está leyendo bien los números", "Ve a Calibración, escribe lo que muestra el sensor y toca «Ajustar a estos valores». Revisa también reflejos de luz sobre la pantalla del sensor.", s.id);
      }
      if (s.tempMin == null && s.tempMax == null && s.humMin == null && s.humMax == null) {
        push("info", "manejo", s.name + ": sin límites configurados", "Pon tus límites de temperatura y humedad en Sensores; sin ellos la app no puede avisarte cuando algo se sale de lo que necesitas.", s.id);
      }
      var t = last && last[ck], h = last && last.humidity;
      if (t != null && s.tempMax != null && t > s.tempMax) push("crit", "manejo", s.name + ": " + lbl + " en " + num(t) + " °C, sobre tu máximo (" + num(s.tempMax) + " °C)", "Revisa si la lámpara quedó encendida de más, la ventilación y si la caja recibe sol directo.", s.id);
      else if (t != null && s.tempMin != null && t < s.tempMin) push("crit", "manejo", s.name + ": " + lbl + " en " + num(t) + " °C, bajo tu mínimo (" + num(s.tempMin) + " °C)", "Revisa que la lámpara encienda, que el enchufe tenga corriente y que la caja esté cerrada.", s.id);
      if (h != null && s.humMax != null && h > s.humMax) push("warn", "manejo", s.name + ": humedad " + num(h, 0) + " %, sobre tu máximo (" + num(s.humMax, 0) + " %)", "Revisa la ventilación, si hay condensación y si se regó agua o alimento húmedo.", s.id);
      else if (h != null && s.humMin != null && h < s.humMin) push("warn", "manejo", s.name + ": humedad " + num(h, 0) + " %, bajo tu mínimo (" + num(s.humMin, 0) + " %)", "Revisa la fuente de agua/humedad de la caja.", s.id);
      // tendencia: ¿llegará pronto al límite? (última hora)
      var hour = mine.filter(function (r) { return r.ts >= now - 3600000 && isReliable(r.level); });
      var sl = slopePerMin(hour.map(function (r) { return { ts: r.ts, v: r[ck] }; }));
      if (sl != null && t != null) {
        if (s.tempMax != null && t <= s.tempMax && sl > 0.02) {
          var mins = (s.tempMax - t) / sl;
          if (mins <= 60) push("warn", "manejo", s.name + ": la temperatura sube " + num(sl * 60) + " °C/h; llegaría a tu máximo en ~" + Math.max(1, Math.round(mins)) + " min", "Anticípate: revisa la lámpara y la ventilación antes de que pase el límite.", s.id);
        }
        if (s.tempMin != null && t >= s.tempMin && sl < -0.02) {
          var mins2 = (t - s.tempMin) / -sl;
          if (mins2 <= 60) push("warn", "manejo", s.name + ": la temperatura baja " + num(-sl * 60) + " °C/h; llegaría a tu mínimo en ~" + Math.max(1, Math.round(mins2)) + " min", "Anticípate: revisa que la lámpara encienda y que la caja esté cerrada.", s.id);
        }
      }
      var evs = (ctx.events || []).filter(function (e) { return e.sensorId === s.id && !e.ack && e.ts >= now - 2 * 3600000; });
      if (evs.some(function (e) { return e.type === "POSSIBLE_STALE_READING" || e.type === "READING_UNCHANGED"; })) push("warn", "sistema", s.name + ": la lectura no cambia hace rato", "¿La pantalla del sensor está congelada o con pila baja? Mírala directamente.", s.id);
      var jumps = evs.filter(function (e) { return CHANGE_TYPES.indexOf(e.type) >= 0 && e.severity !== "INFO"; });
      if (jumps.length) push("warn", "manejo", s.name + ": " + (EVENT_LABELS[jumps[jumps.length - 1].type] || "cambio brusco").toLowerCase() + " (" + fmtTime(jumps[jumps.length - 1].ts) + ")", "¿Se abrió la caja, se movió la lámpara o cambió la ventilación? Cuando lo revises, reconócela en Alertas.", s.id);
    });
    // diferencia entre cajas (dato para decidir, sin juicio)
    var lastOf = function (s) { var m = (ctx.readings || []).filter(function (r) { return r.sensorId === s.id && isReliable(r.level); }); return m.length ? m[m.length - 1] : null; };
    var en = (ctx.sensors || []).filter(function (s) { return s.enabled; });
    if (en.length === 2) {
      var a = lastOf(en[0]), b = lastOf(en[1]), ka = controlKey(en[0]), kb = controlKey(en[1]);
      if (a && b && a[ka] != null && b[kb] != null && Math.abs(a[ka] - b[kb]) >= 3) push("info", "manejo", "Las cajas difieren " + num(Math.abs(a[ka] - b[kb])) + " °C (" + en[0].name + " " + num(a[ka]) + " · " + en[1].name + " " + num(b[kb]) + ")", "Si deberían estar iguales (mismo perfil), revisa la lámpara y la ventilación de la más alejada de su objetivo.");
    }
    // control térmico (lámparas)
    ((ctx.thermal && ctx.thermal.boxes) || []).filter(function (bx) { return bx.enabled; }).forEach(function (bx) {
      var stt = bx.state || {}, out = bx.reading ? bx.reading.out : null, prof = bx.profile || {};
      if (stt.safety) push("crit", "accidente", bx.name + ": apagado de seguridad por sobrecalentamiento", "La lámpara se apagó sola. Revisa la caja (ventilación, sol directo, otra fuente de calor). Volverá a encender cuando baje a la temperatura de recuperación.");
      if (bx.device === "UNREACHABLE" || stt.heater === "UNREACHABLE") push("crit", "accidente", bx.name + ": sin comunicación con el enchufe", "La lámpara podría quedar como estaba. Revisa que el enchufe tenga corriente y Wi-Fi.");
      if (bx.mode === "MANUAL_ON") push("warn", "accidente", bx.name + ": lámpara en MANUAL encendida", "No se apaga sola por temperatura (sí por seguridad). Vuelve a AUTO cuando termines.");
      var boxRead = (ctx.readings || []).filter(function (r) { return r.sensorId === bx.sensorId && r.ts >= now - 45 * 60000 && isReliable(r.level); });
      var sl2 = slopePerMin(boxRead.map(function (r) { return { ts: r.ts, v: r.tempOut }; }));
      if (stt.heater === "ON" && stt.onSince && now - stt.onSince > 45 * 60000 && sl2 != null && sl2 <= 0 && prof.onAt != null && out != null && out < prof.onAt)
        push("warn", "accidente", bx.name + ": la lámpara lleva " + Math.round((now - stt.onSince) / 60000) + " min encendida y la caja no se calienta", "¿Bombillo quemado, lámpara desconectada o caja abierta? Revísala.");
      if ((stt.heater === "OFF" || bx.mode === "MANUAL_OFF") && sl2 != null && sl2 > 0.03 && prof.offAt != null && out != null && out > prof.offAt)
        push("crit", "accidente", bx.name + ": la caja se calienta con la lámpara apagada (" + num(sl2 * 60) + " °C/h)", "Hay otra fuente de calor: sol directo, otra lámpara o un equipo cerca. Revísala ya.");
    });
    var order = { crit: 0, warn: 1, info: 2, good: 3 };
    items.sort(function (x, y) { return order[x.level] - order[y.level]; });
    if (!items.some(function (i) { return i.level === "crit" || i.level === "warn"; })) items.unshift({ level: "good", kind: "sistema", title: "Todo en orden", action: "No hay nada urgente que revisar. La app sigue vigilando.", sensorId: null });
    return items;
  }

  root.MonLogic = {
    actionItems: actionItems,
    minutesOutOfRange: minutesOutOfRange,
    slopePerMin: slopePerMin,
    buildSummary: buildSummary,
    FIELD_KEYS: FIELD_KEYS,
    FIELD_LABELS: FIELD_LABELS,
    LEVEL_LABELS: LEVEL_LABELS,
    STATUS_LABELS: STATUS_LABELS,
    EVENT_LABELS: EVENT_LABELS,
    CHANGE_TYPES: CHANGE_TYPES,
    INTERVAL_OPTIONS: INTERVAL_OPTIONS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    validateSettings: validateSettings,
    validateSensorLimits: validateSensorLimits,
    defaultCalibration: defaultCalibration,
    HTC2_FIELDS: HTC2_FIELDS,
    OLD_FIELDS_JSON: OLD_FIELDS_JSON,
    defaultSensor: defaultSensor,
    levelFor: levelFor,
    isReliable: isReliable,
    validateField: validateField,
    rangeOf: rangeOf,
    processCycle: processCycle,
    currentStatus: currentStatus,
    describe: describe,
    dailySummary: dailySummary,
    statistics: statistics,
    series: series,
    changesReport: changesReport,
    dailyReport: dailyReport,
    createSimulator: createSimulator,
    simulateHistory: simulateHistory,
    controlKey: controlKey,
    metricName: metricName,
    unitFor: unitFor,
    fmtTime: fmtTime,
    fmtDateTime: fmtDateTime,
    fmtDuration: fmtDuration,
    dayKey: dayKey,
    dayBounds: dayBounds,
    num: num,
    signed: signed,
    uid: uid,
  };
})(typeof self !== "undefined" ? self : globalThis);
