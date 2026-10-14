// Planning opportunities (Core + High Stocks). GET is read-only. POST /prepare-shoot only creates the local `styles` rows the Shoot Plan stores colourways by (idempotent,
// local database only, never ApparelMagic / Shopify / Meta) for ONE product a person is about to plan, and returns what the Shoot Plan modal needs. It creates no
// production record: the Shoot Plan's own Save is the explicit action.
const express = require('express');
const { pool } = require('../db');
const loader = require('../lib/planningOpportunitiesLoader');
const progressLib = require('../lib/shootPlanProgress');
const apparelmagic = require('../lib/apparelmagic');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const deps = req.app && req.app.locals && req.app.locals.opportunityDeps ? req.app.locals.opportunityDeps : undefined;
    const data = await loader.getOpportunities({ fresh: !!req.query.fresh, deps });
    if (!data.available) return res.json(data);
    // the weekly concept target and where the team is against it (so the page can show the shortfall rather than pad the list)
    const t = (await pool.query('SELECT weekly_new_concept_target AS t FROM planning_settings WHERE id = 1')).rows[0];
    const target = t && Number.isInteger(t.t) ? t.t : 15;
    const prog = await progressLib.loadWeeklyProgress(pool, data.week_start, { target });
    const qualified = data.core.actionable + data.high_stocks.actionable + (data.momentum ? data.momentum.actionable : 0);
    const stillNeeded = prog.remaining;
    res.json({
      ...data,
      concept_progress: { target, planned: prog.planned, remaining: stillNeeded, uploaded: prog.uploaded },
      shortfall: {
        target, planned: prog.planned, remaining_concepts: stillNeeded, qualified_products: qualified,
        text: stillNeeded === 0 ? `The weekly target of ${target} concepts is already planned.`
          : qualified === 0 ? `${stillNeeded} more concept${stillNeeded === 1 ? '' : 's'} needed to reach ${target}, and no product currently qualifies for new creative. The list is not padded: use Upcoming Drops, Promotions or a manual idea if more are wanted.`
            : `${stillNeeded} more concept${stillNeeded === 1 ? '' : 's'} needed to reach ${target}. ${qualified} product${qualified === 1 ? '' : 's'} currently qualify for new creative; each can support more than one genuinely different concept. If that is not enough the shortfall is real: the list is never padded.`,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/opportunities/launch-cohort?date=YYYY-MM-DD -> every product officially launched (ApparelMagic mid_code) on that date, or in the whole recent-launch window when no date is
// given, with its stock, recent sales and what Planning currently says about it.
// It writes nothing, but it is NOT free of external reads: it uses the same loader as GET /api/opportunities (getOpportunities, 5-minute memo). With a warm memo it answers from memory;
// with a cold memo, or with ?fresh=1 (which discards the memo), the loader recomputes everything, and that reads the ApparelMagic stock / catalogue / on-order / size caches and the
// sales window and the Shopify-export tiers through THEIR caches (12 h and 3 h): any cache that has expired is refetched from ApparelMagic / the pipeline, which can be slow. It never
// calls Meta (Meta data is read from this application's own database). Prefer it without ?fresh=1.
router.get('/launch-cohort', async (req, res, next) => {
  try {
    const deps = req.app && req.app.locals && req.app.locals.opportunityDeps ? req.app.locals.opportunityDeps : undefined;
    const data = await loader.getOpportunities({ fresh: !!req.query.fresh, deps });
    if (!data.available) return res.json(data);
    const date = req.query.date ? String(req.query.date) : null;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const list = (data.recent_launches || []).filter((r) => !date || r.launch_date === date);
    res.json({ available: true, date, window_days: data.config.momentum_window_days, count: list.length, products: list, note: 'Launch dates are the official ApparelMagic mid_code; sales are ApparelMagic online sales (not the Shopify first-sale date).' });
  } catch (err) { next(err); }
});

router.get('/launch-diagnostics', async (req, res, next) => {
  try {
    const deps = req.app && req.app.locals && req.app.locals.opportunityDeps ? req.app.locals.opportunityDeps : undefined;
    res.json(await loader.launchDiagnostics({ deps }));
  } catch (err) { next(err); }
});

router.post('/prepare-shoot', async (req, res, next) => {
  try {
    const key = String((req.body && req.body.key) || '').trim();
    if (!key) return res.status(400).json({ error: 'key is required' });
    const deps = req.app && req.app.locals && req.app.locals.opportunityDeps ? req.app.locals.opportunityDeps : undefined;
    const data = await loader.getOpportunities({ deps });
    if (!data.available) return res.status(409).json({ error: data.reason || 'Opportunities are not available' });
    const item = [...data.core.items, ...data.high_stocks.items, ...((data.momentum && data.momentum.items) || [])].find((i) => i.key === key);
    if (!item) return res.status(404).json({ error: 'Product not found in the opportunity lists' });
    if (['not_launched', 'launch_unknown'].includes(item.status)) return res.status(409).json({ error: `${item.name} has not launched (or its launch is not confirmed), so it cannot be planned for a shoot.` });
    const usable = (item.colourways || []).filter((c) => c.launch_status !== 'unlaunched' && c.launch_status !== 'discontinued');
    if (!usable.length) return res.status(409).json({ error: 'No launched colourways to plan' });
    const am = deps && deps.am ? deps.am : await require('../lib/planningData').fetchAmData();
    for (const c of usable) {
      const d = am.amDetails && am.amDetails.get(c.style_code);
      await pool.query("INSERT INTO styles (style_code, name, tier) VALUES ($1, $2, $3) ON CONFLICT (style_code) DO NOTHING", [c.style_code, (d && d.productName) || item.name || c.style_code, item.is_core ? 'core_proven' : 'new_drop']);
    }
    const rows = await pool.query('SELECT id, style_code FROM styles WHERE style_code = ANY($1::text[])', [usable.map((c) => c.style_code)]);
    const idBy = new Map(rows.rows.map((r) => [r.style_code, r.id]));
    const colours = usable.filter((c) => idBy.has(c.style_code)).map((c) => {
      const sizing = apparelmagic.resolveStyleSizing(am.amDetails, am.amSizeRanges, c.style_code);
      return { style_id: idBy.get(c.style_code), style_code: c.style_code, colour_label: c.colour_label, image_url: c.image_url, soh: c.soh, viable: c.viable !== false, restriction: c.restriction || null, sizes: sizing.sizes, sizing_system: sizing.system };
    });
    // what already exists for this product this week, so the modal can say so instead of creating a duplicate
    res.json({
      key: item.key, product_code: item.product_code, product_name: item.name, category: item.category || null, colours, source: item.kinds.includes('momentum') ? 'momentum' : item.kinds.includes('core') ? 'core' : 'high_stock',
      kinds: item.kinds, tags: item.tags, status: item.status, headline: item.headline,
      snapshot: { generated_at: data.generated_at, week_start: data.week_start, kinds: item.kinds, status: item.status, priority: item.priority, score: item.score, opportunity_type: item.opportunity_label || null, classification: item.classification || null, also_qualifies: item.also_qualifies || [], reason: item.reason, headline: item.headline, why: (item.why || []).map((w) => w.text), direction: item.direction ? item.direction.text : null },
      pipeline: item.pipeline,
    });
  } catch (err) { next(err); }
});

module.exports = router;
