-- 073 — Borrar pedidos de corte de Sin Frontera (Gaspar, 27-oct-2026: "permitime borrar pedidos que todavia no esten en corte").
-- Solo Gaspar y solo en Pedido o Cancelado (POST /admin/sinfrontera/corte/borrar). Borrado LÓGICO: borrado_at <> NULL = borrado;
-- no sale en ninguna pantalla, sus archivos no se bajan y no se puede mover ni editar, pero la fila queda (y los archivos en R2)
-- para el Deshacer (POST /admin/sinfrontera/corte/restaurar, que vuelve a poner borrado_at y borrado_por en NULL).
-- borrado_por = el usuario que lo borró. Aditiva, sin backfill (ningún pedido viejo queda borrado).
-- La agrega también ensureSinFronteraSchema, así que da lo mismo aplicarla antes o después del deploy del worker:
--   cd worker && npx wrangler d1 execute ni-ventas --remote --config wrangler.toml --file=migrations/073_sf_cortes_borrado.sql
-- NO es idempotente (SQLite no tiene ADD COLUMN IF NOT EXISTS): si el worker nuevo ya corrió, un "duplicate column" acá es inocuo.
ALTER TABLE sf_cortes ADD COLUMN borrado_at TEXT;
ALTER TABLE sf_cortes ADD COLUMN borrado_por TEXT;
