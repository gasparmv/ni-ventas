-- Migración 022: panel de costos del sitio.
-- site_services: inventario de TODO lo que hace andar el CRM (IAs, infra,
-- mensajería, almacenamiento, ads) con: qué hace, dónde vive la credencial
-- (NUNCA el valor del secreto, solo la ubicación), y el costo mensual.
-- cost_type='auto' => el costo lo calcula el worker desde datos reales (Anthropic
-- desde copilot_usage + wa_chat_analyses). 'fixed' => monto fijo editable por
-- Gaspar. 'usage' => variable estimado. 'free' => $0.
-- El tipo de cambio USD->ARS para el total se guarda en kv_cache (key usd_ars_rate).
CREATE TABLE IF NOT EXISTS site_services (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  sort_order          INTEGER NOT NULL DEFAULT 100,
  name                TEXT NOT NULL,
  category            TEXT NOT NULL DEFAULT 'otro',   -- ia | infra | mensajeria | almacenamiento | ads | otro
  provider            TEXT NOT NULL DEFAULT '',
  usage               TEXT NOT NULL DEFAULT '',       -- qué hace en el sitio
  credential_location TEXT NOT NULL DEFAULT '',       -- dónde está la credencial (ubicación, no el valor)
  cost_type           TEXT NOT NULL DEFAULT 'fixed',  -- auto | fixed | usage | free
  cost_amount         REAL NOT NULL DEFAULT 0,        -- mensual, en cost_currency (ignorado si auto/free)
  cost_currency       TEXT NOT NULL DEFAULT 'USD',    -- USD | ARS | EUR
  auto_key            TEXT NOT NULL DEFAULT '',       -- para cost_type=auto: qué computar (ej. 'anthropic')
  billing_url         TEXT NOT NULL DEFAULT '',       -- dónde se ve/paga
  notes               TEXT NOT NULL DEFAULT '',
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_services_active ON site_services(active);
