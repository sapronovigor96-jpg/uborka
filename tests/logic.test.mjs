import test from 'node:test';
import assert from 'node:assert/strict';
import { TASKS, ZONES } from '../js/data.js';
import * as L from '../js/logic.js';

const NOW = Date.UTC(2026, 8, 25, 9);
const fresh = () => L.initState(NOW);

test('данные: id уникальны, зоны существуют, prep всегда с wait', () => {
  const ids = new Set();
  const zones = new Set(ZONES.map((z) => z.id));
  for (const t of TASKS) {
    assert.ok(!ids.has(t.id), `дубль ${t.id}`);
    ids.add(t.id);
    assert.ok(zones.has(t.z), `${t.id}: нет зоны ${t.z}`);
    assert.ok(t.every >= 1 && t.min >= 1, t.id);
    if (t.prep) assert.ok(t.wait > 0, `${t.id}: prep без wait`);
  }
});


test('отключённые зоны не попадают в задачи', () => {
  const st = fresh();
  assert.ok(!L.activeTasks(st).some((t) => t.z === 'kids'));
  L.setZone(st, 'kids', true, NOW);
  assert.ok(L.activeTasks(st).some((t) => t.z === 'kids'));
});

test('сессия укладывается в бюджет и соблюдает порядок профи', () => {
  const st = fresh();
  const later = NOW + 30 * L.DAY; // всё накопилось
  const steps = L.buildSession(st, later, 60);
  assert.ok(L.sessionMinutes(steps) <= 60);
  assert.ok(steps.length > 3);
  const firstTask = steps.findIndex((s) => s.kind === 'task');
  // все подготовки — до первой задачи
  assert.ok(steps.slice(firstTask).every((s) => s.kind === 'task'));
  // пол — в самом конце
  const isFloor = (s) => (L.task(st, s.id).tags || []).includes('floor');
  const firstFloor = steps.findIndex(isFloor);
  if (firstFloor >= 0) assert.ok(steps.slice(firstFloor).every(isFloor));
});

test('после долгого перерыва ежедневное не вытесняет унитаз', () => {
  const st = fresh();
  const steps = L.buildSession(st, NOW + 20 * L.DAY, 40);
  assert.ok(steps.some((s) => s.id === 'b-toilet' && s.kind === 'task'));
  assert.ok(steps.some((s) => s.id === 'b-toilet' && s.kind === 'prep'));
});

test('если срочного мало, большой бюджет добирает «заранее»', () => {
  const st = fresh();
  const n10 = L.buildSession(st, NOW, 10).length;
  const n60 = L.buildSession(st, NOW, 60).length;
  assert.ok(n60 > n10);
});

test('после выполнения задача перестаёт быть срочной', () => {
  const st = fresh();
  const later = NOW + 10 * L.DAY;
  const t = L.taskById['b-toilet'];
  assert.ok(L.urgency(t, st, later) >= 1);
  L.complete(st, t.id, later, 7);
  assert.equal(L.urgency(t, st, later), 0);
  assert.equal(L.stats(st, later).tasks, 1);
});

test('отмена возвращает прежнюю дату', () => {
  const st = fresh();
  const prev = st.last['k-dishes'];
  L.complete(st, 'k-dishes', NOW, 10);
  L.undoComplete(st, 'k-dishes', prev);
  assert.equal(st.last['k-dishes'], undefined);
  assert.equal(st.log.length, 0);
});

test('отпуск замораживает срочность', () => {
  const st = fresh();
  const t = L.taskById['l-floor'];
  const before = L.urgency(t, st, NOW);
  L.startPause(st, NOW);
  assert.equal(L.urgency(t, st, NOW + 14 * L.DAY), before);
  L.endPause(st, NOW + 14 * L.DAY);
  assert.ok(Math.abs(L.urgency(t, st, NOW + 14 * L.DAY) - before) < 1e-9);
});

test('питомцы учащают пол, ручная частота важнее', () => {
  const st = fresh();
  const floor = L.taskById['l-floor'];
  assert.equal(L.effEvery(floor, st), 7);
  st.household.dog = true;
  assert.equal(L.effEvery(floor, st), 3.5);
  st.every['l-floor'] = 5;
  assert.equal(L.effEvery(floor, st), 5);
});

test('задачи питомцев появляются только с питомцем и с его именем', () => {
  const st = fresh();
  assert.ok(!L.activeTasks(st).some((t) => t.need));
  st.household.cat = true;
  st.household.catName = 'Тони';
  L.seedMissing(st, NOW, (t) => t.need);
  const litter = L.activeTasks(st).find((t) => t.id === 'pt-litter');
  assert.ok(litter);
  assert.equal(L.label(litter, st), 'Лоток Тони: убрать комки');
  assert.ok(!L.activeTasks(st).some((t) => t.need === 'dog'));
  assert.equal(L.zoneLabel(st, 'pets'), 'Тони');
  // только что заведённый питомец не приносит сразу просроченных дел
  assert.ok(!L.dueTasks(st, NOW).some((x) => x.t.need));
});

test('кухня-гостиная: одна зона, задачи гостиной не теряются', () => {
  const st = fresh();
  const before = L.activeTasks(st).length;
  st.merged = true;
  assert.equal(L.activeTasks(st).length, before);
  assert.ok(!L.zonesShown(st).some((z) => z.id === 'living'));
  assert.equal(L.zoneLabel(st, 'kitchen'), 'Кухня-гостиная');
  const steps = L.buildSession(st, NOW + 30 * L.DAY, 60);
  assert.ok(steps.every((s) => s.zone !== 'living'));
});

test('в первый день ничего не просрочено', () => {
  const st = fresh();
  st.household.dog = true;
  st.household.cat = true;
  assert.equal(L.dueTasks(st, NOW).length, 0);
});

test('знакомство «давно» даёт честный старт с делами', () => {
  const st = fresh();
  L.startFrom(st, NOW, 2);
  assert.ok(st.setup);
  assert.ok(L.dueTasks(st, NOW).length > 5);
});

test('короткая уборка не гоняет по всей квартире', () => {
  const st = fresh();
  L.startFrom(st, NOW, 1);
  const steps = L.buildSession(st, NOW, 15);
  const rooms = new Set(steps.map((s) => s.zone));
  assert.ok(rooms.size <= 3, `комнат: ${rooms.size}`);
});

test('список «что взять» без повторов', () => {
  const st = fresh();
  const steps = L.buildSession(st, NOW + 20 * L.DAY, 60);
  const kit = L.sessionKit(steps);
  assert.equal(new Set(kit).size, kit.length);
  assert.ok(kit.length > 0);
});

test('normalize чинит битое и чужое состояние', () => {
  assert.equal(L.normalize(null, NOW).v, 1);
  assert.equal(L.normalize({ v: 99 }, NOW).log.length, 0);
  const st = L.normalize({ v: 1, household: { pets: true } }, NOW);
  assert.equal(st.household.kids, false);
  assert.equal(st.household.pets, true);
});

test('русские окончания', () => {
  assert.equal(L.fmtAgo(3 * L.DAY), '3 дня назад');
  assert.equal(L.fmtAgo(11 * L.DAY), '11 дней назад');
  assert.equal(L.fmtAgo(21 * L.DAY), '21 день назад');
  assert.equal(L.fmtEvery(90), 'раз в 3 месяца');
});

test('своё дело: добавить, найти, попасть в уборку, изменить, удалить', () => {
  const st = fresh();
  const id = L.addCustom(st, NOW, { z: 'living', t: '  Полить монстеру ', every: 7, min: 5, soon: true });
  const t = L.task(st, id);
  assert.equal(t.t, 'Полить монстеру');
  assert.ok(L.activeTasks(st).includes(t));
  assert.ok(L.urgency(t, st, NOW) >= 1);
  assert.ok(L.buildSession(st, NOW, 15, L.DUE, 'living').some((s) => s.id === id));
  L.editCustom(st, id, { z: 'bedroom', t: 'Полить фикус', every: 3, min: 2 });
  assert.equal(L.task(st, id).z, 'bedroom');
  L.removeCustom(st, id);
  assert.equal(L.task(st, id), undefined);
  assert.equal(st.last[id], undefined);
});

test('своё дело без «сейчас» не висит срочным', () => {
  const st = fresh();
  const id = L.addCustom(st, NOW, { z: 'bath', t: 'Протереть стиралку', every: 14, min: 5, soon: false });
  assert.ok(L.urgency(L.task(st, id), st, NOW) < L.DUE);
});

test('уборка одной комнаты не выходит за её пределы', () => {
  const st = fresh();
  L.startFrom(st, NOW, 2);
  const steps = L.buildSession(st, NOW, 30, L.DUE, 'bath');
  assert.ok(steps.length > 0);
  assert.ok(steps.every((s) => s.zone === 'bath'));
});

test('свои дела переживают сохранение и загрузку', () => {
  const st = fresh();
  L.addCustom(st, NOW, { z: 'hall', t: 'Зонты просушить', every: 7, min: 2 });
  const back = L.normalize(JSON.parse(JSON.stringify(st)), NOW);
  assert.equal(back.custom.length, 1);
});

test('«нужно уже сейчас» попадает даже в 5-минутную уборку, пока не сделано', () => {
  const st = fresh();
  L.startFrom(st, NOW, 2);
  const id = L.addCustom(st, NOW, { z: 'balcony', t: 'Убрать зимние шины', every: 30, min: 5, soon: true });
  L.setZone(st, 'balcony', true, NOW);
  assert.ok(L.buildSession(st, NOW, 5).some((s) => s.id === id));
  L.complete(st, id, NOW, 5);
  assert.equal(L.task(st, id).soon, false);
});

test('распорядок: утро и вечер разделены, сделанное сегодня выпадает', () => {
  const st = fresh();
  st.household.cat = true;
  const morning = L.ritual(st, 'morning').map((t) => t.id);
  const evening = L.ritual(st, 'evening').map((t) => t.id);
  assert.ok(morning.includes('s-bed'));
  assert.ok(evening.includes('k-dishes') && evening.includes('pt-litter'));
  assert.ok(!morning.some((id) => evening.includes(id)));
  L.complete(st, 's-bed', NOW, 2);
  assert.ok(!L.ritualSteps(st, 'morning', NOW).some((s) => s.id === 's-bed'));
  st.when['k-dishes'] = 'morning';
  assert.ok(L.ritual(st, 'morning').some((t) => t.id === 'k-dishes'));
});

test('календарь: три события, повторы, напоминание, переносы строк по стандарту', () => {
  const st = fresh();
  const ics = L.makeIcs(st, NOW, 'https://example.org/uborka/');
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 3);
  assert.ok(ics.includes('RRULE:FREQ=DAILY'));
  assert.ok(/RRULE:FREQ=WEEKLY;BYDAY=SA/.test(ics));
  assert.ok(ics.includes('TRIGGER:PT0M'));
  assert.ok(ics.includes('DTSTART:') && ics.includes('T083000'));
  const enc = new TextEncoder();
  for (const line of ics.split('\r\n')) assert.ok(enc.encode(line).length <= 75, line);
  st.remind.morning.on = false;
  assert.equal((L.makeIcs(st, NOW).match(/BEGIN:VEVENT/g) || []).length, 2);
});

test('заметки: пустая не сохраняется, текст для копирования только из открытых', () => {
  const st = fresh();
  assert.equal(L.addNote(st, NOW, '   ', ''), null);
  L.addNote(st, NOW, 'Кнопка «Позже» мелкая', 'Уборка · Унитаз');
  L.addNote(st, NOW + 1, 'Уже поправили', '');
  st.notes[1].done = true;
  const txt = L.notesText(st);
  assert.ok(txt.includes('Кнопка «Позже» мелкая') && txt.includes('[Уборка · Унитаз]'));
  assert.ok(!txt.includes('Уже поправили'));
});

test('отмена возвращает точную прежнюю дату, даже стартовую', () => {
  const st = fresh();
  L.setZone(st, 'balcony', true, NOW);
  const seeded = st.last['p-sweep'];
  L.complete(st, 'p-sweep', NOW + L.DAY, 5);
  L.complete(st, 'p-sweep', NOW + 2 * L.DAY, 5);
  L.undoComplete(st, 'p-sweep');
  assert.equal(st.last['p-sweep'], NOW + L.DAY);
  L.undoComplete(st, 'p-sweep');
  assert.equal(st.last['p-sweep'], seeded);
});

test('отметить — снять — отметить снова работает', () => {
  const st = fresh();
  L.complete(st, 'k-trash', NOW, 2);
  L.undoComplete(st, 'k-trash');
  L.complete(st, 'k-trash', NOW, 2);
  assert.equal(st.last['k-trash'], NOW);
  assert.equal(st.log.filter((e) => e.id === 'k-trash').length, 1);
});

test('длительность учится на замерах таймера, а не на ручных отметках', () => {
  const st = fresh();
  const t = L.task(st, 'b-toilet');
  assert.equal(L.effMin(t, st), 7);
  L.complete(st, t.id, NOW, 12, false);
  L.complete(st, t.id, NOW, 12, false);
  L.complete(st, t.id, NOW, 12, false);
  assert.equal(L.effMin(t, st), 7);
  L.complete(st, t.id, NOW, 11, true);
  L.complete(st, t.id, NOW, 13, true);
  L.complete(st, t.id, NOW, 12, true);
  assert.equal(L.effMin(t, st), 12);
});

test('у каждого дела из базы есть «даст» и «если пропустить»', () => {
  for (const t of TASKS) {
    const w = L.why(t);
    assert.ok(w && w[0] && w[1], `нет пояснения для ${t.id}`);
  }
});

test('сброс отметок: история пуста, настройки дома на месте', () => {
  const st = fresh();
  st.household.cat = true;
  L.addCustom(st, NOW, { z: 'bath', t: 'Своё', every: 7, min: 5, soon: true });
  L.addNote(st, NOW, 'заметка', '');
  L.complete(st, 'k-dishes', NOW, 10);
  L.resetMarks(st, NOW + L.DAY);
  assert.equal(st.log.length, 0);
  assert.deepEqual(st.last, {});
  assert.equal(st.household.cat, true);
  assert.equal(st.custom.length, 1);
  assert.equal(st.custom[0].soon, false);
  assert.equal(st.notes.length, 1);
});

test('«уже сделано» засчитывается, но не учит длительность', () => {
  const st = fresh();
  const t = L.task(st, 'b-toilet');
  for (let i = 0; i < 4; i++) L.complete(st, t.id, NOW, 30, false, true);
  assert.equal(L.effMin(t, st), t.min);
  assert.ok(st.log.every((e) => e.pre));
});

test('день для мелочей начинается в 4 утра', () => {
  const late = new Date(2026, 8, 26, 23, 30).getTime();
  const night = new Date(2026, 8, 27, 1, 0).getTime();
  const morning = new Date(2026, 8, 27, 8, 0).getTime();
  assert.ok(L.sameDay(late, night), 'вечер и час ночи — один день');
  assert.ok(!L.sameDay(night, morning), 'утро — уже новый день');
  assert.equal(L.currentRitual(night), 'evening');
  assert.equal(L.currentRitual(morning), 'morning');
});

test('оценка дела: «слишком часто» сдвигает частоту на шаг, «не про нас» убирает, оценка сохраняется', () => {
  const st = fresh();
  assert.equal(L.rateTask(st, 'b-mirror', 'often', 'Игорь', NOW), 14);
  assert.equal(L.effEvery(L.task(st, 'b-mirror'), st), 14);
  assert.equal(L.rateTask(st, 'k-micro', 'rare', 'Маша', NOW), 3);
  L.rateTask(st, 'l-plants', 'no', 'Маша', NOW);
  assert.ok(st.taskOff['l-plants']);
  L.rateTask(st, 's-bed', 'ok', 'Игорь', NOW);
  assert.deepEqual(Object.keys(st.fb).sort(), ['b-mirror', 'k-micro', 'l-plants', 's-bed']);
  assert.equal(st.fb['k-micro'].by, 'Маша');
});

test('сброс с выбором «давно» показывает честную картину, а не «всё уютно»', () => {
  const st = fresh();
  L.resetMarks(st, NOW);
  L.startFrom(st, NOW, 2);
  assert.ok(L.homeHealth(st, NOW) < 0.6);
});

test('очки: минуты × сложность, «уже сделано» +25%, записываются в журнал', () => {
  const st = fresh();
  assert.equal(L.points(L.task(st, 's-clothes')), 3); // лёгкое ×1
  assert.equal(L.points(L.task(st, 'b-toilet')), 11); // гигиена 7 × 1,5
  assert.equal(L.points(L.task(st, 'k-oven')), 60); // тяжёлое 30 × 2
  assert.equal(L.points(L.task(st, 's-clothes'), true), 4); // 3 × 1,25
  L.complete(st, 'b-toilet', NOW, 7);
  assert.equal(st.log[0].pts, 11);
});

test('неделя начинается в понедельник в 4:00', () => {
  const sunNight = new Date(2026, 8, 28, 2, 0).getTime(); // пн 28.09, 02:00 — ещё прошлая неделя
  const monMorning = new Date(2026, 8, 28, 9, 0).getTime();
  assert.equal(new Date(L.weekStart(monMorning)).getDate(), 28);
  assert.equal(new Date(L.weekStart(sunNight)).getDate(), 21);
});

test('счёт недели: дела и оценённые «сверх списка» по людям', () => {
  const st = fresh();
  const from = L.weekStart(NOW);
  L.complete(st, 'b-toilet', NOW, 7);
  st.log[0].by = 'Игорь';
  L.complete(st, 'pt-litter', NOW, 2);
  st.log[1].by = 'Маша';
  const extras = [
    { by: 'Маша', pts: 20, at: NOW, status: 'rated' },
    { by: 'Маша', pts: 99, at: NOW, status: 'pending' },
  ];
  const board = L.scoreboard(st, extras, from, from + 7 * L.DAY);
  assert.deepEqual(board.map((r) => [r.by, r.pts]), [['Маша', 23], ['Игорь', 11]]);
});

test('общий список: дело, которое взяла Маша, видно всем, но в мою уборку и шаги не попадает', () => {
  const st = fresh();
  L.startFrom(st, NOW, 2);
  st.assign['k-trash'] = 'Маша';
  st._me = 'Игорь';
  assert.ok(L.dueTasks(st, NOW).some((x) => x.t.id === 'k-trash'), 'в списке видно');
  assert.ok(!L.buildSession(st, NOW, 999).some((x) => x.id === 'k-trash'), 'в мою уборку не берётся');
  st._me = 'Маша';
  assert.ok(L.buildSession(st, NOW, 999).some((x) => x.id === 'k-trash'), 'у Маши берётся');
  st.assign['s-cups'] = 'Маша';
  st._me = 'Игорь';
  assert.ok(L.ritual(st, 'evening').some((t) => t.id === 's-cups'), 'в ритуале видно');
  assert.ok(!L.ritualSteps(st, 'evening', NOW).some((x) => x.id === 's-cups'), 'по шагам — не мне');
});

test('составные дела разделены: в названии одно действие', () => {
  const t = (id) => TASKS.find((x) => x.id === id).t;
  assert.equal(t('k-counters'), 'Протереть столешницу');
  assert.ok(TASKS.some((x) => x.id === 'k-splash') && TASKS.some((x) => x.id === 'l-leaves'));
});

test('свой план: предлагает дела, в том числе заранее; порядок — профи; реальное время — медиана замеров', () => {
  const st = fresh();
  L.startFrom(st, NOW, 2);
  const pool = L.planPool(st, NOW);
  assert.ok(pool.length > 0);
  assert.ok(pool.every((x) => L.effEvery(x.t, st) > 1), 'ежедневных мелочей в плане нет');
  st.assign[pool[0].t.id] = 'Маша';
  st._me = 'Игорь';
  assert.ok(!L.planPool(st, NOW).some((x) => x.t.id === pool[0].t.id), 'взятое Машей не предлагается');
  const steps = L.planSteps(st, pool.slice(1, 4).map((x) => x.t.id));
  assert.equal(steps.filter((x) => x.kind === 'task').length, 3);
  const id = pool[1].t.id;
  const P = pool[1].t.min;
  for (const m of [P, P + 1, P * 2]) L.complete(st, id, NOW, m, true);
  L.complete(st, id, NOW, P * 4, true); // забытый таймер — не считается
  L.complete(st, id, NOW, 30, false);
  const r = L.realTimes(st).find((x) => x.t.id === id);
  assert.equal(r.real, P + 1);
  assert.equal(r.n, 3);
  assert.ok(!L.honest(0.5, 15), '«Готово» через полминуты у 15-минутного дела — не замер');
  assert.ok(L.honest(0.5, 1));
  assert.equal(st.log[st.log.length - 1].pts, L.points(pool[1].t), 'очки не зависят от времени');
});

test('план по фото: шаги из списка и разовые, сделанное не повторяется', () => {
  const st = fresh();
  const plan = { id: 'f1', steps: [{ z: 'bath', t: 'Полотенце с пола — в стирку', min: 1 }, { z: 'kitchen', t: 'Плита', min: 3, id: 'k-hob' }, { z: 'hall', t: 'Коробку к двери', min: 2, id: 'нет-такого' }], done: { 0: true } };
  const steps = L.photoSteps(plan, st);
  assert.deepEqual(steps.map((s) => [s.id, s.adhoc, s.pi]), [['k-hob', false, 1], ['pl-f1-2', true, 2]]);
  assert.equal(L.sessionMinutes(steps), 5);
  assert.ok(Array.isArray(L.sessionKit(steps, st)), 'корзинка собирается и для разовых шагов');
});
