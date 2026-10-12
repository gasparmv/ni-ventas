-- 047 — Qué producto quiere el lead del bot de precotización (12-oct-2026).
-- La IA marca en cada respuesta "neon" | "corporeo" | "no_sabe"; se guarda el último valor definido
-- para que, si el cliente pidió corpóreo (aunque no haya venido de un anuncio de corpóreo), en los
-- turnos siguientes corran las reglas fijas del corpóreo (sin techo ni tipografías) y quede la
-- etiqueta 🔠 Corpóreo. Vacío = todavía no se sabe (se decide por el anuncio, si hay).
--   wrangler d1 execute ni-ventas --remote --config wrangler.toml --file=migrations/047_precotiz_producto.sql
ALTER TABLE precotiz_pilot ADD COLUMN producto TEXT DEFAULT '';
