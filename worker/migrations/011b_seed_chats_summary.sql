-- Seed inicial de wa_chats_summary: la llena con el estado actual de todos los
-- chats, usando la MISMA lógica que la query original del endpoint. Idempotente
-- (ON CONFLICT actualiza). De acá en más el trigger la mantiene al día.
--
-- Aplicar UNA vez tras la migración 011:
--   wrangler d1 execute ni-ventas --remote --file=worker/migrations/011b_seed_chats_summary.sql

INSERT INTO wa_chats_summary (phone, last_ts, last_body, last_direction, last_msg_type, contact_name, unread, updated_at)
SELECT lm.phone, lm.last_ts, lm.last_body, lm.last_direction, lm.last_msg_type,
       COALESCE(inm.sender_name, '') AS contact_name,
       COALESCE(uc.unread, 0) AS unread,
       lm.last_ts
FROM (
  SELECT phone, ts AS last_ts, body AS last_body, direction AS last_direction, msg_type AS last_msg_type
  FROM (
    SELECT phone, ts, body, direction, msg_type,
           ROW_NUMBER() OVER (PARTITION BY phone ORDER BY ts DESC, id DESC) AS rn
    FROM wa_messages
    WHERE phone IS NOT NULL AND phone != ''
      AND NOT (msg_type = 'status' AND (body IS NULL OR body = '') AND direction != 'outbound')
  ) t WHERE rn = 1
) lm
LEFT JOIN (
  SELECT phone, sender_name FROM (
    SELECT phone, sender_name, ROW_NUMBER() OVER (PARTITION BY phone ORDER BY ts DESC) AS rn
    FROM wa_messages WHERE direction = 'inbound' AND sender_name IS NOT NULL AND sender_name != ''
  ) t WHERE rn = 1
) inm ON inm.phone = lm.phone
LEFT JOIN (
  SELECT m.phone, COUNT(*) AS unread FROM wa_messages m
  LEFT JOIN wa_read_cursor c ON c.phone = m.phone
  WHERE m.direction = 'inbound' AND m.ts > COALESCE(c.last_read_ts, '1970-01-01')
  GROUP BY m.phone
) uc ON uc.phone = lm.phone
ON CONFLICT(phone) DO UPDATE SET
  last_ts        = excluded.last_ts,
  last_body      = excluded.last_body,
  last_direction = excluded.last_direction,
  last_msg_type  = excluded.last_msg_type,
  contact_name   = excluded.contact_name,
  unread         = excluded.unread,
  updated_at     = excluded.updated_at;
