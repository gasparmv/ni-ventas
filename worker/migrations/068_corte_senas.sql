-- Seña de los pedidos web del corte para los que no son alumnos (Gaspar 24-oct-2026): 50 % del estimado si hay diseños,
-- el total si es solo de insumos. Hasta que se acredita, las piezas quedan retenidas (corte_pedidos.sena_estado='pendiente').
CREATE TABLE IF NOT EXISTS corte_senas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  envio_id INTEGER,
  telefono TEXT NOT NULL,
  nombre TEXT,
  tipo TEXT,                 -- 'disenos' (50 % del estimado) | 'insumos' (el total)
  estimado INTEGER,
  monto INTEGER NOT NULL,    -- lo que tiene que transferir
  estado TEXT NOT NULL DEFAULT 'pendiente', -- pendiente | revisar | pagada | aplicada (descontada del cobro) | cancelada
  token TEXT,                -- para subir el comprobante desde la página sin cuenta
  comprobantes TEXT,         -- JSON [{key, hash, monto, caja, titular, banco, fecha, confianza, via, wamid, at, leido, repetido}]
  pagado_monto INTEGER DEFAULT 0,
  caja TEXT,
  revisar_motivo TEXT,
  pagada_at TEXT, pagada_por TEXT,
  aplicada_at TEXT, aplicada_total INTEGER,
  nota TEXT,
  prueba INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_corte_senas_tel ON corte_senas(telefono, estado);
CREATE INDEX IF NOT EXISTS idx_corte_senas_token ON corte_senas(token);
CREATE INDEX IF NOT EXISTS idx_corte_senas_estado ON corte_senas(estado, created_at);
ALTER TABLE corte_pedidos ADD COLUMN sena_id INTEGER;
ALTER TABLE corte_pedidos ADD COLUMN sena_estado TEXT;    -- NULL (sin seña) | pendiente | pagada | liberada
ALTER TABLE corte_alumnos ADD COLUMN publico INTEGER DEFAULT 0; -- 1 = público (no alumno): se le pide seña
ALTER TABLE corte_landing_envios ADD COLUMN sena_id INTEGER;
