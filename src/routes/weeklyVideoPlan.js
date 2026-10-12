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

let memo = null; // one short cache so the Planning tabs that all ask for it do not each recompute it
const MEMO_MS = 20 * 1000;
const invalidate = () => { memo = null; };

router.get('/', async (req, res, next) => {
  try {
    const weekStart = req.query.week_start;
    if (weekStart !== undefined && !WEEK_RE.test(weekStart)) return res.status(400).json({ error: 'week_start must be YYYY-MM-DD' });
    const key = weekStart || 'current';
    if (!req.query.fresh && memo && memo.key === key && Date.now() - memo.at < MEMO_MS) return res.json(memo.value);
    const value = await loader.computeWeeklyVideoPlan({ weekStart });
    memo = { key, at: Date.now(), value };
    res.json(value);
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
