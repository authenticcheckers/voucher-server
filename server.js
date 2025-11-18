// server.js
// Backend for Authentic Vouchers (Paystack + Arkesel + Google Sheets)
// Matches your current sheets where Main voucher sheet has 6 columns (no AffiliateCode)

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const sheets = require('./sheets');
const arkesel = require('./arkesel');
const utils = require('./utils');

const app = express();

// Capture raw body for Paystack signature verification
app.use(bodyParser.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));

// CORS - add any extra origin your frontend uses
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

const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_WEBHOOK_SECRET = process.env.PAYSTACK_WEBHOOK_SECRET || PAYSTACK_SECRET_KEY;
const VOUCHER_PRICE_GHS = 25;
const COMMISSION_GHS = 3;

if (!PAYSTACK_SECRET_KEY) {
  console.error('Missing PAYSTACK_SECRET_KEY. Exiting.');
  process.exit(1);
}
if (!process.env.SHEET_ID || !process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
  console.error('Missing Google Sheets credentials (SHEET_ID / GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY). Exiting.');
  process.exit(1);
}
if (!process.env.ARKESEL_API_KEY) {
  console.warn('ARKESEL_API_KEY not set — SMS will fail until provided.');
}

// Utility: verify Paystack signature
function verifyPaystackSignature(rawBody, signature) {
  if (!PAYSTACK_WEBHOOK_SECRET) return false;
  const hash = crypto.createHmac('sha512', PAYSTACK_WEBHOOK_SECRET).update(rawBody).digest('hex');
  return hash === signature;
}

/**
 * POST /create-payment
 * Body: { name, phone, email, ref }
 * Returns authorization_url + reference
 */
app.post('/create-payment', async (req, res) => {
  try {
    const { name, phone, email, ref } = req.body || {};

    if (!name || !phone || !email) {
      return res.status(400).json({ error: 'name, phone and email required' });
    }

    const normalizedPhone = utils.normalizePhone(phone);
    const amountPesewas = Math.round(VOUCHER_PRICE_GHS * 100);

    const initResp = await axios.post('https://api.paystack.co/transaction/initialize', {
      email,
      amount: amountPesewas,
      currency: 'GHS',
      metadata: { name, phone: normalizedPhone, ref: ref || null }
    }, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' }
    });

    if (!initResp.data || !initResp.data.data) {
      console.error('Paystack initialize returned unexpected response', initResp.data);
      return res.status(500).json({ error: 'Paystack initialize failed' });
    }

    return res.json({
      authorization_url: initResp.data.data.authorization_url,
      reference: initResp.data.data.reference,
      amount: VOUCHER_PRICE_GHS
    });

  } catch (err) {
    console.error('create-payment error', err.response?.data || err.message || err);
    const body = err.response?.data || { error: 'server error' };
    return res.status(500).json(body);
  }
});

/**
 * POST /webhook
 * Paystack posts here on charge.success
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
    if ((data.status || '').toLowerCase() !== 'success') return res.status(200).send('ignored');

    const metadata = data.metadata || {};
    let phone = metadata.phone || '';
    let email = metadata.email || '';
    const refCode = metadata.ref || null;
    const paystackRef = data.reference || '';

    // Idempotency: check Payments tab for existing reference
    const already = await sheets.paymentsContainsReference(paystackRef);
    if (already) {
      console.log('Webhook duplicate ignored for reference:', paystackRef);
      return res.status(200).send('already processed');
    }

    // Normalize phone for SMS
    if (phone && phone.startsWith('0')) phone = '233' + phone.slice(1);
    if (phone && phone.startsWith('+')) phone = phone.slice(1);

    // Get and mark a voucher (note: voucher sheet has no AffiliateCode column)
    const voucher = await sheets.getAndMarkVoucher(phone, email);
    if (!voucher) {
      console.error('No vouchers left');
      // Append payment log for record even if no voucher
      await sheets.appendPaymentLog(paystackRef, phone, email, VOUCHER_PRICE_GHS, '', refCode || '');
      return res.status(200).send('no vouchers');
    }

    // Send SMS by Arkesel
    const message = `Your WASSCE voucher:\nSerial: ${voucher.serial}\nPIN: ${voucher.pin}\nThank you for buying from Authentic Checkers!`;
    try {
      await arkesel.sendSMS(phone, message);
      console.log('SMS sent to', phone);
    } catch (err) {
      console.error('Arkesel send error', err.response?.data || err.message || err);
    }

    // Affiliate logging (only in Affiliates & AffiliateSales tabs)
    if (refCode) {
      try {
        await sheets.appendAffiliateSaleRow(refCode, phone, voucher.serial);
        await sheets.updateOrCreateAffiliateTotals(refCode);
        console.log('Affiliate sale recorded for', refCode);
      } catch (err) {
        console.error('Affiliate logging error', err.message || err);
      }
    }

    // append to payments log (optional)
    try {
      await sheets.appendPaymentLog(paystackRef, phone, email, VOUCHER_PRICE_GHS, voucher.serial, refCode || '');
    } catch (err) {
      console.warn('Payment log append error (non-fatal):', err.message || err);
    }

    return res.status(200).send('ok');

  } catch (err) {
    console.error('webhook error', err);
    return res.status(500).send('server error');
  }
});

// Health
app.get('/', (req, res) => res.send('Voucher server running ✔'));

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
