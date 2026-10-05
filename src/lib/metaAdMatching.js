// Meta Ad Matching V1 -- classifies Meta ads into WNDRR's creative-
// intelligence vocabulary (Product(s) / Concept / Creative Style / Creator /
// optional Ad Setup link). Everything here reads and writes the LOCAL
// database only: nothing in this file imports metaAds.js or touches the
// network, so opening the matching UI, searching, suggesting, confirming
// and editing never cost (or depend on) a Meta call. Meta synchronisation
// stays entirely separate (metaSync.js).
//
// ── Truth model (see the schema comment on meta_ad_classifications) ─────
//   meta_ads.match_status        the existing state machine -- the ONE state
//                                field: unmatched | suggested (UI: "Needs
//                                review") | auto_matched | confirmed (human)
//   meta_ads.matched_ad_setup_id the optional link to a real WNDRR Ad Setup
//   meta_ad_classifications +    the HUMAN-confirmed values
//   meta_ad_products
//   meta_ad_suggestions          derived, disposable proposals
//
// ── Protection of confirmed mappings ────────────────────────────────────
//  * metaSync.js (routine sync, backfill, inventory refresh) never writes a
//    match_* column or any of the tables above (upsertAd lists its columns).
//  * Suggestion runs lock the ad row and skip it when match_status is
//    'confirmed'; the only meta_ads write they make is guarded
//    `WHERE match_status IN ('unmatched','suggested','auto_matched')`.
//  * Auto-matching (see evaluateAutoMatch) writes only ads that are not
//    confirmed, not blocked and have exact, unambiguous structured evidence;
//    a human Confirm always replaces it, a human Clear blocks it from
//    returning.
//  * Only the explicit human actions below (confirm / clear / exclude /
//    skip) ever write a classification.
//
// ── Suggestions: deterministic, evidence-carrying, never confirmed ──────
// Each carries a value, a confidence and a human-readable reason. Sources:
//   product   existing Settings -> Meta Mapping (READ ONLY lookup -- unlike
//             resolveMetaProduct this never inserts "Unmapped" rows, so a
//             29k-ad queue can't flood that screen), structured-name
//             product tokens vs the product-family list, and the products
//             of a matched Ad Setup
//   concept   structured-name concept token / matched Ad Setup concept vs
//             concept_types; a token that isn't in concept_types is offered
//             as a LEGACY free-text classification, never inserted into it
//   creator   structured-name creator token / Ad Setup creator vs the
//             content_creators roster (creator stays a plain name)
//   creative_style  a matched Ad Setup's creative's Creative Style (promotion
//             style matrix) and conservative name keywords -- kept separate
//             from concept (see schema comment)
//   ad_setup  exact / near-exact match of the ad's name against the Meta
//             name generated from each WNDRR Ad Setup
const { pool } = require('../db');
const { parseMetaAdName, listProductFamilies } = require('./metaProductMapping');
const { buildMetaAdName, detectPromotionStageType } = require('./adSetupNaming');
const { deriveProductCode } = require('./apparelmagic');
const {
  MEDIA_TYPES, MEDIA_KEYS, MEDIA_LABEL, buildFamilyIndex, matchProductPhrase, expandSet, hasSetWord,
  coreTokens, mediaTokensFromName, parseLooseMetaName,
} = require('./metaNameParsing');
const {
  ymdInZone, addDays, REPORTING_TIMEZONE, deriveMetrics, HttpError, parseRangeParams,
} = require('./metaPerformance');

// Bump when evaluateAutoMatch's rules change: ads last evaluated under an
// older version are re-evaluated by the next suggestion run.
const AUTO_RULES_VERSION = 2;

// ONE definition of "a person owns this ad's state", as a SQL CASE returning
// the reason (or NULL). Aliases: m = meta_ads, c = meta_ad_classifications.
// Used by the backlog job to pick candidates AND to re-check under the row
// lock, and by its status report -- so selection, protection and reporting
// can never disagree. Machine-written state (auto_matched / auto_structured,
// suggestions, per-field auto provenance) is NOT human-owned and stays
// re-evaluable; a classification with values on an ad that is neither
// confirmed nor auto-matched can only have come from a person, so it is
// protected too.
const HUMAN_OWNED_SQL = `(CASE
  WHEN COALESCE(c.excluded_from_intelligence, false) THEN 'excluded'
  WHEN m.match_status = 'confirmed' THEN 'confirmed'
  WHEN m.match_confirmed_at IS NOT NULL OR m.match_confirmed_by_user_id IS NOT NULL OR m.match_method = 'manual' THEN 'manually_confirmed'
  WHEN m.matched_ad_setup_id IS NOT NULL THEN 'linked_ad_setup'
  WHEN c.skipped_at IS NOT NULL THEN 'skipped'
  WHEN c.classified_by_user_id IS NOT NULL OR c.creative_style_id IS NOT NULL THEN 'human_classification'
  WHEN m.match_status <> 'auto_matched' AND (
         c.concept_type_id IS NOT NULL OR c.concept_label IS NOT NULL OR c.creator_name IS NOT NULL
         OR c.media_type IS NOT NULL OR COALESCE(c.not_product_specific, false)
         OR EXISTS (SELECT 1 FROM meta_ad_products pp WHERE pp.meta_ad_id = m.meta_ad_id)
       ) THEN 'unexpected_classification_values'
  END)`;
const HIGH = 0.85;
const MEDIUM = 0.6;
function confidenceLevel(c) {
  const n = Number(c);
  return n >= HIGH ? 'high' : n >= MEDIUM ? 'medium' : 'low';
}

// Plain-language confidence for the UI (the number stays internal):
//   Exact  (>= 0.90) deterministic evidence matched a known value exactly
//   Likely (>= 0.60) a reasonable match a person should check
//   Weak   (<  0.60) a hint only
function confidenceLabel(c) {
  const n = Number(c);
  return n >= 0.9 ? 'Exact' : n >= MEDIUM ? 'Likely' : 'Weak';
}

function norm(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

// ── Structured (newer WNDRR) Meta name parser ───────────────────────────
// Mirrors lib/adSetupNaming.js's buildMetaAdName, which joins with "_":
//   [STAGE [n]] #batch, week, DD-MM, PRODUCT, CATEGORY, HOOK,
//   Media, Single|Carousel, CREATOR, CONCEPT, URL PAGE
// Week/date are only emitted when present, so the tail is parsed from the
// RIGHT (the last 8 segments are always there, `*` = blank placeholder) and
// anything left of the product is the optional prefix. A name that doesn't
// have "Single|Carousel" and "Video|Image|*" in those positions is NOT
// structured (returns null) -- legacy "PRODUCT + TYPE" names fall through
// to the existing Meta Product Mapping path instead.
const AD_TYPES = new Set(['SINGLE', 'CAROUSEL']);
const MEDIA = new Set(['VIDEO', 'IMAGE', '*']);
function parseStructuredMetaName(name) {
  if (!name || !String(name).includes('_')) return null;
  const segs = String(name).split('_').map((s) => s.trim());
  const n = segs.length;
  if (n < 8) return null;
  if (!AD_TYPES.has(segs[n - 4].toUpperCase()) || !MEDIA.has(segs[n - 5].toUpperCase())) return null;
  const val = (s) => (s === '' || s === '*' ? null : s);
  const out = {
    product_name: val(segs[n - 8]),
    product_category: val(segs[n - 7]),
    hook: val(segs[n - 6]),
    media: val(segs[n - 5]) && segs[n - 5].toLowerCase(),
    ad_type: segs[n - 4].toLowerCase(),
    creator: val(segs[n - 3]),
    concept: val(segs[n - 2]),
    url_link_page: val(segs[n - 1]),
    stage: null, batch: null, week: null, date: null,
  };
  const stage = [];
  segs.slice(0, n - 8).forEach((s) => {
    if (/^#/.test(s)) out.batch = s;
    else if (/^\d{2}-WK\d{1,2}$/i.test(s)) out.week = s;
    else if (/^\d{2}-\d{2}$/.test(s)) out.date = s;
    else if (s) stage.push(s);
  });
  out.stage = stage.join(' ') || null;
  return out;
}

// ── Suggestion context (loaded once per batch) ──────────────────────────
async function loadContext(db = pool) {
  const [mappings, families, concepts, creators, styles, setups, setupProducts, setupStyles, confirmedSingles] = await Promise.all([
    db.query('SELECT meta_product, meta_product_type, product_code, product_name FROM meta_product_mappings'),
    listProductFamilies(db),
    db.query('SELECT id, name, format FROM concept_types WHERE active ORDER BY sort_order, name'),
    db.query('SELECT name FROM content_creators ORDER BY name'),
    db.query('SELECT id, name, media_type FROM creative_styles ORDER BY sort_order, name'),
    db.query(
      `SELECT au.id, au.status, au.week_no, au.ad_date, au.product_label, au.product_type, au.hook_short,
              au.media_type, au.ad_type, au.creator_name, au.concept_label, au.url_link_page,
              au.ad_category, au.sale_sequence_number, au.creative_asset_id, au.final_edit_id,
              ab.batch_number, ps.name AS promotion_stage_name, ca.concept_name, ca.concept_type,
              fe.format AS final_edit_format
         FROM ad_setups au
         JOIN creative_assets ca ON ca.id = au.creative_asset_id
         LEFT JOIN final_edits fe ON fe.id = au.final_edit_id
         LEFT JOIN ad_batches ab ON ab.id = au.ad_batch_id
         LEFT JOIN promotion_stages ps ON ps.id = au.promotion_stage_id`
    ),
    db.query(
      `SELECT asp.ad_setup_id, s.style_code FROM ad_setup_products asp JOIN styles s ON s.id = asp.style_id`
    ),
    db.query(
      `SELECT COALESCE(e.linked_creative_asset_id, i.linked_creative_asset_id) AS creative_asset_id,
              COALESCE(e.creative_style_id, i.creative_style_id) AS creative_style_id
         FROM promotion_creative_idea_executions e
         JOIN promotion_creative_ideas i ON i.id = e.promotion_creative_idea_id
        WHERE COALESCE(e.creative_style_id, i.creative_style_id) IS NOT NULL
          AND COALESCE(e.linked_creative_asset_id, i.linked_creative_asset_id) IS NOT NULL`
    ),
    // Human-confirmed, single-product ads: the source of the "trusted
    // Product + Category pair" reuse (see trustedPairs below).
    db.query(
      `SELECT m.ad_name, (array_agg(p.product_code))[1] AS product_code
         FROM meta_ads m
         JOIN meta_ad_products p ON p.meta_ad_id = m.meta_ad_id
         LEFT JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id
        WHERE m.match_status = 'confirmed' AND m.match_method = 'manual'
          AND NOT COALESCE(c.excluded_from_intelligence, false) AND NOT COALESCE(c.not_product_specific, false)
        GROUP BY m.meta_ad_id, m.ad_name
       HAVING count(*) = 1`
    ),
  ]);

  const mappingByKey = new Map();
  const mappingCodesByProduct = new Map(); // product name (any type) -> set of mapped product_codes
  mappings.rows.forEach((r) => {
    mappingByKey.set(`${norm(r.meta_product)}||${norm(r.meta_product_type)}`, r);
    if (r.product_code) {
      const k = norm(r.meta_product);
      if (!mappingCodesByProduct.has(k)) mappingCodesByProduct.set(k, new Set());
      mappingCodesByProduct.get(k).add(r.product_code);
    }
  });
  // A Product + Category pair a PERSON already confirmed (as exactly one
  // product family on one or more ads). key -> Map(product_code -> #ads).
  // One code = trusted and reused for every matching historical/future ad;
  // several codes = the humans disagreed -> surfaced as a conflict, never guessed.
  const trustedPairs = new Map();
  confirmedSingles.rows.forEach((r) => {
    const st = parseStructuredMetaName(r.ad_name);
    const lg = parseMetaAdName(r.ad_name);
    const pairs = [];
    if (st && st.product_name && st.product_category) pairs.push([st.product_name, st.product_category]);
    if (lg && lg.product && lg.productType) pairs.push([lg.product, lg.productType]);
    pairs.forEach(([prod, cat]) => {
      const k = `${norm(prod)}||${norm(cat)}`;
      if (!trustedPairs.has(k)) trustedPairs.set(k, new Map());
      const m = trustedPairs.get(k);
      m.set(r.product_code, (m.get(r.product_code) || 0) + 1);
    });
  });
  const familyIndex = buildFamilyIndex(families);
  const familyByCode = new Map(families.map((f) => [f.product_code, f]));
  const familyByNorm = new Map();
  families.forEach((f) => { const k = norm(f.product_name); if (!familyByNorm.has(k)) familyByNorm.set(k, f); });
  const conceptByNorm = new Map(concepts.rows.map((c) => [norm(c.name), c]));
  const creatorByNorm = new Map(creators.rows.map((c) => [norm(c.name), c.name]));
  const styleByNorm = new Map(styles.rows.map((s) => [norm(s.name), s]));
  const styleById = new Map(styles.rows.map((s) => [s.id, s]));

  const productsBySetup = new Map();
  setupProducts.rows.forEach((r) => {
    const code = deriveProductCode(r.style_code);
    if (!productsBySetup.has(r.ad_setup_id)) productsBySetup.set(r.ad_setup_id, new Set());
    productsBySetup.get(r.ad_setup_id).add(code);
  });
  const stylesByAsset = new Map();
  setupStyles.rows.forEach((r) => {
    if (!stylesByAsset.has(r.creative_asset_id)) stylesByAsset.set(r.creative_asset_id, new Set());
    stylesByAsset.get(r.creative_asset_id).add(r.creative_style_id);
  });

  // Same field mapping as GET /api/ad-setup/:id (routes/adSetup.js) -- the
  // generated name is never stored, always rebuilt from the structured
  // fields, so matching against it can never drift from what Ad Setup shows.
  const adSetups = setups.rows.map((row) => {
    const generated = buildMetaAdName({
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
    const tokens = new Set(norm(generated).split(' ').filter(Boolean));
    return {
      id: row.id,
      status: row.status,
      generated_name: generated,
      norm_name: norm(generated),
      tokens,
      product_codes: [...(productsBySetup.get(row.id) || [])],
      concept_label: row.concept_label || row.concept_type || null,
      creator_name: row.creator_name || null,
      media_type: row.media_type || null,
      ad_type: row.ad_type || null,
      final_edit_format: row.final_edit_format || null,
      creative_asset_id: row.creative_asset_id,
      final_edit_id: row.final_edit_id,
      concept_name: row.concept_name,
      product_label: row.product_label,
      style_ids: [...(stylesByAsset.get(row.creative_asset_id) || [])],
    };
  });
  const adSetupByNorm = new Map();
  adSetups.forEach((a) => {
    if (!adSetupByNorm.has(a.norm_name)) adSetupByNorm.set(a.norm_name, []);
    adSetupByNorm.get(a.norm_name).push(a);
  });
  const adSetupById = new Map(adSetups.map((a) => [a.id, a]));
  // Ad Setups keyed by their product label's core words, so a set phrase seen
  // before (an Ad Setup already linking several families) can be reused.
  const adSetupsByLabel = new Map();
  adSetups.forEach((a) => {
    if (!a.product_label) return;
    const k = coreTokens(a.product_label).join(' ');
    if (!k) return;
    if (!adSetupsByLabel.has(k)) adSetupsByLabel.set(k, []);
    adSetupsByLabel.get(k).push(a);
  });

  return {
    mappingByKey, mappingCodesByProduct, trustedPairs, familyIndex, adSetupsByLabel, families, familyByCode, familyByNorm, concepts: concepts.rows, conceptByNorm,
    creators: creators.rows.map((c) => c.name), creatorByNorm, styles: styles.rows, styleByNorm, styleById,
    adSetups, adSetupByNorm, adSetupById,
  };
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  a.forEach((t) => { if (b.has(t)) inter += 1; });
  return inter / (a.size + b.size - inter);
}

// ── Product resolution for structured names (hands-off auto-matching) ───
// Decides whether a structured name's Product (+ Category) points to ONE
// clearly best existing product family, in this order of trust:
//   confirmed_pair     a person already confirmed this exact Product + Category
//                      as one family on other ads (reused automatically)
//   meta_mapping       existing Settings -> Meta Mapping (Product + Type, or a
//                      product name that maps to a single family)
//   catalogue_exact    exact normalised family name
//   catalogue_similar  ONE family clearly ahead of the rest (see clearBest)
// Anything with two plausible families, human disagreement, conflicting
// evidence or a set/bundle wording is NOT resolved -- that is a genuine
// exception for a person.
const PRODUCT_BASIS_CONFIDENCE = { confirmed_pair: 0.95, meta_mapping: 0.9, catalogue_exact: 0.9, catalogue_similar: 0.8 };
function clearBest(cands) {
  if (!cands.length) return null;
  const [top, second] = cands;
  if (top.ties > 1 || top.confidence < 0.6) return null;
  if (top.kind === 'fuzzy' && top.inter < 3) return null; // two shared words isn't enough to act alone
  if (second && !(top.jacc - second.jacc >= 0.1 || top.confidence - second.confidence >= 0.15)) return null;
  return top;
}
function resolveStructuredProduct(src, ctx, { cands }) {
  const fam = (code) => ctx.familyByCode.get(code);
  const hit = (code, basis, why) => ({ status: 'resolved', code, name: fam(code).product_name, basis, confidence: PRODUCT_BASIS_CONFIDENCE[basis], why });
  const setWording = hasSetWord(src.phrase) || hasSetWord(src.type || '');
  const best = clearBest(cands);
  let res = null;

  const trusted = src.type ? ctx.trustedPairs.get(`${norm(src.phrase)}||${norm(src.type)}`) : null;
  if (trusted && trusted.size > 1) return { status: 'ambiguous', reason: 'People have confirmed this Product + Category as different product families' };
  if (trusted && trusted.size === 1) {
    const code = [...trusted.keys()][0];
    if (fam(code)) res = hit(code, 'confirmed_pair', 'Product + Category already confirmed by a person');
  }
  if (!res && src.type) {
    const row = ctx.mappingByKey.get(`${norm(src.phrase)}||${norm(src.type)}`);
    if (row && row.product_code && fam(row.product_code)) res = hit(row.product_code, 'meta_mapping', 'Existing Meta Product Mapping');
  }
  if (!res) {
    const codes = ctx.mappingCodesByProduct.get(norm(src.phrase));
    if (codes && codes.size === 1 && fam([...codes][0])) res = hit([...codes][0], 'meta_mapping', 'Existing Meta Product Mapping (product name)');
  }
  if (res) {
    // human-curated evidence still loses to an exact catalogue match for a DIFFERENT family
    if (best && best.kind === 'exact' && best.family.product_code !== res.code) return { status: 'ambiguous', reason: 'Conflicting product evidence (mapping vs name)' };
    return res;
  }
  if (best && setWording && best.kind !== 'exact') return { status: 'ambiguous', reason: 'Looks like a set / bundle that may include several products' };
  if (best) {
    return hit(best.family.product_code, best.kind === 'exact' ? 'catalogue_exact' : 'catalogue_similar',
      best.kind === 'exact' ? 'Exact product family name' : `One clearly best product family (${best.kind.replace('_', ' ')} match)`);
  }
  if (cands.length) return { status: 'ambiguous', reason: 'More than one plausible product family' };
  if (setWording) return { status: 'ambiguous', reason: 'Looks like a set / bundle that may include several products' };
  return { status: 'none', reason: 'No matching product family' };
}

// Pure: ad row + loaded context -> proposed suggestions (no DB access), so
// the rules are directly unit-testable.
function buildSuggestions(ad, ctx) {
  const out = [];
  const add = (s) => out.push({ value_ref: null, evidence: {}, ...s });
  const name = ad.ad_name || '';
  const legacy = parseMetaAdName(name);
  const structured = parseStructuredMetaName(name);
  // Older / non-standard names: a tolerant token-driven reader that only runs
  // when the name does NOT follow the current structured layout.
  const loose = structured ? null : parseLooseMetaName(name, ctx);

  // ---- Ad Setup candidates (exact, then near-exact, on the generated name) ----
  let anchor = null;
  const nName = norm(name);
  if (nName) {
    const exact = ctx.adSetupByNorm.get(nName) || [];
    exact.forEach((s) => {
      add({
        field: 'ad_setup', value_key: String(s.id), value_label: s.generated_name, value_ref: s.id,
        confidence: 0.95, source: 'ad_setup_name',
        reason: `Ad name exactly matches the Meta name generated for Ad Setup #${s.id}`,
        evidence: { ad_setup_id: s.id, match: 'exact' },
      });
      if (!anchor) anchor = { setup: s, confidence: 0.95 };
    });
    if (!exact.length) {
      const tokens = new Set(nName.split(' ').filter(Boolean));
      let best = null;
      ctx.adSetups.forEach((s) => {
        if (s.tokens.size < 4 || tokens.size < 4) return;
        const j = jaccard(tokens, s.tokens);
        if (j >= 0.8 && (!best || j > best.j)) best = { s, j };
      });
      if (best) {
        const c = best.j >= 0.9 ? 0.7 : 0.6;
        add({
          field: 'ad_setup', value_key: String(best.s.id), value_label: best.s.generated_name, value_ref: best.s.id,
          confidence: c, source: 'ad_setup_name',
          reason: `Ad name is a near match (${Math.round(best.j * 100)}% of words) for the Meta name generated for Ad Setup #${best.s.id}`,
          evidence: { ad_setup_id: best.s.id, match: 'near', similarity: Number(best.j.toFixed(3)) },
        });
        anchor = { setup: best.s, confidence: c };
      }
    }
  }
  const fromSetup = anchor ? Math.max(0.5, anchor.confidence - 0.05) : null;

  // ---- Products ----
  // Priority for each product phrase the name yields:
  //   1. existing Meta Product Mapping (Product + Type pair, then product name)
  //   2. exact / strong / bounded-fuzzy match against EXISTING product families
  //   3. an Ad Setup already linking several families for the same set name
  //   4. set expansion from the catalogue's own collection structure
  //   5. otherwise nothing -- no guess, no new families
  const pushProduct = (family, confidence, reason, source, evidence) => add({
    field: 'product', value_key: family.product_code, value_label: family.product_name, confidence, reason, source, evidence,
  });
  const famOf = (code, fallbackName) => ctx.familyByCode.get(code) || { product_code: code, product_name: fallbackName || code };
  const lookupMapping = (product, type, shown) => {
    const row = type ? ctx.mappingByKey.get(`${norm(product)}||${norm(type)}`) : null;
    if (!row || !row.product_code) return false;
    pushProduct(famOf(row.product_code, row.product_name), 0.9, `Existing Meta Product Mapping matched ${shown}`, 'meta_product_mapping', { meta_product: product, meta_product_type: type });
    return true;
  };
  const lookupMappingByName = (product) => {
    const codes = ctx.mappingCodesByProduct.get(norm(product));
    if (!codes || codes.size !== 1) return false; // ambiguous across types -> don't pick one
    const code = [...codes][0];
    pushProduct(famOf(code), 0.85, `Existing Meta Product Mapping already maps the product name "${product}" to this family (product type ignored)`, 'meta_product_mapping', { meta_product: product, by: 'name_only' });
    return true;
  };
  const MATCH_WORDING = {
    exact: 'matches existing WNDRR product family "%F" (exact normalised name)',
    contains_strong: 'closely matches existing WNDRR product family "%F" (shares %I of %U words)',
    contains: 'matches part of existing WNDRR product family "%F" (shares %I words) — check before confirming',
    fuzzy: 'partially matches existing WNDRR product family "%F" (shares %I words) — check before confirming',
  };
  const setFromHistory = (phrase) => {
    if (!hasSetWord(phrase)) return false;
    const hits = (ctx.adSetupsByLabel.get(coreTokens(phrase).join(' ')) || []).filter((a) => a.product_codes.length >= 2);
    if (!hits.length) return false;
    const a = hits[0];
    a.product_codes.forEach((code) => pushProduct(famOf(code), 0.75, `Set "${phrase}": existing WNDRR Ad Setup #${a.id} with the same product name already links ${a.product_codes.length} families`, 'ad_setup_products', { phrase, ad_setup_id: a.id, set_group: `set:${norm(phrase)}`, kind: 'set_history' }));
    return true;
  };
  const matchSet = (phrase, origin) => {
    const set = expandSet(phrase, ctx.familyIndex);
    if (!set) return false;
    const names = set.members.map((m) => m.family.product_name).join(', ');
    set.members.forEach((m) => {
      const how = m.role === 'anchor' ? 'shares a word stem with the set name'
        : m.role === 'sibling' ? 'sits in the same sub-collection as a matching piece' : 'belongs to the same collection';
      pushProduct(m.family, m.confidence,
        `"${phrase}" looks like a set from the "${set.lead}" collection; WNDRR families ${set.members.length > 1 ? 'that fit' : 'that fits'}: ${names}. This piece ${how} — confirm which pieces the set includes`,
        'name_set_match', { phrase, origin, kind: 'set_expansion', role: m.role, set_group: `set:${norm(phrase)}`, collection_size: set.collection_size });
    });
    return true;
  };
  const lookupTrusted = (product, type, shown) => {
    const entry = type ? ctx.trustedPairs.get(`${norm(product)}||${norm(type)}`) : null;
    if (!entry || !entry.size) return false;
    if (entry.size === 1) {
      const [[code, n]] = [...entry.entries()];
      pushProduct(famOf(code), 0.95, `${shown} was already confirmed by a person as this product family on ${n} other ad${n === 1 ? '' : 's'} — reused automatically`, 'confirmed_pair', { meta_product: product, meta_product_type: type, confirmed_ads: n });
    } else {
      entry.forEach((n, code) => pushProduct(famOf(code), 0.6, `${shown} was confirmed by people as different product families (${entry.size}) — pick the right one`, 'confirmed_pair', { meta_product: product, meta_product_type: type, conflict: true, confirmed_ads: n }));
    }
    return true;
  };
  const productSources = [];
  if (legacy) productSources.push({ phrase: legacy.product, type: legacy.productType, shown: `${legacy.product} + ${legacy.productType}`, origin: 'legacy_name' });
  if (structured && structured.product_name) productSources.push({ phrase: structured.product_name, type: structured.product_category, shown: `${structured.product_name}${structured.product_category ? ` + ${structured.product_category}` : ''}`, origin: 'structured_name' });
  if (loose && loose.product_phrase && loose.product_catalogue_match) productSources.push({ phrase: loose.product_phrase, type: null, shown: loose.product_phrase, origin: 'loose_name' });
  let productResolution = null;
  productSources.forEach((src) => {
    const isStructured = src.origin === 'structured_name';
    // Catalogue candidates for the product phrase alone and for Product + Category;
    // the better-scoring list wins (Category usually disambiguates), ties go to
    // the more specific combined phrase.
    const alone = matchProductPhrase(src.phrase, ctx.familyIndex);
    const combined = src.type ? matchProductPhrase(`${src.phrase} ${src.type}`, ctx.familyIndex) : [];
    const cands = combined.length && (!alone.length || combined[0].confidence >= alone[0].confidence) ? combined : alone;
    if (isStructured) productResolution = resolveStructuredProduct(src, ctx, { trusted: ctx.trustedPairs, alone, combined, cands });

    if (lookupTrusted(src.phrase, src.type, src.shown)) return;
    if (lookupMapping(src.phrase, src.type, src.shown)) return;
    if (lookupMappingByName(src.phrase)) return;
    if (cands.length) {
      const phraseUsed = cands === combined ? `${src.phrase} ${src.type}` : src.phrase;
      cands.forEach((c) => {
        const how = MATCH_WORDING[c.kind].replace('%F', c.family.product_name).replace('%I', c.inter).replace('%U', c.family.matchSet.size);
        const tie = c.ties > 1 ? ` — ${c.ties} families matched equally closely` : '';
        pushProduct(c.family, c.confidence, `Product "${phraseUsed}" parsed from the Meta ad name ${how}${tie}`, 'name_product_match', { phrase: phraseUsed, kind: c.kind, origin: src.origin, shared_words: c.inter, family_words: c.family.matchSet.size });
      });
      return;
    }
    if (setFromHistory(src.phrase)) return;
    matchSet(src.phrase, src.origin);
  });
  if (anchor) {
    anchor.setup.product_codes.forEach((code) => {
      pushProduct(famOf(code), fromSetup, `Product of the linked Ad Setup #${anchor.setup.id}`, 'ad_setup_products', { ad_setup_id: anchor.setup.id });
    });
  }

  // ---- Concept (concept_types vocabulary; unknown text = legacy free text) ----
  const pushConcept = (label, confidence, reason, source, evidence) => {
    const hit = ctx.conceptByNorm.get(norm(label));
    if (hit) {
      add({ field: 'concept', value_key: `ct:${hit.id}`, value_label: hit.name, value_ref: hit.id, confidence, reason: `${reason}; matches existing concept "${hit.name}"`, source, evidence });
    } else {
      add({
        field: 'concept', value_key: `legacy:${norm(label)}`, value_label: label, confidence: Math.min(confidence, 0.55),
        reason: `${reason}; not in WNDRR's concept list (would be saved as a legacy classification)`, source, evidence: { ...evidence, legacy: true },
      });
    }
  };
  let conceptFound = false;
  if (structured && structured.concept) {
    pushConcept(structured.concept, 0.9, `Parsed directly from the structured Meta name ("${structured.concept}")`, 'structured_name', { token: structured.concept });
    conceptFound = true;
  }
  if (loose && loose.concept) {
    pushConcept(loose.concept, loose.concept_formed_from ? 0.55 : 0.75,
      loose.concept_formed_from ? `Formed from the name's "${loose.concept_formed_from}" tokens` : `Concept token "${loose.concept}" found in the Meta ad name`,
      'loose_name', { token: loose.concept, formed_from: loose.concept_formed_from || undefined });
    conceptFound = true;
  }
  if (anchor && anchor.setup.concept_label) {
    pushConcept(anchor.setup.concept_label, fromSetup, `Concept of the linked Ad Setup #${anchor.setup.id}`, 'ad_setup', { ad_setup_id: anchor.setup.id });
    conceptFound = true;
  }
  if (!conceptFound && nName) {
    ctx.concepts.forEach((c) => {
      const k = norm(c.name);
      if (k.length >= 3 && ` ${nName} `.includes(` ${k} `)) {
        add({ field: 'concept', value_key: `ct:${c.id}`, value_label: c.name, value_ref: c.id, confidence: 0.45, reason: `Concept name "${c.name}" appears in the Meta ad name`, source: 'name_keyword', evidence: { keyword: c.name } });
      }
    });
  }

  // ---- Creator (plain name; roster match just normalises the casing) ----
  const pushCreator = (token, confidence, reason, source, evidence) => {
    const roster = ctx.creatorByNorm.get(norm(token));
    if (roster) add({ field: 'creator', value_key: norm(roster), value_label: roster, confidence, reason: `${reason}; matches creator roster`, source, evidence });
    else add({ field: 'creator', value_key: norm(token), value_label: token, confidence: Math.min(confidence, 0.6), reason: `${reason}; not on the creator roster`, source, evidence: { ...evidence, off_roster: true } });
  };
  if (structured && structured.creator) pushCreator(structured.creator, 0.9, `Parsed directly from the structured Meta name ("${structured.creator}")`, 'structured_name', { token: structured.creator });
  if (loose && loose.creator) pushCreator(loose.creator, 0.8, `Creator "${loose.creator}" found in the Meta ad name`, 'loose_name', { token: loose.creator });
  if (anchor && anchor.setup.creator_name) pushCreator(anchor.setup.creator_name, fromSetup, `Creator of the linked Ad Setup #${anchor.setup.id}`, 'ad_setup', { ad_setup_id: anchor.setup.id });

  // ---- Creative Style (promotion creative-style matrix; separate taxonomy) ----
  if (anchor) {
    anchor.setup.style_ids.forEach((id) => {
      const st = ctx.styleById.get(id);
      if (st) add({ field: 'creative_style', value_key: String(st.id), value_label: st.name, value_ref: st.id, confidence: 0.8, reason: `Creative Style of the linked Ad Setup's creative (#${anchor.setup.id})`, source: 'ad_setup', evidence: { ad_setup_id: anchor.setup.id } });
    });
  }
  if (nName) {
    ctx.styles.forEach((st) => {
      const k = norm(st.name);
      const acronym = /^[A-Z]{2,4}$/.test(String(st.name).split(/\s+/)[0]) ? norm(String(st.name).split(/\s+/)[0]) : null;
      if (` ${nName} `.includes(` ${k} `) || (acronym && ` ${nName} `.includes(` ${acronym} `))) {
        add({ field: 'creative_style', value_key: String(st.id), value_label: st.name, value_ref: st.id, confidence: 0.45, reason: `Creative Style keyword for "${st.name}" appears in the Meta ad name`, source: 'name_keyword', evidence: { keyword: acronym || st.name } });
      }
    });
  }

  // ---- Media type (local evidence only -- never a Meta call) ----
  const pushMedia = (key, confidence, reason, source, evidence) => {
    if (!MEDIA_KEYS.has(key) || key === 'unknown') return;
    add({ field: 'media_type', value_key: key, value_label: MEDIA_LABEL[key], confidence, reason, source, evidence });
  };
  if (structured && structured.media) pushMedia(structured.media, 0.9, `Media token "${structured.media}" parsed from the structured Meta name`, 'structured_name', { token: structured.media });
  if (structured && structured.ad_type === 'carousel') pushMedia('carousel', 0.85, 'Ad type "Carousel" parsed from the structured Meta name', 'structured_name', { token: 'carousel' });
  if (loose && loose.media) pushMedia(loose.media, 0.85, `Media token "${loose.media}" found in the Meta ad name`, 'name_token', { token: loose.media });
  mediaTokensFromName(name).forEach((t) => pushMedia(t, 0.8, `Media token "${t}" found in the Meta ad name`, 'name_token', { token: t }));
  if (anchor) {
    const su = anchor.setup;
    if (su.media_type) pushMedia(su.media_type, fromSetup, `Media of the linked Ad Setup #${su.id}`, 'ad_setup', { ad_setup_id: su.id });
    if (su.ad_type === 'carousel') pushMedia('carousel', fromSetup, `Ad type of the linked Ad Setup #${su.id} is Carousel`, 'ad_setup', { ad_setup_id: su.id });
    const fe = { video: 'video', static: 'image', carousel: 'carousel' }[su.final_edit_format];
    if (fe) pushMedia(fe, Math.max(0.5, fromSetup - 0.05), `Format of the linked Ad Setup's final edit is ${su.final_edit_format}`, 'ad_setup', { ad_setup_id: su.id });
  }
  if (!out.some((s) => s.field === 'media_type')) {
    // weakest evidence: the format recorded on a suggested concept type
    const cs = out.filter((s) => s.field === 'concept' && s.value_ref).sort((a, b) => b.confidence - a.confidence)[0];
    const fmt = cs && (ctx.concepts.find((c) => c.id === cs.value_ref) || {}).format;
    const k = { video: 'video', static: 'image' }[fmt];
    if (k) pushMedia(k, 0.5, `Concept "${cs.value_label}" is recorded as a ${fmt} format`, 'concept_format', { concept_id: cs.value_ref });
  }

  // ---- Not product-specific ----
  // (not \b: structured names are underscore-delimited and _ is a word character)
  if (/(^|[^A-Za-z0-9])DPA([^A-Za-z0-9]|$)/i.test(name)) {
    add({ field: 'scope', value_key: 'not_product_specific', value_label: 'Not product-specific', confidence: 0.5, reason: 'Ad name contains "DPA" (dynamic product ads cover the whole catalogue)', source: 'name_keyword', evidence: { keyword: 'DPA' } });
  }

  // De-duplicate on (field, value_key): keep the strongest, note the rest.
  const best = new Map();
  out.forEach((s) => {
    const k = `${s.field}|${s.value_key}`;
    const cur = best.get(k);
    if (!cur) best.set(k, s);
    else if (s.confidence > cur.confidence) best.set(k, { ...s, reason: s.source === cur.source ? s.reason : `${s.reason}. Also: ${cur.reason}`, evidence: { ...s.evidence, also: [cur.source, ...(cur.evidence.also || [])] } });
    else {
      cur.evidence = { ...cur.evidence, also: [...(cur.evidence.also || []), s.source] };
      if (s.source !== cur.source && !cur.reason.includes('. Also: ')) cur.reason = `${cur.reason}. Also: ${s.reason}`;
    }
  });
  return {
    suggestions: [...best.values()].sort((a, b) => b.confidence - a.confidence),
    parsed: { legacy, structured, loose },
    anchor_ad_setup_id: anchor ? anchor.setup.id : null,
    anchor: anchor ? { id: anchor.setup.id, confidence: anchor.confidence, product_codes: anchor.setup.product_codes } : null,
    product_resolution: productResolution,
  };
}

// ── Auto-match rules (hands-off, per field) ─────────────────────────────
// A structured WNDRR name is classified field by field; one unresolved
// OPTIONAL field never blocks the fields that are known. The ad becomes
// AUTO-MATCHED as soon as its Product resolves safely (everything the product
// attribution needs); Concept / Creator / Media are persisted individually
// when unambiguous and simply left blank otherwise.
//
//   Product   ONE clearly best existing family: a person's earlier confirmation
//             of the same Product + Category, an existing Meta Product Mapping,
//             an exact family name, or one family clearly ahead of the rest
//             (resolveStructuredProduct). Never a guess between families.
//   Concept   exact existing concept (concept_type_id) -- or, when the token
//             isn't in the concept list, kept as LEGACY free text on this ad
//             only (never inserted into concept_types)
//   Creator   exact creator-roster name (an off-roster token stays blank)
//   Media     the explicit Media token; a Carousel ad type is Carousel
//   Creative Style: never required, never written here
//
// Genuine exceptions -- the ONLY reasons an ad is held for a person:
//   * not in the structured layout / DPA (not product-specific) wording
//   * product unresolved: none, two or more plausible families, people or
//     sources disagree, or a set/bundle that may hold several products
//   * product contradicts the linked (exact) Ad Setup's products
//   * conflicting media tokens in the name
// Returns { qualifies, blockers[], values, left_blank[], auto_fields, confidence }.
const JUNK_TOKEN = /^(NA|N A|NONE|TBC|TBD|UNKNOWN|NULL|TEST)$/;
function evaluateAutoMatch(ad, built, ctx) {
  const blockers = [];
  const leftBlank = [];
  const st = built.parsed && built.parsed.structured;
  if (!st) return { qualifies: false, blockers: ['The name isn\'t in the structured WNDRR layout'], left_blank: [], values: null, auto_fields: null };
  const by = (f) => built.suggestions.filter((s) => s.field === f);
  const keys = (arr) => new Set(arr.map((s) => s.value_key));

  // ---- Product (required to attribute the ad) ----
  const res = built.product_resolution;
  let product = null;
  if (!res || res.status !== 'resolved') blockers.push(res ? res.reason : 'No matching product family');
  else {
    product = { product_code: res.code, product_name: res.name, basis: res.basis, confidence: res.confidence };
    const anchor = built.anchor;
    if (anchor && anchor.confidence >= 0.9 && anchor.product_codes.length && !anchor.product_codes.includes(res.code)) {
      blockers.push('Product conflicts with the linked Ad Setup\'s product');
      product = null;
    }
  }

  // ---- Media: explicit tokens only ----
  let media = null;
  const tokenMedia = by('media_type').filter((m) => m.source === 'structured_name' || m.source === 'name_token');
  const mediaKeys = keys(tokenMedia.filter((m) => m.value_key !== 'carousel'));
  if (mediaKeys.size > 1) blockers.push('Conflicting media tokens in the name');
  else if (st.ad_type === 'carousel') media = { value: 'carousel', basis: 'ad_type' };
  else if (mediaKeys.size === 1) media = { value: [...mediaKeys][0], basis: 'media_token' };
  else leftBlank.push('Media type (no explicit token)');

  // ---- Concept: exact existing, else legacy text ----
  let concept = null;
  const conTok = by('concept').filter((s) => s.source === 'structured_name');
  const conKeys = keys(by('concept').filter((s) => s.confidence >= 0.8 || s.source === 'structured_name'));
  if (!conTok.length) leftBlank.push('Concept (none in the name)');
  else if (conKeys.size > 1) leftBlank.push('Concept (conflicting evidence)');
  else if (JUNK_TOKEN.test(norm(conTok[0].value_label))) leftBlank.push('Concept (placeholder text)');
  else if (conTok[0].value_ref) concept = { concept_type_id: conTok[0].value_ref, label: conTok[0].value_label, basis: 'existing_concept' };
  else concept = { concept_type_id: null, label: conTok[0].value_label, basis: 'legacy_text' };

  // ---- Creator: roster only ----
  let creator = null;
  const crTok = by('creator').filter((s) => s.source === 'structured_name');
  const crKeys = keys(by('creator').filter((s) => !s.evidence.off_roster));
  if (!crTok.length) leftBlank.push('Creator (none in the name)');
  else if (crTok[0].evidence.off_roster) leftBlank.push('Creator (not on the creator roster)');
  else if (crKeys.size > 1) leftBlank.push('Creator (conflicting evidence)');
  else creator = { value: crTok[0].value_label, basis: 'roster' };

  if (by('scope').length) blockers.push('Looks like a DPA / not product-specific ad');

  const qualifies = !blockers.length && !!product;
  if (!qualifies) return { qualifies: false, blockers, left_blank: [], values: null, auto_fields: null };
  const auto_fields = { product: { basis: product.basis, confidence: product.confidence } };
  if (concept) auto_fields.concept = { basis: concept.basis };
  if (creator) auto_fields.creator = { basis: creator.basis };
  if (media) auto_fields.media_type = { basis: media.basis };
  return {
    qualifies: true,
    blockers: [],
    left_blank: leftBlank,
    values: {
      product: { product_code: product.product_code, product_name: product.product_name },
      concept: concept ? { concept_type_id: concept.concept_type_id, label: concept.label } : null,
      creator: creator ? creator.value : null,
      media_type: media ? media.value : null,
    },
    auto_fields,
    // The ad-level label follows the product evidence (the attribution key):
    // Exact for confirmed/exact evidence, Likely for a clear similarity match.
    confidence: Math.min(0.9, product.confidence),
  };
}

// ── Suggestion persistence ──────────────────────────────────────────────
// Per ad, in one transaction with the ad row locked: confirmed (human) and
// excluded ads are skipped outright. Otherwise the ad's old suggestions are
// replaced and the ad is either AUTO-MATCHED (all rules above hold and no
// human has blocked it) or moved between unmatched <-> suggested. An
// auto-matched ad whose evidence no longer qualifies has its machine-written
// classification removed again (it was never a human decision).
async function refreshSuggestionsForAd(client, ad, ctx, opts = {}) {
  const locked = await client.query(
    `SELECT m.match_status, COALESCE(c.excluded_from_intelligence, false) AS excluded, c.auto_match_blocked_at,
            ${HUMAN_OWNED_SQL} AS human_owned
       FROM meta_ads m LEFT JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id
      WHERE m.meta_ad_id = $1 FOR UPDATE OF m`,
    [ad.meta_ad_id]
  );
  if (!locked.rows.length) return { skipped: 'missing' };
  const prev = locked.rows[0];
  if (prev.match_status === 'confirmed') return { skipped: 'confirmed' };
  if (prev.excluded) return { skipped: 'excluded' };
  // Backlog job only: re-check, under the row lock, that no human owns this ad
  // (a person may have acted since the batch was selected).
  if (opts.protectHumanState && prev.human_owned) return { skipped: prev.human_owned };

  const built = buildSuggestions(ad, ctx);
  const { suggestions } = built;
  await client.query('DELETE FROM meta_ad_suggestions WHERE meta_ad_id = $1', [ad.meta_ad_id]);
  for (const s of suggestions) {
    await client.query(
      `INSERT INTO meta_ad_suggestions (meta_ad_id, field, value_key, value_label, value_ref, confidence, reason, source, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (meta_ad_id, field, value_key) DO NOTHING`,
      [ad.meta_ad_id, s.field, s.value_key, s.value_label, s.value_ref, s.confidence, s.reason, s.source, JSON.stringify(s.evidence || {})]
    );
  }

  const auto = evaluateAutoMatch(ad, built, ctx);
  if (auto.qualifies && !prev.auto_match_blocked_at) {
    const v = auto.values;
    // Machine-owned write (the ad is neither confirmed nor excluded -- checked
    // above under the row lock): every unresolved optional field is NULL, and
    // auto_fields records which evidence produced each value.
    await client.query(
      `INSERT INTO meta_ad_classifications (meta_ad_id, not_product_specific, concept_type_id, concept_label, creator_name, media_type, auto_fields)
       VALUES ($1, false, $2, $3, $4, $5, $6)
       ON CONFLICT (meta_ad_id) DO UPDATE SET
         not_product_specific = false, concept_type_id = EXCLUDED.concept_type_id, concept_label = EXCLUDED.concept_label,
         creator_name = EXCLUDED.creator_name, media_type = EXCLUDED.media_type, auto_fields = EXCLUDED.auto_fields, updated_at = now()`,
      [ad.meta_ad_id, v.concept ? v.concept.concept_type_id : null, v.concept ? v.concept.label : null, v.creator, v.media_type, JSON.stringify(auto.auto_fields)]
    );
    await client.query('DELETE FROM meta_ad_products WHERE meta_ad_id = $1', [ad.meta_ad_id]);
    await client.query('INSERT INTO meta_ad_products (meta_ad_id, product_code, product_name) VALUES ($1,$2,$3)', [ad.meta_ad_id, v.product.product_code, v.product.product_name]);
    await client.query(
      `UPDATE meta_ads SET match_status = 'auto_matched', match_method = 'auto_structured', match_confidence = $2, match_suggestions_at = now(),
              match_rules_version = $3
        WHERE meta_ad_id = $1 AND match_status IN ('unmatched', 'suggested', 'auto_matched')`,
      [ad.meta_ad_id, auto.confidence, AUTO_RULES_VERSION]
    );
    return { suggestions: suggestions.length, auto_matched: true, status: 'auto_matched', left_blank: auto.left_blank };
  }

  if (prev.match_status === 'auto_matched') {
    // No longer qualifies (renamed, catalogue changed, ...): undo the machine's own write.
    await client.query('DELETE FROM meta_ad_products WHERE meta_ad_id = $1', [ad.meta_ad_id]);
    await client.query(
      `UPDATE meta_ad_classifications SET not_product_specific = false, concept_type_id = NULL, concept_label = NULL,
              creator_name = NULL, media_type = NULL, auto_fields = NULL, updated_at = now() WHERE meta_ad_id = $1`,
      [ad.meta_ad_id]
    );
  }
  const top = suggestions.length ? suggestions[0].confidence : null;
  // Guarded: can never touch a confirmed ad even if the lock above were bypassed.
  await client.query(
    `UPDATE meta_ads SET
       match_status = CASE WHEN $2::numeric IS NULL THEN 'unmatched' ELSE 'suggested' END,
       match_confidence = $2,
       match_method = CASE WHEN $2::numeric IS NULL THEN NULL ELSE 'auto_suggest' END,
       match_suggestions_at = now(), match_rules_version = $3
     WHERE meta_ad_id = $1 AND match_status IN ('unmatched', 'suggested', 'auto_matched')`,
    [ad.meta_ad_id, top, AUTO_RULES_VERSION]
  );
  return { suggestions: suggestions.length, auto_matched: false, status: top === null ? 'unmatched' : 'suggested', blockers: auto.blockers };
}

// Window helpers: the queue's "recent activity" scope is relative to the
// Sydney calendar, same as Meta Performance.
const SCOPES = { '30d': 30, '90d': 90, all: null };
function scopeWindow(scope, now = new Date()) {
  const today = ymdInZone(now, REPORTING_TIMEZONE);
  const days = SCOPES[scope];
  if (!days) return { since: null, until: today, days: null };
  return { since: addDays(today, -(days - 1)), until: today, days };
}

// Recomputes suggestions for non-confirmed, non-excluded ads. `pendingOnly`
// (the default for the automatic call) restricts to ads never evaluated, or
// last evaluated under an older AUTO_RULES_VERSION.
async function refreshSuggestions({ scope = '30d', pendingOnly = true, limit = 1500 } = {}) {
  limit = Math.min(10000, Math.max(1, parseInt(limit, 10) || 1500));
  const win = scopeWindow(scope);
  const params = [];
  let activityJoin = '';
  if (win.since) {
    params.push(win.since, win.until);
    activityJoin = `JOIN (SELECT meta_ad_id FROM meta_ad_insights_daily WHERE insight_date BETWEEN $1 AND $2
                         GROUP BY meta_ad_id HAVING SUM(spend) > 0 OR SUM(impressions) > 0) act ON act.meta_ad_id = a.meta_ad_id`;
  }
  params.push(limit);
  const { rows: ads } = await pool.query(
    `SELECT a.meta_ad_id, a.ad_name FROM meta_ads a
       ${activityJoin}
       LEFT JOIN meta_ad_classifications c ON c.meta_ad_id = a.meta_ad_id
      WHERE a.match_status <> 'confirmed' AND COALESCE(c.excluded_from_intelligence, false) = false
        ${pendingOnly ? `AND (a.match_suggestions_at IS NULL OR COALESCE(a.match_rules_version, 0) < ${AUTO_RULES_VERSION})` : ''}
      ORDER BY COALESCE(a.match_rules_version, 0) ASC, a.match_suggestions_at ASC NULLS FIRST
      LIMIT $${params.length}`,
    params
  );
  if (!ads.length) return { examined: 0, with_suggestions: 0, auto_matched: 0, needs_review: 0, unmatched: 0, review_reasons: {} };
  const ctx = await loadContext();
  let withSuggestions = 0;
  let autoMatched = 0;
  let needsReview = 0;
  let unmatched = 0;
  const reasons = {}; // why ads were held for a person (first blocker per ad)
  for (const ad of ads) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await refreshSuggestionsForAd(client, ad, ctx);
      await client.query('COMMIT');
      if (r.suggestions) withSuggestions += 1;
      if (r.auto_matched) autoMatched += 1;
      else if (r.status === 'suggested') needsReview += 1;
      else if (r.status === 'unmatched') unmatched += 1;
      if (!r.auto_matched && r.status) {
        const why = (r.blockers && r.blockers[0]) || (r.status === 'unmatched' ? 'No evidence in the name' : 'Needs a person to choose');
        reasons[why] = (reasons[why] || 0) + 1;
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return { examined: ads.length, with_suggestions: withSuggestions, auto_matched: autoMatched, needs_review: needsReview, unmatched, review_reasons: reasons };
}

// ── Backlog reprocess (explicit admin action, resumable) ────────────────
// Runs every NON-confirmed ad whose match_rules_version is older than
// AUTO_RULES_VERSION (or NULL) through the SAME per-ad matcher the app always
// uses (refreshSuggestionsForAd: buildSuggestions + evaluateAutoMatch), with no
// activity-window limit. Design:
//   * the stale predicate IS the work queue: refreshSuggestionsForAd stamps
//     match_rules_version in the same per-ad transaction as its writes, so an
//     evaluated ad never qualifies again and a re-run after a crash/redeploy
//     simply continues with what is left (idempotent, resumable);
//   * one transaction per ad, row-locked -- a failure rolls back only that ad;
//   * batches of BACKLOG_BATCH ads selected by a keyset cursor (meta_ad_id >
//     last), so skipped / failing ads can never be picked twice in one run;
//   * human-owned ads are never selected (HUMAN_OWNED_SQL) and are re-checked
//     under the lock;
//   * a Postgres advisory lock allows one run at a time (even across instances);
//   * the HTTP request only STARTS the job; progress is polled, so no request
//     ever has to survive the full run.
// Local database only: nothing here can reach Meta.
const BACKLOG_BATCH = 500;
const BACKLOG_LOCK_KEY = 7240913; // pg_try_advisory_lock key
const BACKLOG_MAX_CONSECUTIVE_ERRORS = 50;
let backlogJob = null;

const emptyTotals = () => ({ evaluated: 0, auto_matched: 0, needs_review: 0, unmatched: 0, skipped_protected: 0, errors: 0 });

async function backlogDbStatus(db = pool) {
  const [stale, v2] = await Promise.all([
    db.query(
      `SELECT m.match_status, ${HUMAN_OWNED_SQL} AS human_owned, count(*)::int AS n
         FROM meta_ads m LEFT JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id
        WHERE m.match_status <> 'confirmed' AND COALESCE(m.match_rules_version, 0) < $1
        GROUP BY 1, 2`,
      [AUTO_RULES_VERSION]
    ),
    db.query('SELECT match_status, count(*)::int AS n FROM meta_ads WHERE match_rules_version >= $1 GROUP BY 1', [AUTO_RULES_VERSION]),
  ]);
  let total = 0;
  let protectedN = 0;
  const byStatus = {};
  const protectedBy = {};
  stale.rows.forEach((r) => {
    total += r.n;
    byStatus[r.match_status] = (byStatus[r.match_status] || 0) + r.n;
    if (r.human_owned) { protectedN += r.n; protectedBy[r.human_owned] = (protectedBy[r.human_owned] || 0) + r.n; }
  });
  const evaluated = {};
  v2.rows.forEach((r) => { evaluated[r.match_status] = r.n; });
  return {
    rules_version: AUTO_RULES_VERSION,
    stale_total: total,
    stale_by_status: byStatus,
    stale_protected: protectedN,
    stale_protected_by_reason: protectedBy,
    // what a run would still process
    stale_processable: total - protectedN,
    evaluated_current_version_by_status: evaluated,
  };
}

function publicJob(job) {
  if (!job) return null;
  return {
    state: job.state, // running | completed | stopped | aborted | failed
    started_at: job.started_at, finished_at: job.finished_at,
    target_version: job.target_version,
    processable_at_start: job.processable_at_start,
    totals: { ...job.totals },
    skipped_by_reason: { ...job.skipped_by_reason },
    batches: job.batches, last_batch_at: job.last_batch_at,
    stop_requested: job.stop_requested,
    error_samples: job.error_samples.slice(0, 10),
    fatal_error: job.fatal_error || null,
  };
}

async function getBacklogStatus() {
  return { running: !!(backlogJob && backlogJob.state === 'running'), job: publicJob(backlogJob), db: await backlogDbStatus() };
}

async function runBacklog(job, lockClient, deps = {}) {
  const evaluate = deps.evaluateAd || refreshSuggestionsForAd;
  let cursor = '';
  let consecutiveErrors = 0;
  try {
    for (;;) {
      if (job.stop_requested) { job.state = 'stopped'; break; }
      const { rows } = await pool.query(
        `SELECT m.meta_ad_id, m.ad_name, ${HUMAN_OWNED_SQL} AS human_owned
           FROM meta_ads m LEFT JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id
          WHERE m.match_status <> 'confirmed' AND COALESCE(m.match_rules_version, 0) < $1 AND m.meta_ad_id > $2
          ORDER BY m.meta_ad_id LIMIT $3`,
        [job.target_version, cursor, BACKLOG_BATCH]
      );
      if (!rows.length) { job.state = 'completed'; break; }
      cursor = rows[rows.length - 1].meta_ad_id;
      const ctx = await loadContext(); // fresh per batch: picks up humans' confirmations made meanwhile
      for (const ad of rows) {
        if (job.stop_requested) break;
        if (ad.human_owned) { job.totals.skipped_protected += 1; job.skipped_by_reason[ad.human_owned] = (job.skipped_by_reason[ad.human_owned] || 0) + 1; continue; }
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const r = await evaluate(client, ad, ctx, { protectHumanState: true });
          await client.query('COMMIT');
          consecutiveErrors = 0;
          if (r.skipped) {
            job.totals.skipped_protected += 1;
            job.skipped_by_reason[r.skipped] = (job.skipped_by_reason[r.skipped] || 0) + 1;
          } else {
            job.totals.evaluated += 1;
            if (r.auto_matched) job.totals.auto_matched += 1;
            else if (r.status === 'suggested') job.totals.needs_review += 1;
            else job.totals.unmatched += 1;
          }
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          job.totals.errors += 1;
          consecutiveErrors += 1;
          if (job.error_samples.length < 25) job.error_samples.push({ meta_ad_id: ad.meta_ad_id, error: String(err && err.message).slice(0, 200) });
        } finally {
          client.release();
        }
        if (consecutiveErrors >= BACKLOG_MAX_CONSECUTIVE_ERRORS) {
          job.state = 'aborted';
          job.fatal_error = `Stopped after ${BACKLOG_MAX_CONSECUTIVE_ERRORS} consecutive errors (last: ${job.error_samples[job.error_samples.length - 1].error}). Fix the cause and start it again -- it resumes.`;
          return;
        }
      }
      job.batches += 1;
      job.last_batch_at = new Date().toISOString();
      console.log(`[ad-matching backlog] batch ${job.batches}: evaluated ${job.totals.evaluated}, auto ${job.totals.auto_matched}, review ${job.totals.needs_review}, unmatched ${job.totals.unmatched}, protected ${job.totals.skipped_protected}, errors ${job.totals.errors}`);
      if (job.stop_requested) { job.state = 'stopped'; break; }
    }
  } catch (err) {
    job.state = 'failed';
    job.fatal_error = String(err && err.message).slice(0, 300);
  } finally {
    job.finished_at = new Date().toISOString();
    if (job.state === 'running') job.state = 'failed';
    console.log(`[ad-matching backlog] ${job.state}: ${JSON.stringify({ totals: job.totals, skipped_by_reason: job.skipped_by_reason, batches: job.batches })}`);
    try { await lockClient.query('SELECT pg_advisory_unlock($1)', [BACKLOG_LOCK_KEY]); } catch (e) { /* released with the connection anyway */ }
    lockClient.release();
  }
}

// Starts the job and returns immediately. `deps.evaluateAd` is a test seam.
async function startBacklogReprocess(deps = {}) {
  if (backlogJob && backlogJob.state === 'running') throw new HttpError(409, 'A backlog reprocess is already running');
  const lockClient = await pool.connect();
  let got = false;
  try {
    got = (await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [BACKLOG_LOCK_KEY])).rows[0].ok;
  } catch (err) {
    lockClient.release();
    throw err;
  }
  if (!got) { lockClient.release(); throw new HttpError(409, 'A backlog reprocess is already running (another instance)'); }
  const status = await backlogDbStatus().catch(() => null);
  const job = {
    state: 'running', started_at: new Date().toISOString(), finished_at: null, target_version: AUTO_RULES_VERSION,
    processable_at_start: status ? status.stale_processable : null,
    totals: emptyTotals(), skipped_by_reason: {}, batches: 0, last_batch_at: null, stop_requested: false, error_samples: [], fatal_error: null,
  };
  backlogJob = job;
  const done = runBacklog(job, lockClient, deps);
  if (deps.wait) await done; // tests only
  return getBacklogStatus();
}

function stopBacklogReprocess() {
  if (!backlogJob || backlogJob.state !== 'running') throw new HttpError(409, 'No backlog reprocess is running');
  backlogJob.stop_requested = true;
  return { stop_requested: true };
}

// ── Queue ───────────────────────────────────────────────────────────────
const FILTERS = {
  needs: `a.match_status IN ('unmatched','suggested') AND NOT COALESCE(c.excluded_from_intelligence, false)`,
  unmatched: `a.match_status = 'unmatched' AND NOT COALESCE(c.excluded_from_intelligence, false)`,
  suggested: `a.match_status = 'suggested' AND NOT COALESCE(c.excluded_from_intelligence, false)`,
  auto: `a.match_status = 'auto_matched' AND NOT COALESCE(c.excluded_from_intelligence, false)`,
  confirmed: `a.match_status = 'confirmed' AND NOT COALESCE(c.excluded_from_intelligence, false)`,
  not_product_specific: `a.match_status = 'confirmed' AND COALESCE(c.not_product_specific, false) AND NOT COALESCE(c.excluded_from_intelligence, false)`,
  excluded: `COALESCE(c.excluded_from_intelligence, false)`,
  all: null,
};

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

async function getQueue(query = {}) {
  const scope = Object.prototype.hasOwnProperty.call(SCOPES, query.scope) ? query.scope : '30d';
  const filter = Object.prototype.hasOwnProperty.call(FILTERS, query.filter) ? query.filter : 'needs';
  const q = String(query.q || '').trim().slice(0, 200);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size, 10) || 25));
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const win = scopeWindow(scope);

  // Spend/activity is measured over the scope's window; for "all" it is the
  // last 30 days so the Recent spend column still means something. A windowed
  // scope only lists ads WITH activity in it (JOIN); "all" lists every stored ad.
  const actWin = win.since ? win : scopeWindow('30d');
  const params = [actWin.since, actWin.until];
  const act = win.since ? 'JOIN act ON act.meta_ad_id = a.meta_ad_id' : 'LEFT JOIN act ON act.meta_ad_id = a.meta_ad_id';
  const cte = `
    WITH act AS (
      SELECT d.meta_ad_id, SUM(d.spend) AS spend, SUM(d.purchases) AS purchases, MAX(d.insight_date) AS last_active
        FROM meta_ad_insights_daily d
       WHERE d.insight_date BETWEEN $1 AND $2
       GROUP BY d.meta_ad_id
      HAVING SUM(d.spend) > 0 OR SUM(d.impressions) > 0
    )`;
  const base = `
    FROM meta_ads a
    ${act}
    LEFT JOIN meta_ad_classifications c ON c.meta_ad_id = a.meta_ad_id`;

  // counts for the filter chips: scope only (not filter/search)
  const countsRes = await pool.query(
    `${cte}
     SELECT count(*) FILTER (WHERE ${FILTERS.needs})::int AS needs,
            count(*) FILTER (WHERE ${FILTERS.unmatched})::int AS unmatched,
            count(*) FILTER (WHERE ${FILTERS.suggested})::int AS suggested,
            count(*) FILTER (WHERE ${FILTERS.auto})::int AS auto,
            count(*) FILTER (WHERE ${FILTERS.confirmed})::int AS confirmed,
            count(*) FILTER (WHERE ${FILTERS.not_product_specific})::int AS not_product_specific,
            count(*) FILTER (WHERE ${FILTERS.excluded})::int AS excluded,
            count(*)::int AS all_ads,
            count(*) FILTER (WHERE a.match_status <> 'confirmed' AND NOT COALESCE(c.excluded_from_intelligence, false) AND a.match_suggestions_at IS NULL)::int AS pending_suggestions
       ${base}`,
    params
  );

  const where = [];
  if (FILTERS[filter]) where.push(FILTERS[filter]);
  const filterParams = [...params];
  if (q) {
    filterParams.push(`%${escapeLike(q)}%`);
    const like = `$${filterParams.length}`;
    filterParams.push(q);
    const exact = `$${filterParams.length}`;
    where.push(`(a.ad_name ILIKE ${like} ESCAPE '\\' OR a.meta_ad_id = ${exact}
      OR EXISTS (SELECT 1 FROM meta_ad_products p WHERE p.meta_ad_id = a.meta_ad_id AND (p.product_name ILIKE ${like} ESCAPE '\\' OR p.product_code ILIKE ${like} ESCAPE '\\'))
      OR EXISTS (SELECT 1 FROM meta_ad_suggestions s WHERE s.meta_ad_id = a.meta_ad_id AND s.field = 'product' AND s.value_label ILIKE ${like} ESCAPE '\\')
      OR c.concept_label ILIKE ${like} ESCAPE '\\' OR c.creator_name ILIKE ${like} ESCAPE '\\')`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await pool.query(`${cte} SELECT count(*)::int AS n ${base} ${whereSql}`, filterParams)).rows[0].n;

  const listParams = [...filterParams, pageSize, (page - 1) * pageSize];
  const { rows } = await pool.query(
    `${cte}
     SELECT a.meta_ad_id, a.ad_name, a.effective_status, a.created_time, a.match_status, a.matched_ad_setup_id, a.match_confidence,
            COALESCE(act.spend, 0) AS spend, act.last_active,
            c.skipped_at, COALESCE(c.excluded_from_intelligence, false) AS excluded,
            COALESCE(c.not_product_specific, false) AS not_product_specific,
            c.concept_label AS confirmed_concept, c.creator_name AS confirmed_creator, c.media_type AS confirmed_media,
            (SELECT string_agg(p.product_name, ', ' ORDER BY p.product_name) FROM meta_ad_products p WHERE p.meta_ad_id = a.meta_ad_id) AS confirmed_products,
            (SELECT s.value_label FROM meta_ad_suggestions s WHERE s.meta_ad_id = a.meta_ad_id AND s.field = 'product' ORDER BY s.confidence DESC LIMIT 1) AS suggested_product,
            (SELECT s.confidence FROM meta_ad_suggestions s WHERE s.meta_ad_id = a.meta_ad_id AND s.field = 'product' ORDER BY s.confidence DESC LIMIT 1) AS suggested_product_confidence,
            (SELECT s.value_label FROM meta_ad_suggestions s WHERE s.meta_ad_id = a.meta_ad_id AND s.field = 'concept' ORDER BY s.confidence DESC LIMIT 1) AS suggested_concept,
            (SELECT s.value_label FROM meta_ad_suggestions s WHERE s.meta_ad_id = a.meta_ad_id AND s.field = 'media_type' ORDER BY s.confidence DESC LIMIT 1) AS suggested_media,
            (SELECT max(s.confidence) FROM meta_ad_suggestions s WHERE s.meta_ad_id = a.meta_ad_id) AS top_confidence
       ${base}
       ${whereSql}
      ORDER BY (c.skipped_at IS NOT NULL) ASC,
               COALESCE(act.spend, 0) DESC,
               act.last_active DESC NULLS LAST,
               CASE a.match_status WHEN 'unmatched' THEN 0 WHEN 'suggested' THEN 1 WHEN 'auto_matched' THEN 2 ELSE 3 END ASC,
               a.created_time DESC NULLS LAST,
               a.meta_ad_id ASC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams
  );
  return {
    scope, filter, q, page, page_size: pageSize, total, total_pages: Math.max(1, Math.ceil(total / pageSize)),
    window: { since: actWin.since, until: actWin.until },
    counts: countsRes.rows[0],
    ads: rows.map((r) => ({
      meta_ad_id: r.meta_ad_id,
      ad_name: r.ad_name,
      effective_status: r.effective_status,
      created_time: r.created_time ? r.created_time.toISOString() : null,
      match_status: r.match_status,
      matched_ad_setup_id: r.matched_ad_setup_id,
      recent_spend: Number(r.spend),
      last_active: r.last_active ? new Date(r.last_active).toISOString().slice(0, 10) : null,
      skipped: !!r.skipped_at,
      excluded: r.excluded,
      not_product_specific: r.not_product_specific,
      confirmed_products: r.confirmed_products,
      confirmed_concept: r.confirmed_concept,
      confirmed_creator: r.confirmed_creator,
      confirmed_media: r.confirmed_media ? MEDIA_LABEL[r.confirmed_media] : null,
      suggested_media: r.suggested_media,
      suggested_product: r.suggested_product,
      suggested_concept: r.suggested_concept,
      confidence: r.top_confidence === null ? null : Number(r.top_confidence),
      confidence_level: r.top_confidence === null ? null : confidenceLevel(r.top_confidence),
      // "Exact" is reserved for ads that were actually auto-matched; anything still
      // awaiting a person is at best "Likely".
      confidence_label: r.match_status === 'auto_matched' && r.match_confidence !== null ? confidenceLabel(r.match_confidence)
        : r.top_confidence === null ? null : (confidenceLabel(r.top_confidence) === 'Exact' ? 'Likely' : confidenceLabel(r.top_confidence)),
    })),
  };
}

// ── Workspace ───────────────────────────────────────────────────────────
function describeAdSetup(s) {
  if (!s) return null;
  return {
    id: s.id,
    generated_name: s.generated_name,
    status: s.status,
    concept_name: s.concept_name,
    product_label: s.product_label,
    creator_name: s.creator_name,
    concept_label: s.concept_label,
    creative_asset_id: s.creative_asset_id,
    final_edit_id: s.final_edit_id,
  };
}

async function getAdWorkspace(metaAdId, { refresh = true } = {}) {
  const loadRow = () => pool.query(
    `SELECT a.*, c.not_product_specific, c.concept_type_id, c.concept_label, c.creative_style_id, c.creator_name, c.media_type,
            COALESCE(c.excluded_from_intelligence, false) AS excluded, c.excluded_reason, c.skipped_at, c.auto_match_blocked_at, c.auto_fields
       FROM meta_ads a LEFT JOIN meta_ad_classifications c ON c.meta_ad_id = a.meta_ad_id
      WHERE a.meta_ad_id = $1`,
    [metaAdId]
  );
  const { rows } = await loadRow();
  if (!rows.length) throw new HttpError(404, 'Ad not found');
  let ad = rows[0];
  const ctx = await loadContext();

  if (refresh && ad.match_status !== 'confirmed' && !ad.excluded) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await refreshSuggestionsForAd(client, ad, ctx);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    ad = (await loadRow()).rows[0]; // auto-matching may just have written the classification
  }

  const win = scopeWindow('30d');
  const [recent, life, products, sugg] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(spend),0) spend, COALESCE(SUM(purchases),0) purchases, COALESCE(SUM(purchase_value),0) purchase_value,
              COALESCE(SUM(add_to_cart),0) add_to_cart, COALESCE(SUM(outbound_clicks),0) outbound_clicks,
              COALESCE(SUM(impressions),0) impressions, COUNT(*)::int AS days
         FROM meta_ad_insights_daily WHERE meta_ad_id = $1 AND insight_date BETWEEN $2 AND $3`,
      [metaAdId, win.since, win.until]
    ),
    pool.query(
      `SELECT COALESCE(SUM(spend),0) spend, to_char(MIN(insight_date),'YYYY-MM-DD') first_date, to_char(MAX(insight_date),'YYYY-MM-DD') last_date
         FROM meta_ad_insights_daily WHERE meta_ad_id = $1`,
      [metaAdId]
    ),
    pool.query('SELECT product_code, product_name FROM meta_ad_products WHERE meta_ad_id = $1 ORDER BY product_name', [metaAdId]),
    pool.query('SELECT field, value_key, value_label, value_ref, confidence, reason, source, evidence FROM meta_ad_suggestions WHERE meta_ad_id = $1 ORDER BY confidence DESC, value_label', [metaAdId]),
  ]);

  const suggestions = { product: [], concept: [], creator: [], creative_style: [], ad_setup: [], scope: [], media_type: [] };
  sugg.rows.forEach((s) => {
    const item = {
      value_key: s.value_key, value_label: s.value_label, value_ref: s.value_ref,
      confidence: Number(s.confidence), confidence_level: confidenceLevel(s.confidence), confidence_label: confidenceLabel(s.confidence), reason: s.reason, source: s.source, evidence: s.evidence,
    };
    if (s.field === 'ad_setup') item.ad_setup = describeAdSetup(ctx.adSetupById.get(s.value_ref));
    suggestions[s.field].push(item);
  });

  const structuredParse = parseStructuredMetaName(ad.ad_name);
  const parsed = { legacy: parseMetaAdName(ad.ad_name), structured: structuredParse, loose: structuredParse ? null : parseLooseMetaName(ad.ad_name, ctx) };
  const confirmed = ad.match_status === 'confirmed';
  const autoMatched = ad.match_status === 'auto_matched';
  // Why an ad is (not) auto-matchable, from the CURRENT evidence -- shown as a
  // short note so a reviewer knows what to look at.
  const autoEval = evaluateAutoMatch(ad, buildSuggestions({ ad_name: ad.ad_name || '' }, ctx), ctx);
  return {
    ad: {
      meta_ad_id: ad.meta_ad_id, ad_name: ad.ad_name, effective_status: ad.effective_status,
      created_time: ad.created_time ? ad.created_time.toISOString() : null,
      meta_campaign_id: ad.meta_campaign_id, meta_adset_id: ad.meta_adset_id, meta_creative_id: ad.meta_creative_id,
      match_status: ad.match_status, match_method: ad.match_method,
      match_confirmed_at: ad.match_confirmed_at ? new Date(ad.match_confirmed_at).toISOString() : null,
    },
    performance: {
      window: { since: win.since, until: win.until, label: 'Last 30 days' },
      recent: deriveMetrics(recent.rows[0]),
      active_days: recent.rows[0].days,
      lifetime_spend: Number(life.rows[0].spend),
      first_active: life.rows[0].first_date,
      last_active: life.rows[0].last_date,
    },
    parsed,
    classification: {
      confirmed,
      auto_matched: autoMatched,
      auto_match_blocked: !!ad.auto_match_blocked_at,
      review_reasons: confirmed ? [] : autoEval.blockers,
      // Per-field provenance of the machine's own values (null for human-confirmed).
      auto_fields: confirmed ? null : (ad.auto_fields || null),
      left_blank: autoMatched ? autoEval.left_blank : [],
      excluded: ad.excluded,
      excluded_reason: ad.excluded_reason || null,
      skipped: !!ad.skipped_at,
      not_product_specific: !!ad.not_product_specific,
      products: products.rows,
      concept: ad.concept_label ? { concept_type_id: ad.concept_type_id, label: ad.concept_label, legacy: ad.concept_type_id === null } : null,
      creative_style_id: ad.creative_style_id,
      creator_name: ad.creator_name,
      media_type: ad.media_type || null,
      ad_setup: describeAdSetup(ctx.adSetupById.get(ad.matched_ad_setup_id)),
    },
    suggestions,
  };
}

// ── Human actions ───────────────────────────────────────────────────────
function trimText(v, max = 255) {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, max) : null;
}

// The ONLY way a classification becomes confirmed. Validates every
// reference against the live vocabularies, then writes classification +
// products + the existing meta_ads match_* fields in one transaction under
// a row lock (so it serialises with suggestion runs).
async function confirmMapping(metaAdId, body, userId) {
  const input = body || {};
  const notProductSpecific = input.not_product_specific === true;
  const productCodes = [...new Set((Array.isArray(input.product_codes) ? input.product_codes : []).map((c) => String(c).trim()).filter(Boolean))];
  if (notProductSpecific && productCodes.length) throw new HttpError(400, '"Not product-specific" can’t be combined with products');
  if (!notProductSpecific && !productCodes.length) throw new HttpError(400, 'Choose at least one product, or mark the ad "Not product-specific"');

  const families = await listProductFamilies();
  const famByCode = new Map(families.map((f) => [f.product_code, f]));
  const unknown = productCodes.filter((c) => !famByCode.has(c));
  if (unknown.length) throw new HttpError(400, `Unknown product family: ${unknown.join(', ')}`);

  let conceptTypeId = null;
  let conceptLabel = null;
  if (input.concept && (input.concept.concept_type_id || input.concept.label)) {
    if (input.concept.concept_type_id) {
      const r = await pool.query('SELECT id, name FROM concept_types WHERE id = $1', [parseInt(input.concept.concept_type_id, 10)]);
      if (!r.rows.length) throw new HttpError(400, 'Unknown concept');
      conceptTypeId = r.rows[0].id;
      conceptLabel = r.rows[0].name;
    } else {
      // Legacy / free-text classification: kept ONLY on this ad's
      // classification -- never inserted into concept_types.
      conceptLabel = trimText(input.concept.label);
    }
  }
  let styleId = null;
  if (input.creative_style_id) {
    const r = await pool.query('SELECT id FROM creative_styles WHERE id = $1', [parseInt(input.creative_style_id, 10)]);
    if (!r.rows.length) throw new HttpError(400, 'Unknown creative style');
    styleId = r.rows[0].id;
  }
  let adSetupId = null;
  if (input.ad_setup_id) {
    const r = await pool.query('SELECT id FROM ad_setups WHERE id = $1', [parseInt(input.ad_setup_id, 10)]);
    if (!r.rows.length) throw new HttpError(400, 'Unknown Ad Setup');
    adSetupId = r.rows[0].id;
  }
  const creator = trimText(input.creator_name);
  // Media Type is optional; 'unknown' is a deliberate human answer, NULL = undecided.
  let mediaType = null;
  if (input.media_type !== undefined && input.media_type !== null && input.media_type !== '') {
    if (!MEDIA_KEYS.has(input.media_type)) throw new HttpError(400, 'Unknown media type');
    mediaType = input.media_type;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query('SELECT meta_ad_id FROM meta_ads WHERE meta_ad_id = $1 FOR UPDATE', [metaAdId]);
    if (!lock.rows.length) throw new HttpError(404, 'Ad not found');
    await client.query(
      `INSERT INTO meta_ad_classifications (meta_ad_id, not_product_specific, concept_type_id, concept_label, creative_style_id, creator_name, media_type, skipped_at, classified_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8)
       ON CONFLICT (meta_ad_id) DO UPDATE SET
         not_product_specific = EXCLUDED.not_product_specific, concept_type_id = EXCLUDED.concept_type_id,
         concept_label = EXCLUDED.concept_label, creative_style_id = EXCLUDED.creative_style_id,
         creator_name = EXCLUDED.creator_name, media_type = EXCLUDED.media_type, skipped_at = NULL,
         auto_fields = NULL, classified_by_user_id = EXCLUDED.classified_by_user_id, updated_at = now()`,
      [metaAdId, notProductSpecific, conceptTypeId, conceptLabel, styleId, creator, mediaType, userId || null]
    );
    await client.query('DELETE FROM meta_ad_products WHERE meta_ad_id = $1', [metaAdId]);
    for (const code of productCodes) {
      await client.query('INSERT INTO meta_ad_products (meta_ad_id, product_code, product_name) VALUES ($1,$2,$3)', [metaAdId, code, famByCode.get(code).product_name]);
    }
    await client.query(
      `UPDATE meta_ads SET match_status = 'confirmed', matched_ad_setup_id = $2, match_method = 'manual', match_confidence = 1,
              match_confirmed_at = now(), match_confirmed_by_user_id = $3, match_suggestions_at = now()
        WHERE meta_ad_id = $1`,
      [metaAdId, adSetupId, userId || null]
    );
    await client.query('DELETE FROM meta_ad_suggestions WHERE meta_ad_id = $1', [metaAdId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  let similarApplied = 0;
  if (!notProductSpecific && productCodes.length === 1) {
    try { similarApplied = await reapplyTrustedPair(metaAdId); } catch (err) { /* best effort */ }
  }
  const workspace = await getAdWorkspace(metaAdId, { refresh: false });
  workspace.auto_applied_to_similar = similarApplied;
  return workspace;
}

// After a person confirms a single-product mapping, every OTHER not-yet-
// classified ad with the same structured Product + Category is re-evaluated
// so the now-trusted pair is applied to the historical backlog straight away
// (future ads pick it up through loadContext). Confirmed/excluded/blocked ads
// are skipped inside refreshSuggestionsForAd. Best effort: never fails the
// confirmation that triggered it. Local database only.
async function reapplyTrustedPair(metaAdId) {
  const r = await pool.query('SELECT ad_name FROM meta_ads WHERE meta_ad_id = $1', [metaAdId]);
  const st = r.rows.length ? parseStructuredMetaName(r.rows[0].ad_name) : null;
  if (!st || !st.product_name || !st.product_category) return 0;
  const cands = await pool.query(
    `SELECT meta_ad_id, ad_name FROM meta_ads
      WHERE match_status IN ('unmatched', 'suggested') AND meta_ad_id <> $1
        AND ad_name ILIKE $2 ESCAPE '\\' AND ad_name ILIKE $3 ESCAPE '\\'
      LIMIT 2000`,
    [metaAdId, `%${escapeLike(st.product_name)}%`, `%${escapeLike(st.product_category)}%`]
  );
  if (!cands.rows.length) return 0;
  const ctx = await loadContext();
  let applied = 0;
  for (const ad of cands.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await refreshSuggestionsForAd(client, ad, ctx);
      await client.query('COMMIT');
      if (out.auto_matched) applied += 1;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
    } finally {
      client.release();
    }
  }
  return applied;
}

async function ensureAd(metaAdId) {
  const r = await pool.query('SELECT meta_ad_id FROM meta_ads WHERE meta_ad_id = $1', [metaAdId]);
  if (!r.rows.length) throw new HttpError(404, 'Ad not found');
}

// "Skip for now": records nothing about the ad's classification -- the
// match_status is untouched; the ad just sorts to the bottom of the queue.
async function skipAd(metaAdId, userId) {
  await ensureAd(metaAdId);
  await pool.query(
    `INSERT INTO meta_ad_classifications (meta_ad_id, skipped_at, classified_by_user_id) VALUES ($1, now(), $2)
     ON CONFLICT (meta_ad_id) DO UPDATE SET skipped_at = now(), updated_at = now()`,
    [metaAdId, userId || null]
  );
  return getAdWorkspace(metaAdId, { refresh: false });
}

// Reversible "Not relevant for creative intelligence".
async function setExcluded(metaAdId, excluded, reason, userId) {
  await ensureAd(metaAdId);
  await pool.query(
    `INSERT INTO meta_ad_classifications (meta_ad_id, excluded_from_intelligence, excluded_reason, excluded_at, classified_by_user_id)
     VALUES ($1, $2, $3, CASE WHEN $2 THEN now() END, $4)
     ON CONFLICT (meta_ad_id) DO UPDATE SET
       excluded_from_intelligence = EXCLUDED.excluded_from_intelligence,
       excluded_reason = CASE WHEN EXCLUDED.excluded_from_intelligence THEN EXCLUDED.excluded_reason END,
       excluded_at = CASE WHEN EXCLUDED.excluded_from_intelligence THEN now() END,
       updated_at = now()`,
    [metaAdId, !!excluded, excluded ? trimText(reason) : null, userId || null]
  );
  return getAdWorkspace(metaAdId, { refresh: false });
}

// Explicit reset of a mistaken confirmation back to a clean unmatched ad
// (suggestions recompute on the next open). Keeps the excluded flag.
async function clearMapping(metaAdId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query('SELECT meta_ad_id FROM meta_ads WHERE meta_ad_id = $1 FOR UPDATE', [metaAdId]);
    if (!lock.rows.length) throw new HttpError(404, 'Ad not found');
    await client.query('DELETE FROM meta_ad_products WHERE meta_ad_id = $1', [metaAdId]);
    // The block stops the auto-matcher from re-applying a mapping a person has
    // just overruled; it still suggests (so the ad lands in Needs review).
    await client.query(
      `INSERT INTO meta_ad_classifications (meta_ad_id, auto_match_blocked_at) VALUES ($1, now())
       ON CONFLICT (meta_ad_id) DO UPDATE SET
         not_product_specific = false, concept_type_id = NULL, concept_label = NULL,
         creative_style_id = NULL, creator_name = NULL, media_type = NULL, skipped_at = NULL,
         auto_fields = NULL, auto_match_blocked_at = now(), updated_at = now()`,
      [metaAdId]
    );
    await client.query(
      `UPDATE meta_ads SET match_status = 'unmatched', matched_ad_setup_id = NULL, match_method = NULL, match_confidence = NULL,
              match_confirmed_at = NULL, match_confirmed_by_user_id = NULL, match_suggestions_at = NULL
        WHERE meta_ad_id = $1`,
      [metaAdId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return getAdWorkspace(metaAdId, { refresh: true });
}

// ── Selector data ───────────────────────────────────────────────────────
async function listOptions() {
  const [families, concepts, styles, creators] = await Promise.all([
    listProductFamilies(),
    pool.query('SELECT id, name, format FROM concept_types WHERE active ORDER BY sort_order, name'),
    pool.query('SELECT id, name, media_type FROM creative_styles ORDER BY sort_order, name'),
    pool.query('SELECT name FROM content_creators ORDER BY name'),
  ]);
  return {
    products: families.map((f) => ({ key: f.product_code, label: f.product_name })),
    concepts: concepts.rows.map((c) => ({ id: c.id, label: c.name, format: c.format })),
    creative_styles: styles.rows.map((s) => ({ id: s.id, label: s.name, media_type: s.media_type })),
    creators: creators.rows.map((c) => c.name),
    media_types: MEDIA_TYPES,
  };
}

async function searchAdSetups(q) {
  const ctx = await loadContext();
  const term = String(q || '').trim().toUpperCase();
  return ctx.adSetups
    .filter((s) => !term
      || s.generated_name.toUpperCase().includes(term)
      || String(s.product_label || '').toUpperCase().includes(term)
      || String(s.concept_name || '').toUpperCase().includes(term)
      || String(s.id) === term)
    .slice(0, 20)
    .map(describeAdSetup);
}

async function adSetupPrefill(id) {
  const ctx = await loadContext();
  const s = ctx.adSetupById.get(parseInt(id, 10));
  if (!s) throw new HttpError(404, 'Ad Setup not found');
  const concept = s.concept_label ? ctx.conceptByNorm.get(norm(s.concept_label)) : null;
  return {
    ad_setup: describeAdSetup(s),
    products: s.product_codes.map((code) => {
      const f = ctx.familyByCode.get(code);
      return { key: code, label: f ? f.product_name : code };
    }),
    concept: s.concept_label ? { concept_type_id: concept ? concept.id : null, label: concept ? concept.name : s.concept_label, legacy: !concept } : null,
    creator_name: s.creator_name,
    creative_style_ids: s.style_ids,
  };
}

// ── Performance follows the classification ──────────────────────────────
// Read-only aggregation over meta_ad_insights_daily through the CONFIRMED
// classification (excluded ads never count). Nothing is precomputed. Answers
// the later questions: performance by Product / Concept / Creator / Creative
// Style, a Concept across products (by=product&concept=...), a Product's
// ads (product_code=...), etc.
// NOTE: an ad with several products appears once under EACH product when
// grouped by product, so per-product rows are not additive to a total.
const GROUPS = {
  product: { select: `p.product_code AS key, p.product_name AS label`, join: 'JOIN meta_ad_products p ON p.meta_ad_id = a.meta_ad_id', group: 'p.product_code, p.product_name' },
  concept: { select: `COALESCE(c.concept_type_id::text, 'legacy:' || lower(c.concept_label)) AS key, c.concept_label AS label`, join: '', group: `COALESCE(c.concept_type_id::text, 'legacy:' || lower(c.concept_label)), c.concept_label`, where: 'c.concept_label IS NOT NULL' },
  creator: { select: `lower(c.creator_name) AS key, c.creator_name AS label`, join: '', group: 'lower(c.creator_name), c.creator_name', where: 'c.creator_name IS NOT NULL' },
  creative_style: { select: `cs.id::text AS key, cs.name AS label`, join: 'JOIN creative_styles cs ON cs.id = c.creative_style_id', group: 'cs.id, cs.name' },
  media_type: { select: `c.media_type AS key, c.media_type AS label`, join: '', group: 'c.media_type', where: 'c.media_type IS NOT NULL' },
  ad_setup: { select: `a.matched_ad_setup_id::text AS key, 'Ad Setup #' || a.matched_ad_setup_id AS label`, join: '', group: 'a.matched_ad_setup_id', where: 'a.matched_ad_setup_id IS NOT NULL' },
};

async function performanceBy(query = {}) {
  const by = Object.prototype.hasOwnProperty.call(GROUPS, query.by) ? query.by : 'product';
  const parsed = parseRangeParams(query);
  const g = GROUPS[by];
  const params = [parsed.range.since, parsed.range.until];
  // Human-confirmed AND auto-matched ads both follow their classification;
  // ?source=human restricts to human-confirmed only (auto = machine-matched only).
  const sourceSql = query.source === 'human' ? `a.match_status = 'confirmed'` : query.source === 'auto' ? `a.match_status = 'auto_matched'` : `a.match_status IN ('confirmed', 'auto_matched')`;
  const where = [sourceSql, 'NOT c.excluded_from_intelligence', 'd.insight_date BETWEEN $1 AND $2'];
  if (g.where) where.push(g.where);
  if (query.product_code) { params.push(String(query.product_code)); where.push(`EXISTS (SELECT 1 FROM meta_ad_products fp WHERE fp.meta_ad_id = a.meta_ad_id AND fp.product_code = $${params.length})`); }
  if (query.concept) { params.push(String(query.concept).toLowerCase()); where.push(`lower(c.concept_label) = $${params.length}`); }
  if (query.creator) { params.push(String(query.creator).toLowerCase()); where.push(`lower(c.creator_name) = $${params.length}`); }
  if (query.media_type) { params.push(String(query.media_type)); where.push(`c.media_type = $${params.length}`); }
  if (query.creative_style_id) { params.push(parseInt(query.creative_style_id, 10)); where.push(`c.creative_style_id = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT ${g.select},
            COUNT(DISTINCT a.meta_ad_id)::int AS ads,
            COALESCE(SUM(d.spend),0) AS spend, COALESCE(SUM(d.purchases),0) AS purchases,
            COALESCE(SUM(d.purchase_value),0) AS purchase_value, COALESCE(SUM(d.add_to_cart),0) AS add_to_cart,
            COALESCE(SUM(d.outbound_clicks),0) AS outbound_clicks, COALESCE(SUM(d.impressions),0) AS impressions
       FROM meta_ad_insights_daily d
       JOIN meta_ads a ON a.meta_ad_id = d.meta_ad_id
       JOIN meta_ad_classifications c ON c.meta_ad_id = a.meta_ad_id
       ${g.join}
      WHERE ${where.join(' AND ')}
      GROUP BY ${g.group}
      ORDER BY SUM(d.spend) DESC, 1`,
    params
  );
  return {
    by, range: parsed.range,
    note: by === 'product' ? 'An ad with several products is counted under each of its products, so product rows do not add up to a total.' : undefined,
    rows: rows.map((r) => ({ key: r.key, label: by === 'media_type' ? (MEDIA_LABEL[r.key] || r.key) : r.label, ads: r.ads, ...deriveMetrics(r) })),
  };
}

module.exports = {
  confidenceLevel,
  norm,
  parseStructuredMetaName,
  parseLooseMetaName,
  loadContext,
  buildSuggestions,
  evaluateAutoMatch,
  confidenceLabel,
  refreshSuggestions,
  refreshSuggestionsForAd,
  startBacklogReprocess,
  stopBacklogReprocess,
  getBacklogStatus,
  HUMAN_OWNED_SQL,
  AUTO_RULES_VERSION,
  getQueue,
  getAdWorkspace,
  confirmMapping,
  skipAd,
  setExcluded,
  clearMapping,
  listOptions,
  searchAdSetups,
  adSetupPrefill,
  performanceBy,
  scopeWindow,
};
