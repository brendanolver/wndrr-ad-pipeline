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
    if (body.min_active_ads_per_product !== undefined) {
      const v = Number.parseInt(body.min_active_ads_per_product, 10);
      if (!Number.isInteger(v) || v < 1 || v > 100) {
        return res.status(400).json({ error: 'min_active_ads_per_product must be a whole number from 1 to 100' });
      }
      updates.min_active_ads_per_product = v;
    }
    if (body.weekly_video_target !== undefined) {
      const v = Number.parseInt(body.weekly_video_target, 10);
      if (!Number.isInteger(v) || v < 20 || v > 30) return res.status(400).json({ error: 'weekly_video_target must be a whole number from 20 to 30' });
      updates.weekly_video_target = v;
    }
    if (body.season_immediate_days !== undefined || body.season_secondary_days !== undefined) {
      const cur = (await pool.query('SELECT season_immediate_days, season_secondary_days FROM planning_settings WHERE id = 1')).rows[0] || { season_immediate_days: 7, season_secondary_days: 14 };
      const imm = body.season_immediate_days !== undefined ? Number.parseInt(body.season_immediate_days, 10) : cur.season_immediate_days;
      const sec = body.season_secondary_days !== undefined ? Number.parseInt(body.season_secondary_days, 10) : cur.season_secondary_days;
      if (!Number.isInteger(imm) || imm < 1 || imm > 28) return res.status(400).json({ error: 'season_immediate_days must be a whole number from 1 to 28' });
      if (!Number.isInteger(sec) || sec < 2 || sec > 56) return res.status(400).json({ error: 'season_secondary_days must be a whole number from 2 to 56' });
      if (sec <= imm) return res.status(400).json({ error: 'The secondary lookahead must be longer than the immediate lookahead' });
      if (body.season_immediate_days !== undefined) updates.season_immediate_days = imm;
      if (body.season_secondary_days !== undefined) updates.season_secondary_days = sec;
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
    values.push(req.user.id);
    const result = await pool.query(
      `UPDATE planning_settings SET ${setClauses.join(', ')}, updated_at = now(), updated_by_user_id = $${values.length} WHERE id = 1 RETURNING *`,
      values
    );
    try { require('./weeklyVideoPlan').invalidate(); } catch (e) { /* cache only */ }
    try { require('../lib/planningOpportunitiesLoader').invalidate(); } catch (e) { /* cache only */ }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
