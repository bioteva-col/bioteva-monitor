/*
 * BioTeva — motor de control térmico (termostato) para cajas de grillos.
 *
 * Mismo código en el navegador (simulador, análisis) y en el gateway local que
 * acciona los enchufes TP-Link HS105 (scripts/heater-gateway.mjs).
 *
 * Principios:
 *  - La variable de control es la TEMPERATURA DE CAJA = OUT (sonda dentro de la
 *    caja). IN es la temperatura ambiente y NO enciende ni apaga la lámpara.
 *  - Todos los valores biológicos son PARÁMETROS INICIALES DE PRODUCCIÓN,
 *    editables; no son límites biológicos absolutos.
 *  - Histéresis (no encender/apagar alrededor de un solo punto), tiempos de
 *    confirmación, intervalo mínimo entre conmutaciones, apagado de seguridad
 *    con su propia histéresis de recuperación, y estrategia ante falla del sensor.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MonThermal = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  var SPECIES = { scientific: "Acheta domesticus", common: "Grillo doméstico (house cricket)" };

  /**
   * Fuentes de los parámetros iniciales (resumen; ver docs/CONTROL-TERMICO.md).
   * Ninguno se presenta como límite biológico absoluto.
   */
  var SOURCES = [
    "Insects 2023, 14(7):588 — temperatura y densidad en supervivencia y crecimiento de A. domesticus: 30 °C produjo más biomasa que 25 °C; 35 °C subóptimo para producción.",
    "Animals 2024, 14(15):2176 — incubación de huevos de A. domesticus: mejor desempeño estudiado alrededor de 30 °C y 65–75 % HR.",
    "J. Insect Physiology (2007) — temperatura y energética del desarrollo de A. domesticus: desarrollo más lento a 25 °C que a 28 °C.",
    "Revisiones de producción: rango práctico habitual ~28–30 °C (≈ 30 ± 2 °C).",
  ];

  /** Perfiles por etapa (las de los grillos son ninfas, no larvas: metamorfosis incompleta). */
  function defaultProfiles() {
    return [
      { id: "huevos", name: "Huevos / incubación", target: 30, min: 29, max: 31, onAt: 29.5, offAt: 30.5, warn: 32, critical: 33, recovery: 30.5, humMin: 65, humMax: 75 },
      { id: "ninfas", name: "Ninfas (juveniles) / crecimiento", target: 30, min: 28, max: 32, onAt: 29, offAt: 31, warn: 32.5, critical: 33, recovery: 30.5, humMin: null, humMax: null },
      { id: "adultos", name: "Adultos / reproducción", target: 30, min: 28, max: 32, onAt: 29, offAt: 31, warn: 32.5, critical: 33, recovery: 30.5, humMin: null, humMax: null },
    ];
  }

  function defaultControl() {
    return {
      highConfirmSec: 30, // OUT ≥ apagado durante 30 s → apagar
      lowConfirmSec: 60, // OUT ≤ encendido durante 60 s → encender
      minSwitchSec: 120, // no conmutar más seguido que esto (salvo seguridad o manual)
      sensorTimeoutSec: 180, // sin lectura de caja nueva en 3 min → SENSOR_ERROR
      frozenMaxMin: 30, // mismo valor exacto durante 30 min → lectura congelada
      plausibleMin: 0,
      plausibleMax: 50,
      sensorErrorStrategy: "off", // off | keep | duty
      dutyOnMin: 5,
      dutyOffMin: 15,
    };
  }

  function defaultBoxes() {
    return [
      { id: "BOX-001", name: "Caja 1", enabled: true, profileId: "adultos", sensorId: "A", mode: "AUTO", heater: { type: "sim", host: "" } },
      { id: "BOX-002", name: "Caja 2", enabled: false, profileId: "ninfas", sensorId: "B", mode: "AUTO", heater: { type: "sim", host: "" } },
    ];
  }

  /** Valida un perfil: el orden de los umbrales debe tener sentido. Devuelve errores. */
  function validateProfile(p) {
    var e = [];
    ["target", "min", "max", "onAt", "offAt", "warn", "critical", "recovery"].forEach(function (k) {
      if (typeof p[k] !== "number" || !isFinite(p[k])) e.push(k + " no es numérico");
    });
    if (e.length) return e;
    if (!(p.min < p.max)) e.push("El mínimo operativo debe ser menor que el máximo");
    if (!(p.onAt < p.offAt)) e.push("Encender (≤) debe ser menor que apagar (≥): es la histéresis");
    if (p.onAt < p.min - 3 || p.offAt > p.max + 3) e.push("La histéresis queda muy lejos del rango operativo");
    if (!(p.offAt < p.critical)) e.push("Apagar debe ser menor que la temperatura crítica");
    if (!(p.warn <= p.critical)) e.push("La alerta debe ser menor o igual que la crítica");
    if (!(p.recovery < p.critical)) e.push("La recuperación debe ser menor que la crítica (histéresis de seguridad)");
    if (p.humMin != null && p.humMax != null && !(p.humMin < p.humMax)) e.push("Humedad mínima debe ser menor que la máxima");
    return e;
  }

  function validateControl(c) {
    var e = [], ints = { highConfirmSec: [0, 3600], lowConfirmSec: [0, 3600], minSwitchSec: [0, 7200], sensorTimeoutSec: [30, 7200], frozenMaxMin: [1, 1440], dutyOnMin: [1, 120], dutyOffMin: [1, 240] };
    Object.keys(ints).forEach(function (k) { var v = c[k]; if (typeof v !== "number" || v < ints[k][0] || v > ints[k][1]) e.push(k + " fuera de rango " + ints[k][0] + "–" + ints[k][1]); });
    if (["off", "keep", "duty"].indexOf(c.sensorErrorStrategy) < 0) e.push("Estrategia ante falla del sensor inválida");
    if (!(c.plausibleMin < c.plausibleMax)) e.push("Rango plausible inválido");
    return e;
  }

  var REASONS = {
    LOW_TEMPERATURE: "Temperatura de caja baja: encender",
    HIGH_TEMPERATURE: "Temperatura de caja alta: apagar",
    CRITICAL_TEMPERATURE: "Temperatura crítica",
    MANUAL_ON: "Encendido manual",
    MANUAL_OFF: "Apagado manual",
    AUTO_CONTROL: "Control automático: mantener estado",
    SAFETY_SHUTDOWN: "Apagado de seguridad por sobrecalentamiento",
    SENSOR_ERROR: "Temperatura de caja no disponible",
    DEVICE_UNREACHABLE: "No se pudo comunicar con el enchufe",
    RECOVERY: "Recuperación tras apagado de seguridad",
    WAIT_CONFIRM: "Esperando confirmación del umbral",
    WAIT_MIN_SWITCH: "Esperando el intervalo mínimo entre conmutaciones",
  };

  /**
   * Estado de la lectura de caja (OUT) para el control.
   * reading: { out, in, humidity, ts, reliable } · history: lecturas recientes (para congelamiento)
   */
  function sensorStatus(reading, now, control) {
    if (!reading || reading.ts == null) return { ok: false, why: "Sin lecturas de la temperatura de caja." };
    var age = (now - reading.ts) / 1000;
    if (age > control.sensorTimeoutSec) return { ok: false, why: "Lectura de caja desactualizada (" + Math.round(age / 60) + " min sin datos nuevos)." };
    var t = reading.out;
    if (typeof t !== "number" || !isFinite(t)) return { ok: false, why: "La temperatura de caja (OUT) no es un número válido." };
    if (t < control.plausibleMin || t > control.plausibleMax) return { ok: false, why: "Temperatura de caja imposible (" + t + " °C)." };
    if (reading.reliable === false) return { ok: false, why: "La lectura de caja no es confiable (OCR incierto)." };
    if (reading.sameSince != null && (now - reading.sameSince) / 60000 > control.frozenMaxMin) {
      return { ok: false, why: "La temperatura de caja no cambia desde hace más de " + control.frozenMaxMin + " min (posible lectura congelada)." };
    }
    return { ok: true, why: "" };
  }

  /**
   * Decisión del termostato (función pura).
   * @param box     { id, mode: AUTO|MANUAL_ON|MANUAL_OFF }
   * @param profile perfil térmico
   * @param control parámetros de control
   * @param st      estado previo { heater: ON|OFF|UNKNOWN|ERROR|UNREACHABLE, safety, lowSince, highSince, lastSwitchAt }
   * @param reading última lectura { out, in, humidity, ts, reliable, sameSince }
   * @param now     ms
   * @returns { command: "ON"|"OFF"|null (mantener), reason, state (nuevo estado lógico), level: ok|warn|critical, notes[] }
   */
  function decide(box, profile, control, st, reading, now) {
    st = Object.assign({ heater: "UNKNOWN", safety: false, lowSince: null, highSince: null, lastSwitchAt: null }, st || {});
    var next = { safety: st.safety, lowSince: st.lowSince, highSince: st.highSince, sensorError: false };
    var notes = [], level = "ok";
    var out = function (command, reason, lvl) { return { command: command, reason: reason, state: next, level: lvl || level, notes: notes }; };

    var sensor = sensorStatus(reading, now, control);
    if (!sensor.ok) {
      next.sensorError = true;
      next.lowSince = next.highSince = null;
      notes.push(sensor.why);
      if (box.mode === "MANUAL_ON") return out("ON", "MANUAL_ON", "warn");
      if (box.mode === "MANUAL_OFF") return out("OFF", "MANUAL_OFF", "warn");
      if (control.sensorErrorStrategy === "off") return out("OFF", "SENSOR_ERROR", "critical");
      if (control.sensorErrorStrategy === "keep") return out(null, "SENSOR_ERROR", "critical");
      var period = (control.dutyOnMin + control.dutyOffMin) * 60000;
      return out(now % period < control.dutyOnMin * 60000 ? "ON" : "OFF", "SENSOR_ERROR", "critical");
    }

    var t = reading.out;
    // 1. Seguridad por sobrecalentamiento: inmediata, incluso en modo manual.
    if (t >= profile.critical) {
      next.safety = true;
      next.lowSince = next.highSince = null;
      notes.push("Temperatura de caja " + t + " °C ≥ crítica " + profile.critical + " °C.");
      return out("OFF", "SAFETY_SHUTDOWN", "critical");
    }
    // 2. Bloqueo de seguridad hasta bajar a la temperatura de recuperación.
    var recovered = false;
    if (st.safety) {
      if (t <= profile.recovery) { next.safety = false; recovered = true; notes.push("Recuperado: " + t + " °C ≤ " + profile.recovery + " °C."); }
      else { notes.push("Bloqueo de seguridad: se reanuda al bajar a " + profile.recovery + " °C."); return out("OFF", "SAFETY_SHUTDOWN", "critical"); }
    }
    if (t >= profile.warn) { level = "warn"; notes.push("Temperatura de caja en zona de alerta (≥ " + profile.warn + " °C)."); }
    else if (t < profile.min || t > profile.max) { level = "warn"; notes.push("Fuera del rango operativo " + profile.min + "–" + profile.max + " °C."); }

    // 3. Modo manual.
    if (box.mode === "MANUAL_ON") return out("ON", "MANUAL_ON");
    if (box.mode === "MANUAL_OFF") return out("OFF", "MANUAL_OFF");

    // 4. Automático con histéresis y confirmación temporal.
    var want = null, reason = recovered ? "RECOVERY" : "AUTO_CONTROL";
    if (t <= profile.onAt) {
      next.highSince = null;
      next.lowSince = st.lowSince || now;
      if ((now - next.lowSince) / 1000 >= control.lowConfirmSec) { want = "ON"; reason = "LOW_TEMPERATURE"; }
      else notes.push("≤ " + profile.onAt + " °C: confirmando " + Math.ceil(control.lowConfirmSec - (now - next.lowSince) / 1000) + " s más.");
    } else if (t >= profile.offAt) {
      next.lowSince = null;
      next.highSince = st.highSince || now;
      if ((now - next.highSince) / 1000 >= control.highConfirmSec) { want = "OFF"; reason = "HIGH_TEMPERATURE"; }
      else notes.push("≥ " + profile.offAt + " °C: confirmando " + Math.ceil(control.highConfirmSec - (now - next.highSince) / 1000) + " s más.");
    } else {
      next.lowSince = next.highSince = null; // banda muerta: mantener estado
    }
    if (want && want === st.heater) return out(null, reason); // ya está así
    if (want && st.lastSwitchAt && (now - st.lastSwitchAt) / 1000 < control.minSwitchSec) {
      notes.push("Intervalo mínimo entre conmutaciones: faltan " + Math.ceil(control.minSwitchSec - (now - st.lastSwitchAt) / 1000) + " s.");
      return out(null, "WAIT_MIN_SWITCH");
    }
    // Estado desconocido del enchufe en banda muerta: mejor fijarlo según la mitad de la banda.
    if (!want && (st.heater === "UNKNOWN" || st.heater === "ERROR") && box.mode === "AUTO") {
      want = t < profile.target ? "ON" : "OFF";
      notes.push("Estado del enchufe desconocido: se fija según el objetivo " + profile.target + " °C.");
    }
    return out(want, want ? reason : reason === "RECOVERY" ? "RECOVERY" : "AUTO_CONTROL");
  }

  /** Simulador: ¿qué haría el sistema con esta temperatura de caja? (sin tiempos de espera). */
  function simulate(profile, outTemp, heaterBefore, mode, safetyBefore) {
    var control = Object.assign(defaultControl(), { highConfirmSec: 0, lowConfirmSec: 0, minSwitchSec: 0 });
    var now = Date.now();
    var r = decide({ id: "SIM", mode: mode || "AUTO" }, profile, control, { heater: heaterBefore || "OFF", safety: !!safetyBefore }, { out: outTemp, ts: now, reliable: true }, now);
    var heaterAfter = r.command || heaterBefore || "OFF";
    return { heater: heaterAfter, command: r.command, reason: r.reason, reasonText: REASONS[r.reason] || r.reason, level: r.level, safety: r.state.safety, notes: r.notes };
  }

  /**
   * Análisis de respuesta térmica de una caja a partir de lecturas OUT y cambios
   * de la calefacción. Sin "machine learning": estadísticas simples y honestas.
   * readings: [{ ts, out }] ascendente · switches: [{ ts, state: ON|OFF }] ascendente
   */
  function analyze(readings, switches, profile) {
    var pts = readings.filter(function (r) { return typeof r.out === "number"; });
    var res = { readings: pts.length, inRangePct: null, cycles: 0, avgOnMin: null, avgOffMin: null, heatRate: null, coolRate: null, onPct: null, minutesToRise1C: null, minutesToFall1C: null };
    if (!pts.length) return res;
    if (profile) res.inRangePct = Math.round((1000 * pts.filter(function (r) { return r.out >= profile.min && r.out <= profile.max; }).length) / pts.length) / 10;
    var segs = [], t0 = pts[0].ts, t1 = pts[pts.length - 1].ts;
    var sw = switches.filter(function (s) { return s.state === "ON" || s.state === "OFF"; });
    for (var i = 0; i < sw.length; i++) {
      var a = Math.max(sw[i].ts, t0), b = Math.min(i + 1 < sw.length ? sw[i + 1].ts : t1, t1);
      if (b > a) segs.push({ state: sw[i].state, from: a, to: b });
    }
    var onMs = 0, offMs = 0, onN = 0, offN = 0;
    segs.forEach(function (s) { if (s.state === "ON") { onMs += s.to - s.from; onN++; } else { offMs += s.to - s.from; offN++; } });
    res.cycles = onN;
    if (onN) res.avgOnMin = Math.round(onMs / onN / 6000) / 10;
    if (offN) res.avgOffMin = Math.round(offMs / offN / 6000) / 10;
    if (onMs + offMs) res.onPct = Math.round((1000 * onMs) / (onMs + offMs)) / 10;
    // pendiente (°C/min) por regresión dentro de cada tramo ON/OFF de al menos 3 lecturas
    var rate = function (state) {
      var sum = 0, w = 0;
      segs.filter(function (s) { return s.state === state; }).forEach(function (s) {
        var p = pts.filter(function (r) { return r.ts >= s.from && r.ts <= s.to; });
        if (p.length < 3) return;
        var n = p.length, mx = 0, my = 0, sxx = 0, sxy = 0;
        p.forEach(function (r) { mx += (r.ts - p[0].ts) / 60000; my += r.out; });
        mx /= n; my /= n;
        p.forEach(function (r) { var x = (r.ts - p[0].ts) / 60000 - mx; sxx += x * x; sxy += x * (r.out - my); });
        if (sxx > 0) { sum += (sxy / sxx) * n; w += n; }
      });
      return w ? Math.round((sum / w) * 1000) / 1000 : null;
    };
    res.heatRate = rate("ON");
    res.coolRate = rate("OFF");
    if (res.heatRate && res.heatRate > 0) res.minutesToRise1C = Math.round(10 / res.heatRate) / 10;
    if (res.coolRate && res.coolRate < 0) res.minutesToFall1C = Math.round(-10 / res.coolRate) / 10;
    return res;
  }

  return {
    SPECIES: SPECIES,
    SOURCES: SOURCES,
    REASONS: REASONS,
    defaultProfiles: defaultProfiles,
    defaultControl: defaultControl,
    defaultBoxes: defaultBoxes,
    validateProfile: validateProfile,
    validateControl: validateControl,
    sensorStatus: sensorStatus,
    decide: decide,
    simulate: simulate,
    analyze: analyze,
  };
});
