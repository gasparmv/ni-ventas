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
//   WA_TOKEN                        token permanente de WhatsApp Cloud API (System User)  ← Meta direct (legacy)
//   D360_API_KEY                    API key de 360dialog (channel access)                  ← 360dialog (actual)
//   APPS_SCRIPT_FOLLOWUPS_URL       endpoint de Apps Script que devuelve seguimientos pendientes
//
// Vars (en wrangler.toml):
//   WA_PHONE_NUMBER_ID              919964037861500 (Neon Infinito +54 9 11 4436-6573)
//   WA_API_VERSION                  v25.0
//   WA_PROVIDER                     'meta' | '360dialog' (default 'meta'). Setear a '360dialog'
//                                   con `wrangler secret put WA_PROVIDER` cuando termine la migración.

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
// Semilla del framework de venta. framework-venta.js se autogenera desde
// framework-venta.md (string JSON, módulo JS normal — no requiere reglas de wrangler).
import { FRAMEWORK_SEED_B64 } from './knowledge/framework-venta.js';
// Decodificar base64 UTF-8 -> string (evita problemas de escaping/interop al bundlear).
const FRAMEWORK_SEED = new TextDecoder().decode(Uint8Array.from(atob(FRAMEWORK_SEED_B64), c => c.charCodeAt(0)));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: cors({ 'Content-Type': 'application/json; charset=utf-8' }) });
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

// ============================================================
// WhatsApp Provider Abstraction
// ============================================================
// Abstrae las llamadas a la API de WhatsApp para soportar dos providers:
//   - 'meta'      : Meta Cloud API directa (graph.facebook.com)
//   - '360dialog' : 360dialog como BSP (waba-v2.360dialog.io)
//
// Ambos providers usan estructuras de payload compatibles (360dialog es un thin
// proxy sobre Meta), solo cambia la URL base y el header de autenticación.
function getWaClient(env) {
  const provider = (env.WA_PROVIDER || 'meta').toLowerCase();
  if (provider === '360dialog') {
    if (!env.D360_API_KEY) {
      throw new Error('WA_PROVIDER=360dialog pero D360_API_KEY no configurada');
    }
    const base = env.D360_API_BASE || 'https://waba-v2.360dialog.io';
    return {
      provider: '360dialog',
      base,
      headers: { 'D360-API-KEY': env.D360_API_KEY },
      // En 360dialog NO se incluye phone_id ni waba_id en la URL — son implícitos por la API key
      messagesUrl: () => `${base}/messages`,
      mediaUrl:    (mediaId) => `${base}/${mediaId}`,
      mediaUploadUrl: () => `${base}/media`,
      // Templates en 360dialog usa la Channel API: GET/POST /v1/configs/templates
      // Devuelve { waba_templates: [...] } (no { data: [...] } como Meta).
      templatesUrl: () => `${base}/v1/configs/templates`,
      // GET phone info: 360dialog no expone exactamente este endpoint; el dashboard ya muestra todo
      phoneInfoUrl: (fields) => `${base}/configs/whatsapp_business_account`,
    };
  }
  // Default: Meta direct
  const v = env.WA_API_VERSION || 'v25.0';
  const base = `https://graph.facebook.com/${v}`;
  return {
    provider: 'meta',
    base,
    headers: env.WA_TOKEN ? { 'Authorization': `Bearer ${env.WA_TOKEN}` } : {},
    messagesUrl: () => `${base}/${env.WA_PHONE_NUMBER_ID}/messages`,
    mediaUrl:    (mediaId) => `${base}/${mediaId}`,
    mediaUploadUrl: () => `${base}/${env.WA_PHONE_NUMBER_ID}/media`,
    templatesUrl: () => `${base}/${env.WA_BUSINESS_ACCOUNT_ID}/message_templates`,
    phoneInfoUrl: (fields) => `${base}/${env.WA_PHONE_NUMBER_ID}${fields ? '?fields=' + fields : ''}`,
  };
}

// Query "vieja" de la lista de chats — se usa SOLO como red de seguridad del
// endpoint /admin/wa/chats-summary si la libreta wa_chats_summary está vacía o
// falla. Escanea toda wa_messages (cara) pero garantiza que la lista nunca se
// rompa aunque la libreta tenga un problema.
const CHATS_SUMMARY_FALLBACK_SQL = `
  WITH last_msg AS (
    SELECT phone, ts AS last_ts, body AS last_body, direction AS last_direction, msg_type AS last_msg_type
    FROM (
      SELECT phone, ts, body, direction, msg_type,
             ROW_NUMBER() OVER (PARTITION BY phone ORDER BY ts DESC, id DESC) AS rn
      FROM wa_messages
      WHERE phone IS NOT NULL AND phone != ''
        AND NOT (msg_type = 'status' AND (body IS NULL OR body = '') AND direction != 'outbound')
    ) t WHERE rn = 1
  ),
  inbound_name AS (
    SELECT phone, sender_name FROM (
      SELECT phone, sender_name, ROW_NUMBER() OVER (PARTITION BY phone ORDER BY ts DESC) AS rn
      FROM wa_messages WHERE direction = 'inbound' AND sender_name IS NOT NULL AND sender_name != ''
    ) t WHERE rn = 1
  ),
  unread_counts AS (
    SELECT m.phone, COUNT(*) AS unread FROM wa_messages m
    LEFT JOIN wa_read_cursor c ON c.phone = m.phone
    WHERE m.direction = 'inbound' AND m.ts > COALESCE(c.last_read_ts, '1970-01-01')
    GROUP BY m.phone
  )
  SELECT lm.phone, lm.last_ts, lm.last_body, lm.last_direction, lm.last_msg_type,
         COALESCE(inm.sender_name, '') AS contact_name,
         COALESCE(uc.unread, 0) AS unread,
         'general' AS inbox
  FROM last_msg lm
  LEFT JOIN inbound_name inm ON inm.phone = lm.phone
  LEFT JOIN unread_counts uc ON uc.phone = lm.phone
  ORDER BY lm.last_ts DESC
`;

// Sheet público de interesados en cursos (form del minicurso). Lo leemos por
// CSV export (sin auth, está compartido). Col B (idx 1) = Nombre Completo,
// col G (idx 6, última) = teléfono.
const CURSOS_SHEET_CSV = 'https://docs.google.com/spreadsheets/d/1yJM2uj7SMMreJXHvxPPT8XNe0d1d4sgAt02jTUISXJA/export?format=csv';
const CURSOS_COL_NOMBRE = 1;
const CURSOS_COL_TELEFONO = 6;

// Parser CSV mínimo que respeta comillas dobles (campos con comas/saltos).
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Capitaliza la primera letra (para el {{1}} del template): "alan" → "Alan".
function capitalizeName(s) {
  s = String(s || '').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

// Lee el Sheet de cursos y devuelve los leads parseados + normalizados.
// { total, leads: [{ nombre, telRaw, tel, valido }] } (dedup por tel dentro del sheet).
async function fetchCursosLeads(env) {
  const r = await fetch(CURSOS_SHEET_CSV, { redirect: 'follow' });
  if (!r.ok) throw new Error('sheet HTTP ' + r.status);
  const rows = parseCSV(await r.text());
  const seen = new Set();
  const leads = [];
  for (let i = 1; i < rows.length; i++) {
    const nombre = String(rows[i][CURSOS_COL_NOMBRE] || '').trim();
    const telRaw = String(rows[i][CURSOS_COL_TELEFONO] || '').trim();
    if (!nombre && !telRaw) continue;
    const tel = normalizeArPhone(telRaw) || '';
    const valido = !!tel && tel.length >= 10;
    if (valido) {
      if (seen.has(tel)) continue; // dedup dentro del sheet
      seen.add(tel);
    }
    leads.push({ nombre, telRaw, tel, valido });
  }
  return { total: Math.max(0, rows.length - 1), leads };
}

async function waSend(env, payload) {
  if (!env.WA_PHONE_NUMBER_ID) {
    return { ok: false, status: 500, error: 'WA_PHONE_NUMBER_ID no configurado' };
  }
  let wa;
  try { wa = getWaClient(env); } catch (e) { return { ok: false, status: 500, error: e.message }; }
  if (wa.provider === 'meta' && !env.WA_TOKEN) {
    return { ok: false, status: 500, error: 'WA_TOKEN no configurado (provider meta)' };
  }
  const r = await fetch(wa.messagesUrl(), {
    method: 'POST',
    headers: { ...wa.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Auto-detección de phones no alcanzables. Si Meta nos rechaza con un
    // código que indica que el destinatario está "muerto" (sin WA, bloqueado,
    // mala reputación, etc.), marcamos al phone en wa_unreachable_phones para
    // skipear en los flows automáticos futuros.
    try {
      const to = payload?.to || '';
      const errCode = data?.error?.code;
      const errSubcode = data?.error?.error_subcode;
      const errMsg = data?.error?.message || '';
      const templateName = payload?.template?.name || '';
      const reason = classifyUnreachableReason(errCode, errSubcode, errMsg);
      if (to && reason) {
        await markUnreachable(env, to, reason, errMsg, templateName).catch(() => {});
      }
    } catch (_) { /* no romper el flow del error original */ }
    return { ok: false, status: r.status, error: data?.error?.message || 'wa send failed', raw: data, provider: wa.provider };
  }
  const id = data?.messages?.[0]?.id || null;
  return { ok: true, id, raw: data, provider: wa.provider };
}

// ===== Sistema de phones no alcanzables =====
// Marca/consulta/desmarca contactos que están "muertos" para outreach
// automático. Los flows de follow-up consultan isUnreachable antes de mandar.
// El webhook inbound desmarca automáticamente cuando el cliente responde.

function classifyUnreachableReason(code, subcode, message) {
  // Códigos de Meta — ver migration 017 para detalle.
  if (code === 131026) return 'undeliverable';
  if (code === 131049) return 'ecosystem';
  if (code === 131047) return 'window_closed';
  if (code === 131048) return 'rate_limit';
  // Heurística por mensaje si no hay code (algunos errores vienen sin code numérico).
  const m = String(message || '').toLowerCase();
  if (m.includes('undeliverable')) return 'undeliverable';
  if (m.includes('healthy ecosystem')) return 'ecosystem';
  return null; // null = no marcar (error transitorio o no relacionado al destinatario)
}

async function markUnreachable(env, phone, reason, errorMsg, templateName) {
  if (!phone || !reason || !env.DB) return;
  const num = normalizeArPhone(phone);
  if (!num) return;
  const now = new Date().toISOString();
  const errTrunc = String(errorMsg || '').slice(0, 500);
  try {
    await env.DB.prepare(
      `INSERT INTO wa_unreachable_phones (phone, marked_at, reason, last_error, last_template, fail_count, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(phone) DO UPDATE SET
         reason = excluded.reason,
         last_error = excluded.last_error,
         last_template = excluded.last_template,
         fail_count = fail_count + 1,
         updated_at = excluded.updated_at`
    ).bind(num, now, reason, errTrunc, String(templateName || ''), now).run();
  } catch (_) { /* best-effort */ }
}

async function isUnreachable(env, phone) {
  if (!phone || !env.DB) return false;
  const num = normalizeArPhone(phone);
  if (!num) return false;
  try {
    const row = await env.DB.prepare('SELECT 1 FROM wa_unreachable_phones WHERE phone = ?').bind(num).first();
    return !!row;
  } catch (_) { return false; }
}

async function removeUnreachable(env, phone) {
  if (!phone || !env.DB) return;
  const num = normalizeArPhone(phone);
  if (!num) return;
  try { await env.DB.prepare('DELETE FROM wa_unreachable_phones WHERE phone = ?').bind(num).run(); } catch (_) {}
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

// ===== Auto-respuesta del minicurso (regalos) =====
// Cuando un contacto ESCRIBE pidiendo la guía + cotizador del minicurso, le
// respondemos automáticamente con el link de regalos. Es respuesta dentro de la
// ventana de 24h (mensaje libre, no template — el link va sin restricción).
// Detección por palabras clave (normalizado, sin acentos).
function matchMinicursoTrigger(text) {
  const t = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return t.includes('cotizador') && t.includes('guia') && t.includes('curso');
}

// ===== Campaña de cursos (broadcast lanzamiento mayo) =====
const CURSOS_EVENTO_MSG = 'aah buenísimo! Te escribía para invitarte a un nuevo evento en vivo este próximo martes 9 y jueves 11 de junio, los chicos van a hacer algo muuy copado ahora que arranca el mundial\n\nTe gustaría participar?';

// Clasifica con IA la respuesta del cliente al template de cursos: positiva o no.
async function analyzeResponseSentiment(env, texto) {
  const t = String(texto || '').trim();
  if (!t || !env.ANTHROPIC_API_KEY) return 'no_positiva';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 8,
        system: 'A un contacto se le preguntó si participó de unas clases en vivo y si quiere recibir info/regalo de un curso de carteles de neón. Clasificá su RESPUESTA. Respondé SOLO una palabra: POSITIVA (acepta, le interesa, dice que sí, pide la info, responde con entusiasmo) o NEGATIVA (rechaza, no le interesa, pide que no le escriban, desconfía, o es ambiguo/irrelevante).',
        messages: [{ role: 'user', content: t.slice(0, 500) }]
      })
    });
    const j = await r.json();
    if (!r.ok) return 'no_positiva';
    return (j.content?.[0]?.text || '').toUpperCase().includes('POSITIVA') ? 'positiva' : 'no_positiva';
  } catch (e) { return 'no_positiva'; }
}

// Sentiment del feedback del minicurso. Como el regalo ya está prometido/ganado,
// somos GENEROSOS: en duda → positiva. Solo 'no_positiva' si es claramente
// hostil/spam/rechazo, o si la IA no está disponible (ahí lo maneja Abril).
async function analyzeMinicursoFeedback(env, texto) {
  const t = String(texto || '').trim();
  if (!t || !env.ANTHROPIC_API_KEY) return 'no_positiva';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 8,
        system: 'A un contacto que vio un minicurso de carteles de neón se le prometió un regalo (cotizador + guía) y se le preguntó qué le pareció el curso. Hay que decidir si le mandamos el regalo automáticamente. Como el regalo ya está prometido, sé GENEROSO. Respondé SOLO una palabra: NEGATIVA únicamente si la respuesta es claramente hostil, un insulto, spam, número equivocado, o pide que no le escriban. En cualquier otro caso (feedback, agradecimiento, una pregunta, algo neutral o ambiguo) respondé POSITIVA.',
        messages: [{ role: 'user', content: t.slice(0, 500) }]
      })
    });
    const j = await r.json();
    if (!r.ok) return 'no_positiva';
    return (j.content?.[0]?.text || '').toUpperCase().includes('NEGATIVA') ? 'no_positiva' : 'positiva';
  } catch (e) { return 'no_positiva'; }
}

// Procesa la respuesta de un lead de la campaña: si el chat está oculto, analiza
// el sentiment, manda el mensaje del evento SOLO si es positiva, y revela el
// chat a la bandeja de Abril (responda lo que responda).
// Cliente responde al template 1 de la campaña de cursos: en vez de analizar
// el primer mensaje con IA al toque (que ignoraba mensajes siguientes y podía
// clasificar mal por "hola"), RESERVAMOS la respuesta con analyze_due_at de
// 2 min. Cuando vence el plazo, processCursosCampaignPending junta TODOS los
// mensajes inbound del cliente desde sent_1_at, los manda a la IA, y decide
// si encolar el mensaje del evento o solo revelar el chat a Abril.
async function revealCursosCampaign(env, phone, msgBody) {
  if (!phone) return;
  const now = new Date().toISOString();
  const analyzeDueAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  // Claim ATÓMICO: marcamos responded_at + analyze_due_at solo si aún no
  // estaba respondida. Mensajes siguientes del cliente NO modifican esta
  // fila (responded_at NOT NULL = no entra al WHERE). Quedan en wa_messages
  // y los lee el cron cuando junta el texto agregado.
  try {
    await env.DB.prepare(
      "UPDATE wa_cursos_campaign SET responded_at = ?, analyze_due_at = ?, updated_at = ? WHERE phone = ? AND responded_at IS NULL AND revealed_at IS NULL"
    ).bind(now, analyzeDueAt, now, phone).run();
  } catch (_) { /* best-effort */ }
}

// Cron (*/1): procesa el goteo del broadcast de cursos. La cola se carga vía
// POST /admin/wa/cursos-broadcast-schedule, que inserta filas en
// wa_autoreply_log con kind='cursos_broadcast', status='queued' y due_at
// distribuido en una ventana. Este cron busca los que vencen, manda el
// template (cursos_clases_vivo_mayo con primerNombre) y replica todas las
// acciones que hace el endpoint sincrónico de broadcast: insert en
// wa_messages, INSERT en wa_cursos_campaign, etiqueta 'form 6 y 7 de mayo',
// y oculta el chat (inbox='oculto') hasta que el cliente responda.
async function processCursosBroadcastQueue(env) {
  if (await isWaBillingBlocked(env)) return; // pausado por bloqueo de pago de WhatsApp
  try {
    const nowIso = new Date().toISOString();
    // Floor de 6 hs (no procesamos colas muy viejas — si el worker estuvo down).
    const floorIso = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const rs = await env.DB.prepare(
      "SELECT phone, sender_name FROM wa_autoreply_log " +
      "WHERE kind = 'cursos_broadcast' AND status = 'queued' " +
      "  AND due_at <= ? AND due_at >= ? " +
      "ORDER BY due_at ASC LIMIT 3"
    ).bind(nowIso, floorIso).all();
    if (!rs.results?.length) return;
    // Etiqueta de la campaña (creada al primer broadcast).
    let formLabelId = 24;
    try { const lr = await env.DB.prepare("SELECT id FROM labels WHERE name = 'form 6 y 7 de mayo'").first(); if (lr?.id) formLabelId = lr.id; } catch (_) {}
    for (const row of rs.results) {
      const phone = row.phone;
      const nombre = row.sender_name || '';
      // Claim atómico: 'queued' → 'sending'. Si otro tick ya lo agarró, skip.
      let claim;
      try {
        claim = await env.DB.prepare(
          "UPDATE wa_autoreply_log SET status = 'sending' WHERE phone = ? AND kind = 'cursos_broadcast' AND status = 'queued'"
        ).bind(phone).run();
      } catch (_) { continue; }
      if (!claim?.meta?.changes) continue;
      // Skip si el phone está marcado como unreachable (puede haberse marcado
      // después de encolar). Marca como 'skipped' y sigue.
      if (await isUnreachable(env, phone)) {
        try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'skipped', sent_at = ? WHERE phone = ? AND kind = 'cursos_broadcast'").bind(new Date().toISOString(), phone).run(); } catch (_) {}
        continue;
      }
      const primerNombre = capitalizeName((nombre || '').split(/\s+/)[0]) || 'amigo/a';
      const tpl = await waSendTemplate(env, phone, 'cursos_clases_vivo_mayo', 'es_AR', [primerNombre]);
      if (!tpl?.ok) {
        // Si falla, revertir a queued para reintento. waSend ya marcó
        // unreachable si el error code lo amerita (al próximo tick, isUnreachable
        // arriba lo va a skipear).
        try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'queued' WHERE phone = ? AND kind = 'cursos_broadcast'").bind(phone).run(); } catch (_) {}
        continue;
      }
      const ts = new Date().toISOString();
      const wamid = tpl.id || '';
      try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'sent', sent_at = ? WHERE phone = ? AND kind = 'cursos_broadcast'").bind(ts, phone).run(); } catch (_) {}
      const previewBody = `holaa ${primerNombre}! Cómo andás?\nSoy Abril, de Neon Infinito. Me dijeron los chicos que participaste de las clases en vivo que hicieron el 6 y 7 de mayo, puede ser?`;
      if (wamid) {
        try {
          await env.DB.prepare(
            `INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id)
             VALUES (?, ?, 'outbound', ?, '', 'template', ?, 'sent', '')
             ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'template'
               WHERE wa_messages.body IS NULL OR wa_messages.body = '' OR wa_messages.msg_type = 'status'`
          ).bind(ts, wamid, phone, previewBody).run();
        } catch (_) {}
      }
      // Ocultar el chat hasta que el cliente responda.
      try { await env.DB.prepare("INSERT INTO wa_chats_summary (phone, inbox, updated_at) VALUES (?, 'oculto', ?) ON CONFLICT(phone) DO UPDATE SET inbox = 'oculto'").bind(phone, ts).run(); } catch (_) {}
      // Registrar en la campaña.
      try { await env.DB.prepare("INSERT INTO wa_cursos_campaign (phone, nombre, sent_1_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(phone) DO UPDATE SET sent_1_at = excluded.sent_1_at, updated_at = excluded.updated_at").bind(phone, nombre, ts, ts).run(); } catch (_) {}
      // Etiquetar.
      try { await env.DB.prepare("INSERT OR IGNORE INTO contact_labels (phone, label_id, created_at) VALUES (?, ?, ?)").bind(phone, formLabelId, ts).run(); } catch (_) {}
    }
  } catch (_) { /* best-effort */ }
}

// Cron (*/1): recupera media (imagenes/videos/audios/docs/stickers) cuyo
// downloadMedia falló en el handler del webhook. Causa típica: race con Meta —
// el webhook del msg llega antes de que el media esté disponible en su API, así
// que el primer fetch da 404 o info.url=null, y queda guardado el media_id raw
// en wa_messages.media_url en vez de la R2 key "wa/...".
//
// Filtro de tiempo: solo reintentamos los últimos 2 hs. Más viejo que eso, el
// media ya caducó en Meta (URLs temporales) — reintentarlos solo gasta cuota.
// Idempotente: si downloadMedia funciona, actualizamos media_url a la R2 key
// y la próxima corrida no lo trae más.
async function processPendingMedia(env) {
  if (!env.MEDIA) return;
  try {
    // Ventana de 24h (antes 2h): la media de 360dialog puede tardar en estar
    // disponible o el worker pudo estar saturado; 24h da margen sin reintentar
    // eternamente media ya caducada.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rs = await env.DB.prepare(
      "SELECT id, media_url FROM wa_messages " +
      "WHERE msg_type IN ('image','video','audio','document','sticker') " +
      "  AND media_url GLOB '[0-9]*' AND length(media_url) > 8 " +
      "  AND ts >= ? " +
      "ORDER BY id DESC LIMIT 60"
    ).bind(cutoff).all();
    for (const row of (rs.results || [])) {
      try {
        const result = await downloadMedia(env, row.media_url);
        if (result) {
          await env.DB.prepare('UPDATE wa_messages SET media_url = ? WHERE id = ?').bind(result.key, row.id).run();
        }
      } catch (_) { /* siguiente */ }
    }
  } catch (_) { /* best-effort */ }
}

// Cron: procesa las respuestas pendientes de la campaña de cursos cuando vence
// la ventana de 2 min. Junta TODOS los mensajes inbound del cliente desde
// sent_1_at, los manda a la IA, decide: positiva → encola cursos_evento;
// no positiva → revela el chat a Abril sin mensaje.
async function processCursosCampaignPending(env) {
  try {
    const nowIso = new Date().toISOString();
    const rs = await env.DB.prepare(
      "SELECT phone, sent_1_at FROM wa_cursos_campaign WHERE analyze_due_at IS NOT NULL AND analyze_due_at <= ? AND sentiment IS NULL LIMIT 25"
    ).bind(nowIso).all();
    for (const row of (rs.results || [])) {
      const phone = row.phone;
      // Claim atómico para evitar análisis duplicado entre ticks: pasamos
      // sentiment a 'analyzing' (temporal). Solo una invocación lo logra.
      let claim;
      try {
        claim = await env.DB.prepare(
          "UPDATE wa_cursos_campaign SET sentiment = 'analyzing' WHERE phone = ? AND sentiment IS NULL"
        ).bind(phone).run();
      } catch (_) { continue; }
      if (!claim?.meta?.changes) continue;
      // Juntar todos los msgs inbound del cliente desde sent_1_at.
      const anchor = row.sent_1_at || '';
      const msgs = await env.DB.prepare(
        "SELECT body FROM wa_messages WHERE phone = ? AND direction = 'inbound' AND msg_type != 'reaction' AND ts > ? AND body != '' ORDER BY ts ASC LIMIT 20"
      ).bind(phone, anchor).all();
      const combinedText = (msgs.results || []).map(m => String(m.body || '').trim()).filter(Boolean).join(' · ');
      let sentiment = 'no_positiva';
      if (combinedText) sentiment = await analyzeResponseSentiment(env, combinedText);
      try { await env.DB.prepare("UPDATE wa_cursos_campaign SET sentiment = ? WHERE phone = ?").bind(sentiment, phone).run(); } catch (_) {}
      const now = new Date().toISOString();
      if (sentiment === 'positiva') {
        // Encolar el mensaje del evento con demora (~30s). processAutoReplyQueue
        // lo manda y RECIÉN AHÍ revela el chat a Abril.
        const dueAt = new Date(Date.now() + 30 * 1000).toISOString();
        try {
          await env.DB.prepare(
            "INSERT OR IGNORE INTO wa_autoreply_log (phone, kind, sent_at, status, due_at, sender_name) VALUES (?, 'cursos_evento', '', 'queued', ?, '')"
          ).bind(phone, dueAt).run();
        } catch (_) {}
      } else {
        // No positiva → revelar al toque a Abril, sin mensaje.
        try { await env.DB.prepare("UPDATE wa_chats_summary SET inbox = 'cursos' WHERE phone = ?").bind(phone).run(); } catch (_) {}
        try { await env.DB.prepare("UPDATE wa_cursos_campaign SET revealed_at = ?, updated_at = ? WHERE phone = ?").bind(now, now, phone).run(); } catch (_) {}
      }
    }
  } catch (e) { /* best-effort */ }
}

// Cron: follow-up (template 2) a los que NO respondieron al template 1 hace ≥12h.
// Una sola vez por contacto. El chat sigue oculto hasta que respondan.
async function processCursosFollowup(env) {
  if (await isWaBillingBlocked(env)) return; // pausado por bloqueo de pago de WhatsApp
  try {
    const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const rs = await env.DB.prepare(
      "SELECT phone, nombre FROM wa_cursos_campaign " +
      "WHERE responded_at IS NULL AND followup_at IS NULL AND sent_1_at IS NOT NULL AND sent_1_at <= ? " +
      "  AND phone NOT IN (SELECT phone FROM wa_unreachable_phones) " +
      "ORDER BY sent_1_at ASC LIMIT 30"
    ).bind(cutoff).all();
    for (const row of (rs.results || [])) {
      const phone = row.phone;
      // primerNombre puede ser '' (sin nombre conocido) — NO usar fallback "amigo/a",
      // queda impersonal. Si no hay nombre, usamos el template _anon (sin variable).
      const primerNombre = capitalizeName((row.nombre || '').split(/\s+/)[0]);
      const now = new Date().toISOString();
      // Reservar el follow-up ANTES de mandar (evita doble envío entre crons).
      // Si el cliente respondió justo, responded_at != NULL → no se actualiza.
      const upd = await env.DB.prepare(
        "UPDATE wa_cursos_campaign SET followup_at = ?, updated_at = ? WHERE phone = ? AND followup_at IS NULL AND responded_at IS NULL"
      ).bind(now, now, phone).run();
      if (!upd?.meta?.changes) continue;
      // Dos templates: con nombre y sin nombre. Si todavía no aprobaron el _anon,
      // el send fallará → liberamos followup_at y reintentamos en el próximo ciclo.
      let tpl, previewBody;
      if (primerNombre) {
        tpl = await waSendTemplate(env, phone, 'cursos_followup_clases_mayo', 'es_AR', [primerNombre]);
        previewBody = `Holaa ${primerNombre}! Quedó algo pendiente de las clases del 6 y 7 de mayo 🎁. Queres que te mande la info?`;
      } else {
        tpl = await waSendTemplate(env, phone, 'cursos_followup_clases_mayo_anon_v2', 'es_AR', []);
        previewBody = `Buenass! Quedó algo pendiente de las clases del 6 y 7 de mayo 🎁. Queres que te mande la info?`;
      }
      if (tpl?.ok) {
        const wamid = tpl.id || '';
        if (wamid) {
          try {
            await env.DB.prepare(
              `INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id)
               VALUES (?, ?, 'outbound', ?, '', 'template', ?, 'sent', '')
               ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'template'
                 WHERE wa_messages.body IS NULL OR wa_messages.body = '' OR wa_messages.msg_type = 'status'`
            ).bind(new Date().toISOString(), wamid, phone, previewBody).run();
          } catch (_) {}
        }
      } else {
        // Falló el envío → liberar el follow-up para reintentar en otro ciclo.
        try { await env.DB.prepare("UPDATE wa_cursos_campaign SET followup_at = NULL WHERE phone = ?").bind(phone).run(); } catch (_) {}
      }
    }
  } catch (e) { /* best-effort */ }
}

const MINICURSO_REGALO_LINK = 'https://drive.google.com/drive/folders/14q3QvLPY6vO9d0qSLN-O7X0KxPmmIkW0';

// Responde una sola vez por contacto (dedup por el link en outbound previo),
// guarda el outbound en el CRM y deriva el chat a la bandeja de cursos (Abril).
async function maybeAutoReplyMinicurso(env, phone, senderName) {
  if (!phone) return;
  try {
    // Dedup ATÓMICO: reservamos el envío en wa_autoreply_log (PK phone+kind).
    // Si el webhook del mismo mensaje llega 2 veces casi simultáneo, solo una
    // ejecución obtiene changes=1; las demás (changes=0) NO duplican.
    // ENCOLAR con demora (~1-2 min) en vez de responder al instante, para que no
    // quede robótico. Reserva ATÓMICA por PK (phone, kind): si el webhook del
    // mismo mensaje llega 2 veces, solo una obtiene changes=1; las demás NO
    // duplican. El cron (processAutoReplyQueue) lo manda cuando vence due_at.
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const dueAt = new Date(nowMs + 60 * 1000).toISOString(); // +60s → con el cron */1 sale en ~1-2 min
    let reserva;
    try {
      reserva = await env.DB.prepare(
        "INSERT OR IGNORE INTO wa_autoreply_log (phone, kind, sent_at, status, due_at, sender_name) VALUES (?, 'minicurso', '', 'queued', ?, ?)"
      ).bind(phone, dueAt, senderName || '').run();
    } catch (_) { return; }
    if (!reserva?.meta?.changes) return; // ya en cola o ya enviado → no duplicar
    // Derivar el chat a la bandeja de cursos al instante (la respuesta sale con
    // demora, pero el chat ya aparece en la bandeja de Abril).
    try {
      await env.DB.prepare(
        "INSERT INTO wa_chats_summary (phone, inbox, updated_at) VALUES (?, 'cursos', ?) ON CONFLICT(phone) DO UPDATE SET inbox = 'cursos'"
      ).bind(phone, nowIso).run();
    } catch (_) {}
  } catch (e) { /* best-effort, no rompe el webhook */ }
}

// Cuando llega el PRIMER mensaje del cliente como respuesta al gate de feedback
// del minicurso, en vez de analizar al toque (que ignoraba mensajes siguientes
// del cliente porque la reserva atómica bloqueaba el reanálisis), RESERVAMOS
// con un wait_until de ~2 min para darle tiempo al cliente a tipear todo lo
// que quiera. Cuando ese wait_until vence, processMinicursoGiftPending agrupa
// TODOS los mensajes del cliente posteriores al template, los manda a la IA y
// decide. Una sola vez por contacto (dedup atómico 'minicurso_gift').
async function maybeSendMinicursoGift(env, phone, msgBody, inboundTs) {
  if (!phone || !msgBody) return;
  try {
    const ar = await env.DB.prepare(
      "SELECT sent_at FROM wa_autoreply_log WHERE phone = ? AND kind = 'minicurso' AND status = 'sent' AND sent_at != '' LIMIT 1"
    ).bind(phone).first();
    if (!ar || !ar.sent_at) return;
    if (!(String(inboundTs) > String(ar.sent_at))) return;
    // Reserva ATÓMICA con due_at = ahora + 2 min. NO analizamos todavía.
    // Si el cliente manda 5 mensajes seguidos, los 5 inbound siguientes
    // intentan el INSERT pero solo el primero gana → el resto NO modifica
    // la fila. La IA leerá los 5 mensajes cuando el cron procese al vencer.
    const dueAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    try {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO wa_autoreply_log (phone, kind, sent_at, status, due_at, sender_name) VALUES (?, 'minicurso_gift', '', 'waiting_msgs', ?, '')"
      ).bind(phone, dueAt).run();
    } catch (_) { /* ignore */ }
  } catch (e) { /* best-effort */ }
}

// Cron que procesa las reservas 'waiting_msgs' del minicurso_gift cuya ventana
// de 2 min venció. Agrupa TODOS los mensajes inbound del cliente desde el
// sent_at del template del minicurso (es decir, todo lo que tipeó en esos
// 2 min) y manda el texto concatenado a la IA. Si POSITIVA → encola el regalo
// para envío. Si no → skip (lo maneja Abril manualmente).
async function processMinicursoGiftPending(env) {
  try {
    const nowIso = new Date().toISOString();
    const rs = await env.DB.prepare(
      "SELECT phone FROM wa_autoreply_log WHERE kind = 'minicurso_gift' AND status = 'waiting_msgs' AND due_at <= ? LIMIT 25"
    ).bind(nowIso).all();
    for (const row of (rs.results || [])) {
      const phone = row.phone;
      // Claim atómico: pasamos a 'analyzing' para que dos invocaciones del cron
      // no analicen el mismo chat dos veces (doble llamada a Claude = doble gasto).
      let claim;
      try {
        claim = await env.DB.prepare(
          "UPDATE wa_autoreply_log SET status = 'analyzing' WHERE phone = ? AND kind = 'minicurso_gift' AND status = 'waiting_msgs'"
        ).bind(phone).run();
      } catch (_) { continue; }
      if (!claim?.meta?.changes) continue;
      // Buscar el sent_at del template del minicurso (anchor).
      const anchor = await env.DB.prepare(
        "SELECT sent_at FROM wa_autoreply_log WHERE phone = ? AND kind = 'minicurso' AND status = 'sent' LIMIT 1"
      ).bind(phone).first();
      if (!anchor?.sent_at) {
        try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'skipped' WHERE phone = ? AND kind = 'minicurso_gift'").bind(phone).run(); } catch (_) {}
        continue;
      }
      // Juntar todos los mensajes inbound del cliente posteriores al template.
      // Solo texto utilizable: descartamos reactions y placeholders vacíos.
      const msgs = await env.DB.prepare(
        "SELECT body FROM wa_messages WHERE phone = ? AND direction = 'inbound' AND msg_type != 'reaction' AND ts > ? AND body != '' ORDER BY ts ASC LIMIT 20"
      ).bind(phone, anchor.sent_at).all();
      const combinedText = (msgs.results || []).map(m => String(m.body || '').trim()).filter(Boolean).join(' · ');
      if (!combinedText) {
        // Solo emojis/audios sin transcripción/etc — lo maneja Abril.
        try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'skipped' WHERE phone = ? AND kind = 'minicurso_gift'").bind(phone).run(); } catch (_) {}
        continue;
      }
      const sentiment = await analyzeMinicursoFeedback(env, combinedText);
      if (sentiment !== 'positiva') {
        try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'skipped' WHERE phone = ? AND kind = 'minicurso_gift'").bind(phone).run(); } catch (_) {}
        continue;
      }
      // Positiva → encolar regalo con demora chica (~30s) para que el cliente
      // alcance a leer si llegó algo nuevo justo antes.
      const dueAt = new Date(Date.now() + 30 * 1000).toISOString();
      try {
        await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'queued', due_at = ? WHERE phone = ? AND kind = 'minicurso_gift'").bind(dueAt, phone).run();
      } catch (_) {}
    }
  } catch (e) { /* best-effort */ }
}

// Procesa la cola de auto-respuestas vencidas (lo llama el cron cada minuto).
// Manda el mensaje libre con los regalos, lo guarda en el CRM y marca 'sent'.
// Ventana de reintento de 30 min: si el envío falla (p.ej. fuera de ventana
// 24h) reintenta en los próximos ticks hasta 30 min; después se abandona.
async function processAutoReplyQueue(env) {
  try {
    const nowIso = new Date().toISOString();
    const floorIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    // Procesa minicurso (gate de feedback), minicurso_gift (link de regalos tras
    // respuesta positiva) y cursos_evento. Todos mensaje libre con demora; el
    // evento además REVELA el chat a Abril.
    const rs = await env.DB.prepare(
      "SELECT phone, kind, sender_name FROM wa_autoreply_log WHERE kind IN ('minicurso','minicurso_gift','cursos_evento') AND status = 'queued' AND due_at <= ? AND due_at >= ? ORDER BY due_at ASC LIMIT 25"
    ).bind(nowIso, floorIso).all();
    for (const row of (rs.results || [])) {
      const phone = row.phone;
      // CLAIM ATÓMICO: pasamos la fila a 'sending' antes de enviar. Si dos
      // invocaciones del cron se solapan (1 cron por minuto, send puede tardar),
      // solo una obtiene changes=1 y procesa; la otra se saltea y evita el doble
      // envío que vimos en algunos chats. Si waSendText falla, revertimos a
      // 'queued' para que el próximo tick reintente dentro de la ventana.
      let claim;
      try {
        claim = await env.DB.prepare(
          "UPDATE wa_autoreply_log SET status = 'sending' WHERE phone = ? AND kind = ? AND status = 'queued'"
        ).bind(phone, row.kind).run();
      } catch (_) { continue; }
      if (!claim?.meta?.changes) continue; // ya lo tomó otro tick
      let body;
      if (row.kind === 'minicurso') {
        const nombre = (row.sender_name || '').trim().split(/\s+/)[0] || '';
        const saludo = nombre ? `Buenas ${nombre}!` : 'Buenas!';
        // Nuevo flujo: NO mandamos el link de una. Prometemos los regalos pero
        // pedimos feedback del curso PRIMERO. El link se manda en 'minicurso_gift'
        // cuando el lead responde y la IA lo evalúa como positiva.
        body = `${saludo} Ahora te paso los regalos (Cotizador + Guía de Producción). Pero antes, contanos qué te pareció el nuevo Curso! Viste la 2da clase hasta el final?`;
      } else if (row.kind === 'minicurso_gift') {
        body = `genial entoncees, acá te mando los regalos (cotizador automático + guía de producción) por ver hasta el final! 👇🏼\n${MINICURSO_REGALO_LINK}`;
      } else {
        body = CURSOS_EVENTO_MSG;
      }
      const res = await waSendText(env, phone, body);
      if (!res?.ok) {
        // Revertir a 'queued' para reintento en el siguiente tick
        try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'queued' WHERE phone = ? AND kind = ?").bind(phone, row.kind).run(); } catch (_) {}
        continue;
      }
      await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'sent', sent_at = ? WHERE phone = ? AND kind = ?").bind(new Date().toISOString(), phone, row.kind).run();
      const wamid = res.id || '';
      if (wamid) {
        try {
          await env.DB.prepare(
            `INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id)
             VALUES (?, ?, 'outbound', ?, '', 'text', ?, 'sent', '')
             ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'text'
               WHERE wa_messages.body IS NULL OR wa_messages.body = '' OR wa_messages.msg_type = 'status'`
          ).bind(new Date().toISOString(), wamid, phone, body).run();
        } catch (_) {}
      }
      // El evento de cursos: recién acá (tras mandarlo) se revela el chat a Abril.
      if (row.kind === 'cursos_evento') {
        const ts2 = new Date().toISOString();
        try { await env.DB.prepare("UPDATE wa_chats_summary SET inbox = 'cursos' WHERE phone = ?").bind(phone).run(); } catch (_) {}
        try { await env.DB.prepare("UPDATE wa_cursos_campaign SET revealed_at = ?, updated_at = ? WHERE phone = ?").bind(ts2, ts2, phone).run(); } catch (_) {}
      }
    }
  } catch (e) { /* best-effort */ }
}

// Cron: follow-up del minicurso. Si pasaron ≥4h desde que mandamos el mensaje de
// los regalos y el lead NO respondió, le mandamos un recordatorio (una sola vez).
// Solo se llama en horario hábil AR (8-20), así nunca sale de madrugada.
// Ventana 4–24h: el límite de 24h evita (a) mandar a contactos históricos que el
// backfill cargó en wa_autoreply_log y (b) caer fuera de la ventana libre de 24h.
async function processMinicursoFollowup(env) {
  if (await isWaBillingBlocked(env)) return; // pausado por bloqueo de pago de WhatsApp
  try {
    const cutoffHigh = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();  // ≥4h
    const cutoffLow  = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // ≤24h
    const rs = await env.DB.prepare(
      `SELECT a.phone, a.sent_at FROM wa_autoreply_log a
       WHERE a.kind = 'minicurso' AND a.status = 'sent' AND a.sent_at != ''
         AND a.sent_at <= ? AND a.sent_at >= ?
         AND NOT EXISTS (SELECT 1 FROM wa_autoreply_log f WHERE f.phone = a.phone AND f.kind = 'minicurso_followup')
         AND a.phone NOT IN (SELECT phone FROM wa_unreachable_phones)
       ORDER BY a.sent_at ASC LIMIT 30`
    ).bind(cutoffHigh, cutoffLow).all();
    for (const row of (rs.results || [])) {
      const phone = row.phone;
      const now = new Date().toISOString();
      // ¿Respondió DESPUÉS de que le mandamos los regalos? Si sí, no molestamos.
      const resp = await env.DB.prepare(
        "SELECT 1 FROM wa_messages WHERE phone = ? AND direction = 'inbound' AND ts > ? LIMIT 1"
      ).bind(phone, row.sent_at).first();
      if (resp) {
        // Marca 'skipped' para no volver a evaluar este contacto.
        try {
          await env.DB.prepare(
            "INSERT OR IGNORE INTO wa_autoreply_log (phone, kind, sent_at, status, due_at, sender_name) VALUES (?, 'minicurso_followup', ?, 'skipped', '', '')"
          ).bind(phone, now).run();
        } catch (_) {}
        continue;
      }
      // Reserva ATÓMICA antes de mandar (evita doble envío entre ticks del cron).
      let reserva;
      try {
        reserva = await env.DB.prepare(
          "INSERT OR IGNORE INTO wa_autoreply_log (phone, kind, sent_at, status, due_at, sender_name) VALUES (?, 'minicurso_followup', '', 'queued', '', '')"
        ).bind(phone).run();
      } catch (_) { continue; }
      if (!reserva?.meta?.changes) continue; // otro tick lo reservó
      const body = 'buenas buenas! Acá Abril de Neon infinito. Pudiste ver el mensaje?';
      const res = await waSendText(env, phone, body);
      if (!res?.ok) {
        // Falló (transitorio, o fuera de ventana 24h) → liberar para reintentar.
        try { await env.DB.prepare("DELETE FROM wa_autoreply_log WHERE phone = ? AND kind = 'minicurso_followup' AND status = 'queued'").bind(phone).run(); } catch (_) {}
        continue;
      }
      try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'sent', sent_at = ? WHERE phone = ? AND kind = 'minicurso_followup'").bind(now, phone).run(); } catch (_) {}
      const wamid = res.id || '';
      if (wamid) {
        try {
          await env.DB.prepare(
            `INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id)
             VALUES (?, ?, 'outbound', ?, '', 'text', ?, 'sent', '')
             ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'text'
               WHERE wa_messages.body IS NULL OR wa_messages.body = '' OR wa_messages.msg_type = 'status'`
          ).bind(now, wamid, phone, body).run();
        } catch (_) {}
      }
    }
  } catch (e) { /* best-effort */ }
}

// ===== Análisis de conversaciones con Claude (Anthropic API) =====
// El system prompt vive como constante para versionarlo. Cuando se cambia,
// bumpear ANALYSIS_PROMPT_VERSION para que el cron sepa que tiene que
// re-analizar conversaciones aunque ya tengan análisis previo.
const ANALYSIS_PROMPT_VERSION = 2;
const ANALYSIS_SYSTEM_PROMPT = `Sos un analista experto en ventas de Neon Infinito, empresa argentina con DOS verticales completamente distintos:

1) **CARTELES**: venta de carteles personalizados de neón LED a particulares, locales comerciales, eventos, etc. Ciclo: cliente pide presupuesto → recibe cotización → seña 50% → producción → envío. Objeción principal típica: precio.
2) **CURSOS**: curso de fabricación de carteles de neón (online o presencial, con kit incluido). Ciclo: cliente pide info → recibe modalidad/precio → paga → recibe acceso/material. Objeciones típicas: dudas de modalidad, financiación.

Estos dos verticales tienen ciclos, objeciones, intent signals y customer profiles COMPLETAMENTE distintos. Identificá primero cuál es y aplicá el marco correspondiente.

Devolvé SOLO un JSON válido (sin markdown, sin code blocks, sin texto extra), con este schema EXACTO:

{
  "outcome": "sold" | "lost" | "abandoned_by_client" | "in_progress" | "spam",
  "outcome_reason": "string corto",
  "product_type": "cartel_personalizado" | "curso" | "franquicia" | "tercerizacion" | "otro",
  "product_details": "string descriptivo del producto/curso solicitado",
  "vertical": "particular" | "local" | "franquicia" | "evento" | "tercerizacion" | "alumno_curso" | "otro",
  "customer_profile": "string corto: perfil del cliente",
  "intent_signals": ["array — VER LISTAS NORMALIZADAS ABAJO"],
  "objections": ["array — VER LISTAS NORMALIZADAS ABAJO"],
  "key_questions": ["array de 3-5 preguntas literales más importantes del cliente"],
  "ad_source_inferred": "string solo si cliente cita ad/copy; sino ''",
  "joaco_approach": "string: cómo respondió Joaco/equipo (tiempos, tono, upsells)",
  "what_worked": "string: qué cerró/avanzó la venta",
  "what_didnt": "string: qué frenó",
  "sentiment_final": "positive" | "neutral" | "negative",
  "next_action": "string: qué hacer ahora",
  "confidence": "low" | "medium" | "high"
}

CRÍTICO — USAR SOLO ESTAS ETIQUETAS NORMALIZADAS según el vertical detectado. NO inventes variantes. Si una situación no encaja, usá la más cercana o omitila.

**Para CARTELES (product_type = "cartel_personalizado" / "tercerizacion" / "franquicia"):**
- objections: precio_alto, tiempo_entrega_largo, no_le_gusto_diseno, dudo_calidad, problema_envio_distancia, presupuesto_limitado, silencio_post_presupuesto, prefiere_otro_proveedor, cambio_de_idea, descuento_no_satisfizo, tamano_no_acordado, no_quiere_pagar_envio
- intent_signals: pidio_presupuesto, mando_foto_referencia, pidio_medidas, especifico_colores, eligio_dimmer, eligio_base_acrilica, pidio_envio, pago_sena, pago_completo, pidio_descuento, urgencia_fecha_evento, pidio_logo_marca, eligio_fondo_transparente, eligio_fondo_negro, pidio_postventa

**Para CURSOS (product_type = "curso"):**
- objections: precio_alto_curso, no_tiene_tarjeta_credito, esperando_proximo_pago, prefiere_aprender_youtube_gratis, dudo_certificacion, distancia_lejos_si_presencial, falta_tiempo_para_curso, prefiere_otra_modalidad, no_esta_seguro_si_le_gustara, problemas_de_pago
- intent_signals: pidio_info_curso, pregunto_modalidad, vio_videos_demo, pregunto_kit_incluido, pregunto_fechas, hizo_pago_parcial, completo_pago, pregunto_descuento_grupo, quiere_segunda_actividad_economica, pregunto_certificacion, pregunto_si_para_hijo, pregunto_acceso_videos_grabados

Reglas de outcome:
- sold: hubo seña/pago/entrega/confirmación EXPLÍCITA de compra.
- lost: cliente decidió NO comprar EXPLÍCITAMENTE.
- abandoned_by_client: dejó de responder sin decisión clara.
- in_progress: negociación activa.
- spam: bot/mensaje sin contexto/número equivocado.

product_details: concreto (medidas/colores/dimensiones para carteles; modalidad/fecha/incluye-kit para cursos). Si no hay info, "".

confidence: 'low' si <3 msgs útiles o información ambigua; 'high' si flow claro.

Respondé SOLO el JSON, sin texto adicional.`;

// Junta el contexto completo de un chat (text+transcripciones+adjuntos) para
// pasar a Claude. Limita a últimos N msgs para no explotar el context window.
async function buildChatContext(env, phone, maxMsgs = 100) {
  const rs = await env.DB.prepare(
    `SELECT ts, direction, msg_type, body, media_url FROM wa_messages
     WHERE phone = ? AND msg_type != 'reaction'
     ORDER BY ts ASC LIMIT ?`
  ).bind(phone, maxMsgs).all();
  const msgs = rs.results || [];
  if (!msgs.length) return null;

  // Buscar también ad attribution si existe — es lo que más le ayuda a Claude
  // para entender de dónde viene el cliente.
  const attrib = await env.DB.prepare(
    `SELECT ad_name, campaign_name, headline, body as ad_body, source_id
     FROM wa_ad_attributions WHERE phone = ? ORDER BY ts ASC LIMIT 1`
  ).bind(phone).first();

  // Contact name (de wa_address_book o de los msgs)
  const contact = await env.DB.prepare(
    `SELECT full_name FROM wa_address_book WHERE phone = ? LIMIT 1`
  ).bind(phone).first();

  // Construir string del chat
  const lines = msgs.map(m => {
    const who = m.direction === 'inbound' ? 'CLIENTE' : 'JOACO';
    let content = m.body || '';
    if (m.msg_type === 'image' && !content.startsWith('[imagen')) content = '[imagen] ' + content;
    if (m.msg_type === 'audio' && !content.startsWith('[audio')) content = '[audio] (sin transcripción)';
    if (m.msg_type === 'document') content = `[documento] ${content}`;
    if (m.msg_type === 'location') content = `[ubicación] ${content}`;
    return `${m.ts} ${who}: ${content}`;
  }).join('\n');

  let header = `## CONVERSACIÓN`;
  if (contact?.full_name) header += `\nCliente: ${contact.full_name} (${phone})`;
  else header += `\nCliente: ${phone}`;
  if (attrib) {
    header += `\nORIGEN: Ad "${attrib.ad_name || attrib.source_id}" (campaña "${attrib.campaign_name || 'N/A'}")`;
    if (attrib.headline) header += `\nAd headline: ${attrib.headline}`;
    if (attrib.ad_body) header += `\nAd copy: ${String(attrib.ad_body).slice(0, 300)}`;
  } else {
    header += `\nORIGEN: sin atribución registrada (capaz viene de orgánico o pre-mayo 2026)`;
  }
  header += `\nTotal msgs: ${msgs.length}\n\n`;

  return {
    fullText: header + lines,
    msgsCount: msgs.length,
    lastMsgTs: msgs[msgs.length - 1].ts,
    attribSourceId: attrib?.source_id || '',
    attribAdName: attrib?.ad_name || '',
    attribCampaignName: attrib?.campaign_name || ''
  };
}

// Llama Anthropic API con el chat de un phone y guarda el análisis.
// modelOverride: 'sonnet' (default) | 'opus' — para casos VIP usar opus.
async function analyzeChatWithClaude(env, phone, modelOverride = 'sonnet') {
  if (!env.ANTHROPIC_API_KEY) {
    return { ok: false, error: 'ANTHROPIC_API_KEY no configurada' };
  }
  // Bloqueo phones internos del equipo: no son clientes, son miembros del
  // equipo (Joaco/Gaspar/Bruno) que se comunican con el número del negocio.
  try {
    const internal = await env.DB.prepare('SELECT phone FROM wa_internal_phones WHERE phone = ?').bind(phone).first();
    if (internal) return { ok: false, error: 'phone interno del equipo, no es cliente — skipeado' };
  } catch (_) {}
  const ctx = await buildChatContext(env, phone);
  if (!ctx) return { ok: false, error: 'sin mensajes para este phone' };

  const model = modelOverride === 'opus'
    ? 'claude-opus-4-5'
    : 'claude-sonnet-4-5';

  try {
    const t0 = Date.now();
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        system: ANALYSIS_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: ctx.fullText }]
      })
    });
    const j = await r.json();
    if (!r.ok) {
      // Guardar el error en histórico para debug
      await env.DB.prepare(
        `INSERT INTO wa_chat_analyses (phone, analyzed_at, model_used, prompt_version, msgs_analyzed, msgs_until_ts, raw_response, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(phone, new Date().toISOString(), model, ANALYSIS_PROMPT_VERSION,
             ctx.msgsCount, ctx.lastMsgTs, JSON.stringify(j).slice(0, 4000),
             j.error?.message || 'HTTP ' + r.status).run();
      return { ok: false, error: j.error?.message || 'HTTP ' + r.status, raw: j };
    }
    const text = j.content?.[0]?.text || '';
    let parsed;
    try {
      // Limpiar posibles wrappers de markdown
      const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      await env.DB.prepare(
        `INSERT INTO wa_chat_analyses (phone, analyzed_at, model_used, prompt_version, msgs_analyzed, msgs_until_ts, raw_response, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(phone, new Date().toISOString(), model, ANALYSIS_PROMPT_VERSION,
             ctx.msgsCount, ctx.lastMsgTs, text.slice(0, 4000),
             'JSON parse error: ' + e.message).run();
      return { ok: false, error: 'JSON parse error', raw: text };
    }

    // Estimación de costo (precios junio 2026, USD)
    const ti = j.usage?.input_tokens || 0;
    const to = j.usage?.output_tokens || 0;
    const cost = model.includes('opus')
      ? (ti * 15 + to * 75) / 1000000
      : (ti * 3 + to * 15) / 1000000;

    // Guardar histórico
    await env.DB.prepare(
      `INSERT INTO wa_chat_analyses (phone, analyzed_at, model_used, prompt_version, msgs_analyzed, msgs_until_ts, raw_response, tokens_in, tokens_out, cost_usd_estimated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(phone, new Date().toISOString(), model, ANALYSIS_PROMPT_VERSION,
           ctx.msgsCount, ctx.lastMsgTs, JSON.stringify(parsed).slice(0, 4000),
           ti, to, cost).run();

    // Upsert en wa_conversations (snapshot vigente)
    const adSrcConfidence = ctx.attribSourceId ? 'high' : (parsed.ad_source_inferred ? 'inferred' : '');
    const adSrcId = ctx.attribSourceId || '';
    const adName = ctx.attribAdName || parsed.ad_source_inferred || '';
    const campaignName = ctx.attribCampaignName || '';

    // Calcular contadores básicos
    const counts = await env.DB.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN direction='inbound' THEN 1 ELSE 0 END) AS inbound,
              SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END) AS outbound,
              MIN(ts) AS first_ts, MAX(ts) AS last_ts
       FROM wa_messages WHERE phone = ? AND msg_type != 'reaction'`
    ).bind(phone).first();

    await env.DB.prepare(
      `INSERT INTO wa_conversations (
        phone, first_msg_ts, last_msg_ts, total_msgs, inbound_count, outbound_count,
        ad_source_id, ad_name, campaign_name, ad_source_confidence,
        outcome, outcome_reason, product_type, product_details, vertical, customer_profile,
        intent_signals, objections, key_questions, joaco_approach, what_worked, what_didnt,
        sentiment_final, next_action, last_analyzed_at, analysis_version, last_model_used,
        confidence, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        first_msg_ts = excluded.first_msg_ts,
        last_msg_ts = excluded.last_msg_ts,
        total_msgs = excluded.total_msgs,
        inbound_count = excluded.inbound_count,
        outbound_count = excluded.outbound_count,
        ad_source_id = excluded.ad_source_id,
        ad_name = excluded.ad_name,
        campaign_name = excluded.campaign_name,
        ad_source_confidence = excluded.ad_source_confidence,
        outcome = excluded.outcome,
        outcome_reason = excluded.outcome_reason,
        product_type = excluded.product_type,
        product_details = excluded.product_details,
        vertical = excluded.vertical,
        customer_profile = excluded.customer_profile,
        intent_signals = excluded.intent_signals,
        objections = excluded.objections,
        key_questions = excluded.key_questions,
        joaco_approach = excluded.joaco_approach,
        what_worked = excluded.what_worked,
        what_didnt = excluded.what_didnt,
        sentiment_final = excluded.sentiment_final,
        next_action = excluded.next_action,
        last_analyzed_at = excluded.last_analyzed_at,
        analysis_version = excluded.analysis_version,
        last_model_used = excluded.last_model_used,
        confidence = excluded.confidence,
        updated_at = excluded.updated_at`
    ).bind(
      phone, counts?.first_ts || '', counts?.last_ts || '', counts?.total || 0,
      counts?.inbound || 0, counts?.outbound || 0,
      adSrcId, adName, campaignName, adSrcConfidence,
      parsed.outcome || '', parsed.outcome_reason || '',
      parsed.product_type || '', parsed.product_details || '',
      parsed.vertical || '', parsed.customer_profile || '',
      JSON.stringify(parsed.intent_signals || []),
      JSON.stringify(parsed.objections || []),
      JSON.stringify(parsed.key_questions || []),
      parsed.joaco_approach || '', parsed.what_worked || '', parsed.what_didnt || '',
      parsed.sentiment_final || '', parsed.next_action || '',
      new Date().toISOString(), ANALYSIS_PROMPT_VERSION, model,
      parsed.confidence || '', new Date().toISOString()
    ).run();

    // Auto-etiquetar el chat según outcome + product_type. El equipo arma
    // campañas de re-engagement con templates DISTINTOS para carteles vs
    // cursos (los ciclos de venta y copy son completamente distintos), por
    // eso separamos en dos labels específicas. Los outcomes 'otro'/sin
    // product_type claro caen a la genérica.
    try {
      if (parsed.outcome === 'abandoned_by_client') {
        let labelName = 'Abandonado IA';
        if (parsed.product_type === 'curso') {
          labelName = 'Abandonado IA · Curso';
        } else if (parsed.product_type === 'cartel_personalizado' ||
                   parsed.product_type === 'tercerizacion' ||
                   parsed.product_type === 'franquicia') {
          labelName = 'Abandonado IA · Cartel';
        }
        const lbl = await env.DB.prepare("SELECT id FROM labels WHERE name = ?").bind(labelName).first();
        if (lbl?.id) {
          await env.DB.prepare(
            "INSERT INTO contact_labels (phone, label_id, created_at) VALUES (?, ?, datetime('now')) ON CONFLICT(phone, label_id) DO NOTHING"
          ).bind(phone, lbl.id).run();
        }
      }
    } catch (_) {}

    return { ok: true, parsed, cost_usd: cost, tokens_in: ti, tokens_out: to, model };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ===== Meta Lead Ads — webhook helpers =====
// Fetch del detalle del lead via Graph API. Requiere META_PAGE_ACCESS_TOKEN
// con permiso leads_retrieval sobre la Page que recibe los leads.
async function fetchLeadDetails(env, leadgenId) {
  if (!env.META_PAGE_ACCESS_TOKEN || !leadgenId) return null;
  try {
    const fields = 'field_data,created_time,form_id,ad_id,adset_id,campaign_id';
    const r = await fetch(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(leadgenId)}?fields=${fields}&access_token=${encodeURIComponent(env.META_PAGE_ACCESS_TOKEN)}`
    );
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

// Mapea form_name + ad_name a una "vertical" para usar como {{2}} en el template.
// Los nombres de los forms B2B son del estilo "b2b - carteles-copy" o "b2b - Reventa";
// los ads agregan más contexto ("Franquicias - resolver - B2B - ..."). Tomamos lo
// que aporte más info.
function inferLeadVertical(formName, adName) {
  const text = ((formName || '') + ' ' + (adName || '')).toLowerCase();
  if (text.includes('franquicia')) return 'franquicias';
  if (text.includes('reventa')) return 'reventa';
  if (text.includes('terceriza')) return 'producir tu marca';
  if (text.includes('evento')) return 'eventos';
  if (text.includes('arquitecto')) return 'arquitectos';
  if (text.includes('pop'))       return 'POP';
  if (text.includes('cartel'))    return 'tu cartel';
  return 'tu negocio';
}

// Extrae los valores típicos del field_data del lead. Meta usa slugs estándar
// (full_name, email, phone_number) pero los custom forms pueden agregar campos
// con otros nombres en español.
function extractLeadFields(fieldData) {
  const out = {};
  for (const fd of (fieldData || [])) {
    const k = (fd.name || '').toLowerCase().trim();
    const v = (fd.values || [])[0] || '';
    out[k] = v;
  }
  const phone = out['phone_number'] || out['telefono'] || out['teléfono'] || out['phone'] || out['celular'] || '';
  const fullName = out['full_name'] || out['nombre_completo'] || out['nombre completo'] || out['name'] || out['nombre'] || '';
  const firstName = (out['first_name'] || fullName).split(/\s+/)[0] || '';
  const email = out['email'] || out['correo'] || '';
  return { phone, firstName, fullName, email, allFields: out };
}

// Helper para loguear errores del flow de leads a wa_webhook_log con prefijo
// LEADS_DEBUG, así podemos diagnosticar sin wrangler tail.
async function _logLeadDebug(env, label, data) {
  try {
    const payload = 'LEADS_DEBUG[' + label + ']: ' + (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 3500);
    await env.DB.prepare('INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)').bind(
      new Date().toISOString(), payload
    ).run();
  } catch (_) { /* swallow — best effort logging */ }
}

// Procesa un payload webhook de leadgen. Por cada change.field='leadgen':
//   1) dedup por leadgen_id en wa_leads (evita doble proceso si Meta reintenta).
//   2) fetch detalle del lead via Graph API.
//   3) extrae teléfono/nombre/email.
//   4) inserta en wa_leads.
//   5) si hay teléfono válido, manda el template lead_b2b_followup.
//   6) guarda el msg saliente en wa_messages para que aparezca en el CRM.
async function processLeadgenWebhook(env, body) {
  try {
  const entries = body?.entry || [];
  await _logLeadDebug(env, 'START', { entries_count: entries.length, has_token: !!env.META_PAGE_ACCESS_TOKEN });
  for (const entry of entries) {
    const changes = entry?.changes || [];
    for (const change of changes) {
      if (change?.field !== 'leadgen') continue;
      const value = change?.value || {};
      const leadgenId = value.leadgen_id;
      await _logLeadDebug(env, 'CHANGE', { field: change.field, leadgen_id: leadgenId, page_id: value.page_id });
      if (!leadgenId) continue;

      // Dedup: si ya está procesado, skip silenciosamente.
      try {
        const existing = await env.DB.prepare('SELECT id FROM wa_leads WHERE leadgen_id = ?').bind(leadgenId).first();
        if (existing) { await _logLeadDebug(env, 'DEDUP_SKIP', { leadgen_id: leadgenId }); continue; }
      } catch (e) {
        await _logLeadDebug(env, 'DEDUP_ERR', { msg: e.message });
      }

      const detail = await fetchLeadDetails(env, leadgenId);
      await _logLeadDebug(env, 'FETCH_DETAIL', { has_detail: !!detail, leadgen_id: leadgenId });
      const tsIso = value.created_time
        ? new Date(parseInt(value.created_time) * 1000).toISOString()
        : (detail?.created_time || new Date().toISOString());

      if (!detail) {
        // Guardamos placeholder para que el lead no se pierda. Se puede reintentar
        // luego con un SELECT WHERE process_error IS NOT EMPTY.
        try {
          await env.DB.prepare(
            `INSERT INTO wa_leads (leadgen_id, ts, received_at, page_id, form_id, ad_id, adset_id, campaign_id, process_error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            leadgenId, tsIso, new Date().toISOString(),
            value.page_id || '', value.form_id || '', value.ad_id || '',
            value.adset_id || '', value.campaign_id || '',
            'failed to fetch lead detail from Graph API (token/permiso?)'
          ).run();
          await _logLeadDebug(env, 'INSERT_PLACEHOLDER_OK', { leadgen_id: leadgenId });
        } catch (e) {
          await _logLeadDebug(env, 'INSERT_PLACEHOLDER_ERR', { msg: e.message });
        }
        continue;
      }

      const { phone: phoneRaw, firstName, fullName, email, allFields } = extractLeadFields(detail.field_data);
      const phoneNorm = normalizeArPhone(phoneRaw) || '';
      const formId = detail.form_id || value.form_id || '';
      const adId = detail.ad_id || value.ad_id || '';
      const adsetId = detail.adset_id || value.adset_id || '';
      const campaignId = detail.campaign_id || value.campaign_id || '';
      const vertical = inferLeadVertical('', '');  // se mejora abajo

      // Estrategia para "vertical": si tenemos form_name lo usamos. Si no, ad name
      // requeriría otro Graph API call. Por ahora usamos heurística simple por
      // form_id si lo tenemos. En una siguiente versión podemos cachear form_name
      // por form_id en una tabla aparte.
      const verticalUsed = inferLeadVertical(allFields['__form_name__'] || '', adId ? `ad_${adId}` : '');

      try {
        await env.DB.prepare(
          `INSERT INTO wa_leads
           (leadgen_id, ts, received_at, page_id, form_id, form_name, ad_id, adset_id, campaign_id,
            phone, phone_raw, first_name, full_name, email, vertical, raw_lead_data, template_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          leadgenId, tsIso, new Date().toISOString(),
          value.page_id || '', formId, '',
          adId, adsetId, campaignId,
          phoneNorm, phoneRaw, firstName, fullName, email,
          verticalUsed,
          JSON.stringify(detail.field_data || []).slice(0, 4000),
          phoneNorm ? 'pending' : 'skipped'
        ).run();
      } catch (e) {
        // INSERT podría fallar por race condition (otro tick procesando mismo lead).
        // Si UNIQUE constraint falla, dejamos pasar.
        continue;
      }

      // Sin teléfono válido → no podemos mandar template, marcamos skipped.
      if (!phoneNorm) {
        try {
          await env.DB.prepare('UPDATE wa_leads SET template_error = ? WHERE leadgen_id = ?').bind(
            'telefono invalido o vacio: ' + phoneRaw, leadgenId
          ).run();
        } catch (_) {}
        continue;
      }

      // Mandar template lead_b2b_followup con (firstName,). Sin {{2}}: el copy
      // del template es genérico para carteles, no segmentado por vertical.
      const tplResult = await waSendTemplate(env, phoneNorm, 'lead_b2b_followup', 'es_AR', [
        firstName || 'amigo/a'
      ]);

      if (tplResult?.ok) {
        const wamid = tplResult.id || '';
        try {
          await env.DB.prepare(
            'UPDATE wa_leads SET template_status = ?, template_sent_at = ?, wamid = ? WHERE leadgen_id = ?'
          ).bind('sent', new Date().toISOString(), wamid, leadgenId).run();
        } catch (_) {}

        // Guardar el outbound en wa_messages para que aparezca en el CRM como
        // primer mensaje de la conversación. El body es el copy real (lo que
        // recibió el lead), con {{1}} reemplazado por el firstName.
        try {
          const previewBody = `Holaa ${firstName || 'amigo/a'}, por aca Joaco de Neon Infinito! Nos llego tu formulario para presupuestar carteles! Tenes un diseño/imagen de referencia para pasarnos asi te lo cotizamos?`;
          // UPSERT por wamid: si el status (sent/delivered) ya creó la fila vacía,
          // completamos el body + msg_type en vez de fallar por el UNIQUE de wamid.
          if (wamid) {
            await env.DB.prepare(
              `INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id)
               VALUES (?, ?, 'outbound', ?, '', 'template', ?, 'sent', '')
               ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'template'
                 WHERE wa_messages.body IS NULL OR wa_messages.body = '' OR wa_messages.msg_type = 'status'`
            ).bind(new Date().toISOString(), wamid, phoneNorm, previewBody).run();
          }
        } catch (_) {}
        // Etiquetar el chat como FORM (lead de formulario B2B), id de label = 12.
        try {
          await env.DB.prepare('INSERT OR IGNORE INTO contact_labels (phone, label_id, created_at) VALUES (?, 12, ?)').bind(phoneNorm, new Date().toISOString()).run();
        } catch (_) {}
      } else {
        try {
          await env.DB.prepare(
            'UPDATE wa_leads SET template_status = ?, template_error = ? WHERE leadgen_id = ?'
          ).bind('failed', JSON.stringify(tplResult || {}).slice(0, 500), leadgenId).run();
        } catch (_) {}
      }
    }
  }
  await _logLeadDebug(env, 'END', { ok: true });
  } catch (err) {
    await _logLeadDebug(env, 'FATAL', { message: err?.message, stack: (err?.stack || '').slice(0, 1500) });
  }
}

// Procesa un lead que llegó desde la Google Sheet (via Apps Script onChange).
// Workaround mientras App Review aprueba leads_retrieval: Meta sincroniza leads
// a la Sheet nativamente (sin requerir review), y el Apps Script nos manda
// cada fila nueva como webhook a /webhook/sheet-lead.
// El payload trae row_data como objeto {columna: valor} con TODAS las columnas
// de la sheet. Mapeo a los campos canónicos de wa_leads.
async function processSheetLead(env, body) {
  try {
    const row = body?.row_data || {};
    await _logLeadDebug(env, 'SHEET_START', { keys: Object.keys(row), sheet_id: body?.sheet_id, row_index: body?.row_index });

    // Mapeo de campos de la sheet a los nuestros. Meta usa nombres estándar
    // (id, full_name, phone_number, email) y a veces agrega campos custom del form.
    const lcRow = {};
    for (const k of Object.keys(row)) lcRow[String(k).toLowerCase().trim()] = row[k];

    const leadgenId = String(lcRow['id'] || lcRow['lead_id'] || lcRow['leadgen_id'] || '').trim();
    if (!leadgenId) {
      await _logLeadDebug(env, 'SHEET_NO_ID', { row });
      return;
    }

    // Dedup con la misma tabla wa_leads (key única = leadgen_id).
    try {
      const existing = await env.DB.prepare('SELECT id FROM wa_leads WHERE leadgen_id = ?').bind(leadgenId).first();
      if (existing) { await _logLeadDebug(env, 'SHEET_DEDUP_SKIP', { leadgen_id: leadgenId }); return; }
    } catch (_) {}

    const phoneRaw = String(lcRow['phone_number'] || lcRow['telefono'] || lcRow['teléfono'] || lcRow['phone'] || lcRow['celular'] || '').trim();
    const fullName = String(lcRow['full_name'] || lcRow['nombre_completo'] || lcRow['nombre completo'] || lcRow['name'] || lcRow['nombre'] || '').trim();
    const firstName = String(lcRow['first_name'] || fullName).split(/\s+/)[0] || '';
    const email = String(lcRow['email'] || lcRow['correo'] || '').trim();
    const adId = String(lcRow['ad_id'] || '').trim();
    const formId = String(lcRow['form_id'] || '').trim();
    const formName = String(lcRow['form_name'] || '').trim();
    const adName = String(lcRow['ad_name'] || '').trim();
    const adsetId = String(lcRow['adset_id'] || '').trim();
    const campaignId = String(lcRow['campaign_id'] || '').trim();

    const phoneNorm = normalizeArPhone(phoneRaw) || '';
    const vertical = inferLeadVertical(formName, adName);
    const createdTime = lcRow['created_time'] || lcRow['createdtime'] || '';
    const tsIso = createdTime ? (typeof createdTime === 'string' && createdTime.includes('T') ? createdTime : new Date(createdTime).toISOString()) : new Date().toISOString();

    try {
      await env.DB.prepare(
        `INSERT INTO wa_leads
         (leadgen_id, ts, received_at, page_id, form_id, form_name, ad_id, ad_name, adset_id, campaign_id,
          phone, phone_raw, first_name, full_name, email, vertical, raw_lead_data, template_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        leadgenId, tsIso, new Date().toISOString(),
        '100517509701851', // page id conocido — Neon Infinito
        formId, formName, adId, adName, adsetId, campaignId,
        phoneNorm, phoneRaw, firstName, fullName, email,
        vertical,
        JSON.stringify(row).slice(0, 4000),
        phoneNorm ? 'pending' : 'skipped'
      ).run();
    } catch (e) {
      await _logLeadDebug(env, 'SHEET_INSERT_ERR', { msg: e.message });
      return;
    }

    if (!phoneNorm) {
      try {
        await env.DB.prepare('UPDATE wa_leads SET template_error = ? WHERE leadgen_id = ?').bind(
          'telefono invalido o vacio: ' + phoneRaw, leadgenId
        ).run();
      } catch (_) {}
      await _logLeadDebug(env, 'SHEET_NO_PHONE', { leadgen_id: leadgenId });
      return;
    }

    // Mandar template lead_b2b_followup (mismo flow que webhook real).
    const tplResult = await waSendTemplate(env, phoneNorm, 'lead_b2b_followup', 'es_AR', [
      firstName || 'amigo/a'
    ]);

    if (tplResult?.ok) {
      // BUG FIX: waSend devuelve el wamid en tplResult.id (y el raw en .raw),
      // NO en .data. Antes leía tplResult.data?.messages[0].id → siempre ''.
      // Por eso el template del form B2B se mandaba (el lead lo recibía) pero
      // NO aparecía en el CRM: con wamid='' se saltaba el INSERT en wa_messages
      // y solo quedaba el placeholder vacío de status. El webhook real (línea
      // ~1558) ya usaba .id bien; el bridge de Sheets tenía el typo.
      const wamid = tplResult.id || '';
      try {
        await env.DB.prepare(
          'UPDATE wa_leads SET template_status = ?, template_sent_at = ?, wamid = ? WHERE leadgen_id = ?'
        ).bind('sent', new Date().toISOString(), wamid, leadgenId).run();
      } catch (_) {}

      try {
        const previewBody = `Holaa ${firstName || 'amigo/a'}, por aca Joaco de Neon Infinito! Nos llego tu formulario para presupuestar carteles! Tenes un diseño/imagen de referencia para pasarnos asi te lo cotizamos?`;
        // UPSERT por wamid: si el status (sent/delivered) ya creó la fila vacía,
        // completamos el body + msg_type en vez de fallar por el UNIQUE de wamid.
        if (wamid) {
          await env.DB.prepare(
            `INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id)
             VALUES (?, ?, 'outbound', ?, '', 'template', ?, 'sent', '')
             ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'template'
               WHERE wa_messages.body IS NULL OR wa_messages.body = '' OR wa_messages.msg_type = 'status'`
          ).bind(new Date().toISOString(), wamid, phoneNorm, previewBody).run();
        }
      } catch (_) {}
      // Etiquetar el chat como FORM (lead de formulario B2B), id de label = 12.
      try {
        await env.DB.prepare('INSERT OR IGNORE INTO contact_labels (phone, label_id, created_at) VALUES (?, 12, ?)').bind(phoneNorm, new Date().toISOString()).run();
      } catch (_) {}
      await _logLeadDebug(env, 'SHEET_TEMPLATE_SENT', { leadgen_id: leadgenId, phone: phoneNorm, wamid });
    } else {
      try {
        await env.DB.prepare(
          'UPDATE wa_leads SET template_status = ?, template_error = ? WHERE leadgen_id = ?'
        ).bind('failed', JSON.stringify(tplResult || {}).slice(0, 500), leadgenId).run();
      } catch (_) {}
      await _logLeadDebug(env, 'SHEET_TEMPLATE_FAILED', { leadgen_id: leadgenId, err: tplResult });
    }
  } catch (err) {
    await _logLeadDebug(env, 'SHEET_FATAL', { message: err?.message, stack: (err?.stack || '').slice(0, 1500) });
  }
}

// ===== Media download (WhatsApp → R2, vía Meta o 360dialog) =====
async function downloadMedia(env, mediaId) {
  if (!mediaId || !env.MEDIA) return null;
  let wa;
  try { wa = getWaClient(env); } catch (_) { return null; }
  if (wa.provider === 'meta' && !env.WA_TOKEN) return null;
  try {
    // Step 1: get media URL from WA API (Meta o 360dialog)
    const meta = await fetch(wa.mediaUrl(mediaId), { headers: wa.headers });
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
    // Step 2: download.
    // - Meta directo: bajar de graph.facebook.com con Bearer token.
    // - 360dialog: la URL del paso 1 apunta a lookaside.fbsbx.com pero NO se
    //   puede descargar desde ahí (Meta rechaza 401). 360dialog tiene un PROXY:
    //   reemplazar el host lookaside.fbsbx.com → waba-v2.360dialog.io conservando
    //   path y query, y mandar D360-API-KEY. Documentado en su API reference.
    let downloadUrl = info.url;
    if (wa.provider === '360dialog' && /lookaside\.fbsbx\.com/.test(downloadUrl)) {
      downloadUrl = downloadUrl.replace('https://lookaside.fbsbx.com', wa.base);
    }
    const file = await fetch(downloadUrl, { headers: wa.headers });
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

// Reintenta downloadMedia ante fallo transitorio. Causa #1 de imágenes/audios
// vacíos: el webhook llega ANTES de que Meta/360dialog tenga el media listo para
// descargar (race condition). El primer intento es inmediato; si falla, espera y
// reintenta. Solo agrega latencia en el ~14% de casos que fallan a la primera;
// los que andan al toque no se demoran. Corre dentro de ctx.waitUntil (no bloquea
// la respuesta al webhook), así que los segundos de espera son seguros.
async function downloadMediaWithRetry(env, mediaId, attempts = 3) {
  const delays = [0, 1500, 4000];
  for (let i = 0; i < attempts; i++) {
    if (delays[i]) await new Promise(r => setTimeout(r, delays[i]));
    try {
      const dl = await downloadMedia(env, mediaId);
      if (dl) return dl;
    } catch (_) { /* reintentar */ }
  }
  return null;
}

// ===== Render hiperrealista con Gemini (image-to-image) =====
// Prompt para generar el render. Soporta tanto un boceto vectorizado como
// una captura/foto que mandó Joaco — adapta el comportamiento según el caso.
// Si el contexto (que se appendea al final del prompt) trae NOTAS específicas,
// el modelo debe respetarlas con prioridad alta (cursiva, color, agregados, etc.).
const GEMINI_RENDER_PROMPT = [
  'Sos especialista en carteles de neón LED. Generá un render hiperrealista del producto terminado a partir de la imagen de referencia adjunta.',
  '',
  '═══ ◆ REGLA #1 — FIDELIDAD ABSOLUTA AL DISEÑO ◆ ═══',
  'TU TRABAJO NO ES REDISEÑAR, ES FABRICAR. Sos un fabricante reproduciendo un diseño preexistente, NO un ilustrador haciendo arte propio.',
  '',
  'COPIÁ EXACTO de la imagen de referencia:',
  '- La pose y posición de cada figura (si hay una persona haciendo pilates con piernas arriba, el render tiene a esa persona con piernas arriba, NO con brazos abiertos ni otra pose).',
  '- La composición y layout (qué va arriba, qué va al costado, qué adentro de qué).',
  '- El tipo de letra, las formas exactas de los caracteres.',
  '- Las proporciones relativas entre los elementos.',
  '- La estructura del logo (arcos, círculos, divisiones, etc.).',
  '',
  'NO MODIFIQUES:',
  '- Poses de figuras humanas o animales (¡copialas tal cual la referencia!).',
  '- Orientación o rotación de elementos.',
  '- El estilo tipográfico (si dice cursiva script, no la cambies por block; si es block, no la cambies por cursiva).',
  '- La cantidad o disposición de elementos.',
  '',
  'Las reglas que vienen abajo (materiales, colores, síntesis) SOLO se aplican para resolver IMPOSIBILIDADES FÍSICAS DE FABRICACIÓN (un color que no existe, un punto menor a 1cm, una perspectiva imposible). NUNCA son licencia para cambiar la composición o reinterpretarla artísticamente. Si una regla de "síntesis" te tienta a redibujar algo, freenate: probablemente está bien como está y solo necesita la traducción al material correcto.',
  '',
  '═══ MATERIALES (REGLA ABSOLUTA) ═══',
  'El producto se fabrica EXCLUSIVAMENTE con dos materiales — nada más:',
  '1. Manguera de neón LED de silicona de 6 mm de espesor (base plana, frente en forma de media caña). Esta es la única fuente de luz y la única manera de representar líneas/contornos/letras del diseño.',
  '2. Base de acrílico transparente de 3 mm de espesor, recortada siguiendo el contorno exterior del diseño.',
  '',
  '◆◆◆ EL NEÓN ES UN TUBO HUECO — TODO ES OUTLINE, NUNCA RELLENO ◆◆◆',
  '',
  'El neón LED es un tubo cilíndrico de silicona de 6mm que emite luz. Una sola línea de neón se ve como un TUBO BRILLANTE de 6mm de ancho, no como una franja rellena de color sólido.',
  '',
  'Para CUALQUIER elemento del diseño (letra, figura, silueta, símbolo, lo que sea), aplicá esta regla mental:',
  '   "¿Qué forma toma el tubo de neón al recorrer este elemento?"',
  '   El tubo SOLO puede formar líneas continuas. NO PUEDE RELLENAR áreas.',
  '',
  'CASOS QUE EL MODELO SIEMPRE EQUIVOCA — atención particular:',
  '',
  '1) LETRAS CURSIVAS CON TRAZOS GRUESOS (script, brush, calligraphy estilo logo):',
  '   La referencia muestra la cursiva con un trazo ancho de color sólido (ej: "Axis" violeta con stroke grueso).',
  '   ERROR común del modelo: pintar la letra entera rellena del mismo color, como si fuera vinilo cortado en forma de letra.',
  '   CORRECTO: cada letra cursiva se reduce a UN solo tubo de neón siguiendo el TRAZO CENTRAL de la cursiva, de 6mm de ancho. El interior de las curvas (el ojo de la "A", la panza de la "s") es transparente, se ve la pared. La letra ya no es un shape relleno, es una línea hueca brillante con dos bordes visibles.',
  '',
  '2) SILUETAS SÓLIDAS (cuerpo de un perro, figura humana, animal, objeto):',
  '   La referencia muestra la figura como un shape rellenado de un solo color (ej: mujer violeta sólida, perro negro sólido).',
  '   ERROR común del modelo: copiar la silueta rellena pintada del mismo color.',
  '   CORRECTO: dibujá SOLO el contorno (perímetro) de la silueta como un tubo de neón. Por dentro de la silueta se ve la pared gris. La figura ya no es un shape relleno, es un outline brillante.',
  '',
  '3) ÁREAS CON COLOR DENTRO DE FIGURAS (bandas de color, gradientes, manchas):',
  '   La referencia muestra áreas internas pintadas de colores distintos.',
  '   ERROR común: pintarlas en el render.',
  '   CORRECTO: ignorá los rellenos internos. Solo el contorno exterior queda como neón. El interior es transparente.',
  '',
  'PROHIBIDO ABSOLUTO:',
  '- Vinilo, calcomanías, pintura, impresión.',
  '- Cualquier letra o figura que parezca un shape rellenado en lugar de un tubo hueco.',
  '- Rellenos opacos detrás del neón para "darle cuerpo" a la figura.',
  '- Sombras pintadas, degradados pintados, texturas internas.',
  '- Paneles LED, pantallas, módulos digitales.',
  '',
  'TEST VISUAL: en tu render, ¿se ven DOS BORDES paralelos en cada trazo de letra y figura (uno a cada lado del tubo)? Si se ve un solo bloque de color sólido, está mal — eso es vinilo.',
  '',
  'TEST FÍSICO: si pudieras pasar la mano por detrás del cartel, ¿verías tu mano a través de cada letra y figura, salvo las mangueras de neón propiamente dichas? Si hay zonas opacas, está mal.',
  '',
  '═══ VISTA / CÁMARA ═══',
  'El render debe ser SIEMPRE una vista frontal recta (ortográfica, 0° de inclinación, 0° de rotación). El cartel se ve de frente, perfectamente plano.',
  'PROHIBIDO: perspectiva, vistas 3/4, ángulo, vista lateral, vista desde abajo, vista desde arriba, inclinaciones, picado, contrapicado.',
  'El cartel ocupa el centro de la imagen, frente a una pared neutra simple (gris o blanca lisa), bien iluminado. Sin objetos alrededor, sin decoración de fondo, sin elementos del entorno (cables visibles del transformador OK pero discretos).',
  '',
  '═══ ESPEC TÉCNICA DEL RENDER ═══',
  '- El neón sigue el contorno del diseño con precisión, sin cortes ni desviaciones.',
  '- Respetá exactamente las formas de la imagen de referencia.',
  '- Glow/halo realista del neón sobre el acrílico y la pared.',
  '',
  '═══ PALETA DE COLORES DISPONIBLES (regla absoluta) ═══',
  'El neón LED de silicona solo se fabrica en estos colores. NO hay otros disponibles físicamente:',
  '- Blanco cálido (warm white)',
  '- Blanco frío (cool white)',
  '- Rojo',
  '- Naranja',
  '- Amarillo',
  '- Verde lima',
  '- Verde',
  '- Azul cielo / ice blue',
  '- Azul',
  '- Rosa',
  '- Violeta / púrpura',
  '',
  'MAPEO de colores que NO existen físicamente (siempre aplicarlos):',
  '- Negro → blanco frío.',
  '- Marrón / chocolate / café → naranja o amarillo (el más cercano al tono original).',
  '- Dorado / gold metálico → amarillo.',
  '- Plateado / silver metálico → blanco frío.',
  '- Gris → blanco frío.',
  '- Beige / crema → blanco cálido.',
  '- Cualquier color metálico → el color base no metálico más cercano de la paleta.',
  'Para degradados o multitonos dentro de una misma figura: elegí UN solo color (el dominante) o partí la figura en dos secciones de color distinto. NUNCA renderices un degradado pintado dentro de la línea de neón — el neón es un color sólido uniforme a lo largo de cada tramo.',
  '',
  '═══ RESTRICCIONES FÍSICAS DEL NEÓN LED ═══',
  'Estas reglas existen porque hay cosas que NO SE PUEDEN FABRICAR con manguera de neón LED. NO son licencia para redibujar el diseño. Si una regla acá te lleva a cambiar la composición, parate: la regla está mal interpretada.',
  '',
  '1. PUNTOS / SPARKLES PROHIBIDOS: no dibujes puntos sueltos, motas, destellos, "polvo de estrellas", chispitas, confeti ni elementos puntuales desconectados. Un punto menor a 1cm no se puede cortar de la manguera. Si la referencia tiene sparkles decorativos chiquitos, simplemente NO los incluyas en el render — el resto de la composición queda igual.',
  '',
  '2. CORTE MÍNIMO: la manguera solo se puede cortar cada 1 cm. No existen tramos menores a 1cm.',
  '',
  '3. TAMAÑO MÍNIMO DE ELEMENTO: cualquier figura debe medir al menos 2-3 cm en el cartel terminado.',
  '',
  '4. SOLO CONTORNOS: el neón dibuja el outline de cada forma. El interior queda transparente (acrílico). Detalles internos (cuadrículas dentro de un chocolate, líneas adentro de un balón, etc.) → solo contorno exterior.',
  '',
  '5. DOBLE OUTLINE: si una letra tiene contorno + relleno de otro color en la referencia, renderizá UN solo contorno (el dominante). NO redibujes la letra ni cambies su forma — solo simplificás los trazos múltiples a uno.',
  '',
  '6. FONDO DEL CARTEL: el acrílico es transparente. Detrás solo la pared. No agregues atmósfera ni partículas decorativas que la referencia no tenga.',
  '',
  '═══ INTERPRETACIÓN DEL INPUT ═══',
  '- Si la imagen es un boceto vectorizado limpio: copialo fiel.',
  '- Si es una foto, captura de chat o referencia rough: copiá la composición, las poses, las formas y la tipografía EXACTAS de la referencia. Solo traducí los MATERIALES (no copies texturas, rellenos opacos o efectos pintados — esos los reemplazás por contorno de neón + interior transparente).',
  '',
  '═══ PRIORIDAD DE LAS NOTAS DEL USUARIO ═══',
  'Si en el contexto vienen NOTAS / INSTRUCCIONES ESPECÍFICAS, aplicalas (color dentro de la paleta, agregados puntuales, etc.).',
  'NUNCA sobreescribibles por las notas:',
  '- Fidelidad al diseño de la referencia (composición, poses, tipografía).',
  '- Materiales: neón 6mm + acrílico transparente.',
  '- Vista frontal recta.',
  '- Paleta de colores físicamente posible.',
  '- Restricciones físicas (1cm corte, 2-3cm tamaño mínimo, sin puntitos).'
].join('\n');

// Prompt para que la IA estime medidas + mts de neón a partir de la imagen y
// del texto que escribió el cliente. Usa gemini-2.5-flash (mucho más barato
// que el modelo de imagen) y devuelve JSON estructurado.
const GEMINI_PARAMS_PROMPT = (contextoCliente) => [
  'Sos un experto en cotización de carteles de neón LED en Argentina.',
  '',
  'Mirá la imagen de referencia y estimá las medidas para cotizar.',
  '',
  'CONTEXTO DEL CLIENTE (lo que escribió en el chat):',
  contextoCliente || '(sin info adicional)',
  '',
  '═══ PASO 1: MEDIR LA PROPORCIÓN DE LA IMAGEN ═══',
  'Antes de elegir ancho/alto, calculá el bounding box del DISEÑO en la imagen (el área que efectivamente ocupa el cartel, ignorando padding/fondo vacío).',
  '- píxeles_ancho_diseño = ancho del bounding box del diseño.',
  '- píxeles_alto_diseño = alto del bounding box del diseño.',
  '- ratio_aspect = píxeles_ancho_diseño / píxeles_alto_diseño.',
  '',
  '═══ PASO 2: DETERMINAR ancho_cm Y alto_cm ═══',
  '',
  'CASO A — El cliente especificó AMBAS dimensiones (ej: "90x50", "1m × 60cm"):',
  '   → USÁ esas medidas tal cual. Parseá del texto.',
  '',
  'CASO B — El cliente especificó UNA SOLA dimensión (ej: "80cm de ancho", "1m de largo", "60cm de alto"):',
  '   → LA OTRA DIMENSIÓN SE CALCULA EXACTO POR REGLA DE PROPORCIÓN.',
  '   → Fórmula:',
  '       Si te dieron el ancho:  alto_cm = round(ancho_cm / ratio_aspect)',
  '       Si te dieron el alto:   ancho_cm = round(alto_cm * ratio_aspect)',
  '   → REGLA CRÍTICA: NUNCA inventes la dimensión faltante. Tiene que ser proporcional al diseño en la imagen.',
  '   → EJEMPLO: si el diseño en la imagen mide 1000 × 800 píxeles (ratio 1.25) y el cliente pidió 80cm de ancho,',
  '     entonces alto_cm = 80 / 1.25 = 64cm. NO 29cm, NO 100cm — exacto 64.',
  '',
  'CASO C — El cliente NO especificó medidas:',
  '   → Elegí ancho_cm entre 60 y 150 según complejidad del diseño.',
  '   → alto_cm = round(ancho_cm / ratio_aspect) — también respetá la proporción.',
  '',
  'PRIORIDAD: Si en las NOTAS / INSTRUCCIONES ESPECÍFICAS hay medidas, esas son lo último que pidió el usuario y mandan sobre todo.',
  '',
  '═══ PASO 3: ESTIMAR neon_mt (CÁLCULO OBLIGATORIO, NO HEURÍSTICA) ═══',
  '',
  'IMPORTANTE: el cartel se fabrica con manguera continua siguiendo el CONTORNO (outline) de cada forma. Las letras NO se "rellenan" — la manguera dibuja la silueta exterior + los contornos interiores (counters) si los tienen. Por eso una "O" tiene 2 contornos (exterior + interior agujero), una "B" tiene 3 (exterior + 2 agujeros), una "I" tiene 1.',
  '',
  'PROCEDIMIENTO OBLIGATORIO:',
  '',
  '1. ESTIMÁ LA ALTURA PROMEDIO DE LETRA en cm (basado en alto_cm y proporción del diseño). Llamala h.',
  '',
  '2. CLASIFICÁ CADA LETRA DEL TEXTO POR SU FACTOR DE PERÍMETRO según el estilo del diseño:',
  '',
  '   ESTILO OUTLINE / BLOCK / SANS-SERIF (letras con contorno doble, como "nero.studio"):',
  '   · Letras simples (I, L, T, J, 1): factor = 2.0 × h',
  '   · Letras medianas (E, F, H, N, A, V, K, W, M, Y, X, Z, 2-7): factor = 2.5 × h',
  '   · Letras con espacios cerrados / counters (C, U, S, J): factor = 3.0 × h',
  '   · Letras con uno o más counters (O, D, P, Q, R, 0, 6, 9): factor = 3.5 × h',
  '   · Letras con varios counters (B, 8): factor = 4.5 × h',
  '   · Signos de puntuación (., ,, !, ?, -): factor = 0.3 × h',
  '',
  '   ESTILO CURSIVA / SCRIPT / HANDWRITING (letras de UN solo trazo continuo, como "Gino"):',
  '   · Cada letra: factor = 1.5 × h promedio (el trazo es continuo entre letras así que se aprovecha).',
  '   · Bucles y adornos sumá: 0.5 × h extra por letra adornada.',
  '',
  '   ESTILO BOLD / GRUESO con relleno aparente:',
  '   · Multiplicá los factores de OUTLINE por 1.2 (las letras son más anchas → perímetro mayor).',
  '',
  '3. SUMÁ todos los factores letra por letra. Esto te da el neón del texto.',
  '',
  '4. AGREGÁ EL PERÍMETRO DE CADA FIGURA/ELEMENTO DECORATIVO del logo por separado:',
  '   · Para cada figura (vaso, chocolate, estrella, marco, ondas, etc.): estimá su perímetro real en cm como contorno simple.',
  '   · Fórmula rápida: perímetro ≈ 3 × (lado_más_largo) para figuras orgánicas medianas.',
  '   · Para círculos: π × diámetro ≈ 3.14 × diámetro.',
  '   · Para rectángulos: 2 × (ancho + alto).',
  '',
  '5. SUMÁ TODO y convertí a metros (dividí entre 100).',
  '',
  'EJEMPLO DE CÁLCULO ("nero.studio" en cartel de 150×40cm):',
  '- h (altura letra) ≈ 32 cm',
  '- "n" → 2.5 × 32 = 80 cm',
  '- "e" → 3.5 × 32 = 112 cm (tiene counter)',
  '- "r" → 3.5 × 32 = 112 cm',
  '- "o" → 3.5 × 32 = 112 cm',
  '- "." → 0.3 × 32 = 10 cm',
  '- "s" → 3.0 × 32 = 96 cm',
  '- "t" → 2.0 × 32 = 64 cm',
  '- "u" → 3.0 × 32 = 96 cm',
  '- "d" → 3.5 × 32 = 112 cm',
  '- "i" → 2.0 × 32 = 64 cm',
  '- "o" → 3.5 × 32 = 112 cm',
  '- SUMA: ~970 cm = 9.7 m + 10% de tolerancia + conectores = ~11 m ← este es el valor correcto.',
  '',
  'NO USES HEURÍSTICAS PLANAS TIPO "0.3 mt por letra". Siempre calcular letra por letra con h real.',
  'NO REDONDEES PARA ABAJO sistemáticamente — sumá un 10% al final por tolerancia y conectores.',
  '',
  '═══ PASO 4: VALIDACIÓN ═══',
  'dif_vs_cliente: true SOLO si el ratio que calculaste de la imagen difiere >20% del ratio implícito en lo que dijo el cliente (ej: cliente pidió cartel "cuadrado" pero el diseño es claramente alargado). Si el cliente no dijo medidas, poné false.',
  '',
  'Respondé únicamente con un JSON válido, sin explicación previa, sin markdown:',
  '{"ancho_cm": <entero>, "alto_cm": <entero>, "neon_mt": <decimal 1 lugar>, "razonamiento": "<frase corta: ratio de imagen, cómo llegaste a las medidas, y desglose del cálculo de neón (ej: 11 letras × ~80cm c/u + figura del vaso ~120cm)>", "dif_vs_cliente": <true|false>}'
].join('\n');

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

// Analiza la imagen + el texto del cliente y devuelve un JSON con ancho_cm,
// alto_cm, neon_mt, razonamiento y dif_vs_cliente. Usa gemini-2.5-flash con
// responseMimeType=application/json (modo estructurado) → mucho más confiable
// que parsear texto libre. Costo ~$0.001 por call (muy barato vs render).
async function estimarParametrosConGemini(env, imageBuf, imageMime, contextoCliente) {
  if (!env.GEMINI_API_KEY) return { error: 'GEMINI_API_KEY no configurada' };
  // Modelo de texto+vision. Antes era gemini-2.5-flash (más barato pero
  // poco preciso midiendo proporciones en imágenes: error típico ±15%).
  // Pro tiene visión mucho más fina, error esperable ±5%. Costo extra
  // ~$0.005 por brief (vs $0.001 con Flash), despreciable vs render.
  const model = env.GEMINI_PARAMS_MODEL || 'gemini-2.5-pro';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  const body = {
    contents: [{
      parts: [
        { text: GEMINI_PARAMS_PROMPT(contextoCliente) },
        { inline_data: { mime_type: imageMime || 'image/png', data: abToBase64(imageBuf) } }
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2
    }
  };
  let resp;
  try {
    resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    return { error: 'fetch a Gemini Flash falló: ' + e.message };
  }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json())?.error?.message || ''; } catch(e) {}
    return { error: `Gemini params HTTP ${resp.status}${detail ? ': ' + detail : ''}` };
  }
  let data;
  try { data = await resp.json(); } catch (e) { return { error: 'respuesta de params no es JSON wrapper' }; }
  const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!txt) return { error: 'Gemini no devolvió texto con params' };
  let parsed;
  try { parsed = JSON.parse(txt); }
  catch (e) { return { error: 'JSON de params inválido: ' + txt.slice(0, 100) }; }
  return {
    ok: true,
    ancho_cm: Math.round(Number(parsed.ancho_cm) || 0),
    alto_cm: Math.round(Number(parsed.alto_cm) || 0),
    neon_mt: Math.round((Number(parsed.neon_mt) || 0) * 10) / 10,
    razonamiento: String(parsed.razonamiento || '').slice(0, 250),
    dif_vs_cliente: !!parsed.dif_vs_cliente
  };
}

// ===== Coexistence history import (event: 'history' de 360dialog) =====
// Procesa el formato 360dialog flat con TRES sub-payloads mutuamente exclusivos:
//   - data.messages[]: mensajes entrantes del cliente (live, ya recibimos via Meta-style también)
//   - data.message_echoes[]: mensajes que Joaco escribió desde el celular (outbound)
//   - data.history[].threads[].messages[]: backfill on-boarding (hasta 6 meses de historial)
//
// Todos los inserts son INSERT OR IGNORE — wamid UNIQUE evita duplicados.
// Para cada media (image/video/audio/document/sticker) hace downloadMedia → R2.
async function processCoexistenceHistory(env, data) {
  const businessPhone = String(env.WA_BUSINESS_PHONE || '5491144366573').replace(/\D/g, '');

  // Cache de nombres si hay state_sync o contacts.
  const nameByPhone = {};
  for (const c of (data?.contacts || [])) {
    const waId = String(c.wa_id || '').replace('+', '');
    const nm = c.profile?.name || c.profile?.full_name || '';
    if (waId && nm) nameByPhone[waId] = nm;
  }

  // Helper: extrae body + mediaUrl + flags según el tipo del mensaje.
  // Devuelve { msgType, body, mediaUrl, contextId, forwarded, isVoice }.
  const parseMsg = (m) => {
    let msgType = m.type || 'unknown';
    let body = '';
    let mediaUrl = '';
    let forwarded = 0;
    let isVoice = 0;

    if (m.text)         body = m.text.body || '';
    else if (m.image)   { body = m.image.caption || '';  mediaUrl = m.image.id || ''; }
    else if (m.video)   { body = m.video.caption || '';  mediaUrl = m.video.id || ''; }
    else if (m.audio)   { mediaUrl = m.audio.id || ''; isVoice = m.audio.voice ? 1 : 0; }
    else if (m.document){ body = m.document.filename || ''; mediaUrl = m.document.id || ''; }
    else if (m.sticker) { mediaUrl = m.sticker.id || ''; }
    else if (m.reaction) body = m.reaction.emoji || '';
    else if (m.location) body = `[ubicacion] ${m.location.latitude},${m.location.longitude}${m.location.name ? ' — ' + m.location.name : ''}`;
    else if (m.button)   body = m.button.text || m.button.payload || '';
    else if (m.interactive) body = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '';
    else if (m.contacts && m.contacts.length) {
      const names = m.contacts.map(c => c.name?.formatted_name || c.name?.first_name || 'contacto').join(', ');
      const phones = m.contacts.map(c => c.phones?.[0]?.phone || c.phones?.[0]?.wa_id || '').filter(Boolean).join(', ');
      body = `[contacto] ${names}${phones ? ' — ' + phones : ''}`;
    }
    else if (m.order)   body = `[pedido] ${(m.order.product_items || []).map(p => p.product_retailer_id).join(', ')}`;
    // Coexistence history-specific:
    else if (m.type === 'media_placeholder') {
      // History trae 9417 de estos — placeholders de media que Meta no migró al onboarding.
      body = '[media histórica no disponible]';
    }
    else if (m.type === 'edit' && m.edit) {
      // History trae 373 edits — mantenemos el texto editado.
      msgType = 'edit';
      body = m.edit.message?.text?.body || '[mensaje editado]';
    }
    else if ((m.type === 'errors' || m.unsupported) && Array.isArray(m.errors) && m.errors.length) {
      const code = m.errors[0].code;
      const title = m.errors[0].title || '';
      if (code === 131051 || title === 'Message type unknown') {
        body = '✏️ El cliente editó un mensaje (Meta no comparte el contenido editado)';
      } else if (title.includes('unavailable')) {
        body = '[mensaje no disponible]';
      } else {
        body = `[no soportado: ${title || code || 'desconocido'}]`;
      }
    }

    // Flags adicionales
    let contextId = '';
    if (m.context?.id) contextId = m.context.id;
    else if (m.reaction?.message_id) contextId = m.reaction.message_id;
    if (m.context?.forwarded) forwarded = 1;
    if (m.edit?.original_message_id) contextId = m.edit.original_message_id;

    return { msgType, body, mediaUrl, contextId, forwarded, isVoice };
  };

  // Helper: inserta un mensaje en wa_messages, baja media a R2, atribuye ads.
  const insertMsg = async ({ wamid, ts, direction, phone, senderName, m }) => {
    let { msgType, body, mediaUrl, contextId } = parseMsg(m);

    // Bajar media a R2 (best-effort, con reintentos por el race del webhook).
    let r2Key = '';
    if (mediaUrl && env.MEDIA) {
      try { const dl = await downloadMediaWithRetry(env, mediaUrl); if (dl) r2Key = dl.key; } catch (_) {}
    }
    if (msgType === 'audio' && r2Key && env.AI) {
      // FIX: antes esto era un no-op (calculaba la transcripción y la tiraba).
      // Ahora la guardamos en body como '[audio] <texto>' igual que la rama live.
      try { const t = await transcribeAudio(env, r2Key); if (t) body = '[audio] ' + t; } catch (_) {}
    }

    try {
      await env.DB.prepare(
        `INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(wamid) DO UPDATE SET
           direction = excluded.direction,
           phone = excluded.phone,
           msg_type = excluded.msg_type,
           body = excluded.body,
           media_url = excluded.media_url,
           context_id = excluded.context_id,
           ts = excluded.ts
         WHERE wa_messages.body IS NULL OR wa_messages.body = '' OR wa_messages.msg_type IN ('status','media_placeholder')`
      ).bind(ts, wamid, direction, phone, senderName, msgType, body, r2Key || mediaUrl, contextId, null).run();
    } catch (_) {}

    // Ad attribution (CTWA — referral) — mismo bloque que rama Meta-style.
    if (m.referral && direction === 'inbound') {
      try {
        const ref = m.referral;
        const exists = await env.DB.prepare('SELECT 1 FROM wa_ad_attributions WHERE wamid = ?').bind(wamid).first();
        if (!exists) {
          await env.DB.prepare(`INSERT INTO wa_ad_attributions
            (phone, wamid, ts, source_id, source_type, source_url, headline, body, media_type, image_url, video_url, thumbnail_url, ctwa_clid, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
            phone, wamid, ts,
            String(ref.source_id || ''), String(ref.source_type || ''), String(ref.source_url || ''),
            String(ref.headline || ''), String(ref.body || ''), String(ref.media_type || ''),
            String(ref.image_url || ''), String(ref.video_url || ''), String(ref.thumbnail_url || ''),
            String(ref.ctwa_clid || ''), new Date().toISOString()
          ).run();
        }
      } catch (_) {}
    }
  };

  // === Branch 1: data.messages[] (live inbound del cliente) ===
  for (const m of (data?.messages || [])) {
    const wamid = m.id || ''; if (!wamid) continue;
    const fromNorm = String(m.from || '').replace(/\D/g, '');
    const direction = fromNorm === businessPhone ? 'outbound' : 'inbound';
    const phone = fromNorm;
    const senderName = direction === 'inbound' ? (nameByPhone[phone] || '') : '';
    const ts = m.timestamp ? new Date(parseInt(m.timestamp) * 1000).toISOString() : new Date().toISOString();
    await insertMsg({ wamid, ts, direction, phone, senderName, m });
  }

  // === Branch 2: data.message_echoes[] (Joaco escribió desde el celular) ===
  // ANTES SE IGNORABAN — 6.475 mensajes perdidos en 6 meses según auditoría.
  for (const echo of (data?.message_echoes || [])) {
    const wamid = echo.id || ''; if (!wamid) continue;
    const phone = String(echo.to || '').replace(/\D/g, ''); // destinatario = cliente
    const ts = echo.timestamp ? new Date(parseInt(echo.timestamp) * 1000).toISOString() : new Date().toISOString();
    await insertMsg({ wamid, ts, direction: 'outbound', phone, senderName: '', m: echo });
  }

  // === Branch 3: data.history[] (backfill on-boarding) ===
  // Cada history tiene threads, cada thread tiene messages. ANTES SE IGNORABA — 64.596 mensajes.
  for (const histEntry of (data?.history || [])) {
    for (const thread of (histEntry?.threads || [])) {
      const threadCtx = thread?.context || {};
      // Para identificar al cliente del thread (cuando from_me=true)
      const clientPhone = String(threadCtx.wa_id || '').replace('+', '');
      for (const m of (thread?.messages || [])) {
        const wamid = m.id || ''; if (!wamid) continue;
        // Direction barato y confiable: history_context.from_me
        const fromMe = m.history_context?.from_me === true;
        const direction = fromMe ? 'outbound' : 'inbound';
        const fromNorm = String(m.from || '').replace(/\D/g, '');
        const phone = fromMe ? clientPhone : (fromNorm || clientPhone);
        const senderName = direction === 'inbound' ? (nameByPhone[phone] || '') : '';
        const ts = m.timestamp ? new Date(parseInt(m.timestamp) * 1000).toISOString() : new Date().toISOString();
        await insertMsg({ wamid, ts, direction, phone, senderName, m });
      }
    }
  }
}

// ===== Template status update (webhook field message_template_status_update) =====
// Meta dispara este evento cuando un template cambia de status (PENDING → APPROVED|
// REJECTED|PAUSED|DISABLED). Reemplaza al polling cada 5 min de monitorTemplateStatus
// si el field está suscrito en el hub de 360dialog.
async function processTemplateStatusUpdate(env, value) {
  const name = value?.message_template_name || '';
  const lang = value?.message_template_language || '';
  const event = value?.event || ''; // APPROVED, REJECTED, PAUSED, etc.
  const reason = value?.reason || '';
  if (!env.ADMIN_NOTIFY_PHONE || !name || !event) return;
  let icon = '📋';
  if (event === 'APPROVED') icon = '✅';
  else if (event === 'REJECTED' || event === 'DISABLED') icon = '❌';
  else if (event === 'PAUSED' || event === 'FLAGGED') icon = '⚠️';
  const text = `${icon} Plantilla "${name}" (${lang}): ${event}${reason ? `\nMotivo: ${reason}` : ''}`;
  try { await waSendText(env, env.ADMIN_NOTIFY_PHONE, text); } catch (_) {}
}

// ===== Coexistence state sync (event: 'smb_app_state_sync' de 360dialog) =====
// 360dialog manda este evento al onboardear y cada vez que Joaco agrega/modifica/
// elimina un contacto en la app de WhatsApp Business del celular. Es la fuente de
// la verdad para nombres reales y permite poblar sender_name de mensajes inbound.
async function processCoexistenceStateSync(env, data) {
  const items = Array.isArray(data?.state_sync) ? data.state_sync : [];
  const now = new Date().toISOString();
  for (const item of items) {
    if (item.type !== 'contact') continue;
    const c = item.contact || {};
    const userId = String(c.user_id || '').trim();
    const phone = String(c.phone_number || '').replace(/\D/g, '');
    const fullName = String(c.full_name || '').trim();
    const firstName = String(c.first_name || '').trim();
    if (!userId || !phone) continue;
    const action = item.action || 'add';
    const version = parseInt(item.metadata?.version) || 1;
    try {
      await env.DB.prepare(
        `INSERT INTO wa_address_book (user_id, phone, full_name, first_name, action, version, first_seen_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET
           phone = excluded.phone,
           full_name = CASE WHEN excluded.full_name != '' THEN excluded.full_name ELSE wa_address_book.full_name END,
           first_name = CASE WHEN excluded.first_name != '' THEN excluded.first_name ELSE wa_address_book.first_name END,
           action = excluded.action,
           version = excluded.version,
           updated_at = excluded.updated_at`
      ).bind(userId, phone, fullName, firstName, action, version, now, now).run();

      // Bonus: backfill sender_name de mensajes inbound previos sin nombre.
      if (fullName) {
        await env.DB.prepare(
          "UPDATE wa_messages SET sender_name = ? WHERE phone = ? AND direction = 'inbound' AND (sender_name IS NULL OR sender_name = '')"
        ).bind(fullName, phone).run();
      }
    } catch (_) {}
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

// Mapea el slug del usuario (del nombre que manda el front) a los posibles ids
// en users_panel. Cubre alias históricos: Joaquín↔joaco y Abril↔cursos (el
// botón del selector dice "Abril" pero el usuario en la base es 'cursos').
function userLookupIds(slug) {
  if (slug === 'joaquin' || slug === 'joaco') return ['joaquin', 'joaco'];
  if (slug === 'abril' || slug === 'cursos') return ['abril', 'cursos'];
  return [slug];
}

// Rol funcional del usuario de la sesión: admin | comercial | disenador | cursos.
// gaspar siempre admin; el resto se resuelve por su slug contra users_panel.
async function getSessionRole(env, userName) {
  const slug = String(userName || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (slug === 'gaspar') return 'admin';
  const ids = userLookupIds(slug);
  const ph = ids.map(() => '?').join(',');
  try {
    const u = await env.DB.prepare(`SELECT rol FROM users_panel WHERE id IN (${ph}) AND activo = 1 LIMIT 1`).bind(...ids).first();
    return (u && u.rol) ? u.rol : 'comercial';
  } catch (e) { return 'comercial'; }
}

// Cláusula SQL de filtrado de bandeja según rol (para la lista de chats).
//   admin     → sin filtro (ve todo)
//   cursos    → solo bandeja 'cursos'
//   los demás → todo MENOS 'cursos' (Joaco no ve los de cursos)
function inboxClauseForRole(role) {
  // 'oculto' = chats de broadcast aún sin respuesta: no se ven en NINGUNA
  // bandeja (ni admin) hasta que el cliente responde y se revelan.
  if (role === 'admin') return "AND inbox != 'oculto'";
  if (role === 'cursos') return "AND inbox = 'cursos'";
  return "AND inbox NOT IN ('cursos','oculto')";
}

// Control de acceso por chat para el rol 'cursos': solo puede leer/escribir
// chats que estén en la bandeja 'cursos'. Otros roles no se restringen acá.
async function inboxAccessOk(env, role, phone) {
  if (role !== 'cursos') return true;
  if (!phone) return false;
  try {
    const r = await env.DB.prepare('SELECT inbox FROM wa_chats_summary WHERE phone = ?').bind(phone).first();
    return !!r && r.inbox === 'cursos';
  } catch (e) { return false; }
}

// Invalida las variantes (por rol) del cache de chats-summary.
async function invalidateChatsSummaryCache(request) {
  try {
    const cache = caches.default;
    const base = new URL(request.url);
    base.pathname = '/admin/wa/chats-summary';
    for (const role of ['admin', 'comercial', 'disenador', 'cursos']) {
      base.search = '?role=' + role;
      await cache.delete(new Request(base.toString(), { method: 'GET' }));
    }
  } catch (_) {}
}

// ===== Framework de venta (hogar operativo del agente IA) =====
// Vive en D1 (tabla sales_framework, versionada). Se auto-siembra desde
// FRAMEWORK_SEED (worker/knowledge/framework-venta.md) si la tabla está vacía.
// El agente lee la versión activa en runtime; el bucle de retroalimentación
// inserta versiones nuevas con aprobación humana. Source: seed|manual|synthesis.
async function ensureFrameworkSeeded(env) {
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM sales_framework').first();
    if (row && row.n > 0) return;
    await env.DB.prepare(
      `INSERT INTO sales_framework (version, content, format, is_active, source, notes, created_by, created_at)
       VALUES (1, ?, 'md', 1, 'seed', 'Semilla inicial desde el repo', 'system', ?)`
    ).bind(FRAMEWORK_SEED, new Date().toISOString()).run();
    await deriveFrameworkSections(env, 1, FRAMEWORK_SEED);
  } catch (e) { try { console.error('sales_framework seed:', (e && e.message) || e); } catch (_) {} }
}

async function getActiveFramework(env) {
  await ensureFrameworkSeeded(env);
  return await env.DB.prepare(
    `SELECT version, content, format, source, notes, created_by, created_at
     FROM sales_framework WHERE is_active = 1 ORDER BY version DESC LIMIT 1`
  ).first();
}

// Parte el markdown del playbook en secciones (por encabezados # .. ######).
// Cada sección = { order_idx, level, heading, body }. Sirve para retrieval
// dirigido y feedback por sección (en vez de mandar el blob entero al modelo).
function parseMarkdownSections(md) {
  const lines = String(md || '').split(/\r?\n/);
  const sections = [];
  let cur = null;
  let order = 0;
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      if (cur) sections.push(cur);
      cur = { order_idx: order++, level: m[1].length, heading: m[2].trim(), body: '' };
    } else if (cur) {
      cur.body += (cur.body ? '\n' : '') + line;
    }
  }
  if (cur) sections.push(cur);
  return sections.map(s => ({ order_idx: s.order_idx, level: s.level, heading: s.heading, body: s.body.trim() }));
}

// Deriva (regenera) las secciones de una versión del playbook en framework_sections.
async function deriveFrameworkSections(env, version, content) {
  try {
    const secs = parseMarkdownSections(content);
    await env.DB.prepare('DELETE FROM framework_sections WHERE version = ?').bind(version).run();
    const now = new Date().toISOString();
    for (const s of secs) {
      await env.DB.prepare(
        `INSERT INTO framework_sections (version, order_idx, level, heading, body, tags, created_at)
         VALUES (?, ?, ?, ?, ?, '', ?)`
      ).bind(version, s.order_idx, s.level, s.heading, s.body, now).run();
    }
  } catch (e) { try { console.error('deriveFrameworkSections:', (e && e.message) || e); } catch (_) {} }
}

// Asegura que existan las secciones de una versión (deriva on-demand si faltan).
async function ensureSectionsForVersion(env, version, content) {
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM framework_sections WHERE version = ?').bind(version).first();
    if (row && row.n > 0) return;
    await deriveFrameworkSections(env, version, content);
  } catch (_) {}
}

// Distancia de Levenshtein (para edit_distance entre sugerencia y mensaje enviado).
function levenshtein(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let v0 = new Array(b.length + 1), v1 = new Array(b.length + 1);
  for (let i = 0; i <= b.length; i++) v0[i] = i;
  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    const tmp = v0; v0 = v1; v1 = tmp;
  }
  return v0[b.length];
}

// ===== Copiloto: motor de respuestas sugeridas (Fase 2) =====
// Reglas duras del agente (separadas del playbook, que va cacheado aparte).
const SUGGEST_SYSTEM_RULES = `Sos parte del equipo de ventas de Neon Infinito (carteles de neón LED y cursos para aprender a fabricarlos, Argentina). Te paso una conversación real de WhatsApp con un cliente y el PLAYBOOK de ventas del negocio. Tu tarea: sugerir el PRÓXIMO mensaje para mandarle al cliente, listo para enviar.

REGLAS DURAS (no negociables):
1. PRIMERO clasificá la vertical del lead: "carteles" (quiere un cartel para su local/un regalo), "cursos" (quiere aprender / Neon Mastery), "supernova" (ya fabrica y quiere escalar ventas), o "ambiguo". Aplicá el criterio de esa vertical (ver playbook: 8A.0 router + PARTE A carteles + PARTE B cursos). NUNCA cruces criterios: no mandes render/medidas/seña a un lead de curso, ni testimonios de "facturá millones" a un dueño de local que solo quiere un cartel.
2. NUNCA inventes NI AFIRMES datos que no estén EXPLÍCITOS en el chat o el playbook: precios, plazos de entrega, garantías, datos de pago, condiciones, NI el estado de un pedido (ej. "ya está en producción", "esta semana lo armamos"), fechas de avance, ni qué se fabricó/qué base lleva. Si no lo sabés con certeza por el chat, NO lo afirmes: preguntá o decí que lo confirmás (ej. "dejame chequear cómo viene y te confirmo"), ponelo en "missing_info" y bajá la confianza. Para cotizar un cartel hace falta foto + medidas (alto y ancho) + interior/exterior — nunca tires un precio a ojo.
3. TONO — imitá EXACTAMENTE cómo escribe el equipo (mirá los mensajes de JOACO en el historial). Es WhatsApp argentino informal, NO formal:
   - SIN signos de apertura: NUNCA uses ¿ ni ¡. Escribí "como va?" o "que bueno!", nunca "¿cómo va?" ni "¡qué bueno!".
   - SIN punto final: no cierres las oraciones con ".".
   - Emojis al MÍNIMO: 0 o como mucho 1 en todo el mensaje, nunca varios.
   - Voseo, frases cortas, cercano, humano. Nada robótico ni corporativo. Si no sabés el nombre, arrancá con "Buenas".
4. Espejá el registro de ESA conversación (nivel de formalidad, largo de los mensajes, cómo saluda Joaco). Tu sugerencia tiene que sentirse escrita por la misma persona que venía respondiendo, no por un bot.
5. Si conviene un humano (B2B de varios locales, dudas fuertes de precio/financiación, una queja, o te falta info clave para responder bien), poné should_escalate=true con el motivo y hacé un draft prudente (sin comprometer nada).

Devolvé SOLO un objeto JSON (sin markdown, sin texto extra) con EXACTAMENTE este shape:
{"vertical":"carteles|cursos|supernova|ambiguo","intent":"string corto","draft":"el mensaje sugerido, en tono NI","confidence":0.0,"sources_used":["secciones del playbook usadas"],"missing_info":["datos que faltan y NO inventaste, ej: precio, plazo, garantía"],"should_escalate":false,"escalation_reason":""}`;

// Genera una respuesta sugerida para el último mensaje de un chat. NO la envía.
// opts.dry=true devuelve el contexto armado sin llamar a Claude (para test/inspección).
async function suggestReply(env, phone, opts = {}) {
 try {
  const ctx = await buildChatContext(env, phone, 40);
  if (!ctx) return { ok: false, error: 'sin mensajes para este phone' };

  const conv = await env.DB.prepare(
    `SELECT vertical, product_type, customer_profile, objections, what_worked, next_action
     FROM wa_conversations WHERE phone = ?`
  ).bind(phone).first();

  // Ejemplos ganadores: qué cerró en ventas concretadas del mismo producto.
  let examples = [];
  try {
    const exr = conv?.product_type
      ? await env.DB.prepare(`SELECT what_worked FROM wa_conversations WHERE outcome='sold' AND what_worked != '' AND product_type = ? ORDER BY last_analyzed_at DESC LIMIT 3`).bind(conv.product_type).all()
      : await env.DB.prepare(`SELECT what_worked FROM wa_conversations WHERE outcome='sold' AND what_worked != '' ORDER BY last_analyzed_at DESC LIMIT 3`).all();
    examples = (exr.results || []).map(e => e.what_worked).filter(Boolean);
  } catch (_) {}

  const fw = await getActiveFramework(env);
  const frameworkText = fw?.content || '';
  const frameworkVersion = fw?.version || null;

  let userContent = ctx.fullText + '\n\n';
  if (conv) {
    userContent += `## ANÁLISIS PREVIO DEL CLIENTE\n`;
    if (conv.vertical) userContent += `Vertical: ${conv.vertical}\n`;
    if (conv.customer_profile) userContent += `Perfil: ${conv.customer_profile}\n`;
    if (conv.objections) userContent += `Objeciones detectadas: ${conv.objections}\n`;
    if (conv.next_action) userContent += `Próxima acción (del análisis): ${conv.next_action}\n`;
    userContent += '\n';
  }
  if (examples.length) {
    userContent += `## QUÉ FUNCIONÓ EN VENTAS CERRADAS PARECIDAS (referencia, no copiar literal)\n`;
    examples.forEach((e, i) => { userContent += `${i + 1}. ${e}\n`; });
    userContent += '\n';
  }
  userContent += `Sugerí el PRÓXIMO mensaje para mandarle al cliente ahora. Devolvé SOLO el JSON.`;

  if (opts.dry) {
    return { ok: true, dry: true, framework_version: frameworkVersion, framework_chars: frameworkText.length,
             examples: examples.length, has_analysis: !!conv, user_chars: userContent.length,
             user_preview: userContent.slice(0, 1400) };
  }
  if (!env.ANTHROPIC_API_KEY) return { ok: false, error: 'ANTHROPIC_API_KEY no configurada' };

  const system = [
    { type: 'text', text: SUGGEST_SYSTEM_RULES },
    { type: 'text', text: '## PLAYBOOK DE VENTAS\n\n' + frameworkText, cache_control: { type: 'ephemeral' } }
  ];
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1000, system, messages: [{ role: 'user', content: userContent }] })
    });
    const j = await r.json();
    if (!r.ok) return { ok: false, error: j.error?.message || ('HTTP ' + r.status), raw: j };
    const text = j.content?.[0]?.text || '';
    let parsed;
    try { parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()); }
    catch (e) { return { ok: false, error: 'JSON parse error', raw: text.slice(0, 1500) }; }

    const missing = Array.isArray(parsed.missing_info) ? parsed.missing_info : [];
    const sensitive = missing.some(m => /precio|plazo|garant|pago|cuota|tiempo|entrega|financ/i.test(String(m)));
    const conf = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
    const lowConfidence = conf < 0.7 || sensitive || parsed.should_escalate === true;
    const ti = j.usage?.input_tokens || 0;
    const tcw = j.usage?.cache_creation_input_tokens || 0;
    const tcr = j.usage?.cache_read_input_tokens || 0;
    const to = j.usage?.output_tokens || 0;
    // Costo real (precios Sonnet jun 2026): input $3, cache write $3.75, cache read $0.30, output $15 /MTok.
    const cost = +(((ti * 3 + tcw * 3.75 + tcr * 0.30 + to * 15) / 1000000).toFixed(5));
    try {
      await env.DB.prepare(
        `INSERT INTO copilot_usage (phone, kind, model, tokens_in, tokens_out, cache_read, cache_creation, cost_usd, created_by, created_at)
         VALUES (?, 'suggest', 'claude-sonnet-4-5', ?, ?, ?, ?, ?, ?, ?)`
      ).bind(phone, ti, to, tcr, tcw, cost, opts.createdBy || '', new Date().toISOString()).run();
    } catch (_) {}
    return {
      ok: true,
      suggestion: {
        vertical: parsed.vertical || (conv?.vertical || ''),
        intent: parsed.intent || '',
        draft: String(parsed.draft || ''),
        confidence: conf,
        low_confidence: lowConfidence,
        sources_used: Array.isArray(parsed.sources_used) ? parsed.sources_used : [],
        missing_info: missing,
        should_escalate: parsed.should_escalate === true || sensitive,
        escalation_reason: parsed.escalation_reason || (sensitive ? 'falta info sensible (precio/plazo/garantía) — confirmá con humano' : '')
      },
      framework_version: frameworkVersion,
      model: 'claude-sonnet-4-5',
      tokens_in: ti, tokens_out: to, cache_read: tcr, cache_creation: tcw,
      cost_usd: cost
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
 } catch (outer) {
   return { ok: false, error: 'suggest: ' + String((outer && outer.message) || outer) };
 }
}

// ===== Fase 2C: bucle de auto-mejora del playbook =====
// Lee el feedback acumulado (ediciones/descartes de sugerencias) + lo que cerró
// ventas y las objeciones que perdieron, y propone mejoras CONCRETAS al playbook.
// Cada propuesta queda 'pending' hasta que Gaspar la aprueba. Al aprobar, se crea
// una versión nueva del framework con el cambio aplicado y se activa. NUNCA toca
// el playbook sin aprobación humana.

// Crea la tabla on-demand (belt-and-suspenders: aunque la migración no se haya
// corrido todavía en este entorno, los endpoints no 500ean).
async function ensureImprovementsSchema(env) {
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS framework_improvements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL DEFAULT 'pending',
        vertical TEXT NOT NULL DEFAULT 'general',
        title TEXT NOT NULL DEFAULT '',
        rationale TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '',
        target_heading TEXT NOT NULL DEFAULT '',
        operation TEXT NOT NULL DEFAULT 'append',
        proposed_content TEXT NOT NULL DEFAULT '',
        confidence REAL,
        based_on_version INTEGER,
        source_model TEXT NOT NULL DEFAULT '',
        batch_id TEXT NOT NULL DEFAULT '',
        applied_version INTEGER,
        reviewed_by TEXT NOT NULL DEFAULT '',
        reviewed_at TEXT,
        review_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      )`
    ).run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_framework_improvements_status ON framework_improvements(status)').run();
  } catch (e) { try { console.error('ensureImprovementsSchema:', (e && e.message) || e); } catch (_) {} }
}

// Cirugía sobre el markdown crudo del playbook (preserva el resto del doc tal
// cual; no reserializa desde secciones parseadas, que perdería formato). Busca el
// encabezado destino por texto normalizado y aplica append/replace, o suma una
// sección nueva al final. Si no encuentra el destino, NUNCA pierde el cambio:
// lo agrega como sección nueva al final.
function applyEditToMarkdown(md, edit) {
  const content = String(edit?.proposed_content || '').trim();
  if (!content) return String(md || '');
  const text = String(md || '');
  const op = ['append', 'replace', 'new_section'].includes(edit?.operation) ? edit.operation : 'append';
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const appendAtEnd = () => text.replace(/\s+$/, '') + '\n\n' + content + '\n';
  if (op === 'new_section' || !edit?.target_heading) return appendAtEnd();

  const lines = text.split(/\r?\n/);
  const target = norm(edit.target_heading);
  let hi = -1, hlevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (m && norm(m[2]) === target) { hi = i; hlevel = m[1].length; break; }
  }
  if (hi === -1) return appendAtEnd(); // no se encontró la sección → no perder el cambio

  // Fin de la sección: próximo encabezado de nivel <= al del target (o EOF).
  let end = lines.length;
  for (let i = hi + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= hlevel) { end = i; break; }
  }
  if (op === 'replace') {
    const out = lines.slice(0, hi).concat([lines[hi], '', content], lines.slice(end));
    return out.join('\n');
  }
  // append: insertar al final del cuerpo de la sección (antes del próximo heading),
  // salteando líneas en blanco finales.
  let insertAt = end;
  while (insertAt > hi + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  const out = lines.slice(0, insertAt).concat(['', content], lines.slice(insertAt));
  return out.join('\n');
}

// Junta la evidencia real para la síntesis. Devuelve texto armado + contadores.
async function gatherSynthesisEvidence(env) {
  const safe = async (q, ...b) => { try { return (await env.DB.prepare(q).bind(...b).all()).results || []; } catch (_) { return []; } };
  // (a) Ediciones con cambio significativo: el draft estuvo flojo y el humano lo
  //     corrigió. El "final" es el patrón correcto.
  const edits = await safe(
    `SELECT suggested_text, final_text, vertical, objection, edit_distance
       FROM suggestion_feedback WHERE action='edited' AND edit_distance >= 3
       ORDER BY created_at DESC LIMIT 40`);
  // (b) Descartes: lo que NO había que sugerir.
  const discards = await safe(
    `SELECT suggested_text, vertical, objection
       FROM suggestion_feedback WHERE action='ignored'
       ORDER BY created_at DESC LIMIT 25`);
  // (c) Ventas cerradas: qué funcionó (por vertical/producto).
  const wins = await safe(
    `SELECT product_type, vertical, what_worked, objections
       FROM wa_conversations WHERE outcome='sold' AND what_worked != ''
       ORDER BY last_analyzed_at DESC LIMIT 25`);
  // (d) Ventas perdidas: objeciones/qué falló.
  const losses = await safe(
    `SELECT product_type, vertical, objections, what_didnt, outcome_reason
       FROM wa_conversations WHERE outcome='lost' AND (objections != '' OR what_didnt != '')
       ORDER BY last_analyzed_at DESC LIMIT 20`);

  const counts = { edits: edits.length, discards: discards.length, wins: wins.length, losses: losses.length };
  let txt = '';
  if (edits.length) {
    txt += `## CORRECCIONES DEL HUMANO A LAS SUGERENCIAS (el copiloto sugirió X, el humano lo cambió a Y antes de mandar)\n`;
    edits.forEach((e, i) => {
      txt += `${i + 1}. [${e.vertical || 's/d'}]${e.objection ? ' obj: ' + e.objection : ''}\n   SUGERIDO: ${String(e.suggested_text || '').slice(0, 400)}\n   ENVIADO:  ${String(e.final_text || '').slice(0, 400)}\n`;
    });
    txt += '\n';
  }
  if (discards.length) {
    txt += `## SUGERENCIAS DESCARTADAS (el humano NO las mandó — qué evitar)\n`;
    discards.forEach((e, i) => { txt += `${i + 1}. [${e.vertical || 's/d'}] ${String(e.suggested_text || '').slice(0, 300)}\n`; });
    txt += '\n';
  }
  if (wins.length) {
    txt += `## VENTAS CERRADAS — QUÉ FUNCIONÓ\n`;
    wins.forEach((e, i) => { txt += `${i + 1}. [${e.vertical || e.product_type || 's/d'}] ${String(e.what_worked || '').slice(0, 350)}\n`; });
    txt += '\n';
  }
  if (losses.length) {
    txt += `## VENTAS PERDIDAS — OBJECIONES / QUÉ FALLÓ\n`;
    losses.forEach((e, i) => { txt += `${i + 1}. [${e.vertical || e.product_type || 's/d'}] obj: ${String(e.objections || '').slice(0, 200)}${e.what_didnt ? ' | falló: ' + String(e.what_didnt).slice(0, 200) : ''}\n`; });
    txt += '\n';
  }
  return { text: txt, counts, total: edits.length + discards.length + wins.length + losses.length };
}

const SYNTHESIS_SYSTEM_RULES = `Sos el analista de mejora continua del equipo de ventas de Neon Infinito (carteles de neón LED y cursos para aprender a fabricarlos, Argentina). Tu trabajo: leer (a) el PLAYBOOK de ventas actual y (b) EVIDENCIA real de las últimas semanas — correcciones que el humano le hizo a las sugerencias del copiloto, sugerencias que descartó, qué cerró ventas y qué objeciones perdieron ventas — y proponer MEJORAS CONCRETAS al playbook.

PRINCIPIOS (no negociables):
1. SOLO proponé cambios respaldados por la EVIDENCIA que te paso. Cada propuesta cita el dato que la motiva (ej. "en 4 de 6 ediciones de carteles el humano sacó el precio y preguntó medidas primero"). NADA de consejos genéricos de ventas sin respaldo en los datos.
2. SEPARÁ carteles de cursos SIEMPRE. Una mejora para carteles no se mezcla con cursos. Si la evidencia es de una sola vertical, la propuesta es para esa vertical.
3. CONCRETO Y DIRIGIDO. Cada propuesta apunta a UNA sección existente del playbook (target_heading copiado EXACTO del playbook) con operation=append (sumar al final de esa sección) o replace (reescribir esa sección). Usá new_section solo si es un tema realmente nuevo. proposed_content es el markdown EXACTO a incorporar, en el mismo estilo y tono del playbook.
4. NO toques datos operativos (precios, alias, plazos, garantía, logística): esos los maneja el humano. Enfocate en: cómo redactar y secuenciar los mensajes, manejo de objeciones, criterio de calificación, qué preguntar y cuándo, errores a evitar.
5. CONSERVADOR. Máximo 5 propuestas, solo las de mayor impacto. Si la evidencia es delgada o no hay patrón claro, devolvé MENOS (o ninguna). Calidad sobre cantidad: una propuesta floja erosiona la confianza en el sistema.
6. El playbook es la "biblia" del negocio: afinalo con lo que pasa en la cancha, sin romper lo que ya funciona.

Devolvé SOLO un objeto JSON (sin markdown, sin texto extra) con EXACTAMENTE este shape:
{"improvements":[{"vertical":"carteles|cursos|supernova|general","title":"título corto","rationale":"el insight, por qué mejora la venta","evidence":"el dato concreto que lo respalda (con números si los hay)","target_heading":"encabezado EXACTO de la sección del playbook a tocar","operation":"append|replace|new_section","proposed_content":"el markdown exacto a incorporar","confidence":0.0}]}
Si no hay nada sólido que proponer, devolvé {"improvements":[]}.`;

// Corre la síntesis: junta evidencia, le pide a Opus propuestas, las guarda como
// 'pending'. opts.force salta el gate de "suficiente feedback nuevo".
async function synthesizeFrameworkImprovements(env, opts = {}) {
  try {
    if (!env.ANTHROPIC_API_KEY) return { ok: false, error: 'ANTHROPIC_API_KEY no configurada' };
    await ensureImprovementsSchema(env);

    // Gate: ¿hay suficiente feedback nuevo desde la última corrida?
    let newSinceLast = null;
    try {
      const last = await env.DB.prepare('SELECT MAX(created_at) AS t FROM framework_improvements').first();
      const fbq = last?.t
        ? await env.DB.prepare(`SELECT COUNT(*) AS n FROM suggestion_feedback WHERE action IN ('edited','ignored') AND created_at > ?`).bind(last.t).first()
        : await env.DB.prepare(`SELECT COUNT(*) AS n FROM suggestion_feedback WHERE action IN ('edited','ignored')`).first();
      newSinceLast = fbq?.n || 0;
    } catch (_) {}
    if (!opts.force && newSinceLast != null && newSinceLast < 12) {
      return { ok: true, generated: 0, skipped: true, reason: `poco feedback nuevo (${newSinceLast}/12) — no corro la síntesis para no gastar al pedo`, new_feedback: newSinceLast };
    }

    const ev = await gatherSynthesisEvidence(env);
    if (ev.total === 0) return { ok: true, generated: 0, skipped: true, reason: 'sin evidencia todavía (no hay ediciones, descartes ni ventas analizadas)', evidence_counts: ev.counts };

    const fw = await getActiveFramework(env);
    const frameworkText = fw?.content || '';
    const basedOnVersion = fw?.version || null;

    const userContent = `# EVIDENCIA REAL (últimas semanas)\n\n${ev.text}\n---\nAnalizá la evidencia contra el playbook y proponé mejoras concretas. Devolvé SOLO el JSON.`;
    const system = [
      { type: 'text', text: SYNTHESIS_SYSTEM_RULES },
      { type: 'text', text: '## PLAYBOOK DE VENTAS ACTUAL (v' + basedOnVersion + ')\n\n' + frameworkText }
    ];
    const model = 'claude-opus-4-5';
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 4000, system, messages: [{ role: 'user', content: userContent }] })
    });
    const j = await r.json();
    if (!r.ok) return { ok: false, error: j.error?.message || ('HTTP ' + r.status), raw: j };
    const text = j.content?.[0]?.text || '';
    let parsed;
    try { parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()); }
    catch (e) { return { ok: false, error: 'JSON parse error', raw: text.slice(0, 1500) }; }
    const improvements = Array.isArray(parsed.improvements) ? parsed.improvements.slice(0, 5) : [];

    // Costo (Opus: input $15, output $75 /MTok).
    const ti = j.usage?.input_tokens || 0;
    const to = j.usage?.output_tokens || 0;
    const tcr = j.usage?.cache_read_input_tokens || 0;
    const tcw = j.usage?.cache_creation_input_tokens || 0;
    const cost = +(((ti * 15 + tcw * 18.75 + tcr * 1.5 + to * 75) / 1000000).toFixed(5));
    try {
      await env.DB.prepare(
        `INSERT INTO copilot_usage (phone, kind, model, tokens_in, tokens_out, cache_read, cache_creation, cost_usd, created_by, created_at)
         VALUES (NULL, 'synthesis', ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(model, ti, to, tcr, tcw, cost, opts.createdBy || 'cron', new Date().toISOString()).run();
    } catch (_) {}

    const batchId = 'syn_' + Date.now();
    const now = new Date().toISOString();
    let saved = 0;
    for (const imp of improvements) {
      const op = ['append', 'replace', 'new_section'].includes(imp?.operation) ? imp.operation : 'append';
      const vertical = ['carteles', 'cursos', 'supernova', 'general'].includes(imp?.vertical) ? imp.vertical : 'general';
      const content = String(imp?.proposed_content || '').trim();
      const title = String(imp?.title || '').trim();
      if (!content || !title) continue;
      try {
        await env.DB.prepare(
          `INSERT INTO framework_improvements
             (status, vertical, title, rationale, evidence, target_heading, operation, proposed_content, confidence, based_on_version, source_model, batch_id, created_at)
           VALUES ('pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          vertical, title.slice(0, 200), String(imp?.rationale || '').slice(0, 2000),
          String(imp?.evidence || '').slice(0, 2000), String(imp?.target_heading || '').slice(0, 300),
          op, content.slice(0, 8000),
          (typeof imp?.confidence === 'number' ? imp.confidence : null),
          basedOnVersion, model, batchId, now
        ).run();
        saved++;
      } catch (_) {}
    }
    return { ok: true, generated: saved, batch_id: batchId, cost_usd: cost, based_on_version: basedOnVersion, evidence_counts: ev.counts, new_feedback: newSinceLast };
  } catch (e) {
    return { ok: false, error: 'synthesis: ' + String((e && e.message) || e) };
  }
}

// Aplica una propuesta aprobada: crea una versión nueva del framework con el
// cambio incorporado y la activa. overrideContent permite que Gaspar edite el
// texto antes de aplicar.
async function applyImprovementToFramework(env, imp, user, overrideContent) {
  const fw = await getActiveFramework(env);
  if (!fw) return { ok: false, error: 'no hay framework activo' };
  const effective = (overrideContent != null && String(overrideContent).trim()) ? String(overrideContent) : imp.proposed_content;
  const newMd = applyEditToMarkdown(fw.content, { operation: imp.operation, target_heading: imp.target_heading, proposed_content: effective });
  if (newMd === fw.content) return { ok: false, error: 'el cambio no modificó el playbook (revisá la sección destino)' };
  const maxRow = await env.DB.prepare('SELECT MAX(version) AS v FROM sales_framework').first();
  const nextV = (maxRow?.v || 0) + 1;
  await env.DB.prepare('UPDATE sales_framework SET is_active = 0 WHERE is_active = 1').run();
  await env.DB.prepare(
    `INSERT INTO sales_framework (version, content, format, is_active, source, notes, created_by, created_at)
     VALUES (?, ?, 'md', 1, 'synthesis', ?, ?, ?)`
  ).bind(nextV, newMd, ('2C #' + imp.id + ': ' + String(imp.title || '').slice(0, 120)), user, new Date().toISOString()).run();
  await deriveFrameworkSections(env, nextV, newMd);
  return { ok: true, version: nextV };
}

// ===== Panel de costos del sitio =====
// Inventario de servicios (IAs, infra, mensajería, almacenamiento, ads) + costo
// mensual. Anthropic se calcula solo y exacto; el resto lo carga Gaspar.

async function ensureCostsSchema(env) {
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS site_services (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sort_order INTEGER NOT NULL DEFAULT 100,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'otro',
        provider TEXT NOT NULL DEFAULT '',
        usage TEXT NOT NULL DEFAULT '',
        credential_location TEXT NOT NULL DEFAULT '',
        cost_type TEXT NOT NULL DEFAULT 'fixed',
        cost_amount REAL NOT NULL DEFAULT 0,
        cost_currency TEXT NOT NULL DEFAULT 'USD',
        auto_key TEXT NOT NULL DEFAULT '',
        billing_url TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    ).run();
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM site_services').first();
    if (!row || row.n === 0) await seedDefaultServices(env);
  } catch (e) { try { console.error('ensureCostsSchema:', (e && e.message) || e); } catch (_) {} }
}

async function seedDefaultServices(env) {
  const now = new Date().toISOString();
  // [sort, name, category, provider, usage, credential_location, cost_type, amount, currency, auto_key, billing_url, notes]
  const seed = [
    [10, 'Anthropic (Claude API)', 'ia', 'Anthropic', 'Copiloto de respuestas sugeridas, análisis de chats con IA y síntesis de mejoras al playbook (Fase 2C)', 'Cloudflare secret ANTHROPIC_API_KEY', 'auto', 0, 'USD', 'anthropic', 'https://console.anthropic.com/settings/billing', 'Se calcula solo y exacto desde el uso real. Modelos: Sonnet (copiloto/análisis) y Opus (síntesis).'],
    [20, 'Cloudflare (Workers + D1 + R2 + AI)', 'infra', 'Cloudflare', 'Backend del CRM (Worker), base de datos (D1), almacenamiento de media (R2) e IA de embeddings (Workers AI)', 'Cuenta Cloudflare (login) + wrangler', 'fixed', 0, 'USD', '', 'https://dash.cloudflare.com/?to=/:account/billing', 'Cargá tu costo: plan Workers Paid (~USD 5/mes) o gratis si estás en free tier. D1 actual ~92MB (dentro del free).'],
    [30, '360dialog (WhatsApp BSP)', 'mensajeria', '360dialog', 'Envío y recepción de WhatsApp (Cloud API) + plantillas. Es el proveedor activo desde el 31-may', 'Cloudflare secret D360_API_KEY + login hub.360dialog.com', 'fixed', 0, 'USD', '', 'https://hub.360dialog.com', 'IMPORTANTE: acá se carga el SALDO de WhatsApp (prepago), NO en la tarjeta de Meta. Incluye fee mensual de BSP + saldo de conversaciones.'],
    [40, 'Meta WhatsApp (conversaciones)', 'mensajeria', 'Meta', 'Costo por conversación de WhatsApp que cobra Meta (lo paga 360dialog desde tu saldo prepago)', 'WABA 800446462838166 (Meta Business)', 'usage', 0, 'USD', '', 'https://business.facebook.com/wa/manage/', 'Se descuenta del saldo de 360dialog, no de una tarjeta en Meta. Estimá según conversaciones del mes.'],
    [50, 'Google (Apps Script + Drive)', 'almacenamiento', 'Google', 'Apps Script (lee la Sheet de ventas + COGS del cotizador), Google Drive (Cerebro / base de conocimiento)', 'Cuenta Google neoninfinitok@gmail.com', 'free', 0, 'USD', '', 'https://one.google.com', 'Apps Script y Sheets son gratis. Solo cuesta si tenés Google One por almacenamiento extra de Drive.'],
    [60, 'GitHub Pages (frontend)', 'infra', 'GitHub', 'Hosting del frontend del CRM (sitio estático), deploy automático al pushear', 'Cuenta GitHub gasparmv', 'free', 0, 'USD', '', 'https://github.com/settings/billing', 'Gratis para GitHub Pages en repos públicos.'],
    [70, 'Meta Ads (publicidad)', 'ads', 'Meta', 'Anuncios B2B de captación de leads (campaña activa ~419 leads/mes)', 'Meta Ads Manager — cuenta "Lau - Neon" 882517310728279', 'usage', 0, 'ARS', '', 'https://adsmanager.facebook.com', 'Marketing, no es infraestructura del sitio. Se muestra aparte del total de infra.']
  ];
  for (const s of seed) {
    try {
      await env.DB.prepare(
        `INSERT INTO site_services (sort_order, name, category, provider, usage, credential_location, cost_type, cost_amount, cost_currency, auto_key, billing_url, notes, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).bind(s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], now, now).run();
    } catch (_) {}
  }
}

// Costo real de Anthropic del mes en curso (copilot_usage + wa_chat_analyses).
async function computeAnthropicMonthCost(env) {
  const ms = new Date(); ms.setUTCDate(1); ms.setUTCHours(0, 0, 0, 0); const m = ms.toISOString();
  const out = { total: 0, suggest: 0, synthesis: 0, analysis: 0 };
  try {
    const cu = (await env.DB.prepare(
      `SELECT kind, ROUND(SUM(cost_usd), 4) AS c FROM copilot_usage WHERE created_at >= ? GROUP BY kind`
    ).bind(m).all()).results || [];
    cu.forEach(r => { if (r.kind === 'suggest') out.suggest = r.c || 0; else if (r.kind === 'synthesis') out.synthesis = r.c || 0; });
  } catch (_) {}
  try {
    const an = await env.DB.prepare(
      `SELECT ROUND(SUM(cost_usd_estimated), 4) AS c FROM wa_chat_analyses WHERE analyzed_at >= ?`
    ).bind(m).first();
    out.analysis = an?.c || 0;
  } catch (_) {}
  out.total = +((out.suggest + out.synthesis + out.analysis).toFixed(4));
  return out;
}

async function getUsdArsRate(env) {
  try {
    const row = await env.DB.prepare(`SELECT v FROM kv_cache WHERE k = 'usd_ars_rate'`).first();
    const n = row ? parseFloat(row.v) : NaN;
    return (isFinite(n) && n > 0) ? n : null;
  } catch (_) { return null; }
}

// ===== Circuit breaker: bloqueo de pago de WhatsApp (error Meta 131042) =====
// Cuando Meta rechaza la ENTREGA con "Business eligibility payment issue" (131042),
// es un problema de PAGO en la cuenta de WhatsApp Business de META (su Billing Hub),
// NO del saldo de 360dialog ni del destinatario.
// Pausamos los envíos automáticos para no quemar contactos ni spamear a Gaspar,
// y reanudamos solos cuando un envío vuelve a salir OK (o tras un cooldown).
const WA_BILLING_BLOCK_KEY = 'wa_billing_block';
const WA_BILLING_COOLDOWN_MS = 3 * 60 * 60 * 1000;   // tras el último bloqueo, reintenta a las 3h
const WA_BILLING_NOTIFY_MS = 12 * 60 * 60 * 1000;    // avisa como mucho 1 vez cada 12h

function isBillingBlockError(code, msg) {
  if (code === 131042 || code === '131042') return true;
  const m = String(msg || '').toLowerCase();
  return m.includes('eligibility') || (m.includes('payment') && m.includes('issue'));
}

async function setWaBillingBlock(env, errMsg) {
  const now = Date.now();
  let prev = null;
  try { const row = await env.DB.prepare('SELECT v FROM kv_cache WHERE k=?').bind(WA_BILLING_BLOCK_KEY).first(); if (row) prev = JSON.parse(row.v); } catch (_) {}
  const lastNotify = (prev && prev.last_notify_at) || 0;
  const shouldNotify = (now - lastNotify) > WA_BILLING_NOTIFY_MS;
  const obj = {
    since: (prev && prev.since) || now,
    updated_at: now,
    count: ((prev && prev.count) || 0) + 1,
    last_error: String(errMsg || '').slice(0, 300),
    last_notify_at: shouldNotify ? now : lastNotify
  };
  try { await env.DB.prepare('INSERT INTO kv_cache (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at').bind(WA_BILLING_BLOCK_KEY, JSON.stringify(obj), new Date().toISOString()).run(); } catch (_) {}
  return { shouldNotify, count: obj.count };
}

async function clearWaBillingBlock(env) {
  try {
    const row = await env.DB.prepare('SELECT v FROM kv_cache WHERE k=?').bind(WA_BILLING_BLOCK_KEY).first();
    if (!row) return false; // no estaba bloqueado
    await env.DB.prepare('DELETE FROM kv_cache WHERE k=?').bind(WA_BILLING_BLOCK_KEY).run();
    return true; // estaba bloqueado y se resolvió
  } catch (_) { return false; }
}

async function isWaBillingBlocked(env) {
  try {
    const row = await env.DB.prepare('SELECT v FROM kv_cache WHERE k=?').bind(WA_BILLING_BLOCK_KEY).first();
    if (!row) return false;
    const obj = JSON.parse(row.v);
    return (Date.now() - ((obj && obj.updated_at) || 0)) < WA_BILLING_COOLDOWN_MS;
  } catch (_) { return false; }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    const url = new URL(request.url);
    const path = url.pathname;

    // ----- Health -----
    if (request.method === 'GET' && path === '/health') return json({ ok: true });

    // ===== Meta Lead Ads Webhook (separado del de WhatsApp) =====
    // Se suscribe en la Meta App "agente neon nuevo" (866678322681866) al campo
    // `leadgen` de la Page que recibe los leads (100517509701851).
    // Secretos requeridos:
    //   LEADGEN_VERIFY_TOKEN     — string random; Meta lo verifica al suscribir
    //   META_PAGE_ACCESS_TOKEN   — token de la Page con permiso leads_retrieval
    if (request.method === 'GET' && path === '/webhook/leads') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && token === env.LEADGEN_VERIFY_TOKEN && challenge) {
        return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      return new Response('Forbidden', { status: 403 });
    }
    if (request.method === 'POST' && path === '/webhook/leads') {
      let body;
      try { body = await request.json(); } catch { return json({ ok: true }); }
      // Log raw payload para debug temporal (luego se puede sacar).
      try {
        await env.DB.prepare('INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)').bind(
          new Date().toISOString(), 'LEADS: ' + JSON.stringify(body).slice(0, 4000)
        ).run();
      } catch (_) {}
      // Responder 200 inmediato a Meta. El procesamiento (fetch detalle + enviar
      // template) va en waitUntil para no bloquear la respuesta del webhook.
      ctx.waitUntil(processLeadgenWebhook(env, body));
      return json({ ok: true });
    }

    // ===== Bridge desde Google Sheets (Apps Script onChange) =====
    // Workaround mientras App Review aprueba leads_retrieval. Meta sincroniza
    // leads a la sheet nativamente, y un Apps Script en la sheet nos manda
    // cada fila nueva acá. Auth via header X-Sheet-Secret.
    if (request.method === 'POST' && path === '/webhook/sheet-lead') {
      const incoming = request.headers.get('x-sheet-secret') || '';
      if (!env.SHEET_BRIDGE_SECRET || incoming !== env.SHEET_BRIDGE_SECRET) {
        return json({ error: 'forbidden' }, 403);
      }
      let body;
      try { body = await request.json(); } catch { return json({ ok: true }); }
      try {
        await env.DB.prepare('INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)').bind(
          new Date().toISOString(), 'SHEET_LEAD: ' + JSON.stringify(body).slice(0, 4000)
        ).run();
      } catch (_) {}
      ctx.waitUntil(processSheetLead(env, body));
      return json({ ok: true });
    }

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
          // Coexistence — formato no-Meta: { id, event, data } directo en la raíz.
          // 360dialog envía 'event: history' (mensajes históricos del onboarding)
          // y 'event: smb_app_state_sync' (contactos sincronizados) en este formato
          // a la partner-configured webhook URL.
          if (body?.event === 'history' && body?.data) {
            await processCoexistenceHistory(env, body.data);
            return;
          }
          if (body?.event === 'smb_app_state_sync' && body?.data) {
            await processCoexistenceStateSync(env, body.data);
            return;
          }

          const entries = body?.entry || [];
          for (const entry of entries) {
            const changes = entry?.changes || [];
            for (const change of changes) {
              // Field 'message_template_status_update' = cambio de status de una
              // plantilla (APPROVED/REJECTED/PAUSED/DISABLED). Notificamos al admin
              // y dejamos de pollear monitorTemplateStatus.
              if (change?.field === 'message_template_status_update') {
                await processTemplateStatusUpdate(env, change.value || {});
                continue;
              }
              // Aceptamos: 'messages' (Meta estándar), 'smb_message_echoes'
              // (coexistence echoes), y 'history' (algunos history events vienen
              // en formato Meta-style con value.message_echoes adentro, además del
              // formato plano {event,data} que se maneja arriba).
              const allowedFields = new Set(['messages', 'smb_message_echoes', 'history']);
              if (!allowedFields.has(change?.field)) continue;
              const value = change?.value || {};
              const contacts = value?.contacts || [];
              const contactMap = {};
              for (const c of contacts) contactMap[c.wa_id] = c.profile?.name || '';
              // Coexistencia / Echoes: detectar mensajes SALIENTES (Joaco escribió
              // desde la app de WhatsApp Business) con MÚLTIPLES heurísticas porque
              // 360dialog puede no traer value.metadata.display_phone_number igual
              // que Meta direct.
              // 1) display_phone_number del metadata (Meta direct, ideal)
              // 2) env.WA_BUSINESS_PHONE (fallback hardcoded por wrangler secret)
              // 3) presencia de msg.to (Y from distinto del cliente) — heurística:
              //    los mensajes inbound del cliente NO traen msg.to, los echoes sí.
              const businessPhoneFromMeta = String(value?.metadata?.display_phone_number || '').replace(/\D/g, '');
              const businessPhoneFromEnv  = String(env.WA_BUSINESS_PHONE || '').replace(/\D/g, '');
              const businessPhones = new Set([businessPhoneFromMeta, businessPhoneFromEnv].filter(Boolean));

              // Log de diagnóstico: guardamos el primer message del primer batch
              // para inspeccionar el formato real de 360dialog. Truncado a 4KB.
              try {
                if (Array.isArray(value?.messages) && value.messages.length) {
                  const dbg = {
                    metadata: value.metadata,
                    sample_message_keys: Object.keys(value.messages[0]),
                    sample_message: value.messages[0],
                    business_phones_known: Array.from(businessPhones)
                  };
                  const dbgStr = JSON.stringify(dbg).slice(0, 4000);
                  await env.DB.prepare('INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)').bind(new Date().toISOString(), 'WEBHOOK_DEBUG: ' + dbgStr).run();
                }
              } catch(_) {}

              // Mensajes (entrantes y salientes vía echoes)
              for (const msg of (value?.messages || [])) {
                const fromNorm = String(msg.from || '').replace(/\D/g, '');
                const toNorm   = String(msg.to   || '').replace(/\D/g, '');
                // Echo si: from coincide con un número de business conocido, O si
                // tiene msg.to definido (los mensajes entrantes del cliente NO lo traen).
                const isOutboundEcho =
                  (businessPhones.size > 0 && businessPhones.has(fromNorm)) ||
                  (!!toNorm && fromNorm !== toNorm);
                // En echoes el destinatario viene en msg.to o en contacts[0]?.wa_id
                const recipient = toNorm || String(contacts[0]?.wa_id || '').replace(/\D/g, '');
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
                  // Meta sends error details for unsupported messages.
                  // El código 131051 ("Message type unknown") corresponde casi siempre
                  // a un mensaje EDITADO por el cliente — Meta no expone la edición
                  // por Cloud API, solo te notifica que algo cambió.
                  const errTitle = msg.errors?.[0]?.title || '';
                  const errCode  = msg.errors?.[0]?.code;
                  const errDetails = msg.errors?.[0]?.details || msg.errors?.[0]?.message || '';
                  let classified;
                  if (errCode === 131051 || errTitle === 'Message type unknown') {
                    msgBody = '✏️ El cliente editó un mensaje (Meta no comparte el contenido editado)';
                    classified = 'edited';
                  } else if (errTitle.includes('unavailable')) {
                    msgBody = '[mensaje no disponible]';
                    classified = 'unavailable';
                  } else {
                    msgBody = `[no soportado: ${errTitle || 'desconocido'}]`;
                    classified = 'other';
                  }
                  // Guardamos el payload crudo del mensaje para diagnosticar por qué
                  // Meta no comparte el contenido. La tabla tiene índice por ts/phone.
                  // No bloqueamos el flujo principal si esto falla.
                  try {
                    const rawPayload = JSON.stringify(msg).slice(0, 8000);
                    await env.DB.prepare(
                      'INSERT INTO wa_webhook_debug (ts, inserted_at, wamid, phone, sender_name, error_code, error_title, error_details, msg_type, classified_as, raw_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                    ).bind(
                      msg.timestamp ? new Date(parseInt(msg.timestamp) * 1000).toISOString() : new Date().toISOString(),
                      new Date().toISOString(),
                      msg.id || '',
                      phone || '',
                      senderName || '',
                      errCode || null,
                      errTitle,
                      typeof errDetails === 'string' ? errDetails : JSON.stringify(errDetails),
                      msg.type || 'unsupported',
                      classified,
                      rawPayload
                    ).run();
                  } catch (_) { /* ignore */ }
                }
                const contextId = msg.context?.id || msg.reaction?.message_id || '';
                const ts = msg.timestamp ? new Date(parseInt(msg.timestamp) * 1000).toISOString() : new Date().toISOString();
                // Download media to R2 if present (con reintentos: el webhook
                // suele llegar antes de que el media esté listo en Meta).
                let r2Key = '';
                if (mediaUrl && env.MEDIA) {
                  try {
                    const dl = await downloadMediaWithRetry(env, mediaUrl);
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

                // ===== Auto-recovery de unreachable =====
                // Si este contacto estaba marcado como unreachable y ahora nos
                // escribe, significa que NO está muerto. Lo desmarcamos para que
                // los flows automáticos vuelvan a considerarlo.
                if (direction === 'inbound' && phone) {
                  try { await removeUnreachable(env, phone); } catch (_) {}
                }
                // ===== Auto-respuesta del minicurso (regalos) =====
                // Solo inbound de texto reciente (últimos 10 min) que pida la
                // guía + cotizador. Mensaje libre (ventana 24h). Una vez por
                // contacto y deriva el chat a la bandeja de cursos (Abril).
                if (direction === 'inbound' && matchMinicursoTrigger(msgBody)) {
                  const reciente = (Date.now() - new Date(ts).getTime()) < 10 * 60 * 1000;
                  if (reciente) {
                    try { await maybeAutoReplyMinicurso(env, phone, senderName); } catch (_) {}
                  }
                }
                // ===== Campaña de cursos: si este inbound responde a un broadcast
                // oculto, IA evalúa, manda el evento si es positiva, y revela el
                // chat a Abril. (No hace nada si el chat no es de la campaña.) =====
                if (direction === 'inbound') {
                  try { await revealCursosCampaign(env, phone, msgBody); } catch (_) {}
                }
                // ===== Minicurso: si este inbound responde al gate de feedback,
                // la IA evalúa y le manda el link de regalos si es positiva. =====
                if (direction === 'inbound') {
                  try { await maybeSendMinicursoGift(env, phone, msgBody, ts); } catch (_) {}
                }

                // ===== Ad Attribution (referral) =====
                // Cuando un cliente clickea un ad de Meta (Click-to-WhatsApp) y manda
                // mensaje, Meta inyecta un objeto `referral` con info del ad de origen.
                // Lo guardamos en wa_ad_attributions para trazabilidad y dashboard.
                const ref = msg.referral;
                if (ref && ref.source_id) {
                  try {
                    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS wa_ad_attributions (
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      phone TEXT NOT NULL,
                      wamid TEXT,
                      ts TEXT NOT NULL,
                      source_id TEXT,
                      source_type TEXT,
                      source_url TEXT,
                      headline TEXT,
                      body TEXT,
                      media_type TEXT,
                      image_url TEXT,
                      video_url TEXT,
                      thumbnail_url TEXT,
                      ctwa_clid TEXT,
                      ad_name TEXT,
                      ad_set_name TEXT,
                      campaign_name TEXT,
                      created_at TEXT NOT NULL
                    )`).run();
                    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_wa_ad_attr_phone ON wa_ad_attributions(phone)`).run();
                    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_wa_ad_attr_source ON wa_ad_attributions(source_id)`).run();
                    const nowIso = new Date().toISOString();
                    await env.DB.prepare(`INSERT INTO wa_ad_attributions
                      (phone, wamid, ts, source_id, source_type, source_url, headline, body, media_type, image_url, video_url, thumbnail_url, ctwa_clid, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).bind(
                      phone,
                      wamid,
                      ts,
                      String(ref.source_id || ''),
                      String(ref.source_type || ''),
                      String(ref.source_url || ''),
                      String(ref.headline || ''),
                      String(ref.body || ''),
                      String(ref.media_type || ''),
                      String(ref.image_url || ''),
                      String(ref.video_url || ''),
                      String(ref.thumbnail_url || ''),
                      String(ref.ctwa_clid || ''),
                      nowIso
                    ).run();
                  } catch (e) {
                    try { await env.DB.prepare('INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)').bind(new Date().toISOString(), 'AD_ATTR_ERR: ' + (e?.message || String(e))).run(); } catch(_) {}
                  }
                }

                // Auto-labeling: deshabilitado por pedido del usuario (el matching
                // por keywords genera demasiados falsos positivos). El código
                // queda en applyAutoLabels() por si se quiere reactivar.
              }

              // Coexistence: smb_message_echoes — mensajes que Joaco escribió
              // desde la app de WhatsApp Business del celular. 360dialog los manda
              // en `value.message_echoes[]` (NO en value.messages), con field:
              // 'smb_message_echoes'. Por eso antes los ignorábamos silenciosamente.
              // Estructura del echo:
              //   { from: businessNumber, to: clientNumber, id, timestamp, type, text|image|...}
              for (const echo of (value?.message_echoes || [])) {
                const wamid = echo.id || '';
                if (!wamid) continue;
                const phone = String(echo.to || '').replace(/\D/g, ''); // destinatario = cliente
                const ts = echo.timestamp ? new Date(parseInt(echo.timestamp) * 1000).toISOString() : new Date().toISOString();
                const msgType = echo.type || 'unknown';
                let msgBody = '';
                let mediaUrl = '';
                if (echo.text) msgBody = echo.text.body || '';
                else if (echo.image) { msgBody = echo.image.caption || ''; mediaUrl = echo.image.id || ''; }
                else if (echo.video) { msgBody = echo.video.caption || ''; mediaUrl = echo.video.id || ''; }
                else if (echo.audio) { mediaUrl = echo.audio.id || ''; }
                else if (echo.document) { msgBody = echo.document.filename || ''; mediaUrl = echo.document.id || ''; }
                else if (echo.sticker) { mediaUrl = echo.sticker.id || ''; }
                else if (echo.reaction) { msgBody = echo.reaction.emoji || ''; }
                else if (echo.location) { msgBody = `[ubicacion] ${echo.location.latitude},${echo.location.longitude}${echo.location.name ? ' — ' + echo.location.name : ''}`; }
                const contextId = echo.context?.id || echo.reaction?.message_id || '';
                // Bajar media a R2 si tiene id (algunos echoes traen el media id).
                let r2Key = '';
                if (mediaUrl && env.MEDIA) {
                  try { const dl = await downloadMediaWithRetry(env, mediaUrl); if (dl) r2Key = dl.key; } catch (_) {}
                }
                if (msgType === 'audio' && r2Key && env.AI) {
                  try { const t = await transcribeAudio(env, r2Key); if (t) msgBody = '[audio] ' + t; } catch (_) {}
                }
                if (msgType === 'image' && r2Key && env.AI) {
                  try { const desc = await analyzeImage(env, r2Key); if (desc) msgBody = (msgBody ? msgBody + ' | ' : '') + '[imagen] ' + desc; } catch (_) {}
                }
                try {
                  // Upsert. Si el wamid ya existe como placeholder de status (body
                  // vacío, msg_type='status'), lo completamos con el body real del echo.
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
                  ).bind(ts, wamid, 'outbound', phone, '', msgType, msgBody, r2Key || mediaUrl, contextId, null).run();
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
                  // Si un envío vuelve a salir OK y había bloqueo de pago activo,
                  // levantarlo (se reanudan los flujos automáticos) y avisar.
                  if (status === 'sent' || status === 'delivered') {
                    try { if (await clearWaBillingBlock(env) && env.ADMIN_NOTIFY_PHONE) await waSendText(env, env.ADMIN_NOTIFY_PHONE, 'WhatsApp volvió a andar — reanudo los envíos automáticos'); } catch (_) {}
                  }
                  // Notificar al admin si el envío FALLA (primera vez que llega como failed)
                  if (status === 'failed' && prevStatus !== 'failed') {
                    const errs = Array.isArray(st.errors) ? st.errors : [];
                    const errCode = errs.length ? errs[0].code : null;
                    // Evitar el duplicado feo "X: X" cuando title === message.
                    const errMsg = errs.length
                      ? (errs[0].title || 'error') + (errs[0].message && errs[0].message !== errs[0].title ? ': ' + errs[0].message : '')
                      : 'sin detalle';
                    if (isBillingBlockError(errCode, errMsg)) {
                      // Bloqueo de cuenta por pago: pausar envíos automáticos + avisar 1 vez por episodio.
                      const { shouldNotify } = await setWaBillingBlock(env, errMsg);
                      if (shouldNotify && env.ADMIN_NOTIFY_PHONE) {
                        try { await waSendText(env, env.ADMIN_NOTIFY_PHONE, '🔴 WhatsApp BLOQUEADO por pago — Meta error 131042 (pagos pendientes en la cuenta de WhatsApp Business).\nRegularizá en el Billing Hub de META: business.facebook.com/billing_hub (OJO: es de Meta, NO el saldo de 360dialog).\nPausé los envíos automáticos para no quemar contactos — se reanudan solos cuando vuelva a andar.'); } catch (_) {}
                      }
                    } else if (env.ADMIN_NOTIFY_PHONE) {
                      // Fallo puntual (destinatario, etc.) → aviso por mensaje, como antes.
                      const preview = prevBody ? prevBody.slice(0, 100) + (prevBody.length > 100 ? '…' : '') : '';
                      const summary = `⚠ Falló envío WA a ${phone}\nError: ${errMsg}` + (preview ? `\nMensaje: "${preview}"` : '');
                      try { await waSendText(env, env.ADMIN_NOTIFY_PHONE, summary); } catch (_) {}
                    }
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
      // Alias del slug → ids posibles en users_panel (Joaquín↔joaco, Abril↔cursos).
      const lookupIds = userLookupIds(userSlug);
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

    // DEBUG público temporal — reprocesar imágenes pendientes (media_url con id raw).
    if (request.method === 'POST' && path === '/debug/media-reprocess') {
      // Trae media images con media_url numérico (no wa/...) y las baja a R2.
      const rs = await env.DB.prepare(
        "SELECT id, media_url FROM wa_messages WHERE msg_type IN ('image','video','audio','document','sticker') AND media_url GLOB '[0-9]*' AND length(media_url) > 8 ORDER BY id DESC LIMIT 200"
      ).all();
      const pending = rs.results || [];
      let ok = 0, fail = 0;
      const errors = [];
      for (const row of pending) {
        try {
          const result = await downloadMedia(env, row.media_url);
          if (result) {
            await env.DB.prepare('UPDATE wa_messages SET media_url = ? WHERE id = ?').bind(result.key, row.id).run();
            ok++;
          } else {
            fail++;
            errors.push({ id: row.id, media: row.media_url, reason: 'null' });
          }
        } catch (e) { fail++; errors.push({ id: row.id, err: e.message }); }
      }
      return json({ ok, fail, total: pending.length, errors: errors.slice(0, 10) });
    }

    // DEBUG temporal — reprocesar UN media específico (id puntual).
    if (request.method === 'GET' && /^\/debug\/media\/\d+$/.test(path)) {
      const mediaId = path.split('/').pop();
      try {
        const result = await downloadMedia(env, mediaId);
        if (!result) return json({ ok: false, mediaId });
        // Actualizar wa_messages si hay rows con ese mediaId raw.
        await env.DB.prepare('UPDATE wa_messages SET media_url = ? WHERE media_url = ?').bind(result.key, mediaId).run();
        return json({ ok: true, mediaId, ...result });
      } catch (e) {
        return json({ ok: false, error: e.message, mediaId });
      }
    }

    // ----- Cotizador params (público lectura) -----
    if (request.method === 'GET' && path === '/cotizador/params') {
      const rs = await env.DB.prepare('SELECT key, value FROM cotizador_params').all();
      const params = {};
      for (const r of (rs.results || [])) params[r.key] = r.value;
      return json({ params });
    }

    // ----- COGS del Excel 2026v4 (proxy al Apps Script) -----
    // El front no puede leer el Apps Script directo (CORS lo bloquea), así que
    // el worker hace de proxy server-to-server. Devuelve los costos reales del
    // mes actual leídos de la hoja COGS, para que el cotizador nuevo cotice con
    // datos vivos. Cache D1 (TTL 20 min) salvo ?fresh=1 que fuerza relectura.
    if (request.method === 'GET' && path === '/cotizador/cogs') {
      const scriptUrl = env.APPS_SCRIPT_URL;
      if (!scriptUrl) return json({ error: 'APPS_SCRIPT_URL no configurada en el worker' }, 500);
      const fresh = url.searchParams.get('fresh') === '1';
      const TTL_MS = 20 * 60 * 1000;
      // 1) Cache en kv_cache (key 'cogs_excel').
      if (!fresh) {
        try {
          const cached = await env.DB.prepare(
            "SELECT v, updated_at FROM kv_cache WHERE k = 'cogs_excel'"
          ).first();
          if (cached && cached.v && cached.updated_at) {
            const age = Date.now() - Date.parse(cached.updated_at);
            if (age >= 0 && age < TTL_MS) {
              return json({ ...JSON.parse(cached.v), cached: true, age_ms: age });
            }
          }
        } catch (_) { /* cache miss o JSON inválido → seguimos al fetch */ }
      }
      // 2) Fetch al Apps Script (server-to-server, sin CORS).
      let data;
      try {
        const r = await fetch(scriptUrl + '?action=cogs', { redirect: 'follow' });
        data = await r.json();
      } catch (e) {
        // Si falla la red, devolvemos el cache aunque esté vencido.
        try {
          const stale = await env.DB.prepare("SELECT v FROM kv_cache WHERE k = 'cogs_excel'").first();
          if (stale && stale.v) return json({ ...JSON.parse(stale.v), cached: true, stale: true });
        } catch (_) {}
        return json({ error: 'no pude leer COGS del Apps Script: ' + (e.message || e) }, 502);
      }
      // 3) Guardar en cache solo si vino bien.
      if (data && data.ok) {
        try {
          await env.DB.prepare(
            "INSERT INTO kv_cache (k, v, updated_at) VALUES ('cogs_excel', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at"
          ).bind(JSON.stringify(data), new Date().toISOString()).run();
        } catch (_) { /* si falla el cache no es fatal */ }
      }
      return json(data);
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

      // ----- Framework de venta (sales_framework) -----
      // Lectura: cualquier sesión válida (ver el playbook). Escritura: solo admin.
      if (request.method === 'GET' && path === '/admin/framework') {
        const fw = await getActiveFramework(env);
        if (fw && url.searchParams.get('sections')) {
          await ensureSectionsForVersion(env, fw.version, fw.content);
          const rs = await env.DB.prepare(
            'SELECT order_idx, level, heading, body, tags FROM framework_sections WHERE version = ? ORDER BY order_idx'
          ).bind(fw.version).all();
          return json({ ok: true, framework: fw, sections: (rs.results || []) });
        }
        return json({ ok: true, framework: fw || null });
      }
      if (request.method === 'GET' && path === '/admin/framework/versions') {
        await ensureFrameworkSeeded(env);
        const rs = await env.DB.prepare(
          `SELECT id, version, is_active, source, notes, created_by, created_at
           FROM sales_framework ORDER BY version DESC`
        ).all();
        return json({ ok: true, versions: (rs.results || []) });
      }
      if (request.method === 'POST' && path === '/admin/framework') {
        if (!isAdminSession) return json({ error: 'forbidden: admin only' }, 403);
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const content = String(body?.content || '').trim();
        if (!content) return json({ error: 'missing content' }, 400);
        const notes = String(body?.notes || '');
        const source = ['manual', 'synthesis'].includes(body?.source) ? body.source : 'manual';
        await ensureFrameworkSeeded(env);
        const maxRow = await env.DB.prepare('SELECT MAX(version) AS v FROM sales_framework').first();
        const nextV = (maxRow?.v || 0) + 1;
        await env.DB.prepare('UPDATE sales_framework SET is_active = 0 WHERE is_active = 1').run();
        await env.DB.prepare(
          `INSERT INTO sales_framework (version, content, format, is_active, source, notes, created_by, created_at)
           VALUES (?, ?, 'md', 1, ?, ?, ?, ?)`
        ).bind(nextV, content, source, notes, session.user, new Date().toISOString()).run();
        await deriveFrameworkSections(env, nextV, content);
        return json({ ok: true, version: nextV });
      }
      if (request.method === 'POST' && path === '/admin/framework/activate') {
        if (!isAdminSession) return json({ error: 'forbidden: admin only' }, 403);
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const v = parseInt(body?.version, 10);
        if (!v) return json({ error: 'missing version' }, 400);
        const exists = await env.DB.prepare('SELECT 1 FROM sales_framework WHERE version = ?').bind(v).first();
        if (!exists) return json({ error: 'version not found' }, 404);
        await env.DB.prepare('UPDATE sales_framework SET is_active = 0 WHERE is_active = 1').run();
        await env.DB.prepare('UPDATE sales_framework SET is_active = 1 WHERE version = ?').bind(v).run();
        return json({ ok: true, active: v });
      }

      // ===== Fase 2C: mejoras al playbook (síntesis + aprobación humana) =====
      // Listar propuestas (por defecto las pendientes de revisar).
      if (request.method === 'GET' && path === '/admin/framework/improvements') {
        if (!isAdminSession) return json({ error: 'forbidden: admin only' }, 403);
        await ensureImprovementsSchema(env);
        const status = url.searchParams.get('status') || 'pending';
        const rs = status === 'all'
          ? await env.DB.prepare(`SELECT * FROM framework_improvements ORDER BY (status='pending') DESC, created_at DESC LIMIT 50`).all()
          : await env.DB.prepare(`SELECT * FROM framework_improvements WHERE status = ? ORDER BY created_at DESC LIMIT 50`).bind(status).all();
        const pend = await env.DB.prepare(`SELECT COUNT(*) AS n FROM framework_improvements WHERE status='pending'`).first();
        // Última corrida de síntesis (para mostrar "cuándo / cuánto costó").
        let lastRun = null;
        try { lastRun = await env.DB.prepare(`SELECT created_at, cost_usd, created_by FROM copilot_usage WHERE kind='synthesis' ORDER BY created_at DESC LIMIT 1`).first(); } catch (_) {}
        return json({ ok: true, improvements: (rs.results || []), pending_count: pend?.n || 0, last_run: lastRun });
      }
      // Disparar la síntesis a mano (botón "Generar mejoras ahora"). force salta el gate.
      if (request.method === 'POST' && path === '/admin/framework/improvements/generate') {
        if (!isAdminSession) return json({ error: 'forbidden: admin only' }, 403);
        let body = {};
        try { body = await request.json(); } catch (_) {}
        const res = await synthesizeFrameworkImprovements(env, { force: body?.force !== false, createdBy: session.user });
        if (!res.ok) return json({ error: res.error || 'failed', raw: res.raw }, res.error === 'ANTHROPIC_API_KEY no configurada' ? 503 : 500);
        return json(res);
      }
      // Aprobar una propuesta: aplica el cambio (versión nueva del playbook) y la marca approved.
      if (request.method === 'POST' && path === '/admin/framework/improvements/approve') {
        if (!isAdminSession) return json({ error: 'forbidden: admin only' }, 403);
        await ensureImprovementsSchema(env);
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const id = parseInt(body?.id, 10);
        if (!id) return json({ error: 'missing id' }, 400);
        const imp = await env.DB.prepare(`SELECT * FROM framework_improvements WHERE id = ?`).bind(id).first();
        if (!imp) return json({ error: 'propuesta no encontrada' }, 404);
        if (imp.status !== 'pending') return json({ error: 'ya fue revisada (' + imp.status + ')' }, 409);
        const applied = await applyImprovementToFramework(env, imp, session.user, body?.edited_content);
        if (!applied.ok) return json({ error: applied.error }, 400);
        await env.DB.prepare(
          `UPDATE framework_improvements SET status='approved', applied_version=?, reviewed_by=?, reviewed_at=? WHERE id = ?`
        ).bind(applied.version, session.user, new Date().toISOString(), id).run();
        return json({ ok: true, applied_version: applied.version });
      }
      // Rechazar una propuesta (con motivo opcional, que es señal para la próxima síntesis).
      if (request.method === 'POST' && path === '/admin/framework/improvements/reject') {
        if (!isAdminSession) return json({ error: 'forbidden: admin only' }, 403);
        await ensureImprovementsSchema(env);
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const id = parseInt(body?.id, 10);
        if (!id) return json({ error: 'missing id' }, 400);
        const upd = await env.DB.prepare(
          `UPDATE framework_improvements SET status='rejected', reviewed_by=?, reviewed_at=?, review_note=? WHERE id = ? AND status='pending'`
        ).bind(session.user, new Date().toISOString(), String(body?.note || '').slice(0, 1000), id).run();
        if (!upd.meta?.changes) return json({ error: 'propuesta no encontrada o ya revisada' }, 404);
        return json({ ok: true });
      }

      // ----- Feedback de respuestas sugeridas (substrato del bucle de auto-mejora) -----
      // Loguea enviada/editada/ignorada + edit_distance (Levenshtein) + versión del
      // playbook + datos del hilo. El outcome se completa después al cerrar el hilo.
      if (request.method === 'POST' && path === '/admin/suggestion-feedback') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const phone = String(body?.phone || '').replace(/\D/g, '');
        if (!phone) return json({ error: 'missing phone' }, 400);
        const suggested = String(body?.suggested_text || '');
        const finalTxt = String(body?.final_text || '');
        const action = ['sent', 'edited', 'ignored'].includes(body?.action) ? body.action : '';
        const ed = (suggested && finalTxt) ? levenshtein(suggested, finalTxt)
                 : (body?.edit_distance != null ? parseInt(body.edit_distance, 10) : null);
        await env.DB.prepare(
          `INSERT INTO suggestion_feedback
             (phone, suggested_text, final_text, action, edit_distance, confidence, framework_version, vertical, objection, outcome, model_used, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`
        ).bind(
          phone, suggested, finalTxt, action, ed,
          (body?.confidence != null ? +body.confidence : null),
          (body?.framework_version != null ? parseInt(body.framework_version, 10) : null),
          String(body?.vertical || ''), String(body?.objection || ''),
          String(body?.model_used || ''), session.user, new Date().toISOString()
        ).run();
        return json({ ok: true, edit_distance: ed });
      }

      // ----- Copiloto: respuesta sugerida (NO la envía; la muestra para revisar) -----
      if (request.method === 'POST' && path === '/admin/wa/suggest-reply') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const num = String(body?.phone || '').replace(/\D/g, '');
        if (!num) return json({ error: 'missing phone' }, 400);
        const res = await suggestReply(env, num, { dry: !!body?.dry, createdBy: session.user });
        if (!res.ok) return json({ error: res.error || 'failed', raw: res.raw }, res.error === 'ANTHROPIC_API_KEY no configurada' ? 503 : 500);
        return json(res);
      }

      // ----- Copiloto: contador de gasto IA (solo Gaspar) -----
      if (request.method === 'GET' && path === '/admin/copilot/usage') {
        if (!isAdminSession) return json({ error: 'forbidden: admin only' }, 403);
        const ms = new Date(); ms.setUTCDate(1); ms.setUTCHours(0, 0, 0, 0); const m = ms.toISOString();
        const ds = new Date(); ds.setUTCHours(0, 0, 0, 0); const d = ds.toISOString();
        const usage = async (cond, ...b) => await env.DB.prepare(
          `SELECT COUNT(*) AS n, ROUND(SUM(cost_usd), 4) AS cost FROM copilot_usage WHERE kind = 'suggest'${cond}`
        ).bind(...b).first();
        const fb = async (cond, ...b) => {
          const rows = (await env.DB.prepare(
            `SELECT action, COUNT(*) AS n FROM suggestion_feedback${cond} GROUP BY action`
          ).bind(...b).all()).results || [];
          const o = { sent: 0, edited: 0, ignored: 0 };
          rows.forEach(r => { if (o[r.action] != null) o[r.action] = r.n; });
          return o;
        };
        const uD = await usage(' AND created_at >= ?', d);
        const uM = await usage(' AND created_at >= ?', m);
        const uT = await usage('');
        const fM = await fb(' WHERE created_at >= ?', m);
        const fT = await fb('');
        const edT = await env.DB.prepare(`SELECT ROUND(AVG(edit_distance), 1) AS a FROM suggestion_feedback WHERE action = 'edited' AND edit_distance IS NOT NULL`).first();
        return json({
          ok: true,
          today: { count: uD?.n || 0, cost_usd: uD?.cost || 0 },
          month: { count: uM?.n || 0, cost_usd: uM?.cost || 0, generated: uM?.n || 0, sent: fM.sent, edited: fM.edited, ignored: fM.ignored },
          total: { count: uT?.n || 0, cost_usd: uT?.cost || 0, generated: uT?.n || 0, sent: fT.sent, edited: fT.edited, ignored: fT.ignored, avg_edit_distance: edT?.a || 0 }
        });
      }

      // ----- Panel de costos del sitio -----
      if (request.method === 'GET' && path === '/admin/costs') {
        if (!isAdminSession) return json({ error: 'forbidden: admin only' }, 403);
        await ensureCostsSchema(env);
        const services = (await env.DB.prepare('SELECT * FROM site_services WHERE active = 1 ORDER BY sort_order, id').all()).results || [];
        const anth = await computeAnthropicMonthCost(env);
        const rate = await getUsdArsRate(env);
        const ms = new Date(); ms.setUTCDate(1); ms.setUTCHours(0, 0, 0, 0); const m = ms.toISOString();
        let waOut = 0, waConv = 0;
        try { waOut = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM wa_messages WHERE direction='outbound' AND ts >= ?`).bind(m).first())?.n || 0; } catch (_) {}
        try { waConv = (await env.DB.prepare(`SELECT COUNT(DISTINCT phone) AS n FROM wa_messages WHERE direction='outbound' AND ts >= ?`).bind(m).first())?.n || 0; } catch (_) {}
        const toUsd = (amt, cur) => {
          if (!amt) return 0;
          if (cur === 'ARS') return rate ? +(amt / rate).toFixed(2) : null; // null = falta el tipo de cambio
          if (cur === 'EUR') return +(amt * 1.08).toFixed(2);
          return amt; // USD
        };
        let infraUsd = 0, adsUsd = 0, infraIncomplete = false, adsIncomplete = false;
        const enriched = services.map(s => {
          let usd;
          if (s.cost_type === 'auto' && s.auto_key === 'anthropic') usd = anth.total;
          else if (s.cost_type === 'free') usd = 0;
          else usd = toUsd(s.cost_amount, s.cost_currency);
          const row = { ...s, monthly_usd: usd };
          if (s.cost_type === 'auto' && s.auto_key === 'anthropic') row.anthropic = anth;
          if (s.category === 'ads') { if (usd == null) adsIncomplete = true; else adsUsd += usd; }
          else { if (usd == null) infraIncomplete = true; else infraUsd += usd; }
          return row;
        });
        return json({
          ok: true,
          services: enriched,
          anthropic: anth,
          fx_usd_ars: rate,
          totals: { infra_usd: +infraUsd.toFixed(2), ads_usd: +adsUsd.toFixed(2), infra_incomplete: infraIncomplete, ads_incomplete: adsIncomplete },
          usage: { wa_outbound_msgs: waOut, wa_conversations: waConv },
          provider: {
            wa_provider: env.WA_PROVIDER || 'meta',
            has_d360_key: !!env.D360_API_KEY,
            has_wa_token: !!env.WA_TOKEN,
            has_anthropic_key: !!env.ANTHROPIC_API_KEY,
            wa_billing_blocked: await isWaBillingBlocked(env)
          }
        });
      }
      if (request.method === 'POST' && path === '/admin/costs') {
        if (!isAdminSession) return json({ error: 'forbidden: admin only' }, 403);
        await ensureCostsSchema(env);
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const action = body?.action || 'upsert';
        const now = new Date().toISOString();
        if (action === 'resume_wa') {
          // Reanudar manualmente los envíos (tras cargar saldo en 360dialog).
          const was = await clearWaBillingBlock(env);
          return json({ ok: true, was_blocked: was });
        }
        if (action === 'set_rate') {
          const rt = parseFloat(body?.usd_ars);
          if (!isFinite(rt) || rt <= 0) return json({ error: 'tipo de cambio inválido' }, 400);
          await env.DB.prepare(`INSERT INTO kv_cache (k, v, updated_at) VALUES ('usd_ars_rate', ?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at`).bind(String(rt), now).run();
          return json({ ok: true, usd_ars: rt });
        }
        if (action === 'delete') {
          const id = parseInt(body?.id, 10);
          if (!id) return json({ error: 'missing id' }, 400);
          await env.DB.prepare('UPDATE site_services SET active=0, updated_at=? WHERE id=?').bind(now, id).run();
          return json({ ok: true });
        }
        const sv = body?.service || {};
        const f = {
          name: String(sv.name || '').slice(0, 200),
          category: ['ia', 'infra', 'mensajeria', 'almacenamiento', 'ads', 'otro'].includes(sv.category) ? sv.category : 'otro',
          provider: String(sv.provider || '').slice(0, 100),
          usage: String(sv.usage || '').slice(0, 1000),
          credential_location: String(sv.credential_location || '').slice(0, 500),
          cost_type: ['fixed', 'usage', 'free'].includes(sv.cost_type) ? sv.cost_type : 'fixed', // 'auto' no se setea a mano
          cost_amount: (isFinite(parseFloat(sv.cost_amount)) ? parseFloat(sv.cost_amount) : 0),
          cost_currency: ['USD', 'ARS', 'EUR'].includes(sv.cost_currency) ? sv.cost_currency : 'USD',
          billing_url: String(sv.billing_url || '').slice(0, 500),
          notes: String(sv.notes || '').slice(0, 1000),
          sort_order: (isFinite(parseInt(sv.sort_order, 10)) ? parseInt(sv.sort_order, 10) : 100)
        };
        const id = parseInt(sv.id, 10);
        if (id) {
          // Editar: no tocar auto_key (un servicio 'auto' sigue siendo auto). Solo
          // actualiza cost_type si el original NO era auto.
          const orig = await env.DB.prepare('SELECT cost_type, auto_key FROM site_services WHERE id=?').bind(id).first();
          const keepAuto = orig && orig.cost_type === 'auto';
          await env.DB.prepare(
            `UPDATE site_services SET name=?, category=?, provider=?, usage=?, credential_location=?, cost_type=?, cost_amount=?, cost_currency=?, billing_url=?, notes=?, sort_order=?, updated_at=? WHERE id=?`
          ).bind(f.name, f.category, f.provider, f.usage, f.credential_location, keepAuto ? 'auto' : f.cost_type, f.cost_amount, f.cost_currency, f.billing_url, f.notes, f.sort_order, now, id).run();
          return json({ ok: true, id });
        }
        if (!f.name) return json({ error: 'falta el nombre del servicio' }, 400);
        const res = await env.DB.prepare(
          `INSERT INTO site_services (sort_order, name, category, provider, usage, credential_location, cost_type, cost_amount, cost_currency, auto_key, billing_url, notes, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, 1, ?, ?)`
        ).bind(f.sort_order, f.name, f.category, f.provider, f.usage, f.credential_location, f.cost_type, f.cost_amount, f.cost_currency, f.billing_url, f.notes, now, now).run();
        return json({ ok: true, id: res.meta?.last_row_id });
      }

      if (request.method === 'POST' && path === '/admin/wa/send') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { to, body: text, reply_to } = body || {};
        if (!to || !text) return json({ error: 'missing fields (to, body)' }, 400);
        const num = normalizeArPhone(to);
        // Rol 'cursos' (Abril) solo puede escribir a chats de su bandeja.
        {
          const _role = await getSessionRole(env, session.user);
          if (!(await inboxAccessOk(env, _role, num || String(to).replace(/\D/g, '')))) {
            return json({ error: 'forbidden: chat fuera de tu bandeja' }, 403);
          }
        }
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

      // (Endpoint /admin/wa/phone-info v1 removido — la versión que ramifica por
      //  provider y unifica con phone-status vive más abajo en este mismo archivo.)

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
      // ===== Ad Attribution: contexto del ad que originó el primer contacto =====
      // GET /admin/wa/ad-attribution?phone=549XXXXXXXXXX → último ad referral
      // POST /admin/wa/ad-attributions/list → lista resumida agregada por source_id
      if (request.method === 'GET' && path === '/admin/wa/ad-attribution') {
        const phone = url.searchParams.get('phone') || '';
        if (!phone) return json({ error: 'missing phone' }, 400);
        try {
          const row = await env.DB.prepare(
            'SELECT * FROM wa_ad_attributions WHERE phone = ? ORDER BY ts DESC LIMIT 1'
          ).bind(phone).first();
          return json({ attribution: row || null });
        } catch (e) {
          return json({ attribution: null, error: e.message });
        }
      }
      if (request.method === 'GET' && path === '/admin/wa/ad-attributions/summary') {
        // Para dashboard futuro: agregado por source_id con counts.
        try {
          const rs = await env.DB.prepare(`
            SELECT source_id, source_type, headline,
                   COUNT(*) AS leads,
                   COUNT(DISTINCT phone) AS unique_contacts,
                   MIN(ts) AS first_lead_ts,
                   MAX(ts) AS last_lead_ts
            FROM wa_ad_attributions
            GROUP BY source_id
            ORDER BY last_lead_ts DESC
          `).all();
          return json({ ads: rs.results || [] });
        } catch (e) {
          return json({ ads: [], error: e.message });
        }
      }

      // Reemplaza el patrón anterior de pedir limit=5000 mensajes para armar la
      // lista de chats. Devuelve 1 fila por phone con: last_ts, last_body,
      // last_direction, last_msg_type, contact_name (último sender_name inbound
      // no vacío), unread (count inbound > last_read_ts).
      // Mucho más liviano y escala con la cantidad de chats, no de mensajes.
      if (request.method === 'GET' && path === '/admin/wa/chats-summary') {
        // === Lista de chats: lee de la libreta resumen wa_chats_summary ===
        // La libreta tiene 1 fila por chat (último msg + no leídos + nombre),
        // mantenida al día por el trigger trg_wa_chats_summary_ins. Leerla es
        // ~unas cientos de filas (vs ~440k de la query vieja con ROW_NUMBER).
        // RED DE SEGURIDAD: si la libreta está vacía (no migrada) o falla, se
        // usa la query vieja (CHATS_SUMMARY_FALLBACK_SQL) — así nunca se rompe.
        // Cache corto (5s) en Workers Cache API; mark-read invalida la cache.
        // Rol del usuario → qué bandeja ve. Cache POR ROL (cada rol ve una
        // lista distinta: Abril solo 'cursos', Joaco todo menos 'cursos',
        // Gaspar todo). Sin esto, el cache mezclaría las listas entre usuarios.
        const role = await getSessionRole(env, session.user);
        const cache = caches.default;
        const cacheUrl = new URL(request.url);
        cacheUrl.search = '?role=' + encodeURIComponent(role); // separa el cache por rol
        const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
        const cached = await cache.match(cacheKey);
        if (cached) return cached;
        const inboxClause = inboxClauseForRole(role);
        let chats = null;
        try {
          const rs = await env.DB.prepare(
            `SELECT phone, last_ts, last_body, last_direction, last_msg_type, contact_name, unread, inbox
             FROM wa_chats_summary
             WHERE last_ts != '' ${inboxClause}
             ORDER BY last_ts DESC`
          ).all();
          chats = rs.results || [];
          // Si la libreta está vacía (ej. base sin migrar), caer al fallback.
          if (!chats.length) chats = null;
        } catch (e) { chats = null; }
        // Fallback a la query vieja (red de seguridad). No tiene info de bandeja:
        // para 'cursos' devolvemos vacío (no puede saber cuáles son suyos sin la
        // libreta); admin/comercial reciben la lista completa como degradación.
        if (chats === null) {
          if (role === 'cursos') {
            chats = [];
          } else {
            try {
              const fb = await env.DB.prepare(CHATS_SUMMARY_FALLBACK_SQL).all();
              chats = fb.results || [];
            } catch (e) {
              return json({ chats: [], error: e.message }, 500);
            }
          }
        }
        const response = json({ chats });
        response.headers.set('Cache-Control', 'public, max-age=5');
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }

      // Análisis individual de un chat con Claude. model=sonnet|opus.
      // GET para que sea fácil disparar desde browser/curl, idempotente por phone
      // (cada llamada UPDATE el snapshot vigente + INSERT histórico).
      if (request.method === 'POST' && path === '/admin/wa/analyze-chat') {
        let payload;
        try { payload = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { phone, model } = payload || {};
        if (!phone) return json({ error: 'missing phone' }, 400);
        const res = await analyzeChatWithClaude(env, phone, model === 'opus' ? 'opus' : 'sonnet');
        return json(res, res.ok ? 200 : 500);
      }

      // Batch análisis para cron diario. Toma N chats que tengan actividad
      // posterior al last_analyzed_at (o que nunca se analizaron) y los corre.
      // Limit default 10 por llamada (~30 seg). Se puede llamar varias veces
      // para procesar más. Excluye phones internos del equipo (Joaco, Gaspar, Bruno)
      // listados en wa_internal_phones para no analizar chats internos como si
      // fueran clientes (los msgs de Joaco en su número del negocio NO son
      // conversaciones de venta).
      if (request.method === 'POST' && path === '/admin/wa/analyze-pending') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '10'), 50);
        const minMsgs = parseInt(url.searchParams.get('min_msgs') || '3'); // chats con menos de 3 msgs los skipeamos por default
        const stats = { processed: 0, succeeded: 0, failed: 0, total_cost_usd: 0, results: [] };
        try {
          // Estrategia: phones que tienen msgs nuevos desde el último análisis.
          // Subquery saca last_msg_ts por phone, y comparamos contra last_analyzed_at
          // de wa_conversations. Si nunca se analizó o si hay msgs nuevos, entra.
          // EXCLUDE: phones en wa_internal_phones (equipo, no clientes).
          const rs = await env.DB.prepare(
            `WITH chat_stats AS (
               SELECT phone, MAX(ts) AS last_ts, COUNT(*) AS n_msgs
               FROM wa_messages WHERE msg_type != 'reaction'
                 AND phone NOT IN (SELECT phone FROM wa_internal_phones)
               GROUP BY phone
               HAVING n_msgs >= ?
             )
             SELECT cs.phone FROM chat_stats cs
             LEFT JOIN wa_conversations c ON c.phone = cs.phone
             WHERE c.last_analyzed_at IS NULL OR c.last_analyzed_at < cs.last_ts
                OR c.analysis_version < ?
             ORDER BY cs.last_ts DESC
             LIMIT ?`
          ).bind(minMsgs, ANALYSIS_PROMPT_VERSION, limit).all();
          const phones = (rs.results || []).map(r => r.phone);
          // Ejecutamos los N análisis EN PARALELO con Promise.all. Cada análisis
          // es ~3 seg I/O bound (espera respuesta de Anthropic), así que con
          // limit=15 el wall time queda ~5-8 seg en vez de 45-60 seg en serie.
          // Workers tiene CPU time limit (30s free/5min paid) pero el await fetch
          // no consume CPU, así que esto es safe.
          const results = await Promise.all(phones.map(async (phone) => {
            try {
              const r = await analyzeChatWithClaude(env, phone, 'sonnet');
              return { phone, ok: r.ok, cost: r.cost_usd || 0, error: r.error };
            } catch (e) {
              return { phone, ok: false, error: e.message };
            }
          }));
          for (const r of results) {
            stats.processed++;
            if (r.ok) {
              stats.succeeded++;
              stats.total_cost_usd += r.cost || 0;
            } else {
              stats.failed++;
            }
            stats.results.push({ phone: r.phone, ok: r.ok, error: r.error });
          }
          return json({ ok: true, stats });
        } catch (e) {
          return json({ error: e.message, stats }, 500);
        }
      }

      // Agregados pre-calculados para el dashboard de insights IA.
      // Devuelve resumen, distribución por ad, por vertical, top objeciones,
      // top "qué funcionó" y costo total acumulado del análisis.
      // Filtro opcional ?product_type=cartel_personalizado|curso|... para
      // segmentar por vertical (los ciclos de venta son completamente distintos).
      if (request.method === 'GET' && path === '/admin/wa/insights') {
        try {
          const productFilter = url.searchParams.get('product_type') || '';
          const where = productFilter
            ? `WHERE outcome != '' AND product_type = '${productFilter.replace(/'/g, "''")}'`
            : `WHERE outcome != ''`;
          const whereLabels = productFilter
            ? `WHERE product_type = '${productFilter.replace(/'/g, "''")}'`
            : ``;
          const results = { filter: productFilter };
          // Resumen general — outcomes y costo
          const summary = await env.DB.prepare(
            `SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN outcome = 'sold' THEN 1 ELSE 0 END) AS sold,
              SUM(CASE WHEN outcome = 'lost' THEN 1 ELSE 0 END) AS lost,
              SUM(CASE WHEN outcome = 'abandoned_by_client' THEN 1 ELSE 0 END) AS abandoned,
              SUM(CASE WHEN outcome = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
              SUM(CASE WHEN outcome = 'spam' THEN 1 ELSE 0 END) AS spam
            FROM wa_conversations ${where}`
          ).first();
          results.summary = summary || {};
          const costRow = await env.DB.prepare(
            `SELECT ROUND(SUM(cost_usd_estimated), 2) AS total_cost FROM wa_chat_analyses WHERE error = ''`
          ).first();
          results.total_cost_usd = costRow?.total_cost || 0;
          // Por ad — solo ads que tengan al menos 1 análisis. Aplica filtro de producto si está activo.
          const adWhere = productFilter
            ? `WHERE ad_name != '' AND product_type = '${productFilter.replace(/'/g, "''")}'`
            : `WHERE ad_name != ''`;
          results.by_ad = (await env.DB.prepare(
            `SELECT ad_name, campaign_name,
              COUNT(*) AS total,
              SUM(CASE WHEN outcome = 'sold' THEN 1 ELSE 0 END) AS sold,
              SUM(CASE WHEN outcome = 'lost' THEN 1 ELSE 0 END) AS lost,
              SUM(CASE WHEN outcome = 'abandoned_by_client' THEN 1 ELSE 0 END) AS abandoned,
              SUM(CASE WHEN outcome = 'in_progress' THEN 1 ELSE 0 END) AS in_progress
            FROM wa_conversations
            ${adWhere}
            GROUP BY ad_name, campaign_name
            ORDER BY total DESC LIMIT 30`
          ).all()).results || [];
          // Por vertical (vertical del CLIENTE: particular/local/franquicia/etc — distinto a product_type)
          const vertWhere = productFilter
            ? `WHERE vertical != '' AND product_type = '${productFilter.replace(/'/g, "''")}'`
            : `WHERE vertical != ''`;
          results.by_vertical = (await env.DB.prepare(
            `SELECT vertical,
              COUNT(*) AS total,
              SUM(CASE WHEN outcome = 'sold' THEN 1 ELSE 0 END) AS sold,
              SUM(CASE WHEN outcome = 'lost' THEN 1 ELSE 0 END) AS lost,
              SUM(CASE WHEN outcome = 'abandoned_by_client' THEN 1 ELSE 0 END) AS abandoned,
              SUM(CASE WHEN outcome = 'in_progress' THEN 1 ELSE 0 END) AS in_progress
            FROM wa_conversations
            ${vertWhere}
            GROUP BY vertical
            ORDER BY total DESC`
          ).all()).results || [];
          // Por product type
          results.by_product = (await env.DB.prepare(
            `SELECT product_type,
              COUNT(*) AS total,
              SUM(CASE WHEN outcome = 'sold' THEN 1 ELSE 0 END) AS sold
            FROM wa_conversations
            WHERE product_type != ''
            GROUP BY product_type
            ORDER BY total DESC`
          ).all()).results || [];
          // Sentiment
          results.by_sentiment = (await env.DB.prepare(
            `SELECT sentiment_final, COUNT(*) AS n FROM wa_conversations
             WHERE sentiment_final != '' GROUP BY sentiment_final ORDER BY n DESC`
          ).all()).results || [];
          // Top objeciones (parseamos los JSON arrays a flat list)
          const objWhere = productFilter
            ? `WHERE objections != '' AND objections != '[]' AND product_type = '${productFilter.replace(/'/g, "''")}'`
            : `WHERE objections != '' AND objections != '[]'`;
          const objRows = (await env.DB.prepare(
            `SELECT objections FROM wa_conversations ${objWhere}`
          ).all()).results || [];
          const objCounts = {};
          for (const r of objRows) {
            try {
              const arr = JSON.parse(r.objections);
              if (Array.isArray(arr)) for (const o of arr) {
                const key = String(o).trim().toLowerCase();
                if (key) objCounts[key] = (objCounts[key] || 0) + 1;
              }
            } catch (_) {}
          }
          results.top_objections = Object.entries(objCounts)
            .sort((a, b) => b[1] - a[1]).slice(0, 20)
            .map(([k, v]) => ({ objection: k, count: v }));
          // Top intent signals (mismo filtro de producto)
          const intWhere = productFilter
            ? `WHERE intent_signals != '' AND intent_signals != '[]' AND product_type = '${productFilter.replace(/'/g, "''")}'`
            : `WHERE intent_signals != '' AND intent_signals != '[]'`;
          const intRows = (await env.DB.prepare(
            `SELECT intent_signals FROM wa_conversations ${intWhere}`
          ).all()).results || [];
          const intCounts = {};
          for (const r of intRows) {
            try {
              const arr = JSON.parse(r.intent_signals);
              if (Array.isArray(arr)) for (const o of arr) {
                const key = String(o).trim().toLowerCase();
                if (key) intCounts[key] = (intCounts[key] || 0) + 1;
              }
            } catch (_) {}
          }
          results.top_intents = Object.entries(intCounts)
            .sort((a, b) => b[1] - a[1]).slice(0, 20)
            .map(([k, v]) => ({ intent: k, count: v }));
          // Costos por modelo
          results.by_model = (await env.DB.prepare(
            `SELECT model_used, COUNT(*) AS calls, ROUND(SUM(cost_usd_estimated), 2) AS cost
             FROM wa_chat_analyses WHERE error = ''
             GROUP BY model_used ORDER BY cost DESC`
          ).all()).results || [];
          return json(results);
        } catch (e) {
          return json({ error: e.message }, 500);
        }
      }

      // Listado/resumen de conversaciones ya analizadas. Filtros básicos para
      // explorar insights desde el dashboard sin tener que hacer SQL.
      if (request.method === 'GET' && path === '/admin/wa/conversations') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500);
        const outcome = url.searchParams.get('outcome') || '';
        const productType = url.searchParams.get('product_type') || '';
        const adName = url.searchParams.get('ad_name') || '';
        let sql = `SELECT phone, first_msg_ts, last_msg_ts, total_msgs, ad_name, campaign_name,
                          outcome, outcome_reason, product_type, product_details, vertical,
                          sentiment_final, confidence, last_analyzed_at, last_model_used
                   FROM wa_conversations WHERE 1=1`;
        const params = [];
        if (outcome) { sql += ' AND outcome = ?'; params.push(outcome); }
        if (productType) { sql += ' AND product_type = ?'; params.push(productType); }
        if (adName) { sql += ' AND ad_name = ?'; params.push(adName); }
        sql += ' ORDER BY last_msg_ts DESC LIMIT ?';
        params.push(limit);
        try {
          const rs = await env.DB.prepare(sql).bind(...params).all();
          return json({ conversations: rs.results || [] });
        } catch (e) {
          return json({ conversations: [], error: e.message }, 500);
        }
      }

      // Backfill de transcripción de audios históricos. Toma N audios con media
      // en R2 pero sin transcripción (body vacío o solo placeholder '[audio]')
      // y los procesa via Workers AI whisper-large-v3-turbo. Workers tiene
      // límite de ~30s por request, por eso default limit=15 (cada audio tarda
      // 1-3 seg). Idempotente: si se vuelve a llamar, sigue donde dejó.
      if (request.method === 'POST' && path === '/admin/wa/transcribe-backfill') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '15'), 50);
        const stats = { processed: 0, transcribed: 0, failed: 0, no_media: 0 };
        try {
          const rs = await env.DB.prepare(
            `SELECT id, media_url FROM wa_messages
             WHERE msg_type='audio'
               AND media_url LIKE 'wa/%'
               AND (body = '' OR body = '[audio]' OR body IS NULL OR length(body) < 10)
             ORDER BY ts DESC
             LIMIT ?`
          ).bind(limit).all();
          const rows = rs.results || [];
          for (const r of rows) {
            stats.processed++;
            try {
              const transcript = await transcribeAudio(env, r.media_url);
              if (transcript && transcript.trim().length > 0) {
                await env.DB.prepare('UPDATE wa_messages SET body = ? WHERE id = ?').bind(
                  '[audio] ' + transcript, r.id
                ).run();
                stats.transcribed++;
              } else {
                stats.no_media++;
              }
            } catch (e) {
              stats.failed++;
            }
          }
          // Cuántos quedan pendientes para que el caller decida si seguir.
          const remaining = await env.DB.prepare(
            `SELECT COUNT(*) AS n FROM wa_messages
             WHERE msg_type='audio' AND media_url LIKE 'wa/%'
             AND (body = '' OR body = '[audio]' OR body IS NULL OR length(body) < 10)`
          ).first();
          return json({ ok: true, stats, remaining: remaining?.n || 0 });
        } catch (e) {
          return json({ error: e.message, stats }, 500);
        }
      }

      // Listado de leads procesados desde Meta Lead Ads + status del template.
      // Útil para monitorear el flujo en tiempo real y debug.
      if (request.method === 'GET' && path === '/admin/wa/leads') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500);
        const status = url.searchParams.get('status') || ''; // pending|sent|failed|skipped
        let sql = 'SELECT id, leadgen_id, ts, received_at, page_id, form_id, ad_id, phone, first_name, full_name, email, vertical, template_status, template_sent_at, template_error, wamid, process_error FROM wa_leads';
        const params = [];
        if (status) { sql += ' WHERE template_status = ?'; params.push(status); }
        sql += ' ORDER BY ts DESC LIMIT ?';
        params.push(limit);
        try {
          const rs = await env.DB.prepare(sql).bind(...params).all();
          return json({ leads: rs.results || [] });
        } catch (e) {
          return json({ leads: [], error: e.message }, 500);
        }
      }

      // Reintentar enviar template para un lead que falló. Útil cuando el template
      // estaba pendiente de aprobación al momento del lead, o falló la API.
      if (request.method === 'POST' && path.startsWith('/admin/wa/leads/') && path.endsWith('/retry')) {
        const leadgenId = path.slice('/admin/wa/leads/'.length, -('/retry'.length));
        try {
          const row = await env.DB.prepare('SELECT * FROM wa_leads WHERE leadgen_id = ?').bind(leadgenId).first();
          if (!row) return json({ error: 'lead not found' }, 404);
          if (!row.phone) return json({ error: 'lead has no valid phone' }, 400);
          const tplResult = await waSendTemplate(env, row.phone, 'lead_b2b_followup', 'es_AR', [
            row.first_name || 'amigo/a'
          ]);
          if (tplResult?.ok) {
            const wamid = tplResult.id || '';
            await env.DB.prepare(
              'UPDATE wa_leads SET template_status = ?, template_sent_at = ?, wamid = ?, template_error = ? WHERE leadgen_id = ?'
            ).bind('sent', new Date().toISOString(), wamid, '', leadgenId).run();
            return json({ ok: true, wamid });
          } else {
            await env.DB.prepare(
              'UPDATE wa_leads SET template_status = ?, template_error = ? WHERE leadgen_id = ?'
            ).bind('failed', JSON.stringify(tplResult).slice(0, 500), leadgenId).run();
            return json({ ok: false, error: tplResult }, 500);
          }
        } catch (e) {
          return json({ error: e.message }, 500);
        }
      }

      // Diagnóstico: log de mensajes inbound que Meta marca como unsupported.
      // Captura el JSON crudo + error.title/code/details para entender por qué
      // tantos mensajes llegan sin contenido (sospecha: msgs eliminados rápido).
      if (request.method === 'GET' && path === '/admin/wa/debug-unavailable') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
        try {
          const rs = await env.DB.prepare(
            'SELECT id, ts, inserted_at, wamid, phone, sender_name, error_code, error_title, error_details, msg_type, classified_as, raw_payload FROM wa_webhook_debug ORDER BY ts DESC LIMIT ?'
          ).bind(limit).all();
          return json({ rows: rs.results || [] });
        } catch (e) {
          return json({ rows: [], error: e.message }, 500);
        }
      }

      // Consultar mensajes de WhatsApp guardados (para análisis)
      if (request.method === 'GET' && path === '/admin/wa/messages') {
        const phone = url.searchParams.get('phone') || '';
        const _role = await getSessionRole(env, session.user);
        const from = url.searchParams.get('from') || '';
        const to = url.searchParams.get('to') || '';
        const dir = url.searchParams.get('direction') || '';
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '500'), 5000);
        let where = '1=1';
        const params = [];
        if (phone) {
          // Consulta de un chat puntual. Rol 'cursos' solo accede a su bandeja.
          if (_role === 'cursos' && !(await inboxAccessOk(env, _role, phone.replace(/\D/g, '')))) {
            return json({ error: 'forbidden: chat fuera de tu bandeja', messages: [] }, 403);
          }
          where += ' AND phone = ?'; params.push(phone);
        } else {
          // Consulta global (polling de inbound, follow-ups, etc.): filtramos por
          // bandeja según rol para que Joaco NUNCA reciba ni procese nada de
          // cursos (ni notificaciones en segundo plano), y Abril solo lo suyo.
          //   admin    → sin filtro
          //   cursos   → solo chats de la bandeja cursos
          //   comercial→ todo MENOS cursos
          if (_role === 'cursos') {
            where += " AND phone IN (SELECT phone FROM wa_chats_summary WHERE inbox = 'cursos')";
          } else if (_role === 'admin') {
            where += " AND phone NOT IN (SELECT phone FROM wa_chats_summary WHERE inbox = 'oculto')";
          } else {
            where += " AND phone NOT IN (SELECT phone FROM wa_chats_summary WHERE inbox IN ('cursos','oculto'))";
          }
        }
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

      // Preview de los leads del Sheet de cursos (solo admin). No manda nada;
      // devuelve conteos + muestra para revisar antes del envío masivo.
      if (request.method === 'GET' && path === '/admin/wa/cursos-leads') {
        const role = await getSessionRole(env, session.user);
        if (role !== 'admin') return json({ error: 'forbidden' }, 403);
        let data;
        try { data = await fetchCursosLeads(env); }
        catch (e) { return json({ error: 'no pude leer el sheet: ' + e.message }, 502); }
        const validos = data.leads.filter(l => l.valido);
        const invalidos = data.leads.filter(l => !l.valido);
        // Cuántos ya recibieron el broadcast (dedup).
        let yaEnviados = 0;
        try {
          const phones = validos.map(l => l.tel);
          if (phones.length) {
            // chunk para no pasar 999 binds
            for (let i = 0; i < phones.length; i += 400) {
              const chunk = phones.slice(i, i + 400);
              const ph = chunk.map(() => '?').join(',');
              const r2 = await env.DB.prepare(`SELECT COUNT(*) AS n FROM wa_autoreply_log WHERE kind='cursos_broadcast' AND status='sent' AND phone IN (${ph})`).bind(...chunk).first();
              yaEnviados += (r2?.n || 0);
            }
          }
        } catch (_) {}
        return json({
          total_filas: data.total,
          validos: validos.length,
          invalidos: invalidos.length,
          ya_enviados: yaEnviados,
          pendientes: validos.length - yaEnviados,
          muestra: data.leads.slice(0, 8),
          invalidos_muestra: invalidos.slice(0, 5)
        });
      }

      // Programar goteo del broadcast — encola N leads en la cola con due_at
      // distribuido entre startTs y endTs. El cron processCursosBroadcastQueue
      // los procesa cuando vencen. NO manda nada al toque.
      // Body: { count, startTs (ISO), endTs (ISO), dryRun? }
      // Excluye automáticamente: ya enviados (cursos_broadcast 'sent'),
      // unreachable phones, y leads sin tel válido.
      if (request.method === 'POST' && path === '/admin/wa/cursos-broadcast-schedule') {
        const role = await getSessionRole(env, session.user);
        if (role !== 'admin') return json({ error: 'forbidden' }, 403);
        let body; try { body = await request.json(); } catch { body = {}; }
        const count = Math.min(Math.max(parseInt(body?.count || '0', 10) || 0, 1), 500);
        const startTs = body?.startTs ? new Date(body.startTs) : new Date();
        const endTs = body?.endTs ? new Date(body.endTs) : new Date(Date.now() + 4 * 60 * 60 * 1000);
        const dryRun = !!body?.dryRun;
        if (isNaN(startTs.getTime()) || isNaN(endTs.getTime()) || endTs <= startTs) {
          return json({ error: 'startTs/endTs inválidos' }, 400);
        }
        let data;
        try { data = await fetchCursosLeads(env); } catch (e) { return json({ error: 'no pude leer el sheet: ' + e.message }, 502); }
        const validos = data.leads.filter(l => l.valido);
        // Excluir ya enviados, en cola y unreachable.
        const yaSet = new Set();
        try {
          const rs = await env.DB.prepare("SELECT phone FROM wa_autoreply_log WHERE kind = 'cursos_broadcast'").all();
          for (const r of (rs.results || [])) yaSet.add(r.phone);
        } catch (_) {}
        const unreachSet = new Set();
        try {
          const rs = await env.DB.prepare("SELECT phone FROM wa_unreachable_phones").all();
          for (const r of (rs.results || [])) unreachSet.add(r.phone);
        } catch (_) {}
        const pendientes = validos.filter(l => !yaSet.has(l.tel) && !unreachSet.has(l.tel)).slice(0, count);
        if (!pendientes.length) return json({ scheduled: 0, available: validos.length - yaSet.size, reason: 'no quedan leads pendientes' });
        // Distribuir due_at uniformemente entre startTs y endTs.
        const totalMs = endTs.getTime() - startTs.getTime();
        const step = pendientes.length > 1 ? totalMs / (pendientes.length - 1) : 0;
        const planned = pendientes.map((l, i) => ({
          tel: l.tel,
          nombre: l.nombre || '',
          due_at: new Date(startTs.getTime() + Math.round(i * step)).toISOString()
        }));
        if (dryRun) {
          return json({
            dryRun: true,
            scheduled: planned.length,
            window: { startTs: startTs.toISOString(), endTs: endTs.toISOString(), step_seconds: Math.round(step / 1000) },
            primeros: planned.slice(0, 5),
            ultimos: planned.slice(-5)
          });
        }
        // Insertar en wa_autoreply_log con kind='cursos_broadcast' y status='queued'.
        let scheduled = 0;
        const nowIso = new Date().toISOString();
        for (const p of planned) {
          try {
            const r = await env.DB.prepare(
              "INSERT OR IGNORE INTO wa_autoreply_log (phone, kind, sent_at, status, due_at, sender_name) VALUES (?, 'cursos_broadcast', '', 'queued', ?, ?)"
            ).bind(p.tel, p.due_at, p.nombre).run();
            if (r?.meta?.changes) scheduled++;
          } catch (_) {}
        }
        return json({
          ok: true,
          scheduled,
          requested: planned.length,
          window: { startTs: startTs.toISOString(), endTs: endTs.toISOString(), step_seconds: Math.round(step / 1000) },
          primeros: planned.slice(0, 3),
          ultimos: planned.slice(-3),
          nota: 'El cron procesa cada minuto. El primer envío sale aprox a las ' + startTs.toISOString() + '.'
        });
      }

      // Envío masivo de la plantilla de cursos a los leads del Sheet (solo admin).
      // Body: { limit?: number (default 10, máx 200), dryRun?: bool }.
      // Manda la plantilla cursos_clases_vivo_mayo con {{1}}=primer nombre, guarda
      // el outbound en el CRM y deriva cada chat a la bandeja de Abril. Dedup
      // atómico por wa_autoreply_log kind='cursos_broadcast' (no manda 2 veces).
      if (request.method === 'POST' && path === '/admin/wa/cursos-broadcast') {
        const role = await getSessionRole(env, session.user);
        if (role !== 'admin') return json({ error: 'forbidden' }, 403);
        let body; try { body = await request.json(); } catch { body = {}; }
        const limit = Math.min(Math.max(parseInt(body?.limit || '10', 10) || 10, 1), 200);
        const dryRun = !!body?.dryRun;
        let data;
        try { data = await fetchCursosLeads(env); } catch (e) { return json({ error: 'no pude leer el sheet: ' + e.message }, 502); }
        const validos = data.leads.filter(l => l.valido);
        // Excluir los que ya recibieron (status sent o en curso).
        const yaSet = new Set();
        try {
          const rs = await env.DB.prepare("SELECT phone FROM wa_autoreply_log WHERE kind = 'cursos_broadcast'").all();
          for (const r of (rs.results || [])) yaSet.add(r.phone);
        } catch (_) {}
        const pendientes = validos.filter(l => !yaSet.has(l.tel)).slice(0, limit);
        if (dryRun) {
          return json({ dryRun: true, a_enviar: pendientes.length, muestra: pendientes.map(l => ({ nombre: l.nombre, tel: l.tel })) });
        }
        const result = { enviados: 0, fallidos: 0, errores: [] };
        // id de la etiqueta 'form 6 y 7 de mayo' (para distinguir la campaña).
        let formLabelId = 24;
        try { const lr = await env.DB.prepare("SELECT id FROM labels WHERE name = 'form 6 y 7 de mayo'").first(); if (lr?.id) formLabelId = lr.id; } catch (_) {}
        for (const lead of pendientes) {
          // Reserva atómica (evita doble envío).
          let reserva;
          try {
            reserva = await env.DB.prepare(
              "INSERT OR IGNORE INTO wa_autoreply_log (phone, kind, sent_at, status, due_at, sender_name) VALUES (?, 'cursos_broadcast', '', 'sending', ?, ?)"
            ).bind(lead.tel, new Date().toISOString(), lead.nombre || '').run();
          } catch (_) { continue; }
          if (!reserva?.meta?.changes) continue; // ya reservado
          const primerNombre = capitalizeName((lead.nombre || '').split(/\s+/)[0]) || 'amigo/a';
          const tpl = await waSendTemplate(env, lead.tel, 'cursos_clases_vivo_mayo', 'es_AR', [primerNombre]);
          if (tpl?.ok) {
            result.enviados++;
            const wamid = tpl.id || '';
            const ts = new Date().toISOString();
            try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'sent', sent_at = ? WHERE phone = ? AND kind = 'cursos_broadcast'").bind(ts, lead.tel).run(); } catch (_) {}
            const previewBody = `holaa ${primerNombre}! Cómo andás?\nSoy Abril, de Neon Infinito. Me dijeron los chicos que participaste de las clases en vivo que hicieron el 6 y 7 de mayo, puede ser?`;
            if (wamid) {
              try {
                await env.DB.prepare(
                  `INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id)
                   VALUES (?, ?, 'outbound', ?, '', 'template', ?, 'sent', '')
                   ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'template'
                     WHERE wa_messages.body IS NULL OR wa_messages.body = '' OR wa_messages.msg_type = 'status'`
                ).bind(ts, wamid, lead.tel, previewBody).run();
              } catch (_) {}
            }
            // OCULTAR del front (inbox='oculto') hasta que el cliente responda.
            try {
              await env.DB.prepare("INSERT INTO wa_chats_summary (phone, inbox, updated_at) VALUES (?, 'oculto', ?) ON CONFLICT(phone) DO UPDATE SET inbox = 'oculto'").bind(lead.tel, ts).run();
            } catch (_) {}
            // Registrar en la campaña (estado: enviado template 1, esperando respuesta).
            try {
              await env.DB.prepare("INSERT INTO wa_cursos_campaign (phone, nombre, sent_1_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(phone) DO UPDATE SET sent_1_at = excluded.sent_1_at, updated_at = excluded.updated_at").bind(lead.tel, lead.nombre || '', ts, ts).run();
            } catch (_) {}
            // Etiquetar con 'form 6 y 7 de mayo'.
            try { await env.DB.prepare("INSERT OR IGNORE INTO contact_labels (phone, label_id, created_at) VALUES (?, ?, ?)").bind(lead.tel, formLabelId, ts).run(); } catch (_) {}
          } else {
            result.fallidos++;
            if (result.errores.length < 8) result.errores.push({ tel: lead.tel, err: String(tpl?.error || JSON.stringify(tpl || {})).slice(0, 140) });
            // Liberar reserva para permitir reintento.
            try { await env.DB.prepare("DELETE FROM wa_autoreply_log WHERE phone = ? AND kind = 'cursos_broadcast'").bind(lead.tel).run(); } catch (_) {}
          }
        }
        return json(result);
      }

      // Derivar un chat a una bandeja (solo admin). inbox: 'cursos' | 'general'.
      // Marca el chat como de la bandeja Cursos (lo ve Abril, se oculta de Joaco)
      // o lo devuelve a la bandeja general.
      if (request.method === 'POST' && path === '/admin/wa/chat-inbox') {
        const role = await getSessionRole(env, session.user);
        // Admin y comercial (Joaco): mueven chats en cualquier dirección.
        // Cursos (Abril): SOLO puede SACAR de su bandeja (cursos → general) un
        // chat mal derivado; no puede meter chats (no ve los de general).
        if (role !== 'admin' && role !== 'comercial' && role !== 'cursos') return json({ error: 'forbidden' }, 403);
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const phone = String(body?.phone || '').replace(/\D/g, '');
        const inbox = body?.inbox;
        if (!phone || !['cursos', 'general'].includes(inbox)) {
          return json({ error: 'phone (dígitos) e inbox (cursos|general) requeridos' }, 400);
        }
        if (role === 'cursos') {
          if (inbox !== 'general') return json({ error: 'forbidden: solo podés sacar chats de Cursos' }, 403);
          if (!(await inboxAccessOk(env, 'cursos', phone))) return json({ error: 'forbidden: ese chat no está en tu bandeja' }, 403);
        }
        // Upsert: el chat ya suele existir en la libreta (tiene mensajes). Si no,
        // lo creamos con la bandeja seteada (aparecerá cuando tenga mensajes).
        await env.DB.prepare(
          `INSERT INTO wa_chats_summary (phone, inbox, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(phone) DO UPDATE SET inbox = excluded.inbox`
        ).bind(phone, inbox, new Date().toISOString()).run();
        ctx.waitUntil(invalidateChatsSummaryCache(request));
        return json({ ok: true, phone, inbox });
      }

      // Bulk: derivar varios chats a una bandeja de una (solo admin).
      if (request.method === 'POST' && path === '/admin/wa/chat-inbox-bulk') {
        const role = await getSessionRole(env, session.user);
        if (role !== 'admin') return json({ error: 'forbidden' }, 403);
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const inbox = body?.inbox;
        const phones = Array.isArray(body?.phones) ? body.phones : [];
        if (!['cursos', 'general'].includes(inbox) || !phones.length) {
          return json({ error: 'inbox (cursos|general) y phones[] requeridos' }, 400);
        }
        const now = new Date().toISOString();
        const stmts = phones
          .map(p => String(p || '').replace(/\D/g, ''))
          .filter(p => p.length >= 8)
          .map(p => env.DB.prepare(
            `INSERT INTO wa_chats_summary (phone, inbox, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(phone) DO UPDATE SET inbox = excluded.inbox`
          ).bind(p, inbox, now));
        if (stmts.length) await env.DB.batch(stmts);
        ctx.waitUntil(invalidateChatsSummaryCache(request));
        return json({ ok: true, updated: stmts.length, inbox });
      }

      // Marcar conversación como leída
      if (request.method === 'POST' && path === '/admin/wa/mark-read') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { phone, ts } = body || {};
        if (!phone || !ts) return json({ error: 'missing phone or ts' }, 400);
        // Invalidar cache del chats-summary: el unread count del chat marcado
        // cambia a 0 y el badge tiene que refrescar al instante (no esperar 4s).
        ctx.waitUntil(invalidateChatsSummaryCache(request));
        try {
          await env.DB.prepare(
            'INSERT INTO wa_read_cursor (phone, last_read_ts, updated_at) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET last_read_ts = excluded.last_read_ts, updated_at = excluded.updated_at'
          ).bind(phone, ts, new Date().toISOString()).run();
          // Resetear el contador de no leídos en la libreta resumen (el trigger
          // solo suma; el reset a 0 lo hacemos acá al marcar el chat como leído).
          try { await env.DB.prepare('UPDATE wa_chats_summary SET unread = 0 WHERE phone = ?').bind(phone).run(); } catch (_) {}
        } catch (e) {
          try {
            await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_read_cursor (phone TEXT PRIMARY KEY, last_read_ts TEXT NOT NULL, updated_at TEXT NOT NULL)').run();
            await env.DB.prepare(
              'INSERT OR REPLACE INTO wa_read_cursor (phone, last_read_ts, updated_at) VALUES (?, ?, ?)'
            ).bind(phone, ts, new Date().toISOString()).run();
          } catch (_) {}
        }

        // Marcar el último inbound como leído en WhatsApp (doble tilde azul al cliente).
        // Solo lo hacemos para el ÚLTIMO mensaje inbound del contacto — Meta automáticamente
        // marca todos los anteriores como leídos también.
        try {
          const lastInbound = await env.DB.prepare(
            "SELECT wamid FROM wa_messages WHERE phone = ? AND direction = 'inbound' AND wamid != '' AND ts <= ? ORDER BY ts DESC LIMIT 1"
          ).bind(phone, ts).first();
          if (lastInbound?.wamid && lastInbound.wamid.startsWith('wamid.')) {
            await waSend(env, {
              messaging_product: 'whatsapp',
              status: 'read',
              message_id: lastInbound.wamid,
              // Bonus: typing indicator para mostrar que estamos por contestar.
              typing_indicator: { type: 'text' }
            });
          }
        } catch (e) { /* mark-read en WA es best-effort, no rompe el flow del cursor */ }

        return json({ ok: true });
      }

      // ===== Enviar media (foto/audio) por WhatsApp =====
      if (request.method === 'POST' && path === '/admin/wa/send-media') {
        const ct = request.headers.get('Content-Type') || '';
        if (!ct.includes('multipart/form-data')) return json({ error: 'expected multipart/form-data' }, 400);
        const fd = await request.formData();
        const to = fd.get('to');
        // Rol 'cursos' (Abril) solo puede mandar media a chats de su bandeja.
        {
          const _role = await getSessionRole(env, session.user);
          if (!(await inboxAccessOk(env, _role, String(to || '').replace(/\D/g, '')))) {
            return json({ error: 'forbidden: chat fuera de tu bandeja' }, 403);
          }
        }
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
        const cleanMime = mime.split(';')[0].trim();
        await env.MEDIA.put(r2Key, buf, { httpMetadata: { contentType: cleanMime } });
        // 2. Upload media a WhatsApp (Meta o 360dialog) para obtener el media id.
        // Subimos con el mime LIMPIO (360dialog rechaza el param "; codecs=opus").
        // La NOTA DE VOZ no depende del mime del upload, sino del flag voice:true
        // en el send (ver abajo) + que el archivo sea ogg/opus (lo es: OggS+OpusHead).
        const _wa1 = getWaClient(env);
        const uploadFd = new FormData();
        uploadFd.append('messaging_product', 'whatsapp');
        uploadFd.append('file', new Blob([buf], { type: cleanMime }), fileName);
        uploadFd.append('type', cleanMime);
        const uploadR = await fetch(_wa1.mediaUploadUrl(), { method: 'POST', headers: _wa1.headers, body: uploadFd });
        const uploadData = await uploadR.json().catch(() => ({}));
        if (!uploadR.ok || !uploadData.id) {
          // Log de diagnóstico: mime recibido + respuesta cruda del provider.
          try { await env.DB.prepare('INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)').bind(new Date().toISOString(), `AUDIO_FAIL type=${type} mimeRecibido=${mime} clean=${cleanMime} status=${uploadR.status} resp=${JSON.stringify(uploadData).slice(0, 600)}`).run(); } catch (_) {}
          return json({ error: 'media upload failed', detail: (uploadData?.error?.message || uploadData?.error || JSON.stringify(uploadData) || '').toString().slice(0, 200) }, 500);
        }
        const mediaId = uploadData.id;
        // 3. Send via WA API
        let payload;
        if (type === 'image') {
          payload = { messaging_product: 'whatsapp', to: num, type: 'image', image: { id: mediaId, caption: caption || undefined } };
        } else if (type === 'audio') {
          // voice:true → 360dialog/WhatsApp lo renderiza como NOTA DE VOZ (PTT,
          // con ondita), NO como archivo adjunto. Requiere que el archivo sea
          // ogg/opus (lo es). Sin este flag llega como audio-archivo (que es lo
          // que pasaba). Feature beta de la Cloud API, sin allowlisting.
          // Doc: docs.360dialog.com/docs/messaging/media/voice-message-beta-program
          payload = { messaging_product: 'whatsapp', to: num, type: 'audio', audio: { id: mediaId, voice: true } };
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
          // UPSERT (NO "INSERT OR IGNORE"): el webhook de status ('sent') puede
          // crear un placeholder msg_type='status' con este wamid ANTES de que
          // termine el upload del audio/imagen (es lento: R2 + Cloud API). Con
          // INSERT OR IGNORE el placeholder ganaba y la data real (media_url,
          // tipo, body) se perdía → el media no se veía en otras PCs y quien lo
          // mandó lo re-enviaba (de ahí el "se manda dos veces"). Con ON CONFLICT
          // pisamos el placeholder con la data real, sin tocar el status ya
          // avanzado (delivered/read).
          await env.DB.prepare(
            `INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(wamid) DO UPDATE SET
               msg_type = excluded.msg_type,
               body = excluded.body,
               media_url = excluded.media_url,
               context_id = excluded.context_id
             WHERE wa_messages.msg_type = 'status' OR wa_messages.media_url IS NULL OR wa_messages.media_url = ''`
          ).bind(new Date().toISOString(), r.id || '', 'outbound', num, '', type, body, r2Key, replyTo || '', 'sent').run();
        } catch (_) {}
        return json({ id: r.id, r2Key, type });
      }

      // ===== Enviar presupuesto de un brief: render (foto) + presupuesto de caption =====
      // body: { brief_id, to, caption }
      // Manda el render del brief como IMAGEN con el texto del presupuesto de
      // pie de foto, en un solo mensaje (como pidió Gaspar). Si el brief no
      // tiene render, manda solo el texto. Si el caption supera el límite de
      // WhatsApp (1024 chars), manda la imagen sin caption + el texto aparte.
      if (request.method === 'POST' && path === '/admin/wa/send-brief-presupuesto') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { brief_id, to, caption } = body || {};
        if (!to || !caption) return json({ error: 'missing to or caption' }, 400);
        const num = normalizeArPhone(to);
        if (!num) return json({ error: 'numero invalido' }, 400);

        // Buscar el render más reciente del brief.
        let renderKey = null;
        if (brief_id) {
          try {
            const row = await env.DB.prepare(
              "SELECT r2_key FROM brief_imagenes WHERE brief_id = ? AND tipo = 'render' ORDER BY created_at DESC, id DESC LIMIT 1"
            ).bind(brief_id).first();
            if (row && row.r2_key) renderKey = row.r2_key;
          } catch (_) {}
        }

        const CAPTION_MAX = 1024;
        const nowIso = () => new Date().toISOString();
        const saveMsg = async (wamid, type, bodyTxt, mediaKey) => {
          try {
            await env.DB.prepare(
              'INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).bind(nowIso(), wamid || '', 'outbound', num, '', type, bodyTxt, mediaKey || '', '', 'sent').run();
          } catch (_) {}
        };

        let usedImage = false, splitText = false, mainId = '';

        if (renderKey) {
          const obj = await env.MEDIA.get(renderKey);
          if (obj) {
            const buf = await obj.arrayBuffer();
            const mime = obj.httpMetadata?.contentType || 'image/jpeg';
            const fileName = renderKey.split('/').pop() || 'render.jpg';
            const _wa = getWaClient(env);
            const fd = new FormData();
            fd.append('messaging_product', 'whatsapp');
            fd.append('file', new Blob([buf], { type: mime }), fileName);
            fd.append('type', mime);
            const upR = await fetch(_wa.mediaUploadUrl(), { method: 'POST', headers: _wa.headers, body: fd });
            const upJ = await upR.json().catch(() => ({}));
            if (upR.ok && upJ.id) {
              usedImage = true;
              const fits = String(caption).length <= CAPTION_MAX;
              const imgCaption = fits ? caption : '';
              const r = await waSend(env, { messaging_product: 'whatsapp', to: num, type: 'image', image: { id: upJ.id, caption: imgCaption || undefined } });
              await logWaEvent(env, { to: num, kind: 'image', ref: 'brief:' + (brief_id || ''), ok: r.ok, messageId: r.id, error: r.error });
              if (!r.ok) return json({ error: r.error || 'image send failed' }, r.status || 500);
              mainId = r.id || '';
              await saveMsg(r.id, 'image', imgCaption || '[imagen]', renderKey);
              // Caption no entraba → mandar el texto como segundo mensaje.
              if (!fits) {
                splitText = true;
                const rt = await waSendText(env, num, caption);
                await saveMsg(rt.id, 'text', caption, '');
              }
            }
          }
        }

        // Sin render (o el upload falló): mandar solo texto.
        if (!usedImage) {
          const rt = await waSendText(env, num, caption);
          await logWaEvent(env, { to: num, kind: 'text', ref: 'brief:' + (brief_id || ''), ok: rt.ok, messageId: rt.id, error: rt.error });
          if (!rt.ok) return json({ error: rt.error || 'text send failed' }, rt.status || 500);
          mainId = rt.id || '';
          await saveMsg(rt.id, 'text', caption, '');
        }

        return json({ id: mainId, hasImage: usedImage, splitText });
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
          const _waRe = getWaClient(env);
          const fd = new FormData();
          fd.append('messaging_product', 'whatsapp');
          fd.append('file', new Blob([buf], { type: mime }), fileName);
          fd.append('type', mime);
          const upR = await fetch(_waRe.mediaUploadUrl(), {
            method: 'POST',
            headers: _waRe.headers,
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
              else if (original.msg_type === 'audio') payload = { messaging_product: 'whatsapp', to: num, type: 'audio', audio: { id: up.id, voice: true } };
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
          const rs = await env.DB.prepare('SELECT id, shortcut, body, media_r2_key, vertical FROM quick_replies ORDER BY shortcut').all();
          return json({ replies: rs.results || [] });
        } catch (e) { return json({ replies: [] }); }
      }
      if (request.method === 'POST' && path === '/admin/quick-replies') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { shortcut, body: text, media_r2_key, vertical } = body || {};
        if (!shortcut || (!text && !media_r2_key)) return json({ error: 'missing shortcut, body or media' }, 400);
        const sc = shortcut.toLowerCase().replace(/\s+/g, '_');
        const vert = (vertical === 'cursos') ? 'cursos' : 'carteles';
        await env.DB.prepare('INSERT OR REPLACE INTO quick_replies (shortcut, body, media_r2_key, vertical, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(sc, text || '', media_r2_key || null, vert, new Date().toISOString()).run();
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
        const _waQr = getWaClient(env);
        const fd = new FormData();
        fd.append('messaging_product', 'whatsapp');
        fd.append('file', new Blob([buf], { type: mime }), 'qr.' + ext);
        fd.append('type', mime);
        const upR = await fetch(_waQr.mediaUploadUrl(), {
          method: 'POST',
          headers: _waQr.headers,
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
        const _waT = getWaClient(env);
        if (_waT.provider === 'meta' && (!env.WA_BUSINESS_ACCOUNT_ID || !env.WA_TOKEN)) return json({ error: 'WA not configured (meta)' }, 500);
        const components = [{ type: 'BODY', text: body_text }];
        if (Array.isArray(example_params) && example_params.length) {
          components[0].example = { body_text: [example_params] };
        }
        const r = await fetch(_waT.templatesUrl(), {
          method: 'POST',
          headers: { ..._waT.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, category, language, components })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: data?.error?.message || 'create failed', raw: data }, r.status || 500);
        return json({ ok: true, id: data.id, status: data.status, category: data.category, provider: _waT.provider });
      }
      // ===== Promo assets (imágenes para campañas como follow-up de copa) =====
      // POST /admin/wa/promo-asset/upload?key=copa-mundial-junio
      //   Body: imagen binaria (image/jpeg, image/png, image/webp).
      //   Header opcional: Content-Type (default image/jpeg).
      // Guarda en R2 con key 'promo/<key>.<ext>'. Invalida el cache de media_id
      // (próxima vez que el cron lo necesite, re-uploadea a Meta).
      //
      // GET /admin/wa/promo-asset?key=...  → devuelve metadata + URL del worker
      //   para previsualizar (admin-only via /admin/media path).
      if (request.method === 'POST' && path === '/admin/wa/promo-asset/upload') {
        const role = await getSessionRole(env, session.user);
        if (role !== 'admin') return json({ error: 'forbidden' }, 403);
        const key = (url.searchParams.get('key') || '').trim();
        if (!key || !/^[a-z0-9-]+$/i.test(key)) return json({ error: 'key inválido (solo a-z 0-9 -)' }, 400);
        if (!env.MEDIA) return json({ error: 'R2 no configurado' }, 500);
        const ct = request.headers.get('content-type') || 'image/jpeg';
        const cleanMime = String(ct).split(';')[0].trim();
        const ext = cleanMime.includes('png') ? '.png'
                  : cleanMime.includes('webp') ? '.webp'
                  : '.jpg';
        const r2Key = `promo/${key}${ext}`;
        let buf;
        try { buf = await request.arrayBuffer(); } catch (e) { return json({ error: 'no pude leer el body: ' + e.message }, 400); }
        if (!buf || buf.byteLength < 100) return json({ error: 'imagen vacía o demasiado chica' }, 400);
        if (buf.byteLength > 5 * 1024 * 1024) return json({ error: 'imagen >5MB (Meta no acepta)' }, 400);
        try {
          await env.MEDIA.put(r2Key, buf, { httpMetadata: { contentType: cleanMime } });
        } catch (e) { return json({ error: 'r2 put failed: ' + e.message }, 500); }
        // Invalidar cache del media_id para esta key (próxima invocación
        // re-uploadea a Meta con la imagen nueva).
        try { await env.DB.prepare('DELETE FROM kv_cache WHERE k = ?').bind('promo_media:' + r2Key).run(); } catch (_) {}
        return json({ ok: true, key, r2_key: r2Key, size: buf.byteLength, mime: cleanMime });
      }

      // ===== Unreachable phones — listar / agregar / borrar =====
      // GET  /admin/wa/unreachable          → { phones: [...] }
      // POST /admin/wa/unreachable          { phone, reason? } → marcar manual
      // DELETE /admin/wa/unreachable?phone= → desmarcar manual
      if (request.method === 'GET' && path === '/admin/wa/unreachable') {
        try {
          const limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10) || 500, 2000);
          const rs = await env.DB.prepare(
            'SELECT phone, marked_at, reason, last_error, last_template, fail_count, updated_at FROM wa_unreachable_phones ORDER BY updated_at DESC LIMIT ?'
          ).bind(limit).all();
          return json({ phones: rs.results || [] });
        } catch (e) { return json({ error: e.message }, 500); }
      }
      if (request.method === 'POST' && path === '/admin/wa/unreachable') {
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { phone, reason } = body || {};
        if (!phone) return json({ error: 'missing phone' }, 400);
        await markUnreachable(env, phone, reason || 'manual', '(marcado manual)', '');
        return json({ ok: true, phone: normalizeArPhone(phone) });
      }
      if (request.method === 'DELETE' && path === '/admin/wa/unreachable') {
        const phone = url.searchParams.get('phone');
        if (!phone) return json({ error: 'missing phone' }, 400);
        await removeUnreachable(env, phone);
        return json({ ok: true, phone: normalizeArPhone(phone) });
      }
      // DELETE template — útil para recrear cuando se carga mal (encoding, typos).
      // Meta y 360dialog NO permiten editar un template aprobado, hay que borrar y recrear.
      // En Meta: DELETE /{waba_id}/message_templates?name=...
      // En 360dialog: DELETE /v1/configs/templates/{templatename}
      if (request.method === 'DELETE' && path === '/admin/wa/template-delete') {
        const name = url.searchParams.get('name');
        if (!name) return json({ error: 'missing name' }, 400);
        const _waD = getWaClient(env);
        if (_waD.provider === 'meta' && (!env.WA_BUSINESS_ACCOUNT_ID || !env.WA_TOKEN)) return json({ error: 'WA not configured (meta)' }, 500);
        const delUrl = _waD.provider === '360dialog'
          ? `${_waD.templatesUrl()}/${encodeURIComponent(name)}`
          : `${_waD.templatesUrl()}?name=${encodeURIComponent(name)}`;
        const r = await fetch(delUrl, { method: 'DELETE', headers: _waD.headers });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: data?.error?.message || 'delete failed', raw: data }, r.status || 500);
        return json({ ok: true, deleted: name, provider: _waD.provider });
      }
      // set-pin y register son operaciones del flujo ON_PREMISE de Meta direct,
      // ya no aplican con 360dialog Cloud API hosted (lo gestiona el provider).
      // Si alguien las llama post-migración, devolvemos 501 con guía.
      if (request.method === 'POST' && path === '/admin/wa/set-pin') {
        if ((env.WA_PROVIDER || 'meta') !== 'meta') {
          return json({ error: '2FA PIN se gestiona desde el dashboard de 360dialog Hub', provider: env.WA_PROVIDER }, 501);
        }
        if (!session || session.user !== 'Gaspar') return json({ error: 'forbidden' }, 403);
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
      if (request.method === 'POST' && path === '/admin/wa/register') {
        if ((env.WA_PROVIDER || 'meta') !== 'meta') {
          return json({ error: 'register no aplica con 360dialog (Cloud API hosted)', provider: env.WA_PROVIDER }, 501);
        }
        if (!session || session.user !== 'Gaspar') return json({ error: 'forbidden' }, 403);
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
      // Datos crudos del phone number — ramifica por provider.
      // Meta: GET /{phone_id}?fields=...
      // 360dialog: GET /v1/configs/whatsapp_business_account (devuelve TODO).
      if (request.method === 'GET' && path === '/admin/wa/phone-info') {
        if (!session || session.user !== 'Gaspar') return json({ error: 'forbidden' }, 403);
        const _waP = getWaClient(env);
        if (_waP.provider === '360dialog') {
          const r = await fetch(`${_waP.base}/v1/configs/whatsapp_business_account`, { headers: _waP.headers });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) return json({ error: data?.error || 'failed', raw: data }, r.status || 500);
          return json({ provider: '360dialog', ...data });
        }
        if (!env.WA_PHONE_NUMBER_ID || !env.WA_TOKEN) return json({ error: 'WA not configured (meta)' }, 500);
        const v = env.WA_API_VERSION || 'v25.0';
        const r = await fetch(`https://graph.facebook.com/${v}/${env.WA_PHONE_NUMBER_ID}?fields=verified_name,code_verification_status,display_phone_number,quality_rating,platform_type,certificate,messaging_limit_tier,health_status`, {
          headers: { 'Authorization': `Bearer ${env.WA_TOKEN}` }
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: data?.error?.message || 'failed', raw: data }, r.status || 500);
        return json({ provider: 'meta', ...data });
      }
      // Health status del número (quality + tier + can_send_message).
      if (request.method === 'GET' && path === '/admin/wa/phone-status') {
        if (!session || session.user !== 'Gaspar') return json({ error: 'forbidden' }, 403);
        const _waS = getWaClient(env);
        if (_waS.provider === '360dialog') {
          const r = await fetch(`${_waS.base}/v1/health_status`, { headers: _waS.headers });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) return json({ error: data?.error || 'health fetch failed', raw: data }, r.status || 500);
          return json({ provider: '360dialog', ...data });
        }
        if (!env.WA_BUSINESS_ACCOUNT_ID || !env.WA_TOKEN) return json({ error: 'WA not configured (meta)' }, 500);
        const v = env.WA_API_VERSION || 'v25.0';
        const fields = 'id,display_phone_number,quality_rating,messaging_limit_tier,verified_name,status,name_status,throughput,health_status';
        const r = await fetch(`https://graph.facebook.com/${v}/${env.WA_BUSINESS_ACCOUNT_ID}/phone_numbers?fields=${fields}`, {
          headers: { 'Authorization': `Bearer ${env.WA_TOKEN}` }
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: data?.error?.message || 'fetch failed', raw: data }, r.status || 500);
        return json({ provider: 'meta', phones: data.data || [] });
      }
      if (request.method === 'GET' && path === '/admin/wa/templates') {
        const _waL = getWaClient(env);
        if (_waL.provider === 'meta' && (!env.WA_BUSINESS_ACCOUNT_ID || !env.WA_TOKEN)) return json({ error: 'WA not configured (meta)' }, 500);
        const sep = _waL.templatesUrl().includes('?') ? '&' : '?';
        const r = await fetch(`${_waL.templatesUrl()}${sep}limit=100&fields=name,status,category,language,components`, {
          headers: _waL.headers
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: data?.error?.message || 'list failed' }, r.status || 500);
        return json({ templates: data.data || data.waba_templates || [], provider: _waL.provider });
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
          'alto_cm', 'ancho_cm', 'm2', 'neon_mt', 'tramos', 'medidas_libre',
          'precio_trans', 'precio_negro', 'precio_final',
          'descuento', 'recargo', 'reventa', 'comision_joaco',
          'comercial_id', 'disenador_id', 'notas',
          'created_at', 'updated_at'
        ];
        const vals = [
          body.cliente_wa_id || '', body.cliente_nombre || null, body.origen_lead || '',
          body.estado || 'nuevo', body.tipo || null, body.diseno || null,
          body.alto_cm ?? null, body.ancho_cm ?? null, body.m2 ?? null, body.neon_mt ?? null, body.tramos ?? 0,
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
          'alto_cm', 'ancho_cm', 'm2', 'neon_mt', 'tramos', 'medidas_libre',
          'precio_trans', 'precio_negro', 'precio_final',
          'descuento', 'recargo', 'reventa', 'comision_joaco',
          'disenador_id', 'intentos_followup', 'notas', 'sheet_row'
        ];
        const sets = [];
        const args = [];
        for (const k of editable) {
          if (!(k in body)) continue;
          // Guard defensivo: nunca pisar un teléfono ya cargado con vacío. Si
          // un caller manda cliente_wa_id='' (ej. una auto-grabación sin el
          // campo en el DOM), lo ignoramos para no borrar el número del cliente.
          // Para borrarlo a propósito hay que mandar origen_lead='ig' (que sí
          // se permite cambiar) — el teléfono queda guardado pero no se usa.
          if (k === 'cliente_wa_id') {
            const nv = String(body[k] ?? '').replace(/\D/g, '');
            if (!nv) continue; // vacío → no tocar
            sets.push(`${k} = ?`); args.push(nv);
            continue;
          }
          sets.push(`${k} = ?`); args.push(body[k]);
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

      // POST /admin/briefs/:id/generar-render  →  pipeline IA completo en paralelo:
      //   1. Toma como input el boceto si existe; si no, la captura de chat más reciente.
      //   2. Llama gemini-3-pro-image para generar el render (~$0.04).
      //   3. Llama gemini-2.5-flash para estimar ancho_cm, alto_cm, neon_mt (~$0.001).
      //   4. Guarda el render en R2 + actualiza el brief con las medidas estimadas.
      //   5. Devuelve la imagen del render + los params + flag dif_vs_cliente.
      // Idea: con esto Joaco solo tiene que mandar capturas del chat y el AI
      // saca todo lo necesario para cotizar, salteando al diseñador.
      if (request.method === 'POST' && /^\/admin\/briefs\/\d+\/generar-render$/.test(path)) {
        const briefId = path.split('/')[3];
        if (!env.GEMINI_API_KEY) return json({ error: 'Falta configurar GEMINI_API_KEY en el worker' }, 503);
        if (!env.MEDIA) return json({ error: 'R2 not configured' }, 500);

        const brief = await env.DB.prepare('SELECT * FROM briefs WHERE id = ?').bind(briefId).first();
        if (!brief) return json({ error: 'brief not found' }, 404);

        // Prioridad de imagen input: boceto > captura de chat más reciente.
        let inputRow = await env.DB.prepare(
          "SELECT r2_key, content_type, tipo FROM brief_imagenes WHERE brief_id = ? AND tipo = 'boceto' ORDER BY orden DESC, id DESC LIMIT 1"
        ).bind(briefId).first();
        let inputOrigen = 'boceto';
        if (!inputRow) {
          inputRow = await env.DB.prepare(
            "SELECT r2_key, content_type, tipo FROM brief_imagenes WHERE brief_id = ? AND tipo = 'chat' ORDER BY orden DESC, id DESC LIMIT 1"
          ).bind(briefId).first();
          inputOrigen = 'chat';
        }
        if (!inputRow) return json({ error: 'No hay imagen para generar (subí un boceto o una captura del cliente)' }, 400);

        const obj = await env.MEDIA.get(inputRow.r2_key);
        if (!obj) return json({ error: 'imagen no encontrada en R2' }, 404);
        const inputBuf = await obj.arrayBuffer();

        // Contexto para AMBOS prompts: lo que Joaco escribió, lo que ya está en
        // el brief Y las notas del usuario (instrucciones específicas para esta
        // generación, ej: "letras en cursiva", "color verde", "agregar marco", etc.).
        const contextoLines = [];
        if (brief.cliente_nombre) contextoLines.push(`Cliente / título: ${brief.cliente_nombre}`);
        if (brief.medidas_libre) contextoLines.push(`Medidas que pidió el cliente: ${brief.medidas_libre}`);
        if (brief.ancho_cm) contextoLines.push(`Ancho ya definido: ${brief.ancho_cm} cm`);
        if (brief.alto_cm) contextoLines.push(`Alto ya definido: ${brief.alto_cm} cm`);
        if (brief.neon_mt) contextoLines.push(`Neón ya definido: ${brief.neon_mt} m`);
        if (brief.notas && String(brief.notas).trim()) {
          contextoLines.push(`\nNOTAS / INSTRUCCIONES ESPECÍFICAS PARA ESTE DISEÑO (tomalas en cuenta):\n${String(brief.notas).trim()}`);
        }
        const contexto = contextoLines.join('\n');

        // En PARALELO: render (caro, lento) + params (barato, rápido).
        // Si una falla y la otra OK, devolvemos lo que hay y reportamos el error parcial.
        const [renderResult, paramsResult] = await Promise.all([
          generarRenderConGemini(env, inputBuf, inputRow.content_type, contexto),
          estimarParametrosConGemini(env, inputBuf, inputRow.content_type, contexto)
        ]);

        // Render es lo crítico: si falla, error duro (sin render no hay nada que devolver).
        if (renderResult.error) return json({ error: 'render: ' + renderResult.error, params_error: paramsResult.error }, 502);

        // Guardar el render en R2.
        let renderBuf;
        try { renderBuf = Uint8Array.from(atob(renderResult.base64), c => c.charCodeAt(0)).buffer; }
        catch (e) { return json({ error: 'no se pudo decodificar la imagen de Gemini' }, 500); }
        const ext = (renderResult.mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'png';
        const r2Key = `briefs/${briefId}/render-ia-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        await env.MEDIA.put(r2Key, renderBuf, { httpMetadata: { contentType: renderResult.mime } });

        const ordRow = await env.DB.prepare(
          "SELECT COALESCE(MAX(orden), -1) + 1 AS next_ord FROM brief_imagenes WHERE brief_id = ? AND tipo = 'render'"
        ).bind(briefId).first();
        const now = new Date().toISOString();
        const result = await env.DB.prepare(
          "INSERT INTO brief_imagenes (brief_id, r2_key, content_type, size_bytes, orden, created_at, tipo) VALUES (?,?,?,?,?,?, 'render')"
        ).bind(briefId, r2Key, renderResult.mime, renderBuf.byteLength, ordRow?.next_ord ?? 0, now).run();

        // La IA SOLO SUGIERE medidas — NO sobreescribe los campos del brief.
        // El diseñador (Emma) las completa a mano: la IA puede errar y la diseñadora
        // sabe las medidas reales. La response devuelve los valores estimados como
        // referencia (se muestran en un cartel de sugerencia en el frontend), pero
        // ancho_cm / alto_cm / neon_mt del brief quedan tal cual estaban.
        let paramsOut = null;
        if (paramsResult.ok) {
          paramsOut = {
            ancho_cm: paramsResult.ancho_cm,
            alto_cm: paramsResult.alto_cm,
            neon_mt: paramsResult.neon_mt,
            razonamiento: paramsResult.razonamiento,
            dif_vs_cliente: paramsResult.dif_vs_cliente
          };
        }
        await env.DB.prepare('UPDATE briefs SET updated_at = ? WHERE id = ?').bind(now, briefId).run();

        return json({
          id: result.meta.last_row_id, brief_id: parseInt(briefId, 10),
          r2_key: r2Key, content_type: renderResult.mime, tipo: 'render', created_at: now,
          input_origen: inputOrigen,
          params: paramsOut,
          params_error: paramsResult.error || null
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

      // ===== DEBUG: test download de media desde el worker =====
      if (request.method === 'GET' && /^\/admin\/360\/media-test\/\d+$/.test(path)) {
        const mediaId = path.split('/').pop();
        try {
          const result = await downloadMedia(env, mediaId);
          if (!result) return json({ error: 'downloadMedia returned null', mediaId });
          return json({ ok: true, mediaId, ...result });
        } catch (e) {
          return json({ error: e.message, mediaId });
        }
      }

      // ===== 360dialog webhook config (echoes de WA Business) =====
      // GET ver config actual, PUT actualizar fields suscritos.
      if (request.method === 'GET' && path === '/admin/360/webhook') {
        if (!env.D360_API_KEY) return json({ error: 'D360_API_KEY not configured' }, 500);
        try {
          const r = await fetch('https://waba-v2.360dialog.io/v1/configs/webhook', {
            headers: { 'D360-API-KEY': env.D360_API_KEY, 'Accept': 'application/json' }
          });
          const text = await r.text();
          let body; try { body = JSON.parse(text); } catch { body = text; }
          return json({ status: r.status, body });
        } catch (e) {
          return json({ error: e.message }, 500);
        }
      }
      if (request.method === 'POST' && path === '/admin/360/webhook') {
        if (!env.D360_API_KEY) return json({ error: 'D360_API_KEY not configured' }, 500);
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        try {
          const r = await fetch('https://waba-v2.360dialog.io/v1/configs/webhook', {
            method: 'POST',
            headers: { 'D360-API-KEY': env.D360_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(body)
          });
          const text = await r.text();
          let resp; try { resp = JSON.parse(text); } catch { resp = text; }
          return json({ status: r.status, body: resp });
        } catch (e) {
          return json({ error: e.message }, 500);
        }
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
    // Cola de auto-respuestas (minicurso): corre en CADA tick, incluido el cron
    // dedicado de cada minuto, para que la demora sea ~1-2 min y no más.
    ctx.waitUntil(processAutoReplyQueue(env));
    // Procesar respuestas pendientes del gate de feedback del minicurso:
    // espera 2 min al cliente, junta todos los mensajes, manda a la IA y decide.
    ctx.waitUntil(processMinicursoGiftPending(env));
    // Idem para la campaña de cursos (respuesta al template 1): espera 2 min,
    // junta todos los mensajes, IA decide entre encolar cursos_evento o revelar.
    ctx.waitUntil(processCursosCampaignPending(env));
    // Recuperar media (imagenes/videos/audios) que fallaron en el webhook por
    // race condition con Meta. Reintenta los media_id raw recientes (<2 hs);
    // los viejos ya caducaron en Meta y no tiene sentido reintentarlos.
    ctx.waitUntil(processPendingMedia(env));
    // Cola de goteo del broadcast de cursos: procesa los queued con due_at
    // vencido. Encolados vía POST /admin/wa/cursos-broadcast-schedule.
    ctx.waitUntil(processCursosBroadcastQueue(env));
    // Tick rápido (cron */1): solo la cola, no el resto de tareas pesadas.
    if (event.cron === '* * * * *') return;
    ctx.waitUntil(processScheduledMessages(env));
    // Follow-ups en horario hábil AR (8-20): campaña de cursos + minicurso (4h sin responder).
    const hAR = (new Date(event.scheduledTime).getUTCHours() - 3 + 24) % 24;
    if (hAR >= 8 && hAR < 20) {
      ctx.waitUntil(processCursosFollowup(env));
      ctx.waitUntil(processMinicursoFollowup(env));
    }
    // Followups de Apps Script solo a las 13:00 UTC (10:00 AR)
    const hour = new Date(event.scheduledTime).getUTCHours();
    if (hour === 13) ctx.waitUntil(runScheduled(env));
    // Follow-up automático de presupuestos del cotizador: solo horario hábil AR (8-20).
    // Usa hAR (calculado más arriba en este mismo handler) para consistencia
    // con processCursosFollowup/processMinicursoFollowup.
    if (hAR >= 8 && hAR <= 20) ctx.waitUntil(processPresupuestoFollowups(env));
    // Monitor de status de templates: 1 vez por hora, no cada 5 min. El polling
    // es fallback; lo ideal es suscribir al webhook field 'message_template_status_update'
    // en el hub de 360dialog (lo manejamos abajo en notifyTemplateStatusChange).
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    if (minute < 5) ctx.waitUntil(monitorTemplateStatus(env));
    // Análisis de chats nuevos: 1 vez por hora (procesa hasta 15 chats que
    // tengan actividad nueva desde su último análisis o que nunca se analizaron).
    // Ignora phones internos. Idempotente: si no hay nada que analizar, no hace nada.
    if (minute < 5) ctx.waitUntil(processAnalysisPending(env));
    // Fase 2C: síntesis de mejoras al playbook, 1 vez por semana (lunes 13:00 UTC
    // = 10:00 AR). La función tiene su propio gate: si no hay suficiente feedback
    // nuevo desde la última corrida, no gasta. Las propuestas quedan 'pending'
    // para que Gaspar las apruebe — el cron NUNCA toca el playbook solo.
    const dow = new Date(event.scheduledTime).getUTCDay(); // 0=dom, 1=lun
    if (dow === 1 && hour === 13 && minute < 5) {
      ctx.waitUntil(synthesizeFrameworkImprovements(env, { createdBy: 'cron' }));
    }
  }
};

// Cron handler: procesa chats con actividad nueva. Limit conservador (5/hora)
// para respetar rate limits del tier 1 de Anthropic API (8k output tokens/min,
// 50 req/min). Si subimos de tier (agregando créditos) podemos aumentar.
// Tras el backfill inicial, los chats con actividad nueva por día son ~30-50,
// se procesan en ~10-12 horas con este ritmo.
async function processAnalysisPending(env) {
  if (!env.ANTHROPIC_API_KEY) return;
  try {
    const rs = await env.DB.prepare(
      `WITH chat_stats AS (
         SELECT phone, MAX(ts) AS last_ts, COUNT(*) AS n_msgs
         FROM wa_messages WHERE msg_type != 'reaction'
           AND phone NOT IN (SELECT phone FROM wa_internal_phones)
         GROUP BY phone
         HAVING n_msgs >= 3
       )
       SELECT cs.phone FROM chat_stats cs
       LEFT JOIN wa_conversations c ON c.phone = cs.phone
       WHERE c.last_analyzed_at IS NULL OR c.last_analyzed_at < cs.last_ts
          OR c.analysis_version < ?
       ORDER BY cs.last_ts DESC
       LIMIT 5`
    ).bind(ANALYSIS_PROMPT_VERSION).all();
    const phones = (rs.results || []).map(r => r.phone);
    if (!phones.length) return;
    // Procesamos secuencial (no Promise.all) para no superar el rate limit
    // de requests/minuto del API. Con 5 chats × ~3s c/u = 15s wall time.
    for (const p of phones) {
      try { await analyzeChatWithClaude(env, p, 'sonnet'); } catch (_) {}
    }
  } catch (_) {}
}

// ===== Monitor de templates: notifica al admin cuando cambia el status =====
async function monitorTemplateStatus(env) {
  if (!env.ADMIN_NOTIFY_PHONE) return;
  let _waM;
  try { _waM = getWaClient(env); } catch (_) { return; }
  if (_waM.provider === 'meta' && (!env.WA_BUSINESS_ACCOUNT_ID || !env.WA_TOKEN)) return;
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS template_status_cache (name TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL)').run();
    const sep = _waM.templatesUrl().includes('?') ? '&' : '?';
    const r = await fetch(`${_waM.templatesUrl()}${sep}limit=100&fields=name,status,category`, {
      headers: _waM.headers
    });
    if (!r.ok) return;
    const data = await r.json().catch(() => ({}));
    const templates = data?.data || data?.waba_templates || [];
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
  if (await isWaBillingBlocked(env)) return; // pausado por bloqueo de pago de WhatsApp
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

// ===== Variantes de follow-up de presupuesto =====
// Lógica de selección por fecha (AR):
//   - 24-jun a 30-jun (última semana junio): PROMO COPA + foto.
//   - Resto del tiempo: texto según monto del presupuesto (≷ $300.000).
//     - 'low'  → texto suave ("Holaa, cómo estás?")
//     - 'high' → texto pro ("Buenas! Avisanos qué te pareció")
//
// Detección del monto: regex que toma el MAYOR $XXX del body — captura el
// precio principal del cartel ignorando los accesorios chiquitos (Slim,
// Control, App). Si no parsea, default a 'low'.
const PROMO_COPA_START_UTC = '2026-06-24T03:00:00Z'; // 24-jun 00:00 AR (UTC-3)
const PROMO_COPA_END_UTC   = '2026-07-01T03:00:00Z'; // 1-jul 00:00 AR (UTC-3)
const PROMO_COPA_R2_KEY = 'promo/copa-mundial-junio.jpg';
const PROMO_COPA_CAPTION = 'Te quería avisar que estamos regalando copas del mundo a todos los que compren esta semana!\n\nAvísame si querías avanzar con el pedido, o si queres que te llamemos y te asesoremos!';
const FOLLOWUP_PRESUPUESTO_LOW_TEXT = 'Holaa, cómo estás? Pudiste chequear el presupuesto? Cualquier cosa podemos llamarte para asesorarte! Quedamos a disposición!';
const FOLLOWUP_PRESUPUESTO_HIGH_TEXT = 'Buenas! Avisanos qué te pareció el presupuesto! Si te cierra el precio, o si querés que veamos de mejorar los números.\nTe podemos llamar para asesorarte, o coordinamos una visita si estas por Capital federal o GBA.';
const FOLLOWUP_AMOUNT_THRESHOLD = 300000;

// Prefijos de TODOS los possibles follow-ups (legacy + nuevos) para dedup.
// Si conv contiene un outbound que comience con CUALQUIERA de estos, ya tuvo
// follow-up y no se le manda otro.
const ALL_FOLLOWUP_PREFIXES_TEXT = [
  FOLLOWUP_PRESUPUESTO_PREFIX_TEXT,            // 'Aca te dejamos el presupuesto!' (legacy)
  'Te quería avisar que estamos regalando',    // copa
  'Holaa, cómo estás? Pudiste chequear',       // < 300k
  'Buenas! Avisanos qué te pareció',           // ≥ 300k
  '[plantilla: seguimiento_presupuesto]'       // contingencia ventana cerrada (template)
];

function extractPresupuestoAmount(body) {
  if (!body) return 0;
  // Toma el MAYOR número con $ del body. En el cotizador, el precio principal
  // del cartel siempre es mayor que los accesorios (Slim $18.7k, Control $25k,
  // App $38k). Si querés ser más estricto, cambia a "primer match después de
  // 'Base acrílica transparente'", pero el max es más robusto a cambios de
  // formato del cotizador.
  let max = 0;
  const re = /\$\s*([\d.]+)/g;
  let m;
  while ((m = re.exec(String(body))) !== null) {
    const raw = m[1].replace(/\./g, '');
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return max;
}

// Sube un buffer a Meta vía /media, devuelve el media_id (o null si falla).
// El media_id sirve para mandar mensajes type='image'|'video'|'document' SIN
// re-uploadear cada vez (válido por ~30 días).
async function uploadMediaToMeta(env, buf, mime, fileName) {
  try {
    const wa = getWaClient(env);
    if (wa.provider === 'meta' && !env.WA_TOKEN) return null;
    const fd = new FormData();
    fd.append('messaging_product', 'whatsapp');
    fd.append('file', new Blob([buf], { type: mime }), fileName);
    fd.append('type', mime);
    const r = await fetch(wa.mediaUploadUrl(), {
      method: 'POST',
      headers: wa.headers,
      body: fd
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return null;
    return data.id || null;
  } catch (_) { return null; }
}

// Devuelve el media_id de Meta para una imagen en R2, cacheando el resultado
// en kv_cache. TTL 7 días — Meta caduca media_ids a ~30 días pero re-upload
// más frecuente es trivial. Si la imagen no está en R2, devuelve null y el
// caller debe fallback a texto.
async function getPromoMediaId(env, r2Key) {
  if (!env.MEDIA || !env.DB) return null;
  const cacheKey = 'promo_media:' + r2Key;
  // 1) Try cache válido.
  try {
    const row = await env.DB.prepare("SELECT v, updated_at FROM kv_cache WHERE k = ?").bind(cacheKey).first();
    if (row?.v && row.updated_at) {
      const ageMs = Date.now() - new Date(row.updated_at).getTime();
      if (ageMs < 7 * 24 * 60 * 60 * 1000) return row.v;
    }
  } catch (_) {}
  // 2) Re-upload desde R2.
  try {
    const obj = await env.MEDIA.get(r2Key);
    if (!obj) return null;
    const buf = await obj.arrayBuffer();
    const mime = obj.httpMetadata?.contentType || 'image/jpeg';
    const fileName = r2Key.split('/').pop() || 'image.jpg';
    const mediaId = await uploadMediaToMeta(env, buf, mime, fileName);
    if (!mediaId) return null;
    try {
      await env.DB.prepare(
        "INSERT INTO kv_cache (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at"
      ).bind(cacheKey, mediaId, new Date().toISOString()).run();
    } catch (_) {}
    return mediaId;
  } catch (_) { return null; }
}

async function waSendImage(env, to, mediaId, caption) {
  const num = normalizeArPhone(to);
  if (!num) return { ok: false, status: 400, error: 'numero invalido' };
  return waSend(env, {
    messaging_product: 'whatsapp',
    to: num,
    type: 'image',
    image: { id: mediaId, caption: caption || undefined }
  });
}

async function processPresupuestoFollowups(env) {
  if (await isWaBillingBlocked(env)) return; // pausado por bloqueo de pago de WhatsApp
  const now = Date.now();
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  // 1) Presupuestos del cotizador en las últimas 24h, enviados hace al menos 1h.
  //
  // Antes: WHERE body LIKE 'prefix1%' OR body LIKE 'prefix2%'
  // Problema: D1 tira "LIKE or GLOB pattern too complex" cuando wa_messages
  // crece mucho (vimos esto en producción con ~1.5M rows). El planner no
  // puede aplicar el LIKE eficientemente y aborta.
  //
  // Fix: usar substr(body, 1, N) = 'prefix' — comparación exacta de prefijo
  // sin pattern matching. Más rápido y sin el límite de complejidad.
  // Tomamos 26 chars iniciales, suficiente para distinguir ambos formatos:
  //   'Te comparto el presupuesto' (formato nuevo)
  //   'Te comparto la información' (formato viejo)
  const pfx1 = PRESUPUESTO_PREFIXES_TEXT[0].substring(0, 26);
  const pfx2 = PRESUPUESTO_PREFIXES_TEXT[1].substring(0, 26);
  let rows;
  try {
    const rs = await env.DB.prepare(
      "SELECT phone, ts, body, sender_name FROM wa_messages " +
      "WHERE direction = 'outbound' " +
      "  AND ts >= ? AND ts <= ? " +
      "  AND (substr(body, 1, 26) = ? OR substr(body, 1, 26) = ?) " +
      "ORDER BY ts DESC"
    ).bind(oneDayAgo, oneHourAgo, pfx1, pfx2).all();
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
    // ¿Ya tiene follow-up (cualquier variante: legacy, copa, low, high)?
    // Si el outbound posterior arranca con ALGUNO de los prefijos conocidos,
    // ya recibió follow-up.
    if (conv.some(m => m.direction === 'outbound' && ALL_FOLLOWUP_PREFIXES_TEXT.some(pref => (m.body || '').startsWith(pref)))) continue;

    // 4) Decidir qué variante mandar según fecha y monto.
    // - Entre 24-jun y 30-jun: PROMO COPA (imagen + caption) a TODOS.
    // - Resto del tiempo: texto según monto (≷ $300k).
    const ahoraIso = new Date().toISOString();
    const inCopaPromo = ahoraIso >= PROMO_COPA_START_UTC && ahoraIso < PROMO_COPA_END_UTC;
    const monto = extractPresupuestoAmount(p.body);
    let variantBody, variantKind;
    if (inCopaPromo) {
      variantBody = PROMO_COPA_CAPTION;
      variantKind = 'copa';
    } else if (monto >= FOLLOWUP_AMOUNT_THRESHOLD) {
      variantBody = FOLLOWUP_PRESUPUESTO_HIGH_TEXT;
      variantKind = 'high';
    } else {
      variantBody = FOLLOWUP_PRESUPUESTO_LOW_TEXT;
      variantKind = 'low';
    }

    // Helper para insertar el marker (sent o failed) — ambos casos previenen
    // que el próximo cron re-encuentre este presupuesto como pendiente.
    // Guarda el cuerpo de la variante real que se mandó (para dedup futuro).
    // Si es copa, también persistimos la R2 key del promo asset en media_url
    // para que el chat del CRM renderice la imagen (no "Imagen no disponible").
    const insertMarker = async (status, wamid, bodyToStore) => {
      try {
        const mediaUrl = variantKind === 'copa' ? PROMO_COPA_R2_KEY : '';
        await env.DB.prepare(
          'INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(new Date().toISOString(), wamid, 'outbound', p.phone, '', variantKind === 'copa' ? 'image' : 'text', bodyToStore || variantBody, mediaUrl, '', status).run();
      } catch (_) {}
    };

    // 5) Pre-validar: si el teléfono no normaliza, marcamos como fallido
    // permanente y no gastamos call al API ni notificamos al admin.
    if (!normalizeArPhone(p.phone)) {
      await insertMarker('failed', 'fu-invalid:' + p.phone, null);
      await logWaEvent(env, { to: p.phone, kind: 'pp-followup', ref: 'pp-fu:' + p.phone, ok: false, error: 'numero invalido (skip)' });
      skippedInvalid++;
      continue;
    }

    // Skip si el phone está marcado como unreachable. Insertamos marker
    // 'skipped' para no re-evaluarlo en cada cron (idempotencia).
    if (await isUnreachable(env, p.phone)) {
      await insertMarker('skipped', 'fu-unreachable:' + p.phone, null);
      continue;
    }

    // 6.0) CONTINGENCIA ventana cerrada: el texto libre solo puede salir si el
    // cliente escribió hace <24h. Como el follow-up sale días después del
    // presupuesto, casi siempre la ventana está cerrada → Meta rechaza el texto.
    // Si la ventana está cerrada, mandamos la plantilla aprobada (sí sale fuera
    // de las 24h). La ventana se mide por el último inbound del cliente.
    let windowOpen = false;
    try {
      const li = await env.DB.prepare("SELECT MAX(ts) AS t FROM wa_messages WHERE phone = ? AND direction = 'inbound'").bind(p.phone).first();
      windowOpen = !!(li && li.t && (now - new Date(li.t).getTime()) < 24 * 60 * 60 * 1000);
    } catch (_) {}
    if (!windowOpen) {
      const firstName = capitalizeName((p.sender_name || '').split(/\s+/)[0]) || 'amigo/a';
      const rt = await waSendTemplate(env, p.phone, 'seguimiento_presupuesto', 'es_AR', [firstName]);
      if (rt.ok) {
        // Marker 'sent' → dedup (body reconocido por ALL_FOLLOWUP_PREFIXES_TEXT).
        sent++;
        try {
          await env.DB.prepare(
            'INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(new Date().toISOString(), rt.id || ('fu-tpl:' + p.phone), 'outbound', p.phone, '', 'template', '[plantilla: seguimiento_presupuesto]', '', '', 'sent').run();
        } catch (_) {}
      } else {
        // NO marcamos marker → reintenta el próximo cron (p.ej. si la plantilla
        // todavía está 'pending' de aprobación). Solo log, sin notificar al admin
        // (evita ruido en el hueco de aprobación). Acotado por el query de 24h.
        await logWaEvent(env, { to: p.phone, kind: 'pp-followup-tpl', ref: 'pp-fu:' + p.phone, ok: false, error: rt.error });
      }
      await new Promise(rs => setTimeout(rs, 600));
      continue;
    }

    // 6) Enviar (ventana ABIERTA). Si es copa, intentamos imagen+caption; si no
    // hay media disponible (R2 vacío, upload a Meta falla), caemos a texto solo.
    let r;
    if (variantKind === 'copa') {
      const mediaId = await getPromoMediaId(env, PROMO_COPA_R2_KEY);
      if (mediaId) {
        r = await waSendImage(env, p.phone, mediaId, PROMO_COPA_CAPTION);
      } else {
        // Fallback: sin imagen, solo el caption como texto.
        r = await waSendText(env, p.phone, PROMO_COPA_CAPTION);
      }
    } else {
      r = await waSendText(env, p.phone, variantBody);
    }
    if (r.ok) {
      sent++;
      await insertMarker('sent', r.id || '', null);
    } else {
      // Marker failed → el próximo cron NO lo va a re-procesar. Una sola
      // notificación al admin por presupuesto, no spam cada 5 min.
      await insertMarker('failed', 'fu-fail:' + p.phone + ':' + Date.now(), null);
      failures.push({ phone: p.phone, name: p.sender_name || '', error: r.error || 'unknown' });
    }
    await logWaEvent(env, { to: p.phone, kind: 'pp-followup-' + variantKind, ref: 'pp-fu:' + p.phone, ok: r.ok, messageId: r.id, error: r.error });
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
