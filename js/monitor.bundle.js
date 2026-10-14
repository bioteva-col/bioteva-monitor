/* BioTeva Monitor — paquete generado por `npm run build:monitor`. NO editar: edita js/*.js y reconstruye. */

/* ===== boot.js ===== */
/*
 * BioTeva Monitor — arranque. Se carga PRIMERO: si algo falla al iniciar, el
 * error se muestra en pantalla (en vez de una página en blanco) con qué hacer.
 */
(function () {
  "use strict";
  var shown = false;
  function show(msg) {
    if (shown || window.BioTevaMonitorReady) return;
    shown = true;
    var box = document.getElementById("bootMsg");
    if (!box) return;
    box.hidden = false;
    box.className = "boot boot-error";
    box.textContent = "";
    var b = document.createElement("b");
    b.textContent = "BioTeva Monitor no pudo iniciar.";
    var p = document.createElement("p");
    p.textContent = msg;
    var h = document.createElement("p");
    h.textContent = "Prueba recargar (Ctrl+F5). Si sigue igual, abre la app con deploy\\run-monitor.cmd o como extensión, y envía este mensaje a soporte.";
    box.appendChild(b); box.appendChild(p); box.appendChild(h);
  }
  window.addEventListener("error", function (e) {
    show((e.message || "Error") + (e.filename ? " — " + e.filename.split("/").pop() + ":" + e.lineno : ""));
  });
  window.addEventListener("unhandledrejection", function (e) {
    show(String((e.reason && e.reason.message) || e.reason));
  });
  // Si tras 20 s la app no arrancó y no hubo error visible, avisar igualmente.
  setTimeout(function () { if (!window.BioTevaMonitorReady) show("La app tardó demasiado en cargar sus archivos."); }, 20000);
})();


/* ===== segments.js ===== */
/*
 * BioTeva Monitor — procesamiento de imagen y lector de displays de 7 segmentos.
 *
 * Por qué un lector propio y no Tesseract: el HTC-2 usa un LCD de 7 segmentos.
 * Los motores OCR generales (Tesseract, etc.) están entrenados con tipografías
 * impresas y confunden los dígitos segmentados; además pesan varios MB y cargan
 * modelos desde internet. Aquí cada dígito se lee midiendo la "tinta" en la
 * posición conocida de sus 7 segmentos: es determinista, 100 % local, no
 * necesita red y tarda ~1 ms por sensor.
 *
 * Todas las funciones trabajan sobre imágenes en gris { w, h, d: Uint8ClampedArray }.
 * Script clásico (sin módulos) para funcionar igual en la página, la PWA y la
 * extensión de Chrome; expone `MonSeg` en el objeto global.
 */
(function (root) {
  "use strict";

  // ─────────────────────────── imágenes base ───────────────────────────

  function gray(w, h, fill) {
    var d = new Uint8ClampedArray(w * h);
    if (fill) d.fill(fill);
    return { w: w, h: h, d: d };
  }

  function fromRGBA(rgba, w, h) {
    var out = gray(w, h), d = out.d;
    for (var i = 0, j = 0; i < d.length; i++, j += 4) {
      d[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000;
    }
    return out;
  }

  function toRGBA(img, target) {
    var n = img.w * img.h, out = target || new Uint8ClampedArray(n * 4);
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      var v = img.d[i];
      out[j] = out[j + 1] = out[j + 2] = v;
      out[j + 3] = 255;
    }
    return out;
  }

  /** Muestreo bilineal (coordenadas fuera de la imagen → borde). */
  function sample(img, x, y) {
    var w = img.w, h = img.h, d = img.d;
    if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
    if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
    var x0 = x | 0, y0 = y | 0;
    var x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
    var fx = x - x0, fy = y - y0;
    var a = d[y0 * w + x0] + (d[y0 * w + x1] - d[y0 * w + x0]) * fx;
    var b = d[y1 * w + x0] + (d[y1 * w + x1] - d[y1 * w + x0]) * fx;
    return a + (b - a) * fy;
  }

  // ─────────────────────────── geometría ───────────────────────────

  /**
   * Homografía que lleva puntos de `dst` a puntos de `src` (4 correspondencias,
   * eliminación gaussiana con pivoteo parcial). Devuelve 9 coeficientes o null.
   */
  function homography(src, dst) {
    var A = [], i, r, c, k;
    for (i = 0; i < 4; i++) {
      var u = dst[i].x, v = dst[i].y, x = src[i].x, y = src[i].y;
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
    }
    for (c = 0; c < 8; c++) {
      var p = c;
      for (r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-12) return null;
      var t = A[c]; A[c] = A[p]; A[p] = t;
      for (r = 0; r < 8; r++) {
        if (r === c) continue;
        var f = A[r][c] / A[c][c];
        if (!f) continue;
        for (k = c; k < 9; k++) A[r][k] -= f * A[c][k];
      }
    }
    var h = [];
    for (c = 0; c < 8; c++) h.push(A[c][8] / A[c][c]);
    h.push(1);
    return h;
  }

  function applyH(h, u, v) {
    var z = h[6] * u + h[7] * v + h[8];
    return { x: (h[0] * u + h[1] * v + h[2]) / z, y: (h[3] * u + h[4] * v + h[5]) / z };
  }

  /**
   * Recorta el cuadrilátero `quad` (px, [sup-izq, sup-der, inf-der, inf-izq]) y
   * lo endereza a un rectángulo outW×outH: recorte + escala + rotación +
   * corrección de perspectiva en un solo paso. Fuera del frame → negro.
   */
  function warpQuad(img, quad, outW, outH) {
    var out = gray(outW, outH);
    var dst = [{ x: 0, y: 0 }, { x: outW - 1, y: 0 }, { x: outW - 1, y: outH - 1 }, { x: 0, y: outH - 1 }];
    var h = homography(quad, dst);
    if (!h) return out;
    for (var y = 0; y < outH; y++) {
      for (var x = 0; x < outW; x++) {
        var z = h[6] * x + h[7] * y + h[8];
        var px = (h[0] * x + h[1] * y + h[2]) / z, py = (h[3] * x + h[4] * y + h[5]) / z;
        out.d[y * outW + x] = px < -0.5 || py < -0.5 || px > img.w - 0.5 || py > img.h - 0.5 ? 0 : sample(img, px, py);
      }
    }
    return out;
  }

  /** Pinta `img` dentro del cuadrilátero `quad` de `frame` (usado por el simulador). */
  function placeImage(frame, img, quad) {
    var src = [{ x: 0, y: 0 }, { x: img.w - 1, y: 0 }, { x: img.w - 1, y: img.h - 1 }, { x: 0, y: img.h - 1 }];
    var h = homography(src, quad);
    if (!h) return;
    var xs = quad.map(function (p) { return p.x; }), ys = quad.map(function (p) { return p.y; });
    var x0 = Math.max(0, Math.floor(Math.min.apply(null, xs))), x1 = Math.min(frame.w - 1, Math.ceil(Math.max.apply(null, xs)));
    var y0 = Math.max(0, Math.floor(Math.min.apply(null, ys))), y1 = Math.min(frame.h - 1, Math.ceil(Math.max.apply(null, ys)));
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var p = applyH(h, x, y);
        if (p.x >= 0 && p.y >= 0 && p.x <= img.w - 1 && p.y <= img.h - 1) frame.d[y * frame.w + x] = sample(img, p.x, p.y);
      }
    }
  }

  /** Tamaño de salida razonable para un cuadrilátero (ancho fijo, alto según su proporción). */
  function rectifiedSize(quad, width) {
    var dist = function (a, b) { return Math.hypot(a.x - b.x, a.y - b.y); };
    var wAvg = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2;
    var hAvg = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
    var W = width || 480;
    var H = Math.round((W * hAvg) / Math.max(1, wAvg));
    return { w: W, h: Math.max(80, Math.min(1200, H)) };
  }

  // ─────────────────────────── preprocesamiento ───────────────────────────

  /** Reducción de ruido: promedio 3×3. */
  function boxBlur3(img) {
    var w = img.w, h = img.h, s = img.d, out = gray(w, h), d = out.d;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var sum = 0, n = 0;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            sum += s[yy * w + xx]; n++;
          }
        }
        d[y * w + x] = sum / n;
      }
    }
    return out;
  }

  /** Enfoque (unsharp mask ligero) para cámaras de baja resolución. */
  function sharpen(img, amount) {
    var a = amount == null ? 0.6 : amount, blur = boxBlur3(img), out = gray(img.w, img.h);
    for (var i = 0; i < img.d.length; i++) out.d[i] = img.d[i] + a * (img.d[i] - blur.d[i]);
    return out;
  }

  function histogram(img) {
    var hist = new Array(256).fill(0);
    for (var i = 0; i < img.d.length; i++) hist[img.d[i]]++;
    return hist;
  }

  function percentileFromHist(hist, total, p) {
    var target = total * p, acc = 0;
    for (var v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
    return 255;
  }

  /** Normalización de contraste por percentiles (2 %–98 %). */
  function normalize(img, lo, hi) {
    var hist = histogram(img), n = img.d.length;
    var a = percentileFromHist(hist, n, lo == null ? 0.02 : lo), b = percentileFromHist(hist, n, hi == null ? 0.98 : hi);
    var out = gray(img.w, img.h);
    var span = Math.max(1, b - a);
    for (var i = 0; i < n; i++) out.d[i] = ((img.d[i] - a) * 255) / span;
    return out;
  }

  /** Umbral de Otsu sobre un arreglo de valores 0–255. */
  function otsu(values) {
    var hist = new Array(256).fill(0), n = values.length, i;
    for (i = 0; i < n; i++) hist[Math.max(0, Math.min(255, Math.round(values[i])))]++;
    var sum = 0;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, best = 0, thr = 127;
    for (i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      var wF = n - wB;
      if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = i; }
    }
    return thr;
  }

  /** Binariza (útil para la vista de depuración de la calibración). */
  function threshold(img, t) {
    var out = gray(img.w, img.h), thr = t == null ? otsu(img.d) : t;
    for (var i = 0; i < img.d.length; i++) out.d[i] = img.d[i] > thr ? 255 : 0;
    return out;
  }

  function stats(img) {
    var hist = histogram(img), n = img.d.length, sum = 0, sq = 0;
    for (var i = 0; i < n; i++) { sum += img.d[i]; sq += img.d[i] * img.d[i]; }
    var mean = sum / n;
    return {
      mean: mean,
      std: Math.sqrt(Math.max(0, sq / n - mean * mean)),
      p1: percentileFromHist(hist, n, 0.01),
      p99: percentileFromHist(hist, n, 0.99),
    };
  }

  // ─────────────────────── miniaturas y comparación ───────────────────────

  /** Miniatura 32×24 promediando áreas (para comparar imágenes entre ciclos). */
  function thumbnail(img, tw, th) {
    tw = tw || 32; th = th || 24;
    var out = new Array(tw * th);
    for (var ty = 0; ty < th; ty++) {
      var y0 = Math.floor((ty * img.h) / th), y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * img.h) / th));
      for (var tx = 0; tx < tw; tx++) {
        var x0 = Math.floor((tx * img.w) / tw), x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * img.w) / tw));
        var sum = 0, n = 0;
        for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) { sum += img.d[y * img.w + x]; n++; }
        out[ty * tw + tx] = Math.round(sum / n);
      }
    }
    return out;
  }

  function zscores(a) {
    var n = a.length, m = 0, s = 0, i;
    for (i = 0; i < n; i++) m += a[i];
    m /= n;
    for (i = 0; i < n; i++) s += (a[i] - m) * (a[i] - m);
    s = Math.sqrt(s / n) || 1;
    return a.map(function (v) { return (v - m) / s; });
  }

  /**
   * Diferencia entre miniaturas, 0–100.
   *  - estructural (true): ignora cambios globales de luz; sirve para saber si el
   *    sensor se movió / salió del encuadre / quedó cubierto.
   *  - absoluta (false): cambio real de píxeles; sirve para saber si la imagen
   *    está "congelada" entre ciclos.
   */
  function thumbDiff(a, b, structural) {
    if (!a || !b || a.length !== b.length) return null;
    var i, sum = 0;
    if (structural) {
      var za = zscores(a), zb = zscores(b);
      for (i = 0; i < a.length; i++) sum += Math.abs(za[i] - zb[i]);
      return Math.min(100, Math.round(((sum / a.length) / 1.13) * 1000) / 10);
    }
    for (i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return Math.round(((sum / a.length) / 255) * 1000) / 10;
  }

  function thumbToB64(t) {
    var s = "";
    for (var i = 0; i < t.length; i++) s += String.fromCharCode(t[i]);
    return root.btoa(s);
  }
  function b64ToThumb(b64) {
    if (!b64) return null;
    try {
      var s = root.atob(b64), out = new Array(s.length);
      for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    } catch (e) { return null; }
  }

  // ─────────────────────────── 7 segmentos ───────────────────────────

  // Orden de bits: a b c d e f g.  Cajas relativas al dígito: [u0, u1, v0, v1].
  var SEG_NAMES = ["a", "b", "c", "d", "e", "f", "g"];
  /** Zonas de MUESTREO (algo más pequeñas que el segmento, tolerantes a desalineación). */
  var SAMPLE_BOX = [
    [0.3, 0.7, 0.015, 0.085], // a
    [0.87, 0.97, 0.18, 0.4], // b
    [0.87, 0.97, 0.6, 0.82], // c
    [0.3, 0.7, 0.915, 0.985], // d
    [0.03, 0.13, 0.6, 0.82], // e
    [0.03, 0.13, 0.18, 0.4], // f
    [0.3, 0.7, 0.47, 0.53], // g
  ];
  /** Huecos del "8": nunca llevan tinta → referencia del fondo. */
  var HOLE_BOX = [[0.32, 0.68, 0.2, 0.36], [0.32, 0.68, 0.64, 0.8]];
  /** Zonas de DIBUJO (simulador). */
  var DRAW_BOX = [
    [0.12, 0.88, 0.0, 0.11],
    [0.86, 1.0, 0.07, 0.48],
    [0.86, 1.0, 0.52, 0.93],
    [0.12, 0.88, 0.89, 1.0],
    [0.0, 0.14, 0.52, 0.93],
    [0.0, 0.14, 0.07, 0.48],
    [0.12, 0.88, 0.445, 0.555],
  ];
  /** Margen horizontal de la celda (separación entre dígitos). */
  var PADX = 0.08;

  var PATTERNS = {
    "1111110": "0", "0110000": "1", "1101101": "2", "1111001": "3", "0110011": "4",
    "1011011": "5", "1011111": "6", "0011111": "6", "1110000": "7", "1110010": "7",
    "1111111": "8", "1111011": "9", "1110011": "9",
    "0000001": "-", "0000000": " ", "0001110": "L", "0110111": "H",
  };
  var CANONICAL = {
    "0": "1111110", "1": "0110000", "2": "1101101", "3": "1111001", "4": "0110011",
    "5": "1011011", "6": "1011111", "7": "1110000", "8": "1111111", "9": "1111011",
    "-": "0000001", " ": "0000000", "L": "0001110", "H": "0110111",
  };

  /** Posición en px de un punto (u,v) del dígito `ci` de un campo, con inclinación. */
  function digitPoint(roi, ci, digits, u, v, tanSlant) {
    var cellW = roi.w / digits;
    var dx0 = roi.x + ci * cellW + cellW * PADX, dw = cellW * (1 - 2 * PADX);
    return { x: dx0 + u * dw + (0.5 - v) * roi.h * tanSlant, y: roi.y + v * roi.h };
  }

  function regionInk(img, roi, ci, digits, box, tanSlant, light) {
    var cellW = roi.w / digits, dw = cellW * (1 - 2 * PADX);
    var nu = Math.max(2, Math.min(10, Math.round((box[1] - box[0]) * dw)));
    var nv = Math.max(2, Math.min(10, Math.round((box[3] - box[2]) * roi.h)));
    var vals = [];
    for (var iu = 0; iu < nu; iu++) {
      for (var iv = 0; iv < nv; iv++) {
        var u = box[0] + ((box[1] - box[0]) * (iu + 0.5)) / nu;
        var v = box[2] + ((box[3] - box[2]) * (iv + 0.5)) / nv;
        var p = digitPoint(roi, ci, digits, u, v, tanSlant);
        var val = sample(img, p.x, p.y);
        vals.push(light ? val : 255 - val);
      }
    }
    return vals.sort(function (a, b) { return a - b; });
  }

  /**
   * Ventanas de BÚSQUEDA de cada segmento (más amplias que el segmento): se recorren
   * franjas finas (columnas para segmentos verticales, filas para horizontales) y se
   * toma la de más tinta. Así se toleran desalineaciones de ~±10 % y grosores de
   * trazo distintos entre modelos de display (p. ej. el HTC-2 real).
   */
  var SEARCH_BOX = [
    [0.22, 0.78, 0.0, 0.17, "h"], // a
    [0.7, 1.0, 0.13, 0.43, "v"], // b
    [0.68, 0.99, 0.57, 0.87, "v"], // c
    [0.22, 0.78, 0.83, 1.0, "h"], // d
    [0.0, 0.31, 0.57, 0.87, "v"], // e
    [0.01, 0.32, 0.13, 0.43, "v"], // f
    [0.22, 0.78, 0.41, 0.59, "h"], // g
  ];

  function segmentInk(img, roi, ci, digits, s, tanSlant, light) {
    var box = SEARCH_BOX[s], vertical = box[4] === "v";
    var cellW = roi.w / digits, dw = cellW * (1 - 2 * PADX);
    // franjas de ~el grosor de un trazo (12 % del ancho/alto del dígito)
    var span = vertical ? (box[1] - box[0]) : (box[3] - box[2]);
    var strips = Math.max(3, Math.min(9, Math.round(span / 0.04)));
    var best = -1;
    for (var k = 0; k < strips; k++) {
      var sub = vertical
        ? [box[0] + (span * k) / strips, box[0] + (span * (k + 1)) / strips, box[2] + (box[3] - box[2]) * 0.15, box[3] - (box[3] - box[2]) * 0.15]
        : [box[0] + (box[1] - box[0]) * 0.15, box[1] - (box[1] - box[0]) * 0.15, box[2] + (span * k) / strips, box[2] + (span * (k + 1)) / strips];
      var vals = regionInk(img, roi, ci, digits, sub, tanSlant, light);
      // mediana de la franja: un trazo real la llena; un borde vecino no
      var m = vals[vals.length >> 1];
      if (m > best) best = m;
    }
    return best;
  }

  var meanOf = function (arr) { var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i]; return arr.length ? s / arr.length : 0; };
  var median = function (sorted) { return sorted.length ? sorted[sorted.length >> 1] : 0; };

  /**
   * Lee un campo de 7 segmentos.
   * @param img imagen rectificada del sensor (gris)
   * @param roi { x, y, w, h } en px dentro de `img`
   * @param opts { digits, decimals, slantDeg, lightSegments, format: "number"|"time", minContrastAbs }
   * @returns { text, confidence 0–100, contrast 0–100, blank, digits: [{ ch, conf, bits }] }
   */
  function decodeField(img, roi, opts) {
    // Hora del HTC-2 («12:10»): los dos puntos dejan un hueco en el medio, así que las 4 cifras
    // no están repartidas en partes iguales. Se leen horas y minutos como dos bloques de 2
    // (medido en la foto del fabricante: horas 0–44 % del cuadro, minutos 56–100 %).
    if (opts.format === "time" && opts.digits === 4 && !opts._part) {
      // horas 0–23 (1.ª cifra vacía, 0, 1 o 2) y minutos 00–59 (1.ª cifra 0–5)
      var hh = decodeField(img, { x: roi.x, y: roi.y, w: roi.w * 0.44, h: roi.h }, Object.assign({}, opts, { digits: 2, decimals: 0, format: "number", _part: true, allow: [" 012", "0123456789"] }));
      var mm = decodeField(img, { x: roi.x + roi.w * 0.56, y: roi.y, w: roi.w * 0.44, h: roi.h }, Object.assign({}, opts, { digits: 2, decimals: 0, format: "number", _part: true, allow: ["012345", "0123456789"] }));
      if (hh.blank && mm.blank) return { text: "", confidence: 0, contrast: Math.max(hh.contrast, mm.contrast), blank: true, digits: [] };
      var hText = hh.text.trim(), mText = mm.text.trim();
      var both = hText && mText.length === 2;
      return {
        text: both ? hText + ":" + mText : (hText || "") + (mText ? ":" + mText : ""),
        confidence: both ? Math.min(hh.confidence, mm.confidence) : 0,
        contrast: Math.max(hh.contrast, mm.contrast), blank: false, digits: (hh.digits || []).concat(mm.digits || []),
      };
    }
    var digits = opts.digits, decimals = opts.decimals || 0, light = !!opts.lightSegments;
    var tanSlant = Math.tan(((opts.slantDeg || 0) * Math.PI) / 180);
    var segInk = [], holes = [], all = [], ci, s;

    for (ci = 0; ci < digits; ci++) {
      var row = [];
      for (s = 0; s < 7; s++) {
        var ink = segmentInk(img, roi, ci, digits, s, tanSlant, light);
        row.push(ink);
        all.push(ink);
      }
      segInk.push(row);
      for (var hb = 0; hb < HOLE_BOX.length; hb++) {
        var hv = regionInk(img, roi, ci, digits, HOLE_BOX[hb], tanSlant, light);
        holes.push(meanOf(hv.slice(0, hv.length >> 1)));
      }
    }

    // Niveles de referencia por 2-medias: 'apagado' (anclado en el fondo de los huecos del 8)
    // y 'encendido' (trazos). Más robusto que percentiles con imágenes borrosas.
    var bg = median(holes.slice().sort(function (a, b) { return a - b; }));
    var sortedAll = all.slice().sort(function (a, b) { return a - b; });
    var lo = Math.min(bg, sortedAll[0]), hi = sortedAll[sortedAll.length - 1];
    for (var it = 0; it < 12; it++) {
      var mid = (lo + hi) / 2, sl = 0, nl2 = 0, sh = 0, nh = 0;
      holes.forEach(function (v) { sl += v; nl2++; });
      all.forEach(function (v) { if (v > mid) { sh += v; nh++; } else { sl += v; nl2++; } });
      var nlo = nl2 ? sl / nl2 : lo, nhi = nh ? sh / nh : hi;
      if (Math.abs(nlo - lo) < 0.05 && Math.abs(nhi - hi) < 0.05) break;
      lo = nlo; hi = nhi;
    }
    var contrast = hi - lo;
    var contrast100 = Math.max(0, Math.round((contrast / 2.55) * 10) / 10);
    var minC = opts.minContrastAbs == null ? 20 : opts.minContrastAbs;
    if (contrast < minC) return { text: "", confidence: 0, contrast: contrast100, blank: true, digits: [] };

    // Decodificación suave: cada dígito es el patrón canónico más cercano a su perfil
    // de 7 segmentos (tinta normalizada 0–1); la confianza es el margen sobre el 2.º.
    var out = [], seenVisible = false;
    for (ci = 0; ci < digits; ci++) {
      var z = [], bits = "";
      for (s = 0; s < 7; s++) {
        var zz = Math.max(0, Math.min(1, (segInk[ci][s] - lo) / contrast));
        z.push(zz);
        bits += zz > 0.5 ? "1" : "0";
      }
      var ranked = Object.keys(CANONICAL).filter(function (c) {
        if (opts.allow && opts.allow[ci] && opts.allow[ci].indexOf(c) < 0) return false; // p. ej. hora: 1.ª cifra 0–2
        if (c === " ") return !seenVisible;         // blancos solo a la izquierda
        if (c === "-") return !seenVisible;         // signo solo como primer carácter
        return true;
      }).map(function (c) {
        var pat = CANONICAL[c], dd = 0;
        for (var k = 0; k < 7; k++) { var e = z[k] - (pat[k] === "1" ? 1 : 0); dd += e * e; }
        return { ch: c, d: dd };
      }).sort(function (a, b) { return a.d - b.d; });
      var best = ranked[0], second = ranked[1];
      var ch = best.ch, conf = Math.max(0, Math.min(1, second.d - best.d));
      if (best.d > 2.2) { ch = "?"; conf = 0; } // no se parece a ningún dígito
      if (ch !== " ") seenVisible = true;
      out.push({ ch: ch, conf: conf, bits: bits });
    }

    var chars = out.map(function (o) { return o.ch; });
    var first = chars.findIndex(function (c) { return c !== " "; });
    if (first < 0) return { text: "", confidence: 0, contrast: contrast100, blank: true, digits: out };
    var body = chars.slice(first).join("");
    var text;
    if (opts.format === "time") {
      text = body.length > 2 ? body.slice(0, -2) + ":" + body.slice(-2) : body;
    } else if (decimals > 0) {
      var sign = body[0] === "-" ? "-" : "", num = sign ? body.slice(1) : body;
      while (num.length <= decimals) num = "0" + num;
      text = sign + num.slice(0, num.length - decimals) + "." + num.slice(num.length - decimals);
    } else {
      text = body;
    }

    var confVals = out.slice(first).map(function (o) { return o.conf; });
    var minConf = Math.min.apply(null, confVals), avgConf = meanOf(confVals);
    var contrastFactor = Math.min(1, contrast / 60);
    var confidence = Math.round((0.5 * minConf + 0.5 * avgConf) * contrastFactor * 1000) / 10;
    return { text: text, confidence: confidence, contrast: contrast100, blank: false, digits: out };
  }

  // ─────────────────────── detección de pantallas ───────────────────────
  //
  // Un termohigrómetro tipo HTC-2 visto por la cámara es un MARCO NEGRO (bisel)
  // que encierra un RECTÁNGULO GRIS CLARO (el LCD). El detector busca exactamente
  // eso: componentes oscuros con forma de anillo cuyo interior es más claro, y
  // ajusta las 4 esquinas del interior (sirve con rotación y perspectiva).

  /** Reduce la imagen por un factor entero promediando bloques. */
  function downscale(img, f) {
    if (f <= 1) return img;
    var w = Math.floor(img.w / f), h = Math.floor(img.h / f), out = gray(w, h), n = f * f;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var s = 0;
        for (var dy = 0; dy < f; dy++) { var row = (y * f + dy) * img.w + x * f; for (var dx = 0; dx < f; dx++) s += img.d[row + dx]; }
        out.d[y * w + x] = s / n;
      }
    }
    return out;
  }

  /** Imagen integral (sumas acumuladas) para promedios locales en O(1). */
  function integral(img) {
    var w = img.w, h = img.h, I = new Float64Array((w + 1) * (h + 1));
    for (var y = 0; y < h; y++) {
      var run = 0;
      for (var x = 0; x < w; x++) { run += img.d[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + run; }
    }
    return I;
  }

  function quadArea(q) {
    var a = 0;
    for (var i = 0; i < 4; i++) { var p = q[i], n = q[(i + 1) % 4]; a += p.x * n.y - n.x * p.y; }
    return Math.abs(a) / 2;
  }

  function quadCenter(q) {
    return { x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 };
  }

  function pointInQuad(q, p) {
    var sign = 0;
    for (var i = 0; i < 4; i++) {
      var a = q[i], b = q[(i + 1) % 4], c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      if (c !== 0) { var s = c > 0 ? 1 : -1; if (sign && s !== sign) return false; sign = s; }
    }
    return true;
  }

  /**
   * Busca pantallas LCD enmarcadas por un bisel oscuro.
   * @returns [{ quad: [sup-izq, sup-der, inf-der, inf-izq] en px del frame, score, area, contrast }]
   *          ordenadas de izquierda a derecha.
   * opts: { minFrac (lado mínimo relativo al frame, 0.025), maxFrac (0.8), workWidth (640), radius }
   */
  function detectScreens(frame, opts) {
    opts = opts || {};
    var f = Math.max(1, Math.round(frame.w / (opts.workWidth || 640)));
    var img = downscale(frame, f), W = img.w, H = img.h, N = W * H, d = img.d;
    var I = integral(img), r = opts.radius ? Math.max(3, Math.round(opts.radius / f)) : Math.max(8, Math.round(W / 22));
    var minSide = Math.max(8, Math.round(Math.min(W, H) * (opts.minFrac || 0.025)));
    var maxW = W * (opts.maxFrac || 0.8), maxH = H * (opts.maxFrac || 0.8);

    // 1. Máscara de "muy oscuro respecto a su entorno" (el bisel negro).
    var dark = new Uint8Array(N);
    for (var y = 0; y < H; y++) {
      var y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
      for (var x = 0; x < W; x++) {
        var x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
        var mean = (I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
        var v = d[y * W + x];
        dark[y * W + x] = v < 45 || (v < 135 && v < mean * 0.78) ? 1 : 0;
      }
    }

    // 2. Componentes conexos (8-vecindad) del bisel.
    var label = new Int32Array(N), stack = new Int32Array(N), comps = [], nl = 0;
    for (var i = 0; i < N; i++) {
      if (!dark[i] || label[i]) continue;
      nl++;
      var sp = 0, minx = W, maxx = 0, miny = H, maxy = 0, cnt = 0, sum = 0;
      stack[sp++] = i; label[i] = nl;
      while (sp) {
        var p = stack[--sp], px = p % W, py = (p - px) / W;
        cnt++; sum += d[p];
        if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py;
        for (var dy2 = -1; dy2 <= 1; dy2++) {
          var ny = py + dy2;
          if (ny < 0 || ny >= H) continue;
          for (var dx2 = -1; dx2 <= 1; dx2++) {
            var nx = px + dx2;
            if (nx < 0 || nx >= W) continue;
            var q = ny * W + nx;
            if (dark[q] && !label[q]) { label[q] = nl; stack[sp++] = q; }
          }
        }
      }
      var bw = maxx - minx + 1, bh = maxy - miny + 1;
      if (bw >= minSide && bh >= minSide && bw <= maxW && bh <= maxH && cnt >= (bw + bh)) comps.push({ id: nl, minx: minx, maxx: maxx, miny: miny, maxy: maxy, cnt: cnt, mean: sum / cnt });
    }

    // 3. Interior de cada anillo: lo que no se alcanza desde el borde sin cruzar el bisel.
    var out = [], dbg = opts.debug ? [] : null;
    var reject = function (c, why, extra) { if (dbg) dbg.push(Object.assign({ bbox: [c.minx * f, c.miny * f, (c.maxx + 1) * f, (c.maxy + 1) * f], why: why }, extra || {})); };
    comps.forEach(function (c) {
      var bx0 = Math.max(0, c.minx - 1), bx1 = Math.min(W - 1, c.maxx + 1), by0 = Math.max(0, c.miny - 1), by1 = Math.min(H - 1, c.maxy + 1);
      var bw = bx1 - bx0 + 1, bh = by1 - by0 + 1, seen = new Uint8Array(bw * bh), sp = 0, k, xx, yy;
      var wall = function (lx, ly) { return label[(ly + by0) * W + lx + bx0] === c.id; };
      var push = function (lx, ly) { var o = ly * bw + lx; if (!seen[o] && !wall(lx, ly)) { seen[o] = 1; stack[sp++] = o; } };
      for (xx = 0; xx < bw; xx++) { push(xx, 0); push(xx, bh - 1); }
      for (yy = 0; yy < bh; yy++) { push(0, yy); push(bw - 1, yy); }
      while (sp) {
        var o = stack[--sp], lx = o % bw, ly = (o - lx) / bw;
        if (lx > 0) push(lx - 1, ly);
        if (lx < bw - 1) push(lx + 1, ly);
        if (ly > 0) push(lx, ly - 1);
        if (ly < bh - 1) push(lx, ly + 1);
      }
      // Región = bisel + todo lo que encierra (el LCD). A veces la región queda
      // pegada a otros objetos oscuros (botellas, cables, sombras): se erosiona a
      // varias escalas y cada trozo que se separa se evalúa por su cuenta. El
      // cuerpo sólido del equipo sobrevive a la erosión; los puentes delgados no.
      // Distancia al exterior con chamfer 3-4 (aprox. euclidiana, en tercios de px).
      var dist = new Uint16Array(bw * bh);
      for (yy = 0; yy < bh; yy++) for (xx = 0; xx < bw; xx++) {
        k = yy * bw + xx;
        if (seen[k]) { dist[k] = 0; continue; }
        var v1 = xx > 0 ? dist[k - 1] + 3 : 3, v2 = yy > 0 ? dist[k - bw] + 3 : 3;
        var v3 = xx > 0 && yy > 0 ? dist[k - bw - 1] + 4 : 4, v4 = xx < bw - 1 && yy > 0 ? dist[k - bw + 1] + 4 : 4;
        dist[k] = Math.min(v1, v2, v3, v4);
      }
      var maxD = 0;
      for (yy = bh - 1; yy >= 0; yy--) for (xx = bw - 1; xx >= 0; xx--) {
        k = yy * bw + xx;
        if (!dist[k]) continue;
        var w1 = xx < bw - 1 ? dist[k + 1] + 3 : 3, w2 = yy < bh - 1 ? dist[k + bw] + 3 : 3;
        var w3 = xx < bw - 1 && yy < bh - 1 ? dist[k + bw + 1] + 4 : 4, w4 = xx > 0 && yy < bh - 1 ? dist[k + bw - 1] + 4 : 4;
        dist[k] = Math.min(dist[k], w1, w2, w3, w4);
        if (dist[k] > maxD) maxD = dist[k];
      }
      var blob = new Int32Array(bw * bh), found = 0;
      [1, 2, 3, 5, 8, 12].forEach(function (e) {
        if (e * 3 >= maxD) return;
        blob.fill(0);
        for (var st = 0; st < bw * bh; st++) {
          if (dist[st] <= e * 3 || blob[st]) continue;
          // un trozo conexo del núcleo erosionado
          var n = 0, s = 0, s2 = 0, tl = null, br = null, tr = null, bl = null, bTL = Infinity, bBR = -Infinity, bTR = -Infinity, bBL = Infinity;
          sp = 0; stack[sp++] = st; blob[st] = 1;
          while (sp) {
            var o2 = stack[--sp], lx2 = o2 % bw, ly2 = (o2 - lx2) / bw, gx = lx2 + bx0, gy = ly2 + by0, val = d[gy * W + gx];
            n++; s += val; s2 += val * val;
            if (gx + gy < bTL) { bTL = gx + gy; tl = { x: gx, y: gy }; }
            if (gx + gy > bBR) { bBR = gx + gy; br = { x: gx, y: gy }; }
            if (gx - gy > bTR) { bTR = gx - gy; tr = { x: gx, y: gy }; }
            if (gx - gy < bBL) { bBL = gx - gy; bl = { x: gx, y: gy }; }
            if (lx2 > 0 && !blob[o2 - 1] && dist[o2 - 1] > e * 3) { blob[o2 - 1] = 1; stack[sp++] = o2 - 1; }
            if (lx2 < bw - 1 && !blob[o2 + 1] && dist[o2 + 1] > e * 3) { blob[o2 + 1] = 1; stack[sp++] = o2 + 1; }
            if (ly2 > 0 && !blob[o2 - bw] && dist[o2 - bw] > e * 3) { blob[o2 - bw] = 1; stack[sp++] = o2 - bw; }
            if (ly2 < bh - 1 && !blob[o2 + bw] && dist[o2 + bw] > e * 3) { blob[o2 + bw] = 1; stack[sp++] = o2 + bw; }
          }
          if (n < minSide * minSide * 0.3) continue;
          var cand = evaluate(c, n, s, s2, [
            { x: tl.x, y: tl.y }, { x: tr.x + 1, y: tr.y }, { x: br.x + 1, y: br.y + 1 }, { x: bl.x, y: bl.y + 1 },
          ], e);
          if (cand) { out.push(cand); found++; }
        }
      });
      if (!found) reject(c, dbgWhy || "sin trozo válido", dbgInfo);
    });

    var dbgWhy = null, dbgInfo = null;
    /** Valida un núcleo (esquinas del trozo erosionado) y devuelve el candidato o null. */
    function evaluate(c, n, s, s2, core, e) {
      var rect = n / Math.max(1, quadArea(core)); // ~1 si es un cuadrilátero lleno (no una mancha irregular)
      var quad = [
        { x: core[0].x - e, y: core[0].y - e }, { x: core[1].x + e, y: core[1].y - e },
        { x: core[2].x + e, y: core[2].y + e }, { x: core[3].x - e, y: core[3].y + e },
      ];
      var qa = quadArea(quad);
      var len = function (a, b) { return Math.hypot(a.x - b.x, a.y - b.y); };
      var qw = (len(quad[0], quad[1]) + len(quad[3], quad[2])) / 2, qh = (len(quad[0], quad[3]) + len(quad[1], quad[2])) / 2;
      var aspect = qw / Math.max(1, qh);
      if (rect < 0.78 || rect > 1.3 || aspect < 0.8 || aspect > 2.6 || qw < minSide || qh < minSide || qw > maxW || qh > maxH) {
        dbgWhy = "forma"; dbgInfo = { rect: rect, aspect: aspect, level: e };
        return null;
      }
      var inner = s / n, std = Math.sqrt(Math.max(0, s2 / n - inner * inner));
      // Entorno (carcasa): franja alrededor del cuadrilátero, debe ser más clara.
      var qc = quadCenter(quad), ring = 0, rn = 0;
      for (var t = 0; t < 4; t++) {
        var a = quad[t], b = quad[(t + 1) % 4];
        for (var u = 0.1; u < 0.95; u += 0.1) {
          var ex = a.x + (b.x - a.x) * u, ey = a.y + (b.y - a.y) * u;
          for (var m = 1.12; m <= 1.3; m += 0.06) {
            var sx = Math.round(qc.x + (ex - qc.x) * m), sy = Math.round(qc.y + (ey - qc.y) * m);
            if (sx >= 0 && sy >= 0 && sx < W && sy < H) { ring += d[sy * W + sx]; rn++; }
          }
        }
      }
      var contrast = rn ? ring / rn - inner : 0;
      if (contrast < 28) { dbgWhy = "contraste"; dbgInfo = { contrast: contrast, rect: rect, aspect: aspect, level: e }; return null; }
      // la rectangularidad pesa mucho: entre escalas de erosión gana el núcleo más limpio, no el más grande
      var score = n * Math.pow(Math.min(1, rect, 2 - rect), 6) * Math.min(1, contrast / 80) * (0.6 + Math.min(0.4, std / 60));
      return { quad: quad, score: score, area: qa, contrast: contrast, rect: rect, aspect: aspect, texture: std, level: e };
    }

    // 4. Un candidato por objeto (varias escalas de erosión o recuadros anidados):
    //    se queda el de mejor puntaje; luego se vuelve a coordenadas del frame.
    out.sort(function (a, b) { return b.score - a.score; });
    var kept = [];
    out.forEach(function (c) {
      var cc = quadCenter(c.quad);
      if (kept.some(function (k) { return pointInQuad(k.quad, cc) || pointInQuad(c.quad, quadCenter(k.quad)); })) return;
      kept.push(c);
    });
    kept.forEach(function (c) { c.quad = c.quad.map(function (p) { return { x: p.x * f, y: p.y * f }; }); c.area *= f * f; });
    kept.sort(function (a, b) { return quadCenter(a.quad).x - quadCenter(b.quad).x; });
    if (dbg) kept.debug = dbg;
    return kept;
  }

  /**
   * Detector del LCD directamente: un rectángulo más claro rodeado por un borde
   * más oscuro (el marco negro), medido contra su entorno INMEDIATO. No importa
   * lo que haya detrás del equipo (cables u objetos oscuros pegados al marco):
   * solo cuenta el salto LCD → marco alrededor de la pantalla.
   * @returns [{ quad (LCD, px del frame), score, area, contrast, texture }]
   */
  function detectLcdHoles(frame, opts) {
    opts = opts || {};
    var f = Math.max(1, Math.round(frame.w / (opts.workWidth || 640)));
    var img = downscale(frame, f), W = img.w, H = img.h, N = W * H, d = img.d;
    var I = integral(img), r = opts.radius ? Math.max(2, Math.round(opts.radius / f)) : Math.max(3, Math.round(W / 70));
    var minSide = Math.max(8, Math.round(Math.min(W, H) * (opts.minFrac || 0.035)));
    var maxW = W * (opts.maxFrac || 0.7), maxH = H * (opts.maxFrac || 0.7);
    // "Más oscuro que su vecindad cercana": abraza el borde LCD→marco aunque el marco se funda con el fondo.
    var dark = new Uint8Array(N);
    for (var y = 0; y < H; y++) {
      var y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
      for (var x = 0; x < W; x++) {
        var x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
        var mean = (I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
        var v = d[y * W + x];
        dark[y * W + x] = v < mean * 0.9 - 2 ? 1 : 0;
      }
    }
    // Regiones claras = componentes 4-conexos de lo NO oscuro. Un LCD es una región
    // clara que no toca el borde de la imagen, rectangular y con dígitos adentro.
    var lab = new Int32Array(N), stack = new Int32Array(N), out = [], nl = 0;
    for (var i = 0; i < N; i++) {
      if (dark[i] || lab[i]) continue;
      nl++;
      var sp = 0, minx = W, maxx = 0, miny = H, maxy = 0, cnt = 0, touches = false;
      stack[sp++] = i; lab[i] = nl;
      var pix = [];
      while (sp) {
        var p = stack[--sp], px = p % W, py = (p - px) / W;
        cnt++; pix.push(p);
        if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py;
        if (px === 0 || py === 0 || px === W - 1 || py === H - 1) touches = true;
        if (px > 0 && !dark[p - 1] && !lab[p - 1]) { lab[p - 1] = nl; stack[sp++] = p - 1; }
        if (px < W - 1 && !dark[p + 1] && !lab[p + 1]) { lab[p + 1] = nl; stack[sp++] = p + 1; }
        if (py > 0 && !dark[p - W] && !lab[p - W]) { lab[p - W] = nl; stack[sp++] = p - W; }
        if (py < H - 1 && !dark[p + W] && !lab[p + W]) { lab[p + W] = nl; stack[sp++] = p + W; }
      }
      var bw = maxx - minx + 1, bh = maxy - miny + 1;
      if (opts.debug && bw >= minSide && bh >= minSide) opts.debug.push({ stage: "región", bbox: [minx * f, miny * f, (maxx + 1) * f, (maxy + 1) * f], cnt: cnt, touches: touches });
      if (touches || bw < minSide || bh < minSide || bw > maxW || bh > maxH || cnt < minSide * minSide * 0.5) continue;
      // Rellenar huecos (los dígitos oscuros dentro del LCD) para medir la forma del LCD completo.
      var bx0 = minx, by0 = miny, fill = new Uint8Array(bw * bh), outside = new Uint8Array(bw * bh), k;
      pix.forEach(function (q) { var qx = q % W, qy = (q - qx) / W; fill[(qy - by0) * bw + qx - bx0] = 1; });
      var st = [], push = function (lx, ly) { var o = ly * bw + lx; if (!fill[o] && !outside[o]) { outside[o] = 1; st.push(o); } };
      for (var xx = 0; xx < bw; xx++) { push(xx, 0); push(xx, bh - 1); }
      for (var yy = 0; yy < bh; yy++) { push(0, yy); push(bw - 1, yy); }
      while (st.length) {
        var o = st.pop(), lx = o % bw, ly = (o - lx) / bw;
        if (lx > 0) push(lx - 1, ly); if (lx < bw - 1) push(lx + 1, ly); if (ly > 0) push(lx, ly - 1); if (ly < bh - 1) push(lx, ly + 1);
      }
      var n = 0, s = 0, s2 = 0, tl = null, br = null, tr = null, bl = null, bTL = Infinity, bBR = -Infinity, bTR = -Infinity, bBL = Infinity;
      for (yy = 0; yy < bh; yy++) for (xx = 0; xx < bw; xx++) {
        k = yy * bw + xx;
        if (outside[k]) continue;
        var gx = xx + bx0, gy = yy + by0, val = d[gy * W + gx];
        n++; s += val; s2 += val * val;
        if (gx + gy < bTL) { bTL = gx + gy; tl = { x: gx, y: gy }; }
        if (gx + gy > bBR) { bBR = gx + gy; br = { x: gx + 1, y: gy + 1 }; }
        if (gx - gy > bTR) { bTR = gx - gy; tr = { x: gx + 1, y: gy }; }
        if (gx - gy < bBL) { bBL = gx - gy; bl = { x: gx, y: gy + 1 }; }
      }
      var quad = [tl, tr, br, bl];
      var qa = quadArea(quad), rect = n / Math.max(1, qa);
      var len = function (a, b) { return Math.hypot(a.x - b.x, a.y - b.y); };
      var qw = (len(quad[0], quad[1]) + len(quad[3], quad[2])) / 2, qh = (len(quad[0], quad[3]) + len(quad[1], quad[2])) / 2;
      var aspect = qw / Math.max(1, qh);
      if (opts.debug) opts.debug.push({ stage: "forma", bbox: [minx * f, miny * f, (maxx + 1) * f, (maxy + 1) * f], rect: rect, aspect: aspect });
      if (rect < 0.85 || rect > 1.2 || aspect < 1.0 || aspect > 2.4 || qw < minSide || qh < minSide) continue;
      var inner = s / n, std = Math.sqrt(Math.max(0, s2 / n - inner * inner));
      // Marco: franja justo afuera del LCD, debe ser más oscura.
      var qc = quadCenter(quad), ring = 0, rn = 0;
      for (var t = 0; t < 4; t++) {
        var a = quad[t], b = quad[(t + 1) % 4];
        for (var u = 0.15; u < 0.9; u += 0.07) {
          var ex = a.x + (b.x - a.x) * u, ey = a.y + (b.y - a.y) * u;
          for (var m = 1.04; m <= 1.1; m += 0.03) {
            var sx = Math.round(qc.x + (ex - qc.x) * m), sy = Math.round(qc.y + (ey - qc.y) * m);
            if (sx >= 0 && sy >= 0 && sx < W && sy < H) { ring += d[sy * W + sx]; rn++; }
          }
        }
      }
      var contrast = rn ? inner - ring / rn : 0;
      // Un LCD con lectura tiene dígitos: textura interna moderada.
      if (opts.debug) opts.debug.push({ stage: "contraste", bbox: [minx * f, miny * f, (maxx + 1) * f, (maxy + 1) * f], contrast: contrast, std: std });
      if (contrast < 15 || std < 3) continue;
      var score = n * Math.pow(Math.min(1, rect, 2 - rect), 6) * Math.min(1, contrast / 40) * Math.min(1, std / 10);
      out.push({ quad: quad, score: score, area: qa, contrast: contrast, texture: std, rect: rect, aspect: aspect, kind: "lcd" });
    }
    out.sort(function (a, b) { return b.score - a.score; });
    var kept = [];
    out.forEach(function (c) {
      var cc = quadCenter(c.quad);
      var j = kept.findIndex(function (k2) { return pointInQuad(k2.quad, cc) || pointInQuad(c.quad, quadCenter(k2.quad)); });
      if (j < 0) { kept.push(c); return; }
      // Anidados (p. ej. carcasa clara que rodea todo el equipo): gana la pantalla de adentro
      // si contrasta más con su marco — el LCD es lo más interno enmarcado en oscuro.
      var k2 = kept[j];
      if (c.area < k2.area && c.area >= 0.15 * k2.area && c.contrast > k2.contrast) kept[j] = c;
    });
    kept.forEach(function (c) { c.quad = c.quad.map(function (p) { return { x: p.x * f, y: p.y * f }; }); c.area *= f * f; });
    return kept;
  }

  /**
   * Pantallas LCD encontradas por los dos métodos (LCD directo y marco+interior),
   * ya afinadas al borde del LCD. Sin duplicados, de mejor a peor.
   */
  function detectLcds(frame, opts) {
    opts = opts || {};
    var list = detectLcdHoles(frame, opts).map(function (c) { return { quad: refineEdges(frame, c.quad), score: c.score, area: c.area, kind: "lcd" }; });
    detectScreens(frame, opts).forEach(function (c) {
      var q = innerScreen(frame, c.quad), cc = quadCenter(q);
      if (list.some(function (l) { return pointInQuad(l.quad, cc) || pointInQuad(q, quadCenter(l.quad)); })) return;
      list.push({ quad: q, score: c.score * 0.8, area: quadArea(q), kind: "marco" });
    });
    return list.sort(function (a, b) { return b.score - a.score; });
  }

  /**
   * Asocia pantallas detectadas a sensores conocidos (seguimiento).
   * prev: [{ id, quad }] (px) · found: salida de detectScreens.
   * Devuelve { id: quad | null } eligiendo, para cada sensor, la pantalla más
   * cercana a su posición anterior con tamaño parecido (sin repetir pantallas).
   */
  function matchScreens(prev, found, frameW, frameH) {
    var diag = Math.hypot(frameW, frameH), pairs = [];
    prev.forEach(function (s) {
      var c0 = quadCenter(s.quad), a0 = quadArea(s.quad);
      found.forEach(function (f, j) {
        var ratio = f.area / Math.max(1, a0);
        if (ratio < 0.35 || ratio > 2.8) return;
        var c1 = quadCenter(f.quad);
        pairs.push({ id: s.id, j: j, cost: Math.hypot(c1.x - c0.x, c1.y - c0.y) / diag + Math.abs(Math.log(ratio)) * 0.15 });
      });
    });
    pairs.sort(function (a, b) { return a.cost - b.cost; });
    var res = {}, usedS = {}, usedF = {};
    prev.forEach(function (s) { res[s.id] = null; });
    pairs.forEach(function (p) {
      if (usedS[p.id] || usedF[p.j]) return;
      usedS[p.id] = usedF[p.j] = true;
      res[p.id] = found[p.j].quad;
    });
    return res;
  }

  /** Recorte rectangular (px enteros, recortado a los bordes del frame). */
  function cropGray(img, x, y, w, h) {
    x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
    w = Math.max(1, Math.min(img.w - x, Math.floor(w))); h = Math.max(1, Math.min(img.h - y, Math.floor(h)));
    var out = gray(w, h);
    for (var yy = 0; yy < h; yy++) out.d.set(img.d.subarray((y + yy) * img.w + x, (y + yy) * img.w + x + w), yy * w);
    return { img: out, x: x, y: y };
  }

  function shiftQuad(q, dx, dy) { return q.map(function (p) { return { x: p.x + dx, y: p.y + dy }; }); }

  /**
   * Ajuste local: el usuario hace clic sobre la pantalla de un sensor y se busca
   * el bisel solo alrededor de ese punto (mucho más fiable que en toda la escena).
   * @returns candidato de detectScreens (quad en px del frame) o null
   */
  function fitScreenAt(frame, pt, opts) {
    opts = opts || {};
    var sizes = opts.windows || [0.22, 0.32, 0.45];
    for (var i = 0; i < sizes.length; i++) {
      var ww = frame.w * sizes[i], wh = Math.min(frame.h, ww * 0.9);
      var c = cropGray(frame, pt.x - ww / 2, pt.y - wh / 2, ww, wh);
      var found = detectScreens(c.img, { workWidth: Math.min(640, c.img.w), minFrac: 0.07, maxFrac: 0.95, radius: c.img.w / 3 });
      var best = null, bd = Infinity;
      found.forEach(function (f) {
        var q = shiftQuad(f.quad, c.x, c.y);
        var inside = pointInQuad(q, pt), cc = quadCenter(q), dd = Math.hypot(cc.x - pt.x, cc.y - pt.y);
        var cost = inside ? dd * 0.1 : dd;
        if (cost < bd) { bd = cost; best = Object.assign({}, f, { quad: q, inside: inside }); }
      });
      if (best && best.inside) return best;
    }
    return null;
  }

  /**
   * Del borde exterior del bisel al LCD: en la imagen enderezada, cada lado se
   * recorre hacia adentro buscando el salto de claridad bisel→LCD (el LCD es
   * más claro que el marco). Si el salto no es claro, se usa un margen típico.
   * @returns quad del LCD (px del frame)
   */
  function innerScreen(frame, outer) {
    var RW = 200, RH = rectifiedSize(outer, RW).h;
    var r = warpQuad(frame, outer, RW, RH);
    var profile = function (side, t) { // media de una línea paralela al lado, a profundidad t (0..1)
      var s = 0, n = 0, i;
      for (i = 0.2; i <= 0.8; i += 0.04) {
        var x, y;
        if (side === 0) { x = i * (RW - 1); y = t * (RH - 1); }
        else if (side === 1) { x = (1 - t) * (RW - 1); y = i * (RH - 1); }
        else if (side === 2) { x = i * (RW - 1); y = (1 - t) * (RH - 1); }
        else { x = t * (RW - 1); y = i * (RH - 1); }
        s += sample(r, x, y); n++;
      }
      return s / n;
    };
    var depth = [0, 0, 0, 0];
    for (var side = 0; side < 4; side++) {
      var best = 0, at = -1, prev = profile(side, 0.01);
      for (var t = 0.02; t <= 0.24; t += 0.01) {
        var v = profile(side, t), g = v - prev;
        if (g > best) { best = g; at = t; }
        prev = v;
      }
      depth[side] = best >= 4 && at > 0 ? at + 0.01 : 0.07;
    }
    // esquinas del rectángulo interior en coordenadas enderezadas → frame
    var h = homography(outer, [{ x: 0, y: 0 }, { x: RW - 1, y: 0 }, { x: RW - 1, y: RH - 1 }, { x: 0, y: RH - 1 }]);
    if (!h) return outer;
    var L = depth[3] * (RW - 1), R = (1 - depth[1]) * (RW - 1), T = depth[0] * (RH - 1), B = (1 - depth[2]) * (RH - 1);
    return refineEdges(frame, [applyH(h, L, T), applyH(h, R, T), applyH(h, R, B), applyH(h, L, B)]);
  }

  /**
   * Afinado sub-píxel de un cuadrilátero cuyo interior es MÁS CLARO que su borde
   * exterior (LCD dentro del bisel): en cada lado se buscan, a lo largo de la
   * normal, los puntos de máximo descenso de claridad (interior→bisel); se ajusta
   * una recta por mínimos cuadrados y las esquinas son las intersecciones.
   */
  function refineEdges(frame, quad) {
    var lines = [];
    for (var i = 0; i < 4; i++) {
      var a = quad[i], b = quad[(i + 1) % 4];
      var len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 8) return quad;
      var ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      // normal hacia afuera (el cuadrilátero va en sentido horario en coordenadas de pantalla)
      var nx = uy, ny = -ux;
      var cq = quadCenter(quad);
      if ((a.x + b.x) / 2 * nx + (a.y + b.y) / 2 * ny < cq.x * nx + cq.y * ny) { nx = -nx; ny = -ny; }
      var span = Math.max(2.5, len * 0.05), pts = [];
      for (var t = 0.15; t <= 0.851; t += 0.05) {
        var px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
        var best = 0, at = null, prev = null;
        for (var s = -span; s <= span; s += 0.25) {
          // promedio en un pequeño segmento paralelo al lado (reduce ruido)
          var v = 0;
          for (var k = -1; k <= 1; k++) v += sample(frame, px + nx * s + ux * k, py + ny * s + uy * k);
          if (prev !== null) {
            var g = prev - v; // descenso de claridad hacia afuera
            if (g > best) { best = g; at = s - 0.125; }
          }
          prev = v;
        }
        if (at !== null && best > 6) pts.push({ x: px + nx * at, y: py + ny * at });
      }
      if (pts.length < 5) { lines.push(null); continue; }
      // recta por mínimos cuadrados totales
      var mx = 0, my = 0;
      pts.forEach(function (p) { mx += p.x; my += p.y; });
      mx /= pts.length; my /= pts.length;
      var sxx = 0, syy = 0, sxy = 0;
      pts.forEach(function (p) { sxx += (p.x - mx) * (p.x - mx); syy += (p.y - my) * (p.y - my); sxy += (p.x - mx) * (p.y - my); });
      var ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      lines.push({ px: mx, py: my, dx: Math.cos(ang), dy: Math.sin(ang) });
    }
    var out = [];
    for (var j = 0; j < 4; j++) {
      var l1 = lines[(j + 3) % 4], l2 = lines[j]; // la esquina j es el cruce del lado anterior y el actual
      if (!l1 || !l2) { out.push(quad[j]); continue; }
      var den = l1.dx * l2.dy - l1.dy * l2.dx;
      if (Math.abs(den) < 1e-6) { out.push(quad[j]); continue; }
      var tt = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / den;
      var c = { x: l1.px + l1.dx * tt, y: l1.py + l1.dy * tt };
      // si el afinado se aleja demasiado, se conserva la esquina original
      var lim = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y) * 0.08;
      out.push(Math.hypot(c.x - quad[j].x, c.y - quad[j].y) <= lim ? c : quad[j]);
    }
    return out;
  }

  /**
   * Clic sobre una pantalla → LCD ajustado (px). Primero busca el LCD directo
   * (rectángulo claro con marco oscuro alrededor del clic); si no, marco + interior.
   * sizeHint: ancho aproximado esperado del LCD en px (acelera y afina la búsqueda).
   */
  function fitLcdAt(frame, pt, sizeHint) {
    var windows = sizeHint ? [Math.min(0.7, (sizeHint * 2.6) / frame.w)] : [0.2, 0.3, 0.45];
    // Se prueban varias ventanas y gana el candidato de mejor puntaje que contiene el clic
    // (con ventanas chicas, el LCD a veces se une a lo que tiene justo debajo).
    var best = null;
    for (var i = 0; i < windows.length; i++) {
      var ww = frame.w * windows[i], wh = Math.min(frame.h, ww * 0.85);
      var c = cropGray(frame, pt.x - ww / 2, pt.y - wh / 2, ww, wh);
      var holes = detectLcdHoles(c.img, { workWidth: Math.min(640, c.img.w), minFrac: 0.08, maxFrac: 0.95, radius: Math.max(3, c.img.w / 26) });
      holes.forEach(function (h) {
        var q = shiftQuad(h.quad, c.x, c.y);
        if (pointInQuad(q, pt) && (!best || h.score > best.score)) best = { quad: q, score: h.score };
      });
    }
    if (best) return refineEdges(frame, best.quad);
    var fit = fitScreenAt(frame, pt, sizeHint ? { windows: windows } : undefined);
    return fit ? innerScreen(frame, fit.quad) : null;
  }

  /**
   * Prepara el LCD enderezado para leer: corrección de perspectiva, reducción de
   * ruido y normalización de contraste (los LCD reflectivos vistos por webcam
   * tienen poco contraste: dígitos apenas 15–30 niveles más oscuros que el fondo).
   * @returns { img (normalizada), raw, contrast (0–100, contraste REAL del LCD) }
   */
  function prepareLcd(frame, quad, width) {
    // 2 % hacia adentro: evita que la sombra del marco en el borde del LCD se lea como
    // segmento (la fila superior del HTC-2 casi toca el borde). Medido con imágenes reales.
    var c = quadCenter(quad);
    quad = quad.map(function (p) { return { x: c.x + (p.x - c.x) * 0.98, y: c.y + (p.y - c.y) * 0.98 }; });
    var size = rectifiedSize(quad, width || 480);
    var raw = warpQuad(frame, quad, size.w, size.h);
    var st = stats(raw);
    return { img: normalize(boxBlur3(raw), 0.01, 0.99), raw: raw, size: size, contrast: Math.round(((st.p99 - st.p1) / 2.55) * 10) / 10 };
  }

  // ─────────────── filas de dígitos: ubicar los VALORES dentro de la pantalla ───────────────
  //
  // En vez de suponer dónde están los números (fracciones fijas del LCD), se buscan:
  // la tinta de los dígitos forma BANDAS horizontales (fila de temperatura IN, fila
  // OUT, fila de hora + humedad). Las líneas separadoras del HTC-2, el marco y la
  // franja «TEMPERATURE» son trazos largos y se descartan. Así los cuadros de lectura
  // quedan sobre los dígitos aunque el cuadrilátero incluya carcasa o marco.

  /** Tinta: más oscura (o más clara si light) que su vecindad de radio R (media por caja separable). */
  function inkMask(img, R, light) {
    var W = img.w, H = img.h, d = img.d, x, y;
    var rows = new Float32Array(W * H), m = new Uint8Array(W * H);
    for (y = 0; y < H; y++) { // suma horizontal deslizante
      var o = y * W, acc = 0, lo = 0, hi = -1;
      for (x = 0; x < W; x++) {
        var nhi = Math.min(W - 1, x + R), nlo = Math.max(0, x - R);
        while (hi < nhi) acc += d[o + ++hi];
        while (lo < nlo) acc -= d[o + lo++];
        rows[o + x] = acc / (hi - lo + 1);
      }
    }
    for (x = 0; x < W; x++) { // media vertical deslizante de las medias horizontales
      var acc2 = 0, lo2 = 0, hi2 = -1;
      for (y = 0; y < H; y++) {
        var nhi2 = Math.min(H - 1, y + R), nlo2 = Math.max(0, y - R);
        while (hi2 < nhi2) acc2 += rows[++hi2 * W + x];
        while (lo2 < nlo2) acc2 -= rows[lo2++ * W + x];
        var mean = acc2 / (hi2 - lo2 + 1), v = d[y * W + x];
        if (light) { if (v > mean + Math.max(6, 0.08 * (255 - mean))) m[y * W + x] = 1; }
        else if (v < mean - Math.max(6, 0.08 * mean)) m[y * W + x] = 1;
      }
    }
    return m;
  }

  /**
   * Quita tramos rectos más largos que maxH (horizontal) o maxV (vertical): separadores
   * y bordes. Huecos de hasta `gap` px no cortan el tramo (líneas punteadas por el ruido).
   */
  function dropLines(m, W, H, maxH, maxV, gap) {
    gap = gap || 0;
    var out = m.slice(), x, y, s, last, k;
    for (y = 0; y < H; y++) {
      s = -1; last = -1;
      for (x = 0; x <= W; x++) {
        var on = x < W && m[y * W + x];
        if (on) { if (s < 0) s = x; last = x; }
        else if (s >= 0 && (x === W || x - last > gap)) { if (last + 1 - s > maxH) for (k = s; k <= last; k++) out[y * W + k] = 0; s = -1; }
      }
    }
    for (x = 0; x < W; x++) {
      s = -1; last = -1;
      for (y = 0; y <= H; y++) {
        var on2 = y < H && m[y * W + x];
        if (on2) { if (s < 0) s = y; last = y; }
        else if (s >= 0 && (y === H || y - last > gap)) { if (last + 1 - s > maxV) for (k = s; k <= last; k++) out[k * W + x] = 0; s = -1; }
      }
    }
    return out;
  }

  /**
   * Mapa de tinta de un LCD enderezado, sin líneas largas (borde del LCD,
   * separadores del HTC-2, franja «TEMPERATURE»): solo quedan dígitos y rótulos.
   */
  function digitInk(img, light) {
    var W = img.w, H = img.h;
    return dropLines(inkMask(img, Math.max(4, Math.round(H / 8)), light), W, H, W * 0.3, H * 0.4, Math.max(2, Math.round(H / 100)));
  }

  /** Distribución real del HTC-2 (igual que MonLogic.HTC2_FIELDS): el modelo siempre incluye la hora. */
  var HTC2_FIELDS_DEFAULT = {
    tempIn: { x: 0.275, y: 0.0, w: 0.505, h: 0.315 },
    tempOut: { x: 0.275, y: 0.337, w: 0.505, h: 0.293 },
    humidity: { x: 0.53, y: 0.655, w: 0.312, h: 0.31 },
    time: { x: 0.095, y: 0.752, w: 0.385, h: 0.19 },
  };
  /** Proporción ancho/alto del LCD del HTC-2 (480 × 386 en la vista enderezada). */
  var HTC2_ASPECT = 480 / 386;
  var MODEL_KEYS = ["tempIn", "tempOut", "humidity", "time"];

  /** Integral de un mapa binario reducido por un factor entero s (densidad 0–1 por celda). */
  function inkIntegral(ink, W, H, s) {
    var w = Math.floor(W / s), h = Math.floor(H / s), I = new Float64Array((w + 1) * (h + 1));
    for (var y = 0; y < h; y++) {
      var run = 0;
      for (var x = 0; x < w; x++) {
        var c = 0;
        for (var dy = 0; dy < s; dy++) for (var dx = 0; dx < s; dx++) c += ink[(y * s + dy) * W + x * s + dx];
        run += c / (s * s);
        I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + run;
      }
    }
    return { w: w, h: h, I: I };
  }
  function boxSum(M, x0, y0, x1, y1) {
    var w1 = M.w + 1;
    return M.I[y1 * w1 + x1] - M.I[y0 * w1 + x1] - M.I[y1 * w1 + x0] + M.I[y0 * w1 + x0];
  }
  /** Campos del modelo como arreglo plano [x0, y0, x1, y1, …] (fracciones del LCD). */
  function modelBoxes(fields) {
    var FX = new Float64Array(16);
    MODEL_KEYS.forEach(function (k, i) {
      var f = (fields && fields[k]) || HTC2_FIELDS_DEFAULT[k];
      FX[i * 4] = f.x; FX[i * 4 + 1] = f.y; FX[i * 4 + 2] = f.x + f.w; FX[i * 4 + 3] = f.y + f.h;
    });
    return FX;
  }

  /**
   * Correlación (filtro adaptado) entre la tinta y el «mapa de dígitos» del modelo
   * colocado en el rectángulo (lx, ly, lw, lh), medida dentro de la ventana
   * [wx0, wy0, wx1, wy1] (por defecto, toda la imagen). 1 = dígitos exactamente
   * en los campos y nada de tinta fuera de ellos.
   */
  function modelScore(M, FX, lx, ly, lw, lh, win) {
    var wx0 = win ? win[0] : 0, wy0 = win ? win[1] : 0, wx1 = win ? win[2] : M.w, wy1 = win ? win[3] : M.h;
    var sIn = 0, aIn = 0;
    for (var k = 0; k < 16; k += 4) {
      var x0 = (lx + FX[k] * lw + 0.5) | 0, y0 = (ly + FX[k + 1] * lh + 0.5) | 0;
      var x1 = (lx + FX[k + 2] * lw + 0.5) | 0, y1 = (ly + FX[k + 3] * lh + 0.5) | 0;
      if (x0 < wx0) x0 = wx0; if (y0 < wy0) y0 = wy0; if (x1 > wx1) x1 = wx1; if (y1 > wy1) y1 = wy1;
      if (x1 <= x0 || y1 <= y0) return -1;
      sIn += boxSum(M, x0, y0, x1, y1);
      aIn += (x1 - x0) * (y1 - y0);
    }
    var N = (wx1 - wx0) * (wy1 - wy0), p = aIn / N, d = boxSum(M, wx0, wy0, wx1, wy1) / N;
    if (p >= 1 || d <= 0.002 || d >= 1) return -1;
    return (sIn / N - d * p) / Math.sqrt(d * (1 - d) * p * (1 - p));
  }

  /**
   * Equilibrio entre las tres filas de valores (temp. IN, OUT, humedad): densidad de
   * tinta mínima / máxima. Un HTC-2 tiene dígitos en las tres; un borde de caja o una
   * fila de texto llena solo una. 0–1.
   */
  function modelBalance(M, FX, lx, ly, lw, lh) {
    var mn = Infinity, mxd = 0;
    for (var k = 0; k < 12; k += 4) {
      var x0 = Math.max(0, (lx + FX[k] * lw + 0.5) | 0), y0 = Math.max(0, (ly + FX[k + 1] * lh + 0.5) | 0);
      var x1 = Math.min(M.w, (lx + FX[k + 2] * lw + 0.5) | 0), y1 = Math.min(M.h, (ly + FX[k + 3] * lh + 0.5) | 0);
      if (x1 <= x0 || y1 <= y0) return 0;
      var dd = boxSum(M, x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0));
      if (dd < mn) mn = dd; if (dd > mxd) mxd = dd;
    }
    return mxd > 0 ? mn / mxd : 0;
  }

  /** Búsqueda local por coordenadas del rectángulo del LCD (en la resolución de M). */
  function localFit(M, FX, c0, step, win) {
    var cur = { x: c0.x, y: c0.y, w: c0.w, h: c0.h }, cs = modelScore(M, FX, cur.x, cur.y, cur.w, cur.h, win);
    var lim = win || [0, 0, M.w, M.h];
    for (var it = 0; it < 80; it++) {
      var moved = false;
      for (var d = 0; d < 8; d++) {
        var sg = d % 2 ? -step : step, c = { x: cur.x, y: cur.y, w: cur.w, h: cur.h };
        if (d < 2) c.x += sg; else if (d < 4) c.y += sg; else if (d < 6) c.w += sg; else c.h += sg;
        if (c.x < lim[0] || c.y < lim[1] || c.x + c.w > lim[2] || c.y + c.h > lim[3] || c.w < 8 || c.h < 6) continue;
        var v = modelScore(M, FX, c.x, c.y, c.w, c.h, win);
        if (v > cs + 1e-5) { cs = v; cur = c; moved = true; }
      }
      if (!moved) break;
    }
    cur.sc = cs;
    return cur;
  }

  /**
   * Ajusta el MODELO del HTC-2 (sus cuatro campos en las proporciones reales) dentro
   * de una imagen enderezada que puede incluir carcasa, marco o fondo: se busca el
   * rectángulo del LCD cuyo mapa de dígitos mejor se correlaciona con la tinta real.
   * Búsqueda exhaustiva gruesa (~60 px) + afinado local a media y a resolución completa.
   * @returns { rect: { x, y, w, h } (px de img), score (0–1), fields (fracciones de img) } o null
   */
  function fitHtc2(img, base, opts) {
    opts = opts || {};
    var W = img.w, H = img.h, ink = digitInk(img, opts.lightSegments), FX = modelBoxes(null);
    var s = Math.max(1, Math.round(W / 60)), M = inkIntegral(ink, W, H, s), best = null;
    // con pista (se sabe aproximadamente dónde está) la búsqueda se limita a su alrededor
    var hn = opts.hint ? { x: opts.hint.x / s, y: opts.hint.y / s, w: opts.hint.w / s, h: opts.hint.h / s } : null;
    var wMax = hn ? Math.min(M.w, hn.w * 1.3) : M.w, wMin = hn ? hn.w * 0.75 : M.w * 0.4;
    var hMax = hn ? Math.min(M.h, hn.h * 1.3) : M.h, hMin = hn ? hn.h * 0.75 : M.h * 0.4;
    for (var lw = Math.floor(wMax); lw >= wMin; lw -= 1) {
      for (var lh = Math.floor(hMax); lh >= hMin; lh -= 1) {
        var asp = lw / lh;
        if (asp < HTC2_ASPECT * 0.75 || asp > HTC2_ASPECT * 1.35) continue;
        for (var ly = 0; ly + lh <= M.h; ly += 1) {
          if (hn && Math.abs(ly + lh / 2 - hn.y - hn.h / 2) > hn.h * 0.3) continue;
          for (var lx = 0; lx + lw <= M.w; lx += 1) {
            if (hn && Math.abs(lx + lw / 2 - hn.x - hn.w / 2) > hn.w * 0.3) continue;
            var sc = modelScore(M, FX, lx, ly, lw, lh);
            if (!best || sc > best.sc) best = { sc: sc, x: lx, y: ly, w: lw, h: lh };
          }
        }
      }
    }
    if (!best) return null;
    var k2 = Math.max(1, Math.round(W / 160)), sc2 = s / k2;
    var cur = localFit(inkIntegral(ink, W, H, k2), FX, { x: best.x * sc2, y: best.y * sc2, w: best.w * sc2, h: best.h * sc2 }, 1);
    cur = localFit(inkIntegral(ink, W, H, 1), FX, { x: cur.x * k2, y: cur.y * k2, w: cur.w * k2, h: cur.h * k2 }, 1);
    if (cur.sc < 0.15) return null;
    var fields = JSON.parse(JSON.stringify(base));
    Object.keys(fields).forEach(function (kk) {
      var f = fields[kk], m = HTC2_FIELDS_DEFAULT[kk] || f;
      f.x = (cur.x + m.x * cur.w) / W; f.y = (cur.y + m.y * cur.h) / H; f.w = (m.w * cur.w) / W; f.h = (m.h * cur.h) / H;
    });
    return { rect: { x: cur.x, y: cur.y, w: cur.w, h: cur.h }, score: cur.sc, fields: fields };
  }

  /**
   * Afina la posición de un campo maximizando la confianza de la lectura (búsqueda
   * local por coordenadas: desplazamiento, ancho, alto). No se aleja más de ±30 %.
   */
  function refineField(img, field, opts) {
    var W = img.w, H = img.h;
    // el campo solo puede mostrar un número (o la hora): una lectura con otra forma vale la mitad
    var shape = opts.format === "time" ? /^\d{1,2}:\d{2}$/ : /^-?\d+(\.\d+)?$/;
    var digitsOf = function (t) { return (t.match(/\d/g) || []).length; };
    var minDigits = 0; // no se «mejora» la confianza perdiendo dígitos que ya se leían
    var dec = function (f) {
      var r = decodeField(img, { x: f.x * W, y: f.y * H, w: f.w * W, h: f.h * H }, { digits: f.digits, decimals: f.decimals, slantDeg: opts.slantDeg, lightSegments: opts.lightSegments, format: opts.format });
      var c = shape.test(r.text) ? r.confidence : r.confidence * 0.5;
      return digitsOf(r.text) < minDigits ? c * 0.5 : c;
    };
    var cur = { x: field.x, y: field.y, w: field.w, h: field.h, digits: field.digits, decimals: field.decimals };
    var first = decodeField(img, { x: cur.x * W, y: cur.y * H, w: cur.w * W, h: cur.h * H }, { digits: cur.digits, decimals: cur.decimals, slantDeg: opts.slantDeg, lightSegments: opts.lightSegments, format: opts.format });
    if (shape.test(first.text) && first.confidence >= 40) minDigits = digitsOf(first.text);
    var bestC = dec(cur), cell = field.w / field.digits;
    var steps = [
      function (f, k) { f.x += k * cell * 0.08; },
      function (f, k) { var r = f.x + f.w; f.w *= 1 + k * 0.04; f.x = r - f.w; },
      function (f, k) { f.y += k * field.h * 0.04; },
      function (f, k) { var c = f.y + f.h / 2; f.h *= 1 + k * 0.04; f.y = c - f.h / 2; },
    ];
    for (var pass = 0; pass < 3; pass++) {
      var improved = false;
      steps.forEach(function (st) {
        for (var dir = -1; dir <= 1; dir += 2) {
          for (var n = 0; n < 4; n++) {
            var t = { x: cur.x, y: cur.y, w: cur.w, h: cur.h, digits: cur.digits, decimals: cur.decimals };
            st(t, dir);
            if (t.x < 0 || t.y < 0 || t.x + t.w > 1 || t.y + t.h > 1) break;
            var maxY = opts.format === "time" ? 0.1 : 0.3; // la hora tiene «AM/PM» justo encima
            if (Math.abs(t.x - field.x) > 0.3 * field.w || Math.abs(t.y - field.y) > maxY * field.h || t.w / field.w > 1.3 || t.w / field.w < 0.77 || t.h / field.h > 1.3 || t.h / field.h < 0.77) break;
            var c = dec(t);
            if (c > bestC + 0.5) { bestC = c; cur = t; improved = true; } else break;
          }
        }
      });
      if (!improved) break;
    }
    var out = JSON.parse(JSON.stringify(field));
    out.x = cur.x; out.y = cur.y; out.w = cur.w; out.h = cur.h;
    return { field: out, confidence: bestC };
  }

  /** Esquinas (px del frame) de un rectángulo de la vista enderezada que produce prepareLcd. */
  function rectToFrame(quad, size, r) {
    var c = quadCenter(quad);
    var q = quad.map(function (p) { return { x: c.x + (p.x - c.x) * 0.98, y: c.y + (p.y - c.y) * 0.98 }; });
    var hm = homography(q, [{ x: 0, y: 0 }, { x: size.w - 1, y: 0 }, { x: size.w - 1, y: size.h - 1 }, { x: 0, y: size.h - 1 }]);
    if (!hm) return null;
    return [applyH(hm, r.x, r.y), applyH(hm, r.x + r.w, r.y), applyH(hm, r.x + r.w, r.y + r.h), applyH(hm, r.x, r.y + r.h)];
  }

  // ─────────────── estructura real del HTC-2: separadores → LCD → dígitos ───────────────
  //
  // Medido sobre la cámara del usuario (oct-2026): el LCD del HTC-2 tiene dos LÍNEAS
  // SEPARADORAS finas y oscuras de lado a lado (entre temp. IN / temp. OUT / hora+humedad).
  // Son lo más fácil de encontrar de la pantalla y dan su posición, su tamaño y su
  // inclinación. Con el LCD ya derecho, cada cuadro de lectura se coloca sobre sus
  // dígitos y se elige el que mejor se lee.

  /** Líneas finas oscuras casi horizontales (±6°) que cruzan la imagen: separadores y bordes del LCD. */
  function hLines(img) {
    var W = img.w, H = img.h, res = [], step = Math.max(1, Math.round(W / 140));
    var off = Math.max(3, Math.round(H / 110)), off2 = off + Math.max(1, Math.round(H / 300));
    var coverAt = function (y, sl) {
      var hits = 0, n = 0;
      for (var x = W * 0.08; x < W * 0.92; x += step) {
        var yy = y + sl * (x - W / 2), c = sample(img, x, yy);
        var up = Math.max(sample(img, x, yy - off), sample(img, x, yy - off2)), dn = Math.max(sample(img, x, yy + off), sample(img, x, yy + off2));
        n++; if (Math.min(up, dn) - c > 12) hits++;
      }
      return hits / n;
    };
    // pasada gruesa (cada 2 px, cada 2°) y afinado solo donde hay una línea
    for (var y = 2; y < H - 2; y += 2) {
      var best = null;
      for (var a = -6; a <= 6; a += 2) { var c1 = coverAt(y, Math.tan((a * Math.PI) / 180)); if (!best || c1 > best.cover) best = { y: y, a: a, cover: c1 }; }
      if (best.cover >= 0.25) {
        for (var dy = -1; dy <= 1; dy++) for (var da = -1.5; da <= 1.5; da += 0.5) {
          var c2 = coverAt(y + dy, Math.tan(((best.a + da) * Math.PI) / 180));
          if (c2 > best.cover) best = { y: y + dy, a: best.a + da, cover: c2 };
        }
      }
      best.slope = Math.tan((best.a * Math.PI) / 180);
      res.push(best);
    }
    var out = [];
    res.sort(function (p, q) { return q.cover - p.cover; }).forEach(function (r) {
      if (r.cover < 0.45 || out.some(function (o) { return Math.abs(o.y - r.y) < H * 0.05; })) return;
      out.push(r);
    });
    return out.sort(function (p, q) { return p.y - q.y; });
  }

  /** Fracción de filas de una banda (inclinada) que tienen tinta oscura: ¿hay dígitos? */
  function bandHasInk(img, y0, y1, sl) {
    var W = img.w, H = img.h;
    if (y0 < 0 || y1 > H || y1 - y0 < 8) return 0;
    var vals = [], x, y;
    for (y = y0; y < y1; y += 2) for (x = W * 0.2; x < W * 0.92; x += 3) vals.push(sample(img, x, y + sl * (x - W / 2)));
    vals.sort(function (p, q) { return p - q; });
    var med = vals[vals.length >> 1], withInk = 0, rows = 0;
    for (y = y0 + (y1 - y0) * 0.08; y < y1 - (y1 - y0) * 0.08; y += 2) {
      rows++;
      var k = 0;
      for (x = W * 0.2; x < W * 0.92; x += 3) if (sample(img, x, y + sl * (x - W / 2)) < med - 30) k++;
      if (k >= 3) withInk++;
    }
    return rows ? withInk / rows : 0;
  }

  /** Borde vertical del LCD (línea fina oscura o salto a oscuro) entre xa..xb, perpendicular a las filas. */
  function vEdge(img, xa, xb, yTop, yBot, sl, dir) {
    var best = null;
    for (var x = Math.max(2, Math.round(xa)); x <= Math.min(img.w - 3, Math.round(xb)); x++) {
      var hits = 0, n = 0;
      for (var y = yTop + (yBot - yTop) * 0.1; y < yBot - (yBot - yTop) * 0.1; y += 3) {
        var xx = x - sl * (y - img.h / 2), c = sample(img, xx, y), l = sample(img, xx - 5, y), r = sample(img, xx + 5, y);
        n++; if (Math.min(l, r) - c > 12 || (dir < 0 ? r - c > 25 : l - c > 25)) hits++;
      }
      var cover = hits / n;
      if (!best || cover > best.cover || (cover === best.cover && (dir < 0 ? x < best.x : x > best.x))) best = { x: x, cover: cover };
    }
    return best && best.cover > 0.5 ? best.x : null;
  }

  /** Punto (x, y) de la vista enderezada que produce prepareLcd → px del frame. */
  function rectPointToFrame(quad, size, x, y) {
    var c = quadCenter(quad);
    var q = quad.map(function (p) { return { x: c.x + (p.x - c.x) * 0.98, y: c.y + (p.y - c.y) * 0.98 }; });
    var hm = homography(q, [{ x: 0, y: 0 }, { x: size.w - 1, y: 0 }, { x: size.w - 1, y: size.h - 1 }, { x: 0, y: size.h - 1 }]);
    return hm ? applyH(hm, x, y) : null;
  }

  /**
   * Ubica el LCD del HTC-2 dentro de un cuadrilátero aproximado por sus separadores.
   * @returns { quad (LCD derecho, px del frame), s1, s2 (separadores, fracción del alto) } o null
   */
  function findHtc2Lcd(frame, quad) {
    var lcd = prepareLcd(frame, quad, 480), img = lcd.img, W = img.w, H = img.h;
    var lines = hLines(img), best = null;
    for (var i = 0; i + 1 < lines.length; i++) {
      var a = lines[i], b = lines[i + 1], D = b.y - a.y, sl = (a.slope + b.slope) / 2;
      if (D < H * 0.12 || Math.abs(a.a - b.a) > 2) continue;
      // las tres filas (arriba, entre y abajo de los separadores) deben tener dígitos
      var i1 = bandHasInk(img, Math.round(a.y - D * 0.95), Math.round(a.y - 4), sl), i2 = bandHasInk(img, Math.round(a.y + 4), Math.round(b.y - 4), sl), i3 = bandHasInk(img, Math.round(b.y + 4), Math.round(b.y + D * 0.95), sl);
      var ink = Math.min(i1, i2, i3) >= 0.6 ? i1 + i2 + i3 : 0;
      var score = ink + a.cover + b.cover;
      if (ink >= 2.5 && (!best || score > best.score)) best = { score: score, a: a, b: b, D: D, sl: sl };
    }
    if (!best) return null;
    var A = best.a, B = best.b, DD = best.D, S = best.sl;
    // bordes sup./inf.: línea detectada a la distancia típica o la proporción del HTC-2
    var topL = lines.filter(function (l) { return l.y < A.y && A.y - l.y > DD * 0.8 && A.y - l.y < DD * 1.4; })[0];
    var botL = lines.filter(function (l) { return l.y > B.y && l.y - B.y > DD * 0.8 && l.y - B.y < DD * 1.45; })[0];
    var top = topL ? topL.y : A.y - DD * 1.1, bot = botL ? botL.y : B.y + DD * 1.17;
    var left = vEdge(img, 0, W * 0.2, top, bot, S, -1), right = vEdge(img, W * 0.8, W - 1, top, bot, S, 1);
    if (left == null) left = 0;
    if (right == null) right = W - 1;
    var yAt = function (y0, x) { return y0 + S * (x - W / 2); }, xAt = function (x0, y) { return x0 - S * (y - H / 2); };
    var corners = [[left, top], [right, top], [right, bot], [left, bot]].map(function (p) { return rectPointToFrame(quad, lcd.size, xAt(p[0], p[1]), yAt(p[1], p[0])); });
    if (corners.some(function (p) { return !p; })) return null;
    return { quad: corners, s1: (A.y - top) / (bot - top), s2: (B.y - top) / (bot - top) };
  }

  /** Grupos de tinta (dígitos y símbolos) de una banda horizontal [y0, y1] de una imagen derecha. */
  function inkGroups(img, y0, y1) {
    var W = img.w, h = y1 - y0, vals = [], x, y;
    for (y = y0; y < y1; y++) for (x = 0; x < W; x += 2) vals.push(img.d[y * W + x]);
    vals.sort(function (p, q) { return p - q; });
    var med = vals[vals.length >> 1], thr = med - Math.max(30, (med - vals[Math.floor(vals.length * 0.02)]) * 0.4);
    var col = new Float32Array(W), top = new Int32Array(W), bot = new Int32Array(W);
    for (x = 0; x < W; x++) { top[x] = -1; bot[x] = -1; for (y = y0; y < y1; y++) if (img.d[y * W + x] < thr) { col[x]++; if (top[x] < 0) top[x] = y; bot[x] = y; } }
    var groups = [], g = null, gap = 0;
    for (x = Math.round(W * 0.03); x < W * 0.97; x++) {
      if (col[x] >= Math.max(2, h * 0.1)) {
        if (!g || gap > h * 0.08) { g = { x0: x, x1: x, y0: top[x], y1: bot[x] }; groups.push(g); }
        g.x1 = x; g.y0 = Math.min(g.y0, top[x]); g.y1 = Math.max(g.y1, bot[x]); gap = 0;
      } else gap++;
    }
    groups.forEach(function (q) { q.ext = (q.y1 - q.y0) / h; q.w = q.x1 - q.x0; });
    return groups;
  }

  /**
   * Coloca los cuadros de lectura sobre los dígitos de un LCD de HTC-2 ya derecho
   * (s1, s2: separadores). Prueba pocos candidatos (borde derecho de cada grupo,
   * ancho de dígito, inclinación) y se queda con el que lee números válidos con más
   * confianza sin dejar dígitos afuera. @returns { fields (fracciones), slantDeg, confidence }
   */
  function fieldsOnDigits(img, s1, s2, base, opts) {
    opts = opts || {};
    var W = img.w, H = img.h, light = opts.lightSegments;
    var bands = [[0.03, s1 - 0.03], [s1 + 0.03, s2 - 0.03], [s2 + 0.03, 0.97]].map(function (b) { return [Math.round(b[0] * H), Math.round(b[1] * H)]; });
    var G3 = bands.map(function (b) { return inkGroups(img, b[0], b[1]); });
    var vext = function (gs, b) {
      var d = gs.filter(function (g) { return g.ext >= 0.75; });
      return d.length ? [Math.min.apply(null, d.map(function (g) { return g.y0; })), Math.max.apply(null, d.map(function (g) { return g.y1; }))] : [b[0], b[1]];
    };
    var dec = function (f, slant, fmt) { return decodeField(img, f, { digits: f.digits, decimals: f.decimals, slantDeg: slant, lightSegments: light, format: fmt }); };
    var num = /^-?\d+(\.\d)?$/, best = null;
    var rights = [];
    G3[0].concat(G3[1]).forEach(function (g) { if (g.ext >= 0.75 && g.x1 > W * 0.5 && rights.indexOf(g.x1) < 0) rights.push(g.x1); });
    var ys = [vext(G3[0], bands[0]), vext(G3[1], bands[1])];
    var dIn = base.tempIn || { digits: 3, decimals: 1 }, dOut = base.tempOut || dIn;
    [0, 4, 8, 12].forEach(function (slant) {
      rights.forEach(function (r) {
        [0.7, 0.8, 0.9].forEach(function (cellK) {
          var fs = ys.map(function (yy, i) {
            var spec = i ? dOut : dIn, h = (yy[1] - yy[0]) * 1.06, cell = cellK * h, right = r + 0.05 * cell;
            var own = G3[i].filter(function (g) { return g.ext >= 0.75 && g.x1 <= r + 2 && g.x0 >= r - (spec.digits + 0.4) * cell; });
            var x0 = right - spec.digits * cell;
            if (own.length) x0 = Math.min(x0, Math.min.apply(null, own.map(function (g) { return g.x0; })) - 0.08 * cell);
            return { x: x0, y: (yy[0] + yy[1]) / 2 - h / 2, w: right - x0, h: h, digits: spec.digits, decimals: spec.decimals };
          });
          if (fs[0].x < 0 || fs[1].x < 0) return;
          var sc = 0;
          fs.forEach(function (f, i) {
            var rr = dec(f, slant, "number");
            // ningún dígito a la izquierda del borde queda afuera, y ninguno justo a la derecha (número cortado)
            var left = G3[i].filter(function (g) { return g.ext >= 0.75 && g.x1 <= r + 2; }), tot = 0, inn = 0;
            left.forEach(function (g) { tot += g.w; inn += Math.max(0, Math.min(g.x1, r + 2) - Math.max(g.x0, f.x)); });
            var cover = tot ? inn / tot : 1;
            var cut = G3[i].some(function (g) { return g.ext >= 0.75 && g.w >= 0.3 * f.h && g.x0 > r + 2 && g.x0 < r + 1.2 * cellK * f.h; }) ? 0.5 : 1;
            sc += (num.test(rr.text) ? rr.confidence : rr.confidence * 0.3) * cover * cover * cut;
          });
          if (!best || sc > best.sc) best = { sc: sc, slant: slant, fs: fs };
        });
      });
    });
    var slant = best ? best.slant : opts.slantDeg || 6;
    var out = JSON.parse(JSON.stringify(base)), conf = {};
    var put = function (k, f) { out[k].x = f.x / W; out[k].y = f.y / H; out[k].w = f.w / W; out[k].h = f.h / H; };
    if (best) { put("tempIn", best.fs[0]); put("tempOut", best.fs[1]); }
    // humedad: los dos dígitos anchos más a la derecha de la tercera fila; hora: lo de su izquierda
    var y3 = vext(G3[2], bands[2]), h3 = y3[1] - y3[0];
    var wide = G3[2].filter(function (q) { return q.ext >= 0.75 && q.w >= 0.3 * h3; });
    var hs = base.humidity || { digits: 2, decimals: 0 };
    var right3 = wide.filter(function (q) { return q.x1 > W * 0.45; }).slice(-hs.digits);
    if (right3.length && out.humidity) {
      var hb = null;
      [0.7, 0.8, 0.9].forEach(function (cellK) {
        var g = right3[right3.length - 1], h = h3 * 1.06, x0 = right3[0].x0, w = Math.max(hs.digits * cellK * h, (g.x1 - x0) * 1.12);
        var f = { x: g.x1 + 0.05 * cellK * h - w, y: (y3[0] + y3[1]) / 2 - h / 2, w: w, h: h, digits: hs.digits, decimals: hs.decimals };
        var r = dec(f, slant, "number"), v = +r.text, sc = /^\d+$/.test(r.text) && v >= 5 && v <= 99 ? r.confidence : r.confidence * 0.3;
        if (!hb || sc > hb.sc) hb = { sc: sc, f: f };
      });
      put("humidity", hb.f);
      var leftG = G3[2].filter(function (q) { return q.ext >= 0.5 && q.x1 < hb.f.x - 0.05 * W; });
      if (leftG.length && out.time) {
        var tx0 = Math.min.apply(null, leftG.map(function (q) { return q.x0; })), tx1 = Math.max.apply(null, leftG.map(function (q) { return q.x1; }));
        var ty0 = Math.min.apply(null, leftG.map(function (q) { return q.y0; })), ty1 = Math.max.apply(null, leftG.map(function (q) { return q.y1; }));
        put("time", { x: tx0 - 0.02 * W, y: ty0 - 0.03 * (ty1 - ty0), w: tx1 - tx0 + 0.04 * W, h: (ty1 - ty0) * 1.06 });
      }
    }
    // afinado final de cada campo por la confianza de lectura
    Object.keys(out).forEach(function (k) {
      if (!out[k].enabled) return;
      var r = refineField(img, out[k], { slantDeg: slant, lightSegments: light, format: k === "time" ? "time" : "number" });
      out[k] = r.field; conf[k] = r.confidence;
    });
    return { fields: out, slantDeg: slant, confidence: conf };
  }

  /**
   * HTC-2 por su estructura real: separadores → LCD derecho → cuadros sobre los dígitos.
   * @returns { quad (LCD, px), fields, slantDeg, confidence, score } o null si no se ven los separadores
   */
  function locateHtc2(frame, quad, base, opts) {
    var lcdLoc = findHtc2Lcd(frame, quad);
    if (!lcdLoc) return null;
    var lcd = prepareLcd(frame, lcdLoc.quad, 480);
    var r = fieldsOnDigits(lcd.img, lcdLoc.s1, lcdLoc.s2, base, opts);
    var cs = Object.keys(r.confidence).map(function (k) { return r.confidence[k]; });
    var mean = cs.length ? cs.reduce(function (a, b) { return a + b; }, 0) / cs.length : 0;
    return { quad: lcdLoc.quad, fields: r.fields, slantDeg: r.slantDeg, confidence: r.confidence, score: 0.3 + mean / 400, method: "separadores" };
  }

  /**
   * «Encajar» un sensor: dentro del cuadrilátero que marcó el usuario (o el detector),
   * ubica el LCD del HTC-2 por sus dígitos, lo devuelve ajustado al LCD y coloca los
   * campos de lectura sobre los valores. base: campos actuales (dígitos/decimales).
   * @returns { quad (LCD, px), fields, confidence: { key }, score } o null si no hay dígitos
   */
  function snapHtc2(frame, quad, base, opts) {
    opts = opts || {};
    // Se prueban varias formas de ubicar el LCD y gana la que LEE mejor (más valores con forma
    // de temperatura/humedad y más confianza):
    //   1. separadores del HTC-2 · 2. rectángulo claro dentro del marco oscuro del equipo ·
    //   3. «el recuadro ya es la pantalla» (medidas estándar) · 4. ajuste del modelo de tinta.
    if (opts.noAngle || opts.modelOnly) return snapModel(frame, quad, base, opts);
    var cands = [], rank = function (c) { var ok = plausibleHtc2(frame, c); return ok * 1000 + c.meanConf; };
    var add = function (c) { if (c) { c.rank = rank(c); cands.push(c); } return c; };
    var real = add(locateHtc2(frame, quad, base, opts));
    if (real && real.rank >= 3080) return real;
    lcdInFrame(frame, quad).slice(0, 2).forEach(function (q) { add(standardFit(frame, q, base, opts, "marco")); });
    // «ya es la pantalla» solo si el recuadro tiene la proporción del LCD (≈ 1,36 de ancho por alto);
    // un recuadro del equipo completo es casi cuadrado y daría lecturas falsas con forma válida
    var qw = (Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y) + Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y)) / 2;
    var qh = (Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y) + Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y)) / 2;
    var asp = qw / Math.max(1, qh);
    if (asp > HTC2_ASPECT * 0.85 && asp < HTC2_ASPECT * 1.2) add(standardFit(frame, quad, base, opts, "estándar"));
    if (!cands.some(function (c) { return c.rank >= 3000; })) {
      var mdl = add(snapModel(frame, quad, base, opts));
      // el modelo da el LCD; sobre ese LCD también se prueban las medidas estándar (afinadas)
      if (mdl) add(standardFit(frame, mdl.quad, base, opts, "modelo+estándar"));
    }
    cands.sort(function (a, b) { return b.rank - a.rank; });
    return cands.length && cands[0].rank >= 2000 ? cands[0] : null;
  }

  /**
   * Calibrar CON EL EJEMPLO: la persona escribe lo que muestra el sensor (p. ej. tempIn
   * "25.5") y se ajustan los cuadros y la inclinación hasta leer exactamente eso.
   * expected: { key: texto } (solo los que se escribieron). La inclinación es común a todos.
   * @returns { fields, slantDeg, result: { key: { text, confidence, ok } } }
   */
  function fitToExample(frame, quad, fields, expected, opts) {
    opts = opts || {};
    var lcd = prepareLcd(frame, quad, 480), img = lcd.img, W = img.w, H = img.h;
    var keys = Object.keys(expected).filter(function (k) { return fields[k] && expected[k] != null && String(expected[k]).trim() !== ""; });
    var norm = function (t) { return String(t).replace(/\s/g, ""); };
    var read = function (f, k, slant) {
      return decodeField(img, { x: f.x * W, y: f.y * H, w: f.w * W, h: f.h * H }, { digits: f.digits, decimals: f.decimals, slantDeg: slant, lightSegments: opts.lightSegments, format: k === "time" ? "time" : "number" });
    };
    // puntaje: coincidencia exacta >> caracteres acertados (alineados a la derecha) >> confianza
    var match = function (k, r) {
      var want = norm(expected[k]), got = norm(r.text);
      if (got === want) return 1000 + r.confidence;
      var hit = 0;
      for (var i = 1; i <= Math.min(want.length, got.length); i++) if (want[want.length - i] === got[got.length - i]) hit++;
      return hit * 100 + r.confidence * 0.1;
    };
    var fit = function (k, fStart, slant, grid) {
      // 1) búsqueda gruesa en cuadrícula (el punto de partida puede estar bastante corrido)
      var f0 = fStart, g0 = null;
      (grid ? [0.88, 1, 1.12] : []).forEach(function (sc) {
        for (var dy = -0.4; dy <= 0.401; dy += 0.08) for (var dx = -0.4; dx <= 0.401; dx += 0.08) {
          var t = { w: fStart.w * sc, h: fStart.h * sc, digits: fStart.digits, decimals: fStart.decimals };
          t.x = fStart.x + fStart.w * (1 - sc) / 2 + dx * fStart.w; t.y = fStart.y + fStart.h * (1 - sc) / 2 + dy * fStart.h;
          if (t.x < 0 || t.y < 0 || t.x + t.w > 1 || t.y + t.h > 1) continue;
          var v = match(k, read(t, k, slant));
          if (!g0 || v > g0.v) g0 = { v: v, t: t };
        }
      });
      if (g0) f0 = g0.t;
      // 2) afinado local
      var cur = { x: f0.x, y: f0.y, w: f0.w, h: f0.h, digits: f0.digits, decimals: f0.decimals }, best = match(k, read(cur, k, slant)), cell = f0.w / f0.digits;
      var steps = [
        function (f, d) { f.x += d * cell * 0.06; },
        function (f, d) { var r = f.x + f.w; f.w *= 1 + d * 0.035; f.x = r - f.w; },
        function (f, d) { f.y += d * f0.h * 0.035; },
        function (f, d) { var c = f.y + f.h / 2; f.h *= 1 + d * 0.035; f.y = c - f.h / 2; },
      ];
      for (var pass = 0; pass < 4; pass++) {
        var moved = false;
        steps.forEach(function (st) {
          for (var dir = -1; dir <= 1; dir += 2) {
            for (var n = 0; n < 8; n++) {
              var t = { x: cur.x, y: cur.y, w: cur.w, h: cur.h, digits: cur.digits, decimals: cur.decimals };
              st(t, dir);
              if (t.x < 0 || t.y < 0 || t.x + t.w > 1 || t.y + t.h > 1 || Math.abs(t.x - f0.x) > 0.45 * f0.w || Math.abs(t.y - f0.y) > 0.45 * f0.h || t.w / f0.w > 1.45 || t.w / f0.w < 0.7 || t.h / f0.h > 1.45 || t.h / f0.h < 0.7) break;
              var v = match(k, read(t, k, slant));
              if (v > best + 0.5) { best = v; cur = t; moved = true; } else break;
            }
          }
        });
        if (!moved) break;
      }
      return { f: cur, score: best };
    };
    var bestAll = null;
    [6, 0, 3, 9, 12].forEach(function (slant) {
      var tot = 0, fs = {};
      keys.forEach(function (k) { var r = fit(k, bestAll ? bestAll.fs[k] : fields[k], slant, !bestAll); fs[k] = r.f; tot += r.score; });
      if (!bestAll || tot > bestAll.tot) bestAll = { tot: tot, slant: slant, fs: fs };
    });
    var out = JSON.parse(JSON.stringify(fields)), result = {};
    keys.forEach(function (k) {
      var f = bestAll.fs[k];
      out[k].x = f.x; out[k].y = f.y; out[k].w = f.w; out[k].h = f.h; out[k].enabled = true;
      var r = read(out[k], k, bestAll.slant);
      result[k] = { text: r.text, confidence: r.confidence, ok: norm(r.text) === norm(expected[k]) };
    });
    return { fields: out, slantDeg: bestAll.slant, result: result };
  }

  /** LCD claro rodeado del marco oscuro del HTC-2, buscado DENTRO de un cuadrilátero (px del frame). */
  function lcdInFrame(frame, quad) {
    var l = prepareLcd(frame, quad, 480);
    return detectLcdHoles(l.img, { workWidth: 480, minFrac: 0.25, maxFrac: 0.98, radius: 40 }).map(function (h) {
      return refineEdges(frame, h.quad.map(function (p) { return rectPointToFrame(quad, l.size, p.x, p.y); }));
    }).filter(function (q) { return q.every(function (p) { return p && isFinite(p.x); }); });
  }

  /**
   * Medidas ESTÁNDAR del HTC-2 sobre un LCD ya encuadrado: los campos van en su lugar de
   * fábrica; se busca la inclinación de los dígitos y cada cuadro se afina por la lectura.
   */
  function standardFit(frame, lcdQuad, base, opts, method) {
    var lcd = prepareLcd(frame, lcdQuad, 480), img = lcd.img, W = img.w, H = img.h;
    var fields = JSON.parse(JSON.stringify(base));
    Object.keys(fields).forEach(function (k) { var m = HTC2_FIELDS_DEFAULT[k]; if (m) { fields[k].x = m.x; fields[k].y = m.y; fields[k].w = m.w; fields[k].h = m.h; } });
    var num = /^-?\d{2}\.\d$/, best = 0, slant = 6;
    [0, 3, 6, 9, 12].forEach(function (sl) {
      var sc = 0;
      ["tempIn", "tempOut"].forEach(function (k) {
        var f = fields[k];
        if (!f) return;
        var r = decodeField(img, { x: f.x * W, y: f.y * H, w: f.w * W, h: f.h * H }, { digits: f.digits, decimals: f.decimals, slantDeg: sl, lightSegments: opts.lightSegments });
        sc += num.test(r.text) ? r.confidence : r.confidence * 0.3;
      });
      if (sc > best) { best = sc; slant = sl; }
    });
    var conf = {};
    Object.keys(fields).forEach(function (k) {
      if (!fields[k].enabled) return;
      var r = refineField(img, fields[k], { slantDeg: slant, lightSegments: opts.lightSegments, format: k === "time" ? "time" : "number" });
      fields[k] = r.field; conf[k] = r.confidence;
    });
    return { quad: lcdQuad, fields: fields, slantDeg: slant, confidence: conf, score: 0.3, method: method };
  }

  /**
   * Cuántas de las tres lecturas (IN, OUT, humedad) son plausibles: temperatura con 3 dígitos
   * (p. ej. 28.3) entre −20 y 60 °C, humedad de 2 dígitos entre 5 y 99 %, confianza ≥ 50 %.
   * res.meanConf queda con la confianza media de las plausibles (para comparar resultados).
   */
  function plausibleHtc2(frame, res) {
    var lcd = prepareLcd(frame, res.quad, 480), ok = 0, sum = 0;
    ["tempIn", "tempOut", "humidity"].forEach(function (k) {
      var f = res.fields[k];
      if (!f) return;
      var r = decodeField(lcd.img, { x: f.x * lcd.size.w, y: f.y * lcd.size.h, w: f.w * lcd.size.w, h: f.h * lcd.size.h }, { digits: f.digits, decimals: f.decimals, slantDeg: res.slantDeg != null ? res.slantDeg : 6 });
      var v = parseFloat(r.text);
      // el HTC-2 no muestra ceros a la izquierda («00.0», «05»): eso es una lectura equivocada
      var shapeOk = k === "humidity" ? /^[1-9]\d$/.test(r.text) && v >= 5 && v <= 99 : /^-?[1-9]\d\.\d$/.test(r.text) && v >= -20 && v <= 60;
      if (shapeOk && r.confidence >= 50) { ok++; sum += r.confidence; }
    });
    res.meanConf = ok ? sum / ok : 0;
    return ok;
  }

  function snapModel(frame, quad, base, opts) {
    var lcd = prepareLcd(frame, quad, 480);
    var fit = fitHtc2(lcd.img, base, opts.hint ? Object.assign({}, opts, { hint: { x: opts.hint.x * lcd.size.w, y: opts.hint.y * lcd.size.h, w: opts.hint.w * lcd.size.w, h: opts.hint.h * lcd.size.h } }) : opts);
    if (!fit) return null;
    var lcdQuad = rectToFrame(quad, lcd.size, fit.rect);
    if (!lcdQuad) return null;
    // Inclinación residual (el cuadrilátero marcado puede estar algo girado respecto a la
    // pantalla): se mide en las filas de dígitos y, si pasa de ~1°, se corrige y se reajusta.
    if (!opts.noAngle) {
      var r = fit.rect, ink = digitInk(lcd.img, opts.lightSegments);
      var ang = rowAngle(ink, lcd.size.w, r.x, r.y, r.x + r.w, r.y + r.h);
      if (Math.abs(ang) > 0.017) {
        var c0 = quadCenter(lcdQuad), cs = Math.cos(ang), sn = Math.sin(ang), g = 1.12;
        var rq = lcdQuad.map(function (p) { var dx = (p.x - c0.x) * g, dy = (p.y - c0.y) * g; return { x: c0.x + dx * cs - dy * sn, y: c0.y + dx * sn + dy * cs }; });
        var again = snapModel(frame, rq, base, Object.assign({}, opts, { noAngle: true, hint: { x: 0.06 / g, y: 0.06 / g, w: 1 / g, h: 1 / g } }));
        if (again && again.score >= fit.score) return again;
      }
    }
    // con el cuadrilátero ya ajustado al LCD, los campos parten de la distribución del HTC-2
    var lcd2 = prepareLcd(frame, lcdQuad, 480), fields = JSON.parse(JSON.stringify(base)), conf = {};
    Object.keys(fields).forEach(function (k) {
      var m = HTC2_FIELDS_DEFAULT[k];
      if (m) { fields[k].x = m.x; fields[k].y = m.y; fields[k].w = m.w; fields[k].h = m.h; }
      if (!fields[k].enabled) return;
      var r = refineField(lcd2.img, fields[k], { slantDeg: opts.slantDeg, lightSegments: opts.lightSegments, format: k === "time" ? "time" : "number" });
      fields[k] = r.field; conf[k] = r.confidence;
    });
    return { quad: lcdQuad, fields: fields, confidence: conf, score: fit.score };
  }

  /**
   * ¿Hay un HTC-2 en este cuadrilátero, con los dígitos donde la calibración dice?
   * Verificación rápida (una sola evaluación) para el seguimiento: rechaza camisas,
   * cajas, etc. @returns correlación 0–1 (≥ 0,25 ≈ pantalla con dígitos)
   */
  function screenScore(frame, quad, fields, opts) {
    var lcd = prepareLcd(frame, quad, 200);
    if (lcd.contrast < 6) return 0;
    var ink = digitInk(lcd.img, opts && opts.lightSegments), M = inkIntegral(ink, lcd.img.w, lcd.img.h, 1);
    return Math.max(0, modelScore(M, modelBoxes(fields), 0, 0, M.w, M.h));
  }

  /**
   * Inclinación de las filas de dígitos dentro de una ventana (rad): el ángulo que
   * hace más «nítido» el perfil horizontal de la tinta (enderezado clásico).
   */
  function rowAngle(ink, W, x0, y0, x1, y1) {
    var pts = [];
    for (var y = Math.max(0, y0 | 0); y < y1; y++) for (var x = Math.max(0, x0 | 0); x < Math.min(W, x1); x++) if (ink[y * W + x]) pts.push(x - x0, y - y0);
    if (pts.length < 80) return 0;
    var stride = Math.max(1, Math.round(pts.length / 2 / 4000)) * 2; // como mucho ~4000 puntos
    var n = Math.ceil((y1 - y0) * 2 + (x1 - x0) * 2), off = n / 2, hist = new Float64Array(n + 1);
    var sharp = function (a) {
      var sn = Math.sin(a), cs = Math.cos(a), v = 0, j;
      hist.fill(0);
      for (var i = 0; i < pts.length; i += stride) { var b = Math.round(-pts[i] * sn + pts[i + 1] * cs + off); if (b >= 0 && b <= n) hist[b]++; }
      for (j = 0; j <= n; j++) v += hist[j] * hist[j];
      return v;
    };
    var best = 0, bestV = -1, deg;
    for (deg = -14; deg <= 14; deg += 2) { var v1 = sharp((deg * Math.PI) / 180); if (v1 > bestV) { bestV = v1; best = deg; } }
    var fine = best;
    for (deg = best - 1.5; deg <= best + 1.5; deg += 0.5) { var v2 = sharp((deg * Math.PI) / 180); if (v2 > bestV) { bestV = v2; fine = deg; } }
    return (fine * Math.PI) / 180;
  }

  /**
   * Detección de HTC-2 en toda la imagen por su PATRÓN DE DÍGITOS (no depende de que
   * el LCD tenga marco oscuro: sirve con carcasa blanca y LCD gris). Ventana
   * deslizante del modelo sobre el mapa de tinta (pantallas casi derechas) y cada
   * candidato se encaja con snapHtc2; solo quedan los que dan una lectura plausible.
   * @returns [{ quad (LCD, px), score, area, kind: "dígitos", fields, confidence }] de mejor a peor
   */
  function detectHtc2(frame, base, opts) {
    opts = opts || {};
    var f = Math.max(1, Math.round(frame.w / (opts.workWidth || 640)));
    var img = downscale(frame, f), W = img.w, H = img.h;
    var ink = dropLines(inkMask(img, Math.max(4, Math.round(W / 60)), opts.lightSegments), W, H, W * 0.06, H * 0.08, 1);
    var M = inkIntegral(ink, W, H, 1), FX = modelBoxes(null), cands = [];
    for (var lw = Math.round(W * 0.05); lw <= W * 0.35; lw = Math.round(lw * 1.12) + 1) {
      [0.85, 1, 1.18].forEach(function (ak) {
        var lh = Math.round(lw / (HTC2_ASPECT * ak)), mx = Math.round(lw * 0.3), my = Math.round(lh * 0.3);
        var step = Math.max(1, Math.round(lw / 14));
        for (var y = my; y + lh + my <= H; y += step) {
          for (var x = mx; x + lw + mx <= W; x += step) {
            var sc = modelScore(M, FX, x, y, lw, lh, [x - mx, y - my, x + lw + mx, y + lh + my]);
            if (sc < 0.15) continue;
            var bal = modelBalance(M, FX, x, y, lw, lh);
            if (bal < 0.3) continue;
            // significancia: una correlación en una ventana chica puede ser casualidad
            cands.push({ sc: sc * Math.sqrt((lw + 2 * mx) * (lh + 2 * my)) * (0.6 + 0.4 * bal), x: x, y: y, w: lw, h: lh });
          }
        }
      });
    }
    cands.sort(function (a, b) { return b.sc - a.sc; });
    var kept = [];
    for (var i = 0; i < cands.length && kept.length < (opts.maxCandidates || 6); i++) {
      var c = cands[i], cx = c.x + c.w / 2, cy = c.y + c.h / 2;
      // supresión de no-máximos solo entre ventanas de tamaño parecido (una ventana que
      // abarca dos equipos no debe tapar a las de cada equipo)
      if (kept.some(function (k) { var r = c.w / k.w; return r > 0.7 && r < 1.45 && Math.abs(cx - (k.x + k.w / 2)) < Math.max(c.w, k.w) * 0.6 && Math.abs(cy - (k.y + k.h / 2)) < Math.max(c.h, k.h) * 0.6; })) continue;
      kept.push(c);
    }
    var out = [];
    kept.forEach(function (c) {
      if (opts.need && out.length >= opts.need) return; // ya se encontraron las pantallas buscadas
      // ventana holgada alrededor del candidato, girada según las filas de dígitos → encaje fino
      // (si no lee los tres valores, se reintenta con una ventana más grande)
      var ang = rowAngle(ink, W, c.x, c.y, c.x + c.w, c.y + c.h), cs = Math.cos(ang), sn0 = Math.sin(ang), sn = null;
      [0.25, 0.5].some(function (g) {
        var ccx = (c.x + c.w / 2) * f, ccy = (c.y + c.h / 2) * f, hw = c.w * (0.5 + g) * f, hh = c.h * (0.5 + g) * f;
        var q = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(function (p) { return { x: ccx + p[0] * cs - p[1] * sn0, y: ccy + p[0] * sn0 + p[1] * cs }; });
        // 1.er intento con pista (rápido); el 2.º, sin pista: búsqueda completa en la ventana grande
        var r = snapHtc2(frame, q, base, g < 0.4 ? Object.assign({}, opts, { hint: { x: g / (1 + 2 * g), y: g / (1 + 2 * g), w: 1 / (1 + 2 * g), h: 1 / (1 + 2 * g) } }) : opts);
        if (r && (!sn || (r.rank || 0) > (sn.rank || 0))) sn = r;
        return sn && (sn.rank || 0) >= 3000;
      });
      if (!sn || (sn.rank || 0) < 2000) return; // no lee al menos dos valores con forma válida
      // validación: el HTC-2 muestra temperaturas y humedad con forma de número
      var lcd = prepareLcd(frame, sn.quad, 480), ok = 0, confSum = 0;
      ["tempIn", "tempOut", "humidity"].forEach(function (k) {
        var fl = sn.fields[k];
        if (!fl) return;
        var r = decodeField(lcd.img, { x: fl.x * lcd.size.w, y: fl.y * lcd.size.h, w: fl.w * lcd.size.w, h: fl.h * lcd.size.h }, { digits: fl.digits, decimals: fl.decimals, slantDeg: sn.slantDeg != null ? sn.slantDeg : opts.slantDeg, lightSegments: opts.lightSegments });
        var v = parseFloat(r.text), plausible = (k === "humidity" ? /^[1-9]\d$/.test(r.text) && v >= 5 && v <= 99 : /^-?([1-9]\d|\d)\.\d$/.test(r.text) && !/^-?0\d/.test(r.text) && v >= -20 && v <= 60);
        if (plausible && r.confidence >= 30) { ok++; confSum += r.confidence; }
      });
      if (ok < 3) return; // las tres lecturas deben ser plausibles: si no, no es un HTC-2
      if (Math.hypot(sn.quad[1].x - sn.quad[0].x, sn.quad[1].y - sn.quad[0].y) < 70) return; // demasiado chico para leer
      var meanConf = confSum / ok;
      var cc = quadCenter(sn.quad);
      if (out.some(function (o) { return pointInQuad(o.quad, cc); })) return; // misma pantalla
      out.push({ quad: sn.quad, score: sn.score * 1000 + meanConf, area: quadArea(sn.quad), kind: "dígitos", fields: sn.fields, slantDeg: sn.slantDeg, confidence: sn.confidence });
    });
    return out.sort(function (a, b) { return b.score - a.score; });
  }

  // ─────────────── seguimiento por plantilla (correlación normalizada) ───────────────
  //
  // Tras ubicar una pantalla se guarda su APARIENCIA (una miniatura del equipo con
  // su carcasa). En cada lectura se busca esa miniatura en el frame: la mejor
  // coincidencia da la nueva posición aunque el sensor se haya movido. La
  // correlación normalizada tolera cambios de luz; los objetos oscuros de la
  // escena no la confunden porque se compara la forma completa del equipo.

  var TRACK_W = 480; // ancho de trabajo del seguimiento

  function workImage(frame) {
    var f = Math.max(1, Math.round(frame.w / TRACK_W));
    return { img: downscale(frame, f), f: f };
  }

  /** Crea la plantilla de un sensor a partir de su cuadrilátero (px del frame). */
  function makeTemplate(frame, quadPx) {
    var wk = workImage(frame), f = wk.f, img = wk.img;
    var xs = quadPx.map(function (p) { return p.x / f; }), ys = quadPx.map(function (p) { return p.y / f; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var mx = (x1 - x0) * 0.25, my = (y1 - y0) * 0.25; // incluye bisel y carcasa: más forma para reconocerlo
    var c = cropGray(img, x0 - mx, y0 - my, x1 - x0 + 2 * mx, y1 - y0 + 2 * my);
    if (c.img.w < 8 || c.img.h < 8) return null;
    return {
      w: c.img.w, h: c.img.h, data: Array.prototype.slice.call(c.img.d), f: f, frameW: frame.w,
      app: Array.prototype.slice.call(appearance(frame, quadPx)),
      quadRel: quadPx.map(function (p) { return { x: p.x / f - c.x, y: p.y / f - c.y }; }),
    };
  }

  function resizeGray(src, w, h) {
    var out = gray(w, h);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) out.d[y * w + x] = sample(src, ((x + 0.5) * src.w) / w - 0.5, ((y + 0.5) * src.h) / h - 0.5);
    return out;
  }

  /** Correlación normalizada de `t` sobre `img` en la ventana [x0..x1]×[y0..y1] (esquina sup-izq). */
  function nccSearch(img, t, x0, y0, x1, y1, step) {
    var W = img.w, tw = t.w, th = t.h, n = tw * th, tm = 0, i, x, y;
    for (i = 0; i < n; i++) tm += t.d[i];
    tm /= n;
    var tz = new Float32Array(n), tn = 0;
    for (i = 0; i < n; i++) { tz[i] = t.d[i] - tm; tn += tz[i] * tz[i]; }
    tn = Math.sqrt(tn) || 1;
    // integrales de la imagen (suma y suma de cuadrados) para media/varianza por ventana
    var I = new Float64Array((W + 1) * (img.h + 1)), I2 = new Float64Array((W + 1) * (img.h + 1));
    for (y = 0; y < img.h; y++) {
      var r = 0, r2 = 0;
      for (x = 0; x < W; x++) { var v = img.d[y * W + x]; r += v; r2 += v * v; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + r; I2[(y + 1) * (W + 1) + x + 1] = I2[y * (W + 1) + x + 1] + r2; }
    }
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(W - tw, Math.floor(x1)); y1 = Math.min(img.h - th, Math.floor(y1));
    var best = { score: -2, x: 0, y: 0 };
    for (y = y0; y <= y1; y += step) {
      for (x = x0; x <= x1; x += step) {
        var a = (y + th) * (W + 1) + x + tw, b = y * (W + 1) + x + tw, c = (y + th) * (W + 1) + x, d0 = y * (W + 1) + x;
        var sum = I[a] - I[b] - I[c] + I[d0], sum2 = I2[a] - I2[b] - I2[c] + I2[d0];
        var varI = sum2 - (sum * sum) / n;
        if (varI < n * 4) continue; // zona plana: no puede ser el equipo
        var dot = 0, k = 0;
        for (var ty = 0; ty < th; ty++) {
          var row = (y + ty) * W + x;
          for (var tx = 0; tx < tw; tx++) dot += tz[k++] * img.d[row + tx];
        }
        var score = dot / (tn * Math.sqrt(varI));
        if (score > best.score) best = { score: score, x: x, y: y };
      }
    }
    return best;
  }

  /**
   * Busca la plantilla en el frame. lastQuad (px del frame, opcional) acota la
   * búsqueda; si no aparece cerca, se busca en todo el frame.
   * @returns { quad (px del frame), score (−1..1), scale } o null
   */
  function trackTemplate(frame, tpl, lastQuad) {
    if (!tpl || !tpl.data) return null;
    var wk = workImage(frame), f = wk.f, img = wk.img;
    var k0 = (tpl.frameW / tpl.f) ? frame.w / f / (tpl.frameW / tpl.f) : 1; // cambio de resolución de cámara
    var base = { w: tpl.w, h: tpl.h, d: Uint8ClampedArray.from(tpl.data) };
    // Nivel grueso a la mitad de resolución para cubrir todo el frame rápido.
    var small = downscale(img, 2);
    var tryScales = function (scales, win) {
      var best = null;
      scales.forEach(function (s) {
        var tw = Math.round((base.w * k0 * s) / 2), th = Math.round((base.h * k0 * s) / 2);
        if (tw < 6 || th < 6 || tw >= small.w || th >= small.h) return;
        var t = resizeGray(base, tw, th);
        var r = win ? nccSearch(small, t, win.x0 / 2 - tw / 2, win.y0 / 2 - th / 2, win.x1 / 2 - tw / 2, win.y1 / 2 - th / 2, 1) : nccSearch(small, t, 0, 0, small.w, small.h, 1);
        if (!best || r.score > best.score) best = { score: r.score, x: r.x * 2, y: r.y * 2, s: s };
      });
      return best;
    };
    var scales = [0.8, 0.9, 1, 1.1, 1.25];
    var best = null;
    if (lastQuad) {
      var xs = lastQuad.map(function (p) { return p.x / f; }), ys = lastQuad.map(function (p) { return p.y / f; });
      var cx = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2, cy = (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2;
      var rx = Math.max(base.w * k0, img.w * 0.15), ry = Math.max(base.h * k0, img.h * 0.15);
      best = tryScales(scales, { x0: cx - rx, y0: cy - ry, x1: cx + rx, y1: cy + ry });
    }
    if (!best || best.score < 0.6) {
      var global = tryScales(scales, null);
      if (global && (!best || global.score > best.score)) best = global;
    }
    if (!best) return null;
    // Refinamiento a resolución de trabajo alrededor del mejor punto.
    var s = best.s, tw = Math.round(base.w * k0 * s), th = Math.round(base.h * k0 * s);
    var t = resizeGray(base, tw, th);
    var fine = nccSearch(img, t, best.x - 3, best.y - 3, best.x + 3, best.y + 3, 1);
    var fx = fine.score > -2 ? fine.x : best.x, fy = fine.score > -2 ? fine.y : best.y, score = Math.max(best.score, fine.score);
    var kx = tw / tpl.w, ky = th / tpl.h;
    return {
      score: score,
      scale: s * k0,
      quad: tpl.quadRel.map(function (p) { return { x: (fx + p.x * kx) * f, y: (fy + p.y * ky) * f }; }),
    };
  }

  function expandQuad(q, k) {
    var c = quadCenter(q);
    return q.map(function (p) { return { x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k }; });
  }

  var APP_W = 64, APP_H = 48;
  /** Apariencia enderezada del equipo (LCD + bisel + algo de carcasa): no depende de rotación ni perspectiva. */
  function appearance(frame, q) { return warpQuad(frame, expandQuad(q, 1.35), APP_W, APP_H).d; }

  /** Correlación normalizada entre dos arreglos del mismo tamaño (−1..1). */
  function ncc(a, b) {
    var n = a.length, ma = 0, mb = 0, i;
    for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    var sab = 0, saa = 0, sbb = 0;
    for (i = 0; i < n; i++) { var x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
    return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
  }

  /**
   * Seguimiento conjunto de varios sensores (idénticos entre sí) en un frame.
   * Para cada sensor se proponen posiciones (ajuste donde estaba, búsqueda de su
   * plantilla, y si hace falta detección en toda la imagen); cada propuesta se
   * verifica comparando su apariencia enderezada con la guardada y se prefiere
   * la más cercana a su posición anterior. Dos sensores nunca toman la misma pantalla.
   * sensors: [{ id, tpl, last (quad LCD en px o null) }]
   * @returns { id: { quad (LCD, px) | null, score, how } }
   */
  function trackScreens(frame, sensors, opts) {
    opts = opts || {};
    var minScore = opts.minScore == null ? 0.55 : opts.minScore;
    var minDigits = opts.minDigits == null ? 0.15 : opts.minDigits;
    var diag = Math.hypot(frame.w, frame.h), taken = [], out = {}, globalProps = null;
    var fitNear = function (pt, q) {
      var w = q ? Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) : frame.w * 0.1;
      return fitLcdAt(frame, pt, w);
    };
    sensors.forEach(function (s) {
      var app = s.tpl && s.tpl.app;
      if (!app) { out[s.id] = { quad: null, score: 0, how: "sin plantilla" }; return; }
      var best = null;
      // Los sensores son IDÉNTICOS: un sensor nunca puede tomar la pantalla donde está otro
      // (si no, A «se queda» con la de B y B aparece no encontrado).
      var others = sensors.filter(function (o) { return o !== s && o.last; }).map(function (o) { return expandQuad(o.last, 1.1); });
      var mine = function (c) { return !others.some(function (q) { return pointInQuad(q, c); }); };
      // 0. ¿Sigue donde estaba? (lo normal: el equipo no se mueve). Si se parece mucho a la
      //    plantilla se queda; si se parece algo, además debe tener dígitos donde la
      //    calibración dice. Así un sensor aceptado no aparece «no encontrado» sin moverse.
      if (s.last && !taken.some(function (t) { return pointInQuad(t, quadCenter(s.last)); })) {
        var v0 = ncc(appearance(frame, s.last), app);
        if (v0 >= 0.8 || (v0 >= 0.55 && (!s.fields || screenScore(frame, s.last, s.fields, opts) >= minDigits))) {
          out[s.id] = { quad: s.last, score: v0, how: "en su lugar" };
          taken.push(expandQuad(s.last, 1.2));
          return;
        }
      }
      var consider = function (q, how) {
        if (!q) return;
        var c = quadCenter(q);
        if (taken.some(function (t) { return pointInQuad(t, c); }) || !mine(c)) return; // ya es de otro sensor
        // solo se acepta un lugar donde hay una pantalla con dígitos (no una camisa o una caja)
        if (s.fields && screenScore(frame, q, s.fields, opts) < minDigits) return;
        var v = ncc(appearance(frame, q), app);
        var move = s.last ? Math.hypot(c.x - quadCenter(s.last).x, c.y - quadCenter(s.last).y) / diag : 0;
        var rank = v - 0.3 * Math.min(1, move * 2);
        if (!best || rank > best.rank) best = { quad: q, score: v, rank: rank, how: how };
      };
      // 1. ¿sigue donde estaba (o se movió poco)?
      if (s.last) consider(fitNear(quadCenter(s.last), s.last), "ajuste local");
      // 2. búsqueda de la plantilla (cerca y, si no aparece, en todo el frame)
      if (!best || best.score < 0.75) {
        var tr = trackTemplate(frame, s.tpl, s.last);
        if (tr && tr.score > 0.35) {
          consider(fitNear(quadCenter(tr.quad), tr.quad), "plantilla + ajuste");
          consider(tr.quad, "plantilla");
        }
      }
      // 3. detección de pantallas en toda la imagen
      if (!best || best.score < 0.65) {
        if (!globalProps) globalProps = detectLcds(frame).map(function (c) { return c.quad; });
        globalProps.forEach(function (q) { consider(q, "detección"); });
      }
      if (best && best.score >= minScore) {
        out[s.id] = { quad: best.quad, score: best.score, how: best.how };
        taken.push(expandQuad(best.quad, 1.2));
      } else {
        out[s.id] = { quad: null, score: best ? best.score : 0, how: "no encontrado" };
      }
    });
    return out;
  }

  // ─────────────────────── dibujo (simulador / pruebas) ───────────────────────

  function fillBox(img, roi, ci, digits, box, tanSlant, val) {
    var y0 = Math.max(0, Math.floor(roi.y + box[2] * roi.h)), y1 = Math.min(img.h - 1, Math.ceil(roi.y + box[3] * roi.h) - 1);
    for (var y = y0; y <= y1; y++) {
      var v = (y + 0.5 - roi.y) / roi.h;
      var pa = digitPoint(roi, ci, digits, box[0], v, tanSlant), pb = digitPoint(roi, ci, digits, box[1], v, tanSlant);
      var x0 = Math.max(0, Math.round(pa.x)), x1 = Math.min(img.w - 1, Math.round(pb.x) - 1);
      for (var x = x0; x <= x1; x++) img.d[y * img.w + x] = val;
    }
  }

  /** Dibuja `text` ("31.5", "68", "12:00", "-3.2", "LL.L") en el campo `roi`. */
  function renderField(img, roi, text, opts) {
    var digits = opts.digits, tanSlant = Math.tan(((opts.slantDeg || 0) * Math.PI) / 180), ink = opts.ink == null ? 40 : opts.ink;
    var raw = String(text);
    // hora como en el HTC-2: horas (0–44 %) · dos puntos · minutos (56–100 %)
    if (digits === 4 && raw.indexOf(":") >= 0 && !opts._part) {
      var hm = raw.split(":"), sub = function (t, x0) { renderField(img, { x: roi.x + roi.w * x0, y: roi.y, w: roi.w * 0.44, h: roi.h }, t, Object.assign({}, opts, { digits: 2, _part: true })); };
      sub(hm[0], 0); sub(hm[1], 0.56);
      var kw = Math.max(2, roi.w * 0.03), kx = roi.x + roi.w * 0.5;
      [0.3, 0.7].forEach(function (vv) {
        for (var y3 = Math.floor(roi.y + roi.h * (vv - 0.05)); y3 < roi.y + roi.h * (vv + 0.05); y3++)
          for (var x3 = Math.floor(kx - kw / 2); x3 < kx + kw / 2; x3++) if (x3 >= 0 && y3 >= 0 && x3 < img.w && y3 < img.h) img.d[y3 * img.w + x3] = ink;
      });
      return;
    }
    var dotIdx = raw.indexOf("."), colon = raw.indexOf(":") >= 0;
    var chars = raw.replace(/[.:]/g, "").split("");
    while (chars.length < digits) chars.unshift(" ");
    chars = chars.slice(-digits);
    for (var ci = 0; ci < digits; ci++) {
      var pat = CANONICAL[chars[ci]] || "0000000";
      for (var s = 0; s < 7; s++) if (pat[s] === "1") fillBox(img, roi, ci, digits, DRAW_BOX[s], tanSlant, ink);
    }
    var cellW = roi.w / digits;
    if (dotIdx >= 0) {
      var decimals = raw.length - dotIdx - 1, cell = digits - decimals - 1;
      var cx = roi.x + (cell + 1) * cellW - cellW * 0.03, dotW = Math.max(2, cellW * 0.06);
      for (var y = Math.floor(roi.y + roi.h * 0.9); y < roi.y + roi.h; y++)
        for (var x = Math.floor(cx - dotW / 2); x < cx + dotW / 2; x++) if (x >= 0 && y >= 0 && x < img.w && y < img.h) img.d[y * img.w + x] = ink;
    }
    if (colon) {
      var kx = roi.x + 2 * cellW, kw = Math.max(2, cellW * 0.05);
      [0.3, 0.7].forEach(function (vv) {
        for (var y2 = Math.floor(roi.y + roi.h * (vv - 0.05)); y2 < roi.y + roi.h * (vv + 0.05); y2++)
          for (var x2 = Math.floor(kx - kw / 2); x2 < kx + kw / 2; x2++) if (x2 >= 0 && y2 >= 0 && x2 < img.w && y2 < img.h) img.d[y2 * img.w + x2] = ink;
      });
    }
  }

  /** Generador pseudoaleatorio con semilla (mulberry32). */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Ruido de sensor: tabla precalculada (llamar al generador por píxel es ~30× más lento). */
  function addNoise(img, amp, rand) {
    if (!amp) return img;
    var table = new Float32Array(8192), i;
    for (i = 0; i < table.length; i++) table[i] = (rand() * 2 - 1) * amp;
    var off = Math.floor(rand() * 8192), step = 1 + 2 * Math.floor(rand() * 2000); // paso impar → recorre toda la tabla
    for (i = 0; i < img.d.length; i++) img.d[i] = img.d[i] + table[(off + i * step) & 8191];
    return img;
  }

  /**
   * Dibuja un display tipo HTC-2 (w×h) con los valores dados y la distribución de
   * campos `fields` (normalizada 0–1). values: { tempIn, tempOut, humidity, time } como texto.
   * opts: { slantDeg, noise, seed, blank, bg, ink }
   */
  function renderDisplay(w, h, values, fields, opts) {
    opts = opts || {};
    var bg = opts.bg == null ? 196 : opts.bg;
    var img = gray(w, h, opts.blank ? 150 : bg);
    var rand = rng(opts.seed || 1);
    if (!opts.blank) {
      Object.keys(fields).forEach(function (key) {
        var f = fields[key];
        if (!f || values[key] == null || values[key] === "") return;
        var roi = { x: f.x * w, y: f.y * h, w: f.w * w, h: f.h * h };
        renderField(img, roi, values[key], { digits: f.digits, slantDeg: opts.slantDeg || 0, ink: opts.ink });
        // rótulo pequeño ("IN", "OUT", "RH") a la izquierda del campo, fuera de la zona de lectura
        var ly = Math.floor(roi.y + roi.h * 0.1), lx = Math.max(1, Math.floor(roi.x - w * 0.04));
        for (var yy = ly; yy < ly + Math.max(2, h * 0.012); yy++) for (var xx = lx; xx < lx + Math.max(3, w * 0.025); xx++) if (xx < w && yy < h) img.d[yy * w + xx] = 90;
        // HTC-2 real: «°C» / «%» a la derecha del valor (más bajo que un dígito)
        if (opts.decor && key !== "time") {
          var sx0 = Math.floor(roi.x + roi.w + w * 0.012), sw = Math.max(4, Math.floor(w * 0.05)), sy0 = Math.floor(roi.y + roi.h * 0.08), sh = Math.floor(roi.h * 0.38), th = Math.max(2, Math.floor(h * 0.008));
          for (var cy2 = sy0; cy2 < sy0 + sh; cy2++) for (var cx2 = sx0; cx2 < sx0 + sw; cx2++) {
            if (cx2 >= w || cy2 >= h) continue;
            if (cx2 < sx0 + th || cy2 < sy0 + th || cy2 >= sy0 + sh - th) img.d[cy2 * w + cx2] = opts.ink == null ? 40 : opts.ink;
          }
        }
      });
      if (opts.decor) {
        // líneas separadoras entre filas (trazos largos del LCD del HTC-2)
        [0.32, 0.655].forEach(function (fy) {
          var t = Math.max(2, Math.round(h * 0.007)), y0 = Math.round(fy * h);
          for (var yy2 = y0; yy2 < y0 + t; yy2++) for (var xx2 = Math.round(w * 0.02); xx2 < w * 0.98; xx2++) img.d[yy2 * w + xx2] = opts.ink == null ? 40 : opts.ink;
        });
      }
    }
    return addNoise(img, opts.noise == null ? 6 : opts.noise, rand);
  }

  /**
   * Frame simulado de cámara (W×H) con varios displays ubicados en sus cuadriláteros (px).
   * sensors: [{ quad, values, fields, slantDeg, blank, hidden }]
   */
  function makeSimFrame(W, H, sensors, opts) {
    opts = opts || {};
    var frame = gray(W, H), rand = rng(opts.seed || 7);
    var wave = new Float32Array(W);
    for (var x0 = 0; x0 < W; x0++) wave[x0] = 12 * Math.sin(x0 / 37);
    for (var y = 0; y < H; y++) {
      var base = 95 + 30 * (y / H);
      for (var x = 0; x < W; x++) frame.d[y * W + x] = base + wave[x];
    }
    if (opts.clutter) {
      // escena con objetos: cajas claras/oscuras, una fila de «texto» y una tela con textura
      var cr = rng(opts.seed || 7);
      for (var ci = 0; ci < 14; ci++) {
        var bx = cr() * W * 0.9, by = cr() * H * 0.9, bw = W * (0.03 + cr() * 0.15), bh = H * (0.03 + cr() * 0.2);
        placeImage(frame, gray(4, 4, 30 + cr() * 200), [{ x: bx, y: by }, { x: bx + bw, y: by }, { x: bx + bw, y: by + bh }, { x: bx, y: by + bh }]);
      }
      var tx = W * 0.05, ty = H * 0.82;
      for (var tl = 0; tl < 12; tl++) placeImage(frame, gray(4, 4, 40), [{ x: tx + tl * W * 0.022, y: ty }, { x: tx + tl * W * 0.022 + W * 0.012, y: ty }, { x: tx + tl * W * 0.022 + W * 0.012, y: ty + H * 0.03 }, { x: tx + tl * W * 0.022, y: ty + H * 0.03 }]);
    }
    sensors.forEach(function (s, idx) {
      if (s.hidden) return;
      var size = rectifiedSize(s.quad, 480);
      // carcasa blanca y bisel negro del termohigrómetro alrededor del LCD (como el HTC-2 real)
      var cx = (s.quad[0].x + s.quad[2].x) / 2, cy = (s.quad[0].y + s.quad[2].y) / 2;
      var grow = function (kx, ky) { return s.quad.map(function (p) { return { x: cx + (p.x - cx) * kx, y: cy + (p.y - cy) * ky }; }); };
      // realista (HTC-2): marco negro ancho, cuerpo blanco abajo; opcional objeto oscuro pegado al marco
      var bz = s.bezel || [1.09, 1.12], body = s.body || [1.3, 1.5];
      placeImage(frame, gray(8, 8, 228), grow(body[0], body[1]));
      if (s.darkNeighbor) placeImage(frame, gray(8, 8, 35), grow(bz[0], bz[1]).map(function (p, j) { return j === 1 || j === 2 ? { x: p.x + (s.quad[1].x - s.quad[0].x) * 0.8, y: p.y } : p; }));
      placeImage(frame, gray(8, 8, s.bezelGray == null ? 28 : s.bezelGray), grow(bz[0], bz[1]));
      if (s.style === "real") {
        // franja negra «TEMPERATURE» sobre el LCD, con letras claras
        var hq = homography([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], s.quad);
        var uv = function (u, v) { return applyH(hq, u, v); };
        placeImage(frame, gray(8, 8, 30), [uv(0.02, -0.17), uv(0.6, -0.17), uv(0.6, -0.05), uv(0.02, -0.05)]);
        for (var li = 0; li < 9; li++) placeImage(frame, gray(4, 4, 170), [uv(0.05 + li * 0.06, -0.14), uv(0.09 + li * 0.06, -0.14), uv(0.09 + li * 0.06, -0.08), uv(0.05 + li * 0.06, -0.08)]);
      }
      var disp = renderDisplay(size.w, size.h, s.values, s.fields, { slantDeg: s.slantDeg, blank: s.blank, noise: opts.noise, seed: (opts.seed || 7) + idx * 101, bg: s.lcdBg, ink: s.lcdInk, decor: s.style === "real" });
      placeImage(frame, disp, s.quad);
    });
    frame = addNoise(frame, opts.noise == null ? 3 : opts.noise * 0.5, rand);
    for (var b = 0; b < (opts.blur || 0); b++) frame = boxBlur3(frame); // desenfoque de cámara
    return frame;
  }

  root.MonSeg = {
    gray: gray,
    fromRGBA: fromRGBA,
    toRGBA: toRGBA,
    sample: sample,
    homography: homography,
    applyH: applyH,
    warpQuad: warpQuad,
    placeImage: placeImage,
    rectifiedSize: rectifiedSize,
    boxBlur3: boxBlur3,
    sharpen: sharpen,
    normalize: normalize,
    otsu: otsu,
    threshold: threshold,
    stats: stats,
    thumbnail: thumbnail,
    thumbDiff: thumbDiff,
    thumbToB64: thumbToB64,
    b64ToThumb: b64ToThumb,
    decodeField: decodeField,
    renderField: renderField,
    renderDisplay: renderDisplay,
    makeSimFrame: makeSimFrame,
    detectScreens: detectScreens,
    detectLcdHoles: detectLcdHoles,
    detectLcds: detectLcds,
    matchScreens: matchScreens,
    fitScreenAt: fitScreenAt,
    fitLcdAt: fitLcdAt,
    prepareLcd: prepareLcd,
    innerScreen: innerScreen,
    fitHtc2: fitHtc2,
    refineField: refineField,
    snapHtc2: snapHtc2,
    plausibleHtc2: plausibleHtc2,
    fitToExample: fitToExample,
    locateHtc2: locateHtc2,
    findHtc2Lcd: findHtc2Lcd,
    detectHtc2: detectHtc2,
    rectToFrame: rectToFrame,
    screenScore: screenScore,
    makeTemplate: makeTemplate,
    trackTemplate: trackTemplate,
    trackScreens: trackScreens,
    refineEdges: refineEdges,
    cropGray: cropGray,
    pointInQuad: pointInQuad,
    downscale: downscale,
    quadArea: quadArea,
    quadCenter: quadCenter,
    rng: rng,
    SEG_NAMES: SEG_NAMES,
    SAMPLE_BOX: SAMPLE_BOX,
    PADX: PADX,
  };
})(typeof self !== "undefined" ? self : globalThis);


/* ===== logic.js ===== */
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


/* ===== thermal.js ===== */
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


/* ===== xlsx.js ===== */
/*
 * BioTeva Monitor — generador de Excel (.xlsx) sin dependencias.
 *
 * Un .xlsx es un ZIP con XML (Office Open XML). Aquí se escribe el ZIP en modo
 * "stored" (sin compresión; válido y compatible con Excel, LibreOffice y Google
 * Sheets) con su CRC-32. Las fechas se guardan como fecha/hora real de Excel
 * (número de serie con formato), no como texto, para poder filtrar y graficar.
 *
 *   MonXlsx.build([{ name, columns: [{ header, type, width }], rows: [[...]] }]) → Uint8Array
 *   type: "string" | "number" | "number1" | "number2" | "integer" | "datetime" (ms epoch) | "wrap"
 */
(function (root) {
  "use strict";

  var CRC_TABLE = (function () {
    var t = new Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function utf8(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    var out = [], s = unescape(encodeURIComponent(str));
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return new Uint8Array(out);
  }

  /**
   * ZIP. files: [{ name, data: Uint8Array, comp?: Uint8Array }] — si `comp` existe
   * (deflate crudo de `data`), la entrada va comprimida; si no, "stored".
   */
  function zip(files, date) {
    var d = date || new Date();
    var dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    var dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    var chunks = [], central = [], offset = 0;

    function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
    function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

    files.forEach(function (f) {
      var name = utf8(f.name), data = f.data, crc = crc32(data);
      var method = f.comp ? 8 : 0, body = f.comp || data;
      var local = [].concat(u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(dosTime), u16(dosDate), u32(crc), u32(body.length), u32(data.length), u16(name.length), u16(0));
      chunks.push(new Uint8Array(local), name, body);
      central.push({ name: name, crc: crc, size: data.length, csize: body.length, method: method, offset: offset });
      offset += local.length + name.length + body.length;
    });
    var cdStart = offset, cdSize = 0;
    central.forEach(function (c) {
      var hdr = [].concat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(c.method), u16(dosTime), u16(dosDate), u32(c.crc), u32(c.csize), u32(c.size), u16(c.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.offset));
      chunks.push(new Uint8Array(hdr), c.name);
      cdSize += hdr.length + c.name.length;
    });
    chunks.push(new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cdSize), u32(cdStart), u16(0))));
    var total = chunks.reduce(function (a, c) { return a + c.length; }, 0), out = new Uint8Array(total), pos = 0;
    chunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
    return out;
  }

  function esc(s) {
    return String(s)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function colName(i) {
    var s = "";
    i++;
    while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }

  /** ms epoch → número de serie de Excel en hora LOCAL del equipo. */
  function excelSerial(ms) {
    var off = new Date(ms).getTimezoneOffset() * 60000;
    return (ms - off) / 86400000 + 25569;
  }

  // estilos (índices de cellXfs)
  var STYLE = { string: 0, datetime: 1, number1: 2, header: 3, integer: 4, number2: 5, wrap: 6, number: 0 };

  var STYLES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/><numFmt numFmtId="165" formatCode="0.0"/><numFmt numFmtId="166" formatCode="0.00"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF1B4D2E"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="7">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>' +
    "</cellXfs>" +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    "</styleSheet>";

  function sheetXml(sheet) {
    var cols = sheet.columns, rows = sheet.rows || [];
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
    out.push('<dimension ref="A1:' + colName(Math.max(0, cols.length - 1)) + (rows.length + 1) + '"/>');
    out.push('<sheetViews><sheetView workbookViewId="0"' + (sheet.freeze === false ? "" : '><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView>') + (sheet.freeze === false ? "/>" : "") + "</sheetViews>");
    out.push("<cols>" + cols.map(function (c, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (c.width || 14) + '" customWidth="1"/>'; }).join("") + "</cols>");
    out.push("<sheetData>");
    out.push('<row r="1">' + cols.map(function (c, i) { return '<c r="' + colName(i) + '1" t="inlineStr" s="3"><is><t>' + esc(c.header) + "</t></is></c>"; }).join("") + "</row>");
    rows.forEach(function (row, ri) {
      var r = ri + 2, cells = [];
      cols.forEach(function (c, ci) {
        var v = row[ci], ref = colName(ci) + r;
        if (v === null || v === undefined || v === "") return;
        var type = c.type || "string";
        if (type === "datetime") {
          if (typeof v === "number" && isFinite(v)) cells.push('<c r="' + ref + '" s="1"><v>' + excelSerial(v) + "</v></c>");
          return;
        }
        if (type === "number" || type === "number1" || type === "number2" || type === "integer") {
          var n = Number(v);
          if (isFinite(n)) {
            cells.push('<c r="' + ref + '" s="' + STYLE[type] + '"><v>' + n + "</v></c>");
            return;
          }
        }
        cells.push('<c r="' + ref + '" t="inlineStr"' + (type === "wrap" ? ' s="6"' : "") + '><is><t xml:space="preserve">' + esc(v) + "</t></is></c>");
      });
      out.push('<row r="' + r + '">' + cells.join("") + "</row>");
    });
    out.push("</sheetData>");
    if (sheet.autoFilter !== false && cols.length) out.push('<autoFilter ref="A1:' + colName(cols.length - 1) + (rows.length + 1) + '"/>');
    out.push("</worksheet>");
    return out.join("");
  }

  function safeSheetName(name, used) {
    var n = String(name).replace(/[\\\/\?\*\[\]:]/g, " ").slice(0, 31) || "Hoja";
    var base = n, k = 2;
    while (used[n]) n = base.slice(0, 28) + " " + k++;
    used[n] = true;
    return n;
  }

  /** Partes del libro (sin comprimir). */
  function parts(sheets) {
    var used = {};
    var names = sheets.map(function (s) { return safeSheetName(s.name, used); });
    var files = [];
    files.push({
      name: "[Content_Types].xml",
      data: utf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
          sheets.map(function (_, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join("") +
          "</Types>",
      ),
    });
    files.push({
      name: "_rels/.rels",
      data: utf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
          "</Relationships>",
      ),
    });
    var nowIso = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    files.push({
      name: "docProps/core.xml",
      data: utf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
          "<dc:title>BioTeva — Monitoreo ambiental</dc:title><dc:creator>BioTeva Monitor</dc:creator>" +
          '<dcterms:created xsi:type="dcterms:W3CDTF">' + nowIso + "</dcterms:created>" +
          "</cp:coreProperties>",
      ),
    });
    files.push({
      name: "xl/workbook.xml",
      data: utf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          "<sheets>" + names.map(function (n, i) { return '<sheet name="' + esc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join("") + "</sheets>" +
          "<definedNames>" +
          sheets.map(function (s, i) {
            if (s.autoFilter === false || !s.columns.length) return "";
            return '<definedName name="_xlnm._FilterDatabase" localSheetId="' + i + '" hidden="1">\'' + esc(names[i]).replace(/'/g, "''") + "'!$A$1:$" + colName(s.columns.length - 1) + "$" + ((s.rows || []).length + 1) + "</definedName>";
          }).join("") +
          "</definedNames>" +
          "</workbook>",
      ),
    });
    files.push({
      name: "xl/_rels/workbook.xml.rels",
      data: utf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          sheets.map(function (_, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join("") +
          '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
          "</Relationships>",
      ),
    });
    files.push({ name: "xl/styles.xml", data: utf8(STYLES_XML) });
    sheets.forEach(function (s, i) { files.push({ name: "xl/worksheets/sheet" + (i + 1) + ".xml", data: utf8(sheetXml(s)) }); });
    return files;
  }

  /** Libro .xlsx sin compresión (síncrono). */
  function build(sheets) { return zip(parts(sheets)); }

  function deflateRaw(data) {
    return new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  /**
   * Libro .xlsx comprimido (deflate nativo del navegador, ~10× más pequeño).
   * Si el navegador no tiene CompressionStream, cae a la versión sin compresión.
   */
  function buildCompressed(sheets) {
    var files = parts(sheets);
    if (typeof CompressionStream === "undefined" || typeof Response === "undefined") return Promise.resolve(zip(files));
    return Promise.all(files.map(function (f) { return deflateRaw(f.data).then(function (c) { f.comp = c; }); }))
      .then(function () { return zip(files); })
      .catch(function () { files.forEach(function (f) { delete f.comp; }); return zip(files); });
  }

  root.MonXlsx = { build: build, buildCompressed: buildCompressed, zip: zip, crc32: crc32, colName: colName, excelSerial: excelSerial, utf8: utf8 };
})(typeof self !== "undefined" ? self : globalThis);


/* ===== store.js ===== */
/*
 * BioTeva Monitor — almacenamiento local (IndexedDB).
 *
 * Todo queda en ESTE navegador / perfil de Chrome: funciona sin internet y
 * sobrevive a reinicios. Cada instalación (página local, app instalada,
 * extensión) tiene su propia base; para moverla se usa Respaldo JSON.
 *
 * Almacenes: kv (configuración y sensores), readings, events, snapshots, reports.
 * Las marcas de tiempo son milisegundos epoch (UTC); se muestran en hora local.
 */
(function (root) {
  "use strict";

  var DB_NAME = "bioteva-monitor", DB_VERSION = 1;

  function req(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function done(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error("Transacción abortada")); };
    });
  }

  function open() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) return reject(new Error("Este navegador no permite almacenamiento local (IndexedDB)."));
      var r = root.indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = function () {
        var db = r.result;
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "k" });
        if (!db.objectStoreNames.contains("readings")) {
          var rs = db.createObjectStore("readings", { keyPath: "id" });
          rs.createIndex("ts", "ts");
          rs.createIndex("sensor_ts", ["sensorId", "ts"]);
          rs.createIndex("source", "source");
        }
        if (!db.objectStoreNames.contains("events")) {
          var es = db.createObjectStore("events", { keyPath: "id" });
          es.createIndex("ts", "ts");
          es.createIndex("sensor_ts", ["sensorId", "ts"]);
          es.createIndex("source", "source");
        }
        if (!db.objectStoreNames.contains("snapshots")) {
          var ss = db.createObjectStore("snapshots", { keyPath: "id" });
          ss.createIndex("ts", "ts");
        }
        if (!db.objectStoreNames.contains("reports")) {
          var rp = db.createObjectStore("reports", { keyPath: "id" });
          rp.createIndex("date", "date");
        }
      };
      r.onsuccess = function () { resolve(api(r.result)); };
      r.onerror = function () { reject(r.error); };
      r.onblocked = function () { reject(new Error("La base local está bloqueada por otra pestaña del monitor. Ciérrala e intenta de nuevo.")); };
    });
  }

  function api(db) {
    function store(name, mode) { return db.transaction(name, mode || "readonly").objectStore(name); }
    function getAll(src, range) { return req(src.getAll(range)); }

    return {
      db: db,

      getKV: function (k) { return req(store("kv").get(k)).then(function (r) { return r ? r.v : undefined; }); },
      setKV: function (k, v) {
        var tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put({ k: k, v: v });
        return done(tx);
      },

      /** Guarda lecturas y eventos de un ciclo en UNA transacción. */
      saveCycle: function (readings, events) {
        var tx = db.transaction(["readings", "events"], "readwrite");
        readings.forEach(function (r) { tx.objectStore("readings").put(r); });
        events.forEach(function (e) { tx.objectStore("events").put(e); });
        return done(tx);
      },
      putReading: function (r) {
        var tx = db.transaction("readings", "readwrite");
        tx.objectStore("readings").put(r);
        return done(tx);
      },

      readingsRange: function (from, to, sensorId) {
        if (sensorId) return getAll(store("readings").index("sensor_ts"), IDBKeyRange.bound([sensorId, from], [sensorId, to]));
        return getAll(store("readings").index("ts"), IDBKeyRange.bound(from, to));
      },
      lastReading: function (sensorId) {
        return new Promise(function (resolve, reject) {
          var r = store("readings").index("sensor_ts").openCursor(IDBKeyRange.bound([sensorId, -Infinity], [sensorId, Infinity]), "prev");
          r.onsuccess = function () { resolve(r.result ? r.result.value : null); };
          r.onerror = function () { reject(r.error); };
        });
      },
      countReadings: function () { return req(store("readings").count()); },

      eventsRange: function (from, to, sensorId) {
        if (sensorId) return getAll(store("events").index("sensor_ts"), IDBKeyRange.bound([sensorId, from], [sensorId, to]));
        return getAll(store("events").index("ts"), IDBKeyRange.bound(from, to));
      },
      ackEvent: function (id) {
        var tx = db.transaction("events", "readwrite"), os = tx.objectStore("events");
        var g = os.get(id);
        g.onsuccess = function () { if (g.result && !g.result.ack) { g.result.ack = Date.now(); os.put(g.result); } };
        return done(tx);
      },
      ackAll: function () {
        var tx = db.transaction("events", "readwrite"), os = tx.objectStore("events"), n = 0;
        var c = os.openCursor();
        c.onsuccess = function () {
          var cur = c.result;
          if (!cur) return;
          var e = cur.value;
          if (!e.ack && e.severity !== "INFO") { e.ack = Date.now(); cur.update(e); n++; }
          cur.continue();
        };
        return done(tx).then(function () { return n; });
      },

      addSnapshot: function (blob, meta) {
        var id = "snap-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
        var tx = db.transaction("snapshots", "readwrite");
        tx.objectStore("snapshots").put({ id: id, ts: meta.ts, sensorId: meta.sensorId || null, readingId: meta.readingId || null, blob: blob, bytes: blob.size });
        return done(tx).then(function () { return id; });
      },
      getSnapshot: function (id) { return req(store("snapshots").get(id)); },
      /** Borra evidencias anteriores a `beforeTs` (retención configurable). */
      purgeSnapshots: function (beforeTs) {
        var tx = db.transaction("snapshots", "readwrite"), n = 0;
        var c = tx.objectStore("snapshots").index("ts").openCursor(IDBKeyRange.upperBound(beforeTs, true));
        c.onsuccess = function () { var cur = c.result; if (!cur) return; cur.delete(); n++; cur.continue(); };
        return done(tx).then(function () { return n; });
      },
      countSnapshots: function () { return req(store("snapshots").count()); },

      addReport: function (rep) {
        var tx = db.transaction("reports", "readwrite");
        tx.objectStore("reports").put(rep);
        return done(tx);
      },
      listReports: function () {
        return getAll(store("reports")).then(function (all) { return all.sort(function (a, b) { return b.generatedAt - a.generatedAt; }); });
      },
      getReport: function (id) { return req(store("reports").get(id)); },

      /** Elimina los datos del modo simulación (lecturas y eventos). */
      deleteSimulated: function () {
        var tx = db.transaction(["readings", "events"], "readwrite"), n = { readings: 0, events: 0 };
        ["readings", "events"].forEach(function (name) {
          var c = tx.objectStore(name).index("source").openCursor(IDBKeyRange.only("simulation"));
          c.onsuccess = function () { var cur = c.result; if (!cur) return; cur.delete(); n[name]++; cur.continue(); };
        });
        return done(tx).then(function () { return n; });
      },
      hasSimulated: function () {
        return req(store("readings").index("source").count(IDBKeyRange.only("simulation"))).then(function (n) { return n > 0; });
      },

      /** Respaldo completo (sin fotos) para mover los datos a otro equipo/navegador. */
      exportBackup: function () {
        return Promise.all([getAll(store("kv")), getAll(store("readings")), getAll(store("events")), getAll(store("reports"))]).then(function (r) {
          return { app: "bioteva-monitor", version: 1, exportedAt: Date.now(), kv: r[0], readings: r[1], events: r[2], reports: r[3] };
        });
      },
      importBackup: function (data) {
        if (!data || data.app !== "bioteva-monitor") return Promise.reject(new Error("El archivo no es un respaldo de BioTeva Monitor."));
        var tx = db.transaction(["kv", "readings", "events", "reports"], "readwrite");
        (data.kv || []).forEach(function (x) { tx.objectStore("kv").put(x); });
        (data.readings || []).forEach(function (x) { tx.objectStore("readings").put(x); });
        (data.events || []).forEach(function (x) { tx.objectStore("events").put(x); });
        (data.reports || []).forEach(function (x) { tx.objectStore("reports").put(x); });
        return done(tx).then(function () { return { readings: (data.readings || []).length, events: (data.events || []).length }; });
      },
    };
  }

  root.MonStore = { open: open };
})(typeof self !== "undefined" ? self : globalThis);


/* ===== charts.js ===== */
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


/* ===== workbook.js ===== */
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


/* ===== app.js ===== */
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
      case "ayuda": return null; // guía estática (index.html)
    }
  }

  // ─────────────────────────── DASHBOARD ───────────────────────────

  async function renderDashboard() {
    const host = $('section[data-view="dashboard"]');
    const now = Date.now(), S = App.settings;
    const dayStart = L.dayBounds(L.dayKey(now)).from;
    const today = await App.store.readingsRange(dayStart, now);
    const cards = [];
    // «Qué hacer ahora»: acciones concretas a partir de las lecturas, tus límites y las lámparas
    const [recent3h, events24h] = await Promise.all([App.store.readingsRange(now - 3 * HOUR, now), App.store.eventsRange(now - DAY, now)]);
    const todo = L.actionItems({ sensors: App.sensors, readings: recent3h, events: events24h, thermal: window.MonThermalUI && window.MonThermalUI.getStatus ? window.MonThermalUI.getStatus() : null, running: App.running, now, settings: S });
    const KIND = { manejo: "Manejo", accidente: "Riesgo", sistema: "Sistema" };
    const todoHtml = '<div class="panel todo"><header><h2>Qué hacer ahora</h2></header><div class="panel-body"><ul class="todo-list">' +
      todo.map((t) => '<li class="todo-item ' + t.level + '"><span class="todo-tag">' + esc(t.level === "good" ? "OK" : KIND[t.kind] || "") + '</span><div><b>' + esc(t.title) + "</b><p>" + esc(t.action) + "</p></div></li>").join("") +
      "</ul></div></div>";
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
            (() => { const o = L.minutesOutOfRange(mine, s, now, S); const out = o.tempHigh + o.tempLow + o.humHigh + o.humLow; return s.tempMin == null && s.tempMax == null && s.humMin == null && s.humMax == null ? "" : "<div><dt>Hoy fuera de tus límites</dt><dd>" + (out ? esc(fmtMinutes(o.tempHigh + o.tempLow)) + " temp. · " + esc(fmtMinutes(o.humHigh + o.humLow)) + " humedad" : "nada") + "</dd></div>"; })() +
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
      todoHtml +
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
    $$('input[name="calSensor"]').forEach((r) => (r.checked = r.value === s.id));
    $$('input[name="calField"]').forEach((r) => (r.checked = r.value === App.cal.field));
    $("#calSlant").value = App.cal.draft.slantDeg;
    $("#calSlantOut").textContent = App.cal.draft.slantDeg + "°";
    $("#calLight").checked = !!App.cal.draft.lightSegments;
    $("#calTrack").checked = !!(App.cal.draft.track && App.cal.draft.track.enabled);
    $("#calMsg").textContent = "";
    $("#calSave").textContent = "✓ Aceptar ubicación del " + s.name;
    renderCalFlow();
    buildCalTable();
    drawCalibration(true);
  }

  /** Guía de la calibración: qué sensor falta ubicar y qué hacer ahora. */
  function renderCalFlow() {
    const host = $("#calFlow");
    if (!host) return;
    const list = App.sensors.filter((x) => x.enabled);
    const cur = sensorById(App.cal.sensorId);
    const chips = list.map((x) => {
      const ok = !!x.calibration.accepted;
      return '<button type="button" class="chip ' + (ok ? "ok" : "todo") + (x.id === cur.id ? " cur" : "") + '" data-calgo="' + x.id + '">' + (ok ? "✓ " : "○ ") + esc(x.name) + (ok ? " ubicado" : " pendiente") + "</button>";
    }).join("");
    const allOk = list.every((x) => x.calibration.accepted);
    const now = allOk && cur.calibration.accepted
      ? "✓ Todos los sensores están ubicados. Puedes volver a ajustar cualquiera (elígelo arriba) o ir a <b>▶ Iniciar monitoreo</b>."
      : "<b>Ahora: " + esc(cur.name) + ".</b> Haz <b>clic en el centro de su pantalla</b> o <b>arrastra un rectángulo</b> alrededor de ella (no hace falta exacto: se ajusta sola a la pantalla y coloca los cuadros sobre los números). Para moverlo, arrástralo desde adentro; las esquinas se pueden afinar. Revisa las lecturas de la derecha y pulsa <b>✓ Aceptar ubicación</b>.";
    host.innerHTML = '<div class="chips">' + chips + '</div><div class="now">' + now + "</div>";
    $$("[data-calgo]", host).forEach((b) => b.addEventListener("click", () => { App.cal.sensorId = b.dataset.calgo; App.cal.draft = null; openCalibration(); }));
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
      calMsg("No se reconocieron los números de un HTC-2 en esa zona. Puedes ajustar las esquinas a mano, acercar la cámara o mejorar la luz.", "crit");
      return false;
    }
    d.quad = normQuad(sn.quad, fr.gray.w, fr.gray.h);
    d.fields = sn.fields;
    App.cal.snapped = true;
    if (sn.slantDeg != null) { d.slantDeg = sn.slantDeg; $("#calSlant").value = sn.slantDeg; $("#calSlantOut").textContent = sn.slantDeg + "°"; }
    drawCalibration(false);
    const r = App.cal.lastRect, txt = r ? ["tempIn", "tempOut", "humidity"].map((k) => r.details[k] ? L.FIELD_LABELS[k] + " " + (r.details[k].text || "∅") : null).filter(Boolean).join(" · ") : "";
    calMsg("Pantalla de " + s.name + " ajustada: " + txt + ". Si coincide con lo que muestra el sensor, pulsa «✓ Aceptar ubicación».", "good");
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
    const cr = $("#calRead");
    if (cr) cr.innerHTML = ["tempIn", "tempOut", "humidity", "time"].map((k) => {
      const d = a.details[k], c = d ? d.confidence : 0, cls = !d ? "" : c >= 70 ? "good" : c >= 40 ? "warn" : "crit";
      return '<div class="rv ' + cls + '"><span class="k">' + esc(L.FIELD_LABELS[k]) + '</span><span class="v">' + esc(d ? d.text || "—" : "—") + '</span><span class="c">' + (d ? "confianza " + L.num(c, 0) + " %" : "no se lee") + "</span></div>";
    }).join("");
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
      calMsg("Buscando pantallas (puede tardar unos segundos)…");
      await new Promise((r) => setTimeout(r, 30));
      const res = autoAssign(fr.gray, App.sensors.filter((x) => x.enabled), true);
      await saveSensors();
      App.cal.draft = null;
      openCalibration();
      if (!res.found) calMsg("No se detectaron pantallas. Haz clic sobre la pantalla de cada sensor o arrastra un rectángulo alrededor (o acerca la cámara / mejora la luz).", "crit");
      else calMsg("Se detectaron " + res.found + " pantalla(s) (en amarillo); se asignaron " + res.assigned + ". Revisa las lecturas de cada sensor, usa «Intercambiar A ↔ B» si están al revés y pulsa «✓ Aceptar ubicación» en cada uno.", "good");
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
      const next = App.sensors.find((x) => x.enabled && x.id !== s.id && !x.calibration.accepted);
      if (next) {
        App.cal.sensorId = next.id;
        App.cal.draft = null;
        openCalibration();
        calMsg("✓ Ubicación de " + s.name + " aceptada. Ahora ubica el " + next.name + ": haz clic en su pantalla o arrastra un rectángulo alrededor.", "good");
      } else {
        renderCalFlow();
        calMsg("✓ Ubicación de " + s.name + " aceptada (" + new Date().toLocaleTimeString("es-CO") + ").", "good");
      }
    });
    // Calibrar con el ejemplo: lo que la persona ve en el sensor
    $("#exFit").addEventListener("click", async () => {
      const fr = App.cal.lastFrame, d = App.cal.draft, msg = $("#exMsg");
      if (!fr || !fr.gray) { msg.textContent = "No hay imagen de la cámara."; msg.className = "msg crit"; return; }
      const want = { tempIn: $("#exIn").value.trim().replace(",", "."), tempOut: $("#exOut").value.trim().replace(",", "."), humidity: $("#exHum").value.trim(), time: $("#exTime").value.trim().replace(/^0(\d:)/, "$1") };
      Object.keys(want).forEach((k) => { if (!want[k]) delete want[k]; });
      if (!Object.keys(want).length) { msg.textContent = "Escribe al menos un valor de los que muestra el sensor."; msg.className = "msg warn"; return; }
      msg.textContent = "Ajustando (unos segundos)…"; msg.className = "msg";
      await new Promise((r) => setTimeout(r, 30));
      const res = Seg.fitToExample(fr.gray, pxQuad(d.quad, fr.gray.w, fr.gray.h), d.fields, want, { lightSegments: d.lightSegments });
      d.fields = res.fields; d.slantDeg = res.slantDeg;
      $("#calSlant").value = res.slantDeg; $("#calSlantOut").textContent = res.slantDeg + "°";
      drawCalibration(false);
      const bad = Object.keys(res.result).filter((k) => !res.result[k].ok);
      if (!bad.length) { msg.textContent = "✓ Ahora lee exactamente lo que escribiste. Pulsa «✓ Aceptar ubicación»."; msg.className = "msg good"; }
      else { msg.textContent = "Casi: no logra leer " + bad.map((k) => L.FIELD_LABELS[k] + " (lee «" + (res.result[k].text || "nada") + "»)").join(", ") + ". Prueba encuadrar solo la pantalla del sensor, acercar la cámara o mejorar la luz."; msg.className = "msg warn"; }
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

    extensionSync();
    // Reanudar tras un reinicio de la app si el monitoreo estaba en curso.
    if (await App.store.getKV("running")) {
      toast("Reanudando el monitoreo que estaba en curso…");
      await setRunning(true);
    }
  }

  init();
})();


/* ===== termico-ui.js ===== */
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
