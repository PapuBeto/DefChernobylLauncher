'use strict';

const net = require('node:net');
const { performance } = require('node:perf_hooks');

const PROTOCOL_VERSION = 763; // Minecraft 1.20.1

function writeVarInt(value) {
  const bytes = [];
  let current = value >>> 0;

  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (current !== 0);

  return Buffer.from(bytes);
}

function writeString(text) {
  const data = Buffer.from(text, 'utf8');
  return Buffer.concat([writeVarInt(data.length), data]);
}

function handshakePacket(host, port) {
  const body = Buffer.concat([
    writeVarInt(0x00),
    writeVarInt(PROTOCOL_VERSION),
    writeString(host),
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    writeVarInt(1),
  ]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

function requestPacket() {
  return Buffer.from([0x01, 0x00]);
}

const MAX_RESPONSE_BYTES = 65536;

function readVarInt(buffer, offset) {
  let result = 0;
  let shift = 0;
  let position = offset;

  while (position < buffer.length && shift < 35) {
    const byte = buffer[position++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result, offset: position };
    shift += 7;
  }

  return null;
}

function flattenMotd(motd) {
  if (!motd) return '';
  if (typeof motd === 'string') return motd;

  let text = motd.text || '';
  if (Array.isArray(motd.extra)) {
    text += motd.extra.map(flattenMotd).join('');
  }
  return text;
}

/** Server List Ping (1.7+). Devuelve estado, jugadores y latencia. */
function ping(host, port = 25565, timeout = 5000) {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = new net.Socket();
    let buffer = Buffer.alloc(0);
    let settled = false;
    let latency = null;

    const overallTimer = setTimeout(() => fail('timeout'), timeout);
    overallTimer.unref?.();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimer);
      socket.destroy();
      resolve(result);
    };

    const fail = (reason) => finish({ online: false, error: reason, host, port });

    socket.setTimeout(timeout);
    socket.once('timeout', () => fail('timeout'));
    socket.once('error', (error) => fail(error.code || 'socket-error'));

    socket.connect(port, host, () => {
      socket.write(handshakePacket(host, port));
      socket.write(requestPacket());
    });

    socket.on('data', (chunk) => {
      if (buffer.length + chunk.length > MAX_RESPONSE_BYTES) {
        fail('response-too-large');
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);

      const length = readVarInt(buffer, 0);
      if (!length) {
        if (buffer.length >= 5) fail('bad-varint');
        return;
      }
      if (length.value <= 0 || length.value > MAX_RESPONSE_BYTES) {
        fail('bad-length');
        return;
      }
      if (buffer.length < length.offset + length.value) return;

      const packet = buffer.subarray(length.offset, length.offset + length.value);
      const packetId = readVarInt(packet, 0);
      if (!packetId || packetId.value !== 0x00) {
        fail('bad-packet');
        return;
      }

      const textLength = readVarInt(packet, packetId.offset);
      if (!textLength || textLength.value <= 0 || textLength.offset + textLength.value > packet.length) {
        fail('bad-length');
        return;
      }

      const json = packet
        .subarray(textLength.offset, textLength.offset + textLength.value)
        .toString('utf8');

      latency = Math.round(performance.now() - started);

      try {
        const status = JSON.parse(json);
        finish({
          online: true,
          host,
          port,
          latency,
          protocol: status.version?.protocol ?? null,
          version: status.version?.name ?? null,
          motd: flattenMotd(status.description).trim(),
          players: {
            online: status.players?.online ?? 0,
            max: status.players?.max ?? 0,
          },
        });
      } catch {
        fail('bad-response');
      }
    });

    socket.once('close', () => {
      if (!settled) fail('closed');
    });
  });
}

module.exports = { ping };
