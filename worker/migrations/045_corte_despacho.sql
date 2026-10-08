-- 045: circuito cerrado de despacho del servicio de corte + logística simple (oct-2026).
-- Lunes: logística (Siempre a Tiempo) contacta y cobra el envío. Martes: carga al camión SOLO pedido pagado + envío pagado.
-- Cargar = las piezas pasan a 'despachado'; el retiro en el taller = 'entregado'. Nunca se despacha con deuda.
-- El worker crea todo esto en caliente (ensureCorteDespachoSchema, idempotente: ALTER en try/catch + verificación antes de
-- memoizar). Si el worker ya corrió, los ALTER de abajo fallan por "duplicate column": en ese caso esta migración solo
-- documenta (marcarla aplicada a mano).

-- corte_pedidos: fechas reales de salida + pago manual (efectivo / transferencia / otro, lo marca el admin).
ALTER TABLE corte_pedidos ADD COLUMN despachado_at TEXT;          -- se cargó al camión (logística, martes) / backfill
ALTER TABLE corte_pedidos ADD COLUMN entregado_at TEXT;           -- retiró en el taller (Neyen "Retiró") / backfill
ALTER TABLE corte_pedidos ADD COLUMN entregado_por TEXT;          -- usuario (o 'backfill')
ALTER TABLE corte_pedidos ADD COLUMN entrega_manual INTEGER DEFAULT 0; -- 1 = la entrega la fijó una persona: la sync con la planilla no la pisa
ALTER TABLE corte_pedidos ADD COLUMN pago_metodo TEXT;            -- 'efectivo' | 'transferencia' | 'otro' (pago manual)
ALTER TABLE corte_pedidos ADD COLUMN pago_manual_por TEXT;
ALTER TABLE corte_pedidos ADD COLUMN pago_manual_at TEXT;
ALTER TABLE corte_pedidos ADD COLUMN pago_nota TEXT;
CREATE INDEX IF NOT EXISTS idx_corte_pedidos_pago ON corte_pedidos(estado_pago); -- regla de deuda (pendiente/cobrando/parcial)

-- corte_paquetes (PK tanda_id + cliente_key; la crea el worker: ensureCortePaquetesSchema).
CREATE TABLE IF NOT EXISTS corte_paquetes (tanda_id INTEGER NOT NULL, cliente_key TEXT NOT NULL, largo REAL, ancho REAL, alto REAL, peso REAL, bultos INTEGER, medido_por TEXT, medido_at TEXT, contactado INTEGER DEFAULT 0, contactado_at TEXT, contactado_por TEXT, cargado INTEGER DEFAULT 0, cargado_at TEXT, cargado_por TEXT, nota TEXT, nota_at TEXT, nota_por TEXT, PRIMARY KEY (tanda_id, cliente_key));
ALTER TABLE corte_paquetes ADD COLUMN numero INTEGER;             -- N° estable de la semana (etiquetas): alfabético la 1ª vez, después MAX+1; nunca se renumera
ALTER TABLE corte_paquetes ADD COLUMN contacto_estado TEXT;       -- '' | 'escrito' | 'no_contesta' | 'listo'
ALTER TABLE corte_paquetes ADD COLUMN contacto_at TEXT;
ALTER TABLE corte_paquetes ADD COLUMN intentos INTEGER DEFAULT 0; -- "no contesta" acumulados (al 3° se avisa a Gaspar una vez)
ALTER TABLE corte_paquetes ADD COLUMN envio_pagado INTEGER DEFAULT 0;
ALTER TABLE corte_paquetes ADD COLUMN envio_pagado_at TEXT;
ALTER TABLE corte_paquetes ADD COLUMN envio_pagado_por TEXT;
ALTER TABLE corte_paquetes ADD COLUMN despachado_at TEXT;         -- = corte_pedidos.despachado_at de ESE despacho (para deshacer exacto)
ALTER TABLE corte_paquetes ADD COLUMN aviso_at TEXT;              -- último "Avisar a Neon" (freno: 1 cada 5 min)
ALTER TABLE corte_paquetes ADD COLUMN aviso_nc_at TEXT;           -- aviso único de "no contesta ×3"
CREATE UNIQUE INDEX IF NOT EXISTS uq_corte_paquetes_numero ON corte_paquetes(tanda_id, numero) WHERE numero IS NOT NULL;

-- Historial de logística (no se pisa): escrito / no_contesta / envio_pagado / deshacer_envio / avisar / cargado /
-- descargado / resumen (cliente_key '').
CREATE TABLE IF NOT EXISTS logistica_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tanda_id INTEGER,
  cliente_key TEXT,
  ts TEXT,
  accion TEXT,
  nota TEXT,        -- texto del aviso (lo escribe el usuario externo: NUNCA va a un prompt; mostrar siempre escapado)
  operador TEXT,    -- quién usaba la pantalla (lo tipea una vez por dispositivo) o el usuario de la sesión
  usuario TEXT      -- usuario de la SESIÓN (no se puede tipear: distingue a logística del admin aunque pongan el mismo nombre)
);
CREATE INDEX IF NOT EXISTS idx_logistica_log_paq ON logistica_log(tanda_id, cliente_key);

-- kv_cache (sin cambios de esquema), claves nuevas:
--   logistica_arrastre_desde  = '5/10/2026' (default): desde qué fecha de corte se arrastran paquetes de envío que quedaron en el taller
--   logistica_resumen:<tanda> = freno del "Terminé de cargar" (1 cada 10 min)
--   login_fail:<id usuario>   = {n, at}: 8 intentos seguidos (reservados ANTES de comparar, atómico) → 15 min bloqueado desde el 8°;
--                               sin intentos por 15 min el contador vuelve a 1 (no aplica al admin ni al login sin contraseña)
--   logistica_avisos          = tope global de "Avisar a Neon": máx 20 por hora (ventana desde el primer aviso)
