-- 056: pedido cargado SIN PAGO por Gaspar (cliente frecuente que paga en unos días, 16-oct-2026).
-- pedidos.pago_metodo = 'pendiente' + cobrar_el = 'AAAA-MM-DD' en que hay que cobrarlo. Recordatorio por plantilla a
-- Gaspar (processCobrosPendientes) mientras quede saldo; se pospone o se corta desde la ficha (PATCH cobrar_el).
-- cobro_avisos = claim de cada aviso (un solo envío por pedido/tipo/día/turno). worker.js lo asegura también en runtime.
ALTER TABLE pedidos ADD COLUMN cobrar_el TEXT;
CREATE TABLE IF NOT EXISTS cobro_avisos (clave TEXT PRIMARY KEY, enviado_at TEXT);
