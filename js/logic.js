// Чистая логика без DOM и хранилища — тестируется в node (tests/logic.test.mjs).
import { ZONES, TASKS } from './data.js';

export const DAY = 86400000;
export const DUE = 0.85; // с какой срочности задача считается «пора»
const LOG_CAP = 3000;

const zoneById = Object.fromEntries(ZONES.map((z) => [z.id, z]));
export const taskById = Object.fromEntries(TASKS.map((t) => [t.id, t]));

// Все дела: из базы + свои дела пользователя.
export function allTasks(st) {
  return st.custom && st.custom.length ? TASKS.concat(st.custom) : TASKS;
}

export function task(st, id) {
  return taskById[id] || (st.custom || []).find((t) => t.id === id);
}

export function initState(now) {
  return {
    v: 1,
    created: now,
    last: {},
    log: [],
    zonesOn: {},
    taskOff: {},
    every: {},
    household: { kids: false, allergy: false, dog: false, cat: false, dogName: '', catName: '' },
    merged: false, // кухня и гостиная — одна комната
    custom: [], // свои дела: { id, z, t, every, min, ord, own: true }
    when: {}, // перенос ежедневных мелочей: { taskId: 'morning' | 'evening' }
    remind: defaultRemind(),
    notes: [], // «что неудобно»: { id, at, text, ctx, done }
    setup: false, // знакомство с домом пройдено
    pause: null,
  };
}

// Разброс стартовых дат, чтобы в первый день ничего не «горело»: 0 … 0.75 интервала.
// Детерминирован по id: одинаковый при каждом запуске.
export function stagger(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 76) / 100;
}

export function hasPet(st) {
  return !!(st.household.dog || st.household.cat);
}

// Задача про питомца есть, только если этот питомец живёт дома.
function needMet(t, st) {
  if (!t.need) return true;
  const h = st.household;
  if (t.need === 'dog') return !!h.dog;
  if (t.need === 'cat') return !!h.cat;
  return hasPet(st);
}

// Кухня-гостиная: задачи гостиной живут в зоне кухни.
export function zoneOf(t, st) {
  return st.merged && t.z === 'living' ? 'kitchen' : t.z;
}

export function zoneOn(st, zoneId) {
  if (zoneId === 'living' && st.merged) return false;
  if (zoneId === 'pets' && !hasPet(st)) return false;
  const o = st.zonesOn[zoneId];
  return o === undefined ? zoneById[zoneId].on : o;
}

export function zoneLabel(st, zoneId) {
  if (zoneId === 'kitchen' && st.merged) return 'Кухня-гостиная';
  if (zoneId === 'pets') return petNames(st, 'Питомцы');
  return zoneById[zoneId].name;
}

export function zonesShown(st) {
  return ZONES.filter((z) => zoneOn(st, z.id)).sort((a, b) => a.order - b.order);
}

export function activeTasks(st) {
  return allTasks(st).filter((t) => needMet(t, st) && zoneOn(st, zoneOf(t, st)) && !st.taskOff[t.id]);
}

function petNames(st, fallback) {
  const h = st.household;
  const names = [h.dog && (h.dogName || '').trim(), h.cat && (h.catName || '').trim()].filter(Boolean);
  return names.length ? names.join(' и ') : fallback;
}

// Текст задачи с именами питомцев.
export function label(t, st, text = t.t) {
  const h = st.household;
  return text
    .replace('{dog}', (h.dogName || '').trim() || 'собаки')
    .replace('{cat}', (h.catName || '').trim() || 'кошки')
    .replace('{pets}', petNames(st, 'питомцев'));
}

// Частота с учётом домохозяйства. Ручная настройка пользователя важнее множителей.
export function effEvery(task, st) {
  const own = st.every[task.id];
  if (own) return own;
  const h = st.household;
  const pet = hasPet(st);
  const tags = task.tags || [];
  let e = task.every;
  if (tags.includes('floor') && (h.kids || pet)) e /= 2;
  if (tags.includes('dust') && h.allergy) e /= 2;
  if (tags.includes('linen') && (h.allergy || pet)) e /= 2;
  return Math.max(1, e);
}

export function lastDone(task, st) {
  const l = st.last[task.id];
  if (l !== undefined) return l;
  return st.created - stagger(task.id) * effEvery(task, st) * DAY;
}

// Что взять с собой. Явный kit у задачи важнее выведенного.
export function kitFor(t) {
  if (t.kit) return t.kit;
  const tags = t.tags || [];
  const out = [];
  if (/стирк/i.test(t.t)) out.push('Корзина для белья');
  if (/зеркал|окна|стёкл/i.test(t.t)) out.push('Стеклоочиститель и синяя тряпка');
  if (tags.includes('dust')) out.push('Сухая микрофибра');
  if (tags.includes('floor')) out.push('Пылесос', 'Швабра и ведро');
  if (!out.length && t.z === 'bath') out.push('Перчатки', 'Жёлтая тряпка');
  if (!out.length && t.z === 'kitchen' && !/посуд|мусор|губк/i.test(t.t)) out.push('Зелёная тряпка');
  return out;
}

export function sessionKit(steps, st) {
  const seen = new Set();
  for (const s of steps) for (const k of kitFor(task(st, s.id))) seen.add(k);
  return [...seen];
}

// Время «стоит» во время отпуска.
function clock(st, now) {
  return st.pause ?? now;
}

// 0 — только что сделано, 1 — ровно пора, 2 — прошло два интервала.
export function urgency(task, st, now) {
  return (clock(st, now) - lastDone(task, st)) / (effEvery(task, st) * DAY);
}

// Свежесть дела 0…1: полная, пока до срока далеко (u ≤ 0.5), половина — ровно в срок,
// ноль — когда просрочено на полинтервала.
export function freshness(t, st, now) {
  return Math.max(0, Math.min(1, 1.5 - urgency(t, st, now)));
}

function avgFresh(ts, st, now) {
  if (!ts.length) return 1;
  return ts.reduce((s, t) => s + freshness(t, st, now), 0) / ts.length;
}

// Чистота комнаты 0…1 — средняя свежесть её дел.
export function zoneHealth(st, zoneId, now) {
  return avgFresh(activeTasks(st).filter((t) => zoneOf(t, st) === zoneId), st, now);
}

export function homeHealth(st, now) {
  return avgFresh(activeTasks(st), st, now);
}

// Приоритет срочности ограничен: ежедневная посуда за 20 дней — не в 20 раз важнее
// недельного унитаза за 20 дней. При равенстве — короткие задачи вперёд, их влезает больше.
// Гигиена (посуда, мусор, унитаз…) при просрочке идёт впереди остального.
export const URG_CAP = 2;
const HYG_BONUS = 0.5;

// soon — своё дело с отметкой «нужно уже сейчас»: первое в очереди, пока не сделано.
export function priority(t, u) {
  if (t.soon) return URG_CAP + HYG_BONUS + 1;
  return Math.min(u, URG_CAP) + ((t.tags || []).includes('hyg') && u >= DUE ? HYG_BONUS : 0);
}

export function dueTasks(st, now, minUrg = DUE) {
  return activeTasks(st)
    .map((t) => ({ t, u: urgency(t, st, now) }))
    .filter((x) => x.u >= minUrg)
    .sort((a, b) => priority(b.t, b.u) - priority(a.t, a.u) || a.t.min - b.t.min);
}

// Сессия под бюджет минут.
// 1) Берём самые срочные задачи, пока влезают в бюджет (подготовка = +1 мин).
// 2) Порядок профи: сначала все подготовки (средство действует, пока делаешь остальное),
//    потом зоны от дальней к выходу, внутри — сверху вниз; пол — одной волной в конце.
// 3) Если срочное кончилось, а время осталось — добираем то, что скоро станет срочным (u ≥ AHEAD).
export const AHEAD = 0.6;

// 4) Меньше беготни: дела в комнатах, где уже будем, получают бонус SAME_ROOM —
//    на коротких уборках это держит человека в 1–2 комнатах.
const SAME_ROOM = 0.35;

// zone — уборка только одной комнаты.
export function buildSession(st, now, budget, minUrg = DUE, zone = null) {
  const pool = dueTasks(st, now, Math.min(minUrg, AHEAD)).filter((x) => !zone || zoneOf(x.t, st) === zone);
  const picked = [];
  const rooms = new Set();
  let used = 0;
  for (;;) {
    let best = null;
    let bestScore = -Infinity;
    for (const x of pool) {
      const cost = x.t.min + (x.t.prep ? 1 : 0);
      if (used + cost > budget) continue;
      const score = priority(x.t, x.u) + (rooms.has(zoneOf(x.t, st)) ? SAME_ROOM : 0);
      if (score > bestScore) {
        best = x;
        bestScore = score;
      }
    }
    if (!best) break;
    pool.splice(pool.indexOf(best), 1);
    picked.push(best.t);
    rooms.add(zoneOf(best.t, st));
    used += best.t.min + (best.t.prep ? 1 : 0);
  }
  return orderSteps(picked, st);
}

export function orderSteps(tasks, st) {
  const zo = (t) => zoneById[zoneOf(t, st)].order;
  const step = (kind, t) => ({ kind, id: t.id, zone: zoneOf(t, st), text: label(t, st, kind === 'prep' ? t.prep : t.t), min: kind === 'prep' ? 1 : t.min });
  const isFloor = (t) => (t.tags || []).includes('floor');
  const preps = tasks
    .filter((t) => t.prep)
    .sort((a, b) => b.wait - a.wait)
    .map((t) => step('prep', t));
  const main = tasks
    .filter((t) => !isFloor(t))
    .sort((a, b) => zo(a) - zo(b) || a.ord - b.ord)
    .map((t) => step('task', t));
  const floor = tasks
    .filter(isFloor)
    .sort((a, b) => zo(a) - zo(b))
    .map((t) => step('task', t));
  return [...preps, ...main, ...floor];
}

export function sessionMinutes(steps) {
  return steps.reduce((s, x) => s + x.min, 0);
}

export function complete(st, taskId, now, min) {
  st.last[taskId] = clock(st, now);
  const own = (st.custom || []).find((x) => x.id === taskId);
  if (own) own.soon = false;
  st.log.push({ id: taskId, at: now, min });
  if (st.log.length > LOG_CAP) st.log.splice(0, st.log.length - LOG_CAP);
}

// Отменить последнюю отметку задачи (ошибочное нажатие).
export function undoComplete(st, taskId, prevLast) {
  for (let i = st.log.length - 1; i >= 0; i--) {
    if (st.log[i].id === taskId) {
      st.log.splice(i, 1);
      break;
    }
  }
  if (prevLast === undefined) delete st.last[taskId];
  else st.last[taskId] = prevLast;
}

export function setZone(st, zoneId, on, now) {
  st.zonesOn[zoneId] = on;
  if (on) seedMissing(st, now, (t) => zoneOf(t, st) === zoneId);
}

// Новые задачи (включили зону, завели питомца) стартуют «с разбросом» от сегодняшнего дня,
// а не от даты установки — иначе они появятся сразу просроченными.
export function seedMissing(st, now, pred = () => true) {
  for (const t of activeTasks(st)) {
    if (pred(t) && st.last[t.id] === undefined && urgency(t, st, now) > 0.75) {
      st.last[t.id] = clock(st, now) - stagger(t.id) * effEvery(t, st) * DAY;
    }
  }
}

// Знакомство с домом: насколько давно была большая уборка.
// 0 — недавно, 1 — неделю-две назад, 2 — давно. Сдвигает стартовые даты всех задач.
export function startFrom(st, now, ago) {
  st.last = {};
  st.created = now - [0, 3, 8][ago] * DAY;
  st.setup = true;
}

export function startPause(st, now) {
  if (st.pause === null) st.pause = now;
}

// Отпуск сдвигает все даты на свою длину — ничего не «накапливается» за время отсутствия.
export function endPause(st, now) {
  if (st.pause === null) return;
  const shift = now - st.pause;
  for (const k of Object.keys(st.last)) st.last[k] += shift;
  st.created += shift;
  st.pause = null;
}

export function stats(st, now, days = 7) {
  const from = now - days * DAY;
  const recent = st.log.filter((e) => e.at >= from);
  return {
    tasks: recent.length,
    minutes: Math.round(recent.reduce((s, e) => s + (e.min || 0), 0)),
    days: new Set(recent.map((e) => new Date(e.at).toDateString())).size,
  };
}

// Миграция/починка загруженного состояния: недостающие поля — по умолчанию.
export function normalize(raw, now) {
  const base = initState(now);
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return base;
  return {
    ...base,
    ...raw,
    household: { ...base.household, ...(raw.household || {}) },
    setup: raw.setup ?? true, // у старых данных знакомство считаем пройденным
    merged: !!raw.merged,
    custom: Array.isArray(raw.custom) ? raw.custom : [],
    when: raw.when || {},
    remind: { ...defaultRemind(), ...(raw.remind || {}) },
    notes: Array.isArray(raw.notes) ? raw.notes : [],
    last: raw.last || {},
    log: Array.isArray(raw.log) ? raw.log : [],
    zonesOn: raw.zonesOn || {},
    taskOff: raw.taskOff || {},
    every: raw.every || {},
  };
}

export function fmtAgo(ms) {
  const d = Math.floor(ms / DAY);
  if (d <= 0) return 'сегодня';
  if (d === 1) return 'вчера';
  return `${d} ${plural(d, 'день', 'дня', 'дней')} назад`;
}

export function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export function fmtEvery(days) {
  if (days <= 1) return 'каждый день';
  if (days === 7) return 'раз в неделю';
  if (days === 14) return 'раз в 2 недели';
  if (days === 365) return 'раз в год';
  if (days >= 45 || days % 30 === 0) {
    const m = Math.round(days / 30);
    return m === 1 ? 'раз в месяц' : `раз в ${m} ${plural(m, 'месяц', 'месяца', 'месяцев')}`;
  }
  const r = Math.round(days);
  return `раз в ${r} ${plural(r, 'день', 'дня', 'дней')}`;
}

// ---------- свои дела ----------

// soon — «нужно уже сейчас»: дело сразу попадает в ближайшую уборку.
// Иначе стартует с середины интервала, чтобы не висело сразу, но и не забылось.
export function addCustom(st, now, { z, t, every, min, soon }) {
  const id = 'u-' + now.toString(36);
  st.custom.push({ id, z, t: t.trim(), every, min, ord: 5, own: true, soon: !!soon });
  st.last[id] = clock(st, now) - (soon ? every : every / 2) * DAY;
  return id;
}

export function editCustom(st, id, { z, t, every, min }) {
  const c = st.custom.find((x) => x.id === id);
  if (!c) return;
  Object.assign(c, { z, t: t.trim(), every, min });
  delete st.every[id]; // частота теперь задана в самом деле
}

export function removeCustom(st, id) {
  st.custom = st.custom.filter((x) => x.id !== id);
  delete st.last[id];
  delete st.every[id];
  delete st.taskOff[id];
}

// ---------- распорядок: утренние и вечерние мелочи ----------

export function whenOf(t, st) {
  return st.when[t.id] || t.when || 'evening';
}

export function dailyTasks(st) {
  return activeTasks(st).filter((t) => effEvery(t, st) <= 1);
}

export function sameDay(a, b) {
  return a !== undefined && new Date(a).toDateString() === new Date(b).toDateString();
}

export function ritual(st, which) {
  return dailyTasks(st).filter((t) => whenOf(t, st) === which);
}

// Шаги ритуала — только то, что сегодня ещё не сделано, в порядке профи.
export function ritualSteps(st, which, now) {
  return orderSteps(ritual(st, which).filter((t) => !sameDay(st.last[t.id], now)), st).filter((x) => x.kind === 'task');
}

// Какой ритуал сейчас уместнее: до 14:00 — утро, потом — вечер.
export function currentRitual(now) {
  return new Date(now).getHours() < 14 ? 'morning' : 'evening';
}

// ---------- напоминания: файл для календаря телефона ----------

export function defaultRemind() {
  return {
    morning: { on: true, time: '08:30' },
    evening: { on: true, time: '21:00' },
    weekly: { on: true, day: 5, time: '11:00' }, // day: 0 — понедельник … 6 — воскресенье
  };
}

const BYDAY = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
export const WEEKDAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];

const pad = (n) => String(n).padStart(2, '0');

function icsText(v) {
  return v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

// Строки длиннее 75 байт по стандарту переносятся с пробелом в начале продолжения.
function fold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (enc.encode(cur + ch).length > 73) {
      out.push(cur);
      cur = ' ' + ch;
    } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}

// Ближайшая дата (сегодня или позже) с нужным днём недели; для ежедневных — сегодня.
function firstDate(now, weekday) {
  const d = new Date(now);
  if (weekday !== undefined) {
    const cur = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() + ((weekday - cur + 7) % 7));
  }
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

export function reminderEvents(st, now) {
  const r = st.remind;
  const names = (which) => ritual(st, which).map((t) => '· ' + label(t, st)).join('\n');
  const ev = [];
  if (r.morning.on && ritual(st, 'morning').length)
    ev.push({ id: 'morning', time: r.morning.time, rule: 'FREQ=DAILY', title: 'Утренние мелочи — пара минут для дома', text: names('morning') });
  if (r.evening.on && ritual(st, 'evening').length)
    ev.push({ id: 'evening', time: r.evening.time, rule: 'FREQ=DAILY', title: 'Вечерние мелочи — хотя бы 5 минут', text: names('evening') });
  if (r.weekly.on)
    ev.push({
      id: 'weekly', time: r.weekly.time, day: r.weekly.day, rule: `FREQ=WEEKLY;BYDAY=${BYDAY[r.weekly.day]}`,
      title: 'Забота о доме — 30 минут', text: 'Спокойная уборка по списку в приложении. Можно меньше — любой шаг считается.',
    });
  return ev;
}

// Календарь с повторяющимися событиями и напоминанием в момент начала.
// UID постоянные: повторный импорт обновляет события, а не дублирует (где календарь это умеет).
export function makeIcs(st, now, url = '') {
  const d = new Date(now);
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Uborka//RU', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Уборка'];
  for (const e of reminderEvents(st, now)) {
    const [hh, mm] = e.time.split(':');
    const desc = e.text + (url ? `\n\nОткрыть приложение: ${url}` : '');
    lines.push(
      'BEGIN:VEVENT',
      `UID:uborka-${e.id}@uborka.app`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${firstDate(now, e.day)}T${hh}${mm}00`,
      'DURATION:PT15M',
      `RRULE:${e.rule}`,
      `SUMMARY:${icsText(e.title)}`,
      `DESCRIPTION:${icsText(desc)}`,
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${icsText(e.title)}`,
      'TRIGGER:PT0M',
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ---------- заметки «что неудобно» ----------

export function addNote(st, now, text, ctx) {
  const t = text.trim();
  if (!t) return null;
  const id = 'n-' + now.toString(36);
  st.notes.push({ id, at: now, text: t, ctx: ctx || '', done: false });
  return id;
}

// Текст всех открытых заметок — чтобы скопировать и отправить разработчику.
export function notesText(st) {
  const open = st.notes.filter((n) => !n.done);
  return open
    .map((n) => {
      const d = new Date(n.at);
      return `— ${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}${n.ctx ? ` [${n.ctx}]` : ''}: ${n.text}`;
    })
    .join('\n');
}
