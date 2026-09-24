// Meta ad naming helpers for Ad Setup. Grounded in real WNDRR naming
// examples found in Drive (batch number, week code, date, hook/theme text,
// stage tag, Image/Video, Single/Carousel, destination category) -- the
// exact underscore-segmented shape below is a best-effort reconstruction
// of the real convention, not an invented format, and every value it uses
// comes from a structured field an admin can correct. `*` is only ever
// rendered into the generated string as a placeholder segment (confirmed
// used that way in real ad names) -- it is never written to a stored field.
const { isoWeekNumber } = require('./week');

const PLACEHOLDER = '*';

function pad2(n) {
  return String(n).padStart(2, '0');
}

// ISO week-year (the year the week's Thursday falls in), matching
// isoWeekNumber's own Thursday-adjusted date -- correct across the
// Dec/Jan boundary, unlike date.getFullYear().
function isoWeekYear(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  return d.getUTCFullYear();
}

// "26-WK38" -- 2-digit ISO week-year, WK, ISO week number.
function weekCode(date) {
  const year2 = String(isoWeekYear(date)).slice(-2);
  return `${year2}-WK${isoWeekNumber(date)}`;
}

// "24-09" -- DD-MM, per the brief.
function formatDateDDMM(date) {
  return `${pad2(date.getDate())}-${pad2(date.getMonth() + 1)}`;
}

const AD_CATEGORY_LABELS = {
  new_drop: 'New Drop/Product Launch',
  core: 'Core',
  promotion: 'Promotion/Sale',
  organic_first: 'Organic-first',
};

const URL_LINK_PAGE_LABELS = {
  product: 'Product',
  category: 'Category',
  new_arrivals: 'New Arrivals',
  home: 'Home Page',
  sale_bundle: 'Sale/Bundle Page',
  other: 'Other',
};

const CTA_LABELS = {
  shop_now: 'Shop Now',
  sign_up: 'Sign Up',
  learn_more: 'Learn More',
  shop_the_sale: 'Shop the Sale',
};

// shoot_plan_items.source ('core'|'high_stock'|'drop'|'promotion'|'manual')
// is the universal origin discriminator -- this is the auto-detect rule an
// admin can override on the Ad Setup record afterward.
function detectAdCategory(source) {
  if (source === 'drop') return 'new_drop';
  if (source === 'promotion') return 'promotion';
  if (source === 'core' || source === 'high_stock') return 'core';
  return 'organic_first'; // 'manual' or no shoot_plan_item at all
}

// promotion_stages.name is free text (no enum/flag exists today), so this
// is a best-effort keyword match against the 4 known real stage names --
// admin-correctable via promotion_stage_id on the Ad Setup record, and it
// only ever affects display/copy-context, never which real stage row is
// linked.
function detectPromotionStageType(stageName) {
  if (!stageName) return null;
  const n = stageName.toLowerCase();
  if (n.includes('hype') || n.includes('pre-hype') || n.includes('pre hype')) return 'hype';
  if (n.includes('mid')) return 'mid_sale';
  if (n.includes('last chance') || n.includes('final') || n.includes('ending')) return 'last_chance';
  if (n.includes('live')) return 'sale_live';
  return null;
}

const STAGE_TAGS = {
  hype: 'HYPE',
  sale_live: 'LIVE',
  mid_sale: 'MID SALE',
  last_chance: 'LAST CHANCE',
};

// A general (not WNDRR-name-specific) apparel vocabulary for splitting a
// full product name like "Asset Raglan Box Fit Tee" into a distinctive
// Product Name ("Asset Raglan") and a Product Category ("Box Fit Tee").
// GARMENT_NOUNS are the actual object being sold -- the split always
// anchors on the LAST occurrence of one of these; FIT_MODIFIERS are the
// words that commonly precede a garment noun as part of its "type" phrase
// (a fit/cut/style descriptor) rather than the product's own name. This is
// a heuristic, not a taxonomy import (WNDRR/ApparelMagic's own `category`
// field is a coarse bucket like APPAREL/ACCESSORIES, not a per-garment
// type -- see splitProductName below for when that coarser field is used
// instead).
const GARMENT_NOUNS = new Set([
  'tee', 't-shirt', 'tshirt', 'shirt', 'hoodie', 'jumper', 'sweater', 'sweatshirt',
  'crew', 'short', 'shorts', 'pant', 'pants', 'jean', 'jeans', 'jogger', 'joggers',
  'jacket', 'vest', 'cap', 'hat', 'beanie', 'sock', 'socks', 'set', 'dress', 'skirt',
  'polo', 'tank', 'singlet', 'coat', 'parka', 'jumpsuit', 'romper', 'rugby', 'bomber',
  'zip', 'quarterzip', 'halfzip', 'boardshort', 'boardshorts',
]);
const FIT_MODIFIERS = new Set([
  'box', 'fit', 'relaxed', 'oversized', 'cropped', 'slim', 'regular', 'straight',
  'wide', 'skinny', 'loose', 'carpenter', 'cargo', 'utility', 'heavyweight',
  'lightweight', 'long', 'short', 'sleeve', 'full', 'half', 'quarter', 'classic',
  'essential', 'core',
]);

function normWord(w) {
  return String(w || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
}

// Splits a full product name into { name, category }. Anchors on the LAST
// garment noun found; walks backward from it consuming FIT_MODIFIERS words
// to form the category phrase, everything before that is the product name.
// Falls back to { name: fullName, category: null } when no known garment
// noun is found (an unfamiliar/new product type), rather than guessing.
function splitProductNameByWords(fullName) {
  const words = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { name: fullName || '', category: null };

  let nounIdx = -1;
  for (let i = words.length - 1; i >= 0; i -= 1) {
    if (GARMENT_NOUNS.has(normWord(words[i]))) { nounIdx = i; break; }
  }
  if (nounIdx === -1) return { name: fullName.trim(), category: null };

  let startIdx = nounIdx;
  while (startIdx - 1 >= 0 && FIT_MODIFIERS.has(normWord(words[startIdx - 1]))) {
    startIdx -= 1;
  }

  const category = words.slice(startIdx, nounIdx + 1).join(' ');
  const name = words.slice(0, startIdx).join(' ').trim();
  return { name: name || fullName.trim(), category };
}

// Product Name + Product Category for Ad Setup's Naming section (see the
// brief, item 1). Prefers a REAL, specific style/category field over
// parsing when one exists -- WNDRR/ApparelMagic's own `category` (via
// styles.category_id) is checked first, but it's a coarse sync bucket
// (APPAREL/ACCESSORIES/...), so a short, generic-looking value there is
// treated as unreliable for this purpose and the word-split heuristic
// above is used instead. When the structured category IS specific enough
// to be useful, it's used directly and its words are stripped from the
// Product Name so the two fields never repeat each other.
const GENERIC_CATEGORY_VALUES = new Set(['apparel', 'accessories', 'general', 'uncategorized', 'misc', 'other']);
function splitProductName(fullName, structuredCategory) {
  const trimmedName = String(fullName || '').trim();
  const categoryWords = new Set(String(structuredCategory || '').trim().toLowerCase().split(/\s+/).filter(Boolean));
  const structuredIsUsable = structuredCategory
    && !GENERIC_CATEGORY_VALUES.has(String(structuredCategory).trim().toLowerCase())
    && [...categoryWords].some((w) => trimmedName.toLowerCase().includes(w));

  if (structuredIsUsable) {
    const nameWords = trimmedName.split(/\s+/).filter((w) => !categoryWords.has(normWord(w)));
    return { name: (nameWords.join(' ').trim() || trimmedName), category: structuredCategory.trim() };
  }
  return splitProductNameByWords(trimmedName);
}

// A small set of low-information words dropped from a shortened hook --
// articles/pronouns/possessives that never carry the actual angle/message,
// so removing them tightens "3 ways I'd style the Asset Raglan Tee" toward
// its real content words without attempting any grammatical rewrite.
const HOOK_STOPWORDS = new Set([
  'a', 'an', 'the', 'my', 'your', 'our', 'i', 'id', 'ill', 'ive', 'im', 'would', 'will',
  'youd', 'youll', 'youre', 'this', 'that', 'these', 'those', 'it', 'its',
  'of', 'for', 'and', 'so',
]);

// Short, naming-safe version of a CONFIRMED Tuesday Review hook --
// deterministic and rule-based (no external AI/LLM call is made anywhere
// in this app; see the brief, item 4). Takes the first clause, drops
// stopwords and any words that just repeat the Product Name/Category
// (already their own naming segments, so echoing them here is redundant),
// keeps roughly the first 5 remaining content words, no trailing
// punctuation. This is a deliberately simple starting heuristic -- it does
// not paraphrase or rewrite grammar (so "I'd style" won't become "to
// style"), it only selects and trims. Never overwrites the full confirmed
// hook it's derived from; always editable on the Ad Setup record.
function shortenHook(hook, productName, productCategory) {
  if (!hook) return '';
  const clause = String(hook).split(/[.!?\n]/)[0].trim();
  const productWords = new Set(
    `${productName || ''} ${productCategory || ''}`.split(/\s+/).map(normWord).filter(Boolean)
  );
  const rawWords = clause.split(/\s+/).map((w) => w.replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, '')).filter(Boolean);

  const kept = [];
  for (const w of rawWords) {
    const bare = normWord(w.replace(/'/g, ''));
    if (HOOK_STOPWORDS.has(bare) || productWords.has(bare)) continue;
    kept.push(w);
    if (kept.length >= 5) break;
  }
  const finalWords = kept.length ? kept : rawWords.slice(0, 5);
  return finalWords.join(' ').toUpperCase();
}

// Assembles the read-only Generated Meta Ad Name preview from the
// structured fields on an ad_setups row (never stored as its own text
// column, so it can never drift out of sync with the fields it's built
// from). Order: [Sale stage/sequence prefix, if Promotion] Batch, Week,
// Date, Product Name, Product Category, Short Hook, Media, Ad Type,
// Creator, Concept, URL Link Page.
function buildMetaAdName(fields) {
  const {
    batchNumber, weekNo, adDate, productName, productCategory, hookShort, mediaType, adType,
    creatorName, conceptLabel, urlLinkPage, adCategory, stageType, saleSequenceNumber,
  } = fields;

  const segments = [];

  if (adCategory === 'promotion' && stageType && STAGE_TAGS[stageType]) {
    const seq = saleSequenceNumber ? ` ${saleSequenceNumber}` : '';
    segments.push(`${STAGE_TAGS[stageType]}${seq}`);
  }

  segments.push(batchNumber ? `#${batchNumber}` : '#—');
  if (weekNo) segments.push(weekNo);
  if (adDate) segments.push(formatDateDDMM(new Date(adDate)));
  // Product Name/Category/Short Hook/Creator/Concept render UPPERCASE in
  // the generated name (matching real WNDRR ad names) even though the
  // stored fields themselves keep normal casing for readability elsewhere
  // in the UI -- Media/Ad Type/URL Link Page keep their own Title Case
  // labels, also matching the real convention.
  segments.push(productName ? productName.toUpperCase() : PLACEHOLDER);
  segments.push(productCategory ? productCategory.toUpperCase() : PLACEHOLDER);
  segments.push(hookShort || PLACEHOLDER);
  segments.push(mediaType === 'video' ? 'Video' : mediaType === 'image' ? 'Image' : PLACEHOLDER);
  segments.push(adType === 'carousel' ? 'Carousel' : 'Single');
  segments.push(creatorName ? creatorName.toUpperCase() : PLACEHOLDER);
  segments.push(conceptLabel ? conceptLabel.toUpperCase() : PLACEHOLDER);
  segments.push(urlLinkPage ? URL_LINK_PAGE_LABELS[urlLinkPage] || urlLinkPage : PLACEHOLDER);

  return segments.join('_').replace(/\s+/g, ' ');
}

module.exports = {
  weekCode,
  formatDateDDMM,
  detectAdCategory,
  detectPromotionStageType,
  splitProductName,
  shortenHook,
  buildMetaAdName,
  AD_CATEGORY_LABELS,
  URL_LINK_PAGE_LABELS,
  CTA_LABELS,
  STAGE_TAGS,
};
