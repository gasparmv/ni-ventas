-- Migración 033: leads que se registran en la LANDING del minicurso gratuito.
--
-- La landing manda cada registro (nombre + teléfono) a /webhook/minicurso-lead
-- (una 2da acción de webhook, en paralelo a la que ya escribe en el Google Sheet).
-- A los ~45 min, Abril manda un opener (PLANTILLA aprobada, porque el lead nunca
-- nos escribió y la ventana de 24h está cerrada), el chat entra a su bandeja, y
-- según la respuesta (IA) se ramifica. Follow-up a las 23h si no vio la clase 2.
--
-- Estructura calcada de wa_cursos_flow (el "Flujo de cursos ads"), que hace casi
-- lo mismo pero se dispara por inbound de un ad; acá el disparo es el registro.
--
-- Aplicar con:
--   wrangler d1 execute ni-ventas --remote --file=migrations/033_minicurso_landing.sql

CREATE TABLE IF NOT EXISTS minicurso_landing (
  phone            TEXT PRIMARY KEY,
  nombre           TEXT NOT NULL DEFAULT '',
  -- registered -> (guardia) -> await1 -> analyze1/analyzing1 -> done_pos | abril_manual | guarded ; luego done (follow-up procesado)
  stage            TEXT NOT NULL DEFAULT 'registered',
  registered_at    TEXT NOT NULL,
  opener_due_at    TEXT,                       -- registered_at + 45 min: cuándo mandar el opener
  opener_sent_at   TEXT,                        -- cuándo se mandó el opener
  reply_due        TEXT,                        -- debounce (junta mensajes) antes de analizar la respuesta
  vio_clase2       INTEGER NOT NULL DEFAULT 0,  -- 1 si la IA detectó que ya vio/terminó la clase 2
  followup_due_at  TEXT,                        -- (último mensaje) + 23h: cuándo evaluar el follow-up
  followup_sent_at TEXT,                        -- ISO si se mandó, 'skipped' si no correspondía
  guard_reason     TEXT NOT NULL DEFAULT '',    -- por qué no se mandó el opener (si stage='guarded')
  source           TEXT NOT NULL DEFAULT 'landing',
  updated_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_minicurso_landing_stage ON minicurso_landing(stage);
CREATE INDEX IF NOT EXISTS idx_minicurso_landing_opener_due ON minicurso_landing(opener_due_at);
CREATE INDEX IF NOT EXISTS idx_minicurso_landing_followup_due ON minicurso_landing(followup_due_at);
