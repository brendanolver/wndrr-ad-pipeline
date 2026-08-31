const express = require('express');
const { pool } = require('../db');
const { insertCreativeAsset } = require('../lib/assets');
const { CONCEPT_DEV_STATUSES } = require('../lib/statuses');
const { generateOrTopUpPlan } = require('./dropProductPlans');

const router = express.Router();

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_START_SQL = `COALESCE($1::date, date_trunc('week', now())::date)`;

// The content creator's workspace for turning a CONFIRMED weekly Shoot Plan
// into concepts ready for the Tuesday review meeting. Deliberately reads
// only -- product/colourways/owner/source/initial idea all come straight
// from shoot_plan_items (Monday Planning's handoff), never re-entered here.
// Gated on weekly_shoot_plan_confirmations, matching the Shoot Plan step's
// own "Shoot plan sent to Concept Development" confirmation copy -- nothing
// flows into this page until that handoff has actually happened.
router.get('/', async (req, res, next) => {
  try {
    const weekStart = req.query.week_start;
    if (weekStart !== undefined && !WEEK_RE.test(weekStart)) {
      return res.status(400).json({ error: 'week_start must be YYYY-MM-DD' });
    }

    const confirmationResult = await pool.query(
      `SELECT * FROM weekly_shoot_plan_confirmations WHERE week_start = ${WEEK_START_SQL}`,
      [weekStart || null]
    );
    const confirmation = confirmationResult.rows[0] || null;
    const resolvedWeekResult = await pool.query(`SELECT ${WEEK_START_SQL} AS week_start`, [weekStart || null]);
    const resolvedWeekStart = resolvedWeekResult.rows[0].week_start;

    if (!confirmation) {
      return res.json({ week_start: resolvedWeekStart, confirmed: false, confirmed_at: null, products: [] });
    }

    const itemsResult = await pool.query(
      `SELECT spi.*, p.id AS promotion_id, p.name AS promotion_name, ps.name AS promotion_stage_name
       FROM shoot_plan_items spi
       LEFT JOIN promotion_stages ps ON ps.id = spi.promotion_stage_id
       LEFT JOIN promotions p ON p.id = ps.promotion_id
       WHERE spi.week_start = $1
       ORDER BY spi.created_at ASC`,
      [resolvedWeekStart]
    );
    const items = itemsResult.rows;
    if (!items.length) {
      return res.json({ week_start: resolvedWeekStart, confirmed: true, confirmed_at: confirmation.confirmed_at, products: [] });
    }

    const stylesResult = await pool.query(
      `SELECT spis.shoot_plan_item_id, s.id AS style_id, s.style_code, s.drop_id, spis.size, spis.colour_label
       FROM shoot_plan_item_styles spis
       JOIN styles s ON s.id = spis.style_id
       WHERE spis.shoot_plan_item_id = ANY($1::int[])`,
      [items.map((i) => i.id)]
    );
    const stylesByItem = new Map();
    for (const row of stylesResult.rows) {
      if (!stylesByItem.has(row.shoot_plan_item_id)) stylesByItem.set(row.shoot_plan_item_id, []);
      stylesByItem.get(row.shoot_plan_item_id).push(row);
    }

    // Core/High Stock/Promotion concepts: every creative_assets row already
    // scoped to this item via shoot_plan_item_id (the seed concept plus any
    // the creator has added on this page since).
    const nonDropItemIds = items.filter((i) => i.source !== 'drop').map((i) => i.id);
    const conceptsResult = nonDropItemIds.length
      ? await pool.query(
          `SELECT * FROM creative_assets WHERE shoot_plan_item_id = ANY($1::int[]) ORDER BY created_at ASC`,
          [nonDropItemIds]
        )
      : { rows: [] };
    const conceptsByItem = new Map();
    for (const row of conceptsResult.rows) {
      if (!conceptsByItem.has(row.shoot_plan_item_id)) conceptsByItem.set(row.shoot_plan_item_id, []);
      conceptsByItem.get(row.shoot_plan_item_id).push({ ...row, name_locked: false });
    }

    // Drop concepts: the product's already-assigned Required Concept slots.
    // Auto-generate/top-up server-side (same logic Planning's own product
    // page uses) so "already assigned" holds true even if nobody has
    // visited that product's Planning page yet.
    const dropItems = items.filter((i) => i.source === 'drop');
    const dropPlanIdByItem = new Map();
    for (const item of dropItems) {
      const itemStyles = stylesByItem.get(item.id) || [];
      const dropId = itemStyles.map((s) => s.drop_id).find((id) => id != null);
      if (!dropId) { conceptsByItem.set(item.id, []); continue; }
      const result = await generateOrTopUpPlan(dropId, item.product_code);
      if (result.notFound || !result.plan) { conceptsByItem.set(item.id, []); continue; }
      dropPlanIdByItem.set(item.id, result.plan.id);
      const slotAssetsResult = await pool.query(
        `SELECT dpps.proven_winner_id, ca.*
         FROM drop_product_plan_slots dpps
         JOIN creative_assets ca ON ca.id = dpps.fulfilled_by_asset_id
         WHERE dpps.plan_id = $1
         ORDER BY dpps.slot_rank ASC`,
        [result.plan.id]
      );
      conceptsByItem.set(item.id, slotAssetsResult.rows.map((row) => ({
        ...row,
        name_locked: row.proven_winner_id != null,
      })));
    }

    const products = items.map((i) => ({
      shoot_plan_item_id: i.id,
      product_code: i.product_code,
      product_name: i.product_name,
      image_url: i.image_url,
      stock_status: i.stock_status,
      creator: i.creator,
      initial_idea: i.initial_idea,
      source: i.source,
      promotion_stage_id: i.promotion_stage_id,
      promotion_name: i.promotion_name,
      promotion_stage_name: i.promotion_stage_name,
      drop_plan_id: dropPlanIdByItem.get(i.id) || null,
      colourways: (stylesByItem.get(i.id) || []).map((s) => ({
        style_id: s.style_id,
        style_code: s.style_code,
        colour_label: s.colour_label,
        size: s.size,
      })),
      concepts: conceptsByItem.get(i.id) || [],
    }));

    res.json({ week_start: resolvedWeekStart, confirmed: true, confirmed_at: confirmation.confirmed_at, products });
  } catch (err) {
    next(err);
  }
});

// Ad-hoc concept for a Core/High Stock/Promotion product -- a Drop
// product's "+ Add Concept" instead reuses the existing
// POST /drop-product-plans/:id/slots (adds a 'new' Required Concept slot,
// same as Planning's own product page), so there's exactly one place that
// creates a Drop concept.
router.post('/concepts', async (req, res, next) => {
  try {
    const { shoot_plan_item_id, concept_name } = req.body || {};
    if (!shoot_plan_item_id) return res.status(400).json({ error: 'shoot_plan_item_id is required' });
    if (!concept_name || !concept_name.trim()) return res.status(400).json({ error: 'concept_name is required' });

    const itemResult = await pool.query('SELECT * FROM shoot_plan_items WHERE id = $1', [shoot_plan_item_id]);
    if (!itemResult.rows.length) return res.status(404).json({ error: 'Shoot plan item not found' });
    if (itemResult.rows[0].source === 'drop') {
      return res.status(409).json({ error: 'Drop products add concepts via their Required Concept slots, not this endpoint' });
    }

    const styleResult = await pool.query(
      `SELECT style_id FROM shoot_plan_item_styles WHERE shoot_plan_item_id = $1 LIMIT 1`,
      [shoot_plan_item_id]
    );
    if (!styleResult.rows.length) return res.status(400).json({ error: 'This product has no colourways to attach a concept to' });

    const asset = await insertCreativeAsset(pool, {
      style_id: styleResult.rows[0].style_id,
      concept_name: concept_name.trim(),
      concept_classification: 'new_experimental',
      format: 'video',
      status: 'awaiting_concept_development',
    });
    await pool.query('UPDATE creative_assets SET shoot_plan_item_id = $1 WHERE id = $2', [shoot_plan_item_id, asset.id]);

    res.status(201).json({ ...asset, shoot_plan_item_id: Number(shoot_plan_item_id), name_locked: false });
  } catch (err) {
    next(err);
  }
});

// The one place every rich creative-development field gets edited,
// regardless of whether the concept came from a Core/High Stock/Promotion
// handoff or a Drop's Required Concept slot -- both are plain
// creative_assets rows. concept_name is accepted here too, but the
// frontend never renders it editable when name_locked (a real Proven
// Winner name) is true. hook_variations replaces the old single `hook`
// field -- a concept's opening(s), not a separate concept per opening; see
// schema.sql's comment on the column. Same whole-array-replace pattern as
// reference_items, not a diffed patch, so the frontend can freely
// add/remove/reorder hooks client-side before saving.
router.patch('/concepts/:id', async (req, res, next) => {
  try {
    const {
      concept_name,
      concept_dev_status,
      angle,
      execution,
      script_notes,
      hook_variations,
      reference_items,
      talent_requirement,
      location,
      props_notes,
    } = req.body || {};

    if (concept_dev_status !== undefined && !CONCEPT_DEV_STATUSES.includes(concept_dev_status)) {
      return res.status(400).json({ error: `concept_dev_status must be one of: ${CONCEPT_DEV_STATUSES.join(', ')}` });
    }
    if (reference_items !== undefined) {
      const valid = Array.isArray(reference_items) && reference_items.every(
        (r) => r && typeof r === 'object' && typeof r.url === 'string'
      );
      if (!valid) return res.status(400).json({ error: 'reference_items must be an array of { url, note }' });
    }
    if (hook_variations !== undefined) {
      const valid = Array.isArray(hook_variations) && hook_variations.every(
        (h) => h && typeof h === 'object' && typeof h.text === 'string'
      );
      if (!valid) return res.status(400).json({ error: 'hook_variations must be an array of { text }' });
    }

    const result = await pool.query(
      `UPDATE creative_assets SET
         concept_name = COALESCE($1, concept_name),
         concept_dev_status = COALESCE($2, concept_dev_status),
         angle = COALESCE($3, angle),
         execution = COALESCE($4, execution),
         script_notes = COALESCE($5, script_notes),
         hook_variations = COALESCE($6, hook_variations),
         reference_items = COALESCE($7, reference_items),
         talent_requirement = COALESCE($8, talent_requirement),
         location = COALESCE($9, location),
         props_notes = COALESCE($10, props_notes),
         updated_at = now()
       WHERE id = $11 RETURNING *`,
      [
        concept_name && concept_name.trim() ? concept_name.trim() : null,
        concept_dev_status || null,
        angle !== undefined ? angle : null,
        execution !== undefined ? execution : null,
        script_notes !== undefined ? script_notes : null,
        hook_variations !== undefined ? JSON.stringify(hook_variations) : null,
        reference_items !== undefined ? JSON.stringify(reference_items) : null,
        talent_requirement !== undefined ? talent_requirement : null,
        location !== undefined ? location : null,
        props_notes !== undefined ? props_notes : null,
        req.params.id,
      ]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Concept not found' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
