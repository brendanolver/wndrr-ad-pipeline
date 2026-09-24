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

// Short, naming-safe version of a concept's real hook -- rule-based (no
// external AI call): strip to the first clause, title-case it, cap length.
// Never overwrites creative_assets.hook itself; only ever stored on the
// Ad Setup row, and always editable there.
function shortenHook(hook) {
  if (!hook) return '';
  const firstClause = String(hook).split(/[.!?\n]/)[0].trim();
  const words = firstClause.split(/\s+/).slice(0, 6).join(' ');
  const upper = words.toUpperCase();
  return upper.length > 40 ? `${upper.slice(0, 40).trim()}` : upper;
}

// Assembles the read-only Generated Meta Ad Name preview from the
// structured fields on an ad_setups row (never stored as its own text
// column, so it can never drift out of sync with the fields it's built
// from). stageType/saleSequenceNumber only apply to Promotion ads.
function buildMetaAdName(fields) {
  const {
    batchNumber, weekNo, adDate, hookShort, mediaType, adType,
    creatorName, urlLinkPage, adCategory, stageType, saleSequenceNumber,
  } = fields;

  const segments = [];

  if (adCategory === 'promotion' && stageType && STAGE_TAGS[stageType]) {
    const seq = saleSequenceNumber ? ` ${saleSequenceNumber}` : '';
    segments.push(`${STAGE_TAGS[stageType]}${seq}`);
  }

  segments.push(batchNumber ? `#${batchNumber}` : '#—');
  if (weekNo) segments.push(weekNo);
  if (adDate) segments.push(formatDateDDMM(new Date(adDate)));
  segments.push(hookShort || PLACEHOLDER);
  segments.push(creatorName || PLACEHOLDER);
  segments.push(mediaType === 'video' ? 'Video' : mediaType === 'image' ? 'Image' : PLACEHOLDER);
  segments.push(adType === 'carousel' ? 'Carousel' : 'Single');
  segments.push(urlLinkPage ? URL_LINK_PAGE_LABELS[urlLinkPage] || urlLinkPage : PLACEHOLDER);

  return segments.join('_').replace(/\s+/g, ' ');
}

module.exports = {
  weekCode,
  formatDateDDMM,
  detectAdCategory,
  detectPromotionStageType,
  shortenHook,
  buildMetaAdName,
  AD_CATEGORY_LABELS,
  URL_LINK_PAGE_LABELS,
  CTA_LABELS,
  STAGE_TAGS,
};
