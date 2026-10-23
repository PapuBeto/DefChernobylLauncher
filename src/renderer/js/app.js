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
  auth: {},
  skins: {},
  skinPending: new Set(),
  effects: true,
  update: null,
  signingIn: false,
  manualUpdateCheck: false,
};

const $ = (id) => document.getElementById(id);

const els = {
  body: document.body,
  main: document.querySelector('main'),
  bgFx: $('bgFx'),
  bgSpores: $('bgSpores'),
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
  effectsToggle: $('effectsToggle'),
  settingsNote: $('settingsNote'),

  profilesOverlay: $('profilesOverlay'),
  profilesClose: $('profilesClose'),
  profilesDone: $('profilesDone'),
  profileList: $('profileList'),
  newProfileName: $('newProfileName'),
  addProfileButton: $('addProfileButton'),
  profilesNote: $('profilesNote'),
  profilesIntro: $('profilesIntro'),
  listHead: $('listHead'),

  avatarDefault: $('avatarDefault'),
  avatarCanvas: $('avatarCanvas'),
  accountUser: $('accountUser'),
  accountSkin: $('accountSkin'),
  accountName: $('accountName'),

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

  accountFlag: $('accountFlag'),
  accountHint: $('accountHint'),
  msLoginButton: $('msLoginButton'),
  deviceBox: $('deviceBox'),
  deviceCode: $('deviceCode'),
  deviceLink: $('deviceLink'),
  deviceCopy: $('deviceCopy'),
  deviceCancel: $('deviceCancel'),

  updateBar: $('updateBar'),
  updateText: $('updateText'),
  updateFill: $('updateFill'),
  updateAction: $('updateAction'),
  updateVersion: $('updateVersion'),
  updateState: $('updateState'),
  updateCheckButton: $('updateCheckButton'),
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

const cleanError = (error) =>
  String(error?.message || error || '')
    .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
    .trim();

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

  const hasNews = state.news.length > 0;
  els.main.classList.toggle('no-news', !hasNews);

  if (!hasNews) {
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
   FONDO REACTIVO
   ========================================================= */

const glow = {
  ready: false,
  active: false,
  raf: null,
  x: 0,
  y: 0,
  tx: 0,
  ty: 0,
  x2: 0,
  y2: 0,
};

function paintGlow() {
  glow.raf = null;

  glow.x += (glow.tx - glow.x) * 0.12;
  glow.y += (glow.ty - glow.y) * 0.12;
  glow.x2 += (glow.tx - glow.x2) * 0.045;
  glow.y2 += (glow.ty - glow.y2) * 0.045;

  els.bgFx.style.setProperty('--mx', `${glow.x}px`);
  els.bgFx.style.setProperty('--my', `${glow.y}px`);
  els.bgFx.style.setProperty('--mx2', `${glow.x2}px`);
  els.bgFx.style.setProperty('--my2', `${glow.y2}px`);

  if (Math.abs(glow.tx - glow.x) > 0.4 || Math.abs(glow.ty - glow.y) > 0.4) {
    glow.raf = requestAnimationFrame(paintGlow);
  }
}

function startGlow() {
  if (!glow.active || glow.raf) return;
  glow.raf = requestAnimationFrame(paintGlow);
}

function centerGlow() {
  glow.tx = window.innerWidth * 0.6;
  glow.ty = window.innerHeight * 0.42;
  startGlow();
}

function initGlow() {
  if (glow.ready) return;
  glow.ready = true;

  for (let index = 0; index < 18; index += 1) {
    const spore = document.createElement('span');
    spore.className = 'bg-spore';
    spore.style.left = `${Math.random() * 100}%`;
    spore.style.setProperty('--size', `${1 + Math.random() * 2.4}px`);
    spore.style.setProperty('--dur', `${12 + Math.random() * 12}s`);
    spore.style.setProperty('--delay', `${-Math.random() * 18}s`);
    spore.style.setProperty('--sway', `${(Math.random() - 0.5) * 90}px`);
    els.bgSpores.appendChild(spore);
  }

  glow.x = glow.x2 = glow.tx = window.innerWidth * 0.62;
  glow.y = glow.y2 = glow.ty = window.innerHeight * 0.4;
  paintGlow();

  window.addEventListener('pointermove', (event) => {
    glow.tx = event.clientX;
    glow.ty = event.clientY;
    startGlow();
  }, { passive: true });

  window.addEventListener('pointerleave', centerGlow);
  window.addEventListener('blur', centerGlow);
}

function applyEffects(enabled) {
  state.effects = Boolean(enabled);
  document.body.classList.toggle('no-effects', !state.effects);

  if (!state.effects) {
    glow.active = false;
    if (glow.raf) cancelAnimationFrame(glow.raf);
    glow.raf = null;
    return;
  }

  initGlow();
  glow.active = true;
  startGlow();
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
    state.config.profiles[0] ||
    null
  );
}

/* ---------- Skins ---------- */

function drawHead(canvas, dataUrl) {
  if (!canvas || !dataUrl) return;

  const image = new Image();
  image.onload = () => {
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, canvas.width, canvas.height);

    // Cara en (8,8) de la textura.
    context.drawImage(image, 8, 8, 8, 8, 0, 0, canvas.width, canvas.height);

    // La capa de sombrero solo existe en skins modernas (64x64). En las
    // antiguas (64x32) esa zona está vacía y suele venir pintada de negro.
    if (image.naturalHeight >= 64) {
      context.drawImage(image, 40, 8, 8, 8, 0, 0, canvas.width, canvas.height);
    }
  };
  image.src = dataUrl;
}

function paintSkins() {
  for (const canvas of document.querySelectorAll('canvas[data-skin-id]')) {
    const dataUrl = state.skins[canvas.dataset.skinId];
    if (dataUrl) drawHead(canvas, dataUrl);
  }

  const profile = activeProfile();
  const skin = profile ? state.skins[profile.id] : null;

  if (profile?.type === 'microsoft' && skin) {
    drawHead(els.avatarCanvas, skin);
    els.avatarCanvas.hidden = false;
    els.avatarDefault.hidden = true;
  } else {
    els.avatarCanvas.hidden = true;
    els.avatarDefault.hidden = false;
  }
}

async function ensureSkin(profile) {
  if (!profile || profile.type !== 'microsoft') return;
  const id = profile.id;
  if (state.skins[id] || state.skinPending.has(id)) return;

  state.skinPending.add(id);
  try {
    const dataUrl = await api.profileSkin(id);
    if (dataUrl) {
      state.skins[id] = dataUrl;
      paintSkins();
      if (activeMicrosoft()?.id === id) drawHead(els.accountSkin, dataUrl);
    }
  } catch {
    // Sin skin: se mantiene el avatar por defecto.
  } finally {
    state.skinPending.delete(id);
  }
}

/* ---------- Perfiles ---------- */

function renderProfile() {
  const profile = activeProfile();
  els.profileName.textContent = profile?.name || 'Sin cuenta';

  const label = els.profileButton.querySelector('.profile-label');
  if (label) {
    label.textContent = !profile
      ? 'ELEGIR CUENTA ▾'
      : profile.type === 'microsoft'
        ? 'PREMIUM ▾'
        : 'NO PREMIUM ▾';
  }

  els.profileButton.classList.toggle('no-account', !profile);

  if (profile) ensureSkin(profile);
  paintSkins();
}

function renderProfileList() {
  els.profileList.innerHTML = '';

  const empty = state.config.profiles.length === 0;
  els.profilesIntro.hidden = !empty;
  els.listHead.hidden = empty;

  for (const profile of state.config.profiles) {
    const row = document.createElement('div');
    row.className = `profile-row${profile.id === state.config.activeProfile ? ' active' : ''}`;

    if (profile.type === 'microsoft') {
      const skin = document.createElement('canvas');
      skin.className = 'row-skin';
      skin.width = 64;
      skin.height = 64;
      skin.dataset.skinId = profile.id;
      row.appendChild(skin);
    }

    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = profile.name;

    const type = document.createElement('span');
    type.className = 'row-type';

    if (profile.type === 'microsoft') {
      const connected = state.auth[profile.id] !== false;
      type.textContent = connected ? 'PREMIUM' : 'PREMIUM · SIN SESIÓN';
      type.classList.toggle('ms', connected);
    } else {
      type.textContent = 'NO PREMIUM';
    }

    const badge = document.createElement('span');
    badge.className = 'row-badge';
    badge.textContent = profile.id === state.config.activeProfile ? 'ACTIVO' : '';

    row.append(name, type, badge);

    const remove = document.createElement('button');
    remove.className = 'row-remove';
    remove.textContent = '×';
    remove.title =
      profile.type === 'microsoft' ? 'Quitar cuenta Microsoft' : 'Eliminar cuenta no premium';
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      try {
        const result = await api.removeProfile(profile.id);
        state.config = result.config;
        state.auth = result.auth || {};
        delete state.skins[profile.id];
        renderProfile();
        renderProfileList();
        renderAccount();
        toast(`Cuenta "${profile.name}" eliminada.`);
      } catch (error) {
        toast(cleanError(error), 'error');
      }
    });
    row.appendChild(remove);

    row.addEventListener('click', async () => {
      try {
        state.config = await api.selectProfile(profile.id);
        renderProfile();
        renderProfileList();
        renderAccount();
        els.profilesNote.textContent = `Cuenta activa: ${profile.name}`;
      } catch (error) {
        toast(cleanError(error), 'error');
      }
    });

    els.profileList.appendChild(row);
  }

  paintSkins();
  for (const profile of state.config.profiles) ensureSkin(profile);
}

/* ---------- Cuenta Microsoft ---------- */

function activeMicrosoft() {
  const profile = activeProfile();
  return profile && profile.type === 'microsoft' ? profile : null;
}

function renderAccount() {
  const profile = activeMicrosoft();
  const connected = profile ? state.auth[profile.id] !== false : false;

  els.accountFlag.classList.toggle('connected', Boolean(profile) && connected);

  if (!profile) {
    els.accountFlag.textContent = 'SIN CONECTAR';
    els.accountHint.textContent = 'Usa tu cuenta de Microsoft con Minecraft: Java Edition.';
    els.msLoginButton.textContent = 'Iniciar sesión con Microsoft';
    els.msLoginButton.hidden = false;
    els.accountUser.hidden = true;
    return;
  }

  els.msLoginButton.hidden = false;
  els.accountName.textContent = profile.name;

  if (connected) {
    els.accountFlag.textContent = 'CONECTADO';
    els.accountHint.textContent = 'Esta cuenta entra sin contraseña a servidores mixtos.';
    els.msLoginButton.textContent = 'Iniciar sesión con otra cuenta';
    els.accountUser.hidden = false;
    ensureSkin(profile);
  } else {
    els.accountFlag.textContent = 'SESIÓN CADUCADA';
    els.accountHint.textContent =
      'La sesión de Microsoft caducó. Vuelve a conectar la cuenta para jugar.';
    els.msLoginButton.textContent = 'Reconectar Microsoft';
    els.accountUser.hidden = true;
  }
}

async function signInMicrosoft() {
  if (state.signingIn) return;

  state.signingIn = true;
  els.msLoginButton.disabled = true;
  els.msLoginButton.textContent = 'Conectando…';
  els.deviceBox.hidden = true;

  try {
    const result = await api.signInMicrosoft();
    state.config = result.config;
    state.auth = result.auth || {};
    toast(`Sesión iniciada como ${result.profile.name}.`);
    renderProfile();
    renderProfileList();
    renderAccount();
  } catch (error) {
    const message = cleanError(error);
    if (!/cancelad/i.test(message)) toast(message, 'error', 9000);
  } finally {
    state.signingIn = false;
    els.msLoginButton.disabled = false;
    els.deviceBox.hidden = true;
    renderAccount();
  }
}

/* ---------- Actualizaciones ---------- */

const UPDATE_TEXT = {
  idle: 'Sin comprobar',
  checking: 'Buscando actualizaciones…',
  available: 'Actualización disponible',
  downloading: 'Descargando actualización',
  ready: 'Actualización lista para instalar',
  current: 'Launcher actualizado',
  error: 'No se pudo comprobar la actualización',
  disabled: 'Solo en la versión instalada',
};

function renderUpdate(update) {
  if (!update) return;
  state.update = update;

  els.updateVersion.textContent = update.currentVersion || '';
  els.updateState.value = UPDATE_TEXT[update.status] || update.status;

  const visible = ['available', 'downloading', 'ready'].includes(update.status);
  els.updateBar.hidden = !visible;
  els.updateBar.dataset.state = update.status;

  if (update.status === 'downloading') {
    const percent = Math.max(0, Math.min(100, Number(update.percent) || 0));
    els.updateText.textContent = `Descargando ${update.version || 'actualización'} … ${percent}%`;
    els.updateFill.style.width = `${percent}%`;
  } else if (update.status === 'ready') {
    els.updateText.textContent = `Actualización ${update.version || ''} lista. Se aplicará al reiniciar.`;
    els.updateFill.style.width = '100%';
  } else if (update.status === 'available') {
    els.updateText.textContent = `Actualización ${update.version || ''} encontrada, preparando descarga…`;
    els.updateFill.style.width = '6%';
  }

  els.updateAction.hidden = update.status !== 'ready';

  if (state.manualUpdateCheck && ['current', 'error', 'disabled'].includes(update.status)) {
    state.manualUpdateCheck = false;
    if (update.status === 'current') {
      toast(`Estás al día (v${update.currentVersion}).`);
    } else if (update.status === 'disabled') {
      toast('Las actualizaciones automáticas solo funcionan con el launcher instalado.');
    } else {
      toast(`No se pudo comprobar: ${update.error || 'error de red'}`, 'error', 7000);
    }
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
    renderAccount();
    toast(`Cuenta no premium "${activeProfile()?.name}" activada.`);
  } catch (error) {
    toast(cleanError(error), 'error');
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
  els.effectsToggle.checked = config.effects !== false;
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
      effects: els.effectsToggle.checked,
      javaPath: els.javaPath.value.trim() || null,
    });

    applyEffects(state.config.effects !== false);
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

  if (!state.launching) {
    if (!activeProfile()) {
      toast('Elige una cuenta premium o no premium para jugar.');
      renderProfileList();
      renderAccount();
      openPanel(els.profilesOverlay);
      return;
    }
  }

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

  // Cuenta Microsoft
  api.onDeviceCode(({ userCode, verificationUri }) => {
    els.deviceBox.hidden = false;
    els.deviceCode.textContent = userCode;
    els.deviceLink.textContent = 'microsoft.com/link';
    els.deviceLink.dataset.url = verificationUri || 'https://www.microsoft.com/link';
    if (verificationUri) api.open(verificationUri);
  });

  api.onSignedIn((payload) => {
    state.config = payload.config;
    state.auth = payload.auth || {};
    renderProfile();
    renderProfileList();
    renderAccount();
  });

  api.onAuthError(({ message }) => {
    els.deviceBox.hidden = true;
    if (message) toast(message, 'error', 9000);
  });

  // Actualizaciones
  api.onUpdateState((update) => renderUpdate(update));

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

  // Cuenta Microsoft
  els.msLoginButton.addEventListener('click', signInMicrosoft);

  els.deviceLink.addEventListener('click', (event) => {
    event.preventDefault();
    api.open(els.deviceLink.dataset.url || 'https://www.microsoft.com/link');
  });

  els.deviceCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(els.deviceCode.textContent.trim());
      toast('Código copiado.');
    } catch {
      toast('No se pudo copiar el código.', 'error');
    }
  });

  els.deviceCancel.addEventListener('click', () => {
    api.cancelSignIn();
    els.deviceBox.hidden = true;
  });

  // Actualizaciones
  els.updateCheckButton.addEventListener('click', async () => {
    state.manualUpdateCheck = true;
    renderUpdate(await api.checkUpdates());
  });

  els.updateAction.addEventListener('click', () => api.installUpdate());

  // Ajustes
  els.openSettings.addEventListener('click', () => {
    closeAllMenu();
    renderSettings();
    openPanel(els.settingsOverlay);
  });

  const closeSettings = () => {
    closePanel(els.settingsOverlay);
    applyEffects(state.config.effects !== false);
  };

  els.settingsClose.addEventListener('click', closeSettings);
  els.settingsCancel.addEventListener('click', closeSettings);
  els.settingsSave.addEventListener('click', saveSettings);

  els.effectsToggle.addEventListener('change', () => {
    applyEffects(els.effectsToggle.checked);
  });

  els.settingsOverlay.addEventListener('click', (event) => {
    if (event.target === els.settingsOverlay) closeSettings();
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
    renderAccount();
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
    state.auth = boot.auth || {};
    state.update = boot.update || null;

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
    renderAccount();
    renderUpdate(boot.update);
    applyEffects(boot.config.effects !== false);

    setLaunchState('idle');
    setProgress(0, null);

    refreshServerStatus();
    setInterval(refreshServerStatus, 60000);

    detectJava(null);
  } catch (error) {
    toast(`No se pudo iniciar el launcher: ${error.message}`, 'error', 12000);
  }

  bindEvents();

  // Primer inicio sin cuentas: elegir premium o no premium directamente.
  if (state.config && !activeProfile()) {
    renderProfileList();
    renderAccount();
    openPanel(els.profilesOverlay);
    setTimeout(() => els.newProfileName.focus(), 150);
  }
}

document.addEventListener('DOMContentLoaded', init);
