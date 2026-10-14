/*
 * BioTeva Monitor — pantalla "Control térmico" y panel del Dashboard.
 *
 * Habla con el gateway térmico local (http://127.0.0.1:4479), que es quien
 * acciona los enchufes HS105 y aplica la seguridad aunque esta ventana se cierre.
 * El simulador y el análisis funcionan aquí mismo, sin gateway.
 */
(function () {
  "use strict";
  const T = window.MonThermal;
  const GW = "http://127.0.0.1:4479";
  const S = { status: null, online: null, error: "", events: [], lastPoll: 0, lastAlertTs: 0, sim: { out: 30, profileId: "adultos", heater: "OFF", mode: "AUTO" } };
  // app.js se carga antes que este archivo: se conecta a la app ya creada.
  let App = window.BioTevaMonitor || null, H = App ? App.helpers : null;

  const MODE_LABEL = { AUTO: "AUTO", MANUAL_ON: "MANUAL ON", MANUAL_OFF: "MANUAL OFF" };
  const HEATER_UI = { ON: ["🔥 ENCENDIDA", "warn"], OFF: ["APAGADA", "muted"], UNKNOWN: ["ESTADO DESCONOCIDO", "crit"], ERROR: ["ERROR", "crit"], UNREACHABLE: ["SIN COMUNICACIÓN", "crit"] };
  const n1 = (v) => (v == null || !isFinite(v) ? "—" : Number(v).toFixed(1));

  async function gw(method, path, body) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetch(GW + path, { method, headers: { "content-type": "application/json", "x-bioteva": "1" }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      return j;
    } finally { clearTimeout(to); }
  }

  async function poll(force) {
    if (!force && Date.now() - S.lastPoll < 5000) return;
    S.lastPoll = Date.now();
    try {
      S.status = await gw("GET", "/api/status");
      S.online = true; S.error = "";
      const ev = await gw("GET", "/api/events?since=" + (Date.now() - 2 * 86400000));
      S.events = ev;
      // alertas críticas nuevas → aviso en pantalla
      ev.filter((e) => e.ts > S.lastAlertTs && (e.level === "critical" || e.reason === "SAFETY_SHUTDOWN" || e.reason === "CRITICAL_TEMPERATURE" || e.reason === "DEVICE_UNREACHABLE" || e.reason === "SENSOR_ERROR"))
        .forEach((e) => { if (S.lastAlertTs) H.toast("CONTROL TÉRMICO · " + e.box_id + ": " + e.message + (e.error ? " (" + e.error + ")" : ""), "crit"); });
      if (ev.length) S.lastAlertTs = Math.max(S.lastAlertTs, ev[ev.length - 1].ts);
    } catch (e) {
      S.online = false; S.error = e.message;
    }
  }

  /** Tras cada ciclo de lectura: enviar la temperatura de caja (OUT) de cada sensor al gateway. */
  async function onCycle(results) {
    if (S.online === false && Date.now() - S.lastPoll < 30000) return;
    for (const r of results) {
      const rd = r.reading;
      try {
        S.status = await gw("POST", "/api/reading", {
          sensorId: rd.sensorId, out: rd.tempOut, in: rd.tempIn, humidity: rd.humidity,
          reliable: rd.tempOut != null, source: rd.source, // las simuladas nunca accionan un HS105 real
        });
        S.online = true;
      } catch (e) { S.online = false; S.error = e.message; break; }
    }
  }

  function heaterChip(st) {
    const ui = HEATER_UI[st] || HEATER_UI.UNKNOWN;
    return '<span class="chip ' + ui[1] + '">' + H.esc(ui[0]) + "</span>";
  }

  function boxCard(b, compact) {
    const r = b.reading || {}, p = b.profile, st = b.state || {};
    const lvl = st.level === "critical" ? "crit" : st.level === "warn" ? "warn" : "good";
    const sensorOk = b.sensor && b.sensor.ok;
    return '<article class="thermo-card ' + lvl + '">' +
      "<header><h2>" + H.esc(b.name) + ' <small class="muted-text">' + H.esc(b.id) + '</small></h2><div class="spacer"></div>' + heaterChip(st.heater) +
      (st.safety ? ' <span class="chip crit">⬣ SAFETY_SHUTDOWN</span>' : "") + "</header>" +
      '<div class="thermo-main">' +
        '<div class="val box"><span class="k">Temperatura de caja · OUT (controla)</span><span class="v">' + (sensorOk ? n1(r.out) + " <small>°C</small>" : '<span class="crit-text" style="font-size:15px">no disponible</span>') + "</span></div>" +
        '<div class="val"><span class="k">Ambiente · IN</span><span class="v">' + n1(r.in) + " <small>°C</small></span></div>" +
        '<div class="val"><span class="k">Humedad de caja</span><span class="v">' + (r.humidity == null ? "—" : Math.round(r.humidity)) + " <small>%</small></span></div>" +
      "</div>" +
      (b.sensor && !b.sensor.ok ? '<p class="note warn">⚠ Temperatura de caja no disponible: ' + H.esc(b.sensor.why) + "</p>" : "") +
      ((st.notes || []).length ? '<p class="hint">' + H.esc(st.notes.join(" ")) + "</p>" : "") +
      '<dl class="meta">' +
        "<div><dt>Perfil</dt><dd>" + H.esc(p.name) + "</dd></div>" +
        "<div><dt>Objetivo · rango operativo</dt><dd>" + n1(p.target) + " °C · " + n1(p.min) + "–" + n1(p.max) + " °C</dd></div>" +
        "<div><dt>Enciende ≤ / apaga ≥</dt><dd>" + n1(p.onAt) + " / " + n1(p.offAt) + " °C</dd></div>" +
        "<div><dt>Alerta · crítico · recuperación</dt><dd>" + n1(p.warn) + " · " + n1(p.critical) + " · " + n1(p.recovery) + " °C</dd></div>" +
        "<div><dt>Modo</dt><dd>" + H.esc(MODE_LABEL[b.mode] || b.mode) + (b.mode !== "AUTO" ? ' <span class="warn-text">· Control automático desactivado</span>' : "") + "</dd></div>" +
        "<div><dt>Última decisión</dt><dd>" + H.esc((T.REASONS[st.reason] || st.reason || "—")) + "</dd></div>" +
        "<div><dt>Sensor</dt><dd>" + (sensorOk ? "ONLINE (Sensor " + H.esc(b.sensorId) + ")" : "SIN DATOS (Sensor " + H.esc(b.sensorId) + ")") + "</dd></div>" +
        "<div><dt>Enchufe " + (b.heater.type === "hs105" ? "HS105 " + H.esc(b.heater.host) : b.heater.type === "sim" ? "simulado" : "—") + "</dt><dd>" + H.esc(b.device) + " · encendido hoy " + (b.onMinutesToday || 0) + " min</dd></div>" +
      "</dl>" +
      (compact ? "" : "") +
      '<div class="row-actions"><div class="mode-switch" role="group" aria-label="Modo de ' + H.esc(b.name) + '">' +
        ["AUTO", "MANUAL_ON", "MANUAL_OFF"].map((m) => '<button type="button" data-box="' + H.esc(b.id) + '" data-mode="' + m + '" aria-pressed="' + (b.mode === m) + '">' + MODE_LABEL[m] + "</button>").join("") +
      "</div></div>" +
    "</article>";
  }

  function bindModeButtons(host) {
    host.querySelectorAll("[data-mode]").forEach((btn) => btn.addEventListener("click", async () => {
      try { S.status = await gw("POST", "/api/box/" + btn.dataset.box + "/mode", { mode: btn.dataset.mode }); H.toast("Modo " + MODE_LABEL[btn.dataset.mode] + " en " + btn.dataset.box + "."); }
      catch (e) { H.toast("No se pudo cambiar el modo: " + e.message, "crit"); }
      App.renderView();
    }));
  }

  function offlineHelp() {
    return '<div class="banner warn"><b>Gateway térmico no disponible.</b> El control de las lámparas (HS105) lo hace un pequeño servicio local que se inicia solo al abrir la app con el acceso directo <b>BioTeva Monitor</b>. ' +
      "También puedes iniciarlo con <span class=\"mono\">npm run termico</span> en la carpeta <span class=\"mono\">asistente-ejecutivo</span>. El monitoreo por cámara sigue funcionando; el simulador de abajo también.</div>";
  }

  /** Panel compacto para el Dashboard. */
  function dashboardHtml() {
    if (!S.status) return S.online === false ? '<div class="panel"><header><h2>Control térmico BioTeva</h2></header><div class="panel-body">' + offlineHelp() + "</div></div>" : "";
    const boxes = S.status.boxes.filter((b) => b.enabled);
    if (!boxes.length) return "";
    return '<div class="panel"><header><h2>Control térmico BioTeva</h2><div class="spacer"></div><a class="btn ghost" href="#termico" data-go="termico">Abrir control térmico</a></header>' +
      '<div class="panel-body"><div class="thermo-grid">' + boxes.map((b) => boxCard(b, true)).join("") + "</div></div></div>";
  }

  // ───────────── pantalla completa ─────────────

  async function render() {
    await poll(true);
    const host = document.querySelector('section[data-view="termico"]');
    const st = S.status;
    const profiles = st ? st.profiles : T.defaultProfiles();
    const control = st ? st.control : T.defaultControl();
    const boxes = st ? st.boxes : [];
    const sensors = App.sensors;

    host.innerHTML =
      '<div class="banner muted"><b>' + H.esc(T.SPECIES.scientific) + "</b> (" + H.esc(T.SPECIES.common) + "). Variable de control: <b>OUT = temperatura de la caja</b> (sonda dentro de la caja). IN = ambiente, no enciende ni apaga la lámpara.</div>" +
      (S.online === false ? offlineHelp() : "") +
      (boxes.filter((b) => b.enabled).length ? '<div class="thermo-grid">' + boxes.filter((b) => b.enabled).map((b) => boxCard(b, false)).join("") + "</div>" : "") +

      // gráfica con franjas de calefacción
      '<div class="panel"><header><h2>Temperatura de caja vs. calefacción (48 h)</h2><div class="spacer"></div>' +
        '<select id="thChartBox" aria-label="Caja a graficar">' + boxes.map((b) => '<option value="' + H.esc(b.id) + '">' + H.esc(b.name + " · Sensor " + b.sensorId) + "</option>").join("") + "</select></header>" +
        '<div class="panel-body"><div class="chart" id="thChart"></div><div id="thAnalysis"></div></div></div>' +

      // simulador
      '<div class="panel"><header><h2>Simulador del termostato</h2></header><div class="panel-body col">' +
        '<p class="hint">Escribe una temperatura de caja y mira qué haría el sistema (no acciona ningún enchufe).</p>' +
        '<div class="filters">' +
          '<label class="f"><span>OUT simulado (°C)</span><input id="simOut" type="number" step="0.1" value="' + S.sim.out + '"></label>' +
          '<label class="f"><span>Perfil</span><select id="simProfile">' + profiles.map((p) => '<option value="' + p.id + '"' + (p.id === S.sim.profileId ? " selected" : "") + ">" + H.esc(p.name) + "</option>").join("") + "</select></label>" +
          '<label class="f"><span>Calefacción antes</span><select id="simHeater"><option>OFF</option><option' + (S.sim.heater === "ON" ? " selected" : "") + ">ON</option></select></label>" +
          '<label class="f"><span>Modo</span><select id="simMode">' + ["AUTO", "MANUAL_ON", "MANUAL_OFF"].map((m) => "<option" + (m === S.sim.mode ? " selected" : "") + ' value="' + m + '">' + MODE_LABEL[m] + "</option>").join("") + "</select></label>" +
          '<div class="row-actions">' + [25, 27, 28, 29, 30, 31, 32, 33, 35].map((v) => '<button class="btn small" type="button" data-simv="' + v + '">' + v + " °C</button>").join("") + "</div>" +
        "</div><div class=\"sim-result\" id=\"simOutResult\"></div></div></div>" +

      // configuración de cajas
      '<form class="panel" id="thBoxes"><header><h2>Cajas, sensores y enchufes</h2><div class="spacer"></div><button class="btn" type="button" id="thAddBox">+ Caja</button><button class="btn primary" type="submit">Guardar</button></header>' +
        '<div class="table-scroll"><table class="compact"><thead><tr><th>Activa</th><th>Id</th><th>Nombre</th><th>Perfil</th><th>Sensor (cámara)</th><th>Enchufe</th><th>IP del HS105</th><th></th></tr></thead><tbody>' +
        boxes.map((b, i) => boxRow(b, i, profiles, sensors)).join("") +
        '</tbody></table></div><p class="form-err" hidden></p><p class="hint" style="padding:0 16px 14px">El HS105 debe estar en la misma red Wi-Fi (2,4 GHz) que este computador. Usa una IP fija (reserva DHCP en el router). El enchufe nunca se expone a internet: solo este equipo le habla por la red local. Tipo <b>simulado</b> = enchufe virtual para pruebas.</p></form>' +

      // perfiles
      '<form class="panel" id="thProfiles"><header><h2>Perfiles térmicos · parámetros iniciales de producción</h2><div class="spacer"></div><button class="btn primary" type="submit">Guardar</button></header>' +
        '<div class="table-scroll"><table class="compact"><thead><tr><th>Etapa</th><th>Objetivo</th><th>Mín. op.</th><th>Máx. op.</th><th>Enciende ≤</th><th>Apaga ≥</th><th>Alerta</th><th>Crítico</th><th>Recupera ≤</th><th>HR mín.</th><th>HR máx.</th></tr></thead><tbody>' +
        profiles.map((p, i) => "<tr><td>" + H.esc(p.name) + "</td>" + ["target", "min", "max", "onAt", "offAt", "warn", "critical", "recovery", "humMin", "humMax"].map((k) => '<td><input class="num" type="number" step="0.1" data-p="' + i + '" data-k="' + k + '" value="' + (p[k] == null ? "" : p[k]) + '"></td>').join("") + "</tr>").join("") +
        '</tbody></table></div><p class="form-err" hidden></p><div class="panel-body"><p class="hint">Son <b>parámetros iniciales de producción</b> tomados de la literatura, no límites biológicos absolutos: ajústalos con los resultados de Bioteva (mortalidad, crecimiento, eclosión). 33 °C es un umbral de seguridad inicial, no una temperatura letal demostrada. Referencias:</p><ul class="sources">' +
        T.SOURCES.map((s) => "<li>" + H.esc(s) + "</li>").join("") + "</ul></div></form>" +

      // parámetros de control
      '<form class="panel" id="thControl"><header><h2>Parámetros de control</h2><div class="spacer"></div><button class="btn primary" type="submit">Guardar</button></header><div class="panel-body"><div class="grid-form">' +
        num("Confirmar temperatura alta (s)", "highConfirmSec", control) + num("Confirmar temperatura baja (s)", "lowConfirmSec", control) +
        num("Intervalo mínimo entre conmutaciones (s)", "minSwitchSec", control) + num("Sin lectura de caja → falla del sensor (s)", "sensorTimeoutSec", control) +
        num("Lectura congelada tras (min)", "frozenMaxMin", control) + num("Temperatura plausible mín. (°C)", "plausibleMin", control) + num("Temperatura plausible máx. (°C)", "plausibleMax", control) +
        '<label class="f"><span>Si falla el sensor de caja</span><select name="sensorErrorStrategy">' +
          [["off", "Apagar la calefacción (por defecto)"], ["keep", "Mantener el último estado"], ["duty", "Ciclo de seguridad ON/OFF"]].map((o) => '<option value="' + o[0] + '"' + (control.sensorErrorStrategy === o[0] ? " selected" : "") + ">" + o[1] + "</option>").join("") + "</select></label>" +
        num("Ciclo de seguridad: minutos ON", "dutyOnMin", control) + num("Ciclo de seguridad: minutos OFF", "dutyOffMin", control) +
      '</div><p class="form-err" hidden></p></div></form>' +

      // registro
      '<div class="panel"><header><h2>Registro de eventos térmicos (48 h)</h2></header><div class="table-scroll"><table class="compact"><thead><tr><th>Hora</th><th>Caja</th><th>IN</th><th>OUT</th><th>HR</th><th>Antes</th><th>Después</th><th>Modo</th><th>Razón</th></tr></thead><tbody>' +
        (S.events.length ? S.events.slice().reverse().slice(0, 200).map((e) => "<tr><td class=\"mono\">" + H.esc(new Date(e.ts).toLocaleString("es-CO")) + "</td><td>" + H.esc(e.box_id) + "</td><td class=\"mono\">" + n1(e.in_temperature) + "</td><td class=\"mono\">" + n1(e.out_temperature) + "</td><td class=\"mono\">" + (e.humidity == null ? "—" : Math.round(e.humidity)) + "</td><td>" + H.esc(e.previous_heater_state) + "</td><td>" + H.esc(e.new_heater_state) + "</td><td>" + H.esc(e.mode) + '</td><td><span class="chip ' + (e.level === "critical" ? "crit" : e.level === "warn" ? "warn" : "") + '">' + H.esc(e.reason) + "</span> " + H.esc(e.error || e.note || "") + "</td></tr>").join("") : '<tr><td colspan="9" class="muted-text">Sin eventos.</td></tr>') +
      "</tbody></table></div></div>";

    bindModeButtons(host);
    bindSimulator(profiles);
    bindForms(boxes, profiles, control);
    const sel = document.getElementById("thChartBox");
    if (sel) { sel.addEventListener("change", () => drawChart(sel.value)); drawChart(sel.value); }
  }

  function num(label, key, obj) {
    return '<label class="f"><span>' + H.esc(label) + '</span><input type="number" step="any" name="' + key + '" value="' + H.esc(obj[key]) + '"></label>';
  }

  function boxRow(b, i, profiles, sensors) {
    return '<tr data-i="' + i + '"><td><input type="checkbox" data-f="enabled"' + (b.enabled ? " checked" : "") + ' aria-label="Caja activa"></td>' +
      '<td><input data-f="id" value="' + H.esc(b.id) + '" maxlength="32" style="width:100px"></td>' +
      '<td><input data-f="name" value="' + H.esc(b.name) + '" maxlength="40" style="width:120px"></td>' +
      '<td><select data-f="profileId">' + profiles.map((p) => '<option value="' + p.id + '"' + (p.id === b.profileId ? " selected" : "") + ">" + H.esc(p.name) + "</option>").join("") + "</select></td>" +
      '<td><select data-f="sensorId">' + sensors.map((s) => '<option value="' + s.id + '"' + (s.id === b.sensorId ? " selected" : "") + ">" + H.esc(s.name) + " (OUT)</option>").join("") + "</select></td>" +
      '<td><select data-f="type">' + [["hs105", "TP-Link HS105"], ["sim", "Simulado"], ["none", "Ninguno"]].map((o) => '<option value="' + o[0] + '"' + (b.heater.type === o[0] ? " selected" : "") + ">" + o[1] + "</option>").join("") + "</select></td>" +
      '<td><input data-f="host" value="' + H.esc(b.heater.host || "") + '" placeholder="192.168.x.x" style="width:130px"></td>' +
      '<td><button class="btn small" type="button" data-test="' + i + '">Probar</button></td></tr>';
  }

  function bindSimulator(profiles) {
    const run = () => {
      S.sim = { out: Number(document.getElementById("simOut").value), profileId: document.getElementById("simProfile").value, heater: document.getElementById("simHeater").value, mode: document.getElementById("simMode").value };
      const p = profiles.find((x) => x.id === S.sim.profileId) || profiles[0];
      const r = T.simulate(p, S.sim.out, S.sim.heater, S.sim.mode);
      document.getElementById("simOutResult").innerHTML = "OUT simulado <b>" + n1(S.sim.out) + " °C</b> → calefacción <b>" + r.heater + "</b> · razón <b>" + H.esc(r.reason) + "</b><br><span class=\"hint\">" + H.esc(r.reasonText + (r.notes.length ? " — " + r.notes.join(" ") : "")) + "</span>";
    };
    ["simOut", "simProfile", "simHeater", "simMode"].forEach((id) => document.getElementById(id).addEventListener("input", run));
    document.querySelectorAll("[data-simv]").forEach((b) => b.addEventListener("click", () => { document.getElementById("simOut").value = b.dataset.simv; run(); }));
    run();
  }

  function formErr(form, msg) { const e = form.querySelector(".form-err"); e.hidden = !msg; e.textContent = msg || ""; }

  function bindForms(boxes, profiles, control) {
    const fb = document.getElementById("thBoxes");
    const collectBoxes = () => [...fb.querySelectorAll("tbody tr")].map((tr) => {
      const g = (f) => tr.querySelector('[data-f="' + f + '"]');
      const prev = boxes[Number(tr.dataset.i)] || {};
      return { id: g("id").value.trim(), name: g("name").value.trim() || g("id").value.trim(), enabled: g("enabled").checked, profileId: g("profileId").value, sensorId: g("sensorId").value, mode: prev.mode || "AUTO", heater: { type: g("type").value, host: g("host").value.trim() } };
    });
    fb.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try { S.status = await gw("PUT", "/api/config", { boxes: collectBoxes() }); formErr(fb, ""); H.toast("Cajas guardadas."); render(); } catch (e) { formErr(fb, e.message); }
    });
    document.getElementById("thAddBox").addEventListener("click", () => {
      const list = collectBoxes(), k = list.length + 1;
      list.push({ id: "BOX-" + String(k).padStart(3, "0"), name: "Caja " + k, enabled: false, profileId: "adultos", sensorId: App.sensors[0].id, mode: "AUTO", heater: { type: "sim", host: "" } });
      const tb = fb.querySelector("tbody");
      tb.insertAdjacentHTML("beforeend", boxRow(list[list.length - 1], list.length - 1, profiles, App.sensors));
    });
    fb.querySelectorAll("[data-test]").forEach((btn) => btn.addEventListener("click", async () => {
      const tr = btn.closest("tr"), type = tr.querySelector('[data-f="type"]').value, host = tr.querySelector('[data-f="host"]').value.trim();
      try {
        const r = await gw("POST", "/api/test-device", { type, host });
        H.toast(r.ok ? "Enchufe OK: " + (r.info ? r.info.alias + " · " + r.info.model + " · " + (r.info.relay ? "encendido" : "apagado") : "sin datos") : "No responde: " + r.error, r.ok ? "" : "crit");
      } catch (e) { H.toast("Gateway no disponible: " + e.message, "crit"); }
    }));

    const fp = document.getElementById("thProfiles");
    fp.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const next = profiles.map((p) => Object.assign({}, p));
      fp.querySelectorAll("[data-p]").forEach((inp) => { const v = inp.value === "" ? null : Number(inp.value); next[Number(inp.dataset.p)][inp.dataset.k] = v; });
      const errs = [];
      next.forEach((p) => T.validateProfile(p).forEach((e) => errs.push(p.name + ": " + e)));
      if (errs.length) return formErr(fp, errs.join(" · "));
      try { S.status = await gw("PUT", "/api/config", { profiles: next }); formErr(fp, ""); H.toast("Perfiles guardados."); render(); } catch (e) { formErr(fp, e.message); }
    });

    const fc = document.getElementById("thControl");
    fc.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const next = Object.assign({}, control);
      new FormData(fc).forEach((v, k) => { next[k] = k === "sensorErrorStrategy" ? v : Number(v); });
      const errs = T.validateControl(next);
      if (errs.length) return formErr(fc, errs.join(" · "));
      try { S.status = await gw("PUT", "/api/config", { control: next }); formErr(fc, ""); H.toast("Parámetros de control guardados."); } catch (e) { formErr(fc, e.message); }
    });
  }

  /** Gráfica OUT/IN de la caja con franjas de calefacción encendida y marcas de eventos. */
  async function drawChart(boxId) {
    const st = S.status, host = document.getElementById("thChart");
    if (!host || !st) { if (host) host.innerHTML = '<p class="muted-text">Necesita el gateway térmico para mostrar el estado de la calefacción.</p>'; return; }
    const box = st.boxes.find((b) => b.id === boxId);
    if (!box) return;
    const to = Date.now(), from = to - 48 * 3600000;
    const readings = (await App.store.readingsRange(from, to, box.sensorId)).sort((a, b) => a.ts - b.ts);
    const ev = S.events.filter((e) => e.box_id === boxId);
    const switches = ev.filter((e) => e.new_heater_state === "ON" || e.new_heater_state === "OFF").map((e) => ({ ts: e.ts, state: e.new_heater_state }));
    const bands = [];
    switches.forEach((s, i) => { if (s.state === "ON") bands.push({ from: s.ts, to: i + 1 < switches.length ? switches[i + 1].ts : to, label: "Calefacción encendida" }); });
    const SHORT = { SAFETY_SHUTDOWN: "SAFETY OFF", CRITICAL_TEMPERATURE: "SAFETY OFF", MANUAL_ON: "MANUAL ON", MANUAL_OFF: "MANUAL OFF", LOW_TEMPERATURE: "ON", HIGH_TEMPERATURE: "OFF", SENSOR_ERROR: "SENSOR", DEVICE_UNREACHABLE: "HS105?" };
    const markers = ev.filter((e) => SHORT[e.reason]).map((e) => ({ t: e.ts, label: e.reason + ": " + e.message, short: SHORT[e.reason], kind: /SAFETY|CRITICAL|UNREACHABLE|SENSOR/.test(e.reason) ? "crit" : "" }));
    const p = box.profile;
    window.MonCharts.render(host, {
      series: [
        { id: "out", label: "OUT · caja", cssVar: "--series-a", points: window.MonLogic.series(readings, box.sensorId, "tempOut", from, to, 600) },
        { id: "in", label: "IN · ambiente", cssVar: "--series-b", points: window.MonLogic.series(readings, box.sensorId, "tempIn", from, to, 600) },
      ],
      unit: "°C", decimals: 1, from, to, bands, markers,
      limits: [{ value: p.onAt, label: "enciende ≤" + p.onAt }, { value: p.offAt, label: "apaga ≥" + p.offAt }, { value: p.critical, label: "crítico " + p.critical }],
      ariaLabel: "Temperatura de caja y ambiente con periodos de calefacción",
    });
    const a = T.analyze(readings.filter((r) => r.tempOut != null).map((r) => ({ ts: r.ts, out: r.tempOut })), switches, p);
    document.getElementById("thAnalysis").innerHTML =
      '<p class="hint" style="margin-top:8px">Franjas sombreadas = calefacción encendida. Análisis (48 h): ' +
      H.esc([
        a.inRangePct != null ? a.inRangePct + " % del tiempo dentro del rango operativo" : null,
        a.cycles + " ciclos de encendido",
        a.avgOnMin != null ? "encendido promedio " + a.avgOnMin + " min" : null,
        a.avgOffMin != null ? "apagado promedio " + a.avgOffMin + " min" : null,
        a.onPct != null ? a.onPct + " % del tiempo encendida" : null,
        a.minutesToRise1C != null ? "sube 1 °C en ~" + a.minutesToRise1C + " min" : null,
        a.minutesToFall1C != null ? "baja 1 °C en ~" + a.minutesToFall1C + " min" : null,
      ].filter(Boolean).join(" · ")) + ". El consumo eléctrico no se estima: el HS105 no lo mide.</p>";
  }

  window.MonThermalUI = {
    attach(app, helpers) { App = app; H = helpers; },
    poll, onCycle, render, dashboardHtml, bindModeButtons,
    getStatus: () => (S.online ? S.status : null),
    get online() { return S.online; },
  };
})();
