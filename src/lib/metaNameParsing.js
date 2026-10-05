// Deterministic, evidence-bounded helpers for reading Meta ad NAMES in the Ad
// Matching suggestion layer. Pure functions (no DB, no network) so the rules
// are directly testable. Nothing here ever confirms anything -- it only
// produces candidates that the caller turns into suggestions with a
// confidence and a reason.
//
// Three jobs:
//  1. Tokenising/normalising product text so "MAISON 1/4 ZIP" can meet a
//     catalogue name like "Maison Quarter Zip Jumper" (matchProductPhrase).
//  2. Recognising a SET/bundle phrase and, only when the existing catalogue
//     gives structural evidence, the component families (expandSet).
//  3. A tolerant fallback reader for older / non-standard names that don't
//     follow today's buildMetaAdName() layout (parseLooseMetaName), driven by
//     recognisable TOKENS (batch, week, date, media, ad type, page, creator,
//     concept) plus the product catalogue -- not by fixed positions.
//
// How matching is bounded (so it can't invent products):
//  * Only EXISTING product families are ever returned -- no new ones.
//  * Stop words (THE, AND, ...) are ignored; set words (SET, BUNDLE, ...) stay
//    significant for matching a family and are only stripped for set expansion.
//  * A single-word phrase matches only by exact name; fuzzy matching needs >= 2
//    shared significant words AND Jaccard overlap >= 0.6.
//  * Strong tiers (exact 0.90, containment >= 0.75 overlap 0.85, containment
//    >= 0.6 overlap 0.70) require ALL words of the shorter side to be present.
//  * Ties lower confidence (-0.10 each extra equally-close family) and at most
//    3 candidates are returned; below the 0.5 floor nothing is returned.
//  * Set expansion only runs when the phrase contains an explicit set word and
//    only returns collection members the catalogue structurally supports.

const STOP = new Set(['THE', 'A', 'AN', 'AND', 'OF', 'FOR', 'WITH', 'NEW']);
const SET_WORDS = new Set(['SET', 'SETS', 'BUNDLE', 'PACK', 'DUO', 'TRIO', 'KIT', 'COMBO', 'OUTFIT']);

const MEDIA_TYPES = [
  { key: 'video', label: 'Video' },
  { key: 'image', label: 'Image / Static' },
  { key: 'carousel', label: 'Carousel' },
  { key: 'gif', label: 'GIF' },
  { key: 'unknown', label: 'Unknown' },
];
const MEDIA_KEYS = new Set(MEDIA_TYPES.map((m) => m.key));
const MEDIA_LABEL = Object.fromEntries(MEDIA_TYPES.map((m) => [m.key, m.label]));
// A whole delimited segment that IS a media word.
const MEDIA_WORDS = {
  VIDEO: 'video', IMAGE: 'image', STATIC: 'image', PHOTO: 'image', GIF: 'gif', CAROUSEL: 'carousel',
};

function norm(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

// Upper-case word tokens with the usual apparel spellings canonicalised, so
// both sides of a comparison are reduced the same way:
//   1/4, ¼, QTR -> QUARTER;  1/2, ½ -> HALF;  & -> AND;
//   trailing plural S dropped on words of 5+ letters (SHORTS -> SHORT).
function canonTokens(text) {
  const t = String(text || '').toUpperCase()
    .replace(/¼/g, ' QUARTER ').replace(/½/g, ' HALF ').replace(/¾/g, ' THREEQUARTER ')
    .replace(/(?<!\d)1\s*\/\s*4(?!\d)/g, ' QUARTER ')
    .replace(/(?<!\d)1\s*\/\s*2(?!\d)/g, ' HALF ')
    .replace(/(?<!\d)3\s*\/\s*4(?!\d)/g, ' THREEQUARTER ')
    .replace(/&/g, ' AND ');
  return t.replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map((w) => {
    if (w === 'QTR') return 'QUARTER';
    return w.length >= 5 && w.endsWith('S') && !w.endsWith('SS') ? w.slice(0, -1) : w;
  });
}

const matchTokens = (text) => canonTokens(text).filter((t) => !STOP.has(t));
const coreTokens = (text) => canonTokens(text).filter((t) => !STOP.has(t) && !SET_WORDS.has(t));
const hasSetWord = (text) => canonTokens(text).some((t) => SET_WORDS.has(t));

// Pre-tokenised view of the product-family list ({product_code, product_name}).
function buildFamilyIndex(families) {
  return families.map((f) => {
    const match = matchTokens(f.product_name);
    return { ...f, match, matchSet: new Set(match), core: coreTokens(f.product_name) };
  });
}

function scoreSets(P, F) {
  const inter = [...P].filter((t) => F.has(t)).length;
  if (!inter) return null;
  const union = P.size + F.size - inter;
  const jacc = inter / union;
  const info = { inter, jacc, pSize: P.size, fSize: F.size };
  if (inter === P.size && inter === F.size) {
    // a single word only counts as an exact family name when it is distinctive
    const only = [...P][0];
    if (P.size === 1 && only.length < 4) return null;
    return { ...info, confidence: 0.9, kind: 'exact' };
  }
  const contained = inter === P.size || inter === F.size;
  if (contained && Math.min(P.size, F.size) >= 2) {
    if (jacc >= 0.75) return { ...info, confidence: 0.85, kind: 'contains_strong' };
    if (jacc >= 0.6) return { ...info, confidence: 0.7, kind: 'contains' };
    return null;
  }
  if (inter >= 2 && jacc >= 0.6) return { ...info, confidence: 0.6, kind: 'fuzzy' };
  return null;
}

// Existing product families a phrase refers to, best first (<= 3), each with
// confidence + how it matched. [] when nothing clears the bounds above.
function matchProductPhrase(phrase, index) {
  const P = new Set(matchTokens(phrase));
  if (!P.size) return [];
  const scored = [];
  index.forEach((f) => {
    const s = scoreSets(P, f.matchSet);
    if (s) scored.push({ family: f, ...s });
  });
  if (!scored.length) return [];
  scored.sort((a, b) => b.confidence - a.confidence || b.jacc - a.jacc);
  const top = scored[0];
  const tied = scored.filter((s) => s.confidence === top.confidence && Math.abs(s.jacc - top.jacc) < 1e-9).length;
  return scored.slice(0, 3).map((s, i) => {
    const isTop = s.confidence === top.confidence && Math.abs(s.jacc - top.jacc) < 1e-9;
    const penalty = isTop && tied > 1 ? Math.min(0.2, 0.1 * (tied - 1)) : 0;
    return { ...s, confidence: Math.max(0.5, Number((s.confidence - penalty).toFixed(3))), ties: isTop ? tied : 0, rank: i };
  }).filter((s) => s.confidence >= 0.5);
}

function commonPrefixLen(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

// Set / bundle phrase ("THE WORLD TRACKSUIT SET") -> component families the
// catalogue structurally supports. Requires an explicit set word.
//   1. collection = existing families whose first significant word equals the
//      phrase's (here WORLD) -- needs >= 2 families, i.e. a real collection;
//   2. anchors = collection members that share a >= 5-letter word stem with
//      the rest of the phrase (TRACKSUIT ~ TRACKPANT);
//   3. with anchors: the anchors plus siblings from the SAME sub-collection
//      (same 2nd significant word, e.g. WORLD SPORT ...) -> jacket + pant,
//      while an unrelated WORLD CAP is not pulled in;
//   4. no anchors: only a small collection (<= 3) is offered, at low
//      confidence, purely for human review.
function expandSet(phrase, index) {
  if (!hasSetWord(phrase)) return null;
  const core = coreTokens(phrase);
  if (!core.length || core[0].length < 4) return null;
  const lead = core[0];
  const rest = core.slice(1);
  const members = index.filter((f) => f.core[0] === lead);
  if (members.length < 2) return null;

  const anchors = members.filter((f) => {
    const fr = f.core.slice(1);
    return rest.some((rt) => fr.some((ft) => commonPrefixLen(rt, ft) >= 5));
  });
  let out;
  if (anchors.length) {
    const subs = new Set(anchors.map((a) => a.core[1]).filter((t) => t && t.length >= 3));
    const siblings = members.filter((m) => !anchors.includes(m) && m.core[1] && subs.has(m.core[1]));
    out = [
      ...anchors.map((f) => ({ family: f, confidence: 0.65, role: 'anchor' })),
      ...siblings.map((f) => ({ family: f, confidence: 0.6, role: 'sibling' })),
    ];
    if (out.length > 4) out = out.slice(0, anchors.length);
  } else if (members.length <= 3) {
    out = members.map((f) => ({ family: f, confidence: 0.5, role: 'collection' }));
  } else {
    return null;
  }
  return { lead, members: out, collection_size: members.length, phrase };
}

// ── Media ───────────────────────────────────────────────────────────────
// Exact media words as whole delimited segments of the name (never loose
// substring hits inside a longer phrase).
function stripCopySuffix(seg) {
  return String(seg || '').replace(/\s*[–—-]\s*COPY(\s+\d+)?\s*$/i, '').replace(/\s*\(\s*COPY(\s+\d+)?\s*\)\s*$/i, '').trim();
}
function mediaTokensFromName(name) {
  const found = [];
  String(name || '').split(/_|\||\+|\s[–—-]\s/).forEach((raw) => {
    const w = stripCopySuffix(raw).toUpperCase();
    if (MEDIA_WORDS[w]) found.push(MEDIA_WORDS[w]);
  });
  return found;
}

// ── Loose parser for older / non-standard names ─────────────────────────
const PAGE_WORDS = new Set(['PRODUCT', 'CATEGORY', 'NEW ARRIVALS', 'HOME PAGE', 'HOME', 'SALE/BUNDLE PAGE', 'SALE BUNDLE PAGE', 'OTHER']);

function classifySegment(raw, ctx) {
  const s = stripCopySuffix(raw);
  const U = s.toUpperCase();
  if (!s) return { text: raw, kind: 'empty' };
  if (/^COPY(\s+\d+)?$/.test(U)) return { text: s, kind: 'copy' };
  if (/^#\s*(\d+|—|-)$/.test(s)) return { text: s, kind: 'batch' };
  if (/^\d{2}-WK\d{1,2}$/i.test(s)) return { text: s, kind: 'week' };
  if (/^\d{2}-\d{2}$/.test(s)) return { text: s, kind: 'date' };
  if (MEDIA_WORDS[U]) return { text: s, kind: 'media', value: MEDIA_WORDS[U] };
  if (U === 'SINGLE') return { text: s, kind: 'ad_type', value: 'single' };
  if (PAGE_WORDS.has(U)) return { text: s, kind: 'page' };
  if (/^[A-Z]\d{2}[A-Z0-9]{1,4}$/.test(U) && /\d/.test(U)) return { text: s, kind: 'code' };
  if (ctx.creatorByNorm && ctx.creatorByNorm.has(norm(s))) return { text: s, kind: 'creator', value: ctx.creatorByNorm.get(norm(s)) };
  if (ctx.conceptByNorm && ctx.conceptByNorm.has(norm(s))) return { text: s, kind: 'concept', value: ctx.conceptByNorm.get(norm(s)) };
  return { text: s, kind: 'text' };
}

// Returns null when no recognisable token is found at all. Otherwise a
// partial parse: whatever was recognised, plus a likely product phrase chosen
// by the catalogue (or, failing that, the first multi-word text segment --
// shown as evidence only, never turned into a suggestion without a match).
function parseLooseMetaName(name, ctx) {
  const text = String(name || '').trim();
  if (!text) return null;
  const rawSegs = text.split(/_|\s[|–—]\s|\||\s-\s/).map((s) => s.trim()).filter(Boolean);
  const segs = rawSegs.map((s) => classifySegment(s, ctx));
  const first = (kind) => segs.find((s) => s.kind === kind);
  const out = {
    loose: true,
    batch: (first('batch') || {}).text || null,
    week: (first('week') || {}).text || null,
    date: (first('date') || {}).text || null,
    code: (first('code') || {}).text || null,
    media: (first('media') || {}).value || null,
    ad_type: (first('ad_type') || {}).value || null,
    url_link_page: (first('page') || {}).text || null,
    creator: (first('creator') || {}).value || null,
    concept: null,
    concept_formed_from: null,
    product_phrase: null,
    product_catalogue_match: false,
    variant: null,
    segments: segs.map((s) => ({ text: s.text, kind: s.kind })),
  };

  // Concept: a whole segment that is a concept name, or text + media tokens
  // that spell one in either order ("Video" + "Campaign" -> "Campaign Video").
  const conceptSeg = first('concept');
  if (conceptSeg) out.concept = conceptSeg.value.name;
  if (!out.concept) {
    for (let i = 0; i < segs.length && !out.concept; i += 1) {
      const m = segs[i];
      if (m.kind !== 'media') continue;
      [segs[i - 1], segs[i + 1]].forEach((nb) => {
        if (out.concept || !nb || nb.kind !== 'text' || nb.text.split(/\s+/).length > 2) return;
        [`${nb.text} ${m.text}`, `${m.text} ${nb.text}`].forEach((combo) => {
          const hit = ctx.conceptByNorm && ctx.conceptByNorm.get(norm(combo));
          if (hit && !out.concept) { out.concept = hit.name; out.concept_formed_from = `${nb.text} + ${m.text}`; }
        });
      });
    }
  }

  // Product phrase: best catalogue hit among the text segments; else the
  // first multi-word text segment (display only).
  const texts = segs.filter((s) => s.kind === 'text' && /[A-Za-z]{3}/.test(s.text));
  let best = null;
  texts.forEach((s) => {
    const cands = ctx.familyIndex ? matchProductPhrase(s.text, ctx.familyIndex) : [];
    const set = ctx.familyIndex ? expandSet(s.text, ctx.familyIndex) : null;
    const score = Math.max(cands.length ? cands[0].confidence : 0, set ? Math.max(...set.members.map((m) => m.confidence)) : 0);
    if (score > 0 && (!best || score > best.score || (score === best.score && s.text.length > best.seg.text.length))) best = { seg: s, score };
  });
  if (best) {
    out.product_phrase = best.seg.text;
    out.product_catalogue_match = true;
  } else {
    const display = texts.find((s) => s.text.split(/\s+/).length >= 2);
    if (display) out.product_phrase = display.text;
  }
  const variants = segs.filter((s) => s.kind === 'text' && out.product_phrase && s.text !== out.product_phrase && s.text.length <= 6);
  out.variant = variants.length ? variants.map((v) => v.text).join(' ') : null;

  // An unmatched "product phrase" alone is NOT evidence the name has structure
  // (plain prose would otherwise always qualify) -- it only counts when a real
  // token was recognised or the catalogue matched it.
  const recognised = ['batch', 'week', 'date', 'code', 'media', 'ad_type', 'url_link_page', 'creator', 'concept'].some((k) => out[k])
    || out.product_catalogue_match;
  return recognised ? out : null;
}

module.exports = {
  STOP, SET_WORDS, MEDIA_TYPES, MEDIA_KEYS, MEDIA_LABEL, MEDIA_WORDS,
  norm, canonTokens, matchTokens, coreTokens, hasSetWord,
  buildFamilyIndex, matchProductPhrase, expandSet, mediaTokensFromName, stripCopySuffix, parseLooseMetaName,
};
