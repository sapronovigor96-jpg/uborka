// Синхронизация через общую базу: поддельная база в памяти и два «телефона».
import test from 'node:test';
import assert from 'node:assert/strict';

// Общая «база» как в артефакте: документы, update сливает поля, update без документа — ошибка.
function makeDb() {
  const docs = new Map();
  const subs = new Map();
  const notify = (path) => {
    for (const fn of subs.get(path) || []) fn(snap(path));
  };
  const snap = (path) => ({
    exists: docs.has(path),
    data: () => (docs.has(path) ? structuredClone(docs.get(path)) : undefined),
    metadata: { hasPendingWrites: false, fromCache: false },
  });
  const merge = (a, b) => {
    for (const [k, v] of Object.entries(b)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') merge(a[k], v);
      else a[k] = v;
    }
  };
  return {
    docs,
    doc: (path) => ({
      get: async () => snap(path),
      set: async (d) => {
        docs.set(path, structuredClone(d));
        notify(path);
      },
      update: async (d) => {
        if (!docs.has(path)) throw { code: 'invalid_argument' };
        merge(docs.get(path), structuredClone(d));
        notify(path);
      },
      onSnapshot: (fn) => {
        subs.set(path, [...(subs.get(path) || []), fn]);
        return () => {};
      },
    }),
  };
}

// Загрузить отдельную копию модулей — как отдельный телефон.
async function phone(db, userId, n) {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  globalThis.window = { claude: { use: async (name) => (name === 'db' ? db : name === 'user' ? { id: async () => userId } : null) } };
  const S = await import(`../js/store.js?phone=${n}`);
  const L = await import(`../js/logic.js?phone=${n}`);
  return { S, L };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const NOW = Date.UTC(2026, 8, 27, 10);

test('первый телефон переносит дом в общую базу, второй получает его', async () => {
  const db = makeDb();
  const a = await phone(db, 'u_ivan', 1);
  const stA = a.L.initState(NOW);
  stA.setup = true;
  stA.household.catName = 'Тони';
  await a.S.connect(stA, NOW, () => {});
  await settle();
  assert.ok(db.docs.has('home/state'));

  const b = await phone(db, 'u_masha', 2);
  const stB = b.L.initState(NOW);
  await b.S.connect(stB, NOW, () => {});
  assert.equal(stB.setup, true);
  assert.equal(stB.household.catName, 'Тони');
});

test('двое отмечают разные дела одновременно — не затирают друг друга', async () => {
  const db = makeDb();
  const a = await phone(db, 'u_ivan', 3);
  const stA = a.L.initState(NOW);
  stA.setup = true;
  await a.S.connect(stA, NOW, () => {});
  await settle();
  const b = await phone(db, 'u_masha', 4);
  const stB = b.L.initState(NOW);
  await b.S.connect(stB, NOW, () => {});

  a.L.complete(stA, 'k-dishes', NOW, 10);
  b.L.complete(stB, 'pt-litter', NOW, 2);
  a.S.save(stA);
  b.S.save(stB);
  await settle();

  assert.equal(stA.last['pt-litter'], NOW, 'Иван видит, что Маша убрала лоток');
  assert.equal(stB.last['k-dishes'], NOW, 'Маша видит посуду Ивана');
  assert.equal(stA.log.length, 2);
  const who = Object.fromEntries(stA.log.map((e) => [e.id, e.by]));
  assert.deepEqual(who, { 'k-dishes': 'u_ivan', 'pt-litter': 'u_masha' });
});

test('отмена отметки доходит до второго телефона', async () => {
  const db = makeDb();
  const a = await phone(db, 'u_ivan', 5);
  const stA = a.L.initState(NOW);
  stA.setup = true;
  await a.S.connect(stA, NOW, () => {});
  await settle();
  const b = await phone(db, 'u_masha', 6);
  const stB = b.L.initState(NOW);
  await b.S.connect(stB, NOW, () => {});

  a.L.complete(stA, 'k-trash', NOW, 2);
  a.S.save(stA);
  await settle();
  assert.equal(stB.last['k-trash'], NOW);

  a.L.undoComplete(stA, 'k-trash');
  a.S.save(stA);
  await settle();
  assert.equal(stB.last['k-trash'], undefined);
  assert.equal(stB.log.length, 0);
});

test('незавершённая уборка остаётся на своём телефоне', async () => {
  const db = makeDb();
  const a = await phone(db, 'u_ivan', 7);
  const stA = a.L.initState(NOW);
  stA.setup = true;
  stA.session = { steps: [], idx: 0 };
  await a.S.connect(stA, NOW, () => {});
  a.S.save(stA);
  await settle();
  assert.ok(!('session' in db.docs.get('home/state')));
});
