/*
 * BioTeva Monitor — libro de Excel del monitoreo: LÉAME (qué significa cada cosa), ANÁLISIS POR DÍA,
 * ANÁLISIS POR HORA, READINGS, EVENTS, DAILY SUMMARY, CONFIGURATION, STATISTICS. Puro: sin DOM ni almacenamiento.
 *
 *   MonWorkbook.build(readings, events, sensors, settings, from, to) → Promise<Uint8Array>
 */
(function (root) {
  "use strict";
  const L = root.MonLogic, MonXlsx = root.MonXlsx;

  /** Libro con hojas READINGS, EVENTS, DAILY SUMMARY, CONFIGURATION, STATISTICS (comprimido). */
  function buildWorkbook(readings, events, sensors, S, from, to) {
    const name = (id) => (sensors.find((s) => s.id === id) || { name: id }).name;
    const byReading = {};
    events.forEach((e) => { if (e.readingId) (byReading[e.readingId] = byReading[e.readingId] || []).push(e.type); });
    const notes = (r) => Object.keys(r.fields || {}).map((k) => r.fields[k].note).filter(Boolean).join(" | ") || (r.error || "");
    // ── Análisis: por día y sensor, y por hora del día (todo el periodo) ──
    const days = [];
    for (let d = L.dayBounds(L.dayKey(from)).from; d <= to; d += 86400000) { const b = L.dayBounds(L.dayKey(d)); if (!days.length || days[days.length - 1].from !== b.from) days.push(b); }
    const anaDay = [];
    days.forEach((b) => L.analyzePeriod(readings, sensors, S, b.from, b.to).forEach((a) => { if (a.total) anaDay.push(Object.assign({ date: L.dayKey(b.from) }, a)); }));
    const anaAll = L.analyzePeriod(readings, sensors, S, from, to);
    const st = (a, k, f) => (a.stats[k] && a.stats[k][f] != null ? Math.round(a.stats[k][f] * 10) / 10 : null);
    const pctOf = (n, t) => (t ? Math.round((1000 * n) / t) / 10 : null);
    const explain = [
      ["QUÉ ES ESTE ARCHIVO", "Lecturas de los termohigrómetros HTC-2 tomadas por la cámara de BioTeva Monitor (" + L.fmtDateTime(from) + " a " + L.fmtDateTime(to) + ")."],
      ["IN", "Temperatura del sensor DENTRO del aparato: el aire donde está la pantalla (el cuarto)."],
      ["OUT", "Temperatura de la SONDA del cable: donde esté puesta la punta (dentro de la caja). Es la temperatura de control por defecto."],
      ["Humedad (HR %)", "Humedad relativa medida por el aparato (lado IN)."],
      ["Lectura confiable", "La app leyó los dígitos con confianza suficiente y el valor es coherente con las lecturas anteriores. SOLO estas entran en promedios, gráficas y alertas."],
      ["Sin luz", "La imagen de la pantalla estaba demasiado oscura para leerla (típico de noche sin una lámpara cerca)."],
      ["Sensor no visible / no detectado", "La imagen no se parece a la de la calibración: sensor o cámara movidos, algo tapando, o muy oscuro."],
      ["Lectura dudosa / incierta", "Se vio la pantalla pero algún dígito no era claro; el valor no se usa."],
      ["Hueco sin datos", "Periodo en que no se registró nada: app cerrada, computador suspendido o apagado."],
      ["", ""],
      ["HOJA", "CONTENIDO"],
      ["ANÁLISIS POR DÍA", "Una fila por día y sensor: cuántas lecturas, qué porcentaje fue confiable, cuántas no se pudieron leer y por qué, mínimos/promedios/máximos y los HALLAZGOS en lenguaje claro. Empieza por aquí."],
      ["ANÁLISIS POR HORA", "Para cada sensor y hora del día (todo el periodo): lecturas, % confiables, % sin luz o sin ver el sensor y promedios. Muestra a qué horas falla la lectura (p. ej. de noche) y cómo cambia la temperatura en el día."],
      ["READINGS", "Todas las lecturas, una por fila (columnas en inglés por compatibilidad: temperature_in = IN, temperature_out = OUT, humidity = HR, status = estado, confidence = confianza 0–100, raw_text = lo que leyó la cámara)."],
      ["EVENTS", "Eventos y alertas detectados (cambios, fuera de límites, falla de cámara, sin luz, huecos…), con su descripción."],
      ["DAILY SUMMARY", "Resumen por día y sensor de la temperatura de control y la humedad."],
      ["STATISTICS", "Estadística descriptiva de todo el periodo: media, desviación estándar (std_dev), mínimo, percentiles 5/50/95 y máximo de las lecturas confiables."],
      ["CONFIGURATION", "Parámetros con que se tomaron los datos (frecuencia, umbrales, límites configurados)."],
      ["", ""],
      ["NOTA", "La app no inventa límites para los grillos ni afirma causas: los límites los define la persona y los hallazgos describen lo medido."],
    ];
    const sheets = [
      { name: "LÉAME", columns: [{ header: "Término u hoja", width: 30 }, { header: "Qué significa", type: "wrap", width: 110 }], rows: explain, autoFilter: false },
      {
        name: "ANÁLISIS POR DÍA",
        columns: [
          { header: "Fecha", width: 12 }, { header: "Sensor", width: 14 }, { header: "Lecturas", type: "integer", width: 10 }, { header: "Confiables", type: "integer", width: 11 },
          { header: "% confiables", type: "number1", width: 12 }, { header: "Sin luz", type: "integer", width: 9 }, { header: "Sensor no visible", type: "integer", width: 15 },
          { header: "Dudosas", type: "integer", width: 9 }, { header: "Huecos sin datos", type: "integer", width: 15 }, { header: "Horas sin datos", type: "number1", width: 14 },
          { header: "OUT mín", type: "number1" }, { header: "OUT prom", type: "number1" }, { header: "OUT máx", type: "number1" },
          { header: "IN mín", type: "number1" }, { header: "IN prom", type: "number1" }, { header: "IN máx", type: "number1" },
          { header: "HR mín", type: "number1" }, { header: "HR prom", type: "number1" }, { header: "HR máx", type: "number1" },
          { header: "Fuera de límites", type: "integer", width: 14 }, { header: "Hallazgos", type: "wrap", width: 110 },
        ],
        rows: anaDay.map((a) => [a.date, a.sensorName, a.total, a.reliable, a.reliablePct == null ? null : Math.round(a.reliablePct * 10) / 10,
          a.byStatus.SIN_LUZ || 0, a.byStatus.SENSOR_NO_DETECTADO || 0, a.byStatus.LECTURA_INCIERTA || 0, a.gaps.length, Math.round(a.gaps.reduce((t, g) => t + g.ms, 0) / 360000) / 10,
          st(a, "tempOut", "min"), st(a, "tempOut", "mean"), st(a, "tempOut", "max"), st(a, "tempIn", "min"), st(a, "tempIn", "mean"), st(a, "tempIn", "max"),
          st(a, "humidity", "min"), st(a, "humidity", "mean"), st(a, "humidity", "max"), a.outOfRange, a.findings.map((f) => "• " + f.text).join("\n")]),
      },
      {
        name: "ANÁLISIS POR HORA",
        columns: [
          { header: "Sensor", width: 14 }, { header: "Hora", width: 12 }, { header: "Lecturas", type: "integer", width: 10 }, { header: "% confiables", type: "number1", width: 12 },
          { header: "% sin luz", type: "number1", width: 10 }, { header: "% sensor no visible", type: "number1", width: 17 }, { header: "% dudosas", type: "number1", width: 10 },
          { header: "OUT prom (°C)", type: "number1", width: 13 }, { header: "IN prom (°C)", type: "number1", width: 12 }, { header: "HR prom (%)", type: "number1", width: 12 },
        ],
        rows: anaAll.flatMap((a) => a.hours.map((x) => [a.sensorName, (x.h < 10 ? "0" : "") + x.h + ":00–" + (x.h < 10 ? "0" : "") + x.h + ":59", x.n, pctOf(x.reliable, x.n), pctOf(x.dark, x.n), pctOf(x.notSeen, x.n), pctOf(x.uncertain, x.n),
          x.tempOut == null ? null : Math.round(x.tempOut * 10) / 10, x.tempIn == null ? null : Math.round(x.tempIn * 10) / 10, x.humidity == null ? null : Math.round(x.humidity * 10) / 10])),
      },
      {
        name: "READINGS",
        columns: [
          { header: "timestamp", type: "datetime", width: 20 }, { header: "sensor", width: 14 }, { header: "temperature_in", type: "number1" },
          { header: "temperature_out", type: "number1" }, { header: "humidity", type: "integer", width: 11 }, { header: "display_time", width: 12 },
          { header: "delta_temperature", type: "number1" }, { header: "delta_humidity", type: "number1" }, { header: "confidence", type: "number1", width: 11 },
          { header: "confidence_level", width: 15 }, { header: "status", width: 20 }, { header: "events", width: 30 }, { header: "source", width: 11 },
          { header: "raw_text", width: 30 }, { header: "image_quality", type: "number1" }, { header: "image_change_score", type: "number1" },
          { header: "reference_diff_score", type: "number1" }, { header: "notes", width: 50 }, { header: "timestamp_utc", width: 22 },
        ],
        rows: readings.map((r) => [
          r.ts, name(r.sensorId), r.tempIn, r.tempOut, r.humidity, r.displayTime, r.deltaTemp, r.deltaHum, r.confidence,
          L.LEVEL_LABELS[r.level] || r.level, L.STATUS_LABELS[r.status] || r.status, (byReading[r.id] || []).join(", "),
          r.source === "simulation" ? "simulación" : r.source === "image" ? "imagen" : "cámara", r.rawText, r.imageQuality,
          r.imageChangeScore, r.referenceDiffScore, notes(r), new Date(r.ts).toISOString(),
        ]),
      },
      {
        name: "EVENTS",
        columns: [
          { header: "timestamp", type: "datetime", width: 20 }, { header: "sensor", width: 14 }, { header: "event_type", width: 26 }, { header: "event", width: 28 },
          { header: "value", type: "number1" }, { header: "previous_value", type: "number1", width: 15 }, { header: "delta", type: "number1" },
          { header: "severity", width: 11 }, { header: "description", type: "wrap", width: 90 }, { header: "acknowledged", type: "datetime", width: 20 }, { header: "source", width: 11 },
        ],
        rows: events.map((e) => [e.ts, e.sensorId ? name(e.sensorId) : "", e.type, L.EVENT_LABELS[e.type] || e.type, e.value, e.previousValue, e.delta, e.severity, e.description, e.ack, e.source === "simulation" ? "simulación" : e.source === "image" ? "imagen" : "cámara"]),
      },
      {
        name: "DAILY SUMMARY",
        columns: [
          { header: "date", width: 12 }, { header: "sensor", width: 14 }, { header: "control_temperature", width: 18 },
          { header: "min_temperature", type: "number1", width: 15 }, { header: "max_temperature", type: "number1", width: 15 }, { header: "average_temperature", type: "number2", width: 18 },
          { header: "min_humidity", type: "number1", width: 13 }, { header: "max_humidity", type: "number1", width: 13 }, { header: "average_humidity", type: "number2", width: 16 },
          { header: "number_of_readings", type: "integer", width: 18 }, { header: "reliable_readings", type: "integer", width: 16 }, { header: "number_of_alerts", type: "integer", width: 16 },
          { header: "number_of_ocr_errors", type: "integer", width: 19 }, { header: "out_of_range_readings", type: "integer", width: 20 }, { header: "relevant_changes", type: "integer", width: 16 }, { header: "data_gaps", type: "integer", width: 10 },
        ],
        rows: L.dailySummary(readings, events, sensors).map((d) => [d.date, d.sensorName, d.controlTemp, d.minTemp, d.maxTemp, d.avgTemp, d.minHum, d.maxHum, d.avgHum, d.readings, d.reliable, d.alerts, d.ocrErrors, d.outOfRange, d.changes, d.gaps]),
      },
      {
        name: "CONFIGURATION",
        columns: [{ header: "parameter", width: 34 }, { header: "value", width: 30 }, { header: "description", type: "wrap", width: 80 }],
        rows: [
          ["exported_at", L.fmtDateTime(Date.now()), "Fecha de generación del archivo"],
          ["range_from", L.fmtDateTime(from), "Inicio del rango exportado (hora local)"],
          ["range_to", L.fmtDateTime(to), "Fin del rango exportado (hora local)"],
          ["frame_source", S.frameSource, "Fuente de imagen activa al exportar"],
          ["interval_sec", S.intervalSec, "Frecuencia de lectura de día (segundos)"],
          ["night_interval_sec", S.nightIntervalSec || S.intervalSec, "Frecuencia de lectura de noche (" + (S.nightFrom || "") + "–" + (S.nightTo || "") + ")"],
          ["min_confidence / high_confidence", S.minConfidence + " / " + S.highConfidence, "Por debajo del mínimo la lectura NO es confiable"],
          ["temp_change_threshold", S.tempChangeThreshold, "°C dentro de la ventana que genera evento de cambio"],
          ["humidity_change_threshold", S.humidityChangeThreshold, "%HR dentro de la ventana que genera evento de cambio"],
          ["change_window_min", S.changeWindowMin, "Ventana para comparar cambios (min)"],
          ["confirm_readings", S.confirmReadings, "Lecturas confiables consecutivas para confirmar fuera de rango"],
          ["no_data_cycles", S.noDataCycles, "Ciclos sin lectura para declarar periodo sin datos"],
          ["stale_cycles", S.staleCycles, "Lecturas idénticas para evento de lectura sin cambios"],
          ["plausible_temp_range", S.plausibleTempMin + " a " + S.plausibleTempMax, "Rango físico plausible de la LECTURA (no es un rango de producción)"],
          ["save_snapshots", S.saveSnapshots + " (" + S.snapshotRetentionDays + " días)", "Evidencia fotográfica y retención"],
        ].concat(sensors.flatMap((s) => [
          [s.name + " · activo", s.enabled ? "sí" : "no", ""],
          [s.name + " · temperatura de control", s.controlTemp === "out" ? "OUT" : "IN", "Variable usada para límites y alertas de temperatura"],
          [s.name + " · target_min / target_max (°C)", (s.tempMin == null ? "no configurado" : s.tempMin) + " / " + (s.tempMax == null ? "no configurado" : s.tempMax), "Límites definidos por el usuario; el sistema no propone valores"],
          [s.name + " · humedad mín / máx (%)", (s.humMin == null ? "no configurado" : s.humMin) + " / " + (s.humMax == null ? "no configurado" : s.humMax), "Límites definidos por el usuario"],
          [s.name + " · calibración", L.FIELD_KEYS.filter((k) => s.calibration.fields[k].enabled).join(", "), "Campos leídos; inclinación " + s.calibration.slantDeg + "°"],
        ])),
        autoFilter: false,
      },
      {
        name: "STATISTICS",
        columns: [
          { header: "sensor", width: 14 }, { header: "metric", width: 14 }, { header: "unit", width: 6 }, { header: "total_readings", type: "integer", width: 14 },
          { header: "reliable_readings", type: "integer", width: 16 }, { header: "reliable_pct", type: "number1", width: 12 }, { header: "mean", type: "number2" },
          { header: "std_dev", type: "number2" }, { header: "min", type: "number1" }, { header: "p5", type: "number1" }, { header: "median", type: "number1" },
          { header: "p95", type: "number1" }, { header: "max", type: "number1" }, { header: "in_range_pct", type: "number1", width: 13 },
        ],
        rows: L.statistics(readings, sensors).map((x) => [x.sensorName, x.metric, x.unit, x.total, x.n, x.reliablePct, x.mean, x.sd, x.min, x.p5, x.median, x.p95, x.max, x.inRangePct]),
      },
    ];
    return MonXlsx.buildCompressed(sheets);
  }

  root.MonWorkbook = { build: buildWorkbook };
})(typeof self !== "undefined" ? self : globalThis);
