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
    var minScore = opts.minScore == null ? 0.5 : opts.minScore;
    var diag = Math.hypot(frame.w, frame.h), taken = [], out = {}, globalProps = null;
    var fitNear = function (pt, q) {
      var w = q ? Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) : frame.w * 0.1;
      return fitLcdAt(frame, pt, w);
    };
    sensors.forEach(function (s) {
      var app = s.tpl && s.tpl.app;
      if (!app) { out[s.id] = { quad: null, score: 0, how: "sin plantilla" }; return; }
      var best = null;
      var consider = function (q, how) {
        if (!q) return;
        var c = quadCenter(q);
        if (taken.some(function (t) { return pointInQuad(t, c); })) return; // ya es de otro sensor
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
      });
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
      var disp = renderDisplay(size.w, size.h, s.values, s.fields, { slantDeg: s.slantDeg, blank: s.blank, noise: opts.noise, seed: (opts.seed || 7) + idx * 101, bg: s.lcdBg, ink: s.lcdInk });
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
