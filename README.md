# ☢ Chernobyl Z — Launcher

Launcher de escritorio para el servidor de zombies **Chernobyl Z** (Minecraft **1.20.1 + Forge**).
Interfaz oscura con estética post-apocalíptica, perfiles offline, sincronización de mods y
lanzamiento automático al servidor.

![Estado](https://img.shields.io/badge/estado-desarrollo-9cff42) ![Electron](https://img.shields.io/badge/Electron-33-9cff42) ![MC](https://img.shields.io/badge/Minecraft-1.20.1-9cff42)

---

## ¿Qué hace?

- **Instala todo solo**: Minecraft 1.20.1, Forge y los mods del modpack (con verificación SHA-1).
- **Java automático**: detecta Java 17+ en el sistema; si no existe, descarga Eclipse Temurin.
- **Perfiles offline**: varios nombres de jugador, sin cuenta premium.
- **Canales de modpack**: `COMPLETA`, `LITE` y `FPS` con distinto conjunto de mods.
- **Estado real del servidor**: ping al servidor (jugadores en línea, latencia, MOTD).
- **Noticias dinámicas** desde `resources/news.json`.
- **Consola integrada** para diagnosticar problemas y reportes de crash.
- Conexión directa al servidor al pulsar **JUGAR**.

---

## Requisitos (desarrollo)

| Herramienta | Versión |
|---|---|
| Node.js | 20 o superior |
| Java | 17 o superior (para instalar Forge) |
| Git | cualquiera reciente |

> En Windows, si `npm` da error de *execution policy*, usa `npm.cmd`.

## Empezar

```bash
npm install
npm start        # abre el launcher
npm run dev      # igual, con DevTools
```

Datos en tiempo de ejecución (Windows): `%APPDATA%\Chernobyl Z\`

```
Chernobyl Z/
├── config.json      # ajustes y perfiles
├── state.json       # archivos gestionados + instancia instalada
├── game/            # .minecraft (mods, configs, saves...)
├── java/            # JRE descargado (si hizo falta)
├── logs/            # launcher.log
└── cache/           # descargas temporales
```

---

## Configurar el modpack

Todo se define en **`resources/modpack.json`**:

```jsonc
{
  "name": "Chernobyl Z",
  "minecraft": "1.20.1",
  "forge": "47.3.0",
  "server": { "name": "Chernobyl Z", "host": "play.chernobylz.net", "port": 25565 },
  "channels": {
    "COMPLETA": { "label": "COMPLETA", "description": "Todos los mods", "memory": { "min": 2048, "max": 6144 } }
  },
  "files": [
    {
      "path": "mods/example-mod.jar",
      "url": "https://tu-cdn.com/mods/example-mod.jar",
      "sha1": "0123456789abcdef0123456789abcdef01234567",
      "size": 1234567,
      "channels": ["COMPLETA", "LITE"]
    }
  ]
}
```

- `path`: ruta **relativa** a `game/`. Se ignoran rutas que salgan de esa carpeta.
- `url`: descarga directa del archivo.
- `sha1` / `size`: opcionales pero muy recomendados (si el hash no coincide, se vuelve a descargar).
- `channels`: si se omite, el archivo aplica a todos los canales.
- Los archivos gestionados que dejan de aparecer en el manifiesto **se eliminan** en la siguiente sincronización.

### Generar entradas del manifiesto

```bash
node scripts/generate-manifest.js "C:\ruta\a\mods" "https://tu-cdn.com/mods" COMPLETA
```

Imprime los objetos JSON listos para pegar en `files`.

---

## Noticias y enlaces

- **`resources/news.json`** → tarjetas del panel izquierdo y modal de detalle.
- **`resources/links.json`** → Discord, tienda, YouTube, TikTok, Instagram.
  Deja una cadena vacía para desactivar el aviso (muestra un toast recordatorio).

---

## Build / distribución

```bash
npm run pack     # carpeta desempaquetada en dist/
npm run dist     # instalador NSIS en dist/
npm run icon     # regenera build/icon.png + build/icon.ico
```

El icono se genera por código (`scripts/generate-icon.js`). Puedes sustituir
`build/icon.png` e `build/icon.ico` por tu propio arte (256×256) cuando lo tengas.

---

## Estructura del proyecto

```
src/
├── main/                 # proceso principal (Node)
│   ├── main.js           # ventana, IPC, ciclo de vida
│   ├── preload.js        # API segura expuesta al renderer
│   ├── config.js         # ajustes y perfiles
│   ├── paths.js          # rutas de userData
│   ├── resources.js      # lectura de modpack/noticias/enlaces
│   ├── java.js           # detección y descarga de Java 17
│   ├── game.js           # instalación de Forge y lanzamiento
│   ├── mods.js           # sincronización del modpack
│   ├── auth.js           # perfil offline (UUID v3)
│   └── server-status.js  # Server List Ping
└── renderer/             # interfaz (HTML/CSS/JS sin frameworks)
    ├── index.html
    ├── css/theme.css     # diseño original
    ├── css/launcher.css  # ventana, paneles, ajustes
    └── js/app.js
resources/
├── modpack.json
├── news.json
└── links.json
scripts/
├── generate-manifest.js
├── test-install.js
└── test-launch.js
```

### Pruebas

```bash
node_modules\electron\dist\electron.exe scripts\test-install.js
node_modules\electron\dist\electron.exe scripts\test-launch.js
```

- `test-install.js` instala Minecraft + Forge en `%TEMP%\cz-install-test` y sincroniza el modpack.
- `test-launch.js` abre el juego, espera 15 s y lo cierra para comprobar que arranca.

El botón **CANCELAR** aborta de verdad: corta la descarga en curso, cancela la tarea de
instalación y termina el proceso del juego si ya estaba abierto.

### Seguridad

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- El renderer solo puede ejecutar las acciones expuestas en `preload.js`.
- Las URL externas se abren con `shell.openExternal` y solo se aceptan `http(s)`.

---

## Solución de problemas

| Problema | Solución |
|---|---|
| «No se encontró Minecraft 1.20.1» | Sin conexión o Mojang caído. Revisa la consola. |
| Forge falla al instalar | Necesita Java 17 en el PATH; el launcher lo añade solo. |
| Crash al entrar | Abre **Consola** (menú de perfil) y revisa `game/crash-reports`. |
| Servidor OFFLINE | Revisa `server.host` / `server.port` en `resources/modpack.json`. |
| Mods no aparecen | Comprueba `channels`, `sha1` y que la URL sea accesible. |

---

## Próximos pasos

- [ ] Autenticación Microsoft (cuentas premium) además de offline.
- [ ] Auto-actualización del launcher (electron-updater + GitHub Releases).
- [ ] Barra de progreso con velocidad y tamaño descargado.
- [ ] Selector de idioma.
- [ ] Firma de código del ejecutable.
