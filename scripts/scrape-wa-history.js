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
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

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

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wa-session') }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', (qr) => {
    console.log('📱 Escaneá el QR con WhatsApp Business del celular del 6573:');
    console.log('   (Ajustes → Dispositivos vinculados → Vincular un dispositivo)');
    console.log('');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => console.log('✅ Autenticado'));
  client.on('auth_failure', (msg) => {
    console.error('❌ Falla de auth:', msg);
    process.exit(1);
  });

  client.on('ready', async () => {
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
        const phone = normalizePhone(chat.id._serialized);
        if (!phone || phone.length < 10) {
          console.log(`  [${chatIdx}/${oneToOne.length}] SKIP: phone inválido (${chat.id._serialized})`);
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
