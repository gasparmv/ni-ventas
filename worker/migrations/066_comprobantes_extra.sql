-- Varios comprobantes por pago (22-oct-2026): los de más de la seña y del saldo, en JSON.
ALTER TABLE pedidos ADD COLUMN comprobantes_extra TEXT;
