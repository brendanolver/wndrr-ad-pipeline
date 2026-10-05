// Creative Opportunities V1 -- admin-only. Reads the LOCAL database only
// (no Meta function is called from here, only stored data is read); the only
// writes are a person's dismiss / acted-on decisions. See
// src/lib/creativeOpportunities.js for the rules and
// src/lib/creativeOpportunitiesConfig.js for every threshold.
const express = require('express');
const { pool } = require('../db');
const { requireAdmin } = require('../lib/permissions');
const { HttpError } = require('../lib/metaPerformance');
const opportunities = require('../lib/creativeOpportunities');
const apparelmagic = require('../lib/apparelmagic');
const { fetchAmData } = require('../lib/planningData');

const router = express.Router();
router.use(requireAdmin);

function handle(fn) {
  return async (req, res, next) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      return next(err);
    }
  };
}

// Ranked recommendations + evidence.
// GET /api/creative-opportunities?state=active|dismissed|acted_on|all
router.get('/', handle((req) => opportunities.listOpportunities({ state: req.query.state })));

// Dismiss / mark acted-on / reopen one recommendation.
// POST /api/creative-opportunities/state { key, state: 'dismissed'|'acted_on'|'open', note?, shoot_plan_item_id? }
router.post('/state', handle((req) => {
  const b = req.body || {};
  return opportunities.setState({ key: b.key, state: b.state, note: b.note, shootPlanItemId: b.shoot_plan_item_id, userId: req.user && req.user.id });
}));

// The preset the EXISTING "Shoot This Week" modal needs for a product
// (colourways, sizes, images) -- nothing is created here; the person reviews
// the modal and confirms "Add to Shoot Plan" themselves.
// GET /api/creative-opportunities/shoot-preset?product_code=
router.get('/shoot-preset', handle(async (req) => {
  const code = String(req.query.product_code || '').trim();
  if (!/^[A-Za-z0-9]{1,32}$/.test(code)) throw new HttpError(400, 'Invalid product code');
  const [styles, am] = await Promise.all([
    pool.query('SELECT id, style_code, name FROM styles ORDER BY style_code ASC'),
    fetchAmData(),
  ]);
  const members = styles.rows.filter((s) => apparelmagic.deriveProductCode(s.style_code) === code);
  if (!members.length) throw new HttpError(404, 'Unknown product');
  const first = members[0];
  const firstDetails = am.amDetails ? am.amDetails.get(first.style_code) : null;
  return {
    productCode: code,
    productName: first.name,
    category: (firstDetails && firstDetails.category) || null,
    source: 'manual',
    colours: members.map((s) => {
      const details = am.amDetails ? am.amDetails.get(s.style_code) : null;
      const sizing = apparelmagic.resolveStyleSizing(am.amDetails, am.amSizeRanges, s.style_code);
      return {
        style_id: s.id,
        style_code: s.style_code,
        image_url: (details && details.imageUrl) || null,
        colour_label: apparelmagic.resolveColourLabel(am.amDetails, s.style_code),
        sizes: sizing.sizes,
        sizing_system: sizing.system,
      };
    }),
  };
}));

module.exports = router;
