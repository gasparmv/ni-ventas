-- 054: comprobante + caja OBLIGATORIOS al cargar un pedido desde el CRM, y registro del 2do pago (oct-2026).
-- Nivel PEDIDO: se repiten en cada fila-cartel del mismo N° (igual que pagado / estado_pago).
-- caja ∈ ('Melina','Gaspar','Favio','Bruno','Efectivo'); 'Efectivo' ⇔ pago_metodo='efectivo' (sin comprobante).
-- pagado sigue siendo COBRO 1 (va a Pedidos_Corporeo!AB / Excel viejo R → Pedidos_Directo!AB). El 2do pago
-- NO se suma a pagado: va a cobro2 (en la planilla COBRO 2 es fórmula = total − COBRO 1).
-- caja_sync*: espejo de la caja a la col Z de Pedidos_Corporeo / Pedidos_Directo (syncCajaPedidos).
-- worker.js ensurePedidosSchema hace los mismos ALTER como red de seguridad.
ALTER TABLE pedidos ADD COLUMN caja TEXT;
ALTER TABLE pedidos ADD COLUMN pago_metodo TEXT;
ALTER TABLE pedidos ADD COLUMN comprobante_key TEXT;
ALTER TABLE pedidos ADD COLUMN comprobante_wamid TEXT;
ALTER TABLE pedidos ADD COLUMN cobro2 REAL;
ALTER TABLE pedidos ADD COLUMN caja2 TEXT;
ALTER TABLE pedidos ADD COLUMN pago2_metodo TEXT;
ALTER TABLE pedidos ADD COLUMN comprobante2_key TEXT;
ALTER TABLE pedidos ADD COLUMN comprobante2_wamid TEXT;
ALTER TABLE pedidos ADD COLUMN cobro2_at TEXT;
ALTER TABLE pedidos ADD COLUMN caja_sync TEXT;
ALTER TABLE pedidos ADD COLUMN caja_sync_err TEXT;
ALTER TABLE pedidos ADD COLUMN caja_sync_attempts INTEGER NOT NULL DEFAULT 0;

-- Cache del OCR de comprobantes por mensaje (para no pagar una llamada a Sonnet cada vez que se abre el modal).
CREATE TABLE IF NOT EXISTS pago_ocr (
  wamid TEXT PRIMARY KEY,
  phone TEXT,
  media_key TEXT,
  es_comprobante INTEGER,
  monto REAL,
  titular TEXT,
  banco TEXT,
  cuenta TEXT,
  caja TEXT,
  raw TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pago_ocr_phone ON pago_ocr (phone);
