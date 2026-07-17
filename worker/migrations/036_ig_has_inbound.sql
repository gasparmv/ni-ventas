-- Migración 036: has_inbound en wa_chats_summary.
--
-- PROBLEMA: en Instagram le mandamos un welcome automático (vía ManyChat) a CADA
-- seguidor nuevo (~1600/mes). Ese mensaje SALIENTE crea una fila en la libreta de
-- chats (por el trigger) y ensucia la bandeja con gente que nunca respondió nada.
--
-- REGLA: un chat de IG aparece en la bandeja SOLO si hubo alguna entrada del lead
-- (mensaje o toque de botón/postback, que guardamos como inbound). Marcamos
-- has_inbound=1 en el primer inbound real; la query de la bandeja excluye los chats
-- de IG con has_inbound=0. (WhatsApp no se filtra: ahí no mandamos welcomes masivos.)
--
-- Aplicar con:
--   wrangler d1 execute ni-ventas --remote --file=migrations/036_ig_has_inbound.sql

ALTER TABLE wa_chats_summary ADD COLUMN has_inbound INTEGER NOT NULL DEFAULT 0;

-- Backfill: marcar los chats que YA tienen algún inbound real (no status).
UPDATE wa_chats_summary SET has_inbound = 1
WHERE phone IN (SELECT DISTINCT phone FROM wa_messages WHERE direction = 'inbound' AND msg_type != 'status');

-- Recrear el trigger sumando el mantenimiento de has_inbound (una vez 1, se queda 1).
DROP TRIGGER IF EXISTS trg_wa_chats_summary_ins;
CREATE TRIGGER trg_wa_chats_summary_ins
AFTER INSERT ON wa_messages
WHEN NEW.phone IS NOT NULL AND NEW.phone != ''
  AND NOT (NEW.msg_type = 'status' AND (NEW.body IS NULL OR NEW.body = '') AND NEW.direction != 'outbound')
BEGIN
  INSERT INTO wa_chats_summary (phone, last_ts, last_body, last_direction, last_msg_type, contact_name, unread, updated_at, has_inbound)
  VALUES (
    NEW.phone,
    COALESCE(NEW.ts, ''),
    COALESCE(NEW.body, ''),
    COALESCE(NEW.direction, ''),
    COALESCE(NEW.msg_type, ''),
    CASE WHEN NEW.direction = 'inbound' AND NEW.sender_name IS NOT NULL AND NEW.sender_name != '' THEN NEW.sender_name ELSE '' END,
    CASE WHEN NEW.direction = 'inbound' THEN 1 ELSE 0 END,
    COALESCE(NEW.ts, ''),
    CASE WHEN NEW.direction = 'inbound' AND NEW.msg_type != 'status' THEN 1 ELSE 0 END
  )
  ON CONFLICT(phone) DO UPDATE SET
    last_ts        = CASE WHEN NEW.ts >= wa_chats_summary.last_ts THEN NEW.ts ELSE wa_chats_summary.last_ts END,
    last_body      = CASE WHEN NEW.ts >= wa_chats_summary.last_ts THEN COALESCE(NEW.body, '') ELSE wa_chats_summary.last_body END,
    last_direction = CASE WHEN NEW.ts >= wa_chats_summary.last_ts THEN COALESCE(NEW.direction, '') ELSE wa_chats_summary.last_direction END,
    last_msg_type  = CASE WHEN NEW.ts >= wa_chats_summary.last_ts THEN COALESCE(NEW.msg_type, '') ELSE wa_chats_summary.last_msg_type END,
    contact_name   = CASE WHEN NEW.direction = 'inbound' AND NEW.sender_name IS NOT NULL AND NEW.sender_name != '' THEN NEW.sender_name ELSE wa_chats_summary.contact_name END,
    unread         = wa_chats_summary.unread + CASE WHEN NEW.direction = 'inbound' THEN 1 ELSE 0 END,
    updated_at     = COALESCE(NEW.ts, wa_chats_summary.updated_at),
    has_inbound    = CASE WHEN NEW.direction = 'inbound' AND NEW.msg_type != 'status' THEN 1 ELSE wa_chats_summary.has_inbound END;
END;
