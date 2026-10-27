// Public friend code for a player: 6 easy-to-read characters made from their
// private player id. Safe to show to others; the id itself stays secret.
const crypto = require('crypto');
const ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
module.exports = pid => {
  if (!pid) return null;
  const h = crypto.createHash('sha256').update('dp-friend:' + pid).digest();
  let s = '';
  for (let i = 0; i < 6; i++) s += ABC[h[i] % ABC.length];
  return s;
};
