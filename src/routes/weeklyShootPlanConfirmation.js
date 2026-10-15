const express = require('express');
const { pool } = require('../db');
const { confirmationPreview, autoLinkedSql } = require('../lib/shootPlanSelection');

const router = express.Router();
const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

// Falls back to the current calendar week (same date_trunc('week', ...)
// expression GET/POST /shoot-plan use for their own default) whenever the
// caller doesn't pass an explicit week_start -- lets week navigation ask
// about any week while old callers/tests keep working unchanged.
const WEEK_START_SQL = `COALESCE($1::date, date_trunc('week', now())::date)`;

router.get('/', async (req, res, next) => {
  try {
    const weekStart = req.query.week_start;
    if (weekStart !== undefined && !WEEK_RE.test(weekStart)) {
      return res.status(400).json({ error: 'week_start must be YYYY-MM-DD' });
    }
    const result = await pool.query(
      `SELECT * FROM weekly_shoot_plan_confirmations WHERE week_start = ${WEEK_START_SQL}`,
      [weekStart || null]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    next(err);
  }
});

// What "Confirm & Send Shoot Plan" will do for this week (read-only): the products and concepts handed over, anything worth knowing first, and what it does NOT do.
router.get('/preview', async (req, res, next) => {
  try {
    const weekStart = req.query.week_start;
    if (weekStart !== undefined && !WEEK_RE.test(weekStart)) return res.status(400).json({ error: 'week_start must be YYYY-MM-DD' });
    const week = (await pool.query(`SELECT ${WEEK_START_SQL} AS w`, [weekStart || null])).rows[0].w;
    res.json(await confirmationPreview(pool, week));
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const weekStart = req.body && req.body.week_start;
    if (weekStart !== undefined && weekStart !== null && !WEEK_RE.test(weekStart)) {
      return res.status(400).json({ error: 'week_start must be YYYY-MM-DD' });
    }
    // Nothing to send: refuse rather than record an empty hand-off (Drop assignments that Shooting links automatically are not Planning selections).
    const explicit = await pool.query(
      `SELECT count(*)::int AS n FROM shoot_plan_items spi WHERE spi.week_start = ${WEEK_START_SQL} AND NOT ${autoLinkedSql('spi')}`, [weekStart || null]);
    if (!explicit.rows[0].n) return res.status(400).json({ error: 'Add at least one product to the Shoot Plan before confirming it.' });
    // ON CONFLICT DO NOTHING so a second confirm click never bumps
    // confirmed_at/confirmed_by -- the row should record the FIRST
    // confirmation. The primary key on week_start makes this race-safe if
    // two people click at once: whichever insert loses just falls through
    // to DO NOTHING.
    const inserted = await pool.query(
      `INSERT INTO weekly_shoot_plan_confirmations (week_start, confirmed_by_user_id) VALUES (${WEEK_START_SQL}, $2)
       ON CONFLICT (week_start) DO NOTHING RETURNING *`,
      [weekStart || null, req.user.id]
    );
    if (inserted.rows.length) return res.status(201).json(inserted.rows[0]);

    const existing = await pool.query(
      `SELECT * FROM weekly_shoot_plan_confirmations WHERE week_start = ${WEEK_START_SQL}`,
      [weekStart || null]
    );
    res.json(existing.rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
