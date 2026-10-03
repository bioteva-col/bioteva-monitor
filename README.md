# BioTeva Monitor

Monitoreo ambiental por cámara (termohigrómetros HTC-2, lectura de 7 segmentos en el navegador) y control térmico de cajas de grillos (*Acheta domesticus*).

- **Abrir la app:** https://bioteva-col.github.io/bioteva-monitor/
- **Paquete portátil para Windows** (app + gateway térmico + extensión de Chrome): [download/BioTeva-Monitor-Portable.zip](download/BioTeva-Monitor-Portable.zip)
- **Extensión de Chrome:** [download/bioteva-monitor-extension.zip](download/bioteva-monitor-extension.zip)

Todo se procesa en el navegador: el video no sale del computador y las lecturas se guardan en IndexedDB del propio equipo. El control de lámparas (TP-Link HS105) necesita el gateway local (`node gateway/heater-gateway.mjs`, en el paquete portátil).

Este repositorio solo contiene la app publicada; se genera desde el proyecto privado de BioTeva.
