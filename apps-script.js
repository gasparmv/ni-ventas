/**
 * Google Apps Script — Cotizador Writer
 *
 * Deploy como Web App:
 *   1. Abrí https://script.google.com y creá un proyecto nuevo
 *   2. Pegá este código
 *   3. Cambiá SHEET_ID por el ID del spreadsheet del cotizador
 *   4. Deploy > New deployment > Web app
 *      - Execute as: Me
 *      - Who has access: Anyone
 *   5. Copiá la URL del deployment y pegala en CONFIG.appsScriptUrl en app.js
 */

const SHEET_ID = '13I4OAwpFm4Z0DM81SzbwMpr1DvIjC2NF1BiB0njA1hQ';

const SHEET_NAME = '2026';

// Spreadsheet 2026 v4 — de ahí leemos la hoja COGS para el cotizador nuevo.
// (Es OTRO spreadsheet, distinto del SHEET_ID de presupuestos de arriba.)
const COGS_SHEET_ID = '1PLG-vosgVtvhYYaBLi5Rh-LM6f2A_BvG3i6-a7NpNCE';

function doPost(e) {
  try {
    // Soporta tanto JSON body directo como form field "data"
    const raw = (e.parameter && e.parameter.data) ? e.parameter.data : e.postData.contents;
    const data = JSON.parse(raw);

    // ===== Acciones de PEDIDOS (espejo del CRM → Excel de Ventas) =====
    // Si no hay `action`, sigue el flujo histórico del cotizador (más abajo).
    if (data.action === 'pedido_ping') {
      return jsonOut({ ok: true, pong: true });
    }
    if (data.action === 'pedido_upsert') {
      return pedidoUpsert(data);
    }

    const ss = SpreadsheetApp.openById(SHEET_ID);

    let sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      return ContentService.createTextOutput(JSON.stringify({ error: 'Hoja "' + SHEET_NAME + '" no encontrada' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Formato fecha: d/M/yyyy HH:mm (hora local Argentina, AR-Buenos_Aires).
    // Importante: incluir año + hora para poder ordenar dentro de un mismo día y no perder
    // referencia al cambiar de año. parseDate() en app.js consume este formato.
    const fecha = Utilities.formatDate(new Date(), 'America/Argentina/Buenos_Aires', 'd/M/yyyy HH:mm');

    // Columnas: A=Fecha, B=m2, C=diseño, D=alto, E=ancho, F=neon, G=tipo,
    //           H=transparente, I=negro, J=descuento, K=recargo, L=reventa,
    //           M=vacía, N=vacía, O=5% joaco, P=teléfono/contacto, Q=canal,
    //           R=tramos (NUEVO), S=CF (NUEVO), T=margen (NUEVO),
    //           U=precio_nuevo (NUEVO), V=precio_viejo (NUEVO), W=densidad (NUEVO)
    // R..W son las columnas de TRANSICIÓN: durante el cambio al cotizador nuevo
    // (spec COGS + margen variable) grabamos AMBOS precios para validar la
    // fórmula nueva contra los presupuestos históricos. Una vez confirmado que
    // la fórmula nueva está bien calibrada, se pueden ignorar/limpiar.
    const row = [
      fecha,
      data.m2 || 0,
      data.cliente || '',
      data.alto || 0,
      data.ancho || 0,
      data.neon || 0,
      data.tipo || 'INT',
      data.trans || 0,
      data.negro || 0,
      data.descuento || 0,
      data.recargo || 0,
      data.reventa || 0,
      '', // M vacía
      '', // N vacía
      data.comision || 0,  // O = 5% Joaco
      data.telefono || '', // P = Teléfono o usuario IG (lo que corresponda según canal)
      data.canal || '',    // Q = Canal: "WPP" o "IG"
      data.tramos || 0,    // R = Tramos (cortes/subtrazos del vector)
      Math.round(data.cf || 0),                    // S = Costo Fijo (fórmula nueva)
      data.margen ? +(data.margen).toFixed(4) : 0, // T = Margen objetivo (0..1)
      data.precio_nuevo || 0,                      // U = Precio según fórmula nueva
      data.precio_viejo || 0,                      // V = Precio según fórmula vieja
      data.densidad ? +(data.densidad).toFixed(3) : 0 // W = Densidad (tramos/mt)
    ];

    // Insertar después de la última fila con datos en columna C
    var colC = sheet.getRange('C:C').getValues();
    var lastDataRow = 0;
    for (var i = colC.length - 1; i >= 0; i--) {
      if (colC[i][0] !== '' && colC[i][0] !== null) {
        lastDataRow = i + 1;
        break;
      }
    }
    var insertRow = lastDataRow + 1;
    sheet.getRange(insertRow, 1, 1, row.length).setValues([row]);

    return ContentService.createTextOutput(JSON.stringify({ ok: true, sheet: SHEET_NAME, row: insertRow }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Upsert de un pedido en el Excel de VENTAS (hoja 2026). El CRM (D1) es la fuente
// de verdad; esto es el espejo. data.row = array de 21 valores (cols A..U). Con
// data.sheet_row actualiza esa fila SIN tocar O (15 = Productor, que cargás vos en
// el Excel); sin sheet_row, agrega una fila nueva y devuelve su número.
function pedidoUpsert(data) {
  try {
    var VENTAS_ID = '1qKUhSDDjBV4k8W0goPhOFzEhLz0Zeruq2slLpb9bWSg';
    var ss = SpreadsheetApp.openById(VENTAS_ID);
    var sheet = ss.getSheetByName('2026');
    if (!sheet) return jsonOut({ error: 'hoja 2026 de Ventas no encontrada' });
    var row = data.row || [];
    while (row.length < 21) row.push('');
    var sheetRow = parseInt(data.sheet_row, 10) || 0;
    if (sheetRow && sheetRow > 1) {
      // UPDATE: escribir A..N (1..14) y P..U (16..21), SALTANDO O (15 = Productor).
      sheet.getRange(sheetRow, 1, 1, 14).setValues([row.slice(0, 14)]);
      sheet.getRange(sheetRow, 16, 1, 6).setValues([row.slice(15, 21)]);
      return jsonOut({ ok: true, row: sheetRow });
    }
    // APPEND: después de la última fila con datos en la col C (cartel).
    var colC = sheet.getRange('C:C').getValues();
    var last = 0;
    for (var i = colC.length - 1; i >= 0; i--) { if (colC[i][0] !== '' && colC[i][0] !== null) { last = i + 1; break; } }
    var insertRow = last + 1;
    sheet.getRange(insertRow, 1, 1, 21).setValues([row.slice(0, 21)]);
    return jsonOut({ ok: true, row: insertRow });
  } catch (err) {
    return jsonOut({ error: err.message });
  }
}

// Lee la hoja COGS del 2026 v4 y devuelve los costos del MES ACTUAL.
// - La columna del mes se detecta leyendo la fila 1: busca la celda cuyo número
//   == mes actual (zona AR). Así no importa en qué letra esté.
// - Los valores se buscan por NOMBRE de fila (col A "id" o col B "Nombre"),
//   no por número de fila → si insertás filas en el Excel no se rompe.
// - Override para testear: ?action=cogs&mes=6  ·  diagnóstico: ?action=cogs&debug=1
function getCogs(e) {
  try {
    const ss = SpreadsheetApp.openById(COGS_SHEET_ID);
    // Buscar la hoja cuyo nombre contenga "cogs" (la pestaña puede ser "1 COGS").
    var sheet = null;
    var allSheets = ss.getSheets();
    for (var s = 0; s < allSheets.length; s++) {
      if (allSheets[s].getName().toLowerCase().indexOf('cogs') !== -1) { sheet = allSheets[s]; break; }
    }
    if (!sheet) return jsonOut({ error: 'no encontré una hoja con "COGS" en el nombre' });

    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();

    // Mes actual (AR), o override por querystring.
    var mes = parseInt((e && e.parameter && e.parameter.mes) || '', 10);
    if (!mes || mes < 1 || mes > 12) {
      mes = parseInt(Utilities.formatDate(new Date(), 'America/Argentina/Buenos_Aires', 'M'), 10);
    }

    // Columna del mes: en la fila 1, la celda cuyo número == mes.
    var header = values[0] || [];
    var monthCol = -1;
    for (var c = 0; c < header.length; c++) {
      var hv = header[c];
      var n = (typeof hv === 'number') ? Math.round(hv) : parseInt(String(hv).trim(), 10);
      if (n === mes) { monthCol = c; break; }
    }
    if (monthCol === -1) return jsonOut({ error: 'no encontré la columna del mes ' + mes, header: header });

    // Buscar el valor de una fila por su id (col A) o nombre (col B).
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
    // Normaliza porcentajes: si viene 15 en vez de 0.15, lo divide.
    function pct(v) { v = Number(v) || 0; return v > 1 ? v / 100 : v; }

    if (e && e.parameter && e.parameter.debug) {
      // Modo diagnóstico: devuelve las primeras 3 columnas de cada fila + header.
      var preview = [];
      for (var r2 = 0; r2 < Math.min(values.length, 30); r2++) {
        preview.push([values[r2][0], values[r2][1], values[r2][monthCol]]);
      }
      return jsonOut({ ok: true, mes: mes, monthColIndex: monthCol, header: header, preview: preview });
    }

    var cogs = {
      costo_acrilico_trans:   Number(findVal(['Trans', 'Coste Acrilico Trans'])) || 0,
      costo_acrilico_negro:   Number(findVal(['Negro', 'Coste Acrilico Negro'])) || 0,
      venta_trans_imaginario: Number(findVal(['TRANS_V', 'Venta Acrilico Trans'])) || 0,
      anibal:    pct(findVal(['ANIBAL', 'Anibal'])),
      emma:      pct(findVal(['EMMA', 'Emma'])),
      costo_neon_mt: Number(findVal(['Neon', 'Metro de neon'])) || 0,
      mano_obra: pct(findVal(['MO', 'Mano de Obra'])),
      joaquin:   pct(findVal(['JOAQUIN', 'Joaquin']))
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
  // GET ?action=cogs → costos del mes actual para el cotizador nuevo.
  if (action === 'cogs') return getCogs(e);
  // GET ?action=rows&sheet=2026 → devuelve las filas crudas (sin coerción de tipo
  // que hace gviz, que rompe los teléfonos con "+" o espacios).
  if (action === 'rows') {
    try {
      const sheetName = (e.parameter.sheet || SHEET_NAME);
      const ss = SpreadsheetApp.openById(SHEET_ID);
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) {
        return ContentService.createTextOutput(JSON.stringify({ error: 'sheet not found: ' + sheetName }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      // Leer hasta col Z y convertir a string para preservar formato exacto
      const lastRow = sheet.getLastRow();
      if (lastRow < 1) return ContentService.createTextOutput(JSON.stringify({ ok: true, rows: [] })).setMimeType(ContentService.MimeType.JSON);
      const range = sheet.getRange(1, 1, lastRow, 26);
      const display = range.getDisplayValues(); // valores tal como se ven en el sheet (preserva formato)
      return ContentService.createTextOutput(JSON.stringify({ ok: true, rows: display, sheet: sheetName }))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({ error: err.message })).setMimeType(ContentService.MimeType.JSON);
    }
  }
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok', info: 'NI Cotizador Writer. POST to add rows. GET ?action=rows&sheet=NAME to fetch.' }))
    .setMimeType(ContentService.MimeType.JSON);
}
