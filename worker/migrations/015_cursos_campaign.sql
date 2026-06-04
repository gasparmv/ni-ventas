-- Migración 015: campaña de cursos (broadcast lanzamiento mayo).
--
-- Flujo: se manda el template 1 a los leads del Sheet, el chat queda OCULTO del
-- front (inbox='oculto') hasta que el cliente responde. Al responder, una IA
-- evalúa si es positiva; si lo es, se le manda el mensaje del evento y se revela
-- a Abril (inbox='cursos'); si no, se revela igual sin mensaje. A los que no
-- responden en 12h (horario hábil) se les manda el template 2 una vez.

CREATE TABLE IF NOT EXISTS wa_cursos_campaign (
  phone        TEXT PRIMARY KEY,
  nombre       TEXT NOT NULL DEFAULT '',
  sent_1_at    TEXT,            -- cuándo se mandó el template 1
  responded_at TEXT,            -- cuándo respondió (NULL = no respondió aún)
  sentiment    TEXT,            -- 'positiva' | 'no_positiva' | NULL
  followup_at  TEXT,            -- cuándo se mandó el template 2 (NULL = no)
  revealed_at  TEXT,            -- cuándo se reveló a Abril (NULL = oculto)
  updated_at   TEXT NOT NULL DEFAULT ''
);
-- Para el cron de follow-up: pendientes sin responder y sin follow-up.
CREATE INDEX IF NOT EXISTS idx_cursos_campaign_followup ON wa_cursos_campaign(responded_at, followup_at, sent_1_at);

-- Etiqueta para distinguir los chats de esta campaña.
INSERT OR IGNORE INTO labels (name, color, created_at) VALUES ('form 6 y 7 de mayo', '#a855f7', datetime('now'));
