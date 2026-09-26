// Сервер «Уборки»: общая база дома для всех телефонов и для Claude.
// Хранит документы (путь → JSON) в базе D1. Доступ — только с «ключом дома» в заголовке X-Home-Key.
//
//   GET    /docs?since=<мс>         — всё, что изменилось после since (удалённое приходит с data: null)
//   PUT    /doc?path=home/state     — заменить документ целиком       { data }
//   PATCH  /doc?path=home/last      — слить поля (null удаляет поле)  { patch }
//   DELETE /doc?path=chat/m123      — удалить документ
//
// Слияние делает сама база (json_patch) одним запросом — двое могут писать одновременно,
// не затирая друг друга.

const ALLOWED_ORIGINS = ['https://sapronovigor96-jpg.github.io', 'http://localhost:8767'];
const MAX_BODY = 256 * 1024;
const PATH_RE = /^[A-Za-z0-9_\-.~:@+]{1,100}(\/[A-Za-z0-9_\-.~:@+]{1,100}){1,5}$/;

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Home-Key',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!env.HOME_KEY || !(await sameKey(req.headers.get('X-Home-Key') || '', env.HOME_KEY))) return reply({ error: 'wrong_key' }, 401);

    const url = new URL(req.url);
    const now = Date.now();
    try {
      if (req.method === 'GET' && url.pathname === '/docs') {
        const since = Number(url.searchParams.get('since')) || 0;
        const { results } = await env.DB.prepare('SELECT path, data, updated FROM docs WHERE updated > ?1 ORDER BY updated').bind(since).all();
        return reply({ now, docs: results.map((r) => ({ path: r.path, data: r.data === null ? null : JSON.parse(r.data), updated: r.updated })) });
      }

      if (url.pathname === '/doc') {
        const path = url.searchParams.get('path') || '';
        if (!PATH_RE.test(path)) return reply({ error: 'bad_path' }, 400);

        if (req.method === 'DELETE') {
          await env.DB.prepare('UPDATE docs SET data = NULL, updated = ?2 WHERE path = ?1').bind(path, now).run();
          return reply({ ok: true, now });
        }

        const text = await req.text();
        if (text.length > MAX_BODY) return reply({ error: 'too_large' }, 413);
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          return reply({ error: 'bad_json' }, 400);
        }

        if (req.method === 'PUT') {
          if (!isObject(body.data)) return reply({ error: 'bad_data' }, 400);
          await env.DB.prepare(
            'INSERT INTO docs (path, data, updated) VALUES (?1, ?2, ?3) ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated = excluded.updated',
          )
            .bind(path, JSON.stringify(body.data), now)
            .run();
          return reply({ ok: true, now });
        }

        if (req.method === 'PATCH') {
          if (!isObject(body.patch)) return reply({ error: 'bad_patch' }, 400);
          const patch = JSON.stringify(body.patch);
          // Нет документа — создать из патча; есть — слить (RFC 7396: null удаляет поле).
          await env.DB.prepare(
            `INSERT INTO docs (path, data, updated) VALUES (?1, json_patch('{}', ?2), ?3)
             ON CONFLICT(path) DO UPDATE SET data = json_patch(COALESCE(docs.data, '{}'), ?2), updated = ?3`,
          )
            .bind(path, patch, now)
            .run();
          return reply({ ok: true, now });
        }
      }
      return reply({ error: 'not_found' }, 404);
    } catch (e) {
      return reply({ error: 'server_error', message: String(e && e.message) }, 500);
    }
  },
};

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Сравнение ключа за постоянное время — чтобы по времени ответа нельзя было подбирать ключ.
async function sameKey(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
