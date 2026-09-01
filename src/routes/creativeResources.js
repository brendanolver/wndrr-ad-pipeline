const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Same "rewrite every rank on any reorder" pattern as proven_winners --
// see provenWinners.js's rewriteRanks for the reasoning.
async function rewriteSortOrders(client, orderedIds) {
  for (let i = 0; i < orderedIds.length; i += 1) {
    await client.query('UPDATE creative_resources SET sort_order = $1, updated_at = now() WHERE id = $2', [i, orderedIds[i]]);
  }
}

router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM creative_resources ORDER BY sort_order ASC');
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { name, description, url, resource_type, cta_label } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!url || !url.trim()) return res.status(400).json({ error: 'url is required' });

    await client.query('BEGIN');
    const maxOrder = await client.query('SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM creative_resources');
    const inserted = await client.query(
      `INSERT INTO creative_resources (name, description, url, resource_type, cta_label, sort_order)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'Open ↗'), $6) RETURNING *`,
      [
        name.trim(),
        description && description.trim() ? description.trim() : null,
        url.trim(),
        resource_type && resource_type.trim() ? resource_type.trim() : null,
        cta_label && cta_label.trim() ? cta_label.trim() : null,
        maxOrder.rows[0].max_order + 1,
      ]
    );
    await client.query('COMMIT');
    res.status(201).json(inserted.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'A resource with that name already exists' });
    next(err);
  } finally {
    client.release();
  }
});

// Registered before PUT /:id so "/reorder" isn't shadowed as an :id param
// (same convention proven_winners.js's PUT /reorder follows).
router.put('/reorder', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { ordered_ids } = req.body || {};
    if (!Array.isArray(ordered_ids) || !ordered_ids.length) {
      return res.status(400).json({ error: 'ordered_ids is required' });
    }

    const current = await pool.query('SELECT id FROM creative_resources');
    const currentSet = new Set(current.rows.map((r) => r.id));
    const requestedSet = new Set(ordered_ids.map(Number));
    const sameMembers = currentSet.size === requestedSet.size && [...currentSet].every((id) => requestedSet.has(id));
    if (!sameMembers) {
      return res.status(400).json({ error: 'ordered_ids must contain exactly the current set of resource ids' });
    }

    await client.query('BEGIN');
    await rewriteSortOrders(client, ordered_ids.map(Number));
    await client.query('COMMIT');

    const result = await pool.query('SELECT * FROM creative_resources ORDER BY sort_order ASC');
    res.json(result.rows);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { name, description, url, resource_type, cta_label, enabled } = req.body || {};
    if (name != null && !name.trim()) return res.status(400).json({ error: 'name cannot be blank' });
    if (url != null && !url.trim()) return res.status(400).json({ error: 'url cannot be blank' });

    const result = await pool.query(
      `UPDATE creative_resources SET
         name = COALESCE($1, name),
         description = $2,
         url = COALESCE($3, url),
         resource_type = $4,
         cta_label = COALESCE($5, cta_label),
         enabled = COALESCE($6, enabled),
         updated_at = now()
       WHERE id = $7 RETURNING *`,
      [
        name ? name.trim() : null,
        description && description.trim() ? description.trim() : null,
        url ? url.trim() : null,
        resource_type && resource_type.trim() ? resource_type.trim() : null,
        cta_label && cta_label.trim() ? cta_label.trim() : null,
        typeof enabled === 'boolean' ? enabled : null,
        req.params.id,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Resource not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A resource with that name already exists' });
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deleted = await client.query('DELETE FROM creative_resources WHERE id = $1 RETURNING id', [req.params.id]);
    if (deleted.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Resource not found' });
    }
    const remaining = await client.query('SELECT id FROM creative_resources ORDER BY sort_order ASC');
    await rewriteSortOrders(client, remaining.rows.map((r) => r.id));
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
