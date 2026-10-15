// WNDRR copy reference library: read-only sync from Google Sheets, a cache in the database, deterministic tone-of-voice statistics, and example
// selection for the AI Copy Assistant. The source spreadsheet is never modified. Nothing here is hard-coded as a "finding": every guideline the
// assistant sees is computed from the examples that were actually read in the last successful sync.

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
const HEADER_HINT = /(primary|headline|copy|text|caption|description|product|range|sale|campaign|collection|name|title|style|body|message|link|cta|date|hook|type)/i;
const BODY_PATTERNS = [/^primary\s*text/i, /primary/i, /ad\s*copy/i, /^copy$/i, /copy/i, /^body/i, /caption/i, /^text$/i, /text/i, /message/i, /description/i];
const HEADLINE_RE = /head\s*line|^title$|^headline/i;
const LABEL_RE = /product|range|name|sale|campaign|collection|style|drop/i;

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

// → { header_found, columns: { body: [idx], headline, label }, examples, warnings }
function parseTab(rows, tab = {}) {
  const warnings = [];
  const data = (rows || []).map((r) => (r || []).map(norm));
  const headerIdx = findHeaderRow(data);
  const headers = headerIdx >= 0 ? data[headerIdx] : [];
  const columns = { body: [], headline: null, label: null };

  if (headerIdx >= 0) {
    headers.forEach((h, i) => { if (HEADLINE_RE.test(h) && columns.headline === null) columns.headline = i; });
    for (const re of BODY_PATTERNS) {
      const idxs = headers.map((h, i) => (re.test(h) && !HEADLINE_RE.test(h) && i !== columns.headline ? i : -1)).filter((i) => i >= 0);
      if (idxs.length) { columns.body = idxs; break; }
    }
    headers.forEach((h, i) => { if (columns.label === null && LABEL_RE.test(h) && !columns.body.includes(i) && i !== columns.headline) columns.label = i; });
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
  if (!columns.body.length) { warnings.push('No copy text was found on this tab.'); return { header_found: headerIdx >= 0, columns, examples: [], warnings, rows_read: data.length }; }

  const seen = new Set();
  const examples = [];
  bodyRows.forEach((r, offset) => {
    const rowNumber = headerIdx + 2 + offset; // 1-based sheet row
    for (const c of columns.body) {
      const body = r[c];
      if (!body || body.length < MIN_BODY_CHARS || !/[a-z]/i.test(body)) continue;
      if (headers[c] && key(body) === key(headers[c])) continue;
      const dedupe = key(body);
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const label = columns.label !== null ? r[columns.label] : (r.find((cell, i) => cell && !columns.body.includes(i) && i !== columns.headline && cell.length <= 80) || '');
      const extra = {};
      r.forEach((cell, i) => { if (cell && !columns.body.includes(i) && i !== columns.headline && i !== columns.label && headers[i]) extra[headers[i]] = cell.slice(0, 200); });
      examples.push({
        row_number: rowNumber, label: (label || '').slice(0, 255) || null,
        headline: columns.headline !== null && r[columns.headline] ? r[columns.headline] : null,
        body, meta: { ...extra, ...(columns.body.length > 1 ? { column: headers[c] || `column ${c + 1}` } : {}) },
      });
    }
  });
  if (!examples.length) warnings.push('The copy column was found but contained no usable text.');
  return { header_found: headerIdx >= 0, columns, examples, warnings, rows_read: data.length };
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
function analyseTone(examples) {
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
      s.openers.length ? `- Common openings: ${s.openers.map((o) => `"${o.text}" (${o.count})`).join(', ')}.` : null,
      s.cta_phrases.length ? `- Calls to action seen: ${s.cta_phrases.map((o) => `"${o.text}" (${o.count})`).join(', ')}.` : null,
      s.phrases.length ? `- Recurring phrases: ${s.phrases.slice(0, 10).map((o) => `"${o.text}"`).join(', ')}.` : null,
    ].filter(Boolean).join('\n');
  });
  const out = [...blocks];
  if (analysis.notes && analysis.notes.length) out.push(analysis.notes.join(' '));
  if (aiSummary) out.push(`Style summary written from the examples:\n${aiSummary}`);
  return out.join('\n\n');
}

// ── example selection ────────────────────────────────────────────────────────────────────────────────────────────
// Which families suit the ad. Sales ads use sales copy, never product-launch copy; a bundle product also looks at bundles.
function familiesFor({ adCategory, productName, productCategory }) {
  if (adCategory === 'promotion') return ['sales'];
  const text = `${productName || ''} ${productCategory || ''}`.toLowerCase();
  const bundle = /\b(bundle|box|pack|set|duo|trio)\b/.test(text) && /\b(bundle|pack|set|duo|trio|mystery)\b/.test(text);
  if (adCategory === 'new_drop') return bundle ? ['ranges', 'bundles'] : ['ranges', 'core'];
  return bundle ? ['core', 'bundles'] : ['core', 'ranges'];
}

const STAGE_WORDS = { hype: /(hype|coming|sign up|notif|teaser|soon)/i, sale_live: /(live|now on|starts|on now)/i, mid_sale: /(mid|still on|ongoing)/i, last_chance: /(last chance|final|ends|don'?t miss)/i };

// Deterministic scoring: product/category word overlap, stage keywords for sales, newer years first. Returns at most `limit` examples.
function selectExamples(all, { adCategory, stageType, productName, productCategory, limit = 6 }) {
  const fams = familiesFor({ adCategory, productName, productCategory });
  const pool = all.filter((e) => fams.includes(e.family));
  const words = tokens(`${productName || ''} ${productCategory || ''}`).filter((w) => w.length > 2 && !STOP.has(w));
  const scored = pool.map((e) => {
    const hay = `${e.label || ''} ${e.body}`.toLowerCase();
    let score = 0;
    words.forEach((w) => { if (hay.includes(w)) score += 3; });
    if (adCategory === 'promotion' && stageType && STAGE_WORDS[stageType]) { if (STAGE_WORDS[stageType].test(`${e.label || ''} ${e.meta && e.meta.column ? e.meta.column : ''}`)) score += 4; if (STAGE_WORDS[stageType].test(e.body)) score += 2; }
    score += fams.length - fams.indexOf(e.family); // earlier family first
    score += ((e.year || 2020) - 2020) * 0.5;
    return { e, score };
  });
  scored.sort((a, b) => b.score - a.score || (a.e.id || 0) - (b.e.id || 0));
  // spread across families so one tab does not crowd out the rest
  const out = []; const perFam = {};
  for (const { e } of scored) {
    perFam[e.family] = (perFam[e.family] || 0);
    if (perFam[e.family] >= Math.ceil(limit / fams.length) + 1) continue;
    out.push(e); perFam[e.family] += 1;
    if (out.length >= limit) break;
  }
  return out;
}

// ── database: sync + reads ─────────────────────────────────────────────────────────────────────────────────────────
// Never throws for an expected failure: the sync row records it and the previous successful sync stays the active library.
async function syncLibrary({ db, sheets, userId = null }) {
  const started = await db.query("INSERT INTO copy_reference_syncs (status, triggered_by_user_id) VALUES ('running', $1) RETURNING id", [userId]);
  const syncId = started.rows[0].id;
  const fail = async (err) => {
    await db.query("UPDATE copy_reference_syncs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1", [syncId, String(err.message || err).slice(0, 500)]);
    return { ok: false, sync_id: syncId, code: err.code || 'error', error: String(err.message || err) };
  };
  try {
    const titles = (await sheets.listTabs()).map((t) => t.title);
    const matched = matchTabs(titles);
    const tabReports = []; const all = [];
    for (const tab of matched) {
      if (!tab.actual) { tabReports.push({ title: tab.title, family: tab.family, found: false, examples: 0, warnings: ['Tab not found in the spreadsheet.'] }); continue; }
      const rows = await sheets.readTab(tab.actual);
      const parsed = parseTab(rows, tab);
      tabReports.push({ title: tab.title, family: tab.family, found: true, rows_read: parsed.rows_read, examples: parsed.examples.length, header_found: parsed.header_found, columns: parsed.columns, warnings: parsed.warnings });
      parsed.examples.forEach((e) => all.push({ ...e, tab: tab.title, family: tab.family, year: tab.year || null }));
    }
    if (!all.length) throw Object.assign(new Error('The spreadsheet was read but no usable copy examples were found. Check the tab names and column headers.'), { code: 'no_examples' });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const e of all) {
        await client.query(
          'INSERT INTO copy_reference_examples (sync_id, tab, family, row_number, label, body, headline, meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
          [syncId, e.tab, e.family, e.row_number, e.label, e.body, e.headline, JSON.stringify({ ...e.meta, year: e.year })]
        );
      }
      const analysis = analyseTone(all);
      await client.query('INSERT INTO copy_tone_guidelines (sync_id, analysis) VALUES ($1, $2::jsonb)', [syncId, JSON.stringify(analysis)]);
      await client.query("UPDATE copy_reference_syncs SET status = 'success', finished_at = now(), tabs = $2::jsonb, example_count = $3 WHERE id = $1", [syncId, JSON.stringify(tabReports), all.length]);
      // keep the three most recent successful libraries; older caches are dropped (they only hold copies of the sheet)
      await client.query(`DELETE FROM copy_reference_syncs WHERE status = 'success' AND id NOT IN (SELECT id FROM copy_reference_syncs WHERE status = 'success' ORDER BY id DESC LIMIT 3)`);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    return { ok: true, sync_id: syncId, examples: all.length, tabs: tabReports };
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
    library: last ? { synced_at: last.finished_at, example_count: last.example_count, tabs: last.tabs } : null,
    last_attempt: attempt && (!last || attempt.id !== last.id) ? { status: attempt.status, at: attempt.finished_at || attempt.started_at, error: attempt.error } : null,
    guidelines: g ? { generated_at: g.created_at, has_ai_summary: !!g.ai_summary } : null,
    ai: { configured: !!aiConfigured },
  };
}

async function loadExamples(db) {
  const last = await latestSuccess(db);
  if (!last) return { sync: null, examples: [] };
  const rows = (await db.query('SELECT id, tab, family, label, body, headline, meta FROM copy_reference_examples WHERE sync_id = $1 ORDER BY id', [last.id])).rows;
  return { sync: last, examples: rows.map((r) => ({ ...r, year: r.meta && r.meta.year ? Number(r.meta.year) : null })) };
}

async function loadGuidelines(db) {
  const last = await latestSuccess(db);
  if (!last) return null;
  const g = (await db.query('SELECT id, analysis, ai_summary, created_at FROM copy_tone_guidelines WHERE sync_id = $1 ORDER BY id DESC LIMIT 1', [last.id])).rows[0];
  return g ? { ...g, sync_id: last.id, synced_at: last.finished_at } : null;
}

module.exports = {
  EXPECTED_TABS, FAMILIES, parseTab, matchTabs, analyseTone, statsFor, guidelinesText, familiesFor, selectExamples, syncLibrary, latestSuccess, status, loadExamples, loadGuidelines,
};
