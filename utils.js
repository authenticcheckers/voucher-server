// utils.js

function normalizePhone(phone) {
  if (!phone) return '';
  let p = phone.toString().trim();
  p = p.replace(/\s+/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('0')) p = '233' + p.slice(1);
  return p;
}

// voucher generator (not used by current flow but included)
function generateVoucher() {
  const a = Math.random().toString(36).substring(2, 8).toUpperCase();
  const b = Math.floor(100000 + Math.random() * 900000);
  return `${a}-${b}`;
}

module.exports = { normalizePhone, generateVoucher };
