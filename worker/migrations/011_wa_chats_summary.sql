-- Migración 011: wa_chats_summary — "libreta resumen" de la lista de chats.
--
-- PROBLEMA: el endpoint /admin/wa/chats-summary arma la lista de conversaciones
-- con un ROW_NUMBER() OVER (PARTITION BY phone) sobre TODA la tabla wa_messages
-- (64k+ filas → ~440k filas escaneadas, ~310ms por ejecución, medido con
-- `wrangler d1 insights`). Se ejecuta en cada poll del sidebar.
--
-- SOLUCIÓN: una tabla con 1 fila por chat (último mensaje + no leídos + nombre),
-- mantenida incrementalmente por un TRIGGER que corre en cada mensaje nuevo.
-- Leer la lista pasa de escanear 64k filas a leer ~unos cientos. El endpoint
-- usa esta tabla con FALLBACK a la query vieja si está vacía o falla.
--
-- Aplicar con:
--   wrangler d1 execute ni-ventas --remote --file=worker/migrations/011_wa_chats_summary.sql

CREATE TABLE IF NOT EXISTS wa_chats_summary (
  phone          TEXT PRIMARY KEY,
  last_ts        TEXT NOT NULL DEFAULT '',
  last_body      TEXT NOT NULL DEFAULT '',
  last_direction TEXT NOT NULL DEFAULT '',
  last_msg_type  TEXT NOT NULL DEFAULT '',
  contact_name   TEXT NOT NULL DEFAULT '',
  unread         INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_wa_chats_summary_ts ON wa_chats_summary(last_ts DESC);

-- Trigger: en cada mensaje insertado en wa_messages, actualiza la libreta del
-- contacto. Misma regla de exclusión que la query original (ignora status
-- vacíos entrantes). Solo pisa "último mensaje" si el nuevo es más reciente.
-- unread: suma 1 por cada inbound; los outbound no lo tocan; mark-read lo
-- resetea a 0 desde el worker.
DROP TRIGGER IF EXISTS trg_wa_chats_summary_ins;
CREATE TRIGGER trg_wa_chats_summary_ins
AFTER INSERT ON wa_messages
WHEN NEW.phone IS NOT NULL AND NEW.phone != ''
  AND NOT (NEW.msg_type = 'status' AND (NEW.body IS NULL OR NEW.body = '') AND NEW.direction != 'outbound')
BEGIN
  INSERT INTO wa_chats_summary (phone, last_ts, last_body, last_direction, last_msg_type, contact_name, unread, updated_at)
  VALUES (
    NEW.phone,
    COALESCE(NEW.ts, ''),
    COALESCE(NEW.body, ''),
    COALESCE(NEW.direction, ''),
    COALESCE(NEW.msg_type, ''),
    CASE WHEN NEW.direction = 'inbound' AND NEW.sender_name IS NOT NULL AND NEW.sender_name != '' THEN NEW.sender_name ELSE '' END,
    CASE WHEN NEW.direction = 'inbound' THEN 1 ELSE 0 END,
    COALESCE(NEW.ts, '')
  )
  ON CONFLICT(phone) DO UPDATE SET
    last_ts        = CASE WHEN NEW.ts >= wa_chats_summary.last_ts THEN NEW.ts ELSE wa_chats_summary.last_ts END,
    last_body      = CASE WHEN NEW.ts >= wa_chats_summary.last_ts THEN COALESCE(NEW.body, '') ELSE wa_chats_summary.last_body END,
    last_direction = CASE WHEN NEW.ts >= wa_chats_summary.last_ts THEN COALESCE(NEW.direction, '') ELSE wa_chats_summary.last_direction END,
    last_msg_type  = CASE WHEN NEW.ts >= wa_chats_summary.last_ts THEN COALESCE(NEW.msg_type, '') ELSE wa_chats_summary.last_msg_type END,
    contact_name   = CASE WHEN NEW.direction = 'inbound' AND NEW.sender_name IS NOT NULL AND NEW.sender_name != '' THEN NEW.sender_name ELSE wa_chats_summary.contact_name END,
    unread         = wa_chats_summary.unread + CASE WHEN NEW.direction = 'inbound' THEN 1 ELSE 0 END,
    updated_at     = COALESCE(NEW.ts, wa_chats_summary.updated_at);
END;
