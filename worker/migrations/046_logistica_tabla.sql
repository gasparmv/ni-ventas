-- 046: logística como PLANILLA (tabla tipo Excel para Siempre a Tiempo, oct-2026).
-- El lunes logística ya tiene en una tabla todo lo de cada envío: dirección desglosada (calle, localidad, provincia, CP,
-- quién recibe, DNI), medidas/peso, transporte, costo del envío (lo cobra logística al cliente), guía/seguimiento.
-- El worker crea todo esto en caliente (ensureLogiTablaSchema, idempotente: ALTER en try/catch + verificación con
-- SELECT ... LIMIT 0 antes de memoizar). Si el worker ya corrió, los ALTER de abajo fallan por "duplicate column": en ese
-- caso esta migración solo documenta (marcarla aplicada a mano).

-- corte_paquetes (PK tanda_id + cliente_key): columnas de la planilla.
ALTER TABLE corte_paquetes ADD COLUMN transporte TEXT;                 -- Correo Argentino | OCA | Buspack | Flecha Cargo | Integral Pack | Via Cargo | otro (texto). Andreani NO.
ALTER TABLE corte_paquetes ADD COLUMN transporte_conf INTEGER DEFAULT 0; -- 1 = lo eligió una persona. El sugerido (último elegido para ese cliente en una semana anterior) NO se guarda: se calcula al leer.
ALTER TABLE corte_paquetes ADD COLUMN envio_costo INTEGER;             -- costo del envío en pesos (0..10.000.000; NULL = sin cotizar). Es de logística, no es un monto del pedido.
ALTER TABLE corte_paquetes ADD COLUMN seguimiento TEXT;                -- N° de guía / seguimiento del transporte (hasta 80)
CREATE INDEX IF NOT EXISTS idx_corte_paquetes_cliente ON corte_paquetes(cliente_key, tanda_id); -- transporte sugerido + migración de clave

-- Dirección desglosada por cliente (vale para todas las semanas). Clave = la de corte_paquetes: teléfono, o 'n:'+nombre
-- normalizado si no tiene (POST /admin/corte/asignar-telefono la migra a la clave teléfono).
--  · texto_fuente / texto_hash: el texto de LTV_Alumnos col E ("Datos envío") que se desglosó; si el hash no cambió se usa
--    la IA guardada (una llamada a Gemini 2.5 Flash por carga de la lista, con TODAS las pendientes; gasto en gemini_usage
--    kind 'direcciones').
--  · ia_json: {recibe, dni, calle, localidad, provincia, cp, tel_alt, obs} que devolvió la IA (saneado).
--  · edit_json: correcciones de logística POR CAMPO (mandan sobre la IA, aunque sean vacías). NUNCA se escriben en LTV.
--  · edit_hash: hash del texto de LTV sobre el que se hicieron esas correcciones. Si el dueño cambia la col E después
--    (ej. el cliente se mudó), las correcciones viejas dejan de aplicarse (se muestra la dirección nueva, dir_edit_vieja)
--    y la próxima corrección arranca de cero: así no queda una dirección mezclada (calle vieja + localidad nueva).
--    NULL = sin hash registrado (no se invalida).
CREATE TABLE IF NOT EXISTS corte_direcciones (
  cliente_key TEXT PRIMARY KEY,
  texto_fuente TEXT,
  texto_hash TEXT,
  ia_json TEXT,
  ia_at TEXT,
  edit_json TEXT,
  edit_por TEXT,    -- usuario de la sesión (+ " · " nombre tipeado si es otro)
  edit_at TEXT,
  edit_hash TEXT
);
-- Si la tabla ya existía sin edit_hash (el worker la crea en caliente), agregarla a mano:
--   ALTER TABLE corte_direcciones ADD COLUMN edit_hash TEXT;

-- logistica_log (sin cambios de esquema): acciones nuevas 'celda:<campo>' (nota = valor nuevo, hasta 120).
-- kv_cache (sin cambios de esquema), clave nueva:
--   logistica_dir_lock = turno de la IA de direcciones (una request a la vez; si la IA falla queda tomado 45 s = freno).
