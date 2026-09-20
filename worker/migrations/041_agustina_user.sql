-- 041_agustina_user.sql — alta de Agustina (vendedora comercial secundaria, molde Facu).
-- Versiona el alta que hoy se hace por INSERT directo (Facundo nunca quedó versionado).
-- password_hash = sha256(hex, sin sal) de la clave entregada a Agustina. activo=1.
-- Reparto de sus leads: kv agustina_cuota_diaria / agustina_reparto_prob (ver seed abajo).
INSERT OR IGNORE INTO users_panel (id, nombre, rol, password_hash, activo, created_at)
VALUES ('agustina', 'Agustina', 'comercial', '28495462740c28bb7d926a92520e011c1c85f41bfdadc26d1e856b03291c4e87', 1, datetime('now'));

-- Reparto: 10 leads/día al azar (prob por-lead 0.30). Se pueden editar desde el panel de Pre cotización.
INSERT OR REPLACE INTO kv_cache (k, v, updated_at) VALUES ('agustina_cuota_diaria', '10', datetime('now'));
INSERT OR REPLACE INTO kv_cache (k, v, updated_at) VALUES ('agustina_reparto_prob', '0.30', datetime('now'));
