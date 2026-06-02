-- Migración 005: wa_webhook_debug — log de mensajes inbound que Meta marca como
-- "unavailable" o "unsupported". Capturamos el JSON crudo + el error.title +
-- error.code para diagnosticar por qué llegan tantos mensajes sin contenido.
--
-- Use case: investigar el patrón de "Mensaje no disponible" que ocurre con
-- contactos que jamás aparecen en la app de WhatsApp Business del celu — Meta
-- nos notifica al webhook pero filtra la entrega. Posibles causas: msgs
-- eliminados por el sender, contenido tipo bot/spam, edits que no comparten
-- contenido.

CREATE TABLE IF NOT EXISTS wa_webhook_debug (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,                -- ISO timestamp del mensaje original
  inserted_at   TEXT NOT NULL,                -- cuando lo guardamos en debug
  wamid         TEXT NOT NULL DEFAULT '',     -- ID de Meta del mensaje
  phone         TEXT NOT NULL DEFAULT '',     -- desde quién venía
  sender_name   TEXT NOT NULL DEFAULT '',     -- nombre del perfil de WA si Meta lo expuso
  error_code    INTEGER,                      -- m.errors[0].code (131051, etc)
  error_title   TEXT NOT NULL DEFAULT '',     -- m.errors[0].title ('Message type unknown', 'unavailable', etc)
  error_details TEXT NOT NULL DEFAULT '',     -- m.errors[0].details si lo manda
  msg_type      TEXT NOT NULL DEFAULT '',     -- m.type del payload (errors, unsupported, etc)
  classified_as TEXT NOT NULL DEFAULT '',     -- cómo lo clasificamos al guardarlo (mensaje no disponible, editado, etc)
  raw_payload   TEXT NOT NULL DEFAULT ''      -- JSON.stringify del m completo, para diagnóstico
);
CREATE INDEX IF NOT EXISTS idx_wa_webhook_debug_ts ON wa_webhook_debug(ts DESC);
CREATE INDEX IF NOT EXISTS idx_wa_webhook_debug_phone ON wa_webhook_debug(phone);
