-- 076 — Encargos de neón de Sin Frontera (Gaspar, 30-oct-2026: "que Sin Frontera desde su usuario pueda encargarme ventas de
-- neones con lo mínimo de info, ninguna información de pago (va a la cuenta corriente); ellos cargan diseño, para cuándo lo
-- necesitan y medidas aproximadas; a mí me aparece en Pedidos, lo verifico y completo lo que falte").
-- El encargo NO es un pedido: queda acá ('nuevo') hasta que Gaspar lo carga con el formulario de siempre (Cliente: Sin Frontera,
-- cuenta corriente) → 'cargado' con pedido_numero / pedido_ids (JSON). Sin Frontera lo cancela mientras está 'nuevo'
-- ('cancelado'); Gaspar lo descarta ('descartado'). archivos = JSON [{key (sf-encargos/…), nombre, bytes, tipo}].
-- La crea también ensureSinFronteraSchema; esta queda de registro:
--   cd worker && npx wrangler d1 execute ni-ventas --remote --config wrangler.toml --file=migrations/076_sf_encargos.sql
CREATE TABLE IF NOT EXISTS sf_encargos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  creado_por TEXT,
  nombre TEXT NOT NULL,
  medida TEXT NOT NULL,
  cantidad INTEGER NOT NULL DEFAULT 1,
  fecha_necesita TEXT NOT NULL,
  aclaraciones TEXT,
  archivos TEXT NOT NULL DEFAULT '[]',
  estado TEXT NOT NULL DEFAULT 'nuevo',
  estado_at TEXT,
  estado_por TEXT,
  pedido_numero TEXT,
  pedido_ids TEXT
);
