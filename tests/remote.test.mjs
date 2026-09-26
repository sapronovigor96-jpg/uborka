// Телефонная синхронизация через сервер дома: поддельный сервер с теми же правилами, два «телефона».
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePatch } from '../js/remote.js';

const KEY = 'test-key';

// Сервер как в server/src/index.js, только в памяти.
function makeServer() {
  const docs = new Map(); // path → { data, updated }
  let clock = 1000;
  let offline = false;
  const fetch = async (url, opts = {}) => {
    if (offline) throw new TypeError('fetch failed');
    const u = new URL(url);
    const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
    if (opts.headers['X-Home-Key'] !== KEY) return reply({ error: 'wrong_key' }, 401);
    const now = ++clock;
    if (opts.method === 'GET') {
      const since = Number(u.searchParams.get('since'));
      return reply({ now, docs: [...docs].filter(([, d]) => d.updated > since).map(([path, d]) => ({ path, data: d.data, updated: d.updated })) });
    }
    const path = u.searchParams.get('path');
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (opts.method === 'PUT') docs.set(path, { data: body.data, updated: now });
    if (opts.method === 'PATCH') docs.set(path, { data: mergePatch(docs.get(path)?.data || {}, body.patch), updated: now });
    if (opts.method === 'DELETE') docs.set(path, { data: null, updated: now });
    return reply({ ok: true, now });
  };
  return { docs, fetch, setOffline: (v) => (offline = v) };
}

// Отдельный «телефон»: своя память и своя копия модулей.
async function phone(server, name, n, key = KEY) {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  globalThis.fetch = server.fetch;
  delete globalThis.window;
  const S = await import(`../js/store.js?p=${n}`);
  const L = await import(`../js/logic.js?p=${n}`);
  S.setPairing({ key, name });
  return { S, L, mem, use: () => ((globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) }), (globalThis.fetch = server.fetch)) };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const NOW = Date.UTC(2026, 8, 27, 10);

test('первый телефон заливает дом, второй получает его и видит отметки первого', async () => {
  const srv = makeServer();
  const ivan = await phone(srv, 'Иван', 1);
  const stI = ivan.L.initState(NOW);
  stI.setup = true;
  stI.household.dogName = 'Эйрин';
  assert.equal(await ivan.S.connect(stI, NOW, () => {}), true);
  ivan.L.complete(stI, 'k-dishes', NOW, 10);
  ivan.S.save(stI);
  await settle();

  const masha = await phone(srv, 'Маша', 2);
  const stM = masha.L.initState(NOW);
  assert.equal(await masha.S.connect(stM, NOW, () => {}), true);
  assert.equal(stM.setup, true);
  assert.equal(stM.household.dogName, 'Эйрин');
  assert.equal(stM.last['k-dishes'], NOW);
  assert.equal(stM.log[0].by, 'Иван');
});

test('неверный ключ не подключает и не трогает данные телефона', async () => {
  const srv = makeServer();
  const p = await phone(srv, 'Кто-то', 3, 'чужой');
  const st = p.L.initState(NOW);
  assert.equal(await p.S.connect(st, NOW, () => {}), 'wrong_key');
  assert.equal(srv.docs.size, 0);
});

test('без сети отметки копятся и уходят, когда сеть появилась', async () => {
  const srv = makeServer();
  const ivan = await phone(srv, 'Иван', 4);
  const stI = ivan.L.initState(NOW);
  stI.setup = true;
  await ivan.S.connect(stI, NOW, () => {});
  await settle();

  srv.setOffline(true);
  ivan.L.complete(stI, 'pt-litter', NOW, 2);
  ivan.S.save(stI);
  await settle();
  assert.equal(srv.docs.get('home/last')?.data?.['pt-litter'], undefined, 'пока нет сети — на сервере нет');
  assert.ok(JSON.parse(ivan.mem.get('uborka.remote.outbox')).length > 0, 'отметка лежит в очереди');

  srv.setOffline(false);
  await ivan.S.syncNow();
  await settle();
  assert.equal(srv.docs.get('home/last').data['pt-litter'], NOW, 'после появления сети — на сервере');
});

test('чужая отметка приходит, а своя неотправленная не пропадает', async () => {
  const srv = makeServer();
  const ivan = await phone(srv, 'Иван', 5);
  const stI = ivan.L.initState(NOW);
  stI.setup = true;
  await ivan.S.connect(stI, NOW, () => {});
  await settle();
  const masha = await phone(srv, 'Маша', 6);
  const stM = masha.L.initState(NOW);
  await masha.S.connect(stM, NOW, () => {});

  masha.use();
  masha.L.complete(stM, 'k-trash', NOW, 2);
  masha.S.save(stM);
  await settle();

  ivan.use();
  srv.setOffline(true);
  ivan.L.complete(stI, 's-bed', NOW, 2);
  ivan.S.save(stI);
  srv.setOffline(false);
  await ivan.S.syncNow();
  await settle();
  assert.equal(stI.last['k-trash'], NOW, 'Иван видит мусор Маши');
  assert.equal(stI.last['s-bed'], NOW, 'своя кровать не пропала');
});

test('сообщение Claude из телефона попадает в общую базу', async () => {
  const srv = makeServer();
  const ivan = await phone(srv, 'Иван', 7);
  const stI = ivan.L.initState(NOW);
  stI.setup = true;
  await ivan.S.connect(stI, NOW, () => {});
  await ivan.S.database().collection('chat').doc('m1').set({ role: 'user', by: 'Иван', text: 'привет', at: NOW, status: 'saved' });
  await settle();
  assert.equal(srv.docs.get('chat/m1').data.text, 'привет');
});
