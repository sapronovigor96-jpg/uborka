// Связь телефона с сервером дома (Cloudflare). Снаружи выглядит как база артефакта:
// doc(path).get/set/update/onSnapshot и collection(path)…onSnapshot — поэтому store.js работает с обеими.
//
// Работает без интернета: копия базы и очередь изменений лежат в localStorage.
// Изменения уходят на сервер по очереди, как только есть связь; чужие изменения забираются
// раз в 30 секунд, при возврате в приложение и при появлении сети.

const CACHE_KEY = 'uborka.remote.cache';
const OUTBOX_KEY = 'uborka.remote.outbox';
const POLL_MS = 30000;
const OVERLAP_MS = 5000; // забираем с запасом: запись могла прийти одновременно с прошлым опросом

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// RFC 7396: объекты сливаются рекурсивно, null удаляет поле — так же, как на сервере.
export function mergePatch(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return clone(patch);
  const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

function readLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeLS(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* память переполнена или запрещена — работаем без сохранения очереди */
  }
}

export function makeHttpDb(url, key, onStatus = () => {}) {
  const saved = readLS(CACHE_KEY, { since: 0, docs: {}, url: '' });
  const fresh = saved.url !== url; // другой сервер — старая копия не годится
  let since = fresh ? 0 : saved.since;
  const cache = new Map(fresh ? [] : Object.entries(saved.docs));
  let outbox = fresh ? [] : readLS(OUTBOX_KEY, []);
  const docSubs = new Map(); // path → [fn]
  const colSubs = []; // { prefix, order, dir, limit, fn }
  const status = { online: false, wrongKey: false, lastSync: 0, pending: outbox.length, error: '' };
  let flushing = false;
  let timer = null;
  let stopped = false;

  const persist = () => {
    writeLS(CACHE_KEY, { since, docs: Object.fromEntries(cache), url });
    writeLS(OUTBOX_KEY, outbox);
    status.pending = outbox.length;
    onStatus({ ...status });
  };

  const pendingOn = (path) => outbox.some((o) => o.path === path);
  const snap = (path) => ({
    id: path.split('/').pop(),
    exists: cache.has(path),
    data: () => clone(cache.get(path)),
    metadata: { hasPendingWrites: pendingOn(path), fromCache: !status.online },
  });

  function notify(paths) {
    for (const p of paths) for (const fn of docSubs.get(p) || []) fn(snap(p));
    for (const s of colSubs) if (paths.some((p) => p.startsWith(s.prefix))) s.fn(query(s));
  }

  function query(s) {
    let docs = [...cache.keys()]
      .filter((p) => p.startsWith(s.prefix) && p.slice(s.prefix.length).indexOf('/') === -1)
      .map(snap);
    if (s.order) {
      const f = s.order;
      docs.sort((a, b) => ((a.data()[f] ?? Infinity) > (b.data()[f] ?? Infinity) ? 1 : -1) * (s.dir === 'desc' ? -1 : 1));
    }
    if (s.limit) docs = s.dir === 'desc' ? docs.slice(0, s.limit) : docs.slice(-s.limit);
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { hasPendingWrites: false, fromCache: !status.online } };
  }

  // Применить операцию к локальной копии.
  function applyOp(o) {
    if (o.op === 'put') cache.set(o.path, clone(o.body.data));
    else if (o.op === 'patch') cache.set(o.path, mergePatch(cache.get(o.path) || {}, o.body.patch));
    else cache.delete(o.path);
  }

  async function call(method, path, body) {
    const res = await fetch(url + path, {
      method,
      headers: { 'X-Home-Key': key, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (res.status === 401) {
      status.wrongKey = true;
      throw new Error('wrong_key');
    }
    if (!res.ok) throw new Error('http_' + res.status);
    status.wrongKey = false;
    return res.json();
  }

  async function flush() {
    if (stopped || flushing || status.wrongKey) return;
    flushing = true;
    try {
      while (outbox.length) {
        const o = outbox[0];
        const q = '/doc?path=' + encodeURIComponent(o.path);
        await call(o.op === 'put' ? 'PUT' : o.op === 'patch' ? 'PATCH' : 'DELETE', q, o.op === 'delete' ? null : o.body);
        outbox.shift();
        persist();
        if (!pendingOn(o.path)) notify([o.path]); // запись подтверждена — снимок без «ожидающих»
      }
      status.online = true;
      status.error = '';
    } catch (e) {
      status.online = false;
      status.error = String(e.message || e);
      schedule(20000);
    } finally {
      flushing = false;
      persist();
    }
  }

  async function pull() {
    if (stopped) return false;
    try {
      const res = await call('GET', '/docs?since=' + Math.max(0, since - OVERLAP_MS));
      const changed = [];
      for (const d of res.docs) {
        const before = JSON.stringify(cache.get(d.path));
        if (d.data === null) cache.delete(d.path);
        else cache.set(d.path, d.data);
        // Свои ещё не отправленные изменения накладываем поверх — сервер их пока не видел.
        for (const o of outbox) if (o.path === d.path) applyOp(o);
        if (JSON.stringify(cache.get(d.path)) !== before) changed.push(d.path);
      }
      since = res.now;
      status.online = true;
      status.lastSync = Date.now();
      status.error = '';
      persist();
      if (changed.length) notify(changed);
      return true;
    } catch (e) {
      status.online = false;
      status.error = String(e.message || e);
      persist();
      return false;
    }
  }

  function schedule(ms = POLL_MS) {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(async () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        await flush();
        await pull();
      }
      schedule();
    }, ms);
  }

  function write(o) {
    outbox.push(o);
    applyOp(o);
    persist();
    notify([o.path]);
    flush();
    return Promise.resolve();
  }

  const docRef = (path) => ({
    id: path.split('/').pop(),
    path,
    get: async () => snap(path),
    set: (data) => write({ op: 'put', path, body: { data: clone(data) } }),
    // Сервер создаёт документ, если его нет, поэтому update здесь никогда не падает.
    update: (patch) => write({ op: 'patch', path, body: { patch: clone(patch) } }),
    delete: () => write({ op: 'delete', path }),
    onSnapshot(fn) {
      docSubs.set(path, [...(docSubs.get(path) || []), fn]);
      queueMicrotask(() => fn(snap(path)));
      return () => docSubs.set(path, (docSubs.get(path) || []).filter((f) => f !== fn));
    },
  });

  const colRef = (path, s = { prefix: path + '/', order: null, dir: 'asc', limit: 0 }) => ({
    path,
    orderBy: (field, dir = 'asc') => colRef(path, { ...s, order: field, dir }),
    limit: (n) => colRef(path, { ...s, limit: n }),
    doc: (id) => docRef(path + '/' + (id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6))),
    get: async () => query(s),
    onSnapshot(fn) {
      const sub = { ...s, fn };
      colSubs.push(sub);
      queueMicrotask(() => fn(query(sub)));
      return () => colSubs.splice(colSubs.indexOf(sub), 1);
    },
  });

  const wake = () => !stopped && flush().then(pull);
  const onVisible = () => document.visibilityState === 'visible' && wake();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', wake);
  }

  return {
    upserts: true,
    status: () => ({ ...status }),
    // Первое подключение: отправить накопленное и забрать свежее. false — сервер недоступен.
    ready: async () => {
      await flush();
      const ok = await pull();
      schedule();
      return ok;
    },
    syncNow: async () => {
      await flush();
      return pull();
    },
    // Остановить: без опросов и отправки (телефон отключили или ключ не подошёл).
    stop() {
      stopped = true;
      clearTimeout(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('online', wake);
      }
    },
    doc: docRef,
    collection: colRef,
  };
}
