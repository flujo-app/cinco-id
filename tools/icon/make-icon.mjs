// Draws the app icon in code: a beige mid-nineties monitor with a teal screen and a little
// dancer in a big hat. No picture files, no outside artwork. Writes
//   build/icon.ico       (16, 24, 32, 48, 64, 128 and 256 pixels, for the installer and the program)
//   src/shell/icon.png   (256 pixels, for the window)
// Usage: npm run icon
import { promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const COLOURS = {
  '.': null,
  K: [0, 0, 0], W: [255, 255, 255], L: [223, 223, 223], F: [192, 192, 192], S: [128, 128, 128],
  T: [0, 128, 128], D: [0, 96, 96], N: [0, 0, 128], Y: [255, 216, 0], P: [232, 64, 160], G: [53, 226, 90],
};

// 32 by 32 pixels. F face, L light edge, S shadow, K outline, T teal screen, D darker screen line,
// N navy hat, Y the dancer, P the hat band, G the power light.
const ART = [
  '................................',
  '................................',
  '..KKKKKKKKKKKKKKKKKKKKKKKKKKKK..',
  '..KWWWWWWWWWWWWWWWWWWWWWWWWWSK..',
  '..KWLLLLLLLLLLLLLLLLLLLLLLLLSK..',
  '..KWLSSSSSSSSSSSSSSSSSSSSSWLSK..',
  '..KWLSKKKKKKKKKKKKKKKKKKKKWLSK..',
  '..KWLSKTTTTTTTTTTNNNNTTTTKWLSK..',
  '..KWLSKTTTTTTTTTNNNNNNTTTKWLSK..',
  '..KWLSKDDDDDDDDNNPPPPNNDDKWLSK..',
  '..KWLSKTTTTTTTTTTTYYTTTTTKWLSK..',
  '..KWLSKTTTTTTTYTTTYYTTTYTKWLSK..',
  '..KWLSKTTTTTTTTYYYYYYYYTTKWLSK..',
  '..KWLSKDDDDDDDDDDDYYDDDDDKWLSK..',
  '..KWLSKTTTTTTTTTTTYYTTTTTKWLSK..',
  '..KWLSKTTTTTTTTTTYTTYTTTTKWLSK..',
  '..KWLSKTTTTTTTTTYTTTTYTTTKWLSK..',
  '..KWLSKDDDDDDDDYDDDDDDYDDKWLSK..',
  '..KWLSKTTTTTTTTWWTTTTWWTTKWLSK..',
  '..KWLSKTTTTTTTTTTTTTTTTTTKWLSK..',
  '..KWLSKWWWWWWWWWWWWWWWWWWWWLSK..',
  '..KWLLLLLLLLLLLLLLLLLLLLGGLLSK..',
  '..KSSSSSSSSSSSSSSSSSSSSSSSSSSK..',
  '..KKKKKKKKKKKKKKKKKKKKKKKKKKKK..',
  '............KSFFFFSK............',
  '............KSFFFFSK............',
  '......KKKKKKKKKKKKKKKKKKKK......',
  '......KWWWWWWWWWWWWWWWWWWK......',
  '......KWLLLLLLLLLLLLLLLLSK......',
  '......KSSSSSSSSSSSSSSSSSSK......',
  '......KKKKKKKKKKKKKKKKKKKK......',
  '................................',
];

function pixels(size) {
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const colour = COLOURS[ART[Math.floor(y * 32 / size)][Math.floor(x * 32 / size)]];
      if (colour) data.set([...colour, 255], (y * size + x) * 4);
    }
  }
  return data;
}

function crc32(buffer) {
  if (zlib.crc32) return zlib.crc32(buffer);
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

function png(size) {
  const raw = pixels(size);
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) raw.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(sizes) {
  const images = sizes.map(png);
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((size, i) => {
    const at = 6 + i * 16;
    head.writeUInt8(size >= 256 ? 0 : size, at);
    head.writeUInt8(size >= 256 ? 0 : size, at + 1);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(images[i].length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += images[i].length;
  });
  return Buffer.concat([head, ...images]);
}

await fs.mkdir(path.join(root, 'build'), { recursive: true });
await fs.writeFile(path.join(root, 'build', 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]));
await fs.writeFile(path.join(root, 'src', 'shell', 'icon.png'), png(256));
console.log('Wrote build/icon.ico and src/shell/icon.png');
