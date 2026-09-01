const express = require('express');
const { pool } = require('../db');
const { fetchAmData, getRules } = require('../lib/planningData');
const { buildCoverage } = require('../lib/coverage');
const { deriveProductCode } = require('../lib/apparelmagic');
const { insertCreativeAsset } = require('../lib/assets');
const { FORMATS } = require('../lib/statuses');

const router = express.Router();

// "Products" have no table of their own -- they're a derived grouping of a
// drop's styles by shared 8-char product code (same as coverage.js).
async function getProductStyles(dropId, productCode) {
  const stylesResult = await pool.query('SELECT * FROM styles WHERE drop_id = $1', [dropId]);
  return stylesResult.rows.filter((s) => deriveProductCode(s.style_code) === productCode);
}

// Recomputes the live creative_target for one product the exact same way
// the Drop coverage grid does, so the two always agree. Also returns the
// product's styles -- a Required Concept slot's auto-created asset needs a
// style_id, and the product's first colourway (same fallback used
// elsewhere, e.g. the Plan Creative modal) is the sensible default; the
// team can change it via Edit.
async function computeProductTarget(dropId, productCode) {
  const matching = await getProductStyles(dropId, productCode);
  if (!matching.length) return { found: false, target: null, styles: [] };

  const [rules, am] = await Promise.all([getRules(), fetchAmData()]);
  const coverage = buildCoverage(matching, {
    assetCounts: new Map(),
    amStock: am.amStock,
    amOnOrder: am.amOnOrder,
    amDetails: am.amDetails,
    amSizeRanges: am.amSizeRanges,
    rules,
  });
  return { found: true, target: coverage[0] ? coverage[0].creative_target : null, styles: matching };
}

async function fetchPlanWithSlots(planId) {
  const planResult = await pool.query('SELECT * FROM drop_product_plans WHERE id = $1', [planId]);
  if (!planResult.rows.length) return null;
  const slotsResult = await pool.query(
    `SELECT s.*, ca.id AS asset_id, ca.concept_name AS asset_concept_name, ca.status AS asset_status,
            ca.concept_classification AS asset_classification, ca.format AS asset_format,
            sty.style_code AS asset_style_code
     FROM drop_product_plan_slots s
     LEFT JOIN creative_assets ca ON ca.id = s.fulfilled_by_asset_id
     LEFT JOIN styles sty ON sty.id = ca.style_id
     WHERE s.plan_id = $1 ORDER BY s.slot_rank ASC`,
    [planId]
  );
  return { plan: planResult.rows[0], slots: slotsResult.rows };
}

router.get('/', async (req, res, next) => {
  try {
    const dropId = Number(req.query.drop_id);
    const productCode = req.query.product_code;
    if (!dropId || !productCode) return res.status(400).json({ error: 'drop_id and product_code are required' });

    const { found, target } = await computeProductTarget(dropId, productCode);
    if (!found) return res.status(404).json({ error: 'Product not found in this drop' });

    const planRow = await pool.query(
      'SELECT id FROM drop_product_plans WHERE drop_id = $1 AND product_code = $2',
      [dropId, productCode]
    );
    if (!planRow.rows.length) {
      return res.json({ plan: null, slots: [], target, shortfall: target });
    }
    const { plan, slots } = await fetchPlanWithSlots(planRow.rows[0].id);
    const shortfall = target != null ? Math.max(0, target - slots.length) : null;
    res.json({ plan, slots, target, shortfall });
  } catch (err) {
    next(err);
  }
});

// Server-authoritative generate-or-top-up. Idempotent: safe to call on every
// product view. Only ever APPENDS new slots (from currently-active Proven
// Winners not already used on this plan) up to the live target -- existing
// slots are never edited, reordered, or removed, so a later playbook edit
// (rename/reorder/deactivate/delete) can never rewrite committed work.
//
// Each new Proven slot's Creative Asset is created immediately, using the
// concept name/format/classification already decided in Settings -- there
// is nothing left for the team to fill in to bring the concept into the
// pipeline, so there's no separate "create" step. It starts against the
// product's first colourway; the team can change that (and add target
// date/owner) via Edit.
//
// Extracted so Concept Development (conceptDevelopment.js) can call this
// exact same logic server-side -- a Drop product's "already assigned"
// concepts must exist by the time Concept Dev is opened, even if nobody
// has visited that product's page in Planning yet.
async function generateOrTopUpPlan(dropId, productCode) {
  const client = await pool.connect();
  try {
    const { found, target, styles } = await computeProductTarget(dropId, productCode);
    if (!found) return { notFound: true };
    if (target == null) {
      return { plan: null, slots: [], target: null, shortfall: null, reason: 'stock_unavailable' };
    }

    await client.query('BEGIN');
    const upserted = await client.query(
      `INSERT INTO drop_product_plans (drop_id, product_code, last_known_target)
       VALUES ($1, $2, $3)
       ON CONFLICT (drop_id, product_code)
       DO UPDATE SET last_known_target = EXCLUDED.last_known_target, updated_at = now()
       RETURNING id`,
      [dropId, productCode, target]
    );
    const planId = upserted.rows[0].id;

    const existingSlots = await client.query(
      `SELECT slot_rank, proven_winner_id FROM drop_product_plan_slots WHERE plan_id = $1`,
      [planId]
    );
    const existingCount = existingSlots.rows.length;
    const usedPwIds = existingSlots.rows.map((r) => r.proven_winner_id).filter((id) => id != null);

    if (existingCount < target) {
      const need = target - existingCount;
      const pwResult = await client.query(
        `SELECT id, name, default_format, default_classification FROM proven_winners
         WHERE active AND NOT (id = ANY($1::int[])) ORDER BY rank ASC LIMIT $2`,
        [usedPwIds, need]
      );
      let nextRank = existingCount + 1;
      for (const pw of pwResult.rows) {
        const slotResult = await client.query(
          `INSERT INTO drop_product_plan_slots
            (plan_id, slot_rank, source, concept_name, proven_winner_id, default_format, default_classification)
           VALUES ($1, $2, 'proven', $3, $4, $5, $6) RETURNING id`,
          [planId, nextRank, pw.name, pw.id, pw.default_format, pw.default_classification]
        );
        const asset = await insertCreativeAsset(client, {
          style_id: styles[0].id,
          concept_name: pw.name,
          concept_classification: pw.default_classification,
          format: pw.default_format,
        });
        await client.query(`UPDATE drop_product_plan_slots SET fulfilled_by_asset_id = $1 WHERE id = $2`, [
          asset.id,
          slotResult.rows[0].id,
        ]);
        nextRank += 1;
      }
    }

    await client.query('COMMIT');

    const { plan, slots } = await fetchPlanWithSlots(planId);
    return { plan, slots, target, shortfall: Math.max(0, target - slots.length) };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

router.post('/', async (req, res, next) => {
  try {
    const { drop_id, product_code } = req.body || {};
    if (!drop_id || !product_code) return res.status(400).json({ error: 'drop_id and product_code are required' });

    const result = await generateOrTopUpPlan(drop_id, product_code);
    if (result.notFound) return res.status(404).json({ error: 'Product not found in this drop' });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// A manually-added New/Test concept has no Proven Winner to default from,
// so this is the one place the team still picks a Format -- classification
// is fixed to 'new_experimental' since that's definitionally what a New/
// Test slot is. Its asset is created immediately too, same as a Proven
// slot, so every Required Concept row behaves the same way from here on.
router.post('/:id/slots', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { concept_name, description, format = 'video', shoot_plan_item_id } = req.body || {};
    if (!concept_name || !concept_name.trim()) return res.status(400).json({ error: 'concept_name is required' });
    if (!FORMATS.includes(format)) return res.status(400).json({ error: `format must be one of: ${FORMATS.join(', ')}` });

    const planResult = await client.query('SELECT * FROM drop_product_plans WHERE id = $1', [req.params.id]);
    if (!planResult.rows.length) return res.status(404).json({ error: 'Plan not found' });
    const plan = planResult.rows[0];

    const styles = await getProductStyles(plan.drop_id, plan.product_code);
    if (!styles.length) return res.status(404).json({ error: 'Product not found in this drop' });

    const maxRank = await client.query(
      'SELECT COALESCE(MAX(slot_rank), 0) AS max_rank FROM drop_product_plan_slots WHERE plan_id = $1',
      [req.params.id]
    );
    const nextRank = maxRank.rows[0].max_rank + 1;

    await client.query('BEGIN');
    const slotResult = await client.query(
      `INSERT INTO drop_product_plan_slots
        (plan_id, slot_rank, source, concept_name, description, default_format, default_classification)
       VALUES ($1, $2, 'new', $3, $4, $5, 'new_experimental') RETURNING id`,
      [req.params.id, nextRank, concept_name.trim(), description || null, format]
    );
    const asset = await insertCreativeAsset(client, {
      style_id: styles[0].id,
      concept_name: concept_name.trim(),
      concept_classification: 'new_experimental',
      format,
    });
    await client.query(`UPDATE drop_product_plan_slots SET fulfilled_by_asset_id = $1 WHERE id = $2`, [
      asset.id,
      slotResult.rows[0].id,
    ]);
    // Links this concept back to the Shoot Plan handoff it was created
    // from, same as every Core/High Stock/Promotion concept already does
    // (see shootPlan.js) -- optional because Planning's own product page
    // also calls this route directly, with no shoot_plan_item in play.
    // Without this link, a Drop concept has no reliable way to carry its
    // product/week context into Shooting once approved.
    if (shoot_plan_item_id) {
      await client.query('UPDATE creative_assets SET shoot_plan_item_id = $1 WHERE id = $2', [
        shoot_plan_item_id,
        asset.id,
      ]);
    }
    await client.query('COMMIT');

    const data = await fetchPlanWithSlots(req.params.id);
    res.status(201).json(data);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id/slots/:slotId', async (req, res, next) => {
  try {
    const slot = await pool.query(
      'SELECT * FROM drop_product_plan_slots WHERE id = $1 AND plan_id = $2',
      [req.params.slotId, req.params.id]
    );
    if (!slot.rows.length) return res.status(404).json({ error: 'Slot not found' });
    const row = slot.rows[0];
    if (row.source !== 'new') {
      return res.status(409).json({ error: 'Only manually-added New/Test concept slots can be removed' });
    }
    if (row.fulfilled_by_asset_id) {
      return res.status(409).json({ error: 'Unlink the fulfilling creative asset before removing this slot' });
    }

    await pool.query('DELETE FROM drop_product_plan_slots WHERE id = $1', [req.params.slotId]);
    const data = await fetchPlanWithSlots(req.params.id);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// Link an EXISTING creative asset (e.g. one already made from the ordinary
// Kanban board before this product had a plan) to an open slot, without
// creating a new asset.
router.patch('/:id/slots/:slotId/fulfill', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { asset_id } = req.body || {};
    if (!asset_id) return res.status(400).json({ error: 'asset_id is required' });

    await client.query('BEGIN');
    const slot = await client.query(
      'SELECT * FROM drop_product_plan_slots WHERE id = $1 AND plan_id = $2 FOR UPDATE',
      [req.params.slotId, req.params.id]
    );
    if (!slot.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Slot not found' });
    }
    if (slot.rows[0].fulfilled_by_asset_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Slot is already fulfilled' });
    }

    const planResult = await client.query('SELECT * FROM drop_product_plans WHERE id = $1', [req.params.id]);
    if (!planResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Plan not found' });
    }
    const { drop_id: dropId, product_code: productCode } = planResult.rows[0];

    const asset = await client.query(
      `SELECT ca.id, s.style_code FROM creative_assets ca JOIN styles s ON s.id = ca.style_id
       WHERE ca.id = $1 AND s.drop_id = $2`,
      [asset_id, dropId]
    );
    if (!asset.rows.length || deriveProductCode(asset.rows[0].style_code) !== productCode) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'asset_id does not belong to a style in this product' });
    }

    await client.query('UPDATE drop_product_plan_slots SET fulfilled_by_asset_id = $1 WHERE id = $2', [
      asset_id,
      req.params.slotId,
    ]);
    await client.query('COMMIT');

    const data = await fetchPlanWithSlots(req.params.id);
    res.json(data);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id/slots/:slotId/fulfill', async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE drop_product_plan_slots SET fulfilled_by_asset_id = NULL WHERE id = $1 AND plan_id = $2 RETURNING id`,
      [req.params.slotId, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Slot not found' });
    const data = await fetchPlanWithSlots(req.params.id);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = { router, generateOrTopUpPlan };
