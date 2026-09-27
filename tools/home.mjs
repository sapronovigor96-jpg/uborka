// Инструмент Claude для общей базы дома. Ключ берётся из uborka/.env (HOME_KEY) и нигде не печатается.
//
//   node tools/home.mjs chat              — непрочитанные сообщения (и последние ответы)
//   node tools/home.mjs chat all          — вся переписка
//   node tools/home.mjs reply <id> <текст> — ответить на сообщение <id>
//   node tools/home.mjs get <path>        — показать документ
//   node tools/home.mjs patch <path> <json>  — слить поля в документ
//   node tools/home.mjs docs              — список документов
//   node tools/home.mjs ratings           — оценки дел жильцами
//   node tools/home.mjs inbox             — входящие дела, которые ждут настройки
//   node tools/home.mjs add-task <inboxId> <json> — добавить настроенное дело в дом и закрыть входящее
//        json: { z, t, every, min, when?, hint?, why?: [даст, если пропустить] }
//   node tools/home.mjs inbox-skip <inboxId> <почему> — не добавлять, с пояснением
//   node tools/home.mjs project-add <json>  — разовый проект { title, why?, steps: [текст, …] }
//   node tools/home.mjs projects          — проекты и прогресс
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const URL_BASE = 'https://uborka.sapronov-home.workers.dev';
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
const KEY = readFileSync(envPath, 'utf8').match(/HOME_KEY=(.*)/)[1].trim();

export async function api(method, path, body, key = KEY) {
  const res = await fetch(URL_BASE + path, {
    method,
    headers: { 'X-Home-Key': key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const docs = async () => (await api('GET', '/docs?since=0')).body.docs.filter((d) => d.data !== null);
const time = (ts) => new Date(ts).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

async function main() {
  const [cmd, a, ...rest] = process.argv.slice(2);
  if (cmd === 'docs') {
    for (const d of await docs()) console.log(d.path, JSON.stringify(d.data).length + ' байт', time(d.updated));
  } else if (cmd === 'get') {
    const d = (await docs()).find((x) => x.path === a);
    console.log(d ? JSON.stringify(d.data, null, 1) : 'нет такого документа');
  } else if (cmd === 'patch') {
    console.log((await api('PATCH', '/doc?path=' + encodeURIComponent(a), { patch: JSON.parse(rest.join(' ')) })).body);
  } else if (cmd === 'chat') {
    const msgs = (await docs())
      .filter((d) => d.path.startsWith('chat/'))
      .map((d) => ({ id: d.path.slice(5), ...d.data }))
      .sort((x, y) => x.at - y.at);
    const shown = a === 'all' ? msgs : msgs.filter((m) => m.role === 'user' && m.status !== 'answered');
    if (!shown.length) console.log('Новых сообщений нет.');
    for (const m of shown) console.log(`[${m.id}] ${time(m.at)} ${m.role === 'claude' ? 'Claude' : m.by || 'жилец'}${m.ctx ? ' · ' + m.ctx : ''}${m.status ? ' · ' + m.status : ''}\n  ${m.text}`);
  } else if (cmd === 'ratings') {
    const st = (await docs()).find((x) => x.path === 'home/state');
    const fb = (st && st.data.fb) || {};
    const names = { ok: 'норм', often: 'слишком часто', rare: 'слишком редко', no: 'не про нас' };
    if (!Object.keys(fb).length) console.log('Оценок пока нет.');
    for (const [id, r] of Object.entries(fb).sort((a, b) => b[1].at - a[1].at)) console.log(time(r.at), (r.by || '?').padEnd(8), id.padEnd(16), names[r.v] || r.v);
  } else if (cmd === 'inbox') {
    const items = (await docs()).filter((d) => d.path.startsWith('inbox/')).map((d) => ({ id: d.path.slice(6), ...d.data }));
    const fresh = items.filter((x) => x.status === 'new').sort((x, y) => x.at - y.at);
    if (!fresh.length) console.log('Входящих нет.');
    for (const x of fresh) console.log(`[${x.id}] ${time(x.at)} ${x.by || 'жилец'}\n  ${x.text}`);
  } else if (cmd === 'add-task') {
    const spec = JSON.parse(rest.join(' '));
    for (const f of ['z', 't', 'every', 'min']) if (!spec[f]) throw new Error('нет поля ' + f);
    const state = (await docs()).find((x) => x.path === 'home/state');
    const custom = [...((state && state.data.custom) || [])];
    const id = 'u-' + Date.now().toString(36);
    custom.push({ id, ord: 5, own: true, by: 'claude', ...spec });
    await api('PATCH', '/doc?path=home/state', { patch: { custom } });
    // Новое дело стартует с середины интервала: не горит сразу и не забывается.
    await api('PATCH', '/doc?path=home/last', { patch: { [id]: Date.now() - (spec.every / 2) * 86400000 } });
    if (a && a !== '-') await api('PATCH', '/doc?path=inbox/' + a, { patch: { status: 'done', taskId: id } });
    console.log('дело добавлено:', id, spec.t);
  } else if (cmd === 'inbox-skip') {
    await api('PATCH', '/doc?path=inbox/' + a, { patch: { status: 'skip', note: rest.join(' ') } });
    console.log('отмечено');
  } else if (cmd === 'project-add') {
    const spec = JSON.parse([a, ...rest].join(' '));
    const id = 'p' + Date.now().toString(36);
    await api('PUT', '/doc?path=projects/' + id, {
      data: { title: spec.title, why: spec.why || '', steps: spec.steps.map((t) => ({ t, done: false })), status: 'open', at: Date.now() },
    });
    console.log('проект добавлен:', id, spec.title);
  } else if (cmd === 'projects') {
    const ps = (await docs()).filter((d) => d.path.startsWith('projects/')).map((d) => ({ id: d.path.slice(9), ...d.data }));
    if (!ps.length) console.log('Проектов нет.');
    for (const p of ps) console.log(`[${p.id}] ${p.status === 'done' ? '✓' : '·'} ${p.title} — ${p.steps.filter((x) => x.done).length}/${p.steps.length}`);
  } else if (cmd === 'reply') {
    const text = rest.join(' ').trim();
    if (!a || !text) throw new Error('нужно: reply <id> <текст>');
    const id = 'r' + Date.now().toString(36);
    await api('PUT', '/doc?path=chat/' + id, { data: { role: 'claude', text, at: Date.now(), replyTo: a } });
    await api('PATCH', '/doc?path=chat/' + a, { patch: { status: 'answered' } });
    console.log('ответ записан:', id);
  } else {
    console.log('команды: chat [all] | reply <id> <текст> | get <path> | patch <path> <json> | docs');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => (console.error(e.message), process.exit(1)));
