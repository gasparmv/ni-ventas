-- Migración 025: prioridad y re-edición de briefs (feature urgencia/modificar).
-- urgente:   pedido marcado urgente por Joaco/Gaspar → va ARRIBA en "A cotizar"
--            para que Emma lo tome como prioridad.
-- modificar: el pedido volvió de "Listo" a "A cotizar" porque el cliente pidió un
--            cambio → muestra el sticker "modificar" (+ se marca urgente).
ALTER TABLE briefs ADD COLUMN urgente INTEGER NOT NULL DEFAULT 0;
ALTER TABLE briefs ADD COLUMN modificar INTEGER NOT NULL DEFAULT 0;
