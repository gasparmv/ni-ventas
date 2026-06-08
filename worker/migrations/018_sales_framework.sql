-- Migración 018: framework de venta versionado (hogar operativo del agente IA).
-- Cada versión es una fila; is_active=1 marca la vigente (solo una a la vez). El
-- agente lee la versión activa en runtime; el bucle de retroalimentación inserta
-- versiones nuevas con aprobación humana (source='synthesis'|'manual').
-- Se auto-siembra como v1 desde worker/knowledge/framework-venta.md si está vacía.
CREATE TABLE IF NOT EXISTS sales_framework (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  version     INTEGER NOT NULL,
  content     TEXT NOT NULL,                 -- markdown completo del framework
  format      TEXT NOT NULL DEFAULT 'md',
  is_active   INTEGER NOT NULL DEFAULT 0,    -- 1 = versión vigente
  source      TEXT NOT NULL DEFAULT '',      -- 'seed' | 'manual' | 'synthesis'
  notes       TEXT NOT NULL DEFAULT '',      -- changelog de la versión
  created_by  TEXT NOT NULL DEFAULT '',      -- usuario que la creó
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_framework_version ON sales_framework(version);
CREATE INDEX IF NOT EXISTS idx_sales_framework_active ON sales_framework(is_active);
