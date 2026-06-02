# NI Ventas — contexto para Claude

CRM/dashboard de ventas para Neon Infinito. Frontend en GitHub Pages, backend en Cloudflare Worker.

## ⚠ REGLA CRÍTICA — Verificar sync ANTES de editar

Hay múltiples sesiones de Claude editando este repo desde distintas PCs y celulares (Remote Control). Antes de leer o editar CUALQUIER archivo, **siempre arrancar con esto**:

```bash
git fetch origin
git status              # ver si hay cambios uncommitted locales
git log HEAD..origin/main --oneline   # ver si origin tiene commits que no tenés
```

- Si `origin/main` tiene commits nuevos → `git pull origin main` ANTES de editar
- Si hay cambios locales uncommitted → preguntar al usuario qué hacer con ellos antes de pullear (pueden ser de otra sesión Claude que no llegó a commitear)
- **NUNCA editar sin verificar sync primero.** El tool `Read` lee del filesystem local, no de GitHub. Editar sobre código viejo genera conflictos al pushear o pisa trabajo de otras sesiones.

Si vas a editar un archivo que también modificó un commit reciente del remoto, primero hacer el pull y revisar cómo quedó el archivo actualizado — el problema que vas a resolver puede que ya esté resuelto, o la estructura del código puede haber cambiado.


## Arquitectura

- **Frontend** (`index.html`, `assets/`): SPA estática servida por GitHub Pages en `https://gasparmv.github.io/ni-ventas/`. Push a `main` → deploy automático.
- **Backend** (`worker/`): Cloudflare Worker. Bindings: D1 (`ni-ventas`), R2 (`ni-ventas-media`), Workers AI. URL: `https://ni-ventas-tracker.neoninfinito.workers.dev`. Deploy: `cd worker && wrangler deploy` (NO se deploya por git push).
- **Sheets**: lee Sheet "Ventas" hoja `2026` y Cotizador (Apps Script en `apps-script.js`).

## WhatsApp Business — info clave

- **Número productivo**: +54 9 11 4436-6573, Phone Number ID `919964037861500`, WABA ID `800446462838166`.
- **Provider activo (desde 2026-05-31)**: **360dialog** como BSP en modo Coexistencia.
  - API base: `https://waba-v2.360dialog.io`
  - API key en secret `D360_API_KEY` (Cloudflare worker)
  - Channel ID (interno 360dialog): `vrx5QVCH`
  - Hosting: Cloud API hosted by Meta (migrado de ON_PREMISE)
  - Webhook recibe en `/webhook` del worker (mismo endpoint que Meta direct)
  - Funds prepagados en 360dialog hub
- **Modo Coexistencia activo**: Joaco mantiene la app WA Business del celular Y el CRM funciona con Cloud API. Regla: Joaco debe abrir la app al menos 1 vez cada 13 días o se desactiva. PIN 2FA configurado: `230204` (uso si se necesita re-migrar).
- **App de Meta (legacy)**: "agente neon nuevo", App ID `866678322681866`. Antes del 31-may era el provider productivo via Meta directo con `WA_TOKEN`. Ya no se usa para sends, pero el secret WA_TOKEN se mantiene como fallback (si se setea WA_PROVIDER='meta' en el worker, vuelve al provider Meta direct).
- **Pre-migración (histórico)**: el número estaba en ON_PREMISE con flag 2494160 que bloqueaba templates. PIP (`Fintech Solutions Wsp`, App ID `518523686767316`) era un BSP previo, removido del Business Portfolio durante la migración. Manychat también está en "Eliminadas" del portfolio.

## Templates

- Se gestionan desde el dashboard de 360dialog (https://hub.360dialog.com → Templates).
- Aprobación de Meta tarda 30 min - 24 hs por template.
- 4 plantillas redactadas pendientes de cargar: `saludo_inicio`, `presupuesto_seguimiento`, `recordatorio_sena`, `pedido_listo`.

## Provider abstraction en el worker

- `getWaClient(env)` en worker.js devuelve un cliente abstracto que apunta a Meta direct o 360dialog según `env.WA_PROVIDER`.
- Default es `'meta'` para back-compat. Actualmente seteado a `'360dialog'` via secret.
- Para rollback emergency: `wrangler secret put WA_PROVIDER` con valor `meta` y redeploy.

## Login del dashboard

- `Gaspar` requiere password (env `ADMIN_PASSWORD` en el worker).
- `Joaquín` (o `Joaquin`) entra sin password — ver `worker.js` `/auth/login`.

## Convenciones

- Fechas en hora local Argentina, no UTC. Helper `localDateKey()` en `app.js`.
- `wa_messages` tabla central (D1). Direction inbound/outbound, dedup por `wamid`.
- `msg_type='status'` con body vacío = mensaje saliente desde WA Business app (placeholder).
