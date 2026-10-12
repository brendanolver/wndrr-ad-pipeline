// Data-driven seasonality for Creative Planning (Australian calendar months).
//
// INPUT is real WNDRR sales: units sold per style per month (ApparelMagic online-sales crawl, see apparelmagic.getSalesByStyle().months). Nothing here
// assumes "shorts sell in summer": a product or category is seasonal only if its own sales say so, and says "insufficient data" when they cannot.
//
// METHOD (one season-index per product / category per calendar month):
//   1. A product's month is compared with its OWN average month while it was on sale (ratio 1.0 = usual).
//   2. That ratio is divided by the STORE-WIDE level for the month = the median of those ratios across every product that had enough sales history.
//      A store-wide surge (Black Friday, a site-wide sale, a big ad push) lifts almost every product at once, so the median lifts with it and the surge
//      cancels; a genuinely seasonal product moves differently from the median and stands out. (A plain share-of-total would make a flat product look
//      seasonal whenever another category peaked, so it is not used.) With too few products to take a median it falls back to the store's total units.
//   * Months before a product existed are NOT weak demand: a product's months start the month AFTER its launch (the launch month is partial) and at
//     its first sale; it needs at least MIN_MONTHS on-sale months and MIN_UNITS units, else it falls back to its CATEGORY's pattern (labelled), else
//     "Insufficient data".
//   * A month with almost no sales between two normal months is treated as a possible STOCKOUT (unavailable stock is not weak demand): it is left out,
//     not counted as a trough.
//   * A one-off spike is capped (SPIKE_CAP x the product's median index) so a single wholesale / hero order cannot create a "season".
//   * The month being judged is in progress, so it is built from its two halves in the window (the end of last year's and this year's so far, folded
//     into one month when they cover at least 80 % of it), else read from the neighbouring complete months; the next 4-8 weeks are weighted by days.
// STATUS: year_round (every month within the band) | in_season (now >= IN_SEASON) | coming_into_season (the next 4-8 weeks are in season and now is
//   not, and rising) | out_of_season (now <= OUT_OF_SEASON, or heading into a trough) | shoulder (in between) | insufficient_data.
// LIMIT, stated in every result: the sales feed holds about 12 months, so this is ONE observed cycle. It is real evidence, not proof that the pattern
// repeats; a second year would confirm it. Confidence is reported accordingly.
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CFG = {
  MIN_MONTHS: 9,            // on-sale months needed to judge a pattern
  MIN_UNITS: 60,            // units over those months
  IN_SEASON: 1.10,
  OUT_OF_SEASON: 0.80,
  RISING_DELTA: 0.15,       // the next 4-8 weeks must beat "now" by this to be "coming"
  YEAR_ROUND_BAND: [0.80, 1.25],
  SPIKE_CAP: 3,
  GAP_FRACTION: 0.2,        // a month under this share of the usual month, between two normal months = possible stockout
  GAP_NEIGHBOUR: 0.6,
  HORIZON_DAYS: [28, 56],   // "the next 4-8 weeks"
  MIN_PRODUCTS_FOR_MEDIAN: 5, // products needed to take the store-wide median (else the store's total units are used)
};

const pad2 = (n) => String(n).padStart(2, '0');
const ymOf = (ymd) => String(ymd).slice(0, 7);
const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${pad2((t % 12) + 1)}`; };
const monthNum = (ym) => Number(ym.slice(5, 7));
const dayMs = 86400000;
const toMs = (ymd) => { const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
const toYmd = (ms) => new Date(ms).toISOString().slice(0, 10);
const daysInMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const median = (a) => { const s = a.filter((x) => Number.isFinite(x)).slice().sort((x, y) => x - y); if (!s.length) return 0; const h = Math.floor(s.length / 2); return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const r2 = (x) => Math.round(x * 100) / 100;

// Complete calendar months inside the sales window [from, today): the month containing `from` is dropped unless `from` is its first day, and the
// current month (still in progress) is never included.
function completeMonths(from, today, { foldStart = false } = {}) {
  const cur = ymOf(today);
  let first = ymOf(from);
  if (String(from).slice(8, 10) !== '01' && !foldStart) first = addMonths(first, 1);
  const out = [];
  for (let m = first; m < cur; m = addMonths(m, 1)) out.push(m);
  return out;
}

// the share of the 4-8 week horizon that falls in each month: { 'YYYY-MM': weight }, weights sum to 1
function horizonWeights(today) {
  const t = toMs(today); const a = t + CFG.HORIZON_DAYS[0] * dayMs; const b = t + CFG.HORIZON_DAYS[1] * dayMs;
  const w = {}; let tot = 0;
  for (let ms = a; ms < b; ms += dayMs) { const k = toYmd(ms).slice(0, 7); w[k] = (w[k] || 0) + 1; tot += 1; }
  Object.keys(w).forEach((k) => { w[k] /= tot; });
  return w;
}

// the share of an arbitrary day range [fromDay, toDay) (days ahead of today) that falls in each month
function rangeWeights(today, fromDay, toDay) {
  const t = toMs(today); const w = {}; let tot = 0;
  for (let d = fromDay; d < toDay; d += 1) { const k = toYmd(t + d * dayMs).slice(0, 7); w[k] = (w[k] || 0) + 1; tot += 1; }
  Object.keys(w).forEach((k) => { w[k] /= tot || 1; });
  return w;
}

// ONE series -> a season assessment.   series: { 'YYYY-MM': units } ; factor: { 'YYYY-MM': store-wide level for that month (1.0 = usual) } ;
// startMonth: first on-sale month (inclusive)
function assessSeries({ series, factor, months, startMonth, today, label, lookahead = { immediate_days: 7, secondary_days: 14 } }) {
  const avail = months.filter((m) => !startMonth || m >= startMonth);
  const units = avail.map((m) => Math.max(0, Number(series[m]) || 0));
  const total = units.reduce((s, x) => s + x, 0);
  const insufficient = (reason) => ({ status: 'insufficient_data', evidence: { reason, why: [`Not enough sales history to judge seasonality: ${reason}. Season is not used for this product's priority.`], monthly: months.map((m) => ({ m, u: Math.round(Number(series[m]) || 0), on_sale: !startMonth || m >= startMonth, i: null, flag: null })), now_month: ymOf(today), horizon_months: [], months_used: avail.length, units: Math.round(total), summary: reason, confidence: 'none', caveats: [] } });
  if (avail.length < CFG.MIN_MONTHS) return insufficient(`${avail.length} month${avail.length === 1 ? '' : 's'} on sale (needs ${CFG.MIN_MONTHS})`);
  if (total < CFG.MIN_UNITS) return insufficient(`${Math.round(total)} units sold (needs ${CFG.MIN_UNITS})`);

  const caveats = [];
  const nonzero = units.filter((u) => u > 0);
  const med = median(nonzero);
  // possible stockout: a month far below the usual one between two normal months is left out (never read as weak demand)
  const gaps = [];
  avail.forEach((m, i) => {
    const u = units[i];
    const prev = i > 0 ? units[i - 1] : null; const next = i < avail.length - 1 ? units[i + 1] : null;
    if (u <= CFG.GAP_FRACTION * med && prev !== null && next !== null && (prev + next) / 2 >= CFG.GAP_NEIGHBOUR * med) gaps.push(m);
  });
  // index = the product's month relative to its own average, divided by the store-wide level for that month; spikes capped
  const own = total / avail.length;
  const raw = avail.map((m, i) => { const f = Number(factor[m]) || 0; return f > 0 && own > 0 ? (units[i] / own) / f : null; });
  const medIdx = median(raw.filter((x) => x !== null && x > 0));
  const spikes = [];
  const used = []; // { m, v }
  avail.forEach((m, i) => {
    if (raw[i] === null || gaps.includes(m)) return;
    let v = raw[i];
    if (medIdx > 0 && v > CFG.SPIKE_CAP * medIdx) { v = CFG.SPIKE_CAP * medIdx; spikes.push(m); }
    used.push({ m, v });
  });
  if (used.length < CFG.MIN_MONTHS - 1) return insufficient(`only ${used.length} usable months after leaving out possible stockouts`);
  const avgIdx = used.reduce((s, x) => s + x.v, 0) / used.length;
  if (!(avgIdx > 0)) return insufficient('no sales to compare');
  const idx = {}; used.forEach((x) => { idx[x.m] = x.v / avgIdx; });

  // calendar-month profile (a month can appear once in a 12-month window; average if it ever appears twice)
  const prof = {};
  Object.keys(idx).forEach((m) => { const n = monthNum(m); (prof[n] = prof[n] || []).push(idx[m]); });
  const profile = {}; for (let n = 1; n <= 12; n += 1) profile[n] = prof[n] ? prof[n].reduce((s, x) => s + x, 0) / prof[n].length : null;
  // fill an unknown calendar month from its nearest known neighbours (needed for the in-progress month and any left-out month)
  const fill = (n) => {
    if (profile[n] !== null) return profile[n];
    let l = null; let r = null;
    for (let k = 1; k <= 3 && l === null; k += 1) { const v = profile[((n - 1 - k + 120) % 12) + 1]; if (v !== null) l = v; }
    for (let k = 1; k <= 3 && r === null; k += 1) { const v = profile[((n - 1 + k) % 12) + 1]; if (v !== null) r = v; }
    return l !== null && r !== null ? (l + r) / 2 : (l !== null ? l : r);
  };
  const curN = monthNum(ymOf(today));
  const cur = fill(curN);
  const hw = horizonWeights(today);
  let horizon = 0; let wsum = 0;
  Object.entries(hw).forEach(([m, w]) => { const v = fill(monthNum(m)); if (v !== null) { horizon += v * w; wsum += w; } });
  horizon = wsum > 0 ? horizon / wsum : null;
  if (cur === null || horizon === null) return insufficient('the months that matter now have no usable history');

  const known = Object.values(profile).filter((v) => v !== null);
  const peaks = []; const troughs = [];
  for (let n = 1; n <= 12; n += 1) { const v = profile[n]; if (v === null) continue; if (v >= CFG.IN_SEASON) peaks.push([n, v]); if (v <= CFG.OUT_OF_SEASON) troughs.push([n, v]); }
  peaks.sort((a, b) => b[1] - a[1]); troughs.sort((a, b) => a[1] - b[1]);
  const names = (list) => list.slice(0, 4).sort((a, b) => a[0] - b[0]).map(([n]) => MONTH_NAMES[n - 1]).join(', ');
  const stable = known.length >= CFG.MIN_MONTHS && known.every((v) => v >= CFG.YEAR_ROUND_BAND[0] && v <= CFG.YEAR_ROUND_BAND[1]);

  let status;
  if (stable) status = 'year_round';
  else if (cur >= CFG.IN_SEASON) status = 'in_season';
  else if (horizon >= CFG.IN_SEASON && horizon - cur >= CFG.RISING_DELTA) status = 'coming_into_season';
  else if (cur <= CFG.OUT_OF_SEASON || (horizon <= CFG.OUT_OF_SEASON && horizon < cur)) status = 'out_of_season';
  else status = 'shoulder';

  const monthsCovered = months.length;
  caveats.push(`Based on ${monthsCovered} months of online sales — one observed cycle (about ${monthsCovered >= 24 ? Math.floor(monthsCovered / 12) : 1} year). A launch, ad push or promotion in that year can look like seasonality; a second year would confirm it.`);
  if (gaps.length) caveats.push(`${gaps.map((m) => MONTH_NAMES[monthNum(m) - 1]).join(', ')} had almost no sales between two normal months; treated as a possible stockout and left out, not as weak demand.`);
  if (spikes.length) caveats.push(`${spikes.map((m) => MONTH_NAMES[monthNum(m) - 1]).join(', ')} was a one-off spike and was capped.`);
  const summary = status === 'year_round'
    ? `sells at a steady rate all year (every month between ${r2(Math.min(...known))} and ${r2(Math.max(...known))} of its usual)`
    : `${peaks.length ? `peaks ${names(peaks)}` : 'no clear peak'}${troughs.length ? `, quiet ${names(troughs)}` : ''}; now ${r2(cur)}× its usual level, next 4–8 weeks ${r2(horizon)}×`;
  // compact monthly breakdown + a plain-language "why" for the screen (units only: no money, no customers)
  const nowYm = ymOf(today);
  const horizonMonths = Object.keys(hw).sort();
  // PRODUCTION outlook: what the next days look like, over the configurable immediate (default 0-7 days) and secondary (8-14 days) windows. Months are the
  // finest resolution the sales history has, so each window is the day-weighted mix of the months it touches. The 4-8-week horizon above stays as the
  // longer-term insight; only these windows may lift THIS WEEK's shoot priority.
  const fx = (v) => `${r2(v)}×`;
  const imm = Math.max(1, Math.round(lookahead.immediate_days || 7)); const sec = Math.max(imm + 1, Math.round(lookahead.secondary_days || 14));
  const idxOver = (w) => { let v = 0; let ws = 0; Object.entries(w).forEach(([m, x]) => { const f = fill(monthNum(m)); if (f !== null) { v += f * x; ws += x; } }); return ws > 0 ? v / ws : null; };
  const immIdx = idxOver(rangeWeights(today, 0, imm)); const secIdx = idxOver(rangeWeights(today, imm, sec));
  let boost = 'none'; let entering = null; let outlookText;
  if (cur >= CFG.IN_SEASON) { boost = 'strong'; entering = 'now'; outlookText = `In season now (${fx(cur)} its usual level).`; }
  else if (immIdx !== null && immIdx >= CFG.IN_SEASON && immIdx - cur >= CFG.RISING_DELTA / 2) { boost = 'strong'; entering = 'immediate'; outlookText = `Entering its stronger selling period within ${imm} days (${fx(immIdx)} its usual level, from ${fx(cur)} now).`; }
  else if (secIdx !== null && secIdx >= CFG.IN_SEASON && secIdx - cur >= CFG.RISING_DELTA / 2) { boost = 'small'; entering = 'secondary'; outlookText = `Entering its stronger selling period in ${imm + 1}-${sec} days (${fx(secIdx)} its usual level): a smaller boost.`; }
  else if (status === 'coming_into_season') { entering = 'later'; outlookText = `Its stronger period is more than ${sec} days away (${fx(horizon)} in the next 4-8 weeks): kept as an insight, not a reason to shoot this week.`; }
  else outlookText = 'No seasonal lift expected in the next two weeks.';
  const outlook = { now_index: r2(cur), immediate_index: immIdx === null ? null : r2(immIdx), secondary_index: secIdx === null ? null : r2(secIdx), immediate_days: imm, secondary_days: sec, boost, entering, text: outlookText };
  const monthly = months.map((m) => ({ m, u: Math.round(Number(series[m]) || 0), on_sale: !startMonth || m >= startMonth, i: idx[m] !== undefined ? r2(idx[m]) : null, flag: gaps.includes(m) ? 'gap' : spikes.includes(m) ? 'spike' : null }));
  const why = [];
  if (status === 'year_round') why.push(`Year-round: every month sits between ${fx(Math.min(...known))} and ${fx(Math.max(...known))} of its usual level, so there is no season to chase.`);
  else if (status === 'in_season') why.push(`In season: ${MONTH_NAMES[curN - 1]} runs at ${fx(cur)} its usual level (in season is ${fx(CFG.IN_SEASON)} or more).`);
  else if (status === 'coming_into_season') why.push(`Coming into season: ${MONTH_NAMES[curN - 1]} is ${fx(cur)} its usual level but the next 4–8 weeks (${horizonMonths.map((m) => MONTH_NAMES[monthNum(m) - 1]).join('–')}) run at ${fx(horizon)}, so demand is rising towards a peak.`);
  else if (status === 'out_of_season') why.push(cur <= CFG.OUT_OF_SEASON ? `Out of season: ${MONTH_NAMES[curN - 1]} runs at ${fx(cur)} its usual level (out of season is ${fx(CFG.OUT_OF_SEASON)} or less).` : `Out of season: ${MONTH_NAMES[curN - 1]} is ${fx(cur)} its usual level and the next 4–8 weeks fall to ${fx(horizon)}.`);
  else why.push(`Shoulder season: ${MONTH_NAMES[curN - 1]} is ${fx(cur)} its usual level and the next 4–8 weeks ${fx(horizon)}: neither a peak nor a trough.`);
  if (peaks.length && status !== 'year_round') why.push(`Peak months: ${peaks.slice(0, 4).sort((a, b) => a[0] - b[0]).map(([n, v]) => `${MONTH_NAMES[n - 1]} ${fx(v)}`).join(', ')}.`);
  if (troughs.length && status !== 'year_round') why.push(`Quiet months: ${troughs.slice(0, 4).sort((a, b) => a[0] - b[0]).map(([n, v]) => `${MONTH_NAMES[n - 1]} ${fx(v)}`).join(', ')}.`);
  why.push(`"Usual" is this ${label ? `${label}'s` : 'product\'s'} own average month, after dividing out store-wide surges (sales, Black Friday) so only product-specific movement counts.`);
  return {
    status,
    evidence: {
      label, outlook, why, monthly, now_month: nowYm, horizon_months: horizonMonths, summary, months_used: used.length, first_month: avail[0], last_month: avail[avail.length - 1], units: Math.round(total),
      current_index: r2(cur), horizon_index: r2(horizon), peaks: peaks.slice(0, 4).map(([n, v]) => ({ month: MONTH_NAMES[n - 1], index: r2(v) })), troughs: troughs.slice(0, 4).map(([n, v]) => ({ month: MONTH_NAMES[n - 1], index: r2(v) })),
      index_by_month: Object.fromEntries(MONTH_NAMES.map((nm, i) => [nm, profile[i + 1] === null ? null : r2(profile[i + 1])])),
      confidence: monthsCovered >= 24 ? 'medium' : 'limited', years_of_data: monthsCovered >= 24 ? Math.floor(monthsCovered / 12) : 1, caveats,
    },
  };
}

// MAIN.  monthlyByStyle: Map(styleCode -> { 'YYYY-MM': units }) ; groups: [{ key, name, category, style_codes[] }] (a product family each)
//        launchByStyle: Map(styleCode -> 'YYYY-MM-DD' | null) ; window: { from, to } of the sales feed ; today: 'YYYY-MM-DD'
function buildSeasonality({ monthlyByStyle: monthlyIn, groups, launchByStyle, window, today, lookahead }) {
  let monthlyByStyle = monthlyIn;
  if (!monthlyByStyle || !monthlyByStyle.size) return { available: false, reason: 'No monthly sales history has loaded yet' };
  if (!window || !window.from) return { available: false, reason: 'The sales window is unknown' };
  // The window starts part-way through a month a year ago, so the month we are in now exists twice, in two halves: the end of last year's (window
  // start) and this year's so far. When together they cover at least 80 % of that month they are folded into ONE month, scaled for the days covered,
  // which gives the month that matters most right now a real observation instead of an interpolation.
  const startYm = ymOf(window.from); const curYm = ymOf(today);
  const startDays = daysInMonth(startYm) - Number(String(window.from).slice(8, 10)) + 1;
  const curDays = Number(String(today).slice(8, 10));
  const fold = addMonths(startYm, 12) === curYm && String(window.from).slice(8, 10) !== '01' && (startDays + curDays) / daysInMonth(startYm) >= 0.8;
  const months = completeMonths(window.from, today, { foldStart: fold });
  if (months.length < CFG.MIN_MONTHS) return { available: false, reason: `Only ${months.length} complete months of sales are available (needs ${CFG.MIN_MONTHS})` };
  if (fold) {
    const scale = daysInMonth(startYm) / (startDays + curDays);
    const folded = new Map();
    monthlyByStyle.forEach((bm, code) => { folded.set(code, { ...bm, [startYm]: ((Number(bm[startYm]) || 0) + (Number(bm[curYm]) || 0)) * scale }); });
    monthlyByStyle = folded;
  }
  const storeTotals = {}; months.forEach((m) => { storeTotals[m] = 0; });
  monthlyByStyle.forEach((byMonth) => months.forEach((m) => { storeTotals[m] += Number(byMonth[m]) || 0; }));
  const sumSeries = (codes) => { const s = {}; months.forEach((m) => { s[m] = 0; }); codes.forEach((c) => { const bm = monthlyByStyle.get(c); if (bm) months.forEach((m) => { s[m] += Number(bm[m]) || 0; }); }); return s; };
  const firstSale = (s) => months.find((m) => s[m] > 0) || null;

  // each product's on-sale months: after the launch month (partial), and from the first sale (also dropped when it is not the window's first month)
  const prepared = groups.map((g) => {
    const s = sumSeries(g.style_codes);
    const launches = g.style_codes.map((c) => (launchByStyle && launchByStyle.get(c)) || null).filter(Boolean).sort();
    const fs = firstSale(s);
    let start = fs && fs !== months[0] ? addMonths(fs, 1) : fs;
    if (launches.length && launches[0] >= `${months[0]}-01`) { const lm = addMonths(ymOf(launches[0]), 1); if (!start || lm > start) start = lm; }
    const avail = start ? months.filter((m) => m >= start) : [];
    const total = avail.reduce((t, m) => t + (s[m] || 0), 0);
    return { g, s, fs, start, avail, total, eligible: !!fs && avail.length >= CFG.MIN_MONTHS && total >= CFG.MIN_UNITS };
  });

  // the store-wide level per month: the median product's movement (see METHOD); the store's total units when there are too few products
  const eligible = prepared.filter((x) => x.eligible);
  const factor = {};
  const usedMedian = eligible.length >= CFG.MIN_PRODUCTS_FOR_MEDIAN;
  if (usedMedian) {
    const ratios = eligible.map((x) => { const own = x.total / x.avail.length; const r = {}; x.avail.forEach((m) => { r[m] = own > 0 ? (x.s[m] || 0) / own : 0; }); return r; });
    months.forEach((m) => { const vs = ratios.filter((r) => r[m] !== undefined).map((r) => r[m]); factor[m] = vs.length >= 3 ? median(vs) : null; });
  }
  const meanTotal = months.reduce((t, m) => t + storeTotals[m], 0) / months.length;
  months.forEach((m) => { if (!usedMedian || !(factor[m] > 0)) factor[m] = meanTotal > 0 ? storeTotals[m] / meanTotal : 0; });

  const categories = new Map(); const catCodes = new Map();
  groups.forEach((g) => { const c = String(g.category || 'UNCATEGORISED').toUpperCase(); if (!catCodes.has(c)) catCodes.set(c, []); catCodes.get(c).push(...g.style_codes); });
  catCodes.forEach((codes, cat) => {
    categories.set(cat, { ...assessSeries({ series: sumSeries(codes), factor, months, startMonth: months[0], today, label: `${cat} category`, lookahead }), level: 'category', name: cat });
  });
  const out = new Map();
  prepared.forEach(({ g, s, fs, start }) => {
    const own = fs ? assessSeries({ series: s, factor, months, startMonth: start, today, label: g.name, lookahead }) : { status: 'insufficient_data', evidence: { reason: 'no sales in the period', months_used: 0, units: 0, summary: 'no sales in the period', confidence: 'none', caveats: [] } };
    if (own.status !== 'insufficient_data') { out.set(g.key, { ...own, level: 'family' }); return; }
    const cat = categories.get(String(g.category || 'UNCATEGORISED').toUpperCase());
    if (cat && cat.status !== 'insufficient_data') {
      out.set(g.key, { status: cat.status, level: 'category', evidence: { ...cat.evidence, why: [`Using the ${cat.name} category pattern: this product has too little history of its own (${own.evidence.reason}).`, ...(cat.evidence.why || [])], summary: `${cat.evidence.summary} (category pattern: this product has too little history of its own — ${own.evidence.reason})`, own_reason: own.evidence.reason } });
    } else out.set(g.key, { ...own, level: 'family' });
  });
  return { available: true, window: { from: window.from, to: window.to || today }, months, groups: out, categories, store_units: Object.values(storeTotals).reduce((s, x) => s + x, 0), baseline: usedMedian ? 'median_product' : 'store_total', config: { ...CFG } };
}

const SEASON_ORDER = ['in_season', 'coming_into_season', 'year_round', 'shoulder', 'out_of_season', 'insufficient_data'];
module.exports = { MONTH_NAMES, CFG, SEASON_ORDER, completeMonths, horizonWeights, assessSeries, buildSeasonality };
