const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Same "rewrite every rank on any reorder" pattern as proven_winners/
// creative_resources -- see provenWinners.js's rewriteRanks for the reasoning.
async function rewriteSortOrders(client, orderedIds) {
  for (let i = 0; i < orderedIds.length; i += 1) {
    await client.query('UPDATE customer_avatars SET sort_order = $1, updated_at = now() WHERE id = $2', [i, orderedIds[i]]);
  }
}

router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM customer_avatars ORDER BY sort_order ASC');
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { name, who_they_are, what_they_care_about, what_stops_buying, what_resonates } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    await client.query('BEGIN');
    const maxOrder = await client.query('SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM customer_avatars');
    const inserted = await client.query(
      `INSERT INTO customer_avatars (name, who_they_are, what_they_care_about, what_stops_buying, what_resonates, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        name.trim(),
        who_they_are && who_they_are.trim() ? who_they_are.trim() : null,
        what_they_care_about && what_they_care_about.trim() ? what_they_care_about.trim() : null,
        what_stops_buying && what_stops_buying.trim() ? what_stops_buying.trim() : null,
        what_resonates && what_resonates.trim() ? what_resonates.trim() : null,
        maxOrder.rows[0].max_order + 1,
      ]
    );
    await client.query('COMMIT');
    res.status(201).json(inserted.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'A Customer Avatar with that name already exists' });
    next(err);
  } finally {
    client.release();
  }
});

// Registered before PUT /:id so "/reorder" isn't shadowed as an :id param.
router.put('/reorder', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { ordered_ids } = req.body || {};
    if (!Array.isArray(ordered_ids) || !ordered_ids.length) {
      return res.status(400).json({ error: 'ordered_ids is required' });
    }

    const current = await pool.query('SELECT id FROM customer_avatars');
    const currentSet = new Set(current.rows.map((r) => r.id));
    const requestedSet = new Set(ordered_ids.map(Number));
    const sameMembers = currentSet.size === requestedSet.size && [...currentSet].every((id) => requestedSet.has(id));
    if (!sameMembers) {
      return res.status(400).json({ error: 'ordered_ids must contain exactly the current set of avatar ids' });
    }

    await client.query('BEGIN');
    await rewriteSortOrders(client, ordered_ids.map(Number));
    await client.query('COMMIT');

    const result = await pool.query('SELECT * FROM customer_avatars ORDER BY sort_order ASC');
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
    const { name, who_they_are, what_they_care_about, what_stops_buying, what_resonates, enabled } = req.body || {};
    if (name != null && !name.trim()) return res.status(400).json({ error: 'name cannot be blank' });

    const result = await pool.query(
      `UPDATE customer_avatars SET
         name = COALESCE($1, name),
         who_they_are = $2,
         what_they_care_about = $3,
         what_stops_buying = $4,
         what_resonates = $5,
         enabled = COALESCE($6, enabled),
         updated_at = now()
       WHERE id = $7 RETURNING *`,
      [
        name ? name.trim() : null,
        who_they_are && who_they_are.trim() ? who_they_are.trim() : null,
        what_they_care_about && what_they_care_about.trim() ? what_they_care_about.trim() : null,
        what_stops_buying && what_stops_buying.trim() ? what_stops_buying.trim() : null,
        what_resonates && what_resonates.trim() ? what_resonates.trim() : null,
        typeof enabled === 'boolean' ? enabled : null,
        req.params.id,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Customer Avatar not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A Customer Avatar with that name already exists' });
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deleted = await client.query('DELETE FROM customer_avatars WHERE id = $1 RETURNING id', [req.params.id]);
    if (deleted.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Customer Avatar not found' });
    }
    const remaining = await client.query('SELECT id FROM customer_avatars ORDER BY sort_order ASC');
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
