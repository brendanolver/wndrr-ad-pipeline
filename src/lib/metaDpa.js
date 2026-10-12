// Dynamic Product Ads (DPAs): catalogue ads that show whichever products a person browsed. They are not creative the team made for a product, so they must
// not count as a product's creative coverage and are left out of the creative-performance views by default. Nothing is deleted or altered: the Meta rows
// stay exactly as stored and the exclusion is applied when reading (a view parameter), so the data is always one switch away.
//
// HOW A DPA IS RECOGNISED (established WNDRR conventions found in this codebase, strongest and least ambiguous first):
//   1. a PERSON classified the ad's concept as "DPA" (Ad Matching, meta_ad_classifications.concept_label; "DPA" is one of the approved concept names);
//   2. Meta's own campaign objective is PRODUCT_CATALOG_SALES (catalogue sales campaigns are how Meta runs DPAs; read from meta_campaigns.objective);
//   3. the ad name or the campaign name carries "DPA" as a WHOLE WORD (delimited by anything that is not a letter or digit: "DPA - Catalogue", "[DPA]",
//      "WNDRR_DPA_BAU"). This is the same word-boundary rule Ad Matching already uses (metaAdMatching.js): "ADPAD" or "DPAX" never match.
// Not used: Meta's creative `product_set_id` / `template_data` (the sync does not store them), and any other substring.
// KNOWN LIMIT: an ad that is a DPA but is not named or classified as one and sits in a non-catalogue campaign cannot be recognised from stored data. The
// Meta Performance page keeps an "Include DPAs" switch, and the classification route lets a person label such an ad "DPA" once.
const OBJECTIVES = ['PRODUCT_CATALOG_SALES'];
const WORD_RE = /(^|[^A-Za-z0-9])DPA([^A-Za-z0-9]|$)/i;
// the same rule as a Postgres regular expression (case-insensitive match operator ~*)
const WORD_PG = "(^|[^A-Za-z0-9])DPA([^A-Za-z0-9]|$)";

// pure: why an ad is a DPA ('classified' | 'objective' | 'ad_name' | 'campaign_name'), or null
function dpaReason({ ad_name = null, campaign_name = null, objective = null, concept_label = null } = {}) {
  if (concept_label && String(concept_label).trim().toUpperCase() === 'DPA') return 'classified';
  if (objective && OBJECTIVES.includes(String(objective).trim().toUpperCase())) return 'objective';
  if (ad_name && WORD_RE.test(String(ad_name))) return 'ad_name';
  if (campaign_name && WORD_RE.test(String(campaign_name))) return 'campaign_name';
  return null;
}
const isDpa = (ad) => dpaReason(ad) !== null;

// SQL predicate: TRUE for a DPA ad. adAlias = the meta_ads alias, campAlias = the meta_campaigns alias (LEFT JOINed; may be NULL). No user input is interpolated.
function dpaPredicate(adAlias = 'a', campAlias = 'mc') {
  return `(COALESCE(UPPER(${campAlias}.objective), '') IN (${OBJECTIVES.map((o) => `'${o}'`).join(', ')})
    OR ${adAlias}.ad_name ~* '${WORD_PG}'
    OR ${campAlias}.name ~* '${WORD_PG}'
    OR EXISTS (SELECT 1 FROM meta_ad_classifications dpc WHERE dpc.meta_ad_id = ${adAlias}.meta_ad_id AND UPPER(TRIM(dpc.concept_label)) = 'DPA'))`;
}
// The same rule for queries that do not join meta_campaigns: the campaign is looked up by a correlated EXISTS.
function dpaPredicateStandalone(adAlias = 'm') {
  return `(${adAlias}.ad_name ~* '${WORD_PG}'
    OR EXISTS (SELECT 1 FROM meta_campaigns dpmc WHERE dpmc.meta_campaign_id = ${adAlias}.meta_campaign_id
                 AND (COALESCE(UPPER(dpmc.objective), '') IN (${OBJECTIVES.map((o) => `'${o}'`).join(', ')}) OR dpmc.name ~* '${WORD_PG}'))
    OR EXISTS (SELECT 1 FROM meta_ad_classifications dpc WHERE dpc.meta_ad_id = ${adAlias}.meta_ad_id AND UPPER(TRIM(dpc.concept_label)) = 'DPA'))`;
}
const notDpaStandalone = (adAlias = 'm') => `NOT COALESCE(${dpaPredicateStandalone(adAlias)}, false)`;

// SQL predicate: TRUE for an ad that is NOT a DPA (NULL-safe)
const notDpaPredicate = (adAlias, campAlias) => `NOT COALESCE(${dpaPredicate(adAlias, campAlias)}, false)`;

// ?dpa=include|exclude (default exclude). `exclude` is the default everywhere creative performance is judged.
function parseDpaMode(query = {}) { return String(query.dpa || '').toLowerCase() === 'include' ? 'include' : 'exclude'; }

module.exports = { OBJECTIVES, WORD_RE, dpaReason, isDpa, dpaPredicate, dpaPredicateStandalone, notDpaPredicate, notDpaStandalone, parseDpaMode };
