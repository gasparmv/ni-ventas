-- Migración 017: tabla de phones no alcanzables.
--
-- Cuando Meta nos rechaza un envío con ciertos códigos, el contacto está
-- "muerto" para outreach automático y no tiene sentido insistir con
-- templates ni re-engagement. Los marcamos acá para skipearlos.
--
-- Códigos de Meta detectados:
--   131026 → "Message undeliverable" (cliente sin WA, bloqueó nuestro número,
--            número viejo migrado, etc.)
--   131049 → "This message was not delivered to maintain healthy ecosystem
--            engagement" (Meta protegiendo al cliente — bajo engagement con
--            WhatsApp Business, marcó otros como spam, etc.). Si se acumulan
--            muchos, baja nuestro quality rating.
--   131047 → "Re-engagement message" — ventana de 24h cerrada.
--   131048 → "Spam rate limit hit".
--
-- Auto-recovery: si el contacto manda un mensaje inbound (osea, está vivo),
-- lo removemos automáticamente de esta tabla (ver webhook handler).
--
-- Aplicar con:
--   wrangler d1 execute ni-ventas --remote --file=worker/migrations/017_wa_unreachable_phones.sql

CREATE TABLE IF NOT EXISTS wa_unreachable_phones (
  phone TEXT PRIMARY KEY,
  marked_at TEXT NOT NULL,
  reason TEXT NOT NULL,             -- 'undeliverable' | 'ecosystem' | 'rate_limit' | 'window_closed' | 'manual'
  last_error TEXT,                  -- mensaje completo del error (truncado)
  last_template TEXT,               -- qué template falló (si aplica)
  fail_count INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wa_unreachable_marked ON wa_unreachable_phones(marked_at);
CREATE INDEX IF NOT EXISTS idx_wa_unreachable_reason ON wa_unreachable_phones(reason);
