-- Migración 028: etiqueta para las SEÑAS del lanzamiento junio (~40.000 ARS).
-- Mucha gente seña el acceso al curso con ~40k; esos comprobantes se etiquetan
-- "seña lanzamiento junio" (distinto del pago completo "pago lanzamiento junio").

INSERT OR IGNORE INTO labels (name, color, created_at) VALUES ('seña lanzamiento junio', '#06b6d4', datetime('now'));
