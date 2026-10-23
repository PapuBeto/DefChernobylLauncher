'use strict';

const crypto = require('node:crypto');

/**
 * Perfil offline compatible con servidores `online-mode=false`.
 * El UUID se deriva igual que Minecraft: MD5("OfflinePlayer:<nombre>")
 * con los bits de versión/variante de UUID v3.
 */
function offlineProfile(name) {
  const digest = crypto
    .createHash('md5')
    .update(`OfflinePlayer:${name}`, 'utf8')
    .digest();

  digest[6] = (digest[6] & 0x0f) | 0x30;
  digest[8] = (digest[8] & 0x3f) | 0x80;

  const hex = digest.toString('hex');
  const id = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');

  return {
    name,
    id,
    accessToken: crypto.randomBytes(16).toString('hex'),
    userType: 'legacy',
  };
}

module.exports = { offlineProfile };
