// server.js
// Full: create-payment, webhook, voucher assignment, Arkesel SMS, affiliate logging

const express = require('express');
const cors = require("cors");
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();

// Allow browser calls from your GitHub Pages + Google Sites
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

// ======= ENV CONFIG =======
const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_WEBHOOK_SECRET = process.env.PAYSTACK_WEBHOOK_SECRET || PAYSTACK_SECRET_KEY;
const ARKESEL_API_KEY = process.env.ARKESEL_API_KEY || '';
const ARKESEL_SENDER = process.env.ARKESEL_SENDER || '';
const SHEET_ID = process.env.SHEET_ID || '';
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL || '';
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || '';

if (!PAYSTACK_SECRET_KEY) {
  console.error("Missing Paystack key.");
  process.exit(1);
}
if (!SHEET_ID || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) {
  console.error("Missing Google Sheets credentials.");
  process.exit(1);
}
if (!ARKESEL_API_KEY) {
  console.warn("⚠ Arkesel API key missing — SMS will fail.");
}

// ======= GOOGLE SHEETS CLIENT =======
function getSheetsClient() {
  const key = GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

  const auth = new google.auth.GoogleAuth({
    credentials: {
      type: "service_account",
      client_email: GOOGLE_CLIENT_EMAIL,
      private_key: key
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  return google.sheets({ version: 'v4', auth });
}

// ======= PICK + MARK VOUCHER =======
// Sheet columns: A = Serial, B = Pin, C = Status, D = Phone, E = Email, F = Date
async function getAndMarkVoucher(phone, email) {
  const sheets = getSheetsClient();

  const read = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "A2:F"
  });

  const rows = read.data.values || [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const status = (row[2] || "").toLowerCase().trim();

    if (status !== "used" && status !== "yes") {
      const serial = (row[0] || "").trim();
      const pin = (row[1] || "").trim();

      const rowNumber = i + 2; // Sheet row index starts at row 2
      const timestamp = new Date().toISOString();

      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `A${rowNumber}:F${rowNumber}`,
        valueInputOption: "RAW",
        requestBody: {
          values: [[serial, pin, "USED", phone, email, timestamp]]
        }
      });

      return { serial, pin };
    }
  }

  return null;
}

// ======= SEND SMS VIA ARKESEL =======
async function sendSMS(phone, message) {
  const payload = { recipients: [phone], message };
  if (ARKESEL_SENDER) payload.sender = ARKESEL_SENDER;

  const resp = await axios.post(
    "https://sms.arkesel.com/api/v2/sms/send",
    payload,
    { headers: { "api-key": ARKESEL_API_KEY } }
  );

  return resp.data;
}

// ======= VERIFY PAYSTACK SIGNATURE =======
function verifySignature(rawBody, signature) {
  const computed = crypto
    .createHmac("sha512", PAYSTACK_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  return computed === signature;
}

// ========== AFFILIATE: recordAffiliateSale ==========
// Appends a row to AffiliateSales and updates Affiliates totals.
// AffiliateSales columns: Date | AffiliateCode | BuyerPhone | Amount | Commission
// Affiliates columns: AffiliateCode | Name | Phone | TotalSales | TotalCommission
const COMMISSION_GHS = 3; // fixed commission per voucher
async function recordAffiliateSale(refCode, buyerPhone, amountGHS) {
  if (!refCode) return;

  const sheets = getSheetsClient();
  const date = new Date().toISOString();
  const commission = COMMISSION_GHS;

  // 1) Append to AffiliateSales
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "AffiliateSales!A:E",
    valueInputOption: "RAW",
    requestBody: {
      values: [[date, refCode, buyerPhone, amountGHS, commission]]
    }
  });

  // 2) Update Affiliates sheet totals (find row with AffiliateCode)
  const affRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Affiliates!A2:E"
  });
  const affRows = affRes.data.values || [];

  let foundIndex = -1;
  for (let i = 0; i < affRows.length; i++) {
    if ((affRows[i][0] || "").toString() === refCode) {
      foundIndex = i;
      break;
    }
  }

  if (foundIndex === -1) {
    // create new affiliate row
    const totalSales = amountGHS;
    const totalCommission = commission;
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Affiliates!A:E",
      valueInputOption: "RAW",
      requestBody: {
        values: [[refCode, "", "", totalSales, totalCommission]]
      }
    });
  } else {
    // update existing totals
    const rowNum = foundIndex + 2; // offset
    const existing = affRows[foundIndex];
    const prevSales = parseFloat(existing[3] || 0) || 0;
    const prevComm = parseFloat(existing[4] || 0) || 0;
    const newSales = prevSales + amountGHS;
    const newComm = prevComm + commission;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Affiliates!D${rowNum}:E${rowNum}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[newSales, newComm]]
      }
    });
  }
}

// =========================================================
// =============== CREATE PAYMENT ROUTE ====================
// =========================================================
app.post('/create-payment', async (req, res) => {
  try {
    const { name, phone, email, ref } = req.body;

    if (!name || !phone) return res.status(400).json({ error: "name and phone required" });

    // Normalize phone: 054... → 23354...
    let fixedPhone = phone.trim();
    if (fixedPhone.startsWith("0")) fixedPhone = "233" + fixedPhone.slice(1);
    if (fixedPhone.startsWith("+")) fixedPhone = fixedPhone.slice(1);

    const amountGHS = 25.00;
    const amountPesewas = Math.round(amountGHS * 100);

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: email || `${fixedPhone}@noemail.local`,
        amount: amountPesewas,
        currency: "GHS",
        metadata: { name, phone: fixedPhone, ref: ref || null }
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.json({
      authorization_url: response.data.data.authorization_url,
      reference: response.data.data.reference,
      amount: amountGHS
    });

  } catch (err) {
    console.error("create-payment error:", err.response?.data || err.message);
    res.status(500).json({ error: "Payment creation failed" });
  }
});

// =========================================================
// ==================== WEBHOOK ROUTE ======================
// =========================================================
app.post("/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-paystack-signature"];
    const raw = req.rawBody;

    if (!verifySignature(raw, signature)) {
      console.log("❌ INVALID SIGNATURE — ignoring.");
      return res.status(400).send("Invalid signature");
    }

    const event = req.body;

    if (event.event !== "charge.success") return res.status(200).send("ignored");

    const data = event.data;
    const metadata = data.metadata || {};

    let phone = metadata.phone || "";
    let email = metadata.email || "";

    if (phone && phone.startsWith("0")) phone = "233" + phone.slice(1);
    if (phone && phone.startsWith("+")) phone = phone.slice(1);

    // ===== get voucher =====
    const voucher = await getAndMarkVoucher(phone, email);
    if (!voucher) {
      console.log("❌ No vouchers left!");
      return res.status(200).send("no vouchers");
    }

    // ===== send SMS =====
    const msg =
      `Your WASSCE Voucher:\nSerial: ${voucher.serial}\nPIN: ${voucher.pin}\nThank you for buying from Authentic Checkers.`;

    try {
      const sms = await sendSMS(phone, msg);
      console.log("SMS sent:", sms);
    } catch (e) {
      console.error("SMS error:", e.response?.data || e.message);
    }

    // ===== affiliate logging =====
    try {
      const refCode = metadata.ref || null;
      if (refCode) {
        await recordAffiliateSale(refCode, phone, 25.00);
        console.log("Affiliate recorded:", refCode);
      }
    } catch (e) {
      console.error("Affiliate logging error:", e.message || e);
    }

    return res.status(200).send("ok");

  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("server error");
  }
});

// =========================================================
app.get("/", (req, res) => res.send("Voucher server running ✔"));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
