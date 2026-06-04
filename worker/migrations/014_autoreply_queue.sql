-- Migración 014: convertir wa_autoreply_log en cola con demora.
-- En vez de responder al instante (robótico), encolamos la auto-respuesta con
-- un due_at (~1-2 min) y el cron la manda cuando vence. Reusa la PK (phone,kind)
-- para el dedup atómico. Las filas viejas quedan status='sent' (ya enviadas) y
-- el cron no las re-procesa.

ALTER TABLE wa_autoreply_log ADD COLUMN status TEXT NOT NULL DEFAULT 'sent';
ALTER TABLE wa_autoreply_log ADD COLUMN due_at TEXT;
ALTER TABLE wa_autoreply_log ADD COLUMN sender_name TEXT;
CREATE INDEX IF NOT EXISTS idx_wa_autoreply_queue ON wa_autoreply_log(kind, status, due_at);
