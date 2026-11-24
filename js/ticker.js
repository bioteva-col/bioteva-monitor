// Reloj del ciclo de lectura en un Worker: Chrome limita mucho los temporizadores
// de las pestañas en segundo plano (hasta 1 por minuto), pero no los de los Workers.
// - Cada segundo manda la hora (tick del monitoreo).
// - Además atiende esperas cortas del ciclo ({ sleep: id, ms }): así tomar las 5 fotos
//   no tarda minutos cuando la ventana está detrás de otra o la pantalla apagada.
setInterval(function () { postMessage(Date.now()); }, 1000);
onmessage = function (e) {
  var d = e.data || {};
  if (d.sleep != null) setTimeout(function () { postMessage({ wake: d.sleep }); }, Math.max(0, Number(d.ms) || 0));
};
