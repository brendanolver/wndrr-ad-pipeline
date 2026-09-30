// Black Friday 2026 creative-style matrix, progress, ideas, and inspiration
// library -- extends the EXISTING Promotion/Campaign Stage system
// (promotions/promotion_stages/shoot_plan_items.promotion_stage_id), never
// a parallel Black Friday application. See db/schema.sql's header comment
// on this feature for the full table layout.
//
// A creative idea is a MASTER record (promotion_creative_ideas: concept/
// footage/who/where/inspo) with one or more STAGE EXECUTIONS
// (promotion_creative_idea_executions: which Black Friday phase it runs
// in, its own creative-style classification, and optionally its own
// separate produced asset). The 180-target progress counters always count
// executions, never master ideas -- one master idea used across 3 stages
// is 3 planned pieces.
const express = require('express');
const { pool } = require('../db');
const { STATUSES } = require('../lib/statuses');
const { insertCreativeAsset } = require('../lib/assets');

const router = express.Router();

// ---------------------------------------------------------------------
// Production stage of a single execution -- derived, never stored (see the
// brief: status must come from the real pipeline record, not a second
// lifecycle a human has to keep in sync). Checked latest-first so a
// concept always lands in the furthest stage it's actually reached.
// Mirrors the same underlying signals routes/moveBack.js already uses to
// detect a concept's current stage, just shaped into the simpler 7-rung
// ladder the brief asks for.
const IDEA_STAGE_LABELS = {
  planned: 'Planned',
  concept_development: 'Concept Development',
  tuesday_review: 'Tuesday Review',
  scheduled_to_shoot: 'Scheduled to Shoot',
  editing: 'Editing',
  final_approval: 'Final Approval',
  completed: 'Completed',
};

function deriveIdeaStage(concept, shootSchedule) {
  if (!concept) return 'planned';
  if (STATUSES.indexOf(concept.status) >= STATUSES.indexOf('qc')) return 'completed';
  if (concept.editing_submitted_at) return 'final_approval';
  if (shootSchedule && shootSchedule.ready_for_editing) return 'editing';
  if (shootSchedule) return 'scheduled_to_shoot';
  if (concept.concept_dev_status === 'ready_for_review') return 'tuesday_review';
  return 'concept_development';
}

// One shared loader for every idea-list endpoint: master ideas + their
// stage executions + each execution's EFFECTIVE linked concept's real
// pipeline signals + inspiration links, all in a handful of batched
// queries rather than N+1.
async function loadIdeasForPromotion(promotionId) {
  const ideasResult = await pool.query(
    `SELECT * FROM promotion_creative_ideas WHERE promotion_id = $1 ORDER BY created_at ASC`,
    [promotionId]
  );
  const ideas = ideasResult.rows;
  const ideaIds = ideas.map((i) => i.id);

  const executionsResult = ideaIds.length
    ? await pool.query(
        `SELECT pcie.*, ps.name AS stage_name, ps.sort_order AS stage_sort_order,
                cs.name AS style_name, cs.media_type AS style_media_type
         FROM promotion_creative_idea_executions pcie
         JOIN promotion_stages ps ON ps.id = pcie.promotion_stage_id
         LEFT JOIN creative_styles cs ON cs.id = pcie.creative_style_id
         WHERE pcie.promotion_creative_idea_id = ANY($1::int[])
         ORDER BY ps.sort_order ASC`,
        [ideaIds]
      )
    : { rows: [] };
  const executionsByIdea = new Map();
  for (const row of executionsResult.rows) {
    if (!executionsByIdea.has(row.promotion_creative_idea_id)) executionsByIdea.set(row.promotion_creative_idea_id, []);
    executionsByIdea.get(row.promotion_creative_idea_id).push(row);
  }

  // Every asset an idea's executions could possibly resolve to -- the
  // master's own shared asset, plus any execution's deliberate override.
  const ideaById = new Map(ideas.map((i) => [i.id, i]));
  const assetIds = new Set();
  for (const idea of ideas) if (idea.linked_creative_asset_id) assetIds.add(idea.linked_creative_asset_id);
  for (const exec of executionsResult.rows) if (exec.linked_creative_asset_id) assetIds.add(exec.linked_creative_asset_id);

  const conceptsById = new Map();
  const schedulesByAssetId = new Map();
  if (assetIds.size) {
    const idArray = [...assetIds];
    const conceptsResult = await pool.query(
      `SELECT id, concept_name, status, concept_dev_status, editing_submitted_at, final_approval_status
       FROM creative_assets WHERE id = ANY($1::int[])`,
      [idArray]
    );
    for (const row of conceptsResult.rows) conceptsById.set(row.id, row);

    const schedulesResult = await pool.query(
      `SELECT creative_asset_id, status, ready_for_editing FROM shoot_schedule WHERE creative_asset_id = ANY($1::int[])`,
      [idArray]
    );
    for (const row of schedulesResult.rows) schedulesByAssetId.set(row.creative_asset_id, row);
  }

  const inspirationLinksResult = ideaIds.length
    ? await pool.query(
        `SELECT pcii.promotion_creative_idea_id, ci.id, ci.title, ci.campaign_name, ci.video_url,
                ci.creative_style_id, cs.name AS style_name, ci.media_type
         FROM promotion_creative_idea_inspirations pcii
         JOIN creative_inspiration ci ON ci.id = pcii.creative_inspiration_id
         LEFT JOIN creative_styles cs ON cs.id = ci.creative_style_id
         WHERE pcii.promotion_creative_idea_id = ANY($1::int[])`,
        [ideaIds]
      )
    : { rows: [] };
  const inspirationByIdea = new Map();
  for (const row of inspirationLinksResult.rows) {
    if (!inspirationByIdea.has(row.promotion_creative_idea_id)) inspirationByIdea.set(row.promotion_creative_idea_id, []);
    inspirationByIdea.get(row.promotion_creative_idea_id).push({
      id: row.id, title: row.title, campaign_name: row.campaign_name, video_url: row.video_url,
      creative_style_id: row.creative_style_id, style_name: row.style_name, media_type: row.media_type,
    });
  }

  return ideas.map((idea) => {
    const executions = (executionsByIdea.get(idea.id) || []).map((exec) => {
      // Falls back to the master's shared asset when this execution has no
      // deliberate override -- "do not create three identical shoot jobs".
      const effectiveAssetId = exec.linked_creative_asset_id || idea.linked_creative_asset_id || null;
      const concept = effectiveAssetId ? conceptsById.get(effectiveAssetId) : null;
      const schedule = effectiveAssetId ? schedulesByAssetId.get(effectiveAssetId) : null;
      const stage = deriveIdeaStage(concept, schedule);
      return {
        id: exec.id,
        promotion_stage_id: exec.promotion_stage_id,
        stage_name: exec.stage_name,
        stage_sort_order: exec.stage_sort_order,
        creative_style_id: exec.creative_style_id,
        style_name: exec.style_name,
        needs_classification: exec.creative_style_id === null,
        linked_creative_asset_id: exec.linked_creative_asset_id,
        effective_creative_asset_id: effectiveAssetId,
        uses_shared_asset: !exec.linked_creative_asset_id && !!idea.linked_creative_asset_id,
        linked_concept_name: concept ? concept.concept_name : null,
        production_stage: stage,
        production_stage_label: IDEA_STAGE_LABELS[stage],
        is_completed: stage === 'completed',
      };
    });
    return {
      ...idea,
      executions,
      inspiration: inspirationByIdea.get(idea.id) || [],
    };
  });
}

async function loadOneIdea(promotionId, ideaId) {
  const rows = await loadIdeasForPromotion(promotionId);
  return rows.find((r) => r.id === Number(ideaId)) || null;
}

router.get('/:promotionId/ideas', async (req, res, next) => {
  try {
    const ideas = await loadIdeasForPromotion(req.params.promotionId);
    res.json({ ideas });
  } catch (err) {
    next(err);
  }
});

// Creates a master idea, optionally with its first stage_ids/creative_style_id
// executions in the same call (the "New Idea" modal's common case: pick one
// or more stages up front). Additional stages can be added later via
// POST /ideas/:id/executions.
router.post('/:promotionId/ideas', async (req, res, next) => {
  try {
    const {
      title, who, where_text, concept_script, need_text, reference_note, media_type,
      stage_ids, creative_style_id,
    } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
    if (media_type !== undefined && media_type !== null && !['graphic', 'video'].includes(media_type)) {
      return res.status(400).json({ error: 'media_type must be graphic or video' });
    }
    const ideaResult = await pool.query(
      `INSERT INTO promotion_creative_ideas
        (promotion_id, title, who, where_text, concept_script, need_text, reference_note, media_type, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        req.params.promotionId, title.trim(), who || null, where_text || null, concept_script || null,
        need_text || null, reference_note || null, media_type || null, req.user.id,
      ]
    );
    const ideaId = ideaResult.rows[0].id;
    const stageIds = Array.isArray(stage_ids) ? stage_ids.filter(Boolean) : [];
    for (const stageId of stageIds) {
      await pool.query(
        `INSERT INTO promotion_creative_idea_executions (promotion_creative_idea_id, promotion_stage_id, creative_style_id)
         VALUES ($1,$2,$3) ON CONFLICT (promotion_creative_idea_id, promotion_stage_id) DO NOTHING`,
        [ideaId, stageId, creative_style_id || null]
      );
    }
    const idea = await loadOneIdea(req.params.promotionId, ideaId);
    res.status(201).json(idea);
  } catch (err) {
    next(err);
  }
});

// Edits the MASTER idea's own fields, including linked_creative_asset_id --
// so a master can be pointed at an ALREADY-EXISTING concept (see the
// brief: "If an existing concept/creative record can be linked, link it")
// without going through the create-new-concept path at all. Per-execution
// fields (stage, style, an execution's own asset override) are edited
// through the /executions routes below, not here.
router.patch('/ideas/:id', async (req, res, next) => {
  try {
    const existing = await pool.query('SELECT * FROM promotion_creative_ideas WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Idea not found' });
    const current = existing.rows[0];

    const {
      title, who, where_text, concept_script, need_text, reference_note, media_type, linked_creative_asset_id,
    } = req.body || {};

    if (media_type !== undefined && media_type !== null && !['graphic', 'video'].includes(media_type)) {
      return res.status(400).json({ error: 'media_type must be graphic or video' });
    }
    if (linked_creative_asset_id !== undefined && linked_creative_asset_id !== null) {
      const assetCheck = await pool.query('SELECT id FROM creative_assets WHERE id = $1', [linked_creative_asset_id]);
      if (!assetCheck.rows.length) return res.status(400).json({ error: 'linked_creative_asset_id does not reference a real concept' });
    }

    const hasLinkedField = Object.prototype.hasOwnProperty.call(req.body || {}, 'linked_creative_asset_id');

    await pool.query(
      `UPDATE promotion_creative_ideas SET
         title = COALESCE($1, title),
         who = COALESCE($2, who),
         where_text = COALESCE($3, where_text),
         concept_script = COALESCE($4, concept_script),
         need_text = COALESCE($5, need_text),
         reference_note = COALESCE($6, reference_note),
         media_type = COALESCE($7, media_type),
         linked_creative_asset_id = CASE WHEN $8 THEN $9 ELSE linked_creative_asset_id END,
         updated_at = now()
       WHERE id = $10`,
      [
        title && title.trim() ? title.trim() : null,
        who !== undefined ? who : null, where_text !== undefined ? where_text : null,
        concept_script !== undefined ? concept_script : null, need_text !== undefined ? need_text : null,
        reference_note !== undefined ? reference_note : null, media_type || null,
        hasLinkedField, hasLinkedField ? (linked_creative_asset_id || null) : null,
        req.params.id,
      ]
    );
    const idea = await loadOneIdea(current.promotion_id, req.params.id);
    res.json(idea);
  } catch (err) {
    next(err);
  }
});

// Deletes only the PLANNING record (cascades its executions) -- never the
// linked creative_assets/shoot_plan_items/final_edits row, which is real
// production work that lives on independently of whatever planning record
// pointed at it.
router.delete('/ideas/:id', async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM promotion_creative_ideas WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Idea not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Stage executions -- add/edit/remove one Black Friday phase a master
// idea runs in. All idempotent-safe: adding the same stage twice, or
// editing a field to the same value, never creates a second row (the
// (idea, stage) UNIQUE constraint enforces this at the DB level too).
// ---------------------------------------------------------------------
router.post('/ideas/:id/executions', async (req, res, next) => {
  try {
    const { promotion_stage_id, creative_style_id } = req.body || {};
    if (!promotion_stage_id) return res.status(400).json({ error: 'promotion_stage_id is required' });
    const ideaCheck = await pool.query('SELECT promotion_id FROM promotion_creative_ideas WHERE id = $1', [req.params.id]);
    if (!ideaCheck.rows.length) return res.status(404).json({ error: 'Idea not found' });
    await pool.query(
      `INSERT INTO promotion_creative_idea_executions (promotion_creative_idea_id, promotion_stage_id, creative_style_id)
       VALUES ($1,$2,$3) ON CONFLICT (promotion_creative_idea_id, promotion_stage_id) DO NOTHING`,
      [req.params.id, promotion_stage_id, creative_style_id || null]
    );
    const idea = await loadOneIdea(ideaCheck.rows[0].promotion_id, req.params.id);
    res.status(201).json(idea);
  } catch (err) {
    next(err);
  }
});

// Reclassify one execution's creative style, or give it its OWN separate
// produced asset instead of inheriting the master's shared one (see the
// brief, item 7 -- always an explicit opt-in, never automatic). Linking to
// an existing concept here never creates a duplicate -- same
// already-exists check as the master-level PATCH.
router.patch('/ideas/:id/executions/:execId', async (req, res, next) => {
  try {
    const { creative_style_id, linked_creative_asset_id } = req.body || {};
    const execCheck = await pool.query(
      `SELECT pcie.id, pci.promotion_id FROM promotion_creative_idea_executions pcie
       JOIN promotion_creative_ideas pci ON pci.id = pcie.promotion_creative_idea_id
       WHERE pcie.id = $1 AND pcie.promotion_creative_idea_id = $2`,
      [req.params.execId, req.params.id]
    );
    if (!execCheck.rows.length) return res.status(404).json({ error: 'Execution not found' });
    if (linked_creative_asset_id !== undefined && linked_creative_asset_id !== null) {
      const assetCheck = await pool.query('SELECT id FROM creative_assets WHERE id = $1', [linked_creative_asset_id]);
      if (!assetCheck.rows.length) return res.status(400).json({ error: 'linked_creative_asset_id does not reference a real concept' });
    }
    const hasStyleField = Object.prototype.hasOwnProperty.call(req.body || {}, 'creative_style_id');
    const hasLinkedField = Object.prototype.hasOwnProperty.call(req.body || {}, 'linked_creative_asset_id');
    await pool.query(
      `UPDATE promotion_creative_idea_executions SET
         creative_style_id = CASE WHEN $1 THEN $2 ELSE creative_style_id END,
         linked_creative_asset_id = CASE WHEN $3 THEN $4 ELSE linked_creative_asset_id END,
         updated_at = now()
       WHERE id = $5`,
      [hasStyleField, creative_style_id || null, hasLinkedField, hasLinkedField ? (linked_creative_asset_id || null) : null, req.params.execId]
    );
    const idea = await loadOneIdea(execCheck.rows[0].promotion_id, req.params.id);
    res.json(idea);
  } catch (err) {
    next(err);
  }
});

router.delete('/ideas/:id/executions/:execId', async (req, res, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM promotion_creative_idea_executions WHERE id = $1 AND promotion_creative_idea_id = $2 RETURNING id`,
      [req.params.execId, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Execution not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// "Send to Pipeline" -- creates the SHARED base concept for the master
// idea, through the SAME entry point every other Promotion concept already
// uses (mirrors savePromotionShootItem's POST /shoot-plan call in app.js).
// Every execution without its own override automatically inherits this
// asset (see loadIdeasForPromotion) -- "do not create three identical
// shoot jobs by default". Idempotent: a master that already has
// linked_creative_asset_id is never sent twice. Graphics use format:
// 'static', the SAME already-supported path every other static Promotion
// concept uses -- no fake Shooting-skip mechanism invented.
router.post('/ideas/:id/send-to-pipeline', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const ideaResult = await client.query('SELECT * FROM promotion_creative_ideas WHERE id = $1', [req.params.id]);
    if (!ideaResult.rows.length) return res.status(404).json({ error: 'Idea not found' });
    const idea = ideaResult.rows[0];
    if (idea.linked_creative_asset_id) {
      return res.json({ ok: true, already_linked: true, creative_asset_id: idea.linked_creative_asset_id });
    }
    // The legacy planning-Campaign-Stages coverage panel (shoot_plan_items.
    // promotion_stage_id) still expects a single stage per shoot -- picks
    // the earliest stage this idea actually runs in as that one anchor;
    // the real multi-stage progress counters below never use this column.
    const execResult = await client.query(
      `SELECT pcie.promotion_stage_id FROM promotion_creative_idea_executions pcie
       JOIN promotion_stages ps ON ps.id = pcie.promotion_stage_id
       WHERE pcie.promotion_creative_idea_id = $1 ORDER BY ps.sort_order ASC LIMIT 1`,
      [req.params.id]
    );
    if (!execResult.rows.length) return res.status(400).json({ error: 'Add at least one Black Friday stage before sending this idea to the pipeline' });
    const primaryStageId = execResult.rows[0].promotion_stage_id;

    const format = idea.media_type === 'graphic' ? 'static' : 'video';

    await client.query('BEGIN');
    const asset = await insertCreativeAsset(client, {
      concept_name: idea.title,
      format,
      status: 'awaiting_concept_development',
      created_by_user_id: req.user.id,
    });
    const itemResult = await client.query(
      `INSERT INTO shoot_plan_items (product_code, product_name, stock_status, creator, initial_idea, asset_id, source, promotion_stage_id, week_start, created_by_user_id)
       VALUES (NULL, NULL, 'in_office', $1, $2, $3, 'promotion', $4, date_trunc('week', now())::date, $5) RETURNING id`,
      [idea.who || 'Unassigned', idea.concept_script || null, asset.id, primaryStageId, req.user.id]
    );
    await client.query('UPDATE creative_assets SET shoot_plan_item_id = $1 WHERE id = $2', [itemResult.rows[0].id, asset.id]);
    await client.query('UPDATE promotion_creative_ideas SET linked_creative_asset_id = $1, updated_at = now() WHERE id = $2', [asset.id, req.params.id]);
    await client.query('COMMIT');
    res.status(201).json({ ok: true, already_linked: false, creative_asset_id: asset.id });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// Gives ONE execution its own separate produced asset instead of the
// master's shared one -- an explicit opt-in for when the team genuinely
// decides to shoot a different version for that phase (see the brief,
// item 7). Idempotent: an execution that already has its own asset just
// returns it.
router.post('/ideas/:id/executions/:execId/send-to-pipeline', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const execResult = await client.query(
      `SELECT pcie.*, pci.title, pci.who, pci.concept_script, pci.media_type, pci.promotion_id
       FROM promotion_creative_idea_executions pcie
       JOIN promotion_creative_ideas pci ON pci.id = pcie.promotion_creative_idea_id
       WHERE pcie.id = $1 AND pcie.promotion_creative_idea_id = $2`,
      [req.params.execId, req.params.id]
    );
    if (!execResult.rows.length) return res.status(404).json({ error: 'Execution not found' });
    const exec = execResult.rows[0];
    if (exec.linked_creative_asset_id) {
      return res.json({ ok: true, already_linked: true, creative_asset_id: exec.linked_creative_asset_id });
    }

    const format = exec.media_type === 'graphic' ? 'static' : 'video';

    await client.query('BEGIN');
    const asset = await insertCreativeAsset(client, {
      concept_name: exec.title,
      format,
      status: 'awaiting_concept_development',
      created_by_user_id: req.user.id,
    });
    const itemResult = await client.query(
      `INSERT INTO shoot_plan_items (product_code, product_name, stock_status, creator, initial_idea, asset_id, source, promotion_stage_id, week_start, created_by_user_id)
       VALUES (NULL, NULL, 'in_office', $1, $2, $3, 'promotion', $4, date_trunc('week', now())::date, $5) RETURNING id`,
      [exec.who || 'Unassigned', exec.concept_script || null, asset.id, exec.promotion_stage_id, req.user.id]
    );
    await client.query('UPDATE creative_assets SET shoot_plan_item_id = $1 WHERE id = $2', [itemResult.rows[0].id, asset.id]);
    await client.query('UPDATE promotion_creative_idea_executions SET linked_creative_asset_id = $1, updated_at = now() WHERE id = $2', [asset.id, req.params.execId]);
    await client.query('COMMIT');
    res.status(201).json({ ok: true, already_linked: false, creative_asset_id: asset.id });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------
// Creative styles (read-only reference list for dropdowns/target matrix)
// ---------------------------------------------------------------------
router.get('/styles', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM creative_styles ORDER BY sort_order ASC, id ASC');
    res.json({ styles: result.rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Progress: the derived required/planned/completed matrix + stage totals
// (see the brief, items 2/8/9). Never a stored counter -- computed fresh
// from promotion_creative_targets + every idea's stage EXECUTIONS + each
// execution's effective linked concept's real pipeline state, on every
// call. Stage totals count every execution regardless of whether it has a
// style yet (an unclassified execution is still real planned work); the
// per-style matrix only breaks out the ones that do.
// ---------------------------------------------------------------------
router.get('/:promotionId/progress', async (req, res, next) => {
  try {
    const promotionId = req.params.promotionId;
    const targetsResult = await pool.query(
      `SELECT pct.*, ps.name AS stage_name, ps.sort_order AS stage_sort_order, cs.name AS style_name, cs.media_type
       FROM promotion_creative_targets pct
       JOIN promotion_stages ps ON ps.id = pct.promotion_stage_id
       JOIN creative_styles cs ON cs.id = pct.creative_style_id
       WHERE pct.promotion_id = $1`,
      [promotionId]
    );

    const ideas = await loadIdeasForPromotion(promotionId);

    const stageTotalsMap = new Map();
    for (const t of targetsResult.rows) {
      if (!stageTotalsMap.has(t.promotion_stage_id)) {
        stageTotalsMap.set(t.promotion_stage_id, {
          promotion_stage_id: t.promotion_stage_id, stage_name: t.stage_name, stage_sort_order: t.stage_sort_order,
          required: 0, planned: 0, completed: 0,
        });
      }
      stageTotalsMap.get(t.promotion_stage_id).required += t.required_count;
    }

    // Cell key: "stageId:styleId" -- unions target-matrix cells with any
    // cell that has executions but no target row, so nothing with real
    // work logged against it ever silently disappears from the view.
    const cells = new Map();
    for (const t of targetsResult.rows) {
      cells.set(`${t.promotion_stage_id}:${t.creative_style_id}`, {
        promotion_stage_id: t.promotion_stage_id, stage_name: t.stage_name, stage_sort_order: t.stage_sort_order,
        creative_style_id: t.creative_style_id, style_name: t.style_name, media_type: t.media_type,
        required: t.required_count, planned: 0, completed: 0,
      });
    }

    let needsClassificationCount = 0;
    for (const idea of ideas) {
      for (const exec of idea.executions) {
        if (!stageTotalsMap.has(exec.promotion_stage_id)) {
          stageTotalsMap.set(exec.promotion_stage_id, {
            promotion_stage_id: exec.promotion_stage_id, stage_name: exec.stage_name, stage_sort_order: exec.stage_sort_order,
            required: 0, planned: 0, completed: 0,
          });
        }
        const stageTotal = stageTotalsMap.get(exec.promotion_stage_id);
        stageTotal.planned += 1;
        if (exec.is_completed) stageTotal.completed += 1;

        if (!exec.creative_style_id) {
          needsClassificationCount += 1;
          continue; // Needs Classification -- doesn't count toward any one style cell.
        }
        const key = `${exec.promotion_stage_id}:${exec.creative_style_id}`;
        if (!cells.has(key)) {
          cells.set(key, {
            promotion_stage_id: exec.promotion_stage_id, stage_name: exec.stage_name, stage_sort_order: exec.stage_sort_order,
            creative_style_id: exec.creative_style_id, style_name: exec.style_name, media_type: exec.style_media_type,
            required: 0, planned: 0, completed: 0,
          });
        }
        const cell = cells.get(key);
        cell.planned += 1;
        if (exec.is_completed) cell.completed += 1;
      }
    }

    const matrix = [...cells.values()].map((c) => ({
      ...c,
      still_to_plan: Math.max(0, c.required - c.planned),
    })).sort((a, b) => a.stage_sort_order - b.stage_sort_order || a.style_name.localeCompare(b.style_name));

    const stageTotals = [...stageTotalsMap.values()].sort((a, b) => a.stage_sort_order - b.stage_sort_order);

    const grandTotal = stageTotals.reduce(
      (acc, s) => ({ required: acc.required + s.required, planned: acc.planned + s.planned, completed: acc.completed + s.completed }),
      { required: 0, planned: 0, completed: 0 }
    );

    res.json({ matrix, stage_totals: stageTotals, grand_total: grandTotal, needs_classification_count: needsClassificationCount });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Inspiration library (Previous Winning Ads) -- historical reference only,
// never itself a production job. Not scoped to one promotion: a Winter
// Sale winner is useful reference for Black Friday, Boxing Day, or any
// future sale alike.
// ---------------------------------------------------------------------
router.get('/inspiration', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ci.*, cs.name AS style_name FROM creative_inspiration ci
       LEFT JOIN creative_styles cs ON cs.id = ci.creative_style_id
       ORDER BY ci.created_at DESC`
    );
    res.json({ inspiration: result.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/inspiration', async (req, res, next) => {
  try {
    const { title, campaign_name, creative_style_id, media_type, video_url, notes } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
    if (media_type !== undefined && media_type !== null && !['graphic', 'video'].includes(media_type)) {
      return res.status(400).json({ error: 'media_type must be graphic or video' });
    }
    const result = await pool.query(
      `INSERT INTO creative_inspiration (title, campaign_name, creative_style_id, media_type, video_url, notes, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [title.trim(), campaign_name || null, creative_style_id || null, media_type || null, video_url || null, notes || null, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.patch('/inspiration/:id', async (req, res, next) => {
  try {
    const { title, campaign_name, creative_style_id, media_type, video_url, notes } = req.body || {};
    if (media_type !== undefined && media_type !== null && !['graphic', 'video'].includes(media_type)) {
      return res.status(400).json({ error: 'media_type must be graphic or video' });
    }
    const result = await pool.query(
      `UPDATE creative_inspiration SET
         title = COALESCE($1, title), campaign_name = COALESCE($2, campaign_name),
         creative_style_id = CASE WHEN $3 THEN $4 ELSE creative_style_id END,
         media_type = COALESCE($5, media_type), video_url = COALESCE($6, video_url), notes = COALESCE($7, notes),
         updated_at = now()
       WHERE id = $8 RETURNING *`,
      [
        title && title.trim() ? title.trim() : null, campaign_name !== undefined ? campaign_name : null,
        Object.prototype.hasOwnProperty.call(req.body || {}, 'creative_style_id'), creative_style_id || null,
        media_type || null, video_url !== undefined ? video_url : null, notes !== undefined ? notes : null,
        req.params.id,
      ]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Inspiration record not found' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/inspiration/:id', async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM creative_inspiration WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Inspiration record not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post('/ideas/:id/inspiration', async (req, res, next) => {
  try {
    const { creative_inspiration_id } = req.body || {};
    if (!creative_inspiration_id) return res.status(400).json({ error: 'creative_inspiration_id is required' });
    await pool.query(
      `INSERT INTO promotion_creative_idea_inspirations (promotion_creative_idea_id, creative_inspiration_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.id, creative_inspiration_id]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/ideas/:id/inspiration/:inspirationId', async (req, res, next) => {
  try {
    await pool.query(
      `DELETE FROM promotion_creative_idea_inspirations WHERE promotion_creative_idea_id = $1 AND creative_inspiration_id = $2`,
      [req.params.id, req.params.inspirationId]
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
