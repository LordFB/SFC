import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const palette = {
  ink: [10, 12, 11],
  lime: [196, 255, 77],
  cyan: [112, 225, 209]
};

const fold = [
  [17, 12], [51, 12], [43, 22], [26, 22], [21, 27], [26, 32],
  [39, 32], [48, 41], [48, 46], [41, 53], [13, 53], [21, 43],
  [37, 43], [41, 39], [37, 35], [23, 35], [14, 26], [14, 21]
];

function insidePolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function insideRoundedRect(x, y, left, top, width, height, radius) {
  const nearestX = Math.max(left + radius, Math.min(x, left + width - radius));
  const nearestY = Math.max(top + radius, Math.min(y, top + height - radius));
  return (x - nearestX) ** 2 + (y - nearestY) ** 2 <= radius ** 2;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function render(size, markScale = 1) {
  const samples = size <= 32 ? 8 : 4;
  const rows = Buffer.alloc((size * 4 + 1) * size);
  const sampleCount = samples * samples;
  const center = 32;

  for (let py = 0; py < size; py++) {
    const row = py * (size * 4 + 1);
    rows[row] = 0;
    for (let px = 0; px < size; px++) {
      let lime = 0;
      let cyan = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          let x = ((px + (sx + 0.5) / samples) / size) * 64;
          let y = ((py + (sy + 0.5) / samples) / size) * 64;
          x = (x - center) / markScale + center;
          y = (y - center) / markScale + center;
          if (insideRoundedRect(x, y, 45, 10, 8, 8, 2)) cyan++;
          else if (insidePolygon(x, y, fold)) lime++;
        }
      }

      const limeMix = lime / sampleCount;
      const cyanMix = cyan / sampleCount;
      const inkMix = 1 - limeMix - cyanMix;
      const offset = row + 1 + px * 4;
      for (let channel = 0; channel < 3; channel++) {
        rows[offset + channel] = Math.round(
          palette.ink[channel] * inkMix + palette.lime[channel] * limeMix + palette.cyan[channel] * cyanMix
        );
      }
      rows[offset + 3] = 255;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const output = join(process.cwd(), 'public', 'icons');
mkdirSync(output, { recursive: true });

for (const [name, size, scale] of [
  ['favicon-16.png', 16, 0.94],
  ['favicon-32.png', 32, 0.94],
  ['apple-touch-icon.png', 180, 0.9],
  ['icon-192.png', 192, 0.9],
  ['icon-512.png', 512, 0.9],
  ['icon-maskable-512.png', 512, 0.78]
]) writeFileSync(join(output, name), render(size, scale));

console.log('Generated SFC app icons in public/icons.');
