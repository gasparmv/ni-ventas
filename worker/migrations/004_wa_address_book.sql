-- Migración 004: wa_address_book — libreta sincronizada desde smb_app_state_sync
-- 360dialog manda este evento al onboardear y cada vez que Joaco agrega/modifica
-- un contacto en su celular. Es la fuente de la verdad para nombres reales.

CREATE TABLE IF NOT EXISTS wa_address_book (
  user_id     TEXT PRIMARY KEY,         -- AR.XXX o US.XXX, id estable de WA cross-número
  phone       TEXT NOT NULL,            -- número actual del contacto (puede cambiar)
  full_name   TEXT NOT NULL DEFAULT '',
  first_name  TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL DEFAULT 'add',  -- add | update | delete (según WA)
  version     INTEGER DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_address_book_phone ON wa_address_book(phone);
