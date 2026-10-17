-- Índice para el tablero de neón: busca en pedido_estado_log por pedido (quién y cuándo puso 'para enviar' / 'Entregado').
CREATE INDEX IF NOT EXISTS idx_pedido_estado_log_pid_ts ON pedido_estado_log(pedido_id, ts);
