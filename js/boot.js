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
