# NI Ventas — contexto para Claude

CRM/dashboard de ventas para Neon Infinito. Frontend en GitHub Pages, backend en Cloudflare Worker.

## Arquitectura

- **Frontend** (`index.html`, `assets/`): SPA estática servida por GitHub Pages en `https://gasparmv.github.io/ni-ventas/`. Push a `main` → deploy automático.
- **Backend** (`worker/`): Cloudflare Worker. Bindings: D1 (`ni-ventas`), R2 (`ni-ventas-media`), Workers AI. URL: `https://ni-ventas-tracker.neoninfinito.workers.dev`. Deploy: `cd worker && wrangler deploy` (NO se deploya por git push).
- **Sheets**: lee Sheet "Ventas" hoja `2026` y Cotizador (Apps Script en `apps-script.js`).

## WhatsApp Business — info clave

- **Número productivo**: +54 9 11 4436-6573, Phone Number ID `919964037861500`, WABA ID `800446462838166`.
- **App de Meta**: "agente neon nuevo", App ID `866678322681866`. Webhook: `/webhook` del worker, verify token `neon-infinito-webhook-2026`.
- **`platform_type: CLOUD_API`** — NO está en modo Coexistencia. **No se puede activar `message_echoes`** para este número (probado 2026-05-05). Si Joaquín manda algo desde la app/web de WA Business, el webhook solo recibe el `status` (sent/delivered) sin contenido.
- Workaround actual: el dashboard muestra placeholder "✓ Respondido desde WhatsApp" (sin contenido) cuando llega un status sin echo. Implementado en `assets/app.js`.
- WABA también está suscrita a la app de PIP (`Fintech Solutions Wsp`, App ID `518523686767316`) — no tocar esa subscripción.

## Login del dashboard

- `Gaspar` requiere password (env `ADMIN_PASSWORD` en el worker).
- `Joaquín` (o `Joaquin`) entra sin password — ver `worker.js` `/auth/login`.

## Convenciones

- Fechas en hora local Argentina, no UTC. Helper `localDateKey()` en `app.js`.
- `wa_messages` tabla central (D1). Direction inbound/outbound, dedup por `wamid`.
- `msg_type='status'` con body vacío = mensaje saliente desde WA Business app (placeholder).
