-- 070 — Partes de producción (Gaspar, 26-oct-2026): una línea de neón con varias unidades se reparte entre productores
-- ("GONZALO ×4 · OCTAVIO ×5") sin partir la fila de la venta. Precio, seña, planillas, pieza de corte y Aníbal no cambian:
-- lo que se reparte es el TRABAJO (unidades, estado, fotos, mano de obra, pago, llegada al taller y paquete de Neyen).
-- Solo las líneas repartidas tienen partes (pedidos.productor_id = '*'); las demás siguen exactamente como antes.
-- Se pueden dejar unidades libres: SUM(unidades) <= ROUND(cantidad) (las libres no son de nadie hasta asignarlas).
-- Una sola parte con TODAS las unidades no existe: esa línea vuelve a ser normal con ese productor.
-- Aditiva, sin backfill. Se aplica ANTES del deploy del worker (que igual la asegura con ensureProdSchema):
--   cd worker && npx wrangler d1 execute ni-ventas --remote --config wrangler.toml --file=migrations/070_produccion_partes.sql
CREATE TABLE IF NOT EXISTS pedido_prod_partes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL,                       -- la línea (fila de pedidos)
  productor_id TEXT NOT NULL,                       -- users_panel.id o un extra de kv prod_extra (ej. anibal)
  unidades INTEGER NOT NULL CHECK (unidades >= 1),
  prod_estado TEXT NOT NULL DEFAULT 'pendiente',    -- pendiente | en_armado | terminado
  prod_estado_at TEXT, asignado_at TEXT, terminado_at TEXT,
  pagado_at TEXT, pagado_por TEXT DEFAULT '',       -- pago de Gaspar a ESTE productor (congela su mo_monto)
  mo_monto REAL,                                    -- su parte de la mano de obra de la línea (prorrateo por unidades)
  recibido_at TEXT, recibido_por TEXT,              -- "Llegó al taller" de esta parte
  entregado_at TEXT, entregado_por TEXT,            -- Neyen le entregó sus bases + el neón
  created_at TEXT, updated_at TEXT,
  UNIQUE (pedido_id, productor_id)
);
CREATE INDEX IF NOT EXISTS idx_ppp_productor ON pedido_prod_partes (productor_id);
ALTER TABLE pedido_prod_fotos ADD COLUMN parte_id INTEGER;   -- NULL = foto de la línea (como antes)
CREATE INDEX IF NOT EXISTS idx_pedido_prod_fotos_parte ON pedido_prod_fotos (parte_id);
ALTER TABLE pedido_prod_log ADD COLUMN parte_id INTEGER;
