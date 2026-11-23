'use strict';

/**
 * Genera build/icon.png (256x256) y build/icon.ico a partir de un dibujo
 * procedural del símbolo de radiación. Sin dependencias externas.
 *
 *   node scripts/generate-icon.js
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;
const SS = 3; // supermuestreo para bordes suaves
const GREEN = [156, 255, 66];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits por canal
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filtro "none"
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO con una única entrada de 256x256 en formato PNG (Vista+). */
function encodeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry[0] = 0; // 256 px
  entry[1] = 0; // 256 px
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4); // planos
  entry.writeUInt16LE(32, 6); // bits por pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);

  return Buffer.concat([header, entry, png]);
}

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** Distancia (aproximada) al símbolo de radiación; negativa dentro. */
function symbolDistance(x, y) {
  const r = Math.hypot(x, y);
  const disc = r - 0.17;

  let blade = Infinity;
  if (r >= 0.015) {
    const angle = Math.atan2(y, x);
    for (let i = 0; i < 3; i += 1) {
      const center = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
      let delta = Math.abs(angle - center);
      if (delta > Math.PI) delta = 2 * Math.PI - delta;
      const gap = (Math.PI / 3) * 0.5; // medio hueco de 60° entre palas
      const radial = Math.max(0.24 - r, r - 0.63);
      const tangential = Math.max(0, delta - gap) * r;
      blade = Math.min(blade, Math.max(radial, tangential));
    }
  }

  return Math.min(disc, blade);
}

function render() {
  const big = SIZE * SS;
  const rgba = Buffer.alloc(SIZE * SIZE * 4);

  for (let py = 0; py < SIZE; py += 1) {
    for (let px = 0; px < SIZE; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = ((px * SS + sx + 0.5) / big) * 2 - 1;
          const y = ((py * SS + sy + 0.5) / big) * 2 - 1;

          // Fondo: cuadrado redondeado oscuro con degradado radial.
          const radius = 0.82;
          const qx = Math.abs(x) - radius + 0.18;
          const qy = Math.abs(y) - radius + 0.18;
          const corner =
            Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 0.18;
          const inside = corner < 0;
          if (!inside) continue;

          const distanceFromCenter = clamp01(Math.hypot(x, y) / 1.25);
          const base = 0.055 + 0.05 * (1 - distanceFromCenter);
          let cr = 8 * base * 6;
          let cg = 14 * base * 6;
          let cb = 10 * base * 6;

          // Resplandor verde alrededor del símbolo.
          const sd = symbolDistance(x, y);
          const glow = Math.exp(-Math.max(sd, 0) / 0.1) * 0.5 + Math.exp(-Math.max(sd, 0) / 0.03) * 0.5;
          const edge = clamp01(0.5 - sd * big * 0.5);
          const ink = clamp01(edge);

          const glowStrength = sd < 0.05 ? glow : glow * 0.6;
          cr += GREEN[0] * glowStrength * 0.35;
          cg += GREEN[1] * glowStrength * 0.55;
          cb += GREEN[2] * glowStrength * 0.3;

          // Símbolo sólido.
          cr = cr * (1 - ink) + GREEN[0] * ink;
          cg = cg * (1 - ink) + GREEN[1] * ink;
          cb = cb * (1 - ink) + GREEN[2] * ink;

          // Anillo exterior tenue.
          const ring = Math.abs(Math.hypot(x, y) - 0.72);
          const ringAlpha = clamp01(1 - ring / 0.012) * 0.28;
          cr = cr * (1 - ringAlpha) + GREEN[0] * ringAlpha;
          cg = cg * (1 - ringAlpha) + GREEN[1] * ringAlpha;
          cb = cb * (1 - ringAlpha) + GREEN[2] * ringAlpha;

          r += cr;
          g += cg;
          b += cb;
          a += 255;
        }
      }

      const samples = SS * SS;
      const offset = (py * SIZE + px) * 4;
      const alpha = a / samples;
      if (alpha <= 0) continue;
      const weight = a / 255; // media solo de las muestras opacas

      rgba[offset] = Math.round(Math.min(255, r / weight));
      rgba[offset + 1] = Math.round(Math.min(255, g / weight));
      rgba[offset + 2] = Math.round(Math.min(255, b / weight));
      rgba[offset + 3] = Math.round(alpha);
    }
  }

  return rgba;
}

const build = path.join(__dirname, '..', 'build');
fs.mkdirSync(build, { recursive: true });

const png = encodePng(SIZE, SIZE, render());
fs.writeFileSync(path.join(build, 'icon.png'), png);
fs.writeFileSync(path.join(build, 'icon.ico'), encodeIco(png));

console.log(`[icon] build/icon.png (${png.length} bytes)`);
console.log('[icon] build/icon.ico (256x256)');
