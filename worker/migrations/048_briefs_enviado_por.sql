-- 048 — Quién mandó cada presupuesto (panel de rendimiento por vendedor, 12-oct-2026).
-- briefs.comercial_id se MUEVE con el lead (reasignaciones) y sirve para la comisión; enviado_por
-- queda fijo con quien apretó "Enviar" (slug del vendedor o usuario en minúscula). Vacío = viejo.
--   wrangler d1 execute ni-ventas --remote --config wrangler.toml --file=migrations/048_briefs_enviado_por.sql
ALTER TABLE briefs ADD COLUMN enviado_por TEXT DEFAULT '';
