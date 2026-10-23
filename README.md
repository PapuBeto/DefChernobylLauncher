# ☢ Chernobyl Z — Launcher

Launcher de escritorio para el servidor de zombies **Chernobyl Z** (Minecraft **1.20.1 + Forge**).
Interfaz oscura con estética post-apocalíptica, cuentas premium y no premium, sincronización de mods y
lanzamiento automático al servidor.

![Estado](https://img.shields.io/badge/estado-desarrollo-9cff42) ![Electron](https://img.shields.io/badge/Electron-33-9cff42) ![MC](https://img.shields.io/badge/Minecraft-1.20.1-9cff42)

---

## ¿Qué hace?

- **Instala todo solo**: Minecraft 1.20.1, Forge y los mods del modpack (con verificación SHA-1).
- **Java automático**: detecta Java 17+ en el sistema; si no existe, descarga Eclipse Temurin.
- **Perfiles offline**: varios nombres de jugador, sin cuenta premium.
- **Canales de modpack**: `COMPLETA`, `LITE` y `FPS` con distinto conjunto de mods.
- **Estado real del servidor**: ping al servidor (jugadores en línea, latencia, MOTD).
- **Fondo reactivo**: halo verde que sigue al ratón, con esporas flotando. Se puede
  desactivar en **Ajustes → Fondo reactivo**.
- **Panel de skins** (solo premium): sube un PNG y cámbiala al instante en tu cuenta de
  Minecraft, con vista previa del cuerpo y modelo clásico o slim.
- **Panel de mods**: lista los mods del canal activo con su descripción, versión, autor y
  estado de descarga.
- **Noticias dinámicas** desde `resources/news.json`. Si está vacío, el panel de noticias
  se oculta y la portada ocupa todo el ancho.
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

### En VS Code

Abre la carpeta del proyecto y pulsa **F5** (o *Ejecutar → Iniciar depuración*). Ya hay
configuración lista en `.vscode/`:

| Acción | Cómo |
|---|---|
| Arrancar el launcher | **F5** → `Launcher (F5)` |
| Arrancar + DevTools | F5 → `Launcher + DevTools` (`--dev`) |
| Poner breakpoints | En `src/main/*.js` (proceso principal) |
| Depurar la interfaz | DevTools → pestaña *Sources* |
| Instalar el juego sin UI | F5 → `Prueba: instalar Minecraft + Forge` |
| Compilar el instalador | **Ctrl+Shift+B** o `Terminal → Run Build Task` |

Equivalencias si vienes de .NET:

| .NET | Aquí |
|---|---|
| `dotnet run` | `npm start` / **F5** |
| `dotnet build` | no aplica: el código se ejecuta tal cual |
| `dotnet publish` | `npm run dist` (instalador NSIS en `dist/`) |
| `dotnet test` | `scripts/test-install.js` y `test-launch.js` |
| `bin/` | `dist/` (ignorado por git) |

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
  ],
  "mods": [
    {
      "id": "example-mod",
      "name": "Example Mod",
      "version": "1.2.0",
      "author": "Autor",
      "description": "Qué hace este mod, en una o dos frases.",
      "channels": ["COMPLETA", "LITE"],
      "file": "mods/example-mod.jar"
    }
  ]
}
```

- `path`: ruta **relativa** a `game/`. Se ignoran rutas que salgan de esa carpeta.
- `url`: descarga directa del archivo.
- `sha1` / `size`: opcionales pero muy recomendados (si el hash no coincide, se vuelve a descargar).
- `channels`: si se omite, el archivo aplica a todos los canales.
- Los archivos gestionados que dejan de aparecer en el manifiesto **se eliminan** en la siguiente sincronización.

### Panel de mods

`mods` es la información que se muestra en el panel **Mods del modpack** (menú de perfil):

| Campo | Descripción |
|---|---|
| `name` | Nombre visible del mod. |
| `version` / `author` | Opcionales; se muestran junto al nombre. |
| `description` | Explicación breve de qué añade el mod. |
| `channels` | Canales donde aparece. Si se omite, aparece en todos. |
| `file` | Ruta del `.jar` dentro de `files` (misma cadena que `path`). Sirve para mostrar el tamaño y el estado «INSTALADO» / «SE DESCARGA». |

Si `mods` no existe (o está vacío), el panel deriva los mods de los `.jar` de `files`.
En cuanto añadas las entradas con descripción, se verán tal cual en el launcher sin
tocar código.

### Generar entradas del manifiesto

```bash
node scripts/generate-manifest.js "C:\ruta\a\mods" "https://tu-cdn.com/mods" COMPLETA
```

Imprime los objetos JSON listos para pegar en `files`.

---

## Noticias y enlaces

- **`resources/news.json`** → tarjetas del panel izquierdo y modal de detalle. Viene vacío
  por defecto: mientras no haya `items`, el panel no se muestra. Cada noticia admite
  `id`, `type` (`update`/`fix`/`server`), `date`, `tag`, `title`, `shortTitle`,
  `description` y `featured`.
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

> **Windows sin permisos de administrador:** electron-builder necesita crear enlaces
> simbólicos al preparar sus herramientas. Si el build falla con *"Cannot create symbolic
> link"*, activa el **Modo para desarrolladores** (Ajustes → Sistema → Para desarrolladores)
> o compila desde GitHub Actions. Para probar el empaquetado sin editar el `.exe`:
>
> ```bash
> npx electron-builder --dir -c.win.signAndEditExecutable=false
> ```

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
│   ├── updater.js        # auto-actualización (electron-updater)
│   ├── skins.js          # descarga y caché de skins
│   ├── skin-service.js   # subida/restauración de skin en Mojang
│   ├── mods-info.js      # metadatos de mods para el panel
│   ├── auth/             # cuentas
│   │   ├── index.js      # sesión por perfil + login Microsoft
│   │   ├── microsoft.js  # device code → Xbox → Minecraft
│   │   ├── accounts.js   # refresh tokens cifrados (DPAPI)
│   │   └── offline.js    # perfil offline (UUID v3)
│   └── server-status.js  # Server List Ping
└── renderer/             # interfaz (HTML/CSS/JS sin frameworks)
    ├── index.html
    ├── css/theme.css     # diseño original
    ├── css/launcher.css  # ventana, paneles, ajustes
    └── js/app.js
resources/
├── modpack.json
├── news.json
├── links.json
└── auth.json            # clientId de la app de Azure
scripts/
├── generate-icon.js
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

Para probar el primer arranque (pantalla de elección de cuenta) sin tocar tus datos:

```bash
node_modules\electron\dist\electron.exe . --user-data %TEMP%\cz-perfil-limpio
```

### Seguridad

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- El renderer solo puede ejecutar las acciones expuestas en `preload.js`.
- Las URL externas se abren con `shell.openExternal` y solo se aceptan `http(s)`.

---

## Cuentas: premium y offline

El launcher soporta las dos a la vez (estilo Prism / TLauncher). **No hay cuenta por
defecto**: en el primer arranque se abre la pantalla de cuentas y cada jugador elige.

| Cuenta | Cómo entra | UUID | Avatar |
|---|---|---|---|
| **Premium (Microsoft)** | Inicia sesión con la cuenta; token real | El de tu cuenta | Su skin real |
| **No premium (offline)** | Solo un nick | `MD5("OfflinePlayer:<nick>")` | Avatar genérico |

- **Perfiles → Iniciar sesión con Microsoft**: se abre `microsoft.com/link` con un código de
  8 caracteres. El refresh token se guarda cifrado con DPAPI (`safeStorage`) en
  `%APPDATA%\Chernobyl Z\accounts.json` y la textura de la skin en `cache/skins/`.
- La cabeza de la skin se dibuja en la cabecera y en la lista de cuentas; las cuentas no
  premium mantienen el avatar por defecto.
- Se pueden tener varias cuentas (premium y no premium) y cambiar con un clic.
- `online-mode=true` en el servidor **solo** acepta cuentas Microsoft.
- `online-mode=false` acepta ambas.

### Cambiar de skin (solo premium)

**Menú de perfil → Cambiar skin** abre el panel de skins:

1. **Elegir PNG…** valida que sea un PNG de 64×64 (o 64×32) y muestra una vista previa
   del cuerpo antes de subirlo.
2. Selecciona el modelo: **Clásica** (Steve) o **Slim** (Alex).
3. **Aplicar skin** la sube a Mojang con el token de Minecraft de la cuenta. El cambio se
   ve al instante en el juego y en el launcher.
4. **Restaurar** vuelve a la skin predeterminada de la cuenta.

Las cuentas no premium ven un aviso de «solo premium» y un acceso directo a **Cuentas**,
porque Mojang solo permite cambiar la skin de cuentas con licencia.

### Servidor mixto (premium + no premium)

`server.properties`:

```properties
online-mode=false
```

más un plugin que detecte cuentas premium al entrar:

- **nLogin**: detección premium integrada; los premium entran solos y el resto usa `/login`.
- **AuthMe + FastLogin**: FastLogin comprueba si el nick es premium y AuthMe pide contraseña
  a los demás.

Resultado: los premium entran sin contraseña, los no premium con `/register` y `/login`.
La comprobación premium la hace el plugin **por nombre** contra Mojang: es razonable, pero
no equivale criptográficamente a `online-mode=true`.

> El `clientId` de Azure vive en `resources/auth.json`. Es público y puede cambiarse sin
> recompilar (basta editar el JSON).

## Actualizaciones automáticas

`electron-updater` + GitHub Releases, con descarga **diferencial** (blockmap): no se
reinstala todo ni se pierden mods, mundos o ajustes.

- En la versión instalada comprueba al arrancar (8 s) y cada 30 min.
- Al haber versión nueva aparece una barra inferior con el progreso y el botón
  **Reiniciar e instalar**; también se puede forzar desde **Ajustes → Launcher → Buscar**.
- El auto-actualizador necesita que el repositorio (o el de releases) sea **público**:
  GitHub no entrega assets privados sin token.

Publicar una versión:

```bash
npm version 1.0.1 --no-git-tag-version
git commit -am "chore: version 1.0.1"
git tag v1.0.1
git push origin main --tags
```

El workflow compila con `--publish onTag` y sube al release
`ChernobylZ-Setup-<version>.exe`, su `.blockmap` y `latest.yml`.

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

- [x] Autenticación Microsoft (cuentas premium) además de offline.
- [x] Auto-actualización del launcher (electron-updater + GitHub Releases).
- [ ] Barra de progreso con velocidad y tamaño descargado.
- [ ] Selector de idioma.
- [ ] Firma de código del ejecutable.
