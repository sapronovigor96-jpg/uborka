import * as L from './logic.js';
import * as S from './store.js';

const $ = (sel) => document.querySelector(sel);
const view = $('#view');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const now = () => Date.now();
const dela = (n) => `${n} ${L.plural(n, 'дело', 'дела', 'дел')}`;

let st = S.load(now());
let tab = 'now';
let openZones = new Set();
let tick = null;
let wakeLock = null;
let setupStep = 0;
let ritualView = null; // какой ритуал показан: null — по времени суток
let ritualOpen = false; // развернуть уже сделанный ритуал
let restMore = false;
let armed = null; // кнопка, ждущая второго нажатия (опасные действия — в два касания)
let armTimer = null;

function arm(name) {
  if (armed === name) {
    armed = null;
    clearTimeout(armTimer);
    return true;
  }
  armed = name;
  clearTimeout(armTimer);
  armTimer = setTimeout(() => {
    armed = null;
    if (tab === 'settings') render();
  }, 4000);
  return false;
} // вечер сделан, но хочется ещё — показать выбор времени
const RITUAL = { morning: 'Утренние мелочи', evening: 'Вечерние мелочи' };
let cheer = ''; // похвала после шага — только в памяти, чтобы не повторялась после перезагрузки
const LIT = 0.7; // с какой чистоты окно комнаты горит в полную силу

function commit() {
  S.save(st);
}

const zname = (id) => L.zoneLabel(st, id);
const tname = (t) => L.label(t, st);

/* ---------- общие кусочки ---------- */

function level(h) {
  return h >= LIT ? '' : h >= 0.4 ? 'mid' : 'low';
}

function dotClass(u) {
  return u >= L.DUE ? 'due' : u >= 0.5 ? 'mid' : '';
}

function taskMeta(t) {
  // Дата показывается только для реально отмеченных дел — стартовые даты условные.
  const marked = st.last[t.id] !== undefined && st.log.some((e) => e.id === t.id);
  const ago = marked ? L.fmtAgo((st.pause ?? now()) - st.last[t.id]) + ' · ' : '';
  return `${ago}${L.fmtEvery(L.effEvery(t, st))} · ${t.min} мин`;
}

// Домик: каждое окно — комната. Чем чище комната, тем теплее горит свет.
function house(zones, glowZones = []) {
  const cols = 3;
  const rows = Math.ceil(zones.length / cols);
  const W = 30, H = 26, GX = 12, GY = 12;
  const bodyH = rows * H + (rows - 1) * GY + 30;
  const top = 78;
  const x0 = 100 - (cols * W + (cols - 1) * GX) / 2;
  const t = now();
  const wins = zones
    .map((z, i) => {
      const h = L.zoneHealth(st, z.id, t);
      const x = x0 + (i % cols) * (W + GX);
      const y = top + 15 + Math.floor(i / cols) * (H + GY);
      const glow = Math.min(1, 0.1 + 0.9 * Math.pow(h / LIT, 1.3));
      return `<g class="win ${glowZones.includes(z.id) ? 'fresh' : ''}" data-act="go-zone" data-z="${z.id}">
        <title>${esc(zname(z.id))}</title>
        <rect x="${x}" y="${y}" width="${W}" height="${H}" rx="3" class="win-dark"/>
        <rect x="${x}" y="${y}" width="${W}" height="${H}" rx="3" class="win-lit" style="opacity:${glow}" ${glow === 1 ? 'filter="url(#glow)"' : ''}/>
        <path d="M${x + W / 2} ${y}v${H}M${x} ${y + H / 2}h${W}" class="win-frame"/>
      </g>`;
    })
    .join('');
  const bottom = top + bodyH;
  return `<svg class="house" viewBox="0 0 200 ${bottom + 8}" role="img" aria-label="Дом: окна — комнаты">
    <defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    <path d="M140 44v-22h14v32" class="chimney"/>
    <path class="smoke" d="M147 16c-5-5 5-8 0-13"/>
    <path d="M22 ${top + 2}L100 22L178 ${top + 2}Z" class="roof"/>
    <rect x="34" y="${top}" width="132" height="${bodyH}" rx="4" class="body"/>
    ${wins}
    <path d="M26 ${bottom}h148" class="ground"/>
  </svg>`;
}

function toast(text, undo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(text)}</span>${undo ? '<button data-act="undo">Вернуть</button>' : ''}`;
  // Во время уборки внизу — кнопка «Готово», сообщение не должно её закрывать.
  el.classList.toggle('top', !$('#session').hidden || !$('#sheet').hidden);
  el.hidden = false;
  toast.undo = undo;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => {
    el.hidden = true;
    toast.undo = null;
  }, 5000);
}

function buzz(ms = 20) {
  try {
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    navigator.vibrate && navigator.vibrate(ms);
  } catch {
    /* нет вибро — не страшно */
  }
}

/* ---------- домовёнок ---------- */

const buddyName = () => (st.buddy || '').trim() || 'Тишка';
const FINISH_LINES = ['Вот это да! Стало светлее.', 'Спасибо! Мне тут так уютно.', 'Красота. Отдыхайте, я присмотрю.'];

// Домовёнок: пушистый, в шапке-чёлке. Настроения: calm, happy, sleepy, cheer.
// Настроения: calm — обычный, happy — дома уютно, cheer — только что сделали дело (прыгает, руки вверх),
// sad — давно не убирались (скучает, не упрекает), sleepy — пауза.
function mascot(mood = 'calm') {
  const open = '<circle cx="25" cy="39" r="2.8" class="ink"/><circle cx="39" cy="39" r="2.8" class="ink"/><circle cx="26" cy="38" r=".9" class="shine"/><circle cx="40" cy="38" r=".9" class="shine"/>';
  const eyes = {
    calm: open,
    sad: open + '<path d="M21 35l6-2.5M43 35l-6-2.5" class="line thin"/>',
    happy: '<path d="M22 40q3-4 6 0M36 40q3-4 6 0" class="line"/>',
    cheer: '<path d="M22 40q3-4 6 0M36 40q3-4 6 0" class="line"/>',
    sleepy: '<path d="M22 40h6M36 40h6" class="line"/>',
  }[mood];
  const mouth = {
    calm: '<path d="M29 46q3 2 6 0" class="line"/>',
    happy: '<path d="M28 45q4 5 8 0" class="line"/>',
    cheer: '<path d="M28 44q4 7 8 0z" class="ink"/>',
    sleepy: '<circle cx="32" cy="47" r="1.4" class="ink"/>',
    sad: '<path d="M29 48q3-2 6 0" class="line"/>',
  }[mood];
  const arms = mood === 'cheer' ? '<path d="M12 40l-6-9M52 40l6-9" class="arm"/>' : '<path d="M12 44l-4 4M52 44l4 4" class="arm"/>';
  return `<svg class="mascot ${mood}" viewBox="0 0 64 64" aria-hidden="true">
    ${arms}
    <ellipse cx="24" cy="58" rx="6" ry="3" class="hair"/><ellipse cx="40" cy="58" rx="6" ry="3" class="hair"/>
    <ellipse cx="32" cy="40" rx="21" ry="19" class="body"/>
    <path d="M11 37C10 17 54 17 53 37C48 29 42 33 37 27C33 32 27 29 25 25C21 31 16 29 11 37Z" class="hair"/>
    <path d="M30 17q2-7 6-5" class="tuft"/>
    <circle cx="19" cy="46" r="3.2" class="cheek"/><circle cx="45" cy="46" r="3.2" class="cheek"/>
    <g class="eyes">${eyes}</g>${mouth}
  </svg>`;
}

function say(text, mood = 'calm') {
  return `<div class="buddy">${mascot(mood)}<div class="bubble"><b>${esc(buddyName())}</b>${esc(text)}</div></div>`;
}

/* ---------- знакомство с домом ---------- */

const ROOMS = [
  ['bedroom', 'Спальня'],
  ['living', 'Гостиная'],
  ['kitchen', 'Кухня'],
  ['bath', 'Ванная'],
  ['hall', 'Прихожая'],
  ['balcony', 'Балкон'],
  ['kids', 'Детская'],
  ['work', 'Рабочее место'],
];

function roomOn(id) {
  const o = st.zonesOn[id];
  return o === undefined ? L.zoneOn({ ...st, merged: false }, id) : o;
}

function petFields() {
  const h = st.household;
  return `<div class="row"><div>Собака</div>${sw('pet', h.dog, 'data-k="dog"')}</div>
    ${h.dog ? `<input class="field" data-act="petname" data-k="dogName" placeholder="Имя" value="${esc(h.dogName)}" maxlength="20">` : ''}
    <div class="row"><div>Кошка или кот</div>${sw('pet', h.cat, 'data-k="cat"')}</div>
    ${h.cat ? `<input class="field" data-act="petname" data-k="catName" placeholder="Имя" value="${esc(h.catName)}" maxlength="20">` : ''}`;
}

function renderSetup() {
  const el = $('#setup');
  el.hidden = false;
  const h = st.household;
  const steps = [
    () => `<div class="s-kind">Знакомство · 1 из 3</div>
      <h1>Какие комнаты есть дома?</h1>
      <p class="mut">Отметьте всё, где хочется поддерживать уют.</p>
      <div class="chips big">${ROOMS.filter(([id]) => !(st.merged && id === 'living'))
        .map(([id, n]) => `<button class="chip ${roomOn(id) ? 'on' : ''}" data-act="room" data-z="${id}">${id === 'kitchen' && st.merged ? 'Кухня-гостиная' : n}</button>`)
        .join('')}</div>
      <div class="card" style="margin-top:18px"><div class="row"><div>Кухня и гостиная — одна комната<small>Будут одним окном в домике</small></div>${sw('merged', st.merged)}</div></div>
      ${S.inArtifact ? '' : '<button class="btn wide ghost" style="margin-top:14px" data-act="pair-open">У нас уже есть общий дом — подключиться</button>'}`,
    () => `<div class="s-kind">Знакомство · 2 из 3</div>
      <h1>Кто живёт с вами?</h1>
      <p class="mut">От этого зависит, как часто нужен пол, стирка и что ещё добавить.</p>
      <div class="card">${petFields()}
        <div class="row"><div>Дети</div>${sw('hh', h.kids, 'data-k="kids"')}</div>
        <div class="row"><div>Аллергия на пыль</div>${sw('hh', h.allergy, 'data-k="allergy"')}</div></div>`,
    () => `<div class="s-kind">Знакомство · 3 из 3</div>
      <h1>Когда в последний раз была большая уборка?</h1>
      <p class="mut">Честный ответ поможет не завалить делами в первый день.</p>
      <div class="stack">
        <button class="btn wide opt" data-act="ago" data-v="0">Недавно — дома порядок</button>
        <button class="btn wide opt" data-act="ago" data-v="1">Неделю-две назад</button>
        <button class="btn wide opt" data-act="ago" data-v="2">Давно — кое-что накопилось</button>
        ${st.log.length ? '<button class="btn wide ghost" data-act="setup-keep">Оставить мои отметки как есть</button>' : ''}
      </div>`,
  ];
  el.innerHTML = `<div class="inner">
    <div class="s-body setup-body">${steps[setupStep]()}</div>
    <div class="s-actions">
      ${setupStep < 2 ? `<button class="btn primary" data-act="setup-next">Дальше</button>` : ''}
      ${setupStep > 0 ? `<button class="btn ghost" data-act="setup-back">Назад</button>` : ''}
    </div></div>`;
}

/* ---------- вкладка «Сейчас» ---------- */

const BUDGETS = [
  [15, 'Немного заботы'],
  [30, 'Спокойная уборка'],
  [60, 'Большая забота'],
];
const AWAY_DAYS = 3; // после стольких дней без отметок — встречаем «с возвращением»

function greeting() {
  const hr = new Date().getHours();
  return hr < 6 ? 'Доброй ночи' : hr < 12 ? 'Доброе утро' : hr < 18 ? 'Добрый день' : 'Добрый вечер';
}

function weekDots() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toDateString();
    const on = st.log.some((e) => new Date(e.at).toDateString() === key);
    days.push(`<i class="${on ? 'on' : ''}" title="${d.toLocaleDateString('ru', { weekday: 'short' })}"></i>`);
  }
  return `<div class="week">${days.join('')}</div>`;
}

function ritualNowFor(t, rLeft) {
  return !ritualView && rLeft.length ? L.currentRitual(t) : null;
}

// Сделано ли дело сегодня — по журналу (стартовые даты не считаются).
function doneToday(id) {
  const t = now();
  return st.log.some((e) => e.id === id && L.sameDay(e.at, t));
}

function renderNow() {
  const t = now();
  const zones = L.zonesShown(st);
  const lit = zones.filter((z) => L.zoneHealth(st, z.id, t) >= LIT).length;
  const h = L.homeHealth(st, t);
  const active = L.activeTasks(st);
  const which = ritualView || L.currentRitual(t);
  const other = which === 'morning' ? 'evening' : 'morning';
  const rList = L.ritual(st, which);
  const rDone = rList.filter((x) => doneToday(x.id)).length;
  const rLeft = L.ritualSteps(st, which, t);
  const oList = L.ritual(st, other);
  const oDone = oList.filter((x) => doneToday(x.id)).length;
  const due = L.dueTasks(st, t).filter((x) => L.effEvery(x.t, st) > 1);
  const wk = L.stats(st, t);
  const lastAct = st.log.length ? Math.max(...st.log.map((e) => e.at)) : null;
  const back = lastAct !== null && t - lastAct >= AWAY_DAYS * L.DAY && st.pause === null;
  const title = back
    ? 'С возвращением'
    : (new Date(t).getHours() >= 18 || new Date(t).getHours() < L.DAY_START_H) && L.ritual(st, 'evening').length > 0 && L.ritualSteps(st, 'evening', t).length === 0
      ? 'На сегодня хватит'
    : h >= 0.85 ? 'Дома уютно' : h >= 0.65 ? 'Дому нужно чуть-чуть заботы' : h >= 0.45 ? 'Дом соскучился по вам' : 'Зажжём одно окошко?';
  const small = L.buildSession(st, t, 5).filter((x) => x.kind === 'task').length;
  const hour = new Date(t).getHours();
  const eveningDone = (hour >= 18 || hour < L.DAY_START_H) && L.ritual(st, 'evening').length > 0 && L.ritualSteps(st, 'evening', t).length === 0;
  const morningDone = hour >= L.DAY_START_H && hour < 14 && L.ritual(st, 'morning').length > 0 && L.ritualSteps(st, 'morning', t).length === 0;
  const few = (n) => (n <= 3 ? 'Пара мелочей' : 'Несколько мелочей');
  const buddyLine = eveningDone
    ? ['Вечер сделан. Отдыхайте — я присмотрю.', 'happy']
    : back
    ? ['Я скучал! Начнём с малого — вместе веселее.', 'sad']
    : ritualNowFor(t, rLeft) === 'morning' ? [`Доброе утро! ${few(rLeft.length)} — и день пойдёт легче.`, 'happy']
    : ritualNowFor(t, rLeft) === 'evening' ? [`Вечер. ${few(rLeft.length)} — и можно отдыхать. Начнём с первой.`, 'calm']
    : morningDone ? ['Утро сделано — хорошее начало дня.', 'happy']
    : h >= 0.85 ? ['Как хорошо у нас. Можно просто отдохнуть.', 'happy']
    : h < 0.45 ? ['Что-то я загрустил. Зажжём хотя бы одно окошко?', 'sad']
    : ['Одно маленькое дело — и в доме станет светлее.', 'calm'];
  // Главная кнопка: сначала ежедневный ритуал этого времени суток, если он не сделан.
  const ritualNow = !ritualView && rLeft.length ? L.currentRitual(t) : null;
  const mainBtn = eveningDone
    ? (restMore ? '' : `<button class="btn ghost wide" style="margin-top:14px" data-act="rest-more">Если хочется ещё</button>`)
    : ritualNow
    ? `<button class="btn primary wide start-small" data-act="ritual" data-w="${ritualNow}">${RITUAL[ritualNow]}<small>${dela(rLeft.length)} · по шагам</small></button>`
    : small
      ? `<button class="btn primary wide start-small" data-act="start" data-b="5">Начать с малого<small>5 минут · ${dela(small)}</small></button>`
      : '';

  const budgets = BUDGETS.map(([b, name]) => {
    const n = L.buildSession(st, t, b).filter((s) => s.kind === 'task').length;
    return `<button class="budget" data-act="start" data-b="${b}" ${n ? '' : 'disabled'}>
      <b>${b} мин</b><em>${name}</em><span>${n ? dela(n) : 'всё сделано'}</span></button>`;
  }).join('');

  view.innerHTML = `
    ${st.pause !== null ? `<div class="card pause-banner"><div><b>Вы в отпуске</b><div class="small mut">Дом подождёт, сроки не идут</div></div>
      <button class="btn" data-act="pause-off">Я дома</button></div>` : ''}
    ${S.persistent ? '' : '<div class="card s-warn">Браузер не даёт сохранять данные — после закрытия всё сбросится.</div>'}
    <div class="hello mut">${greeting()}</div>
    <div class="hero">
      ${house(zones)}
      <h1>${title}</h1>
      <div class="mut small">${back ? 'Ничего не потеряно — начнём с малого' : `Свет горит в ${lit} из ${zones.length} ${L.plural(zones.length, 'комнаты', 'комнат', 'комнат')}`}</div>
    </div>
    ${say(...buddyLine)}
    ${mainBtn}

    ${eveningDone && !restMore ? '' : `
    <div class="sec-title">${ritualNow ? 'Или уборка на время' : eveningDone ? 'Сколько есть времени?' : 'Есть больше времени?'}</div>
    <div class="budgets three">${budgets}</div>
    ${L.buildSession(st, t, 60).length === 0 ? `<button class="btn wide ghost" style="margin-top:10px" data-act="start-ahead">Сделать что-нибудь заранее · 15 мин</button>` : ''}
    <div class="rooms-pick"><span class="mut small">Или одна комната:</span>
      <div class="chips">${zones
        .filter((z) => z.id !== 'home')
        .map((z) => {
          const n = L.dueTasks(st, t).filter((x) => L.zoneOf(x.t, st) === z.id).length;
          return `<button class="chip" data-act="room-sheet" data-z="${z.id}">${esc(zname(z.id))}${n ? '<i class="chip-dot"></i>' : ''}</button>`;
        })
        .join('')}</div></div>`}

    ${rList.length || oList.length ? `<div class="sec-title">${RITUAL[which]} <span class="count">${rDone} из ${rList.length}</span></div>
    <div class="card">
    ${rLeft.length && !ritualNow ? `<button class="btn wide ritual-go" data-act="ritual" data-w="${which}">Пройти по шагам · ${dela(rLeft.length)}</button>` : ''}
    ${rList.length && !rLeft.length ? `<button class="ok-note ritual-done" data-act="ritual-open">✓ ${which === 'morning' ? 'Утро сделано' : 'Вечер сделан'} · ${rDone} из ${rList.length} <span class="dim">${ritualOpen ? 'свернуть' : 'показать'}</span></button>` : ''}
    <ul class="tl daily" ${rList.length && !rLeft.length && !ritualOpen ? 'hidden' : ''}>${rList
      .map((x) => {
        const done = doneToday(x.id);
        return `<li class="${done ? 'is-done' : ''}"><button class="check ${done ? 'done' : ''}" data-act="${done ? 'undo-today' : 'done'}" data-id="${x.id}" aria-label="Сделано">✓</button>
          <button class="tt" data-act="task" data-id="${x.id}">${esc(tname(x))}<small>${esc(zname(L.zoneOf(x, st)))} · ${x.min} мин${whoTag(x)}</small></button></li>`;
      })
      .join('')}</ul>
      ${oList.length ? `<button class="more" data-act="ritual-switch" data-w="${other}">${eveningDone && other === 'morning' ? 'Утренние мелочи — завтра →' : `${RITUAL[other]}: ${oDone} из ${oList.length} →`}</button>` : ''}</div>` : ''}

    ${eveningDone && due.length ? '<p class="small mut rest-note">Остальное подождёт до завтра.</p>' : ''}
    ${due.length && !eveningDone ? `<div class="sec-title">Ждут заботы</div>
    <div class="card"><ul class="tl">${due.slice(0, 5).map((x) => taskRow(x.t, true)).join('')}</ul>
    ${due.length > 5 ? `<button class="more" data-act="tab" data-tab="home">Остальное — в комнатах, оно подождёт</button>` : ''}</div>` : ''}

    <div class="sec-title">Ваша неделя</div>
    <div class="card week-card">${weekDots()}
      <div class="small mut">${wk.tasks ? `${dela(wk.tasks)} · ${wk.minutes} мин заботы о доме` : 'Здесь будут отмечаться дни, когда вы заботились о доме.'}</div></div>
  `;
}

function taskRow(t, showZone) {
  const u = L.urgency(t, st, now());
  const done = doneToday(t.id);
  return `<li class="${done ? 'is-done' : ''}">
    <span class="dot ${done ? '' : dotClass(u)}"></span>
    <button class="tt" data-act="task" data-id="${t.id}">${esc(tname(t))}
      <small>${showZone ? esc(zname(L.zoneOf(t, st))) + ' · ' : ''}${taskMeta(t)}${whoTag(t)}</small></button>
    <button class="check ${done ? 'done' : ''}" data-act="${done ? 'undo-today' : 'done'}" data-id="${t.id}" aria-label="${done ? 'Снять отметку' : 'Сделано'}">✓</button>
  </li>`;
}

/* ---------- вкладка «Дом» ---------- */

let query = '';

function renderHome() {
  view.innerHTML = `<h1 class="page-title">Комнаты</h1>
    <p class="mut small">По порядку уборки — от дальней к выходу. Сделали что-то без приложения — найдите и отметьте.</p>
    <button class="btn wide inbox-btn" data-act="inbox-open">+ Дело во входящие${inboxWaiting() ? ` · ждут Claude: ${inboxWaiting()}` : ''}</button>
    ${projectsHtml()}
    <input class="field search" id="search" data-act="search" type="search" placeholder="Найти дело: пол, лоток, окна…" value="${esc(query)}">
    <div id="zones">${zonesHtml()}</div>`;
}

function zonesHtml() {
  const t = now();
  const q = query.trim().toLowerCase();
  const html = L.zonesShown(st)
      .map((z) => {
        let ts = L.activeTasks(st).filter((x) => L.zoneOf(x, st) === z.id);
        if (q) {
          ts = ts.filter((x) => tname(x).toLowerCase().includes(q));
          if (!ts.length) return '';
        }
        const isFloor = (x) => (x.tags || []).includes('floor');
        ts.sort((a, b) => Number(isFloor(a)) - Number(isFloor(b)) || a.ord - b.ord || L.effEvery(a, st) - L.effEvery(b, st));
        const h = L.zoneHealth(st, z.id, t);
        const n = ts.filter((x) => L.urgency(x, st, t) >= L.DUE).length;
        return `<details class="card zone" id="zone-${z.id}" data-zone="${z.id}" ${q || openZones.has(z.id) ? 'open' : ''}>
          <summary><h3>${esc(zname(z.id))}</h3>
            <span class="${n ? 'chip-due' : 'chip-ok'}">${n ? `ждут: ${n}` : 'уютно'}</span>
            <div class="bar ${level(h)}"><i style="width:${Math.round(h * 100)}%"></i></div></summary>
          ${q ? '' : `<div class="zone-actions">
            <button class="btn" data-act="room-sheet" data-z="${z.id}">Навести уют здесь</button>
            <button class="btn ghost" data-act="own-new" data-z="${z.id}">+ Своё дело</button>
          </div>`}
          <ul class="tl">${ts.map((x) => taskRow(x, false)).join('')}</ul>
        </details>`;
      })
      .join('');
  return `<div class="stack">${html || '<p class="mut">Ничего не нашлось. Можно добавить своё дело в любой комнате.</p>'}</div>`;
}

/* ---------- вкладка «Настройки» ---------- */

function sw(act, checked, extra = '') {
  return `<label class="switch"><input type="checkbox" data-act="${act}" ${extra} ${checked ? 'checked' : ''}><i></i></label>`;
}

function renderSettings() {
  const h = st.household;
  const off = L.allTasks(st).filter((t) => st.taskOff[t.id]);
  const r = st.remind;
  const openNotes = st.notes.filter((n) => !n.done);
  const doneNotes = st.notes.filter((n) => n.done);
  const noteLi = (n) => `<li class="${n.done ? 'is-done' : ''}">
      <button class="check ${n.done ? 'done' : ''}" data-act="note-done" data-id="${n.id}" aria-label="Решено">✓</button>
      <span class="tt">${esc(n.text)}<small>${new Date(n.at).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${n.ctx ? ' · ' + esc(n.ctx) : ''}</small></span>
      <button class="x" data-act="note-del" data-id="${n.id}" aria-label="Удалить">×</button></li>`;
  const timeRow = (k, title, sub, extra = '') => `<div class="rem">
      <div class="row"><div>${title}<small>${sub}</small></div>${sw('rt-on', r[k].on, `data-k="${k}"`)}</div>
      ${r[k].on ? `<div class="rem-ctl">${extra}<input class="field time" type="time" data-act="rt-time" data-k="${k}" value="${r[k].time}"></div>` : ''}</div>`;
  view.innerHTML = `<h1 class="page-title">Настройки</h1>

    <div class="sec-title">Что неудобно <span class="count">${openNotes.length ? openNotes.length : ''}</span></div>
    <div class="card">
      <p class="small mut" style="margin-top:0">Заметили неудобство — нажмите ✎ в углу любого экрана, даже во время уборки. Здесь всё соберётся, а потом одной кнопкой отправите разработчику.</p>
      ${openNotes.length ? `<ul class="tl notes">${openNotes.map(noteLi).join('')}</ul>
        <button class="btn wide primary" data-act="notes-copy" style="margin-top:8px">Скопировать всё</button>
        <button class="btn wide ghost confirm" data-act="notes-clear" style="margin-top:8px">${armed === 'notes-clear' ? 'Точно удалить все заметки? Нажмите ещё раз' : 'Отправили? Очистить заметки'}</button>` : '<button class="btn wide" data-act="note">✎ Записать первое</button>'}
      ${doneNotes.length ? `<details class="done-notes"><summary class="small mut">Решено: ${doneNotes.length}</summary><ul class="tl notes">${doneNotes.map(noteLi).join('')}</ul></details>` : ''}
    </div>

    <div class="sec-title">Домовёнок</div>
    <div class="card">${say('Это я присматриваю за домом. Можете звать меня как хотите.', 'happy')}
      <input class="field" data-act="buddy-name" placeholder="Имя" value="${esc(buddyName())}" maxlength="16" style="margin-top:10px"></div>

    <div class="sec-title">Напоминания</div>
    <div class="card">
      <p class="small mut" style="margin-top:0">Напоминания живут в календаре телефона — там они надёжно звенят, даже когда приложение закрыто.</p>
      ${timeRow('morning', 'Утренние мелочи', 'Каждый день')}
      ${timeRow('evening', 'Вечерние мелочи', 'Каждый день')}
      ${timeRow('weekly', 'Забота о доме', 'Раз в неделю, около 30 минут',
        `<select class="field time" data-act="rt-day">${L.WEEKDAYS.map((d, i) => `<option value="${i}" ${r.weekly.day === i ? 'selected' : ''}>${d}</option>`).join('')}</select>`)}
      ${S.inArtifact
        ? `<a class="btn wide primary" href="${icsLink()}" target="_blank" rel="noopener" style="margin-top:8px">Добавить в календарь</a>
           <p class="small dim" style="margin-bottom:0">Откроется страница «Уборки» в браузере — там календарь заберёт файл.</p>`
        : '<button class="btn wide primary" data-act="rt-ics" style="margin-top:8px">Добавить в календарь</button>'}
      <p class="small dim" style="margin-bottom:0">Откроется файл — календарь предложит добавить события. Поменяли время — нажмите ещё раз и удалите старые события «Уборка».</p>
    </div>

    ${S.inArtifact ? '' : homeSection()}

    <div class="sec-title">Кто живёт дома</div>
    <div class="card">${petFields()}
      <div class="row"><div>Дети<small>Пол — в 2 раза чаще</small></div>${sw('hh', h.kids, 'data-k="kids"')}</div>
      <div class="row"><div>Аллергия на пыль<small>Пыль и бельё — в 2 раза чаще</small></div>${sw('hh', h.allergy, 'data-k="allergy"')}</div>
    </div>

    <div class="sec-title">Комнаты</div>
    <div class="card">
      <div class="row"><div>Кухня и гостиная — одна комната</div>${sw('merged', st.merged)}</div>
      ${ROOMS.filter(([id]) => !(st.merged && id === 'living'))
        .map(([id, n]) => `<div class="row"><div>${id === 'kitchen' && st.merged ? 'Кухня-гостиная' : n}</div>${sw('zone', roomOn(id), `data-z="${id}"`)}</div>`)
        .join('')}
      <div class="row"><div>Весь дом<small>Окна снаружи, датчики, фильтры</small></div>${sw('zone', L.zoneOn(st, 'home'), 'data-z="home"')}</div>
    </div>

    ${off.length ? `<div class="sec-title">Отключённые дела</div>
    <div class="card"><ul class="tl">${off.map((t) => `<li><span class="tt">${esc(tname(t))}<small>${esc(zname(L.zoneOf(t, st)))}</small></span>
      <button class="btn" data-act="task-on" data-id="${t.id}">Вернуть</button></li>`).join('')}</ul></div>` : ''}

    <div class="sec-title">Отпуск</div>
    <div class="card"><div class="row"><div>Режим отпуска<small>Сроки не идут, пока вас нет дома</small></div>${sw('pause', st.pause !== null)}</div></div>

    <div class="sec-title">Резервная копия</div>
    <div class="card stack">
      <p class="small mut" style="margin:0">Данные хранятся только на этом телефоне. Копия — файл, который можно сохранить и потом загрузить обратно.</p>
      <button class="btn wide" data-act="export">Сохранить копию</button>
      <label class="btn wide ghost">Загрузить из копии<input type="file" accept="application/json,.json" data-act="import" hidden></label>
    </div>
    <div class="sec-title">Для тестирования</div>
    <div class="card stack">
      <p class="small mut" style="margin:0">Сбросить все отметки «сделано» и историю. Комнаты, питомцы, свои дела, напоминания и заметки останутся.</p>
      <button class="btn wide ghost confirm" data-act="reset-marks">${armed === 'reset-marks' ? 'Точно сбросить? Нажмите ещё раз' : 'Сбросить отметки'}</button>
    </div>
    <button class="btn wide ghost" style="margin-top:16px" data-act="setup-again">Пройти знакомство заново</button>
    <p class="small dim" style="text-align:center;margin-top:24px">Уборка · версия 0.9</p>`;
}

/* ---------- лист задачи ---------- */

const FREQS = [1, 2, 3, 7, 14, 30, 60, 90, 180, 365];

function openSheet(id) {
  const t = L.task(st, id);
  if (t.own) return openOwnSheet(t);
  const cur = L.effEvery(t, st);
  const own = st.every[id];
  const kit = L.kitFor(t);
  const w = L.why(t);
  const usual = L.effMin(t, st) !== t.min ? `<p class="small mut">Обычно у вас уходит ~${L.effMin(t, st)} мин — приложение это учитывает.</p>` : '';
  $('#sheet').innerHTML = `<button class="sheet-x" data-act="sheet-close" aria-label="Закрыть">×</button>
    <h2>${esc(tname(t))}</h2>
    <div class="mut small">${esc(zname(L.zoneOf(t, st)))} · ${taskMeta(t)}</div>
    ${w ? `<div class="why-box"><p><b>Даст:</b> ${esc(w[0])}</p><p class="mut"><b>Если пропустить:</b> ${esc(w[1])}</p></div>` : ''}
    ${usual}
    ${assignChips(t)}
    ${rateChips(t)}
    ${t.prep ? `<p class="small"><b>Сначала:</b> ${esc(L.label(t, st, t.prep))} — и ${t.wait} мин пусть действует.</p>` : ''}
    ${t.hint ? `<p class="small mut">${esc(t.hint)}</p>` : ''}
    ${kit.length ? `<p class="small mut">Понадобится: ${esc(kit.join(', ').toLowerCase())}</p>` : ''}
    ${t.warn ? `<div class="s-warn">${esc(t.warn)}</div>` : ''}
    ${whenChips(t)}
    <div class="sec-title">Как часто</div>
    <div class="chips">
      <button class="chip ${own ? '' : 'on'}" data-act="freq" data-id="${id}" data-v="0">Как советуют · ${L.fmtEvery(t.every)}</button>
      ${FREQS.map((f) => `<button class="chip ${own === f ? 'on' : ''}" data-act="freq" data-id="${id}" data-v="${f}">${L.fmtEvery(f)}</button>`).join('')}
    </div>
    <p class="small mut">${own ? 'Сохраняется сразу.' : cur !== t.every ? `Сейчас ${L.fmtEvery(cur)} — с учётом того, кто живёт дома. Изменения сохраняются сразу.` : 'Изменения сохраняются сразу.'}</p>
    <div class="stack" style="margin-top:20px">
      <button class="btn wide primary" data-act="done" data-id="${id}">Сделано сегодня</button>
      <button class="btn wide" data-act="done-yday" data-id="${id}">Сделано вчера</button>
      <button class="btn wide ghost" data-act="task-off" data-id="${id}">Мне это не нужно</button>
    </div>`;
  $('#sheet').hidden = false;
  $('#sheet-bg').hidden = false;
}

/* ---------- ритуал ---------- */

function startRitual(which) {
  const steps = L.ritualSteps(st, which, now());
  if (!steps.length) return;
  closeSheet();
  st.session = { steps, idx: 0, prepAt: {}, stepStart: now(), done: 0, min: 0, started: now(), ready: true, zones: [], ritual: which };
  lockScreen(true);
  commit();
  renderSession();
}

/* ---------- заметки «что неудобно» ---------- */

let noteCtx = '';

function currentCtx() {
  const ss = st.session;
  if (ss && ss.ready && ss.idx < ss.steps.length) return `Уборка · шаг «${ss.steps[ss.idx].text}»`;
  if (ss) return 'Уборка';
  if (!st.setup) return 'Знакомство';
  return { now: 'Главная', home: 'Комнаты', settings: 'Настройки' }[tab];
}

/* ---------- чат с Claude (версия внутри Claude) ---------- */
// Сообщение пишется в общую базу (chat/<id>) и отправляется Claude в ветку комментариев артефакта.
// Claude отвечает в ту же ветку и записывает ответ в базу — приложение показывает его здесь.

let chat = { msgs: [], can: 'off', thread: null, names: {}, open: false, sending: false };

async function startChat() {
  const db = S.database();
  if (!db) return;
  db.collection('extra').orderBy('at').limit(300).onSnapshot((snap) => {
    extras = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (tab === 'score' && !st.session) render();
    if (extraOpen) renderExtra();
  });
  db.collection('projects').orderBy('at').limit(50).onSnapshot((snap) => {
    projects = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (tab === 'home' && !st.session) render();
    if (projectOpen) renderProject(projectOpen);
  });
  db.collection('inbox').orderBy('at').limit(50).onSnapshot((snap) => {
    inbox = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (tab === 'home' && !st.session) render();
    if (inboxOpen) renderInbox();
  });
  db.collection('chat').orderBy('at').limit(100).onSnapshot((snap) => {
    chat.msgs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    loadNames();
    if (chat.open) renderChat();
  });
  db.doc('home/chat').onSnapshot((s) => {
    chat.thread = (s.exists && s.data().threadId) || null;
  });
}

async function loadNames() {
  if (!S.inArtifact) return; // на телефоне в сообщении уже записано имя
  const ids = [...new Set(chat.msgs.map((m) => m.by).filter((id) => id && !(id in chat.names)))];
  if (!ids.length) return;
  try {
    const user = await window.claude.use('user');
    const ps = user ? await user.profiles(ids) : {};
    for (const id of ids) chat.names[id] = (ps[id] && ps[id].name) || '';
    if (chat.open) renderChat();
  } catch {
    /* имена не обязательны */
  }
}

async function refreshCan() {
  if (!S.inArtifact) {
    chat.can = 'home';
    if (chat.open) renderChat();
    return;
  }
  try {
    const c = await window.claude.use('comments');
    chat.can = c ? await c.canSendToClaude() : 'off';
  } catch {
    chat.can = 'off';
  }
  if (chat.open) renderChat();
}

const CAN_TEXT = {
  home: 'Сообщение увидят Claude и все в доме. Ответ придёт сюда.',
  available: 'Claude на связи — ответит прямо здесь.',
  no_session: 'Claude сейчас не на связи. Сообщение сохранится, он прочитает его, как только вернётся.',
  writers_only: 'Отправлять Claude может тот, у кого есть права редактора. Сообщение сохранится в общей переписке.',
  off: 'Отправка Claude здесь недоступна. Сообщение сохранится в общей переписке.',
};
const STATUS_TEXT = { sent: 'отправлено', saved: 'сохранено — Claude прочитает позже', answered: 'Claude ответил', consent: 'не отправлено: нужно разрешение' };

function renderChat() {
  const who = (m) => (m.role === 'claude' ? 'Claude' : m.by && m.by === S.me ? 'Вы' : (S.inArtifact ? chat.names[m.by] : m.by) || 'Жилец');
  const time = (ts) => new Date(ts).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const list = chat.msgs.length
    ? chat.msgs
        .map((m) => `<div class="msg ${m.role === 'claude' ? 'from-claude' : 'from-me'}">
          <b>${esc(who(m))}</b>${esc(m.text)}
          <small>${time(m.at)}${m.ctx ? ' · ' + esc(m.ctx) : ''}${m.role !== 'claude' && STATUS_TEXT[m.status] ? ' · ' + STATUS_TEXT[m.status] : ''}</small></div>`)
        .join('')
    : `<p class="mut small">Здесь можно написать, что неудобно, попросить поправить приложение или спросить про уборку. Ответ придёт сюда.</p>`;
  const draft = $('#chat-text') ? $('#chat-text').value : '';
  $('#sheet').innerHTML = `<button class="sheet-x" data-act="sheet-close" aria-label="Закрыть">×</button>
    <h2>Написать Claude</h2>
    <div class="mut small">${CAN_TEXT[chat.can] || CAN_TEXT.off}</div>
    <div class="chat-list" id="chat-list">${list}</div>
    <textarea class="field note-text" id="chat-text" rows="3" maxlength="2000" placeholder="Например: сделай кнопку «Позже» крупнее"></textarea>
    <button class="btn wide primary" data-act="chat-send" ${chat.sending ? 'disabled' : ''}>${chat.sending ? 'Отправляю…' : 'Отправить'}</button>
    <p class="small dim">Где вы сейчас: ${esc(noteCtx)}</p>`;
  $('#chat-text').value = draft;
  const box = $('#chat-list');
  box.scrollTop = box.scrollHeight;
}

function openChat() {
  noteCtx = currentCtx();
  chat.open = true;
  renderChat();
  openSheetEl();
  refreshCan();
}

async function sendChat() {
  const el = $('#chat-text');
  const text = (el ? el.value : '').trim();
  if (!text || chat.sending) return;
  const db = S.database();
  const id = 'm' + now().toString(36);
  const body = `Из приложения «Уборка» · ${noteCtx}\n${text}\n(сообщение ${id})`;
  let status = 'saved';
  let threadId = null;
  chat.sending = true;
  renderChat();
  // Отправка Claude — сразу по нажатию: платформа принимает её только от свежего действия человека.
  try {
    const c = S.inArtifact ? await window.claude.use('comments') : null;
    if (c && chat.can === 'available') {
      let res;
      try {
        res = chat.thread
          ? await c.sendToClaude({ threadId: chat.thread, text: body })
          : await c.sendToClaude({ anchor: await c.anchorFor($('#view')), text: body });
      } catch (e) {
        if (e && e.code === 'not_found') res = await c.sendToClaude({ anchor: await c.anchorFor($('#view')), text: body });
        else throw e;
      }
      threadId = res.threadId;
      status = 'sent';
      if (res.threadId !== chat.thread) {
        chat.thread = res.threadId;
        db.doc('home/chat').set({ threadId: res.threadId });
      }
    }
  } catch (e) {
    status = e && e.code === 'consent_required' ? 'consent' : 'saved';
  }
  try {
    await db.collection('chat').doc(id).set({ role: 'user', by: S.me, text, ctx: noteCtx, at: now(), status, threadId });
    $('#chat-text').value = '';
  } catch {
    toast('Не получилось сохранить сообщение — проверьте интернет');
  }
  chat.sending = false;
  renderChat();
}

function openNoteSheet() {
  if (S.shared) return openChat();
  noteCtx = currentCtx();
  $('#sheet').innerHTML = `<h2>Что неудобно?</h2>
    <div class="mut small">Где: ${esc(noteCtx)}</div>
    <textarea class="field note-text" id="note-text" rows="4" placeholder="Например: кнопка «Позже» слишком близко к «Готово»"></textarea>
    <div class="stack" style="margin-top:12px">
      <button class="btn wide primary" data-act="note-save">Записать</button>
    </div>`;
  openSheetEl();
  setTimeout(() => $('#note-text')?.focus(), 50);
}

async function copyNotes() {
  const text = 'Заметки из «Уборки» — что неудобно:\n' + L.notesText(st);
  try {
    if (!S.inArtifact && navigator.share && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
      await navigator.share({ text });
      return;
    }
    await navigator.clipboard.writeText(text);
    toast('Скопировано — вставьте в чат');
  } catch {
    // Буфер обмена недоступен — показываем текст, чтобы выделить вручную.
    $('#sheet').innerHTML = `<h2>Заметки</h2><p class="small mut">Выделите и скопируйте:</p>
      <textarea class="field note-text" rows="10" readonly>${esc(text)}</textarea>`;
    openSheetEl();
  }
}

const GITHUB_APP = 'https://sapronovigor96-jpg.github.io/uborka/';

function downloadIcs() {
  const url = location.origin + location.pathname;
  S.saveFile('uborka-napominaniya.ics', L.makeIcs(st, now(), url), 'text/calendar;charset=utf-8');
  toast('Файл готов — откройте его, календарь добавит напоминания');
}

// Ссылка для версии внутри Claude: события передаются после «#» — эта часть не уходит на сервер.
function icsLink() {
  const events = L.reminderEvents(st, now());
  return GITHUB_APP + '#ics=' + encodeURIComponent(JSON.stringify(events));
}

// GitHub-версия, открытая по такой ссылке: показать экран «Скачать напоминания».
function icsFromHash() {
  if (!location.hash.startsWith('#ics=')) return false;
  let events;
  try {
    events = JSON.parse(decodeURIComponent(location.hash.slice(5)));
  } catch {
    return false;
  }
  const el = $('#setup');
  el.hidden = false;
  el.innerHTML = `<div class="inner"><div class="s-body setup-body">
      <div class="s-kind">Напоминания</div>
      <h1>Добавим в календарь</h1>
      <p class="mut">${events.map((e) => esc(e.title)).join('<br>')}</p>
      <p class="small dim">Откроется файл — календарь предложит добавить события.</p>
    </div>
    <div class="s-actions"><button class="btn primary" id="ics-go">Скачать напоминания</button></div></div>`;
  $('#ics-go').onclick = () => S.saveFile('uborka-napominaniya.ics', L.makeIcsFromEvents(events, now(), GITHUB_APP), 'text/calendar;charset=utf-8');
  return true;
}

/* ---------- входящие: идеи дел своими словами, Claude настраивает ---------- */
// В общем доме — коллекция inbox/<id> { text, by, at, status: 'new' | 'done' | 'skip', taskId, note }.
// Без общего дома — список в st.inbox на этом телефоне.

let inbox = [];
let inboxOpen = false;

const inboxItems = () => (S.shared ? inbox : st.inbox || []);
const inboxWaiting = () => inboxItems().filter((x) => x.status === 'new').length;

function renderInbox() {
  const items = [...inboxItems()].sort((a, b) => b.at - a.at).slice(0, 20);
  const state = (x) =>
    x.status === 'done' ? `добавлено${x.taskId && L.task(st, x.taskId) ? ': ' + esc(tname(L.task(st, x.taskId))) : ''}`
    : x.status === 'skip' ? 'Claude: ' + esc(x.note || 'не стал добавлять')
    : 'ждёт Claude';
  $('#sheet').innerHTML = `<button class="sheet-x" data-act="sheet-close" aria-label="Закрыть">×</button>
    <h2>Входящие дела</h2>
    <p class="small mut">Опишите дело своими словами. Claude решит, в какую комнату его поставить, как часто и сколько времени оно займёт, — и добавит в ваш дом.</p>
    <textarea class="field note-text" id="inbox-text" rows="3" maxlength="500" placeholder="Например: протирать домик Тони от шерсти"></textarea>
    <button class="btn wide primary" data-act="inbox-save">Во входящие</button>
    ${items.length ? `<ul class="tl inbox-list">${items.map((x) => `<li class="${x.status !== 'new' ? 'is-done' : ''}"><span class="tt">${esc(x.text)}<small>${S.shared && x.by ? esc(x.by) + ' · ' : ''}${state(x)}</small></span></li>`).join('')}</ul>` : ''}
    ${S.shared ? '' : '<p class="small dim">Без общего дома Claude увидит входящие, только если вы их скопируете ему. Подключите общий дом в Настройках.</p>'}`;
}

function openInbox() {
  inboxOpen = true;
  renderInbox();
  openSheetEl();
  setTimeout(() => $('#inbox-text')?.focus(), 50);
}

async function saveInbox() {
  const text = ($('#inbox-text').value || '').trim();
  if (!text) return;
  const item = { text, by: S.me || '', at: now(), status: 'new' };
  const id = 'i' + now().toString(36);
  if (S.shared) await S.database().collection('inbox').doc(id).set(item);
  else {
    st.inbox = [...(st.inbox || []), { id, ...item }];
    commit();
  }
  $('#inbox-text').value = '';
  toast('Во входящих — Claude настроит дело');
  renderInbox();
  render();
}

function confetti() {
  const box = document.createElement('div');
  box.className = 'confetti';
  const colors = ['#eab87f', '#a6c191', '#f6c97f', '#f2e8d9'];
  for (let i = 0; i < 36; i++) {
    const p = document.createElement('i');
    p.style.left = Math.random() * 100 + 'vw';
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = Math.random() * 0.5 + 's';
    p.style.animationDuration = 1.2 + Math.random() * 0.9 + 's';
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 2800);
}

/* ---------- очки и недельные итоги ---------- */
// «Сверх списка» и бонусы — коллекция extra/<id>:
//   { kind: 'extra' | 'bonus', text, min, by, at, status: 'pending' | 'rated', pts, note }
// Дела сверх списка оценивает Claude (tools/home.mjs extra-rate), бонусы за новые дела начисляет он же.

let extras = [];
let extraOpen = false;
const extraList = () => (S.shared ? extras : st.extra || []);
const WEEK = 7 * L.DAY;

function weekLabel(from) {
  const f = new Date(from);
  const t = new Date(from + WEEK - L.DAY);
  const o = { day: 'numeric', month: 'long' };
  return `${f.toLocaleDateString('ru', { day: 'numeric' })} – ${t.toLocaleDateString('ru', o)}`;
}

const who = (by) => (!by ? (S.shared ? 'Без имени' : 'Вы') : by === S.me ? by + ' (вы)' : by);

function scoreLine(board, daysLeft) {
  if (!board.length || board[0].pts === 0) return ['Неделя только началась — первое дело задаст темп.', 'calm'];
  if (board.length === 1) return [`${board[0].pts} очков за неделю. Отличный темп!`, 'happy'];
  const [a, b] = board;
  const gap = a.pts - b.pts;
  if (gap === 0) return ['Ничья! Кто сделает следующее дело — тот и впереди.', 'cheer'];
  if (gap <= 10) return [`${a.by || 'Кто-то'} впереди всего на ${gap}. ${daysLeft > 1 ? 'Всё решится в последние дни!' : 'Решающий день!'}`, 'cheer'];
  return [`${a.by || 'Кто-то'} впереди на ${gap}. ${b.by || 'Второй'}, пара вечерних мелочей — и догонишь.`, 'happy'];
}

function renderScore() {
  const t = now();
  const from = L.weekStart(t);
  const board = L.scoreboard(st, extraList(), from, from + WEEK);
  const top = board[0] ? board[0].pts : 0;
  const daysLeft = Math.ceil((from + WEEK - t) / L.DAY);
  const pending = extraList().filter((x) => x.kind !== 'bonus' && x.status === 'pending');
  const rated = extraList().filter((x) => x.status === 'rated' && x.at >= from).sort((a, b) => b.at - a.at);
  const past = [1, 2, 3, 4]
    .map((k) => {
      const f = from - k * WEEK;
      const b = L.scoreboard(st, extraList(), f, f + WEEK).filter((r) => r.pts > 0);
      return b.length ? { f, b } : null;
    })
    .filter(Boolean);

  view.innerHTML = `<h1 class="page-title">Итоги недели</h1>
    <p class="mut small">${weekLabel(from)} · ${daysLeft > 1 ? `до конца недели ${daysLeft} ${L.plural(daysLeft, 'день', 'дня', 'дней')}` : 'последний день недели'}</p>
    ${say(...scoreLine(board, daysLeft))}
    <div class="stack" style="margin-top:14px">${board.length
      ? board
          .map((r, i) => `<div class="card score ${i === 0 && r.pts > 0 && board.length > 1 ? 'lead' : ''}">
            <div class="score-head"><b>${i === 0 && r.pts > 0 && board.length > 1 ? '♛ ' : ''}${esc(who(r.by))}</b><span class="pts">${r.pts}</span></div>
            <div class="bar"><i style="width:${top ? Math.round((r.pts / top) * 100) : 0}%"></i></div>
            <small class="mut">${dela(r.tasks)} · ${Math.round(r.minutes)} мин${r.extra ? ` · сверх списка и бонусы: ${r.extra}` : ''}</small>
          </div>`)
          .join('')
      : '<div class="card mut small">Пока пусто. Отмечайте дела — очки появятся здесь.</div>'}</div>

    <button class="btn wide primary" style="margin-top:14px" data-act="extra-open">+ Сделал сверх списка</button>

    ${pending.length ? `<div class="sec-title">Ждут оценки Claude</div>
      <div class="card"><ul class="tl">${pending.map((x) => `<li><span class="tt">${esc(x.text)}<small>${esc(who(x.by))} · ${x.min} мин</small></span></li>`).join('')}</ul></div>` : ''}
    ${rated.length ? `<div class="sec-title">Сверх списка и бонусы</div>
      <div class="card"><ul class="tl">${rated.map((x) => `<li><span class="tt">${esc(x.text)}<small>${esc(who(x.by))}${x.note ? ' · ' + esc(x.note) : ''}</small></span><b class="pts-sm">+${x.pts}</b></li>`).join('')}</ul></div>` : ''}

    ${past.length ? `<div class="sec-title">Прошлые недели</div>
      <div class="card"><ul class="tl">${past
        .map(({ f, b }) => `<li><span class="tt">${weekLabel(f)}<small>${b.map((r) => `${esc(r.by || 'без имени')}: ${r.pts}`).join(' · ')}</small></span><b>${b.length > 1 && b[0].pts > b[1].pts ? '♛ ' + esc(b[0].by || '') : b.length > 1 ? 'ничья' : ''}</b></li>`)
        .join('')}</ul></div>` : ''}

    <details class="card rules"><summary class="small">Как считаются очки</summary>
      <ul class="small mut">
        <li>Дело из списка: минуты по оценке × сложность. Лёгкое ×1, грязное или с химией ×1,5, тяжёлое ×2.</li>
        <li>«Уже сделано» — то, что сделали заодно, сверх плана: +25%.</li>
        <li>Сверх списка — присылаете, что сделали и сколько минут, Claude оценивает.</li>
        <li>Новое регулярное дело (через «Входящие» или сверх списка) — +${L.NEW_TASK_BONUS} автору.</li>
        <li>Неделя — с понедельника 4:00 до следующего понедельника.</li>
      </ul></details>`;
}

function renderExtra() {
  const mine = extraList().filter((x) => x.kind !== 'bonus').sort((a, b) => b.at - a.at).slice(0, 10);
  const draftMin = Number(($('.chip.on[data-act="extra-min"]') || {}).dataset?.v || 15);
  $('#sheet').innerHTML = `<button class="sheet-x" data-act="sheet-close" aria-label="Закрыть">×</button>
    <h2>Сделал сверх списка</h2>
    <p class="small mut">Опишите, что сделали и сколько примерно заняло. Claude оценит очки и, если дело стоит делать регулярно, предложит добавить его в список (+${L.NEW_TASK_BONUS} за новое дело).</p>
    <textarea class="field note-text" id="extra-text" rows="3" maxlength="400" placeholder="Например: разобрал балкон, вынес 3 пакета"></textarea>
    <div class="sec-title">Сколько минут</div>
    <div class="chips">${[5, 10, 15, 30, 45, 60, 90, 120].map((m) => `<button class="chip ${m === draftMin ? 'on' : ''}" data-act="extra-min" data-v="${m}">${m}</button>`).join('')}</div>
    <button class="btn wide primary" style="margin-top:16px" data-act="extra-save">Отправить на оценку</button>
    ${mine.length ? `<ul class="tl" style="margin-top:12px">${mine.map((x) => `<li class="${x.status === 'rated' ? 'is-done' : ''}"><span class="tt">${esc(x.text)}<small>${x.min} мин · ${x.status === 'rated' ? `+${x.pts}${x.note ? ' · ' + esc(x.note) : ''}` : 'ждёт Claude'}</small></span></li>`).join('')}</ul>` : ''}`;
}

function openExtra() {
  extraOpen = true;
  renderExtra();
  openSheetEl();
}

async function saveExtra() {
  const text = ($('#extra-text').value || '').trim();
  if (!text) return;
  const min = Number(($('.chip.on[data-act="extra-min"]') || {}).dataset?.v || 15);
  const item = { kind: 'extra', text, min, by: S.me || '', at: now(), status: 'pending' };
  const id = 'x' + now().toString(36);
  if (S.shared) await S.database().collection('extra').doc(id).set(item);
  else {
    st.extra = [...(st.extra || []), { id, ...item }];
    commit();
  }
  $('#extra-text').value = '';
  toast('Отправлено — Claude оценит');
  renderExtra();
  render();
}

/* ---------- разовые проекты: сделали один раз — и готово ---------- */
// В общем доме — projects/<id> { title, why, steps: [{ t, done }], status: 'open' | 'done', at }.
// Проекты составляет Claude (tools/home.mjs project-add), жильцы отмечают шаги.

let projects = [];
let projectOpen = null;
const projectList = () => (S.shared ? projects : st.projects || []);

function projectsHtml() {
  const open = projectList().filter((p) => p.status !== 'done');
  const done = projectList().filter((p) => p.status === 'done');
  if (!open.length && !done.length) return '';
  const row = (p) => {
    const n = p.steps.filter((x) => x.done).length;
    return `<li><button class="tt" data-act="proj-open" data-id="${p.id}">${esc(p.title)}
      <small>${n} из ${p.steps.length} шагов</small>
      <span class="bar mini ${n === p.steps.length ? '' : 'mid'}"><i style="width:${Math.round((n / p.steps.length) * 100)}%"></i></span></button></li>`;
  };
  return `<div class="sec-title">Разовые проекты <span class="count">${done.length ? `готово: ${done.length}` : ''}</span></div>
    <div class="card"><ul class="tl projects">${open.map(row).join('') || '<li class="mut small">Все проекты сделаны — вы молодцы.</li>'}</ul></div>`;
}

function renderProject(id) {
  const p = projectList().find((x) => x.id === id);
  if (!p) return closeSheet();
  const n = p.steps.filter((x) => x.done).length;
  $('#sheet').innerHTML = `<button class="sheet-x" data-act="sheet-close" aria-label="Закрыть">×</button>
    <h2>${esc(p.title)}</h2>
    ${p.why ? `<p class="small mut">${esc(p.why)}</p>` : ''}
    <ul class="tl daily">${p.steps
      .map((x, i) => `<li class="${x.done ? 'is-done' : ''}"><button class="check ${x.done ? 'done' : ''}" data-act="proj-step" data-id="${p.id}" data-i="${i}" aria-label="Шаг сделан">✓</button>
        <span class="tt">${esc(x.t)}</span></li>`)
      .join('')}</ul>
    ${n === p.steps.length && p.status !== 'done' ? '<button class="btn wide primary" data-act="proj-done" data-id="' + p.id + '">Проект готов</button>' : ''}
    ${p.status === 'done' ? '<p class="ok-note">✓ Проект готов</p>' : ''}`;
}

function openProject(id) {
  projectOpen = id;
  renderProject(id);
  openSheetEl();
}

async function saveProject(p, patch) {
  Object.assign(p, patch);
  if (S.shared) await S.database().doc('projects/' + p.id).update(patch);
  else commit();
  renderProject(p.id);
  render();
}

/* ---------- общий дом (телефонная версия) ---------- */

function syncText(r) {
  if (!r) return 'Подключаюсь…';
  if (r.wrongKey) return 'Ключ не подходит. Проверьте его и подключитесь заново.';
  const ago = r.lastSync ? Math.round((Date.now() - r.lastSync) / 60000) : null;
  const when = ago === null ? '' : ago < 1 ? 'только что' : `${ago} мин назад`;
  if (!r.online) return `Нет связи с общим домом — изменения отправятся позже${r.pending ? ` (в очереди: ${r.pending})` : ''}.`;
  return `Синхронизировано ${when}${r.pending ? ` · отправляется: ${r.pending}` : ''}.`;
}

function homeSection() {
  const cfg = S.pairing();
  if (cfg && S.shared)
    return `<div class="sec-title">Общий дом</div>
    <div class="card stack">
      <div class="row"><div>Подключено<small>Вы здесь — ${esc(cfg.name || 'без имени')}</small></div><span class="chip-ok">●</span></div>
      <p class="small mut" style="margin:0" id="sync-line">${esc(syncText(S.remoteStatus))}</p>
      <button class="btn wide" data-act="sync-now">Синхронизировать сейчас</button>
      <button class="btn wide ghost confirm" data-act="unpair">${armed === 'unpair' ? 'Точно отключить этот телефон? Нажмите ещё раз' : 'Отключить этот телефон'}</button>
    </div>`;
  return `<div class="sec-title">Общий дом</div>
    <div class="card stack">
      <p class="small mut" style="margin:0">Отметки, дела и переписка с Claude станут общими для всех, у кого есть ключ дома, — например, для вас и Маши.</p>
      <button class="btn wide primary" data-act="pair-open">Подключиться к общему дому</button>
    </div>`;
}

function openResetSheet() {
  $('#sheet').innerHTML = `<button class="sheet-x" data-act="sheet-close" aria-label="Закрыть">×</button>
    <h2>Какой дом сейчас?</h2>
    <p class="small mut">Чтобы после сброса приложение показало честную картину.${S.shared ? ' Сброс общий — отметки обнулятся у всех в доме.' : ''}</p>
    <div class="stack">
      <button class="btn wide opt" data-act="reset-ago" data-v="0">Только что убрались — порядок</button>
      <button class="btn wide opt" data-act="reset-ago" data-v="1">Убирались неделю-две назад</button>
      <button class="btn wide opt" data-act="reset-ago" data-v="2">Давно — кое-что накопилось</button>
    </div>`;
  openSheetEl();
}

function openPairSheet() {
  $('#sheet').innerHTML = `<button class="sheet-x" data-act="sheet-close" aria-label="Закрыть">×</button>
    <h2>Общий дом</h2>
    <p class="small mut">Вставьте ключ дома — его вам даст тот, кто настроил общий дом.</p>
    <input class="field" id="pair-key" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Ключ дома: xxxxx-xxxxx-xxxxx-xxxxx">
    <input class="field" id="pair-name" maxlength="20" placeholder="Как вас зовут? Например, Маша">
    <p class="small dim">Если в общем доме уже есть данные, они заменят данные на этом телефоне. Если общий дом пустой — туда попадёт этот телефон.</p>
    <button class="btn wide primary" data-act="pair-go">Подключиться</button>`;
  openSheetEl();
}

async function pairGo() {
  const key = ($('#pair-key').value || '').trim().toLowerCase();
  const name = ($('#pair-name').value || '').trim();
  if (!key || !name) return toast('Нужны ключ и имя');
  S.setPairing({ url: S.HOME_SERVER, key, name });
  toast('Подключаюсь…');
  const res = await S.connect(st, now(), onRemote, onRemoteStatus);
  if (res === true) {
    if (!(st.people || []).includes(name)) {
      st.people = [...(st.people || []), name];
      commit();
    }
    closeSheet();
    startChat();
    render();
    return toast('Готово — теперь дом общий');
  }
  S.disconnect();
  toast(res === 'wrong_key' ? 'Ключ не подошёл — проверьте его' : 'Нет связи с общим домом — попробуйте позже');
}

function onRemote() {
  if (!st.session || $('#session').hidden) render();
}

function onRemoteStatus(r) {
  const line = $('#sync-line');
  if (line) line.textContent = syncText(r);
}

/* ---------- уборка одной комнаты ---------- */

const ROOM_BUDGETS = [10, 20, 30];

function openRoomSheet(z) {
  const t = now();
  const due = L.dueTasks(st, t).filter((x) => L.zoneOf(x.t, st) === z).length;
  const opts = ROOM_BUDGETS.map((b) => {
    let n = L.buildSession(st, t, b, L.DUE, z).filter((s) => s.kind === 'task').length;
    let early = false;
    if (!n) {
      n = L.buildSession(st, t, b, 0, z).filter((s) => s.kind === 'task').length;
      early = true;
    }
    return `<button class="budget" data-act="room-start" data-z="${z}" data-b="${b}" data-early="${early ? 1 : 0}" ${n ? '' : 'disabled'}>
      <b>${b} мин</b><span>${n ? dela(n) + (early ? ' заранее' : '') : 'нечего'}</span></button>`;
  }).join('');
  $('#sheet').innerHTML = `<h2>${esc(zname(z))}</h2>
    <div class="mut small">${due ? `Ждут заботы: ${dela(due)}` : 'Здесь уютно — можно освежить заранее'}</div>
    <div class="sec-title">Сколько есть времени?</div>
    <div class="budgets three">${opts}</div>
    <button class="btn wide ghost" style="margin-top:14px" data-act="own-new" data-z="${z}">+ Своё дело в этой комнате</button>`;
  openSheetEl();
}

/* ---------- свои дела ---------- */

const OWN_FREQS = [1, 2, 3, 7, 14, 30, 90];
const OWN_MINS = [2, 5, 10, 15, 30];
let form = null;

function openOwnForm(z, id) {
  const c = id && L.task(st, id);
  form = c
    ? { id, z: c.z, t: c.t, every: c.every, min: c.min, soon: false }
    : { id: null, z: z || 'kitchen', t: '', every: 7, min: 5, soon: false };
  renderOwnForm();
  setTimeout(() => $('#own-name')?.focus(), 50);
}

function renderOwnForm() {
  const f = form;
  const rooms = L.zonesShown(st);
  const chip = (k, v, text) => `<button class="chip ${f[k] === v ? 'on' : ''}" data-act="own-set" data-k="${k}" data-v="${v}">${esc(text)}</button>`;
  $('#sheet').innerHTML = `<h2>${f.id ? 'Изменить дело' : 'Своё дело'}</h2>
    <input class="field" id="own-name" data-act="own-name" placeholder="Например: полить монстеру" value="${esc(f.t)}" maxlength="60">
    <div class="sec-title">Где</div>
    <div class="chips">${rooms.map((z) => chip('z', z.id, zname(z.id))).join('')}</div>
    <div class="sec-title">Как часто</div>
    <div class="chips">${OWN_FREQS.map((v) => chip('every', v, L.fmtEvery(v))).join('')}</div>
    <div class="sec-title">Сколько времени</div>
    <div class="chips">${OWN_MINS.map((v) => chip('min', v, v + ' мин')).join('')}</div>
    ${f.id ? '' : `<div class="row" style="margin-top:14px"><div>Нужно уже сейчас<small>Попадёт в ближайшую уборку</small></div>${sw('own-soon', f.soon)}</div>`}
    <div class="stack" style="margin-top:20px">
      <button class="btn wide primary" data-act="own-save" ${f.t.trim() ? '' : 'disabled'}>${f.id ? 'Сохранить' : 'Добавить'}</button>
      ${f.id ? '<button class="btn wide ghost" data-act="own-del">Удалить дело</button>' : ''}
    </div>`;
  openSheetEl();
}

const RATE = [
  ['ok', 'Норм'],
  ['often', 'Слишком часто'],
  ['rare', 'Слишком редко'],
  ['no', 'Не про нас'],
];

// Кто есть в доме: из списка жильцов и из журнала (у старых записей).
function people() {
  const set = new Set(st.people || []);
  for (const e of st.log) if (e.by) set.add(e.by);
  if (S.me) set.add(S.me);
  return [...set].filter(Boolean);
}

// Кто взял дело из общего списка
function whoTag(t) {
  const who = S.shared && st.assign[t.id];
  return who ? ' · ' + (who === S.me ? 'беру я' : 'берёт ' + esc(who)) : '';
}

function assignChips(t) {
  if (!S.shared) return '';
  const cur = st.assign[t.id] || '';
  return `<div class="sec-title">Кто возьмёт</div>
    <div class="chips">${[['', 'Пока никто'], ...people().map((p) => [p, p])]
      .map(([v, n]) => `<button class="chip ${cur === v ? 'on' : ''}" data-act="assign" data-id="${t.id}" data-v="${esc(v)}">${esc(n)}</button>`)
      .join('')}</div>`;
}

function rateChips(t) {
  const cur = st.fb[t.id] && st.fb[t.id].v;
  return `<div class="sec-title">Как вам это дело?</div>
    <div class="chips">${RATE.map(([v, n]) => `<button class="chip ${cur === v ? 'on' : ''}" data-act="rate" data-id="${t.id}" data-v="${v}">${n}</button>`).join('')}</div>`;
}

function whenChips(t) {
  if (L.effEvery(t, st) > 1) return '';
  const w = L.whenOf(t, st);
  return `<div class="sec-title">Когда удобнее</div>
    <div class="chips">
      <button class="chip ${w === 'morning' ? 'on' : ''}" data-act="when" data-id="${t.id}" data-v="morning">Утром</button>
      <button class="chip ${w === 'evening' ? 'on' : ''}" data-act="when" data-id="${t.id}" data-v="evening">Вечером</button>
    </div>`;
}

function openOwnSheet(t) {
  const w = L.why(t);
  $('#sheet').innerHTML = `<button class="sheet-x" data-act="sheet-close" aria-label="Закрыть">×</button>
    <h2>${esc(t.t)}</h2>
    <div class="mut small">Своё дело${t.by === 'claude' ? ' · настроил Claude' : ''} · ${esc(zname(L.zoneOf(t, st)))} · ${taskMeta(t)}</div>
    ${w ? `<div class="why-box"><p><b>Даст:</b> ${esc(w[0])}</p><p class="mut"><b>Если пропустить:</b> ${esc(w[1])}</p></div>` : ''}
    ${t.hint ? `<p class="small mut">${esc(t.hint)}</p>` : ''}
    ${whenChips(t)}
    ${assignChips(t)}
    <div class="stack" style="margin-top:20px">
      <button class="btn wide primary" data-act="done" data-id="${t.id}">Сделано сегодня</button>
      <button class="btn wide" data-act="done-yday" data-id="${t.id}">Сделано вчера</button>
      <button class="btn wide ghost" data-act="own-edit" data-id="${t.id}">Изменить или удалить</button>
    </div>`;
  openSheetEl();
}

function openSheetEl() {
  $('#sheet').hidden = false;
  $('#sheet-bg').hidden = false;
}

function closeSheet() {
  chat.open = false;
  inboxOpen = false;
  projectOpen = null;
  extraOpen = false;
  $('#sheet').hidden = true;
  $('#sheet-bg').hidden = true;
}

/* ---------- отметка выполнения ---------- */

function markDone(id, at = now(), min) {
  const t = L.task(st, id);
  L.complete(st, id, at, min ?? t.min);
  commit();
  buzz();
  const last = st.log[st.log.length - 1];
  toast(`${pick(THANKS)} ${tname(t)} · +${last ? L.entryPoints(st, last) : 0}`, () => {
    L.undoComplete(st, id);
    commit();
    render();
  });
}

const THANKS = ['Готово:', 'Сделано:', 'Одним делом меньше:', 'Дом благодарит:'];
const AFTER = [
  'Спасибо себе',
  'Стало чуть светлее',
  'Хорошо идёт',
  'Минус одно дело',
  'Спокойно, без спешки',
  'Дому приятно',
  'Вдох — и дальше',
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/* ---------- тихий фон ---------- */

// Коричневый шум — как далёкий дождь. Генерируется на месте, без файлов.
const ambient = {
  ctx: null,
  gain: null,
  on: false,
  start() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = this.ctx || new Ctx();
      const ctx = this.ctx;
      const len = ctx.sampleRate * 4;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        d[i] = last * 3.5;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      this.gain = ctx.createGain();
      this.gain.gain.setValueAtTime(0, ctx.currentTime);
      this.gain.gain.linearRampToValueAtTime(0.35, ctx.currentTime + 2);
      src.connect(lp).connect(this.gain).connect(ctx.destination);
      src.start();
      this.src = src;
      this.on = true;
    } catch {
      this.on = false;
    }
  },
  stop() {
    if (!this.on || !this.ctx) return;
    const g = this.gain;
    const src = this.src;
    g.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 1);
    setTimeout(() => src.stop(), 1100);
    this.on = false;
  },
  toggle() {
    this.on ? this.stop() : this.start();
  },
};

/* ---------- режим уборки ---------- */

function startSession(budget, minUrg, zone) {
  closeSheet();
  const steps = L.buildSession(st, now(), budget, minUrg ?? L.DUE, zone || null);
  if (!steps.length) return;
  // Короткую уборку начинаем сразу: лишний экран перед стартом съедает решимость.
  const quick = L.sessionMinutes(steps) <= 6;
  st.session = { steps, idx: 0, prepAt: {}, stepStart: now(), done: 0, min: 0, started: now(), ready: quick, zones: [] };
  if (quick) lockScreen(true);
  commit();
  renderSession();
}

async function lockScreen(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    /* экран может погаснуть — не критично */
  }
}

function mmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function soundBtn() {
  return `<button data-act="s-sound" class="sound ${ambient.on ? 'on' : ''}">${ambient.on ? '♪ фон включён' : '♪ тихий фон'}</button>`;
}

function renderSession() {
  const ss = st.session;
  const el = $('#session');
  if (!ss) {
    el.hidden = true;
    clearInterval(tick);
    return;
  }
  el.hidden = false;
  const inner = (html) => (el.innerHTML = `<div class="inner">${html}</div>`);
  const total = ss.steps.reduce((s, x) => s + x.min, 0);

  // Перед началом: собрать корзинку.
  if (!ss.ready) {
    const kit = L.sessionKit(ss.steps, st);
    const zones = [...new Set(ss.steps.map((s) => s.zone))].map(zname);
    inner(`<div class="s-top"><button data-act="s-cancel" class="mut">✕ Не сейчас</button>${soundBtn()}</div>
      <div class="s-body">
        <div class="s-kind">~${total} мин · ${dela(ss.steps.filter((s) => s.kind === 'task').length)}</div>
        <h1 class="s-text">Соберите корзинку</h1>
        <p class="mut">${esc(zones.join(' → '))}</p>
        ${kit.length ? `<ul class="kit">${kit.map((k) => `<li><button data-act="kit">${esc(k)}</button></li>`).join('')}</ul>` : '<p class="mut">Ничего особенного не понадобится.</p>'}
        <p class="small dim">Можно включить музыку или тихий фон — и не торопиться.</p>
      </div>
      <div class="s-actions"><button class="btn primary" data-act="s-go">Начать</button></div>`);
    return;
  }

  if (ss.idx >= ss.steps.length) {
    clearInterval(tick);
    const mins = Math.max(1, Math.round(ss.min));
    const touched = [...new Set(ss.zones)];
    const zones = touched.map(zname);
    const note = ss.ritual === 'morning' ? 'Утро началось с заботы. Хорошего дня.'
      : ss.ritual === 'evening' ? 'Дом готов ко сну — и вы тоже.'
      : ss.done >= 5 ? 'Теперь можно заварить чай и полюбоваться.' : 'Маленький шаг — тоже шаг. Дом это чувствует.';
    inner(`<div class="s-body finish">
      ${ss.done ? house(L.zonesShown(st), touched) : ''}
      ${say(ss.done ? pick(FINISH_LINES) : 'Ничего, я подожду. Дом никуда не денется.', ss.done ? 'cheer' : 'calm')}
      <h1>${ss.done ? 'Дом стал уютнее' : 'Хорошо, что заглянули'}</h1>
      <p class="mut">${ss.done ? `${dela(ss.done)} за ${mins} мин${zones.length ? ' · ' + esc(zones.join(', ')) : ''}` : 'Вернётесь, когда будут силы — дом подождёт.'}</p>
      ${ss.done ? `<p class="small mut">${note}</p>` : ''}
      <button class="btn primary wide" data-act="s-close">Спасибо</button>
    </div>`);
    return;
  }

  ss.doneIds = ss.doneIds || {};
  ss.mins = ss.mins || {};
  const step = ss.steps[ss.idx];
  const t = L.task(st, step.id);
  const paused = !!ss.pausedAt;
  // Долго не было (прогулка, звонок) — встречаем и начинаем шаг заново, а не показываем «45:08».
  const away = !paused && now() - ss.stepStart > Math.max(15, step.min * 3) * 60000;
  if (away) {
    ss.stepStart = now();
    cheer = 'С возвращением — продолжим';
    commit();
  }
  const prepAt = ss.prepAt[step.id];
  const waitLeft = step.kind === 'task' && t.wait && prepAt ? prepAt + t.wait * 60000 - now() : 0;
  const hasLater = ss.idx < ss.steps.length - 1;
  const prev = ss.steps[ss.idx - 1];
  const moved = step.kind === 'task' && prev && prev.kind === 'task' && prev.zone !== step.zone;
  const kit = step.kind === 'task' ? L.kitFor(t) : [];
  const isDone = step.kind === 'task' && ss.doneIds[step.id];
  const w = step.kind === 'task' ? L.why(t) : null;

  const top = `<div class="s-top">
      <button class="icon-btn" data-act="s-back" ${ss.idx ? '' : 'disabled'} aria-label="Предыдущий шаг">‹</button>
      <span class="s-tools">
        <button class="icon-btn ${paused ? 'on' : ''}" data-act="s-pause" aria-label="Пауза">${paused ? '▶' : 'Ⅱ'}</button>
        <button class="icon-btn" data-act="note" aria-label="Что неудобно">✎</button>
        ${soundBtn()}
      </span></div>
    <button class="s-prog" data-act="s-list" aria-label="Все шаги">${ss.steps
      .map((x, i) => `<i class="${ss.doneIds[x.id] && x.kind === 'task' ? 'done' : i === ss.idx ? 'cur' : i < ss.idx ? 'passed' : ''}"></i>`)
      .join('')}</button>`;

  if (paused) {
    clearInterval(tick);
    inner(`${top}
      <div class="s-body">
        ${say('Отдыхаем. Я подожду.', 'sleepy')}
        <div class="s-text">Пауза</div>
        <div class="s-hint">${esc(step.text)} · ${mmss(ss.pausedAt - ss.stepStart)} из ~${step.min} мин</div>
      </div>
      <div class="s-actions"><button class="btn primary" data-act="s-pause">Продолжить</button>
        <button class="btn ghost" data-act="s-stop">Хватит на сегодня</button></div>`);
    return;
  }

  if (isDone) {
    clearInterval(tick);
    inner(`${top}
      <div class="s-body">
        <div class="s-kind">${esc(zname(step.zone))}</div>
        <div class="s-text">${esc(step.text)}</div>
        <div class="ok-note">✓ Уже сделано</div>
      </div>
      <div class="s-actions">
        <button class="btn primary" data-act="s-next">Дальше</button>
        <button class="btn ghost" data-act="s-unmark">Снять отметку</button>
      </div>`);
    return;
  }

  inner(`${top}
    <div class="s-body">
      <div class="cheer-slot">${cheer ? say(cheer, 'cheer').replace('class="bubble"', 'class="bubble fade"') : `<div class="buddy">${mascot('calm')}</div>`}</div>
      <div class="s-kind ${step.kind}">${step.kind === 'prep' ? 'Сначала — пусть средство поработает' : (moved ? 'Переходим: ' : '') + esc(zname(step.zone))}</div>
      <div class="s-text pop">${esc(step.text)}</div>
      ${w ? `<div class="s-why"><b>Даст:</b> ${esc(w[0])}</div>` : ''}
      ${step.kind === 'task' && t.hint ? `<div class="s-hint">${esc(t.hint)}</div>` : ''}
      ${step.kind === 'prep' ? `<div class="s-hint">Пока оно действует ${t.wait} мин, займёмся другим.</div>` : ''}
      ${kit.length ? `<div class="s-hint small">Понадобится: ${esc(kit.join(', ').toLowerCase())}</div>` : ''}
      ${t.warn ? `<div class="s-warn">${esc(t.warn)}</div>` : ''}
      ${waitLeft > 0 ? `<div class="s-wait">Средство ещё действует: <b id="wait-left">${mmss(waitLeft)}</b>${hasLater ? ' — можно вернуться к этому позже.' : ''}</div>` : ''}
      ${w ? `<div class="s-why skip">Если пропустить: ${esc(w[1])}</div>` : ''}
      <div class="s-timer" id="s-timer">${timerText(step)}</div>
    </div>
    <div class="s-actions">
      <button class="btn primary" data-act="s-done">${step.kind === 'prep' ? 'Нанесено' : 'Готово'}</button>
      <div class="s-row">
        <button class="btn" data-act="s-later" ${hasLater ? '' : 'disabled'}>Позже</button>
        ${step.kind === 'task' ? '<button class="btn" data-act="s-already">Уже сделано</button>' : ''}
        <button class="btn ghost" data-act="s-skip">Пропустить</button>
      </div>
      <div class="s-links">
        ${step.kind === 'task' ? '<button class="link" data-act="task" data-id="' + step.id + '">Оценить дело</button>' : ''}
        <button class="link" data-act="s-stop">Хватит на сегодня</button>
      </div>
    </div>`);

  clearInterval(tick);
  tick = setInterval(() => {
    const tm = $('#s-timer');
    if (tm) tm.innerHTML = timerText(step);
    const wl = $('#wait-left');
    if (wl) {
      const rest = prepAt + t.wait * 60000 - now();
      if (rest <= 0) renderSession();
      else wl.textContent = mmss(rest);
    }
  }, 1000);
}

// «1:20 из ~5 мин», а когда дольше оценки — спокойный отсчёт сверх неё.
function timerText(step) {
  const el = now() - st.session.stepStart;
  const est = step.min * 60000;
  if (el <= est) return `${mmss(el)} из ~${step.min} мин`;
  return `~${step.min} мин и ещё <span class="over">+${mmss(el - est)}</span>`;
}

function openStepList() {
  const ss = st.session;
  $('#sheet').innerHTML = `<h2>Все шаги</h2>
    <div class="mut small">Нажмите на шаг, чтобы перейти к нему</div>
    <ul class="tl steps">${ss.steps
      .map((x, i) => {
        const done = x.kind === 'task' && ss.doneIds[x.id];
        const mark = done ? '✓' : i === ss.idx ? '●' : x.kind === 'prep' && ss.prepAt[x.id] ? '✓' : '○';
        return `<li class="${done ? 'is-done' : ''} ${i === ss.idx ? 'cur' : ''}"><span class="mark">${mark}</span>
          <button class="tt" data-act="s-jump" data-i="${i}">${esc(x.text)}<small>${x.kind === 'prep' ? 'подготовка' : esc(zname(x.zone))} · ~${x.min} мин</small></button></li>`;
      })
      .join('')}</ul>`;
  openSheetEl();
}

function sessionAct(act, el) {
  const ss = st.session;
  ss.doneIds = ss.doneIds || {};
  ss.mins = ss.mins || {};
  const step = ss.steps[ss.idx];
  cheer = '';
  if (act === 's-sound') {
    ambient.toggle();
    const b = $('.sound');
    if (b) b.outerHTML = soundBtn();
    return;
  }
  if (act === 's-list') return openStepList();
  if (act === 's-pause') {
    if (ss.pausedAt) {
      ss.stepStart += now() - ss.pausedAt; // пауза не считается во время шага
      ss.pausedAt = null;
    } else ss.pausedAt = now();
    commit();
    return renderSession();
  }
  if (act === 's-go') {
    ss.ready = true;
    ss.stepStart = now();
    lockScreen(true);
  } else if (act === 's-cancel') {
    st.session = null;
    ambient.stop();
    commit();
    renderSession();
    return render();
  } else if (act === 's-done') {
    if (step.kind === 'prep') {
      ss.prepAt[step.id] = now();
    } else {
      // Замер таймера учит приложение. Если шаг затянулся втрое — скорее отвлеклись, пишем оценку.
      const spent = (now() - ss.stepStart) / 60000;
      const real = spent <= step.min * 3;
      const min = real ? Math.max(0.5, Math.round(spent * 10) / 10) : step.min;
      L.complete(st, step.id, now(), min, real);
      ss.doneIds[step.id] = true;
      ss.mins[step.id] = min;
      ss.done++;
      ss.min += min;
      ss.zones.push(step.zone);
      cheer = `${pick(AFTER)} · +${L.entryPoints(st, st.log[st.log.length - 1])}`;
    }
    buzz(30);
    ss.idx++;
  } else if (act === 's-already') {
    // Сделано раньше, без таймера: засчитываем, но не учимся на времени. Для будущих очков — отдельный признак.
    L.complete(st, step.id, now(), step.min, false, true);
    ss.doneIds[step.id] = true;
    ss.mins[step.id] = 0;
    ss.done++;
    ss.zones.push(step.zone);
    cheer = `Отлично, одним делом меньше · +${L.entryPoints(st, st.log[st.log.length - 1])}`;
    ss.idx++;
  } else if (act === 's-next') {
    ss.idx++;
  } else if (act === 's-back') {
    if (ss.idx > 0) ss.idx--;
  } else if (act === 's-jump') {
    ss.idx = Number(el.dataset.i);
    closeSheet();
  } else if (act === 's-unmark') {
    L.undoComplete(st, step.id);
    delete ss.doneIds[step.id];
    ss.done--;
    ss.min -= ss.mins[step.id] || 0;
    ss.zones.splice(ss.zones.lastIndexOf(step.zone), 1);
  } else if (act === 's-later') {
    ss.steps.push(ss.steps.splice(ss.idx, 1)[0]);
  } else if (act === 's-skip') {
    ss.idx++;
  } else if (act === 's-stop') {
    ss.pausedAt = null;
    ss.idx = ss.steps.length;
  } else if (act === 's-close') {
    st.session = null;
    ambient.stop();
    commit();
    lockScreen(false);
    renderSession();
    render();
    return;
  }
  // Пропускаем уже сделанные шаги при движении вперёд — возвращаться к ним можно кнопкой «‹».
  if (act === 's-done' || act === 's-skip' || act === 's-next' || act === 's-already') {
    while (ss.idx < ss.steps.length && ss.steps[ss.idx].kind === 'task' && ss.doneIds[ss.steps[ss.idx].id]) ss.idx++;
  }
  ss.stepStart = now();
  commit();
  renderSession();
}

/* ---------- маршрутизация и события ---------- */

function render() {
  st._me = S.shared ? S.me : null;
  if (!st.setup) {
    renderSetup();
    return;
  }
  $('#setup').hidden = true;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  if (tab === 'now') renderNow();
  else if (tab === 'home') renderHome();
  else if (tab === 'score') renderScore();
  else renderSettings();
}

function goTab(name) {
  tab = name;
  render();
  window.scrollTo(0, 0);
}

document.addEventListener('click', (e) => {
  const tb = e.target.closest('#tabs button');
  if (tb) return goTab(tb.dataset.tab);
  if (e.target.id === 'sheet-bg') return closeSheet();

  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT') return;
  const { act, id } = el.dataset;

  if (act.startsWith('s-')) return sessionAct(act, el);
  switch (act) {
    case 'kit':
      return el.classList.toggle('got');
    case 'room': {
      const on = !roomOn(el.dataset.z);
      L.setZone(st, el.dataset.z, on, now());
      commit();
      return renderSetup();
    }
    case 'setup-next':
      setupStep++;
      return renderSetup();
    case 'setup-back':
      setupStep--;
      return renderSetup();
    case 'ago':
      L.startFrom(st, now(), Number(el.dataset.v));
      commit();
      tab = 'now';
      render();
      return toast('Добро пожаловать домой');
    case 'setup-keep':
      st.setup = true;
      commit();
      return render();
    case 'setup-again':
      st.setup = false;
      setupStep = 0;
      return render();
    case 'room-sheet':
      return openRoomSheet(el.dataset.z);
    case 'room-start':
      return startSession(Number(el.dataset.b), el.dataset.early === '1' ? 0 : L.DUE, el.dataset.z);
    case 'own-new':
      return openOwnForm(el.dataset.z);
    case 'own-edit':
      return openOwnForm(null, id);
    case 'own-set':
      form[el.dataset.k] = el.dataset.k === 'z' ? el.dataset.v : Number(el.dataset.v);
      return renderOwnForm();
    case 'own-save': {
      if (!form.t.trim()) return;
      const data = { z: form.z, t: form.t, every: form.every, min: form.min, soon: form.soon };
      if (form.id) L.editCustom(st, form.id, data);
      else L.addCustom(st, now(), data);
      commit();
      closeSheet();
      openZones.add(form.z);
      toast(form.id ? 'Сохранено' : 'Дело добавлено');
      return render();
    }
    case 'own-del':
      L.removeCustom(st, form.id);
      commit();
      closeSheet();
      toast('Дело удалено');
      return render();
    case 'rest-more':
      restMore = true;
      return render();
    case 'ritual-open':
      ritualOpen = !ritualOpen;
      return render();
    case 'ritual-switch':
      ritualView = el.dataset.w === L.currentRitual(now()) ? null : el.dataset.w;
      return render();
    case 'ritual':
      return startRitual(el.dataset.w);
    case 'when':
      st.when[id] = el.dataset.v;
      commit();
      openSheet(id);
      return render();
    case 'rt-ics':
      return downloadIcs();
    case 'pair-open':
      return openPairSheet();
    case 'pair-go':
      return pairGo();
    case 'sync-now':
      toast('Синхронизирую…');
      return S.syncNow().then((ok) => (render(), toast(ok ? 'Синхронизировано' : 'Нет связи — попробуйте позже')));
    case 'unpair':
      if (!arm('unpair')) return render();
      S.disconnect();
      toast('Телефон отключён от общего дома');
      return setTimeout(() => location.reload(), 800);
    case 'extra-open':
      return openExtra();
    case 'extra-min':
      document.querySelectorAll('[data-act="extra-min"]').forEach((b) => b.classList.toggle('on', b === el));
      return;
    case 'extra-save':
      return saveExtra();
    case 'proj-open':
      return openProject(id);
    case 'proj-step': {
      const p = projectList().find((x) => x.id === id);
      const steps = p.steps.map((x, i) => (i === Number(el.dataset.i) ? { ...x, done: !x.done } : x));
      buzz();
      return saveProject(p, { steps });
    }
    case 'proj-done': {
      const p = projectList().find((x) => x.id === id);
      confetti();
      toast('Проект готов — дом стал легче');
      return saveProject(p, { status: 'done', doneAt: now() });
    }
    case 'inbox-open':
      return openInbox();
    case 'inbox-save':
      return saveInbox();
    case 'chat-send':
      return sendChat();
    case 'note':
      return openNoteSheet();
    case 'note-save': {
      const txt = $('#note-text').value;
      if (!L.addNote(st, now(), txt, noteCtx)) return;
      commit();
      closeSheet();
      toast('Записано — поработаем над этим');
      return tab === 'settings' ? render() : undefined;
    }
    case 'note-done': {
      const n = st.notes.find((x) => x.id === id);
      n.done = !n.done;
      commit();
      return render();
    }
    case 'note-del':
      st.notes = st.notes.filter((x) => x.id !== id);
      commit();
      return render();
    case 'notes-clear':
      if (!arm('notes-clear')) return render();
      st.notes = [];
      commit();
      toast('Заметки очищены');
      return render();
    case 'reset-marks':
      if (!arm('reset-marks')) return render();
      return openResetSheet();
    case 'reset-ago':
      L.resetMarks(st, now());
      L.startFrom(st, now(), Number(el.dataset.v));
      commit();
      closeSheet();
      toast('Отметки сброшены');
      return render();
    case 'notes-copy':
      return copyNotes();
    case 'tab':
      return goTab(el.dataset.tab);
    case 'go-zone':
      openZones.add(el.dataset.z);
      goTab('home');
      return document.getElementById('zone-' + el.dataset.z)?.scrollIntoView({ block: 'start' });
    case 'start':
      return startSession(Number(el.dataset.b));
    case 'start-ahead':
      return startSession(15, 0);
    case 'task':
      return openSheet(id);
    case 'done':
      closeSheet();
      el.classList.add('done');
      markDone(id);
      return setTimeout(render, 250);
    case 'undo-today':
      // Повторное нажатие на отмеченное сегодня дело — снять отметку.
      L.undoComplete(st, id);
      commit();
      toast('Отметка снята');
      return render();
    case 'done-yday':
      closeSheet();
      markDone(id, now() - L.DAY);
      return render();
    case 'task-off':
      st.taskOff[id] = true;
      commit();
      closeSheet();
      toast('Убрано из списка — вернуть можно в настройках');
      return render();
    case 'task-on':
      delete st.taskOff[id];
      commit();
      return render();
    case 'freq': {
      const v = Number(el.dataset.v);
      if (v) st.every[id] = v;
      else delete st.every[id];
      commit();
      openSheet(id);
      render();
      return toast(`Сохранено: ${L.fmtEvery(L.effEvery(L.task(st, id), st))}`);
    }
    case 'assign': {
      const v = el.dataset.v;
      if (v) st.assign[id] = v;
      else delete st.assign[id];
      commit();
      openSheet(id);
      render();
      return toast(v ? (v === S.me ? 'Теперь это ваше дело' : `Теперь это дело — ${v}`) : 'Теперь дело общее');
    }
    case 'rate': {
      const t = L.task(st, id);
      const v = el.dataset.v;
      const f = L.rateTask(st, id, v, S.me, now());
      commit();
      if (v === 'no') {
        closeSheet();
        toast('Убрали из списка — вернуть можно в Настройках');
      } else {
        openSheet(id);
        toast(v === 'ok' ? 'Спасибо, учту' : `Теперь ${L.fmtEvery(f)}`);
      }
      if (st.session) renderSession();
      return render();
    }
    case 'sheet-close':
      return closeSheet();
    case 'pause-off':
      L.endPause(st, now());
      commit();
      return render();
    case 'export':
      return S.exportFile(st);
    case 'undo':
      if (toast.undo) toast.undo();
      $('#toast').hidden = true;
      return;
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  const act = el.dataset.act;
  if (act === 'own-soon') {
    form.soon = el.checked;
    return;
  }
  if (act === 'rt-on') st.remind[el.dataset.k].on = el.checked;
  else if (act === 'rt-time') st.remind[el.dataset.k].time = el.value || st.remind[el.dataset.k].time;
  else if (act === 'rt-day') st.remind.weekly.day = Number(el.value);
  else if (act === 'hh') st.household[el.dataset.k] = el.checked;
  else if (act === 'pet') {
    st.household[el.dataset.k] = el.checked;
    if (el.checked) L.seedMissing(st, now(), (t) => !!t.need || t.z === 'pets');
  } else if (act === 'petname') st.household[el.dataset.k] = el.value.trim();
  else if (act === 'merged') st.merged = el.checked;
  else if (act === 'zone') L.setZone(st, el.dataset.z, el.checked, now());
  else if (act === 'pause') (el.checked ? L.startPause : L.endPause)(st, now());
  else if (act === 'import' && el.files[0]) {
    S.importFile(el.files[0], now())
      .then((data) => {
        st = data;
        commit();
        toast('Копия загружена');
        render();
      })
      .catch((err) => toast(err.message || 'Не удалось прочитать файл'));
    return;
  } else return;
  commit();
  if (act === 'petname') return; // не перерисовывать, чтобы не терять фокус
  render();
});

// Имя питомца сохраняем по мере ввода, без перерисовки.
document.addEventListener('input', (e) => {
  if (e.target.dataset.act === 'buddy-name') {
    st.buddy = e.target.value.trim();
    commit();
    return;
  }
  if (e.target.dataset.act === 'search') {
    query = e.target.value;
    $('#zones').innerHTML = zonesHtml();
    return;
  }
  if (e.target.dataset.act === 'own-name') {
    form.t = e.target.value;
    const b = document.querySelector('[data-act="own-save"]');
    if (b) b.disabled = !form.t.trim();
    return;
  }
  if (e.target.dataset.act !== 'petname') return;
  st.household[e.target.dataset.k] = e.target.value.trim();
  commit();
});

// Запоминаем раскрытые зоны, чтобы после отметки список не схлопывался.
document.addEventListener(
  'toggle',
  (e) => {
    const z = e.target.dataset && e.target.dataset.zone;
    if (!z) return;
    if (e.target.open) openZones.add(z);
    else openZones.delete(z);
  },
  true,
);

// Вернулись в приложение (например, утром) — пересчитать сроки.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (st.session) {
    if (st.session.ready) lockScreen(true);
    renderSession();
  } else render();
});

if (!icsFromHash()) {
  render();
  if (st.session) renderSession();
}
S.askPersist();

// Внутри Claude: подключаем общую базу и чат. Чужие отметки приходят сами и перерисовывают экран.
S.connect(st, now(), onRemote, onRemoteStatus).then((ok) => {
  if (ok === true) {
    if (S.me && !(st.people || []).includes(S.me)) {
      st.people = [...(st.people || []), S.me];
      commit();
    }
    startChat();
    render();
  } else if (ok === 'wrong_key') toast('Ключ общего дома не подходит — проверьте в Настройках');
});

if (!S.inArtifact && 'serviceWorker' in navigator && location.protocol !== 'file:') {
  // Пришла новая версия — перезагрузиться один раз, чтобы не показывать старую.
  // Только если страницей уже управляла прежняя версия (при первой установке — не нужно).
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
