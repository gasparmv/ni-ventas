-- Migración 013: wa_autoreply_log — registro atómico de auto-respuestas.
--
-- El dedup por "¿ya hay un outbound con el link?" tenía una ventana de carrera:
-- si el webhook del mismo mensaje llega 2 veces casi simultáneo (reintento de
-- Meta/360dialog), ambas ejecuciones leen "no enviado" antes de que la primera
-- inserte → doble envío. Esta tabla con PK (phone, kind) permite reservar el
-- envío con INSERT OR IGNORE atómico: solo una ejecución gana.

CREATE TABLE IF NOT EXISTS wa_autoreply_log (
  phone   TEXT NOT NULL,
  kind    TEXT NOT NULL,      -- 'minicurso' | (futuras auto-respuestas)
  sent_at TEXT NOT NULL,
  PRIMARY KEY (phone, kind)
);

-- Backfill: marcar como ya-enviado a todos los que recibieron el link de regalos,
-- para que el dedup nuevo los respete y no les reenvíe.
INSERT OR IGNORE INTO wa_autoreply_log (phone, kind, sent_at)
SELECT phone, 'minicurso', MIN(ts)
FROM wa_messages
WHERE direction = 'outbound' AND body LIKE '%14q3QvLPY6vO9d0qSLN%'
GROUP BY phone;
