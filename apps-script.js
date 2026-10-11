/**
 * Google Apps Script — Cotizador Writer
 * v3 (24-sep): IDENTIDAD ESTABLE. Cada fila lleva el pedido.id de la D1 en una columna
 * auxiliar (id_sync). El upsert matchea POR ESE ID primero → sobrevive al rename del
 * cartel/diseño (no huérfana la fila con tus costos), distingue piezas idénticas de una
 * orden, y no pisa filas de otra orden. Retrocompatible: las filas viejas sin id se
 * matchean por numero+nombre la 1ª vez y quedan estampadas.
 *   Columna id_sync:  NEÓN "2026" = col AB (28)   ·   CORPÓREO "Pedidos_Corporeo" = col AO (41)
 * v4 (11-oct): Pedidos_Corporeo sumó la col Z "Caja" → estado pago / COBRO 1 pasan a AA:AB y el
 *   id_sync a AO. + acción directo_vendedor: vendedor de los pedidos de neón en el 2026 v4
 *   (Pedidos_Directo, col C), sin pisar nunca lo cargado a mano.
 *   ⚠️ NO borres ni muevas esas columnas: son la clave del sync (si se pierden, degrada a
 *      matchear por numero+nombre, menos robusto).
 */
const SHEET_ID = '13I4OAwpFm4Z0DM81SzbwMpr1DvIjC2NF1BiB0njA1hQ';
const SHEET_NAME = '2026';
const COGS_SHEET_ID = '1PLG-vosgVtvhYYaBLi5Rh-LM6f2A_BvG3i6-a7NpNCE';
const NEON_ID_COL = 28;   // col AB = id_sync (Excel de Ventas, hoja 2026)
const CORP_ID_COL = 41;   // col AO = id_sync (Pedidos_Corporeo; era AN antes de la col Z "Caja")

function doPost(e) {
  try {
    const raw = (e.parameter && e.parameter.data) ? e.parameter.data : e.postData.contents;
    const data = JSON.parse(raw);
    if (data.action === 'pedido_ping') return jsonOut({ ok: true, pong: true });
    if (data.action === 'pedido_upsert') return pedidoUpsert(data);
    if (data.action === 'corporeo_upsert') return corporeoUpsert(data);
    if (data.action === 'corporeo_dedupe') return jsonOut({ ok: true, deleted: corporeoDedupeRun() });
    if (data.action === 'neon_dedupe') return jsonOut({ ok: true, deleted: neonDedupeRun() });
    if (data.action === 'set_ad_bulk') return setAdBulk(data);
    if (data.action === 'directo_vendedor') return directoVendedor(data);

    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) return ContentService.createTextOutput(JSON.stringify({ error: 'Hoja "' + SHEET_NAME + '" no encontrada' })).setMimeType(ContentService.MimeType.JSON);

    const fecha = Utilities.formatDate(new Date(), 'America/Argentina/Buenos_Aires', 'd/M/yyyy HH:mm');
    const row = [
      fecha, data.m2 || 0, data.cliente || '', data.alto || 0, data.ancho || 0, data.neon || 0,
      data.tipo || 'INT', data.trans || 0, data.negro || 0, data.descuento || 0, data.recargo || 0,
      data.reventa || 0, '', '', data.comision || 0, data.telefono || '', data.canal || '',
      data.tramos || 0, Math.round(data.cf || 0), data.margen ? +(data.margen).toFixed(4) : 0,
      data.precio_nuevo || 0, data.precio_viejo || 0, data.densidad ? +(data.densidad).toFixed(3) : 0
    ];
    var colC = sheet.getRange('C:C').getValues();
    var lastDataRow = 0;
    for (var i = colC.length - 1; i >= 0; i--) { if (colC[i][0] !== '' && colC[i][0] !== null) { lastDataRow = i + 1; break; } }
    var insertRow = lastDataRow + 1;
    sheet.getRange(insertRow, 1, 1, row.length).setValues([row]);
    return ContentService.createTextOutput(JSON.stringify({ ok: true, sheet: SHEET_NAME, row: insertRow })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.message })).setMimeType(ContentService.MimeType.JSON);
  }
}

// Clave de MATCH de nombre: NFC (une acentos), colapsa espacios, RESPETA mayusculas (para
// no fusionar "LOOP" con "Loop", que son carteles distintos del mismo pedido).
function _mk(s) { return String(s == null ? '' : s).normalize('NFC').replace(/\s+/g, ' ').trim(); }

// ── IDENTIDAD ESTABLE ────────────────────────────────────────────────────────
// Busca la fila por el pedido.id de la D1 en la columna id_sync. Es la clave más robusta:
// no cambia aunque se renombre el cartel, y es única por pieza. Devuelve la fila o 0.
function findById_(sheet, idCol, pid) {
  if (!pid) return 0;
  var last = sheet.getLastRow();
  if (last < 1) return 0;
  var vals = sheet.getRange(1, idCol, last, 1).getValues();
  var want = String(pid).trim();
  for (var r = 0; r < last; r++) {
    if (String(vals[r][0] == null ? '' : vals[r][0]).trim() === want) return r + 1;
  }
  return 0;
}
// Estampa el pedido.id en la fila (la "adopta") + pone el header id_sync si falta.
function stampId_(sheet, row, idCol, pid) {
  if (!pid || !(row > 1)) return;
  ensureCols_(sheet, idCol);
  var cell = sheet.getRange(row, idCol);
  cell.setNumberFormat('0');   // sin esto, 917 se ve "91700%" (hereda el % de la columna de al lado)
  cell.setValue(pid);
  var h = sheet.getRange(1, idCol).getValue();
  if (h === '' || h == null) sheet.getRange(1, idCol).setValue('id_sync');
}
// La hoja puede tener menos columnas que la auxiliar (AB=28 / AO=41) → getRange tiraría error.
// Crea las columnas vacías que falten al final (no afecta datos ni fórmulas a la izquierda).
function ensureCols_(sheet, n) {
  var mc = sheet.getMaxColumns();
  if (mc < n) sheet.insertColumnsAfter(mc, n - mc);
}

// Re-ubica por nombre (col keyCol) cerca del hint viejo, ignorando acentos/espacios.
// id-aware: saltea filas cuyo id_sync sea de OTRO pedido. Devuelve fila corregida o 0.
function relocateRow(sheet, sheetRow, keyCol, keyVal, idCol, pid) {
  var want = _mk(keyVal);
  if (!(sheetRow > 1) || want === '') return 0;
  var lastRow = sheet.getLastRow();
  var wantPid = pid ? String(pid).trim() : '';
  var wide = Math.max(keyCol, idCol || 0);
  var grid = sheet.getRange(1, 1, lastRow, wide).getValues();
  var best = 0, bestDist = 1e9;
  for (var r = 1; r <= lastRow; r++) {
    if (_mk(grid[r - 1][keyCol - 1]) !== want) continue;
    if (idCol) {
      var rid = String(grid[r - 1][idCol - 1] == null ? '' : grid[r - 1][idCol - 1]).trim();
      if (rid && wantPid && rid !== wantPid) continue; // fila de otro pedido
    }
    var dist = Math.abs(r - sheetRow);
    if (dist < bestDist) { bestDist = dist; best = r; }
  }
  return best > 1 ? best : 0;
}

// Busca por numero + nombre en TODA la hoja, id-aware (saltea filas de otro pedido).
// numCol/nameCol/idCol son 1-based. Devuelve la fila más arriba que coincide, o 0.
function findByContent_(sheet, numero, name, numCol, nameCol, idCol, pid) {
  var last = sheet.getLastRow();
  if (last < 1) return 0;
  var wantName = _mk(name);
  if (!wantName) return 0;
  var wantNum = _toNum(numero);
  var wantPid = pid ? String(pid).trim() : '';
  var wide = Math.max(numCol, nameCol, idCol);
  var grid = sheet.getRange(1, 1, last, wide).getValues();
  for (var r = 0; r < last; r++) {
    if (_mk(grid[r][nameCol - 1]) !== wantName) continue;
    var a = grid[r][numCol - 1];
    var an = (a instanceof Date) ? NaN : _toNum(a);
    if (wantNum && an !== wantNum) continue;
    var rid = String(grid[r][idCol - 1] == null ? '' : grid[r][idCol - 1]).trim();
    if (rid && wantPid && rid !== wantPid) continue; // fila de OTRO pedido (otra pieza) → no fusionar
    return r + 1;
  }
  return 0;
}

// Upsert NEÓN (hoja 2026). Escribe A:N y P:U (salta O=Productor). Orden de resolución:
// (1) id estable  (2) numero+cartel id-aware  (3) hint re-ubicado por cartel  (4) append. Estampa el id.
function pedidoUpsert(data) {
  try {
    var VENTAS_ID = '1qKUhSDDjBV4k8W0goPhOFzEhLz0Zeruq2slLpb9bWSg';
    var ss = SpreadsheetApp.openById(VENTAS_ID);
    var sheet = ss.getSheetByName('2026');
    if (!sheet) return jsonOut({ error: 'hoja 2026 de Ventas no encontrada' });
    ensureCols_(sheet, NEON_ID_COL);
    var row = data.row || [];
    while (row.length < 21) row.push('');
    var pid = data.pedido_id || 0;
    var hint = parseInt(data.sheet_row, 10) || 0;
    var target = 0;
    if (pid) target = findById_(sheet, NEON_ID_COL, pid);                                  // 1) id estable
    if (!(target > 1)) target = findByContent_(sheet, row[1], row[2], 2, 3, NEON_ID_COL, pid); // 2) numero(B)+cartel(C)
    if (!(target > 1) && hint > 1) target = relocateRow(sheet, hint, 3, row[2], NEON_ID_COL, pid); // 3) hint por cartel
    if (!(target > 1)) {                                                                    // 4) append
      var colC = sheet.getRange('C:C').getValues();
      var last = 0;
      for (var i = colC.length - 1; i >= 0; i--) { if (colC[i][0] !== '' && colC[i][0] !== null) { last = i + 1; break; } }
      target = last + 1;
    }
    sheet.getRange(target, 1, 1, 14).setValues([row.slice(0, 14)]);
    sheet.getRange(target, 16, 1, 6).setValues([row.slice(15, 21)]);
    stampId_(sheet, target, NEON_ID_COL, pid);
    return jsonOut({ ok: true, row: target });
  } catch (err) {
    return jsonOut({ error: err.message });
  }
}

// Upsert CORPÓREO (hoja Pedidos_Corporeo). Escribe SOLO A:O (15) y AA:AB (2: estado pago, COBRO 1);
// nunca toca costos P:Y / Caja Z / cobros AC:AF / resumen AH:AM. Mismo orden idempotente por id.
function corporeoUpsert(data) {
  try {
    var CORP_ID = '1PLG-vosgVtvhYYaBLi5Rh-LM6f2A_BvG3i6-a7NpNCE';
    var ss = SpreadsheetApp.openById(CORP_ID);
    var sheet = ss.getSheetByName('Pedidos_Corporeo');
    if (!sheet) return jsonOut({ error: 'hoja Pedidos_Corporeo no encontrada' });
    ensureCols_(sheet, CORP_ID_COL);
    var ao = data.row_ao || []; while (ao.length < 15) ao.push(''); ao = ao.slice(0, 15);
    var zaa = data.row_zaa || []; while (zaa.length < 2) zaa.push(''); zaa = zaa.slice(0, 2);
    var pid = data.pedido_id || 0;
    var hint = parseInt(data.sheet_row, 10) || 0;
    var target = 0;
    if (pid) target = findById_(sheet, CORP_ID_COL, pid);                                   // 1) id estable
    if (!(target > 1)) target = findByContent_(sheet, ao[0], ao[4], 1, 5, CORP_ID_COL, pid); // 2) numero(A)+Diseño(E)
    if (!(target > 1) && hint > 1) target = relocateRow(sheet, hint, 5, ao[4], CORP_ID_COL, pid); // 3) hint por Diseño
    if (!(target > 1)) {                                                                     // 4) append
      var colB = sheet.getRange('B:B').getValues();
      var last = 0;
      for (var i = colB.length - 1; i >= 0; i--) { if (colB[i][0] !== '' && colB[i][0] !== null) { last = i + 1; break; } }
      target = (last < 1 ? 1 : last) + 1;
    }
    sheet.getRange(target, 1, 1, 15).setValues([ao]);   // A:O
    sheet.getRange(target, 27, 1, 2).setValues([zaa]);  // AA:AB (Z = Caja, la cargás vos)
    stampId_(sheet, target, CORP_ID_COL, pid);
    return jsonOut({ ok: true, row: target });
  } catch (err) {
    return jsonOut({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LIMPIEZA DE DUPLICADOS — corré la función UNA VEZ desde el editor (botón ▶).
// Duplicada = TODAS las columnas del CRM idénticas a otra (corpóreo A:O+AA:AB / neón A:N+P:U).
// Conserva la fila con MÁS celdas llenas (la de tus costos), borra el resto. Nunca toca
// filas manuales ni piezas distintas.
// ─────────────────────────────────────────────────────────────────────────────
function corporeoDedupeRun() {
  var CORP_ID = '1PLG-vosgVtvhYYaBLi5Rh-LM6f2A_BvG3i6-a7NpNCE';
  var sheet = SpreadsheetApp.openById(CORP_ID).getSheetByName('Pedidos_Corporeo');
  var n = _dedupeSheet_(sheet, [[1, 15], [27, 28]], 2);
  Logger.log('Corpóreo: borradas ' + n + ' filas duplicadas');
  return n;
}
function neonDedupeRun() {
  var VENTAS_ID = '1qKUhSDDjBV4k8W0goPhOFzEhLz0Zeruq2slLpb9bWSg';
  var sheet = SpreadsheetApp.openById(VENTAS_ID).getSheetByName('2026');
  var n = _dedupeSheet_(sheet, [[1, 14], [16, 21]], 2);
  Logger.log('Neón: borradas ' + n + ' filas duplicadas');
  return n;
}
function _cellKey_(v) { if (v instanceof Date) return 'D' + v.getTime(); return String(v == null ? '' : v).normalize('NFC').trim(); }
function _dedupeSheet_(sheet, ranges, startRow) {
  var last = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (last < startRow) return 0;
  var full = sheet.getRange(startRow, 1, last - startRow + 1, lastCol).getValues();
  function keyOf(rowArr) {
    var parts = [];
    for (var g = 0; g < ranges.length; g++) {
      for (var c = ranges[g][0]; c <= ranges[g][1]; c++) parts.push(_cellKey_(rowArr[c - 1]));
      parts.push('\u0002');
    }
    return parts.join('\u0001');
  }
  function fillCount(rowArr) { var n = 0; for (var c = 0; c < rowArr.length; c++) { if (String(rowArr[c] == null ? '' : rowArr[c]).trim() !== '') n++; } return n; }
  var groups = {};
  for (var i = 0; i < full.length; i++) {
    var k = keyOf(full[i]);
    if (k.replace(/[\u0001\u0002]/g, '').trim() === '') continue;
    (groups[k] = groups[k] || []).push(startRow + i);
  }
  var toDelete = [];
  for (var key in groups) {
    var g = groups[key];
    if (g.length < 2) continue;
    var keep = g[0], keepFill = fillCount(full[keep - startRow]);
    for (var j = 1; j < g.length; j++) { var f = fillCount(full[g[j] - startRow]); if (f > keepFill) { keepFill = f; keep = g[j]; } }
    for (var j2 = 0; j2 < g.length; j2++) { if (g[j2] !== keep) toDelete.push(g[j2]); }
  }
  toDelete.sort(function (a, b) { return a - b; });
  for (var d = toDelete.length - 1; d >= 0; d--) sheet.deleteRow(toDelete[d]);
  return toDelete.length;
}

function setAdBulk(data) {
  try {
    var VENTAS_ID = '1qKUhSDDjBV4k8W0goPhOFzEhLz0Zeruq2slLpb9bWSg';
    var ss = SpreadsheetApp.openById(VENTAS_ID);
    var sheet = ss.getSheetByName('2026');
    if (!sheet) return jsonOut({ error: 'hoja 2026 de Ventas no encontrada' });
    var items = data.items || [];
    var col = parseInt(data.col, 10) || 21;
    var written = 0;
    for (var i = 0; i < items.length; i++) {
      var sr = parseInt(items[i].row, 10) || 0;
      if (sr > 1) { sheet.getRange(sr, col).setValue(String(items[i].ad || '')); written++; }
    }
    return jsonOut({ ok: true, written: written });
  } catch (err) {
    return jsonOut({ error: err.message });
  }
}

function _norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
function _toNum(v) {
  if (typeof v === 'number') return Math.round(v);
  var s = String(v == null ? '' : v).replace(/[^0-9\-]/g, '');
  var n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

function getCogs(e) {
  try {
    const ss = SpreadsheetApp.openById(COGS_SHEET_ID);
    var sheet = null;
    var allSheets = ss.getSheets();
    for (var s = 0; s < allSheets.length; s++) {
      if (allSheets[s].getName().toLowerCase().indexOf('cogs') !== -1) { sheet = allSheets[s]; break; }
    }
    if (!sheet) return jsonOut({ error: 'no encontré una hoja con "COGS" en el nombre' });
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    var mes = parseInt((e && e.parameter && e.parameter.mes) || '', 10);
    if (!mes || mes < 1 || mes > 12) mes = parseInt(Utilities.formatDate(new Date(), 'America/Argentina/Buenos_Aires', 'M'), 10);
    var header = values[0] || [];
    var monthCol = -1;
    for (var c = 0; c < header.length; c++) {
      var hv = header[c];
      var n = (typeof hv === 'number') ? Math.round(hv) : parseInt(String(hv).trim(), 10);
      if (n === mes) { monthCol = c; break; }
    }
    if (monthCol === -1) return jsonOut({ error: 'no encontré la columna del mes ' + mes, header: header });
    function findVal(labels) {
      for (var r = 1; r < values.length; r++) {
        var idA = String(values[r][0] || '').trim().toLowerCase();
        var idB = String(values[r][1] || '').trim().toLowerCase();
        for (var i = 0; i < labels.length; i++) {
          var L = labels[i].toLowerCase();
          if (idA === L || idB === L) return values[r][monthCol];
        }
      }
      return null;
    }
    function pct(v) { v = Number(v) || 0; return v > 1 ? v / 100 : v; }
    function findRowByLabel(needle) {
      needle = _norm(needle);
      for (var r = 0; r < values.length; r++) {
        var maxc = Math.min(values[r].length, 6);
        for (var c = 0; c < maxc; c++) {
          if (_norm(values[r][c]).indexOf(needle) !== -1 && _norm(values[r][c]).length) return r;
        }
      }
      return -1;
    }
    function monthColsNear(dataRow) {
      for (var r = dataRow - 1; r >= 0; r--) {
        var map = {}, count = 0;
        for (var c = 0; c < values[r].length; c++) {
          var vv = values[r][c];
          var nn = (typeof vv === 'number') ? Math.round(vv) : parseInt(String(vv).trim(), 10);
          if (nn >= 1 && nn <= 12 && map[nn] === undefined) { map[nn] = c; count++; }
        }
        if (count >= 6) return map;
      }
      return null;
    }
    var joaquinFijoByMonth = null, joaquinFijoRow = -1;
    var jrow = findRowByLabel('sueldos joaqu');
    if (jrow >= 0) {
      joaquinFijoRow = jrow + 1;
      var mcols = monthColsNear(jrow);
      if (!mcols) {
        mcols = {};
        for (var c2 = 0; c2 < header.length; c2++) {
          var hh = header[c2];
          var hn = (typeof hh === 'number') ? Math.round(hh) : parseInt(String(hh).trim(), 10);
          if (hn >= 1 && hn <= 12 && mcols[hn] === undefined) mcols[hn] = c2;
        }
      }
      joaquinFijoByMonth = {};
      for (var m = 1; m <= 12; m++) {
        if (mcols[m] !== undefined) {
          var val = _toNum(values[jrow][mcols[m]]);
          if (val) joaquinFijoByMonth[m] = val;
        }
      }
    }
    if (e && e.parameter && e.parameter.debug) {
      var preview = [];
      for (var r3 = 0; r3 < Math.min(values.length, 55); r3++) preview.push([values[r3][0], values[r3][1], values[r3][2], values[r3][monthCol]]);
      return jsonOut({ ok: true, mes: mes, monthColIndex: monthCol, header: header, joaquinFijoRow: joaquinFijoRow, joaquin_fijo_by_month: joaquinFijoByMonth, preview: preview });
    }
    var cogs = {
      costo_acrilico_trans: Number(findVal(['Trans', 'Coste Acrilico Trans'])) || 0,
      costo_acrilico_negro: Number(findVal(['Negro', 'Coste Acrilico Negro'])) || 0,
      venta_trans_imaginario: Number(findVal(['TRANS_V', 'Venta Acrilico Trans'])) || 0,
      anibal: pct(findVal(['ANIBAL', 'Anibal'])), emma: pct(findVal(['EMMA', 'Emma'])),
      costo_neon_mt: Number(findVal(['Neon', 'Metro de neon'])) || 0,
      mano_obra: pct(findVal(['MO', 'Mano de Obra'])), joaquin: pct(findVal(['JOAQUIN', 'Joaquin'])),
      joaquin_fijo_by_month: joaquinFijoByMonth,
      joaquin_fijo: (joaquinFijoByMonth && joaquinFijoByMonth[mes]) || 0
    };
    return jsonOut({ ok: true, mes: mes, cogs: cogs });
  } catch (err) {
    return jsonOut({ error: err.message });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === 'cogs') return getCogs(e);
  if (action === 'pedido_ping') return jsonOut({ ok: true, pong: true });
  if (action === 'directo_ping') return jsonOut({ ok: true, directo: true });
  if (action === 'rows') {
    try {
      const sheetName = (e.parameter.sheet || SHEET_NAME);
      const ss = SpreadsheetApp.openById(SHEET_ID);
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) return ContentService.createTextOutput(JSON.stringify({ error: 'sheet not found: ' + sheetName })).setMimeType(ContentService.MimeType.JSON);
      const lastRow = sheet.getLastRow();
      if (lastRow < 1) return ContentService.createTextOutput(JSON.stringify({ ok: true, rows: [] })).setMimeType(ContentService.MimeType.JSON);
      const range = sheet.getRange(1, 1, lastRow, 26);
      const display = range.getDisplayValues();
      return ContentService.createTextOutput(JSON.stringify({ ok: true, rows: display, sheet: sheetName })).setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({ error: err.message })).setMimeType(ContentService.MimeType.JSON);
    }
  }
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok', info: 'NI Cotizador Writer.' })).setMimeType(ContentService.MimeType.JSON);
}

// ── VENDEDOR de los pedidos de NEÓN → 2026 v4 › Pedidos_Directo, col C (10-oct) ──────────
// Pedidos_Directo trae cada columna de la hoja "2026" de Ventas por IMPORTRANGE, salvo la C
// (VENDEDOR), que es un valor común (de ahí salen las comisiones). El CRM manda los vendedores
// y esto los escribe SOLO si la celda está vacía o todavía tiene lo que había puesto el CRM
// (prev): nunca pisa lo que cargaste a mano. Antes de escribir verifica N° + nombre del pedido.
function directoVendedor(data) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var sh = SpreadsheetApp.openById('1PLG-vosgVtvhYYaBLi5Rh-LM6f2A_BvG3i6-a7NpNCE').getSheetByName('Pedidos_Directo');
    if (!sh) return jsonOut({ error: 'hoja Pedidos_Directo no encontrada' });
    // Fila donde arranca el IMPORTRANGE de "2026!b2:b" (col A) → corrimiento entre las dos hojas.
    var fa = sh.getRange(1, 1, 300, 1).getFormulas(), base = 0;
    for (var i = 0; i < fa.length; i++) { if (/2026!b2:b/i.test(fa[i][0])) { base = i + 1; break; } }
    if (!base) return jsonOut({ error: 'no encontré el IMPORTRANGE de 2026!B2:B en la columna A' });
    var off = base - 2, last = sh.getLastRow();
    var vals = sh.getRange(1, 1, last, 4).getValues();   // A..D: ID, Fecha, VENDEDOR, Nombre
    var nz = function (s) { return String(s == null ? '' : s).normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase(); };
    var coincide = function (r, it) { return r >= base && r <= last && nz(vals[r - 1][0]) === nz(it.numero) && nz(vals[r - 1][3]) === nz(it.cartel); };
    var items = data.items || [], out = [];
    for (var k = 0; k < items.length; k++) {
      var it = items[k], r = (parseInt(it.row, 10) || 0) + off;
      if (!coincide(r, it)) {   // la fila que tiene el CRM quedó vieja: buscar por N° + nombre (solo si hay UNA)
        var hits = [];
        for (var j = base; j <= last; j++) { if (coincide(j, it)) hits.push(j); }
        if (hits.length !== 1) { out.push({ id: it.id, error: hits.length ? 'hay ' + hits.length + ' filas con ese N° y nombre' : 'no está en Pedidos_Directo' }); continue; }
        r = hits[0];
      }
      var cur = nz(vals[r - 1][2]), vend = nz(it.vendedor), prev = nz(it.prev);
      if (!vend) { out.push({ id: it.id, error: 'sin vendedor' }); continue; }
      if (cur === vend) { out.push({ id: it.id, ok: true, row: r, igual: true }); continue; }
      if (cur && cur !== prev) { out.push({ id: it.id, ok: true, row: r, manual: cur }); continue; }
      sh.getRange(r, 3).setValue(vend);
      vals[r - 1][2] = vend;
      out.push({ id: it.id, ok: true, row: r, escrito: vend });
    }
    return jsonOut({ ok: true, base: base, items: out });
  } catch (err) {
    return jsonOut({ error: err.message });
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}
