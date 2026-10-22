-- Avisos por tanda (22-oct-2026): los "Falló envío" y "Plantilla aprobada y enviada" de una misma ráfaga van en un solo aviso.
CREATE TABLE IF NOT EXISTS avisos_tanda (id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT NOT NULL, clave TEXT UNIQUE, phone TEXT, detalle TEXT, preview TEXT, texto TEXT, created_at TEXT NOT NULL, flushed_at TEXT);
CREATE INDEX IF NOT EXISTS idx_avisos_tanda_pend ON avisos_tanda (flushed_at, tipo, created_at);
