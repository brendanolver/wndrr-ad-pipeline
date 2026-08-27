const express = require('express');
const { pool } = require('../db');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM content_creators ORDER BY is_default DESC, name ASC');
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    // First creator ever added becomes the default automatically, so the
    // list is never left without one.
    const existing = await pool.query('SELECT COUNT(*)::int AS count FROM content_creators');
    const isFirst = existing.rows[0].count === 0;

    const result = await pool.query(
      'INSERT INTO content_creators (name, is_default) VALUES ($1, $2) RETURNING *',
      [name.trim(), isFirst]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A content creator with that name already exists' });
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    const result = await pool.query(
      'UPDATE content_creators SET name = $1 WHERE id = $2 RETURNING *',
      [name.trim(), req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Content creator not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A content creator with that name already exists' });
    next(err);
  }
});

router.put('/:id/default', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await client.query('SELECT id FROM content_creators WHERE id = $1', [req.params.id]);
    if (target.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Content creator not found' });
    }
    await client.query('UPDATE content_creators SET is_default = false WHERE is_default = true');
    await client.query('UPDATE content_creators SET is_default = true WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');

    const result = await pool.query('SELECT * FROM content_creators ORDER BY is_default DESC, name ASC');
    res.json(result.rows);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deleted = await client.query('DELETE FROM content_creators WHERE id = $1 RETURNING is_default', [req.params.id]);
    if (deleted.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Content creator not found' });
    }
    // If the default was just deleted, promote another creator (if any
    // remain) so there's always exactly one default whenever the list
    // isn't empty.
    if (deleted.rows[0].is_default) {
      await client.query(
        `UPDATE content_creators SET is_default = true
         WHERE id = (SELECT id FROM content_creators ORDER BY name ASC LIMIT 1)`
      );
    }
    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
