const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Read-only for V1 -- no invite/create/deactivate UI yet (per the brief).
// The six seed accounts are managed via src/db.js's seedUsersAndBackfill();
// this just exposes them for anything that wants a real users list (rather
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

module.exports = router;
