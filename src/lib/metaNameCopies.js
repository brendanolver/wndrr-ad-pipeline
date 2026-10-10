// Name-based DUPLICATE CANDIDATES for Ad Matching: an ad duplicated in Meta usually gets a NEW creative id, so the exact-creative-id
// inheritance (metaCreativeIdentity.js, unchanged) cannot see it. This module finds ads whose NAMES differ only by a recognised
// trailing copy suffix and offers -- never silently applies -- the classification a person just confirmed.
//
// THE RULES (exact, no fuzzy matching of any kind):
//   1. Only a recognised TRAILING copy suffix is removed: whitespace, a dash (-, en dash, em dash, minus), whitespace, the word
//      "Copy" in any capitalisation, and optionally a number ("Copy 2", "copy3"). Repeated suffixes ("X - Copy - Copy 2") are all
//      removed. Anything else -- "Copy" in the middle of a name, "(Copy)", "X Copy", "X-Copy" with no spaces -- is NOT a suffix.
//   2. After removing it, the remainder must match EXACTLY (case-sensitive, internal spacing as written; only the ends are trimmed).
//      No fuzzy / partial / similar-name matching, no campaign similarity, no shared product keywords.
//   3. Name equality is a CANDIDATE signal only. It never proves the creative assets are identical, so applying a classification
//      across different creative ids needs an explicit approval (the endpoint takes the exact ads the person was shown).
//
// WHAT IS NEVER TOUCHED when a person approves:
//   * an ad (or any ad of its creative) a person already classified, skipped, excluded or linked to an Ad Setup;
//   * an ad a person rejected; an ad whose creative has competing human decisions;
//   * a machine auto-match whose product decision disagrees (surfaced as a conflict instead).
// Eligible copies are written through the SAME confirmMapping() path (same validation, same exact-creative inheritance for their own
// copies), inside one guarded transaction that re-checks eligibility under the row lock. Every application is recorded in
// meta_name_copy_applications. Local database only: no Meta call, no ApparelMagic call.
const { pool } = require('../db');
const { HttpError } = require('./metaPerformance');
const creativeIdentity = require('./metaCreativeIdentity');

const COPY_SUFFIX_RE = /\s+[-–—−]\s+copy(?:\s*\d{1,3})?\s*$/i; // " - Copy", " – Copy 2", "  —  copy3" ...
const MAX_SUFFIXES = 6;
const MAX_COPY_IDS = 200;

// -> { base, stripped }   base = the name with every trailing copy suffix removed (ends trimmed); stripped = how many were removed.
// A name that would be empty after stripping (e.g. " - Copy") is returned unchanged.
function normaliseAdName(name) {
  let base = String(name == null ? '' : name).replace(/\s+$/, '').replace(/^\s+/, '');
  let stripped = 0;
  while (stripped < MAX_SUFFIXES) {
    const next = base.replace(COPY_SUFFIX_RE, '').replace(/\s+$/, '');
    if (next === base || !next) break;
    base = next; stripped += 1;
  }
  return { base, stripped };
}
const baseOf = (name) => normaliseAdName(name).base;

// ── pure grouping logic (no database) ───────────────────────────────────
// ad row: { meta_ad_id, ad_name, meta_creative_id, match_status, eligible, ineligible_reason, nps, codes, concept_key, human_confirmed }
// One creative = one exact meta_creative_id (an ad without one is its own creative).
const creativeKey = (a) => a.meta_creative_id || `ad:${a.meta_ad_id}`;

// The human-confirmed decision of one creative from ITS human rows (every confirmed ad of that exact creative, whatever their names):
// { state: 'none' | 'source' | 'conflict', sig, concept }
function humanState(humanRows) {
  if (!humanRows.length) return { state: 'none' };
  const psigs = new Set(humanRows.map((r) => `${r.nps ? 'nps' : 'p'}|${r.codes || ''}`));
  const concepts = new Set(humanRows.map((r) => r.concept_key).filter(Boolean));
  if (psigs.size > 1 || concepts.size > 1) return { state: 'conflict' };
  const r = humanRows[0];
  return { state: 'source', sig: `${r.nps ? 'nps' : 'p'}|${r.codes || ''}`, concept: r.concept_key || '' };
}
// does a decision (product/NPS + concept) agree with the source decision? Concepts only conflict when BOTH are set and differ.
const sameDecision = (a, b) => a.sig === b.sig && (!a.concept || !b.concept || a.concept === b.concept);

// Classifies every OTHER creative that carries the same normalised name as the source ad.
//   ads          every ad row whose normalised name equals the source's (including the source's own creative)
//   humanByKey   Map(creative key -> humanState) for every creative in `ads`
//   source       { meta_ad_id, creative key, decision }
// -> { eligible: [{ key, rep, ads[] }], already_same: [...], conflicts: [{ key, ads, why }], protected: [{ key, ads, reason }] }
function classifyCopies(ads, humanByKey, source) {
  const out = { eligible: [], already_same: [], conflicts: [], protected: [] };
  const byKey = new Map();
  ads.forEach((a) => { const k = creativeKey(a); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(a); });
  for (const [key, group] of byKey) {
    if (key === source.key) continue; // the source's own creative: exact-creative inheritance already covers it
    const hs = humanByKey.get(key) || { state: 'none' };
    const entry = { key, ads: group.map((a) => ({ meta_ad_id: a.meta_ad_id, ad_name: a.ad_name, match_status: a.match_status })) };
    if (hs.state === 'conflict') { out.conflicts.push({ ...entry, why: 'People classified ads of this creative differently' }); continue; }
    if (hs.state === 'source') {
      if (sameDecision(hs, source.decision)) out.already_same.push(entry);
      else out.conflicts.push({ ...entry, why: 'Already confirmed with a different classification' });
      continue;
    }
    // no human decision on this creative: look at the ads themselves
    const elig = group.filter((a) => a.eligible);
    if (!elig.length) { out.protected.push({ ...entry, reason: group[0].ineligible_reason || 'protected' }); continue; }
    // a machine auto-match whose product decision disagrees is a conflict, not something to overwrite; one that agrees needs nothing
    const rep = elig.slice().sort((a, b) => String(a.meta_ad_id).localeCompare(String(b.meta_ad_id)))[0];
    if (rep.match_status === 'auto_matched') {
      const d = { sig: `${rep.nps ? 'nps' : 'p'}|${rep.codes || ''}`, concept: rep.concept_key || '' };
      if (sameDecision(d, source.decision)) { out.already_same.push(entry); continue; }
      out.conflicts.push({ ...entry, why: 'An automatic match disagrees with this classification' });
      continue;
    }
    out.eligible.push({ ...entry, key, rep: rep.meta_ad_id, rep_name: rep.ad_name, ads_total: group.length, ads_eligible: elig.length });
  }
  return out;
}

// ── database ────────────────────────────────────────────────────────────
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// the ad rows (with eligibility flags) whose normalised name equals `base`, source included
async function loadNameAds(db, base, humanOwnedSql) {
  const { rows } = await db.query(
    `SELECT m.meta_ad_id, m.ad_name, m.meta_creative_id, m.match_status, m.match_method,
            ${creativeIdentity.eligibleSql(humanOwnedSql)} AS eligible, ${creativeIdentity.ineligibleReasonSql(humanOwnedSql)} AS ineligible_reason,
            COALESCE(c.not_product_specific, false) AS nps,
            COALESCE((SELECT string_agg(p.product_code, ',' ORDER BY p.product_code) FROM meta_ad_products p WHERE p.meta_ad_id = m.meta_ad_id), '') AS codes,
            lower(btrim(COALESCE(c.concept_label, ''))) AS concept_key,
            (m.match_status = 'confirmed' AND NOT COALESCE(c.excluded_from_intelligence, false)) AS human_confirmed
       FROM meta_ads m LEFT JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id
      WHERE m.ad_name LIKE $1 ESCAPE '\\'`,
    [`${escapeLike(base)}%`]
  );
  return rows.filter((r) => baseOf(r.ad_name) === base);
}

// human decisions of the given creatives (every confirmed ad of each exact creative, whatever its name)
async function loadHumanStates(db, creativeIds) {
  const out = new Map();
  if (!creativeIds.length) return out;
  const { rows } = await db.query(
    `SELECT m.meta_creative_id, m.meta_ad_id, COALESCE(c.not_product_specific, false) AS nps,
            COALESCE((SELECT string_agg(p.product_code, ',' ORDER BY p.product_code) FROM meta_ad_products p WHERE p.meta_ad_id = m.meta_ad_id), '') AS codes,
            lower(btrim(COALESCE(c.concept_label, ''))) AS concept_key
       FROM meta_ads m JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id
      WHERE m.meta_creative_id = ANY($1::text[]) AND m.match_status = 'confirmed' AND NOT COALESCE(c.excluded_from_intelligence, false)`,
    [creativeIds]
  );
  const by = new Map();
  rows.forEach((r) => { if (!by.has(r.meta_creative_id)) by.set(r.meta_creative_id, []); by.get(r.meta_creative_id).push(r); });
  by.forEach((list, k) => out.set(k, humanState(list)));
  return out;
}

// The offer for ONE just-confirmed ad. Read-only. -> null when the ad has no (confirmed) classification or no name-copies exist.
async function findNameCopies(sourceAdId, { humanOwnedSql }, db = pool) {
  const srcQ = await db.query(
    `SELECT m.meta_ad_id, m.ad_name, m.meta_creative_id, m.match_status, COALESCE(c.excluded_from_intelligence, false) AS excluded
       FROM meta_ads m LEFT JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id WHERE m.meta_ad_id = $1`, [sourceAdId]);
  if (!srcQ.rows.length) throw new HttpError(404, 'Ad not found');
  const src = srcQ.rows[0];
  if (src.match_status !== 'confirmed' || src.excluded || !src.ad_name) return null;
  const { base } = normaliseAdName(src.ad_name);
  const ads = await loadNameAds(db, base, humanOwnedSql);
  if (ads.length < 2) return null;
  const key = src.meta_creative_id || `ad:${src.meta_ad_id}`;
  const creativeIds = [...new Set(ads.map((a) => a.meta_creative_id).filter(Boolean).concat(src.meta_creative_id ? [src.meta_creative_id] : []))];
  const human = await loadHumanStates(db, creativeIds);
  ads.forEach((a) => { if (!a.meta_creative_id && a.human_confirmed) human.set(`ad:${a.meta_ad_id}`, humanState([a])); }); // an ad with no creative id is its own creative
  let decision = human.get(src.meta_creative_id);
  if (!decision || decision.state !== 'source') {
    // the source ad itself is the human decision (its creative may have no creative id)
    const own = ads.find((a) => a.meta_ad_id === src.meta_ad_id);
    if (!own) return null;
    decision = { state: 'source', sig: `${own.nps ? 'nps' : 'p'}|${own.codes || ''}`, concept: own.concept_key || '' };
  }
  const res = classifyCopies(ads, human, { key, decision });
  if (!res.eligible.length && !res.conflicts.length && !res.already_same.length && !res.protected.length) return null;
  return { source_meta_ad_id: sourceAdId, source_name: src.ad_name, base, ...res };
}

// Compact form for the confirm response / review prompt (names capped; the apply endpoint re-derives everything).
function offerSummary(found) {
  if (!found) return null;
  const e = found.eligible;
  return {
    base: found.base,
    eligible_creatives: e.length,
    eligible_ads: e.reduce((n, g) => n + g.ads_eligible, 0),
    copy_ids: e.map((g) => g.rep),
    copies: e.slice(0, 6).map((g) => ({ meta_ad_id: g.rep, ad_name: g.rep_name, ads: g.ads_total })),
    already_same: found.already_same.length,
    conflicts: found.conflicts.slice(0, 6).map((g) => ({ meta_ad_id: g.ads[0].meta_ad_id, ad_name: g.ads[0].ad_name, why: g.why })),
    conflict_count: found.conflicts.length,
    protected: found.protected.length,
  };
}

// The source's stored classification, read from the DATABASE (never from the client), as a confirmMapping payload.
async function sourcePayload(db, sourceAdId) {
  const { rows } = await db.query(
    `SELECT m.match_status, c.not_product_specific, c.concept_type_id, c.concept_label, c.creative_style_id, c.creator_name, c.media_type,
            COALESCE(c.excluded_from_intelligence, false) AS excluded,
            COALESCE((SELECT array_agg(p.product_code ORDER BY p.product_code) FROM meta_ad_products p WHERE p.meta_ad_id = m.meta_ad_id), '{}') AS codes
       FROM meta_ads m LEFT JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id WHERE m.meta_ad_id = $1`, [sourceAdId]);
  const r = rows[0];
  if (!r) throw new HttpError(404, 'Ad not found');
  if (r.match_status !== 'confirmed' || r.excluded) throw new HttpError(409, 'That ad no longer has a confirmed classification to copy');
  return {
    product_codes: r.not_product_specific ? [] : r.codes,
    not_product_specific: !!r.not_product_specific,
    concept: r.concept_label ? { concept_type_id: r.concept_type_id || null, label: r.concept_label } : null,
    creative_style_id: r.creative_style_id || null,
    creator_name: r.creator_name || null,
    media_type: r.media_type || null,
    ad_setup_id: null, // the instance-specific Ad Setup link is never copied
    rapid: true,
  };
}

// Applies the source's classification to the copies the person approved. `copyIds` = the representative ad ids they were shown.
//   deps.confirm(adId, payload, userId, opts)   the ONE confirm path (metaAdMatching.confirmMapping)
//   deps.humanOwnedSql                          the matcher's own "a person owns this" rule
// Serialised per normalised name (advisory lock) so two approvals can never write the same copies twice; each copy is
// re-checked under its row lock inside confirmMapping (opts.requireEligible), so anything that changed since the offer is skipped.
async function applyNameCopies(sourceAdId, copyIdsInput, userId, deps) {
  const ids = [...new Set((Array.isArray(copyIdsInput) ? copyIdsInput : []).map((x) => String(x).trim()).filter((x) => /^[A-Za-z0-9_]{1,64}$/.test(x)))];
  if (!ids.length) throw new HttpError(400, 'Choose the copies to apply the classification to');
  if (ids.length > MAX_COPY_IDS) throw new HttpError(400, `At most ${MAX_COPY_IDS} copies can be applied at once`);
  const src = await pool.query('SELECT ad_name FROM meta_ads WHERE meta_ad_id = $1', [sourceAdId]);
  if (!src.rows.length) throw new HttpError(404, 'Ad not found');
  const { base } = normaliseAdName(src.rows[0].ad_name);
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock(hashtext($1))', [`name_copies:${base}`]);
    const payload = await sourcePayload(pool, sourceAdId);
    const found = await findNameCopies(sourceAdId, { humanOwnedSql: deps.humanOwnedSql });
    const eligibleByRep = new Map(((found && found.eligible) || []).map((g) => [g.rep, g]));
    const applied = []; const skipped = [];
    let inheritedAds = 0;
    for (const id of ids) {
      const group = eligibleByRep.get(id);
      if (!group) { skipped.push({ meta_ad_id: id, reason: 'no longer an eligible copy' }); continue; }
      try {
        const ws = await deps.confirm(id, { ...payload }, userId, {
          requireEligible: true, expectedBase: base,
          afterWrite: async (client) => {
            await client.query(
              `INSERT INTO meta_name_copy_applications (source_meta_ad_id, copy_meta_ad_id, base_name, source_ad_name, copy_ad_name, applied_by_user_id, classification)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [sourceAdId, id, base, src.rows[0].ad_name, group.rep_name, userId || null, JSON.stringify(payload)]
            );
          },
        });
        applied.push({ meta_ad_id: id, ad_name: group.rep_name, creative_key: group.key, same_creative_ads: Number(ws && ws.applied_to_same_creative) || 0 });
        inheritedAds += Number(ws && ws.applied_to_same_creative) || 0;
      } catch (err) {
        if (err && err.code === 'not_eligible') skipped.push({ meta_ad_id: id, reason: err.message });
        else throw err;
      }
    }
    return {
      base, applied, skipped, applied_creatives: applied.length, applied_ads: applied.length + inheritedAds,
      remaining_conflicts: found ? found.conflicts.length : 0,
    };
  } finally {
    await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [`name_copies:${base}`]).catch(() => {});
    lock.release();
  }
}

// ── read-only preview over the WHOLE database (nothing is written) ─────────
// "How many previously confirmed creatives have unreviewed name-copies?" Groups ads by normalised name; a group is an ELIGIBLE
// duplicate group when it has at least one human decision (all human decisions in the group agree) and at least one creative that
// would be offered it. Groups whose decisions disagree are reported separately (conflicts) and never counted as eligible.
async function previewAll({ humanOwnedSql }, db = pool, { sample = 25, full = false } = {}) {
  const { rows } = await db.query(
    `SELECT m.meta_ad_id, m.ad_name, m.meta_creative_id, m.match_status, m.match_method,
            ${creativeIdentity.eligibleSql(humanOwnedSql)} AS eligible, ${creativeIdentity.ineligibleReasonSql(humanOwnedSql)} AS ineligible_reason,
            COALESCE(c.not_product_specific, false) AS nps,
            COALESCE((SELECT string_agg(p.product_code, ',' ORDER BY p.product_code) FROM meta_ad_products p WHERE p.meta_ad_id = m.meta_ad_id), '') AS codes,
            lower(btrim(COALESCE(c.concept_label, ''))) AS concept_key,
            (m.match_status = 'confirmed' AND NOT COALESCE(c.excluded_from_intelligence, false)) AS human_confirmed
       FROM meta_ads m LEFT JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id
      WHERE m.ad_name IS NOT NULL AND btrim(m.ad_name) <> ''`);
  const groups = new Map();
  rows.forEach((r) => { const b = baseOf(r.ad_name); if (!groups.has(b)) groups.set(b, []); groups.get(b).push(r); });
  // human decisions per creative across ALL its ads (a creative's human ad may carry a different name)
  const humanByCreative = new Map();
  const confirmedRows = rows.filter((r) => r.human_confirmed && r.meta_creative_id);
  const cr = new Map();
  confirmedRows.forEach((r) => { if (!cr.has(r.meta_creative_id)) cr.set(r.meta_creative_id, []); cr.get(r.meta_creative_id).push(r); });
  cr.forEach((list, k) => humanByCreative.set(k, humanState(list)));

  const totals = { names_with_several_creatives: 0, eligible_groups: 0, eligible_creatives: 0, eligible_ads: 0, groups_with_conflicts: 0, conflicting_creatives: 0, already_same_creatives: 0, protected_creatives: 0, with_copy_suffix_groups: 0 };
  const samples = []; const conflicts = [];
  for (const [base, ads] of groups) {
    const keys = new Set(ads.map(creativeKey));
    if (keys.size < 2) continue;
    totals.names_with_several_creatives += 1;
    const hasSuffix = ads.some((a) => normaliseAdName(a.ad_name).stripped > 0);
    // per-creative human decision (a creative with no creative id: its own ad when confirmed)
    const human = new Map();
    keys.forEach((k) => {
      if (humanByCreative.has(k)) human.set(k, humanByCreative.get(k));
      else if (k.startsWith('ad:')) { const a = ads.find((x) => creativeKey(x) === k); human.set(k, a && a.human_confirmed ? humanState([a]) : { state: 'none' }); }
    });
    const decided = [...human.entries()].filter(([, h]) => h.state === 'source');
    const anyConflict = [...human.values()].some((h) => h.state === 'conflict');
    const distinct = new Set(decided.map(([, h]) => `${h.sig}`));
    if (!decided.length) continue; // nothing has been decided in this group: nothing to offer
    if (anyConflict || distinct.size > 1) {
      totals.groups_with_conflicts += 1;
      const conflictingCreatives = decided.length + [...human.values()].filter((h) => h.state === 'conflict').length;
      totals.conflicting_creatives += conflictingCreatives;
      if (conflicts.length < sample) conflicts.push({ name: base, creatives: keys.size, decisions: distinct.size });
      continue;
    }
    // all decisions agree: the offer is the first decided creative's decision
    const [srcKey, srcState] = decided[0];
    const res = classifyCopies(ads, human, { key: srcKey, decision: srcState });
    // creatives with their OWN agreeing decision are not offers
    totals.already_same_creatives += res.already_same.length;
    totals.protected_creatives += res.protected.length;
    totals.conflicting_creatives += res.conflicts.length;
    if (res.conflicts.length) totals.groups_with_conflicts += 1;
    if (!res.eligible.length) continue;
    totals.eligible_groups += 1;
    totals.eligible_creatives += res.eligible.length;
    totals.eligible_ads += res.eligible.reduce((n, g) => n + g.ads_eligible, 0);
    if (hasSuffix) totals.with_copy_suffix_groups += 1;
    if (samples.length < sample) samples.push({ name: base, decided_creatives: decided.length, eligible_creatives: res.eligible.length, copies: res.eligible.slice(0, full ? undefined : 3).map((g) => g.rep_name), decided_names: full ? decided.map(([k]) => k) : undefined });
  }
  return { read_only: true, totals, samples, conflicts, rule: 'Names match after removing ONLY a trailing " - Copy" / " - Copy N" suffix; the rest must match exactly.' };
}

const csvCell = (v) => { const t = String(v == null ? '' : v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
// every eligible duplicate group as CSV (read-only)
function previewCsv(preview) {
  const lines = [['name', 'decided_creatives', 'eligible_creatives', 'copy_names'].join(',')];
  preview.samples.forEach((g) => lines.push([g.name, g.decided_creatives, g.eligible_creatives, g.copies.join(' | ')].map(csvCell).join(',')));
  return `${lines.join('\n')}\n`;
}

module.exports = { previewCsv, COPY_SUFFIX_RE, normaliseAdName, baseOf, creativeKey, humanState, sameDecision, classifyCopies, findNameCopies, offerSummary, applyNameCopies, previewAll, MAX_COPY_IDS };
