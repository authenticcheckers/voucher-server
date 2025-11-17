// server.js - Authentic Checkers backend
// Requirements:
// - Node 18+
// - Environment variables configured (see below)
// - Google Sheets with the tabs: main voucher sheet, "Affiliates", "AffiliateSales"

// Environment variables used:
// PAYSTACK_SECRET_KEY
// PAYSTACK_WEBHOOK_SECRET (optional; defaults to PAYSTACK_SECRET_KEY)
// ARKESEL_API_KEY
// ARKESEL_SENDER (optional)
// SHEET_ID
// GOOGLE_CLIENT_EMAIL
// GOOGLE_PRIVATE_KEY  (use actual newlines or use \\n in the value and code below replaces them)
// PORT (optional)

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();

// CORS - allow your frontend sources
app.use(cors({
  origin: [
    "https://authenticcheckers.github.io",
    "https://sites.google.com",
    "https://sites.google.com/view/wasscevouchershop",
    "https://sites.google.com/view/wasscevouchershop/home"
  ],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// capture raw body for webhook verification
app.use(bodyParser.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));

// ========= ENV CONFIG =========
const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_WEBHOOK_SECRET = process.env.PAYSTACK_WEBHOOK_SECRET || PAYSTACK_SECRET_KEY;
const ARKESEL_API_KEY = process.env.ARKESEL_API_KEY || '';
const ARKESEL_SENDER = process.env.ARKESEL_SENDER || '';
const SHEET_ID = process.env.SHEET_ID || '';
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL || '';
let GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || '';

if (!PAYSTACK_SECRET_KEY) {
  console.error("Missing PAYSTACK_SECRET_KEY. Exiting.");
  process.exit(1);
}
if (!SHEET_ID || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) {
  console.error("Missing Google Sheets config (SHEET_ID / GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY). Exiting.");
  process.exit(1);
}
if (!ARKESEL_API_KEY) {
  console.warn("ARKESEL_API_KEY not set — SMS will fail until provided.");
}

// fix private key newlines if they were stored with \n
GOOGLE_PRIVATE_KEY = GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

// ======= Google Sheets client helper =======
function getSheetsClient() {
  const credentials = {
    type: "service_account",
    client_email: GOOGLE_CLIENT_EMAIL,
    private_key: GOOGLE_PRIVATE_KEY
  };

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  return google.sheets({ version: 'v4', auth });
}

// ======= pick first unused voucher, mark USED, return {serial,pin} =======
async function getAndMarkVoucher(phone, email, refCode) {
  const sheets = getSheetsClient();

  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'A2:F' // read from serial/pin/status area
  });

  const rows = readRes.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const used = (row[2] || '').toString().trim().toLowerCase();
    if (used !== 'yes' && used !== 'used') {
      const serial = (row[0] || '').toString().trim();
      const pin = (row[1] || '').toString().trim();
      const now = new Date().toISOString();
      const rowIndex = i + 2;
      // we will write serial,pin,USED,phone,email,date
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `A${rowIndex}:F${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [
            [serial, pin, 'USED', phone || '', email || '', now]
          ]
        }
      });
      return { serial, pin };
    }
  }
  return null;
}

// ======= send SMS via Arkesel =======
async function sendArkeselSMS(phone, message) {
  const url = 'https://sms.arkesel.com/api/v2/sms/send';
  const payload = { recipients: [phone], message };
  if (ARKESEL_SENDER) payload.sender = ARKESEL_SENDER;
  const headers = { 'Content-Type': 'application/json', 'api-key': ARKESEL_API_KEY };
  const resp = await axios.post(url, payload, { headers });
  return resp.data;
}

// ======= verify Paystack webhook signature =======
function verifyPaystackSignature(rawBody, signature) {
  const secret = PAYSTACK_WEBHOOK_SECRET;
  if (!secret) return false;
  const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  return hash === signature;
}

// ======= AFFILIATE HELPERS =======
const COMMISSION_GHS = 3;
async function recordAffiliateSale(refCode, buyerPhone, voucherSerial) {
  if (!refCode) return;
  const sheets = getSheetsClient();
  const now = new Date().toISOString();
  const commission = COMMISSION_GHS;
  // Append to AffiliateSales: Date | AffiliateCode | BuyerPhone | Amount | Commission | VoucherSerial | PaidStatus
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'AffiliateSales!A:G',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[now, refCode, buyerPhone, 25, commission, voucherSerial || '', 'no']]
    }
  });

  // Update Affiliates: find AffiliateCode row and update totals, or append new row
  const affRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Affiliates!A2:E'
  });
  const affRows = affRes.data.values || [];

  let foundIndex = -1;
  for (let i = 0; i < affRows.length; i++) {
    if ((affRows[i][0] || '').toString() === refCode) { foundIndex = i; break; }
  }

  if (foundIndex === -1) {
    // Create new affiliate row: AffiliateCode, Name(empty), Phone(empty), TotalSales=1, TotalCommission=commission
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Affiliates!A:E',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[refCode, '', '', 1, commission]]
      }
    });
  } else {
    const rowNum = foundIndex + 2;
    const existing = affRows[foundIndex];
    const prevSales = parseFloat(existing[3] || 0) || 0;
    const prevComm = parseFloat(existing[4] || 0) || 0;
    const newSales = prevSales + 1;
    const newComm = prevComm + commission;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Affiliates!D${rowNum}:E${rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[newSales, newComm]] }
    });
  }
}

// ======= CREATE PAYMENT ROUTE =======
app.post('/create-payment', async (req, res) => {
  try {
    const { name, phone, email, ref } = req.body || {};

    if (!name || !phone || !email) {
      return res.status(400).json({ error: 'name, phone and email required' });
    }

    // normalize phone to no '+' and Ghana format
    let normalizedPhone = phone.toString().trim();
    normalizedPhone = normalizedPhone.replace(/\s+/g, '');
    if (normalizedPhone.startsWith('+')) normalizedPhone = normalizedPhone.slice(1);
    if (normalizedPhone.startsWith('0')) normalizedPhone = '233' + normalizedPhone.slice(1);

    const amountGHS = 25.00;
    const amountSmallest = Math.round(amountGHS * 100);

    const initResp = await axios.post('https://api.paystack.co/transaction/initialize', {
      email: email,
      amount: amountSmallest,
      metadata: { name, phone: normalizedPhone, ref: ref || null },
      currency: 'GHS'
    }, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' }
    });

    const data = initResp.data;
    if (!data || !data.data) return res.status(500).json({ error: 'Paystack initialize failed' });

    return res.json({
      authorization_url: data.data.authorization_url,
      reference: data.data.reference,
      amount: amountGHS
    });

  } catch (err) {
    console.error('create-payment error', err.response ? err.response.data : err.message);
    return res.status(500).json({ error: 'server error' });
  }
});

// ======= WEBHOOK =======
app.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'] || req.headers['X-Paystack-Signature'];
    const raw = req.rawBody || JSON.stringify(req.body);

    if (!verifyPaystackSignature(raw, signature)) {
      console.warn('Invalid Paystack signature');
      return res.status(400).send('Invalid signature');
    }

    const event = req.body;
    const data = event.data || {};
    const status = (data.status || '').toLowerCase();
    if (status !== 'success') {
      console.log('ignored non-successful transaction');
      return res.status(200).send('ignored');
    }

    const metadata = data.metadata || {};
    let phone = metadata.phone || '';
    let email = metadata.email || '';
    const refCode = metadata.ref || null;

    if (phone && phone.startsWith('0')) phone = '233' + phone.slice(1);
    if (phone && phone.startsWith('+')) phone = phone.slice(1);

    // get voucher
    const voucher = await getAndMarkVoucher(phone, email, refCode);
    if (!voucher) {
      console.error('No vouchers left');
      // optionally inform admin here
      return res.status(200).send('no vouchers');
    }

    const message = `Your WASSCE voucher:\nSerial: ${voucher.serial}\nPIN: ${voucher.pin}\nThank you for buying from Authentic Checkers!`;

    // send SMS
    try {
      const smsResp = await sendArkeselSMS(phone, message);
      console.log('SMS sent', smsResp);
    } catch (e) {
      console.error('Arkesel send error', e.response ? e.response.data : e.message);
    }

    // affiliate logging
    try {
      if (refCode) {
        await recordAffiliateSale(refCode, phone, voucher.serial);
        console.log('Affiliate recorded:', refCode);
      }
    } catch (e) {
      console.error('Affiliate logging error', e.message || e);
    }

    // Optionally append a payments log row (Payments tab) - safe basic logging
    try {
      const sheets = getSheetsClient();
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'Payments!A:G',
        valueInputOption: 'RAW',
        requestBody: {
          values: [[new Date().toISOString(), data.reference || '', phone, email, 25, voucher.serial, refCode || '']]
        }
      });
    } catch (e) {
      console.error('Payment log append error', e.message || e);
    }

    return res.status(200).send('ok');

  } catch (err) {
    console.error('webhook error', err);
    return res.status(500).send('server error');
  }
});

app.get('/', (req, res) => res.send('Voucher server running ✔'));

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
