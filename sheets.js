// sheets.js
const { google } = require('googleapis');

const SHEET_ID = process.env.SHEET_ID;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
let GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || '';
GOOGLE_PRIVATE_KEY = GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

if (!SHEET_ID || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) {
  console.error('Missing Google Sheets env vars in sheets.js');
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: GOOGLE_CLIENT_EMAIL,
    private_key: GOOGLE_PRIVATE_KEY,
    type: "service_account"
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheetsApi = google.sheets({ version: 'v4', auth });

/**
 * getAndMarkVoucher(phone, email, affiliateCode)
 * Reads Main voucher sheet!A2:G, finds first row where used != yes, marks USED and writes buyer details.
 */
async function getAndMarkVoucher(phone, email, affiliateCode) {
  const resp = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Main voucher sheet!A2:G'
  });

  const rows = resp.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const used = (row[2] || '').toString().trim().toLowerCase();
    if (used !== 'yes' && used !== 'used') {
      const serial = (row[0] || '').toString().trim();
      const pin = (row[1] || '').toString().trim();
      const rowNum = i + 2;
      const now = new Date().toISOString();
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `Main voucher sheet!A${rowNum}:G${rowNum}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[serial, pin, 'USED', phone || '', email || '', now, affiliateCode || '']]
        }
      });
      return { serial, pin };
    }
  }
  return null;
}

/**
 * appendAffiliateSaleRow(refCode, buyerPhone, voucherSerial)
 * Appends to AffiliateSales!A:G
 */
async function appendAffiliateSaleRow(refCode, buyerPhone, voucherSerial) {
  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'AffiliateSales!A:G',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[new Date().toISOString(), refCode || '', buyerPhone || '', 25, 3, voucherSerial || '', 'no']]
    }
  });
}

/**
 * updateOrCreateAffiliateTotals(refCode)
 * Reads Affiliates!A2:E and updates totals or appends new row
 */
async function updateOrCreateAffiliateTotals(refCode) {
  if (!refCode) return;
  const resp = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Affiliates!A2:E'
  });
  const rows = resp.data.values || [];
  let found = -1;
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] || '').toString() === refCode) { found = i; break; }
  }
  if (found === -1) {
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Affiliates!A:E',
      valueInputOption: 'RAW',
      requestBody: { values: [[refCode, '', '', 1, 3]] }
    });
  } else {
    const rowIndex = found + 2;
    const existing = rows[found];
    const prevSales = parseFloat(existing[3] || 0) || 0;
    const prevComm = parseFloat(existing[4] || 0) || 0;
    const newSales = prevSales + 1;
    const newComm = prevComm + 3;
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Affiliates!D${rowIndex}:E${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[newSales, newComm]] }
    });
  }
}

/**
 * appendPaymentLog(reference, phone, email, amount, voucherSerial, affiliateCode)
 * Appends to Payments!A:G (optional)
 */
async function appendPaymentLog(reference, phone, email, amount, voucherSerial, affiliateCode) {
  try {
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Payments!A:G',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[new Date().toISOString(), reference || '', phone || '', email || '', amount || '', voucherSerial || '', affiliateCode || '']]
      }
    });
  } catch (err) {
    console.warn('appendPaymentLog: Payments tab missing or append failed:', err.message || err);
  }
}

/**
 * paymentsContainsReference(reference)
 * Checks Payments!B2:B for given reference. Returns true/false.
 */
async function paymentsContainsReference(reference) {
  try {
    const resp = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Payments!B2:B'
    });
    const rows = resp.data.values || [];
    for (const r of rows) {
      if ((r[0] || '') === reference) return true;
    }
    return false;
  } catch (err) {
    // If Payments tab doesn't exist, return false so processing continues
    console.warn('paymentsContainsReference read failed (continuing):', err.message || err);
    return false;
  }
}

module.exports = {
  getAndMarkVoucher,
  appendAffiliateSaleRow,
  updateOrCreateAffiliateTotals,
  appendPaymentLog,
  paymentsContainsReference
};
