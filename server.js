// server.js
// Authentic Checkers backend - Paystack + Arkesel + Google Sheets (exact sheet structure)
// Required env vars (see below). Paste this file into your repo and deploy on Render.

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();

// Capture raw body for Paystack signature verification
app.use(bodyParser.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));

// CORS - allow your frontend origins
app.use(cors({
  origin: [
    "https://authenticcheckers.github.io",
    "https://sites.google.com",
    "https://sites.google.com/view/wasscevouchershop",
    "https://sites.google.com/view/wasscevouchershop/home"
  ],
  methods: ["GET","POST"],
  allowedHeaders: ["Content-Type","Authorization"]
}));

// ========== CONFIG ==========
const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_WEBHOOK_SECRET = process.env.PAYSTACK_WEBHOOK_SECRET || PAYSTACK_SECRET_KEY;
const ARKESEL_API_KEY = process.env.ARKESEL_API_KEY || '';
const ARKESEL_SENDER = process.env.ARKESEL_SENDER || '';
const SHEET_ID = process.env.SHEET_ID || '';
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL || '';
let GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || '';

// constants
const VOUCHER_PRICE_GHS = 25;
const COMMISSION_GHS = 3;

if (!PAYSTACK_SECRET_KEY) {
  console.error('Missing PAYSTACK_SECRET_KEY. Exiting.');
  process.exit(1);
}
if (!SHEET_ID || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) {
  console.error('Missing Google Sheets config (SHEET_ID / GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY). Exiting.');
  process.exit(1);
}
if (!ARKESEL_API_KEY) {
  console.warn('Warning: ARKESEL_API_KEY not set — SMS will fail until provided.');
}

// fix private key newlines if stored with \n sequences
GOOGLE_PRIVATE_KEY = GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

// ========== Google Sheets helper ==========
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

// ========== Utility functions ==========

/** Normalize Ghana phone to no '+' and international 233 format if user provided local 0xxxxx */
function normalizePhone(phone) {
  if (!phone) return '';
  let p = phone.toString().trim();
  p = p.replace(/\s+/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('0')) p = '233' + p.slice(1);
  return p;
}

/** Check Payments tab for existing paystack reference (idempotency) */
async function paymentsContainsReference(reference) {
  try {
    const sheets = getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Payments!B2:B' // PaystackReference column (B)
    });
    const rows = res.data.values || [];
    for (const r of rows) {
      if ((r[0] || '') === reference) return true;
    }
    return false;
  } catch (err) {
    // If Payments tab missing or read fails, return false so processing continues.
    console.warn('paymentsContainsReference read error (continuing):', err.message || err);
    return false;
  }
}

// ========== Voucher operations ==========

/**
 * Pick the first unused voucher from Main voucher sheet and mark USED.
 * Returns { serial, pin } or null if none.
 */
async function getAndMarkVoucher(phone, email, affiliateCode) {
  const sheets = getSheetsClient();
  const read = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Main voucher sheet!A2:G'
  });
  const rows = read.data.values || [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const used = (row[2] || '').toString().trim().toLowerCase();
    if (used !== 'yes' && used !== 'used') {
      const serial = (row[0] || '').toString().trim();
      const pin = (row[1] || '').toString().trim();
      const rowNumber = i + 2;
      const now = new Date().toISOString();
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `Main voucher sheet!A${rowNumber}:G${rowNumber}`,
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

// ========== Affiliate logging ==========

async function appendAffiliateSale(affiliateCode, buyerPhone, voucherSerial) {
  const sheets = getSheetsClient();
  const now = new Date().toISOString();
  const amount = VOUCHER_PRICE_GHS;
  const commission = COMMISSION_GHS;
  // Date | AffiliateCode | BuyerPhone | Amount | Commission | VoucherSerial | PaidStatus
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'AffiliateSales!A:G',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[now, affiliateCode || '', buyerPhone || '', amount, commission, voucherSerial || '', 'no']]
    }
  });
}

async function incrementAffiliateTotals(affiliateCode) {
  if (!affiliateCode) return;
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Affiliates!A2:E'
  });
  const rows = res.data.values || [];
  let found = -1;
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] || '').toString() === affiliateCode) { found = i; break; }
  }
  if (found === -1) {
    // append: AffiliateCode | Name(empty) | Phone(empty) | TotalSales=1 | TotalCommission=COMMISSION_GHS
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Affiliates!A:E',
      valueInputOption: 'RAW',
      requestBody: { values: [[affiliateCode, '', '', 1, COMMISSION_GHS]] }
    });
  } else {
    const idx = found + 2;
    const existing = rows[found];
    const prevSales = parseFloat(existing[3] || 0) || 0;
    const prevComm = parseFloat(existing[4] || 0) || 0;
    const newSales = prevSales + 1;
    const newComm = prevComm + COMMISSION_GHS;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Affiliates!D${idx}:E${idx}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[newSales, newComm]] }
    });
  }
}

// ========== Payments log (optional) ==========

async function appendPaymentLog(reference, phone, email, amount, voucherSerial, affiliateCode) {
  const sheets = getSheetsClient();
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Payments!A:G',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[new Date().toISOString(), reference || '', phone || '', email || '', amount || '', voucherSerial || '', affiliateCode || '']]
      }
    });
  } catch (err) {
    // optional Payments tab; non-fatal
    console.warn('appendPaymentLog failed (optional):', err.message || err);
  }
}

// ========== Arkesel SMS ==========
async function sendArkeselSMS(phone, message) {
  if (!ARKESEL_API_KEY) throw new Error('ARKESEL_API_KEY not configured');
  const url = 'https://sms.arkesel.com/api/v2/sms/send';
  const payload = { recipients: [phone], message };
  if (ARKESEL_SENDER) payload.sender = ARKESEL_SENDER;
  const headers = { 'Content-Type': 'application/json', 'api-key': ARKESEL_API_KEY };
  const resp = await axios.post(url, payload, { headers });
  return resp.data;
}

// ========== Paystack signature verify ==========
function verifyPaystackSignature(rawBody, signature) {
  if (!PAYSTACK_WEBHOOK_SECRET) return false;
  const computed = crypto.createHmac('sha512', PAYSTACK_WEBHOOK_SECRET).update(rawBody).digest('hex');
  return computed === signature;
}

// -------------------- ROUTES --------------------

/**
 * POST /create-payment
 * Body: { name, phone, email, ref }
 * Returns: { authorization_url, reference, amount }
 */
app.post('/create-payment', async (req, res) => {
  try {
    const { name, phone, email, ref } = req.body || {};
    if (!name || !phone || !email) {
      return res.status(400).json({ error: 'name, phone and email required' });
    }
    const normalizedPhone = normalizePhone(phone);
    const amountPesewas = Math.round(VOUCHER_PRICE_GHS * 100);

    const resp = await axios.post('https://api.paystack.co/transaction/initialize', {
      email,
      amount: amountPesewas,
      currency: 'GHS',
      metadata: { name, phone: normalizedPhone, ref: ref || null }
    }, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' }
    });

    if (!resp.data || !resp.data.data) {
      return res.status(500).json({ error: 'Paystack initialize failed' });
    }

    return res.json({
      authorization_url: resp.data.data.authorization_url,
      reference: resp.data.data.reference,
      amount: VOUCHER_PRICE_GHS
    });
  } catch (err) {
    console.error('create-payment error:', err.response?.data || err.message);
    const body = err.response?.data || { error: 'server error' };
    return res.status(500).json(body);
  }
});

/**
 * POST /webhook
 * Paystack will POST here with x-paystack-signature header
 */
app.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'] || req.headers['X-Paystack-Signature'];
    const raw = req.rawBody || JSON.stringify(req.body);

    if (!verifyPaystackSignature(raw, signature)) {
      console.warn('Invalid Paystack signature');
      return res.status(400).send('Invalid signature');
    }

    const event = req.body;
    if (!event || event.event !== 'charge.success') {
      return res.status(200).send('ignored');
    }

    const data = event.data || {};
    if ((data.status || '').toLowerCase() !== 'success') {
      return res.status(200).send('ignored');
    }

    const metadata = data.metadata || {};
    let phone = metadata.phone || '';
    let email = metadata.email || '';
    const refCode = metadata.ref || null;
    const paystackRef = data.reference || '';

    // Idempotency: check if this reference was already processed via Payments sheet
    const already = await paymentsContainsReference(paystackRef);
    if (already) {
      console.log('Webhook duplicate ignored for reference:', paystackRef);
      return res.status(200).send('already processed');
    }

    // Normalize phone
    if (phone && phone.startsWith('0')) phone = '233' + phone.slice(1);
    if (phone && phone.startsWith('+')) phone = phone.slice(1);

    // Pick a voucher and mark it used
    const voucher = await getAndMarkVoucher(phone, email, refCode);
    if (!voucher) {
      console.error('No vouchers left');
      // append a payment log anyway
      await appendPaymentLog(paystackRef, phone, email, VOUCHER_PRICE_GHS, '', refCode || '');
      return res.status(200).send('no vouchers');
    }

    // Send SMS
    const message = `Your WASSCE voucher:\nSerial: ${voucher.serial}\nPIN: ${voucher.pin}\nThank you for buying from Authentic Checkers!`;
    try {
      await sendArkeselSMS(phone, message);
      console.log('SMS sent to', phone);
    } catch (err) {
      console.error('Arkesel send error:', err.response?.data || err.message);
    }

    // Affiliate: append sale and increment totals
    try {
      if (refCode) {
        await appendAffiliateSale(refCode, phone, voucher.serial);
        await incrementAffiliateTotals(refCode);
        console.log('Affiliate recorded for', refCode);
      }
    } catch (err) {
      console.error('Affiliate logging error:', err.message || err);
    }

    // Append payment log to Payments (optional)
    try {
      await appendPaymentLog(paystackRef, phone, email, VOUCHER_PRICE_GHS, voucher.serial, refCode || '');
    } catch (err) {
      console.warn('Payment log append error:', err.message || err);
    }

    return res.status(200).send('ok');

  } catch (err) {
    console.error('webhook error:', err);
    return res.status(500).send('server error');
  }
});

// Health
app.get('/', (req, res) => res.send('Voucher server running ✔'));

// Start server
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
