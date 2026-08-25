const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const CONCEPT_TYPES = [
  'proven_concept', 'new_concept', 'winning_concept_iteration', 'product_content',
  'ugc_creator', 'static', 'existing_content_variation', 'other',
];
const PLANNING_STATUSES = ['not_started', 'organising', 'blocked', 'ready_for_briefing'];
const STOCK_STATUSES = ['not_required', 'available', 'needs_organising', 'in_transit', 'blocked'];
const TALENT_STATUSES = ['not_required', 'internal_team', 'model_required', 'creator_required', 'confirmed', 'not_confirmed'];
const LOCATION_STATUSES = ['not_required', 'office', 'warehouse', 'studio', 'external_location', 'needs_organising', 'confirmed'];
const PROPS_STATUSES = ['not_required', 'required', 'organised', 'not_organised'];

// Statuses per readiness category that count as "resolved" for the
// Ready-for-Briefing exit check (section 14 of the Planning brief).
const STOCK_RESOLVED = ['not_required', 'available'];
const TALENT_RESOLVED = ['not_required', 'internal_team', 'confirmed'];
const LOCATION_RESOLVED = ['not_required', 'office', 'warehouse', 'studio', 'external_location', 'confirmed'];
const PROPS_RESOLVED = ['not_required', 'organised'];

function computeReadiness(job, productCount) {
  const checks = {
    product: productCount > 0,
    concept: Boolean(job.high_level_concept && job.high_level_concept.trim()),
    owner: Boolean(job.owner && job.owner.trim()),
    production_timing: Boolean(job.production_date),
    stock: STOCK_RESOLVED.includes(job.stock_status),
    talent: TALENT_RESOLVED.includes(job.talent_status),
    location: LOCATION_RESOLVED.includes(job.location_status),
    props: PROPS_RESOLVED.includes(job.props_status),
    no_blocker: !job.blocker_reason,
  };
  return { ready: Object.values(checks).every(Boolean), checks };
}

const SELECT_JOB = `
  SELECT cj.*,
    d.name AS drop_name,
    COALESCE(
      (SELECT json_agg(json_build_object('style_id', s.id, 'style_code', s.style_code, 'name', s.name) ORDER BY s.style_code)
       FROM creative_job_products cjp JOIN styles s ON s.id = cjp.style_id
       WHERE cjp.job_id = cj.id),
      '[]'
    ) AS products
  FROM creative_jobs cj
  LEFT JOIN drops d ON d.id = cj.drop_id
`;

function withReadiness(job) {
  const { ready, checks } = computeReadiness(job, job.products.length);
  return { ...job, readiness: { ready, checks } };
}

router.get('/', async (req, res, next) => {
  try {
    const { drop_id, planning_status } = req.query;
    const clauses = [];
    const params = [];
    if (drop_id) { params.push(drop_id); clauses.push(`cj.drop_id = $${params.length}`); }
    if (planning_status) { params.push(planning_status); clauses.push(`cj.planning_status = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const result = await pool.query(`${SELECT_JOB} ${where} ORDER BY cj.production_date NULLS LAST, cj.id`, params);
    res.json(result.rows.map(withReadiness));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(`${SELECT_JOB} WHERE cj.id = $1`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Creative job not found' });
    res.json(withReadiness(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

function validateEnums(body, res) {
  if (body.concept_type && !CONCEPT_TYPES.includes(body.concept_type)) {
    res.status(400).json({ error: `concept_type must be one of: ${CONCEPT_TYPES.join(', ')}` });
    return false;
  }
  if (body.stock_status && !STOCK_STATUSES.includes(body.stock_status)) {
    res.status(400).json({ error: `stock_status must be one of: ${STOCK_STATUSES.join(', ')}` });
    return false;
  }
  if (body.talent_status && !TALENT_STATUSES.includes(body.talent_status)) {
    res.status(400).json({ error: `talent_status must be one of: ${TALENT_STATUSES.join(', ')}` });
    return false;
  }
  if (body.location_status && !LOCATION_STATUSES.includes(body.location_status)) {
    res.status(400).json({ error: `location_status must be one of: ${LOCATION_STATUSES.join(', ')}` });
    return false;
  }
  if (body.props_status && !PROPS_STATUSES.includes(body.props_status)) {
    res.status(400).json({ error: `props_status must be one of: ${PROPS_STATUSES.join(', ')}` });
    return false;
  }
  return true;
}

router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    if (!body.high_level_concept || !body.high_level_concept.trim()) {
      return res.status(400).json({ error: 'high_level_concept is required' });
    }
    if (!validateEnums(body, res)) return;

    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO creative_jobs
        (drop_id, high_level_concept, concept_type, expected_deliverables, expected_ad_variations, owner,
         production_date, production_session, ship_by_date, stock_status, stock_notes, talent_status,
         talent_assignee, talent_notes, location_status, location_notes, props_status, props_notes,
         equipment_needed, logistics_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [
        body.drop_id || null,
        body.high_level_concept.trim(),
        body.concept_type || 'other',
        body.expected_deliverables || null,
        body.expected_ad_variations ?? null,
        body.owner || null,
        body.production_date || null,
        body.production_session || null,
        body.ship_by_date || null,
        body.stock_status || 'not_required',
        body.stock_notes || null,
        body.talent_status || 'not_required',
        body.talent_assignee || null,
        body.talent_notes || null,
        body.location_status || 'not_required',
        body.location_notes || null,
        body.props_status || 'not_required',
        body.props_notes || null,
        body.equipment_needed || [],
        body.logistics_notes || null,
      ]
    );
    const job = result.rows[0];

    const styleIds = Array.isArray(body.style_ids) ? [...new Set(body.style_ids)] : [];
    for (const styleId of styleIds) {
      await client.query(
        `INSERT INTO creative_job_products (job_id, style_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [job.id, styleId]
      );
    }

    await client.query('COMMIT');
    const full = await pool.query(`${SELECT_JOB} WHERE cj.id = $1`, [job.id]);
    res.status(201).json(withReadiness(full.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!validateEnums(body, res)) return;

    const result = await pool.query(
      `UPDATE creative_jobs SET
         drop_id = $1, high_level_concept = COALESCE($2, high_level_concept), concept_type = COALESCE($3, concept_type),
         expected_deliverables = $4, expected_ad_variations = $5, owner = $6, production_date = $7,
         production_session = $8, ship_by_date = $9, stock_status = COALESCE($10, stock_status), stock_notes = $11,
         talent_status = COALESCE($12, talent_status), talent_assignee = $13, talent_notes = $14,
         location_status = COALESCE($15, location_status), location_notes = $16,
         props_status = COALESCE($17, props_status), props_notes = $18, equipment_needed = $19,
         logistics_notes = $20, updated_at = now()
       WHERE id = $21 RETURNING *`,
      [
        body.drop_id || null,
        body.high_level_concept ? body.high_level_concept.trim() : null,
        body.concept_type || null,
        body.expected_deliverables || null,
        body.expected_ad_variations ?? null,
        body.owner || null,
        body.production_date || null,
        body.production_session || null,
        body.ship_by_date || null,
        body.stock_status || null,
        body.stock_notes || null,
        body.talent_status || null,
        body.talent_assignee || null,
        body.talent_notes || null,
        body.location_status || null,
        body.location_notes || null,
        body.props_status || null,
        body.props_notes || null,
        body.equipment_needed || [],
        body.logistics_notes || null,
        req.params.id,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Creative job not found' });
    const full = await pool.query(`${SELECT_JOB} WHERE cj.id = $1`, [req.params.id]);
    res.json(withReadiness(full.rows[0]));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/products', async (req, res, next) => {
  try {
    const { style_id } = req.body || {};
    if (!style_id) return res.status(400).json({ error: 'style_id is required' });
    await pool.query(`INSERT INTO creative_job_products (job_id, style_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      req.params.id,
      style_id,
    ]);
    const full = await pool.query(`${SELECT_JOB} WHERE cj.id = $1`, [req.params.id]);
    if (full.rows.length === 0) return res.status(404).json({ error: 'Creative job not found' });
    res.json(withReadiness(full.rows[0]));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/products/:styleId', async (req, res, next) => {
  try {
    await pool.query(`DELETE FROM creative_job_products WHERE job_id = $1 AND style_id = $2`, [
      req.params.id,
      req.params.styleId,
    ]);
    const full = await pool.query(`${SELECT_JOB} WHERE cj.id = $1`, [req.params.id]);
    if (full.rows.length === 0) return res.status(404).json({ error: 'Creative job not found' });
    res.json(withReadiness(full.rows[0]));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!PLANNING_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${PLANNING_STATUSES.join(', ')}` });
    }

    const current = await pool.query(`${SELECT_JOB} WHERE cj.id = $1`, [req.params.id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Creative job not found' });
    const job = current.rows[0];

    if (status === 'ready_for_briefing') {
      const { ready, checks } = computeReadiness(job, job.products.length);
      if (!ready) {
        const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
        return res.status(422).json({ error: `Not ready for Briefing yet: ${failed.join(', ')} unresolved`, checks });
      }
    }
    if (status === 'blocked' && !job.blocker_reason) {
      return res.status(422).json({ error: 'Set a blocker reason first via PATCH /:id/blocker before marking Blocked' });
    }

    const result = await pool.query(
      `UPDATE creative_jobs SET planning_status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/blocker', async (req, res, next) => {
  try {
    const { blocker_reason, blocker_owner, blocker_expected_resolution } = req.body || {};
    const clearing = !blocker_reason || !blocker_reason.trim();

    const result = await pool.query(
      `UPDATE creative_jobs SET
         blocker_reason = $1::text, blocker_owner = $2, blocker_expected_resolution = $3,
         planning_status = CASE
           WHEN $1::text IS NOT NULL THEN 'blocked'
           WHEN planning_status = 'blocked' THEN 'organising'
           ELSE planning_status
         END,
         updated_at = now()
       WHERE id = $4 RETURNING *`,
      [
        clearing ? null : blocker_reason.trim(),
        clearing ? null : blocker_owner || null,
        clearing ? null : blocker_expected_resolution || null,
        req.params.id,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Creative job not found' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM creative_jobs WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Creative job not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
