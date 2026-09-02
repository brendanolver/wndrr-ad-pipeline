const express = require('express');
const { COOKIE_NAME, issueToken, verifyToken, checkCredentials } = require('../auth');
const { pool } = require('../db');

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const user = await checkCredentials(email, password);
    if (!user) return res.status(401).json({ error: 'Incorrect email or password' });

    const token = issueToken(user.id);
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// Also returns the caller's own permission list (their role's grants) --
// nothing in the app enforces these yet, but this is the one live proof
// the permission model actually resolves end to end for a real user.
router.get('/session', async (req, res, next) => {
  try {
    const token = req.cookies ? req.cookies[COOKIE_NAME] : null;
    const userId = verifyToken(token);
    if (!userId) return res.json({ authenticated: false });

    const userResult = await pool.query('SELECT id, name, email, role, active FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];
    if (!user || !user.active) return res.json({ authenticated: false });

    const permsResult = await pool.query('SELECT permission_key FROM role_permissions WHERE role = $1', [user.role]);
    res.json({
      authenticated: true,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      permissions: permsResult.rows.map((r) => r.permission_key),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
