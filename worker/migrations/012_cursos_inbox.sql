-- Migración 012: bandeja "cursos" + usuario Abril (rol cursos).
--
-- OBJETIVO: una bandeja separada para chats de gente interesada en el CURSO.
-- Abril (usuario 'cursos') ve SOLO esos chats; Joaco (comercial) NO los ve;
-- Gaspar (admin) los ve todos. El ruteo se marca por chat con la columna
-- inbox en wa_chats_summary ('general' por defecto | 'cursos').
--
-- Aplicar con:
--   wrangler d1 execute ni-ventas --remote --file=worker/migrations/012_cursos_inbox.sql

-- 1) Columna de bandeja en la libreta resumen. Las 17k filas existentes quedan
--    en 'general'. El trigger trg_wa_chats_summary_ins NO toca esta columna
--    (ni en INSERT — toma el default — ni en UPDATE), así que el ruteo manual
--    persiste aunque sigan entrando mensajes.
ALTER TABLE wa_chats_summary ADD COLUMN inbox TEXT NOT NULL DEFAULT 'general';
CREATE INDEX IF NOT EXISTS idx_wa_chats_summary_inbox ON wa_chats_summary(inbox, last_ts DESC);

-- 2) Usuario nuevo: Abril, rol 'cursos'. Password: cursosneon2026 (SHA-256).
--    Solo podrá ver la sección Chat WA y, dentro, solo la bandeja 'cursos'.
INSERT OR IGNORE INTO users_panel (id, nombre, rol, password_hash, activo, created_at)
VALUES ('cursos', 'Abril', 'cursos', '0901bea95ee41e7332f5eacdf3c52bd7f363d4d53fd25416e223e5f859471ef6', 1, datetime('now'));
