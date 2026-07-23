-- Migración 038: dedup de plantillas "adhoc" para no volver a inflar la cuenta de
-- WhatsApp con una plantilla MARKETING nueva por cada mensaje fuera de ventana
-- (causa de la inhabilitación de Meta de jul-2026). body_norm = texto normalizado;
-- permite REUSAR una plantilla ya aprobada con el mismo texto en vez de crear otra.

ALTER TABLE wa_pending_template_send ADD COLUMN body_norm TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_pending_tpl_bodynorm ON wa_pending_template_send(body_norm, status);
