-- Migración 021: Fase 2C — bucle de auto-mejora del playbook.
-- framework_improvements: propuestas de mejora al playbook generadas por la
-- síntesis (lee suggestion_feedback + wa_conversations) y revisadas por Gaspar.
-- Cada fila es UNA propuesta concreta y dirigida a una sección del playbook.
-- Flujo: synthesis -> status='pending' -> Gaspar aprueba/rechaza. Al aprobar se
-- crea una versión nueva de sales_framework con el cambio aplicado y se activa
-- (applied_version). Nada toca el playbook sin aprobación humana (human-in-loop).
CREATE TABLE IF NOT EXISTS framework_improvements (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  vertical         TEXT NOT NULL DEFAULT 'general',  -- carteles | cursos | supernova | general
  title            TEXT NOT NULL DEFAULT '',         -- título corto de la mejora
  rationale        TEXT NOT NULL DEFAULT '',         -- el insight: por qué mejora la venta
  evidence         TEXT NOT NULL DEFAULT '',         -- datos que la respaldan (counts/ejemplos)
  target_heading   TEXT NOT NULL DEFAULT '',         -- sección del playbook a tocar
  operation        TEXT NOT NULL DEFAULT 'append',   -- append | replace | new_section
  proposed_content TEXT NOT NULL DEFAULT '',         -- el markdown exacto a sumar/usar
  confidence       REAL,                             -- confianza auto-reportada del modelo
  based_on_version INTEGER,                          -- versión del playbook sobre la que se sintetizó
  source_model     TEXT NOT NULL DEFAULT '',
  batch_id         TEXT NOT NULL DEFAULT '',         -- agrupa propuestas de una misma corrida
  applied_version  INTEGER,                          -- versión nueva creada al aprobar (null si no)
  reviewed_by      TEXT NOT NULL DEFAULT '',
  reviewed_at      TEXT,
  review_note      TEXT NOT NULL DEFAULT '',         -- motivo al rechazar (es señal en sí mismo)
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_framework_improvements_status ON framework_improvements(status);
CREATE INDEX IF NOT EXISTS idx_framework_improvements_created ON framework_improvements(created_at);
CREATE INDEX IF NOT EXISTS idx_framework_improvements_batch ON framework_improvements(batch_id);
