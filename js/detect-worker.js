/* Busca las pantallas en segundo plano: la búsqueda tarda varios segundos y no debe congelar la app. */
importScripts("segments.js");
self.onmessage = function (e) {
  var m = e.data;
  try {
    var found = self.MonSeg.detectHtc2({ w: m.w, h: m.h, d: m.d }, m.base, m.opts);
    self.postMessage({ ok: true, found: found });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};
