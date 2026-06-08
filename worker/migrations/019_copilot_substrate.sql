-- Migración 019: substrato del copiloto de ventas (prepara Fase 2).
-- (a) framework_sections: el playbook partido por secciones (derivado de la
--     versión activa de sales_framework). Permite retrieval dirigido y feedback
--     por sección, en vez de servir el blob de ~19KB entero (best practice RAG:
--     "servir secciones, no el blob"). Se regenera al sembrar y en cada versión.
-- (b) suggestion_feedback: log de cada respuesta sugerida (enviada/editada/
--     ignorada) + edit_distance (Levenshtein sugerencia vs enviado) + la VERSION
--     del playbook que la generó + outcome del hilo. Es el combustible del bucle
--     de auto-mejora (patrón Intercom Fin: edit_distance y outcome > accept rate).
CREATE TABLE IF NOT EXISTS framework_sections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  version     INTEGER NOT NULL,
  order_idx   INTEGER NOT NULL,
  level       INTEGER NOT NULL,            -- nivel del encabezado (1..6)
  heading     TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '',    -- etiquetas opcionales (vertical/objeción)
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_framework_sections_version ON framework_sections(version);

CREATE TABLE IF NOT EXISTS suggestion_feedback (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  phone             TEXT NOT NULL,
  suggested_text    TEXT NOT NULL DEFAULT '',
  final_text        TEXT NOT NULL DEFAULT '',   -- lo que realmente se envió
  action            TEXT NOT NULL DEFAULT '',   -- sent | edited | ignored
  edit_distance     INTEGER,                    -- Levenshtein(suggested, final)
  confidence        REAL,                       -- confianza auto-reportada del modelo
  framework_version INTEGER,                    -- versión del playbook que la generó (atribución)
  vertical          TEXT NOT NULL DEFAULT '',   -- carteles | cursos | supernova
  objection         TEXT NOT NULL DEFAULT '',
  outcome           TEXT NOT NULL DEFAULT '',   -- se llena al cerrar (sold|lost|abandoned)
  model_used        TEXT NOT NULL DEFAULT '',
  created_by        TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_suggestion_feedback_phone ON suggestion_feedback(phone);
CREATE INDEX IF NOT EXISTS idx_suggestion_feedback_version ON suggestion_feedback(framework_version);
CREATE INDEX IF NOT EXISTS idx_suggestion_feedback_created ON suggestion_feedback(created_at);
