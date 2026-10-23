'use strict';

const accounts = require('./accounts');
const microsoft = require('./microsoft');
const { offlineProfile } = require('./offline');

const SESSION_MARGIN = 120000; // renueva 2 min antes de caducar
const sessions = new Map();

/**
 * Devuelve la sesión lista para `launch()`:
 * - offline: nombre + UUID v3 derivado del nombre.
 * - microsoft: token real + UUID/nombre de la cuenta.
 */
async function sessionForProfile(profile) {
  if (!profile || profile.type !== 'microsoft') {
    return offlineProfile(profile?.name || 'Jugador');
  }

  const cached = sessions.get(profile.id);
  if (cached && cached.expiresAt - SESSION_MARGIN > Date.now()) {
    return cached.session;
  }

  const account = accounts.get(profile.id);
  if (!account) {
    throw new Error(
      'Esta cuenta necesita iniciar sesión con Microsoft de nuevo (Perfiles → Conectar).',
    );
  }

  const refreshed = await microsoft.refreshMicrosoft(account.refreshToken);
  if (refreshed.refreshToken !== account.refreshToken) {
    accounts.save(profile.id, { ...account, refreshToken: refreshed.refreshToken });
  }

  const minecraft = await microsoft.loginMinecraft(refreshed.accessToken);
  const session = {
    name: minecraft.profile.name,
    id: minecraft.profile.id,
    accessToken: minecraft.accessToken,
    userType: 'msa',
  };

  sessions.set(profile.id, {
    session,
    expiresAt: Date.now() + Math.max(60, minecraft.expiresIn) * 1000,
  });

  return session;
}

/**
 * Flujo interactivo de Microsoft. `onDeviceCode` recibe el código para pintarlo
 * en la interfaz y `signal` permite cancelar el sondeo.
 */
async function signInMicrosoft({ onDeviceCode, signal } = {}) {
  const result = await microsoft.signIn({ onDeviceCode, signal });
  const id = `ms:${result.profile.id}`;

  accounts.save(id, {
    name: result.profile.name,
    uuid: result.profile.id,
    refreshToken: result.refreshToken,
  });

  sessions.set(id, {
    session: {
      name: result.profile.name,
      id: result.profile.id,
      accessToken: result.accessToken,
      userType: 'msa',
    },
    expiresAt: Date.now() + Math.max(60, result.expiresIn) * 1000,
  });

  return { id, profile: result.profile };
}

function signOut(id) {
  sessions.delete(id);
  return accounts.remove(id);
}

function hasSession(id) {
  return sessions.has(id) || accounts.has(id);
}

/** Estado de sesión por perfil, para pintar la UI. */
function status(profiles = []) {
  const result = {};
  for (const profile of profiles) {
    if (profile.type !== 'microsoft') continue;
    result[profile.id] = hasSession(profile.id);
  }
  return result;
}

module.exports = {
  sessionForProfile,
  signInMicrosoft,
  signOut,
  hasSession,
  status,
  offlineProfile,
};
