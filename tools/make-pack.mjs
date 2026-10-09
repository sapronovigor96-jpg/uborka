// Собирает «пакет игры» для пиксельной темы из своей копии Stardew Valley.
//
//   npm install            (один раз, ставит xnb, opentype.js и pngjs)
//   node tools/make-pack.mjs ["C:\Program Files (x86)\Stardew Valley"]
//
// Результат — stardew-pack.json в корне проекта. Он в .gitignore: это файлы игры, их нельзя
// публиковать. Файл переносится на телефон и загружается в «Настройки → Вид → Загрузить пакет игры».

import fs from 'node:fs/promises';
import path from 'node:path';
import XNB from 'xnb';
import opentype from 'opentype.js';
import { PNG } from 'pngjs';

const GAME = process.argv[2] || 'C:\\Program Files (x86)\\Stardew Valley';
const C = path.join(GAME, 'Content');
const OUT = path.join(import.meta.dirname, '..', 'stardew-pack.json');

const bytes = async (d) => (d instanceof Blob ? Buffer.from(await d.arrayBuffer()) : Buffer.from(d));

// xnb → { png: PNG, json: object|null }
async function unpack(rel) {
  const files = await XNB.unpackToFiles(await fs.readFile(path.join(C, rel)), { fileName: 'x' });
  const out = {};
  for (const { data, extension } of files) {
    if (extension === 'png') out.png = PNG.sync.read(await bytes(data));
    if (extension === 'json') out.json = JSON.parse((await bytes(data)).toString('utf8'));
  }
  return out;
}

const alpha = (png, x, y) => png.data[(png.width * y + x) * 4 + 3];

function crop(png, x, y, w, h) {
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(png, out, x, y, w, h, 0, 0);
  return PNG.sync.write(out).toString('base64');
}
const whole = (png) => PNG.sync.write(png).toString('base64');

// Пиксели глифа → квадраты контура (подряд идущие пиксели строки — одним прямоугольником).
function glyphPath(png, gx, gy, gw, gh, dx, top, U) {
  const p = new opentype.Path();
  for (let y = 0; y < gh; y++) {
    let x = 0;
    while (x < gw) {
      if (alpha(png, gx + x, gy + y) > 127) {
        const s = x;
        while (x < gw && alpha(png, gx + x, gy + y) > 127) x++;
        const X0 = (dx + s) * U, X1 = (dx + x) * U, Yt = (top - y) * U;
        p.moveTo(X0, Yt - U); p.lineTo(X1, Yt - U); p.lineTo(X1, Yt); p.lineTo(X0, Yt); p.close();
      } else x++;
    }
  }
  return p;
}

function makeFont(family, glyphs, upem, ascender, descender) {
  const notdef = new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: upem / 3, path: new opentype.Path() });
  const font = new opentype.Font({ familyName: family, styleName: 'Regular', unitsPerEm: Math.round(upem), ascender, descender, glyphs: [notdef, ...glyphs] });
  return Buffer.from(font.toArrayBuffer()).toString('base64');
}

const U = 100;

// Шрифт текста русской версии (XNA SpriteFont)
async function textFont() {
  const { png, json } = await unpack('Fonts/SpriteFont1.ru-RU.xnb');
  const c = json.content || json;
  const R = (r) => [r.x, r.y, r.width, r.height];
  const chars = c.characterMap, g = c.glyphs.map(R), cr = c.cropping.map(R), k = c.kerning, hsp = c.horizontalSpacing || 0;
  const hi = chars.indexOf('H'), [hx, hy, hw, hh] = g[hi];
  let bottom = 0;
  for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) if (alpha(png, hx + x, hy + y) > 127) bottom = y;
  const asc = cr[hi][1] + bottom + 1, line = c.verticalLineSpacing;
  const list = chars.map((ch, i) => {
    const code = typeof ch === 'string' ? ch.codePointAt(0) : ch;
    const [gx, gy, gw, gh] = g[i];
    const adv = Math.max(0, Math.round((k[i].x + k[i].y + k[i].z + hsp) * U));
    const p = code === 32 ? new opentype.Path() : glyphPath(png, gx, gy, gw, gh, k[i].x + cr[i][0], asc - cr[i][1], U);
    return new opentype.Glyph({ name: `uni${code.toString(16).toUpperCase().padStart(4, '0')}`, unicode: code, advanceWidth: adv, path: p });
  });
  return makeFont('Stardew RU', list, 26 * U, asc * U, -(line - asc) * U);
}

// Шрифт заголовков русской версии (BMFont)
async function titleFont() {
  const xml = await fs.readFile(path.join(C, 'Fonts/Russian.fnt'), 'utf8');
  const { png } = await unpack('Fonts/Russian_0.xnb');
  const num = (s, k) => Number(new RegExp(`\\b${k}="(-?\\d+)"`).exec(s)[1]);
  const common = /<common [^>]*>/.exec(xml)[0];
  const line = num(common, 'lineHeight'), base = num(common, 'base');
  const list = [];
  for (const m of xml.matchAll(/<char [^>]*>/g)) {
    const s = m[0], id = num(s, 'id');
    if (id < 32) continue;
    const p = id === 32 ? new opentype.Path() : glyphPath(png, num(s, 'x'), num(s, 'y'), num(s, 'width'), num(s, 'height'), num(s, 'xoffset'), base - num(s, 'yoffset'), U);
    list.push(new opentype.Glyph({ name: `uni${id.toString(16).toUpperCase().padStart(4, '0')}`, unicode: id, advanceWidth: num(s, 'xadvance') * U, path: p }));
  }
  return makeFont('Stardew RU Title', list, 13 * U, base * U, -(line - base) * U);
}

const cursors = (await unpack('LooseSprites/Cursors.ru-RU.xnb')).png;
const menu = (await unpack('Maps/MenuTiles.xnb')).png;
const img = {
  box: crop(cursors, 384, 373, 18, 18), // пергамент в тёмной раме
  light: crop(cursors, 293, 360, 24, 24), // светлая рамка — кнопки
  menu: crop(menu, 0, 256, 60, 60), // рамка меню
  ok: crop(cursors, 128, 256, 64, 64),
  no: crop(cursors, 192, 256, 64, 64),
  pano: whole((await unpack('LooseSprites/stardewPanorama.xnb')).png),
};
for (let i = 0; i < 5; i++) {
  img[`dog${i}`] = whole((await unpack(`Animals/dog${i || ''}.xnb`)).png);
  img[`cat${i}`] = whole((await unpack(`Animals/cat${i || ''}.xnb`)).png);
}
const pack = {
  format: 'uborka-pack',
  v: 1,
  source: 'Stardew Valley (личная копия)',
  fonts: { 'Stardew RU': await textFont(), 'Stardew RU Title': await titleFont() },
  img,
};
await fs.writeFile(OUT, JSON.stringify(pack));
console.log(`Готово: ${path.resolve(OUT)} (${Math.round((await fs.stat(OUT)).size / 1024)} КБ)`);
