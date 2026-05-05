// NI Ventas · tracking + auth worker
//
// Endpoints públicos:
//   POST /event              { user, action, itemId, itemKind, undo? }   → 204
//   GET  /report?user=&from=&to=                                         → { rows }
//   GET  /health
//
// Webhook WhatsApp:
//   GET  /webhook             verificación de Meta (hub.verify_token)
//   POST /webhook             recibe mensajes entrantes + status updates → guarda en wa_messages
//
// Auth:
//   POST /auth/login         { user, password }                          → { token }
//   POST /auth/logout                                                    → 204 (con Bearer)
//   GET  /auth/me                                                        → { user } (con Bearer)
//
// Endpoints privados (requieren Bearer token de admin):
//   GET  /admin/activity?user=&from=&to=                                 → { rows } (igual a /report pero gated)
//   GET  /admin/wa/messages?phone=&from=&to=&direction=&limit=           → { messages }
//   POST /admin/wa/send      { to, body }                                → { id } (texto libre, ventana 24h)
//   POST /admin/wa/template  { to, name, lang?, params?: [] }            → { id } (plantilla aprobada)
//   POST /admin/wa/followups { items: [{to, name, milestone, pedidoId}] } → { sent, skipped, errors }
//
// Cron Trigger (diario 13:00 UTC / 10:00 AR):
//   Apps Script publica los seguimientos pendientes; el worker los manda por WhatsApp.
//
// Secrets:
//   ADMIN_PASSWORD                  setear con `wrangler secret put ADMIN_PASSWORD`
//   WA_TOKEN                        token permanente de WhatsApp Cloud API (System User)
//   APPS_SCRIPT_FOLLOWUPS_URL       endpoint de Apps Script que devuelve seguimientos pendientes
//
// Vars (en wrangler.toml):
//   WA_PHONE_NUMBER_ID              919964037861500 (Neon Infinito +54 9 11 4436-6573)
//   WA_API_VERSION                  v25.0

const ALLOWED_ORIGINS = '*';
const SESSION_DAYS = 30;
const WA_VERIFY_TOKEN = 'neon-infinito-webhook-2026';

function cors(headers = {}) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    ...headers
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: cors({ 'Content-Type': 'application/json' }) });
}
function noContent() {
  return new Response(null, { status: 204, headers: cors() });
}
function unauthorized(msg = 'unauthorized') { return json({ error: msg }, 401); }

function randomToken() {
  // 32 bytes hex
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ===== WhatsApp Cloud API =====
function normalizeArPhone(raw) {
  // Acepta varios formatos y devuelve E.164 sin "+" para Argentina mobile (549...)
  let n = String(raw || '').replace(/\D/g, '');
  if (!n) return null;
  if (n.startsWith('00')) n = n.slice(2);
  if (n.startsWith('54')) {
    // ya tiene country code; asegurarse del 9 mobile
    if (!n.startsWith('549')) n = '549' + n.slice(2);
    return n;
  }
  if (n.startsWith('15')) n = n.slice(2);   // 15-prefijo viejo
  if (n.startsWith('0'))  n = n.slice(1);    // 0 inicial
  return '549' + n;
}

async function waSend(env, payload) {
  if (!env.WA_TOKEN || !env.WA_PHONE_NUMBER_ID) {
    return { ok: false, status: 500, error: 'WhatsApp no configurado (faltan WA_TOKEN o WA_PHONE_NUMBER_ID)' };
  }
  const v = env.WA_API_VERSION || 'v25.0';
  const url = `https://graph.facebook.com/${v}/${env.WA_PHONE_NUMBER_ID}/messages`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, error: data?.error?.message || 'wa send failed', raw: data };
  const id = data?.messages?.[0]?.id || null;
  return { ok: true, id, raw: data };
}

async function waSendText(env, to, body) {
  const num = normalizeArPhone(to);
  if (!num) return { ok: false, status: 400, error: 'numero invalido' };
  return waSend(env, { messaging_product: 'whatsapp', to: num, type: 'text', text: { body: String(body || '') } });
}

async function waSendTemplate(env, to, name, lang = 'es', params = []) {
  const num = normalizeArPhone(to);
  if (!num) return { ok: false, status: 400, error: 'numero invalido' };
  const components = params && params.length
    ? [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: String(p) })) }]
    : [];
  return waSend(env, {
    messaging_product: 'whatsapp',
    to: num,
    type: 'template',
    template: { name, language: { code: lang }, components }
  });
}

// ===== Media download (Meta → R2) =====
async function downloadMedia(env, mediaId) {
  if (!env.WA_TOKEN || !mediaId || !env.MEDIA) return null;
  const v = env.WA_API_VERSION || 'v25.0';
  try {
    // Step 1: get media URL from Meta
    const meta = await fetch(`https://graph.facebook.com/${v}/${mediaId}`, {
      headers: { 'Authorization': `Bearer ${env.WA_TOKEN}` }
    });
    const info = await meta.json();
    if (!info.url) return null;
    const mime = info.mime_type || 'application/octet-stream';
    const ext = mime.includes('jpeg') || mime.includes('jpg') ? '.jpg'
      : mime.includes('png') ? '.png'
      : mime.includes('webp') ? '.webp'
      : mime.includes('mp4') ? '.mp4'
      : mime.includes('ogg') ? '.ogg'
      : mime.includes('opus') ? '.opus'
      : mime.includes('pdf') ? '.pdf'
      : mime.includes('mp3') || mime.includes('mpeg') ? '.mp3'
      : '';
    // Step 2: download actual file
    const file = await fetch(info.url, {
      headers: { 'Authorization': `Bearer ${env.WA_TOKEN}` }
    });
    if (!file.ok) return null;
    const blob = await file.arrayBuffer();
    // Step 3: store in R2
    const key = `wa/${mediaId}${ext}`;
    await env.MEDIA.put(key, blob, { httpMetadata: { contentType: mime } });
    return { key, mime, size: blob.byteLength };
  } catch (e) {
    console.error('media download error:', e);
    return null;
  }
}

// ===== Audio transcription (Whisper via Workers AI) =====
async function transcribeAudio(env, r2Key) {
  if (!env.AI || !env.MEDIA || !r2Key) return null;
  try {
    const obj = await env.MEDIA.get(r2Key);
    if (!obj) return null;
    const bytes = await obj.arrayBuffer();
    const result = await env.AI.run('@cf/openai/whisper', { audio: [...new Uint8Array(bytes)] });
    return result?.text || null;
  } catch (e) {
    console.error('transcription error:', e);
    return null;
  }
}

async function logWaEvent(env, { to, kind, ref, ok, messageId, error }) {
  try {
    await env.DB.prepare(
      'INSERT INTO wa_log (ts, to_number, kind, ref, ok, message_id, error) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(new Date().toISOString(), to || '', kind || '', ref || '', ok ? 1 : 0, messageId || '', error || '').run();
  } catch (_) { /* tabla puede no existir aun en primera deploy */ }
}

async function getSession(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  const row = await env.DB.prepare(
    'SELECT user, expires_at FROM sessions WHERE token = ?'
  ).bind(token).first();
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return { token, user: row.user };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    const url = new URL(request.url);
    const path = url.pathname;

    // ----- Health -----
    if (request.method === 'GET' && path === '/health') return json({ ok: true });

    // ----- WhatsApp Webhook (verificación + recepción de mensajes) -----
    if (request.method === 'GET' && path === '/webhook') {
      // Verificación del webhook: Meta envía hub.mode, hub.verify_token, hub.challenge
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && (token === WA_VERIFY_TOKEN || token === env.WA_VERIFY_TOKEN) && challenge) {
        return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      // For override_callback_uri verification, Meta may send without our token
      if (mode === 'subscribe' && challenge) {
        return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      return new Response('Forbidden', { status: 403 });
    }

    if (request.method === 'POST' && path === '/webhook') {
      // Meta envía notificaciones de mensajes entrantes y status updates
      let body;
      try { body = await request.json(); } catch { return json({ ok: true }); }
      // Log raw payload for debugging (temporary)
      try {
        await env.DB.prepare('INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)').bind(new Date().toISOString(), JSON.stringify(body).slice(0, 4000)).run();
      } catch (_) {}
      // Siempre responder 200 rápido para que Meta no reintente
      const processWebhook = async () => {
        try {
          const entries = body?.entry || [];
          for (const entry of entries) {
            const changes = entry?.changes || [];
            for (const change of changes) {
              if (change?.field !== 'messages') continue;
              const value = change?.value || {};
              const contacts = value?.contacts || [];
              const contactMap = {};
              for (const c of contacts) contactMap[c.wa_id] = c.profile?.name || '';

              // Mensajes entrantes
              for (const msg of (value?.messages || [])) {
                const phone = msg.from || '';
                const wamid = msg.id || '';
                const senderName = contactMap[phone] || '';
                const msgType = msg.type || 'unknown';
                let msgBody = '';
                let mediaUrl = '';
                if (msg.text) msgBody = msg.text.body || '';
                else if (msg.button) msgBody = msg.button.text || msg.button.payload || '';
                else if (msg.interactive) msgBody = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
                else if (msg.image) { msgBody = msg.image.caption || ''; mediaUrl = msg.image.id || ''; }
                else if (msg.video) { msgBody = msg.video.caption || ''; mediaUrl = msg.video.id || ''; }
                else if (msg.audio) { mediaUrl = msg.audio.id || ''; }
                else if (msg.document) { msgBody = msg.document.filename || ''; mediaUrl = msg.document.id || ''; }
                else if (msg.sticker) { mediaUrl = msg.sticker.id || ''; }
                else if (msg.reaction) { msgBody = msg.reaction.emoji || ''; }
                const contextId = msg.context?.id || '';
                const ts = msg.timestamp ? new Date(parseInt(msg.timestamp) * 1000).toISOString() : new Date().toISOString();
                // Download media to R2 if present
                let r2Key = '';
                if (mediaUrl && env.MEDIA) {
                  try {
                    const dl = await downloadMedia(env, mediaUrl);
                    if (dl) r2Key = dl.key;
                  } catch (_) {}
                }
                // Transcribe audio messages
                if (msgType === 'audio' && r2Key && env.AI) {
                  try {
                    const transcript = await transcribeAudio(env, r2Key);
                    if (transcript) msgBody = '[audio] ' + transcript;
                  } catch (_) {}
                }
                try {
                  await env.DB.prepare(
                    'INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                  ).bind(ts, wamid, 'inbound', phone, senderName, msgType, msgBody, r2Key || mediaUrl, contextId, null).run();
                } catch (_) {}
              }

              // Status updates (sent, delivered, read) para mensajes salientes
              for (const st of (value?.statuses || [])) {
                const wamid = st.id || '';
                const status = st.status || ''; // sent | delivered | read | failed
                const phone = st.recipient_id || '';
                const ts = st.timestamp ? new Date(parseInt(st.timestamp) * 1000).toISOString() : new Date().toISOString();
                if (!wamid) continue;
                try {
                  // Intentar actualizar status de un mensaje saliente existente
                  const updated = await env.DB.prepare(
                    'UPDATE wa_messages SET status = ? WHERE wamid = ?'
                  ).bind(status, wamid).run();
                  // Si no existe (mensaje enviado antes del webhook), insertar
                  if (!updated?.meta?.changes) {
                    await env.DB.prepare(
                      'INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                    ).bind(ts, wamid, 'outbound', phone, '', 'status', '', '', '', status).run();
                  }
                } catch (_) {}
              }
            }
          }
        } catch (e) { console.error('webhook processing error:', e); }
      };
      // Procesar en background, responder inmediato
      if (typeof ctx !== 'undefined') ctx.waitUntil(processWebhook());
      else await processWebhook();
      return json({ ok: true });
    }

    // ----- Tracking público -----
    if (request.method === 'POST' && path === '/event') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const { user, action, itemId, itemKind, undo } = body || {};
      if (!user || !action || !itemId) return json({ error: 'missing fields' }, 400);
      const ts = new Date().toISOString();
      await env.DB.prepare(
        'INSERT INTO events (user, action, item_id, item_kind, undo, ts) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(user, action, itemId, itemKind || '', undo ? 1 : 0, ts).run();
      return noContent();
    }

    // ----- Done marks (persistente, reemplaza localStorage) -----
    if (request.method === 'GET' && path === '/done') {
      const user = url.searchParams.get('user');
      if (!user) return json({ error: 'missing user' }, 400);
      const rs = await env.DB.prepare('SELECT item_id, ts FROM done_marks WHERE user = ?').bind(user).all();
      const marks = {};
      for (const r of (rs.results || [])) marks[r.item_id] = r.ts;
      return json({ marks });
    }

    if (request.method === 'POST' && path === '/done') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const { user, itemId } = body || {};
      if (!user || !itemId) return json({ error: 'missing fields' }, 400);
      const ts = new Date().toISOString();
      await env.DB.prepare(
        'INSERT OR REPLACE INTO done_marks (user, item_id, ts) VALUES (?, ?, ?)'
      ).bind(user, itemId, ts).run();
      return json({ ts });
    }

    if (request.method === 'DELETE' && path === '/done') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const { user, itemId } = body || {};
      if (!user || !itemId) return json({ error: 'missing fields' }, 400);
      await env.DB.prepare('DELETE FROM done_marks WHERE user = ? AND item_id = ?').bind(user, itemId).run();
      return noContent();
    }

    // ----- Auth -----
    if (request.method === 'POST' && path === '/auth/login') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const { user, password } = body || {};
      if (!user || !password) return json({ error: 'missing fields' }, 400);
      if (!env.ADMIN_PASSWORD) return json({ error: 'server not configured' }, 500);
      // Solo el admin (Gaspar) tiene contraseña; cualquier otro user devuelve 401
      if (user !== 'Gaspar' || password !== env.ADMIN_PASSWORD) {
        // pequeño delay para no facilitar timing attacks
        await new Promise(r => setTimeout(r, 250));
        return unauthorized('credenciales inválidas');
      }
      const token = randomToken();
      const now = new Date();
      const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
      await env.DB.prepare(
        'INSERT INTO sessions (token, user, expires_at, created_at) VALUES (?, ?, ?, ?)'
      ).bind(token, user, expires.toISOString(), now.toISOString()).run();
      return json({ token, user, expiresAt: expires.toISOString() });
    }

    if (request.method === 'POST' && path === '/auth/logout') {
      const session = await getSession(env, request);
      if (session) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(session.token).run();
      return noContent();
    }

    if (request.method === 'GET' && path === '/auth/me') {
      const session = await getSession(env, request);
      if (!session) return unauthorized();
      return json({ user: session.user });
    }

    // ----- Reportes (público para tracking básico) -----
    if (request.method === 'GET' && path === '/report') {
      return reportHandler(env, url, false);
    }

    // ----- Cotizador params (público lectura) -----
    if (request.method === 'GET' && path === '/cotizador/params') {
      const rs = await env.DB.prepare('SELECT key, value FROM cotizador_params').all();
      const params = {};
      for (const r of (rs.results || [])) params[r.key] = r.value;
      return json({ params });
    }

    // ----- Admin (requiere Bearer) -----
    if (path.startsWith('/admin/')) {
      const session = await getSession(env, request);
      if (!session) return unauthorized();

      if (request.method === 'GET' && path === '/admin/activity') {
        return reportHandler(env, url, true);
      }

      if (request.method === 'POST' && path === '/admin/wa/send') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { to, body: text } = body || {};
        if (!to || !text) return json({ error: 'missing fields (to, body)' }, 400);
        const r = await waSendText(env, to, text);
        await logWaEvent(env, { to, kind: 'text', ref: '', ok: r.ok, messageId: r.id, error: r.error });
        if (!r.ok) return json({ error: r.error, raw: r.raw }, r.status || 500);
        return json({ id: r.id });
      }

      if (request.method === 'POST' && path === '/admin/wa/template') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { to, name, lang, params } = body || {};
        if (!to || !name) return json({ error: 'missing fields (to, name)' }, 400);
        const r = await waSendTemplate(env, to, name, lang || 'es', Array.isArray(params) ? params : []);
        await logWaEvent(env, { to, kind: 'template:' + name, ref: '', ok: r.ok, messageId: r.id, error: r.error });
        if (!r.ok) return json({ error: r.error, raw: r.raw }, r.status || 500);
        return json({ id: r.id });
      }

      if (request.method === 'POST' && path === '/admin/wa/followups') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const items = Array.isArray(body?.items) ? body.items : null;
        if (!items) return json({ error: 'missing items[]' }, 400);
        const result = await runFollowups(env, items);
        return json(result);
      }

      // Consultar mensajes de WhatsApp guardados (para análisis)
      if (request.method === 'GET' && path === '/admin/wa/messages') {
        const phone = url.searchParams.get('phone') || '';
        const from = url.searchParams.get('from') || '';
        const to = url.searchParams.get('to') || '';
        const dir = url.searchParams.get('direction') || '';
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '500'), 5000);
        let where = '1=1';
        const params = [];
        if (phone) { where += ' AND phone = ?'; params.push(phone); }
        if (from) { where += ' AND ts >= ?'; params.push(from); }
        if (to) { where += ' AND ts <= ?'; params.push(to); }
        if (dir === 'inbound' || dir === 'outbound') { where += ' AND direction = ?'; params.push(dir); }
        const rs = await env.DB.prepare(
          `SELECT id, ts, wamid, direction, phone, sender_name, msg_type, body, context_id, status FROM wa_messages WHERE ${where} ORDER BY ts DESC LIMIT ?`
        ).bind(...params, limit).all();
        return json({ messages: rs.results || [] });
      }

      // Servir medios desde R2
      if (request.method === 'GET' && path.startsWith('/admin/media/')) {
        const key = decodeURIComponent(path.slice('/admin/media/'.length));
        if (!env.MEDIA) return json({ error: 'R2 not configured' }, 500);
        const obj = await env.MEDIA.get(key);
        if (!obj) return json({ error: 'not found' }, 404);
        return new Response(obj.body, {
          headers: {
            ...cors(),
            'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
            'Cache-Control': 'public, max-age=86400'
          }
        });
      }

      if (request.method === 'PUT' && path === '/admin/cotizador/params') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const params = body && body.params;
        if (!params || typeof params !== 'object') return json({ error: 'missing params' }, 400);
        const now = new Date().toISOString();
        const stmts = [];
        for (const [k, v] of Object.entries(params)) {
          if (typeof v !== 'number' || isNaN(v)) continue;
          stmts.push(env.DB.prepare(
            'INSERT INTO cotizador_params (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
          ).bind(k, v, now));
        }
        if (stmts.length) await env.DB.batch(stmts);
        return noContent();
      }

      return json({ error: 'not found' }, 404);
    }

    return json({ error: 'not found' }, 404);
  },

  // ===== Cron Trigger =====
  // Se dispara segun wrangler.toml [triggers].crons. Ej: "0 13 * * *" = diario 13:00 UTC.
  // Pide a Apps Script la lista de seguimientos pendientes de hoy y los manda por WhatsApp.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  }
};

// ===== Followups =====
// Recibe items: [{ to, name, milestone: 'D30'|'D60'|'D90'|'PPTO', pedidoId?, message? }]
// Si milestone es D30/D60/D90 o PPTO y no hay message, usa la plantilla preconfigurada.
const FOLLOWUP_TEMPLATES = {
  // Reemplazar por nombres de plantillas UTILITY aprobadas en Meta cuando esten listas.
  // Por ahora usa la plantilla aprobada generica para validar el flujo.
  D30:  { name: 'prueba_de_plantilla', lang: 'es' },
  D60:  { name: 'prueba_de_plantilla', lang: 'es' },
  D90:  { name: 'prueba_de_plantilla', lang: 'es' },
  PPTO: { name: 'prueba_de_plantilla', lang: 'es' }
};

async function runFollowups(env, items) {
  const sent = [], skipped = [], errors = [];
  for (const it of items) {
    const to = it?.to;
    const name = it?.name || 'cliente';
    const milestone = it?.milestone || '';
    const ref = it?.pedidoId ? `${milestone}:${it.pedidoId}` : milestone;
    if (!to) { skipped.push({ ref, reason: 'sin telefono' }); continue; }
    if (!normalizeArPhone(to)) { skipped.push({ ref, reason: 'telefono invalido' }); continue; }

    // Idempotencia: si ya se envio hoy un followup con el mismo ref, saltar.
    const today = new Date().toISOString().slice(0, 10);
    try {
      const existing = await env.DB.prepare(
        "SELECT 1 FROM wa_log WHERE ref = ? AND ok = 1 AND substr(ts, 1, 10) = ? LIMIT 1"
      ).bind(ref, today).first();
      if (existing) { skipped.push({ ref, reason: 'ya enviado hoy' }); continue; }
    } catch (_) {}

    let r;
    if (it.message) {
      // texto libre (solo funciona dentro de ventana 24h)
      r = await waSendText(env, to, it.message);
    } else {
      const tpl = FOLLOWUP_TEMPLATES[milestone] || FOLLOWUP_TEMPLATES.PPTO;
      r = await waSendTemplate(env, to, tpl.name, tpl.lang, [name]);
    }
    await logWaEvent(env, { to, kind: 'followup:' + milestone, ref, ok: r.ok, messageId: r.id, error: r.error });
    if (r.ok) sent.push({ ref, id: r.id });
    else errors.push({ ref, error: r.error });
  }
  return { sent: sent.length, skipped: skipped.length, errors: errors.length, detail: { sent, skipped, errors } };
}

async function runScheduled(env) {
  const url = env.APPS_SCRIPT_FOLLOWUPS_URL;
  if (!url) {
    await logWaEvent(env, { to: '', kind: 'cron', ref: '', ok: false, error: 'APPS_SCRIPT_FOLLOWUPS_URL no configurado' });
    return;
  }
  let items;
  try {
    const r = await fetch(url, { method: 'GET' });
    const j = await r.json();
    items = Array.isArray(j?.items) ? j.items : [];
  } catch (e) {
    await logWaEvent(env, { to: '', kind: 'cron', ref: '', ok: false, error: 'fetch apps script: ' + e.message });
    return;
  }
  if (!items.length) {
    await logWaEvent(env, { to: '', kind: 'cron', ref: '', ok: true, error: '0 followups pendientes' });
    return;
  }
  const result = await runFollowups(env, items);
  await logWaEvent(env, {
    to: '', kind: 'cron-summary', ref: '',
    ok: true, error: `sent=${result.sent} skipped=${result.skipped} errors=${result.errors}`
  });
}

async function reportHandler(env, url, _admin) {
  const userFilter = url.searchParams.get('user') || '';
  const from = url.searchParams.get('from') || '';
  const to   = url.searchParams.get('to')   || '';
  let where = 'undo = 0';
  const params = [];
  if (userFilter) { where += ' AND user = ?'; params.push(userFilter); }
  if (from)       { where += ' AND ts >= ?'; params.push(from); }
  if (to)         { where += ' AND ts <= ?'; params.push(to); }
  const rs = await env.DB.prepare(
    `SELECT user, item_kind, action, ts FROM events WHERE ${where} ORDER BY ts DESC LIMIT 5000`
  ).bind(...params).all();
  return json({ rows: rs.results || [] });
}
