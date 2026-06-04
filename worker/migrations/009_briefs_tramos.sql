-- Migración 009: agregar columna "tramos" al brief.
--
-- "tramos" = cantidad de cortes/subtrazos independientes del neón LED del
-- diseño (se cuenta en Illustrator). Es input del cotizador NUEVO — afecta
-- el margen por complejidad (más tramos → más trabajo de empalme → más margen).
--
-- Lo carga el diseñador (Emma) junto con ancho/alto/neón al armar el render.
-- INTEGER, default 0 para back-compat con briefs viejos. SQLite acepta null
-- igual; un brief sin tramos cotiza con densidad=0 (margen por tamaño nada más).
--
-- Aplicar con:
--   wrangler d1 execute ni-ventas --remote --file=worker/migrations/009_briefs_tramos.sql

ALTER TABLE briefs ADD COLUMN tramos INTEGER DEFAULT 0;
