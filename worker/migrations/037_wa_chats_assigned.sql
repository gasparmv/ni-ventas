-- Migración 037: assigned_to / assigned_at en wa_chats_summary.
--
-- Para el REPARTO de chats entre vendedores (Joaco / Nadia) y el REPORTE DIARIO.
--   assigned_to = slug del vendedor dueño del chat ('' = sin asignar; por default lo
--                 maneja Joaco, Nadia solo ve lo que se le asigna).
--   assigned_at = cuándo se asignó (ISO UTC), para contar "chats asignados en el día".
-- El trigger trg_wa_chats_summary_ins NO toca estas columnas (se setean al asignar un
-- chat, no en cada mensaje) — por eso alcanza con ADD COLUMN con default ''.
--
-- Aplicar con:
--   wrangler d1 execute ni-ventas --remote --file=migrations/037_wa_chats_assigned.sql

ALTER TABLE wa_chats_summary ADD COLUMN assigned_to TEXT NOT NULL DEFAULT '';
ALTER TABLE wa_chats_summary ADD COLUMN assigned_at TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_wa_chats_summary_assigned ON wa_chats_summary(assigned_to, assigned_at);
