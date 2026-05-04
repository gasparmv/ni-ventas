CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user      TEXT NOT NULL,
  action    TEXT NOT NULL,
  item_id   TEXT NOT NULL,
  item_kind TEXT,
  undo      INTEGER DEFAULT 0,
  ts        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_ts   ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user);

-- Sesiones de admin (token-based)
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user       TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Parámetros del cotizador (editables por admin)
CREATE TABLE IF NOT EXISTS cotizador_params (
  key   TEXT PRIMARY KEY,
  value REAL NOT NULL,
  updated_at TEXT NOT NULL
);

-- Tareas marcadas como hechas (persistente, reemplaza localStorage)
CREATE TABLE IF NOT EXISTS done_marks (
  user    TEXT NOT NULL,
  item_id TEXT NOT NULL,
  ts      TEXT NOT NULL,
  PRIMARY KEY (user, item_id)
);

-- Log de envíos de WhatsApp (Cloud API). Sirve para idempotencia diaria
-- (no reenviar el mismo followup el mismo día) y auditoría.
CREATE TABLE IF NOT EXISTS wa_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  to_number   TEXT,
  kind        TEXT,                 -- text | template:<name> | followup:D30 | cron-summary
  ref         TEXT,                 -- correlativo: ej "D30:123" (milestone + pedidoId)
  ok          INTEGER DEFAULT 0,
  message_id  TEXT,                 -- wamid devuelto por Meta
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_wa_log_ref_ts ON wa_log(ref, ts);
CREATE INDEX IF NOT EXISTS idx_wa_log_ts     ON wa_log(ts);

-- Mensajes de WhatsApp recibidos y enviados (para análisis e insights)
CREATE TABLE IF NOT EXISTS wa_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  wamid       TEXT UNIQUE,            -- ID de mensaje de Meta (dedup)
  direction   TEXT NOT NULL,          -- inbound | outbound
  phone       TEXT NOT NULL,          -- número del cliente (E.164 sin +)
  sender_name TEXT,                   -- nombre del contacto (si Meta lo envía)
  msg_type    TEXT,                   -- text | image | audio | video | document | sticker | reaction | button
  body        TEXT,                   -- contenido del mensaje (texto, caption, o payload del botón)
  media_url   TEXT,                   -- URL del media (si aplica)
  context_id  TEXT,                   -- wamid del mensaje al que responde (si es reply)
  status      TEXT                    -- sent | delivered | read (solo outbound, actualizado por webhook)
);
CREATE INDEX IF NOT EXISTS idx_wa_messages_phone ON wa_messages(phone);
CREATE INDEX IF NOT EXISTS idx_wa_messages_ts    ON wa_messages(ts);
CREATE INDEX IF NOT EXISTS idx_wa_messages_wamid ON wa_messages(wamid);
