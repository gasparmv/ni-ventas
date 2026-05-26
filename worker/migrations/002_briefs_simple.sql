-- Migración 002: simplificación del brief
-- - Agregar columna medidas_libre (texto opcional: "60x40 aprox", "letras 80cm", etc.)
-- - Crear tabla brief_imagenes con keys R2 de las capturas que pegó Joaco.
--
-- Aplicar con:
--   wrangler d1 execute ni-ventas --file=worker/migrations/002_briefs_simple.sql --remote

-- SQLite no soporta IF NOT EXISTS para ALTER TABLE ADD COLUMN, así que envolvemos
-- en transacción que ignora el error si la columna ya existe (idempotente vía retry).
-- En la práctica wrangler ejecuta cada statement por separado: si existe, falla pero
-- no aborta el resto si se corre con tolerancia. Como alternativa segura,
-- la mejor práctica es no re-correr este archivo dos veces.

ALTER TABLE briefs ADD COLUMN medidas_libre TEXT;

-- Tabla de imágenes asociadas a cada brief.
-- Cada fila apunta a una key del bucket R2 (env.MEDIA = ni-ventas-media).
-- orden = posición visible en el drawer (0-based).
CREATE TABLE IF NOT EXISTS brief_imagenes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  brief_id    INTEGER NOT NULL,
  r2_key      TEXT NOT NULL,
  content_type TEXT,
  size_bytes  INTEGER,
  orden       INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brief_img_brief ON brief_imagenes(brief_id, orden);
