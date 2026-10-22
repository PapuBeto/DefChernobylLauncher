'use strict';

/* =========================================================
   CHERNOBYL Z — LAUNCHER
   Lógica del renderer: habla con el proceso principal por IPC.
   ========================================================= */

const api = window.launcher;

const state = {
  boot: null,
  config: null,
  modpack: null,
  news: [],
  links: {},
  launching: false,
  running: false,
  java: null,
  serverOnline: false,
  logBuffer: [],
};

const $ = (id) => document.getElementById(id);

const els = {
  body: document.body,
  playButton: $('playButton'),
  progress: $('progress'),
  percentage: $('percentage'),
  status: $('status'),

  versionButton: $('versionButton'),
  versionMenu: $('versionMenu'),
  versionArrow: $('versionArrow'),
  currentVersion: $('currentVersion'),

  profileButton: $('profileButton'),
  profileMenu: $('profileMenu'),
  profileName: $('profileName'),

  overlay: $('overlay'),
  modalClose: $('modalClose'),
  modalTitle: $('modalTitle'),
  modalDescription: $('modalDescription'),
  modalDate: $('modalDate'),
  modalTag: $('modalTag'),
  modalDot: $('modalDot'),

  newsList: $('newsList'),
  playerCount: $('playerCount'),
  serverLabel: $('serverLabel'),
  serverDot: $('serverDot'),

  brandVersion: $('brandVersion'),
  launcherVersion: $('launcherVersion'),
  buildLauncher: $('buildLauncher'),
  buildForge: $('buildForge'),
  buildMinecraft: $('buildMinecraft'),

  settingsOverlay: $('settingsOverlay'),
  settingsClose: $('settingsClose'),
  settingsCancel: $('settingsCancel'),
  settingsSave: $('settingsSave'),
  memoryRange: $('memoryRange'),
  memoryValue: $('memoryValue'),
  memoryHint: $('memoryHint'),
  resolutionSelect: $('resolutionSelect'),
  fullscreenToggle: $('fullscreenToggle'),
  javaPath: $('javaPath'),
  javaState: $('javaState'),
  javaDetectButton: $('javaDetectButton'),
  javaBrowseButton: $('javaBrowseButton'),
  gameDirPath: $('gameDirPath'),
  openGameFolder: $('openGameFolder'),
  closeOnLaunchToggle: $('closeOnLaunchToggle'),
  settingsNote: $('settingsNote'),

  profilesOverlay: $('profilesOverlay'),
  profilesClose: $('profilesClose'),
  profilesDone: $('profilesDone'),
  profileList: $('profileList'),
  newProfileName: $('newProfileName'),
  addProfileButton: $('addProfileButton'),
  profilesNote: $('profilesNote'),

  consoleOverlay: $('consoleOverlay'),
  consoleClose: $('consoleClose'),
  consoleDone: $('consoleDone'),
  consoleOutput: $('consoleOutput'),
  openLogsFolder: $('openLogsFolder'),

  toastStack: $('toastStack'),

  minimizeButton: $('minimizeButton'),
  maximizeButton: $('maximizeButton'),
  closeButton: $('closeButton'),

  openProfiles: $('openProfiles'),
  openSettings: $('openSettings'),
  openConsole: $('openConsole'),
  quitLauncher: $('quitLauncher'),
};

/* =========================================================
   UTILIDADES
   ========================================================= */

function toast(message, type = 'info', timeout = 4200) {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  els.toastStack.appendChild(node);

  setTimeout(() => {
    node.classList.add('hide');
    setTimeout(() => node.remove(), 200);
  }, timeout);
}

function openPanel(overlay) {
  overlay.classList.add('open');
}

function closePanel(overlay) {
  overlay.classList.remove('open');
}

function closeAllMenu() {
  els.versionMenu.classList.remove('open');
  els.versionArrow.classList.remove('open');
  els.profileMenu.classList.remove('open');
}

function formatPercent(value) {
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

function selectChannel(channelId) {
  const channel = state.modpack.channels[channelId];
  if (!channel) return;

  state.config.channel = channelId;
  els.currentVersion.textContent = channel.label;

  for (const option of els.versionMenu.querySelectorAll('.version-option')) {
    option.classList.toggle('active', option.dataset.channel === channelId);
  }

  updateMemoryHint();
  api.saveSettings({ channel: channelId }).catch(() => {});
}

/* =========================================================
   NOTICIAS
   ========================================================= */

function renderNews() {
  els.newsList.innerHTML = '';

  if (!state.news.length) {
    els.newsList.innerHTML = '<p class="news-empty">Todavía no hay novedades publicadas.</p>';
    return;
  }

  state.news.forEach((item, index) => {
    const article = document.createElement('article');
    article.className = `news-item changelog${item.featured || index === 0 ? ' featured' : ''}`;
    article.dataset.id = item.id;
    article.tabIndex = 0;

    if (item.featured || index === 0) {
      const image = document.createElement('div');
      image.className = 'news-image';
      article.appendChild(image);
    }

    const meta = document.createElement('div');
    meta.className = 'news-meta';

    const dot = document.createElement('span');
    dot.className = `news-dot${item.type === 'fix' ? ' fix' : item.type === 'server' ? ' server' : ''}`;

    const date = document.createElement('span');
    date.className = 'news-date';
    date.textContent = item.date || '';

    const tag = document.createElement('span');
    tag.className = 'news-tag';
    tag.textContent = item.tag || '';

    meta.append(dot, date, tag);

    const title = document.createElement('h2');
    title.className = 'news-title';
    title.textContent = item.featured || index === 0
      ? item.title
      : item.shortTitle || item.title;

    article.append(meta, title);

    const open = () => openChangelog(item);
    article.addEventListener('click', open);
    article.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });

    els.newsList.appendChild(article);
  });
}

function openChangelog(item) {
  els.modalTitle.textContent = item.title;
  els.modalDescription.textContent = item.description;
  els.modalDate.textContent = item.date || '';
  els.modalTag.textContent = item.tag || '';

  els.modalDot.className = 'modal-dot';
  if (item.type === 'fix') els.modalDot.classList.add('fix');
  if (item.type === 'server') els.modalDot.classList.add('server');

  els.overlay.classList.add('open');
}

/* =========================================================
   CANALES / VERSIONES
   ========================================================= */

function renderChannels() {
  els.versionMenu.innerHTML = '';

  for (const [id, channel] of Object.entries(state.modpack.channels)) {
    const option = document.createElement('div');
    option.className = 'version-option';
    option.dataset.channel = id;

    const name = document.createElement('span');
    name.className = 'option-name';
    name.textContent = channel.label || id;

    const description = document.createElement('span');
    description.className = 'option-description';
    description.textContent = channel.description || '';

    option.append(name, description);
    option.addEventListener('click', () => {
      selectChannel(id);
      closeAllMenu();
    });

    els.versionMenu.appendChild(option);
  }

  const active = state.modpack.channels[state.config.channel]
    ? state.config.channel
    : Object.keys(state.modpack.channels)[0];

  selectChannel(active);
  api.saveSettings({ channel: active }).catch(() => {});
}

function updateMemoryHint() {
  const channel = state.modpack.channels[state.config.channel] || {};
  const max = channel.memory?.max;

  els.memoryHint.textContent = max
    ? `Recomendado para el canal ${channel.label}: ${Math.round(max / 1024)} GB (${max} MB).`
    : 'Cada canal del modpack puede recomendar una cantidad distinta.';
}

/* =========================================================
   SERVIDOR
   ========================================================= */

function paintServer(status) {
  state.serverOnline = Boolean(status?.online);

  if (!status) {
    els.serverDot.className = 'server-dot pending';
    els.playerCount.textContent = '—';
    els.serverLabel.textContent = 'COMPROBANDO';
    return;
  }

  if (status.online) {
    els.serverDot.className = 'server-dot';
    els.playerCount.textContent = `${status.players.online}/${status.players.max}`;
    els.serverLabel.textContent = 'EN LÍNEA';

    const parts = [];
    if (status.latency) parts.push(`${status.latency} ms`);
    if (status.version) parts.push(status.version);
    if (status.motd) parts.push(status.motd.replace(/\s+/g, ' '));
    els.serverLabel.parentElement.title = parts.join(' · ');
  } else {
    els.serverDot.className = 'server-dot offline';
    els.playerCount.textContent = '0';
    els.serverLabel.textContent = 'OFFLINE';
    els.serverLabel.parentElement.title = 'No se pudo contactar con el servidor.';
  }
}

async function refreshServerStatus() {
  try {
    paintServer(await api.serverStatus());
  } catch {
    paintServer({ online: false, players: { online: 0, max: 0 } });
  }
}

/* =========================================================
   PERFILES
   ========================================================= */

function activeProfile() {
  return (
    state.config.profiles.find((profile) => profile.id === state.config.activeProfile) ||
    state.config.profiles[0]
  );
}

function renderProfile() {
  const profile = activeProfile();
  els.profileName.textContent = profile?.name || 'Superviviente';
}

function renderProfileList() {
  els.profileList.innerHTML = '';

  for (const profile of state.config.profiles) {
    const row = document.createElement('div');
    row.className = `profile-row${profile.id === state.config.activeProfile ? ' active' : ''}`;

    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = profile.name;

    const badge = document.createElement('span');
    badge.className = 'row-badge';
    badge.textContent = profile.id === state.config.activeProfile ? 'ACTIVO' : '';

    row.append(name, badge);

    if (state.config.profiles.length > 1) {
      const remove = document.createElement('button');
      remove.className = 'row-remove';
      remove.textContent = '×';
      remove.title = 'Eliminar perfil';
      remove.addEventListener('click', async (event) => {
        event.stopPropagation();
        try {
          state.config = await api.removeProfile(profile.id);
          renderProfile();
          renderProfileList();
          toast(`Perfil "${profile.name}" eliminado.`);
        } catch (error) {
          toast(error.message, 'error');
        }
      });
      row.appendChild(remove);
    }

    row.addEventListener('click', async () => {
      try {
        state.config = await api.selectProfile(profile.id);
        renderProfile();
        renderProfileList();
        els.profilesNote.textContent = `Perfil activo: ${profile.name}`;
      } catch (error) {
        toast(error.message, 'error');
      }
    });

    els.profileList.appendChild(row);
  }
}

async function addProfile() {
  const name = els.newProfileName.value.trim();
  if (!name) {
    toast('Escribe un nombre para el perfil.', 'error');
    return;
  }

  try {
    state.config = await api.addProfile(name);
    els.newProfileName.value = '';
    renderProfile();
    renderProfileList();
    toast(`Perfil "${activeProfile().name}" activado.`);
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* =========================================================
   AJUSTES
   ========================================================= */

function renderSettings() {
  const config = state.config;

  els.memoryRange.max = String(Math.min(12288, Math.max(4096, config.memory + 4096)));
  els.memoryRange.value = String(config.memory);
  els.memoryValue.textContent = `${config.memory} MB`;

  const resolution = `${config.resolution.width}x${config.resolution.height}`;
  if (![...els.resolutionSelect.options].some((option) => option.value === resolution)) {
    const option = document.createElement('option');
    option.value = resolution;
    option.textContent = `${config.resolution.width} × ${config.resolution.height}`;
    els.resolutionSelect.appendChild(option);
  }
  els.resolutionSelect.value = resolution;

  els.fullscreenToggle.checked = config.resolution.fullscreen;
  els.closeOnLaunchToggle.checked = config.closeOnLaunch;
  els.javaPath.value = config.javaPath || '';
  els.gameDirPath.value = state.boot.system.gameDir;

  updateMemoryHint();
  paintJava();
}

function paintJava() {
  if (state.java) {
    els.javaState.textContent = `Java ${state.java.raw}`;
    els.javaState.style.color = 'var(--green)';
  } else {
    els.javaState.textContent = 'No detectado (se descargará)';
    els.javaState.style.color = '#d96a4d';
  }
}

async function detectJava(explicitPath) {
  els.javaState.textContent = 'Detectando…';
  els.javaState.style.color = 'var(--muted)';
  try {
    state.java = await api.detectJava(explicitPath || null);
    paintJava();
    return state.java;
  } catch {
    state.java = null;
    paintJava();
    return null;
  }
}

async function saveSettings() {
  const [width, height] = els.resolutionSelect.value.split('x').map(Number);

  try {
    state.config = await api.saveSettings({
      memory: Number(els.memoryRange.value),
      resolution: {
        width,
        height,
        fullscreen: els.fullscreenToggle.checked,
      },
      closeOnLaunch: els.closeOnLaunchToggle.checked,
      javaPath: els.javaPath.value.trim() || null,
    });

    renderProfile();
    closePanel(els.settingsOverlay);
    toast('Ajustes guardados.');
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* =========================================================
   CONSOLA
   ========================================================= */

function appendLog(line) {
  state.logBuffer.push(line);
  if (state.logBuffer.length > 400) state.logBuffer.shift();

  if (els.consoleOverlay.classList.contains('open')) {
    renderConsole();
  }
}

function renderConsole() {
  els.consoleOutput.textContent = state.logBuffer.length
    ? state.logBuffer.join('\n')
    : 'Sin actividad todavía.';
  els.consoleOutput.scrollTop = els.consoleOutput.scrollHeight;
}

async function openConsole() {
  try {
    const logs = await api.logs();
    if (Array.isArray(logs) && logs.length) state.logBuffer = logs.slice(-400);
  } catch {
    /* sin logs */
  }
  renderConsole();
  openPanel(els.consoleOverlay);
}

/* =========================================================
   LANZAMIENTO
   ========================================================= */

function setLaunchState(mode) {
  const button = els.playButton;

  state.launching = mode === 'launching';
  state.running = mode === 'running';

  els.body.dataset.state = mode;

  button.classList.remove('is-busy', 'is-running');
  button.disabled = false;

  if (mode === 'launching') {
    button.textContent = 'CANCELAR';
    button.classList.add('is-busy');
    els.status.textContent = 'Preparando el juego...';
  } else if (mode === 'running') {
    button.textContent = 'JUGANDO';
    button.classList.add('is-running');
    button.disabled = true;
  } else {
    button.textContent = 'JUGAR';
    els.percentage.textContent = '—';
    els.progress.style.width = '0%';
    els.status.textContent = 'Listo para jugar';
  }
}

function setProgress(percent, detail) {
  const value = Math.min(1, Math.max(0, Number(percent) || 0));
  els.progress.style.width = `${value * 100}%`;
  els.percentage.textContent = value > 0 && value < 1 ? formatPercent(value) : value >= 1 ? '' : '—';
  if (detail) els.progress.title = detail;
}

async function startGame() {
  if (state.launching) {
    await api.cancel();
    return;
  }
  if (state.running) return;

  setLaunchState('launching');
  setProgress(0, null);

  try {
    await api.launch();
  } catch (error) {
    setLaunchState('idle');
    toast(error.message || 'No se pudo iniciar el juego.', 'error');
  }
}

/* =========================================================
   EVENTOS IPC
   ========================================================= */

function bindEvents() {
  api.onStatus(({ text, phase }) => {
    els.status.textContent = text;
    if (phase) els.body.dataset.state = phase;
  });

  api.onProgress(({ percent, detail }) => setProgress(percent, detail));

  api.onLog(({ line }) => appendLog(line));

  api.onReady(() => {
    setLaunchState('running');
    setProgress(1, 'Jugando');
    els.status.textContent = 'Jugando';
    els.body.dataset.state = 'running';

    if (state.config.closeOnLaunch) {
      setTimeout(() => api.hideWindow(), 1500);
    }
  });

  api.onExit(({ code, crashed, crashReportLocation }) => {
    setLaunchState('idle');

    if (crashed) {
      toast(
        `El juego se cerró con un error (código ${code}).${crashReportLocation ? ' Revisa la consola.' : ''}`,
        'error',
        8000,
      );
      els.body.dataset.state = 'error';
      els.status.textContent = 'El juego se cerró inesperadamente';
    } else {
      els.status.textContent = 'Listo para jugar';
    }
  });

  api.onError(({ message }) => {
    setLaunchState('idle');
    els.body.dataset.state = 'error';
    els.status.textContent = 'Error al iniciar el juego';
    toast(message || 'Error desconocido al iniciar el juego.', 'error', 9000);
  });

  api.onCancelled(() => {
    setLaunchState('idle');
    toast('Inicio cancelado.');
  });

  // Ventana
  els.minimizeButton.addEventListener('click', () => api.minimize());
  els.maximizeButton.addEventListener('click', () => api.toggleMaximize());
  els.closeButton.addEventListener('click', () => api.closeWindow());

  // Menús
  els.versionButton.addEventListener('click', (event) => {
    event.stopPropagation();
    const opened = els.versionMenu.classList.toggle('open');
    els.versionArrow.classList.toggle('open', opened);
    els.profileMenu.classList.remove('open');
  });

  els.profileButton.addEventListener('click', (event) => {
    event.stopPropagation();
    els.profileMenu.classList.toggle('open');
    els.versionMenu.classList.remove('open');
    els.versionArrow.classList.remove('open');
  });

  document.addEventListener('click', closeAllMenu);

  // Enlaces sociales
  document.querySelectorAll('[data-link]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const url = state.links[link.dataset.link];

      if (!url || !/^https?:\/\//i.test(url)) {
        toast(`Configura el enlace "${link.dataset.link}" en resources/links.json.`);
        return;
      }

      api.open(url);
    });
  });

  // Modal de noticias
  els.modalClose.addEventListener('click', () => els.overlay.classList.remove('open'));
  els.overlay.addEventListener('click', (event) => {
    if (event.target === els.overlay) els.overlay.classList.remove('open');
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;

    if (els.overlay.classList.contains('open')) els.overlay.classList.remove('open');
    else if (els.settingsOverlay.classList.contains('open')) closePanel(els.settingsOverlay);
    else if (els.profilesOverlay.classList.contains('open')) closePanel(els.profilesOverlay);
    else if (els.consoleOverlay.classList.contains('open')) closePanel(els.consoleOverlay);
    else closeAllMenu();
  });

  // Jugar
  els.playButton.addEventListener('click', startGame);

  // Ajustes
  els.openSettings.addEventListener('click', () => {
    closeAllMenu();
    renderSettings();
    openPanel(els.settingsOverlay);
  });

  els.settingsClose.addEventListener('click', () => closePanel(els.settingsOverlay));
  els.settingsCancel.addEventListener('click', () => closePanel(els.settingsOverlay));
  els.settingsSave.addEventListener('click', saveSettings);

  els.settingsOverlay.addEventListener('click', (event) => {
    if (event.target === els.settingsOverlay) closePanel(els.settingsOverlay);
  });

  els.memoryRange.addEventListener('input', () => {
    els.memoryValue.textContent = `${els.memoryRange.value} MB`;
  });

  els.javaDetectButton.addEventListener('click', async () => {
    const java = await detectJava(null);
    toast(java ? `Java ${java.raw} detectado.` : 'No se encontró Java 17 en el sistema.', java ? 'info' : 'error');
  });

  els.javaBrowseButton.addEventListener('click', async () => {
    const result = await api.pickJava();
    if (!result) return;

    if (!result.version || result.version.major < 17) {
      toast('Ese Java es anterior a la versión 17.', 'error');
      return;
    }

    els.javaPath.value = result.path;
    state.java = result.version;
    paintJava();
    toast(`Java ${result.version.raw} seleccionado.`);
  });

  els.openGameFolder.addEventListener('click', () => api.open('game'));

  // Perfiles
  els.openProfiles.addEventListener('click', () => {
    closeAllMenu();
    renderProfileList();
    els.profilesNote.textContent = '';
    openPanel(els.profilesOverlay);
  });

  els.profilesClose.addEventListener('click', () => closePanel(els.profilesOverlay));
  els.profilesDone.addEventListener('click', () => closePanel(els.profilesOverlay));
  els.addProfileButton.addEventListener('click', addProfile);
  els.newProfileName.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addProfile();
  });

  els.profilesOverlay.addEventListener('click', (event) => {
    if (event.target === els.profilesOverlay) closePanel(els.profilesOverlay);
  });

  // Consola
  els.openConsole.addEventListener('click', () => {
    closeAllMenu();
    openConsole();
  });

  els.consoleClose.addEventListener('click', () => closePanel(els.consoleOverlay));
  els.consoleDone.addEventListener('click', () => closePanel(els.consoleOverlay));
  els.openLogsFolder.addEventListener('click', () => api.open('logs'));

  els.consoleOverlay.addEventListener('click', (event) => {
    if (event.target === els.consoleOverlay) closePanel(els.consoleOverlay);
  });

  // Salir
  els.quitLauncher.addEventListener('click', () => api.closeWindow());
}

/* =========================================================
   ARRANQUE
   ========================================================= */

async function init() {
  try {
    const boot = await api.bootstrap();
    state.boot = boot;
    state.config = boot.config;
    state.modpack = boot.modpack;
    state.news = boot.news || [];
    state.links = boot.links || {};

    els.brandVersion.textContent = boot.launcherVersion;
    els.launcherVersion.textContent = `LAUNCHER ${boot.launcherVersion}`;
    els.buildLauncher.textContent = `v${boot.launcherVersion}`;
    els.buildForge.textContent = `Forge ${boot.modpack.forge}`;
    els.buildMinecraft.textContent = `MC ${boot.modpack.minecraft}`;
    els.gameDirPath.value = boot.system.gameDir;

    renderProfile();
    renderNews();
    renderChannels();
    renderSettings();

    setLaunchState('idle');
    setProgress(0, null);

    refreshServerStatus();
    setInterval(refreshServerStatus, 60000);

    detectJava(null);
  } catch (error) {
    toast(`No se pudo iniciar el launcher: ${error.message}`, 'error', 12000);
  }

  bindEvents();
}

document.addEventListener('DOMContentLoaded', init);
