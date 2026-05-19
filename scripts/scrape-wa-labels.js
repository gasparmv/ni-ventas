#!/usr/bin/env node
/**
 * scrape-wa-labels.js — Migra ETIQUETAS y NOMBRES DE CONTACTO de WhatsApp
 *                       Business al CRM.
 *
 * Lee:
 *  · client.getLabels() → todas las etiquetas (con color en hexColor)
 *  · label.getChats()   → contactos asignados a cada etiqueta
 *  · chat.name / pushname / contact.name → nombre real del contacto
 *
 * Sube:
 *  · POST /admin/wa/labels/import-bulk   → labels + assignments (replaceAll=true)
 *  · POST /admin/wa/contacts/import-bulk → phone → name
 *
 * Reusa la sesión de .wa-session/ (si no existe, abrir QR como con scrape-wa-history.js).
 *
 * Uso:
 *   node scrape-wa-labels.js
 *
 * Idempotente. Se puede correr todas las veces que quieras.
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const http = require('http');

const WORKER_URL = 'https://ni-ventas-tracker.neoninfinito.workers.dev';
const TOKEN_FILE = path.join(__dirname, '.crm-token');
const CONTACTS_BATCH = 100;

function getToken() {
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (process.env.CRM_TOKEN) return process.env.CRM_TOKEN;
  console.error('❌ No hay token. Setealo en scripts/.crm-token');
  process.exit(1);
}
const TOKEN = getToken();

// Mini QR server (solo se usa si .wa-session/ no tiene sesión válida)
let currentQrDataUrl = '';
let qrStatus = 'waiting';
const QR_PORT = 8765;
function startQrServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head>
      <meta charset="UTF-8"><title>NEON · QR</title>
      <meta http-equiv="refresh" content="3">
      <style>body{background:#0A0A0F;color:#e9edef;font-family:system-ui;text-align:center;padding:30px}
      .qr{background:white;padding:20px;border-radius:14px;display:inline-block;margin:20px}
      h1{color:#8FD4DE}</style>
    </head><body>
      <h1>🏷 Scraper de Etiquetas</h1>
      <div>Estado: ${qrStatus}</div>
      ${currentQrDataUrl && qrStatus === 'waiting' ? `<div class="qr"><img src="${currentQrDataUrl}" width="320"></div>` : '<div style="padding:60px">⏳</div>'}
    </body></html>`);
  });
  server.listen(QR_PORT, '127.0.0.1', () => {
    console.log(`🌐 QR en http://localhost:${QR_PORT}`);
  });
}

async function resolvePhone(chat) {
  const serial = chat?.id?._serialized || '';
  if (serial.endsWith('@c.us')) return chat.id.user;
  const nm = (chat?.name || chat?.pushname || '').trim();
  const m = nm.match(/\+?\s*(\d[\d\s\-()]+)/);
  if (m) {
    const d = m[1].replace(/\D/g, '');
    if (d.length >= 10 && d.length <= 15) return d;
  }
  try {
    const contact = await chat.getContact();
    if (contact?.number) return String(contact.number).replace(/\D/g, '');
    if (contact?.id?.user && /^\d+$/.test(contact.id.user) && contact.id.server === 'c.us') return contact.id.user;
  } catch (_) {}
  return null;
}

// Mejor nombre disponible para mostrar
function resolveDisplayName(chat, contact) {
  // 1. Contact.name (nombre guardado en la agenda del 6573) — el más confiable
  if (contact?.name && contact.name.trim()) return contact.name.trim();
  // 2. Chat.name (nombre que aparece en la lista de WA, puede venir de agenda o ser pushname)
  if (chat?.name && chat.name.trim() && !/^\+?\d[\d\s\-()]*$/.test(chat.name.trim())) {
    return chat.name.trim();
  }
  // 3. pushname (lo que el contacto puso de nombre en su WA)
  if (contact?.pushname && contact.pushname.trim()) return contact.pushname.trim();
  if (chat?.pushname && chat.pushname.trim()) return chat.pushname.trim();
  return '';
}

async function postJson(pathPart, body) {
  const r = await fetch(WORKER_URL + pathPart, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} ${t.slice(0, 200)}`);
  }
  return await r.json();
}

async function main() {
  console.log('🚀 NEON · Scraper de Etiquetas + Nombres');
  console.log('   Worker:', WORKER_URL);

  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
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

  startQrServer();

  client.on('qr', async (qr) => {
    qrStatus = 'waiting';
    try { currentQrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 480 }); } catch (_) {}
    console.log('📱 QR en http://localhost:' + QR_PORT);
  });
  client.on('authenticated', () => { qrStatus = 'authenticated'; console.log('✅ Autenticado'); });
  client.on('auth_failure', (m) => { console.error('❌ Auth failure:', m); process.exit(1); });

  client.on('ready', async () => {
    qrStatus = 'ready';
    console.log('✅ WhatsApp Web listo.');
    try {
      // ====== 1) ETIQUETAS ======
      console.log('');
      console.log('🏷  Leyendo etiquetas...');
      let labels = [];
      try {
        labels = await client.getLabels();
      } catch (e) {
        console.error('   ⚠ getLabels falló:', e.message);
        console.error('   ⚠ Probablemente este número no está en modo WhatsApp Business o no soporta labels.');
      }
      console.log(`   ${labels.length} etiquetas encontradas`);
      labels.forEach((l, i) => {
        console.log(`     ${i + 1}. ${l.name} (${l.hexColor || l.color || '?'})`);
      });

      // ====== 2) ASIGNACIONES (qué chat tiene qué label) ======
      console.log('');
      console.log('🔗 Leyendo asignaciones (qué contacto tiene qué etiqueta)...');
      const assignments = [];
      const phoneToContact = new Map(); // phone → {name, contactName}
      for (const label of labels) {
        let labelChats = [];
        try {
          labelChats = await label.getChats();
        } catch (e) {
          console.log(`   ⚠ Label "${label.name}" → getChats falló: ${e.message}`);
          continue;
        }
        let counted = 0;
        for (const chat of labelChats) {
          if (chat.isGroup) continue;
          const phone = await resolvePhone(chat);
          if (!phone || phone.length < 10 || phone.length > 15) continue;
          assignments.push({ phone, labelName: label.name });
          counted++;
          // Capturar nombre del contacto mientras estamos acá
          if (!phoneToContact.has(phone)) {
            let contact = null;
            try { contact = await chat.getContact(); } catch (_) {}
            const dispName = resolveDisplayName(chat, contact);
            if (dispName) phoneToContact.set(phone, dispName);
          }
        }
        console.log(`   ${label.name} → ${counted} contactos`);
      }

      // ====== 3) NOMBRES DE TODOS LOS CHATS (no solo los etiquetados) ======
      console.log('');
      console.log('👤 Leyendo nombres de TODOS los chats individuales...');
      const allChats = await client.getChats();
      const oneToOne = allChats.filter(c => !c.isGroup && !c.id._serialized.includes('status'));
      console.log(`   ${oneToOne.length} chats individuales`);
      let nameCount = 0;
      for (let i = 0; i < oneToOne.length; i++) {
        const chat = oneToOne[i];
        const phone = await resolvePhone(chat);
        if (!phone || phone.length < 10 || phone.length > 15) continue;
        if (phoneToContact.has(phone)) continue; // ya lo tenemos por label
        let contact = null;
        try { contact = await chat.getContact(); } catch (_) {}
        const dispName = resolveDisplayName(chat, contact);
        if (dispName) {
          phoneToContact.set(phone, dispName);
          nameCount++;
        }
        if ((i + 1) % 50 === 0) {
          process.stdout.write(`\r   Procesados ${i + 1}/${oneToOne.length} (${phoneToContact.size} nombres)...`);
        }
      }
      console.log(`\n   Total: ${phoneToContact.size} nombres únicos`);

      // ====== 4) SUBIR ETIQUETAS + ASIGNACIONES ======
      if (labels.length) {
        console.log('');
        console.log('☁  Subiendo etiquetas + asignaciones al CRM...');
        const labelsBody = labels.map(l => ({
          name: l.name,
          color: (l.hexColor || l.color || '#42a5f5').toString()
        }));
        const res1 = await postJson('/admin/wa/labels/import-bulk', {
          labels: labelsBody,
          assignments,
          replaceAll: true
        });
        console.log(`   → ${res1.labelsCreated} creadas / ${res1.labelsUpdated} actualizadas / ${res1.assignmentsCreated} asignaciones`);
      }

      // ====== 5) SUBIR NOMBRES DE CONTACTOS EN BATCHES ======
      if (phoneToContact.size) {
        console.log('');
        console.log('☁  Subiendo nombres de contactos...');
        const list = Array.from(phoneToContact.entries()).map(([phone, name]) => ({ phone, name }));
        let totalUp = 0;
        for (let i = 0; i < list.length; i += CONTACTS_BATCH) {
          const batch = list.slice(i, i + CONTACTS_BATCH);
          try {
            const res2 = await postJson('/admin/wa/contacts/import-bulk', { contacts: batch });
            totalUp += res2.upserted || 0;
          } catch (e) {
            console.log(`   ⚠ batch ${i}: ${e.message}`);
          }
        }
        console.log(`   → ${totalUp} nombres subidos`);
      }

      console.log('');
      console.log('🎉 DONE');
      console.log('   Refrescá el CRM (Ctrl+Shift+R) para ver los nombres y etiquetas.');
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
