-- 074 — Cliente de cada pedido de corte (Gaspar, 29-oct-2026: el kanban de cortes de Fran pasa a "Corte > Pedidos de corte" y
-- también lleva cortes que no son de Sin Frontera). cliente_tipo: 'sinfrontera' (Sin Frontera) | 'ni_corporeo' (corpóreos
-- nuestros, Neon Infinito) | 'otro' (otro cliente; su nombre en cliente_nombre, obligatorio). Lo que ya estaba queda como
-- 'sinfrontera' por el DEFAULT (hasta hoy todo era de Sin Frontera). El usuario sinfrontera SOLO ve y toca las filas
-- 'sinfrontera' (lo filtra el worker en todas las rutas /admin/sinfrontera/* de cortes).
-- La agrega también ensureSinFronteraSchema, pero CORRERLA ANTES del deploy del worker (el filtro de Sin Frontera usa la columna):
--   cd worker && npx wrangler d1 execute ni-ventas --remote --config wrangler.toml --file=migrations/074_sf_cortes_cliente.sql
-- NO es idempotente (SQLite no tiene ADD COLUMN IF NOT EXISTS): si el worker nuevo ya corrió, un "duplicate column" acá es inocuo.
ALTER TABLE sf_cortes ADD COLUMN cliente_tipo TEXT NOT NULL DEFAULT 'sinfrontera';
ALTER TABLE sf_cortes ADD COLUMN cliente_nombre TEXT;
