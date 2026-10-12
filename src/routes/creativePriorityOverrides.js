// Creative Planning priority overrides: the business reasons that may lift (or hold) a product's priority whatever its season, stock or coverage --
// an upcoming drop, a confirmed restock, a major promotion, a strategic launch, a manual priority. They only change how Planning RANKS a product and
// explain why; they never create or change creative. Removing one is a soft delete (kept for history). Same access as the other Planning settings.
const express = require('express');
const { pool } = require('../db');
const cfg = require('../lib/creativePriorityConfig');
const apparelmagic = require('../lib/apparelmagic');
const planningContext = require('../lib/planningContext');

const router = express.Router();
const KINDS = Object.keys(cfg.OVERRIDE_KINDS);
const CODE_RE = /^[A-Z0-9]{3,32}$/;

const view = (r) => ({ id: r.id, product_code: r.product_code, kind: r.kind, kind_label: cfg.OVERRIDE_KINDS[r.kind] ? cfg.OVERRIDE_KINDS[r.kind].label : r.kind, note: r.note, until: r.until, created_by: r.created_by || null, created_at: r.created_at });

// GET /api/creative-priority-overrides -> active overrides (+ the available kinds)
router.get('/', async (req, res, next) => {
  try {
    const rows = await planningContext.loadOverrides();
    // names for the codes, when the catalogue is loaded (never blocks)
    let nameByCode = new Map();
    try {
      if (apparelmagic.configured() && apparelmagic.getAmCacheStatus().catalogue.hasData) {
        const fams = planningContext.buildAllFamilies(await apparelmagic.getStyleCatalogue());
        fams.forEach((f) => { nameByCode.set(f.key, f.name); f.codes.forEach((c) => nameByCode.set(c, f.name)); });
      }
    } catch (e) { nameByCode = new Map(); }
    res.json({ kinds: KINDS.map((k) => ({ key: k, label: cfg.OVERRIDE_KINDS[k].label })), overrides: rows.map((r) => ({ ...view(r), product_name: nameByCode.get(r.product_code) || null })) });
  } catch (err) { next(err); }
});

// GET /api/creative-priority-overrides/products?q= -> products to pick from (from the cached ApparelMagic catalogue)
router.get('/products', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().toUpperCase().slice(0, 60);
    if (!apparelmagic.configured() || !apparelmagic.getAmCacheStatus().catalogue.hasData) return res.json({ available: false, products: [] });
    const fams = planningContext.buildAllFamilies(await apparelmagic.getStyleCatalogue());
    res.json({ available: true, products: fams.filter((f) => !q || f.name.toUpperCase().includes(q) || f.codes.some((c) => c.includes(q))).slice(0, 20).map((f) => ({ product_code: f.key, product_name: f.name, category: f.category, is_core: f.is_core })) });
  } catch (err) { next(err); }
});

// POST /api/creative-priority-overrides { product_code, kind, note?, until_date? }
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const code = String(b.product_code || '').trim().toUpperCase();
    if (!CODE_RE.test(code)) return res.status(400).json({ error: 'Choose a product' });
    if (!KINDS.includes(b.kind)) return res.status(400).json({ error: `kind must be one of: ${KINDS.join(', ')}` });
    const note = b.note === undefined || b.note === null ? null : String(b.note).trim().slice(0, 300) || null;
    let until = null;
    if (b.until_date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.until_date))) return res.status(400).json({ error: 'until_date must be YYYY-MM-DD' });
      until = String(b.until_date);
    }
    const dup = await pool.query('SELECT id FROM creative_priority_overrides WHERE product_code = $1 AND kind = $2 AND removed_at IS NULL', [code, b.kind]);
    if (dup.rows.length) return res.status(409).json({ error: 'That product already has this override. Remove it first to change it.' });
    const r = await pool.query(
      `INSERT INTO creative_priority_overrides (product_code, kind, note, until_date, created_by_user_id) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, product_code, kind, note, to_char(until_date, 'YYYY-MM-DD') AS until, created_at`, [code, b.kind, note, until, req.user && req.user.id]);
    res.status(201).json(view(r.rows[0]));
  } catch (err) { next(err); }
});

// DELETE /api/creative-priority-overrides/:id -> soft delete
router.delete('/:id', async (req, res, next) => {
  try {
    if (!/^\d{1,9}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const r = await pool.query('UPDATE creative_priority_overrides SET removed_at = now(), removed_by_user_id = $2 WHERE id = $1 AND removed_at IS NULL RETURNING id', [Number(req.params.id), req.user && req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Override not found' });
    res.json({ id: r.rows[0].id, removed: true });
  } catch (err) { next(err); }
});

module.exports = router;
