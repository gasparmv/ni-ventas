-- Quién y cuándo embaló cada pieza del corte (22-oct-2026): historial de semanas de Neyen.
ALTER TABLE corte_pedidos ADD COLUMN embalado_at TEXT;
ALTER TABLE corte_pedidos ADD COLUMN embalado_por TEXT;
