-- Migración 010: kv_cache — cache genérico key/value (TEXT) con timestamp.
--
-- Primer uso: cachear el JSON de COGS leído del Excel 2026v4 vía Apps Script,
-- para no pegarle al Apps Script (lento, ~1-2s) en cada carga del dashboard.
-- TTL lo controla el worker (20 min); ?fresh=1 fuerza relectura.
--
-- No usamos cotizador_params para esto porque su columna value es REAL NOT NULL
-- (numérica) y el front la lee entera como params del cotizador — meter un JSON
-- ahí la ensuciaría.
--
-- Aplicar con:
--   wrangler d1 execute ni-ventas --remote --file=worker/migrations/010_kv_cache.sql

CREATE TABLE IF NOT EXISTS kv_cache (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
