const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Derived with the identical SQL expression GET /shoot-plan already uses
// for its own week filter, so the two never drift apart into disagreeing
// about which calendar week is "this week."
const WEEK_START_SQL = `date_trunc('week', now())::date`;

router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM weekly_shoot_plan_confirmations WHERE week_start = ${WEEK_START_SQL}`
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    // ON CONFLICT DO NOTHING so a second confirm click never bumps
    // confirmed_at -- the row should record the FIRST confirmation. The
    // primary key on week_start makes this race-safe if two people click
    // at once: whichever insert loses just falls through to DO NOTHING.
    const inserted = await pool.query(
      `INSERT INTO weekly_shoot_plan_confirmations (week_start) VALUES (${WEEK_START_SQL})
       ON CONFLICT (week_start) DO NOTHING RETURNING *`
    );
    if (inserted.rows.length) return res.status(201).json(inserted.rows[0]);

    const existing = await pool.query(
      `SELECT * FROM weekly_shoot_plan_confirmations WHERE week_start = ${WEEK_START_SQL}`
    );
    res.json(existing.rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
