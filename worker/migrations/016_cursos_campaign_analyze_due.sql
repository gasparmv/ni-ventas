-- Migración 016: agregar analyze_due_at a wa_cursos_campaign.
--
-- Cambia el flujo de respuesta del cliente al template 1:
-- ANTES: el primer mensaje del cliente disparaba el análisis con IA al toque
--   (analyzeResponseSentiment) y solo veía ese primer mensaje. Si el cliente
--   tipeaba "hola" y después "uy si, me interesa", la IA solo veía "hola".
-- AHORA: el primer mensaje marca analyze_due_at = now + 2 min (y responded_at).
--   Cuando vence el plazo, el cron junta TODOS los mensajes inbound del
--   cliente desde sent_1_at y los manda concatenados a Claude. Mucho más
--   certero.
--
-- Aplicar con:
--   wrangler d1 execute ni-ventas --remote --file=worker/migrations/016_cursos_campaign_analyze_due.sql

ALTER TABLE wa_cursos_campaign ADD COLUMN analyze_due_at TEXT;
CREATE INDEX IF NOT EXISTS idx_wa_cursos_campaign_analyze ON wa_cursos_campaign(analyze_due_at);
