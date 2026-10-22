'use strict';

const { app } = require('electron');

app.whenReady().then(async () => {
  const undici = require('undici');
  console.log('[test] undici', require('undici/package.json').version);

  try {
    console.log('[test] request...');
    const response = await undici.request('https://launchermeta.mojang.com/mc/game/version_manifest.json', {
      throwOnError: true,
    });
    console.log('[test] status', response.statusCode);
    const json = await response.body.json();
    console.log('[test] versions', json.versions.length);
  } catch (error) {
    console.error('[test] error', error);
  }

  app.exit(0);
});
