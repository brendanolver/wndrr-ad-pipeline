const express = require('express');
const { pool } = require('../db');
const {
  weekCode, detectAdCategory, detectPromotionStageType, splitProductName, shortenHook, buildMetaAdName,
} = require('../lib/adSetupNaming');
const { generateCopyDrafts, defaultCta } = require('../lib/adCopyDraft');
const { deriveCopyRule, mayAutoApply } = require('../lib/adCopyRules');

const router = express.Router();

// ---------------------------------------------------------------------
// Shared context builder -- everything an Ad Setup row needs to prefill
// itself and its copy drafts, gathered from the SAME canonical rows
// Concept Development/Shooting/Editing already populate. Never touches
// Meta; purely internal reads.
// ---------------------------------------------------------------------
async function loadContext(client, finalEditId) {
  const feResult = await client.query(
    `SELECT fe.*, ca.id AS creative_asset_id, ca.concept_name, ca.hook, ca.concept_type,
            ca.avatar_why_care, ca.filming_owner, ca.style_id AS ca_style_id,
            ca.shoot_plan_item_id, ca.hook_variations
     FROM final_edits fe
     JOIN creative_assets ca ON ca.id = fe.creative_asset_id
     WHERE fe.id = $1`,
    [finalEditId]
  );
  if (!feResult.rows.length) return null;
  const row = feResult.rows[0];
  // The CONFIRMED hook this specific Final Edit is cutting -- its own
  // variation_text when it was created from a Tuesday-Review-confirmed
  // hook (see finalEditAssetsFromConceptHooks in app.js), falling back to
  // the concept's first confirmed hook for a still-single, not yet
  // hook-tagged Final Edit, and only then the legacy single `hook` column
  // (pre-hook_variations concepts). Never invented here -- if none of
  // these exist, confirmedHook is null and Ad Setup's Hook fields stay
  // blank for a human to fill in, rather than fabricating one.
  const firstConceptHook = (Array.isArray(row.hook_variations) ? row.hook_variations : [])
    .find((h) => h && h.text && h.text.trim());
  row.confirmedHook = (row.variation_text && row.variation_text.trim())
    || (firstConceptHook && firstConceptHook.text.trim())
    || (row.hook && row.hook.trim())
    || null;

  const spiResult = row.shoot_plan_item_id
    ? await client.query('SELECT * FROM shoot_plan_items WHERE id = $1', [row.shoot_plan_item_id])
    : { rows: [] };
  const spi = spiResult.rows[0] || null;

  const styleLinksResult = row.shoot_plan_item_id
    ? await client.query(
        `SELECT s.id, s.style_code, s.name, s.category_id, c.name AS category_name, s.drop_id
         FROM shoot_plan_item_styles spis
         JOIN styles s ON s.id = spis.style_id
         LEFT JOIN categories c ON c.id = s.category_id
         WHERE spis.shoot_plan_item_id = $1`,
        [row.shoot_plan_item_id]
      )
    : { rows: [] };
  let styles = styleLinksResult.rows;
  if (!styles.length && row.ca_style_id) {
    const fallback = await client.query(
      `SELECT s.id, s.style_code, s.name, s.category_id, c.name AS category_name, s.drop_id
       FROM styles s LEFT JOIN categories c ON c.id = s.category_id WHERE s.id = $1`,
      [row.ca_style_id]
    );
    styles = fallback.rows;
  }

  let promotion = null;
  let promotionStage = null;
  if (spi && spi.promotion_stage_id) {
    const stageResult = await client.query(
      `SELECT ps.*, p.name AS promotion_name, p.start_date, p.end_date, p.notes AS promotion_notes, p.verified_offer, p.verified_offer_teaser
       FROM promotion_stages ps JOIN promotions p ON p.id = ps.promotion_id
       WHERE ps.id = $1`,
      [spi.promotion_stage_id]
    );
    if (stageResult.rows.length) {
      promotionStage = stageResult.rows[0];
      promotion = {
        name: promotionStage.promotion_name,
        start_date: promotionStage.start_date,
        end_date: promotionStage.end_date,
        notes: promotionStage.promotion_notes,
        verified_offer: promotionStage.verified_offer,
        verified_offer_teaser: promotionStage.verified_offer_teaser,
      };
    }
  }

  let dropName = null;
  const dropId = styles.find((s) => s.drop_id)?.drop_id;
  if (dropId) {
    const dropResult = await client.query('SELECT name FROM drops WHERE id = $1', [dropId]);
    dropName = dropResult.rows[0]?.name || null;
  }

  return { finalEdit: row, shootPlanItem: spi, styles, promotion, promotionStage, dropName };
}

function saleDatesLabel(promotion) {
  if (!promotion || !promotion.start_date) return null;
  const fmt = (d) => new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  return promotion.end_date ? `${fmt(promotion.start_date)}–${fmt(promotion.end_date)}` : fmt(promotion.start_date);
}

// Product Name + Product Category (see the brief, item 1). Single product:
// split the real style name via splitProductName (canonical product/style
// ID stays exactly as already linked -- this only changes how its name is
// REPRESENTED for Meta naming, never the underlying record). Multi-product
// (a Drop/multi-style concept): unchanged from before -- there's no single
// garment name to split, so Name stays the collective Drop/Promotion label
// and Category stays the distinct-category union (or OTHER).
function deriveProductNameAndCategory(styles, dropName, promotion) {
  if (styles.length === 1) {
    return splitProductName(styles[0].name, styles[0].category_name);
  }
  const name = dropName || (promotion ? promotion.name : null) || (styles.length > 1 ? `${styles.length} Products` : null);
  const distinctCategories = [...new Set(styles.map((s) => s.category_name).filter(Boolean))];
  const category = distinctCategories.length === 1 ? distinctCategories[0] : (distinctCategories.length > 1 ? 'OTHER' : null);
  return { name, category };
}

function deriveUrlLinkPage(adCategory, styles) {
  if (adCategory === 'promotion') return 'sale_bundle';
  if (styles.length > 1) return 'new_arrivals';
  if (adCategory === 'new_drop') return 'new_arrivals';
  return 'product';
}

function copyContextFromLoaded(ctx, adCategory, stageType) {
  const { name, category } = deriveProductNameAndCategory(ctx.styles, ctx.dropName, ctx.promotion);
  return {
    hook: ctx.finalEdit.confirmedHook,
    conceptLabel: ctx.finalEdit.concept_type,
    productLabel: name,
    productType: category,
    avatarWhyCare: ctx.finalEdit.avatar_why_care,
    adCategory,
    stageType,
    offer: ctx.promotion?.notes ? String(ctx.promotion.notes).split(/[.\n]/)[0].trim() : null,
    saleDates: saleDatesLabel(ctx.promotion),
  };
}

// Builds a brand-new ad_setups row's prefilled field set from context.
// Never touches an existing row -- see the ON CONFLICT DO NOTHING at the
// call site, which makes this idempotent per final_edit_id.
function buildPrefill(ctx) {
  const source = ctx.shootPlanItem?.source || null;
  const adCategory = detectAdCategory(source);
  const stageType = ctx.promotionStage ? detectPromotionStageType(ctx.promotionStage.name) : null;
  const format = ctx.finalEdit.format;
  const mediaType = format === 'video' ? 'video' : format === 'static' ? 'image' : 'image';
  const adType = format === 'carousel' ? 'carousel' : 'single';
  const today = new Date();
  const { name: productName, category: productCategory } = deriveProductNameAndCategory(ctx.styles, ctx.dropName, ctx.promotion);
  const copyCtx = copyContextFromLoaded(ctx, adCategory, stageType);
  const drafts = generateCopyDrafts(copyCtx);
  // Headline / Description / CTA come from the deterministic WNDRR rules, using the exact catalogue product name(s) and only a verified offer.
  const rule = deriveCopyRule({
    adCategory, stageType, productNames: ctx.styles.map((x) => x.name),
    offer: ctx.promotion ? ctx.promotion.verified_offer : null, offerTeaser: ctx.promotion ? ctx.promotion.verified_offer_teaser : null,
    promotionName: ctx.promotion ? ctx.promotion.name : null,
  });

  return {
    adCategory,
    weekNo: weekCode(today),
    adDate: today,
    productLabel: productName,
    productType: productCategory,
    hookShort: shortenHook(ctx.finalEdit.confirmedHook, productName, productCategory),
    mediaType,
    adType,
    // Creator = the real Shooting assignment (filming_owner), never the
    // editor, never the logged-in user, never a concept owner (see the
    // brief, item 6). Left null ("n/a", editable) when no Shooting
    // assignment exists -- never invented.
    creatorName: ctx.finalEdit.filming_owner || null,
    conceptLabel: ctx.finalEdit.concept_type || ctx.finalEdit.concept_name,
    urlLinkPage: deriveUrlLinkPage(adCategory, ctx.styles),
    promotionStageId: ctx.promotionStage ? ctx.promotionStage.id : null,
    cta: rule.cta || defaultCta(adCategory, stageType),
    rule,
    primaryTextOptions: drafts.primaryTextOptions,
    headlineOptions: drafts.headlineOptions,
  };
}

// Called from finalApproval.js's POST /concepts/:id/approve, once per
// final_edits row on that concept -- see this file's header comment.
// Idempotent: a final edit that already has an ad_setups row is skipped.
async function createAdSetupsForConcept(client, creativeAssetId) {
  const feResult = await client.query('SELECT id FROM final_edits WHERE creative_asset_id = $1 AND is_active = true', [creativeAssetId]);
  for (const fe of feResult.rows) {
    const ctx = await loadContext(client, fe.id);
    if (!ctx) continue;
    const p = buildPrefill(ctx);
    const insertResult = await client.query(
      `INSERT INTO ad_setups (
         creative_asset_id, final_edit_id, ad_category, ad_category_auto_detected,
         week_no, ad_date, product_label, product_type, hook_short, media_type, ad_type,
         creator_name, concept_label, url_link_page, promotion_stage_id, cta,
         primary_text_options, headline_options,
         selected_headline, selected_description, copy_rule_key, copy_rule_flags
       ) VALUES ($1,$2,$3,true,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb)
       ON CONFLICT (final_edit_id) DO NOTHING
       RETURNING id`,
      [
        creativeAssetId, fe.id, p.adCategory, p.weekNo, p.adDate, p.productLabel, p.productType,
        p.hookShort, p.mediaType, p.adType, p.creatorName, p.conceptLabel, p.urlLinkPage,
        p.promotionStageId, p.cta, JSON.stringify(p.primaryTextOptions), JSON.stringify(p.headlineOptions),
        p.rule.headline, p.rule.description, p.rule.ruleKey, JSON.stringify(p.rule.flags),
      ]
    );
    const adSetupId = insertResult.rows[0]?.id;
    if (adSetupId && ctx.styles.length) {
      for (const s of ctx.styles) {
        await client.query(
          `INSERT INTO ad_setup_products (ad_setup_id, style_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [adSetupId, s.id]
        );
      }
    }
  }
}

// ---------------------------------------------------------------------
// Board: Ad Setup tab + Approved tab listings
// ---------------------------------------------------------------------
const ROW_SELECT = `
  SELECT
    au.*, ca.concept_name, ca.hook AS concept_hook, fe.asset_name AS final_edit_asset_name,
    fe.final_edit_link, fe.format AS final_edit_format, fe.editor,
    ab.batch_number, ab.name AS batch_name,
    ps.name AS promotion_stage_name, p.name AS promotion_name, p.verified_offer, p.verified_offer_teaser
  FROM ad_setups au
  JOIN creative_assets ca ON ca.id = au.creative_asset_id
  JOIN final_edits fe ON fe.id = au.final_edit_id
  LEFT JOIN ad_batches ab ON ab.id = au.ad_batch_id
  LEFT JOIN promotion_stages ps ON ps.id = au.promotion_stage_id
  LEFT JOIN promotions p ON p.id = ps.promotion_id
`;

router.get('/board', async (req, res, next) => {
  try {
    const [adSetupResult, approvedResult] = await Promise.all([
      // fe.is_active guards against a hook Tuesday Review no longer
      // confirms (see Move Back's reconciliation) still showing a card
      // here. ca.final_approval_status = 'approved' guards against a
      // concept that's been Moved Back to Final Approval -- its ad_setups
      // rows stay in the database (reused, never re-created) but
      // shouldn't visibly sit in this tab while the concept itself is
      // parked one stage earlier.
      pool.query(`${ROW_SELECT} WHERE au.status = 'draft' AND fe.is_active = true AND ca.final_approval_status = 'approved' AND ca.archived_at IS NULL AND ca.concept_dev_status <> 'killed' ORDER BY au.created_at ASC`),
      pool.query(`${ROW_SELECT} WHERE au.status = 'approved' AND fe.is_active = true AND ca.archived_at IS NULL ORDER BY au.updated_at DESC`),
    ]);
    res.json({ ad_setup: adSetupResult.rows, approved: approvedResult.rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Deterministic copy rules (lib/adCopyRules.js) applied to a row.
//  * created rows get them at creation (createAdSetupsForConcept)
//  * an untouched draft (no person has edited Headline/Description/CTA) follows the rules, so a verified offer added later flows through
//  * a row a person has edited (copy_fields_manual) or that already holds chosen copy from before this release is never overwritten;
//    the rule result is returned as `copy_rule` so the UI can offer "Apply WNDRR rules" explicitly.
// ---------------------------------------------------------------------
function ruleForRow(row, products) {
  return deriveCopyRule({
    adCategory: row.ad_category,
    stageType: row.promotion_stage_name ? detectPromotionStageType(row.promotion_stage_name) : null,
    productNames: products.map((p) => p.name),
    offer: row.verified_offer, offerTeaser: row.verified_offer_teaser, promotionName: row.promotion_name,
  });
}

async function syncCopyRules(row, products) {
  const rule = ruleForRow(row, products);
  const differs = (rule.headline !== undefined && rule.headline !== null && rule.headline !== row.selected_headline)
    || (rule.description !== null && rule.description !== row.selected_description)
    || (rule.cta !== null && rule.cta !== row.cta);
  const legacyChosen = row.copy_rule_key === null && (row.selected_headline || row.selected_description);
  let applied = false;
  if (rule.ruleKey && row.status === 'draft' && !row.copy_set_id && mayAutoApply(row) && !legacyChosen) {
    const result = await pool.query(
      `UPDATE ad_setups SET selected_headline = $1, selected_description = $2, cta = COALESCE($3, cta), copy_rule_key = $4, copy_rule_flags = $5::jsonb, updated_at = now()
       WHERE id = $6 RETURNING *`,
      [rule.headline, rule.description, rule.cta, rule.ruleKey, JSON.stringify(rule.flags), row.id]
    );
    row = { ...row, ...result.rows[0] };
    applied = true;
  } else if (JSON.stringify(row.copy_rule_flags || []) !== JSON.stringify(rule.flags) && row.status === 'draft') {
    await pool.query('UPDATE ad_setups SET copy_rule_flags = $1::jsonb WHERE id = $2', [JSON.stringify(rule.flags), row.id]);
    row = { ...row, copy_rule_flags: rule.flags };
  }
  return {
    row,
    info: {
      rule_key: rule.ruleKey, flags: rule.flags, rule: { headline: rule.headline, description: rule.description, cta: rule.cta },
      auto_applied: applied, manual: !!row.copy_fields_manual, differs: !!rule.ruleKey && differs && !applied,
    },
  };
}

router.get('/:id', async (req, res, next) => {
  try {
    const rowResult = await pool.query(`${ROW_SELECT} WHERE au.id = $1`, [req.params.id]);
    if (!rowResult.rows.length) return res.status(404).json({ error: 'Ad Setup not found' });
    let row = rowResult.rows[0];

    const [productsResult, batchesResult, copySetsResult] = await Promise.all([
      pool.query(
        `SELECT s.id, s.style_code, s.name FROM ad_setup_products asp
         JOIN styles s ON s.id = asp.style_id WHERE asp.ad_setup_id = $1`,
        [req.params.id]
      ),
      pool.query('SELECT id, batch_number, name FROM ad_batches ORDER BY batch_number DESC'),
      pool.query('SELECT id, name, primary_text, headline, cta FROM ad_copy_sets ORDER BY name ASC'),
    ]);

    const synced = await syncCopyRules(row, productsResult.rows);
    row = synced.row;

    const generatedName = buildMetaAdName({
      batchNumber: row.batch_number,
      weekNo: row.week_no,
      adDate: row.ad_date,
      productName: row.product_label,
      productCategory: row.product_type,
      hookShort: row.hook_short,
      mediaType: row.media_type,
      adType: row.ad_type,
      creatorName: row.creator_name,
      conceptLabel: row.concept_label,
      urlLinkPage: row.url_link_page,
      adCategory: row.ad_category,
      stageType: row.promotion_stage_name ? detectPromotionStageType(row.promotion_stage_name) : null,
      saleSequenceNumber: row.sale_sequence_number,
    });

    res.json({
      ...row,
      products: productsResult.rows,
      batches: batchesResult.rows,
      copy_sets: copySetsResult.rows,
      generated_meta_ad_name: generatedName,
      copy_rule: synced.info,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Update (Save Draft covers all of these; nothing here calls Meta)
// ---------------------------------------------------------------------
const EDITABLE_FIELDS = [
  'ad_category', 'week_no', 'product_label', 'product_type', 'hook_short',
  'media_type', 'ad_type', 'creator_name', 'concept_label', 'url_link_page',
  'destination_url', 'selected_primary_text', 'selected_headline', 'selected_description', 'cta', 'copy_set_id', 'primary_text_source',
];
const DATE_FIELDS = new Set(['ad_date']);

router.patch('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingResult = await client.query('SELECT * FROM ad_setups WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!existingResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ad Setup not found' });
    }
    const existing = existingResult.rows[0];
    if (existing.status === 'approved') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This Ad Setup has already been approved.' });
    }

    const body = req.body || {};
    if ('primary_text_source' in body && body.primary_text_source !== null && !['ai', 'manual', 'template'].includes(body.primary_text_source)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'primary_text_source must be ai, manual or template' });
    }
    const sets = [];
    const values = [];
    let i = 1;
    for (const field of [...EDITABLE_FIELDS, 'ad_date']) {
      if (!(field in body)) continue;
      sets.push(`${field} = $${i}`);
      values.push(body[field] === '' ? null : body[field]);
      i += 1;
    }

    // Copy ownership: the moment a person changes Headline / Description / CTA, the deterministic rules stop managing them. Changing
    // the Primary Text also withdraws any earlier approval of it (the new wording has not been approved).
    const changedCopy = ['selected_headline', 'selected_description', 'cta'].some((f) => f in body && (body[f] === '' ? null : body[f]) !== existing[f]);
    if (changedCopy) sets.push('copy_fields_manual = true');
    if ('selected_primary_text' in body && (body.selected_primary_text === '' ? null : body.selected_primary_text) !== existing.selected_primary_text) {
      sets.push('primary_text_approved = false', 'primary_text_approved_at = NULL', 'primary_text_approved_by_user_id = NULL');
    }

    // Batch assignment: allocate a Sale sequential ad number the first
    // time a Promotion ad with a known stage gets a batch, atomically and
    // exactly once (see the counters table) -- never on a plain re-save.
    let ad_batch_id = 'ad_batch_id' in body ? body.ad_batch_id : existing.ad_batch_id;
    if ('ad_batch_id' in body) {
      sets.push(`ad_batch_id = $${i}`);
      values.push(body.ad_batch_id || null);
      i += 1;
    }
    const promotionStageId = existing.promotion_stage_id;
    const needsSaleNumber = existing.ad_category === 'promotion' && promotionStageId && ad_batch_id
      && existing.sale_sequence_number === null;
    if (needsSaleNumber) {
      const counterResult = await client.query(
        `INSERT INTO ad_sale_sequence_counters (promotion_stage_id, ad_batch_id, next_number)
         VALUES ($1, $2, 2)
         ON CONFLICT (promotion_stage_id, ad_batch_id)
         DO UPDATE SET next_number = ad_sale_sequence_counters.next_number + 1
         RETURNING next_number - 1 AS assigned`,
        [promotionStageId, ad_batch_id]
      );
      sets.push(`sale_sequence_number = $${i}`);
      values.push(counterResult.rows[0].assigned);
      i += 1;
    }

    if (!sets.length) {
      await client.query('ROLLBACK');
      return res.json(existing);
    }

    sets.push('updated_at = now()');
    values.push(req.params.id);
    const result = await client.query(
      `UPDATE ad_setups SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.post('/:id/regenerate-copy', async (req, res, next) => {
  try {
    const rowResult = await pool.query('SELECT * FROM ad_setups WHERE id = $1', [req.params.id]);
    if (!rowResult.rows.length) return res.status(404).json({ error: 'Ad Setup not found' });
    const row = rowResult.rows[0];
    const ctx = await loadContext(pool, row.final_edit_id);
    if (!ctx) return res.status(404).json({ error: 'Underlying Final Edit not found' });
    const stageType = ctx.promotionStage ? detectPromotionStageType(ctx.promotionStage.name) : null;
    const drafts = generateCopyDrafts(copyContextFromLoaded(ctx, row.ad_category, stageType));
    const result = await pool.query(
      `UPDATE ad_setups SET primary_text_options = $1, headline_options = $2, updated_at = now() WHERE id = $3 RETURNING *`,
      [JSON.stringify(drafts.primaryTextOptions), JSON.stringify(drafts.headlineOptions), req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Applies the deterministic WNDRR rules on request. A row whose copy a person has edited is only overwritten with confirm_overwrite: true.
router.post('/:id/apply-copy-rules', async (req, res, next) => {
  try {
    const rowResult = await pool.query(`${ROW_SELECT} WHERE au.id = $1`, [req.params.id]);
    if (!rowResult.rows.length) return res.status(404).json({ error: 'Ad Setup not found' });
    const row = rowResult.rows[0];
    if (row.status === 'approved') return res.status(409).json({ error: 'This Ad Setup has already been approved.' });
    const products = (await pool.query('SELECT s.id, s.style_code, s.name FROM ad_setup_products asp JOIN styles s ON s.id = asp.style_id WHERE asp.ad_setup_id = $1', [row.id])).rows;
    const rule = ruleForRow(row, products);
    if (!rule.ruleKey) return res.status(409).json({ error: (rule.flags[0] && rule.flags[0].message) || 'No rule applies to this ad.', flags: rule.flags });
    const holdsCopy = row.copy_fields_manual || row.selected_headline || row.selected_description;
    if (holdsCopy && (req.body || {}).confirm_overwrite !== true) {
      return res.status(409).json({ error: 'This ad already has its own Headline / Description / CTA. Confirm to replace them with the WNDRR rules.', needs_confirmation: true });
    }
    const result = await pool.query(
      `UPDATE ad_setups SET selected_headline = $1, selected_description = $2, cta = COALESCE($3, cta), copy_rule_key = $4, copy_rule_flags = $5::jsonb,
              copy_fields_manual = false, copy_set_id = NULL, updated_at = now() WHERE id = $6 RETURNING *`,
      [rule.headline, rule.description, rule.cta, rule.ruleKey, JSON.stringify(rule.flags), row.id]
    );
    res.json({ ...result.rows[0], copy_rule: { rule_key: rule.ruleKey, flags: rule.flags, rule: { headline: rule.headline, description: rule.description, cta: rule.cta }, auto_applied: true, manual: false, differs: false } });
  } catch (err) { next(err); }
});

// Approve the Primary Text. The text may be passed (the wording being approved) or already saved; unfinished AI suggestions never count.
router.post('/:id/approve-primary-text', async (req, res, next) => {
  try {
    const rowResult = await pool.query('SELECT * FROM ad_setups WHERE id = $1', [req.params.id]);
    if (!rowResult.rows.length) return res.status(404).json({ error: 'Ad Setup not found' });
    const row = rowResult.rows[0];
    if (row.status === 'approved') return res.status(409).json({ error: 'This Ad Setup has already been approved.' });
    const body = req.body || {};
    const text = (typeof body.text === 'string' ? body.text : row.selected_primary_text || '').trim();
    if (!text) return res.status(400).json({ error: 'There is no Primary Text to approve.' });
    if (text.length > 2200) return res.status(400).json({ error: 'Primary Text is too long (2,200 characters max).' });
    const source = ['ai', 'manual', 'template'].includes(body.source) ? body.source : (row.primary_text_source || 'manual');
    const result = await pool.query(
      `UPDATE ad_setups SET selected_primary_text = $1, primary_text_source = $2, primary_text_approved = true, primary_text_approved_at = now(),
              primary_text_approved_by_user_id = $3, ai_draft_options = '[]'::jsonb, updated_at = now() WHERE id = $4 RETURNING *`,
      [text, source, req.user.id, row.id]
    );
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// Approve Ad Setup -> Approved tab. Validates the same Final Check
// readiness the UI shows, server-side too, so an incomplete record can't
// be approved just by calling the API directly.
router.post('/:id/approve', async (req, res, next) => {
  try {
    const rowResult = await pool.query(
      `SELECT au.*, ca.id AS creative_asset_id FROM ad_setups au
       JOIN creative_assets ca ON ca.id = au.creative_asset_id WHERE au.id = $1`,
      [req.params.id]
    );
    if (!rowResult.rows.length) return res.status(404).json({ error: 'Ad Setup not found' });
    const row = rowResult.rows[0];
    if (row.status === 'approved') return res.status(409).json({ error: 'Already approved' });

    // Primary Text: a shared Copy Set, or this ad's own text that has been APPROVED. Copy from before approval existed (no source recorded) keeps counting;
    // an AI suggestion that nobody approved does not.
    const primaryOk = !!row.copy_set_id || (row.selected_primary_text && (row.primary_text_approved || !row.primary_text_source));
    const hasCopy = primaryOk && (row.copy_set_id || (row.selected_headline && row.selected_description));
    const missing = [];
    if (!row.hook_short) missing.push('Meta Ad Name (Hook)');
    if (!row.creator_name && row.creator_name !== null) missing.push('Creator');
    if (!hasCopy) {
      if (!primaryOk) missing.push(row.selected_primary_text ? 'Primary Text approval' : 'Primary Text');
      if (!row.copy_set_id && !row.selected_headline) missing.push('Headline');
      if (!row.copy_set_id && !row.selected_description) missing.push('Description');
    }
    if (!row.cta) missing.push('CTA');
    if (!row.url_link_page || !row.destination_url) missing.push('Destination');
    if (missing.length) {
      return res.status(400).json({ error: `Not ready to approve. Missing: ${missing.join(', ')}` });
    }

    const result = await pool.query(
      `UPDATE ad_setups SET status = 'approved', updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    await pool.query(
      `UPDATE creative_assets SET ad_setup_approved_at = now(), ad_setup_approved_by_user_id = $1
       WHERE id = $2 AND ad_setup_approved_at IS NULL`,
      [req.user.id, row.creative_asset_id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------
router.get('/batches/list', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT id, batch_number, name FROM ad_batches ORDER BY batch_number DESC');
    res.json({ batches: result.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/batches', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const settingsResult = await client.query('SELECT next_ad_batch_number FROM planning_settings WHERE id = 1 FOR UPDATE');
    const nextNumber = settingsResult.rows[0]?.next_ad_batch_number || 1;
    await client.query('UPDATE planning_settings SET next_ad_batch_number = $1 WHERE id = 1', [nextNumber + 1]);
    const name = (req.body && req.body.name && String(req.body.name).trim()) || `Batch #${nextNumber}`;
    const result = await client.query(
      `INSERT INTO ad_batches (batch_number, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING *`,
      [nextNumber, name, req.user.id]
    );
    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------
// Copy Sets
// ---------------------------------------------------------------------
router.get('/copy-sets/list', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM ad_copy_sets ORDER BY name ASC');
    res.json({ copy_sets: result.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/copy-sets', async (req, res, next) => {
  try {
    const { name, primary_text, headline, cta } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const result = await pool.query(
      `INSERT INTO ad_copy_sets (name, primary_text, headline, cta, created_by_user_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [String(name).trim(), primary_text || null, headline || null, cta || null, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.createAdSetupsForConcept = createAdSetupsForConcept;
