-- Pedidos de corte por la web (landing neoninfinitosoftware.com/corte/, 14-oct-2026).
-- Un renglón por pedido enviado desde la landing. Cada diseño / insumo es además una pieza de corte_pedidos con
-- origen='landing', sin tanda hasta la carga (hoja_fecha = el lunes de su tanda, hoja_cliente = el nombre en la planilla).
-- El worker crea todo solo (ensureCorteLandingSchema); este archivo queda como registro.
CREATE TABLE IF NOT EXISTS corte_landing_envios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT,
  telefono TEXT,          -- 549... (13 dígitos)
  nombre TEXT,            -- como lo escribió
  nombre_hoja TEXT,       -- como va (o ya está) en la planilla
  nuevo INTEGER DEFAULT 0,-- 1 = no estaba en la base
  entrega TEXT,           -- retira | envio
  datos_json TEXT,        -- {nuevo:{dni,calle,localidad,provincia,cp,recibe}, dir:{...dirección nueva de un cliente conocido}}
  insumos_json TEXT,      -- [{codigo,cantidad,color,precio,nombre}]
  n_disenos INTEGER,
  estimado INTEGER,       -- total estimado que vio el cliente
  hoja_fecha TEXT,        -- lunes de la tanda (D/M/AAAA)
  plazo_estado TEXT,      -- abierto | margen
  huella TEXT,            -- para no duplicar un doble envío
  ip_hash TEXT,
  piezas_ids TEXT,        -- ids de corte_pedidos
  cliente_hoja TEXT,      -- 'escrito' cuando el cliente nuevo se sumó a LTV_Alumnos y a Clientes
  cierre_at TEXT,         -- cuándo salió el resumen del cierre
  prueba INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_corte_landing_fecha ON corte_landing_envios(hoja_fecha);
CREATE INDEX IF NOT EXISTS idx_corte_landing_tel ON corte_landing_envios(telefono, created_at);
CREATE INDEX IF NOT EXISTS idx_corte_pedidos_origen ON corte_pedidos(origen, hoja_fecha);
