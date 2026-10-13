-- 049 — Trazabilidad para el panel de rendimiento (auditoría del 13-oct-2026).
-- oc_enviadas.enviado_por: quién MANDÓ la OC de verdad (vendedor, admin, 'celular' o 'app_ig'); vendedor sigue
--   siendo a quién le toca seguirla. Las OC que manda un admin (Bruno/Gaspar) no suman en el panel del vendedor.
-- pedidos.asistido_por: la venta la cerró el equipo aunque figure a nombre de un vendedor ('' | 'bruno' | 'equipo');
--   no suma en su panel, se muestra aparte. Solo lo edita Gaspar. No toca comisiones ni el Excel.
-- pedido_estado_log: historial de cambios de estado de producción (antes no quedaba quién ni cuándo).
--   wrangler d1 execute ni-ventas --remote --config wrangler.toml --file=migrations/049_kpi_trazabilidad.sql
ALTER TABLE oc_enviadas ADD COLUMN enviado_por TEXT DEFAULT '';
ALTER TABLE pedidos ADD COLUMN asistido_por TEXT DEFAULT '';
CREATE TABLE IF NOT EXISTS pedido_estado_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER, numero INTEGER, fecha TEXT, comercial_id TEXT, telefono TEXT,
  de TEXT, a TEXT, por TEXT, ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_pedido_estado_log_ts ON pedido_estado_log (ts);
