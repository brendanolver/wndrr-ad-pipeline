// Copy Type: what kind of advertisement a piece of Primary Text is for, which decides which historical examples are used as style references and how the writer is briefed.
//
// The type is worked out automatically from information the Creative Pipeline already holds -- nothing is invented, and a type that needs evidence (a new range, new colourways,
// a bundle, a USA bundle) is only chosen when evidence exists; otherwise the general product-copy fallback is used. A person can override the type on the Ad Setup; the override is
// stored on the Ad Setup (ad_setups.copy_type_override) and always wins until it is reset to "Automatic". Pure functions: no database, no network.

const COPY_TYPES = [
  { value: 'core', label: 'Core / Evergreen', hint: 'An established product that is always available.' },
  { value: 'new_range', label: 'New Range / Drop', hint: 'A product from a new range or drop.' },
  { value: 'new_colourways', label: 'New Colourways', hint: 'Existing product in new colours.' },
  { value: 'bundle', label: 'Bundle', hint: 'A multi-buy or mix-and-match bundle.' },
  { value: 'usa_bundle', label: 'USA Bundle', hint: 'A bundle for the USA store.' },
  { value: 'sale', label: 'Sale / Promotion', hint: 'A sale or promotion (hype, live, mid sale, last chance).' },
  { value: 'general', label: 'General product copy', hint: 'No specific type: plain product copy.' },
];
const VALUES = COPY_TYPES.map((t) => t.value);
const LABELS = Object.fromEntries(COPY_TYPES.map((t) => [t.value, t.label]));
const isCopyType = (v) => VALUES.includes(v);

// Which spreadsheet tabs are the style references for each type. `primary` is used first; `secondary` only fills the remaining places when the primary tabs cannot.
// `families` is the same plan expressed by tab family, for examples that carry no tab name.
const TAB_PLAN = {
  core: { primary: ['CORE 26', 'CORE'], secondary: ['2026 RANGES', '2025 RANGES'], families: { primary: ['core'], secondary: ['ranges'] } },
  new_range: { primary: ['2026 RANGES', '2025 RANGES', '2024 RANGES'], secondary: ['CORE 26', 'CORE'], families: { primary: ['ranges'], secondary: ['core'] } },
  new_colourways: { primary: ['CORE 26', 'CORE', '2026 RANGES', '2025 RANGES', '2024 RANGES'], secondary: [], families: { primary: ['core', 'ranges'], secondary: [] } },
  bundle: { primary: ['BUNDLES 26', 'BUNDLES'], secondary: [], families: { primary: ['bundles'], secondary: [] } },
  usa_bundle: { primary: ['USA - BUNDLES 26'], secondary: ['BUNDLES 26', 'BUNDLES'], families: { primary: [], secondary: ['bundles'] } },
  sale: { primary: ['2026 SALES', 'SALES'], secondary: [], families: { primary: ['sales'], secondary: [] } },
  general: { primary: ['CORE 26', 'CORE', '2026 RANGES', '2025 RANGES'], secondary: ['2024 RANGES'], families: { primary: ['core', 'ranges'], secondary: [] } },
};

// How the writer is briefed for each type (tone and structure only; facts always come from the verified facts).
const GUIDANCE = {
  core: 'Evergreen product ad for a product that is always available. Confident and simple, in WNDRR\'s usual voice. Do not use launch wording (new, just dropped, introducing).',
  new_range: 'A product from a new range or drop. Launch energy is appropriate, but state nothing about the product that is not in the verified facts.',
  new_colourways: 'Existing product now in new colours. You may say new colours are in; do not name, list or count the colours unless they are in the verified facts.',
  bundle: 'A bundle / mix-and-match ad. Talk about the idea of building a set; do not state prices, quantities or savings unless they are in the verified facts.',
  usa_bundle: 'A bundle for the USA store. Same as a bundle: no prices, quantities or savings unless they are in the verified facts; no Australian-only wording.',
  sale: 'A sale or promotion. Follow the campaign stage; the only offer wording allowed is the verified offer.',
  general: 'General product copy. No specific campaign: introduce the product by name and keep to the verified facts. No launch wording and no claims.',
};

const BUNDLE_RE = /\b(?:bundles?|multi-?packs?|mix\s*(?:&|and|n)\s*match|\d+\s*for\s*(?:a?\$|us\$)?\s*\d+|(?:pick|choose|grab)\s+(?:any\s+)?\d+|(?:two|three|2|3)[- ]pack)\b/i;
const USA_RE = /\b(?:usa|u\.s\.a\.?|united states|usd)\b/i;
const US_RE = /\bUS(?: store| market| site| customers?| audience| bundles?| launch)\b/;
const COLOUR_NEWS_RE = /\bnew colou?rs?\b|\bnew colou?rways?\b|\bcolou?rway\s+(?:drop|release|launch|update)s?\b|\bcolou?r\s+(?:drop|alert|refresh)\b/i;
const RECENT_DAYS = 120; // a drop counts as "new" this long after it launched
const UPCOMING_DAYS = 60;

const textOf = (...v) => v.filter((x) => typeof x === 'string' && x.trim()).join(' | ');
const daysBetween = (a, b) => Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86400000);

// evidence: {
//   adCategory: 'core' | 'new_drop' | 'promotion' | 'organic_first'   (the Ad Setup's category, from the planning workflow that created the work)
//   stageType, promotionStageName, promotionName                       (the Promotion stage the ad belongs to, if any)
//   shootPlanSource                                                    ('core' | 'high_stock' | 'drop' | 'momentum' | 'promotion' | 'manual')
//   styles: [{ style_code, name, tier, drop_name, drop_launch_date }]  (the linked catalogue products)
//   productCount                                                       (distinct products linked)
//   planningReason                                                     (why Planning recommended it, if recorded)
//   texts: { conceptName, hook, angle, productLabel, initialIdea, promotionName }   (the creative brief, free text)
//   siblingColourwaysEarlier: boolean                                  (the same product already launched in other colours earlier -- only when the catalogue says so)
//   today: Date
// }
// → { type, label, confidence: 'high' | 'medium' | 'low', fallback: boolean, reasons: string[], newnessAllowed: boolean }
function classifyCopyType(evidence) {
  const e = evidence || {};
  const today = e.today ? new Date(e.today) : new Date();
  const reasons = [];
  const t = e.texts || {};
  const brief = textOf(t.conceptName, t.hook, t.angle, t.productLabel, t.initialIdea, t.promotionName, e.planningReason);
  const styles = Array.isArray(e.styles) ? e.styles : [];
  const done = (type, confidence, extra = {}) => ({
    type, label: LABELS[type], confidence, fallback: type === 'general', reasons, newnessAllowed: type === 'new_range' || type === 'new_colourways', ...extra,
  });

  // 1. Sale / promotion: the ad belongs to a Promotion stage
  if (e.adCategory === 'promotion' || e.promotionStageName) {
    reasons.push(e.promotionStageName ? `Linked to the ${e.promotionName ? `"${e.promotionName}" ` : ''}promotion stage "${e.promotionStageName}".` : 'The Ad Setup category is Promotion / Sale.');
    return done('sale', 'high');
  }

  // 2. Bundle / USA bundle: the brief says so (a bundle is never assumed from the number of products alone)
  const bundleHit = brief.match(BUNDLE_RE);
  if (bundleHit) {
    const usa = USA_RE.test(brief) || US_RE.test(brief);
    reasons.push(`The creative brief mentions "${bundleHit[0]}".`);
    if (Number(e.productCount) > 1) reasons.push(`${e.productCount} products are linked.`);
    if (usa) {
      reasons.push('The brief refers to the USA.');
      return done('usa_bundle', 'high');
    }
    return done('bundle', Number(e.productCount) > 1 ? 'high' : 'medium');
  }

  // 3. New colourways: the brief or the planning reason says so, or the catalogue shows the product launched earlier in other colours
  const colourHit = brief.match(COLOUR_NEWS_RE);
  if (colourHit) {
    reasons.push(`The creative brief or planning reason mentions "${colourHit[0]}".`);
    return done('new_colourways', 'medium');
  }
  if (e.siblingColourwaysEarlier) {
    reasons.push('The catalogue shows this product launched earlier in other colourways.');
    return done('new_colourways', 'medium');
  }

  // 4. New range / drop: planned from Upcoming Drops (or Protect Momentum), or a new-drop product whose drop launched recently / launches soon
  if (e.adCategory === 'new_drop') {
    reasons.push(e.shootPlanSource === 'momentum' ? 'Planned from Protect Momentum (a recent launch).' : 'Planned from Upcoming Drops.');
    const dropStyle = styles.find((s) => s.drop_name);
    if (dropStyle) reasons.push(`Part of the drop "${dropStyle.drop_name}".`);
    return done('new_range', 'high');
  }
  const recentDrop = styles.find((s) => s.tier === 'new_drop' && s.drop_launch_date && (() => { const d = daysBetween(today, s.drop_launch_date); return d <= RECENT_DAYS && d >= -UPCOMING_DAYS; })());
  if (recentDrop) {
    reasons.push(`The product is part of the drop "${recentDrop.drop_name || 'untitled'}" (launch ${String(recentDrop.drop_launch_date).slice(0, 10)}).`);
    return done('new_range', 'medium');
  }

  // 5. Core: planned from Core / High Stock, or the catalogue marks the product as core
  if (e.adCategory === 'core') {
    reasons.push(e.shootPlanSource === 'high_stock' ? 'Planned from High Stocks (an established product).' : 'Planned from Core (an established product).');
    return done('core', 'high');
  }
  if (styles.length && styles.every((s) => s.tier === 'core_proven')) {
    reasons.push('The catalogue marks the product as core / proven.');
    return done('core', 'medium');
  }

  // 6. Not enough evidence
  reasons.push('Not enough information to choose a specific type, so general product copy is used.');
  return done('general', 'low');
}

// The type that is used: a person's override always wins over the automatic result.
function effectiveCopyType(override, auto) {
  if (isCopyType(override)) return { type: override, source: 'manual', label: LABELS[override], newnessAllowed: override === 'new_range' || override === 'new_colourways' };
  const a = auto && isCopyType(auto.type) ? auto : { type: 'general' };
  return { type: a.type, source: 'auto', label: LABELS[a.type], newnessAllowed: a.type === 'new_range' || a.type === 'new_colourways' };
}

module.exports = { COPY_TYPES, VALUES, LABELS, TAB_PLAN, GUIDANCE, isCopyType, classifyCopyType, effectiveCopyType, BUNDLE_RE, COLOUR_NEWS_RE };
