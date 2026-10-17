-- 059_debi_user.sql — alta de Debi (vendedora secundaria SOLO NEÓN, Gaspar 17-oct-2026).
-- Nace INACTIVA y sin contraseña: no entra ni recibe reparto hasta que Gaspar le pone la clave en Admin → Consultas por
-- vendedor (POST /admin/vendedores/password la activa). password_hash nunca se versiona (repo público).
INSERT OR IGNORE INTO users_panel (id, nombre, rol, password_hash, activo, created_at)
VALUES ('debi', 'Debi', 'comercial', 'REDACTADO', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Reparto (Gaspar: 10 por día para arrancar; después ella lo regula en "Mis consultas"). Prob por lead 0.25.
INSERT OR REPLACE INTO kv_cache (k, v, updated_at) VALUES ('debi_cuota_diaria', '10', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT OR REPLACE INTO kv_cache (k, v, updated_at) VALUES ('debi_reparto_prob', '0.25', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
