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
