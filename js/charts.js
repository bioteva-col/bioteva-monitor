/*
 * BioTeva Monitor — gráficas de líneas en SVG (sin librerías).
 *
 * Reglas: un solo eje Y por gráfica (temperatura y humedad van en gráficas
 * separadas); líneas de 2 px; la línea se corta donde no hubo datos (no se
 * inventa continuidad); leyenda + etiqueta directa al final de cada serie;
 * cruz vertical + tooltip con todas las series; accesible por teclado.
 *
 *   MonCharts.buildSvg(opts, width) → { svg, layout }   (puro, probado en Node)
 *   MonCharts.render(container, opts)                   (DOM + interacción)
 *
 * opts: { series: [{ id, label, cssVar, points: [{ t, v }] }], unit, decimals,
 *         from, to, height, limits: [{ value, label }], emptyText }
 */
(function (root) {
  "use strict";

  var M = { l: 46, r: 92, t: 14, b: 30 };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }

  function niceStep(span, target) {
    var raw = span / Math.max(1, target), mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  }

  var HOUR = 3600000, DAY = 24 * HOUR;
  var pad2 = function (n) { return (n < 10 ? "0" : "") + n; };
  var MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

  function timeTicks(from, to, maxTicks) {
    var span = to - from;
    var steps = [15 * 60000, 30 * 60000, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];
    var step = steps.filter(function (s) { return span / s <= maxTicks; })[0] || 14 * DAY;
    var d = new Date(from);
    if (step >= DAY) d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    else {
      d.setSeconds(0, 0);
      var mins = d.getHours() * 60 + d.getMinutes(), sm = step / 60000;
      d.setHours(0, Math.ceil(mins / sm) * sm, 0, 0);
    }
    var out = [];
    for (var t = d.getTime(); t <= to; t = step >= DAY ? new Date(new Date(t).getFullYear(), new Date(t).getMonth(), new Date(t).getDate() + step / DAY).getTime() : t + step) {
      var x = new Date(t);
      var label = step >= DAY ? x.getDate() + " " + MONTHS[x.getMonth()] : pad2(x.getHours()) + ":" + pad2(x.getMinutes());
      if (step < DAY && x.getHours() === 0 && x.getMinutes() === 0) label = x.getDate() + " " + MONTHS[x.getMonth()];
      out.push({ t: t, label: label });
    }
    return out;
  }

  function fmtTip(t) {
    var d = new Date(t);
    return d.getDate() + " " + MONTHS[d.getMonth()] + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function buildSvg(opts, width) {
    var W = Math.max(280, width || 800), H = opts.height || 260;
    var dec = opts.decimals == null ? 1 : opts.decimals;
    var from = opts.from, to = opts.to;
    var all = [];
    opts.series.forEach(function (s) { s.points.forEach(function (p) { all.push(p.v); }); });
    (opts.limits || []).forEach(function (l) { if (l.value != null) all.push(l.value); });
    var hasData = opts.series.some(function (s) { return s.points.length > 0; });
    var lo = all.length ? Math.min.apply(null, all) : 0, hi = all.length ? Math.max.apply(null, all) : 1;
    if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
    var padY = (hi - lo) * 0.08;
    lo -= padY; hi += padY;
    var step = niceStep(hi - lo, 5);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;

    var pw = W - M.l - M.r, ph = H - M.t - M.b;
    var x = function (t) { return M.l + ((t - from) / Math.max(1, to - from)) * pw; };
    var y = function (v) { return M.t + (1 - (v - lo) / (hi - lo)) * ph; };
    var parts = [];
    parts.push('<svg class="chart-svg" viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc(opts.ariaLabel || "Gráfica") + '">');

    // cuadrícula y eje Y
    for (var v = lo; v <= hi + step / 2; v += step) {
      var yy = y(v).toFixed(1);
      parts.push('<line class="grid" x1="' + M.l + '" x2="' + (W - M.r) + '" y1="' + yy + '" y2="' + yy + '"/>');
      parts.push('<text class="axis" x="' + (M.l - 8) + '" y="' + yy + '" text-anchor="end" dominant-baseline="middle">' + esc(Number(v.toFixed(6)).toString()) + "</text>");
    }
    parts.push('<text class="axis unit" x="' + (M.l - 8) + '" y="' + (M.t - 4) + '" text-anchor="end">' + esc(opts.unit || "") + "</text>");
    // eje X
    var ticks = timeTicks(from, to, Math.max(3, Math.floor(pw / 90)));
    ticks.forEach(function (tk) {
      var xx = x(tk.t).toFixed(1);
      parts.push('<line class="tick" x1="' + xx + '" x2="' + xx + '" y1="' + (H - M.b) + '" y2="' + (H - M.b + 4) + '"/>');
      parts.push('<text class="axis" x="' + xx + '" y="' + (H - M.b + 17) + '" text-anchor="middle">' + esc(tk.label) + "</text>");
    });
    parts.push('<line class="baseline" x1="' + M.l + '" x2="' + (W - M.r) + '" y1="' + (H - M.b) + '" y2="' + (H - M.b) + '"/>');

    // franjas (p. ej. calefacción encendida) y marcas de eventos, detrás de las series
    (opts.bands || []).forEach(function (b) {
      var bx0 = Math.max(M.l, x(b.from)), bx1 = Math.min(W - M.r, x(b.to));
      if (bx1 <= bx0) return;
      parts.push('<rect class="band" x="' + bx0.toFixed(1) + '" y="' + M.t + '" width="' + (bx1 - bx0).toFixed(1) + '" height="' + ph + '"><title>' + esc(b.label || "") + '</title></rect>');
    });
    var lastLabelX = -Infinity;
    (opts.markers || []).slice().sort(function (a, b) { return a.t - b.t; }).forEach(function (m) {
      var mx = x(m.t);
      if (mx < M.l || mx > W - M.r) return;
      // eventos muy juntos: una sola etiqueta (el detalle queda en el tooltip y en el registro)
      if (mx - lastLabelX < 46) { parts.push('<line class="marker ' + esc(m.kind || "") + '" x1="' + mx.toFixed(1) + '" x2="' + mx.toFixed(1) + '" y1="' + M.t + '" y2="' + (H - M.b) + '"><title>' + esc(m.label) + '</title></line>'); return; }
      lastLabelX = mx;
      parts.push('<line class="marker ' + esc(m.kind || "") + '" x1="' + mx.toFixed(1) + '" x2="' + mx.toFixed(1) + '" y1="' + M.t + '" y2="' + (H - M.b) + '"><title>' + esc(m.label) + '</title></line>');
      parts.push('<text class="marker-label ' + esc(m.kind || "") + '" x="' + (mx + 3).toFixed(1) + '" y="' + (M.t + 10) + '">' + esc(m.short || "") + '</text>');
    });

    // límites configurados
    (opts.limits || []).forEach(function (l) {
      if (l.value == null) return;
      var ly = y(l.value).toFixed(1);
      parts.push('<line class="limit" x1="' + M.l + '" x2="' + (W - M.r) + '" y1="' + ly + '" y2="' + ly + '"/>');
      parts.push('<text class="limit-label" x="' + (W - M.r + 6) + '" y="' + ly + '" dominant-baseline="middle">' + esc(l.label) + "</text>");
    });

    // series (la línea se corta en huecos de datos)
    var endLabels = [];
    opts.series.forEach(function (s) {
      var pts = s.points;
      if (!pts.length) return;
      var dts = [];
      for (var i = 1; i < pts.length; i++) dts.push(pts[i].t - pts[i - 1].t);
      dts.sort(function (a, b) { return a - b; });
      var gap = (dts.length ? dts[dts.length >> 1] : 60000) * 3.5;
      var d = "", prev = null;
      pts.forEach(function (p) {
        var cmd = !prev || p.t - prev.t > gap ? "M" : "L";
        d += cmd + x(p.t).toFixed(1) + " " + y(p.v).toFixed(1);
        prev = p;
      });
      parts.push('<path class="series" d="' + d + '" style="stroke:var(' + s.cssVar + ')"/>');
      // puntos aislados (tramos de una sola lectura)
      pts.forEach(function (p, i) {
        var isolated = (i === 0 || p.t - pts[i - 1].t > gap) && (i === pts.length - 1 || pts[i + 1].t - p.t > gap);
        if (isolated) parts.push('<circle class="dot" cx="' + x(p.t).toFixed(1) + '" cy="' + y(p.v).toFixed(1) + '" r="3" style="fill:var(' + s.cssVar + ')"/>');
      });
      var last = pts[pts.length - 1];
      endLabels.push({ y: y(last.v), x: x(last.t), s: s, v: last.v });
    });
    // etiquetas directas con separación mínima (con línea guía si se desplazan)
    endLabels.sort(function (a, b) { return a.y - b.y; });
    for (var k = 1; k < endLabels.length; k++) if (endLabels[k].y - endLabels[k - 1].y < 26) endLabels[k].ly = endLabels[k - 1].y + 26;
    endLabels.forEach(function (e) {
      var ly = e.ly != null ? e.ly : e.y, lx = W - M.r + 8;
      if (e.ly != null) parts.push('<line class="leader" x1="' + e.x.toFixed(1) + '" y1="' + e.y.toFixed(1) + '" x2="' + (lx - 2) + '" y2="' + ly.toFixed(1) + '"/>');
      parts.push('<circle cx="' + e.x.toFixed(1) + '" cy="' + e.y.toFixed(1) + '" r="4" class="enddot" style="fill:var(' + e.s.cssVar + ')"/>');
      parts.push('<text class="end-label" x="' + lx + '" y="' + (ly - 5).toFixed(1) + '">' + esc(e.s.label) + "</text>");
      parts.push('<text class="end-value" x="' + lx + '" y="' + (ly + 9).toFixed(1) + '">' + esc(e.v.toFixed(dec) + " " + (opts.unit || "")) + "</text>");
    });

    if (!hasData) parts.push('<text class="empty" x="' + (M.l + pw / 2) + '" y="' + (M.t + ph / 2) + '" text-anchor="middle">' + esc(opts.emptyText || "Sin datos confiables en este periodo") + "</text>");

    parts.push('<line class="crosshair" x1="0" x2="0" y1="' + M.t + '" y2="' + (H - M.b) + '" visibility="hidden"/>');
    parts.push('<rect class="hit" x="' + M.l + '" y="' + M.t + '" width="' + pw + '" height="' + ph + '" fill="transparent" tabindex="0" aria-label="Explorar valores con las flechas"/>');
    parts.push("</svg>");
    return { svg: parts.join(""), layout: { W: W, H: H, x: x, y: y, lo: lo, hi: hi, pw: pw, ph: ph } };
  }

  function render(container, opts) {
    var width = Math.floor(container.clientWidth || 800);
    var built = buildSvg(opts, width);
    container.innerHTML = "";
    var legend = document.createElement("div");
    legend.className = "chart-legend";
    opts.series.forEach(function (s) {
      var item = document.createElement("span");
      item.className = "legend-item";
      var key = document.createElement("i");
      key.className = "legend-key";
      key.style.background = "var(" + s.cssVar + ")";
      item.appendChild(key);
      item.appendChild(document.createTextNode(s.label));
      legend.appendChild(item);
    });
    container.appendChild(legend);
    var wrap = document.createElement("div");
    wrap.className = "chart-wrap";
    wrap.innerHTML = built.svg;
    var tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.hidden = true;
    wrap.appendChild(tip);
    container.appendChild(wrap);

    var svg = wrap.querySelector("svg"), cross = svg.querySelector(".crosshair"), hit = svg.querySelector(".hit");
    var L = built.layout, dec = opts.decimals == null ? 1 : opts.decimals;
    var times = [];
    opts.series.forEach(function (s) { s.points.forEach(function (p) { times.push(p.t); }); });
    times.sort(function (a, b) { return a - b; });
    var idx = -1;

    function nearest(points, t) {
      var best = null, bd = Infinity;
      for (var i = 0; i < points.length; i++) { var d = Math.abs(points[i].t - t); if (d < bd) { bd = d; best = points[i]; } }
      return best;
    }
    function show(t) {
      if (!times.length) return;
      var px = L.x(t);
      cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
      tip.hidden = false;
      tip.textContent = "";
      var head = document.createElement("div");
      head.className = "tip-head";
      head.textContent = fmtTip(t);
      tip.appendChild(head);
      var tol = (opts.to - opts.from) / 120;
      opts.series.forEach(function (s) {
        var p = nearest(s.points, t);
        var row = document.createElement("div");
        row.className = "tip-row";
        var key = document.createElement("i");
        key.className = "tip-key";
        key.style.background = "var(" + s.cssVar + ")";
        var val = document.createElement("b");
        val.textContent = p && Math.abs(p.t - t) <= Math.max(tol, 90000) ? p.v.toFixed(dec) + " " + (opts.unit || "") : "sin dato";
        var lab = document.createElement("span");
        lab.textContent = s.label;
        row.appendChild(key); row.appendChild(val); row.appendChild(lab);
        tip.appendChild(row);
      });
      var scale = wrap.clientWidth / L.W;
      var left = px * scale + 12;
      if (left + 190 > wrap.clientWidth) left = px * scale - 200;
      tip.style.left = Math.max(0, left) + "px";
      tip.style.top = "8px";
    }
    function hide() { cross.setAttribute("visibility", "hidden"); tip.hidden = true; }
    function tFromEvent(ev) {
      var rect = svg.getBoundingClientRect();
      var sx = ((ev.clientX - rect.left) / rect.width) * L.W;
      return opts.from + ((sx - 46) / L.pw) * (opts.to - opts.from);
    }
    function snap(t) {
      var best = times[0], bd = Infinity;
      for (var i = 0; i < times.length; i++) { var d = Math.abs(times[i] - t); if (d < bd) { bd = d; best = times[i]; idx = i; } }
      return best;
    }
    hit.addEventListener("pointermove", function (ev) { if (times.length) show(snap(tFromEvent(ev))); });
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("blur", hide);
    hit.addEventListener("keydown", function (ev) {
      if (!times.length) return;
      if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
        ev.preventDefault();
        idx = idx < 0 ? times.length - 1 : Math.max(0, Math.min(times.length - 1, idx + (ev.key === "ArrowRight" ? 1 : -1)));
        show(times[idx]);
      }
    });
  }

  root.MonCharts = { buildSvg: buildSvg, render: render, timeTicks: timeTicks };
})(typeof self !== "undefined" ? self : globalThis);
