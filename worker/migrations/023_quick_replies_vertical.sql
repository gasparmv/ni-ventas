-- Migración 023: vertical (carteles|cursos) en quick_replies.
-- Permite filtrar las respuestas guardadas por rol en el menú "/" del chat:
--   Joaco (comercial) ve 'carteles', Abril (cursos) ve 'cursos', Gaspar (admin) ve todas.
-- Las 4 existentes: Colocación + frenterender = carteles (default); Completo + Feedback = cursos.

ALTER TABLE quick_replies ADD COLUMN vertical TEXT NOT NULL DEFAULT 'carteles';
UPDATE quick_replies SET vertical = 'cursos' WHERE LOWER(shortcut) IN ('completo', 'feedback');
