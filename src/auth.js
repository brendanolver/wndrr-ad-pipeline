const crypto = require('crypto');

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

function issueToken() {
  const expires = Date.now() + SESSION_TTL_MS;
  const payload = `${expires}`;
  const sig = sign(payload);
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;

  const expected = sign(payload);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;

  const expires = Number(payload);
  return Number.isFinite(expires) && Date.now() < expires;
}

function checkPassword(candidate) {
  const appPassword = process.env.APP_PASSWORD;
  if (!appPassword) {
    throw new Error('APP_PASSWORD is not set.');
  }
  if (typeof candidate !== 'string') return false;

  const candidateBuf = Buffer.from(candidate);
  const expectedBuf = Buffer.from(appPassword);
  if (candidateBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(candidateBuf, expectedBuf);
}

function requireAuth(req, res, next) {
  const token = req.cookies ? req.cookies[COOKIE_NAME] : null;
  if (verifyToken(token)) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

module.exports = { COOKIE_NAME, issueToken, verifyToken, checkPassword, requireAuth };
