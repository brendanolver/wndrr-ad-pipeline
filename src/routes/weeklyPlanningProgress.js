const express = require('express');
const { pool } = require('../db');

const router = express.Router();
const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

// The Monday Planning Checklist's first four items -- manually ticked, not
// auto-set by visiting a tab. The 5th item ("Shoot Plan confirmed") is
// derived client-side from weekly_shoot_plan_confirmations instead of
// living here, so there's one source of truth for it.
const FIELDS = ['core_reviewed', 'high_stock_reviewed', 'drops_reviewed', 'promotions_reviewed'];

router.get('/', async (req, res, next) => {
  try {
    const weekStart = req.query.week_start;
    if (weekStart !== undefined && !WEEK_RE.test(weekStart)) {
      return res.status(400).json({ error: 'week_start must be YYYY-MM-DD' });
    }
    const result = await pool.query(
      `SELECT * FROM weekly_planning_progress WHERE week_start = COALESCE($1::date, date_trunc('week', now())::date)`,
      [weekStart || null]
    );
    res.json(result.rows[0] || { week_start: weekStart || null, core_reviewed: false, high_stock_reviewed: false, drops_reviewed: false, promotions_reviewed: false });
  } catch (err) {
    next(err);
  }
});

router.put('/', async (req, res, next) => {
  try {
    const { week_start, field, value } = req.body || {};
    if (!week_start || !WEEK_RE.test(week_start)) {
      return res.status(400).json({ error: 'week_start (YYYY-MM-DD) is required' });
    }
    if (!FIELDS.includes(field)) {
      return res.status(400).json({ error: `field must be one of ${FIELDS.join(', ')}` });
    }
    if (typeof value !== 'boolean') {
      return res.status(400).json({ error: 'value must be a boolean' });
    }
    // field is validated against the FIELDS whitelist above before it ever
    // touches the query string, so this interpolation can't carry
    // attacker-controlled SQL.
    const result = await pool.query(
      `INSERT INTO weekly_planning_progress (week_start, ${field}) VALUES ($1, $2)
       ON CONFLICT (week_start) DO UPDATE SET ${field} = $2, updated_at = now()
       RETURNING *`,
      [week_start, value]
    );
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
