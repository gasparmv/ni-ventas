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
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  shortcut      TEXT NOT NULL UNIQUE,   -- ej: "saludo", "precio", "horarios"
  body          TEXT NOT NULL,
  media_r2_key  TEXT,                   -- R2 key opcional: foto adjunta al QR
  created_at    TEXT NOT NULL
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

-- ============================================================
-- Panel de cotización conversacional (briefs)
-- Cada brief es la unidad de trabajo entre comercial y diseñador:
-- nace de una conversación de WhatsApp (vinculado por cliente_wa_id
-- al phone de wa_messages), pasa por estados (nuevo → en_diseno →
-- listo → enviado), y al "enviar" se materializa como fila del
-- Sheet "Cotizador Joaco" + mensaje al cliente.
-- ============================================================
CREATE TABLE IF NOT EXISTS briefs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_wa_id     TEXT NOT NULL,             -- phone E.164 sin + (FK lógica a wa_messages.phone)
  cliente_nombre    TEXT,
  origen_lead       TEXT NOT NULL,             -- obligatorio (Locales Corto, El neón, Tu logo, IG orgánico, Plantilla msj, Recomendación, B2B form, otro)
  estado            TEXT NOT NULL DEFAULT 'nuevo',  -- nuevo | en_diseno | listo | enviado | cerrado | colgado
  tipo              TEXT,                      -- INT | EXT
  diseno            TEXT,                      -- nombre/descripción del diseño
  alto_cm           REAL,
  ancho_cm          REAL,
  m2                REAL,
  neon_mt           REAL,
  precio_trans      REAL,
  precio_negro      REAL,
  precio_final      REAL,                      -- el que efectivamente se envió
  descuento         REAL DEFAULT 0,
  recargo           REAL DEFAULT 0,
  reventa           REAL DEFAULT 0,
  comision_joaco    REAL DEFAULT 0,
  comercial_id      TEXT NOT NULL,             -- FK lógica a users_panel.id
  disenador_id      TEXT,                      -- null hasta que se asigne
  intentos_followup INTEGER DEFAULT 0,         -- regla 12 puntos (sec. 8.1 cerebro)
  notas             TEXT,
  sheet_row         INTEGER,                   -- fila del Sheet "Cotizador Joaco" si se materializó
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  enviado_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_briefs_estado    ON briefs(estado);
CREATE INDEX IF NOT EXISTS idx_briefs_wa        ON briefs(cliente_wa_id);
CREATE INDEX IF NOT EXISTS idx_briefs_comercial ON briefs(comercial_id);
CREATE INDEX IF NOT EXISTS idx_briefs_disenador ON briefs(disenador_id);
CREATE INDEX IF NOT EXISTS idx_briefs_updated   ON briefs(updated_at);

-- Hilo interno por brief (reemplaza grupo WhatsApp interno).
-- Para fase 3, ya queda el esqueleto.
CREATE TABLE IF NOT EXISTS brief_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  brief_id    INTEGER NOT NULL,
  autor_id    TEXT NOT NULL,                  -- users_panel.id
  tipo        TEXT NOT NULL,                  -- text | image | render | system
  contenido   TEXT,                            -- texto o R2 key
  is_final    INTEGER DEFAULT 0,               -- 1 = render final (el que se adjunta al envío)
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brief_msg_brief ON brief_messages(brief_id, created_at);

-- Usuarios del panel (comerciales, diseñadores, admin).
-- Reemplaza el array hardcoded de NO_PASSWORD_USERS en worker.js.
CREATE TABLE IF NOT EXISTS users_panel (
  id            TEXT PRIMARY KEY,              -- slug: 'joaco', 'emma', 'gaspar'
  nombre        TEXT NOT NULL,                 -- display name
  rol           TEXT NOT NULL,                 -- comercial | disenador | admin
  password_hash TEXT,                          -- null = entra sin password
  activo        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

-- Seed inicial: equipo actual. Idempotente (INSERT OR IGNORE).
-- Nuevos usuarios se agregan desde el panel de admin de Gaspar.
INSERT OR IGNORE INTO users_panel (id, nombre, rol, password_hash, activo, created_at) VALUES
  ('joaco',  'Joaquín Peiro',     'comercial', NULL, 1, datetime('now')),
  ('emma',   'Emmanuel Canales',  'disenador', NULL, 1, datetime('now')),
  ('gaspar', 'Gaspar Martínez',   'admin',     NULL, 1, datetime('now'));

