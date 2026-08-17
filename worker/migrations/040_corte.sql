-- Módulo Servicio de Corte (vertical B2B/alumnos). Etapa 1: base de datos.
-- Fuente de clientes: LTV_Alumnos (2026v4). Contable: Venta_Insumos (sync semanal).

-- Alumnos del servicio de corte (espejo de LTV_Alumnos + datos estructurados para clientes nuevos).
CREATE TABLE IF NOT EXISTS corte_alumnos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nro_cliente TEXT,
  nombre TEXT,
  telefono TEXT,                 -- normalizado (549...)
  datos_envio TEXT,              -- texto libre de LTV ("retira" o dirección)
  cantidad_pedidos INTEGER DEFAULT 0,
  importe_acumulado TEXT,
  -- datos estructurados que pide el bot a los clientes NUEVOS (envío + contable)
  apellido TEXT, direccion TEXT, provincia TEXT, cp TEXT, dni TEXT,
  origen TEXT DEFAULT 'ltv',     -- 'ltv' | 'nuevo'
  activo INTEGER DEFAULT 1,
  ltv_row INTEGER,               -- fila en LTV_Alumnos (para el sync)
  created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_corte_alumnos_tel ON corte_alumnos(telefono);
CREATE INDEX IF NOT EXISTS idx_corte_alumnos_nombre ON corte_alumnos(nombre);

-- Tanda semanal (el fin de semana que se corta).
CREATE TABLE IF NOT EXISTS corte_tandas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  semana TEXT,                   -- ej '2026-W34'
  fecha_corte TEXT,              -- domingo del corte
  cutoff TEXT,                   -- cierre real (sábado ~14hs)
  estado TEXT DEFAULT 'abierta', -- abierta | cortando | cerrada
  created_at TEXT
);

-- Pedido de corte: una fila por diseño. Junta pedido + producción + venta + cobro.
CREATE TABLE IF NOT EXISTS corte_pedidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alumno_id INTEGER,
  telefono TEXT,
  cliente_nombre TEXT,
  -- lo que releva el bot en el intake
  diseno_nombre TEXT,
  aclaraciones TEXT,
  foto_key TEXT,                 -- R2: foto del diseño del alumno
  medida_declarada TEXT,         -- lo que dijo el cliente (texto, NO confiable)
  cantidad INTEGER DEFAULT 1,
  producto TEXT DEFAULT 'TRANS', -- TRANS (negro pausado)
  -- lo que carga Emma (medida REAL → precio)
  ancho_real REAL, alto_real REAL,
  matriz_key TEXT,               -- R2: matriz vectorizada
  matriz_drive_url TEXT,         -- backup en Google Drive
  -- flujo
  tanda_id INTEGER,
  estado TEXT DEFAULT 'pedido',  -- pedido → matriz_lista → cortado → embalado → cobrado → despachado → entregado
  entrega TEXT,                  -- 'retira' | 'envio'
  productor TEXT,
  -- venta / cobro
  precio REAL,                   -- (ancho_real/100 * alto_real/100) * m2 (175000 transparente)
  estado_pago TEXT DEFAULT 'pendiente', -- pendiente | pagado | parcial
  comprobante_key TEXT,          -- R2: comprobante de pago
  insumos_sync INTEGER DEFAULT 0,-- ya escrito a Venta_Insumos (contable)?
  created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_corte_pedidos_estado ON corte_pedidos(estado);
CREATE INDEX IF NOT EXISTS idx_corte_pedidos_tanda ON corte_pedidos(tanda_id);
CREATE INDEX IF NOT EXISTS idx_corte_pedidos_alumno ON corte_pedidos(alumno_id);
