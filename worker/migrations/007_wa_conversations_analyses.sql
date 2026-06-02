-- Migración 007: análisis estructurado de conversaciones para IA.
-- Dos tablas:
--   wa_conversations  → 1 fila por phone, snapshot del análisis vigente.
--   wa_chat_analyses  → histórico de cada análisis (sobre el mismo chat puede
--                       haber N versiones a medida que avanza la conversación).

CREATE TABLE IF NOT EXISTS wa_conversations (
  phone               TEXT PRIMARY KEY,
  -- Métricas básicas (las llena un trigger/refresh, no Claude)
  first_msg_ts        TEXT NOT NULL DEFAULT '',
  last_msg_ts         TEXT NOT NULL DEFAULT '',
  total_msgs          INTEGER NOT NULL DEFAULT 0,
  inbound_count       INTEGER NOT NULL DEFAULT 0,
  outbound_count      INTEGER NOT NULL DEFAULT 0,
  -- Atribución del origen (cruza con wa_ad_attributions)
  ad_source_id        TEXT NOT NULL DEFAULT '',
  ad_name             TEXT NOT NULL DEFAULT '',
  campaign_name       TEXT NOT NULL DEFAULT '',
  ad_source_confidence TEXT NOT NULL DEFAULT '', -- 'high' (de wa_ad_attributions) | 'inferred' (Claude lo dedujo del primer msg) | ''
  -- Análisis de Claude
  outcome             TEXT NOT NULL DEFAULT '', -- sold|lost|abandoned_by_client|in_progress|spam
  outcome_reason      TEXT NOT NULL DEFAULT '', -- texto libre con justificación
  product_type        TEXT NOT NULL DEFAULT '', -- cartel_personalizado|curso|franquicia|tercerizacion|otro
  product_details     TEXT NOT NULL DEFAULT '', -- ej "Cartel logo 80x50cm, neón rojo+azul"
  vertical            TEXT NOT NULL DEFAULT '', -- particular|local|franquicia|evento|tercerizacion|otro
  customer_profile    TEXT NOT NULL DEFAULT '', -- ej "Particular joven, primer cartel"
  intent_signals      TEXT NOT NULL DEFAULT '', -- JSON array string ['pidio_precio','pregunto_envio']
  objections          TEXT NOT NULL DEFAULT '', -- JSON array string
  key_questions       TEXT NOT NULL DEFAULT '', -- JSON array string
  joaco_approach      TEXT NOT NULL DEFAULT '', -- qué hizo Joaco
  what_worked         TEXT NOT NULL DEFAULT '', -- qué cerró/facilitó la venta
  what_didnt          TEXT NOT NULL DEFAULT '', -- qué la dificultó
  sentiment_final     TEXT NOT NULL DEFAULT '', -- positive|neutral|negative
  next_action         TEXT NOT NULL DEFAULT '', -- recomendación de seguimiento
  -- Meta del análisis
  last_analyzed_at    TEXT,                     -- último timestamp analizado (NULL = nunca)
  analysis_version    INTEGER NOT NULL DEFAULT 0, -- contador, sirve para forzar re-análisis cambiando un nro
  last_model_used     TEXT NOT NULL DEFAULT '', -- 'claude-sonnet-4-5' | 'claude-opus-4-5' | etc
  confidence          TEXT NOT NULL DEFAULT '', -- low|medium|high (auto-reportado por Claude)
  updated_at          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_wa_conv_outcome ON wa_conversations(outcome);
CREATE INDEX IF NOT EXISTS idx_wa_conv_product ON wa_conversations(product_type);
CREATE INDEX IF NOT EXISTS idx_wa_conv_ad ON wa_conversations(ad_name);
CREATE INDEX IF NOT EXISTS idx_wa_conv_analyzed ON wa_conversations(last_analyzed_at);

CREATE TABLE IF NOT EXISTS wa_chat_analyses (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  phone               TEXT NOT NULL,
  analyzed_at         TEXT NOT NULL,
  model_used          TEXT NOT NULL,            -- 'claude-sonnet-4-5' | etc
  prompt_version      INTEGER NOT NULL DEFAULT 1, -- bumpear cuando cambia el system prompt
  msgs_analyzed       INTEGER NOT NULL DEFAULT 0, -- cuántos msgs entraron al prompt
  msgs_until_ts       TEXT NOT NULL DEFAULT '', -- ts del último msg incluido
  raw_response        TEXT NOT NULL DEFAULT '', -- JSON crudo que devolvió Claude
  tokens_in           INTEGER,
  tokens_out          INTEGER,
  cost_usd_estimated  REAL,
  error               TEXT NOT NULL DEFAULT '', -- si falló la llamada
  notes               TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_wa_chat_analyses_phone ON wa_chat_analyses(phone);
CREATE INDEX IF NOT EXISTS idx_wa_chat_analyses_at ON wa_chat_analyses(analyzed_at DESC);
