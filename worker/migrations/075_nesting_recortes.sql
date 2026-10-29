-- 075 — Recortes del taller del nesting guardados en el usuario (Gaspar, 29-oct-2026: "que Fran entre con el mismo user al
-- nesting y que pueda guardarse recortes por material"). Hasta acá vivían en el localStorage de cada compu (nesting_recortes);
-- ahora cada usuario (dueno: 'gaspar', 'fran') tiene los suyos, con material ('acrilico' | 'pvc' | 'mdf' | 'policarbonato' |
-- 'alto_impacto' | '' = sin material), color (texto), color_hex y espesor (mm, texto: '3', '2.5'). rings = JSON de contornos
-- en mm con la esquina en (0, 0): el primero es el borde y los demás, huecos. Borrado lógico (borrado_at).
-- La crea también ensureNestingRecortesSchema en el worker; esta queda de registro:
--   cd worker && npx wrangler d1 execute ni-ventas --remote --config wrangler.toml --file=migrations/075_nesting_recortes.sql
CREATE TABLE IF NOT EXISTS nesting_recortes (
  dueno TEXT NOT NULL,
  id TEXT NOT NULL,
  nombre TEXT NOT NULL DEFAULT '',
  material TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  color_hex TEXT,
  espesor TEXT NOT NULL DEFAULT '',
  rings TEXT NOT NULL,
  largo REAL NOT NULL,
  ancho REAL NOT NULL,
  area REAL NOT NULL,
  origen TEXT,
  usar INTEGER NOT NULL DEFAULT 0,
  creado_at TEXT NOT NULL,
  creado_por TEXT,
  editado_at TEXT,
  editado_por TEXT,
  borrado_at TEXT,
  borrado_por TEXT,
  PRIMARY KEY (dueno, id)
);
