const express = require('express');
const { pool } = require('../db');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM planning_settings WHERE id = 1');
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Each Settings field on the frontend has its own independent Save button
// that sends only its own field -- so every field here is validated only
// when present, and the SET clause is built from whichever fields were
// actually provided, rather than requiring the whole row every time.
router.put('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const updates = {};

    if (body.weekly_new_concept_target !== undefined) {
      const v = Number.parseInt(body.weekly_new_concept_target, 10);
      if (!Number.isInteger(v) || v < 0) {
        return res.status(400).json({ error: 'weekly_new_concept_target must be a non-negative integer' });
      }
      updates.weekly_new_concept_target = v;
    }
    if (body.high_stock_min_soh !== undefined) {
      const v = Number.parseInt(body.high_stock_min_soh, 10);
      if (!Number.isInteger(v) || v < 0) {
        return res.status(400).json({ error: 'high_stock_min_soh must be a non-negative integer' });
      }
      updates.high_stock_min_soh = v;
    }
    for (const field of ['default_shoot_top_size', 'default_shoot_bottom_alpha_size', 'default_shoot_bottom_waist_size']) {
      if (body[field] === undefined) continue;
      const v = String(body[field] || '').trim();
      if (!v) return res.status(400).json({ error: `${field} is required` });
      updates[field] = v;
    }

    const keys = Object.keys(updates);
    if (!keys.length) {
      return res.status(400).json({ error: 'No valid fields provided' });
    }

    const setClauses = keys.map((key, i) => `${key} = $${i + 1}`);
    const values = keys.map((key) => updates[key]);
    const result = await pool.query(
      `UPDATE planning_settings SET ${setClauses.join(', ')}, updated_at = now() WHERE id = 1 RETURNING *`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
