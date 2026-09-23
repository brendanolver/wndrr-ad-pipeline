const express = require('express');
const { pool } = require('../db');
const { ALL_MODULE_KEYS, requireAdmin } = require('../lib/permissions');

const router = express.Router();

// Read-only for V1 -- no invite/create/deactivate UI yet (per the brief).
// Seed accounts are managed via src/db.js's seedUsersAndBackfill(); this
// just exposes them for anything that wants a real users list (rather
// than the narrower content_creators one) later.
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, role, active FROM users WHERE active = true ORDER BY name ASC'
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// Round 11 Settings "User Management" surface -- admin-only (see the
// brief, item 13: "Only Admin users should be able to manage user
// permissions"). Separate route from the plain GET / above (which any
// authenticated user can already call and which nothing currently
// restricts) rather than changing that one's contract, since exposing
// every user's module-restriction list is a bigger disclosure than a
// plain name/email/role directory.
router.get('/manage', requireAdmin, async (req, res, next) => {
  try {
    const usersResult = await pool.query(
      'SELECT id, name, email, role, active FROM users WHERE active = true ORDER BY name ASC'
    );
    const restrictionsResult = await pool.query('SELECT user_id, module_key FROM user_module_restrictions');
    const restrictedByUser = new Map();
    for (const row of restrictionsResult.rows) {
      if (!restrictedByUser.has(row.user_id)) restrictedByUser.set(row.user_id, []);
      restrictedByUser.get(row.user_id).push(row.module_key);
    }
    res.json({
      module_keys: ALL_MODULE_KEYS,
      users: usersResult.rows.map((u) => ({ ...u, restricted_modules: restrictedByUser.get(u.id) || [] })),
    });
  } catch (err) {
    next(err);
  }
});

// Replaces a user's whole restricted-module set (never a partial merge --
// the Settings checkbox grid always submits its full current state, same
// "the client sends the complete picture" pattern as hook_variations/
// reference_links elsewhere in this app) and optionally their role in the
// same call. Admin-only, same guard as GET /manage above.
router.patch('/:id/access', requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { role, restricted_modules } = req.body || {};
    if (role !== undefined && !['admin', 'marketing', 'creative', 'viewer', 'lead', 'member'].includes(role)) {
      client.release();
      return res.status(400).json({ error: 'Invalid role' });
    }
    if (restricted_modules !== undefined) {
      if (!Array.isArray(restricted_modules) || restricted_modules.some((m) => !ALL_MODULE_KEYS.includes(m))) {
        client.release();
        return res.status(400).json({ error: `restricted_modules must be an array of: ${ALL_MODULE_KEYS.join(', ')}` });
      }
    }

    await client.query('BEGIN');
    if (role !== undefined) {
      await client.query('UPDATE users SET role = $1, updated_at = now() WHERE id = $2', [role, req.params.id]);
    }
    if (restricted_modules !== undefined) {
      await client.query('DELETE FROM user_module_restrictions WHERE user_id = $1', [req.params.id]);
      for (const moduleKey of restricted_modules) {
        await client.query(
          'INSERT INTO user_module_restrictions (user_id, module_key) VALUES ($1, $2)',
          [req.params.id, moduleKey]
        );
      }
    }
    const result = await client.query('SELECT id, name, email, role, active FROM users WHERE id = $1', [req.params.id]);
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }
    await client.query('COMMIT');
    res.json({ ...result.rows[0], restricted_modules: restricted_modules !== undefined ? restricted_modules : undefined });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
