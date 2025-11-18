// utils.js

function generateVoucherCode() {
  const s = Math.random().toString(36).slice(2, 10).toUpperCase();
  const n = Math.floor(1000 + Math.random() * 9000);
  return `${s}-${n}`;
}

function normalizePhone(phone) {
  if (!phone) return '';
  let p = phone.toString().trim();
  p = p.replace(/\s+/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('0')) p = '233' + p.slice(1);
  return p;
}

module.exports = { generateVoucherCode, normalizePhone };
