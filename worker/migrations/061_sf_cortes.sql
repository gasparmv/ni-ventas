-- Pedidos de corte que encarga Sin Frontera (21-oct-2026). La crea también ensureSinFronteraSchema.
CREATE TABLE IF NOT EXISTS sf_cortes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  creado_por TEXT,
  material TEXT NOT NULL,
  color TEXT NOT NULL,
  espesor TEXT NOT NULL,
  fecha_necesita TEXT NOT NULL,
  aclaraciones TEXT,
  archivos TEXT NOT NULL DEFAULT '[]',
  estado TEXT NOT NULL DEFAULT 'pedido',
  estado_at TEXT,
  estado_por TEXT
);
