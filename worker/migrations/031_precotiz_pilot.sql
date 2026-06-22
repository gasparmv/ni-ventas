-- Migración 031: piloto de PRE COTIZACIÓN automática de carteles.
--
-- OBJETIVO: automatizar SOLO la etapa de pre cotización (apertura + relevamiento
-- hasta juntar los 3 datos: foto + medidas + interior/exterior) para el 20% de
-- los leads nuevos, con tope de 10 personas. El bot responde con "freno de mano"
-- (escala a Gaspar ante B2B / objeción / queja / fuera de guion).
--
-- La BANDEJA solo-Gaspar reusa la columna inbox de wa_chats_summary (mig. 012):
-- los chats en pre cotización se marcan inbox='precotiz' (Joaco NO los ve, Gaspar
-- sí); al completar los 3 datos vuelven a inbox='general' (ahí recién los ve Joaco).
--
-- El MODO (draft = Gaspar aprueba los mensajitos / auto = auto-envío) y el ON/OFF
-- global del piloto viven en kv_cache (no necesitan tabla): 'precotiz_modo',
-- 'precotiz_on'.
--
-- Aplicar con:
--   wrangler d1 execute ni-ventas --remote --file=migrations/031_precotiz_pilot.sql

CREATE TABLE IF NOT EXISTS precotiz_pilot (
  phone            TEXT PRIMARY KEY,
  estado           TEXT NOT NULL DEFAULT 'activo',   -- activo | completo | escalado
  tiene_foto       INTEGER NOT NULL DEFAULT 0,
  tiene_medidas    INTEGER NOT NULL DEFAULT 0,
  tiene_intext     INTEGER NOT NULL DEFAULT 0,
  nombre           TEXT NOT NULL DEFAULT '',
  escalado_motivo  TEXT NOT NULL DEFAULT '',
  pending_draft    TEXT NOT NULL DEFAULT '',          -- JSON array de mensajitos esperando OK de Gaspar (modo draft)
  draft_ts         TEXT NOT NULL DEFAULT '',          -- cuándo se generó el draft pendiente
  msgs_bot         INTEGER NOT NULL DEFAULT 0,         -- cuántas tandas de mensajes mandó el bot
  last_inbound_ts  TEXT NOT NULL DEFAULT '',          -- último inbound del cliente registrado
  last_processed_ts TEXT NOT NULL DEFAULT '',         -- hasta qué inbound ya procesó el motor (no re-procesar)
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  completed_at     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_precotiz_estado ON precotiz_pilot(estado);
