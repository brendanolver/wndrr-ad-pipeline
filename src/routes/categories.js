const express = require('express');
const { pool } = require('../db');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM categories ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, meta_campaign_id, meta_ad_set_id, notes } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const result = await pool.query(
      `INSERT INTO categories (name, meta_campaign_id, meta_ad_set_id, notes)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name.trim(), meta_campaign_id || null, meta_ad_set_id || null, notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A category with that name already exists' });
    }
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { name, meta_campaign_id, meta_ad_set_id, notes } = req.body || {};
    const result = await pool.query(
      `UPDATE categories
       SET name = COALESCE($1, name),
           meta_campaign_id = $2,
           meta_ad_set_id = $3,
           notes = $4,
           updated_at = now()
       WHERE id = $5 RETURNING *`,
      [name ? name.trim() : null, meta_campaign_id || null, meta_ad_set_id || null, notes || null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Category not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A category with that name already exists' });
    }
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM categories WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Category not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
