// Concept inventory for Ad Matching: every distinct concept currently in use, with how many UNIQUE CREATIVES (exact meta_creative_id; an
// ad without one counts as its own creative) and how many Meta ADS carry it, split by where it comes from.
//
// READ ONLY. It never merges, renames, deletes or approves anything -- it exists so a person can decide which concepts belong in the
// approved list. Concepts are listed by their EXACT stored text; spelling / capitalisation / punctuation variants are reported next to
// each other, never combined.
//
// Sources
//   confirmed      ads a person confirmed (meta_ad_classifications.concept_label)
//   auto_matched   ads the matcher classified itself (not copies of a person's decision)
//   inherited      ads that carry a person's decision because they are the same exact creative (match_method creative_inherited)
//   suggested      concepts proposed for ads still Unmatched / Needs review (meta_ad_suggestions); an ad with two proposals appears under both
//   ad_setups      WNDRR Ad Setups that name the concept (ad_setups.concept_label); counted in Ad Setups, plus the Meta ads linked to them
//   vocabulary     the concept lists Ad Matching offers today: concept_types (active / inactive) and names added in Ad Matching
// Concept words that exist only inside ad NAMES and have not produced a stored suggestion are not scanned (they have no stored form).
const { pool } = require('../db');
const { keyOf, cleanName } = require('./metaMatchingVocab');

const SOURCES = ['confirmed', 'auto_matched', 'inherited', 'suggested'];

// "Try-On", "try on", "TRY_ON" and "try  on" are one variant family; "&" and "and" too. Nothing fuzzier than that.
function variantKey(text) {
  return String(text == null ? '' : text).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

// pure: aggregate rows -> inventory (kept separate from SQL so it is unit-testable)
// usage rows:   { concept, source|null (null = across sources), creatives, ads }
// setup rows:   { concept, setups, linked_ads }
// vocab rows:   { name, origin: 'concept_types'|'added', active }
function buildInventory({ usage, setups, vocabulary }) {
  const by = new Map();
  const slot = (concept) => {
    if (!by.has(concept)) by.set(concept, { concept, sources: {}, total_creatives: 0, total_ads: 0, ad_setups: { setups: 0, linked_ads: 0 }, vocabulary: null });
    return by.get(concept);
  };
  for (const r of usage) {
    if (r.concept == null || !String(r.concept).trim()) continue;
    const row = slot(r.concept);
    if (r.source === null) { row.total_creatives = r.creatives; row.total_ads = r.ads; } else row.sources[r.source] = { creatives: r.creatives, ads: r.ads };
  }
  for (const r of setups) {
    if (r.concept == null || !String(r.concept).trim()) continue;
    slot(r.concept).ad_setups = { setups: r.setups, linked_ads: r.linked_ads };
  }
  const vocabByExact = new Map(vocabulary.map((v) => [v.name, v]));
  const vocabByKey = new Map();
  for (const v of vocabulary) if (!vocabByKey.has(keyOf(v.name))) vocabByKey.set(keyOf(v.name), v);
  for (const v of vocabulary) slot(v.name); // vocabulary entries nobody uses yet still appear (zero counts)
  const concepts = [...by.values()].map((row) => {
    const exact = vocabByExact.get(row.concept);
    const ci = vocabByKey.get(keyOf(row.concept));
    row.vocabulary = exact
      ? { match: 'exact', origin: exact.origin, active: exact.active }
      : ci ? { match: 'case_insensitive', name: ci.name, origin: ci.origin, active: ci.active } : { match: 'none' };
    for (const s of SOURCES) if (!row.sources[s]) row.sources[s] = { creatives: 0, ads: 0 };
    row.variant_key = variantKey(row.concept);
    return row;
  });
  // variant families: same normalised text, more than one exact spelling
  const fam = new Map();
  for (const c of concepts) { if (!fam.has(c.variant_key)) fam.set(c.variant_key, []); fam.get(c.variant_key).push(c); }
  const variantGroups = [];
  for (const [key, members] of fam) {
    if (key && members.length > 1) {
      variantGroups.push({ key, variants: members.map((m) => ({ concept: m.concept, total_creatives: m.total_creatives, total_ads: m.total_ads })).sort((a, b) => b.total_creatives - a.total_creatives || a.concept.localeCompare(b.concept)) });
      for (const m of members) m.variants_of = members.filter((x) => x !== m).map((x) => x.concept);
    }
  }
  concepts.sort((a, b) => b.total_creatives - a.total_creatives || b.total_ads - a.total_ads || a.concept.localeCompare(b.concept));
  variantGroups.sort((a, b) => b.variants.reduce((n, v) => n + v.total_creatives, 0) - a.variants.reduce((n, v) => n + v.total_creatives, 0));
  return {
    totals: {
      distinct_concepts: concepts.length,
      distinct_after_ignoring_case_and_punctuation: fam.size,
      in_use: concepts.filter((c) => c.total_ads > 0 || c.ad_setups.setups > 0).length,
      not_in_vocabulary: concepts.filter((c) => c.vocabulary.match === 'none').length,
      variant_groups: variantGroups.length,
    },
    concepts, variant_groups: variantGroups,
  };
}

async function getInventory(db = pool) {
  const [usage, setups, types, added] = await Promise.all([
    db.query(
      `WITH uses AS (
         SELECT c.concept_label AS concept,
                CASE WHEN a.match_status = 'confirmed' THEN 'confirmed'
                     WHEN a.match_method = 'creative_inherited' THEN 'inherited'
                     ELSE 'auto_matched' END AS source,
                COALESCE(a.meta_creative_id, a.meta_ad_id) AS unit, a.meta_ad_id
           FROM meta_ad_classifications c JOIN meta_ads a ON a.meta_ad_id = c.meta_ad_id
          WHERE c.concept_label IS NOT NULL AND btrim(c.concept_label) <> '' AND a.match_status IN ('confirmed', 'auto_matched')
         UNION ALL
         SELECT s.value_label, 'suggested', COALESCE(a.meta_creative_id, a.meta_ad_id), a.meta_ad_id
           FROM meta_ad_suggestions s JOIN meta_ads a ON a.meta_ad_id = s.meta_ad_id
          WHERE s.field = 'concept' AND s.value_label IS NOT NULL AND btrim(s.value_label) <> '' AND a.match_status IN ('unmatched', 'suggested')
       )
       SELECT concept, CASE WHEN GROUPING(source) = 1 THEN NULL ELSE source END AS source,
              count(DISTINCT unit)::int AS creatives, count(DISTINCT meta_ad_id)::int AS ads
         FROM uses GROUP BY GROUPING SETS ((concept, source), (concept))`),
    db.query(
      `SELECT s.concept_label AS concept, count(*)::int AS setups,
              (SELECT count(*)::int FROM meta_ads m WHERE m.matched_ad_setup_id = ANY(array_agg(s.id))) AS linked_ads
         FROM ad_setups s WHERE s.concept_label IS NOT NULL AND btrim(s.concept_label) <> '' GROUP BY s.concept_label`),
    db.query('SELECT name, active FROM concept_types ORDER BY name'),
    db.query("SELECT name FROM meta_matching_vocab WHERE kind = 'concept' ORDER BY name"),
  ]);
  const vocabulary = [
    ...types.rows.map((r) => ({ name: r.name, origin: 'concept_types', active: !!r.active })),
    ...added.rows.map((r) => ({ name: r.name, origin: 'added', active: true })),
  ];
  const inv = buildInventory({ usage: usage.rows, setups: setups.rows, vocabulary });
  inv.generated_at = new Date().toISOString();
  inv.read_only = true;
  inv.notes = [
    'Counts are UNIQUE CREATIVES (exact meta_creative_id; an ad without one is its own creative) and, separately, Meta ADS. The same creative running in 5 ads is 1 creative and 5 ads.',
    'Concepts are listed by their exact stored text. Variants (case, punctuation, "&" vs "and") are shown side by side and are NOT merged.',
    '"suggested" counts every concept proposed for ads still awaiting review; an ad with two proposals appears under both.',
    'Nothing here changes an approved list: the approved concept list is decided by a person.',
  ];
  return inv;
}

function inventoryCsv(inv) {
  const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['concept', 'total_unique_creatives', 'total_meta_ads',
    'confirmed_creatives', 'confirmed_ads', 'auto_matched_creatives', 'auto_matched_ads', 'inherited_creatives', 'inherited_ads', 'suggested_creatives', 'suggested_ads',
    'ad_setups', 'ad_setup_linked_ads', 'in_vocabulary', 'vocabulary_origin', 'variants_of'];
  const lines = [head.join(',')];
  for (const c of inv.concepts) {
    lines.push([c.concept, c.total_creatives, c.total_ads,
      c.sources.confirmed.creatives, c.sources.confirmed.ads, c.sources.auto_matched.creatives, c.sources.auto_matched.ads, c.sources.inherited.creatives, c.sources.inherited.ads, c.sources.suggested.creatives, c.sources.suggested.ads,
      c.ad_setups.setups, c.ad_setups.linked_ads, c.vocabulary.match, c.vocabulary.origin || '', (c.variants_of || []).join(' | ')].map(esc).join(','));
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { SOURCES, variantKey, buildInventory, getInventory, inventoryCsv, cleanName };
