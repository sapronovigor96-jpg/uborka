// Рисует иконки (SVG + PNG 192/512) без внешних библиотек: node tools/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [0x1d, 0x18, 0x13];
const ACC = [0xea, 0xb8, 0x7f];
const OK = [0xa6, 0xc1, 0x91];

// Искорка: |x|^p + |y|^p <= 1 при p=0.5 — четырёхлучевая звезда.
const sparkles = [
  { cx: 0.46, cy: 0.54, r: 0.30, c: ACC },
  { cx: 0.73, cy: 0.27, r: 0.12, c: OK },
];

function inSparkle(x, y, s) {
  const dx = Math.abs(x - s.cx) / s.r;
  const dy = Math.abs(y - s.cy) / s.r;
  return Math.sqrt(dx) + Math.sqrt(dy) <= 1;
}

function png(size) {
  const SS = 4;
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const hit = sparkles.find((s) => inSparkle(x, y, s));
          const c = hit ? hit.c : BG;
          for (let k = 0; k < 3; k++) acc[k] += c[k];
        }
      for (let k = 0; k < 3; k++) row[1 + px * 3 + k] = Math.round(acc[k] / (SS * SS));
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function svg() {
  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  // Та же кривая, аппроксимированная четырьмя квадратичными Безье с контрольной точкой в центре.
  const star = (s) => {
    const { cx, cy, r } = s;
    const p = (x, y) => `${(x * 100).toFixed(2)} ${(y * 100).toFixed(2)}`;
    return `<path fill="${hex(s.c)}" d="M${p(cx, cy - r)} Q${p(cx, cy)} ${p(cx + r, cy)} Q${p(cx, cy)} ${p(cx, cy + r)} Q${p(cx, cy)} ${p(cx - r, cy)} Q${p(cx, cy)} ${p(cx, cy - r)}Z"/>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="${hex(BG)}"/>${sparkles.map(star).join('')}</svg>\n`;
}

writeFileSync('icons/icon-192.png', png(192));
writeFileSync('icons/icon-512.png', png(512));
writeFileSync('icons/icon.svg', svg());
console.log('ok');
