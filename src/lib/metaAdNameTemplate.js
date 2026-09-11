// Parses the team's REAL Meta ad naming convention: an underscore-delimited,
// 11-field positional template --
//   Batch No. _ Week No. _ Date _ Product _ Product Type _ Hook _ Media _
//   Ad Type _ Creator _ Concept _ URL Link Page
// e.g. "#315_26-WK32_04-08_PULSE_HEAVY WEIGHT TEES_FIT_Video_Single_SAMI_FIT CHECK_Product"
//
// This is a DIFFERENT convention from metaProductMapping.js's parseMetaAdName
// (a "+"-delimited "Product + Product Type [+ Batch No]" parser). That one
// stays untouched -- it's still what the existing live-coverage/mapping flow
// depends on. This module is Stage 1's own parser, used only to populate the
// new meta_ads table's parsed_* columns; it deliberately does not feed into
// any style/product matching yet.
//
// Historical ads are not guaranteed to follow this template cleanly (old
// naming patterns, missing fields, extra underscores) -- see the brief this
// was built from. The parser never throws and never drops an ad: a name
// that doesn't split into exactly 11 segments still gets a best-effort
// partial extraction of whichever leading fields (Batch No./Week No./Date)
// are structurally recognisable, and callers always get a parse_status
// ('parsed' | 'partial' | 'unparsed') to store alongside the raw name.

const TEMPLATE_FIELD_KEYS = [
  'batchNo', 'weekNo', 'date', 'productRaw', 'productTypeRaw',
  'hook', 'media', 'adType', 'creator', 'concept', 'urlLinkPage',
];

// Loose structural checks used only for best-effort partial extraction when
// the full 11-segment split doesn't apply -- not used to reject a clean
// 11-segment parse, since real Batch/Week/Date formatting may drift over
// time and a strict regex there would just turn a real field into "partial"
// for no benefit.
const BATCH_NO_RE = /^#\d+$/;
const WEEK_NO_RE = /^\d{2}-?WK\d+$/i;
const DATE_RE = /^\d{1,2}-\d{1,2}$/;

function emptyFields() {
  return Object.fromEntries(TEMPLATE_FIELD_KEYS.map((k) => [k, null]));
}

// Best-effort recovery for a name that didn't cleanly split into 11
// segments: scan the leading few segments for anything that structurally
// looks like Batch No./Week No./Date (the most recognisable, least
// ambiguous fields), independent of position, since a missing/extra
// underscore elsewhere in the name can shift everything after it.
function extractPartialFields(segments) {
  const fields = emptyFields();
  let found = false;
  for (const seg of segments.slice(0, 4)) {
    if (!fields.batchNo && BATCH_NO_RE.test(seg)) { fields.batchNo = seg; found = true; continue; }
    if (!fields.weekNo && WEEK_NO_RE.test(seg)) { fields.weekNo = seg; found = true; continue; }
    if (!fields.date && DATE_RE.test(seg)) { fields.date = seg; found = true; continue; }
  }
  return { fields, found };
}

// Returns { parseStatus, parseError, fields } -- fields keys match
// TEMPLATE_FIELD_KEYS, always present (null where not recovered). Never
// throws.
function parseAdNameTemplate(rawName) {
  const name = String(rawName || '').trim();
  if (!name) {
    return { parseStatus: 'unparsed', parseError: 'empty ad name', fields: emptyFields() };
  }

  const segments = name.split('_').map((s) => s.trim());

  if (segments.length === TEMPLATE_FIELD_KEYS.length) {
    const fields = emptyFields();
    TEMPLATE_FIELD_KEYS.forEach((key, i) => { fields[key] = segments[i] || null; });
    return { parseStatus: 'parsed', parseError: null, fields };
  }

  const { fields, found } = extractPartialFields(segments);
  const parseError = `expected 11 underscore-delimited fields, found ${segments.length}`;
  return { parseStatus: found ? 'partial' : 'unparsed', parseError, fields };
}

// Conservative normalization for Meta-generated duplicate-ad suffixes --
// e.g. duplicating a Creative Library ad into a live campaign often appends
// "- Copy", "- Copy 2", or a manual "UPDATED". Strips only known trailing
// suffix patterns (repeatedly, to handle a chain like "- Copy - Copy 2"),
// never touches the middle of a name, and never merges/deletes rows -- this
// is purely a future reconciliation aid. Returns the normalized string
// (identical to the input when nothing matched); the caller is always
// expected to keep the original raw name alongside it.
const TRAILING_SUFFIX_PATTERNS = [
  /\s*[-–]\s*copy(\s*\d+)?\s*$/i,
  /\s*\(\s*copy(\s*\d+)?\s*\)\s*$/i,
  /\s+copy(\s*\d+)?\s*$/i,
  /\s*[-–]\s*updated\s*$/i,
  /\s*\(\s*updated\s*\)\s*$/i,
  /\s+updated\s*$/i,
];

function normalizeAdName(rawName) {
  let name = String(rawName || '').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of TRAILING_SUFFIX_PATTERNS) {
      const stripped = name.replace(pattern, '');
      if (stripped !== name) {
        name = stripped.trim();
        changed = true;
      }
    }
  }
  return name;
}

module.exports = { parseAdNameTemplate, normalizeAdName, TEMPLATE_FIELD_KEYS };
