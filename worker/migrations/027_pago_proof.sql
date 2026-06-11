-- Migración 027: captura de comprobantes de pago del lanzamiento junio 2026.
-- Todo inbound con imagen/PDF en la ventana (11-15/06) se analiza con OCR (Claude
-- visión), se respalda acá y se etiqueta. clasificacion:
--   'lanzamiento' (mensaje con "comunidad al infinito") → etiqueta "pago lanzamiento junio"
--   'a_definir'   (sin la frase pero monto similar)      → etiqueta "a definir - lanzamiento"
--   'otro'        (comprobante no relacionado al lanzamiento)

CREATE TABLE IF NOT EXISTS wa_pago_proof (
  wamid         TEXT PRIMARY KEY,
  phone         TEXT NOT NULL,
  nombre        TEXT NOT NULL DEFAULT '',
  is_payment    INTEGER NOT NULL DEFAULT 0,
  clasificacion TEXT NOT NULL DEFAULT '',
  monto         REAL NOT NULL DEFAULT 0,
  moneda        TEXT NOT NULL DEFAULT 'ARS',
  cuenta        TEXT NOT NULL DEFAULT '',
  titular       TEXT NOT NULL DEFAULT '',
  banco         TEXT NOT NULL DEFAULT '',
  confianza     REAL NOT NULL DEFAULT 0,
  raw           TEXT NOT NULL DEFAULT '',
  media_key     TEXT NOT NULL DEFAULT '',
  caption       TEXT NOT NULL DEFAULT '',
  ts            TEXT NOT NULL,
  sheet_synced  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pago_proof_class ON wa_pago_proof(clasificacion, monto);
CREATE INDEX IF NOT EXISTS idx_pago_proof_sync ON wa_pago_proof(is_payment, sheet_synced);

INSERT OR IGNORE INTO labels (name, color, created_at) VALUES ('pago lanzamiento junio', '#22c55e', datetime('now'));
INSERT OR IGNORE INTO labels (name, color, created_at) VALUES ('a definir - lanzamiento', '#f59e0b', datetime('now'));
