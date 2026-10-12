-- 051: avisos internos (Etapa 1 del plan de arreglos de fondo, oct-2026).
-- Un solo camino para avisarle algo a alguien del equipo (avisoInterno): registra cada aviso, elige la via
-- (texto si la ventana de 24h esta abierta, plantilla UTILITY si no, resumen, cola de silencio o tope por hora)
-- y sigue su entrega por los statuses del webhook. Arranca en aviso_interno_modo='dry': todo sigue saliendo
-- como hoy y lo nuevo solo registra que habria hecho.
-- Aplicar ANTES del deploy de la Etapa 1. Sin emojis ni caracteres fuera de ASCII (wrangler en Windows).
-- El worker crea lo mismo en caliente (ensureAvisosSchema: solo tablas y columnas, ALTER en try/catch,
-- verificacion antes de memoizar). Si el worker ya corrio, el ALTER del final falla por "duplicate column":
-- en ese caso comentarlo y volver a correr.

CREATE TABLE IF NOT EXISTS avisos_internos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clave TEXT UNIQUE,                       -- '<tipo>:<id>:<slug>'; NULL = sin dedup
  dest TEXT NOT NULL, dest_slug TEXT NOT NULL DEFAULT '',
  tipo TEXT NOT NULL,
  prioridad TEXT NOT NULL DEFAULT 'P2' CHECK (prioridad IN ('P1','P2','P3')),
  texto TEXT NOT NULL, ref_phone TEXT NOT NULL DEFAULT '', media_keys TEXT NOT NULL DEFAULT '',
  via TEXT NOT NULL DEFAULT '', decision TEXT NOT NULL DEFAULT '',
  wamid TEXT, wamid_prev TEXT,
  status TEXT NOT NULL DEFAULT 'pendiente', -- pendiente|dry|enviando|enviado|entregado|leido|fallido|reintentando|perdido|sin_confirmar|digest|cola|tope|pausado|agrupado|descartado
  error_code TEXT NOT NULL DEFAULT '', intentos INTEGER NOT NULL DEFAULT 0, digest_id INTEGER,
  created_at TEXT NOT NULL, sent_at TEXT, delivered_at TEXT, read_at TEXT, flushed_at TEXT,
  visto_at TEXT, visto_por TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_avisos_wamid          ON avisos_internos(wamid) WHERE wamid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_avisos_dest_created   ON avisos_internos(dest, created_at);
CREATE INDEX IF NOT EXISTS idx_avisos_status_created ON avisos_internos(status, created_at);
-- Panel (ultimas 24 h), tope global por hora y purga de +90 dias: rango por fecha sin escanear la tabla.
CREATE INDEX IF NOT EXISTS idx_avisos_created        ON avisos_internos(created_at);

-- Autor real de cada envio manual del CRM (wamid -> slug de agenda_phones). Lo usa avisoInterno({autor})
-- para que la falla de un envio le llegue a quien lo mando. Se purga a los 14 dias.
CREATE TABLE IF NOT EXISTS wa_send_author (wamid TEXT PRIMARY KEY, autor TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', ts TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_wa_send_author_ts ON wa_send_author(ts);

-- Kill-switch y perillas (todo se cambia sin deploy desde Admin -> Avisos internos o POST /admin/avisos/config).
-- Sin la fila de modo el worker usa 'off' (un deploy sin esta migracion no prende nada).
INSERT OR IGNORE INTO kv_cache (k, v, updated_at) VALUES
 ('aviso_interno_modo','dry',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('aviso_interno_vendedores_on','0',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('aviso_interno_tope_hora','12',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('aviso_interno_tope_p1_hora','30',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('aviso_interno_tope_global_hora','80',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('aviso_interno_tpl_chain','["aviso_interno_crm","recordatorio_agenda"]',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('aviso_interno_gaspar_marketing_ok','1',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('aviso_interno_retry_on','1',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('aviso_interno_flush_on','1',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('aviso_interno_silencio','22-8',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('aviso_interno_tope_filas_corrida','20000',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('aviso_interno_tope_filas_dia','200000',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('resumen_horas','10,14,18',strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Decision 6 del plan (default si): Neyen y Anibal tambien son equipo. Los avisos ya los toman de agenda_phones;
-- esto ademas los saca del analisis de chats y del reparto (que miran wa_internal_phones).
INSERT OR IGNORE INTO wa_internal_phones (phone, name, role, added_at) VALUES
 ('5491162080023','Neyen','produccion',strftime('%Y-%m-%dT%H:%M:%SZ','now')),
 ('5491162889259','Anibal','produccion',strftime('%Y-%m-%dT%H:%M:%SZ','now'));

-- Ultimo: no idempotente (si falla por "duplicate column", ya lo creo ensureAvisosSchema).
ALTER TABLE template_status_cache ADD COLUMN category TEXT NOT NULL DEFAULT '';
