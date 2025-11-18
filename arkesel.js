// arkesel.js
const axios = require('axios');

const ARKESEL_API_KEY = process.env.ARKESEL_API_KEY || '';
const ARKESEL_SENDER = process.env.ARKESEL_SENDER || '';

if (!ARKESEL_API_KEY) {
  console.warn('ARKESEL_API_KEY not set. SMS will fail until provided.');
}

async function sendSMS(phone, message) {
  if (!ARKESEL_API_KEY) throw new Error('ARKESEL_API_KEY missing');

  const payload = { recipients: [phone], message };
  if (ARKESEL_SENDER) payload.sender = ARKESEL_SENDER;

  const resp = await axios.post('https://sms.arkesel.com/api/v2/sms/send', payload, {
    headers: {
      'Content-Type': 'application/json',
      'api-key': ARKESEL_API_KEY
    }
  });

  return resp.data;
}

module.exports = { sendSMS };
