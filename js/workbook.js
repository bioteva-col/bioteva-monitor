/*
 * BioTeva Monitor — libro de Excel del monitoreo (hojas READINGS, EVENTS,
 * DAILY SUMMARY, CONFIGURATION, STATISTICS). Puro: sin DOM ni almacenamiento.
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
    const sheets = [
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
          ["interval_sec", S.intervalSec, "Frecuencia de lectura"],
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
