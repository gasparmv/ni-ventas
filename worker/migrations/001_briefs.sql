-- Migración 001: Panel de cotización conversacional
-- Aplicar con:
--   wrangler d1 execute ni-ventas --file=worker/migrations/001_briefs.sql --remote
-- Para probar local primero:
--   wrangler d1 execute ni-ventas --file=worker/migrations/001_briefs.sql --local

CREATE TABLE IF NOT EXISTS briefs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_wa_id     TEXT NOT NULL,
  cliente_nombre    TEXT,
  origen_lead       TEXT NOT NULL,
  estado            TEXT NOT NULL DEFAULT 'nuevo',
  tipo              TEXT,
  diseno            TEXT,
  alto_cm           REAL,
  ancho_cm          REAL,
  m2                REAL,
  neon_mt           REAL,
  precio_trans      REAL,
  precio_negro      REAL,
  precio_final      REAL,
  descuento         REAL DEFAULT 0,
  recargo           REAL DEFAULT 0,
  reventa           REAL DEFAULT 0,
  comision_joaco    REAL DEFAULT 0,
  comercial_id      TEXT NOT NULL,
  disenador_id      TEXT,
  intentos_followup INTEGER DEFAULT 0,
  notas             TEXT,
  sheet_row         INTEGER,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  enviado_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_briefs_estado    ON briefs(estado);
CREATE INDEX IF NOT EXISTS idx_briefs_wa        ON briefs(cliente_wa_id);
CREATE INDEX IF NOT EXISTS idx_briefs_comercial ON briefs(comercial_id);
CREATE INDEX IF NOT EXISTS idx_briefs_disenador ON briefs(disenador_id);
CREATE INDEX IF NOT EXISTS idx_briefs_updated   ON briefs(updated_at);

CREATE TABLE IF NOT EXISTS brief_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  brief_id    INTEGER NOT NULL,
  autor_id    TEXT NOT NULL,
  tipo        TEXT NOT NULL,
  contenido   TEXT,
  is_final    INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brief_msg_brief ON brief_messages(brief_id, created_at);

CREATE TABLE IF NOT EXISTS users_panel (
  id            TEXT PRIMARY KEY,
  nombre        TEXT NOT NULL,
  rol           TEXT NOT NULL,
  password_hash TEXT,
  activo        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

INSERT OR IGNORE INTO users_panel (id, nombre, rol, password_hash, activo, created_at) VALUES
  ('joaco',  'Joaquín Peiro',     'comercial', NULL, 1, datetime('now')),
  ('emma',   'Emmanuel Canales',  'disenador', NULL, 1, datetime('now')),
  ('gaspar', 'Gaspar Martínez',   'admin',     NULL, 1, datetime('now'));
