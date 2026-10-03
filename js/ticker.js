// Reloj del ciclo de lectura en un Worker: Chrome limita mucho los temporizadores
// de las pestañas en segundo plano, pero no los de los Workers.
setInterval(function () { postMessage(Date.now()); }, 1000);
