# BioTeva Monitor

Monitoreo ambiental por cámara (termohigrómetros HTC-2, lectura de 7 segmentos en el navegador) y control térmico de cajas de grillos (*Acheta domesticus*).

- **Abrir la app:** https://bioteva-col.github.io/bioteva-monitor/
- **Paquete portátil para Windows** (extraer y doble clic en `INSTALAR BioTeva Monitor.cmd`: queda arrancando sola al encender el equipo): [download/BioTeva-Monitor-Portable.zip](download/BioTeva-Monitor-Portable.zip)
- **Extensión de Chrome:** [download/bioteva-monitor-extension.zip](download/bioteva-monitor-extension.zip)

## Instalar la extensión de Chrome

Chrome **no** instala extensiones desde un `.zip`.

- **Con el paquete portátil:** doble clic en `Instalar extension de Chrome.cmd`. Copia la extensión a una carpeta fija y abre `chrome://extensions`.
- **A mano:**
  1. Extrae el `.zip` en una carpeta que no vayas a borrar.
  2. Abre `chrome://extensions` y activa **Modo de desarrollador**.
  3. Pulsa **Cargar descomprimida** y elige la carpeta que contiene `manifest.json`.

Las instrucciones completas están en `INSTALAR.txt`, dentro del zip.

La extensión tiene un ID fijo. Si Chrome se cierra con el monitoreo en curso, la reabre al iniciarse. La pestaña no se descarta por ahorro de memoria, y si la cámara se cae, la app reintenta cada 30 s.

Todo se procesa en el navegador. El video no sale del computador y las lecturas se guardan en el propio equipo. Para controlar las lámparas TP-Link HS105 hace falta el gateway local, que viene en el paquete portátil.

Este repositorio solo contiene la app publicada; se genera desde el proyecto privado de BioTeva.
