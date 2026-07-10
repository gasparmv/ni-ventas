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

// ============================================================================
// ===== Portal Revendedores (cotizador publico con cuentas propias) ==========
// Pagina + endpoints servidos por el worker, en dominio aparte del CRM.
// El precio se calcula SERVER-SIDE: los costos/margenes internos nunca viajan
// al navegador del revendedor. Auth separada de la del CRM.
// ============================================================================

// Defaults de la formula nueva (espejo de CONFIG.cotizadorDefaults en app.js).
const REV_COTIZADOR_DEFAULTS = {
  nv_fuente_corto: 4000, nv_fuente_medio: 4500, nv_fuente_largo: 9000,
  nv_costo_m2: 75000, nv_costo_neon_mt: 2631,
  nv_cf_ref_chico: 20500, nv_cf_ref_grande: 109000,
  nv_margen_chico: 0.68, nv_margen_grande: 0.51,
  nv_complejidad_coef: 0.018, nv_complejidad_pivote: 1.4, nv_complejidad_tope: 0.04,
  nv_margen_min: 0.48, nv_margen_max: 0.72,
  nv_divisor_base: 0.815,
  ext_25: 20000, ext_50: 25000, ext_99: 35000,
  nv_negro_ratio: 0.93
};

// Lee los COGS crudos (mismo cache 'cogs_excel' que usa el CRM). Si no hay cache,
// los trae del Apps Script y los cachea. Devuelve el objeto data ({ok, cogs,...}).
async function getCogsForPricing(env) {
  try {
    const row = await env.DB.prepare("SELECT v FROM kv_cache WHERE k = 'cogs_excel'").first();
    if (row && row.v) return JSON.parse(row.v);
  } catch (_) {}
  try {
    if (!env.APPS_SCRIPT_URL) return null;
    const r = await fetch(env.APPS_SCRIPT_URL + '?action=cogs', { redirect: 'follow' });
    const data = await r.json();
    if (data && data.ok) {
      try {
        await env.DB.prepare(
          "INSERT INTO kv_cache (k, v, updated_at) VALUES ('cogs_excel', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at"
        ).bind(JSON.stringify(data), new Date().toISOString()).run();
      } catch (_) {}
    }
    return data;
  } catch (_) { return null; }
}

// Arma los params: defaults + overrides (cotizador_params) + COGS derivados
// (misma derivacion que loadCogsFromExcel en app.js). Asi el precio sugerido
// queda identico al que muestra el CRM.
async function revPriceParams(env) {
  const p = Object.assign({}, REV_COTIZADOR_DEFAULTS);
  try {
    const rs = await env.DB.prepare('SELECT key, value FROM cotizador_params').all();
    for (const r of (rs.results || [])) { const n = Number(r.value); p[r.key] = isNaN(n) ? r.value : n; }
  } catch (_) {}
  try {
    const data = await getCogsForPricing(env);
    const c = data && data.cogs;
    if (c) {
      const costoM2 = Math.round((+c.costo_acrilico_trans || 0) + ((+c.anibal || 0) + (+c.emma || 0)) * (+c.venta_trans_imaginario || 0));
      const neonMt = Math.round(+c.costo_neon_mt || 0);
      const divisor = +(1 - (+c.mano_obra || 0) - (+c.joaquin || 0)).toFixed(4);
      if (costoM2 > 0) p.nv_costo_m2 = costoM2;
      if (neonMt > 0) p.nv_costo_neon_mt = neonMt;
      if (isFinite(divisor) && divisor > 0 && divisor < 1) p.nv_divisor_base = divisor;
    }
  } catch (_) {}
  return p;
}

// Port de calcCotizadorNuevo (app.js). Devuelve precio transparente y negro.
function revCalcPrecio(input, p) {
  const ancho = +input.ancho || 0, alto = +input.alto || 0;
  const metros = +input.neon || 0, tramos = +input.tramos || 0;
  const tipo = String(input.tipo || 'INT').toUpperCase();
  const m2 = (ancho * alto) / 10000;
  const cm = metros * 100;
  const m2Sheet = (ancho * alto) / 100;
  const fuente = cm <= 500 ? p.nv_fuente_corto : cm < 1200 ? p.nv_fuente_medio : p.nv_fuente_largo;
  const cf = m2 * p.nv_costo_m2 + fuente + p.nv_costo_neon_mt * metros;
  const lo = Math.log(p.nv_cf_ref_chico), hi = Math.log(p.nv_cf_ref_grande);
  const x = Math.max(0, Math.min(1, (Math.log(Math.max(cf, 1)) - lo) / (hi - lo)));
  const margenTam = p.nv_margen_chico - (p.nv_margen_chico - p.nv_margen_grande) * x;
  const densidad = metros > 0 ? tramos / metros : 0;
  const ajuste = Math.max(-p.nv_complejidad_tope, Math.min(p.nv_complejidad_tope, p.nv_complejidad_coef * (densidad - p.nv_complejidad_pivote)));
  const margen = Math.max(p.nv_margen_min, Math.min(p.nv_margen_max, margenTam + ajuste));
  let precio = cf / (p.nv_divisor_base - margen);
  if (tipo === 'EXT') precio += m2Sheet <= 25 ? p.ext_25 : m2Sheet <= 50 ? p.ext_50 : p.ext_99;
  const transFinal = Math.round(precio / 500) * 500;
  const negroFinal = Math.round((transFinal * p.nv_negro_ratio) / 500) * 500;
  return { transFinal, negroFinal };
}

// Numeros de revendedor: costo = sugerido -5%; reventa = costo +25% a +35%.
function revNumbers(sugerido) {
  const costo = Math.round(sugerido * 0.95);
  return {
    sugerido,
    costo,
    reventaMin: Math.round(costo * 1.25),
    reventaMax: Math.round(costo * 1.35),
    gananciaMin: Math.round(costo * 0.25),
    gananciaMax: Math.round(costo * 0.35)
  };
}

// --- Auth de revendedores (separada de la del CRM) ---
function revHex(buf) { return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(''); }
function revBytes(hex) { const a = new Uint8Array(hex.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16); return a; }
async function revHashPassword(password, saltHex) {
  const salt = saltHex ? revBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return { hash: revHex(bits), salt: saltHex || revHex(salt) };
}
async function getRevSession(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  try {
    const row = await env.DB.prepare(
      'SELECT s.revendedor_id AS id, s.expires_at AS exp, r.nombre AS nombre, r.email AS email FROM revendedor_sesiones s JOIN revendedores r ON r.id = s.revendedor_id WHERE s.token = ?'
    ).bind(token).first();
    if (!row) return null;
    if (new Date(row.exp) < new Date()) return null;
    return { id: row.id, nombre: row.nombre, email: row.email, token };
  } catch (_) { return null; }
}
async function ensureRevSchema(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS revendedores (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT, email TEXT UNIQUE, whatsapp TEXT, pass_hash TEXT, pass_salt TEXT, created_at TEXT)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS revendedor_sesiones (token TEXT PRIMARY KEY, revendedor_id INTEGER, expires_at TEXT, created_at TEXT)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS revendedor_cotizaciones (id INTEGER PRIMARY KEY AUTOINCREMENT, revendedor_id INTEGER, nombre TEXT, ancho REAL, alto REAL, neon REAL, tramos REAL, tipo TEXT, sugerido INTEGER, costo INTEGER, reventa_min INTEGER, reventa_max INTEGER, created_at TEXT)").run();
  try { await env.DB.prepare("ALTER TABLE revendedor_cotizaciones ADD COLUMN nombre TEXT").run(); } catch (_) {}
}

const REVENDEDOR_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Neon Infinito - Revendedores</title>
<meta name="theme-color" content="#0A0A0F">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800;900&family=Archivo+Black&family=JetBrains+Mono:wght@400;500;700&display=swap">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
--red:#FF1830;--red-glow:#FF4A5E;--cyan:#8FD4DE;
--bg:#0A0A0F;--raised:#101018;--card:#1A1A24;--bd:#262633;--bd2:#3A3A4A;
--fg:#FFFFFF;--mut:#BFBFCF;--sub:#8A8A9E;--faint:#5B5B6E;--gr:#4ADE80;
--fdisp:'Archivo Black','Archivo',system-ui,sans-serif;
--fsans:'Archivo',ui-sans-serif,system-ui,-apple-system,sans-serif;
--fmono:'JetBrains Mono',ui-monospace,Menlo,monospace;
--glow-red:0 0 14px rgba(255,24,48,.6),0 0 32px rgba(255,24,48,.34);
--glow-cyan:0 0 12px rgba(143,212,222,.7),0 0 30px rgba(143,212,222,.4);
}
body{font-family:var(--fsans);background:radial-gradient(1100px 600px at 50% -15%,rgba(255,24,48,.10),transparent),radial-gradient(900px 520px at 88% 4%,rgba(143,212,222,.07),transparent),var(--bg);color:var(--fg);min-height:100vh;line-height:1.45;-webkit-font-smoothing:antialiased}
.wrap{max-width:520px;margin:0 auto;padding:28px 16px 60px}
.brand{display:flex;flex-direction:column;align-items:center;gap:9px;margin:6px 0 26px}
.brand .logo{height:46px;width:auto;filter:drop-shadow(0 0 9px rgba(255,21,21,.55)) drop-shadow(0 0 12px rgba(42,216,255,.4))}
.brand .tag{font-family:var(--fmono);font-size:11px;text-transform:uppercase;letter-spacing:.3em;color:var(--sub)}
.card{background:var(--card);border:1px solid var(--bd);border-radius:18px;padding:20px;margin-bottom:14px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.03)}
h1{font-family:var(--fdisp);font-size:23px;text-transform:uppercase;letter-spacing:-.01em;margin-bottom:5px;line-height:1.05}
.sub{color:var(--sub);font-size:13px;margin-bottom:8px}
label{display:block;font-family:var(--fmono);font-size:10.5px;text-transform:uppercase;letter-spacing:.12em;color:var(--sub);margin:14px 0 6px;font-weight:500}
input,select{width:100%;background:var(--raised);border:1px solid var(--bd);border-radius:10px;padding:12px 13px;color:var(--fg);font-size:15px;font-family:var(--fsans);outline:none;transition:border .15s,box-shadow .15s}
input::placeholder{color:var(--faint)}
input:focus,select:focus{border-color:var(--cyan);box-shadow:0 0 0 3px rgba(143,212,222,.16)}
.r{display:flex;gap:10px}.r>div{flex:1}
.btn{width:100%;border:0;border-radius:11px;padding:14px;font-family:var(--fsans);font-size:14px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:#fff;background:var(--red);cursor:pointer;margin-top:18px;box-shadow:var(--glow-red);transition:transform .1s,box-shadow .2s,filter .2s}
.btn:hover{filter:brightness(1.08);box-shadow:0 0 18px rgba(255,24,48,.85),0 0 46px rgba(255,24,48,.45)}
.btn:active{transform:scale(.99)}.btn:disabled{opacity:.45;box-shadow:none;filter:none}
.tabs{display:flex;gap:6px;background:var(--raised);border:1px solid var(--bd);border-radius:11px;padding:4px}
.tabs button{flex:1;border:0;background:transparent;color:var(--sub);padding:10px;border-radius:8px;font-family:var(--fsans);font-weight:700;cursor:pointer;font-size:13px;text-transform:uppercase;letter-spacing:.04em}
.tabs button.on{background:var(--card);color:var(--fg);box-shadow:inset 0 0 0 1px var(--bd2)}
.err{background:rgba(255,24,48,.12);border:1px solid rgba(255,24,48,.34);color:var(--red-glow);padding:10px 12px;border-radius:9px;font-size:13px;margin-top:12px;display:none}
.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.top .hi{font-size:14px;color:var(--mut)}.top .hi b{color:var(--cyan);font-weight:700}
.linkb{background:none;border:0;color:var(--sub);font-size:11px;cursor:pointer;font-family:var(--fmono);text-transform:uppercase;letter-spacing:.08em}
.base{border:1px solid var(--bd);border-radius:14px;padding:16px;margin-bottom:10px;background:var(--raised)}
.base h3{font-family:var(--fmono);font-size:11px;text-transform:uppercase;letter-spacing:.16em;color:var(--sub);margin-bottom:12px;display:flex;align-items:center;gap:8px}
.base h3 .sw{width:13px;height:13px;border-radius:4px;border:1px solid rgba(255,255,255,.2)}
.line{display:flex;justify-content:space-between;align-items:baseline;padding:6px 0}
.line .k{font-size:13px;color:var(--sub)}
.line .v{font-weight:700;font-size:15px;font-family:var(--fmono)}
.line.big{padding-top:8px}
.line.big .v{font-size:23px;color:var(--cyan);text-shadow:var(--glow-cyan)}
.line.win .v{color:var(--gr)}
.hist .it{border-top:1px solid var(--bd);padding:11px 0;display:flex;justify-content:space-between;gap:8px}
.hist .it:first-child{border-top:0}
.hist .d{color:var(--faint);font-size:11px;font-family:var(--fmono)}
.hist .sp{font-weight:700;font-size:13px}
.hist .pr{text-align:right;white-space:nowrap}
.hist .pr .c{color:var(--cyan);font-weight:700;font-size:13px;font-family:var(--fmono)}
.note{color:var(--faint);font-size:11px;margin-top:10px;text-align:center;line-height:1.6}
.hide{display:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><svg class="logo" viewBox="1500 600 1300 800" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="NEON INFINITO"><path fill="#FF1515" d="M1830.98,943.35c-3.12,0-6.17-1.29-8.36-3.67l-236.8-257.99v250.24c0,6.26-5.08,11.34-11.34,11.34 s-11.34-5.08-11.34-11.34V652.57c0-4.67,2.87-8.87,7.22-10.57c4.36-1.7,9.31-0.54,12.47,2.9l236.8,257.99V652.57 c0-6.26,5.08-11.34,11.34-11.34s11.34,5.08,11.34,11.34v279.44c0,4.67-2.87,8.87-7.22,10.57 C1833.75,943.1,1832.36,943.35,1830.98,943.35z"/><path fill="#FF1515" d="M2081.45,940.36h-178.79c-6.26,0-11.34-5.08-11.34-11.34V647.9c0-6.26,5.08-11.34,11.34-11.34h178.79 c6.26,0,11.34,5.08,11.34,11.34s-5.08,11.34-11.34,11.34H1914v258.45h167.45c6.26,0,11.34,5.08,11.34,11.34 S2087.71,940.36,2081.45,940.36z"/><path fill="#FF1515" d="M2246.82,944.74c-86.17,0-156.28-70.11-156.28-156.28c0-86.17,70.11-156.28,156.28-156.28 s156.28,70.11,156.28,156.28C2403.1,874.63,2332.99,944.74,2246.82,944.74z M2246.82,654.86c-73.67,0-133.6,59.93-133.6,133.6 s59.93,133.6,133.6,133.6s133.6-59.93,133.6-133.6S2320.49,654.86,2246.82,654.86z"/><path fill="#FF1515" d="M2708.34,943.35c-3.12,0-6.17-1.29-8.36-3.67l-236.8-257.99v250.32c0,6.26-5.08,11.34-11.34,11.34 s-11.34-5.08-11.34-11.34V652.57c0-4.67,2.87-8.87,7.22-10.57c4.36-1.7,9.31-0.54,12.47,2.9L2697,902.89V652.57 c0-6.26,5.08-11.34,11.34-11.34s11.34,5.08,11.34,11.34v279.44c0,4.67-2.87,8.87-7.22,10.57 C2711.12,943.1,2709.72,943.35,2708.34,943.35z"/><path fill="#FF1515" d="M1995.54,796.87h-57.82c-6.26,0-11.34-5.08-11.34-11.34s5.08-11.34,11.34-11.34h57.82 c6.26,0,11.34,5.08,11.34,11.34S2001.8,796.87,1995.54,796.87z"/><path fill="#2AD8FF" d="M2420.21,1351.48c-20.88,0-41.89-3.86-62.74-11.54c-26.3-9.69-50.25-24.92-71.18-45.27l-106.05-103.06 l-106.14,102.08c-42.21,40.6-99.11,60.48-156.12,54.55c-37.24-3.87-71.06-18.04-97.81-40.97c-62.45-53.54-60.97-133.61-60.88-137 c1.65-59.37,34.98-115.4,86.98-146.21c43.23-25.61,97.1-31.28,147.81-15.54c29.11,9.03,56.52,25.5,79.29,47.62l106.95,103.93 l109.47-105.28c14.69-14.13,31.05-25.69,48.62-34.37c28.64-14.15,73.59-28.37,125.08-15.8c37.07,9.05,71.41,30.39,96.7,60.09 c27.05,31.77,41.44,69.79,41.61,109.93c0.18,43.03-16.83,84.77-47.87,117.52c-28.52,30.09-67.58,50.95-107.16,57.23 C2437.96,1350.78,2429.09,1351.48,2420.21,1351.48z M2196.59,1175.88l105.5,102.52c18.65,18.12,39.92,31.67,63.22,40.26 c26.03,9.6,52.24,12.4,77.9,8.33c67.07-10.64,136.24-70.5,135.91-152.26c-0.32-77.9-61.11-133.46-121.01-148.08 c-44.87-10.95-84.4,1.62-109.66,14.1c-15.48,7.65-29.93,17.87-42.94,30.38L2196.59,1175.88z M1936.82,1022.44 c-28.07,0-55.38,7.14-78.98,21.13c-45.37,26.88-74.44,75.67-75.88,127.33c-0.08,2.94-1.36,72.57,52.97,119.15 c23.24,19.92,52.76,32.24,85.4,35.64c50.35,5.23,100.67-12.39,138.06-48.34l105.58-101.55l-106.4-103.4 c-20.21-19.64-44.49-34.24-70.2-42.22C1970.68,1024.99,1953.61,1022.44,1936.82,1022.44z"/></svg><span class="tag">Revendedores</span></div>
  <div id="auth"></div>
  <div id="app" class="hide"></div>
</div>
<script>
(function(){
  var TKEY='rev_token';
  var token=localStorage.getItem(TKEY)||'';
  var me=null;
  function $(id){return document.getElementById(id);}
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function money(n){return '$'+Number(Math.round(n||0)).toLocaleString('es-AR');}
  function api(path,opts){
    opts=opts||{}; opts.headers=opts.headers||{};
    if(opts.body){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(opts.body);}
    if(token)opts.headers['Authorization']='Bearer '+token;
    return fetch(path,opts).then(function(r){return r.json().then(function(j){return {ok:r.ok,data:j};}).catch(function(){return {ok:r.ok,data:{}};});});
  }
  function showErr(m){var e=$('err');if(e){e.textContent=m;e.style.display='block';}}
  var authTab='login';
  function renderAuth(){
    $('app').className='hide'; $('auth').className='';
    var h='<div class="card">';
    h+='<div class="tabs"><button id="tlogin" class="'+(authTab==='login'?'on':'')+'">Entrar</button><button id="tsignup" class="'+(authTab==='signup'?'on':'')+'">Crear cuenta</button></div>';
    if(authTab==='signup'){
      h+='<h1 style="margin-top:14px">Crear cuenta</h1><div class="sub">Para revender carteles de Neon Infinito.</div>';
      h+='<label>Nombre / Negocio</label><input id="f_nombre" placeholder="Tu nombre o local">';
      h+='<label>Email</label><input id="f_email" type="email" placeholder="vos@email.com" autocapitalize="off" autocomplete="email">';
      h+='<label>WhatsApp</label><input id="f_wpp" type="tel" placeholder="11 2345 6789">';
      h+='<label>Contrase&ntilde;a</label><input id="f_pass" type="password" placeholder="minimo 6 caracteres" autocomplete="new-password">';
      h+='<button class="btn" id="b_signup">Crear cuenta</button>';
    } else {
      h+='<h1 style="margin-top:14px">Entrar</h1><div class="sub">Ingresa con tu email y contrase&ntilde;a.</div>';
      h+='<label>Email</label><input id="f_email" type="email" placeholder="vos@email.com" autocapitalize="off" autocomplete="email">';
      h+='<label>Contrase&ntilde;a</label><input id="f_pass" type="password" placeholder="tu contrase&ntilde;a" autocomplete="current-password">';
      h+='<button class="btn" id="b_login">Entrar</button>';
    }
    h+='<div class="err" id="err"></div></div>';
    h+='<div class="note">Precios de referencia para revendedores. La cotizacion final la confirma Neon Infinito.</div>';
    $('auth').innerHTML=h;
    $('tlogin').onclick=function(){authTab='login';renderAuth();};
    $('tsignup').onclick=function(){authTab='signup';renderAuth();};
    if($('b_signup'))$('b_signup').onclick=doSignup;
    if($('b_login'))$('b_login').onclick=doLogin;
  }
  function doSignup(){
    var nombre=$('f_nombre').value.trim(), email=$('f_email').value.trim(), wpp=$('f_wpp').value.trim(), pass=$('f_pass').value;
    if(!nombre||!email||!wpp||!pass)return showErr('Completa todos los campos.');
    if(pass.length<6)return showErr('La contrasena necesita al menos 6 caracteres.');
    var b=$('b_signup');b.disabled=true;b.textContent='Creando...';
    api('/revendedor/signup',{method:'POST',body:{nombre:nombre,email:email,whatsapp:wpp,password:pass}}).then(function(r){
      b.disabled=false;b.textContent='Crear cuenta';
      if(!r.ok||!r.data.token)return showErr(r.data.error||'No se pudo crear la cuenta.');
      token=r.data.token;localStorage.setItem(TKEY,token);me=r.data.revendedor||{nombre:nombre};enterApp();
    });
  }
  function doLogin(){
    var email=$('f_email').value.trim(), pass=$('f_pass').value;
    if(!email||!pass)return showErr('Completa email y contrasena.');
    var b=$('b_login');b.disabled=true;b.textContent='Entrando...';
    api('/revendedor/login',{method:'POST',body:{email:email,password:pass}}).then(function(r){
      b.disabled=false;b.textContent='Entrar';
      if(!r.ok||!r.data.token)return showErr(r.data.error||'Email o contrasena incorrectos.');
      token=r.data.token;localStorage.setItem(TKEY,token);me=r.data.revendedor||{};enterApp();
    });
  }
  function logout(){token='';localStorage.removeItem(TKEY);me=null;renderAuth();}
  function enterApp(){ $('auth').className='hide'; $('app').className=''; renderApp(); loadHist(); }
  function renderApp(){
    var nm=(me&&me.nombre)?me.nombre:'';
    var h='<div class="top"><div class="hi">Hola <b>'+esc(nm)+'</b></div><button class="linkb" id="b_out">Salir</button></div>';
    h+='<div class="card"><h1>Cotizador</h1><div class="sub">Carga las medidas y te muestra tu costo y a cuanto revenderlo.</div>';
    h+='<label>Nombre del dise&ntilde;o <span style="opacity:.6">(opcional)</span></label><input id="i_nombre" maxlength="60" placeholder="Ej: Logo del local">';
    h+='<div class="r"><div><label>Ancho (cm)</label><input id="i_ancho" type="number" inputmode="numeric" placeholder="50"></div><div><label>Alto (cm)</label><input id="i_alto" type="number" inputmode="numeric" placeholder="30"></div></div>';
    h+='<div class="r"><div><label>Metros de neon</label><input id="i_neon" type="number" inputmode="decimal" placeholder="3"></div><div><label>Tramos</label><input id="i_tramos" type="number" inputmode="numeric" placeholder="3"></div></div>';
    h+='<label>Tipo</label><select id="i_tipo"><option value="INT">Interior</option><option value="EXT">Exterior (resistente)</option></select>';
    h+='<button class="btn" id="b_calc">Calcular precio</button><div class="err" id="err"></div></div>';
    h+='<div id="res"></div>';
    h+='<div class="card"><h1 style="font-size:16px">Tus cotizaciones</h1><div id="hist" class="hist"><div class="note" style="margin:8px 0 0">Todavia no hiciste ninguna.</div></div></div>';
    h+='<div class="note">Tu costo = 5% menos del precio sugerido. Reventa sugerida = 25% a 35% sobre tu costo.<br>Precios de referencia; la cotizacion final la confirma Neon Infinito.</div>';
    $('app').innerHTML=h;
    $('b_out').onclick=logout;
    $('b_calc').onclick=doCalc;
  }
  function baseCard(title,sw,o){
    var h='<div class="base"><h3><span class="sw" style="background:'+sw+'"></span>'+title+'</h3>';
    h+='<div class="line big"><span class="k">Tu costo</span><span class="v">'+money(o.costo)+'</span></div>';
    h+='<div class="line"><span class="k">Reventa sugerida</span><span class="v">'+money(o.reventaMin)+' a '+money(o.reventaMax)+'</span></div>';
    h+='<div class="line win"><span class="k">Tu ganancia</span><span class="v">'+money(o.gananciaMin)+' a '+money(o.gananciaMax)+'</span></div>';
    return h+'</div>';
  }
  function doCalc(){
    var nombre=$('i_nombre')?$('i_nombre').value.trim():'';
    var ancho=+$('i_ancho').value, alto=+$('i_alto').value, neon=+$('i_neon').value, tramos=+$('i_tramos').value, tipo=$('i_tipo').value;
    if(!ancho||!alto||!neon||!tramos)return showErr('Carga ancho, alto, metros de neon y tramos.');
    var b=$('b_calc');b.disabled=true;b.textContent='Calculando...';
    api('/revendedor/cotizar',{method:'POST',body:{nombre:nombre,ancho:ancho,alto:alto,neon:neon,tramos:tramos,tipo:tipo}}).then(function(r){
      b.disabled=false;b.textContent='Calcular precio';
      if(!r.ok){ if(r.data&&r.data.error==='unauthorized')return logout(); return showErr((r.data&&r.data.error)||'No se pudo calcular.'); }
      if(!r.data||!r.data.trans)return showErr('No se pudo calcular.');
      var head=nombre?'<div class="card" style="padding:12px 16px;margin-bottom:10px"><b style="font-size:15px">'+esc(nombre)+'</b></div>':'';
      $('res').innerHTML=head+baseCard('Transparente','#cbd5e1',r.data.trans)+baseCard('Negro','#1f2937',r.data.negro);
      loadHist();
    });
  }
  function loadHist(){
    api('/revendedor/historial').then(function(r){
      if(!r.ok||!r.data||!r.data.items||!r.data.items.length)return;
      var its=r.data.items,h='';
      for(var i=0;i<its.length;i++){var it=its[i];
        var dt=new Date(it.created_at);var ds=isNaN(dt.getTime())?'':dt.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'});
        var sp=Math.round(it.ancho)+'x'+Math.round(it.alto)+' cm - '+it.neon+'m'+(it.tipo==='EXT'?' - ext':'');
        var nm=(it.nombre&&String(it.nombre).trim())?String(it.nombre):'';
        var title=nm||sp; var sub=nm?(sp+' - '+ds):ds;
        h+='<div class="it"><div><div class="sp">'+esc(title)+'</div><div class="d">'+esc(sub)+'</div></div><div class="pr"><div class="c">'+money(it.costo)+'</div><div class="d">rev '+money(it.reventa_min)+' a '+money(it.reventa_max)+'</div></div></div>';
      }
      $('hist').innerHTML=h;
    });
  }
  if(token){ api('/revendedor/me').then(function(r){ if(r.ok&&r.data&&r.data.id){me=r.data;enterApp();} else {token='';localStorage.removeItem(TKEY);renderAuth();} }); }
  else renderAuth();
})();
</script>
</body>
</html>`;

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

// ===== Pedidos: migración del Excel de Ventas (hoja 2026) a D1 =====
// D1 pasa a ser la fuente de verdad; el Excel queda como espejo (fase posterior).
async function ensurePedidosSchema(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pedidos (id INTEGER PRIMARY KEY AUTOINCREMENT, numero INTEGER, fecha TEXT, cartel TEXT, colores TEXT, alto REAL, ancho REAL, cm_neon REAL, base TEXT, cantidad REAL, precio REAL, dimer TEXT, precio_dimmer REAL, envio TEXT, aclaracion TEXT, productor TEXT, plataforma TEXT, estado_pago TEXT, pagado REAL, restante REAL, estado_pedido TEXT, ad TEXT, telefono TEXT, tramos REAL, tipo TEXT, sheet_row INTEGER, origen TEXT NOT NULL DEFAULT 'backfill', mirror_dirty INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT)`).run();
  // Columnas agregadas después de crear la tabla en prod: red de seguridad del espejo.
  // mirror_attempts = intentos fallidos; mirror_error = motivo del último fallo (ej.
  // valor que infringe la validación de datos del Excel). El ALTER tira si ya existen.
  for (const col of ['mirror_attempts INTEGER NOT NULL DEFAULT 0', 'mirror_error TEXT']) {
    try { await env.DB.prepare(`ALTER TABLE pedidos ADD COLUMN ${col}`).run(); } catch (_) {}
  }
}
// Número de precio → entero. Los precios de NI son SIEMPRE enteros en pesos (sin
// centavos). Google CSV puede mandar "149500", "149.500", "149,500", "$149.500",
// "1,110,000", "149500.00", etc. Misma lógica que parseNum() del front: saca el
// decimal final (.0 / ,00) y después TODO lo no-dígito. null si queda vacío.
function pedidoNum(s) {
  if (s == null || s === '') return null;
  let str = String(s).trim();
  if (!str || str === '-') return null;
  const sign = str.startsWith('-') ? -1 : 1;
  str = str.replace(/[.,]\d{1,2}$/, '').replace(/[^\d]/g, '');
  if (!str) return null;
  const n = parseInt(str, 10);
  return isNaN(n) ? null : sign * n;
}
// Fecha "DD/M/YYYY" (o "DD/M/YY") → ISO "YYYY-MM-DD"; null si no parsea.
function pedidoFecha(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let y = m[3]; if (y.length === 2) y = '20' + y;
  return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}
// Sincroniza SOLO el campo `productor` desde el Excel de Ventas hacia D1 (Gaspar
// lo completa en el Excel, no en el CRM). Matchea por sheet_row (posición en el
// Excel) y solo toca filas origen='backfill' → NO pisa ediciones del CRM ni los
// pedidos nuevos (origen='crm', sheet_row NULL). Devuelve cuántas filas cambiaron.
async function syncProductoresFromVentas(env) {
  try {
    const VENTAS_SID = '1qKUhSDDjBV4k8W0goPhOFzEhLz0Zeruq2slLpb9bWSg';
    const u = `https://docs.google.com/spreadsheets/d/${VENTAS_SID}/gviz/tq?tqx=out:csv&sheet=2026`;
    const r = await fetch(u);
    if (!r.ok) return 0;
    const rows = parseCsv(await r.text());
    const now = new Date().toISOString();
    const stmts = [];
    for (let i = 1; i < rows.length; i++) {
      const prod = String((rows[i] && rows[i][14]) || '').trim();
      if (!prod) continue; // no borramos un productor existente con vacíos del Excel
      stmts.push(env.DB.prepare("UPDATE pedidos SET productor = ?, updated_at = ? WHERE sheet_row = ? AND origen = 'backfill' AND IFNULL(productor,'') != ?").bind(prod, now, i + 1, prod));
    }
    let changed = 0;
    const CHUNK = 50;
    for (let j = 0; j < stmts.length; j += CHUNK) {
      const res = await env.DB.batch(stmts.slice(j, j + CHUNK));
      for (const rr of res) changed += (rr.meta && rr.meta.changes) || 0;
    }
    return changed;
  } catch (e) { return 0; }
}
// Sync Excel → CRM: importa a D1 los pedidos NUEVOS cargados a mano en el Excel
// (filas con cartel + fecha válida cuyo sheet_row todavía no está en D1). Es la
// contraparte del espejo (CRM → Excel). Los inserta con origen='excel' y
// mirror_dirty=0 (NO se re-empujan al Excel). Matchea por sheet_row → asume que el
// Excel crece agregando filas al final (que es como se carga). Devuelve cuántos importó.
async function importNewPedidosFromVentas(env) {
  try {
    const VENTAS_SID = '1qKUhSDDjBV4k8W0goPhOFzEhLz0Zeruq2slLpb9bWSg';
    const u = `https://docs.google.com/spreadsheets/d/${VENTAS_SID}/gviz/tq?tqx=out:csv&sheet=2026`;
    const r = await fetch(u);
    if (!r.ok) return 0;
    const rows = parseCsv(await r.text());
    if (rows.length < 2) return 0;
    const have = new Set();
    const rs = await env.DB.prepare('SELECT sheet_row FROM pedidos WHERE sheet_row IS NOT NULL').all();
    for (const x of (rs.results || [])) have.add(Number(x.sheet_row));
    const now = new Date().toISOString();
    const stmts = [];
    for (let i = 1; i < rows.length; i++) {
      const sheetRow = i + 1;
      if (have.has(sheetRow)) continue;                 // ya está en D1
      const c = rows[i];
      if (!c || !String(c[2] || '').trim()) continue;   // necesita cartel
      const fecha = pedidoFecha(c[0]);
      if (!fecha) continue;                             // necesita fecha válida
      stmts.push(env.DB.prepare(
        `INSERT INTO pedidos (numero, fecha, cartel, colores, alto, ancho, cm_neon, base, cantidad, precio, dimer, precio_dimmer, envio, aclaracion, productor, plataforma, estado_pago, pagado, restante, estado_pedido, ad, sheet_row, origen, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'excel', ?, ?)`
      ).bind(
        pedidoNum(c[1]), fecha, String(c[2] || '').trim(), String(c[3] || '').trim(),
        pedidoNum(c[4]), pedidoNum(c[5]), pedidoNum(c[6]), String(c[7] || '').trim(),
        pedidoNum(c[8]) || 1, pedidoNum(c[9]), String(c[10] || '').trim(), pedidoNum(c[11]),
        String(c[12] || '').trim(), String(c[13] || '').trim(), String(c[14] || '').trim(), String(c[15] || '').trim(),
        String(c[16] || '').trim(), pedidoNum(c[17]), pedidoNum(c[18]), String(c[19] || '').trim(),
        String(c[20] || '').trim(), sheetRow, now, now
      ));
    }
    if (!stmts.length) return 0;
    const CHUNK = 50;
    for (let j = 0; j < stmts.length; j += CHUNK) {
      await env.DB.batch(stmts.slice(j, j + CHUNK));
    }
    return stmts.length;
  } catch (e) { return 0; }
}
// ISO "YYYY-MM-DD" → "D/M/YYYY" (formato del Excel de Ventas).
function pedidoFechaToExcel(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso || '';
  return `${parseInt(m[3], 10)}/${parseInt(m[2], 10)}/${m[1]}`;
}
// POST robusto al Apps Script. El Web App responde un 302 a una URL googleusercontent
// que entrega el resultado del doPost por GET. Cloudflare, al seguir el redirect sobre
// un POST con redirect:'follow', puede perder el body → el doPost no corre. Por eso lo
// seguimos a mano: POST con redirect:'manual' y, si hay 3xx, GET al Location. Devuelve
// el JSON parseado, o null si falla.
async function appsScriptPost(env, payload) {
  if (!env.APPS_SCRIPT_URL) return { error: 'no APPS_SCRIPT_URL' };
  let r = await fetch(env.APPS_SCRIPT_URL, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (r.status >= 300 && r.status < 400) {
    const loc = r.headers.get('location');
    if (loc) r = await fetch(loc, { method: 'GET', redirect: 'follow' });
  }
  const text = await r.text();
  try { return JSON.parse(text); }
  catch (_) {
    // Apps Script devuelve HTML cuando el doPost tira un error no atrapado (típico:
    // una celda que infringe la validación de datos del Excel). Sacamos el mensaje.
    const m = text.match(/monospace[^>]*>([^<]+)</) || text.match(/errorMessage[^>]*>([^<]+)</);
    return { error: (m ? m[1] : 'respuesta no-JSON del Apps Script').trim().slice(0, 280) };
  }
}
// Empuja UNA fila de pedido al Excel de Ventas vía el Apps Script (action=
// pedido_upsert). Con sheet_row → actualiza; sin él → agrega y devuelve el nuevo
// nro de fila. La columna Productor (O) NO se toca (la maneja Gaspar en el Excel).
async function pushPedidoToVentas(env, row) {
  if (!env.APPS_SCRIPT_URL) return { error: 'no APPS_SCRIPT_URL' };
  const arr = [
    pedidoFechaToExcel(row.fecha), row.numero ?? '', row.cartel || '', row.colores || '',
    row.alto ?? '', row.ancho ?? '', row.cm_neon ?? '', row.base || '',
    row.cantidad ?? '', row.precio ?? '', row.dimer || '', row.precio_dimmer ?? '',
    row.envio || '', row.aclaracion || '', '', // O = Productor (placeholder, se respeta)
    row.plataforma || '', row.estado_pago || '', row.pagado ?? '', row.restante ?? '',
    row.estado_pedido || '', row.ad || ''
  ];
  try {
    const j = await appsScriptPost(env, { action: 'pedido_upsert', sheet_row: row.sheet_row || 0, row: arr });
    if (j && j.ok && j.row) return { row: Number(j.row) };
    return { error: (j && j.error) ? String(j.error) : 'el Apps Script no devolvió row' };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}
// Cron: replica al Excel los pedidos marcados mirror_dirty=1 (creados/editados en
// el CRM). GATEADO por el flag kv 'pedidos_mirror_on' (se prende DESPUÉS de
// deployar el Apps Script, para no pushear contra el viejo). El clear es condicional
// por updated_at para no perder ediciones concurrentes.
async function processPedidosMirror(env) {
  if (!env.APPS_SCRIPT_URL) return { skipped: 'no_url' };
  try {
    const flag = await env.DB.prepare("SELECT v FROM kv_cache WHERE k = 'pedidos_mirror_on'").first();
    if (!flag || flag.v !== '1') return { skipped: 'flag_off' };
    const rs = await env.DB.prepare('SELECT * FROM pedidos WHERE mirror_dirty = 1 ORDER BY id LIMIT 8').all();
    const rows = rs.results || [];
    let pushed = 0, failed = 0;
    for (const row of rows) {
      const res = await pushPedidoToVentas(env, row);
      if (res && res.row) {
        await env.DB.prepare('UPDATE pedidos SET mirror_dirty = 0, mirror_attempts = 0, mirror_error = NULL, sheet_row = ? WHERE id = ? AND updated_at = ?').bind(res.row, row.id, row.updated_at).run();
        pushed++;
      } else {
        // Red de seguridad: tras 5 intentos deja de reintentar (dirty=0) y guarda el
        // error para que se vea en el CRM. Evita el loop infinito ante un valor rechazado.
        const att = (Number(row.mirror_attempts) || 0) + 1;
        const err = (res && res.error) ? String(res.error) : 'fallo desconocido';
        await env.DB.prepare('UPDATE pedidos SET mirror_attempts = ?, mirror_error = ?, mirror_dirty = ? WHERE id = ? AND updated_at = ?').bind(att, err, att >= 5 ? 0 : 1, row.id, row.updated_at).run();
        failed++;
      }
    }
    return { checked: rows.length, pushed, failed };
  } catch (e) { return { error: String((e && e.message) || e) }; }
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

// Sheet del lanzamiento de JUNIO 2026 (form acumulativo desde 2025). Para el
// broadcast SOLO tomamos los anotados el 9 y 10 de junio 2026 (los del lanzamiento).
// Col 0 = Marca temporal (D/M/YYYY ...), col 1 = Nombre, col 2 = teléfono.
const JUNIO_SHEET_CSV = 'https://docs.google.com/spreadsheets/d/11Hg9nmiCPPBACas_14uOnV1k4npE_zN7uX6xilHb4RE/export?format=csv';
const JUNIO_COL_TS = 0, JUNIO_COL_NOMBRE = 1, JUNIO_COL_TELEFONO = 2;

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

// Lee el sheet del lanzamiento de junio y devuelve SOLO los anotados el 9 y 10
// de junio 2026 (los del lanzamiento), parseados + normalizados. El form es
// acumulativo desde 2025, por eso el filtro de fecha por la Marca temporal.
async function fetchJunioLeads(env) {
  const r = await fetch(JUNIO_SHEET_CSV, { redirect: 'follow' });
  if (!r.ok) throw new Error('sheet HTTP ' + r.status);
  const rows = parseCSV(await r.text());
  const seen = new Set();
  const leads = [];
  for (let i = 1; i < rows.length; i++) {
    const ts = String(rows[i][JUNIO_COL_TS] || '').trim();
    const p = (ts.split(/\s+/)[0] || '').split('/'); // D/M/YYYY
    if (p.length !== 3) continue;
    const day = parseInt(p[0], 10), mon = parseInt(p[1], 10), yr = parseInt(p[2], 10);
    if (!((day === 9 || day === 10) && mon === 6 && yr === 2026)) continue; // solo 9 y 10 jun 2026
    const nombre = String(rows[i][JUNIO_COL_NOMBRE] || '').trim();
    const telRaw = String(rows[i][JUNIO_COL_TELEFONO] || '').trim();
    if (!nombre && !telRaw) continue;
    const tel = normalizeArPhone(telRaw) || '';
    const valido = !!tel && tel.length >= 10;
    if (valido) { if (seen.has(tel)) continue; seen.add(tel); }
    leads.push({ nombre, telRaw, tel, valido });
  }
  return { total: leads.length, leads };
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
  const _body = JSON.stringify(payload);
  const _doSend = async () => {
    const rr = await fetch(wa.messagesUrl(), {
      method: 'POST',
      headers: { ...wa.headers, 'Content-Type': 'application/json' },
      body: _body
    });
    const dd = await rr.json().catch(() => ({}));
    return { r: rr, data: dd };
  };
  let { r, data } = await _doSend();
  // Reintento del error transitorio #131000 de Meta ("Something went wrong"): el mensaje NO
  // salió (falló), Meta mismo recomienda reintentar, así que NO se duplica. Sin esto, a la gente
  // (ej. Abril) le aparecía "Error: (#131000)" en la cara por un glitch pasajero de Meta.
  if (!r.ok && (data?.error?.code === 131000 || data?.error?.code === 131016)) {
    await new Promise(res => setTimeout(res, 800));
    ({ r, data } = await _doSend());
  }
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
    return { ok: false, status: r.status, code: data?.error?.code ?? null, error: data?.error?.message || 'wa send failed', raw: data, provider: wa.provider };
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

// ===== Clasificación de fallos de envío + reintento con tope (follow-ups) =====
// Usado por TODOS los crons de follow-up para tratar igual los errores: los
// transitorios (glitch de Meta, rate-limit) se reintentan hasta SEND_FAIL_CAP
// veces; los permanentes (ventana cerrada, número muerto, cuenta bloqueada) se
// dan por perdidos enseguida. El contador vive en kv_cache (sin schema nuevo).
const SEND_FAIL_CAP = 3;

// ¿El error conviene reintentarlo? Permanentes → false. Resto (incluido el
// genérico "wa send failed" y el #131000 "Something went wrong") → true.
function isTransientSendError(res) {
  const code = res && res.code;
  const msg = String((res && res.error) || '').toLowerCase();
  if (code === 131047 || code === 131051) return false; // fuera de ventana 24h
  if (code === 131026 || code === 131049) return false; // destinatario no alcanzable
  if (code === 131042) return false;                     // cuenta bloqueada por pago
  if (/re-?engag|outside|more than 24|undeliverable|ecosystem|eligibilit|payment/.test(msg)) return false;
  return true;
}

// Motivo legible del fallo, para el aviso al admin (en vez del genérico fijo).
function describeSendFailure(res) {
  const code = res && res.code;
  const msg = String((res && res.error) || '');
  if (code === 131047 || code === 131051 || /re-?engag|outside|more than 24|window/i.test(msg)) return 'ventana de 24h cerrada (el cliente no escribió hace +24h)';
  if (code === 131042 || /eligibilit|payment/i.test(msg)) return 'cuenta bloqueada por pago — revisá saldo en 360dialog';
  if (code === 131026 || code === 131049 || /undeliverable|ecosystem/i.test(msg)) return 'número no alcanzable (sin WhatsApp / bloqueado)';
  if (code === 131000 || /something went wrong/i.test(msg)) return 'error transitorio de Meta (#131000)';
  if (code === 131048 || code === 131056 || /rate/i.test(msg)) return 'límite de envío momentáneo de Meta';
  return (msg || 'error desconocido') + (code ? ' (#' + code + ')' : '');
}

// Contador de fallos consecutivos por (kind:phone) en kv_cache. bump devuelve el
// nuevo total; clear lo borra (llamar al enviar OK). Tope = SEND_FAIL_CAP.
async function bumpSendFail(env, key) {
  let n = 0;
  try {
    const row = await env.DB.prepare('SELECT v FROM kv_cache WHERE k = ?').bind('sfail:' + key).first();
    n = row ? (parseInt(row.v, 10) || 0) : 0;
  } catch (_) {}
  n += 1;
  try { await env.DB.prepare('INSERT INTO kv_cache (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at').bind('sfail:' + key, String(n), new Date().toISOString()).run(); } catch (_) {}
  return n;
}
async function clearSendFail(env, key) {
  try { await env.DB.prepare('DELETE FROM kv_cache WHERE k = ?').bind('sfail:' + key).run(); } catch (_) {}
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

// ============================================================
// PILOTO DE PRE COTIZACIÓN automática (carteles) — ver migración 031.
// Automatiza SOLO la pre cotización (apertura + relevamiento hasta juntar los 3
// datos: foto + medidas + interior/exterior) para ~20% de los leads nuevos, con
// tope de 10. Bot con freno de mano; los chats van a inbox='precotiz' (solo
// Gaspar los ve) hasta completar. ON/OFF y modo (draft/auto) viven en kv_cache.
// ============================================================
const PRECOTIZ_CAP = 10;                       // tope de leads en el piloto
const PRECOTIZ_DEBOUNCE_MS = 60 * 1000;        // esperar a que el cliente pare de escribir (manda foto + medidas en mensajes seguidos) antes de armar la respuesta
const PRECOTIZ_GASPAR_PHONE = '5491155604999'; // a quién avisar al completar

// kv_cache como settings store (genérico, idempotente).
async function kvGet(env, k, def = null) {
  try { const r = await env.DB.prepare('SELECT v FROM kv_cache WHERE k = ?').bind(k).first(); return r ? r.v : def; }
  catch (_) { return def; }
}
async function kvSet(env, k, v) {
  try { await env.DB.prepare('INSERT INTO kv_cache (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at').bind(k, String(v), new Date().toISOString()).run(); }
  catch (_) {}
}

// ¿Piloto prendido? Default OFF (kill-switch): arranca apagado hasta estar
// deployado y probado. Gaspar lo prende con kv 'precotiz_on'='1'.
async function precotizOn(env) { return (await kvGet(env, 'precotiz_on', '0')) === '1'; }
// Modo: 'auto' (auto-envío) | 'draft' (Gaspar aprueba los mensajitos). Default draft.
async function precotizModo(env) { return (await kvGet(env, 'precotiz_modo', 'draft')) === 'auto' ? 'auto' : 'draft'; }

// Selección determinística ~20% por número: un mismo cliente cae siempre del
// mismo lado (no random por mensaje). Hash simple sobre los dígitos del teléfono.
function precotizPicks(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 8) return false;
  let h = 0;
  for (let i = 0; i < d.length; i++) h = (h * 31 + d.charCodeAt(i)) >>> 0;
  return h % 5 === 0; // 1 de cada 5 ≈ 20%
}

// Horario hábil del piloto: 8:00–22:00 AR (UTC-3) — los clientes escriben tarde.
function precotizEnHorario(d = new Date()) {
  const ar = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  const h = ar.getUTCHours();
  return h >= 8 && h < 22;
}

async function precotizGet(env, phone) {
  try { return await env.DB.prepare('SELECT * FROM precotiz_pilot WHERE phone = ?').bind(phone).first(); }
  catch (_) { return null; }
}
async function precotizCount(env) {
  try { const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM precotiz_pilot').first(); return r ? (r.n || 0) : 0; }
  catch (_) { return 0; }
}

// Envía un mensaje del bot Y lo persiste en wa_messages (waSend no guarda solo).
// automated=1 para distinguir lo que mandó el piloto. Aparece en el chat del CRM.
async function precotizSend(env, phone, body) {
  const r = await waSendText(env, phone, body);
  if (r && r.ok) {
    try {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id, automated)
         VALUES (?, ?, 'outbound', ?, '', 'text', ?, 'sent', '', 1)`
      ).bind(new Date().toISOString(), r.id || ('precotiz:' + phone + ':' + Date.now()), phone, String(body || '')).run();
    } catch (_) {}
  }
  return r;
}

async function precotizNotifyGaspar(env, msg) {
  try { await waSendText(env, PRECOTIZ_GASPAR_PHONE, msg); } catch (_) {}
}

// Mueve el chat de bandeja (reusa wa_chats_summary.inbox, mig. 012):
// 'precotiz' = solo Gaspar lo ve; 'general' = vuelve a la bandeja de Joaco.
async function precotizSetInbox(env, phone, inbox) {
  try { await env.DB.prepare('UPDATE wa_chats_summary SET inbox = ? WHERE phone = ?').bind(inbox, phone).run(); } catch (_) {}
}

// Una sola llamada IA por lead: clasifica si es carteles, detecta cuáles de los
// 3 datos ya están, decide si frenar, y si falta algo redacta los mensajitos.
const PRECOTIZ_LLM_SYSTEM = `Sos parte del equipo de ventas de Neon Infinito (carteles de neón LED, Argentina). Manejás SOLO la PRE COTIZACIÓN de un lead: la etapa de relevamiento donde hay que juntar 3 datos para poder cotizar un cartel:
1) una FOTO o imagen de referencia del diseño,
2) las MEDIDAS aproximadas (alto y ancho),
3) si es para INTERIOR o EXTERIOR.

Si te paso imágenes, MIRALAS bien. Una imagen cuenta como la foto del diseño (tiene_foto=true) SOLO si es un boceto, logo, foto o referencia del cartel/diseño que el cliente quiere. Si la imagen es un meme, una captura de otra app, un tweet, una promo, spam, o cualquier cosa que no tenga que ver con un cartel → tiene_foto=false (y si es spam o estafa, frenar=true y es_carteles=false).

Te paso la conversación de WhatsApp (CLIENTE = el lead, JOACO = nosotros/el bot). Mirá qué de los 3 datos ya dio el cliente y, si corresponde, escribí el/los próximos mensajes para pedir SOLO lo que falta.

ESTILO DE LOS MENSAJES (clave, para parecer humano y no un bot):
- Súper natural, tono argentino informal de WhatsApp.
- SIN emojis.
- SIN signos de apertura (nunca ¿ ni ¡). El cierre de pregunta ? va siempre; el de exclamación ! solo a veces.
- Varios mensajes CORTOS y separados, MÁXIMO 4 (idealmente 2-3). NUNCA mandes un mensaje por cada dato.
- NUNCA uses la palabra "cositas".
- SIEMPRE cerrá con una PREGUNTA, para darle pie al cliente a responder.
- Si es el primer mensaje nuestro, presentate ("buenas, te habla Joaco de neon infinito").

FORMATO PARA PEDIR LOS DATOS QUE FALTAN: un mensaje con la lista (cada dato en su propio renglón, arrancando con un guion "- "), y DESPUÉS un mensaje APARTE preguntando si los tiene. Ejemplo de primer contacto (3 mensajes):
[1] buenas, te habla Joaco de neon infinito
[2] para cotizarte necesito lo siguiente:
- una foto o referencia del diseño
- las medidas aprox (alto y ancho)
- si es para interior o exterior
[3] tenes esa info para pasarme?
La lista [2] es UN SOLO mensaje aunque tenga varios renglones (los renglones van separados por saltos de linea simples dentro del mismo mensaje). Si el cliente YA dio algún dato, sacalo de la lista y pedí solo lo que falta; si falta uno solo, pedilo en una frase corta sin lista. Igual, cerrá siempre con una pregunta.

FRENO DE MANO — poné frenar=true y mensajes=[] si:
- es B2B / varios locales / franquicia,
- hay objeción fuerte de precio o pedido de financiación,
- es una queja o cliente enojado,
- pide algo fuera del relevamiento simple (factura, garantía, instalación compleja),
- es SPAM, una cadena, una promo de cripto / casino / inversión, un link sospechoso, o cualquier cosa que claramente NO tiene que ver con pedir un cartel → frenar=true y es_carteles=false (NO le respondas),
- o no parece un lead de carteles (curso, o ambiguo) → además es_carteles=false.

Si ya están los 3 datos, mensajes=[] (el humano sigue desde acá). Nunca prometas el render/precio: eso lo hace una persona después.

Devolvé SOLO un JSON, sin nada alrededor:
{"es_carteles":bool,"frenar":bool,"motivo_freno":"string corto","tiene_foto":bool,"tiene_medidas":bool,"tiene_intext":bool,"mensajes":["..."]}`;

// Arma bloques de imagen (base64) de las últimas imágenes inbound del lead, para
// que el clasificador las VEA (Claude visión) — así distingue una foto de diseño
// real de un spam/captura random. Reusa el formato de analyzePaymentProof.
async function precotizImageBlocks(env, phone, max = 2) {
  if (!env.MEDIA) return [];
  let rows = [];
  try {
    const rs = await env.DB.prepare("SELECT media_url FROM wa_messages WHERE phone = ? AND direction = 'inbound' AND msg_type = 'image' AND media_url != '' ORDER BY ts DESC LIMIT ?").bind(phone, max).all();
    rows = rs.results || [];
  } catch (_) { return []; }
  const blocks = [];
  for (const r of rows) {
    try {
      const obj = await env.MEDIA.get(r.media_url);
      if (!obj) continue;
      const buf = await obj.arrayBuffer();
      if (!buf || buf.byteLength < 64 || buf.byteLength > 4 * 1024 * 1024) continue; // vacía o >4MB
      let mime = String(obj.httpMetadata?.contentType || 'image/jpeg').split(';')[0].trim().toLowerCase();
      if (mime === 'image/jpg') mime = 'image/jpeg';
      if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) continue;
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data: abToBase64(buf) } });
    } catch (_) {}
  }
  return blocks;
}

// Extrae el PRIMER objeto JSON balanceado de un texto (el modelo a veces agrega
// un análisis en markdown después del JSON, lo que rompía JSON.parse del todo).
function extractFirstJson(text) {
  let t = String(text || '').replace(/^```(?:json)?\s*/i, '');
  const start = t.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return t.slice(start, i + 1); }
  }
  return null;
}

// Devuelve { ok, data, error, status, raw }. Reintenta 1 vez ante saturación
// (429/529) o error de red. data = el JSON parseado del modelo.
async function precotizLlm(env, fullText, fwText, imageBlocks) {
  if (!env.ANTHROPIC_API_KEY) return { ok: false, error: 'sin ANTHROPIC_API_KEY' };
  const userContent = (Array.isArray(imageBlocks) && imageBlocks.length)
    ? [...imageBlocks, { type: 'text', text: fullText }]
    : fullText;
  const payload = {
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    system: [
      { type: 'text', text: PRECOTIZ_LLM_SYSTEM },
      { type: 'text', text: '## PLAYBOOK (referencia de tono y criterio)\n\n' + (fwText || ''), cache_control: { type: 'ephemeral' } }
    ],
    messages: [{ role: 'user', content: userContent }]
  };
  for (let intento = 0; intento < 2; intento++) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if ((r.status === 429 || r.status === 529) && intento === 0) { await new Promise(s => setTimeout(s, 1500)); continue; }
        return { ok: false, error: (j && j.error && j.error.message) || ('HTTP ' + r.status), status: r.status };
      }
      const text = j.content?.[0]?.text || '';
      const jsonStr = extractFirstJson(text);
      if (!jsonStr) return { ok: false, error: 'sin JSON en la respuesta', raw: text.slice(0, 600) };
      try { return { ok: true, data: JSON.parse(jsonStr) }; }
      catch (e) { return { ok: false, error: 'JSON parse', raw: text.slice(0, 600) }; }
    } catch (e) {
      if (intento === 0) { await new Promise(s => setTimeout(s, 1500)); continue; }
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  return { ok: false, error: 'sin respuesta' };
}

// Manda (auto) o deja en borrador (draft) los mensajitos que generó la IA.
async function precotizEmitir(env, phone, nombre, msgs, modo, nowIso) {
  if (modo === 'auto') {
    for (const m of msgs) { await precotizSend(env, phone, m); await new Promise(r => setTimeout(r, 1200)); }
    return { sent: true };
  }
  // draft: guardar para que Gaspar apruebe desde el CRM; NO enviar.
  try { await env.DB.prepare('UPDATE precotiz_pilot SET pending_draft = ?, draft_ts = ?, updated_at = ? WHERE phone = ?').bind(JSON.stringify(msgs), nowIso, nowIso, phone).run(); } catch (_) {}
  await precotizNotifyGaspar(env, `hay un borrador para aprobar en la pre cotizacion de ${nombre || phone}\nentra al crm a revisarlo`);
  return { sent: false };
}

// Motor del piloto. Corre en el cron de 1 min. Gateado por kill-switch (OFF por
// defecto) + horario 8-22 AR + bloqueo de billing de WA.
async function processPrecotizPilot(env) {
  if (!(await precotizOn(env))) return;
  if (!precotizEnHorario()) return;
  if (await isWaBillingBlocked(env)) return;

  const modo = await precotizModo(env);
  const nowIso = new Date().toISOString();

  // ---- B) Procesar leads ACTIVOS con un inbound nuevo sin responder ----
  let activos = [];
  try { const rs = await env.DB.prepare("SELECT * FROM precotiz_pilot WHERE estado = 'activo'").all(); activos = rs.results || []; } catch (_) {}
  for (const lead of activos) {
    let lastIn;
    try { lastIn = await env.DB.prepare("SELECT MAX(ts) AS t FROM wa_messages WHERE phone = ? AND direction = 'inbound' AND msg_type != 'status'").bind(lead.phone).first(); } catch (_) { continue; }
    const lastInTs = lastIn?.t || '';
    if (!lastInTs) continue;
    // Debounce: el cliente manda foto + medidas en varios mensajes seguidos. No
    // respondemos apresurado — esperamos a que el último inbound tenga > DEBOUNCE
    // de antigüedad (que haya parado de escribir).
    if (Date.now() - new Date(lastInTs).getTime() < PRECOTIZ_DEBOUNCE_MS) continue;
    if (lead.pending_draft) {
      // Hay un borrador esperando tu OK. Si el cliente NO mandó nada nuevo desde
      // que se generó, lo dejamos quieto. Si mandó algo después (ej. las medidas),
      // el borrador quedó viejo → seguimos y lo RE-GENERAMOS con la info al día.
      if (lead.draft_ts && lastInTs <= lead.draft_ts) continue;
    } else if (lead.last_processed_ts && lastInTs <= lead.last_processed_ts) {
      continue; // sin draft y sin nada nuevo
    }

    const ctx = await buildChatContext(env, lead.phone, 40);
    if (!ctx) continue;
    const fw = await getActiveFramework(env);
    const imgs = await precotizImageBlocks(env, lead.phone);
    const out = await precotizLlm(env, ctx.fullText, fw?.content || '', imgs);
    if (!out.ok) continue;
    const res = out.data;

    const tF = res.tiene_foto ? 1 : 0; // la IA VE la imagen y decide si es la foto del diseño
    const tM = res.tiene_medidas ? 1 : 0, tI = res.tiene_intext ? 1 : 0;

    if (res.frenar || res.es_carteles === false) {
      try { await env.DB.prepare("UPDATE precotiz_pilot SET estado='escalado', escalado_motivo=?, tiene_foto=?, tiene_medidas=?, tiene_intext=?, last_processed_ts=?, updated_at=? WHERE phone=?").bind(String(res.motivo_freno || (res.es_carteles === false ? 'no es carteles' : 'fuera de guion')).slice(0, 200), tF, tM, tI, lastInTs, nowIso, lead.phone).run(); } catch (_) {}
      await precotizNotifyGaspar(env, `freno de mano en la pre cotizacion de ${lead.nombre || lead.phone}\nmotivo: ${res.motivo_freno || 'revisar'}\nentra a verlo vos`);
      continue;
    }
    if (tF && tM && tI) { // completó los 3 → handoff a Joaco
      try { await env.DB.prepare("UPDATE precotiz_pilot SET estado='completo', tiene_foto=1, tiene_medidas=1, tiene_intext=1, last_processed_ts=?, completed_at=?, updated_at=? WHERE phone=?").bind(lastInTs, nowIso, nowIso, lead.phone).run(); } catch (_) {}
      await precotizSetInbox(env, lead.phone, 'general');
      await precotizNotifyGaspar(env, `termino la pre cotizacion de ${lead.nombre || lead.phone}\nya tiene foto, medidas e interior/exterior\npaso a la bandeja para que lo cotice Joaco`);
      continue;
    }
    const msgs = Array.isArray(res.mensajes) ? res.mensajes.filter(m => typeof m === 'string' && m.trim()).slice(0, 4) : [];
    try { await env.DB.prepare("UPDATE precotiz_pilot SET tiene_foto=?, tiene_medidas=?, tiene_intext=?, last_processed_ts=?, updated_at=? WHERE phone=?").bind(tF, tM, tI, lastInTs, nowIso, lead.phone).run(); } catch (_) {}
    if (!msgs.length) continue;
    if (modo === 'auto') {
      await precotizEmitir(env, lead.phone, lead.nombre, msgs, 'auto', nowIso);
      try { await env.DB.prepare('UPDATE precotiz_pilot SET msgs_bot = msgs_bot + 1, updated_at = ? WHERE phone = ?').bind(nowIso, lead.phone).run(); } catch (_) {}
    } else {
      await precotizEmitir(env, lead.phone, lead.nombre, msgs, 'draft', nowIso);
    }
  }

  // ---- A) Captar leads NUEVOS de carteles (si hay cupo) ----
  if ((await precotizCount(env)) >= PRECOTIZ_CAP) return;
  let cands = [];
  try {
    const since = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const rs = await env.DB.prepare("SELECT phone, MAX(ts) AS last_ts FROM wa_messages WHERE direction='inbound' AND msg_type!='status' AND ts > ? GROUP BY phone ORDER BY last_ts DESC LIMIT 15").bind(since).all();
    cands = rs.results || [];
  } catch (_) { return; }

  for (const c of cands) {
    if ((await precotizCount(env)) >= PRECOTIZ_CAP) break;
    const phone = c.phone;
    // Solo WhatsApp Argentina (54 + 10/11 dígitos). Excluye IDs de Instagram
    // (números largos de 15-17 dígitos) y números no-AR: no son leads de
    // carteles que el bot pueda atender por este canal.
    if (!/^54\d{10,11}$/.test(phone)) continue;
    if (!precotizPicks(phone)) continue;                                   // fuera del 20%
    if (await precotizGet(env, phone)) continue;                           // ya en el piloto
    if ((await kvGet(env, 'precotiz_seen:' + phone)) === '1') continue;     // ya evaluado
    // Debounce: esperar a que el lead nuevo pare de escribir (manda hola + foto +
    // medidas en ráfaga) antes de captarlo. NO marcamos seen todavía → se re-evalúa
    // en los próximos ticks hasta que pase el silencio.
    if (Date.now() - new Date(c.last_ts).getTime() < PRECOTIZ_DEBOUNCE_MS) continue;
    await kvSet(env, 'precotiz_seen:' + phone, '1');                        // marcar visto pase lo que pase
    try { const intn = await env.DB.prepare('SELECT 1 AS x FROM wa_internal_phones WHERE phone = ?').bind(phone).first(); if (intn) continue; } catch (_) {}
    try { const ped = await env.DB.prepare('SELECT 1 AS x FROM pedidos WHERE telefono = ? LIMIT 1').bind(phone).first(); if (ped) continue; } catch (_) {} // cliente existente, no lead nuevo
    let first;
    try { first = await env.DB.prepare("SELECT MIN(ts) AS t FROM wa_messages WHERE phone = ? AND direction='inbound' AND msg_type!='status'").bind(phone).first(); } catch (_) { continue; }
    const firstTs = first?.t || '';
    if (!firstTs || firstTs < new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()) continue; // primer contacto debe ser reciente (<3h)

    const ctx = await buildChatContext(env, phone, 40);
    if (!ctx) continue;
    const fw = await getActiveFramework(env);
    const imgs = await precotizImageBlocks(env, phone);
    const out = await precotizLlm(env, ctx.fullText, fw?.content || '', imgs);
    if (!out.ok) continue;
    const res = out.data;
    if (!res || res.es_carteles === false || res.frenar) continue;          // no entra al piloto

    const tF = res.tiene_foto ? 1 : 0;
    const tM = res.tiene_medidas ? 1 : 0, tI = res.tiene_intext ? 1 : 0;
    try {
      await env.DB.prepare("INSERT OR IGNORE INTO precotiz_pilot (phone, estado, tiene_foto, tiene_medidas, tiene_intext, nombre, last_inbound_ts, last_processed_ts, created_at, updated_at) VALUES (?, 'activo', ?, ?, ?, '', ?, ?, ?, ?)").bind(phone, tF, tM, tI, c.last_ts, c.last_ts, nowIso, nowIso).run();
    } catch (_) { continue; }
    await precotizSetInbox(env, phone, 'precotiz'); // ocultar de Joaco

    if (tF && tM && tI) { // raro en el primer contacto, pero por las dudas
      try { await env.DB.prepare("UPDATE precotiz_pilot SET estado='completo', completed_at=?, updated_at=? WHERE phone=?").bind(nowIso, nowIso, phone).run(); } catch (_) {}
      await precotizSetInbox(env, phone, 'general');
      await precotizNotifyGaspar(env, `termino la pre cotizacion de ${phone} (vino con todo)\npaso a la bandeja para Joaco`);
      continue;
    }
    const msgs = Array.isArray(res.mensajes) ? res.mensajes.filter(m => typeof m === 'string' && m.trim()).slice(0, 4) : [];
    if (!msgs.length) continue;
    if (modo === 'auto') {
      await precotizEmitir(env, phone, '', msgs, 'auto', nowIso);
      try { await env.DB.prepare('UPDATE precotiz_pilot SET msgs_bot = 1, updated_at = ? WHERE phone = ?').bind(nowIso, phone).run(); } catch (_) {}
    } else {
      await precotizEmitir(env, phone, '', msgs, 'draft', nowIso);
    }
  }
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

// ===== API de Conversiones de Meta (CAPI) =====
// Manda eventos de leads al dataset de Meta para que el algoritmo optimice hacia
// leads de CALIDAD (no solo cantidad de formularios). Sirve para carteles y
// reventa (mismo dataset). El lead_id (leadgen_id de Meta) matchea el evento con
// el lead del anuncio, sin exponer datos personales. Sin token, es no-op.
const META_CAPI_DATASET = '1268253154997275';
async function metaCapiHash(s) {
  try {
    const data = new TextEncoder().encode(String(s || '').trim().toLowerCase());
    const buf = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (_) { return ''; }
}
// eventName: 'Lead' (entró) | 'QualifiedLead' (bueno) | etc. leadId = leadgen_id de Meta.
async function sendCapiEvent(env, { leadId, phone, email, eventName, eventTime, ref } = {}) {
  if (!env.META_CAPI_TOKEN) return { ok: false, error: 'no_token' };
  try {
    const user_data = {};
    if (leadId) user_data.lead_id = String(leadId);
    if (phone) { const h = await metaCapiHash(String(phone).replace(/\D/g, '')); if (h) user_data.ph = [h]; }
    if (email) { const h = await metaCapiHash(email); if (h) user_data.em = [h]; }
    if (!user_data.lead_id && !user_data.ph && !user_data.em) return { ok: false, error: 'no_identifier' };
    // custom_data con event_source='crm' + lead_event_source: Meta lo exige para que
    // el evento cuente como "CRM lead" en la optimización de Conversion Leads.
    const payload = { data: [{ event_name: eventName || 'Lead', event_time: eventTime || Math.floor(Date.now() / 1000), action_source: 'system_generated', custom_data: { event_source: 'crm', lead_event_source: 'Neon Infinito CRM' }, user_data }] };
    const url = `https://graph.facebook.com/v25.0/${META_CAPI_DATASET}/events?access_token=${env.META_CAPI_TOKEN}`;
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) { try { await env.DB.prepare('INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)').bind(new Date().toISOString(), 'CAPI_ERR ' + (ref || '') + ': ' + JSON.stringify(j).slice(0, 400)).run(); } catch (_) {} return { ok: false, error: j.error || j }; }
    return { ok: true, received: j.events_received, fbtrace: j.fbtrace_id };
  } catch (e) { return { ok: false, error: e.message }; }
}

// CAPI: cuando un lead B2B (del form de carteles) RESPONDE por WhatsApp, es señal
// de CALIDAD (lead real, no basura ni número equivocado). Manda "QualifiedLead" a
// Meta una sola vez, para que la campaña optimice hacia leads que responden.
async function maybeCapiQualifiedLead(env, phone) {
  if (!phone || !env.META_CAPI_TOKEN) return;
  try {
    const lead = await env.DB.prepare("SELECT leadgen_id FROM wa_leads WHERE phone = ? AND capi_qualified_at IS NULL AND leadgen_id IS NOT NULL ORDER BY received_at DESC LIMIT 1").bind(phone).first();
    if (!lead || !lead.leadgen_id) return;
    // Marca atómica ANTES de mandar (evita doble envío entre inbounds seguidos).
    const claim = await env.DB.prepare("UPDATE wa_leads SET capi_qualified_at = ? WHERE leadgen_id = ? AND capi_qualified_at IS NULL").bind(new Date().toISOString(), lead.leadgen_id).run();
    if (!claim?.meta?.changes) return;
    await sendCapiEvent(env, { leadId: lead.leadgen_id, phone, eventName: 'QualifiedLead', ref: 'qual:' + lead.leadgen_id });
  } catch (_) {}
}

// Avisa a Gaspar por WhatsApp UNA sola vez cuando el dataset ya juntó suficientes
// eventos QualifiedLead como para que valga cambiar la campaña a Conversion Leads.
const CAPI_READY_THRESHOLD = 15;
async function maybeCapiReadyNotice(env) {
  try {
    if (!env.META_CAPI_TOKEN) return;
    if ((await kvGet(env, 'capi_ready_notified', '0')) === '1') return;
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM wa_leads WHERE capi_qualified_at IS NOT NULL").first();
    const n = (r && r.n) || 0;
    if (n < CAPI_READY_THRESHOLD) return;
    await precotizNotifyGaspar(env, `che, ya se juntaron ${n} leads B2B que respondieron (evento QualifiedLead en el dataset de Meta). Es buen momento para cambiar la campaña de carteles a "Clientes potenciales de conversion" optimizando por QualifiedLead. Avisame y te guio con el cambio.`);
    await kvSet(env, 'capi_ready_notified', '1');
  } catch (_) {}
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

// Mensaje que se manda a los que responden POSITIVO a la plantilla del
// lanzamiento de junio 2026 (mismo criterio IA que mayo).
const JUNIO_VIVO_MSG = 'Perfectoo, acá vamos a transmitir en vivo mañana 19 hs. TODO sobre el modelo de negocio de los neones LED… y también abrimos inscripciones para la Comunidad Al Infinito 🙌🏼\nhttps://youtube.com/live/UbMdCzZhwxY?feature=share';

// Clasifica con IA la respuesta del cliente al broadcast de cursos/lanzamiento.
// El contacto YA mostró interés (se anotó al form / participó del vivo), así que
// somos GENEROSOS: el costo de NO mandarle el link a alguien interesado es alto y
// el de mandárselo a alguien tibio es bajo (es solo un link de YouTube). Ante la
// duda → positiva. Solo 'no_positiva' si es rechazo claro, hostil, spam, número
// equivocado o auto-respuesta de otro negocio. Antes esto era ESTRICTO (todo lo
// ambiguo caía en no_positiva) y se comía respuestas cortas afirmativas tipo
// "Si por favor" → no recibían el link. Si la IA no está → no_positiva (Abril lo
// maneja a mano viendo el chat revelado).
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
        system: 'A un contacto que se anotó a unas clases en vivo de carteles de neón LED se le ofreció el link para ver la próxima clase/vivo ("¿te paso el link?"). Decidí si le mandamos el link automáticamente. El contacto YA mostró interés, así que ANTE LA DUDA mandá (POSITIVA). Respondé SOLO una palabra. POSITIVA: si dice que sí de cualquier forma ("si", "dale", "si por favor", "obvio", "bueno", "ok"), pide el link, agradece con interés, hace una pregunta, o responde algo neutral o ambiguo. NEGATIVA: SOLO si rechaza claramente (dice que no, "no hace falta", "ya lo tengo", "ya lo vi", "no me interesa", "no me escriban"), insulta, es spam, número equivocado, o es una auto-respuesta automática de otro negocio.',
        messages: [{ role: 'user', content: t.slice(0, 500) }]
      })
    });
    const j = await r.json();
    if (!r.ok) return 'no_positiva';
    // Generoso: positiva por defecto, no_positiva SOLO si la IA dice NEGATIVA.
    return (j.content?.[0]?.text || '').toUpperCase().includes('NEGATIVA') ? 'no_positiva' : 'positiva';
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
            `INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id, automated)
             VALUES (?, ?, 'outbound', ?, '', 'template', ?, 'sent', '', 1)
             ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'template', automated = 1
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

// Cron (*/1): goteo del broadcast de JUNIO 2026 (lanzamiento). Misma lógica que el
// de mayo pero con la plantilla lanzamiento_junio_2026, campaign='junio' y la cola
// kind='junio_broadcast'. Manda hasta 6 por tick para terminar los ~720 a tiempo.
async function processJunioBroadcastQueue(env) {
  if (await isWaBillingBlocked(env)) return; // pausado por bloqueo de pago de WhatsApp
  try {
    const nowIso = new Date().toISOString();
    const floorIso = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const rs = await env.DB.prepare(
      "SELECT phone, sender_name FROM wa_autoreply_log " +
      "WHERE kind = 'junio_broadcast' AND status = 'queued' AND due_at <= ? AND due_at >= ? " +
      "ORDER BY due_at ASC LIMIT 6"
    ).bind(nowIso, floorIso).all();
    if (!rs.results?.length) return;
    let labelId = null;
    try { const lr = await env.DB.prepare("SELECT id FROM labels WHERE name = 'lanzamiento junio 2026'").first(); if (lr?.id) labelId = lr.id; } catch (_) {}
    for (const row of rs.results) {
      const phone = row.phone;
      const nombre = row.sender_name || '';
      let claim;
      try {
        claim = await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'sending' WHERE phone = ? AND kind = 'junio_broadcast' AND status = 'queued'").bind(phone).run();
      } catch (_) { continue; }
      if (!claim?.meta?.changes) continue;
      if (await isUnreachable(env, phone)) {
        try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'skipped', sent_at = ? WHERE phone = ? AND kind = 'junio_broadcast'").bind(new Date().toISOString(), phone).run(); } catch (_) {}
        continue;
      }
      const primerNombre = capitalizeName((nombre || '').split(/\s+/)[0]) || 'amigo/a';
      const tpl = await waSendTemplate(env, phone, 'lanzamiento_junio_2026', 'es_AR', [primerNombre]);
      if (!tpl?.ok) {
        try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'queued' WHERE phone = ? AND kind = 'junio_broadcast'").bind(phone).run(); } catch (_) {}
        continue;
      }
      const ts = new Date().toISOString();
      const wamid = tpl.id || '';
      try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'sent', sent_at = ? WHERE phone = ? AND kind = 'junio_broadcast'").bind(ts, phone).run(); } catch (_) {}
      const previewBody = `holaa ${primerNombre}! Soy Abril, de Neon Infinito\nveo que completaste el formulario que pasamos al final del vivo de ayer, y te escribo porque mañana tenemos la 2da clase!! Arrancamos sorteando los 3 kits iniciales…\nTe paso el link para ver la clase de mañana?`;
      if (wamid) {
        try {
          await env.DB.prepare(
            `INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id, automated)
             VALUES (?, ?, 'outbound', ?, '', 'template', ?, 'sent', '', 1)
             ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'template', automated = 1
               WHERE wa_messages.body IS NULL OR wa_messages.body = '' OR wa_messages.msg_type = 'status'`
          ).bind(ts, wamid, phone, previewBody).run();
        } catch (_) {}
      }
      // Ocultar el chat hasta que responda.
      try { await env.DB.prepare("INSERT INTO wa_chats_summary (phone, inbox, updated_at) VALUES (?, 'oculto', ?) ON CONFLICT(phone) DO UPDATE SET inbox = 'oculto'").bind(phone, ts).run(); } catch (_) {}
      // Registrar en la campaña con campaign='junio'.
      try { await env.DB.prepare("INSERT INTO wa_cursos_campaign (phone, nombre, sent_1_at, campaign, updated_at) VALUES (?, ?, ?, 'junio', ?) ON CONFLICT(phone) DO UPDATE SET sent_1_at = excluded.sent_1_at, campaign = 'junio', updated_at = excluded.updated_at").bind(phone, nombre, ts, ts).run(); } catch (_) {}
      if (labelId) { try { await env.DB.prepare("INSERT OR IGNORE INTO contact_labels (phone, label_id, created_at) VALUES (?, ?, ?)").bind(phone, labelId, ts).run(); } catch (_) {} }
    }
  } catch (_) { /* best-effort */ }
}

// Cron (*/1): goteo del broadcast "1 cupo · Comunidad Al Infinito" (plantilla
// cupo_comunidad_junio) a los leads del form de junio que NO pagaron. Encolado en
// wa_autoreply_log (kind='cupo_broadcast', due_at desde el 14/06 14:00 ART). Manda
// la plantilla cuando Meta la aprueba (revert-on-fail: si aún no está aprobada,
// vuelve a 'queued' y reintenta el próximo tick → arranca apenas se apruebe).
async function processCupoBroadcastQueue(env) {
  if (await isWaBillingBlocked(env)) return;
  try {
    const nowIso = new Date().toISOString();
    const floorIso = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const rs = await env.DB.prepare(
      "SELECT phone, sender_name FROM wa_autoreply_log WHERE kind = 'cupo_broadcast' AND status = 'queued' AND due_at <= ? AND due_at >= ? ORDER BY due_at ASC LIMIT 6"
    ).bind(nowIso, floorIso).all();
    if (!rs.results?.length) return;
    for (const row of rs.results) {
      const phone = row.phone;
      const nombre = row.sender_name || '';
      let claim;
      try { claim = await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'sending' WHERE phone = ? AND kind = 'cupo_broadcast' AND status = 'queued'").bind(phone).run(); } catch (_) { continue; }
      if (!claim?.meta?.changes) continue;
      if (await isUnreachable(env, phone)) {
        try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'skipped', sent_at = ? WHERE phone = ? AND kind = 'cupo_broadcast'").bind(new Date().toISOString(), phone).run(); } catch (_) {}
        continue;
      }
      const primerNombre = capitalizeName((nombre || '').split(/\s+/)[0]) || 'amigo/a';
      const tpl = await waSendTemplate(env, phone, 'cupo_comunidad_junio', 'es_AR', [primerNombre]);
      if (!tpl?.ok) {
        // Falla típica: la plantilla todavía no está aprobada por Meta → volver a 'queued' y reintentar.
        try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'queued' WHERE phone = ? AND kind = 'cupo_broadcast'").bind(phone).run(); } catch (_) {}
        continue;
      }
      const ts = new Date().toISOString();
      const wamid = tpl.id || '';
      try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'sent', sent_at = ? WHERE phone = ? AND kind = 'cupo_broadcast'").bind(ts, phone).run(); } catch (_) {}
      const previewBody = `buenass ${primerNombre}! Abril de Neon Infinito te escribe ✨\n🚨 Te comento que queda UN solo cupo para acceder a la Comunidad Al Infinito!! confirmame porfa si viste el jueves la clase 2 del evento, y estás al tanto de la propuesta (sorteo incluido!)`;
      if (wamid) {
        try {
          await env.DB.prepare(
            `INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id, automated)
             VALUES (?, ?, 'outbound', ?, '', 'template', ?, 'sent', '', 1)
             ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'template', automated = 1
               WHERE wa_messages.body IS NULL OR wa_messages.body = '' OR wa_messages.msg_type = 'status'`
          ).bind(ts, wamid, phone, previewBody).run();
        } catch (_) {}
      }
    }
  } catch (_) { /* best-effort */ }
}

// ===== Broadcast custom (Fase 2): CSV + plantilla elegida, con goteo =====
// Tabla de metadata (una fila por broadcast); los targets van a wa_autoreply_log
// con kind = 'bc_<id>' (mismo motor de goteo que los broadcasts hardcodeados).
async function ensureBroadcastsSchema(env) {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS wa_broadcasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      template TEXT NOT NULL,
      lang TEXT DEFAULT 'es',
      param_mode TEXT DEFAULT 'nombre',
      body_preview TEXT,
      status TEXT DEFAULT 'running',
      total INTEGER DEFAULT 0,
      created_at TEXT,
      created_by TEXT
    )`).run();
  } catch (_) {}
  // Columnas opcionales del flujo fusionado (Fase 2.5): respuesta con IA + follow-up.
  for (const c of [
    "reply_ai INTEGER DEFAULT 0",
    "reply_pos_msg TEXT",
    "reply_neg_msg TEXT",
    "followup_hours REAL",
    "followup_template TEXT",
    "followup_lang TEXT",
    "followup_param_mode TEXT",
    "followup_preview TEXT"
  ]) { try { await env.DB.prepare("ALTER TABLE wa_broadcasts ADD COLUMN " + c).run(); } catch (_) {} }
  // Estado por contacto del flujo: respondio / sentimiento / branch / followup.
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS wa_broadcast_events (
      broadcast_id INTEGER,
      phone TEXT,
      replied_at TEXT,
      analyze_due_at TEXT,
      sentiment TEXT,
      branch_sent_at TEXT,
      followup_sent_at TEXT,
      PRIMARY KEY (broadcast_id, phone)
    )`).run();
  } catch (_) {}
}

// Procesa los broadcasts custom: manda la plantilla guardada de cada broadcast
// 'running' a sus targets encolados que ya vencieron. 6 por tick (goteo via
// due_at). Revert-on-fail (vuelve a 'queued') y respeta unreachable + billing.
async function processCustomBroadcasts(env) {
  if (await isWaBillingBlocked(env)) return;
  try {
    const nowIso = new Date().toISOString();
    const floorIso = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const rs = await env.DB.prepare(
      "SELECT a.phone AS phone, a.sender_name AS sender_name, a.kind AS kind, b.template AS template, b.lang AS lang, b.param_mode AS param_mode, b.body_preview AS body_preview FROM wa_autoreply_log a JOIN wa_broadcasts b ON ('bc_' || b.id) = a.kind WHERE a.status = 'queued' AND a.due_at <= ? AND a.due_at >= ? AND b.status = 'running' ORDER BY a.due_at ASC LIMIT 6"
    ).bind(nowIso, floorIso).all();
    if (!rs.results?.length) return;
    for (const row of rs.results) {
      const phone = row.phone, kind = row.kind;
      let claim;
      try { claim = await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'sending' WHERE phone = ? AND kind = ? AND status = 'queued'").bind(phone, kind).run(); } catch (_) { continue; }
      if (!claim?.meta?.changes) continue;
      if (await isUnreachable(env, phone)) {
        try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'skipped', sent_at = ? WHERE phone = ? AND kind = ?").bind(new Date().toISOString(), phone, kind).run(); } catch (_) {}
        continue;
      }
      const primerNombre = capitalizeName((row.sender_name || '').split(/\s+/)[0]) || 'amigo/a';
      const params = (row.param_mode === 'none') ? [] : [primerNombre];
      const tpl = await waSendTemplate(env, phone, row.template, row.lang || 'es', params);
      if (!tpl?.ok) {
        // Falla tipica: plantilla no aprobada aun o ventana → volver a 'queued'.
        try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'queued' WHERE phone = ? AND kind = ?").bind(phone, kind).run(); } catch (_) {}
        continue;
      }
      const ts = new Date().toISOString();
      const wamid = tpl.id || '';
      try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'sent', sent_at = ? WHERE phone = ? AND kind = ?").bind(ts, phone, kind).run(); } catch (_) {}
      const previewBody = (row.body_preview || '').replace(/\{\{\s*1\s*\}\}/g, primerNombre);
      if (wamid && previewBody) {
        try {
          await env.DB.prepare(
            `INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id, automated)
             VALUES (?, ?, 'outbound', ?, '', 'template', ?, 'sent', '', 1)
             ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'template', automated = 1
               WHERE wa_messages.body IS NULL OR wa_messages.body = '' OR wa_messages.msg_type = 'status'`
          ).bind(ts, wamid, phone, previewBody).run();
        } catch (_) {}
      }
    }
  } catch (_) { /* best-effort */ }
}

// Sentiment GENERICO para broadcasts custom: clasifica la respuesta del contacto
// como 'positiva' o 'no_positiva'. Generoso: ante la duda, positiva.
async function analyzeBroadcastReply(env, texto) {
  const t = String(texto || '').trim();
  if (!t || !env.ANTHROPIC_API_KEY) return 'positiva';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 8,
        system: 'Un contacto respondio a un mensaje que le mandamos. Clasifica su respuesta en UNA palabra. POSITIVA: muestra interes, dice que si de cualquier forma, pregunta, agradece, o es neutral/ambigua. NEGATIVA: SOLO si rechaza claramente (dice que no, no le interesa, pide que no le escriban), insulta, es spam, numero equivocado, o es una auto-respuesta de otro negocio. Ante la duda, POSITIVA. Responde SOLO: POSITIVA o NEGATIVA.',
        messages: [{ role: 'user', content: t.slice(0, 500) }]
      })
    });
    const j = await r.json();
    if (!r.ok) return 'positiva';
    return (j.content?.[0]?.text || '').toUpperCase().includes('NEGATIVA') ? 'no_positiva' : 'positiva';
  } catch (e) { return 'positiva'; }
}

// Webhook: si un inbound viene de un contacto que recibio un broadcast con
// respuesta-IA activada y todavia no fue procesado, lo marca para analisis (a
// los ~2 min, para juntar todos sus mensajes). processBroadcastReplies lo levanta.
async function maybeBranchBroadcastReply(env, phone) {
  if (!phone) return;
  try {
    const row = await env.DB.prepare(
      "SELECT b.id AS bid FROM wa_autoreply_log a JOIN wa_broadcasts b ON ('bc_' || b.id) = a.kind WHERE a.phone = ? AND a.status = 'sent' AND b.reply_ai = 1 AND b.status = 'running' ORDER BY a.sent_at DESC LIMIT 1"
    ).bind(phone).first();
    if (!row?.bid) return;
    const exists = await env.DB.prepare("SELECT 1 FROM wa_broadcast_events WHERE broadcast_id = ? AND phone = ?").bind(row.bid, phone).first();
    if (exists) return;
    const now = new Date().toISOString();
    const due = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    await env.DB.prepare("INSERT OR IGNORE INTO wa_broadcast_events (broadcast_id, phone, replied_at, analyze_due_at) VALUES (?, ?, ?, ?)").bind(row.bid, phone, now, due).run();
  } catch (_) {}
}

// Cron (*/1): analiza respuestas pendientes a broadcasts con IA y manda el
// mensaje X (positiva) o Y (no_positiva) como TEXTO LIBRE (la ventana esta
// abierta porque el contacto acaba de escribir).
async function processBroadcastReplies(env) {
  if (await isWaBillingBlocked(env)) return;
  try {
    const nowIso = new Date().toISOString();
    const rs = await env.DB.prepare(
      "SELECT e.broadcast_id AS bid, e.phone AS phone, e.replied_at AS replied_at, b.reply_pos_msg AS pos, b.reply_neg_msg AS neg FROM wa_broadcast_events e JOIN wa_broadcasts b ON b.id = e.broadcast_id WHERE e.sentiment IS NULL AND e.analyze_due_at IS NOT NULL AND e.analyze_due_at <= ? ORDER BY e.analyze_due_at ASC LIMIT 4"
    ).bind(nowIso).all();
    if (!rs.results?.length) return;
    for (const row of rs.results) {
      let claim;
      try { claim = await env.DB.prepare("UPDATE wa_broadcast_events SET sentiment = 'analizando' WHERE broadcast_id = ? AND phone = ? AND sentiment IS NULL").bind(row.bid, row.phone).run(); } catch (_) { continue; }
      if (!claim?.meta?.changes) continue;
      let texto = '';
      try {
        const m = await env.DB.prepare("SELECT body FROM wa_messages WHERE phone = ? AND direction = 'inbound' AND msg_type != 'reaction' AND ts >= ? AND body != '' ORDER BY ts ASC LIMIT 20").bind(row.phone, row.replied_at).all();
        texto = (m.results || []).map(x => x.body).join('\n');
      } catch (_) {}
      const sentiment = await analyzeBroadcastReply(env, texto);
      const msg = (sentiment === 'positiva') ? row.pos : row.neg;
      if (msg && String(msg).trim()) { try { await waSendText(env, row.phone, String(msg)); } catch (_) {} }
      try { await env.DB.prepare("UPDATE wa_broadcast_events SET sentiment = ?, branch_sent_at = ? WHERE broadcast_id = ? AND phone = ?").bind(sentiment, new Date().toISOString(), row.bid, row.phone).run(); } catch (_) {}
    }
  } catch (_) { /* best-effort */ }
}

// Cron (*/1, solo 9-21 AR): a los contactos de un broadcast que NO respondieron
// despues de followup_hours, les manda la plantilla de seguimiento (Z). Como no
// respondieron la ventana esta cerrada => va como plantilla.
async function processBroadcastFollowups(env) {
  if (await isWaBillingBlocked(env)) return;
  const hAR = (new Date().getUTCHours() + 24 - 3) % 24;
  if (hAR < 9 || hAR >= 21) return;
  try {
    const now = Date.now();
    const bcs = (await env.DB.prepare("SELECT id, followup_hours, followup_template, followup_lang, followup_param_mode, followup_preview FROM wa_broadcasts WHERE status = 'running' AND followup_hours IS NOT NULL AND followup_template IS NOT NULL AND followup_template != ''").all()).results || [];
    for (const b of bcs) {
      const cutoff = new Date(now - b.followup_hours * 3600 * 1000).toISOString();
      const targets = (await env.DB.prepare(
        "SELECT a.phone AS phone, a.sender_name AS nombre FROM wa_autoreply_log a WHERE a.kind = ? AND a.status = 'sent' AND a.sent_at <= ? AND NOT EXISTS (SELECT 1 FROM wa_broadcast_events e WHERE e.broadcast_id = ? AND e.phone = a.phone) AND NOT EXISTS (SELECT 1 FROM wa_messages m WHERE m.phone = a.phone AND m.direction = 'inbound' AND m.ts > a.sent_at) ORDER BY a.sent_at ASC LIMIT 4"
      ).bind('bc_' + b.id, cutoff, b.id).all()).results || [];
      for (const t of targets) {
        // Claim atomico: marca el evento ANTES de mandar (evita doble-envio).
        let claim;
        try { claim = await env.DB.prepare("INSERT OR IGNORE INTO wa_broadcast_events (broadcast_id, phone, followup_sent_at) VALUES (?, ?, ?)").bind(b.id, t.phone, new Date().toISOString()).run(); } catch (_) { continue; }
        if (!claim?.meta?.changes) continue;
        if (await isUnreachable(env, t.phone)) continue;
        const primerNombre = capitalizeName((t.nombre || '').split(/\s+/)[0]) || 'amigo/a';
        const params = (b.followup_param_mode === 'none') ? [] : [primerNombre];
        const tpl = await waSendTemplate(env, t.phone, b.followup_template, b.followup_lang || 'es', params);
        if (tpl?.ok && tpl.id) {
          const ts = new Date().toISOString();
          const previewBody = (b.followup_preview || '').replace(/\{\{\s*1\s*\}\}/g, primerNombre);
          if (previewBody) { try { await env.DB.prepare(`INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id, automated) VALUES (?, ?, 'outbound', ?, '', 'template', ?, 'sent', '', 1) ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'template', automated = 1 WHERE wa_messages.body IS NULL OR wa_messages.body = '' OR wa_messages.msg_type = 'status'`).bind(ts, tpl.id, t.phone, previewBody).run(); } catch (_) {} }
        }
      }
    }
  } catch (_) { /* best-effort */ }
}

// ===== Flujo de cursos por ads (Fase 3) =====
// Se dispara cuando un lead de un ad de CURSOS nos escribe: opener automatico
// (msgs 1-3), branch por IA (manda link si responde positivo), y nutrir (msg 6
// a +23h, msg 7 si responde). Queda OCULTO para Abril durante el opener; se
// revela al responder o al nudge de 3hs. Apagado por flag kv 'cursos_flow_on'.
async function cursosFlowOn(env) {
  try { const f = await env.DB.prepare("SELECT v FROM kv_cache WHERE k = 'cursos_flow_on'").first(); return !!f && f.v === '1'; } catch (_) { return false; }
}

// ¿El contacto ya esta mas adelante en el embudo del minicurso? (recibio el link
// del minicurso o el regalo cotizador+guia). Si si, no arrancamos / no va el msg 6.
async function gotMinicurso(env, phone) {
  try {
    const r = await env.DB.prepare("SELECT 1 AS x FROM wa_autoreply_log WHERE phone = ? AND kind IN ('minicurso','minicurso_gift') AND status = 'sent' LIMIT 1").bind(phone).first();
    return !!r;
  } catch (_) { return false; }
}

// Texto de cada mensaje del flujo (texto libre; la ventana de 24h esta abierta
// porque el lead nos escribio).
function cursosFlowBody(kind) {
  switch (kind) {
    case 'cf_1': return 'Holaa como va?? Por acá Abril de Neon Infinito, sii, estamos con una formación online y GRATUITA de 2 clases, donde te contamos todo sobre el negocio de carteles de Neon LED: cómo venderlos (con o sin inversión en anuncios), cómo fabricarlos desde cero, y cómo empezar sin tener idea.';
    case 'cf_2': return 'Al final, te contamos cómo acceder al programa completo, con seguimiento en nuestra comunidad, contenido grabado, y un regalo sorpresa para cada nuevo alumno.';
    case 'cf_3': return 'Te paso el enlace para verla?';
    case 'cf_4': return 'Acá te mando la página para que te registres en nuestra nueva formación GRATUITA de 2 clases.\nAprovechá a verla ahora en este link 👇🏼\nneoninfinito.com';
    case 'cf_5': return 'Después nos contás qué te pareció (quedate hasta el final que hay sorpresa) ✨';
    case 'cf_nudge': return 'buenas buenas! Pudiste ver el mensaje?';
    case 'cf_6': return 'holaa, cómo va?? Contanos qué te pareció el Minicurso, si es que pudiste verlo completo ✨';
    case 'cf_7': return 'Viste la 2da y última clase de la Formación gratuita hasta el final? Para saber si estás al tanto del programa Al Infinito, y todo lo que incluye (kit inicial de regalo, grupo de alumnos por Wpp, etc.)';
    default: return '';
  }
}

// ============================================================================
// Landing del minicurso gratuito (leads que se REGISTRAN en la web).
// La landing manda cada registro (nombre + teléfono) a /webhook/minicurso-lead
// (2da acción de webhook, en paralelo a la que ya escribe en el Google Sheet).
// A los ~45 min Abril manda un opener (PLANTILLA aprobada: el lead nunca nos
// escribió, la ventana de 24h está cerrada), el chat entra a su bandeja, y según
// la respuesta la IA ramifica. Follow-up a las 23h si no vio la clase 2.
// Estructura calcada de wa_cursos_flow; la diferencia es el disparo (registro,
// no inbound de ad) y que el opener va por plantilla. GUARDIA anti-choque con el
// flujo de ads en ambas direcciones (ver también cursosFlowOnInbound).
// ============================================================================
const MINICURSO_LANDING_DELAY_MS = 45 * 60 * 1000;          // opener a los 45 min del registro
const MINICURSO_LANDING_FOLLOWUP_MS = 23 * 60 * 60 * 1000;  // follow-up a las 23h del último mensaje
const MINICURSO_LANDING_DEBOUNCE_MS = 90 * 1000;            // esperar a que el cliente termine de escribir
const MINICURSO_LANDING_OPENER_TPL = 'minicurso_landing_opener';     // plantilla Meta (opener, fuera de ventana)
const MINICURSO_LANDING_FOLLOWUP_TPL = 'minicurso_landing_followup_v2'; // plantilla Meta (follow-up, fuera de ventana). v2: la v1 se borró para sacar "che"/"jej" y Meta bloquea reusar el nombre 4 semanas.
// Mensajes de texto libre (dentro de la ventana de 24h: el lead ya respondió).
const MINICURSO_LANDING_CLASE2_MSG = 'buenísimo entonces ✨ avisame cuando hayas visto la clase 2 completa y seguimos charlando! Que al final hay una propuesta que te va a interesar seguro';
const MINICURSO_LANDING_FU_1 = 'buenass, cómo va? Abril de nuevoo';
const MINICURSO_LANDING_FU_2 = 'avisame cuando hayas podido ver la clase 2 hasta el final! Me ayudaría mucho saber qué te pareció ✨';

async function minicursoLandingOn(env) { return (await kvGet(env, 'minicurso_landing_on', '0')) === '1'; }
// Horario de envío (opener + follow-up): 8-22 AR, para no mandar plantillas de madrugada.
function minicursoLandingEnHorario() {
  const hAR = (new Date().getUTCHours() - 3 + 24) % 24;
  return hAR >= 8 && hAR < 22;
}
// Preview del opener que se guarda en el chat (la plantilla real la aprueba Meta).
function minicursoLandingOpenerPreview(nombre) {
  const n = String(nombre || '').trim();
  return `holaa ${n}, vimos que te registraste hace un ratito a la formación gratuita! Soy Abril, de Neon Infinito. calculo que ya viste la clase 1, no?`.replace(' , ', ', ');
}
function minicursoLandingFollowupPreview() {
  return MINICURSO_LANDING_FU_1 + '\n' + MINICURSO_LANDING_FU_2;
}
// ¿El lead ya está en el flujo de la landing en un estado ACTIVO (no terminal)?
// Lo usa el guardia del flujo de ads para no arrancar un opener duplicado.
async function minicursoLandingActivo(env, phone) {
  try {
    const r = await env.DB.prepare("SELECT 1 AS x FROM minicurso_landing WHERE phone = ? AND stage NOT IN ('guarded','abril_manual','done') LIMIT 1").bind(phone).first();
    return !!r;
  } catch (_) { return false; }
}

// ¿El cliente indicó que YA vio/terminó la clase 2? Gate del follow-up (que SOLO
// sale si NO vio la clase 2). Conservadores para el "sí vio": solo true ante señal
// clara; ante duda -> false (mandamos el recordatorio, es suave y barato).
async function analyzeVioClase2(env, texto) {
  const t = String(texto || '').trim();
  if (!t || !env.ANTHROPIC_API_KEY) return false;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 8,
        system: 'Seguís a personas anotadas a una formación gratuita de 2 clases sobre carteles de neón LED. Te paso la conversación (Cliente / Abril). Decidí si el CLIENTE ya vio, terminó o está viendo la CLASE 2 (la segunda y última clase). Respondé SOLO una palabra: SI si el cliente da a entender claramente que ya vio/terminó/está viendo la clase 2, la segunda clase, o las dos clases (ej. "ya la vi", "terminé las dos", "me encantó la segunda"). NO en cualquier otro caso: si no menciona la clase 2, si solo habló de la clase 1, si dijo que todavía no pudo, si es ambiguo o no hay señal. Ante la duda, NO.',
        messages: [{ role: 'user', content: t.slice(0, 1500) }]
      })
    });
    const j = await r.json();
    if (!r.ok) return false;
    return (j.content?.[0]?.text || '').trim().toUpperCase().startsWith('S');
  } catch (e) { return false; }
}

// Webhook (inbound): el lead de la landing respondió. Marca para análisis (con
// debounce para juntar mensajes) o reprograma el follow-up si ya avanzó.
async function minicursoLandingOnInbound(env, phone, ts) {
  if (!phone || !(await minicursoLandingOn(env))) return;
  try {
    const row = await env.DB.prepare("SELECT stage FROM minicurso_landing WHERE phone = ?").bind(phone).first();
    if (!row) return;
    const now = new Date().toISOString();
    // El lead respondió ALGO (cualquier mensaje, cualquier stage) → recién ahora lo
    // mostramos en la bandeja de Abril. Antes queda 'oculto' para no ensuciarla con
    // leads que no contestan nada. No pisa si Abril ya lo movió a otra bandeja.
    try { await env.DB.prepare("INSERT INTO wa_chats_summary (phone, inbox, updated_at) VALUES (?, 'cursos', ?) ON CONFLICT(phone) DO UPDATE SET inbox = 'cursos', updated_at = excluded.updated_at WHERE wa_chats_summary.inbox IS NULL OR wa_chats_summary.inbox IN ('oculto','general','')").bind(phone, now).run(); } catch (_) {}
    const due = new Date(Date.now() + MINICURSO_LANDING_DEBOUNCE_MS).toISOString();
    const fu = new Date(Date.now() + MINICURSO_LANDING_FOLLOWUP_MS).toISOString();
    if (row.stage === 'await1' || row.stage === 'analyze1' || row.stage === 'analyzing1') {
      // Primera respuesta al opener (o sigue escribiendo): analizar con debounce y correr el follow-up.
      await env.DB.prepare("UPDATE minicurso_landing SET stage = 'analyze1', reply_due = ?, followup_due_at = ?, updated_at = ? WHERE phone = ?").bind(due, fu, now, phone).run();
    } else if (row.stage === 'done_pos') {
      // Ya le mandamos la clase 2: cada mensaje nuevo corre el follow-up 23h.
      await env.DB.prepare("UPDATE minicurso_landing SET followup_due_at = ?, updated_at = ? WHERE phone = ? AND followup_sent_at IS NULL").bind(fu, now, phone).run();
    }
  } catch (_) {}
}

// Cron (*/1): motor del flujo de la landing. (a) manda el opener a los 45 min
// (plantilla) con guardia + horario; (b) analiza la respuesta con IA y ramifica;
// (c) follow-up a las 23h si no vio la clase 2 y no pidió los regalos.
async function processMinicursoLanding(env) {
  if (!(await minicursoLandingOn(env)) || await isWaBillingBlocked(env)) return;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const enHorario = minicursoLandingEnHorario();

  // (a) OPENER: registros cuyo +45min venció. Solo en horario (no plantillas de
  //     madrugada). Guardia anti-choque con el flujo de ads / minicurso ya recibido.
  if (enHorario) {
    try {
      const rs = await env.DB.prepare("SELECT phone, nombre FROM minicurso_landing WHERE stage = 'registered' AND opener_due_at <= ? ORDER BY opener_due_at ASC LIMIT 10").bind(nowIso).all();
      for (const r of (rs.results || [])) {
        const phone = r.phone;
        // GUARDIA: si ya está en el flujo de ads (sin terminar) o ya recibió el
        // minicurso/regalo, no duplicamos el opener. Lo marcamos guarded y lo dejamos
        // OCULTO hasta que responda (el reveal-on-inbound lo cubre, sigue en la tabla).
        let guard = '';
        try { const inFlow = await env.DB.prepare("SELECT stage FROM wa_cursos_flow WHERE phone = ?").bind(phone).first(); if (inFlow && inFlow.stage && inFlow.stage !== 'done') guard = 'en_flujo_ads:' + inFlow.stage; } catch (_) {}
        if (!guard && await gotMinicurso(env, phone)) guard = 'ya_recibio_minicurso';
        if (guard) {
          try { await env.DB.prepare("UPDATE minicurso_landing SET stage = 'guarded', guard_reason = ?, updated_at = ? WHERE phone = ? AND stage = 'registered'").bind(guard, nowIso, phone).run(); } catch (_) {}
          try { await env.DB.prepare("UPDATE wa_chats_summary SET inbox = 'oculto', updated_at = ? WHERE phone = ? AND (inbox IS NULL OR inbox IN ('general',''))").bind(nowIso, phone).run(); } catch (_) {}
          continue;
        }
        // Claim atómico (evita doble envío entre ticks del cron).
        let cl; try { cl = await env.DB.prepare("UPDATE minicurso_landing SET stage = 'sending_opener', updated_at = ? WHERE phone = ? AND stage = 'registered'").bind(nowIso, phone).run(); } catch (_) { continue; }
        if (!cl?.meta?.changes) continue;
        const nombre = (r.nombre || '').trim() || 'buenas';
        const res = await waSendTemplate(env, phone, MINICURSO_LANDING_OPENER_TPL, 'es_AR', [nombre]);
        if (!res || !res.ok) {
          // Liberar para reintentar en el próximo tick en horario.
          try { await env.DB.prepare("UPDATE minicurso_landing SET stage = 'registered', updated_at = ? WHERE phone = ?").bind(nowIso, phone).run(); } catch (_) {}
          continue;
        }
        const sentTs = new Date().toISOString();
        // Queda OCULTO hasta que responda algo (Abril solo ve leads que contestaron).
        // El reveal a 'cursos' lo hace minicursoLandingOnInbound al primer entrante.
        try { await env.DB.prepare("INSERT INTO wa_chats_summary (phone, inbox, updated_at) VALUES (?, 'oculto', ?) ON CONFLICT(phone) DO UPDATE SET inbox = 'oculto', updated_at = excluded.updated_at WHERE wa_chats_summary.inbox IS NULL OR wa_chats_summary.inbox IN ('general','oculto','')").bind(phone, sentTs).run(); } catch (_) {}
        try { await env.DB.prepare("UPDATE minicurso_landing SET stage = 'await1', opener_sent_at = ?, followup_due_at = ?, updated_at = ? WHERE phone = ?").bind(sentTs, new Date(nowMs + MINICURSO_LANDING_FOLLOWUP_MS).toISOString(), sentTs, phone).run(); } catch (_) {}
        if (res.id) { try { await env.DB.prepare(`INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id, automated) VALUES (?, ?, 'outbound', ?, '', 'template', ?, 'sent', '', 1) ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'template', automated = 1 WHERE wa_messages.body IS NULL OR wa_messages.body = '' OR wa_messages.msg_type = 'status'`).bind(sentTs, res.id, phone, minicursoLandingOpenerPreview(nombre)).run(); } catch (_) {} }
      }
    } catch (_) {}
  }

  // (b) BRANCH: respuestas con el debounce vencido. Junta los mensajes del cliente,
  //     IA evalúa (generoso): positiva -> mensaje clase 2 (texto libre, ventana
  //     abierta); no positiva -> Abril lo sigue a mano (sin mensaje automático).
  try {
    const an = await env.DB.prepare("SELECT phone, opener_sent_at FROM minicurso_landing WHERE stage = 'analyze1' AND reply_due <= ? LIMIT 6").bind(nowIso).all();
    for (const r of (an.results || [])) {
      const phone = r.phone;
      let cl; try { cl = await env.DB.prepare("UPDATE minicurso_landing SET stage = 'analyzing1' WHERE phone = ? AND stage = 'analyze1'").bind(phone).run(); } catch (_) { continue; }
      if (!cl?.meta?.changes) continue;
      let texto = '';
      try { const m = await env.DB.prepare("SELECT body FROM wa_messages WHERE phone = ? AND direction = 'inbound' AND msg_type != 'reaction' AND ts >= ? AND body != '' ORDER BY ts ASC LIMIT 20").bind(phone, r.opener_sent_at || '').all(); texto = (m.results || []).map(x => x.body).join('\n'); } catch (_) {}
      const sentiment = await analyzeMinicursoFeedback(env, texto); // generoso: duda -> positiva
      if (sentiment === 'positiva') {
        const res = await waSendText(env, phone, MINICURSO_LANDING_CLASE2_MSG);
        const sentTs = new Date().toISOString();
        if (res && res.ok) {
          if (res.id) { try { await env.DB.prepare(`INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id, automated) VALUES (?, ?, 'outbound', ?, '', 'text', ?, 'sent', '', 1) ON CONFLICT(wamid) DO NOTHING`).bind(sentTs, res.id, phone, MINICURSO_LANDING_CLASE2_MSG).run(); } catch (_) {} }
          try { await env.DB.prepare("UPDATE minicurso_landing SET stage = 'done_pos', followup_due_at = ?, updated_at = ? WHERE phone = ?").bind(new Date(Date.now() + MINICURSO_LANDING_FOLLOWUP_MS).toISOString(), sentTs, phone).run(); } catch (_) {}
        } else {
          // No se pudo mandar: volver a await1 (reintenta con el próximo inbound/tick).
          try { await env.DB.prepare("UPDATE minicurso_landing SET stage = 'await1', updated_at = ? WHERE phone = ?").bind(sentTs, phone).run(); } catch (_) {}
        }
      } else {
        // No positiva: lo sigue Abril. El chat ya está en su bandeja. Sin follow-up.
        try { await env.DB.prepare("UPDATE minicurso_landing SET stage = 'abril_manual', followup_due_at = NULL, updated_at = ? WHERE phone = ?").bind(nowIso, phone).run(); } catch (_) {}
      }
    }
  } catch (_) {}

  // (c) FOLLOW-UP a las 23h del último mensaje. Aplica a await1 (no respondió el
  //     opener) o done_pos (dijo que vio la 1, le pedimos la 2). Gates: no pidió
  //     los regalos y la IA interpreta que NO vio la clase 2. Texto libre si la
  //     ventana sigue abierta (2 mensajitos), plantilla si ya cerró.
  if (enHorario) {
    try {
      const fsq = await env.DB.prepare("SELECT phone, opener_sent_at FROM minicurso_landing WHERE stage IN ('await1','done_pos') AND followup_due_at IS NOT NULL AND followup_due_at <= ? AND followup_sent_at IS NULL LIMIT 10").bind(nowIso).all();
      for (const r of (fsq.results || [])) {
        const phone = r.phone;
        // Claim atómico.
        let cl; try { cl = await env.DB.prepare("UPDATE minicurso_landing SET followup_sent_at = 'sending', updated_at = ? WHERE phone = ? AND followup_sent_at IS NULL").bind(nowIso, phone).run(); } catch (_) { continue; }
        if (!cl?.meta?.changes) continue;
        // Gate 1: ya pidió los regalos (cotizador+guía) -> no lo molestamos.
        if (await gotMinicurso(env, phone)) { try { await env.DB.prepare("UPDATE minicurso_landing SET followup_sent_at = 'skipped', guard_reason = 'pidio_regalos', stage = 'done', updated_at = ? WHERE phone = ?").bind(nowIso, phone).run(); } catch (_) {} continue; }
        // Gate 2: ¿ya vio la clase 2 (según la conversación)? Si sí -> no mandamos.
        let texto = '';
        try { const m = await env.DB.prepare("SELECT direction, body FROM wa_messages WHERE phone = ? AND ts >= ? AND body != '' AND msg_type != 'reaction' ORDER BY ts ASC LIMIT 30").bind(phone, r.opener_sent_at || '').all(); texto = (m.results || []).map(x => (x.direction === 'inbound' ? 'Cliente: ' : 'Abril: ') + x.body).join('\n'); } catch (_) {}
        if (await analyzeVioClase2(env, texto)) { try { await env.DB.prepare("UPDATE minicurso_landing SET vio_clase2 = 1, followup_sent_at = 'skipped', guard_reason = 'vio_clase2', stage = 'done', updated_at = ? WHERE phone = ?").bind(nowIso, phone).run(); } catch (_) {} continue; }
        // Mandar. ¿Ventana abierta? (último inbound < 24h).
        let lastIn = null;
        try { const li = await env.DB.prepare("SELECT MAX(ts) AS t FROM wa_messages WHERE phone = ? AND direction = 'inbound'").bind(phone).first(); lastIn = li && li.t; } catch (_) {}
        const within24 = lastIn && (nowMs - new Date(lastIn).getTime()) < 24 * 60 * 60 * 1000;
        let ok = false;
        if (within24) {
          const r1 = await waSendText(env, phone, MINICURSO_LANDING_FU_1);
          if (r1 && r1.ok) {
            if (r1.id) { try { await env.DB.prepare("INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id, automated) VALUES (?, ?, 'outbound', ?, '', 'text', ?, 'sent', '', 1) ON CONFLICT(wamid) DO NOTHING").bind(new Date().toISOString(), r1.id, phone, MINICURSO_LANDING_FU_1).run(); } catch (_) {} }
            const r2 = await waSendText(env, phone, MINICURSO_LANDING_FU_2);
            if (r2 && r2.ok && r2.id) { try { await env.DB.prepare("INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id, automated) VALUES (?, ?, 'outbound', ?, '', 'text', ?, 'sent', '', 1) ON CONFLICT(wamid) DO NOTHING").bind(new Date().toISOString(), r2.id, phone, MINICURSO_LANDING_FU_2).run(); } catch (_) {} }
            ok = true;
          }
        } else {
          const rt = await waSendTemplate(env, phone, MINICURSO_LANDING_FOLLOWUP_TPL, 'es_AR', []);
          if (rt && rt.ok) {
            if (rt.id) { try { await env.DB.prepare("INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id, automated) VALUES (?, ?, 'outbound', ?, '', 'template', ?, 'sent', '', 1) ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'template', automated = 1 WHERE wa_messages.body IS NULL OR wa_messages.body = '' OR wa_messages.msg_type = 'status'").bind(new Date().toISOString(), rt.id, phone, minicursoLandingFollowupPreview()).run(); } catch (_) {} }
            ok = true;
          }
        }
        if (ok) { try { await env.DB.prepare("UPDATE minicurso_landing SET followup_sent_at = ?, stage = 'done', updated_at = ? WHERE phone = ?").bind(new Date().toISOString(), nowIso, phone).run(); } catch (_) {} }
        else { try { await env.DB.prepare("UPDATE minicurso_landing SET followup_sent_at = NULL, updated_at = ? WHERE phone = ?").bind(nowIso, phone).run(); } catch (_) {} }
      }
    } catch (_) {}
  }
}

// Webhook (inbound): arranca el flujo para un lead nuevo de ad de cursos, o
// transiciona el estado si ya esta en el flujo (respuesta al msg 3 o al msg 6).
async function cursosFlowOnInbound(env, phone, msgBody, ts) {
  if (!phone || !(await cursosFlowOn(env))) return;
  try {
    const row = await env.DB.prepare("SELECT stage FROM wa_cursos_flow WHERE phone = ?").bind(phone).first();
    const now = new Date().toISOString();
    if (!row) {
      const attr = await env.DB.prepare("SELECT source_id, headline, body FROM wa_ad_attributions WHERE phone = ? ORDER BY ts DESC LIMIT 1").bind(phone).first();
      if (!attr || !attr.source_id) return;
      const vert = await adVerticalForSource(env, attr.source_id, attr.headline, attr.body);
      if (vert !== 'cursos') return;
      if (await gotMinicurso(env, phone)) return;
      // GUARDIA anti-choque: si el lead ya está siendo atendido por la landing del
      // minicurso (mismo público), no arrancamos el opener de ads (sería doble).
      if (await minicursoLandingActivo(env, phone)) return;
      await env.DB.prepare("INSERT OR IGNORE INTO wa_cursos_flow (phone, stage, started_at, nudged, updated_at) VALUES (?, 'opener', ?, 0, ?)").bind(phone, now, now).run();
      // Abril los ve DESDE EL INICIO: arrancan en su bandeja (cursos), no ocultos.
      try { await env.DB.prepare("INSERT INTO wa_chats_summary (phone, inbox, updated_at) VALUES (?, 'cursos', ?) ON CONFLICT(phone) DO UPDATE SET inbox = 'cursos', updated_at = excluded.updated_at WHERE wa_chats_summary.inbox IS NULL OR wa_chats_summary.inbox IN ('general','oculto')").bind(phone, now).run(); } catch (_) {}
      const base = Date.now() + 5 * 60 * 1000;
      const enq = (k, off) => env.DB.prepare("INSERT OR IGNORE INTO wa_autoreply_log (phone, kind, sent_at, status, due_at, sender_name) VALUES (?, ?, '', 'queued', ?, '')").bind(phone, k, new Date(base + off).toISOString());
      try { await env.DB.batch([enq('cf_1', 0), enq('cf_2', 10000), enq('cf_3', 20000)]); } catch (_) {}
      return;
    }
    const due2 = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    if (row.stage === 'await1') {
      await env.DB.prepare("UPDATE wa_cursos_flow SET stage = 'analyze1', reply_due = ?, updated_at = ? WHERE phone = ? AND stage = 'await1'").bind(due2, now, phone).run();
      try { await env.DB.prepare("UPDATE wa_chats_summary SET inbox = 'cursos', updated_at = ? WHERE phone = ?").bind(now, phone).run(); } catch (_) {}
    } else if (row.stage === 'await6') {
      await env.DB.prepare("UPDATE wa_cursos_flow SET stage = 'analyze6', m6_reply_due = ?, updated_at = ? WHERE phone = ? AND stage = 'await6'").bind(due2, now, phone).run();
    }
  } catch (_) {}
}

// Cron (*/1): motor del flujo. (a) manda cf_* vencidos + transiciona; (b) analiza
// respuestas (cf_3/cf_6) con IA y ramifica; (c) nudge a las 3hs sin respuesta.
async function processCursosFlow(env) {
  if (!(await cursosFlowOn(env)) || await isWaBillingBlocked(env)) return;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  // (a) Mandar mensajes cf_* vencidos (texto libre; cf_6 plantilla si cerro la ventana).
  try {
    const floorIso = new Date(nowMs - 72 * 60 * 60 * 1000).toISOString();
    const rs = await env.DB.prepare("SELECT phone, kind FROM wa_autoreply_log WHERE kind LIKE 'cf/_%' ESCAPE '/' AND status = 'queued' AND due_at <= ? AND due_at >= ? ORDER BY due_at ASC LIMIT 6").bind(nowIso, floorIso).all();
    for (const r of (rs.results || [])) {
      const phone = r.phone, kind = r.kind;
      let claim;
      try { claim = await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'sending' WHERE phone = ? AND kind = ? AND status = 'queued'").bind(phone, kind).run(); } catch (_) { continue; }
      if (!claim?.meta?.changes) continue;
      const body = cursosFlowBody(kind);
      let res, asTemplate = false;
      if (kind === 'cf_6') {
        let lastIn = null;
        try { const li = await env.DB.prepare("SELECT MAX(ts) AS t FROM wa_messages WHERE phone = ? AND direction = 'inbound'").bind(phone).first(); lastIn = li && li.t; } catch (_) {}
        const within24 = lastIn && (nowMs - new Date(lastIn).getTime()) < 24 * 60 * 60 * 1000;
        if (within24) { res = await waSendText(env, phone, body); }
        else { asTemplate = true; res = await waSendTemplate(env, phone, 'minicurso_feedback', 'es_AR', []); }
      } else {
        res = await waSendText(env, phone, body);
      }
      if (!res || !res.ok) { try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'queued' WHERE phone = ? AND kind = ?").bind(phone, kind).run(); } catch (_) {} continue; }
      const sentTs = new Date().toISOString();
      try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'sent', sent_at = ? WHERE phone = ? AND kind = ?").bind(sentTs, phone, kind).run(); } catch (_) {}
      if (res.id && body) { try { await env.DB.prepare(`INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id, automated) VALUES (?, ?, 'outbound', ?, '', ?, ?, 'sent', '', 1) ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, automated = 1 WHERE wa_messages.body IS NULL OR wa_messages.body = '' OR wa_messages.msg_type = 'status'`).bind(sentTs, res.id, phone, asTemplate ? 'template' : 'text', body).run(); } catch (_) {} }
      if (kind === 'cf_3') {
        try { await env.DB.prepare("UPDATE wa_cursos_flow SET stage = 'await1', opener3_at = ?, updated_at = ? WHERE phone = ?").bind(sentTs, sentTs, phone).run(); } catch (_) {}
      } else if (kind === 'cf_4') {
        try { await env.DB.prepare("UPDATE wa_cursos_flow SET stage = 'link', link_sent_at = ?, updated_at = ? WHERE phone = ?").bind(sentTs, sentTs, phone).run(); } catch (_) {}
        if (!(await gotMinicurso(env, phone))) {
          try { await env.DB.prepare("INSERT OR IGNORE INTO wa_autoreply_log (phone, kind, sent_at, status, due_at, sender_name) VALUES (?, 'cf_6', '', 'queued', ?, '')").bind(phone, new Date(nowMs + 23 * 60 * 60 * 1000).toISOString()).run(); } catch (_) {}
        }
      } else if (kind === 'cf_6') {
        try { await env.DB.prepare("UPDATE wa_cursos_flow SET stage = 'await6', updated_at = ? WHERE phone = ?").bind(sentTs, phone).run(); } catch (_) {}
      } else if (kind === 'cf_7') {
        try { await env.DB.prepare("UPDATE wa_cursos_flow SET stage = 'done', updated_at = ? WHERE phone = ?").bind(sentTs, phone).run(); } catch (_) {}
      }
    }
  } catch (_) {}
  // (b) Analizar respuestas pendientes con IA y ramificar.
  try {
    const an = await env.DB.prepare("SELECT phone, stage, started_at, link_sent_at FROM wa_cursos_flow WHERE (stage = 'analyze1' AND reply_due <= ?) OR (stage = 'analyze6' AND m6_reply_due <= ?) LIMIT 4").bind(nowIso, nowIso).all();
    for (const r of (an.results || [])) {
      const phone = r.phone;
      const sinceTs = r.stage === 'analyze6' ? (r.link_sent_at || r.started_at) : r.started_at;
      const claimStage = r.stage === 'analyze1' ? 'analyzing1' : 'analyzing6';
      let cl; try { cl = await env.DB.prepare("UPDATE wa_cursos_flow SET stage = ? WHERE phone = ? AND stage = ?").bind(claimStage, phone, r.stage).run(); } catch (_) { continue; }
      if (!cl?.meta?.changes) continue;
      let texto = '';
      try { const m = await env.DB.prepare("SELECT body FROM wa_messages WHERE phone = ? AND direction = 'inbound' AND msg_type != 'reaction' AND ts >= ? AND body != '' ORDER BY ts ASC LIMIT 20").bind(phone, sinceTs).all(); texto = (m.results || []).map(x => x.body).join('\n'); } catch (_) {}
      const sentiment = await analyzeBroadcastReply(env, texto);
      if (r.stage === 'analyze1') {
        if (sentiment === 'positiva') {
          const b = Date.now() + 2 * 60 * 1000;
          try { await env.DB.batch([
            env.DB.prepare("INSERT OR IGNORE INTO wa_autoreply_log (phone, kind, sent_at, status, due_at, sender_name) VALUES (?, 'cf_4', '', 'queued', ?, '')").bind(phone, new Date(b).toISOString()),
            env.DB.prepare("INSERT OR IGNORE INTO wa_autoreply_log (phone, kind, sent_at, status, due_at, sender_name) VALUES (?, 'cf_5', '', 'queued', ?, '')").bind(phone, new Date(b + 10000).toISOString())
          ]); } catch (_) {}
          try { await env.DB.prepare("UPDATE wa_cursos_flow SET stage = 'await_link', updated_at = ? WHERE phone = ?").bind(nowIso, phone).run(); } catch (_) {}
        } else {
          try { await env.DB.prepare("UPDATE wa_cursos_flow SET stage = 'done', updated_at = ? WHERE phone = ?").bind(nowIso, phone).run(); } catch (_) {}
        }
      } else {
        if (sentiment === 'positiva') {
          try { await env.DB.prepare("INSERT OR IGNORE INTO wa_autoreply_log (phone, kind, sent_at, status, due_at, sender_name) VALUES (?, 'cf_7', '', 'queued', ?, '')").bind(phone, new Date(Date.now() + 2 * 60 * 1000).toISOString()).run(); } catch (_) {}
        }
        try { await env.DB.prepare("UPDATE wa_cursos_flow SET stage = 'done', updated_at = ? WHERE phone = ?").bind(nowIso, phone).run(); } catch (_) {}
      }
    }
  } catch (_) {}
  // (c) Nudge a las 3hs si quedo en await1 sin responder (y se revela a Abril).
  try {
    const cutoff = new Date(nowMs - 3 * 60 * 60 * 1000).toISOString();
    const nd = await env.DB.prepare("SELECT phone FROM wa_cursos_flow WHERE stage = 'await1' AND nudged = 0 AND opener3_at IS NOT NULL AND opener3_at <= ? LIMIT 4").bind(cutoff).all();
    for (const r of (nd.results || [])) {
      const phone = r.phone;
      let cl; try { cl = await env.DB.prepare("UPDATE wa_cursos_flow SET nudged = 1, updated_at = ? WHERE phone = ? AND stage = 'await1' AND nudged = 0").bind(nowIso, phone).run(); } catch (_) { continue; }
      if (!cl?.meta?.changes) continue;
      const res = await waSendText(env, phone, cursosFlowBody('cf_nudge'));
      if (res && res.ok) {
        try { await env.DB.prepare("UPDATE wa_chats_summary SET inbox = 'cursos', updated_at = ? WHERE phone = ?").bind(nowIso, phone).run(); } catch (_) {}
        if (res.id) { try { await env.DB.prepare(`INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id, automated) VALUES (?, ?, 'outbound', ?, '', 'text', ?, 'sent', '', 1) ON CONFLICT(wamid) DO NOTHING`).bind(new Date().toISOString(), res.id, phone, cursosFlowBody('cf_nudge')).run(); } catch (_) {} }
      } else {
        try { await env.DB.prepare("UPDATE wa_cursos_flow SET nudged = 0 WHERE phone = ?").bind(phone).run(); } catch (_) {}
      }
    }
  } catch (_) {}
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
      "SELECT phone, sent_1_at, campaign FROM wa_cursos_campaign WHERE analyze_due_at IS NOT NULL AND analyze_due_at <= ? AND sentiment IS NULL LIMIT 25"
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
        // lo manda y RECIÉN AHÍ revela el chat a Abril. El mensaje depende de la
        // campaña: junio → JUNIO_VIVO_MSG; mayo → CURSOS_EVENTO_MSG.
        const dueAt = new Date(Date.now() + 30 * 1000).toISOString();
        const evKind = (row.campaign === 'junio') ? 'junio_evento' : 'cursos_evento';
        try {
          await env.DB.prepare(
            "INSERT OR IGNORE INTO wa_autoreply_log (phone, kind, sent_at, status, due_at, sender_name) VALUES (?, ?, '', 'queued', ?, '')"
          ).bind(phone, evKind, dueAt).run();
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
  // ⛔ DESACTIVADO 2026-06-11 (pedido urgente de Gaspar). Este follow-up de mayo
  // seleccionaba TODO wa_cursos_campaign sin filtrar `campaign`, así que le mandó
  // el seguimiento de "las clases del 6 y 7 de mayo" al cohort de JUNIO (~90 envíos
  // a gente equivocada, muchos bloqueados por calidad de Meta - "healthy ecosystem
  // engagement"). Queda apagado. Para re-activar SOLO el cohort real de mayo:
  // agregar  AND campaign = 'mayo'  al SELECT de abajo y borrar este return.
  return;
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
        await clearSendFail(env, 'cursosfu:' + phone);
        const wamid = tpl.id || '';
        if (wamid) {
          try {
            await env.DB.prepare(
              `INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id, automated)
               VALUES (?, ?, 'outbound', ?, '', 'template', ?, 'sent', '', 1)
               ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'template', automated = 1
                 WHERE wa_messages.body IS NULL OR wa_messages.body = '' OR wa_messages.msg_type = 'status'`
            ).bind(new Date().toISOString(), wamid, phone, previewBody).run();
          } catch (_) {}
        }
      } else {
        // Falló. Transitorio y bajo el tope → liberar para reintentar; permanente
        // o tope alcanzado → dejar marcado (no reintenta más) + registrar el motivo.
        const n = await bumpSendFail(env, 'cursosfu:' + phone);
        if (isTransientSendError(tpl) && n < SEND_FAIL_CAP) {
          try { await env.DB.prepare("UPDATE wa_cursos_campaign SET followup_at = NULL WHERE phone = ?").bind(phone).run(); } catch (_) {}
        } else {
          await clearSendFail(env, 'cursosfu:' + phone);
          await logWaEvent(env, { to: phone, kind: 'cursos-followup-giveup', ref: 'cursosfu:' + phone, ok: false, error: describeSendFailure(tpl) });
        }
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
      "SELECT phone, kind, sender_name FROM wa_autoreply_log WHERE kind IN ('minicurso','minicurso_gift','cursos_evento','junio_evento') AND status = 'queued' AND due_at <= ? AND due_at >= ? ORDER BY due_at ASC LIMIT 25"
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
      } else if (row.kind === 'junio_evento') {
        body = JUNIO_VIVO_MSG;
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
            `INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id, automated)
             VALUES (?, ?, 'outbound', ?, '', 'text', ?, 'sent', '', 1)
             ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'text', automated = 1
               WHERE wa_messages.body IS NULL OR wa_messages.body = '' OR wa_messages.msg_type = 'status'`
          ).bind(new Date().toISOString(), wamid, phone, body).run();
        } catch (_) {}
      }
      // El evento de cursos/junio: recién acá (tras mandarlo) se revela el chat a Abril.
      if (row.kind === 'cursos_evento' || row.kind === 'junio_evento') {
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
        // Transitorio y bajo el tope → liberar para reintentar; permanente
        // (ventana cerrada, etc.) o tope alcanzado → marcar 'failed' (no reintenta más).
        const n = await bumpSendFail(env, 'minifu:' + phone);
        if (isTransientSendError(res) && n < SEND_FAIL_CAP) {
          try { await env.DB.prepare("DELETE FROM wa_autoreply_log WHERE phone = ? AND kind = 'minicurso_followup' AND status = 'queued'").bind(phone).run(); } catch (_) {}
        } else {
          await clearSendFail(env, 'minifu:' + phone);
          try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'failed', sent_at = ? WHERE phone = ? AND kind = 'minicurso_followup'").bind(now, phone).run(); } catch (_) {}
          await logWaEvent(env, { to: phone, kind: 'minicurso-followup-giveup', ref: 'minifu:' + phone, ok: false, error: describeSendFailure(res) });
        }
        continue;
      }
      await clearSendFail(env, 'minifu:' + phone);
      try { await env.DB.prepare("UPDATE wa_autoreply_log SET status = 'sent', sent_at = ? WHERE phone = ? AND kind = 'minicurso_followup'").bind(now, phone).run(); } catch (_) {}
      const wamid = res.id || '';
      if (wamid) {
        try {
          await env.DB.prepare(
            `INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id, automated)
             VALUES (?, ?, 'outbound', ?, '', 'text', ?, 'sent', '', 1)
             ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'text', automated = 1
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
    const _adVert = await adVerticalForSource(env, attrib.source_id, attrib.campaign_name, attrib.ad_name, attrib.headline, attrib.ad_body);
    header += `\nVERTICAL DEFINIDA POR EL AD: ${_adVert.toUpperCase()} — el cliente entro desde un anuncio de ${_adVert}, asi que NO hay ambiguedad carteles/cursos. Asumi ${_adVert} y anda directo a ese flujo (NO preguntes si busca un cartel o si quiere aprender/cursos).`;
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

// Clasifica un lead que vino de un AD de Meta en su vertical de NEGOCIO:
// 'cursos' (quiere aprender / comunidad / Neon Mastery / Supernova) o 'carteles'
// (quiere o vende carteles). Mira el texto disponible del ad (campaña / nombre /
// headline / copy). Conservador: cursos SOLO con senales fuertes; el resto cae
// en carteles (la mayoria de los click-to-WhatsApp, y el comercial puede re-derivar).
function classifyAdVertical(...parts) {
  const t = parts.filter(Boolean).join(' ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/\bcurso|mastery|comunidad|supernova|al infinito|aprend(e|er|iz)|emprend/.test(t)) return 'cursos';
  return 'carteles';
}

// Vertical de un ad priorizando el MAPA explicito por ad_id (wa_ad_verticals,
// poblado a mano / desde Meta Ads cuando el texto no alcanza — ej. ads de cursos
// con headline de carteles). Si no esta mapeado, cae en la heuristica por texto.
async function adVerticalForSource(env, sourceId, ...parts) {
  if (sourceId) {
    try {
      const row = await env.DB.prepare("SELECT vertical FROM wa_ad_verticals WHERE ad_id = ?").bind(String(sourceId)).first();
      if (row && row.vertical) return row.vertical;
    } catch (_) { /* la tabla puede no existir aun → cae en la heuristica */ }
  }
  return classifyAdVertical(...parts);
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
// ===== Instagram DM — flag + procesador (Fase 2a: SOLO recibir + clasificar) =====
// Gateado por kv_cache 'ig_inbox_on' (default OFF). Cuando está ON, guarda el DM en
// wa_messages (channel='ig') y rutea el chat: a 'cursos' SOLO si la trazabilidad del
// ad (wa_ad_verticals vía adVerticalForSource) o el contenido lo confirman; si no,
// 'general'. NO responde nada. WhatsApp queda intacto (channel='wa').
async function igInboxOn(env) {
  try { const r = await env.DB.prepare("SELECT v FROM kv_cache WHERE k = 'ig_inbox_on'").first(); return !!r && String(r.v) === '1'; } catch (_) { return false; }
}
// Resuelve nombre + @usuario de un IG user id (el que escribe) vía Graph API.
// Token de IG: priorizamos el de kv_cache (que el cron va refrescando antes de que venza)
// y caemos al secret IG_ACCESS_TOKEN como semilla inicial. Así el token se auto-renueva
// sin que Gaspar tenga que re-pegarlo cada 60 días.
async function igGetToken(env) {
  try { const r = await env.DB.prepare("SELECT v FROM kv_cache WHERE k='ig_access_token'").first(); if (r && r.v) return r.v; } catch (_) {}
  return env.IG_ACCESS_TOKEN || '';
}

// Envía un DM de IG por la Graph API (Instagram con Instagram Login). El que envía es
// 'me' (la cuenta del token). Devuelve { ok, id, error }. NO valida la ventana de 24h:
// eso lo hace el endpoint antes de llamar acá.
async function igSend(env, recipientId, text) {
  const token = await igGetToken(env);
  if (!token) return { ok: false, error: 'no IG token' };
  try {
    const r = await fetch('https://graph.instagram.com/v21.0/me/messages?access_token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: String(recipientId) }, message: { text: String(text) } })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) return { ok: false, error: (j.error && (j.error.error_user_msg || j.error.message)) || ('http ' + r.status), raw: j };
    return { ok: true, id: j.message_id || j.id || '' };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// Manda una IMAGEN por IG (Graph API). IG baja la imagen de una URL PUBLICA
// (usamos /admin/media/<key>, que se sirve sin auth). El caption NO va en el
// attachment: se manda como texto aparte (lo hace el endpoint).
async function igSendImage(env, recipientId, imageUrl) {
  const token = await igGetToken(env);
  if (!token) return { ok: false, error: 'no IG token' };
  try {
    const r = await fetch('https://graph.instagram.com/v21.0/me/messages?access_token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: String(recipientId) }, message: { attachment: { type: 'image', payload: { url: String(imageUrl), is_reusable: false } } } })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) return { ok: false, error: (j.error && (j.error.error_user_msg || j.error.message)) || ('http ' + r.status), raw: j };
    return { ok: true, id: j.message_id || j.id || '' };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// Manda un audio por IG (attachment type=audio con URL pública que IG descarga). Igual que
// igSendImage pero type=audio. El audio se sirve desde R2 vía /admin/media/ (sin token).
async function igSendAudio(env, recipientId, audioUrl) {
  const token = await igGetToken(env);
  if (!token) return { ok: false, error: 'no IG token' };
  try {
    const r = await fetch('https://graph.instagram.com/v21.0/me/messages?access_token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: String(recipientId) }, message: { attachment: { type: 'audio', payload: { url: String(audioUrl), is_reusable: false } } } })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) return { ok: false, error: (j.error && (j.error.error_user_msg || j.error.message)) || ('http ' + r.status), raw: j };
    return { ok: true, id: j.message_id || j.id || '' };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// Refresca el token largo de IG (válido 60 días) por otro de 60 días. Solo corre si pasaron
// >24h del último refresco (gate en kv_cache). Si el token no es renovable o falla, no rompe
// nada: igGetToken sigue usando el último válido. Se llama desde el cron.
async function igMaybeRefreshToken(env) {
  try {
    const last = await env.DB.prepare("SELECT v FROM kv_cache WHERE k='ig_token_refreshed_at'").first();
    const lastTs = last && last.v ? new Date(last.v).getTime() : 0;
    if (lastTs && (Date.now() - lastTs) < 24 * 3600 * 1000) return; // ya refrescado hoy
    const token = await igGetToken(env);
    if (!token) return;
    const r = await fetch('https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=' + encodeURIComponent(token));
    const j = await r.json().catch(() => ({}));
    const now = new Date().toISOString();
    if (r.ok && j.access_token) {
      await env.DB.prepare("INSERT INTO kv_cache (k, v, updated_at) VALUES ('ig_access_token', ?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at").bind(j.access_token, now).run();
      await env.DB.prepare("INSERT INTO kv_cache (k, v, updated_at) VALUES ('ig_token_refreshed_at', ?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at").bind(now, now).run();
      try { await env.DB.prepare("INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)").bind(now, 'IG: token refrescado, +' + (j.expires_in || '?') + 's').run(); } catch (_) {}
    } else {
      // No marcamos refreshed_at: reintenta en el próximo cron. Logueamos para visibilidad.
      try { await env.DB.prepare("INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)").bind(now, 'IG: refresh token FALLÓ: ' + JSON.stringify(j).slice(0, 200)).run(); } catch (_) {}
    }
  } catch (_) {}
}

// Cachea en wa_contacts para no re-pegarle a la API en cada mensaje. Si no hay token
// o falla, devuelve '' (el chat muestra el id hasta que se resuelva).
async function igResolveName(env, igId) {
  const token = await igGetToken(env);
  if (!token || !igId) return '';
  let cachedName = '';
  try {
    const c = await env.DB.prepare("SELECT name, username, pic_url, updated_at FROM wa_contacts WHERE phone = ?").bind(igId).first();
    if (c && c.name) {
      cachedName = c.name;
      // Cacheado COMPLETO (nombre + @usuario + foto) y FRESCO (<20 días, antes de que venza
      // la URL de IG, que caduca en semanas) -> no le pegamos a la API. Si falta algo o está
      // vieja, re-resolvemos: así los contactos viejos se auto-reparan en su próximo DM.
      const fresh = c.updated_at && (Date.now() - new Date(c.updated_at).getTime()) < 20 * 86400000;
      if (c.pic_url && c.username && fresh) return c.name;
    }
  } catch (_) {}
  try {
    const r = await fetch(`https://graph.instagram.com/${encodeURIComponent(igId)}?fields=name,username,profile_pic&access_token=${encodeURIComponent(token)}`);
    const j = await r.json();
    if (j && !j.error) {
      const name = j.name || (j.username ? '@' + j.username : '') || cachedName;
      const username = j.username || '';
      const pic = j.profile_pic || '';
      if (name || pic || username) { try { await env.DB.prepare("INSERT INTO wa_contacts (phone, name, username, pic_url, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(phone) DO UPDATE SET name=excluded.name, username=excluded.username, pic_url=excluded.pic_url, updated_at=excluded.updated_at").bind(igId, name, username, pic, new Date().toISOString()).run(); } catch (_) {} }
      return name;
    }
  } catch (_) {}
  return cachedName;
}

// Baja una media de IG (imagen/video/audio/doc que mandó el cliente) y la guarda en R2,
// igual que con WhatsApp. Las URLs de IG (lookaside.fbsbx.com) vencen en horas, por eso
// hay que cachear el binario. Devuelve la R2 key (ej 'ig/<mid>.jpg') o '' si falla.
async function downloadIgMedia(env, url, mid, attType) {
  if (!url || !env.MEDIA) return '';
  try {
    // UA de navegador: lookaside.fbsbx.com le sirve HTML/403 a clientes sin UA (como el fetch
    // por defecto de Workers). Con UA de navegador devuelve el binario real.
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'image/avif,image/webp,image/apng,image/*,video/*,*/*' } });
    if (!res.ok) { try { await env.DB.prepare("INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)").bind(new Date().toISOString(), 'IG_MEDIA_FAIL http ' + res.status).run(); } catch (_) {} return ''; }
    const mime = res.headers.get('content-type') || 'application/octet-stream';
    // Si la URL de IG ya venció, devuelve una página de error HTML con 200. NO la guardamos
    // como si fuera media (si no, el chat muestra un "archivo" roto). Solo media real.
    if (!/^(image|video|audio|application\/pdf|application\/octet-stream)/i.test(mime)) { try { await env.DB.prepare("INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)").bind(new Date().toISOString(), 'IG_MEDIA_SKIP mime=' + mime).run(); } catch (_) {} return ''; }
    const ext = mime.includes('jpeg') || mime.includes('jpg') ? '.jpg'
      : mime.includes('png') ? '.png'
      : mime.includes('webp') ? '.webp'
      : mime.includes('gif') ? '.gif'
      : mime.includes('mp4') ? '.mp4'
      : mime.includes('quicktime') ? '.mov'
      : mime.includes('ogg') || mime.includes('opus') ? '.ogg'
      : mime.includes('mpeg') || mime.includes('mp3') ? '.mp3'
      : mime.includes('aac') || mime.includes('m4a') ? '.m4a'
      : mime.includes('pdf') ? '.pdf' : '';
    // CLAVE: NO truncar corto. Los mid de Instagram comparten un prefijo largo
    // (formato + IDs de página/thread) y la parte ÚNICA (message id) viene al
    // final (~char 110+). Truncar a 80 hacía colisionar imágenes de DISTINTOS
    // chats en la misma key de R2 → se pisaban (un cliente veía la foto de otro).
    // 300 captura el mid completo (los de IG rondan los 150 chars) y queda único.
    const safe = String(mid || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 300) || ('m' + (attType || 'media'));
    const blob = await res.arrayBuffer();
    const key = `ig/${safe}${ext}`;
    await env.MEDIA.put(key, blob, { httpMetadata: { contentType: mime } });
    return key;
  } catch (_) { return ''; }
}
// Sincroniza el mapa media_id -> {ad_id, ad_name, campaign} de la cuenta de Meta Ads, para
// darle a los leads de IG (que responden a un post promocionado) la MISMA trazabilidad que
// WhatsApp: el webhook de IG solo trae el título del aviso, no el ad_id; acá lo resolvemos.
// Necesita un token con permiso ads_read. Devuelve {ok, count, error} para diagnóstico.
async function syncIgAdMap(env) {
  const token = env.META_ADS_TOKEN || env.META_PAGE_ACCESS_TOKEN || env.IG_ACCESS_TOKEN || '';
  if (!token) return { ok: false, error: 'no token' };
  const acct = String(env.META_AD_ACCOUNT_ID || '882517310728279').replace(/^act_/, '');
  try { await env.DB.prepare("CREATE TABLE IF NOT EXISTS ig_ad_map (media_id TEXT PRIMARY KEY, ad_id TEXT, ad_name TEXT, campaign_name TEXT, updated_at TEXT)").run(); } catch (_) {}
  let url = `https://graph.facebook.com/v21.0/act_${acct}/ads?fields=id,name,campaign{name},creative{effective_instagram_media_id}&limit=200&access_token=${encodeURIComponent(token)}`;
  let count = 0, pages = 0, error = '';
  try {
    while (url && pages < 25) {
      const r = await fetch(url);
      const j = await r.json();
      if (j.error) { error = '(#' + (j.error.code || '?') + ') ' + (j.error.message || ''); break; }
      for (const ad of (j.data || [])) {
        const mid = ad.creative && ad.creative.effective_instagram_media_id;
        if (!mid) continue;
        try {
          await env.DB.prepare("INSERT INTO ig_ad_map (media_id, ad_id, ad_name, campaign_name, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET ad_id=excluded.ad_id, ad_name=excluded.ad_name, campaign_name=excluded.campaign_name, updated_at=excluded.updated_at")
            .bind(String(mid), String(ad.id || ''), String(ad.name || ''), String(ad.campaign && ad.campaign.name || ''), new Date().toISOString()).run();
          count++;
        } catch (_) {}
      }
      url = (j.paging && j.paging.next) || '';
      pages++;
    }
  } catch (e) { error = String(e); }
  return { ok: !error, count, pages, error };
}
async function processIgWebhook(env, body) {
  if (body?.object !== 'instagram') return;
  for (const entry of (body?.entry || [])) {
    for (const m of (entry?.messaging || [])) {
      try {
        const msg = m?.message;
        if (!msg) continue;
        // ECHO = lo que mandamos NOSOTROS (desde el CRM, la app de IG, ManyChat o GHL). Antes
        // los descartábamos y por eso no se veían los mensajes enviados. Ahora los guardamos
        // como 'outbound'. Dedup: el mid del echo == el id que devuelve nuestro envío, así que
        // INSERT OR IGNORE no duplica los que ya guardó /admin/ig/send.
        const isEcho = !!msg.is_echo;
        // La "phone" (clave del chat) SIEMPRE es el cliente: en inbound es el sender; en echo,
        // el sender somos nosotros y el cliente es el recipient.
        const custId = isEcho ? m?.recipient?.id : m?.sender?.id;
        if (!custId) continue;
        const direction = isEcho ? 'outbound' : 'inbound';
        const mid = msg.mid || ('ig-' + custId + '-' + (m.timestamp || ''));
        const att = Array.isArray(msg.attachments) ? msg.attachments[0] : null;
        const attType = att?.type || '';
        // ig_post / share / story_mention / ig_reel = referencia al ANUNCIO o publicación a la
        // que respondió el cliente (NO una imagen que mandó). Lo mostramos como aviso con el
        // título del aviso, no como "imagen no disponible".
        const isAdRef = ['ig_post', 'share', 'story_mention', 'ig_reel'].includes(attType);
        let msgType, body, rawMediaUrl = '';
        if (isAdRef) {
          msgType = 'text';
          const adTitle = String(att?.payload?.title || '').replace(/\s+/g, ' ').trim();
          body = '📢 Respondió a un anuncio' + (adTitle ? ': "' + adTitle.slice(0, 140) + (adTitle.length > 140 ? '…' : '') + '"' : '');
        } else if (att) {
          msgType = attType === 'image' ? 'image' : attType === 'video' ? 'video' : attType === 'audio' ? 'audio' : 'document';
          rawMediaUrl = att?.payload?.url || '';
          body = msg.text || '';
        } else {
          msgType = 'text';
          body = msg.text || '';
        }
        // Hora REAL del mensaje (epoch ms del webhook), no la de ahora -> así el replay de logs
        // viejos respeta el orden cronológico de la conversación.
        // Hora REAL del mensaje (epoch ms del webhook), no la de ahora -> así el replay de logs
        // viejos respeta el orden cronológico de la conversación.
        const ts = m.timestamp ? new Date(m.timestamp).toISOString() : new Date().toISOString();
        // Media a R2 (la URL de IG vence en horas). No aplica a ad refs.
        let storedMedia = rawMediaUrl;
        if (rawMediaUrl && env.MEDIA) {
          const k = await downloadIgMedia(env, rawMediaUrl, mid, attType);
          if (k) storedMedia = k;
        }
        // Echo de story/reacción/share SIN texto ni media -> nada que mostrar. No lo guardamos
        // (si no, aparece una fila vacía que se ve como "[text]" en la lista).
        if (!isAdRef && !String(body).trim() && !storedMedia) continue;
        // Nombre del cliente: en inbound es el sender; en echo igual lo resolvemos (populando
        // wa_contacts) para que los contactos a los que SOLO les escribimos no salgan como el ID.
        // El sender_name del mensaje va '' en echo (el remitente somos nosotros).
        const senderName = isEcho ? '' : await igResolveName(env, custId);
        if (isEcho) { try { await igResolveName(env, custId); } catch (_) {} }
        // 1) Guardar el mensaje (channel='ig'). El trigger arma resumen + nombre.
        try {
          await env.DB.prepare(
            "INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', 'ig')"
          ).bind(ts, mid, direction, custId, senderName, msgType, body, storedMedia).run();
          // Si el mensaje YA existía con una media_url vieja (key truncada que se
          // pisaba entre chats), la corregimos a la key nueva re-descargada. Esto
          // hace que /admin/ig/replay-logs RECUPERE las imágenes cuya URL de IG
          // siga viva (las vencidas no se pueden re-bajar).
          if (storedMedia && String(storedMedia).startsWith('ig/')) {
            await env.DB.prepare("UPDATE wa_messages SET media_url = ? WHERE wamid = ? AND media_url LIKE 'ig/%' AND media_url != ?").bind(storedMedia, mid, storedMedia).run();
          }
        } catch (_) {}
        // Canal IG siempre (también si la conversación arranca con un echo de automatización).
        try { await env.DB.prepare("UPDATE wa_chats_summary SET channel='ig' WHERE phone = ?").bind(custId).run(); } catch (_) {}
        // Bandeja por CONTENIDO de cursos (mensaje entrante o echo saliente): el opener de cursos
        // en IG lo manda una herramienta externa (ManyChat/GHL) o se manda a mano, así que el
        // worker lo ve solo como mensaje. Si el texto tiene marcadores fuertes de cursos, mandamos
        // el chat a la bandeja de Abril (sin pisar asignación manual). Sin esto, el lead de cursos
        // que entra por IG cae en 'general' porque se clasifica por el texto de su respuesta.
        try {
          if (/neoninfinito\.com|mastery|minicurso|curso\s+gratuito|comunidad\s+al\s+infinito|supernova/i.test(String(body || ''))) {
            await env.DB.prepare("UPDATE wa_chats_summary SET inbox='cursos', updated_at = ? WHERE phone = ? AND (inbox IS NULL OR inbox IN ('general','oculto',''))").bind(ts, custId).run();
          }
        } catch (_) {}
        // 2) Clasificación de vertical + bandeja: SOLO para mensajes ENTRANTES del cliente.
        if (!isEcho) {
          const ref = msg.referral || m.referral || null;
          const adId = ref && ref.ad_id ? String(ref.ad_id) : '';
          let vert;
          if (adId) vert = await adVerticalForSource(env, adId, body, String(ref?.ref || ''), String(ref?.ad_title || ''));
          else vert = classifyAdVertical(body);
          const esCursos = vert === 'cursos';
          // Canal IG; bandeja 'cursos' SOLO si es seguro (sin pisar asignación manual previa),
          // default 'general'. Mismo criterio que WhatsApp.
          try {
            if (esCursos) {
              await env.DB.prepare("UPDATE wa_chats_summary SET inbox='cursos' WHERE phone = ? AND (inbox IS NULL OR inbox IN ('general','oculto',''))").bind(custId).run();
            } else {
              await env.DB.prepare("UPDATE wa_chats_summary SET inbox='general' WHERE phone = ? AND (inbox IS NULL OR inbox = '')").bind(custId).run();
            }
          } catch (_) {}
          // Atribución de anuncio (igual que CTWA en WhatsApp): si el cliente vino de un anuncio
          // (referral con ad_id) o respondió al post de un aviso (ig_post), lo guardamos en
          // wa_ad_attributions -> el banner del chat aparece solo (mismo endpoint que WhatsApp).
          try {
            let adAttr = null;
            if (ref && (ref.ad_id || ref.ref)) {
              const ctx = ref.ads_context_data || {};
              adAttr = { sid: String(ref.ad_id || ''), stype: String(ref.type || ref.source || 'ad'), head: String(ctx.ad_title || ''), img: String(ctx.photo_url || ''), vid: String(ctx.video_url || '') };
            } else if (isAdRef && att) {
              const p = att.payload || {};
              const mediaId = String(p.ig_post_media_id || p.id || '');
              // Si el mapa de Meta Ads tiene este post promocionado, usamos el ad_id REAL + campaña
              // (paridad total con WhatsApp: el frontend arma el link "Ver" a la biblioteca de Meta).
              let mapped = null;
              try { mapped = await env.DB.prepare("SELECT ad_id, ad_name, campaign_name FROM ig_ad_map WHERE media_id = ?").bind(mediaId).first(); } catch (_) {}
              const tituloAviso = String(p.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
              adAttr = {
                sid: (mapped && mapped.ad_id) ? mapped.ad_id : mediaId,
                stype: (mapped && mapped.ad_id) ? 'ad' : attType,   // 'ad' habilita el link "Ver" en el banner
                head: tituloAviso || (mapped && mapped.ad_name) || '',
                body: (mapped && mapped.campaign_name) ? ('Campaña: ' + mapped.campaign_name) : '',
                img: String(p.url || ''), vid: ''
              };
            }
            if (adAttr) {
              const exists = await env.DB.prepare('SELECT 1 FROM wa_ad_attributions WHERE wamid = ?').bind(mid).first();
              if (!exists) {
                await env.DB.prepare(`INSERT INTO wa_ad_attributions (phone, wamid, ts, source_id, source_type, source_url, headline, body, media_type, image_url, video_url, thumbnail_url, ctwa_clid, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
                  custId, mid, ts, adAttr.sid, adAttr.stype, '', adAttr.head, adAttr.body || '', 'instagram', adAttr.img, adAttr.vid, '', '', new Date().toISOString()
                ).run();
              }
            }
          } catch (_) {}
          await logWaEvent(env, { to: custId, kind: 'ig-inbound', ref: 'ig:' + custId, ok: true, error: vert || '' });
        }
      } catch (e) {
        try { await env.DB.prepare("INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)").bind(new Date().toISOString(), 'IG_ERR: ' + (e?.message || String(e))).run(); } catch (_) {}
      }
    }
  }
}

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
              `INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id, automated)
               VALUES (?, ?, 'outbound', ?, '', 'template', ?, 'sent', '', 1)
               ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'template', automated = 1
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

    // CAPI: avisar a Meta que entró un lead B2B (para optimización de la pauta).
    // El lead_id matchea el evento con el lead del anuncio. No-op si no hay token.
    try { await sendCapiEvent(env, { leadId: leadgenId, phone: phoneNorm, email, eventName: 'Lead', ref: 'sheet:' + leadgenId }); } catch (_) {}

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
            `INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id, automated)
             VALUES (?, ?, 'outbound', ?, '', 'template', ?, 'sent', '', 1)
             ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'template', automated = 1
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

// Registra un lead de la LANDING del minicurso: normaliza el teléfono, dedup, e
// inserta en minicurso_landing con el opener programado a +45min. NO manda nada
// acá — el opener lo dispara el cron processMinicursoLanding (con guardia + horario).
async function processMinicursoLead(env, body) {
  try {
    const phoneRaw = String(body?.phone || body?.telefono || body?.['teléfono'] || body?.phone_number || body?.celular || '').trim();
    const nombreRaw = String(body?.firstName || body?.first_name || body?.nombre || body?.name || '').trim();
    const phone = normalizeArPhone(phoneRaw) || '';
    if (!phone) {
      try { await env.DB.prepare('INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)').bind(new Date().toISOString(), 'MINICURSO_LEAD_NO_PHONE: ' + JSON.stringify(body).slice(0, 500)).run(); } catch (_) {}
      return;
    }
    // Primer nombre, sin puntuación/números (evita openers tipo "holaa Andrés,,").
    const nombre = (nombreRaw.split(/\s+/)[0] || '').replace(/[^\p{L}\p{M}'\-]/gu, '');
    // Dedup: si ya está registrado (en cualquier estado), no re-encolamos.
    try { const ex = await env.DB.prepare('SELECT 1 AS x FROM minicurso_landing WHERE phone = ?').bind(phone).first(); if (ex) return; } catch (_) {}
    const now = new Date().toISOString();
    const due = new Date(Date.now() + MINICURSO_LANDING_DELAY_MS).toISOString();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO minicurso_landing (phone, nombre, stage, registered_at, opener_due_at, source, updated_at, created_at) VALUES (?, ?, 'registered', ?, ?, 'landing', ?, ?)"
    ).bind(phone, nombre, now, due, now, now).run();
  } catch (err) {
    try { await env.DB.prepare('INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)').bind(new Date().toISOString(), 'MINICURSO_LEAD_ERR: ' + (err?.message || String(err))).run(); } catch (_) {}
  }
}

// ============================================================================
// Leads B2B de REVENTA (revendedores). Un App Script en el Sheet de reventa
// reenvía cada fila nueva a POST /webhook/reventa-lead. Filtramos los
// CUALIFICADOS (tiene experiencia en venta Y clientes) y a esos les mandamos la
// plantilla lead_reventa_apertura (firmada por Gaspar), los etiquetamos
// "revendedor", los dejamos en la bandeja general (los ven Joaco y Gaspar, Abril
// no) y le avisamos a Gaspar por WhatsApp. Los NO cualificados no se tocan: van
// al minicurso por la página E2 del formulario. Kill-switch OFF por defecto.
// ============================================================================
async function reventaOn(env) { return (await kvGet(env, 'reventa_on', '0')) === '1'; }
// ¿La respuesta descalifica? (P1/P2 en "No"). Normaliza mayúsculas y acentos.
function reventaEsNo(s) {
  const t = String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return t === 'no' || t.startsWith('no ') || t.startsWith('no,') || t.startsWith('no.');
}

async function processReventaLead(env, body) {
  try {
    const row = body?.row_data || body || {};
    // Claves del Sheet normalizadas (sin mayúsculas ni acentos) para matchear seguro.
    const lc = {};
    for (const k of Object.keys(row)) { const nk = String(k).toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, ''); lc[nk] = row[k]; }
    const pick = (...keys) => { for (const key of keys) { for (const rk of Object.keys(lc)) { if (rk.includes(key)) return String(lc[rk] || '').trim(); } } return ''; };

    const leadId = String(lc['id'] || lc['lead_id'] || lc['leadgen_id'] || '').trim();
    if (!leadId) { try { await env.DB.prepare('INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)').bind(new Date().toISOString(), 'REVENTA_NO_ID: ' + JSON.stringify(body).slice(0, 400)).run(); } catch (_) {} return; }
    // Dedup por lead_id.
    try { const ex = await env.DB.prepare('SELECT 1 AS x FROM reventa_leads WHERE lead_id = ?').bind(leadId).first(); if (ex) return; } catch (_) {}

    const phoneRaw = String(lc['phone'] || lc['phone_number'] || lc['telefono'] || lc['celular'] || '').trim();
    const nombreRaw = String(lc['full_name'] || lc['nombre_completo'] || lc['name'] || lc['nombre'] || '').trim();
    const p1 = pick('experiencia');                 // ¿tenés experiencia en venta de productos?
    const p2 = pick('clientes');                    // ¿tenes clientes para venderles?
    const p3 = pick('rubro', 'dedica');             // ¿te dedicás a alguno de estos rubros?
    const phone = normalizeArPhone(phoneRaw) || '';
    const nombre = (nombreRaw.split(/\s+/)[0] || '').replace(/[^\p{L}\p{M}'\-]/gu, '');
    // Cualifica si tiene experiencia (P1 ≠ No) Y clientes (P2 ≠ No).
    const cualif = !!p1 && !!p2 && !reventaEsNo(p1) && !reventaEsNo(p2);
    const now = new Date().toISOString();

    // Registrar siempre (dedup + métricas), cualifique o no.
    try {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO reventa_leads (lead_id, ts, phone, nombre, p1_experiencia, p2_clientes, p3_rubro, cualificado, template_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(leadId, now, phone, nombre, p1, p2, p3, cualif ? 1 : 0, cualif ? 'pending' : 'skipped', now).run();
    } catch (e) { try { await env.DB.prepare('INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)').bind(new Date().toISOString(), 'REVENTA_INSERT_ERR: ' + (e?.message || String(e))).run(); } catch (_) {} return; }

    // No cualificado o sin teléfono: no lo tocamos (va al minicurso por la página E2).
    if (!cualif || !phone) return;
    // Kill-switch: si está OFF, quedó registrado pero no mandamos nada.
    if (!(await reventaOn(env))) return;

    // 1) Plantilla de apertura (fuera de ventana: el lead nunca nos escribió).
    const nombreTpl = capitalizeName(nombre) || 'buenas';
    const res = await waSendTemplate(env, phone, 'lead_reventa_apertura', 'es_AR', [nombreTpl]);
    const sentTs = new Date().toISOString();
    if (res?.ok) {
      const wamid = res.id || '';
      try { await env.DB.prepare("UPDATE reventa_leads SET template_status = 'sent', template_sent_at = ?, wamid = ? WHERE lead_id = ?").bind(sentTs, wamid, leadId).run(); } catch (_) {}
      const preview = `Holaa ${nombreTpl}! Soy Gaspar de Neon Infinito. Vimos que te interesa sumarte como revendedor de nuestros neones LED. Contame, hoy tenés un local o vendés más por redes?`;
      if (wamid) { try { await env.DB.prepare("INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id, automated) VALUES (?, ?, 'outbound', ?, '', 'template', ?, 'sent', '', 1) ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'template', automated = 1 WHERE wa_messages.body IS NULL OR wa_messages.body = '' OR wa_messages.msg_type = 'status'").bind(sentTs, wamid, phone, preview).run(); } catch (_) {} }
    } else {
      try { await env.DB.prepare("UPDATE reventa_leads SET template_status = 'failed' WHERE lead_id = ?").bind(leadId).run(); } catch (_) {}
    }

    // 2) Bandeja general + etiqueta "revendedor" (los ven Joaco y Gaspar, Abril no).
    try { await env.DB.prepare("INSERT INTO wa_chats_summary (phone, inbox, updated_at) VALUES (?, 'general', ?) ON CONFLICT(phone) DO UPDATE SET inbox = 'general', updated_at = excluded.updated_at WHERE wa_chats_summary.inbox IS NULL OR wa_chats_summary.inbox IN ('oculto','')").bind(phone, sentTs).run(); } catch (_) {}
    try {
      const lab = await env.DB.prepare("SELECT id FROM labels WHERE name = 'revendedor'").first();
      if (lab?.id) await env.DB.prepare("INSERT OR IGNORE INTO contact_labels (phone, label_id, created_at) VALUES (?, ?, ?)").bind(phone, lab.id, sentTs).run();
    } catch (_) {}

    // 3) Avisar a Gaspar por WhatsApp (una sola vez por lead).
    try {
      const st = await env.DB.prepare("SELECT notif_sent FROM reventa_leads WHERE lead_id = ?").bind(leadId).first();
      if (!st?.notif_sent) {
        await precotizNotifyGaspar(env, `nuevo revendedor cualificado\n${nombreRaw || nombre || 's/nombre'} - ${phone}\nya le mandé la apertura, quedó en la bandeja general con etiqueta revendedor`);
        await env.DB.prepare("UPDATE reventa_leads SET notif_sent = 1 WHERE lead_id = ?").bind(leadId).run();
      }
    } catch (_) {}
  } catch (err) {
    try { await env.DB.prepare('INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)').bind(new Date().toISOString(), 'REVENTA_ERR: ' + (err?.message || String(err))).run(); } catch (_) {}
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
  '   CORRECTO: dibujá SOLO el contorno (perímetro) de la silueta como un tubo de neón. Por dentro de la silueta se ve la pared negra. La figura ya no es un shape relleno, es un outline brillante.',
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
  'El cartel ocupa el centro de la imagen, montado sobre una pared NEGRA lisa y pareja (negro pleno, NUNCA gris ni blanco). El fondo tiene que ser SIEMPRE negro: contra el negro el brillo y el color del neón contrastan y resaltan al máximo. Luz ambiente tenue (la luz la pone el propio neón), con el cartel bien visible. Sin objetos alrededor, sin decoración de fondo, sin elementos del entorno (cables visibles del transformador OK pero discretos).',
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
  '6. FONDO DEL CARTEL: el acrílico es transparente. Detrás solo la pared negra. No agregues atmósfera ni partículas decorativas que la referencia no tenga.',
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

// ===== Render de CORPÓREAS (letras 3D macizas) =====
// Mismo esquema que GEMINI_RENDER_PROMPT pero para letras corpóreas (no neón).
// La diferencia clave es de DÓNDE SALE LA LUZ según qué caras son translúcidas u
// opacas → colapsa en 5 casos visuales (A-E). El worker arma el bloque de contexto
// con el caso puntual (corporeaContexto) y lo appendea al final, igual que carteles.
const GEMINI_CORPOREA_RENDER_PROMPT = [
  'Sos especialista en carteles CORPÓREOS (letras 3D macizas). Generá un render hiperrealista del producto terminado a partir de la imagen de referencia adjunta.',
  '',
  '═══ REGLA #1 — FIDELIDAD ABSOLUTA AL DISEÑO ═══',
  'Sos fabricante, NO ilustrador. Copiá EXACTO de la referencia: composición, tipografía, formas, proporciones, poses. NO rediseñes ni reinterpretes.',
  '',
  '═══ QUÉ ES EL PRODUCTO: LETRA CORPÓREA 3D ═══',
  'Letras/logo MACIZOS en 3 dimensiones. NO es neón (no son tubos/contornos): son letras SÓLIDAS con cuerpo y profundidad. Cada letra es una "caja" con:',
  '- FRENTE: la cara de adelante (superficie llena, no hueca).',
  '- LATERALES: el canto/profundidad que le da volumen (~5-10 cm de fondo).',
  '- ESPALDA: el fondo, contra la pared. Lleva LED interno.',
  '',
  '═══ DE DÓNDE SALE LA LUZ (regla central) ═══',
  'Con luz, el LED escapa SOLO por las caras translúcidas; las opacas son color sólido.',
  '- Frente translúcido → la cara frontal BRILLA pareja (transiluminada).',
  '- Frente opaco → cara frontal color sólido, sin brillo.',
  '- Laterales translúcidos → los cantos BRILLAN.  |  Laterales opacos → cantos color sólido.',
  '- Espalda translúcida + frente opaco → la luz sale por atrás = HALO retroiluminado en la pared alrededor de la letra (efecto backlight).  |  Espalda opaca → sin halo.',
  'SIN LUZ → ninguna cara brilla, todo opaco, letra 3D de color sólido (tipo PVC/acrílico pintado).',
  '',
  '═══ LOS 5 CASOS (el contexto indica cuál) ═══',
  'A) frente translúcido + laterales translúcidos → toda la letra brilla como volumen de luz.',
  'B) frente translúcido + laterales opacos → cara frontal brilla, cantos color sólido.',
  'C) frente opaco + laterales translúcidos → frente color sólido, cantos brillan.',
  'D) frente opaco + laterales opacos + espalda translúcida → letra color sólido con HALO retroiluminado en la pared detrás.',
  'E) sin luz → letra 3D color sólido, sin ningún brillo ni halo.',
  '',
  '═══ COLOR ═══',
  'CADA cara tiene su propio color y el contexto los indica por separado (frente, laterales, espalda pueden ser de colores distintos).',
  'Cara TRANSLÚCIDA encendida → el material translúcido es de ESE color y la luz sale de ese color: la cara BRILLA en su color (frente translúcido verde → brilla verde; laterales translúcidos blancos → brillan blanco; frente translúcido azul → brilla azul). Si el contexto no indica color para una cara translúcida → blanco cálido por defecto.',
  'Cara OPACA → color sólido del contexto (cualquiera), sin brillo (la luz no la atraviesa).',
  '',
  '═══ VISTA ═══',
  'Leve 3/4 (perspectiva suave) para que se vea la PROFUNDIDAD y el volumen 3D, sobre pared neutra lisa, bien iluminada, sin objetos alrededor.',
  '',
  '═══ PRIORIDAD DE NOTAS ═══',
  'Aplicá las notas del contexto (color, agregados). NUNCA sobreescriben: fidelidad al diseño, que sea corpórea maciza 3D, y la regla de por dónde sale la luz.'
].join('\n');

// Prompt de rectificación de perspectiva: endereza una foto de un cartel a vista
// FRONTAL (herramienta del diseñador Emma). Es una corrección geométrica pura —
// preserva texto/tipografía/colores/proporciones. Usa la misma cañería de Gemini
// image que los renders (generarRenderConGemini con basePrompt).
const GEMINI_RECTIFY_PROMPT = [
  'Corregí la perspectiva de esta fotografía de un cartel. Transformá la imagen para mostrar el cartel en una vista FRONTAL perfecta (de frente, head-on), como si la cámara estuviera exactamente perpendicular y centrada al cartel.',
  '',
  'Corregí SOLO la geometría:',
  '- Eliminá toda la distorsión de perspectiva y el efecto keystone/trapezoidal.',
  '- Las líneas verticales quedan 100% verticales y las horizontales 100% horizontales; las esquinas del cartel forman ángulos rectos de 90 grados.',
  '- El cartel queda plano y de frente, sin inclinación, rotación ni punto de fuga.',
  '',
  'Mantené IDÉNTICO, sin alterar absolutamente nada:',
  '- El texto y la tipografía exactos (misma caligrafía, mismos trazos). NO reescribas ni cambies ninguna letra, número ni símbolo.',
  '- Los colores, el brillo y el color de luz del neón/LED, los reflejos y la iluminación.',
  '- Las proporciones reales, el grosor de los trazos, el logo y todos los detalles del diseño.',
  '',
  'Es una corrección geométrica, NO un rediseño: no agregues, quites, inventes ni reestilices nada. Mantené la calidad fotográfica original.',
  '',
  'Encuadrá el cartel centrado y recortado prolijo. Si al enderezar quedan bordes vacíos, completá el fondo de forma neutra y coherente. Devolvé únicamente la imagen final rectificada, sin texto ni marcas de agua.'
].join('\n');

// Prompt de vectorización: convierte una imagen (logo/texto) en una SILUETA MACIZA
// blanco y negro puro, lista para el Calco de Imagen de Illustrator (rellena huecos/
// contornos, alto contraste, sin grises). Herramienta del diseñador. Misma cañería.
const GEMINI_VECTORIZE_PROMPT = [
  'Convertí esta imagen en una SILUETA MACIZA en blanco y negro puro, lista para vectorizar con el Calco de Imagen (Image Trace) de Illustrator.',
  '',
  'Aislá el elemento gráfico principal (el logo o el texto) sobre un fondo BLANCO PURO (#FFFFFF), sin nada más alrededor.',
  '',
  'Convertí TODO a blanco y negro binario de máximo contraste:',
  '- Solo dos colores: negro pleno (#000000) para la figura, blanco puro (#FFFFFF) para el fondo. Nada intermedio.',
  '- Eliminá por completo cualquier gris, escala de grises, degradado, sombra, brillo, textura, reflejo o transparencia.',
  '',
  'Rellená las formas para que queden MACIZAS:',
  '- Si las letras o formas son huecas, contorneadas o tienen trazo doble/interno, rellenalas por completo de negro pleno.',
  '- Eliminá absolutamente cualquier trazo, línea o hueco BLANCO dentro de la figura. El interior de cada letra/forma queda negro sólido.',
  '',
  'Bordes limpios y DUROS (nítidos, sin desenfoque ni suavizado), formas simplificadas.',
  '',
  'REGLA CLAVE — fidelidad: NO rediseñes, NO cambies la tipografía, NO reinterpretes. Respetá EXACTO la forma, las proporciones, la composición y el texto del original (misma cantidad de letras, mismos trazos). Es una conversión a silueta, no un rediseño.',
  '',
  'Devolvé únicamente la imagen procesada (silueta negra sobre blanco), sin texto, marcas de agua ni bordes.'
].join('\n');

// ===== Analytics: funnel pre-cotización (carteles) =====
// Mide por mes (cohorte por PRIMER inbound del año, hora AR): leads nuevos, cuántos
// mandaron foto, cuántos medidas, cuántos recibieron presupuesto — y la cohorte
// "revivible" (últimos 60 días sin presupuesto, desglosada por qué dato falta).
// UN solo scan de wa_messages por query (agregación condicional, sin LIKE por el
// límite de D1) — para uso on-demand/cron, nunca en polls. Detección de presupuesto
// = la misma de producción (processPresupuestoFollowups) + los markers de plantilla.
async function analyticsPrecotizFunnel(env, url) {
  const desde = (url.searchParams.get('desde') || '2026-01-01') + 'T03:00:00Z'; // 00:00 AR
  const hoyMs = Date.now();
  const revDesde = new Date(hoyMs - 60 * 86400000).toISOString();
  const revHasta = new Date(hoyMs - 3 * 86400000).toISOString(); // 3 días de gracia (en curso)
  // per_phone: flags por teléfono en un solo scan. GLOB de medidas = aproximación
  // (el regex real vive en JS); excluye imágenes porque la descripción IA appendeada
  // ('[imagen] ...') mete números. Nota: acotar por ts hace que un cliente viejo que
  // vuelve cuente como nuevo — error aceptado, mismo criterio del análisis de mayo.
  const perPhone = (extraWhere) => `
    WITH per_phone AS (
      SELECT phone,
        CASE WHEN MAX(CASE WHEN channel='ig' THEN 1 ELSE 0 END)=1 THEN 'ig' ELSE 'wa' END AS canal,
        MIN(CASE WHEN direction='inbound'  AND msg_type!='status' THEN ts END) AS first_in_ts,
        MIN(CASE WHEN direction='outbound' AND msg_type!='status' THEN ts END) AS first_out_ts,
        MAX(CASE WHEN direction='inbound'  AND msg_type!='status' THEN ts END) AS last_in_ts,
        MAX(CASE WHEN direction='outbound' AND msg_type!='status' THEN ts END) AS last_out_ts,
        MAX(CASE WHEN direction='inbound' AND msg_type='image' THEN 1 ELSE 0 END) AS has_img,
        MAX(CASE WHEN direction='inbound' AND msg_type IN ('text','audio') AND (
              lower(body) GLOB '*[0-9]x[0-9]*'  OR lower(body) GLOB '*[0-9] x [0-9]*'
           OR lower(body) GLOB '*[0-9]x [0-9]*' OR lower(body) GLOB '*[0-9] x[0-9]*'
           OR lower(body) GLOB '*[0-9] por [0-9]*'
           OR lower(body) GLOB '*[0-9]cm*'      OR lower(body) GLOB '*[0-9] cm*'
           OR lower(body) GLOB '*[0-9] mts*'    OR lower(body) GLOB '*[0-9] metro*'
        ) THEN 1 ELSE 0 END) AS has_med,
        MAX(CASE WHEN direction='outbound' AND IFNULL(status,'')!='failed' AND (
              substr(body,1,26)='Te comparto el presupuesto'
           OR substr(body,1,26)='Te comparto la información'
           OR substr(body,1,34)='[plantilla: presupuesto_detallado]'
           OR substr(body,1,33)='[plantilla: presupuesto_corporea]'
        ) THEN 1 ELSE 0 END) AS has_quote
      FROM wa_messages
      WHERE ts >= ?1 AND phone IS NOT NULL AND phone != ''
        AND phone NOT IN ('5491137593269','5491155604999','5491155604996','5491144366573')
      GROUP BY phone
    ),
    leads AS (
      SELECT p.*, strftime('%Y-%m', datetime(first_in_ts,'-3 hours')) AS mes
      FROM per_phone p
      WHERE first_in_ts IS NOT NULL
        AND (first_out_ts IS NULL OR first_in_ts <= first_out_ts)  -- inbound-first (excluye broadcasts nuestros)
        AND p.phone NOT IN (SELECT phone FROM wa_chats_summary WHERE inbox='cursos')  -- solo carteles
        ${extraWhere || ''}
    )`;
  const qMensual = perPhone('') + `
    SELECT mes, COUNT(*) AS nuevos,
      SUM(canal='wa') AS wa, SUM(canal='ig') AS ig,
      SUM(has_img) AS con_foto, SUM(has_med) AS con_medidas,
      SUM(has_img*has_med) AS con_ambas,
      SUM(has_quote) AS cotizados,
      SUM(CASE WHEN has_quote=0 AND has_img=1 AND has_med=1 THEN 1 ELSE 0 END) AS listos_sin_cotizar,
      SUM(CASE WHEN has_quote=0 AND has_img=0 AND has_med=0 THEN 1 ELSE 0 END) AS sin_datos_sin_cotizar
    FROM leads GROUP BY mes ORDER BY mes`;
  const qRevival = perPhone(`AND p.first_in_ts >= '${revDesde}' AND p.first_in_ts <= '${revHasta}'
        AND p.phone NOT IN (SELECT phone FROM wa_unreachable_phones)`) + `
    SELECT canal, COUNT(*) AS total,
      SUM(CASE WHEN has_img=0 AND has_med=0 THEN 1 ELSE 0 END) AS sin_datos,
      SUM(CASE WHEN has_img=1 AND has_med=0 THEN 1 ELSE 0 END) AS solo_foto,
      SUM(CASE WHEN has_img=0 AND has_med=1 THEN 1 ELSE 0 END) AS solo_medidas,
      SUM(CASE WHEN has_img=1 AND has_med=1 THEN 1 ELSE 0 END) AS datos_completos,
      SUM(CASE WHEN last_out_ts IS NULL OR last_in_ts > last_out_ts THEN 1 ELSE 0 END) AS ultima_palabra_del_cliente
    FROM leads WHERE has_quote=0 GROUP BY canal`;
  const qBriefs = `
    SELECT strftime('%Y-%m', datetime(created_at,'-3 hours')) AS mes,
      COUNT(*) AS creados,
      SUM(CASE WHEN estado='enviado' THEN 1 ELSE 0 END) AS enviados,
      SUM(CASE WHEN lower(origen_lead)='ig' THEN 1 ELSE 0 END) AS ig
    FROM briefs WHERE created_at >= ?1 GROUP BY mes ORDER BY mes`;
  const out = { desde: desde, revival_ventana: { desde: revDesde, hasta: revHasta } };
  try { out.mensual = (await env.DB.prepare(qMensual).bind(desde).all()).results || []; }
  catch (e) { out.mensual_error = String(e && e.message || e); }
  try { out.revival = (await env.DB.prepare(qRevival).bind(desde).all()).results || []; }
  catch (e) { out.revival_error = String(e && e.message || e); }
  try { out.briefs = (await env.DB.prepare(qBriefs).bind(desde).all()).results || []; }
  catch (e) { out.briefs_error = String(e && e.message || e); }
  return json(out);
}

// Prompt de montaje/mockup: monta el render de un cartel sobre la foto del local del
// cliente, en la zona que el diseñador marcó con un recuadro. Hiperrealista, con glow
// del neón, SIN el cable de 220v. Herramienta del diseñador (2 imágenes de entrada).
const GEMINI_MOCKUP_PROMPT = [
  'Sos especialista en fotomontajes hiperrealistas de carteles de neón LED. Recibís DOS imágenes:',
  '1) La PRIMERA es la foto del frente/lugar del cliente. Tiene un recuadro marcado (un rectángulo dibujado encima) que indica EXACTAMENTE dónde y de qué tamaño va el cartel.',
  '2) La SEGUNDA es el cartel de neón solo (el render).',
  '',
  'Montá el cartel de la segunda imagen sobre la primera, EXACTAMENTE en la zona del recuadro y con ese tamaño. Reglas:',
  '- Integración HIPERREALISTA: ajustá la perspectiva, el ángulo y la escala del cartel para que calce natural con la pared/superficie del recuadro.',
  '- El neón ILUMINA de verdad: agregá el glow/resplandor del neón sobre la pared y el entorno cercano, con reflejos, luz y sombras coherentes con la escena (hora del día, materiales).',
  '- ELIMINÁ por completo el recuadro/marca: no debe quedar ningún rastro del rectángulo dibujado.',
  '- NO dibujes el cable de alimentación a 220v, ni transformadores, ni cables visibles: queda feo. El cartel va limpio, sin cables.',
  '- El resto de la foto (el local, la pared, el entorno) queda IDÉNTICO a la original, sin cambios.',
  '- No agregues texto, marcas de agua ni elementos que no estén en las imágenes.',
  '',
  'Devolvé únicamente la foto final con el cartel montado, fotorrealista.'
].join('\n');

// Dado un brief de corpórea (tipo='corporea' con corporea_json), determina el caso
// visual A-E (según qué caras son translúcidas/opacas + iluminación) y arma el bloque
// de contexto puntual que se appendea al GEMINI_CORPOREA_RENDER_PROMPT.
function corporeaContexto(brief) {
  let p = {};
  try { p = JSON.parse(brief.corporea_json || '{}') || {}; } catch { p = {}; }
  const conLuz = p.con_luz !== false; // default: con luz
  const fTrans = String(p.frente_acabado || 'translucido').toLowerCase().startsWith('transl');
  const lTrans = String(p.lat_acabado || 'translucido').toLowerCase().startsWith('transl');
  const eTrans = String(p.esp_acabado || 'opaca').toLowerCase().startsWith('transl');
  const mat = (p.frente_material === 'acrilico') ? 'acrílico' : 'impreso';
  let caso, efecto;
  if (!conLuz) {
    caso = 'E'; efecto = 'apagada: letra 3D de color sólido, sin ningún brillo ni halo (todas las caras opacas).';
  } else if (fTrans && lTrans) {
    caso = 'A'; efecto = 'toda la letra brilla como un volumen de luz (frente y cantos transiluminados).';
  } else if (fTrans && !lTrans) {
    caso = 'B'; efecto = 'la cara frontal brilla pareja, los cantos/laterales son color sólido.';
  } else if (!fTrans && lTrans) {
    caso = 'C'; efecto = 'el frente es color sólido, los cantos/laterales brillan.';
  } else if (!fTrans && !lTrans && eTrans) {
    caso = 'D'; efecto = 'letra de color sólido con HALO retroiluminado en la pared detrás (efecto backlight).';
  } else {
    caso = 'E'; efecto = 'todas las caras opacas con luz = no escapa luz, se ve como una letra 3D de color sólido sin brillo.';
  }
  // "Replicar diseño": el frente NO es un color sólido sino GRÁFICA IMPRESA full
  // color que reproduce el diseño de la imagen de referencia (logos multicolor
  // como Google/marcas — no se representan con un color único).
  const fReplicar = /replic|dise[ñn]o/i.test(String(p.frente_color || ''));
  const colF = fReplicar
    ? ' — GRÁFICA IMPRESA FULL COLOR: el frente reproduce EXACTAMENTE el diseño/logo de la imagen de referencia (todos sus colores, formas y tipografía tal cual), NO es un color sólido'
    : (p.frente_color ? `, color ${p.frente_color}` : '');
  const colL = p.lat_color ? `, color ${p.lat_color}` : '';
  const colE = p.esp_color ? `, color ${p.esp_color}` : '';
  const med = (p.ancho_cm && p.alto_cm) ? `${p.ancho_cm} × ${p.alto_cm} cm` : (brief.medidas_libre || 's/d');
  return [
    'CONTEXTO DE ESTA CORPÓREA (aplicá EXACTAMENTE este caso):',
    `- CASO ${caso}: ${efecto}`,
    `- Frente: ${fReplicar ? 'gráfica impresa' : mat}, ${fTrans ? 'translúcido (transilumina)' : 'opaco'}${colF}.`,
    `- Laterales: ${lTrans ? 'translúcidos (brillan)' : 'opacos'}${colL}.`,
    `- Espalda: ${eTrans ? 'translúcida (deja salir luz = halo)' : 'opaca'}${colE}.`,
    `- Iluminación: ${conLuz ? 'CON luz (LED encendido)' : 'SIN luz (apagada)'}.`,
    `- Medidas: ${med}.`
  ].join('\n');
}

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

// Precios de Gemini por 1M tokens (USD). En los modelos *-image, 'out' incluye los
// tokens de la imagen generada (el grueso del costo). Ajustables si Google cambia
// precios — la fuente de verdad sigue siendo la factura de Google.
const GEMINI_PRICES = {
  'gemini-3.1-flash-image': { in: 0.30, out: 30 },
  'gemini-2.5-flash-image': { in: 0.30, out: 30 },
  'gemini-3-pro-image':     { in: 2.00, out: 120 },
  'gemini-2.5-pro':         { in: 1.25, out: 5 },
  'gemini-2.5-flash':       { in: 0.30, out: 2.50 },
};
function geminiCost(model, usage) {
  if (!usage) return 0;
  const p = GEMINI_PRICES[model] || GEMINI_PRICES['gemini-2.5-flash-image'];
  const ti = usage.promptTokenCount || 0;
  const to = usage.candidatesTokenCount || Math.max(0, (usage.totalTokenCount || 0) - ti);
  return (ti * p.in + to * p.out) / 1e6;
}
// Registra un uso de Gemini (render | params) con su costo estimado en gemini_usage.
async function geminiTrackUsage(env, model, kind, usage, ref) {
  try {
    const ti = (usage && usage.promptTokenCount) || 0;
    const to = (usage && usage.candidatesTokenCount) || 0;
    await env.DB.prepare(
      "INSERT INTO gemini_usage (ts, model, kind, tokens_in, tokens_out, cost_usd, ref) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(new Date().toISOString(), model || '', kind || 'render', ti, to, geminiCost(model, usage), String(ref || '')).run();
  } catch (_) {}
}

// Toma el boceto (bytes + mime) + medidas, llama a Gemini, devuelve { ok, base64, mime }
// con la imagen generada, o { error }.
async function generarRenderConGemini(env, bocetoBuf, bocetoMime, extraTexto, opts = {}) {
  if (!env.GEMINI_API_KEY) return { error: 'GEMINI_API_KEY no configurada' };
  const model = geminiImageModel(env);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  // basePrompt permite usar otro prompt (ej. corpóreas) sin tocar el de carteles.
  const basePrompt = opts.basePrompt || GEMINI_RENDER_PROMPT;
  const promptText = basePrompt + (extraTexto ? `\n\n${extraTexto}` : '');
  const reqParts = [
    { text: promptText },
    { inline_data: { mime_type: bocetoMime || 'image/png', data: opts.mainBase64 || abToBase64(bocetoBuf) } }
  ];
  // Imágenes extra (ej: montaje = foto del local marcada + render del cartel). Van
  // después de la principal, en el orden que las referencia el prompt.
  if (Array.isArray(opts.extraImages)) {
    for (const im of opts.extraImages) {
      if (im && im.base64) reqParts.push({ inline_data: { mime_type: im.mime || 'image/png', data: im.base64 } });
    }
  }
  const body = {
    contents: [{ parts: reqParts }],
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
  // Registrar el costo de este render (tokens reales que devuelve Gemini).
  try { await geminiTrackUsage(env, model, 'render', data?.usageMetadata, opts.ref || ''); } catch (_) {}
  return { ok: true, base64: inline.data, mime: inline.mimeType || inline.mime_type || 'image/png', usage: data?.usageMetadata || null, model };
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
  try { await geminiTrackUsage(env, model, 'params', data?.usageMetadata, ''); } catch (_) {}
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

// ===== Comprobantes de pago — lanzamiento junio 2026 =====
// DESACTIVADO el 12/06 a pedido de Gaspar: el OCR de comprobantes y el reenvío
// a su WhatsApp personal eran solo para la noche del 11/06. Este interruptor
// apaga las tres piezas (OCR, reenvío en vivo y backfill). Para reactivar todo,
// poner PAGO_CAPTURA_ACTIVA = true.
const PAGO_CAPTURA_ACTIVA = false;
// Ventana 11/06 00:00 → 16/06 00:00 (AR, incluye todo el 15/06). AR = UTC-3.
const PAGO_LANZAMIENTO_START_UTC = '2026-06-11T03:00:00.000Z';
const PAGO_LANZAMIENTO_END_UTC   = '2026-06-16T03:00:00.000Z';
const PAGO_SENA_MIN = 30000;   // banda de la seña del acceso (~40.000 ARS)
const PAGO_SENA_MAX = 50000;
function isPagoLanzamientoWindow(tsIso) {
  if (!PAGO_CAPTURA_ACTIVA) return false;   // captura desactivada → no se OCR-ea ni reenvía nada
  const t = String(tsIso || '');
  return t >= PAGO_LANZAMIENTO_START_UTC && t < PAGO_LANZAMIENTO_END_UTC;
}
function _normTxt(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

// ===== Reenvío automático de comprobantes al WhatsApp personal de Gaspar =====
// Pedido para el lanzamiento: que cada imagen/PDF que entre se le reenvíe a
// Gaspar a su personal, SOLO hoy (11/06) y mañana (12/06) AR. Idempotente vía la
// MISMA marca de kv_cache ('resent:<num>:<wamid>') que usó el reenvío manual, así
// no duplica con la "foto" inicial. Si el send falla (p.ej. ventana 24h cerrada)
// NO marca → un barrido posterior con /admin/wa/resend-media lo recupera.
const RESEND_GASPAR_PHONE   = '5491155604999';
const RESEND_GASPAR_END_UTC = '2026-06-13T03:00:00.000Z'; // fin del 12/06 AR (cubre todo el 12)
function isResendGasparWindow(tsIso) {
  // Sin límite inferior: alcanza con que sea anterior al cierre (todo lo que
  // entre de acá a fin de mañana). El hook ya está acotado a inbound media.
  return String(tsIso || '') < RESEND_GASPAR_END_UTC;
}
async function forwardProofToGaspar(env, m) {
  try {
    const target = RESEND_GASPAR_PHONE;
    const phone = String(m.phone || '');
    if (!phone || phone === target) return;        // no reenviarse a sí mismo
    const r2Key = m.r2Key;
    if (!r2Key) return;
    const ckey = 'resent:' + target + ':' + m.wamid;
    // idempotencia: si ya se reenvió, salir
    try { const seen = await env.DB.prepare("SELECT 1 AS x FROM kv_cache WHERE k = ?").bind(ckey).first(); if (seen) return; } catch (_) {}
    // datos del OCR (processPaymentProof ya escribió la fila, si pudo)
    let monto = 0, cuenta = '';
    try { const p = await env.DB.prepare("SELECT monto, cuenta FROM wa_pago_proof WHERE wamid = ?").bind(m.wamid).first(); if (p) { monto = p.monto || 0; cuenta = p.cuenta || ''; } } catch (_) {}
    let obj; try { obj = await env.MEDIA.get(r2Key); } catch (_) { return; }
    if (!obj) return;
    const buf = await obj.arrayBuffer();
    const mime = obj.httpMetadata?.contentType || (m.msgType === 'image' ? 'image/jpeg' : 'application/pdf');
    const baseName = (r2Key.split('/').pop() || '');
    const dotExt = baseName.includes('.') ? ('.' + baseName.split('.').pop()) : '';
    const ext = dotExt || (m.msgType === 'image' ? '.jpg' : (mime.includes('pdf') ? '.pdf' : ''));
    const fileName = m.msgType === 'document' ? ('comprobante_' + phone + ext) : (baseName || ('img' + ext));
    const mediaId = await uploadMediaToMeta(env, buf, mime, fileName);
    if (!mediaId) return;
    const fmtMonto = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const cuentaLabel = (c) => c === 'mp_gaspar' ? 'MP Gaspar' : c === 'bna_bruno' ? 'BNA Bruno' : (c === 'otra' ? 'otra cuenta' : (c || ''));
    const d = new Date(m.ts || Date.now());
    const art = new Date(d.getTime() - 3 * 3600 * 1000);
    const hhmm = String(art.getUTCHours()).padStart(2, '0') + ':' + String(art.getUTCMinutes()).padStart(2, '0');
    const quien = (m.senderName && String(m.senderName).trim()) ? String(m.senderName).trim() : phone;
    let cap = quien + ' · ' + phone + ' · ' + hhmm;
    if (monto && monto > 0) cap += '\n$' + fmtMonto(monto) + (cuenta ? (' · ' + cuentaLabel(cuenta)) : '');
    let res;
    if (m.msgType === 'image') res = await waSendImage(env, target, mediaId, cap);
    else res = await waSendDocument(env, target, mediaId, fileName, cap);
    if (res && res.ok) {
      try { await env.DB.prepare("INSERT OR REPLACE INTO kv_cache (k, v, updated_at) VALUES (?, ?, ?)").bind(ckey, '1', new Date().toISOString()).run(); } catch (_) {}
    }
  } catch (_) {}
}
// Red de seguridad del reenvío a Gaspar: corre en el cron y reintenta los inbound
// media (hoy+mañana) que aún no tienen la marca 'resent:' (los que el reenvío en
// vivo no logró mandar). LIMIT chico por tick — como corre cada minuto, drena
// cualquier backlog rápido sin recargar. Se apaga sola pasada la ventana + 3h.
async function processGasparResendBackfill(env) {
  try {
    if (!PAGO_CAPTURA_ACTIVA) return;               // reenvío de comprobantes desactivado (12/06)
    const endMs = new Date(RESEND_GASPAR_END_UTC).getTime() + 3 * 3600 * 1000;
    if (Date.now() > endMs) return;                 // ventana terminada → nada que hacer
    const target = RESEND_GASPAR_PHONE;
    const floor = '2026-06-11T23:00:00.000Z';       // desde las 20h AR del 11/06
    let rows;
    try {
      const rs = await env.DB.prepare(
        "SELECT m.wamid, m.phone, m.sender_name AS senderName, m.msg_type AS msgType, m.media_url AS r2Key, m.ts " +
        "FROM wa_messages m " +
        "LEFT JOIN kv_cache kc ON kc.k = ('resent:' || ? || ':' || m.wamid) " +
        "WHERE m.direction='inbound' AND m.msg_type IN ('image','document') " +
        "  AND m.ts >= ? AND m.ts < ? AND m.media_url IS NOT NULL AND m.media_url != '' " +
        "  AND kc.k IS NULL " +
        "ORDER BY m.id ASC LIMIT 5"
      ).bind(target, floor, RESEND_GASPAR_END_UTC).all();
      rows = rs.results || [];
    } catch (_) { return; }
    for (const r of rows) {
      await forwardProofToGaspar(env, { wamid: r.wamid, phone: r.phone, senderName: r.senderName, r2Key: r.r2Key, msgType: r.msgType, ts: r.ts });
      await new Promise(rr => setTimeout(rr, 300));
    }
  } catch (_) {}
}

// OCR potente del comprobante con Claude visión (imagen o PDF). Devuelve el JSON parseado o null.
async function analyzePaymentProof(env, r2Key, mimeHint) {
  if (!env.ANTHROPIC_API_KEY || !env.MEDIA || !r2Key) return null;
  let obj; try { obj = await env.MEDIA.get(r2Key); } catch (_) { return null; }
  if (!obj) return null;
  let buf; try { buf = await obj.arrayBuffer(); } catch (_) { return null; }
  if (!buf || buf.byteLength < 64) return null;
  const mime = (String(obj.httpMetadata?.contentType || mimeHint || '').split(';')[0].trim().toLowerCase()) || 'image/jpeg';
  const isPdf = mime.includes('pdf');
  const b64 = abToBase64(buf);
  const block = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: /(png|jpeg|webp|gif)/.test(mime) ? mime : 'image/jpeg', data: b64 } };
  const system = 'Sos un analista que lee comprobantes de pago/transferencia de Argentina (capturas o PDFs). Devolvé SOLO un JSON válido (sin markdown ni texto extra) con este formato exacto:\n' +
    '{"es_comprobante":true,"monto":0,"moneda":"ARS","cuenta":"mp_gaspar","titular_destino":"","banco":"","fecha":"","confianza":0.0}\n' +
    'Reglas:\n' +
    '- monto: numero sin simbolos ni puntos de miles (ej: 45000). 0 si no se ve.\n' +
    '- cuenta: a que cuenta ENTRO el dinero. Mercado Pago -> "mp_gaspar". Banco de la Nacion Argentina (BNA / Banco Nacion) -> "bna_bruno". Otra entidad -> "otra". No se distingue -> "desconocida".\n' +
    '- titular_destino: nombre del que RECIBE, tal cual figura. banco: la entidad destino.\n' +
    '- Si NO es un comprobante de pago, es_comprobante=false y el resto en 0/"".';
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 400, system, messages: [{ role: 'user', content: [block, { type: 'text', text: 'Analiza este comprobante y devolve el JSON.' }] }] })
    });
  } catch (_) { return null; }
  let j; try { j = await r.json(); } catch (_) { return null; }
  if (!r.ok) return null;
  let txt = String(j.content?.[0]?.text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(txt); } catch (_) { return { es_comprobante: false }; }
}

// ¿La conversación tiene la frase clave del lanzamiento? (caption del comprobante
// o algún inbound de texto de los últimos 30 min con "comunidad al infinito").
async function hasLaunchKeyPhrase(env, phone, caption) {
  if (_normTxt(caption).includes('comunidad al infinito')) return true;
  try {
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const rs = await env.DB.prepare("SELECT body FROM wa_messages WHERE phone = ? AND direction = 'inbound' AND ts >= ? ORDER BY ts DESC LIMIT 12").bind(phone, since).all();
    for (const r of (rs.results || [])) if (_normTxt(r.body).includes('comunidad al infinito')) return true;
  } catch (_) {}
  return false;
}

// ¿El monto es similar (±10%) a algún pago confirmado del lanzamiento?
async function isSimilarToLaunchAmount(env, monto) {
  if (!(monto > 0)) return false;
  try {
    const rs = await env.DB.prepare("SELECT DISTINCT monto FROM wa_pago_proof WHERE clasificacion = 'lanzamiento' AND monto > 0").all();
    for (const r of (rs.results || [])) { const a = +r.monto; if (a > 0 && Math.abs(monto - a) <= 0.10 * a) return true; }
  } catch (_) {}
  return false;
}

// Crea la etiqueta si no existe (con el nombre EXACTO en UTF-8 del worker — evita
// el problema de encoding de la ñ vía wrangler) y devuelve su id.
async function ensureLabelId(env, name, color) {
  try { await env.DB.prepare("INSERT OR IGNORE INTO labels (name, color, created_at) VALUES (?, ?, datetime('now'))").bind(name, color || '#888').run(); } catch (_) {}
  try { const r = await env.DB.prepare("SELECT id FROM labels WHERE name = ?").bind(name).first(); return r?.id || null; } catch (_) { return null; }
}

// Resuelve la cuenta destino por la INSTITUCIÓN (más confiable que el campo
// "cuenta" del OCR, que falla si el titular figura "Neon infinito" en vez de Gaspar).
function resolveCuenta(a) {
  const banco = _normTxt(a && a.banco);
  if (banco.includes('mercado pago') || banco.includes('mercadopago')) return 'mp_gaspar';
  if (banco.includes('nacion') || banco.includes('bna')) return 'bna_bruno';
  const c = (a && a.cuenta) || '';
  if (c === 'mp_gaspar' || c === 'bna_bruno') return c;
  return c || 'desconocida';
}

// Procesa un comprobante entrante: dedup por wamid, OCR, respalda en D1 y etiqueta.
// NO responde nada (eso lo hacen a mano). Corre en ctx.waitUntil (no bloquea el webhook).
async function processPaymentProof(env, m) {
  if (!m || !m.wamid || !m.phone) return;
  try {
    const res = await env.DB.prepare(
      "INSERT OR IGNORE INTO wa_pago_proof (wamid, phone, nombre, media_key, caption, ts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(m.wamid, m.phone, m.senderName || '', m.r2Key || '', String(m.caption || '').slice(0, 500), m.ts || new Date().toISOString(), new Date().toISOString()).run();
    if (!res?.meta?.changes) return; // ya procesado
  } catch (_) { return; }
  const a = await analyzePaymentProof(env, m.r2Key, m.msgType === 'document' ? 'application/pdf' : '');
  const esPago = !!(a && a.es_comprobante);
  const monto = (a && +a.monto) || 0;
  const cuenta = resolveCuenta(a);
  let clasificacion = '', labelName = null;
  if (esPago) {
    const esSena = monto >= PAGO_SENA_MIN && monto <= PAGO_SENA_MAX;  // ~40k → seña
    if (esSena) { clasificacion = 'sena'; labelName = 'seña lanzamiento junio'; }
    else if (await hasLaunchKeyPhrase(env, m.phone, m.caption)) { clasificacion = 'lanzamiento'; labelName = 'pago lanzamiento junio'; }
    else { clasificacion = 'a_definir'; labelName = 'a definir - lanzamiento'; }  // catch-all en la ventana: ningún pago queda sin etiquetar
  }
  try {
    await env.DB.prepare(
      "UPDATE wa_pago_proof SET is_payment=?, clasificacion=?, monto=?, moneda=?, cuenta=?, titular=?, banco=?, confianza=?, raw=? WHERE wamid=?"
    ).bind(esPago ? 1 : 0, clasificacion, monto, (a && a.moneda) || 'ARS', cuenta, (a && a.titular_destino) || '', (a && a.banco) || '', (a && +a.confianza) || 0, JSON.stringify(a || {}).slice(0, 1500), m.wamid).run();
  } catch (_) {}
  if (labelName) {
    const color = labelName.indexOf('seña') === 0 ? '#06b6d4' : labelName.indexOf('pago') === 0 ? '#22c55e' : '#f59e0b';
    const lid = await ensureLabelId(env, labelName, color);
    if (lid) { try { await env.DB.prepare("INSERT OR IGNORE INTO contact_labels (phone, label_id, created_at) VALUES (?, ?, ?)").bind(m.phone, lid, new Date().toISOString()).run(); } catch (_) {} }
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
  // 'precotiz' = lead en pre cotización automática (piloto): solo Gaspar (admin)
  // lo ve mientras está en relevamiento; vuelve a 'general' al completar los 3 datos.
  return "AND inbox NOT IN ('cursos','oculto','precotiz')";
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
6. FORMATO — mandá como un humano real por WhatsApp: NO un bloque largo, sino VARIOS mensajes CORTOS, uno por idea (típico: el saludo por un lado, la respuesta por otro, la pregunta que sigue por otro). Separá cada mensaje con un DOBLE salto de línea (una línea en blanco entre uno y otro). Entre 1 y 4 mensajes, cada uno corto. Si es un "sí/no" simple o una sola idea, puede ser 1 solo. El campo "draft" tiene que venir con esos dobles saltos de línea entre los mensajes.

Devolvé SOLO un objeto JSON (sin markdown, sin texto extra) con EXACTAMENTE este shape (draft = los mensajes separados por doble salto de línea):
{"vertical":"carteles|cursos|supernova|ambiguo","intent":"string corto","draft":"mensaje 1\\n\\nmensaje 2\\n\\nmensaje 3","confidence":0.0,"sources_used":["secciones del playbook usadas"],"missing_info":["datos que faltan y NO inventaste, ej: precio, plazo, garantía"],"should_escalate":false,"escalation_reason":""}`;

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

// Wrapper del cron para la síntesis (Fase 2C): se chequea 1 vez/día pero corre solo si pasaron
// ~7 días desde la última síntesis que EFECTIVAMENTE gastó (copilot_usage). Mantiene la cadencia
// semanal pero SE AUTO-RECUPERA: si el lunes falla (hipo de API, cron salteado, deploy en ese
// minuto), reintenta el martes, etc. — ya no se pierde la semana entera. Loguea éxito/fallo en
// wa_webhook_log para visibilidad; los skip por poco feedback no se loguean (esperados y gratis).
async function maybeWeeklySynthesis(env) {
  try {
    const last = await env.DB.prepare("SELECT MAX(created_at) AS t FROM copilot_usage WHERE kind='synthesis'").first();
    if (last && last.t) {
      const days = (Date.now() - new Date(last.t).getTime()) / 86400000;
      if (days < 6.5) return; // ya corrió esta semana
    }
    const res = await synthesizeFrameworkImprovements(env, { createdBy: 'cron' });
    if (res && !res.skipped) {
      const msg = res.ok
        ? ('SYNTH ok: ' + (res.generated != null ? res.generated : '?') + ' propuestas ($' + (res.cost_usd || 0) + ')')
        : ('SYNTH FALLO: ' + (res.error || 'desconocido'));
      try { await env.DB.prepare("INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)").bind(new Date().toISOString(), msg).run(); } catch (_) {}
    }
  } catch (e) {
    try { await env.DB.prepare("INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)").bind(new Date().toISOString(), 'SYNTH ERR: ' + ((e && e.message) || String(e))).run(); } catch (_) {}
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
    [30, '360dialog (WhatsApp BSP)', 'mensajeria', '360dialog', 'Envío y recepción de WhatsApp (Cloud API) + plantillas. Es el proveedor activo desde el 31-may', 'Cloudflare secret D360_API_KEY + login hub.360dialog.com', 'fixed', 0, 'USD', '', 'https://hub.360dialog.com', '360dialog es el BSP (Cloud API hosted by Meta). Tiene su saldo/fee propio en el hub, PERO las conversaciones/mensajes los cobra Meta DIRECTO a la tarjeta (ver fila Meta WhatsApp), no salen de este saldo.'],
    [40, 'Meta WhatsApp (conversaciones)', 'mensajeria', 'Meta', 'Costo por MENSAJE de plantilla de WhatsApp (mayormente MARKETING). Lo cobra Meta directo a la tarjeta.', 'WABA 1748207462464731 + Visa ...1528 (Meta Billing Hub)', 'usage', 0, 'USD', '', 'https://business.facebook.com/billing_hub/accounts', 'Meta lo cobra DIRECTO a la tarjeta (Visa) cuando la cuenta llega al umbral de facturación, NO sale del saldo de 360dialog. El grueso son plantillas MARKETING (los broadcasts). Si la tarjeta rebota (Error en el hub), Meta bloquea los envíos.'],
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

// ===== Plantillas "al toque" (creadas por vendedores) =====
// Guardrails: el vendedor no conoce las reglas de Meta, así que validamos el
// contenido ANTES de mandarlo a Meta. Si no cumple, ni se intenta crear.
// Devuelve un mensaje de error (string) si NO cumple, o null si está OK.
function validateAdhocTemplate(text) {
  const t = String(text || '').trim();
  if (t.length < 10) return 'El texto es muy corto (mínimo 10 caracteres).';
  if (t.length > 600) return 'El texto es muy largo (máximo 600 caracteres).';
  if (/https?:\/\/|www\.|wa\.me|t\.me|\b\S+\.(com|net|ar|org|io)\b/i.test(t)) return 'No se permiten links en la plantilla.';
  if (/[A-ZÁÉÍÓÚÑ]{5,}/.test(t)) return 'Evitá palabras en MAYÚSCULAS (Meta las rechaza).';
  if (/\d{7,}/.test(t)) return 'No incluyas números largos (teléfonos o códigos).';
  if (/(.)\1{6,}/.test(t)) return 'Hay caracteres repetidos de más.';
  return null;
}

// Cron: manda las plantillas "al toque" apenas Meta las aprueba (el vendedor no
// espera en el chat). Reintenta si el envío falla; marca rejected/expired.
// Se llama SOLO en horario hábil AR para no escribir de madrugada.
async function processPendingTemplateSends(env) {
  if (await isWaBillingBlocked(env)) return;
  let pend;
  try {
    const rs = await env.DB.prepare(
      "SELECT template_name, phone, body_preview, created_at FROM wa_pending_template_send WHERE status = 'pending' ORDER BY created_at ASC LIMIT 20"
    ).all();
    pend = rs.results || [];
  } catch (_) { return; }
  if (!pend.length) return;
  // Estado actual de las plantillas (un solo fetch).
  const statusByName = {};
  try {
    const _wa = getWaClient(env);
    const sep = _wa.templatesUrl().includes('?') ? '&' : '?';
    const r = await fetch(`${_wa.templatesUrl()}${sep}limit=200&fields=name,status`, { headers: _wa.headers });
    const data = await r.json().catch(() => ({}));
    for (const t of (data.data || data.waba_templates || [])) statusByName[t.name] = String(t.status || '').toLowerCase();
  } catch (_) { return; }
  const now = Date.now();
  for (const row of pend) {
    const st = statusByName[row.template_name];
    if (st === 'approved') {
      const rt = await waSendTemplate(env, row.phone, row.template_name, 'es_AR', []);
      if (rt.ok) {
        try { await env.DB.prepare("UPDATE wa_pending_template_send SET status='sent', updated_at=? WHERE template_name=?").bind(new Date().toISOString(), row.template_name).run(); } catch (_) {}
        const wamid = rt.id || '';
        if (wamid) {
          try {
            await env.DB.prepare(
              `INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id, automated)
               VALUES (?, ?, 'outbound', ?, '', 'template', ?, 'sent', '', 1)
               ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'template', automated = 1
                 WHERE wa_messages.body IS NULL OR wa_messages.body = '' OR wa_messages.msg_type = 'status'`
            ).bind(new Date().toISOString(), wamid, row.phone, row.body_preview).run();
          } catch (_) {}
        }
        if (env.ADMIN_NOTIFY_PHONE) { try { await waSendText(env, env.ADMIN_NOTIFY_PHONE, `✅ Plantilla aprobada y enviada a ${row.phone}:\n"${(row.body_preview || '').slice(0, 120)}"`); } catch (_) {} }
        await new Promise(rs => setTimeout(rs, 400));
      }
      // si el envío falla, queda 'pending' y reintenta el próximo tick
    } else if (st === 'rejected') {
      try { await env.DB.prepare("UPDATE wa_pending_template_send SET status='rejected', updated_at=? WHERE template_name=?").bind(new Date().toISOString(), row.template_name).run(); } catch (_) {}
      if (env.ADMIN_NOTIFY_PHONE) { try { await waSendText(env, env.ADMIN_NOTIFY_PHONE, `❌ Meta rechazó una plantilla nueva para ${row.phone}. Probá de nuevo con un texto más simple (sin links ni MAYÚSCULAS).`); } catch (_) {} }
    } else if ((now - new Date(row.created_at).getTime()) > 24 * 60 * 60 * 1000) {
      try { await env.DB.prepare("UPDATE wa_pending_template_send SET status='expired', updated_at=? WHERE template_name=?").bind(new Date().toISOString(), row.template_name).run(); } catch (_) {}
    }
  }
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

    // ===== Instagram DM Webhook (inbox de IG → CRM) — FASE 1: SOLO RECIBIR =====
    // App de Meta "agente neon nuevo" (866678322681866), producto Instagram con
    // Instagram Business Login, suscripto al campo `messages`. SEPARADO del de
    // WhatsApp (/webhook) y del de leadgen (/webhook/leads) para NO tocar lo que ya
    // anda. Por ahora SOLO loguea el payload (confirmar que los DM llegan). No guarda
    // en el chat ni responde NADA — eso se suma después, gateado. No puede romper nada.
    // Secreto requerido: IG_VERIFY_TOKEN (string random; Meta lo verifica al suscribir).
    if (request.method === 'GET' && path === '/webhook/ig') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && env.IG_VERIFY_TOKEN && token === env.IG_VERIFY_TOKEN && challenge) {
        return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      return new Response('Forbidden', { status: 403 });
    }
    if (request.method === 'POST' && path === '/webhook/ig') {
      let body;
      try { body = await request.json(); } catch { return json({ ok: true }); }
      try {
        await env.DB.prepare('INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)').bind(
          new Date().toISOString(), 'IG: ' + JSON.stringify(body).slice(0, 4000)
        ).run();
      } catch (_) {}
      // Fase 2a: si el flag 'ig_inbox_on' está prendido, parsear + clasificar + guardar
      // (read-only, sin responder nada). Si está apagado, solo queda el log de arriba.
      if (await igInboxOn(env)) ctx.waitUntil(processIgWebhook(env, body));
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

    // ===== Registro de la landing del minicurso gratuito =====
    // La landing manda cada registro (nombre + teléfono) acá, en paralelo a la
    // acción que ya escribe en el Google Sheet. Auth via header X-Sheet-Secret
    // (acepta el secret del bridge de leads o uno dedicado). El opener lo dispara
    // el cron a los 45 min (con guardia + horario), no acá.
    if (request.method === 'POST' && path === '/webhook/minicurso-lead') {
      const incoming = request.headers.get('x-sheet-secret') || '';
      const okSecret = (env.SHEET_BRIDGE_SECRET && incoming === env.SHEET_BRIDGE_SECRET) || (env.MINICURSO_WEBHOOK_SECRET && incoming === env.MINICURSO_WEBHOOK_SECRET);
      if (!okSecret) return json({ error: 'forbidden' }, 403);
      let body;
      try { body = await request.json(); } catch { return json({ ok: true }); }
      try { await env.DB.prepare('INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)').bind(new Date().toISOString(), 'MINICURSO_LEAD: ' + JSON.stringify(body).slice(0, 2000)).run(); } catch (_) {}
      ctx.waitUntil(processMinicursoLead(env, body));
      return json({ ok: true });
    }

    // ===== Registro de leads del formulario B2B de REVENTA =====
    // Un App Script en el Sheet de reventa reenvía cada fila nueva acá (mismo
    // header de auth que el minicurso). El worker filtra cualificados y actúa.
    if (request.method === 'POST' && path === '/webhook/reventa-lead') {
      const incoming = request.headers.get('x-sheet-secret') || '';
      const okSecret = (env.SHEET_BRIDGE_SECRET && incoming === env.SHEET_BRIDGE_SECRET) || (env.MINICURSO_WEBHOOK_SECRET && incoming === env.MINICURSO_WEBHOOK_SECRET);
      if (!okSecret) return json({ error: 'forbidden' }, 403);
      let body;
      try { body = await request.json(); } catch { return json({ ok: true }); }
      try { await env.DB.prepare('INSERT INTO wa_webhook_log (ts, payload) VALUES (?, ?)').bind(new Date().toISOString(), 'REVENTA_LEAD: ' + JSON.stringify(body).slice(0, 2000)).run(); } catch (_) {}
      ctx.waitUntil(processReventaLead(env, body));
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
                // Broadcast custom con respuesta-IA activada: marcar para branch X/Y (Fase 2.5).
                if (direction === 'inbound') {
                  try { await maybeBranchBroadcastReply(env, phone); } catch (_) {}
                }
                // ===== wa.me "Neón Mastery": ruteo directo a bandeja de cursos =====
                // Gente que entra por el link de wa.me del grupo de precalentamiento
                // del prelanzamiento manda el texto prearmado "Hola quiero acceder a
                // Neón Mastery". Los pasamos SOLO a la bandeja de Abril (cursos), sin
                // responder nada (pedido explícito): el equipo los atiende a mano.
                if (direction === 'inbound' && _normTxt(msgBody).includes('acceder a neon mastery')) {
                  try {
                    await env.DB.prepare(
                      "INSERT INTO wa_chats_summary (phone, inbox, updated_at) VALUES (?, 'cursos', ?) ON CONFLICT(phone) DO UPDATE SET inbox = 'cursos'"
                    ).bind(phone, ts).run();
                  } catch (_) {}
                }
                // ===== Minicurso: si este inbound responde al gate de feedback,
                // la IA evalúa y le manda el link de regalos si es positiva. =====
                if (direction === 'inbound') {
                  try { await maybeSendMinicursoGift(env, phone, msgBody, ts); } catch (_) {}
                }
                // ===== Lanzamiento junio: capturar comprobantes de pago =====
                // En la ventana (11-15/06), todo inbound con imagen/PDF se OCRea,
                // se clasifica, se etiqueta y se respalda en D1 (NO se responde nada).
                if (direction === 'inbound' && (msgType === 'image' || msgType === 'document') && r2Key && isPagoLanzamientoWindow(ts)) {
                  // 1) OCR + clasificación + backup en D1. 2) reenvío a Gaspar
                  // (solo hoy/mañana). El reenvío corre SIEMPRE tras el intento de
                  // OCR (aunque el OCR falle) para no perder ningún comprobante; el
                  // caption incluye monto/cuenta si el OCR alcanzó a leerlos.
                  const _pp = (async () => {
                    try { await processPaymentProof(env, { wamid, phone, senderName, r2Key, msgType, caption: msgBody, ts }); } catch (_) {}
                    if (isResendGasparWindow(ts)) { try { await forwardProofToGaspar(env, { wamid, phone, senderName, r2Key, msgType, ts }); } catch (_) {} }
                  })();
                  if (typeof ctx !== 'undefined' && ctx && ctx.waitUntil) ctx.waitUntil(_pp); else await _pp;
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
                  // Trazabilidad del ad -> bandeja: carteles a Joaquin (general), cursos a Abril.
                  // Solo si el chat no tiene bandeja asignada o esta 'oculto' (no pisa asignaciones manuales).
                  try {
                    const _vert = await adVerticalForSource(env, ref.source_id, String(ref.headline || ''), String(ref.body || ''));
                    // Si es lead de cursos y el flujo automatico esta activo, el flujo
                    // maneja la bandeja (oculto durante el opener). No ruteamos aca.
                    if (!(_vert === 'cursos' && await cursosFlowOn(env))) {
                      await env.DB.prepare("INSERT INTO wa_chats_summary (phone, inbox, updated_at) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET inbox = excluded.inbox, updated_at = excluded.updated_at WHERE wa_chats_summary.inbox IS NULL OR wa_chats_summary.inbox = 'oculto'").bind(phone, _vert === 'cursos' ? 'cursos' : 'general', ts).run();
                    }
                  } catch (_) {}
                }

                // Auto-labeling: deshabilitado por pedido del usuario (el matching
                // por keywords genera demasiados falsos positivos). El código
                // queda en applyAutoLabels() por si se quiere reactivar.
                // ===== Flujo de cursos por ads (Fase 3): arranque / transiciones =====
                if (direction === 'inbound') {
                  try { await cursosFlowOnInbound(env, phone, msgBody, ts); } catch (_) {}
                  // Landing del minicurso: respuesta al opener -> branch por IA / follow-up.
                  try { await minicursoLandingOnInbound(env, phone, ts); } catch (_) {}
                  // CAPI: un lead B2B que responde = señal de calidad -> "QualifiedLead" a Meta.
                  try { await maybeCapiQualifiedLead(env, phone); } catch (_) {}
                }
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

    // ----- Portal Revendedores (publico, cuentas propias, aislado del CRM) -----
    if (path === '/revendedores' || path === '/revendedores/') {
      return new Response(REVENDEDOR_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store' }
      });
    }
    if (path.startsWith('/revendedor/')) {
      try {
      await ensureRevSchema(env);

      if (request.method === 'POST' && path === '/revendedor/signup') {
        let body; try { body = await request.json(); } catch (_) { return json({ error: 'JSON invalido' }, 400); }
        const nombre = String(body.nombre || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const whatsapp = normalizeArPhone(body.whatsapp) || String(body.whatsapp || '').trim();
        const password = String(body.password || '');
        if (!nombre || !email || !whatsapp || !password) return json({ error: 'Faltan datos.' }, 400);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Email invalido.' }, 400);
        if (password.length < 6) return json({ error: 'La contrasena necesita al menos 6 caracteres.' }, 400);
        const dup = await env.DB.prepare('SELECT id FROM revendedores WHERE email = ?').bind(email).first();
        if (dup) return json({ error: 'Ya existe una cuenta con ese email. Proba entrar.' }, 409);
        const { hash, salt } = await revHashPassword(password);
        const now = new Date().toISOString();
        const ins = await env.DB.prepare(
          'INSERT INTO revendedores (nombre, email, whatsapp, pass_hash, pass_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(nombre, email, whatsapp, hash, salt, now).run();
        let id = ins.meta && ins.meta.last_row_id;
        if (!id) { const row = await env.DB.prepare('SELECT id FROM revendedores WHERE email = ?').bind(email).first(); id = row && row.id; }
        const tk = randomToken();
        const exp = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
        await env.DB.prepare('INSERT INTO revendedor_sesiones (token, revendedor_id, expires_at, created_at) VALUES (?, ?, ?, ?)').bind(tk, id, exp, now).run();
        return json({ ok: true, token: tk, revendedor: { id, nombre, email } });
      }

      if (request.method === 'POST' && path === '/revendedor/login') {
        let body; try { body = await request.json(); } catch (_) { return json({ error: 'JSON invalido' }, 400); }
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        if (!email || !password) return json({ error: 'Faltan datos.' }, 400);
        const u = await env.DB.prepare('SELECT id, nombre, email, pass_hash, pass_salt FROM revendedores WHERE email = ?').bind(email).first();
        if (!u) return json({ error: 'Email o contrasena incorrectos.' }, 401);
        const { hash } = await revHashPassword(password, u.pass_salt);
        if (hash !== u.pass_hash) return json({ error: 'Email o contrasena incorrectos.' }, 401);
        const tk = randomToken();
        const now = new Date().toISOString();
        const exp = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
        await env.DB.prepare('INSERT INTO revendedor_sesiones (token, revendedor_id, expires_at, created_at) VALUES (?, ?, ?, ?)').bind(tk, u.id, exp, now).run();
        return json({ ok: true, token: tk, revendedor: { id: u.id, nombre: u.nombre, email: u.email } });
      }

      // De aca en adelante requiere sesion de revendedor.
      const sess = await getRevSession(env, request);
      if (!sess) return unauthorized();

      if (request.method === 'GET' && path === '/revendedor/me') {
        return json({ id: sess.id, nombre: sess.nombre, email: sess.email });
      }
      if (request.method === 'POST' && path === '/revendedor/logout') {
        await env.DB.prepare('DELETE FROM revendedor_sesiones WHERE token = ?').bind(sess.token).run();
        return json({ ok: true });
      }
      if (request.method === 'POST' && path === '/revendedor/cotizar') {
        let body; try { body = await request.json(); } catch (_) { return json({ error: 'JSON invalido' }, 400); }
        const ancho = +body.ancho || 0, alto = +body.alto || 0, neon = +body.neon || 0;
        const tramos = +body.tramos || 1;
        const tipo = String(body.tipo || 'INT').toUpperCase() === 'EXT' ? 'EXT' : 'INT';
        const nombre = String(body.nombre || '').slice(0, 80).trim();
        if (ancho <= 0 || alto <= 0 || neon <= 0) return json({ error: 'Carga ancho, alto y metros de neon.' }, 400);
        if (ancho > 2000 || alto > 2000 || neon > 200) return json({ error: 'Medidas fuera de rango.' }, 400);
        const p = await revPriceParams(env);
        const { transFinal, negroFinal } = revCalcPrecio({ ancho, alto, neon, tramos, tipo }, p);
        const trans = revNumbers(transFinal), negro = revNumbers(negroFinal);
        const now = new Date().toISOString();
        try {
          await env.DB.prepare(
            'INSERT INTO revendedor_cotizaciones (revendedor_id, nombre, ancho, alto, neon, tramos, tipo, sugerido, costo, reventa_min, reventa_max, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
          ).bind(sess.id, nombre, ancho, alto, neon, tramos, tipo, trans.sugerido, trans.costo, trans.reventaMin, trans.reventaMax, now).run();
        } catch (_) {}
        return json({ ok: true, trans, negro });
      }
      if (request.method === 'GET' && path === '/revendedor/historial') {
        const rs = await env.DB.prepare(
          'SELECT id, nombre, ancho, alto, neon, tramos, tipo, sugerido, costo, reventa_min, reventa_max, created_at FROM revendedor_cotizaciones WHERE revendedor_id = ? ORDER BY id DESC LIMIT 40'
        ).bind(sess.id).all();
        return json({ ok: true, items: rs.results || [] });
      }
      return json({ error: 'not found' }, 404);
      } catch (e) {
        console.error('rev_error', (e && (e.stack || e.message)) || e);
        return json({ error: 'Hubo un error, proba de nuevo.' }, 500);
      }
    }

    // ----- Admin (requiere Bearer) -----
    // Media SALIENTE de IG (ig/out_): PÚBLICA sin auth. Instagram descarga la URL (sin token)
    // para reenviarla al cliente; con el gate de auth recibía 401 y fallaba ("Upload failed").
    // Son archivos que NOSOTROS mandamos (imágenes/audios salientes, no sensibles) y con nombre
    // aleatorio inadivinable. El resto de /admin/media/ sigue protegido por el gate de abajo.
    if (request.method === 'GET' && path.startsWith('/admin/media/')) {
      const _k = decodeURIComponent(path.slice('/admin/media/'.length));
      if (_k.startsWith('ig/out_') && env.MEDIA) {
        const _obj = await env.MEDIA.get(_k);
        if (_obj) return new Response(_obj.body, { headers: { ...cors(), 'Content-Type': _obj.httpMetadata?.contentType || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' } });
      }
    }

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

      // ----- Piloto de pre cotización (solo Gaspar): estado, control, dry-run, aprobar -----
      if (path.startsWith('/admin/precotiz')) {
        if (!isAdminSession) return json({ error: 'forbidden: admin only' }, 403);

        // GET /admin/precotiz → on/off + modo + leads del piloto
        if (request.method === 'GET' && path === '/admin/precotiz') {
          const on = (await kvGet(env, 'precotiz_on', '0')) === '1';
          const modo = await kvGet(env, 'precotiz_modo', 'draft');
          let leads = [];
          try { const rs = await env.DB.prepare('SELECT * FROM precotiz_pilot ORDER BY updated_at DESC').all(); leads = rs.results || []; } catch (_) {}
          return json({ ok: true, on, modo, cap: PRECOTIZ_CAP, count: leads.length, leads });
        }

        // POST /admin/precotiz/control → { on?, modo? } prender/apagar + draft|auto
        if (request.method === 'POST' && path === '/admin/precotiz/control') {
          let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
          if (typeof body?.on === 'boolean') await kvSet(env, 'precotiz_on', body.on ? '1' : '0');
          if (body?.modo === 'auto' || body?.modo === 'draft') await kvSet(env, 'precotiz_modo', body.modo);
          return json({ ok: true, on: (await kvGet(env, 'precotiz_on', '0')) === '1', modo: await kvGet(env, 'precotiz_modo', 'draft') });
        }

        // GET /admin/minicurso-landing → estado + leads del flujo de la landing del minicurso
        if (request.method === 'GET' && path === '/admin/minicurso-landing') {
          const on = (await kvGet(env, 'minicurso_landing_on', '0')) === '1';
          let leads = [];
          try { const rs = await env.DB.prepare('SELECT * FROM minicurso_landing ORDER BY updated_at DESC LIMIT 300').all(); leads = rs.results || []; } catch (_) {}
          const by_stage = {};
          for (const l of leads) by_stage[l.stage] = (by_stage[l.stage] || 0) + 1;
          return json({ ok: true, on, count: leads.length, by_stage, leads });
        }
        // POST /admin/minicurso-landing/control → { on? } prender/apagar (kill-switch)
        if (request.method === 'POST' && path === '/admin/minicurso-landing/control') {
          let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
          if (typeof body?.on === 'boolean') await kvSet(env, 'minicurso_landing_on', body.on ? '1' : '0');
          return json({ ok: true, on: (await kvGet(env, 'minicurso_landing_on', '0')) === '1' });
        }
        // POST /admin/minicurso-landing/test → { phone, nombre, now? } registra un lead
        // de prueba. Con now:true el opener sale en el próximo tick (probar sin esperar 45min).
        if (request.method === 'POST' && path === '/admin/minicurso-landing/test') {
          let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
          const num = normalizeArPhone(String(body?.phone || '')) || '';
          if (!num) return json({ error: 'missing/invalid phone' }, 400);
          const nombre = (String(body?.nombre || body?.firstName || '').trim().split(/\s+/)[0]) || '';
          const now = new Date().toISOString();
          const due = body?.now ? now : new Date(Date.now() + MINICURSO_LANDING_DELAY_MS).toISOString();
          try {
            await env.DB.prepare(
              "INSERT INTO minicurso_landing (phone, nombre, stage, registered_at, opener_due_at, source, updated_at, created_at) VALUES (?, ?, 'registered', ?, ?, 'test', ?, ?) ON CONFLICT(phone) DO UPDATE SET stage='registered', nombre=excluded.nombre, opener_due_at=excluded.opener_due_at, opener_sent_at=NULL, reply_due=NULL, followup_sent_at=NULL, followup_due_at=NULL, guard_reason='', vio_clase2=0, updated_at=excluded.updated_at"
            ).bind(num, nombre, now, due, now, now).run();
          } catch (e) { return json({ error: String(e?.message || e) }, 500); }
          return json({ ok: true, phone: num, nombre, opener_due_at: due });
        }

        // GET /admin/reventa → estado + leads del flujo de reventa B2B
        if (request.method === 'GET' && path === '/admin/reventa') {
          const on = (await kvGet(env, 'reventa_on', '0')) === '1';
          let leads = [];
          try { const rs = await env.DB.prepare('SELECT * FROM reventa_leads ORDER BY created_at DESC LIMIT 300').all(); leads = rs.results || []; } catch (_) {}
          const cual = leads.filter(l => l.cualificado).length;
          return json({ ok: true, on, count: leads.length, cualificados: cual, no_cualificados: leads.length - cual, leads });
        }
        // POST /admin/reventa/control → { on? } (kill-switch)
        if (request.method === 'POST' && path === '/admin/reventa/control') {
          let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
          if (typeof body?.on === 'boolean') await kvSet(env, 'reventa_on', body.on ? '1' : '0');
          return json({ ok: true, on: (await kvGet(env, 'reventa_on', '0')) === '1' });
        }
        // POST /admin/reventa/test → simula un lead { phone, nombre, p1, p2, p3, id? }
        if (request.method === 'POST' && path === '/admin/reventa/test') {
          let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
          const row = { id: body.id || ('test-' + String(body.phone || '').replace(/\D/g, '')), phone: body.phone || '', full_name: body.nombre || '', 'tenes experiencia en venta de productos': body.p1 || '', 'tenes clientes para venderles': body.p2 || '', 'te dedicas a alguno de estos rubros': body.p3 || '' };
          await processReventaLead(env, { row_data: row });
          const lead = await env.DB.prepare('SELECT lead_id, phone, nombre, cualificado, template_status FROM reventa_leads WHERE lead_id = ?').bind(row.id).first();
          return json({ ok: true, lead });
        }

        // POST /admin/capi/test → { phone?, leadId?, event? } manda un evento de prueba a la CAPI de Meta
        if (request.method === 'POST' && path === '/admin/capi/test') {
          let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
          const out = await sendCapiEvent(env, { leadId: body.leadId || '', phone: body.phone || '', email: body.email || '', eventName: body.event || 'Lead', ref: 'admin-test' });
          return json(out);
        }

        // POST /admin/precotiz/dry-run → { phone } qué decidiría el motor, SIN enviar
        if (request.method === 'POST' && path === '/admin/precotiz/dry-run') {
          let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
          const num = String(body?.phone || '').replace(/\D/g, '');
          if (!num) return json({ error: 'missing phone' }, 400);
          const ctx = await buildChatContext(env, num, 40);
          if (!ctx) return json({ error: 'sin mensajes para ese phone' }, 404);
          const fw = await getActiveFramework(env);
          const imgs = await precotizImageBlocks(env, num);
          const out = await precotizLlm(env, ctx.fullText, fw?.content || '', imgs);
          return json({ ok: out.ok, phone: num, result: out.data || null, error: out.error || null, status: out.status || null, raw: out.raw || null });
        }

        // POST /admin/precotiz/approve → { phone, mensajes? } envía los mensajitos (editados o del borrador)
        if (request.method === 'POST' && path === '/admin/precotiz/approve') {
          let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
          const num = String(body?.phone || '').replace(/\D/g, '');
          if (!num) return json({ error: 'missing phone' }, 400);
          const lead = await precotizGet(env, num);
          if (!lead) return json({ error: 'lead no encontrado' }, 404);
          let msgs = Array.isArray(body?.mensajes) ? body.mensajes : null;
          if (!msgs && lead.pending_draft) { try { msgs = JSON.parse(lead.pending_draft); } catch (_) { msgs = null; } }
          msgs = (msgs || []).filter(m => typeof m === 'string' && m.trim()).slice(0, 5);
          if (!msgs.length) return json({ error: 'no hay mensajes para enviar' }, 400);
          for (const m of msgs) { await precotizSend(env, num, m); await new Promise(r => setTimeout(r, 900)); }
          const nowIso = new Date().toISOString();
          let lastInTs = '';
          try { const li = await env.DB.prepare("SELECT MAX(ts) AS t FROM wa_messages WHERE phone = ? AND direction = 'inbound' AND msg_type != 'status'").bind(num).first(); lastInTs = li?.t || ''; } catch (_) {}
          try { await env.DB.prepare("UPDATE precotiz_pilot SET pending_draft = '', draft_ts = '', msgs_bot = msgs_bot + 1, last_processed_ts = ?, updated_at = ? WHERE phone = ?").bind(lastInTs || nowIso, nowIso, num).run(); } catch (_) {}
          return json({ ok: true, sent: msgs.length });
        }

        // POST /admin/precotiz/discard → { phone } descarta el borrador sin enviar
        if (request.method === 'POST' && path === '/admin/precotiz/discard') {
          let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
          const num = String(body?.phone || '').replace(/\D/g, '');
          if (!num) return json({ error: 'missing phone' }, 400);
          const nowIso = new Date().toISOString();
          let lastInTs = '';
          try { const li = await env.DB.prepare("SELECT MAX(ts) AS t FROM wa_messages WHERE phone = ? AND direction = 'inbound' AND msg_type != 'status'").bind(num).first(); lastInTs = li?.t || ''; } catch (_) {}
          try { await env.DB.prepare("UPDATE precotiz_pilot SET pending_draft = '', draft_ts = '', last_processed_ts = ?, updated_at = ? WHERE phone = ?").bind(lastInTs || nowIso, nowIso, num).run(); } catch (_) {}
          return json({ ok: true });
        }

        return json({ error: 'not found' }, 404);
      }

      // ----- Copiloto: contador de gasto IA (solo Gaspar) -----
      // ----- Gasto de Gemini: renders + estimación de medidas (solo Gaspar) -----
      if (request.method === 'GET' && path === '/admin/gemini/usage') {
        if (!isAdminSession) return json({ error: 'forbidden: admin only' }, 403);
        const ms = new Date(); ms.setUTCDate(1); ms.setUTCHours(0, 0, 0, 0); const m = ms.toISOString();
        const ds = new Date(); ds.setUTCHours(0, 0, 0, 0); const d = ds.toISOString();
        const agg = async (where, ...b) => {
          const r = await env.DB.prepare(`SELECT COUNT(*) AS n, ROUND(SUM(cost_usd), 4) AS cost FROM gemini_usage WHERE 1=1 ${where}`).bind(...b).first();
          return { n: r?.n || 0, cost: r?.cost || 0 };
        };
        const today = await agg(' AND ts >= ?', d);
        const month = await agg(' AND ts >= ?', m);
        const monthRender = await agg(" AND kind='render' AND ts >= ?", m);
        const total = await agg('');
        const byModel = (await env.DB.prepare("SELECT model, kind, COUNT(*) AS n, ROUND(SUM(cost_usd), 4) AS cost FROM gemini_usage WHERE ts >= ? GROUP BY model, kind ORDER BY cost DESC").bind(m).all()).results || [];
        const avgRender = monthRender.n ? +(monthRender.cost / monthRender.n).toFixed(4) : 0;
        return json({
          ok: true,
          today: { count: today.n, cost_usd: today.cost },
          month: { count: month.n, cost_usd: month.cost, renders: monthRender.n, avg_render_usd: avgRender },
          total: { count: total.n, cost_usd: total.cost },
          by_model: byModel
        });
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
      // Inventario de automatizaciones de WhatsApp (Fase 1: read-only). Lista
      // TODAS las automatizaciones (broadcasts, disparadores por mensaje, crons)
      // con su estado real y stats en vivo derivadas de la base. Solo admin.
      if (request.method === 'GET' && path === '/admin/automations') {
        if (!isAdminSession) return json({ error: 'forbidden: admin only' }, 403);
        // Stats de colas/broadcasts en una sola query (kind x status).
        const qRows = (await env.DB.prepare("SELECT kind, status, COUNT(*) AS n FROM wa_autoreply_log GROUP BY kind, status").all()).results || [];
        const byKind = {};
        for (const r of qRows) { (byKind[r.kind] = byKind[r.kind] || {})[r.status] = r.n; }
        // Stats de campañas (respondieron / positivas) por campaña.
        const camp = {};
        try {
          const cr = (await env.DB.prepare("SELECT campaign, COUNT(*) AS total, SUM(CASE WHEN responded_at IS NOT NULL THEN 1 ELSE 0 END) AS responded, SUM(CASE WHEN sentiment='positiva' THEN 1 ELSE 0 END) AS positiva FROM wa_cursos_campaign GROUP BY campaign").all()).results || [];
          for (const r of cr) camp[r.campaign] = r;
        } catch (_) {}
        let cursosInbox = 0;
        try { cursosInbox = (await env.DB.prepare("SELECT COUNT(*) AS n FROM wa_chats_summary WHERE inbox='cursos'").first())?.n || 0; } catch (_) {}
        const billingBlocked = await isWaBillingBlocked(env);
        // Stats del flujo Lead Ads B2B -> auto-WhatsApp (tabla wa_leads).
        let leadsTotal = 0, leadsSent = 0;
        try {
          const lr = await env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN template_status='sent' THEN 1 ELSE 0 END) AS sent FROM wa_leads").first();
          leadsTotal = lr?.total || 0; leadsSent = lr?.sent || 0;
        } catch (_) {}
        let cfOn = false, cfTotal = 0, cfActivos = 0;
        try { cfOn = (await env.DB.prepare("SELECT v FROM kv_cache WHERE k='cursos_flow_on'").first())?.v === '1'; } catch (_) {}
        try { const cr = await env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN stage NOT IN ('done','stopped') THEN 1 ELSE 0 END) AS activos FROM wa_cursos_flow").first(); cfTotal = cr?.total || 0; cfActivos = cr?.activos || 0; } catch (_) {}
        // Estado de un broadcast segun su cola: en curso si quedan encolados,
        // completado si ya mando algo, inactivo si nunca tuvo data.
        const bcState = (k) => (byKind[k]?.queued ? 'en_curso' : (byKind[k]?.sent ? 'completado' : 'inactivo'));
        const automations = [
          { id:'cupo_broadcast', group:'Broadcasts', name:'Cupo Comunidad (1 cupo)', desc:'Plantilla cupo_comunidad_junio a leads del form de junio, con goteo.', trigger:'Manual / encolado', state: bcState('cupo_broadcast'), stats: byKind.cupo_broadcast || {} },
          { id:'junio_broadcast', group:'Broadcasts', name:'Lanzamiento Junio', desc:'Plantilla lanzamiento_junio_2026 a leads del 9-10 jun, con goteo.', trigger:'Manual / encolado', state: bcState('junio_broadcast'), stats: byKind.junio_broadcast || {} },
          { id:'cursos_broadcast', group:'Broadcasts', name:'Cursos Mayo', desc:'Plantilla cursos_clases_vivo_mayo, con goteo.', trigger:'Manual / encolado', state: bcState('cursos_broadcast'), stats: byKind.cursos_broadcast || {} },
          { id:'neon_mastery', group:'Disparadores por mensaje', name:'Ruteo "Neon Mastery"', desc:'Quien escribe "acceder a Neon Mastery" pasa a la bandeja de Abril (cursos). No responde nada.', trigger:'Texto contiene "acceder a neon mastery"', state:'active', stats:{} },
          { id:'minicurso', group:'Disparadores por mensaje', name:'Auto-reply Minicurso', desc:'Quien pide cotizador + guia + curso recibe el link del minicurso (1 vez por contacto).', trigger:'Texto: cotizador + guia + curso', state: billingBlocked ? 'pausado' : 'active', stats:{ enviados: byKind.minicurso?.sent || 0, en_cola: byKind.minicurso?.queued || 0 } },
          { id:'cursos_reveal', group:'Disparadores por mensaje', name:'Respuesta a campana de cursos', desc:'Si un lead de campana responde, la IA evalua, manda el evento si es positiva y revela el chat a Abril.', trigger:'Inbound de lead de campana', state:'active', stats:{ respondieron: (camp.junio?.responded||0)+(camp.mayo?.responded||0), positivas: (camp.junio?.positiva||0)+(camp.mayo?.positiva||0) } },
          { id:'presupuesto_fu', group:'Seguimientos automaticos', name:'Follow-up de presupuesto', desc:'23h despues de cotizar sin respuesta, manda un seguimiento (gratis, dentro de la ventana de 24h).', trigger:'Cron horario 8-20 AR', state: billingBlocked ? 'pausado' : 'active', stats:{} },
          { id:'minicurso_fu', group:'Seguimientos automaticos', name:'Follow-up de minicurso', desc:'4-24h sin respuesta tras el minicurso, manda un recordatorio.', trigger:'Cron horario 8-20 AR', state: billingBlocked ? 'pausado' : 'active', stats:{} },
          { id:'cursos_fu', group:'Seguimientos automaticos', name:'Follow-up de cursos (Mayo)', desc:'2do mensaje a no-respondedores. DESACTIVADO (mandaba al cohorte equivocado).', trigger:'Cron horario', state:'disabled', stats:{} },
          { id:'pago_ocr', group:'Otras', name:'OCR de comprobantes de pago', desc:'En ventana de lanzamiento, OCRea imagenes/PDF, clasifica y respalda. No responde al cliente.', trigger:'Inbound con imagen/PDF', state: PAGO_CAPTURA_ACTIVA ? 'active' : 'disabled', stats:{} },
          { id:'copilot', group:'Otras', name:'Analisis IA de chats (Copilot)', desc:'Analiza chats nuevos con Claude (hasta 5/h): sentimiento, objeciones, proxima accion.', trigger:'Cron horario', state: env.ANTHROPIC_API_KEY ? 'active' : 'inactivo', stats:{} },
          { id:'lead_b2b', group:'Leads / Ads', name:'Lead Ads B2B -> auto-WhatsApp', desc:'Cuando entra un lead del form B2B de Meta Ads, le manda la plantilla lead_b2b_followup en menos de 30s.', trigger:'Webhook de Meta (leadgen)', state: env.META_PAGE_ACCESS_TOKEN ? 'active' : 'disabled', stats:{ leads: leadsTotal, enviados: leadsSent, fallidos: Math.max(0, leadsTotal - leadsSent) } },
          { id:'cursos_flow', group:'Disparadores por mensaje', name:'Flujo de cursos (ads)', desc:'Lead de ad de cursos -> opener automatico (visible para Abril desde el inicio) -> branch por IA (manda el minicurso si responde) -> nutrir (msg +23h) + nudge a las 3hs.', trigger:'Inbound de lead de ad de cursos', state: cfOn ? 'active' : 'disabled', stats:{ en_curso: cfActivos, total: cfTotal } },
        ];
        // Broadcasts custom creados desde el panel (Fase 2): se suman arriba.
        try {
          const bcs = (await env.DB.prepare("SELECT id, name, template, status FROM wa_broadcasts ORDER BY id DESC").all()).results || [];
          for (const b of bcs) {
            const st = byKind['bc_' + b.id] || {};
            const state = b.status === 'paused' ? 'pausado' : (st.queued ? 'en_curso' : (st.sent ? 'completado' : 'inactivo'));
            automations.unshift({ id: 'bc_' + b.id, group: 'Broadcasts', name: b.name || ('Broadcast #' + b.id), desc: 'Plantilla ' + b.template + ' - creado desde el panel (CSV).', trigger: 'CSV / manual', state, stats: st });
          }
        } catch (_) {}
        return json({ ok:true, billing_blocked: billingBlocked, cursos_inbox: cursosInbox, automations });
      }
      // Crear un broadcast custom desde el panel (Fase 2): CSV de contactos +
      // plantilla elegida + goteo. dryRun=true valida sin encolar (preview seguro).
      if (request.method === 'POST' && path === '/admin/broadcasts') {
        if (!isAdminSession) return json({ error: 'forbidden: admin only' }, 403);
        await ensureBroadcastsSchema(env);
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const template = (body?.template || '').trim();
        if (!template) return json({ error: 'falta la plantilla' }, 400);
        const lang = (body?.lang || 'es').trim();
        const paramMode = body?.param_mode === 'none' ? 'none' : 'nombre';
        const bodyPreview = (body?.body_preview || '').slice(0, 2000);
        const name = (body?.name || '').slice(0, 120);
        const intervalSec = Math.max(5, Math.min(3600, parseInt(body?.intervalSec, 10) || 32));
        const rawContacts = Array.isArray(body?.contacts) ? body.contacts : [];
        // Flujo fusionado (Fase 2.5): respuesta IA (X/Y texto libre) + follow-up (Z plantilla). Opcional.
        const replyAi = body?.reply_ai ? 1 : 0;
        const replyPos = (body?.reply_pos_msg || '').slice(0, 2000);
        const replyNeg = (body?.reply_neg_msg || '').slice(0, 2000);
        let followupHours = parseFloat(body?.followup_hours);
        if (!followupHours || isNaN(followupHours) || followupHours <= 0) followupHours = null;
        const followupTemplate = (body?.followup_template || '').trim();
        const followupLang = (body?.followup_lang || 'es').trim();
        const followupParamMode = body?.followup_param_mode === 'none' ? 'none' : 'nombre';
        const followupPreview = (body?.followup_preview || '').slice(0, 2000);
        // Normalizar telefonos + dedupe; descartar invalidos.
        const seen = new Set();
        const valid = [];
        let invalid = 0;
        for (const c of rawContacts) {
          const ph = normalizeArPhone(c && (c.phone != null ? c.phone : c.tel));
          if (!ph) { invalid++; continue; }
          if (seen.has(ph)) continue;
          seen.add(ph);
          valid.push({ phone: ph, nombre: String((c && c.nombre) || '').slice(0, 80) });
        }
        if (!valid.length) return json({ error: 'no hay contactos validos en el CSV', invalid }, 400);
        let startMs = Date.parse(body?.startTs || '');
        if (!startMs || isNaN(startMs)) startMs = Date.now();
        const durationMin = Math.round((valid.length * intervalSec) / 60);
        if (body?.dryRun) {
          return json({ ok: true, dryRun: true, valid: valid.length, invalid, interval_sec: intervalSec, start: new Date(startMs).toISOString(), duration_min: durationMin, sample: valid.slice(0, 5) });
        }
        const ins = await env.DB.prepare(
          "INSERT INTO wa_broadcasts (name, template, lang, param_mode, body_preview, status, total, created_at, created_by, reply_ai, reply_pos_msg, reply_neg_msg, followup_hours, followup_template, followup_lang, followup_param_mode, followup_preview) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, 'admin', ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(name, template, lang, paramMode, bodyPreview, valid.length, new Date().toISOString(), replyAi, replyPos, replyNeg, followupHours, (followupHours ? followupTemplate : null), followupLang, followupParamMode, followupPreview).run();
        const id = ins?.meta?.last_row_id;
        if (!id) return json({ error: 'no se pudo crear el broadcast' }, 500);
        const kind = 'bc_' + id;
        const stmts = [];
        for (let i = 0; i < valid.length; i++) {
          const dueAt = new Date(startMs + i * intervalSec * 1000).toISOString();
          stmts.push(env.DB.prepare("INSERT OR IGNORE INTO wa_autoreply_log (phone, kind, sent_at, status, due_at, sender_name) VALUES (?, ?, '', 'queued', ?, ?)").bind(valid[i].phone, kind, dueAt, valid[i].nombre));
        }
        for (let j = 0; j < stmts.length; j += 100) { try { await env.DB.batch(stmts.slice(j, j + 100)); } catch (_) {} }
        return json({ ok: true, id, kind, enqueued: valid.length, invalid, interval_sec: intervalSec, start: new Date(startMs).toISOString(), duration_min: durationMin });
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
          const rs = await env.DB.prepare('SELECT phone, name, username, pic_url FROM wa_contacts').all();
          return json({ contacts: rs.results || [] });
        } catch (e) { return json({ contacts: [] }); }
      }

      // Rellena la foto de perfil de los contactos de IG que todavía no la tienen
      // (los resueltos antes de agregar la foto). One-shot, idempotente: igResolveName
      // ya saltea los que tienen foto fresca. Útil además para refrescar antes de que venzan.
      if (request.method === 'POST' && path === '/admin/ig/backfill-pics') {
        if (session.user !== 'Gaspar') return json({ error: 'forbidden' }, 403);
        if (!(await igGetToken(env))) return json({ error: 'no IG token' }, 400);
        let contactos = 0, media = 0;
        try {
          // 1) Contactos de IG sin nombre/@usuario/foto -> re-resolver. Incluye los "echo-only"
          //    (a los que solo les escribimos y no están en wa_contacts) vía LEFT JOIN.
          const rs = await env.DB.prepare("SELECT s.phone AS phone FROM wa_chats_summary s LEFT JOIN wa_contacts c ON c.phone=s.phone WHERE s.channel='ig' AND (c.name IS NULL OR c.name='' OR c.username IS NULL OR c.username='' OR c.pic_url IS NULL OR c.pic_url='')").all();
          for (const row of (rs.results || [])) { contactos++; await igResolveName(env, row.phone); }
          // 2) Mensajes de IG con media todavía en URL cruda (lookaside) -> bajar a R2.
          const ms = await env.DB.prepare("SELECT id, wamid, media_url, msg_type FROM wa_messages WHERE channel='ig' AND media_url LIKE 'http%' LIMIT 100").all();
          for (const row of (ms.results || [])) {
            const k = await downloadIgMedia(env, row.media_url, row.wamid, row.msg_type);
            if (k) { await env.DB.prepare('UPDATE wa_messages SET media_url=? WHERE id=?').bind(k, row.id).run(); media++; }
          }
          return json({ ok: true, contactos, media });
        } catch (e) { return json({ error: String(e), contactos, media }, 500); }
      }

      // Re-procesa los webhooks de IG ya logueados a través de processIgWebhook (idempotente:
      // INSERT OR IGNORE por mid). Sirve para recuperar HISTÓRICO: los mensajes ENVIADOS (echoes)
      // que antes descartábamos, y re-etiquetar los anuncios (ig_post) que quedaron como
      // "imagen no disponible". Esos placeholders se borran primero para que el replay los recree bien.
      if (request.method === 'POST' && path === '/admin/ig/replay-logs') {
        if (session.user !== 'Gaspar') return json({ error: 'forbidden' }, 403);
        let replayed = 0, deleted = 0;
        try {
          const del = await env.DB.prepare("DELETE FROM wa_messages WHERE channel='ig' AND body='🖼️ imagen no disponible'").run();
          deleted = del.meta?.changes || 0;
          const rs = await env.DB.prepare("SELECT payload FROM wa_webhook_log WHERE payload LIKE 'IG: {%' ORDER BY ts DESC LIMIT 600").all();
          for (const row of (rs.results || [])) {
            try {
              const raw = String(row.payload || '');
              const obj = JSON.parse(raw.slice(raw.indexOf('{')));
              await processIgWebhook(env, obj);
              replayed++;
            } catch (_) {}
          }
          return json({ ok: true, deleted, replayed });
        } catch (e) { return json({ error: String(e), deleted, replayed }, 500); }
      }

      // Backfill: manda a la bandeja de Abril (cursos) los chats de IG que recibieron el
      // opener/contenido de cursos pero quedaron en 'general' (leads de cursos que entran por
      // IG, históricamente mal ruteados por clasificarse por el texto de su respuesta).
      // Idempotente y seguro: solo promueve general/oculto -> cursos (no pisa asignación manual).
      if (request.method === 'POST' && path === '/admin/ig/reclasify-cursos') {
        if (session.user !== 'Gaspar') return json({ error: 'forbidden' }, 403);
        try {
          const r = await env.DB.prepare(
            "UPDATE wa_chats_summary SET inbox='cursos', updated_at = ? WHERE channel='ig' AND inbox IN ('general','oculto') AND phone IN (SELECT DISTINCT phone FROM wa_messages WHERE channel='ig' AND (body LIKE '%neoninfinito.com%' OR body LIKE '%mastery%' OR body LIKE '%minicurso%' OR body LIKE '%curso gratuito%' OR body LIKE '%comunidad al infinito%' OR body LIKE '%supernova%'))"
          ).bind(new Date().toISOString()).run();
          return json({ ok: true, updated: r.meta && r.meta.changes });
        } catch (e) { return json({ error: String(e && e.message || e) }, 500); }
      }

      // Sincroniza el mapa de anuncios de IG (media_id -> ad_id/campaña) desde Meta Ads.
      // Devuelve el diagnóstico (sirve para ver si el token tiene permiso ads_read).
      if (request.method === 'POST' && path === '/admin/ig/sync-ad-map') {
        if (session.user !== 'Gaspar') return json({ error: 'forbidden' }, 403);
        const res = await syncIgAdMap(env);
        return json(res, res.ok ? 200 : 502);
      }

      // Enviar un DM de IG (texto). Lo dispara el chat cuando el contacto es de Instagram.
      // Valida la ventana de 24h ANTES de mandar (IG no permite texto libre fuera de ella;
      // a diferencia de WhatsApp, IG no tiene plantillas para reabrir). El que envía es una
      // persona desde el chat: nada automático.
      if (request.method === 'POST' && path === '/admin/ig/send') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const { to, text } = body || {};
        if (!to || !text) return json({ error: 'missing fields (to, text)' }, 400);
        const igId = String(to);
        // Rol 'cursos' (Abril) solo puede escribir a chats de su bandeja.
        {
          const _role = await getSessionRole(env, session.user);
          if (!(await inboxAccessOk(env, _role, igId))) {
            return json({ error: 'forbidden: chat fuera de tu bandeja' }, 403);
          }
        }
        // Ventana de 24h: tomamos el último mensaje ENTRANTE de IG de este contacto.
        let lastTs = 0;
        try {
          const lastIn = await env.DB.prepare("SELECT MAX(ts) AS ts FROM wa_messages WHERE phone=? AND direction='inbound' AND channel='ig'").bind(igId).first();
          lastTs = lastIn && lastIn.ts ? new Date(lastIn.ts).getTime() : 0;
        } catch (_) {}
        if (!(lastTs && (Date.now() - lastTs) < 24 * 3600 * 1000)) {
          return json({ error: 'Ventana de 24 h cerrada: el cliente no escribió en las últimas 24 h. Instagram no permite mandar fuera de la ventana.', window_closed: true }, 409);
        }
        const r = await igSend(env, igId, text);
        await logWaEvent(env, { to: igId, kind: 'ig-text', ref: '', ok: r.ok, messageId: r.id, error: r.error });
        if (!r.ok) return json({ error: r.error, raw: r.raw }, 500);
        try {
          await env.DB.prepare(
            "INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status, channel) VALUES (?, ?, 'outbound', ?, '', 'text', ?, '', '', 'sent', 'ig')"
          ).bind(new Date().toISOString(), r.id || '', igId, String(text)).run();
          // Aseguramos que el resumen quede marcado como IG (el trigger no toca channel).
          await env.DB.prepare("UPDATE wa_chats_summary SET channel='ig' WHERE phone=?").bind(igId).run();
        } catch (_) {}
        return json({ id: r.id });
      }

      // Enviar una FOTO por IG. Sube a R2, arma la URL publica (/admin/media/, sin
      // auth) y la manda por la Graph API. Caption (si hay) va como texto aparte.
      if (request.method === 'POST' && path === '/admin/ig/send-media') {
        const ctIg = request.headers.get('Content-Type') || '';
        if (!ctIg.includes('multipart/form-data')) return json({ error: 'expected multipart/form-data' }, 400);
        if (!env.MEDIA) return json({ error: 'R2 not configured' }, 500);
        const fd = await request.formData();
        const igId = String(fd.get('to') || '');
        const caption = fd.get('caption') || '';
        const file = fd.get('file');
        if (!igId || !file) return json({ error: 'missing to or file' }, 400);
        { const _role = await getSessionRole(env, session.user); if (!(await inboxAccessOk(env, _role, igId))) return json({ error: 'forbidden: chat fuera de tu bandeja' }, 403); }
        const fileMime = (file.type || '').split(';')[0].trim();
        const isImg = fileMime.startsWith('image/');
        const isAud = fileMime.startsWith('audio/');
        if (!isImg && !isAud) return json({ error: 'Por IG solo se pueden mandar imagenes o audios por ahora' }, 400);
        let lastTs = 0;
        try { const lastIn = await env.DB.prepare("SELECT MAX(ts) AS ts FROM wa_messages WHERE phone=? AND direction='inbound' AND channel='ig'").bind(igId).first(); lastTs = lastIn && lastIn.ts ? new Date(lastIn.ts).getTime() : 0; } catch (_) {}
        if (!(lastTs && (Date.now() - lastTs) < 24 * 3600 * 1000)) return json({ error: 'Ventana de 24 h cerrada: el cliente no escribio en las ultimas 24 h. Instagram no permite mandar fuera de la ventana.', window_closed: true }, 409);
        const fileName = file.name || ((isAud ? 'aud_' : 'img_') + Date.now());
        const ext = fileName.includes('.') ? '.' + fileName.split('.').pop() : (isAud ? '.m4a' : '.jpg');
        const r2Key = `ig/out_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`;
        await env.MEDIA.put(r2Key, await file.arrayBuffer(), { httpMetadata: { contentType: fileMime } });
        const mediaUrl = new URL(request.url).origin + '/admin/media/' + r2Key;
        const r = isAud ? await igSendAudio(env, igId, mediaUrl) : await igSendImage(env, igId, mediaUrl);
        await logWaEvent(env, { to: igId, kind: isAud ? 'ig-audio' : 'ig-image', ref: r2Key, ok: r.ok, messageId: r.id, error: r.error });
        if (!r.ok) return json({ error: r.error, raw: r.raw }, 500);
        const ts = new Date().toISOString();
        const mtype = isAud ? 'audio' : 'image';
        try {
          await env.DB.prepare("INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status, channel) VALUES (?, ?, 'outbound', ?, '', ?, '', ?, '', 'sent', 'ig')").bind(ts, r.id || ('ig-med-' + Date.now()), igId, mtype, r2Key).run();
          await env.DB.prepare("UPDATE wa_chats_summary SET channel='ig' WHERE phone=?").bind(igId).run();
        } catch (_) {}
        if (caption && String(caption).trim()) {
          const rc = await igSend(env, igId, String(caption));
          if (rc && rc.ok) { try { await env.DB.prepare("INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status, channel) VALUES (?, ?, 'outbound', ?, '', 'text', ?, '', '', 'sent', 'ig')").bind(new Date().toISOString(), rc.id || '', igId, String(caption)).run(); } catch (_) {} }
        }
        return json({ id: r.id, r2Key, media_url: r2Key });
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
            `SELECT phone, last_ts, last_body, last_direction, last_msg_type, contact_name, unread, inbox, channel
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
          `SELECT id, ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status, automated FROM wa_messages WHERE ${where} ORDER BY ts DESC LIMIT ?`
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

      // Schedule del broadcast de JUNIO 2026 (lanzamiento). Igual que el de cursos
      // pero lee fetchJunioLeads (filtrado 9 y 10 jun 2026) y encola kind='junio_broadcast'.
      if (request.method === 'POST' && path === '/admin/wa/junio-broadcast-schedule') {
        const role = await getSessionRole(env, session.user);
        if (role !== 'admin') return json({ error: 'forbidden' }, 403);
        let body; try { body = await request.json(); } catch { body = {}; }
        const count = Math.min(Math.max(parseInt(body?.count || '0', 10) || 0, 1), 1000);
        const startTs = body?.startTs ? new Date(body.startTs) : new Date();
        const endTs = body?.endTs ? new Date(body.endTs) : new Date(Date.now() + 4 * 60 * 60 * 1000);
        const dryRun = !!body?.dryRun;
        if (isNaN(startTs.getTime()) || isNaN(endTs.getTime()) || endTs <= startTs) {
          return json({ error: 'startTs/endTs inválidos' }, 400);
        }
        let data;
        try { data = await fetchJunioLeads(env); } catch (e) { return json({ error: 'no pude leer el sheet: ' + e.message }, 502); }
        const validos = data.leads.filter(l => l.valido);
        const yaSet = new Set();
        try {
          const rs = await env.DB.prepare("SELECT phone FROM wa_autoreply_log WHERE kind = 'junio_broadcast'").all();
          for (const r of (rs.results || [])) yaSet.add(r.phone);
        } catch (_) {}
        const unreachSet = new Set();
        try {
          const rs = await env.DB.prepare("SELECT phone FROM wa_unreachable_phones").all();
          for (const r of (rs.results || [])) unreachSet.add(r.phone);
        } catch (_) {}
        const pendientes = validos.filter(l => !yaSet.has(l.tel) && !unreachSet.has(l.tel)).slice(0, count);
        if (!pendientes.length) return json({ scheduled: 0, available: validos.length - yaSet.size, reason: 'no quedan leads pendientes' });
        const totalMs = endTs.getTime() - startTs.getTime();
        const step = pendientes.length > 1 ? totalMs / (pendientes.length - 1) : 0;
        const planned = pendientes.map((l, i) => ({
          tel: l.tel, nombre: l.nombre || '',
          due_at: new Date(startTs.getTime() + Math.round(i * step)).toISOString()
        }));
        if (dryRun) {
          return json({ dryRun: true, scheduled: planned.length, total_validos: validos.length, ya_encolados: yaSet.size,
            window: { startTs: startTs.toISOString(), endTs: endTs.toISOString(), step_seconds: Math.round(step / 1000) },
            primeros: planned.slice(0, 5), ultimos: planned.slice(-5) });
        }
        let scheduled = 0;
        for (const p of planned) {
          try {
            const r = await env.DB.prepare(
              "INSERT OR IGNORE INTO wa_autoreply_log (phone, kind, sent_at, status, due_at, sender_name) VALUES (?, 'junio_broadcast', '', 'queued', ?, ?)"
            ).bind(p.tel, p.due_at, p.nombre).run();
            if (r?.meta?.changes) scheduled++;
          } catch (_) {}
        }
        return json({ ok: true, scheduled, requested: planned.length,
          window: { startTs: startTs.toISOString(), endTs: endTs.toISOString(), step_seconds: Math.round(step / 1000) },
          primeros: planned.slice(0, 3), ultimos: planned.slice(-3) });
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
                  `INSERT INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, status, context_id, automated)
                   VALUES (?, ?, 'outbound', ?, '', 'template', ?, 'sent', '', 1)
                   ON CONFLICT(wamid) DO UPDATE SET body = excluded.body, msg_type = 'template', automated = 1
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

        // ¿Ventana de 24h abierta? (el cliente escribió en las últimas 24h). Si NO,
        // no intentamos el envío libre (imagen/texto): Meta lo acepta y después lo
        // rechaza async con 131047 ("Re-engagement message"), dejando el brief mal
        // marcado como enviado. Avisamos al front (window_closed) para que mande la
        // plantilla aprobada presupuesto_detallado, que SÍ se puede fuera de ventana.
        try {
          const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const inb = await env.DB.prepare(
            "SELECT 1 FROM wa_messages WHERE phone = ? AND direction = 'inbound' AND ts > ? LIMIT 1"
          ).bind(num, since24).first();
          if (!inb) return json({ error: 'Re-engagement message', window_closed: true }, 409);
        } catch (_) {}

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
        // Acepta wamids[] (varios mensajes, estilo WhatsApp) o wamid (uno solo, compat).
        const wamids = Array.isArray(body?.wamids) ? body.wamids : (body?.wamid ? [body.wamid] : []);
        const to_phones = Array.isArray(body?.to_phones) ? body.to_phones : [];
        if (!wamids.length || !to_phones.length) return json({ error: 'missing wamids or to_phones' }, 400);
        // Tope anti-spam: a Gaspar le bloquearon el número una vez por mandar de más.
        if (to_phones.length > 30) return json({ error: 'demasiados destinatarios (máx 30 por seguridad de WhatsApp)' }, 400);
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
        // Pre-fetch de los mensajes + subir su media UNA sola vez (se reusa el media_id para
        // todos los destinatarios → más rápido y menos carga en la API). Orden = el de wamids.
        const items = [];
        for (const w of wamids) {
          const original = await env.DB.prepare('SELECT msg_type, body, media_url FROM wa_messages WHERE wamid = ? LIMIT 1').bind(w).first();
          if (!original) continue;
          let up = null;
          if (original.msg_type !== 'text' && original.media_url && !/^https?:/i.test(original.media_url)) {
            up = await uploadFromR2ToMeta(original.media_url);
          }
          items.push({ original, up });
        }
        if (!items.length) return json({ error: 'ningún mensaje original encontrado' }, 404);
        results.recipients = to_phones.length;
        results.messages = items.length;
        for (const rawPhone of to_phones) {
          const num = normalizeArPhone(rawPhone);
          if (!num) { results.failed++; results.errors.push({ phone: rawPhone, error: 'numero invalido' }); continue; }
          for (const it of items) {
            const original = it.original;
            try {
              let res;
              if (original.msg_type === 'text' || !original.media_url) {
                res = await waSendText(env, num, original.body || '');
              } else if (!it.up) {
                results.failed++; results.errors.push({ phone: num, error: 'no se pudo subir media a Meta' }); continue;
              } else {
                const caption = cleanBody(original.body, original.msg_type);
                let payload;
                if (original.msg_type === 'image') payload = { messaging_product: 'whatsapp', to: num, type: 'image', image: { id: it.up.id, caption: caption || undefined } };
                else if (original.msg_type === 'video') payload = { messaging_product: 'whatsapp', to: num, type: 'video', video: { id: it.up.id, caption: caption || undefined } };
                else if (original.msg_type === 'audio') payload = { messaging_product: 'whatsapp', to: num, type: 'audio', audio: { id: it.up.id, voice: true } };
                else if (original.msg_type === 'sticker') payload = { messaging_product: 'whatsapp', to: num, type: 'sticker', sticker: { id: it.up.id } };
                else payload = { messaging_product: 'whatsapp', to: num, type: 'document', document: { id: it.up.id, caption: caption || undefined, filename: it.up.fileName } };
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

      // ===== Crear plantilla "al toque" + mandarla sola cuando Meta la apruebe =====
      // Para vendedores (Joaco/Abril): crean una plantilla a medida para ESTE chat
      // sin esperar la aprobación en pantalla. Guardrails de contenido + tope diario
      // + nombre auto (categoría siempre MARKETING). El cron processPendingTemplateSends
      // la manda apenas Meta la aprueba.
      if (request.method === 'POST' && path === '/admin/wa/template-create-send') {
        const role = await getSessionRole(env, session.user);
        if (!['admin', 'comercial', 'cursos'].includes(role)) return json({ error: 'forbidden' }, 403);
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const num = normalizeArPhone(String(body?.to || ''));
        if (!num) return json({ error: 'teléfono inválido' }, 400);
        if (!(await inboxAccessOk(env, role, num))) return json({ error: 'forbidden: chat fuera de tu bandeja' }, 403);
        const text = String(body?.body_text || '').trim();
        const vErr = validateAdhocTemplate(text);
        if (vErr) return json({ error: vErr }, 400);
        // Tope diario: 5 plantillas nuevas por usuario.
        const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
        try {
          const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM wa_pending_template_send WHERE created_by = ? AND created_at >= ?").bind(session.user, dayStart.toISOString()).first();
          if (c && c.n >= 100) return json({ error: 'Llegaste al máximo de 100 plantillas nuevas por día.' }, 429);
        } catch (_) {}
        const tplName = 'adhoc_' + Date.now();
        const _waT = getWaClient(env);
        const r = await fetch(_waT.templatesUrl(), {
          method: 'POST', headers: { ..._waT.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: tplName, category: 'MARKETING', language: 'es_AR', components: [{ type: 'BODY', text }] })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: data?.error?.message || 'Meta rechazó la creación de la plantilla', raw: data }, r.status || 500);
        try {
          await env.DB.prepare(
            "INSERT OR REPLACE INTO wa_pending_template_send (template_name, phone, body_preview, created_by, created_at, status, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
          ).bind(tplName, num, text.slice(0, 300), session.user, new Date().toISOString(), new Date().toISOString()).run();
        } catch (_) {}
        return json({ ok: true, template_name: tplName, status: data.status || 'pending' });
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
      // One-off: reenvía a un número TODAS las imágenes/PDF inbound desde un
      // timestamp. Usado en el lanzamiento junio para que Gaspar reciba en su
      // WhatsApp personal todos los comprobantes que entraron. Gaspar-only.
      // Robusto: timeout por item (un upload colgado NO cuelga toda la request),
      // budget total (corta y devuelve last_id para continuar) e idempotencia
      // (marca cada envío en kv_cache para que reintentos no dupliquen).
      // Paginado por id estable. Body: { since, to, limit?, after_id?, delay_ms? }.
      if (request.method === 'POST' && path === '/admin/wa/resend-media') {
        if (!session || session.user !== 'Gaspar') return json({ error: 'forbidden' }, 403);
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const since = String(body?.since || '').trim();
        const to = String(body?.to || '').trim();
        const afterId = parseInt(body?.after_id || '0', 10) || 0;
        const limit = Math.min(Math.max(parseInt(body?.limit || '8', 10) || 8, 1), 50);
        const delayMs = Math.min(Math.max(parseInt(body?.delay_ms || '250', 10) || 250, 0), 3000);
        const itemTimeoutMs = Math.min(Math.max(parseInt(body?.item_timeout_ms || '15000', 10) || 15000, 3000), 45000);
        const maxReqMs = Math.min(Math.max(parseInt(body?.max_req_ms || '45000', 10) || 45000, 5000), 110000);
        if (!since || !to) return json({ error: 'missing since or to' }, 400);
        const num = normalizeArPhone(to);
        if (!num) return json({ error: 'numero destino invalido' }, 400);
        let rows;
        try {
          const rs = await env.DB.prepare(
            "SELECT m.id, m.wamid, m.phone, m.sender_name, m.msg_type, m.media_url, m.ts, " +
            "       p.monto AS p_monto, p.cuenta AS p_cuenta, p.clasificacion AS p_clase " +
            "FROM wa_messages m " +
            "LEFT JOIN wa_pago_proof p ON p.wamid = m.wamid " +
            "WHERE m.direction='inbound' AND m.msg_type IN ('image','document') " +
            "  AND m.ts >= ? AND m.id > ? AND m.media_url IS NOT NULL AND m.media_url != '' " +
            "ORDER BY m.id ASC LIMIT ?"
          ).bind(since, afterId, limit).all();
          rows = rs.results || [];
        } catch (e) { return json({ error: 'query failed: ' + e.message }, 500); }

        const fmtMonto = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
        const cuentaLabel = (c) => c === 'mp_gaspar' ? 'MP Gaspar' : c === 'bna_bruno' ? 'BNA Bruno' : (c === 'otra' ? 'otra cuenta' : (c || 'cuenta?'));
        const withTimeout = (p, ms, label) => Promise.race([
          Promise.resolve(p),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + label)), ms))
        ]);
        const startMs = Date.now();
        let sent = 0, failed = 0, skipped = 0, lastId = afterId, truncated = false; const errors = [];
        for (const r of rows) {
          if (Date.now() - startMs > maxReqMs) { truncated = true; break; }
          lastId = r.id;
          const ckey = 'resent:' + num + ':' + r.wamid;
          // idempotencia: si ya lo reenviamos a este número, saltar
          try {
            const seen = await env.DB.prepare("SELECT 1 AS x FROM kv_cache WHERE k = ?").bind(ckey).first();
            if (seen) { skipped++; continue; }
          } catch (_) {}
          try {
            const obj = await withTimeout(env.MEDIA.get(r.media_url), itemTimeoutMs, 'r2');
            if (!obj) { failed++; errors.push({ id: r.id, phone: r.phone, error: 'no en R2' }); continue; }
            const buf = await withTimeout(obj.arrayBuffer(), itemTimeoutMs, 'r2-read');
            const mime = obj.httpMetadata?.contentType || (r.msg_type === 'image' ? 'image/jpeg' : 'application/pdf');
            const baseName = (r.media_url.split('/').pop() || '');
            const dotExt = baseName.includes('.') ? ('.' + baseName.split('.').pop()) : '';
            const ext = dotExt || (r.msg_type === 'image' ? '.jpg' : (mime.includes('pdf') ? '.pdf' : ''));
            const fileName = r.msg_type === 'document' ? ('comprobante_' + r.phone + ext) : (baseName || ('img' + ext));
            const mediaId = await withTimeout(uploadMediaToMeta(env, buf, mime, fileName), itemTimeoutMs, 'upload');
            if (!mediaId) { failed++; errors.push({ id: r.id, phone: r.phone, error: 'upload a Meta fallo' }); continue; }
            // ART hh:mm (UTC-3)
            const d = new Date(r.ts);
            const art = new Date(d.getTime() - 3 * 3600 * 1000);
            const hhmm = String(art.getUTCHours()).padStart(2, '0') + ':' + String(art.getUTCMinutes()).padStart(2, '0');
            const quien = (r.sender_name && r.sender_name.trim()) ? r.sender_name.trim() : r.phone;
            let cap = quien + ' · ' + r.phone + ' · ' + hhmm;
            if (r.p_monto && r.p_monto > 0) cap += '\n$' + fmtMonto(r.p_monto) + ' · ' + cuentaLabel(r.p_cuenta);
            let res;
            if (r.msg_type === 'image') res = await withTimeout(waSendImage(env, num, mediaId, cap), itemTimeoutMs, 'send');
            else res = await withTimeout(waSendDocument(env, num, mediaId, fileName, cap), itemTimeoutMs, 'send');
            if (res && res.ok) {
              sent++;
              try { await env.DB.prepare("INSERT OR REPLACE INTO kv_cache (k, v, updated_at) VALUES (?, ?, ?)").bind(ckey, '1', new Date().toISOString()).run(); } catch (_) {}
            } else { failed++; errors.push({ id: r.id, phone: r.phone, error: (res && res.error) || 'send fallo', code: res && res.code }); }
          } catch (e) { failed++; errors.push({ id: r.id, phone: r.phone, error: String(e && e.message || e) }); }
          if (delayMs) await new Promise(rr => setTimeout(rr, delayMs));
        }
        return json({ ok: true, batch: rows.length, sent, failed, skipped, last_id: lastId, truncated, done: !truncated && rows.length < limit, errors: errors.slice(0, 30) });
      }
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
        // wa/ y briefs/ son content-addressed (la key nunca cambia de contenido) →
        // cache inmutable de 1 año, así no se re-bajan las fotos en cada primera
        // apertura del día (antes era 24h y se vencía cada noche). promo/ puede
        // re-subirse con la misma key → cache corto de 24h.
        const immutableMedia = key.startsWith('wa/') || key.startsWith('briefs/') || key.startsWith('ig/');
        return new Response(obj.body, {
          headers: {
            ...cors(),
            'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
            'Cache-Control': immutableMedia ? 'public, max-age=31536000, immutable' : 'public, max-age=86400'
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
          const { phone, body: text, scheduled_at, template, params, lang } = it || {};
          // Acepta texto libre Y/O plantilla. La plantilla se usa al enviar si la
          // ventana de 24h está cerrada (que es lo normal al día siguiente). Al menos
          // uno de los dos es obligatorio.
          if (!phone || !scheduled_at || (!text && !template)) { created.push({ error: 'missing phone, scheduled_at, or (body|template)' }); continue; }
          const num = normalizeArPhone(phone);
          if (!num) { created.push({ error: 'numero invalido', phone }); continue; }
          const now = new Date().toISOString();
          const rs = await env.DB.prepare(
            'INSERT INTO scheduled_messages (phone, body, scheduled_at, status, created_at, template, template_params, lang) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(num, text || '', scheduled_at, 'pending', now, template || null, params ? JSON.stringify(params) : null, lang || 'es_AR').run();
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
      // Pedidos (migración del Excel de Ventas a D1 — fuente de verdad)
      // ============================================================

      // GET /admin/pedidos → todas las filas de la tabla pedidos.
      if (request.method === 'GET' && path === '/admin/pedidos') {
        await ensurePedidosSchema(env);
        const rs = await env.DB.prepare('SELECT * FROM pedidos ORDER BY fecha DESC, numero DESC, id DESC').all();
        return json({ pedidos: rs.results || [] });
      }

      // POST /admin/pedidos/backfill → importa (idempotente) los pedidos del Excel
      // de Ventas hoja "2026" a D1. Borra solo lo previamente importado (origen=
      // 'backfill') y reinserta; preserva los creados en el CRM (origen='crm').
      if (request.method === 'POST' && path === '/admin/pedidos/backfill') {
        await ensurePedidosSchema(env);
        const VENTAS_SID = '1qKUhSDDjBV4k8W0goPhOFzEhLz0Zeruq2slLpb9bWSg';
        const u = `https://docs.google.com/spreadsheets/d/${VENTAS_SID}/gviz/tq?tqx=out:csv&sheet=2026`;
        const r = await fetch(u);
        if (!r.ok) return json({ error: 'no se pudo leer el Excel de Ventas: HTTP ' + r.status }, 502);
        const rows = parseCsv(await r.text());
        if (rows.length < 2) return json({ error: 'el Excel de Ventas vino vacío' }, 502);
        const now = new Date().toISOString();
        let skipped = 0;
        const stmts = [env.DB.prepare("DELETE FROM pedidos WHERE origen = 'backfill'")];
        for (let i = 1; i < rows.length; i++) {
          const c = rows[i];
          if (!c || !String(c[2] || '').trim()) { skipped++; continue; }  // necesita cartel
          const fecha = pedidoFecha(c[0]);
          if (!fecha) { skipped++; continue; }                            // necesita fecha válida
          stmts.push(env.DB.prepare(
            `INSERT INTO pedidos (numero, fecha, cartel, colores, alto, ancho, cm_neon, base, cantidad, precio, dimer, precio_dimmer, envio, aclaracion, productor, plataforma, estado_pago, pagado, restante, estado_pedido, ad, sheet_row, origen, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'backfill', ?, ?)`
          ).bind(
            pedidoNum(c[1]), fecha, String(c[2] || '').trim(), String(c[3] || '').trim(),
            pedidoNum(c[4]), pedidoNum(c[5]), pedidoNum(c[6]), String(c[7] || '').trim(),
            pedidoNum(c[8]) || 1, pedidoNum(c[9]), String(c[10] || '').trim(), pedidoNum(c[11]),
            String(c[12] || '').trim(), String(c[13] || '').trim(), String(c[14] || '').trim(), String(c[15] || '').trim(),
            String(c[16] || '').trim(), pedidoNum(c[17]), pedidoNum(c[18]), String(c[19] || '').trim(),
            String(c[20] || '').trim(), i + 1, now, now
          ));
        }
        const inserted = stmts.length - 1;
        const CHUNK = 50;
        for (let j = 0; j < stmts.length; j += CHUNK) {
          await env.DB.batch(stmts.slice(j, j + CHUNK));
        }
        return json({ ok: true, inserted, skipped, total_rows: rows.length });
      }

      // POST /admin/pedidos → crea un pedido (1+ carteles que comparten número).
      // numero = max+1 (server-side); fecha = hoy si no viene; estado_pedido fijo
      // 'En produccion'; pagado/restante a nivel pedido (restante = total − pagado)
      // replicados en cada fila. origen='crm' (lo distingue del backfill del Excel).
      if (request.method === 'POST' && path === '/admin/pedidos') {
        await ensurePedidosSchema(env);
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const carteles = Array.isArray(body.carteles) ? body.carteles.filter(c => c && String(c.cartel || '').trim()) : [];
        if (!carteles.length) return json({ error: 'falta al menos un cartel con nombre' }, 400);
        const now = new Date().toISOString();
        const fecha = (body.fecha && /^\d{4}-\d{2}-\d{2}$/.test(body.fecha)) ? body.fecha : now.slice(0, 10);
        // El número viene del front (auto-sugerido pero editable por Joaco, porque
        // el numbering del Excel es inconsistente). Si no viene, fallback a max+1.
        const bodyNum = Math.floor(Number(body.numero));
        let numero;
        if (Number.isFinite(bodyNum) && bodyNum > 0) {
          numero = bodyNum;
        } else {
          const mx = await env.DB.prepare('SELECT MAX(numero) AS m FROM pedidos').first();
          numero = (mx && mx.m ? Math.floor(Number(mx.m)) : 0) + 1;
        }
        const num = (v) => (v == null || v === '') ? null : (isNaN(Number(v)) ? null : Number(v));
        const total = carteles.reduce((s, c) => s + (num(c.precio) || 0) + (num(c.precio_dimmer) || 0), 0);
        const pagado = num(body.pagado);
        const restante = pagado != null ? Math.max(0, total - pagado) : total;
        const plataforma = body.plataforma === 'IG' ? 'IG' : 'WPP';
        const estadoPago = String(body.estado_pago || '1er pago');
        const ad = String(body.ad || '');
        const telefono = String(body.telefono || '').replace(/\D/g, '');
        const stmts = carteles.map(c => env.DB.prepare(
          `INSERT INTO pedidos (numero, fecha, cartel, colores, alto, ancho, cm_neon, base, cantidad, precio, dimer, precio_dimmer, envio, aclaracion, tramos, tipo, productor, plataforma, estado_pago, pagado, restante, estado_pedido, ad, telefono, sheet_row, origen, mirror_dirty, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, '', ?, ?, ?, ?, 'En produccion', ?, ?, NULL, 'crm', 1, ?, ?)`
        ).bind(
          numero, fecha, String(c.cartel || '').trim(), String(c.colores || '').trim(),
          num(c.alto), num(c.ancho), num(c.cm_neon), String(c.base || '').trim(),
          num(c.cantidad) || 1, num(c.precio), String(c.dimer || 'NO').trim(), num(c.precio_dimmer),
          String(c.envio || '').trim(), String(c.aclaracion || '').trim(), num(c.tramos), String(c.tipo || '').trim(),
          plataforma, estadoPago, pagado, restante, ad, telefono, now, now
        ));
        await env.DB.batch(stmts);
        const rs = await env.DB.prepare('SELECT * FROM pedidos WHERE numero = ? AND origen = ? ORDER BY id').bind(numero, 'crm').all();
        return json({ ok: true, numero, pedidos: rs.results || [] });
      }

      // PATCH /admin/pedidos/:id → edita un pedido. Dos alcances:
      //  - Campos del CARTEL (solo esta fila, por id): cartel, base, dimer, precio, ad,
      //    envio, aclaracion.
      //  - Campos del PEDIDO (todas las filas del numero+fecha): estado_pedido,
      //    estado_pago, productor, pagado.
      // Si cambia el precio (cartel) o el pagado (pedido), recalcula el restante del
      // pedido = (Σ precio + Σ precio_dimmer) − pagado. Todo marca mirror_dirty.
      if (request.method === 'PATCH' && /^\/admin\/pedidos\/\d+$/.test(path)) {
        await ensurePedidosSchema(env);
        const id = parseInt(path.split('/').pop(), 10);
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const ref = await env.DB.prepare('SELECT numero, fecha FROM pedidos WHERE id = ?').bind(id).first();
        if (!ref) return json({ error: 'pedido no encontrado' }, 404);
        const now = new Date().toISOString();
        let touched = false, precioChanged = false;

        // 1) Campos del CARTEL → UPDATE solo esta fila (por id).
        const cSets = [], cArgs = [];
        if ('cartel' in body)     { cSets.push('cartel = ?');     cArgs.push(String(body.cartel || '').trim()); }
        if ('base' in body)       { cSets.push('base = ?');       cArgs.push(String(body.base || '').trim()); }
        if ('dimer' in body)      { cSets.push('dimer = ?');      cArgs.push(String(body.dimer || '').trim()); }
        if ('ad' in body)         { cSets.push('ad = ?');         cArgs.push(String(body.ad || '').trim()); }
        if ('envio' in body)      { cSets.push('envio = ?');      cArgs.push(String(body.envio || '').trim()); }
        if ('aclaracion' in body) { cSets.push('aclaracion = ?'); cArgs.push(String(body.aclaracion || '').trim()); }
        if ('precio' in body) {
          const pv = (body.precio === '' || body.precio == null) ? null : (isNaN(Number(body.precio)) ? null : Number(body.precio));
          cSets.push('precio = ?'); cArgs.push(pv); precioChanged = true;
        }
        if (cSets.length) {
          cSets.push('mirror_dirty = 1', 'mirror_attempts = 0', 'mirror_error = NULL', 'updated_at = ?');
          cArgs.push(now, id);
          await env.DB.prepare(`UPDATE pedidos SET ${cSets.join(', ')} WHERE id = ?`).bind(...cArgs).run();
          touched = true;
        }

        // 2) Campos del PEDIDO → UPDATE todas las filas del numero+fecha. Recalcula el
        //    restante si cambió el precio (ya aplicado arriba) o el pagado.
        const oSets = [], oArgs = [];
        if ('estado_pedido' in body) { oSets.push('estado_pedido = ?'); oArgs.push(String(body.estado_pedido || '')); }
        if ('estado_pago' in body)   { oSets.push('estado_pago = ?');   oArgs.push(String(body.estado_pago || '')); }
        if ('productor' in body)     { oSets.push('productor = ?');     oArgs.push(String(body.productor || '')); }
        const pagadoInBody = ('pagado' in body);
        if (pagadoInBody || precioChanged) {
          let pagado;
          if (pagadoInBody) { pagado = (body.pagado === '' || body.pagado == null) ? null : Number(body.pagado); }
          else { const cur = await env.DB.prepare('SELECT pagado FROM pedidos WHERE numero = ? AND fecha = ? LIMIT 1').bind(ref.numero, ref.fecha).first(); pagado = (cur && cur.pagado != null) ? Number(cur.pagado) : null; }
          const tot = await env.DB.prepare('SELECT COALESCE(SUM(precio),0) + COALESCE(SUM(precio_dimmer),0) AS t FROM pedidos WHERE numero = ? AND fecha = ?').bind(ref.numero, ref.fecha).first();
          const total = tot ? Number(tot.t) : 0;
          const restante = pagado != null ? Math.max(0, total - pagado) : total;
          oSets.push('pagado = ?', 'restante = ?'); oArgs.push(pagado, restante);
        }
        if (oSets.length) {
          oSets.push('mirror_dirty = 1', 'mirror_attempts = 0', 'mirror_error = NULL', 'updated_at = ?');
          oArgs.push(now, ref.numero, ref.fecha);
          await env.DB.prepare(`UPDATE pedidos SET ${oSets.join(', ')} WHERE numero = ? AND fecha = ?`).bind(...oArgs).run();
          touched = true;
        }

        if (!touched) return json({ error: 'nada para actualizar' }, 400);
        const rs2 = await env.DB.prepare('SELECT * FROM pedidos WHERE numero = ? AND fecha = ? ORDER BY id').bind(ref.numero, ref.fecha).all();
        return json({ ok: true, numero: ref.numero, pedidos: rs2.results || [] });
      }

      // POST /admin/pedidos/sync-productores → trae el productor del Excel a D1
      // (solo ese campo, por sheet_row). On-demand; también corre solo en el cron.
      if (request.method === 'POST' && path === '/admin/pedidos/sync-productores') {
        await ensurePedidosSchema(env);
        const changed = await syncProductoresFromVentas(env);
        return json({ ok: true, changed });
      }

      // POST /admin/pedidos/import-excel → importa al CRM los pedidos nuevos cargados a
      // mano en el Excel (sync Excel → CRM, on-demand; también corre solo en el cron).
      if (request.method === 'POST' && path === '/admin/pedidos/import-excel') {
        await ensurePedidosSchema(env);
        const imported = await importNewPedidosFromVentas(env);
        return json({ ok: true, imported });
      }

      // POST /admin/pedidos/mirror-resync → marca los pedidos creados en el CRM
      // (origen='crm') como mirror_dirty para que el cron los empuje al Excel.
      // Sirve para el primer push tras activar el espejo, o para forzar re-sync.
      if (request.method === 'POST' && path === '/admin/pedidos/mirror-resync') {
        await ensurePedidosSchema(env);
        const res = await env.DB.prepare("UPDATE pedidos SET mirror_dirty = 1, mirror_attempts = 0, mirror_error = NULL WHERE origen = 'crm'").run();
        return json({ ok: true, marcados: (res.meta && res.meta.changes) || 0 });
      }

      // POST /admin/pedidos/mirror-run → fuerza una corrida del espejo ahora mismo
      // (sin esperar el cron) y devuelve el diagnóstico { checked, pushed } o { error }.
      if (request.method === 'POST' && path === '/admin/pedidos/mirror-run') {
        await ensurePedidosSchema(env);
        const result = await processPedidosMirror(env);
        return json({ ok: true, result });
      }

      // GET /admin/pedidos/mirror-debug → testea el path POST worker→Apps Script con un
      // pedido_ping (NO escribe nada) y reporta si llegó al doPost. Diagnóstico.
      if (request.method === 'GET' && path === '/admin/pedidos/mirror-debug') {
        if (!env.APPS_SCRIPT_URL) return json({ error: 'no APPS_SCRIPT_URL' });
        try {
          const j = await appsScriptPost(env, { action: 'pedido_ping' });
          return json({ ok: true, reached: !!(j && j.pong), response: j });
        } catch (e) {
          return json({ error: String((e && e.message) || e) });
        }
      }

      // GET /admin/pedidos/mirror-failures → lista los pedidos que la red de seguridad
      // marcó con error de espejo (mirror_error no nulo). Para revisarlos y corregirlos.
      if (request.method === 'GET' && path === '/admin/pedidos/mirror-failures') {
        await ensurePedidosSchema(env);
        const rs = await env.DB.prepare("SELECT id, numero, fecha, cartel, estado_pedido, estado_pago, mirror_attempts, mirror_error FROM pedidos WHERE mirror_error IS NOT NULL ORDER BY id").all();
        return json({ ok: true, fallos: rs.results || [] });
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
          'cliente_wa_id', 'cliente_nombre', 'origen_lead', 'estado', 'tipo', 'diseno', 'corporea_json',
          'alto_cm', 'ancho_cm', 'm2', 'neon_mt', 'tramos', 'medidas_libre',
          'precio_trans', 'precio_negro', 'precio_final',
          'descuento', 'recargo', 'reventa', 'comision_joaco',
          'comercial_id', 'disenador_id', 'notas',
          'urgente', 'modificar',
          'created_at', 'updated_at'
        ];
        const vals = [
          body.cliente_wa_id || '', body.cliente_nombre || null, body.origen_lead || '',
          body.estado || 'nuevo', body.tipo || null, body.diseno || null, body.corporea_json ?? null,
          body.alto_cm ?? null, body.ancho_cm ?? null, body.m2 ?? null, body.neon_mt ?? null, body.tramos ?? 0,
          body.medidas_libre || null,
          body.precio_trans ?? null, body.precio_negro ?? null, body.precio_final ?? null,
          body.descuento ?? 0, body.recargo ?? 0, body.reventa ?? 0, body.comision_joaco ?? 0,
          comercial_id, body.disenador_id || null, body.notas || null,
          body.urgente ?? 0, body.modificar ?? 0,
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
          'cliente_nombre', 'cliente_wa_id', 'origen_lead', 'estado', 'tipo', 'diseno', 'corporea_json',
          'alto_cm', 'ancho_cm', 'm2', 'neon_mt', 'tramos', 'medidas_libre',
          'precio_trans', 'precio_negro', 'precio_final',
          'descuento', 'recargo', 'reventa', 'comision_joaco',
          'disenador_id', 'intentos_followup', 'notas', 'sheet_row',
          'urgente', 'modificar'
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
      // POST /admin/render-adhoc — render IA "suelto" (SIN brief): lo usa el
      // cotizador rápido de #presupuestos para hacer un mockup al toque sin pasar
      // por el flujo del panel. Recibe una foto (multipart) + notas opcionales,
      // genera el render con Gemini y lo devuelve en base64. El front lo muestra y,
      // al enviar el presupuesto, lo manda como foto + caption (igual que el panel).
      if (request.method === 'POST' && path === '/admin/render-adhoc') {
        if (!env.GEMINI_API_KEY) return json({ error: 'Falta configurar GEMINI_API_KEY en el worker' }, 503);
        const ctType = request.headers.get('Content-Type') || '';
        if (!ctType.includes('multipart/form-data')) return json({ error: 'expected multipart/form-data' }, 400);
        let fd; try { fd = await request.formData(); } catch { return json({ error: 'invalid form-data' }, 400); }
        const file = fd.get('file');
        if (!file || typeof file.arrayBuffer !== 'function') return json({ error: 'missing file' }, 400);
        const buf = await file.arrayBuffer();
        if (!buf || buf.byteLength < 64) return json({ error: 'imagen inválida o vacía' }, 400);
        const mime = (file.type || 'image/jpeg').split(';')[0].trim();
        const notas = String(fd.get('notas') || '').trim();
        const contexto = notas ? `NOTAS / INSTRUCCIONES ESPECÍFICAS PARA ESTE DISEÑO (tomalas en cuenta):\n${notas}` : '';
        const renderResult = await generarRenderConGemini(env, buf, mime, contexto);
        if (!renderResult || renderResult.error) {
          return json({ error: 'render: ' + ((renderResult && renderResult.error) || 'sin respuesta de la IA') }, 502);
        }
        return json({ ok: true, mime: renderResult.mime, base64: renderResult.base64 });
      }

      // POST /admin/rectify-perspective  →  endereza la perspectiva de una foto a vista
      // frontal (herramienta del diseñador). Body: imagen cruda (Content-Type image/*).
      // Reusa la cañería de Gemini image con GEMINI_RECTIFY_PROMPT. Devuelve { ok, base64, mime }.
      if (request.method === 'POST' && (path === '/admin/img-tool' || path === '/admin/rectify-perspective')) {
        if (!env.GEMINI_API_KEY) return json({ error: 'Falta configurar GEMINI_API_KEY en el worker' }, 503);
        // modo: rectify (perspectiva -> frontal) | vectorize (silueta B&N para Illustrator).
        // La ruta vieja /admin/rectify-perspective queda como rectify por retrocompat.
        const mode = path === '/admin/rectify-perspective' ? 'rectify' : (url.searchParams.get('mode') || 'rectify');
        const basePrompt = mode === 'vectorize' ? GEMINI_VECTORIZE_PROMPT : GEMINI_RECTIFY_PROMPT;
        const ct = (request.headers.get('content-type') || '').split(';')[0].trim();
        if (!ct.startsWith('image/')) return json({ error: 'Mandá la imagen cruda con Content-Type image/*' }, 400);
        let buf;
        try { buf = await request.arrayBuffer(); } catch (e) { return json({ error: 'No pude leer la imagen: ' + e.message }, 400); }
        if (!buf || buf.byteLength < 100) return json({ error: 'Imagen vacía o demasiado chica' }, 400);
        if (buf.byteLength > 12 * 1024 * 1024) return json({ error: 'Imagen muy grande (máx 12 MB)' }, 400);
        const notes = (url.searchParams.get('notes') || '').trim();
        const extraTexto = notes ? ('Aclaración adicional del diseñador (respetala): ' + notes) : '';
        const r = await generarRenderConGemini(env, buf, ct, extraTexto, { basePrompt, ref: 'imgtool:' + mode });
        if (!r.ok) return json({ error: r.error || 'No se pudo procesar la imagen' }, 502);
        return json({ ok: true, base64: r.base64, mime: r.mime });
      }

      // POST /admin/img-mockup  →  monta el render de un cartel sobre la foto del local
      // (montaje hiperrealista). Body JSON: { canvas, render, canvasMime, renderMime } en
      // base64 crudo. 'canvas' = la foto del local CON el recuadro marcado (dónde va el cartel).
      if (request.method === 'POST' && path === '/admin/img-mockup') {
        if (!env.GEMINI_API_KEY) return json({ error: 'Falta configurar GEMINI_API_KEY en el worker' }, 503);
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const canvasB64 = String((body && body.canvas) || '');
        const renderB64 = String((body && body.render) || '');
        if (!canvasB64 || !renderB64) return json({ error: 'Faltan las dos imágenes (local marcado + render del cartel)' }, 400);
        if (canvasB64.length > 24 * 1024 * 1024 || renderB64.length > 24 * 1024 * 1024) return json({ error: 'Imagen muy grande' }, 400);
        const notes = String((body && body.notes) || '').trim();
        const extraTexto = notes ? ('Aclaración adicional del diseñador (respetala): ' + notes) : '';
        const r = await generarRenderConGemini(env, null, (body && body.canvasMime) || 'image/png', extraTexto, {
          basePrompt: GEMINI_MOCKUP_PROMPT,
          mainBase64: canvasB64,
          extraImages: [{ base64: renderB64, mime: (body && body.renderMime) || 'image/png' }],
          ref: 'mockup'
        });
        if (!r.ok) return json({ error: r.error || 'No se pudo generar el montaje' }, 502);
        return json({ ok: true, base64: r.base64, mime: r.mime });
      }

      // GET /admin/analytics/precotiz-funnel  →  funnel pre-cotización de carteles por mes
      // + cohorte revivible (últimos 60 días sin presupuesto). Solo admin; query pesada
      // (scan de wa_messages) — no llamar en polls.
      if (request.method === 'GET' && path === '/admin/analytics/precotiz-funnel') {
        const role = await getSessionRole(env, session.user);
        if (role !== 'admin') return json({ error: 'forbidden' }, 403);
        return analyticsPrecotizFunnel(env, url);
      }

      // POST /admin/briefs/:id/generar-render  →  pipeline IA completo en paralelo:
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
        let contexto = contextoLines.join('\n');

        // Corpóreas (tipo='corporea'): prompt distinto (letra 3D maciza, no neón) +
        // contexto del caso visual A-E (según qué caras son translúcidas/opacas) que
        // se antepone. NO se estima neón/ancho/alto como en carteles — las medidas las
        // carga el usuario en el form, así que params queda null.
        const esCorporea = brief.tipo === 'corporea';
        if (esCorporea) {
          contexto = corporeaContexto(brief) + (contexto ? `\n\n${contexto}` : '');
        }

        // En PARALELO: render (caro, lento) + params (barato, rápido).
        // Si una falla y la otra OK, devolvemos lo que hay y reportamos el error parcial.
        const [renderResult, paramsResult] = await Promise.all([
          generarRenderConGemini(env, inputBuf, inputRow.content_type, contexto, esCorporea ? { basePrompt: GEMINI_CORPOREA_RENDER_PROMPT } : {}),
          esCorporea ? Promise.resolve({ ok: false, error: null }) : estimarParametrosConGemini(env, inputBuf, inputRow.content_type, contexto)
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
    // Espejo de pedidos al Excel de Ventas (gateado por flag kv 'pedidos_mirror_on';
    // no hace nada hasta que se active tras deployar el Apps Script).
    ctx.waitUntil(processPedidosMirror(env));
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
    // Goteo del broadcast de JUNIO 2026. Encolado vía /admin/wa/junio-broadcast-schedule.
    ctx.waitUntil(processJunioBroadcastQueue(env));
    // Goteo del broadcast "1 cupo · Comunidad Al Infinito" a no-pagadores del form de junio.
    ctx.waitUntil(processCupoBroadcastQueue(env));
    ctx.waitUntil(processCustomBroadcasts(env));
    ctx.waitUntil(processBroadcastReplies(env));
    ctx.waitUntil(processBroadcastFollowups(env));
    ctx.waitUntil(processCursosFlow(env));
    // Backfill del reenvío de comprobantes a Gaspar (lanzamiento, hoy+mañana):
    // reintenta los inbound media que el reenvío en vivo no logró mandar (glitch
    // de Meta o ventana 24h momentáneamente cerrada). Idempotente vía kv_cache,
    // se auto-apaga pasada la ventana, y si no hay pendientes no hace nada.
    ctx.waitUntil(processGasparResendBackfill(env));
    // Piloto de pre cotización automática (carteles): capta leads del 20% y los
    // releva con freno de mano. Gateado internamente (kill-switch OFF por defecto
    // + horario 8-22 AR). Corre en cada tick para responder en ~1-2 min.
    ctx.waitUntil(processPrecotizPilot(env));
    // Landing del minicurso gratuito: opener a los 45 min (plantilla) + branch por
    // IA + follow-up 23h. Gateado (kill-switch OFF por defecto + horario 8-22 AR).
    // Corre en cada tick para responder rápido; guardia anti-choque con el flujo de ads.
    ctx.waitUntil(processMinicursoLanding(env));
    // Tick rápido (cron */1): solo la cola, no el resto de tareas pesadas.
    if (event.cron === '* * * * *') return;
    ctx.waitUntil(processScheduledMessages(env));
    // Refresca el token largo de IG antes de que venza (se autogatea a 1 vez/día).
    ctx.waitUntil(igMaybeRefreshToken(env));
    // Cada ~30 min: traer del Excel de Ventas el campo `productor` (Gaspar lo carga ahí).
    if (new Date().getUTCMinutes() % 30 < 5) ctx.waitUntil(syncProductoresFromVentas(env));
    // Cada ~15 min: importar al CRM los pedidos nuevos cargados a mano en el Excel.
    if (new Date().getUTCMinutes() % 15 < 5) ctx.waitUntil(importNewPedidosFromVentas(env));
    // Follow-ups en horario hábil AR (8-20): campaña de cursos + minicurso (4h sin responder).
    const hAR = (new Date(event.scheduledTime).getUTCHours() - 3 + 24) % 24;
    if (hAR >= 8 && hAR < 20) {
      ctx.waitUntil(processCursosFollowup(env));
      ctx.waitUntil(processMinicursoFollowup(env));
    }
    // Followups de Apps Script solo a las 13:00 UTC (10:00 AR)
    const hour = new Date(event.scheduledTime).getUTCHours();
    if (hour === 13) ctx.waitUntil(runScheduled(env));
    // Sync diario del mapa de anuncios de IG (post promocionado -> ad_id + campaña), para darle
    // a los leads de IG la misma trazabilidad que WhatsApp. No-op hasta que exista META_ADS_TOKEN.
    if (hour === 13) ctx.waitUntil(syncIgAdMap(env));
    // Follow-up automático de presupuestos del cotizador: solo horario hábil AR (8-20).
    // Usa hAR (calculado más arriba en este mismo handler) para consistencia
    // con processCursosFollowup/processMinicursoFollowup.
    // Seguimientos de presupuesto: NO los domingos (hora AR). Los que caen domingo
    // salen el lunes a primera hora (8 AR); el lunes ampliamos la ventana a 72h para
    // levantar el backlog del finde sin perder ninguno (el dedup evita repetir).
    const dowAR = new Date(new Date(event.scheduledTime).getTime() - 3 * 3600 * 1000).getUTCDay(); // 0=domingo
    if (hAR >= 8 && hAR <= 20 && dowAR !== 0) ctx.waitUntil(processPresupuestoFollowups(env, { maxAgeHours: dowAR === 1 ? 72 : 48 }));
    // Anti-colgados: etiqueta "⏳ Te toca" los leads tibios que nos quedaron debiendo
    // respuesta + resumen 2x/día a Joaco y Gaspar (ver playbook §A4.1).
    if (hAR >= 8 && hAR <= 20) ctx.waitUntil(processColgados(env));
    // Aviso a Gaspar cuando el dataset ya tiene suficientes QualifiedLead (CAPI) para cambiar la campaña.
    if (hAR >= 9 && hAR <= 20) ctx.waitUntil(maybeCapiReadyNotice(env));
    // Plantillas "al toque": mandar las que Meta ya aprobó (horario hábil AR 8-21).
    if (hAR >= 8 && hAR < 21) ctx.waitUntil(processPendingTemplateSends(env));
    // Monitor de status de templates: 1 vez por hora, no cada 5 min. El polling
    // es fallback; lo ideal es suscribir al webhook field 'message_template_status_update'
    // en el hub de 360dialog (lo manejamos abajo en notifyTemplateStatusChange).
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    if (minute < 5) ctx.waitUntil(monitorTemplateStatus(env));
    // Análisis de chats nuevos: 1 vez por hora (procesa hasta 15 chats que
    // tengan actividad nueva desde su último análisis o que nunca se analizaron).
    // Ignora phones internos. Idempotente: si no hay nada que analizar, no hace nada.
    if (minute < 5) ctx.waitUntil(processAnalysisPending(env));
    // Fase 2C: síntesis de mejoras al playbook. Antes corría SOLO lunes 13:00 (una ventana de 5
    // min por semana); si ese tick fallaba se perdía la semana entera y sin rastro. Ahora se
    // chequea 1 vez/día (13:00 UTC = 10 AR) y corre si pasaron ~7 días desde la última síntesis
    // -> self-healing (un día perdido lo agarra el siguiente). Igual tiene su gate de feedback y
    // NUNCA toca el playbook solo (deja propuestas 'pending' para que Gaspar apruebe).
    if (hour === 13 && minute < 5) {
      ctx.waitUntil(maybeWeeklySynthesis(env));
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
      "SELECT id, phone, body, scheduled_at, created_at, template, template_params, lang FROM scheduled_messages WHERE status = 'pending' AND scheduled_at <= ? ORDER BY scheduled_at ASC LIMIT 50"
    ).bind(now).all();
    rows = rs.results || [];
  } catch (e) {
    // Table might not exist yet
    console.error('scheduled_messages query error:', e);
    return;
  }
  if (!rows.length) return;
  for (const msg of rows) {
    // CANCELAR si el cliente nos volvió a escribir desde que se programó (retomó la
    // conversación) → no mandamos nada, se sigue hablando normal.
    try {
      const since = msg.created_at || '1970-01-01';
      const reply = await env.DB.prepare(
        "SELECT 1 FROM wa_messages WHERE phone = ? AND direction = 'inbound' AND msg_type != 'reaction' AND ts > ? LIMIT 1"
      ).bind(msg.phone, since).first();
      if (reply) {
        await env.DB.prepare("UPDATE scheduled_messages SET status = 'cancelled', error = 'cliente respondió' WHERE id = ?").bind(msg.id).run();
        await logWaEvent(env, { to: msg.phone, kind: 'scheduled-cancel', ref: `sched:${msg.id}`, ok: true, error: 'cliente retomó la conversación' });
        continue;
      }
    } catch (_) {}
    // ¿Ventana de 24h abierta? (último inbound < 24h). Si está abierta y hay texto
    // libre → lo mandamos (personalizado). Si está cerrada → plantilla aprobada.
    let windowOpen = false;
    try {
      const li = await env.DB.prepare("SELECT MAX(ts) AS t FROM wa_messages WHERE phone = ? AND direction = 'inbound'").bind(msg.phone).first();
      windowOpen = !!(li && li.t && (Date.now() - new Date(li.t).getTime()) < 24 * 60 * 60 * 1000);
    } catch (_) {}
    let r, sentBody = msg.body, sentType = 'text';
    if (windowOpen && msg.body) {
      r = await waSendText(env, msg.phone, msg.body);
    } else if (msg.template) {
      let params = []; try { params = JSON.parse(msg.template_params || '[]'); } catch (_) {}
      r = await waSendTemplate(env, msg.phone, msg.template, msg.lang || 'es_AR', Array.isArray(params) ? params : []);
      sentBody = '[plantilla: ' + msg.template + ']'; sentType = 'template';
    } else if (msg.body) {
      r = await waSendText(env, msg.phone, msg.body); // ventana cerrada y sin plantilla: probablemente falle
    } else {
      r = { ok: false, error: 'sin contenido' };
    }
    const sentAt = new Date().toISOString();
    if (r.ok) {
      await env.DB.prepare(
        "UPDATE scheduled_messages SET status = 'sent', sent_at = ?, wamid = ? WHERE id = ?"
      ).bind(sentAt, r.id || '', msg.id).run();
      // Guardar en wa_messages para que aparezca en el chat.
      try {
        await env.DB.prepare(
          'INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(sentAt, r.id || '', 'outbound', msg.phone, '', sentType, sentBody, '', '', 'sent').run();
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
// Señales de que el cliente YA avanzó al cierre/compra → NO le mandamos follow-up
// automático (no se spamea a quien está comprando). Solo aparecen en el cierre
// (datos de pago / orden de compra), nunca en el presupuesto.
const FUP_CIERRE_MARKERS = ['neoninfinito.ok', 'orden de compra', 'datos de pago', '3840200500000051390011'];

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

async function waSendDocument(env, to, mediaId, filename, caption) {
  const num = normalizeArPhone(to);
  if (!num) return { ok: false, status: 400, error: 'numero invalido' };
  return waSend(env, {
    messaging_product: 'whatsapp',
    to: num,
    type: 'document',
    document: { id: mediaId, filename: filename || undefined, caption: caption || undefined }
  });
}

async function processPresupuestoFollowups(env, opts = {}) {
  if (await isWaBillingBlocked(env)) return; // pausado por bloqueo de pago de WhatsApp
  const now = Date.now();
  // Follow-up a las 23h del envío del presupuesto: lo más tarde posible DENTRO de
  // la ventana de 24h de WhatsApp para que salga como TEXTO LIBRE GRATIS (no
  // plantilla paga). Si el cron lo agarra con la ventana del cliente todavía
  // abierta → gratis; si ya cerró → plantilla paga (ver bloque windowOpen abajo).
  // Ventana de selección 23h–48h; corre solo en horario hábil 8-20.
  const minAgeAgo = new Date(now - 23 * 60 * 60 * 1000).toISOString();   // edad mínima: 23h
  const maxAgeAgo = new Date(now - (opts.maxAgeHours || 48) * 60 * 60 * 1000).toISOString();   // edad máxima: 48h normal, 72h los lunes (backlog del domingo)

  // 1) Presupuestos del cotizador enviados hace entre 24h y 48h.
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
    ).bind(maxAgeAgo, minAgeAgo, pfx1, pfx2).all();
    rows = rs.results || [];
  } catch (e) {
    await logWaEvent(env, { to: '', kind: 'cron-pp-followup', ref: '', ok: false, error: 'query: ' + e.message });
    return;
  }
  // 2) Latest presupuesto por teléfono (ventana 23-48h = candidatos automáticos)
  const byPhone = new Map();
  for (const r of rows) {
    const ex = byPhone.get(r.phone);
    if (!ex || new Date(r.ts) > new Date(ex.ts)) byPhone.set(r.phone, r);
  }

  if (!byPhone.size) return;

  const failures = [];
  let sent = 0;
  let skippedInvalid = 0;

  for (const p of byPhone.values()) {
    // 3) Conversación posterior al presupuesto
    let conv;
    try {
      const rs = await env.DB.prepare(
        'SELECT direction, body, ts FROM wa_messages WHERE phone = ? AND ts > ? ORDER BY ts LIMIT 200'
      ).bind(p.phone, p.ts).all();
      conv = rs.results || [];
    } catch (_) { continue; }

    // ¿Respondió el cliente? ANTES: si respondía CUALQUIER cosa, se salteaba el
    // follow-up. AHORA (pedido de Gaspar, 18/06): el FUP de las 23h TAMBIÉN va a los
    // que respondieron con un NO-COMPROMISO ("dale, lo pienso", "hablo con mi socio",
    // "gracias, me comunico") — esos demostraron interés y valen MÁS que los mudos.
    // Solo NO mandamos el FUP automático en dos casos:
    //   (a) Ya avanzó al CIERRE / compró → no spamear a quien está comprando.
    //   (b) Dejó una PREGUNTA puntual sin responder (última inbound con "?" o pidiendo
    //       factura) → lo contesta una persona (queda en "⏳ Te toca"); mandar
    //       "¿pudiste verlo?" encima de una pregunta sin responder sería tonto.
    // NO duplicar: si ya le escribimos hace poco (≤12h), no mandamos el FUP
    // automático. Cubre el caso de Joaco mandando un seguimiento MANUAL y el cron
    // disparando otro encima minutos después. El presupuesto en sí tiene ≥23h, así
    // que nunca cuenta acá — solo cuentan los mensajes posteriores (manuales).
    if (conv.some(m => m.direction === 'outbound' && (now - new Date(m.ts).getTime()) < 12 * 60 * 60 * 1000)) continue;
    // No molestar a quien YA compró / está cerrando.
    if (conv.some(m => m.direction === 'outbound' && FUP_CIERRE_MARKERS.some(k => (m.body || '').toLowerCase().includes(k)))) continue;
    // Pregunta puntual sin responder → la contesta una persona (queda en "⏳ Te toca");
    // mandar "¿pudiste verlo?" encima de una pregunta sin responder sería tonto.
    const ultimoMsg = conv[conv.length - 1];
    if (ultimoMsg && ultimoMsg.direction === 'inbound' && /\?|factura/i.test(ultimoMsg.body || '')) continue;
    // ¿Ya tiene follow-up (cualquier variante: legacy, copa, low, high)?
    // Si el outbound posterior arranca con ALGUNO de los prefijos conocidos,
    // ya recibió follow-up.
    if (conv.some(m => m.direction === 'outbound' && ALL_FOLLOWUP_PREFIXES_TEXT.some(pref => (m.body || '').startsWith(pref)))) continue;

    // 4) Decidir qué variante mandar según fecha y monto.
    // - Entre 24-jun y 30-jun: PROMO COPA (imagen + caption) a TODOS.
    // - Resto del tiempo: texto según monto (≷ $300k).
    const ahoraIso = new Date().toISOString();
    // Copa DESACTIVADA por pedido de Gaspar — se manda el follow-up NORMAL (high/low por monto).
    // Para reactivar: const inCopaPromo = ahoraIso >= PROMO_COPA_START_UTC && ahoraIso < PROMO_COPA_END_UTC;
    const inCopaPromo = false;
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
          'INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status, automated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)'
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
            'INSERT OR IGNORE INTO wa_messages (ts, wamid, direction, phone, sender_name, msg_type, body, media_url, context_id, status, automated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)'
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
      await clearSendFail(env, 'ppfu:' + p.phone);
    } else {
      // Transitorio y bajo el tope → NO marcamos (reintenta el próximo cron, sin
      // avisar para no spamear). Permanente o tope alcanzado → marcar failed +
      // avisar con el motivo REAL (no el genérico "fuera de ventana").
      const n = await bumpSendFail(env, 'ppfu:' + p.phone);
      if (isTransientSendError(r) && n < SEND_FAIL_CAP) {
        // dejar pendiente para que el próximo cron lo reintente
      } else {
        await insertMarker('failed', 'fu-fail:' + p.phone + ':' + Date.now(), null);
        await clearSendFail(env, 'ppfu:' + p.phone);
        failures.push({ phone: p.phone, name: p.sender_name || '', error: describeSendFailure(r) });
      }
    }
    await logWaEvent(env, { to: p.phone, kind: 'pp-followup-' + variantKind, ref: 'pp-fu:' + p.phone, ok: r.ok, messageId: r.id, error: r.error });
    await new Promise(rs => setTimeout(rs, 600)); // delay anti rate-limit
  }

  // 5) Si fallaron envíos y hay número de admin configurado, mandar resumen
  if (failures.length && env.ADMIN_NOTIFY_PHONE) {
    const lines = failures.slice(0, 10).map(f => `• ${f.name || f.phone} (${f.phone}): ${f.error}`).join('\n');
    const more = failures.length > 10 ? `\n…y ${failures.length - 10} más` : '';
    const summary = `⚠ Follow-ups de presupuesto que no salieron (${failures.length}):\n${lines}${more}\n\n(El motivo real va al lado de cada uno. Los transitorios se reintentan solos; estos ya agotaron los reintentos o son permanentes.)`;
    try { await waSendText(env, env.ADMIN_NOTIFY_PHONE, summary); } catch (_) {}
  }

  if (sent > 0 || failures.length > 0) {
    await logWaEvent(env, { to: '', kind: 'cron-pp-summary', ref: '', ok: true, error: `sent=${sent} failed=${failures.length}` });
  }
}

// ===== Anti-colgados: leads tibios esperando respuesta (pelota de NUESTRO lado) =====
// Marca con la etiqueta "⏳ Te toca" toda conversación donde mandamos presupuesto, el
// cliente RESPONDIÓ, y la última palabra es de él hace ≥90 min. La etiqueta se SACA
// sola cuando contestamos. 2x/día (10 y 17 AR) manda un resumen a los internos
// (Joaco + Gaspar). Objetivo: que ningún lead tibio se cuelgue por olvido. El FUP
// automático solo cubre a los que quedaron MUDOS; esto cubre el hueco de los que
// respondieron y se dejan enfriar. Ver playbook §A4.1.
const COLGADO_LABEL_NAME = '⏳ Te toca';
const COLGADO_LABEL_COLOR = '#f59e0b';
const COLGADO_MIN_MS = 90 * 60 * 1000;                                // 1h30 esperando
const COLGADO_INTERNAL_PHONES = ['5491137593269', '5491155604999'];   // Joaco, Gaspar

async function processColgados(env) {
  const now = Date.now();
  const labelId = await ensureLabelId(env, COLGADO_LABEL_NAME, COLGADO_LABEL_COLOR);
  if (!labelId) return;

  // 1) Presupuestos enviados en los últimos 12 días (prefijo exacto, sin LIKE → sin
  //    el límite de complejidad de D1; mismos prefijos que usa el FUP).
  const since = new Date(now - 12 * 24 * 60 * 60 * 1000).toISOString();
  const pfx1 = PRESUPUESTO_PREFIXES_TEXT[0].substring(0, 26);
  const pfx2 = PRESUPUESTO_PREFIXES_TEXT[1].substring(0, 26);
  let presRows;
  try {
    const rs = await env.DB.prepare(
      "SELECT phone, MAX(ts) AS pres_ts FROM wa_messages " +
      "WHERE direction='outbound' AND ts >= ? AND (substr(body,1,26)=? OR substr(body,1,26)=?) " +
      "GROUP BY phone"
    ).bind(since, pfx1, pfx2).all();
    presRows = rs.results || [];
  } catch (e) {
    await logWaEvent(env, { to: '', kind: 'cron-colgados', ref: '', ok: false, error: 'query: ' + e.message });
    return;
  }

  // 2) Determinar quiénes están colgados (respondieron + última palabra de ellos + ≥90 min).
  const colgados = [];
  for (const p of presRows) {
    if (COLGADO_INTERNAL_PHONES.includes(p.phone)) continue;
    let conv;
    try {
      const rs = await env.DB.prepare(
        "SELECT direction, ts, sender_name FROM wa_messages WHERE phone=? AND ts>? ORDER BY ts LIMIT 200"
      ).bind(p.phone, p.pres_ts).all();
      conv = rs.results || [];
    } catch (_) { continue; }
    if (!conv.length) continue;
    if (!conv.some(m => m.direction === 'inbound')) continue;          // mudo → lo cubre el FUP
    const last = conv[conv.length - 1];
    if (last.direction !== 'inbound') continue;                         // ya contestamos → no es colgado
    const waitedMs = now - new Date(last.ts).getTime();
    if (waitedMs < COLGADO_MIN_MS) continue;                            // todavía no llegó al umbral
    try { if (await env.DB.prepare("SELECT 1 FROM archived_chats WHERE phone=?").bind(p.phone).first()) continue; } catch (_) {}
    let name = '';
    try { const c = await env.DB.prepare("SELECT name FROM wa_contacts WHERE phone=?").bind(p.phone).first(); name = (c && c.name) || ''; } catch (_) {}
    if (!name) { const inb = [...conv].reverse().find(m => m.direction === 'inbound' && m.sender_name); name = (inb && inb.sender_name) || ''; }
    colgados.push({ phone: p.phone, waitingMin: Math.round(waitedMs / 60000), name });
  }
  const colgadoSet = new Set(colgados.map(c => c.phone));

  // 3) Aplicar la etiqueta a los colgados.
  for (const c of colgados) {
    try { await env.DB.prepare("INSERT OR IGNORE INTO contact_labels (phone, label_id, created_at) VALUES (?, ?, ?)").bind(c.phone, labelId, new Date().toISOString()).run(); } catch (_) {}
  }
  // 4) Sacar la etiqueta de los que YA NO están colgados (contestamos / avanzaron / se archivaron).
  try {
    const tagged = (await env.DB.prepare("SELECT phone FROM contact_labels WHERE label_id=?").bind(labelId).all()).results || [];
    for (const t of tagged) {
      if (!colgadoSet.has(t.phone)) {
        try { await env.DB.prepare("DELETE FROM contact_labels WHERE phone=? AND label_id=?").bind(t.phone, labelId).run(); } catch (_) {}
      }
    }
  } catch (_) {}

  // 5) Resumen a los internos 2x/día (10:00 y 17:00 AR), dedup por kv_cache.
  const hAR = (new Date().getUTCHours() - 3 + 24) % 24;
  const minute = new Date().getUTCMinutes();
  if ((hAR === 10 || hAR === 17) && minute < 5 && colgados.length > 0) {
    const dateKeyAR = new Date(now - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const slotKey = `colgados-summary:${dateKeyAR}:${hAR}`;
    let already = false;
    try { already = !!(await env.DB.prepare("SELECT v FROM kv_cache WHERE k=?").bind(slotKey).first()); } catch (_) {}
    if (!already && !(await isWaBillingBlocked(env))) {
      const top = colgados.sort((a, b) => b.waitingMin - a.waitingMin).slice(0, 12);
      const lines = top.map(c => {
        const hrs = c.waitingMin >= 60 ? `${Math.floor(c.waitingMin / 60)}h${String(c.waitingMin % 60).padStart(2, '0')}` : `${c.waitingMin}min`;
        return `• ${c.name || ('+' + c.phone)} — hace ${hrs}`;
      }).join('\n');
      const more = colgados.length > 12 ? `\n…y ${colgados.length - 12} más` : '';
      const msg = `⏳ *Leads esperándote* (${colgados.length})\nRespondieron el presupuesto y tienen la pelota de nuestro lado 👇\n\n${lines}${more}\n\nEntrá al CRM → Chat → filtro "${COLGADO_LABEL_NAME}" y respondeles. No los dejes enfriar! 🔥`;
      for (const ph of COLGADO_INTERNAL_PHONES) {
        try { await waSendText(env, ph, msg); } catch (_) {}
        await new Promise(r => setTimeout(r, 400));
      }
      try { await env.DB.prepare("INSERT INTO kv_cache (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at").bind(slotKey, String(colgados.length), new Date().toISOString()).run(); } catch (_) {}
    }
  }

  if (colgados.length > 0) {
    await logWaEvent(env, { to: '', kind: 'cron-colgados', ref: '', ok: true, error: `colgados=${colgados.length}` });
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
