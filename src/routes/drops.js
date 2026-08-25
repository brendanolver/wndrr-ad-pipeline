const express = require('express');
const { pool } = require('../db');
const apparelmagic = require('../lib/apparelmagic');
const { buildCoverage } = require('../lib/coverage');

const router = express.Router();

async function fetchAmData() {
  if (!apparelmagic.configured()) {
    return { amStock: null, amDetails: null, amError: null, amConfigured: false };
  }
  try {
    const [amStock, amDetails] = await Promise.all([apparelmagic.getStockByStyle(), apparelmagic.getStyleDetails()]);
    return { amStock, amDetails, amError: null, amConfigured: true };
  } catch (err) {
    return { amStock: null, amDetails: null, amError: err.message, amConfigured: true };
  }
}

async function getRules() {
  const result = await pool.query('SELECT * FROM creative_target_rules ORDER BY soh_min ASC');
  return result.rows;
}

async function getAssetCounts(styleIds) {
  if (!styleIds.length) return new Map();
  const result = await pool.query(
    `SELECT style_id, COUNT(*)::int AS count FROM creative_assets WHERE style_id = ANY($1::int[]) GROUP BY style_id`,
    [styleIds]
  );
  return new Map(result.rows.map((r) => [r.style_id, r.count]));
}

function summarize(coverage) {
  const green = coverage.filter((c) => c.status === 'green').length;
  const amber = coverage.filter((c) => c.status === 'amber').length;
  const red = coverage.filter((c) => c.status === 'red').length;
  const totalCovered = coverage.reduce((sum, c) => sum + c.current_coverage, 0);
  const totalTarget = coverage.reduce((sum, c) => sum + (c.creative_target || 0), 0);
  const overallPct = totalTarget > 0 ? Math.round((totalCovered / totalTarget) * 100) : null;
  return { styleCount: coverage.length, green, amber, red, totalCovered, totalTarget, overallPct };
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
        buildCoverage(styleRows, { assetCounts, amStock: am.amStock, amDetails: am.amDetails, rules })
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
      buildCoverage(stylesResult.rows, { assetCounts, amStock: am.amStock, amDetails: am.amDetails, rules })
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
