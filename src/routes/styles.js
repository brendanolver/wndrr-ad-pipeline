const express = require('express');
const { pool } = require('../db');
const { TIERS } = require('../lib/statuses');

const router = express.Router();

const LIST_QUERY = `
  SELECT
    s.*,
    c.name AS category_name,
    EXISTS(
      SELECT 1 FROM creative_assets ca
      WHERE ca.style_id = s.id AND ca.status = 'uploaded_live'
    ) AS has_live_asset,
    EXISTS(
      SELECT 1 FROM creative_assets ca
      WHERE ca.style_id = s.id AND ca.status = 'awaiting_proven_concept'
    ) AS has_awaiting_hold,
    (SELECT COUNT(*) FROM creative_assets ca WHERE ca.style_id = s.id)::int AS creative_asset_count
  FROM styles s
  LEFT JOIN categories c ON c.id = s.category_id
`;

function withMissingAdFlag(row) {
  // Missing-ad flag: zero Live creative assets AND not deliberately parked
  // Awaiting Proven Concept. A New Drop holding for a tested concept is a
  // different, non-alarming state from a style nobody's touched.
  const missing_ad = !row.has_live_asset && !row.has_awaiting_hold;
  return { ...row, missing_ad };
}

router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(`${LIST_QUERY} ORDER BY s.style_code ASC`);
    res.json(result.rows.map(withMissingAdFlag));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(`${LIST_QUERY} WHERE s.id = $1`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Style not found' });
    res.json(withMissingAdFlag(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { style_code, name, tier, category_id } = req.body || {};
    if (!style_code || !style_code.trim()) return res.status(400).json({ error: 'style_code is required' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!TIERS.includes(tier)) return res.status(400).json({ error: `tier must be one of: ${TIERS.join(', ')}` });

    const result = await pool.query(
      `INSERT INTO styles (style_code, name, tier, category_id) VALUES ($1, $2, $3, $4) RETURNING *`,
      [style_code.trim(), name.trim(), tier, category_id || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A style with that style_code already exists' });
    }
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { style_code, name, tier, category_id } = req.body || {};
    if (tier && !TIERS.includes(tier)) {
      return res.status(400).json({ error: `tier must be one of: ${TIERS.join(', ')}` });
    }

    const result = await pool.query(
      `UPDATE styles
       SET style_code = COALESCE($1, style_code),
           name = COALESCE($2, name),
           tier = COALESCE($3, tier),
           category_id = $4,
           updated_at = now()
       WHERE id = $5 RETURNING *`,
      [style_code ? style_code.trim() : null, name ? name.trim() : null, tier || null, category_id || null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Style not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A style with that style_code already exists' });
    }
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM styles WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Style not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
