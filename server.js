app.get("/", (req, res) => {
  res.send("Voucher server is running ✔");
});

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const app = express();
app.use(bodyParser.json());

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  if (req.body.event !== 'charge.success') return;

  const phone = req.body.data?.customer?.phone;
  if (!phone) return;

  try {
    const doc = new GoogleSpreadsheet(process.env.SHEET_ID);
    await doc.useServiceAccountAuth({
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    if (rows.length === 0) return;

    const code = rows[0].code;
    await rows[0].delete();

    await axios.get(
      `https://sms.arkesel.com/sms/api?action=send-sms&api_key=${process.env.ARKESEL_API_KEY}&to=${phone}&from=Voucher&sms=Your WASSCE voucher: ${code}`
    );
  } catch (e) {
    console.error(e);
  }
});

app.listen(3000, ()=> console.log("Server running"));
