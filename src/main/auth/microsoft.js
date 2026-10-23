'use strict';

const { loadAuth } = require('../resources');

/**
 * Inicio de sesión con cuenta Microsoft (device code) y cadena de
 * autenticación de Minecraft:
 *
 *   Microsoft → Xbox Live → XSTS → Minecraft Services → perfil
 *
 * Todo con `fetch`, sin dependencias externas.
 */

const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

const XSTS_ERRORS = {
  2148916233:
    'Esa cuenta Microsoft no tiene perfil de Xbox. Crea uno en xbox.com y vuelve a intentarlo.',
  2148916235: 'Xbox Live no está disponible en el país de esa cuenta.',
  2148916236: 'La cuenta es de un menor y necesita autorización familiar.',
  2148916237: 'La cuenta es de un menor y necesita autorización familiar.',
  2148916238: 'La cuenta es de un menor: debe estar añadida a un grupo familiar de Microsoft.',
};

function authConfig() {
  const auth = loadAuth();
  return {
    clientId: String(auth.clientId || ''),
    tenant: String(auth.tenant || 'consumers'),
    scope: String(auth.scope || 'XboxLive.signin offline_access'),
  };
}

function timeoutSignal(ms, signal) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function cancelError() {
  return new Error('Inicio de sesión cancelado.');
}

async function postForm(url, params, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: timeoutSignal(30000, signal),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok && !data.error) {
    throw new Error(`Microsoft respondió HTTP ${response.status}.`);
  }
  return data;
}

async function postJson(url, body, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: timeoutSignal(30000, signal),
  });

  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(cancelError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Pide el código de 8 caracteres que el usuario introduce en microsoft.com/link. */
async function requestDeviceCode(signal) {
  const { clientId, tenant, scope } = authConfig();
  if (!clientId) {
    throw new Error('Falta el clientId de Azure en resources/auth.json.');
  }

  const data = await postForm(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/devicecode`,
    { client_id: clientId, scope },
    signal,
  );

  if (!data.device_code) {
    throw new Error(data.error_description || 'Microsoft rechazó la solicitud de inicio de sesión.');
  }

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri || 'https://www.microsoft.com/link',
    expiresIn: Number(data.expires_in) || 900,
    interval: Number(data.interval) || 5,
    message: data.message || '',
  };
}

/** Sondea el endpoint de token hasta que el usuario autoriza o caduca el código. */
async function pollForToken(device, signal) {
  const { clientId } = authConfig();
  const deadline = Date.now() + device.expiresIn * 1000;
  let wait = device.interval;

  while (Date.now() < deadline) {
    await sleep(wait * 1000, signal);

    const data = await postForm(
      `https://login.microsoftonline.com/${authConfig().tenant}/oauth2/v2.0/token`,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: device.deviceCode,
      },
      signal,
    );

    if (data.access_token) return data;

    switch (data.error) {
      case 'authorization_pending':
        break;
      case 'slow_down':
        wait += 5;
        break;
      case 'expired_token':
        throw new Error('El código caducó. Pulsa "Iniciar sesión" para generar uno nuevo.');
      case 'authorization_declined':
        throw new Error('Has cancelado el inicio de sesión en Microsoft.');
      default:
        throw new Error(data.error_description || 'No se pudo iniciar sesión con Microsoft.');
    }
  }

  throw new Error('El código caducó. Pulsa "Iniciar sesión" para generar uno nuevo.');
}

/** Renueva el token de Microsoft con el refresh token guardado. */
async function refreshMicrosoft(refreshToken, signal) {
  const { clientId, tenant, scope } = authConfig();
  const data = await postForm(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
      scope,
    },
    signal,
  );

  if (!data.access_token) {
    throw new Error('La sesión de Microsoft caducó. Inicia sesión de nuevo.');
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: Number(data.expires_in) || 3600,
  };
}

async function xboxLive(msAccessToken, signal) {
  const { response, data } = await postJson(
    XBL_URL,
    {
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `d=${msAccessToken}`,
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    },
    signal,
  );

  const uhs = data?.DisplayClaims?.xui?.[0]?.uhs;
  if (!response.ok || !data.Token || !uhs) {
    throw new Error('Xbox Live rechazó la cuenta. Comprueba que tenga perfil de Xbox.');
  }

  return { token: data.Token, uhs };
}

async function xsts(xbl, signal) {
  const { response, data } = await postJson(
    XSTS_URL,
    {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.token] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    },
    signal,
  );

  if (!response.ok) {
    throw new Error(XSTS_ERRORS[data?.XErr] || 'Xbox Live no autorizó esta cuenta.');
  }

  const uhs = data?.DisplayClaims?.xui?.[0]?.uhs;
  if (!data.Token || !uhs) {
    throw new Error('Respuesta inesperada de Xbox Live.');
  }

  return { token: data.Token, uhs };
}

/** Devuelve token de Minecraft + perfil (nombre y UUID reales). */
async function loginMinecraft(msAccessToken, signal) {
  const xbl = await xboxLive(msAccessToken, signal);
  const secure = await xsts(xbl, signal);

  const { response, data } = await postJson(
    MC_LOGIN_URL,
    { identityToken: `XBL3.0 x=${secure.uhs};${secure.token}` },
    signal,
  );

  if (!response.ok || !data.access_token) {
    throw new Error('Minecraft rechazó la sesión. Comprueba que la cuenta tenga el juego.');
  }

  const profileResponse = await fetch(MC_PROFILE_URL, {
    headers: { authorization: `Bearer ${data.access_token}`, accept: 'application/json' },
    signal: timeoutSignal(30000, signal),
  });

  if (profileResponse.status === 404) {
    throw new Error('Esa cuenta de Microsoft no tiene Minecraft: Java Edition.');
  }

  if (!profileResponse.ok) {
    throw new Error(`No se pudo obtener el perfil de Minecraft (HTTP ${profileResponse.status}).`);
  }

  const profile = await profileResponse.json();

  return {
    accessToken: data.access_token,
    expiresIn: Number(data.expires_in) || 86400,
    profile: { id: profile.id, name: profile.name, skins: profile.skins || [] },
  };
}

/** Flujo completo de inicio de sesión (device code → Minecraft). */
async function signIn({ onDeviceCode = () => {}, signal } = {}) {
  const device = await requestDeviceCode(signal);
  onDeviceCode(device);

  const token = await pollForToken(device, signal);
  const minecraft = await loginMinecraft(token.access_token, signal);

  return {
    profile: minecraft.profile,
    accessToken: minecraft.accessToken,
    expiresIn: minecraft.expiresIn,
    refreshToken: token.refresh_token,
  };
}

module.exports = {
  signIn,
  requestDeviceCode,
  pollForToken,
  refreshMicrosoft,
  loginMinecraft,
  authConfig,
};
