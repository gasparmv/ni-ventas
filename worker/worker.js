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

// ===== Image analysis (Vision via Workers AI) =====
async function analyzeImage(env, r2Key) {
  if (!env.AI || !env.MEDIA || !r2Key) return null;
  try {
    const obj = await env.MEDIA.get(r2Key);
    if (!obj) return null;
    const buf = await obj.arrayBuffer();
    const uint8 = new Uint8Array(buf);
    // Try uform-gen2 (image-to-text, simpler API)
    let result;
    try {
      result = await env.AI.run('@cf/unum/uform-gen2-qwen-500m', {
        image: [...uint8],
        prompt: 'Describí esta imagen en español en 1-2 oraciones cortas. Si tiene texto o palabras, transcibilas exactamente. Si es un diseño, logo o cartel, describí qué muestra.',
        max_tokens: 200
      });
    } catch (e1) {
      // Fallback: llama vision with array format
      try {
        result = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
          image: [...uint8],
          prompt: 'Describe this image in Spanish in 1-2 short sentences.',
          max_tokens: 200
        });
      } catch (e2) {
        console.error('both vision models failed:', e1.message, e2.message);
        return null;
      }
    }
    // Extract text from whatever format the model returns
    if (!result) return null;
    if (typeof result === 'string') return result;
    return result.description || result.response || result.text || result.output || JSON.stringify(result);
  } catch (e) {
    console.error('image analysis error:', e);
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
    // Usar whisper-large-v3-turbo (mejor calidad), fallback a whisper base
    let result;
    try {
      result = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
        audio: [...new Uint8Array(bytes)],
        language: 'es'
      });
    } catch (e1) {
      // Fallback al modelo base con idioma forzado
      result = await env.AI.run('@cf/openai/whisper', {
        audio: [...new Uint8Array(bytes)],
        language: 'es'
      });
    }
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
              // Coexistencia / Echoes: si msg.from coincide con nuestro número
              // de negocio, es un mensaje SALIENTE enviado desde la app/web de
              // WhatsApp Business (no por la Cloud API). Lo guardamos con body.
              const businessPhone = String(value?.metadata?.display_phone_number || '').replace(/\D/g, '');

              // Mensajes (entrantes y salientes vía echoes)
              for (const msg of (value?.messages || [])) {
                const fromNorm = String(msg.from || '').replace(/\D/g, '');
                const isOutboundEcho = businessPhone && fromNorm === businessPhone;
                // En echoes el destinatario viene en msg.to o en contacts[0].wa_id
                const recipient = String(msg.to || contacts[0]?.wa_id || '').replace(/\D/g, '');
                const phone = isOutboundEcho ? recipient : (msg.from || '');
                const direction = isOutboundEcho ? 'outbound' : 'inbound';
                const wamid = msg.id || '';
                const senderName = isOutboundEcho ? '' : (contactMap[phone] || '');
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
                else if (msg.location) { msgBody = `[ubicacion] ${msg.location.latitude},${msg.location.longitude}${msg.location.name ? ' — ' + msg.location.name : ''}${msg.location.address ? ' (' + msg.location.address + ')' : ''}`; }
                else if (msg.contacts && msg.contacts.length) {
                  const cNames = msg.contacts.map(c => c.name?.formatted_name || c.name?.first_name || 'contacto').join(', ');
                  const cPhones = msg.contacts.map(c => c.phones?.[0]?.phone || '').filter(Boolean).join(', ');
                  msgBody = `[contacto] ${cNames}${cPhones ? ' — ' + cPhones : ''}`;
                }
                else if (msg.order) { msgBody = `[pedido] ${(msg.order.product_items || []).map(p => p.product_retailer_id).join(', ')}`; }
                else if (msg.unsupported) {
                  // Meta sends error details for unsupported messages
                  const errTitle = msg.errors?.[0]?.title || '';
                  const errDetails = msg.errors?.[0]?.error_data?.details || '';
                  if (errTitle.includes('unavailable')) msgBody = '[mensaje no disponible]';
                  else if (errTitle.includes('unknown')) msgBody = '[tipo de mensaje no soportado por la API]';
                  else msgBody = `[no soportado: ${errTitle || 'desconocido'}]`;
                }
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
                // Analyze image messages
                if (msgType === 'image' && r2Key && env.AI) {
                  try {
                    const description = await analyzeImage(env, r2Key);
                    if (description) msgBody = (msgBody ? msgBody + ' | ' : '') + '[imagen] ' + description;
                  } catch (imgErr) {
                    try { await env.DB.prepare('INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)').bind(new Date().toISOString(), 'IMG_ERR: ' + (imgErr?.message || String(imgErr))).run(); } catch(_){}
                  }
                }
                try {
                  // Upsert: si ya existe (p.ej. placeholder de status webhook con body vacío),
                  // completamos body/tipo/media. No pisamos status si ya viene 'sent/delivered/read'.
                  await env.DB.prepare(
                    `INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(wamid) DO UPDATE SET
                       direction = excluded.direction,
                       phone = excluded.phone,
                       msg_type = excluded.msg_type,
                       body = excluded.body,
                       media_url = excluded.media_url,
                       context_id = excluded.context_id,
                       ts = excluded.ts
                     WHERE wa_messages.body IS NULL OR wa_messages.body = '' OR wa_messages.msg_type = 'status'`
                  ).bind(ts, wamid, direction, phone, senderName, msgType, msgBody, r2Key || mediaUrl, contextId, null).run();
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
                  // Auto-mark conversation as read when an outbound message is sent
                  // (means someone replied from WA Web/phone)
                  if (status === 'sent' && phone) {
                    try {
                      await env.DB.prepare(
                        'INSERT INTO wa_read_cursor (phone, last_read_ts, updated_at) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET last_read_ts = excluded.last_read_ts, updated_at = excluded.updated_at'
                      ).bind(phone, ts, ts).run();
                    } catch (_) {}
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
      if (!user) return json({ error: 'missing fields' }, 400);
      // Joaquín entra sin contraseña (solo chat); Gaspar necesita password
      const NO_PASSWORD_USERS = ['Joaquín', 'Joaquin'];
      if (NO_PASSWORD_USERS.includes(user)) {
        // ok, sin password
      } else {
        if (!password) return json({ error: 'missing fields' }, 400);
        if (!env.ADMIN_PASSWORD) return json({ error: 'server not configured' }, 500);
        if (user !== 'Gaspar' || password !== env.ADMIN_PASSWORD) {
          await new Promise(r => setTimeout(r, 250));
          return unauthorized('credenciales inválidas');
        }
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
      // Allow token via query param for resources loaded by <img>, <audio>, etc.
      let session = await getSession(env, request);
      if (!session && url.searchParams.get('token')) {
        const qToken = url.searchParams.get('token');
        const row = await env.DB.prepare('SELECT user, expires_at FROM sessions WHERE token = ?').bind(qToken).first();
        if (row && new Date(row.expires_at) >= new Date()) session = { token: qToken, user: row.user };
      }
      if (!session) return unauthorized();

      if (request.method === 'GET' && path === '/admin/activity') {
        return reportHandler(env, url, true);
      }

      if (request.method === 'POST' && path === '/admin/wa/send') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { to, body: text } = body || {};
        if (!to || !text) return json({ error: 'missing fields (to, body)' }, 400);
        const num = normalizeArPhone(to);
        const r = await waSendText(env, to, text);
        await logWaEvent(env, { to, kind: 'text', ref: '', ok: r.ok, messageId: r.id, error: r.error });
        if (!r.ok) return json({ error: r.error, raw: r.raw }, r.status || 500);
        // Guardar en wa_messages para que aparezca en el chat
        try {
          await env.DB.prepare(
            'INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(new Date().toISOString(), r.id || '', 'outbound', num || to, '', 'text', String(text), '', '', 'sent').run();
        } catch (_) {}
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
          `SELECT id, ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status FROM wa_messages WHERE ${where} ORDER BY ts DESC LIMIT ?`
        ).bind(...params, limit).all();
        return json({ messages: rs.results || [] });
      }

      // Read cursors: qué conversaciones fueron leídas y cuándo
      if (request.method === 'GET' && path === '/admin/wa/read-cursors') {
        try {
          const rs = await env.DB.prepare('SELECT phone, last_read_ts FROM wa_read_cursor').all();
          const cursors = {};
          for (const r of (rs.results || [])) cursors[r.phone] = r.last_read_ts;
          return json({ cursors });
        } catch (_) {
          return json({ cursors: {} });
        }
      }

      // Marcar conversación como leída
      if (request.method === 'POST' && path === '/admin/wa/mark-read') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { phone, ts } = body || {};
        if (!phone || !ts) return json({ error: 'missing phone or ts' }, 400);
        try {
          await env.DB.prepare(
            'INSERT INTO wa_read_cursor (phone, last_read_ts, updated_at) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET last_read_ts = excluded.last_read_ts, updated_at = excluded.updated_at'
          ).bind(phone, ts, new Date().toISOString()).run();
        } catch (e) {
          // Table might not exist yet — create it
          try {
            await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_read_cursor (phone TEXT PRIMARY KEY, last_read_ts TEXT NOT NULL, updated_at TEXT NOT NULL)').run();
            await env.DB.prepare(
              'INSERT OR REPLACE INTO wa_read_cursor (phone, last_read_ts, updated_at) VALUES (?, ?, ?)'
            ).bind(phone, ts, new Date().toISOString()).run();
          } catch (_) {}
        }
        return json({ ok: true });
      }

      // ===== Enviar media (foto/audio) por WhatsApp =====
      if (request.method === 'POST' && path === '/admin/wa/send-media') {
        const ct = request.headers.get('Content-Type') || '';
        if (!ct.includes('multipart/form-data')) return json({ error: 'expected multipart/form-data' }, 400);
        const fd = await request.formData();
        const to = fd.get('to');
        const type = fd.get('type'); // image | audio
        const caption = fd.get('caption') || '';
        const file = fd.get('file');
        if (!to || !type || !file) return json({ error: 'missing to, type, or file' }, 400);
        const num = normalizeArPhone(to);
        if (!num) return json({ error: 'numero invalido' }, 400);
        // 1. Upload to R2
        const ext = file.name ? '.' + file.name.split('.').pop() : (type === 'audio' ? '.ogg' : '.jpg');
        const r2Key = `wa/out_${Date.now()}${ext}`;
        const buf = await file.arrayBuffer();
        const mime = file.type || (type === 'audio' ? 'audio/ogg; codecs=opus' : 'image/jpeg');
        await env.MEDIA.put(r2Key, buf, { httpMetadata: { contentType: mime } });
        // 2. Upload media to Meta (get media ID)
        const v = env.WA_API_VERSION || 'v25.0';
        const uploadFd = new FormData();
        uploadFd.append('messaging_product', 'whatsapp');
        uploadFd.append('file', new Blob([buf], { type: mime }), 'file' + ext);
        uploadFd.append('type', mime);
        const uploadR = await fetch(`https://graph.facebook.com/${v}/${env.WA_PHONE_NUMBER_ID}/media`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.WA_TOKEN}` },
          body: uploadFd
        });
        const uploadData = await uploadR.json().catch(() => ({}));
        if (!uploadR.ok || !uploadData.id) {
          return json({ error: 'media upload failed', detail: uploadData?.error?.message || '' }, 500);
        }
        const mediaId = uploadData.id;
        // 3. Send via WA API
        let payload;
        if (type === 'image') {
          payload = { messaging_product: 'whatsapp', to: num, type: 'image', image: { id: mediaId, caption: caption || undefined } };
        } else {
          payload = { messaging_product: 'whatsapp', to: num, type: 'audio', audio: { id: mediaId } };
        }
        const r = await waSend(env, payload);
        await logWaEvent(env, { to: num, kind: type, ref: '', ok: r.ok, messageId: r.id, error: r.error });
        if (!r.ok) return json({ error: r.error }, r.status || 500);
        // 4. Save in wa_messages
        let body = caption || '';
        if (type === 'image') body = body || '[imagen]';
        if (type === 'audio') {
          // Transcribe outbound audio too
          try {
            const transcript = await transcribeAudio(env, r2Key);
            if (transcript) body = '[audio] ' + transcript;
            else body = '[audio]';
          } catch (_) { body = '[audio]'; }
        }
        try {
          await env.DB.prepare(
            'INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(new Date().toISOString(), r.id || '', 'outbound', num, '', type, body, r2Key, '', 'sent').run();
        } catch (_) {}
        return json({ id: r.id, r2Key });
      }

      // ===== Quick Replies CRUD =====
      if (request.method === 'GET' && path === '/admin/quick-replies') {
        try {
          await env.DB.prepare('CREATE TABLE IF NOT EXISTS quick_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, shortcut TEXT NOT NULL UNIQUE, body TEXT NOT NULL, created_at TEXT NOT NULL)').run();
          const rs = await env.DB.prepare('SELECT id, shortcut, body FROM quick_replies ORDER BY shortcut').all();
          return json({ replies: rs.results || [] });
        } catch (e) { return json({ replies: [] }); }
      }
      if (request.method === 'POST' && path === '/admin/quick-replies') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { shortcut, body: text } = body || {};
        if (!shortcut || !text) return json({ error: 'missing shortcut or body' }, 400);
        await env.DB.prepare('CREATE TABLE IF NOT EXISTS quick_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, shortcut TEXT NOT NULL UNIQUE, body TEXT NOT NULL, created_at TEXT NOT NULL)').run();
        await env.DB.prepare('INSERT OR REPLACE INTO quick_replies (shortcut, body, created_at) VALUES (?, ?, ?)').bind(shortcut.toLowerCase().replace(/\s+/g, '_'), text, new Date().toISOString()).run();
        return json({ ok: true });
      }
      if (request.method === 'DELETE' && path.startsWith('/admin/quick-replies/')) {
        const id = path.split('/').pop();
        await env.DB.prepare('DELETE FROM quick_replies WHERE id = ?').bind(id).run();
        return json({ ok: true });
      }

      // ===== Labels CRUD =====
      if (request.method === 'GET' && path === '/admin/labels') {
        try {
          await env.DB.prepare('CREATE TABLE IF NOT EXISTS labels (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL, created_at TEXT NOT NULL)').run();
          await env.DB.prepare('CREATE TABLE IF NOT EXISTS contact_labels (phone TEXT NOT NULL, label_id INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (phone, label_id))').run();
          const rs = await env.DB.prepare('SELECT id, name, color FROM labels ORDER BY name').all();
          return json({ labels: rs.results || [] });
        } catch (e) { return json({ labels: [] }); }
      }
      if (request.method === 'POST' && path === '/admin/labels') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { name, color } = body || {};
        if (!name || !color) return json({ error: 'missing name or color' }, 400);
        await env.DB.prepare('CREATE TABLE IF NOT EXISTS labels (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL, created_at TEXT NOT NULL)').run();
        await env.DB.prepare('INSERT OR REPLACE INTO labels (name, color, created_at) VALUES (?, ?, ?)').bind(name, color, new Date().toISOString()).run();
        const row = await env.DB.prepare('SELECT id FROM labels WHERE name = ?').bind(name).first();
        return json({ ok: true, id: row?.id });
      }
      if (request.method === 'DELETE' && path.startsWith('/admin/labels/')) {
        const id = path.split('/').pop();
        await env.DB.prepare('DELETE FROM contact_labels WHERE label_id = ?').bind(id).run();
        await env.DB.prepare('DELETE FROM labels WHERE id = ?').bind(id).run();
        return json({ ok: true });
      }

      // ===== Contact Labels =====
      if (request.method === 'GET' && path === '/admin/contact-labels') {
        try {
          await env.DB.prepare('CREATE TABLE IF NOT EXISTS contact_labels (phone TEXT NOT NULL, label_id INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (phone, label_id))').run();
          const rs = await env.DB.prepare('SELECT phone, label_id FROM contact_labels').all();
          // Group by phone
          const map = {};
          for (const r of (rs.results || [])) {
            if (!map[r.phone]) map[r.phone] = [];
            map[r.phone].push(r.label_id);
          }
          return json({ contactLabels: map });
        } catch (e) { return json({ contactLabels: {} }); }
      }
      if (request.method === 'POST' && path === '/admin/contact-labels') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { phone, label_id } = body || {};
        if (!phone || !label_id) return json({ error: 'missing phone or label_id' }, 400);
        await env.DB.prepare('CREATE TABLE IF NOT EXISTS contact_labels (phone TEXT NOT NULL, label_id INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (phone, label_id))').run();
        await env.DB.prepare('INSERT OR IGNORE INTO contact_labels (phone, label_id, created_at) VALUES (?, ?, ?)').bind(phone, label_id, new Date().toISOString()).run();
        return json({ ok: true });
      }
      if (request.method === 'DELETE' && path === '/admin/contact-labels') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { phone, label_id } = body || {};
        if (!phone || !label_id) return json({ error: 'missing phone or label_id' }, 400);
        await env.DB.prepare('DELETE FROM contact_labels WHERE phone = ? AND label_id = ?').bind(phone, label_id).run();
        return json({ ok: true });
      }

      // ===== Bulk messaging =====
      if (request.method === 'POST' && path === '/admin/wa/send-bulk') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { label_ids, message, template_name } = body || {};
        if ((!label_ids || !label_ids.length) && !body.phones) return json({ error: 'missing label_ids or phones' }, 400);
        if (!message && !template_name) return json({ error: 'missing message or template_name' }, 400);
        // Get phones for the labels
        let phones = body.phones || [];
        if (label_ids && label_ids.length) {
          const placeholders = label_ids.map(() => '?').join(',');
          const rs = await env.DB.prepare(`SELECT DISTINCT phone FROM contact_labels WHERE label_id IN (${placeholders})`).bind(...label_ids).all();
          phones = (rs.results || []).map(r => r.phone);
        }
        if (!phones.length) return json({ error: 'no contacts found for these labels' }, 400);
        const results = { sent: 0, failed: 0, errors: [] };
        for (const ph of phones) {
          try {
            let r;
            if (template_name) {
              r = await waSendTemplate(env, ph, template_name, 'es', []);
            } else {
              r = await waSendText(env, ph, message);
            }
            if (r.ok) {
              results.sent++;
              try {
                await env.DB.prepare(
                  'INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                ).bind(new Date().toISOString(), r.id || '', 'outbound', ph, '', 'text', message || `[template:${template_name}]`, '', '', 'sent').run();
              } catch (_) {}
            } else {
              results.failed++;
              results.errors.push({ phone: ph, error: r.error });
            }
            await logWaEvent(env, { to: ph, kind: 'bulk', ref: '', ok: r.ok, messageId: r.id, error: r.error });
          } catch (e) {
            results.failed++;
            results.errors.push({ phone: ph, error: e.message });
          }
        }
        return json(results);
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

      // ===== Scheduled Messages CRUD =====
      if (request.method === 'POST' && path === '/admin/wa/schedule') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const items = Array.isArray(body?.messages) ? body.messages : [body];
        const created = [];
        for (const it of items) {
          const { phone, body: text, scheduled_at } = it || {};
          if (!phone || !text || !scheduled_at) { created.push({ error: 'missing phone, body, or scheduled_at' }); continue; }
          const num = normalizeArPhone(phone);
          if (!num) { created.push({ error: 'numero invalido', phone }); continue; }
          const now = new Date().toISOString();
          const rs = await env.DB.prepare(
            'INSERT INTO scheduled_messages (phone, body, scheduled_at, status, created_at) VALUES (?, ?, ?, ?, ?)'
          ).bind(num, text, scheduled_at, 'pending', now).run();
          created.push({ id: rs.meta?.last_row_id, phone: num, scheduled_at });
        }
        return json({ created });
      }

      if (request.method === 'GET' && path === '/admin/wa/schedule') {
        const status = url.searchParams.get('status') || 'pending';
        const rs = await env.DB.prepare(
          'SELECT id, phone, body, scheduled_at, status, created_at, sent_at, error FROM scheduled_messages WHERE status = ? ORDER BY scheduled_at ASC LIMIT 200'
        ).bind(status).all();
        return json({ messages: rs.results || [] });
      }

      if (request.method === 'DELETE' && path.startsWith('/admin/wa/schedule/')) {
        const id = path.split('/').pop();
        await env.DB.prepare('UPDATE scheduled_messages SET status = ? WHERE id = ? AND status = ?').bind('cancelled', id, 'pending').run();
        return json({ ok: true });
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
  // Corre cada 5 min. Procesa: 1) mensajes programados, 2) followups (solo a las 13:00 UTC).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processScheduledMessages(env));
    // Followups de Apps Script solo a las 13:00 UTC (10:00 AR)
    const hour = new Date(event.scheduledTime).getUTCHours();
    if (hour === 13) ctx.waitUntil(runScheduled(env));
    // Follow-up automático de presupuestos del cotizador: solo en horario AR (09-22 AR = 12-01 UTC)
    if (hour >= 12 || hour <= 1) ctx.waitUntil(processPresupuestoFollowups(env));
  }
};

// ===== Scheduled Messages =====
async function processScheduledMessages(env) {
  const now = new Date().toISOString();
  let rows;
  try {
    const rs = await env.DB.prepare(
      "SELECT id, phone, body, scheduled_at FROM scheduled_messages WHERE status = 'pending' AND scheduled_at <= ? ORDER BY scheduled_at ASC LIMIT 50"
    ).bind(now).all();
    rows = rs.results || [];
  } catch (e) {
    // Table might not exist yet
    console.error('scheduled_messages query error:', e);
    return;
  }
  if (!rows.length) return;
  for (const msg of rows) {
    const r = await waSendText(env, msg.phone, msg.body);
    const sentAt = new Date().toISOString();
    if (r.ok) {
      await env.DB.prepare(
        "UPDATE scheduled_messages SET status = 'sent', sent_at = ?, wamid = ? WHERE id = ?"
      ).bind(sentAt, r.id || '', msg.id).run();
      // Save in wa_messages so it shows in chat
      try {
        await env.DB.prepare(
          'INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(sentAt, r.id || '', 'outbound', msg.phone, '', 'text', msg.body, '', '', 'sent').run();
      } catch (_) {}
    } else {
      await env.DB.prepare(
        "UPDATE scheduled_messages SET status = 'failed', error = ? WHERE id = ?"
      ).bind(r.error || 'unknown error', msg.id).run();
    }
    await logWaEvent(env, { to: msg.phone, kind: 'scheduled', ref: `sched:${msg.id}`, ok: r.ok, messageId: r.id, error: r.error });
  }
}

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

// ===== Follow-up automático de presupuestos del cotizador =====
// Detecta presupuestos enviados desde el cotizador (texto que arranca con un prefijo conocido),
// que no fueron respondidos ni recibieron follow-up, y manda un mensaje de insistencia.
// Si algun envio falla y hay ADMIN_NOTIFY_PHONE configurado, manda un WA al admin con el resumen.
const PRESUPUESTO_PREFIX_TEXT = 'Te comparto la información detallada!';
const FOLLOWUP_PRESUPUESTO_TEXT = 'Aca te dejamos el presupuesto! Decinos que te parece? si hay algun cambio o ajuste que quieras hacer, tambien si tenes foto de donde lo vas a poner te podemos hacer un montaje digital de como quedaría!';
const FOLLOWUP_PRESUPUESTO_PREFIX_TEXT = 'Aca te dejamos el presupuesto!';

async function processPresupuestoFollowups(env) {
  const now = Date.now();
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  // 1) Presupuestos del cotizador en las últimas 24h, enviados hace al menos 1h
  let rows;
  try {
    const rs = await env.DB.prepare(
      "SELECT phone, ts, body, sender_name FROM wa_messages WHERE direction = 'outbound' AND body LIKE ? AND ts >= ? AND ts <= ? ORDER BY ts DESC"
    ).bind(PRESUPUESTO_PREFIX_TEXT + '%', oneDayAgo, oneHourAgo).all();
    rows = rs.results || [];
  } catch (e) {
    await logWaEvent(env, { to: '', kind: 'cron-pp-followup', ref: '', ok: false, error: 'query: ' + e.message });
    return;
  }
  if (!rows.length) return;

  // 2) Latest presupuesto por teléfono
  const byPhone = new Map();
  for (const r of rows) {
    const ex = byPhone.get(r.phone);
    if (!ex || new Date(r.ts) > new Date(ex.ts)) byPhone.set(r.phone, r);
  }

  const failures = [];
  let sent = 0;

  for (const p of byPhone.values()) {
    // 3) Conversación posterior al presupuesto
    let conv;
    try {
      const rs = await env.DB.prepare(
        'SELECT direction, body FROM wa_messages WHERE phone = ? AND ts > ? LIMIT 200'
      ).bind(p.phone, p.ts).all();
      conv = rs.results || [];
    } catch (_) { continue; }

    // ¿Respondió?
    if (conv.some(m => m.direction === 'inbound')) continue;
    // ¿Ya tiene follow-up?
    if (conv.some(m => m.direction === 'outbound' && (m.body || '').startsWith(FOLLOWUP_PRESUPUESTO_PREFIX_TEXT))) continue;

    // 4) Enviar
    const r = await waSendText(env, p.phone, FOLLOWUP_PRESUPUESTO_TEXT);
    const ts = new Date().toISOString();
    if (r.ok) {
      sent++;
      try {
        await env.DB.prepare(
          'INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(ts, r.id || '', 'outbound', p.phone, '', 'text', FOLLOWUP_PRESUPUESTO_TEXT, '', '', 'sent').run();
      } catch (_) {}
    } else {
      failures.push({ phone: p.phone, name: p.sender_name || '', error: r.error || 'unknown' });
    }
    await logWaEvent(env, { to: p.phone, kind: 'pp-followup', ref: 'pp-fu:' + p.phone, ok: r.ok, messageId: r.id, error: r.error });
    await new Promise(rs => setTimeout(rs, 600)); // delay anti rate-limit
  }

  // 5) Si fallaron envíos y hay número de admin configurado, mandar resumen
  if (failures.length && env.ADMIN_NOTIFY_PHONE) {
    const lines = failures.slice(0, 10).map(f => `• ${f.name || f.phone} (${f.phone}): ${f.error}`).join('\n');
    const more = failures.length > 10 ? `\n…y ${failures.length - 10} más` : '';
    const summary = `⚠ Follow-ups de presupuesto fallidos (${failures.length}):\n${lines}${more}\n\nProbablemente fuera de la ventana de 24h del cliente.`;
    try { await waSendText(env, env.ADMIN_NOTIFY_PHONE, summary); } catch (_) {}
  }

  if (sent > 0 || failures.length > 0) {
    await logWaEvent(env, { to: '', kind: 'cron-pp-summary', ref: '', ok: true, error: `sent=${sent} failed=${failures.length}` });
  }
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
