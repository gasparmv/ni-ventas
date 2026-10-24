-- Cuenta del alumno en la página del corte, "Mis pedidos" (24-oct-2026).
CREATE TABLE IF NOT EXISTS corte_cuentas (telefono TEXT PRIMARY KEY, nombre TEXT, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, created_at TEXT, updated_at TEXT, ultimo_login TEXT, fallos INTEGER NOT NULL DEFAULT 0, bloqueado_hasta TEXT);
CREATE TABLE IF NOT EXISTS corte_cuenta_sesiones (token TEXT PRIMARY KEY, telefono TEXT NOT NULL, created_at TEXT, expires_at TEXT);
CREATE INDEX IF NOT EXISTS idx_corte_cuenta_ses_tel ON corte_cuenta_sesiones (telefono);
CREATE TABLE IF NOT EXISTS corte_cuenta_codigos (telefono TEXT PRIMARY KEY, proposito TEXT, codigo_hash TEXT, expires_at TEXT, intentos INTEGER NOT NULL DEFAULT 0, ultimo_envio TEXT);
CREATE TABLE IF NOT EXISTS corte_pedidos_cambios (id INTEGER PRIMARY KEY AUTOINCREMENT, pieza_id INTEGER NOT NULL, telefono TEXT, campo TEXT, antes TEXT, despues TEXT, por TEXT, at TEXT, tras_diseno INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_corte_cambios_pieza ON corte_pedidos_cambios (pieza_id);
ALTER TABLE corte_pedidos ADD COLUMN cliente_editado_at TEXT;
ALTER TABLE corte_pedidos ADD COLUMN cliente_edit_tras_diseno INTEGER NOT NULL DEFAULT 0;
ALTER TABLE corte_pedidos ADD COLUMN cliente_cambio_txt TEXT;
