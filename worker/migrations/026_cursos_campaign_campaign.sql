-- Migración 026: distinguir campañas en wa_cursos_campaign.
-- 'mayo' (lanzamiento 6-7 de mayo) vs 'junio' (lanzamiento junio 2026). Define
-- qué plantilla/mensaje de revelado corresponde a cada contacto del broadcast.
ALTER TABLE wa_cursos_campaign ADD COLUMN campaign TEXT NOT NULL DEFAULT 'mayo';
