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

-- Tracking de última lectura por contacto (para badge "no leído" en dashboard chat)
CREATE TABLE IF NOT EXISTS wa_read_cursor (
  phone       TEXT PRIMARY KEY,
  last_read_ts TEXT NOT NULL,        -- ISO timestamp del último mensaje visto
  updated_at   TEXT NOT NULL
);

-- Respuestas rápidas (tipo / como WhatsApp)
CREATE TABLE IF NOT EXISTS quick_replies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  shortcut    TEXT NOT NULL UNIQUE,   -- ej: "saludo", "precio", "horarios"
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- Etiquetas para contactos
CREATE TABLE IF NOT EXISTS labels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  color       TEXT NOT NULL,          -- hex color ej: "#FF5722"
  created_at  TEXT NOT NULL
);

-- Asignación de etiquetas a contactos (muchos a muchos)
CREATE TABLE IF NOT EXISTS contact_labels (
  phone       TEXT NOT NULL,
  label_id    INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (phone, label_id)
);

-- Notas libres por contacto (post-it que aparece al abrir el chat)
CREATE TABLE IF NOT EXISTS contact_notes (
  phone       TEXT PRIMARY KEY,
  note        TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL
);

-- Chats archivados (no aparecen en la lista principal salvo que se filtre)
CREATE TABLE IF NOT EXISTS archived_chats (
  phone        TEXT PRIMARY KEY,
  archived_at  TEXT NOT NULL
);

-- Mensajes programados de WhatsApp
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  phone        TEXT NOT NULL,             -- número destino E.164 sin +
  body         TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,             -- ISO UTC timestamp de envío
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed | cancelled
  created_at   TEXT NOT NULL,
  sent_at      TEXT,                      -- cuando se envió realmente
  wamid        TEXT,                      -- ID de Meta si se envió
  error        TEXT                       -- error si falló
);
CREATE INDEX IF NOT EXISTS idx_sched_status_ts ON scheduled_messages(status, scheduled_at);
