-- Despacho exprés de insumos (19/20-oct-2026) + dirección nueva a LTV.
ALTER TABLE corte_pedidos ADD COLUMN express INTEGER DEFAULT 0;
ALTER TABLE corte_landing_envios ADD COLUMN express_estado TEXT;
ALTER TABLE corte_landing_envios ADD COLUMN express_at TEXT;
ALTER TABLE corte_landing_envios ADD COLUMN express_cobro_at TEXT;
ALTER TABLE corte_landing_envios ADD COLUMN express_tpl TEXT;
ALTER TABLE corte_landing_envios ADD COLUMN express_liberado_at TEXT;
ALTER TABLE corte_landing_envios ADD COLUMN express_aviso_at TEXT;
ALTER TABLE corte_landing_envios ADD COLUMN express_recordado_at TEXT;
ALTER TABLE corte_landing_envios ADD COLUMN express_err INTEGER DEFAULT 0;
ALTER TABLE corte_landing_envios ADD COLUMN dir_ltv_at TEXT;
