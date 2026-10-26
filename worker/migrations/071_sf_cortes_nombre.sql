-- 071 — Nombre del pedido o del cartel en los pedidos de corte de Sin Frontera (Gaspar, 26-oct-2026): es el título de cada
-- pedido en la lista y es obligatorio al cargar uno nuevo. Los que ya estaban quedan sin nombre (la lista muestra el de sus
-- archivos, marcado "sin nombre") hasta que alguien se lo pone desde Editar. Aditiva, sin backfill.
-- La agrega también ensureSinFronteraSchema, así que da lo mismo aplicarla antes o después del deploy del worker:
--   cd worker && npx wrangler d1 execute ni-ventas --remote --config wrangler.toml --file=migrations/071_sf_cortes_nombre.sql
-- NO es idempotente (SQLite no tiene ADD COLUMN IF NOT EXISTS): si el worker nuevo ya corrió, un "duplicate column" acá es inocuo.
ALTER TABLE sf_cortes ADD COLUMN nombre TEXT;
