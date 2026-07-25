-- Migración 039: cola de recuperación post-migración de número (25-jul-2026).
-- Contacta gradualmente a los leads que quedaron colgados por la caída/migración
-- (Caso 1 pedido en curso, Caso 2 presupuesto sin seguimiento, Caso 3 consulta sin
-- respuesta) avisando el número nuevo. Drena con freno de mano (1 cada N min).
CREATE TABLE IF NOT EXISTS recovery_queue (
  phone         TEXT PRIMARY KEY,
  caso          INTEGER NOT NULL,          -- 1 | 2 | 3 (prioridad de menor a mayor)
  template_name TEXT NOT NULL,
  param         TEXT NOT NULL DEFAULT '',  -- valor de {{1}} (nombre del cartel) o ''
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT '',
  sent_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_recovery_status ON recovery_queue(status, caso, created_at);
