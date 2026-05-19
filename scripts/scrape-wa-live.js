#!/usr/bin/env node
/**
 * scrape-wa-live.js — Listener en tiempo real de WhatsApp Web.
 *
 * Usa la misma sesión persistente que dejaste vinculada con scrape-wa-history.js.
 * Cada mensaje nuevo (inbound u outbound desde el celular de Joaco) lo captura
 * y lo manda al CRM al toque. Es como un "scrape delta continuo" sin lag.
 *
 * Uso:
 *   node scrape-wa-live.js
 *
 * Stats UI: http://localhost:8765 (auto-refresca cada 5s)
 *
 * Dejalo corriendo en una terminal hasta el momento de la migración.
 * Si la PC se reinicia, simplemente lo volvés a correr.
 * Si el script crashea, retoma desde donde estaba (la sesión persiste).
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const http = require('http');

// === CONFIG ===
const WORKER_URL = 'https://ni-ventas-tracker.neoninfinito.workers.dev';
const TOKEN_FILE = path.join(__dirname, '.crm-token');
const STATS_FILE = path.join(__dirname, '.live-stats.json');
const STATS_PORT = 8765;

function getToken() {
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (process.env.CRM_TOKEN) return process.env.CRM_TOKEN;
  console.error('❌ No hay token. Setealo en scripts/.crm-token');
  process.exit(1);
}
const TOKEN = getToken();

// === Stats ===
let stats = (() => {
  if (fs.existsSync(STATS_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch (_) {}
  }
  return { startedAt: new Date().toISOString(), messagesIn: 0, messagesOut: 0, errors: 0, lastMsgAt: null, lastMsgFrom: null, status: 'starting' };
})();
function saveStats() {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2)); } catch (_) {}
}

// === Mini HTTP server para ver el estado en vivo ===
function startStatsServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const upMs = stats.startedAt ? Date.now() - new Date(stats.startedAt).getTime() : 0;
    const hours = Math.floor(upMs / 3600000);
    const minutes = Math.floor((upMs % 3600000) / 60000);
    const statusColor = stats.status === 'live' ? '#25D366' : stats.status === 'authenticating' ? '#FFA726' : '#FF1830';
    res.end(`<!DOCTYPE html><html><head>
      <meta charset="UTF-8">
      <title>NEON · WA Live Listener</title>
      <meta http-equiv="refresh" content="5">
      <style>
        body { background:#0A0A0F; color:#e9edef; font-family:-apple-system,system-ui,sans-serif; padding:30px; max-width:680px; margin:0 auto; }
        h1 { background:linear-gradient(135deg,#FF1830,#8FD4DE); -webkit-background-clip:text; -webkit-text-fill-color:transparent; margin-bottom:6px; }
        .sub { color:rgba(233,237,239,.55); font-size:13px; margin-bottom:24px; }
        .status { padding:14px 18px; border-radius:10px; background:#18181f; border:1px solid #2a2a35; margin-bottom:20px; }
        .status-pill { display:inline-block; padding:4px 12px; border-radius:14px; font-family:ui-monospace,monospace; font-size:11px; font-weight:700; letter-spacing:.5px; }
        .grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
        .card { background:#18181f; border:1px solid #2a2a35; border-radius:10px; padding:16px; }
        .card-label { font-size:10px; text-transform:uppercase; letter-spacing:.8px; color:rgba(233,237,239,.45); font-weight:600; margin-bottom:6px; }
        .card-value { font-size:24px; font-weight:700; font-family:ui-monospace,monospace; }
        .last { margin-top:20px; padding:14px 18px; background:rgba(143,212,222,.06); border-left:3px solid #8FD4DE; border-radius:6px; font-size:13px; }
        .last b { color:#8FD4DE; }
      </style>
    </head><body>
      <h1>📡 WA Live Listener</h1>
      <div class="sub">Captura mensajes en tiempo real y los manda al CRM</div>
      <div class="status">
        <div class="status-pill" style="background:rgba(${stats.status==='live'?'37,211,102':stats.status==='authenticating'?'255,167,38':'255,24,48'},.15); color:${statusColor}">
          ● ${stats.status === 'live' ? 'EN VIVO' : stats.status === 'authenticating' ? 'AUTENTICANDO' : stats.status.toUpperCase()}
        </div>
        <div style="margin-top:10px;font-size:13px;color:rgba(233,237,239,.65)">
          Uptime: ${hours}h ${minutes}m · Inició ${stats.startedAt ? new Date(stats.startedAt).toLocaleString('es-AR') : '—'}
        </div>
      </div>
      <div class="grid">
        <div class="card"><div class="card-label">Inbound (entrantes)</div><div class="card-value" style="color:#25D366">${stats.messagesIn}</div></div>
        <div class="card"><div class="card-label">Outbound (salientes de Joaco)</div><div class="card-value" style="color:#8FD4DE">${stats.messagesOut}</div></div>
      </div>
      <div class="grid" style="margin-top:14px">
        <div class="card"><div class="card-label">Total capturado</div><div class="card-value">${stats.messagesIn + stats.messagesOut}</div></div>
        <div class="card"><div class="card-label">Errores</div><div class="card-value" style="color:${stats.errors > 0 ? '#FF1830' : '#25D366'}">${stats.errors}</div></div>
      </div>
      ${stats.lastMsgAt ? `<div class="last">
        <b>Último mensaje:</b> ${new Date(stats.lastMsgAt).toLocaleString('es-AR')}<br>
        <b>De:</b> ${stats.lastMsgFrom || '—'}
      </div>` : ''}
      <div style="margin-top:24px;font-size:11px;color:rgba(233,237,239,.4);text-align:center">
        Esta página se refresca cada 5 segundos.<br>
        Para detener el listener: Ctrl+C en la terminal donde corre.
      </div>
    </body></html>`);
  });
  server.listen(STATS_PORT, '127.0.0.1', () => {
    console.log(`🌐 Stats en vivo: http://localhost:${STATS_PORT}`);
  });
}

// === Helpers (reusados del scrape-wa-history.js) ===
function tsToISO(ts) { return new Date((ts || 0) * 1000).toISOString(); }
async function resolvePhone(chat) {
  const serial = chat.id?._serialized || '';
  if (serial.endsWith('@c.us')) return chat.id.user;
  const nm = (chat.name || chat.pushname || '').trim();
  const matchPlus = nm.match(/\+?\s*(\d[\d\s\-()]+)/);
  if (matchPlus) {
    const digits = matchPlus[1].replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) return digits;
  }
  try {
    const contact = await chat.getContact();
    if (contact?.number) return String(contact.number).replace(/\D/g, '');
    if (contact?.id?.user && /^\d+$/.test(contact.id.user) && contact.id.server === 'c.us') return contact.id.user;
  } catch (_) {}
  return null;
}
function normalizeMessage(msg) {
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
  return {
    ts,
    wamid: msg.id?._serialized || msg.id?.id || ('live_' + msg.timestamp + '_' + Math.random().toString(36).slice(2, 8)),
    direction,
    msg_type: msgType,
    body,
    sender_name: msg.author || msg._data?.notifyName || '',
    context_id: msg.hasQuotedMsg ? (msg._data?.quotedStanzaID || '') : ''
  };
}
async function postBatch(phone, contactName, messages) {
  if (!messages.length) return null;
  const url = WORKER_URL + '/admin/wa/import-bulk';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
    body: JSON.stringify({ phone, contactName, messages })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// === Main ===
async function main() {
  console.log('📡 NEON · WhatsApp Live Listener');
  console.log('   Worker:', WORKER_URL);
  console.log('   Token cargado (' + TOKEN.slice(0, 10) + '...)');
  console.log('   Stats inicial:', stats);
  console.log('');

  startStatsServer();

  // Buscar Chrome
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser'
  ];
  let chromeExe = process.env.CHROME_PATH || '';
  if (!chromeExe) for (const p of chromePaths) if (fs.existsSync(p)) { chromeExe = p; break; }
  if (!chromeExe) { console.error('❌ Chrome no encontrado'); process.exit(1); }

  stats.status = 'authenticating';
  saveStats();

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wa-session') }),
    puppeteer: {
      headless: true,
      executablePath: chromeExe,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', () => {
    console.log('⚠️ El listener requiere QR (sesión expirada). Corré scrape-wa-history.js primero para autenticar.');
    process.exit(1);
  });
  client.on('authenticated', () => {
    console.log('✅ Autenticado, conectando...');
    stats.status = 'authenticating';
    saveStats();
  });
  client.on('ready', () => {
    console.log('✅ LIVE — escuchando mensajes en tiempo real');
    console.log('   Stats: http://localhost:' + STATS_PORT);
    stats.status = 'live';
    saveStats();
  });
  client.on('disconnected', (reason) => {
    console.log('⚠️ Desconectado:', reason);
    stats.status = 'disconnected';
    saveStats();
  });

  // Handler de mensaje nuevo (inbound + outbound desde el device de Joaco)
  client.on('message_create', async (msg) => {
    try {
      const chat = await msg.getChat();
      if (chat.isGroup || chat.id._serialized.includes('status')) return;
      const phone = await resolvePhone(chat);
      if (!phone || phone.length < 10) return;
      const contactName = (chat.name || chat.pushname || '').trim();
      const normalized = normalizeMessage(msg);
      await postBatch(phone, contactName, [normalized]);
      if (normalized.direction === 'inbound') stats.messagesIn++;
      else stats.messagesOut++;
      stats.lastMsgAt = new Date().toISOString();
      stats.lastMsgFrom = `${contactName || phone} (${normalized.direction})`;
      saveStats();
      const arrow = normalized.direction === 'inbound' ? '📥' : '📤';
      console.log(`${arrow} ${phone} (${contactName || '—'}): ${normalized.body.slice(0, 60).replace(/\n/g, ' ')}`);
    } catch (e) {
      stats.errors++;
      saveStats();
      console.error('❌ Error procesando mensaje:', e.message);
    }
  });

  await client.initialize();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
