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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
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

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
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

// === BUSINESS PANEL: parsing helpers ===
function parseCsvLine(line) {
  // Mini parser: respeta " " quotes y comas internas. Sheets gviz devuelve
  // valores "quoteados" siempre, así que es seguro.
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i+1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}
function parseCsv(csv) {
  if (!csv) return [];
  // Sheets gviz puede meter \n dentro de campos quoteados; reglas estrictas requieren parser estado.
  const rows = [];
  let cur = '', inQ = false, row = [];
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (inQ && csv[i+1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      row.push(cur); cur = '';
    } else if ((c === '\n' || c === '\r') && !inQ) {
      if (c === '\r' && csv[i+1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else {
      cur += c;
    }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
// Convierte "13.832k", "$175.000", "954.251", "(5.097k)", "63%", "-" → number.
// Sheet usa . como separador de miles (formato AR) y k como sufijo de miles.
function parseAmt(s) {
  if (s == null) return 0;
  const x = String(s).trim();
  if (!x || x === '-' || x === '—') return 0;
  let neg = false;
  let v = x;
  if (v.startsWith('(') && v.endsWith(')')) { neg = true; v = v.slice(1, -1); }
  if (v.startsWith('-')) { neg = true; v = v.slice(1); }
  v = v.replace(/[$\s]/g, '');
  let mult = 1;
  if (v.endsWith('k') || v.endsWith('K')) { mult = 1000; v = v.slice(0, -1); }
  if (v.endsWith('M')) { mult = 1000000; v = v.slice(0, -1); }
  if (v.endsWith('%')) { v = v.slice(0, -1); }
  // formato AR: punto = miles, coma = decimal
  if (v.includes(',')) {
    v = v.replace(/\./g, '').replace(',', '.');
  } else {
    // Si tiene un solo punto y los dígitos después son ≤ 2 → decimal; sino es separador de miles
    const m = v.match(/\.(\d+)$/);
    if (!m || m[1].length === 3) v = v.replace(/\./g, '');
  }
  const n = parseFloat(v);
  if (isNaN(n)) return 0;
  return (neg ? -1 : 1) * n * mult;
}
// dd/MM/yyyy o d/M/yyyy → ISO 'yyyy-MM-dd'
function parseDateAR(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const d = m[1].padStart(2, '0');
  const mo = m[2].padStart(2, '0');
  return `${m[3]}-${mo}-${d}`;
}
// Filtro: cliente "neon" / "NEON" no cuenta como cliente real (es uso interno
// del negocio, no facturación). Decidido en sección 15A del Cerebro NI.
function isInternalNeon(name) {
  if (!name) return false;
  const n = String(name).trim().toLowerCase();
  return n === 'neon' || n === 'neón' || n === 'neon infinito' || n === 'neoninfinito';
}

function parsePanelData({ pnlCsv, dirCsv, disCsv, insCsv, curCsv }) {
  // ---- PnL: matriz mes × concepto (cols D-O = ene-dic, fila 3+ con conceptos en col C) ----
  const pnlRows = parseCsv(pnlCsv);
  // Filas relevantes: 3=TOTAL INGRESOS, 4=Carteles Directo, 5=Carteles Distris, 6=Insumos, 7=Cursos,
  // 8=TOTAL COSTOS, 9=Carteles Directo costos, 10=Distris costos, 11=Insumos costos, 12=Cursos costos,
  // 13=Fijos, 14=TOTAL CMA, 15=TOTAL CMA %
  const monthCol = (m) => 3 + (m - 1); // mes 1 → col D (idx 3)
  const pickRow = (idx) => pnlRows[idx] || [];
  const pnl = [];
  for (let m = 1; m <= 12; m++) {
    const c = monthCol(m);
    pnl.push({
      month: m,
      ingresos: {
        total: parseAmt(pickRow(2)[c]),
        directo: parseAmt(pickRow(3)[c]),
        distris: parseAmt(pickRow(4)[c]),
        insumos: parseAmt(pickRow(5)[c]),
        cursos: parseAmt(pickRow(6)[c]),
      },
      costos: {
        total: parseAmt(pickRow(7)[c]),
        directo: parseAmt(pickRow(8)[c]),
        distris: parseAmt(pickRow(9)[c]),
        insumos: parseAmt(pickRow(10)[c]),
        cursos: parseAmt(pickRow(11)[c]),
        fijos: parseAmt(pickRow(12)[c]),
      },
      margen: parseAmt(pickRow(13)[c]),
      margenPct: parseAmt(pickRow(14)[c]),
    });
  }
  // ---- Pedidos_Directo: cada fila = una venta ----
  // Cols: 0=ID, 1=Fecha, 2=Canal, 3=Nombre, 4=Cantidad, 14=VENTA PRECIO, 15=PRECIO DIMMER,
  //       16=COSTOS ENVIO, 17=MATERIAL, 18=FUENTE, 19=DIMMER, 20=NEON, 21=MO, 22=JOAQUIN, 23=ANIBAL, 24=EMMA, 25=Caja
  const dirRows = parseCsv(dirCsv).slice(1);
  const directo = [];
  for (const r of dirRows) {
    const fecha = parseDateAR(r[1]);
    const venta = parseAmt(r[14]) + parseAmt(r[15]);
    if (!fecha || !venta) continue;
    if (isInternalNeon(r[3])) continue; // skip uso interno
    directo.push({
      id: (r[0] || '').trim(),
      fecha,
      cliente: (r[3] || '').trim(),
      cant: parseAmt(r[4]) || 1,
      venta,
      costos: {
        envio: parseAmt(r[16]),
        material: parseAmt(r[17]),
        fuente: parseAmt(r[18]),
        dimmer: parseAmt(r[19]),
        neon: parseAmt(r[20]),
        mo: parseAmt(r[21]),
        joaquin: parseAmt(r[22]),
        anibal: parseAmt(r[23]),
        emma: parseAmt(r[24]),
      },
      caja: (r[25] || '').trim(),
    });
  }
  // ---- Pedidos_Distris: igual pero sin PRODUCTOR ----
  // Cols: 0=ID,1=Fecha,2=Canal,3=Nombre,4=Cantidad,13=VENTA PRECIO,14=PRECIO DIMMER,
  //       15=COSTOS ENVIO,16=MATERIAL,17=FUENTE,18=DIMMER,19=NEON,20=MO,21=JOAQUIN,22=ANIBAL,23=EMMA,24=Caja
  const disRows = parseCsv(disCsv).slice(1);
  const distris = [];
  for (const r of disRows) {
    const fecha = parseDateAR(r[1]);
    const venta = parseAmt(r[13]) + parseAmt(r[14]);
    if (!fecha || !venta) continue;
    if (isInternalNeon(r[3])) continue; // skip uso interno
    distris.push({
      id: (r[0] || '').trim(),
      fecha,
      cliente: (r[3] || '').trim(),
      cant: parseAmt(r[4]) || 1,
      venta,
      costos: {
        envio: parseAmt(r[15]),
        material: parseAmt(r[16]),
        fuente: parseAmt(r[17]),
        dimmer: parseAmt(r[18]),
        neon: parseAmt(r[19]),
        mo: parseAmt(r[20]),
      },
      caja: (r[24] || '').trim(),
    });
  }
  // ---- Venta_Insumos: 0=ID,1=FECHA,3=PRODUCTO,4=DISEÑO,5=ANCHO,6=ALTO,7=CANTIDAD,8=Pago,9=Precio,
  //                    10=Emma,11=Anibal,12=Material,13=Margen,14=%,15=Mes,16=Año,17=Caja
  const insRows = parseCsv(insCsv).slice(2);
  const insumos = [];
  for (const r of insRows) {
    const fecha = parseDateAR(r[1]);
    const venta = parseAmt(r[9]);
    if (!fecha || !venta) continue;
    // En Venta_Insumos el "cliente" está en col C (idx 2) — NO en col D.
    // Filtramos uso interno (mencionado explícito en cerebro sección 15A).
    if (isInternalNeon(r[2])) continue;
    insumos.push({
      id: (r[0] || '').trim(),
      fecha,
      cliente: (r[2] || '').trim(),
      producto: (r[3] || '').trim(),
      diseno: (r[4] || '').trim(),
      cant: parseAmt(r[7]) || 1,
      venta,
      costo: parseAmt(r[10]) + parseAmt(r[11]) + parseAmt(r[12]),
      margen: parseAmt(r[13]),
      caja: (r[17] || '').trim(),
    });
  }
  // ---- CURSOS: 0=Fecha,1=Nro orden,2=Alumno,3=Seña,4=Importe Restante,5=Vendido,
  //              6=Medio de pago,7=Producto,10=Importe MP,11=ComisionMP,15=Caja
  const curRows = parseCsv(curCsv).slice(1);
  const cursos = [];
  for (const r of curRows) {
    const fecha = parseDateAR(r[0]);
    const venta = parseAmt(r[5]);
    if (!fecha || !venta) continue;
    cursos.push({
      fecha,
      orden: (r[1] || '').trim(),
      alumno: (r[2] || '').trim(),
      vendido: venta,
      medio: (r[6] || '').trim(),
      producto: (r[7] || '').trim(),
      comisionMp: parseAmt(r[11]),
      caja: (r[15] || '').trim(),
    });
  }
  return { pnl, directo, distris, insumos, cursos };
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

// ===== Render hiperrealista con Gemini (image-to-image) =====
// Prompt fijo del negocio para generar el render del cartel de neón a partir
// del boceto vectorizado de cotización.
const GEMINI_RENDER_PROMPT = 'Creame un render hiperrealista de un Cartel de Neon LED hecho con una manguera de silicona de 6 mm de espesor (con base plana y frente en forma de media caña), a partir de este boceto de cotización vectorizado. El diseño debe respetar exactamente los colores de la imagen proporcionada. El neón debe seguir el contorno del diseño con presición. Debe incluir el contorno de base de acrilico';

// Modelo de generación de imágenes de Gemini (Nano Banana). Configurable por env
// por si cambia el nombre; default al actual.
function geminiImageModel(env) {
  // gemini-3-pro-image = mejor calidad (render que va al cliente).
  // Alternativas más rápidas/baratas: gemini-3.1-flash-image, gemini-2.5-flash-image.
  return env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image';
}

// ArrayBuffer → base64 en chunks (evita stack overflow con imágenes grandes).
function abToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Toma el boceto (bytes + mime) + medidas, llama a Gemini, devuelve { ok, base64, mime }
// con la imagen generada, o { error }.
async function generarRenderConGemini(env, bocetoBuf, bocetoMime, extraTexto) {
  if (!env.GEMINI_API_KEY) return { error: 'GEMINI_API_KEY no configurada' };
  const model = geminiImageModel(env);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  const promptText = GEMINI_RENDER_PROMPT + (extraTexto ? `\n\n${extraTexto}` : '');
  const body = {
    contents: [{
      parts: [
        { text: promptText },
        { inline_data: { mime_type: bocetoMime || 'image/png', data: abToBase64(bocetoBuf) } }
      ]
    }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
  };
  let resp;
  try {
    resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    return { error: 'fetch a Gemini falló: ' + e.message };
  }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json())?.error?.message || ''; } catch(e) {}
    return { error: `Gemini HTTP ${resp.status}${detail ? ': ' + detail : ''}` };
  }
  let data;
  try { data = await resp.json(); } catch (e) { return { error: 'respuesta de Gemini no es JSON' }; }
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inlineData || p.inline_data);
  const inline = imgPart?.inlineData || imgPart?.inline_data;
  if (!inline || !inline.data) {
    // A veces devuelve solo texto (rechazo / safety). Lo reportamos.
    const txt = parts.find(p => p.text)?.text || 'sin imagen en la respuesta';
    return { error: 'Gemini no devolvió imagen: ' + txt.slice(0, 200) };
  }
  return { ok: true, base64: inline.data, mime: inline.mimeType || inline.mime_type || 'image/png' };
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
                const contextId = msg.context?.id || msg.reaction?.message_id || '';
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
      const userSlug = String(user).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      // Alias: el frontend manda "Joaquín" (slug 'joaquin'); en users_panel puede
      // estar como 'joaco' o 'joaquin'. Buscamos por cualquiera de los dos.
      const lookupIds = userSlug === 'joaquin' ? ['joaquin', 'joaco']
                      : userSlug === 'joaco'   ? ['joaco', 'joaquin']
                      : [userSlug];
      const placeholders = lookupIds.map(() => '?').join(',');
      const panelUser = await env.DB.prepare(
        `SELECT id, rol, password_hash FROM users_panel WHERE id IN (${placeholders}) AND activo = 1 LIMIT 1`
      ).bind(...lookupIds).first();

      const isAdminUser = userSlug === 'gaspar' || (panelUser && panelUser.rol === 'admin');

      if (isAdminUser) {
        // Gaspar: contraseña en env.ADMIN_PASSWORD.
        if (!password) return json({ error: 'missing fields' }, 400);
        if (!env.ADMIN_PASSWORD) return json({ error: 'server not configured' }, 500);
        if (password !== env.ADMIN_PASSWORD) {
          await new Promise(r => setTimeout(r, 250));
          return unauthorized('credenciales inválidas');
        }
      } else if (panelUser && panelUser.password_hash) {
        // Comercial / diseñador con password: validar hash SHA-256.
        if (!password) return json({ error: 'missing fields' }, 400);
        const inputHash = await sha256hex(password);
        if (inputHash !== panelUser.password_hash) {
          await new Promise(r => setTimeout(r, 250));
          return unauthorized('credenciales inválidas');
        }
      } else if (panelUser) {
        // Usuario existe pero sin password configurada → entra sin password (legacy).
      } else {
        // Usuario desconocido.
        await new Promise(r => setTimeout(r, 250));
        return unauthorized('usuario desconocido');
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

      // Defensa en profundidad: endpoints con datos sensibles (P&L, márgenes,
      // actividad global) requieren que la sesión sea del admin (Gaspar), no
      // cualquier token válido de bajo privilegio.
      const sessionUserKey = String(session.user || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const isAdminSession = sessionUserKey === 'gaspar';
      const ADMIN_ONLY_PATHS = ['/admin/business-panel', '/admin/activity'];
      if (ADMIN_ONLY_PATHS.includes(path) && !isAdminSession) {
        return json({ error: 'forbidden: admin only' }, 403);
      }

      if (request.method === 'GET' && path === '/admin/activity') {
        return reportHandler(env, url, true);
      }

      if (request.method === 'POST' && path === '/admin/wa/send') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { to, body: text, reply_to } = body || {};
        if (!to || !text) return json({ error: 'missing fields (to, body)' }, 400);
        const num = normalizeArPhone(to);
        // Si reply_to viene, incluimos context.message_id para que WA lo muestre como cita.
        const payload = { messaging_product: 'whatsapp', to: num || to, type: 'text', text: { body: String(text) } };
        if (reply_to) payload.context = { message_id: reply_to };
        const r = await waSend(env, payload);
        await logWaEvent(env, { to, kind: 'text', ref: reply_to || '', ok: r.ok, messageId: r.id, error: r.error });
        if (!r.ok) return json({ error: r.error, raw: r.raw }, r.status || 500);
        try {
          await env.DB.prepare(
            'INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(new Date().toISOString(), r.id || '', 'outbound', num || to, '', 'text', String(text), '', reply_to || '', 'sent').run();
        } catch (_) {}
        return json({ id: r.id });
      }

      if (request.method === 'POST' && path === '/admin/wa/template') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { to, name, lang, params } = body || {};
        if (!to || !name) return json({ error: 'missing fields (to, name)' }, 400);
        const num = normalizeArPhone(to);
        const r = await waSendTemplate(env, to, name, lang || 'es', Array.isArray(params) ? params : []);
        await logWaEvent(env, { to, kind: 'template:' + name, ref: '', ok: r.ok, messageId: r.id, error: r.error });
        if (!r.ok) return json({ error: r.error, raw: r.raw }, r.status || 500);
        // Guardar en wa_messages para que aparezca en el chat
        try {
          const previewBody = `[plantilla: ${name}]${Array.isArray(params) && params.length ? ' ' + params.join(', ') : ''}`;
          await env.DB.prepare(
            'INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(new Date().toISOString(), r.id || '', 'outbound', num || to, '', 'template', previewBody, '', '', 'sent').run();
        } catch (_) {}
        return json({ id: r.id });
      }

      // ===== FULL-TEXT SEARCH del chat WA =====
      // Busca en body de mensajes, sender_name y phone. Devuelve:
      // - contacts: lista de phones que tienen mensajes que matchean
      // - messages: mensajes individuales que matchean con preview
      if (request.method === 'GET' && path === '/admin/wa/search') {
        const q = (url.searchParams.get('q') || '').trim();
        if (q.length < 2) return json({ contacts: [], messages: [] });
        // SQLite LIKE es case-insensitive para ASCII por default con NOCASE,
        // pero acá normalizamos a lowercase para consistencia.
        const qLower = q.toLowerCase();
        const like = '%' + qLower + '%';

        // Contactos: phones únicos cuyos mensajes contienen el query.
        // También matchea si el query es parte del phone (para buscar por número).
        const contactsQ = await env.DB.prepare(
          `SELECT phone, COUNT(*) AS hits, MAX(ts) AS last_match_ts,
                  MAX(CASE WHEN LOWER(sender_name) != '' THEN sender_name END) AS contact_name
           FROM wa_messages
           WHERE LOWER(body) LIKE ?
              OR LOWER(sender_name) LIKE ?
              OR phone LIKE ?
           GROUP BY phone
           ORDER BY last_match_ts DESC
           LIMIT 50`
        ).bind(like, like, like).all();

        // Mensajes individuales: top 50 mensajes recientes que matchean.
        const messagesQ = await env.DB.prepare(
          `SELECT ts, phone, sender_name, direction, msg_type, body, wamid
           FROM wa_messages
           WHERE LOWER(body) LIKE ?
           ORDER BY ts DESC
           LIMIT 50`
        ).bind(like).all();

        return json({
          q,
          contacts: contactsQ.results || [],
          messages: messagesQ.results || []
        });
      }

      // ===== BULK IMPORT de historial de WA (scrape via whatsapp-web.js) =====
      // El script scrape-wa-history.js corre en la PC del usuario y manda
      // batches de mensajes acá. Inserta con OR IGNORE para dedup por wamid.
      if (request.method === 'POST' && path === '/admin/wa/import-bulk') {
        if (session.user !== 'Gaspar') return json({ error: 'forbidden' }, 403);
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { phone, messages, contactName } = body || {};
        if (!phone || !Array.isArray(messages)) return json({ error: 'missing phone or messages[]' }, 400);
        const num = normalizeArPhone(phone) || phone;
        let inserted = 0, duplicates = 0, skipped = 0, errors = 0, mediaBackfilled = 0;
        for (const m of messages) {
          try {
            // Normalizar
            const ts = m.ts || new Date().toISOString();
            const wamid = m.wamid || ('scraped_' + num + '_' + new Date(ts).getTime() + '_' + Math.random().toString(36).slice(2, 8));
            const direction = m.direction === 'outbound' ? 'outbound' : 'inbound';
            const msgType = m.msg_type || m.type || 'text';
            const bodyText = String(m.body || '');
            const mediaUrl = m.media_url || '';
            const contextId = m.context_id || '';
            const senderName = direction === 'inbound' ? (contactName || m.sender_name || '') : '';
            if (!bodyText && !mediaUrl) { skipped++; continue; }
            const r = await env.DB.prepare(
              'INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).bind(ts, wamid, direction, num, senderName, msgType, bodyText, mediaUrl, contextId, 'imported').run();
            if (r.meta && r.meta.changes > 0) {
              inserted++;
            } else {
              duplicates++;
              // Backfill media_url si el mensaje ya existía con media_url vacío
              // y este import trae uno nuevo (ej: catch-up que ahora baja media).
              if (mediaUrl) {
                const u = await env.DB.prepare(
                  "UPDATE wa_messages SET media_url = ? WHERE wamid = ? AND (media_url IS NULL OR media_url = '')"
                ).bind(mediaUrl, wamid).run();
                if (u.meta && u.meta.changes > 0) mediaBackfilled++;
              }
            }
          } catch (e) {
            errors++;
          }
        }
        return json({ ok: true, inserted, duplicates, skipped, errors, mediaBackfilled, total: messages.length });
      }

      // ===== MEDIA UPLOAD desde scraper (sube blob a R2, devuelve key) =====
      // El scraper baja la media de WA Web (msg.downloadMedia → base64),
      // la convierte a binario y la sube acá multipart. Devuelve el R2 key
      // que el scraper guarda en media_url al hacer import-bulk.
      // Key determinístico = wa/scrape_<wamid_sanitized> → si se intenta subir
      // el mismo wamid 2 veces, sobrescribe (idempotente).
      if (request.method === 'POST' && path === '/admin/wa/media/upload') {
        if (session.user !== 'Gaspar') return json({ error: 'forbidden' }, 403);
        if (!env.MEDIA) return json({ error: 'R2 not configured' }, 500);
        const ct = request.headers.get('Content-Type') || '';
        if (!ct.includes('multipart/form-data')) return json({ error: 'expected multipart/form-data' }, 400);
        const fd = await request.formData();
        const file = fd.get('file');
        const wamid = String(fd.get('wamid') || '').trim();
        const msgType = String(fd.get('type') || 'document').trim();
        if (!file) return json({ error: 'missing file' }, 400);
        if (!wamid) return json({ error: 'missing wamid' }, 400);
        const fileMime = file.type || '';
        const fileName = file.name || '';
        const ext = fileName.includes('.') ? '.' + fileName.split('.').pop().toLowerCase().slice(0, 5)
                  : msgType === 'audio' ? '.ogg'
                  : msgType === 'image' ? '.jpg'
                  : msgType === 'video' ? '.mp4'
                  : msgType === 'sticker' ? '.webp'
                  : '';
        // Key determinístico por wamid (sanitizado).
        const sanitized = wamid.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
        const r2Key = `wa/scrape_${sanitized}${ext}`;
        const buf = await file.arrayBuffer();
        const defaultMime = msgType === 'audio' ? 'audio/ogg; codecs=opus'
                          : msgType === 'image' ? 'image/jpeg'
                          : msgType === 'video' ? 'video/mp4'
                          : msgType === 'sticker' ? 'image/webp'
                          : 'application/octet-stream';
        const mime = fileMime || defaultMime;
        try {
          await env.MEDIA.put(r2Key, buf, { httpMetadata: { contentType: mime } });
          return json({ ok: true, key: r2Key, bytes: buf.byteLength });
        } catch (e) {
          return json({ error: 'r2 put failed: ' + e.message }, 500);
        }
      }

      // Lista de wamids que YA tienen media_url en DB.
      if (request.method === 'GET' && path === '/admin/wa/media/wamids') {
        try {
          const rs = await env.DB.prepare(
            "SELECT wamid FROM wa_messages WHERE media_url IS NOT NULL AND media_url != ''"
          ).all();
          const wamids = (rs.results || []).map(r => r.wamid).filter(Boolean);
          return json({ wamids });
        } catch (e) { return json({ wamids: [], error: e.message }, 500); }
      }

      // Lista de TODOS los wamids en DB (con o sin media). El scraper la baja
      // al arrancar para saber qué mensajes ya están conocidos y skipear el
      // download de media (costoso) cuando es un duplicado. Solo para mensajes
      // NUEVOS se baja la media. ~16k strings ≈ 800 KB total.
      if (request.method === 'GET' && path === '/admin/wa/wamids') {
        try {
          const rs = await env.DB.prepare('SELECT wamid FROM wa_messages WHERE wamid IS NOT NULL AND wamid != ""').all();
          const wamids = (rs.results || []).map(r => r.wamid).filter(Boolean);
          return json({ wamids, count: wamids.length });
        } catch (e) { return json({ wamids: [], error: e.message }, 500); }
      }

      // ===== WA CONTACTS (nombres de contacto sincronizados desde WhatsApp) =====
      // Tabla wa_contacts: phone → name. La fuente es el scraper que lee los
      // nombres tal como Joaco los tiene guardados en la agenda del 6573.
      // El frontend mergea esto contra los mensajes para mostrar el nombre real.
      if (request.method === 'POST' && path === '/admin/wa/contacts/import-bulk') {
        if (session.user !== 'Gaspar') return json({ error: 'forbidden' }, 403);
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { contacts } = body || {};
        if (!Array.isArray(contacts)) return json({ error: 'missing contacts[]' }, 400);
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS wa_contacts (phone TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)").run();
        const now = new Date().toISOString();
        let upserted = 0, skipped = 0;
        for (const c of (contacts || [])) {
          const rawPhone = c?.phone || '';
          const num = normalizeArPhone(rawPhone) || String(rawPhone).replace(/\D/g, '');
          const name = String(c?.name || '').trim();
          if (!num || !name) { skipped++; continue; }
          try {
            await env.DB.prepare(
              'INSERT INTO wa_contacts (phone, name, updated_at) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at'
            ).bind(num, name, now).run();
            upserted++;
          } catch (_) { skipped++; }
        }
        return json({ ok: true, upserted, skipped, total: contacts.length });
      }

      if (request.method === 'GET' && path === '/admin/wa/contacts') {
        try {
          await env.DB.prepare("CREATE TABLE IF NOT EXISTS wa_contacts (phone TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)").run();
          const rs = await env.DB.prepare('SELECT phone, name FROM wa_contacts').all();
          return json({ contacts: rs.results || [] });
        } catch (e) { return json({ contacts: [] }); }
      }

      // ===== WA LABELS BULK IMPORT (desde el scraper) =====
      // Body: { labels: [{name, color}], assignments: [{phone, labelName}], replaceAll?: bool }
      // Si replaceAll=true → borra TODAS las assignments antes de insertar (sync limpio).
      // Las labels se hacen upsert (mantiene id existente si ya está, actualiza color).
      if (request.method === 'POST' && path === '/admin/wa/labels/import-bulk') {
        if (session.user !== 'Gaspar') return json({ error: 'forbidden' }, 403);
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { labels, assignments, replaceAll } = body || {};
        await env.DB.prepare('CREATE TABLE IF NOT EXISTS labels (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL, created_at TEXT NOT NULL)').run();
        await env.DB.prepare('CREATE TABLE IF NOT EXISTS contact_labels (phone TEXT NOT NULL, label_id INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (phone, label_id))').run();
        const now = new Date().toISOString();
        const nameToId = new Map();
        let labelsCreated = 0, labelsUpdated = 0, assignmentsCreated = 0, assignmentsSkipped = 0;

        // 1) Upsert labels
        if (Array.isArray(labels)) {
          for (const l of labels) {
            const name = String(l?.name || '').trim();
            const color = String(l?.color || '#42a5f5').trim();
            if (!name) continue;
            try {
              const existing = await env.DB.prepare('SELECT id FROM labels WHERE name = ?').bind(name).first();
              if (existing) {
                await env.DB.prepare('UPDATE labels SET color = ? WHERE id = ?').bind(color, existing.id).run();
                nameToId.set(name, existing.id);
                labelsUpdated++;
              } else {
                await env.DB.prepare('INSERT INTO labels (name, color, created_at) VALUES (?, ?, ?)').bind(name, color, now).run();
                const row = await env.DB.prepare('SELECT id FROM labels WHERE name = ?').bind(name).first();
                if (row) nameToId.set(name, row.id);
                labelsCreated++;
              }
            } catch (_) {}
          }
        }

        // 2) Si replaceAll → limpiar assignments existentes para sync limpio
        if (replaceAll === true) {
          await env.DB.prepare('DELETE FROM contact_labels').run();
        }

        // 3) Upsert assignments
        if (Array.isArray(assignments)) {
          for (const a of assignments) {
            const rawPhone = a?.phone || '';
            const phone = normalizeArPhone(rawPhone) || String(rawPhone).replace(/\D/g, '');
            const labelName = String(a?.labelName || '').trim();
            if (!phone || !labelName) { assignmentsSkipped++; continue; }
            let lid = nameToId.get(labelName);
            if (!lid) {
              const row = await env.DB.prepare('SELECT id FROM labels WHERE name = ?').bind(labelName).first();
              if (row) { lid = row.id; nameToId.set(labelName, lid); }
            }
            if (!lid) { assignmentsSkipped++; continue; }
            try {
              await env.DB.prepare(
                'INSERT OR IGNORE INTO contact_labels (phone, label_id, created_at) VALUES (?, ?, ?)'
              ).bind(phone, lid, now).run();
              assignmentsCreated++;
            } catch (_) { assignmentsSkipped++; }
          }
        }
        return json({ ok: true, labelsCreated, labelsUpdated, assignmentsCreated, assignmentsSkipped });
      }

      // ===== BUSINESS PANEL (solo Gaspar) =====
      // Lee el Sheet "2025 V4" (PnL + 6 hojas detalle), parsea y devuelve JSON.
      // Cachea 1h en D1 para no tirar del Sheet en cada visita.
      if (request.method === 'GET' && path === '/admin/business-panel') {
        if (session.user !== 'Gaspar') return json({ error: 'forbidden' }, 403);
        const force = url.searchParams.get('force') === '1';
        // Cache check
        await env.DB.prepare('CREATE TABLE IF NOT EXISTS panel_cache (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at TEXT NOT NULL)').run();
        if (!force) {
          const cached = await env.DB.prepare('SELECT v, updated_at FROM panel_cache WHERE k = ?').bind('business_panel_v2_noneon').first();
          if (cached) {
            const age = Date.now() - new Date(cached.updated_at).getTime();
            if (age < 60 * 60 * 1000) {
              return json({ ...JSON.parse(cached.v), _cached: true, _cache_age_s: Math.floor(age / 1000) });
            }
          }
        }
        // Fetch all 7 sheets in parallel via public gviz CSV.
        const SID = '1PLG-vosgVtvhYYaBLi5Rh-LM6f2A_BvG3i6-a7NpNCE';
        const fetchSheet = async (name, range) => {
          const u = `https://docs.google.com/spreadsheets/d/${SID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}${range ? '&range=' + range : ''}`;
          const r = await fetch(u);
          if (!r.ok) return '';
          return await r.text();
        };
        const [pnlCsv, dirCsv, disCsv, insCsv, curCsv] = await Promise.all([
          fetchSheet('PnL', 'A1:Q15'),
          fetchSheet('Pedidos_Directo'),
          fetchSheet('Pedidos_Distris'),
          fetchSheet('Venta_Insumos'),
          fetchSheet('CURSOS'),
        ]);
        const data = parsePanelData({ pnlCsv, dirCsv, disCsv, insCsv, curCsv });
        const payload = JSON.stringify({ ts: new Date().toISOString(), ...data });
        try {
          await env.DB.prepare('INSERT OR REPLACE INTO panel_cache (k, v, updated_at) VALUES (?, ?, ?)')
            .bind('business_panel_v2_noneon', payload, new Date().toISOString()).run();
        } catch (_) {}
        return new Response(payload, { headers: cors({ 'Content-Type': 'application/json' }) });
      }

      if (request.method === 'POST' && path === '/admin/wa/followups') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const items = Array.isArray(body?.items) ? body.items : null;
        if (!items) return json({ error: 'missing items[]' }, 400);
        const result = await runFollowups(env, items);
        return json(result);
      }

      // ===== CHATS SUMMARY: una fila por phone con último mensaje + unread =====
      // Reemplaza el patrón anterior de pedir limit=5000 mensajes para armar la
      // lista de chats. Devuelve 1 fila por phone con: last_ts, last_body,
      // last_direction, last_msg_type, contact_name (último sender_name inbound
      // no vacío), unread (count inbound > last_read_ts).
      // Mucho más liviano y escala con la cantidad de chats, no de mensajes.
      if (request.method === 'GET' && path === '/admin/wa/chats-summary') {
        try {
          const rs = await env.DB.prepare(`
            WITH last_per_phone AS (
              SELECT phone, MAX(ts) AS max_ts
              FROM wa_messages
              WHERE phone IS NOT NULL AND phone != ''
                AND NOT (msg_type = 'status' AND (body IS NULL OR body = '') AND direction != 'outbound')
              GROUP BY phone
            ),
            last_msg AS (
              SELECT m.phone, m.ts AS last_ts, m.body AS last_body,
                     m.direction AS last_direction, m.msg_type AS last_msg_type
              FROM wa_messages m
              INNER JOIN last_per_phone lp ON m.phone = lp.phone AND m.ts = lp.max_ts
            ),
            inbound_name AS (
              SELECT phone, sender_name
              FROM (
                SELECT phone, sender_name,
                       ROW_NUMBER() OVER (PARTITION BY phone ORDER BY ts DESC) AS rn
                FROM wa_messages
                WHERE direction = 'inbound' AND sender_name IS NOT NULL AND sender_name != ''
              ) t
              WHERE rn = 1
            ),
            unread_counts AS (
              SELECT m.phone, COUNT(*) AS unread
              FROM wa_messages m
              LEFT JOIN wa_read_cursor c ON c.phone = m.phone
              WHERE m.direction = 'inbound'
                AND m.ts > COALESCE(c.last_read_ts, '1970-01-01')
              GROUP BY m.phone
            )
            SELECT lm.phone, lm.last_ts, lm.last_body, lm.last_direction, lm.last_msg_type,
                   COALESCE(inm.sender_name, '') AS contact_name,
                   COALESCE(uc.unread, 0) AS unread
            FROM last_msg lm
            LEFT JOIN inbound_name inm ON inm.phone = lm.phone
            LEFT JOIN unread_counts uc ON uc.phone = lm.phone
            ORDER BY lm.last_ts DESC
          `).all();
          return json({ chats: rs.results || [] });
        } catch (e) {
          return json({ chats: [], error: e.message }, 500);
        }
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
        const replyTo = fd.get('reply_to') || '';
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
        if (replyTo) payload.context = { message_id: replyTo };
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
          ).bind(new Date().toISOString(), r.id || '', 'outbound', num, '', type, body, r2Key, replyTo || '', 'sent').run();
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

      // ===== Reaccionar a un mensaje (emoji) =====
      // body: { phone, wamid, emoji }   — emoji vacío = quitar la reacción
      if (request.method === 'POST' && path === '/admin/wa/react') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { phone, wamid, emoji } = body || {};
        if (!phone || !wamid) return json({ error: 'missing phone or wamid' }, 400);
        const num = normalizeArPhone(phone);
        if (!num) return json({ error: 'numero invalido' }, 400);
        const payload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: num,
          type: 'reaction',
          reaction: { message_id: wamid, emoji: emoji || '' }
        };
        const r = await waSend(env, payload);
        await logWaEvent(env, { to: num, kind: 'reaction', ref: wamid, ok: r.ok, messageId: r.id, error: r.error });
        if (!r.ok) return json({ error: r.error }, r.status || 500);
        try {
          await env.DB.prepare(
            'INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(new Date().toISOString(), r.id || '', 'outbound', num, '', 'reaction', emoji || '', '', wamid, 'sent').run();
        } catch (_) {}
        return json({ ok: true, id: r.id });
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

      // ============================================================
      // Briefs (panel de cotización conversacional)
      // ============================================================

      // GET /admin/briefs?estado=&comercial_id=&disenador_id=&limit=
      // Incluye:
      //   - first_chat_key + chat_count (capturas del chat — para thumb del kanban)
      //   - first_render_key + render_count (renders del diseñador)
      if (request.method === 'GET' && path === '/admin/briefs') {
        const estado = url.searchParams.get('estado');
        const comercialId = url.searchParams.get('comercial_id');
        const disenadorId = url.searchParams.get('disenador_id');
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '500'), 2000);
        const where = [];
        const args = [];
        if (estado)      { where.push('b.estado = ?');       args.push(estado); }
        if (comercialId) { where.push('b.comercial_id = ?'); args.push(comercialId); }
        if (disenadorId) { where.push('b.disenador_id = ?'); args.push(disenadorId); }
        const sql = `
          SELECT b.*,
                 (SELECT r2_key FROM brief_imagenes WHERE brief_id = b.id AND tipo = 'chat'   ORDER BY orden, id LIMIT 1) AS first_chat_key,
                 (SELECT COUNT(*)  FROM brief_imagenes WHERE brief_id = b.id AND tipo = 'chat')                            AS chat_count,
                 (SELECT r2_key FROM brief_imagenes WHERE brief_id = b.id AND tipo = 'render' ORDER BY orden, id LIMIT 1) AS first_render_key,
                 (SELECT COUNT(*)  FROM brief_imagenes WHERE brief_id = b.id AND tipo = 'render')                          AS render_count
          FROM briefs b
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY b.updated_at DESC
          LIMIT ?
        `;
        args.push(limit);
        const rs = await env.DB.prepare(sql).bind(...args).all();
        return json({ briefs: rs.results || [] });
      }

      // GET /admin/briefs/:id  →  detalle + hilo interno + imágenes
      if (request.method === 'GET' && /^\/admin\/briefs\/\d+$/.test(path)) {
        const id = path.split('/').pop();
        const brief = await env.DB.prepare('SELECT * FROM briefs WHERE id = ?').bind(id).first();
        if (!brief) return json({ error: 'not found' }, 404);
        const msgs = await env.DB.prepare(
          'SELECT * FROM brief_messages WHERE brief_id = ? ORDER BY created_at ASC'
        ).bind(id).all();
        const imgs = await env.DB.prepare(
          'SELECT * FROM brief_imagenes WHERE brief_id = ? ORDER BY orden ASC, id ASC'
        ).bind(id).all();
        return json({ brief, messages: msgs.results || [], imagenes: imgs.results || [] });
      }

      // POST /admin/briefs  →  crear (form simplificado: solo titulo es virtualmente obligatorio)
      if (request.method === 'POST' && path === '/admin/briefs') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        // Comercial siempre joaco por default (equipo actual: solo Joaco + Emma).
        const comercial_id = body.comercial_id || 'joaco';
        const now = new Date().toISOString();
        const cols = [
          'cliente_wa_id', 'cliente_nombre', 'origen_lead', 'estado', 'tipo', 'diseno',
          'alto_cm', 'ancho_cm', 'm2', 'neon_mt', 'medidas_libre',
          'precio_trans', 'precio_negro', 'precio_final',
          'descuento', 'recargo', 'reventa', 'comision_joaco',
          'comercial_id', 'disenador_id', 'notas',
          'created_at', 'updated_at'
        ];
        const vals = [
          body.cliente_wa_id || '', body.cliente_nombre || null, body.origen_lead || '',
          body.estado || 'nuevo', body.tipo || null, body.diseno || null,
          body.alto_cm ?? null, body.ancho_cm ?? null, body.m2 ?? null, body.neon_mt ?? null,
          body.medidas_libre || null,
          body.precio_trans ?? null, body.precio_negro ?? null, body.precio_final ?? null,
          body.descuento ?? 0, body.recargo ?? 0, body.reventa ?? 0, body.comision_joaco ?? 0,
          comercial_id, body.disenador_id || null, body.notas || null,
          now, now
        ];
        const placeholders = cols.map(() => '?').join(',');
        const result = await env.DB.prepare(
          `INSERT INTO briefs (${cols.join(',')}) VALUES (${placeholders})`
        ).bind(...vals).run();
        const id = result.meta.last_row_id;
        const brief = await env.DB.prepare('SELECT * FROM briefs WHERE id = ?').bind(id).first();
        return json({ brief }, 201);
      }

      // PATCH /admin/briefs/:id  →  editar specs / cambiar estado / asignar
      if (request.method === 'PATCH' && /^\/admin\/briefs\/\d+$/.test(path)) {
        const id = path.split('/').pop();
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const editable = [
          'cliente_nombre', 'cliente_wa_id', 'origen_lead', 'estado', 'tipo', 'diseno',
          'alto_cm', 'ancho_cm', 'm2', 'neon_mt', 'medidas_libre',
          'precio_trans', 'precio_negro', 'precio_final',
          'descuento', 'recargo', 'reventa', 'comision_joaco',
          'disenador_id', 'intentos_followup', 'notas', 'sheet_row'
        ];
        const sets = [];
        const args = [];
        for (const k of editable) {
          if (k in body) { sets.push(`${k} = ?`); args.push(body[k]); }
        }
        if (!sets.length) return json({ error: 'nothing to update' }, 400);
        sets.push('updated_at = ?');
        args.push(new Date().toISOString());
        args.push(id);
        await env.DB.prepare(`UPDATE briefs SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
        const brief = await env.DB.prepare('SELECT * FROM briefs WHERE id = ?').bind(id).first();
        return json({ brief });
      }

      // POST /admin/briefs/:id/messages  →  agregar mensaje al hilo interno (fase 3)
      if (request.method === 'POST' && /^\/admin\/briefs\/\d+\/messages$/.test(path)) {
        const id = path.split('/')[3];
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        if (!body.autor_id || !body.tipo) return json({ error: 'missing fields' }, 400);
        const now = new Date().toISOString();
        const result = await env.DB.prepare(
          'INSERT INTO brief_messages (brief_id, autor_id, tipo, contenido, is_final, created_at) VALUES (?,?,?,?,?,?)'
        ).bind(id, body.autor_id, body.tipo, body.contenido || null, body.is_final ? 1 : 0, now).run();
        await env.DB.prepare('UPDATE briefs SET updated_at = ? WHERE id = ?').bind(now, id).run();
        return json({ id: result.meta.last_row_id }, 201);
      }

      // DELETE /admin/briefs/:id  →  borra brief + sus imágenes (R2 + DB) + sus mensajes.
      // Solo se debe llamar desde rol comercial/admin (el frontend gatea, acá confiamos).
      if (request.method === 'DELETE' && /^\/admin\/briefs\/\d+$/.test(path)) {
        const id = path.split('/').pop();
        const brief = await env.DB.prepare('SELECT id FROM briefs WHERE id = ?').bind(id).first();
        if (!brief) return json({ error: 'not found' }, 404);
        // Borrar imágenes de R2 (mejor esfuerzo).
        const imgs = await env.DB.prepare('SELECT r2_key FROM brief_imagenes WHERE brief_id = ?').bind(id).all();
        if (env.MEDIA) {
          for (const row of (imgs.results || [])) {
            try { await env.MEDIA.delete(row.r2_key); } catch(e) { /* ignorar */ }
          }
        }
        // Borrar filas dependientes en orden.
        await env.DB.prepare('DELETE FROM brief_imagenes WHERE brief_id = ?').bind(id).run();
        await env.DB.prepare('DELETE FROM brief_messages WHERE brief_id = ?').bind(id).run();
        await env.DB.prepare('DELETE FROM briefs WHERE id = ?').bind(id).run();
        return noContent();
      }

      // POST /admin/briefs/:id/enviar  →  marca brief como enviado.
      // El envío real al cliente (WhatsApp) y la escritura al Sheet ya las hace
      // el frontend (cot-send-wa-btn / cot-save-btn en app.js). Este endpoint
      // solo registra el avance de estado + el sheet_row para trazabilidad.
      if (request.method === 'POST' && /^\/admin\/briefs\/\d+\/enviar$/.test(path)) {
        const id = path.split('/')[3];
        let body = {};
        try { body = await request.json(); } catch {}
        const now = new Date().toISOString();
        await env.DB.prepare(
          'UPDATE briefs SET estado = ?, enviado_at = ?, updated_at = ?, sheet_row = COALESCE(?, sheet_row), precio_final = COALESCE(?, precio_final) WHERE id = ?'
        ).bind('enviado', now, now, body.sheet_row ?? null, body.precio_final ?? null, id).run();
        const brief = await env.DB.prepare('SELECT * FROM briefs WHERE id = ?').bind(id).first();
        return json({ brief });
      }

      // PUT /admin/briefs/:id/imagen?tipo=chat|boceto|render  →  sube imagen a R2 + inserta.
      // Body: bytes raw del archivo. Headers: Content-Type: image/png|jpeg|webp|etc.
      // tipo:
      //   - 'chat'   → captura del cliente, sube Joaco
      //   - 'boceto' → boceto vectorizado de cotización, sube Emma
      //   - 'render' → render generado por IA (o subido manual), Emma
      // Default: 'chat'.
      if (request.method === 'PUT' && /^\/admin\/briefs\/\d+\/imagen$/.test(path)) {
        const briefId = path.split('/')[3];
        const tipoRaw = url.searchParams.get('tipo') || 'chat';
        const tipo = ['chat', 'boceto', 'render'].includes(tipoRaw) ? tipoRaw : 'chat';
        if (!env.MEDIA) return json({ error: 'R2 not configured' }, 500);
        const ct = request.headers.get('content-type') || 'application/octet-stream';
        if (!ct.startsWith('image/')) return json({ error: 'only image/* content-type allowed' }, 400);

        const buf = await request.arrayBuffer();
        if (!buf || buf.byteLength === 0) return json({ error: 'empty body' }, 400);
        if (buf.byteLength > 10 * 1024 * 1024) return json({ error: 'image too large (>10MB)' }, 413);

        const brief = await env.DB.prepare('SELECT id FROM briefs WHERE id = ?').bind(briefId).first();
        if (!brief) return json({ error: 'brief not found' }, 404);

        const ext = (ct.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
        const r2Key = `briefs/${briefId}/${tipo}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        try {
          await env.MEDIA.put(r2Key, buf, { httpMetadata: { contentType: ct } });
        } catch (e) {
          return json({ error: 'r2 put failed: ' + e.message }, 500);
        }

        // Orden = max(orden) + 1 dentro del brief + tipo.
        const ordRow = await env.DB.prepare(
          'SELECT COALESCE(MAX(orden), -1) + 1 AS next_ord FROM brief_imagenes WHERE brief_id = ? AND tipo = ?'
        ).bind(briefId, tipo).first();
        const orden = ordRow?.next_ord ?? 0;
        const now = new Date().toISOString();
        const result = await env.DB.prepare(
          'INSERT INTO brief_imagenes (brief_id, r2_key, content_type, size_bytes, orden, created_at, tipo) VALUES (?,?,?,?,?,?,?)'
        ).bind(briefId, r2Key, ct, buf.byteLength, orden, now, tipo).run();
        await env.DB.prepare('UPDATE briefs SET updated_at = ? WHERE id = ?').bind(now, briefId).run();
        return json({
          id: result.meta.last_row_id,
          brief_id: parseInt(briefId, 10),
          r2_key: r2Key,
          content_type: ct,
          size_bytes: buf.byteLength,
          orden,
          tipo,
          created_at: now
        }, 201);
      }

      // POST /admin/briefs/:id/generar-render  →  toma el boceto (tipo='boceto')
      // más reciente del brief, lo manda a Gemini con el prompt del negocio, y
      // guarda el resultado como una imagen tipo='render'. Devuelve el render nuevo.
      if (request.method === 'POST' && /^\/admin\/briefs\/\d+\/generar-render$/.test(path)) {
        const briefId = path.split('/')[3];
        if (!env.GEMINI_API_KEY) return json({ error: 'Falta configurar GEMINI_API_KEY en el worker' }, 503);
        if (!env.MEDIA) return json({ error: 'R2 not configured' }, 500);

        const brief = await env.DB.prepare('SELECT * FROM briefs WHERE id = ?').bind(briefId).first();
        if (!brief) return json({ error: 'brief not found' }, 404);

        // Buscar el boceto más reciente.
        const bocetoRow = await env.DB.prepare(
          "SELECT r2_key, content_type FROM brief_imagenes WHERE brief_id = ? AND tipo = 'boceto' ORDER BY orden DESC, id DESC LIMIT 1"
        ).bind(briefId).first();
        if (!bocetoRow) return json({ error: 'No hay boceto cargado para generar el render' }, 400);

        const obj = await env.MEDIA.get(bocetoRow.r2_key);
        if (!obj) return json({ error: 'boceto no encontrado en R2' }, 404);
        const bocetoBuf = await obj.arrayBuffer();

        // Contexto de medidas para el prompt.
        const medidas = [];
        if (brief.ancho_cm) medidas.push(`ancho ${brief.ancho_cm} cm`);
        if (brief.alto_cm)  medidas.push(`alto ${brief.alto_cm} cm`);
        if (brief.neon_mt)  medidas.push(`${brief.neon_mt} m de neón`);
        const extraTexto = medidas.length ? `Medidas del cartel: ${medidas.join(', ')}.` : '';

        const gen = await generarRenderConGemini(env, bocetoBuf, bocetoRow.content_type, extraTexto);
        if (gen.error) return json({ error: gen.error }, 502);

        // Guardar el render generado en R2.
        let renderBuf;
        try { renderBuf = Uint8Array.from(atob(gen.base64), c => c.charCodeAt(0)).buffer; }
        catch (e) { return json({ error: 'no se pudo decodificar la imagen de Gemini' }, 500); }
        const ext = (gen.mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'png';
        const r2Key = `briefs/${briefId}/render-ia-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        await env.MEDIA.put(r2Key, renderBuf, { httpMetadata: { contentType: gen.mime } });

        const ordRow = await env.DB.prepare(
          "SELECT COALESCE(MAX(orden), -1) + 1 AS next_ord FROM brief_imagenes WHERE brief_id = ? AND tipo = 'render'"
        ).bind(briefId).first();
        const now = new Date().toISOString();
        const result = await env.DB.prepare(
          "INSERT INTO brief_imagenes (brief_id, r2_key, content_type, size_bytes, orden, created_at, tipo) VALUES (?,?,?,?,?,?, 'render')"
        ).bind(briefId, r2Key, gen.mime, renderBuf.byteLength, ordRow?.next_ord ?? 0, now).run();
        await env.DB.prepare('UPDATE briefs SET updated_at = ? WHERE id = ?').bind(now, briefId).run();
        return json({
          id: result.meta.last_row_id, brief_id: parseInt(briefId, 10),
          r2_key: r2Key, content_type: gen.mime, tipo: 'render', created_at: now
        }, 201);
      }

      // DELETE /admin/briefs/:id/imagen/:imgId  →  borra de R2 + DB.
      if (request.method === 'DELETE' && /^\/admin\/briefs\/\d+\/imagen\/\d+$/.test(path)) {
        const parts = path.split('/');
        const briefId = parts[3];
        const imgId = parts[5];
        const row = await env.DB.prepare(
          'SELECT r2_key FROM brief_imagenes WHERE id = ? AND brief_id = ?'
        ).bind(imgId, briefId).first();
        if (!row) return json({ error: 'not found' }, 404);
        try { if (env.MEDIA) await env.MEDIA.delete(row.r2_key); } catch (e) { /* ignorar fallos de R2 */ }
        await env.DB.prepare('DELETE FROM brief_imagenes WHERE id = ?').bind(imgId).run();
        await env.DB.prepare('UPDATE briefs SET updated_at = ? WHERE id = ?').bind(new Date().toISOString(), briefId).run();
        return noContent();
      }

      // ===== Team chat (chat global del equipo, flotante) =====
      // Reusa brief_messages con brief_id = 0 (hilo general, no atado a un brief).
      if (request.method === 'GET' && path === '/admin/team-chat') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
        const rs = await env.DB.prepare(
          'SELECT * FROM brief_messages WHERE brief_id = 0 ORDER BY created_at DESC LIMIT ?'
        ).bind(limit).all();
        return json({ messages: (rs.results || []).reverse() });
      }
      if (request.method === 'POST' && path === '/admin/team-chat') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        if (!body.autor_id || !body.contenido) return json({ error: 'missing fields' }, 400);
        const now = new Date().toISOString();
        const result = await env.DB.prepare(
          'INSERT INTO brief_messages (brief_id, autor_id, tipo, contenido, created_at) VALUES (0,?,?,?,?)'
        ).bind(body.autor_id, body.tipo || 'text', body.contenido, now).run();
        return json({ id: result.meta.last_row_id, created_at: now }, 201);
      }
      // PUT /admin/team-chat/imagen?autor=joaco  →  sube imagen a R2 + mensaje tipo='image'.
      if (request.method === 'PUT' && path === '/admin/team-chat/imagen') {
        if (!env.MEDIA) return json({ error: 'R2 not configured' }, 500);
        const ct = request.headers.get('content-type') || '';
        if (!ct.startsWith('image/')) return json({ error: 'only image/* allowed' }, 400);
        const autor = url.searchParams.get('autor') || 'joaco';
        const buf = await request.arrayBuffer();
        if (!buf || buf.byteLength === 0) return json({ error: 'empty body' }, 400);
        if (buf.byteLength > 10 * 1024 * 1024) return json({ error: 'too large (>10MB)' }, 413);
        const ext = (ct.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
        const r2Key = `teamchat/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        try { await env.MEDIA.put(r2Key, buf, { httpMetadata: { contentType: ct } }); }
        catch (e) { return json({ error: 'r2 put failed: ' + e.message }, 500); }
        const now = new Date().toISOString();
        const result = await env.DB.prepare(
          'INSERT INTO brief_messages (brief_id, autor_id, tipo, contenido, created_at) VALUES (0,?,?,?,?)'
        ).bind(autor, 'image', r2Key, now).run();
        return json({ id: result.meta.last_row_id, r2_key: r2Key, tipo: 'image', autor_id: autor, contenido: r2Key, created_at: now }, 201);
      }

      // GET /admin/users-panel  →  lista de usuarios del panel (comerciales/diseñadores/admin)
      if (request.method === 'GET' && path === '/admin/users-panel') {
        const rs = await env.DB.prepare(
          'SELECT id, nombre, rol, activo FROM users_panel WHERE activo = 1 ORDER BY rol, nombre'
        ).all();
        return json({ users: rs.results || [] });
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
// Acepta AMBOS prefijos (viejo + nuevo) para no perder presupuestos históricos.
const PRESUPUESTO_PREFIXES_TEXT = [
  'Te comparto el presupuesto con la información detallada!',
  'Te comparto la información detallada!'
];
const PRESUPUESTO_PREFIX_TEXT = PRESUPUESTO_PREFIXES_TEXT[0]; // back-compat
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
      "SELECT phone, ts, body, sender_name FROM wa_messages WHERE direction = 'outbound' AND (body LIKE ? OR body LIKE ?) AND ts >= ? AND ts <= ? ORDER BY ts DESC"
    ).bind(PRESUPUESTO_PREFIXES_TEXT[0] + '%', PRESUPUESTO_PREFIXES_TEXT[1] + '%', oneDayAgo, oneHourAgo).all();
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
