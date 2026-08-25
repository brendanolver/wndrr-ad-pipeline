const express = require('express');
const { pool } = require('../db');
const { buildCoverage } = require('../lib/coverage');
const { fetchAmData, getRules, getAssetCounts } = require('../lib/planningData');

const router = express.Router();

function summarize(coverage) {
  const green = coverage.filter((c) => c.status === 'green').length;
  const amber = coverage.filter((c) => c.status === 'amber').length;
  const red = coverage.filter((c) => c.status === 'red').length;
  const totalCovered = coverage.reduce((sum, c) => sum + c.current_coverage, 0);
  const totalTarget = coverage.reduce((sum, c) => sum + (c.creative_target || 0), 0);
  const overallPct = totalTarget > 0 ? Math.round((totalCovered / totalTarget) * 100) : null;
  const styleCount = coverage.reduce((sum, c) => sum + c.styles.length, 0);
  return { productCount: coverage.length, styleCount, green, amber, red, totalCovered, totalTarget, overallPct };
}

function sortByUrgency(coverage) {
  return [...coverage].sort((a, b) => {
    const gapDiff = (b.creative_gap ?? -1) - (a.creative_gap ?? -1);
    if (gapDiff !== 0) return gapDiff;
    return (b.soh ?? -1) - (a.soh ?? -1);
  });
}

router.get('/', async (req, res, next) => {
  try {
    const [dropsResult, stylesResult, rules, am] = await Promise.all([
      pool.query('SELECT * FROM drops ORDER BY launch_date ASC'),
      pool.query('SELECT * FROM styles WHERE drop_id IS NOT NULL'),
      getRules(),
      fetchAmData(),
    ]);

    const stylesByDrop = new Map();
    for (const style of stylesResult.rows) {
      if (!stylesByDrop.has(style.drop_id)) stylesByDrop.set(style.drop_id, []);
      stylesByDrop.get(style.drop_id).push(style);
    }

    const assetCounts = await getAssetCounts(stylesResult.rows.map((s) => s.id));

    const drops = dropsResult.rows.map((drop) => {
      const styleRows = stylesByDrop.get(drop.id) || [];
      const coverage = sortByUrgency(
        buildCoverage(styleRows, { assetCounts, amStock: am.amStock, amOnOrder: am.amOnOrder, amDetails: am.amDetails, rules })
      );
      const daysUntilLaunch = Math.ceil((new Date(drop.launch_date) - new Date()) / 86400000);
      return {
        ...drop,
        days_until_launch: daysUntilLaunch,
        summary: summarize(coverage),
        most_urgent: coverage.slice(0, 3),
      };
    });

    res.json({ drops, apparelmagic: { configured: am.amConfigured, error: am.amError } });
  } catch (err) {
    next(err);
  }
});

// Suggested drops: cluster ApparelMagic styles by shared launch date
// (mid_code), so the team doesn't have to manually notice "these 12 styles
// all land the same week" -- ApparelMagic has no drop-grouping field of its
// own, so this is inference from a shared date, not a real AM entity.
router.get('/suggestions', async (req, res, next) => {
  try {
    const days = Number.parseInt(req.query.days, 10) || 120;
    const am = await fetchAmData();
    if (!am.amConfigured) {
      return res.json({ suggestions: [], apparelmagic: { configured: false, error: null } });
    }
    if (am.amError) {
      return res.json({ suggestions: [], apparelmagic: { configured: true, error: am.amError } });
    }

    const existingResult = await pool.query('SELECT style_code, drop_id FROM styles');
    const alreadyPlanned = new Set(existingResult.rows.filter((r) => r.drop_id != null).map((r) => r.style_code));

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const horizon = new Date(today); horizon.setDate(horizon.getDate() + days);

    const groups = new Map(); // ISO date string -> styles[]
    for (const [styleCode, details] of am.amDetails.entries()) {
      if (!details.launchDate) continue;
      if (details.launchDate < today || details.launchDate > horizon) continue;
      if (alreadyPlanned.has(styleCode)) continue;

      const key = details.launchDate.toISOString().slice(0, 10);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        style_code: styleCode,
        product_name: details.productName || styleCode,
        image_url: details.imageUrl,
        is_core: details.isCore,
      });
    }

    const suggestions = [...groups.entries()]
      .map(([launch_date, styles]) => ({ launch_date, styles: styles.sort((a, b) => a.style_code.localeCompare(b.style_code)) }))
      .sort((a, b) => a.launch_date.localeCompare(b.launch_date));

    res.json({ suggestions, apparelmagic: { configured: true, error: null } });
  } catch (err) {
    next(err);
  }
});

// Create a Drop from a suggestion cluster (or any manual style list) in one
// step: creates any styles that don't exist locally yet (name + tier seeded
// from ApparelMagic's product name / CORE group), and assigns all of them to
// the new drop.
router.post('/from-suggestion', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { name, launch_date, notes, styles } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!launch_date) return res.status(400).json({ error: 'launch_date is required' });
    if (!Array.isArray(styles) || !styles.length) return res.status(400).json({ error: 'styles is required' });

    await client.query('BEGIN');
    const dropResult = await client.query(
      `INSERT INTO drops (name, launch_date, notes) VALUES ($1, $2, $3) RETURNING *`,
      [name.trim(), launch_date, notes || null]
    );
    const drop = dropResult.rows[0];

    for (const s of styles) {
      if (!s.style_code) continue;
      const existing = await client.query('SELECT id FROM styles WHERE style_code = $1', [s.style_code]);
      if (existing.rows.length) {
        await client.query('UPDATE styles SET drop_id = $1, updated_at = now() WHERE id = $2', [drop.id, existing.rows[0].id]);
      } else {
        await client.query(
          `INSERT INTO styles (style_code, name, tier, drop_id) VALUES ($1, $2, $3, $4)`,
          [s.style_code, s.product_name || s.style_code, s.is_core ? 'core_proven' : 'new_drop', drop.id]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json(drop);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, launch_date, notes } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!launch_date) return res.status(400).json({ error: 'launch_date is required' });

    const result = await pool.query(
      `INSERT INTO drops (name, launch_date, notes) VALUES ($1, $2, $3) RETURNING *`,
      [name.trim(), launch_date, notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A drop with that name already exists' });
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const dropResult = await pool.query('SELECT * FROM drops WHERE id = $1', [req.params.id]);
    if (dropResult.rows.length === 0) return res.status(404).json({ error: 'Drop not found' });
    const drop = dropResult.rows[0];

    const [stylesResult, rules, am] = await Promise.all([
      pool.query('SELECT * FROM styles WHERE drop_id = $1 ORDER BY style_code ASC', [drop.id]),
      getRules(),
      fetchAmData(),
    ]);
    const assetCounts = await getAssetCounts(stylesResult.rows.map((s) => s.id));
    const coverage = sortByUrgency(
      buildCoverage(stylesResult.rows, { assetCounts, amStock: am.amStock, amOnOrder: am.amOnOrder, amDetails: am.amDetails, rules })
    );
    const daysUntilLaunch = Math.ceil((new Date(drop.launch_date) - new Date()) / 86400000);

    res.json({
      ...drop,
      days_until_launch: daysUntilLaunch,
      summary: summarize(coverage),
      coverage,
      apparelmagic: { configured: am.amConfigured, error: am.amError },
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { name, launch_date, notes } = req.body || {};
    const result = await pool.query(
      `UPDATE drops SET name = COALESCE($1, name), launch_date = COALESCE($2, launch_date), notes = $3, updated_at = now()
       WHERE id = $4 RETURNING *`,
      [name ? name.trim() : null, launch_date || null, notes || null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Drop not found' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM drops WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Drop not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
