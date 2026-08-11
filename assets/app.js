/* NI Ventas · App logic
 * Live data: Sheet "Ventas" hoja 2026 + Cotizador hojas Abril/Mayo+
 * Cross-match presupuesto → cerrado por nombre + ±20% precio
 * Routing: hash-based (#dashboard, #pedidos, etc.)
 */

// ============================================================
// FLAG TEMPORAL — ofrecer base negra (acrílico negro) al cliente.
// Puesto en false (jul-2026) HASTA NUEVO AVISO: se cotiza y presupuesta
// SOLO con base transparente (no se muestra ni se manda la opción negra).
// El cálculo del precio negro sigue intacto por si se reactiva.
// Controla: panel de cotización + texto de presupuesto (dentro de ventana 24h).
// Para REACTIVAR: poner en true.
const OFRECER_BASE_NEGRA = false;

// Fuera de ventana el presupuesto va por PLANTILLA. Las 'presupuesto_detallado(_img)2'
// (jul-2026) NO tienen base negra (4 vars); enviarPresupuestoComoPlantilla las prefiere y
// cae a las viejas 'presupuesto_detallado(_img)' (con negra, 5 vars) SOLO hasta que Meta
// apruebe las nuevas. Cuando estén aprobadas y estables, se pueden borrar las viejas.

const CONFIG = {
  trackerUrl: 'https://ni-ventas-tracker.neoninfinito.workers.dev',  // URL pública del Worker. Vacío = sin tracking remoto, solo localStorage.
  defaultUsers: ['Gaspar', 'Joaquín', 'Nadia', 'Diseñador', 'Abril'],
  ventasSheetId: '1qKUhSDDjBV4k8W0goPhOFzEhLz0Zeruq2slLpb9bWSg',
  cotizadorSheetId: '13I4OAwpFm4Z0DM81SzbwMpr1DvIjC2NF1BiB0njA1hQ',
  ventasSheetName: '2026',
  cotizadorSheets: ['2026'],
  // Hojas históricas pre-tracking-por-fecha. Cada fila = 1 presupuesto del mes.
  // Sin columna de fecha — asignamos día 15 del mes como referencia.
  cotizadorHistoricalSheets: [
    { name: 'ENERO',   month: '2026-01' },
    { name: 'FEBRERO', month: '2026-02' },
    { name: 'MARZO',   month: '2026-03' },
  ],
  // Overrides manuales para meses con tracking incompleto.
  // Se generan presupuestos "phantom" para llegar al total que vos dijiste,
  // así la tasa de cierre refleja la realidad y no solo lo trackeado.
  // Las phantom rows tienen historical:true y nombre genérico, no afectan
  // el matching de pedidos.
  cotizadorMonthOverrides: {
    '2026-04': 512,  // Abril 2026: 376 trackeados + 136 phantom = 512 reales
  },
  matchPriceTolerance: 0.20,   // ±20%
  presupuestoFollowupDays: 7,  // miércoles a miércoles
  presupuestoCutoff: '2026-05-08',   // presupuestos anteriores quedan dados por vencidos / fuera del seguimiento activo
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
    nv_nadia_comision_pct: 0.04,  // 4% Nadia (2da vendedora)
    descuento_mult: 0.88,     // si m2 > descuento_min_m2
    descuento_min_m2: 100,
    recargo_5: 2,             // m2 ≤ 5  → trans × 2
    recargo_125: 1.5,         // m2 ≤ 12.5 → trans × 1.5
    recargo_25: 1.15,         // m2 < 25 → trans × 1.15
    // Controladores opcionales
    ctrl_slim: 18700,
    ctrl_remoto: 25000,
    ctrl_app: 38000,

    // ============ Lógica NUEVA (paralelo durante transición) ============
    // Modelo COGS + margen variable. Spec en spec-cotizador-nuevo.md.
    // Mientras "transicionUseNueva" sea false, el cotizador muestra ambos
    // precios pero usa la fórmula vieja para el presupuesto enviado al cliente.
    // Para activar la nueva en producción, setear true (configurable desde el
    // worker via /admin/cotizador/params).
    transicionUseNueva: true,        // si true, presupuesto cliente usa fórmula nueva
    // Costos por m²
    nv_costo_m2: 75000,              // = $40k acrílico + (15% Anibal + 5% Emma) × $175k m² imaginario
    nv_costo_neon_mt: 2631,          // $/mt de neón
    // Fuente por cm de neón (3 escalones)
    nv_fuente_corto: 4000,           // cm ≤ 500
    nv_fuente_medio: 4500,           // 500 < cm < 1200
    nv_fuente_largo: 9000,           // cm ≥ 1200
    // Divisor base = 1 − MO (13.5%) − comisión Joaco (5%)
    nv_divisor_base: 0.815,
    // Margen por tamaño (interpolación log entre dos CF de referencia)
    nv_margen_chico: 0.68,           // CF ≤ ref_chico → 68%
    nv_margen_grande: 0.51,          // CF ≥ ref_grande → 51%
    nv_cf_ref_chico: 20500,
    nv_cf_ref_grande: 109000,
    // Complejidad por densidad (tramos / metros)
    nv_complejidad_coef: 0.018,
    nv_complejidad_pivote: 1.4,
    nv_complejidad_tope: 0.04,
    // Clamp final del margen
    nv_margen_min: 0.48,
    nv_margen_max: 0.72,
    // Acrílico negro: precio = transparente × ratio (siempre 7% más barato)
    nv_negro_ratio: 0.93,
    // Fallback del sueldo fijo de Joaco si un mes no está en joacoFijoByMonth.
    nv_joaquin_fijo: 250000,
    // Sueldo fijo de Nadia (2da vendedora): PENDIENTE de definir → 0 por ahora.
    nv_nadia_fijo: 0
  },
  // Sueldo fijo mensual de Joaco — espejo de la hoja COGS fila 50 ("Sueldos
  // Joaquin"), indexado por número de mes (fila 47 = 1..12). El dashboard suma
  // el fijo REAL de cada mes del período elegido (varía mes a mes). Si cambia
  // en el Excel, actualizá acá (o conectamos el Apps Script para sincronizar).
  joacoFijoByMonth: { 1: 492500, 2: 267000, 3: 250000, 4: 326000, 5: 290000, 6: 250000, 7: 250000, 8: 250000, 9: 250000, 10: 250000, 11: 250000, 12: 250000 },
  // Sueldo fijo mensual de Nadia — PENDIENTE de definir (arranca vacío = 0). Cargar acá
  // cuando Gaspar lo defina (mismo formato que joacoFijoByMonth: { mes: monto }).
  nadiaFijoByMonth: {},
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
  cotizadorCogs: null,    // COGS del Excel 2026v4 { derived, raw, mes, fetchedAt } — pisa params para la fórmula nueva
  cotizadorCogsError: null,
  cotizadorForm: { ancho: '', alto: '', neon: '', tramos: '', tipo: 'INT', cliente: '', canal: 'WPP', telefono: '', textoOverride: '', extraCarteles: [] },
  corporeaForm: defaultCorpForm(),
  corpCreating: false,
  cotizadorSaving: false,
  // Panel de negocio (solo Gaspar) — datos del Sheet "2025 V4"
  businessPanel: { data: null, loading: false, error: null, lastFetch: 0, period: 'current', selectedVertical: null },
  // Privacy mode: oculta números económicos (estilo billetera virtual)
  privacy: (() => { try { return localStorage.getItem('privacy_mode') === '1'; } catch(_) { return false; } })()
};

// ============ COTIZADOR ============
// Precedencia de params: defaults del código < params de D1 (panel admin) <
// COGS derivados del Excel 2026v4 (los costos reales pisan a todo, son la fuente
// de verdad de la fórmula nueva). Los COGS solo aportan 3 claves: nv_costo_m2,
// nv_costo_neon_mt, nv_divisor_base. El resto (calibración) viene de D1/defaults.
function getCotizadorParams() {
  const cogs = (STATE.cotizadorCogs && STATE.cotizadorCogs.derived) || {};
  return Object.assign({}, CONFIG.cotizadorDefaults, STATE.cotizadorParams || {}, cogs);
}

// Sueldo fijo de Joaco para un mes 'YYYY-MM' (panel "Tu sueldo").
// Prioridad: mapa por mes que venga de COGS → CONFIG.joacoFijoByMonth → default.
function joacoFijoMes(yyyymm) {
  const m = parseInt(String(yyyymm || '').split('-')[1], 10);
  const cogsMap = (STATE.cotizadorCogs && STATE.cotizadorCogs.fijoByMonth) || null;
  if (cogsMap && +cogsMap[m]) return +cogsMap[m];
  const cfgMap = CONFIG.joacoFijoByMonth || {};
  if (+cfgMap[m]) return +cfgMap[m];
  return (+getCotizadorParams().nv_joaquin_fijo) || 250000;
}
// Sueldo fijo de Nadia para un mes 'YYYY-MM' (mismo patrón que joacoFijoMes). Arranca en 0
// hasta que se defina (CONFIG.nadiaFijoByMonth vacío, nv_nadia_fijo=0).
function nadiaFijoMes(yyyymm) {
  const m = parseInt(String(yyyymm || '').split('-')[1], 10);
  const cogsMap = (STATE.cotizadorCogs && STATE.cotizadorCogs.fijoByMonthNadia) || null;
  if (cogsMap && +cogsMap[m]) return +cogsMap[m];
  const cfgMap = CONFIG.nadiaFijoByMonth || {};
  if (+cfgMap[m]) return +cfgMap[m];
  return (+getCotizadorParams().nv_nadia_fijo) || 0;
}
// Panel "Tu sueldo" de un vendedor ('joaco'|'nadia'): fijo del mes + comisión sobre SUS
// ventas (filtradas por comercial_id) + total. Joaco: 5% desde may-2026; Nadia: 4% desde
// jul-2026. El filtro (p.comercial_id||'joaco')===vendedor deja a Joaco IGUAL que antes
// (todo el histórico es suyo por el default 'joaco').
function panelSueldoHtml(vendedor) {
  const esNadia = vendedor === 'nadia';
  const DESDE = esNadia ? '2026-07' : '2026-05';
  const params = getCotizadorParams();
  const rate = esNadia
    ? ((STATE.cotizadorCogs && STATE.cotizadorCogs.raw && +STATE.cotizadorCogs.raw.nadia) || params.nv_nadia_comision_pct || 0.04)
    : ((STATE.cotizadorCogs && STATE.cotizadorCogs.raw && +STATE.cotizadorCogs.raw.joaquin) || params.comision_pct || 0.05);
  const ratePct = +(rate * 100).toFixed(1);
  const fijoMes = esNadia ? nadiaFijoMes : joacoFijoMes;
  const sel = getDashMonths();
  const periodMonths = (sel || availableMonths()).filter(m => m >= DESDE);
  let inner, periodLbl;
  if (!periodMonths.length) {
    const desdeLbl = esNadia ? 'desde julio 2026' : 'desde mayo 2026';
    periodLbl = desdeLbl;
    inner = `<div style="color:var(--fg-subtle);font-size:13px">El sueldo se muestra <b>${desdeLbl}</b> en adelante. Elegí ese período (o "Todos") para verlo.</div>`;
  } else {
    const nMonths = periodMonths.length;
    const fijo = periodMonths.reduce((a, m) => a + fijoMes(m), 0);
    const ventas = STATE.pedidos
      .filter(p => periodMonths.indexOf(getMonth(p.fecha)) !== -1 && (p.comercial_id || 'joaco') === vendedor)
      .reduce((a, p) => a + (p.precio || 0) + (p.precioDimmer || 0), 0);
    const comision = Math.round(ventas * rate);
    const sueldo = fijo + comision;
    const por100k = Math.round(100000 * rate);
    periodLbl = nMonths === 1
      ? new Date(+periodMonths[0].split('-')[0], +periodMonths[0].split('-')[1] - 1, 1).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' })
      : nMonths + ' meses';
    const fijoNota = (esNadia && fijo === 0) ? 'fijo a definir' : (nMonths === 1 ? 'fijo del mes' : 'suma real · ' + nMonths + ' meses');
    inner = `
        <div class="kpi-grid" style="margin:0">
          <div class="kpi"><div class="kpi-label">Sueldo fijo</div><div class="kpi-value">${fmtMoney(fijo)}</div><div class="kpi-delta">${fijoNota}</div></div>
          <div class="kpi cyan"><div class="kpi-label">Comisión ${ratePct}%</div><div class="kpi-value">${fmtMoney(comision)}</div><div class="kpi-delta">sobre ${fmtMoney(ventas)} en carteles directo</div></div>
          <div class="kpi"><div class="kpi-label">Te estás llevando</div><div class="kpi-value">${fmtMoney(sueldo)}</div><div class="kpi-delta">fijo + comisión</div></div>
        </div>
        <div style="margin-top:var(--s-3);color:var(--fg-subtle);font-size:12px">Por cada ${fmtMoney(100000)} en carteles directo sumás ${fmtMoney(por100k)} de comisión 🚀</div>`;
  }
  return `
      <div style="background:linear-gradient(135deg,rgba(37,211,102,.07),transparent 55%),var(--bg-card);border:1px solid rgba(37,211,102,.35);border-radius:var(--r-md);padding:var(--s-4);margin-bottom:var(--s-5)">
        <h3 style="margin:0 0 var(--s-3);font-size:15px;letter-spacing:var(--tr-tight)">💰 Tu sueldo · ${escapeHtml(periodLbl)}</h3>
        ${inner}
      </div>`;
}

async function loadCotizadorParams() {
  if (!CONFIG.trackerUrl) return;
  // Cache optimista de COGS desde localStorage (instantáneo mientras llega el fresco).
  try {
    const cached = JSON.parse(localStorage.getItem('niventas.cogs') || 'null');
    if (cached && cached.derived) STATE.cotizadorCogs = cached;
  } catch (_) {}
  try {
    const r = await fetch(CONFIG.trackerUrl.replace(/\/$/, '') + '/cotizador/params');
    if (r.ok) {
      const j = await r.json();
      if (j.params && Object.keys(j.params).length) STATE.cotizadorParams = j.params;
    }
  } catch (e) { /* offline ok */ }
  // COGS del Excel en background (no bloquea el resto del arranque).
  loadCogsFromExcel();
}

// Lee los COGS reales del Excel 2026v4 (vía worker proxy → Apps Script) y los
// transforma en los 3 params nv_* de la fórmula nueva. Cachea en localStorage.
// opts.fresh = true bypassa el cache del worker (botón "Refrescar COGS").
async function loadCogsFromExcel(opts) {
  if (!CONFIG.trackerUrl) return null;
  const fresh = !!(opts && opts.fresh);
  try {
    const r = await fetch(CONFIG.trackerUrl.replace(/\/$/, '') + '/cotizador/cogs' + (fresh ? '?fresh=1' : ''));
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !j.ok || !j.cogs) { STATE.cotizadorCogsError = (j && j.error) || 'sin datos'; return null; }
    const c = j.cogs;
    // Derivar los params de la fórmula nueva a partir de los costos crudos:
    //   nv_costo_m2 = costo acrílico transparente + (Anibal% + Emma%) × m² imaginario
    //   nv_divisor_base = 1 − Mano de Obra − comisión Joaquín
    const derived = {
      nv_costo_m2: Math.round((+c.costo_acrilico_trans || 0) + ((+c.anibal || 0) + (+c.emma || 0)) * (+c.venta_trans_imaginario || 0)),
      nv_costo_neon_mt: Math.round(+c.costo_neon_mt || 0),
      nv_divisor_base: +(1 - (+c.mano_obra || 0) - (+c.joaquin || 0)).toFixed(4)
    };
    // Sueldo fijo de Joaco (panel "Tu sueldo"): si el Apps Script expone el mapa
    // por mes (joaquin_fijo_by_month = COGS fila 50) lo usamos; un valor único
    // (joaquin_fijo) sirve de fallback; si no, queda el mapa de CONFIG.
    if (+c.joaquin_fijo) derived.nv_joaquin_fijo = Math.round(+c.joaquin_fijo);
    const fijoByMonth = (c.joaquin_fijo_by_month && typeof c.joaquin_fijo_by_month === 'object') ? c.joaquin_fijo_by_month : null;
    STATE.cotizadorCogs = { derived, raw: c, mes: j.mes, fijoByMonth, fetchedAt: Date.now(), cached: !!j.cached };
    STATE.cotizadorCogsError = null;
    try { localStorage.setItem('niventas.cogs', JSON.stringify(STATE.cotizadorCogs)); } catch (_) {}
    // Re-render si estamos en una vista que muestra precios/params.
    if (['admin', 'cotizacion', 'presupuestos'].includes(STATE.view)) { try { render(); } catch(_){} }
    return STATE.cotizadorCogs;
  } catch (e) {
    STATE.cotizadorCogsError = e.message || String(e);
    return null;
  }
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

// Normaliza un teléfono AR a E.164 sin "+", así queda listo para WA Cloud API y bulk.
// Mismo criterio que normalizeArPhone() del worker.
function normalizeArPhoneFE(raw) {
  let n = String(raw || '').replace(/\D/g, '');
  if (!n) return '';
  if (n.startsWith('00')) n = n.slice(2);
  if (n.startsWith('54')) {
    if (!n.startsWith('549')) n = '549' + n.slice(2);
  } else {
    if (n.startsWith('15')) n = n.slice(2);
    if (n.startsWith('0'))  n = n.slice(1);
    n = '549' + n;
  }
  return n;
}

// Devuelve la lista completa de carteles del cotizador (cartel 1 + extras).
// Cada item conserva los campos del form (cliente, ancho, alto, neon, tipo).
// El campo "cliente" en este contexto es el nombre del diseño (no del comprador).
function getCarteles() {
  const f = STATE.cotizadorForm;
  const c1 = { cliente: f.cliente, ancho: f.ancho, alto: f.alto, neon: f.neon, tramos: f.tramos, tipo: f.tipo || 'INT' };
  const extras = Array.isArray(f.extraCarteles) ? f.extraCarteles : [];
  return [c1, ...extras].filter(c => +c.ancho > 0 && +c.alto > 0);
}

function buildPresupuestoTexto() {
  const carteles = getCarteles();
  if (carteles.length === 0) return null;
  const p = getCotizadorParams();

  const closing = `\n\nControladores opcionales:\n\nSlim: ${fmtMoney(p.ctrl_slim)}\n\nControl remoto: ${fmtMoney(p.ctrl_remoto)}\n\nApp: ${fmtMoney(p.ctrl_app)}\n\nTrabajamos con bases acrílicas transparentes de 3mm, la mejor calidad (NO mdf/fibrofácil/policarbonato/PETG/etc.)\nPara iniciar el trabajo, se requiere el 50% del total del cartel en concepto de seña. Aceptamos todos los medios de pago!\n\nTiempo de entrega: 15/20 días.\n\nHacemos envíos GRATIS a todo el país!`;

  if (carteles.length === 1) {
    const c = carteles[0];
    const r = calcCotizadorActivo(c);
    const nombre = (c.cliente || '').trim() || 'Custom name';
    const lineaNegra = OFRECER_BASE_NEGRA ? `\nBase negra: ${fmtMoney(r.negroFinal)}` : '';
    return `Te comparto el presupuesto con la información detallada!\n\nTrabajo: ${nombre}\nMedidas: ${Math.round(+c.ancho)}x${Math.round(+c.alto)}\nBase acrílica transparente: ${fmtMoney(r.transFinal)}${lineaNegra}${closing}`;
  }

  // 2+ carteles — cada uno con su propio nombre de diseño
  let totalTrans = 0, totalNegro = 0;
  const bloques = carteles.map((c, i) => {
    const r = calcCotizadorActivo(c);
    totalTrans += r.transFinal;
    totalNegro += r.negroFinal;
    const disen = (c.cliente || '').trim() || `Cartel ${i+1}`;
    const lineaNegraB = OFRECER_BASE_NEGRA ? `\nBase negra: ${fmtMoney(r.negroFinal)}` : '';
    return `${disen} — ${Math.round(+c.ancho)}x${Math.round(+c.alto)} cm\nBase acrílica transparente: ${fmtMoney(r.transFinal)}${lineaNegraB}`;
  }).join('\n\n');

  const trabajo = carteles.map(c => (c.cliente || '').trim()).filter(Boolean).join(' · ') || 'Custom name';
  const totalLabel = OFRECER_BASE_NEGRA ? 'Total transparente' : 'Total';
  const totalNegroLinea = OFRECER_BASE_NEGRA ? `\nTotal negro: ${fmtMoney(totalNegro)}` : '';
  return `Te comparto el presupuesto con la información detallada!\n\nTrabajo: ${trabajo}\n\n${bloques}\n\n${totalLabel}: ${fmtMoney(totalTrans)}${totalNegroLinea}${closing}`;
}

function getPresupuestoTextoFinal() {
  // Si el usuario editó manualmente, usamos esa versión. Si no, la auto-generada.
  const override = STATE.cotizadorForm.textoOverride;
  if (override && override.trim()) return override;
  // Los precios del presupuesto que se MANDA al cliente van SIEMPRE con el valor real,
  // aunque el modo privacidad (STATE.privacy) esté activo en pantalla — sino se le manda
  // "$•••" al cliente (bug: con privacy activo, Nadia mandó un presupuesto sin precios).
  const prevPriv = STATE.privacy;
  STATE.privacy = false;
  try { return buildPresupuestoTexto(); }
  finally { STATE.privacy = prevPriv; }
}

function copiarPresupuesto() {
  const texto = getPresupuestoTextoFinal();
  if (!texto) { showAlert('Completá al menos ancho y alto', { title: 'Faltan datos' }); return; }
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

// Manda el presupuesto como PLANTILLA aprobada 'presupuesto_detallado' (5 vars:
// nombre, ancho, alto, precio transparente, precio negro). Se usa cuando la
// ventana de 24h está cerrada (ej. presupuesto del lunes de una consulta del
// sábado) y Meta no deja mandar texto libre. La plantilla es de UN diseño.
async function enviarPresupuestoComoPlantilla(tel, carteles, renderKey) {
  if (!carteles || carteles.length !== 1) {
    return { ok: false, error: 'La ventana de 24h está cerrada y la plantilla de presupuesto es para UN diseño. Para varios carteles, esperá que el cliente escriba o mandá uno por uno.' };
  }
  const c = carteles[0];
  const r = calcCotizadorActivo(c);
  const nombre = (c.cliente || '').trim() || 'tu local';
  const ancho = String(Math.round(+c.ancho));
  const alto = String(Math.round(+c.alto));
  // Precios SIEMPRE reales en la plantilla (ignorar el modo privacidad de pantalla,
  // sino los precios salen "$•••" al cliente).
  const _pp = STATE.privacy; STATE.privacy = false;
  const precioTrans = fmtMoney(r.transFinal), precioNegro = fmtMoney(r.negroFinal);
  STATE.privacy = _pp;
  // Plantillas 'presupuesto_detallado(_img)2' = SIN base negra (4 vars, jul-2026). Se prefieren;
  // las viejas (con negra, 5 vars) quedan de red hasta que Meta apruebe las nuevas.
  const paramsNew = [nombre, ancho, alto, precioTrans];
  const paramsOld = [nombre, ancho, alto, precioTrans, precioNegro];
  const useImg = !!renderKey;
  const ok = await showConfirm(
    `La ventana de 24h está cerrada, así que el presupuesto va como PLANTILLA aprobada${useImg ? ' CON el render' : ''} (incluye los controladores, seña 50%, 3 cuotas con 10%, 10 días hábiles y envío gratis).\n\n` +
    `Trabajo: ${nombre}\nMedidas: ${ancho} x ${alto}\nBase transparente: ${precioTrans}\n\n¿Lo mando?`,
    { title: 'Enviar como plantilla', confirmLabel: '📤 Mandar plantilla', cancelLabel: 'Cancelar' }
  );
  if (!ok) return { ok: false, cancelled: true };
  const post = (name, withImg, prms) => fetch(CONFIG.trackerUrl + '/admin/wa/template', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ to: tel, name, lang: 'es', params: prms, header_image_key: withImg ? renderKey : undefined })
  });
  // Cascada: nueva-con-img → nueva-texto → vieja-con-img → vieja-texto. La 1ra que Meta
  // acepta gana. Sin bache: hasta que aprueben las "2" (sin negra), siguen andando las viejas.
  const attempts = [];
  if (useImg) attempts.push(['presupuesto_detallado_img2', true, paramsNew]);
  attempts.push(['presupuesto_detallado2', false, paramsNew]);
  if (useImg) attempts.push(['presupuesto_detallado_img', true, paramsOld]);
  attempts.push(['presupuesto_detallado', false, paramsOld]);
  try {
    let tj = {}, okSent = false, usedImg = false;
    for (const [nm, wi, pr] of attempts) {
      const tr = await post(nm, wi, pr);
      tj = await tr.json().catch(() => ({}));
      if (tr.ok) { okSent = true; usedImg = wi; break; }
    }
    if (!okSent) return { ok: false, error: 'No se pudo mandar la plantilla: ' + (tj.error || 'sin detalle') };
    toast(usedImg ? 'Mandado como plantilla con render ✓' : 'Mandado como plantilla aprobada ✓');
    return { ok: true, wamid: tj.id || '' };
  } catch (e) {
    return { ok: false, error: 'Error de red al mandar la plantilla' };
  }
}

async function enviarPresupuestoWA() {
  const f = STATE.cotizadorForm;
  const carteles = getCarteles();
  if (carteles.length === 0) { await showAlert('Completá al menos ancho y alto', { title: 'Faltan datos' }); return; }
  const sinNombre = carteles.findIndex(c => !(c.cliente || '').trim());
  if (sinNombre !== -1) {
    await showAlert(`Falta el nombre de diseño del cartel ${sinNombre+1} (se guarda también en el Sheet)`, { title: 'Falta el diseño' });
    return;
  }
  const tel = (f.telefono || '').trim();
  if (!tel) { await showAlert('Completá el teléfono del cliente', { title: 'Falta el teléfono' }); return; }
  const digits = tel.replace(/\D/g, '');
  if (digits.length < 8) { await showAlert('El teléfono parece inválido (' + digits.length + ' dígitos). Argentina necesita al menos 8 dígitos sin contar el código de país.', { title: 'Teléfono inválido', variant: 'warn' }); return; }
  if (!STATE.token) { await showAlert('Tenés que estar logueado (Gaspar o Joaquín) para enviar por WhatsApp', { title: 'Login requerido', variant: 'warn' }); return; }
  if (!CONFIG.trackerUrl) { await showAlert('Tracker no configurado', { title: 'Error de configuración', variant: 'warn' }); return; }
  const texto = getPresupuestoTextoFinal();
  if (!texto) return;
  STATE.cotizadorSendingWA = true;
  updateCotizadorForm();
  let waOk = false;
  let wamid = '';
  try {
    // Si hay render IA generado, se manda como FOTO con el texto del presupuesto
    // en el caption (misma lógica que el panel de cotización). Si no, texto solo.
    const tieneRender = !!(f.renderResult && f.renderResult.base64);
    let r;
    if (tieneRender) {
      const blob = b64ToBlob(f.renderResult.base64, f.renderResult.mime);
      const fd = new FormData();
      fd.append('to', tel);
      fd.append('type', 'image');
      fd.append('caption', texto);
      fd.append('file', blob, 'render.png');
      r = await fetch(CONFIG.trackerUrl + '/admin/wa/send-media', { method: 'POST', headers: authHeaders(), body: fd });
    } else {
      r = await fetch(CONFIG.trackerUrl + '/admin/wa/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ to: tel, body: texto, check_window: true })
      });
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const detail = j.error || 'no se pudo enviar';
      // Ventana de 24h cerrada (típico del lunes con consulta del finde): Meta
      // rechaza el texto libre. Lo mandamos como plantilla aprobada.
      const windowClosed = /outside|24|window|template|131047|re-?engag/i.test(String(detail));
      if (windowClosed) {
        const sent = await enviarPresupuestoComoPlantilla(tel, carteles, j.render_key);
        if (sent.ok) { waOk = true; wamid = sent.wamid || ''; }
        else { if (!sent.cancelled) await showAlert(sent.error || detail, { title: 'No se pudo enviar', variant: 'warn' }); return; }
      } else {
        await showAlert(detail, { title: 'No se pudo enviar', variant: 'warn' });
        return;
      }
    } else {
      waOk = true;
      wamid = j.id || '';
      // OJO: r.ok solo significa que Meta aceptó el request — no que entregó.
      // El webhook puede marcarlo como 'failed' después.
      toast('Mandado a WhatsApp · verificando entrega…');
    }
  } catch (e) {
    await showAlert('Error de red al enviar', { title: 'Error de conexión', variant: 'warn' });
  } finally {
    STATE.cotizadorSendingWA = false;
    updateCotizadorForm();
  }
  // Si el envío salió bien, guardar también en Sheet (un envío = un presupuesto registrado).
  if (waOk) {
    await saveCotizacion();
    // Limpiar el render para que no quede pegado al próximo presupuesto.
    STATE.cotizadorForm.renderInput = null;
    STATE.cotizadorForm.renderResult = null;
    STATE.cotizadorRenderGenerating = false;
    // Verificar entrega real en background (no bloquea la UI).
    if (wamid) verificarEntregaWA(wamid, tel);
  }
}

async function verificarEntregaWA(wamid, phone) {
  // Polling: cada 3s hasta 18s, mira si el status cambió a delivered/read/failed.
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const r = await fetch(CONFIG.trackerUrl + '/admin/wa/messages?phone=' + encodeURIComponent(phone) + '&limit=30', {
        headers: authHeaders()
      });
      const j = await r.json();
      const msg = (j.messages || []).find(m => m.wamid === wamid);
      if (!msg) continue;
      if (msg.status === 'failed') {
        await showAlert(
          'El mensaje a ' + phone + ' NO se entregó.\n\nLo más probable: el cliente está fuera de la ventana de 24h de WhatsApp (no te escribió en las últimas 24hs).\n\nEl presupuesto quedó guardado en el Sheet pero no llegó al cliente.',
          { title: 'Entrega fallida', variant: 'warn' }
        );
        return;
      }
      if (msg.status === 'delivered' || msg.status === 'read') {
        toast('✓ Entregado a ' + phone);
        return;
      }
    } catch (_) {}
  }
  // Timeout: el status sigue 'sent' después de 18s — queda en cola
  toast('Mensaje en cola · chequeá el chat para confirmar entrega');
}

async function verFallosWA() {
  if (!STATE.token) { await showAlert('Tenés que estar logueado', { title: 'Login requerido', variant: 'warn' }); return; }
  if (!CONFIG.trackerUrl) { await showAlert('Tracker no configurado', { title: 'Error', variant: 'warn' }); return; }
  toast('Buscando presupuestos fallidos…');
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let all = [];
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/messages?direction=outbound&from=' + encodeURIComponent(since) + '&limit=2000', {
      headers: authHeaders()
    });
    const j = await r.json();
    all = j.messages || [];
  } catch (e) { await showAlert('Error al consultar el worker', { title: 'Error de red', variant: 'warn' }); return; }
  const fallos = all.filter(m =>
    m.status === 'failed' && isPresupuestoMessage(m.body)
  );
  if (fallos.length === 0) {
    await showAlert(
      'Todos los presupuestos enviados por el cotizador en las últimas 24hs llegaron al servidor de WhatsApp y fueron aceptados.',
      { title: 'Sin fallos ✓', variant: 'success' }
    );
    return;
  }
  // Agrupar por teléfono (último intento por cliente)
  const byPhone = new Map();
  for (const m of fallos) {
    const ex = byPhone.get(m.phone);
    if (!ex || new Date(m.ts) > new Date(ex.ts)) byPhone.set(m.phone, m);
  }
  const list = [...byPhone.values()].sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const lines = list.map(m => {
    const trabajo = (m.body.match(/Trabajo: ([^\n]+)/) || [])[1] || '(sin nombre)';
    const hora = new Date(m.ts).toLocaleString('es-AR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    return `• ${m.phone} — ${trabajo} (${hora})`;
  }).join('\n');
  await showAlert(
    `${lines}\n\nLa causa más común: el cliente no escribió al número de WA Business en las últimas 24h, así que la API de WhatsApp no permite mandarle texto libre.`,
    { title: `${list.length} presupuesto${list.length > 1 ? 's' : ''} no entregado${list.length > 1 ? 's' : ''}`, variant: 'warn' }
  );
}

// Aceptamos AMBOS prefijos (viejo + nuevo) para no perder detección de
// presupuestos históricos al cambiar la plantilla. La plantilla nueva
// (mayo 2026) arranca con "Te comparto el presupuesto con..." y la vieja
// con "Te comparto la información detallada!".
const PRESUPUESTO_PREFIXES = [
  'Te comparto el presupuesto con la información detallada!',
  'Te comparto la información detallada!'
];
const PRESUPUESTO_PREFIX = PRESUPUESTO_PREFIXES[0]; // back-compat
function isPresupuestoMessage(body) {
  const b = String(body || '');
  return PRESUPUESTO_PREFIXES.some(p => b.startsWith(p));
}
const FOLLOWUP_PRESUPUESTO_TEXT = 'Aca te dejamos el presupuesto! Decinos que te parece? si hay algun cambio o ajuste que quieras hacer, tambien si tenes foto de donde lo vas a poner te podemos hacer un montaje digital de como quedaría!';
const FOLLOWUP_PRESUPUESTO_PREFIX = 'Aca te dejamos el presupuesto!';

async function enviarFollowupsPresupuesto(opts) {
  const force = !!(opts && opts.force);
  if (!STATE.token) { await showAlert('Tenés que estar logueado para enviar follow-ups', { title: 'Login requerido', variant: 'warn' }); return; }
  if (!CONFIG.trackerUrl) { await showAlert('Tracker no configurado', { title: 'Error', variant: 'warn' }); return; }

  toast(force ? 'Buscando presupuestos para forzar follow-up…' : 'Buscando presupuestos sin respuesta…');

  // 1) Outbound de las últimas 24h
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let outbound = [];
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/messages?direction=outbound&from=' + encodeURIComponent(since) + '&limit=2000', {
      headers: authHeaders()
    });
    const j = await r.json();
    outbound = j.messages || [];
  } catch (e) { await showAlert('Error de red al buscar mensajes', { title: 'Error de red', variant: 'warn' }); return; }

  // 2) Filtrar presupuestos del cotizador (texto que arranca con cualquiera
  // de los prefijos conocidos — viejo o nuevo, para mantener históricos).
  const presupuestos = outbound.filter(m => isPresupuestoMessage(m.body));

  // 3) Quedarse con el último presupuesto por teléfono
  const byPhone = new Map();
  for (const p of presupuestos) {
    const ex = byPhone.get(p.phone);
    if (!ex || new Date(p.ts) > new Date(ex.ts)) byPhone.set(p.phone, p);
  }

  // 4) Filtrar los enviados hace > 1h (sino es muy pronto para insistir)
  // En modo force se saltea esta restricción — útil para test inmediato.
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const candidates = force
    ? [...byPhone.values()]
    : [...byPhone.values()].filter(p => new Date(p.ts).getTime() < oneHourAgo);

  if (candidates.length === 0) {
    await showAlert(
      force
        ? 'No hay presupuestos enviados en las últimas 24h.'
        : 'No hay presupuestos enviados hace más de 1 hora.',
      { title: 'Nada para enviar' }
    );
    return;
  }

  // 5) Para cada uno, chequear conversación: ¿respondió? ¿ya tiene follow-up?
  const toSend = [];
  let respondidos = 0;
  let yaFollowedUp = 0;
  for (const p of candidates) {
    try {
      const r = await fetch(CONFIG.trackerUrl + '/admin/wa/messages?phone=' + encodeURIComponent(p.phone) + '&from=' + encodeURIComponent(p.ts) + '&limit=200', {
        headers: authHeaders()
      });
      const j = await r.json();
      const msgs = j.messages || [];
      const respondio = msgs.some(m => m.direction === 'inbound' && new Date(m.ts) > new Date(p.ts));
      if (respondio) { respondidos++; continue; }
      const yaFu = msgs.some(m => m.direction === 'outbound' && new Date(m.ts) > new Date(p.ts) && (m.body || '').startsWith(FOLLOWUP_PRESUPUESTO_PREFIX));
      if (yaFu) { yaFollowedUp++; continue; }
      toSend.push(p);
    } catch (_) { /* skip on error */ }
  }

  if (toSend.length === 0) {
    await showAlert(
      `${respondidos} ya respondieron, ${yaFollowedUp} ya tienen follow-up.`,
      { title: 'Nada para enviar' }
    );
    return;
  }

  const lista = toSend.map(p => `• ${p.sender_name || p.phone} (${p.phone})`).join('\n');
  const ok = await showConfirm(
    `${lista}\n\nDescartados: ${respondidos} respondieron, ${yaFollowedUp} ya tenían follow-up.`,
    {
      title: `Enviar ${toSend.length} follow-up${toSend.length > 1 ? 's' : ''}`,
      confirmLabel: 'Enviar todos',
      cancelLabel: 'Cancelar'
    }
  );
  if (!ok) return;

  // 6) Enviar uno por uno con pequeño delay
  let sent = 0, failed = 0;
  const errors = [];
  for (const p of toSend) {
    try {
      const r = await fetch(CONFIG.trackerUrl + '/admin/wa/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ to: p.phone, body: FOLLOWUP_PRESUPUESTO_TEXT })
      });
      if (r.ok) { sent++; }
      else {
        failed++;
        const j = await r.json().catch(() => ({}));
        errors.push(`${p.sender_name || p.phone}: ${j.error || 'error'}`);
      }
    } catch (e) {
      failed++;
      errors.push(`${p.sender_name || p.phone}: red`);
    }
    await new Promise(r => setTimeout(r, 600));
  }
  const msg = `Enviados: ${sent}\nFallidos: ${failed}` + (errors.length ? `\n\nErrores:\n${errors.slice(0, 10).join('\n')}` : '');
  await showAlert(msg, {
    title: 'Resultado del envío',
    variant: failed > 0 ? 'warn' : 'success'
  });
}

function postCartelToSheet(payload) {
  return new Promise((resolve, reject) => {
    const id = 'cot-iframe-' + Date.now() + '-' + Math.random().toString(36).slice(2,7);
    const iframe = document.createElement('iframe');
    iframe.name = id;
    iframe.style.display = 'none';
    document.body.appendChild(iframe);

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = CONFIG.appsScriptUrl;
    form.target = id;
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'data';
    input.value = JSON.stringify(payload);
    form.appendChild(input);
    document.body.appendChild(form);

    iframe.onload = () => {
      setTimeout(() => { iframe.remove(); form.remove(); }, 500);
      resolve();
    };
    iframe.onerror = () => {
      iframe.remove(); form.remove();
      reject(new Error('Error de red'));
    };
    setTimeout(() => { resolve(); iframe.remove(); form.remove(); }, 8000);

    form.submit();
  });
}

async function saveCotizacion() {
  if (!CONFIG.appsScriptUrl) { await showAlert('Falta configurar CONFIG.appsScriptUrl (Google Apps Script)', { title: 'Error de configuración', variant: 'warn' }); return; }
  const f = STATE.cotizadorForm;
  const carteles = getCarteles();
  if (carteles.length === 0) { await showAlert('Completá al menos ancho y alto', { title: 'Faltan datos' }); return; }
  // Cada cartel necesita su propio nombre de diseño (campo "cliente").
  const sinNombre = carteles.findIndex(c => !(c.cliente || '').trim());
  if (sinNombre !== -1) {
    await showAlert(`Falta el nombre de diseño del cartel ${sinNombre+1}`, { title: 'Falta el diseño' });
    return;
  }
  if (f.canal === 'WPP' && !f.telefono.trim()) { await showAlert('Completá el teléfono del cliente (obligatorio para WPP)', { title: 'Falta el teléfono' }); return; }
  STATE.cotizadorSaving = true;
  updateCotizadorForm();
  const telRaw = (f.telefono || '').trim();
  const canal = f.canal || 'WPP';
  const telFinal = canal === 'WPP' ? normalizeArPhoneFE(telRaw) : telRaw;
  const multi = carteles.length > 1;
  try {
    for (let i = 0; i < carteles.length; i++) {
      const c = carteles[i];
      // Calculamos AMBAS fórmulas y mandamos todo al Sheet. La de "activo"
      // (transicionUseNueva) es la que el cliente recibe; la otra queda
      // como referencia histórica para validar la transición con datos reales.
      const r       = calcCotizadorActivo(c);
      const rNueva  = calcCotizadorNuevo(c);
      const rViejo  = calcCotizador(c);
      const payload = {
        cliente: c.cliente.trim(),
        ancho: +c.ancho,
        alto: +c.alto,
        neon: +c.neon || 0,
        tramos: +c.tramos || 0,
        tipo: c.tipo || 'INT',
        m2: r.m2,
        trans: r.trans,
        negro: r.negro,
        descuento: r.descuento,
        recargo: r.recargo,
        reventa: r.reventa,
        comision: r.comision,
        canal,
        telefono: telFinal,
        // Campos nuevos (para apps-script que los grabe al final del row):
        cf: rNueva.cf,
        margen: rNueva.margen,
        densidad: rNueva.densidad,
        precio_nuevo: rNueva.transFinal,
        precio_viejo: rViejo.transFinal
      };
      await postCartelToSheet(payload);
    }
    STATE.cotizadorForm = { ancho: '', alto: '', neon: '', tramos: '', tipo: 'INT', cliente: '', canal: 'WPP', telefono: '', textoOverride: '', extraCarteles: [] };
    toast(multi ? `${carteles.length} carteles guardados ✓` : 'Cotización guardada ✓');
    setTimeout(() => loadAll(), 2000);
  } catch (e) {
    await showAlert(e.message, { title: 'Error al guardar', variant: 'warn' });
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

// ============ COTIZADOR NUEVO (spec-cotizador-nuevo.md) ============
// Modelo: costo real (COGS) + margen objetivo variable.
// Input: { ancho, alto, neon (mt), tramos (cantidad), tipo (INT|EXT) }
// Devuelve mismo shape que calcCotizador para que los consumers no rompan,
// PLUS: cf, margen, densidad (para diagnóstico/UI comparativa).
//
// Diferencias vs la vieja:
//  - Margen variable por tamaño y complejidad (no markup ×3 fijo).
//  - m² real (÷10.000) en vez del m² "del Sheet" (÷100).
//  - Negro = transparente × nv_negro_ratio (no fórmula propia).
//  - Sin recargos/descuentos automáticos (la spec dice "precio sale justo").
//  - EXT mantiene tiers actuales (ext_25/ext_50/ext_99) — se suma al precio.
function calcCotizadorNuevo(input) {
  const p = getCotizadorParams();
  const ancho   = +input.ancho  || 0;
  const alto    = +input.alto   || 0;
  const metros  = +input.neon   || 0;
  const tramos  = +input.tramos || 0;
  const tipo    = (input.tipo || 'INT').toUpperCase();

  const m2 = (ancho * alto) / 10000;  // m² real
  const cm = metros * 100;
  // Para mantener back-compat con el "m²" que graba el Sheet (división /100),
  // lo seguimos exponiendo igual:
  const m2Sheet = (ancho * alto) / 100;

  // Fuente por cm
  const fuente = cm <= 500 ? p.nv_fuente_corto
               : cm <  1200 ? p.nv_fuente_medio
               : p.nv_fuente_largo;

  // Costo fijo
  const cf = m2 * p.nv_costo_m2 + fuente + p.nv_costo_neon_mt * metros;

  // Margen por tamaño (interpolación log sobre el CF)
  const lo = Math.log(p.nv_cf_ref_chico);
  const hi = Math.log(p.nv_cf_ref_grande);
  const x  = Math.max(0, Math.min(1, (Math.log(Math.max(cf, 1)) - lo) / (hi - lo)));
  const margenTam = p.nv_margen_chico - (p.nv_margen_chico - p.nv_margen_grande) * x;

  // Complejidad por densidad
  const densidad = metros > 0 ? tramos / metros : 0;
  const ajuste = Math.max(-p.nv_complejidad_tope,
                  Math.min(p.nv_complejidad_tope,
                    p.nv_complejidad_coef * (densidad - p.nv_complejidad_pivote)));

  const margen = Math.max(p.nv_margen_min, Math.min(p.nv_margen_max, margenTam + ajuste));

  // Precio: CF / (0.815 − margen). Suma EXT si corresponde, después redondea a $500.
  let precio = cf / (p.nv_divisor_base - margen);
  if (tipo === 'EXT') {
    precio += m2Sheet <= 25 ? p.ext_25 : m2Sheet <= 50 ? p.ext_50 : p.ext_99;
  }
  const transFinal = redondMult(precio, 500);
  const negroFinal = redondMult(transFinal * p.nv_negro_ratio, 500);

  // Comisión Joaco 5% del precio (info — ya está incluida en el divisor 0.815).
  const comision = Math.round(transFinal * p.comision_pct);
  // Reventa (info, igual que antes).
  const reventa = redondMult(transFinal * p.reventa_mult, 500);

  // Devuelve shape compatible + extras para UI comparativa.
  return {
    // Diagnóstico nuevo
    cf, margen, densidad, fuente,
    // Shape compatible con calcCotizador (sin recargos/descuentos)
    m2: m2Sheet, m2real: m2,
    trans: transFinal, negro: negroFinal,
    descuento: 0, descuentoNegro: 0, recargo: 0, recargoNegro: 0,
    reventa, comision,
    transFinal, negroFinal
  };
}

// Helper: devuelve la función de cálculo activa según el toggle de transición.
// Default = nueva (transicionUseNueva true en cotizadorDefaults). El presupuesto
// que se envía al cliente sale de acá.
function calcCotizadorActivo(input) {
  const p = getCotizadorParams();
  return p.transicionUseNueva ? calcCotizadorNuevo(input) : calcCotizador(input);
}

// ============ USUARIO ============
function loadUser() {
  // Merge: los usuarios por defecto SIEMPRE están presentes (aunque el localStorage
  // tenga una lista vieja cacheada), + cualquiera que el usuario haya agregado con "+".
  let stored = [];
  try { stored = JSON.parse(localStorage.getItem('niventas.users') || 'null') || []; }
  catch(e) { stored = []; }
  const merged = CONFIG.defaultUsers.slice();
  for (const u of stored) {
    if (!merged.some(x => x.toLowerCase() === String(u).toLowerCase())) merged.push(u);
  }
  STATE.users = merged;
  STATE.user = localStorage.getItem('niventas.user') || null;
  STATE.token = localStorage.getItem('niventas.token') || null;
  STATE.tokenUser = localStorage.getItem('niventas.tokenUser') || null;
  // Si el token cargado no corresponde al usuario activo (estado viejo/manipulado),
  // lo descartamos por seguridad: hay que re-autenticar.
  if (STATE.token && STATE.user && _userKey(STATE.tokenUser) !== _userKey(STATE.user)) {
    saveToken(null);
  }
}
function saveUser() {
  localStorage.setItem('niventas.users', JSON.stringify(STATE.users));
  if (STATE.user) localStorage.setItem('niventas.user', STATE.user);
  else localStorage.removeItem('niventas.user');
}
function saveToken(t, owner) {
  STATE.token = t;
  STATE.tokenUser = t ? (owner || STATE.user || null) : null;
  if (t) {
    localStorage.setItem('niventas.token', t);
    localStorage.setItem('niventas.tokenUser', STATE.tokenUser || '');
  } else {
    localStorage.removeItem('niventas.token');
    localStorage.removeItem('niventas.tokenUser');
  }
}
// Normaliza nombre de usuario para comparaciones tolerantes a tilde.
// Soporta variantes históricas en localStorage (Joaquin / Joaquín).
function _userKey(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function isJoaquinUser(s) { return _userKey(s) === 'joaquin' || _userKey(s) === 'joaco'; }
// Nadia: 2da vendedora (rol comercial, como Joaco). Ve el Chat WA y trabaja carteles.
function isNadiaUser(s) { return _userKey(s) === 'nadia'; }
function isGasparUser(s) { return _userKey(s) === 'gaspar'; }
function isDisenadorUser(s) { const k = _userKey(s); return k === 'disenador' || k === 'emma' || k === 'emmanuel'; }
// Abril: usuario de la bandeja de Cursos. Solo ve el Chat WA, y dentro solo los
// chats derivados a 'cursos'.
function isCursosUser(s) { const k = _userKey(s); return k === 'abril' || k === 'cursos'; }
// El token cargado pertenece a este usuario? (evita reutilizar token de bajo
// privilegio para pasar como admin).
function tokenBelongsTo(name) {
  return !!STATE.token && _userKey(STATE.tokenUser) === _userKey(name);
}

async function setUser(name) {
  // SEGURIDAD: el token está atado a un usuario. Si el token actual NO pertenece
  // al usuario que se quiere activar, hay que re-autenticar. IMPORTANTE: NO
  // descartamos el token viejo ANTES de loguear — si el login se cancela o falla
  // (no te acordás la contraseña, cerrás el prompt), el usuario debe quedar como
  // estaba, con su sesión intacta, NO deslogueado. loginPrompt, al tener éxito,
  // reemplaza el token de forma atómica (saveToken con owner=name). Si falla,
  // volvemos sin tocar nada: el token viejo sigue siendo del usuario viejo y
  // STATE.user tampoco se actualiza → no hay escalada de privilegios.
  if (!tokenBelongsTo(name)) {
    // Todos los usuarios requieren contraseña (Gaspar, Joaquín, Nadia, Diseñador, Abril).
    const ok = await loginPrompt(name);
    if (!ok) return;
  }
  STATE.user = name;
  saveUser();
  render();
  // Pre-load chat contacts in background for unread badge
  if (canAccessChat() && !chatState.contacts.length) {
    loadChatContacts().then(() => updateUnreadBadge());
  }
  // Notificaciones funcionan aunque no estés en la vista del Chat — arrancamos
  // el web worker apenas el user puede acceder.
  if (canAccessChat()) {
    ensureNotificationPermission();
    initPollWorker();
  }
}
async function loginPrompt(userName) {
  if (!CONFIG.trackerUrl) {
    await showAlert('El backend de auth no está configurado. Ver CONFIG.trackerUrl.', { title: 'Error de configuración', variant: 'warn' });
    return false;
  }
  const pw = await showPasswordPrompt(userName);
  if (!pw) return false;
  try {
    const r = await fetch(CONFIG.trackerUrl.replace(/\/$/, '') + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: userName || 'Gaspar', password: pw })
    });
    if (r.status === 401) { await showAlert('Contraseña incorrecta', { title: 'Login fallido', variant: 'warn' }); return false; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    saveToken(j.token, userName || 'Gaspar');
    return true;
  } catch (e) {
    await showAlert(e.message, { title: 'Error de login', variant: 'warn' });
    return false;
  }
}
async function autoLogin(userName) {
  if (!CONFIG.trackerUrl) return false;
  try {
    const r = await fetch(CONFIG.trackerUrl.replace(/\/$/, '') + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: userName })
    });
    if (!r.ok) return false;
    const j = await r.json();
    saveToken(j.token, userName);
    return true;
  } catch (e) { return false; }
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
  teardownPollWorker();
  // Si estaba con usuario privilegiado, lo dejo sin usuario para que tenga que re-loguearse
  if (isGasparUser(STATE.user) || isJoaquinUser(STATE.user)) { STATE.user = null; saveUser(); }
  // Si estaba en vista admin, salir
  if (STATE.view === 'admin') setView('dashboard');
  else render();
}
// isAdmin requiere que el TOKEN sea de Gaspar (no solo el nombre activo). Sin esto,
// un token de bajo privilegio podría usarse para mostrar la UI admin.
function isAdmin() { return !!STATE.token && isGasparUser(STATE.tokenUser) && isGasparUser(STATE.user); }
function canAccessChat() { return !!STATE.token && tokenBelongsTo(STATE.user) && (isGasparUser(STATE.user) || isJoaquinUser(STATE.user) || isNadiaUser(STATE.user) || isCursosUser(STATE.user)); }
// Abril (rol cursos): SOLO ve la sección Chat WA, nada más.
function isCursosOnly() { return isCursosUser(STATE.user); }
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
  // Hora opcional al final: " HH:mm" o " HH:mm:ss"
  const timeMatch = v.match(/\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  const hh = timeMatch ? parseInt(timeMatch[1]) : 0;
  const mi = timeMatch ? parseInt(timeMatch[2]) : 0;
  const ss = timeMatch && timeMatch[3] ? parseInt(timeMatch[3]) : 0;
  const datePart = timeMatch ? v.slice(0, timeMatch.index) : v;
  // ISO yyyy-mm-dd (with optional time): unambiguous
  let m = datePart.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]), hh, mi, ss);
    return isNaN(d) ? null : d;
  }
  // AR: dd/mm/yyyy or dd/mm/yy
  m = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
    const d = new Date(yr, parseInt(m[2]) - 1, parseInt(m[1]), hh, mi, ss);
    return isNaN(d) ? null : d;
  }
  // AR: d/m (sin año — asume año actual)
  m = datePart.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    const d = new Date(new Date().getFullYear(), parseInt(m[2]) - 1, parseInt(m[1]), hh, mi, ss);
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

function fmtMoney(n) {
  if (STATE.privacy) return '$•••';
  return '$' + Math.round(n||0).toLocaleString('es-AR');
}
// Toggle privacy mode (oculta números económicos, estilo billetera virtual)
function togglePrivacy() {
  STATE.privacy = !STATE.privacy;
  try { localStorage.setItem('privacy_mode', STATE.privacy ? '1' : '0'); } catch(_) {}
  render();
}
function fmtDate(d) { if (!d) return '—'; return d.toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'2-digit' }); }
function fmtDateTime(d) {
  if (!d) return '—';
  const date = d.toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'2-digit' });
  // Solo mostrar hora si está presente (las filas viejas sin hora son 00:00:00)
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) return date;
  const hh = String(d.getHours()).padStart(2,'0');
  const mm = String(d.getMinutes()).padStart(2,'0');
  return `${date} ${hh}:${mm}`;
}
function fmtDateLong(d) { if (!d) return '—'; return d.toLocaleDateString('es-AR', { day:'2-digit', month:'long', year:'numeric' }); }
function daysBetween(a, b) {
  // Diferencia en días calendario (ignora hora/min/seg) — evita falsos negativos
  // cuando una fecha tiene hora > 00:00 y la otra está fija a medianoche local.
  if (!a || !b) return 0;
  const da = new Date(a); da.setHours(0,0,0,0);
  const db = new Date(b); db.setHours(0,0,0,0);
  return Math.round((db - da) / 86400000);
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function normName(s) { return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'').trim(); }

// ============ LOAD ============
// Fetch con timeout: aborta si tarda más de N ms. Sin esto, una request
// colgada de Apps Script o de gviz dejaba el spinner eterno.
async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ===== Backoff global de polling (anti-cascada de sobrecarga de D1) =====
// Si el worker responde 503 (db_busy, típ. "D1 DB is overloaded") o un poll falla
// por red, frenamos los POLLS de fondo 20-40s (con jitter, para no re-sincronizar
// a todos los clientes) en vez de seguir martillando una D1 saturada -> corta la
// cascada. Un wrapper fino de fetch OBSERVA las respuestas del tracker y marca el
// flag; NO bloquea nada. Los timers de polling consultan pollBackoffActive() y se
// saltan el tick; las acciones del usuario (abrir chat, enviar, refrescar) pasan
// siempre, y una respuesta ok del tracker limpia el backoff.
let _pollBackoffUntil = 0;
function pollBackoffActive() { return Date.now() < _pollBackoffUntil; }
function _notePollBusy() { _pollBackoffUntil = Date.now() + 20000 + Math.floor(Math.random() * 20000); }
(function installPollBackoffProbe() {
  if (typeof window === 'undefined' || !window.fetch || window.__niPollBackoff) return;
  window.__niPollBackoff = true;
  const _orig = window.fetch.bind(window);
  window.fetch = function (input, init) {
    let url = '';
    try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (_) {}
    const isTracker = !!(CONFIG && CONFIG.trackerUrl) && url.indexOf(CONFIG.trackerUrl) === 0;
    return _orig(input, init).then(res => {
      if (isTracker) {
        if (res.status === 503) _notePollBusy();
        else if (res.ok) _pollBackoffUntil = 0;
      }
      return res;
    }, err => {
      if (isTracker) _notePollBusy();
      throw err;
    });
  };
})();

async function fetchSheet(id, sheet) {
  const url = csvUrl(id, sheet);
  try {
    const r = await fetchWithTimeout(url, {}, 12000);
    if (!r.ok) throw new Error(`${sheet}: ${r.status}`);
    const text = await r.text();
    return parseCSV(text);
  } catch (e) {
    console.warn(`Sheet "${sheet}" no disponible:`, e.message);
    return null;
  }
}

// Fetch del cotizador via Apps Script Web App (devuelve display values raw).
// 8s timeout — Apps Script tiene cold-start hasta de varios segundos pero si
// pasa de eso, fallback a gviz (más rápido aunque pierde teléfonos con +).
async function fetchCotizadorViaAppsScript(sheetName) {
  if (!CONFIG.appsScriptUrl) return null;
  try {
    const url = CONFIG.appsScriptUrl.replace(/\/$/, '') + '?action=rows&sheet=' + encodeURIComponent(sheetName);
    const r = await fetchWithTimeout(url, { redirect: 'follow' }, 8000);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !Array.isArray(j.rows)) return null;
    return j.rows;
  } catch (e) {
    console.warn('Apps Script fetch falló, fallback a gviz:', e.message);
    return null;
  }
}

// Caché de pedidos + presupuestos en localStorage para mostrar data al instante
// en el siguiente reload mientras se refresca en background (stale-while-revalidate).
const CACHE_KEY = 'niventas.cache.v1';
function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || !j.ts) return null;
    // Re-hidratar fechas: parseDate ya las maneja como objetos Date al guardar
    // estaban serializadas como ISO strings. Las convertimos de vuelta.
    const reviveDate = (d) => d ? new Date(d) : null;
    j.pedidos.forEach(p => { p.fecha = reviveDate(p.fecha); });
    j.presupuestos.forEach(p => { p.fecha = reviveDate(p.fecha); });
    return j;
  } catch (_) { return null; }
}
function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      ts: Date.now(),
      pedidos: STATE.pedidos,
      presupuestos: STATE.presupuestos
    }));
  } catch (_) {}
}

// Carga los pedidos desde D1 (la nueva fuente de verdad, ex-Excel de Ventas) y
// los mapea a la MISMA forma que devolvía parseVentas, así el resto del front
// (tabla, dashboard, matching de presupuestos) no cambia.
async function fetchPedidosFromD1() {
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/pedidos', { headers: authHeaders() });
    if (!r.ok) return null;
    const j = await r.json();
    return (j.pedidos || []).map(mapPedidoFromD1);
  } catch (e) { return null; }
}
function mapPedidoFromD1(row) {
  return {
    idx: row.id,
    fecha: parseDate(row.fecha),
    numero: row.numero || '',
    cartel: row.cartel || '',
    colores: row.colores || '',
    alto: row.alto || 0,
    ancho: row.ancho || 0,
    cmNeon: row.cm_neon || 0,
    base: row.base || '',
    cantidad: row.cantidad || 1,
    precio: row.precio || 0,
    dimmer: row.dimer || 'NO',
    precioDimmer: row.precio_dimmer || 0,
    envio: row.envio || '',
    aclaracion: row.aclaracion || '',
    productor: row.productor || '',
    plataforma: row.plataforma || '',
    estadoPago: row.estado_pago || '',
    pagado: row.pagado || 0,
    restante: row.restante || 0,
    estadoPedido: row.estado_pedido || '',
    canalAd: row.ad || '',
    tramos: row.tramos || '',
    tipo: row.tipo || '',
    comercial_id: row.comercial_id || 'joaco',
    mirrorError: row.mirror_error || ''
  };
}

// Cache PERMANENTE de las hojas históricas (ENE/FEB/MAR): son datos del pasado,
// inmutables, pero antes se re-bajaban de Google gviz en CADA arranque (3 fetches
// lentos + dependencia de Google). Las cacheamos para siempre: se bajan una sola
// vez en la vida y después salen de localStorage al instante. (Si alguna vez hay
// que invalidar, subir el sufijo de versión _v1.)
function getHistSheetCache(name) {
  try { const v = localStorage.getItem('ni_hist_v1_' + name); return v ? JSON.parse(v) : null; } catch { return null; }
}
function setHistSheetCache(name, rows) {
  try { if (rows && rows.length) localStorage.setItem('ni_hist_v1_' + name, JSON.stringify(rows)); } catch {}
}

async function loadAll(opts) {
  const silent = !!(opts && opts.silent);
  // Stale-while-revalidate: si tenemos caché y no se pidió refresh forzado,
  // mostramos data al toque y refrescamos en background.
  if (!STATE.loaded && !silent) {
    const cached = loadCache();
    if (cached && cached.pedidos && cached.presupuestos) {
      STATE.pedidos = cached.pedidos;
      STATE.presupuestos = cached.presupuestos;
      matchPresupuestos();
      STATE.loaded = true;
      STATE.error = null;
      render();
      // Sigue al fetch fresco abajo, sin loading screen
    } else {
      STATE.loaded = false;
      STATE.error = null;
      render();
    }
  }
  try {
    // Cargar ventas + cotizador moderno + hojas históricas EN PARALELO.
    const cotizadorN = CONFIG.cotizadorSheets.length;
    const histN = (CONFIG.cotizadorHistoricalSheets || []).length;
    const all = await Promise.race([Promise.all([
      fetchPedidosFromD1(),
      ...CONFIG.cotizadorSheets.map(async sheet => {
        let rows = await fetchCotizadorViaAppsScript(sheet);
        if (!rows) rows = await fetchSheet(CONFIG.cotizadorSheetId, sheet);
        return { sheet, rows };
      }),
      ...(CONFIG.cotizadorHistoricalSheets || []).map(async ({ name, month }) => {
        // Inmutables → cache permanente. Solo se bajan la primera vez.
        let rows = getHistSheetCache(name);
        if (!rows) { rows = await fetchSheet(CONFIG.cotizadorSheetId, name); setHistSheetCache(name, rows); }
        return { historical: true, name, month, rows };
      })
    ]), new Promise((_, rej) => setTimeout(() => rej(new Error('La carga tardó demasiado (timeout). Revisá tu conexión y reintentá.')), 30000))]);
    const pedidosD1 = all[0];
    const cotizadorResults = all.slice(1, 1 + cotizadorN);
    const historicalResults = all.slice(1 + cotizadorN, 1 + cotizadorN + histN);
    if (!pedidosD1) throw new Error('No se pudieron cargar los pedidos del CRM (worker /admin/pedidos).');
    STATE.pedidos = pedidosD1;
    const presupuestosAll = [];
    for (const { sheet, rows } of cotizadorResults) {
      if (rows) presupuestosAll.push(...parseCotizador(rows, sheet));
    }
    for (const { name, month, rows } of historicalResults) {
      if (rows) presupuestosAll.push(...parseCotizadorHistorical(rows, month));
    }
    // Aplicar overrides: para cada mes con count manual, generar phantom
    // entries hasta llegar al total. Si el override es menor al count actual,
    // no hace nada (no quitamos data real).
    const overrides = CONFIG.cotizadorMonthOverrides || {};
    for (const [ym, target] of Object.entries(overrides)) {
      const current = presupuestosAll.filter(p => getMonth(p.fecha) === ym).length;
      const missing = target - current;
      if (missing <= 0) continue;
      const [y, m] = ym.split('-').map(Number);
      // Distribuir las phantom uniformemente por días lun-sáb del mes anterior al primer trackeado
      const realDates = presupuestosAll
        .filter(p => getMonth(p.fecha) === ym && !p.historical)
        .map(p => p.fecha.getTime());
      const minRealDate = realDates.length ? new Date(Math.min(...realDates)) : new Date(y, m, 0);
      // Asignamos las phantom al día 5 del mes (antes del tracking real)
      const phantomDate = new Date(y, m - 1, 5, 12, 0, 0);
      for (let i = 0; i < missing; i++) {
        presupuestosAll.push({
          idx: 'override_' + ym + '_' + i,
          sheet: ym + '_override',
          fecha: phantomDate,
          m2: 0,
          nombre: '',
          tamCm: 0, ancho: 0, neonMt: 0,
          tipo: '', precioTrans: 0, precioNegro: 0, precioReventa: 0, precio: 0,
          telefono: '', canal: '',
          historical: true,
          phantom: true,
          phantomMonth: ym
        });
      }
    }
    STATE.presupuestos = presupuestosAll;
    matchPresupuestos();
    STATE.loaded = true;
    saveCache();
  } catch (e) {
    // Solo mostramos pantalla de error si NO hay nada cacheado para mostrar. Si
    // ya teníamos data (cache stale-while-revalidate), un refresh fallido/timeout
    // NO debe tapar la vista con el error — mantenemos la data y seguimos.
    if (!STATE.loaded) STATE.error = e.message;
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
    const contacto = (r[15] || '').trim();
    // Canal: si está en col Q lo usamos, sino lo inferimos del formato del contacto.
    let canal = (r[16] || '').toUpperCase().trim();
    if (canal !== 'WPP' && canal !== 'IG') {
      // Heurística para datos viejos: solo dígitos / + / - / espacios → WPP. Tiene letras o @ → IG.
      if (!contacto) canal = '';
      else if (/^[\d\s+\-()]+$/.test(contacto)) canal = 'WPP';
      else canal = 'IG';
    }
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
      telefono: contacto,
      canal
    });
  }
  return out;
}

// Parser para hojas históricas (ENERO/FEBRERO/MARZO) — sin fecha por fila.
// Headers: ch, m2, diseño, Tamaño (cm), '', Neon (mt), Transparente, Negro
// Asigna fecha = día 15 del mes (referencia para filtros mensuales).
function parseCotizadorHistorical(rows, monthYM) {
  const out = [];
  if (!rows || rows.length < 2) return out;
  const [y, m] = monthYM.split('-').map(Number);
  const fecha = new Date(y, m - 1, 15, 12, 0, 0); // mediodía día 15
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const nombre = String(r[2] || '').trim();
    if (!nombre) continue;
    const precioTrans = parseNum(r[6]);
    const precioNegro = parseNum(r[7]);
    const precio = Math.max(precioTrans, precioNegro);
    out.push({
      idx: i,
      sheet: monthYM, // '2026-01' etc para que match con getMonth()
      fecha,
      m2: parseNum(r[1]),
      nombre,
      tamCm: parseNum(r[3]),
      ancho: parseNum(r[4]),
      neonMt: parseNum(r[5]),
      tipo: '',
      precioTrans,
      precioNegro,
      precioReventa: 0,
      precio,
      telefono: '',
      canal: '',
      historical: true
    });
  }
  return out;
}

function matchPresupuestos() {
  STATE._segStamp = (STATE._segStamp || 0) + 1;  // invalida el memo de getSeguimientosWeek (cambiaron datos)
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

// Detecta si los datos de presupuestos son parciales para un conjunto de meses.
// Lógica: para cada mes del rango, mirar si está cubierto:
//   1) Por una hoja histórica (ENERO/FEBRERO/MARZO) → COMPLETO
//   2) Por cotizador moderno con fecha mínima ≈ día 1 → COMPLETO
//   3) Por cotizador moderno con fecha mínima > día 5 → PARCIAL desde esa fecha
// Devuelve { partial: boolean, since: Date|null } donde since es la fecha
// más temprana del mes con tracking incompleto.
function detectPartialPresupuestos(monthsArr) {
  const histMonths = new Set((CONFIG.cotizadorHistoricalSheets || []).map(h => h.month));
  const overrideMonths = new Set(Object.keys(CONFIG.cotizadorMonthOverrides || {}));
  let partial = false;
  let since = null;
  for (const ym of monthsArr) {
    if (histMonths.has(ym)) continue;     // hoja histórica completa
    if (overrideMonths.has(ym)) continue; // override manual completo
    const inMonth = (STATE.presupuestos || []).filter(p =>
      !p.historical && getMonth(p.fecha) === ym
    );
    if (!inMonth.length) {
      partial = true;
      const [y,m] = ym.split('-').map(Number);
      const monthStart = new Date(y, m-1, 1);
      if (!since || monthStart < since) since = monthStart;
      continue;
    }
    const minFecha = inMonth.reduce((min, p) => p.fecha < min ? p.fecha : min, inMonth[0].fecha);
    if (minFecha.getDate() > 5) {
      partial = true;
      if (!since || minFecha < since) since = minFecha;
    }
  }
  return { partial, since };
}

// Tasa de cierre Pedidos Directo (agregada del período):
//   # ventas del período / # presupuestos enviados del período
// monthsFilter: null = mes actual, Set('YYYY-MM') = filtro, 'all' = todos.
function getTasaCierreDirecto(monthsFilter) {
  let pptos = STATE.presupuestos || [];
  let pedidos = STATE.pedidos || [];
  let monthsArr = [];
  if (monthsFilter === 'all') {
    const allMonths = new Set();
    for (const p of [...pptos, ...pedidos]) allMonths.add(getMonth(p.fecha));
    monthsArr = [...allMonths];
  } else if (monthsFilter instanceof Set) {
    pptos = pptos.filter(p => monthsFilter.has(getMonth(p.fecha)));
    pedidos = pedidos.filter(p => monthsFilter.has(getMonth(p.fecha)));
    monthsArr = [...monthsFilter];
  } else {
    const cur = getCurrentMonth();
    pptos = pptos.filter(p => getMonth(p.fecha) === cur);
    pedidos = pedidos.filter(p => getMonth(p.fecha) === cur);
    monthsArr = [cur];
  }
  const enviados = pptos.length;
  const vendidos = pedidos.length;
  const tasa = enviados ? (vendidos / enviados) : 0;
  // Match-based: cuántos presu del período tienen pedido asociado por nombre+precio
  let cerradosMatch = 0;
  for (const ppto of pptos) {
    if (ppto.historical) continue; // las históricas no se matchean
    const st = presupuestoStatus(ppto);
    if (st.state === 'cerrado') cerradosMatch++;
  }
  const { partial, since } = detectPartialPresupuestos(monthsArr);
  return { enviados, vendidos, cerradosMatch, tasa, partial, trackingStart: since };
}

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

let _segWeekCache = null, _segWeekKey = '';
function getSeguimientosWeek() {
  // Memo: esta función corre en CADA renderShell() (todas las vistas) y recorre
  // presupuestos + pedidos con cálculo de milestones — caro para pintar 2 badges.
  // Cacheamos y recalculamos solo cuando cambian los datos (lengths o el stamp
  // que sube matchPresupuestos al re-cruzar datos).
  const key = STATE.presupuestos.length + '|' + STATE.pedidos.length + '|' + (STATE._segStamp || 0);
  if (_segWeekKey === key && _segWeekCache) return _segWeekCache;
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
// Diseñador puro (no admin): solo puede ver la tab Cotización.
function isDisenadorOnly() {
  return getUserRole() === 'disenador';
}
function setView(v) {
  // Diseñador queda confinado a Cotización; Abril (cursos) al Chat WA.
  if (isCursosOnly()) v = 'chat';
  else if (isDisenadorOnly()) v = 'cotizacion';
  STATE.view = v;
  STATE.selected = null;
  location.hash = v;
  render();
}
window.addEventListener('hashchange', () => {
  let h = location.hash.replace('#','') || 'dashboard';
  if (isCursosOnly()) h = 'chat';
  else if (isDisenadorOnly()) h = 'cotizacion';
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
        <div style="display:flex;flex-wrap:wrap;gap:var(--s-3);justify-content:center">
          ${CONFIG.defaultUsers.map(u => `
            <button class="btn btn-cyan user-pick-big" data-pick-user="${escapeHtml(u)}" style="min-width:110px;padding:var(--s-3) var(--s-4);font-size:16px">${escapeHtml(u)}</button>
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
  // Diseñador queda confinado a Cotización; Abril (cursos) al Chat WA, aunque
  // la URL o el state digan otra cosa.
  if (isCursosOnly() && STATE.view !== 'chat') {
    STATE.view = 'chat';
    if (location.hash !== '#chat') location.hash = 'chat';
  } else if (isDisenadorOnly() && STATE.view !== 'cotizacion') {
    STATE.view = 'cotizacion';
    if (location.hash !== '#cotizacion') location.hash = 'cotizacion';
  }
  // Corpóreas: solo Joaquín + Gaspar. Si alguien más cae acá (hash directo), al dashboard.
  if (STATE.view === 'corporeas' && !(isJoaquinUser(STATE.user) || isGasparUser(STATE.user))) {
    STATE.view = 'dashboard';
    if (location.hash !== '#dashboard') location.hash = 'dashboard';
  }
  // Nadia (2da vendedora): set reducido por ahora. Views permitidas: dashboard (solo
  // su panel "Tu sueldo"), pedidos, presupuestos, cotizacion, chat. Si cae en otra
  // (seguimientos/actividad/etc. por hash directo), al dashboard.
  if (isNadiaUser(STATE.user) && !['dashboard','pedidos','presupuestos','cotizacion','chat'].includes(STATE.view)) {
    STATE.view = 'dashboard';
    if (location.hash !== '#dashboard') location.hash = 'dashboard';
  }
  document.getElementById('app').innerHTML = renderShell();
  try { startSinCotizarWatch(); } catch (_) {}
  try { startOcUrgenteWatch(); } catch (_) {}
  // El Chat WA carga su data del worker (no de Sheets), así que se renderiza
  // SIEMPRE — aunque Sheets siga cargando o haya fallado. Antes el gate de abajo
  // (!STATE.loaded) tapaba el chat con "Conectando con Google Sheets…" y, si el
  // fetch de Sheets se colgaba en un arranque sin caché, la app quedaba trabada.
  if (STATE.view === 'chat') document.getElementById('main').innerHTML = renderChat();
  else if (STATE.error)   document.getElementById('main').innerHTML = renderError();
  else if (!STATE.loaded) document.getElementById('main').innerHTML = renderLoading();
  else {
    const v = STATE.view;
    if (v === 'dashboard')      document.getElementById('main').innerHTML = isAdmin() ? renderBusinessPanel() : renderDashboard();
    else if (v === 'pedidos')   document.getElementById('main').innerHTML = renderPedidos();
    else if (v === 'presupuestos') document.getElementById('main').innerHTML = renderPresupuestos();
    else if (v === 'cotizacion')   document.getElementById('main').innerHTML = renderCotizacion();
    else if (v === 'corporeas')    document.getElementById('main').innerHTML = renderCorporeas();
    else if (v === 'seguimientos') document.getElementById('main').innerHTML = renderSeguimientos();
    else if (v === 'panel-joaco')   document.getElementById('main').innerHTML = renderPanelJoaco();
    else if (v === 'actividad')    document.getElementById('main').innerHTML = renderActividad();
    else if (v === 'chat')         document.getElementById('main').innerHTML = renderChat();
    else if (v === 'insights')     document.getElementById('main').innerHTML = renderInsights();
    else if (v === 'automatizaciones') document.getElementById('main').innerHTML = renderAutomatizaciones();
    else if (v === 'admin')        document.getElementById('main').innerHTML = renderAdmin();
    else                        document.getElementById('main').innerHTML = renderDashboard();
  }
  // Toggle main--chat class for full-height layout
  const mainEl = document.getElementById('main');
  if (mainEl) mainEl.classList.toggle('main--chat', STATE.view === 'chat');
  // Lock entire app shell height when chat is active
  const appEl = mainEl && mainEl.closest('.app');
  if (appEl) {
    appEl.classList.toggle('app--chat', STATE.view === 'chat');
    if (STATE.view !== 'chat') appEl.classList.remove('app--chat-full');
  }
  bindNav();
  bindCommon();
  if (STATE.view === 'pedidos') bindPedidos();
  if (STATE.view === 'presupuestos') bindPresupuestos();
  if (STATE.view === 'cotizacion')   bindCotizacion();
  if (STATE.view === 'corporeas')    bindCorporeas();
  if (STATE.view === 'seguimientos') bindSeguimientos();
  if (STATE.view === 'dashboard') {
    if (isAdmin()) bindBusinessPanel();
    else if (!isNadiaUser(STATE.user)) drawCharts();  // Nadia: dashboard reducido, sin gráficos
  }
  if (STATE.view === 'panel-joaco') bindPanelJoaco();
  if (STATE.view === 'actividad') bindActividad();
  if (STATE.view === 'chat') bindChat();
  if (STATE.view === 'insights') bindInsights();
  if (STATE.view === 'automatizaciones') bindAutomatizaciones();
  if (STATE.view === 'admin') bindAdmin();
  // Sincronizar classes mobile del chat (chat-mobile-list / chat-mobile-conv)
  // en el .app raíz. Solo el CSS bajo el media query mobile las usa.
  if (typeof _applyMobileChatClass === 'function') _applyMobileChatClass();
}

// ===== Alarma "💰 Sin cotizar" — pedidos con foto+medidas sin presupuesto hace +20hs =====
// Modal global para Joaco (comercial) + admin: aparece cuando queda un lead colgado.
// La lista la mantiene DINÁMICA el worker (destilda a los que Joaco ya cotizó). El
// botón "Ver" filtra el chat por la etiqueta. Poll liviano cada 75s (solo lee, no scanea).
function _canSeeSinCotizar() { const r = getUserRole(); return r === 'admin' || r === 'comercial'; }
function _sinCotizarShouldShow() {
  const sc = STATE.sinCotizar;
  if (!sc || !_canSeeSinCotizar() || !sc.count) return false;
  const ack = localStorage.getItem('sinCotizarAck') || '';
  return !!sc.maxCreatedAt && sc.maxCreatedAt > ack;
}
async function fetchSinCotizarStatus() {
  if (!STATE.token || !CONFIG.trackerUrl || !_canSeeSinCotizar()) return;
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/sin-cotizar-status', { headers: authHeaders() });
    if (!r.ok) return;
    const j = await r.json();
    if (!j.ok) return;
    const prev = STATE.sinCotizar;
    STATE.sinCotizar = { count: j.count || 0, labelId: j.label_id, maxCreatedAt: j.max_created_at || '', nombres: j.nombres || [] };
    if (!prev || prev.count !== STATE.sinCotizar.count || prev.maxCreatedAt !== STATE.sinCotizar.maxCreatedAt) render();
  } catch (_) {}
}
function _sinCotizarAck() { if (STATE.sinCotizar) localStorage.setItem('sinCotizarAck', STATE.sinCotizar.maxCreatedAt || ''); }
function startSinCotizarWatch() {
  if (window._sinCotizarWatch || !_canSeeSinCotizar()) return;
  window._sinCotizarWatch = true;
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-sc-ver]')) {
      _sinCotizarAck();
      if (STATE.sinCotizar && STATE.sinCotizar.labelId) { chatState.filterLabels = [STATE.sinCotizar.labelId]; chatState.labelDropdownOpen = false; }
      setView('chat');
      return;
    }
    if (t.closest('[data-sc-dismiss]') || (t.matches && t.matches('[data-sc-bg]'))) { _sinCotizarAck(); render(); return; }
  });
  fetchSinCotizarStatus();
  setInterval(() => { if (!pollBackoffActive()) fetchSinCotizarStatus(); }, 75000);
}
function renderSinCotizarModal() {
  if (!_sinCotizarShouldShow()) return '';
  const sc = STATE.sinCotizar;
  const nombres = (sc.nombres || []).slice(0, 4);
  return `
    <div data-sc-bg style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:7000;display:flex;align-items:center;justify-content:center;padding:16px">
      <div style="background:var(--bg);border:1px solid var(--accent-cyan);border-radius:var(--r-md);width:min(420px,94vw);padding:var(--s-4);box-shadow:0 10px 40px rgba(0,0,0,.45)">
        <div style="font-size:34px;text-align:center;margin-bottom:4px">💰</div>
        <h2 style="margin:0 0 6px;font-size:17px;text-align:center">${sc.count === 1 ? 'Hay un pedido sin cotizar' : 'Hay ' + sc.count + ' pedidos sin cotizar'}</h2>
        <p style="margin:0 0 12px;font-size:13px;color:var(--fg-mute);text-align:center;line-height:1.5">Mandaron foto y medidas y todavía no les pasaste presupuesto (hace más de 20 h).</p>
        ${nombres.length ? `<div style="font-size:12px;color:var(--fg-subtle);text-align:center;margin-bottom:14px">${nombres.map(n => escapeHtml(n)).join(' · ')}${sc.count > nombres.length ? ' · +' + (sc.count - nombres.length) : ''}</div>` : ''}
        <div style="display:flex;gap:8px;justify-content:center">
          <button class="btn btn-ghost" data-sc-dismiss style="padding:8px 16px">Después</button>
          <button class="btn btn-cyan" data-sc-ver style="padding:8px 20px">Ver los pedidos →</button>
        </div>
      </div>
    </div>`;
}

// ===== Alarma "🔥 Pedido por vender URGENTE" — OC enviada hace +3h sin respuesta del cliente =====
// Clon del popup "Sin cotizar" pero por ITEM (cada uno con su botón "Ver chat →", IG o WPP).
// El backend (/admin/wa/oc-urgente-status) filtra por vendedor (quién mandó la OC) y por
// "3h sin inbound posterior". Poll liviano cada 75s. Mismo gate que sin-cotizar (admin+comercial).
function _canSeeOcUrgente() { const r = getUserRole(); return r === 'admin' || r === 'comercial'; }
function _ocUrgenteShouldShow() {
  const oc = STATE.ocUrgente;
  if (!oc || !_canSeeOcUrgente() || !oc.count) return false;
  const ack = localStorage.getItem('ocUrgenteAck') || '';
  return !!oc.maxCreatedAt && oc.maxCreatedAt > ack;
}
async function fetchOcUrgenteStatus() {
  if (!STATE.token || !CONFIG.trackerUrl || !_canSeeOcUrgente()) return;
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/oc-urgente-status', { headers: authHeaders() });
    if (!r.ok) return;
    const j = await r.json();
    if (!j.ok) return;
    const prev = STATE.ocUrgente;
    STATE.ocUrgente = { count: j.count || 0, maxCreatedAt: j.max_created_at || '', items: j.items || [] };
    if (!prev || prev.count !== STATE.ocUrgente.count || prev.maxCreatedAt !== STATE.ocUrgente.maxCreatedAt) render();
  } catch (_) {}
}
function _ocUrgenteAck() { if (STATE.ocUrgente) localStorage.setItem('ocUrgenteAck', STATE.ocUrgente.maxCreatedAt || ''); }
function startOcUrgenteWatch() {
  if (window._ocUrgenteWatch || !_canSeeOcUrgente()) return;
  window._ocUrgenteWatch = true;
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const ver = t.closest('[data-oc-ver]');
    if (ver) {
      const ph = ver.getAttribute('data-oc-phone') || '';
      _ocUrgenteAck();
      STATE.view = 'chat';
      chatState.selectedPhone = ph;
      if (typeof enterMobileChatConversation === 'function') enterMobileChatConversation();
      try { selectChatContact(ph); } catch (_) {}
      location.hash = 'chat';
      render();
      return;
    }
    if (t.closest('[data-oc-dismiss]') || (t.matches && t.matches('[data-oc-bg]'))) { _ocUrgenteAck(); render(); return; }
  });
  fetchOcUrgenteStatus();
  setInterval(() => { if (!pollBackoffActive()) fetchOcUrgenteStatus(); }, 75000);
}
function renderOcUrgenteModal() {
  if (!_ocUrgenteShouldShow()) return '';
  const oc = STATE.ocUrgente;
  const items = (oc.items || []).slice(0, 8);
  const rows = items.map(it => {
    const nombre = escapeHtml((it.nombre || '').trim() || ('+' + it.phone));
    const importe = it.importe ? escapeHtml(it.importe) : '';
    const canalTag = it.canal === 'ig' ? '📷 ' : '';
    return `
      <div style="display:flex;align-items:center;gap:8px;justify-content:space-between;padding:8px 10px;border:1px solid var(--border);border-radius:var(--r-sm);margin-bottom:6px">
        <div style="min-width:0">
          <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${canalTag}${nombre}</div>
          ${importe ? `<div style="font-size:12px;color:var(--fg-mute)">${importe}</div>` : ''}
        </div>
        <button class="btn btn-cyan btn-sm" data-oc-ver data-oc-phone="${escapeHtml(it.phone)}" style="flex:none">Ver chat →</button>
      </div>`;
  }).join('');
  return `
    <div data-oc-bg style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:7100;display:flex;align-items:center;justify-content:center;padding:16px">
      <div style="background:var(--bg);border:1px solid #f59e0b;border-radius:var(--r-md);width:min(440px,94vw);padding:var(--s-4);box-shadow:0 10px 40px rgba(0,0,0,.45)">
        <div style="font-size:34px;text-align:center;margin-bottom:4px">🔥</div>
        <h2 style="margin:0 0 6px;font-size:17px;text-align:center">${oc.count === 1 ? 'Pedido por vender URGENTE' : oc.count + ' pedidos por vender URGENTE'}</h2>
        <p style="margin:0 0 12px;font-size:13px;color:var(--fg-mute);text-align:center;line-height:1.5">Mandaste la orden de compra hace más de 3 h y el cliente todavía no respondió.</p>
        <div style="margin-bottom:12px">${rows}</div>
        <div style="display:flex;justify-content:center">
          <button class="btn btn-ghost" data-oc-dismiss style="padding:8px 16px">Después</button>
        </div>
      </div>
    </div>`;
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
        <div class="user-pick-label">Usuario ${canAccessChat() ? '<span class="admin-tag">' + (isAdmin() ? 'admin' : 'chat') + '</span>' : ''}</div>
        <div class="user-pick-chips">
          ${STATE.users.map(u => {
            const locked = !tokenBelongsTo(u);  // 🔒 = requiere login (todos tienen contraseña)
            return `<button class="user-chip ${STATE.user===u?'active':''}" data-set-user="${escapeHtml(u)}">${locked?'🔒 ':''}${escapeHtml(u)}</button>`;
          }).join('')}
          <button class="user-chip add" data-add-user>+</button>
          ${canAccessChat() ? '<button class="user-chip add" data-logout title="Cerrar sesión">⎋</button>' : ''}
          <button class="user-chip add privacy-toggle ${STATE.privacy ? 'on' : ''}" data-privacy-toggle title="${STATE.privacy ? 'Mostrar montos' : 'Ocultar montos (modo billetera)'}">
            ${STATE.privacy
              ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>'
              : '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>'}
          </button>
        </div>
      </div>
      <nav class="nav">
        ${isCursosOnly() ? `
          <button class="nav-item active" data-view="chat"><span class="icon">✉</span> Chat WA
            <span class="badge cyan" data-chat-badge style="display:${chatState.totalUnread ? '' : 'none'}">${chatState.totalUnread > 99 ? '99+' : (chatState.totalUnread || '')}</span>
          </button>
        ` : isDisenadorOnly() ? `
          <button class="nav-item active" data-view="cotizacion"><span class="icon">◆</span> Cotización</button>
        ` : `
        <button class="nav-item ${v==='dashboard'?'active':''}" data-view="dashboard"><span class="icon">◊</span> Dashboard</button>
        <button class="nav-item ${v==='pedidos'?'active':''}" data-view="pedidos"><span class="icon">▦</span> Pedidos</button>
        <button class="nav-item ${v==='presupuestos'?'active':''}" data-view="presupuestos"><span class="icon">∑</span> Presupuestos</button>
        <button class="nav-item ${v==='cotizacion'?'active':''}" data-view="cotizacion"><span class="icon">◆</span> Cotización</button>
        ${(isJoaquinUser(STATE.user) || isGasparUser(STATE.user)) ? `<button class="nav-item ${v==='corporeas'?'active':''}" data-view="corporeas"><span class="icon">▣</span> Corpóreas</button>` : ''}
        ${!isNadiaUser(STATE.user) ? `<button class="nav-item ${v==='seguimientos'?'active':''}" data-view="seguimientos"><span class="icon">↻</span> Seguimientos
          ${sgts.length ? `<span class="badge">${sgts.length}</span>` : ''}
        </button>` : ''}
        ${!isNadiaUser(STATE.user) ? `<button class="nav-item ${v==='actividad'?'active':''}" data-view="actividad"><span class="icon">⌬</span> Actividad</button>` : ''}
        ${canAccessChat() ? `<button class="nav-item ${v==='chat'?'active':''}" data-view="chat"><span class="icon">✉</span> Chat WA
          <span class="badge cyan" data-chat-badge style="display:${chatState.totalUnread ? '' : 'none'}">${chatState.totalUnread > 99 ? '99+' : (chatState.totalUnread || '')}</span>
        </button>` : ''}
        ${isAdmin() ? `<button class="nav-item ${v==='insights'?'active':''}" data-view="insights"><span class="icon">⚡</span> Insights IA</button>` : ''}
        ${isAdmin() ? `<button class="nav-item ${v==='automatizaciones'?'active':''}" data-view="automatizaciones"><span class="icon">⚙</span> Automatiz.</button>` : ''}
        `}
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
    ${renderSinCotizarModal()}
    ${renderOcUrgenteModal()}
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

// ---------- AUTOMATIZACIONES (Fase 1: panel read-only, solo admin) ----------
// Lista todas las automatizaciones de WhatsApp con su estado y stats en vivo.
// Data del endpoint GET /admin/automations del worker.
// ===== Piloto de pre cotización (vista admin / solo Gaspar) =====
async function fetchPrecotiz() {
  if (!STATE.token) return;
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/precotiz', { headers: authHeaders() });
    if (!r.ok) { STATE.precotiz = { error: 'HTTP ' + r.status }; return; }
    const j = await r.json();
    const leads = j.leads || [];
    STATE.precotiz = {
      on: !!j.on, modo: j.modo || 'draft', cap: j.cap || 10, count: j.count != null ? j.count : leads.length,
      leads, frozen: j.frozen || [], draftCount: leads.filter(l => l.pending_draft && l.pending_draft !== '').length
    };
  } catch (e) { STATE.precotiz = { error: String((e && e.message) || e) }; }
}

function renderPrecotiz() {
  if (!isAdmin()) return '<div class="page-head"><h1>Pre cotización</h1></div><div class="error">Solo Gaspar.</div>';
  const P = STATE.precotiz;
  if (!P) { fetchPrecotiz().then(render); return '<div class="page-head"><h1>Pre cotización</h1></div>' + renderLoading(); }
  if (P.error) return `<div class="page-head"><h1>Pre cotización</h1></div><div class="error">Error: ${escapeHtml(P.error)} <button class="btn" data-precotiz-reload>Reintentar</button></div>`;

  const estadoChip = (l) => l.estado === 'completo'
    ? '<span class="pill" style="background:rgba(37,211,102,.16);color:#25D366">completo</span>'
    : l.estado === 'escalado'
      ? '<span class="pill" style="background:rgba(255,167,38,.16);color:#FFA726">freno de mano</span>'
      : '<span class="pill" style="background:rgba(143,212,222,.14);color:var(--accent-cyan,#8FD4DE)">en relevamiento</span>';
  const datoChip = (ok, label) => `<span class="pill" style="font-size:10px;${ok ? 'background:rgba(37,211,102,.16);color:#25D366' : 'background:rgba(255,255,255,.06);color:var(--fg-subtle)'}">${ok ? '✓' : '○'} ${label}</span>`;

  const leadsHtml = (P.leads || []).map(l => {
    let draft = [];
    if (l.pending_draft) { try { draft = JSON.parse(l.pending_draft); } catch (_) {} }
    return `
      <div class="card" style="margin-bottom:var(--s-3);padding:var(--s-3)">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
          <div style="font-weight:600;font-size:13px">${escapeHtml(l.nombre || ('+' + l.phone))} <span class="muted" style="font-weight:400">+${escapeHtml(l.phone)}</span></div>
          ${estadoChip(l)}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">
          ${datoChip(l.tiene_foto, 'foto')} ${datoChip(l.tiene_medidas, 'medidas')} ${datoChip(l.tiene_intext, 'int/ext')}
        </div>
        ${l.escalado_motivo ? `<div class="muted" style="font-size:11px;margin-bottom:6px">motivo: ${escapeHtml(l.escalado_motivo)}</div>` : ''}
        ${draft.length ? `
          <div style="background:var(--ink-100);border:1px solid var(--accent-cyan,#8FD4DE);border-radius:var(--r-sm);padding:10px;margin-top:6px">
            <div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--fg-subtle);margin-bottom:6px">Borrador del bot — esperando tu OK</div>
            <textarea data-precotiz-draft="${escapeHtml(l.phone)}" rows="${Math.min(8, draft.length + 2)}" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px;color:var(--fg);font-size:13px;font-family:inherit;resize:vertical">${escapeHtml(draft.join('\n'))}</textarea>
            <div style="font-size:10px;color:var(--fg-subtle);margin:4px 0 8px">cada renglón = un mensajito separado · podés editar antes de mandar</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn btn-cyan" data-precotiz-approve="${escapeHtml(l.phone)}">Aprobar y enviar</button>
              <button class="btn btn-ghost" data-precotiz-discard="${escapeHtml(l.phone)}">Descartar</button>
            </div>
          </div>` : ''}
      </div>`;
  }).join('');

  return `
    <div class="page-head">
      <h1>Pre cotización <span class="muted" style="font-size:14px">· piloto</span></h1>
      <div class="actions"><button class="btn btn-ghost" data-precotiz-reload>↻ Actualizar</button></div>
    </div>
    <div class="card" style="padding:var(--s-4);margin-bottom:var(--s-4)">
      <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" data-precotiz-on ${P.on ? 'checked' : ''}>
          <b>${P.on ? 'Piloto PRENDIDO' : 'Piloto apagado'}</b>
        </label>
        <label style="display:flex;align-items:center;gap:8px">Modo:
          <select data-precotiz-modo>
            <option value="draft" ${P.modo !== 'auto' ? 'selected' : ''}>Borrador (apruebo yo)</option>
            <option value="auto" ${P.modo === 'auto' ? 'selected' : ''}>Auto-envío</option>
          </select>
        </label>
        <span class="muted" style="font-size:12px">${P.count}/${P.cap} leads</span>
      </div>
      <div class="muted" style="font-size:11px;margin-top:8px">Con el piloto prendido y en modo borrador, el bot arma los mensajitos y te avisa acá para que los apruebes. Solo vos ves estos chats hasta que junten los 3 datos.</div>
      <div style="border-top:1px solid var(--border);margin-top:12px;padding-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:8px">👤 Reparto a Nadia — leads por día:
          <input type="number" min="0" step="1" data-nadia-cuota value="${P.nadia_cuota != null ? P.nadia_cuota : 0}" style="width:64px;background:var(--bg);border:1px solid var(--border);border-radius:var(--r-sm);padding:5px 8px;color:var(--fg);font-size:13px">
        </label>
        <span class="muted" style="font-size:12px">hoy le tocaron ${P.nadia_hoy || 0}/${P.nadia_cuota || 0}</span>
      </div>
      <div class="muted" style="font-size:11px;margin-top:6px">Cada lead NUEVO de carteles que entra se reparte: hasta ese tope por día va a Nadia (lo atiende ella desde el primer mensaje), el resto queda para Joaco. En 0, Nadia no recibe nada automático — le asignás a mano con el botón 👤N en cada chat.</div>
    </div>
    ${(P.leads && P.leads.length) ? leadsHtml : '<div class="muted" style="font-size:13px">Todavía no entró ningún lead al piloto.</div>'}
  `;
}

function bindPrecotiz() {
  const reload = () => fetchPrecotiz().then(render);
  document.querySelectorAll('[data-precotiz-reload]').forEach(el => el.onclick = reload);
  const onChk = document.querySelector('[data-precotiz-on]');
  if (onChk) onChk.onchange = async () => { await precotizControl({ on: onChk.checked }); reload(); };
  const modoSel = document.querySelector('[data-precotiz-modo]');
  if (modoSel) modoSel.onchange = async () => { await precotizControl({ modo: modoSel.value }); toast('Modo: ' + modoSel.value); };
  const nadiaCuotaInp = document.querySelector('[data-nadia-cuota]');
  if (nadiaCuotaInp) nadiaCuotaInp.onchange = async () => { const q = Math.max(0, parseInt(nadiaCuotaInp.value, 10) || 0); await precotizControl({ nadia_cuota: q }); toast('Reparto a Nadia: ' + q + '/día'); reload(); };
  document.querySelectorAll('[data-precotiz-approve]').forEach(el => el.onclick = async () => {
    const phone = el.dataset.precotizApprove;
    const ta = document.querySelector(`[data-precotiz-draft="${phone}"]`);
    const mensajes = (ta ? ta.value : '').split('\n').map(s => s.trim()).filter(Boolean);
    if (!mensajes.length) { toast('No hay mensajes para enviar'); return; }
    if (!await showConfirm(`Mandar ${mensajes.length} mensaje(s) a +${phone}?`, { title: 'Enviar', confirmLabel: 'Mandar' }).catch(() => false)) return;
    el.disabled = true; el.textContent = 'Enviando…';
    try {
      const r = await fetch(CONFIG.trackerUrl + '/admin/precotiz/approve', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, mensajes }) });
      const j = await r.json().catch(() => ({}));
      toast(r.ok ? '✓ Enviado' : ('Error: ' + (j.error || r.status)));
    } catch (e) { toast('Error de red'); }
    reload();
  });
  document.querySelectorAll('[data-precotiz-discard]').forEach(el => el.onclick = async () => {
    const phone = el.dataset.precotizDiscard;
    if (!await showConfirm('Descartar este borrador sin enviar?', { title: 'Descartar', confirmLabel: 'Descartar' }).catch(() => false)) return;
    try { await fetch(CONFIG.trackerUrl + '/admin/precotiz/discard', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) }); } catch (_) {}
    reload();
  });
}

async function precotizControl(body) {
  try { await fetch(CONFIG.trackerUrl + '/admin/precotiz/control', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch (_) {}
}

// Banner del piloto DENTRO de la conversación (solo Gaspar): si el chat abierto
// es un lead del piloto, muestra estado + datos juntados + (si hay) el borrador
// del bot para aprobar/editar/descartar. '' si no aplica.
function renderPrecotizChatBanner(phone) {
  if (!isAdmin() || !STATE.precotiz || !Array.isArray(STATE.precotiz.leads)) return '';
  const lead = STATE.precotiz.leads.find(l => l.phone === phone);
  if (!lead) return '';
  let draft = [];
  if (lead.pending_draft) { try { draft = JSON.parse(lead.pending_draft); } catch (_) {} }
  const estado = lead.estado === 'completo' ? 'pre cotización completa' : lead.estado === 'escalado' ? ('freno de mano — ' + (lead.escalado_motivo || 'revisar')) : 'en pre cotización · el bot releva';
  const dato = (ok, l) => `<span style="color:${ok ? '#25D366' : 'var(--fg-subtle)'}">${ok ? '✓' : '○'} ${l}</span>`;
  const frozen = STATE.precotiz && Array.isArray(STATE.precotiz.frozen) && STATE.precotiz.frozen.includes(phone);
  // El botón "Frenar bot" solo tiene sentido si el bot está TRABAJANDO (estado 'activo'). Si la
  // pre cotización ya está completa/cotizada/escalada, el bot ya no habla → no mostramos el botón.
  // Si el chat está frenado a mano, sí lo mostramos (como "Reactivar") para poder revertir.
  const mostrarFreno = frozen || lead.estado === 'activo';
  return `
    <div style="background:${frozen ? 'rgba(224,108,108,.10)' : 'rgba(143,212,222,.08)'};border-bottom:1px solid var(--border);padding:8px 14px;font-size:12px;position:relative;z-index:1">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="color:${frozen ? '#e06c6c' : 'var(--accent-cyan,#8FD4DE)'};font-weight:600">${frozen ? '🛑 bot frenado a mano en este chat' : '◐ ' + escapeHtml(estado)}</span>
        <span style="display:flex;gap:8px;align-items:center;font-size:11px">${dato(lead.tiene_foto, 'foto')} ${dato(lead.tiene_medidas, 'medidas')} ${dato(lead.tiene_intext, 'int/ext')}${mostrarFreno ? `<button id="precotiz-freeze-btn" data-frozen="${frozen ? '1' : '0'}" title="${frozen ? 'Reactivar el bot en este chat' : 'Frenar el bot en este chat — no vuelve a hablar acá'}" style="font-size:11px;padding:3px 10px;border-radius:var(--r-sm);cursor:pointer;background:transparent;border:1px solid ${frozen ? '#25D366' : '#e06c6c'};color:${frozen ? '#25D366' : '#e06c6c'};font-weight:600;white-space:nowrap">${frozen ? '▶ Reactivar bot' : '🛑 Frenar bot'}</button>` : ''}</span>
      </div>
      ${draft.length ? `
        <div style="margin-top:8px;background:var(--ink-100);border:1px solid var(--accent-cyan,#8FD4DE);border-radius:var(--r-sm);padding:8px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--fg-subtle);margin-bottom:5px">Borrador del bot — esperando tu OK</div>
          <textarea id="precotiz-chat-draft" rows="${Math.min(12, draft.join('\n\n').split('\n').length + 1)}" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px;color:var(--fg);font-size:13px;font-family:inherit;resize:vertical">${escapeHtml(draft.join('\n\n'))}</textarea>
          <div style="font-size:10px;color:var(--fg-subtle);margin:3px 0 7px">cada bloque separado por una línea en blanco = un mensajito</div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-cyan" id="precotiz-chat-approve" style="font-size:12px;padding:5px 12px">Aprobar y enviar</button>
            <button class="btn btn-ghost" id="precotiz-chat-discard" style="font-size:12px;padding:5px 12px">Descartar</button>
          </div>
        </div>` : ''}
    </div>`;
}

function bindPrecotizChatBanner(phone) {
  const ap = document.getElementById('precotiz-chat-approve');
  if (ap) ap.onclick = async () => {
    const ta = document.getElementById('precotiz-chat-draft');
    const mensajes = (ta ? ta.value : '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
    if (!mensajes.length) { toast('No hay mensajes para enviar'); return; }
    if (!await showConfirm(`Mandar ${mensajes.length} mensaje(s) a este cliente?`, { title: 'Enviar', confirmLabel: 'Mandar' }).catch(() => false)) return;
    ap.disabled = true; ap.textContent = 'Enviando…';
    try {
      const r = await fetch(CONFIG.trackerUrl + '/admin/precotiz/approve', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, mensajes }) });
      toast(r.ok ? '✓ Enviado' : 'Error al enviar');
    } catch (_) { toast('Error de red'); }
    await fetchPrecotiz();
    if (chatState.selectedPhone === phone) { try { await loadChatMessages(phone); } catch (_) {} }
    render();
  };
  const di = document.getElementById('precotiz-chat-discard');
  if (di) di.onclick = async () => {
    if (!await showConfirm('Descartar este borrador sin enviar?', { title: 'Descartar', confirmLabel: 'Descartar' }).catch(() => false)) return;
    try { await fetch(CONFIG.trackerUrl + '/admin/precotiz/discard', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) }); } catch (_) {}
    await fetchPrecotiz(); render();
  };
  const fz = document.getElementById('precotiz-freeze-btn');
  if (fz) fz.onclick = async () => {
    const wasFrozen = fz.dataset.frozen === '1';
    const msg = wasFrozen ? 'Reactivar el bot en este chat?' : 'Frenar el bot en este chat? No vuelve a hablar acá hasta que lo reactives a mano.';
    if (!await showConfirm(msg, { title: wasFrozen ? 'Reactivar bot' : 'Frenar bot', confirmLabel: wasFrozen ? 'Reactivar' : 'Frenar' }).catch(() => false)) return;
    fz.disabled = true;
    try {
      const r = await fetch(CONFIG.trackerUrl + '/admin/precotiz/freeze', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, on: !wasFrozen }) });
      toast(r.ok ? (wasFrozen ? '✓ Bot reactivado' : '🛑 Bot frenado en este chat') : 'Error');
    } catch (_) { toast('Error de red'); }
    await fetchPrecotiz(); render();
  };
}

// Control compacto del piloto (on/off + modo), arriba de la lista de chats. Solo Gaspar.
function renderPrecotizControl() {
  if (!isAdmin()) return '';
  const P = STATE.precotiz || {};
  return `
    <div style="padding:6px 10px;background:var(--ink-100);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;font-size:11px;flex-wrap:wrap">
      <span style="color:var(--accent-cyan,#8FD4DE);font-weight:600">◐ Pre cotización</span>
      <label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" id="precotiz-ctl-on" ${P.on ? 'checked' : ''}> ${P.on ? 'ON' : 'off'}</label>
      <select id="precotiz-ctl-modo" style="font-size:11px;padding:2px 4px">
        <option value="draft" ${P.modo !== 'auto' ? 'selected' : ''}>borrador</option>
        <option value="auto" ${P.modo === 'auto' ? 'selected' : ''}>auto</option>
      </select>
      <span class="muted">${P.count || 0}/${P.cap || 10}${P.sample ? ' · ' + P.sample + '%' : ''}${P.draftCount ? ' · ' + P.draftCount + ' x aprobar' : ''}</span>
    </div>`;
}

function bindPrecotizControl() {
  const on = document.getElementById('precotiz-ctl-on');
  if (on) on.onchange = async () => { await precotizControl({ on: on.checked }); await fetchPrecotiz(); render(); };
  const modo = document.getElementById('precotiz-ctl-modo');
  if (modo) modo.onchange = async () => { await precotizControl({ modo: modo.value }); toast('Modo: ' + modo.value); };
}

function renderAutomatizaciones() {
  return `
    <div class="page-head">
      <div>
        <div class="eyebrow">WhatsApp</div>
        <h1>Automatizaciones</h1>
      </div>
      <div class="actions">
        <button class="btn btn-cyan" onclick="openBroadcastModal()">+ Crear broadcast</button>
        <button class="btn btn-ghost" onclick="bindAutomatizaciones()">↻ Refrescar</button>
      </div>
    </div>
    <div id="autos-body"><div class="loading"><div class="spinner"></div><p style="margin-top:14px">Cargando automatizaciones…</p></div></div>
  `;
}

async function bindAutomatizaciones() {
  const body = document.getElementById('autos-body');
  if (!body) return;
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/automations', { headers: authHeaders() });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    body.innerHTML = renderAutomatizacionesData(await r.json());
  } catch (e) {
    body.innerHTML = `<div class="error">No se pudieron cargar las automatizaciones.<br>${escapeHtml(e.message)}<br><br><button class="btn" onclick="bindAutomatizaciones()">Reintentar</button></div>`;
  }
}

function renderAutomatizacionesData(data) {
  const autos = (data && data.automations) || [];
  const stateMeta = {
    active:     { label: 'Activa',     cls: 'on'   },
    en_curso:   { label: 'En curso',   cls: 'live' },
    completado: { label: 'Completada', cls: 'done' },
    pausado:    { label: 'Pausada',    cls: 'warn' },
    disabled:   { label: 'Apagada',    cls: 'off'  },
    inactivo:   { label: 'Inactiva',   cls: 'idle' },
  };
  const statLabels = { queued: 'en cola', sent: 'enviados', skipped: 'omitidos', en_cola: 'en cola', enviados: 'enviados', respondieron: 'respondieron', positivas: 'positivas' };
  const renderStats = (s) => {
    const entries = Object.entries(s || {}).filter(([, v]) => v != null);
    if (!entries.length) return '';
    return `<div class="auto-stats">${entries.map(([k, v]) => `<span class="auto-stat"><b>${v}</b> ${statLabels[k] || k}</span>`).join('')}</div>`;
  };
  const groups = {};
  for (const a of autos) (groups[a.group] = groups[a.group] || []).push(a);
  const banner = data && data.billing_blocked
    ? `<div class="auto-banner warn">⚠ Envíos PAUSADOS por Meta (problema de facturación). Todas las automatizaciones de envío están frenadas hasta resolver la tarjeta.</div>`
    : '';
  const sections = Object.entries(groups).map(([g, items]) => `
    <div class="auto-group">
      <h2 class="auto-group-h">${escapeHtml(g)}</h2>
      <div class="auto-cards">
        ${items.map(a => {
          const sm = stateMeta[a.state] || { label: a.state, cls: 'idle' };
          return `<div class="card auto-card">
            <div class="auto-card-top">
              <span class="auto-name">${escapeHtml(a.name)}</span>
              <span class="auto-badge ${sm.cls}">${escapeHtml(sm.label)}</span>
            </div>
            <div class="auto-desc">${escapeHtml(a.desc)}</div>
            <div class="auto-trigger">⚡ ${escapeHtml(a.trigger)}</div>
            ${renderStats(a.stats)}
          </div>`;
        }).join('')}
      </div>
    </div>
  `).join('');
  const foot = `<div class="auto-foot">Bandeja de cursos (Abril): ${(data && data.cursos_inbox) || 0} chats · Podés crear broadcasts por CSV con el botón de arriba. Las reglas "escriben X → mandá Y" y los switches on/off llegan en las próximas fases.</div>`;
  return banner + sections + foot;
}

// Parser de CSV para broadcasts: detecta delimitador, header opcional, y saca
// telefono + nombre de cada fila. El worker re-normaliza/dedupea, así que acá
// solo extraemos candidatos.
function _parseBroadcastCsv(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { contacts: [], invalid: 0 };
  const delim = lines[0].includes('\t') ? '\t' : (lines[0].includes(';') ? ';' : ',');
  const rows = lines.map(l => l.split(delim).map(c => c.trim().replace(/^"|"$/g, '')));
  const looksPhone = (s) => String(s || '').replace(/\D/g, '').length >= 8;
  let header = null, dataRows = rows;
  if (!rows[0].some(looksPhone)) { header = rows[0].map(h => h.toLowerCase()); dataRows = rows.slice(1); }
  let phoneIdx = -1, nameIdx = -1;
  if (header) {
    phoneIdx = header.findIndex(h => /tel|phone|cel|whats|num/.test(h));
    nameIdx = header.findIndex(h => /nombre|name|contacto|cliente/.test(h));
  }
  const contacts = []; let invalid = 0;
  for (const r of dataRows) {
    let phone, nombre;
    if (phoneIdx >= 0) {
      phone = r[phoneIdx];
      nombre = nameIdx >= 0 ? r[nameIdx] : (r.find((c, i) => i !== phoneIdx && c && !looksPhone(c)) || '');
    } else {
      const pi = r.findIndex(looksPhone);
      phone = pi >= 0 ? r[pi] : r[0];
      nombre = r.find((c, i) => i !== pi && c && !looksPhone(c)) || '';
    }
    if (!phone || !looksPhone(phone)) { invalid++; continue; }
    contacts.push({ phone: String(phone), nombre: String(nombre || '') });
  }
  return { contacts, invalid };
}

// Modal para crear un broadcast (Fase 2): CSV + plantilla + goteo, con preview
// de seguridad (dry-run) antes de encolar de verdad.
function openBroadcastModal() {
  document.getElementById('bc-modal')?.remove();
  loadChatTemplates();
  const verts = qrVerticalsForUser();
  const tpls = (chatState.templates || []).filter(t => !verts || verts.includes(templateVertical(t.name)));
  const tplRows = (tpls.map(t => _renderTplItem(t)).join('') || '<div class="nc-empty">No hay plantillas aprobadas.</div>')
    + '<div class="qr-item" data-tpl-create="1"><div class="qr-item-text"><span class="qr-shortcut" style="color:var(--neon-cyan,#8FD4DE)">📋 Crear plantilla nueva (Meta)</span></div></div>';
  const bg = document.createElement('div');
  bg.id = 'bc-modal';
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal" style="max-width:520px;width:94vw">
      <div class="modal-h"><h3>Crear broadcast</h3></div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:14px;max-height:72vh;overflow:auto">
        <div class="nc-note">Mandá una plantilla aprobada a una lista de contactos (CSV), con goteo para no quemar la cuenta. Revisá el <strong>preview</strong> antes de encolar.</div>
        <label class="nc-field">
          <span class="nc-label">Nombre del broadcast (interno)</span>
          <input type="text" id="bc-name" class="nc-input" placeholder="Ej: Reactivación junio" autocomplete="off">
        </label>
        <div class="nc-field">
          <span class="nc-label">Contactos (CSV: teléfono, nombre)</span>
          <input type="file" id="bc-file" accept=".csv,.txt" style="margin-bottom:6px;font-size:12px">
          <textarea id="bc-csv" class="nc-input" rows="4" placeholder="O pegá acá, uno por línea:&#10;5491122334455, Sofia&#10;1133445566, Mateo" style="resize:vertical;font-family:monospace;font-size:12px"></textarea>
          <span class="nc-hint" id="bc-csv-hint"></span>
        </div>
        <div class="nc-field">
          <span class="nc-label">Plantilla a enviar</span>
          <div class="nc-tpl-list" id="bc-tpl-list">${tplRows}</div>
        </div>
        <div class="nc-field" id="bc-preview-field" style="display:none">
          <span class="nc-label">Vista previa del mensaje</span>
          <div class="nc-preview" id="bc-preview"></div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <label class="nc-field" style="flex:1;min-width:150px">
            <span class="nc-label">Arranca</span>
            <input type="datetime-local" id="bc-start" class="nc-input">
            <span class="nc-hint">vacío = ahora</span>
          </label>
          <label class="nc-field" style="flex:1;min-width:110px">
            <span class="nc-label">Cada (seg)</span>
            <input type="number" id="bc-interval" class="nc-input" value="32" min="5" max="3600">
            <span class="nc-hint">goteo entre envíos</span>
          </label>
        </div>
        <div class="nc-field" style="border-top:1px solid var(--border,#2a2a36);padding-top:12px">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin:0">
            <input type="checkbox" id="bc-reply-on"> <span class="nc-label" style="margin:0">Responder automático según la respuesta (IA)</span>
          </label>
          <div id="bc-reply-cfg" style="display:none;flex-direction:column;gap:8px;margin-top:8px">
            <span class="nc-hint">Cuando conteste, la IA decide. Sale como texto libre (gratis, ventana abierta).</span>
            <textarea id="bc-reply-pos" class="nc-input" rows="2" placeholder="Si contesta algo POSITIVO, mandar..." style="resize:vertical"></textarea>
            <textarea id="bc-reply-neg" class="nc-input" rows="2" placeholder="Si contesta algo NEGATIVO, mandar (opcional)..." style="resize:vertical"></textarea>
          </div>
        </div>
        <div class="nc-field" style="border-top:1px solid var(--border,#2a2a36);padding-top:12px">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin:0">
            <input type="checkbox" id="bc-fu-on"> <span class="nc-label" style="margin:0">Seguimiento si NO contesta</span>
          </label>
          <div id="bc-fu-cfg" style="display:none;flex-direction:column;gap:8px;margin-top:8px">
            <label class="nc-field" style="max-width:170px;margin:0">
              <span class="nc-label">A las (horas)</span>
              <input type="number" id="bc-fu-hours" class="nc-input" value="24" min="1" max="168">
            </label>
            <span class="nc-hint">No contestó = ventana cerrada → tiene que ser plantilla aprobada:</span>
            <div class="nc-tpl-list" id="bc-fu-tpl-list">${tplRows}</div>
            <div id="bc-fu-preview-field" style="display:none"><span class="nc-label">Vista previa del seguimiento</span><div class="nc-preview" id="bc-fu-preview"></div></div>
          </div>
        </div>
        <div id="bc-summary" style="display:none"><div class="auto-banner warn" id="bc-summary-box" style="margin:0"></div></div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost modal-cancel" type="button">Cancelar</button>
        <button class="btn btn-cyan" id="bc-create" type="button" disabled>Crear y encolar</button>
      </div>
    </div>`;
  document.body.appendChild(bg);
  void bg.offsetWidth; bg.classList.add('open'); requestAnimationFrame(() => bg.classList.add('open'));

  const fileEl = bg.querySelector('#bc-file');
  const csvEl = bg.querySelector('#bc-csv');
  const csvHint = bg.querySelector('#bc-csv-hint');
  const listEl = bg.querySelector('#bc-tpl-list');
  const previewField = bg.querySelector('#bc-preview-field');
  const previewEl = bg.querySelector('#bc-preview');
  const startEl = bg.querySelector('#bc-start');
  const intervalEl = bg.querySelector('#bc-interval');
  const createBtn = bg.querySelector('#bc-create');
  const summaryWrap = bg.querySelector('#bc-summary');
  const summaryBox = bg.querySelector('#bc-summary-box');
  const nameEl = bg.querySelector('#bc-name');
  const replyOnEl = bg.querySelector('#bc-reply-on');
  const replyCfg = bg.querySelector('#bc-reply-cfg');
  const replyPosEl = bg.querySelector('#bc-reply-pos');
  const replyNegEl = bg.querySelector('#bc-reply-neg');
  const fuOnEl = bg.querySelector('#bc-fu-on');
  const fuCfg = bg.querySelector('#bc-fu-cfg');
  const fuHoursEl = bg.querySelector('#bc-fu-hours');
  const fuListEl = bg.querySelector('#bc-fu-tpl-list');
  const fuPreviewField = bg.querySelector('#bc-fu-preview-field');
  const fuPreviewEl = bg.querySelector('#bc-fu-preview');

  let selectedName = null, selectedLang = 'es_AR', selectedParams = 0;
  let fuName = null, fuLang = 'es_AR', fuParams = 0;
  let parsed = { contacts: [], invalid: 0 };
  let confirmed = false;

  const close = () => bg.remove();
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  bg.querySelector('.modal-cancel').onclick = close;

  function refresh() {
    parsed = _parseBroadcastCsv(csvEl.value);
    if (csvEl.value.trim()) {
      csvHint.innerHTML = `<strong>${parsed.contacts.length}</strong> contactos detectados${parsed.invalid ? ` · ${parsed.invalid} sin teléfono (se descartan)` : ''}`;
      csvHint.className = 'nc-hint ok';
    } else { csvHint.textContent = ''; csvHint.className = 'nc-hint'; }
    const tpl = selectedName ? (chatState.templates || []).find(t => t.name === selectedName) : null;
    if (tpl) {
      previewEl.textContent = tplBodyText(tpl).replace(/\{\{\s*\d+\s*\}\}/g, '{nombre}');
      previewField.style.display = '';
    } else previewField.style.display = 'none';
    // Preview del seguimiento (Z).
    const fuTpl = fuName ? (chatState.templates || []).find(t => t.name === fuName) : null;
    if (fuTpl) { fuPreviewEl.textContent = tplBodyText(fuTpl).replace(/\{\{\s*\d+\s*\}\}/g, '{nombre}'); fuPreviewField.style.display = ''; }
    else fuPreviewField.style.display = 'none';
    // Cualquier cambio invalida un preview previo: hay que re-confirmar.
    if (confirmed) { confirmed = false; createBtn.textContent = 'Crear y encolar'; summaryWrap.style.display = 'none'; }
    const replyOk = !replyOnEl.checked || !!(replyPosEl.value || '').trim();
    const fuOk = !fuOnEl.checked || (!!fuName && parseFloat(fuHoursEl.value) > 0);
    createBtn.disabled = !(parsed.contacts.length && selectedName && replyOk && fuOk);
  }

  listEl.querySelectorAll('.qr-item').forEach(row => {
    row.onclick = () => {
      if (row.dataset.tplCreate === '1') { close(); showCreateTemplateBroadcast(); return; }
      if (!row.dataset.tplName) return;
      selectedName = row.dataset.tplName;
      selectedLang = row.dataset.tplLang || 'es_AR';
      selectedParams = parseInt(row.dataset.tplParams || '0', 10) || 0;
      listEl.querySelectorAll('.qr-item').forEach(r => r.classList.remove('nc-selected'));
      row.classList.add('nc-selected');
      refresh();
    };
  });
  fuListEl.querySelectorAll('.qr-item').forEach(row => {
    row.onclick = () => {
      if (row.dataset.tplCreate === '1') { close(); showCreateTemplateBroadcast(); return; }
      if (!row.dataset.tplName) return;
      fuName = row.dataset.tplName;
      fuLang = row.dataset.tplLang || 'es_AR';
      fuParams = parseInt(row.dataset.tplParams || '0', 10) || 0;
      fuListEl.querySelectorAll('.qr-item').forEach(r => r.classList.remove('nc-selected'));
      row.classList.add('nc-selected');
      refresh();
    };
  });
  replyOnEl.onchange = () => { replyCfg.style.display = replyOnEl.checked ? 'flex' : 'none'; refresh(); };
  fuOnEl.onchange = () => { fuCfg.style.display = fuOnEl.checked ? 'flex' : 'none'; refresh(); };
  [replyPosEl, replyNegEl, fuHoursEl].forEach(el => el.addEventListener('input', refresh));

  fileEl.onchange = () => {
    const f = fileEl.files && fileEl.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { csvEl.value = String(reader.result || ''); refresh(); };
    reader.readAsText(f);
  };
  csvEl.addEventListener('input', refresh);
  intervalEl.addEventListener('input', () => { if (confirmed) refresh(); });
  startEl.addEventListener('input', () => { if (confirmed) refresh(); });
  refresh();

  async function callApi(dryRun) {
    const tpl = (chatState.templates || []).find(t => t.name === selectedName);
    const fuTpl = fuName ? (chatState.templates || []).find(t => t.name === fuName) : null;
    const payload = {
      name: nameEl.value.trim(),
      template: selectedName,
      lang: selectedLang,
      param_mode: selectedParams >= 1 ? 'nombre' : 'none',
      body_preview: tpl ? tplBodyText(tpl) : '',
      contacts: parsed.contacts,
      startTs: startEl.value ? new Date(startEl.value).toISOString() : '',
      intervalSec: parseInt(intervalEl.value, 10) || 32,
      reply_ai: replyOnEl.checked ? 1 : 0,
      reply_pos_msg: replyOnEl.checked ? replyPosEl.value.trim() : '',
      reply_neg_msg: replyOnEl.checked ? replyNegEl.value.trim() : '',
      followup_hours: fuOnEl.checked ? (parseFloat(fuHoursEl.value) || 24) : null,
      followup_template: fuOnEl.checked ? (fuName || '') : '',
      followup_lang: fuLang,
      followup_param_mode: fuParams >= 1 ? 'nombre' : 'none',
      followup_preview: (fuOnEl.checked && fuTpl) ? tplBodyText(fuTpl) : '',
      dryRun
    };
    const r = await fetch(CONFIG.trackerUrl + '/admin/broadcasts', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload) });
    return r.json();
  }

  createBtn.onclick = async () => {
    if (!parsed.contacts.length || !selectedName) return;
    if (!confirmed) {
      createBtn.disabled = true; createBtn.textContent = 'Calculando…';
      const j = await callApi(true);
      createBtn.disabled = false;
      if (!j || !j.ok) { toast(j && j.error ? j.error : 'Error en el preview'); createBtn.textContent = 'Crear y encolar'; return; }
      const startTxt = j.start ? new Date(j.start).toLocaleString('es-AR') : 'ahora';
      const extras = [];
      if (replyOnEl.checked) extras.push('responde con IA según la contestación');
      if (fuOnEl.checked) extras.push(`seguimiento a las ${parseFloat(fuHoursEl.value) || 24}h si no contesta`);
      const extraTxt = extras.length ? `<br>+ ${extras.join(' · ')}.` : '';
      summaryBox.innerHTML = `Vas a mandar <strong>${escapeHtml(selectedName)}</strong> a <strong>${j.valid}</strong> contactos${j.invalid ? ` (${j.invalid} descartados)` : ''}.<br>Arranca <strong>${escapeHtml(startTxt)}</strong>, uno cada ${j.interval_sec}s (~${j.duration_min} min total).${extraTxt}<br><strong>Tocá de nuevo para confirmar y encolar.</strong>`;
      summaryWrap.style.display = '';
      createBtn.textContent = 'Confirmar y encolar';
      confirmed = true;
      return;
    }
    createBtn.disabled = true; createBtn.textContent = 'Encolando…';
    const j = await callApi(false);
    if (j && j.ok) {
      toast(`✓ Broadcast encolado: ${j.enqueued} contactos`);
      close();
      if (STATE.view === 'automatizaciones') bindAutomatizaciones();
    } else {
      toast(j && j.error ? j.error : 'Error al crear el broadcast');
      createBtn.disabled = false; createBtn.textContent = 'Confirmar y encolar';
    }
  };
}

// Validacion de plantilla para broadcast (guardrails de Meta: sin links/tel/
// MAYUS, largo, y reglas de la variable [nombre]). Devuelve null si esta OK.
function validateBroadcastTemplate(text) {
  const t = (text || '').trim();
  if (!t) return '';
  if (t.length < 10) return 'Muy corto (mínimo 10 caracteres).';
  if (t.length > 600) return 'Muy largo (máximo 600).';
  if (/https?:\/\/|www\.|wa\.me|t\.me|\b\S+\.(com|net|ar|org|io)\b/i.test(t)) return 'Sin links (Meta los rechaza).';
  if (/[A-ZÁÉÍÓÚÑ]{5,}/.test(t)) return 'Evitá palabras en MAYÚSCULAS.';
  if (/\d{7,}/.test(t)) return 'No incluyas números largos (teléfonos).';
  const varCount = (t.match(/\[nombre\]/gi) || []).length;
  if (varCount > 1) return 'Usá [nombre] una sola vez.';
  if (varCount === 1) {
    if (/^\s*\[nombre\]/i.test(t)) return 'No puede empezar con [nombre] (regla de Meta).';
    if (/\[nombre\]\s*$/i.test(t)) return 'No puede terminar con [nombre] (regla de Meta).';
  }
  return null;
}

// Crear una plantilla nueva para usar en broadcasts (sin cliente asociado). Va a
// Meta via /admin/wa/template-create con guardrails para que la aprueben. Queda
// PENDING hasta que Meta la apruebe (unos min); ahi aparece en la lista.
function showCreateTemplateBroadcast(opts) {
  opts = opts || {};
  const content = `
    <div class="manage-qr">
      <p class="manage-qr-hint">Creá una plantilla nueva. La mandamos a Meta para aprobación — cuando la aprueben (unos minutos) aparece en la lista de plantillas, lista para usar.</p>
      ${opts.scheduleInfo ? `<div style="background:#102a1e;border:1px solid #1f6f47;border-radius:8px;padding:8px 10px;font-size:12px;color:#9fe0b8;margin-bottom:8px">📅 Al crearla, queda <b>programado el seguimiento para ${escapeHtml(opts.scheduleInfo)}</b> con esta plantilla. Se manda cuando Meta la apruebe (unos min) y <b>solo si el cliente no te volvió a escribir antes</b>.</div>` : ''}
      <textarea id="bct-body" placeholder="Escribí el mensaje… Usá [nombre] donde quieras que vaya el nombre del contacto.&#10;Ej: Hola [nombre]! Te escribo de Neon Infinito para contarte una novedad 🙂" rows="5"></textarea>
      <div id="bct-warn" style="color:#ff6b6b;font-size:12px;min-height:16px;margin:4px 0"></div>
      <div id="bct-preview-wrap" style="display:none;margin:6px 0">
        <div style="font-size:11px;color:var(--muted,#8a93a3);margin-bottom:4px">Vista previa</div>
        <div class="nc-preview" id="bct-preview"></div>
      </div>
      <div style="font-size:12px;color:var(--fg-subtle,#8696a0);line-height:1.7;margin:6px 0">
        <b>Para que Meta la apruebe (categoría Marketing):</b><br>
        ✅ Mensaje claro y humano, como le escribirías a un cliente.<br>
        ✅ Podés usar <b>[nombre]</b> (una vez, ni al principio ni al final).<br>
        🚫 Sin links · 🚫 sin teléfonos · 🚫 sin MAYÚSCULAS · 🚫 nada engañoso.
      </div>
      <button class="btn btn-cyan" id="bct-btn" disabled>Crear plantilla</button>
    </div>
  `;
  openDrawer('Crear plantilla nueva', content);
  const ta = document.getElementById('bct-body');
  const warn = document.getElementById('bct-warn');
  const btn = document.getElementById('bct-btn');
  const pvWrap = document.getElementById('bct-preview-wrap');
  const pv = document.getElementById('bct-preview');
  const check = () => {
    const err = validateBroadcastTemplate(ta.value);
    warn.textContent = err || '';
    const has = !!ta.value.trim();
    btn.disabled = !!err || !has;
    if (has && !err) { pv.textContent = ta.value.replace(/\[nombre\]/gi, 'Sofia'); pvWrap.style.display = ''; }
    else pvWrap.style.display = 'none';
  };
  if (ta) { ta.oninput = check; setTimeout(() => ta.focus(), 50); }
  if (btn) btn.onclick = async () => {
    const text = (ta.value || '').trim();
    const err = validateBroadcastTemplate(text);
    if (err) { warn.textContent = err; return; }
    btn.disabled = true; btn.textContent = 'Creando…';
    const hasVar = /\[nombre\]/i.test(text);
    const bodyText = text.replace(/\[nombre\]/gi, '{{1}}');
    const name = 'bcast_' + Date.now().toString(36);
    try {
      const r = await fetch(CONFIG.trackerUrl + '/admin/wa/template-create', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ name, category: 'MARKETING', language: 'es_AR', body_text: bodyText, example_params: hasVar ? ['Sofia'] : [] })
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        closeDrawer();
        loadChatTemplates();
        if (opts.onCreated) { await opts.onCreated(name, hasVar); }
        else toast('✓ Plantilla enviada a Meta. Cuando la aprueben (unos min) aparece en la lista.');
      } else {
        warn.textContent = j.error || 'No se pudo crear';
        btn.disabled = false; btn.textContent = 'Crear plantilla';
      }
    } catch (e) {
      warn.textContent = 'Error: ' + (e.message || e);
      btn.disabled = false; btn.textContent = 'Crear plantilla';
    }
  };
}

// ---------- DASHBOARD ----------
function renderDashboard() {
  // Nadia (2da vendedora): dashboard reducido -> SOLO su panel "Tu sueldo". No ve
  // las métricas del negocio (ventas totales, AOV, cobrado, gráficos, etc.).
  if (isNadiaUser(STATE.user)) {
    return `
    <div class="page-head">
      <div>
        <div class="eyebrow">${new Date().toLocaleDateString('es-AR', {day:'2-digit', month:'long', year:'numeric'})}</div>
        <h1>Dashboard</h1>
      </div>
    </div>
    ${panelSueldoHtml('nadia')}
  `;
  }
  const cur = pedidosDash();
  const totalMes = cur.reduce((a,p)=>a+p.precio+p.precioDimmer, 0);
  // AOV = ventas / total de UNIDADES (no pedidos). Un pedido puede tener
  // múltiples carteles (ej. Bistau cantidad=10). Promediar por pedido sin
  // contar unidades infla el ticket promedio.
  const totalUnidades = cur.reduce((a,p) => a + (Number(p.cantidad) || 1), 0);
  const aov = totalUnidades ? totalMes / totalUnidades : 0;
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

    ${(() => {
      const tc = getTasaCierreDirecto(STATE.dashMonths);
      return `<div class="kpi-grid">
        <div class="kpi"><div class="kpi-label">Ventas mes</div><div class="kpi-value">${fmtMoney(totalMes)}</div><div class="kpi-delta">${cur.length} pedidos · ${totalUnidades} unidades</div></div>
        <div class="kpi cyan"><div class="kpi-label">Ticket promedio</div><div class="kpi-value">${fmtMoney(aov)}</div><div class="kpi-delta">ø por cartel</div></div>
        <div class="kpi"><div class="kpi-label">% Cobrado</div><div class="kpi-value">${pctCobrado}%</div><div class="kpi-delta">${fmtMoney(cobrado)} / ${fmtMoney(totalMes)}</div></div>
        <div class="kpi cyan"${tc.partial ? ' title="Datos parciales: tracking empezó el ' + fmtDate(tc.trackingStart) + '"' : ''}><div class="kpi-label">Tasa de cierre${tc.partial ? ' <span class="partial-flag">parcial</span>' : ''}</div><div class="kpi-value">${(tc.tasa*100).toFixed(1)}%</div><div class="kpi-delta">${tc.vendidos} ventas / ${tc.enviados} presu${tc.partial ? ' · desde ' + fmtDate(tc.trackingStart) : ''}</div></div>
        <div class="kpi"><div class="kpi-label">Total año</div><div class="kpi-value">${fmtMoney(STATE.pedidos.reduce((a,p)=>a+p.precio+p.precioDimmer,0))}</div><div class="kpi-delta">${STATE.pedidos.length} pedidos · año</div></div>
      </div>`;
    })()}

    ${isJoaquinUser(STATE.user) ? panelSueldoHtml('joaco') : (isNadiaUser(STATE.user) ? panelSueldoHtml('nadia') : '')}

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
          <h3>Para contactar esta semana</h3>
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

// ============================================================================
// ---------- BUSINESS PANEL (Gaspar only) ------------------------------------
// ============================================================================
// Lee del worker /admin/business-panel que parsea el Sheet "2025 V4".
// Cachea 1h en D1; el frontend refetchea al entrar y cada 1h en background.

const BP_VERTICALS = [
  { key: 'directo', label: 'Carteles Directo', color: 'var(--neon-red)' },
  { key: 'distris', label: 'Carteles Distris', color: 'var(--neon-cyan)' },
  { key: 'insumos', label: 'Insumos',          color: '#FFA726' },
  { key: 'cursos',  label: 'Cursos',           color: '#25D366' },
];
const BP_MONTHS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
let _bpRefreshTimer = null;

async function loadBusinessPanel(force) {
  if (!CONFIG.trackerUrl || !STATE.token) return;
  STATE.businessPanel.loading = true;
  STATE.businessPanel.error = null;
  if (STATE.view === 'dashboard' && isAdmin()) render();
  try {
    const r = await fetch(CONFIG.trackerUrl.replace(/\/$/, '') + '/admin/business-panel' + (force ? '?force=1' : ''), {
      headers: { 'Authorization': 'Bearer ' + STATE.token }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    STATE.businessPanel.data = j;
    STATE.businessPanel.lastFetch = Date.now();
  } catch (e) {
    STATE.businessPanel.error = e.message;
  } finally {
    STATE.businessPanel.loading = false;
    if (STATE.view === 'dashboard' && isAdmin()) render();
  }
}

function bindBusinessPanel() {
  const bp = STATE.businessPanel;
  if (!bp.data && !bp.loading && !bp.error) loadBusinessPanel(false);
  // Period tabs
  document.querySelectorAll('[data-bp-period]').forEach(b => {
    b.onclick = () => {
      STATE.businessPanel.period = b.dataset.bpPeriod;
      render();
    };
  });
  // Refresh
  const refresh = document.getElementById('bp-refresh');
  if (refresh) refresh.onclick = () => loadBusinessPanel(true);
  // Auto-refresh cada 1h en background (idempotente)
  if (_bpRefreshTimer) clearInterval(_bpRefreshTimer);
  _bpRefreshTimer = setInterval(() => {
    if (STATE.view === 'dashboard' && isAdmin()) loadBusinessPanel(false);
  }, 60 * 60 * 1000);
  // Click en una fila de vertical → drill-down
  document.querySelectorAll('[data-bp-vertical]').forEach(row => {
    row.style.cursor = 'pointer';
    row.onclick = () => {
      STATE.businessPanel.selectedVertical = row.dataset.bpVertical;
      render();
    };
  });
  // Botón "Volver al panel general"
  const back = document.getElementById('bp-back');
  if (back) back.onclick = () => {
    STATE.businessPanel.selectedVertical = null;
    render();
  };
  // Dibujar charts si hay data
  if (bp.data) {
    if (bp.selectedVertical) {
      requestAnimationFrame(() => drawVerticalCharts(bp.selectedVertical));
    } else {
      requestAnimationFrame(() => drawBusinessCharts());
    }
  }
}

// === Helpers ===
function bpFmt(n) {
  if (STATE.privacy) return '$•••';
  if (!n) return '-';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return sign + '$' + (abs / 1_000_000).toFixed(2) + 'M';
  if (abs >= 1_000)     return sign + '$' + (abs / 1_000).toFixed(0) + 'k';
  return sign + '$' + Math.round(abs);
}
function bpFmtNum(n) {
  // Para etiquetas de gráficos: en privacy mode también ocultar montos
  if (STATE.privacy) return '•••';
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(0) + 'k';
  return String(Math.round(n));
}
// Lunes-sábado de la semana actual (domingos no trabajan)
function bpWeekRange() {
  const today = new Date();
  const dow = today.getDay(); // 0=Dom, 1=Lun ... 6=Sab
  const monOffset = (dow === 0 ? -6 : 1 - dow); // si es domingo, ir al lunes anterior
  const mon = new Date(today); mon.setDate(today.getDate() + monOffset); mon.setHours(0,0,0,0);
  const sat = new Date(mon); sat.setDate(mon.getDate() + 5); sat.setHours(23,59,59,999);
  return { start: mon, end: sat };
}
function bpMonthRange(yyyymm) {
  // yyyymm opcional: '2026-04'. Si no, mes actual.
  let y, m;
  if (yyyymm) { const p = yyyymm.split('-'); y = +p[0]; m = +p[1] - 1; }
  else { const now = new Date(); y = now.getFullYear(); m = now.getMonth(); }
  return {
    start: new Date(y, m, 1),
    end: new Date(y, m + 1, 0, 23, 59, 59, 999)
  };
}
function bpAllRange() {
  const bp = STATE.businessPanel.data;
  const all = [...(bp?.directo||[]), ...(bp?.distris||[]), ...(bp?.insumos||[]), ...(bp?.cursos||[])];
  if (!all.length) return { start: new Date(2026,0,1), end: new Date() };
  const dates = all.map(r => new Date((r.fecha||'') + 'T12:00:00').getTime()).filter(Boolean);
  return { start: new Date(Math.min(...dates)), end: new Date() };
}
function bpInRange(isoDate, range) {
  const d = new Date(isoDate + 'T12:00:00');
  return d >= range.start && d <= range.end;
}
// Devuelve meses únicos con datos: ['2026-05', '2026-04', ...] desc.
function bpAvailableMonths() {
  const bp = STATE.businessPanel.data; if (!bp) return [];
  const set = new Set();
  for (const arr of [bp.directo, bp.distris, bp.insumos, bp.cursos]) {
    for (const r of (arr || [])) {
      if (r.fecha) set.add(r.fecha.slice(0, 7));
    }
  }
  return [...set].sort().reverse();
}

// Calcula KPIs y métricas según el período seleccionado.
function bpCompute() {
  const bp = STATE.businessPanel;
  if (!bp.data) return null;
  const period = bp.period || 'current';
  let range;
  if (period === 'week') range = bpWeekRange();
  else if (period === 'all') range = bpAllRange();
  else if (period === 'current') range = bpMonthRange(); // mes actual
  else if (/^\d{4}-\d{2}$/.test(period)) range = bpMonthRange(period); // mes específico
  else range = bpMonthRange();

  const directo = bp.data.directo.filter(r => bpInRange(r.fecha, range));
  const distris = bp.data.distris.filter(r => bpInRange(r.fecha, range));
  const insumos = bp.data.insumos.filter(r => bpInRange(r.fecha, range));
  const cursos  = bp.data.cursos .filter(r => bpInRange(r.fecha, range));

  const sumVenta = (arr) => arr.reduce((a, r) => a + (r.venta || r.vendido || 0), 0);
  const sumCostosD = (arr) => arr.reduce((a, r) => a + Object.values(r.costos || {}).reduce((s, x) => s + (x || 0), 0), 0);

  // sumUnidades: para directo y distris usamos r.cant (col Cantidad del Sheet).
  // Para insumos y cursos no hay cantidad explícita, tratamos cada fila como 1.
  const sumUnidades = (arr) => arr.reduce((a, r) => a + (Number(r.cant) || 1), 0);
  const verticals = {
    directo: { count: directo.length, unidades: sumUnidades(directo), ventas: sumVenta(directo), costos: sumCostosD(directo) },
    distris: { count: distris.length, unidades: sumUnidades(distris), ventas: sumVenta(distris), costos: sumCostosD(distris) },
    insumos: { count: insumos.length, unidades: insumos.length,       ventas: sumVenta(insumos), costos: insumos.reduce((a,r)=>a+(r.costo||0),0) },
    cursos:  { count: cursos.length,  unidades: cursos.length,        ventas: sumVenta(cursos),  costos: cursos.reduce((a,r)=>a+(r.comisionMp||0),0) },
  };
  for (const k of Object.keys(verticals)) {
    const v = verticals[k];
    // AOV = ventas / UNIDADES, no por pedido. Pedidos con cantidad > 1
    // (ej. Bistau con 10 carteles) inflaban el ticket promedio.
    v.aov = v.unidades ? v.ventas / v.unidades : 0;
    v.margen = v.ventas - v.costos;
    v.margenPct = v.ventas ? (v.margen / v.ventas) : 0;
  }
  const total = {
    count: Object.values(verticals).reduce((a,v)=>a+v.count,0),
    unidades: Object.values(verticals).reduce((a,v)=>a+v.unidades,0),
    ventas: Object.values(verticals).reduce((a,v)=>a+v.ventas,0),
    costos: Object.values(verticals).reduce((a,v)=>a+v.costos,0),
    fijos: 0,
  };
  total.aov = total.unidades ? total.ventas / total.unidades : 0;
  total.margen = total.ventas - total.costos;
  total.margenPct = total.ventas ? (total.margen / total.ventas) : 0;

  // === OVERRIDE con PnL real (más preciso, incluye Fijos + ADS + contingencias) ===
  // La PnL del Sheet tiene CMA precalculado a nivel mensual.
  // Para esta semana o ranges no-mensuales, prorrateamos los fijos por días lun-sáb.
  const pnl = bp.data.pnl || [];
  const monthsInRange = (() => {
    const out = [];
    const start = new Date(range.start.getFullYear(), range.start.getMonth(), 1);
    const end = new Date(range.end.getFullYear(), range.end.getMonth(), 1);
    for (let d = new Date(start); d <= end; d.setMonth(d.getMonth() + 1)) {
      out.push({ y: d.getFullYear(), m: d.getMonth() + 1 });
    }
    return out;
  })();
  // Sumar PnL de los meses incluidos
  let pnlIngresos = 0, pnlCostos = 0, pnlFijos = 0, pnlMargen = 0;
  const pnlByVertical = { directo: { ingresos: 0, costos: 0 }, distris: { ingresos: 0, costos: 0 }, insumos: { ingresos: 0, costos: 0 }, cursos: { ingresos: 0, costos: 0 } };
  for (const { m } of monthsInRange) {
    const row = pnl.find(p => p.month === m);
    if (!row) continue;
    pnlIngresos += row.ingresos.total;
    pnlCostos   += Math.abs(row.costos.total);
    pnlFijos    += Math.abs(row.costos.fijos);
    pnlMargen   += row.margen;
    for (const v of ['directo', 'distris', 'insumos', 'cursos']) {
      pnlByVertical[v].ingresos += row.ingresos[v];
      pnlByVertical[v].costos   += Math.abs(row.costos[v]);
    }
  }
  // Si el rango cubre meses completos (current, mes específico, all) → usar PnL directo.
  // Si es 'week' → prorrateamos fijos por # días lun-sáb del rango.
  const useFullPnl = period === 'current' || period === 'all' || /^\d{4}-\d{2}$/.test(period);
  if (useFullPnl && pnlIngresos > 0) {
    // Override total con valores PnL (más confiables — fuente contable de Iñaki)
    total.ventas = pnlIngresos;
    total.costos = pnlCostos;
    total.fijos = pnlFijos;
    total.margen = pnlMargen;
    total.margenPct = pnlIngresos ? (pnlMargen / pnlIngresos) : 0;
    // Override verticals con PnL (ingresos + costos) para que donut/tabla
    // sean consistentes con el KPI total. Los counts (# transacciones)
    // siguen viniendo de raw rows porque el PnL no los tiene.
    for (const v of ['directo', 'distris', 'insumos', 'cursos']) {
      const pv = pnlByVertical[v];
      if (pv.ingresos > 0 || pv.costos > 0) {
        verticals[v].ventas = pv.ingresos;
        verticals[v].costos = pv.costos;
        verticals[v].margen = pv.ingresos - pv.costos;
        verticals[v].margenPct = pv.ingresos ? (verticals[v].margen / pv.ingresos) : 0;
        verticals[v].aov = verticals[v].unidades ? pv.ingresos / verticals[v].unidades : 0;
      }
    }
  } else if (period === 'week') {
    // Prorrateo de Fijos: tomamos los Fijos del mes en curso, los dividimos
    // por # días lun-sáb del mes y multiplicamos por # días lun-sáb pasados de la semana.
    const today = new Date();
    const mRow = pnl.find(p => p.month === today.getMonth() + 1);
    if (mRow) {
      const fijosMes = Math.abs(mRow.costos.fijos);
      // Días lun-sáb del mes
      const y = today.getFullYear(), mo = today.getMonth();
      const dim = new Date(y, mo + 1, 0).getDate();
      let workDays = 0;
      for (let d = 1; d <= dim; d++) {
        const dow = new Date(y, mo, d).getDay();
        if (dow !== 0) workDays++;
      }
      // Días lun-sáb pasados desde el lunes hasta hoy (o sábado si ya pasó)
      let weekDays = 0;
      for (let d = new Date(range.start); d <= range.end && d <= today; d = addDays(d, 1)) {
        if (d.getDay() !== 0) weekDays++;
      }
      const fijosWeek = workDays > 0 ? fijosMes * (weekDays / workDays) : 0;
      total.fijos = fijosWeek;
      total.costos = total.costos + fijosWeek;
      total.margen = total.ventas - total.costos;
      total.margenPct = total.ventas ? (total.margen / total.ventas) : 0;
    }
  }

  // Top carteles del período (más caros) — clasificamos por canal (Directo/Distri)
  const topCarteles = [
    ...directo.map(r => ({ ...r, canal: 'Directo' })),
    ...distris.map(r => ({ ...r, canal: 'Distri' }))
  ]
    .sort((a, b) => b.venta - a.venta)
    .slice(0, 8);

  // # carteles total (directo + distris) — usamos UNIDADES (cant) no filas.
  // Un pedido con cantidad=10 cuenta como 10 carteles, no 1.
  const totalCarteles = verticals.directo.unidades + verticals.distris.unidades;
  const ventaCarteles = verticals.directo.ventas + verticals.distris.ventas;
  const aovCarteles = totalCarteles ? ventaCarteles / totalCarteles : 0;

  return { period, range, verticals, total, topCarteles, totalCarteles, aovCarteles };
}

// === Render ===
function renderBusinessPanel() {
  const bp = STATE.businessPanel;
  // Loading inicial
  if (!bp.data && bp.loading) {
    return `<div class="page-head"><h1>Panel de Negocio</h1></div>
      <div class="loading"><div class="spinner"></div><p style="margin-top:14px">Leyendo Sheet "2025 V4"…</p></div>`;
  }
  if (bp.error && !bp.data) {
    return `<div class="page-head"><h1>Panel de Negocio</h1></div>
      <div class="error">Error: ${escapeHtml(bp.error)}<br><br>
        <button class="btn" id="bp-refresh">Reintentar</button>
      </div>`;
  }
  if (!bp.data) {
    return `<div class="page-head"><h1>Panel de Negocio</h1></div>
      <div class="loading"><div class="spinner"></div></div>`;
  }
  // Si hay vertical seleccionada → mostrar drill-down detallado
  if (bp.selectedVertical) {
    return renderVerticalDetail(bp.selectedVertical);
  }
  const c = bpCompute();
  if (!c) return '<div class="loading"><div class="spinner"></div></div>';

  const period = bp.period || 'current';
  const ageS = Math.floor((Date.now() - bp.lastFetch) / 1000);
  const ageLabel = ageS < 60 ? 'recién' : ageS < 3600 ? `hace ${Math.floor(ageS/60)} min` : `hace ${Math.floor(ageS/3600)}h`;
  const months = bpAvailableMonths();
  const periodLabel = period === 'week' ? 'Esta semana'
                    : period === 'all'  ? 'Todos los meses'
                    : period === 'current' ? new Date().toLocaleDateString('es-AR', {month:'long', year:'numeric'})
                    : (() => { const [y,m] = period.split('-'); return new Date(+y, +m-1, 1).toLocaleDateString('es-AR', {month:'long', year:'numeric'}); })();

  return `
    <div class="period-selector">
      <span class="ps-label">Período</span>
      <div class="ps-chips">
        <button class="ps-chip ${period==='current'?'active':''}" data-bp-period="current">Mes actual</button>
        <button class="ps-chip ${period==='week'?'active':''}" data-bp-period="week">Esta semana</button>
        <button class="ps-chip ${period==='all'?'active':''}" data-bp-period="all">Todos</button>
        ${months.map(m => {
          const [y, mm] = m.split('-');
          const lbl = new Date(+y, +mm - 1, 1).toLocaleDateString('es-AR', {month:'short'}).replace('.','');
          return `<button class="ps-chip ${period===m?'active':''}" data-bp-period="${m}">${lbl} ${y.slice(2)}</button>`;
        }).join('')}
      </div>
      <span class="ps-meta">${periodLabel} · ${c.total.count} ventas · ${c.totalCarteles} carteles</span>
    </div>

    <div class="page-head">
      <div>
        <div class="eyebrow" style="display:flex;align-items:center;gap:8px">
          <span style="background:rgba(255,24,48,.12);color:var(--neon-red);padding:2px 8px;border-radius:4px;font-weight:700;letter-spacing:.5px">🔒 SOLO GASPAR</span>
          ${new Date().toLocaleDateString('es-AR', {day:'2-digit', month:'long', year:'numeric'})}
        </div>
        <h1>Dashboard</h1>
      </div>
      <div class="actions">
        <span style="color:var(--fg-subtle);font-size:12px;margin-right:8px">Actualizado ${ageLabel}</span>
        <button class="btn btn-ghost" id="bp-refresh">↻ Refrescar</button>
        <a class="btn btn-cyan" href="https://docs.google.com/spreadsheets/d/1PLG-vosgVtvhYYaBLi5Rh-LM6f2A_BvG3i6-a7NpNCE/edit" target="_blank">Abrir Sheet ↗</a>
      </div>
    </div>

    ${(() => {
      // Tasa de cierre: re-usar los presupuestos del Sheet "Ventas" filtrados al período.
      // Mapeamos period del panel → monthsFilter del helper de Joaco.
      let monthsFilter;
      if (period === 'all') monthsFilter = 'all';
      else if (period === 'current') monthsFilter = null;
      else if (/^\d{4}-\d{2}$/.test(period)) monthsFilter = new Set([period]);
      else monthsFilter = null; // week → mes actual como aproximación
      const tc = getTasaCierreDirecto(monthsFilter);
      return `<div class="kpi-grid">
        <div class="kpi"><div class="kpi-label">Ventas</div><div class="kpi-value">${bpFmt(c.total.ventas)}</div><div class="kpi-delta">${c.total.count} pedidos · ${c.total.unidades} unidades</div></div>
        <div class="kpi cyan"><div class="kpi-label">Costos totales</div><div class="kpi-value">${bpFmt(c.total.costos)}</div><div class="kpi-delta">${c.total.fijos ? 'Fijos: ' + bpFmt(c.total.fijos) : Math.round((c.total.costos/Math.max(1,c.total.ventas))*100) + '% s/ ventas'}</div></div>
        <div class="kpi"><div class="kpi-label">Margen operativo (CMA)</div><div class="kpi-value" style="color:${c.total.margen >= 0 ? 'var(--success, #25D366)' : 'var(--neon-red)'}">${bpFmt(c.total.margen)}</div><div class="kpi-delta">${Math.round(c.total.margenPct*100)}% del ingreso</div></div>
        <div class="kpi cyan"><div class="kpi-label">Ticket promedio</div><div class="kpi-value">${bpFmt(c.total.aov)}</div><div class="kpi-delta">ø por cartel</div></div>
        <div class="kpi"${tc.partial ? ' title="Datos parciales: tracking empezó el ' + fmtDate(tc.trackingStart) + '"' : ''}><div class="kpi-label">Tasa de cierre Directo${tc.partial ? ' <span class="partial-flag">parcial</span>' : ''}</div><div class="kpi-value">${(tc.tasa*100).toFixed(1)}%</div><div class="kpi-delta">${tc.vendidos} ventas / ${tc.enviados} presu${tc.partial ? ' · desde ' + fmtDate(tc.trackingStart) : ''}</div></div>
        <div class="kpi cyan"><div class="kpi-label">Carteles totales</div><div class="kpi-value">${c.totalCarteles}</div><div class="kpi-delta">ø ${bpFmt(c.aovCarteles)} c/u</div></div>
      </div>`;
    })()}

    <div class="bp-charts-row">
      <div class="card chart-card bp-chart-wide">
        <div class="card-h"><h3>Ingresos vs Costos por mes (FY ${new Date().getFullYear()})</h3></div>
        <div class="chart-canvas" id="bp-chart-bars-line"></div>
      </div>
      <div class="card">
        <div class="card-h"><h3>Mix por vertical</h3></div>
        <div class="chart-canvas" id="bp-chart-donut"></div>
        <div class="legend" id="bp-legend-donut"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-h"><h3>Run-Rate · Ingresos por vertical (stacked, mensual)</h3></div>
      <div class="chart-canvas" id="bp-chart-stacked" style="height:280px"></div>
      <div class="legend" id="bp-legend-stacked"></div>
    </div>

    <div class="card" style="margin-top:18px">
      <div class="card-h"><h3>Por vertical de negocio</h3><span class="muted" style="margin-left:auto;font-size:12px">${escapeHtml(periodLabel)}</span></div>
      <table class="bp-table">
        <thead>
          <tr>
            <th>Vertical</th><th># ventas</th><th>Ingresos</th><th>ø precio</th><th>Costos</th><th>Margen</th><th>%</th><th style="width:120px">Share</th>
          </tr>
        </thead>
        <tbody>
          ${BP_VERTICALS.map(v => {
            const x = c.verticals[v.key];
            const share = c.total.ventas ? (x.ventas / c.total.ventas) : 0;
            return `<tr class="bp-vertical-row" data-bp-vertical="${v.key}" title="Click para ver análisis detallado">
              <td><span class="bp-vname"><span class="bp-vdot" style="background:${v.color}"></span>${v.label} <span class="bp-drill-hint">→</span></span></td>
              <td class="num">${x.count}</td>
              <td class="num">${bpFmt(x.ventas)}</td>
              <td class="num">${bpFmt(x.aov)}</td>
              <td class="num">${bpFmt(x.costos)}</td>
              <td class="num">${bpFmt(x.margen)}</td>
              <td class="num">${Math.round(x.margenPct*100)}%</td>
              <td><div class="bp-bar-bg"><div class="bp-bar-fg" style="width:${(share*100).toFixed(1)}%;background:${v.color}"></div></div></td>
            </tr>`;
          }).join('')}
          <tr class="total">
            <td>TOTAL</td>
            <td class="num">${c.total.count}</td>
            <td class="num">${bpFmt(c.total.ventas)}</td>
            <td class="num">${bpFmt(c.total.aov)}</td>
            <td class="num">${bpFmt(c.total.costos)}</td>
            <td class="num">${bpFmt(c.total.margen)}</td>
            <td class="num">${Math.round(c.total.margenPct*100)}%</td>
            <td></td>
          </tr>
        </tbody>
      </table>
    </div>

    ${(() => {
      let monthsFilter;
      if (period === 'all') monthsFilter = 'all';
      else if (period === 'current') monthsFilter = null;
      else if (/^\d{4}-\d{2}$/.test(period)) monthsFilter = new Set([period]);
      else monthsFilter = null;
      const tc = getTasaCierreDirecto(monthsFilter);
      const enviados = tc.enviados;
      const vendidos = tc.vendidos;
      const noCerrados = Math.max(0, enviados - vendidos);
      const wPct = (n) => enviados ? Math.max(2, (n / enviados) * 100) : 0;
      return `<div class="card" style="margin-top:18px">
        <div class="card-h">
          <h3>Funnel Pedidos Directo · Presupuestos → Ventas</h3>
          <span class="muted" style="margin-left:auto;font-size:12px">${escapeHtml(periodLabel)}</span>
        </div>
        ${tc.partial ? `<div class="bp-partial-banner">
          ⚠ Datos parciales: el tracking de presupuestos empezó el <b>${fmtDate(tc.trackingStart)}</b>.
          El denominador (# presupuestos) no incluye los anteriores a esa fecha,
          así que la tasa real del período puede ser más baja.
        </div>` : ''}
        <div style="padding:16px 20px">
          <div class="bp-funnel">
            <div class="bp-funnel-row">
              <div class="bp-funnel-lbl">Presupuestos enviados</div>
              <div class="bp-funnel-bar-wrap"><div class="bp-funnel-bar" style="width:100%;background:rgba(143,212,222,.65)"><span class="bp-funnel-num">${enviados}</span><span class="bp-funnel-pct">100%</span></div></div>
            </div>
            <div class="bp-funnel-row">
              <div class="bp-funnel-lbl">No cerrados</div>
              <div class="bp-funnel-bar-wrap"><div class="bp-funnel-bar" style="width:${wPct(noCerrados)}%;background:rgba(255,24,48,.55)"><span class="bp-funnel-num">${noCerrados}</span><span class="bp-funnel-pct">${enviados ? ((noCerrados/enviados)*100).toFixed(1) : 0}%</span></div></div>
            </div>
            <div class="bp-funnel-row">
              <div class="bp-funnel-lbl">Vendidos</div>
              <div class="bp-funnel-bar-wrap"><div class="bp-funnel-bar" style="width:${wPct(vendidos)}%;background:rgba(37,211,102,.75)"><span class="bp-funnel-num">${vendidos}</span><span class="bp-funnel-pct">${enviados ? ((vendidos/enviados)*100).toFixed(1) : 0}%</span></div></div>
            </div>
          </div>
          <div class="bp-stat-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:18px;padding-top:14px;border-top:1px solid var(--border)">
            <div><div style="font-size:11px;text-transform:uppercase;color:var(--fg-subtle);letter-spacing:.5px">Tasa de cierre</div><div style="font-size:22px;font-weight:700;color:var(--neon-cyan);font-family:ui-monospace,monospace">${(tc.tasa*100).toFixed(1)}%</div><div style="font-size:11px;color:var(--fg-subtle)">${vendidos} ventas / ${enviados} presu</div></div>
            <div><div style="font-size:11px;text-transform:uppercase;color:var(--fg-subtle);letter-spacing:.5px">Match nombre+precio</div><div style="font-size:22px;font-weight:700;font-family:ui-monospace,monospace">${tc.cerradosMatch}<span style="font-size:13px;color:var(--fg-subtle);font-weight:400"> de ${enviados}</span></div><div style="font-size:11px;color:var(--fg-subtle)">presu identificables como vendidos</div></div>
            <div><div style="font-size:11px;text-transform:uppercase;color:var(--fg-subtle);letter-spacing:.5px">Diferencia</div><div style="font-size:22px;font-weight:700;font-family:ui-monospace,monospace">${vendidos - tc.cerradosMatch >= 0 ? '+' : ''}${vendidos - tc.cerradosMatch}</div><div style="font-size:11px;color:var(--fg-subtle)">ventas sin presu identificable</div></div>
          </div>
        </div>
      </div>`;
    })()}

    <div class="card" style="margin-top:18px">
      <div class="card-h"><h3>Top carteles del período</h3><span class="muted" style="margin-left:auto;font-size:12px">${escapeHtml(periodLabel)} · ${c.totalCarteles} carteles</span></div>
      <table class="bp-table compact">
        <thead><tr><th>Cliente</th><th>Fecha</th><th>Canal</th><th class="num">Venta</th></tr></thead>
        <tbody>
          ${c.topCarteles.length ? c.topCarteles.map(p => `
            <tr>
              <td>${escapeHtml(p.cliente || '—')}</td>
              <td>${p.fecha}</td>
              <td><span class="bp-pill" style="background:${p.canal === 'Directo' ? 'rgba(255,24,48,.12)' : 'rgba(143,212,222,.12)'};color:${p.canal === 'Directo' ? 'var(--neon-red)' : 'var(--neon-cyan)'}">${p.canal}</span></td>
              <td class="num">${bpFmt(p.venta)}</td>
            </tr>
          `).join('') : '<tr><td colspan="4" class="muted" style="text-align:center;padding:14px">Sin ventas en el período</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

// === Charts (SVG puro, mismo estilo que drawDonut existente) ===
function drawBusinessCharts() {
  drawBpBarsLine();
  drawBpStacked();
  drawBpDonut();
}

// 1. Bars (ingresos) + Line (costos) por mes — igual a la primera foto
function drawBpBarsLine() {
  const el = document.getElementById('bp-chart-bars-line'); if (!el) return;
  const pnl = STATE.businessPanel.data?.pnl || [];
  if (!pnl.length) { el.innerHTML = '<div class="loading muted">sin datos</div>'; return; }
  const W = el.clientWidth || 700, H = 260, PL = 56, PR = 16, PT = 24, PB = 32;
  const max = Math.max(...pnl.map(p => Math.max(p.ingresos.total, Math.abs(p.costos.total))), 1);
  const xStep = (W - PL - PR) / 12;
  const xAt = (m) => PL + (m - 0.5) * xStep;
  const yAt = (v) => (H - PB) - (v / max) * (H - PB - PT);
  const barW = xStep * 0.55;
  const yTicks = [0, max/2, max].map(v => ({ v, y: yAt(v) }));
  const bars = pnl.map((p, i) => {
    const m = i + 1;
    const x = xAt(m) - barW/2;
    const y = yAt(p.ingresos.total);
    const h = (H - PB) - y;
    return p.ingresos.total > 0
      ? `<g class="bp-bar-g">
           <rect class="bp-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0,h).toFixed(1)}" rx="3"/>
           <text class="bp-bar-lbl" x="${(x+barW/2).toFixed(1)}" y="${(y-6).toFixed(1)}" text-anchor="middle">${bpFmtNum(p.ingresos.total)}</text>
         </g>`
      : '';
  }).join('');
  // Costos line (puntos) — costos totales por mes, valor absoluto
  const costPts = pnl.map((p, i) => ({ x: xAt(i+1), y: yAt(Math.abs(p.costos.total)), v: Math.abs(p.costos.total) }))
                    .filter(p => p.v > 0);
  const costPath = costPts.length > 1 ? `M ${costPts.map(p => p.x.toFixed(1)+' '+p.y.toFixed(1)).join(' L ')}` : '';
  const costDots = costPts.map(p => `<circle class="bp-cost-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3"/>`).join('');
  const costLbls = costPts.map(p => `<text class="bp-cost-lbl" x="${p.x.toFixed(1)}" y="${(p.y+18).toFixed(1)}" text-anchor="middle">${bpFmtNum(p.v)}</text>`).join('');

  el.innerHTML = `<svg class="chart-svg bp-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${yTicks.map(t => `<line class="grid" x1="${PL}" x2="${W-PR}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}"/>`).join('')}
    ${yTicks.map(t => `<text class="label" x="${PL-8}" y="${(t.y+3).toFixed(1)}" text-anchor="end">${bpFmtNum(t.v)}</text>`).join('')}
    ${bars}
    ${costPath ? `<path class="bp-cost-line" d="${costPath}"/>` : ''}
    ${costDots}
    ${costLbls}
    ${BP_MONTHS.map((mn, i) => `<text class="label" x="${xAt(i+1).toFixed(1)}" y="${H-10}" text-anchor="middle">${mn}</text>`).join('')}
    <g class="bp-legend-inline" transform="translate(${PL},6)">
      <rect class="bp-bar" x="0" y="0" width="14" height="10" rx="2"/>
      <text class="label" x="20" y="9">Ingresos</text>
      <line class="bp-cost-line" x1="80" y1="5" x2="100" y2="5"/>
      <circle class="bp-cost-dot" cx="90" cy="5" r="3"/>
      <text class="label" x="106" y="9">Costos</text>
    </g>
  </svg>`;
}

// 2. Stacked bars: ingresos por vertical apilados por mes
function drawBpStacked() {
  const el = document.getElementById('bp-chart-stacked'); if (!el) return;
  const pnl = STATE.businessPanel.data?.pnl || [];
  if (!pnl.length) { el.innerHTML = '<div class="loading muted">sin datos</div>'; return; }
  const W = el.clientWidth || 700, H = 280, PL = 56, PR = 16, PT = 18, PB = 32;
  const max = Math.max(...pnl.map(p => p.ingresos.total), 1);
  const xStep = (W - PL - PR) / 12;
  const xAt = (m) => PL + (m - 0.5) * xStep;
  const yAt = (v) => (H - PB) - (v / max) * (H - PB - PT);
  const barW = xStep * 0.6;
  const yTicks = [0, max/2, max].map(v => ({ v, y: yAt(v) }));

  const bars = pnl.map((p, i) => {
    const m = i + 1;
    const x = xAt(m) - barW/2;
    let stackY = H - PB;
    const segments = [];
    for (const v of BP_VERTICALS) {
      const val = p.ingresos[v.key];
      if (val <= 0) continue;
      const h = (val / max) * (H - PB - PT);
      stackY -= h;
      segments.push(`<g class="bp-stack-seg">
        <rect x="${x.toFixed(1)}" y="${stackY.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${v.color}" opacity=".88"/>
        ${h > 14 ? `<text class="bp-stack-lbl" x="${(x+barW/2).toFixed(1)}" y="${(stackY+h/2+3).toFixed(1)}" text-anchor="middle">${bpFmtNum(val)}</text>` : ''}
      </g>`);
    }
    if (p.ingresos.total > 0) {
      segments.push(`<text class="bp-bar-total" x="${(x+barW/2).toFixed(1)}" y="${(stackY-6).toFixed(1)}" text-anchor="middle">${bpFmtNum(p.ingresos.total)}</text>`);
    }
    return segments.join('');
  }).join('');

  el.innerHTML = `<svg class="chart-svg bp-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${yTicks.map(t => `<line class="grid" x1="${PL}" x2="${W-PR}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}"/>`).join('')}
    ${yTicks.map(t => `<text class="label" x="${PL-8}" y="${(t.y+3).toFixed(1)}" text-anchor="end">${bpFmtNum(t.v)}</text>`).join('')}
    ${bars}
    ${BP_MONTHS.map((mn, i) => `<text class="label" x="${xAt(i+1).toFixed(1)}" y="${H-10}" text-anchor="middle">${mn}</text>`).join('')}
  </svg>`;
  document.getElementById('bp-legend-stacked').innerHTML = BP_VERTICALS.map(v =>
    `<span class="lg-i"><span class="lg-d" style="background:${v.color}"></span>${v.label}</span>`
  ).join('');
}

// 3. Donut: % de ingresos por vertical en el período actual
function drawBpDonut() {
  const el = document.getElementById('bp-chart-donut'); if (!el) return;
  const c = bpCompute(); if (!c) return;
  const data = BP_VERTICALS.map(v => ({ k: v.label, v: c.verticals[v.key].ventas, color: v.color }))
                            .filter(d => d.v > 0);
  const total = data.reduce((a, d) => a + d.v, 0);
  if (!total) { el.innerHTML = '<div class="loading muted">sin datos</div>'; document.getElementById('bp-legend-donut').innerHTML=''; return; }
  const W = el.clientWidth || 280, H = 220, R = 70, cx = W/2, cy = H/2;
  let acc = 0;
  const arcs = data.map(d => {
    const len = (d.v / total) * 2 * Math.PI * R;
    const dash = `${len} ${2 * Math.PI * R}`;
    const offset = -acc;
    acc += len;
    return `<circle class="donut-cy" cx="${cx}" cy="${cy}" r="${R}" stroke="${d.color}" stroke-dasharray="${dash}" stroke-dashoffset="${offset}"></circle>`;
  }).join('');
  el.innerHTML = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}">
    ${arcs}
    <text class="donut-center" x="${cx}" y="${cy-2}" style="font-size:18px">${bpFmt(total).replace('$','$')}</text>
    <text x="${cx}" y="${cy+18}" class="label" text-anchor="middle">total ingresos</text>
  </svg>`;
  document.getElementById('bp-legend-donut').innerHTML = data.map(d => {
    const pct = ((d.v / total) * 100).toFixed(1);
    return `<span class="lg-i"><span class="lg-d" style="background:${d.color}"></span>${escapeHtml(d.k)} · <b>${pct}%</b></span>`;
  }).join('');
}

// ============================================================================
// ---------- VERTICAL DETAIL VIEW (drill-down por vertical) ------------------
// ============================================================================
// Cada vertical tiene su set propio de KPIs e insights, sacados del cerebro
// (Cerebro_Principal_v9.html) y de los datos reales del Sheet 2025 V4.

// Configuración de KPIs e insights por vertical
const BP_VERTICAL_CONFIG = {
  directo: {
    label: 'Carteles Directo',
    icon: '🎨',
    color: 'var(--neon-red)',
    desc: 'Ventas directas de carteles LED neón. Mezcla B2C (Instagram ads, retargeting) + algunos B2B/locales. Joaquín atiende todos los leads.',
    rule: 'Regla 10:1 — cada 10 presupuestos enviados → 1 venta',
    insights: [
      '95% de clientes Directo compran 1 sola vez. Palanca dormida: flujo de post-venta sistemático.',
      'Carteles 1000+ cm = 20% del volumen pero 38% de la facturación. AOV $604k vs $308k promedio.',
      'AOV creció +42% en 4 meses por mix shift de canales, no por suba de precios.',
      'Bs As Interior es el principal mercado fuera de CABA/GBA.',
      'Miércoles es el día rey de la venta.'
    ],
    benchmark: { aov: 357000, marginPct: 60, monthlyVol: 39, regla10a1: 0.10 }
  },
  distris: {
    label: 'Carteles Distris',
    icon: '🏭',
    color: 'var(--neon-cyan)',
    desc: 'Carteles vendidos por Gaspar directo a clientes propios B2B (locales, marcas, gastronomía). Sin intervención de Joaquín. Sin ad spend.',
    rule: 'Margen 65-84% (mejor que Directo) · ROAS efectivo infinito (sin ads)',
    insights: [
      'Sin ad spend asignado: revenue 100% del trabajo directo de Gaspar (red personal, B2B).',
      'CAC efectivo $0. Es el canal con mejor unit economics absoluto, aunque chico en volumen.',
      'Si se escala a 10 pedidos/mes sostenido, el revenue se duplica con casi cero costo.',
      'AOV bajó -49% en 4 meses pero pedidos pasaron de 3 a 6 → canal se diversificó.',
      'Volumen actual bajo: solo 21 pedidos en 4 meses (Q1+Abr).'
    ],
    benchmark: { aov: 386000, marginPct: 72, monthlyVol: 5 }
  },
  insumos: {
    label: 'Insumos CNC',
    icon: '🔌',
    color: '#FFA726',
    desc: 'Bases de acrílico cortadas por router CNC propio (Aníbal, domingos) + cables. Vendidas casi exclusivamente a alumnos del curso. Extensión natural del ecosistema.',
    rule: 'Margen 58% · Ticket promedio $40.799 · Corte domingo → despacho lunes → entrega viernes',
    insights: [
      'TRANS (acrílico transparente) domina: 511 ventas, 73% del volumen.',
      'Pack x6 es el SKU bandera: 49 unidades vendidas = $2.16M.',
      'Base de alumnos recurrentes crece mes a mes (0 → 27 → 43 → 46) mientras la captación de nuevos baja (71 → 23 → 28 → 15).',
      'Cross-sell cursos→insumos solo 2.5%: el 92.8% de los cursos ya incluye kit, casi nadie recompra después.',
      'El embudo del Q1 ya está casi convertido — para escalar insumos hace falta nueva camada de alumnos.'
    ],
    benchmark: { aov: 40799, marginPct: 58, monthlyVol: 174 }
  },
  cursos: {
    label: 'Cursos / Al Infinito',
    icon: '🎓',
    color: '#25D366',
    desc: 'Programa de educación pago. SKUs: Evergreen Medium, Supernova (high ticket), Micro Launch, con upsells de Pack base x6 y Pack PREMIUM. Cara visible: Bruno.',
    rule: 'AOV $227.500 · 92.8% incluye kit físico · Cadencia: Mastery mensual + Supernova trimestral',
    insights: [
      'Vertical de mayor aceleración: crecimiento x9 en 4 meses ($995k → $9.3M).',
      'Lanzamiento mayo 2026: 40 cupos = récord histórico. Tasa de cierre 8% sobre asistentes a clase 2 (antes 5%).',
      'Avatar que paga: 30-50 años (no pendejos). Hooks con pop culture argentina funcionan sin excepción.',
      'MercadoPago domina la facturación (64.7%) — la fricción de cobro es mucho menor que transferencia.',
      'Insight Lautaro: 80-90% de asistentes al lanzamiento no conocían a NI previamente. Interés compuesto.',
      'Próximo lanzamiento Neon Mastery: 9-11 junio 2026.'
    ],
    benchmark: { aov: 227500, marginPct: 50, monthlyVol: 20, conversionRate: 0.08 }
  }
};

// Compute específico para una vertical: filtra los datos y devuelve metrics relevantes
function bpComputeVertical(key) {
  const bp = STATE.businessPanel;
  if (!bp.data) return null;
  const period = bp.period || 'current';
  let range;
  if (period === 'week') range = bpWeekRange();
  else if (period === 'all') range = bpAllRange();
  else if (period === 'current') range = bpMonthRange();
  else if (/^\d{4}-\d{2}$/.test(period)) range = bpMonthRange(period);
  else range = bpMonthRange();

  const arrName = key === 'cursos' ? 'cursos' : key;
  const allArr = bp.data[arrName] || [];
  const rows = allArr.filter(r => bpInRange(r.fecha, range));

  // Métricas básicas
  const count = rows.length;
  const ventas = rows.reduce((a, r) => a + (r.venta || r.vendido || 0), 0);
  const aov = count ? ventas / count : 0;

  // Por mes (para tendencia)
  const byMonth = new Map();
  for (const r of allArr) {
    const m = r.fecha.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, { count: 0, ventas: 0 });
    const x = byMonth.get(m);
    x.count++; x.ventas += (r.venta || r.vendido || 0);
  }

  // Top clientes/items del período
  const byCustomer = new Map();
  for (const r of rows) {
    const name = (r.cliente || r.alumno || r.diseno || '').trim() || 'Sin nombre';
    if (!byCustomer.has(name)) byCustomer.set(name, { count: 0, total: 0 });
    const c = byCustomer.get(name);
    c.count++; c.total += (r.venta || r.vendido || 0);
  }
  const topCustomers = [...byCustomer.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 10)
    .map(([name, x]) => ({ name, ...x }));

  // PnL del mes corriente para esta vertical
  const pnl = bp.data.pnl || [];
  const currentMonth = period === 'current' ? new Date().getMonth() + 1
                     : /^\d{4}-\d{2}$/.test(period) ? parseInt(period.split('-')[1])
                     : null;
  let pnlRow = currentMonth ? pnl.find(p => p.month === currentMonth) : null;
  let pnlIngresos = pnlRow ? pnlRow.ingresos[key] : ventas;
  let pnlCostos = pnlRow ? Math.abs(pnlRow.costos[key]) : 0;
  let pnlMargen = pnlIngresos - pnlCostos;
  let pnlMargenPct = pnlIngresos ? pnlMargen / pnlIngresos : 0;

  // Si es 'all', sumar todos los meses del PnL
  if (period === 'all' && pnl.length) {
    pnlIngresos = pnl.reduce((a, p) => a + (p.ingresos[key] || 0), 0);
    pnlCostos = pnl.reduce((a, p) => a + Math.abs(p.costos[key] || 0), 0);
    pnlMargen = pnlIngresos - pnlCostos;
    pnlMargenPct = pnlIngresos ? pnlMargen / pnlIngresos : 0;
  }

  return { range, count, ventas, aov, rows, byMonth, topCustomers, pnlIngresos, pnlCostos, pnlMargen, pnlMargenPct };
}

function renderVerticalDetail(key) {
  const bp = STATE.businessPanel;
  const cfg = BP_VERTICAL_CONFIG[key];
  if (!cfg) return '<div class="error">Vertical no encontrada</div>';
  const c = bpComputeVertical(key);
  if (!c) return '<div class="loading"><div class="spinner"></div></div>';

  const period = bp.period || 'current';
  const months = bpAvailableMonths();
  const periodLabel = period === 'week' ? 'Esta semana'
                    : period === 'all'  ? 'Todos los meses'
                    : period === 'current' ? new Date().toLocaleDateString('es-AR', {month:'long', year:'numeric'})
                    : (() => { const [y,m] = period.split('-'); return new Date(+y, +m-1, 1).toLocaleDateString('es-AR', {month:'long', year:'numeric'}); })();

  // Para Carteles Directo: integrar tasa de cierre
  let tasaCierreHtml = '';
  if (key === 'directo') {
    let mf;
    if (period === 'all') mf = 'all';
    else if (period === 'current') mf = null;
    else if (/^\d{4}-\d{2}$/.test(period)) mf = new Set([period]);
    else mf = null;
    const tc = getTasaCierreDirecto(mf);
    tasaCierreHtml = `
      <div class="card" style="margin-top:18px">
        <div class="card-h">
          <h3>📊 Funnel · Presupuestos → Ventas</h3>
          <span class="muted" style="margin-left:auto;font-size:12px">${escapeHtml(periodLabel)}${tc.partial ? ' · ⚠ parcial' : ''}</span>
        </div>
        <div style="padding:16px 20px">
          <div class="bp-funnel">
            <div class="bp-funnel-row">
              <div class="bp-funnel-lbl">Presupuestos enviados</div>
              <div class="bp-funnel-bar-wrap"><div class="bp-funnel-bar" style="width:100%;background:rgba(143,212,222,.65)"><span class="bp-funnel-num">${tc.enviados}</span><span class="bp-funnel-pct">100%</span></div></div>
            </div>
            <div class="bp-funnel-row">
              <div class="bp-funnel-lbl">No cerrados</div>
              <div class="bp-funnel-bar-wrap"><div class="bp-funnel-bar" style="width:${tc.enviados ? Math.max(2, ((tc.enviados - tc.vendidos)/tc.enviados)*100) : 0}%;background:rgba(255,24,48,.55)"><span class="bp-funnel-num">${tc.enviados - tc.vendidos}</span><span class="bp-funnel-pct">${tc.enviados ? (((tc.enviados-tc.vendidos)/tc.enviados)*100).toFixed(1) : 0}%</span></div></div>
            </div>
            <div class="bp-funnel-row">
              <div class="bp-funnel-lbl">Vendidos</div>
              <div class="bp-funnel-bar-wrap"><div class="bp-funnel-bar" style="width:${tc.enviados ? Math.max(2, (tc.vendidos/tc.enviados)*100) : 0}%;background:rgba(37,211,102,.75)"><span class="bp-funnel-num">${tc.vendidos}</span><span class="bp-funnel-pct">${tc.enviados ? ((tc.vendidos/tc.enviados)*100).toFixed(1) : 0}%</span></div></div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:14px;margin-top:18px;padding-top:14px;border-top:1px solid var(--border)">
            <div style="font-size:13px;color:var(--fg-subtle)">Tasa de cierre real:</div>
            <div style="font-size:24px;font-weight:700;color:var(--neon-cyan);font-family:ui-monospace,monospace">${(tc.tasa*100).toFixed(1)}%</div>
            <div style="margin-left:auto;font-size:12px;color:var(--fg-subtle)">Regla 10:1 = ${(cfg.benchmark.regla10a1*100).toFixed(0)}% objetivo · ${tc.tasa >= cfg.benchmark.regla10a1 ? '✅ por encima' : '⚠ por debajo'}</div>
          </div>
        </div>
      </div>
    `;
  }

  // Análisis específico por vertical
  const specificAnalysis = renderVerticalSpecific(key, c);

  return `
    <div class="period-selector">
      <span class="ps-label">Período</span>
      <div class="ps-chips">
        <button class="ps-chip ${period==='current'?'active':''}" data-bp-period="current">Mes actual</button>
        <button class="ps-chip ${period==='week'?'active':''}" data-bp-period="week">Esta semana</button>
        <button class="ps-chip ${period==='all'?'active':''}" data-bp-period="all">Todos</button>
        ${months.map(m => {
          const [y, mm] = m.split('-');
          const lbl = new Date(+y, +mm - 1, 1).toLocaleDateString('es-AR', {month:'short'}).replace('.','');
          return `<button class="ps-chip ${period===m?'active':''}" data-bp-period="${m}">${lbl} ${y.slice(2)}</button>`;
        }).join('')}
      </div>
      <span class="ps-meta">${escapeHtml(periodLabel)} · ${c.count} ${key === 'cursos' ? 'cursos' : key === 'insumos' ? 'ventas' : 'pedidos'}</span>
    </div>

    <div class="page-head">
      <div>
        <div class="eyebrow" style="display:flex;align-items:center;gap:8px">
          <button class="btn btn-ghost" id="bp-back" style="padding:4px 10px;font-size:12px">← Panel general</button>
          <span style="background:rgba(255,24,48,.12);color:var(--neon-red);padding:2px 8px;border-radius:4px;font-weight:700;letter-spacing:.5px;font-size:10px">🔒 SOLO GASPAR</span>
        </div>
        <h1>${cfg.icon} ${cfg.label}</h1>
        <div style="font-size:13px;color:var(--fg-subtle);max-width:760px;margin-top:6px">${escapeHtml(cfg.desc)}</div>
      </div>
      <div class="actions">
        <button class="btn btn-ghost" id="bp-refresh">↻ Refrescar</button>
      </div>
    </div>

    <div style="padding:8px 14px;background:rgba(143,212,222,.06);border-left:3px solid var(--neon-cyan);border-radius:4px;font-size:12.5px;margin-bottom:18px">
      📋 <b>Regla del vertical:</b> ${escapeHtml(cfg.rule)}
    </div>

    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">Ventas (${periodLabel})</div><div class="kpi-value">${bpFmt(c.pnlIngresos || c.ventas)}</div><div class="kpi-delta">${c.count} ${key === 'cursos' ? 'cursos' : key === 'insumos' ? 'ventas' : 'pedidos'}</div></div>
      <div class="kpi cyan"><div class="kpi-label">Ticket promedio</div><div class="kpi-value">${bpFmt(c.aov)}</div><div class="kpi-delta">Benchmark: ${bpFmt(cfg.benchmark.aov)}</div></div>
      <div class="kpi"><div class="kpi-label">Costos</div><div class="kpi-value">${bpFmt(c.pnlCostos)}</div><div class="kpi-delta">${c.pnlIngresos ? Math.round((c.pnlCostos/c.pnlIngresos)*100) : 0}% s/ ventas</div></div>
      <div class="kpi cyan"><div class="kpi-label">Margen</div><div class="kpi-value" style="color:${c.pnlMargen >= 0 ? 'var(--success, #25D366)' : 'var(--neon-red)'}">${bpFmt(c.pnlMargen)}</div><div class="kpi-delta">${Math.round(c.pnlMargenPct*100)}% · benchmark ${cfg.benchmark.marginPct}%</div></div>
      <div class="kpi"><div class="kpi-label">Volumen vs benchmark</div><div class="kpi-value">${c.count >= cfg.benchmark.monthlyVol ? '↑' : '↓'} ${cfg.benchmark.monthlyVol}</div><div class="kpi-delta">${c.count} actuales vs ${cfg.benchmark.monthlyVol} esperados</div></div>
    </div>

    ${specificAnalysis}

    ${tasaCierreHtml}

    <div class="card" style="margin-top:18px">
      <div class="card-h"><h3>📈 Evolución mensual</h3></div>
      <div class="chart-canvas" id="bp-vert-chart" style="height:240px"></div>
    </div>

    ${c.topCustomers.length ? `
    <div class="card" style="margin-top:18px">
      <div class="card-h"><h3>🏆 Top ${key === 'cursos' ? 'alumnos' : key === 'insumos' ? 'diseños/clientes' : 'clientes'} del período</h3><span class="muted" style="margin-left:auto;font-size:12px">${escapeHtml(periodLabel)}</span></div>
      <table class="bp-table compact">
        <thead><tr><th>#</th><th>${key === 'cursos' ? 'Alumno' : key === 'insumos' ? 'Diseño' : 'Cliente'}</th><th class="num"># compras</th><th class="num">Total</th><th class="num">Promedio</th></tr></thead>
        <tbody>
          ${c.topCustomers.map((t, i) => `
            <tr>
              <td>${i+1}</td>
              <td>${escapeHtml(t.name)}</td>
              <td class="num">${t.count}</td>
              <td class="num">${bpFmt(t.total)}</td>
              <td class="num">${bpFmt(t.count ? t.total/t.count : 0)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>` : ''}

    <div class="card" style="margin-top:18px">
      <div class="card-h"><h3>💡 Insights estratégicos (Cerebro Neon Infinito)</h3></div>
      <div style="padding:14px 20px">
        <ul style="margin:0;padding-left:20px;line-height:1.7">
          ${cfg.insights.map(i => `<li style="margin-bottom:6px;color:var(--fg-subtle)"><span style="color:var(--fg)">${escapeHtml(i)}</span></li>`).join('')}
        </ul>
      </div>
    </div>
  `;
}

// Render de análisis específico por vertical (depende de cuál es)
function renderVerticalSpecific(key, c) {
  const bp = STATE.businessPanel;
  if (key === 'directo') {
    // Análisis de tamaño de cartel, dimmer, base, color (de las filas)
    const rows = c.rows;
    // Por tamaño (cm) — calculado de cada row si tiene el dato (no lo tenemos en parsing actual, simplificamos por venta size buckets)
    const buckets = { 'Mini (<150k)': 0, 'Chico (150-300k)': 0, 'Medio (300-500k)': 0, 'Grande (500-1M)': 0, 'XL (1M+)': 0 };
    const bucketRev = { 'Mini (<150k)': 0, 'Chico (150-300k)': 0, 'Medio (300-500k)': 0, 'Grande (500-1M)': 0, 'XL (1M+)': 0 };
    for (const r of rows) {
      const v = r.venta;
      let b;
      if (v < 150000) b = 'Mini (<150k)';
      else if (v < 300000) b = 'Chico (150-300k)';
      else if (v < 500000) b = 'Medio (300-500k)';
      else if (v < 1000000) b = 'Grande (500-1M)';
      else b = 'XL (1M+)';
      buckets[b]++;
      bucketRev[b] += v;
    }
    const totalRev = Object.values(bucketRev).reduce((a, b) => a + b, 0);
    return `
      <div class="card" style="margin-top:18px">
        <div class="card-h"><h3>📐 Distribución por ticket (carteles)</h3></div>
        <table class="bp-table compact">
          <thead><tr><th>Bucket</th><th class="num"># pedidos</th><th class="num">Facturación</th><th class="num">% revenue</th><th>Share</th></tr></thead>
          <tbody>
            ${Object.entries(buckets).map(([b, n]) => {
              const rev = bucketRev[b];
              const pct = totalRev ? (rev / totalRev) * 100 : 0;
              return `<tr>
                <td>${b}</td>
                <td class="num">${n}</td>
                <td class="num">${bpFmt(rev)}</td>
                <td class="num">${pct.toFixed(1)}%</td>
                <td><div class="bp-bar-bg"><div class="bp-bar-fg" style="width:${pct.toFixed(1)}%;background:var(--neon-red)"></div></div></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        <div style="padding:10px 20px 16px;font-size:12px;color:var(--fg-subtle)">
          💡 Histórico Q1+Abr 2026: <b>Carteles 1M+</b> son 20% del volumen pero <b>38% de la facturación</b>. Esos son los que ads B2C (Locales corto, El neón es una mierda) traen mayoritariamente.
        </div>
      </div>
    `;
  }
  if (key === 'distris') {
    return `
      <div class="card" style="margin-top:18px">
        <div class="card-h"><h3>🎯 Unit economics</h3></div>
        <div class="bp-stat-grid" style="padding:20px;display:grid;grid-template-columns:repeat(3,1fr);gap:18px">
          <div><div style="font-size:11px;text-transform:uppercase;color:var(--fg-subtle);letter-spacing:.5px">CAC</div><div style="font-size:24px;font-weight:700;color:var(--success, #25D366);font-family:ui-monospace,monospace">$0</div><div style="font-size:11px;color:var(--fg-subtle)">Sin ad spend asignado</div></div>
          <div><div style="font-size:11px;text-transform:uppercase;color:var(--fg-subtle);letter-spacing:.5px">ROAS efectivo</div><div style="font-size:24px;font-weight:700;color:var(--neon-cyan);font-family:ui-monospace,monospace">∞</div><div style="font-size:11px;color:var(--fg-subtle)">Sin costo de adquisición</div></div>
          <div><div style="font-size:11px;text-transform:uppercase;color:var(--fg-subtle);letter-spacing:.5px">Mejor margen del negocio</div><div style="font-size:24px;font-weight:700;font-family:ui-monospace,monospace">65-84%</div><div style="font-size:11px;color:var(--fg-subtle)">vs 60% en Directo</div></div>
        </div>
      </div>
    `;
  }
  if (key === 'insumos') {
    // Productos vendidos
    const byProd = new Map();
    for (const r of c.rows) {
      const p = (r.producto || 'Sin producto').trim();
      if (!byProd.has(p)) byProd.set(p, { count: 0, ventas: 0 });
      const x = byProd.get(p);
      x.count++; x.ventas += r.venta;
    }
    const sorted = [...byProd.entries()].sort((a, b) => b[1].ventas - a[1].ventas).slice(0, 6);
    return `
      <div class="card" style="margin-top:18px">
        <div class="card-h"><h3>📦 Productos vendidos</h3></div>
        <table class="bp-table compact">
          <thead><tr><th>Producto</th><th class="num"># ventas</th><th class="num">Facturación</th><th class="num">Ticket ø</th></tr></thead>
          <tbody>
            ${sorted.map(([p, x]) => `<tr>
              <td><b>${escapeHtml(p)}</b></td>
              <td class="num">${x.count}</td>
              <td class="num">${bpFmt(x.ventas)}</td>
              <td class="num">${bpFmt(x.count ? x.ventas/x.count : 0)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        <div style="padding:10px 20px 16px;font-size:12px;color:var(--fg-subtle)">
          💡 TRANS (acrílico transparente) y NEGRO son los pilares. Pack x6 es el SKU bandera. Los cables son ventas residuales pero recurrentes.
        </div>
      </div>
    `;
  }
  if (key === 'cursos') {
    // SKUs vendidos
    const bySku = new Map();
    for (const r of c.rows) {
      const p = (r.producto || 'Sin producto').trim();
      if (!bySku.has(p)) bySku.set(p, { count: 0, ventas: 0 });
      const x = bySku.get(p);
      x.count++; x.ventas += r.vendido;
    }
    const sorted = [...bySku.entries()].sort((a, b) => b[1].ventas - a[1].ventas);
    return `
      <div class="card" style="margin-top:18px">
        <div class="card-h"><h3>🎓 SKUs vendidos</h3></div>
        <table class="bp-table compact">
          <thead><tr><th>Producto</th><th class="num"># ventas</th><th class="num">Facturación</th><th class="num">AOV</th></tr></thead>
          <tbody>
            ${sorted.length ? sorted.map(([p, x]) => `<tr>
              <td><b>${escapeHtml(p)}</b></td>
              <td class="num">${x.count}</td>
              <td class="num">${bpFmt(x.ventas)}</td>
              <td class="num">${bpFmt(x.count ? x.ventas/x.count : 0)}</td>
            </tr>`).join('') : '<tr><td colspan="4" class="muted" style="text-align:center;padding:14px">Sin cursos en el período</td></tr>'}
          </tbody>
        </table>
        <div style="padding:10px 20px 16px;font-size:12px;color:var(--fg-subtle)">
          💡 <b>Evergreen Medium</b> es la base del funnel ($172k AOV). <b>Supernova</b> es high-ticket ($506k AOV). El upsell de Pack PREMIUM lleva el AOV de $172k a $278k. Próximo lanzamiento Mastery: <b>9-11 junio 2026</b>.
        </div>
      </div>
    `;
  }
  return '';
}

// Chart de evolución mensual de la vertical seleccionada
function drawVerticalCharts(key) {
  const el = document.getElementById('bp-vert-chart');
  if (!el) return;
  const c = bpComputeVertical(key);
  if (!c) { el.innerHTML = '<div class="loading muted">sin datos</div>'; return; }
  const cfg = BP_VERTICAL_CONFIG[key];
  const months = [...c.byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (!months.length) { el.innerHTML = '<div class="loading muted">sin datos</div>'; return; }
  const W = el.clientWidth || 700, H = 240, PL = 56, PR = 16, PT = 24, PB = 32;
  const max = Math.max(...months.map(([, x]) => x.ventas), 1);
  const xStep = (W - PL - PR) / Math.max(months.length, 1);
  const xAt = (i) => PL + (i + 0.5) * xStep;
  const yAt = (v) => (H - PB) - (v / max) * (H - PB - PT);
  const barW = Math.min(xStep * 0.65, 60);
  const yTicks = [0, max/2, max].map(v => ({ v, y: yAt(v) }));
  const bars = months.map(([m, x], i) => {
    const cx = xAt(i);
    const y = yAt(x.ventas);
    const h = (H - PB) - y;
    return `<g>
      <rect x="${(cx-barW/2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0,h).toFixed(1)}" rx="3" fill="${cfg.color}" opacity=".75"/>
      <text class="bp-bar-lbl" x="${cx.toFixed(1)}" y="${(y-6).toFixed(1)}" text-anchor="middle" fill="${cfg.color}">${bpFmtNum(x.ventas)}</text>
      <text class="bp-bar-lbl" x="${cx.toFixed(1)}" y="${(H-PB+18).toFixed(1)}" text-anchor="middle" style="opacity:.5;font-weight:400">${x.count}</text>
    </g>`;
  }).join('');
  const labels = months.map(([m], i) => {
    const [y, mm] = m.split('-');
    const lbl = new Date(+y, +mm - 1, 1).toLocaleDateString('es-AR', {month:'short'}).replace('.','');
    return `<text class="label" x="${xAt(i).toFixed(1)}" y="${H-2}" text-anchor="middle">${lbl} ${y.slice(2)}</text>`;
  }).join('');
  el.innerHTML = `<svg class="chart-svg bp-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${yTicks.map(t => `<line class="grid" x1="${PL}" x2="${W-PR}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}"/>`).join('')}
    ${yTicks.map(t => `<text class="label" x="${PL-8}" y="${(t.y+3).toFixed(1)}" text-anchor="end">${bpFmtNum(t.v)}</text>`).join('')}
    ${bars}
    ${labels}
  </svg>`;
}

// ---------- PEDIDOS ----------
let pedidoFilter = { search: '', estadoPago: '', estadoPedido: '', canal: '', mes: '' };
let pedidoSort = { col: 'fecha', dir: -1 };
function bindPedidos() {
  startPedidosPolling();
  let _pedidoSearchTimer = null;
  document.querySelectorAll('[data-pf]').forEach(el => {
    if (el.dataset.pf === 'search') {
      // Búsqueda de texto: debounce 180ms. renderTablePedidos() filtra y repinta
      // las 200+ filas; hacerlo en cada tecla traba el tipeo. El input vive en el
      // toolbar (fuera de #table-pedidos), así que no pierde el foco al repintar.
      el.addEventListener('input', () => {
        pedidoFilter.search = el.value;
        clearTimeout(_pedidoSearchTimer);
        _pedidoSearchTimer = setTimeout(renderTablePedidos, 180);
      });
    } else {
      el.addEventListener('input', () => { pedidoFilter[el.dataset.pf] = el.value; renderTablePedidos(); });
      el.addEventListener('change', () => { pedidoFilter[el.dataset.pf] = el.value; renderTablePedidos(); });
    }
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
  const nuevoBtn = document.getElementById('pedido-nuevo');
  if (nuevoBtn) nuevoBtn.onclick = openCargarPedidoModal;
  bindPedidoModal();
}
function renderPedidos() {
  const estadosPago = uniq(STATE.pedidos.map(p=>p.estadoPago).filter(Boolean));
  const estadosPed = uniq(STATE.pedidos.map(p=>p.estadoPedido).filter(Boolean));
  const canales = uniq(STATE.pedidos.map(p=>p.canalAd).filter(Boolean));
  const meses = uniq(STATE.pedidos.map(p=>getMonth(p.fecha))).sort().reverse();
  return `
    <div class="page-head">
      <div><div class="eyebrow" id="pedidos-total-count">${STATE.pedidos.length} totales</div><h1>Pedidos</h1></div>
      <div class="actions">${canCotizar() ? '<button class="btn btn-cyan" id="pedido-nuevo">＋ Cargar pedido</button>' : ''}<button class="btn btn-ghost" onclick="loadAll()">↻ Refrescar</button></div>
    </div>
    ${(() => {
      const fallos = STATE.pedidos.filter(p => p.mirrorError);
      if (!fallos.length) return '';
      return `<div style="margin:0 0 12px;padding:10px 14px;background:rgba(255,90,90,.12);border:1px solid var(--neon-red,#ff5a5a);border-radius:8px;color:var(--fg);font-size:13px">⚠ <strong>${fallos.length} pedido${fallos.length>1?'s':''}</strong> no se sincronizó al Excel (un valor fue rechazado por la validación de la planilla). Revisá: ${fallos.slice(0,6).map(p=>'#'+p.numero+' '+escapeHtml(p.cartel)).join(', ')}${fallos.length>6?'…':''}</div>`;
    })()}
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
    ${renderPedidoModal()}
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
    let cmp;
    if (va instanceof Date) cmp = (va - vb) * pedidoSort.dir;
    else if (typeof va === 'number') cmp = (va - vb) * pedidoSort.dir;
    else cmp = String(va).localeCompare(String(vb)) * pedidoSort.dir;
    return cmp || (b.idx - a.idx); // tiebreaker: orden del sheet (más nuevos primero)
  });
  document.getElementById('row-count').textContent = filtered.length;
  // Columnas pedidas: C cartel, H base, J precio, K dimer, M envio, N aclaracion,
  // Q estado_pago, T estado_pedido, U ad. Fecha queda como primera (ordena).
  const headers = [
    ['fecha','Fecha'],['cartel','Cartel'],['base','Base'],['precio','Precio'],['dimmer','Dimer'],['envio','Envío'],['aclaracion','Aclar.'],['estadoPago','Pago'],['estadoPedido','Estado'],['canalAd','Ad']
  ];
  const trunc = (s, n) => { s = String(s||'').replace(/\s+/g,' ').trim(); return s ? (escapeHtml(s.slice(0,n)) + (s.length>n?'…':'')) : '—'; };
  wrap.innerHTML = `
    <table class="t">
      <thead><tr>${headers.map(([c,l]) => `<th data-sort="${c}" class="${pedidoSort.col===c?'sorted':''}">${l} <span class="sort">${pedidoSort.col===c?(pedidoSort.dir>0?'▲':'▼'):''}</span></th>`).join('')}</tr></thead>
      <tbody>
        ${filtered.length === 0 ? '<tr class="empty-row"><td colspan="10">No hay pedidos con esos filtros</td></tr>' :
          filtered.map(p => `
            <tr data-pid="${p.idx}">
              <td class="num">${fmtDate(p.fecha)}</td>
              <td class="cliente">${escapeHtml(p.cartel)}</td>
              <td>${baseSwatch(p.base)}</td>
              <td class="num">${fmtMoney(p.precio)}</td>
              <td>${dimerPillHtml(p.dimmer)}</td>
              <td title="${escapeHtml(p.envio||'')}"><span class="muted" style="font-size:12px">${trunc(p.envio,16)}</span></td>
              <td title="${escapeHtml(p.aclaracion||'')}"><span class="muted" style="font-size:12px">${trunc(p.aclaracion,16)}</span></td>
              <td onclick="event.stopPropagation()">${inlinePedidoSelect(p.idx,'estado_pago',p.estadoPago,PAGO_OPTS_TABLE)}</td>
              <td onclick="event.stopPropagation()">${inlinePedidoSelect(p.idx,'estado_pedido',p.estadoPedido,PED_OPTS_TABLE)}</td>
              <td><span class="muted" style="font-size:12px">${escapeHtml(p.canalAd||'—')}</span></td>
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
// Paleta de pills (mismo look que el timeline post-venta). Mapea cada valor a un color.
const PILL_HEX = {
  red:    { bg:'rgba(255,24,48,.12)',   fg:'#ff5a6e',          bd:'rgba(255,24,48,.35)' },
  green:  { bg:'rgba(74,222,128,.12)',  fg:'#6ef0a0',          bd:'rgba(74,222,128,.3)' },
  amber:  { bg:'rgba(255,184,77,.12)',  fg:'#ffc97a',          bd:'rgba(255,184,77,.3)' },
  cyan:   { bg:'rgba(143,212,222,.12)', fg:'var(--neon-cyan)', bd:'rgba(143,212,222,.3)' },
  blue:   { bg:'rgba(80,140,255,.14)',  fg:'#8ab4ff',          bd:'rgba(80,140,255,.32)' },
  violet: { bg:'rgba(155,92,255,.14)',  fg:'#c4a0ff',          bd:'rgba(155,92,255,.32)' },
  muted:  { bg:'var(--ink-200)',        fg:'var(--fg-subtle)', bd:'var(--border)' }
};
// 1er pago → rojo · 2do pago → verde.
function pagoColor(s){ const x=(s||'').toLowerCase(); if (x.includes('1er')||x.includes('primer')||/\b1\b/.test(x)) return 'red'; if (x.includes('2do')||x.includes('pagad')||x.includes('cobrad')||x.includes('total')) return 'green'; return 'muted'; }
// En produccion → rojo · para enviar → amarillo · entregado → verde.
function pedidoEstadoColor(s){ const x=(s||'').toLowerCase(); if (x.includes('produc')) return 'red'; if (x.includes('envia')||x.includes('enviar')) return 'amber'; if (x.includes('entreg')||x.includes('list')) return 'green'; return 'muted'; }
// Dimmer: NO gris · SLIM cyan · CONTROL azul · APP violeta.
function dimerColor(s){ const x=(s||'').toLowerCase(); if (x.includes('slim')) return 'cyan'; if (x.includes('control')) return 'blue'; if (x.includes('app')) return 'violet'; return 'muted'; }
// Color del acrílico para el puntito de la base.
function baseHex(s){ const x=(s||'').toLowerCase(); if (x==='negro') return '#0c0c0c'; if (x==='trans') return '#ffffff'; if (x.includes('espejo')) return 'linear-gradient(135deg,#e2e8f0,#9aa6b4)'; if (x.includes('vinilo')) return '#dfe8ff'; return 'var(--ink-300)'; }
function pillEstadoPago(s){ return `<span class="pill ${pagoColor(s)}">${escapeHtml(s||'—')}</span>`; }
function pillEstadoPedido(s){ return `<span class="pill ${pedidoEstadoColor(s)}">${escapeHtml(s||'—')}</span>`; }
function dimerPillHtml(s){ if (!s) return '<span style="color:var(--fg-subtle)">—</span>'; return `<span class="pill ${dimerColor(s)}">${escapeHtml(s)}</span>`; }
// Base con un puntito del color del acrílico (NEGRO negro, TRANS blanco, etc.).
function baseSwatch(s){ if (!s) return '<span style="color:var(--fg-subtle)">—</span>'; return `<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:11px;height:11px;border-radius:50%;background:${baseHex(s)};border:1px solid var(--border);flex:none"></span><span style="font-size:12px">${escapeHtml(s)}</span></span>`; }
// Dropdown inline (tabla) coloreado según el valor actual, para editar el estado sin
// abrir el drawer (a nivel pedido: el worker lo aplica a todos los carteles del nro+fecha).
const PAGO_OPTS_TABLE = ['1er pago','2do pago'];
const PED_OPTS_TABLE = ['En produccion','para enviar','Entregado'];
function inlinePedidoSelect(idx, field, current, opts) {
  const col = PILL_HEX[(field === 'estado_pago' ? pagoColor(current) : pedidoEstadoColor(current))] || PILL_HEX.muted;
  const options = uniq([current, ...opts].filter(Boolean)).map(o => `<option style="background:var(--ink-100);color:var(--fg)" ${current===o?'selected':''}>${escapeHtml(o)}</option>`).join('');
  return `<select onchange="savePedidoField(${idx},'${field}',this.value)" style="background:${col.bg};color:${col.fg};border:1px solid ${col.bd};border-radius:var(--r-pill);padding:3px 8px;font-size:11px;font-weight:600;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:.04em;cursor:pointer;max-width:150px">${options}</select>`;
}

// ===================== Modal "Cargar pedido" (fase 2) =====================
// Carga un pedido (1+ carteles) directo a D1 via POST /admin/pedidos. Mismo
// estilo/UX que "Crear brief". Numero sugerido+editable, fecha/estado automaticos,
// precio de dimmer auto por tipo (editable), restante calculado, y trazabilidad
// del ad por telefono (WPP).
const DIMMER_PRECIOS = { NO: '', SLIM: 18700, CONTROL: 25000, APP: 38000 };
function nuevoCartelPedido() {
  return { cartel:'', colores:'', tipo:'INT', alto:'', ancho:'', cmNeon:'', tramos:'', base:'TRANS', cantidad:1, precio:'', dimer:'NO', precioDimmer:'', envio:'', aclaracion:'' };
}
function suggestProximoNumero() {
  const ps = (STATE.pedidos || []).filter(p => p.numero);
  if (!ps.length) return '';
  const sorted = ps.slice().sort((a,b) => (b.fecha - a.fecha) || (b.idx - a.idx));
  const n = parseInt(sorted[0].numero, 10);
  return isNaN(n) ? '' : n + 1;
}
function pedidoModalTotal() {
  return ((STATE.pedidoModal && STATE.pedidoModal.carteles) || []).reduce((s,c) => s + (Number(c.precio)||0) + (Number(c.precioDimmer)||0), 0);
}
function openCargarPedidoModal() {
  if (!canCotizar()) return;
  STATE.pedidoModal = { numero: suggestProximoNumero(), plataforma:'WPP', telefono:'', estadoPago:'1er pago', pagado:'', ad:'', carteles:[nuevoCartelPedido()] };
  STATE.pedidoModalOpen = true;
  STATE.pedidoModalSaving = false;
  render();
  setTimeout(() => { const el = document.getElementById('pm-cartel-0'); if (el) el.focus(); }, 60);
}
function cancelCargarPedido() { STATE.pedidoModalOpen = false; render(); }
// Vuelca el DOM a STATE para que los valores sobrevivan a un re-render (agregar/quitar cartel, cambiar plataforma).
function readPedidoModalDOM() {
  const m = STATE.pedidoModal; if (!m) return;
  const v = id => { const el = document.getElementById(id); return el ? el.value : undefined; };
  ['numero','telefono','pagado','ad'].forEach(f => { const x = v('pm-'+f); if (x !== undefined) m[f] = x; });
  const ep = v('pm-estadopago'); if (ep !== undefined) m.estadoPago = ep;
  (m.carteles||[]).forEach((c,i) => {
    ['cartel','alto','ancho','cmNeon','tramos','cantidad','precio','precioDimmer','envio','aclaracion','base','dimer','tipo'].forEach(f => {
      const x = v(`pm-${f}-${i}`); if (x !== undefined) c[f] = x;
    });
  });
}
function pmAddCartel() { readPedidoModalDOM(); STATE.pedidoModal.carteles.push(nuevoCartelPedido()); render(); }
function pmRemoveCartel(i) { readPedidoModalDOM(); STATE.pedidoModal.carteles.splice(i,1); if (!STATE.pedidoModal.carteles.length) STATE.pedidoModal.carteles.push(nuevoCartelPedido()); render(); }
// Recalcula total + restante inline (sin re-render → no pierde foco).
function pmRecalc() {
  readPedidoModalDOM();
  const total = pedidoModalTotal();
  const pagado = Number(STATE.pedidoModal.pagado) || 0;
  const tEl = document.getElementById('pm-total'); if (tEl) tEl.textContent = fmtMoney(total);
  const rEl = document.getElementById('pm-restante'); if (rEl) rEl.textContent = fmtMoney(Math.max(0, total - pagado));
}
// Trae el ad por telefono (WPP) y lo pone en "de que ad viene" (override manual ok).
async function pmTraceAd() {
  const m = STATE.pedidoModal; if (!m || m.plataforma !== 'WPP') return;
  const tel = (document.getElementById('pm-telefono')?.value || '').replace(/\D/g,'');
  if (tel.length < 8) return;
  const adEl = document.getElementById('pm-ad');
  if (!adEl || adEl.value.trim()) return; // no pisar si ya hay algo cargado a mano
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/ad-attribution?phone=' + encodeURIComponent(tel), { headers: authHeaders() });
    if (!r.ok) return;
    const j = await r.json();
    const a = j.attribution;
    if (!a) return;
    const plat = ((a.source_url||'').includes('instagram') || (a.media_type||'').toLowerCase().includes('instagram')) ? 'IG ad' : 'FB ad';
    const det = a.headline || (a.body ? a.body.slice(0,60) : '') || a.source_id || '';
    const txt = det ? `${plat}: ${det}` : plat;
    adEl.value = txt; m.ad = txt;
    adEl.style.borderColor = '#25D366';
    setTimeout(() => { adEl.style.borderColor = 'var(--border)'; }, 1600);
  } catch (e) {}
}
// Paleta del muestrario (dropdown multi-color → chips).
const PEDIDO_COLORES = ['Amarillo','Azul','Blanco cálido','Blanco frío','Celeste','Naranja','Rojo','Rosa','Verde','Violeta'];
const PEDIDO_COLOR_HEX = { 'Amarillo':'#f5d020','Azul':'#2a5cff','Blanco cálido':'#ffe3a8','Blanco frío':'#eaf2ff','Celeste':'#5ad1e6','Naranja':'#ff8a1e','Rojo':'#ff2d2d','Rosa':'#ff4fa3','Verde':'#39e639','Violeta':'#9b5cff' };
function pmColorList(c) { return String(c.colores||'').split(/,\s*/).map(s=>s.trim()).filter(Boolean); }
function pmAddColor(i, color) {
  if (!color) return;
  readPedidoModalDOM();
  const c = STATE.pedidoModal.carteles[i];
  const list = pmColorList(c);
  if (!list.includes(color)) list.push(color);
  c.colores = list.join(', ');
  render();
}
function pmRemoveColor(i, color) {
  readPedidoModalDOM();
  const c = STATE.pedidoModal.carteles[i];
  c.colores = pmColorList(c).filter(x => x !== color).join(', ');
  render();
}
// Autocomplete del diseño contra las cotizaciones (STATE.presupuestos). Si el
// pedido siguió el flujo de cotización aparece acá y prellena medidas/tipo/tel.
function pmCartelAutocomplete(i) {
  const input = document.getElementById('pm-cartel-' + i);
  const box = document.getElementById('pm-ac-' + i);
  if (!input || !box) return;
  const q = normName(input.value);
  if (q.length < 2) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const matches = (STATE.presupuestos || []).filter(p => p.nombre && normName(p.nombre).includes(q)).slice(0, 8);
  if (!matches.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  STATE._pmAcMatches = matches;
  box.innerHTML = matches.map((p, k) => `<div data-pm-ac-pick="${i}|${k}" style="padding:7px 10px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--border)"><b>${escapeHtml(p.nombre)}</b><span style="color:var(--fg-mute)"> · ${escapeHtml(p.tipo||'')}${p.ancho?(' · '+p.ancho+'×'+(p.tamCm||'?')+'cm'):''}${p.neonMt?(' · '+p.neonMt+'m neón'):''}</span></div>`).join('');
  box.style.display = 'block';
  box.querySelectorAll('[data-pm-ac-pick]').forEach(el => el.onmousedown = (ev) => {
    ev.preventDefault(); // antes del blur del input
    const parts = el.dataset.pmAcPick.split('|');
    pmPickCotizacion(parseInt(parts[0],10), parseInt(parts[1],10));
  });
}
function pmPickCotizacion(i, k) {
  const p = (STATE._pmAcMatches || [])[k];
  if (!p) return;
  readPedidoModalDOM();
  const c = STATE.pedidoModal.carteles[i];
  c.cartel = p.nombre;
  if (p.tamCm) c.alto = p.tamCm;        // "Tamaño (cm)" del cotizador ≈ alto
  if (p.ancho) c.ancho = p.ancho;
  if (p.neonMt) c.cmNeon = Math.round(p.neonMt * 100); // cotizador en metros → cm
  if (p.tipo === 'INT' || p.tipo === 'EXT') c.tipo = p.tipo;
  const m = STATE.pedidoModal;
  if (p.telefono) m.telefono = String(p.telefono).replace(/\D/g, '');
  if (p.canal === 'WPP' || p.canal === 'IG') m.plataforma = p.canal;
  render();
  pmTraceAd(); // trazar el ad con el teléfono recién prellenado (WPP)
  toast('Prellenado desde la cotización "' + p.nombre + '" — revisá medidas y poné el precio');
}
function renderPedidoCartelBlock(c, i, n) {
  const inp = 'width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:7px 9px;color:var(--fg);font-size:13px';
  const lbl = 'display:block;font-size:10px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px';
  const baseOpts = ['TRANS','NEGRO','ESPEJO','TRANS Y VINILO'].map(o=>`<option ${c.base===o?'selected':''}>${o}</option>`).join('');
  const dimerOpts = ['NO','SLIM','CONTROL','APP'].map(o=>`<option ${c.dimer===o?'selected':''}>${o}</option>`).join('');
  const tipoOpts = [['INT','Interior'],['EXT','Exterior']].map(([v,l])=>`<option value="${v}" ${c.tipo===v?'selected':''}>${l}</option>`).join('');
  const cols = pmColorList(c);
  const chips = cols.map(col => `<span style="display:inline-flex;align-items:center;gap:5px;background:rgba(143,212,222,.10);border:1px solid var(--border);border-radius:11px;padding:2px 5px 2px 8px;font-size:11px;margin:0 4px 4px 0"><span style="width:9px;height:9px;border-radius:50%;background:${PEDIDO_COLOR_HEX[col]||'#888'};display:inline-block;border:1px solid rgba(255,255,255,.3)"></span>${escapeHtml(col)}<button data-pm-color-rm="${i}|${escapeHtml(col)}" title="Quitar" style="background:none;border:0;color:var(--fg-subtle);cursor:pointer;font-size:12px;line-height:1;padding:0 1px">✕</button></span>`).join('');
  const availCols = PEDIDO_COLORES.filter(col => !cols.includes(col));
  const colorMenu = availCols.length
    ? availCols.map(col => `<div data-pm-coloradd="${i}|${escapeHtml(col)}" style="display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;font-size:13px"><span style="width:12px;height:12px;border-radius:50%;background:${PEDIDO_COLOR_HEX[col]||'#888'};border:1px solid rgba(255,255,255,.3);flex-shrink:0"></span>${escapeHtml(col)}</div>`).join('')
    : '<div style="padding:8px 10px;font-size:12px;color:var(--fg-mute)">ya están todos</div>';
  return `
    <div style="border:1px solid var(--border);border-radius:var(--r-sm);padding:var(--s-2);margin-bottom:var(--s-2);background:var(--ink-050)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-size:11px;color:var(--accent-cyan);font-weight:700">Cartel ${i+1}</span>
        ${n>1 ? `<button class="btn btn-ghost" data-pm-remove="${i}" style="padding:1px 8px;font-size:11px;color:#FF5566">✕ quitar</button>` : ''}
      </div>
      <div style="margin-bottom:6px;position:relative">
        <label style="${lbl}">Cartel / diseño * <span style="opacity:.5;text-transform:none;letter-spacing:0">— si fue cotizado, elegilo y se prellena</span></label>
        <input id="pm-cartel-${i}" data-pm-ac="${i}" autocomplete="off" value="${escapeHtml(c.cartel||'')}" placeholder="ej. Magnolia café-bar" style="${inp}">
        <div id="pm-ac-${i}" style="display:none;position:absolute;left:0;right:0;top:100%;z-index:6;background:var(--bg,#0A0A0F);border:1px solid var(--accent-cyan,#8FD4DE);border-radius:var(--r-sm);max-height:190px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.5)"></div>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:6px">
        <div style="flex:2;position:relative">
          <label style="${lbl}">Colores *</label>
          <div style="margin-bottom:3px">${chips || '<span style="font-size:11px;color:var(--fg-mute)">elegí del muestrario →</span>'}</div>
          <button type="button" data-pm-color-trigger="${i}" style="${inp};cursor:pointer;text-align:left;display:flex;align-items:center;justify-content:space-between">＋ agregar color… <span style="opacity:.5">▾</span></button>
          <div id="pm-colorpanel-${i}" style="display:none;position:absolute;left:0;right:0;z-index:7;background:var(--bg,#0A0A0F);border:1px solid var(--accent-cyan,#8FD4DE);border-radius:var(--r-sm);max-height:220px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.5);margin-top:2px">${colorMenu}</div>
        </div>
        <div style="flex:1.1">
          <label style="${lbl}">Tipo *</label>
          <div style="display:flex;border:1px solid var(--border);border-radius:var(--r-sm);overflow:hidden">
            <button type="button" data-pm-tipo="${i}|INT" style="flex:1;padding:7px 4px;border:0;cursor:pointer;font-size:12px;${c.tipo==='INT'?'background:var(--accent-cyan,#8FD4DE);color:#000;font-weight:700':'background:transparent;color:var(--fg-subtle)'}">Interior</button>
            <button type="button" data-pm-tipo="${i}|EXT" style="flex:1;padding:7px 4px;border:0;cursor:pointer;font-size:12px;${c.tipo==='EXT'?'background:var(--accent-cyan,#8FD4DE);color:#000;font-weight:700':'background:transparent;color:var(--fg-subtle)'}">Exterior</button>
          </div>
        </div>
        <div style="flex:0.8"><label style="${lbl}">Cant. *</label><input id="pm-cantidad-${i}" type="number" value="${escapeHtml(String(c.cantidad??1))}" style="${inp}"></div>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:6px">
        <div style="flex:1"><label style="${lbl}">Alto cm *</label><input id="pm-alto-${i}" type="number" value="${escapeHtml(String(c.alto||''))}" style="${inp}"></div>
        <div style="flex:1"><label style="${lbl}">Ancho cm *</label><input id="pm-ancho-${i}" type="number" value="${escapeHtml(String(c.ancho||''))}" style="${inp}"></div>
        <div style="flex:1"><label style="${lbl}">CM neón *</label><input id="pm-cmNeon-${i}" type="number" value="${escapeHtml(String(c.cmNeon||''))}" style="${inp}"></div>
        <div style="flex:1"><label style="${lbl}">Tramos</label><input id="pm-tramos-${i}" type="number" value="${escapeHtml(String(c.tramos||''))}" style="${inp}"></div>
        <div style="flex:1"><label style="${lbl}">Base *</label><select id="pm-base-${i}" style="${inp}">${baseOpts}</select></div>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:6px">
        <div style="flex:1.3"><label style="${lbl}">Precio cartel *</label><input id="pm-precio-${i}" type="number" value="${escapeHtml(String(c.precio||''))}" placeholder="$" style="${inp}" data-pm-calc></div>
        <div style="flex:1"><label style="${lbl}">Dimmer *</label><select id="pm-dimer-${i}" data-pm-dimer="${i}" style="${inp}">${dimerOpts}</select></div>
        <div style="flex:1"><label style="${lbl}">Precio dimmer</label><input id="pm-precioDimmer-${i}" type="number" value="${escapeHtml(String(c.precioDimmer||''))}" placeholder="auto" style="${inp}" data-pm-calc></div>
      </div>
      <div style="display:flex;gap:6px">
        <div style="flex:1"><label style="${lbl}">Envío *</label><input id="pm-envio-${i}" value="${escapeHtml(c.envio||'')}" placeholder="ej. CABA / exterior" style="${inp}"></div>
        <div style="flex:1.6"><label style="${lbl}">Aclaración</label><input id="pm-aclaracion-${i}" value="${escapeHtml(c.aclaracion||'')}" style="${inp}"></div>
      </div>
    </div>`;
}
function renderPedidoModal() {
  if (!STATE.pedidoModalOpen || !STATE.pedidoModal) return '';
  const m = STATE.pedidoModal;
  const total = pedidoModalTotal();
  const restante = Math.max(0, total - (Number(m.pagado)||0));
  const inp = 'width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px 10px;color:var(--fg);font-size:13px';
  const lbl = 'display:block;font-size:10px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px';
  const oBtn = (active) => active ? 'background:var(--accent-cyan,#8FD4DE);color:#000;border-color:var(--accent-cyan,#8FD4DE);' : 'background:transparent;color:var(--fg-subtle);border-color:var(--border);';
  return `
    <div id="pm-backdrop" role="dialog" aria-modal="true" style="position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:280;display:flex;align-items:flex-start;justify-content:center;padding:18px;overflow-y:auto;backdrop-filter:blur(4px)">
      <div style="background:var(--bg,#0A0A0F);border:1px solid var(--accent-cyan,#8FD4DE);border-radius:14px;box-shadow:0 12px 48px rgba(0,0,0,.6);max-width:660px;width:100%;margin:auto;padding:var(--s-4)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--s-3);padding-bottom:var(--s-2);border-bottom:1px solid var(--border)">
          <h2 style="margin:0;font-size:16px">📦 Cargar pedido</h2>
          <button id="pm-close" class="btn btn-ghost btn-icon" style="font-size:16px">✕</button>
        </div>
        <div style="display:flex;gap:10px;margin-bottom:var(--s-3)">
          <div style="width:120px"><label style="${lbl}">N° pedido</label><input id="pm-numero" type="number" value="${escapeHtml(String(m.numero||''))}" style="${inp}"></div>
          <div style="flex:1"><label style="${lbl}">Fecha (auto)</label><input type="text" value="${fmtDate(new Date())}" disabled style="${inp};opacity:.5"></div>
          <div style="flex:1"><label style="${lbl}">Estado pedido</label><input type="text" value="En produccion" disabled style="${inp};opacity:.5"></div>
        </div>
        <label style="${lbl}">Plataforma · ¿por dónde llegó?</label>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <button type="button" data-pm-plat="WPP" style="flex:1;padding:9px;border:1px solid;border-radius:var(--r-sm);cursor:pointer;font-size:13px;font-weight:600;${oBtn(m.plataforma==='WPP')}">📱 WhatsApp</button>
          <button type="button" data-pm-plat="IG" style="flex:1;padding:9px;border:1px solid;border-radius:var(--r-sm);cursor:pointer;font-size:13px;font-weight:600;${oBtn(m.plataforma==='IG')}">📷 Instagram</button>
        </div>
        <div id="pm-tel-wrap" style="margin-bottom:var(--s-3);${m.plataforma==='WPP'?'':'display:none'}">
          <label style="${lbl}">Teléfono del cliente <span style="opacity:.6">(para trazar el ad)</span></label>
          <input id="pm-telefono" type="tel" value="${escapeHtml(m.telefono||'')}" placeholder="5491155604999" style="${inp}">
        </div>
        <label style="${lbl}">Carteles del pedido</label>
        <div id="pm-carteles">${m.carteles.map((c,i)=>renderPedidoCartelBlock(c,i,m.carteles.length)).join('')}</div>
        <button id="pm-add-cartel" class="btn btn-ghost" style="width:100%;margin-bottom:var(--s-3);font-size:12px">＋ Agregar otro cartel a este pedido</button>
        <div style="display:flex;gap:10px;margin-bottom:var(--s-3)">
          <div style="flex:1"><label style="${lbl}">Estado del pago</label><select id="pm-estadopago" style="${inp}">${['1er pago','2do pago'].map(o=>`<option ${m.estadoPago===o?'selected':''}>${o}</option>`).join('')}</select></div>
          <div style="flex:1"><label style="${lbl}">Pagado (seña)</label><input id="pm-pagado" type="number" value="${escapeHtml(String(m.pagado||''))}" placeholder="$" style="${inp}" data-pm-calc></div>
          <div style="flex:1"><label style="${lbl}">Restante (auto)</label><div style="${inp};opacity:.7;display:flex;align-items:center;min-height:36px"><span id="pm-restante">${fmtMoney(restante)}</span></div></div>
        </div>
        <div style="margin-bottom:var(--s-3)"><label style="${lbl}">De qué ad viene <span style="opacity:.6">(auto por teléfono en WPP · editable)</span></label><input id="pm-ad" value="${escapeHtml(m.ad||'')}" placeholder="se completa solo si vino de un ad" style="${inp}"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding-top:var(--s-2);border-top:1px solid var(--border)">
          <div style="font-size:13px;color:var(--fg-subtle)">Total: <b style="color:var(--fg)" id="pm-total">${fmtMoney(total)}</b></div>
          <div style="display:flex;gap:8px">
            <button id="pm-cancel" class="btn btn-ghost">Cancelar</button>
            <button id="pm-confirm" class="btn btn-cyan">${STATE.pedidoModalSaving ? 'Cargando…' : '✓ Crear pedido'}</button>
          </div>
        </div>
      </div>
    </div>`;
}
function bindPedidoModal() {
  if (!STATE.pedidoModalOpen) return;
  const close = () => cancelCargarPedido();
  const cl = document.getElementById('pm-close'); if (cl) cl.onclick = close;
  const cc = document.getElementById('pm-cancel'); if (cc) cc.onclick = close;
  const bk = document.getElementById('pm-backdrop'); if (bk) bk.onclick = (e) => { if (e.target.id === 'pm-backdrop') close(); };
  document.querySelectorAll('[data-pm-plat]').forEach(b => b.onclick = () => { readPedidoModalDOM(); STATE.pedidoModal.plataforma = b.dataset.pmPlat; render(); });
  const add = document.getElementById('pm-add-cartel'); if (add) add.onclick = pmAddCartel;
  document.querySelectorAll('[data-pm-remove]').forEach(b => b.onclick = () => pmRemoveCartel(parseInt(b.dataset.pmRemove,10)));
  document.querySelectorAll('[data-pm-dimer]').forEach(sel => sel.onchange = () => {
    const i = parseInt(sel.dataset.pmDimer,10);
    const pd = document.getElementById('pm-precioDimmer-'+i);
    if (pd) { const sug = DIMMER_PRECIOS[sel.value]; pd.value = (sug==null?'':sug); }
    pmRecalc();
  });
  document.querySelectorAll('[data-pm-calc]').forEach(el => el.addEventListener('input', pmRecalc));
  // Autocomplete del diseño (cotizaciones).
  document.querySelectorAll('[data-pm-ac]').forEach(el => {
    const i = parseInt(el.dataset.pmAc, 10);
    el.oninput = () => pmCartelAutocomplete(i);
    el.onblur = () => setTimeout(() => { const box = document.getElementById('pm-ac-' + i); if (box) box.style.display = 'none'; }, 150);
  });
  // Colores: dropdown agrega chip / ✕ quita.
  document.querySelectorAll('[data-pm-color-trigger]').forEach(b => b.onclick = (e) => { e.stopPropagation(); const panel = document.getElementById('pm-colorpanel-' + b.dataset.pmColorTrigger); if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; });
  document.querySelectorAll('[data-pm-coloradd]').forEach(el => el.onclick = () => { const p = el.dataset.pmColoradd.split('|'); pmAddColor(parseInt(p[0], 10), p[1]); });
  document.querySelectorAll('[data-pm-color-rm]').forEach(b => b.onclick = () => { const p = b.dataset.pmColorRm.split('|'); pmRemoveColor(parseInt(p[0], 10), p[1]); });
  document.querySelectorAll('[data-pm-tipo]').forEach(b => b.onclick = () => { const p = b.dataset.pmTipo.split('|'); readPedidoModalDOM(); STATE.pedidoModal.carteles[parseInt(p[0], 10)].tipo = p[1]; render(); });
  const tel = document.getElementById('pm-telefono'); if (tel) tel.addEventListener('blur', pmTraceAd);
  const cf = document.getElementById('pm-confirm'); if (cf) cf.onclick = confirmCargarPedido;
}
async function confirmCargarPedido() {
  if (STATE.pedidoModalSaving) return;
  readPedidoModalDOM();
  const m = STATE.pedidoModal;
  const carteles = (m.carteles||[]).filter(c => String(c.cartel||'').trim());
  if (!carteles.length) { toast('Poné al menos un cartel con nombre'); return; }
  if (m.plataforma === 'WPP' && String(m.telefono||'').replace(/\D/g,'').length < 8) { toast('El teléfono es obligatorio para WhatsApp'); return; }
  for (let k = 0; k < carteles.length; k++) {
    const c = carteles[k], nro = k + 1;
    if (!String(c.colores||'').trim())   { toast(`Cartel ${nro}: elegí al menos un color`); return; }
    if (!(Number(c.cantidad) > 0))       { toast(`Cartel ${nro}: falta la cantidad`); return; }
    if (!(Number(c.alto) > 0))           { toast(`Cartel ${nro}: falta el alto`); return; }
    if (!(Number(c.ancho) > 0))          { toast(`Cartel ${nro}: falta el ancho`); return; }
    if (!(Number(c.cmNeon) > 0))         { toast(`Cartel ${nro}: faltan los cm de neón`); return; }
    if (!String(c.base||'').trim())      { toast(`Cartel ${nro}: falta la base`); return; }
    if (!(Number(c.precio) > 0))         { toast(`Cartel ${nro}: falta el precio`); return; }
    if (c.dimer && c.dimer !== 'NO' && !(Number(c.precioDimmer) > 0)) { toast(`Cartel ${nro}: falta el precio del dimmer`); return; }
    if (!String(c.envio||'').trim())     { toast(`Cartel ${nro}: falta el envío`); return; }
  }
  if (!(Number(m.pagado) > 0)) { toast('Falta el monto de la seña (pagado)'); return; }
  STATE.pedidoModalSaving = true; render();
  try {
    const payload = {
      numero: m.numero ? Number(m.numero) : undefined,
      plataforma: m.plataforma, telefono: m.telefono, estado_pago: m.estadoPago, pagado: m.pagado, ad: m.ad,
      carteles: carteles.map(c => ({
        cartel: c.cartel, colores: c.colores, tipo: c.tipo, alto: c.alto, ancho: c.ancho, cm_neon: c.cmNeon,
        tramos: c.tramos, base: c.base, cantidad: c.cantidad, precio: c.precio, dimer: c.dimer, precio_dimmer: c.precioDimmer,
        envio: c.envio, aclaracion: c.aclaracion
      }))
    };
    const r = await fetch(CONFIG.trackerUrl + '/admin/pedidos', { method:'POST', headers: { ...authHeaders(), 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || ('HTTP '+r.status));
    const nuevos = (j.pedidos||[]).map(mapPedidoFromD1);
    STATE.pedidos = [...nuevos, ...STATE.pedidos];
    STATE.pedidoModalOpen = false;
    STATE.pedidoModalSaving = false;
    render();
    toast(`Pedido #${j.numero} cargado ✓ (${nuevos.length} cartel${nuevos.length>1?'es':''})`);
  } catch (e) {
    STATE.pedidoModalSaving = false; render();
    toast('Error al cargar el pedido: ' + e.message);
  }
}

// ---------- PRESUPUESTOS ----------
let pptoFilter = 'all'; // all | abiertos | cerrados | semana
let pptoSearch = '';
function bindPresupuestos() {
  document.querySelectorAll('[data-ppfilter]').forEach(el => {
    el.onclick = () => { pptoFilter = el.dataset.ppfilter; render(); };
  });
  const searchInput = document.querySelector('[data-pp-search]');
  if (searchInput) {
    // Debounce 180ms: repintar la tabla de presupuestos en cada tecla traba el
    // tipeo. El input está en el toolbar (fuera de #table-presupuestos) → no
    // pierde el foco al repintar.
    let _pptoSearchTimer = null;
    searchInput.addEventListener('input', () => {
      pptoSearch = searchInput.value;
      clearTimeout(_pptoSearchTimer);
      _pptoSearchTimer = setTimeout(renderTablePresupuestos, 180);
    });
  }
  const openBtn = document.querySelector('[data-cot-open]');
  if (openBtn) openBtn.onclick = () => { pptoShowCotizador = true; render(); };
  const closeBtn = document.querySelector('[data-cot-close]');
  if (closeBtn) closeBtn.onclick = () => { pptoShowCotizador = false; render(); };
  document.querySelectorAll('[data-cot-field]').forEach(el => {
    el.oninput = () => { STATE.cotizadorForm[el.dataset.cotField] = el.value; updateCotizadorForm(); };
    el.onchange = () => { STATE.cotizadorForm[el.dataset.cotField] = el.value; updateCotizadorForm(); };
  });
  // Inputs de carteles extra (data-extra-field + data-extra-idx)
  document.querySelectorAll('[data-extra-field]').forEach(el => {
    const idx = +el.dataset.extraIdx;
    const field = el.dataset.extraField;
    const handler = () => {
      if (!Array.isArray(STATE.cotizadorForm.extraCarteles)) STATE.cotizadorForm.extraCarteles = [];
      if (!STATE.cotizadorForm.extraCarteles[idx]) STATE.cotizadorForm.extraCarteles[idx] = { cliente:'', ancho:'', alto:'', neon:'', tramos:'', tipo:'INT' };
      STATE.cotizadorForm.extraCarteles[idx][field] = el.value;
      updateCotizadorForm();
    };
    el.oninput = handler;
    el.onchange = handler;
  });
  // ＋ Agregar otro cartel
  const addBtn = document.getElementById('cot-add-cartel');
  if (addBtn) addBtn.onclick = () => {
    if (!Array.isArray(STATE.cotizadorForm.extraCarteles)) STATE.cotizadorForm.extraCarteles = [];
    STATE.cotizadorForm.extraCarteles.push({ cliente:'', ancho:'', alto:'', neon:'', tramos:'', tipo:'INT' });
    render();
  };
  // × Eliminar cartel extra
  document.querySelectorAll('[data-extra-remove]').forEach(el => {
    el.onclick = () => {
      const idx = +el.dataset.extraRemove;
      if (Array.isArray(STATE.cotizadorForm.extraCarteles)) STATE.cotizadorForm.extraCarteles.splice(idx, 1);
      render();
    };
  });
  bindCotSaveBtn();
  bindCotRender();
  const fuBtn = document.getElementById('btn-pp-followups');
  if (fuBtn) fuBtn.onclick = () => enviarFollowupsPresupuesto();
  const failBtn = document.getElementById('btn-pp-failures');
  if (failBtn) failBtn.onclick = () => verFallosWA();
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
  const waBtn = document.getElementById('cot-send-wa-btn');
  if (waBtn) waBtn.onclick = () => enviarPresupuestoWA();
  const editBtn = document.getElementById('cot-edit-btn');
  if (editBtn) editBtn.onclick = () => { STATE.cotizadorEditing = !STATE.cotizadorEditing; updateCotizadorForm(); };
  const closeBtn = document.getElementById('cot-text-close');
  if (closeBtn) closeBtn.onclick = () => { STATE.cotizadorEditing = false; updateCotizadorForm(); };
  const resetBtn = document.getElementById('cot-text-reset');
  if (resetBtn) resetBtn.onclick = () => { STATE.cotizadorForm.textoOverride = ''; updateCotizadorForm(); };
  const ta = document.getElementById('cot-text-editor');
  if (ta) {
    // Sin re-render mientras el usuario tipea (preserva cursor).
    // Solo guarda el override; el badge "modificado" se actualiza al cerrar el editor.
    ta.oninput = () => { STATE.cotizadorForm.textoOverride = ta.value; };
  }
}

// ===== Render IA del cotizador rápido (#presupuestos) =====
function bindCotRender() {
  const dz = document.getElementById('cot-render-dropzone');
  const fileInput = document.getElementById('cot-render-file');
  if (dz && fileInput) {
    dz.onclick = () => fileInput.click();
    dz.ondragover = (ev) => { ev.preventDefault(); dz.style.borderColor = 'var(--accent-cyan)'; dz.style.background = 'rgba(143,212,222,.06)'; };
    dz.ondragleave = () => { dz.style.borderColor = ''; dz.style.background = ''; };
    dz.ondrop = (ev) => { ev.preventDefault(); dz.style.borderColor = ''; dz.style.background = ''; cotRenderSetFile(ev.dataTransfer?.files?.[0]); };
    fileInput.onchange = () => { cotRenderSetFile(fileInput.files?.[0]); fileInput.value = ''; };
  }
  const genBtn = document.getElementById('cot-render-generate');
  if (genBtn) genBtn.onclick = () => cotGenerarRender();
  const regenBtn = document.getElementById('cot-render-regen');
  if (regenBtn) regenBtn.onclick = () => cotGenerarRender();
  const clearBtn = document.getElementById('cot-render-clear');
  if (clearBtn) clearBtn.onclick = () => cotRenderClear();

  // Paste de imagen (Ctrl/Cmd+V) sobre el Render IA. Un <div> no recibe el
  // evento 'paste' (solo inputs/contenteditable/document), por eso el "📋 Pegá"
  // del dropzone no hacía nada. Escuchamos en document (bind único) y dirigimos
  // la imagen al cotizador cuando su dropzone está visible (cotizador abierto y
  // sin imagen aún) y no hay un modal encima con su propio paste.
  if (!document._cotRenderPasteBound) {
    document.addEventListener('paste', async (ev) => {
      if (STATE.quickModalOpen || (STATE.rectify && STATE.rectify.open) || (STATE.mockup && STATE.mockup.open)) return;
      if (!document.getElementById('cot-render-dropzone')) return;
      const items = ev.clipboardData?.items || [];
      let file = null;
      for (const it of items) {
        if (it.kind === 'file' && (it.type || '').startsWith('image/')) { file = it.getAsFile(); break; }
      }
      if (!file) return;            // texto u otro contenido → no interceptamos
      ev.preventDefault();
      await cotRenderSetFile(file);
    });
    document._cotRenderPasteBound = true;
  }
}

async function cotRenderSetFile(file) {
  if (!file || !(file.type || '').startsWith('image/')) return;
  try {
    const img = await fileToDraftImage(file);   // { dataUrl, blob, contentType }
    STATE.cotizadorForm.renderInput = img;
    STATE.cotizadorForm.renderResult = null;
    render();
  } catch (e) { toast('No se pudo leer la imagen'); }
}

function cotRenderClear() {
  STATE.cotizadorForm.renderInput = null;
  STATE.cotizadorForm.renderResult = null;
  STATE.cotizadorRenderGenerating = false;
  render();
}

async function cotGenerarRender() {
  const inp = STATE.cotizadorForm.renderInput;
  if (!inp || !inp.blob) { toast('Subí una foto primero'); return; }
  if (STATE.cotizadorRenderGenerating) return;
  if (!CONFIG.trackerUrl || !STATE.token) { toast('Tenés que estar logueado para generar el render'); return; }
  STATE.cotizadorRenderGenerating = true;
  render();
  try {
    const fd = new FormData();
    fd.append('file', inp.blob, 'boceto' + (inp.contentType === 'image/png' ? '.png' : '.jpg'));
    const nombre = (STATE.cotizadorForm.cliente || '').trim();
    if (nombre) fd.append('notas', 'Cartel de neón LED para: ' + nombre);
    const r = await fetch(CONFIG.trackerUrl + '/admin/render-adhoc', { method: 'POST', headers: authHeaders(), body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.base64) {
      toast('Error generando render: ' + (j.error || 'fallo'));
      STATE.cotizadorRenderGenerating = false; render(); return;
    }
    STATE.cotizadorForm.renderResult = { mime: j.mime || 'image/png', base64: j.base64 };
    STATE.cotizadorRenderGenerating = false;
    render();
    toast('Render generado ✨');
  } catch (e) {
    STATE.cotizadorRenderGenerating = false; render();
    toast('Error de red generando el render');
  }
}

// base64 → Blob (para mandar el render por /admin/wa/send-media con caption).
function b64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'image/png' });
}

let pptoShowCotizador = false;

// Modo revendedor: dado un precio (sugerido/retail), el revendedor lo compra a -5%
// y lo revende marcando 25-35% SOBRE SU COSTO. Devuelve costo + rango de reventa + ganancia.
function revendedorCalc(precio) {
  const costo = Math.round(precio * 0.95);
  return {
    costo,
    reventaMin: Math.round(costo * 1.25),
    reventaMax: Math.round(costo * 1.35),
    gananciaMin: Math.round(costo * 0.25),
    gananciaMax: Math.round(costo * 0.35),
  };
}
function toggleCotizadorRevendedor() { STATE.cotizadorRevendedor = !STATE.cotizadorRevendedor; render(); }
// Bloque "Precios revendedor" para el cotizador: toggle + tabla (trans/negro) con
// costo (-5%), reventa sugerida (+25-35% sobre el costo) y ganancia del revendedor.
function renderRevendedorBlock(baseTrans, baseNegro) {
  if (!isAdmin()) return '';  // precios de revendedor: solo Gaspar, no Joaco
  const on = !!STATE.cotizadorRevendedor;
  const toggle = `<button class="btn btn-ghost" onclick="toggleCotizadorRevendedor()" style="font-size:11px;margin-top:var(--s-3)">🤝 ${on ? 'Ocultar' : 'Ver'} precios revendedor</button>`;
  if (!on) return toggle;
  const fila = (label, base) => {
    const r = revendedorCalc(base);
    return `<tr>
      <td style="padding:5px 8px;color:var(--fg-subtle)">${label}</td>
      <td style="padding:5px 8px;text-align:right">${fmtMoney(r.costo)}</td>
      <td style="padding:5px 8px;text-align:right;color:var(--accent-cyan)">${fmtMoney(r.reventaMin)} – ${fmtMoney(r.reventaMax)}</td>
      <td style="padding:5px 8px;text-align:right;color:#4ade80">${fmtMoney(r.gananciaMin)} – ${fmtMoney(r.gananciaMax)}</td>
    </tr>`;
  };
  return `${toggle}
    <div style="margin-top:var(--s-2);padding:var(--s-2) var(--s-3);background:rgba(143,212,222,.06);border:1px solid var(--border);border-radius:var(--r-sm)">
      <div style="font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">🤝 Precios revendedor <span style="text-transform:none;color:var(--fg-mute)">· costo −5% · reventa +25 a 35% sobre el costo</span></div>
      <table style="width:100%;font-size:12px;border-collapse:collapse">
        <thead><tr style="color:var(--fg-mute);font-size:10px;text-transform:uppercase;letter-spacing:.04em">
          <th style="text-align:left;padding:2px 8px">Base</th>
          <th style="text-align:right;padding:2px 8px">Tu costo (−5%)</th>
          <th style="text-align:right;padding:2px 8px">Reventa sugerida</th>
          <th style="text-align:right;padding:2px 8px">Tu ganancia</th>
        </tr></thead>
        <tbody>
          ${fila('Transparente', baseTrans)}
          ${OFRECER_BASE_NEGRA ? fila('Negro', baseNegro) : ''}
        </tbody>
      </table>
    </div>`;
}
function renderCotizadorResults() {
  const f = STATE.cotizadorForm;
  const valid = +f.ancho > 0 && +f.alto > 0;
  if (!valid) return '<div class="muted" style="margin-top:var(--s-2);font-size:12px">Completá ancho y alto para ver los precios</div>';
  const carteles = getCarteles();
  const p = getCotizadorParams();
  const multi = carteles.length > 1;
  // Comparativa: calculamos con AMBAS fórmulas. La activa (transicionUseNueva)
  // es la que se manda al cliente; la otra se muestra como referencia chica.
  const useNueva = !!p.transicionUseNueva;
  const r       = useNueva ? calcCotizadorNuevo(carteles[0] || f) : calcCotizador(carteles[0] || f);
  const rOtra   = useNueva ? calcCotizador(carteles[0] || f)       : calcCotizadorNuevo(carteles[0] || f);
  const labelActivo = useNueva ? 'NUEVO' : 'VIEJO';
  const labelOtra   = useNueva ? 'fórmula vieja' : 'fórmula nueva';

  const blocksHtml = multi ? carteles.map((c, i) => {
    const rr = useNueva ? calcCotizadorNuevo(c) : calcCotizador(c);
    const rrOtra = useNueva ? calcCotizador(c) : calcCotizadorNuevo(c);
    const disen = (c.cliente || '').trim() || `Cartel ${i+1}`;
    return `
      <div class="cot-block" style="border:1px solid var(--border);border-radius:var(--r-sm);padding:var(--s-2);margin-bottom:var(--s-2)">
        <div style="font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">${escapeHtml(disen)} · ${Math.round(+c.ancho)}×${Math.round(+c.alto)} cm${useNueva && rr.cf ? ' · CF '+fmtMoney(rr.cf)+' · margen '+Math.round(rr.margen*100)+'%' : ' · m² '+rr.m2.toFixed(2)}</div>
        <div class="cot-result-grid">
          <div class="cot-result"><div class="lbl">Transparente</div><div class="val">${fmtMoney(rr.transFinal)}</div></div>
          ${OFRECER_BASE_NEGRA ? `<div class="cot-result"><div class="lbl">Negro</div><div class="val">${fmtMoney(rr.negroFinal)}</div></div>` : ''}
        </div>
        <div style="font-size:10px;color:var(--fg-mute);margin-top:6px">↔ ${labelOtra}: trans ${fmtMoney(rrOtra.transFinal)}${OFRECER_BASE_NEGRA ? ` · negro ${fmtMoney(rrOtra.negroFinal)}` : ''}</div>
      </div>`;
  }).join('') : '';

  const totalTrans = carteles.reduce((s, c) => s + (useNueva ? calcCotizadorNuevo(c) : calcCotizador(c)).transFinal, 0);
  const totalNegro = carteles.reduce((s, c) => s + (useNueva ? calcCotizadorNuevo(c) : calcCotizador(c)).negroFinal, 0);
  const totalTransOtra = carteles.reduce((s, c) => s + (useNueva ? calcCotizador(c) : calcCotizadorNuevo(c)).transFinal, 0);
  const totalNegroOtra = carteles.reduce((s, c) => s + (useNueva ? calcCotizador(c) : calcCotizadorNuevo(c)).negroFinal, 0);

  return `
    <div class="cot-results">
      ${multi ? `
        ${blocksHtml}
        <div class="cot-result-grid" style="border-top:2px solid var(--accent-cyan);padding-top:var(--s-2);margin-top:var(--s-2)">
          <div class="cot-result"><div class="lbl">${OFRECER_BASE_NEGRA ? 'Total transparente' : 'Total'}</div><div class="val"><b>${fmtMoney(totalTrans)}</b></div></div>
          ${OFRECER_BASE_NEGRA ? `<div class="cot-result"><div class="lbl">Total negro</div><div class="val"><b>${fmtMoney(totalNegro)}</b></div></div>` : ''}
        </div>
        <div style="font-size:10px;color:var(--fg-mute);margin-top:6px">↔ ${labelOtra}: total trans ${fmtMoney(totalTransOtra)}${OFRECER_BASE_NEGRA ? ` · total negro ${fmtMoney(totalNegroOtra)}` : ''}</div>
      ` : `
      <div class="cot-meta">
        ${useNueva && r.cf ? `CF: <b>${fmtMoney(r.cf)}</b> · margen: <b>${Math.round(r.margen*100)}%</b>${r.densidad ? ' · densidad '+r.densidad.toFixed(2)+'<small style="color:var(--fg-mute);font-size:10px">tramos/m</small>' : ''}` : `m² (sheet): <b>${r.m2.toFixed(2)}</b>`}
      </div>
      <div class="cot-result-grid">
        <div class="cot-result"><div class="lbl">Transparente</div><div class="val">${fmtMoney(r.transFinal)}</div></div>
        ${OFRECER_BASE_NEGRA ? `<div class="cot-result"><div class="lbl">Negro</div><div class="val">${fmtMoney(r.negroFinal)}</div></div>` : ''}
        <div class="cot-result"><div class="lbl">Reventa (×${p.reventa_mult})</div><div class="val">${fmtMoney(r.reventa)}</div></div>
        <div class="cot-result"><div class="lbl">Comisión (${(p.comision_pct*100).toFixed(0)}%)</div><div class="val">${fmtMoney(r.comision)}</div></div>
      </div>
      <div style="font-size:11px;color:var(--fg-mute);margin-top:8px;padding:8px;background:rgba(255,255,255,.02);border-radius:var(--r-sm);border:1px dashed var(--border)">
        <b style="color:var(--fg-subtle)">↔ ${labelOtra}:</b>
        trans <s>${fmtMoney(rOtra.transFinal)}</s>${OFRECER_BASE_NEGRA ? ` · negro <s>${fmtMoney(rOtra.negroFinal)}</s>` : ''}
        <span style="margin-left:6px;font-size:10px;opacity:.7">${useNueva ? '(la spec dice "abaratar grandes / cobrar chicos complejos")' : '(toggle transicionUseNueva en cotizador_params para activar)'}</span>
      </div>
      `}
      ${renderRevendedorBlock(multi ? totalTrans : r.transFinal, multi ? totalNegro : r.negroFinal)}
      <div style="margin-top:var(--s-3);display:flex;gap:var(--s-2);justify-content:flex-end;flex-wrap:wrap;align-items:center">
        ${STATE.cotizadorForm.textoOverride ? '<span class="pill amber" style="font-size:10px">texto modificado</span>' : ''}
        <button class="btn btn-ghost btn-icon" id="cot-copy-btn" title="Copiar presupuesto" aria-label="Copiar presupuesto">
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
        </button>
        <button class="btn btn-ghost btn-icon" id="cot-edit-btn" title="Editar texto del presupuesto" aria-label="Editar texto">
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
        </button>
        <button class="btn btn-ghost" id="cot-send-wa-btn" ${STATE.cotizadorSendingWA ? 'disabled' : ''}>${STATE.cotizadorSendingWA ? 'Enviando…' : '📱 Enviar por WhatsApp'}</button>
        <button class="btn btn-cyan" id="cot-save-btn" ${STATE.cotizadorSaving ? 'disabled' : ''}>${STATE.cotizadorSaving ? 'Guardando…' : 'Guardar en Sheet'}</button>
      </div>
      ${STATE.cotizadorEditing ? `
        <div style="margin-top:var(--s-3);display:flex;flex-direction:column;gap:var(--s-2)">
          <label style="font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em">Texto del presupuesto (editable)</label>
          <textarea id="cot-text-editor" rows="14" style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:10px;font-family:inherit;font-size:13px;color:var(--fg);resize:vertical">${escapeHtml(getPresupuestoTextoFinal() || '')}</textarea>
          <div style="display:flex;gap:var(--s-2);justify-content:flex-end">
            ${STATE.cotizadorForm.textoOverride ? '<button class="btn btn-ghost" id="cot-text-reset" title="Volver al texto auto-generado">↺ Restablecer</button>' : ''}
            <button class="btn btn-ghost" id="cot-text-close">Cerrar editor</button>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function renderCotizadorCartelBlock(c, idx, removable) {
  return `
    <div class="cot-extra-block" data-extra-idx="${idx}" style="border:1px solid var(--border);border-radius:var(--r-sm);padding:var(--s-2);margin-top:var(--s-2);position:relative">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--s-2)">
        <span style="font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em">Cartel ${idx+2}</span>
        ${removable ? `<button class="btn btn-ghost btn-icon" data-extra-remove="${idx}" title="Eliminar este cartel" aria-label="Eliminar">×</button>` : ''}
      </div>
      <div class="cot-grid">
        <label>Cliente / diseño<input type="text" data-extra-field="cliente" data-extra-idx="${idx}" value="${escapeHtml(c.cliente || '')}" placeholder="nombre del diseño"></label>
        <label>Ancho (cm)<input type="number" min="0" step="0.1" data-extra-field="ancho" data-extra-idx="${idx}" value="${escapeHtml(c.ancho)}"></label>
        <label>Alto (cm)<input type="number" min="0" step="0.1" data-extra-field="alto" data-extra-idx="${idx}" value="${escapeHtml(c.alto)}"></label>
        <label>Neón (mt)<input type="number" min="0" step="0.1" data-extra-field="neon" data-extra-idx="${idx}" value="${escapeHtml(c.neon)}"></label>
        <label title="Cantidad de tramos/cortes del vector. Afecta margen por complejidad.">
          Tramos<input type="number" min="0" step="1" data-extra-field="tramos" data-extra-idx="${idx}" value="${escapeHtml(c.tramos || '')}" placeholder="ej. 15">
        </label>
        <label>Tipo
          <select data-extra-field="tipo" data-extra-idx="${idx}">
            <option value="INT" ${c.tipo==='INT'?'selected':''}>INT (interior)</option>
            <option value="EXT" ${c.tipo==='EXT'?'selected':''}>EXT (exterior)</option>
          </select>
        </label>
      </div>
    </div>
  `;
}

function renderCotizadorForm() {
  const f = STATE.cotizadorForm;
  const extras = Array.isArray(f.extraCarteles) ? f.extraCarteles : [];
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
      </div>
      ${extras.length ? `<div style="font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em;margin-top:var(--s-3)">Cartel 1</div>` : ''}
      <div class="cot-grid" style="${extras.length ? 'margin-top:var(--s-1)' : ''}">
        <label>Ancho (cm)<input type="number" min="0" step="0.1" data-cot-field="ancho" value="${escapeHtml(f.ancho)}"></label>
        <label>Alto (cm)<input type="number" min="0" step="0.1" data-cot-field="alto" value="${escapeHtml(f.alto)}"></label>
        <label>Neón (mt)<input type="number" min="0" step="0.1" data-cot-field="neon" value="${escapeHtml(f.neon)}"></label>
        <label title="Cantidad de cortes/tramos independientes de neón (subtrazos abiertos del vector). Se cuenta en Illustrator. Afecta el margen por complejidad.">
          Tramos<input type="number" min="0" step="1" data-cot-field="tramos" value="${escapeHtml(f.tramos)}" placeholder="ej. 15">
        </label>
        <label>Tipo
          <select data-cot-field="tipo">
            <option value="INT" ${f.tipo==='INT'?'selected':''}>INT (interior)</option>
            <option value="EXT" ${f.tipo==='EXT'?'selected':''}>EXT (exterior)</option>
          </select>
        </label>
      </div>
      ${extras.map((c, i) => renderCotizadorCartelBlock(c, i, true)).join('')}
      <div style="margin-top:var(--s-2)">
        <button class="btn btn-ghost" id="cot-add-cartel" title="Agregar otro cartel al presupuesto">＋ Agregar otro cartel</button>
      </div>
      ${renderCotizadorRenderBlock()}
      <div id="cot-results-slot">${renderCotizadorResults()}</div>
    </div>
  `;
}

// Bloque de Render IA del cotizador rápido (#presupuestos). Misma lógica que el
// panel de cotización: subís una foto/boceto, se genera el render con IA y se
// manda como foto + caption (el texto del presupuesto) al enviar por WhatsApp.
function renderCotizadorRenderBlock() {
  const f = STATE.cotizadorForm;
  const input = f.renderInput;     // { dataUrl, blob, contentType }
  const result = f.renderResult;   // { mime, base64 }
  const gen = !!STATE.cotizadorRenderGenerating;
  return `
    <div style="margin-top:var(--s-3);border:1px dashed var(--border);border-radius:var(--r-sm);padding:var(--s-2)">
      <div style="font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">✨ Render IA <span style="text-transform:none;color:var(--fg-mute)">(opcional · se envía como foto con el presupuesto)</span></div>
      ${!input && !result ? `
        <div id="cot-render-dropzone" style="border:2px dashed var(--border);border-radius:var(--r-sm);padding:var(--s-2);text-align:center;color:var(--fg-mute);font-size:11px;cursor:pointer;transition:border-color .15s,background .15s">
          📋 Pegá, arrastrá o tocá para subir la foto / boceto del cartel
          <input type="file" id="cot-render-file" accept="image/*" style="display:none">
        </div>
      ` : ''}
      ${input && !result ? `
        <div style="display:flex;gap:var(--s-2);align-items:center">
          <img src="${input.dataUrl}" alt="boceto" style="width:64px;height:64px;object-fit:cover;border-radius:6px;border:1px solid var(--border);flex:0 0 auto">
          <button class="btn btn-cyan" id="cot-render-generate" ${gen ? 'disabled' : ''} style="flex:1">${gen ? '✨ Generando render…' : '✨ Generar render IA'}</button>
          <button class="btn btn-ghost btn-icon" id="cot-render-clear" title="Quitar" ${gen ? 'disabled' : ''}>×</button>
        </div>
      ` : ''}
      ${result ? `
        <div style="display:flex;gap:var(--s-2);align-items:flex-start">
          <img src="data:${result.mime};base64,${result.base64}" alt="render" style="width:120px;border-radius:8px;border:1px solid var(--accent-cyan);flex:0 0 auto">
          <div style="flex:1;font-size:11px;color:var(--fg-mute)">
            ✅ Render listo — se va a enviar como foto junto con el presupuesto.
            <div style="margin-top:8px;display:flex;gap:6px">
              <button class="btn btn-ghost" id="cot-render-regen" title="Generar otro render con la misma foto" ${gen ? 'disabled' : ''}>${gen ? '…' : '↻ Otro'}</button>
              <button class="btn btn-ghost" id="cot-render-clear" title="Quitar el render">× Quitar</button>
            </div>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

// Mensaje pre-armado para follow-up de presupuesto
const FUP_MSG = 'Holaa, cómo estás? Pudiste chequear el presupuesto? Cualquier cosa podemos hablar por llamada de celular! Quedamos a disposición!';

function renderContactoCell(p, withFup) {
  const tel = (p.telefono || '').trim();
  if (!tel) return '<span class="muted" style="font-size:12px">—</span>';
  if (p.canal === 'IG') {
    const handle = tel.startsWith('@') ? tel : '@' + tel;
    return `<span class="contact-pill ig" title="Instagram"><span class="contact-icon">📷</span>${escapeHtml(handle)}</span>`;
  }
  // WPP por default si tenemos contacto pero no canal claro
  const pill = `<span class="contact-pill wpp" title="WhatsApp"><span class="contact-icon">💬</span>${escapeHtml(formatPhoneDisplay(tel))}</span>`;
  if (!withFup) return pill;
  // Botón FUP: abre wa.me con mensaje prearmado de follow-up
  const telNorm = tel.startsWith('54') ? tel : '549' + tel.replace(/^0+/, '').replace(/^15/, '');
  const url = waLink(telNorm, FUP_MSG);
  return `<span class="contact-cell">${pill}<a class="fup-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="Follow-up por WhatsApp" onclick="event.stopPropagation()">FUP</a></span>`;
}

function renderPresupuestos() {
  const list = STATE.presupuestos.map(p => ({...p, st: presupuestoStatus(p)}));
  const counts = {
    all: list.length,
    hoy: list.filter(p=>daysBetween(p.fecha, TODAY) === 0).length,
    abiertos: list.filter(p=>p.st.state==='abierto').length,
    cerrados: list.filter(p=>p.st.state==='cerrado').length,
    semana: list.filter(p=>p.st.state==='abierto' && p.st.days <= 14).length,
  };
  return `
    <div class="page-head">
      <div><div class="eyebrow">${STATE.presupuestos.length}${STATE.presupuestos.length ? ' desde ' + fmtDate(STATE.presupuestos.reduce((min, p) => p.fecha < min ? p.fecha : min, STATE.presupuestos[0].fecha)) : ''}</div><h1>Presupuestos</h1></div>
      <div class="actions">
        <button class="btn btn-cyan" data-cot-open>＋ Cotizador</button>
        <button class="btn btn-ghost" id="btn-pp-failures" title="Ver presupuestos del cotizador que fallaron en entregar por WhatsApp en las últimas 24hs">⚠ Fallos WA</button>
        <button class="btn btn-ghost" id="btn-pp-followups" title="Enviar follow-up a clientes que recibieron presupuesto hace +1hs y no respondieron">📱 Follow-ups</button>
        <button class="btn btn-ghost" onclick="loadAll()">↻ Refrescar</button>
      </div>
    </div>
    ${pptoShowCotizador ? renderCotizadorForm() : ''}
    <div class="table-wrap">
      <div class="table-toolbar">
        <input type="text" placeholder="Buscar por diseño / cliente…" data-pp-search value="${escapeHtml(pptoSearch)}">
        <button class="btn btn-ghost ${pptoFilter==='hoy'?'btn-cyan':''}" data-ppfilter="hoy">Hoy · ${counts.hoy}</button>
        <button class="btn btn-ghost ${pptoFilter==='all'?'btn-cyan':''}" data-ppfilter="all">Todos · ${counts.all}</button>
        <button class="btn btn-ghost ${pptoFilter==='abiertos'?'btn-cyan':''}" data-ppfilter="abiertos">Abiertos · ${counts.abiertos}</button>
        <button class="btn btn-ghost ${pptoFilter==='semana'?'btn-cyan':''}" data-ppfilter="semana">Para seguir · ${counts.semana}</button>
        <button class="btn btn-ghost ${pptoFilter==='cerrados'?'btn-cyan':''}" data-ppfilter="cerrados">Cerrados · ${counts.cerrados}</button>
        <div class="right"><span id="ppto-row-count">0</span> filas</div>
      </div>
      <div id="table-presupuestos"></div>
    </div>
  `;
}

function renderTablePresupuestos() {
  const wrap = document.getElementById('table-presupuestos');
  if (!wrap) return;
  const list = STATE.presupuestos.map(p => ({...p, st: presupuestoStatus(p)}));
  let filtered = list;
  if (pptoFilter === 'hoy') filtered = filtered.filter(p=>daysBetween(p.fecha, TODAY) === 0);
  else if (pptoFilter === 'abiertos') filtered = filtered.filter(p=>p.st.state==='abierto');
  else if (pptoFilter === 'cerrados') filtered = filtered.filter(p=>p.st.state==='cerrado');
  else if (pptoFilter === 'semana') filtered = filtered.filter(p=>p.st.state==='abierto' && p.st.days <= 14);
  if (pptoSearch) {
    const q = normName(pptoSearch);
    filtered = filtered.filter(p => normName([p.nombre, p.telefono].join(' ')).includes(q));
  }
  filtered = filtered.sort((a,b) => (b.fecha - a.fecha) || (b.idx - a.idx));
  const countEl = document.getElementById('ppto-row-count');
  if (countEl) countEl.textContent = filtered.length;
  wrap.innerHTML = `
    <table class="t">
      <thead><tr><th>Fecha</th><th>Cliente</th><th>Tamaño</th><th>m²</th><th>Precio</th><th>Contacto</th><th>Estado</th></tr></thead>
      <tbody>
        ${filtered.length===0 ? '<tr class="empty-row"><td colspan="7">Sin presupuestos en este filtro</td></tr>' :
          filtered.map(p => {
            let pill = '';
            if (p.st.state === 'cerrado') {
              const ratio = p.st.pedido ? (p.st.pedido.precio / (p.precio || 1)) : 1;
              const exact = ratio >= 0.999 && ratio <= 1.001;
              pill = exact
                ? `<span class="pill green">✓ Cerrado</span>`
                : `<span class="pill green" title="Cerrado automáticamente por match de nombre + precio dentro de tolerancia ±20%">✓ Cerrado <span style="opacity:.6;font-size:9px">auto</span></span>`;
            }
            else if (p.st.state === 'fresco') pill = `<span class="pill cyan">${p.st.days}d</span>`;
            else if (p.st.state === 'abierto') pill = `<span class="pill ${p.st.days > 14 ? 'red' : 'amber'}">Abierto · ${p.st.days}d</span>`;
            else pill = `<span class="pill muted">Futuro</span>`;
            const dDays = daysBetween(p.fecha, TODAY);
            const dayPill = dDays === 0 ? '<span class="pill cyan" style="margin-left:6px;font-size:9px">HOY</span>' : dDays === 1 ? '<span class="pill amber" style="margin-left:6px;font-size:9px">AYER</span>' : '';
            return `<tr><td class="num">${fmtDateTime(p.fecha)}${dayPill}</td><td class="cliente">${escapeHtml(p.nombre)}</td><td class="num">${p.tamCm||'—'}×${p.ancho||'—'}</td><td class="num">${p.m2||'—'}</td><td class="num">${fmtMoney(p.precio)}</td><td>${renderContactoCell(p, true)}</td><td>${pill}</td></tr>`;
          }).join('')}
      </tbody>
    </table>
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
          const stateText = it.done ? '✓ Hecho' : (days > 0 ? `vencido ${days}d` : days === 0 ? 'HOY' : `en ${-days}d`);
          const stClass = it.done ? 'tp-done' : (m.state === 'overdue' ? 'tp-overdue' : m.state === 'now' ? 'tp-due' : 'tp-future');
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
  // Carteles del mismo pedido (numero+fecha): los cambios de estado/pago/productor aplican a todos.
  const hermanos = STATE.pedidos.filter(x => x.numero === p.numero && +x.fecha === +p.fecha);
  const totalPedido = hermanos.reduce((s,x) => s + (Number(x.precio)||0) + (Number(x.precioDimmer)||0), 0);
  const inpD = 'width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:6px;padding:7px 9px;color:var(--fg);font-size:13px';
  const lblD = 'display:block;font-size:10px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px';
  const pedOpts = uniq([p.estadoPedido,'En produccion','para enviar','Entregado'].filter(Boolean)).map(o=>`<option ${p.estadoPedido===o?'selected':''}>${escapeHtml(o)}</option>`).join('');
  const pagoOpts = uniq([p.estadoPago,'1er pago','2do pago'].filter(Boolean)).map(o=>`<option ${p.estadoPago===o?'selected':''}>${escapeHtml(o)}</option>`).join('');
  // Dropdowns alineados a la validación del Excel (base col H, dimer col K).
  const baseOptsD = ['NEGRO','TRANS','ESPEJO','TRANS Y VINILO'].map(o=>`<option ${p.base===o?'selected':''}>${o}</option>`).join('');
  const dimerOptsD = ['NO','SLIM','CONTROL','APP'].map(o=>`<option ${p.dimmer===o?'selected':''}>${o}</option>`).join('');
  document.getElementById('drawer').innerHTML = `
    <div class="drawer-h">
      <h2>${escapeHtml(p.cartel)}</h2>
      <button class="close" onclick="closeDrawer()">×</button>
    </div>
    <div class="drawer-body">
      <div class="drawer-section">
        <h4>Datos del cartel</h4>
        <div style="display:flex;flex-direction:column;gap:10px">
          <div><label style="${lblD}">Diseño / cartel</label><input id="ped-edit-cartel" value="${escapeHtml(p.cartel||'')}" style="${inpD}"></div>
          <div style="display:flex;gap:8px">
            <div style="flex:1"><label style="${lblD}">Base</label><select id="ped-edit-base" style="${inpD}">${baseOptsD}</select></div>
            <div style="flex:1"><label style="${lblD}">Dimmer</label><select id="ped-edit-dimer" style="${inpD}">${dimerOptsD}</select></div>
          </div>
          <div><label style="${lblD}">Precio del cartel</label><input id="ped-edit-precio" type="number" value="${p.precio||''}" style="${inpD}"></div>
        </div>
        <dl class="kv" style="margin-top:10px">
          <dt>Fecha</dt><dd>${fmtDateLong(p.fecha)}</dd>
          <dt>Número</dt><dd>${p.numero || '—'}</dd>
          <dt>Medidas</dt><dd>${p.alto}×${p.ancho} cm · ${p.cmNeon} cm neón</dd>
          <dt>Colores</dt><dd>${escapeHtml(p.colores)}</dd>
          <dt>Cantidad</dt><dd>${p.cantidad}</dd>
          ${p.precioDimmer ? `<dt>Precio dimmer</dt><dd>${fmtMoney(p.precioDimmer)}</dd>` : ''}
        </dl>
      </div>
      <div class="drawer-section">
        <h4>Estado, pago y productor ${hermanos.length>1?`<span style="font-size:11px;color:var(--fg-subtle);font-weight:400">· aplica a los ${hermanos.length} carteles</span>`:''}</h4>
        <div style="display:flex;flex-direction:column;gap:10px">
          <div><label style="${lblD}">Estado del pedido</label><select id="ped-edit-estadopedido" style="${inpD}">${pedOpts}</select></div>
          <div style="display:flex;gap:8px">
            <div style="flex:1"><label style="${lblD}">Estado del pago</label><select id="ped-edit-estadopago" style="${inpD}">${pagoOpts}</select></div>
            <div style="flex:1"><label style="${lblD}">Pagado</label><input id="ped-edit-pagado" type="number" value="${p.pagado||''}" style="${inpD}"></div>
          </div>
          <div><label style="${lblD}">Productor</label><input id="ped-edit-productor" value="${escapeHtml(p.productor||'')}" placeholder="quién lo produce (lo cargás vos)" style="${inpD}"></div>
        </div>
      </div>
      <div class="drawer-section">
        <h4>Trazabilidad y envío</h4>
        <div style="display:flex;flex-direction:column;gap:10px">
          <div><label style="${lblD}">Trazabilidad (Ad)</label><input id="ped-edit-ad" value="${escapeHtml(p.canalAd||'')}" placeholder="de qué ad vino / cómo llegó" style="${inpD}"></div>
          <button class="btn btn-ghost" onclick="verAnuncioPedido(${idx})" style="font-size:12px;align-self:flex-start;padding:5px 10px">🔗 Ver anuncio</button>
          <div><label style="${lblD}">Envío</label><textarea id="ped-edit-envio" rows="4" style="${inpD};resize:vertical">${escapeHtml(p.envio||'')}</textarea></div>
          <div><label style="${lblD}">Aclaración</label><input id="ped-edit-aclaracion" value="${escapeHtml(p.aclaracion||'')}" style="${inpD}"></div>
          <div style="font-size:11px;color:var(--fg-subtle)">Plataforma: ${escapeHtml(p.plataforma||'—')}</div>
        </div>
      </div>
      <div class="drawer-section">
        <div style="font-size:12px;color:var(--fg-subtle);margin-bottom:10px">Total del pedido: <b style="color:var(--fg)">${fmtMoney(totalPedido)}</b> · Restante actual: <b style="color:var(--fg)">${fmtMoney(p.restante)}</b></div>
        <button class="btn btn-cyan" id="ped-edit-save" onclick="savePedidoEdit(${idx})" style="width:100%">Guardar cambios</button>
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
            const doneId = `pv:${p.idx}|${m.id}`;
            const done = isDone(doneId);
            const doneAt = getDoneAt(doneId);
            const cls = done ? 'done' : (m.state === 'now' ? 'now' : 'future');
            const link = tel ? waLink(tel, m.template(p.cartel.split(' ')[0])) : '';
            const desc = done
              ? `✓ hecho${doneAt ? ' ' + fmtDoneAt(doneAt) : ''}`
              : (m.entregado ? (m.days > 0 ? `vencido hace ${m.days}d` : m.days === 0 ? 'hoy' : `en ${-m.days}d`) : 'esperando entrega');
            return `<div class="tl-item ${cls}">
              <div class="tl-date">${fmtDate(m.due)} · <span class="pill ${m.tagClass}">${m.id}</span></div>
              <div class="tl-title">${m.label}</div>
              <div class="tl-desc">${desc}</div>
              ${!done && link && (m.state === 'now' || m.state === 'overdue') ? `<a class="btn btn-primary" target="_blank" href="${escapeHtml(link)}" style="margin-top:8px;font-size:12px">📱 Mandar mensaje</a>` : ''}
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

// Abre el anuncio del que vino el cliente: busca en vivo la atribución de ad por el
// teléfono del pedido y abre el link de Meta (source_url o Ads Library por id).
async function verAnuncioPedido(idx) {
  const p = STATE.pedidos.find(x => x.idx === idx);
  if (!p) return;
  const tel = String(p.telefono || extractPhone(p.envio) || '').replace(/\D/g, '');
  if (!tel) { toast('Este pedido no tiene teléfono para trazar el anuncio'); return; }
  toast('Buscando el anuncio…');
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/ad-attribution?phone=' + encodeURIComponent(tel), { headers: authHeaders() });
    const j = await r.json();
    const a = j && j.attribution;
    const url = a && (a.source_url || (a.source_id ? 'https://www.facebook.com/ads/library/?id=' + a.source_id : ''));
    if (url) window.open(url, '_blank');
    else toast('No se encontró el anuncio para este contacto');
  } catch (e) { toast('Error al buscar el anuncio'); }
}
// Cambio rápido de un solo campo (estado_pago / estado_pedido) desde el dropdown
// inline de la tabla. PATCH a nivel pedido; refresca STATE + repinta la tabla.
async function savePedidoField(idx, field, value) {
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/pedidos/' + idx, { method: 'PATCH', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ [field]: value }) });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
    const updated = (j.pedidos || []).map(mapPedidoFromD1);
    const ids = new Set(updated.map(x => x.idx));
    STATE.pedidos = STATE.pedidos.filter(x => !ids.has(x.idx)).concat(updated);
    renderTablePedidos();
    toast('Actualizado ✓');
  } catch (e) { toast('Error: ' + e.message); renderTablePedidos(); }
}
// Guarda los cambios del cartel + del pedido desde el drawer. Refresca tabla + drawer.
async function savePedidoEdit(idx) {
  const p = STATE.pedidos.find(x => x.idx === idx);
  if (!p) return;
  const body = {
    // Campos del cartel (esta fila): el worker los actualiza por id.
    cartel:        document.getElementById('ped-edit-cartel')?.value,
    base:          document.getElementById('ped-edit-base')?.value,
    dimer:         document.getElementById('ped-edit-dimer')?.value,
    precio:        document.getElementById('ped-edit-precio')?.value,
    ad:            document.getElementById('ped-edit-ad')?.value,
    envio:         document.getElementById('ped-edit-envio')?.value,
    aclaracion:    document.getElementById('ped-edit-aclaracion')?.value,
    // Campos del pedido (aplican a todos los carteles del nro+fecha).
    estado_pedido: document.getElementById('ped-edit-estadopedido')?.value,
    estado_pago:   document.getElementById('ped-edit-estadopago')?.value,
    pagado:        document.getElementById('ped-edit-pagado')?.value,
    productor:     document.getElementById('ped-edit-productor')?.value
  };
  const btn = document.getElementById('ped-edit-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/pedidos/' + idx, { method: 'PATCH', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
    const updated = (j.pedidos || []).map(mapPedidoFromD1);
    const ids = new Set(updated.map(x => x.idx));
    STATE.pedidos = STATE.pedidos.filter(x => !ids.has(x.idx)).concat(updated);
    if (STATE.view === 'pedidos') renderTablePedidos();
    openDrawerPedido(idx); // refrescar el drawer con lo guardado
    toast('Pedido actualizado ✓');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar cambios'; }
    toast('Error al guardar: ' + e.message);
  }
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

  // Heatmap por día (últimos N días) — usar fecha LOCAL Argentina, no UTC
  const days = actFilter.range === 'all' ? 30 : (actFilter.range === '7d' ? 7 : 30);
  const dayMap = new Map();
  for (const r of rows) {
    const k = localDateKey(new Date(r.ts));
    dayMap.set(k, (dayMap.get(k) || 0) + 1);
  }
  const dayList = [];
  for (let i = days - 1; i >= 0; i--) {
    const dt = addDays(TODAY, -i);
    const k = localDateKey(dt);
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
let adminData = { rows: [], loading: false, error: null, range: '7d', loaded: false };

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
    adminData = { rows: j.rows || [], loading: false, error: null, range: adminData.range, loaded: true };
  } catch (e) {
    adminData = { rows: [], loading: false, error: e.message, range: adminData.range, loaded: true };
  }
  render();
}

function bindAdmin() {
  document.querySelectorAll('[data-admin-range]').forEach(b => b.onclick = () => { adminData.range = b.dataset.adminRange; loadAdminActivity(); });
  // Usar el flag `loaded` (no rows.length): si Joaquin tiene 0 actividad, rows=[] y
  // el guard viejo re-disparaba loadAdminActivity en cada render -> loop infinito -> spinner eterno.
  if (!adminData.loaded && !adminData.loading && isAdmin()) loadAdminActivity();
  // Stats del copiloto IA (generadas / enviadas / editadas / descartadas).
  maybeRefreshCopilotCost();
  // Fase 2C: propuestas de mejora al playbook pendientes de aprobar.
  loadImprovements();
  // Panel de costos del sitio (gasto mensual IA/infra/servicios).
  loadCosts();

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
  if (resetBtn) resetBtn.onclick = async () => {
    const ok = await showConfirm('¿Resetear todos los parámetros a los valores originales?', {
      title: 'Resetear parámetros',
      confirmLabel: 'Resetear',
      variant: 'warn'
    });
    if (!ok) return;
    const defs = CONFIG.cotizadorDefaults;
    document.querySelectorAll('[data-cot-param]').forEach(i => {
      i.value = defs[i.dataset.cotParam];
    });
  };
  // 🔄 Refrescar COGS del Excel al instante (bypassa cache del worker).
  const cogsBtn = document.getElementById('cogs-refresh');
  if (cogsBtn) cogsBtn.onclick = async () => {
    cogsBtn.disabled = true;
    const orig = cogsBtn.textContent;
    cogsBtn.textContent = '⏳ Leyendo…';
    const res = await loadCogsFromExcel({ fresh: true });
    cogsBtn.disabled = false;
    cogsBtn.textContent = orig;
    if (res) toast('✓ COGS actualizados del Excel');
    else toast('⚠ No se pudo leer el Excel — revisá el Apps Script');
    render();
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

    <div class="card" style="margin-bottom:var(--s-4)">
      <div class="card-h">
        <h3>Copiloto IA · sugerencias</h3>
        <span class="muted" style="font-size:12px">se cobra solo al tocar ✨</span>
      </div>
      <div id="copilot-admin-stats"><div class="loading"><div class="spinner"></div></div></div>
      <div style="border-top:1px solid var(--border);margin-top:var(--s-3);padding-top:var(--s-3)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:var(--s-2)">
          <div><b>Mejoras al playbook</b> <span class="muted" style="font-size:12px">la IA las propone, las aprobás vos</span></div>
          <button class="btn btn-ghost" id="btn-gen-improvements" onclick="generateImprovements(this)">✨ Generar ahora</button>
        </div>
        <div id="copilot-improvements"><div class="muted" style="font-size:12px">cargando…</div></div>
      </div>
    </div>

    <div class="card" style="margin-bottom:var(--s-4)">
      <div class="card-h">
        <h3>Costos del sitio</h3>
        <span class="muted" style="font-size:12px">gasto mensual · la IA se mide sola</span>
      </div>
      <div id="costs-panel"><div class="loading"><div class="spinner"></div></div></div>
    </div>

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

// Parámetros de CALIBRACIÓN de la fórmula nueva (editables, viven en D1).
// Los COGS (costo m², neón, divisor) NO están acá — salen del Excel y se
// muestran aparte (read-only). Los params viejos van en COT_PARAM_GROUPS_LEGACY.
const COT_PARAM_GROUPS = [
  { title: 'Fuente (por cm de neón)', keys: [
    ['nv_fuente_corto', 'cm ≤ 500'],
    ['nv_fuente_medio', '500 – 1200'],
    ['nv_fuente_largo', 'cm ≥ 1200']
  ]},
  { title: 'Margen por tamaño', keys: [
    ['nv_margen_chico', 'Margen cartel chico (0.68 = 68%)'],
    ['nv_margen_grande', 'Margen cartel grande (0.51 = 51%)'],
    ['nv_cf_ref_chico', 'CF referencia chico ($)'],
    ['nv_cf_ref_grande', 'CF referencia grande ($)']
  ]},
  { title: 'Complejidad (densidad tramos/m)', keys: [
    ['nv_complejidad_coef', 'Coeficiente (0.018)'],
    ['nv_complejidad_pivote', 'Pivote densidad (1.4)'],
    ['nv_complejidad_tope', 'Tope ± (0.04)']
  ]},
  { title: 'Topes y negro', keys: [
    ['nv_margen_min', 'Margen mínimo (0.48 = 48%)'],
    ['nv_margen_max', 'Margen máximo (0.72 = 72%)'],
    ['nv_negro_ratio', 'Negro × transparente (0.93)']
  ]},
  { title: 'Extra por exterior (EXT)', keys: [
    ['ext_25', 'm² ≤ 25'],
    ['ext_50', 'm² ≤ 50'],
    ['ext_99', 'm² > 50']
  ]}
];

// Params de la fórmula VIEJA — quedan accesibles colapsados por si se reactiva.
const COT_PARAM_GROUPS_LEGACY = [
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
  { title: 'Multiplicadores (viejos)', keys: [
    ['reventa_mult', 'Reventa × trans'],
    ['comision_pct', 'Comisión (decimal: 0.05 = 5%)'],
    ['descuento_mult', 'Descuento × trans'],
    ['descuento_min_m2', 'Descuento aplica si m² >'],
    ['recargo_5', 'Recargo (m² ≤ 5) ×'],
    ['recargo_125', 'Recargo (m² ≤ 12.5) ×'],
    ['recargo_25', 'Recargo (m² < 25) ×']
  ]}
];

const MESES_ES = ['', 'enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

// Bloque read-only con los COGS leídos del Excel 2026v4 + el desglose de cómo
// se arman los params de la fórmula nueva. Botón para refrescar al instante.
function renderCogsBlock() {
  const cogs = STATE.cotizadorCogs;
  const err = STATE.cotizadorCogsError;
  const p = getCotizadorParams();
  const fmtPct = v => (v != null ? (Number(v) * 100).toFixed(1).replace('.0', '') + '%' : '—');
  const raw = cogs && cogs.raw;
  const mesTxt = cogs && cogs.mes ? (MESES_ES[cogs.mes] || ('mes ' + cogs.mes)) : '—';
  const ageTxt = cogs && cogs.fetchedAt
    ? 'leído ' + relativeTime(new Date(cogs.fetchedAt).toISOString()) + (cogs.cached ? ' · cache' : '')
    : '';
  return `
    <div class="cot-params-group" style="border:1px solid rgba(143,212,222,.25);border-radius:var(--r-sm);padding:var(--s-3);background:rgba(143,212,222,.03)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--s-2)">
        <div class="cot-params-title" style="margin:0;color:var(--accent-cyan)">💎 COGS reales — del Excel 2026v4 · hoja COGS</div>
        <button class="btn btn-ghost" id="cogs-refresh" style="font-size:12px;padding:4px 10px">🔄 Refrescar</button>
      </div>
      ${err ? `<div style="font-size:11px;color:#FFA726;margin-bottom:var(--s-2)">⚠ No se pudo leer el Excel (${escapeHtml(String(err))}). Usando valores por defecto del código.</div>` : ''}
      ${raw ? `
        <div style="font-size:11px;color:var(--fg-mute);margin-bottom:var(--s-2)">Mes: <b style="color:var(--fg-subtle)">${mesTxt}</b> · ${ageTxt}</div>
        <div class="cot-params-grid">
          <label class="cot-param"><span>Costo acrílico transparente (m²)</span><input type="text" value="${fmtMoney(raw.costo_acrilico_trans||0)}" readonly style="opacity:.75"></label>
          <label class="cot-param"><span>m² imaginario (venta trans)</span><input type="text" value="${fmtMoney(raw.venta_trans_imaginario||0)}" readonly style="opacity:.75"></label>
          <label class="cot-param"><span>Anibal</span><input type="text" value="${fmtPct(raw.anibal)}" readonly style="opacity:.75"></label>
          <label class="cot-param"><span>Emma</span><input type="text" value="${fmtPct(raw.emma)}" readonly style="opacity:.75"></label>
          <label class="cot-param"><span>Costo neón (mt)</span><input type="text" value="${fmtMoney(raw.costo_neon_mt||0)}" readonly style="opacity:.75"></label>
          <label class="cot-param"><span>Mano de obra</span><input type="text" value="${fmtPct(raw.mano_obra)}" readonly style="opacity:.75"></label>
          <label class="cot-param"><span>Comisión Joaquín</span><input type="text" value="${fmtPct(raw.joaquin)}" readonly style="opacity:.75"></label>
        </div>
        <div style="margin-top:var(--s-2);padding:8px 12px;background:rgba(143,212,222,.06);border-radius:var(--r-sm);font-size:12px;color:var(--fg-subtle);font-family:ui-monospace,monospace">
          → Costo por m² combinado: <b style="color:var(--accent-cyan)">${fmtMoney(p.nv_costo_m2)}</b>
          &nbsp;·&nbsp; Costo neón: <b style="color:var(--accent-cyan)">${fmtMoney(p.nv_costo_neon_mt)}/mt</b>
          &nbsp;·&nbsp; Divisor: <b style="color:var(--accent-cyan)">${(+p.nv_divisor_base).toFixed(3)}</b>
        </div>
      ` : `<div style="font-size:12px;color:var(--fg-mute);padding:var(--s-2)">Cargando COGS del Excel… (si no aparece, revisá que el Apps Script tenga <code>action=cogs</code>)</div>`}
    </div>
  `;
}

function renderAdminCotizador() {
  const p = getCotizadorParams();
  const usandoNueva = !!p.transicionUseNueva;
  return `
    <div class="card" style="margin-bottom:var(--s-4)">
      <div class="card-h">
        <h3>Parámetros del cotizador</h3>
        <span class="muted" style="font-size:11px">${usandoNueva ? '⚡ fórmula nueva activa' : 'fórmula vieja activa'} · ${STATE.cotizadorParams ? 'D1' : 'defaults'}</span>
      </div>

      ${renderCogsBlock()}

      <div style="font-size:11px;color:var(--fg-mute);margin:var(--s-3) 0 var(--s-1)">CALIBRACIÓN — fórmula nueva (editable)</div>
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
        <button class="btn btn-primary" data-cot-save>💾 Guardar calibración</button>
        <button class="btn btn-ghost" data-cot-reset>Resetear a defaults</button>
        <span id="cot-save-msg" class="muted" style="font-size:12px"></span>
      </div>

      <details style="margin-top:var(--s-4)">
        <summary style="cursor:pointer;font-size:11px;color:var(--fg-mute);user-select:none">⚙ Parámetros de la fórmula VIEJA (legacy — no afectan el precio mientras la nueva esté activa)</summary>
        <div style="margin-top:var(--s-2)">
          ${COT_PARAM_GROUPS_LEGACY.map(g => `
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
        </div>
      </details>
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
  const privacyBtn = document.querySelector('[data-privacy-toggle]');
  if (privacyBtn) privacyBtn.onclick = () => togglePrivacy();
}
function bindCommon() {
  // Paste de imágenes en el modal "Nuevo brief" cuando está abierto FUERA de la
  // vista Cotización (ej. sobre el chat). En Cotización lo maneja el paste propio
  // de ese view. Global + guardado por flag: se bindea una sola vez para toda la app.
  if (!document._quickModalPasteBound) {
    document.addEventListener('paste', async (ev) => {
      if (!STATE.quickModalOpen || STATE.view === 'cotizacion') return;
      const items = ev.clipboardData?.items || [];
      const files = [];
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) { ev.preventDefault(); await addFilesToQuickModal(files); }
    });
    document._quickModalPasteBound = true;
  }
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

// ===== Modales NEON (reemplazan alert/confirm nativos) =====
function _modalRender({ message, title, variant, confirmLabel, cancelLabel, withCancel }) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  const variantClass = variant ? ` modal--${variant}` : '';
  const titleHtml = title ? `<div class="modal-h"><h3>${escapeHtml(title)}</h3></div>` : '';
  const bodyHtml = escapeHtml(String(message || '')).replace(/\n/g, '<br>');
  const cancelBtn = withCancel ? `<button class="btn btn-ghost modal-cancel">${escapeHtml(cancelLabel || 'Cancelar')}</button>` : '';
  bg.innerHTML = `
    <div class="modal${variantClass}">
      ${titleHtml}
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-actions">
        ${cancelBtn}
        <button class="btn btn-cyan modal-confirm">${escapeHtml(confirmLabel || 'Aceptar')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(bg);
  // animar entrada en el siguiente tick
  void bg.offsetWidth; bg.classList.add('open'); requestAnimationFrame(() => bg.classList.add('open'));
  return bg;
}

function showAlert(message, opts) {
  return new Promise(resolve => {
    const variant = opts?.variant || (/⚠|fallaron|fall(ó|o)|inv(á|a)lido|error/i.test(String(message)) ? 'warn' : null);
    const bg = _modalRender({
      message,
      title: opts?.title,
      variant,
      confirmLabel: opts?.confirmLabel,
      withCancel: false
    });
    const close = () => {
      bg.classList.remove('open');
      setTimeout(() => bg.remove(), 150);
      document.removeEventListener('keydown', onKey);
      resolve();
    };
    function onKey(e) { if (e.key === 'Escape' || e.key === 'Enter') close(); }
    bg.querySelector('.modal-confirm').onclick = close;
    bg.addEventListener('click', e => { if (e.target === bg) close(); });
    document.addEventListener('keydown', onKey);
    setTimeout(() => bg.querySelector('.modal-confirm')?.focus(), 0);
  });
}

function showConfirm(message, opts) {
  return new Promise(resolve => {
    const bg = _modalRender({
      message,
      title: opts?.title,
      variant: opts?.variant,
      confirmLabel: opts?.confirmLabel || 'Confirmar',
      cancelLabel: opts?.cancelLabel || 'Cancelar',
      withCancel: true
    });
    const finish = (val) => {
      bg.classList.remove('open');
      setTimeout(() => bg.remove(), 150);
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    function onKey(e) {
      if (e.key === 'Escape') finish(false);
      else if (e.key === 'Enter') finish(true);
    }
    bg.querySelector('.modal-confirm').onclick = () => finish(true);
    bg.querySelector('.modal-cancel').onclick = () => finish(false);
    bg.addEventListener('click', e => { if (e.target === bg) finish(false); });
    document.addEventListener('keydown', onKey);
    setTimeout(() => bg.querySelector('.modal-confirm')?.focus(), 0);
  });
}

// Prompt de contraseña con la estética NEON (reemplaza el prompt() nativo del
// login). Resuelve con el texto ingresado, o null si se cancela.
function showPasswordPrompt(userName) {
  return new Promise(resolve => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    // El input + botones van DENTRO de un <form>: así el botón "Go/Ir" del teclado
    // de iOS dispara el submit (un input suelto no lo hace de forma confiable). Y
    // los botones van junto al campo (no en .modal-actions al fondo) porque en
    // mobile el modal es full-screen y el fondo queda tapado por el teclado / las
    // barras del 100vh de Safari — ahí no se veían.
    bg.innerHTML = `
      <div class="modal modal--login">
        <div class="modal-h"><h3>Iniciar sesión</h3></div>
        <div class="modal-body">
          <form class="login-form" novalidate>
            <label class="nc-field">
              <span class="nc-label">Contraseña de ${escapeHtml(userName || 'usuario')}</span>
              <input type="password" class="nc-input" autocomplete="current-password" placeholder="••••••••" enterkeyhint="go">
            </label>
            <button type="submit" class="btn btn-cyan modal-confirm" style="width:100%;margin-top:16px">Entrar</button>
            <button type="button" class="btn btn-ghost modal-cancel" style="width:100%;margin-top:8px">Cancelar</button>
          </form>
        </div>
      </div>`;
    document.body.appendChild(bg);
    void bg.offsetWidth; bg.classList.add('open'); requestAnimationFrame(() => bg.classList.add('open'));
    const input = bg.querySelector('input');
    const form = bg.querySelector('form');
    const finish = (val) => {
      bg.classList.remove('open');
      setTimeout(() => bg.remove(), 150);
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    function onKey(e) {
      if (e.key === 'Escape') finish(null);
    }
    // submit cubre: Enter en el input, botón "Go/Ir" del teclado iOS y click en "Entrar".
    form.addEventListener('submit', e => { e.preventDefault(); finish(input.value || null); });
    bg.querySelector('.modal-cancel').onclick = () => finish(null);
    bg.addEventListener('click', e => { if (e.target === bg) finish(null); });
    document.addEventListener('keydown', onKey);
    setTimeout(() => { if (input) input.focus(); }, 50);
  });
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
  quickReplies: [],   // [{id, shortcut, body, vertical}]
  qrLoaded: false,
  templates: [],      // plantillas aprobadas (para el menú /)
  tplLoaded: false,
  labels: [],         // [{id, name, color}]
  contactLabels: {},  // phone → [label_id, ...]
  labelsLoaded: false,
  filterLabels: [],   // active label filters (array of label_ids)
  filterUnreadOnly: false, // chip "No leídos" del top — muestra solo chats con unread > 0
  labelDropdownOpen: false, // dropdown de etiquetas (estilo WA Web)
  recording: false,
  mediaRecorder: null,
  audioChunks: [],
  recordingTimer: null,
  recordingSecs: 0,
  // Full-text search (busca en historial completo de mensajes, no solo el último)
  searchResults: { contacts: [], messages: [], q: '' },
  searchLoading: false,
  _searchTimer: null,
  highlightWamid: null, // wamid del mensaje a destacar al abrir un chat (de búsqueda)
  // Nombres de contacto sincronizados desde WhatsApp (tabla wa_contacts en D1).
  // Map phone → name. Tiene prioridad sobre sender_name al renderizar la lista.
  waContactNames: {},
  waContactPics: {},
  waContactUsernames: {},
  waContactNamesLoaded: false,
  // Ad attribution por contacto (Meta Click-to-WhatsApp). Map phone → attribution row.
  // Se carga lazy cuando seleccionás un chat. Si no hay attribution → null.
  adAttributions: {},
  // Mobile UX (≤768px): 'list' muestra solo el sidebar de contactos full-screen
  // (estilo WA), 'conversation' muestra solo la conversación con back arrow.
  // En desktop se ignora y siempre se muestra el split-view completo.
  mobileView: 'list',
  // Canal activo del chat: 'wa' (WhatsApp) | 'ig' (Instagram). Default WhatsApp.
  // Separa las dos bandejas — WhatsApp queda priorizado, IG aparte.
  channel: 'wa',
  // Windowing del sidebar: cuántos contactos pintamos en el DOM (hay 7000+).
  // Pintarlos a TODOS clava el main thread ~1-2s y deja el scroll/tipeo trabado
  // (cada contacto son ~14 nodos → 7000 = ~100k nodos). El scroll va sumando
  // de a CHAT_CONTACT_PAGE al acercarse al fondo. Los viejos se alcanzan buscando.
  contactRenderLimit: 50,
  _lastFilteredCount: 0,
};
// Tamaño de página del windowing del sidebar de chats.
const CHAT_CONTACT_PAGE = 50;

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
  const pic = (chatState.waContactPics && chatState.waContactPics[phone]) || '';

  // Base que queda SIEMPRE por debajo: iniciales (si hay nombre) o silueta.
  const base = hasName
    ? `<span class="chat-avatar-text" style="font-size:${fontSize}px">${initials}</span>`
    : `<div class="chat-avatar-icon">${WA_PERSON_SVG}</div>`;
  // Foto de perfil (hoy solo IG): se superpone. Si la URL venció (las de IG
  // caducan), onerror la quita y quedan las iniciales/silueta de abajo.
  const img = pic
    ? `<img src="${pic.replace(/"/g, '&quot;')}" loading="lazy" referrerpolicy="no-referrer" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block" onerror="this.remove()">`
    : '';
  return `<div class="chat-avatar" style="width:${s}px;height:${s}px;${bg};position:relative;overflow:hidden">${base}${img}</div>`;
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
// Carga las plantillas aprobadas para mostrarlas en el menú "/" junto a las respuestas.
async function loadChatTemplates() {
  if (chatState.tplLoaded) return;
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/templates', { headers: authHeaders() });
    if (r.ok) {
      const j = await r.json();
      const list = Array.isArray(j.templates) ? j.templates : [];
      chatState.templates = list.filter(t => String(t.status || '').toLowerCase() === 'approved' && t.name !== 'prueba_de_plantilla' && !String(t.name || '').startsWith('adhoc_'));
      chatState.tplLoaded = true;
    }
  } catch (_) {}
}
// Texto del body de una plantilla (de sus components) y cantidad de variables {{n}}.
function tplBodyText(t) {
  const comps = t && Array.isArray(t.components) ? t.components : [];
  const b = comps.find(c => String(c.type || '').toUpperCase() === 'BODY');
  return (b && b.text) || '';
}
function tplParamCount(t) {
  const m = tplBodyText(t).match(/\{\{\s*\d+\s*\}\}/g);
  return m ? m.length : 0;
}
// Si el body es el marcador "[plantilla: NOMBRE] p1, p2, …", devuelve el TEXTO
// REAL de esa plantilla con cada {{n}} reemplazada por el parámetro n-ésimo que
// se guardó al enviarla (el worker los une con ", "). Si NO se guardaron params
// (plantillas de 1 variable = nombre), cae al primer nombre del contacto. Si no
// encuentra la plantilla, un rótulo limpio. Si no es un marcador, el body tal cual.
function tplMarkerToText(body, phone) {
  const s = String(body || '');
  const mk = s.match(/^\[plantilla:\s*([a-z0-9_]+)\]\s*([\s\S]*)$/i);
  if (!mk) return s;
  const tpl = (chatState.templates || []).find(t => t.name === mk[1]);
  if (!tpl) return '📋 Plantilla enviada';
  const text = tplBodyText(tpl);
  const stored = (mk[2] || '').trim() ? mk[2].trim().split(', ') : [];
  if (stored.length) {
    // Reemplazo posicional: {{1}}→stored[0], {{2}}→stored[1], … (los valores reales enviados).
    return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => {
      const v = stored[parseInt(n, 10) - 1];
      return (v === undefined) ? m : v;
    });
  }
  // Sin params guardados (plantilla de 1 var = nombre): usar el primer nombre del contacto.
  const c = (chatState.contacts || []).find(x => x.phone === phone);
  const fn = ((c && c.name) || '').trim().split(/\s+/)[0] || 'amigo/a';
  return text.replace(/\{\{\s*\d+\s*\}\}/g, fn);
}
// Vertical de una plantilla según su nombre (cursos_* / sorteo / clase → cursos).
function templateVertical(name) {
  const n = String(name || '').toLowerCase();
  return (n.startsWith('cursos') || n.includes('sorteo') || n.includes('clase')) ? 'cursos' : 'carteles';
}
// Verticales visibles para el usuario actual (null = todas). Joaco→carteles, Abril→cursos, Gaspar→todas.
function qrVerticalsForUser() {
  if (isCursosUser(STATE.user)) return ['cursos'];
  if (isGasparUser(STATE.user)) return null;
  return ['carteles'];
}
// Manda una plantilla aprobada al chat actual (reabre conversaciones de +24h).
async function sendTemplateToChat(phone, name, lang, params) {
  const r = await fetch(CONFIG.trackerUrl + '/admin/wa/template', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ to: phone, name, lang: lang || 'es_AR', params: params || [] })
  });
  return r.ok ? await r.json() : { ok: false };
}

// ===== Nuevo chat a un número que no está en contactos =====
// Como el número es nuevo (fuera de la ventana de 24h de WhatsApp), el primer
// mensaje OBLIGATORIAMENTE tiene que ser una plantilla aprobada. Dos entradas:
// el botón "+" del header y la barra de búsqueda (al pegar un teléfono).

// ¿El texto parece un número de teléfono? (solo dígitos/símbolos y >= 8 dígitos).
function looksLikePhone(s) {
  const raw = String(s || '').trim();
  if (!raw) return false;
  if (!/^[\d\s()+.\-]+$/.test(raw)) return false; // si tiene letras, es búsqueda por nombre
  return raw.replace(/\D/g, '').length >= 8;
}

// Muestra/oculta el botón "Chatear con +54…" debajo de la barra de búsqueda.
function updateNewChatSuggest(value) {
  const box = document.getElementById('new-chat-suggest');
  if (!box) return;
  if (!looksLikePhone(value)) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const norm = normalizeArPhoneFE(value);
  const exists = (chatState.contacts || []).some(c => c.phone === norm);
  box.style.display = 'block';
  box.innerHTML = `<button type="button" class="new-chat-suggest-btn" id="new-chat-suggest-btn">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9h-3v3h-2v-3h-3V9h3V6h2v3h3v2z"/></svg>
      <span><strong>Chatear</strong> con ${escapeHtml(formatPhoneDisplay(norm))}${exists ? ' <span class="nc-exists">· ya tenés un chat</span>' : ''}</span>
    </button>`;
  const btn = document.getElementById('new-chat-suggest-btn');
  if (btn) btn.onclick = () => {
    if (exists) {
      // Ya existe → abrir el chat directamente (no hace falta plantilla).
      const si = document.getElementById('chat-search'); if (si) si.value = '';
      chatState.search = ''; updateNewChatSuggest('');
      selectChatContact(norm);
    } else {
      showNewChatModal(norm);
    }
  };
}

// Modal para arrancar un chat nuevo con una plantilla aprobada.
function showNewChatModal(prefillPhone) {
  document.getElementById('new-chat-modal')?.remove();
  loadChatTemplates(); // idempotente
  const verts = qrVerticalsForUser(); // null = admin ve todas
  const tpls = (chatState.templates || []).filter(t => !verts || verts.includes(templateVertical(t.name)));
  const tplRows = tpls.map(t => _renderTplItem(t)).join('') || '<div class="nc-empty">No hay plantillas aprobadas para tu vertical.</div>';
  const bg = document.createElement('div');
  bg.id = 'new-chat-modal';
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal new-chat-modal" style="max-width:460px;width:92vw">
      <div class="modal-h"><h3>Nuevo chat</h3></div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:14px">
        <div class="nc-note">Es un número nuevo, fuera de la ventana de 24 h: el primer mensaje tiene que salir como <strong>plantilla</strong>.</div>
        <label class="nc-field">
          <span class="nc-label">Número de teléfono</span>
          <input type="tel" id="nc-phone" class="nc-input" placeholder="11 2345-6789" value="${escapeHtml(prefillPhone || '')}" autocomplete="off">
          <span class="nc-hint" id="nc-hint"></span>
        </label>
        <div style="display:flex;gap:6px">
          <button type="button" class="btn btn-cyan nc-mode-btn" data-mode="tpl">Elegir plantilla</button>
          <button type="button" class="btn btn-ghost nc-mode-btn" data-mode="msg">Escribir mensaje</button>
        </div>
        <div id="nc-mode-tpl">
          <div class="nc-field">
            <span class="nc-label">Plantilla de inicio · sale al instante</span>
            <div class="nc-tpl-list" id="nc-tpl-list">${tplRows}</div>
          </div>
          <label class="nc-field" id="nc-name-field" style="display:none">
            <span class="nc-label">Nombre (reemplaza {{1}} en la plantilla)</span>
            <input type="text" id="nc-name" class="nc-input" placeholder="amigo/a" autocomplete="off">
          </label>
          <div class="nc-field" id="nc-preview-field" style="display:none">
            <span class="nc-label">Vista previa — así se manda</span>
            <div class="nc-preview" id="nc-preview"></div>
          </div>
        </div>
        <div id="nc-mode-msg" style="display:none">
          <div class="nc-field">
            <span class="nc-label">Mensaje nuevo · sale como plantilla</span>
            <textarea id="nc-msg-body" class="nc-input" placeholder="Escribí el mensaje… ej: Hola! Te escribo de Neon Infinito por tu consulta, cualquier cosa quedo a disposición" rows="4" style="resize:vertical"></textarea>
            <div id="nc-msg-warn" style="color:#ff6b6b;font-size:12px;min-height:16px;margin:4px 0"></div>
            <div style="font-size:12px;color:var(--fg-subtle,#8696a0);line-height:1.6">Se crea como plantilla: Meta la aprueba en unos minutos y ahí se manda sola. 🚫 Sin links en el texto · 🚫 Sin teléfonos · 🚫 Sin MAYÚSCULAS.</div>
          </div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost modal-cancel" type="button">Cancelar</button>
        <button class="btn btn-cyan" id="nc-send" type="button" disabled>Chatear</button>
      </div>
    </div>`;
  document.body.appendChild(bg);
  void bg.offsetWidth; bg.classList.add('open'); requestAnimationFrame(() => bg.classList.add('open'));

  const phoneEl = bg.querySelector('#nc-phone');
  const listEl = bg.querySelector('#nc-tpl-list');
  const nameField = bg.querySelector('#nc-name-field');
  const nameEl = bg.querySelector('#nc-name');
  const hintEl = bg.querySelector('#nc-hint');
  const sendBtn = bg.querySelector('#nc-send');
  const previewField = bg.querySelector('#nc-preview-field');
  const previewEl = bg.querySelector('#nc-preview');
  const modeTplEl = bg.querySelector('#nc-mode-tpl');
  const modeMsgEl = bg.querySelector('#nc-mode-msg');
  const msgBodyEl = bg.querySelector('#nc-msg-body');
  const msgWarnEl = bg.querySelector('#nc-msg-warn');
  const modeBtns = Array.from(bg.querySelectorAll('.nc-mode-btn'));

  // Dos modos: 'tpl' = elegir plantilla ya aprobada (sale al instante);
  // 'msg' = escribir un mensaje nuevo que sale como plantilla (create-send, lo aprueba Meta).
  let mode = 'tpl';
  let selectedName = null, selectedLang = 'es_AR', selectedParams = 0;

  const close = () => bg.remove();
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  bg.querySelector('.modal-cancel').onclick = close;

  function refresh() {
    const norm = normalizeArPhoneFE(phoneEl.value);
    const phoneOk = norm.length >= 12; // 549 + área + número
    if (!phoneEl.value.trim()) { hintEl.textContent = ''; hintEl.className = 'nc-hint'; }
    else if (phoneOk) {
      const exists = (chatState.contacts || []).some(c => c.phone === norm);
      hintEl.innerHTML = `Se enviará a <strong>${escapeHtml(formatPhoneDisplay(norm))}</strong>${exists ? ' · <span class="nc-exists">ya tenés un chat con este número</span>' : ''}`;
      hintEl.className = 'nc-hint ok';
    } else { hintEl.textContent = 'Número inválido — revisá el código de área.'; hintEl.className = 'nc-hint err'; }
    if (mode === 'tpl') {
      nameField.style.display = (selectedName && selectedParams >= 1) ? '' : 'none';
      const tpl = selectedName ? (chatState.templates || []).find(t => t.name === selectedName) : null;
      if (tpl) {
        const fn = (nameEl.value || '').trim() || 'amigo/a';
        previewEl.textContent = tplBodyText(tpl).replace(/\{\{\s*\d+\s*\}\}/g, fn);
        previewField.style.display = '';
      } else { previewField.style.display = 'none'; }
      sendBtn.textContent = 'Chatear';
      sendBtn.disabled = !(phoneOk && selectedName);
    } else {
      const text = (msgBodyEl.value || '').trim();
      const err = text ? validateAdhocTemplateClient(text) : '';
      msgWarnEl.textContent = text ? (err || '') : '';
      sendBtn.textContent = 'Crear y mandar';
      sendBtn.disabled = !(phoneOk && text && !err);
    }
  }

  modeBtns.forEach(b => { b.onclick = () => {
    mode = b.dataset.mode;
    modeBtns.forEach(x => { x.className = 'btn nc-mode-btn ' + (x.dataset.mode === mode ? 'btn-cyan' : 'btn-ghost'); });
    modeTplEl.style.display = mode === 'tpl' ? '' : 'none';
    modeMsgEl.style.display = mode === 'msg' ? '' : 'none';
    refresh();
    if (mode === 'msg') setTimeout(() => msgBodyEl.focus(), 20);
  }; });

  // Rows del listado: elegir una plantilla (resalta).
  listEl.querySelectorAll('.qr-item').forEach(row => {
    row.onclick = () => {
      if (!row.dataset.tplName) return;
      selectedName = row.dataset.tplName;
      selectedLang = row.dataset.tplLang || 'es_AR';
      selectedParams = parseInt(row.dataset.tplParams || '0', 10) || 0;
      listEl.querySelectorAll('.qr-item').forEach(r => r.classList.remove('nc-selected'));
      row.classList.add('nc-selected');
      refresh();
    };
  });

  phoneEl.addEventListener('input', refresh);
  nameEl.addEventListener('input', refresh);
  msgBodyEl.addEventListener('input', refresh);
  refresh();
  setTimeout(() => phoneEl.focus(), 30);

  sendBtn.onclick = async () => {
    const norm = normalizeArPhoneFE(phoneEl.value);
    if (!norm || norm.length < 12) return;
    if (mode === 'tpl') {
      // Plantilla ya aprobada → sale al instante.
      if (!selectedName) return;
      const params = selectedParams >= 1 ? [((nameEl.value || '').trim() || 'amigo/a')] : [];
      sendBtn.disabled = true; sendBtn.textContent = 'Enviando…';
      const j = await sendTemplateToChat(norm, selectedName, selectedLang, params);
      if (j && j.id) {
        toast('✓ Plantilla enviada');
        close();
        const si = document.getElementById('chat-search'); if (si) si.value = '';
        chatState.search = ''; updateNewChatSuggest('');
        await selectChatContact(norm); // abre la conversación con el mensaje de la plantilla
        loadChatContacts().then(() => { if (STATE.view === 'chat') refreshContactList(); });
      } else {
        toast('Error al enviar la plantilla');
        sendBtn.disabled = false; sendBtn.textContent = 'Chatear';
      }
    } else {
      // Mensaje nuevo → se crea como plantilla (Meta la aprueba y se manda sola).
      const text = (msgBodyEl.value || '').trim();
      const err = validateAdhocTemplateClient(text);
      if (err) { msgWarnEl.textContent = err; return; }
      sendBtn.disabled = true; sendBtn.textContent = 'Creando…';
      try {
        const r = await fetch(CONFIG.trackerUrl + '/admin/wa/template-create-send', {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ to: norm, body_text: text })
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.ok) {
          toast(j.reused ? '✓ Mensaje enviado (se reusó una plantilla ya aprobada).' : '✓ Plantilla creada. Se manda sola cuando Meta la apruebe (unos min).');
          close();
          const si = document.getElementById('chat-search'); if (si) si.value = '';
          chatState.search = ''; updateNewChatSuggest('');
        } else {
          msgWarnEl.textContent = j.error || 'No se pudo crear la plantilla';
          sendBtn.disabled = false; sendBtn.textContent = 'Crear y mandar';
        }
      } catch (e) {
        msgWarnEl.textContent = 'Error: ' + (e.message || e);
        sendBtn.disabled = false; sendBtn.textContent = 'Crear y mandar';
      }
    }
  };
}
async function saveQuickReply(shortcut, body, mediaR2Key, vertical) {
  await fetch(CONFIG.trackerUrl + '/admin/quick-replies', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ shortcut, body, media_r2_key: mediaR2Key || null, vertical: vertical || 'carteles' })
  });
  chatState.qrLoaded = false;
  await loadQuickReplies();
}
async function uploadQuickReplyImage(file) {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch(CONFIG.trackerUrl + '/admin/quick-replies/upload', {
    method: 'POST',
    headers: authHeaders(),
    body: fd
  });
  if (!r.ok) throw new Error('upload failed');
  const j = await r.json();
  return j.r2_key;
}
async function sendQuickReplyToChat(phone, qrId) {
  const r = await fetch(CONFIG.trackerUrl + '/admin/wa/send-quick-reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ phone, qr_id: qrId })
  });
  return r.ok ? await r.json() : { ok: false };
}
async function deleteQuickReply(id) {
  await fetch(CONFIG.trackerUrl + '/admin/quick-replies/' + id, { method: 'DELETE', headers: authHeaders() });
  chatState.quickReplies = chatState.quickReplies.filter(q => q.id !== id);
}

// ===== WA Contact Names (snapshot histórico, sincronizado en su momento desde la agenda del 6573) =====
async function loadWaContactNames() {
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/contacts', { headers: authHeaders() });
    if (!r.ok) return;
    const j = await r.json();
    const map = {};
    const pics = {};
    const usernames = {};
    for (const c of (j.contacts || [])) {
      if (c?.phone && c?.name) map[c.phone] = c.name;
      if (c?.phone && c?.pic_url) pics[c.phone] = c.pic_url;
      if (c?.phone && c?.username) usernames[c.phone] = c.username;
    }
    chatState.waContactNames = map;
    chatState.waContactPics = pics;
    chatState.waContactUsernames = usernames;
    chatState.waContactNamesLoaded = true;
    // Si ya hay contactos cargados, re-aplicar los nombres
    if (chatState.contacts.length) {
      for (const c of chatState.contacts) {
        const wn = map[c.phone];
        if (wn) c.name = wn;
      }
    }
  } catch (_) {}
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

// ===== Notas por contacto =====
async function loadAllNotes() {
  if (chatState.notesLoaded) return;
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/contact-notes', { headers: authHeaders() });
    if (r.ok) {
      const j = await r.json();
      const map = {};
      for (const n of (j.notes || [])) map[n.phone] = n.note;
      chatState.notes = map;
      chatState.notesLoaded = true;
    }
  } catch (_) {}
}
function getContactNote(phone) {
  return (chatState.notes && chatState.notes[phone]) || '';
}
async function saveContactNote(phone, note) {
  const r = await fetch(CONFIG.trackerUrl + '/admin/contact-notes', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ phone, note })
  });
  if (r.ok) {
    if (!chatState.notes) chatState.notes = {};
    if (note && note.trim()) chatState.notes[phone] = note;
    else delete chatState.notes[phone];
    return true;
  }
  return false;
}
async function markChatUnread(phone) {
  const r = await fetch(CONFIG.trackerUrl + '/admin/wa/mark-unread', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ phone })
  });
  return r.ok;
}

// ===== Archivado de chats =====
async function loadArchivedChats() {
  if (chatState.archivedLoaded) return;
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/archived', { headers: authHeaders() });
    if (r.ok) {
      const j = await r.json();
      chatState.archived = new Set(j.phones || []);
      chatState.archivedLoaded = true;
    }
  } catch (_) {}
}
async function archiveChat(phone) {
  const r = await fetch(CONFIG.trackerUrl + '/admin/wa/archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ phone })
  });
  if (r.ok) {
    if (!chatState.archived) chatState.archived = new Set();
    chatState.archived.add(phone);
    return true;
  }
  return false;
}
async function unarchiveChat(phone) {
  const r = await fetch(CONFIG.trackerUrl + '/admin/wa/archive?phone=' + encodeURIComponent(phone), {
    method: 'DELETE',
    headers: authHeaders()
  });
  if (r.ok) {
    chatState.archived?.delete(phone);
    return true;
  }
  return false;
}
function isArchived(phone) {
  return chatState.archived ? chatState.archived.has(phone) : false;
}
async function saveLabel(name, color) {
  const r = await fetch(CONFIG.trackerUrl + '/admin/labels', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ name, color })
  });
  let j = {}; try { j = await r.json(); } catch (_) {}
  if (!r.ok) throw new Error(j.error || ('No se pudo crear la etiqueta (HTTP ' + r.status + ')'));
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
  const lbl = chatState.labels.find(l => l.id === labelId);
  const lblName = lbl?.name || 'etiqueta';
  const removing = current.includes(labelId);
  // OPTIMISTA: actualizamos estado + UI YA; la persistencia va en segundo plano.
  // Aunque el back tarde, el toggle vuela. Si el back falla, revertimos y avisamos.
  chatState.contactLabels[phone] = removing ? current.filter(id => id !== labelId) : [...current, labelId];
  toast(removing ? `✗ ${lblName}` : `✓ ${lblName}`);
  fetch(CONFIG.trackerUrl + '/admin/contact-labels', {
    method: removing ? 'DELETE' : 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ phone, label_id: labelId })
  }).then(r => { if (!r.ok) throw new Error('http ' + r.status); }).catch(() => {
    // rollback: el back no guardó
    const cur = chatState.contactLabels[phone] || [];
    chatState.contactLabels[phone] = removing ? [...cur, labelId] : cur.filter(id => id !== labelId);
    toast('⚠ No se pudo guardar la etiqueta, reintentá');
    if (chatState.selectedPhone === phone) {
      const chips = document.getElementById('chat-label-chips');
      if (chips) chips.innerHTML = renderContactLabelChips(phone);
      const vb = document.getElementById('btn-venta-abril');
      if (vb && labelId === VENTA_ABRIL_LABEL_ID) {
        const has = (chatState.contactLabels[phone] || []).includes(VENTA_ABRIL_LABEL_ID);
        vb.classList.toggle('btn-cyan', has); vb.classList.toggle('btn-ghost', !has);
        vb.innerHTML = has ? '✅ Venta Abril' : '💰 Venta Abril';
      }
    }
  });
}

// Animación tipo casino (monedas + confeti + frase random) cuando Abril marca una
// venta. Todo CSS (GPU), sin loop de JS, y se autolimpia a los ~3s → no ralentiza.
function ventaAbrilCelebration() {
  if (document.getElementById('va-celebration')) return; // no solapar
  if (!document.getElementById('va-anim-css')) {
    const st = document.createElement('style');
    st.id = 'va-anim-css';
    st.textContent = '@keyframes vaFall{0%{transform:translateY(-15vh) rotate(0)}100%{transform:translateY(115vh) rotate(720deg)}}@keyframes vaPop{0%{transform:translate(-50%,-50%) scale(.3);opacity:0}12%{transform:translate(-50%,-50%) scale(1.18);opacity:1}72%{transform:translate(-50%,-50%) scale(1);opacity:1}100%{transform:translate(-50%,-50%) scale(1.06);opacity:0}}#va-celebration{position:fixed;inset:0;z-index:99999;pointer-events:none;overflow:hidden}#va-celebration .va-p{position:absolute;top:0;will-change:transform;animation:vaFall linear forwards}#va-celebration .va-msg{position:absolute;left:50%;top:42%;transform:translate(-50%,-50%);text-align:center;font-weight:900;font-size:clamp(26px,7vw,64px);line-height:1.1;color:#fff;text-shadow:0 0 12px var(--neon-cyan,#8fd4de),0 0 26px var(--neon-cyan,#8fd4de),0 0 40px #22c55e;animation:vaPop 2.6s cubic-bezier(.2,.8,.2,1) forwards;max-width:92vw}';
    document.head.appendChild(st);
  }
  const FRASES = ['¡GENIA TOTAL, ABRI! 💸','¡Otra que cae, sos una máquina! 🔥','¡Vendiste, reina! 👑','¡Se prende otro neón! ✨','¡Comisión asegurada, capa! 💰','¡Imparable, Abri! 🚀','¡Otra venta al infinito! ♾️','¡La rompiste toda! 💪','¡Máquina de vender, grosa! 🤑','¡Bien ahí, crack! 🙌','¡Que siga la joda! 🎉','¡A cobrar, campeona! 💵'];
  const EMO = ['🪙','💰','🎉','✨','💵','🤑','⭐','💚','🎊'];
  const COLORS = ['#22c55e','#8fd4de','#ffd23f','#ff5a6e','#c4a0ff','#ffa94d'];
  const wrap = document.createElement('div');
  wrap.id = 'va-celebration';
  let html = `<div class="va-msg">${FRASES[Math.floor(Math.random()*FRASES.length)]}</div>`;
  for (let i = 0; i < 42; i++) {
    const left = Math.random()*100, dur = 1.8+Math.random()*1.6, delay = Math.random()*0.7;
    if (Math.random() < 0.62) {
      const size = 18+Math.random()*26;
      html += `<span class="va-p" style="left:${left}vw;font-size:${size}px;animation-duration:${dur}s;animation-delay:${delay}s">${EMO[Math.floor(Math.random()*EMO.length)]}</span>`;
    } else {
      const c = COLORS[Math.floor(Math.random()*COLORS.length)], w = 8+Math.random()*8;
      html += `<span class="va-p" style="left:${left}vw;width:${w}px;height:${(w*1.6).toFixed(1)}px;background:${c};border-radius:2px;box-shadow:0 0 8px ${c};animation-duration:${dur}s;animation-delay:${delay}s"></span>`;
    }
  }
  wrap.innerHTML = html;
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 3100);
}

// ===== Send media =====
async function sendChatImage(phone, file, caption) {
  return sendChatFile(phone, file, caption);
}

// Wrapper para mandar múltiples files al chat seleccionado, en serie con
// delay anti rate-limit. Se usa desde paste, drag-drop y file input.
// Antes de enviar, muestra un modal de preview con caption + cancelar.
async function sendChatFiles(files) {
  const phone = chatState.selectedPhone;
  if (!phone || !files.length) return;
  const result = await showMediaPreviewModal(files);
  if (!result) return; // cancelado
  const { files: finalFiles, caption } = result;
  if (!finalFiles.length) return;
  if (finalFiles.length === 1) { await sendChatFile(phone, finalFiles[0], caption); return; }
  toast(`Enviando ${finalFiles.length} archivos…`);
  let sent = 0;
  for (let i = 0; i < finalFiles.length; i++) {
    const f = finalFiles[i];
    // Caption va solo en el primero (igual que WA Web).
    const cap = i === 0 ? caption : '';
    try { await sendChatFile(phone, f, cap); sent++; } catch (_) {}
    await new Promise(r => setTimeout(r, 400));
  }
  toast(`✓ ${sent}/${finalFiles.length} enviados`);
}

// Modal de preview de media antes de enviar (estilo WA Web).
// Devuelve { files, caption } al confirmar, o null si se cancela.
function showMediaPreviewModal(initialFiles) {
  return new Promise((resolve) => {
    document.getElementById('media-preview-modal')?.remove();
    let files = [...initialFiles];
    let activeIdx = 0;
    const bg = document.createElement('div');
    bg.id = 'media-preview-modal';
    bg.className = 'modal-bg';
    bg.innerHTML = `
      <div class="modal media-preview-modal" style="max-width:680px;width:92vw">
        <div class="modal-h" style="display:flex;align-items:center;gap:10px">
          <h3 style="flex:1">Vista previa</h3>
          <button class="btn btn-ghost mp-cancel" title="Cancelar (Esc)">✕</button>
        </div>
        <div class="modal-body" style="padding:0;display:flex;flex-direction:column;gap:0">
          <div class="mp-stage" id="mp-stage"></div>
          <div class="mp-thumbs" id="mp-thumbs"></div>
          <div class="mp-caption-wrap">
            <input type="text" id="mp-caption" placeholder="Agregar un mensaje (opcional)" autocomplete="off" maxlength="1024">
          </div>
        </div>
        <div class="modal-actions">
          <span id="mp-meta" style="margin-right:auto;color:var(--fg-subtle);font-size:12px"></span>
          <button class="btn btn-ghost mp-cancel">Cancelar</button>
          <button class="btn btn-cyan" id="mp-send">Enviar</button>
        </div>
      </div>
    `;
    document.body.appendChild(bg);
    void bg.offsetWidth; bg.classList.add('open'); requestAnimationFrame(() => bg.classList.add('open'));

    const stage = bg.querySelector('#mp-stage');
    const thumbs = bg.querySelector('#mp-thumbs');
    const meta = bg.querySelector('#mp-meta');
    const captionInput = bg.querySelector('#mp-caption');

    const fmtBytes = (b) => b < 1024 ? b + ' B' : b < 1024 * 1024 ? (b / 1024).toFixed(1) + ' KB' : (b / 1024 / 1024).toFixed(2) + ' MB';

    const renderStage = () => {
      const f = files[activeIdx];
      if (!f) { stage.innerHTML = '<div class="mp-empty">Sin archivos</div>'; meta.textContent = ''; return; }
      const m = (f.type || '').toLowerCase();
      let inner = '';
      if (m.startsWith('image/')) {
        inner = `<img src="${URL.createObjectURL(f)}" alt="${escapeHtml(f.name || '')}">`;
      } else if (m.startsWith('video/')) {
        inner = `<video controls src="${URL.createObjectURL(f)}"></video>`;
      } else if (m.startsWith('audio/')) {
        inner = `<div class="mp-doc"><div class="mp-doc-icon">♪</div><div><div class="mp-doc-name">${escapeHtml(f.name || 'audio')}</div><audio controls src="${URL.createObjectURL(f)}" style="width:100%;margin-top:8px"></audio></div></div>`;
      } else {
        const ext = (f.name || '').split('.').pop()?.toUpperCase() || 'FILE';
        inner = `<div class="mp-doc"><div class="mp-doc-icon">${escapeHtml(ext.slice(0, 4))}</div><div><div class="mp-doc-name">${escapeHtml(f.name || 'documento')}</div><div class="mp-doc-sub">${fmtBytes(f.size || 0)}</div></div></div>`;
      }
      stage.innerHTML = inner;
      meta.textContent = `${activeIdx + 1}/${files.length} · ${escapeHtml(f.name || '')} · ${fmtBytes(f.size || 0)}`;
    };

    const renderThumbs = () => {
      if (files.length <= 1) { thumbs.style.display = 'none'; thumbs.innerHTML = ''; return; }
      thumbs.style.display = 'flex';
      thumbs.innerHTML = files.map((f, i) => {
        const m = (f.type || '').toLowerCase();
        let inner = '';
        if (m.startsWith('image/')) inner = `<img src="${URL.createObjectURL(f)}">`;
        else if (m.startsWith('video/')) inner = `<div class="mp-th-icon">▶</div>`;
        else if (m.startsWith('audio/')) inner = `<div class="mp-th-icon">♪</div>`;
        else inner = `<div class="mp-th-icon">📄</div>`;
        return `<div class="mp-thumb${i === activeIdx ? ' active' : ''}" data-idx="${i}">
          ${inner}
          <button class="mp-th-rm" data-rm="${i}" title="Quitar">✕</button>
        </div>`;
      }).join('');
      thumbs.querySelectorAll('.mp-thumb').forEach(el => {
        el.onclick = (e) => {
          if (e.target.closest('[data-rm]')) return;
          activeIdx = parseInt(el.dataset.idx, 10) || 0;
          renderStage();
          renderThumbs();
        };
      });
      thumbs.querySelectorAll('[data-rm]').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const i = parseInt(btn.dataset.rm, 10);
          files.splice(i, 1);
          if (!files.length) { close(null); return; }
          if (activeIdx >= files.length) activeIdx = files.length - 1;
          renderStage();
          renderThumbs();
        };
      });
    };

    renderStage();
    renderThumbs();

    const close = (val) => {
      bg.classList.remove('open');
      setTimeout(() => bg.remove(), 150);
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) confirm();
    };
    const confirm = () => close({ files, caption: captionInput.value || '' });

    document.addEventListener('keydown', onKey);
    bg.addEventListener('click', e => { if (e.target === bg) close(null); });
    bg.querySelectorAll('.mp-cancel').forEach(b => b.onclick = () => close(null));
    bg.querySelector('#mp-send').onclick = confirm;
    setTimeout(() => captionInput.focus(), 50);
  });
}

// Genérico: detecta tipo del file por mime y manda con el endpoint correcto.
// type puede ser: image | audio | video | document | auto
async function sendChatFile(phone, file, caption, type) {
  if (!phone || !file) return;
  chatState.sending = true;
  updateChatInputState();
  // Detectar tipo si no fue pasado
  if (!type) {
    const m = (file.type || '').toLowerCase();
    if (m.startsWith('image/')) type = 'image';
    else if (m.startsWith('audio/')) type = 'audio';
    else if (m.startsWith('video/')) type = 'video';
    else type = 'document';
  }
  const replyTo = chatState.replyingTo || '';
  // IG: la foto va por el endpoint de Instagram (el de WhatsApp rechaza el ID de IG).
  const _cMedia = (chatState.contacts || []).find(c => c.phone === phone);
  const _mediaEndpoint = (_cMedia && _cMedia.channel === 'ig') ? '/admin/ig/send-media' : '/admin/wa/send-media';
  try {
    const fd = new FormData();
    fd.append('to', phone);
    fd.append('type', type);
    fd.append('caption', caption || '');
    fd.append('file', file);
    if (replyTo) fd.append('reply_to', replyTo);
    const r = await fetch(CONFIG.trackerUrl + _mediaEndpoint, {
      method: 'POST', headers: authHeaders(), body: fd
    });
    const j = await r.json();
    if (!r.ok) { toast('Error: ' + (j.error || 'fallo envío')); return; }
    const tag = type === 'image' ? '[imagen]' : type === 'video' ? '[video]' : type === 'audio' ? '[audio]' : ('[documento] ' + (file.name || ''));
    chatState.messages.push({
      ts: new Date().toISOString(), wamid: j.id || '', direction: 'outbound',
      phone, sender_name: '', msg_type: type, body: caption || tag,
      media_url: j.r2Key || '', context_id: replyTo || '', status: 'sent'
    });
    chatState.replyingTo = null;
    renderReplyBanner();
    renderChatMessages();
    const labelOk = type === 'image' ? 'Imagen enviada' : type === 'video' ? 'Video enviado' : type === 'audio' ? 'Audio enviado' : 'Documento enviado';
    toast(labelOk);
  } catch (e) { toast('Error de red'); }
  finally { chatState.sending = false; updateChatInputState(); }
}

async function sendChatAudio(phone, blob) {
  if (!phone || !blob) return;
  chatState.sending = true;
  updateChatInputState();
  try {
    const mime = blob.type || 'audio/ogg';
    // Instagram va por su propio caño (/admin/ig/send-media, Graph API); WhatsApp por 360dialog.
    const _c = (chatState.contacts || []).find(c => c.phone === phone);
    const _isIg = _c && _c.channel === 'ig';
    const fd = new FormData();
    fd.append('to', phone);
    fd.append('type', 'audio');
    fd.append('file', blob, 'audio' + audioExtForMime(mime));
    const r = await fetch(CONFIG.trackerUrl + (_isIg ? '/admin/ig/send-media' : '/admin/wa/send-media'), {
      method: 'POST', headers: authHeaders(), body: fd
    });
    const j = await r.json();
    if (!r.ok) { toast('Error audio: ' + (j.error || 'fallo') + (j.detail ? ' · ' + j.detail : '')); console.warn('audio fail', j); return; }
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
// WhatsApp solo acepta audio en ogg/opus, mp4(m4a), mpeg(mp3), aac o amr — NO
// acepta webm. Elegimos el mejor formato compatible que soporte el navegador.
// (Firefox graba ogg; Safari mp4; Chrome solo webm → ese caso lo cubrimos en el
//  worker/segundo paso si hace falta.)
function pickAudioMime() {
  const prefs = ['audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/webm;codecs=opus', 'audio/webm'];
  if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported) {
    for (const m of prefs) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {} }
  }
  return '';
}
function audioExtForMime(m) {
  m = (m || '').toLowerCase();
  if (m.includes('ogg')) return '.ogg';
  if (m.includes('wav')) return '.wav';
  if (m.includes('mp4')) return '.m4a';
  if (m.includes('mpeg') || m.includes('mp3')) return '.mp3';
  if (m.includes('webm')) return '.webm';
  return '.bin';
}
// Self-hosted (mismo origen) — ANTES era el CDN de jsdelivr, pero iOS Safari
// bloquea cargar un Worker cross-origin → opus-recorder fallaba en iPhone y
// caía a MediaRecorder (m4a) → WhatsApp mostraba el audio como ARCHIVO en vez
// de nota de voz. Sirviéndolo del mismo origen, iOS lo carga y graba ogg/opus.
const OPUS_ENCODER_URL = 'assets/opus-encoderWorker.min.js';

function _startRecTimer() {
  chatState.recordingSecs = 0;
  chatState.recordingTimer = setInterval(() => {
    chatState.recordingSecs++;
    const el = document.getElementById('rec-timer');
    if (el) el.textContent = Math.floor(chatState.recordingSecs / 60) + ':' + String(chatState.recordingSecs % 60).padStart(2, '0');
  }, 1000);
}

// ===== Grabador WAV (para Instagram) =====
// IG acepta aac/m4a/wav/mp4 pero NO ogg/opus (lo que grabamos para WhatsApp). Chrome y Firefox
// no graban mp4/aac nativo, así que capturamos PCM crudo con Web Audio API y lo encodeamos como
// WAV (que IG sí acepta). Anda en TODOS los navegadores y sin librerías de transcodeo.
function _startRecordingWav(phone) {
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const source = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    proc.onaudioprocess = (e) => {
      chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); // copiar: el buffer se reusa
      e.outputBuffer.getChannelData(0).fill(0); // silencio en la salida -> no se escucha el mic por los parlantes
    };
    source.connect(proc);
    proc.connect(ctx.destination);
    chatState.wavRec = { stream, ctx, source, proc, chunks, sampleRate: ctx.sampleRate };
    chatState.recording = true;
    _startRecTimer();
    renderRecordingUI();
  }).catch(() => toast('No se pudo acceder al micrófono'));
}
// Une los chunks PCM, baja a 16kHz mono y arma un WAV (PCM 16-bit) — liviano y suficiente para voz.
function _encodeWav(chunks, inRate) {
  let len = 0; for (const c of chunks) len += c.length;
  const pcm = new Float32Array(len);
  let off = 0; for (const c of chunks) { pcm.set(c, off); off += c.length; }
  const outRate = 16000;
  const ratio = (inRate || 48000) / outRate;
  const outLen = Math.max(1, Math.floor(pcm.length / ratio));
  const ds = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, pcm[Math.floor(i * ratio)] || 0));
    ds[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  const buf = new ArrayBuffer(44 + ds.length * 2);
  const dv = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + ds.length * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, outRate, true); dv.setUint32(28, outRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws(36, 'data'); dv.setUint32(40, ds.length * 2, true);
  let p = 44; for (let i = 0; i < ds.length; i++) { dv.setInt16(p, ds[i], true); p += 2; }
  return new Blob([buf], { type: 'audio/wav' });
}

function startRecording(phone) {
  // Instagram NO acepta ogg/opus -> grabamos WAV con Web Audio API (anda en todo navegador).
  const _c = (chatState.contacts || []).find(x => x.phone === phone);
  if (_c && _c.channel === 'ig') { _startRecordingWav(phone); return; }
  // WhatsApp: preferimos opus-recorder (ogg/opus, que WhatsApp acepta en TODOS los navegadores;
  // Chrome con MediaRecorder solo graba webm, que WhatsApp rechaza).
  if (typeof Recorder !== 'undefined') {
    try {
      const rec = new Recorder({ encoderPath: OPUS_ENCODER_URL, numberOfChannels: 1, encoderSampleRate: 48000, streamPages: false, recordingGain: 1 });
      chatState.opusRec = rec;
      rec.ondataavailable = () => {}; // se setea el real en stop
      rec.start().then(() => {
        chatState.recording = true;
        _startRecTimer();
        renderRecordingUI();
      }).catch(() => { chatState.opusRec = null; _startRecordingMR(phone); });
      return;
    } catch (e) { chatState.opusRec = null; }
  }
  _startRecordingMR(phone);
}

// Fallback con MediaRecorder (Firefox graba ogg, Safari mp4; Chrome webm = falla).
function _startRecordingMR(phone) {
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    chatState.recording = true;
    chatState.audioChunks = [];
    const wantMime = pickAudioMime();
    const mr = wantMime ? new MediaRecorder(stream, { mimeType: wantMime }) : new MediaRecorder(stream);
    chatState.audioMime = mr.mimeType || wantMime || 'audio/webm';
    chatState.mediaRecorder = mr;
    mr.ondataavailable = e => { if (e.data.size > 0) chatState.audioChunks.push(e.data); };
    mr.onstop = () => { stream.getTracks().forEach(t => t.stop()); };
    mr.start();
    _startRecTimer();
    renderRecordingUI();
  }).catch(() => toast('No se pudo acceder al micrófono'));
}

function cancelRecording() {
  try {
    if (chatState.wavRec) { const w = chatState.wavRec; chatState.wavRec = null; try { w.proc.disconnect(); w.source.disconnect(); w.stream.getTracks().forEach(t => t.stop()); w.ctx.close(); } catch (_) {} }
    else if (chatState.opusRec) { chatState.opusRec.ondataavailable = () => {}; chatState.opusRec.stop(); chatState.opusRec = null; }
    else if (chatState.mediaRecorder && chatState.mediaRecorder.state !== 'inactive') chatState.mediaRecorder.stop();
  } catch (_) {}
  chatState.recording = false;
  chatState.audioChunks = [];
  clearInterval(chatState.recordingTimer);
  renderNormalInputUI();
}

function stopAndSendRecording(phone) {
  const finish = (blob) => {
    chatState.recording = false;
    chatState.audioChunks = [];
    clearInterval(chatState.recordingTimer);
    renderNormalInputUI();
    if (blob && blob.size > 0) sendChatAudio(phone, blob);
  };
  // WAV (Instagram): armamos el WAV desde los chunks PCM capturados.
  if (chatState.wavRec) {
    const w = chatState.wavRec; chatState.wavRec = null;
    try {
      w.proc.disconnect(); w.source.disconnect();
      w.stream.getTracks().forEach(t => t.stop());
      const blob = _encodeWav(w.chunks, w.sampleRate);
      try { w.ctx.close(); } catch (_) {}
      finish(blob);
    } catch (_) { finish(null); }
    return;
  }
  // opus-recorder: el archivo ogg llega por ondataavailable al hacer stop().
  if (chatState.opusRec) {
    const rec = chatState.opusRec;
    chatState.opusRec = null;
    rec.ondataavailable = (typedArray) => { finish(new Blob([typedArray], { type: 'audio/ogg' })); };
    try { rec.stop(); } catch (_) { finish(null); }
    return;
  }
  if (!chatState.mediaRecorder) return;
  chatState.mediaRecorder.onstop = () => {
    chatState.mediaRecorder.stream?.getTracks().forEach(t => t.stop());
    finish(new Blob(chatState.audioChunks, { type: chatState.audioMime || 'audio/webm' }));
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
    <input type="file" id="chat-file-input" accept="image/*,video/*,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/zip,text/plain" multiple style="display:none">
    <textarea id="chat-input" placeholder="Escribí un mensaje" rows="1"></textarea>
    <button class="btn-send" id="chat-send-btn" ${chatState.sending ? 'disabled' : ''} title="Enviar"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M1.101 21.757L23.8 12.028 1.101 2.3l.011 7.912 13.239 1.816-13.239 1.817-.011 7.912z"/></svg></button>
    <button class="btn-send btn-schedule" id="btn-schedule" title="Programar mensaje"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg></button>
    <button class="btn-send btn-mic" id="btn-mic" title="Grabar audio"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M11.999 14.942c2.001 0 3.531-1.53 3.531-3.531V4.35c0-2.001-1.53-3.531-3.531-3.531S8.469 2.35 8.469 4.35v7.061c0 2.001 1.53 3.531 3.53 3.531zm6.238-3.53c0 3.531-2.942 6.002-6.238 6.002s-6.238-2.471-6.238-6.002H4.761c0 3.885 3.118 7.061 7.003 7.414v3.174h.471v-3.174c3.885-.353 7.003-3.529 7.003-7.414h-1z"/></svg></button>
  `;
  bindChatConversation();
}

// Menú del clip (adjuntar) estilo WhatsApp: Foto/video, Documento, Sticker.
function openAttachMenu() {
  const existing = document.getElementById('attach-menu');
  if (existing) { existing.remove(); return; }
  const bar = document.querySelector('.chat-input-bar');
  if (!bar || !bar.parentElement) return;
  const _c = (chatState.contacts || []).find(c => c.phone === chatState.selectedPhone);
  const _isIg = _c && _c.channel === 'ig';
  const menu = document.createElement('div');
  menu.id = 'attach-menu';
  menu.style.cssText = 'position:absolute;bottom:64px;left:8px;background:var(--bg-elev,#233138);border:1px solid var(--border,#2a3942);border-radius:12px;padding:6px;z-index:60;box-shadow:0 -6px 24px rgba(0,0,0,.5);min-width:210px';
  const item = (icon, label, id) => `<button data-attach="${id}" style="display:flex;align-items:center;gap:13px;width:100%;padding:11px 13px;background:none;border:none;color:var(--fg,#e9edef);font-size:14px;cursor:pointer;border-radius:8px;text-align:left"><span style="font-size:18px;width:22px;text-align:center">${icon}</span><span>${label}</span></button>`;
  menu.innerHTML = item('🖼️', 'Foto o video', 'photo') + item('📄', 'Documento', 'doc') + (_isIg ? '' : item('🎨', 'Sticker', 'sticker'));
  const host = bar.parentElement;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(menu);
  menu.querySelectorAll('[data-attach]').forEach(el => {
    el.onmouseenter = () => { el.style.background = 'rgba(255,255,255,.07)'; };
    el.onmouseleave = () => { el.style.background = 'none'; };
    el.onclick = () => {
      const a = el.getAttribute('data-attach');
      menu.remove();
      const fi = document.getElementById('chat-file-input');
      if (a === 'photo' && fi) { fi.setAttribute('accept', 'image/*,video/*'); fi.click(); }
      else if (a === 'doc' && fi) { fi.setAttribute('accept', 'application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/zip,text/plain,image/*'); fi.click(); }
      else if (a === 'sticker') toggleStickerPicker();
    };
  });
  setTimeout(() => {
    const close = (ev) => { if (!menu.contains(ev.target) && ev.target.id !== 'btn-attach' && !(ev.target.closest && ev.target.closest('#btn-attach'))) { menu.remove(); document.removeEventListener('click', close); } };
    document.addEventListener('click', close);
  }, 50);
}

// ===== Stickers favoritos =====
// Gaspar se manda sus stickers al numero desde su WhatsApp personal -> entran como inbound
// (WebP en R2). Toca ⭐ para guardarlos y los reusa desde el picker de la barra.
async function loadStickerFavs() {
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/sticker-favs', { headers: authHeaders() });
    if (r.ok) { const j = await r.json(); chatState.stickerFavs = (j.stickers || []).map(s => s.r2_key); }
  } catch (_) {}
}
async function toggleStickerFav(r2Key, remove) {
  try {
    await fetch(CONFIG.trackerUrl + '/admin/wa/sticker-fav', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ r2_key: r2Key, remove: !!remove }) });
    if (remove) chatState.stickerFavs = (chatState.stickerFavs || []).filter(k => k !== r2Key);
    else if (!(chatState.stickerFavs || []).includes(r2Key)) chatState.stickerFavs = [r2Key, ...(chatState.stickerFavs || [])];
    toast(remove ? 'Sticker quitado de favoritos' : '⭐ Sticker guardado');
  } catch (_) { toast('No se pudo guardar'); }
}
async function sendStickerToChat(phone, r2Key) {
  if (!phone || !r2Key) return;
  chatState.sending = true; updateChatInputState();
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/send-sticker', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ to: phone, r2_key: r2Key }) });
    const j = await r.json();
    if (!r.ok) { toast('Error sticker: ' + (j.error || 'fallo')); return; }
    chatState.messages.push({ ts: new Date().toISOString(), wamid: j.id || '', direction: 'outbound', phone, sender_name: '', msg_type: 'sticker', body: '', media_url: r2Key, status: 'sent' });
    renderChatMessages();
    const p = document.getElementById('sticker-picker'); if (p) p.remove();
  } catch (e) { toast('Error de red'); }
  finally { chatState.sending = false; updateChatInputState(); }
}
function toggleStickerPicker() {
  const existing = document.getElementById('sticker-picker');
  if (existing) { existing.remove(); return; }
  const bar = document.querySelector('.chat-input-bar');
  if (!bar || !bar.parentElement) return;
  const favs = chatState.stickerFavs || [];
  const panel = document.createElement('div');
  panel.id = 'sticker-picker';
  panel.style.cssText = 'position:absolute;bottom:64px;left:8px;right:8px;max-height:240px;overflow-y:auto;background:var(--bg-elev,#1f2c34);border:1px solid var(--border,#2a3942);border-radius:12px;padding:10px;display:flex;flex-wrap:wrap;gap:8px;z-index:60;box-shadow:0 -4px 20px rgba(0,0,0,.45)';
  panel.innerHTML = favs.length
    ? favs.map(k => `<img src="${mediaUrl(k)}" data-send-sticker="${k}" style="width:82px;height:82px;object-fit:contain;cursor:pointer;border-radius:8px" title="Mandar sticker">`).join('')
    : '<div style="padding:14px;opacity:.75;font-size:13px;line-height:1.4">No tenés stickers guardados todavía.<br>Mandate tus stickers favoritos desde tu WhatsApp a este número y tocá <b>⭐</b> en cada uno para guardarlos acá.</div>';
  const host = bar.parentElement;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(panel);
  panel.querySelectorAll('[data-send-sticker]').forEach(el => { el.onclick = () => sendStickerToChat(chatState.selectedPhone, el.getAttribute('data-send-sticker')); });
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
  if (!canAccessChat()) return;
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
    badge.textContent = chatState.totalUnread > 99 ? '99+' : (chatState.totalUnread || '');
    badge.style.display = chatState.totalUnread ? '' : 'none';
  }
}

async function loadChatContacts() {
  if (!canAccessChat()) return;
  chatState.loading = true;
  try {
    // Cargar read cursors en paralelo en la primera carga
    if (!Object.keys(chatState.readCursors).length) {
      await loadReadCursors();
    }
    // Usamos el endpoint /admin/wa/chats-summary que devuelve UNA fila por
    // phone con: last_ts, last_body, last_direction, last_msg_type,
    // contact_name (último sender_name inbound) y unread (computado server-
    // side contra wa_read_cursor). Esto cubre TODOS los chats que tenemos
    // en DB sin importar cuántos mensajes haya en total — escala con la
    // cantidad de chats (~1k filas), no de mensajes (~16k+).
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/chats-summary', {
      headers: authHeaders()
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const chats = j.chats || [];
    const waNames = chatState.waContactNames || {};
    chatState.contacts = chats.map(c => {
      // Prioridad de nombre: wa_contacts (agenda) > último sender_name > vacío
      const displayName = waNames[c.phone] || c.contact_name || '';
      const body = c.last_body || '';
      const isStatusPlaceholder = c.last_msg_type === 'status' && c.last_direction === 'outbound' && !body;
      return {
        phone: c.phone,
        name: displayName,
        lastMsg: (
          c.last_msg_type === 'revoke' ? 'Mensaje eliminado' :
          isStatusPlaceholder ? '✓ Respondido desde WhatsApp' :
          (body || ({ image: '📷 Foto', video: '🎥 Video', audio: '🎤 Audio', document: '📎 Archivo', sticker: 'Sticker', text: '' }[c.last_msg_type] ?? `[${c.last_msg_type}]`))
        ).slice(0, 60),
        lastTs: c.last_ts,
        lastDir: c.last_direction,
        lastType: c.last_msg_type,
        unread: c.unread || 0,
        inbox: c.inbox || 'general',  // bandeja: general | cursos (para el botón 🎓)
        channel: c.channel || 'wa',   // canal: wa | ig (pestaña WhatsApp / Instagram)
        assigned_to: c.assigned_to || ''  // vendedor asignado (reparto Joaco/Nadia)
      };
    }).sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
    // Refrescar etiquetas de contactos (throttle ~12s). Antes solo se cargaban
    // UNA vez (loadLabels tiene guard labelsLoaded), así que las etiquetas nuevas
    // —p.ej. "revendedor" aplicada por la automatización— no aparecían hasta
    // recargar la página. Ahora el poll las re-consulta y refreshContactList (que
    // corre justo después en tickPoll) las muestra sin recargar.
    try {
      const _now = Date.now();
      if (!chatState._clRefreshAt || (_now - chatState._clRefreshAt) >= 12000) {
        chatState._clRefreshAt = _now;
        const [_lr2, _clr] = await Promise.all([
          fetch(CONFIG.trackerUrl + '/admin/labels', { headers: authHeaders() }),
          fetch(CONFIG.trackerUrl + '/admin/contact-labels', { headers: authHeaders() })
        ]);
        // Refrescar la LISTA de etiquetas (definiciones), no solo las asignaciones.
        // Sin esto, una etiqueta nueva (creada por cualquiera) no aparecia en los menus
        // hasta recargar la pagina (los menus leen chatState.labels).
        if (_lr2.ok) { const _lj = await _lr2.json(); if (Array.isArray(_lj.labels)) chatState.labels = _lj.labels; }
        if (_clr.ok) { const _cj = await _clr.json(); chatState.contactLabels = _cj.contactLabels || {}; }
        // Refrescar nombres/@usuarios/fotos (Instagram incluido): igual que las
        // etiquetas, antes solo se cargaban 1 vez (guard waContactNamesLoaded), así
        // que el @usuario y la foto de un chat de IG nuevo no aparecían hasta
        // recargar. Ahora el poll los trae solos.
        try { await loadWaContactNames(); } catch (_) {}
      }
    } catch (_) {}
    // NO tocar chatState.messages — loadChatMessages(phone) maneja el
    // historial del chat abierto por su cuenta.
    updateUnreadBadge();
  } catch (e) {
    console.error('chat load error:', e);
  } finally {
    chatState.loading = false;
  }
}

// PAGE_SIZE_INITIAL: cuántos mensajes traer al abrir un chat por primera vez.
// PAGE_SIZE_OLDER: cuántos cargar al scrollear arriba ("ver anteriores").
// Bajar 2000 → 200 elimina el lag de 2-4s en chats con +1700 mensajes.
const CHAT_PAGE_SIZE_INITIAL = 200;
const CHAT_PAGE_SIZE_OLDER = 200;

// Handler del botón "↑ Cargar mensajes anteriores". Mantiene el scroll position
// del usuario: si tenía un mensaje X visible antes de cargar, sigue viendo X
// después (no scrollea al top).
async function handleLoadOlderMessages() {
  if (chatState.loadingOlder || !chatState.selectedPhone) return;
  chatState.loadingOlder = true;
  // Re-render del botón para mostrar "Cargando…"
  renderChatMessages();
  // Capturar scroll position relativa al primer mensaje visible (anchor).
  const container = document.getElementById('chat-messages');
  const prevScrollHeight = container?.scrollHeight || 0;
  const prevScrollTop = container?.scrollTop || 0;
  try {
    await loadChatMessages(chatState.selectedPhone, { loadOlder: true });
  } finally {
    chatState.loadingOlder = false;
    renderChatMessages();
    // Restaurar scroll position: el container crece hacia arriba con los
    // mensajes nuevos. scrollTop += diferencia de altura para que el usuario
    // siga viendo el mismo mensaje que tenía a la vista.
    const newContainer = document.getElementById('chat-messages');
    if (newContainer) {
      const newScrollHeight = newContainer.scrollHeight;
      newContainer.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
    }
  }
}

async function loadChatMessages(phone, opts) {
  if (!canAccessChat() || !phone) return;
  const isInitialLoad = !opts?.incremental && !opts?.loadOlder
    && (!chatState.messages.length || chatState.messages[0]?.phone !== phone);
  const isLoadOlder = !!opts?.loadOlder;
  try {
    let url = CONFIG.trackerUrl + '/admin/wa/messages?phone=' + encodeURIComponent(phone);
    if (isInitialLoad) {
      // Carga inicial: los 200 mensajes más recientes (server hace ORDER BY ts DESC).
      url += '&limit=' + CHAT_PAGE_SIZE_INITIAL;
    } else if (isLoadOlder) {
      // Cargar 200 anteriores al primer mensaje actualmente cacheado.
      const firstTs = chatState.messages.length ? chatState.messages[0].ts : '';
      if (!firstTs) return;
      // to=firstTs (exclusivo): -1ms para no traer el mismo.
      const beforeTs = new Date(new Date(firstTs).getTime() - 1).toISOString();
      url += '&limit=' + CHAT_PAGE_SIZE_OLDER + '&to=' + encodeURIComponent(beforeTs);
    } else {
      // Incremental (polling): deltas desde el último ts conocido.
      const lastTs = chatState.messages.length ? chatState.messages[chatState.messages.length - 1].ts : '';
      let sinceTs = lastTs ? new Date(new Date(lastTs).getTime() - 60000).toISOString() : '';
      // Si hay media todavía "crudo" en la vista (media_id sin bajar a R2: el webhook
      // no lo bajó al toque y lo está recuperando el retry/cron del backend), retroceder
      // el 'from' hasta el crudo más viejo (de las últimas 6h) para re-traerlo en cada
      // poll. Cuando el backend termina de bajarlo, el merge de abajo actualiza su
      // media_url a wa/... y la foto/audio aparece SOLA, sin tener que refrescar la página.
      const isRawMedia = (m) => (m.msg_type === 'image' || m.msg_type === 'audio' || m.msg_type === 'video' || m.msg_type === 'sticker' || m.msg_type === 'document') && m.media_url && !/^(wa|ig|promo|briefs)\//.test(String(m.media_url));
      const limiteReciente = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      const crudos = chatState.messages.filter(m => isRawMedia(m) && m.ts >= limiteReciente);
      if (crudos.length) {
        const oldest = crudos.reduce((min, m) => (m.ts < min ? m.ts : min), crudos[0].ts);
        const oldestSince = new Date(new Date(oldest).getTime() - 1).toISOString();
        if (!sinceTs || oldestSince < sinceTs) sinceTs = oldestSince;
      }
      url += '&limit=500' + (sinceTs ? '&from=' + encodeURIComponent(sinceTs) : '');
    }
    const r = await fetch(url, { headers: authHeaders() });
    if (!r.ok) return;
    const j = await r.json();
    const fresh = (j.messages || []).filter(m => m.msg_type !== 'status');

    // Si fue initial o loadOlder, calcular si hay más anteriores: si el server
    // devolvió un batch lleno, asumimos que sí. Si vino con menos rows, no hay más.
    if (isInitialLoad || isLoadOlder) {
      chatState.hasMoreOlder = fresh.length >= (isInitialLoad ? CHAT_PAGE_SIZE_INITIAL : CHAT_PAGE_SIZE_OLDER);
    }

    // Merge: preservar TODOS los mensajes locales con wamid (de cargas previas),
    // sumar los frescos. Funciona tanto para incremental (timestamps nuevos) como
    // para loadOlder (timestamps viejos): el sort final ordena bien todo.
    const byKey = new Map();
    const keyOf = (m) => m.wamid || ('ts:' + m.ts + ':' + m.direction);
    if (!isInitialLoad) {
      for (const m of chatState.messages) byKey.set(keyOf(m), m);
    }
    for (const m of fresh) byKey.set(keyOf(m), m);
    if (!isInitialLoad) {
      for (const local of chatState.messages) {
        if (local.wamid) continue;
        const k = keyOf(local);
        if (!byKey.has(k)) byKey.set(k, local);
      }
    }
    chatState.messages = [...byKey.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  } catch (e) {
    console.error('chat messages error:', e);
  }
}

async function sendChatMessage(phone, text) {
  if (!canAccessChat() || !phone || !text.trim()) return;
  const full = text.trim();
  // El split en "varios mensajes cortos" (parecer humano del playbook) es SOLO para las
  // sugerencias del Copiloto IA (cuando tocaste "Usar ✍️"). Lo que escribís VOS a mano se
  // manda tal cual, en un solo mensaje, aunque tenga saltos de línea dobles. Detectamos la
  // sugerencia por chatState.lastSuggestion._used del chat actual.
  const fromSuggestion = !!(chatState.lastSuggestion && chatState.lastSuggestion.phone === phone && chatState.lastSuggestion._used);
  const parts = fromSuggestion
    ? full.split(/\n[ \t]*\n+/).map(t => t.trim()).filter(Boolean)
    : [full];
  const replyTo = chatState.replyingTo || '';
  // OPTIMISTA: limpiamos el input YA (antes del envío) para que puedas seguir. Si algo falla,
  // restauramos SOLO lo que no se llegó a mandar (no re-mandamos lo que ya salió).
  const ta = document.getElementById('chat-input');
  if (ta) { ta.value = ''; ta.style.height = 'auto'; }
  chatState.replyingTo = null;
  renderReplyBanner();
  setDraft(phone, '');
  const restoreOnFail = (remaining) => {
    const t = document.getElementById('chat-input');
    if (t && !t.value.trim()) { t.value = remaining; setDraft(phone, remaining); }
    chatState.replyingTo = replyTo || null;
    renderReplyBanner();
  };
  chatState.sending = true;
  updateChatInputState();
  // Instagram va por su propio caño (Graph API), no por el de WhatsApp (360dialog).
  const _contact = (chatState.contacts || []).find(c => c.phone === phone);
  const _isIg = _contact && _contact.channel === 'ig';
  let sent = 0;
  try {
    for (let i = 0; i < parts.length; i++) {
      const partBody = parts[i];
      const partReply = i === 0 ? replyTo : ''; // la cita (reply) va solo en el primero
      const r = await fetch(CONFIG.trackerUrl + (_isIg ? '/admin/ig/send' : '/admin/wa/send'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(_isIg ? { to: phone, text: partBody } : { to: phone, body: partBody, reply_to: partReply || undefined })
      });
      const j = await r.json();
      if (!r.ok) {
        // IG: traducimos los errores crípticos de Meta a algo entendible (así Abril entiende y
        // no reintenta 7 veces). "cannot be found" = esa cuenta quedó inalcanzable por la API
        // (se desactivó, te bloqueó o borró la conversación) — se puede responder desde la app.
        let msg = 'Error: ' + (j.error || 'no se pudo enviar');
        if (_isIg && /cannot be found|user.*not.*found|does not exist/i.test(String(j.error || ''))) {
          msg = '⚠️ No se puede responder a este contacto por Instagram: la cuenta se desactivó, te bloqueó o borró la conversación. Podés intentar desde la app de Instagram.';
        } else if (_isIg) {
          msg = 'Instagram — ' + (j.error || 'no se pudo enviar');
        }
        toast(msg);
        restoreOnFail(parts.slice(sent).join('\n\n'));
        return;
      }
      chatState.messages.push({
        ts: new Date().toISOString(),
        wamid: j.id || '',
        direction: 'outbound',
        phone: phone,
        sender_name: '',
        msg_type: 'text',
        body: partBody,
        context_id: partReply || '',
        status: 'sent'
      });
      sent++;
      renderChatMessages();
      // Pausa humana entre mensajes (no en el último): se sienten escritos, no un bloque bulk.
      if (i < parts.length - 1) await new Promise(res => setTimeout(res, 650));
    }
    // Copiloto: si esta respuesta salió de una sugerencia usada, logueamos el feedback (texto completo).
    try {
      const sg = chatState.lastSuggestion;
      if (sg && sg.phone === phone && sg._used) {
        logSuggestionFeedback(sg, full, full === String(sg.draft || '').trim() ? 'sent' : 'edited');
        chatState.lastSuggestion = null;
      }
    } catch (_) {}
  } catch (e) {
    toast('Error de red al enviar');
    restoreOnFail(parts.slice(sent).join('\n\n'));
  } finally {
    chatState.sending = false;
    updateChatInputState();
  }
}

function updateChatInputState() {
  const btn = document.getElementById('chat-send-btn');
  if (btn) btn.disabled = chatState.sending;
}

// ===== Scheduled messages =====
function showScheduleModal(phone) {
  const ta = document.getElementById('chat-input');
  const text = (ta?.value || '').trim();   // texto libre OPCIONAL (solo si la ventana sigue abierta)
  loadChatTemplates();                       // idempotente (por si no cargaron)
  const contact = (chatState.contacts || []).find(c => c.phone === phone);
  const cname = (contact && contact.name) || chatState.selectedName || '';
  const firstName = (cname.trim().split(/\s+/)[0] || '').replace(/^./, c => c.toUpperCase());
  const tplBody = (t) => { const b = (t.components || []).find(c => (c.type || '').toUpperCase() === 'BODY'); return (b && b.text) || ''; };
  const tplVars = (t) => (tplBody(t).match(/\{\{\d+\}\}/g) || []).length;
  const fillTpl = (t) => tplBody(t).replace(/\{\{1\}\}/g, firstName || 'tu nombre').replace(/\{\{\d+\}\}/g, '…');
  // Plantillas de re-enganche de carteles primero (las más útiles para seguimiento).
  const prefer = ['seguimiento_presupuesto', 'retomar_carteles_v2', 'retomar_carteles'];
  const ordered = [...(chatState.templates || [])].sort((a, b) => ((prefer.indexOf(a.name) + 1) || 99) - ((prefer.indexOf(b.name) + 1) || 99));
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const defaultDate = tomorrow.toISOString().slice(0, 10);
  const modal = document.createElement('div');
  modal.className = 'schedule-modal-overlay';
  modal.innerHTML = `
    <div class="schedule-modal">
      <h3 style="margin:0 0 6px">Programar seguimiento</h3>
      <p style="font-size:12px;color:#8696a0;margin:0 0 10px">Se manda <b>solo si el cliente NO te vuelve a escribir</b> antes. Si la ventana de 24h ya cerró (lo normal al día siguiente), se manda con una <b>plantilla aprobada</b> 👇</p>
      ${text ? `<div class="schedule-preview">${escapeHtml(text).replace(/\n/g, '<br>')}</div><div style="font-size:11px;color:#8696a0;margin:4px 0 8px">↑ este texto libre solo se manda si la ventana sigue abierta</div>` : ''}
      <label style="font-size:12px;color:#8696a0">Plantilla (si la ventana está cerrada)</label>
      <select id="sched-template" style="width:100%;padding:8px;border-radius:6px;border:1px solid #3b4a54;background:#2a3942;color:#e9edef;margin-bottom:6px">
        ${ordered.length ? ordered.map(t => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`).join('') : '<option value="">(no hay plantillas aprobadas)</option>'}
      </select>
      <div id="sched-tpl-preview" style="font-size:12px;color:#aebac1;background:#202c33;border-radius:6px;padding:8px;margin-bottom:6px;white-space:pre-wrap"></div>
      <button type="button" id="sched-new-tpl" style="background:none;border:none;color:#53bdeb;cursor:pointer;font-size:12px;padding:0;margin:0 0 10px;text-align:left">➕ Crear plantilla nueva (la aprueba Meta en unos minutos)</button>
      <div style="display:flex;gap:8px;margin:6px 0">
        <div style="flex:1">
          <label style="font-size:12px;color:#8696a0">Fecha</label>
          <input type="date" id="sched-date" value="${defaultDate}" style="width:100%;padding:8px;border-radius:6px;border:1px solid #3b4a54;background:#2a3942;color:#e9edef">
        </div>
        <div style="flex:1">
          <label style="font-size:12px;color:#8696a0">Hora (Argentina)</label>
          <input type="time" id="sched-time" value="10:00" style="width:100%;padding:8px;border-radius:6px;border:1px solid #3b4a54;background:#2a3942;color:#e9edef">
        </div>
      </div>
      <div id="sched-pending-list" style="margin:8px 0"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
        <button id="sched-cancel" class="btn-action" style="background:#3b4a54">Cerrar</button>
        <button id="sched-confirm" class="btn-action" style="background:#00a884">Programar</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const sel = modal.querySelector('#sched-template');
  const prev = modal.querySelector('#sched-tpl-preview');
  const syncPrev = () => {
    const t = ordered.find(x => x.name === (sel && sel.value));
    if (prev) prev.textContent = t ? fillTpl(t) : '';
  };
  if (sel) { sel.onchange = syncPrev; syncPrev(); }
  // Crear una plantilla nueva al toque (se manda a Meta; cuando la aprueban aparece
  // en este dropdown). Cierra este modal y abre el creador de plantillas.
  const newTplBtn = modal.querySelector('#sched-new-tpl');
  if (newTplBtn) newTplBtn.onclick = () => {
    // Crear + PROGRAMAR en un solo flujo: capturamos la fecha/hora de acá, abrimos el
    // creador de plantilla, y al crearla programamos el seguimiento para ese horario
    // con la plantilla nueva (se manda cuando Meta la apruebe, si el cliente no responde).
    const date = modal.querySelector('#sched-date').value;
    const time = modal.querySelector('#sched-time').value;
    const arDate = (date && time) ? new Date(`${date}T${time}:00-03:00`) : null;
    if (!arDate || isNaN(arDate.getTime()) || arDate <= new Date()) { toast('Primero elegí acá la fecha y hora (futura), después creá la plantilla'); return; }
    modal.remove();
    showCreateTemplateBroadcast({
      scheduleInfo: `${date} ${time} AR`,
      onCreated: async (name, hasVar) => {
        const params = (hasVar && firstName) ? [firstName] : [];
        try {
          const r = await fetch(CONFIG.trackerUrl + '/admin/wa/schedule', {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ phone, body: '', template: name, params, lang: 'es_AR', scheduled_at: arDate.toISOString() })
          });
          const j = await r.json().catch(() => ({}));
          if (r.ok) toast(`✓ Plantilla creada y seguimiento programado para ${date} ${time} AR. Se manda cuando Meta la apruebe, si el cliente no responde antes 🙌`);
          else toast('Plantilla creada, pero no se pudo programar: ' + (j.error || 'error'));
        } catch (e) { toast('Plantilla creada, pero falló programar: ' + (e.message || e)); }
      }
    });
  };
  modal.querySelector('#sched-cancel').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  loadPendingScheduled(phone, modal.querySelector('#sched-pending-list'));
  modal.querySelector('#sched-confirm').onclick = async () => {
    const date = modal.querySelector('#sched-date').value;
    const time = modal.querySelector('#sched-time').value;
    const template = sel ? sel.value : '';
    if (!date || !time) { toast('Elegí fecha y hora'); return; }
    if (!template && !text) { toast('Elegí una plantilla (o escribí un texto)'); return; }
    const arDate = new Date(`${date}T${time}:00-03:00`);
    if (isNaN(arDate.getTime()) || arDate <= new Date()) { toast('La fecha debe ser futura'); return; }
    const tplObj = ordered.find(x => x.name === template);
    const params = (tplObj && tplVars(tplObj) >= 1 && firstName) ? [firstName] : [];
    try {
      const r = await fetch(CONFIG.trackerUrl + '/admin/wa/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ phone, body: text || '', template, params, lang: 'es_AR', scheduled_at: arDate.toISOString() })
      });
      const j = await r.json();
      if (!r.ok) { toast('Error: ' + (j.error || 'fallo')); return; }
      toast(`⏰ Seguimiento programado para ${date} ${time} AR — se cancela si responde antes`);
      if (ta) { ta.value = ''; ta.style.height = 'auto'; }
      modal.remove();
    } catch (e) {
      toast('Error de red');
    }
  };
}

async function loadPendingScheduled(phone, container) {
  if (!container) return;
  try {
    const num = phone.replace(/\D/g, '');
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/schedule?status=pending', {
      headers: authHeaders()
    });
    const j = await r.json();
    const msgs = (j.messages || []).filter(m => m.phone === num || m.phone === phone);
    if (!msgs.length) return;
    container.innerHTML = `<div style="font-size:12px;color:#8696a0;margin-bottom:4px">Programados pendientes:</div>` +
      msgs.map(m => {
        const arTime = new Date(m.scheduled_at).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
        return `<div class="sched-pending-item" style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:13px">
          <span style="flex:1;color:#d1d7db">${escapeHtml(m.body).slice(0, 50)}${m.body.length > 50 ? '...' : ''}</span>
          <span style="color:#8696a0;white-space:nowrap">${arTime}</span>
          <button data-id="${m.id}" class="sched-cancel-btn" style="background:none;border:none;color:#e44;cursor:pointer;font-size:16px" title="Cancelar">✕</button>
        </div>`;
      }).join('');
    container.querySelectorAll('.sched-cancel-btn').forEach(btn => {
      btn.onclick = async () => {
        await fetch(CONFIG.trackerUrl + '/admin/wa/schedule/' + btn.dataset.id, {
          method: 'DELETE', headers: authHeaders()
        });
        btn.closest('.sched-pending-item').remove();
        toast('Mensaje cancelado');
      };
    });
  } catch (_) {}
}

function localDateKey(d) {
  // YYYY-MM-DD en hora local (no UTC), para comparar "mismo día calendario"
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatChatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const today = localDateKey(now);
  const msgDate = localDateKey(d);
  const time = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  if (msgDate === today) return time;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (msgDate === localDateKey(yesterday)) return 'Ayer';
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays < 7) return d.toLocaleDateString('es-AR', { weekday: 'short' });
  return d.toLocaleDateString('es-AR', { day: 'numeric', month: 'numeric', year: '2-digit' });
}

function formatChatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const today = localDateKey(now);
  const msgDate = localDateKey(d);
  if (msgDate === today) return 'Hoy';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (msgDate === localDateKey(yesterday)) return 'Ayer';
  return d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
}

function formatPhoneDisplay(phone) {
  if (!phone) return '';
  // Sacar todo lo que no sea dígito y trabajar sobre la versión normalizada,
  // así da igual si entra como "5491167...", "+54 9 11 67..." o "11-6766-9217".
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return '';
  // Casos típicos AR: 549 + área (2-4) + número.
  if (digits.startsWith('549') && digits.length >= 12) {
    const area = digits.slice(3, 5);
    const rest = digits.slice(5);
    return `+54 9 ${area} ${rest.slice(0, 4)}-${rest.slice(4)}`;
  }
  return '+' + digits;
}

// Etiquetas visibles según el rol. El rol 'cursos' (Abril) solo ve las
// relevantes a cursos; los demás roles ven todas. IDs estables:
//   23 Abandonado IA · Curso · 19 Cliente potencial · 17 Importante
//   13 Pago completo curso · 5 interesado curso
// Etiquetas que ve Abril (usuario Cursos) al etiquetar/filtrar. El resto las ve solo el admin.
// 5=interesado curso, 13=Pago completo curso, 26=Alumno, 23=Abandonado IA·Curso,
// 25=Registro evento junio, 27=form 9 de junio, 17=Importante, 18=Seguimiento.
// "Venta Abril": Abril la marca (botón dedicado en el chat) cada vez que vende un
// curso; a fin de mes Gaspar filtra por esta etiqueta para revisar comisiones.
const VENTA_ABRIL_LABEL_ID = 2154;
// 2965437 = seña (pagos de seña del lanzamiento) · 2954729 = lead lanzamiento agosto.
// Ambas son de cursos/lanzamiento → Abril las tiene que ver y filtrar.
const CURSOS_LABEL_IDS = [5, 13, 26, 23, 25, 27, 17, 18, VENTA_ABRIL_LABEL_ID, 2965437, 2954729];
// Etiquetas creadas a mano desde el dropdown (persisten en localStorage): se muestran
// SIEMPRE aunque el rol cursos tenga whitelist — si la creaste, la tenés que ver/usar/borrar.
function createdLabelIds() { try { return JSON.parse(localStorage.getItem('nv_created_labels') || '[]'); } catch (_) { return []; } }
function rememberCreatedLabel(id) { if (!id) return; try { const s = new Set(createdLabelIds()); s.add(id); localStorage.setItem('nv_created_labels', JSON.stringify([...s])); } catch (_) {} }
function forgetCreatedLabel(id) { try { const s = new Set(createdLabelIds()); s.delete(id); localStorage.setItem('nv_created_labels', JSON.stringify([...s])); } catch (_) {} }
function visibleLabels() {
  const all = chatState.labels || [];
  if (!isCursosOnly()) return all;
  const created = new Set(createdLabelIds());
  return all.filter(l => CURSOS_LABEL_IDS.includes(l.id) || created.has(l.id));
}

// Bandeja "Para cotizar": pre cotizaciones que el bot TERMINÓ y esperan que Joaco cotice.
// El label lo crea/administra el backend (se pone al completar, se saca al enviar el
// presupuesto); acá lo ubicamos por nombre para el chip fijo + su contador.
function paraCotizarLabel() {
  return (chatState.labels || []).find(l => l.name === '📋 Para cotizar') || null;
}
function paraCotizarCount() {
  const l = paraCotizarLabel();
  if (!l) return 0;
  const cl = chatState.contactLabels || {};
  let n = 0;
  for (const p in cl) { if ((cl[p] || []).includes(l.id)) n++; }
  return n;
}

function renderContactLabelChips(phone) {
  const ids = chatState.contactLabels[phone] || [];
  if (!ids.length) return '';
  const vis = visibleLabels();
  return ids.map(id => {
    const l = vis.find(lb => lb.id === id);
    if (!l) return '';
    return `<span class="label-chip" style="background:${l.color}">${escapeHtml(l.name)}</span>`;
  }).join('');
}

function renderLabelFilterBar() {
  // Diseño tipo WhatsApp Web: chips fijos Todos / No leídos + dropdown
  // "Etiquetas ▾" que abre el listado de etiquetas custom. Mucho más compacto
  // que la lista vertical anterior, especialmente en desktop.
  const noFilters = !chatState.filterLabels.length && !chatState.filterUnreadOnly;
  const labelsCount = chatState.filterLabels.length;
  const ch = chatState.channel || 'wa';
  const chanTabs = `<div class="chat-channel-tabs" style="display:flex;border-bottom:1px solid var(--border);margin-bottom:4px">
    <button class="chat-channel-tab" data-channel="wa" style="flex:1;padding:8px 4px;background:none;border:none;border-bottom:2px solid ${ch==='wa'?'var(--accent-cyan,#8FD4DE)':'transparent'};color:${ch==='wa'?'var(--fg)':'var(--fg-subtle)'};font-weight:700;font-size:13px;cursor:pointer">💬 WhatsApp</button>
    <button class="chat-channel-tab" data-channel="ig" style="flex:1;padding:8px 4px;background:none;border:none;border-bottom:2px solid ${ch==='ig'?'#E1306C':'transparent'};color:${ch==='ig'?'var(--fg)':'var(--fg-subtle)'};font-weight:700;font-size:13px;cursor:pointer">📷 Instagram</button>
  </div>`;
  return chanTabs + `<div class="label-filter-bar" id="label-filter-bar">
    <button class="label-filter-pill${noFilters ? ' active' : ''}" data-filter-fixed="all">Todos</button>
    <button class="label-filter-pill${chatState.filterUnreadOnly ? ' active' : ''}" data-filter-fixed="unread">No leídos</button>
    ${(() => {
      const l = paraCotizarLabel();
      if (!l || isCursosOnly()) return '';   // bandeja de carteles: no aplica para el rol cursos (Abril)
      const n = paraCotizarCount();
      const active = chatState.filterLabels.length === 1 && chatState.filterLabels[0] === l.id;
      return `<button class="label-filter-pill${active ? ' active' : ''}" data-filter-fixed="paracotizar">📋 Para cotizar${n ? ` (${n})` : ''}</button>`;
    })()}
    ${visibleLabels().length ? `
      <div class="label-filter-dd-wrap">
        <button class="label-filter-pill label-filter-dd-btn${labelsCount ? ' active' : ''}" id="label-filter-dd-btn" aria-expanded="${chatState.labelDropdownOpen ? 'true' : 'false'}">
          Etiquetas${labelsCount ? ` (${labelsCount})` : ''}
          <span class="label-filter-dd-caret" aria-hidden="true">▾</span>
        </button>
        <div class="label-filter-dd-menu" id="label-filter-dd-menu" style="display:${chatState.labelDropdownOpen ? 'block' : 'none'}">
          ${visibleLabels().map(l => {
            const active = chatState.filterLabels.includes(l.id);
            return `<button class="label-filter-item${active ? ' active' : ''}" data-label-id="${l.id}">
              <span class="label-filter-item-dot" style="background:${l.color}"></span>
              <span class="label-filter-item-name">${escapeHtml(l.name)}</span>
              ${active ? '<span class="label-filter-item-check">✓</span>' : ''}
              <span class="label-filter-item-del" data-del-label="${l.id}" title="Eliminar etiqueta" style="margin-left:auto;padding:0 4px 0 10px;color:#8696a0;font-size:17px;line-height:1;cursor:pointer">×</span>
            </button>`;
          }).join('')}
          ${labelsCount ? `<button class="label-filter-clear" id="clear-label-filter">Limpiar etiquetas</button>` : ''}
          <div class="label-filter-newrow" style="display:flex;gap:4px;padding:6px;border-top:1px solid var(--border);margin-top:4px">
            <input id="label-filter-new-input" type="text" placeholder="Nueva etiqueta…" maxlength="40" autocomplete="off" style="flex:1;min-width:0;background:var(--bg-elev,#2a3942);border:1px solid var(--border);border-radius:6px;color:var(--fg);padding:5px 8px;font-size:13px" />
            <button id="label-filter-new-btn" title="Crear etiqueta" style="flex:0 0 auto;background:var(--accent-cyan,#8FD4DE);border:none;border-radius:6px;color:#0b141a;font-weight:700;padding:5px 11px;cursor:pointer;font-size:15px;line-height:1">+</button>
          </div>
        </div>
      </div>
    ` : ''}
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
      ${chatState.labels.map(l => `<button type="button" class="label-toggle-chip" data-lbl-id="${l.id}" style="--lc:${l.color}" aria-pressed="false">${escapeHtml(l.name)}</button>`).join('')}
    </div>
    <div id="bulk-count" style="color:#8696a0;font-size:12px;margin:6px 0"></div>
    <textarea id="bulk-msg" placeholder="Escribí el mensaje..." rows="3" class="bulk-textarea"></textarea>
    <button class="btn btn-cyan" id="bulk-send-btn" style="margin-top:8px;width:100%">Enviar masivo</button>
    <div id="bulk-result" style="margin-top:6px;font-size:13px"></div>
  </div>`;
}

// ============================================================
// INSIGHTS IA — dashboard con datos agregados del análisis de
// conversaciones con Claude. Los datos los provee el endpoint
// /admin/wa/insights del worker.
// ============================================================
const insightsState = { data: null, loading: false, error: null, productFilter: '', zoomOutcome: '', zoomList: null, zoomLoading: false };

function renderInsights() {
  if (!isAdmin()) return `<div class="page-head"><h1>Insights IA</h1></div><div class="error">Solo admin.</div>`;
  const d = insightsState.data;
  if (insightsState.loading && !d) {
    return `<div class="page-head"><h1>Insights IA</h1></div><div class="loading"><div class="spinner"></div><p style="margin-top:10px">Cargando análisis…</p></div>`;
  }
  if (!d) {
    return `<div class="page-head"><h1>Insights IA</h1><button class="btn" id="insights-refresh">↻ Cargar</button></div>${insightsState.error ? `<div class="error">${escapeHtml(insightsState.error)}</div>` : '<p style="opacity:.7">Cargando…</p>'}`;
  }
  const s = d.summary || {};
  const total = s.total || 0;
  const sold = s.sold || 0, lost = s.lost || 0, abandoned = s.abandoned || 0, inProgress = s.in_progress || 0, spam = s.spam || 0;
  const decided = sold + lost + abandoned;
  const conversionRate = decided > 0 ? Math.round((sold / decided) * 100) : 0;
  const explicitDecided = sold + lost;
  const explicitRate = explicitDecided > 0 ? Math.round((sold / explicitDecided) * 100) : 0;

  const pf = insightsState.productFilter;
  const tabs = [
    { v: '', label: 'TODO', count: '' },
    { v: 'cartel_personalizado', label: '🎨 Carteles', count: '' },
    { v: 'curso', label: '🎓 Cursos', count: '' },
    { v: 'tercerizacion', label: '🏭 Tercerización', count: '' },
    { v: 'franquicia', label: '⚙ Franquicia', count: '' }
  ];
  return `
    <div class="page-head">
      <h1>Insights IA</h1>
      <div style="display:flex;gap:8px;align-items:center">
        <span style="opacity:.6;font-size:13px">Total analizado: ${total} · Gastado: $${(d.total_cost_usd||0).toFixed(2)} USD</span>
        <button class="btn" id="insights-refresh">↻ Refrescar</button>
      </div>
    </div>
    <div class="ins-tabs">
      ${tabs.map(t => `<button class="ins-tab${pf === t.v ? ' active' : ''}" data-pf="${t.v}">${t.label}</button>`).join('')}
    </div>

    <div class="kpi-grid" style="margin-bottom:24px">
      <button class="kpi kpi-clickable${insightsState.zoomOutcome==='sold'?' kpi-active':''}" data-outcome="sold"><div class="kpi-label">VENTAS</div><div class="kpi-value" style="color:#22c55e">${sold}</div><div class="kpi-sub">${total ? Math.round(sold/total*100) : 0}% del total</div></button>
      <button class="kpi kpi-clickable${insightsState.zoomOutcome==='lost'?' kpi-active':''}" data-outcome="lost"><div class="kpi-label">PERDIDOS</div><div class="kpi-value" style="color:#ef4444">${lost}</div><div class="kpi-sub">decisión NO comprar</div></button>
      <button class="kpi kpi-clickable${insightsState.zoomOutcome==='abandoned_by_client'?' kpi-active':''}" data-outcome="abandoned_by_client"><div class="kpi-label">ABANDONADOS</div><div class="kpi-value" style="color:#f59e0b">${abandoned}</div><div class="kpi-sub">${total ? Math.round(abandoned/total*100) : 0}% — dejaron de responder</div></button>
      <button class="kpi kpi-clickable${insightsState.zoomOutcome==='in_progress'?' kpi-active':''}" data-outcome="in_progress"><div class="kpi-label">EN PROCESO</div><div class="kpi-value">${inProgress}</div><div class="kpi-sub">conversación activa</div></button>
      <div class="kpi"><div class="kpi-label">CONVERSIÓN</div><div class="kpi-value" style="color:#06b6d4">${conversionRate}%</div><div class="kpi-sub">de los decididos (incl. abandono)</div></div>
      <div class="kpi"><div class="kpi-label">CONV. EXPLÍCITA</div><div class="kpi-value" style="color:#06b6d4">${explicitRate}%</div><div class="kpi-sub">solo sold vs lost</div></div>
    </div>

    ${insightsState.zoomOutcome ? renderInsightsZoom() : ''}

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px">
      <div class="card">
        <h3 style="margin:0 0 12px">Conversiones por anuncio</h3>
        ${renderInsightsAdTable(d.by_ad || [])}
      </div>
      <div class="card">
        <h3 style="margin:0 0 12px">Por vertical de cliente</h3>
        ${renderInsightsTable(d.by_vertical || [], 'vertical')}
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px">
      <div class="card">
        <h3 style="margin:0 0 12px">Top objeciones que frenan ventas</h3>
        ${renderInsightsRankList(d.top_objections || [], 'objection', 'count')}
      </div>
      <div class="card">
        <h3 style="margin:0 0 12px">Top intent signals</h3>
        ${renderInsightsRankList(d.top_intents || [], 'intent', 'count')}
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px">
      <div class="card">
        <h3 style="margin:0 0 12px">Por tipo de producto</h3>
        ${renderInsightsProductTable(d.by_product || [])}
      </div>
      <div class="card">
        <h3 style="margin:0 0 12px">Sentiment final del cliente</h3>
        ${renderInsightsSentimentTable(d.by_sentiment || [])}
      </div>
    </div>

    <div class="card">
      <h3 style="margin:0 0 12px">Costo por modelo</h3>
      ${renderInsightsTable((d.by_model || []).map(m => ({ ...m, total: m.calls })), 'model_used', true)}
    </div>
  `;
}

function renderInsightsAdTable(rows) {
  if (!rows.length) return '<p style="opacity:.6">Sin datos todavía</p>';
  return `<table class="ins-table"><thead><tr>
    <th>Ad</th><th>Campaña</th><th>Total</th><th style="color:#22c55e">✓</th><th style="color:#ef4444">✗</th><th style="color:#f59e0b">👻</th><th>Conv%</th>
  </tr></thead><tbody>
  ${rows.map(r => {
    const decided = (r.sold||0) + (r.lost||0) + (r.abandoned||0);
    const rate = decided > 0 ? Math.round((r.sold||0)/decided*100) : 0;
    return `<tr><td title="${escapeHtml(r.ad_name)}">${escapeHtml((r.ad_name||'').slice(0,40))}</td>
      <td style="opacity:.6">${escapeHtml((r.campaign_name||'').slice(0,30))}</td>
      <td>${r.total}</td>
      <td style="color:#22c55e">${r.sold||0}</td>
      <td style="color:#ef4444">${r.lost||0}</td>
      <td style="color:#f59e0b">${r.abandoned||0}</td>
      <td>${rate}%</td>
    </tr>`;
  }).join('')}
  </tbody></table>`;
}

function renderInsightsTable(rows, keyField, simpleCount) {
  if (!rows.length) return '<p style="opacity:.6">Sin datos todavía</p>';
  if (simpleCount) {
    return `<table class="ins-table"><thead><tr><th>${keyField}</th><th>Calls</th><th>Costo USD</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${escapeHtml(r[keyField] || '-')}</td><td>${r.calls||r.total||0}</td><td>$${(r.cost||0).toFixed(2)}</td></tr>`).join('')}
    </tbody></table>`;
  }
  return `<table class="ins-table"><thead><tr>
    <th>${keyField}</th><th>Total</th><th style="color:#22c55e">✓</th><th style="color:#ef4444">✗</th><th style="color:#f59e0b">👻</th><th>Conv%</th>
  </tr></thead><tbody>
  ${rows.map(r => {
    const decided = (r.sold||0) + (r.lost||0) + (r.abandoned||0);
    const rate = decided > 0 ? Math.round((r.sold||0)/decided*100) : 0;
    return `<tr><td>${escapeHtml(r[keyField] || '-')}</td>
      <td>${r.total}</td>
      <td style="color:#22c55e">${r.sold||0}</td>
      <td style="color:#ef4444">${r.lost||0}</td>
      <td style="color:#f59e0b">${r.abandoned||0}</td>
      <td>${rate}%</td>
    </tr>`;
  }).join('')}
  </tbody></table>`;
}

function renderInsightsProductTable(rows) {
  if (!rows.length) return '<p style="opacity:.6">Sin datos todavía</p>';
  return `<table class="ins-table"><thead><tr><th>Producto</th><th>Total</th><th style="color:#22c55e">Ventas</th><th>%</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${escapeHtml(r.product_type)}</td><td>${r.total}</td><td style="color:#22c55e">${r.sold}</td><td>${r.total ? Math.round(r.sold/r.total*100):0}%</td></tr>`).join('')}
  </tbody></table>`;
}

function renderInsightsSentimentTable(rows) {
  if (!rows.length) return '<p style="opacity:.6">Sin datos todavía</p>';
  const colors = { positive: '#22c55e', neutral: '#9ca3af', negative: '#ef4444' };
  return `<table class="ins-table"><thead><tr><th>Sentiment</th><th>Cantidad</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td style="color:${colors[r.sentiment_final] || '#9ca3af'}">${escapeHtml(r.sentiment_final)}</td><td>${r.n}</td></tr>`).join('')}
  </tbody></table>`;
}

function renderInsightsRankList(rows, labelField, countField) {
  if (!rows.length) return '<p style="opacity:.6">Sin datos todavía</p>';
  const max = Math.max(...rows.map(r => r[countField] || 0));
  return `<ol class="ins-rank">
    ${rows.map(r => {
      const pct = max > 0 ? (r[countField] / max) * 100 : 0;
      return `<li>
        <div class="ins-rank-label">${escapeHtml(r[labelField] || '-')}</div>
        <div class="ins-rank-bar"><div class="ins-rank-fill" style="width:${pct}%"></div><span>${r[countField]}</span></div>
      </li>`;
    }).join('')}
  </ol>`;
}

// Renderiza la sección "drill-down" con la lista de chats del outcome elegido.
// Se monta debajo de las KPIs cuando insightsState.zoomOutcome no es vacío.
function renderInsightsZoom() {
  const o = insightsState.zoomOutcome;
  const titles = {
    sold: '🟢 Ventas confirmadas',
    lost: '🔴 Perdidos (decisión NO comprar)',
    abandoned_by_client: '🟠 Abandonados (clientes que dejaron de responder)',
    in_progress: '⚪ En proceso (conversaciones activas)'
  };
  const items = insightsState.zoomList || [];
  return `<div class="card" style="margin-bottom:24px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h3 style="margin:0">${titles[o] || o} <span style="opacity:.5;font-weight:400">(${items.length})</span></h3>
      <button class="btn btn-ghost" id="zoom-close">✕ Cerrar</button>
    </div>
    ${insightsState.zoomLoading
      ? '<div class="loading"><div class="spinner"></div></div>'
      : items.length === 0
        ? '<p style="opacity:.6">Sin chats en esta categoría todavía.</p>'
        : `<table class="ins-table">
            <thead><tr>
              <th>Cliente</th><th>Producto</th><th>Vertical</th><th>Ad</th>
              <th>Razón</th><th>Sentiment</th><th>Última msg</th><th></th>
            </tr></thead>
            <tbody>
              ${items.map(c => {
                const fmtTs = c.last_msg_ts ? new Date(c.last_msg_ts).toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'2-digit' }) : '-';
                const sentColors = { positive:'#22c55e', neutral:'#9ca3af', negative:'#ef4444' };
                return `<tr>
                  <td style="font-family:monospace;font-size:12px">${escapeHtml(c.phone)}</td>
                  <td>${escapeHtml((c.product_details||c.product_type||'').slice(0,50))}</td>
                  <td>${escapeHtml(c.vertical||'-')}</td>
                  <td style="opacity:.7">${escapeHtml((c.ad_name||'').slice(0,30))}</td>
                  <td style="font-size:12px;opacity:.85">${escapeHtml((c.outcome_reason||'').slice(0,80))}</td>
                  <td style="color:${sentColors[c.sentiment_final]||'#9ca3af'}">${escapeHtml(c.sentiment_final||'-')}</td>
                  <td style="font-size:12px;opacity:.7">${fmtTs}</td>
                  <td><button class="btn btn-sm" data-open-chat="${escapeHtml(c.phone)}">Ver chat →</button></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>`}
  </div>`;
}

async function loadInsightsZoom(outcome) {
  if (!CONFIG.trackerUrl || !STATE.token) return;
  insightsState.zoomLoading = true;
  insightsState.zoomList = null;
  render();
  const pf = insightsState.productFilter;
  const params = new URLSearchParams({ outcome, limit: '500' });
  if (pf) params.set('product_type', pf);
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/conversations?' + params.toString(), { headers: authHeaders() });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    insightsState.zoomList = j.conversations || [];
  } catch (e) {
    insightsState.zoomList = [];
  } finally {
    insightsState.zoomLoading = false;
    render();
  }
}

async function loadInsights() {
  if (!CONFIG.trackerUrl || !STATE.token) return;
  insightsState.loading = true;
  const pf = insightsState.productFilter;
  const q = pf ? '?product_type=' + encodeURIComponent(pf) : '';
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/insights' + q, { headers: authHeaders() });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    insightsState.data = await r.json();
    insightsState.error = null;
  } catch (e) {
    insightsState.error = e.message;
  } finally {
    insightsState.loading = false;
    render();
  }
}

function bindInsights() {
  // Carga inicial si no hay data
  if (!insightsState.data && !insightsState.loading) {
    loadInsights();
  }
  const btn = document.getElementById('insights-refresh');
  if (btn) btn.onclick = () => loadInsights();
  // Tabs de filtro por product_type
  document.querySelectorAll('.ins-tab').forEach(t => {
    t.onclick = () => {
      const pf = t.dataset.pf || '';
      if (pf === insightsState.productFilter) return;
      insightsState.productFilter = pf;
      insightsState.data = null; // force re-fetch
      insightsState.zoomOutcome = ''; // cierro el zoom al cambiar tab
      insightsState.zoomList = null;
      loadInsights();
    };
  });
  // KPIs clickeables — drill-down a lista de chats
  document.querySelectorAll('.kpi-clickable').forEach(k => {
    k.onclick = () => {
      const oc = k.dataset.outcome;
      if (insightsState.zoomOutcome === oc) {
        // Click en el mismo KPI cierra el zoom
        insightsState.zoomOutcome = '';
        insightsState.zoomList = null;
        render();
        return;
      }
      insightsState.zoomOutcome = oc;
      loadInsightsZoom(oc);
    };
  });
  // Cerrar el zoom
  const closeBtn = document.getElementById('zoom-close');
  if (closeBtn) closeBtn.onclick = () => {
    insightsState.zoomOutcome = '';
    insightsState.zoomList = null;
    render();
  };
  // Abrir el chat completo desde un row
  document.querySelectorAll('[data-open-chat]').forEach(b => {
    b.onclick = () => {
      const phone = b.dataset.openChat;
      STATE.view = 'chat';
      chatState.selectedPhone = phone;
      // Si el chat está en modo mobile WA-style, mostrar la conversación
      if (typeof enterMobileChatConversation === 'function') enterMobileChatConversation();
      try { selectChatContact(phone); } catch (_) {}
      location.hash = 'chat';
      render();
    };
  });
}

// ===== Copiloto: sugerencia de respuesta (Fase 2B) — sugiere, NO envía =====
// Pide una sugerencia al worker (POST /admin/wa/suggest-reply). Gasta solo al
// clickear. NUNCA envía: solo muestra el draft para revisar/editar/usar.
async function requestSuggestion(phone) {
  if (!phone) return;
  const btn = document.getElementById('btn-suggest');
  const panel = document.getElementById('suggest-panel');
  if (!panel) return;
  if (btn) btn.disabled = true;
  panel.style.display = 'block';
  panel.innerHTML = '<div class="suggest-loading">✨ Pensando una respuesta…</div>';
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/suggest-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ phone })
    });
    const j = await r.json();
    if (!r.ok || !j.ok) {
      panel.innerHTML = '<div class="suggest-row"><span class="suggest-err">No se pudo generar' + (j && j.error ? ': ' + escapeHtml(String(j.error)) : '') + '</span><button class="suggest-x" data-suggest-close>✕</button></div>';
    } else {
      chatState.lastSuggestion = { phone, draft: j.suggestion.draft || '', framework_version: j.framework_version || null, vertical: j.suggestion.vertical || '', _used: false };
      renderSuggestPanel(j);
      maybeRefreshCopilotCost();
    }
  } catch (e) {
    panel.innerHTML = '<div class="suggest-row"><span class="suggest-err">Error de red</span><button class="suggest-x" data-suggest-close>✕</button></div>';
  } finally {
    if (btn) btn.disabled = false;
    bindSuggestPanelActions();
  }
}

function renderSuggestPanel(j) {
  const panel = document.getElementById('suggest-panel');
  if (!panel) return;
  const s = j.suggestion || {};
  const warn = !!(s.low_confidence || s.should_escalate);
  const conf = Math.round((s.confidence || 0) * 100);
  const missing = Array.isArray(s.missing_info) ? s.missing_info : [];
  const sources = Array.isArray(s.sources_used) ? s.sources_used : [];
  panel.innerHTML = `
    <div class="suggest-head">
      <span class="suggest-title">✨ Sugerencia${s.vertical ? ' · ' + escapeHtml(s.vertical) : ''}</span>
      <span class="suggest-conf ${warn ? 'warn' : 'ok'}">${conf}%</span>
      <button class="suggest-x" data-suggest-close title="Descartar">✕</button>
    </div>
    ${warn ? `<div class="suggest-warn">⚠ Revisá antes de mandar${s.escalation_reason ? ': ' + escapeHtml(String(s.escalation_reason)) : ''}${missing.length ? '<br><b>Falta:</b> ' + escapeHtml(missing.join(', ')) : ''}</div>` : ''}
    ${(() => {
      // Mostramos la sugerencia PARTIDA en los mensajes que se van a mandar (uno por globo),
      // para que se vea que van separados (estilo humano del playbook).
      const msgs = String(s.draft || '').split(/\n[ \t]*\n+/).map(t => t.trim()).filter(Boolean);
      if (msgs.length <= 1) return `<div class="suggest-draft">${escapeHtml(s.draft || '')}</div>`;
      return `<div class="suggest-draft suggest-draft-multi" title="Se manda en ${msgs.length} mensajes separados">` +
        msgs.map(m => `<div class="suggest-msg" style="padding:5px 9px;background:rgba(255,255,255,.06);border-radius:9px;margin-bottom:4px">${escapeHtml(m)}</div>`).join('') +
        `<div class="suggest-msg-hint" style="font-size:11px;opacity:.6;margin-top:2px">↑ ${msgs.length} mensajes separados</div></div>`;
    })()}
    ${sources.length ? `<div class="suggest-src">basado en: ${escapeHtml(sources.join(' · '))}</div>` : ''}
    <div class="suggest-actions">
      <button class="suggest-use" data-suggest-use>Usar ✍️</button>
      <button class="suggest-dismiss" data-suggest-close>Descartar</button>
    </div>`;
  bindSuggestPanelActions();
}

function bindSuggestPanelActions() {
  const panel = document.getElementById('suggest-panel');
  if (!panel) return;
  const useBtn = panel.querySelector('[data-suggest-use]');
  if (useBtn) useBtn.onclick = useSuggestion;
  panel.querySelectorAll('[data-suggest-close]').forEach(el => { el.onclick = dismissSuggestion; });
}

function useSuggestion() {
  const ta = document.getElementById('chat-input');
  const s = chatState.lastSuggestion;
  if (ta && s) {
    ta.value = s.draft;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    ta.focus();
    s._used = true;
  }
  const panel = document.getElementById('suggest-panel');
  if (panel) panel.style.display = 'none';
}

function dismissSuggestion(e) {
  if (e && e.preventDefault) e.preventDefault();
  const s = chatState.lastSuggestion;
  if (s && !s._used) logSuggestionFeedback(s, '', 'ignored');
  chatState.lastSuggestion = null;
  const panel = document.getElementById('suggest-panel');
  if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
}

function logSuggestionFeedback(s, finalText, action) {
  if (!s) return;
  try {
    fetch(CONFIG.trackerUrl + '/admin/suggestion-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ phone: s.phone, suggested_text: s.draft, final_text: finalText, action, framework_version: s.framework_version, vertical: s.vertical })
    });
  } catch (_) {}
}

async function maybeRefreshCopilotCost() {
  if (typeof getUserRole === 'function' && getUserRole() !== 'admin') return;
  // Solo pega al endpoint si hay algo en pantalla que llenar (contador del
  // toolbar o tarjeta del panel admin). Evita fetches innecesarios.
  const costEl = document.getElementById('copilot-cost');
  const statsEl = document.getElementById('copilot-admin-stats');
  if (!costEl && !statsEl) return;
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/copilot/usage', { headers: { ...authHeaders() } });
    const j = await r.json();
    if (j && j.ok) {
      if (costEl) costEl.textContent = `🤖 $${(j.month.cost_usd || 0).toFixed(2)}`;
      if (statsEl) statsEl.innerHTML = renderCopilotStatsHTML(j);
    }
  } catch (_) {
    if (statsEl) statsEl.innerHTML = '<div class="muted" style="padding:16px">No se pudo cargar el uso del copiloto</div>';
  }
}

// Pinta el detalle de uso del copiloto en el panel admin. j = respuesta de
// GET /admin/copilot/usage. Muestra el mes en curso (generadas / enviadas tal
// cual / editadas / descartadas / costo) + histórico con tasa "tal cual".
function renderCopilotStatsHTML(j) {
  const m = j.month || {}, t = j.total || {};
  const gen = m.generated || 0, sent = m.sent || 0, edited = m.edited || 0, ignored = m.ignored || 0;
  // Tasa "tal cual" = de las que se mandaron (tal cual + editadas), cuántas
  // salieron sin tocar. Señal de qué tan buena viene la sugerencia.
  const usadas = (t.sent || 0) + (t.edited || 0);
  const tasaTalCual = usadas > 0 ? Math.round((t.sent || 0) / usadas * 100) : null;
  return `
    <div class="kpi-grid" style="margin-bottom:var(--s-3)">
      <div class="kpi cyan"><div class="kpi-label">Generadas (mes)</div><div class="kpi-value">${gen}</div></div>
      <div class="kpi"><div class="kpi-label">Enviadas tal cual</div><div class="kpi-value">${sent}</div></div>
      <div class="kpi"><div class="kpi-label">Editadas</div><div class="kpi-value">${edited}</div></div>
      <div class="kpi"><div class="kpi-label">Descartadas</div><div class="kpi-value">${ignored}</div></div>
    </div>
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">Costo del mes</div><div class="kpi-value">$${(m.cost_usd || 0).toFixed(2)}</div></div>
      <div class="kpi"><div class="kpi-label">Tasa "tal cual"</div><div class="kpi-value">${tasaTalCual == null ? '—' : tasaTalCual + '%'}</div></div>
      <div class="kpi"><div class="kpi-label">Edición prom.</div><div class="kpi-value">${t.avg_edit_distance || 0}</div></div>
      <div class="kpi"><div class="kpi-label">Generadas (total)</div><div class="kpi-value">${t.generated || 0}</div></div>
    </div>
    <div class="muted" style="font-size:12px;margin-top:var(--s-2)">Histórico: ${t.sent || 0} enviadas tal cual · ${t.edited || 0} editadas · ${t.ignored || 0} descartadas · $${(t.cost_usd || 0).toFixed(2)} gastado en total</div>
  `;
}

// ===== Fase 2C: mejoras al playbook (panel admin) =====
async function loadImprovements() {
  if (typeof getUserRole === 'function' && getUserRole() !== 'admin') return;
  const el = document.getElementById('copilot-improvements');
  if (!el) return;
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/framework/improvements?status=pending', { headers: { ...authHeaders() } });
    const j = await r.json();
    el.innerHTML = (j && j.ok) ? renderImprovementsHTML(j) : '<div class="muted" style="font-size:12px">no se pudo cargar</div>';
  } catch (_) { el.innerHTML = '<div class="muted" style="font-size:12px">no se pudo cargar</div>'; }
}

function renderImprovementsHTML(j) {
  const items = (j && j.improvements) || [];
  const lr = j && j.last_run;
  const lastLine = lr ? `<div class="muted" style="font-size:11px;margin-top:8px">última síntesis: ${new Date(lr.created_at).toLocaleString('es-AR')}${lr.cost_usd != null ? ' · $' + (+lr.cost_usd).toFixed(2) : ''}${lr.created_by ? ' · ' + escapeHtml(lr.created_by) : ''}</div>` : '';
  if (!items.length) {
    return `<div class="muted" style="font-size:13px;line-height:1.5">No hay propuestas pendientes. El sistema aprende de cada sugerencia que editás o descartás. Cuando junta señal suficiente (o tocás "Generar ahora") te propone acá mejoras concretas al guión para que las apruebes vos. Nada se cambia sin tu OK.</div>${lastLine}`;
  }
  return items.map(it => {
    const conf = it.confidence != null ? Math.round(it.confidence * 100) + '%' : '';
    return `<div class="improve-item">
      <div class="improve-head">
        <span class="improve-vert improve-vert-${escapeHtml(it.vertical || 'general')}">${escapeHtml(it.vertical || 'general')}</span>
        <span class="improve-title">${escapeHtml(it.title || '')}</span>
        ${conf ? `<span class="muted" style="font-size:11px">conf ${conf}</span>` : ''}
      </div>
      ${it.rationale ? `<div class="improve-txt">${escapeHtml(it.rationale)}</div>` : ''}
      ${it.evidence ? `<div class="improve-txt muted"><b>Evidencia:</b> ${escapeHtml(it.evidence)}</div>` : ''}
      <div class="muted" style="font-size:11px;margin-top:4px">→ ${escapeHtml(it.operation || 'append')} · sección "${escapeHtml(it.target_heading || '(nueva)')}"</div>
      <details style="margin-top:6px"><summary style="cursor:pointer;font-size:12px;color:var(--neon-cyan)">Ver texto propuesto</summary><pre class="improve-content">${escapeHtml(it.proposed_content || '')}</pre></details>
      <div class="improve-actions">
        <button class="suggest-use" onclick="approveImprovement(${it.id}, this)">Aprobar y aplicar</button>
        <button class="suggest-dismiss" onclick="rejectImprovement(${it.id}, this)">Rechazar</button>
      </div>
    </div>`;
  }).join('') + lastLine;
}

async function generateImprovements(btn) {
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Analizando...'; }
  const el = document.getElementById('copilot-improvements');
  if (el) el.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/framework/improvements/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ force: true })
    });
    const j = await r.json();
    if (j && j.ok) {
      if (j.generated === 0) {
        if (el) el.innerHTML = `<div class="muted" style="font-size:13px;line-height:1.5">${escapeHtml(j.reason || 'no encontró mejoras sólidas para proponer esta vez')}</div>`;
      } else { await loadImprovements(); }
    } else if (el) {
      el.innerHTML = `<div class="suggest-err" style="font-size:12px">${escapeHtml(j.error || 'falló la síntesis')}</div>`;
    }
  } catch (_) { if (el) el.innerHTML = '<div class="suggest-err" style="font-size:12px">error de red</div>'; }
  finally { if (btn) { btn.disabled = false; btn.textContent = '✨ Generar ahora'; } }
}

async function approveImprovement(id, btn) {
  if (!confirm('Aprobar esta mejora? Se crea una versión nueva del playbook con el cambio aplicado y queda activa al toque.')) return;
  if (btn) btn.disabled = true;
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/framework/improvements/approve', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ id })
    });
    const j = await r.json();
    if (j && j.ok) { await loadImprovements(); }
    else { alert('No se pudo aplicar: ' + (j.error || 'error')); if (btn) btn.disabled = false; }
  } catch (_) { alert('Error de red'); if (btn) btn.disabled = false; }
}

async function rejectImprovement(id, btn) {
  const note = prompt('Por qué la rechazás? (opcional — ayuda a la próxima síntesis)');
  if (note === null) return; // canceló el prompt
  if (btn) btn.disabled = true;
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/framework/improvements/reject', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ id, note })
    });
    const j = await r.json();
    if (j && j.ok) { await loadImprovements(); }
    else { alert('No se pudo: ' + (j.error || 'error')); if (btn) btn.disabled = false; }
  } catch (_) { alert('Error de red'); if (btn) btn.disabled = false; }
}
window.generateImprovements = generateImprovements;
window.approveImprovement = approveImprovement;
window.rejectImprovement = rejectImprovement;

// ===== Panel de costos del sitio (admin) =====
let costsState = { data: null, editingId: null, adding: false, gemini: null };

async function loadCosts() {
  if (typeof getUserRole === 'function' && getUserRole() !== 'admin') return;
  const el = document.getElementById('costs-panel');
  if (!el) return;
  try {
    const [rc, rg] = await Promise.all([
      fetch(CONFIG.trackerUrl + '/admin/costs', { headers: { ...authHeaders() } }),
      fetch(CONFIG.trackerUrl + '/admin/gemini/usage', { headers: { ...authHeaders() } }).catch(() => null)
    ]);
    if (rg) { try { const g = await rg.json(); if (g && g.ok) costsState.gemini = g; } catch (_) {} }
    const j = await rc.json();
    if (j && j.ok) { costsState.data = j; renderCostsPanel(); }
    else el.innerHTML = '<div class="muted" style="font-size:12px">no se pudo cargar</div>';
  } catch (_) { el.innerHTML = '<div class="muted" style="font-size:12px">no se pudo cargar</div>'; }
}

function renderCostsPanel() {
  const el = document.getElementById('costs-panel');
  if (el) el.innerHTML = renderCostsHTML(costsState.data);
}

const COST_CAT_LABEL = { ia: 'IA', infra: 'Infra', mensajeria: 'Mensajería', almacenamiento: 'Almacenam.', ads: 'Ads', otro: 'Otro' };

function costAmtDisplay(s) {
  if (s.cost_type === 'auto') return `auto · $${(s.monthly_usd || 0).toFixed(2)}`;
  if (s.cost_type === 'free') return 'gratis';
  if (s.monthly_usd == null) return '⚠ definí el tipo de cambio';
  const native = s.cost_currency !== 'USD' ? ` (${s.cost_amount} ${s.cost_currency})` : '';
  const est = s.cost_type === 'usage' ? ' est.' : '';
  return `$${(s.monthly_usd || 0).toFixed(2)}${est}${native}`;
}

function renderCostsHTML(j) {
  if (!j) return '<div class="loading"><div class="spinner"></div></div>';
  const services = j.services || [];
  const t = j.totals || {};
  const pv = j.provider || {};
  const anth = j.anthropic || {};
  const infra = services.filter(s => s.category !== 'ads');
  const ads = services.filter(s => s.category === 'ads');

  const totalsHead = `
    <div class="kpi-grid" style="margin-bottom:var(--s-3)">
      <div class="kpi cyan"><div class="kpi-label">Infra del sitio / mes</div><div class="kpi-value">$${(t.infra_usd || 0).toFixed(2)}${t.infra_incomplete ? ' <span class="muted" style="font-size:11px">+faltan</span>' : ''}</div></div>
      <div class="kpi"><div class="kpi-label">Anthropic (Claude) / mes</div><div class="kpi-value">$${(anth.total || 0).toFixed(2)}</div></div>
      <div class="kpi"><div class="kpi-label" title="Gasto trackeado por el CRM en cada llamada a Gemini (render, medidas, transcripción, diseño). Se actualiza al toque; puede diferir un poco del billing de Google Cloud, que además tarda ~1 día.">Gemini / mes (en vivo)</div><div class="kpi-value">$${(((costsState.gemini||{}).month||{}).cost_usd || 0).toFixed(2)}</div>${(costsState.gemini||{}).month ? `<div class="kpi-delta">${costsState.gemini.month.renders || 0} renders · hoy $${(((costsState.gemini||{}).today||{}).cost_usd || 0).toFixed(2)}</div>` : ''}</div>
      <div class="kpi"><div class="kpi-label">Ads / mes (aparte)</div><div class="kpi-value">$${(t.ads_usd || 0).toFixed(2)}${t.ads_incomplete ? ' <span class="muted" style="font-size:11px">+faltan</span>' : ''}</div></div>
    </div>
    <div class="muted" style="font-size:12px;margin-bottom:var(--s-2)">IA total (Claude + Gemini): <b>$${((anth.total || 0) + ((((costsState.gemini||{}).month||{}).cost_usd) || 0)).toFixed(2)}</b> · copiloto $${(anth.suggest || 0).toFixed(2)} · análisis $${(anth.analysis || 0).toFixed(2)} · síntesis $${(anth.synthesis || 0).toFixed(2)} · Gemini $${((((costsState.gemini||{}).month||{}).cost_usd) || 0).toFixed(2)}</div>`;

  const itemHtml = (s) => {
    if (costsState.editingId === s.id) return editFormHtml(s);
    const billing = s.billing_url ? `<a href="${escapeHtml(s.billing_url)}" target="_blank" rel="noopener" class="cost-link">facturación ↗</a>` : '';
    const acts = s.cost_type === 'auto'
      ? '<span class="muted" style="font-size:11px">calculado solo</span>'
      : `<button class="cost-btn" onclick="startEditCost(${s.id})">editar</button><button class="cost-btn cost-btn-del" onclick="deleteCost(${s.id})">quitar</button>`;
    return `<div class="cost-item">
      <div class="cost-row1">
        <span class="cost-cat cost-cat-${escapeHtml(s.category)}">${COST_CAT_LABEL[s.category] || s.category}</span>
        <span class="cost-name">${escapeHtml(s.name)}</span>
        <span class="cost-amt">${costAmtDisplay(s)}</span>
      </div>
      ${s.usage ? `<div class="cost-usage">${escapeHtml(s.usage)}</div>` : ''}
      ${s.credential_location ? `<div class="cost-cred">🔑 ${escapeHtml(s.credential_location)}</div>` : ''}
      ${s.notes ? `<div class="cost-notes">${escapeHtml(s.notes)}</div>` : ''}
      <div class="cost-actions">${billing}${acts}</div>
    </div>`;
  };

  const editFormHtml = (s) => {
    const cur = c => s.cost_currency === c ? 'selected' : '';
    const typ = tp => s.cost_type === tp ? 'selected' : '';
    return `<div class="cost-item cost-editing">
      <div class="cost-name">${escapeHtml(s.name)}</div>
      <div class="cost-edit-grid">
        <label>Costo mensual<input type="number" step="0.01" id="cost-amount-${s.id}" value="${s.cost_amount}"></label>
        <label>Moneda<select id="cost-cur-${s.id}"><option ${cur('USD')}>USD</option><option ${cur('ARS')}>ARS</option><option ${cur('EUR')}>EUR</option></select></label>
        <label>Tipo<select id="cost-type-${s.id}"><option value="fixed" ${typ('fixed')}>fijo</option><option value="usage" ${typ('usage')}>variable</option><option value="free" ${typ('free')}>gratis</option></select></label>
      </div>
      <label class="cost-full">Notas<input type="text" id="cost-notes-${s.id}" value="${escapeHtml(s.notes || '')}"></label>
      <div class="cost-actions">
        <button class="suggest-use" onclick="saveCost(${s.id})">Guardar</button>
        <button class="suggest-dismiss" onclick="cancelEditCost()">Cancelar</button>
      </div>
    </div>`;
  };

  const rateLine = `<div class="cost-rate">Tipo de cambio USD→ARS: <input type="number" id="cost-rate-input" value="${j.fx_usd_ars || ''}" placeholder="ej 1200" style="width:90px"> <button class="cost-btn" onclick="saveRate()">guardar</button> ${j.fx_usd_ars ? '' : '<span class="muted" style="font-size:11px">⚠ sin definir — los montos en ARS no se suman al total</span>'}</div>`;

  const addBlock = costsState.adding ? `
    <div class="cost-item cost-editing">
      <div class="cost-name">Nuevo servicio</div>
      <label class="cost-full">Nombre<input type="text" id="newcost-name" placeholder="ej OpenAI, dominio, etc"></label>
      <div class="cost-edit-grid">
        <label>Categoría<select id="newcost-cat"><option value="ia">IA</option><option value="infra">Infra</option><option value="mensajeria">Mensajería</option><option value="almacenamiento">Almacenam.</option><option value="ads">Ads</option><option value="otro">Otro</option></select></label>
        <label>Costo mensual<input type="number" step="0.01" id="newcost-amount" value="0"></label>
        <label>Moneda<select id="newcost-cur"><option>USD</option><option>ARS</option><option>EUR</option></select></label>
      </div>
      <label class="cost-full">Qué hace<input type="text" id="newcost-usage"></label>
      <label class="cost-full">Dónde está la credencial<input type="text" id="newcost-cred"></label>
      <div class="cost-actions">
        <button class="suggest-use" onclick="addCostService()">Agregar</button>
        <button class="suggest-dismiss" onclick="cancelAddCost()">Cancelar</button>
      </div>
    </div>` : `<button class="btn btn-ghost" onclick="startAddCost()" style="margin-top:var(--s-2)">+ Agregar servicio</button>`;

  const blockBanner = pv.wa_billing_blocked
    ? `<div class="cost-block-banner">🔴 WhatsApp BLOQUEADO por pago — cargá saldo en <a href="https://hub.360dialog.com" target="_blank" rel="noopener">hub.360dialog.com</a>. Envíos automáticos pausados; se reanudan solos al destrabarse. <button class="cost-btn" onclick="resumeWa()" style="margin-left:6px">reanudar ahora</button></div>`
    : '';
  const provLine = blockBanner + `<div class="muted" style="font-size:11px;margin-top:var(--s-3);border-top:1px solid var(--border);padding-top:var(--s-2)">
    WhatsApp activo: <b>${escapeHtml(pv.wa_provider || '?')}</b>${pv.wa_billing_blocked ? ' <span style="color:#ff6b6b">(bloqueado)</span>' : ''} · credenciales configuradas: 360dialog ${pv.has_d360_key ? '✓' : '✗'} · Anthropic ${pv.has_anthropic_key ? '✓' : '✗'} · Meta token ${pv.has_wa_token ? '✓' : '✗'}
    ${j.usage ? `<br>uso del mes: ${j.usage.wa_outbound_msgs} mensajes salientes a ${j.usage.wa_conversations} contactos` : ''}
  </div>`;

  return totalsHead +
    infra.map(itemHtml).join('') +
    (ads.length ? `<div class="cost-sep">Marketing (aparte del total de infra)</div>` + ads.map(itemHtml).join('') : '') +
    addBlock + rateLine + provLine;
}

function startEditCost(id) { costsState.editingId = id; costsState.adding = false; renderCostsPanel(); }
function cancelEditCost() { costsState.editingId = null; renderCostsPanel(); }
function startAddCost() { costsState.adding = true; costsState.editingId = null; renderCostsPanel(); }
function cancelAddCost() { costsState.adding = false; renderCostsPanel(); }

async function postCosts(payload) {
  const r = await fetch(CONFIG.trackerUrl + '/admin/costs', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload)
  });
  return await r.json();
}

async function saveCost(id) {
  const amount = parseFloat((document.getElementById('cost-amount-' + id) || {}).value);
  const cur = (document.getElementById('cost-cur-' + id) || {}).value;
  const type = (document.getElementById('cost-type-' + id) || {}).value;
  const notes = (document.getElementById('cost-notes-' + id) || {}).value;
  const orig = (costsState.data.services || []).find(s => s.id === id) || {};
  const j = await postCosts({ action: 'upsert', service: { id, name: orig.name, category: orig.category, provider: orig.provider, usage: orig.usage, credential_location: orig.credential_location, billing_url: orig.billing_url, sort_order: orig.sort_order, cost_amount: isFinite(amount) ? amount : 0, cost_currency: cur, cost_type: type, notes } });
  if (j && j.ok) { costsState.editingId = null; await loadCosts(); }
  else alert('No se pudo guardar: ' + ((j && j.error) || 'error'));
}

async function addCostService() {
  const name = (document.getElementById('newcost-name') || {}).value;
  if (!name || !name.trim()) { alert('Poné un nombre'); return; }
  const j = await postCosts({ action: 'upsert', service: {
    name: name.trim(),
    category: (document.getElementById('newcost-cat') || {}).value,
    cost_amount: parseFloat((document.getElementById('newcost-amount') || {}).value) || 0,
    cost_currency: (document.getElementById('newcost-cur') || {}).value,
    usage: (document.getElementById('newcost-usage') || {}).value,
    credential_location: (document.getElementById('newcost-cred') || {}).value,
    cost_type: 'fixed', sort_order: 90
  } });
  if (j && j.ok) { costsState.adding = false; await loadCosts(); }
  else alert('No se pudo agregar: ' + ((j && j.error) || 'error'));
}

async function deleteCost(id) {
  if (!confirm('Quitar este servicio del panel de costos?')) return;
  const j = await postCosts({ action: 'delete', id });
  if (j && j.ok) await loadCosts();
  else alert('No se pudo quitar');
}

async function saveRate() {
  const r = parseFloat((document.getElementById('cost-rate-input') || {}).value);
  if (!isFinite(r) || r <= 0) { alert('Poné un tipo de cambio válido'); return; }
  const j = await postCosts({ action: 'set_rate', usd_ars: r });
  if (j && j.ok) await loadCosts();
  else alert('No se pudo guardar el tipo de cambio');
}

async function resumeWa() {
  if (!confirm('Reanudar los envíos automáticos de WhatsApp? Hacelo solo si ya cargaste saldo en 360dialog.')) return;
  const j = await postCosts({ action: 'resume_wa' });
  if (j && j.ok) await loadCosts();
  else alert('No se pudo reanudar');
}

window.startEditCost = startEditCost;
window.resumeWa = resumeWa;
window.cancelEditCost = cancelEditCost;
window.startAddCost = startAddCost;
window.cancelAddCost = cancelAddCost;
window.saveCost = saveCost;
window.addCostService = addCostService;
window.deleteCost = deleteCost;
window.saveRate = saveRate;

function renderChat() {
  if (!canAccessChat()) {
    return `<div class="page-head"><h1>Chat WhatsApp</h1></div><div class="error">No autorizado. Logueate con un usuario autorizado.</div>`;
  }
  // Al (re)armar la página de chat arrancamos mostrando los más recientes; el
  // scroll va sumando. Sin esto pintaríamos los 7000+ contactos de una sola vez.
  chatState.contactRenderLimit = CHAT_CONTACT_PAGE;
  const search = chatState.search.toLowerCase();
  let filtered = chatState.contacts.filter(c => (c.channel || 'wa') === (chatState.channel || 'wa'));
  // Archivados: por defecto fuera. Solo se muestran si chatState.showArchived = true.
  if (chatState.showArchived) {
    filtered = filtered.filter(c => isArchived(c.phone));
  } else {
    filtered = filtered.filter(c => !isArchived(c.phone));
  }
  if (search) {
    filtered = filtered.filter(c =>
      (c.name || '').toLowerCase().includes(search) ||
      c.phone.includes(search) ||
      (c.lastMsg || '').toLowerCase().includes(search));
  }
  // Filter por "No leídos" (chip fijo del top de la barra).
  if (chatState.filterUnreadOnly) {
    filtered = filtered.filter(c => (c.unread || 0) > 0);
  }
  // Filter by labels
  if (chatState.filterLabels.length) {
    filtered = filtered.filter(c => {
      const cLabels = chatState.contactLabels[c.phone] || [];
      return chatState.filterLabels.every(lid => cLabels.includes(lid));
    });
  }

  // Windowing: solo pintamos los primeros N (orden por recencia, ver línea 7113).
  // El resto se alcanza scrolleando (suma páginas) o buscando.
  chatState._lastFilteredCount = filtered.length;
  const visibleContacts = filtered.slice(0, chatState.contactRenderLimit);

  return `
    <div class="chat-layout">
      <div class="chat-contacts">
        ${renderPrecotizControl()}
        <h1 class="chat-mobile-title">Chats</h1>
        <div class="chat-contacts-header">
          <button id="chat-fullscreen" class="chat-fullscreen-btn" title="Ocultar barra lateral">
            <svg class="ico-enter" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M5 5h5V3H3v7h2V5zm9-2v2h5v5h2V3h-7zm5 16h-5v2h7v-7h-2v5zM5 14H3v7h7v-2H5v-5z"/></svg>
            <svg class="ico-exit" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="display:none"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>
          </button>
          <div style="display:flex;gap:4px">
            <button class="btn-send" id="btn-new-chat" style="width:34px;height:34px;font-size:14px" title="Nuevo chat (a un número nuevo)">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9h-3v3h-2v-3h-3V9h3V6h2v3h3v2z"/></svg>
            </button>
            <button class="btn-send" id="btn-bulk" style="width:34px;height:34px;font-size:14px" title="Mensaje masivo">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/><path d="M7 9h2v2H7zM11 9h2v2h-2zM15 9h2v2h-2z"/></svg>
            </button>
            <button class="btn-send" id="btn-manage-labels" style="width:34px;height:34px;font-size:14px" title="Gestionar etiquetas">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16z"/></svg>
            </button>
            <button class="btn-send" id="btn-manage-qr" style="width:34px;height:34px;font-size:14px" title="Respuestas rápidas">/ </button>
            <button class="btn-send ${chatState.showArchived ? 'active' : ''}" id="btn-toggle-archived" style="width:34px;height:34px;font-size:14px" title="${chatState.showArchived ? 'Volver a chats activos' : 'Ver chats archivados'}">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/></svg>
            </button>
            <button class="btn-send" id="chat-refresh" style="width:34px;height:34px;font-size:16px" title="Actualizar">↻</button>
            ${getUserRole() === 'admin' ? '<span id="copilot-cost" class="copilot-cost" title="Gasto IA del mes en sugerencias"></span>' : ''}
          </div>
        </div>
        <div class="chat-contacts-search">
          <input type="text" id="chat-search" placeholder="${chatState.showArchived ? 'Buscar en archivados…' : 'Buscar o empezar un chat nuevo'}" value="${escapeHtml(chatState.search)}">
        </div>
        <div id="new-chat-suggest" class="new-chat-suggest" style="display:none"></div>
        ${chatState.showArchived ? '<div class="archived-banner">📦 Mostrando solo chats archivados</div>' : ''}
        ${(() => {
          // Fila estilo WA "Archivados · N" — solo si NO estamos viendo archivados
          // y hay alguno. CSS la oculta en desktop (botón del header sigue ahí).
          if (chatState.showArchived) return '';
          const archCount = chatState.contacts.filter(c => isArchived(c.phone)).length;
          if (!archCount) return '';
          return `<button class="chat-archived-row" id="chat-archived-row" type="button">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" style="flex-shrink:0;color:#8696a0"><path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/></svg>
            <span class="chat-archived-label">Archivados</span>
            <span class="chat-archived-count">${archCount}</span>
          </button>`;
        })()}
        ${renderLabelFilterBar()}
        <div class="chat-contact-list" id="chat-contact-list">
          ${chatState.loading && !chatState.contacts.length ? '<div style="padding:30px;text-align:center"><div class="spinner" style="border-color:#2a3942;border-top-color:#00a884"></div></div>' : ''}
          ${visibleContacts.map(c => renderContactItem(c)).join('')}
          ${!chatState.loading && !filtered.length ? `<div class="chat-empty-state">${chatState.showArchived ? '<div class="chat-empty-emoji">📦</div>No hay chats archivados' : '<div class="chat-empty-emoji">👋</div>Sin conversaciones'}</div>` : ''}
        </div>
        ${renderBulkSection()}
      </div>
      <div class="chat-main">
        ${chatState.selectedPhone ? renderChatConversation() : renderChatNoSelect()}
      </div>
    </div>
    ${renderQuickCreateModal()}
  `;
}

// Cache global del HTML de cada item del sidebar. Reduces drásticamente el
// costo de refreshContactList (de ~500ms a <50ms para 1000+ chats) porque
// el polling cada 4s casi nunca cambia el 99% de los items. Solo regeneramos
// el HTML si CAMBIÓ algún campo relevante (visible en _contactItemKey).
const _contactItemCache = new Map();
function _contactItemKey(c) {
  // Key estable que captura todo lo que afecta el HTML renderizado.
  // Si cualquiera de estos cambia, regeneramos. Sino, reusamos el cache.
  const labels = (chatState.contactLabels[c.phone] || []).join(',');
  const isActive = chatState.selectedPhone === c.phone ? '1' : '0';
  return `${c.phone}|${c.name || ''}|${c.lastTs || ''}|${c.unread || 0}|${c.lastDir || ''}|${c.lastType || ''}|${c.lastMsg || ''}|${isActive}|${labels}`;
}
function renderContactItem(c) {
  // Cache hit: HTML idéntico al previo. Devolvemos directo sin recomputar.
  const cached = _contactItemCache.get(c.phone);
  const key = _contactItemKey(c);
  if (cached && cached.key === key) return cached.html;

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
  else if (preview.startsWith('[ubicacion]')) preview = '📍 Ubicación';
  else if (preview.startsWith('[contacto]')) preview = '👤 Contacto';
  else if (preview.startsWith('[pedido]')) preview = '🛒 Pedido';
  else if (preview.startsWith('[mensaje no disponible]')) preview = '⚠ Mensaje no disponible';
  else if (preview.startsWith('[tipo de mensaje no soportado')) preview = '⚠ Mensaje no compatible';
  else if (preview.startsWith('[no soportado')) preview = '⚠ No soportado';
  else if (c.lastType === 'unsupported') preview = '⚠ No compatible';
  else if (c.lastType === 'sticker') preview = '🏷 Sticker';
  else if (c.lastType === 'video') preview = '🎥 Video';
  else if (c.lastType === 'document') preview = '📄 ' + preview;

  const hasUnread = (c.unread || 0) > 0;
  const isActive = chatState.selectedPhone === c.phone;

  const html = `
    <div class="chat-contact ${isActive ? 'active' : ''}${hasUnread ? ' has-unread' : ''}" data-chat-phone="${escapeHtml(c.phone)}">
      ${avatarHtml(c.phone, c.name, 49)}
      <div class="chat-contact-info">
        <div class="chat-contact-top">
          <div class="chat-contact-name">${escapeHtml(c.name || formatPhoneDisplay(c.phone))}</div>
          <div class="chat-contact-time${hasUnread ? ' unread' : ''}">${formatChatTime(c.lastTs)}</div>
        </div>
        <div class="chat-contact-bottom">
          <div class="chat-contact-preview" title="${escapeHtml(preview)}">${previewIcon}${escapeHtml(preview)}</div>
          <div style="display:flex;align-items:center;gap:4px">
            ${renderContactLabelChips(c.phone)}
            ${hasUnread ? `<div class="chat-contact-unread">${c.unread > 99 ? '99+' : c.unread}</div>` : ''}
          </div>
        </div>
      </div>
    </div>
  `;
  _contactItemCache.set(c.phone, { key, html });
  return html;
}

// Devuelve el ts del último inbound del contacto seleccionado, o null.
function lastInboundTs() {
  const msgs = chatState.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.direction === 'inbound' && m.msg_type !== 'reaction') return m.ts;
  }
  return null;
}

// La "ventana de 24h" está abierta si hubo un inbound (que no sea reacción)
// dentro de las últimas 24 horas. Si no, hay que mandar un template.
function is24hWindowOpen() {
  const last = lastInboundTs();
  if (!last) return false;
  const ageMs = Date.now() - new Date(last).getTime();
  return ageMs < 24 * 60 * 60 * 1000;
}

function render24hBanner() {
  if (is24hWindowOpen()) return '';
  const last = lastInboundTs();
  const sub = last
    ? `Última respuesta del cliente ${formatRelativeTime(last)}. Solo se puede escribir con plantilla aprobada.`
    : 'Sin mensajes previos del cliente. Solo se puede escribir con plantilla aprobada.';
  return `<div class="window24-banner">
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="flex-shrink:0"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
    <div class="w24-text">
      <span class="w24-title">Ventana de 24h cerrada</span>
      <span class="w24-sub"> · ${escapeHtml(sub)}</span>
    </div>
  </div>`;
}

function formatRelativeTime(ts) {
  const ms = Date.now() - new Date(ts).getTime();
  const h = Math.floor(ms / (60 * 60 * 1000));
  if (h < 24) return `hace ${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `hace ${d}d`;
  const mo = Math.floor(d / 30);
  return `hace ${mo} mes${mo === 1 ? '' : 'es'}`;
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

function bindChatPostit() {
  const phone = chatState.selectedPhone;
  if (!phone) return;
  const editBtn = document.getElementById('chat-postit-edit-btn');
  if (editBtn) {
    editBtn.onclick = (e) => {
      e.stopPropagation();
      chatState.editingNoteFor = phone;
      refreshPostit();
    };
  }
  // Click sobre el cuerpo del post-it (no editing) → entrar a edición
  const postit = document.getElementById('chat-postit');
  if (postit && !postit.classList.contains('chat-postit--editing')) {
    postit.onclick = () => {
      chatState.editingNoteFor = phone;
      refreshPostit();
    };
  }
  const cancel = document.getElementById('chat-postit-cancel');
  if (cancel) cancel.onclick = () => {
    chatState.editingNoteFor = null;
    refreshPostit();
  };
  const save = document.getElementById('chat-postit-save');
  if (save) save.onclick = async () => {
    const txt = (document.getElementById('chat-postit-textarea')?.value || '').trim();
    save.disabled = true; save.textContent = 'Guardando…';
    const ok = await saveContactNote(phone, txt);
    chatState.editingNoteFor = null;
    refreshPostit();
    if (ok) toast('Nota guardada ✓');
    else toast('Error al guardar la nota');
  };
  const del = document.getElementById('chat-postit-delete');
  if (del) del.onclick = async () => {
    const confirmed = await showConfirm('¿Borrar la nota de este contacto?', { title: 'Borrar nota', variant: 'warn', confirmLabel: 'Borrar' });
    if (!confirmed) return;
    await saveContactNote(phone, '');
    chatState.editingNoteFor = null;
    refreshPostit();
    toast('Nota borrada');
  };
}

function refreshPostit() {
  // Re-renderizar solo el post-it sin tocar mensajes (no perdés scroll ni input)
  const phone = chatState.selectedPhone;
  if (!phone) return;
  const old = document.getElementById('chat-postit');
  const html = renderChatNotePostit(phone);
  if (old) {
    if (!html) { old.remove(); return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    old.replaceWith(tmp.firstElementChild);
  } else if (html) {
    // Insertar después del header
    const header = document.querySelector('.chat-main .chat-header');
    if (header) {
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      header.after(tmp.firstElementChild);
    }
  }
  bindChatPostit();
  // Foco al textarea si está editando
  const textarea = document.getElementById('chat-postit-textarea');
  if (textarea) { textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length); }
}

// ===== Ad Attribution banner =====
// Muestra contexto del ad de Meta del que vino el cliente (Click-to-WhatsApp).
// Similar al banner verde que muestra WhatsApp Business arriba del chat.
function renderAdAttributionBanner(phone) {
  const attr = chatState.adAttributions[phone];
  if (!attr) return ''; // null = sin attribution, undefined = no cargado todavía
  const isInstagram = (attr.source_url || '').includes('instagram') || (attr.media_type || '').toLowerCase().includes('instagram');
  const platform = isInstagram ? 'Instagram' : 'Facebook';
  const icon = isInstagram
    ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41-.56-.22-.96-.48-1.38-.9-.42-.42-.68-.82-.9-1.38-.16-.42-.36-1.06-.41-2.23C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16zm0 5.84a4 4 0 100 8 4 4 0 000-8zm0 6.6a2.6 2.6 0 110-5.2 2.6 2.6 0 010 5.2zm5.1-7.7a.94.94 0 100-1.88.94.94 0 000 1.88z"/></svg>'
    : '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M22 12c0-5.52-4.48-10-10-10S2 6.48 2 12c0 4.84 3.44 8.87 8 9.8V15H8v-3h2V9.5C10 7.57 11.57 6 13.5 6H16v3h-2c-.55 0-1 .45-1 1v2h3v3h-3v6.95c5.05-.5 9-4.76 9-9.95z"/></svg>';
  const adIdShort = attr.source_id ? (attr.source_id.length > 12 ? attr.source_id.slice(0, 6) + '…' + attr.source_id.slice(-4) : attr.source_id) : '';
  // El link "Ver" va a la biblioteca de anuncios de Meta SOLO si es un ad_id real. Para los
  // ig_post de IG el source_id es el id del post (no un ad_id), así que no armamos link roto.
  const igPostTypes = ['ig_post', 'share', 'story_mention', 'ig_reel'];
  const sourceUrl = attr.source_url || (attr.source_id && !igPostTypes.includes(attr.source_type) ? `https://www.facebook.com/ads/library/?id=${attr.source_id}` : '');
  return `
    <div class="ad-attribution-banner" style="background:rgba(37,211,102,.08);border-left:3px solid #25D366;padding:10px 14px;margin:0;font-size:13px;display:flex;gap:10px;align-items:center">
      <div style="color:#25D366;flex-shrink:0">${icon}</div>
      <div style="flex:1;min-width:0">
        <div style="color:#25D366;font-weight:600;font-size:12px">Anuncio de ${platform}</div>
        ${attr.headline ? `<div style="color:var(--fg);font-size:13px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(attr.headline)}</div>` : ''}
        ${attr.body ? `<div style="color:var(--fg-subtle);font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(attr.body.slice(0, 80))}</div>` : ''}
        <div style="color:var(--fg-mute);font-size:11px;margin-top:2px;font-family:ui-monospace,monospace">ad:${adIdShort}</div>
      </div>
      ${sourceUrl ? `<a href="${sourceUrl}" target="_blank" style="color:#25D366;text-decoration:none;font-size:12px;flex-shrink:0">Ver ↗</a>` : ''}
    </div>
  `;
}

async function loadAdAttribution(phone) {
  if (!canAccessChat() || !phone) return;
  if (phone in chatState.adAttributions) return; // ya está cargado (puede ser null o objeto)
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/ad-attribution?phone=' + encodeURIComponent(phone), {
      headers: authHeaders()
    });
    if (!r.ok) { chatState.adAttributions[phone] = null; return; }
    const j = await r.json();
    chatState.adAttributions[phone] = j.attribution || null;
  } catch (_) {
    chatState.adAttributions[phone] = null;
  }
}

function renderChatNotePostit(phone) {
  const note = getContactNote(phone);
  const editing = chatState.editingNoteFor === phone;
  if (!note && !editing) return ''; // sin nota y no editando → no renderizamos nada (el botón "agregar nota" vive en el context menu)
  if (editing) {
    return `
      <div class="chat-postit chat-postit--editing" id="chat-postit">
        <div class="chat-postit-h">
          <span>📌 Nota del contacto</span>
          <button class="chat-postit-close" id="chat-postit-cancel" title="Cancelar">×</button>
        </div>
        <textarea class="chat-postit-textarea" id="chat-postit-textarea" placeholder="Escribí algo sobre este cliente…">${escapeHtml(note)}</textarea>
        <div class="chat-postit-actions">
          ${note ? '<button class="chat-postit-btn chat-postit-btn--danger" id="chat-postit-delete">Borrar</button>' : ''}
          <button class="chat-postit-btn chat-postit-btn--primary" id="chat-postit-save">Guardar</button>
        </div>
      </div>
    `;
  }
  return `
    <div class="chat-postit" id="chat-postit" title="Click para editar">
      <div class="chat-postit-h">
        <span>📌 Nota</span>
        <button class="chat-postit-edit" id="chat-postit-edit-btn" title="Editar">✎</button>
      </div>
      <div class="chat-postit-body">${escapeHtml(note)}</div>
    </div>
  `;
}

function renderChatConversation() {
  const phone = chatState.selectedPhone;
  const name = chatState.selectedName;
  loadProfilePic(phone);
  const msgCount = chatState.messages.length;
  // En Instagram el "phone" es el ID interno de IG (no un teléfono): mostramos el
  // @usuario. En WhatsApp mostramos el teléfono (+ @usuario si lo hay).
  const _chat = chatState.contacts.find(c => c.phone === phone) || {};
  const _uname = (chatState.waContactUsernames && chatState.waContactUsernames[phone]) || '';
  const _sub = _chat.channel === 'ig'
    ? (_uname ? '@' + escapeHtml(_uname) : 'Instagram')
    : (escapeHtml(formatPhoneDisplay(phone)) + (_uname ? ' · @' + escapeHtml(_uname) : ''));
  return `
    <div class="chat-header">
      <button class="chat-back-btn" id="chat-back-btn" title="Volver a la lista" aria-label="Volver">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
      </button>
      ${avatarHtml(phone, name, 40)}
      <div style="flex:1;min-width:0">
        <div class="chat-header-name">${escapeHtml(name || formatPhoneDisplay(phone))}</div>
        <div class="chat-header-phone">${_sub}</div>
      </div>
      <div class="chat-header-meta">
        ${canCreateBriefs() ? `<button class="btn btn-cyan" id="btn-chat-brief" title="Crear brief para este contacto — se carga a Emma como 'A cotizar' (teléfono y WhatsApp ya quedan cargados)" style="padding:4px 11px;font-size:12px;font-weight:600;white-space:nowrap;line-height:1.3">📋 Crear brief</button>` : ''}
        ${(getUserRole() === 'comercial') ? (() => {
          const _lbls = chatState.labels || [];
          const _pre = _lbls.find(l => l.name === '🤖 Precotización');
          const _fre = _lbls.find(l => l.name === '🛑 Bot frenado');
          const _ids = chatState.contactLabels[phone] || [];
          const _activo = _pre && _ids.includes(_pre.id);
          const _frozen = _fre && _ids.includes(_fre.id);
          if (!_activo && !_frozen) return '';
          return `<button id="btn-frenar-bot" data-frozen="${_frozen ? '1' : '0'}" title="${_frozen ? 'Reactivar el bot en este chat' : 'Frenar el bot en este chat — no vuelve a hablar acá'}" style="padding:4px 11px;font-size:12px;font-weight:600;white-space:nowrap;line-height:1.3;border-radius:var(--r-sm);cursor:pointer;background:transparent;border:1px solid ${_frozen ? '#25D366' : '#e06c6c'};color:${_frozen ? '#25D366' : '#e06c6c'}">${_frozen ? '▶ Reactivar bot' : '🛑 Frenar bot'}</button>`;
        })() : ''}
        ${(isCursosOnly() || getUserRole() === 'admin') ? (() => {
          const _venta = (chatState.contactLabels[phone] || []).includes(VENTA_ABRIL_LABEL_ID);
          return `<button class="btn ${_venta ? 'btn-cyan' : 'btn-ghost'}" id="btn-venta-abril" title="Marcar/desmarcar esta conversación como Venta de curso de Abril" style="padding:4px 11px;font-size:12px;font-weight:600;white-space:nowrap;line-height:1.3">${_venta ? '✅ Venta Abril' : '💰 Venta Abril'}</button>`;
        })() : ''}
        <span>${msgCount} msgs</span>
        ${['admin', 'comercial', 'cursos'].includes(getUserRole()) ? (() => {
          const _c = (chatState.contacts || []).find(x => x.phone === phone);
          const _enCursos = _c && _c.inbox === 'cursos';
          // Abril (cursos) solo ve chats de su bandeja → siempre "Sacar de Cursos".
          return `<button class="btn-label-toggle${_enCursos ? ' has-note' : ''}" id="btn-cursos-toggle" data-en-cursos="${_enCursos ? '1' : '0'}" title="${_enCursos ? 'Sacar de la bandeja Cursos' : 'Derivar a la bandeja Cursos (Abril)'}" style="font-size:17px;line-height:1">🎓</button>`;
        })() : ''}
        ${getUserRole() === 'admin' ? (() => {
          const _c = (chatState.contacts || []).find(x => x.phone === phone);
          const _enNadia = _c && _c.assigned_to === 'nadia';
          // Reparto de vendedores: asignar/sacar el chat a Nadia (solo Gaspar). Sin asignar = lo ve Joaco.
          return `<button class="btn-label-toggle${_enNadia ? ' has-note' : ''}" id="btn-nadia-toggle" title="${_enNadia ? 'Sacar de Nadia (vuelve a Joaco)' : 'Asignar este chat a Nadia'}" style="font-size:13px;font-weight:700;line-height:1">👤${_enNadia ? 'N✓' : 'N'}</button>`;
        })() : ''}
        <button class="btn-label-toggle ${getContactNote(phone) ? 'has-note' : ''}" id="btn-note" title="${getContactNote(phone) ? 'Editar nota' : 'Agregar nota'}">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
        </button>
        <button class="btn-label-toggle" id="btn-labels" title="Etiquetas">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16z"/></svg>
        </button>
      </div>
      <div class="chat-label-chips" id="chat-label-chips">${renderContactLabelChips(phone)}</div>
    </div>
    ${renderChatNotePostit(phone)}
    ${renderAdAttributionBanner(phone)}
    ${renderPrecotizChatBanner(phone)}
    <div class="chat-messages" id="chat-messages">
      ${chatState.loadingConv
        ? '<div class="chat-loading"><div class="spinner" style="border-color:#2a3942;border-top-color:#00a884"></div></div>'
        : renderChatBubbles()}
    </div>
    <button class="chat-scroll-down" id="chat-scroll-down" title="Ir al final">
      <svg viewBox="0 0 19 20" width="18" height="18" fill="currentColor"><path d="M3.8 6.7l5.7 5.7 5.7-5.7 1.6 1.6-7.3 7.2-7.3-7.2 1.6-1.6z"/></svg>
    </button>
    ${render24hBanner()}
    <div id="suggest-panel" class="suggest-panel" style="display:none"></div>
    <div class="chat-input-bar">
      ${['admin', 'comercial', 'cursos'].includes(getUserRole()) ? '<button class="btn-send btn-suggest" id="btn-suggest" title="Sugerir respuesta con IA">✨</button>' : ''}
      <button class="btn-send btn-attach" id="btn-attach" title="Adjuntar imagen"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M1.816 15.556v.002c0 1.502.584 2.912 1.646 3.972s2.472 1.647 3.974 1.647a5.58 5.58 0 003.972-1.645l9.547-9.548c.769-.768 1.147-1.767 1.058-2.817-.079-.968-.548-1.927-1.319-2.698-1.594-1.592-4.068-1.711-5.517-.262l-7.916 7.915c-.881.881-.792 2.25.214 3.261.501.501 1.134.79 1.737.79.558 0 1.031-.224 1.37-.564l5.582-5.58a.747.747 0 10-1.055-1.06l-5.58 5.58c-.172.172-.42.156-.614-.04-.508-.51-.427-1.122-.07-1.478l7.916-7.916c.866-.866 2.358-.764 3.46.34.556.557.876 1.203.918 1.818.036.526-.176 1.047-.595 1.466L10.11 18.526a4.09 4.09 0 01-2.913 1.205 4.09 4.09 0 01-2.913-1.205 4.09 4.09 0 01-1.205-2.913c0-1.1.428-2.134 1.205-2.911l8.647-8.646a.747.747 0 00-1.055-1.06l-8.647 8.646A5.58 5.58 0 001.816 15.556z"/></svg></button>
      <input type="file" id="chat-file-input" accept="image/*,video/*,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/zip,text/plain" multiple style="display:none">
      <div class="chat-input-wrap">
        <textarea id="chat-input" placeholder="Escribí un mensaje" rows="1"></textarea>
        <div class="qr-dropdown" id="qr-dropdown" style="display:none"></div>
      </div>
      <button class="btn-send" id="chat-send-btn" ${chatState.sending ? 'disabled' : ''} title="Enviar"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M1.101 21.757L23.8 12.028 1.101 2.3l.011 7.912 13.239 1.816-13.239 1.817-.011 7.912z"/></svg></button>
      <button class="btn-send btn-schedule" id="btn-schedule" title="Programar mensaje"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg></button>
      <button class="btn-send btn-mic" id="btn-mic" title="Grabar audio"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M11.999 14.942c2.001 0 3.531-1.53 3.531-3.531V4.35c0-2.001-1.53-3.531-3.531-3.531S8.469 2.35 8.469 4.35v7.061c0 2.001 1.53 3.531 3.53 3.531zm6.238-3.53c0 3.531-2.942 6.002-6.238 6.002s-6.238-2.471-6.238-6.002H4.761c0 3.885 3.118 7.061 7.003 7.414v3.174h.471v-3.174c3.885-.353 7.003-3.529 7.003-7.414h-1z"/></svg></button>
    </div>
  `;
}

function mediaUrl(r2Key) {
  if (!r2Key) return '';
  const tkParam = STATE.token ? '?token=' + encodeURIComponent(STATE.token) : '';
  // wa/  → media bajado del webhook (imagen del cliente, audio, etc.)
  // promo/ → assets promocionales (foto de copa para follow-up de presupuesto)
  if (r2Key.startsWith('wa/') || r2Key.startsWith('promo/') || r2Key.startsWith('briefs/') || r2Key.startsWith('ig/')) {
    return CONFIG.trackerUrl + '/admin/media/' + encodeURIComponent(r2Key) + tkParam;
  }
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

// HTML para los iconos flotantes (forward + reaccionar) que aparecen al hover.
// Se inyecta dentro del bubble; CSS lo posiciona afuera y lo muestra en hover.
function chatMsgActionsHtml() {
  return `<div class="chat-msg-actions">
    <button class="cma-btn" data-cma="react" title="Reaccionar">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/></svg>
    </button>
    <button class="cma-btn" data-cma="reply" title="Responder">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>
    </button>
    <button class="cma-btn" data-cma="forward" title="Reenviar">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 8V4l8 8-8 8v-4H4V8z"/></svg>
    </button>
  </div>`;
}

// Devuelve un mensaje por wamid (busca en chatState.messages).
function findMessageByWamid(wamid) {
  if (!wamid) return null;
  return chatState.messages.find(m => m.wamid === wamid) || null;
}

// HTML del bloque de cita (quoted reply) que va arriba del bubble cuando
// el mensaje tiene context_id apuntando a otro mensaje.
function quotePreviewFor(type, body) {
  if (type === 'image') return '📷 Imagen' + (body ? ' · ' + body : '');
  if (type === 'audio') return '🎤 Audio';
  if (type === 'video') return '🎬 Video';
  if (type === 'document') return '📄 ' + (body || 'Documento');
  if (type === 'sticker') return 'Sticker';
  return body || '';
}
function quoteBlockHtml(m) {
  if (!m.context_id) return '';
  let parentDir, author, preview;
  const parent = findMessageByWamid(m.context_id);
  if (parent) {
    // Mensaje citado cargado en pantalla (respuesta reciente o mensaje optimista).
    parentDir = parent.direction || 'inbound';
    author = parentDir === 'outbound' ? 'Vos' : (parent.sender_name || 'Cliente');
    preview = quotePreviewFor(parent.msg_type, parent.body);
  } else if (m.quoted_meta) {
    // Padre FUERA de la ventana cargada (respuesta a un mensaje viejo): usamos el preview
    // que resolvió el backend por context_id. Formato: dir⏹type⏹sender⏹body (sep char 31).
    const parts = String(m.quoted_meta).split('\x1f');
    parentDir = parts[0] || 'inbound';
    author = parentDir === 'outbound' ? 'Vos' : (parts[2] || 'Cliente');
    preview = quotePreviewFor(parts[1], (parts.slice(3).join('\x1f')) || '');
  } else {
    return ''; // ni cargado ni resuelto por backend → nada
  }
  preview = (preview || '').slice(0, 120);
  return `<div class="chat-msg-quote ${parentDir === 'outbound' ? 'mine' : 'theirs'}" data-jump-to="${escapeHtml(m.context_id)}">
    <div class="cmq-author">${escapeHtml(author)}</div>
    <div class="cmq-text">${escapeHtml(preview)}</div>
  </div>`;
}

// Construye los chips de reacciones (inbound + outbound) para un wamid dado.
function reactionsBadgeHtml(wamid, reactionsByParent) {
  const list = reactionsByParent.get(wamid);
  if (!list || !list.length) return '';
  // Última reacción por sender (phone+direction). Emoji vacío = quitada.
  const latest = new Map();
  for (const r of list) {
    const key = (r.direction || 'inbound') + '|' + (r.phone || '');
    latest.set(key, r);
  }
  const counts = new Map();
  for (const r of latest.values()) {
    const e = (r.body || '').trim();
    if (!e) continue;
    counts.set(e, (counts.get(e) || 0) + 1);
  }
  if (!counts.size) return '';
  const chips = [...counts.entries()].map(([e, n]) =>
    `<span class="reaction-chip">${escapeHtml(e)}${n > 1 ? '<span class="rc-num">' + n + '</span>' : ''}</span>`
  ).join('');
  return `<div class="chat-msg-reactions">${chips}</div>`;
}

function renderChatBubbles(msgs, opts) {
  // Permite render incremental: pasás un subset de msgs + opts.previousMsg
  // para arrancar el lastDate/lastDir desde un "ancla" sin renderearla. Y
  // opts.skipOlderBtn evita duplicar el botón de "cargar anteriores" cuando
  // estás appendeando bubbles nuevos al DOM existente.
  msgs = msgs || chatState.messages;
  opts = opts || {};
  if (!msgs.length) return '<div class="chat-empty">Sin mensajes</div>';
  // Botón "cargar anteriores" arriba si hay más mensajes históricos por traer.
  const olderBtn = (!opts.skipOlderBtn && chatState.hasMoreOlder) ? `
    <div class="chat-load-older-wrap">
      <button class="chat-load-older-btn" id="chat-load-older-btn" ${chatState.loadingOlder ? 'disabled' : ''}>
        ${chatState.loadingOlder ? '⏳ Cargando…' : '↑ Cargar mensajes anteriores'}
      </button>
    </div>
  ` : '';
  // Pre-armar mapa de reacciones por wamid del padre. Para el caso incremental
  // usamos chatState.messages completo (no solo el subset) — las reacciones
  // pueden venir en cualquier orden y aplicarse a bubbles existentes en DOM.
  const reactionsSource = opts.allMsgsForReactions || msgs;
  const reactionsByParent = new Map();
  for (const m of reactionsSource) {
    if (m.msg_type === 'reaction' && m.context_id) {
      if (!reactionsByParent.has(m.context_id)) reactionsByParent.set(m.context_id, []);
      reactionsByParent.get(m.context_id).push(m);
    }
  }
  let html = olderBtn;
  // Arranco el lastDate/lastDir desde el "ancla" si fue provisto (caso
  // incremental: el último bubble en DOM define la continuidad de fecha).
  // IMPORTANTE: comparamos fechas en hora LOCAL (Argentina), no UTC.
  // Antes hacíamos m.ts.slice(0,10) que sacaba la fecha UTC del ISO string,
  // y eso agrupaba mensajes de 21-23:59hs AR con los del día siguiente UTC
  // (porque UTC = AR + 3h). Bug visible: si tipeabas a las 22hs y respondías
  // al día siguiente 15hs, no aparecía separador "Hoy" entre ambos.
  let lastDate = opts.previousMsg ? localDateKey(new Date(opts.previousMsg.ts)) : '';
  let lastDir = opts.previousMsg ? (opts.previousMsg.direction || 'inbound') : '';
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.msg_type === 'reaction') continue; // se renderizan como chips, no como bubble
    const msgDate = localDateKey(new Date(m.ts));
    if (msgDate !== lastDate) {
      lastDate = msgDate;
      html += `<div class="chat-date-sep"><span>${formatChatDate(m.ts)}</span></div>`;
      lastDir = '';
    }
    const dir = m.direction || 'inbound';
    const time = new Date(m.ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    const hasTail = dir !== lastDir;
    lastDir = dir;

    // Status ticks (SVG like WA). 'played' = audio escuchado, mismo símbolo que 'read'.
    let statusHtml = '';
    if (dir === 'outbound') {
      if (m.status === 'read' || m.status === 'played') statusHtml = `<span class="chat-msg-status read" title="Leído">${TICK_DOUBLE}</span>`;
      else if (m.status === 'delivered') statusHtml = `<span class="chat-msg-status delivered" title="Entregado">${TICK_DOUBLE}</span>`;
      else if (m.status === 'failed') statusHtml = `<span class="chat-msg-status failed" title="No se pudo entregar">✗ falló</span>`;
      else statusHtml = `<span class="chat-msg-status sent" title="Enviado">${TICK_SINGLE}</span>`;
    }
    // Badge de mensaje automático: solo en salientes marcados automated=1 por el
    // worker (broadcasts, follow-ups, auto-replies). Lo que manda una persona
    // (Gaspar/Joaco/Abril desde el CRM o el cel) queda sin badge.
    const autoBadge = (dir === 'outbound' && m.automated)
      ? `<span class="chat-msg-auto" title="Mensaje automático del sistema — no lo mandó una persona del equipo" style="font-size:9px;font-weight:700;color:#9fb0bb;background:rgba(134,150,160,.18);padding:1px 5px;border-radius:7px;margin-right:5px;vertical-align:middle;letter-spacing:.02em">🤖 automático</span>`
      : '';
    const footer = `<span class="chat-msg-footer">${autoBadge}<span class="chat-msg-time">${time}</span>${statusHtml}</span>`;

    // Parse body: separate actual text from [audio]/[imagen] AI annotations.
    // Si es el marcador de una plantilla ("[plantilla: NOMBRE]"), mostramos el texto real.
    let bodyText = tplMarkerToText(m.body || '', m.phone || chatState.selectedPhone);
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
      const _isFav = (chatState.stickerFavs || []).includes(m.media_url);
      const _canFav = String(m.media_url).startsWith('wa/');
      html += `<div class="chat-msg ${dir} sticker-msg${hasTail ? ' has-tail' : ''}" data-wamid="${escapeHtml(m.wamid || '')}" data-msg-type="${escapeHtml(m.msg_type || 'sticker')}" style="position:relative">
        <img src="${mediaUrl(m.media_url)}" alt="" style="max-width:160px;max-height:160px" loading="lazy">
        ${_canFav ? `<button class="sticker-fav-btn" data-sticker-fav="${m.media_url}" data-fav="${_isFav ? '1' : '0'}" title="${_isFav ? 'Quitar de mis stickers' : 'Guardar sticker'}" style="position:absolute;bottom:4px;right:4px;background:rgba(0,0,0,.6);border:none;border-radius:50%;width:28px;height:28px;cursor:pointer;font-size:15px;line-height:1;padding:0;color:#fff;z-index:5">${_isFav ? '⭐' : '☆'}</button>` : ''}
      </div>`;
      continue;
    }

    // === IMAGE ===
    if (m.msg_type === 'image') {
      // media_url válido si fue descargado a R2 (wa/) o es un asset
      // promocional (promo/). Si quedó como media_id raw es porque
      // downloadMedia falló en el webhook y el media ya no se puede recuperar
      // (Meta expira las URLs en ~30 días). Mostramos placeholder en vez de
      // burbuja vacía con un <img> roto.
      const hasValidMedia = m.media_url && (String(m.media_url).startsWith('wa/') || String(m.media_url).startsWith('promo/') || String(m.media_url).startsWith('briefs/') || String(m.media_url).startsWith('ig/'));
      if (hasValidMedia) {
        const imgSrc = mediaUrl(m.media_url);
        html += `<div class="chat-msg ${dir} has-media${hasTail ? ' has-tail' : ''}" data-wamid="${escapeHtml(m.wamid || '')}" data-msg-type="${escapeHtml(m.msg_type || 'image')}">
          <div class="chat-msg-media">
            <img src="${imgSrc}" alt="" loading="lazy" data-img-preview="${escapeHtml(imgSrc)}" onerror="this.style.display='none'">
          </div>
          ${bodyText ? `<div class="chat-msg-body">${escapeHtml(bodyText).replace(/\n/g, '<br>')}</div>` : ''}
          ${footer}
        </div>`;
      } else {
        // Placeholder para imagen no recuperable.
        html += `<div class="chat-msg ${dir}${hasTail ? ' has-tail' : ''}" data-wamid="${escapeHtml(m.wamid || '')}" data-msg-type="${escapeHtml(m.msg_type || 'image')}">
          <div class="chat-msg-body" style="opacity:.7;font-style:italic">📷 Imagen (no disponible)${bodyText ? '<br>' + escapeHtml(bodyText).replace(/\n/g, '<br>') : ''}</div>
          ${footer}
        </div>`;
      }
      continue;
    }

    // === AUDIO ===
    if (m.msg_type === 'audio' && m.media_url) {
      const contact = chatState.contacts.find(c => c.phone === chatState.selectedPhone);
      const aName = dir === 'inbound' ? (contact?.name || '') : 'Neon';
      const audioId = 'aud_' + (m.wamid || m.ts).replace(/[^a-z0-9]/gi, '');
      const transcriptIconSvg = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M14 17H4v2h10v-2zm6-8H4v2h16V9zM4 15h16v-2H4v2zM4 5v2h16V5H4z"/></svg>';
      html += `<div class="chat-msg ${dir} chat-msg-audio-bubble${hasTail ? ' has-tail' : ''}" data-wamid="${escapeHtml(m.wamid || '')}" data-msg-type="${escapeHtml(m.msg_type || 'text')}">
        <div class="chat-msg-audio">
          <div class="audio-avatar-wrap" style="position:relative;flex-shrink:0">
            ${avatarHtml(dir === 'inbound' ? chatState.selectedPhone : '0000', aName, 40)}
            <button class="audio-play-btn" data-audio-play title="Reproducir / pausar" aria-label="Reproducir o pausar audio">
              <svg class="ico-play" viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              <svg class="ico-pause" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" style="display:none"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            </button>
          </div>
          <div class="audio-wave">
            <div class="audio-bars" data-audio-src="${mediaUrl(m.media_url)}">
              ${generateAudioBars()}
            </div>
            <div class="audio-row">
              <audio preload="metadata" src="${mediaUrl(m.media_url)}" data-audio-el></audio>
              <span class="audio-dur" data-audio-time>0:00</span>
              <button class="audio-speed" data-audio-speed="1" title="Velocidad de reproducción">1x</button>
              ${transcript ? `<button class="audio-toggle-transcript" data-toggle-transcript="${audioId}" title="Mostrar transcripción">${transcriptIconSvg}</button>` : ''}
              ${footer}
            </div>
          </div>
        </div>
        ${transcript ? `<div class="chat-msg-transcript" id="${audioId}" style="display:none">"${escapeHtml(transcript)}"</div>` : ''}
      </div>`;
      continue;
    }

    // === VIDEO ===
    if (m.msg_type === 'video' && m.media_url) {
      html += `<div class="chat-msg ${dir}${hasTail ? ' has-tail' : ''}" data-wamid="${escapeHtml(m.wamid || '')}" data-msg-type="${escapeHtml(m.msg_type || 'text')}">
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
      const docSrc = mediaUrl(m.media_url);
      const ext = (m.media_url.split('.').pop() || 'doc').toUpperCase();
      const isPdf = ext === 'PDF' || /\.pdf($|\?)/i.test(m.media_url) || /\.pdf$/i.test(docName);
      html += `<div class="chat-msg ${dir}${hasTail ? ' has-tail' : ''}" data-wamid="${escapeHtml(m.wamid || '')}" data-msg-type="${escapeHtml(m.msg_type || 'text')}">
        <div class="chat-msg-doc" ${isPdf ? `data-pdf-preview="${escapeHtml(docSrc)}" data-doc-name="${escapeHtml(docName)}"` : `data-doc-open="${escapeHtml(docSrc)}"`} role="button">
          <div class="doc-icon">${ext.slice(0, 4)}</div>
          <div class="doc-name">${escapeHtml(docName)}</div>
        </div>
        ${footer}
      </div>`;
      continue;
    }

    // Outbound enviado desde WA Business app/web: no tenemos contenido (Cloud API
    // sin Coexistencia), pero mostramos placeholder para que el chat no se vea vacío.
    if (!bodyText.trim() && dir === 'outbound' && m.msg_type === 'status') {
      html += `<div class="chat-msg ${dir}${hasTail ? ' has-tail' : ''}" data-wamid="${escapeHtml(m.wamid || '')}" data-msg-type="${escapeHtml(m.msg_type || 'text')}">
        <div class="chat-msg-unsupported" style="font-style:italic;opacity:.7">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="#8696a0"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
          <span>Respondido desde WhatsApp</span>
        </div>
        ${footer}
      </div>`;
      continue;
    }

    // === LOCATION ===
    if (bodyText.startsWith('[ubicacion] ')) {
      const locData = bodyText.slice(12);
      const coordMatch = locData.match(/^(-?[\d.]+),(-?[\d.]+)/);
      let locDisplay = locData.replace(/^-?[\d.]+,-?[\d.]+\s*—?\s*/, '').trim() || 'Ubicación compartida';
      const mapLink = coordMatch ? `https://www.google.com/maps?q=${coordMatch[1]},${coordMatch[2]}` : '#';
      html += `<div class="chat-msg ${dir}${hasTail ? ' has-tail' : ''}" data-wamid="${escapeHtml(m.wamid || '')}" data-msg-type="${escapeHtml(m.msg_type || 'text')}">
        <a href="${mapLink}" target="_blank" style="text-decoration:none">
          <div class="chat-msg-location">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="#ef5350"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
            <div>
              <div style="color:#e9edef;font-size:14px">${escapeHtml(locDisplay)}</div>
              ${coordMatch ? `<div style="color:#8696a0;font-size:11px">${coordMatch[1]}, ${coordMatch[2]}</div>` : ''}
            </div>
          </div>
        </a>
        ${footer}
      </div>`;
      continue;
    }

    // === CONTACT CARD ===
    if (bodyText.startsWith('[contacto] ')) {
      const contactData = bodyText.slice(11);
      html += `<div class="chat-msg ${dir}${hasTail ? ' has-tail' : ''}" data-wamid="${escapeHtml(m.wamid || '')}" data-msg-type="${escapeHtml(m.msg_type || 'text')}">
        <div class="chat-msg-contact-card">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="#53bdeb"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
          <div style="color:#e9edef;font-size:14px">${escapeHtml(contactData)}</div>
        </div>
        ${footer}
      </div>`;
      continue;
    }

    // === UNSUPPORTED / UNAVAILABLE ===
    if (m.msg_type === 'unsupported' || bodyText.startsWith('[mensaje no disponible]') || bodyText.startsWith('[tipo de mensaje no soportado') || bodyText.startsWith('[no soportado')) {
      const isUnavailable = bodyText.includes('no disponible');
      html += `<div class="chat-msg ${dir}${hasTail ? ' has-tail' : ''}" data-wamid="${escapeHtml(m.wamid || '')}" data-msg-type="${escapeHtml(m.msg_type || 'text')}">
        <div class="chat-msg-unsupported">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="#8696a0"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
          <span>${isUnavailable ? 'Mensaje no disponible' : 'Mensaje no compatible con la API'}</span>
        </div>
        ${footer}
      </div>`;
      continue;
    }

    // === REVOKED (mensaje eliminado) ===
    if (m.msg_type === 'revoke') {
      html += `<div class="chat-msg ${dir}${hasTail ? ' has-tail' : ''}" data-wamid="${escapeHtml(m.wamid || '')}" data-msg-type="${escapeHtml(m.msg_type || 'text')}">
        <div class="chat-msg-unsupported" style="font-style:italic;opacity:.7">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="#8696a0"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8 0-1.85.63-3.55 1.69-4.9L16.9 18.31A7.902 7.902 0 0112 20zm6.31-3.1L7.1 5.69A7.902 7.902 0 0112 4c4.42 0 8 3.58 8 8 0 1.85-.63 3.55-1.69 4.9z"/></svg>
          <span>Mensaje eliminado</span>
        </div>
        ${footer}
      </div>`;
      continue;
    }

    // === TEXT (or fallback) ===
    if (!bodyText.trim() && !m.media_url) {
      if (m.msg_type !== 'text' && m.msg_type !== 'status') {
        bodyText = `[${m.msg_type}]`;
      } else {
        continue;
      }
    }

    html += `<div class="chat-msg ${dir}${hasTail ? ' has-tail' : ''}" data-wamid="${escapeHtml(m.wamid || '')}" data-msg-type="${escapeHtml(m.msg_type || 'text')}">
      ${bodyText ? `<span class="chat-msg-body">${escapeHtml(bodyText).replace(/\n/g, '<br>')}</span>` : ''}
      ${footer}
    </div>`;
  }
  // Post-proceso: inyectar acciones flotantes y chips de reacción en cada bubble con wamid.
  // Lo hacemos via DOM después en renderChatMessages, pero también devolvemos el mapa de reacciones.
  renderChatBubbles._reactionsByParent = reactionsByParent;
  return html;
}

// Post-procesa los bubbles recién insertados al DOM (quote blocks, action
// buttons, chips de reacción, event handlers). Si se le pasa `scope`, solo
// trabaja sobre los elementos dentro de ese scope (caso render incremental).
function _postProcessBubbles(container, reactionsByParent, scope) {
  const root = scope || container;
  root.querySelectorAll('.chat-msg[data-wamid]').forEach(el => {
    const wamid = el.dataset.wamid;
    if (!wamid) return;
    // Skip si ya tiene las acciones inyectadas (defensa contra doble bind)
    if (el.querySelector('.chat-msg-actions')) return;
    const m = chatState.messages.find(x => x.wamid === wamid);
    if (m && m.context_id) {
      const qHtml = quoteBlockHtml(m);
      if (qHtml) el.insertAdjacentHTML('afterbegin', qHtml);
    }
    el.insertAdjacentHTML('beforeend', chatMsgActionsHtml());
    // Chevron estilo WhatsApp Web: aparece al hover (desktop) y abre el menú de
    // acciones (el mismo del click derecho). En mobile se usa long-press (ver bind).
    el.insertAdjacentHTML('beforeend', '<button class="chat-msg-caret" data-caret aria-label="Más opciones"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg></button>');
    const chips = reactionsBadgeHtml(wamid, reactionsByParent);
    if (chips) el.insertAdjacentHTML('beforeend', chips);
  });
  root.querySelectorAll('[data-jump-to]').forEach(q => {
    if (q.dataset._bound) return; q.dataset._bound = '1';
    q.style.cursor = 'pointer';
    q.onclick = (e) => {
      e.stopPropagation();
      const target = container.querySelector(`.chat-msg[data-wamid="${q.dataset.jumpTo}"]`);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('chat-msg-flash');
      setTimeout(() => target.classList.remove('chat-msg-flash'), 1500);
    };
  });
}

function renderChatMessages() {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  // ===== Render incremental cuando es seguro =====
  // En vez de hacer innerHTML = ... y reconstruir todos los bubbles cada vez
  // que el polling detecta cambios, intentamos un append incremental de los
  // mensajes nuevos al final. Eso evita el reflow completo del DOM (que es
  // lo que generaba lag al escribir en chats pesados de 200+ mensajes).
  //
  // Condiciones para incremental:
  //   1. Ya hay bubbles renderizados en el DOM (no es la primera vez).
  //   2. Los mensajes nuevos en chatState son TODOS más nuevos (ts >=) que
  //      el último bubble en DOM. Si hay mensajes "insertados al medio"
  //      (status update que cambió el ts, load older), caemos al full render.
  //   3. No hay highlightWamid pendiente (caso de búsqueda → necesita scrollIntoView
  //      sobre TODO el listado, mejor un full render para asegurarnos).
  //   4. El número de bubbles actuales corresponde al de chatState (no se
  //      borraron mensajes).
  const existingBubbles = container.querySelectorAll('.chat-msg[data-wamid]');
  const allMsgs = chatState.messages || [];
  const renderableMsgs = allMsgs.filter(m => m.msg_type !== 'reaction');
  // Buildeamos el lookup por wamid una sola vez, lo usamos tanto para
  // determinar el ts del último bubble como para encontrar el "anchor".
  const msgByWamid = new Map();
  for (const m of allMsgs) if (m.wamid) msgByWamid.set(m.wamid, m);

  const canTryIncremental =
    existingBubbles.length > 0 &&
    !chatState.highlightWamid &&
    renderableMsgs.length > 0;

  if (canTryIncremental) {
    const existingWamids = new Set();
    for (const el of existingBubbles) existingWamids.add(el.dataset.wamid);
    const newMsgs = renderableMsgs.filter(m => m.wamid && !existingWamids.has(m.wamid));
    // Detectar reacciones nuevas a bubbles ya en DOM (no son "newMsgs" porque
    // las reactions están filtradas, pero impactan los chips).
    const newReactionsToExisting = allMsgs.some(m =>
      m.msg_type === 'reaction' && m.context_id && existingWamids.has(m.context_id) && !existingWamids.has(m.wamid)
    );

    if (newMsgs.length === 0) {
      // Nada nuevo que renderizar — pero quizás cambiaron status de mensajes
      // existentes (sent→delivered→read) o llegó una reacción nueva. Actualizamos
      // los ticks y chips in-place sin reflow completo.
      _updateExistingBubbleStatuses(container, msgByWamid);
      if (newReactionsToExisting) {
        const reactionsByParent = _buildReactionsMap(allMsgs);
        _refreshReactionChips(container, reactionsByParent);
      }
      return;
    }

    // ¿Todos los nuevos van al final? Comparamos contra el ts del ÚLTIMO bubble
    // en DOM (no leemos dataset.ts porque no se emite; lookup por wamid).
    const lastBubble = existingBubbles[existingBubbles.length - 1];
    const lastExistingWamid = lastBubble.dataset.wamid;
    const lastExistingMsg = msgByWamid.get(lastExistingWamid);
    const lastTs = (lastExistingMsg && lastExistingMsg.ts) || '';
    const allAtEnd = !lastTs || newMsgs.every(m => (m.ts || '') >= lastTs);

    if (allAtEnd) {
      // ✅ Render incremental: append solo los nuevos
      const newHtml = renderChatBubbles(newMsgs, {
        skipOlderBtn: true,
        previousMsg: lastExistingMsg || null,
        allMsgsForReactions: allMsgs
      });
      // Buildeamos en un fragment temporal para post-procesar antes de mover al DOM real.
      const tmp = document.createElement('div');
      tmp.innerHTML = newHtml;
      const reactionsByParent = renderChatBubbles._reactionsByParent || new Map();
      _postProcessBubbles(container, reactionsByParent, tmp);
      // Detectamos si el usuario estaba al fondo ANTES de insertar (para
      // decidir auto-scroll). Threshold de 80px para tolerar leves scrolls hacia arriba.
      const wasAtBottom = (container.scrollHeight - container.scrollTop - container.clientHeight) < 80;
      // Bind handlers SOLO al markup nuevo, mientras vive en el fragment detached.
      // Antes estos 4 binds recorrían TODO el container en cada poll (O(n) en la
      // conversación, aunque skipearan los ya bindeados); acotándolos al fragment
      // el costo es O(burbujas nuevas). Los onclick se preservan al mover los nodos;
      // los handlers que necesitan ver toda la conversación (galería de imágenes,
      // pausar otros audios) usan document en tiempo de click, no de bind.
      bindAudioPlayers(tmp);
      bindMessageContextMenus(tmp);
      bindMessageHoverActions(tmp);
      bindMediaPreviewClicks(tmp);
      while (tmp.firstChild) container.appendChild(tmp.firstChild);
      // Refrescar chips de reacciones de bubbles existentes (las nuevas msgs
      // pueden incluir reacciones a bubbles viejos).
      _refreshReactionChips(container, reactionsByParent);
      if (wasAtBottom) container.scrollTop = container.scrollHeight;
      _updateExistingBubbleStatuses(container, msgByWamid);
      return;
    }
    // Si llegamos acá, hay msgs insertados al medio o reordenados → full render
  }

  // ===== Full render (fallback / primera vez / casos complejos) =====
  container.innerHTML = renderChatBubbles();
  const olderBtn = container.querySelector('#chat-load-older-btn');
  if (olderBtn) olderBtn.onclick = handleLoadOlderMessages;
  const reactionsByParent = renderChatBubbles._reactionsByParent || new Map();
  _postProcessBubbles(container, reactionsByParent);
  bindAudioPlayers();
  bindMessageContextMenus();
  bindMessageHoverActions();
  bindMediaPreviewClicks();
  if (chatState.highlightWamid) {
    const target = container.querySelector(`.chat-msg[data-wamid="${chatState.highlightWamid}"]`);
    if (target) {
      setTimeout(() => {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('chat-msg-flash');
        setTimeout(() => target.classList.remove('chat-msg-flash'), 2200);
      }, 100);
    } else {
      scrollChatToBottom();
    }
    chatState.highlightWamid = null;
  } else {
    scrollChatToBottom();
  }
}

// Actualiza in-place los ticks de status (sent/delivered/read) sin tocar el
// resto del bubble. Mucho más liviano que re-renderizar la lista entera.
// El caller puede pasar un msgByWamid precomputado para evitar rebuildearlo.
function _updateExistingBubbleStatuses(container, msgByWamid) {
  if (!msgByWamid) {
    msgByWamid = new Map();
    for (const m of (chatState.messages || [])) if (m.wamid) msgByWamid.set(m.wamid, m);
  }
  container.querySelectorAll('.chat-msg.outbound[data-wamid]').forEach(el => {
    const m = msgByWamid.get(el.dataset.wamid);
    if (!m || !m.status) return;
    const statusEl = el.querySelector('.chat-msg-status');
    if (!statusEl) return;
    const cur = statusEl.className.includes('read') ? 'read'
              : statusEl.className.includes('delivered') ? 'delivered'
              : statusEl.className.includes('failed') ? 'failed'
              : 'sent';
    const desired = (m.status === 'played' || m.status === 'read') ? 'read'
                  : m.status === 'delivered' ? 'delivered'
                  : m.status === 'failed' ? 'failed'
                  : 'sent';
    if (cur !== desired) {
      statusEl.classList.remove('read', 'delivered', 'failed', 'sent');
      statusEl.classList.add(desired);
      statusEl.title = desired === 'read' ? 'Leído'
                     : desired === 'delivered' ? 'Entregado'
                     : desired === 'failed' ? 'No se pudo entregar'
                     : 'Enviado';
      statusEl.innerHTML = desired === 'failed' ? '✗ falló'
                         : (desired === 'read' || desired === 'delivered') ? TICK_DOUBLE
                         : TICK_SINGLE;
    }
  });
}

// Construye el mapa context_id → [reactions] desde un array de mensajes.
// Mismo formato que renderChatBubbles produce internamente.
function _buildReactionsMap(msgs) {
  const map = new Map();
  for (const m of (msgs || [])) {
    if (m.msg_type === 'reaction' && m.context_id) {
      if (!map.has(m.context_id)) map.set(m.context_id, []);
      map.get(m.context_id).push(m);
    }
  }
  return map;
}

// Cuando llegan reacciones nuevas, actualiza los chips de los bubbles ya
// renderizados en DOM sin reconstruir el bubble. Reemplaza chips existentes.
function _refreshReactionChips(container, reactionsByParent) {
  for (const [parentWamid, _] of reactionsByParent) {
    const parentEl = container.querySelector(`.chat-msg[data-wamid="${parentWamid}"]`);
    if (!parentEl) continue;
    const existingChips = parentEl.querySelector('.chat-msg-reactions');
    if (existingChips) existingChips.remove();
    const chipsHtml = reactionsBadgeHtml(parentWamid, reactionsByParent);
    if (chipsHtml) parentEl.insertAdjacentHTML('beforeend', chipsHtml);
  }
}

// Click en imagen/PDF → preview inline (no abre nueva pestaña).
function bindMediaPreviewClicks(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-img-preview]').forEach(img => {
    img.style.cursor = 'zoom-in';
    img.onclick = (e) => {
      e.preventDefault();
      // Galería: todas las imágenes del chat actual, en orden de aparición.
      const all = Array.from(document.querySelectorAll('[data-img-preview]')).map(el => el.dataset.imgPreview);
      const idx = all.indexOf(img.dataset.imgPreview);
      showImageLightbox(all, idx >= 0 ? idx : 0);
    };
  });
  scope.querySelectorAll('[data-pdf-preview]').forEach(el => {
    el.style.cursor = 'pointer';
    el.onclick = (e) => {
      e.preventDefault();
      showPdfPreview(el.dataset.pdfPreview, el.dataset.docName || 'Documento');
    };
  });
  scope.querySelectorAll('[data-doc-open]').forEach(el => {
    el.style.cursor = 'pointer';
    el.onclick = (e) => {
      e.preventDefault();
      window.open(el.dataset.docOpen, '_blank');
    };
  });
}

// Lightbox de imagen con prev/next, zoom, descargar y cerrar.
function showImageLightbox(images, startIdx) {
  document.getElementById('img-lightbox')?.remove();
  let idx = startIdx;
  const lb = document.createElement('div');
  lb.id = 'img-lightbox';
  lb.className = 'img-lightbox';
  lb.innerHTML = `
    <button class="lb-close" title="Cerrar (Esc)">✕</button>
    <a class="lb-download" download title="Descargar">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
    </a>
    <button class="lb-nav lb-prev" title="Anterior">‹</button>
    <button class="lb-nav lb-next" title="Siguiente">›</button>
    <div class="lb-stage"><img id="lb-img" alt=""></div>
    <div class="lb-counter"></div>
  `;
  document.body.appendChild(lb);
  void lb.offsetWidth; lb.classList.add('open'); requestAnimationFrame(() => lb.classList.add('open'));
  const imgEl = lb.querySelector('#lb-img');
  const counter = lb.querySelector('.lb-counter');
  const prevBtn = lb.querySelector('.lb-prev');
  const nextBtn = lb.querySelector('.lb-next');
  const dlLink = lb.querySelector('.lb-download');
  const update = () => {
    imgEl.src = images[idx];
    dlLink.href = images[idx];
    counter.textContent = images.length > 1 ? `${idx + 1} / ${images.length}` : '';
    prevBtn.style.display = nextBtn.style.display = images.length > 1 ? '' : 'none';
  };
  update();
  // Zoom on click
  let zoomed = false;
  imgEl.onclick = (e) => {
    e.stopPropagation();
    zoomed = !zoomed;
    imgEl.classList.toggle('zoomed', zoomed);
  };
  prevBtn.onclick = (e) => { e.stopPropagation(); idx = (idx - 1 + images.length) % images.length; zoomed = false; imgEl.classList.remove('zoomed'); update(); };
  nextBtn.onclick = (e) => { e.stopPropagation(); idx = (idx + 1) % images.length; zoomed = false; imgEl.classList.remove('zoomed'); update(); };
  const close = () => { lb.classList.remove('open'); setTimeout(() => lb.remove(), 150); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft' && images.length > 1) prevBtn.click();
    else if (e.key === 'ArrowRight' && images.length > 1) nextBtn.click();
  };
  document.addEventListener('keydown', onKey);
  lb.querySelector('.lb-close').onclick = close;
  lb.addEventListener('click', (e) => { if (e.target === lb || e.target.classList.contains('lb-stage')) close(); });
}

// Preview de PDF en modal con iframe (renderiza nativo del browser).
function showPdfPreview(src, name) {
  document.getElementById('pdf-preview-modal')?.remove();
  const bg = document.createElement('div');
  bg.id = 'pdf-preview-modal';
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal pdf-preview-modal" style="max-width:1100px;width:96vw;height:92vh;display:flex;flex-direction:column">
      <div class="modal-h" style="display:flex;align-items:center;gap:10px">
        <h3 style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(name)}</h3>
        <a class="btn btn-ghost" href="${escapeHtml(src)}" download="${escapeHtml(name)}" title="Descargar">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="vertical-align:middle"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        </a>
        <a class="btn btn-ghost" href="${escapeHtml(src)}" target="_blank" title="Abrir en pestaña nueva">↗</a>
        <button class="btn btn-ghost pdf-close" title="Cerrar (Esc)">✕</button>
      </div>
      <div class="modal-body" style="flex:1;padding:0;background:#1a1a1a">
        <iframe src="${escapeHtml(src)}#toolbar=1&navpanes=0" style="width:100%;height:100%;border:0;display:block"></iframe>
      </div>
    </div>
  `;
  document.body.appendChild(bg);
  void bg.offsetWidth; bg.classList.add('open'); requestAnimationFrame(() => bg.classList.add('open'));
  const close = () => { bg.classList.remove('open'); setTimeout(() => bg.remove(), 150); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bg.querySelector('.pdf-close').onclick = close;
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
}

// Right-click sobre cualquier mensaje: muestra menú con "Reenviar".
// Solo funciona si el mensaje tiene wamid (no para optimistic locales sin wamid).
function bindMessageContextMenus(root) {
  const scope = root || document;
  scope.querySelectorAll('.chat-msg[data-wamid]').forEach(el => {
    const wamid = el.dataset.wamid;
    const msgType = el.dataset.msgType || 'text';
    if (!wamid) return; // sin wamid no se puede citar/reenviar
    // Idempotente: si ya lo bindeamos, no volver a agregar listeners (los
    // addEventListener de touch NO son idempotentes y se duplicarían).
    if (el.dataset._ctxBound) return;
    el.dataset._ctxBound = '1';
    el.oncontextmenu = (e) => {
      e.preventDefault();
      showMessageActionsMenu(e.clientX, e.clientY, wamid, msgType);
    };
    // DESKTOP: el chevron (aparece al hover) abre el mismo menú de acciones.
    const caret = el.querySelector('.chat-msg-caret');
    if (caret && !caret.dataset._bound) {
      caret.dataset._bound = '1';
      caret.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        const r = caret.getBoundingClientRect();
        showMessageActionsMenu(r.right, r.bottom, wamid, msgType);
      };
    }
    // DESKTOP: doble-click cita el mensaje para responder (estilo WhatsApp).
    el.ondblclick = (e) => { e.preventDefault(); startReplyTo(wamid); };
    // MOBILE: swipe a la DERECHA → citar; mantener apretado (long-press) → menú.
    // Ambos gestos conviven: si el dedo se mueve, se cancela el long-press; si se
    // queda quieto ~480ms, abre el menú (como WhatsApp en el celular).
    let _sx = 0, _sy = 0, _swiping = false, _lpTimer = null, _lpFired = false;
    const _clearLp = () => { if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; } };
    el.addEventListener('touchstart', (ev) => {
      if (ev.touches.length !== 1) { _swiping = false; _clearLp(); return; }
      _sx = ev.touches[0].clientX; _sy = ev.touches[0].clientY; _swiping = true; _lpFired = false;
      el.style.transition = '';
      _clearLp();
      _lpTimer = setTimeout(() => {
        _lpFired = true; _swiping = false; el.style.transform = '';
        try { if (navigator.vibrate) navigator.vibrate(15); } catch (_) {}
        showMessageActionsMenu(_sx, _sy, wamid, msgType);
      }, 480);
    }, { passive: true });
    el.addEventListener('touchmove', (ev) => {
      const dx = ev.touches[0].clientX - _sx;
      const dy = ev.touches[0].clientY - _sy;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) _clearLp(); // se movió → no es long-press
      if (!_swiping) return;
      if (Math.abs(dy) > Math.abs(dx)) { _swiping = false; el.style.transform = ''; return; }
      if (dx > 0) el.style.transform = `translateX(${Math.min(dx, 80)}px)`;
    }, { passive: true });
    el.addEventListener('touchend', (ev) => {
      _clearLp();
      if (_lpFired) { _lpFired = false; _swiping = false; el.style.transition = 'transform .15s ease'; el.style.transform = ''; return; }
      if (!_swiping) return;
      _swiping = false;
      const dx = (ev.changedTouches[0] ? ev.changedTouches[0].clientX : _sx) - _sx;
      if (dx > 45) {
        // preventDefault marca el gesto como acción deliberada → iOS permite que
        // el focus() del input abra el TECLADO (como WhatsApp). Citamos (banner)
        // y enfocamos DENTRO del gesto, antes del reset visual.
        ev.preventDefault();
        startReplyTo(wamid);
        const ta = document.getElementById('chat-input');
        if (ta) { ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) {} }
      }
      el.style.transition = 'transform .15s ease';
      el.style.transform = '';
    }, { passive: false });
  });
}

// Hover actions (forward + react) inline al lado del bubble — estilo WA Web.
function bindMessageHoverActions(root) {
  const scope = root || document;
  scope.querySelectorAll('.chat-msg[data-wamid] .chat-msg-actions').forEach(actions => {
    const bubble = actions.closest('.chat-msg');
    if (!bubble) return;
    const wamid = bubble.dataset.wamid;
    const msgType = bubble.dataset.msgType || 'text';
    if (!wamid) return;
    const fwdBtn = actions.querySelector('[data-cma="forward"]');
    const reactBtn = actions.querySelector('[data-cma="react"]');
    if (fwdBtn) fwdBtn.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      startForwardSelection(wamid);
    };
    if (reactBtn) reactBtn.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      showReactionPicker(reactBtn, wamid);
    };
    const replyBtn = actions.querySelector('[data-cma="reply"]');
    if (replyBtn) replyBtn.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      startReplyTo(wamid);
    };
  });
}

// Marca el mensaje como "respondiendo a", muestra el banner sobre el input
// y enfoca el textarea. El send() existente lee chatState.replyingTo.
function startReplyTo(wamid) {
  const m = findMessageByWamid(wamid);
  if (!m) return;
  chatState.replyingTo = wamid;
  renderReplyBanner();
  const ta = document.getElementById('chat-input');
  if (ta) ta.focus();
}

function cancelReply() {
  chatState.replyingTo = null;
  renderReplyBanner();
}

function renderReplyBanner() {
  // El banner va ARRIBA de toda la barra de input (full-width, estilo WhatsApp),
  // NO adentro de .chat-input-bar. Si se insertaba antes de .chat-input-wrap,
  // quedaba como hijo en fila del flex horizontal y le robaba ancho al textarea
  // → el textarea colapsaba a ~1 carácter y el texto se veía VERTICAL. Anclando
  // en .chat-input-bar (cuyo contenedor apila en columna, igual que el banner de
  // 24h) el banner queda arriba y el input mantiene su ancho.
  const bar = document.querySelector('.chat-input-bar');
  if (!bar) return;
  document.getElementById('reply-banner')?.remove();
  if (!chatState.replyingTo) return;
  const m = findMessageByWamid(chatState.replyingTo);
  if (!m) return;
  const author = m.direction === 'outbound' ? 'Vos' : (m.sender_name || 'Cliente');
  let preview = '';
  if (m.msg_type === 'image') preview = '📷 Imagen' + (m.body ? ' · ' + m.body : '');
  else if (m.msg_type === 'audio') preview = '🎤 Audio';
  else if (m.msg_type === 'video') preview = '🎬 Video';
  else if (m.msg_type === 'document') preview = '📄 ' + (m.body || 'Documento');
  else preview = tplMarkerToText(m.body || '', m.phone || chatState.selectedPhone).slice(0, 140);
  const banner = document.createElement('div');
  banner.id = 'reply-banner';
  banner.className = 'reply-banner';
  banner.innerHTML = `
    <div class="reply-banner-line"></div>
    <div class="reply-banner-content">
      <div class="rb-author">${escapeHtml(author)}</div>
      <div class="rb-text">${escapeHtml(preview)}</div>
    </div>
    <button class="rb-close" title="Cancelar (Esc)">✕</button>
  `;
  wrap.before(banner);
  banner.querySelector('.rb-close').onclick = cancelReply;
}

function showReactionPicker(anchor, wamid) {
  document.getElementById('reaction-picker')?.remove();
  const emojis = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  const pop = document.createElement('div');
  pop.id = 'reaction-picker';
  pop.className = 'reaction-picker';
  pop.innerHTML = emojis.map(e => `<button class="rp-emoji" data-emoji="${e}">${e}</button>`).join('') +
    `<button class="rp-emoji rp-more" data-more title="Otro">＋</button>`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let left = r.left + r.width / 2 - pr.width / 2;
  let top = r.top - pr.height - 8;
  if (top < 8) top = r.bottom + 8;
  left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8));
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  void pop.offsetWidth; pop.classList.add('open'); requestAnimationFrame(() => pop.classList.add('open'));
  const close = () => { pop.remove(); document.removeEventListener('click', closer, true); document.removeEventListener('keydown', escer); };
  function closer(ev) { if (!pop.contains(ev.target) && ev.target !== anchor) close(); }
  function escer(ev) { if (ev.key === 'Escape') close(); }
  setTimeout(() => {
    document.addEventListener('click', closer, true);
    document.addEventListener('keydown', escer);
  }, 0);
  pop.querySelectorAll('[data-emoji]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const emoji = btn.dataset.emoji;
      close();
      sendReaction(wamid, emoji);
    };
  });
  pop.querySelector('[data-more]').onclick = (e) => {
    e.stopPropagation();
    const custom = prompt('Emoji para reaccionar:');
    close();
    if (custom && custom.trim()) sendReaction(wamid, custom.trim());
  };
}

async function sendReaction(wamid, emoji) {
  const phone = chatState.selectedPhone;
  if (!phone || !wamid) return;
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/react', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ phone, wamid, emoji })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast('Error al reaccionar: ' + (j.error || 'fallo'));
      return;
    }
    // Reflejo optimista local: agregar reacción a chatState.messages.
    chatState.messages.push({
      ts: new Date().toISOString(),
      wamid: j.id || ('local_react_' + Date.now()),
      direction: 'outbound',
      phone,
      msg_type: 'reaction',
      body: emoji,
      context_id: wamid,
      status: 'sent'
    });
    renderChatMessages();
  } catch (_) {
    toast('Error de red');
  }
}

function showMessageActionsMenu(x, y, wamid, msgType) {
  document.getElementById('msg-action-menu')?.remove();
  const _m = findMessageByWamid(wamid);
  const _hasText = !!(_m && _m.body && String(_m.body).trim() && _m.msg_type !== 'reaction');
  const menu = document.createElement('div');
  menu.id = 'msg-action-menu';
  menu.className = 'chat-context-menu';
  menu.innerHTML = `
    <button class="ccm-item" data-action="reply">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>
      Responder
    </button>
    <button class="ccm-item" data-action="react">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-3.5 6c.83 0 1.5.67 1.5 1.5S9.33 11 8.5 11 7 10.33 7 9.5 7.67 8 8.5 8zm7 0c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5-1.5-.67-1.5-1.5.67-1.5 1.5-1.5zM12 17.5c-2.33 0-4.31-1.46-5.11-3.5h10.22c-.8 2.04-2.78 3.5-5.11 3.5z"/></svg>
      Reaccionar
    </button>
    <button class="ccm-item" data-action="forward">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 8V4l8 8-8 8v-4H4V8h8z"/></svg>
      Reenviar
    </button>
    ${msgType === 'image' ? `
    <button class="ccm-item" data-action="copy-image">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
      Copiar imagen
    </button>` : ''}
    ${_hasText ? `
    <button class="ccm-item" data-action="copy-text">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
      Copiar texto
    </button>` : ''}
  `;
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
  void menu.offsetWidth; menu.classList.add('open'); requestAnimationFrame(() => menu.classList.add('open'));
  const close = () => { menu.remove(); document.removeEventListener('click', closer, true); document.removeEventListener('keydown', escer); };
  function closer(ev) { if (!menu.contains(ev.target)) close(); }
  function escer(ev) { if (ev.key === 'Escape') close(); }
  setTimeout(() => {
    document.addEventListener('click', closer, true);
    document.addEventListener('keydown', escer);
  }, 0);
  menu.querySelector('[data-action="forward"]').onclick = (ev) => {
    ev.stopPropagation();
    close();
    startForwardSelection(wamid);
  };
  menu.querySelector('[data-action="react"]').onclick = (ev) => {
    ev.stopPropagation();
    close();
    // Anclar el picker al punto de click — creamos un anchor virtual.
    const fakeAnchor = { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y, width: 0, height: 0 }) };
    showReactionPicker(fakeAnchor, wamid);
  };
  menu.querySelector('[data-action="reply"]').onclick = (ev) => {
    ev.stopPropagation();
    close();
    startReplyTo(wamid);
  };
  const copyImgBtn = menu.querySelector('[data-action="copy-image"]');
  if (copyImgBtn) copyImgBtn.onclick = (ev) => {
    ev.stopPropagation();
    close();
    copyImageOfMessage(wamid);
  };
  const copyTxtBtn = menu.querySelector('[data-action="copy-text"]');
  if (copyTxtBtn) copyTxtBtn.onclick = (ev) => { ev.stopPropagation(); close(); copyTextOfMessage(wamid); };
}

// Copia el TEXTO de un mensaje (click derecho / long-press → "Copiar texto").
// Necesario en mobile porque desactivamos la selección nativa para el long-press.
async function copyTextOfMessage(wamid) {
  const m = findMessageByWamid(wamid);
  if (!m) return;
  const txt = (typeof tplMarkerToText === 'function')
    ? tplMarkerToText(m.body || '', m.phone || chatState.selectedPhone)
    : (m.body || '');
  if (!txt || !txt.trim()) { toast('No hay texto para copiar'); return; }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(txt);
      toast('Texto copiado');
    } else {
      // Fallback para navegadores viejos / contextos sin clipboard API.
      const ta = document.createElement('textarea');
      ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Texto copiado'); } catch (_) { toast('No se pudo copiar'); }
      ta.remove();
    }
  } catch (_) { toast('No se pudo copiar'); }
}

// Copia la imagen de un mensaje al portapapeles (click derecho / long-press →
// "Copiar imagen"). El portapapeles en Chrome solo acepta image/png, así que si
// la imagen es jpeg/webp la convertimos vía canvas antes de copiar.
async function copyImageOfMessage(wamid) {
  if (!navigator.clipboard || !window.ClipboardItem) {
    toast('Tu navegador no permite copiar imágenes');
    return;
  }
  const el = document.querySelector(`.chat-msg[data-wamid="${(window.CSS && CSS.escape) ? CSS.escape(wamid) : wamid}"] img`);
  const src = el?.getAttribute('src') || el?.dataset?.imgPreview;
  if (!src) { toast('No encontré la imagen'); return; }
  try {
    const resp = await fetch(src);
    const blob = await resp.blob();
    let outBlob = blob;
    if (blob.type !== 'image/png') {
      outBlob = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const cv = document.createElement('canvas');
          cv.width = img.naturalWidth; cv.height = img.naturalHeight;
          cv.getContext('2d').drawImage(img, 0, 0);
          cv.toBlob(b => b ? resolve(b) : reject(new Error('canvas')), 'image/png');
        };
        img.onerror = reject;
        img.src = URL.createObjectURL(blob);
      });
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': outBlob })]);
    toast('Imagen copiada ✓');
  } catch (e) {
    toast('No pude copiar la imagen');
  }
}

// ===== Modo selección para reenviar VARIOS mensajes (estilo WhatsApp) =====
// "Reenviar" en el menú de un mensaje entra en este modo: se marca ese mensaje y podés
// tocar otros para sumarlos; la barra de abajo abre el selector de destinatarios con TODOS.
function ensureFwdStyles() {
  if (document.getElementById('fwd-styles')) return;
  const s = document.createElement('style'); s.id = 'fwd-styles';
  s.textContent = `
    .chat-messages.fwd-selecting .chat-msg{cursor:pointer}
    .chat-msg.fwd-checked{background:rgba(143,212,222,.16);outline:2px solid var(--accent-cyan,#8FD4DE);border-radius:10px}
    #fwd-bar{position:sticky;bottom:0;z-index:40;display:flex;align-items:center;gap:12px;padding:10px 16px;background:var(--ink-200,#1b2836);border-top:1px solid var(--border)}
    #fwd-bar .fwd-lbl{color:var(--fg);font-weight:600;font-size:13px}
    #fwd-bar .fwd-go{margin-left:auto;background:var(--accent-cyan,#8FD4DE);color:#04222a;border:none;border-radius:20px;padding:8px 18px;font-weight:700;cursor:pointer;font-size:13px}
    #fwd-bar .fwd-go:disabled{opacity:.45;cursor:default}
    #fwd-bar .fwd-x{background:none;border:none;color:var(--fg-subtle);font-size:20px;line-height:1;cursor:pointer}
  `;
  document.head.appendChild(s);
}
function startForwardSelection(wamid) {
  ensureFwdStyles();
  chatState.fwdMode = true;
  chatState.fwdSel = new Set(wamid ? [wamid] : []);
  document.querySelector('.chat-messages')?.classList.add('fwd-selecting');
  applyFwdSelectionUI();
}
function applyFwdSelectionUI() {
  const sel = chatState.fwdSel || new Set();
  document.querySelectorAll('.chat-msg[data-wamid]').forEach(el => {
    el.classList.toggle('fwd-checked', sel.has(el.dataset.wamid));
    if (!el.dataset._fwdBound) { el.dataset._fwdBound = '1'; el.addEventListener('click', fwdBubbleClick, true); }
  });
  renderFwdBar();
}
function fwdBubbleClick(e) {
  if (!chatState.fwdMode) return;
  const el = e.currentTarget; const w = el.dataset.wamid; if (!w) return;
  e.preventDefault(); e.stopPropagation();
  const sel = chatState.fwdSel;
  if (sel.has(w)) sel.delete(w); else sel.add(w);
  el.classList.toggle('fwd-checked', sel.has(w));
  renderFwdBar();
}
function renderFwdBar() {
  let bar = document.getElementById('fwd-bar');
  if (!chatState.fwdMode) { bar?.remove(); return; }
  const main = document.querySelector('.chat-main'); if (!main) return;
  if (!bar) { bar = document.createElement('div'); bar.id = 'fwd-bar'; main.appendChild(bar); }
  const n = chatState.fwdSel.size;
  bar.innerHTML = `<button class="fwd-x" title="Cancelar">✕</button><span class="fwd-lbl">${n} mensaje${n === 1 ? '' : 's'} seleccionado${n === 1 ? '' : 's'}</span><button class="fwd-go"${n ? '' : ' disabled'}>Reenviar →</button>`;
  bar.querySelector('.fwd-x').onclick = exitForwardSelection;
  bar.querySelector('.fwd-go').onclick = () => { const ids = Array.from(chatState.fwdSel); if (!ids.length) return; exitForwardSelection(); showForwardModal(ids); };
}
function exitForwardSelection() {
  chatState.fwdMode = false;
  document.querySelector('.chat-messages')?.classList.remove('fwd-selecting');
  document.querySelectorAll('.chat-msg.fwd-checked').forEach(el => el.classList.remove('fwd-checked'));
  document.getElementById('fwd-bar')?.remove();
  chatState.fwdSel = new Set();
}

function showForwardModal(wamidOrIds, msgType) {
  // Acepta un wamid solo (compat) o un array (reenvío de varios mensajes a la vez).
  const wamids = (Array.isArray(wamidOrIds) ? wamidOrIds : [wamidOrIds]).filter(Boolean);
  if (!wamids.length) return;
  document.getElementById('forward-modal')?.remove();
  const bg = document.createElement('div');
  bg.id = 'forward-modal';
  bg.className = 'modal-bg';
  // Contactos disponibles, ordenados por recencia (chatState.contacts ya viene
  // ordenado por último mensaje, ver ~línea 7113). Hay 7000+: NO los pintamos
  // todos de una o el main thread se clava 1-2s (mismo problema que el sidebar,
  // ver windowing en renderChat). Renderizamos de a FWD_PAGE; el scroll suma y
  // la búsqueda re-filtra sobre la lista completa en memoria.
  const allContacts = [...chatState.contacts].filter(c => !isArchived(c.phone));
  const FWD_PAGE = 50;
  let fwdLimit = FWD_PAGE;
  let lastFilteredCount = 0;
  // Selección persistida fuera del DOM: como re-renderizamos al buscar/scrollear
  // los checkboxes se recrean, así que el Set es la fuente de verdad de a quién
  // reenviar (podés elegir a uno, buscar otro lejano y mantener ambos marcados).
  const selected = new Set();
  bg.innerHTML = `
    <div class="modal" style="max-width:480px">
      <div class="modal-h"><h3>Reenviar${wamids.length > 1 ? ' ' + wamids.length + ' mensajes' : ''} a…</h3></div>
      <div class="modal-body" style="padding:0;display:flex;flex-direction:column">
        <div style="padding:10px 14px;border-bottom:1px solid var(--border)">
          <input type="text" id="fwd-search" placeholder="Buscar contacto…" autocomplete="off" style="width:100%;padding:8px 10px;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);color:var(--fg);font-size:13px">
        </div>
        <div id="fwd-list" style="max-height:380px;overflow-y:auto;padding:6px 0"></div>
      </div>
      <div class="modal-actions">
        <span id="fwd-count" style="margin-right:auto;color:var(--fg-subtle);font-size:12px">0 seleccionados</span>
        <button class="btn btn-ghost modal-cancel">Cancelar</button>
        <button class="btn btn-cyan" id="fwd-confirm" disabled>Reenviar</button>
      </div>
    </div>
  `;
  document.body.appendChild(bg);
  void bg.offsetWidth; bg.classList.add('open'); requestAnimationFrame(() => bg.classList.add('open'));
  const close = () => { bg.classList.remove('open'); setTimeout(() => bg.remove(), 150); };
  bg.querySelector('.modal-cancel').onclick = close;
  bg.addEventListener('click', e => { if (e.target === bg) close(); });

  const search = bg.querySelector('#fwd-search');
  const listEl = bg.querySelector('#fwd-list');
  const countEl = bg.querySelector('#fwd-count');
  const confirmBtn = bg.querySelector('#fwd-confirm');

  const itemHtml = c => `
    <label class="fwd-item">
      <input type="checkbox" value="${escapeHtml(c.phone)}"${selected.has(c.phone) ? ' checked' : ''}>
      ${avatarHtml(c.phone, c.name, 36)}
      <div class="fwd-item-text">
        <div class="fwd-item-name">${escapeHtml(c.name || formatPhoneDisplay(c.phone))}</div>
        <div class="fwd-item-sub">${escapeHtml(formatPhoneDisplay(c.phone))}</div>
      </div>
    </label>
  `;

  // El contador y el botón se rigen por el Set, no por los checkboxes del DOM
  // (que son solo la ventana visible).
  const updateCount = () => {
    const n = selected.size;
    countEl.textContent = `${n} seleccionado${n === 1 ? '' : 's'}`;
    confirmBtn.disabled = n === 0;
  };

  // Filtra sobre los 7000+ en memoria y re-renderiza SOLO la ventana visible.
  // preserveScroll=true al sumar página (scroll infinito) para no saltar;
  // false al buscar/abrir (mostramos desde arriba).
  const renderList = ({ preserveScroll = false } = {}) => {
    const q = search.value.toLowerCase().trim();
    let filtered = allContacts;
    if (q) filtered = allContacts.filter(c =>
      (c.name || '').toLowerCase().includes(q) ||
      c.phone.includes(q) ||
      (formatPhoneDisplay(c.phone) || '').toLowerCase().includes(q));
    lastFilteredCount = filtered.length;
    const visible = filtered.slice(0, fwdLimit);
    const st = listEl.scrollTop;
    listEl.innerHTML = visible.length
      ? visible.map(itemHtml).join('')
      : '<div style="padding:18px 14px;text-align:center;color:var(--fg-subtle);font-size:13px">Sin resultados</div>';
    listEl.scrollTop = preserveScroll ? st : 0;
    listEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.onchange = () => {
        if (cb.checked) selected.add(cb.value); else selected.delete(cb.value);
        updateCount();
      };
    });
  };

  // Scroll infinito: cerca del fondo suma una página si quedan más por mostrar.
  listEl.addEventListener('scroll', () => {
    if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 200
        && fwdLimit < lastFilteredCount) {
      fwdLimit += FWD_PAGE;
      renderList({ preserveScroll: true });
    }
  });

  // Búsqueda: filtra la lista COMPLETA y re-renderiza los matches desde arriba.
  // (Antes solo toggleaba display sobre los visibles → no encontraba a los de
  // más abajo de los primeros 50.) Reseteamos la ventana a la primera página.
  search.oninput = () => { fwdLimit = FWD_PAGE; renderList(); };

  renderList();

  confirmBtn.onclick = async () => {
    const phones = Array.from(selected);
    if (!phones.length) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Reenviando…';
    try {
      const r = await fetch(CONFIG.trackerUrl + '/admin/wa/forward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ wamids, to_phones: phones })
      });
      const j = await r.json();
      if (r.ok) {
        toast(`✓ Reenviado a ${phones.length} ${phones.length === 1 ? 'persona' : 'personas'}${j.failed ? ' (' + j.failed + ' fallaron)' : ''}`);
        close();
      } else {
        toast('Error: ' + (j.error || 'fallo'));
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Reenviar';
      }
    } catch (e) {
      toast('Error de red');
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Reenviar';
    }
  };
  setTimeout(() => search.focus(), 50);
}

function bindAudioPlayers(root) {
  const scope = root || document;
  // Speed buttons (1x → 1.5x → 2x → 1x)
  scope.querySelectorAll('.audio-speed').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const audioEl = btn.closest('.chat-msg-audio')?.querySelector('audio[data-audio-el]');
      if (!audioEl) return;
      const cur = parseFloat(btn.dataset.audioSpeed || '1');
      const next = cur === 1 ? 1.5 : cur === 1.5 ? 2 : 1;
      btn.dataset.audioSpeed = String(next);
      btn.textContent = next + 'x';
      audioEl.playbackRate = next;
    };
  });
  // Toggle transcripción
  scope.querySelectorAll('[data-toggle-transcript]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const target = document.getElementById(btn.dataset.toggleTranscript);
      if (!target) return;
      const visible = target.style.display !== 'none';
      target.style.display = visible ? 'none' : 'block';
      btn.classList.toggle('active', !visible);
    };
  });
  // Bind click on audio bars to play/pause
  scope.querySelectorAll('.chat-msg-audio .audio-bars').forEach(bars => {
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

  // Botón play/pausa explícito (símbolo ▶/⏸) — además del click en la onda.
  // Sincroniza el ícono con el estado REAL del audio (play/pause/ended), así
  // refleja también cuando se pausa solo al reproducir otro audio.
  scope.querySelectorAll('.chat-msg-audio').forEach(box => {
    const audioEl = box.querySelector('audio[data-audio-el]');
    const playBtn = box.querySelector('[data-audio-play]');
    if (!audioEl || !playBtn) return;
    const icoPlay = playBtn.querySelector('.ico-play');
    const icoPause = playBtn.querySelector('.ico-pause');
    const syncIcon = () => {
      const playing = !audioEl.paused && !audioEl.ended;
      if (icoPlay) icoPlay.style.display = playing ? 'none' : '';
      if (icoPause) icoPause.style.display = playing ? '' : 'none';
    };
    playBtn.onclick = (e) => {
      e.stopPropagation();
      if (audioEl.paused) {
        document.querySelectorAll('audio[data-audio-el]').forEach(a => { if (a !== audioEl) a.pause(); });
        audioEl.play();
      } else {
        audioEl.pause();
      }
    };
    audioEl.addEventListener('play', syncIcon);
    audioEl.addEventListener('pause', syncIcon);
    audioEl.addEventListener('ended', syncIcon);
    syncIcon();
  });
}

// ===== Mobile chat navigation (estilo WhatsApp app) =====
// En pantallas ≤768px el chat funciona como WA mobile: lista de chats full-screen,
// tap → conversación full-screen con back arrow. Mantenemos history.pushState así
// el botón "atrás" del browser/Android funciona como esperás.
function _isMobileViewport() {
  return window.matchMedia('(max-width: 768px)').matches;
}
function _applyMobileChatClass() {
  const appEl = document.querySelector('.app');
  if (!appEl) return;
  appEl.classList.remove('chat-mobile-list', 'chat-mobile-conv');
  if (STATE.view !== 'chat') return;
  // Aplicamos las classes SIEMPRE (no solo en mobile) — el CSS las activa solo
  // bajo el media query, así no rompemos el split-view de desktop.
  appEl.classList.add(chatState.mobileView === 'conversation' ? 'chat-mobile-conv' : 'chat-mobile-list');
}
function enterMobileChatConversation() {
  chatState.mobileView = 'conversation';
  _applyMobileChatClass();
  // Marker en history para que el botón "atrás" del browser nos devuelva a la lista
  // en vez de salir del chat view. Solo si todavía no estamos en un state nuestro.
  if (_isMobileViewport()) {
    try {
      if (!history.state || history.state.mobileChat !== 'conversation') {
        history.pushState({ mobileChat: 'conversation' }, '');
      }
    } catch (_) {}
  }
}
function exitMobileChatConversation() {
  chatState.mobileView = 'list';
  _applyMobileChatClass();
  // Volvemos al state anterior (la lista) sin pushear uno nuevo, así "atrás"
  // sigue navegando entre las views de la app.
  try {
    if (history.state && history.state.mobileChat === 'conversation') {
      history.back();
      return; // popstate handler abajo ya limpia
    }
  } catch (_) {}
}
// popstate (atrás del browser) en mobile + en chat conversation → volver a la lista.
if (typeof window !== 'undefined' && !window._chatPopstateBound) {
  window.addEventListener('popstate', (e) => {
    if (STATE.view !== 'chat') return;
    if (!_isMobileViewport()) return;
    if (chatState.mobileView === 'conversation') {
      chatState.mobileView = 'list';
      _applyMobileChatClass();
      // No prevenir default — dejamos que la navegación siga si hay más history.
    }
  });
  window._chatPopstateBound = true;
}

async function selectChatContact(phone) {
  chatState.selectedPhone = phone;
  const contact = chatState.contacts.find(c => c.phone === phone);
  chatState.selectedName = contact?.name || '';
  // En mobile, al tocar un chat pasamos a la vista "conversación full-screen"
  // (oculta lista + sidebar nav). En desktop esto no cambia nada visual.
  enterMobileChatConversation();
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

  // Lazy load ad attribution (no bloquea, se actualiza el banner cuando vuelve)
  loadAdAttribution(phone).then(() => {
    if (chatState.selectedPhone === phone && STATE.view === 'chat') {
      const main = document.querySelector('.chat-main');
      if (main) {
        // Re-renderizamos solo el banner sin tocar los mensajes (preserva scroll)
        const banner = main.querySelector('.ad-attribution-banner');
        const newBannerHtml = renderAdAttributionBanner(phone);
        if (newBannerHtml && !banner) {
          // No había banner antes — insertarlo después del postit (o después del header)
          const insertAfter = main.querySelector('.chat-postit') || main.querySelector('.chat-header');
          if (insertAfter) insertAfter.insertAdjacentHTML('afterend', newBannerHtml);
        } else if (newBannerHtml && banner) {
          banner.outerHTML = newBannerHtml;
        }
      }
    }
  });

  // Load messages — protegido contra race: si el usuario clickea otro chat
  // antes de que termine la carga, descartamos el resultado.
  try {
    await loadChatMessages(phone);
  } catch (e) {
    if (chatState.selectedPhone === phone) toast('Error al cargar la conversación');
  }
  chatState.loadingConv = false;
  // Si el usuario ya cambió de contacto durante el await, abortamos.
  if (chatState.selectedPhone !== phone) return;

  // Mark as read
  markConversationRead(phone);

  // Refrescar el estado del piloto al abrir un chat, así el banner de pre
  // cotización (si aplica) muestra el borrador/datos al día. Solo Gaspar.
  if (isAdmin()) { try { await fetchPrecotiz(); } catch (_) {} }
  // Re-render conversation with actual messages
  if (STATE.view === 'chat') {
    const main = document.querySelector('.chat-main');
    if (main) {
      main.innerHTML = renderChatConversation();
      bindChatConversation();
      bindAudioPlayers();
      bindMessageContextMenus();
      // Scroll al fondo (último mensaje), robusto a las imágenes que cargan después.
      scrollChatToBottom();
    }
    // Update unread badge on contact
    const contactEl = document.querySelector(`[data-chat-phone="${phone}"]`);
    if (contactEl) {
      const badge = contactEl.querySelector('.chat-contact-unread');
      if (badge) badge.remove();
    }
  }
}

// === Borradores por chat (persisten al cambiar de conversación y al recargar) ===
// Guarda lo que estás tipeando, indexado por teléfono, en localStorage. Al volver
// al chat (o recargar el CRM) el texto sigue ahí listo para mandar. Se borra al
// enviar el mensaje.
const DRAFTS_LS_KEY = 'ni_chat_drafts';
let _chatDrafts = (() => { try { return JSON.parse(localStorage.getItem(DRAFTS_LS_KEY) || '{}'); } catch (_) { return {}; } })();
function getDraft(phone) { return (phone && _chatDrafts[phone]) || ''; }
function setDraft(phone, text) {
  if (!phone) return;
  if (text && text.trim()) _chatDrafts[phone] = text;
  else delete _chatDrafts[phone];
  try { localStorage.setItem(DRAFTS_LS_KEY, JSON.stringify(_chatDrafts)); } catch (_) {}
}

// Scroll robusto al fondo del chat. Un solo scrollTop=scrollHeight queda CORTO al
// abrir, porque las imágenes todavía no cargaron (alto 0) → scrollHeight es chico y
// te deja en el medio. Re-scrolleamos en rAF + timeouts, y cuando carga cada imagen
// (solo si seguís cerca del fondo, para no tironearte si scrolleaste a leer historial).
function scrollChatToBottom() {
  const m = document.getElementById('chat-messages');
  if (!m) return;
  const toBottom = () => { const el = document.getElementById('chat-messages'); if (el) el.scrollTop = el.scrollHeight; };
  toBottom();
  requestAnimationFrame(toBottom);
  setTimeout(toBottom, 150);
  setTimeout(toBottom, 500);
  m.querySelectorAll('img').forEach(img => {
    if (img.complete) return;
    img.addEventListener('load', () => {
      const c = document.getElementById('chat-messages');
      if (c && (c.scrollHeight - c.scrollTop - c.clientHeight) < 800) c.scrollTop = c.scrollHeight;
    }, { once: true });
  });
}
function bindChatConversation() {
  if (isAdmin()) bindPrecotizChatBanner(chatState.selectedPhone);
  const ta = document.getElementById('chat-input');
  const btn = document.getElementById('chat-send-btn');
  const msgEl = document.getElementById('chat-messages');
  const scrollBtn = document.getElementById('chat-scroll-down');
  const attachBtn = document.getElementById('btn-attach');
  const fileInput = document.getElementById('chat-file-input');
  const micBtn = document.getElementById('btn-mic');
  const labelsBtn = document.getElementById('btn-labels');
  // Instagram: se RESPONDE (texto, imagen y audio) SOLO dentro de la ventana de 24 h. IG no
  // permite mandar fuera de la ventana y no tiene plantillas para reabrir como WhatsApp → si
  // está cerrada, avisamos y bloqueamos todo hasta que el cliente vuelva a escribir.
  const _selContact = (chatState.contacts || []).find(c => c.phone === chatState.selectedPhone);
  if (_selContact && _selContact.channel === 'ig') {
    let _lastInTs = 0;
    for (const m of (chatState.messages || [])) {
      if (m.direction === 'inbound') { const t = new Date(m.ts).getTime(); if (t > _lastInTs) _lastInTs = t; }
    }
    const _igOpen = _lastInTs && (Date.now() - _lastInTs) < 24 * 3600 * 1000;
    // Imagen y audio van por /admin/ig/send-media (mismo caño que WhatsApp). Dentro de la
    // ventana: habilitados. Fuera: bloqueados.
    if (attachBtn) attachBtn.disabled = !_igOpen;
    if (micBtn && !_igOpen) micBtn.style.display = 'none';
    if (ta) {
      ta.disabled = !_igOpen;
      ta.placeholder = _igOpen ? 'Responder por Instagram…' : '🔒 Ventana de 24 h cerrada — esperá a que el cliente escriba para poder responder';
    }
    if (btn) btn.disabled = !_igOpen;
  }
  // Botón "Crear brief" del header → abre el mismo modal del panel de Cotización
  // (con teléfono + WhatsApp pre-cargados) por encima de la conversación. Y bindea
  // ese modal por si quedó abierto tras este render.
  const chatBriefBtn = document.getElementById('btn-chat-brief');
  if (chatBriefBtn) chatBriefBtn.onclick = chooseBriefTypeFromChat;
  const frenarBotBtn = document.getElementById('btn-frenar-bot');
  if (frenarBotBtn) frenarBotBtn.onclick = async () => {
    const _ph = chatState.selectedPhone;
    const wasFrozen = frenarBotBtn.dataset.frozen === '1';
    const _msg = wasFrozen ? 'Reactivar el bot en este chat?' : 'Frenar el bot en este chat? No vuelve a hablar acá hasta que lo reactives a mano.';
    if (!await showConfirm(_msg, { title: wasFrozen ? 'Reactivar bot' : 'Frenar bot', confirmLabel: wasFrozen ? 'Reactivar' : 'Frenar' }).catch(() => false)) return;
    frenarBotBtn.disabled = true;
    try {
      const r = await fetch(CONFIG.trackerUrl + '/admin/precotiz/freeze', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: _ph, on: !wasFrozen }) });
      toast(r.ok ? (wasFrozen ? '✓ Bot reactivado' : '🛑 Bot frenado en este chat') : 'Error');
    } catch (_) { toast('Error de red'); }
    try { await loadChatContacts(true); } catch (_) {}
    render();
  };
  bindQuickCreateModal();
  const backBtn = document.getElementById('chat-back-btn');
  bindChatPostit();
  // Hidratar los bubbles recién renderizados: inyectar acciones (chevron + iconos
  // de hover + chips de reacción) y bindear menús (click derecho / long-press /
  // hover). renderChatConversation() arma los bubbles INLINE pero NO los
  // post-procesa — sin esto no aparecían ni el chevron ni los iconos de hover al
  // ABRIR un chat (solo se veían tras un update incremental). Todo idempotente.
  if (msgEl) {
    _postProcessBubbles(msgEl, renderChatBubbles._reactionsByParent || new Map());
    bindMessageContextMenus();
    bindMessageHoverActions();
    bindMediaPreviewClicks(); // sin esto, las imágenes no abrían el lightbox al ABRIR un chat (solo tras un update incremental)
  }
  // Back arrow del header (solo se ve en mobile via CSS, pero igual lo bindeamos
  // siempre para no tener que distinguir).
  if (backBtn) {
    backBtn.onclick = (e) => { e.preventDefault(); exitMobileChatConversation(); };
  }

  if (ta) {
    // Restaurar borrador guardado para este chat (si quedó algo sin enviar).
    const _draft = getDraft(chatState.selectedPhone);
    if (_draft && !ta.value) ta.value = _draft;
    ta.addEventListener('input', () => {
      // Marker para que el polling sepa que estás tipeando activamente
      // y evite refreshes pesados del sidebar mientras escribís.
      chatState._lastTypeMs = performance.now();
      // Persistir el borrador por chat (sobrevive al cambiar de conversación y recargar).
      setDraft(chatState.selectedPhone, ta.value);
      // El auto-resize del textarea lo maneja el CSS via `field-sizing: content`
      // (Chrome ≥123, Safari 17). No usamos JS para evitar reflows forzados.
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
        if (e.key === 'Enter' && active) { e.preventDefault(); pickQuickReply(ta, active); return; }
        if (e.key === 'Escape') { dd.style.display = 'none'; return; }
        if (e.key === 'Tab' && active) { e.preventDefault(); pickQuickReply(ta, active); return; }
      }
      if (e.key === 'Escape' && chatState.replyingTo) {
        e.preventDefault();
        cancelReply();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (ta.value.trim()) {
          sendChatMessage(chatState.selectedPhone, ta.value);
        }
      }
    });
    // Foco automático SOLO en desktop. En móvil, hacer focus al seleccionar un
    // chat dispara el teclado de inmediato y tapa media pantalla (el usuario
    // todavía está leyendo, no escribiendo) — el teclado debe salir recién
    // cuando toca el input.
    if (!_isMobileViewport()) ta.focus();
  }
  if (btn) {
    btn.onclick = () => {
      const ta = document.getElementById('chat-input');
      if (ta && ta.value.trim()) {
        sendChatMessage(chatState.selectedPhone, ta.value);
      }
    };
  }
  // Schedule button
  const schedBtn = document.getElementById('btn-schedule');
  if (schedBtn) {
    schedBtn.onclick = () => showScheduleModal(chatState.selectedPhone);
  }
  // Copiloto: botón "Sugerir" + contador de gasto (admin)
  const suggestBtn = document.getElementById('btn-suggest');
  if (suggestBtn) suggestBtn.onclick = () => requestSuggestion(chatState.selectedPhone);
  maybeRefreshCopilotCost();
  // Attach: soporta imágenes, videos, audios y documentos. Múltiples archivos.
  // Mandamos en serie con delay para evitar rate limit del WA Cloud API.
  if (attachBtn && fileInput) {
    attachBtn.onclick = openAttachMenu; // clip -> menú estilo WhatsApp (foto/video, documento, sticker)
    fileInput.onchange = async () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = '';
      await sendChatFiles(files);
    };
  }
  // Stickers: cargamos los favoritos una vez (el picker se abre desde el menú del clip) y
  // bindeamos el ⭐ para guardarlos (delegado en el contenedor de mensajes).
  if (!chatState.stickerFavsLoaded) { chatState.stickerFavsLoaded = true; loadStickerFavs(); }
  const _msgsEl = document.getElementById('chat-messages');
  if (_msgsEl && !_msgsEl._stickerFavBound) {
    _msgsEl._stickerFavBound = true;
    _msgsEl.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-sticker-fav]');
      if (!b) return;
      e.stopPropagation();
      const k = b.getAttribute('data-sticker-fav');
      const isFav = b.getAttribute('data-fav') === '1';
      toggleStickerFav(k, isFav);
      b.setAttribute('data-fav', isFav ? '0' : '1');
      b.textContent = isFav ? '☆' : '⭐';
      b.title = isFav ? 'Guardar sticker' : 'Quitar de mis stickers';
    });
  }
  // Paste de imágenes desde clipboard (Ctrl+V con imagen copiada)
  if (ta) {
    ta.addEventListener('paste', async (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const it of items) {
        if (it.kind === 'file') {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (!files.length) return; // texto plano: dejá que el browser lo pegue normal
      e.preventDefault();
      await sendChatFiles(files);
    });
  }
  // Drag and drop sobre el chat
  const chatMain = document.querySelector('.chat-main');
  if (chatMain && !chatMain.dataset.dropBound) {
    chatMain.dataset.dropBound = '1';
    let dragOverlay = null;
    const showOverlay = () => {
      if (dragOverlay) return;
      dragOverlay = document.createElement('div');
      dragOverlay.className = 'chat-drop-overlay';
      dragOverlay.innerHTML = '<div class="chat-drop-inner">📎<br>Soltá para enviar</div>';
      chatMain.appendChild(dragOverlay);
    };
    const hideOverlay = () => {
      if (dragOverlay) { dragOverlay.remove(); dragOverlay = null; }
    };
    chatMain.addEventListener('dragenter', (e) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        showOverlay();
      }
    });
    chatMain.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    chatMain.addEventListener('dragleave', (e) => {
      if (e.target === chatMain || e.target === dragOverlay) hideOverlay();
    });
    chatMain.addEventListener('drop', async (e) => {
      e.preventDefault();
      hideOverlay();
      const files = Array.from(e.dataTransfer?.files || []);
      if (!files.length) return;
      await sendChatFiles(files);
    });
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
  // 💰 Venta Abril — botón dedicado de 1 toque: togglea la etiqueta "Venta Abril"
  // en la conversación. Abril lo marca al vender un curso; Gaspar filtra a fin de mes.
  const ventaAbrilBtn = document.getElementById('btn-venta-abril');
  if (ventaAbrilBtn) ventaAbrilBtn.onclick = () => {
    const phone = chatState.selectedPhone;
    if (!phone) return;
    // Optimista: el toggle actualiza el estado al toque (el back persiste solo).
    toggleContactLabel(phone, VENTA_ABRIL_LABEL_ID);
    const has = (chatState.contactLabels[phone] || []).includes(VENTA_ABRIL_LABEL_ID);
    ventaAbrilBtn.classList.toggle('btn-cyan', has);
    ventaAbrilBtn.classList.toggle('btn-ghost', !has);
    ventaAbrilBtn.innerHTML = has ? '✅ Venta Abril' : '💰 Venta Abril';
    const chips = document.getElementById('chat-label-chips');
    if (chips) chips.innerHTML = renderContactLabelChips(phone);
    if (has) ventaAbrilCelebration();  // 🎰 fiesta solo al MARCAR
  };
  // Note button on header (al lado del de etiquetas)
  const noteBtn = document.getElementById('btn-note');
  if (noteBtn) noteBtn.onclick = () => {
    const phone = chatState.selectedPhone;
    if (!phone) return;
    chatState.editingNoteFor = phone;
    refreshPostit();
  };
  // 🎓 Derivar / sacar de la bandeja Cursos (solo admin).
  const cursosBtn = document.getElementById('btn-cursos-toggle');
  if (cursosBtn) cursosBtn.onclick = () => handleToggleCursos();
  const nadiaBtn = document.getElementById('btn-nadia-toggle');
  if (nadiaBtn) nadiaBtn.onclick = () => handleToggleNadia();
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

// Deriva (o saca) el chat activo a la bandeja de Cursos. Admin y comercial (Joaco).
async function handleToggleCursos() {
  const phone = chatState.selectedPhone;
  const role = getUserRole();
  if (!phone || !['admin', 'comercial', 'cursos'].includes(role)) return;
  const c = (chatState.contacts || []).find(x => x.phone === phone);
  const enCursos = c && c.inbox === 'cursos';
  const nuevo = enCursos ? 'general' : 'cursos';
  const nombre = (c && c.contact_name) || formatPhoneDisplay(phone);
  const ok = await showConfirm(
    enCursos
      ? `Sacar a "${nombre}" de la bandeja de Cursos.\n\nVuelve a la bandeja general (la ve Joaco).`
      : `Derivar a "${nombre}" a la bandeja de Cursos.\n\nLo va a ver Abril y sale de la bandeja de Joaco.`,
    { title: enCursos ? 'Sacar de Cursos' : 'Derivar a Cursos', confirmLabel: enCursos ? 'Sacar' : '🎓 Derivar', cancelLabel: 'Cancelar' }
  ).catch(() => false);
  if (!ok) return;
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/chat-inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ phone, inbox: nuevo })
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || ('HTTP ' + r.status)); }
    if (c) c.inbox = nuevo;  // refleja al instante en el botón
    toast(nuevo === 'cursos' ? '🎓 Derivado a Cursos — lo ve Abril' : 'Devuelto a la bandeja general');
    // Si el chat dejó de pertenecer a la bandeja del usuario, lo deseleccionamos
    // (Abril lo sacó a general, o Joaco lo derivó a cursos) — ya no lo puede ver.
    const yaNoVisible = (role === 'cursos' && nuevo === 'general') || (role === 'comercial' && nuevo === 'cursos');
    if (yaNoVisible) chatState.selectedPhone = null;
    // Refrescar la lista para que el chat salga (o entre) en la bandeja correcta.
    chatState.contactsLoaded = false;
    loadChatContacts().then(() => { updateUnreadBadge(); render(); }).catch(() => render());
  } catch (e) {
    await showAlert('No se pudo cambiar la bandeja: ' + (e.message || e), { title: 'Error', variant: 'warn' });
  }
}

// Asigna (o saca) el chat activo a la vendedora Nadia. Solo Gaspar (admin). Sin asignar
// = vuelve a la bandeja de Joaco. Reparto de vendedores (backend /admin/wa/chat-assign).
// Gaspar sigue viendo el chat igual (ve todo); cambia quién MÁS lo ve (Nadia sí, Joaco no).
async function handleToggleNadia() {
  const phone = chatState.selectedPhone;
  if (!phone || getUserRole() !== 'admin') return;
  const c = (chatState.contacts || []).find(x => x.phone === phone);
  const enNadia = c && c.assigned_to === 'nadia';
  const nuevo = enNadia ? '' : 'nadia';
  const nombre = (c && c.contact_name) || formatPhoneDisplay(phone);
  const ok = await showConfirm(
    enNadia
      ? `Sacar a "${nombre}" de Nadia.\n\nVuelve a la bandeja de Joaco.`
      : `Asignar a "${nombre}" a Nadia.\n\nLo va a ver Nadia y sale de la bandeja de Joaco.`,
    { title: enNadia ? 'Sacar de Nadia' : 'Asignar a Nadia', confirmLabel: enNadia ? 'Sacar' : '👤 Asignar', cancelLabel: 'Cancelar' }
  ).catch(() => false);
  if (!ok) return;
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/chat-assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ phone, assigned_to: nuevo })
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || ('HTTP ' + r.status)); }
    if (c) c.assigned_to = nuevo;  // refleja al instante en el botón
    toast(nuevo === 'nadia' ? '👤 Asignado a Nadia' : 'Devuelto a la bandeja de Joaco');
    chatState.contactsLoaded = false;
    loadChatContacts().then(() => { updateUnreadBadge(); render(); }).catch(() => render());
  } catch (e) {
    await showAlert('No se pudo asignar: ' + (e.message || e), { title: 'Error', variant: 'warn' });
  }
}

function _renderQRItem(q, i, active) {
  const hasMedia = !!q.media_r2_key;
  const icon = hasMedia ? `<img class="qr-thumb" src="${mediaUrl(q.media_r2_key)}" alt="">` : '';
  return `<div class="qr-item${i === 0 || active ? ' active' : ''}" data-qr-id="${q.id}" data-qr-body="${escapeHtml(q.body)}" data-qr-has-media="${hasMedia ? '1' : '0'}">
    ${icon}
    <div class="qr-item-text">
      <span class="qr-shortcut">/${escapeHtml(q.shortcut)}${hasMedia ? ' <span style="opacity:.6;font-size:10px">📷</span>' : ''}</span>
      <span class="qr-preview">${escapeHtml((q.body || '(solo imagen)').slice(0, 60))}</span>
    </div>
  </div>`;
}

// Item de PLANTILLA en el menú "/" (distinto de una respuesta guardada: badge
// + al elegirla se manda como template, sirve para reabrir charlas de +24h).
function _renderTplItem(t) {
  const preview = tplBodyText(t).replace(/\{\{\s*1\s*\}\}/g, '[nombre]');
  return `<div class="qr-item" data-tpl-name="${escapeHtml(t.name)}" data-tpl-lang="${escapeHtml(t.language || 'es_AR')}" data-tpl-params="${tplParamCount(t)}">
    <div class="qr-item-text">
      <span class="qr-shortcut">${escapeHtml(t.name)} <span style="opacity:.75;font-size:9px;border:1px solid currentColor;border-radius:4px;padding:0 4px;color:var(--neon-cyan,#8FD4DE)">PLANTILLA</span></span>
      <span class="qr-preview">${escapeHtml((preview || '').slice(0, 60))}</span>
    </div>
  </div>`;
}

function handleQuickReplyInput(ta) {
  const dd = document.getElementById('qr-dropdown');
  if (!dd) return;
  const val = ta.value;
  if (!val.startsWith('/')) { dd.style.display = 'none'; return; }
  loadChatTemplates(); // idempotente (por si no cargaron al abrir el chat)
  const query = val.slice(1).toLowerCase();
  const verts = qrVerticalsForUser(); // null = todas (admin)
  const qrs = (chatState.quickReplies || []).filter(q => !verts || verts.includes(q.vertical || 'carteles'));
  const tpls = (chatState.templates || []).filter(t => !verts || verts.includes(templateVertical(t.name)));
  let qrMatches, tplMatches;
  if (val === '/') {
    qrMatches = qrs.slice(0, 8);
    tplMatches = tpls.slice(0, 6);
  } else {
    qrMatches = qrs.filter(q => q.shortcut.toLowerCase().includes(query) || (q.body || '').toLowerCase().includes(query)).slice(0, 6);
    tplMatches = tpls.filter(t => (t.name || '').toLowerCase().includes(query) || tplBodyText(t).toLowerCase().includes(query)).slice(0, 4);
  }
  let html = qrMatches.map((q, i) => _renderQRItem(q, i, false)).join('');
  html += tplMatches.map(t => _renderTplItem(t)).join('');
  // Pie: crear una respuesta guardada nueva + crear plantilla al toque.
  html += `<div class="qr-item" data-qr-add="1"><div class="qr-item-text"><span class="qr-shortcut" style="color:var(--neon-cyan,#8FD4DE)">＋ Nueva respuesta guardada</span></div></div>`;
  html += `<div class="qr-item" data-tpl-create="1"><div class="qr-item-text"><span class="qr-shortcut" style="color:var(--neon-cyan,#8FD4DE)">📋 Crear plantilla nueva (Meta)</span></div></div>`;
  dd.innerHTML = html;
  dd.style.display = 'block';
  dd.querySelectorAll('.qr-item').forEach(el => { el.onclick = () => pickQuickReply(ta, el); });
}

async function pickQuickReply(ta, el) {
  const dd = document.getElementById('qr-dropdown');
  // "+" → abrir el panel para crear una respuesta guardada nueva.
  if (el.dataset.qrAdd === '1') {
    if (dd) dd.style.display = 'none';
    ta.value = ''; ta.dispatchEvent(new Event('input'));
    showManageQRModal();
    return;
  }
  // "Crear plantilla nueva (Meta)" → abre el cuadro de creación al toque.
  if (el.dataset.tplCreate === '1') {
    if (dd) dd.style.display = 'none';
    ta.value = ''; ta.dispatchEvent(new Event('input'));
    showCreateTemplateModal();
    return;
  }
  // Plantilla → mandarla como template (reabre charlas de +24h). Pide confirmación.
  if (el.dataset.tplName) {
    if (dd) dd.style.display = 'none';
    const name = el.dataset.tplName;
    const lang = el.dataset.tplLang || 'es_AR';
    const nParams = parseInt(el.dataset.tplParams || '0', 10) || 0;
    const ok = await showConfirm(`¿Mandar la plantilla "${name}"?\n\nSe envía como mensaje aprobado por Meta — sirve para reabrir conversaciones de más de 24h.`, { title: 'Enviar plantilla', confirmLabel: 'Enviar' });
    if (!ok) return;
    let params = [];
    if (nParams >= 1) {
      const c = (chatState.contacts || []).find(x => x.phone === chatState.selectedPhone);
      const first = ((c && c.name) || '').trim().split(/\s+/)[0] || 'amigo/a';
      params = [first];
    }
    ta.value = ''; ta.dispatchEvent(new Event('input'));
    toast('Enviando plantilla…');
    const j = await sendTemplateToChat(chatState.selectedPhone, name, lang, params);
    if (j && j.id) {
      try { await loadChatMessages(chatState.selectedPhone); renderChatMessages(); } catch (_) {}
      toast('✓ Plantilla enviada');
    } else {
      toast('Error al enviar la plantilla');
    }
    return;
  }
  const hasMedia = el.dataset.qrHasMedia === '1';
  const qrId = parseInt(el.dataset.qrId);
  const body = el.dataset.qrBody;
  if (dd) dd.style.display = 'none';
  if (hasMedia && chatState.selectedPhone) {
    // Mandar directo (imagen + caption) sin pasar por el textarea.
    ta.value = '';
    ta.dispatchEvent(new Event('input'));
    toast('Enviando respuesta…');
    const j = await sendQuickReplyToChat(chatState.selectedPhone, qrId);
    if (j.ok) {
      // Refrescar mensajes inmediatamente
      try { await loadChatMessages(chatState.selectedPhone); renderChatMessages(); } catch (_) {}
      toast('✓ Enviado');
    } else {
      toast('Error al enviar');
    }
  } else {
    // Sin imagen → cargamos el body al textarea (el usuario puede editar antes de mandar).
    ta.value = body;
    ta.focus();
    ta.dispatchEvent(new Event('input'));
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
    <div class="label-picker-chips">
      ${visibleLabels().map(l => `<button type="button" class="label-toggle-chip${cLabels.includes(l.id) ? ' active' : ''}" data-lbl-id="${l.id}" style="--lc:${l.color}" aria-pressed="${cLabels.includes(l.id)}">${escapeHtml(l.name)}</button>`).join('')}
    </div>
    ${!visibleLabels().length ? '<div style="color:#8696a0;font-size:13px;padding:8px">No hay etiquetas.</div>' : ''}
  `;
  document.body.appendChild(popup);
  const btn = document.getElementById('btn-labels');
  if (btn) {
    const r = btn.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.top = (r.bottom + 6) + 'px';
    popup.style.right = (window.innerWidth - r.right) + 'px';
    popup.style.left = 'auto';
  }
  popup.querySelectorAll('.label-toggle-chip').forEach(chip => {
    chip.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (chip.dataset.busy === '1') return;
      chip.dataset.busy = '1';
      const labelId = parseInt(chip.dataset.lblId);
      await toggleContactLabel(phone, labelId);
      const nowOn = (chatState.contactLabels[phone] || []).includes(labelId);
      chip.classList.toggle('active', nowOn);
      chip.setAttribute('aria-pressed', nowOn ? 'true' : 'false');
      const chips = document.getElementById('chat-label-chips');
      if (chips) chips.innerHTML = renderContactLabelChips(phone);
      refreshContactList();
      chip.dataset.busy = '0';
    });
  });
  setTimeout(() => {
    document.addEventListener('click', function closer(e) {
      if (!popup.contains(e.target) && e.target.id !== 'btn-labels') {
        popup.remove(); document.removeEventListener('click', closer);
      }
    });
  }, 10);
}

// === Altura del chat vs teclado virtual (móvil) ===
// El teclado virtual NO achica 100vh → el input quedaría tapado detrás de él.
// VisualViewport sí refleja el área realmente visible: seteamos --vvh (que usa
// .app--chat en el CSS) al alto visible. Solo en chat + móvil; en desktop o sin
// soporte de VisualViewport el CSS cae al fallback 100vh (sin regresión).
let _vvBound = false;
function syncChatViewportHeight() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    if (STATE.view === 'chat' && window.matchMedia('(max-width: 768px)').matches) {
      document.documentElement.style.setProperty('--vvh', Math.round(vv.height) + 'px');
    } else {
      document.documentElement.style.removeProperty('--vvh');
    }
  };
  if (!_vvBound) {
    _vvBound = true;
    vv.addEventListener('resize', apply);
  }
  apply();
}

function bindChat() {
  syncChatViewportHeight();
  if (isAdmin()) {
    bindPrecotizControl();
    // Carga inicial del estado del piloto (una vez al entrar a la sección chat).
    if (!STATE._precotizInit) { STATE._precotizInit = true; fetchPrecotiz().then(() => { if (STATE.view === 'chat') render(); }); }
  }
  // Load data
  if (!chatState.contacts.length && !chatState.loading) {
    // Cargar nombres de WA primero (rápido, solo phone→name) y después contactos
    // para que el primer render ya los muestre bien.
    loadWaContactNames().finally(() => {
      Promise.all([loadChatContacts(), loadQuickReplies(), loadChatTemplates(), loadLabels(), loadAllNotes(), loadArchivedChats()]).then(() => {
        if (STATE.view === 'chat') render();
      });
    });
  } else {
    loadQuickReplies();
    loadLabels();
    loadAllNotes();
    loadArchivedChats();
    if (!chatState.waContactNamesLoaded) loadWaContactNames();
  }
  // Search — full-text en historial completo (no solo lastMsg)
  const searchInput = document.getElementById('chat-search');
  if (searchInput) {
    searchInput.oninput = () => {
      chatState.search = searchInput.value;
      chatState.contactRenderLimit = CHAT_CONTACT_PAGE; // mostrar resultados desde arriba
      // Si pegaron un teléfono, mostrar el botón "Chatear con +54…".
      updateNewChatSuggest(searchInput.value);
      // Refresh inmediato con filtrado local (rápido, lo viejo)
      refreshContactList();
      // Debounce: 300ms después llamar al backend para búsqueda en historial
      if (chatState._searchTimer) clearTimeout(chatState._searchTimer);
      const q = searchInput.value.trim();
      if (q.length < 2) {
        chatState.searchResults = { contacts: [], messages: [], q: '' };
        refreshContactList();
        return;
      }
      chatState._searchTimer = setTimeout(() => runBackendSearch(q), 300);
    };
  }
  // Repoblar la sugerencia de "Chatear con…" tras un re-render (si quedó un tel en la búsqueda).
  updateNewChatSuggest(chatState.search);
  bindChatContactClicks();
  bindContactListInfiniteScroll();
  // Refresh
  const refreshBtn = document.getElementById('chat-refresh');
  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      await loadChatContacts();
      if (STATE.view === 'chat') render();
    };
  }
  // Fullscreen toggle
  const fsBtn = document.getElementById('chat-fullscreen');
  if (fsBtn) {
    const appEl = document.querySelector('.app');
    const syncIcons = () => {
      const on = appEl.classList.contains('app--chat-full');
      fsBtn.querySelector('.ico-enter').style.display = on ? 'none' : '';
      fsBtn.querySelector('.ico-exit').style.display = on ? '' : 'none';
      fsBtn.title = on ? 'Mostrar barra lateral' : 'Ocultar barra lateral';
    };
    syncIcons();
    fsBtn.onclick = () => {
      appEl.classList.toggle('app--chat-full');
      syncIcons();
    };
  }
  // Pestañas de canal (WhatsApp / Instagram). Cambia la bandeja visible.
  document.querySelectorAll('[data-channel]').forEach(btn => {
    btn.onclick = () => {
      const ch = btn.dataset.channel;
      if (ch && ch !== chatState.channel) {
        chatState.channel = ch;
        chatState.contactRenderLimit = CHAT_CONTACT_PAGE; // reset del windowing
        render();
      }
    };
  });
  // Chips fijos (Todos, No leídos) — estilo WhatsApp Web.
  document.querySelectorAll('[data-filter-fixed]').forEach(btn => {
    btn.onclick = () => {
      const kind = btn.dataset.filterFixed;
      if (kind === 'all') {
        // Limpia TODO: unread + labels + cierra dropdown.
        chatState.filterUnreadOnly = false;
        chatState.filterLabels = [];
        chatState.labelDropdownOpen = false;
      } else if (kind === 'unread') {
        chatState.filterUnreadOnly = !chatState.filterUnreadOnly;
      } else if (kind === 'paracotizar') {
        // Toggle: filtra por la etiqueta "Para cotizar" (o la apaga si ya estaba sola).
        const l = paraCotizarLabel();
        if (l) {
          const on = chatState.filterLabels.length === 1 && chatState.filterLabels[0] === l.id;
          chatState.filterLabels = on ? [] : [l.id];
          chatState.filterUnreadOnly = false;
          chatState.labelDropdownOpen = false;
        }
      }
      render();
    };
  });
  // Dropdown "Etiquetas ▾".
  const ddBtn = document.getElementById('label-filter-dd-btn');
  if (ddBtn) {
    ddBtn.onclick = (e) => {
      e.stopPropagation();
      chatState.labelDropdownOpen = !chatState.labelDropdownOpen;
      render();
    };
  }
  // Posicionamiento del menu fijo (position:fixed escapa del overflow:hidden
  // del sidebar). Calculamos top/left desde el rect del botón.
  if (chatState.labelDropdownOpen) {
    const menu = document.getElementById('label-filter-dd-menu');
    if (menu && ddBtn) {
      const r = ddBtn.getBoundingClientRect();
      menu.style.top = (r.bottom + 6) + 'px';
      menu.style.left = r.left + 'px';
    }
  }
  // Items del dropdown (toggle de cada etiqueta) — quedan adentro del menu.
  document.querySelectorAll('#label-filter-dd-menu .label-filter-item').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation(); // no cerrar el dropdown al tildar
      const id = parseInt(btn.dataset.labelId);
      if (chatState.filterLabels.includes(id)) {
        chatState.filterLabels = chatState.filterLabels.filter(l => l !== id);
      } else {
        chatState.filterLabels.push(id);
      }
      render();
    };
  });
  // Eliminar etiqueta (× dentro de cada item). stopPropagation → no togglea el filtro.
  document.querySelectorAll('#label-filter-dd-menu .label-filter-item-del').forEach(x => {
    x.onclick = (e) => {
      e.stopPropagation(); e.preventDefault();
      const id = parseInt(x.dataset.delLabel);
      const lab = (chatState.labels || []).find(l => l.id === id);
      if (!confirm('¿Eliminar la etiqueta "' + (lab ? lab.name : '') + '"? Se saca de todos los chats.')) return;
      forgetCreatedLabel(id);
      chatState.filterLabels = chatState.filterLabels.filter(l => l !== id);
      deleteLabel(id).then(() => render()).catch(() => toast('✗ No se pudo eliminar la etiqueta'));
    };
  });
  // Click afuera del dropdown lo cierra.
  if (chatState.labelDropdownOpen && !chatState._ddOutsideBound) {
    chatState._ddOutsideBound = true;
    setTimeout(() => {
      const handler = (ev) => {
        if (!ev.target.closest('.label-filter-dd-wrap')) {
          chatState.labelDropdownOpen = false;
          chatState._ddOutsideBound = false;
          document.removeEventListener('click', handler);
          render();
        }
      };
      document.addEventListener('click', handler);
    }, 0);
  }
  const clearFilter = document.getElementById('clear-label-filter');
  if (clearFilter) clearFilter.onclick = (e) => {
    e.stopPropagation();
    chatState.filterLabels = [];
    render();
  };
  // Crear una etiqueta NUEVA desde el dropdown. Delegación en document (se instala
  // UNA sola vez) → inmune a re-renders y a cuándo aparece el input en el DOM.
  if (!chatState._newLabelDelegated) {
    chatState._newLabelDelegated = true;
    const createFromInput = async () => {
      const inp = document.getElementById('label-filter-new-input');
      const btn = document.getElementById('label-filter-new-btn');
      const name = (inp && inp.value || '').trim();
      if (!name) { if (inp) inp.focus(); return; }
      const palette = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6', '#eab308'];
      const color = palette[(chatState.labels?.length || 0) % palette.length];
      try {
        if (btn) btn.disabled = true;
        const newId = await saveLabel(name, color);
        rememberCreatedLabel(newId);
        toast('✓ Etiqueta "' + name + '" creada');
        render();
      } catch (err) {
        toast('✗ ' + ((err && err.message) || 'No se pudo crear la etiqueta'));
        if (btn) btn.disabled = false;
      }
    };
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('#label-filter-new-btn')) { e.stopPropagation(); e.preventDefault(); createFromInput(); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target && e.target.id === 'label-filter-new-input') { e.stopPropagation(); e.preventDefault(); createFromInput(); }
    });
  }
  // Nuevo chat a un número nuevo (botón "+")
  const newChatBtn = document.getElementById('btn-new-chat');
  if (newChatBtn) newChatBtn.onclick = () => showNewChatModal('');
  // Manage labels button
  const manageLabelsBtn = document.getElementById('btn-manage-labels');
  if (manageLabelsBtn) manageLabelsBtn.onclick = () => showManageLabelsModal();
  // Toggle ver archivados (botón del header desktop + fila mobile)
  const toggleArchived = () => { chatState.showArchived = !chatState.showArchived; render(); };
  const archivedBtn = document.getElementById('btn-toggle-archived');
  if (archivedBtn) archivedBtn.onclick = toggleArchived;
  const archivedRow = document.getElementById('chat-archived-row');
  if (archivedRow) archivedRow.onclick = toggleArchived;
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
  // Poll: refresca contactos + mensajes del chat abierto cada 4s. NO bloqueamos
  // cuando la pestaña está oculta — los browsers ya tirotean setInterval a ~60s
  // en background, y necesitamos que las notificaciones funcionen aunque Joaco
  // tenga la pestaña minimizada.
  clearInterval(chatState.pollTimer);
  const tickPoll = async () => {
    if (STATE.view !== 'chat') return;
    const phone = chatState.selectedPhone;
    const prevMsgCount = chatState.messages.length;
    const prevLastTs = chatState.messages.length ? chatState.messages[chatState.messages.length - 1].ts : '';
    const prevTotalUnread = chatState.totalUnread || 0;
    const prevContactsByPhone = new Map(chatState.contacts.map(c => [c.phone, c]));
    const _fetchT0 = performance.now();
    await Promise.all([
      loadChatContacts(),
      phone ? loadChatMessages(phone) : Promise.resolve()
    ]);
    // Trackear duración del fetch para el adaptive polling (si fue >3s,
    // el setInterval externo espacia el próximo tick a 8s).
    chatState._lastTickMs = performance.now() - _fetchT0;
    if (STATE.view !== 'chat' || chatState.selectedPhone !== phone) return;
    // Skip refresh del sidebar durante typing activo (últimos 1500ms). El
    // fetch ya trajo los datos al estado — el próximo poll cuando pare de
    // tipear va a renderearlos.
    const isTyping = chatState._lastTypeMs && (performance.now() - chatState._lastTypeMs < 1500);
    if (!isTyping) refreshContactList();
    const newLastTs = chatState.messages.length ? chatState.messages[chatState.messages.length - 1].ts : '';
    const changed = chatState.messages.length !== prevMsgCount || newLastTs !== prevLastTs;
    // renderChatMessages corre incluso durante typing — el render incremental
    // es liviano (<8ms) y el usuario quiere ver msgs entrantes del chat actual.
    if (phone && changed) {
      const msgEl = document.getElementById('chat-messages');
      const wasAtBottom = msgEl && (msgEl.scrollHeight - msgEl.scrollTop - msgEl.clientHeight < 80);
      renderChatMessages();
      if (wasAtBottom && msgEl) msgEl.scrollTop = msgEl.scrollHeight;
    }
    updateUnreadBadge();
    // Notificación: si total unread subió, llegó al menos un inbound nuevo.
    const newTotalUnread = chatState.totalUnread || 0;
    if (newTotalUnread > prevTotalUnread) {
      const trigger = chatState.contacts.find(c => {
        const prev = prevContactsByPhone.get(c.phone);
        return (c.unread || 0) > (prev?.unread || 0);
      });
      // El ts del último msg del contact actúa como id único para el dedupe
      // — evita que el WW notifique el mismo wamid cuando él lo poll después.
      notifyNewMessage(trigger, trigger?.lastInboundTs || trigger?.lastTs);
    }
    updateChatPageTitle();
  };
  // requestIdleCallback difiere el polling a cuando el main thread está libre
  // — si el usuario está tipeando rápido, el render del polling queda en cola
  // hasta el primer gap entre keystrokes. Con timeout de 2s nos aseguramos
  // que se ejecute en algún momento incluso bajo presión sostenida.
  // Fallback a tickPoll directo si el browser no soporta (Safari < 17).
  const scheduleTick = (typeof requestIdleCallback === 'function')
    ? () => requestIdleCallback(tickPoll, { timeout: 2000 })
    : () => tickPoll();
  // Adaptive polling: arrancamos en 4s. Si un tick tarda >3s (server lento),
  // subimos el interval a 8s para no acumular ticks ni saturar la red. Si vuelve
  // a ser rápido, bajamos a 4s. chatState._lastTickMs lo mide tickPoll.
  let _pollIntervalMs = 4000;
  const reschedulePolling = (newMs) => {
    if (newMs === _pollIntervalMs) return;
    _pollIntervalMs = newMs;
    clearInterval(chatState.pollTimer);
    chatState.pollTimer = setInterval(() => {
      if (STATE.view !== 'chat') { clearInterval(chatState.pollTimer); return; }
      if (pollBackoffActive()) return;  // D1 saturada: saltar el tick (el timer sigue)
      scheduleTick();
      const last = chatState._lastTickMs || 0;
      reschedulePolling(last > 3000 ? 8000 : 4000);
    }, _pollIntervalMs);
  };
  chatState.pollTimer = setInterval(() => {
    if (STATE.view !== 'chat') { clearInterval(chatState.pollTimer); return; }
    scheduleTick();
    const last = chatState._lastTickMs || 0;
    reschedulePolling(last > 3000 ? 8000 : 4000);
  }, _pollIntervalMs);
  // Refresh inmediato al volver a la pestaña
  if (!chatState._visibilityHook) {
    chatState._visibilityHook = () => {
      if (document.visibilityState === 'visible' && STATE.view === 'chat') tickPoll();
    };
    document.addEventListener('visibilitychange', chatState._visibilityHook);
  }
  // Pedir permiso de notificaciones del browser (idempotente).
  ensureNotificationPermission();
  // Web Worker para notificaciones cuando la pestaña está minimizada/hidden.
  // El main-thread setInterval sufre throttling a ~1/min en hidden tabs;
  // el Web Worker corre en su propio thread y mantiene su frecuencia.
  initPollWorker();
}

// ===== Web Worker para notificaciones en background =====
let _pollWorker = null;
let _pollWorkerToken = null; // token con el que arrancó el poll-worker (para detectar cambio de usuario)
function initPollWorker() {
  if (!STATE.token || !CONFIG.trackerUrl) return;
  if (typeof Worker === 'undefined') return;
  // Si ya está corriendo con ESTE token, no hacemos nada. Si el token cambió
  // (cambio de usuario sin recargar: Joaco → Abril, etc.), reiniciamos para que
  // el polling de notificaciones use el token/rol correcto (filtra por bandeja).
  if (_pollWorker && _pollWorkerToken === STATE.token) return;
  if (_pollWorker) { try { _pollWorker.postMessage({ type: 'stop' }); _pollWorker.terminate(); } catch (_) {} _pollWorker = null; }
  try {
    _pollWorker = new Worker('assets/poll-worker.js');
    _pollWorkerToken = STATE.token;
    _pollWorker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type !== 'new-message') return;
      // Si la pestaña está visible y este mensaje es del chat abierto, ya
      // lo va a manejar el polling principal. Solo notificamos si NO está
      // abierto este chat o si la pestaña está oculta.
      if (document.visibilityState === 'visible' && chatState.selectedPhone === m.phone) return;
      // Buscar el contacto si lo conocemos para usar su nombre/avatar
      const contact = chatState.contacts.find(c => c.phone === m.phone) || {
        phone: m.phone, name: m.name || '', lastMsg: m.body || ''
      };
      // m.ts (timestamp del msg detectado por el WW) es la clave de dedupe
      // que va a coincidir con la del main polling si ambos lo capturan.
      notifyNewMessage(contact, m.ts, m.body);
    };
    _pollWorker.postMessage({
      type: 'init',
      token: STATE.token,
      trackerUrl: CONFIG.trackerUrl
    });
  } catch (e) {
    console.warn('Poll worker no disponible:', e);
    _pollWorker = null;
    _pollWorkerToken = null;
  }
}
function teardownPollWorker() {
  if (!_pollWorker) return;
  try { _pollWorker.postMessage({ type: 'stop' }); _pollWorker.terminate(); } catch (_) {}
  _pollWorker = null;
  _pollWorkerToken = null;
}

// ===== Notificaciones del chat =====
function ensureNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch (_) {}
  }
}

let _audioCtx = null;
function playChatNotificationSound() {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    const ctx = _audioCtx;
    const t0 = ctx.currentTime;
    // Doble "ding" estilo WA: 880Hz → 1320Hz, decay exponencial corto.
    const tones = [
      { freq: 880,  start: 0,    dur: 0.10 },
      { freq: 1320, start: 0.12, dur: 0.20 }
    ];
    for (const t of tones) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = t.freq;
      g.gain.setValueAtTime(0, t0 + t.start);
      g.gain.linearRampToValueAtTime(0.16, t0 + t.start + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + t.start + t.dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(t0 + t.start);
      osc.stop(t0 + t.start + t.dur + 0.02);
    }
  } catch (_) {}
}

// Dedupe global: el web worker (poll-worker.js cada 5s) y el main-thread
// polling (cada 4-8s) pueden detectar el MISMO mensaje y disparar notifs
// duplicadas. Dedupe ESTRICTO por (phone, ts) — si ya notificamos ese
// mensaje exacto, nunca volvemos a notificarlo aunque pase tiempo.
const _notifiedKeys = new Set();
const _NOTIF_KEYS_CAP = 500; // LRU manual: cuando supera, dropeamos los más viejos

function notifyNewMessage(contact, ts, bodyOverride) {
  const phone = contact?.phone || '';
  // Si no nos pasaron ts, usamos el del contact (lastInboundTs / lastTs).
  const tsKey = ts || contact?.lastInboundTs || contact?.lastTs || '';
  const key = phone + '|' + tsKey;
  if (!phone || !tsKey) return; // sin key confiable, mejor no notificar (evita spam)
  if (_notifiedKeys.has(key)) return;
  _notifiedKeys.add(key);
  // Cap simple: si pasa el límite, vaciamos la mitad más vieja. Set en JS
  // mantiene orden de inserción, así que iteramos y borramos los primeros.
  if (_notifiedKeys.size > _NOTIF_KEYS_CAP) {
    const drop = Math.floor(_NOTIF_KEYS_CAP / 2);
    let i = 0;
    for (const k of _notifiedKeys) {
      if (i++ >= drop) break;
      _notifiedKeys.delete(k);
    }
  }
  playChatNotificationSound();
  // Browser notification solo si la pestaña no está visible (sino el sonido
  // y el badge en pantalla ya alcanzan).
  if (document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const name = contact?.name || formatPhoneDisplay(contact?.phone || '') || 'Nuevo mensaje';
      // bodyOverride = texto del mensaje ENTRANTE que disparó la notif (lo trae el
      // poll-worker). Sin esto usábamos contact.lastMsg, que suele ser TU último
      // saliente (el cliente responde → notif mostraba tu propio texto, no el suyo).
      const body = ((bodyOverride || contact?.lastMsg || '').slice(0, 120)) || 'Nuevo mensaje de WhatsApp';
      const n = new Notification(name, {
        body,
        icon: 'assets/logo.svg',
        tag: 'wa-' + (contact?.phone || 'new'),
        renotify: true,
        silent: true
      });
      n.onclick = () => {
        try { window.focus(); } catch (_) {}
        if (contact?.phone) selectChatContact(contact.phone);
        n.close();
      };
    } catch (_) {}
  }
}

function updateChatPageTitle() {
  const total = chatState.totalUnread || 0;
  const base = 'NEON · Ventas';
  document.title = total > 0 ? `(${total}) ${base}` : base;
}

// Llama al backend para buscar en TODO el historial de wa_messages
// (no solo lastMsg como hace el filtrado local).
async function runBackendSearch(q) {
  if (!CONFIG.trackerUrl || !STATE.token) return;
  chatState.searchLoading = true;
  refreshContactList();
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/search?q=' + encodeURIComponent(q), {
      headers: authHeaders()
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    chatState.searchResults = {
      contacts: j.contacts || [],
      messages: j.messages || [],
      q: j.q || q
    };
  } catch (e) {
    chatState.searchResults = { contacts: [], messages: [], q: '' };
  } finally {
    chatState.searchLoading = false;
    refreshContactList();
  }
}

// "Infinite scroll" del sidebar: cerca del fondo sube el límite de contactos
// renderizados y re-renderiza. Idempotente (guard _moreScrollBound por elemento).
function bindContactListInfiniteScroll() {
  const list = document.getElementById('chat-contact-list');
  if (!list || list._moreScrollBound) return;
  list._moreScrollBound = true;
  list.addEventListener('scroll', () => {
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 500
        && chatState.contactRenderLimit < (chatState._lastFilteredCount || 0)) {
      chatState.contactRenderLimit += CHAT_CONTACT_PAGE;
      refreshContactList();
    }
  });
}
function refreshContactList() {
  const list = document.getElementById('chat-contact-list');
  if (!list) return;
  const search = chatState.search.toLowerCase().trim();
  let filtered = chatState.contacts.filter(c => (c.channel || 'wa') === (chatState.channel || 'wa'));
  // Filtrar archivados (salvo que el filtro esté en "ver archivados")
  if (chatState.showArchived) {
    filtered = filtered.filter(c => isArchived(c.phone));
  } else {
    filtered = filtered.filter(c => !isArchived(c.phone));
  }
  // Filtrado local rápido
  if (search) filtered = filtered.filter(c => (c.name || '').toLowerCase().includes(search) || c.phone.includes(search) || (c.lastMsg || '').toLowerCase().includes(search));
  if (chatState.filterUnreadOnly) filtered = filtered.filter(c => (c.unread || 0) > 0);
  if (chatState.filterLabels.length) filtered = filtered.filter(c => { const cl = chatState.contactLabels[c.phone] || []; return chatState.filterLabels.every(lid => cl.includes(lid)); });

  // Si hay búsqueda activa, agregar contactos del backend que no están ya
  // en la lista (matchean por historial profundo).
  let extraHtml = '';
  if (search && chatState.searchResults.q && chatState.searchResults.q.toLowerCase() === search) {
    const localPhones = new Set(filtered.map(c => c.phone));
    const extraContacts = chatState.searchResults.contacts.filter(c => !localPhones.has(c.phone));
    if (extraContacts.length) {
      const items = extraContacts.map(c => {
        const contactObj = chatState.contacts.find(x => x.phone === c.phone) || {
          phone: c.phone, name: c.contact_name || '', lastMsg: '', lastTs: c.last_match_ts, unread: 0
        };
        return renderContactItem(contactObj);
      }).join('');
      extraHtml = `<div class="search-section-header">📜 En historial (${extraContacts.length})</div>` + items;
    }
    // Mensajes individuales que matchean
    if (chatState.searchResults.messages.length) {
      const msgItems = chatState.searchResults.messages.slice(0, 20).map(m => {
        const contact = chatState.contacts.find(c => c.phone === m.phone);
        const name = contact?.name || m.sender_name || formatPhoneDisplay(m.phone);
        const dirIcon = m.direction === 'outbound' ? '↗' : '↘';
        const dateStr = new Date(m.ts).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
        const preview = highlightMatch(m.body || '', search);
        return `<div class="search-msg-result" data-search-jump="${escapeHtml(m.phone)}|${escapeHtml(m.wamid || '')}">
          <div class="search-msg-head">
            <span class="search-msg-name">${escapeHtml(name)}</span>
            <span class="search-msg-date">${dateStr}</span>
          </div>
          <div class="search-msg-body"><span class="search-msg-dir">${dirIcon}</span> ${preview}</div>
        </div>`;
      }).join('');
      extraHtml += `<div class="search-section-header">💬 Mensajes (${chatState.searchResults.messages.length})</div>` + msgItems;
    }
  }

  // Indicador de loading
  const loadingHtml = chatState.searchLoading
    ? '<div class="search-loading">🔍 Buscando en historial...</div>'
    : '';

  // Dirty check: comparamos el HTML resultante contra el último seteado. Si es
  // idéntico, NO tocamos el DOM. Es el caso del polling cada 4s cuando no
  // hubo cambios reales: antes se reconstruía toda la lista igual y bloqueaba
  // el main thread mientras el usuario tipeaba.
  chatState._lastFilteredCount = filtered.length;
  const visibleContacts = filtered.slice(0, chatState.contactRenderLimit);
  const newHtml = visibleContacts.map(c => renderContactItem(c)).join('') + loadingHtml + extraHtml;
  if (newHtml !== list._lastHtml) {
    const st = list.scrollTop; // preservar scroll: evita el salto al re-render del poll y al sumar página
    list.innerHTML = newHtml;
    list._lastHtml = newHtml;
    list.scrollTop = st;
    bindChatContactClicks();
    bindSearchMessageJumps();
  }
  bindContactListInfiniteScroll();
}

// Escapa HTML y resalta el match dentro de un texto con <mark>
function highlightMatch(text, query) {
  if (!text || !query) return escapeHtml(text || '');
  const safe = escapeHtml(text);
  const safeQ = escapeHtml(query);
  // Case-insensitive replace preservando original
  const re = new RegExp('(' + safeQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
  // Truncar el snippet a ~120 chars alrededor del primer match
  const lower = safe.toLowerCase();
  const qLower = safeQ.toLowerCase();
  const idx = lower.indexOf(qLower);
  let snippet = safe;
  if (idx > 60 && safe.length > 140) {
    snippet = '…' + safe.slice(idx - 40, idx + 80) + (idx + 80 < safe.length ? '…' : '');
  } else if (safe.length > 140) {
    snippet = safe.slice(0, 140) + '…';
  }
  return snippet.replace(re, '<mark>$1</mark>');
}

// Click en un resultado de mensaje → abrir el chat y scroll al mensaje
function bindSearchMessageJumps() {
  document.querySelectorAll('[data-search-jump]').forEach(el => {
    el.style.cursor = 'pointer';
    el.onclick = () => {
      const [phone, wamid] = el.dataset.searchJump.split('|');
      chatState.highlightWamid = wamid;
      selectChatContact(phone);
    };
  });
}

function bindBulkSection() {
  const closeBtn = document.getElementById('bulk-close');
  if (closeBtn) closeBtn.onclick = () => { document.getElementById('bulk-section').style.display = 'none'; };
  const bulkSection = document.getElementById('bulk-section');
  const getSelectedIds = () => Array.from(bulkSection.querySelectorAll('.label-toggle-chip.active')).map(b => parseInt(b.dataset.lblId));
  const updateCount = () => {
    const ids = getSelectedIds();
    if (!ids.length) { document.getElementById('bulk-count').textContent = ''; return; }
    const phones = new Set();
    for (const ph of Object.keys(chatState.contactLabels)) {
      const cl = chatState.contactLabels[ph];
      if (ids.some(lid => cl.includes(lid))) phones.add(ph);
    }
    document.getElementById('bulk-count').textContent = `${phones.size} contacto(s) seleccionados`;
  };
  bulkSection.querySelectorAll('.label-toggle-chip').forEach(btn => {
    btn.onclick = () => {
      btn.classList.toggle('active');
      btn.setAttribute('aria-pressed', btn.classList.contains('active') ? 'true' : 'false');
      updateCount();
    };
  });
  const sendBtn = document.getElementById('bulk-send-btn');
  if (sendBtn) sendBtn.onclick = async () => {
    if (sendBtn.disabled) return;
    // Disable ANTES de leer/await — protege contra doble-click rápido.
    sendBtn.disabled = true;
    const prevText = sendBtn.textContent;
    const checked = getSelectedIds();
    const msg = document.getElementById('bulk-msg')?.value?.trim();
    if (!checked.length) { sendBtn.disabled = false; toast('Seleccioná al menos una etiqueta'); return; }
    if (!msg) { sendBtn.disabled = false; toast('Escribí un mensaje'); return; }
    sendBtn.textContent = 'Enviando...';
    try {
      const result = await sendBulkMessage(checked, msg);
      const resEl = document.getElementById('bulk-result');
      if (resEl && result) resEl.innerHTML = `<span style="color:#00a884">Enviados: ${result.sent}</span>${result.failed ? ` | <span style="color:#ef5350">Fallidos: ${result.failed}</span>` : ''}`;
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = prevText;
    }
  };
}

function showManageLabelsModal() {
  const LABEL_COLORS = ['#ef5350','#ff7043','#ffa726','#ffca28','#66bb6a','#26a69a','#42a5f5','#5c6bc0','#ab47bc','#ec407a','#8d6e63','#78909c'];
  const content = `
    <div class="manage-labels">
      <div class="manage-labels-section">
        <div class="manage-labels-section-h">${chatState.labels.length} etiqueta${chatState.labels.length === 1 ? '' : 's'}</div>
        ${chatState.labels.length ? `
          <div class="manage-labels-list">
            ${chatState.labels.map(l => `
              <div class="manage-label-row">
                <span class="label-chip" style="background:${l.color}">${escapeHtml(l.name)}</span>
                <button class="manage-label-del" data-del-label="${l.id}" title="Eliminar etiqueta">&times;</button>
              </div>
            `).join('')}
          </div>
        ` : '<p class="manage-labels-empty">No hay etiquetas todavía</p>'}
      </div>
      <div class="manage-labels-section">
        <div class="manage-labels-section-h">Nueva etiqueta</div>
        <div class="manage-labels-colors">
          ${LABEL_COLORS.map((c, i) => `<button class="label-color-pick${i === 0 ? ' active' : ''}" data-color="${c}" style="background:${c}" aria-label="Color ${c}"></button>`).join('')}
        </div>
        <div class="manage-labels-add">
          <input type="text" id="new-label-name" placeholder="Nombre de la etiqueta…" autocomplete="off">
          <button class="btn btn-cyan" id="add-label-btn">Crear</button>
        </div>
      </div>
      <div class="manage-labels-section">
        <div class="manage-labels-section-h">Auto-etiquetado</div>
        <p style="font-size:12px;color:var(--fg-subtle);line-height:1.5;margin:0">
          Los mensajes nuevos de clientes se etiquetan automáticamente según palabras clave:
          mensajes que contienen "curso", "comunidad", "alumno", etc. → <b style="color:var(--neon-cyan)">interesado curso</b>.
          Si contienen "cartel", "neón", "presupuesto", etc. → <b style="color:var(--neon-red-glow)">interesado cartel</b>.
        </p>
        <button class="btn btn-ghost" id="run-autolabel-backfill" style="margin-top:8px">⚡ Procesar últimos 90 días</button>
        <div id="autolabel-result" style="font-size:12px;color:var(--fg-subtle);margin-top:6px"></div>
      </div>
    </div>
  `;
  openDrawer('Gestionar etiquetas', content);
  let selectedColor = LABEL_COLORS[0];
  document.querySelectorAll('.label-color-pick').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.label-color-pick').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedColor = btn.dataset.color;
    };
  });
  document.querySelectorAll('[data-del-label]').forEach(btn => {
    btn.onclick = async () => {
      const lid = parseInt(btn.dataset.delLabel);
      const lbl = chatState.labels.find(l => l.id === lid);
      const ok = await showConfirm(
        `¿Eliminar la etiqueta "${lbl?.name || ''}"? Se va a quitar de todos los contactos que la tienen.`,
        { title: 'Eliminar etiqueta', variant: 'warn', confirmLabel: 'Eliminar' }
      );
      if (!ok) return;
      await deleteLabel(lid);
      showManageLabelsModal();
      render();
    };
  });
  const addBtn = document.getElementById('add-label-btn');
  const nameInput = document.getElementById('new-label-name');
  const submit = async () => {
    const name = nameInput?.value?.trim();
    if (!name) return;
    if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'Creando…'; }
    try {
      await saveLabel(name, selectedColor);
      toast('✓ Etiqueta creada');
      showManageLabelsModal();
      render();
    } catch (e) {
      if (addBtn) { addBtn.disabled = false; addBtn.textContent = 'Crear'; }
      toast('✗ ' + ((e && e.message) || 'No se pudo crear la etiqueta'));
    }
  };
  if (addBtn) addBtn.onclick = submit;
  if (nameInput) {
    nameInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
    setTimeout(() => nameInput.focus(), 50);
  }
  // Auto-label backfill
  const backfillBtn = document.getElementById('run-autolabel-backfill');
  const backfillResult = document.getElementById('autolabel-result');
  if (backfillBtn) backfillBtn.onclick = async () => {
    if (backfillBtn.disabled) return;
    backfillBtn.disabled = true;
    const prev = backfillBtn.textContent;
    backfillBtn.textContent = 'Procesando…';
    if (backfillResult) backfillResult.textContent = '';
    try {
      const r = await fetch(CONFIG.trackerUrl + '/admin/wa/auto-label-backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ days: 90 })
      });
      const j = await r.json();
      if (r.ok) {
        if (backfillResult) backfillResult.textContent = `✓ ${j.processed || 0} mensajes analizados`;
        // Recargar contact_labels para reflejar lo nuevo
        chatState.labelsLoaded = false;
        await loadLabels();
        toast('Backfill completado');
      } else {
        if (backfillResult) backfillResult.textContent = `✗ ${j.error || 'error'}`;
      }
    } catch (e) {
      if (backfillResult) backfillResult.textContent = '✗ Error de red';
    } finally {
      backfillBtn.disabled = false;
      backfillBtn.textContent = prev;
    }
  };
}

// Validación cliente (espejo del worker) para plantillas "al toque".
function validateAdhocTemplateClient(text) {
  const t = (text || '').trim();
  if (!t) return '';
  if (t.length < 10) return 'Muy corto (mínimo 10 caracteres).';
  if (t.length > 600) return 'Muy largo (máximo 600).';
  if (/https?:\/\/|www\.|wa\.me|t\.me|\b\S+\.(com|net|ar|org|io)\b/i.test(t)) return 'No se permiten links.';
  if (/[A-ZÁÉÍÓÚÑ]{5,}/.test(t)) return 'Evitá palabras en MAYÚSCULAS.';
  if (/\d{7,}/.test(t)) return 'No incluyas números largos (teléfonos).';
  return null;
}

// Cuadro para crear una plantilla a medida para el chat actual. Cuando Meta la
// aprueba, el cron la manda sola (el vendedor no espera en pantalla).
function showCreateTemplateModal() {
  if (!chatState.selectedPhone) { toast('Abrí un chat primero'); return; }
  const content = `
    <div class="manage-qr">
      <div style="display:flex;gap:6px;margin-bottom:10px">
        <button type="button" class="btn btn-cyan tpl-mode-btn" data-mode="once">Mandar una vez</button>
        <button type="button" class="btn btn-ghost tpl-mode-btn" data-mode="reuse">Guardar como atajo</button>
      </div>
      <p class="manage-qr-hint" id="tpl-hint">Creá una plantilla a medida para este cliente. Cuando Meta la apruebe (unos minutos), <b>se manda sola</b> a este chat — no tenés que esperar acá.</p>
      <div id="tpl-shortcut-wrap" style="display:none;margin-bottom:8px">
        <input id="new-tpl-shortcut" class="nc-input" placeholder="Atajo para el menú / (ej: revendedores)" autocomplete="off" style="width:100%">
      </div>
      <textarea id="new-tpl-body" class="nc-input" placeholder="Escribí el mensaje… ej: Hola! Quería saber si seguís interesado, cualquier cosa quedamos a disposición" rows="4" style="resize:vertical"></textarea>
      <div id="new-tpl-warn" style="color:#ff6b6b;font-size:12px;min-height:16px;margin:4px 0"></div>
      <label style="font-size:12px;color:var(--fg-subtle,#8696a0);display:flex;align-items:center;gap:6px;margin:4px 0;cursor:pointer"><input type="checkbox" id="new-tpl-btn-on"> Agregar un botón con link (ej. "Ver portal")</label>
      <div id="new-tpl-btn-wrap" style="display:none;gap:6px;margin:6px 0">
        <input id="new-tpl-btn-text" class="nc-input" placeholder="Texto del botón" maxlength="25" style="flex:1;min-width:0">
        <input id="new-tpl-btn-url" class="nc-input" placeholder="https://..." style="flex:2;min-width:0">
      </div>
      <div style="font-size:12px;color:var(--fg-subtle,#8696a0);line-height:1.7;margin:6px 0">
        <b>Para que Meta la apruebe:</b><br>
        ✅ Mensaje claro y amable (tipo "retomemos la charla").<br>
        🚫 Sin links en el texto (para un link usá el botón) · 🚫 Sin teléfonos · 🚫 Sin MAYÚSCULAS.
      </div>
      <button class="btn btn-cyan" id="create-tpl-btn" disabled>Crear y mandar al aprobarse</button>
    </div>
  `;
  openDrawer('Crear plantilla nueva', content);
  let mode = 'once';
  const ta = document.getElementById('new-tpl-body');
  const warn = document.getElementById('new-tpl-warn');
  const btn = document.getElementById('create-tpl-btn');
  const scWrap = document.getElementById('tpl-shortcut-wrap');
  const scIn = document.getElementById('new-tpl-shortcut');
  const hint = document.getElementById('tpl-hint');
  const btnOn = document.getElementById('new-tpl-btn-on');
  const btnWrap = document.getElementById('new-tpl-btn-wrap');
  const btnText = document.getElementById('new-tpl-btn-text');
  const btnUrl = document.getElementById('new-tpl-btn-url');
  const modeBtns = Array.from(document.querySelectorAll('.tpl-mode-btn'));
  const paint = () => {
    modeBtns.forEach(b => { b.className = 'btn tpl-mode-btn ' + (b.dataset.mode === mode ? 'btn-cyan' : 'btn-ghost'); });
    if (scWrap) scWrap.style.display = mode === 'reuse' ? '' : 'none';
    if (hint) hint.innerHTML = mode === 'reuse'
      ? 'Creá una plantilla <b>reutilizable</b> con un atajo. Cuando Meta la apruebe (unos min), la encontrás en el menú <b>/</b> por su atajo y la mandás a quien quieras, las veces que quieras.'
      : 'Creá una plantilla a medida para este cliente. Cuando Meta la apruebe (unos minutos), <b>se manda sola</b> a este chat — no tenés que esperar acá.';
    if (btn) btn.textContent = mode === 'reuse' ? 'Crear atajo reutilizable' : 'Crear y mandar al aprobarse';
  };
  const check = () => {
    const t = (ta.value || '').trim();
    if (!t) { warn.textContent = ''; btn.disabled = true; return; }
    let err = validateAdhocTemplateClient(t);
    if (!err && mode === 'reuse' && !(scIn.value || '').trim()) err = 'Poné un atajo para guardarla.';
    if (!err && btnOn.checked) {
      if (!(btnText.value || '').trim()) err = 'Poné el texto del botón.';
      else if (!/^https?:\/\/\S+/i.test((btnUrl.value || '').trim())) err = 'El botón necesita un link válido (https://...).';
    }
    warn.textContent = err || '';
    btn.disabled = !!err;
  };
  modeBtns.forEach(b => { b.onclick = () => { mode = b.dataset.mode; paint(); check(); }; });
  if (btnOn) btnOn.onchange = () => { btnWrap.style.display = btnOn.checked ? 'flex' : 'none'; check(); };
  [ta, scIn, btnText, btnUrl].forEach(el => { if (el) el.oninput = check; });
  paint();
  setTimeout(() => ta && ta.focus(), 50);
  if (btn) btn.onclick = async () => {
    const text = (ta.value || '').trim();
    const err = validateAdhocTemplateClient(text);
    if (err) { warn.textContent = err; return; }
    const useBtn = btnOn.checked;
    const bTxt = (btnText.value || '').trim();
    const bUrl = (btnUrl.value || '').trim();
    if (useBtn && (!bTxt || !/^https?:\/\/\S+/i.test(bUrl))) { warn.textContent = 'Completá el texto y el link del botón.'; return; }
    btn.disabled = true; btn.textContent = 'Creando…';
    try {
      let r, j;
      if (mode === 'reuse') {
        const sc = (scIn.value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        if (!sc) { warn.textContent = 'Atajo inválido (usá letras o números).'; btn.disabled = false; paint(); return; }
        r = await fetch(CONFIG.trackerUrl + '/admin/wa/template-create', {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ name: sc, category: 'UTILITY', allow_category_change: true, language: 'es_AR', body_text: text, button_url: useBtn ? bUrl : undefined, button_text: useBtn ? bTxt : undefined })
        });
        j = await r.json().catch(() => ({}));
        if (r.ok && j.ok) {
          closeDrawer(); loadChatTemplates();
          toast('✓ Atajo creado. Cuando Meta lo apruebe (unos min) aparece en el menú / como /' + sc);
        } else { warn.textContent = j.error || 'No se pudo crear'; btn.disabled = false; paint(); }
      } else {
        r = await fetch(CONFIG.trackerUrl + '/admin/wa/template-create-send', {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ to: chatState.selectedPhone, body_text: text, button_url: useBtn ? bUrl : undefined, button_text: useBtn ? bTxt : undefined })
        });
        j = await r.json().catch(() => ({}));
        if (r.ok && j.ok) {
          closeDrawer();
          toast(j.reused ? '✓ Mensaje enviado (se reusó una plantilla ya aprobada).' : '✓ Plantilla creada. Se manda sola cuando Meta la apruebe (unos min).');
        } else { warn.textContent = j.error || 'No se pudo crear'; btn.disabled = false; paint(); }
      }
    } catch (e) {
      warn.textContent = 'Error: ' + (e.message || e);
      btn.disabled = false; paint();
    }
  };
}

function showManageQRModal() {
  const verts = qrVerticalsForUser();
  const visQR = (chatState.quickReplies || []).filter(q => !verts || verts.includes(q.vertical || 'carteles'));
  const defVert = (verts && verts[0]) || 'carteles';
  const vertOptions = (verts === null)
    ? `<option value="carteles">Carteles</option><option value="cursos">Cursos</option>`
    : `<option value="${defVert}">${defVert === 'cursos' ? 'Cursos' : 'Carteles'}</option>`;
  const content = `
    <div class="manage-qr">
      <p class="manage-qr-hint">Escribí <b>/</b> en el chat para ver tus respuestas guardadas y plantillas. Las que tienen foto la mandan junto con el texto como caption.</p>
      <div class="manage-qr-section">
        <div class="manage-qr-section-h">${visQR.length} respuesta${visQR.length === 1 ? '' : 's'}</div>
        ${visQR.length ? `
          <div class="manage-qr-list">
            ${visQR.map(q => `
              <div class="manage-qr-row">
                ${q.media_r2_key ? `<img class="manage-qr-thumb" src="${mediaUrl(q.media_r2_key)}" alt="">` : '<div class="manage-qr-thumb-empty">📝</div>'}
                <div class="manage-qr-text">
                  <div class="manage-qr-shortcut">/${escapeHtml(q.shortcut)}</div>
                  <div class="manage-qr-body">${escapeHtml(q.body || '(sin texto)')}</div>
                </div>
                <button class="manage-label-del" data-del-qr="${q.id}" title="Eliminar">&times;</button>
              </div>
            `).join('')}
          </div>
        ` : '<p class="manage-labels-empty">No hay respuestas guardadas</p>'}
      </div>
      <div class="manage-qr-section">
        <div class="manage-qr-section-h">Nueva respuesta</div>
        <input type="text" id="new-qr-shortcut" placeholder="Atajo (ej: saludo)" autocomplete="off">
        <textarea id="new-qr-body" placeholder="Texto del mensaje (o caption si adjuntás foto)…" rows="3"></textarea>
        <div class="manage-qr-image">
          <input type="file" id="new-qr-image" accept="image/*" style="display:none">
          <button class="btn btn-ghost" id="new-qr-image-btn" type="button">🖼 Adjuntar foto</button>
          <span id="new-qr-image-name" class="manage-qr-image-name"></span>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--fg-subtle,#8696a0);margin:4px 0 8px">Sección:
          <select id="new-qr-vertical" style="flex:1;padding:6px;border-radius:6px;background:rgba(255,255,255,.05);color:inherit;border:1px solid var(--border,#334155)">${vertOptions}</select>
        </label>
        <button class="btn btn-cyan" id="add-qr-btn">Guardar respuesta</button>
      </div>
    </div>
  `;
  openDrawer('Respuestas rápidas', content);
  document.querySelectorAll('[data-del-qr]').forEach(btn => {
    btn.onclick = async () => {
      const ok = await showConfirm('¿Eliminar esta respuesta rápida?', { title: 'Eliminar', variant: 'warn', confirmLabel: 'Eliminar' });
      if (!ok) return;
      await deleteQuickReply(parseInt(btn.dataset.delQr));
      chatState.qrLoaded = false;
      await loadQuickReplies();
      showManageQRModal();
    };
  });
  const imgInput = document.getElementById('new-qr-image');
  const imgBtn = document.getElementById('new-qr-image-btn');
  const imgName = document.getElementById('new-qr-image-name');
  let pendingFile = null;
  if (imgBtn) imgBtn.onclick = () => imgInput.click();
  if (imgInput) imgInput.onchange = () => {
    pendingFile = imgInput.files[0] || null;
    if (imgName) imgName.textContent = pendingFile ? '✓ ' + pendingFile.name : '';
  };
  const addBtn = document.getElementById('add-qr-btn');
  const shortcutInput = document.getElementById('new-qr-shortcut');
  const bodyInput = document.getElementById('new-qr-body');
  if (addBtn) addBtn.onclick = async () => {
    const shortcut = shortcutInput?.value?.trim();
    const body = bodyInput?.value?.trim();
    if (!shortcut) { toast('Falta el atajo'); return; }
    if (!body && !pendingFile) { toast('Agregá texto o imagen'); return; }
    addBtn.disabled = true;
    addBtn.textContent = 'Guardando…';
    try {
      let r2Key = null;
      if (pendingFile) {
        addBtn.textContent = 'Subiendo imagen…';
        r2Key = await uploadQuickReplyImage(pendingFile);
      }
      addBtn.textContent = 'Guardando…';
      const vertical = document.getElementById('new-qr-vertical')?.value || defVert;
      await saveQuickReply(shortcut, body, r2Key, vertical);
      showManageQRModal();
    } catch (e) {
      toast('Error: ' + e.message);
      addBtn.disabled = false;
      addBtn.textContent = 'Guardar respuesta';
    }
  };
  if (shortcutInput) setTimeout(() => shortcutInput.focus(), 50);
}

function bindChatContactClicks() {
  document.querySelectorAll('.chat-contact').forEach(el => {
    el.onclick = () => selectChatContact(el.dataset.chatPhone);
    el.oncontextmenu = (e) => {
      e.preventDefault();
      const phone = el.dataset.chatPhone;
      const contact = chatState.contacts.find(c => c.phone === phone);
      showChatContactContextMenu(e.clientX, e.clientY, phone, contact?.name || '');
    };
  });
}

function showChatContactContextMenu(x, y, phone, name) {
  // Cerrar otro abierto
  document.getElementById('chat-context-menu')?.remove();
  const hasNote = !!getContactNote(phone);
  const cLabels = chatState.contactLabels[phone] || [];
  const labelItems = chatState.labels.map(l => {
    const on = cLabels.includes(l.id);
    return `
      <div class="ccm-sub-item${on ? ' active' : ''}" data-lbl-id="${l.id}" role="button">
        <span class="ccm-sub-chip" style="background:${l.color}">${escapeHtml(l.name)}</span>
        <span class="ccm-sub-tick">${on ? '✓' : ''}</span>
      </div>
    `;
  }).join('') || '<div class="ccm-sub-empty">No hay etiquetas creadas todavía</div>';

  const menu = document.createElement('div');
  menu.id = 'chat-context-menu';
  menu.className = 'chat-context-menu';
  menu.innerHTML = `
    <div class="ccm-h">${escapeHtml(name || formatPhoneDisplay(phone))}</div>
    <div class="ccm-item ccm-item--has-sub" data-action="label" tabindex="0">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16z"/></svg>
      <span style="flex:1">Etiquetar</span>
      <span class="ccm-chevron">▸</span>
      <div class="ccm-submenu" data-submenu="label">
        <div class="ccm-sub-h">Etiquetas</div>
        ${labelItems}
      </div>
    </div>
    <button class="ccm-item" data-action="note">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
      ${hasNote ? 'Editar nota' : 'Agregar nota'}
    </button>
    <button class="ccm-item" data-action="unread">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>
      Marcar como no leído
    </button>
    <button class="ccm-item" data-action="archive">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/></svg>
      ${isArchived(phone) ? 'Desarchivar chat' : 'Archivar chat'}
    </button>
  `;
  document.body.appendChild(menu);
  // Posicionar (manteniéndolo dentro del viewport)
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 8;
  const maxY = window.innerHeight - rect.height - 8;
  menu.style.left = Math.min(x, maxX) + 'px';
  menu.style.top = Math.min(y, maxY) + 'px';
  void menu.offsetWidth; menu.classList.add('open'); requestAnimationFrame(() => menu.classList.add('open'));

  const close = () => { menu.remove(); document.removeEventListener('click', closer, true); document.removeEventListener('keydown', escer); };
  function closer(e) { if (!menu.contains(e.target)) close(); }
  function escer(e) { if (e.key === 'Escape') close(); }
  setTimeout(() => {
    document.addEventListener('click', closer, true);
    document.addEventListener('keydown', escer);
  }, 0);

  // Decidir si el submenú se abre a la derecha o a la izquierda del menú principal
  const subEl = menu.querySelector('.ccm-submenu');
  if (subEl) {
    const space = window.innerWidth - (parseFloat(menu.style.left) + rect.width);
    if (space < 240) subEl.classList.add('ccm-submenu--left');
  }

  // Click en row → toggle (no cierra el menú). El estado se refleja con la
  // clase .active y el tick (sin checkbox redundante).
  menu.querySelectorAll('[data-lbl-id]').forEach(row => {
    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (row.dataset.busy === '1') return;
      row.dataset.busy = '1';
      const labelId = parseInt(row.dataset.lblId);
      await toggleContactLabel(phone, labelId);
      // Refrescar visual del row según nuevo estado
      const nowOn = (chatState.contactLabels[phone] || []).includes(labelId);
      row.classList.toggle('active', nowOn);
      const tick = row.querySelector('.ccm-sub-tick');
      if (tick) tick.textContent = nowOn ? '✓' : '';
      if (chatState.selectedPhone === phone) {
        const chips = document.getElementById('chat-label-chips');
        if (chips) chips.innerHTML = renderContactLabelChips(phone);
      }
      refreshContactList();
      row.dataset.busy = '0';
    });
  });

  // Click en items de acción
  menu.querySelectorAll('button[data-action]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      close();
      if (action === 'note') {
        chatState.editingNoteFor = phone;
        await selectChatContact(phone);
      } else if (action === 'unread') {
        const ok = await markChatUnread(phone);
        if (ok) {
          const c = chatState.contacts.find(c => c.phone === phone);
          if (c) c.unread = (c.unread || 0) + 1;
          refreshContactList();
          toast('Marcado como no leído');
        } else {
          toast('Error al marcar como no leído');
        }
      } else if (action === 'archive') {
        const wasArchived = isArchived(phone);
        const ok = wasArchived ? await unarchiveChat(phone) : await archiveChat(phone);
        if (ok) {
          refreshContactList();
          toast(wasArchived ? 'Chat desarchivado' : 'Chat archivado');
        } else {
          toast('Error');
        }
      }
    };
  });
}

window.loadAll = loadAll;
window.closeDrawer = closeDrawer;

// ---------- INIT ----------
loadUser();
// Cargar done marks: localStorage inmediato + sync async desde Worker
STATE.done = loadDoneLocal();
loadCotizadorParams();
// Al abrir la PWA instalada (standalone) sin hash explícito, arrancamos en el
// Chat WA (lo más usado en el celu) para usuarios con acceso al chat. En el
// navegador (tab) se mantiene el dashboard por defecto.
const _isStandalone = !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
const initView = location.hash.replace('#','') || ((_isStandalone && canAccessChat()) ? 'chat' : 'dashboard');
STATE.view = initView;
loadAll();
// Sync done marks desde Worker (en background, re-render cuando llegue)
loadDone().then(() => { if (STATE.loaded) render(); });
// Pre-load chat unread counts for sidebar badge + arrancar el web worker de
// notificaciones aunque el usuario no entre a la vista del Chat.
if (canAccessChat()) {
  loadChatContacts().then(() => updateUnreadBadge());
  ensureNotificationPermission();
  initPollWorker();
}

// ===== Diseñador IA: medición CV del boceto en el navegador (modo comparación Emma vs IA) =====
// ===== Medición CV del boceto IA en el navegador =====
// Mide neón (m), alto (cm) y tramos desde el line-art, replicando el método Python
// validado (~8-10% vs Emma). El browser decodifica el JPEG con canvas (gratis).
// neon = area_linea / ancho_linea × (ancho_cm / bbox_ancho_px) / 100
//   ancho_linea = 2 × mediana(distanceTransform en los máximos locales de la cresta)
// tramos = componentes conexos ; alto = ancho_cm × bbox_alto/bbox_ancho
function _loadImg(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('no se pudo cargar la imagen'));
    im.src = url;
  });
}

// Distance transform euclídeo exacto (Felzenszwalb-Huttenlocher, 1D lower envelope
// por columnas y luego por filas). Entra máscara 0/1, sale distancia al borde (px).
function _edt(mask, W, H) {
  const INF = 1e20;
  const g = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = mask[i] ? INF : 0; // distancia al pixel de fondo más cercano
  const f = new Float64Array(Math.max(W, H));
  const d = new Float64Array(Math.max(W, H));
  const v = new Int32Array(Math.max(W, H));
  const z = new Float64Array(Math.max(W, H) + 1);
  const dt1d = (n, get, set) => {
    for (let i = 0; i < n; i++) f[i] = get(i);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const dx = q - v[k];
      set(q, dx * dx + f[v[k]]);
    }
  };
  // columnas
  for (let x = 0; x < W; x++) dt1d(H, (y) => g[y * W + x], (y, val) => { g[y * W + x] = val; });
  // filas
  for (let y = 0; y < H; y++) dt1d(W, (x) => g[y * W + x], (x, val) => { g[y * W + x] = val; });
  const out = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = Math.sqrt(g[i]);
  return out;
}

async function medirBocetoIA(url, anchoCm) {
  const img = await _loadImg(url);
  const scale = img.width > 600 ? 600 / img.width : 1;
  const W = Math.max(1, Math.round(img.width * scale)), H = Math.max(1, Math.round(img.height * scale));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;
  return _measureFromPixels(px, W, H, anchoCm);
}

function _measureFromPixels(px, W, H, anchoCm) {
  const N = W * H;
  const Varr = new Uint8Array(N), Sarr = new Uint8Array(N), hist = new Uint32Array(256);
  for (let i = 0; i < N; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    Varr[i] = mx; Sarr[i] = mx === 0 ? 0 : Math.round((mx - mn) / mx * 255); hist[mx]++;
  }
  let bg = 0, best = 0;
  for (let v = 0; v < 256; v++) if (hist[v] > best) { best = hist[v]; bg = v; }
  let mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) { const v = Varr[i]; if (Sarr[i] > 55 || (v - bg) > 55 || (bg - v) > 75) mask[i] = 1; }
  // CLOSE 3x3 (dilate -> erode) para conectar la línea sin fragmentarla
  const morph = (src, dilate) => {
    const out = new Uint8Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let hit = dilate ? 0 : 1;
      for (let dy = -1; dy <= 1 && (dilate ? !hit : hit); dy++) for (let dx = -1; dx <= 1; dx++) {
        const ny = y + dy, nx = x + dx;
        const val = (ny < 0 || ny >= H || nx < 0 || nx >= W) ? 0 : src[ny * W + nx];
        if (dilate) { if (val) { hit = 1; break; } } else { if (!val) { hit = 0; break; } }
      }
      out[y * W + x] = hit;
    }
    return out;
  };
  mask = morph(morph(mask, true), false);
  // Componentes conexos (BFS 8-conn): remover chicos + contar
  const labels = new Int32Array(N).fill(0);
  const minpx = Math.max(6, Math.round(N * 0.0002));
  const stack = new Int32Array(N); let ncomp = 0;
  for (let i = 0; i < N; i++) {
    if (!mask[i] || labels[i]) continue;
    let sp = 0, cnt = 0; stack[sp++] = i; labels[i] = -1; const px2 = [];
    while (sp > 0) {
      const p = stack[--sp]; px2.push(p); cnt++;
      const y = (p / W) | 0, x = p - y * W;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue; const ny = y + dy, nx = x + dx;
        if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
        const q = ny * W + nx; if (mask[q] && !labels[q]) { labels[q] = -1; stack[sp++] = q; }
      }
    }
    if (cnt >= minpx) { ncomp++; for (const p of px2) labels[p] = ncomp; }
    else for (const p of px2) mask[p] = 0;
  }
  let area = 0, minx = W, maxx = 0, miny = H, maxy = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) {
    area++; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  if (area < 40) return null;
  const bw = maxx - minx + 1, bh = maxy - miny + 1;
  const dt = _edt(mask, W, H);
  // máximos locales del DT (cresta) → mediana → ancho de línea
  const ridge = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x; if (!mask[p] || dt[p] <= 0.7) continue;
    let isMax = true;
    for (let dy = -1; dy <= 1 && isMax; dy++) for (let dx = -1; dx <= 1; dx++) {
      const ny = y + dy, nx = x + dx; if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
      if (dt[ny * W + nx] > dt[p]) { isMax = false; break; }
    }
    if (isMax) ridge.push(dt[p]);
  }
  if (ridge.length < 3) return null;
  ridge.sort((a, b) => a - b);
  const med = ridge[ridge.length >> 1];
  const width = Math.max(2 * med, 1);
  const cmPerPx = anchoCm / bw;
  const neon = Math.round((area / width) * cmPerPx / 100 * 10) / 10;
  const alto = Math.round(anchoCm * bh / bw);
  return { neon, alto, tramos: ncomp };
}


// ============ COTIZACIÓN — panel conversacional ============
// Kanban de briefs. Cada brief es la unidad de trabajo entre comercial
// (Joaco) y diseñador (Emma): nace de una conversación de WhatsApp,
// pasa por estados (nuevo → en_diseno → listo → enviado), y al final
// se materializa como fila del Sheet "Cotizador Joaco" usando el
// cotizador existente de la vista Presupuestos.
//
// Backend: tabla `briefs` en D1 + endpoints /admin/briefs/* en worker.js.
// El hilo interno (fase 3) reusa `brief_messages`, todavía no implementado.

const BRIEF_ESTADOS = ['nuevo', 'listo', 'enviado'];
// Columna "colgados" es VIRTUAL: filtra briefs estado=nuevo|listo con +24h sin movimiento.
// El estado real en DB sigue siendo 'nuevo' o 'listo'; cuando se mueva (edit/upload),
// updated_at se actualiza y deja de estar colgado solo.
const BRIEF_STALE_MS = 24 * 60 * 60 * 1000;
const BRIEF_COLUMNAS = [
  { id: 'nuevo',   label: '📥 A cotizar', color: 'var(--accent-cyan)' },
  { id: 'listo',   label: '🎨 Listos',    color: 'var(--green, #25D366)' },
  { id: 'enviado', label: '📤 Enviados',  color: 'var(--fg-subtle)' },
  { id: 'colgado', label: '🟡 Colgados',  color: 'var(--amber, #FFA726)', virtual: true },
];

function isBriefColgado(b) {
  if (b.estado !== 'nuevo' && b.estado !== 'listo') return false;
  return (Date.now() - Date.parse(b.updated_at)) >= BRIEF_STALE_MS;
}
// Motivo del cuelgue para mostrar en el card.
function getColgadoMotivo(b) {
  if (b.estado === 'nuevo')  return 'Falta cotizar (Emma no diseñó)';
  if (b.estado === 'listo')  return 'Falta enviar (Joaco no mandó al cliente)';
  return '';
}
// Para filtrar columnas reales (vs virtuales):
// - "nuevo"/"listo" en col real: NO colgado
// - "colgado" virtual: cualquiera de los anteriores que SÍ colgó
function briefBelongsToColumn(b, colId) {
  if (colId === 'colgado') return isBriefColgado(b);
  if (colId === 'enviado') return b.estado === 'enviado';
  // 'nuevo' o 'listo'
  return b.estado === colId && !isBriefColgado(b);
}

// Rol del usuario logueado. Mapea el display name (STATE.user) a un rol funcional.
// Joaco/Joaquín = comercial; Emma/Emmanuel = diseñador; Gaspar = admin (puede todo).
function getUserRole() {
  const u = (STATE.user || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (u === 'gaspar')                                   return 'admin';
  if (u === 'emma' || u === 'emmanuel' || u === 'disenador') return 'disenador';
  return 'comercial'; // joaco, joaquin, default
}
function canCreateBriefs() { if (isCursosUser(STATE.user)) return false; const r = getUserRole(); return r === 'comercial' || r === 'admin'; }
function canCotizar()      { const r = getUserRole(); return r === 'comercial' || r === 'admin'; }
function canMarkListo()    { const r = getUserRole(); return r === 'disenador' || r === 'admin'; }

if (typeof STATE.briefs === 'undefined')          STATE.briefs = [];
if (typeof STATE.briefsLoading === 'undefined')   STATE.briefsLoading = false;
if (typeof STATE.briefsLoaded === 'undefined')    STATE.briefsLoaded = false;
if (typeof STATE.briefsError === 'undefined')     STATE.briefsError = null;
if (typeof STATE.briefSelected === 'undefined')   STATE.briefSelected = null;
if (typeof STATE.briefDraft === 'undefined')      STATE.briefDraft = null;
if (typeof STATE.briefDraftImages === 'undefined') STATE.briefDraftImages = []; // blobs pre-creación
if (typeof STATE.briefDetailImages === 'undefined') STATE.briefDetailImages = []; // imágenes ya en R2 del brief abierto
if (typeof STATE.briefDetailLoading === 'undefined') STATE.briefDetailLoading = false;
if (typeof STATE.briefCotPopupOpen === 'undefined') STATE.briefCotPopupOpen = false;
if (typeof STATE.imgLightboxUrl === 'undefined')    STATE.imgLightboxUrl = null;
if (typeof STATE.quickModalOpen === 'undefined')    STATE.quickModalOpen = false;
if (typeof STATE.quickModalImages === 'undefined')  STATE.quickModalImages = []; // [{dataUrl, blob, contentType}]
if (typeof STATE.quickModalSaving === 'undefined')  STATE.quickModalSaving = false;
// Mapa { briefId: true } de briefs cuya generación de render IA está corriendo
// EN SEGUNDO PLANO. Emma puede cerrar el drawer y abrir otro brief mientras la
// IA termina; cuando termina, refrescamos la card y opcionalmente notificamos.
if (typeof STATE.briefsGenerando === 'undefined') STATE.briefsGenerando = {};
// Brief en proceso de envío del presupuesto vía WhatsApp API. Mientras el flag
// está en true, el botón "Enviar por WhatsApp" muestra "⏳ Enviando…" y queda
// deshabilitado, evitando que un doble-click mande dos mensajes al cliente.
if (typeof STATE.briefsEnviando === 'undefined') STATE.briefsEnviando = {};
// True mientras corre la verificación masiva de "enviados" (botón del kanban).
if (typeof STATE.verificandoEnviados === 'undefined') STATE.verificandoEnviados = false;
if (typeof STATE.briefLastAiParams === 'undefined') STATE.briefLastAiParams = null; // último resultado de estimación IA (banner)
if (typeof STATE.briefDetailMessages === 'undefined') STATE.briefDetailMessages = []; // (legacy, sin uso)
if (typeof STATE.teamChatOpen === 'undefined')    STATE.teamChatOpen = false;
if (typeof STATE.teamChatMessages === 'undefined') STATE.teamChatMessages = [];
if (typeof STATE.teamChatLoaded === 'undefined')  STATE.teamChatLoaded = false;
if (typeof STATE.teamChatLastSeen === 'undefined') STATE.teamChatLastSeen = (() => { try { return localStorage.getItem('niventas.teamChatLastSeen') || ''; } catch(e) { return ''; } })();
let _teamChatPollTimer = null;
let _teamChatLastMsgTs = '';
// Zona de imágenes "activa" (bajo el mouse) para dirigir el paste al tipo correcto:
// 'chat' | 'boceto' | 'render'. Se setea con mouseenter sobre cada zona, pero
// además trackeamos las coords del mouse para usar elementFromPoint en el paste —
// mouseenter no dispara si el drawer se abre con el cursor ya sobre la zona.
let _briefPasteZone = null;
let _briefMouseX = 0, _briefMouseY = 0;
if (typeof document !== 'undefined' && !document._briefMouseTracked) {
  document.addEventListener('mousemove', (ev) => {
    _briefMouseX = ev.clientX;
    _briefMouseY = ev.clientY;
  }, { passive: true });
  document._briefMouseTracked = true;
}
// Resuelve la zona destino de un paste mirando qué hay debajo del cursor en
// ese instante. Más confiable que el state _briefPasteZone (que depende de
// que el mouse haya pasado por encima del fieldset).
function resolvePasteZoneAtCursor() {
  const el = document.elementFromPoint(_briefMouseX, _briefMouseY);
  if (!el || !el.closest) return null;
  if (el.closest('#brief-images-grid-render') || el.closest('#brief-dropzone-render')) return 'render';
  if (el.closest('#brief-zone-disenador')) return 'boceto';
  if (el.closest('#brief-zone-chat')) return 'chat';
  return null;
}

async function fetchBriefs() {
  if (!CONFIG.trackerUrl || !STATE.token) return;
  STATE.briefsLoading = true;
  try {
    const r = await fetch(`${CONFIG.trackerUrl}/admin/briefs?limit=500`, {
      headers: { Authorization: `Bearer ${STATE.token}` }
    });
    if (r.status === 401) throw new Error('SESION_VENCIDA');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    STATE.briefs = data.briefs || [];
    STATE.briefsError = null;
    STATE.briefsLoaded = true;
  } catch (e) {
    STATE.briefsError = e.message || 'error';
  } finally {
    STATE.briefsLoading = false;
  }
}

async function fetchBriefDetail(id) {
  if (!CONFIG.trackerUrl || !STATE.token) return null;
  STATE.briefDetailLoading = true;
  try {
    const r = await fetch(`${CONFIG.trackerUrl}/admin/briefs/${id}`, {
      headers: { Authorization: `Bearer ${STATE.token}` }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    STATE.briefDetailImages = data.imagenes || [];
    STATE.briefDetailMessages = data.messages || [];
    // Sync el brief en la lista por si tiene cambios.
    const i = STATE.briefs.findIndex(b => b.id === data.brief.id);
    if (i >= 0) STATE.briefs[i] = data.brief;
    return data;
  } catch (e) {
    return null;
  } finally {
    STATE.briefDetailLoading = false;
  }
}

// Redimensiona un blob de imagen si supera maxDim (lado mayor) o maxArea (px totales).
// Los screenshots que pega Joaco pueden venir ENORMES (ej. 23624x8034 px); con imágenes
// tan pesadas Gemini corta el render a los ~30s (deadline). Achicarlas acá lo evita.
// Usa createImageBitmap (aguanta imágenes muy grandes). Si ya es chica o falla, no toca nada.
async function resizeImageBlob(file, maxDim = 1600, maxArea = 3000000) {
  try {
    if (!/^image\//.test(file.type || '') || /gif/i.test(file.type || '')) return { blob: file, type: file.type || 'image/png' };
    let bmp = await createImageBitmap(file);
    const w = bmp.width, h = bmp.height;
    let scale = Math.min(1, maxDim / Math.max(w, h));
    if (w * h * scale * scale > maxArea) scale = Math.min(scale, Math.sqrt(maxArea / (w * h)));
    if (scale >= 1) { if (bmp.close) bmp.close(); return { blob: file, type: file.type || 'image/png' }; }
    const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
    if (bmp.close) bmp.close();
    bmp = await createImageBitmap(file, { resizeWidth: cw, resizeHeight: ch, resizeQuality: 'high' });
    const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    cv.getContext('2d').drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    const blob = await new Promise(res => cv.toBlob(b => res(b), 'image/jpeg', 0.85));
    return blob ? { blob, type: 'image/jpeg' } : { blob: file, type: file.type || 'image/png' };
  } catch (e) { return { blob: file, type: file.type || 'image/png' }; }
}
async function uploadBriefImage(briefId, blob, contentType, tipo = 'chat') {
  // Achicar imágenes grandes antes de subir (ver resizeImageBlob).
  try { const rz = await resizeImageBlob(blob.type ? blob : new Blob([blob], { type: contentType }), 1600, 3000000); if (rz && rz.blob) { blob = rz.blob; contentType = rz.type; } } catch (_) {}
  const r = await fetch(`${CONFIG.trackerUrl}/admin/briefs/${briefId}/imagen?tipo=${tipo}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${STATE.token}`, 'Content-Type': contentType },
    body: blob
  });
  if (!r.ok) throw new Error('upload failed: HTTP ' + r.status);
  return r.json();
}

async function deleteBriefAPI(id) {
  const r = await fetch(`${CONFIG.trackerUrl}/admin/briefs/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${STATE.token}` }
  });
  if (!r.ok) throw new Error('delete failed: HTTP ' + r.status);
}

async function handleBriefDelete(briefId, fromCard) {
  if (!briefId) return;
  // Solo comercial/admin pueden borrar.
  const role = getUserRole();
  if (role === 'disenador') { alert('Solo el comercial o admin puede borrar briefs.'); return; }
  const b = STATE.briefs.find(x => x.id === briefId);
  const titulo = b?.cliente_nombre || `Brief #${briefId}`;
  if (!confirm(`¿Borrar "${titulo}"? Esta acción no se puede deshacer.`)) return;
  try {
    await deleteBriefAPI(briefId);
    STATE.briefs = STATE.briefs.filter(x => x.id !== briefId);
    if (STATE.briefSelected === briefId) closeBriefDrawer();
    else render();
  } catch (e) {
    alert('Error al borrar: ' + e.message);
  }
}

// ============ TEAM CHAT (widget flotante global del equipo) ============
function autorNombre(autorId) {
  const k = _userKey(autorId);
  if (k === 'gaspar') return 'Gaspar';
  if (k === 'joaquin' || k === 'joaco') return 'Joaco';
  if (k === 'disenador' || k === 'emma' || k === 'emmanuel') return 'Diseñador';
  return autorId || '?';
}

async function fetchTeamChat() {
  if (!CONFIG.trackerUrl || !STATE.token) return;
  STATE.teamChatLoaded = true; // marcar antes para no entrar en loop de re-fetch
  try {
    const r = await fetch(`${CONFIG.trackerUrl}/admin/team-chat?limit=100`, {
      headers: { Authorization: `Bearer ${STATE.token}` }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    STATE.teamChatMessages = data.messages || [];
  } catch (e) { /* silencioso */ }
}

async function sendTeamMessage(texto) {
  const autor_id = _userKey(STATE.user) || 'joaco';
  const r = await fetch(`${CONFIG.trackerUrl}/admin/team-chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STATE.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ autor_id, tipo: 'text', contenido: texto })
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function uploadTeamImage(blob, contentType) {
  const autor = _userKey(STATE.user) || 'joaco';
  const r = await fetch(`${CONFIG.trackerUrl}/admin/team-chat/imagen?autor=${autor}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${STATE.token}`, 'Content-Type': contentType },
    body: blob
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// Cantidad de mensajes nuevos (no vistos) para el badge de la burbuja.
function teamChatUnread() {
  if (!STATE.teamChatLastSeen) return STATE.teamChatMessages.length ? 0 : 0;
  return STATE.teamChatMessages.filter(m =>
    m.created_at > STATE.teamChatLastSeen && _userKey(m.autor_id) !== _userKey(STATE.user)
  ).length;
}

function markTeamChatSeen() {
  const last = STATE.teamChatMessages.length ? STATE.teamChatMessages[STATE.teamChatMessages.length - 1].created_at : new Date().toISOString();
  STATE.teamChatLastSeen = last;
  try { localStorage.setItem('niventas.teamChatLastSeen', last); } catch(e) {}
}

function renderTeamChatBubbles() {
  const msgs = STATE.teamChatMessages || [];
  const myKey = _userKey(STATE.user);
  if (!msgs.length) return '<div style="font-size:12px;color:var(--fg-mute);text-align:center;padding:var(--s-4)">Sin mensajes todavía.<br>Escribile al equipo 👋</div>';
  return msgs.map(m => {
    const mine = _userKey(m.autor_id) === myKey;
    const hora = (function(){ try { return new Date(m.created_at).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }); } catch(e){ return ''; } })();
    let inner;
    if (m.tipo === 'image') {
      const url = `${CONFIG.trackerUrl}/admin/media/${encodeURIComponent(m.contenido)}?token=${STATE.token}`;
      inner = `<img src="${url}" data-img-zoom="${escapeHtml(url)}" style="max-width:180px;max-height:180px;border-radius:6px;cursor:zoom-in;display:block">`;
    } else {
      inner = `<div style="font-size:13px;color:var(--fg);white-space:pre-wrap;word-break:break-word">${escapeHtml(m.contenido || '')}</div>`;
    }
    return `
      <div style="display:flex;justify-content:${mine ? 'flex-end' : 'flex-start'};margin-bottom:8px">
        <div style="max-width:82%">
          <div style="font-size:10px;color:var(--fg-mute);margin-bottom:2px;${mine ? 'text-align:right' : ''}">${escapeHtml(autorNombre(m.autor_id))} · ${hora}</div>
          <div style="background:${mine ? 'rgba(143,212,222,.14)' : 'var(--ink-100)'};border:1px solid ${mine ? 'rgba(143,212,222,.25)' : 'var(--border)'};border-radius:10px;padding:${m.tipo === 'image' ? '4px' : '7px 11px'}">${inner}</div>
        </div>
      </div>`;
  }).join('');
}

function renderTeamChatWidget() {
  const unread = teamChatUnread();
  if (!STATE.teamChatOpen) {
    // Burbuja minimizada (FAB).
    return `
      <button id="team-chat-fab" title="Chat del equipo" aria-label="Abrir chat"
        style="position:fixed;bottom:24px;right:24px;z-index:120;width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;background:linear-gradient(135deg,var(--neon-red,#FF1830),var(--accent-cyan,#8FD4DE));box-shadow:0 4px 20px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;font-size:24px">
        💬
        ${unread > 0 ? `<span style="position:absolute;top:-2px;right:-2px;background:var(--neon-red,#FF1830);color:#fff;font-size:11px;font-weight:700;min-width:20px;height:20px;border-radius:10px;display:flex;align-items:center;justify-content:center;padding:0 5px;border:2px solid var(--bg,#0A0A0F)">${unread}</span>` : ''}
      </button>
    `;
  }
  // Ventana abierta.
  return `
    <div id="team-chat-window"
      style="position:fixed;bottom:24px;right:24px;z-index:120;width:min(380px,calc(100vw - 32px));height:min(520px,calc(100vh - 80px));background:var(--bg,#0A0A0F);border:1px solid var(--accent-cyan,#8FD4DE);border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:linear-gradient(135deg,rgba(255,24,48,.12),rgba(143,212,222,.12));border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px">💬 Chat del equipo</div>
        <button id="team-chat-min" title="Minimizar" aria-label="Minimizar"
          style="width:28px;height:28px;border-radius:6px;background:rgba(255,255,255,.08);color:var(--fg);border:0;cursor:pointer;font-size:16px;line-height:1">─</button>
      </div>
      <div id="team-chat-list" style="flex:1;overflow-y:auto;padding:12px 14px">
        ${renderTeamChatBubbles()}
      </div>
      <div style="display:flex;gap:6px;align-items:center;padding:10px 12px;border-top:1px solid var(--border)">
        <button id="team-chat-attach" title="Adjuntar imagen" aria-label="Adjuntar"
          style="width:34px;height:34px;border-radius:8px;background:var(--ink-100);border:1px solid var(--border);color:var(--fg-subtle);cursor:pointer;font-size:16px;flex-shrink:0">📎</button>
        <input type="file" id="team-chat-file" accept="image/*" multiple style="display:none">
        <input type="text" id="team-chat-input" placeholder="Mensaje…" autocomplete="off"
          style="flex:1;background:var(--ink-100);border:1px solid var(--border);border-radius:8px;padding:9px;color:var(--fg);font-size:13px">
        <button id="team-chat-send" class="btn btn-cyan" style="padding:9px 14px;flex-shrink:0">➤</button>
      </div>
    </div>
  `;
}

function refreshTeamChat(scroll = true) {
  const list = document.getElementById('team-chat-list');
  if (list) {
    list.innerHTML = renderTeamChatBubbles();
    if (scroll) list.scrollTop = list.scrollHeight;
    // Re-bind zoom de imágenes del chat.
    list.querySelectorAll('[data-img-zoom]').forEach(el => {
      el.onclick = (ev) => { ev.stopPropagation(); openImgLightbox(el.dataset.imgZoom); };
    });
  }
  // Si está minimizado, actualizar el badge.
  const fab = document.getElementById('team-chat-fab');
  if (fab && !STATE.teamChatOpen) render();
}

function openTeamChat() {
  STATE.teamChatOpen = true;
  render();
  fetchTeamChat().then(() => { markTeamChatSeen(); refreshTeamChat(); });
}
function closeTeamChat() {
  STATE.teamChatOpen = false;
  render();
}

// "Ruidito" de notificación con Web Audio (dos tonitos tipo pop). No requiere
// archivo de audio. Puede fallar si el browser bloquea autoplay sin interacción,
// pero como el usuario ya interactuó con el dashboard, normalmente suena.
let _teamAudioCtx = null;
function playChatSound() {
  try {
    _teamAudioCtx = _teamAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (_teamAudioCtx.state === 'suspended') _teamAudioCtx.resume();
    const t = _teamAudioCtx.currentTime;
    const o = _teamAudioCtx.createOscillator();
    const g = _teamAudioCtx.createGain();
    o.connect(g); g.connect(_teamAudioCtx.destination);
    o.type = 'sine';
    o.frequency.setValueAtTime(880, t);
    o.frequency.setValueAtTime(1245, t + 0.09);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.start(t); o.stop(t + 0.34);
  } catch (e) { /* sin audio */ }
}

function notifyChatBrowser(msg) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    // Solo notificar si la pestaña no está visible (si está mirando, ya lo ve).
    if (!document.hidden) return;
    const body = msg.tipo === 'image' ? '📷 Imagen' : (msg.contenido || '').slice(0, 90);
    const n = new Notification('💬 ' + autorNombre(msg.autor_id), { body, icon: 'assets/logo.svg', tag: 'team-chat' });
    n.onclick = () => { try { window.focus(); } catch(e){} if (STATE.view !== 'cotizacion' && STATE.view !== 'corporeas') setView('cotizacion'); openTeamChat(); n.close(); };
  } catch (e) {}
}

// Poll del team chat: detecta mensajes nuevos de OTROS y avisa con sonido +
// notificación. Corre mientras se está en la vista Cotización (abierto o minimizado).
async function pollTeamChat() {
  if (!CONFIG.trackerUrl || !STATE.token) return;
  let msgs = [];
  try {
    const r = await fetch(`${CONFIG.trackerUrl}/admin/team-chat?limit=100`, {
      headers: { Authorization: `Bearer ${STATE.token}` }
    });
    if (!r.ok) return;
    msgs = (await r.json()).messages || [];
  } catch (e) { return; }

  const prevTs = _teamChatLastMsgTs;
  if (msgs.length) _teamChatLastMsgTs = msgs[msgs.length - 1].created_at;
  const nuevosDeOtros = prevTs
    ? msgs.filter(m => m.created_at > prevTs && _userKey(m.autor_id) !== _userKey(STATE.user))
    : [];

  STATE.teamChatMessages = msgs;
  STATE.teamChatLoaded = true;

  if (nuevosDeOtros.length) {
    playChatSound();
    notifyChatBrowser(nuevosDeOtros[nuevosDeOtros.length - 1]);
  }

  if (STATE.teamChatOpen) { markTeamChatSeen(); refreshTeamChat(false); }
  else if (nuevosDeOtros.length) { render(); }  // refrescar badge de la burbuja
}

function startTeamChatPolling() {
  if (_teamChatPollTimer) return;
  _teamChatPollTimer = setInterval(() => {
    // Corpóreas reusa el board de Cotización (renderCorporeas = renderCotizacion),
    // así que el FAB del team-chat también vive ahí: el polling debe seguir activo
    // en AMBAS vistas, no solo en cotizacion (si no, en corpóreas el chat de equipo
    // no recibía mensajes nuevos: badge sin actualizar, sin sonido).
    if (STATE.view !== 'cotizacion' && STATE.view !== 'corporeas') { stopTeamChatPolling(); return; }
    if (pollBackoffActive()) return;  // D1 saturada: saltar el tick (el timer sigue)
    pollTeamChat();
  }, 8000);
}
function stopTeamChatPolling() {
  if (_teamChatPollTimer) { clearInterval(_teamChatPollTimer); _teamChatPollTimer = null; }
}

async function handleTeamChatSend() {
  const input = document.getElementById('team-chat-input');
  if (!input) return;
  const texto = input.value.trim();
  if (!texto) return;
  input.value = '';
  input.focus();
  // Optimista.
  const optimistic = { id: 'tmp' + Date.now(), autor_id: _userKey(STATE.user), tipo: 'text', contenido: texto, created_at: new Date().toISOString() };
  STATE.teamChatMessages.push(optimistic);
  refreshTeamChat();
  try {
    const res = await sendTeamMessage(texto);
    optimistic.id = res.id;
    markTeamChatSeen();
  } catch (e) {
    optimistic.contenido = '⚠ no se envió: ' + texto;
    refreshTeamChat();
  }
}

async function handleTeamChatImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  try {
    const res = await uploadTeamImage(file, file.type);
    STATE.teamChatMessages.push(res);
    markTeamChatSeen();
    refreshTeamChat();
  } catch (e) {
    alert('Error subiendo imagen: ' + e.message);
  }
}

async function deleteBriefImage(briefId, imgId) {
  const r = await fetch(`${CONFIG.trackerUrl}/admin/briefs/${briefId}/imagen/${imgId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${STATE.token}` }
  });
  if (!r.ok) throw new Error('delete failed: HTTP ' + r.status);
}

async function saveBrief(data) {
  const isCreate = !data.id;
  const url = isCreate
    ? `${CONFIG.trackerUrl}/admin/briefs`
    : `${CONFIG.trackerUrl}/admin/briefs/${data.id}`;
  const method = isCreate ? 'POST' : 'PATCH';
  const body = { ...data };
  delete body.id;
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${STATE.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('save failed: HTTP ' + r.status);
  const result = await r.json();
  return result.brief;
}

async function marcarBriefEnviado(id, extra = {}) {
  const r = await fetch(`${CONFIG.trackerUrl}/admin/briefs/${id}/enviar`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STATE.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(extra)
  });
  if (!r.ok) throw new Error('enviar failed: HTTP ' + r.status);
  return (await r.json()).brief;
}

// Manda un brief de vuelta a 'A cotizar' (nuevo) para que Emma lo modifique
// (el cliente vio el presupuesto y pidió un cambio): lo marca urgente + modificar
// y lo deja arriba de la cola. Sirve para 'listo' Y 'enviado' — siempre resetea a
// nuevo + urgente + modificar. Gate de rol en el botón (canCotizar = Joaco/Gaspar).
async function mandarBriefAModificar(id) {
  if (!id) return;
  const ok = await showConfirm(
    'Mandar este pedido de vuelta a "A cotizar" para que Emma lo modifique?\n\nVa a aparecer arriba de todo (urgente) con el sticker "modificar".',
    { title: 'Mandar a modificar', confirmLabel: '🔧 Mandar a modificar', cancelLabel: 'Cancelar' }
  );
  if (!ok) return;
  try {
    await saveBrief({ id, estado: 'nuevo', urgente: 1, modificar: 1 });
    const i = STATE.briefs.findIndex(x => x.id === id);
    if (i >= 0) STATE.briefs[i] = { ...STATE.briefs[i], estado: 'nuevo', urgente: 1, modificar: 1 };
    closeBriefDrawer();
    render();
    toast('Mandado a modificar — quedó arriba en "A cotizar" 🔧');
  } catch (e) {
    toast('No se pudo mandar a modificar');
  }
}

// Toggle del flag urgente desde el DRAWER del brief (mismo efecto que el 🔥 de la
// card). Optimista: actualiza el state + re-render y revierte si el save falla.
async function toggleBriefUrgente(id) {
  const b = STATE.briefs.find(x => x.id === id);
  if (!b) return;
  const prev = b.urgente ? 1 : 0;
  b.urgente = prev ? 0 : 1;
  render();
  try { await saveBrief({ id, urgente: b.urgente }); }
  catch (e) { b.urgente = prev; render(); toast('No se pudo marcar urgente'); }
}

// Verifica vía API si a un teléfono ya se le mandó un presupuesto por WhatsApp.
// Busca en el historial outbound un mensaje que matchee isPresupuestoMessage
// (o el follow-up de presupuesto) en los últimos `dias` días. NO reenvía nada.
// Devuelve { enviado: bool, ts, wamid } — enviado=true si encontró el presu.
async function verificarPresupuestoEnHistorial(phone, dias = 30) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 8) return { enviado: false };
  const tel = normalizeArPhoneFE(digits);
  const since = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/messages?phone=' + encodeURIComponent(tel) + '&direction=outbound&from=' + encodeURIComponent(since) + '&limit=500', {
      headers: authHeaders()
    });
    if (!r.ok) return { enviado: false };
    const j = await r.json();
    const msgs = j.messages || [];
    // Un presupuesto cuenta si: matchea el prefijo del cotizador, o es el
    // follow-up de presupuesto, y NO está fallido.
    const hit = msgs
      .filter(m => m.status !== 'failed')
      .filter(m => isPresupuestoMessage(m.body) || String(m.body || '').startsWith(FOLLOWUP_PRESUPUESTO_PREFIX))
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
    if (hit) return { enviado: true, ts: hit.ts, wamid: hit.wamid || '' };
    return { enviado: false };
  } catch (e) {
    return { enviado: false, error: e.message };
  }
}

// Botón "🔍 Verificar enviados": recorre los briefs en 'listo' tipo WhatsApp con
// teléfono, consulta el historial WA de cada uno, y marca como enviado los que
// ya tienen el presupuesto mandado. No reenvía. Resuelve el atraso de golpe.
async function handleVerificarEnviados() {
  if (STATE.verificandoEnviados) return;
  if (!STATE.token) { await showAlert('Tenés que estar logueado.', { title: 'Login requerido', variant: 'warn' }); return; }

  // Candidatos: 'listos' + 'colgados' (briefs 'nuevo'/'listo' parados +24h), origen
  // WA (o con teléfono cargado), con tel válido. Incluir los colgados capta los que
  // Joaco mandó por la app de WA sin actualizar el CRM: se detectan en el historial
  // y pasan a "Enviados" de una, limpiando el atraso.
  const candidatos = STATE.briefs.filter(b => {
    if (!(b.estado === 'listo' || isBriefColgado(b))) return false;
    const o = String(b.origen_lead || '').toLowerCase();
    const tel = String(b.cliente_wa_id || '').replace(/\D/g, '');
    const esWa = o === 'wpp' || o === 'whatsapp' || (o === '' && tel.length >= 8);
    return esWa && tel.length >= 8;
  });

  if (!candidatos.length) {
    await showAlert('No hay briefs en "Listos" ni "Colgados" de WhatsApp con teléfono para verificar.', { title: 'Nada para verificar' });
    return;
  }

  STATE.verificandoEnviados = true;
  render();
  let marcados = 0, sinRastro = 0;
  try {
    // Secuencial para no saturar el worker / la API de WhatsApp.
    for (const b of candidatos) {
      const res = await verificarPresupuestoEnHistorial(b.cliente_wa_id);
      if (res.enviado) {
        try {
          const updated = await marcarBriefEnviado(b.id);
          const i = STATE.briefs.findIndex(x => x.id === updated.id);
          if (i >= 0) STATE.briefs[i] = updated;
          marcados++;
        } catch (e) { /* sigue con el resto */ }
      } else {
        sinRastro++;
      }
    }
  } finally {
    STATE.verificandoEnviados = false;
    render();
  }

  await showAlert(
    `Revisé ${candidatos.length} brief${candidatos.length > 1 ? 's' : ''} de WhatsApp ("Listos" + "Colgados").\n\n` +
    `✓ ${marcados} pasaron a "Enviados" (encontré el presupuesto en el historial).\n` +
    `• ${sinRastro} quedaron sin cambios (no encontré presupuesto mandado — capaz se mandó editado o todavía no se envió).`,
    { title: 'Verificación terminada', variant: marcados > 0 ? 'success' : undefined }
  );
}

// Tiempo relativo "hace X" para el badge SLA en cada tarjeta.
function relativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - Date.parse(iso);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'recién';
  if (mins < 60) return `hace ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours}h`;
  const days = Math.floor(hours / 24);
  return `hace ${days}d`;
}

function isBriefStale(b) {
  // Regla de cerebro 6.4: tiempo de respuesta importa. Estado activo sin
  // mover +24h = badge rojo. Enviado sin respuesta +7d = colgado (auto).
  if (b.estado === 'enviado' || b.estado === 'cerrado') return false;
  const last = Date.parse(b.updated_at);
  return (Date.now() - last) > 24 * 60 * 60 * 1000;
}

// Cruce con tabla de Presupuestos del Sheet: heurística por nombre normalizado.
// Si el brief tiene un cliente_nombre que matchea con un presupuesto del sheet (mismo
// nombre, fecha cercana), consideramos que fue cotizado.
function findPresupuestoMatch(brief) {
  if (!brief) return null;
  // 1) Señal AUTORITATIVA: si el brief tiene sheet_row, el presupuesto YA se
  //    escribió en el Sheet al enviarlo (saveCotToSheetFromPopup guardó el número
  //    de fila que devolvió el Apps Script). No dependemos del match por nombre
  //    contra STATE.presupuestos, que puede estar desactualizado si el presupuesto
  //    se mandó DESPUÉS de que cargó el dashboard → falso ⚠ "no está en el Sheet".
  if (brief.sheet_row) {
    // Intentar traer la fila real (para mostrar datos en el drawer); si no la
    // encontramos en la data cargada, devolvemos un match sintético igual.
    const byName = Array.isArray(STATE.presupuestos) && brief.cliente_nombre
      ? STATE.presupuestos.find(p => {
          const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          return norm(p.cliente || p.nombre || '') === norm(brief.cliente_nombre);
        })
      : null;
    return byName || { nombre: brief.cliente_nombre || '', sheet_row: brief.sheet_row, _bySheetRow: true };
  }
  // 2) Fallback (briefs viejos sin sheet_row): match exacto por nombre normalizado.
  if (!Array.isArray(STATE.presupuestos) || !brief.cliente_nombre) return null;
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(brief.cliente_nombre);
  if (!target) return null;
  return STATE.presupuestos.find(p => norm(p.cliente || p.nombre || '') === target) || null;
}

function renderBriefCard(b) {
  const colgado = isBriefColgado(b);
  const motivo = colgado ? getColgadoMotivo(b) : '';
  const intentos = b.intentos_followup || 0;
  const chatCount = b.chat_count || 0;
  const renderCount = b.render_count || 0;
  const generando = !!STATE.briefsGenerando[b.id];
  // En el kanban mostramos el render si lo hay (refleja avance), si no la captura del chat.
  const thumb = b.first_render_key || b.first_chat_key || null;
  const isRenderThumb = !!b.first_render_key;
  const medidas = b.medidas_libre || ((b.alto_cm && b.ancho_cm) ? `${Math.round(b.ancho_cm)}×${Math.round(b.alto_cm)} cm` : '');
  const pMatch = b.estado === 'enviado' ? findPresupuestoMatch(b) : null;
  const sinPresupuesto = b.estado === 'enviado' && !pMatch;
  const thumbUrl = thumb ? `${CONFIG.trackerUrl}/admin/media/${encodeURIComponent(thumb)}?token=${STATE.token}` : null;
  const borderColor = colgado ? 'rgba(255,167,38,.45)' : sinPresupuesto ? 'rgba(255,167,38,.35)' : 'var(--border)';
  const canDelete = canCreateBriefs();  // mismo gate: comercial/admin
  return `
    <div class="brief-card" data-brief-id="${b.id}" data-sig="${briefCardSig(b)}"
         style="background:var(--ink-100);border:1px solid ${generando ? 'var(--accent-cyan,#8FD4DE)' : borderColor};border-radius:var(--r-sm);overflow:hidden;margin-bottom:var(--s-2);cursor:pointer;transition:border-color .15s;position:relative">
      ${generando ? `<div style="position:absolute;top:6px;left:6px;background:rgba(143,212,222,.92);color:#000;font-size:9px;font-weight:700;padding:3px 7px;border-radius:10px;z-index:3;animation:nv-pulse 1.4s ease-in-out infinite">✨ Generando IA…</div>` : ''}
      ${canDelete ? `<button class="brief-card-delete" data-brief-delete="${b.id}" title="Eliminar brief" aria-label="Eliminar"
              style="position:absolute;top:4px;right:4px;width:22px;height:22px;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;border:0;cursor:pointer;font-size:12px;line-height:1;display:flex;align-items:center;justify-content:center;z-index:2;opacity:.6;transition:opacity .15s,background .15s"
              onmouseover="this.style.opacity='1';this.style.background='rgba(255,24,48,.85)'"
              onmouseout="this.style.opacity='.6';this.style.background='rgba(0,0,0,.55)'">✕</button>` : ''}
      ${canCreateBriefs() && b.estado === 'nuevo' && !generando ? `<button class="brief-card-urgente" data-brief-urgente="${b.id}" title="${b.urgente ? 'Quitar urgente' : 'Marcar urgente (prioridad para Emma)'}"
              style="position:absolute;top:4px;left:4px;width:22px;height:22px;border-radius:50%;background:${b.urgente ? 'rgba(255,24,48,.92)' : 'rgba(0,0,0,.55)'};border:0;cursor:pointer;font-size:11px;line-height:1;display:flex;align-items:center;justify-content:center;z-index:3;opacity:${b.urgente ? '1' : '.55'};transition:opacity .15s,background .15s">🔥</button>` : ''}
      ${thumbUrl ? `
        <div style="width:100%;height:120px;background:var(--ink-050);position:relative;overflow:hidden">
          <img src="${thumbUrl}" loading="lazy" decoding="async" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">
          ${isRenderThumb ? '<div style="position:absolute;top:4px;left:4px;background:rgba(143,212,222,.85);color:#000;font-size:9px;font-weight:600;padding:2px 6px;border-radius:3px;z-index:1">RENDER</div>' : ''}
          ${(chatCount + renderCount) > 1 ? `<div style="position:absolute;bottom:4px;right:4px;background:rgba(0,0,0,.7);color:#fff;font-size:10px;padding:2px 6px;border-radius:10px;z-index:1">+${(chatCount + renderCount) - 1}</div>` : ''}
        </div>
      ` : ''}
      <div style="padding:var(--s-2)">
        <div style="display:flex;justify-content:space-between;align-items:start;gap:6px;margin-bottom:4px">
          <div style="font-weight:600;font-size:13px;line-height:1.3;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${escapeHtml(b.cliente_nombre || 'Sin título')}
          </div>
          <div style="display:flex;gap:3px;flex-shrink:0">
            ${(() => {
              // Badge del VENDEDOR (de quién es el brief): SOLO lo ven Emma (diseñador) y Gaspar
              // (admin) — así Emma sabe a quién le cotiza. Joaco/Nadia ven solo los suyos, no lo necesitan.
              const _r = getUserRole();
              if (_r !== 'admin' && _r !== 'disenador') return '';
              const _c = String(b.comercial_id || '').toLowerCase();
              const _nom = _c === 'nadia' ? 'Nadia' : (_c === 'joaco' ? 'Joaquín' : (_c || '—'));
              const _col = _c === 'nadia' ? '#c084fc' : '#8FD4DE';
              return `<span title="Vendedor: ${escapeHtml(_nom)}" style="background:${_col}22;color:${_col};font-size:9px;padding:1px 5px;border-radius:3px;font-weight:600">${escapeHtml(_nom)}</span>`;
            })()}
            ${(() => {
              // Chip de origen: 📱 (WA, con tel) o 📷 (IG). Ayuda a Joaco a
              // identificar de un vistazo si el brief puede enviarse por API.
              const o = String(b.origen_lead || '').toLowerCase();
              if (o === 'ig' || o === 'instagram') {
                return '<span title="Consulta vino por Instagram — copiar y pegar en DM" style="background:rgba(225,48,108,.15);color:#E1306C;font-size:9px;padding:1px 5px;border-radius:3px;font-weight:600">IG</span>';
              }
              if (o === 'wpp' || o === 'whatsapp' || (b.cliente_wa_id && String(b.cliente_wa_id).length >= 8)) {
                return '<span title="Consulta vino por WhatsApp — se puede enviar presu por API" style="background:rgba(37,211,102,.15);color:#25D366;font-size:9px;padding:1px 5px;border-radius:3px;font-weight:600">WA</span>';
              }
              return '';
            })()}
            ${sinPresupuesto ? '<span title="Marcado como enviado pero no encontramos presupuesto en el Sheet" style="background:rgba(255,167,38,.15);color:#FFA726;font-size:9px;padding:1px 5px;border-radius:3px">⚠</span>' : ''}
            ${pMatch ? '<span title="Tiene presupuesto en el Sheet" style="background:rgba(37,211,102,.15);color:#25D366;font-size:9px;padding:1px 5px;border-radius:3px">✓</span>' : ''}
          </div>
        </div>
        ${(b.urgente && b.estado === 'nuevo') || b.modificar ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px">
          ${b.urgente && b.estado === 'nuevo' ? '<span style="background:rgba(255,24,48,.16);color:#ff5468;font-size:9px;font-weight:700;padding:1px 6px;border-radius:3px">🔥 URGENTE</span>' : ''}
          ${b.modificar && (b.estado === 'nuevo' || b.estado === 'listo') ? '<span style="background:rgba(255,167,38,.16);color:#FFA726;font-size:9px;font-weight:700;padding:1px 6px;border-radius:3px">🔧 MODIFICAR</span>' : ''}
        </div>` : ''}
        ${colgado ? `<div style="font-size:11px;color:#FFA726;margin-bottom:4px"><b>⚠ Colgado:</b> ${escapeHtml(motivo)}</div>` : ''}
        ${medidas ? `<div style="font-size:11px;color:var(--fg-subtle);margin-bottom:4px">${escapeHtml(medidas)}</div>` : ''}
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:10px;color:var(--fg-mute, rgba(233,237,239,.4))">
          <div style="display:flex;gap:6px;align-items:center">
            ${!thumbUrl && chatCount > 0 ? `<span title="${chatCount} captura(s)">📎 ${chatCount}</span>` : ''}
            ${intentos > 0 ? `<span title="Intentos de seguimiento">↻ ${intentos}/12</span>` : ''}
          </div>
          <div>${relativeTime(b.updated_at)}</div>
        </div>
      </div>
    </div>
  `;
}

// Producto del tablero activo: 'neon' (Cotización) | 'corporea' (Corpóreas). Lo setea
// renderCotizacion(producto). Separa los dos kanbans sobre la misma tabla de briefs.
let briefProducto = 'neon';
function briefMatchesProducto(b) {
  return briefProducto === 'corporea' ? b.tipo === 'corporea' : b.tipo !== 'corporea';
}
function renderBriefColumn(col) {
  let briefs = STATE.briefs.filter(b => briefBelongsToColumn(b, col.id) && briefMatchesProducto(b));
  // En "A cotizar" (nuevo) los urgentes van arriba de todo para que Emma priorice.
  if (col.id === 'nuevo') briefs = briefs.slice().sort((a, b) => (b.urgente ? 1 : 0) - (a.urgente ? 1 : 0));
  const isDropTarget = col.id === 'nuevo' && canCreateBriefs();
  const dashedBorder = isDropTarget ? 'border:2px dashed rgba(143,212,222,.25)' : 'border:1px solid var(--border)';
  const hint = isDropTarget && !briefs.length
    ? '<div style="font-size:11px;color:var(--accent-cyan);text-align:center;padding:var(--s-4);line-height:1.5;opacity:.7">📋 Pegá Ctrl+V<br>o arrastrá una imagen<br>acá adentro</div>'
    : (briefs.length ? '' : '<div style="font-size:11px;color:var(--fg-mute);text-align:center;padding:var(--s-4)">—</div>');
  return `
    <div class="brief-col" data-col="${col.id}" style="flex:1;min-width:240px;background:var(--ink-050,#0f0f15);${dashedBorder};border-radius:var(--r-md);padding:var(--s-2);display:flex;flex-direction:column;transition:border-color .15s,background .15s">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--s-2);padding:0 4px">
        <span style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:${col.color}">
          ${col.label}
        </span>
        <span style="font-size:11px;color:var(--fg-mute);font-family:ui-monospace,monospace" data-col-count data-total="${briefs.length}">${briefs.length}</span>
      </div>
      <div class="brief-col-list" style="flex:1;overflow-y:auto;max-height:calc(100vh - 220px)">
        ${briefs.length ? briefs.map(renderBriefCard).join('') : hint}
      </div>
    </div>
  `;
}

// Filtra las cards del board de cotización según briefSearch SIN re-renderizar
// (preserva el foco del input y los handlers de las cards). Oculta las que no
// matchean por cliente/diseño/teléfono y actualiza el contador de cada columna.
// Se re-aplica desde bindCotizacion tras cada render (ej. polling actualizó el board).
function filterBriefBoard() {
  const q = briefSearch ? normName(briefSearch) : '';
  document.querySelectorAll('.brief-col').forEach(colEl => {
    let visible = 0;
    colEl.querySelectorAll('.brief-card').forEach(card => {
      const b = STATE.briefs.find(x => x.id === parseInt(card.dataset.briefId, 10));
      const hay = b ? normName([b.cliente_nombre, b.diseno, b.cliente_wa_id].filter(Boolean).join(' ')) : '';
      const show = !q || (hay && hay.includes(q));
      card.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    const countEl = colEl.querySelector('[data-col-count]');
    if (countEl) countEl.textContent = q ? visible : (countEl.dataset.total || visible);
  });
}

// ===== Modo comparación Emma vs IA (diseñador IA — solo Joaco + Gaspar) =====
function _iaMedia(key) { return (key && STATE.token) ? (CONFIG.trackerUrl + '/admin/media/' + encodeURIComponent(key) + '?token=' + encodeURIComponent(STATE.token)) : ''; }
function _iaMoney(n) { return (n == null || isNaN(n)) ? '—' : ('$' + Math.round(n).toLocaleString('es-AR')); }
function _iaPrecio(a, al, n, t, tipo) { if (!a || !al || !n) return null; try { return calcCotizadorNuevo({ ancho: +a, alto: +al, neon: +n, tramos: +t || 0, tipo: tipo || 'INT' }).transFinal; } catch (e) { return null; } }
// Ancho (cm) que pidió el cliente, parseado de medidas_libre ("90x50", "1 mt", "90").
// Se usa para escalar la medición CV cuando Emma todavía no cargó el ancho.
function parseAnchoDeMedida(txt) {
  if (!txt) return 0;
  const s = String(txt).toLowerCase();
  const nums = (s.match(/[0-9]+(?:[.,][0-9]+)?/g) || []).map(x => parseFloat(x.replace(',', '.')));
  if (!nums.length) return 0;
  let w = nums[0]; // convención "ancho x alto" → el primero es el ancho
  if (/\bm\b|mt|metro/.test(s) && w > 0 && w < 10) w = w * 100; // "1 mt" → 100 cm
  return Math.round(w) || 0;
}

async function generarDisenioIA(briefId) {
  STATE.iaGenerando = STATE.iaGenerando || {};
  if (STATE.iaGenerando[briefId]) return;
  if (!STATE.token) { await showAlert('Tenés que estar logueado', { title: 'Diseño IA', variant: 'warn' }); return; }
  STATE.iaGenerando[briefId] = true; render();
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/briefs/' + briefId + '/generar-ia', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() } });
    const j = await r.json().catch(() => ({ error: 'respuesta inválida' }));
    if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
    // Medir el boceto con CV en el navegador + cotizar + guardar.
    const brief = STATE.briefs.find(b => b.id === briefId) || {};
    const ancho = Number(brief.ancho_cm) || parseAnchoDeMedida(brief.medidas_libre) || 0;
    if (ancho > 0 && j.ia_boceto_key) {
      let med = null;
      try { med = await medirBocetoIA(_iaMedia(j.ia_boceto_key), ancho); } catch (e) { med = null; }
      if (med) {
        const precio = _iaPrecio(ancho, med.alto, med.neon, med.tramos, brief.tipo);
        await fetch(CONFIG.trackerUrl + '/admin/briefs/' + briefId, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ ia_alto_cm: med.alto, ia_neon_mt: med.neon, ia_tramos: med.tramos, ia_precio_trans: precio }) });
      }
    }
    await fetchBriefDetail(briefId);
  } catch (e) {
    await showAlert('No se pudo generar el diseño IA: ' + (e.message || e), { title: 'Diseño IA', variant: 'warn' });
  } finally {
    STATE.iaGenerando[briefId] = false; render();
  }
}

async function guardarFeedbackIA(briefId, feedback) {
  const el = document.getElementById('ia-feedback-nota');
  const nota = el ? el.value : '';
  try {
    await fetch(CONFIG.trackerUrl + '/admin/briefs/' + briefId, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ ia_feedback: feedback, ia_feedback_nota: nota }) });
    const b = STATE.briefs.find(x => x.id === briefId); if (b) { b.ia_feedback = feedback; b.ia_feedback_nota = nota; }
    render();
  } catch (e) { await showAlert('No se pudo guardar el feedback', { title: 'Feedback', variant: 'warn' }); }
}

// Sección de comparación para el drawer. Devuelve '' si no aplica (gate Joaco+Gaspar).
function renderIACompare(data) {
  if (!data || !data.id) return '';
  if (!(isJoaquinUser(STATE.user) || isGasparUser(STATE.user))) return '';
  if (data.tipo === 'corporea') return '';
  const gen = STATE.iaGenerando && STATE.iaGenerando[data.id];
  const box = 'background:var(--card,#12121a);border:1px solid var(--border);border-radius:var(--r-md,10px);padding:10px';
  const head = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span style="font-weight:700;font-size:14px">🤖 Diseñador IA vs Emma</span><span style="font-size:11px;color:var(--sub);border:1px solid var(--border);border-radius:6px;padding:1px 6px">prueba</span></div>`;
  const wrap = (inner) => `<fieldset style="border:1px dashed var(--accent-cyan,#8FD4DE);border-radius:var(--r-md,10px);padding:12px;margin-top:14px">${head}${inner}</fieldset>`;

  if (gen) return wrap(`<div style="display:flex;align-items:center;gap:8px;color:var(--sub);font-size:13px"><span class="spin" style="width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--accent-cyan);border-radius:50%;display:inline-block;animation:spin 1s linear infinite"></span> Generando diseño IA + midiendo… (planner + imagen, ~30s)</div>`);

  if (!data.ia_boceto_key) {
    return wrap(`<button class="btn btn-cyan" id="brief-generar-ia" data-brief-id="${data.id}" style="width:100%">Diseñar con IA</button><div style="font-size:12px;color:var(--sub);margin-top:8px">La IA diseña el boceto desde la referencia del cliente, lo mide (ancho/alto/neón/tramos) y cotiza — para comparar con Emma.</div>`);
  }

  const tipo = data.tipo || 'INT';
  const eA = Number(data.ancho_cm) || 0, eAl = Number(data.alto_cm) || 0, eN = Number(data.neon_mt) || 0, eT = Number(data.tramos) || 0;
  const ePrecio = _iaPrecio(eA, eAl, eN, eT, tipo);
  const iaAl = data.ia_alto_cm, iaN = data.ia_neon_mt, iaT = data.ia_tramos, iaP = data.ia_precio_trans;
  const pdiff = (ePrecio && iaP) ? Math.round((iaP - ePrecio) / ePrecio * 100) : null;
  // Imagen de Emma: su render si existe, si no su boceto.
  const emmaImg = (STATE.briefDetailImages.find(x => x.tipo === 'render') || STATE.briefDetailImages.find(x => x.tipo === 'boceto'));
  const emmaUrl = emmaImg ? _iaMedia(emmaImg.r2_key) : '';
  const iaUrl = _iaMedia(data.ia_boceto_key);
  const cell = (title, imgUrl, a, al, n, t, precio, diffPill) => `
    <div style="${box}">
      <div style="font-size:10px;font-weight:700;letter-spacing:.5px;color:var(--sub);margin-bottom:6px">${title}${diffPill || ''}</div>
      ${imgUrl ? `<img src="${imgUrl}" style="width:100%;height:96px;object-fit:contain;background:#3a3d42;border-radius:6px;border:1px solid var(--border)">` : `<div style="height:96px;display:flex;align-items:center;justify-content:center;color:var(--sub);font-size:11px;background:#22222c;border-radius:6px">sin imagen</div>`}
      <div style="font-size:12px;color:var(--sub);margin-top:6px;line-height:1.7">
        <div>Ancho·Alto: <b style="color:var(--fg)">${a || '—'} · ${al || '—'} cm</b></div>
        <div>Neón·Tramos: <b style="color:var(--fg)">${n || '—'} m · ${t || '—'}</b></div>
        <div style="margin-top:2px;font-size:14px">Precio: <b style="color:var(--fg)">${_iaMoney(precio)}</b></div>
      </div>
    </div>`;
  const diffPill = pdiff != null ? ` <span style="color:${Math.abs(pdiff) <= 10 ? 'var(--ok,#4fca77)' : (Math.abs(pdiff) <= 20 ? 'var(--warn,#e0a94f)' : 'var(--red,#f0644a)')};font-weight:700">${pdiff > 0 ? '+' : ''}${pdiff}%</span>` : '';
  const fbOk = data.ia_feedback === 'bien', fbMal = data.ia_feedback === 'mal';
  return wrap(`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      ${cell('EMMA', emmaUrl, eA, eAl, eN, eT, ePrecio, '')}
      ${cell('IA', iaUrl, eA, iaAl, iaN, iaT, iaP, diffPill)}
    </div>
    <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
      <div style="font-size:12px;color:var(--sub);margin-bottom:6px">¿La cotización de la IA está bien?</div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <button class="btn" id="ia-fb-bien" data-brief-id="${data.id}" style="border-color:${fbOk ? 'var(--ok,#4fca77)' : 'var(--border)'};color:${fbOk ? 'var(--ok,#4fca77)' : 'var(--fg)'}">✓ Bien</button>
        <button class="btn" id="ia-fb-mal" data-brief-id="${data.id}" style="border-color:${fbMal ? 'var(--red,#f0644a)' : 'var(--border)'};color:${fbMal ? 'var(--red,#f0644a)' : 'var(--fg)'}">✗ Mal</button>
        <input type="text" id="ia-feedback-nota" placeholder="nota (opcional)…" value="${(data.ia_feedback_nota || '').replace(/"/g, '&quot;')}" style="flex:1;min-width:140px;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm,7px);padding:7px 9px;color:var(--fg);font-size:13px">
        <button class="btn btn-ghost" id="brief-regenerar-ia" data-brief-id="${data.id}" title="Volver a generar">↻</button>
      </div>
      ${data.ia_feedback ? `<div style="font-size:11px;color:var(--sub);margin-top:6px">Marcado: <b style="color:var(--fg)">${data.ia_feedback === 'bien' ? 'Bien ✓' : 'Mal ✗'}</b></div>` : ''}
    </div>`);
}


function renderBriefDrawer() {
  if (!STATE.briefSelected && !STATE.briefDraft) return '';
  const isNew = !STATE.briefSelected;
  const data = isNew ? STATE.briefDraft : (STATE.briefDraft || STATE.briefs.find(b => b.id === STATE.briefSelected) || {});
  const pMatch = (!isNew && data.estado === 'enviado') ? findPresupuestoMatch(data) : null;
  const role = getUserRole();
  const isCom = role === 'comercial' || role === 'admin';
  const isDis = role === 'disenador' || role === 'admin';
  const esCorpBrief = data.tipo === 'corporea';
  let corpCj = {}; if (esCorpBrief) { try { corpCj = JSON.parse(data.corporea_json || '{}') || {}; } catch(e){} }
  const corpSinLuz = esCorpBrief && corpCj.con_luz === false;
  const corpPr = esCorpBrief ? calcCorporea({ ancho: data.ancho_cm, alto: data.alto_cm, con_luz: corpSinLuz ? '0' : '1', frente_material: corpCj.frente_material || 'impreso' }) : null;
  const corpAc = (field, val, l0, l1) => corpSinLuz ? '<span class="pill" style="font-size:11px">opaco</span>' : `<select data-corp-bf="${field}" style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px;color:var(--fg)"><option value="translucido" ${String(val||'').startsWith('transl')?'selected':''}>${l0}</option><option value="opaco" ${!String(val||'').startsWith('transl')?'selected':''}>${l1}</option></select>`;
  const corpColorSel = (field, val) => {
    const baseKeys = Object.keys(CORP_COLOR_MAP);
    // Solo el FRENTE ofrece "Replicar diseño" (gráfica impresa full color).
    const keys = (field === 'frente_color') ? [CORP_REPLICAR, ...baseKeys] : baseKeys;
    const cur = keys.find(k => k.toLowerCase() === String(val||'').toLowerCase()) || baseKeys[0];
    const dot = (k) => `<span class="corp-cdot" style="width:13px;height:13px;border-radius:50%;background:${k===CORP_REPLICAR?CORP_REPLICAR_GRAD:(CORP_COLOR_MAP[k]||'#888')};border:1px solid rgba(255,255,255,.35);flex-shrink:0;display:inline-block"></span>`;
    const opts = keys.map(k => `<div data-corp-color="${field}|${k}" style="display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;font-size:13px${k===cur?';background:rgba(143,212,222,.12)':''}${k===CORP_REPLICAR?';border-bottom:1px solid var(--border);font-weight:600':''}">${dot(k)}${k}</div>`).join('');
    return `<div style="position:relative">
      <input type="hidden" data-corp-bf="${field}" value="${cur}">
      <button type="button" data-corp-color-trigger="${field}" style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:7px 9px;color:var(--fg);font-size:13px;cursor:pointer;text-align:left;display:flex;align-items:center;gap:8px;justify-content:space-between"><span style="display:flex;align-items:center;gap:8px">${dot(cur)}<span class="corp-cname">${cur}</span></span><span style="opacity:.5">▾</span></button>
      <div id="corp-colorpanel-${field}" style="display:none;position:absolute;left:0;right:0;z-index:30;background:var(--bg,#0A0A0F);border:1px solid var(--accent-cyan,#8FD4DE);border-radius:var(--r-sm);max-height:240px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.5);margin-top:2px">${opts}</div>
    </div>`;
  };
  const estado = data.estado || 'nuevo';

  // Imágenes separadas por tipo.
  const chatImgs = STATE.briefDetailImages.filter(x => (x.tipo || 'chat') === 'chat');
  const renderImgs = STATE.briefDetailImages.filter(x => x.tipo === 'render');

  // El bloque "Respuesta del diseñador" se muestra siempre que el brief exista
  // (no es draft), porque tanto Emma como Joaco necesitan verlo:
  // - Emma para llenar / editar (en nuevo o listo).
  // - Joaco para ver el resultado (en listo o enviado, read-only).
  const showRenderBlock = !isNew;

  return `
    <div class="brief-drawer-backdrop" id="brief-drawer-backdrop"
         style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:90"></div>
    <aside class="brief-drawer" id="brief-drawer"
           style="position:fixed;top:0;right:0;bottom:0;width:min(560px,100vw);background:var(--bg, #0A0A0F);border-left:1px solid var(--border);z-index:100;overflow-y:auto;padding:var(--s-4)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--s-3);position:sticky;top:0;background:var(--bg);padding-bottom:var(--s-2);border-bottom:1px solid var(--border);z-index:1">
        <h2 style="margin:0;font-size:16px">
          ${isNew ? '➕ Nuevo brief' : '📋 Brief #' + data.id}
          <span style="font-size:11px;color:var(--fg-subtle);font-weight:400;margin-left:6px">${estado}</span>
        </h2>
        <button class="btn btn-ghost btn-icon" id="brief-close" aria-label="Cerrar">✕</button>
      </div>

      <div style="display:grid;gap:var(--s-3)">

        <!-- ========= ZONA 1: Pedido de Joaco ========= -->
        <fieldset id="brief-zone-chat" style="border:1px solid var(--border);border-radius:var(--r-sm);padding:var(--s-3)">
          <legend style="font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em;padding:0 6px">📋 Pedido de Joaco</legend>

          <label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">Título ${isCom ? '<span style="color:#FF5566">*</span>' : ''}</label>
          <input type="text" data-bf="cliente_nombre" id="brief-titulo-input" value="${escapeHtml(data.cliente_nombre || '')}"
                 placeholder="ej. Cartel Alhambra"
                 ${!isCom ? 'readonly' : ''}
                 style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:10px;color:var(--fg);font-size:14px;margin-bottom:var(--s-3);${!isCom ? 'opacity:.7' : ''}">

          ${(() => {
            // Bloque origen + teléfono. Editable por comercial/admin. Para roles
            // diseñador es read-only. Cuando origen=wpp, el teléfono es
            // obligatorio para poder mandar el presu via API al finalizar.
            // Back-compat: briefs viejos con origen_lead='' los tratamos como
            // 'wpp' si tienen cliente_wa_id (heredado del flujo anterior).
            const origenRaw = (data.origen_lead || '').toLowerCase();
            const origen = (origenRaw === 'ig' || origenRaw === 'instagram') ? 'ig'
                         : (origenRaw === 'wpp' || origenRaw === 'whatsapp' || data.cliente_wa_id) ? 'wpp'
                         : 'wpp';
            const tel = data.cliente_wa_id || '';
            const actStyle = 'border:1px solid var(--accent-cyan,#8FD4DE);background:rgba(143,212,222,.08);color:var(--accent-cyan)';
            const inactStyle = 'border:1px solid var(--border);background:transparent;color:var(--fg-subtle)';
            return `
              <label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">¿Por dónde llegó la consulta? ${isCom ? '<span style="color:#FF5566">*</span>' : ''}</label>
              <div style="display:flex;gap:8px;margin-bottom:var(--s-3)">
                <label id="brief-origen-lbl-wpp" data-brief-origen="wpp" style="flex:1;cursor:${isCom ? 'pointer' : 'default'};padding:8px;border-radius:var(--r-sm);text-align:center;font-size:13px;${origen === 'wpp' ? actStyle : inactStyle};opacity:${isCom ? '1' : '.7'}">
                  <input type="radio" name="brief-origen" data-bf-radio="origen_lead" value="wpp" ${origen === 'wpp' ? 'checked' : ''} ${!isCom ? 'disabled' : ''} style="display:none">
                  📱 WhatsApp
                </label>
                <label id="brief-origen-lbl-ig" data-brief-origen="ig" style="flex:1;cursor:${isCom ? 'pointer' : 'default'};padding:8px;border-radius:var(--r-sm);text-align:center;font-size:13px;${origen === 'ig' ? actStyle : inactStyle};opacity:${isCom ? '1' : '.7'}">
                  <input type="radio" name="brief-origen" data-bf-radio="origen_lead" value="ig" ${origen === 'ig' ? 'checked' : ''} ${!isCom ? 'disabled' : ''} style="display:none">
                  📷 Instagram
                </label>
              </div>
              <div id="brief-tel-wrap" style="${origen === 'wpp' ? '' : 'display:none'}">
                <label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">
                  Teléfono del cliente <span style="color:#FF5566">*</span>
                  <span style="color:var(--fg-mute);font-size:10px;margin-left:4px">obligatorio para mandar presu por WhatsApp</span>
                </label>
                <input type="tel" data-bf="cliente_wa_id" id="brief-tel-input" value="${escapeHtml(tel)}"
                       placeholder="ej. 5491155604999 (sin +, solo dígitos)"
                       ${!isCom ? 'readonly' : ''}
                       style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:10px;color:var(--fg);font-size:14px;margin-bottom:var(--s-3);${!isCom ? 'opacity:.7' : ''}">
              </div>
            `;
          })()}

          <label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">Medidas referenciales (lo que pidió el cliente)</label>
          <input type="text" data-bf="medidas_libre" value="${escapeHtml(data.medidas_libre || '')}"
                 placeholder="ej. 90x50 aprox, letras 80cm, INT"
                 ${!isCom ? 'readonly' : ''}
                 style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:10px;color:var(--fg);font-size:14px;margin-bottom:var(--s-3);${!isCom ? 'opacity:.7' : ''}">

          <label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">Capturas del chat / referencias</label>
          ${isCom ? `
          <div id="brief-dropzone"
               style="border:2px dashed var(--border);border-radius:var(--r-sm);padding:var(--s-2);text-align:center;color:var(--fg-mute);font-size:11px;cursor:pointer;transition:border-color .15s,background .15s">
            📋 Pegá (Ctrl+V) o arrastrá capturas acá
            <input type="file" id="brief-file-input" accept="image/*" multiple style="display:none">
          </div>
          ` : (chatImgs.length === 0 ? '<div style="font-size:11px;color:var(--fg-mute);text-align:center;padding:var(--s-2)">— Joaco aún no subió capturas —</div>' : '')}
          <div id="brief-images-grid-chat"
               style="margin-top:var(--s-2);display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px">
            ${renderBriefImagesGridFor('chat', isNew, isCom)}
          </div>
        </fieldset>

        ${showRenderBlock ? `
        <!-- ========= ZONA 2: Respuesta del diseñador ========= -->
        <fieldset id="brief-zone-disenador" style="border:1px solid rgba(143,212,222,.25);border-radius:var(--r-sm);padding:var(--s-3);background:rgba(143,212,222,.03)">
          <legend style="font-size:11px;color:var(--accent-cyan);text-transform:uppercase;letter-spacing:.06em;padding:0 6px">🎨 Respuesta del diseñador</legend>

          <!-- Boceto vectorizado (lo sube Emma) -->
          <label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">Boceto vectorizado de cotización</label>
          ${isDis ? `
          <div id="brief-dropzone-boceto"
               style="border:2px dashed rgba(143,212,222,.3);border-radius:var(--r-sm);padding:var(--s-2);text-align:center;color:var(--fg-mute);font-size:11px;cursor:pointer;transition:border-color .15s,background .15s">
            ✏️ Pegá (Ctrl+V) o arrastrá el boceto acá
            <input type="file" id="brief-file-input-boceto" accept="image/*" multiple style="display:none">
          </div>
          ` : (STATE.briefDetailImages.filter(x=>x.tipo==='boceto').length === 0 ? '<div style="font-size:11px;color:var(--fg-mute);text-align:center;padding:var(--s-2)">— sin boceto —</div>' : '')}
          <div id="brief-images-grid-boceto"
               style="margin-top:var(--s-2);display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px;margin-bottom:var(--s-2)">
            ${renderBriefImagesGridFor('boceto', false, isDis)}
          </div>

          <!-- Botón: generar render + estimar medidas con IA -->
          ${(() => {
            // Disponible para diseñador Y comercial/admin: el AI saca todo
            // (render + ancho + alto + mts neón) de cualquier imagen disponible
            // (boceto si existe, si no las capturas que mandó Joaco).
            const tieneBoceto = STATE.briefDetailImages.some(x => x.tipo === 'boceto');
            const tieneChat = chatImgs.length > 0;
            const hayInput = tieneBoceto || tieneChat;
            const fuente = tieneBoceto ? 'el boceto' : 'las capturas de Joaco';
            const generando = !!STATE.briefsGenerando[STATE.briefSelected];
            const disabled = generando || !hayInput;
            const label = generando
              ? '✨ Generando… podés seguir con otro brief'
              : !hayInput
                ? '⚠ Subí al menos una imagen para generar'
                : `✨ Generar render IA (con ${fuente})`;
            return `
              <button class="btn btn-cyan" id="brief-generar-render" style="width:100%;margin-bottom:var(--s-3)" ${disabled ? 'disabled' : ''}>${label}</button>
              <div id="brief-render-ia-status" style="font-size:11px;text-align:center;margin-bottom:var(--s-2);min-height:14px;color:var(--fg-mute)"></div>
            `;
          })()}

          <!-- Render generado por IA — aparece automáticamente acá tras clickear el botón -->
          <label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">Render ${isDis ? '(se genera con el botón de arriba)' : 'del diseño'}</label>
          ${isDis && renderImgs.length === 0 ? '<div style="font-size:11px;color:var(--fg-mute);text-align:center;padding:var(--s-2);border:1px dashed rgba(143,212,222,.15);border-radius:var(--r-sm)">— el render aparecerá acá cuando lo generes con IA —</div>' : ''}
          ${!isDis && renderImgs.length === 0 ? '<div style="font-size:11px;color:var(--fg-mute);text-align:center;padding:var(--s-2)">— sin render todavía —</div>' : ''}
          <div id="brief-images-grid-render"
               style="margin-top:var(--s-2);display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px;margin-bottom:var(--s-3)">
            ${renderBriefImagesGridFor('render', false, isDis)}
          </div>

          ${(() => {
            // Banner del último razonamiento IA si es este brief y hay info.
            const ai = STATE.briefLastAiParams;
            if (!ai || ai.briefId !== STATE.briefSelected) return '';
            const warn = ai.dif_vs_cliente;
            const bg = warn ? 'rgba(255,167,38,.1)' : 'rgba(143,212,222,.08)';
            const border = warn ? '#FFA726' : 'var(--accent-cyan)';
            const icon = warn ? '⚠' : '✨';
            const prefix = warn
              ? '<b>AI difiere de lo que dijo el cliente.</b> '
              : '<b>AI sugiere estas medidas:</b> ';
            return `<div style="padding:8px 12px;margin-bottom:var(--s-2);background:${bg};border-left:3px solid ${border};border-radius:var(--r-sm);font-size:12px;color:var(--fg-subtle)">
              ${icon} ${prefix}${escapeHtml(ai.razonamiento || '')}
            </div>`;
          })()}

          <!-- Medidas (auto-rellenadas por AI o editables a mano). Solo carteles:
               las corpóreas tienen su propia grilla (medidas + specs) más abajo. -->
          ${!esCorpBrief ? `
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:var(--s-2)">
            <div>
              <label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">Ancho (cm)</label>
              <input type="number" step="1" data-bf="ancho_cm" value="${data.ancho_cm || ''}"
                     ${!isDis ? 'readonly' : ''}
                     style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px;color:var(--fg);${!isDis ? 'opacity:.7' : ''}">
            </div>
            <div>
              <label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">Alto (cm)</label>
              <input type="number" step="1" data-bf="alto_cm" value="${data.alto_cm || ''}"
                     ${!isDis ? 'readonly' : ''}
                     style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px;color:var(--fg);${!isDis ? 'opacity:.7' : ''}">
            </div>
            <div>
              <label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">Neón (mt)</label>
              <input type="number" step="0.1" data-bf="neon_mt" value="${data.neon_mt || ''}"
                     ${!isDis ? 'readonly' : ''}
                     style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px;color:var(--fg);${!isDis ? 'opacity:.7' : ''}">
            </div>
            <div title="Cantidad de tramos/cortes independientes del neón LED. Se cuenta en Illustrator. Afecta el margen por complejidad en la fórmula nueva.">
              <label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">Tramos</label>
              <input type="number" step="1" min="0" data-bf="tramos" value="${data.tramos || ''}"
                     ${!isDis ? 'readonly' : ''}
                     placeholder="ej. 15"
                     style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px;color:var(--fg);${!isDis ? 'opacity:.7' : ''}">
            </div>
          </div>` : ''}
          ${esCorpBrief ? `
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:var(--s-2)">
            <div><label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">Ancho (cm)</label><input type="number" step="1" data-bf="ancho_cm" value="${data.ancho_cm || ''}" style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px;color:var(--fg)"></div>
            <div><label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">Alto (cm)</label><input type="number" step="1" data-bf="alto_cm" value="${data.alto_cm || ''}" style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px;color:var(--fg)"></div>
            <div><label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">Iluminación</label><select data-corp-bf="con_luz" style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px;color:var(--fg)"><option value="1" ${!corpSinLuz?'selected':''}>Con luz</option><option value="0" ${corpSinLuz?'selected':''}>Sin luz</option></select></div>
          </div>
          <div style="font-size:12px;font-weight:600;color:var(--accent-cyan);text-transform:uppercase;letter-spacing:.08em;margin:var(--s-3) 0 6px;padding-bottom:5px;border-bottom:1px solid var(--border)">Frente</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:var(--s-2)">
            <div><label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">Material</label><select data-corp-bf="frente_material" style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px;color:var(--fg)"><option value="impreso" ${(corpCj.frente_material||'impreso')!=='acrilico'?'selected':''}>Impreso</option><option value="acrilico" ${corpCj.frente_material==='acrilico'?'selected':''}>Acrílico</option></select></div>
            <div><label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">Acabado</label>${corpAc('frente_acabado', corpCj.frente_acabado||'translucido','Translúcido','Opaco')}</div>
            <div><label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">Color</label>${corpColorSel('frente_color', corpCj.frente_color)}</div>
          </div>
          <div style="font-size:12px;font-weight:600;color:var(--accent-cyan);text-transform:uppercase;letter-spacing:.08em;margin:var(--s-3) 0 6px;padding-bottom:5px;border-bottom:1px solid var(--border)">Laterales</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:var(--s-2)">
            <div><label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">Acabado</label>${corpAc('lat_acabado', corpCj.lat_acabado||'translucido','Translúcido','Opaco')}</div>
            <div><label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">Color</label>${corpColorSel('lat_color', corpCj.lat_color)}</div>
          </div>
          <div style="font-size:12px;font-weight:600;color:var(--accent-cyan);text-transform:uppercase;letter-spacing:.08em;margin:var(--s-3) 0 6px;padding-bottom:5px;border-bottom:1px solid var(--border)">Espalda</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:var(--s-2)">
            <div><label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">Acabado</label>${corpAc('esp_acabado', corpCj.esp_acabado||'translucida','Translúcida','Opaca')}</div>
            <div><label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">Color</label>${corpColorSel('esp_color', corpCj.esp_color)}</div>
          </div>
          <div id="corp-price-box">${corpPriceBoxHtml(corpPr)}</div>
          <div style="font-size:11px;color:var(--fg-mute);margin-top:6px">💡 Guardá para recalcular el precio y dejar la config lista para el render.</div>
          ` : `
          <label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px">Tipo</label>
          <div style="display:flex;gap:8px">
            <label style="flex:1;cursor:${isDis ? 'pointer' : 'default'};opacity:${isDis ? '1' : '.7'}">
              <input type="radio" name="brief-tipo" data-bf-radio="tipo" value="INT" ${(data.tipo || 'INT') === 'INT' ? 'checked' : ''} ${!isDis ? 'disabled' : ''} style="margin-right:4px">
              Interior
            </label>
            <label style="flex:1;cursor:${isDis ? 'pointer' : 'default'};opacity:${isDis ? '1' : '.7'}">
              <input type="radio" name="brief-tipo" data-bf-radio="tipo" value="EXT" ${data.tipo === 'EXT' ? 'checked' : ''} ${!isDis ? 'disabled' : ''} style="margin-right:4px">
              Exterior
            </label>
          </div>
          `}

          ${estado === 'nuevo' && isDis && !esCorpBrief ? `
            <div style="margin-top:var(--s-2);padding:var(--s-2);background:rgba(143,212,222,.06);border-radius:4px;font-size:11px;color:var(--accent-cyan);text-align:center">
              💡 Al guardar con render + ancho + alto + neón completos, pasa automáticamente a "Listos".
            </div>
          ` : ''}
        </fieldset>
        ` : ''}

        ${renderIACompare(data)}

        <!-- Notas (cualquier rol puede escribir) -->
        <div>
          <label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px;text-transform:uppercase;letter-spacing:.06em">Notas</label>
          <textarea data-bf="notas" rows="2" placeholder="cambios pedidos, info extra, etc."
                    style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px;color:var(--fg);font-family:inherit;font-size:13px;resize:vertical">${escapeHtml(data.notas || '')}</textarea>
        </div>


        ${pMatch ? `
        <div style="padding:var(--s-2);background:rgba(37,211,102,.08);border:1px solid rgba(37,211,102,.3);border-radius:var(--r-sm);font-size:12px;color:#25D366">
          ✓ Hay presupuesto correspondiente en el Sheet: <b>${escapeHtml(pMatch.cliente || pMatch.nombre || '')}</b>
        </div>
        ` : ''}
        ${(!isNew && data.estado === 'enviado' && !pMatch) ? `
        <div style="padding:var(--s-2);background:rgba(255,167,38,.08);border:1px solid rgba(255,167,38,.3);border-radius:var(--r-sm);font-size:12px;color:#FFA726">
          ⚠ Marcado como enviado pero no encontramos presupuesto en el Sheet.
        </div>
        ` : ''}

        <!-- Acciones por rol y estado -->
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding-bottom:var(--s-4)">
          ${!isNew && canCreateBriefs() ? `<button class="btn btn-ghost" id="brief-delete" style="color:#FF5566;border-color:rgba(255,24,48,.25)" title="Eliminar este brief">🗑 Eliminar</button>` : ''}
          ${!isNew && estado === 'nuevo' && canCreateBriefs() ? `<button class="btn btn-ghost" id="brief-urgente-toggle" title="${data.urgente ? 'Quitar urgente' : 'Marcar urgente (prioridad para Emma)'}" style="color:${data.urgente ? '#ff5468' : 'var(--fg-subtle)'};border-color:${data.urgente ? 'rgba(255,24,48,.5)' : 'var(--border)'}">🔥 ${data.urgente ? 'Urgente ✓' : 'Marcar urgente'}</button>` : ''}
          <div style="flex:1"></div>
          ${!isNew && estado === 'listo' && canCotizar() ? (esCorpBrief ? `<button class="btn btn-cyan" id="corp-ver-presupuesto">💰 Ver presupuesto</button>` : `<button class="btn btn-cyan" id="brief-cotizar-popup">💰 Ver presupuesto</button>`) : ''}
          ${!isNew && (estado === 'listo' || estado === 'enviado') && canCotizar() ? `<button class="btn btn-ghost" id="brief-modificar" title="Volver a 'A cotizar' para que Emma lo modifique (queda urgente y arriba de todo)" style="color:#FFA726;border-color:rgba(255,167,38,.4)">🔧 Mandar a modificar</button>` : ''}
          ${!isNew && estado === 'enviado' && isCom ? `<button class="btn btn-ghost" id="brief-cotizar">📐 Abrir Cotizador</button>` : ''}
          ${(isCom || isDis || isNew) ? `<button class="btn ${isNew ? 'btn-cyan' : 'btn-ghost'}" id="brief-save">${isNew ? 'Crear brief' : 'Guardar'}</button>` : ''}
        </div>
      </div>
    </aside>
  `;
}

// Render grid de imágenes para un tipo específico (chat | render).
// editable = si el rol actual puede borrar imágenes de este tipo.
function renderBriefImagesGridFor(tipo, isDraft, editable) {
  if (isDraft && tipo === 'chat') {
    // En draft solo soportamos capturas del chat (todavía no hay id para subir render).
    if (!STATE.briefDraftImages.length) return '';
    return STATE.briefDraftImages.map((img, i) => `
      <div style="position:relative;width:100%;aspect-ratio:1;border-radius:4px;overflow:hidden;background:var(--ink-050)">
        <img src="${img.dataUrl}" style="width:100%;height:100%;object-fit:cover">
        <button type="button" data-drop-img-remove="${i}" title="Quitar"
                style="position:absolute;top:2px;right:2px;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,.7);color:#fff;border:0;cursor:pointer;font-size:11px;line-height:1;display:flex;align-items:center;justify-content:center">✕</button>
      </div>
    `).join('');
  }
  const imgs = STATE.briefDetailImages.filter(x => (x.tipo || 'chat') === tipo);
  if (!imgs.length) return '';
  // Los RENDER de IA se muestran en calidad FULL (sin ?w). Las capturas del chat /
  // referencias se comprimen al vuelo (el worker redimensiona con ?w) porque el panel
  // junta muchas y se pone pesado/lento para Emma. Miniatura chica, zoom mediano.
  const isRender = tipo === 'render';
  return imgs.map(img => {
    const base = `${CONFIG.trackerUrl}/admin/media/${encodeURIComponent(img.r2_key)}?token=${STATE.token}`;
    const thumbUrl = isRender ? base : base + '&w=560';
    const zoomUrl = isRender ? base : base + '&w=1400';
    return `
      <div style="position:relative;width:100%;aspect-ratio:1;border-radius:4px;overflow:hidden;background:var(--ink-050)">
        <img src="${thumbUrl}" loading="lazy" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in" data-img-zoom="${escapeHtml(zoomUrl)}">
        ${editable ? `<button type="button" data-img-remove="${img.id}" title="Eliminar"
                style="position:absolute;top:2px;right:2px;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,.7);color:#fff;border:0;cursor:pointer;font-size:11px;line-height:1;display:flex;align-items:center;justify-content:center">✕</button>` : ''}
      </div>
    `;
  }).join('');
}

let briefSearch = ''; // búsqueda del board de cotización — filtra las cards en vivo (las columnas son los estados)
// ============ CORPÓREAS (cotización de letras 3D) ============
// Panel paralelo al de carteles, acceso solo Joaquín + Gaspar. Modelo de precio
// por MULTIPLICADOR (distinto al divisor de carteles): precio = m² × costo/m² × margen.
// Crea un brief tipo='corporea' con corporea_json; el render + seguimiento reusan
// el drawer de briefs existente (es agnóstico al tipo).
function defaultCorpForm() {
  return { cliente:'', telefono:'', ancho:'', alto:'', con_luz:'1',
    frente_material:'impreso', frente_acabado:'translucido', frente_color:'#ffd400',
    lat_acabado:'translucido', lat_color:'#ffffff',
    esp_acabado:'translucida', esp_color:'#ffffff' };
}
const CORP_PRECIOS = { conluz: { impreso: 320000, acrilico: 400000 }, sinluz: { impreso: 200000, acrilico: 300000 } };
function calcCorporea(f) {
  const ancho = +f.ancho || 0, alto = +f.alto || 0;
  const m2 = (ancho * alto) / 10000;
  const conLuz = String(f.con_luz) !== '0';
  const mat = f.frente_material === 'acrilico' ? 'acrilico' : 'impreso';
  const costoM2 = CORP_PRECIOS[conLuz ? 'conluz' : 'sinluz'][mat];
  const costo = m2 * costoM2;
  const margen = m2 <= 2 ? 2 : (m2 <= 5 ? 1.75 : 1.5);
  const precio = Math.round(costo * margen / 1000) * 1000;
  return { m2, conLuz, costoM2, costo, margen, precio };
}
// Deriva el caso visual A-E (igual que el worker) para mostrarlo de referencia.
function corporeaCaso(f) {
  const conLuz = String(f.con_luz) !== '0';
  const fT = String(f.frente_acabado || '').startsWith('transl');
  const lT = String(f.lat_acabado || '').startsWith('transl');
  const eT = String(f.esp_acabado || '').startsWith('transl');
  if (!conLuz) return 'E';
  if (fT && lT) return 'A';
  if (fT && !lT) return 'B';
  if (!fT && lT) return 'C';
  if (!fT && !lT && eT) return 'D';
  return 'E';
}
// Contenido de la cajita de precio del drawer corpóreo (reusable para el live-update).
function corpPriceBoxHtml(r) {
  return `<div style="display:flex;justify-content:space-between;align-items:center;padding:var(--s-2) var(--s-3);background:rgba(143,212,222,.06);border-radius:var(--r-sm)"><div><div style="font-size:11px;color:var(--fg-subtle)">Precio final</div><div style="font-size:20px;font-weight:600;color:var(--accent-cyan)">${fmtMoney(r.precio)}</div></div><div style="text-align:right;font-size:11px;color:var(--fg-subtle)">${r.m2.toLocaleString('es-AR',{maximumFractionDigits:2})} m²${isAdmin()?` · costo ${fmtMoney(r.costo)} · ×${r.margen}`:''}<br>Comisión Joaco 3%: ${fmtMoney(Math.round(r.precio*0.03))}</div></div>`;
}
// Recalcula el precio del drawer corpóreo en vivo (sin re-render, mantiene foco).
function updateCorpDrawerPrice() {
  const box = document.getElementById('corp-price-box');
  if (!box) return;
  const val = (s, d) => { const el = document.querySelector(s); return el ? el.value : d; };
  box.innerHTML = corpPriceBoxHtml(calcCorporea({
    ancho: val('[data-bf="ancho_cm"]', 0), alto: val('[data-bf="alto_cm"]', 0),
    con_luz: val('[data-corp-bf="con_luz"]', '1'), frente_material: val('[data-corp-bf="frente_material"]', 'impreso')
  }));
}
document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t && t.matches && t.matches('[data-bf="ancho_cm"],[data-bf="alto_cm"]') && document.getElementById('corp-price-box')) updateCorpDrawerPrice();
});
document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t && t.matches && t.matches('[data-corp-bf="con_luz"],[data-corp-bf="frente_material"]') && document.getElementById('corp-price-box')) updateCorpDrawerPrice();
});
// Paleta de colores corpóreos (nombre → hex) — usada por el dropdown custom del drawer.
const CORP_COLOR_MAP = {'Blanco':'#ffffff','Blanco cálido':'#fff1d6','Blanco frío':'#e9f1ff','Crema':'#f7efd6','Beige':'#e3d3a8','Marfil':'#fbf8ef','Negro':'#141414','Gris oscuro':'#454545','Gris':'#8a8a8a','Gris claro':'#c9c9c9','Plateado':'#c6cace','Rojo':'#e10600','Rojo oscuro':'#8b0000','Bordó':'#5c0a1e','Coral':'#ff6f5e','Rosa':'#ff5fa2','Rosa pastel':'#ffc2d4','Fucsia':'#ff2d8e','Magenta':'#cc0a78','Naranja':'#ff7a00','Naranja oscuro':'#cc5200','Ámbar':'#ffbf00','Amarillo':'#ffd400','Amarillo oro':'#f0c000','Dorado':'#d4af37','Verde lima':'#7ce000','Verde':'#1db954','Verde oscuro':'#0b6b35','Verde agua':'#22c9a9','Menta':'#9ff0c8','Celeste':'#5ec8ff','Cyan':'#00cfd4','Turquesa':'#1fc7c7','Azul':'#1565ff','Azul marino':'#0a2a66','Violeta':'#7c3aed','Lila':'#b794f6','Púrpura':'#6b21a8','Marrón':'#7b4a21','Chocolate':'#4a2c11'};
// "Replicar diseño": opción especial SOLO del frente — en vez de un color sólido,
// el frente va en GRÁFICA IMPRESA full color reproduciendo el logo/diseño que mandó
// el cliente (para logos multicolor que no se representan con un color). Swatch = arcoíris.
const CORP_REPLICAR = 'Replicar diseño';
const CORP_REPLICAR_GRAD = 'conic-gradient(from 0deg,#ff3b30,#ff9500,#ffd400,#34c759,#00c7be,#1565ff,#7c3aed,#ff2d8e,#ff3b30)';
// Dropdown de color custom (swatch en cada opción). Delegado: trigger toggle / opción selecciona / click afuera cierra.
document.addEventListener('click', (ev) => {
  const opt = ev.target.closest && ev.target.closest('[data-corp-color]');
  if (opt) {
    const sp = opt.dataset.corpColor.split('|'); const field = sp[0], name = sp[1];
    const panel = document.getElementById('corp-colorpanel-' + field);
    const wrap = panel && panel.parentElement;
    if (wrap) {
      const hid = wrap.querySelector('[data-corp-bf]'); if (hid) hid.value = name;
      const trig = wrap.querySelector('[data-corp-color-trigger]');
      if (trig) { const d = trig.querySelector('.corp-cdot'); if (d) d.style.background = (name === CORP_REPLICAR) ? CORP_REPLICAR_GRAD : (CORP_COLOR_MAP[name] || '#888'); const nm = trig.querySelector('.corp-cname'); if (nm) nm.textContent = name; }
    }
    document.querySelectorAll('[id^="corp-colorpanel-"]').forEach(p => p.style.display = 'none');
    return;
  }
  const trig = ev.target.closest && ev.target.closest('[data-corp-color-trigger]');
  if (trig) {
    const panel = document.getElementById('corp-colorpanel-' + trig.dataset.corpColorTrigger);
    const wasOpen = panel && panel.style.display === 'block';
    document.querySelectorAll('[id^="corp-colorpanel-"]').forEach(p => p.style.display = 'none');
    if (panel && !wasOpen) panel.style.display = 'block';
    return;
  }
  document.querySelectorAll('[id^="corp-colorpanel-"]').forEach(p => p.style.display = 'none');
});
// ===== Presupuesto de corpórea (Stage C) — popup con texto editable + copiar + enviar por WhatsApp.
// Mismo flujo que "Ver presupuesto" de neones, pero con precio/texto corpóreo y SIN tocar el Sheet.
// Arma el texto del presupuesto de una CORPÓREA con las variables que se eligieron
// (material del frente, color o "replica tu diseño", acabado, color de laterales,
// iluminación y halo). Mismo estilo que el de neón pero adaptado a letras 3D.
// Campos variables del presupuesto de corpórea, compuestos en UN solo lugar.
// Lo reusan el texto libre (corpPresupuestoTexto) y la plantilla de fallback
// presupuesto_corporea (enviarPresupuestoCorporeaComoPlantilla) — así no divergen.
function corpPresupuestoFields(brief, cj) {
  cj = cj || {};
  // Color como texto legible: nombres (ej. "Rojo") sí; hex (#xxxxxx) se omite.
  const fmtCol = (c) => { c = String(c || '').trim(); return (!c || c[0] === '#') ? '' : c.toLowerCase(); };
  const acab = (v, def) => String(v || def).toLowerCase().startsWith('transl') ? 'translúcido' : 'opaco';
  const esReplica = /replic|dise[ñn]o/i.test(String(cj.frente_color || ''));
  const conLuz = !(cj.con_luz === false || cj.con_luz === '0' || cj.con_luz === 0 || cj.con_luz === 'no');
  const fTrans = String(cj.frente_acabado || 'translucido').toLowerCase().startsWith('transl');
  const mat = String(cj.frente_material) === 'acrilico' ? 'acrílico' : 'impreso';
  const med = (cj.ancho_cm && cj.alto_cm) ? `${cj.ancho_cm}x${cj.alto_cm} cm` : (brief.medidas_libre || '');
  const precio = brief.precio_final || cj.precio || 0;

  // Frente: material + color/diseño + acabado.
  let frente;
  if (esReplica) {
    frente = 'gráfica impresa full color, reproduciendo tu diseño';
  } else {
    const col = fmtCol(cj.frente_color);
    frente = mat + (col ? ` color ${col}` : '');
  }
  frente += fTrans ? ', translúcido (el frente ilumina)' : ', opaco';

  // Laterales y fondo (espalda): color + acabado (opaco/translúcido).
  const latCol = fmtCol(cj.lat_color), espCol = fmtCol(cj.esp_color);
  const laterales = latCol ? `${latCol} (${acab(cj.lat_acabado, 'translucido')})` : acab(cj.lat_acabado, 'translucido');
  const fondo = espCol ? `${espCol} (${acab(cj.esp_acabado, 'opaca')})` : acab(cj.esp_acabado, 'opaca');

  return {
    nombre: brief.cliente_nombre || '',
    medidas: med,
    frente,
    laterales,
    fondo,
    conLuz,
    iluminacion: conLuz ? 'con LED interno' : 'sin luz',
    precio,
  };
}
function corpPresupuestoTexto(brief, cj) {
  const f = corpPresupuestoFields(brief, cj);
  const L = [
    'Te comparto el presupuesto con la información detallada!',
    '',
    `Trabajo: ${f.nombre}`,
  ];
  if (f.medidas) L.push(`Medidas: ${f.medidas}`);
  L.push(`Frente: ${f.frente}`);
  L.push(`Laterales: ${f.laterales}`);
  L.push(`Fondo: ${f.fondo}`);
  L.push(`Iluminación: ${f.iluminacion}`);
  L.push('', `Precio: ${fmtMoney(f.precio)}`, '',
    `Fabricación en letras 3D${f.conLuz ? ' con LED interno' : ''}. Para arrancar pedimos el 50% de seña — aceptamos todos los medios de pago. Hacemos envíos a todo el país!`,
    'Cualquier duda quedo a disposición 🙌',
    '', 'Tiempo de producción: 15/20 días');
  return L.join('\n');
}
function openCorpPopup(id) { STATE.corpPopupBrief = id; STATE.corpPopupText = null; render(); }
function closeCorpPopup() { STATE.corpPopupBrief = null; STATE.corpPopupText = null; render(); }
// ============ Herramientas de imagen IA (rectificar perspectiva / vectorizar B&N) ============
// Herramientas del diseñador (Emma) + admin: subís una imagen y con un click la
// procesás con Gemini (mismo modelo que los renders del cotizador), para usarla de
// base de diseño. Un solo modal parametrizado por "modo". No toca briefs.
const IMG_TOOL_CFG = {
  rectify: {
    icon: '🔧', title: 'Rectificar foto', sub: 'perspectiva → vista frontal',
    zoneIcon: '📐', zoneHint: 'Tocá para subir una foto, o pegá con Ctrl+V',
    zoneSub: 'cartel en perspectiva · JPG o PNG · máx 12 MB',
    resultLabel: 'Rectificada', loadingMsg: '⏳ Enderezando con IA…<br>(10-20s)',
    go: '✨ Rectificar perspectiva', going: '⏳ Rectificando…', again: '↻ Rectificar de nuevo',
    resetLabel: '↺ Otra foto', endpoint: '/admin/img-tool?mode=rectify', file: 'rectificada.png',
  },
  vectorize: {
    icon: '⬛', title: 'Vectorizar (B&N)', sub: 'silueta maciza para Illustrator',
    zoneIcon: '⬛', zoneHint: 'Tocá para subir el logo/diseño, o pegá con Ctrl+V',
    zoneSub: 'para el Calco de Imagen · JPG o PNG · máx 12 MB',
    resultLabel: 'Silueta B&N', loadingMsg: '⏳ Convirtiendo a B&N con IA…<br>(10-20s)',
    go: '✨ Generar silueta B&N', going: '⏳ Procesando…', again: '↻ Generar de nuevo',
    resetLabel: '↺ Otra imagen', endpoint: '/admin/img-tool?mode=vectorize', file: 'silueta-bn.png',
  },
};
function _imgToolCfg() { return IMG_TOOL_CFG[(STATE.rectify && STATE.rectify.mode) || 'rectify'] || IMG_TOOL_CFG.rectify; }
function _ensureRectifyListeners() {
  if (window._rectifyBound) return;
  window._rectifyBound = true;
  // El input file dispara 'change'; los botones 'click' (delegado, el modal se re-renderiza).
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'rectify-file') _rectifyPickFile(e.target.files && e.target.files[0]);
    if (e.target && e.target.id === 'rectify-notes' && STATE.rectify) STATE.rectify.notes = e.target.value;
  });
  // Pegar con Ctrl+V mientras el modal está abierto: agarra la imagen del portapapeles.
  document.addEventListener('paste', (e) => {
    if (!STATE.rectify || !STATE.rectify.open) return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    let file = null;
    for (const it of items) {
      if (it.kind === 'file' && (it.type || '').startsWith('image/')) { file = it.getAsFile(); break; }
    }
    if (!file) return;
    e.preventDefault();
    _rectifyPickFile(file);
  });
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.matches && t.matches('[data-rectify-bg]')) return closeRectifyModal();
    if (t.closest('[data-rectify-close]')) return closeRectifyModal();
    if (t.closest('[data-rectify-reset]')) { STATE.rectify = { ...(STATE.rectify || {}), open: true, origUrl: '', origFile: null, result: null, error: '' }; return render(); }
    if (t.closest('[data-rectify-download]')) return downloadRectify();
    if (t.closest('[data-rectify-go]')) return doRectify();
  });
}
function openImgTool(mode) {
  _ensureRectifyListeners();
  STATE.rectify = { open: true, mode: (mode === 'vectorize' ? 'vectorize' : 'rectify'), origUrl: '', origFile: null, result: null, loading: false, error: '' };
  render();
}
function closeRectifyModal() {
  if (STATE.rectify) STATE.rectify.open = false;
  render();
}
function _rectifyPickFile(file) {
  if (!file || !/^image\//.test(file.type || '')) { toast('Elegí una imagen'); return; }
  if (file.size > 12 * 1024 * 1024) { toast('La imagen es muy grande (máx 12 MB)'); return; }
  const fr = new FileReader();
  fr.onload = () => {
    STATE.rectify = { ...(STATE.rectify || {}), open: true, origUrl: fr.result, origFile: file, result: null, error: '' };
    render();
  };
  fr.readAsDataURL(file);
}
async function doRectify() {
  const st = STATE.rectify;
  if (!st || !st.origFile || st.loading) return;
  st.loading = true; st.error = ''; render();
  try {
    const _notes = ((document.getElementById('rectify-notes') || {}).value || st.notes || '').trim();
    const resp = await fetch(CONFIG.trackerUrl + _imgToolCfg().endpoint + (_notes ? ('&notes=' + encodeURIComponent(_notes.slice(0, 600))) : ''), {
      method: 'POST',
      headers: { 'Content-Type': st.origFile.type || 'image/png', ...authHeaders() },
      body: st.origFile
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) st.error = data.error || ('HTTP ' + resp.status);
    else st.result = { base64: data.base64, mime: data.mime || 'image/png' };
  } catch (e) {
    st.error = 'Error de red: ' + (e.message || e);
  } finally {
    st.loading = false; render();
  }
}
function downloadRectify() {
  const st = STATE.rectify;
  if (!st || !st.result) return;
  const blob = b64ToBlob(st.result.base64, st.result.mime);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = _imgToolCfg().file; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function renderRectifyModal() {
  const st = STATE.rectify;
  if (!st || !st.open) return '';
  const cfg = _imgToolCfg();
  const hasOrig = !!st.origUrl;
  const hasResult = !!(st.result && st.result.base64);
  return `
    <div data-rectify-bg style="position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:6000;display:flex;align-items:center;justify-content:center;padding:16px">
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--r-md);width:min(760px,96vw);max-height:92vh;overflow:auto;padding:var(--s-4)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--s-3)">
          <h2 style="margin:0;font-size:16px">${cfg.icon} ${cfg.title} <span style="color:var(--fg-mute);font-size:12px;font-weight:400">· ${cfg.sub}</span></h2>
          <button class="btn btn-ghost" data-rectify-close style="padding:4px 10px">✕</button>
        </div>
        ${!hasOrig ? `
          <label style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;border:2px dashed var(--border);border-radius:var(--r-sm);padding:38px 16px;cursor:pointer;color:var(--fg-mute);text-align:center">
            <div style="font-size:30px">${cfg.zoneIcon}</div>
            <div style="font-size:13px">${cfg.zoneHint}</div>
            <div style="font-size:11px;opacity:.7">${cfg.zoneSub}</div>
            <input type="file" id="rectify-file" accept="image/*" style="display:none">
          </label>
        ` : `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start">
            <div>
              <div style="font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">Original</div>
              <img src="${st.origUrl}" style="width:100%;border-radius:var(--r-sm);border:1px solid var(--border);display:block">
            </div>
            <div>
              <div style="font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">${cfg.resultLabel}</div>
              ${hasResult
                ? `<img src="data:${st.result.mime};base64,${st.result.base64}" style="width:100%;border-radius:var(--r-sm);border:1px solid var(--accent-cyan);display:block">`
                : `<div style="width:100%;aspect-ratio:1/1;border-radius:var(--r-sm);border:1px dashed var(--border);display:flex;align-items:center;justify-content:center;color:var(--fg-mute);font-size:12px;text-align:center;padding:12px">${st.loading ? cfg.loadingMsg : 'Apretá el botón para generarla'}</div>`}
            </div>
          </div>
          <div style="margin-top:var(--s-3)">
            <label style="font-size:11px;color:var(--fg-subtle);display:block;margin-bottom:4px">Aclaración extra para la IA (opcional)</label>
            <textarea id="rectify-notes" rows="2" placeholder="Ej: mantené el corazón tal cual, no cambies los colores…" style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px;color:var(--fg);font-family:inherit;font-size:12px;resize:vertical">${escapeHtml(st.notes || '')}</textarea>
          </div>
          ${st.error ? `<div style="margin-top:10px;color:#FF6B7A;font-size:12px">⚠ ${escapeHtml(st.error)}</div>` : ''}
          <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:var(--s-3)">
            <button class="btn btn-ghost" data-rectify-reset ${st.loading ? 'disabled' : ''}>${cfg.resetLabel}</button>
            ${hasResult ? `<button class="btn btn-ghost" data-rectify-download>⬇ Descargar</button>` : ''}
            <button class="btn btn-cyan" data-rectify-go ${st.loading ? 'disabled' : ''}>${st.loading ? cfg.going : (hasResult ? cfg.again : cfg.go)}</button>
          </div>
        `}
      </div>
    </div>`;
}
// ============ Montaje / Mockup: cartel montado sobre la foto del local ============
// Herramienta del diseñador + admin: 2 imágenes (foto del local marcada con un
// recuadro + render del cartel) -> Gemini compone un montaje hiperrealista (sin el
// cable 220v). El recuadro (posición + tamaño) lo dibuja el usuario sobre la foto.
let _mockupRect = null;  // marca en coords NATURALES de la foto del local {nx,ny,nw,nh}
function _ensureMockupListeners() {
  if (window._mockupBound) return;
  window._mockupBound = true;
  document.addEventListener('change', (e) => {
    if (!e.target) return;
    if (e.target.id === 'mockup-canvas-file') _mockupPickCanvas(e.target.files && e.target.files[0]);
    if (e.target.id === 'mockup-render-file') _mockupPickRender(e.target.files && e.target.files[0]);
    if (e.target.id === 'mockup-notes' && STATE.mockup) STATE.mockup.notes = e.target.value;
  });
  // Ctrl+V: llena el primer campo vacío (local, luego render).
  document.addEventListener('paste', (e) => {
    const m = STATE.mockup;
    if (!m || !m.open) return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    let file = null;
    for (const it of items) { if (it.kind === 'file' && (it.type || '').startsWith('image/')) { file = it.getAsFile(); break; } }
    if (!file) return;
    e.preventDefault();
    if (!m.canvasUrl) _mockupPickCanvas(file);
    else if (!m.renderUrl) _mockupPickRender(file);
    else _mockupPickCanvas(file);
  });
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.matches && t.matches('[data-mockup-bg]')) return closeMockupModal();
    if (t.closest('[data-mockup-close]')) return closeMockupModal();
    if (t.closest('[data-mockup-clearmark]')) { _mockupRect = null; const cv = document.getElementById('mockup-draw'); if (cv) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); return; }
    if (t.closest('[data-mockup-go]')) return doMockup();
    if (t.closest('[data-mockup-download]')) return downloadMockup();
    if (t.closest('[data-mockup-reset]')) { if (STATE.mockup) { STATE.mockup.result = null; STATE.mockup.error = ''; } return render(); }
  });
}
function openMockupModal() {
  _ensureMockupListeners();
  STATE.mockup = { open: true, canvasUrl: '', canvasFile: null, renderUrl: '', renderFile: null, result: null, loading: false, error: '' };
  _mockupRect = null;
  render();
}
function closeMockupModal() { if (STATE.mockup) STATE.mockup.open = false; render(); }
function _mockupPickCanvas(file) {
  if (!file || !/^image\//.test(file.type || '')) { toast('Elegí una imagen'); return; }
  if (file.size > 12 * 1024 * 1024) { toast('La imagen es muy grande (máx 12 MB)'); return; }
  const fr = new FileReader();
  fr.onload = () => { STATE.mockup = { ...(STATE.mockup || {}), open: true, canvasUrl: fr.result, canvasFile: file, result: null, error: '' }; _mockupRect = null; render(); };
  fr.readAsDataURL(file);
}
function _mockupPickRender(file) {
  if (!file || !/^image\//.test(file.type || '')) { toast('Elegí una imagen'); return; }
  if (file.size > 12 * 1024 * 1024) { toast('La imagen es muy grande (máx 12 MB)'); return; }
  const fr = new FileReader();
  fr.onload = () => { STATE.mockup = { ...(STATE.mockup || {}), open: true, renderUrl: fr.result, renderFile: file, result: null, error: '' }; render(); };
  fr.readAsDataURL(file);
}
function _mockupDrawRect(cv, x, y, w, h) {
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.lineWidth = Math.max(2, Math.round(cv.width / 220));
  ctx.strokeStyle = '#FF3DAE';
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = 'rgba(255,61,174,0.12)';
  ctx.fillRect(x, y, w, h);
}
// Se llama tras cada render: dimensiona el canvas de dibujo al tamaño mostrado de la
// foto, redibuja la marca guardada y (re)bindea los eventos de dibujo del recuadro.
function bindMockupCanvas() {
  const m = STATE.mockup;
  if (!m || !m.open || !m.canvasUrl) return;
  const img = document.getElementById('mockup-canvas-img');
  const cv = document.getElementById('mockup-draw');
  if (!img || !cv) return;
  const fit = () => {
    const w = img.clientWidth, h = img.clientHeight;
    if (!w || !h) return;
    cv.width = w; cv.height = h; cv.style.width = w + 'px'; cv.style.height = h + 'px';
    if (_mockupRect && img.naturalWidth) {
      const s = w / img.naturalWidth;
      _mockupDrawRect(cv, _mockupRect.nx * s, _mockupRect.ny * s, _mockupRect.nw * s, _mockupRect.nh * s);
    }
  };
  if (img.complete && img.naturalWidth) fit(); else img.onload = fit;
  setTimeout(fit, 40);  // red de seguridad: redibuja la marca cuando el layout ya midió el ancho
  let drawing = false, sx = 0, sy = 0;
  const P = (e) => {
    const r = cv.getBoundingClientRect();
    const cx = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX) - r.left;
    const cy = (e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY) - r.top;
    return { x: Math.max(0, Math.min(cv.width, cx)), y: Math.max(0, Math.min(cv.height, cy)) };
  };
  cv.onpointerdown = (e) => { e.preventDefault(); drawing = true; const p = P(e); sx = p.x; sy = p.y; try { cv.setPointerCapture(e.pointerId); } catch (_) {} };
  cv.onpointermove = (e) => { if (!drawing) return; const p = P(e); _mockupDrawRect(cv, Math.min(sx, p.x), Math.min(sy, p.y), Math.abs(p.x - sx), Math.abs(p.y - sy)); };
  cv.onpointerup = (e) => {
    if (!drawing) return; drawing = false;
    const p = P(e);
    const x = Math.min(sx, p.x), y = Math.min(sy, p.y), w = Math.abs(p.x - sx), h = Math.abs(p.y - sy);
    if (w < 8 || h < 8) { _mockupRect = null; cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); return; }
    const s = img.naturalWidth / cv.width;
    _mockupRect = { nx: x * s, ny: y * s, nw: w * s, nh: h * s };
    _mockupDrawRect(cv, x, y, w, h);
  };
}
function _fileToB64(file) {
  return new Promise((resolve) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result).split(',')[1] || ''); fr.readAsDataURL(file); });
}
async function doMockup() {
  const m = STATE.mockup;
  if (!m || m.loading) return;
  if (!m.canvasFile) { toast('Subí la foto del local (paso 1)'); return; }
  if (!_mockupRect) { toast('Marcá con el recuadro dónde va el cartel'); return; }
  if (!m.renderFile) { toast('Subí el render del cartel (paso 2)'); return; }
  const img = document.getElementById('mockup-canvas-img');
  if (!img || !img.naturalWidth) { toast('Esperá a que cargue la foto del local'); return; }
  // Componer la foto del local + el recuadro (a resolución natural) -> base64.
  const off = document.createElement('canvas');
  off.width = img.naturalWidth; off.height = img.naturalHeight;
  const ctx = off.getContext('2d');
  ctx.drawImage(img, 0, 0);
  ctx.lineWidth = Math.max(3, Math.round(off.width / 150));
  ctx.strokeStyle = '#FF3DAE';
  ctx.strokeRect(_mockupRect.nx, _mockupRect.ny, _mockupRect.nw, _mockupRect.nh);
  const canvasB64 = off.toDataURL('image/png').split(',')[1];
  const renderB64 = await _fileToB64(m.renderFile);
  const _notes = ((document.getElementById('mockup-notes') || {}).value || m.notes || '').trim();
  m.loading = true; m.error = ''; render();
  try {
    const resp = await fetch(CONFIG.trackerUrl + '/admin/img-mockup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ canvas: canvasB64, canvasMime: 'image/png', render: renderB64, renderMime: (m.renderFile.type || 'image/png'), notes: _notes.slice(0, 600) })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) m.error = data.error || ('HTTP ' + resp.status);
    else m.result = { base64: data.base64, mime: data.mime || 'image/png' };
  } catch (e) {
    m.error = 'Error de red: ' + (e.message || e);
  } finally {
    m.loading = false; render();
  }
}
function downloadMockup() {
  const m = STATE.mockup;
  if (!m || !m.result) return;
  const blob = b64ToBlob(m.result.base64, m.result.mime);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'montaje.png'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function renderMockupModal() {
  const m = STATE.mockup;
  if (!m || !m.open) return '';
  const dz = (id, label, sub) => `<label style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;border:2px dashed var(--border);border-radius:var(--r-sm);padding:26px 12px;cursor:pointer;color:var(--fg-mute);text-align:center;min-height:150px">
        <div style="font-size:24px">📷</div><div style="font-size:12px">${label}</div><div style="font-size:10px;opacity:.7">${sub}</div>
        <input type="file" id="${id}" accept="image/*" style="display:none"></label>`;
  const hasResult = !!(m.result && m.result.base64);
  return `
    <div data-mockup-bg style="position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:6000;display:flex;align-items:center;justify-content:center;padding:16px">
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--r-md);width:min(920px,96vw);max-height:92vh;overflow:auto;padding:var(--s-4)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--s-3)">
          <h2 style="margin:0;font-size:16px">🏠 Montaje en el local <span style="color:var(--fg-mute);font-size:12px;font-weight:400">· mirá cómo queda el cartel puesto</span></h2>
          <button class="btn btn-ghost" data-mockup-close style="padding:4px 10px">✕</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start">
          <div>
            <div style="font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">1 · Lugar (marcá dónde va)</div>
            ${m.canvasUrl ? `
              <div style="position:relative;display:inline-block;max-width:100%;line-height:0">
                <img id="mockup-canvas-img" src="${m.canvasUrl}" style="max-width:100%;display:block;border-radius:var(--r-sm);border:1px solid var(--border)">
                <canvas id="mockup-draw" style="position:absolute;left:0;top:0;cursor:crosshair;touch-action:none"></canvas>
              </div>
              <div style="font-size:11px;color:var(--fg-mute);margin-top:5px">✏️ Arrastrá para marcar el recuadro donde va el cartel</div>
            ` : dz('mockup-canvas-file', 'Foto del frente / local', 'subí o pegá con Ctrl+V')}
          </div>
          <div>
            <div style="font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">2 · Render del cartel (solo)</div>
            ${m.renderUrl
              ? `<img src="${m.renderUrl}" style="max-width:100%;display:block;border-radius:var(--r-sm);border:1px solid var(--border)">`
              : dz('mockup-render-file', 'Render del cartel', 'subí o pegá con Ctrl+V')}
          </div>
        </div>
        <div style="margin-top:var(--s-3)">
          <label style="font-size:11px;color:var(--fg-subtle);display:block;margin-bottom:4px">Aclaración extra para la IA (opcional)</label>
          <textarea id="mockup-notes" rows="2" placeholder="Ej: ponelo un poco más arriba, luz más cálida, sin reflejos en el vidrio…" style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px;color:var(--fg);font-family:inherit;font-size:12px;resize:vertical">${escapeHtml(m.notes || '')}</textarea>
        </div>
        ${m.error ? `<div style="margin-top:10px;color:#FF6B7A;font-size:12px">⚠ ${escapeHtml(m.error)}</div>` : ''}
        <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:var(--s-3)">
          ${m.canvasUrl ? `<button class="btn btn-ghost" data-mockup-clearmark ${m.loading ? 'disabled' : ''}>Borrar marca</button>` : ''}
          <button class="btn btn-cyan" data-mockup-go ${m.loading ? 'disabled' : ''}>${m.loading ? '⏳ Montando… (15-30s)' : '✨ Generar montaje'}</button>
        </div>
        ${hasResult ? `
          <div style="margin-top:var(--s-4);border-top:1px solid var(--border);padding-top:var(--s-3)">
            <div style="font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">3 · Montaje hiperrealista</div>
            <img src="data:${m.result.mime};base64,${m.result.base64}" style="max-width:100%;display:block;border-radius:var(--r-sm);border:1px solid var(--accent-cyan)">
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
              <button class="btn btn-ghost" data-mockup-reset>↺ Otro</button>
              <button class="btn btn-ghost" data-mockup-download>⬇ Descargar</button>
            </div>
          </div>
        ` : ''}
      </div>
    </div>`;
}
function renderCorpPopup() {
  const id = STATE.corpPopupBrief; if (!id) return '';
  const brief = STATE.briefs.find(b => b.id === id); if (!brief) return '';
  let cj = {}; try { cj = JSON.parse(brief.corporea_json || '{}') || {}; } catch (e) {}
  const texto = STATE.corpPopupText != null ? STATE.corpPopupText : corpPresupuestoTexto(brief, cj);
  const noTel = !String(brief.cliente_wa_id || '').replace(/\D/g, '');
  const sending = !!STATE.briefsEnviando[id];
  const caso = corporeaCaso({ con_luz: cj.con_luz === false ? '0' : '1', frente_acabado: cj.frente_acabado, lat_acabado: cj.lat_acabado, esp_acabado: cj.esp_acabado });
  const luz = cj.con_luz === false ? 'sin luz' : 'con luz';
  const mat = cj.frente_material === 'acrilico' ? 'acrílico' : 'impreso';
  const m2 = (typeof cj.m2 === 'number') ? cj.m2.toFixed(2) : '';
  return `
    <div data-corp-popup-bg style="position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:200;display:flex;align-items:center;justify-content:center;padding:var(--s-4)">
      <div style="background:var(--bg, #0A0A0F);border:1px solid var(--accent-cyan);border-radius:var(--r-md);max-width:560px;width:100%;max-height:90vh;overflow-y:auto;padding:var(--s-4)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--s-3);border-bottom:1px solid var(--border);padding-bottom:var(--s-2)">
          <h2 style="margin:0;font-size:16px;color:var(--accent-cyan)">💰 Cotizar y enviar</h2>
          <button class="btn btn-ghost btn-icon" data-corp-popup-close aria-label="Cerrar">✕</button>
        </div>
        <div style="font-size:12px;color:var(--fg-subtle);margin-bottom:var(--s-3)">
          <b>${escapeHtml(brief.cliente_nombre || 'Sin título')}</b> · ${cj.ancho_cm || '?'}×${cj.alto_cm || '?'} cm${m2 ? ' · ' + m2 + ' m²' : ''} · corpórea · caso ${caso} · ${luz} · frente ${mat}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-family:ui-monospace,monospace;font-size:14px;margin-bottom:var(--s-3);background:rgba(143,212,222,.04);padding:var(--s-3);border-radius:var(--r-sm)">
          <div><span style="color:var(--fg-subtle);font-size:11px">Comisión Joaco 3%</span><br><b>${fmtMoney(Math.round((brief.precio_final || 0) * 0.03))}</b></div>
          ${isAdmin() ? `<div><span style="color:var(--fg-subtle);font-size:11px">Costo · margen</span><br><b>${fmtMoney(cj.costo || 0)} · ×${cj.margen || ''}</b></div>` : '<div></div>'}
          <div style="grid-column:1 / -1"><span style="color:var(--fg-subtle);font-size:11px">Precio final</span><br><b style="color:var(--accent-cyan);font-size:18px">${fmtMoney(brief.precio_final || 0)}</b></div>
        </div>
        ${isAdmin() ? `
        <div style="font-size:12px;background:rgba(255,255,255,.02);border:1px dashed var(--border);border-radius:var(--r-sm);padding:var(--s-3);margin-bottom:var(--s-3)">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--accent-cyan);margin-bottom:6px">🔒 Desglose de costos · solo admin</div>
          <table style="width:100%;font-family:ui-monospace,monospace;font-size:12px;color:var(--fg-subtle)">
            <tr><td>Superficie</td><td style="text-align:right;color:var(--fg)">${cj.ancho_cm || '?'}×${cj.alto_cm || '?'} cm = <b>${m2 || '?'} m²</b></td></tr>
            <tr><td>Costo/m² (${mat}, ${luz})</td><td style="text-align:right;color:var(--fg)">${fmtMoney(cj.costo_m2 || 0)}</td></tr>
            <tr><td>Costo base (m² × costo/m²)</td><td style="text-align:right;color:var(--fg)">${fmtMoney(cj.costo || 0)}</td></tr>
            <tr><td>Margen por superficie</td><td style="text-align:right;color:var(--fg)">×${cj.margen || '?'}</td></tr>
            <tr style="border-top:1px solid var(--border)"><td style="padding-top:5px">Precio final (costo × margen)</td><td style="text-align:right;padding-top:5px"><b style="color:var(--accent-cyan)">${fmtMoney(brief.precio_final || 0)}</b></td></tr>
            <tr><td>Comisión Joaco (3% — es costo)</td><td style="text-align:right;color:var(--fg)">${fmtMoney(Math.round((brief.precio_final || 0) * 0.03))}</td></tr>
            <tr style="border-top:1px solid var(--border)"><td style="padding-top:5px"><b>Ganancia neta</b> (precio − costo − comisión)</td><td style="text-align:right;padding-top:5px;color:#4ade80"><b>${fmtMoney((brief.precio_final || 0) - (cj.costo || 0) - Math.round((brief.precio_final || 0) * 0.03))}</b></td></tr>
          </table>
          <div style="font-size:10px;color:var(--fg-mute);margin-top:6px">Margen: ≤2 m² ×2 · 2–5 m² ×1.75 · +5 m² ×1.5 · costo/m²: impreso 320k / acrílico 400k (con luz), 200k / 300k (sin luz)</div>
        </div>
        ` : ''}
        <label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px;text-transform:uppercase;letter-spacing:.06em">Texto del presupuesto</label>
        <textarea id="corp-popup-text" rows="12" style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:10px;color:var(--fg);font-family:inherit;font-size:13px;resize:vertical;margin-bottom:var(--s-3)">${escapeHtml(texto)}</textarea>
        <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
          <button class="btn btn-ghost" data-corp-popup-copy>📋 Copiar</button>
          <button class="btn btn-cyan" data-corp-popup-send ${(sending || noTel) ? 'disabled' : ''} ${noTel ? 'title="Falta el teléfono del cliente (obligatorio para WhatsApp)"' : ''}>${sending ? '⏳ Enviando…' : '📤 Enviar por WhatsApp'}</button>
        </div>
      </div>
    </div>`;
}
// Fallback fuera de la ventana de 24 h: igual que en neón (enviarPresupuestoComoPlantilla),
// manda el presupuesto como PLANTILLA aprobada (presupuesto_corporea, 7 variables).
// El render NO va acá — se manda cuando el cliente responde y se reabre la ventana.
async function enviarPresupuestoCorporeaComoPlantilla(tel, brief, cj, renderKey) {
  const f = corpPresupuestoFields(brief, cj);
  // Meta no acepta variables vacías: default para los campos que puedan venir sin dato.
  const nombre = (f.nombre || '').trim() || 'tu trabajo';
  const medidas = (f.medidas || '').trim() || 'a confirmar';
  const _pp = STATE.privacy; STATE.privacy = false;
  const precio = fmtMoney(f.precio);
  const params = [nombre, medidas, f.frente, f.laterales, f.fondo, f.iluminacion, precio];
  STATE.privacy = _pp;
  const useImg = !!renderKey;
  const ok = await showConfirm(
    `La ventana de 24 h está cerrada, así que el presupuesto va como PLANTILLA aprobada${useImg ? ' CON el render' : ' (texto, sin el render — eso se manda cuando el cliente responda y se reabra la ventana)'}.\n\n` +
    `Trabajo: ${nombre}\nMedidas: ${medidas}\nPrecio: ${precio}\n\n¿Lo mando?`,
    { title: 'Enviar como plantilla', confirmLabel: '📤 Mandar plantilla', cancelLabel: 'Cancelar' }
  );
  if (!ok) return { ok: false, cancelled: true };
  const post = (name, withImg) => fetch(CONFIG.trackerUrl + '/admin/wa/template', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ to: tel, name, lang: 'es', params, header_image_key: withImg ? renderKey : undefined })
  });
  try {
    let tr = await post(useImg ? 'presupuesto_corporea_img' : 'presupuesto_corporea', useImg);
    let tj = await tr.json().catch(() => ({}));
    // Si la plantilla CON imagen todavía no está aprobada por Meta, caemos a la de texto.
    if (!tr.ok && useImg) { tr = await post('presupuesto_corporea', false); tj = await tr.json().catch(() => ({})); }
    if (!tr.ok) return { ok: false, error: 'No se pudo mandar la plantilla: ' + (tj.error || ('HTTP ' + tr.status)) };
    return { ok: true, wamid: tj.id || '' };
  } catch (e) {
    return { ok: false, error: 'Error de red al mandar la plantilla' };
  }
}
async function enviarCorporeaPresupuesto(briefId, textOverride) {
  const brief = STATE.briefs.find(b => b.id === briefId);
  if (!brief || STATE.briefsEnviando[briefId]) return;
  const tel = String(brief.cliente_wa_id || '').replace(/\D/g, '');
  if (!tel) { toast('Falta el teléfono del cliente para enviar por WhatsApp'); return; }
  let cj = {}; try { cj = JSON.parse(brief.corporea_json || '{}') || {}; } catch (e) {}
  const texto = textOverride != null ? textOverride : corpPresupuestoTexto(brief, cj);
  STATE.briefsEnviando[briefId] = true; render();
  try {
    // send-brief-presupuesto manda el RENDER del brief (si existe en R2) como foto
    // con el presupuesto de pie de foto; si no hay render, manda solo el texto.
    // Antes esto usaba /admin/wa/send con solo {body} → NUNCA adjuntaba la imagen.
    const res = await fetch(`${CONFIG.trackerUrl}/admin/wa/send-brief-presupuesto`, {
      method: 'POST', headers: { Authorization: `Bearer ${STATE.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ brief_id: briefId, to: tel, caption: texto })
    });
    const data = await res.json().catch(() => ({}));
    let viaPlantilla = false;
    if (!res.ok) {
      // Ventana de 24 h cerrada: Meta rechaza foto/texto libre. Igual que en neón,
      // mandamos el presupuesto como PLANTILLA aprobada (presupuesto_corporea) y
      // seguimos al guardado en Sheet + marcado de enviado. El render se manda cuando
      // el cliente responda y se reabra la ventana.
      if (res.status === 409 || data.window_closed) {
        const sent = await enviarPresupuestoCorporeaComoPlantilla(tel, brief, cj, data.render_key);
        if (!sent.ok) {
          if (!sent.cancelled) toast(sent.error || 'No se pudo mandar la plantilla');
          return;
        }
        viaPlantilla = true;
      } else {
        throw new Error(data.error || ('HTTP ' + res.status));
      }
    }
    // Guardar la corpórea en el Sheet de presupuestos (hoja del año) como una fila
    // más, con tipo='CORP' (marca de producto que la distingue del INT/EXT de neón).
    // Así entra a facturación + seguimientos; el sheet_row que devuelve se persiste
    // en el brief → el aviso "no encontramos presupuesto en el Sheet" desaparece.
    let sheetRow = null;
    if (CONFIG.appsScriptUrl) {
      try {
        const sresp = await fetch(CONFIG.appsScriptUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },  // text/plain evita el preflight CORS
          body: JSON.stringify({
            cliente: brief.cliente_nombre || '',
            alto: cj.alto_cm || 0, ancho: cj.ancho_cm || 0,
            neon: 0, tramos: 0, tipo: 'CORP', m2: cj.m2 || 0,
            trans: brief.precio_final || 0, negro: 0, reventa: 0,
            descuento: 0, recargo: 0,
            telefono: tel, canal: 'WPP',
            comision: Math.round((brief.precio_final || 0) * 0.03),
            cf: cj.costo || 0, margen: cj.margen || 0, densidad: 0,
            precio_nuevo: brief.precio_final || 0, precio_viejo: brief.precio_final || 0
          })
        });
        const sd = await sresp.json().catch(() => ({}));
        if (sd && sd.ok && sd.row) sheetRow = sd.row;
      } catch (e) { console.warn('No se pudo guardar la corpórea en el Sheet:', e); }
    }
    if (sheetRow) { try { await saveBrief({ id: briefId, sheet_row: sheetRow }); } catch (e) {} }

    const updated = await marcarBriefEnviado(briefId, { precio_final: brief.precio_final });
    const i = STATE.briefs.findIndex(b => b.id === updated.id);
    if (i >= 0) STATE.briefs[i] = updated;
    STATE.corpPopupBrief = null;
    const okMsg = viaPlantilla
      ? (sheetRow ? 'Presupuesto enviado como plantilla ✓' : 'Plantilla enviada ✓ · ⚠ no se guardó en el Sheet')
      : (sheetRow ? '✓ Presupuesto enviado' : '✓ Enviado · ⚠ no se pudo guardar en el Sheet');
    toast(okMsg);
  } catch (e) {
    toast('No se pudo enviar: ' + (e.message || e));
  } finally {
    STATE.briefsEnviando[briefId] = false; render();
  }
}
document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (t.closest && t.closest('#corp-ver-presupuesto') && STATE.briefSelected) { openCorpPopup(STATE.briefSelected); return; }
  if (t.closest && t.closest('[data-corp-popup-close]')) { closeCorpPopup(); return; }
  if (t.matches && t.matches('[data-corp-popup-bg]')) { closeCorpPopup(); return; }
  if (t.closest && t.closest('[data-corp-popup-copy]')) { const ta = document.getElementById('corp-popup-text'); if (ta) { try { navigator.clipboard.writeText(ta.value); } catch(e){ ta.select(); document.execCommand('copy'); } toast('Copiado'); } return; }
  if (t.closest && t.closest('[data-corp-popup-send]')) { const ta = document.getElementById('corp-popup-text'); if (ta && STATE.corpPopupBrief) enviarCorporeaPresupuesto(STATE.corpPopupBrief, ta.value); return; }
});
function renderCorporeaPrice() {
  const f = STATE.corporeaForm;
  const valid = +f.ancho > 0 && +f.alto > 0;
  if (!valid) return '<div class="muted" style="margin-top:var(--s-3);font-size:12px">Completá ancho y alto para ver el precio</div>';
  const r = calcCorporea(f);
  const caso = corporeaCaso(f);
  const adminInfo = isAdmin() ? `<div class="muted" style="font-size:11px;margin-top:6px">Costo/m² ${fmtMoney(r.costoM2)} · Costo ${fmtMoney(r.costo)} · Margen ×${r.margen}</div>` : '';
  return `
    <div class="cot-results" style="margin-top:var(--s-3)">
      <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap">
        <div>
          <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.06em">Precio final</div>
          <div style="font-size:26px;font-weight:600;color:var(--cyan,#3ad)">${fmtMoney(r.precio)}</div>
        </div>
        <div style="text-align:right" class="muted">
          <div style="font-size:12px">${r.m2.toLocaleString('es-AR',{maximumFractionDigits:2})} m² · caso ${caso}</div>
        </div>
      </div>
      ${adminInfo}
      <div style="margin-top:var(--s-3);display:flex;gap:var(--s-2);justify-content:flex-end">
        <button class="btn btn-cyan" id="corp-create-btn" ${STATE.corpCreating?'disabled':''}>${STATE.corpCreating?'Creando…':'Crear brief + render'}</button>
      </div>
    </div>
  `;
}
function renderCorpBriefCard(b) {
  let cj = {}; try { cj = JSON.parse(b.corporea_json || '{}') || {}; } catch (e) {}
  const caso = b.corporea_json ? corporeaCaso({ con_luz: cj.con_luz === false ? '0' : '1', frente_acabado: cj.frente_acabado, lat_acabado: cj.lat_acabado, esp_acabado: cj.esp_acabado }) : '?';
  return `
    <div class="card" data-corp-brief="${b.id}" style="cursor:pointer;padding:var(--s-3)">
      <div style="font-weight:600;font-size:13px;margin-bottom:4px">${escapeHtml(b.cliente_nombre || '—')}</div>
      <div class="muted" style="font-size:11px">${b.ancho_cm||'?'}×${b.alto_cm||'?'}cm · caso ${caso} · ${escapeHtml(b.estado || '')}</div>
      <div style="font-size:15px;font-weight:600;margin-top:4px;color:var(--cyan,#3ad)">${fmtMoney(b.precio_final || 0)}</div>
      ${b.render_count ? '<div class="pill" style="font-size:10px;margin-top:4px;display:inline-block">✓ render</div>' : ''}
    </div>
  `;
}
function renderCorporeas() {
  // Corpóreas = MISMO kanban que Cotización, scopeado a tipo='corporea'.
  return renderCotizacion('corporea');
}
function _corporeasFormV1_dead() {
  if (!STATE.token) {
    return `<div style="max-width:540px;margin:var(--s-6) auto;padding:var(--s-4);text-align:center"><div style="font-size:32px;margin-bottom:var(--s-2)">🔒</div><p>Iniciá sesión para ver el panel de corpóreas.</p></div>`;
  }
  const f = STATE.corporeaForm;
  const sinLuz = String(f.con_luz) === '0';
  const corpBriefs = (STATE.briefs || []).filter(b => b.tipo === 'corporea');
  const acabado = (field, val, labels) => sinLuz
    ? ` <span class="pill" style="font-size:11px;display:inline-block;margin-top:4px">opaco</span>`
    : `<select data-corp-field="${field}">
         <option value="translucido" ${String(val).startsWith('transl')?'selected':''}>${labels[0]}</option>
         <option value="opaco" ${!String(val).startsWith('transl')?'selected':''}>${labels[1]}</option>
       </select>`;
  return `
    <div style="padding:var(--s-4);min-height:100%">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--s-3)">
        <div>
          <h2 style="margin:0;font-size:18px">▣ Corpóreas</h2>
          <p class="muted" style="margin:2px 0 0;font-size:12px">Cotización de letras 3D · ${corpBriefs.length} ${corpBriefs.length===1?'brief':'briefs'}</p>
        </div>
      </div>
      <div class="card cot-card" style="margin-bottom:var(--s-4)">
        <div class="card-h"><h3>Nueva corpórea</h3></div>
        <div class="cot-grid">
          <label>Cliente / diseño<input type="text" data-corp-field="cliente" value="${escapeHtml(f.cliente)}" placeholder="nombre del cliente"></label>
          <label>Teléfono<input type="tel" data-corp-field="telefono" value="${escapeHtml(f.telefono)}" placeholder="para el presupuesto"></label>
          <label>Ancho (cm)<input type="number" min="0" step="1" data-corp-field="ancho" value="${escapeHtml(f.ancho)}"></label>
          <label>Alto (cm)<input type="number" min="0" step="1" data-corp-field="alto" value="${escapeHtml(f.alto)}"></label>
          <label>Iluminación
            <select data-corp-field="con_luz" data-corp-render="1">
              <option value="1" ${!sinLuz?'selected':''}>Con luz</option>
              <option value="0" ${sinLuz?'selected':''}>Sin luz</option>
            </select>
          </label>
        </div>
        <div style="font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em;margin-top:var(--s-3)">Frente</div>
        <div class="cot-grid" style="margin-top:var(--s-1)">
          <label>Material
            <select data-corp-field="frente_material">
              <option value="impreso" ${f.frente_material!=='acrilico'?'selected':''}>Impreso</option>
              <option value="acrilico" ${f.frente_material==='acrilico'?'selected':''}>Acrílico</option>
            </select>
          </label>
          <label>Acabado${acabado('frente_acabado', f.frente_acabado, ['Translúcido','Opaco'])}</label>
          <label>Color<input type="color" data-corp-field="frente_color" value="${escapeHtml(f.frente_color||'#ffffff')}" style="height:34px;padding:2px"></label>
        </div>
        <div style="font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em;margin-top:var(--s-3)">Laterales</div>
        <div class="cot-grid" style="margin-top:var(--s-1)">
          <label>Acabado${acabado('lat_acabado', f.lat_acabado, ['Translúcido','Opaco'])}</label>
          <label>Color<input type="color" data-corp-field="lat_color" value="${escapeHtml(f.lat_color||'#ffffff')}" style="height:34px;padding:2px"></label>
        </div>
        <div style="font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em;margin-top:var(--s-3)">Espalda</div>
        <div class="cot-grid" style="margin-top:var(--s-1)">
          <label>Acabado${acabado('esp_acabado', f.esp_acabado, ['Translúcida','Opaca'])}</label>
          <label>Color<input type="color" data-corp-field="esp_color" value="${escapeHtml(f.esp_color||'#ffffff')}" style="height:34px;padding:2px"></label>
        </div>
        <div id="corp-price-slot">${renderCorporeaPrice()}</div>
      </div>
      <div style="font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em;margin-bottom:var(--s-2)">Briefs de corpóreas</div>
      ${corpBriefs.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:var(--s-2)">${corpBriefs.map(renderCorpBriefCard).join('')}</div>` : '<div class="muted" style="font-size:12px">Todavía no hay corpóreas cotizadas. Completá el form de arriba y dale a "Crear brief".</div>'}
    </div>
  `;
}
function updateCorpPrice() {
  const slot = document.getElementById('corp-price-slot');
  if (slot) { slot.innerHTML = renderCorporeaPrice(); bindCorpCreateBtn(); }
}
function bindCorpCreateBtn() {
  const b = document.getElementById('corp-create-btn');
  if (b) b.onclick = createCorporeaBrief;
}
function bindCorporeas() {
  // Reusa el binding del kanban (mismos IDs). briefProducto ya quedó en 'corporea'
  // porque renderCorporeas llamó a renderCotizacion('corporea').
  bindCotizacion();
}
function _bindCorporeasV1_dead() {
  if (!STATE.token) return;
  if (!STATE.briefsLoaded && !STATE.briefsLoading && !STATE.briefsError) {
    fetchBriefs().then(() => render());
  }
  document.querySelectorAll('[data-corp-field]').forEach(el => {
    const field = el.dataset.corpField;
    const isRender = el.dataset.corpRender === '1';
    const handler = () => {
      STATE.corporeaForm[field] = el.value;
      if (isRender) render(); else updateCorpPrice();
    };
    el.oninput = handler;
    el.onchange = handler;
  });
  bindCorpCreateBtn();
  document.querySelectorAll('[data-corp-brief]').forEach(el => {
    el.onclick = () => openCorporeaInDrawer(parseInt(el.dataset.corpBrief, 10));
  });
}
function openCorporeaInDrawer(id) {
  // El drawer de briefs vive y se bindea en la vista Cotización — abrimos ahí
  // (es agnóstico al tipo: muestra imágenes + botón de render, que el worker
  // resuelve con el prompt de corpóreas según corporea_json).
  setView('cotizacion');
  openBriefDrawer(id);
}
async function createCorporeaBrief() {
  const f = STATE.corporeaForm;
  if (!(+f.ancho > 0 && +f.alto > 0)) { toast('Completá ancho y alto'); return; }
  const r = calcCorporea(f);
  const sinLuz = String(f.con_luz) === '0';
  const cj = {
    frente_material: f.frente_material === 'acrilico' ? 'acrilico' : 'impreso',
    con_luz: !sinLuz,
    frente_acabado: sinLuz ? 'opaco' : f.frente_acabado,
    frente_color: f.frente_color,
    lat_acabado: sinLuz ? 'opaco' : f.lat_acabado,
    lat_color: f.lat_color,
    esp_acabado: sinLuz ? 'opaca' : f.esp_acabado,
    esp_color: f.esp_color,
    ancho_cm: +f.ancho, alto_cm: +f.alto, m2: r.m2,
    costo_m2: r.costoM2, margen: r.margen, costo: r.costo, precio: r.precio
  };
  STATE.corpCreating = true; updateCorpPrice();
  try {
    const body = {
      tipo: 'corporea', cliente_nombre: f.cliente || 'Corpórea', origen_lead: 'wpp',
      cliente_wa_id: (f.telefono || '').replace(/\D/g, ''),
      estado: 'nuevo', ancho_cm: +f.ancho, alto_cm: +f.alto, m2: r.m2,
      precio_final: r.precio, corporea_json: JSON.stringify(cj)
    };
    const res = await fetch(`${CONFIG.trackerUrl}/admin/briefs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${STATE.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok || !data.brief) throw new Error(data.error || ('HTTP ' + res.status));
    STATE.briefs.unshift(data.brief);
    STATE.corporeaForm = defaultCorpForm();
    STATE.corpCreating = false;
    openCorporeaInDrawer(data.brief.id);
    toast('Corpórea creada — subí el diseño y generá el render');
  } catch (e) {
    STATE.corpCreating = false; updateCorpPrice();
    toast('No se pudo crear: ' + (e.message || e));
  }
}

function renderCotizacion(producto = 'neon') {
  briefProducto = producto;
  const esCorp = producto === 'corporea';
  // Disparar carga si no hay datos.
  if (!STATE.token) {
    return `
      <div style="max-width:540px;margin:var(--s-6) auto;padding:var(--s-4);text-align:center">
        <div style="font-size:32px;margin-bottom:var(--s-2)">🔒</div>
        <p>Iniciá sesión para ver el panel de ${esCorp ? 'corpóreas' : 'cotización'}.</p>
      </div>
    `;
  }
  const headerActions = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--s-3)">
      <div>
        <h2 style="margin:0;font-size:18px">${esCorp ? '▣ Corpóreas' : '◆ Cotización'}</h2>
        <p class="muted" style="margin:2px 0 0;font-size:12px">${canCreateBriefs() ? 'Pegá (Ctrl+V) o arrastrá imágenes sobre la columna "A cotizar" — se crea solo' : 'Tomá briefs de "A cotizar" para diseñarlos'} · ${STATE.briefs.filter(briefMatchesProducto).length} ${esCorp ? 'corpóreas' : 'total'}</p>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost" id="briefs-refresh" title="Refrescar">↻</button>
        ${(getUserRole() === 'disenador' || getUserRole() === 'admin' || getUserRole() === 'comercial') ? `<button class="btn btn-ghost" id="btn-rectify-foto" title="Enderezar la perspectiva de una foto (llevarla a vista frontal) con IA — para usarla de base de diseño">🔧 Rectificar foto</button>` : ''}
        ${(getUserRole() === 'disenador' || getUserRole() === 'admin') ? `<button class="btn btn-ghost" id="btn-vectorize" title="Convertir un logo/diseño a silueta B&N maciza de alto contraste, lista para vectorizar con el Calco de Imagen de Illustrator">⬛ Vectorizar</button>` : ''}
        ${(getUserRole() === 'disenador' || getUserRole() === 'admin' || getUserRole() === 'comercial') ? `<button class="btn btn-ghost" id="btn-mockup" title="Montar el render de un cartel sobre la foto del local del cliente para ver cómo queda puesto (montaje hiperrealista con IA)">🏠 Montaje</button>` : ''}
        ${canCotizar() ? `<button class="btn btn-ghost" id="briefs-verificar-enviados" title="Revisar los 'Listos' y 'Colgados' tipo WhatsApp contra el historial y pasar a Enviados los que ya tienen presupuesto mandado">${STATE.verificandoEnviados ? '⏳ Verificando…' : '🔍 Verificar enviados'}</button>` : ''}
        ${canCreateBriefs() ? '<button class="btn btn-cyan" id="brief-new">+ Nuevo brief</button>' : ''}
      </div>
    </div>
  `;

  if (STATE.briefsLoading && !STATE.briefs.length) {
    return `<div style="padding:var(--s-4)">${headerActions}<div class="muted" style="text-align:center;padding:var(--s-4)">Cargando briefs…</div></div>`;
  }
  if (STATE.briefsError) {
    if (STATE.briefsError === 'SESION_VENCIDA') {
      return `<div style="padding:var(--s-4)">${headerActions}<div style="padding:var(--s-3);background:rgba(255,24,48,.08);border:1px solid rgba(255,24,48,.3);border-radius:var(--r-sm);color:#FF5566"><b>Tu sesión venció en este dispositivo.</b><br><span style="font-size:12px;opacity:.85">Volvé a entrar con tu usuario y contraseña para seguir cargando presupuestos.</span><br><button class="btn" onclick="logout()" style="margin-top:12px;background:#FF1830;color:#fff;border:none;padding:9px 18px;border-radius:8px;font-weight:600">Cerrar sesión y volver a entrar</button></div></div>`;
    }
    return `<div style="padding:var(--s-4)">${headerActions}<div style="padding:var(--s-3);background:rgba(255,24,48,.08);border:1px solid rgba(255,24,48,.3);border-radius:var(--r-sm);color:#FF5566">Error: ${escapeHtml(STATE.briefsError)}<br><span style="font-size:11px;opacity:.7">¿Falta aplicar la migración 001_briefs.sql al worker?</span></div></div>`;
  }

  return `
    <div style="padding:var(--s-4);min-height:100%">
      ${headerActions}
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:var(--s-3);flex-wrap:wrap">
        <input type="text" id="brief-search" placeholder="🔍 Buscar presupuesto por cliente / diseño / teléfono…" value="${escapeHtml(briefSearch)}" autocomplete="off"
          style="flex:1;min-width:220px;max-width:440px;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:9px 12px;color:var(--fg);font-size:13px">
        <button class="btn btn-ghost" id="brief-search-clear" title="Limpiar búsqueda" style="padding:7px 11px;font-size:13px">✕</button>
        <span class="muted" style="font-size:11px">Cada coincidencia queda en la columna de su estado</span>
      </div>
      <div class="brief-kanban" style="display:flex;gap:var(--s-3);overflow-x:auto;padding-bottom:var(--s-2)">
        ${BRIEF_COLUMNAS.map(renderBriefColumn).join('')}
      </div>
      ${renderBriefDrawer()}
      ${renderBriefCotizadorPopup()}
      ${renderCorpPopup()}
      ${renderRectifyModal()}
      ${renderMockupModal()}
      ${renderImgLightbox()}
      ${renderQuickCreateModal()}
      ${renderTeamChatWidget()}
    </div>
  `;
}

// Crea brief al instante PIDIENDO TÍTULO ANTES — Joaco tiene que tipear sí o sí
// el nombre del cliente o cartel antes de que se cree el brief. Esto evita
// que queden briefs "Sin título" colgados en el board.
// Usado por el paste/drop sobre la columna "A cotizar".
// Cuando el comercial pega/dropea una imagen sobre la columna "A cotizar":
// en vez de crear el brief directo (con prompt feo), abrimos un MODAL popup
// centrado con animación, con el form de "Nuevo brief" pre-cargado con la
// imagen. Recién al confirmar se crea el brief en la DB.
async function quickCreateBriefFromImage(file) {
  if (!canCreateBriefs()) return;
  if (!file) return;
  // Convertir el archivo a {dataUrl, blob, contentType} para preview local.
  let img;
  try { img = await fileToDraftImage(file); } catch(e) { return; }
  if (STATE.quickModalOpen) {
    // Modal ya abierto: agregar la imagen al draft (permite múltiples paste/drop seguidos).
    STATE.quickModalImages.push(img);
    refreshQuickModalImages();
  } else {
    // Abrir modal por primera vez.
    STATE.quickModalImages = [img];
    STATE.quickModalOpen = true;
    STATE.quickModalSaving = false;
    STATE.quickModalOrigen = 'wpp';  // default: la mayoría llega por WhatsApp
    STATE.quickModalIntExt = null;   // sin default: Joaco DEBE elegir Interior/Exterior
    STATE.quickModalTipo = (briefProducto === 'corporea' ? 'corporea' : null);
    render();
    // Auto-focus en el input de título.
    setTimeout(() => {
      const el = document.getElementById('quick-modal-titulo');
      if (el) { el.focus(); el.select(); }
    }, 50);
  }
}

// Cancela el modal sin crear nada.
function cancelQuickCreate() {
  STATE.quickModalOpen = false;
  STATE.quickModalImages = [];
  STATE.quickModalSaving = false;
  STATE.quickModalOrigen = 'wpp';
  render();
}

// Abre el modal "Nuevo brief" VACÍO (sin imagen previa). Lo usa el botón
// "+ Nuevo brief" del kanban. Las capturas son opcionales y se suman dentro
// del modal (dropzone / paste / drag). Reemplaza al viejo drawer lateral.
function openNuevoBriefModal() {
  if (!canCreateBriefs()) return;
  STATE.quickModalImages = [];
  STATE.quickModalOpen = true;
  STATE.quickModalSaving = false;
  STATE.quickModalOrigen = 'wpp';
  STATE.quickModalUrgente = false;
  STATE.quickModalIA = false;
  STATE.quickModalPrefillPhone = '';
  STATE.quickModalTipo = (briefProducto === 'corporea' ? 'corporea' : null);
  STATE.quickModalIntExt = null;
  render();
  setTimeout(() => {
    const el = document.getElementById('quick-modal-titulo');
    if (el) el.focus();
  }, 60);
}

// Abre el modal "Nuevo brief" DESDE UN CHAT, con el teléfono y la plataforma
// (WhatsApp) ya cargados — el resto (título, medidas, notas, imágenes) lo completa
// Joaco. El brief se crea como estado 'nuevo' → le llega a Emma en "A cotizar".
// Es el MISMO modal del panel de Cotización, renderizado por encima de la conversación.
// Chooser: al tocar "Crear brief" en el chat, preguntamos si es para NEÓN o CORPÓREA
// (cada uno arma el brief con el tipo correcto). Antes siempre creaba neón.
function chooseBriefTypeFromChat() {
  if (!canCreateBriefs()) { toast('No tenés permiso para crear briefs'); return; }
  if (!chatState.selectedPhone) return;
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal" style="max-width:400px">
      <div class="modal-h"><h3>¿Qué tipo de brief?</h3></div>
      <div class="modal-body" style="display:flex;gap:12px;padding:18px">
        <button class="btn btn-cyan" id="bt-neon" style="flex:1;padding:18px 10px;font-size:14px;font-weight:700;line-height:1.5">🔤<br>Cartel de neón</button>
        <button class="btn btn-cyan" id="bt-corp" style="flex:1;padding:18px 10px;font-size:14px;font-weight:700;line-height:1.5">▣<br>Corpórea</button>
      </div>
      <div class="modal-actions"><button class="btn btn-ghost modal-cancel">Cancelar</button></div>
    </div>`;
  document.body.appendChild(bg);
  void bg.offsetWidth; bg.classList.add('open'); requestAnimationFrame(() => bg.classList.add('open'));
  const close = () => { bg.classList.remove('open'); setTimeout(() => bg.remove(), 150); };
  bg.querySelector('.modal-cancel').onclick = close;
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
  bg.querySelector('#bt-neon').onclick = () => { close(); openBriefFromChat(false); };
  bg.querySelector('#bt-corp').onclick = () => { close(); openBriefFromChat(true); };
}
function openBriefFromChat(corporea) {
  if (!canCreateBriefs()) { toast('No tenés permiso para crear briefs'); return; }
  const phone = chatState.selectedPhone;
  if (!phone) return;
  STATE.quickModalImages = [];
  STATE.quickModalOpen = true;
  STATE.quickModalSaving = false;
  STATE.quickModalOrigen = 'wpp';
  STATE.quickModalUrgente = false;
  STATE.quickModalIA = false;
  STATE.quickModalPrefillPhone = String(phone).replace(/\D/g, '');
  STATE.quickModalIntExt = null;
  STATE.quickModalTipo = corporea ? 'corporea' : null;
  render();
  setTimeout(() => {
    const el = document.getElementById('quick-modal-titulo');
    if (el) el.focus();
  }, 60);
}

// Bindea los handlers del modal "Nuevo brief" (quick-create). Extraído de
// bindCotizacion para poder reusarlo también desde el chat (botón "Crear brief"
// del header de la conversación). Idempotente; corre solo si el modal está abierto.
function bindQuickCreateModal() {
  if (!STATE.quickModalOpen) return;
  const qBackdrop = document.getElementById('quick-modal-backdrop');
  if (qBackdrop) qBackdrop.onclick = (ev) => { if (ev.target.id === 'quick-modal-backdrop') cancelQuickCreate(); };
  const qClose = document.getElementById('quick-modal-close');
  if (qClose) qClose.onclick = cancelQuickCreate;
  const qCancel = document.getElementById('quick-modal-cancel');
  if (qCancel) qCancel.onclick = cancelQuickCreate;
  const qConfirm = document.getElementById('quick-modal-confirm');
  if (qConfirm) qConfirm.onclick = confirmQuickCreate;
  // Checkbox urgente: persiste en STATE (sobrevive re-renders) + feedback visual.
  const qUrg = document.getElementById('quick-modal-urgente');
  if (qUrg) qUrg.onchange = () => {
    STATE.quickModalUrgente = qUrg.checked;
    const lbl = document.getElementById('quick-modal-urgente-lbl');
    if (lbl) {
      lbl.style.borderColor = qUrg.checked ? 'rgba(255,24,48,.5)' : 'var(--border)';
      lbl.style.background = qUrg.checked ? 'rgba(255,24,48,.08)' : 'transparent';
      const sp = lbl.querySelector('span');
      if (sp) sp.style.color = qUrg.checked ? '#ff5468' : 'var(--fg)';
    }
  };
  // Checkbox "diseñar también con IA" (persiste en STATE + feedback visual).
  const qIA = document.getElementById('quick-modal-ia');
  if (qIA) qIA.onchange = () => {
    STATE.quickModalIA = qIA.checked;
    const lbl = document.getElementById('quick-modal-ia-lbl');
    if (lbl) {
      lbl.style.borderColor = qIA.checked ? 'rgba(143,212,222,.5)' : 'var(--border)';
      lbl.style.background = qIA.checked ? 'rgba(143,212,222,.10)' : 'transparent';
      const sp = lbl.querySelector('span');
      if (sp) sp.style.color = qIA.checked ? 'var(--accent-cyan,#8FD4DE)' : 'var(--fg)';
    }
  };
  // Toggle origen WhatsApp / Instagram.
  document.querySelectorAll('[data-qm-origen]').forEach(btn => {
    btn.onclick = () => setQuickModalOrigen(btn.dataset.qmOrigen);
  });
  // Toggle Interior / Exterior (obligatorio, sin default).
  document.querySelectorAll('[data-qm-intext]').forEach(btn => {
    btn.onclick = () => setQuickModalIntExt(btn.dataset.qmIntext);
  });
  // Dropzone: click abre el selector, drop/file-input suman imágenes.
  const qDrop = document.getElementById('quick-modal-dropzone');
  const qFileInput = document.getElementById('quick-modal-file-input');
  if (qDrop && qFileInput) {
    qDrop.onclick = () => qFileInput.click();
    qDrop.ondragover = (ev) => { ev.preventDefault(); qDrop.style.borderColor = 'var(--accent-cyan)'; qDrop.style.background = 'rgba(143,212,222,.06)'; };
    qDrop.ondragleave = () => { qDrop.style.borderColor = ''; qDrop.style.background = ''; };
    qDrop.ondrop = (ev) => { ev.preventDefault(); qDrop.style.borderColor = ''; qDrop.style.background = ''; addFilesToQuickModal(ev.dataTransfer?.files); };
    qFileInput.onchange = () => { addFilesToQuickModal(qFileInput.files); qFileInput.value = ''; };
  }
  // Botones quitar imagen.
  document.querySelectorAll('[data-quick-img-remove]').forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const i = parseInt(btn.dataset.quickImgRemove, 10);
      STATE.quickModalImages.splice(i, 1);
      refreshQuickModalImages();
    };
  });
  // Enter en el título → confirmar.
  const tituloInput = document.getElementById('quick-modal-titulo');
  if (tituloInput) tituloInput.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); confirmQuickCreate(); } };
  // ESC cierra (binding global propio, una sola vez).
  if (!document._quickModalEscBound) {
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && STATE.quickModalOpen) cancelQuickCreate();
    });
    document._quickModalEscBound = true;
  }
}

// Suma archivos de imagen al modal Quick Create (desde input file o drop).
async function addFilesToQuickModal(fileList) {
  const files = Array.from(fileList || []).filter(f => f.type && f.type.startsWith('image/'));
  for (const f of files) {
    try { const img = await fileToDraftImage(f); STATE.quickModalImages.push(img); } catch (e) { /* skip */ }
  }
  refreshQuickModalImages();
}

// Setea el origen del modal Quick Create y actualiza la visibilidad del input
// teléfono sin re-renderear todo (evita perder lo que el usuario ya tipeó).
function setQuickModalOrigen(origen) {
  STATE.quickModalOrigen = origen;
  // Update visual del toggle.
  ['wpp', 'ig'].forEach(o => {
    const btn = document.getElementById('quick-modal-origen-' + o);
    if (!btn) return;
    if (o === origen) {
      btn.style.background = 'var(--accent-cyan,#8FD4DE)';
      btn.style.color = '#000';
      btn.style.borderColor = 'var(--accent-cyan,#8FD4DE)';
    } else {
      btn.style.background = 'transparent';
      btn.style.color = 'var(--fg-subtle)';
      btn.style.borderColor = 'var(--border)';
    }
  });
  // Mostrar/ocultar input teléfono.
  const wrap = document.getElementById('quick-modal-telefono-wrap');
  if (wrap) wrap.style.display = origen === 'wpp' ? '' : 'none';
}

// Setea Interior/Exterior del modal Quick Create y actualiza el toggle (sin
// re-render, para no perder lo tipeado). Arranca null: Joaco DEBE elegir.
function setQuickModalIntExt(val) {
  STATE.quickModalIntExt = val;
  ['INT', 'EXT'].forEach(o => {
    const btn = document.getElementById('quick-modal-intext-' + o);
    if (!btn) return;
    const active = (o === val);
    btn.style.background = active ? 'var(--accent-cyan,#8FD4DE)' : 'transparent';
    btn.style.color = active ? '#000' : 'var(--fg-subtle)';
    btn.style.borderColor = active ? 'var(--accent-cyan,#8FD4DE)' : 'var(--border)';
  });
}

// Lee el form, valida, crea el brief en la DB y sube todas las imágenes.
async function confirmQuickCreate() {
  if (STATE.quickModalSaving) return;
  const tEl = document.getElementById('quick-modal-titulo');
  const mEl = document.getElementById('quick-modal-medidas');
  const nEl = document.getElementById('quick-modal-notas');
  const fEl = document.getElementById('quick-modal-telefono');
  const titulo = (tEl?.value || '').trim();
  const medidas = (mEl?.value || '').trim();
  const notas   = (nEl?.value || '').trim();
  const origen  = (STATE.quickModalOrigen || 'wpp');
  const telRaw  = (fEl?.value || '').trim();
  const telDigits = telRaw.replace(/\D/g, '');
  if (titulo.length < 2) {
    if (tEl) { tEl.focus(); tEl.style.borderColor = '#FF5566'; setTimeout(() => { tEl.style.borderColor = 'var(--border)'; }, 1200); }
    return;
  }
  // Si la consulta vino por WhatsApp, el teléfono es obligatorio: lo necesitamos
  // para poder mandarle el presupuesto directo via API cuando el brief esté listo.
  // Para Instagram lo dejamos pasar vacío (Joaco le responde por DM manual).
  if (origen === 'wpp' && telDigits.length < 8) {
    if (fEl) { fEl.focus(); fEl.style.borderColor = '#FF5566'; setTimeout(() => { fEl.style.borderColor = 'var(--border)'; }, 1500); }
    alert('Si la consulta vino por WhatsApp, el teléfono es obligatorio (al menos 8 dígitos sin contar el código de país).');
    return;
  }
  // La FOTO ES OBLIGATORIA: un brief sin imagen de referencia no sirve para que
  // Emma cotice. Si no hay ninguna, frenamos y marcamos en rojo el dropzone.
  if (!STATE.quickModalImages.length) {
    const dz = document.getElementById('quick-modal-dropzone');
    if (dz) {
      dz.style.borderColor = '#FF5566';
      dz.style.color = '#FF5566';
      setTimeout(() => { dz.style.borderColor = 'var(--border)'; dz.style.color = 'var(--fg-mute)'; }, 1800);
    }
    toast('Agregá al menos una foto de referencia (Ctrl+V, arrastrá o tocá la zona de arriba)');
    return;
  }
  // Interior / Exterior OBLIGATORIO para neones (define el precio). Sin default:
  // si Joaco no eligió, frenamos y resaltamos los botones en rojo.
  const esCorpBrief = (STATE.view === 'corporeas') || STATE.quickModalTipo === 'corporea';
  if (!esCorpBrief && !STATE.quickModalIntExt) {
    ['INT', 'EXT'].forEach(o => {
      const b = document.getElementById('quick-modal-intext-' + o);
      if (b) { b.style.borderColor = '#FF5566'; setTimeout(() => { if (STATE.quickModalIntExt !== o) b.style.borderColor = 'var(--border)'; }, 1600); }
    });
    toast('Elegí si el cartel es Interior o Exterior (define el precio)');
    return;
  }
  STATE.quickModalSaving = true;
  const saveBtn = document.getElementById('quick-modal-confirm');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Creando…'; }
  try {
    const urgente = document.getElementById('quick-modal-urgente')?.checked ? 1 : 0;
    const wantIA = document.getElementById('quick-modal-ia')?.checked || false;
    const saved = await saveBrief({
      cliente_nombre: titulo,
      cliente_wa_id: origen === 'wpp' ? telDigits : '',
      origen_lead: origen,
      medidas_libre: medidas || null,
      notas: notas || null,
      estado: 'nuevo',
      tipo: (esCorpBrief ? 'corporea' : STATE.quickModalIntExt),
      urgente
    });
    STATE.briefs.unshift(saved);
    // Subir todas las imágenes pegadas. ANTES el error se tragaba (console.error) y el
    // modal cerraba como éxito → el brief quedaba SIN la foto obligatoria y Joaco lo
    // recreaba (duplicados). Ahora contamos las que subieron:
    let okImgs = 0, failImgs = 0;
    for (const img of STATE.quickModalImages) {
      try { await uploadBriefImage(saved.id, img.blob, img.contentType, 'chat'); okImgs++; } catch(e) { console.error('upload', e); failImgs++; }
    }
    if (STATE.quickModalImages.length && okImgs === 0) {
      // NINGUNA foto subió → el brief quedó sin la referencia (Emma no lo puede cotizar).
      // Avisar fuerte: el brief YA existe, hay que subirle la foto desde la bandeja, NO
      // recrearlo (eso genera los duplicados). Cerramos el modal para que no lo re-cree.
      STATE.quickModalOpen = false;
      STATE.quickModalImages = [];
      STATE.quickModalSaving = false;
      render();
      await showAlert('El brief se creó pero la FOTO no se pudo subir (revisá la conexión). Está en la bandeja "A cotizar" sin imagen: abrilo y subile la foto ahí. NO lo crees de nuevo — ya existe.', { title: '⚠ Falta subir la foto', variant: 'warn' });
      return;
    }
    if (failImgs > 0) toast(`Brief creado, pero ${failImgs} foto(s) no subieron — abrilo y revisá que estén todas.`);
    // Cerrar modal y volver al kanban. NO abrimos el drawer porque el form
    // que se completó en el modal ya tiene todos los datos del brief — abrirlo
    // sería pedir los mismos campos otra vez. El brief queda visible como
    // tarjeta nueva en la columna "A cotizar".
    STATE.quickModalOpen = false;
    STATE.quickModalImages = [];
    STATE.quickModalSaving = false;
    render();
    // Si Joaco marcó "diseñar también con IA": arranca ya, en segundo plano, con la
    // medida que pidió el cliente (no espera a Emma). Fire-and-forget (~30s).
    if (wantIA && !esCorpBrief && okImgs > 0) {
      toast('🤖 Generando diseño IA en segundo plano…');
      generarDisenioIA(saved.id);
    }
  } catch (e) {
    STATE.quickModalSaving = false;
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '✓ Crear brief'; }
    alert('Error creando brief: ' + e.message);
  }
}

// ============ Modal "Quick Create" — popup centrado con animación ============
function renderQuickCreateModal() {
  if (!STATE.quickModalOpen) return '';
  const origen = STATE.quickModalOrigen || 'wpp';
  // Helper para estilo del botón origen (activo/inactivo).
  const oBtn = (val, active) => active
    ? 'background:var(--accent-cyan,#8FD4DE);color:#000;border-color:var(--accent-cyan,#8FD4DE);'
    : 'background:transparent;color:var(--fg-subtle);border-color:var(--border);';
  return `
    <style>
      @keyframes nv-qmodal-fade { from { opacity: 0 } to { opacity: 1 } }
      @keyframes nv-qmodal-pop {
        from { opacity: 0; transform: scale(.88) translateY(8px); }
        to   { opacity: 1; transform: scale(1) translateY(0); }
      }
      .nv-qmodal-backdrop { animation: nv-qmodal-fade .18s ease-out; }
      .nv-qmodal-card { animation: nv-qmodal-pop .22s cubic-bezier(.16,1.0,.3,1) both; }
    </style>
    <div id="quick-modal-backdrop" class="nv-qmodal-backdrop" role="dialog" aria-modal="true"
      style="position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:280;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px)">
      <div id="quick-modal-card" class="nv-qmodal-card"
        style="background:var(--bg,#0A0A0F);border:1px solid var(--accent-cyan,#8FD4DE);border-radius:14px;box-shadow:0 12px 48px rgba(0,0,0,.6);max-width:520px;width:100%;max-height:90vh;overflow-y:auto;padding:var(--s-4)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--s-3);padding-bottom:var(--s-2);border-bottom:1px solid var(--border)">
          <h2 style="margin:0;font-size:16px">✨ Nuevo brief ${(STATE.view === 'corporeas' || STATE.quickModalTipo === 'corporea') ? '<span style="color:#c4a0ff;font-size:13px">· Corpórea ▣</span>' : '<span style="color:#8FD4DE;font-size:13px">· Neón</span>'}</h2>
          <button id="quick-modal-close" aria-label="Cerrar" class="btn btn-ghost btn-icon" style="font-size:16px">✕</button>
        </div>

        <!-- Preview de las imágenes (capturas del chat / referencias) -->
        <div id="quick-modal-images" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(70px,1fr));gap:6px;margin-bottom:var(--s-2)">
          ${renderQuickModalImages()}
        </div>
        <div id="quick-modal-dropzone"
          style="border:2px dashed var(--border);border-radius:var(--r-sm);padding:var(--s-2);text-align:center;color:var(--fg-mute);font-size:11px;cursor:pointer;transition:border-color .15s,background .15s;margin-bottom:var(--s-3)">
          📋 Pegá (Ctrl+V), arrastrá o tocá acá para sumar la foto de referencia <span style="color:#FF5566">* obligatoria</span>
          <input type="file" id="quick-modal-file-input" accept="image/*" multiple style="display:none">
        </div>

        <!-- Form -->
        <label style="display:block;font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Título <span style="color:#FF5566">*</span></label>
        <input type="text" id="quick-modal-titulo" placeholder="Cliente o cartel — ej. Alhambra"
          style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:10px;color:var(--fg);font-size:14px;margin-bottom:var(--s-3)">

        <!-- Origen de la consulta: WhatsApp o Instagram -->
        <label style="display:block;font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">¿Por dónde llegó la consulta? <span style="color:#FF5566">*</span></label>
        <div style="display:flex;gap:8px;margin-bottom:var(--s-3)">
          <button type="button" id="quick-modal-origen-wpp" data-qm-origen="wpp"
            style="flex:1;padding:10px;border:1px solid;border-radius:var(--r-sm);cursor:pointer;font-size:13px;font-weight:600;transition:all .15s;${oBtn('wpp', origen === 'wpp')}">
            📱 WhatsApp
          </button>
          <button type="button" id="quick-modal-origen-ig" data-qm-origen="ig"
            style="flex:1;padding:10px;border:1px solid;border-radius:var(--r-sm);cursor:pointer;font-size:13px;font-weight:600;transition:all .15s;${oBtn('ig', origen === 'ig')}">
            📷 Instagram
          </button>
        </div>

        <!-- Teléfono (visible solo si WPP, obligatorio en ese caso) -->
        <div id="quick-modal-telefono-wrap" style="${origen === 'wpp' ? '' : 'display:none'}">
          <label style="display:block;font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Teléfono del cliente <span style="color:#FF5566">*</span></label>
          <input type="tel" id="quick-modal-telefono" placeholder="ej. 5491155604999 (sin +, solo dígitos)" value="${escapeHtml(STATE.quickModalPrefillPhone || '')}"
            style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:10px;color:var(--fg);font-size:14px;margin-bottom:var(--s-3)">
        </div>

        ${(STATE.view !== 'corporeas' && STATE.quickModalTipo !== 'corporea') ? `
        <!-- Interior / Exterior: OBLIGATORIO y SIN default — define el precio (EXT cobra extra).
             Si no se exige, Joaco se olvida y queda todo "interior" cobrado de menos. -->
        <label style="display:block;font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">¿Interior o exterior? <span style="color:#FF5566">*</span></label>
        <div id="quick-modal-intext-wrap" style="display:flex;gap:8px;margin-bottom:var(--s-3)">
          <button type="button" id="quick-modal-intext-INT" data-qm-intext="INT"
            style="flex:1;padding:10px;border:1px solid;border-radius:var(--r-sm);cursor:pointer;font-size:13px;font-weight:600;transition:all .15s;${oBtn('x', STATE.quickModalIntExt === 'INT')}">
            🏠 Interior
          </button>
          <button type="button" id="quick-modal-intext-EXT" data-qm-intext="EXT"
            style="flex:1;padding:10px;border:1px solid;border-radius:var(--r-sm);cursor:pointer;font-size:13px;font-weight:600;transition:all .15s;${oBtn('x', STATE.quickModalIntExt === 'EXT')}">
            🌤️ Exterior
          </button>
        </div>
        ` : ''}

        <label style="display:block;font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Medidas referenciales (opcional)</label>
        <input type="text" id="quick-modal-medidas" placeholder="Lo que pidió el cliente: 90x50, letras 80…"
          style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:10px;color:var(--fg);font-size:14px;margin-bottom:var(--s-3)">

        <label style="display:block;font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Notas (opcional)</label>
        <textarea id="quick-modal-notas" rows="2" placeholder="referencia, info extra…"
          style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:10px;color:var(--fg);font-family:inherit;font-size:13px;resize:vertical;margin-bottom:var(--s-3)"></textarea>

        <!-- Urgente: prioridad para Emma (queda arriba de todo en "A cotizar") -->
        <label id="quick-modal-urgente-lbl" style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:9px 11px;border:1px solid ${STATE.quickModalUrgente ? 'rgba(255,24,48,.5)' : 'var(--border)'};border-radius:var(--r-sm);margin-bottom:var(--s-4);background:${STATE.quickModalUrgente ? 'rgba(255,24,48,.08)' : 'transparent'};transition:border-color .15s,background .15s">
          <input type="checkbox" id="quick-modal-urgente" ${STATE.quickModalUrgente ? 'checked' : ''} style="width:16px;height:16px;accent-color:#ff3030;cursor:pointer;margin:0">
          <span style="font-size:13px;font-weight:600;color:${STATE.quickModalUrgente ? '#ff5468' : 'var(--fg)'}">🔥 Marcar como urgente</span>
          <span style="font-size:11px;color:var(--fg-subtle)">prioridad para Emma</span>
        </label>

        ${(isJoaquinUser(STATE.user) || isGasparUser(STATE.user)) ? `
        <!-- Diseñar también con IA (modo comparación — solo Joaco/Gaspar) -->
        <label id="quick-modal-ia-lbl" style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:9px 11px;border:1px solid ${STATE.quickModalIA ? 'rgba(143,212,222,.5)' : 'var(--border)'};border-radius:var(--r-sm);margin-bottom:var(--s-4);background:${STATE.quickModalIA ? 'rgba(143,212,222,.10)' : 'transparent'};transition:border-color .15s,background .15s">
          <input type="checkbox" id="quick-modal-ia" ${STATE.quickModalIA ? 'checked' : ''} style="width:16px;height:16px;accent-color:#8FD4DE;cursor:pointer;margin:0">
          <span style="font-size:13px;font-weight:600;color:${STATE.quickModalIA ? 'var(--accent-cyan,#8FD4DE)' : 'var(--fg)'}">🤖 Diseñar también con IA</span>
          <span style="font-size:11px;color:var(--fg-subtle)">arranca al crear · para comparar vs Emma</span>
        </label>` : ''}

        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="quick-modal-cancel" class="btn btn-ghost">Cancelar</button>
          <button id="quick-modal-confirm" class="btn btn-cyan">✓ Crear brief</button>
        </div>
      </div>
    </div>
  `;
}

function renderQuickModalImages() {
  if (!STATE.quickModalImages.length) return '';  // sin imágenes: el dropzone de abajo invita a sumar
  return STATE.quickModalImages.map((img, i) => `
    <div style="position:relative;width:100%;aspect-ratio:1;border-radius:6px;overflow:hidden;background:var(--ink-050)">
      <img src="${img.dataUrl}" style="width:100%;height:100%;object-fit:cover">
      <button type="button" data-quick-img-remove="${i}" title="Quitar"
        style="position:absolute;top:2px;right:2px;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,.7);color:#fff;border:0;cursor:pointer;font-size:11px;line-height:1;display:flex;align-items:center;justify-content:center">✕</button>
    </div>
  `).join('');
}

function refreshQuickModalImages() {
  const grid = document.getElementById('quick-modal-images');
  if (!grid) return;
  grid.innerHTML = renderQuickModalImages();
  // Re-bind botones quitar.
  grid.querySelectorAll('[data-quick-img-remove]').forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const i = parseInt(btn.dataset.quickImgRemove, 10);
      STATE.quickModalImages.splice(i, 1);
      refreshQuickModalImages();
    };
  });
}

function openBriefDrawer(id) {
  STATE.briefSelected = id;
  STATE.briefDraft = null;
  STATE.briefDraftImages = [];
  STATE.briefDetailImages = [];
  STATE.briefDetailMessages = [];
  render();
  // Cargar detalle en background. Cuando llega, re-renderizamos el DRAWER ENTERO
  // para que la IIFE del botón "Generar render IA" se vuelva a evaluar con las
  // imágenes ya cargadas (refreshImageGrids parchea grid y botón pero la IIFE
  // del label del botón ya quedó congelada en el primer render).
  fetchBriefDetail(id).then(() => {
    render();
    refreshImageGrids();
    refreshBriefChat();
  });
}

function openBriefDraft() {
  STATE.briefSelected = null;
  STATE.briefDraft = {
    cliente_nombre: '',
    cliente_wa_id: '',
    origen_lead: '',
    estado: 'nuevo',
    medidas_libre: '',
    notas: ''
  };
  STATE.briefDraftImages = [];
  STATE.briefDetailImages = [];
  STATE.briefDetailMessages = [];
  render();
}

function closeBriefDrawer() {
  STATE.briefSelected = null;
  STATE.briefDraft = null;
  STATE.briefDraftImages = [];
  STATE.briefDetailImages = [];
  STATE.briefDetailMessages = [];
  STATE.briefLastAiParams = null;
  _briefPasteZone = null;
  render();
}

function readBriefDrawerForm() {
  const out = {};
  // cliente_wa_id y origen_lead son NOT NULL en D1 — mandar '' en vez de null
  // para no romper el PATCH cuando el campo queda vacío (ej. brief Instagram).
  const KEEP_EMPTY = new Set(['cliente_wa_id', 'origen_lead']);
  document.querySelectorAll('[data-bf]').forEach(el => {
    // CRÍTICO: NO reenviar campos que el usuario actual NO puede editar
    // (readonly/disabled). Para el rol diseñador, título/origen/teléfono son
    // read-only — si los reenviáramos, una auto-grabación (ej. al generar el
    // render, generarRenderBrief) pisaría el origen_lead/cliente_wa_id que
    // cargó el comercial. BUG real: briefs creados como WPP + número aparecían
    // como IG sin número después de pasar por la etapa de diseño.
    if (el.disabled || el.readOnly) return;
    const k = el.dataset.bf;
    let v = el.value;
    if (['alto_cm', 'ancho_cm', 'neon_mt', 'tramos'].includes(k)) v = v === '' ? null : Number(v);
    // Para teléfono: normalizar a solo dígitos.
    if (k === 'cliente_wa_id' && typeof v === 'string') v = v.replace(/\D/g, '');
    out[k] = (v === '' && !KEEP_EMPTY.has(k)) ? null : v;
  });
  // tipo (INT/EXT) lo edita el diseñador; origen lo edita el comercial. En ambos
  // casos: solo lo incluimos si el radio NO está disabled (= el rol puede editarlo).
  const tipoEl = document.querySelector('[data-bf-radio="tipo"]:checked');
  if (tipoEl && !tipoEl.disabled) out.tipo = tipoEl.value;
  const origenEl = document.querySelector('[data-bf-radio="origen_lead"]:checked');
  if (origenEl && !origenEl.disabled) out.origen_lead = origenEl.value;
  // Corpóreas: si el drawer tiene specs (data-corp-bf), armamos corporea_json +
  // precio_final + comisión Joaco (3%) desde esos campos. No toca tipo (queda 'corporea').
  const corpEls = document.querySelectorAll('[data-corp-bf]');
  if (corpEls.length) {
    const cf = {};
    corpEls.forEach(el => { if (!el.disabled) cf[el.dataset.corpBf] = el.value; });
    const ancho = +out.ancho_cm || +cf.ancho_cm || 0;
    const alto  = +out.alto_cm  || +cf.alto_cm  || 0;
    const sinLuz = String(cf.con_luz) === '0';
    const r = calcCorporea({ ancho, alto, con_luz: cf.con_luz, frente_material: cf.frente_material });
    out.corporea_json = JSON.stringify({
      frente_material: cf.frente_material === 'acrilico' ? 'acrilico' : 'impreso',
      con_luz: !sinLuz,
      frente_acabado: sinLuz ? 'opaco' : cf.frente_acabado, frente_color: cf.frente_color,
      lat_acabado: sinLuz ? 'opaco' : cf.lat_acabado, lat_color: cf.lat_color,
      esp_acabado: sinLuz ? 'opaca' : cf.esp_acabado, esp_color: cf.esp_color,
      ancho_cm: ancho, alto_cm: alto, m2: r.m2,
      costo_m2: r.costoM2, margen: r.margen, costo: r.costo, precio: r.precio,
      comision_joaco: Math.round(r.precio * 0.03)
    });
    out.precio_final = r.precio;
    out.m2 = r.m2;
  }
  return out;
}

// Toggle de origen (WhatsApp / Instagram) en el DRAWER del brief. Actualiza el
// feedback visual de ambos botones, marca el radio oculto y muestra/oculta el
// campo teléfono (obligatorio solo para WhatsApp). Equivalente a
// setQuickModalOrigen pero para el drawer.
function setBriefDrawerOrigen(origen) {
  const actStyle = { border: '1px solid var(--accent-cyan,#8FD4DE)', background: 'rgba(143,212,222,.08)', color: 'var(--accent-cyan)' };
  const inactStyle = { border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-subtle)' };
  ['wpp', 'ig'].forEach(o => {
    const lbl = document.getElementById('brief-origen-lbl-' + o);
    if (!lbl) return;
    const st = o === origen ? actStyle : inactStyle;
    lbl.style.border = st.border;
    lbl.style.background = st.background;
    lbl.style.color = st.color;
    const radio = lbl.querySelector('input[type=radio]');
    if (radio) radio.checked = (o === origen);
  });
  const telWrap = document.getElementById('brief-tel-wrap');
  if (telWrap) telWrap.style.display = origen === 'wpp' ? '' : 'none';
}

// Mini-popup cotizador: usa la lógica existente (calcCotizador + buildPresupuestoTexto)
// pre-cargada con los datos que Emma dejó en el brief. Joaco copia el presupuesto
// armado y lo manda al cliente; al cerrar el popup el brief queda marcado como enviado.
function openBriefCotizadorPopup() {
  if (!STATE.briefSelected) return;
  const b = STATE.briefs.find(x => x.id === STATE.briefSelected);
  if (!b) return;
  if (!b.ancho_cm || !b.alto_cm) {
    alert('Faltan medidas. Pedile a Emma que complete ancho y alto antes de cotizar.');
    return;
  }
  // Setear STATE.cotizadorForm para que las funciones existentes (calcCotizador,
  // buildPresupuestoTexto) operen con estos valores.
  STATE.cotizadorForm = {
    ancho: b.ancho_cm,
    alto:  b.alto_cm,
    neon:  b.neon_mt || 0,
    tramos: b.tramos || 0,
    tipo:  b.tipo || 'INT',
    cliente: b.cliente_nombre || '',
    canal: 'WPP',
    telefono: b.cliente_wa_id || '',
    textoOverride: '',
    extraCarteles: []
  };
  STATE.briefCotPopupOpen = true;
  render();
}

function closeBriefCotizadorPopup() {
  STATE.briefCotPopupOpen = false;
  render();
}


// Guarda la cotización actual al Sheet "Cotizador Joaco" vía Apps Script.
// Si el brief abierto no tenía sheet_row, lo persistimos para idempotencia/traza.
// Devuelve { ok, row } o { error }.
async function saveCotToSheetFromPopup() {
  const f = STATE.cotizadorForm;
  if (!f) return { error: 'no form' };
  const r       = (function(){ try { return calcCotizadorActivo(f); } catch(e){ return null; } })();
  const rNueva  = (function(){ try { return calcCotizadorNuevo(f); }  catch(e){ return null; } })();
  const rViejo  = (function(){ try { return calcCotizador(f); }       catch(e){ return null; } })();
  if (!r) return { error: 'no calc' };
  const payload = {
    cliente: f.cliente, alto: f.alto, ancho: f.ancho, neon: f.neon,
    tramos: +f.tramos || 0,
    tipo: f.tipo, m2: r.m2,
    trans: r.transFinal, negro: r.negroFinal,
    reventa: r.reventa, comision: r.comision,
    descuento: r.descuento || 0, recargo: r.recargo || 0,
    telefono: f.telefono || '', canal: f.canal || 'WPP',
    // Campos de transición — grabados al final del row para validar:
    cf: rNueva ? rNueva.cf : 0,
    margen: rNueva ? rNueva.margen : 0,
    densidad: rNueva ? rNueva.densidad : 0,
    precio_nuevo: rNueva ? rNueva.transFinal : 0,
    precio_viejo: rViejo ? rViejo.transFinal : 0
  };
  try {
    const resp = await fetch(CONFIG.appsScriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },  // text/plain evita preflight CORS
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    if (data && data.ok && STATE.briefSelected && data.row) {
      // Persistir sheet_row en el brief para trazabilidad.
      try {
        const saved = await saveBrief({ id: STATE.briefSelected, sheet_row: data.row });
        const i = STATE.briefs.findIndex(b => b.id === saved.id);
        if (i >= 0) STATE.briefs[i] = saved;
      } catch(e) {}
    }
    return data;
  } catch (e) {
    return { error: e.message };
  }
}

// ===== Lightbox (modal flotante para preview de imágenes) =====
function openImgLightbox(url) {
  STATE.imgLightboxUrl = url;
  render();
}
function closeImgLightbox() {
  STATE.imgLightboxUrl = null;
  render();
}
function renderImgLightbox() {
  if (!STATE.imgLightboxUrl) return '';
  return `
    <div id="img-lightbox" role="dialog" aria-modal="true"
         style="position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:300;display:flex;align-items:center;justify-content:center;padding:24px;cursor:zoom-out">
      <img src="${escapeHtml(STATE.imgLightboxUrl)}" alt="preview"
           style="max-width:100%;max-height:100%;object-fit:contain;border-radius:6px;box-shadow:0 8px 40px rgba(0,0,0,.6);cursor:default">
      <button id="img-lightbox-close" aria-label="Cerrar"
              style="position:fixed;top:16px;right:20px;width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.1);color:#fff;border:0;cursor:pointer;font-size:18px;line-height:1;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)">✕</button>
    </div>
  `;
}

function renderBriefCotizadorPopup() {
  if (!STATE.briefCotPopupOpen) return '';
  const p = getCotizadorParams();
  const useNueva = !!p.transicionUseNueva;
  let r = null, rOtra = null;
  try { r     = useNueva ? calcCotizadorNuevo(STATE.cotizadorForm) : calcCotizador(STATE.cotizadorForm); } catch(e) {}
  try { rOtra = useNueva ? calcCotizador(STATE.cotizadorForm)       : calcCotizadorNuevo(STATE.cotizadorForm); } catch(e) {}
  const labelOtra = useNueva ? 'fórmula vieja' : 'fórmula nueva';
  const texto = (function(){ try { return buildPresupuestoTexto() || ''; } catch(e) { return ''; } })();
  const f = STATE.cotizadorForm;
  return `
    <div id="brief-cot-popup-backdrop"
         style="position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:200;display:flex;align-items:center;justify-content:center;padding:var(--s-4)">
      <div style="background:var(--bg, #0A0A0F);border:1px solid var(--accent-cyan);border-radius:var(--r-md);max-width:560px;width:100%;max-height:90vh;overflow-y:auto;padding:var(--s-4)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--s-3);border-bottom:1px solid var(--border);padding-bottom:var(--s-2)">
          <h2 style="margin:0;font-size:16px;color:var(--accent-cyan)">💰 Cotizar y enviar</h2>
          <button class="btn btn-ghost btn-icon" id="brief-cot-popup-close" aria-label="Cerrar">✕</button>
        </div>
        <div style="font-size:12px;color:var(--fg-subtle);margin-bottom:var(--s-3)">
          <b>${escapeHtml(f.cliente || 'Sin título')}</b> · ${Math.round(+f.ancho)}×${Math.round(+f.alto)} cm · ${f.tipo} · neón ${f.neon} mt${(+f.tramos > 0) ? ' · '+(+f.tramos)+' tramos' : ''}
        </div>
        ${r ? `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-family:ui-monospace,monospace;font-size:14px;margin-bottom:var(--s-2);background:rgba(143,212,222,.04);padding:var(--s-3);border-radius:var(--r-sm)">
          ${useNueva && r.cf ? `
            <div><span style="color:var(--fg-subtle);font-size:11px">CF (costo fijo)</span><br><b>${fmtMoney(r.cf)}</b></div>
            <div><span style="color:var(--fg-subtle);font-size:11px">Margen objetivo</span><br><b>${Math.round(r.margen*100)}%</b></div>
          ` : `
            <div><span style="color:var(--fg-subtle);font-size:11px">m²</span><br><b>${r.m2.toFixed(2)}</b></div>
            <div><span style="color:var(--fg-subtle);font-size:11px">Comisión Joaco</span><br><b>${fmtMoney(r.comision)}</b></div>
          `}
          <div><span style="color:var(--fg-subtle);font-size:11px">Acrílico transparente</span><br><b style="color:var(--accent-cyan);font-size:16px">${fmtMoney(r.transFinal)}</b></div>
          ${OFRECER_BASE_NEGRA ? `<div><span style="color:var(--fg-subtle);font-size:11px">Acrílico negro</span><br><b style="color:var(--accent-cyan);font-size:16px">${fmtMoney(r.negroFinal)}</b></div>` : ''}
        </div>
        ${rOtra ? `
        <div style="font-size:11px;color:var(--fg-mute);margin-bottom:var(--s-3);padding:8px;background:rgba(255,255,255,.02);border:1px dashed var(--border);border-radius:var(--r-sm)">
          <b style="color:var(--fg-subtle)">↔ ${labelOtra}:</b>
          trans <s>${fmtMoney(rOtra.transFinal)}</s>${OFRECER_BASE_NEGRA ? ` · negro <s>${fmtMoney(rOtra.negroFinal)}</s>` : ''}
        </div>
        ` : ''}
        ` : '<div class="muted" style="text-align:center;padding:var(--s-2)">No se pudo calcular precio (revisá medidas).</div>'}

        ${isAdmin() && r ? (function(){
          const raw = (STATE.cotizadorCogs && STATE.cotizadorCogs.raw) || null;
          const m2r = r.m2real || ((+f.ancho * +f.alto) / 10000) || 0;
          const metros = +f.neon || 0;
          const dual = (lbl, vt, vn) => `<tr><td>${lbl}</td><td style="text-align:right;color:var(--fg)">${fmtMoney(vt)}${(vn != null) ? ` <span style="color:var(--fg-mute)">/ ${fmtMoney(vn)}</span>` : ''}</td></tr>`;
          if (!raw) {
            return `<div style="font-size:12px;background:rgba(255,255,255,.02);border:1px dashed var(--border);border-radius:var(--r-sm);padding:var(--s-3);margin-bottom:var(--s-3)"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--accent-cyan);margin-bottom:6px">🔒 Desglose de COGS · solo admin</div><div style="font-family:ui-monospace,monospace;font-size:12px;color:var(--fg)">Costo fijo: ${fmtMoney(r.cf || 0)} · comisión Joaco: ${fmtMoney(r.comision || 0)}</div><div style="font-size:10px;color:var(--fg-mute);margin-top:6px">Entrá una vez a la tab Cotización para cargar el desglose detallado de COGS.</div></div>`;
          }
          const imag = +raw.venta_trans_imaginario || 0;
          const baseT = m2r * (+raw.costo_acrilico_trans || 0), baseN = m2r * (+raw.costo_acrilico_negro || 0);
          const neon = metros * (+raw.costo_neon_mt || 0), fuente = r.fuente || 0;
          const anibal = m2r * (+raw.anibal || 0) * imag, emma = m2r * (+raw.emma || 0) * imag;
          const pT = r.transFinal || 0, pN = r.negroFinal || 0;
          const moT = (+raw.mano_obra || 0) * pT, moN = (+raw.mano_obra || 0) * pN;
          const joT = (+raw.joaquin || 0) * pT, joN = (+raw.joaquin || 0) * pN;
          const ctT = baseT + neon + fuente + anibal + emma + moT + joT;
          const ctN = baseN + neon + fuente + anibal + emma + moN + joN;
          return `<div style="font-size:12px;background:rgba(255,255,255,.02);border:1px dashed var(--border);border-radius:var(--r-sm);padding:var(--s-3);margin-bottom:var(--s-3)"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--accent-cyan);margin-bottom:6px">🔒 Desglose de COGS · solo admin <span style="color:var(--fg-mute);text-transform:none;letter-spacing:0">(transparente / negro)</span></div><table style="width:100%;font-family:ui-monospace,monospace;font-size:12px;color:var(--fg-subtle)">${dual('Base (acrílico)', baseT, baseN)}${dual('Neón', neon, null)}${dual('Fuente', fuente, null)}${dual('Aníbal (corte base, 15%)', anibal, null)}${dual('Emma (diseño, 5%)', emma, null)}${dual('Mano de obra (13.5%)', moT, moN)}${dual('Joaquín (comisión, 5%)', joT, joN)}<tr style="border-top:1px solid var(--border)"><td style="padding-top:5px"><b>Costo total</b></td><td style="text-align:right;padding-top:5px;color:var(--fg)"><b>${fmtMoney(ctT)} <span style="color:var(--fg-mute)">/ ${fmtMoney(ctN)}</span></b></td></tr><tr><td>Precio</td><td style="text-align:right;color:var(--accent-cyan)">${fmtMoney(pT)} / ${fmtMoney(pN)}</td></tr><tr><td><b>Ganancia neta</b></td><td style="text-align:right;color:#4ade80"><b>${fmtMoney(pT - ctT)} / ${fmtMoney(pN - ctN)}</b></td></tr></table><div style="font-size:10px;color:var(--fg-mute);margin-top:6px">Dimmer + envío se cotizan aparte. Joaco además cobra sueldo fijo mensual (${fmtMoney(+raw.joaquin_fijo || 0)}) — costo general del negocio, no por cartel.</div></div>`;
        })() : ''}
        <label style="display:block;font-size:11px;color:var(--fg-subtle);margin-bottom:4px;text-transform:uppercase;letter-spacing:.06em">Texto del presupuesto</label>
        <textarea id="brief-cot-popup-text" rows="14"
                  style="width:100%;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);padding:10px;color:var(--fg);font-family:inherit;font-size:13px;resize:vertical;margin-bottom:var(--s-3)">${escapeHtml(texto)}</textarea>

        ${(() => {
          // Botones del modal, según el origen del brief:
          // - WhatsApp: "📋 Copiar presupuesto" (copia + Sheet, no marca) +
          //   "📤 Enviar por WhatsApp" (manda + verifica 3 cosas + marca enviado).
          // - Instagram: un solo botón "📋 Copiar y marcar como enviado" (copia +
          //   Sheet + marca enviado, sin teléfono ni verificación API).
          const b = STATE.briefs.find(x => x.id === STATE.briefSelected) || {};
          const o = String(b.origen_lead || '').toLowerCase();
          const tel = String(b.cliente_wa_id || '').replace(/\D/g, '');
          const esIg = (o === 'ig' || o === 'instagram');
          const isWa = !esIg && (o === 'wpp' || o === 'whatsapp' || (o === '' && tel.length >= 8)) && tel.length >= 8;
          const sending = STATE.briefsEnviando && STATE.briefsEnviando[b.id];
          if (esIg) {
            return `
              <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
                <button class="btn btn-cyan" id="brief-cot-popup-copy-ig" ${sending ? 'disabled' : ''}>${sending ? '⏳…' : '📋 Copiar y marcar como enviado'}</button>
              </div>
              <div style="font-size:10px;color:var(--fg-mute);text-align:right;margin-top:6px">📷 Instagram: copia el texto, lo guarda en el Sheet y marca el brief como enviado. Pegalo en el DM.</div>
            `;
          }
          // WhatsApp (o brief viejo con teléfono).
          const noTel = !isWa;
          return `
            <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
              <button class="btn btn-ghost" id="brief-cot-popup-copy">📋 Copiar presupuesto</button>
              <button class="btn btn-cyan" id="brief-cot-popup-send-wa" ${(sending || noTel) ? 'disabled' : ''} ${noTel ? 'title="Falta el teléfono del cliente (obligatorio para WhatsApp)"' : ''}>
                ${sending ? '⏳ Enviando…' : '📤 Enviar por WhatsApp'}
              </button>
            </div>
            ${noTel ? '<div style="font-size:10px;color:#FFA726;text-align:right;margin-top:6px">⚠ Falta el teléfono del cliente. Editá el brief para poder enviar por WhatsApp.</div>' : '<div style="font-size:10px;color:var(--fg-mute);text-align:right;margin-top:6px">"Copiar" solo guarda en Sheet · "Enviar" manda al cliente, verifica y marca enviado.</div>'}
          `;
        })()}
        <div id="brief-cot-popup-status" style="font-size:11px;color:var(--green, #25D366);text-align:right;margin-top:6px;height:14px"></div>
      </div>
    </div>
  `;
}

// Convierte un File/Blob a { dataUrl, blob, contentType, size } para preview local
// antes de subir al backend.
function fileToDraftImage(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve({
      dataUrl: fr.result,
      blob: file,
      contentType: file.type || 'image/png',
      size: file.size
    });
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

// El tipo final de la imagen se resuelve por ROL, no solo por la zona donde se
// soltó. Un diseñador NUNCA sube capturas de chat (eso es de Joaco); un comercial
// NUNCA sube boceto/render (eso es del diseñador). Admin (Gaspar) respeta la zona.
function resolveImgTipoForRole(intentado) {
  const role = getUserRole();
  if (role === 'admin') return intentado;                                   // Gaspar: respeta la zona
  if (role === 'disenador') return intentado === 'render' ? 'render' : 'boceto';
  return 'chat';                                                            // comercial: siempre chat
}

async function addImageFromFile(file, isNewBrief, tipo = 'chat') {
  if (!file || !file.type || !file.type.startsWith('image/')) return;
  tipo = resolveImgTipoForRole(tipo);
  if (isNewBrief) {
    // Draft solo soporta capturas del chat (render requiere id de brief).
    if (tipo !== 'chat') return;
    const img = await fileToDraftImage(file);
    STATE.briefDraftImages.push(img);
    refreshImageGrids();
  } else {
    try {
      const result = await uploadBriefImage(STATE.briefSelected, file, file.type, tipo);
      STATE.briefDetailImages.push(result);
      // Refresco PARCIAL: refreshImageGrids() regenera los grids de imágenes y
      // re-evalúa el botón "Generar render IA" (vía refreshGenerarRenderButton).
      // Antes había además un render() global que repintaba TODA la app (board
      // detrás del drawer incluido) solo para actualizar ese botón — innecesario
      // y causaba parpadeo. El refresco parcial cubre todo lo visible del drawer.
      refreshImageGrids();
    } catch (e) {
      alert('Error subiendo imagen: ' + e.message);
    }
  }
}

// Refresca los grids (chat + boceto + render) sin re-render del drawer.
function refreshImageGrids() {
  const isNew = !STATE.briefSelected && !!STATE.briefDraft;
  const role = getUserRole();
  const isCom = role === 'comercial' || role === 'admin';
  const isDis = role === 'disenador' || role === 'admin';
  const chatGrid = document.getElementById('brief-images-grid-chat');
  if (chatGrid) chatGrid.innerHTML = renderBriefImagesGridFor('chat', isNew, isCom);
  const bocetoGrid = document.getElementById('brief-images-grid-boceto');
  if (bocetoGrid) bocetoGrid.innerHTML = renderBriefImagesGridFor('boceto', false, isDis);
  const renderGrid = document.getElementById('brief-images-grid-render');
  if (renderGrid) renderGrid.innerHTML = renderBriefImagesGridFor('render', false, isDis);
  bindBriefImageGridHandlers(isNew);
  refreshGenerarRenderButton();
}

// Recalcula el estado del botón "Generar render IA" según las imágenes que hay
// realmente en STATE.briefDetailImages. Se invoca al cargar el detalle y al
// subir/borrar imágenes — sin esto, el botón queda con el estado del primer
// render del drawer (cuando aún no había llegado el detalle del backend).
function refreshGenerarRenderButton() {
  const btn = document.getElementById('brief-generar-render');
  if (!btn) return;
  const tieneBoceto = STATE.briefDetailImages.some(x => x.tipo === 'boceto');
  const tieneChat = STATE.briefDetailImages.some(x => (x.tipo || 'chat') === 'chat');
  const hayInput = tieneBoceto || tieneChat;
  const fuente = tieneBoceto ? 'el boceto' : 'las capturas de Joaco';
  const generando = !!STATE.briefsGenerando[STATE.briefSelected];
  btn.disabled = generando || !hayInput;
  btn.textContent = generando
    ? '✨ Generando… podés seguir con otro brief'
    : !hayInput
      ? '⚠ Subí al menos una imagen para generar'
      : `✨ Generar render IA (con ${fuente})`;
}

// Llama al worker para generar el render con Gemini a partir del boceto.
// Lanza la generación de render IA EN SEGUNDO PLANO. Emma puede cerrar el
// drawer, abrir otro brief, generar otro render — todo en paralelo. Al
// terminar, refresca la card del kanban y suena una notificación si el brief
// ya no está abierto.
async function generarRenderBrief() {
  if (!STATE.briefSelected) return;
  const tieneImagen = STATE.briefDetailImages.length > 0;
  if (!tieneImagen) { alert('Subí al menos una captura o boceto antes de generar.'); return; }

  // Snapshot del briefId: si Emma cambia de brief, las callbacks usan ESTE id.
  const briefId = STATE.briefSelected;

  // Auto-save sincrónico de los campos del drawer antes de mandar a la IA, para
  // que el worker lea las notas / título / medidas referenciales actualizadas.
  try {
    const form = readBriefDrawerForm();
    form.id = briefId;
    const saved = await saveBrief(form);
    const idx = STATE.briefs.findIndex(b => b.id === saved.id);
    if (idx >= 0) STATE.briefs[idx] = saved;
  } catch (eSave) { console.warn('auto-save pre-IA falló:', eSave); }

  // Marcar como generando + refrescar UI (botón disabled + card con spinner).
  STATE.briefsGenerando[briefId] = true;
  if (STATE.briefSelected === briefId) {
    const statusEl = document.getElementById('brief-render-ia-status');
    if (statusEl) { statusEl.textContent = 'Corriendo en segundo plano… podés cerrar y seguir con otro brief.'; statusEl.style.color = 'var(--accent-cyan)'; }
  }
  refreshGenerarRenderButton();
  // Refresh card del kanban para mostrar el badge "generando" si Emma lo cierra.
  // No re-renderizamos el drawer entero para no interrumpir si está escribiendo.

  // Lanzar el trabajo de fondo (no await acá — Emma sigue interactuando).
  generarRenderInBackground(briefId);
}

async function generarRenderInBackground(briefId) {
  let renderResult = null;
  let renderError = null;
  try {
    const r = await fetch(`${CONFIG.trackerUrl}/admin/briefs/${briefId}/generar-render`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${STATE.token}` }
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    renderResult = data;
  } catch (e) {
    renderError = e;
  }

  // Cleanup del flag siempre.
  delete STATE.briefsGenerando[briefId];

  if (renderError) {
    console.error(`Render falló para brief #${briefId}:`, renderError);
    // Si Emma sigue en ese brief, mostrarle el error.
    if (STATE.briefSelected === briefId) {
      const statusEl = document.getElementById('brief-render-ia-status');
      if (statusEl) { statusEl.textContent = '⚠ ' + renderError.message; statusEl.style.color = '#FF5566'; }
      refreshGenerarRenderButton();
    } else {
      // Si está en otro brief, notificarle el fallo en segundo plano.
      notifyRenderResult(briefId, false, renderError.message);
    }
    return;
  }

  // Éxito: separar la imagen render de los params.
  const { params, params_error, input_origen, ...renderImg } = renderResult;

  // Actualizar contador render_count + thumb en la card del kanban.
  const idx = STATE.briefs.findIndex(b => b.id === briefId);
  if (idx >= 0) {
    STATE.briefs[idx].render_count = (STATE.briefs[idx].render_count || 0) + 1;
    if (!STATE.briefs[idx].first_render_key) STATE.briefs[idx].first_render_key = renderImg.r2_key;
  }

  // Si el brief sigue abierto, agregar a briefDetailImages para el grid local.
  if (STATE.briefSelected === briefId) {
    STATE.briefDetailImages.push(renderImg);
  }

  // Guardar params sugeridos por IA como referencia (no escribimos los inputs).
  if (params) {
    STATE.briefLastAiParams = {
      briefId,
      ancho_cm: params.ancho_cm,
      alto_cm: params.alto_cm,
      neon_mt: params.neon_mt,
      razonamiento: params.razonamiento,
      dif_vs_cliente: params.dif_vs_cliente
    };
  }

  // Auto-transición de 'nuevo' → 'listo' SOLO si ya están las 3 medidas.
  // Si Emma aún no cargó ancho/alto/neón, el brief se queda en 'nuevo' hasta
  // que las complete y guarde — en ese momento handleBriefSave detecta render
  // + medidas y lo pasa a 'listo'.
  try {
    const current = STATE.briefs.find(b => b.id === briefId);
    const tieneMedidas = current && current.ancho_cm > 0 && current.alto_cm > 0 && (current.tipo === 'corporea' || current.neon_mt > 0);
    if (current && current.estado === 'nuevo' && tieneMedidas) {
      const saved = await saveBrief({ id: briefId, estado: 'listo' });
      const ix = STATE.briefs.findIndex(b => b.id === saved.id);
      if (ix >= 0) STATE.briefs[ix] = saved;
    }
  } catch (eState) { console.error('auto-transición listo falló:', eState); }

  // Refresh UI según contexto:
  if (STATE.briefSelected === briefId) {
    // Emma sigue en el brief original — re-render para que aparezca el render generado.
    render();
  } else {
    // Emma se cambió a otro brief — refrescar SOLO el kanban (no destruir lo abierto)
    // y notificar con sonido.
    render();
    notifyRenderResult(briefId, true);
  }
}

function notifyRenderResult(briefId, success, errMsg) {
  const b = STATE.briefs.find(x => x.id === briefId);
  const titulo = b?.cliente_nombre || `Brief #${briefId}`;
  try { playChatSound(); } catch(e) {}
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const body = success ? titulo : `${titulo} · ⚠ ${(errMsg || '').slice(0, 80)}`;
      const n = new Notification(success ? '✨ Render listo' : '⚠ Render falló', { body, icon: 'assets/logo.svg', tag: 'render-ia-' + briefId });
      n.onclick = () => {
        try { window.focus(); } catch(e) {}
        if (STATE.view !== 'cotizacion' && STATE.view !== 'corporeas') setView('cotizacion');
        openBriefDrawer(briefId);
        n.close();
      };
    }
  } catch (e) {}
}

function bindBriefImageGridHandlers(isNew) {
  // Botones quitar de DRAFT (sin subir, solo borra del array).
  document.querySelectorAll('[data-drop-img-remove]').forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const i = parseInt(btn.dataset.dropImgRemove, 10);
      STATE.briefDraftImages.splice(i, 1);
      refreshImageGrids();
    };
  });
  // Botones eliminar de imágenes ya subidas (brief existente).
  document.querySelectorAll('[data-img-remove]').forEach(btn => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      const imgId = parseInt(btn.dataset.imgRemove, 10);
      if (!confirm('¿Eliminar esta imagen?')) return;
      try {
        await deleteBriefImage(STATE.briefSelected, imgId);
        STATE.briefDetailImages = STATE.briefDetailImages.filter(x => x.id !== imgId);
        refreshImageGrids();
      } catch (e) {
        alert('Error eliminando: ' + e.message);
      }
    };
  });
  document.querySelectorAll('[data-img-zoom]').forEach(el => {
    el.onclick = (ev) => { ev.stopPropagation(); openImgLightbox(el.dataset.imgZoom); };
  });
}

async function handleBriefSave() {
  const form = readBriefDrawerForm();
  const isCreate = !STATE.briefSelected;
  if (!form.cliente_nombre || !form.cliente_nombre.trim()) {
    alert('Falta el título del brief.');
    return;
  }
  // Si la consulta vino por WhatsApp, el teléfono es obligatorio (lo necesitamos
  // para mandar el presupuesto por API). Para Instagram no se pide.
  const origen = String(form.origen_lead || '').toLowerCase();
  if (origen === 'wpp' || origen === 'whatsapp') {
    const telDigits = String(form.cliente_wa_id || '').replace(/\D/g, '');
    if (telDigits.length < 8) {
      const telEl = document.getElementById('brief-tel-input');
      if (telEl) { telEl.focus(); telEl.style.borderColor = '#FF5566'; setTimeout(() => { telEl.style.borderColor = 'var(--border)'; }, 1500); }
      alert('La consulta es por WhatsApp: el teléfono es obligatorio (al menos 8 dígitos). Si es de Instagram, cambiá el origen a 📷 Instagram.');
      return;
    }
  }
  if (!isCreate) form.id = STATE.briefSelected;

  // Auto-transición a "listo" cuando el diseñador completa render + medidas.
  // Condiciones (todas):
  //   - brief existente (no create)
  //   - estado actual = "nuevo"
  //   - ancho_cm, alto_cm, neon_mt todos completos
  //   - al menos 1 imagen tipo='render' subida
  if (!isCreate) {
    const current = STATE.briefs.find(b => b.id === STATE.briefSelected);
    const estadoActual = current?.estado || 'nuevo';
    const tieneRender = STATE.briefDetailImages.some(x => x.tipo === 'render');
    const tieneMedidas = form.ancho_cm > 0 && form.alto_cm > 0 && (current?.tipo === 'corporea' || form.neon_mt > 0);
    if (estadoActual === 'nuevo' && tieneRender && tieneMedidas) {
      form.estado = 'listo';
    }
  }

  try {
    const saved = await saveBrief(form);
    // Subir imágenes pendientes del draft (solo capturas del chat).
    if (isCreate && STATE.briefDraftImages.length) {
      for (const img of STATE.briefDraftImages) {
        try { await uploadBriefImage(saved.id, img.blob, img.contentType, 'chat'); } catch(e) { console.error('upload failed', e); }
      }
    }
    if (isCreate) {
      STATE.briefs.unshift(saved);
    } else {
      const i = STATE.briefs.findIndex(b => b.id === saved.id);
      if (i >= 0) STATE.briefs[i] = saved;
    }
    closeBriefDrawer();
  } catch (e) {
    alert('Error al guardar: ' + e.message);
  }
}

async function handleBriefEnviar() {
  if (!STATE.briefSelected) return;
  const brief = STATE.briefs.find(b => b.id === STATE.briefSelected);
  if (!brief) return;
  if (!confirm('Marcar este brief como enviado al cliente?')) return;
  try {
    const updated = await marcarBriefEnviado(brief.id, { precio_final: brief.precio_trans });
    const i = STATE.briefs.findIndex(b => b.id === updated.id);
    if (i >= 0) STATE.briefs[i] = updated;
    closeBriefDrawer();
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

function handleBriefAbrirCotizador() {
  if (!STATE.briefSelected) return;
  const b = STATE.briefs.find(x => x.id === STATE.briefSelected);
  if (!b) return;
  // Pre-cargar el cotizador de Presupuestos con los datos del brief.
  STATE.cotizadorForm = {
    ancho: b.ancho_cm || '',
    alto:  b.alto_cm  || '',
    neon:  b.neon_mt  || '',
    tramos: b.tramos  || '',
    tipo:  b.tipo     || 'INT',
    cliente: b.cliente_nombre || b.diseno || '',
    canal: 'WPP',
    telefono: b.cliente_wa_id || '',
    textoOverride: '',
    extraCarteles: []
  };
  if (typeof pptoShowCotizador !== 'undefined') pptoShowCotizador = true;
  closeBriefDrawer();
  setView('presupuestos');
}

// Firma de la lista de briefs para detectar cambios entre polls.
function briefsSignature() {
  return (STATE.briefs || [])
    .map(b => `${b.id}:${b.estado}:${b.updated_at}:${b.chat_count || 0}:${b.render_count || 0}`)
    .join('|');
}

// ===== Bindeo de las tarjetas del kanban (abrir / borrar / urgente) =====
// Extraído para reusarlo desde el refresh incremental sin re-correr TODO bindCotizacion.
// Todos los handlers son `.onclick` (property) → idempotentes, re-llamar no duplica.
function bindBriefCards() {
  document.querySelectorAll('.brief-card').forEach(el => {
    el.onclick = () => openBriefDrawer(parseInt(el.dataset.briefId, 10));
  });
  document.querySelectorAll('[data-brief-delete]').forEach(btn => {
    btn.onclick = (ev) => { ev.stopPropagation(); handleBriefDelete(parseInt(btn.dataset.briefDelete, 10), true); };
  });
  document.querySelectorAll('[data-brief-urgente]').forEach(btn => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      const id = parseInt(btn.dataset.briefUrgente, 10);
      const b = STATE.briefs.find(x => x.id === id);
      if (!b) return;
      const prev = b.urgente ? 1 : 0;
      b.urgente = prev ? 0 : 1;
      if (!refreshBriefBoardIncremental()) render();
      try { await saveBrief({ id, urgente: b.urgente }); }
      catch (e) { b.urgente = prev; if (!refreshBriefBoardIncremental()) render(); toast('No se pudo marcar urgente'); }
    };
  });
}

// ===== Refresh INCREMENTAL del kanban (evita el flash de rebuildear todo) =====
// En vez de reemplazar #main entero (que destruye las ~500 tarjetas + sus imágenes →
// parpadeo + pierde scroll), reconcilia SOLO los .brief-card dentro de cada .brief-col-list
// por brief-id. Compara una FIRMA por-card que EXCLUYE relativeTime (para no reemplazar cada
// tarjeta cada minuto): solo reemplaza las que cambiaron, agrega las nuevas, saca las que se
// fueron, respeta el orden (urgentes arriba en "A cotizar") y preserva el scroll de cada
// columna. Devuelve false si el tablero no está montado → el caller cae a render() completo.
// Firma HASH de una tarjeta: incluye TODO lo que pinta renderBriefCard (para no perder cambios
// de urgente/vendedor/thumb/etc), MENOS relativeTime (que cambia solo con el tiempo → si no,
// reemplazaría cada tarjeta cada minuto). Se guarda como data-sig en la propia card (auto-
// consistente: la primera reconciliación tras un render() completo NO reemplaza nada).
function briefCardSig(b) {
  const colg = isBriefColgado(b) ? 1 : 0;
  const gen = STATE.briefsGenerando[b.id] ? 1 : 0;
  const pm = b.estado === 'enviado' ? (findPresupuestoMatch(b) ? 1 : 0) : -1;
  const s = [b.id, b.estado, b.urgente ? 1 : 0, b.modificar ? 1 : 0, b.chat_count || 0, b.render_count || 0,
    b.first_render_key || '', b.first_chat_key || '', b.comercial_id || '', b.origen_lead || '',
    b.cliente_nombre || '', b.medidas_libre || '', b.alto_cm || '', b.ancho_cm || '',
    b.intentos_followup || 0, b.tipo || '', b.cliente_wa_id || '', colg, gen, pm].join('');
  let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}
function _briefHtmlToCard(html) {
  const t = document.createElement('template');
  t.innerHTML = String(html).trim();
  return t.content.firstElementChild;
}
function refreshBriefBoardIncremental() {
  const kanban = document.querySelector('.brief-kanban');
  if (!kanban) return false;
  for (const col of BRIEF_COLUMNAS) {
    const colEl = kanban.querySelector(`.brief-col[data-col="${col.id}"]`);
    if (!colEl) return false;
    const listEl = colEl.querySelector('.brief-col-list');
    if (!listEl) return false;
    let briefs = STATE.briefs.filter(b => briefBelongsToColumn(b, col.id) && briefMatchesProducto(b));
    if (col.id === 'nuevo') briefs = briefs.slice().sort((a, b) => (b.urgente ? 1 : 0) - (a.urgente ? 1 : 0));
    const cntEl = colEl.querySelector('[data-col-count]');
    if (cntEl) { cntEl.dataset.total = String(briefs.length); if (!briefSearch) cntEl.textContent = String(briefs.length); }
    if (!briefs.length) {
      // Columna vacía → hint (igual que renderBriefColumn). Solo si todavía hay cards o está vacía del todo.
      if (listEl.querySelector('.brief-card') || !listEl.firstElementChild) {
        const drop = col.id === 'nuevo' && canCreateBriefs();
        listEl.innerHTML = drop
          ? '<div style="font-size:11px;color:var(--accent-cyan);text-align:center;padding:var(--s-4);line-height:1.5;opacity:.7">📋 Pegá Ctrl+V<br>o arrastrá una imagen<br>acá adentro</div>'
          : '<div style="font-size:11px;color:var(--fg-mute);text-align:center;padding:var(--s-4)">—</div>';
      }
      continue;
    }
    const scrollTop = listEl.scrollTop;
    const existing = new Map();
    listEl.querySelectorAll(':scope > .brief-card').forEach(n => existing.set(String(n.dataset.briefId), n));
    const desired = new Set();
    let anchor = null;
    for (const b of briefs) {
      const id = String(b.id);
      desired.add(id);
      const sig = briefCardSig(b);
      let node = existing.get(id);
      if (node) {
        // Reemplazar SOLO si la firma (guardada en data-sig al renderizar) cambió.
        if (node.dataset.sig !== sig) { const nn = _briefHtmlToCard(renderBriefCard(b)); listEl.replaceChild(nn, node); node = nn; }
      } else {
        node = _briefHtmlToCard(renderBriefCard(b));
      }
      const expected = anchor ? anchor.nextElementSibling : listEl.firstElementChild;
      if (node !== expected) listEl.insertBefore(node, anchor ? anchor.nextElementSibling : listEl.firstElementChild);
      anchor = node;
    }
    // Sacar cards que ya no van + cualquier hint/nodo suelto que quedó de antes.
    Array.from(listEl.children).forEach(n => {
      if (n.classList && n.classList.contains('brief-card')) {
        if (!desired.has(String(n.dataset.briefId))) n.remove();
      } else { n.remove(); }
    });
    listEl.scrollTop = scrollTop;
  }
  bindBriefCards();                       // re-bindea las cards nuevas/reemplazadas (idempotente)
  if (briefSearch) filterBriefBoard();    // re-aplica el filtro (setea display:none en las que no matchean)
  return true;
}

// Polling: refresca los briefs cada 30s mientras se está en la vista Cotización.
// Ahora con REFRESH INCREMENTAL (refreshBriefBoardIncremental) en vez de render() completo:
// reconcilia solo las tarjetas que cambiaron → sin parpadeo, sin perder scroll. Cae a render()
// si el tablero no está montado. Se sube el intervalo a 30s igual (menos carga del endpoint lento).
// Re-renderiza solo si (a) la lista cambió y (b) el usuario no está en medio de
// algo (drawer/popup/lightbox abierto), para no pisarle la interacción.
function startBriefsPolling() {
  if (STATE.briefsPollTimer) return;
  STATE.briefsPollTimer = setInterval(async () => {
    if ((STATE.view !== 'cotizacion' && STATE.view !== 'corporeas') || !STATE.token) return;
    if (document.hidden) return;  // no pollear si la pestaña está oculta
    if (pollBackoffActive()) return;  // D1 saturada: saltar el tick (el timer sigue)
    const before = briefsSignature();
    await fetchBriefs();
    const after = briefsSignature();
    if (after !== before) {
      // No pisar un form en progreso: drawer, cotizador, lightbox o el MODAL de
      // crear brief abierto (quickModalOpen). Sin esto, cuando Emma manda algo a
      // "Listos" el poll re-renderizaba y le borraba a Joaco lo que estaba cargando.
      const busy = STATE.briefSelected || STATE.briefDraft || STATE.briefCotPopupOpen || STATE.imgLightboxUrl || STATE.quickModalOpen;
      if (!busy) { if (!refreshBriefBoardIncremental()) render(); }
    }
  }, 30000);
}

// Auto-refresco del panel de Pedidos (igual que el de Cotización). Sin esto, un
// pedido nuevo (que entra a D1 vía el cron Excel→base) no aparecía hasta tocar
// "Refrescar" o recargar la página. Polleamos /admin/pedidos cada 15s, solo en la
// vista Pedidos y solo si el usuario no está editando nada.
function pedidosSignature() {
  return (STATE.pedidos || []).map(p => `${p.idx}:${p.estadoPago}:${p.estadoPedido}:${p.precio}:${p.precioDimmer}:${p.restante}`).join('|');
}
function startPedidosPolling() {
  if (STATE.pedidosPollTimer) return;
  STATE.pedidosPollTimer = setInterval(async () => {
    if (STATE.view !== 'pedidos' || !STATE.token) return;
    if (document.hidden) return;  // no pollear si la pestaña está oculta
    if (pollBackoffActive()) return;  // D1 saturada: saltar el tick (el timer sigue)
    // No pisar al usuario mientras edita: modal "Cargar pedido", drawer abierto,
    // un input/select con foco (búsqueda o dropdown inline), o el lightbox.
    const ae = document.activeElement;
    const editing = ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName);
    const drawerOpen = document.getElementById('drawer')?.classList.contains('open');
    if (STATE.pedidoModalOpen || drawerOpen || STATE.imgLightboxUrl || editing) return;
    const before = pedidosSignature();
    const fresh = await fetchPedidosFromD1();
    if (!fresh || !fresh.length) return;  // fetch falló o vino vacío → no pisar la tabla
    STATE.pedidos = fresh;
    if (pedidosSignature() !== before) {
      renderTablePedidos();
      const tc = document.getElementById('pedidos-total-count');
      if (tc) tc.textContent = `${STATE.pedidos.length} totales`;
    }
  }, 15000);
}

function bindCotizacion() {
  if (!STATE.token) return;

  startBriefsPolling();

  // Carga inicial — flag briefsLoaded evita loop infinito si la DB está vacía.
  if (!STATE.briefsLoaded && !STATE.briefsLoading && !STATE.briefsError) {
    fetchBriefs().then(() => render());
  }

  // Header.
  const newBtn = document.getElementById('brief-new');
  if (newBtn) newBtn.onclick = openNuevoBriefModal;
  const refreshBtn = document.getElementById('briefs-refresh');
  if (refreshBtn) refreshBtn.onclick = () => {
    STATE.briefsLoaded = false;
    fetchBriefs().then(() => render());
  };
  const verifBtn = document.getElementById('briefs-verificar-enviados');
  if (verifBtn) verifBtn.onclick = handleVerificarEnviados;
  const rectBtn = document.getElementById('btn-rectify-foto');
  if (rectBtn) rectBtn.onclick = () => openImgTool('rectify');
  const vecBtn = document.getElementById('btn-vectorize');
  if (vecBtn) vecBtn.onclick = () => openImgTool('vectorize');
  const mockBtn = document.getElementById('btn-mockup');
  if (mockBtn) mockBtn.onclick = openMockupModal;
  bindMockupCanvas();

  // Buscador del board: filtra las cards en vivo (sin re-render, mantiene foco).
  const briefSearchInput = document.getElementById('brief-search');
  if (briefSearchInput) briefSearchInput.oninput = () => { briefSearch = briefSearchInput.value; filterBriefBoard(); };
  const briefSearchClear = document.getElementById('brief-search-clear');
  if (briefSearchClear) briefSearchClear.onclick = () => {
    briefSearch = '';
    const el = document.getElementById('brief-search');
    if (el) { el.value = ''; el.focus(); }
    filterBriefBoard();
  };
  // Re-aplicar el filtro tras este render (el polling de briefs re-renderiza el board).
  if (briefSearch) filterBriefBoard();

  // Tarjetas: abrir drawer / borrar / toggle urgente. Extraído a bindBriefCards() para
  // reusarlo desde el refresh incremental del board (mismos handlers, idempotentes).
  bindBriefCards();

  // ===== Drop + paste sobre columna "A cotizar" (Joaco/admin) =====
  if (canCreateBriefs()) {
    const colNuevo = document.querySelector('.brief-col[data-col="nuevo"]');
    if (colNuevo) {
      colNuevo.ondragover = (ev) => {
        ev.preventDefault();
        colNuevo.style.borderColor = 'var(--accent-cyan)';
        colNuevo.style.background = 'rgba(143,212,222,.06)';
      };
      colNuevo.ondragleave = () => {
        colNuevo.style.borderColor = '';
        colNuevo.style.background = '';
      };
      colNuevo.ondrop = async (ev) => {
        ev.preventDefault();
        colNuevo.style.borderColor = '';
        colNuevo.style.background = '';
        const files = Array.from(ev.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
        for (const f of files) await quickCreateBriefFromImage(f);
      };
    }

  }

  // Paste global EN VISTA Cotización. Decide chat/render según rol y contexto.
  if (!document._cotPasteBound) {
    document.addEventListener('paste', async (ev) => {
      if (STATE.view !== 'cotizacion' && STATE.view !== 'corporeas') return;
      // Si un modal de herramienta de imagen está abierto (rectificar/vectorizar o
      // montaje), el Ctrl+V es para ÉL: no abrir brief.
      if ((STATE.rectify && STATE.rectify.open) || (STATE.mockup && STATE.mockup.open)) return;
      const items = ev.clipboardData?.items || [];
      const drawerOpen = !!STATE.briefSelected || !!STATE.briefDraft;
      const role = getUserRole();
      // Prioridad para resolver la zona destino:
      //   1) elementFromPoint(cursor) — la verdad de dónde está el mouse AHORA.
      //   2) _briefPasteZone — state seteado por mouseenter (fallback).
      //   3) default por rol — diseñador 'boceto', otros 'chat'.
      // El elementFromPoint cubre el caso "drawer abierto con el cursor ya
      // sobre la dropzone" donde mouseenter no llegó a dispararse.
      const zoneAtCursor = resolvePasteZoneAtCursor();
      let tipo = zoneAtCursor || _briefPasteZone || (role === 'disenador' ? 'boceto' : 'chat');
      // RESTRICCIÓN DURA: diseñador NUNCA puede pegar en chat. Si la zona
      // resuelve a chat, lo forzamos a boceto. resolveImgTipoForRole adentro
      // también haría esto, pero acá es explícito para evitar uploads basura.
      if (role === 'disenador' && tipo === 'chat') tipo = 'boceto';
      // En brief nuevo (draft) solo se puede pegar chat (boceto/render necesitan id).
      const tipoFinal = (!STATE.briefSelected && tipo !== 'chat') ? 'chat' : tipo;
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          ev.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;
          if (drawerOpen) {
            await addImageFromFile(file, !STATE.briefSelected, tipoFinal);
          } else if (canCreateBriefs()) {
            await quickCreateBriefFromImage(file);
          }
        }
      }
    });
    document._cotPasteBound = true;
  }

  // ===== Drawer =====
  const isNewDraft = !STATE.briefSelected && !!STATE.briefDraft;
  const drawerOpen = !!STATE.briefSelected || isNewDraft;

  const closeBtn = document.getElementById('brief-close');
  if (closeBtn) closeBtn.onclick = closeBriefDrawer;
  const backdrop = document.getElementById('brief-drawer-backdrop');
  if (backdrop) backdrop.onclick = closeBriefDrawer;
  const saveBtn = document.getElementById('brief-save');
  if (saveBtn) saveBtn.onclick = handleBriefSave;
  const cotBtn = document.getElementById('brief-cotizar');
  if (cotBtn) cotBtn.onclick = handleBriefAbrirCotizador;
  const modBtn = document.getElementById('brief-modificar');
  if (modBtn) modBtn.onclick = () => mandarBriefAModificar(STATE.briefSelected);
  const urgToggleBtn = document.getElementById('brief-urgente-toggle');
  if (urgToggleBtn) urgToggleBtn.onclick = () => toggleBriefUrgente(STATE.briefSelected);
  const cotPopupBtn = document.getElementById('brief-cotizar-popup');
  if (cotPopupBtn) cotPopupBtn.onclick = openBriefCotizadorPopup;
  // Toggle origen WhatsApp / Instagram en el drawer (feedback visual + tel).
  document.querySelectorAll('[data-brief-origen]').forEach(lbl => {
    lbl.onclick = () => {
      const radio = lbl.querySelector('input[type=radio]');
      if (!radio || radio.disabled) return;  // solo comercial/admin
      setBriefDrawerOrigen(lbl.dataset.briefOrigen);
    };
  });
  const delBtn = document.getElementById('brief-delete');
  if (delBtn) delBtn.onclick = () => handleBriefDelete(STATE.briefSelected, false);

  // ===== Drawer: dropzones internos (chat + boceto + render) =====
  if (drawerOpen) {
    bindBriefImageGridHandlers(isNewDraft);

    // Helper: usa elementFromPoint para determinar la zona REAL al hacer drop.
    // No confiamos en a qué fieldset bubbleó el evento — usamos las coords del
    // mouse y vemos qué hay debajo. Esto evita que un drop en la zona del
    // boceto termine en chat por orden de event listeners o bubbling raro.
    const resolveDropZone = (ev) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!el?.closest) return null;
      if (el.closest('#brief-images-grid-render') || el.closest('#brief-dropzone-render')) return 'render';
      if (el.closest('#brief-zone-disenador')) return 'boceto';
      if (el.closest('#brief-zone-chat')) return 'chat';
      return null;
    };
    const bindZone = (el, fallbackTipo, isDraftFor) => {
      if (!el) return;
      el.addEventListener('dragover', (ev) => { ev.preventDefault(); el.style.outline = '2px dashed var(--accent-cyan)'; });
      el.addEventListener('dragleave', () => { el.style.outline = ''; });
      el.addEventListener('drop', async (ev) => {
        ev.preventDefault(); ev.stopPropagation(); el.style.outline = '';
        // Resolución autoritativa: cursor → zona real. Si por algún motivo
        // no se pudo resolver (ej. cursor fuera del drawer), usa el fallback.
        const tipo = resolveDropZone(ev) || fallbackTipo;
        const files = Array.from(ev.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
        for (const f of files) await addImageFromFile(f, isDraftFor, tipo);
      });
      el.addEventListener('mouseenter', () => { _briefPasteZone = fallbackTipo; });
    };

    // CATCH-ALL por sección entera: soltar en cualquier parte de la sección
    // funciona, pero la decisión final se basa en elementFromPoint del cursor.
    // RESTRICCIÓN DURA: el rol diseñador NUNCA puede interactuar con la
    // sección de Joaco. No bindeamos la zona de chat para él.
    const role = getUserRole();
    if (role !== 'disenador') {
      bindZone(document.getElementById('brief-zone-chat'), 'chat', isNewDraft);
    }
    bindZone(document.getElementById('brief-zone-disenador'), 'boceto', false);

    // CHAT — click en la cajita abre el file picker.
    const fiChat = document.getElementById('brief-file-input');
    const dzChat = document.getElementById('brief-dropzone');
    if (dzChat && fiChat) {
      dzChat.onclick = () => fiChat.click();
      fiChat.onchange = async (ev) => { for (const f of Array.from(ev.target.files || [])) await addImageFromFile(f, isNewDraft, 'chat'); fiChat.value = ''; };
      // mouseenter directo en la cajita para que el paste sepa el target
      // aunque el mouseenter del fieldset padre no haya disparado.
      dzChat.addEventListener('mouseenter', () => { _briefPasteZone = 'chat'; });
    }

    // BOCETO — click en la cajita abre el file picker.
    const fiBoceto = document.getElementById('brief-file-input-boceto');
    const dzBoceto = document.getElementById('brief-dropzone-boceto');
    if (dzBoceto && fiBoceto) {
      dzBoceto.onclick = () => fiBoceto.click();
      fiBoceto.onchange = async (ev) => { for (const f of Array.from(ev.target.files || [])) await addImageFromFile(f, false, 'boceto'); fiBoceto.value = ''; };
      dzBoceto.addEventListener('mouseenter', () => { _briefPasteZone = 'boceto'; });
      // También binding de drop directo (con stopPropagation) para que el
      // drop en la cajita NUNCA bubble al fieldset y caiga en chat por error.
      dzBoceto.addEventListener('dragover', (ev) => { ev.preventDefault(); dzBoceto.style.borderColor = 'var(--accent-cyan)'; });
      dzBoceto.addEventListener('dragleave', () => { dzBoceto.style.borderColor = ''; });
      dzBoceto.addEventListener('drop', async (ev) => {
        ev.preventDefault(); ev.stopPropagation(); dzBoceto.style.borderColor = '';
        const files = Array.from(ev.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
        for (const f of files) await addImageFromFile(f, false, 'boceto');
      });
    }
    // También el grid de bocetos ya cargados acepta drop directo.
    const bocetoGrid = document.getElementById('brief-images-grid-boceto');
    if (bocetoGrid) {
      bocetoGrid.addEventListener('mouseenter', () => { _briefPasteZone = 'boceto'; });
      bocetoGrid.addEventListener('drop', async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const files = Array.from(ev.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
        for (const f of files) await addImageFromFile(f, false, 'boceto');
      });
    }

    // Botón generar render IA.
    const genBtn = document.getElementById('brief-generar-render');
    if (genBtn) genBtn.onclick = generarRenderBrief;

    // Modo comparación Emma vs IA (diseñador IA — solo Joaco + Gaspar).
    const iaGenBtn = document.getElementById('brief-generar-ia');
    if (iaGenBtn) iaGenBtn.onclick = () => generarDisenioIA(parseInt(iaGenBtn.dataset.briefId, 10));
    const iaReGenBtn = document.getElementById('brief-regenerar-ia');
    if (iaReGenBtn) iaReGenBtn.onclick = () => generarDisenioIA(parseInt(iaReGenBtn.dataset.briefId, 10));
    const iaFbBien = document.getElementById('ia-fb-bien');
    if (iaFbBien) iaFbBien.onclick = () => guardarFeedbackIA(parseInt(iaFbBien.dataset.briefId, 10), 'bien');
    const iaFbMal = document.getElementById('ia-fb-mal');
    if (iaFbMal) iaFbMal.onclick = () => guardarFeedbackIA(parseInt(iaFbMal.dataset.briefId, 10), 'mal');

    // El render YA no tiene dropzone manual — solo se genera con IA.
    // Igual mantenemos el grid como zona target por si se pega/dropea desde
    // el modo "Pegar Ctrl+V" global (catch-all _briefPasteZone).
    bindZone(document.getElementById('brief-images-grid-render'), 'render', false);
  }

  // ===== Popup cotizador =====
  if (STATE.briefCotPopupOpen) {
    const popupBackdrop = document.getElementById('brief-cot-popup-backdrop');
    if (popupBackdrop) popupBackdrop.onclick = (ev) => {
      if (ev.target.id === 'brief-cot-popup-backdrop') closeBriefCotizadorPopup();
    };
    const popupClose = document.getElementById('brief-cot-popup-close');
    if (popupClose) popupClose.onclick = closeBriefCotizadorPopup;
    const setStatus = (msg, color) => {
      const st = document.getElementById('brief-cot-popup-status');
      if (!st) return;
      st.textContent = msg;
      st.style.color = color || 'var(--green, #25D366)';
      if (msg) setTimeout(() => { if (st.textContent === msg) st.textContent = ''; }, 3500);
    };

    // 📋 Copiar presupuesto — copia al clipboard + guarda en el Sheet.
    // NO marca el brief como enviado — esto sirve para IG donde Joaco pega
    // manualmente en el DM, o para chequear el texto antes de mandar por WA.
    const copyBtn = document.getElementById('brief-cot-popup-copy');
    if (copyBtn) copyBtn.onclick = async () => {
      const ta = document.getElementById('brief-cot-popup-text');
      if (!ta) return;
      setStatus('Guardando…', 'var(--fg-subtle)');
      try {
        await navigator.clipboard.writeText(ta.value);
      } catch (e) {
        ta.select(); document.execCommand('copy');
      }
      const sheetResp = await saveCotToSheetFromPopup();
      if (sheetResp.error) setStatus('⚠ copiado, pero falló Sheet: ' + sheetResp.error, '#FFA726');
      else setStatus(`✓ copiado y guardado en Sheet (fila ${sheetResp.row || '?'})`);
    };

    // 📤 Enviar por WhatsApp — manda el texto al cliente via API, guarda en
    // Sheet, marca el brief como enviado y cierra los modales. Solo aparece
    // cuando origen=wpp + tel válido.
    const sendWaBtn = document.getElementById('brief-cot-popup-send-wa');
    if (sendWaBtn) sendWaBtn.onclick = async () => {
      if (!STATE.briefSelected) return;
      const briefId = STATE.briefSelected;
      if (STATE.briefsEnviando[briefId]) return;
      const brief = STATE.briefs.find(b => b.id === briefId);
      if (!brief) return;
      const telDigits = String(brief.cliente_wa_id || '').replace(/\D/g, '');
      if (telDigits.length < 8) {
        await showAlert('Falta el teléfono del cliente o es inválido.', { title: 'Falta teléfono', variant: 'warn' });
        return;
      }
      if (!STATE.token) {
        await showAlert('Tenés que estar logueado para enviar por WhatsApp.', { title: 'Login requerido', variant: 'warn' });
        return;
      }
      if (!CONFIG.trackerUrl) { await showAlert('Tracker no configurado', { title: 'Error', variant: 'warn' }); return; }
      const ta = document.getElementById('brief-cot-popup-text');
      const texto = (ta?.value || '').trim();
      if (!texto) { await showAlert('El texto del presupuesto está vacío.', { title: 'Sin texto', variant: 'warn' }); return; }

      const tieneRender = (STATE.briefDetailImages || []).some(x => x.tipo === 'render');
      const ok = await showConfirm(
        `Voy a mandarle al WhatsApp +${telDigits} ${tieneRender ? 'el render con el presupuesto de pie de foto' : 'el presupuesto'} y marcar el brief como enviado.\n\n¿Confirmás?`,
        { title: 'Enviar presupuesto', confirmLabel: '📤 Mandar', cancelLabel: 'Cancelar' }
      ).catch(() => false);
      if (!ok) return;

      STATE.briefsEnviando[briefId] = true;
      setStatus('Enviando por WhatsApp…', 'var(--fg-subtle)');
      // Re-render del modal para que el botón muestre "⏳ Enviando…".
      render();

      let waOk = false, wamid = '';
      try {
        // Mandamos el RENDER del brief como foto con el presupuesto de caption
        // (un solo mensaje). El worker resuelve la imagen desde R2; si el brief
        // no tiene render, manda solo el texto.
        const r = await fetch(CONFIG.trackerUrl + '/admin/wa/send-brief-presupuesto', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ brief_id: briefId, to: telDigits, caption: texto })
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok) {
          waOk = true;
          wamid = j.id || '';
        } else {
          const detail = j.error || 'no se pudo enviar';
          // Ventana de 24h cerrada (el worker no intentó el envío libre porque Meta
          // lo rechaza): mandamos el presupuesto como PLANTILLA aprobada (1 diseño).
          const windowClosed = j.window_closed || /outside|24|window|template|131047|re-?engag/i.test(String(detail));
          if (windowClosed) {
            const sent = await enviarPresupuestoComoPlantilla(telDigits, getCarteles(), j.render_key);
            if (sent.cancelled) { render(); return; }
            if (!sent.ok) { await showAlert(sent.error || 'No se pudo mandar la plantilla.', { title: 'No se pudo enviar', variant: 'warn' }); return; }
            waOk = true; wamid = sent.wamid || '';
          } else {
            await showAlert(detail, { title: 'No se pudo enviar', variant: 'warn' });
            return;
          }
        }
      } catch (e) {
        await showAlert('Error de red al enviar: ' + (e.message || e), { title: 'Error de conexión', variant: 'warn' });
      } finally {
        STATE.briefsEnviando[briefId] = false;
      }

      if (!waOk) { render(); return; }

      // CHECK 2 — guardar en el Sheet del cotizador Joaco.
      let sheetOk = false;
      try {
        const sheetResp = await saveCotToSheetFromPopup();
        sheetOk = !sheetResp.error;
        if (sheetResp.error) console.warn('Sheet falló:', sheetResp.error);
      } catch(e) { console.warn('Sheet exception:', e); }

      // CHECK 3 cumplido (API ok = waOk) + tel (gate) + sheet → marcar enviado.
      // El precio guardado usa la fórmula ACTIVA (la nueva) para que matchee el Sheet.
      try {
        const calc = (function(){ try { return calcCotizadorActivo(STATE.cotizadorForm); } catch(e){ return null; } })();
        const updated = await marcarBriefEnviado(briefId, calc ? { precio_final: calc.transFinal } : {});
        const i = STATE.briefs.findIndex(b => b.id === updated.id);
        if (i >= 0) STATE.briefs[i] = updated;
      } catch (e) {
        console.warn('No pude marcar brief como enviado:', e);
      }

      toast(sheetOk ? '✓ Presupuesto enviado · brief pasó a "Enviados"' : '✓ Enviado y marcado · ⚠ no se guardó en el Sheet');
      // Polling de delivery en background — no bloquea el cierre.
      if (wamid) verificarEntregaWA(wamid, telDigits);

      closeBriefCotizadorPopup();
      closeBriefDrawer();
    };

    // 📋 (IG) Copiar y marcar como enviado — copia al clipboard, guarda en el
    // Sheet y marca el brief como enviado, SIN teléfono ni verificación API.
    // Joaco lo usa para consultas de Instagram (lo pega en el DM a mano).
    const copyIgBtn = document.getElementById('brief-cot-popup-copy-ig');
    if (copyIgBtn) copyIgBtn.onclick = async () => {
      if (!STATE.briefSelected) return;
      const briefId = STATE.briefSelected;
      if (STATE.briefsEnviando[briefId]) return;
      const ta = document.getElementById('brief-cot-popup-text');
      const texto = (ta?.value || '').trim();
      if (!texto) { await showAlert('El texto del presupuesto está vacío.', { title: 'Sin texto', variant: 'warn' }); return; }
      STATE.briefsEnviando[briefId] = true;
      setStatus('Copiando y guardando…', 'var(--fg-subtle)');
      render();
      // 1) Clipboard.
      try { await navigator.clipboard.writeText(texto); } catch (e) { ta.select(); document.execCommand('copy'); }
      // 2) Sheet.
      let sheetOk = false;
      try { const sr = await saveCotToSheetFromPopup(); sheetOk = !sr.error; } catch (e) { console.warn('Sheet:', e); }
      // 3) Marcar enviado (sin API — IG no se verifica).
      try {
        const calc = (function(){ try { return calcCotizadorActivo(STATE.cotizadorForm); } catch(e){ return null; } })();
        const updated = await marcarBriefEnviado(briefId, calc ? { precio_final: calc.transFinal } : {});
        const i = STATE.briefs.findIndex(b => b.id === updated.id);
        if (i >= 0) STATE.briefs[i] = updated;
      } catch (e) { console.warn('marcar enviado:', e); }
      STATE.briefsEnviando[briefId] = false;
      toast(sheetOk ? '✓ Copiado · brief pasó a "Enviados". Pegalo en el DM de IG.' : '✓ Marcado enviado · ⚠ no guardó en Sheet. Pegalo en el DM.');
      closeBriefCotizadorPopup();
      closeBriefDrawer();
    };
  }

  // ===== Lightbox: click backdrop o botón cierra =====
  if (STATE.imgLightboxUrl) {
    const lb = document.getElementById('img-lightbox');
    if (lb) lb.onclick = (ev) => {
      // Solo cerrar si clickearon el fondo (no la imagen).
      if (ev.target.tagName !== 'IMG') closeImgLightbox();
    };
    const lbClose = document.getElementById('img-lightbox-close');
    if (lbClose) lbClose.onclick = (ev) => { ev.stopPropagation(); closeImgLightbox(); };
    // ESC también cierra.
    if (!document._lightboxEscBound) {
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && STATE.imgLightboxUrl) closeImgLightbox();
      });
      document._lightboxEscBound = true;
    }
  }

  // ===== Quick-create modal (paste/drop sobre A cotizar) =====
  bindQuickCreateModal();

  // ===== Team chat widget (flotante) =====
  const fab = document.getElementById('team-chat-fab');
  if (fab) fab.onclick = openTeamChat;
  const minBtn = document.getElementById('team-chat-min');
  if (minBtn) minBtn.onclick = closeTeamChat;
  const tcSend = document.getElementById('team-chat-send');
  if (tcSend) tcSend.onclick = handleTeamChatSend;
  const tcInput = document.getElementById('team-chat-input');
  if (tcInput) tcInput.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); handleTeamChatSend(); } };
  const tcAttach = document.getElementById('team-chat-attach');
  const tcFile = document.getElementById('team-chat-file');
  if (tcAttach && tcFile) {
    tcAttach.onclick = () => tcFile.click();
    tcFile.onchange = async (ev) => {
      const files = Array.from(ev.target.files || []);
      for (const f of files) await handleTeamChatImage(f);
      tcFile.value = '';
    };
  }
  // Paste de imagen dentro de la ventana de chat.
  if (STATE.teamChatOpen && tcInput && !tcInput._pasteBound) {
    tcInput.addEventListener('paste', async (ev) => {
      const items = ev.clipboardData?.items || [];
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          ev.preventDefault();
          const file = item.getAsFile();
          if (file) await handleTeamChatImage(file);
        }
      }
    });
    tcInput._pasteBound = true;
  }
  // Bind zoom de imágenes ya presentes en el chat.
  if (STATE.teamChatOpen) {
    document.querySelectorAll('#team-chat-list [data-img-zoom]').forEach(el => {
      el.onclick = (ev) => { ev.stopPropagation(); openImgLightbox(el.dataset.imgZoom); };
    });
  }
  // Carga inicial del chat (para el badge de no leídos) aunque esté minimizado.
  if (!STATE.teamChatLoaded) {
    fetchTeamChat().then(() => {
      // Inicializar el cursor del poll para no notificar mensajes viejos al entrar.
      if (STATE.teamChatMessages.length) _teamChatLastMsgTs = STATE.teamChatMessages[STATE.teamChatMessages.length - 1].created_at;
      render();
    });
  }
  // Polling activo mientras estés en la vista Cotización (avisa con sonido + notif).
  startTeamChatPolling();
  // Pedir permiso de notificaciones del navegador (una vez).
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  } catch (e) {}
}

// Re-bind table when pedidos view rendered after data loads
function rerenderTablePedidosIfNeeded() { if (STATE.view === 'pedidos') renderTablePedidos(); }
const _origRender = render;
render = function() {
  _origRender.apply(this, arguments);
  if (STATE.loaded) {
    if (STATE.view === 'pedidos') renderTablePedidos();
    else if (STATE.view === 'presupuestos') renderTablePresupuestos();
  }
};
