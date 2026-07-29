// Web Worker que poolea mensajes inbound nuevos cada 5s.
// Vive en su propio thread → NO sufre el throttling de setInterval que los
// browsers le aplican a la pestaña principal cuando está hidden.
// El thread principal solo se usa para reproducir sonido + mostrar notif.
//
// Mensajes:
//   recibe { type: 'init', token, trackerUrl }      → arranca el polling
//   recibe { type: 'baseline', ts }                  → setea último visto
//   recibe { type: 'stop' }                          → detiene el polling
//   manda { type: 'new-message', phone, name, body, ts } por cada mensaje nuevo

let token = null;
let trackerUrl = null;
let lastSeenTs = '';
let pollHandle = null;
let inFlight = false;
let backoffUntil = 0;

async function poll() {
  if (!token || !trackerUrl || inFlight) return;
  if (Date.now() < backoffUntil) return;  // backoff: D1 saturada -> saltar el tick
  inFlight = true;
  try {
    let url = trackerUrl.replace(/\/$/, '') + '/admin/wa/messages?direction=inbound&limit=30';
    if (lastSeenTs) url += '&from=' + encodeURIComponent(lastSeenTs);
    const r = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!r.ok) {
      // 503 (db_busy) o 5xx: la base está saturada. Backoff 20-40s (con jitter)
      // para no sumar a la cascada de sobrecarga.
      if (r.status >= 500) backoffUntil = Date.now() + 20000 + Math.floor(Math.random() * 20000);
      return;
    }
    backoffUntil = 0;  // la base responde -> limpiar backoff
    const j = await r.json();
    const msgs = (j.messages || [])
      .filter(m => m.msg_type !== 'status')
      .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    if (!msgs.length) return;
    if (!lastSeenTs) {
      // Primera corrida: no disparamos notificaciones por mensajes pasados.
      lastSeenTs = msgs[msgs.length - 1].ts || '';
      return;
    }
    for (const m of msgs) {
      if (!m.ts || m.ts <= lastSeenTs) continue;
      postMessage({
        type: 'new-message',
        phone: m.phone || '',
        name: m.sender_name || '',
        body: m.body || '',
        ts: m.ts
      });
    }
    lastSeenTs = msgs[msgs.length - 1].ts || lastSeenTs;
  } catch (e) {
    // Error de red/timeout: backoff para no martillar (mismo criterio que el 5xx).
    backoffUntil = Date.now() + 20000 + Math.floor(Math.random() * 20000);
  } finally {
    inFlight = false;
  }
}

self.onmessage = (e) => {
  const data = e.data || {};
  if (data.type === 'init') {
    token = data.token || null;
    trackerUrl = data.trackerUrl || null;
    if (pollHandle) clearInterval(pollHandle);
    if (token && trackerUrl) {
      pollHandle = setInterval(poll, 5000);
      poll();
    }
  } else if (data.type === 'baseline') {
    lastSeenTs = data.ts || '';
  } else if (data.type === 'stop') {
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = null;
    token = null;
    trackerUrl = null;
  }
};
