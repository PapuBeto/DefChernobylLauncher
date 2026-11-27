'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/**
 * Lector y escritor NBT sin dependencias externas para `servers.dat` de Minecraft.
 * Preserva intactos todos los servidores y etiquetas NBT existentes del jugador
 * mientras asegura que el servidor oficial aparezca siempre en Multijugador.
 */

const TAG = {
  End: 0,
  Byte: 1,
  Short: 2,
  Int: 3,
  Long: 4,
  Float: 5,
  Double: 6,
  ByteArray: 7,
  String: 8,
  List: 9,
  Compound: 10,
  IntArray: 11,
  LongArray: 12,
};

class NbtReader {
  constructor(buffer) {
    this.buf = buffer;
    this.pos = 0;
  }

  ensure(bytes) {
    if (this.pos + bytes > this.buf.length) {
      throw new Error('Archivo NBT truncado.');
    }
  }

  readByte() {
    this.ensure(1);
    const value = this.buf.readInt8(this.pos);
    this.pos += 1;
    return value;
  }

  readUShort() {
    this.ensure(2);
    const value = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return value;
  }

  readShort() {
    this.ensure(2);
    const value = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return value;
  }

  readInt() {
    this.ensure(4);
    const value = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return value;
  }

  readLong() {
    this.ensure(8);
    const value = this.buf.readBigInt64BE(this.pos);
    this.pos += 8;
    return value;
  }

  readFloat() {
    this.ensure(4);
    const value = this.buf.readFloatBE(this.pos);
    this.pos += 4;
    return value;
  }

  readDouble() {
    this.ensure(8);
    const value = this.buf.readDoubleBE(this.pos);
    this.pos += 8;
    return value;
  }

  readString() {
    const len = this.readUShort();
    this.ensure(len);
    const value = this.buf.subarray(this.pos, this.pos + len).toString('utf8');
    this.pos += len;
    return value;
  }

  readPayload(type, depth = 0) {
    if (depth > 64) throw new Error('Profundidad NBT excesiva.');
    switch (type) {
      case TAG.Byte:
        return this.readByte();
      case TAG.Short:
        return this.readShort();
      case TAG.Int:
        return this.readInt();
      case TAG.Long:
        return this.readLong();
      case TAG.Float:
        return this.readFloat();
      case TAG.Double:
        return this.readDouble();
      case TAG.ByteArray: {
        const len = this.readInt();
        if (len < 0) throw new Error('Longitud de ByteArray inválida.');
        this.ensure(len);
        const value = Buffer.from(this.buf.subarray(this.pos, this.pos + len));
        this.pos += len;
        return value;
      }
      case TAG.String:
        return this.readString();
      case TAG.List: {
        const elementType = this.readByte();
        const len = this.readInt();
        if (len < 0) throw new Error('Longitud de List inválida.');
        const items = [];
        for (let i = 0; i < len; i += 1) {
          items.push(this.readPayload(elementType, depth + 1));
        }
        return { elementType, items };
      }
      case TAG.Compound: {
        const entries = [];
        while (true) {
          const entryType = this.readByte();
          if (entryType === TAG.End) break;
          const name = this.readString();
          const value = this.readPayload(entryType, depth + 1);
          entries.push({ type: entryType, name, value });
        }
        return entries;
      }
      case TAG.IntArray: {
        const len = this.readInt();
        if (len < 0) throw new Error('Longitud de IntArray inválida.');
        this.ensure(len * 4);
        const value = Buffer.from(this.buf.subarray(this.pos, this.pos + len * 4));
        this.pos += len * 4;
        return value;
      }
      case TAG.LongArray: {
        const len = this.readInt();
        if (len < 0) throw new Error('Longitud de LongArray inválida.');
        this.ensure(len * 8);
        const value = Buffer.from(this.buf.subarray(this.pos, this.pos + len * 8));
        this.pos += len * 8;
        return value;
      }
      default:
        throw new Error(`Tipo de etiqueta NBT desconocido: ${type}`);
    }
  }

  readRoot() {
    const type = this.readByte();
    if (type !== TAG.Compound) {
      throw new Error(`Raíz NBT inválida (esperado Compound, recibido ${type}).`);
    }
    const name = this.readString();
    const value = this.readPayload(TAG.Compound, 0);
    return { type, name, value };
  }
}

function encodeString(value) {
  const bytes = Buffer.from(String(value ?? ''), 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

function encodePayload(type, value, chunks) {
  switch (type) {
    case TAG.Byte: {
      const b = Buffer.alloc(1);
      b.writeInt8(value, 0);
      chunks.push(b);
      break;
    }
    case TAG.Short: {
      const b = Buffer.alloc(2);
      b.writeInt16BE(value, 0);
      chunks.push(b);
      break;
    }
    case TAG.Int: {
      const b = Buffer.alloc(4);
      b.writeInt32BE(value, 0);
      chunks.push(b);
      break;
    }
    case TAG.Long: {
      const b = Buffer.alloc(8);
      b.writeBigInt64BE(BigInt(value), 0);
      chunks.push(b);
      break;
    }
    case TAG.Float: {
      const b = Buffer.alloc(4);
      b.writeFloatBE(value, 0);
      chunks.push(b);
      break;
    }
    case TAG.Double: {
      const b = Buffer.alloc(8);
      b.writeDoubleBE(value, 0);
      chunks.push(b);
      break;
    }
    case TAG.ByteArray: {
      const len = Buffer.alloc(4);
      len.writeInt32BE(value.length, 0);
      chunks.push(len, value);
      break;
    }
    case TAG.String:
      chunks.push(encodeString(value));
      break;
    case TAG.List: {
      const header = Buffer.alloc(5);
      header.writeInt8(value.elementType, 0);
      header.writeInt32BE(value.items.length, 1);
      chunks.push(header);
      for (const item of value.items) {
        encodePayload(value.elementType, item, chunks);
      }
      break;
    }
    case TAG.Compound: {
      for (const entry of value) {
        chunks.push(Buffer.from([entry.type]), encodeString(entry.name));
        encodePayload(entry.type, entry.value, chunks);
      }
      chunks.push(Buffer.from([TAG.End]));
      break;
    }
    case TAG.IntArray: {
      const len = Buffer.alloc(4);
      len.writeInt32BE(Math.floor(value.length / 4), 0);
      chunks.push(len, value);
      break;
    }
    case TAG.LongArray: {
      const len = Buffer.alloc(4);
      len.writeInt32BE(Math.floor(value.length / 8), 0);
      chunks.push(len, value);
      break;
    }
    default:
      throw new Error(`Tipo NBT no soportado al escribir: ${type}`);
  }
}

function serializeRoot(root) {
  const chunks = [Buffer.from([TAG.Compound]), encodeString(root.name || '')];
  encodePayload(TAG.Compound, root.value || [], chunks);
  return Buffer.concat(chunks);
}

function parseNbtFile(filePath) {
  let raw = fs.readFileSync(filePath);
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    raw = zlib.gunzipSync(raw);
  }
  return new NbtReader(raw).readRoot();
}

function getCompoundString(entries, key) {
  const found = entries.find((entry) => entry.name === key && entry.type === TAG.String);
  return found ? String(found.value || '') : '';
}

function setCompoundString(entries, key, value) {
  const found = entries.find((entry) => entry.name === key);
  if (found) {
    found.type = TAG.String;
    found.value = String(value);
  } else {
    entries.push({ type: TAG.String, name: key, value: String(value) });
  }
}

/**
 * Crea o actualiza el servidor oficial dentro de `<gameDir>/servers.dat`
 * sin borrar otros servidores guardados por el jugador.
 */
function ensureServerEntry(gameDir, { name = 'Chernobyl Z', host, port = 25565 } = {}) {
  const cleanHost = String(host || '').trim();
  if (!cleanHost || !gameDir) return { updated: false, reason: 'missing-host' };

  const numericPort = Number(port);
  const address =
    Number.isInteger(numericPort) && numericPort >= 1 && numericPort <= 65535 && numericPort !== 25565
      ? `${cleanHost}:${numericPort}`
      : cleanHost;
  const serverName = String(name || 'Chernobyl Z').trim() || 'Chernobyl Z';

  const filePath = path.join(gameDir, 'servers.dat');
  let root = { type: TAG.Compound, name: '', value: [] };

  if (fs.existsSync(filePath)) {
    try {
      root = parseNbtFile(filePath);
    } catch {
      // Si el archivo previo está corrupto, guardamos respaldo y generamos uno limpio.
      try {
        fs.copyFileSync(filePath, `${filePath}.bak`);
      } catch {
        /* respaldo best-effort */
      }
      root = { type: TAG.Compound, name: '', value: [] };
    }
  }

  let serversTag = root.value.find((entry) => entry.name === 'servers' && entry.type === TAG.List);
  if (!serversTag) {
    serversTag = {
      type: TAG.List,
      name: 'servers',
      value: { elementType: TAG.Compound, items: [] },
    };
    root.value.push(serversTag);
  } else if (serversTag.value.items.length === 0) {
    serversTag.value.elementType = TAG.Compound;
  }

  const items = serversTag.value.items;
  const targetNameLower = serverName.toLowerCase();
  const targetAddressLower = address.toLowerCase();
  const targetHostLower = cleanHost.toLowerCase();

  let matchedIndex = -1;
  for (let i = 0; i < items.length; i += 1) {
    const entry = items[i];
    if (!Array.isArray(entry)) continue;
    const entryName = getCompoundString(entry, 'name').trim().toLowerCase();
    const entryIp = getCompoundString(entry, 'ip').trim().toLowerCase();
    const entryHost = entryIp.split(':')[0];
    if (entryName === targetNameLower || entryIp === targetAddressLower || entryHost === targetHostLower) {
      matchedIndex = i;
      break;
    }
  }

  let changed = false;
  if (matchedIndex >= 0) {
    const entry = items[matchedIndex];
    const prevName = getCompoundString(entry, 'name');
    const prevIp = getCompoundString(entry, 'ip');
    if (prevName !== serverName || prevIp !== address) {
      setCompoundString(entry, 'name', serverName);
      setCompoundString(entry, 'ip', address);
      changed = true;
    }
  } else {
    items.unshift([
      { type: TAG.String, name: 'name', value: serverName },
      { type: TAG.String, name: 'ip', value: address },
    ]);
    changed = true;
  }

  if (!changed && fs.existsSync(filePath)) {
    return { updated: false, address, name: serverName };
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, serializeRoot(root));
  fs.renameSync(tempPath, filePath);
  return { updated: true, address, name: serverName };
}

module.exports = { ensureServerEntry, parseNbtFile, serializeRoot, TAG };
