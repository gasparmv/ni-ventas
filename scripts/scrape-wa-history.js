#!/usr/bin/env node
/**
 * scrape-wa-history.js — Importa todo el historial accesible de WhatsApp Web
 *                        del 6573 a la base wa_messages del CRM.
 *
 * Uso:
 *   1. cd scripts/ && npm install
 *   2. node scrape-wa-history.js
 *   3. Escanear el QR que aparece en la terminal con WhatsApp Business
 *      del celular del 6573 (Ajustes → Dispositivos vinculados → Vincular dispositivo).
 *   4. Esperar. El script logea progreso. Total esperado: 1-4 horas según volumen.
 *
 * Requiere: Node 18+ · Chrome instalado en la PC (whatsapp-web.js lo lanza headless).
 *
 * Idempotente: corre el INSERT OR IGNORE en wa_messages dedupado por wamid.
 * Si lo corrés 2 veces no duplica nada, solo re-procesa.
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerm = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const http = require('http');

// === Mini HTTP server local para mostrar el QR como imagen PNG ===
// Joaco abre http://localhost:8765 y escanea el QR de ahí, mucho más fácil
// que desde una consola ASCII.
let currentQrDataUrl = '';
let qrStatus = 'waiting'; // waiting | scanned | authenticated | ready
const QR_PORT = 8765;
function startQrServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head>
      <meta charset="UTF-8">
      <title>NEON · QR de WhatsApp</title>
      <meta http-equiv="refresh" content="3">
      <style>
        body { background:#0A0A0F; color:#e9edef; font-family:-apple-system,system-ui,sans-serif; display:flex; flex-direction:column; align-items:center; padding:30px; }
        h1 { background:linear-gradient(135deg,#FF1830,#8FD4DE); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
        .qr { background:white; padding:20px; border-radius:14px; margin:20px 0; }
        .status { padding:10px 20px; border-radius:8px; background:#18181f; border:1px solid #2a2a35; font-family:ui-monospace,monospace; }
        .status.waiting { color:#FFA726; }
        .status.scanned { color:#8FD4DE; }
        .status.authenticated, .status.ready { color:#25D366; }
        .info { color:rgba(233,237,239,.6); font-size:13px; max-width:480px; text-align:center; line-height:1.5; }
        .info b { color:#8FD4DE; }
      </style>
    </head><body>
      <h1>🔗 Vincular WhatsApp Business</h1>
      <div class="status ${qrStatus}">Estado: ${qrStatus === 'waiting' ? 'Esperando escaneo...' : qrStatus === 'scanned' ? 'QR Escaneado, autenticando...' : qrStatus === 'authenticated' ? '✓ Autenticado' : '✓ Listo, scrapeando...'}</div>
      ${currentQrDataUrl && qrStatus === 'waiting' ? `<div class="qr"><img src="${currentQrDataUrl}" width="320" height="320"></div>` : '<div style="padding:60px">⏳ Generando QR...</div>'}
      <div class="info">
        <b>Joaco en el celular del 6573:</b><br>
        WhatsApp Business → Ajustes → <b>Dispositivos vinculados</b> → Vincular un dispositivo → escaneá el QR de esta pantalla.<br><br>
        Esta página se refresca sola cada 3 segundos.
      </div>
    </body></html>`);
  });
  server.listen(QR_PORT, '127.0.0.1', () => {
    console.log(`🌐 QR disponible en http://localhost:${QR_PORT}`);
    console.log(`   Abrilo en Chrome de tu PC y mostrá esa pantalla a Joaco.`);
  });
  return server;
}

// === CONFIG ===
const WORKER_URL = 'https://ni-ventas-tracker.neoninfinito.workers.dev';
const TOKEN_FILE = path.join(__dirname, '.crm-token');
const PROGRESS_FILE = path.join(__dirname, '.scrape-progress.json');
const BATCH_SIZE = 50; // mensajes por POST al worker
const MAX_MESSAGES_PER_CHAT = 5000; // límite de mensajes a bajar por chat
const SCROLL_DELAY_MS = 500; // delay entre scrolls para que WA cargue más
const CHAT_DELAY_MS = 1500; // delay entre chats para no rate-limit

// === Cargar/pedir token de admin (Gaspar) ===
function getToken() {
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const tok = process.env.CRM_TOKEN;
  if (tok) { fs.writeFileSync(TOKEN_FILE, tok); return tok; }
  console.error('❌ No hay token. Setealo así:');
  console.error('   echo "tu_token_de_gaspar" > scripts/.crm-token');
  console.error('   O exportá CRM_TOKEN=... en el environment');
  console.error('');
  console.error('Para obtener el token: andá al CRM, logueate como Gaspar, abrí DevTools → Application → Local Storage → "auth_token"');
  process.exit(1);
}
const TOKEN = getToken();

// === Cargar/guardar progreso (chats ya procesados, para retomar si se corta) ===
function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return { processedChats: [], stats: { inserted: 0, duplicates: 0, errors: 0 } };
  return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
}
function saveProgress(p) { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2)); }
let progress = loadProgress();

// === Helpers ===
function normalizePhone(waId) {
  // waId formato '5491155604999@c.us' → '5491155604999'
  return String(waId || '').replace(/@.*$/, '').replace(/\D/g, '');
}

// Resuelve el número real de un chat. WhatsApp ahora usa LID (identificador
// interno) para algunos contactos, en lugar del número directo. Probamos:
//   1. Si el waId termina en @c.us → el user ES el número (formato viejo)
//   2. Si termina en @lid → buscamos en chat.name si tiene formato +54... etc
//   3. Si no, llamamos getContact() y vemos el number/id.user real
async function resolvePhone(chat) {
  const serial = chat.id?._serialized || '';
  if (serial.endsWith('@c.us')) {
    return chat.id.user; // formato clásico, es el número
  }
  // LID — buscar en el nombre del chat si tiene número embebido
  const nm = (chat.name || chat.pushname || '').trim();
  const matchPlus = nm.match(/\+?\s*(\d[\d\s\-()]+)/);
  if (matchPlus) {
    const digits = matchPlus[1].replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) return digits;
  }
  // Último recurso: getContact y leer el number
  try {
    const contact = await chat.getContact();
    if (contact?.number) return String(contact.number).replace(/\D/g, '');
    if (contact?.id?.user && /^\d+$/.test(contact.id.user) && contact.id.server === 'c.us') {
      return contact.id.user;
    }
  } catch (_) {}
  return null;
}
function tsToISO(ts) {
  // ts viene como Unix seconds
  return new Date((ts || 0) * 1000).toISOString();
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function postBatch(phone, contactName, messages) {
  if (!messages.length) return { inserted: 0, duplicates: 0, errors: 0 };
  const url = WORKER_URL + '/admin/wa/import-bulk';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
    body: JSON.stringify({ phone, contactName, messages })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return await res.json();
}

// Normaliza un mensaje de whatsapp-web.js al formato que entiende el endpoint
function normalizeMessage(msg) {
  const ts = tsToISO(msg.timestamp);
  const direction = msg.fromMe ? 'outbound' : 'inbound';
  // Tipo
  let msgType = 'text';
  if (msg.type === 'image') msgType = 'image';
  else if (msg.type === 'audio' || msg.type === 'ptt') msgType = 'audio';
  else if (msg.type === 'video') msgType = 'video';
  else if (msg.type === 'document') msgType = 'document';
  else if (msg.type === 'sticker') msgType = 'sticker';
  else if (msg.type === 'location') msgType = 'location';
  else if (msg.type === 'vcard' || msg.type === 'multi_vcard') msgType = 'contact';
  else if (msg.type === 'revoked') msgType = 'revoke';
  // Body
  let body = String(msg.body || '');
  // Para media sin caption, marcamos placeholder
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
    wamid: msg.id?._serialized || msg.id?.id || ('scraped_' + msg.timestamp + '_' + Math.random().toString(36).slice(2, 8)),
    direction,
    msg_type: msgType,
    body,
    sender_name: msg.author || msg._data?.notifyName || '',
    context_id: msg.hasQuotedMsg ? (msg._data?.quotedStanzaID || '') : ''
  };
}

// === Main ===
async function main() {
  console.log('🚀 NEON · Scraper de WhatsApp History');
  console.log('   Worker:', WORKER_URL);
  console.log('   Token cargado (' + TOKEN.slice(0, 10) + '...)');
  console.log('   Progreso previo:', progress.processedChats.length, 'chats ya procesados');
  console.log('');

  // Buscar Chrome instalado en el sistema (Windows / Mac / Linux)
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser'
  ];
  let chromeExe = process.env.CHROME_PATH || '';
  if (!chromeExe) {
    for (const p of chromePaths) {
      if (fs.existsSync(p)) { chromeExe = p; break; }
    }
  }
  if (!chromeExe) {
    console.error('❌ No se encontró Chrome instalado. Instalá Google Chrome o setea CHROME_PATH.');
    process.exit(1);
  }
  console.log('   Chrome:', chromeExe);

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wa-session') }),
    puppeteer: {
      headless: true,
      executablePath: chromeExe,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  startQrServer();

  client.on('qr', async (qr) => {
    qrStatus = 'waiting';
    try {
      currentQrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 480, errorCorrectionLevel: 'L' });
    } catch (_) {}
    console.log('📱 QR actualizado · http://localhost:' + QR_PORT);
  });

  client.on('loading_screen', () => { qrStatus = 'scanned'; });
  client.on('authenticated', () => { qrStatus = 'authenticated'; console.log('✅ Autenticado'); });
  client.on('auth_failure', (msg) => {
    console.error('❌ Falla de auth:', msg);
    process.exit(1);
  });

  client.on('ready', async () => {
    qrStatus = 'ready';
    console.log('✅ WhatsApp Web listo. Listando chats...');
    try {
      const chats = await client.getChats();
      console.log(`📋 ${chats.length} chats encontrados.`);
      console.log('');

      // Filtrar grupos y status (solo chats 1:1)
      const oneToOne = chats.filter(c => !c.isGroup && !c.id._serialized.includes('status'));
      console.log(`🎯 ${oneToOne.length} chats individuales para procesar (excl. grupos y status).`);
      console.log('');

      let chatIdx = 0;
      for (const chat of oneToOne) {
        chatIdx++;
        const phone = await resolvePhone(chat);
        if (!phone || phone.length < 10 || phone.length > 15) {
          console.log(`  [${chatIdx}/${oneToOne.length}] SKIP: phone inválido (${chat.id._serialized} · name="${chat.name || chat.pushname || '?'}")`);
          continue;
        }
        if (progress.processedChats.includes(phone)) {
          console.log(`  [${chatIdx}/${oneToOne.length}] SKIP: ${phone} ya procesado`);
          continue;
        }
        const contactName = (chat.name || chat.pushname || '').trim();
        console.log(`  [${chatIdx}/${oneToOne.length}] 📥 ${phone} (${contactName || 'sin nombre'})...`);

        try {
          const messages = await chat.fetchMessages({ limit: MAX_MESSAGES_PER_CHAT });
          if (!messages.length) {
            console.log(`     · Sin mensajes`);
            progress.processedChats.push(phone);
            saveProgress(progress);
            continue;
          }
          // Normalizar y mandar en batches
          const normalized = messages.map(normalizeMessage).filter(m => m.body || m.msg_type !== 'text');
          let inserted = 0, duplicates = 0, errors = 0;
          for (let i = 0; i < normalized.length; i += BATCH_SIZE) {
            const batch = normalized.slice(i, i + BATCH_SIZE);
            try {
              const res = await postBatch(phone, contactName, batch);
              inserted += res.inserted || 0;
              duplicates += res.duplicates || 0;
              errors += res.errors || 0;
            } catch (e) {
              console.log(`     ⚠ Error en batch ${i}/${normalized.length}: ${e.message}`);
              errors += batch.length;
            }
          }
          progress.stats.inserted += inserted;
          progress.stats.duplicates += duplicates;
          progress.stats.errors += errors;
          console.log(`     ✓ ${messages.length} mensajes leídos · ${inserted} insertados · ${duplicates} duplicados · ${errors} errores`);

          progress.processedChats.push(phone);
          saveProgress(progress);
          await sleep(CHAT_DELAY_MS);
        } catch (e) {
          console.log(`     ❌ Error procesando chat: ${e.message}`);
        }
      }

      console.log('');
      console.log('🎉 DONE');
      console.log(`   Chats procesados: ${progress.processedChats.length}`);
      console.log(`   Mensajes insertados: ${progress.stats.inserted}`);
      console.log(`   Mensajes duplicados (ya en CRM): ${progress.stats.duplicates}`);
      console.log(`   Errores: ${progress.stats.errors}`);

      // Reset progress file al terminar
      fs.unlinkSync(PROGRESS_FILE);
      console.log('');
      console.log('   Para correr de nuevo limpio: borrá scripts/.wa-session/');
      process.exit(0);
    } catch (e) {
      console.error('❌ Error general:', e.message);
      console.error(e.stack);
      process.exit(1);
    }
  });

  await client.initialize();
}

main().catch(e => { console.error(e); process.exit(1); });
