const express = require('express');
const { COOKIE_NAME, issueToken, checkPassword } = require('../auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (!checkPassword(password)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  const token = issueToken();
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

router.get('/session', (req, res) => {
  const { verifyToken } = require('../auth');
  const token = req.cookies ? req.cookies[COOKIE_NAME] : null;
  res.json({ authenticated: verifyToken(token) });
});

module.exports = router;
