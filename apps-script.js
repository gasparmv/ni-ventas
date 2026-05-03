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
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.openById(SHEET_ID);

    let sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      return ContentService.createTextOutput(JSON.stringify({ error: 'Hoja "' + SHEET_NAME + '" no encontrada' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Formato fecha: d/M
    const now = new Date();
    const fecha = now.getDate() + '/' + (now.getMonth() + 1);

    // Columnas: A=Fecha, B=m2, C=diseño, D=alto, E=ancho, F=neon, G=tipo,
    //           H=transparente, I=negro, J=descuento, K=recargo, L=reventa,
    //           M=vacía, N=vacía, O=5% joaco
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
      data.comision || 0  // O = 5% Joaco
    ];

    sheet.appendRow(row);

    return ContentService.createTextOutput(JSON.stringify({ ok: true, sheet: SHEET_NAME, row: sheet.getLastRow() }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok', info: 'NI Cotizador Writer. Use POST to add rows.' }))
    .setMimeType(ContentService.MimeType.JSON);
}
