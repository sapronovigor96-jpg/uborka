// Внешний вид: пиксельная тема и «пакет игры».
// Пакет — файл со шрифтами и картинками из своей копии Stardew Valley. Он хранится только на этом телефоне
// (IndexedDB), в репозиторий и на сайт не попадает. Без пакета тема рисуется своими средствами.
// Выбор темы и вид питомцев — тоже только для этого телефона (localStorage), у второго человека свои.

const SKIN = 'uborka.skin';
const LOOK = 'uborka.petlook';
const DB = 'uborka-pack';

export let pack = null; // { fonts: [...], img: [...] } — что загружено

const ls = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* приватный режим — просто не запомним */
    }
  },
};

export const skin = () => (ls.get(SKIN) === 'classic' ? 'classic' : 'pixel');

export function setSkin(v) {
  ls.set(SKIN, v);
  apply();
}

export function petLook() {
  try {
    return { dog: 0, cat: 0, ...JSON.parse(ls.get(LOOK) || '{}') };
  } catch {
    return { dog: 0, cat: 0 };
  }
}

export function setPetLook(kind, i) {
  ls.set(LOOK, JSON.stringify({ ...petLook(), [kind]: i }));
  apply();
}

const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;

export function apply() {
  const root = document.documentElement;
  const pixel = skin() === 'pixel';
  root.dataset.skin = skin();
  root.classList.toggle('has-pack', pixel && !!pack);
  if (pack) {
    const look = petLook();
    root.style.setProperty('--g-dog', `var(--g-dog${look.dog})`);
    root.style.setProperty('--g-cat', `var(--g-cat${look.cat})`);
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = !pixel ? '#1d1813' : dark() ? '#1f1a33' : '#9fd3f0';
}

matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', apply);

/* ---------- хранилище пакета ---------- */

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) return reject(new Error('no idb'));
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('files');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('files', mode);
      const req = fn(tx.objectStore('files'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}

const b64buf = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;

async function use(p) {
  if (!p || p.format !== 'uborka-pack' || !p.fonts || !p.img) throw new Error('not a pack');
  const fonts = [];
  for (const [name, data] of Object.entries(p.fonts)) {
    try {
      const face = new FontFace(name, b64buf(data), { display: 'block' });
      await face.load();
      document.fonts.add(face);
      fonts.push(name);
    } catch {
      /* телефон не принял шрифт — рамки и питомцы всё равно ставим */
    }
  }
  const root = document.documentElement;
  for (const [k, data] of Object.entries(p.img)) root.style.setProperty(`--g-${k}`, `url("data:image/png;base64,${data}")`);
  pack = { fonts, img: Object.keys(p.img) };
  apply();
}

// При запуске: поднять сохранённый пакет, если есть.
export async function loadPack() {
  try {
    const txt = await idb('readonly', (s) => s.get('pack'));
    if (txt) await use(JSON.parse(txt));
  } catch {
    /* нет пакета или он испорчен — работаем без него */
  }
}

export async function installPack(file) {
  const txt = await file.text();
  await use(JSON.parse(txt)); // сначала проверить, что файл правильный
  await idb('readwrite', (s) => s.put(txt, 'pack'));
}

export async function removePack() {
  await idb('readwrite', (s) => s.delete('pack'));
}

apply();
