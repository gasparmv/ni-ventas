-- Migración 034: leads del formulario B2B de REVENTA (revendedores).
--
-- El form de Meta (con lógica condicional) manda TODOS los leads al Sheet
-- leads-b2b-claude, pestaña "b2b - Reventa-nuevo". Un App Script reenvía cada
-- fila nueva a POST /webhook/reventa-lead. El worker filtra los CUALIFICADOS
-- (tiene experiencia en venta Y tiene clientes) y a esos les manda la plantilla
-- lead_reventa_apertura, los etiqueta "revendedor", los deja en la bandeja
-- general (los ven Joaco y Gaspar, Abril no) y le avisa a Gaspar por WhatsApp.
-- Los NO cualificados no se tocan: van al minicurso por la página E2 del form.
--
-- Aplicar con:
--   wrangler d1 execute ni-ventas --remote --file=migrations/034_reventa_leads.sql

CREATE TABLE IF NOT EXISTS reventa_leads (
  lead_id          TEXT PRIMARY KEY,             -- id del lead de Meta (dedup)
  ts               TEXT,
  phone            TEXT NOT NULL DEFAULT '',
  nombre           TEXT NOT NULL DEFAULT '',
  p1_experiencia   TEXT NOT NULL DEFAULT '',
  p2_clientes      TEXT NOT NULL DEFAULT '',
  p3_rubro         TEXT NOT NULL DEFAULT '',
  cualificado      INTEGER NOT NULL DEFAULT 0,   -- 1 = calificó (experiencia Y clientes)
  template_status  TEXT NOT NULL DEFAULT '',      -- sent | failed | skipped (no cualif)
  template_sent_at TEXT,
  wamid            TEXT NOT NULL DEFAULT '',
  notif_sent       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reventa_leads_cualif ON reventa_leads(cualificado);

-- Etiqueta "revendedor" para el CRM (idempotente).
INSERT OR IGNORE INTO labels (name, color, created_at) VALUES ('revendedor', '#f59e0b', datetime('now'));
