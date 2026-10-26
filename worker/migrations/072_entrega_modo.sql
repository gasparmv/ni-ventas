-- 072 — Cómo se entrega un pedido de neón (Gaspar, 26-oct-2026). Al registrar el 2do pago (o al cargar un pedido que pagó
-- todo de una) el vendedor elige: retira en el taller / Uber (Capital y alrededores) / encomienda al interior / instalación.
-- Retira y Uber le aparecen a Neyen (logística no los ve); encomienda va a la pestaña "Producción neón" de logística.
-- entrega_modo ∈ 'retira' | 'uber' | 'encomienda' | 'instalacion' | NULL (= de antes: se deduce del texto de Envío).
-- Los corpóreos no lo usan por ahora. Aditiva, sin backfill.
-- La agregan también ensurePedidosSchema y ensureNeonTableroSchema, así que da lo mismo aplicarla antes o después del deploy:
--   cd worker && npx wrangler d1 execute ni-ventas --remote --config wrangler.toml --file=migrations/072_entrega_modo.sql
-- NO es idempotente (SQLite no tiene ADD COLUMN IF NOT EXISTS): si el worker nuevo ya corrió, un "duplicate column" acá es inocuo.
ALTER TABLE pedidos ADD COLUMN entrega_modo TEXT;
ALTER TABLE pedidos ADD COLUMN entrega_modo_at TEXT;
ALTER TABLE pedidos ADD COLUMN entrega_modo_por TEXT;
