#!/usr/bin/env node
/**
 * scrape-wa-delta.js — Catch-up + Live listener.
 *
 * Diseñado para correr continuo. Hace dos cosas:
 *
 *  1) CATCH-UP (al arrancar y cada CATCHUP_INTERVAL_MIN minutos):
 *     Recorre todos los chats con actividad reciente y baja los últimos N
 *     mensajes. El worker hace INSERT OR IGNORE por wamid, así que duplicados
 *     se descartan solos. Captura todo lo que llegó mientras el listener
 *     estaba caído o desconectado.
 *
 *  2) LIVE LISTENER:
 *     Escucha message_create y postea cada mensaje al toque. Inbound y
 *     outbound (incluyendo lo que Joaco mande desde la app del 6573).
 *
 * Reusa la sesión persistente de .wa-session/. Si crashea, lo relanzás y
 * retoma. Idempotente por wamid en el backend.
 *
 * Uso:
 *   node scrape-wa-delta.js
 *
 * Stats UI: http://localhost:8765
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const http = require('http');

// QR state — si la sesión está vencida, el web UI muestra el QR aquí.
let currentQrDataUrl = '';

// === CONFIG ===
const WORKER_URL = 'https://ni-ventas-tracker.neoninfinito.workers.dev';
const TOKEN_FILE = path.join(__dirname, '.crm-token');
const STATE_FILE = path.join(__dirname, '.delta-state.json');
const STATS_PORT = 8765;
const CATCHUP_INTERVAL_MIN = 15;   // catch-up cada 15 min — agresivo porque WA Web está
                                    // sincronizando historial post-relink (los primeros días)
const CATCHUP_LOOKBACK_DAYS = 21;  // amplío a 21 días por las dudas — cuando WA sincroniza
                                    // mensajes viejos, el chat.timestamp puede ser antiguo
const FETCH_LIMIT_PER_CHAT = 80;   // últimos 80 mensajes por chat (dedup en backend)
const BATCH_SIZE = 50;
const SLEEP_BETWEEN_CHATS_MS = 300;
// Media download config
const MEDIA_TYPES = new Set(['image', 'audio', 'video', 'sticker', 'document']);
const MEDIA_DOWNLOAD_TIMEOUT_MS = 25000;   // skip si tarda más de 25s
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;  // skip si >25MB

function getToken() {
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (process.env.CRM_TOKEN) return process.env.CRM_TOKEN;
  console.error('❌ No hay token. Setealo en scripts/.crm-token');
  process.exit(1);
}
const TOKEN = getToken();

// === Estado persistido (stats + last catchup) ===
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) {}
  }
  return {
    startedAt: new Date().toISOString(),
    status: 'starting',
    catchupRuns: 0,
    lastCatchupAt: null,
    lastCatchupInserted: 0,
    catchupTotalInserted: 0,
    liveIn: 0,
    liveOut: 0,
    errors: 0,
    lastLiveAt: null,
    lastLiveFrom: null,
    mediaDownloaded: 0,
    mediaSkipped: 0,
    mediaFailed: 0
  };
}

// Set en memoria con wamids que YA conocemos (están en DB). Se llena al
// arrancar via GET /admin/wa/wamids y se actualiza al postear mensajes nuevos.
// Sirve para skipear el download de media en catch-up cuando el mensaje ya
// existe (caso típico: se procesan los últimos 80 msgs por chat, casi todos
// ya están en DB, no tiene sentido re-bajar la media de cada uno).
const seenWamids = new Set();
let state = loadState();
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (_) {}
}

// === HTTP Stats UI ===
function startStatsServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const upMs = state.startedAt ? Date.now() - new Date(state.startedAt).getTime() : 0;
    const h = Math.floor(upMs / 3600000);
    const m = Math.floor((upMs % 3600000) / 60000);
    const sColor = state.status === 'live' ? '#25D366' : state.status === 'catching_up' ? '#FFA726' : state.status === 'idle' ? '#8FD4DE' : '#FF1830';
    res.end(`<!DOCTYPE html><html><head>
      <meta charset="UTF-8"><title>NEON · WA Delta</title>
      <meta http-equiv="refresh" content="5">
      <style>
        body{background:#0A0A0F;color:#e9edef;font-family:-apple-system,system-ui,sans-serif;padding:30px;max-width:700px;margin:0 auto;}
        h1{background:linear-gradient(135deg,#FF1830,#8FD4DE);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:6px;}
        .sub{color:rgba(233,237,239,.55);font-size:13px;margin-bottom:24px;}
        .status{padding:14px 18px;border-radius:10px;background:#18181f;border:1px solid #2a2a35;margin-bottom:20px;}
        .pill{display:inline-block;padding:4px 12px;border-radius:14px;font-family:ui-monospace,monospace;font-size:11px;font-weight:700;letter-spacing:.5px;}
        .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
        .card{background:#18181f;border:1px solid #2a2a35;border-radius:10px;padding:16px;}
        .lbl{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:rgba(233,237,239,.45);font-weight:600;margin-bottom:6px;}
        .val{font-size:24px;font-weight:700;font-family:ui-monospace,monospace;}
        .last{margin-top:20px;padding:14px 18px;background:rgba(143,212,222,.06);border-left:3px solid #8FD4DE;border-radius:6px;font-size:13px;}
        .last b{color:#8FD4DE;}
      </style></head><body>
      <h1>🔁 WA Delta Scraper</h1>
      <div class="sub">Catch-up periódico + Live listener — pensado para correr 24/7</div>
      ${state.status === 'waiting_qr' && currentQrDataUrl ? `
        <div style="background:#fff;padding:18px;border-radius:14px;text-align:center;margin-bottom:20px">
          <img src="${currentQrDataUrl}" width="320" height="320" alt="QR de WhatsApp" style="display:block;margin:0 auto">
          <div style="color:#0A0A0F;font-size:13px;margin-top:10px"><b>Escanealo desde el celular del 6573:</b><br>WhatsApp Business → Ajustes → Dispositivos vinculados → Vincular un dispositivo</div>
        </div>
      ` : ''}
      <div class="status">
        <div class="pill" style="background:rgba(143,212,222,.12);color:${sColor}">● ${state.status.toUpperCase().replace(/_/g,' ')}</div>
        <div style="margin-top:10px;font-size:13px;color:rgba(233,237,239,.65)">
          Uptime: ${h}h ${m}m · Inició ${new Date(state.startedAt).toLocaleString('es-AR')}<br>
          Próximo catch-up cada ${CATCHUP_INTERVAL_MIN} min · ${state.catchupRuns} ya hechos
        </div>
      </div>
      <div class="grid">
        <div class="card"><div class="lbl">Catch-up — total nuevos</div><div class="val" style="color:#FFA726">${state.catchupTotalInserted}</div></div>
        <div class="card"><div class="lbl">Catch-up — último</div><div class="val">${state.lastCatchupInserted}</div></div>
      </div>
      <div class="grid" style="margin-top:14px">
        <div class="card"><div class="lbl">Live · Inbound</div><div class="val" style="color:#25D366">${state.liveIn}</div></div>
        <div class="card"><div class="lbl">Live · Outbound</div><div class="val" style="color:#8FD4DE">${state.liveOut}</div></div>
      </div>
      <div class="grid" style="margin-top:14px">
        <div class="card"><div class="lbl">Total live</div><div class="val">${state.liveIn + state.liveOut}</div></div>
        <div class="card"><div class="lbl">Errores</div><div class="val" style="color:${state.errors>0?'#FF1830':'#25D366'}">${state.errors}</div></div>
      </div>
      <div class="grid" style="margin-top:14px">
        <div class="card"><div class="lbl">Media ↓ subida a R2</div><div class="val" style="color:#8FD4DE">${state.mediaDownloaded || 0}</div></div>
        <div class="card"><div class="lbl">Media skip (ya en R2)</div><div class="val">${state.mediaSkipped || 0}</div></div>
      </div>
      <div class="grid" style="margin-top:14px">
        <div class="card"><div class="lbl">Media falló (timeout/error)</div><div class="val" style="color:${state.mediaFailed>0?'#FFA726':'#25D366'}">${state.mediaFailed || 0}</div></div>
        <div class="card"><div class="lbl">Wamids conocidos</div><div class="val">${seenWamids.size}</div></div>
      </div>
      ${state.lastLiveAt ? `<div class="last">
        <b>Último mensaje live:</b> ${new Date(state.lastLiveAt).toLocaleString('es-AR')}<br>
        <b>De:</b> ${state.lastLiveFrom || '—'}
      </div>` : ''}
      ${state.lastCatchupAt ? `<div class="last" style="border-left-color:#FFA726;background:rgba(255,167,38,.06)">
        <b style="color:#FFA726">Último catch-up:</b> ${new Date(state.lastCatchupAt).toLocaleString('es-AR')} — ${state.lastCatchupInserted} nuevos
      </div>` : ''}
      <div style="margin-top:24px;font-size:11px;color:rgba(233,237,239,.4);text-align:center">Auto-refresh cada 5s · Ctrl+C en la terminal para parar</div>
    </body></html>`);
  });
  server.listen(STATS_PORT, '127.0.0.1', () => {
    console.log(`🌐 Stats en http://localhost:${STATS_PORT}`);
  });
}

// === Helpers ===
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function tsToISO(ts) { return new Date((ts || 0) * 1000).toISOString(); }

async function resolvePhone(chat) {
  const serial = chat.id?._serialized || '';
  if (serial.endsWith('@c.us')) return chat.id.user;
  const nm = (chat.name || chat.pushname || '').trim();
  const m = nm.match(/\+?\s*(\d[\d\s\-()]+)/);
  if (m) {
    const d = m[1].replace(/\D/g, '');
    if (d.length >= 10 && d.length <= 15) return d;
  }
  try {
    const c = await chat.getContact();
    if (c?.number) return String(c.number).replace(/\D/g, '');
    if (c?.id?.user && /^\d+$/.test(c.id.user) && c.id.server === 'c.us') return c.id.user;
  } catch (_) {}
  return null;
}

// Descarga media de WA Web y la sube al worker → R2. Devuelve la key R2
// o null si no se pudo. Skip si el wamid ya es conocido (probablemente
// dup en catch-up, no vale la pena gastar el download).
async function downloadAndUploadMedia(msg, wamid, msgType) {
  if (!wamid || !MEDIA_TYPES.has(msgType)) return null;
  if (seenWamids.has(wamid)) {
    state.mediaSkipped++;
    return null;
  }
  try {
    // Timeout: si downloadMedia tarda demasiado, skip y seguir.
    const downloadP = msg.downloadMedia();
    const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), MEDIA_DOWNLOAD_TIMEOUT_MS));
    const media = await Promise.race([downloadP, timer]);
    if (!media || !media.data) {
      state.mediaFailed++;
      // Causa más común: media vieja con keys expiradas en WhatsApp.
      if ((state.mediaFailed % 10) === 1) console.log(`     ⚠ media ${msgType} sin data (probable: expirada en WA): ${wamid.slice(-12)}`);
      return null;
    }
    const buf = Buffer.from(media.data, 'base64');
    if (buf.length > MEDIA_MAX_BYTES) {
      console.log(`     ⚠ media ${msgType} skipeada (${(buf.length/1048576).toFixed(1)}MB > 25MB)`);
      state.mediaFailed++;
      return null;
    }
    const filename = media.filename || ('media' + (
      msgType === 'audio' ? '.ogg' :
      msgType === 'image' ? '.jpg' :
      msgType === 'video' ? '.mp4' :
      msgType === 'sticker' ? '.webp' : ''
    ));
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: media.mimetype || 'application/octet-stream' }), filename);
    fd.append('wamid', wamid);
    fd.append('type', msgType);
    const r = await fetch(WORKER_URL + '/admin/wa/media/upload', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + TOKEN },
      body: fd
    });
    if (!r.ok) {
      state.mediaFailed++;
      const txt = await r.text().catch(() => '');
      console.log(`     ⚠ upload R2 falló HTTP ${r.status} ${txt.slice(0,100)}`);
      return null;
    }
    const j = await r.json();
    if (!j.key) {
      state.mediaFailed++;
      console.log(`     ⚠ upload R2 OK pero sin key: ${JSON.stringify(j).slice(0,100)}`);
      return null;
    }
    state.mediaDownloaded++;
    if ((state.mediaDownloaded % 25) === 1) {
      console.log(`     ✓ media R2: ${state.mediaDownloaded} OK / ${state.mediaFailed} fail (${msgType} → ${j.key})`);
    }
    return j.key;
  } catch (e) {
    state.mediaFailed++;
    if ((state.mediaFailed % 10) === 1) console.log(`     ⚠ media exception: ${e.message?.slice(0,80)}`);
    return null;
  }
}

async function normalizeMessage(msg) {
  const ts = tsToISO(msg.timestamp);
  const direction = msg.fromMe ? 'outbound' : 'inbound';
  let msgType = 'text';
  if (msg.type === 'image') msgType = 'image';
  else if (msg.type === 'audio' || msg.type === 'ptt') msgType = 'audio';
  else if (msg.type === 'video') msgType = 'video';
  else if (msg.type === 'document') msgType = 'document';
  else if (msg.type === 'sticker') msgType = 'sticker';
  else if (msg.type === 'location') msgType = 'location';
  else if (msg.type === 'vcard' || msg.type === 'multi_vcard') msgType = 'contact';
  else if (msg.type === 'revoked') msgType = 'revoke';
  let body = String(msg.body || '');
  if (msg.hasMedia && !body) {
    body = msgType === 'image' ? '[imagen]'
         : msgType === 'audio' ? '[audio]'
         : msgType === 'video' ? '[video]'
         : msgType === 'document' ? '[documento]'
         : msgType === 'sticker' ? '[sticker]'
         : '[' + msgType + ']';
  }
  if (msg.type === 'location') {
    const loc = msg.location || {};
    body = `[ubicacion] ${loc.latitude || ''},${loc.longitude || ''}${loc.description ? ' — ' + loc.description : ''}`;
  }
  const wamid = msg.id?._serialized || msg.id?.id || ('delta_' + msg.timestamp + '_' + Math.random().toString(36).slice(2, 8));
  // Si tiene media, intentar bajarla y subirla a R2 (returns key o null).
  let mediaKey = '';
  if (msg.hasMedia && MEDIA_TYPES.has(msgType)) {
    mediaKey = await downloadAndUploadMedia(msg, wamid, msgType) || '';
  }
  return {
    ts,
    wamid,
    direction,
    msg_type: msgType,
    body,
    media_url: mediaKey,
    sender_name: msg.author || msg._data?.notifyName || '',
    context_id: msg.hasQuotedMsg ? (msg._data?.quotedStanzaID || '') : ''
  };
}

async function postBatch(phone, contactName, messages) {
  if (!messages.length) return { inserted: 0, duplicates: 0, errors: 0 };
  const r = await fetch(WORKER_URL + '/admin/wa/import-bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
    body: JSON.stringify({ phone, contactName, messages })
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  // Marcar los wamids como conocidos para que el próximo catch-up no
  // intente bajar la media de nuevo (los acabamos de procesar).
  for (const m of messages) if (m.wamid) seenWamids.add(m.wamid);
  return await r.json();
}

// === Phase 1: Catch-up ===
let catchupRunning = false;
async function runCatchup(client) {
  if (catchupRunning) {
    console.log('⏭  Catch-up ya está corriendo, salteando.');
    return;
  }
  catchupRunning = true;
  const wasStatus = state.status;
  state.status = 'catching_up';
  saveState();
  const t0 = Date.now();
  console.log('');
  console.log(`🔁 [${new Date().toLocaleTimeString('es-AR')}] CATCH-UP iniciado...`);

  let totalNew = 0, totalDup = 0, chatsScanned = 0, chatsWithNew = 0;
  try {
    const chats = await client.getChats();
    const cutoffSec = Math.floor((Date.now() - CATCHUP_LOOKBACK_DAYS * 86400000) / 1000);
    const eligible = chats.filter(c => !c.isGroup
      && !c.id._serialized.includes('status')
      && (c.timestamp || 0) >= cutoffSec
    );
    console.log(`   ${eligible.length} chats con actividad en últimos ${CATCHUP_LOOKBACK_DAYS} días`);

    for (const chat of eligible) {
      chatsScanned++;
      const phone = await resolvePhone(chat);
      if (!phone || phone.length < 10 || phone.length > 15) continue;
      const contactName = (chat.name || chat.pushname || '').trim();
      try {
        const messages = await chat.fetchMessages({ limit: FETCH_LIMIT_PER_CHAT });
        if (!messages.length) continue;
        // Normalizar uno por uno (es async porque puede bajar media).
        // Hacemos serial dentro del chat para no saturar el browser con N
        // downloads paralelos; el paralelismo viene entre chats al loopear.
        const normalized = [];
        for (const m of messages) {
          const n = await normalizeMessage(m);
          if (n.body || n.msg_type !== 'text') normalized.push(n);
        }
        let chatNew = 0, chatDup = 0;
        for (let i = 0; i < normalized.length; i += BATCH_SIZE) {
          const batch = normalized.slice(i, i + BATCH_SIZE);
          try {
            const res = await postBatch(phone, contactName, batch);
            chatNew += res.inserted || 0;
            chatDup += res.duplicates || 0;
          } catch (e) {
            state.errors++;
          }
        }
        totalNew += chatNew;
        totalDup += chatDup;
        if (chatNew > 0) {
          chatsWithNew++;
          console.log(`   📥 ${phone} (${contactName || '-'}): ${chatNew} nuevos`);
        }
        if (chatsScanned % 25 === 0) {
          process.stdout.write(`   [${chatsScanned}/${eligible.length}] · ${totalNew} nuevos\r`);
        }
        await sleep(SLEEP_BETWEEN_CHATS_MS);
      } catch (e) {
        state.errors++;
      }
    }

    state.catchupRuns++;
    state.lastCatchupAt = new Date().toISOString();
    state.lastCatchupInserted = totalNew;
    state.catchupTotalInserted += totalNew;
    saveState();
    const secs = Math.round((Date.now() - t0) / 1000);
    console.log('');
    console.log(`✅ Catch-up #${state.catchupRuns} completo en ${secs}s — ${totalNew} mensajes nuevos en ${chatsWithNew} chats (${totalDup} duplicados, ${chatsScanned} chats escaneados)`);
  } catch (e) {
    console.error('❌ Error en catch-up:', e.message);
    state.errors++;
  } finally {
    catchupRunning = false;
    state.status = wasStatus === 'starting' ? 'live' : 'live';
    saveState();
  }
}

// === Main ===
async function main() {
  console.log('🔁 NEON · WA Delta Scraper (Catch-up + Live)');
  console.log('   Worker:', WORKER_URL);
  console.log('   Catch-up cada', CATCHUP_INTERVAL_MIN, 'min — Lookback', CATCHUP_LOOKBACK_DAYS, 'días');
  console.log('');

  startStatsServer();

  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome'
  ];
  let chromeExe = process.env.CHROME_PATH || '';
  if (!chromeExe) for (const p of chromePaths) if (fs.existsSync(p)) { chromeExe = p; break; }
  if (!chromeExe) { console.error('❌ Chrome no encontrado'); process.exit(1); }

  state.status = 'starting';
  saveState();

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wa-session') }),
    puppeteer: {
      headless: true,
      executablePath: chromeExe,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', async (qr) => {
    state.status = 'waiting_qr';
    saveState();
    try {
      currentQrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 480, errorCorrectionLevel: 'L' });
    } catch (_) {}
    console.log('📱 QR actualizado · escanealo desde http://localhost:' + STATS_PORT);
  });
  client.on('authenticated', () => {
    console.log('✅ Autenticado');
    state.status = 'authenticating';
    currentQrDataUrl = ''; // limpiar QR
    saveState();
  });
  client.on('ready', async () => {
    console.log('✅ WhatsApp Web LISTO');
    state.status = 'live';
    saveState();

    // Bajar la lista de TODOS los wamids ya conocidos en DB. Sirve para
    // skipear el download de media en catch-up cuando el mensaje es un dup.
    try {
      const r = await fetch(WORKER_URL + '/admin/wa/wamids', {
        headers: { 'Authorization': 'Bearer ' + TOKEN }
      });
      if (r.ok) {
        const j = await r.json();
        for (const w of (j.wamids || [])) seenWamids.add(w);
        console.log(`📁 ${seenWamids.size} wamids conocidos en DB (no se re-bajará media de duplicados)`);
      }
    } catch (e) {
      console.log('⚠ no pude bajar wamids existentes:', e.message);
    }

    // Primer catch-up al arrancar
    await runCatchup(client);

    // Loop periódico de catch-up
    setInterval(() => runCatchup(client).catch(e => console.error('catchup loop err:', e.message)),
      CATCHUP_INTERVAL_MIN * 60 * 1000);
  });
  client.on('disconnected', (reason) => {
    console.log('⚠️ Desconectado:', reason);
    state.status = 'disconnected';
    saveState();
  });

  // Live listener
  client.on('message_create', async (msg) => {
    try {
      const chat = await msg.getChat();
      if (chat.isGroup || chat.id._serialized.includes('status')) return;
      const phone = await resolvePhone(chat);
      if (!phone || phone.length < 10) return;
      const contactName = (chat.name || chat.pushname || '').trim();
      const normalized = await normalizeMessage(msg);
      await postBatch(phone, contactName, [normalized]);
      if (normalized.direction === 'inbound') state.liveIn++;
      else state.liveOut++;
      state.lastLiveAt = new Date().toISOString();
      state.lastLiveFrom = `${contactName || phone} (${normalized.direction})`;
      saveState();
      const arrow = normalized.direction === 'inbound' ? '📥' : '📤';
      console.log(`${arrow} ${phone} (${contactName || '—'}): ${normalized.body.slice(0, 60).replace(/\n/g, ' ')}`);
    } catch (e) {
      state.errors++;
      saveState();
      console.error('❌ Error live:', e.message);
    }
  });

  await client.initialize();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
