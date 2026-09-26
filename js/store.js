// Хранение. Два режима:
// 1) Телефон (GitHub-версия): всё в localStorage этого устройства.
// 2) Внутри Claude (артефакт): общая база, которую видят все жильцы и Claude.
//    localStorage остаётся копией для быстрого старта и для незавершённой уборки.
//
// Общая база разложена так, чтобы двое могли отмечать дела одновременно, не затирая друг друга:
//   home/state      — настройки дома (комнаты, питомцы, свои дела, напоминания…), целиком
//   home/last       — { taskId: когда сделано } — каждое дело отдельным полем
//   log/<ГГГГ-ММ>   — { ключ записи: запись } — журнал по месяцам, записи отдельными полями
// Удалённое поле записывается как null.
import { normalize } from './logic.js';

const KEY = 'uborka.v1';
const SHARED = ['v', 'created', 'zonesOn', 'taskOff', 'every', 'household', 'merged', 'custom', 'when', 'remind', 'buddy', 'setup', 'pause', 'notes'];
const LOG_MONTHS = 3; // сколько месяцев журнала держать в памяти

export let persistent = true;
export let shared = false; // подключена общая база
export let me = null; // id того, кто смотрит (для отметки «кто сделал»)

const inClaude = () => typeof window !== 'undefined' && !!(window.claude && window.claude.use);
export const inArtifact = inClaude();

export function load(now) {
  try {
    const raw = localStorage.getItem(KEY);
    return normalize(raw ? JSON.parse(raw) : null, now);
  } catch {
    persistent = inArtifact; // в артефакте данные всё равно в общей базе
    return normalize(null, now);
  }
}

export function save(st) {
  try {
    localStorage.setItem(KEY, JSON.stringify(st));
    persistent = true;
  } catch {
    persistent = shared;
  }
  if (db) sync(st);
}

// Просим браузер не чистить данные при нехватке места.
export async function askPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch {
    /* не критично */
  }
}

/* ---------- общая база ---------- */

let db = null;
let synced = { state: '', last: '', logKeys: new Map() }; // logKeys: ключ записи → месяц
const chains = {}; // по одной записи за раз на документ
// Свои записи, ещё не подтверждённые базой: не даём чужому снимку их затереть.
const pendingLast = {};
const pendingLog = new Map();

// Сравнение без учёта порядка полей: база может вернуть их в другом порядке.
const stable = (v) =>
  Array.isArray(v) ? '[' + v.map(stable).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
  : JSON.stringify(v);
const pick = (st) => Object.fromEntries(SHARED.map((k) => [k, st[k] === undefined ? null : st[k]]));
const monthOf = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const recentMonths = (now) => {
  const out = [];
  const d = new Date(now);
  for (let i = 0; i < LOG_MONTHS; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
};
const entryKey = () => 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clean = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== null && v !== undefined));

function queue(path, fn) {
  chains[path] = (chains[path] || Promise.resolve()).then(fn).catch(() => {});
  return chains[path];
}

// Слить поля в документ: update, а если документа ещё нет — создать.
// Перед созданием перечитываем: вдруг его только что создал другой жилец — тогда update.
function merge(path, patch, done) {
  return queue(path, async () => {
    const ref = db.doc(path);
    try {
      await ref.update(patch);
    } catch (e) {
      if (!e || e.code !== 'invalid_argument') throw e;
      if ((await ref.get()).exists) await ref.update(patch);
      else await ref.set(clean(patch));
    }
  }).finally(done);
}

// Создать пустые документы заранее, чтобы первые отметки двух жильцов не столкнулись.
async function ensure(path) {
  const ref = db.doc(path);
  if (!(await ref.get()).exists) await queue(path, () => ref.set({}));
}

function sync(st) {
  // Настройки дома
  const stateObj = pick(st);
  const state = stable(stateObj);
  if (state !== synced.state) {
    synced.state = state;
    queue('home/state', () => db.doc('home/state').set(stateObj));
  }
  // Даты выполнения — только изменившиеся поля
  const prevLast = synced.last ? JSON.parse(synced.last) : {};
  const lastPatch = {};
  for (const [k, v] of Object.entries(st.last)) if (prevLast[k] !== v) lastPatch[k] = v;
  for (const k of Object.keys(prevLast)) if (!(k in st.last)) lastPatch[k] = null;
  if (Object.keys(lastPatch).length) {
    synced.last = JSON.stringify(st.last);
    Object.assign(pendingLast, lastPatch);
    merge('home/last', lastPatch, () => {
      for (const k of Object.keys(lastPatch)) if (pendingLast[k] === lastPatch[k]) delete pendingLast[k];
    });
  }
  // Журнал — новые записи и удалённые (отмена отметки)
  const byMonth = {};
  const keys = new Map();
  for (const e of st.log) {
    if (!e.k) {
      e.k = entryKey();
      if (me) e.by = me;
    }
    const m = monthOf(e.at);
    keys.set(e.k, m);
    if (!synced.logKeys.has(e.k)) (byMonth[m] ||= {})[e.k] = e;
  }
  for (const [k, m] of synced.logKeys) if (!keys.has(k)) (byMonth[m] ||= {})[k] = null;
  synced.logKeys = keys;
  for (const [m, patch] of Object.entries(byMonth)) {
    for (const [k, v] of Object.entries(patch)) pendingLog.set(k, v);
    merge('log/' + m, patch, () => {
      for (const k of Object.keys(patch)) pendingLog.delete(k);
    });
  }
}

// Подключиться к общей базе. st меняется на месте; onChange вызывается, когда пришли чужие изменения.
export async function connect(st, now, onChange) {
  if (!inClaude()) return false;
  try {
    db = await window.claude.use('db');
  } catch {
    db = null;
  }
  if (!db) return false;
  try {
    const user = await window.claude.use('user');
    me = user ? await user.id() : null;
  } catch {
    me = null;
  }

  await Promise.all(['home/last', ...recentMonths(now).slice(0, 1).map((m) => 'log/' + m)].map(ensure));
  const stateSnap = await db.doc('home/state').get();
  if (!stateSnap.exists) {
    // Первый запуск в общей базе: переносим то, что уже есть на этом устройстве.
    shared = true;
    synced = { state: '', last: '', logKeys: new Map() };
    if (st.setup) sync(st);
  } else {
    apply(st, 'state', stateSnap.data());
    apply(st, 'last', (await db.doc('home/last').get()).data() || {});
    const months = recentMonths(now);
    const logs = await Promise.all(months.map((m) => db.doc('log/' + m).get()));
    logs.forEach((s, i) => apply(st, 'log:' + months[i], s.data() || {}));
    shared = true;
    save(st);
  }

  // Живые изменения от других жильцов (и от Claude)
  db.doc('home/state').onSnapshot((s) => s.exists && !s.metadata.hasPendingWrites && apply(st, 'state', s.data()) && onChange());
  db.doc('home/last').onSnapshot((s) => s.exists && !s.metadata.hasPendingWrites && apply(st, 'last', s.data()) && onChange());
  for (const m of recentMonths(now)) {
    db.doc('log/' + m).onSnapshot((s) => s.exists && !s.metadata.hasPendingWrites && apply(st, 'log:' + m, s.data()) && onChange());
  }
  onChange();
  return true;
}

const logByMonth = {};

// Применить документ из базы к состоянию. Возвращает true, если что-то поменялось.
function apply(st, what, data) {
  if (what === 'state') {
    const json = stable(pick({ ...Object.fromEntries(SHARED.map((k) => [k, null])), ...data }));
    if (json === synced.state) return false;
    synced.state = json;
    Object.assign(st, normalize({ ...st, ...clean(data), v: 1 }, Date.now()), { last: st.last, log: st.log, session: st.session });
    return true;
  }
  if (what === 'last') {
    const next = clean({ ...data, ...pendingLast });
    if (stable(next) === stable(st.last)) return false;
    st.last = next;
    synced.last = JSON.stringify(next);
    return true;
  }
  const m = what.slice(4);
  logByMonth[m] = Object.entries(clean(data)).map(([k, e]) => ({ ...e, k }));
  // Свои неподтверждённые записи: новые добавить, удалённые не показывать.
  const seen = new Set();
  const all = Object.values(logByMonth)
    .flat()
    .filter((e) => (seen.add(e.k), pendingLog.get(e.k) !== null))
    .concat([...pendingLog].filter(([k, e]) => e && !seen.has(k)).map(([k, e]) => ({ ...e, k })))
    .sort((a, b) => a.at - b.at);
  const before = st.log.map((e) => e.k).join();
  st.log.splice(0, st.log.length, ...all);
  synced.logKeys = new Map(all.map((e) => [e.k, monthOf(e.at)]));
  return before !== all.map((e) => e.k).join();
}

export function database() {
  return db;
}

/* ---------- файлы ---------- */

// Скачать файл: внутри Claude — через разрешённый способ, на телефоне — обычной ссылкой.
export async function saveFile(filename, text, type) {
  if (inClaude()) {
    const dl = await window.claude.use('downloads').catch(() => null);
    if (dl) return dl.save({ filename, data: text });
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function exportFile(st) {
  return saveFile(`uborka-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(st, null, 1), 'application/json');
}

export function importFile(file, now) {
  return file.text().then((txt) => {
    const data = JSON.parse(txt);
    if (!data || data.v !== 1) throw new Error('Это не файл копии «Уборки»');
    return normalize(data, now);
  });
}
