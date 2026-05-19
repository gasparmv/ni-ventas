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
  cotizadorForm: { ancho: '', alto: '', neon: '', tipo: 'INT', cliente: '', canal: 'WPP', telefono: '', textoOverride: '', extraCarteles: [] },
  cotizadorSaving: false,
  // Panel de negocio (solo Gaspar) — datos del Sheet "2025 V4"
  businessPanel: { data: null, loading: false, error: null, lastFetch: 0, period: 'current', selectedVertical: null },
  // Privacy mode: oculta números económicos (estilo billetera virtual)
  privacy: (() => { try { return localStorage.getItem('privacy_mode') === '1'; } catch(_) { return false; } })()
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
  const c1 = { cliente: f.cliente, ancho: f.ancho, alto: f.alto, neon: f.neon, tipo: f.tipo || 'INT' };
  const extras = Array.isArray(f.extraCarteles) ? f.extraCarteles : [];
  return [c1, ...extras].filter(c => +c.ancho > 0 && +c.alto > 0);
}

function buildPresupuestoTexto() {
  const carteles = getCarteles();
  if (carteles.length === 0) return null;
  const p = getCotizadorParams();

  const closing = `\n\nControladores opcionales\n\nSlim: ${fmtMoney(p.ctrl_slim)}\n\nControl remoto: ${fmtMoney(p.ctrl_remoto)}\n\nApp: ${fmtMoney(p.ctrl_app)}\n\nPara iniciar el trabajo, se requiere el 50% del total en concepto de seña.\n\nTiempo de armado: 15/20 días.\n\nTodos los medios de pago!\n\nHacemos envíos GRATIS a todo el país!`;

  if (carteles.length === 1) {
    const c = carteles[0];
    const r = calcCotizador(c);
    const nombre = (c.cliente || '').trim() || 'Custom name';
    return `Te comparto la información detallada!\n\nTrabajo: ${nombre}\nMedidas: ${Math.round(+c.ancho)}x${Math.round(+c.alto)}\nBase transparente: ${fmtMoney(r.transFinal)}\nBase negra: ${fmtMoney(r.negroFinal)}${closing}`;
  }

  // 2+ carteles — cada uno con su propio nombre de diseño
  let totalTrans = 0, totalNegro = 0;
  const bloques = carteles.map((c, i) => {
    const r = calcCotizador(c);
    totalTrans += r.transFinal;
    totalNegro += r.negroFinal;
    const disen = (c.cliente || '').trim() || `Cartel ${i+1}`;
    return `${disen} — ${Math.round(+c.ancho)}x${Math.round(+c.alto)} cm\nBase transparente: ${fmtMoney(r.transFinal)}\nBase negra: ${fmtMoney(r.negroFinal)}`;
  }).join('\n\n');

  const trabajo = carteles.map(c => (c.cliente || '').trim()).filter(Boolean).join(' · ') || 'Custom name';
  return `Te comparto la información detallada!\n\nTrabajo: ${trabajo}\n\n${bloques}\n\nTotal transparente: ${fmtMoney(totalTrans)}\nTotal negro: ${fmtMoney(totalNegro)}${closing}`;
}

function getPresupuestoTextoFinal() {
  // Si el usuario editó manualmente, usamos esa versión. Si no, la auto-generada.
  const override = STATE.cotizadorForm.textoOverride;
  return (override && override.trim()) ? override : buildPresupuestoTexto();
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
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ to: tel, body: texto })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const detail = j.error || 'no se pudo enviar';
      // Caso típico fuera de ventana 24hs:
      const hint = /outside|24|window|template/i.test(String(detail))
        ? '\n\nWhatsApp Cloud API solo permite mensajes libres si el cliente escribió en las últimas 24hs. Si el cliente nunca habló al número, hay que mandar primero un template aprobado.'
        : '';
      await showAlert(detail + hint, { title: 'No se pudo enviar', variant: 'warn' });
      return;
    }
    waOk = true;
    wamid = j.id || '';
    // OJO: r.ok solo significa que Meta aceptó el request — no que entregó.
    // El webhook puede marcarlo como 'failed' después.
    toast('Mandado a WhatsApp · verificando entrega…');
  } catch (e) {
    await showAlert('Error de red al enviar', { title: 'Error de conexión', variant: 'warn' });
  } finally {
    STATE.cotizadorSendingWA = false;
    updateCotizadorForm();
  }
  // Si el envío salió bien, guardar también en Sheet (un envío = un presupuesto registrado).
  if (waOk) {
    await saveCotizacion();
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
    m.status === 'failed' &&
    (m.body || '').startsWith(PRESUPUESTO_PREFIX)
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

const PRESUPUESTO_PREFIX = 'Te comparto la información detallada!';
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

  // 2) Filtrar presupuestos del cotizador (texto que arranca con el prefijo conocido)
  const presupuestos = outbound.filter(m => (m.body || '').startsWith(PRESUPUESTO_PREFIX));

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
      const r = calcCotizador(c);
      const payload = {
        cliente: c.cliente.trim(),
        ancho: +c.ancho,
        alto: +c.alto,
        neon: +c.neon || 0,
        tipo: c.tipo || 'INT',
        m2: r.m2,
        trans: r.trans,
        negro: r.negro,
        descuento: r.descuento,
        recargo: r.recargo,
        reventa: r.reventa,
        comision: r.comision,
        canal,
        telefono: telFinal
      };
      await postCartelToSheet(payload);
    }
    STATE.cotizadorForm = { ancho: '', alto: '', neon: '', tipo: 'INT', cliente: '', canal: 'WPP', telefono: '', textoOverride: '', extraCarteles: [] };
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
// Normaliza nombre de usuario para comparaciones tolerantes a tilde.
// Soporta variantes históricas en localStorage (Joaquin / Joaquín).
function _userKey(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function isJoaquinUser(s) { return _userKey(s) === 'joaquin'; }
function isGasparUser(s) { return _userKey(s) === 'gaspar'; }

async function setUser(name) {
  // Gaspar necesita password; Joaquín se auto-loguea sin password
  if (isGasparUser(name) && !STATE.token) {
    const ok = await loginPrompt(name);
    if (!ok) return;
  } else if (isJoaquinUser(name) && !STATE.token) {
    const ok = await autoLogin(name);
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
  const pw = prompt('Contraseña de admin:');
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
    saveToken(j.token);
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
    saveToken(j.token);
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
function isAdmin() { return !!STATE.token && STATE.user === 'Gaspar'; }
function canAccessChat() { return !!STATE.token && (isGasparUser(STATE.user) || isJoaquinUser(STATE.user)); }
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
    const all = await Promise.all([
      fetchSheet(CONFIG.ventasSheetId, CONFIG.ventasSheetName),
      ...CONFIG.cotizadorSheets.map(async sheet => {
        let rows = await fetchCotizadorViaAppsScript(sheet);
        if (!rows) rows = await fetchSheet(CONFIG.cotizadorSheetId, sheet);
        return { sheet, rows };
      }),
      ...(CONFIG.cotizadorHistoricalSheets || []).map(async ({ name, month }) => {
        const rows = await fetchSheet(CONFIG.cotizadorSheetId, name);
        return { historical: true, name, month, rows };
      })
    ]);
    const ventasRows = all[0];
    const cotizadorResults = all.slice(1, 1 + cotizadorN);
    const historicalResults = all.slice(1 + cotizadorN, 1 + cotizadorN + histN);
    if (!ventasRows) throw new Error('No se pudo cargar el Sheet "Ventas/2026". Verificá que esté público.');
    STATE.pedidos = parseVentas(ventasRows);
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
    if (v === 'dashboard')      document.getElementById('main').innerHTML = isAdmin() ? renderBusinessPanel() : renderDashboard();
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
  if (appEl) {
    appEl.classList.toggle('app--chat', STATE.view === 'chat');
    if (STATE.view !== 'chat') appEl.classList.remove('app--chat-full');
  }
  bindNav();
  bindCommon();
  if (STATE.view === 'pedidos') bindPedidos();
  if (STATE.view === 'presupuestos') bindPresupuestos();
  if (STATE.view === 'seguimientos') bindSeguimientos();
  if (STATE.view === 'dashboard') {
    if (isAdmin()) bindBusinessPanel();
    else drawCharts();
  }
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
        <div class="user-pick-label">Usuario ${canAccessChat() ? '<span class="admin-tag">' + (isAdmin() ? 'admin' : 'chat') + '</span>' : ''}</div>
        <div class="user-pick-chips">
          ${STATE.users.map(u => {
            const locked = u === 'Gaspar' && !STATE.token;
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
        ${canAccessChat() ? `<button class="nav-item ${v==='chat'?'active':''}" data-view="chat"><span class="icon">✉</span> Chat WA
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

    ${(() => {
      const tc = getTasaCierreDirecto(STATE.dashMonths);
      return `<div class="kpi-grid">
        <div class="kpi"><div class="kpi-label">Ventas mes</div><div class="kpi-value">${fmtMoney(totalMes)}</div><div class="kpi-delta">${cur.length} pedidos</div></div>
        <div class="kpi cyan"><div class="kpi-label">Ticket promedio</div><div class="kpi-value">${fmtMoney(aov)}</div><div class="kpi-delta">AOV mes</div></div>
        <div class="kpi"><div class="kpi-label">% Cobrado</div><div class="kpi-value">${pctCobrado}%</div><div class="kpi-delta">${fmtMoney(cobrado)} / ${fmtMoney(totalMes)}</div></div>
        <div class="kpi cyan"${tc.partial ? ' title="Datos parciales: tracking empezó el ' + fmtDate(tc.trackingStart) + '"' : ''}><div class="kpi-label">Tasa de cierre${tc.partial ? ' <span class="partial-flag">parcial</span>' : ''}</div><div class="kpi-value">${(tc.tasa*100).toFixed(1)}%</div><div class="kpi-delta">${tc.vendidos} ventas / ${tc.enviados} presu${tc.partial ? ' · desde ' + fmtDate(tc.trackingStart) : ''}</div></div>
        <div class="kpi"><div class="kpi-label">Total año</div><div class="kpi-value">${fmtMoney(STATE.pedidos.reduce((a,p)=>a+p.precio+p.precioDimmer,0))}</div><div class="kpi-delta">${STATE.pedidos.length} pedidos · año</div></div>
      </div>`;
    })()}

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

  const verticals = {
    directo: { count: directo.length, ventas: sumVenta(directo), costos: sumCostosD(directo) },
    distris: { count: distris.length, ventas: sumVenta(distris), costos: sumCostosD(distris) },
    insumos: { count: insumos.length, ventas: sumVenta(insumos), costos: insumos.reduce((a,r)=>a+(r.costo||0),0) },
    cursos:  { count: cursos.length,  ventas: sumVenta(cursos),  costos: cursos.reduce((a,r)=>a+(r.comisionMp||0),0) },
  };
  for (const k of Object.keys(verticals)) {
    const v = verticals[k];
    v.aov = v.count ? v.ventas / v.count : 0;
    v.margen = v.ventas - v.costos;
    v.margenPct = v.ventas ? (v.margen / v.ventas) : 0;
  }
  const total = {
    count: Object.values(verticals).reduce((a,v)=>a+v.count,0),
    ventas: Object.values(verticals).reduce((a,v)=>a+v.ventas,0),
    costos: Object.values(verticals).reduce((a,v)=>a+v.costos,0),
    fijos: 0,
  };
  total.aov = total.count ? total.ventas / total.count : 0;
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
        verticals[v].aov = verticals[v].count ? pv.ingresos / verticals[v].count : 0;
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

  // # carteles total (directo + distris)
  const totalCarteles = directo.length + distris.length;
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
        <div class="kpi"><div class="kpi-label">Ventas</div><div class="kpi-value">${bpFmt(c.total.ventas)}</div><div class="kpi-delta">${c.total.count} ventas</div></div>
        <div class="kpi cyan"><div class="kpi-label">Costos totales</div><div class="kpi-value">${bpFmt(c.total.costos)}</div><div class="kpi-delta">${c.total.fijos ? 'Fijos: ' + bpFmt(c.total.fijos) : Math.round((c.total.costos/Math.max(1,c.total.ventas))*100) + '% s/ ventas'}</div></div>
        <div class="kpi"><div class="kpi-label">Margen operativo (CMA)</div><div class="kpi-value" style="color:${c.total.margen >= 0 ? 'var(--success, #25D366)' : 'var(--neon-red)'}">${bpFmt(c.total.margen)}</div><div class="kpi-delta">${Math.round(c.total.margenPct*100)}% del ingreso</div></div>
        <div class="kpi cyan"><div class="kpi-label">Ticket promedio</div><div class="kpi-value">${bpFmt(c.total.aov)}</div><div class="kpi-delta">AOV global</div></div>
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
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:18px;padding-top:14px;border-top:1px solid var(--border)">
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
        <div style="padding:20px;display:grid;grid-template-columns:repeat(3,1fr);gap:18px">
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
    let cmp;
    if (va instanceof Date) cmp = (va - vb) * pedidoSort.dir;
    else if (typeof va === 'number') cmp = (va - vb) * pedidoSort.dir;
    else cmp = String(va).localeCompare(String(vb)) * pedidoSort.dir;
    return cmp || (b.idx - a.idx); // tiebreaker: orden del sheet (más nuevos primero)
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
let pptoSearch = '';
function bindPresupuestos() {
  document.querySelectorAll('[data-ppfilter]').forEach(el => {
    el.onclick = () => { pptoFilter = el.dataset.ppfilter; renderPresupuestos(); render(); };
  });
  const searchInput = document.querySelector('[data-pp-search]');
  if (searchInput) {
    searchInput.addEventListener('input', () => { pptoSearch = searchInput.value; renderTablePresupuestos(); });
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
      if (!STATE.cotizadorForm.extraCarteles[idx]) STATE.cotizadorForm.extraCarteles[idx] = { cliente:'', ancho:'', alto:'', neon:'', tipo:'INT' };
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
    STATE.cotizadorForm.extraCarteles.push({ cliente:'', ancho:'', alto:'', neon:'', tipo:'INT' });
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
let pptoShowCotizador = false;

function renderCotizadorResults() {
  const f = STATE.cotizadorForm;
  const valid = +f.ancho > 0 && +f.alto > 0;
  if (!valid) return '<div class="muted" style="margin-top:var(--s-2);font-size:12px">Completá ancho y alto para ver los precios</div>';
  const carteles = getCarteles();
  const p = getCotizadorParams();
  const multi = carteles.length > 1;
  const r = calcCotizador(carteles[0] || f);

  const blocksHtml = multi ? carteles.map((c, i) => {
    const rr = calcCotizador(c);
    const disen = (c.cliente || '').trim() || `Cartel ${i+1}`;
    return `
      <div class="cot-block" style="border:1px solid var(--border);border-radius:var(--r-sm);padding:var(--s-2);margin-bottom:var(--s-2)">
        <div style="font-size:11px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">${escapeHtml(disen)} · ${Math.round(+c.ancho)}×${Math.round(+c.alto)} cm · m² ${rr.m2.toFixed(2)}</div>
        <div class="cot-result-grid">
          <div class="cot-result"><div class="lbl">Transparente</div><div class="val">${rr.transFinal !== rr.trans ? '<s style="opacity:.4;font-size:12px">'+fmtMoney(rr.trans)+'</s> ' : ''}${fmtMoney(rr.transFinal)}</div></div>
          <div class="cot-result"><div class="lbl">Negro</div><div class="val">${rr.negroFinal !== rr.negro ? '<s style="opacity:.4;font-size:12px">'+fmtMoney(rr.negro)+'</s> ' : ''}${fmtMoney(rr.negroFinal)}</div></div>
        </div>
      </div>`;
  }).join('') : '';

  const totalTrans = carteles.reduce((s, c) => s + calcCotizador(c).transFinal, 0);
  const totalNegro = carteles.reduce((s, c) => s + calcCotizador(c).negroFinal, 0);

  return `
    <div class="cot-results">
      ${multi ? `
        ${blocksHtml}
        <div class="cot-result-grid" style="border-top:2px solid var(--accent-cyan);padding-top:var(--s-2);margin-top:var(--s-2)">
          <div class="cot-result"><div class="lbl">Total transparente</div><div class="val"><b>${fmtMoney(totalTrans)}</b></div></div>
          <div class="cot-result"><div class="lbl">Total negro</div><div class="val"><b>${fmtMoney(totalNegro)}</b></div></div>
        </div>
      ` : `
      <div class="cot-meta">m² (sheet): <b>${r.m2.toFixed(2)}</b></div>
      <div class="cot-result-grid">
        <div class="cot-result"><div class="lbl">Transparente</div><div class="val">${r.transFinal !== r.trans ? '<s style="opacity:.4;font-size:12px">'+fmtMoney(r.trans)+'</s> ' : ''}${fmtMoney(r.transFinal)}</div></div>
        <div class="cot-result"><div class="lbl">Negro</div><div class="val">${r.negroFinal !== r.negro ? '<s style="opacity:.4;font-size:12px">'+fmtMoney(r.negro)+'</s> ' : ''}${fmtMoney(r.negroFinal)}</div></div>
        <div class="cot-result"><div class="lbl">Reventa (×${p.reventa_mult})</div><div class="val">${fmtMoney(r.reventa)}</div></div>
        <div class="cot-result"><div class="lbl">Comisión (${(p.comision_pct*100).toFixed(0)}%)</div><div class="val">${fmtMoney(r.comision)}</div></div>
        ${r.descuento ? '<div class="cot-result"><div class="lbl">Descuento (m²>'+p.descuento_min_m2+')</div><div class="val">×'+p.descuento_mult+'</div></div>' : ''}
        ${r.recargo ? '<div class="cot-result"><div class="lbl">Recargo (m²≤'+(r.m2<=5?'5':r.m2<=12.5?'12.5':'25')+')</div><div class="val">×'+(r.m2<=5?p.recargo_5:r.m2<=12.5?p.recargo_125:p.recargo_25)+'</div></div>' : ''}
      </div>
      `}
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
      <div id="cot-results-slot">${renderCotizadorResults()}</div>
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
  const privacyBtn = document.querySelector('[data-privacy-toggle]');
  if (privacyBtn) privacyBtn.onclick = () => togglePrivacy();
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
  requestAnimationFrame(() => bg.classList.add('open'));
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
  // Full-text search (busca en historial completo de mensajes, no solo el último)
  searchResults: { contacts: [], messages: [], q: '' },
  searchLoading: false,
  _searchTimer: null,
  highlightWamid: null, // wamid del mensaje a destacar al abrir un chat (de búsqueda)
  // Nombres de contacto sincronizados desde WhatsApp (tabla wa_contacts en D1).
  // Map phone → name. Tiene prioridad sobre sender_name al renderizar la lista.
  waContactNames: {},
  waContactNamesLoaded: false,
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
async function saveQuickReply(shortcut, body, mediaR2Key) {
  await fetch(CONFIG.trackerUrl + '/admin/quick-replies', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ shortcut, body, media_r2_key: mediaR2Key || null })
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

// ===== WA Contact Names (sincronizados desde la agenda del 6573 vía scraper) =====
async function loadWaContactNames() {
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/contacts', { headers: authHeaders() });
    if (!r.ok) return;
    const j = await r.json();
    const map = {};
    for (const c of (j.contacts || [])) {
      if (c?.phone && c?.name) map[c.phone] = c.name;
    }
    chatState.waContactNames = map;
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
  const lbl = chatState.labels.find(l => l.id === labelId);
  const lblName = lbl?.name || 'etiqueta';
  if (current.includes(labelId)) {
    await fetch(CONFIG.trackerUrl + '/admin/contact-labels', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ phone, label_id: labelId })
    });
    chatState.contactLabels[phone] = current.filter(id => id !== labelId);
    toast(`✗ ${lblName}`);
  } else {
    await fetch(CONFIG.trackerUrl + '/admin/contact-labels', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ phone, label_id: labelId })
    });
    if (!chatState.contactLabels[phone]) chatState.contactLabels[phone] = [];
    chatState.contactLabels[phone].push(labelId);
    toast(`✓ ${lblName}`);
  }
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
    requestAnimationFrame(() => bg.classList.add('open'));

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
  try {
    const fd = new FormData();
    fd.append('to', phone);
    fd.append('type', type);
    fd.append('caption', caption || '');
    fd.append('file', file);
    if (replyTo) fd.append('reply_to', replyTo);
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/send-media', {
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
    <input type="file" id="chat-file-input" accept="image/*,video/*,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/zip,text/plain" multiple style="display:none">
    <textarea id="chat-input" placeholder="Escribí un mensaje" rows="1"></textarea>
    <button class="btn-send" id="chat-send-btn" ${chatState.sending ? 'disabled' : ''} title="Enviar"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M1.101 21.757L23.8 12.028 1.101 2.3l.011 7.912 13.239 1.816-13.239 1.817-.011 7.912z"/></svg></button>
    <button class="btn-send btn-schedule" id="btn-schedule" title="Programar mensaje"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg></button>
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
    badge.textContent = chatState.totalUnread || '';
    badge.style.display = chatState.totalUnread ? '' : 'none';
  }
}

async function loadChatContacts() {
  if (!canAccessChat()) return;
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
      if (!m.phone) continue;
      // Status sin body = mensaje saliente desde WA Business app/web (placeholder).
      // Lo incluimos para bumpear el chat y que se vea actividad, pero
      // los status con body genuinamente vacíos los dejamos pasar como tal.
      const isStatusPlaceholder = m.msg_type === 'status' && m.direction === 'outbound' && !m.body;
      if (m.msg_type === 'status' && !isStatusPlaceholder) continue;
      if (!byPhone.has(m.phone)) {
        byPhone.set(m.phone, { phone: m.phone, name: '', messages: [], lastTs: m.ts });
      }
      const c = byPhone.get(m.phone);
      c.messages.push(m);
      // Always prefer the most recent non-empty sender_name
      if (m.sender_name && m.direction === 'inbound') c.name = m.sender_name;
      if (m.ts > c.lastTs) c.lastTs = m.ts;
    }
    // Ordenar contactos por último mensaje
    const waNames = chatState.waContactNames || {};
    chatState.contacts = Array.from(byPhone.values())
      .map(c => {
        c.messages.sort((a, b) => a.ts.localeCompare(b.ts));
        const last = c.messages[c.messages.length - 1];
        const unread = countUnread(c.phone, c.messages);
        // Prioridad de nombre: wa_contacts (agenda real) > sender_name de inbound > vacío
        const displayName = waNames[c.phone] || c.name || '';
        return {
          phone: c.phone,
          name: displayName,
          lastMsg: last ? (
            last.msg_type === 'revoke' ? 'Mensaje eliminado' :
            (last.msg_type === 'status' && last.direction === 'outbound' && !last.body) ? '✓ Respondido desde WhatsApp' :
            (last.body || `[${last.msg_type}]`)
          ).slice(0, 60) : '',
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

async function loadChatMessages(phone, opts) {
  if (!canAccessChat() || !phone) return;
  const isInitialLoad = !opts?.incremental && (!chatState.messages.length || chatState.messages[0]?.phone !== phone);
  try {
    // Initial load: limit alto (2000) para traer todo el historial visible.
    // Incremental (polling): solo deltas desde el último ts conocido.
    let url = CONFIG.trackerUrl + '/admin/wa/messages?phone=' + encodeURIComponent(phone);
    if (isInitialLoad) {
      url += '&limit=2000';
    } else {
      const lastTs = chatState.messages.length ? chatState.messages[chatState.messages.length - 1].ts : '';
      // Pedir solo los mensajes desde el último ts conocido (incluso un poco antes
      // para capturar status updates de mensajes recientes).
      const sinceTs = lastTs ? new Date(new Date(lastTs).getTime() - 60000).toISOString() : '';
      url += '&limit=500' + (sinceTs ? '&from=' + encodeURIComponent(sinceTs) : '');
    }
    const r = await fetch(url, { headers: authHeaders() });
    if (!r.ok) return;
    const j = await r.json();
    const fresh = (j.messages || []).filter(m => m.msg_type !== 'status');

    // Merge: preservar TODOS los mensajes locales que tienen wamid (vienen del
    // servidor en cargas anteriores), y agregar/actualizar los nuevos del fetch.
    // Antes el comportamiento era reemplazar el array entero, lo que hacía que
    // mensajes viejos "desaparecieran" en chats con >500 mensajes.
    const byKey = new Map();
    const keyOf = (m) => m.wamid || ('ts:' + m.ts + ':' + m.direction);
    // Si es initial load: empezar desde cero con lo que vino del server.
    // Si es incremental: empezar con los mensajes existentes y sumar/actualizar.
    if (!isInitialLoad) {
      for (const m of chatState.messages) {
        byKey.set(keyOf(m), m);
      }
    }
    // Agregar/actualizar con los frescos del server (server gana en caso de conflict)
    for (const m of fresh) {
      byKey.set(keyOf(m), m);
    }
    // Conservar mensajes optimistic locales (sin wamid, recién enviados)
    if (!isInitialLoad) {
      for (const local of chatState.messages) {
        if (local.wamid) continue;
        // Sin wamid = optimistic recién enviado, conservar si no apareció en server
        const k = keyOf(local);
        if (!byKey.has(k)) byKey.set(k, local);
      }
    }
    const merged = [...byKey.values()].sort((a, b) => a.ts.localeCompare(b.ts));
    chatState.messages = merged;
  } catch (e) {
    console.error('chat messages error:', e);
  }
}

async function sendChatMessage(phone, text) {
  if (!canAccessChat() || !phone || !text.trim()) return;
  chatState.sending = true;
  updateChatInputState();
  const replyTo = chatState.replyingTo || '';
  try {
    const r = await fetch(CONFIG.trackerUrl + '/admin/wa/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ to: phone, body: text.trim(), reply_to: replyTo || undefined })
    });
    const j = await r.json();
    if (!r.ok) {
      toast('Error: ' + (j.error || 'no se pudo enviar'));
      return;
    }
    chatState.messages.push({
      ts: new Date().toISOString(),
      wamid: j.id || '',
      direction: 'outbound',
      phone: phone,
      sender_name: '',
      msg_type: 'text',
      body: text.trim(),
      context_id: replyTo || '',
      status: 'sent'
    });
    chatState.replyingTo = null;
    renderReplyBanner();
    renderChatMessages();
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

// ===== Scheduled messages =====
function showScheduleModal(phone) {
  const ta = document.getElementById('chat-input');
  const text = ta?.value?.trim();
  if (!text) { toast('Escribí un mensaje primero'); return; }
  // Default: tomorrow 8:00 AR
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const defaultDate = tomorrow.toISOString().slice(0, 10);
  const modal = document.createElement('div');
  modal.className = 'schedule-modal-overlay';
  modal.innerHTML = `
    <div class="schedule-modal">
      <h3 style="margin:0 0 12px">Programar mensaje</h3>
      <div class="schedule-preview">${escapeHtml(text).replace(/\n/g, '<br>')}</div>
      <div style="display:flex;gap:8px;margin:12px 0">
        <div style="flex:1">
          <label style="font-size:12px;color:#8696a0">Fecha</label>
          <input type="date" id="sched-date" value="${defaultDate}" style="width:100%;padding:8px;border-radius:6px;border:1px solid #3b4a54;background:#2a3942;color:#e9edef">
        </div>
        <div style="flex:1">
          <label style="font-size:12px;color:#8696a0">Hora (Argentina)</label>
          <input type="time" id="sched-time" value="08:00" style="width:100%;padding:8px;border-radius:6px;border:1px solid #3b4a54;background:#2a3942;color:#e9edef">
        </div>
      </div>
      <div id="sched-pending-list" style="margin:8px 0"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
        <button id="sched-cancel" class="btn-action" style="background:#3b4a54">Cancelar</button>
        <button id="sched-confirm" class="btn-action" style="background:#00a884">Programar</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector('#sched-cancel').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  // Load pending scheduled messages for this phone
  loadPendingScheduled(phone, modal.querySelector('#sched-pending-list'));
  modal.querySelector('#sched-confirm').onclick = async () => {
    const date = modal.querySelector('#sched-date').value;
    const time = modal.querySelector('#sched-time').value;
    if (!date || !time) { toast('Elegí fecha y hora'); return; }
    // Convert AR time to UTC (AR = UTC-3)
    const arDate = new Date(`${date}T${time}:00-03:00`);
    const utc = arDate.toISOString();
    if (arDate <= new Date()) { toast('La fecha debe ser futura'); return; }
    try {
      const r = await fetch(CONFIG.trackerUrl + '/admin/wa/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ phone, body: text, scheduled_at: utc })
      });
      const j = await r.json();
      if (!r.ok) { toast('Error: ' + (j.error || 'fallo')); return; }
      toast(`Programado para ${date} ${time} AR`);
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
      ${chatState.labels.map(l => `<button type="button" class="label-toggle-chip" data-lbl-id="${l.id}" style="--lc:${l.color}" aria-pressed="false">${escapeHtml(l.name)}</button>`).join('')}
    </div>
    <div id="bulk-count" style="color:#8696a0;font-size:12px;margin:6px 0"></div>
    <textarea id="bulk-msg" placeholder="Escribí el mensaje..." rows="3" class="bulk-textarea"></textarea>
    <button class="btn btn-cyan" id="bulk-send-btn" style="margin-top:8px;width:100%">Enviar masivo</button>
    <div id="bulk-result" style="margin-top:6px;font-size:13px"></div>
  </div>`;
}

function renderChat() {
  if (!canAccessChat()) {
    return `<div class="page-head"><h1>Chat WhatsApp</h1></div><div class="error">No autorizado. Logueate con un usuario autorizado.</div>`;
  }
  const search = chatState.search.toLowerCase();
  let filtered = chatState.contacts;
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
          <button id="chat-fullscreen" class="chat-fullscreen-btn" title="Ocultar barra lateral">
            <svg class="ico-enter" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M5 5h5V3H3v7h2V5zm9-2v2h5v5h2V3h-7zm5 16h-5v2h7v-7h-2v5zM5 14H3v7h7v-2H5v-5z"/></svg>
            <svg class="ico-exit" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="display:none"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>
          </button>
          <div style="display:flex;gap:4px">
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
          </div>
        </div>
        <div class="chat-contacts-search">
          <input type="text" id="chat-search" placeholder="${chatState.showArchived ? 'Buscar en archivados…' : 'Buscar o empezar un chat nuevo'}" value="${escapeHtml(chatState.search)}">
        </div>
        ${chatState.showArchived ? '<div class="archived-banner">📦 Mostrando solo chats archivados</div>' : ''}
        ${renderLabelFilterBar()}
        <div class="chat-contact-list" id="chat-contact-list">
          ${chatState.loading && !chatState.contacts.length ? '<div style="padding:30px;text-align:center"><div class="spinner" style="border-color:#2a3942;border-top-color:#00a884"></div></div>' : ''}
          ${filtered.map(c => renderContactItem(c)).join('')}
          ${!chatState.loading && !filtered.length ? `<div class="chat-empty-state">${chatState.showArchived ? '<div class="chat-empty-emoji">📦</div>No hay chats archivados' : '<div class="chat-empty-emoji">👋</div>Sin conversaciones'}</div>` : ''}
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
    <div class="chat-messages" id="chat-messages">
      ${chatState.loadingConv
        ? '<div class="chat-loading"><div class="spinner" style="border-color:#2a3942;border-top-color:#00a884"></div></div>'
        : renderChatBubbles()}
    </div>
    <button class="chat-scroll-down" id="chat-scroll-down" title="Ir al final">
      <svg viewBox="0 0 19 20" width="18" height="18" fill="currentColor"><path d="M3.8 6.7l5.7 5.7 5.7-5.7 1.6 1.6-7.3 7.2-7.3-7.2 1.6-1.6z"/></svg>
    </button>
    ${render24hBanner()}
    <div class="chat-input-bar">
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
function quoteBlockHtml(m) {
  if (!m.context_id) return '';
  const parent = findMessageByWamid(m.context_id);
  if (!parent) return ''; // padre no esta cargado, no mostramos nada
  const parentDir = parent.direction || 'inbound';
  const isMine = parentDir === 'outbound';
  const author = isMine ? 'Vos' : (parent.sender_name || 'Cliente');
  let preview = '';
  if (parent.msg_type === 'image') preview = '📷 Imagen' + (parent.body ? ' · ' + parent.body : '');
  else if (parent.msg_type === 'audio') preview = '🎤 Audio';
  else if (parent.msg_type === 'video') preview = '🎬 Video';
  else if (parent.msg_type === 'document') preview = '📄 ' + (parent.body || 'Documento');
  else if (parent.msg_type === 'sticker') preview = 'Sticker';
  else preview = parent.body || '';
  preview = preview.slice(0, 120);
  return `<div class="chat-msg-quote ${isMine ? 'mine' : 'theirs'}" data-jump-to="${escapeHtml(m.context_id)}">
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

function renderChatBubbles() {
  const msgs = chatState.messages;
  if (!msgs.length) return '<div class="chat-empty">Sin mensajes</div>';
  // Pre-armar mapa de reacciones por wamid del padre.
  const reactionsByParent = new Map();
  for (const m of msgs) {
    if (m.msg_type === 'reaction' && m.context_id) {
      if (!reactionsByParent.has(m.context_id)) reactionsByParent.set(m.context_id, []);
      reactionsByParent.get(m.context_id).push(m);
    }
  }
  let html = '';
  let lastDate = '';
  let lastDir = '';
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.msg_type === 'reaction') continue; // se renderizan como chips, no como bubble
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

    // Status ticks (SVG like WA). 'played' = audio escuchado, mismo símbolo que 'read'.
    let statusHtml = '';
    if (dir === 'outbound') {
      if (m.status === 'read' || m.status === 'played') statusHtml = `<span class="chat-msg-status read" title="Leído">${TICK_DOUBLE}</span>`;
      else if (m.status === 'delivered') statusHtml = `<span class="chat-msg-status delivered" title="Entregado">${TICK_DOUBLE}</span>`;
      else if (m.status === 'failed') statusHtml = `<span class="chat-msg-status failed" title="No se pudo entregar">✗ falló</span>`;
      else statusHtml = `<span class="chat-msg-status sent" title="Enviado">${TICK_SINGLE}</span>`;
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
      html += `<div class="chat-msg ${dir} sticker-msg${hasTail ? ' has-tail' : ''}" data-wamid="${escapeHtml(m.wamid || '')}" data-msg-type="${escapeHtml(m.msg_type || 'sticker')}">
        <img src="${mediaUrl(m.media_url)}" alt="" style="max-width:160px;max-height:160px" loading="lazy">
      </div>`;
      continue;
    }

    // === IMAGE ===
    if (m.msg_type === 'image' && m.media_url) {
      const imgSrc = mediaUrl(m.media_url);
      html += `<div class="chat-msg ${dir} has-media${hasTail ? ' has-tail' : ''}" data-wamid="${escapeHtml(m.wamid || '')}" data-msg-type="${escapeHtml(m.msg_type || 'image')}">
        <div class="chat-msg-media">
          <img src="${imgSrc}" alt="" loading="lazy" data-img-preview="${escapeHtml(imgSrc)}" onerror="this.style.display='none'">
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
      const audioId = 'aud_' + (m.wamid || m.ts).replace(/[^a-z0-9]/gi, '');
      const transcriptIconSvg = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M14 17H4v2h10v-2zm6-8H4v2h16V9zM4 15h16v-2H4v2zM4 5v2h16V5H4z"/></svg>';
      html += `<div class="chat-msg ${dir} chat-msg-audio-bubble${hasTail ? ' has-tail' : ''}" data-wamid="${escapeHtml(m.wamid || '')}" data-msg-type="${escapeHtml(m.msg_type || 'text')}">
        <div class="chat-msg-audio">
          ${avatarHtml(dir === 'inbound' ? chatState.selectedPhone : '0000', aName, 40)}
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

function renderChatMessages() {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  container.innerHTML = renderChatBubbles();
  // Inyectar acciones hover (forward + reaccionar) y chips de reacción en cada bubble con wamid.
  const reactionsByParent = renderChatBubbles._reactionsByParent || new Map();
  container.querySelectorAll('.chat-msg[data-wamid]').forEach(el => {
    const wamid = el.dataset.wamid;
    if (!wamid) return;
    // Quote block (si este mensaje cita a otro)
    const m = chatState.messages.find(x => x.wamid === wamid);
    if (m && m.context_id) {
      const qHtml = quoteBlockHtml(m);
      if (qHtml) el.insertAdjacentHTML('afterbegin', qHtml);
    }
    el.insertAdjacentHTML('beforeend', chatMsgActionsHtml());
    const chips = reactionsBadgeHtml(wamid, reactionsByParent);
    if (chips) el.insertAdjacentHTML('beforeend', chips);
  });
  // Click en una cita scrollea/destaca el mensaje original
  container.querySelectorAll('[data-jump-to]').forEach(q => {
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
  bindAudioPlayers();
  bindMessageContextMenus();
  bindMessageHoverActions();
  bindMediaPreviewClicks();
  // Si venimos de un click en resultado de búsqueda, scrollear al mensaje y destacarlo
  if (chatState.highlightWamid) {
    const target = container.querySelector(`.chat-msg[data-wamid="${chatState.highlightWamid}"]`);
    if (target) {
      setTimeout(() => {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('chat-msg-flash');
        setTimeout(() => target.classList.remove('chat-msg-flash'), 2200);
      }, 100);
    } else {
      // No está cargado (mensaje muy viejo no fue traído por la query de mensajes)
      container.scrollTop = container.scrollHeight;
    }
    chatState.highlightWamid = null; // consumir el flag
  } else {
    container.scrollTop = container.scrollHeight;
  }
}

// Click en imagen/PDF → preview inline (no abre nueva pestaña).
function bindMediaPreviewClicks() {
  document.querySelectorAll('[data-img-preview]').forEach(img => {
    img.style.cursor = 'zoom-in';
    img.onclick = (e) => {
      e.preventDefault();
      // Galería: todas las imágenes del chat actual, en orden de aparición.
      const all = Array.from(document.querySelectorAll('[data-img-preview]')).map(el => el.dataset.imgPreview);
      const idx = all.indexOf(img.dataset.imgPreview);
      showImageLightbox(all, idx >= 0 ? idx : 0);
    };
  });
  document.querySelectorAll('[data-pdf-preview]').forEach(el => {
    el.style.cursor = 'pointer';
    el.onclick = (e) => {
      e.preventDefault();
      showPdfPreview(el.dataset.pdfPreview, el.dataset.docName || 'Documento');
    };
  });
  document.querySelectorAll('[data-doc-open]').forEach(el => {
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
  requestAnimationFrame(() => lb.classList.add('open'));
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
  requestAnimationFrame(() => bg.classList.add('open'));
  const close = () => { bg.classList.remove('open'); setTimeout(() => bg.remove(), 150); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bg.querySelector('.pdf-close').onclick = close;
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
}

// Right-click sobre cualquier mensaje: muestra menú con "Reenviar".
// Solo funciona si el mensaje tiene wamid (no para optimistic locales sin wamid).
function bindMessageContextMenus() {
  document.querySelectorAll('.chat-msg[data-wamid]').forEach(el => {
    el.oncontextmenu = (e) => {
      const wamid = el.dataset.wamid;
      const msgType = el.dataset.msgType || 'text';
      if (!wamid) return; // sin wamid no se puede reenviar
      e.preventDefault();
      showMessageActionsMenu(e.clientX, e.clientY, wamid, msgType);
    };
  });
}

// Hover actions (forward + react) inline al lado del bubble — estilo WA Web.
function bindMessageHoverActions() {
  document.querySelectorAll('.chat-msg[data-wamid] .chat-msg-actions').forEach(actions => {
    const bubble = actions.closest('.chat-msg');
    if (!bubble) return;
    const wamid = bubble.dataset.wamid;
    const msgType = bubble.dataset.msgType || 'text';
    if (!wamid) return;
    const fwdBtn = actions.querySelector('[data-cma="forward"]');
    const reactBtn = actions.querySelector('[data-cma="react"]');
    if (fwdBtn) fwdBtn.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      showForwardModal(wamid, msgType);
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
  const wrap = document.querySelector('.chat-input-wrap');
  if (!wrap) return;
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
  else preview = (m.body || '').slice(0, 140);
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
  requestAnimationFrame(() => pop.classList.add('open'));
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
  `;
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
  requestAnimationFrame(() => menu.classList.add('open'));
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
    showForwardModal(wamid, msgType);
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
}

function showForwardModal(wamid, msgType) {
  document.getElementById('forward-modal')?.remove();
  const bg = document.createElement('div');
  bg.id = 'forward-modal';
  bg.className = 'modal-bg';
  // contactos disponibles, ordenados por último mensaje
  const contacts = [...chatState.contacts].filter(c => !isArchived(c.phone));
  bg.innerHTML = `
    <div class="modal" style="max-width:480px">
      <div class="modal-h"><h3>Reenviar a…</h3></div>
      <div class="modal-body" style="padding:0;display:flex;flex-direction:column">
        <div style="padding:10px 14px;border-bottom:1px solid var(--border)">
          <input type="text" id="fwd-search" placeholder="Buscar contacto…" autocomplete="off" style="width:100%;padding:8px 10px;background:var(--ink-100);border:1px solid var(--border);border-radius:var(--r-sm);color:var(--fg);font-size:13px">
        </div>
        <div id="fwd-list" style="max-height:380px;overflow-y:auto;padding:6px 0">
          ${contacts.map(c => `
            <label class="fwd-item" data-phone="${escapeHtml(c.phone)}" data-name="${escapeHtml((c.name || '').toLowerCase())}">
              <input type="checkbox" value="${escapeHtml(c.phone)}">
              ${avatarHtml(c.phone, c.name, 36)}
              <div class="fwd-item-text">
                <div class="fwd-item-name">${escapeHtml(c.name || formatPhoneDisplay(c.phone))}</div>
                <div class="fwd-item-sub">${escapeHtml(formatPhoneDisplay(c.phone))}</div>
              </div>
            </label>
          `).join('')}
        </div>
      </div>
      <div class="modal-actions">
        <span id="fwd-count" style="margin-right:auto;color:var(--fg-subtle);font-size:12px">0 seleccionados</span>
        <button class="btn btn-ghost modal-cancel">Cancelar</button>
        <button class="btn btn-cyan" id="fwd-confirm" disabled>Reenviar</button>
      </div>
    </div>
  `;
  document.body.appendChild(bg);
  requestAnimationFrame(() => bg.classList.add('open'));
  const close = () => { bg.classList.remove('open'); setTimeout(() => bg.remove(), 150); };
  bg.querySelector('.modal-cancel').onclick = close;
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
  // search filter
  const search = document.getElementById('fwd-search');
  search.oninput = () => {
    const q = search.value.toLowerCase();
    document.querySelectorAll('.fwd-item').forEach(it => {
      const name = it.dataset.name || '';
      const phone = it.dataset.phone || '';
      it.style.display = (name.includes(q) || phone.includes(q)) ? '' : 'none';
    });
  };
  // selection counter
  const updateCount = () => {
    const checked = bg.querySelectorAll('input[type="checkbox"]:checked');
    document.getElementById('fwd-count').textContent = `${checked.length} seleccionado${checked.length === 1 ? '' : 's'}`;
    document.getElementById('fwd-confirm').disabled = checked.length === 0;
  };
  bg.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.onchange = updateCount);
  // confirm
  document.getElementById('fwd-confirm').onclick = async () => {
    const phones = Array.from(bg.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
    if (!phones.length) return;
    const btn = document.getElementById('fwd-confirm');
    btn.disabled = true;
    btn.textContent = 'Reenviando…';
    try {
      const r = await fetch(CONFIG.trackerUrl + '/admin/wa/forward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ wamid, to_phones: phones })
      });
      const j = await r.json();
      if (r.ok) {
        toast(`✓ Reenviado a ${j.sent}/${phones.length}${j.failed ? ' (' + j.failed + ' fallidos)' : ''}`);
        close();
      } else {
        toast('Error: ' + (j.error || 'fallo'));
        btn.disabled = false;
        btn.textContent = 'Reenviar';
      }
    } catch (e) {
      toast('Error de red');
      btn.disabled = false;
      btn.textContent = 'Reenviar';
    }
  };
  setTimeout(() => search.focus(), 50);
}

function bindAudioPlayers() {
  // Speed buttons (1x → 1.5x → 2x → 1x)
  document.querySelectorAll('.audio-speed').forEach(btn => {
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
  document.querySelectorAll('[data-toggle-transcript]').forEach(btn => {
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

  // Re-render conversation with actual messages
  if (STATE.view === 'chat') {
    const main = document.querySelector('.chat-main');
    if (main) {
      main.innerHTML = renderChatConversation();
      bindChatConversation();
      bindAudioPlayers();
      bindMessageContextMenus();
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
  bindChatPostit();

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
  // Schedule button
  const schedBtn = document.getElementById('btn-schedule');
  if (schedBtn) {
    schedBtn.onclick = () => showScheduleModal(chatState.selectedPhone);
  }
  // Attach: soporta imágenes, videos, audios y documentos. Múltiples archivos.
  // Mandamos en serie con delay para evitar rate limit del WA Cloud API.
  if (attachBtn && fileInput) {
    attachBtn.onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = '';
      await sendChatFiles(files);
    };
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
  // Note button on header (al lado del de etiquetas)
  const noteBtn = document.getElementById('btn-note');
  if (noteBtn) noteBtn.onclick = () => {
    const phone = chatState.selectedPhone;
    if (!phone) return;
    chatState.editingNoteFor = phone;
    refreshPostit();
  };
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

function handleQuickReplyInput(ta) {
  const dd = document.getElementById('qr-dropdown');
  if (!dd) return;
  const val = ta.value;
  if (!val.startsWith('/')) { dd.style.display = 'none'; return; }
  const query = val.slice(1).toLowerCase();
  let matches;
  if (val === '/') matches = chatState.quickReplies.slice(0, 10);
  else matches = chatState.quickReplies.filter(q => q.shortcut.includes(query) || (q.body || '').toLowerCase().includes(query)).slice(0, 8);
  if (!matches.length) { dd.style.display = 'none'; return; }
  dd.innerHTML = matches.map((q, i) => _renderQRItem(q, i, false)).join('');
  dd.style.display = 'block';
  dd.querySelectorAll('.qr-item').forEach(el => {
    el.onclick = () => pickQuickReply(ta, el);
  });
}

async function pickQuickReply(ta, el) {
  const dd = document.getElementById('qr-dropdown');
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
      ${chatState.labels.map(l => `<button type="button" class="label-toggle-chip${cLabels.includes(l.id) ? ' active' : ''}" data-lbl-id="${l.id}" style="--lc:${l.color}" aria-pressed="${cLabels.includes(l.id)}">${escapeHtml(l.name)}</button>`).join('')}
    </div>
    ${!chatState.labels.length ? '<div style="color:#8696a0;font-size:13px;padding:8px">No hay etiquetas. Crealas desde el panel izquierdo.</div>' : ''}
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

function bindChat() {
  // Load data
  if (!chatState.contacts.length && !chatState.loading) {
    // Cargar nombres de WA primero (rápido, solo phone→name) y después contactos
    // para que el primer render ya los muestre bien.
    loadWaContactNames().finally(() => {
      Promise.all([loadChatContacts(), loadQuickReplies(), loadLabels(), loadAllNotes(), loadArchivedChats()]).then(() => {
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
  bindChatContactClicks();
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
  // Toggle ver archivados
  const archivedBtn = document.getElementById('btn-toggle-archived');
  if (archivedBtn) archivedBtn.onclick = () => {
    chatState.showArchived = !chatState.showArchived;
    render();
  };
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
    await Promise.all([
      loadChatContacts(),
      phone ? loadChatMessages(phone) : Promise.resolve()
    ]);
    if (STATE.view !== 'chat' || chatState.selectedPhone !== phone) return;
    refreshContactList();
    const newLastTs = chatState.messages.length ? chatState.messages[chatState.messages.length - 1].ts : '';
    const changed = chatState.messages.length !== prevMsgCount || newLastTs !== prevLastTs;
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
      notifyNewMessage(trigger);
    }
    updateChatPageTitle();
  };
  chatState.pollTimer = setInterval(() => {
    if (STATE.view !== 'chat') { clearInterval(chatState.pollTimer); return; }
    tickPoll();
  }, 4000);
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
function initPollWorker() {
  if (_pollWorker) return; // ya inicializado
  if (!STATE.token || !CONFIG.trackerUrl) return;
  if (typeof Worker === 'undefined') return;
  try {
    _pollWorker = new Worker('assets/poll-worker.js');
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
      notifyNewMessage(contact);
    };
    _pollWorker.postMessage({
      type: 'init',
      token: STATE.token,
      trackerUrl: CONFIG.trackerUrl
    });
  } catch (e) {
    console.warn('Poll worker no disponible:', e);
    _pollWorker = null;
  }
}
function teardownPollWorker() {
  if (!_pollWorker) return;
  try { _pollWorker.postMessage({ type: 'stop' }); _pollWorker.terminate(); } catch (_) {}
  _pollWorker = null;
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

// Dedupe global: el web worker y el main-thread polling pueden detectar el
// mismo mensaje nuevo casi al mismo tiempo. Evitamos doble notif por phone+ts.
const _recentNotifs = new Map(); // key: phone, value: lastNotifiedAt (ms)
const _NOTIF_DEDUPE_MS = 6000; // 6s — más que el ciclo del polling

function notifyNewMessage(contact) {
  const phone = contact?.phone || '';
  const now = Date.now();
  const last = _recentNotifs.get(phone) || 0;
  if (now - last < _NOTIF_DEDUPE_MS) return; // ya notificamos hace poco
  _recentNotifs.set(phone, now);
  // Limpieza vieja del Map
  if (_recentNotifs.size > 100) {
    for (const [k, v] of _recentNotifs) if (now - v > _NOTIF_DEDUPE_MS * 4) _recentNotifs.delete(k);
  }
  playChatNotificationSound();
  // Browser notification solo si la pestaña no está visible (sino el sonido
  // y el badge en pantalla ya alcanzan).
  if (document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const name = contact?.name || formatPhoneDisplay(contact?.phone || '') || 'Nuevo mensaje';
      const body = (contact?.lastMsg || '').slice(0, 120) || 'Nuevo mensaje de WhatsApp';
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

function refreshContactList() {
  const list = document.getElementById('chat-contact-list');
  if (!list) return;
  const search = chatState.search.toLowerCase().trim();
  let filtered = chatState.contacts;
  // Filtrar archivados (salvo que el filtro esté en "ver archivados")
  if (chatState.showArchived) {
    filtered = filtered.filter(c => isArchived(c.phone));
  } else {
    filtered = filtered.filter(c => !isArchived(c.phone));
  }
  // Filtrado local rápido
  if (search) filtered = filtered.filter(c => (c.name || '').toLowerCase().includes(search) || c.phone.includes(search) || (c.lastMsg || '').toLowerCase().includes(search));
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

  list.innerHTML = filtered.map(c => renderContactItem(c)).join('') + loadingHtml + extraHtml;
  bindChatContactClicks();
  bindSearchMessageJumps();
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
    await saveLabel(name, selectedColor);
    showManageLabelsModal();
    render();
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

function showManageQRModal() {
  const content = `
    <div class="manage-qr">
      <p class="manage-qr-hint">Escribí <b>/</b> en el chat para ver tus respuestas guardadas. Las que tienen foto la mandan junto con el texto como caption.</p>
      <div class="manage-qr-section">
        <div class="manage-qr-section-h">${chatState.quickReplies.length} respuesta${chatState.quickReplies.length === 1 ? '' : 's'}</div>
        ${chatState.quickReplies.length ? `
          <div class="manage-qr-list">
            ${chatState.quickReplies.map(q => `
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
      await saveQuickReply(shortcut, body, r2Key);
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
  requestAnimationFrame(() => menu.classList.add('open'));

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
const initView = location.hash.replace('#','') || 'dashboard';
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
