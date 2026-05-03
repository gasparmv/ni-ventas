# NI Ventas · Tracking Worker

Backend mínimo para registrar quién (Gaspar/Joaquín) marca seguimientos y cuándo.

## Stack
- **Cloudflare Worker** (gratis hasta 100k req/día).
- **D1** (SQLite gestionado, gratis hasta 5GB y 5M lecturas/día).
- Sin autenticación: el panel es interno, los nombres son solo identificadores.

## Setup (una sola vez)

Desde esta carpeta (`worker/`):

```bash
# 1) Crear la base D1
wrangler d1 create ni-ventas
```

Te devuelve un bloque tipo:
```
[[d1_databases]]
binding = "DB"
database_name = "ni-ventas"
database_id = "abc-123-def-456"
```

Copiá el `database_id` y pegalo en `wrangler.toml` reemplazando `<DB_ID>`.

```bash
# 2) Aplicar el schema (crea la tabla events)
wrangler d1 execute ni-ventas --remote --file=./schema.sql

# 3) Deploy del Worker
wrangler deploy
```

Te imprime la URL pública, tipo:
```
https://ni-ventas-tracker.<tu-subdomain>.workers.dev
```

Esa URL la pegás en el frontend en `assets/app.js` → `CONFIG.trackerUrl = '...'`.

## Endpoints

- `POST /event`  body: `{ user, action, itemId, itemKind, undo? }` → registra el evento.
- `GET  /report?user=&from=&to=` → lista eventos filtrados.
- `GET  /health` → ping.

## Re-deploy tras cambios
```bash
wrangler deploy
```

## Migrar schema más adelante
Editá `schema.sql` agregando `ALTER TABLE` y corré:
```bash
wrangler d1 execute ni-ventas --remote --file=./schema.sql
```
