// server.js
// Full app: /create-payment -> initializes Paystack transaction
//           /webhook -> handles Paystack webhook (verifies signature), picks voucher from Google Sheet, sends Arkesel SMS

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
// capture raw body for webhook verification
app.use(bodyParser.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));

const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || ''; // for API calls
const PAYSTACK_WEBHOOK_SECRET = process.env.PAYSTACK_WEBHOOK_SECRET || PAYSTACK_SECRET_KEY; // used to verify signature
const ARKESEL_API_KEY = process.env.ARKESEL_API_KEY || '';
const ARKESEL_SENDER = process.env.ARKESEL_SENDER || ''; // optional
const SHEET_ID = process.env.SHEET_ID || '';
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL || '';
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || ''; // multiline private key

if (!SHEET_ID || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) {
  console.error('Missing Google Sheets config (SHEET_ID / GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY). Exiting.');
  process.exit(1);
}
if (!PAYSTACK_SECRET_KEY) {
  console.error('Missing PAYSTACK_SECRET_KEY. Exiting.');
  process.exit(1);
}
if (!ARKESEL_API_KEY) {
  console.warn('ARKESEL_API_KEY not set — SMS will fail until provided.');
}

// Google Sheets client helper
function getSheetsClient() {
  const key = GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const json = {
    type: "service_account",
    project_id: "auto",
    private_key_id: "auto",
    private_key: key,
    client_email: GOOGLE_CLIENT_EMAIL,
    client_id: "auto",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: "auto"
  };
  const auth = new google.auth.GoogleAuth({
    credentials: json,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

// picks first unused voucher row, marks it used, returns {serial,pin}
async function getAndMarkVoucher(phone, email) {
  const sheets = getSheetsClient();
  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'A2:F'
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
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `A${rowIndex}:F${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [
            [serial, pin, 'yes', phone || '', email || '', now]
          ]
        }
      });
      return { serial, pin };
    }
  }
  return null;
}

// send SMS via Arkesel
async function sendArkeselSMS(phone, message) {
  const url = 'https://sms.arkesel.com/api/v2/sms/send';
  const payload = { recipients: [phone], message: message };
  if (ARKESEL_SENDER) payload.sender = ARKESEL_SENDER;
  const headers = { 'Content-Type': 'application/json', 'api-key': ARKESEL_API_KEY };
  const resp = await axios.post(url, payload, { headers });
  return resp.data;
}

// Verify Paystack webhook signature (x-paystack-signature)
function verifyPaystackSignature(rawBody, signature) {
  const secret = PAYSTACK_WEBHOOK_SECRET;
  if (!secret) return false;
  const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  return hash === signature;
}

// ========== Route: create-payment ==========
// Expects JSON body: { name: string, email?: string, phone: string }
// Returns: { authorization_url, reference, amount }
app.post('/create-payment', async (req, res) => {
  try {
    const { name, phone, email } = req.body || {};
    if (!phone || !name) return res.status(400).json({ error: 'name and phone required' });

    // normalize phone to international format without '+', e.g., 233241234567
    let normalizedPhone = phone.trim();
    if (normalizedPhone.startsWith('0')) normalizedPhone = '233' + normalizedPhone.slice(1);
    if (normalizedPhone.startsWith('+')) normalizedPhone = normalizedPhone.slice(1);

    const amountGHS = 25.00;
    // Paystack expects amount in smallest currency unit (pesewas) -> 25.00 => 2500
    const amountSmallest = Math.round(amountGHS * 100);

    // build metadata
    const metadata = { name: name, phone: normalizedPhone, email: email || '' };

    // initialize transaction
    const initResp = await axios.post('https://api.paystack.co/transaction/initialize', {
      email: email || `${normalizedPhone}@noemail.local`,
      amount: amountSmallest,
      metadata: metadata,
      currency: 'GHS'
    }, {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const data = initResp.data;
    if (!data || !data.data) return res.status(500).json({ error: 'Paystack initialize failed' });

    // return authorization URL to client
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

// ========== Route: webhook ==========
// Paystack will POST here on transaction success
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

    // extract phone/email from metadata (we included it at initialization)
    let phone = '';
    let email = '';
    if (data.metadata) {
      phone = data.metadata.phone || phone;
      email = data.metadata.email || email;
    }
    // fallback: try data.customer info
    if (!phone && data.customer) phone = data.customer.phone || data.customer.mobile || '';
    if (!email && data.customer) email = data.customer.email || '';

    // normalize phone
    if (phone && phone.startsWith('0')) phone = '233' + phone.slice(1);
    if (phone && phone.startsWith('+')) phone = phone.slice(1);

    // get voucher
    const voucher = await getAndMarkVoucher(phone, email);
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

    return res.status(200).send('ok');

  } catch (err) {
    console.error('webhook error', err);
    return res.status(500).send('server error');
  }
});

app.get('/', (req, res) => res.send('Voucher server running ✔'));

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
app.post('/create-payment', async (req, res) => {
  const { name, phone } = req.body;

  if (!name || !phone) {
    return res.status(400).json({ error: "Name and phone required" });
  }

  try {
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: `${phone}@autovoucher.com`,
        amount: 2500 * 100, // 25 cedis
        metadata: { name, phone }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.json({
      authorization_url: response.data.data.authorization_url
    });

  } catch (error) {
    console.error(error.response?.data || error);
    return res.status(500).json({ error: "Payment creation failed" });
  }
});
app.post('/webhook', bodyParser.raw({ type: '*/*' }), async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const crypto = require("crypto");

    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest('hex');

    if (hash !== signature) {
      console.log("Signature mismatch");
      return res.sendStatus(401);
    }

    const event = JSON.parse(req.body);

    if (event.event === "charge.success") {
      const { name, phone } = event.data.metadata;

      console.log("Payment confirmed for:", name, phone);

      // ==== 1. GET unused voucher from Google Sheet ====
      await doc.loadInfo();
      const sheet = doc.sheetsByIndex[0];
      const rows = await sheet.getRows();

      const unused = rows.find(r => r.Status !== "USED");

      if (!unused) {
        console.log("No vouchers left");
        return res.sendStatus(200);
      }

      const voucherCode = unused.Code;

      // Mark voucher as used
      unused.Status = "USED";
      await unused.save();

      // ==== 2. SEND SMS VIA ARKESEL ====
      await axios.post(
        "https://sms.arkesel.com/api/v2/sms/send",
        {
          sender: "CHECKER",
          message: `Your WASSCE voucher: ${voucherCode}`,
          recipients: [phone]
        },
        {
          headers: {
            "api-key": process.env.ARKESEL_API_KEY
          }
        }
      );

      console.log("Voucher sent:", voucherCode);

      return res.sendStatus(200);
    }

    res.sendStatus(200);

  } catch (error) {
    console.error(error);
    res.sendStatus(500);
  }
});

