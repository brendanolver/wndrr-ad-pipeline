// WNDRR copy reference library: read-only sync from Google Sheets, a cache in the database, deterministic tone-of-voice statistics, and example
// selection for the AI Copy Assistant. The source spreadsheet is never modified. Nothing here is hard-coded as a "finding": every guideline the
// assistant sees is computed from the examples that were actually read in the last successful sync.

const { normalizeUnicode, plain, wordList, contentWords, similarity, hasPhrase } = require('./copyText');
const { RULES, maskClaims } = require('./copyClaims');
const copyTypes = require('./copyTypes');

const EXPECTED_TABS = [
  { title: 'CORE', family: 'core' },
  { title: 'CORE 26', family: 'core', year: 2026 },
  { title: 'SALES', family: 'sales' },
  { title: '2026 SALES', family: 'sales', year: 2026 },
  { title: 'BUNDLES', family: 'bundles' },
  { title: 'BUNDLES 26', family: 'bundles', year: 2026 },
  { title: 'USA - BUNDLES 26', family: 'bundles', year: 2026, region: 'USA' },
  { title: '2024 RANGES', family: 'ranges', year: 2024 },
  { title: '2025 RANGES', family: 'ranges', year: 2025 },
  { title: '2026 RANGES', family: 'ranges', year: 2026 },
  { title: 'PINTEREST', family: 'pinterest' },
];
const FAMILIES = ['core', 'sales', 'bundles', 'ranges', 'pinterest'];
const MIN_BODY_CHARS = 20;

const norm = (s) => String(s == null ? '' : s).replace(/\r/g, '').trim();
const key = (s) => norm(s).toLowerCase().replace(/\s+/g, ' ');

// ── parsing ────────────────────────────────────────────────────────────────────────────────────────────────────────
const HEADER_HINT = /(primary|headline|copy|text|caption|description|product|range|sale|campaign|collection|name|title|style|body|message|link|cta|date|hook|type|what|subject)/i;
const BODY_PATTERNS = [/^primary\s*text/i, /primary/i, /ad\s*copy/i, /^copy$/i, /copy/i, /^body/i, /caption/i, /^text$/i, /text/i, /message/i, /description/i];
const HEADLINE_RE = /head\s*line|^title$|^headline/i;
const LABEL_RE = /product|range|name|sale|campaign|collection|style|drop/i;
// The product / subject column. WNDRR's tabs are laid out "Range | What | Copy": "What" is the product (or, on the sales tabs, the sale stage).
const SUBJECT_PATTERNS = [/^what$/i, /^(subject|item)$/i, /^product(?:\s*\/\s*range)?$/i, /^(name|title)$/i];
// Sheets shows merged cells as "[merged] TEXT" in some exports; the marker is never part of the content.
const cleanCell = (s) => norm(s).replace(/^\\?\[merged\\?\]\s*/i, '');

function findHeaderRow(rows) {
  let best = -1; let bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, 12); i += 1) {
    const cells = (rows[i] || []).map(norm).filter(Boolean);
    if (!cells.length) continue;
    // A header row is made of short cells that name things; copy rows have long cells.
    const short = cells.filter((c) => c.length <= 40);
    const hits = short.filter((c) => HEADER_HINT.test(c)).length;
    const score = short.length === cells.length ? hits : 0;
    if (score > bestScore) { best = i; bestScore = score; }
  }
  return bestScore >= 1 ? best : -1;
}

// → { header_found, columns: { body: [idx], headline, label, subject }, examples, warnings, filled_down }
function parseTab(rows, tab = {}) {
  const warnings = [];
  const data = (rows || []).map((r) => (r || []).map(cleanCell));
  const headerIdx = findHeaderRow(data);
  const headers = headerIdx >= 0 ? data[headerIdx] : [];
  const columns = { body: [], headline: null, label: null, subject: null };

  if (headerIdx >= 0) {
    headers.forEach((h, i) => { if (HEADLINE_RE.test(h) && columns.headline === null) columns.headline = i; });
    for (const re of BODY_PATTERNS) {
      const idxs = headers.map((h, i) => (re.test(h) && !HEADLINE_RE.test(h) && i !== columns.headline ? i : -1)).filter((i) => i >= 0);
      if (idxs.length) { columns.body = idxs; break; }
    }
    headers.forEach((h, i) => { if (columns.label === null && LABEL_RE.test(h) && !columns.body.includes(i) && i !== columns.headline) columns.label = i; });
    for (const re of SUBJECT_PATTERNS) {
      const at = headers.findIndex((h, i) => h && re.test(h) && !columns.body.includes(i) && i !== columns.headline);
      if (at >= 0) { columns.subject = at; break; }
    }
  }
  const bodyRows = data.slice(headerIdx + 1);
  if (!columns.body.length) {
    // No usable header: treat the column holding the most text as the copy.
    const width = Math.max(0, ...bodyRows.map((r) => r.length));
    let bestCol = -1; let bestLen = 0;
    for (let c = 0; c < width; c += 1) {
      const total = bodyRows.reduce((n, r) => n + (r[c] ? r[c].length : 0), 0);
      if (total > bestLen) { bestLen = total; bestCol = c; }
    }
    if (bestCol >= 0) { columns.body = [bestCol]; warnings.push('No header row naming the copy column was found; the column with the most text was used.'); }
  }
  if (!columns.body.length) { warnings.push('No copy text was found on this tab.'); return { header_found: headerIdx >= 0, columns, examples: [], warnings, rows_read: data.length, filled_down: 0 }; }
  if (headerIdx >= 0 && columns.subject === null) warnings.push('No "What" / product column was found, so examples have no product name.');

  // A label that is merged over several rows (Range, Sale) arrives only on its first row: carry it down. The sales tabs also merge the stage ("What") the same way.
  const fillSubject = tab.family === 'sales';
  let lastLabel = ''; let lastSubject = ''; let filledDown = 0;
  const seen = new Set();
  const examples = [];
  bodyRows.forEach((r, offset) => {
    const rowNumber = headerIdx + 2 + offset; // 1-based sheet row
    let label = columns.label !== null ? r[columns.label] : '';
    if (columns.label !== null) { if (label) lastLabel = label; else if (lastLabel && r.some((c) => c)) { label = lastLabel; filledDown += 1; } }
    let subject = columns.subject !== null ? r[columns.subject] : '';
    if (fillSubject && columns.subject !== null) { if (subject) lastSubject = subject; else if (lastSubject && r.some((c) => c)) subject = lastSubject; }
    for (const c of columns.body) {
      const body = r[c];
      if (!body || body.length < MIN_BODY_CHARS || !/[a-z]/i.test(body)) continue;
      if (headers[c] && key(body) === key(headers[c])) continue;
      const dedupe = key(normalizeUnicode(body));
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const rowLabel = columns.label !== null ? label : (r.find((cell, i) => cell && !columns.body.includes(i) && i !== columns.headline && cell.length <= 80) || '');
      const extra = {};
      r.forEach((cell, i) => { if (cell && !columns.body.includes(i) && i !== columns.headline && i !== columns.label && headers[i]) extra[headers[i]] = cell.slice(0, 200); });
      if (subject && columns.subject !== null && !extra[headers[columns.subject]]) extra[headers[columns.subject]] = subject.slice(0, 200);
      examples.push({
        row_number: rowNumber, label: (rowLabel || '').slice(0, 255) || null, subject: subject ? subject.slice(0, 255) : null,
        headline: columns.headline !== null && r[columns.headline] ? r[columns.headline] : null,
        body, meta: { ...extra, ...(columns.body.length > 1 ? { column: headers[c] || `column ${c + 1}` } : {}) },
      });
    }
  });
  if (!examples.length) warnings.push('The copy column was found but contained no usable text.');
  return { header_found: headerIdx >= 0, columns, examples, warnings, rows_read: data.length, filled_down: filledDown };
}

// ── what each example is (kind), and which ones must never be used as style references ───────────────────────────────
const RECRUIT_RE = /\b(?:we(?:'|’)?re hiring|now hiring|hiring|recruit(?:ing|ment)?|job (?:opening|ad|description|vacancy)|careers?|apply (?:now|today|here|via)|join (?:our|the) team|work (?:with|for) us|vacanc(?:y|ies)|position available)\b/i;
const RECRUIT_SUBJECT_RE = /\b(?:hiring|recruit\w*|job|careers?|vacanc\w+|specialist|coordinator|manager|intern(?:ship)?)\b/i;
const GENERIC_SUBJECT = /^(?:product|range layout(?:\s*\+\s*grid)?|layout|grid|range)$/i;
const EMOJI_TAIL = /[\p{Extended_Pictographic}️‍]+/gu;

// "SPRING DEL. 3.0 | The Junkyard Box Fit Tee 🥊" -> "Junkyard Box Fit Tee"
function productFromBody(body) {
  const first = normalizeUnicode(String(body || '').split('\n')[0]).replace(EMOJI_TAIL, ' ').trim();
  const at = first.lastIndexOf('|');
  if (at < 0) return null;
  const name = first.slice(at + 1).trim().replace(/^the\s+/i, '').replace(/[.!:\s]+$/g, '').trim();
  return name && name.length <= 80 ? name : null;
}

// e: { tab, family, label, subject, body, meta, kind, excluded, exclude_reason } (any of the last four may be missing: rows imported before they existed)
// → { subject, kind, excluded, exclude_reason }. Pure; used when a library is imported AND when it is read, so libraries imported by an earlier version benefit at once.
function enrichExample(e) {
  const meta = e.meta || {};
  const raw = norm(e.subject || meta.What || meta['Product/Range'] || '');
  const first = normalizeUnicode(String(e.body || '').split('\n')[0]).trim();
  let subject = raw || null; let kind = 'other';
  if (raw && GENERIC_SUBJECT.test(raw)) {
    const generic = raw.toLowerCase();
    if (/^product$/.test(generic)) { kind = 'product'; subject = productFromBody(e.body) || e.label || null; }
    else { kind = 'range_layout'; subject = e.label || raw; }
  } else if (e.family === 'sales') kind = 'sale';
  else if (e.family === 'bundles') kind = 'bundle';
  else if (e.family === 'pinterest') kind = 'pinterest';
  else if (e.family === 'ranges') kind = raw ? 'lifestyle' : 'other';
  else if (raw) kind = 'product';
  if (!subject && e.label) subject = e.label;

  let excluded = false; let reason = null;
  if (RECRUIT_RE.test(normalizeUnicode(e.body)) || (raw && RECRUIT_SUBJECT_RE.test(raw))) { kind = 'recruitment'; excluded = true; reason = 'recruitment'; }
  else if (/^["“”].+["“”]\s*[-–—]\s*\S+(?:\s+\S+)?$/.test(first)) { kind = 'testimonial'; excluded = true; reason = 'testimonial'; }
  else if (e.family === 'pinterest') { excluded = true; reason = 'not_meta_ad_copy'; }
  return { subject, kind, excluded, exclude_reason: reason };
}

function matchTabs(sheetTitles) {
  const byKey = new Map(sheetTitles.map((t) => [key(t), t]));
  return EXPECTED_TABS.map((t) => ({ ...t, actual: byKey.get(key(t.title)) || null }));
}

// ── tone analysis (statistics only) ───────────────────────────────────────────────────────────────────────────────
const STOP = new Set('a an the and or of to in on for with at by from is are was be it its this that you your we our us as but if so not no can will just all more than then them they their have has had do does did i me my'.split(' '));
const CTA_RE = /\b(shop now|shop the [a-z]+|shop [a-z]+|sign up|get yours|grab (?:yours|it|one)|available now|out now|now live|live now|link in bio|tap (?:the )?link|pre-?order|don'?t miss out|while (?:stocks|stock) last)\b/gi;
const URGENCY_RE = /\b(limited(?: time)?|last chance|ends|hurry|don'?t miss|final(?:ly)?|today only|selling fast|running out|now live|live now|only \d+|few left|while (?:stocks|stock) last)\b/i;
const PRICE_RE = /(\$\s?\d|\d+\s?%|% off|\boff\b)/i;
const EMOJI_RE = /\p{Extended_Pictographic}/u;

function pct(n, d) { return d ? Math.round((n / d) * 1000) / 10 : 0; }
function quantile(sorted, q) { if (!sorted.length) return 0; const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q))); return sorted[i]; }
const sentencesOf = (t) => t.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const wordsOf = (t) => t.split(/\s+/).filter(Boolean);
const tokens = (t) => t.toLowerCase().replace(/[^a-z0-9'\s-]/g, ' ').split(/\s+/).filter(Boolean);

function statsFor(bodies) {
  const n = bodies.length;
  if (!n) return null;
  const wordCounts = bodies.map((b) => wordsOf(b).length).sort((a, b) => a - b);
  const charCounts = bodies.map((b) => b.length).sort((a, b) => a - b);
  const sentCounts = bodies.map((b) => sentencesOf(b).length);
  const sentWords = bodies.flatMap((b) => sentencesOf(b).map((s) => wordsOf(s).length));
  const lineCounts = bodies.map((b) => b.split(/\n+/).filter((l) => l.trim()).length);
  const capsShare = bodies.map((b) => { const w = wordsOf(b).filter((x) => x.replace(/[^A-Za-z]/g, '').length >= 3); return w.length ? w.filter((x) => x === x.toUpperCase() && /[A-Z]/.test(x)).length / w.length : 0; });
  const avg = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : 0);
  const ctaCounts = new Map();
  bodies.forEach((b) => { const m = b.match(CTA_RE) || []; new Set(m.map((x) => x.toLowerCase())).forEach((x) => ctaCounts.set(x, (ctaCounts.get(x) || 0) + 1)); });
  const openerCounts = new Map();
  bodies.forEach((b) => { const o = tokens(b).slice(0, 3).join(' '); if (o) openerCounts.set(o, (openerCounts.get(o) || 0) + 1); });
  const gramCounts = new Map();
  bodies.forEach((b) => {
    const t = tokens(b); const seen = new Set();
    for (const size of [2, 3]) for (let i = 0; i + size <= t.length; i += 1) {
      const g = t.slice(i, i + size); if (g.every((w) => STOP.has(w))) continue; if (STOP.has(g[0]) && STOP.has(g[size - 1])) continue;
      seen.add(g.join(' '));
    }
    seen.forEach((g) => gramCounts.set(g, (gramCounts.get(g) || 0) + 1));
  });
  const top = (map, min, limit) => [...map.entries()].filter(([, c]) => c >= min).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([text, count]) => ({ text, count, share: pct(count, n) }));
  return {
    examples: n,
    words: { median: quantile(wordCounts, 0.5), p10: quantile(wordCounts, 0.1), p90: quantile(wordCounts, 0.9), avg: avg(wordCounts) },
    chars: { median: quantile(charCounts, 0.5), p90: quantile(charCounts, 0.9) },
    sentences: { avg_per_example: avg(sentCounts), avg_words_per_sentence: avg(sentWords) },
    lines: { avg_per_example: avg(lineCounts), multi_line_share: pct(lineCounts.filter((c) => c > 1).length, n) },
    shares: {
      emoji: pct(bodies.filter((b) => EMOJI_RE.test(b)).length, n),
      hashtags: pct(bodies.filter((b) => /#\w+/.test(b)).length, n),
      exclamation: pct(bodies.filter((b) => b.includes('!')).length, n),
      question: pct(bodies.filter((b) => b.includes('?')).length, n),
      urgency_language: pct(bodies.filter((b) => URGENCY_RE.test(b)).length, n),
      price_or_discount: pct(bodies.filter((b) => PRICE_RE.test(b)).length, n),
      all_caps_words: Math.round(avg(capsShare) * 1000) / 10,
      link_or_url: pct(bodies.filter((b) => /https?:\/\/|www\./i.test(b)).length, n),
    },
    cta_phrases: top(ctaCounts, 2, 8),
    openers: top(openerCounts, 2, 8),
    phrases: top(gramCounts, 3, 15),
  };
}

// examples: [{ family, body }] → the analysis stored with a sync
function analyseTone(allExamples) {
  const examples = allExamples.filter((e) => !e.excluded); // recruitment, testimonials and non-ad rows say nothing about how WNDRR writes ads
  const byFamily = {};
  for (const f of FAMILIES) {
    const bodies = examples.filter((e) => e.family === f).map((e) => e.body);
    if (bodies.length) byFamily[f] = statsFor(bodies);
  }
  const overall = statsFor(examples.map((e) => e.body));
  const notes = [];
  if (overall) {
    const rare = Object.entries(overall.shares).filter(([k, v]) => v < 3 && ['emoji', 'hashtags', 'exclamation', 'question', 'price_or_discount', 'link_or_url'].includes(k)).map(([k]) => k.replace(/_/g, ' '));
    if (rare.length) notes.push(`Rarely or never used in the reference examples (under 3%): ${rare.join(', ')}.`);
  }
  return { generated_at: new Date().toISOString(), examples: examples.length, families: byFamily, overall, notes };
}

// Recurring phrases are style evidence ("cop yours", "shop now"). One that states a product detail (a fabric, a count, a feature, a colour) is not style, so it is left out of the prompt.
function stylePhrases(list) {
  return (list || []).filter((p) => !/\d/.test(p.text) && !RULES.some((r) => r.mask && r.mask !== '[DISCOUNT]' && new RegExp(r.re.source, 'i').test(p.text)));
}

const labelOf = { emoji: 'emoji', hashtags: 'hashtags', exclamation: 'exclamation marks', question: 'questions', urgency_language: 'urgency language', price_or_discount: 'prices or discounts', all_caps_words: 'ALL-CAPS words', link_or_url: 'links' };

// Compact plain-text guideline block for the prompt, derived only from the stored analysis (and the AI summary of it, when one exists).
function guidelinesText(analysis, aiSummary, families = []) {
  if (!analysis || !analysis.overall) return '';
  const pick = families.length ? families.filter((f) => analysis.families[f]) : [];
  const blocks = (pick.length ? pick : ['overall']).map((f) => {
    const s = f === 'overall' ? analysis.overall : analysis.families[f];
    const share = Object.entries(s.shares).map(([k, v]) => `${labelOf[k] || k} ${v}%`).join(', ');
    return [
      `${f === 'overall' ? 'All examples' : `${f.toUpperCase()} examples`} (${s.examples}):`,
      `- Length: median ${s.words.median} words (typical range ${s.words.p10}-${s.words.p90}); about ${s.sentences.avg_per_example} sentences of ${s.sentences.avg_words_per_sentence} words; ${s.lines.avg_per_example} lines on average.`,
      `- Share of examples using: ${share}.`,
      stylePhrases(s.openers).length ? `- Common openings: ${stylePhrases(s.openers).map((o) => `"${o.text}" (${o.count})`).join(', ')}.` : null,
      s.cta_phrases.length ? `- Calls to action seen: ${s.cta_phrases.map((o) => `"${o.text}" (${o.count})`).join(', ')}.` : null,
      stylePhrases(s.phrases).length ? `- Recurring phrases: ${stylePhrases(s.phrases).slice(0, 10).map((o) => `"${o.text}"`).join(', ')}.` : null,
    ].filter(Boolean).join('\n');
  });
  const out = [...blocks];
  if (analysis.notes && analysis.notes.length) out.push(analysis.notes.join(' '));
  if (aiSummary) out.push(`Style summary written from the examples:\n${aiSummary}`);
  return out.join('\n\n');
}

// ── example selection ────────────────────────────────────────────────────────────────────────────────────────────
// Which families suit the ad (legacy, kept for the Settings statistics and older callers). Sales ads use sales copy, never product-launch copy.
function familiesFor({ adCategory, productName, productCategory }) {
  if (adCategory === 'promotion') return ['sales'];
  const text = `${productName || ''} ${productCategory || ''}`.toLowerCase();
  const bundle = /\b(bundle|box|pack|set|duo|trio)\b/.test(text) && /\b(bundle|pack|set|duo|trio|mystery)\b/.test(text);
  if (adCategory === 'new_drop') return bundle ? ['ranges', 'bundles'] : ['ranges', 'core'];
  return bundle ? ['core', 'bundles'] : ['core', 'ranges'];
}

// The Copy Type an Ad Setup category implies when no explicit type is given (older callers).
const typeForCategory = (adCategory) => ({ promotion: 'sale', new_drop: 'new_range', core: 'core' }[adCategory] || 'general');

const STAGE_WORDS = { hype: /(hype|coming|sign up|notif|teaser|soon)/i, sale_live: /(live|now on|starts|on now)/i, mid_sale: /(mid|still on|ongoing)/i, last_chance: /(last chance|final|ends|don'?t miss)/i };
const COLOUR_WORDS = /\bcolou?rs?\b|\bcolou?rways?\b/i;
// Garment groups: a "tee" reference is relevant to a "tee" product; shorts do not help a tee.
const GARMENT_GROUPS = [
  ['tee', 'tshirt', 'shirt', 'top', 'singlet', 'muscle', 'jersey', 'polo'],
  ['short', 'trackshort'],
  ['pant', 'trackpant', 'jogger', 'jean', 'trouser', 'cargo', 'trackpants'],
  ['hood', 'hoodie', 'sweat', 'crew', 'jumper', 'sweater', 'fleece', 'tracksuit'],
  ['jacket', 'coat', 'puffer', 'vest'],
  ['cap', 'hat', 'beanie', 'sock', 'bag', 'belt', 'wallet'],
];
const KIND_WEIGHT = { product: 2, lifestyle: 0, range_layout: -2, bundle: 0, sale: 0, other: 0 };
const NEVER_REFERENCE = new Set(['recruitment', 'testimonial', 'pinterest']);

// What to look for in a reference: the product's type (from its category, e.g. "box fit tee"), its head noun ("tee") and its distinctive name words ("asset", "raglan").
function productQuery({ productName, productCategory }) {
  const catWords = contentWords(productCategory || '');
  const nameWords = contentWords(productName || '');
  const head = catWords.length ? catWords[catWords.length - 1] : (nameWords.length ? nameWords[nameWords.length - 1] : null);
  const distinct = nameWords.filter((w) => !catWords.includes(w) && w !== head);
  const typePhrase = catWords.length > 1 ? catWords.join(' ') : null;
  const group = head ? GARMENT_GROUPS.findIndex((g) => g.map((w) => wordList(w)[0]).includes(head)) : -1;
  return { head, distinct, typePhrase, group };
}

// Relevance of one reference to the product: whole-word matches only ("boxy" is not "box", "fits" is "fit"); decorative lettering is resolved first.
function relevanceScore(e, q) {
  const subj = `${e.subject || ''} ${e.label || ''}`;
  let score = 0;
  if (q.typePhrase && hasPhrase(subj, q.typePhrase)) score += 6; else if (q.typePhrase && hasPhrase(e.body, q.typePhrase)) score += 4;
  if (q.head && hasPhrase(subj, q.head)) score += 3;
  else if (q.head && hasPhrase(e.body, q.head)) score += 2;
  else if (q.group >= 0 && GARMENT_GROUPS[q.group].some((w) => hasPhrase(`${subj} ${e.body}`, w))) score += 1;
  let nameScore = 0;
  for (const w of q.distinct) { if (hasPhrase(subj, w)) nameScore += 5; else if (hasPhrase(e.body, w)) nameScore += 3; }
  return score + Math.min(nameScore, 8);
}

const inTabs = (e, tabs, families) => (e.tab ? tabs.includes(e.tab) : families.includes(e.family));

// Choose up to `limit` references: best score first, but never two near-identical texts, never two about the same product, and no single tab fills the set.
function pickVaried(cands, limit, chosen) {
  const out = chosen.slice();
  const perTab = {}; out.forEach((e) => { const k = e.tab || e.family; perTab[k] = (perTab[k] || 0) + 1; });
  const maxPerTab = Math.max(2, Math.ceil(limit / 2));
  const remaining = cands.slice().sort((a, b) => b.score - a.score || (a.id || 0) - (b.id || 0));
  const subjectKey = (e) => (e.kind === 'product' && e.subject ? plain(e.subject) : null);
  while (out.length < limit && remaining.length) {
    let bestI = -1; let bestV = -Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const c = remaining[i];
      if ((perTab[c.tab || c.family] || 0) >= maxPerTab) continue;
      const sk = subjectKey(c);
      if (sk && out.some((o) => subjectKey(o) === sk)) continue;
      const sim = out.reduce((m, o) => Math.max(m, similarity(c.body, o.body)), 0);
      if (sim >= 0.55) continue;
      const v = c.score - 6 * sim;
      if (v > bestV) { bestV = v; bestI = i; }
    }
    if (bestI < 0) break;
    const [pick] = remaining.splice(bestI, 1);
    out.push(pick);
    perTab[pick.tab || pick.family] = (perTab[pick.tab || pick.family] || 0) + 1;
  }
  return out;
}

// Deterministic selection of style references for an ad.
//   copyType     one of copyTypes.VALUES (defaults from adCategory for older callers)
//   productName, productCategory, stageType (sales), limit
// Spreadsheet families are used strictly in tiers (see copyTypes.TAB_PLAN): the type's own tabs first; the secondary tabs only if the primary ones cannot fill the set.
// Recruitment ads, testimonials and non-ad rows are never used. Every returned example carries its `score`.
function selectExamples(all, { copyType, adCategory, stageType, productName, productCategory, limit = 6 }) {
  const type = copyTypes.isCopyType(copyType) ? copyType : typeForCategory(adCategory);
  const plan = copyTypes.TAB_PLAN[type];
  const q = productQuery({ productName, productCategory });
  const pool = all.map((e) => {
    const en = enrichExample(e);
    return { ...e, subject: e.subject || en.subject, kind: e.kind || en.kind, excluded: !!e.excluded || en.excluded, exclude_reason: e.exclude_reason || en.exclude_reason };
  }).filter((e) => !e.excluded && !NEVER_REFERENCE.has(e.kind));
  const scoreOf = (e, tier) => {
    let score = relevanceScore(e, q) + (KIND_WEIGHT[e.kind] || 0);
    if (type === 'new_range' && e.kind === 'range_layout') score += 2; // range-level posts are on topic for a new range
    if (type === 'new_colourways' && COLOUR_WORDS.test(normalizeUnicode(e.body))) score += 3;
    if (type === 'sale' && stageType && STAGE_WORDS[stageType]) {
      if (STAGE_WORDS[stageType].test(`${e.subject || ''} ${e.label || ''} ${e.meta && e.meta.column ? e.meta.column : ''}`)) score += 4;
      if (STAGE_WORDS[stageType].test(e.body)) score += 2;
    }
    const order = (tier === 'primary' ? plan.primary : plan.secondary).indexOf(e.tab);
    score += order >= 0 ? (plan.primary.length - order) * 0.3 : 0;
    score += ((e.year || 2020) - 2020) * 0.5;
    return score;
  };
  const tier = (which) => pool.filter((e) => inTabs(e, plan[which], plan.families[which])).map((e) => ({ ...e, score: scoreOf(e, which) }));
  let out = pickVaried(tier('primary'), limit, []);
  if (out.length < limit) out = pickVaried(tier('secondary').filter((c) => !out.some((o) => o.id === c.id && o.id !== undefined)), limit, out);
  if (!out.length && type !== 'sale') {
    // the library has none of this type's tabs: any ordinary ad copy is better than nothing (never sales copy for a non-sale ad)
    out = pickVaried(pool.filter((e) => e.family !== 'sales').map((e) => ({ ...e, score: scoreOf(e, 'secondary') })), limit, []);
  }
  return out;
}

// What the model is shown for a reference: the text with another product's details removed (names, counts, materials, features, colours, prices, bullet lists).
// The original text stays in the library and in the "References used" list; only the model's copy is masked.
function promptExample(e) {
  const names = [];
  // a product / bundle / range name is hidden; the title of a lifestyle post ("3 fits for summer") is style, and any claim inside it is masked by maskClaims
  if (e.subject && ['product', 'range_layout', 'bundle'].includes(e.kind)) names.push(e.subject);
  if (e.label && e.kind !== 'sale') names.push(e.label);
  return { id: e.id, tab: e.tab, label: e.kind === 'sale' ? (e.subject || e.label) : null, body: maskClaims(e.body, names) };
}

// ── database: validated import + reads ──────────────────────────────────────────────────────────────────────────────
// Reads every expected tab and parses it. Nothing is written anywhere (neither the database nor the spreadsheet).
async function readLibraryPlan(sheets) {
  const titles = (await sheets.listTabs()).map((t) => t.title);
  const matched = matchTabs(titles);
  const tabReports = []; const all = [];
  for (const tab of matched) {
    if (!tab.actual) { tabReports.push({ title: tab.title, family: tab.family, found: false, examples: 0, excluded: 0, warnings: ['Tab not found in the spreadsheet.'] }); continue; }
    const rows = await sheets.readTab(tab.actual);
    const parsed = parseTab(rows, tab);
    const enriched = parsed.examples.map((e) => ({ ...e, ...enrichExample({ ...e, tab: tab.title, family: tab.family }), tab: tab.title, family: tab.family, year: tab.year || null }));
    const kinds = {}; enriched.forEach((e) => { kinds[e.kind] = (kinds[e.kind] || 0) + 1; });
    tabReports.push({
      title: tab.title, family: tab.family, found: true, rows_read: parsed.rows_read, examples: enriched.length, excluded: enriched.filter((e) => e.excluded).length,
      with_subject: enriched.filter((e) => e.subject).length, kinds, filled_down: parsed.filled_down, header_found: parsed.header_found, columns: parsed.columns, warnings: parsed.warnings,
    });
    enriched.forEach((e) => all.push(e));
  }
  return { tabReports, all };
}

// Checks a parsed import BEFORE it replaces the library. `previous` = the currently active library (or null).
function validatePlan(plan, previous, { acceptSmaller = false } = {}) {
  const errors = []; const warnings = [];
  const usable = plan.all.filter((e) => !e.excluded).length;
  if (!plan.all.length) errors.push({ code: 'no_examples', message: 'The spreadsheet was read but no usable copy examples were found. Check the tab names and column headers.' });
  else if (usable < 5) errors.push({ code: 'too_few', message: `Only ${usable} usable copy examples were found; the library was not replaced.` });
  if (previous && previous.example_count > 0 && plan.all.length < previous.example_count * 0.6 && !acceptSmaller) {
    errors.push({ code: 'shrunk', message: `The new import has ${plan.all.length} examples but the current library has ${previous.example_count}. Nothing was replaced; check the spreadsheet, or accept the smaller library explicitly.` });
  }
  for (const t of plan.tabReports) {
    if (!t.found) { warnings.push(`${t.title}: tab not found.`); continue; }
    if (t.header_found && t.columns && t.columns.body.length && !t.examples) warnings.push(`${t.title}: the copy column was found but held no usable text.`);
    if (t.columns && t.columns.subject !== null && t.examples && t.with_subject / t.examples < 0.5) warnings.push(`${t.title}: fewer than half of the examples have a product / subject.`);
    if (t.excluded) warnings.push(`${t.title}: ${t.excluded} example(s) kept but never used as references (recruitment, testimonials or not Meta ad copy).`);
  }
  return { ok: errors.length === 0, errors, warnings, usable, excluded: plan.all.length - usable };
}

// Never throws for an expected failure: the sync row records it and the previous successful sync stays the active library.
// dryRun: read, parse and validate only -- no row is written; returns the report an admin can look at before refreshing.
async function syncLibrary({ db, sheets, userId = null, source = 'sheets', dryRun = false, acceptSmaller = false }) {
  let syncId = null;
  const fail = async (err) => {
    if (syncId) await db.query("UPDATE copy_reference_syncs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1", [syncId, String(err.message || err).slice(0, 500)]);
    return { ok: false, sync_id: syncId, code: err.code || 'error', error: String(err.message || err) };
  };
  try {
    if (!dryRun) {
      const started = await db.query("INSERT INTO copy_reference_syncs (status, triggered_by_user_id, source) VALUES ('running', $1, $2) RETURNING id", [userId, source]);
      syncId = started.rows[0].id;
    }
    const plan = await readLibraryPlan(sheets);
    const previous = await latestSuccess(db);
    const verdict = validatePlan(plan, source === 'import' ? null : previous, { acceptSmaller });
    const report = {
      examples: plan.all.length, usable: verdict.usable, excluded: verdict.excluded, tabs: plan.tabReports, warnings: verdict.warnings,
      current: previous ? { examples: previous.example_count, synced_at: previous.finished_at } : null,
    };
    if (dryRun) return { ok: verdict.ok, dry_run: true, errors: verdict.errors, ...report };
    if (!verdict.ok) throw Object.assign(new Error(verdict.errors.map((e) => e.message).join(' ')), { code: verdict.errors[0].code });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const e of plan.all) {
        await client.query(
          'INSERT INTO copy_reference_examples (sync_id, tab, family, row_number, label, body, headline, meta, subject, kind, excluded, exclude_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)',
          [syncId, e.tab, e.family, e.row_number, e.label, e.body, e.headline, JSON.stringify({ ...e.meta, year: e.year }), e.subject, e.kind, !!e.excluded, e.exclude_reason]
        );
      }
      const analysis = analyseTone(plan.all);
      await client.query('INSERT INTO copy_tone_guidelines (sync_id, analysis) VALUES ($1, $2::jsonb)', [syncId, JSON.stringify(analysis)]);
      await client.query("UPDATE copy_reference_syncs SET status = 'success', finished_at = now(), tabs = $2::jsonb, example_count = $3 WHERE id = $1", [syncId, JSON.stringify(plan.tabReports), plan.all.length]);
      // keep the three most recent successful libraries; older caches are dropped (they only hold copies of the sheet)
      await client.query(`DELETE FROM copy_reference_syncs WHERE status = 'success' AND id NOT IN (SELECT id FROM copy_reference_syncs WHERE status = 'success' ORDER BY id DESC LIMIT 3)`);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    return { ok: true, sync_id: syncId, ...report, warnings: verdict.warnings };
  } catch (err) {
    return fail(err);
  }
}

async function latestSuccess(db) {
  const r = await db.query("SELECT * FROM copy_reference_syncs WHERE status = 'success' ORDER BY id DESC LIMIT 1");
  return r.rows[0] || null;
}

async function status(db, sheets, aiConfigured) {
  const cfg = sheets.readCredentials();
  const last = await latestSuccess(db);
  const attempt = (await db.query('SELECT id, status, started_at, finished_at, error FROM copy_reference_syncs ORDER BY id DESC LIMIT 1')).rows[0] || null;
  const g = last ? (await db.query('SELECT analysis, ai_summary, created_at FROM copy_tone_guidelines WHERE sync_id = $1 ORDER BY id DESC LIMIT 1', [last.id])).rows[0] : null;
  return {
    sheets: { configured: cfg.configured, reason: cfg.reason, sheet_id: sheets.sheetId(), service_account: cfg.configured ? cfg.credentials.client_email : null },
    library: last ? { synced_at: last.finished_at, example_count: last.example_count, tabs: last.tabs, source: last.source || 'sheets' } : null,
    last_attempt: attempt && (!last || attempt.id !== last.id) ? { status: attempt.status, at: attempt.finished_at || attempt.started_at, error: attempt.error } : null,
    guidelines: g ? { generated_at: g.created_at, has_ai_summary: !!g.ai_summary } : null,
    ai: { configured: !!aiConfigured, reason: aiConfigured ? null : require('./copyAi').aiConfig().reason },
  };
}

// Library rows -> examples. A library imported before subject / kind existed is enriched here, from the same rules, so it improves without a re-import.
async function loadExamples(db) {
  const last = await latestSuccess(db);
  if (!last) return { sync: null, examples: [] };
  const rows = (await db.query('SELECT id, tab, family, row_number, label, body, headline, meta, subject, kind, excluded, exclude_reason FROM copy_reference_examples WHERE sync_id = $1 ORDER BY id', [last.id])).rows;
  // rows are in sheet order: a merged Range (and, on the sales tabs, a merged stage) that an earlier import left blank takes the value above it, exactly as a new import does
  const lastLabel = {}; const lastSubject = {};
  return {
    sync: last,
    examples: rows.map((r) => {
      let label = r.label; let subject = r.subject || (r.meta && (r.meta.What || r.meta['Product/Range'])) || null;
      if (label) lastLabel[r.tab] = label; else if (lastLabel[r.tab]) label = lastLabel[r.tab];
      if (r.family === 'sales') { if (subject) lastSubject[r.tab] = subject; else if (lastSubject[r.tab]) subject = lastSubject[r.tab]; }
      const en = enrichExample({ ...r, label, subject });
      return { ...r, label, subject: r.subject || en.subject, kind: r.kind || en.kind, excluded: !!r.excluded || en.excluded, exclude_reason: r.exclude_reason || en.exclude_reason, year: r.meta && r.meta.year ? Number(r.meta.year) : null };
    }),
  };
}

async function loadGuidelines(db) {
  const last = await latestSuccess(db);
  if (!last) return null;
  const g = (await db.query('SELECT id, analysis, ai_summary, created_at FROM copy_tone_guidelines WHERE sync_id = $1 ORDER BY id DESC LIMIT 1', [last.id])).rows[0];
  return g ? { ...g, sync_id: last.id, synced_at: last.finished_at } : null;
}

module.exports = {
  EXPECTED_TABS, FAMILIES, parseTab, matchTabs, analyseTone, statsFor, guidelinesText, familiesFor, selectExamples, promptExample, enrichExample, productQuery, relevanceScore,
  readLibraryPlan, validatePlan, syncLibrary, latestSuccess, status, loadExamples, loadGuidelines, typeForCategory,
};
