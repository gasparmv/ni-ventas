-- 050 — Índices para el panel de rendimiento (auditoría del 13-oct-2026: cada carga leía ~250k filas de wa_messages
-- buscando los mensajes de presupuesto). Índice PARCIAL con la misma expresión que usa KPI_PRESUP_SQL (tiene que ser
-- idéntica para que SQLite lo use): ~3,7k filas desde junio en vez de recorrer todos los salientes.
--   wrangler d1 execute ni-ventas --remote --config wrangler.toml --file=migrations/050_kpi_indices.sql
CREATE INDEX IF NOT EXISTS idx_wa_messages_presup ON wa_messages (phone, ts) WHERE direction = 'outbound' AND (substr(body, 1, 26) = 'Te comparto el presupuesto' OR substr(body, 1, 24) = '[plantilla: presupuesto_' OR substr(body, 1, 8) = 'Trabajo:');
CREATE INDEX IF NOT EXISTS idx_wa_messages_presup_ts ON wa_messages (ts) WHERE direction = 'outbound' AND (substr(body, 1, 26) = 'Te comparto el presupuesto' OR substr(body, 1, 24) = '[plantilla: presupuesto_' OR substr(body, 1, 8) = 'Trabajo:');
CREATE INDEX IF NOT EXISTS idx_oc_enviadas_phone_ts ON oc_enviadas (phone, ts_out);
