-- Tablero de producción de neón (16-oct-2026). La etapa de cada cartel se calcula; estas columnas solo guardan
-- cuándo pasó cada cosa (recorrido), la salida que marca Neyen/logística y la ubicación manual de Gaspar.
ALTER TABLE corte_pedidos ADD COLUMN diseno_inicio_at TEXT;
ALTER TABLE corte_pedidos ADD COLUMN diseno_inicio_por TEXT;
ALTER TABLE corte_pedidos ADD COLUMN cortado_at TEXT;
ALTER TABLE corte_pedidos ADD COLUMN separado_at TEXT;
ALTER TABLE pedidos ADD COLUMN recibido_at TEXT;
ALTER TABLE pedidos ADD COLUMN recibido_por TEXT;
ALTER TABLE pedidos ADD COLUMN despachado_at TEXT;
ALTER TABLE pedidos ADD COLUMN despachado_por TEXT;
ALTER TABLE pedidos ADD COLUMN despacho_modo TEXT;
ALTER TABLE pedidos ADD COLUMN despacho_transporte TEXT;
ALTER TABLE pedidos ADD COLUMN despacho_seguimiento TEXT;
ALTER TABLE pedidos ADD COLUMN despacho_prev_estado TEXT;
ALTER TABLE pedidos ADD COLUMN neon_piso TEXT;
ALTER TABLE pedidos ADD COLUMN neon_piso_at TEXT;
ALTER TABLE pedidos ADD COLUMN neon_piso_por TEXT;
ALTER TABLE pedidos ADD COLUMN neon_piso_motivo TEXT;
