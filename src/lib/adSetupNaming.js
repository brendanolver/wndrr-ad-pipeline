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
  sign_up: 'Sign Up Page',
  other: 'Other',
};

const CTA_LABELS = {
  shop_now: 'Shop Now',
  sign_up: 'Sign Up',
  learn_more: 'Learn More',
  shop_the_sale: 'Shop the Sale',
};

// shoot_plan_items.source ('core'|'high_stock'|'drop'|'promotion'|'manual'|'momentum')
// is the universal origin discriminator -- this is the auto-detect rule an
// admin can override on the Ad Setup record afterward.
function detectAdCategory(source) {
  if (source === 'drop' || source === 'momentum') return 'new_drop'; // Protect Momentum = a recent launch
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
  'zip', 'quarterzip', 'halfzip', 'boardshort', 'boardshorts', 'trackshort', 'trackpant',
  'tracksuit', 'bag', 'tote', 'belt', 'scarf', 'glove', 'gloves', 'bottle', 'towel',
]);
const FIT_MODIFIERS = new Set([
  'box', 'fit', 'relaxed', 'oversized', 'cropped', 'slim', 'regular', 'straight',
  'wide', 'skinny', 'loose', 'carpenter', 'cargo', 'utility', 'heavyweight',
  'lightweight', 'long', 'short', 'sleeve', 'full', 'half', 'quarter', 'classic',
  'essential', 'core', 'sport', 'beach', 'swim', 'gym', 'training', 'tech', 'track',
  'lounge', 'sweat', 'board', 'running', 'baggy', 'tapered', 'pleated', '1/4', '1/2', '3/4',
]);

function normWord(w) {
  return String(w || '').toLowerCase().replace(/[^a-z0-9/-]/g, '');
}
// "tees" -> "tee", "pants" -> "pant", "hoodies" -> "hoodie"; "dress" keeps its s
const KEEP_S = new Set(['dress', 'cross']);
function singular(w) {
  const x = normWord(w);
  if (x.length > 3 && x.endsWith('ies')) return x.slice(0, -3) + 'y';
  if (x.length > 3 && x.endsWith('s') && !x.endsWith('ss') && !KEEP_S.has(x)) return x.slice(0, -1);
  return x;
}
const isGarmentNoun = (w) => GARMENT_NOUNS.has(normWord(w)) || GARMENT_NOUNS.has(singular(w));

// Splits a full product name into { name, category }. Anchors on the LAST
// garment noun found; walks backward from it consuming FIT_MODIFIERS words
// to form the category phrase. Everything before it is the product name, and any
// words AFTER the noun (a colour, a suffix) stay with the name so nothing meaningful is
// lost. At least one word always stays in the name ("Cargo Pant" -> "Cargo" + "Pant",
// never the whole name repeated as its own category).
// Falls back to { name: fullName, category: null } when no known garment
// noun is found (an unfamiliar/new product type), rather than guessing.
function splitProductNameByWords(fullName) {
  const words = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { name: fullName || '', category: null };

  let nounIdx = -1;
  for (let i = words.length - 1; i >= 0; i -= 1) {
    if (isGarmentNoun(words[i])) { nounIdx = i; break; }
  }
  if (nounIdx === -1) return { name: fullName.trim(), category: null };

  let startIdx = nounIdx;
  while (startIdx - 1 >= 1 && FIT_MODIFIERS.has(normWord(words[startIdx - 1]))) {
    startIdx -= 1;
  }

  const category = words.slice(startIdx, nounIdx + 1).join(' ');
  const name = [...words.slice(0, startIdx), ...words.slice(nounIdx + 1)].join(' ').trim();
  return { name: name || fullName.trim(), category };
}

// Where does `phrase` (a category such as "Box Fit Tee") sit inside `words` as a CONTIGUOUS run? -> start index or -1. Case-, punctuation- and plural-insensitive;
// only a whole run of words counts, never a word here and there, so a meaningful style word that merely shares a word with the category is never removed.
function findPhrase(words, phraseWords) {
  const w = words.map(singular); const p = phraseWords.map(singular);
  if (!p.length) return -1;
  for (let i = w.length - p.length; i >= 0; i -= 1) {
    if (p.every((x, k) => w[i + k] === x)) return i;
  }
  return -1;
}

// Product Name + Product Category for Ad Setup's Naming section. Prefers a REAL, specific category (the product's structured category) over parsing when it
// is specific enough to be useful: its words must appear in the name as one contiguous run, and only that run is taken out of the name, so the two fields never
// repeat each other ("ASSET RAGLAN BOX FIT TEE" + "BOX FIT TEE" -> "ASSET RAGLAN"). A coarse bucket (APPAREL, ACCESSORIES ...) or a category the name does not contain is
// not used and the word heuristic above decides instead. This only changes how the name is REPRESENTED for Meta naming, never the underlying product record.
const GENERIC_CATEGORY_VALUES = new Set(['apparel', 'accessories', 'general', 'uncategorized', 'misc', 'other']);
function splitProductName(fullName, structuredCategory) {
  const trimmedName = String(fullName || '').trim();
  const cat = String(structuredCategory || '').trim();
  if (cat && !GENERIC_CATEGORY_VALUES.has(cat.toLowerCase())) {
    const words = trimmedName.split(/\s+/).filter(Boolean);
    const at = findPhrase(words, cat.split(/\s+/).filter(Boolean));
    if (at >= 0) {
      const catWords = cat.split(/\s+/).filter(Boolean);
      const rest = [...words.slice(0, at), ...words.slice(at + catWords.length)].join(' ').trim();
      // a coarse category ("Tees") sitting inside a more specific type in the name ("Box Fit Tee"): the specific type is the category, so "Box Fit" is not left in the name
      const h = splitProductNameByWords(trimmedName);
      const hc = h.category ? h.category.split(/\s+/) : [];
      const hcTailIsCat = hc.length > catWords.length && hc.slice(-catWords.length).map(singular).join(' ') === catWords.map(singular).join(' ');
      if (hcTailIsCat) return h;
      if (rest) return { name: rest, category: cat };
    }
  }
  return splitProductNameByWords(trimmedName);
}

// Does a product name already END with its category (case/plural-insensitive)? -> the name without it, else the name unchanged. Used only when the Meta ad name is built,
// so a stored value (including one a person typed) is never edited: the generated name just never says the category twice.
function nameWithoutCategory(productName, productCategory) {
  const name = String(productName || '').trim(); const cat = String(productCategory || '').trim();
  if (!name || !cat) return name;
  const words = name.split(/\s+/); const catWords = cat.split(/\s+/);
  if (words.length <= catWords.length) return name;
  const tail = words.slice(-catWords.length).map(singular); const want = catWords.map(singular);
  return tail.every((x, i) => x === want[i]) ? words.slice(0, -catWords.length).join(' ') : name;
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
  segments.push(productName ? nameWithoutCategory(productName, productCategory).toUpperCase() : PLACEHOLDER);
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
  nameWithoutCategory,
  shortenHook,
  buildMetaAdName,
  AD_CATEGORY_LABELS,
  URL_LINK_PAGE_LABELS,
  CTA_LABELS,
  STAGE_TAGS,
};
