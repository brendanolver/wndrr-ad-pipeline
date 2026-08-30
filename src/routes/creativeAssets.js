const express = require('express');
const { pool } = require('../db');
const { STATUSES, CONCEPT_CLASSIFICATIONS, FORMATS } = require('../lib/statuses');
const { assertCanEnterFilming, RuleViolationError } = require('../lib/rules');
const { deriveProductCode } = require('../lib/apparelmagic');
const { insertCreativeAsset } = require('../lib/assets');

const router = express.Router();

const SELECT_QUERY = `
  SELECT ca.*, s.style_code, s.name AS style_name, s.tier AS style_tier,
    (SELECT slot_rank FROM drop_product_plan_slots WHERE fulfilled_by_asset_id = ca.id LIMIT 1) AS fulfills_slot_rank
  FROM creative_assets ca
  JOIN styles s ON s.id = ca.style_id
`;

router.get('/', async (req, res, next) => {
  try {
    const { style_id, style_ids, status, ids } = req.query;
    const clauses = [];
    const params = [];

    if (ids) {
      const assetIds = String(ids).split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
      if (assetIds.length) {
        params.push(assetIds);
        clauses.push(`ca.id = ANY($${params.length}::int[])`);
      }
    } else if (style_ids) {
      const styleIds = String(style_ids).split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
      if (styleIds.length) {
        params.push(styleIds);
        clauses.push(`ca.style_id = ANY($${params.length}::int[])`);
      }
    } else if (style_id) {
      params.push(style_id);
      clauses.push(`ca.style_id = $${params.length}`);
    }
    if (status) {
      params.push(status);
      clauses.push(`ca.status = $${params.length}`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await pool.query(`${SELECT_QUERY} ${where} ORDER BY ca.target_date NULLS LAST, ca.id`, params);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(`${SELECT_QUERY} WHERE ca.id = $1`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Creative asset not found' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/history', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM status_history WHERE creative_asset_id = $1 ORDER BY changed_at ASC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  // fulfills_slot_id links the new asset to a Required Concept slot
  // (Proven Winners feature) as part of the same create -- optional, and
  // every existing caller omits it, so their behavior is unaffected.
  const { fulfills_slot_id } = req.body || {};
  const client = fulfills_slot_id ? await pool.connect() : null;
  const db = client || pool;
  try {
    const {
      style_id,
      concept_name,
      concept_classification = 'new_experimental',
      format,
      is_deliberate_trial = false,
      target_date,
      strategy_owner,
      filming_owner,
      editing_owner,
      qc_owner,
    } = req.body || {};

    if (!style_id) return res.status(400).json({ error: 'style_id is required' });
    if (!concept_name || !concept_name.trim()) return res.status(400).json({ error: 'concept_name is required' });
    if (!FORMATS.includes(format)) return res.status(400).json({ error: `format must be one of: ${FORMATS.join(', ')}` });
    if (!CONCEPT_CLASSIFICATIONS.includes(concept_classification)) {
      return res.status(400).json({ error: `concept_classification must be one of: ${CONCEPT_CLASSIFICATIONS.join(', ')}` });
    }

    if (client) await client.query('BEGIN');

    if (fulfills_slot_id) {
      const slot = await client.query(
        `SELECT s.id, p.product_code FROM drop_product_plan_slots s
         JOIN drop_product_plans p ON p.id = s.plan_id
         WHERE s.id = $1 AND s.fulfilled_by_asset_id IS NULL FOR UPDATE OF s`,
        [fulfills_slot_id]
      );
      if (!slot.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Concept slot is already fulfilled or does not exist' });
      }
      const style = await client.query('SELECT style_code FROM styles WHERE id = $1', [style_id]);
      if (!style.rows.length || deriveProductCode(style.rows[0].style_code) !== slot.rows[0].product_code) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'style_id does not belong to the concept slot\'s product' });
      }
    }

    const asset = await insertCreativeAsset(db, {
      style_id,
      concept_name: concept_name.trim(),
      concept_classification,
      format,
      is_deliberate_trial,
      target_date: target_date || null,
      strategy_owner: strategy_owner || null,
      filming_owner: filming_owner || null,
      editing_owner: editing_owner || null,
      qc_owner: qc_owner || null,
    });

    if (fulfills_slot_id) {
      await client.query(`UPDATE drop_product_plan_slots SET fulfilled_by_asset_id = $1 WHERE id = $2`, [
        asset.id,
        fulfills_slot_id,
      ]);
      await client.query('COMMIT');
    }

    res.status(201).json(asset);
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    if (err.code === '23503') return res.status(400).json({ error: 'style_id does not reference a real style' });
    next(err);
  } finally {
    if (client) client.release();
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const {
      concept_name,
      concept_classification,
      format,
      is_deliberate_trial,
      target_date,
      strategy_owner,
      filming_owner,
      editing_owner,
      qc_owner,
    } = req.body || {};

    if (concept_classification && !CONCEPT_CLASSIFICATIONS.includes(concept_classification)) {
      return res.status(400).json({ error: `concept_classification must be one of: ${CONCEPT_CLASSIFICATIONS.join(', ')}` });
    }
    if (format && !FORMATS.includes(format)) {
      return res.status(400).json({ error: `format must be one of: ${FORMATS.join(', ')}` });
    }

    const result = await pool.query(
      `UPDATE creative_assets SET
         concept_name = COALESCE($1, concept_name),
         concept_classification = COALESCE($2, concept_classification),
         format = COALESCE($3, format),
         is_deliberate_trial = COALESCE($4, is_deliberate_trial),
         target_date = $5,
         strategy_owner = $6,
         filming_owner = $7,
         editing_owner = $8,
         qc_owner = $9,
         updated_at = now()
       WHERE id = $10 RETURNING *`,
      [
        concept_name ? concept_name.trim() : null,
        concept_classification || null,
        format || null,
        typeof is_deliberate_trial === 'boolean' ? is_deliberate_trial : null,
        target_date || null,
        strategy_owner || null,
        filming_owner || null,
        editing_owner || null,
        qc_owner || null,
        req.params.id,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Creative asset not found' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Status transitions are a dedicated endpoint so the New Drop -> Filming
// rule (and stage-owner accountability logging) can't be bypassed by a
// generic field update.
router.patch('/:id/status', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { status: nextStatus, changed_by } = req.body || {};
    if (!STATUSES.includes(nextStatus)) {
      return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
    }

    await client.query('BEGIN');

    const current = await client.query(
      `SELECT ca.*, s.tier AS style_tier FROM creative_assets ca
       JOIN styles s ON s.id = ca.style_id WHERE ca.id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (current.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Creative asset not found' });
    }
    const asset = current.rows[0];

    if (nextStatus === 'filming') {
      assertCanEnterFilming({
        styleTier: asset.style_tier,
        conceptClassification: asset.concept_classification,
        isDeliberateTrial: asset.is_deliberate_trial,
      });
    }

    const updated = await client.query(
      `UPDATE creative_assets SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [nextStatus, req.params.id]
    );
    await client.query(
      `INSERT INTO status_history (creative_asset_id, from_status, to_status, changed_by) VALUES ($1, $2, $3, $4)`,
      [req.params.id, asset.status, nextStatus, changed_by || null]
    );

    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof RuleViolationError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM creative_assets WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Creative asset not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
