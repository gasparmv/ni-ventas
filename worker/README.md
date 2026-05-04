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

Públicos:
- `POST /event` body: `{ user, action, itemId, itemKind, undo? }` → registra el evento.
- `GET  /report?user=&from=&to=` → lista eventos filtrados.
- `GET  /health` → ping.

Auth:
- `POST /auth/login` `{ user, password }` → `{ token }`
- `POST /auth/logout` (Bearer) → 204
- `GET  /auth/me` (Bearer) → `{ user }`

Admin (Bearer):
- `GET  /admin/activity?user=&from=&to=` → eventos filtrados (gated).
- `PUT  /admin/cotizador/params` → actualiza params del cotizador.
- `POST /admin/wa/send` `{ to, body }` → manda texto libre por WhatsApp (ventana 24h).
- `POST /admin/wa/template` `{ to, name, lang?, params?: [] }` → manda plantilla aprobada.
- `POST /admin/wa/followups` `{ items: [{to, name, milestone, pedidoId, message?}] }` → procesa lote.

## WhatsApp Cloud API

Setear secrets antes del primer deploy:
```bash
wrangler secret put WA_TOKEN                   # token permanente System User (no expira)
wrangler secret put APPS_SCRIPT_FOLLOWUPS_URL  # endpoint Apps Script con seguimientos pendientes
```

Las variables `WA_PHONE_NUMBER_ID` y `WA_API_VERSION` ya están en `wrangler.toml`.

### Cron Trigger
Definido en `wrangler.toml` (`crons = ["0 13 * * *"]` → 13:00 UTC = 10:00 AR).
Cada disparo:
1. GET al endpoint `APPS_SCRIPT_FOLLOWUPS_URL` (debe devolver `{ items: [...] }`)
2. Por cada item manda WhatsApp (template o texto libre)
3. Logea en tabla `wa_log` (idempotente por día via `ref`)

Apps Script debe devolver:
```json
{ "items": [
  { "to": "5491155604999", "name": "Juan", "milestone": "D30", "pedidoId": "123" }
]}
```

## Re-deploy tras cambios
```bash
wrangler deploy
```

## Migrar schema más adelante
Editá `schema.sql` agregando `ALTER TABLE` y corré:
```bash
wrangler d1 execute ni-ventas --remote --file=./schema.sql
```
