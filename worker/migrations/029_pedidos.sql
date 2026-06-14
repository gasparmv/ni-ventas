-- Migración 029: tabla `pedidos` — migración del Excel de Ventas (hoja 2026) a D1.
-- D1 pasa a ser la fuente de verdad de los pedidos; el Excel queda como espejo
-- (fase posterior). Ya aplicada en prod vía wrangler (tabla + columnas
-- telefono/tramos/tipo). El worker también la asegura con ensurePedidosSchema().
CREATE TABLE IF NOT EXISTS pedidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero INTEGER,
  fecha TEXT,                                -- ISO YYYY-MM-DD
  cartel TEXT,
  colores TEXT,
  alto REAL,
  ancho REAL,
  cm_neon REAL,
  base TEXT,                                 -- TRANS | NEGRO
  cantidad REAL,
  precio REAL,
  dimer TEXT,                                -- NO | SLIM | CONTROL | APP
  precio_dimmer REAL,
  envio TEXT,
  aclaracion TEXT,
  productor TEXT,                            -- lo carga Gaspar (no Joaco)
  plataforma TEXT,                           -- WPP | IG
  estado_pago TEXT,                          -- 1er pago | 2do pago
  pagado REAL,
  restante REAL,
  estado_pedido TEXT,                        -- En produccion | para enviar | Entregado
  ad TEXT,                                   -- de qué ad viene
  telefono TEXT,                             -- tel del cliente (WPP) — trazabilidad de ad + chat
  tramos REAL,
  tipo TEXT,                                 -- INT | EXT (interior/exterior)
  sheet_row INTEGER,                         -- fila en el Excel (espejo, fase posterior)
  origen TEXT NOT NULL DEFAULT 'backfill',   -- backfill | crm
  created_at TEXT,
  updated_at TEXT
);
