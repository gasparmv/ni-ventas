-- 044: fecha REAL de diseño de cada pieza de corte (Emma marca "Matriz lista", o el admin la saltea desde 'pedido').
-- updated_at no sirve: lo pisan el corte (Aníbal), el embalado (Neyen) y el cambio de foto.
-- (El worker también la crea en caliente: ensureCorteNeonSchema.)
ALTER TABLE corte_pedidos ADD COLUMN disenado_at TEXT;
-- Backfill: las que están en matriz_lista no se movieron desde que Emma las diseñó → updated_at = fecha de diseño.
-- Las ya cortadas/separadas no tienen dato confiable → quedan NULL (el tablero cae a updated_at sin mostrar fecha).
UPDATE corte_pedidos SET disenado_at = updated_at WHERE estado = 'matriz_lista' AND disenado_at IS NULL;
