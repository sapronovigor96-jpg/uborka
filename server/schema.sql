-- Документы дома: путь → JSON. data = NULL — документ удалён (так телефоны узнают об удалении).
CREATE TABLE IF NOT EXISTS docs (
  path TEXT PRIMARY KEY,
  data TEXT,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_updated ON docs (updated);
