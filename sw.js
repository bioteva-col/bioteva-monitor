/* Service worker de BioTeva Monitor: guarda la app en caché para abrirla sin
   internet (y sin el servidor local) una vez instalada. Los datos no pasan por
   aquí: viven en IndexedDB. Cambia VERSION al publicar archivos nuevos. */
const VERSION = "bioteva-monitor-v5";
const ASSETS = [
  "./",
  "index.html",
  "monitor.css",
  "manifest.webmanifest",
  "js/monitor.bundle.js",
  "js/ticker.js",
  "icons/icon-32.png",
  "icons/icon-128.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

// Red primero (para recibir actualizaciones); si no hay red o servidor, caché.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      // Sin red: la copia guardada de ESE archivo. Solo una navegación de página puede
      // caer en index.html (nunca devolver HTML a una petición de script o estilo).
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error()))),
  );
});
