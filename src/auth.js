const crypto = require('crypto');
const { pool } = require('./db');
const { verifyPassword } = require('./lib/passwordHash');

const COOKIE_NAME = 'wndrr_ad_pipeline_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET is not set.');
  }
  return secret;
}

function sign(value) {
  return crypto.createHmac('sha256', getSecret()).update(value).digest('hex');
}

// The signed cookie itself carries which user this session belongs to (no
// server-side session store needed) -- payload is "<userId>.<expires>",
// same stateless-cookie approach as before per-user login existed, just now
// identity-bearing.
function issueToken(userId) {
  const expires = Date.now() + SESSION_TTL_MS;
  const payload = `${userId}.${expires}`;
  const sig = sign(payload);
  return `${payload}.${sig}`;
}

// Returns the authenticated user id, or null if the token is missing,
// malformed, tampered with, or expired.
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userIdStr, expiresStr, sig] = parts;
  const payload = `${userIdStr}.${expiresStr}`;

  const expected = sign(payload);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  const expires = Number(expiresStr);
  const userId = Number(userIdStr);
  if (!Number.isFinite(expires) || Date.now() >= expires) return null;
  if (!Number.isFinite(userId)) return null;
  return userId;
}

// Individual email+password login -- replaces the old single shared
// APP_PASSWORD gate entirely. Only an active user can log in.
async function checkCredentials(email, password) {
  if (!email || !password) return null;
  const result = await pool.query(
    'SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND active = true',
    [String(email).trim()]
  );
  const user = result.rows[0];
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return user;
}

async function requireAuth(req, res, next) {
  const token = req.cookies ? req.cookies[COOKIE_NAME] : null;
  const userId = verifyToken(token);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const result = await pool.query('SELECT id, name, email, role, active FROM users WHERE id = $1', [userId]);
    const user = result.rows[0];
    // Re-checked on every request (not just at login) so deactivating a
    // user takes effect immediately, even on an already-issued cookie.
    if (!user || !user.active) return res.status(401).json({ error: 'Not authenticated' });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { COOKIE_NAME, issueToken, verifyToken, checkCredentials, requireAuth };
