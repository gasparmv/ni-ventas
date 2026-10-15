-- 053 — Producción de NEÓN: productores con usuario propio, estados por cartel, fotos del cartel terminado,
-- pago de la producción y mano de obra por tiempo (Gaspar, 15-oct-2026).
-- pedidos.productor_id: id del productor (users_panel.rol='productor') asignado a ese cartel ('' = sin asignar).
-- pedidos.prod_estado: '' | 'pendiente' | 'en_armado' | 'terminado' (lo pone el productor; terminado exige foto).
-- pedidos.prod_pagado_at/por: Gaspar marcó que ya le pagó la producción (congela mo_monto).
-- pedidos.mo_monto/mo_regla/mo_detalle/mo_at: mano de obra que le corresponde al productor por ese cartel.
--   regla 'tiempo_v1' (desde kv mo_desde): % del precio + $ por minuto de armado (tiempos de Bruno), tope % del precio.
--   regla 'pct_mes' (antes): % de mano de obra del mes sobre el precio (13,5% hasta sep-2026, 12% desde oct).
-- El worker también lo asegura con ensureProdSchema().
--   wrangler d1 execute ni-ventas --remote --config wrangler.toml --file=migrations/053_produccion_neon.sql
ALTER TABLE pedidos ADD COLUMN productor_id TEXT DEFAULT '';
ALTER TABLE pedidos ADD COLUMN prod_estado TEXT DEFAULT '';
ALTER TABLE pedidos ADD COLUMN prod_estado_at TEXT;
ALTER TABLE pedidos ADD COLUMN prod_asignado_at TEXT;
ALTER TABLE pedidos ADD COLUMN prod_terminado_at TEXT;
ALTER TABLE pedidos ADD COLUMN prod_pagado_at TEXT;
ALTER TABLE pedidos ADD COLUMN prod_pagado_por TEXT DEFAULT '';
ALTER TABLE pedidos ADD COLUMN mo_monto REAL;
ALTER TABLE pedidos ADD COLUMN mo_regla TEXT DEFAULT '';
ALTER TABLE pedidos ADD COLUMN mo_detalle TEXT;
ALTER TABLE pedidos ADD COLUMN mo_at TEXT;
CREATE INDEX IF NOT EXISTS idx_pedidos_productor ON pedidos (productor_id);
CREATE TABLE IF NOT EXISTS pedido_prod_fotos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL, r2_key TEXT NOT NULL, subido_por TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pedido_prod_fotos_pedido ON pedido_prod_fotos (pedido_id);
CREATE TABLE IF NOT EXISTS pedido_prod_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER, campo TEXT, de TEXT, a TEXT, por TEXT, ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_pedido_prod_log_pedido ON pedido_prod_log (pedido_id);
