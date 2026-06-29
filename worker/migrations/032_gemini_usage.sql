-- Migración 032: contador de gasto de Gemini (renders + estimación de medidas).
-- Cada llamada a Gemini registra los tokens REALES que devuelve la API y su costo
-- estimado, para ver el gasto por render y el total del mes en el CRM (Insights),
-- sin depender de la consola de Google.
--
-- Aplicar con:
--   wrangler d1 execute ni-ventas --remote --file=migrations/032_gemini_usage.sql

CREATE TABLE IF NOT EXISTS gemini_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  model       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'render',   -- render | params
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL NOT NULL DEFAULT 0,
  ref         TEXT NOT NULL DEFAULT ''           -- brief_id u otra referencia
);
CREATE INDEX IF NOT EXISTS idx_gemini_usage_ts ON gemini_usage(ts);
