# NI Ventas

App web de gestión de ventas para Neon Infinito. Read-only en Fase 1; lee en vivo de:

- Sheet **"Ventas"** hoja `2026` (pedidos cerrados)
- **Cotizador** hojas `Abril`+ (presupuestos enviados)

## Vistas

- **Dashboard** — KPIs del mes, gráficos (ventas/día, estado pedidos, canal AD), alertas de seguimientos.
- **Pedidos** — tabla rica con filtros (mes, estado pago, estado pedido, canal AD), búsqueda y sort. Click en fila → detalle completo con timeline post-venta integrado.
- **Presupuestos** — lista del Cotizador con cross-match contra pedidos cerrados (por nombre + ±20% precio). Filtros: Todos / Abiertos / Para seguir / Cerrados.
- **Seguimientos** — centro unificado: presupuestos abiertos +7 días + post-venta D30/D60/D90. Cada uno con link directo a WhatsApp.
- **Clientes** — vista por cliente con timeline de toda su actividad.

## Deploy (GitHub Pages)

```bash
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin git@github.com:neoninfinito/ni-ventas.git
git push -u origin main
```

GitHub: Settings → Pages → Source = `main` branch, root. URL: `https://neoninfinito.github.io/ni-ventas/`.

## Requisitos sobre los Sheets

Ambos Sheets tienen que estar como **"Cualquiera con el link puede ver"**.

## Configuración

`CONFIG` al inicio de `assets/app.js`:
- `ventasSheetId`, `ventasSheetName`
- `cotizadorSheetId`, `cotizadorSheets` (lista de hojas mensuales)
- `matchPriceTolerance` — default 0.20 (±20%)
- `presupuestoFollowupDays` — default 7
- `postventaMilestones` — D30/D60/D90 con templates

## Stack

Vanilla HTML/CSS/JS, sin build, sin dependencias.
