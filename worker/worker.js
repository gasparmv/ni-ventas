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
  } else {
    if (n.startsWith('15')) n = n.slice(2);   // 15-prefijo viejo
    if (n.startsWith('0'))  n = n.slice(1);    // 0 inicial
    n = '549' + n;
  }
  // Validar largo: AR mobile = 549 + área (2-4) + número (6-8) → entre 11 y 14 dígitos.
  // Sin esto, "333" pasaba a "549333" y Meta aceptaba el send retornando 200, dando
  // falsa sensación de envío exitoso.
  if (n.length < 11 || n.length > 14) return null;
  return n;
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
    const audioArr = [...new Uint8Array(bytes)];
    // Prompt contextual: ayuda al modelo a reconocer terminología específica
    // (carteles de neón, jerga rioplatense, productos, medidas, etc.) que
    // mejora notablemente la calidad de transcripción para Neon Infinito.
    const initialPrompt = 'Conversación en español rioplatense argentino sobre carteles de neón LED, presupuestos, medidas en centímetros, m², colores, pedidos, envíos, pagos, controladores, fuentes, transparente, negro, base, neón, dimmer, instalación, cliente.';
    let result;
    try {
      result = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
        audio: audioArr,
        language: 'es',
        task: 'transcribe',
        vad_filter: true,
        initial_prompt: initialPrompt
      });
    } catch (e1) {
      // Fallback al modelo base si el turbo falla
      try {
        result = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
          audio: audioArr,
          language: 'es'
        });
      } catch (e2) {
        result = await env.AI.run('@cf/openai/whisper', {
          audio: audioArr,
          language: 'es'
        });
      }
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

                // Auto-labeling: deshabilitado por pedido del usuario (el matching
                // por keywords genera demasiados falsos positivos). El código
                // queda en applyAutoLabels() por si se quiere reactivar.
              }

              // Status updates (sent, delivered, read) para mensajes salientes
              for (const st of (value?.statuses || [])) {
                const wamid = st.id || '';
                const status = st.status || ''; // sent | delivered | read | failed
                const phone = st.recipient_id || '';
                const ts = st.timestamp ? new Date(parseInt(st.timestamp) * 1000).toISOString() : new Date().toISOString();
                if (!wamid) continue;
                try {
                  // Leer status previo antes de actualizar — para no notificar dos veces el mismo failed
                  let prevStatus = null;
                  let prevBody = '';
                  try {
                    const row = await env.DB.prepare('SELECT status, body FROM wa_messages WHERE wamid = ?').bind(wamid).first();
                    prevStatus = row?.status || null;
                    prevBody = row?.body || '';
                  } catch (_) {}
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
                  // Notificar al admin si el envío FALLA (primera vez que llega como failed)
                  if (status === 'failed' && prevStatus !== 'failed' && env.ADMIN_NOTIFY_PHONE) {
                    const errs = Array.isArray(st.errors) ? st.errors : [];
                    const errMsg = errs.length
                      ? (errs[0].title || 'error') + (errs[0].message ? ': ' + errs[0].message : '')
                      : 'sin detalle';
                    const preview = prevBody ? prevBody.slice(0, 100) + (prevBody.length > 100 ? '…' : '') : '';
                    const summary = `⚠ Falló envío WA a ${phone}\nError: ${errMsg}` + (preview ? `\nMensaje: "${preview}"` : '');
                    try { await waSendText(env, env.ADMIN_NOTIFY_PHONE, summary); } catch (_) {}
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
        let type = fd.get('type'); // image | audio | document | video (default detectado del mime)
        const caption = fd.get('caption') || '';
        const file = fd.get('file');
        if (!to || !file) return json({ error: 'missing to or file' }, 400);
        const num = normalizeArPhone(to);
        if (!num) return json({ error: 'numero invalido' }, 400);
        const fileMime = file.type || '';
        // Auto-detect type si no vino especificado o si vino "auto"
        if (!type || type === 'auto') {
          if (fileMime.startsWith('image/')) type = 'image';
          else if (fileMime.startsWith('audio/')) type = 'audio';
          else if (fileMime.startsWith('video/')) type = 'video';
          else type = 'document';
        }
        // 1. Upload to R2
        const fileName = file.name || ('file_' + Date.now());
        const ext = fileName.includes('.') ? '.' + fileName.split('.').pop() : '';
        const r2Key = `wa/out_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`;
        const buf = await file.arrayBuffer();
        const defaultMime = type === 'audio' ? 'audio/ogg; codecs=opus'
                          : type === 'image' ? 'image/jpeg'
                          : type === 'video' ? 'video/mp4'
                          : 'application/octet-stream';
        const mime = fileMime || defaultMime;
        await env.MEDIA.put(r2Key, buf, { httpMetadata: { contentType: mime } });
        // 2. Upload media to Meta (get media ID)
        const v = env.WA_API_VERSION || 'v25.0';
        const uploadFd = new FormData();
        uploadFd.append('messaging_product', 'whatsapp');
        uploadFd.append('file', new Blob([buf], { type: mime }), fileName);
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
        } else if (type === 'audio') {
          payload = { messaging_product: 'whatsapp', to: num, type: 'audio', audio: { id: mediaId } };
        } else if (type === 'video') {
          payload = { messaging_product: 'whatsapp', to: num, type: 'video', video: { id: mediaId, caption: caption || undefined } };
        } else { // document
          payload = { messaging_product: 'whatsapp', to: num, type: 'document', document: { id: mediaId, caption: caption || undefined, filename: fileName } };
        }
        const r = await waSend(env, payload);
        await logWaEvent(env, { to: num, kind: type, ref: '', ok: r.ok, messageId: r.id, error: r.error });
        if (!r.ok) return json({ error: r.error }, r.status || 500);
        // 4. Save in wa_messages
        let body = caption || '';
        if (type === 'image') body = body || '[imagen]';
        else if (type === 'video') body = body || '[video]';
        else if (type === 'document') body = body || ('[documento] ' + fileName);
        else if (type === 'audio') {
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
        return json({ id: r.id, r2Key, type });
      }

      // ===== Forward (reenviar) un mensaje a uno o varios contactos =====
      // body: { wamid: "...", to_phones: ["549...", "549..."] }
      if (request.method === 'POST' && path === '/admin/wa/forward') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { wamid, to_phones } = body || {};
        if (!wamid || !Array.isArray(to_phones) || !to_phones.length) return json({ error: 'missing wamid or to_phones' }, 400);
        const original = await env.DB.prepare(
          'SELECT msg_type, body, media_url FROM wa_messages WHERE wamid = ? LIMIT 1'
        ).bind(wamid).first();
        if (!original) return json({ error: 'mensaje original no encontrado' }, 404);
        const results = { sent: 0, failed: 0, errors: [] };
        // Helper: subir un blob existente en R2 a Meta y devolver media id
        const uploadFromR2ToMeta = async (r2Key) => {
          const obj = await env.MEDIA.get(r2Key);
          if (!obj) return null;
          const buf = await obj.arrayBuffer();
          const mime = obj.httpMetadata?.contentType || 'application/octet-stream';
          const fileName = r2Key.split('/').pop() || 'file';
          const v = env.WA_API_VERSION || 'v25.0';
          const fd = new FormData();
          fd.append('messaging_product', 'whatsapp');
          fd.append('file', new Blob([buf], { type: mime }), fileName);
          fd.append('type', mime);
          const upR = await fetch(`https://graph.facebook.com/${v}/${env.WA_PHONE_NUMBER_ID}/media`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${env.WA_TOKEN}` },
            body: fd
          });
          const upJ = await upR.json().catch(() => ({}));
          return upR.ok && upJ.id ? { id: upJ.id, mime, fileName } : null;
        };
        // Sub-helper para limpiar el body cuando es 'image' con descripción inyectada
        const cleanBody = (bd, type) => {
          if (!bd) return '';
          if (type === 'audio' && bd.startsWith('[audio] ')) return ''; // la transcripción no se reenvía
          if (type === 'image') {
            const idx = bd.indexOf('[imagen]');
            if (idx >= 0) return bd.slice(0, idx).trim();
          }
          if (type === 'video') {
            const idx = bd.indexOf('[video]');
            if (idx >= 0) return bd.slice(0, idx).trim();
          }
          if (type === 'document') {
            const idx = bd.indexOf('[documento]');
            if (idx >= 0) return bd.slice(0, idx).trim();
          }
          return bd;
        };
        for (const rawPhone of to_phones) {
          const num = normalizeArPhone(rawPhone);
          if (!num) { results.failed++; results.errors.push({ phone: rawPhone, error: 'numero invalido' }); continue; }
          try {
            let res;
            if (original.msg_type === 'text' || !original.media_url) {
              res = await waSendText(env, num, original.body || '');
            } else {
              const up = await uploadFromR2ToMeta(original.media_url);
              if (!up) { results.failed++; results.errors.push({ phone: num, error: 'no se pudo subir media a Meta' }); continue; }
              const v = env.WA_API_VERSION || 'v25.0';
              const caption = cleanBody(original.body, original.msg_type);
              let payload;
              if (original.msg_type === 'image') payload = { messaging_product: 'whatsapp', to: num, type: 'image', image: { id: up.id, caption: caption || undefined } };
              else if (original.msg_type === 'video') payload = { messaging_product: 'whatsapp', to: num, type: 'video', video: { id: up.id, caption: caption || undefined } };
              else if (original.msg_type === 'audio') payload = { messaging_product: 'whatsapp', to: num, type: 'audio', audio: { id: up.id } };
              else if (original.msg_type === 'sticker') payload = { messaging_product: 'whatsapp', to: num, type: 'sticker', sticker: { id: up.id } };
              else payload = { messaging_product: 'whatsapp', to: num, type: 'document', document: { id: up.id, caption: caption || undefined, filename: up.fileName } };
              res = await waSend(env, payload);
            }
            if (res.ok) {
              results.sent++;
              try {
                await env.DB.prepare(
                  'INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                ).bind(new Date().toISOString(), res.id || '', 'outbound', num, '', original.msg_type, original.body || '', original.media_url || '', '', 'sent').run();
              } catch (_) {}
            } else {
              results.failed++;
              results.errors.push({ phone: num, error: res.error || 'send failed' });
            }
          } catch (e) {
            results.failed++;
            results.errors.push({ phone: rawPhone, error: e.message });
          }
        }
        return json(results);
      }

      // ===== Quick Replies CRUD =====
      if (request.method === 'GET' && path === '/admin/quick-replies') {
        try {
          const rs = await env.DB.prepare('SELECT id, shortcut, body, media_r2_key FROM quick_replies ORDER BY shortcut').all();
          return json({ replies: rs.results || [] });
        } catch (e) { return json({ replies: [] }); }
      }
      if (request.method === 'POST' && path === '/admin/quick-replies') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { shortcut, body: text, media_r2_key } = body || {};
        if (!shortcut || (!text && !media_r2_key)) return json({ error: 'missing shortcut, body or media' }, 400);
        const sc = shortcut.toLowerCase().replace(/\s+/g, '_');
        await env.DB.prepare('INSERT OR REPLACE INTO quick_replies (shortcut, body, media_r2_key, created_at) VALUES (?, ?, ?, ?)')
          .bind(sc, text || '', media_r2_key || null, new Date().toISOString()).run();
        return json({ ok: true });
      }
      if (request.method === 'DELETE' && path.startsWith('/admin/quick-replies/')) {
        const id = path.split('/').pop();
        // Borrar también la imagen de R2 si tenía
        try {
          const row = await env.DB.prepare('SELECT media_r2_key FROM quick_replies WHERE id = ?').bind(id).first();
          if (row?.media_r2_key) await env.MEDIA.delete(row.media_r2_key);
        } catch (_) {}
        await env.DB.prepare('DELETE FROM quick_replies WHERE id = ?').bind(id).run();
        return json({ ok: true });
      }
      // Subir imagen para usar en quick replies. Devuelve la R2 key.
      if (request.method === 'POST' && path === '/admin/quick-replies/upload') {
        try {
          const fd = await request.formData();
          const file = fd.get('file');
          if (!file || typeof file === 'string') return json({ error: 'missing file' }, 400);
          const ext = file.name ? '.' + file.name.split('.').pop() : '.jpg';
          const r2Key = `qr/${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
          const buf = await file.arrayBuffer();
          const mime = file.type || 'image/jpeg';
          await env.MEDIA.put(r2Key, buf, { httpMetadata: { contentType: mime } });
          return json({ ok: true, r2_key: r2Key });
        } catch (e) { return json({ error: e.message }, 500); }
      }
      // Enviar quick reply: el server resuelve si tiene imagen, la sube a Meta
      // (desde R2) y manda imagen+caption en una sola llamada. Sin imagen → texto.
      if (request.method === 'POST' && path === '/admin/wa/send-quick-reply') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { phone, qr_id } = body || {};
        if (!phone || !qr_id) return json({ error: 'missing phone or qr_id' }, 400);
        const qr = await env.DB.prepare('SELECT shortcut, body, media_r2_key FROM quick_replies WHERE id = ?').bind(qr_id).first();
        if (!qr) return json({ error: 'qr not found' }, 404);
        const num = normalizeArPhone(phone);
        if (!num) return json({ error: 'numero invalido' }, 400);
        // Sin imagen: texto plano por waSendText.
        if (!qr.media_r2_key) {
          const r = await waSendText(env, phone, qr.body);
          if (!r.ok) return json({ error: r.error || 'send failed' }, r.status || 500);
          try {
            await env.DB.prepare(
              'INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).bind(new Date().toISOString(), r.id || '', 'outbound', num, '', 'text', qr.body, '', '', 'sent').run();
          } catch (_) {}
          return json({ ok: true, type: 'text', id: r.id });
        }
        // Con imagen: descargar de R2 → upload a Meta → send con caption.
        const obj = await env.MEDIA.get(qr.media_r2_key);
        if (!obj) return json({ error: 'media missing in R2' }, 500);
        const buf = await obj.arrayBuffer();
        const mime = obj.httpMetadata?.contentType || 'image/jpeg';
        const ext = qr.media_r2_key.split('.').pop() || 'jpg';
        const v = env.WA_API_VERSION || 'v25.0';
        const fd = new FormData();
        fd.append('messaging_product', 'whatsapp');
        fd.append('file', new Blob([buf], { type: mime }), 'qr.' + ext);
        fd.append('type', mime);
        const upR = await fetch(`https://graph.facebook.com/${v}/${env.WA_PHONE_NUMBER_ID}/media`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.WA_TOKEN}` },
          body: fd
        });
        const upJ = await upR.json().catch(() => ({}));
        if (!upR.ok || !upJ.id) return json({ error: 'media upload failed', detail: upJ?.error?.message || '' }, 500);
        const r = await waSend(env, {
          messaging_product: 'whatsapp', to: num, type: 'image',
          image: { id: upJ.id, caption: qr.body || undefined }
        });
        if (!r.ok) return json({ error: r.error }, r.status || 500);
        try {
          await env.DB.prepare(
            'INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(new Date().toISOString(), r.id || '', 'outbound', num, '', 'image', qr.body || '[imagen]', qr.media_r2_key, '', 'sent').run();
        } catch (_) {}
        return json({ ok: true, type: 'image', id: r.id });
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

      // ===== Notas por contacto =====
      if (request.method === 'GET' && path === '/admin/contact-notes') {
        try {
          await env.DB.prepare("CREATE TABLE IF NOT EXISTS contact_notes (phone TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)").run();
          const phone = url.searchParams.get('phone') || '';
          if (phone) {
            const row = await env.DB.prepare('SELECT phone, note, updated_at FROM contact_notes WHERE phone = ?').bind(phone).first();
            return json({ note: row || null });
          }
          // Sin filtro: devolver todas las que tienen contenido (para preload masivo)
          const rs = await env.DB.prepare("SELECT phone, note, updated_at FROM contact_notes WHERE note != ''").all();
          return json({ notes: rs.results || [] });
        } catch (e) { return json({ error: e.message }, 500); }
      }
      if (request.method === 'PUT' && path === '/admin/contact-notes') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { phone, note } = body || {};
        if (!phone) return json({ error: 'missing phone' }, 400);
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS contact_notes (phone TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)").run();
        const now = new Date().toISOString();
        await env.DB.prepare(
          'INSERT INTO contact_notes (phone, note, updated_at) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at'
        ).bind(phone, String(note || ''), now).run();
        return json({ ok: true, updated_at: now });
      }
      if (request.method === 'DELETE' && path === '/admin/contact-notes') {
        const phone = url.searchParams.get('phone') || '';
        if (!phone) return json({ error: 'missing phone' }, 400);
        await env.DB.prepare('DELETE FROM contact_notes WHERE phone = ?').bind(phone).run();
        return json({ ok: true });
      }

      // ===== Marcar conversación como NO leída =====
      // (Borra el read_cursor para que la UI lo cuente como no leído otra vez)
      if (request.method === 'POST' && path === '/admin/wa/mark-unread') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { phone } = body || {};
        if (!phone) return json({ error: 'missing phone' }, 400);
        await env.DB.prepare('DELETE FROM wa_read_cursor WHERE phone = ?').bind(phone).run();
        return json({ ok: true });
      }

      // ===== Backfill de auto-labels =====
      // Procesa todos los inbound del rango y aplica las reglas de auto-labeling.
      // Útil cuando se modifican las keywords o para inicializar después de
      // cargar las labels nuevas. Idempotente.
      if (request.method === 'POST' && path === '/admin/wa/auto-label-backfill') {
        let body; try { body = await request.json(); } catch { body = {}; }
        const days = Math.max(1, Math.min(365, parseInt(body?.days || '90')));
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        try {
          const rs = await env.DB.prepare(
            "SELECT phone, body FROM wa_messages WHERE direction = 'inbound' AND body IS NOT NULL AND body != '' AND ts >= ? LIMIT 5000"
          ).bind(since).all();
          const rows = rs.results || [];
          let processed = 0;
          for (const r of rows) {
            await applyAutoLabels(env, r.phone, r.body);
            processed++;
          }
          return json({ ok: true, processed, since });
        } catch (e) { return json({ error: e.message }, 500); }
      }

      // ===== Archivar / desarchivar chats =====
      if (request.method === 'GET' && path === '/admin/wa/archived') {
        try {
          await env.DB.prepare('CREATE TABLE IF NOT EXISTS archived_chats (phone TEXT PRIMARY KEY, archived_at TEXT NOT NULL)').run();
          const rs = await env.DB.prepare('SELECT phone, archived_at FROM archived_chats').all();
          return json({ phones: (rs.results || []).map(r => r.phone) });
        } catch (e) { return json({ error: e.message }, 500); }
      }
      if (request.method === 'POST' && path === '/admin/wa/archive') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { phone } = body || {};
        if (!phone) return json({ error: 'missing phone' }, 400);
        await env.DB.prepare('CREATE TABLE IF NOT EXISTS archived_chats (phone TEXT PRIMARY KEY, archived_at TEXT NOT NULL)').run();
        await env.DB.prepare('INSERT OR REPLACE INTO archived_chats (phone, archived_at) VALUES (?, ?)').bind(phone, new Date().toISOString()).run();
        return json({ ok: true });
      }
      if (request.method === 'DELETE' && path === '/admin/wa/archive') {
        const phone = url.searchParams.get('phone') || '';
        if (!phone) return json({ error: 'missing phone' }, 400);
        await env.DB.prepare('DELETE FROM archived_chats WHERE phone = ?').bind(phone).run();
        return json({ ok: true });
      }

      // ===== Bulk messaging =====
      if (request.method === 'POST' && path === '/admin/wa/send-bulk') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { label_ids, message, template_name, template_lang } = body || {};
        if ((!label_ids || !label_ids.length) && !body.phones) return json({ error: 'missing label_ids or phones' }, 400);
        if (!message && !template_name) return json({ error: 'missing message or template_name' }, 400);
        // phones acepta dos formatos:
        //   1) ["54911...", "54922..."]  (sin params, mismo mensaje a todos)
        //   2) [{phone: "54911...", params: ["Juan"]}, ...]  (params por destinatario para template)
        let recipients = [];
        if (label_ids && label_ids.length) {
          const placeholders = label_ids.map(() => '?').join(',');
          const rs = await env.DB.prepare(`SELECT DISTINCT phone FROM contact_labels WHERE label_id IN (${placeholders})`).bind(...label_ids).all();
          recipients = (rs.results || []).map(r => ({ phone: r.phone, params: [] }));
        } else if (Array.isArray(body.phones)) {
          recipients = body.phones.map(p => typeof p === 'string' ? { phone: p, params: [] } : { phone: p.phone, params: p.params || [] });
        }
        if (!recipients.length) return json({ error: 'no contacts' }, 400);
        const results = { sent: 0, failed: 0, errors: [] };
        for (const it of recipients) {
          const ph = it.phone;
          try {
            let r;
            if (template_name) {
              r = await waSendTemplate(env, ph, template_name, template_lang || 'es', it.params || []);
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

      // ===== Templates: crear y listar =====
      if (request.method === 'POST' && path === '/admin/wa/template-create') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { name, category, language, body_text, example_params } = body || {};
        if (!name || !category || !language || !body_text) return json({ error: 'missing fields' }, 400);
        if (!env.WA_BUSINESS_ACCOUNT_ID || !env.WA_TOKEN) return json({ error: 'WA not configured' }, 500);
        const v = env.WA_API_VERSION || 'v25.0';
        const components = [{ type: 'BODY', text: body_text }];
        if (Array.isArray(example_params) && example_params.length) {
          components[0].example = { body_text: [example_params] };
        }
        const r = await fetch(`https://graph.facebook.com/${v}/${env.WA_BUSINESS_ACCOUNT_ID}/message_templates`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.WA_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, category, language, components })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: data?.error?.message || 'create failed', raw: data }, r.status || 500);
        return json({ ok: true, id: data.id, status: data.status, category: data.category });
      }
      // Setear (o resetear) el PIN de two-step verification del número.
      // POST a /{PHONE_NUMBER_ID} con {pin}. Necesario cuando la UI no expone
      // la opción de 2FA o cuando se olvidó el PIN viejo.
      if (request.method === 'POST' && path === '/admin/wa/set-pin') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { pin } = body || {};
        if (!pin || !/^\d{6}$/.test(String(pin))) return json({ error: 'pin debe ser 6 dígitos numéricos' }, 400);
        const v = env.WA_API_VERSION || 'v25.0';
        const r = await fetch(`https://graph.facebook.com/${v}/${env.WA_PHONE_NUMBER_ID}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.WA_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: String(pin) })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: data?.error?.message || 'set-pin failed', code: data?.error?.code, raw: data }, r.status || 500);
        return json({ ok: true, raw: data });
      }
      // Registrar número con Cloud API. Requiere PIN de two-step verification.
      // Si el PIN no fue setado o se olvidó, ir a WA Manager → Number → Settings →
      // Two-step verification → Set/Reset PIN.
      if (request.method === 'POST' && path === '/admin/wa/register') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { pin } = body || {};
        if (!pin) return json({ error: 'missing pin' }, 400);
        const v = env.WA_API_VERSION || 'v25.0';
        const r = await fetch(`https://graph.facebook.com/${v}/${env.WA_PHONE_NUMBER_ID}/register`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.WA_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', pin: String(pin) })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: data?.error?.message || 'register failed', code: data?.error?.code, raw: data }, r.status || 500);
        return json({ ok: true, raw: data });
      }
      // Datos crudos del phone number (incluye platform_type, code_verification_status, etc.)
      if (request.method === 'GET' && path === '/admin/wa/phone-info') {
        if (!env.WA_PHONE_NUMBER_ID || !env.WA_TOKEN) return json({ error: 'WA not configured' }, 500);
        const v = env.WA_API_VERSION || 'v25.0';
        const r = await fetch(`https://graph.facebook.com/${v}/${env.WA_PHONE_NUMBER_ID}?fields=verified_name,code_verification_status,display_phone_number,quality_rating,platform_type,certificate,messaging_limit_tier,health_status`, {
          headers: { 'Authorization': `Bearer ${env.WA_TOKEN}` }
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: data?.error?.message || 'failed', raw: data }, r.status || 500);
        return json(data);
      }
      // Status del número productivo (tier de mensajería + quality rating).
      if (request.method === 'GET' && path === '/admin/wa/phone-status') {
        if (!env.WA_BUSINESS_ACCOUNT_ID || !env.WA_TOKEN) return json({ error: 'WA not configured' }, 500);
        const v = env.WA_API_VERSION || 'v25.0';
        const fields = 'id,display_phone_number,quality_rating,messaging_limit_tier,verified_name,status,name_status,throughput,health_status';
        const r = await fetch(`https://graph.facebook.com/${v}/${env.WA_BUSINESS_ACCOUNT_ID}/phone_numbers?fields=${fields}`, {
          headers: { 'Authorization': `Bearer ${env.WA_TOKEN}` }
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: data?.error?.message || 'fetch failed', raw: data }, r.status || 500);
        return json({ phones: data.data || [] });
      }
      if (request.method === 'GET' && path === '/admin/wa/templates') {
        if (!env.WA_BUSINESS_ACCOUNT_ID || !env.WA_TOKEN) return json({ error: 'WA not configured' }, 500);
        const v = env.WA_API_VERSION || 'v25.0';
        const r = await fetch(`https://graph.facebook.com/${v}/${env.WA_BUSINESS_ACCOUNT_ID}/message_templates?limit=100&fields=name,status,category,language,components`, {
          headers: { 'Authorization': `Bearer ${env.WA_TOKEN}` }
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: data?.error?.message || 'list failed' }, r.status || 500);
        return json({ templates: data.data || [] });
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
    // Monitorear cambios de status de templates (PENDING → APPROVED/REJECTED)
    ctx.waitUntil(monitorTemplateStatus(env));
  }
};

// ===== Monitor de templates: notifica al admin cuando cambia el status =====
async function monitorTemplateStatus(env) {
  if (!env.WA_BUSINESS_ACCOUNT_ID || !env.WA_TOKEN || !env.ADMIN_NOTIFY_PHONE) return;
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS template_status_cache (name TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL)').run();
    const v = env.WA_API_VERSION || 'v25.0';
    const r = await fetch(`https://graph.facebook.com/${v}/${env.WA_BUSINESS_ACCOUNT_ID}/message_templates?limit=100&fields=name,status,category`, {
      headers: { 'Authorization': `Bearer ${env.WA_TOKEN}` }
    });
    if (!r.ok) return;
    const data = await r.json().catch(() => ({}));
    const templates = data?.data || [];
    for (const t of templates) {
      const name = t.name;
      const status = t.status;
      if (!name || !status) continue;
      const cached = await env.DB.prepare('SELECT status FROM template_status_cache WHERE name = ?').bind(name).first();
      const prevStatus = cached?.status || null;
      if (prevStatus === status) continue; // sin cambio
      await env.DB.prepare(
        'INSERT INTO template_status_cache (name, status, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at'
      ).bind(name, status, new Date().toISOString()).run();
      // Solo notifica si pasó de PENDING a algo decidido (no en la primera carga del cache).
      const becameDecided = prevStatus === 'PENDING' && (status === 'APPROVED' || status === 'REJECTED');
      if (becameDecided) {
        const emoji = status === 'APPROVED' ? '✅' : '❌';
        const msg = `${emoji} Template "${name}" ahora está ${status}.`;
        try { await waSendText(env, env.ADMIN_NOTIFY_PHONE, msg); } catch (_) {}
      }
    }
  } catch (e) {
    await logWaEvent(env, { to: '', kind: 'template-monitor', ref: '', ok: false, error: e.message });
  }
}

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

// ===== Auto-labeling por keywords =====
// Cuando llega un inbound con texto, analizamos el body buscando keywords
// que matcheen reglas. Si matchea, le aplicamos la etiqueta correspondiente
// al contacto (idempotente vía INSERT OR IGNORE).
//
// Reglas hardcodeadas v1. Si más adelante se quiere editar desde UI, mover
// a una tabla `auto_label_rules (label_id, keywords TEXT, created_at)` y
// loadearla acá. Por ahora, simple y directo.
const AUTO_LABEL_RULES = [
  {
    label: 'interesado curso',
    // Keywords case-insensitive. Match si el body contiene CUALQUIERA.
    // Acentos opcionales: la comparación normaliza ambas puntas.
    keywords: [
      'curso', 'cursos', 'comunidad', 'capacitacion', 'capacitación',
      'aprender', 'taller', 'clase', 'clases', 'alumno', 'alumna',
      'inscribir', 'inscripcion', 'inscripción', 'formacion', 'formación',
      'estudiar', 'aprendizaje', 'enseñan', 'ensenan'
    ]
  },
  {
    label: 'interesado cartel',
    keywords: [
      'cartel', 'carteles', 'neon', 'neón', 'letrero', 'letreros',
      'luminoso', 'luminosa', 'rotulo', 'rótulo', 'logo', 'iluminar',
      'cotizacion', 'cotización', 'cotizar', 'presupuesto', 'precio',
      'medidas', 'diseño', 'render', 'fachada'
    ]
  }
];

function _normalizeForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, ''); // saca acentos
}

async function applyAutoLabels(env, phone, body) {
  const haystack = _normalizeForMatch(body);
  if (!haystack) return;
  const matched = [];
  for (const rule of AUTO_LABEL_RULES) {
    for (const kw of rule.keywords) {
      const needle = _normalizeForMatch(kw);
      // Word boundary aproximado: separador o inicio/fin alrededor.
      const re = new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
      if (re.test(haystack)) { matched.push(rule.label); break; }
    }
  }
  if (!matched.length) return;
  // Resolver IDs de las labels que matchearon
  for (const labelName of matched) {
    try {
      const row = await env.DB.prepare('SELECT id FROM labels WHERE name = ?').bind(labelName).first();
      if (!row?.id) continue;
      await env.DB.prepare(
        'INSERT OR IGNORE INTO contact_labels (phone, label_id, created_at) VALUES (?, ?, ?)'
      ).bind(phone, row.id, new Date().toISOString()).run();
    } catch (_) {}
  }
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
  let skippedInvalid = 0;

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
    // ¿Ya tiene follow-up (sent o failed)?
    if (conv.some(m => m.direction === 'outbound' && (m.body || '').startsWith(FOLLOWUP_PRESUPUESTO_PREFIX_TEXT))) continue;

    // Helper para insertar el marker (sent o failed) — ambos casos previenen
    // que el próximo cron re-encuentre este presupuesto como pendiente.
    const insertMarker = async (status, wamid) => {
      try {
        await env.DB.prepare(
          'INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(new Date().toISOString(), wamid, 'outbound', p.phone, '', 'text', FOLLOWUP_PRESUPUESTO_TEXT, '', '', status).run();
      } catch (_) {}
    };

    // 4) Pre-validar: si el teléfono no normaliza, marcamos como fallido
    // permanente y no gastamos call al API ni notificamos al admin.
    if (!normalizeArPhone(p.phone)) {
      await insertMarker('failed', 'fu-invalid:' + p.phone);
      await logWaEvent(env, { to: p.phone, kind: 'pp-followup', ref: 'pp-fu:' + p.phone, ok: false, error: 'numero invalido (skip)' });
      skippedInvalid++;
      continue;
    }

    // 5) Enviar
    const r = await waSendText(env, p.phone, FOLLOWUP_PRESUPUESTO_TEXT);
    if (r.ok) {
      sent++;
      await insertMarker('sent', r.id || '');
    } else {
      // Marker failed → el próximo cron NO lo va a re-procesar. Una sola
      // notificación al admin por presupuesto, no spam cada 5 min.
      await insertMarker('failed', 'fu-fail:' + p.phone + ':' + Date.now());
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
