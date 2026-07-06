-- Migración 035: marca del evento de calidad CAPI para leads B2B.
-- Cuando un lead del form de carteles RESPONDE por WhatsApp (señal de que es un
-- lead real, no basura), mandamos el evento "QualifiedLead" a Meta una sola vez.
-- Esta columna evita re-mandarlo.
--
-- Aplicar con:
--   wrangler d1 execute ni-ventas --remote --file=migrations/035_wa_leads_capi_qualified.sql

ALTER TABLE wa_leads ADD COLUMN capi_qualified_at TEXT;
