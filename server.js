// =================== CORS ==========================
const cors = require("cors");
app.use(cors({
  origin: "https://authenticcheckers.github.io",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// ================== IMPORTS ========================
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();

// Needed for Paystack signature verification
app.use(bodyParser.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));

// ================== ENV KEYS =======================
const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_WEBHOOK_SECRET = process.env.PAYSTACK_WEBHOOK_SECRET || PAYSTACK_SECRET_KEY;

const ARKESEL_API_KEY = process.env.ARKESEL_API_KEY || '';
const ARKESEL_SENDER = process.env.ARKESEL_SENDER || '';

const SHEET_ID = process.env.SHEET_ID || '';
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL || '';
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || '';

if (!PAYSTACK_SECRET_KEY || !SHEET_ID || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) {
  console.error("Missing environment variables");
  process.exit(1);
}

// =================== GOOGLE SHEETS =================
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

// ============ PICK & MARK VOUCHER ==================
async function getAndMarkVoucher(phone, email, refCode) {
  const sheets = getSheetsClient();

  const read = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "A2:G"
  });

  const rows = read.data.values || [];

  // Find first unused row
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const status = (row[2] || "").toLowerCase();

    if (status !== "used") {
      const serial = row[0];
      const pin = row[1];
      const rowNumber = i + 2;
      const timestamp = new Date().toISOString();

      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `A${rowNumber}:G${rowNumber}`,
        valueInputOption: "RAW",
        requestBody: {
          values: [[serial, pin, "USED", phone, email, timestamp, refCode || ""]]
        }
      });

      return { serial, pin };
    }
  }
  return null;
}

// ===================== ARKESEL SMS ===================
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

// ================ PAYSTACK SIGNATURE ==================
function verifySignature(rawBody, signature) {
  const computed = crypto
    .createHmac("sha512", PAYSTACK_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  return computed === signature;
}

// ======================================================
// =============== CREATE PAYMENT ROUTE =================
// ======================================================
app.post('/create-payment', async (req, res) => {
  try {
    const { name, phone, email, ref } = req.body;

    if (!name || !phone || !email) {
      return res.status(400).json({ error: "name, phone and email required" });
    }

    // Normalize Ghana phone number
    let fixedPhone = phone.trim();
    if (fixedPhone.startsWith("0")) fixedPhone = "233" + fixedPhone.slice(1);
    if (fixedPhone.startsWith("+")) fixedPhone = fixedPhone.slice(1);

    // Amount
    const amountGHS = 25.00;
    const amountPesewas = amountGHS * 100;

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: amountPesewas,
        currency: "GHS",
        metadata: { name, phone: fixedPhone, email, refCode: ref || "" }
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
      reference: response.data.data.reference
    });

  } catch (err) {
    console.error("create-payment error:", err.response?.data || err.message);
    res.status(500).json({ error: "Payment creation failed" });
  }
});

// ======================================================
// ====================== WEBHOOK =======================
// ======================================================
app.post("/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-paystack-signature"];
    if (!verifySignature(req.rawBody, signature)) {
      return res.status(400).send("Invalid signature");
    }

    const event = req.body;
    if (event.event !== "charge.success") {
      return res.status(200).send("ignored");
    }

    const data = event.data;
    const md = data.metadata || {};

    let phone = md.phone;
    let email = md.email;
    let refCode = md.refCode;

    // Reformat phone
    if (phone.startsWith("0")) phone = "233" + phone.slice(1);
    if (phone.startsWith("+")) phone = phone.slice(1);

    // Get voucher
    const voucher = await getAndMarkVoucher(phone, email, refCode);
    if (!voucher) {
      return res.status(200).send("no vouchers");
    }

    // SMS content
    const msg = `Your WASSCE Voucher:\nSerial: ${voucher.serial}\nPIN: ${voucher.pin}\nThank you for buying from Authentic Checkers.`;

    try {
      await sendSMS(phone, msg);
    } catch (e) {
      console.error("SMS error:", e.response?.data || e.message);
    }

    res.status(200).send("ok");

  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("server error");
  }
});

// ======================================================

app.get("/", (req, res) => res.send("Voucher server running ✔"));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
