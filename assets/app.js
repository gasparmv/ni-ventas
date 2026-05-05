/* NI Ventas · App logic
 * Live data: Sheet "Ventas" hoja 2026 + Cotizador hojas Abril/Mayo+
 * Cross-match presupuesto → cerrado por nombre + ±20% precio
 * Routing: hash-based (#dashboard, #pedidos, etc.)
 */

const CONFIG = {
  trackerUrl: 'https://ni-ventas-tracker.neoninfinito.workers.dev',  // URL pública del Worker. Vacío = sin tracking remoto, solo localStorage.
  defaultUsers: ['Gaspar', 'Joaquín'],
  ventasSheetId: '1qKUhSDDjBV4k8W0goPhOFzEhLz0Zeruq2slLpb9bWSg',
  cotizadorSheetId: '13I4OAwpFm4Z0DM81SzbwMpr1DvIjC2NF1BiB0njA1hQ',
  ventasSheetName: '2026',
  cotizadorSheets: ['2026'],
  matchPriceTolerance: 0.20,   // ±20%
  presupuestoFollowupDays: 7,  // miércoles a miércoles
  presupuestoCutoff: '2026-04-27',   // presupuestos anteriores quedan dados por vencidos / fuera del seguimiento activo
  appsScriptUrl: 'https://script.google.com/macros/s/AKfycbz9Jq2ew0dMcg5IEXn9OMsqhdVmlwqL_EVULlclWK-oIxh5avOlnZxRrGtis1sGalnd/exec',
  cotizadorDefaults: {
    // Mapping B2..B8 del sheet del cotizador
    neon: 1800,
    trans: 175000,
    negro: 154000,
    fuentes_1a: 3000,    // F entre 0 y 2 mt
    fuentes_3a: 4080,    // F entre 2 y 6 mt
    fuentes_5a: 7735,    // F entre 6 y 9 mt
    fuentes_10a: 10500,  // F entre 9 y 30 mt
    // Tier por m2 (B)
    tier_25: 7500,       // m2 ≤ 25
    tier_50: 15000,      // 25 < m2 ≤ 50
    tier_99: 25000,      // m2 > 50
    // Extra por exterior (G=EXT)
    ext_25: 20000,
    ext_50: 25000,
    ext_99: 35000,
    // Multiplicadores
    reventa_mult: 0.8,        // reventa = trans × 0.8
    comision_pct: 0.05,       // 5% Joaco sobre trans
    descuento_mult: 0.88,     // si m2 > descuento_min_m2
    descuento_min_m2: 100,
    recargo_5: 2,             // m2 ≤ 5  → trans × 2
    recargo_125: 1.5,         // m2 ≤ 12.5 → trans × 1.5
    recargo_25: 1.15,         // m2 < 25 → trans × 1.15
    // Controladores opcionales
    ctrl_slim: 18700,
    ctrl_remoto: 25000,
    ctrl_app: 38000
  },
  postventaMilestones: [
    { id: 'D30', days: 30, label: 'Foto / feedback', tagClass: 'tag-d30',
      template: (n) => `Holaa ${n}, cómo va? cómo te quedó el cartel?\n\nsi tenés una foto cuando puedas pasame, nos re sirve mostrar como queda en el local 🤙` },
    { id: 'D60', days: 60, label: 'Referidos',       tagClass: 'tag-d60',
      template: (n) => `Buenas ${n}, cómo va todo?\n\nte cuento por si pinta: si recomendás a alguien y le cerramos cartel, te tiramos 10% de la venta. cualquier cosa avisame y le mando info al toque` },
    { id: 'D90', days: 90, label: 'Segundo cartel',  tagClass: 'tag-d90',
      template: (n) => `Holaa ${n}, cómo va? ya pasaron 3 meses del cartel 🤯\n\ncapaz se te ocurrió otro espacio del local o algo más — si querés te armo un render gratis con una idea, sin compromiso` }
  ],
  presupuestoTemplate: (n) => `Holaa ${n}! cómo va? te paso para saber si seguís pensando en lo del cartel — cualquier cosa que necesites para decidir avisame y te ayudo`
};

// ============ DATA ============
const STATE = {
  pedidos: [],          // sheet Ventas/2026 rows
  presupuestos: [],     // cotizador rows (Abril+)
  matched: new Map(),   // presupuesto idx → pedido (or null)
  loaded: false,
  error: null,
  view: 'dashboard',
  selected: null,
  dashMonths: null,   // null = mes actual; Set('YYYY-MM') = filtro activo; 'all' = todos
  dashChartIdx: 0,    // 0 = ventas acumuladas, 1 = semanal stacked por canal
  done: new Map(),    // id -> ISO timestamp en que se marcó (persistido en localStorage)
  segPvFilter: 'all', // all | D30 | D60 | D90
  user: null,         // usuario activo (string)
  users: [],          // lista de usuarios (default + agregados)
  token: null,        // token de admin (Gaspar) si está logueado
  activity: { rows: [], loading: false, error: null },
  cotizadorParams: null,  // se carga del Worker; si null usa CONFIG.cotizadorDefaults
  cotizadorForm: { ancho: '', alto: '', neon: '', tipo: 'INT', cliente: '', canal: 'WPP', telefono: '' },
  cotizadorSaving: false
};

// ============ COTIZADOR ============
function getCotizadorParams() {
  return Object.assign({}, CONFIG.cotizadorDefaults, STATE.cotizadorParams || {});
}

async function loadCotizadorParams() {
  if (!CONFIG.trackerUrl) return;
  try {
    const r = await fetch(CONFIG.trackerUrl.replace(/\/$/, '') + '/cotizador/params');
    if (!r.ok) return;
    const j = await r.json();
    if (j.params && Object.keys(j.params).length) STATE.cotizadorParams = j.params;
  } catch (e) { /* offline ok */ }
}

async function saveCotizadorParams(updates) {
  if (!isAdmin()) throw new Error('no autorizado');
  const r = await fetch(CONFIG.trackerUrl.replace(/\/$/, '') + '/admin/cotizador/params', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ params: updates })
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  // Actualizar estado local con los nuevos valores
  STATE.cotizadorParams = Object.assign({}, STATE.cotizadorParams || {}, updates);
}

function copiarPresupuesto() {
  const f = STATE.cotizadorForm;
  if (!(+f.ancho > 0) || !(+f.alto > 0)) { alert('Completá al menos ancho y alto'); return; }
  const r = calcCotizador(f);
  const p = getCotizadorParams();
  const nombre = f.cliente.trim() || 'Custom name';
  const texto = `Te comparto la información detallada!\n\nTrabajo: ${nombre}\nMedidas: ${Math.round(+f.ancho)}x${Math.round(+f.alto)}\nBase transparente: ${fmtMoney(r.transFinal)}\nBase negra: ${fmtMoney(r.negroFinal)}\n\nControladores opcionales\n\nSlim: ${fmtMoney(p.ctrl_slim)}\n\nControl remoto: ${fmtMoney(p.ctrl_remoto)}\n\nApp: ${fmtMoney(p.ctrl_app)}\n\nPara iniciar el trabajo, se requiere el 50% del total del cartel en concepto de seña.\n\nTiempo de armado: 15/20 días.\n\nTodos los medios de pago!\n\nHacemos envíos GRATIS a todo el país!`;
  navigator.clipboard.writeText(texto).then(() => {
    toast('Presupuesto copiado al portapapeles ✓');
  }).catch(() => {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = texto;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('Presupuesto copiado al portapapeles ✓');
  });
}

async function saveCotizacion() {
  if (!CONFIG.appsScriptUrl) { alert('Falta configurar CONFIG.appsScriptUrl (Google Apps Script)'); return; }
  const f = STATE.cotizadorForm;
  if (!(+f.ancho > 0) || !(+f.alto > 0)) { alert('Completá al menos ancho y alto'); return; }
  if (!f.cliente.trim()) { alert('Completá el nombre del cliente/diseño'); return; }
  if (f.canal === 'WPP' && !f.telefono.trim()) { alert('Completá el teléfono del cliente (obligatorio para WPP)'); return; }
  const r = calcCotizador(f);
  STATE.cotizadorSaving = true;
  updateCotizadorForm();
  const payload = {
    cliente: f.cliente.trim(),
    ancho: +f.ancho,
    alto: +f.alto,
    neon: +f.neon || 0,
    tipo: f.tipo || 'INT',
    m2: r.m2,
    trans: r.trans,
    negro: r.negro,
    descuento: r.descuento,
    recargo: r.recargo,
    reventa: r.reventa,
    comision: r.comision,
    canal: f.canal || 'WPP',
    telefono: (f.telefono || '').trim()
  };
  try {
    // Apps Script redirect CORS: usamos un iframe oculto + form POST
    await new Promise((resolve, reject) => {
      const id = 'cot-iframe-' + Date.now();
      const iframe = document.createElement('iframe');
      iframe.name = id;
      iframe.style.display = 'none';
      document.body.appendChild(iframe);

      const form = document.createElement('form');
      form.method = 'POST';
      form.action = CONFIG.appsScriptUrl;
      form.target = id;
      // Mandar payload como campo hidden "data"
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'data';
      input.value = JSON.stringify(payload);
      form.appendChild(input);
      document.body.appendChild(form);

      iframe.onload = () => {
        // cleanup
        setTimeout(() => { iframe.remove(); form.remove(); }, 500);
        resolve();
      };
      iframe.onerror = () => {
        iframe.remove(); form.remove();
        reject(new Error('Error de red'));
      };
      // timeout por si no carga
      setTimeout(() => { resolve(); iframe.remove(); form.remove(); }, 8000);

      form.submit();
    });
    STATE.cotizadorForm = { ancho: '', alto: '', neon: '', tipo: 'INT', cliente: '', canal: 'WPP', telefono: '' };
    toast('Cotización guardada ✓');
    // Esperar un poco para que el sheet se actualice antes de recargar
    setTimeout(() => loadAll(), 2000);
  } catch (e) {
    alert('Error al guardar: ' + e.message);
  } finally {
    STATE.cotizadorSaving = false;
    updateCotizadorForm();
  }
}

function redondMult(v, mult) { return Math.round(v / mult) * mult; }

function fuentesByNeon(f, p) {
  if (f > 0 && f <= 2)  return p.fuentes_1a;
  if (f > 2 && f <= 6)  return p.fuentes_3a;
  if (f > 6 && f <= 9)  return p.fuentes_5a;
  if (f > 9 && f <= 30) return p.fuentes_10a;
  return 0;
}
function tierByM2(b, p) {
  if (b <= 25) return p.tier_25;
  if (b <= 50) return p.tier_50;
  return p.tier_99;
}
function extByM2(b, p) {
  if (b <= 25) return p.ext_25;
  if (b <= 50) return p.ext_50;
  return p.ext_99;
}

function calcCotizador(input) {
  const p = getCotizadorParams();
  const ancho = +input.ancho || 0;     // D (cm)
  const alto  = +input.alto  || 0;     // E (cm)
  const neon  = +input.neon  || 0;     // F (mt)
  const tipo  = (input.tipo || 'INT').toUpperCase();  // G
  const m2 = (ancho * alto) / 100;     // B (no es m² real, usa /100)

  function precio(acrylicCost) {
    const base = (acrylicCost * (ancho * 0.01) * (alto * 0.01) + p.neon * neon + fuentesByNeon(neon, p)) * 3;
    const tier = tierByM2(m2, p);
    const ext = tipo === 'EXT' ? extByM2(m2, p) : 0;
    return redondMult(base + tier + ext, 500);
  }
  const trans = precio(p.trans);
  const negro = precio(p.negro);

  const descuento = m2 > p.descuento_min_m2 ? redondMult(trans * p.descuento_mult, 500) : 0;
  const descuentoNegro = m2 > p.descuento_min_m2 ? redondMult(negro * p.descuento_mult, 500) : 0;
  let recargo = 0, recargoNegro = 0;
  if (m2 <= 5)         { recargo = redondMult(trans * p.recargo_5, 500); recargoNegro = redondMult(negro * p.recargo_5, 500); }
  else if (m2 <= 12.5) { recargo = redondMult(trans * p.recargo_125, 500); recargoNegro = redondMult(negro * p.recargo_125, 500); }
  else if (m2 < 25)    { recargo = redondMult(trans * p.recargo_25, 500); recargoNegro = redondMult(negro * p.recargo_25, 500); }
  const reventa  = redondMult(trans * p.reventa_mult, 500);
  const comision = Math.round(trans * p.comision_pct);

  // Precio final: si hay descuento se usa descuento, si hay recargo se usa recargo, sino base
  const transFinal = descuento ? descuento : recargo ? recargo : trans;
  const negroFinal = descuentoNegro ? descuentoNegro : recargoNegro ? recargoNegro : negro;

  return { m2, trans, negro, descuento, descuentoNegro, recargo, recargoNegro, reventa, comision, transFinal, negroFinal };
}

// ============ USUARIO ============
function loadUser() {
  try {
    STATE.users = JSON.parse(localStorage.getItem('niventas.users') || 'null') || CONFIG.defaultUsers.slice();
  } catch(e) { STATE.users = CONFIG.defaultUsers.slice(); }
  STATE.user = localStorage.getItem('niventas.user') || null;
  STATE.token = localStorage.getItem('niventas.token') || null;
}
function saveUser() {
  localStorage.setItem('niventas.users', JSON.stringify(STATE.users));
  if (STATE.user) localStorage.setItem('niventas.user', STATE.user);
  else localStorage.removeItem('niventas.user');
}
function saveToken(t) {
  STATE.token = t;
  if (t) localStorage.setItem('niventas.token', t);
  else localStorage.removeItem('niventas.token');
}
async function setUser(name) {
  // Si elige Gaspar y no hay token válido, pedir password
  if (name === 'Gaspar' && !STATE.token) {
    const ok = await loginPrompt();
    if (!ok) return;
  }
  STATE.user = name;
  saveUser();
  render();
  // Pre-load chat contacts in background for unread badge
  if (isAdmin() && !chatState.contacts.length) {
    loadChatContacts().then(() => updateUnreadBadge());
  }
}
async function loginPrompt() {
  if (!CONFIG.trackerUrl) {
    alert('El backend de auth no está configurado. Ver CONFIG.trackerUrl.');
    return false;
  }
  const pw = prompt('Contraseña de admin:');
  if (!pw) return false;
  try {
    const r = await fetch(CONFIG.trackerUrl.replace(/\/$/, '') + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'Gaspar', password: pw })
    });
    if (r.status === 401) { alert('Contraseña incorrecta'); return false; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    saveToken(j.token);
    return true;
  } catch (e) {
    alert('Error de login: ' + e.message);
    return false;
  }
}
async function logout() {
  if (CONFIG.trackerUrl && STATE.token) {
    try {
      await fetch(CONFIG.trackerUrl.replace(/\/$/, '') + '/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + STATE.token }
      });
    } catch(e) {}
  }
  saveToken(null);
  // Si estaba como Gaspar, lo dejo sin usuario para que tenga que re-loguearse
  if (STATE.user === 'Gaspar') { STATE.user = null; saveUser(); }
  // Si estaba en vista admin, salir
  if (STATE.view === 'admin') setView('dashboard');
  else render();
}
function isAdmin() { return !!STATE.token && STATE.user === 'Gaspar'; }
function authHeaders() {
  return STATE.token ? { 'Authorization': 'Bearer ' + STATE.token } : {};
}
function addUser() {
  const name = (prompt('Nombre del nuevo usuario:') || '').trim();
  if (!name) return;
  if (!STATE.users.includes(name)) STATE.users.push(name);
  STATE.user = name;
  saveUser();
  render();
}

async function trackEvent(action, itemId, itemKind, undo = false) {
  if (!CONFIG.trackerUrl || !STATE.user) return;
  try {
    await fetch(CONFIG.trackerUrl.replace(/\/$/, '') + '/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: STATE.user, action, itemId, itemKind, undo })
    });
  } catch (e) { console.warn('tracker offline:', e.message); }
}

// ============ TOUCHPOINTS / DONE ============
function loadDoneLocal() {
  // Carga desde localStorage (fallback / cache offline)
  try {
    const raw = JSON.parse(localStorage.getItem('niventas.done') || '{}');
    if (Array.isArray(raw)) {
      return new Map(raw.map(id => [id, null]));
    } else if (raw && typeof raw === 'object') {
      return new Map(Object.entries(raw));
    }
  } catch(e) {}
  return new Map();
}
function saveDoneLocal() {
  const obj = {};
  for (const [k, v] of STATE.done) obj[k] = v;
  localStorage.setItem('niventas.done', JSON.stringify(obj));
}
async function loadDone() {
  // Primero cargar localStorage como fallback inmediato
  STATE.done = loadDoneLocal();
  // Luego intentar cargar desde el Worker (fuente de verdad)
  if (!CONFIG.trackerUrl || !STATE.user) return;
  try {
    const r = await fetch(CONFIG.trackerUrl.replace(/\/$/, '') + '/done?user=' + encodeURIComponent(STATE.user));
    if (!r.ok) return;
    const j = await r.json();
    if (j.marks && typeof j.marks === 'object') {
      const remote = new Map(Object.entries(j.marks));
      // Si el Worker tiene datos, usar esos
      if (remote.size > 0) {
        STATE.done = remote;
        saveDoneLocal(); // sync al localStorage
      } else if (STATE.done.size > 0) {
        // Migración one-time: localStorage tiene datos pero Worker está vacío
        await syncDoneToWorker();
      }
    }
  } catch(e) { console.warn('done sync offline:', e.message); }
}
async function syncDoneToWorker() {
  // Sube todos los done marks de localStorage al Worker
  if (!CONFIG.trackerUrl || !STATE.user) return;
  for (const [itemId, ts] of STATE.done) {
    try {
      await fetch(CONFIG.trackerUrl.replace(/\/$/, '') + '/done', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: STATE.user, itemId })
      });
    } catch(e) { break; } // si falla, parar
  }
}
function isDone(id) { return STATE.done.has(id); }
function getDoneAt(id) {
  const v = STATE.done.get(id);
  return v ? new Date(v) : null;
}
function fmtDoneAt(d) {
  if (!d) return '';
  const days = daysBetween(d, TODAY);
  const hhmm = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  if (days === 0) return `hoy ${hhmm}`;
  if (days === 1) return `ayer ${hhmm}`;
  if (days <= 6) return `hace ${days}d`;
  return d.toLocaleDateString('es-AR', {day:'2-digit', month:'2-digit'});
}
function toggleDone(id) {
  const wasDone = STATE.done.has(id);
  const ts = new Date().toISOString();
  if (wasDone) STATE.done.delete(id);
  else STATE.done.set(id, ts);
  saveDoneLocal(); // cache local
  // Persistir en Worker (no bloquea UI)
  if (CONFIG.trackerUrl && STATE.user) {
    const opts = {
      method: wasDone ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: STATE.user, itemId: id })
    };
    fetch(CONFIG.trackerUrl.replace(/\/$/, '') + '/done', opts).catch(() => {});
  }
  // Tracking remoto
  const kind = id.startsWith('ppto:') ? 'presupuesto' : id.startsWith('pv:') ? 'postventa' : '';
  trackEvent('toggle_done', id, kind, wasDone);
  render();
}
function nextWedAfter(d, minDays) {
  let dt = addDays(d, minDays);
  while (dt.getDay() !== 3) dt = addDays(dt, 1);
  return dt;
}
function nextFollowup(from) {
  // Lun/Mar → miércoles de esa semana
  // Mié → viernes de esa semana
  // Jue/Vie/Sáb/Dom → lunes siguiente
  const d = new Date(from); d.setHours(0,0,0,0);
  const dow = d.getDay(); // 0=dom, 1=lun, 2=mar, 3=mie, 4=jue, 5=vie, 6=sab
  if (dow === 1) return addDays(d, 2);      // lun → mié (+2)
  if (dow === 2) return addDays(d, 1);      // mar → mié (+1)
  if (dow === 3) return addDays(d, 2);      // mié → vie (+2)
  if (dow === 4) return addDays(d, 4);      // jue → lun (+4)
  if (dow === 5) return addDays(d, 3);      // vie → lun (+3)
  if (dow === 6) return addDays(d, 2);      // sáb → lun (+2)
  return addDays(d, 1);                     // dom → lun (+1)
}
function presupuestoTouchpoints(sent) {
  const s = new Date(sent); s.setHours(0,0,0,0);
  const f1 = nextFollowup(s);
  const f2 = nextFollowup(f1);
  const f3 = nextFollowup(f2);
  return [
    { id: 'F1', label: 'F1', due: f1 },
    { id: 'F2', label: 'F2', due: f2 },
    { id: 'F3', label: 'F3', due: f3 }
  ];
}
function touchpointState(due) {
  const days = daysBetween(due, TODAY); // <0=futuro, 0=hoy, >0=pasado
  if (days < -1) return 'future';
  if (days <= 1) return 'due';
  return 'overdue';
}

const DASH_CHARTS = [
  { id: 'cumulative', title: (lbl) => `Ventas acumuladas · ${lbl}` },
  { id: 'weekly',     title: (lbl) => `Semanas · stacked por canal · ${lbl}` }
];

const TODAY = new Date(); TODAY.setHours(0,0,0,0);

function csvUrl(id, sheet) {
  return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheet)}`;
}

// Minimal CSV parser (handles quoted fields, escaped quotes, newlines in fields)
function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') { q = false; }
      else { cur += c; }
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c === '\r') {/* skip */}
      else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function parseDate(v) {
  // Argentina format priority: dd/mm/yyyy. NEVER fall through to new Date(v) for slash/dash formats
  // because JS interprets "02/04/2026" as Feb 4 (US mm/dd), not Apr 2 (AR dd/mm).
  if (!v) return null;
  v = String(v).trim();
  if (!v) return null;
  // ISO yyyy-mm-dd (with optional time): unambiguous
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
    return isNaN(d) ? null : d;
  }
  // AR: dd/mm/yyyy or dd/mm/yy
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
    const d = new Date(yr, parseInt(m[2]) - 1, parseInt(m[1]));
    return isNaN(d) ? null : d;
  }
  // AR: d/m (sin año — asume año actual)
  m = v.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    const d = new Date(new Date().getFullYear(), parseInt(m[2]) - 1, parseInt(m[1]));
    return isNaN(d) ? null : d;
  }
  // AR: dd-mm-yyyy or dd-mm-yy
  m = v.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
  if (m) {
    const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
    const d = new Date(yr, parseInt(m[2]) - 1, parseInt(m[1]));
    return isNaN(d) ? null : d;
  }
  // Last resort: only for non-ambiguous strings (like "Date(...)" wrappers from gviz, or already parsed Date objects)
  if (v instanceof Date) return v;
  // Google's gviz CSV sometimes wraps as Date(2026,3,2) etc.
  m = v.match(/^Date\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) {
    const d = new Date(parseInt(m[1]), parseInt(m[2]), parseInt(m[3]));
    return isNaN(d) ? null : d;
  }
  return null;
}

function parseNum(v) {
  // NI prices are always integer ARS — no real decimals.
  // Google CSV may send: "149500", "149500.0", "149,500", "149,500.00", "$149.500", etc.
  // Strategy: if there's a separator (. or ,) followed by 1-2 digits at end → strip decimals.
  // Then strip all non-digits.
  if (v == null || v === '') return 0;
  let s = String(v).trim();
  if (!s) return 0;
  // Remove trailing decimals (US format ".0" or AR format ",00")
  s = s.replace(/[.,]\d{1,2}$/, '');
  // Strip everything except digits and minus
  const sign = s.startsWith('-') ? -1 : 1;
  s = s.replace(/[^\d]/g, '');
  if (!s) return 0;
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : sign * n;
}

function fmtMoney(n) { return '$' + Math.round(n||0).toLocaleString('es-AR'); }
function fmtDate(d) { if (!d) return '—'; return d.toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'2-digit' }); }
function fmtDateLong(d) { if (!d) return '—'; return d.toLocaleDateString('es-AR', { day:'2-digit', month:'long', year:'numeric' }); }
function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function normName(s) { return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'').trim(); }

// ============ LOAD ============
async function fetchSheet(id, sheet) {
  const url = csvUrl(id, sheet);
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${sheet}: ${r.status}`);
    const text = await r.text();
    return parseCSV(text);
  } catch (e) {
    console.warn(`Sheet "${sheet}" no disponible:`, e.message);
    return null;
  }
}

async function loadAll() {
  STATE.loaded = false;
  STATE.error = null;
  render();
  try {
    const ventasRows = await fetchSheet(CONFIG.ventasSheetId, CONFIG.ventasSheetName);
    if (!ventasRows) throw new Error('No se pudo cargar el Sheet "Ventas/2026". Verificá que esté público.');
    STATE.pedidos = parseVentas(ventasRows);

    const presupuestosAll = [];
    for (const sheet of CONFIG.cotizadorSheets) {
      const rows = await fetchSheet(CONFIG.cotizadorSheetId, sheet);
      if (rows) presupuestosAll.push(...parseCotizador(rows, sheet));
    }
    STATE.presupuestos = presupuestosAll;

    matchPresupuestos();
    STATE.loaded = true;
  } catch (e) {
    STATE.error = e.message;
  }
  render();
}

function parseVentas(rows) {
  // Header row of Ventas hoja 2026 (row 0): [Fecha, NUMERO, CARTEL, COLORES, ALTO, ANCHO, CM neon, BASE, Cantidad, PRECIO, DIMER, PRECIO DIMMER, ENVIO, ACLARACION, Productor, PLATAFORMA, ESTADO DEL PAGO, PAGADO, RESTANTE, ESTADO DEL PEDIDO, AD]
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[2]) continue; // need cartel name
    const fecha = parseDate(r[0]);
    if (!fecha) continue; // skip rows without date
    out.push({
      idx: i,
      fecha,
      numero: r[1] || '',
      cartel: r[2] || '',
      colores: r[3] || '',
      alto: parseNum(r[4]),
      ancho: parseNum(r[5]),
      cmNeon: parseNum(r[6]),
      base: r[7] || '',
      cantidad: parseNum(r[8]) || 1,
      precio: parseNum(r[9]),
      dimmer: r[10] || 'NO',
      precioDimmer: parseNum(r[11]),
      envio: r[12] || '',
      aclaracion: r[13] || '',
      productor: r[14] || '',
      plataforma: r[15] || '',
      estadoPago: r[16] || '',
      pagado: parseNum(r[17]),
      restante: parseNum(r[18]),
      estadoPedido: r[19] || '',
      canalAd: r[20] || ''
    });
  }
  return out;
}

function parseCotizador(rows, sheetName) {
  // Cotizador Abril/Mayo headers (row 0): [Fecha, m2, diseño, Tamaño (cm), '', Neon (mt), '', Transparente, Negro, Descuento, Recargo, Reventa, ...]
  // Pre-Abril didn't have Fecha, so we filter by parseable fecha.
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[2]) continue;
    const fecha = parseDate(r[0]);
    if (!fecha) continue; // only count rows with date (post 11/4/2026)
    const nombre = String(r[2] || '').trim();
    if (!nombre) continue;
    const precioTrans = parseNum(r[7]);
    const precioNegro = parseNum(r[8]);
    const reventa = parseNum(r[11]);
    // Use the highest as headline price (negro is usually lower, trans higher)
    const precio = Math.max(precioTrans, precioNegro, reventa);
    out.push({
      idx: i,
      sheet: sheetName,
      fecha,
      m2: parseNum(r[1]),
      nombre,
      tamCm: parseNum(r[3]),
      ancho: parseNum(r[4]),
      neonMt: parseNum(r[5]),
      tipo: r[6] || '',
      precioTrans,
      precioNegro,
      precioReventa: reventa,
      precio,
      telefono: (r[15] || '').trim()
    });
  }
  return out;
}

function matchPresupuestos() {
  STATE.matched = new Map();
  // Build pedidos index by normalized name
  const byName = new Map();
  for (const p of STATE.pedidos) {
    const k = normName(p.cartel);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(p);
  }
  for (const ppto of STATE.presupuestos) {
    const k = normName(ppto.nombre);
    let match = null;
    if (k && byName.has(k)) {
      const candidates = byName.get(k);
      // Solo cerramos si hay match de nombre + precio dentro de tolerancia + fecha posterior.
      // Sin match de precio, el presupuesto queda abierto (evita falsos cerrados por homónimos
      // o múltiples pedidos del mismo cliente).
      for (const ped of candidates) {
        if (ped.fecha < ppto.fecha) continue;
        const ratio = ped.precio / (ppto.precio || 1);
        if (ratio >= 1 - CONFIG.matchPriceTolerance && ratio <= 1 + CONFIG.matchPriceTolerance) {
          match = ped;
          break;
        }
      }
    }
    STATE.matched.set(ppto.idx + '|' + ppto.sheet, match);
  }
}

// ============ DERIVED ============
function getMonth(d) { return d ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}` : ''; }
function getCurrentMonth() { return getMonth(TODAY); }

function pedidosDelMes(month = null) {
  const m = month || getCurrentMonth();
  return STATE.pedidos.filter(p => getMonth(p.fecha) === m);
}

function getDashMonths() {
  // Returns array of 'YYYY-MM' currently selected for the dashboard, or null = all
  if (STATE.dashMonths === 'all') return null;
  if (STATE.dashMonths instanceof Set && STATE.dashMonths.size > 0) return Array.from(STATE.dashMonths);
  return [getCurrentMonth()];
}
function pedidosDash() {
  const months = getDashMonths();
  if (!months) return STATE.pedidos.slice();
  const set = new Set(months);
  return STATE.pedidos.filter(p => set.has(getMonth(p.fecha)));
}
function dashMonthsLabel() {
  const months = getDashMonths();
  if (!months) return 'Todos los meses';
  if (months.length === 1) {
    const [y,m] = months[0].split('-');
    return new Date(parseInt(y), parseInt(m)-1, 1).toLocaleDateString('es-AR', {month:'long', year:'numeric'});
  }
  return `${months.length} meses`;
}
function availableMonths() {
  const set = new Set(STATE.pedidos.map(p => getMonth(p.fecha)).filter(Boolean));
  return Array.from(set).sort().reverse();
}
function toggleDashMonth(m) {
  // Mantener rango contiguo: al clickear un chip extendemos el rango,
  // o lo achicamos si el chip está en el extremo. Click en el medio = no-op.
  let current;
  if (STATE.dashMonths === 'all' || STATE.dashMonths === null) {
    current = new Set(getDashMonths() || []);
  } else {
    current = new Set(STATE.dashMonths);
  }
  const sorted = Array.from(current).sort();
  if (current.size === 0) {
    STATE.dashMonths = new Set([m]);
  } else if (current.has(m)) {
    // deselect solo si es extremo
    if (m === sorted[0] || m === sorted[sorted.length-1]) {
      current.delete(m);
      if (current.size === 0) { STATE.dashMonths = null; render(); return; }
      STATE.dashMonths = current;
    } else {
      // medio: nada
      return;
    }
  } else {
    // extender rango: incluir m y rellenar todo entre min y max
    const all = [m, ...sorted].sort();
    const minM = all[0], maxM = all[all.length-1];
    const next = new Set();
    // Iterar mes a mes desde minM hasta maxM
    let [yi, mi] = minM.split('-').map(Number);
    const [ye, me] = maxM.split('-').map(Number);
    while (yi < ye || (yi === ye && mi <= me)) {
      next.add(`${yi}-${String(mi).padStart(2,'0')}`);
      mi++; if (mi > 12) { mi = 1; yi++; }
    }
    STATE.dashMonths = next;
  }
  render();
}
function setDashAll() { STATE.dashMonths = 'all'; render(); }
function setDashCurrent() { STATE.dashMonths = null; render(); }

function presupuestoStatus(ppto) {
  const match = STATE.matched.get(ppto.idx + '|' + ppto.sheet);
  if (match) return { state: 'cerrado', pedido: match };
  const days = daysBetween(ppto.fecha, TODAY);
  if (days < 0) return { state: 'futuro', days };
  if (days <= CONFIG.presupuestoFollowupDays) return { state: 'fresco', days };
  return { state: 'abierto', days };
}

function postventaMilestones(pedido) {
  // milestones from "fecha de entrega". If no fecha entrega real, use fecha pedido + 17 (heuristica)
  const entregado = (pedido.estadoPedido || '').toLowerCase().includes('entreg');
  const baseDate = entregado ? pedido.fecha : addDays(pedido.fecha, 17);
  return CONFIG.postventaMilestones.map(m => {
    const due = addDays(baseDate, m.days);
    const days = daysBetween(due, TODAY);
    let state;
    if (!entregado) state = 'pending-delivery';
    else if (days < -3) state = 'future';
    else if (days >= -3 && days <= 3) state = 'now';
    else state = 'overdue';
    return { ...m, due, days, state, baseDate, entregado };
  });
}

function presupuestosActivos() {
  // Devuelve presupuestos no cerrados, con sus 3 touchpoints + el "actual" (primer no-hecho)
  const cutoff = parseDate(CONFIG.presupuestoCutoff);
  const out = [];
  for (const ppto of STATE.presupuestos) {
    if (cutoff && ppto.fecha < cutoff) continue; // anteriores al cutoff: dados por vencidos
    const st = presupuestoStatus(ppto);
    if (st.state === 'cerrado' || st.state === 'futuro') continue;
    const tps = presupuestoTouchpoints(ppto.fecha).map(tp => {
      const doneId = `ppto:${ppto.idx}|${ppto.sheet}|${tp.id}`;
      return {
        ...tp,
        doneId,
        done: isDone(doneId),
        doneAt: getDoneAt(doneId),
        state: touchpointState(tp.due)
      };
    });
    if (tps.every(t => t.done)) continue;
    const currentIdx = tps.findIndex(t => !t.done);
    out.push({ ppto, tps, currentIdx, current: tps[currentIdx], diasAbierto: st.days });
  }
  return out.sort((a, b) => a.current.due - b.current.due);
}

function postventasActivos() {
  const out = [];
  for (const ped of STATE.pedidos) {
    const ms = postventaMilestones(ped);
    for (const m of ms) {
      if (m.state === 'pending-delivery') continue;
      const doneId = `pv:${ped.idx}|${m.id}`;
      const done = isDone(doneId);
      const doneAt = getDoneAt(doneId);
      const tel = extractPhone(ped.envio);
      out.push({ pedido: ped, milestone: m, doneId, done, doneAt, tel });
    }
  }
  return out;
}

function getSeguimientosWeek() {
  // Items "calientes" para badge sidebar y alertas dashboard
  const list = [];
  for (const it of presupuestosActivos()) {
    if (it.current.state === 'future') continue;
    list.push({
      kind: 'presupuesto', cliente: it.ppto.nombre, fecha: it.current.due,
      diasAbierto: it.diasAbierto, precio: it.ppto.precio, ppto: it.ppto, item: it
    });
  }
  for (const it of postventasActivos()) {
    if (it.done) continue;
    if (it.milestone.state !== 'now' && it.milestone.state !== 'overdue') continue;
    list.push({
      kind: 'postventa', cliente: it.pedido.cartel, fecha: it.milestone.due,
      milestone: it.milestone, dias: it.milestone.days, tel: it.tel, pedido: it.pedido
    });
  }
  return list.sort((a, b) => a.fecha - b.fecha);
}

function extractPhone(envio) {
  if (!envio) return '';
  const s = String(envio);
  const candidates = s.match(/\d[\d\s\-]{7,14}\d/g) || [];
  for (const c of candidates) {
    const d = c.replace(/\D/g,'');
    if (d.length >= 8 && d.length <= 13) {
      // Argentina: prepend 549 if doesn't start with 54
      const norm = d.startsWith('54') ? d : '549' + d.replace(/^0+/, '');
      return norm;
    }
  }
  return '';
}

function waLink(tel, msg) {
  if (!tel) return '';
  return `https://wa.me/${tel}?text=${encodeURIComponent(msg)}`;
}

// ============ ROUTING ============
function setView(v) {
  STATE.view = v;
  STATE.selected = null;
  location.hash = v;
  render();
}
window.addEventListener('hashchange', () => {
  const h = location.hash.replace('#','') || 'dashboard';
  if (h !== STATE.view) { STATE.view = h; render(); }
});

// ============ RENDER ============
function renderUserPicker() {
  return `
    <div class="user-picker-overlay">
      <div class="user-picker-box">
        <img class="brand-logo" src="assets/logo.svg" alt="Neon Infinito" style="width:80px;margin-bottom:var(--s-3)">
        <h2 style="margin:0 0 var(--s-1)">NEON · Ventas</h2>
        <p class="muted" style="margin:0 0 var(--s-4);font-size:13px">¿Quién sos?</p>
        <div style="display:flex;gap:var(--s-3);justify-content:center">
          ${CONFIG.defaultUsers.map(u => `
            <button class="btn btn-cyan user-pick-big" data-pick-user="${escapeHtml(u)}" style="min-width:120px;padding:var(--s-3) var(--s-4);font-size:16px">${escapeHtml(u)}</button>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}
function bindUserPicker() {
  document.querySelectorAll('[data-pick-user]').forEach(el => {
    el.onclick = () => setUser(el.dataset.pickUser);
  });
}
function render() {
  if (!STATE.user) {
    document.getElementById('app').innerHTML = renderUserPicker();
    bindUserPicker();
    return;
  }
  document.getElementById('app').innerHTML = renderShell();
  if (STATE.error)   document.getElementById('main').innerHTML = renderError();
  else if (!STATE.loaded) document.getElementById('main').innerHTML = renderLoading();
  else {
    const v = STATE.view;
    if (v === 'dashboard')      document.getElementById('main').innerHTML = renderDashboard();
    else if (v === 'pedidos')   document.getElementById('main').innerHTML = renderPedidos();
    else if (v === 'presupuestos') document.getElementById('main').innerHTML = renderPresupuestos();
    else if (v === 'seguimientos') document.getElementById('main').innerHTML = renderSeguimientos();
    else if (v === 'panel-joaco')   document.getElementById('main').innerHTML = renderPanelJoaco();
    else if (v === 'actividad')    document.getElementById('main').innerHTML = renderActividad();
    else if (v === 'chat')         document.getElementById('main').innerHTML = renderChat();
    else if (v === 'admin')        document.getElementById('main').innerHTML = renderAdmin();
    else                        document.getElementById('main').innerHTML = renderDashboard();
  }
  // Toggle main--chat class for full-height layout
  const mainEl = document.getElementById('main');
  if (mainEl) mainEl.classList.toggle('main--chat', STATE.view === 'chat');
  // Lock entire app shell height when chat is active
  const appEl = mainEl && mainEl.closest('.app');
  if (appEl) appEl.classList.toggle('app--chat', STATE.view === 'chat');
  bindNav();
  bindCommon();
  if (STATE.view === 'pedidos') bindPedidos();
  if (STATE.view === 'presupuestos') bindPresupuestos();
  if (STATE.view === 'seguimientos') bindSeguimientos();
  if (STATE.view === 'dashboard') drawCharts();
  if (STATE.view === 'panel-joaco') bindPanelJoaco();
  if (STATE.view === 'actividad') bindActividad();
  if (STATE.view === 'chat') bindChat();
  if (STATE.view === 'admin') bindAdmin();
}

function renderShell() {
  // Counts for badges
  const sgts = STATE.loaded ? getSeguimientosWeek() : [];
  const presupuestoCount = sgts.filter(s => s.kind === 'presupuesto').length;
  const postventaCount = sgts.filter(s => s.kind === 'postventa').length;
  const v = STATE.view;
  return `
    <aside class="sidebar">
      <div class="brand">
        <img class="brand-logo" src="assets/logo.svg" alt="Neon Infinito">
        <span class="b-sub">· VENTAS</span>
      </div>
      <div class="user-pick">
        <div class="user-pick-label">Usuario ${isAdmin() ? '<span class="admin-tag">admin</span>' : ''}</div>
        <div class="user-pick-chips">
          ${STATE.users.map(u => {
            const locked = u === 'Gaspar' && !STATE.token;
            return `<button class="user-chip ${STATE.user===u?'active':''}" data-set-user="${escapeHtml(u)}">${locked?'🔒 ':''}${escapeHtml(u)}</button>`;
          }).join('')}
          <button class="user-chip add" data-add-user>+</button>
          ${isAdmin() ? '<button class="user-chip add" data-logout title="Cerrar sesión">⎋</button>' : ''}
        </div>
      </div>
      <nav class="nav">
        <button class="nav-item ${v==='dashboard'?'active':''}" data-view="dashboard"><span class="icon">◊</span> Dashboard</button>
        <button class="nav-item ${v==='pedidos'?'active':''}" data-view="pedidos"><span class="icon">▦</span> Pedidos</button>
        <button class="nav-item ${v==='presupuestos'?'active':''}" data-view="presupuestos"><span class="icon">∑</span> Presupuestos</button>
        <button class="nav-item ${v==='seguimientos'?'active':''}" data-view="seguimientos"><span class="icon">↻</span> Seguimientos
          ${sgts.length ? `<span class="badge">${sgts.length}</span>` : ''}
        </button>
        <button class="nav-item ${v==='panel-joaco'?'active':''}" data-view="panel-joaco"><span class="icon">⚡</span> Panel Joaco
          ${STATE.loaded ? (() => { const c = getPanelJoacoCount(); return c ? '<span class="badge">' + c + '</span>' : ''; })() : ''}
        </button>
        <button class="nav-item ${v==='actividad'?'active':''}" data-view="actividad"><span class="icon">⌬</span> Actividad</button>
        ${isAdmin() ? `<button class="nav-item ${v==='chat'?'active':''}" data-view="chat"><span class="icon">✉</span> Chat WA
          <span class="badge cyan" data-chat-badge style="display:${chatState.totalUnread ? '' : 'none'}">${chatState.totalUnread || ''}</span>
        </button>` : ''}
        ${isAdmin() ? `<button class="nav-item ${v==='admin'?'active':''}" data-view="admin"><span class="icon">★</span> Admin</button>` : ''}
      </nav>
      <div class="sidebar-foot">
        <span class="status-dot"></span> Live · Sheet 2026<br>
        ${STATE.loaded ? `<span style="text-transform:none">${STATE.pedidos.length} pedidos · ${STATE.presupuestos.length} ppto</span>` : 'cargando...'}
      </div>
    </aside>
    <main class="main" id="main"></main>
    <div id="drawer-bg" class="drawer-bg"></div>
    <div id="drawer" class="drawer"></div>
    <div id="toast" class="toast"></div>
  `;
}

function renderLoading() {
  return `<div class="loading"><div class="spinner"></div><p style="margin-top:14px">Conectando con Google Sheets…</p></div>`;
}

function renderError() {
  return `<div class="page-head"><h1>Error</h1></div>
    <div class="error">${escapeHtml(STATE.error)}<br><br>
      <button class="btn" onclick="loadAll()">Reintentar</button>
    </div>`;
}

// ---------- DASHBOARD ----------
function renderDashboard() {
  const cur = pedidosDash();
  const totalMes = cur.reduce((a,p)=>a+p.precio+p.precioDimmer, 0);
  const aov = cur.length ? totalMes / cur.length : 0;
  // Cobrado = total - restante (si restante=0, el cartel está saldado)
  const cobrado = cur.reduce((a,p)=>a + (p.precio + p.precioDimmer - p.restante), 0);
  const pctCobrado = totalMes ? Math.round(cobrado/totalMes*100) : 0;
  const sgts = getSeguimientosWeek();
  const pptosAbiertos = sgts.filter(s=>s.kind==='presupuesto');
  const postvenSgs = sgts.filter(s=>s.kind==='postventa');
  const months = availableMonths();
  const selected = getDashMonths(); // null = todos, array = filtro
  const isAll = STATE.dashMonths === 'all';
  const isDefault = STATE.dashMonths === null;
  return `
    <div class="period-selector">
      <span class="ps-label">Período</span>
      <div class="ps-chips">
        <button class="ps-chip ${isDefault?'active':''}" data-period="current">Mes actual</button>
        <button class="ps-chip ${isAll?'active':''}" data-period="all">Todos</button>
        ${months.map(m => {
          const [y,mm] = m.split('-');
          const label = new Date(parseInt(y), parseInt(mm)-1, 1).toLocaleDateString('es-AR', {month:'short'}).replace('.','');
          const active = !isAll && !isDefault && STATE.dashMonths instanceof Set && STATE.dashMonths.has(m);
          return `<button class="ps-chip ${active?'active':''}" data-period-m="${m}">${label} ${y.slice(2)}</button>`;
        }).join('')}
      </div>
      <span class="ps-meta">${dashMonthsLabel()} · ${cur.length} pedidos</span>
    </div>

    <div class="page-head">
      <div>
        <div class="eyebrow">${new Date().toLocaleDateString('es-AR', {day:'2-digit', month:'long', year:'numeric'})}</div>
        <h1>Dashboard</h1>
      </div>
      <div class="actions">
        <button class="btn btn-ghost" onclick="loadAll()">↻ Refrescar</button>
        <a class="btn btn-cyan" href="https://docs.google.com/spreadsheets/d/${CONFIG.ventasSheetId}/edit?gid=1538740882" target="_blank">Abrir Sheet ↗</a>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">Ventas mes</div><div class="kpi-value">${fmtMoney(totalMes)}</div><div class="kpi-delta">${cur.length} pedidos</div></div>
      <div class="kpi cyan"><div class="kpi-label">Ticket promedio</div><div class="kpi-value">${fmtMoney(aov)}</div><div class="kpi-delta">AOV mes</div></div>
      <div class="kpi"><div class="kpi-label">% Cobrado</div><div class="kpi-value">${pctCobrado}%</div><div class="kpi-delta">${fmtMoney(cobrado)} / ${fmtMoney(totalMes)}</div></div>
      <div class="kpi cyan"><div class="kpi-label">Total año</div><div class="kpi-value">${fmtMoney(STATE.pedidos.reduce((a,p)=>a+p.precio+p.precioDimmer,0))}</div><div class="kpi-delta">${STATE.pedidos.length} pedidos · año</div></div>
    </div>

    <div class="chart-grid">
      <div class="card chart-card">
        <div class="card-h">
          <h3>${escapeHtml(DASH_CHARTS[STATE.dashChartIdx].title(dashMonthsLabel()))}</h3>
          <div class="chart-nav">
            <button class="chart-arrow" data-chart-nav="prev" aria-label="Anterior">‹</button>
            <span class="chart-dots">${DASH_CHARTS.map((_,i)=>`<span class="dot ${i===STATE.dashChartIdx?'active':''}" data-chart-idx="${i}"></span>`).join('')}</span>
            <button class="chart-arrow" data-chart-nav="next" aria-label="Siguiente">›</button>
          </div>
        </div>
        <div class="chart-canvas" id="chart-line"></div>
      </div>
      <div class="card">
        <div class="card-h"><h3>Estado de pedidos</h3></div>
        <div class="chart-canvas" id="chart-estado"></div>
        <div class="legend" id="legend-estado"></div>
      </div>
      <div class="card">
        <div class="card-h"><h3>Canal AD</h3></div>
        <div class="chart-canvas" id="chart-canal"></div>
        <div class="legend" id="legend-canal"></div>
      </div>
    </div>

    <div class="alerts-grid">
      <div class="alert-card cyan">
        <div class="h">
          <h3>Presupuestos a seguir</h3>
          <div class="count">${pptosAbiertos.length}</div>
        </div>
        <ul class="alert-list">
          ${pptosAbiertos.slice(0,8).map(s => `
            <li>
              <div class="who">${escapeHtml(s.cliente)}</div>
              <div class="when">${s.diasAbierto}d · ${fmtMoney(s.precio)}</div>
              <button class="go" data-cliente="${escapeHtml(s.cliente)}" data-action="seg-cliente">Ver</button>
            </li>
          `).join('') || '<li><div class="who muted">Nada para seguir esta semana ✨</div></li>'}
        </ul>
      </div>
      <div class="alert-card red">
        <div class="h">
          <h3>Post-venta a seguir</h3>
          <div class="count">${postvenSgs.length}</div>
        </div>
        <ul class="alert-list">
          ${postvenSgs.slice(0,8).map(s => `
            <li>
              <div class="who">${escapeHtml(s.cliente)} <span class="pill ${s.milestone.tagClass}" style="margin-left:6px">${s.milestone.id}</span></div>
              <div class="when">${s.dias > 0 ? '+' + s.dias + 'd' : s.dias === 0 ? 'hoy' : s.dias + 'd'}</div>
              ${s.tel ? `<a class="go" target="_blank" href="${escapeHtml(waLink(s.tel, s.milestone.template(s.cliente.split(' ')[0])))}">WA</a>` : '<span class="go muted">sin tel</span>'}
            </li>
          `).join('') || '<li><div class="who muted">Nada para seguir esta semana ✨</div></li>'}
        </ul>
      </div>
    </div>
  `;
}

// ---------- PEDIDOS ----------
let pedidoFilter = { search: '', estadoPago: '', estadoPedido: '', canal: '', mes: '' };
let pedidoSort = { col: 'fecha', dir: -1 };
function bindPedidos() {
  document.querySelectorAll('[data-pf]').forEach(el => {
    el.addEventListener('input', () => { pedidoFilter[el.dataset.pf] = el.value; renderTablePedidos(); });
    el.addEventListener('change', () => { pedidoFilter[el.dataset.pf] = el.value; renderTablePedidos(); });
  });
  document.querySelectorAll('[data-sort]').forEach(el => {
    el.onclick = () => {
      const c = el.dataset.sort;
      if (pedidoSort.col === c) pedidoSort.dir *= -1;
      else { pedidoSort.col = c; pedidoSort.dir = 1; }
      renderTablePedidos();
    };
  });
  document.querySelectorAll('tr[data-pid]').forEach(el => {
    el.onclick = () => openDrawerPedido(parseInt(el.dataset.pid));
  });
}
function renderPedidos() {
  const estadosPago = uniq(STATE.pedidos.map(p=>p.estadoPago).filter(Boolean));
  const estadosPed = uniq(STATE.pedidos.map(p=>p.estadoPedido).filter(Boolean));
  const canales = uniq(STATE.pedidos.map(p=>p.canalAd).filter(Boolean));
  const meses = uniq(STATE.pedidos.map(p=>getMonth(p.fecha))).sort().reverse();
  return `
    <div class="page-head">
      <div><div class="eyebrow">${STATE.pedidos.length} totales</div><h1>Pedidos</h1></div>
      <div class="actions"><button class="btn btn-ghost" onclick="loadAll()">↻ Refrescar</button></div>
    </div>
    <div class="table-wrap">
      <div class="table-toolbar">
        <input type="text" placeholder="Buscar (cliente, tel, número, canal, productor…)" data-pf="search" value="${escapeHtml(pedidoFilter.search)}">
        <select data-pf="mes"><option value="">Todos los meses</option>${meses.map(m=>`<option ${pedidoFilter.mes===m?'selected':''}>${m}</option>`).join('')}</select>
        <select data-pf="estadoPago"><option value="">Pago: todos</option>${estadosPago.map(s=>`<option ${pedidoFilter.estadoPago===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}</select>
        <select data-pf="estadoPedido"><option value="">Pedido: todos</option>${estadosPed.map(s=>`<option ${pedidoFilter.estadoPedido===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}</select>
        <select data-pf="canal"><option value="">Canal: todos</option>${canales.map(s=>`<option ${pedidoFilter.canal===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}</select>
        <div class="right"><span id="row-count">0</span> filas</div>
      </div>
      <div id="table-pedidos"></div>
    </div>
  `;
}
function renderTablePedidos() {
  const wrap = document.getElementById('table-pedidos');
  if (!wrap) return;
  const filtered = STATE.pedidos.filter(p => {
    if (pedidoFilter.search) {
      const q = normName(pedidoFilter.search);
      const blob = normName([p.cartel, p.envio, p.numero, p.plataforma, p.canalAd, p.productor, p.aclaracion, p.colores, p.base].join(' '));
      if (!blob.includes(q)) return false;
    }
    if (pedidoFilter.estadoPago && p.estadoPago !== pedidoFilter.estadoPago) return false;
    if (pedidoFilter.estadoPedido && p.estadoPedido !== pedidoFilter.estadoPedido) return false;
    if (pedidoFilter.canal && p.canalAd !== pedidoFilter.canal) return false;
    if (pedidoFilter.mes && getMonth(p.fecha) !== pedidoFilter.mes) return false;
    return true;
  });
  filtered.sort((a,b) => {
    const va = a[pedidoSort.col], vb = b[pedidoSort.col];
    if (va instanceof Date) return (va - vb) * pedidoSort.dir;
    if (typeof va === 'number') return (va - vb) * pedidoSort.dir;
    return String(va).localeCompare(String(vb)) * pedidoSort.dir;
  });
  document.getElementById('row-count').textContent = filtered.length;
  const headers = [
    ['fecha','Fecha'],['cartel','Cartel'],['precio','Precio'],['estadoPago','Pago'],['estadoPedido','Estado'],['canalAd','Canal'],['plataforma','Plat.']
  ];
  wrap.innerHTML = `
    <table class="t">
      <thead><tr>${headers.map(([c,l]) => `<th data-sort="${c}" class="${pedidoSort.col===c?'sorted':''}">${l} <span class="sort">${pedidoSort.col===c?(pedidoSort.dir>0?'▲':'▼'):''}</span></th>`).join('')}</tr></thead>
      <tbody>
        ${filtered.length === 0 ? '<tr class="empty-row"><td colspan="7">No hay pedidos con esos filtros</td></tr>' :
          filtered.map(p => `
            <tr data-pid="${p.idx}">
              <td class="num">${fmtDate(p.fecha)}</td>
              <td class="cliente">${escapeHtml(p.cartel)}</td>
              <td class="num">${fmtMoney(p.precio + p.precioDimmer)}</td>
              <td>${pillEstadoPago(p.estadoPago)}</td>
              <td>${pillEstadoPedido(p.estadoPedido)}</td>
              <td><span class="muted" style="font-size:12px">${escapeHtml(p.canalAd||'—')}</span></td>
              <td><span class="muted" style="font-size:12px">${escapeHtml(p.plataforma||'—')}</span></td>
            </tr>
          `).join('')}
      </tbody>
    </table>
  `;
  document.querySelectorAll('tr[data-pid]').forEach(el => el.onclick = () => openDrawerPedido(parseInt(el.dataset.pid)));
  document.querySelectorAll('[data-sort]').forEach(el => {
    el.onclick = () => {
      const c = el.dataset.sort;
      if (pedidoSort.col === c) pedidoSort.dir *= -1;
      else { pedidoSort.col = c; pedidoSort.dir = 1; }
      renderTablePedidos();
    };
  });
}
function pillEstadoPago(s) {
  const x = (s||'').toLowerCase();
  // "primer pago" / "1er pago" → rojo (falta cobrar resto)
  if (x.includes('primer') || x.includes('1er') || x.includes('1°') || /\b1\b/.test(x)) return `<span class="pill red">${escapeHtml(s)}</span>`;
  // Cobro completo → verde
  if (x.includes('cobrad') || x.includes('total') || x === 'pagado' || x.includes('100')) return `<span class="pill green">${escapeHtml(s)}</span>`;
  // Seña / parcial → amber
  if (x.includes('seña') || x.includes('sena') || x.includes('parc')) return `<span class="pill amber">${escapeHtml(s)}</span>`;
  // 2do / restante / pendiente → amber
  if (x.includes('2do') || x.includes('rest') || x.includes('pend')) return `<span class="pill amber">${escapeHtml(s)}</span>`;
  return `<span class="pill muted">${escapeHtml(s||'—')}</span>`;
}
function pillEstadoPedido(s) {
  const x = (s||'').toLowerCase();
  if (x.includes('entreg') || x.includes('envia')) return `<span class="pill cyan">${escapeHtml(s)}</span>`;
  if (x.includes('produc')) return `<span class="pill amber">${escapeHtml(s)}</span>`;
  if (x.includes('list')) return `<span class="pill green">${escapeHtml(s)}</span>`;
  return `<span class="pill muted">${escapeHtml(s||'—')}</span>`;
}

// ---------- PRESUPUESTOS ----------
let pptoFilter = 'all'; // all | abiertos | cerrados | semana
function bindPresupuestos() {
  document.querySelectorAll('[data-ppfilter]').forEach(el => {
    el.onclick = () => { pptoFilter = el.dataset.ppfilter; renderPresupuestos(); render(); };
  });
  const openBtn = document.querySelector('[data-cot-open]');
  if (openBtn) openBtn.onclick = () => { pptoShowCotizador = true; render(); };
  const closeBtn = document.querySelector('[data-cot-close]');
  if (closeBtn) closeBtn.onclick = () => { pptoShowCotizador = false; render(); };
  document.querySelectorAll('[data-cot-field]').forEach(el => {
    el.oninput = () => { STATE.cotizadorForm[el.dataset.cotField] = el.value; updateCotizadorForm(); };
    el.onchange = () => { STATE.cotizadorForm[el.dataset.cotField] = el.value; updateCotizadorForm(); };
  });
  bindCotSaveBtn();
}

function updateCotizadorForm() {
  const slot = document.getElementById('cot-results-slot');
  if (slot) {
    slot.innerHTML = renderCotizadorResults();
    bindCotSaveBtn();
  }
}
function bindCotSaveBtn() {
  const btn = document.getElementById('cot-save-btn');
  if (btn) btn.onclick = () => saveCotizacion();
  const copyBtn = document.getElementById('cot-copy-btn');
  if (copyBtn) copyBtn.onclick = () => copiarPresupuesto();
}
let pptoShowCotizador = false;

function renderCotizadorResults() {
  const f = STATE.cotizadorForm;
  const valid = +f.ancho > 0 && +f.alto > 0;
  if (!valid) return '<div class="muted" style="margin-top:var(--s-2);font-size:12px">Completá ancho y alto para ver los precios</div>';
  const r = calcCotizador(f);
  const p = getCotizadorParams();
  return `
    <div class="cot-results">
      <div class="cot-meta">m² (sheet): <b>${r.m2.toFixed(2)}</b></div>
      <div class="cot-result-grid">
        <div class="cot-result"><div class="lbl">Transparente</div><div class="val">${r.transFinal !== r.trans ? '<s style="opacity:.4;font-size:12px">'+fmtMoney(r.trans)+'</s> ' : ''}${fmtMoney(r.transFinal)}</div></div>
        <div class="cot-result"><div class="lbl">Negro</div><div class="val">${r.negroFinal !== r.negro ? '<s style="opacity:.4;font-size:12px">'+fmtMoney(r.negro)+'</s> ' : ''}${fmtMoney(r.negroFinal)}</div></div>
        <div class="cot-result"><div class="lbl">Reventa (×${p.reventa_mult})</div><div class="val">${fmtMoney(r.reventa)}</div></div>
        <div class="cot-result"><div class="lbl">Comisión (${(p.comision_pct*100).toFixed(0)}%)</div><div class="val">${fmtMoney(r.comision)}</div></div>
        ${r.descuento ? '<div class="cot-result"><div class="lbl">Descuento (m²>'+p.descuento_min_m2+')</div><div class="val">×'+p.descuento_mult+'</div></div>' : ''}
        ${r.recargo ? '<div class="cot-result"><div class="lbl">Recargo (m²≤'+(r.m2<=5?'5':r.m2<=12.5?'12.5':'25')+')</div><div class="val">×'+(r.m2<=5?p.recargo_5:r.m2<=12.5?p.recargo_125:p.recargo_25)+'</div></div>' : ''}
      </div>
      <div style="margin-top:var(--s-3);display:flex;gap:var(--s-2);justify-content:flex-end">
        <button class="btn btn-ghost" id="cot-copy-btn">Copiar presupuesto</button>
        <button class="btn btn-cyan" id="cot-save-btn" ${STATE.cotizadorSaving ? 'disabled' : ''}>${STATE.cotizadorSaving ? 'Guardando…' : 'Guardar en Sheet'}</button>
      </div>
    </div>
  `;
}

function renderCotizadorForm() {
  const f = STATE.cotizadorForm;
  return `
    <div class="card cot-card" style="margin-bottom:var(--s-4)">
      <div class="card-h">
        <h3>Cotizador</h3>
        <button class="btn btn-ghost" data-cot-close>×</button>
      </div>
      <div class="cot-grid">
        <label>Cliente / diseño<input type="text" data-cot-field="cliente" value="${escapeHtml(f.cliente)}" placeholder="nombre del cliente"></label>
        <label>Canal
          <select data-cot-field="canal">
            <option value="WPP" ${f.canal==='WPP'?'selected':''}>WhatsApp</option>
            <option value="IG" ${f.canal==='IG'?'selected':''}>Instagram</option>
          </select>
        </label>
        <label>Teléfono${f.canal==='WPP'?' *':''}<input type="tel" data-cot-field="telefono" value="${escapeHtml(f.telefono)}" placeholder="${f.canal==='WPP'?'obligatorio':'opcional'}"></label>
        <label>Ancho (cm)<input type="number" min="0" step="0.1" data-cot-field="ancho" value="${escapeHtml(f.ancho)}"></label>
        <label>Alto (cm)<input type="number" min="0" step="0.1" data-cot-field="alto" value="${escapeHtml(f.alto)}"></label>
        <label>Neón (mt)<input type="number" min="0" step="0.1" data-cot-field="neon" value="${escapeHtml(f.neon)}"></label>
        <label>Tipo
          <select data-cot-field="tipo">
            <option value="INT" ${f.tipo==='INT'?'selected':''}>INT (interior)</option>
            <option value="EXT" ${f.tipo==='EXT'?'selected':''}>EXT (exterior)</option>
          </select>
        </label>
      </div>
      <div id="cot-results-slot">${renderCotizadorResults()}</div>
    </div>
  `;
}

function renderPresupuestos() {
  const list = STATE.presupuestos.map(p => ({...p, st: presupuestoStatus(p)}));
  const counts = {
    all: list.length,
    abiertos: list.filter(p=>p.st.state==='abierto').length,
    cerrados: list.filter(p=>p.st.state==='cerrado').length,
    semana: list.filter(p=>p.st.state==='abierto' && p.st.days <= 14).length,
  };
  let filtered = list;
  if (pptoFilter === 'abiertos') filtered = list.filter(p=>p.st.state==='abierto');
  else if (pptoFilter === 'cerrados') filtered = list.filter(p=>p.st.state==='cerrado');
  else if (pptoFilter === 'semana') filtered = list.filter(p=>p.st.state==='abierto' && p.st.days <= 14);
  filtered = filtered.sort((a,b) => b.fecha - a.fecha);
  return `
    <div class="page-head">
      <div><div class="eyebrow">${STATE.presupuestos.length}${STATE.presupuestos.length ? ' desde ' + fmtDate(STATE.presupuestos.reduce((min, p) => p.fecha < min ? p.fecha : min, STATE.presupuestos[0].fecha)) : ''}</div><h1>Presupuestos</h1></div>
      <div class="actions">
        <button class="btn btn-cyan" data-cot-open>＋ Cotizador</button>
        <button class="btn btn-ghost" onclick="loadAll()">↻ Refrescar</button>
      </div>
    </div>
    ${pptoShowCotizador ? renderCotizadorForm() : ''}
    <div class="table-wrap">
      <div class="table-toolbar">
        <button class="btn btn-ghost ${pptoFilter==='all'?'btn-cyan':''}" data-ppfilter="all">Todos · ${counts.all}</button>
        <button class="btn btn-ghost ${pptoFilter==='abiertos'?'btn-cyan':''}" data-ppfilter="abiertos">Abiertos · ${counts.abiertos}</button>
        <button class="btn btn-ghost ${pptoFilter==='semana'?'btn-cyan':''}" data-ppfilter="semana">Para seguir · ${counts.semana}</button>
        <button class="btn btn-ghost ${pptoFilter==='cerrados'?'btn-cyan':''}" data-ppfilter="cerrados">Cerrados · ${counts.cerrados}</button>
        <div class="right">${filtered.length} filas</div>
      </div>
      <table class="t">
        <thead><tr><th>Fecha</th><th>Cliente</th><th>Tamaño</th><th>m²</th><th>Precio</th><th>Estado</th></tr></thead>
        <tbody>
          ${filtered.length===0 ? '<tr class="empty-row"><td colspan="6">Sin presupuestos en este filtro</td></tr>' :
            filtered.map(p => {
              let pill = '';
              if (p.st.state === 'cerrado') pill = `<span class="pill green">✓ Cerrado</span>`;
              else if (p.st.state === 'fresco') pill = `<span class="pill cyan">${p.st.days}d</span>`;
              else if (p.st.state === 'abierto') pill = `<span class="pill ${p.st.days > 14 ? 'red' : 'amber'}">Abierto · ${p.st.days}d</span>`;
              else pill = `<span class="pill muted">Futuro</span>`;
              const dDays = daysBetween(p.fecha, TODAY);
              const dayPill = dDays === 0 ? '<span class="pill cyan" style="margin-left:6px;font-size:9px">HOY</span>' : dDays === 1 ? '<span class="pill amber" style="margin-left:6px;font-size:9px">AYER</span>' : '';
              return `<tr><td class="num">${fmtDate(p.fecha)}${dayPill}</td><td class="cliente">${escapeHtml(p.nombre)}</td><td class="num">${p.tamCm||'—'}×${p.ancho||'—'}</td><td class="num">${p.m2||'—'}</td><td class="num">${fmtMoney(p.precio)}</td><td>${pill}</td></tr>`;
            }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ---------- SEGUIMIENTOS ----------
// ---------- PANEL JOACO ----------
let panelJoacoFilter = 'pendientes'; // pendientes | todos | hechos

function getPanelJoacoTasks() {
  const tasks = [];
  // 1. Follow-ups de presupuestos: solo el touchpoint actual (primer no-hecho)
  const cutoff = parseDate(CONFIG.presupuestoCutoff);
  for (const ppto of STATE.presupuestos) {
    if (cutoff && ppto.fecha < cutoff) continue;
    const st = presupuestoStatus(ppto);
    if (st.state === 'cerrado' || st.state === 'futuro') continue;
    const tps = presupuestoTouchpoints(ppto.fecha).map(tp => {
      const doneId = `ppto:${ppto.idx}|${ppto.sheet}|${tp.id}`;
      return { ...tp, doneId, done: isDone(doneId), doneAt: getDoneAt(doneId), state: touchpointState(tp.due) };
    });
    // Agregar los hechos recientes (último 24h) para que aparezcan en "Hechas"
    for (const tp of tps) {
      if (tp.done && tp.doneAt && daysBetween(tp.doneAt, TODAY) <= 1) {
        tasks.push({
          type: 'presupuesto', id: tp.doneId, cliente: ppto.nombre,
          label: `${tp.id} · Seguimiento presupuesto`,
          detail: `${fmtMoney(ppto.precio)} · enviado ${fmtDate(ppto.fecha)} · ${st.days}d abierto`,
          due: tp.due, state: tp.state, done: true, doneAt: tp.doneAt,
          tel: ppto.telefono || '', msg: CONFIG.presupuestoTemplate(ppto.nombre.split(' ')[0]), ppto
        });
      }
    }
    // Solo el primer touchpoint no-hecho (el actual)
    const current = tps.find(t => !t.done);
    if (!current) continue;
    const tel = ppto.telefono || '';
    const firstName = ppto.nombre.split(' ')[0];
    tasks.push({
      type: 'presupuesto', id: current.doneId, cliente: ppto.nombre,
      label: `${current.id} · Seguimiento presupuesto`,
      detail: `${fmtMoney(ppto.precio)} · enviado ${fmtDate(ppto.fecha)} · ${st.days}d abierto`,
      due: current.due, state: current.state, done: false, doneAt: null,
      tel, msg: CONFIG.presupuestoTemplate(firstName), ppto
    });
  }
  // 2. Post-venta: solo el milestone actual (primer no-hecho)
  for (const ped of STATE.pedidos) {
    const ms = postventaMilestones(ped);
    const msDone = [];
    let currentFound = false;
    for (const m of ms) {
      if (m.state === 'pending-delivery') continue;
      const doneId = `pv:${ped.idx}|${m.id}`;
      const done = isDone(doneId);
      const doneAt = getDoneAt(doneId);
      const tel = extractPhone(ped.envio);
      const firstName = ped.cartel.split(' ')[0];
      const stateNorm = m.state === 'overdue' ? 'overdue' : m.state === 'now' ? 'due' : 'future';
      const item = {
        type: 'postventa', id: doneId, cliente: ped.cartel,
        label: `${m.id} · ${m.label}`,
        detail: `${fmtMoney(ped.precio)} · entrega ${fmtDate(ped.fecha)}`,
        due: m.due, state: stateNorm, done, doneAt, tel,
        msg: m.template(firstName), pedido: ped
      };
      if (done) {
        // Solo mostrar hechos recientes en "Hechas"
        if (doneAt && daysBetween(doneAt, TODAY) <= 1) tasks.push(item);
      } else if (!currentFound) {
        // Solo el primer milestone no-hecho
        tasks.push(item);
        currentFound = true;
      }
    }
  }
  return tasks;
}

function getPanelJoacoCount() {
  if (!STATE.loaded) return 0;
  const tasks = getPanelJoacoTasks();
  return tasks.filter(t => !t.done && (t.state === 'due' || t.state === 'overdue')).length;
}

function renderPanelJoaco() {
  const all = getPanelJoacoTasks();
  const pendientes = all.filter(t => !t.done);
  const hot = pendientes.filter(t => t.state === 'due' || t.state === 'overdue');
  const future = pendientes.filter(t => t.state === 'future');
  const hechos = all.filter(t => t.done);

  let filtered;
  if (panelJoacoFilter === 'pendientes') filtered = hot;
  else if (panelJoacoFilter === 'todos') filtered = pendientes;
  else filtered = hechos;

  // Sort: overdue first, then due, then future. Within each: by date ascending
  const order = { overdue: 0, due: 1, future: 2 };
  filtered.sort((a, b) => {
    if (a.done && b.done) return (b.doneAt || 0) - (a.doneAt || 0);
    return (order[a.state] || 0) - (order[b.state] || 0) || a.due - b.due;
  });

  return `
    <div class="page-head">
      <div>
        <div class="eyebrow">${hot.length} tareas para hoy</div>
        <h1>Panel Joaco</h1>
      </div>
      <div class="actions">
        <button class="btn btn-ghost" onclick="loadAll()">↻ Refrescar</button>
      </div>
    </div>
    <div class="table-toolbar" style="margin-bottom:var(--s-3)">
      <button class="btn btn-ghost ${panelJoacoFilter==='pendientes'?'btn-cyan':''}" data-jf="pendientes">Para hoy · ${hot.length}</button>
      <button class="btn btn-ghost ${panelJoacoFilter==='todos'?'btn-cyan':''}" data-jf="todos">Todas pendientes · ${pendientes.length}</button>
      <button class="btn btn-ghost ${panelJoacoFilter==='hechos'?'btn-cyan':''}" data-jf="hechos">Hechas · ${hechos.length}</button>
    </div>
    ${filtered.length === 0 ? '<div class="loading">Sin tareas en este filtro</div>' : `
    <div class="seg-list">
      ${filtered.map(t => {
        const stClass = t.done ? 'tp-done' : t.state === 'overdue' ? 'tp-overdue' : t.state === 'due' ? 'tp-due' : 'tp-future';
        const days = daysBetween(t.due, TODAY);
        const whenLabel = t.done ? (t.doneAt ? 'hecho ' + fmtDoneAt(t.doneAt) : 'hecho') : days > 1 ? 'vencido ' + days + 'd' : days === 1 ? 'ayer' : days === 0 ? 'HOY' : days === -1 ? 'mañana' : 'en ' + (-days) + 'd';
        const typeTag = t.type === 'presupuesto' ? '<span class="pill amber" style="font-size:10px">PPTO</span>' : '<span class="pill cyan" style="font-size:10px">PV</span>';
        const waUrl = t.tel ? waLink(t.tel.startsWith('54') ? t.tel : '549' + t.tel.replace(/^0+/, ''), t.msg) : '';
        return `
          <div class="seg-card ${stClass}">
            <div class="seg-row-top">
              <div>
                <div class="seg-cliente">${escapeHtml(t.cliente)} ${typeTag}</div>
                <div class="seg-meta">${t.label} · ${t.detail}</div>
              </div>
              <div class="seg-current ${stClass}">
                <div class="seg-current-when">${whenLabel}</div>
              </div>
            </div>
            <div class="seg-actions">
              ${waUrl ? `<a class="btn btn-primary" target="_blank" href="${escapeHtml(waUrl)}">WhatsApp</a>` : '<span class="muted" style="font-size:12px">Sin teléfono</span>'}
              <button class="btn ${t.done ? 'btn-cyan' : 'btn-ghost'}" data-toggle-done="${t.id}">
                ${t.done ? '✓ Hecho' : 'Marcar hecho'}
              </button>
            </div>
          </div>`;
      }).join('')}
    </div>`}
  `;
}

function bindPanelJoaco() {
  document.querySelectorAll('[data-jf]').forEach(el => {
    el.onclick = () => { panelJoacoFilter = el.dataset.jf; render(); };
  });
  document.querySelectorAll('[data-toggle-done]').forEach(el => {
    el.onclick = (e) => { e.stopPropagation(); toggleDone(el.dataset.toggleDone); };
  });
}

let segTab = 'presupuestos'; // presupuestos | postventa
function bindSeguimientos() {
  document.querySelectorAll('[data-stab]').forEach(el => {
    el.onclick = () => { segTab = el.dataset.stab; render(); };
  });
  document.querySelectorAll('[data-pv-filter]').forEach(el => {
    el.onclick = () => { STATE.segPvFilter = el.dataset.pvFilter; render(); };
  });
  document.querySelectorAll('[data-toggle-done]').forEach(el => {
    el.onclick = (e) => { e.stopPropagation(); toggleDone(el.dataset.toggleDone); };
  });
  document.querySelectorAll('[data-export-csv]').forEach(el => el.onclick = () => {
    if (el.dataset.exportCsv === 'presupuestos') exportSegPresupuestos();
    else exportSegPostventa();
  });
}

function downloadCSV(filename, rows) {
  const csv = rows.map(r => r.map(cell => {
    const s = String(cell == null ? '' : cell);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

function todayKey() {
  const d = TODAY;
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

function exportSegPresupuestos() {
  const items = presupuestosActivos();
  const headers = ['Cliente','Hoja','Fecha enviado','Días abierto','Monto','F1 vence','F1 hecho','F1 marcado en','F2 vence','F2 hecho','F2 marcado en','F3 vence','F3 hecho','F3 marcado en'];
  const rows = [headers];
  for (const it of items) {
    const p = it.ppto;
    const r = [p.nombre, p.sheet, fmtDate(p.fecha), it.diasAbierto, p.precio];
    for (const tp of it.tps) {
      r.push(fmtDate(tp.due));
      r.push(tp.done ? 'sí' : 'no');
      r.push(tp.doneAt ? tp.doneAt.toLocaleString('es-AR') : '');
    }
    rows.push(r);
  }
  downloadCSV(`seguimientos-presupuestos-${todayKey()}.csv`, rows);
}

function exportSegPostventa() {
  const items = postventasActivos();
  const headers = ['Cliente','Milestone','Vence','Días','Hecho','Marcado en','Tel','Estado pedido','Fecha pedido','Precio'];
  const rows = [headers];
  for (const it of items) {
    rows.push([
      it.pedido.cartel,
      it.milestone.id,
      fmtDate(it.milestone.due),
      it.milestone.days,
      it.done ? 'sí' : 'no',
      it.doneAt ? it.doneAt.toLocaleString('es-AR') : '',
      it.tel || '',
      it.pedido.estadoPedido || '',
      fmtDate(it.pedido.fecha),
      it.pedido.precio + it.pedido.precioDimmer
    ]);
  }
  downloadCSV(`seguimientos-postventa-${todayKey()}.csv`, rows);
}

function tpStateLabel(tp) {
  if (tp.done) return 'hecho';
  const d = daysBetween(tp.due, TODAY);
  if (d < -1) return `en ${-d}d`;
  if (d === 0) return 'HOY';
  if (d === -1) return 'mañana';
  if (d === 1) return 'ayer';
  return `vencido ${d}d`;
}
function tpClass(tp) {
  if (tp.done) return 'tp-done';
  if (tp.state === 'future') return 'tp-future';
  if (tp.state === 'due') return 'tp-due';
  return 'tp-overdue';
}

function renderSeguimientos() {
  const ppts = presupuestosActivos();
  const pvs  = postventasActivos().filter(p => !p.done);

  // Counts to show on tabs
  const pptsHot = ppts.filter(p => p.current.state !== 'future').length;
  const pvsHot  = pvs.filter(p => p.milestone.state === 'now' || p.milestone.state === 'overdue').length;

  let body;
  if (segTab === 'presupuestos') body = renderSegPresupuestos(ppts);
  else body = renderSegPostventa(pvs);

  return `
    <div class="page-head">
      <div>
        <div class="eyebrow">${pptsHot + pvsHot} acciones calientes</div>
        <h1>Seguimientos</h1>
      </div>
      <div class="actions">
        <button class="btn btn-ghost" data-export-csv="${segTab}">⬇ CSV</button>
        <button class="btn btn-ghost" onclick="loadAll()">↻ Refrescar</button>
      </div>
    </div>
    <div class="seg-tabs">
      <button class="seg-tab ${segTab==='presupuestos'?'active':''}" data-stab="presupuestos">
        <span class="seg-tab-label">Presupuestos a cerrar</span>
        <span class="seg-tab-count">${pptsHot}<span class="muted" style="font-size:10px">/${ppts.length}</span></span>
      </button>
      <button class="seg-tab ${segTab==='postventa'?'active':''}" data-stab="postventa">
        <span class="seg-tab-label">Post-venta · retargeting</span>
        <span class="seg-tab-count">${pvsHot}<span class="muted" style="font-size:10px">/${pvs.length}</span></span>
      </button>
    </div>
    ${body}
  `;
}

function renderSegPresupuestos(items) {
  if (items.length === 0) return '<div class="loading">✨ No hay presupuestos pendientes de seguimiento</div>';
  // Orden: primero overdue, luego due (hoy/mañana), luego future
  const order = { overdue: 0, due: 1, future: 2 };
  items.sort((a,b) => order[a.current.state] - order[b.current.state] || a.current.due - b.current.due);
  return `
    <div class="seg-help">
      Cadencia: enviado lun/mar/mié → <b>F1 viernes</b> · <b>F2 mié siguiente</b> · <b>F3 mié posterior</b>. Si se envió jue/vie/sáb/dom, F1 cae el primer miércoles.
    </div>
    <div class="seg-list">
      ${items.map(it => {
        const p = it.ppto;
        return `
          <div class="seg-card ${tpClass(it.current)}">
            <div class="seg-row-top">
              <div>
                <div class="seg-cliente">${escapeHtml(p.nombre)}</div>
                <div class="seg-meta">${fmtMoney(p.precio)} · enviado ${fmtDate(p.fecha)} · ${it.diasAbierto}d abierto</div>
              </div>
              <div class="seg-current ${tpClass(it.current)}">
                <div class="seg-current-id">${it.current.id}</div>
                <div class="seg-current-when">${tpStateLabel(it.current)}</div>
              </div>
            </div>
            <div class="seg-tps">
              ${it.tps.map((tp, i) => `
                <div class="tp-pill ${tpClass(tp)} ${i===it.currentIdx?'is-current':''}" data-toggle-done="${tp.doneId}" title="${tp.done && tp.doneAt ? 'Marcado el ' + tp.doneAt.toLocaleString('es-AR') : 'Marcar como hecho'}">
                  <span class="tp-check">${tp.done ? '✓' : i===it.currentIdx ? '●' : '○'}</span>
                  <span class="tp-id">${tp.id}</span>
                  <span class="tp-date">${tp.done && tp.doneAt ? '✓ ' + fmtDoneAt(tp.doneAt) : fmtDate(tp.due)}</span>
                </div>
              `).join('')}
            </div>
          </div>`;
      }).join('')}
    </div>
  `;
}

function renderSegPostventa(items) {
  const filtered = STATE.segPvFilter === 'all' ? items : items.filter(it => it.milestone.id === STATE.segPvFilter);
  const counts = { all: items.length, D30: 0, D60: 0, D90: 0 };
  for (const it of items) counts[it.milestone.id]++;
  // Orden: overdue → now → future. Pero "future" lo escondemos por defecto excepto si filtra.
  const order = { overdue: 0, now: 1, future: 2 };
  filtered.sort((a,b) => order[a.milestone.state] - order[b.milestone.state] || a.milestone.due - b.milestone.due);

  return `
    <div class="seg-filters">
      <button class="ps-chip ${STATE.segPvFilter==='all'?'active':''}" data-pv-filter="all">Todos · ${counts.all}</button>
      <button class="ps-chip tp-d30 ${STATE.segPvFilter==='D30'?'active':''}" data-pv-filter="D30">D30 foto · ${counts.D30}</button>
      <button class="ps-chip tp-d60 ${STATE.segPvFilter==='D60'?'active':''}" data-pv-filter="D60">D60 referidos · ${counts.D60}</button>
      <button class="ps-chip tp-d90 ${STATE.segPvFilter==='D90'?'active':''}" data-pv-filter="D90">D90 2do cartel · ${counts.D90}</button>
    </div>
    ${filtered.length === 0 ? '<div class="loading">Nada en este filtro</div>' :
      `<div class="seg-list">
        ${filtered.map(it => {
          const m = it.milestone;
          const days = m.days;
          const stateText = days > 0 ? `vencido ${days}d` : days === 0 ? 'HOY' : `en ${-days}d`;
          const stClass = m.state === 'overdue' ? 'tp-overdue' : m.state === 'now' ? 'tp-due' : 'tp-future';
          const tel = it.tel;
          const link = tel ? waLink(tel, m.template(it.pedido.cartel.split(' ')[0])) : '';
          return `
            <div class="seg-card ${stClass}">
              <div class="seg-row-top">
                <div>
                  <div class="seg-cliente">${escapeHtml(it.pedido.cartel)}
                    <span class="pill ${m.tagClass}" style="margin-left:8px">${m.id}</span>
                  </div>
                  <div class="seg-meta">${escapeHtml(m.label)} · vence ${fmtDate(m.due)}${tel ? '' : ' · sin tel'}</div>
                </div>
                <div class="seg-current ${stClass}">
                  <div class="seg-current-id">${m.id}</div>
                  <div class="seg-current-when">${stateText}</div>
                </div>
              </div>
              <div class="seg-actions">
                ${link ? `<a class="btn btn-primary" target="_blank" href="${escapeHtml(link)}">📱 Mandar WhatsApp</a>` : '<span class="muted" style="font-size:12px">No se pudo extraer tel del envío</span>'}
                <button class="btn ${it.done?'btn-cyan':'btn-ghost'}" data-toggle-done="${it.doneId}">
                  ${it.done ? '✓ Hecho' : 'Marcar como hecho'}
                </button>
              </div>
            </div>`;
        }).join('')}
      </div>`}
  `;
}

// ---------- DRAWER ----------
function openDrawerPedido(idx) {
  const p = STATE.pedidos.find(p => p.idx === idx);
  if (!p) return;
  const tel = extractPhone(p.envio);
  const ms = postventaMilestones(p);
  document.getElementById('drawer').innerHTML = `
    <div class="drawer-h">
      <h2>${escapeHtml(p.cartel)}</h2>
      <button class="close" onclick="closeDrawer()">×</button>
    </div>
    <div class="drawer-body">
      <div class="drawer-section">
        <h4>Datos del pedido</h4>
        <dl class="kv">
          <dt>Fecha</dt><dd>${fmtDateLong(p.fecha)}</dd>
          <dt>Número</dt><dd>${p.numero || '—'}</dd>
          <dt>Medidas</dt><dd>${p.alto}×${p.ancho} cm · ${p.cmNeon} cm neón</dd>
          <dt>Colores</dt><dd>${escapeHtml(p.colores)}</dd>
          <dt>Base</dt><dd>${escapeHtml(p.base)}</dd>
          <dt>Dimmer</dt><dd>${escapeHtml(p.dimmer)} ${p.precioDimmer ? '· '+fmtMoney(p.precioDimmer) : ''}</dd>
          <dt>Cantidad</dt><dd>${p.cantidad}</dd>
        </dl>
      </div>
      <div class="drawer-section">
        <h4>Pago</h4>
        <dl class="kv">
          <dt>Precio</dt><dd>${fmtMoney(p.precio + p.precioDimmer)}</dd>
          <dt>Pagado</dt><dd>${fmtMoney(p.pagado)}</dd>
          <dt>Restante</dt><dd>${fmtMoney(p.restante)}</dd>
          <dt>Estado pago</dt><dd>${pillEstadoPago(p.estadoPago)}</dd>
          <dt>Estado pedido</dt><dd>${pillEstadoPedido(p.estadoPedido)}</dd>
        </dl>
      </div>
      <div class="drawer-section">
        <h4>Origen</h4>
        <dl class="kv">
          <dt>Plataforma</dt><dd>${escapeHtml(p.plataforma||'—')}</dd>
          <dt>Canal AD</dt><dd>${escapeHtml(p.canalAd||'—')}</dd>
          <dt>Productor</dt><dd>${escapeHtml(p.productor||'—')}</dd>
        </dl>
      </div>
      <div class="drawer-section">
        <h4>Envío</h4>
        <div class="t-small" style="white-space:pre-wrap;background:var(--ink-200);padding:12px;border-radius:8px;color:var(--fg)">${escapeHtml(p.envio||'(sin datos)')}</div>
        ${p.aclaracion ? `<div class="t-small" style="margin-top:8px;color:var(--fg-subtle)"><b>Aclaración:</b> ${escapeHtml(p.aclaracion)}</div>` : ''}
      </div>
      <div class="drawer-section">
        <h4>Timeline post-venta</h4>
        <div class="timeline">
          <div class="tl-item done">
            <div class="tl-date">${fmtDate(p.fecha)}</div>
            <div class="tl-title">Pedido tomado</div>
            <div class="tl-desc">${fmtMoney(p.precio + p.precioDimmer)}</div>
          </div>
          ${ms.map(m => {
            const cls = m.state === 'now' ? 'now' : (m.state === 'overdue' || m.state === 'future' ? 'future' : 'future');
            const link = tel ? waLink(tel, m.template(p.cartel.split(' ')[0])) : '';
            return `<div class="tl-item ${cls}">
              <div class="tl-date">${fmtDate(m.due)} · <span class="pill ${m.tagClass}">${m.id}</span></div>
              <div class="tl-title">${m.label}</div>
              <div class="tl-desc">${m.entregado ? (m.days > 0 ? `vencido hace ${m.days}d` : m.days === 0 ? 'hoy' : `en ${-m.days}d`) : 'esperando entrega'}</div>
              ${link && (m.state === 'now' || m.state === 'overdue') ? `<a class="btn btn-primary" target="_blank" href="${escapeHtml(link)}" style="margin-top:8px;font-size:12px">📱 Mandar mensaje</a>` : ''}
            </div>`;
          }).join('')}
        </div>
      </div>
    </div>
  `;
  document.getElementById('drawer').classList.add('open');
  document.getElementById('drawer-bg').classList.add('open');
  document.getElementById('drawer-bg').onclick = closeDrawer;
}

function closeDrawer() {
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('drawer-bg').classList.remove('open');
}

function openDrawer(title, contentHtml) {
  document.getElementById('drawer').innerHTML = `
    <div class="drawer-h">
      <h2>${title}</h2>
      <button class="close" onclick="closeDrawer()">×</button>
    </div>
    <div class="drawer-body">${contentHtml}</div>
  `;
  document.getElementById('drawer').classList.add('open');
  document.getElementById('drawer-bg').classList.add('open');
  document.getElementById('drawer-bg').onclick = closeDrawer;
}

// ---------- CHARTS ----------
function drawCharts() {
  if (STATE.dashChartIdx === 0) drawLine();
  else if (STATE.dashChartIdx === 1) drawWeeklyStacked();
  drawDonut('chart-estado', 'legend-estado', byField('estadoPedido'), ['var(--neon-cyan)', 'var(--warning)', 'var(--success)', 'var(--neon-red)', 'var(--ink-500)']);
  drawDonut('chart-canal',  'legend-canal',  byField('canalAd'),       ['var(--neon-red)', 'var(--neon-cyan)', 'var(--warning)', 'var(--success)', 'var(--ink-500)', 'var(--ink-600)']);
}
function byField(f) {
  const cur = pedidosDash();
  const m = new Map();
  for (const p of cur) {
    const k = (p[f] || '—').trim() || '—';
    m.set(k, (m.get(k)||0) + 1);
  }
  return Array.from(m.entries()).sort((a,b)=>b[1]-a[1]);
}
function drawLine() {
  const el = document.getElementById('chart-line'); if (!el) return;
  const cur = pedidosDash();
  const byDay = new Map();
  for (const p of cur) {
    const k = p.fecha.toISOString().slice(0,10);
    byDay.set(k, (byDay.get(k)||0) + p.precio + p.precioDimmer);
  }
  // Build day axis. Modo 'Todos' = todos los días entre primer y último pedido.
  const months = getDashMonths();
  const data = []; // { date: Date, label: string, val: number }
  if (!months) {
    if (cur.length === 0) { el.innerHTML = '<div class="loading muted">sin datos</div>'; return; }
    const dates = STATE.pedidos.map(p => p.fecha.getTime());
    const minD = new Date(Math.min(...dates)); minD.setHours(0,0,0,0);
    const maxD = new Date(Math.max(...dates)); maxD.setHours(0,0,0,0);
    for (let dt = new Date(minD); dt <= maxD; dt = addDays(dt, 1)) {
      const k = dt.toISOString().slice(0,10);
      data.push({ date: new Date(dt), label: fmtDate(dt), val: byDay.get(k) || 0 });
    }
  } else {
    const sortedMonths = months.slice().sort();
    for (const ym of sortedMonths) {
      const [y,m] = ym.split('-');
      const yr = parseInt(y), mo = parseInt(m)-1;
      const dim = new Date(yr, mo+1, 0).getDate();
      for (let d = 1; d <= dim; d++) {
        const dt = new Date(yr, mo, d);
        const k = dt.toISOString().slice(0,10);
        data.push({ date: dt, label: fmtDate(dt), val: byDay.get(k) || 0 });
      }
    }
  }
  if (data.length === 0) { el.innerHTML = '<div class="loading muted">sin datos</div>'; return; }
  // Acumular: cada punto = total acumulado del período hasta ese día
  let running = 0;
  for (const p of data) { running += p.val; p.daily = p.val; p.val = running; }
  const max = Math.max(1, ...data.map(p=>p.val));
  const W = el.clientWidth, H = 220, PL = 50, PR = 20, PT = 16, PB = 28;
  const xAt = (i) => PL + (i / Math.max(1, data.length-1)) * (W - PL - PR);
  const yAt = (v) => (H - PB) - (v / max) * (H - PB - PT);

  // Smooth path via Catmull-Rom → Bezier
  function smoothPath(pts) {
    if (pts.length < 2) return '';
    let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i-1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i+1];
      const p3 = pts[i+2] || p2;
      const tension = 0.5;
      const c1x = p1.x + (p2.x - p0.x) / 6 * tension;
      const c1y = p1.y + (p2.y - p0.y) / 6 * tension;
      const c2x = p2.x - (p3.x - p1.x) / 6 * tension;
      const c2y = p2.y - (p3.y - p1.y) / 6 * tension;
      d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    }
    return d;
  }
  const pts = data.map((p,i) => ({ x: xAt(i), y: yAt(p.val) }));
  const linePath = smoothPath(pts);
  const areaPath = linePath + ` L ${xAt(data.length-1).toFixed(2)} ${(H-PB).toFixed(2)} L ${xAt(0).toFixed(2)} ${(H-PB).toFixed(2)} Z`;

  // Y axis ticks (3 levels)
  const yTicks = [0, max/2, max].map(v => ({ v, y: yAt(v) }));

  el.innerHTML = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs>
      <linearGradient id="redGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#FF1830" stop-opacity=".55"/>
        <stop offset="100%" stop-color="#FF1830" stop-opacity="0"/>
      </linearGradient>
      <filter id="lineGlow" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="2.5" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    ${yTicks.map(t => `<line class="grid" x1="${PL}" x2="${W-PR}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}"/>`).join('')}
    ${yTicks.map(t => `<text class="label" x="${PL-8}" y="${(t.y+3).toFixed(1)}" text-anchor="end">${fmtMoney(t.v)}</text>`).join('')}
    <path class="area" d="${areaPath}"/>
    <path class="line" d="${linePath}" filter="url(#lineGlow)"/>
    <text class="label" x="${PL}" y="${H-8}">${data[0].label}</text>
    <text class="label" x="${W-PR}" y="${H-8}" text-anchor="end">${data[data.length-1].label}</text>
    <g class="hover-layer" style="display:none">
      <line class="hover-line" x1="0" x2="0" y1="${PT}" y2="${H-PB}"/>
      <circle class="hover-dot" r="5"/>
    </g>
    <rect class="hover-capture" x="${PL}" y="${PT}" width="${W-PL-PR}" height="${H-PT-PB}" fill="transparent" pointer-events="all"/>
  </svg>
  <div class="chart-tooltip" style="display:none"></div>`;

  // Hover interaction
  const svg = el.querySelector('svg');
  const tooltip = el.querySelector('.chart-tooltip');
  const hoverLayer = svg.querySelector('.hover-layer');
  const hoverLine = svg.querySelector('.hover-line');
  const hoverDot = svg.querySelector('.hover-dot');
  const capture = svg.querySelector('.hover-capture');
  capture.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const sx = (e.clientX - rect.left) * (W / rect.width);
    // find nearest data index
    const ratio = (sx - PL) / (W - PL - PR);
    const idx = Math.max(0, Math.min(data.length-1, Math.round(ratio * (data.length-1))));
    const p = data[idx];
    const px = xAt(idx), py = yAt(p.val);
    hoverLayer.style.display = '';
    hoverLine.setAttribute('x1', px); hoverLine.setAttribute('x2', px);
    hoverDot.setAttribute('cx', px); hoverDot.setAttribute('cy', py);
    tooltip.style.display = 'block';
    tooltip.innerHTML = `<div class="tt-d">${p.label}</div><div class="tt-v">${fmtMoney(p.val)}</div>${p.daily ? `<div class="tt-sub">+${fmtMoney(p.daily)} hoy</div>` : ''}`;
    // position tooltip in screen coords relative to chart container
    const ttX = (px / W) * rect.width;
    tooltip.style.left = `${Math.min(rect.width - 110, Math.max(0, ttX - 55))}px`;
    tooltip.style.top  = `${Math.max(0, (py / H) * rect.height - 50)}px`;
  });
  capture.addEventListener('mouseleave', () => {
    hoverLayer.style.display = 'none';
    tooltip.style.display = 'none';
  });
}
function weekKey(d) {
  // Lunes como inicio de semana. Devuelve 'YYYY-WNN' y la fecha del lunes.
  const dt = new Date(d); dt.setHours(0,0,0,0);
  const dow = (dt.getDay() + 6) % 7; // 0=lun
  dt.setDate(dt.getDate() - dow);
  const k = dt.toISOString().slice(0,10);
  return { key: k, monday: dt };
}

function drawWeeklyStacked() {
  const el = document.getElementById('chart-line'); if (!el) return;
  const cur = pedidosDash();
  if (cur.length === 0) { el.innerHTML = '<div class="loading muted">sin datos</div>'; return; }

  // Agrupar por semana y por canal
  const weeks = new Map(); // key -> { monday, byCat: {cat:val} }
  const cats = new Map(); // cat -> total (para ordenar)
  for (const p of cur) {
    const wk = weekKey(p.fecha);
    if (!weeks.has(wk.key)) weeks.set(wk.key, { monday: wk.monday, byCat: {} });
    const cat = (p.canalAd || '—').trim() || '—';
    const w = weeks.get(wk.key);
    const v = p.precio + p.precioDimmer;
    w.byCat[cat] = (w.byCat[cat] || 0) + v;
    cats.set(cat, (cats.get(cat) || 0) + v);
  }
  // Asegurar todas las semanas del rango (incluyendo vacías)
  const keys = Array.from(weeks.keys()).sort();
  if (keys.length > 1) {
    let cursor = new Date(keys[0]); const end = new Date(keys[keys.length-1]);
    while (cursor <= end) {
      const k = cursor.toISOString().slice(0,10);
      if (!weeks.has(k)) weeks.set(k, { monday: new Date(cursor), byCat: {} });
      cursor.setDate(cursor.getDate() + 7);
    }
  }
  const sortedKeys = Array.from(weeks.keys()).sort();
  const sortedCats = Array.from(cats.entries()).sort((a,b) => b[1]-a[1]).map(e => e[0]);
  const palette = ['#FF1830', '#8FD4DE', '#FFB84D', '#4ADE80', '#A78BFA', '#F472B6', '#5B5B6E'];
  const catColor = new Map(sortedCats.map((c,i) => [c, palette[i % palette.length]]));

  const W = el.clientWidth, H = 240, PL = 60, PR = 20, PT = 16, PB = 56;
  const innerW = W - PL - PR, innerH = H - PT - PB;
  const totals = sortedKeys.map(k => Object.values(weeks.get(k).byCat).reduce((a,b)=>a+b, 0));
  const max = Math.max(1, ...totals);
  const barW = Math.max(8, Math.min(48, (innerW / sortedKeys.length) * 0.7));
  const step = innerW / Math.max(1, sortedKeys.length);

  // Y ticks
  const yTicks = [0, max/2, max].map(v => ({ v, y: PT + innerH - (v / max) * innerH }));

  let bars = '';
  sortedKeys.forEach((k, i) => {
    const w = weeks.get(k);
    const cx = PL + step * i + step/2;
    const x = cx - barW/2;
    let acc = 0;
    let segs = '';
    sortedCats.forEach(cat => {
      const v = w.byCat[cat] || 0;
      if (v <= 0) return;
      const h = (v / max) * innerH;
      const yTop = PT + innerH - acc - h;
      segs += `<rect class="wk-seg" x="${x.toFixed(2)}" y="${yTop.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" fill="${catColor.get(cat)}" data-week="${k}" data-cat="${escapeHtml(cat)}" data-val="${v}"></rect>`;
      acc += h;
    });
    bars += segs;
  });

  // Labels: primer/medio/último
  const labelIdxs = sortedKeys.length <= 8
    ? sortedKeys.map((_,i) => i)
    : [0, Math.floor(sortedKeys.length/2), sortedKeys.length-1];
  const xLabels = labelIdxs.map(i => {
    const cx = PL + step * i + step/2;
    const md = weeks.get(sortedKeys[i]).monday;
    const lbl = `${String(md.getDate()).padStart(2,'0')}/${String(md.getMonth()+1).padStart(2,'0')}`;
    return `<text class="label" x="${cx.toFixed(1)}" y="${(H - PB + 16).toFixed(1)}" text-anchor="middle">${lbl}</text>`;
  }).join('');

  const legend = sortedCats.slice(0, 7).map(c => `<span class="lg-i"><span class="lg-d" style="background:${catColor.get(c)}"></span>${escapeHtml(c)}</span>`).join('');

  el.innerHTML = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${yTicks.map(t => `<line class="grid" x1="${PL}" x2="${W-PR}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}"/>`).join('')}
    ${yTicks.map(t => `<text class="label" x="${PL-8}" y="${(t.y+3).toFixed(1)}" text-anchor="end">${fmtMoney(t.v)}</text>`).join('')}
    ${bars}
    ${xLabels}
  </svg>
  <div class="chart-legend-row">${legend}</div>
  <div class="chart-tooltip" style="display:none"></div>`;

  const tooltip = el.querySelector('.chart-tooltip');
  el.querySelectorAll('.wk-seg').forEach(seg => {
    seg.addEventListener('mousemove', (e) => {
      const rect = el.getBoundingClientRect();
      const k = seg.dataset.week;
      const cat = seg.dataset.cat;
      const w = weeks.get(k);
      const val = w.byCat[cat] || 0;
      const total = Object.values(w.byCat).reduce((a,b)=>a+b,0);
      const pct = total ? Math.round(val / total * 100) : 0;
      const monday = w.monday;
      const sunday = new Date(monday); sunday.setDate(sunday.getDate()+6);
      tooltip.style.display = 'block';
      tooltip.innerHTML = `
        <div class="tt-d">${fmtDate(monday)} – ${fmtDate(sunday)}</div>
        <div class="tt-row" style="margin-top:4px"><span class="tt-dot" style="background:${catColor.get(cat)}"></span><span style="color:var(--fg)">${escapeHtml(cat)}</span></div>
        <div class="tt-v">${fmtMoney(val)}</div>
        <div class="tt-sub">${pct}% de la semana · total ${fmtMoney(total)}</div>`;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      tooltip.style.left = `${Math.min(rect.width - 220, Math.max(0, x - 110))}px`;
      tooltip.style.top  = `${Math.max(0, y - tooltip.offsetHeight - 12)}px`;
    });
    seg.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
  });
}

function drawDonut(canvasId, legendId, data, colors) {
  const el = document.getElementById(canvasId); if (!el) return;
  const total = data.reduce((a,b)=>a+b[1],0);
  if (total === 0) { el.innerHTML = '<div class="loading muted">sin datos</div>'; document.getElementById(legendId).innerHTML=''; return; }
  const W = el.clientWidth, H = 200, R = 70, cx = W/2, cy = H/2;
  let acc = 0;
  const arcs = data.map(([k,v], i) => {
    const len = (v / total) * 2 * Math.PI * R;
    const dash = `${len} ${2 * Math.PI * R}`;
    const offset = -acc;
    acc += len;
    return `<circle class="donut-cy" cx="${cx}" cy="${cy}" r="${R}" stroke="${colors[i % colors.length]}" stroke-dasharray="${dash}" stroke-dashoffset="${offset}"></circle>`;
  }).join('');
  el.innerHTML = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}">
    ${arcs}
    <text class="donut-center" x="${cx}" y="${cy-4}">${total}</text>
    <text x="${cx}" y="${cy+18}" class="label" text-anchor="middle">total</text>
  </svg>`;
  document.getElementById(legendId).innerHTML = data.map(([k,v],i) =>
    `<span class="lg-i"><span class="lg-d" style="background:${colors[i % colors.length]}"></span>${escapeHtml(k)} · <b>${v}</b></span>`
  ).join('');
}

// ---------- ACTIVIDAD ----------
let actFilter = { user: '', range: '7d' }; // range: 7d | 30d | all

async function loadActivity() {
  if (!CONFIG.trackerUrl) {
    STATE.activity = { rows: [], loading: false, error: 'Tracker no configurado. Pegá la URL del Worker en CONFIG.trackerUrl.' };
    render();
    return;
  }
  STATE.activity.loading = true; STATE.activity.error = null; render();
  try {
    const params = new URLSearchParams();
    if (actFilter.user) params.set('user', actFilter.user);
    if (actFilter.range !== 'all') {
      const days = actFilter.range === '7d' ? 7 : 30;
      const from = new Date(); from.setDate(from.getDate() - days);
      params.set('from', from.toISOString());
    }
    const r = await fetch(CONFIG.trackerUrl.replace(/\/$/, '') + '/report?' + params.toString());
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    STATE.activity = { rows: j.rows || [], loading: false, error: null };
  } catch (e) {
    STATE.activity = { rows: [], loading: false, error: e.message };
  }
  render();
}

function bindActividad() {
  document.querySelectorAll('[data-act-range]').forEach(b => b.onclick = () => { actFilter.range = b.dataset.actRange; loadActivity(); });
  document.querySelectorAll('[data-act-user]').forEach(b => b.onclick = () => { actFilter.user = b.dataset.actUser; loadActivity(); });
  if (!STATE.activity.rows.length && !STATE.activity.error && !STATE.activity.loading) loadActivity();
}

function renderActividad() {
  const { rows, loading, error } = STATE.activity;

  // Resumen por usuario
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user)) byUser.set(r.user, { total: 0, ppto: 0, pv: 0, last: null });
    const u = byUser.get(r.user);
    u.total++;
    if (r.item_kind === 'presupuesto') u.ppto++;
    else if (r.item_kind === 'postventa') u.pv++;
    if (!u.last || r.ts > u.last) u.last = r.ts;
  }

  // Heatmap por día (últimos N días)
  const days = actFilter.range === 'all' ? 30 : (actFilter.range === '7d' ? 7 : 30);
  const dayMap = new Map();
  for (const r of rows) {
    const k = r.ts.slice(0,10);
    dayMap.set(k, (dayMap.get(k) || 0) + 1);
  }
  const dayList = [];
  for (let i = days - 1; i >= 0; i--) {
    const dt = addDays(TODAY, -i);
    const k = dt.toISOString().slice(0,10);
    dayList.push({ date: dt, count: dayMap.get(k) || 0 });
  }
  const maxDay = Math.max(1, ...dayList.map(d => d.count));

  return `
    <div class="page-head">
      <div><div class="eyebrow">Tracking de seguimientos</div><h1>Actividad</h1></div>
      <div class="actions"><button class="btn btn-ghost" onclick="loadActivity()">↻ Recargar</button></div>
    </div>

    ${!CONFIG.trackerUrl ? `<div class="error" style="margin-bottom:var(--s-4)">
      Tracker remoto no configurado. Editá <code>assets/app.js</code> → <code>CONFIG.trackerUrl</code> con la URL del Worker.
    </div>` : ''}

    <div class="seg-filters" style="margin-bottom:var(--s-4)">
      <button class="ps-chip ${actFilter.range==='7d'?'active':''}" data-act-range="7d">Últimos 7 días</button>
      <button class="ps-chip ${actFilter.range==='30d'?'active':''}" data-act-range="30d">Últimos 30 días</button>
      <button class="ps-chip ${actFilter.range==='all'?'active':''}" data-act-range="all">Todo</button>
      <span style="width:1px;background:var(--border);margin:0 6px"></span>
      <button class="ps-chip ${actFilter.user===''?'active':''}" data-act-user="">Todos</button>
      ${STATE.users.map(u => `<button class="ps-chip ${actFilter.user===u?'active':''}" data-act-user="${escapeHtml(u)}">${escapeHtml(u)}</button>`).join('')}
    </div>

    ${loading ? '<div class="loading"><div class="spinner"></div></div>' : ''}
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}

    ${!loading && !error ? `
      <div class="kpi-grid">
        ${(byUser.size === 0
          ? '<div class="kpi"><div class="kpi-label">Sin actividad</div><div class="kpi-value" style="font-size:24px">—</div></div>'
          : Array.from(byUser.entries()).map(([user, u]) => `
            <div class="kpi">
              <div class="kpi-label">${escapeHtml(user)}</div>
              <div class="kpi-value">${u.total}</div>
              <div class="kpi-delta">${u.ppto} ppto · ${u.pv} post-venta · último ${fmtDoneAt(new Date(u.last))}</div>
            </div>
          `).join('')
        )}
      </div>

      <div class="card" style="margin-bottom:var(--s-5)">
        <div class="card-h"><h3>Actividad por día</h3></div>
        <div class="heatmap">
          ${dayList.map(d => {
            const intensity = d.count / maxDay;
            const op = d.count === 0 ? 0.05 : 0.2 + intensity * 0.8;
            return `<div class="hm-cell" style="background:rgba(255,24,48,${op})" title="${fmtDate(d.date)}: ${d.count}"></div>`;
          }).join('')}
        </div>
      </div>

      <div class="table-wrap">
        <div class="table-toolbar">
          <div>Eventos</div>
          <div class="right">${rows.length} filas</div>
        </div>
        ${rows.length === 0 ? '<div class="loading muted">Sin eventos en el rango seleccionado</div>' :
          `<table class="t">
            <thead><tr><th>Cuándo</th><th>Usuario</th><th>Tipo</th><th>Acción</th><th>Item</th></tr></thead>
            <tbody>
              ${rows.slice(0, 200).map(r => `<tr>
                <td class="num">${new Date(r.ts).toLocaleString('es-AR')}</td>
                <td class="cliente">${escapeHtml(r.user)}</td>
                <td>${r.item_kind === 'presupuesto' ? '<span class="pill cyan">PPTO</span>' : r.item_kind === 'postventa' ? '<span class="pill red">POST-V</span>' : '<span class="pill muted">—</span>'}</td>
                <td><span class="muted" style="font-size:12px">${escapeHtml(r.action)}</span></td>
                <td><span class="muted" style="font-size:11px">${escapeHtml(r.item_id || '')}</span></td>
              </tr>`).join('')}
            </tbody>
          </table>`}
      </div>
    ` : ''}
  `;
}
window.loadActivity = loadActivity;

// ---------- ADMIN ----------
let adminData = { rows: [], loading: false, error: null, range: '7d' };

async function loadAdminActivity() {
  if (!isAdmin()) { adminData.error = 'No autorizado'; render(); return; }
  adminData.loading = true; adminData.error = null; render();
  try {
    const params = new URLSearchParams({ user: 'Joaquín' });
    if (adminData.range !== 'all') {
      const days = adminData.range === '7d' ? 7 : 30;
      const from = new Date(); from.setDate(from.getDate() - days);
      params.set('from', from.toISOString());
    }
    const r = await fetch(CONFIG.trackerUrl.replace(/\/$/, '') + '/admin/activity?' + params.toString(), {
      headers: authHeaders()
    });
    if (r.status === 401) { saveToken(null); throw new Error('Sesión expirada — re-logueate'); }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    adminData = { rows: j.rows || [], loading: false, error: null, range: adminData.range };
  } catch (e) {
    adminData = { rows: [], loading: false, error: e.message, range: adminData.range };
  }
  render();
}

function bindAdmin() {
  document.querySelectorAll('[data-admin-range]').forEach(b => b.onclick = () => { adminData.range = b.dataset.adminRange; loadAdminActivity(); });
  if (!adminData.rows.length && !adminData.error && !adminData.loading && isAdmin()) loadAdminActivity();

  const saveBtn = document.querySelector('[data-cot-save]');
  if (saveBtn) saveBtn.onclick = async () => {
    const updates = {};
    document.querySelectorAll('[data-cot-param]').forEach(i => {
      const v = parseFloat(i.value);
      if (!isNaN(v)) updates[i.dataset.cotParam] = v;
    });
    const msg = document.getElementById('cot-save-msg');
    msg.textContent = 'guardando…';
    try {
      await saveCotizadorParams(updates);
      msg.textContent = '✓ guardado';
      msg.style.color = 'var(--success)';
      setTimeout(() => { msg.textContent = ''; }, 2000);
    } catch (e) {
      msg.textContent = '✗ error: ' + e.message;
      msg.style.color = 'var(--neon-red)';
    }
  };
  const resetBtn = document.querySelector('[data-cot-reset]');
  if (resetBtn) resetBtn.onclick = () => {
    if (!confirm('Resetear todos los parámetros a los valores originales?')) return;
    const defs = CONFIG.cotizadorDefaults;
    document.querySelectorAll('[data-cot-param]').forEach(i => {
      i.value = defs[i.dataset.cotParam];
    });
  };
}

function renderAdmin() {
  if (!isAdmin()) {
    return `<div class="page-head"><h1>Admin</h1></div><div class="error">No autorizado. Logueate como Gaspar.</div>`;
  }
  const { rows, loading, error, range } = adminData;
  const days = range === 'all' ? 30 : (range === '7d' ? 7 : 30);
  const periodStart = addDays(TODAY, -days);
  // Presupuestos enviados (del sheet) en el período
  const pptosEnviados = STATE.presupuestos.filter(p => p.fecha >= periodStart);
  // Acciones de seguimiento (del tracker)
  const accionesPpto = rows.filter(r => r.item_kind === 'presupuesto').length;
  const accionesPv   = rows.filter(r => r.item_kind === 'postventa').length;
  const dayMap = new Map();
  for (const r of rows) {
    const k = r.ts.slice(0,10);
    dayMap.set(k, (dayMap.get(k) || 0) + 1);
  }
  const dayList = [];
  for (let i = days - 1; i >= 0; i--) {
    const dt = addDays(TODAY, -i);
    const k = dt.toISOString().slice(0,10);
    dayList.push({ date: dt, count: dayMap.get(k) || 0 });
  }
  const maxDay = Math.max(1, ...dayList.map(d => d.count));

  return `
    <div class="page-head">
      <div><div class="eyebrow">Panel privado · solo Gaspar</div><h1>Admin</h1></div>
      <div class="actions"><button class="btn btn-ghost" onclick="loadAdminActivity()">↻ Recargar</button></div>
    </div>

    <div class="card" style="margin-bottom:var(--s-4)">
      <div class="card-h"><h3>Performance de Joaquín</h3></div>
      <div class="seg-filters" style="margin-bottom:var(--s-3)">
        <button class="ps-chip ${range==='7d'?'active':''}" data-admin-range="7d">7 días</button>
        <button class="ps-chip ${range==='30d'?'active':''}" data-admin-range="30d">30 días</button>
        <button class="ps-chip ${range==='all'?'active':''}" data-admin-range="all">Todo</button>
      </div>
      ${loading ? '<div class="loading"><div class="spinner"></div></div>' : ''}
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
      ${!loading && !error ? `
        <div class="kpi-grid" style="margin-bottom:var(--s-3)">
          <div class="kpi cyan"><div class="kpi-label">Presupuestos enviados</div><div class="kpi-value">${pptosEnviados.length}</div></div>
          <div class="kpi"><div class="kpi-label">Seguimientos hechos</div><div class="kpi-value">${accionesPpto}</div></div>
          <div class="kpi"><div class="kpi-label">Post-venta hechos</div><div class="kpi-value">${accionesPv}</div></div>
        </div>
        <div class="heatmap">
          ${dayList.map(d => {
            const intensity = d.count / maxDay;
            const op = d.count === 0 ? 0.05 : 0.2 + intensity * 0.8;
            return `<div class="hm-cell" style="background:rgba(143,212,222,${op})" title="${fmtDate(d.date)}: ${d.count}"></div>`;
          }).join('')}
        </div>
        ${rows.length === 0 ? '<div class="loading muted" style="padding:24px">Sin actividad de seguimientos en este rango</div>' :
          `<details style="margin-top:var(--s-3)"><summary style="cursor:pointer;font-family:var(--font-mono);font-size:11px;color:var(--fg-subtle);letter-spacing:var(--tr-wide);text-transform:uppercase">Ver eventos detallados (${rows.length})</summary>
            <table class="t" style="margin-top:var(--s-2)">
              <thead><tr><th>Cuándo</th><th>Tipo</th><th>Acción</th></tr></thead>
              <tbody>${rows.slice(0,100).map(r => `<tr>
                <td class="num">${new Date(r.ts).toLocaleString('es-AR')}</td>
                <td>${r.item_kind === 'presupuesto' ? '<span class="pill cyan">PPTO</span>' : '<span class="pill red">POST-V</span>'}</td>
                <td><span class="muted" style="font-size:12px">${escapeHtml(r.action)}</span></td>
              </tr>`).join('')}</tbody>
            </table>
          </details>`
        }
      ` : ''}
    </div>

    ${renderAdminCotizador()}

    <div class="card admin-soon">
      <div class="card-h"><h3>Próximamente</h3></div>
      <div class="muted" style="display:grid;grid-template-columns:1fr 1fr;gap:var(--s-3);font-size:13px">
        <div>📊 Costos y margen real por pedido</div>
        <div>💰 Comisiones acumuladas a pagar</div>
        <div>📝 Notas privadas por cliente</div>
        <div>📧 Reporte semanal automático</div>
      </div>
    </div>
  `;
}

const COT_PARAM_GROUPS = [
  { title: 'Mapping (sheet)', keys: [
    ['neon', 'Precio neón (mt)'],
    ['trans', 'Precio acrílico transparente (m²)'],
    ['negro', 'Precio negro (m²)'],
    ['fuentes_1a', 'Fuente · neón ≤ 2 mt'],
    ['fuentes_3a', 'Fuente · 2-6 mt'],
    ['fuentes_5a', 'Fuente · 6-9 mt'],
    ['fuentes_10a', 'Fuente · 9-30 mt']
  ]},
  { title: 'Tier por m²', keys: [
    ['tier_25', 'm² ≤ 25'],
    ['tier_50', 'm² ≤ 50'],
    ['tier_99', 'm² > 50']
  ]},
  { title: 'Extra por exterior (EXT)', keys: [
    ['ext_25', 'm² ≤ 25'],
    ['ext_50', 'm² ≤ 50'],
    ['ext_99', 'm² > 50']
  ]},
  { title: 'Multiplicadores', keys: [
    ['reventa_mult', 'Reventa × trans'],
    ['comision_pct', 'Comisión (decimal: 0.05 = 5%)'],
    ['descuento_mult', 'Descuento × trans'],
    ['descuento_min_m2', 'Descuento aplica si m² >'],
    ['recargo_5', 'Recargo (m² ≤ 5) ×'],
    ['recargo_125', 'Recargo (m² ≤ 12.5) ×'],
    ['recargo_25', 'Recargo (m² < 25) ×']
  ]}
];

function renderAdminCotizador() {
  const p = getCotizadorParams();
  return `
    <div class="card" style="margin-bottom:var(--s-4)">
      <div class="card-h">
        <h3>Parámetros del cotizador</h3>
        <span class="muted" style="font-size:11px">${STATE.cotizadorParams ? 'sincronizado · D1' : 'usando valores por defecto'}</span>
      </div>
      ${COT_PARAM_GROUPS.map(g => `
        <div class="cot-params-group">
          <div class="cot-params-title">${g.title}</div>
          <div class="cot-params-grid">
            ${g.keys.map(([k, label]) => `
              <label class="cot-param">
                <span>${escapeHtml(label)}</span>
                <input type="number" step="any" data-cot-param="${k}" value="${p[k]}">
              </label>
            `).join('')}
          </div>
        </div>
      `).join('')}
      <div class="seg-actions" style="margin-top:var(--s-3)">
        <button class="btn btn-primary" data-cot-save>💾 Guardar</button>
        <button class="btn btn-ghost" data-cot-reset>Resetear a defaults</button>
        <span id="cot-save-msg" class="muted" style="font-size:12px"></span>
      </div>
    </div>
  `;
}
window.loadAdminActivity = loadAdminActivity;

// ---------- COMMON ----------
function bindNav() {
  document.querySelectorAll('.nav-item').forEach(b => b.onclick = () => setView(b.dataset.view));
  document.querySelectorAll('[data-set-user]').forEach(b => b.onclick = () => setUser(b.dataset.setUser));
  const addBtn = document.querySelector('[data-add-user]');
  if (addBtn) addBtn.onclick = () => addUser();
  const logoutBtn = document.querySelector('[data-logout]');
  if (logoutBtn) logoutBtn.onclick = () => logout();
}
function bindCommon() {
  document.querySelectorAll('[data-action="seg-cliente"]').forEach(b => b.onclick = () => {
    pedidoFilter.search = b.dataset.cliente;
    setView('pedidos');
  });
  document.querySelectorAll('[data-period]').forEach(b => b.onclick = () => {
    if (b.dataset.period === 'all') setDashAll();
    else setDashCurrent();
  });
  document.querySelectorAll('[data-period-m]').forEach(b => b.onclick = () => toggleDashMonth(b.dataset.periodM));
  document.querySelectorAll('[data-chart-nav]').forEach(b => b.onclick = () => {
    const dir = b.dataset.chartNav === 'next' ? 1 : -1;
    STATE.dashChartIdx = (STATE.dashChartIdx + dir + DASH_CHARTS.length) % DASH_CHARTS.length;
    render();
  });
  document.querySelectorAll('[data-chart-idx]').forEach(d => d.onclick = () => {
    STATE.dashChartIdx = parseInt(d.dataset.chartIdx);
    render();
  });
}

function uniq(arr) { return Array.from(new Set(arr)); }
function toast(msg) {
  const t = document.getElementById('toast'); if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(window.__tt); window.__tt = setTimeout(()=>t.classList.remove('show'), 1800);
}

// ============ CHAT WHATSAPP ============
const chatState = {
  contacts: [],       // [{phone, name, lastMsg, lastTs, unread, lastInboundTs}]
  messages: [],       // mensajes del contacto seleccionado
  selectedPhone: null,
  selectedName: '',
  loading: false,
  loadingConv: false,
  sending: false,
  search: '',
  pollTimer: null,
  profilePics: {},
  picLoading: new Set(),
  readCursors: {},
  totalUnread: 0,
  // New features
  quickReplies: [],   // [{id, shortcut, body}]
  qrLoaded: false,
  labels: [],         // [{id, name, color}]
  contactLabels: {},  // phone → [label_id, ...]
  labelsLoaded: false,
  filterLabels: [],   // active label filters (array of label_ids)
  recording: false,
  mediaRecorder: null,
  audioChunks: [],
  recordingTimer: null,
  recordingSecs: 0,
};

// Avatar color palettes [base, accent] — 25 distinct hues for maximum differentiation
const AVATAR_PALETTES = [
  ['#00a884','#02c39a'], // teal
  ['#53bdeb','#73cdf0'], // sky blue
  ['#cd7f32','#d99545'], // bronze
  ['#ef5350','#f47370'], // coral red
  ['#7986cb','#949fd6'], // soft indigo
  ['#e06090','#e87aa5'], // rose pink
  ['#009688','#1aafa0'], // deep teal
  ['#7e57c2','#9574d0'], // amethyst
  ['#ff7043','#ff8f6a'], // terracotta
  ['#26a69a','#40b5aa'], // mint
  ['#5c6bc0','#7580cc'], // slate blue
  ['#8d6e63','#a08478'], // mocha
  ['#d4e157','#dce775'], // lime
  ['#ff8a65','#ffab91'], // peach
  ['#4db6ac','#6ec5bb'], // aquamarine
  ['#ba68c8','#c882d4'], // orchid
  ['#4dd0e1','#6ddae8'], // cyan
  ['#f06292','#f48aac'], // hot pink
  ['#aed581','#bee09a'], // sage
  ['#ffb74d','#ffc877'], // amber
  ['#9575cd','#ad91db'], // lavender
  ['#4fc3f7','#75d0f9'], // light blue
  ['#e57373','#ec9191'], // salmon
  ['#81c784','#9dd49f'], // green
  ['#dce775','#e4ee8d'], // yellow-green
];

function getAvatarPalette(phone) {
  let hash = 0;
  for (let i = 0; i < phone.length; i++) hash = ((hash << 5) - hash) + phone.charCodeAt(i);
  return AVATAR_PALETTES[Math.abs(hash) % AVATAR_PALETTES.length];
}

function getInitials(name, phone) {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/).filter(p => p.length > 0);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0].substring(0, 2).toUpperCase();
  }
  return phone.slice(-2);
}

// WhatsApp Web default person silhouette
const WA_PERSON_SVG = '<svg viewBox="0 0 212 212" width="60%" height="60%"><path fill="rgba(255,255,255,0.85)" d="M106.251 0C47.624 0 0 47.624 0 106.251s47.624 106.251 106.251 106.251 106.251-47.624 106.251-106.251S164.878 0 106.251 0zm0 28.07c23.399 0 42.364 18.966 42.364 42.364 0 23.399-18.966 42.364-42.364 42.364-23.399 0-42.364-18.966-42.364-42.364 0-23.399 18.965-42.364 42.364-42.364zm0 150.87c-26.466 0-49.921-13.513-63.612-34.025.328-21.078 42.408-32.64 63.612-32.64 21.204 0 63.284 11.562 63.612 32.64-13.691 20.512-37.146 34.025-63.612 34.025z"/></svg>';

function avatarHtml(phone, name, size) {
  const s = size || 49;
  const pal = getAvatarPalette(phone);
  const initials = getInitials(name, phone);
  const fontSize = s <= 40 ? 15 : s <= 49 ? 19 : 24;
  const hasName = name && name.trim().length > 0;
  const bg = `background:linear-gradient(135deg,${pal[0]} 0%,${pal[1]} 100%)`;

  if (hasName) {
    return `<div class="chat-avatar" style="width:${s}px;height:${s}px;${bg}"><span class="chat-avatar-text" style="font-size:${fontSize}px">${initials}</span></div>`;
  }
  return `<div class="chat-avatar" style="width:${s}px;height:${s}px;${bg}"><div class="chat-avatar-icon">${WA_PERSON_SVG}</div></div>`;
}

function loadProfilePic(phone) {
  if (!chatState.profilePics[phone]) chatState.profilePics[phone] = 'none';
}

// ===== Quick Replies =====
async function loadQuickReplies() {
  if (chatState.qrLoaded) return;
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/quick-replies', { headers: authHeaders() });
    if (r.ok) { const j = await r.json(); chatState.quickReplies = j.replies || []; chatState.qrLoaded = true; }
  } catch (_) {}
}
async function saveQuickReply(shortcut, body) {
  await fetch(CONFIG.trackerUrl + '/admin/quick-replies', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ shortcut, body })
  });
  chatState.qrLoaded = false;
  await loadQuickReplies();
}
async function deleteQuickReply(id) {
  await fetch(CONFIG.trackerUrl + '/admin/quick-replies/' + id, { method: 'DELETE', headers: authHeaders() });
  chatState.quickReplies = chatState.quickReplies.filter(q => q.id !== id);
}

// ===== Labels =====
async function loadLabels() {
  if (chatState.labelsLoaded) return;
  try {
    const [lr, clr] = await Promise.all([
      fetch(CONFIG.trackerUrl + '/admin/labels', { headers: authHeaders() }),
      fetch(CONFIG.trackerUrl + '/admin/contact-labels', { headers: authHeaders() })
    ]);
    if (lr.ok) { const j = await lr.json(); chatState.labels = j.labels || []; }
    if (clr.ok) { const j = await clr.json(); chatState.contactLabels = j.contactLabels || {}; }
    chatState.labelsLoaded = true;
  } catch (_) {}
}
async function saveLabel(name, color) {
  const r = await fetch(CONFIG.trackerUrl + '/admin/labels', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ name, color })
  });
  const j = await r.json();
  chatState.labelsLoaded = false;
  await loadLabels();
  return j.id;
}
async function deleteLabel(id) {
  await fetch(CONFIG.trackerUrl + '/admin/labels/' + id, { method: 'DELETE', headers: authHeaders() });
  chatState.labels = chatState.labels.filter(l => l.id !== id);
  for (const ph of Object.keys(chatState.contactLabels)) {
    chatState.contactLabels[ph] = chatState.contactLabels[ph].filter(lid => lid !== id);
  }
}
async function toggleContactLabel(phone, labelId) {
  const current = chatState.contactLabels[phone] || [];
  if (current.includes(labelId)) {
    await fetch(CONFIG.trackerUrl + '/admin/contact-labels', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ phone, label_id: labelId })
    });
    chatState.contactLabels[phone] = current.filter(id => id !== labelId);
  } else {
    await fetch(CONFIG.trackerUrl + '/admin/contact-labels', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ phone, label_id: labelId })
    });
    if (!chatState.contactLabels[phone]) chatState.contactLabels[phone] = [];
    chatState.contactLabels[phone].push(labelId);
  }
}

// ===== Send media =====
async function sendChatImage(phone, file, caption) {
  if (!phone || !file) return;
  chatState.sending = true;
  updateChatInputState();
  try {
    const fd = new FormData();
    fd.append('to', phone);
    fd.append('type', 'image');
    fd.append('caption', caption || '');
    fd.append('file', file);
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/send-media', {
      method: 'POST', headers: authHeaders(), body: fd
    });
    const j = await r.json();
    if (!r.ok) { toast('Error: ' + (j.error || 'fallo envío imagen')); return; }
    chatState.messages.push({
      ts: new Date().toISOString(), wamid: j.id || '', direction: 'outbound',
      phone, sender_name: '', msg_type: 'image', body: caption || '[imagen]',
      media_url: j.r2Key || '', status: 'sent'
    });
    renderChatMessages();
    toast('Imagen enviada');
  } catch (e) { toast('Error de red'); }
  finally { chatState.sending = false; updateChatInputState(); }
}

async function sendChatAudio(phone, blob) {
  if (!phone || !blob) return;
  chatState.sending = true;
  updateChatInputState();
  try {
    const fd = new FormData();
    fd.append('to', phone);
    fd.append('type', 'audio');
    fd.append('file', blob, 'audio.ogg');
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/send-media', {
      method: 'POST', headers: authHeaders(), body: fd
    });
    const j = await r.json();
    if (!r.ok) { toast('Error: ' + (j.error || 'fallo envío audio')); return; }
    chatState.messages.push({
      ts: new Date().toISOString(), wamid: j.id || '', direction: 'outbound',
      phone, sender_name: '', msg_type: 'audio', body: '[audio]',
      media_url: j.r2Key || '', status: 'sent'
    });
    renderChatMessages();
    toast('Audio enviado');
  } catch (e) { toast('Error de red'); }
  finally { chatState.sending = false; updateChatInputState(); }
}

// ===== Audio recording =====
function startRecording(phone) {
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    chatState.recording = true;
    chatState.audioChunks = [];
    chatState.recordingSecs = 0;
    const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    chatState.mediaRecorder = mr;
    mr.ondataavailable = e => { if (e.data.size > 0) chatState.audioChunks.push(e.data); };
    mr.onstop = () => { stream.getTracks().forEach(t => t.stop()); };
    mr.start();
    chatState.recordingTimer = setInterval(() => {
      chatState.recordingSecs++;
      const el = document.getElementById('rec-timer');
      if (el) el.textContent = Math.floor(chatState.recordingSecs / 60) + ':' + String(chatState.recordingSecs % 60).padStart(2, '0');
    }, 1000);
    renderRecordingUI();
  }).catch(() => toast('No se pudo acceder al micrófono'));
}

function cancelRecording() {
  if (chatState.mediaRecorder && chatState.mediaRecorder.state !== 'inactive') chatState.mediaRecorder.stop();
  chatState.recording = false;
  chatState.audioChunks = [];
  clearInterval(chatState.recordingTimer);
  renderNormalInputUI();
}

function stopAndSendRecording(phone) {
  if (!chatState.mediaRecorder) return;
  chatState.mediaRecorder.onstop = () => {
    chatState.mediaRecorder.stream?.getTracks().forEach(t => t.stop());
    const blob = new Blob(chatState.audioChunks, { type: 'audio/webm;codecs=opus' });
    chatState.recording = false;
    chatState.audioChunks = [];
    clearInterval(chatState.recordingTimer);
    renderNormalInputUI();
    if (blob.size > 0) sendChatAudio(phone, blob);
  };
  chatState.mediaRecorder.stop();
}

function renderRecordingUI() {
  const bar = document.querySelector('.chat-input-bar');
  if (!bar) return;
  bar.innerHTML = `
    <button class="btn-send" id="rec-cancel" title="Cancelar" style="color:#ef5350"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
    <div class="rec-indicator"><span class="rec-dot"></span><span id="rec-timer">0:00</span></div>
    <button class="btn-send" id="rec-send" title="Enviar audio" style="color:#00a884"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M1.101 21.757L23.8 12.028 1.101 2.3l.011 7.912 13.239 1.816-13.239 1.817-.011 7.912z"/></svg></button>
  `;
  document.getElementById('rec-cancel').onclick = cancelRecording;
  document.getElementById('rec-send').onclick = () => stopAndSendRecording(chatState.selectedPhone);
}

function renderNormalInputUI() {
  const bar = document.querySelector('.chat-input-bar');
  if (!bar) return;
  bar.innerHTML = `
    <button class="btn-send btn-attach" id="btn-attach" title="Adjuntar imagen"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M1.816 15.556v.002c0 1.502.584 2.912 1.646 3.972s2.472 1.647 3.974 1.647a5.58 5.58 0 003.972-1.645l9.547-9.548c.769-.768 1.147-1.767 1.058-2.817-.079-.968-.548-1.927-1.319-2.698-1.594-1.592-4.068-1.711-5.517-.262l-7.916 7.915c-.881.881-.792 2.25.214 3.261.501.501 1.134.79 1.737.79.558 0 1.031-.224 1.37-.564l5.582-5.58a.747.747 0 10-1.055-1.06l-5.58 5.58c-.172.172-.42.156-.614-.04-.508-.51-.427-1.122-.07-1.478l7.916-7.916c.866-.866 2.358-.764 3.46.34.556.557.876 1.203.918 1.818.036.526-.176 1.047-.595 1.466L10.11 18.526a4.09 4.09 0 01-2.913 1.205 4.09 4.09 0 01-2.913-1.205 4.09 4.09 0 01-1.205-2.913c0-1.1.428-2.134 1.205-2.911l8.647-8.646a.747.747 0 00-1.055-1.06l-8.647 8.646A5.58 5.58 0 001.816 15.556z"/></svg></button>
    <input type="file" id="chat-file-input" accept="image/*" style="display:none">
    <textarea id="chat-input" placeholder="Escribí un mensaje" rows="1"></textarea>
    <button class="btn-send" id="chat-send-btn" ${chatState.sending ? 'disabled' : ''} title="Enviar"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M1.101 21.757L23.8 12.028 1.101 2.3l.011 7.912 13.239 1.816-13.239 1.817-.011 7.912z"/></svg></button>
    <button class="btn-send btn-mic" id="btn-mic" title="Grabar audio"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M11.999 14.942c2.001 0 3.531-1.53 3.531-3.531V4.35c0-2.001-1.53-3.531-3.531-3.531S8.469 2.35 8.469 4.35v7.061c0 2.001 1.53 3.531 3.53 3.531zm6.238-3.53c0 3.531-2.942 6.002-6.238 6.002s-6.238-2.471-6.238-6.002H4.761c0 3.885 3.118 7.061 7.003 7.414v3.174h.471v-3.174c3.885-.353 7.003-3.529 7.003-7.414h-1z"/></svg></button>
  `;
  bindChatConversation();
}

// ===== Bulk messaging =====
async function sendBulkMessage(labelIds, message) {
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/send-bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ label_ids: labelIds, message })
    });
    const j = await r.json();
    if (!r.ok) { toast('Error: ' + (j.error || 'fallo')); return j; }
    toast(`Enviados: ${j.sent} | Fallidos: ${j.failed}`);
    return j;
  } catch (e) { toast('Error de red'); return null; }
}

// SVG tick icons (WA-style)
const TICK_SINGLE = `<svg viewBox="0 0 16 11"><path d="M11.071.653a.457.457 0 0 0-.304-.102.493.493 0 0 0-.381.178l-6.19 7.636-2.011-2.585a.463.463 0 0 0-.36-.186.465.465 0 0 0-.344.153.52.52 0 0 0-.132.382.516.516 0 0 0 .159.375l2.323 2.995a.478.478 0 0 0 .353.168.467.467 0 0 0 .363-.169l6.571-8.102a.482.482 0 0 0-.047-.743z" fill="currentColor"/></svg>`;
const TICK_DOUBLE = `<svg viewBox="0 0 16 11"><path d="M11.071.653a.457.457 0 0 0-.304-.102.493.493 0 0 0-.381.178l-6.19 7.636-2.011-2.585a.463.463 0 0 0-.36-.186.465.465 0 0 0-.344.153.52.52 0 0 0-.132.382.516.516 0 0 0 .159.375l2.323 2.995a.478.478 0 0 0 .353.168.467.467 0 0 0 .363-.169l6.571-8.102a.482.482 0 0 0-.047-.743z" fill="currentColor"/><path d="M15.071.653a.457.457 0 0 0-.304-.102.493.493 0 0 0-.381.178l-6.19 7.636-1.2-1.546-.361.446 1.244 1.605a.478.478 0 0 0 .353.168.467.467 0 0 0 .363-.169l6.571-8.102a.482.482 0 0 0-.047-.743z" fill="currentColor"/></svg>`;

async function loadReadCursors() {
  if (!isAdmin()) return;
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/read-cursors', { headers: authHeaders() });
    if (r.ok) {
      const j = await r.json();
      chatState.readCursors = j.cursors || {};
    }
  } catch (_) {}
}

async function markConversationRead(phone) {
  if (!phone) return;
  const now = new Date().toISOString();
  chatState.readCursors[phone] = now;
  // Update contact unread count locally
  const c = chatState.contacts.find(ct => ct.phone === phone);
  if (c) c.unread = 0;
  updateUnreadBadge();
  // Persist to server (fire and forget)
  fetch(CONFIG.trackerUrl + '/admin/wa/mark-read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ phone, ts: now })
  }).catch(() => {});
}

function countUnread(phone, messages) {
  const cursor = chatState.readCursors[phone];
  if (!cursor) {
    // Never opened: count all inbound
    return messages.filter(m => m.direction === 'inbound').length;
  }
  return messages.filter(m => m.direction === 'inbound' && m.ts > cursor).length;
}

function updateUnreadBadge() {
  chatState.totalUnread = chatState.contacts.reduce((sum, c) => sum + (c.unread || 0), 0);
  // Update nav badge
  const badge = document.querySelector('[data-chat-badge]');
  if (badge) {
    badge.textContent = chatState.totalUnread || '';
    badge.style.display = chatState.totalUnread ? '' : 'none';
  }
}

async function loadChatContacts() {
  if (!isAdmin()) return;
  chatState.loading = true;
  try {
    // Load read cursors in parallel with messages on first load
    if (!Object.keys(chatState.readCursors).length) {
      await loadReadCursors();
    }
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/messages?limit=5000', {
      headers: authHeaders()
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const msgs = j.messages || [];
    // Agrupar por teléfono
    const byPhone = new Map();
    for (const m of msgs) {
      if (!m.phone || m.msg_type === 'status') continue;
      if (!byPhone.has(m.phone)) {
        byPhone.set(m.phone, { phone: m.phone, name: m.sender_name || '', messages: [], lastTs: m.ts });
      }
      const c = byPhone.get(m.phone);
      c.messages.push(m);
      if (m.sender_name && !c.name) c.name = m.sender_name;
      if (m.ts > c.lastTs) c.lastTs = m.ts;
    }
    // Ordenar contactos por último mensaje
    chatState.contacts = Array.from(byPhone.values())
      .map(c => {
        c.messages.sort((a, b) => a.ts.localeCompare(b.ts));
        const last = c.messages[c.messages.length - 1];
        const unread = countUnread(c.phone, c.messages);
        return {
          phone: c.phone,
          name: c.name,
          lastMsg: last ? (last.body || `[${last.msg_type}]`).slice(0, 60) : '',
          lastTs: c.lastTs,
          lastDir: last ? last.direction : '',
          lastType: last ? last.msg_type : '',
          unread
        };
      })
      .sort((a, b) => b.lastTs.localeCompare(a.lastTs));
    // Si hay contacto seleccionado, actualizar sus mensajes
    if (chatState.selectedPhone) {
      const c = byPhone.get(chatState.selectedPhone);
      chatState.messages = c ? c.messages : [];
    }
    updateUnreadBadge();
  } catch (e) {
    console.error('chat load error:', e);
  } finally {
    chatState.loading = false;
  }
}

async function loadChatMessages(phone) {
  if (!isAdmin() || !phone) return;
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/messages?phone=' + encodeURIComponent(phone) + '&limit=500', {
      headers: authHeaders()
    });
    if (!r.ok) return;
    const j = await r.json();
    chatState.messages = (j.messages || []).filter(m => m.msg_type !== 'status').sort((a, b) => a.ts.localeCompare(b.ts));
  } catch (e) {
    console.error('chat messages error:', e);
  }
}

async function sendChatMessage(phone, text) {
  if (!isAdmin() || !phone || !text.trim()) return;
  chatState.sending = true;
  updateChatInputState();
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ to: phone, body: text.trim() })
    });
    const j = await r.json();
    if (!r.ok) {
      toast('Error: ' + (j.error || 'no se pudo enviar'));
      return;
    }
    // Agregar mensaje local para feedback inmediato
    chatState.messages.push({
      ts: new Date().toISOString(),
      wamid: j.id || '',
      direction: 'outbound',
      phone: phone,
      sender_name: '',
      msg_type: 'text',
      body: text.trim(),
      status: 'sent'
    });
    renderChatMessages();
    // Limpiar input
    const ta = document.getElementById('chat-input');
    if (ta) { ta.value = ''; ta.style.height = 'auto'; }
    toast('Mensaje enviado');
  } catch (e) {
    toast('Error de red al enviar');
  } finally {
    chatState.sending = false;
    updateChatInputState();
  }
}

function updateChatInputState() {
  const btn = document.getElementById('chat-send-btn');
  if (btn) btn.disabled = chatState.sending;
}

function formatChatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const msgDate = ts.slice(0, 10);
  const time = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  if (msgDate === today) return time;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (msgDate === yesterday.toISOString().slice(0, 10)) return 'Ayer';
  // Same week: show day name
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays < 7) return d.toLocaleDateString('es-AR', { weekday: 'short' });
  return d.toLocaleDateString('es-AR', { day: 'numeric', month: 'numeric', year: '2-digit' });
}

function formatChatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const msgDate = ts.slice(0, 10);
  if (msgDate === today) return 'Hoy';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (msgDate === yesterday.toISOString().slice(0, 10)) return 'Ayer';
  return d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
}

function formatPhoneDisplay(phone) {
  if (!phone) return '';
  // 549XXXXXXXXXX → +54 9 XX XXXX-XXXX
  const s = String(phone);
  if (s.startsWith('549') && s.length >= 12) {
    const area = s.slice(3, 5);
    const rest = s.slice(5);
    return `+54 9 ${area} ${rest.slice(0, 4)}-${rest.slice(4)}`;
  }
  return '+' + s;
}

function renderContactLabelChips(phone) {
  const ids = chatState.contactLabels[phone] || [];
  if (!ids.length) return '';
  return ids.map(id => {
    const l = chatState.labels.find(lb => lb.id === id);
    if (!l) return '';
    return `<span class="label-chip" style="background:${l.color}">${escapeHtml(l.name)}</span>`;
  }).join('');
}

function renderLabelFilterBar() {
  if (!chatState.labels.length) return '';
  return `<div class="label-filter-bar" id="label-filter-bar">
    ${chatState.labels.map(l => {
      const active = chatState.filterLabels.includes(l.id);
      return `<button class="label-filter-chip${active ? ' active' : ''}" data-label-id="${l.id}" style="--lc:${l.color}">${escapeHtml(l.name)}</button>`;
    }).join('')}
    ${chatState.filterLabels.length ? `<button class="label-filter-clear" id="clear-label-filter">Limpiar</button>` : ''}
  </div>`;
}

function renderBulkSection() {
  return `<div class="bulk-section" id="bulk-section" style="display:none">
    <div class="bulk-header">
      <h4>Mensaje masivo</h4>
      <button class="btn-send" id="bulk-close" style="font-size:18px;width:28px;height:28px">&times;</button>
    </div>
    <div class="bulk-labels" id="bulk-labels">
      <p style="color:#8696a0;font-size:13px;margin-bottom:6px">Enviar a contactos con etiqueta:</p>
      ${chatState.labels.map(l => `<label class="bulk-label-check"><input type="checkbox" value="${l.id}" class="bulk-label-cb"><span class="label-chip" style="background:${l.color}">${escapeHtml(l.name)}</span></label>`).join('')}
    </div>
    <div id="bulk-count" style="color:#8696a0;font-size:12px;margin:6px 0"></div>
    <textarea id="bulk-msg" placeholder="Escribí el mensaje..." rows="3" class="bulk-textarea"></textarea>
    <button class="btn btn-primary" id="bulk-send-btn" style="margin-top:8px;width:100%">Enviar masivo</button>
    <div id="bulk-result" style="margin-top:6px;font-size:13px"></div>
  </div>`;
}

function renderChat() {
  if (!isAdmin()) {
    return `<div class="page-head"><h1>Chat WhatsApp</h1></div><div class="error">No autorizado. Logueate como Gaspar.</div>`;
  }
  const search = chatState.search.toLowerCase();
  let filtered = chatState.contacts;
  if (search) {
    filtered = filtered.filter(c =>
      (c.name || '').toLowerCase().includes(search) ||
      c.phone.includes(search) ||
      (c.lastMsg || '').toLowerCase().includes(search));
  }
  // Filter by labels
  if (chatState.filterLabels.length) {
    filtered = filtered.filter(c => {
      const cLabels = chatState.contactLabels[c.phone] || [];
      return chatState.filterLabels.every(lid => cLabels.includes(lid));
    });
  }

  return `
    <div class="chat-layout">
      <div class="chat-contacts">
        <div class="chat-contacts-header">
          <div class="my-avatar"></div>
          <div style="display:flex;gap:4px">
            <button class="btn-send" id="btn-bulk" style="width:34px;height:34px;font-size:14px" title="Mensaje masivo">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/><path d="M7 9h2v2H7zM11 9h2v2h-2zM15 9h2v2h-2z"/></svg>
            </button>
            <button class="btn-send" id="btn-manage-labels" style="width:34px;height:34px;font-size:14px" title="Gestionar etiquetas">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16z"/></svg>
            </button>
            <button class="btn-send" id="btn-manage-qr" style="width:34px;height:34px;font-size:14px" title="Respuestas rápidas">/ </button>
            <button class="btn-send" id="chat-refresh" style="width:34px;height:34px;font-size:16px" title="Actualizar">↻</button>
          </div>
        </div>
        <div class="chat-contacts-search">
          <input type="text" id="chat-search" placeholder="Buscar o empezar un chat nuevo" value="${escapeHtml(chatState.search)}">
        </div>
        ${renderLabelFilterBar()}
        <div class="chat-contact-list" id="chat-contact-list">
          ${chatState.loading && !chatState.contacts.length ? '<div style="padding:30px;text-align:center"><div class="spinner" style="border-color:#2a3942;border-top-color:#00a884"></div></div>' : ''}
          ${filtered.map(c => renderContactItem(c)).join('')}
          ${!chatState.loading && !filtered.length ? '<div style="padding:30px;text-align:center;color:#8696a0;font-size:14px">Sin conversaciones</div>' : ''}
        </div>
        ${renderBulkSection()}
      </div>
      <div class="chat-main">
        ${chatState.selectedPhone ? renderChatConversation() : renderChatNoSelect()}
      </div>
    </div>
  `;
}

function renderContactItem(c) {
  loadProfilePic(c.phone);
  // Preview icons
  let previewIcon = '';
  if (c.lastDir === 'outbound') {
    previewIcon = `<span class="chat-msg-status" style="margin-right:2px;color:#8696a0">${TICK_DOUBLE}</span>`;
  }
  // Clean preview
  let preview = c.lastMsg || '';
  if (preview.startsWith('[audio]')) preview = '🎤 Audio';
  else if (preview.startsWith('[imagen]')) preview = '📷 Foto';
  else if (c.lastType === 'sticker') preview = '🏷 Sticker';
  else if (c.lastType === 'video') preview = '🎥 Video';
  else if (c.lastType === 'document') preview = '📄 ' + preview;

  const hasUnread = (c.unread || 0) > 0;
  const isActive = chatState.selectedPhone === c.phone;

  return `
    <div class="chat-contact ${isActive ? 'active' : ''}${hasUnread ? ' has-unread' : ''}" data-chat-phone="${escapeHtml(c.phone)}">
      ${avatarHtml(c.phone, c.name, 49)}
      <div class="chat-contact-info">
        <div class="chat-contact-top">
          <div class="chat-contact-name">${escapeHtml(c.name || formatPhoneDisplay(c.phone))}</div>
          <div class="chat-contact-time${hasUnread ? ' unread' : ''}">${formatChatTime(c.lastTs)}</div>
        </div>
        <div class="chat-contact-bottom">
          <div class="chat-contact-preview">${previewIcon}${escapeHtml(preview)}</div>
          <div style="display:flex;align-items:center;gap:4px">
            ${renderContactLabelChips(c.phone)}
            ${hasUnread ? `<div class="chat-contact-unread">${c.unread}</div>` : ''}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderChatNoSelect() {
  return `
    <div class="chat-no-select">
      <svg viewBox="0 0 303 172" width="250" fill="none" style="opacity:.08;margin-bottom:10px"><path d="M229.565 160.229c32.647-16.908 54.907-50.96 54.907-90.142C284.472 31.356 252.117 0 213.396 0c-23.618 0-44.489 11.732-57.203 29.653-12.715-17.921-33.586-29.653-57.204-29.653C60.268 0 27.913 31.356 27.913 70.087c0 39.182 22.26 73.234 54.907 90.142H0v12h303v-12h-73.435z" fill="#e9edef"/></svg>
      <h3>Neon Infinito</h3>
      <p>Enviá y recibí mensajes de WhatsApp.<br>Los mensajes que envíes desde acá se guardan automáticamente.</p>
    </div>
  `;
}

function renderChatConversation() {
  const phone = chatState.selectedPhone;
  const name = chatState.selectedName;
  loadProfilePic(phone);
  const msgCount = chatState.messages.length;
  const inboundCount = chatState.messages.filter(m => m.direction === 'inbound').length;
  return `
    <div class="chat-header">
      ${avatarHtml(phone, name, 40)}
      <div style="flex:1;min-width:0">
        <div class="chat-header-name">${escapeHtml(name || formatPhoneDisplay(phone))}</div>
        <div class="chat-header-phone">${escapeHtml(formatPhoneDisplay(phone))}</div>
      </div>
      <div class="chat-header-meta">
        <span>${msgCount} msgs</span>
        <button class="btn-label-toggle" id="btn-labels" title="Etiquetas">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16z"/></svg>
        </button>
      </div>
      <div class="chat-label-chips" id="chat-label-chips">${renderContactLabelChips(phone)}</div>
    </div>
    <div class="chat-messages" id="chat-messages">
      ${chatState.loadingConv
        ? '<div class="chat-loading"><div class="spinner" style="border-color:#2a3942;border-top-color:#00a884"></div></div>'
        : renderChatBubbles()}
    </div>
    <button class="chat-scroll-down" id="chat-scroll-down" title="Ir al final">
      <svg viewBox="0 0 19 20" width="18" height="18" fill="currentColor"><path d="M3.8 6.7l5.7 5.7 5.7-5.7 1.6 1.6-7.3 7.2-7.3-7.2 1.6-1.6z"/></svg>
    </button>
    <div class="chat-input-bar">
      <button class="btn-send btn-attach" id="btn-attach" title="Adjuntar imagen"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M1.816 15.556v.002c0 1.502.584 2.912 1.646 3.972s2.472 1.647 3.974 1.647a5.58 5.58 0 003.972-1.645l9.547-9.548c.769-.768 1.147-1.767 1.058-2.817-.079-.968-.548-1.927-1.319-2.698-1.594-1.592-4.068-1.711-5.517-.262l-7.916 7.915c-.881.881-.792 2.25.214 3.261.501.501 1.134.79 1.737.79.558 0 1.031-.224 1.37-.564l5.582-5.58a.747.747 0 10-1.055-1.06l-5.58 5.58c-.172.172-.42.156-.614-.04-.508-.51-.427-1.122-.07-1.478l7.916-7.916c.866-.866 2.358-.764 3.46.34.556.557.876 1.203.918 1.818.036.526-.176 1.047-.595 1.466L10.11 18.526a4.09 4.09 0 01-2.913 1.205 4.09 4.09 0 01-2.913-1.205 4.09 4.09 0 01-1.205-2.913c0-1.1.428-2.134 1.205-2.911l8.647-8.646a.747.747 0 00-1.055-1.06l-8.647 8.646A5.58 5.58 0 001.816 15.556z"/></svg></button>
      <input type="file" id="chat-file-input" accept="image/*" style="display:none">
      <div class="chat-input-wrap">
        <textarea id="chat-input" placeholder="Escribí un mensaje" rows="1"></textarea>
        <div class="qr-dropdown" id="qr-dropdown" style="display:none"></div>
      </div>
      <button class="btn-send" id="chat-send-btn" ${chatState.sending ? 'disabled' : ''} title="Enviar"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M1.101 21.757L23.8 12.028 1.101 2.3l.011 7.912 13.239 1.816-13.239 1.817-.011 7.912z"/></svg></button>
      <button class="btn-send btn-mic" id="btn-mic" title="Grabar audio"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M11.999 14.942c2.001 0 3.531-1.53 3.531-3.531V4.35c0-2.001-1.53-3.531-3.531-3.531S8.469 2.35 8.469 4.35v7.061c0 2.001 1.53 3.531 3.53 3.531zm6.238-3.53c0 3.531-2.942 6.002-6.238 6.002s-6.238-2.471-6.238-6.002H4.761c0 3.885 3.118 7.061 7.003 7.414v3.174h.471v-3.174c3.885-.353 7.003-3.529 7.003-7.414h-1z"/></svg></button>
    </div>
  `;
}

function mediaUrl(r2Key) {
  if (!r2Key) return '';
  const tkParam = STATE.token ? '?token=' + encodeURIComponent(STATE.token) : '';
  if (r2Key.startsWith('wa/')) return CONFIG.trackerUrl + '/admin/media/' + encodeURIComponent(r2Key) + tkParam;
  return r2Key;
}

function generateAudioBars() {
  // Generate random bar heights for visual waveform
  const count = 28;
  let bars = '';
  for (let i = 0; i < count; i++) {
    const h = 3 + Math.floor(Math.random() * 23);
    bars += `<div class="audio-bar" style="height:${h}px"></div>`;
  }
  return bars;
}

function renderChatBubbles() {
  const msgs = chatState.messages;
  if (!msgs.length) return '<div class="chat-empty">Sin mensajes</div>';
  let html = '';
  let lastDate = '';
  let lastDir = '';
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const msgDate = m.ts.slice(0, 10);
    if (msgDate !== lastDate) {
      lastDate = msgDate;
      html += `<div class="chat-date-sep"><span>${formatChatDate(m.ts)}</span></div>`;
      lastDir = '';
    }
    const dir = m.direction || 'inbound';
    const time = new Date(m.ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    const hasTail = dir !== lastDir;
    lastDir = dir;

    // Status ticks (SVG like WA)
    let statusHtml = '';
    if (dir === 'outbound') {
      if (m.status === 'read') statusHtml = `<span class="chat-msg-status read">${TICK_DOUBLE}</span>`;
      else if (m.status === 'delivered') statusHtml = `<span class="chat-msg-status delivered">${TICK_DOUBLE}</span>`;
      else statusHtml = `<span class="chat-msg-status sent">${TICK_SINGLE}</span>`;
    }
    const footer = `<span class="chat-msg-footer"><span class="chat-msg-time">${time}</span>${statusHtml}</span>`;

    // Parse body: separate actual text from [audio]/[imagen] AI annotations
    let bodyText = m.body || '';
    let transcript = '';
    let imgDescription = '';
    if (m.msg_type === 'audio' && bodyText.startsWith('[audio] ')) {
      transcript = bodyText.slice(8);
      bodyText = '';
    }
    if (m.msg_type === 'image') {
      const imgIdx = bodyText.indexOf('[imagen] ');
      if (imgIdx >= 0) {
        imgDescription = bodyText.slice(imgIdx + 9);
        bodyText = bodyText.slice(0, imgIdx).trim();
      }
    }

    // === STICKER ===
    if (m.msg_type === 'sticker' && m.media_url) {
      html += `<div class="chat-msg ${dir} sticker-msg${hasTail ? ' has-tail' : ''}">
        <img src="${mediaUrl(m.media_url)}" alt="" style="max-width:160px;max-height:160px" loading="lazy">
      </div>`;
      continue;
    }

    // === IMAGE ===
    if (m.msg_type === 'image' && m.media_url) {
      html += `<div class="chat-msg ${dir} has-media${hasTail ? ' has-tail' : ''}">
        <div class="chat-msg-media">
          <img src="${mediaUrl(m.media_url)}" alt="" loading="lazy"
               onclick="window.open(this.src,'_blank')"
               onerror="this.style.display='none'">
        </div>
        ${bodyText ? `<div class="chat-msg-body">${escapeHtml(bodyText).replace(/\n/g, '<br>')}</div>` : ''}
        ${footer}
      </div>`;
      continue;
    }

    // === AUDIO ===
    if (m.msg_type === 'audio' && m.media_url) {
      const contact = chatState.contacts.find(c => c.phone === chatState.selectedPhone);
      const aName = dir === 'inbound' ? (contact?.name || '') : 'Neon';
      html += `<div class="chat-msg ${dir}${hasTail ? ' has-tail' : ''}">
        <div class="chat-msg-audio">
          ${avatarHtml(dir === 'inbound' ? chatState.selectedPhone : '0000', aName, 46)}
          <div class="audio-wave">
            <div class="audio-bars" data-audio-src="${mediaUrl(m.media_url)}">
              ${generateAudioBars()}
            </div>
            <div class="audio-dur">
              <audio preload="metadata" src="${mediaUrl(m.media_url)}" data-audio-el></audio>
              <span data-audio-time>0:00</span>
            </div>
          </div>
        </div>
        ${transcript ? `<div class="chat-msg-transcript">"${escapeHtml(transcript)}"</div>` : ''}
        ${footer}
      </div>`;
      continue;
    }

    // === VIDEO ===
    if (m.msg_type === 'video' && m.media_url) {
      html += `<div class="chat-msg ${dir}${hasTail ? ' has-tail' : ''}">
        <div class="chat-msg-video">
          <div class="v-icon">▶</div>
          <div>
            <a href="${mediaUrl(m.media_url)}" target="_blank">Video</a>
            ${bodyText ? `<div style="font-size:12px;color:#8696a0;margin-top:2px">${escapeHtml(bodyText)}</div>` : ''}
          </div>
        </div>
        ${footer}
      </div>`;
      continue;
    }

    // === DOCUMENT ===
    if (m.msg_type === 'document' && m.media_url) {
      const docName = bodyText || 'Documento';
      const ext = m.media_url.split('.').pop()?.toUpperCase() || 'DOC';
      html += `<div class="chat-msg ${dir}${hasTail ? ' has-tail' : ''}">
        <a href="${mediaUrl(m.media_url)}" target="_blank" style="text-decoration:none">
          <div class="chat-msg-doc">
            <div class="doc-icon">${ext.slice(0, 4)}</div>
            <div class="doc-name">${escapeHtml(docName)}</div>
          </div>
        </a>
        ${footer}
      </div>`;
      continue;
    }

    // === TEXT (or any other type) ===
    // Skip completely empty outbound bubbles (echo messages without content)
    if (!bodyText.trim() && dir === 'outbound' && m.msg_type === 'status') continue;
    // For empty bubbles without any content, show minimal
    if (!bodyText.trim() && !m.media_url) {
      // Could be an unsupported message type
      if (m.msg_type !== 'text' && m.msg_type !== 'status') {
        bodyText = `[${m.msg_type}]`;
      } else if (!bodyText.trim()) {
        continue; // Skip truly empty messages
      }
    }

    html += `<div class="chat-msg ${dir}${hasTail ? ' has-tail' : ''}">
      ${bodyText ? `<span class="chat-msg-body">${escapeHtml(bodyText).replace(/\n/g, '<br>')}</span>` : ''}
      ${footer}
    </div>`;
  }
  return html;
}

function renderChatMessages() {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  container.innerHTML = renderChatBubbles();
  bindAudioPlayers();
  container.scrollTop = container.scrollHeight;
}

function bindAudioPlayers() {
  // Bind click on audio bars to play/pause
  document.querySelectorAll('.chat-msg-audio .audio-bars').forEach(bars => {
    const audioEl = bars.closest('.chat-msg-audio').querySelector('audio[data-audio-el]');
    const timeEl = bars.closest('.chat-msg-audio').querySelector('[data-audio-time]');
    if (!audioEl) return;
    // Show duration once loaded
    audioEl.addEventListener('loadedmetadata', () => {
      if (timeEl && audioEl.duration && isFinite(audioEl.duration)) {
        const d = Math.round(audioEl.duration);
        timeEl.textContent = Math.floor(d / 60) + ':' + String(d % 60).padStart(2, '0');
      }
    });
    bars.style.cursor = 'pointer';
    bars.onclick = () => {
      if (audioEl.paused) {
        // Pause all other audios first
        document.querySelectorAll('audio[data-audio-el]').forEach(a => { if (a !== audioEl) a.pause(); });
        audioEl.play();
        bars.style.opacity = '1';
      } else {
        audioEl.pause();
        bars.style.opacity = '.7';
      }
    };
    audioEl.addEventListener('timeupdate', () => {
      if (timeEl && audioEl.duration && isFinite(audioEl.duration)) {
        const rem = Math.round(audioEl.duration - audioEl.currentTime);
        timeEl.textContent = Math.floor(rem / 60) + ':' + String(rem % 60).padStart(2, '0');
        // Animate bars progress
        const pct = audioEl.currentTime / audioEl.duration;
        const allBars = bars.querySelectorAll('.audio-bar');
        allBars.forEach((bar, idx) => {
          bar.style.background = (idx / allBars.length) <= pct ? '#00a884' : 'rgba(255,255,255,.4)';
        });
      }
    });
    audioEl.addEventListener('ended', () => {
      bars.style.opacity = '.7';
      const allBars = bars.querySelectorAll('.audio-bar');
      allBars.forEach(bar => bar.style.background = 'rgba(255,255,255,.4)');
    });
  });
}

async function selectChatContact(phone) {
  chatState.selectedPhone = phone;
  const contact = chatState.contacts.find(c => c.phone === phone);
  chatState.selectedName = contact?.name || '';
  chatState.loadingConv = true;

  // Show loading state immediately
  if (STATE.view === 'chat') {
    const main = document.querySelector('.chat-main');
    if (main) {
      main.innerHTML = renderChatConversation();
    }
    // Update active in contact list
    document.querySelectorAll('.chat-contact').forEach(el => {
      el.classList.toggle('active', el.dataset.chatPhone === phone);
      el.classList.remove('has-unread');
    });
  }

  // Load messages
  await loadChatMessages(phone);
  chatState.loadingConv = false;

  // Mark as read
  markConversationRead(phone);

  // Re-render conversation with actual messages
  if (STATE.view === 'chat') {
    const main = document.querySelector('.chat-main');
    if (main) {
      main.innerHTML = renderChatConversation();
      bindChatConversation();
      bindAudioPlayers();
      // Scroll to bottom
      const msgs = document.getElementById('chat-messages');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
    }
    // Update unread badge on contact
    const contactEl = document.querySelector(`[data-chat-phone="${phone}"]`);
    if (contactEl) {
      const badge = contactEl.querySelector('.chat-contact-unread');
      if (badge) badge.remove();
    }
  }
}

function bindChatConversation() {
  const ta = document.getElementById('chat-input');
  const btn = document.getElementById('chat-send-btn');
  const msgEl = document.getElementById('chat-messages');
  const scrollBtn = document.getElementById('chat-scroll-down');
  const attachBtn = document.getElementById('btn-attach');
  const fileInput = document.getElementById('chat-file-input');
  const micBtn = document.getElementById('btn-mic');
  const labelsBtn = document.getElementById('btn-labels');

  if (ta) {
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
      // Quick replies dropdown
      handleQuickReplyInput(ta);
    });
    ta.addEventListener('keydown', (e) => {
      // Handle QR dropdown navigation
      const dd = document.getElementById('qr-dropdown');
      if (dd && dd.style.display !== 'none') {
        const items = dd.querySelectorAll('.qr-item');
        const active = dd.querySelector('.qr-item.active');
        let idx = Array.from(items).indexOf(active);
        if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(idx + 1, items.length - 1); items.forEach((el, i) => el.classList.toggle('active', i === idx)); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(idx - 1, 0); items.forEach((el, i) => el.classList.toggle('active', i === idx)); return; }
        if (e.key === 'Enter' && active) { e.preventDefault(); ta.value = active.dataset.qrBody; dd.style.display = 'none'; ta.dispatchEvent(new Event('input')); return; }
        if (e.key === 'Escape') { dd.style.display = 'none'; return; }
        if (e.key === 'Tab' && active) { e.preventDefault(); ta.value = active.dataset.qrBody; dd.style.display = 'none'; ta.dispatchEvent(new Event('input')); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (ta.value.trim() && !chatState.sending) {
          sendChatMessage(chatState.selectedPhone, ta.value);
        }
      }
    });
    ta.focus();
  }
  if (btn) {
    btn.onclick = () => {
      const ta = document.getElementById('chat-input');
      if (ta && ta.value.trim() && !chatState.sending) {
        sendChatMessage(chatState.selectedPhone, ta.value);
      }
    };
  }
  // Attach image
  if (attachBtn && fileInput) {
    attachBtn.onclick = () => fileInput.click();
    fileInput.onchange = () => {
      const file = fileInput.files[0];
      if (file && chatState.selectedPhone) {
        sendChatImage(chatState.selectedPhone, file, '');
        fileInput.value = '';
      }
    };
  }
  // Mic button
  if (micBtn) {
    micBtn.onclick = () => {
      if (!chatState.selectedPhone) return;
      startRecording(chatState.selectedPhone);
    };
  }
  // Label button on header
  if (labelsBtn) {
    labelsBtn.onclick = () => showLabelPicker(chatState.selectedPhone);
  }
  // Scroll-to-bottom FAB
  if (msgEl && scrollBtn) {
    msgEl.addEventListener('scroll', () => {
      const distFromBottom = msgEl.scrollHeight - msgEl.scrollTop - msgEl.clientHeight;
      scrollBtn.classList.toggle('visible', distFromBottom > 200);
    });
    scrollBtn.onclick = () => {
      msgEl.scrollTo({ top: msgEl.scrollHeight, behavior: 'smooth' });
    };
  }
}

function handleQuickReplyInput(ta) {
  const dd = document.getElementById('qr-dropdown');
  if (!dd) return;
  const val = ta.value;
  if (val.startsWith('/') && val.length >= 1) {
    const query = val.slice(1).toLowerCase();
    const matches = chatState.quickReplies.filter(q => !query || q.shortcut.includes(query) || q.body.toLowerCase().includes(query));
    if (matches.length && val !== '/') {
      dd.innerHTML = matches.slice(0, 8).map((q, i) =>
        `<div class="qr-item${i === 0 ? ' active' : ''}" data-qr-body="${escapeHtml(q.body)}">
          <span class="qr-shortcut">/${escapeHtml(q.shortcut)}</span>
          <span class="qr-preview">${escapeHtml(q.body.slice(0, 60))}</span>
        </div>`
      ).join('');
      dd.style.display = 'block';
      dd.querySelectorAll('.qr-item').forEach(el => {
        el.onclick = () => { ta.value = el.dataset.qrBody; dd.style.display = 'none'; ta.focus(); ta.dispatchEvent(new Event('input')); };
      });
    } else if (val === '/') {
      // Show all quick replies
      dd.innerHTML = chatState.quickReplies.slice(0, 10).map((q, i) =>
        `<div class="qr-item${i === 0 ? ' active' : ''}" data-qr-body="${escapeHtml(q.body)}">
          <span class="qr-shortcut">/${escapeHtml(q.shortcut)}</span>
          <span class="qr-preview">${escapeHtml(q.body.slice(0, 60))}</span>
        </div>`
      ).join('');
      if (chatState.quickReplies.length) dd.style.display = 'block';
      else dd.style.display = 'none';
      dd.querySelectorAll('.qr-item').forEach(el => {
        el.onclick = () => { ta.value = el.dataset.qrBody; dd.style.display = 'none'; ta.focus(); ta.dispatchEvent(new Event('input')); };
      });
    } else {
      dd.style.display = 'none';
    }
  } else {
    dd.style.display = 'none';
  }
}

function showLabelPicker(phone) {
  const existing = document.getElementById('label-picker-popup');
  if (existing) { existing.remove(); return; }
  const cLabels = chatState.contactLabels[phone] || [];
  const popup = document.createElement('div');
  popup.id = 'label-picker-popup';
  popup.className = 'label-picker-popup';
  popup.innerHTML = `
    <div class="label-picker-title">Etiquetas</div>
    ${chatState.labels.map(l => `
      <label class="label-picker-row">
        <input type="checkbox" ${cLabels.includes(l.id) ? 'checked' : ''} data-lbl-id="${l.id}">
        <span class="label-chip" style="background:${l.color}">${escapeHtml(l.name)}</span>
      </label>
    `).join('')}
    ${!chatState.labels.length ? '<div style="color:#8696a0;font-size:13px;padding:8px">No hay etiquetas. Crealas desde el panel izquierdo.</div>' : ''}
  `;
  document.querySelector('.chat-header').appendChild(popup);
  popup.querySelectorAll('input[data-lbl-id]').forEach(cb => {
    cb.onchange = async () => {
      await toggleContactLabel(phone, parseInt(cb.dataset.lblId));
      // Update chips
      const chips = document.getElementById('chat-label-chips');
      if (chips) chips.innerHTML = renderContactLabelChips(phone);
    };
  });
  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function closer(e) {
      if (!popup.contains(e.target) && e.target.id !== 'btn-labels') {
        popup.remove(); document.removeEventListener('click', closer);
      }
    });
  }, 10);
}

function bindChat() {
  // Load data
  if (!chatState.contacts.length && !chatState.loading) {
    Promise.all([loadChatContacts(), loadQuickReplies(), loadLabels()]).then(() => {
      if (STATE.view === 'chat') render();
    });
  } else {
    loadQuickReplies();
    loadLabels();
  }
  // Search
  const searchInput = document.getElementById('chat-search');
  if (searchInput) {
    searchInput.oninput = () => {
      chatState.search = searchInput.value;
      refreshContactList();
    };
  }
  bindChatContactClicks();
  // Refresh
  const refreshBtn = document.getElementById('chat-refresh');
  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      await loadChatContacts();
      if (STATE.view === 'chat') render();
    };
  }
  // Label filter chips
  document.querySelectorAll('.label-filter-chip').forEach(btn => {
    btn.onclick = () => {
      const id = parseInt(btn.dataset.labelId);
      if (chatState.filterLabels.includes(id)) {
        chatState.filterLabels = chatState.filterLabels.filter(l => l !== id);
      } else {
        chatState.filterLabels.push(id);
      }
      render();
    };
  });
  const clearFilter = document.getElementById('clear-label-filter');
  if (clearFilter) clearFilter.onclick = () => { chatState.filterLabels = []; render(); };
  // Manage labels button
  const manageLabelsBtn = document.getElementById('btn-manage-labels');
  if (manageLabelsBtn) manageLabelsBtn.onclick = () => showManageLabelsModal();
  // Manage quick replies button
  const manageQrBtn = document.getElementById('btn-manage-qr');
  if (manageQrBtn) manageQrBtn.onclick = () => showManageQRModal();
  // Bulk messaging button
  const bulkBtn = document.getElementById('btn-bulk');
  if (bulkBtn) bulkBtn.onclick = () => {
    const sec = document.getElementById('bulk-section');
    if (sec) sec.style.display = sec.style.display === 'none' ? 'block' : 'none';
  };
  bindBulkSection();
  if (chatState.selectedPhone) bindChatConversation();
  // Poll
  clearInterval(chatState.pollTimer);
  chatState.pollTimer = setInterval(async () => {
    if (STATE.view !== 'chat') { clearInterval(chatState.pollTimer); return; }
    const prevMsgCount = chatState.messages.length;
    await loadChatContacts();
    if (STATE.view === 'chat') {
      refreshContactList();
      if (chatState.selectedPhone && chatState.messages.length > prevMsgCount) {
        const msgEl = document.getElementById('chat-messages');
        const wasAtBottom = msgEl && (msgEl.scrollHeight - msgEl.scrollTop - msgEl.clientHeight < 80);
        renderChatMessages();
        if (wasAtBottom && msgEl) msgEl.scrollTop = msgEl.scrollHeight;
      }
      updateUnreadBadge();
    }
  }, 12000);
}

function refreshContactList() {
  const list = document.getElementById('chat-contact-list');
  if (!list) return;
  const search = chatState.search.toLowerCase();
  let filtered = chatState.contacts;
  if (search) filtered = filtered.filter(c => (c.name || '').toLowerCase().includes(search) || c.phone.includes(search) || (c.lastMsg || '').toLowerCase().includes(search));
  if (chatState.filterLabels.length) filtered = filtered.filter(c => { const cl = chatState.contactLabels[c.phone] || []; return chatState.filterLabels.every(lid => cl.includes(lid)); });
  list.innerHTML = filtered.map(c => renderContactItem(c)).join('');
  bindChatContactClicks();
}

function bindBulkSection() {
  const closeBtn = document.getElementById('bulk-close');
  if (closeBtn) closeBtn.onclick = () => { document.getElementById('bulk-section').style.display = 'none'; };
  // Count contacts when labels are checked
  document.querySelectorAll('.bulk-label-cb').forEach(cb => {
    cb.onchange = () => {
      const checked = Array.from(document.querySelectorAll('.bulk-label-cb:checked')).map(c => parseInt(c.value));
      if (!checked.length) { document.getElementById('bulk-count').textContent = ''; return; }
      const phones = new Set();
      for (const ph of Object.keys(chatState.contactLabels)) {
        const cl = chatState.contactLabels[ph];
        if (checked.some(lid => cl.includes(lid))) phones.add(ph);
      }
      document.getElementById('bulk-count').textContent = `${phones.size} contacto(s) seleccionados`;
    };
  });
  const sendBtn = document.getElementById('bulk-send-btn');
  if (sendBtn) sendBtn.onclick = async () => {
    const checked = Array.from(document.querySelectorAll('.bulk-label-cb:checked')).map(c => parseInt(c.value));
    const msg = document.getElementById('bulk-msg')?.value?.trim();
    if (!checked.length) { toast('Seleccioná al menos una etiqueta'); return; }
    if (!msg) { toast('Escribí un mensaje'); return; }
    sendBtn.disabled = true;
    sendBtn.textContent = 'Enviando...';
    const result = await sendBulkMessage(checked, msg);
    sendBtn.disabled = false;
    sendBtn.textContent = 'Enviar masivo';
    const resEl = document.getElementById('bulk-result');
    if (resEl && result) resEl.innerHTML = `<span style="color:#00a884">Enviados: ${result.sent}</span>${result.failed ? ` | <span style="color:#ef5350">Fallidos: ${result.failed}</span>` : ''}`;
  };
}

function showManageLabelsModal() {
  const LABEL_COLORS = ['#ef5350','#ff7043','#ffa726','#ffca28','#66bb6a','#26a69a','#42a5f5','#5c6bc0','#ab47bc','#ec407a','#8d6e63','#78909c'];
  const content = `
    <h3 style="margin-bottom:12px">Gestionar etiquetas</h3>
    <div style="margin-bottom:12px">
      ${chatState.labels.map(l => `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span class="label-chip" style="background:${l.color}">${escapeHtml(l.name)}</span>
          <button class="btn-send" style="width:24px;height:24px;font-size:14px;color:#ef5350" data-del-label="${l.id}">&times;</button>
        </div>
      `).join('')}
      ${!chatState.labels.length ? '<p style="color:#8696a0;font-size:13px">No hay etiquetas todavía</p>' : ''}
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
      ${LABEL_COLORS.map(c => `<button class="label-color-pick" data-color="${c}" style="width:24px;height:24px;border-radius:50%;border:2px solid transparent;background:${c};cursor:pointer"></button>`).join('')}
    </div>
    <div style="display:flex;gap:6px">
      <input type="text" id="new-label-name" placeholder="Nombre..." style="flex:1;padding:6px 10px;background:#2a3942;border:none;color:#e9edef;border-radius:6px;font-size:14px">
      <button class="btn btn-primary" id="add-label-btn" style="padding:6px 14px">Crear</button>
    </div>
  `;
  openDrawer('Etiquetas', content);
  let selectedColor = LABEL_COLORS[0];
  document.querySelectorAll('.label-color-pick').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.label-color-pick').forEach(b => b.style.borderColor = 'transparent');
      btn.style.borderColor = '#fff';
      selectedColor = btn.dataset.color;
    };
  });
  document.querySelectorAll('[data-del-label]').forEach(btn => {
    btn.onclick = async () => { await deleteLabel(parseInt(btn.dataset.delLabel)); showManageLabelsModal(); render(); };
  });
  const addBtn = document.getElementById('add-label-btn');
  if (addBtn) addBtn.onclick = async () => {
    const name = document.getElementById('new-label-name')?.value?.trim();
    if (!name) return;
    await saveLabel(name, selectedColor);
    showManageLabelsModal();
    render();
  };
}

function showManageQRModal() {
  const content = `
    <h3 style="margin-bottom:12px">Respuestas rápidas</h3>
    <p style="color:#8696a0;font-size:13px;margin-bottom:12px">Escribí <b>/</b> en el chat para ver tus respuestas guardadas</p>
    <div style="margin-bottom:12px">
      ${chatState.quickReplies.map(q => `
        <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:8px;padding:8px;background:#202c33;border-radius:8px">
          <div style="flex:1;min-width:0">
            <div style="color:#00a884;font-size:13px;font-weight:600">/${escapeHtml(q.shortcut)}</div>
            <div style="color:#e9edef;font-size:14px;margin-top:2px;white-space:pre-wrap">${escapeHtml(q.body)}</div>
          </div>
          <button class="btn-send" style="width:24px;height:24px;font-size:14px;color:#ef5350;flex-shrink:0" data-del-qr="${q.id}">&times;</button>
        </div>
      `).join('')}
      ${!chatState.quickReplies.length ? '<p style="color:#8696a0;font-size:13px">No hay respuestas guardadas</p>' : ''}
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
      <input type="text" id="new-qr-shortcut" placeholder="Atajo (ej: saludo)" style="padding:6px 10px;background:#2a3942;border:none;color:#e9edef;border-radius:6px;font-size:14px">
      <textarea id="new-qr-body" placeholder="Texto del mensaje..." rows="3" style="padding:6px 10px;background:#2a3942;border:none;color:#e9edef;border-radius:6px;font-size:14px;resize:vertical;font-family:inherit"></textarea>
      <button class="btn btn-primary" id="add-qr-btn" style="padding:6px 14px">Guardar respuesta</button>
    </div>
  `;
  openDrawer('Respuestas rápidas', content);
  document.querySelectorAll('[data-del-qr]').forEach(btn => {
    btn.onclick = async () => { await deleteQuickReply(parseInt(btn.dataset.delQr)); showManageQRModal(); };
  });
  const addBtn = document.getElementById('add-qr-btn');
  if (addBtn) addBtn.onclick = async () => {
    const shortcut = document.getElementById('new-qr-shortcut')?.value?.trim();
    const body = document.getElementById('new-qr-body')?.value?.trim();
    if (!shortcut || !body) { toast('Completá atajo y mensaje'); return; }
    await saveQuickReply(shortcut, body);
    showManageQRModal();
  };
}

function bindChatContactClicks() {
  document.querySelectorAll('.chat-contact').forEach(el => {
    el.onclick = () => selectChatContact(el.dataset.chatPhone);
  });
}

window.loadAll = loadAll;
window.closeDrawer = closeDrawer;

// ---------- INIT ----------
loadUser();
// Cargar done marks: localStorage inmediato + sync async desde Worker
STATE.done = loadDoneLocal();
loadCotizadorParams();
const initView = location.hash.replace('#','') || 'dashboard';
STATE.view = initView;
loadAll();
// Sync done marks desde Worker (en background, re-render cuando llegue)
loadDone().then(() => { if (STATE.loaded) render(); });
// Pre-load chat unread counts for sidebar badge
if (isAdmin()) loadChatContacts().then(() => updateUnreadBadge());

// Re-bind table when pedidos view rendered after data loads
function rerenderTablePedidosIfNeeded() { if (STATE.view === 'pedidos') renderTablePedidos(); }
const _origRender = render;
render = function() { _origRender.apply(this, arguments); if (STATE.view === 'pedidos' && STATE.loaded) renderTablePedidos(); };
