-- Migración 020: registro de uso/costo del copiloto (contador de gasto IA).
-- Una fila por generación de sugerencia (cada click en "Sugerir"). Permite
-- mostrarle a Gaspar el gasto del mes/día en vivo. Incluye tokens cacheados
-- (cache_creation/cache_read) para que el costo sea exacto.
CREATE TABLE IF NOT EXISTS copilot_usage (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  phone           TEXT,
  kind            TEXT NOT NULL DEFAULT 'suggest',  -- suggest | (futuro: synth, etc)
  model           TEXT NOT NULL DEFAULT '',
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  cache_read      INTEGER,
  cache_creation  INTEGER,
  cost_usd        REAL,
  created_by      TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_copilot_usage_created ON copilot_usage(created_at);
