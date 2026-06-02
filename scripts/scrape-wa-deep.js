#!/usr/bin/env node
/**
 * scrape-wa-deep.js — Scrape PROFUNDO de historial.
 *
 * A diferencia de scrape-wa-history.js que hace UN solo fetchMessages,
 * este script hace loops con loadEarlierMessages() para forzar al
 * device principal a sincronizar más historial. Mucho más lento por chat
 * (5-30 seg cada uno) pero trae historial mucho más profundo.
 *
 * Idempotente: INSERT OR IGNORE en wa_messages dedupado por wamid.
 *
 * Uso:
 *   node scrape-wa-deep.js [phone1,phone2,...]
 *
 * Sin argumentos → procesa TODOS los chats individuales.
 * Con phones específicos → solo esos.
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

const WORKER_URL = 'https://ni-ventas-tracker.neoninfinito.workers.dev';
const TOKEN_FILE = path.join(__dirname, '.crm-token');
const PROGRESS_FILE = path.join(__dirname, '.scrape-deep-progress.json');
const BATCH_SIZE = 50;
const INITIAL_LIMIT = 5000;
const LOAD_EARLIER_ITERATIONS = 20; // hasta 20 loops por chat
const SLEEP_BETWEEN_LOADS_MS = 800; // tiempo para que el device responda
const SLEEP_BETWEEN_CHATS_MS = 2000; // entre chats

function getToken() {
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (process.env.CRM_TOKEN) return process.env.CRM_TOKEN;
  console.error('❌ No hay token. Setealo en scripts/.crm-token');
  process.exit(1);
}
const TOKEN = getToken();

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return { processedChats: [], stats: { inserted: 0, duplicates: 0, errors: 0, deepLoads: 0 } };
  return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
}
function saveProgress(p) { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2)); }
let progress = loadProgress();

const specificPhones = process.argv[2] ? process.argv[2].split(',').map(p => p.trim()) : null;

function tsToISO(ts) { return new Date((ts || 0) * 1000).toISOString(); }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
    wamid: msg.id?._serialized || msg.id?.id || ('deep_' + msg.timestamp + '_' + Math.random().toString(36).slice(2, 8)),
    direction,
    msg_type: msgType,
    body,
    sender_name: msg.author || msg._data?.notifyName || '',
    context_id: msg.hasQuotedMsg ? (msg._data?.quotedStanzaID || '') : ''
  };
}

async function postBatch(phone, contactName, messages) {
  if (!messages.length) return { inserted: 0, duplicates: 0, errors: 0 };
  const url = WORKER_URL + '/admin/wa/import-bulk';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
    body: JSON.stringify({ phone, contactName, messages })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function main() {
  console.log('🚀 NEON · Scraper PROFUNDO');
  console.log('   Estrategia: fetchMessages(5000) + loadEarlierMessages × ' + LOAD_EARLIER_ITERATIONS);
  console.log('   Progreso previo:', progress.processedChats.length, 'chats');
  if (specificPhones) console.log('   Solo procesar:', specificPhones.join(', '));
  console.log('');

  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome'
  ];
  let chromeExe = process.env.CHROME_PATH || '';
  if (!chromeExe) for (const p of chromePaths) if (fs.existsSync(p)) { chromeExe = p; break; }
  if (!chromeExe) { console.error('❌ Chrome no encontrado'); process.exit(1); }

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wa-session') }),
    puppeteer: {
      headless: true,
      executablePath: chromeExe,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', () => {
    console.error('❌ Sesión expirada. Corré scrape-wa-history.js primero para autenticar.');
    process.exit(1);
  });
  client.on('authenticated', () => console.log('✅ Autenticado'));
  client.on('ready', async () => {
    console.log('✅ WhatsApp Web listo. Listando chats...');
    try {
      let chats = await client.getChats();
      chats = chats.filter(c => !c.isGroup && !c.id._serialized.includes('status'));

      if (specificPhones) {
        // Filtrar resolviendo phone real de cada chat (puede ser LID)
        const filtered = [];
        for (const c of chats) {
          const resolved = await resolvePhone(c);
          if (resolved && specificPhones.some(p => resolved.includes(p))) {
            filtered.push(c);
          }
        }
        chats = filtered;
      }

      console.log(`📋 ${chats.length} chats a procesar`);
      console.log('');

      let chatIdx = 0;
      for (const chat of chats) {
        chatIdx++;
        const phone = await resolvePhone(chat);
        if (!phone || phone.length < 10 || phone.length > 15) {
          console.log(`  [${chatIdx}/${chats.length}] SKIP: phone inválido`);
          continue;
        }
        if (progress.processedChats.includes(phone)) {
          console.log(`  [${chatIdx}/${chats.length}] SKIP: ${phone} ya procesado`);
          continue;
        }
        const contactName = (chat.name || chat.pushname || '').trim();
        process.stdout.write(`  [${chatIdx}/${chats.length}] 🔍 ${phone} (${contactName || '-'})...`);

        try {
          // 1. Carga inicial
          let allMessages = await chat.fetchMessages({ limit: INITIAL_LIMIT });
          let lastCount = allMessages.length;
          process.stdout.write(` inicial=${lastCount}`);

          // 2. Loops de loadEarlierMessages para forzar carga profunda
          let deepLoadsUsed = 0;
          for (let i = 0; i < LOAD_EARLIER_ITERATIONS; i++) {
            try {
              // loadEarlierMessages devuelve los mensajes ANTERIORES, no acumulado
              const earlier = await chat.loadEarlierMessages();
              if (!earlier || earlier.length === 0) break;
              deepLoadsUsed++;
              // Combinar y deduplicar por id
              const seenIds = new Set(allMessages.map(m => m.id?._serialized));
              for (const m of earlier) if (!seenIds.has(m.id?._serialized)) allMessages.push(m);
              if (allMessages.length === lastCount) break; // no creció, paramos
              lastCount = allMessages.length;
              await sleep(SLEEP_BETWEEN_LOADS_MS);
            } catch (_) {
              break;
            }
          }
          progress.stats.deepLoads += deepLoadsUsed;
          process.stdout.write(` deep=${deepLoadsUsed} total=${allMessages.length}`);

          // 3. Normalizar y enviar
          const normalized = allMessages.map(normalizeMessage).filter(m => m.body || m.msg_type !== 'text');
          let inserted = 0, duplicates = 0, errors = 0;
          for (let i = 0; i < normalized.length; i += BATCH_SIZE) {
            const batch = normalized.slice(i, i + BATCH_SIZE);
            try {
              const res = await postBatch(phone, contactName, batch);
              inserted += res.inserted || 0;
              duplicates += res.duplicates || 0;
              errors += res.errors || 0;
            } catch (e) {
              errors += batch.length;
            }
          }
          progress.stats.inserted += inserted;
          progress.stats.duplicates += duplicates;
          progress.stats.errors += errors;
          console.log(` → ${inserted} nuevos / ${duplicates} dup / ${errors} err`);

          progress.processedChats.push(phone);
          saveProgress(progress);
          await sleep(SLEEP_BETWEEN_CHATS_MS);
        } catch (e) {
          console.log(` ❌ error: ${e.message}`);
        }
      }

      console.log('');
      console.log('🎉 DEEP SCRAPE DONE');
      console.log(`   Chats procesados: ${progress.processedChats.length}`);
      console.log(`   Mensajes insertados: ${progress.stats.inserted}`);
      console.log(`   Mensajes duplicados: ${progress.stats.duplicates}`);
      console.log(`   Errores: ${progress.stats.errors}`);
      console.log(`   loadEarlierMessages calls: ${progress.stats.deepLoads}`);

      try { fs.unlinkSync(PROGRESS_FILE); } catch (_) {}
      process.exit(0);
    } catch (e) {
      console.error('❌ Error general:', e.message);
      process.exit(1);
    }
  });

  await client.initialize();
}

main().catch(e => { console.error(e); process.exit(1); });
