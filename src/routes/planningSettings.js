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

router.put('/', async (req, res, next) => {
  try {
    const target = Number.parseInt(req.body?.weekly_new_concept_target, 10);
    if (!Number.isInteger(target) || target < 0) {
      return res.status(400).json({ error: 'weekly_new_concept_target must be a non-negative integer' });
    }
    const result = await pool.query(
      'UPDATE planning_settings SET weekly_new_concept_target = $1, updated_at = now() WHERE id = 1 RETURNING *',
      [target]
    );
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
