-- 041_agustina_user.sql — alta de Agustina (vendedora comercial secundaria, molde Facu).
-- Versiona el alta que hoy se hace por INSERT directo (Facundo nunca quedó versionado).
-- password_hash: NO se versiona (repo público); la clave se carga desde Admin → Usuarios. activo=1.
-- Reparto de sus leads: kv agustina_cuota_diaria / agustina_reparto_prob (ver seed abajo).
INSERT OR IGNORE INTO users_panel (id, nombre, rol, password_hash, activo, created_at)
VALUES ('agustina', 'Agustina', 'comercial', 'REDACTADO', 1, datetime('now'));

-- Reparto: 10 leads/día al azar (prob por-lead 0.30). Se pueden editar desde el panel de Pre cotización.
INSERT OR REPLACE INTO kv_cache (k, v, updated_at) VALUES ('agustina_cuota_diaria', '10', datetime('now'));
INSERT OR REPLACE INTO kv_cache (k, v, updated_at) VALUES ('agustina_reparto_prob', '0.30', datetime('now'));
