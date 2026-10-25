-- Pagos a Aníbal (corte de acrílico), Gaspar 24-oct-2026: cada pago con las filas de Venta_Insumos que cubre ([fila, monto, lunes]).
CREATE TABLE IF NOT EXISTS anibal_pagos (id INTEGER PRIMARY KEY AUTOINCREMENT, pagado_at TEXT, monto INTEGER, calculado INTEGER, filas TEXT, semanas TEXT, n_filas INTEGER, metodo TEXT, nota TEXT, por TEXT, created_at TEXT);
