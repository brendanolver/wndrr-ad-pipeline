// Black Friday 2026 creative-style matrix, progress, ideas, and inspiration
// library -- extends the EXISTING Promotion/Campaign Stage system
// (promotions/promotion_stages/shoot_plan_items.promotion_stage_id), never
// a parallel Black Friday application. See db/schema.sql's header comment
// on this feature for the full table layout.
const express = require('express');
const { pool } = require('../db');
const { STATUSES } = require('../lib/statuses');
const { insertCreativeAsset } = require('../lib/assets');

const router = express.Router();

// ---------------------------------------------------------------------
// Idea "production stage" -- derived, never stored (see the brief: status
// must come from the real pipeline record, not a second lifecycle a human
// has to keep in sync). Checked latest-first so a concept always lands in
// the furthest stage it's actually reached. Mirrors the same underlying
// signals routes/moveBack.js already uses to detect a concept's current
// stage, just shaped into the simpler 7-rung ladder the brief asks for.
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

// One shared loader for every idea-list endpoint: ideas + their linked
// concept's real pipeline signals + inspiration links, all in a handful of
// batched queries rather than N+1.
async function loadIdeasForPromotion(promotionId) {
  const ideasResult = await pool.query(
    `SELECT pci.*, ps.name AS stage_name, cs.name AS style_name, cs.media_type
     FROM promotion_creative_ideas pci
     LEFT JOIN promotion_stages ps ON ps.id = pci.promotion_stage_id
     LEFT JOIN creative_styles cs ON cs.id = pci.creative_style_id
     WHERE pci.promotion_id = $1
     ORDER BY pci.created_at ASC`,
    [promotionId]
  );
  const ideas = ideasResult.rows;
  const assetIds = ideas.map((i) => i.linked_creative_asset_id).filter(Boolean);

  const conceptsById = new Map();
  const schedulesByAssetId = new Map();
  if (assetIds.length) {
    const conceptsResult = await pool.query(
      `SELECT id, concept_name, status, concept_dev_status, editing_submitted_at, final_approval_status
       FROM creative_assets WHERE id = ANY($1::int[])`,
      [assetIds]
    );
    for (const row of conceptsResult.rows) conceptsById.set(row.id, row);

    const schedulesResult = await pool.query(
      `SELECT creative_asset_id, status, ready_for_editing FROM shoot_schedule WHERE creative_asset_id = ANY($1::int[])`,
      [assetIds]
    );
    for (const row of schedulesResult.rows) schedulesByAssetId.set(row.creative_asset_id, row);
  }

  const ideaIds = ideas.map((i) => i.id);
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
    const concept = idea.linked_creative_asset_id ? conceptsById.get(idea.linked_creative_asset_id) : null;
    const schedule = idea.linked_creative_asset_id ? schedulesByAssetId.get(idea.linked_creative_asset_id) : null;
    const stage = deriveIdeaStage(concept, schedule);
    return {
      ...idea,
      linked_concept_name: concept ? concept.concept_name : null,
      production_stage: stage,
      production_stage_label: IDEA_STAGE_LABELS[stage],
      is_completed: stage === 'completed',
      inspiration: inspirationByIdea.get(idea.id) || [],
    };
  });
}

router.get('/:promotionId/ideas', async (req, res, next) => {
  try {
    const ideas = await loadIdeasForPromotion(req.params.promotionId);
    res.json({ ideas });
  } catch (err) {
    next(err);
  }
});

router.post('/:promotionId/ideas', async (req, res, next) => {
  try {
    const { title, promotion_stage_id, creative_style_id, who, where_text, concept_script, need_text, reference_note } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
    const result = await pool.query(
      `INSERT INTO promotion_creative_ideas
        (promotion_id, promotion_stage_id, creative_style_id, title, who, where_text, concept_script, need_text, reference_note, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        req.params.promotionId, promotion_stage_id || null, creative_style_id || null, title.trim(),
        who || null, where_text || null, concept_script || null, need_text || null, reference_note || null,
        req.user.id,
      ]
    );
    const [idea] = await loadIdeasForPromotion(req.params.promotionId).then((rows) => rows.filter((r) => r.id === result.rows[0].id));
    res.status(201).json(idea);
  } catch (err) {
    next(err);
  }
});

// The one place every editable idea field is written, including
// linked_creative_asset_id -- so an idea can be pointed at an
// ALREADY-EXISTING concept (see the brief, item 4: "If an existing
// concept/creative record can be linked, link it") without going through
// the create-new-concept path at all.
router.patch('/ideas/:id', async (req, res, next) => {
  try {
    const existing = await pool.query('SELECT * FROM promotion_creative_ideas WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Idea not found' });
    const current = existing.rows[0];

    const {
      title, promotion_stage_id, creative_style_id, who, where_text, concept_script, need_text,
      reference_note, linked_creative_asset_id,
    } = req.body || {};

    if (linked_creative_asset_id !== undefined && linked_creative_asset_id !== null) {
      const assetCheck = await pool.query('SELECT id FROM creative_assets WHERE id = $1', [linked_creative_asset_id]);
      if (!assetCheck.rows.length) return res.status(400).json({ error: 'linked_creative_asset_id does not reference a real concept' });
    }

    const hasLinkedField = Object.prototype.hasOwnProperty.call(req.body || {}, 'linked_creative_asset_id');

    const result = await pool.query(
      `UPDATE promotion_creative_ideas SET
         title = COALESCE($1, title),
         promotion_stage_id = CASE WHEN $2 THEN $3 ELSE promotion_stage_id END,
         creative_style_id = CASE WHEN $4 THEN $5 ELSE creative_style_id END,
         who = COALESCE($6, who),
         where_text = COALESCE($7, where_text),
         concept_script = COALESCE($8, concept_script),
         need_text = COALESCE($9, need_text),
         reference_note = COALESCE($10, reference_note),
         linked_creative_asset_id = CASE WHEN $11 THEN $12 ELSE linked_creative_asset_id END,
         updated_at = now()
       WHERE id = $13 RETURNING promotion_id`,
      [
        title && title.trim() ? title.trim() : null,
        Object.prototype.hasOwnProperty.call(req.body || {}, 'promotion_stage_id'), promotion_stage_id || null,
        Object.prototype.hasOwnProperty.call(req.body || {}, 'creative_style_id'), creative_style_id || null,
        who !== undefined ? who : null, where_text !== undefined ? where_text : null,
        concept_script !== undefined ? concept_script : null, need_text !== undefined ? need_text : null,
        reference_note !== undefined ? reference_note : null,
        hasLinkedField, hasLinkedField ? (linked_creative_asset_id || null) : null,
        req.params.id,
      ]
    );
    const [idea] = await loadIdeasForPromotion(result.rows[0].promotion_id).then((rows) => rows.filter((r) => r.id === Number(req.params.id)));
    res.json(idea);
  } catch (err) {
    next(err);
  }
});

// Deletes only the PLANNING record -- never the linked creative_assets/
// shoot_plan_items/final_edits row, which is real production work that
// lives on independently of whatever planning record pointed at it.
router.delete('/ideas/:id', async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM promotion_creative_ideas WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Idea not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// "Send to Pipeline" -- creates the concept through the SAME entry point
// every other Promotion concept already uses (mirrors savePromotionShootItem's
// POST /shoot-plan call in app.js: source='promotion', promotion_stage_id
// carried over so the existing Concept Dev/Tuesday Review/coverage
// machinery picks it up unchanged). Idempotent: an idea that already has
// linked_creative_asset_id is never sent twice -- this just returns the
// existing link. Graphics use format: 'static', the SAME already-supported
// path every other static Promotion concept uses -- no fake Shooting-skip
// mechanism invented (see the brief's explicit instruction to inspect
// first; this app has no existing way to skip Shooting for any format, so
// building one now would be real pipeline surgery, not a Black-Friday-only
// change).
router.post('/ideas/:id/send-to-pipeline', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const ideaResult = await client.query(
      `SELECT pci.*, cs.media_type FROM promotion_creative_ideas pci
       LEFT JOIN creative_styles cs ON cs.id = pci.creative_style_id
       WHERE pci.id = $1`,
      [req.params.id]
    );
    if (!ideaResult.rows.length) return res.status(404).json({ error: 'Idea not found' });
    const idea = ideaResult.rows[0];
    if (idea.linked_creative_asset_id) {
      return res.json({ ok: true, already_linked: true, creative_asset_id: idea.linked_creative_asset_id });
    }
    if (!idea.promotion_stage_id) return res.status(400).json({ error: 'Assign a Black Friday stage before sending this idea to the pipeline' });

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
      [idea.who || 'Unassigned', idea.concept_script || null, asset.id, idea.promotion_stage_id, req.user.id]
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
// from promotion_creative_targets + promotion_creative_ideas + each idea's
// linked concept's real pipeline state on every call.
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

    // Cell key: "stageId:styleId" -- unions target-matrix cells with any
    // cell that has ideas but no target row, so nothing with real work
    // logged against it ever silently disappears from the view.
    const cells = new Map();
    for (const t of targetsResult.rows) {
      cells.set(`${t.promotion_stage_id}:${t.creative_style_id}`, {
        promotion_stage_id: t.promotion_stage_id, stage_name: t.stage_name, stage_sort_order: t.stage_sort_order,
        creative_style_id: t.creative_style_id, style_name: t.style_name, media_type: t.media_type,
        required: t.required_count, planned: 0, completed: 0,
      });
    }
    for (const idea of ideas) {
      if (!idea.promotion_stage_id || !idea.creative_style_id) continue; // Not yet assigned a stage/style -- doesn't count toward any cell.
      const key = `${idea.promotion_stage_id}:${idea.creative_style_id}`;
      if (!cells.has(key)) {
        cells.set(key, {
          promotion_stage_id: idea.promotion_stage_id, stage_name: idea.stage_name, stage_sort_order: 999,
          creative_style_id: idea.creative_style_id, style_name: idea.style_name, media_type: idea.media_type,
          required: 0, planned: 0, completed: 0,
        });
      }
      const cell = cells.get(key);
      cell.planned += 1;
      if (idea.is_completed) cell.completed += 1;
    }

    const matrix = [...cells.values()].map((c) => ({
      ...c,
      still_to_plan: Math.max(0, c.required - c.planned),
    })).sort((a, b) => a.stage_sort_order - b.stage_sort_order || a.style_name.localeCompare(b.style_name));

    const stageTotalsMap = new Map();
    for (const c of matrix) {
      if (!stageTotalsMap.has(c.promotion_stage_id)) {
        stageTotalsMap.set(c.promotion_stage_id, {
          promotion_stage_id: c.promotion_stage_id, stage_name: c.stage_name, stage_sort_order: c.stage_sort_order,
          required: 0, planned: 0, completed: 0,
        });
      }
      const s = stageTotalsMap.get(c.promotion_stage_id);
      s.required += c.required;
      s.planned += c.planned;
      s.completed += c.completed;
    }
    const stageTotals = [...stageTotalsMap.values()].sort((a, b) => a.stage_sort_order - b.stage_sort_order);

    const grandTotal = matrix.reduce(
      (acc, c) => ({ required: acc.required + c.required, planned: acc.planned + c.planned, completed: acc.completed + c.completed }),
      { required: 0, planned: 0, completed: 0 }
    );

    res.json({ matrix, stage_totals: stageTotals, grand_total: grandTotal });
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
