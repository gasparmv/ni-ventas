-- Edición de los pedidos de corte de Sin Frontera (22-oct-2026): quién y cuándo lo cambió por última vez.
ALTER TABLE sf_cortes ADD COLUMN editado_at TEXT;
ALTER TABLE sf_cortes ADD COLUMN editado_por TEXT;
