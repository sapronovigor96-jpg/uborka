// Хранение на устройстве. localStorage может быть недоступен (приватный режим) —
// тогда приложение работает, но предупреждает, что данные не сохранятся.
import { normalize } from './logic.js';

const KEY = 'uborka.v1';
export let persistent = true;

export function load(now) {
  try {
    const raw = localStorage.getItem(KEY);
    return normalize(raw ? JSON.parse(raw) : null, now);
  } catch {
    persistent = false;
    return normalize(null, now);
  }
}

export function save(st) {
  try {
    localStorage.setItem(KEY, JSON.stringify(st));
    persistent = true;
  } catch {
    persistent = false;
  }
}

// Просим браузер не чистить данные при нехватке места.
export async function askPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch {
    /* не критично */
  }
}

export function exportFile(st) {
  const blob = new Blob([JSON.stringify(st, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `uborka-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function importFile(file, now) {
  return file.text().then((txt) => {
    const data = JSON.parse(txt);
    if (!data || data.v !== 1) throw new Error('Это не файл копии «Уборки»');
    return normalize(data, now);
  });
}
