// Core creative plan: "For our CORE products, what creative should we make next, and why?"
// Open to Planning users. Money (spend / purchases / CPA) is stripped on the SERVER for
// non-admins (see sanitizeForUser) -- they still get the recommendations and a qualitative Meta
// label. Reads the local DB + the cached ApparelMagic data; it never calls Meta.
const express = require('express');
const { pool } = require('../db');
const apparelmagic = require('../lib/apparelmagic');
const plan = require('../lib/coreCreativePlan');
const { HttpError } = require('../lib/metaPerformance');
const { syncCoreStylesFromAm } = require('./coreProducts');

const router = express.Router();

function handle(fn) {
  return async (req, res, next) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      if (err instanceof HttpError || (err && err.status && err.status < 500)) return res.status(err.status).json({ error: err.message });
      return next(err);
    }
  };
}

// GET /api/core-creative-plan
router.get('/', handle((req) => plan.computePlan({ isAdmin: !!(req.user && req.user.role === 'admin') })));

// Dismiss / mark acted-on / reopen one card.
// POST /api/core-creative-plan/state { key, state: 'dismissed'|'acted_on'|'open', note?, card?: { priority, severity, headline, why } }
router.post('/state', handle((req) => {
  const b = req.body || {};
  const card = b.card && typeof b.card === 'object'
    ? { priority: String(b.card.priority || '').slice(0, 10), severity: parseInt(b.card.severity, 10) || 0, headline: String(b.card.headline || '').slice(0, 200), why: String(b.card.why || '').slice(0, 600) }
    : null;
  return plan.setState({ key: b.key, state: b.state, note: b.note, userId: req.user && req.user.id, card });
}));

// The preset the EXISTING "Shoot This Week" modal needs for a CORE product (colourways, sizes,
// images). Nothing is created here: the person reviews the modal and confirms themselves.
// GET /api/core-creative-plan/shoot-preset?product_code=
router.get('/shoot-preset', handle(async (req) => {
  const code = String(req.query.product_code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,32}$/.test(code)) throw new HttpError(400, 'Invalid product code');
  if (!apparelmagic.configured() || !apparelmagic.getAmCacheStatus().catalogue.hasData) throw new HttpError(409, 'The ApparelMagic catalogue is not loaded yet.');
  const [amDetails, sizeRanges] = await Promise.all([apparelmagic.getStyleCatalogue(), apparelmagic.getSizeRanges().catch(() => null)]);
  const { families, codeToFamily } = plan.buildCoreFamilies(amDetails);
  const family = codeToFamily.get(code) || families.find((f) => f.key === code);
  if (!family) throw new HttpError(404, 'That is not a CORE product');
  await syncCoreStylesFromAm(amDetails); // idempotent: makes sure every CORE colourway has a local style row
  const styles = await pool.query('SELECT id, style_code, name FROM styles ORDER BY style_code ASC');
  const members = styles.rows.filter((s) => family.core_codes.includes(apparelmagic.deriveProductCode(s.style_code)));
  if (!members.length) throw new HttpError(404, 'No styles found for that product');
  return {
    productCode: family.product_code,
    productName: family.name,
    category: family.category,
    source: 'manual',
    colours: members.map((s) => {
      const details = amDetails.get(s.style_code);
      const sizing = apparelmagic.resolveStyleSizing(amDetails, sizeRanges, s.style_code);
      return {
        style_id: s.id, style_code: s.style_code, image_url: (details && details.imageUrl) || null,
        colour_label: apparelmagic.resolveColourLabel(amDetails, s.style_code), sizes: sizing.sizes, sizing_system: sizing.system,
      };
    }),
  };
}));

module.exports = router;
