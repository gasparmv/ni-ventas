// NI Ventas · tracking worker
// Endpoints:
//   POST /event   { user, action, itemId, itemKind, undo? }   → 204
//   GET  /report?user=&from=&to=                              → { rows: [...] }
//
// CORS abierto a todo origen (es un panel interno; la lectura no expone PII real).
// Si querés cerrarlo, cambiá ALLOWED_ORIGINS abajo.

const ALLOWED_ORIGINS = '*'; // o por ej. 'https://gasparmv.github.io'

function cors(headers = {}) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    ...headers
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: cors({ 'Content-Type': 'application/json' })
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/event') {
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'invalid json' }, 400); }
      const { user, action, itemId, itemKind, undo } = body || {};
      if (!user || !action || !itemId) return json({ error: 'missing fields' }, 400);
      const ts = new Date().toISOString();
      await env.DB.prepare(
        'INSERT INTO events (user, action, item_id, item_kind, undo, ts) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(user, action, itemId, itemKind || '', undo ? 1 : 0, ts).run();
      return new Response(null, { status: 204, headers: cors() });
    }

    if (request.method === 'GET' && url.pathname === '/report') {
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

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  }
};
