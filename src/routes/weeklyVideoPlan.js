// Weekly VIDEO plan: GET the ranked recommendations + the week's production totals, read and edit the recommendation tuning, and manage launch-status overrides.
// Read-only apart from the settings / override tables it owns; it never creates production records (the Shoot Plan does that, on a person's explicit action).
const express = require('express');
const { pool } = require('../db');
const loader = require('../lib/weeklyVideoPlanLoader');
const cfgLib = require('../lib/creativePlanningConfig');
const planningContext = require('../lib/planningContext');

const router = express.Router();
const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^[A-Z0-9]{3,32}$/;

const invalidate = () => loader.invalidate();

router.get('/', async (req, res, next) => {
  try {
    const weekStart = req.query.week_start;
    if (weekStart !== undefined && !WEEK_RE.test(weekStart)) return res.status(400).json({ error: 'week_start must be YYYY-MM-DD' });
    res.json(await loader.getWeeklyPlan(weekStart, { fresh: !!req.query.fresh }));
  } catch (err) { next(err); }
});

// A recommendation becomes a Shoot Plan entry only when a person chooses it. The Shoot Plan stores colourways by local style id, and a product the
// pipeline has never worked with has no local row yet, so this creates the missing local `styles` rows (idempotent, local database only, never AM or
// Shopify) for the colourways of ONE product the person is about to plan, and returns what the Shoot Plan modal needs. It creates no production record.
router.post('/prepare-shoot', async (req, res, next) => {
  try {
    const key = String((req.body && req.body.key) || '').trim();
    if (!key) return res.status(400).json({ error: 'key is required' });
    const deps = req.app && req.app.locals && req.app.locals.weeklyPlanDeps ? req.app.locals.weeklyPlanDeps : {};
    const plan = await loader.getWeeklyPlan(req.body.week_start, { fresh: false, deps });
    if (!plan.available) return res.status(409).json({ error: plan.reason || 'The weekly plan is not available' });
    const prod = (plan.products || []).find((p) => p.key === key);
    if (!prod) {
      const ex = (plan.excluded || []).find((p) => p.key === key);
      return res.status(ex ? 409 : 404).json({ error: ex ? `${ex.name} has not launched, so it cannot be planned for a shoot.` : 'Product not found in the weekly plan' });
    }
    const am = deps.am || await require('../lib/planningData').fetchAmData();
    const apparelmagic = require('../lib/apparelmagic');
    const usable = (prod.colourways || []).filter((c) => c.launch_status !== 'unlaunched' && c.launch_status !== 'discontinued');
    if (!usable.length) return res.status(409).json({ error: 'No launched colourways to plan' });
    for (const c of usable) {
      const d = am.amDetails && am.amDetails.get(c.style_code);
      await pool.query("INSERT INTO styles (style_code, name, tier) VALUES ($1, $2, 'new_drop') ON CONFLICT (style_code) DO NOTHING", [c.style_code, (d && d.productName) || prod.name || c.style_code]);
    }
    const rows = await pool.query('SELECT id, style_code FROM styles WHERE style_code = ANY($1::text[])', [usable.map((c) => c.style_code)]);
    const idBy = new Map(rows.rows.map((r) => [r.style_code, r.id]));
    const colours = usable.filter((c) => idBy.has(c.style_code)).map((c) => {
      const sizing = apparelmagic.resolveStyleSizing(am.amDetails, am.amSizeRanges, c.style_code);
      return { style_id: idBy.get(c.style_code), style_code: c.style_code, colour_label: c.colour_label, image_url: c.image_url, soh: c.soh, sizes: sizing.sizes, sizing_system: sizing.system };
    });
    res.json({
      key: prod.key, product_code: (prod.codes && prod.codes[0]) || null, product_name: prod.name, category: prod.category_name || null, colours,
      recommended_videos: prod.recommended_videos, net_recommended: prod.net_recommended, remaining: prod.remaining, category_label: prod.category_label,
      mix: prod.mix || null, headline: prod.headline, snapshot: { week_start: plan.week_start, category: prod.category, score: prod.score, recommended_videos: prod.recommended_videos, net_recommended: prod.net_recommended, reasons: (prod.reasons || []).slice(0, 8).map((r) => r.text), taken_at: new Date().toISOString() },
    });
  } catch (err) { next(err); }
});

// the tuning, grouped, with defaults and allowed ranges, for Settings
router.get('/config', async (req, res, next) => {
  try {
    const settings = await planningContext.loadSettings(pool);
    const { config, issues } = cfgLib.resolve(settings.creative_planning_config || {});
    res.json({ groups: cfgLib.describe(config), stored: settings.creative_planning_config || {}, issues, weekly_video_target: settings.weekly_video_target, season_immediate_days: settings.season_immediate_days, season_secondary_days: settings.season_secondary_days, min_active_ads: settings.min_active_ads });
  } catch (err) { next(err); }
});

// save the tuning: only known keys, only in range; a value equal to its default is not stored (so a future default change still applies); { reset: true } clears it all
router.put('/config', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.reset === true) {
      await pool.query("UPDATE planning_settings SET creative_planning_config = '{}'::jsonb, updated_at = now(), updated_by_user_id = $1 WHERE id = 1", [req.user && req.user.id]);
      invalidate();
      return res.json({ stored: {}, reset: true });
    }
    const incoming = body.config;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return res.status(400).json({ error: 'config must be an object of setting values' });
    const unknown = Object.keys(incoming).filter((k) => !(k in cfgLib.DEFAULTS));
    if (unknown.length) return res.status(400).json({ error: `Unknown setting: ${unknown.join(', ')}` });
    const current = (await planningContext.loadSettings(pool)).creative_planning_config || {};
    const merged = { ...current, ...incoming };
    const { config, issues } = cfgLib.resolve(merged);
    // any rejected value is an error (never silently ignored on save)
    const own = issues.filter((i) => Object.keys(incoming).some((k) => i.startsWith(k)));
    if (own.length) return res.status(400).json({ error: own.join('; ') });
    const store = {};
    Object.keys(merged).forEach((k) => { if (k in cfgLib.DEFAULTS && Number(merged[k]) !== cfgLib.DEFAULTS[k]) store[k] = Number(merged[k]); });
    // the ordering rules (thresholds, percentiles) are checked on the merged result
    const check = cfgLib.resolve(store);
    if (check.issues.length) return res.status(400).json({ error: check.issues.join('; ') });
    await pool.query('UPDATE planning_settings SET creative_planning_config = $1::jsonb, updated_at = now(), updated_by_user_id = $2 WHERE id = 1', [JSON.stringify(store), req.user && req.user.id]);
    invalidate();
    res.json({ stored: store, config: check.config });
  } catch (err) { next(err); }
});

// ---- launch-status overrides (a person's call when ApparelMagic and Upcoming Drops cannot tell) ----
router.get('/launch-overrides', async (req, res, next) => {
  try {
    const r = await pool.query(`SELECT o.id, o.product_code, o.status, o.note, o.created_at, u.name AS created_by FROM product_launch_overrides o LEFT JOIN users u ON u.id = o.created_by_user_id WHERE o.removed_at IS NULL ORDER BY o.id DESC`);
    res.json({ overrides: r.rows });
  } catch (err) { next(err); }
});
router.post('/launch-overrides', async (req, res, next) => {
  try {
    const b = req.body || {};
    const code = String(b.product_code || '').trim().toUpperCase();
    if (!CODE_RE.test(code)) return res.status(400).json({ error: 'Choose a product' });
    if (!['launched', 'unlaunched', 'discontinued'].includes(b.status)) return res.status(400).json({ error: 'status must be launched, unlaunched or discontinued' });
    const note = b.note === undefined || b.note === null ? null : String(b.note).trim().slice(0, 300) || null;
    // one active override per product: setting a new one retires the old (kept for history)
    await pool.query('UPDATE product_launch_overrides SET removed_at = now(), removed_by_user_id = $2 WHERE product_code = $1 AND removed_at IS NULL', [code, req.user && req.user.id]);
    const r = await pool.query('INSERT INTO product_launch_overrides (product_code, status, note, created_by_user_id) VALUES ($1, $2, $3, $4) RETURNING id, product_code, status, note, created_at', [code, b.status, note, req.user && req.user.id]);
    invalidate();
    res.status(201).json(r.rows[0]);
  } catch (err) { next(err); }
});
router.delete('/launch-overrides/:id', async (req, res, next) => {
  try {
    if (!/^\d{1,9}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const r = await pool.query('UPDATE product_launch_overrides SET removed_at = now(), removed_by_user_id = $2 WHERE id = $1 AND removed_at IS NULL RETURNING id', [Number(req.params.id), req.user && req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Override not found' });
    invalidate();
    res.json({ id: r.rows[0].id, removed: true });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.invalidate = invalidate;
