const express = require('express');
const { pool } = require('../db');
const { insertCreativeAsset } = require('../lib/assets');
const { STATUS_LABELS, FORMATS, CONCEPT_ASSIGNEES } = require('../lib/statuses');
const apparelmagic = require('../lib/apparelmagic');
const { fetchAmData } = require('../lib/planningData');

const router = express.Router();
const bust = () => {
  try { require('./weeklyVideoPlan').invalidate(); } catch (e) { /* cache only */ }
  try { require('../lib/planningOpportunitiesLoader').invalidate(); } catch (e) { /* cache only */ }
};
const progressLib = require('../lib/shootPlanProgress');
const selection = require('../lib/shootPlanSelection');
const MAX_CONCEPTS = 10;

const STOCK_STATUSES = ['in_office', 'needs_to_be_brought_in'];
const SOURCES = ['core', 'high_stock', 'drop', 'promotion', 'manual', 'momentum'];
const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

// Same local-date-safety reasoning as shooting.js/editing.js's own dateStr.
function dateStr(d) {
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Makes sure an item has at least `want` live concepts (creative_assets that were not killed): the planning step asked for that many distinct concepts, so each
// is its own Concept Development record (counted once, whatever products it is later adapted for). Never removes or renames an existing concept.
async function ensureConcepts(client, item, want, { baseName, creator, createdByUserId, conceptType, assignee, editingOwner, format, plannedStyleIds = null }) {
  const have = (await client.query("SELECT count(*)::int AS n FROM creative_assets WHERE shoot_plan_item_id = $1 AND concept_dev_status <> 'killed'", [item.id])).rows[0].n;
  if (have >= want) return 0;
  const firstStyle = (await client.query('SELECT style_id FROM shoot_plan_item_styles WHERE shoot_plan_item_id = $1 ORDER BY style_id LIMIT 1', [item.id])).rows[0];
  let made = 0;
  for (let n = have + 1; n <= want; n += 1) {
    const a = await insertCreativeAsset(client, {
      style_id: firstStyle ? firstStyle.style_id : null, concept_name: `${baseName} (${n})`, concept_classification: 'new_experimental', format: FORMATS.includes(format) ? format : 'video',
      strategy_owner: creator, status: 'awaiting_concept_development', created_by_user_id: createdByUserId, concept_type: conceptType || null, concept_assignee: assignee || null, editing_owner: editingOwner || null,
    });
    await client.query('UPDATE creative_assets SET shoot_plan_item_id = $1, planned_style_ids = $3::int[] WHERE id = $2', [item.id, a.id, plannedStyleIds && plannedStyleIds.length ? plannedStyleIds : null]);
    made += 1;
  }
  return made;
}

router.get('/', async (req, res, next) => {
  try {
    const weekStart = req.query.week_start;
    if (weekStart !== undefined && !WEEK_RE.test(weekStart)) {
      return res.status(400).json({ error: 'week_start must be YYYY-MM-DD' });
    }

    const itemsResult = await pool.query(
      `SELECT spi.*, ${selection.autoLinkedSql('spi')} AS auto_linked, ca.status AS asset_status, p.id AS promotion_id, p.name AS promotion_name, ps.name AS promotion_stage_name,
              (SELECT count(*)::int FROM creative_assets c2 WHERE c2.shoot_plan_item_id = spi.id AND c2.format = 'video') AS video_assets,
              (SELECT count(*)::int FROM creative_assets c2 WHERE c2.shoot_plan_item_id = spi.id AND c2.format = 'video' AND c2.status IN ('filming', 'editing', 'qc')) AS videos_in_production,
              (SELECT count(*)::int FROM creative_assets c2 WHERE c2.shoot_plan_item_id = spi.id AND c2.format = 'video' AND c2.status = 'uploaded_live') AS videos_completed
       FROM shoot_plan_items spi
       LEFT JOIN creative_assets ca ON ca.id = spi.asset_id
       LEFT JOIN promotion_stages ps ON ps.id = spi.promotion_stage_id
       LEFT JOIN promotions p ON p.id = ps.promotion_id
       WHERE spi.week_start = COALESCE($1::date, date_trunc('week', now())::date)
       ORDER BY spi.created_at ASC`,
      [weekStart || null]
    );
    const items = itemsResult.rows;

    const stylesResult = items.length
      ? await pool.query(
          `SELECT spis.shoot_plan_item_id, s.id AS style_id, s.style_code, spis.size, spis.colour_label
           FROM shoot_plan_item_styles spis
           JOIN styles s ON s.id = spis.style_id
           WHERE spis.shoot_plan_item_id = ANY($1::int[])`,
          [items.map((i) => i.id)]
        )
      : { rows: [] };
    // Same size-range lookup the "Shoot This Week" modal itself uses --
    // lets Edit Sizes offer the real dropdown of valid sizes for a style
    // instead of a free-text field. resolveStyleSizing is null-safe, so
    // this degrades to an empty list (free-text fallback) when AM isn't
    // configured or a style isn't resolvable, same as everywhere else.
    const am = await fetchAmData();
    const stylesByItem = new Map();
    // A separate FRONT picture, only when ApparelMagic holds one that is labelled as the front (and a different one as the back). WNDRR's normal catalogue picture is a single
    // front-and-back composite, which the screens crop to one view (UX.garmentFit); an individual front picture needs no cropping.
    const frontByItem = new Map();
    for (const row of stylesResult.rows) {
      if (!stylesByItem.has(row.shoot_plan_item_id)) stylesByItem.set(row.shoot_plan_item_id, []);
      const sizing = apparelmagic.resolveStyleSizing(am.amDetails, am.amSizeRanges, row.style_code);
      if (!frontByItem.has(row.shoot_plan_item_id)) {
        const d = am.amDetails && am.amDetails.get(row.style_code);
        const pick = d && d.images ? apparelmagic.pickFrontBack(d.images) : null;
        if (pick && pick.layout === 'front_back' && pick.front) frontByItem.set(row.shoot_plan_item_id, pick.front.url);
      }
      stylesByItem.get(row.shoot_plan_item_id).push({
        style_id: row.style_id,
        style_code: row.style_code,
        size: row.size,
        colour_label: row.colour_label,
        sizes: sizing.sizes,
        sizing_system: sizing.system,
      });
    }

    res.json(items.map((i) => ({
      id: i.id,
      product_code: i.product_code,
      product_name: i.product_name,
      stock_status: i.stock_status,
      creator: i.creator,
      quick_note: i.initial_idea,
      shoot_notes: i.shoot_notes || null,
      created_at: i.created_at,
      week_start: i.week_start,
      asset_id: i.asset_id,
      asset_status: i.asset_status,
      asset_status_label: i.asset_status ? (STATUS_LABELS[i.asset_status] || i.asset_status) : null,
      source: i.source,
      auto_linked: !!i.auto_linked,
      planned_videos: Math.max(i.planned_videos || 1, i.video_assets || 0),
      planned_videos_set: i.planned_videos || 1,
      video_assets: i.video_assets || 0,
      videos_in_production: i.videos_in_production || 0,
      videos_completed: i.videos_completed || 0,
      recommended_videos: i.recommended_videos,
      video_mix: i.video_mix || null,
      recommendation_snapshot: i.recommendation_snapshot || null,
      image_url: i.image_url,
      promotion_stage_id: i.promotion_stage_id,
      promotion_id: i.promotion_id,
      promotion_name: i.promotion_name,
      promotion_stage_name: i.promotion_stage_name,
      front_image_url: frontByItem.get(i.id) || null,
      styles: stylesByItem.get(i.id) || [],
    })));
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const {
    product_code, product_name, colourways, stock_status, creator, quick_note, source, image_url,
    promotion_stage_id, week_start, format, concept_name, concept_type, concept_assignee, editing_owner,
    videos, recommended_videos, video_mix, recommendation_snapshot,
  } = req.body || {};
  // Batch 14: the team plans CONCEPTS (distinct creative ideas), not videos. `concepts` is the number of distinct concepts to start for this product now (each is
  // its own Concept Development record); `videos` is the older name for the same number and is still accepted.
  const rawConcepts = req.body && req.body.concepts !== undefined && req.body.concepts !== null ? req.body.concepts : videos;
  const requestedVideos = rawConcepts === undefined || rawConcepts === null ? 1 : Number(rawConcepts);
  // Batch 30: `additional: true` means "this many MORE concepts for a product that is already planned this week" (the count is added to the live concepts, never a duplicate of one that exists)
  const additional = !!(req.body && req.body.additional === true);
  if (!Number.isInteger(requestedVideos) || requestedVideos < 1 || requestedVideos > MAX_CONCEPTS) {
    return res.status(400).json({ error: `concepts must be a whole number from 1 to ${MAX_CONCEPTS}` });
  }
  if (recommended_videos !== undefined && recommended_videos !== null && (!Number.isInteger(Number(recommended_videos)) || Number(recommended_videos) < 0 || Number(recommended_videos) > 50)) {
    return res.status(400).json({ error: 'recommended_videos must be a whole number from 0 to 50' });
  }
  if (video_mix !== undefined && video_mix !== null && !Array.isArray(video_mix)) return res.status(400).json({ error: 'video_mix must be a list' });

  // Product is now optional everywhere this route is called from -- Core/
  // High Stock/Drop's own pickers still always supply one (their UI never
  // lets you skip it), but a Promotion concept genuinely may need none (see
  // schema.sql's comment on creative_assets.style_id / shoot_plan_items.
  // product_code/product_name going nullable). colourways defaults to an
  // empty list rather than being required; an empty shoot_plan_item_styles
  // set is exactly how "No products required" is represented downstream.
  const trimmedColourways = Array.isArray(colourways) ? colourways : [];
  if (!trimmedColourways.every((c) => c && Number.isFinite(Number(c.style_id)))) {
    return res.status(400).json({ error: 'Every selected colourway must have a valid style_id' });
  }
  if (stock_status !== undefined && stock_status !== null && !STOCK_STATUSES.includes(stock_status)) {
    return res.status(400).json({ error: 'stock_status must be in_office or needs_to_be_brought_in' });
  }
  if (!creator || !creator.trim()) {
    return res.status(400).json({ error: 'Content creator is required' });
  }
  if (source !== undefined && source !== null && !SOURCES.includes(source)) {
    return res.status(400).json({ error: `source must be one of ${SOURCES.join(', ')}` });
  }
  if (week_start !== undefined && week_start !== null && !WEEK_RE.test(week_start)) {
    return res.status(400).json({ error: 'week_start must be YYYY-MM-DD' });
  }
  if (format !== undefined && format !== null && !FORMATS.includes(format)) {
    return res.status(400).json({ error: `format must be one of ${FORMATS.join(', ')}` });
  }
  if (concept_assignee !== undefined && concept_assignee !== null && !CONCEPT_ASSIGNEES.includes(concept_assignee)) {
    return res.status(400).json({ error: `concept_assignee must be one of: ${CONCEPT_ASSIGNEES.join(', ')}, or null` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (promotion_stage_id) {
      const stage = await client.query('SELECT id FROM promotion_stages WHERE id = $1', [promotion_stage_id]);
      if (!stage.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'promotion_stage_id does not reference a real stage' });
      }
    }

    // The same product selected again this week (from Core, High Stocks or by hand) is ONE production record, never a duplicate: the existing item keeps
    // its concept and gains any new colourways, and its planned video count is raised to the number asked for (never lowered here: PATCH /:id/videos is
    // the explicit way to change a quantity). Drops and Promotions keep their own items and workflows.
    const DEDUPE_SOURCES = [null, undefined, 'core', 'high_stock', 'manual', 'momentum'];
    if (product_code && !promotion_stage_id && DEDUPE_SOURCES.includes(source)) {
      const existing = await client.query(
        `SELECT * FROM shoot_plan_items WHERE product_code = $1 AND week_start = COALESCE($2::date, date_trunc('week', now())::date) AND promotion_stage_id IS NULL
            AND (source IS NULL OR source IN ('core', 'high_stock', 'manual', 'momentum')) ORDER BY id LIMIT 1 FOR UPDATE`, [product_code, week_start || null]);
      if (existing.rows.length) {
        const ex = existing.rows[0];
        const haveNow = additional ? (await client.query("SELECT count(*)::int AS n FROM creative_assets WHERE shoot_plan_item_id = $1 AND concept_dev_status <> 'killed'", [ex.id])).rows[0].n : 0;
        const wantTotal = additional ? haveNow + requestedVideos : requestedVideos;
        const raised = Math.max(ex.planned_videos || 1, wantTotal);
        await client.query('UPDATE shoot_plan_items SET planned_videos = $1, recommended_videos = COALESCE($2, recommended_videos), video_mix = COALESCE($3::jsonb, video_mix), recommendation_snapshot = COALESCE($4::jsonb, recommendation_snapshot) WHERE id = $5',
          [raised, recommended_videos === undefined ? null : recommended_videos, video_mix ? JSON.stringify(video_mix) : null, recommendation_snapshot ? JSON.stringify(recommendation_snapshot) : null, ex.id]);
        for (const c of trimmedColourways) {
          await client.query(`INSERT INTO shoot_plan_item_styles (shoot_plan_item_id, style_id, size, colour_label) VALUES ($1, $2, $3, $4) ON CONFLICT (shoot_plan_item_id, style_id) DO NOTHING`,
            [ex.id, Number(c.style_id), c.size && String(c.size).trim() ? String(c.size).trim() : null, c.colour_label || null]);
        }
        {
          const baseName = (concept_name && concept_name.trim()) || (quick_note && quick_note.trim()) || (product_name ? `New Concept — ${product_name}` : 'New Concept');
          const cu = await client.query('SELECT user_id FROM content_creators WHERE LOWER(name) = LOWER($1) AND user_id IS NOT NULL', [creator.trim()]);
          await ensureConcepts(client, ex, wantTotal, { plannedStyleIds: trimmedColourways.map((c) => Number(c.style_id)), baseName, creator: creator.trim(), createdByUserId: cu.rows[0] ? cu.rows[0].user_id : null, conceptType: concept_type, assignee: concept_assignee, editingOwner: editing_owner, format });
        }
        await client.query('COMMIT'); bust();
        const refreshed = (await pool.query('SELECT * FROM shoot_plan_items WHERE id = $1', [ex.id])).rows[0];
        return res.status(200).json({ ...refreshed, quick_note: refreshed.initial_idea, asset_id: refreshed.asset_id, merged: true, message: 'This product was already in this week\'s Shoot Plan: its video count was updated instead of adding a duplicate.' });
      }
    }

    const trimmedCreator = creator.trim();
    const trimmedNote = quick_note && quick_note.trim() ? quick_note.trim() : null;
    // Concept Name / Idea takes priority when supplied explicitly (the
    // Promotion concept-first flow always sends this); Core/High Stock/Drop
    // keep their existing quick_note-or-product-name fallback unchanged.
    const trimmedConceptName = concept_name && concept_name.trim() ? concept_name.trim() : null;
    const resolvedConceptName = trimmedConceptName || trimmedNote
      || (product_name ? `New Concept — ${product_name}` : (concept_type || 'New Concept'));
    const trimmedConceptType = concept_type && concept_type.trim() ? concept_type.trim() : null;

    // The Creator field is who's actually assigned to shoot this -- picked
    // from the dropdown, not necessarily the logged-in person filling out
    // the form -- so it's resolved to a real user by name match (via the
    // linked content_creators row, see schema.sql), not from req.user.
    const creatorUserResult = await client.query(
      `SELECT user_id FROM content_creators WHERE LOWER(name) = LOWER($1) AND user_id IS NOT NULL`,
      [trimmedCreator]
    );
    const createdByUserId = creatorUserResult.rows[0] ? creatorUserResult.rows[0].user_id : null;

    const asset = await insertCreativeAsset(client, {
      style_id: trimmedColourways.length ? Number(trimmedColourways[0].style_id) : null,
      concept_name: resolvedConceptName,
      concept_classification: 'new_experimental',
      format: FORMATS.includes(format) ? format : 'video',
      strategy_owner: trimmedCreator,
      status: 'awaiting_concept_development',
      created_by_user_id: createdByUserId,
      concept_type: trimmedConceptType,
      concept_assignee: concept_assignee || null,
      editing_owner: editing_owner || null,
    });

    const itemResult = await client.query(
      `INSERT INTO shoot_plan_items (product_code, product_name, stock_status, creator, initial_idea, asset_id, source, image_url, promotion_stage_id, week_start, created_by_user_id, planned_videos, recommended_videos, video_mix, recommendation_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::date, date_trunc('week', now())::date), $11, $12, $13, $14::jsonb, $15::jsonb) RETURNING *`,
      [
        product_code || null,
        product_name || null,
        STOCK_STATUSES.includes(stock_status) ? stock_status : 'needs_to_be_brought_in',
        trimmedCreator,
        trimmedNote,
        asset.id,
        source || null,
        image_url || null,
        promotion_stage_id || null,
        week_start || null,
        createdByUserId,
        requestedVideos,
        recommended_videos === undefined ? null : recommended_videos,
        video_mix ? JSON.stringify(video_mix) : null,
        recommendation_snapshot ? JSON.stringify(recommendation_snapshot) : null,
      ]
    );
    const item = itemResult.rows[0];

    // Links the seed concept back to this handoff item -- Concept
    // Development scopes a Core/High Stock/Promotion product's concepts to
    // exactly this shoot_plan_item, not every historical asset ever made
    // for the style.
    await client.query('UPDATE creative_assets SET shoot_plan_item_id = $1, planned_style_ids = $3::int[] WHERE id = $2', [item.id, asset.id, trimmedColourways.length ? trimmedColourways.map((c) => Number(c.style_id)) : null]);

    for (const c of trimmedColourways) {
      await client.query(
        `INSERT INTO shoot_plan_item_styles (shoot_plan_item_id, style_id, size, colour_label) VALUES ($1, $2, $3, $4)`,
        [item.id, Number(c.style_id), c.size && String(c.size).trim() ? String(c.size).trim() : null, c.colour_label || null]
      );
    }

    await ensureConcepts(client, item, requestedVideos, { plannedStyleIds: trimmedColourways.map((c) => Number(c.style_id)), baseName: resolvedConceptName, creator: trimmedCreator, createdByUserId, conceptType: trimmedConceptType, assignee: concept_assignee, editingOwner: editing_owner, format });
    await client.query('COMMIT'); bust();
    res.status(201).json({
      ...item,
      quick_note: item.initial_idea,
      asset_status: asset.status,
      asset_status_label: STATUS_LABELS[asset.status] || asset.status,
      asset_id: asset.id,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// Lets a colourway's pull-list size be corrected in place (e.g. after a
// quick "+ Shoot This Week" add with the wrong size) without removing and
// re-adding the whole product.
router.patch('/:itemId/styles/:styleId', async (req, res, next) => {
  try {
    const itemId = Number(req.params.itemId);
    const styleId = Number(req.params.styleId);
    if (!Number.isFinite(itemId) || !Number.isFinite(styleId)) {
      return res.status(400).json({ error: 'Invalid item or style id' });
    }
    const size = req.body && typeof req.body.size === 'string' && req.body.size.trim() ? req.body.size.trim() : null;
    const result = await pool.query(
      `UPDATE shoot_plan_item_styles SET size = $1 WHERE shoot_plan_item_id = $2 AND style_id = $3 RETURNING *`,
      [size, itemId, styleId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Shoot plan colourway not found' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Styles Needed (Concept Development): add one product/colourway to an
// existing shoot_plan_item after its concept already exists -- an execution
// requirement only (see schema.sql's comment on style_id/product_code going
// nullable), never touching the concept's identity. ON CONFLICT DO NOTHING
// mirrors the PK (shoot_plan_item_id, style_id): the same style can't be
// added twice to one item, same as the original "Shoot This Week" picker.
router.post('/:itemId/styles', async (req, res, next) => {
  try {
    const itemId = Number(req.params.itemId);
    if (!Number.isFinite(itemId)) return res.status(400).json({ error: 'Invalid item id' });
    const { style_id, size, colour_label } = req.body || {};
    const styleId = Number(style_id);
    if (!Number.isFinite(styleId)) return res.status(400).json({ error: 'style_id is required' });

    const itemResult = await pool.query('SELECT id FROM shoot_plan_items WHERE id = $1', [itemId]);
    if (!itemResult.rows.length) return res.status(404).json({ error: 'Shoot plan item not found' });

    const result = await pool.query(
      `INSERT INTO shoot_plan_item_styles (shoot_plan_item_id, style_id, size, colour_label)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (shoot_plan_item_id, style_id) DO NOTHING RETURNING *`,
      [itemId, styleId, size && String(size).trim() ? String(size).trim() : null, colour_label || null]
    );
    if (!result.rows.length) return res.status(409).json({ error: 'That product is already in Styles Needed for this concept' });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ error: 'style_id does not reference a real style' });
    next(err);
  }
});

// Removing the last/only style leaves an empty shoot_plan_item_styles set --
// exactly how "No products required" is represented (see schema.sql), so no
// special-casing is needed here for going back down to zero.
router.delete('/:itemId/styles/:styleId', async (req, res, next) => {
  try {
    const itemId = Number(req.params.itemId);
    const styleId = Number(req.params.styleId);
    if (!Number.isFinite(itemId) || !Number.isFinite(styleId)) {
      return res.status(400).json({ error: 'Invalid item or style id' });
    }
    const result = await pool.query(
      `DELETE FROM shoot_plan_item_styles WHERE shoot_plan_item_id = $1 AND style_id = $2 RETURNING style_id`,
      [itemId, styleId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Shoot plan colourway not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// The two fields the Shoot Plan page edits in place on a product card: who shoots it and the short shoot notes. Only what is sent changes. Past weeks are a read-only record.
const SHOOT_NOTES_MAX = 1000;
router.patch('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid item id' });
    const body = req.body || {};
    const hasCreator = Object.prototype.hasOwnProperty.call(body, 'creator');
    const hasNotes = Object.prototype.hasOwnProperty.call(body, 'shoot_notes');
    if (!hasCreator && !hasNotes) return res.status(400).json({ error: 'Send creator and/or shoot_notes' });
    const creator = hasCreator ? String(body.creator == null ? '' : body.creator).trim() : null;
    if (hasCreator && (!creator || creator.length > 255)) return res.status(400).json({ error: 'The shoot owner is required' });
    const notes = hasNotes ? (body.shoot_notes == null ? '' : String(body.shoot_notes)).trim() : null;
    if (hasNotes && notes.length > SHOOT_NOTES_MAX) return res.status(400).json({ error: `Shoot notes can be up to ${SHOOT_NOTES_MAX} characters` });
    const cur = (await pool.query("SELECT (week_start < date_trunc('week', now())::date) AS past FROM shoot_plan_items WHERE id = $1", [id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Shoot plan item not found' });
    if (cur.past) return res.status(409).json({ error: 'A past week is a read-only record.' });
    const result = await pool.query(
      `UPDATE shoot_plan_items SET creator = CASE WHEN $2 THEN $3 ELSE creator END, shoot_notes = CASE WHEN $4 THEN NULLIF($5, '') ELSE shoot_notes END WHERE id = $1 RETURNING id, creator, shoot_notes`,
      [id, hasCreator, creator, hasNotes, notes]
    );
    bust();
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Change how many VIDEOS a plan item plans (and, optionally, its creative mix). Existing work is never silently cancelled: the number cannot go below the video
// concepts that already exist for this item (remove those concepts in Concept Development first). Editing a past week is not allowed.
router.patch('/:id/videos', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid item id' });
    const body = req.body || {};
    const hasVideos = body.videos !== undefined;
    if (hasVideos && (!Number.isInteger(Number(body.videos)) || Number(body.videos) < 1 || Number(body.videos) > 50)) return res.status(400).json({ error: 'videos must be a whole number from 1 to 50' });
    if (body.video_mix !== undefined && body.video_mix !== null && !Array.isArray(body.video_mix)) return res.status(400).json({ error: 'video_mix must be a list' });
    const itemResult = await pool.query(
      `SELECT spi.*, (SELECT count(*)::int FROM creative_assets c WHERE c.shoot_plan_item_id = spi.id AND c.format = 'video') AS video_assets,
              (spi.week_start < date_trunc('week', now())::date) AS past
         FROM shoot_plan_items spi WHERE spi.id = $1`, [id]);
    if (!itemResult.rows.length) return res.status(404).json({ error: 'Shoot plan item not found' });
    const it = itemResult.rows[0];
    if (it.past) return res.status(409).json({ error: 'A past week is a read-only record.' });
    if (hasVideos && Number(body.videos) < it.video_assets) {
      return res.status(409).json({ error: `${it.video_assets} video concept${it.video_assets === 1 ? '' : 's'} already exist for this product this week, so the plan cannot go below ${it.video_assets}. Remove a concept in Concept Development first if it should be cancelled.` });
    }
    const result = await pool.query(
      `UPDATE shoot_plan_items SET planned_videos = COALESCE($1, planned_videos), video_mix = CASE WHEN $2::boolean THEN $3::jsonb ELSE video_mix END WHERE id = $4 RETURNING *`,
      [hasVideos ? Number(body.videos) : null, body.video_mix !== undefined, body.video_mix ? JSON.stringify(body.video_mix) : null, id]);
    bust();
    res.json({ ...result.rows[0], week_start: dateStr(result.rows[0].week_start), video_assets: it.video_assets, planned_videos: Math.max(result.rows[0].planned_videos, it.video_assets) });
  } catch (err) {
    next(err);
  }
});

// Lets a Promotion concept's planned Shoot Week be changed after creation
// (see the Shoot Week brief, section 1: "production plans change") --
// scoped to items that haven't reached Shooting yet (no shoot_schedule row
// on the linked asset). Once a concept is approved and has a real schedule
// entry, moving it is Shooting's own job (drag/move to another week) --
// this field is only the pre-approval plan, not a second scheduling system.
router.patch('/:id/week', async (req, res, next) => {
  try {
    const { week_start } = req.body || {};
    if (!WEEK_RE.test(week_start || '')) {
      return res.status(400).json({ error: 'week_start must be YYYY-MM-DD' });
    }
    const itemResult = await pool.query(
      `SELECT spi.id, spi.asset_id
       FROM shoot_plan_items spi
       WHERE spi.id = $1`,
      [req.params.id]
    );
    if (!itemResult.rows.length) return res.status(404).json({ error: 'Shoot plan item not found' });
    const { asset_id: assetId } = itemResult.rows[0];

    if (assetId) {
      const scheduleResult = await pool.query('SELECT id FROM shoot_schedule WHERE creative_asset_id = $1', [assetId]);
      if (scheduleResult.rows.length) {
        return res.status(409).json({
          error: 'This concept already has a Shooting schedule entry -- reschedule it from Shooting instead of editing its planned Shoot Week here.',
        });
      }
    }

    const result = await pool.query(
      `UPDATE shoot_plan_items SET week_start = $1 WHERE id = $2 RETURNING *`,
      [week_start, req.params.id]
    );
    res.json({ ...result.rows[0], week_start: dateStr(result.rows[0].week_start) });
  } catch (err) {
    next(err);
  }
});

// What removing a plan entry would do (read-only): which concepts exist, and whether any has work on it. The Shoot Plan asks before removing.
router.get('/:id/removal', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid item id' });
    const a = await selection.assessRemoval(pool, id);
    if (!a) return res.status(404).json({ error: 'Shoot plan item not found' });
    res.json({ item_id: id, removable: a.removable, concepts: a.concepts, message: a.blocking.length ? selection.blockingMessage(a) : null });
  } catch (err) {
    next(err);
  }
});

// Remove a product from the week's Shoot Plan. Untouched draft concepts are archived with it (history kept); if any concept already has work on it the plan entry
// stays and the answer (409) says which concept and where to close it. The product record itself is never touched. Past weeks are a read-only record.
router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid item id' });
    const week = (await pool.query("SELECT (week_start < date_trunc('week', now())::date) AS past FROM shoot_plan_items WHERE id = $1", [id])).rows[0];
    if (!week) return res.status(404).json({ error: 'Shoot plan item not found' });
    if (week.past) return res.status(409).json({ error: 'A past week is a read-only record.' });
    const lifecycle = require('../lib/conceptLifecycle');
    const out = await selection.removeSelection(pool, id, (conceptId, reason) => lifecycle.applyAction(conceptId, 'archive', req.user, { reason }));
    bust();
    res.json(out);
  } catch (err) {
    if (err instanceof selection.RemovalError) return res.status(err.status).json({ error: err.message, blocking: err.blocking || undefined });
    next(err);
  }
});


// ── Batch 14: weekly CONCEPT progress + adapting one concept for several products ─────────────────────────────────────────────────────────────────────────────
// Read-only: derived from the production records that already exist (see lib/shootPlanProgress.js for exactly what is counted and how a stage is decided).
router.get('/progress', async (req, res, next) => {
  try {
    const week = req.query.week_start;
    if (week !== undefined && !WEEK_RE.test(week)) return res.status(400).json({ error: 'week_start must be YYYY-MM-DD' });
    const ymdNow = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
    const weekStart = week || require('../lib/planningOpportunitiesLoader').mondayOf(ymdNow);
    const t = (await pool.query('SELECT weekly_new_concept_target AS t FROM planning_settings WHERE id = 1')).rows[0];
    const target = t && Number.isInteger(t.t) ? t.t : 15;
    res.json(await progressLib.loadWeeklyProgress(pool, weekStart, { target }));
  } catch (err) { next(err); }
});

// Adds more distinct concepts to a product already in the Shoot Plan (each is its own Concept Development record; nothing existing is changed).
router.post('/:id/concepts', async (req, res, next) => {
  const count = Number((req.body || {}).count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_CONCEPTS) return res.status(400).json({ error: `count must be a whole number from 1 to ${MAX_CONCEPTS}` });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const item = (await client.query('SELECT * FROM shoot_plan_items WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!item) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Shoot Plan item not found' }); }
    const have = (await client.query("SELECT count(*)::int AS n FROM creative_assets WHERE shoot_plan_item_id = $1 AND concept_dev_status <> 'killed'", [item.id])).rows[0].n;
    const cu = await client.query('SELECT user_id FROM content_creators WHERE LOWER(name) = LOWER($1) AND user_id IS NOT NULL', [item.creator || '']);
    const made = await ensureConcepts(client, item, have + count, { baseName: item.product_name ? `New Concept — ${item.product_name}` : 'New Concept', creator: item.creator, createdByUserId: cu.rows[0] ? cu.rows[0].user_id : null, format: 'video' });
    await client.query('UPDATE shoot_plan_items SET planned_videos = GREATEST(planned_videos, $1) WHERE id = $2', [have + made, item.id]);
    await client.query('COMMIT'); bust();
    res.status(201).json({ item_id: item.id, added: made, concepts: have + made });
  } catch (err) { await client.query('ROLLBACK'); next(err); } finally { client.release(); }
});

// One concept adapted for another product: the concept stays ONE record (and one count); this records the extra product so both products show the concept.
router.post('/concepts/:id/products', async (req, res, next) => {
  try {
    const { product_code, product_name, shoot_plan_item_id, reason } = req.body || {};
    const link = await progressLib.linkConceptToProduct(pool, { assetId: Number(req.params.id), productCode: product_code, productName: product_name, shootPlanItemId: shoot_plan_item_id || null, reason: reason || null, userId: req.user && req.user.id });
    bust();
    res.status(201).json(link);
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});
router.delete('/concepts/:id/products/:productCode', async (req, res, next) => {
  try {
    const n = await progressLib.unlinkConceptProduct(pool, { assetId: Number(req.params.id), productCode: req.params.productCode });
    bust();
    res.json({ removed: n });
  } catch (err) { next(err); }
});

router.ensureConcepts = ensureConcepts; // exported for tests (a fake client proves the concept / colourway rules without a database)
module.exports = router;
