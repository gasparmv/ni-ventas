-- Migración 024: cola de plantillas creadas "al toque" que deben mandarse
-- automáticamente cuando Meta las apruebe (así el vendedor no espera en el chat).
-- El cron processPendingTemplateSends revisa el estado y, al aprobarse, envía.

CREATE TABLE IF NOT EXISTS wa_pending_template_send (
  template_name TEXT PRIMARY KEY,
  phone         TEXT NOT NULL,
  body_preview  TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | rejected | expired | failed
  updated_at    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pending_tpl_status ON wa_pending_template_send(status, created_at);
