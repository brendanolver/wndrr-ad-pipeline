const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Deliberately minimal readiness read (no ApparelMagic/SOH-driven target
// like Core/High Stocks/Drops) -- a promotion with zero checklist items
// reads as needing attention (nothing organised yet), not on track, so a
// promotion nobody has set up can't silently look fine.
function withStatus(promotion, items) {
  const itemCount = items.length;
  const readyCount = items.filter((i) => i.is_ready).length;
  const status = itemCount === 0 || readyCount < itemCount ? 'needs_attention' : 'on_track';
  return { ...promotion, items, item_count: itemCount, ready_count: readyCount, status };
}

router.get('/', async (req, res, next) => {
  try {
    const promotionsResult = await pool.query('SELECT * FROM promotions ORDER BY start_date ASC');
    const promotions = promotionsResult.rows;

    const itemsResult = promotions.length
      ? await pool.query(
          `SELECT * FROM promotion_creative_items WHERE promotion_id = ANY($1::int[]) ORDER BY created_at ASC`,
          [promotions.map((p) => p.id)]
        )
      : { rows: [] };
    const itemsByPromotion = new Map();
    for (const item of itemsResult.rows) {
      if (!itemsByPromotion.has(item.promotion_id)) itemsByPromotion.set(item.promotion_id, []);
      itemsByPromotion.get(item.promotion_id).push(item);
    }

    res.json(promotions.map((p) => withStatus(p, itemsByPromotion.get(p.id) || [])));
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, start_date, notes } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!start_date) return res.status(400).json({ error: 'start_date is required' });

    const result = await pool.query(
      'INSERT INTO promotions (name, start_date, notes) VALUES ($1, $2, $3) RETURNING *',
      [name.trim(), start_date, notes && notes.trim() ? notes.trim() : null]
    );
    res.status(201).json(withStatus(result.rows[0], []));
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { name, start_date, notes } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!start_date) return res.status(400).json({ error: 'start_date is required' });

    const result = await pool.query(
      `UPDATE promotions SET name = $1, start_date = $2, notes = $3, updated_at = now() WHERE id = $4 RETURNING *`,
      [name.trim(), start_date, notes && notes.trim() ? notes.trim() : null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Promotion not found' });

    const itemsResult = await pool.query(
      'SELECT * FROM promotion_creative_items WHERE promotion_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json(withStatus(result.rows[0], itemsResult.rows));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM promotions WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Promotion not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post('/:id/items', async (req, res, next) => {
  try {
    const { description } = req.body || {};
    if (!description || !description.trim()) return res.status(400).json({ error: 'description is required' });

    const promotion = await pool.query('SELECT id FROM promotions WHERE id = $1', [req.params.id]);
    if (!promotion.rows.length) return res.status(404).json({ error: 'Promotion not found' });

    const result = await pool.query(
      'INSERT INTO promotion_creative_items (promotion_id, description) VALUES ($1, $2) RETURNING *',
      [req.params.id, description.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/items/:itemId', async (req, res, next) => {
  try {
    const { description, is_ready } = req.body || {};
    const existing = await pool.query('SELECT * FROM promotion_creative_items WHERE id = $1', [req.params.itemId]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Promotion creative item not found' });
    const current = existing.rows[0];

    const nextDescription = description !== undefined && description.trim() ? description.trim() : current.description;
    const nextIsReady = is_ready !== undefined ? Boolean(is_ready) : current.is_ready;

    const result = await pool.query(
      'UPDATE promotion_creative_items SET description = $1, is_ready = $2 WHERE id = $3 RETURNING *',
      [nextDescription, nextIsReady, req.params.itemId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/items/:itemId', async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM promotion_creative_items WHERE id = $1 RETURNING id', [req.params.itemId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Promotion creative item not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
