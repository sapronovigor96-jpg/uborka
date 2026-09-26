// Инструмент Claude для общей базы дома. Ключ берётся из uborka/.env (HOME_KEY) и нигде не печатается.
//
//   node tools/home.mjs chat              — непрочитанные сообщения (и последние ответы)
//   node tools/home.mjs chat all          — вся переписка
//   node tools/home.mjs reply <id> <текст> — ответить на сообщение <id>
//   node tools/home.mjs get <path>        — показать документ
//   node tools/home.mjs patch <path> <json>  — слить поля в документ
//   node tools/home.mjs docs              — список документов
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
