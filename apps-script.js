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

function doPost(e) {
  try {
    // Soporta tanto JSON body directo como form field "data"
    const raw = (e.parameter && e.parameter.data) ? e.parameter.data : e.postData.contents;
    const data = JSON.parse(raw);
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
    //           M=vacía, N=vacía, O=5% joaco, P=teléfono/contacto, Q=canal (WPP|IG)
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
      data.canal || ''     // Q = Canal: "WPP" o "IG"
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

function doGet(e) {
  // GET ?action=rows&sheet=2026 → devuelve las filas crudas (sin coerción de tipo
  // que hace gviz, que rompe los teléfonos con "+" o espacios).
  const action = e && e.parameter && e.parameter.action;
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
