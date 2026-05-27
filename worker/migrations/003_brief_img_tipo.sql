-- Migración 003: tipo de imagen en brief_imagenes
-- 'chat'   = captura del chat / referencia que sube el comercial (Joaco)
-- 'render' = render del diseño que sube el diseñador (Emma)
--
-- Aplicar con:
--   wrangler d1 execute ni-ventas --file=worker/migrations/003_brief_img_tipo.sql --remote

ALTER TABLE brief_imagenes ADD COLUMN tipo TEXT NOT NULL DEFAULT 'chat';
CREATE INDEX IF NOT EXISTS idx_brief_img_brief_tipo ON brief_imagenes(brief_id, tipo, orden);
