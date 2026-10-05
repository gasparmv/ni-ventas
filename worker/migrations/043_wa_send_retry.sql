-- 043_wa_send_retry.sql — reintentos ACOTADOS de las campañas automáticas (5-oct-2026).
-- comunidad-promo, lanzamiento-opener, minisupernova y pp-followup-tpl reintentaban cada minuto para
-- siempre ante cualquier fallo (sep-2026: ~24k fallos en wa_log). Una fila por (kind, phone, ref):
-- intentos gastados, próximo intento (backoff), si quedó dada por perdida (final=1) y el último error
-- REAL de Meta/360dialog (last_error) con su clase (account/template/permanent/transient).
-- ref: '' en las campañas de una sola vez; el ts del presupuesto en pp-followup-tpl.
-- El worker también la crea sola (ensureSendRetryTable) por si esta migración no corrió.
CREATE TABLE IF NOT EXISTS wa_send_retry (
  kind TEXT NOT NULL,
  phone TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT,
  final INTEGER NOT NULL DEFAULT 0,
  last_class TEXT,
  last_error TEXT,
  first_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (kind, phone, ref)
);
CREATE INDEX IF NOT EXISTS idx_wa_send_retry_kind_next ON wa_send_retry (kind, next_at);
