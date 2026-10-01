-- 042_chat_assign_log.sql — auditoría de reasignaciones manuales de chats.
-- Hoy la usa "Traer de Joaco" (POST /admin/wa/chat-import, 1-oct-2026): Agus se trae a su bandeja un chat de
-- la bandeja de Joaco → via='import'. Los imports NO cuentan para la cuota del reparto automático ni para
-- "chats asignados hoy" del reporte diario (se excluyen consultando esta tabla).
CREATE TABLE IF NOT EXISTS chat_assign_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  from_asg TEXT,
  to_asg TEXT,
  via TEXT,
  by_user TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_assign_log_to_ts ON chat_assign_log (to_asg, ts);
CREATE INDEX IF NOT EXISTS idx_chat_assign_log_phone ON chat_assign_log (phone);
