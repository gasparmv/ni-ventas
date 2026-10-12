// Test de humo de los avisos internos (plan de fondo, Etapa 1, objeción [ALTA] "loop en el bloqueo por pago").
// Correr: node --test worker/avisos.test.mjs  (no deploya nada, no toca la D1 ni manda mensajes: fetch y D1 son falsos)
//
// Qué asegura: un envío que rebota por PAGO genera como mucho UN envío extra (el aviso a Gaspar), nunca una cadena
// (aviso que rebota → otro aviso → …, el bug que ya saturó la D1). Y que el envío de hoy (legacy) sale aunque la tabla
// nueva no exista. Y que el rebote de un AVISO no avisa desde el envío: lo avisa el cron (avisoBloqueoPagoCron), una
// vez por turno de 12 h, con el mismo texto y destino que hoy. worker.js no exporta sus funciones internas: se copia a
// un archivo temporal con un export al final.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, 'worker.js'), 'utf8')
  .replace("from './knowledge/framework-venta.js'", "from '" + pathToFileURL(path.join(dir, 'knowledge', 'framework-venta.js')).href + "'")
  + '\nexport { waSend, waSendText, avisoInterno, kvManyOlvidar, AVISO_KV, setWaBillingBlock, avisoBloqueoPagoCron };\n';
const tmp = path.join(os.tmpdir(), 'avisos_test_' + process.pid + '.mjs');
fs.writeFileSync(tmp, src);
const W = await import(pathToFileURL(tmp).href);
fs.unlinkSync(tmp);

// ----- D1 falsa: kv_cache en memoria; template_status_cache y avisos_internos según el caso; el resto vacío -----
function fakeDB({ kv = {}, sinTablaAvisos = false, conTablaAvisos = false, plantillas = [], fallaLecturaKv = [] } = {}) {
  const store = new Map(Object.entries(kv));
  const claves = new Set();   // UNIQUE(clave) de avisos_internos
  let nextId = 1;
  const res = (kind, rows, changes = 0) => kind === 'first' ? (rows[0] || null) : { results: rows, meta: { changes, rows_read: rows.length, rows_written: changes } };
  const exec = (sql, b, kind) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (sinTablaAvisos && /avisos_internos|wa_send_author/.test(s)) throw new Error('no such table: avisos_internos');
    if (/^SELECT v FROM kv_cache WHERE k ?= ?\?/i.test(s)) { if (fallaLecturaKv.includes(b[0])) throw new Error('D1 overloaded'); return res(kind, store.has(b[0]) ? [{ v: store.get(b[0]) }] : []); }
    if (/^UPDATE kv_cache SET v = \?, updated_at = \? WHERE k = \? AND v = \?/i.test(s)) { if (store.get(b[2]) !== b[3]) return res(kind, [], 0); store.set(b[2], b[0]); return res(kind, [], 1); }
    if (/^DELETE FROM kv_cache WHERE k = \? AND v = \?/i.test(s)) { if (store.get(b[0]) !== b[1]) return res(kind, [], 0); store.delete(b[0]); return res(kind, [], 1); }
    if (/^SELECT 1 (AS x )?FROM kv_cache WHERE k ?= ?\?/i.test(s)) return res(kind, store.has(b[0]) ? [{ x: 1 }] : []);
    const lit = s.match(/^SELECT 1 FROM kv_cache WHERE k = '([^']+)'/i);
    if (lit) return res(kind, store.has(lit[1]) ? [{ x: 1 }] : []);
    if (/^SELECT k, v FROM kv_cache WHERE k IN/i.test(s)) return res(kind, b.filter(k => store.has(k)).map(k => ({ k, v: store.get(k) })));
    if (/^INSERT INTO kv_cache .*ON CONFLICT\(k\) DO UPDATE SET v ?= ?excluded\.v/i.test(s)) { store.set(b[0], String(b[1])); return res(kind, [], 1); }
    if (/^INSERT OR IGNORE INTO kv_cache/i.test(s)) { if (store.has(b[0])) return res(kind, [], 0); store.set(b[0], '1'); return res(kind, [], 1); }
    if (/^DELETE FROM kv_cache WHERE k ?= ?\?/i.test(s)) { const had = store.delete(b[0]); return res(kind, [], had ? 1 : 0); }
    if (/FROM template_status_cache WHERE name IN/i.test(s)) return res(kind, plantillas.filter(p => b.includes(p.name)));
    if (conTablaAvisos && /^INSERT INTO avisos_internos .*RETURNING id/i.test(s)) { if (b[0] != null && claves.has(b[0])) return res(kind, [], 0); if (b[0] != null) claves.add(b[0]); return res(kind, [{ id: nextId++ }], 1); }
    return res(kind, [], 0);
  };
  return {
    store,
    prepare(sql) {
      let b = [];
      const st = { bind(...x) { b = x; return st; }, first: async () => exec(sql, b, 'first'), all: async () => exec(sql, b, 'all'), run: async () => exec(sql, b, 'run') };
      return st;
    },
    batch: async () => [],
  };
}

// ----- fetch falso: cuenta los envíos a /messages; 'pago' = rechazo por falta de pago, 'ok' = sale -----
let envios = [], modoFetch = 'pago';
globalThis.fetch = async (url, init = {}) => {
  if (String(url).endsWith('/messages')) envios.push(JSON.parse(init.body || '{}'));
  if (modoFetch === 'ok') return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.T' + envios.length }] }) };
  return { ok: false, status: 400, json: async () => ({ error: { message: 'This number is blocked due to lack of payment on client side.', code: 131042 } }) };
};
const mkEnv = (db) => ({ DB: db, WA_PROVIDER: '360dialog', D360_API_KEY: 'x', WA_PHONE_NUMBER_ID: '1', ADMIN_NOTIFY_PHONE: '5491155604999' });
const plantillaCliente = { messaging_product: 'whatsapp', to: '5491100000001', type: 'template', template: { name: 'seguimiento_presupuesto', language: { code: 'es_AR' }, components: [] } };

beforeEach(() => { envios = []; modoFetch = 'pago'; W.kvManyOlvidar(W.AVISO_KV); });

for (const modo of ['off', 'dry']) {
  test(`[${modo}] rechazo por pago: 1 aviso (el de hoy, con esAviso) y nada más; el segundo rebote no avisa (12 h)`, async () => {
    const db = fakeDB({ kv: { aviso_interno_modo: modo } });
    const env = mkEnv(db);
    const r = await W.waSend(env, plantillaCliente);
    assert.equal(r.ok, false);
    assert.equal(envios.length, 2, 'el envío + 1 aviso a Gaspar');
    assert.equal(envios[1].to, '5491155604999');
    assert.equal(envios[1].type, 'text');
    await W.waSend(env, plantillaCliente);
    assert.equal(envios.length, 3, 'dentro de las 12 h no se vuelve a avisar');
  });
}

test('[dry] sin la tabla nueva (migración no aplicada) el aviso de hoy sale igual', async () => {
  const env = mkEnv(fakeDB({ kv: { aviso_interno_modo: 'dry' }, sinTablaAvisos: true }));
  await W.waSend(env, plantillaCliente);
  assert.equal(envios.length, 2);
});

test('[on] sin la tabla nueva: lo nuevo revienta antes de mandar y sale el envío de hoy como red (1 aviso)', async () => {
  const env = mkEnv(fakeDB({ kv: { aviso_interno_modo: 'on' }, sinTablaAvisos: true }));
  await W.waSend(env, plantillaCliente);
  assert.equal(envios.length, 2);
});

test('[on] con la tabla: un aviso por destinatario (Gaspar y Bruno) que rebota por pago no genera otro aviso', async () => {
  const env = mkEnv(fakeDB({ kv: { aviso_interno_modo: 'on' }, conTablaAvisos: true, plantillas: [{ name: 'aviso_interno_crm', status: 'APPROVED', category: 'UTILITY' }] }));
  await W.waSend(env, plantillaCliente);
  assert.equal(envios.length, 3, 'el envío + 1 plantilla a Gaspar + 1 a Bruno, sin cadena');
  assert.ok(envios.slice(1).every(e => e.type === 'template' && e.template.name === 'aviso_interno_crm'));
});

test('un AVISO que rebota por pago (esAviso) solo registra el episodio: 0 envíos extra', async () => {
  const db = fakeDB({ kv: { aviso_interno_modo: 'off' } });
  await W.waSendText(mkEnv(db), '5491155604999', 'aviso', { esAviso: true });
  assert.equal(envios.length, 1);
  assert.ok(db.store.has('wa_pay_reject'), 'el episodio queda anotado');
});

test('una plantilla que sale OK cierra el episodio y avisa "volvió" una sola vez', async () => {
  modoFetch = 'ok';
  const db = fakeDB({ kv: { aviso_interno_modo: 'off', wa_pay_reject: JSON.stringify({ since: 1, count: 3, last_notify_at: 1, updated_at: 1 }) } });
  const env = mkEnv(db);
  await W.waSend(env, plantillaCliente);
  assert.equal(envios.length, 2, 'envío normal + 1 "volvió"');
  assert.ok(!db.store.has('wa_pay_reject'));
  await W.waSend(env, plantillaCliente);
  assert.equal(envios.length, 3, 'el "volvió" no se repite');
});

test('si la plantilla que sale OK es un AVISO: cierra el episodio sin avisar; el "volvió" lo manda el cron, una vez', async () => {
  modoFetch = 'ok';
  const db = fakeDB({ kv: { aviso_interno_modo: 'off', wa_pay_reject: JSON.stringify({ since: 1, count: 3, last_notify_at: 1, updated_at: 1 }) } });
  const env = mkEnv(db);
  await W.waSend(env, plantillaCliente, { esAviso: true });
  assert.equal(envios.length, 1, 'un aviso no genera el "volvió"');
  assert.ok(!db.store.has('wa_pay_reject'), 'el episodio se cierra igual (un bloqueo nuevo no lo hereda)');
  await W.waSend(env, plantillaCliente);
  assert.equal(envios.length, 2, 'el envío normal ya no lo manda (lo tiene el cron)');
  await W.avisoBloqueoPagoCron(env);
  assert.equal(envios.length, 3, 'el cron manda el "volvió"');
  assert.match(envios[2].text.body, /volvió a mandar plantillas/);
  await W.avisoBloqueoPagoCron(env);
  assert.equal(envios.length, 3, 'y no lo repite');
});

for (const modo of ['off', 'dry']) {
  test(`[${modo}] un AVISO que rebota por pago en un episodio nuevo: el envío no avisa, el cron sí (mismo texto y destino que hoy), una vez`, async () => {
    const db = fakeDB({ kv: { aviso_interno_modo: modo } });
    const env = mkEnv(db);
    await W.waSendText(env, '5491155604996', 'aviso', { esAviso: true });
    assert.equal(envios.length, 1, '0 envíos extra desde el envío');
    await W.avisoBloqueoPagoCron(env);
    assert.equal(envios.length, 2, 'el cron manda el aviso de bloqueo');
    assert.equal(envios[1].to, '5491155604999');
    assert.match(envios[1].text.body, /rechaza envíos por un problema de PAGO/);
    await W.avisoBloqueoPagoCron(env);
    await W.waSend(env, plantillaCliente);
    assert.equal(envios.length, 3, 'ni el próximo tick ni el próximo rebote normal vuelven a avisar (12 h)');
  });
}

test('si la D1 no deja leer el episodio, el rebote normal no avisa (sin dedup no hay aviso)', async () => {
  const env = mkEnv(fakeDB({ kv: { aviso_interno_modo: 'off' }, fallaLecturaKv: ['wa_pay_reject'] }));
  await W.waSend(env, plantillaCliente);
  await W.waSend(env, plantillaCliente);
  assert.equal(envios.length, 2, 'solo los dos envíos, ningún aviso');
});

test('[on] el recordatorio de las 12 h sale (la clave lleva el turno) y dentro del turno no se repite', async () => {
  const hace13h = Date.now() - 13 * 3600e3;
  const db = fakeDB({ kv: { aviso_interno_modo: 'on' }, conTablaAvisos: true, plantillas: [{ name: 'aviso_interno_crm', status: 'APPROVED', category: 'UTILITY' }] });
  const env = mkEnv(db);
  await W.waSend(env, plantillaCliente);
  assert.equal(envios.length, 3, 'primer aviso: Gaspar + Bruno');
  const ep = JSON.parse(db.store.get('wa_pay_reject'));
  db.store.set('wa_pay_reject', JSON.stringify({ ...ep, since: hace13h, last_notify_at: hace13h }));
  await W.waSend(env, plantillaCliente);
  assert.equal(envios.length, 6, 'a las 12 h: el rebote + el recordatorio a los dos');
  await W.waSend(env, plantillaCliente);
  assert.equal(envios.length, 7, 'dentro del turno no se repite');
});

test('131042 asíncrono de un envío al EQUIPO: se arma el bloqueo pero no avisa; lo avisa el cron una vez', async () => {
  modoFetch = 'ok';   // el aviso del cron sale; después rebota asíncrono (el status 'failed' de abajo)
  const db = fakeDB({ kv: { aviso_interno_modo: 'off' } });
  const env = mkEnv(db);
  const r = await W.setWaBillingBlock(env, '131042', { soloRegistrar: true });
  assert.equal(r.shouldNotify, false);
  assert.ok(db.store.has('wa_billing_block'), 'el breaker queda armado');
  await W.avisoBloqueoPagoCron(env);
  assert.equal(envios.length, 1);
  assert.match(envios[0].text.body, /BLOQUEADO por pago/);
  const r2 = await W.setWaBillingBlock(env, '131042', { soloRegistrar: true });   // el 131042 del propio aviso
  await W.avisoBloqueoPagoCron(env);
  assert.equal(r2.shouldNotify, false);
  assert.equal(envios.length, 1, 'el rebote del propio aviso no arma otra vuelta');
});

test('si el aviso del cron también rebota (síncrono y asíncrono), la cadena se corta: como mucho 1 aviso por episodio cada 12 h', async () => {
  const db = fakeDB({ kv: { aviso_interno_modo: 'off' } });
  const env = mkEnv(db);
  await W.setWaBillingBlock(env, '131042', { soloRegistrar: true });
  for (let i = 0; i < 5; i++) {
    await W.avisoBloqueoPagoCron(env);
    await W.setWaBillingBlock(env, '131042', { soloRegistrar: true });
  }
  // Igual que hoy: el aviso del bloqueo asíncrono y, como ese rebota síncrono, el del episodio síncrono. Nada más.
  assert.equal(envios.length, 2);
});
