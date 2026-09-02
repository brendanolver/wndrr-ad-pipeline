const crypto = require('crypto');

// Node's built-in crypto.scrypt -- no extra dependency (bcrypt/argon2 etc.)
// for what the brief calls "the minimum clean login experience," and this
// codebase already leans on Node's crypto module for the session-token HMAC
// in auth.js. A random per-password salt (never the app's shared session
// secret) is the whole point of storing it alongside the hash below.
const KEY_LENGTH = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, KEY_LENGTH).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hashHex] = parts;
  const hashBuf = Buffer.from(hashHex, 'hex');
  const candidateBuf = crypto.scryptSync(String(password), salt, hashBuf.length);
  if (candidateBuf.length !== hashBuf.length) return false;
  return crypto.timingSafeEqual(candidateBuf, hashBuf);
}

module.exports = { hashPassword, verifyPassword };
