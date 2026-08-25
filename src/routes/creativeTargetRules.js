const express = require('express');
const { pool } = require('../db');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM creative_target_rules ORDER BY soh_min ASC');
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { soh_min, soh_max, required_creatives } = req.body || {};
    if (soh_min == null || required_creatives == null) {
      return res.status(400).json({ error: 'soh_min and required_creatives are required' });
    }
    const result = await pool.query(
      `INSERT INTO creative_target_rules (soh_min, soh_max, required_creatives) VALUES ($1, $2, $3) RETURNING *`,
      [soh_min, soh_max ?? null, required_creatives]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A rule with that soh_min already exists' });
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { soh_min, soh_max, required_creatives } = req.body || {};
    const result = await pool.query(
      `UPDATE creative_target_rules SET soh_min = COALESCE($1, soh_min), soh_max = $2,
         required_creatives = COALESCE($3, required_creatives) WHERE id = $4 RETURNING *`,
      [soh_min ?? null, soh_max ?? null, required_creatives ?? null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Rule not found' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM creative_target_rules WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Rule not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
