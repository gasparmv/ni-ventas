-- Migración 006: wa_leads — leads que llegan desde Meta Lead Ads via webhook.
-- Se crea una fila por cada submission del form. Dedup por leadgen_id (único
-- por lead). Trackea el ciclo: recibido → procesado → template enviado.

CREATE TABLE IF NOT EXISTS wa_leads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  leadgen_id      TEXT NOT NULL UNIQUE,         -- ID único del lead en Meta
  ts              TEXT NOT NULL,                -- created_time del lead (ISO)
  received_at     TEXT NOT NULL,                -- cuando llegó al worker (ISO)

  -- Origen
  page_id         TEXT NOT NULL DEFAULT '',
  form_id         TEXT NOT NULL DEFAULT '',
  form_name       TEXT NOT NULL DEFAULT '',
  ad_id           TEXT NOT NULL DEFAULT '',
  ad_name         TEXT NOT NULL DEFAULT '',
  adset_id        TEXT NOT NULL DEFAULT '',
  campaign_id     TEXT NOT NULL DEFAULT '',

  -- Datos del lead
  phone           TEXT NOT NULL DEFAULT '',     -- normalizado AR (sin +, ej "5491144366573")
  phone_raw       TEXT NOT NULL DEFAULT '',     -- como vino de Meta, sin normalizar
  first_name      TEXT NOT NULL DEFAULT '',
  full_name       TEXT NOT NULL DEFAULT '',
  email           TEXT NOT NULL DEFAULT '',
  vertical        TEXT NOT NULL DEFAULT '',     -- mapeado desde form_name/ad_name
  raw_lead_data   TEXT NOT NULL DEFAULT '',     -- JSON crudo de field_data de Meta

  -- Procesamiento
  template_status TEXT NOT NULL DEFAULT 'pending',  -- pending|sent|failed|skipped
  template_sent_at TEXT,
  template_error  TEXT NOT NULL DEFAULT '',
  wamid           TEXT NOT NULL DEFAULT '',         -- wamid del template enviado

  -- Errores generales del procesamiento
  process_error   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_wa_leads_ts ON wa_leads(ts DESC);
CREATE INDEX IF NOT EXISTS idx_wa_leads_phone ON wa_leads(phone);
CREATE INDEX IF NOT EXISTS idx_wa_leads_form_id ON wa_leads(form_id);
CREATE INDEX IF NOT EXISTS idx_wa_leads_template_status ON wa_leads(template_status);
