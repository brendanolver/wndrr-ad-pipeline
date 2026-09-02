const express = require('express');
const { pool } = require('../db');
const apparelmagic = require('../lib/apparelmagic');

const router = express.Router();

const IDEA_TYPES = ['bau', 'sale'];

const LIST_QUERY = `SELECT rl.* FROM reference_library rl`;

// Categories offered on the Add/Edit Reference form -- the live AM category
// list (e.g. "BOX FIT TEES", "HEAVY WEIGHT TEES"), the same one Core Shoot
// Planning/High Stocks group products by, not the app's own `categories`
// table (that's a separate Meta campaign/ad-set mapping used by Styles
// admin). No DB round trip: same AD_EXCLUDED_CATEGORY convention as Core
// (the team doesn't run ads for Accessories).
router.get('/categories', async (req, res, next) => {
  try {
    if (!apparelmagic.configured()) return res.json([]);
    const amDetails = await apparelmagic.getStyleCatalogue();
    const categories = new Set();
    for (const details of amDetails.values()) {
      if (!details.category || apparelmagic.isAdExcludedCategory(details)) continue;
      categories.add(details.category);
    }
    res.json([...categories].sort());
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { idea_type, q } = req.query;
    const clauses = [];
    const params = [];

    if (idea_type) {
      if (!IDEA_TYPES.includes(idea_type)) return res.status(400).json({ error: 'idea_type must be bau or sale' });
      params.push(idea_type);
      clauses.push(`rl.idea_type = $${params.length}`);
    }

    if (q && q.trim()) {
      params.push(`%${q.trim().toLowerCase()}%`);
      clauses.push(`(LOWER(rl.comment) LIKE $${params.length} OR LOWER(rl.category) LIKE $${params.length})`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await pool.query(`${LIST_QUERY} ${where} ORDER BY rl.created_at DESC`, params);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { link, comment, idea_type, category } = req.body || {};
    if (!link || !link.trim()) return res.status(400).json({ error: 'link is required' });
    if (!comment || !comment.trim()) return res.status(400).json({ error: 'comment is required' });
    if (!IDEA_TYPES.includes(idea_type)) return res.status(400).json({ error: 'idea_type must be bau or sale' });

    // Added-by is always the logged-in user now -- never taken from the
    // client (see the brief: "never manually entered"). This also retires
    // the old client-side one-time "who am I" localStorage prompt, which is
    // genuinely redundant once every request already carries a real
    // identity via requireAuth.
    const inserted = await pool.query(
      `INSERT INTO reference_library (link, comment, idea_type, category, added_by, added_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [link.trim(), comment.trim(), idea_type, category && category.trim() ? category.trim() : null, req.user.name, req.user.id]
    );
    const result = await pool.query(`${LIST_QUERY} WHERE rl.id = $1`, [inserted.rows[0].id]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { link, comment, idea_type, category, added_by } = req.body || {};
    if (link != null && !link.trim()) return res.status(400).json({ error: 'link cannot be blank' });
    if (comment != null && !comment.trim()) return res.status(400).json({ error: 'comment cannot be blank' });
    if (idea_type != null && !IDEA_TYPES.includes(idea_type)) return res.status(400).json({ error: 'idea_type must be bau or sale' });
    if (added_by != null && !added_by.trim()) return res.status(400).json({ error: 'added_by cannot be blank' });

    const updated = await pool.query(
      `UPDATE reference_library SET
         link = COALESCE($1, link),
         comment = COALESCE($2, comment),
         idea_type = COALESCE($3, idea_type),
         category = $4,
         added_by = COALESCE($5, added_by),
         updated_at = now()
       WHERE id = $6 RETURNING id`,
      [
        link ? link.trim() : null,
        comment ? comment.trim() : null,
        idea_type || null,
        category && category.trim() ? category.trim() : null,
        added_by ? added_by.trim() : null,
        req.params.id,
      ]
    );
    if (updated.rows.length === 0) return res.status(404).json({ error: 'Reference not found' });
    const result = await pool.query(`${LIST_QUERY} WHERE rl.id = $1`, [req.params.id]);
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await pool.query('DELETE FROM reference_library WHERE id = $1 RETURNING id', [req.params.id]);
    if (deleted.rows.length === 0) return res.status(404).json({ error: 'Reference not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
