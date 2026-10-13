-- Vigía de logística (13-oct-2026). Un renglón por evento de la pantalla de logística:
--  origen 'server': cada POST a /admin/logistica/* (con su tiempo) y los GET que fallan o tardan;
--  origen 'front': errores de la página y el uso de lo que no pasa por el server (WhatsApp, Copiar, Excel, Imprimir...).
-- tipo: ok | bloqueo (409, el freno de impago) | error | lento | uso. avisado=1: ya se le avisó a Gaspar por WhatsApp.
-- El worker la crea solo (ensureLogiVigiaSchema); este archivo queda como registro.
CREATE TABLE IF NOT EXISTS logistica_vigia (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  usuario TEXT,
  operador TEXT,
  origen TEXT,
  tipo TEXT,
  accion TEXT,
  cliente_key TEXT,
  status INTEGER,
  ms INTEGER,
  detalle TEXT,
  avisado INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_logistica_vigia_ts ON logistica_vigia(ts);
CREATE INDEX IF NOT EXISTS idx_logistica_vigia_aviso ON logistica_vigia(avisado, tipo);
