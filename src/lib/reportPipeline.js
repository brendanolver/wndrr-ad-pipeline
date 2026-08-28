// WNDRR "Report Pipeline" client -- an internal service (separate from
// ApparelMagic) that serves Shopify sales/inventory CSV exports. High Stock
// uses it for exactly one thing: the Platinum/Rocket/Surfer/Dog performance
// tier already computed and shown in the "demand planning v2" tool
// (brendanolver/demandplanning), which this module ports verbatim so both
// tools agree on the same classification.
//
// Credentials come from PIPELINE_BASE_URL / PIPELINE_TOKEN env vars, unset
// by default -- configured() lets callers degrade gracefully, same pattern
// as apparelmagic.js's configured().

const http = require('http');
const https = require('https');
const { getCached, cacheStatus } = require('./amCache');
const { isWndrrStyleCode } = require('./apparelmagic');

const PIPELINE_BASE_URL = process.env.PIPELINE_BASE_URL;
const PIPELINE_TOKEN = process.env.PIPELINE_TOKEN;

// A full CSV parse + cohort computation over the whole catalogue's sales
// history isn't cheap enough to redo every request, but tiers don't shift
// meaningfully within a day -- matches the spirit of apparelmagic.js's
// multi-hour TTLs for its own slow-changing catalogue data.
const TIER_TTL = 3 * 60 * 60 * 1000;

// Tier thresholds ported verbatim from demandplanning's getPerfTier
// (index.html) -- Platinum >=150, Rocket 100-149, Surfer 50-99, Dog <50.
// New products with no sales history at all get 'egg', which High Stock's
// platinum/rocket-only filter naturally excludes.
const NEW_THRESHOLD_DAYS = 32;

function configured() {
  return Boolean(PIPELINE_BASE_URL && PIPELINE_TOKEN);
}

function pipelineRequest(pathOrUrl) {
  if (!configured()) {
    return Promise.reject(new Error('Report Pipeline is not configured (PIPELINE_BASE_URL / PIPELINE_TOKEN missing)'));
  }
  const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : PIPELINE_BASE_URL + pathOrUrl;
  const client = url.startsWith('https:') ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.get(url, { headers: { Authorization: `Bearer ${PIPELINE_TOKEN}` } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
  });
}

async function fetchManifest() {
  const result = await pipelineRequest('/api/reports/manifest');
  if (result.status !== 200) {
    throw new Error(`Report Pipeline manifest returned status ${result.status}`);
  }
  return JSON.parse(result.body);
}

async function downloadReportCsv(reportKey) {
  const manifest = await fetchManifest();
  const report = (manifest.reports || []).find((r) => r.reportKey === reportKey && r.exists);
  if (!report) {
    throw new Error(`Report Pipeline: ${reportKey} report not available`);
  }
  const result = await pipelineRequest(report.downloadUrl);
  if (result.status !== 200) {
    throw new Error(`Report Pipeline ${reportKey} download returned status ${result.status}`);
  }
  return result.body;
}

// Minimal RFC4180-ish CSV parser (quoted fields, "" as an escaped quote,
// commas/newlines inside quotes) -- no CSV dependency exists in this
// project's package.json, and the codebase otherwise has zero build-step
// dependencies, so this stays hand-rolled rather than adding a package.
// Returns an array of row objects keyed by the header row.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  function endField() { row.push(field); field = ''; }
  function endRow() { endField(); rows.push(row); row = []; }

  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { endField(); i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\n') { endRow(); i += 1; continue; }
    field += ch; i += 1;
  }
  if (field.length || row.length) endRow();
  if (!rows.length) return [];

  const header = rows[0];
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    if (rows[r].length === 1 && rows[r][0] === '') continue; // trailing blank line
    const obj = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = rows[r][c] ?? '';
    out.push(obj);
  }
  return out;
}

// WNDRR style codes are the first 11 characters of the Shopify SKU (the
// remainder is the size suffix) -- confirmed by reading demandplanning's own
// SKU->style-code derivation, which strips a hardcoded list of known size
// suffixes off the SKU. Matching against our own WNDRR_STYLE_CODE_RE
// (via isWndrrStyleCode) is more robust than replicating that list.
function styleCodeFromSku(sku) {
  const prefix = (sku || '').toUpperCase().trim().slice(0, 11);
  return isWndrrStyleCode(prefix) ? prefix : null;
}

function getPerfTier(indexScore, noSales) {
  if (noSales) return 'egg';
  if (indexScore >= 150) return 'platinum';
  if (indexScore >= 100) return 'rocket';
  if (indexScore >= 50) return 'surfer';
  return 'dog';
}

// Monday of the ISO week containing firstSaleDay ("YYYY-MM-DD" string) --
// verbatim port of demandplanning's getCohortWeek.
function cohortWeekOf(firstSaleDay) {
  const fsd = new Date(firstSaleDay);
  fsd.setHours(0, 0, 0, 0);
  const dow = (fsd.getDay() + 6) % 7; // Mon=0
  const mon = new Date(fsd);
  mon.setDate(fsd.getDate() - dow);
  return mon.toISOString().slice(0, 10);
}

function sumUnitsInWindow(dayMap, startMs, endMs) {
  let total = 0;
  for (const [day, qty] of dayMap.entries()) {
    const t = new Date(day).setHours(0, 0, 0, 0);
    if (t >= startMs && t <= endMs) total += qty;
  }
  return Math.round(total);
}

// Downloads + parses the shopify_sales report once, reduced to just the
// fields either consumer (tier cohort math, category sales cadence) needs --
// cached so both derive from a single fetch+parse per TTL window rather than
// each downloading and re-parsing what can be a multi-MB CSV.
async function fetchSalesRowsUncached() {
  const csvText = await downloadReportCsv('shopify_sales');
  const raw = parseCsv(csvText);
  const rows = [];
  for (const r of raw) {
    const sku = (r['Product variant SKU'] || '').trim();
    const day = (r['Day'] || '').trim();
    const qty = parseFloat(r['Quantity ordered'] || 0) || 0;
    if (!sku || !day || qty <= 0) continue;
    rows.push({ sku, day, qty, category: (r['Product type'] || '').trim().toUpperCase() });
  }
  return rows;
}

async function getSalesRows() {
  return getCached('pipelineSalesRows', TIER_TTL, fetchSalesRowsUncached);
}

// Verbatim port of demandplanning's buildPerfData (index.html ~10486-10727),
// keyed by AM style_code instead of Shopify productName+'||'+colour -- our
// style_code already IS the colourway-level identity demand-v2 reconstructs
// from productName+colour, so no product-name parsing is needed here.
//
// Cohort peer averages MUST be computed from every style_code that has any
// sales history, not just High Stock's own candidates -- a candidate's
// cohort peers are whatever else first sold the same week, almost none of
// which will themselves be High Stock eligible. Partial data would corrupt
// the averages, so this always processes the full shopify_sales CSV.
async function buildStyleTiersUncached() {
  const rows = await getSalesRows();

  const salesBySkuDay = new Map(); // sku -> Map<day, qty>
  for (const r of rows) {
    if (!salesBySkuDay.has(r.sku)) salesBySkuDay.set(r.sku, new Map());
    const dayMap = salesBySkuDay.get(r.sku);
    dayMap.set(r.day, (dayMap.get(r.day) || 0) + r.qty);
  }

  const styleSkus = new Map(); // style_code -> sku[]
  for (const sku of salesBySkuDay.keys()) {
    const styleCode = styleCodeFromSku(sku);
    if (!styleCode) continue;
    if (!styleSkus.has(styleCode)) styleSkus.set(styleCode, []);
    styleSkus.get(styleCode).push(sku);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();

  function skusUnitsInWindow(skus, startMs, endMs) {
    let total = 0;
    for (const sku of skus) total += sumUnitsInWindow(salesBySkuDay.get(sku) || new Map(), startMs, endMs);
    return Math.round(total);
  }

  const interim = [];
  for (const [styleCode, skus] of styleSkus.entries()) {
    let firstSaleDay = null;
    for (const sku of skus) {
      for (const day of (salesBySkuDay.get(sku) || new Map()).keys()) {
        if (!firstSaleDay || day < firstSaleDay) firstSaleDay = day;
      }
    }
    if (!firstSaleDay) {
      interim.push({ styleCode, firstSaleDay: null, cohortWeek: null, isNew: false, units4w: 0, projectedUnits: 0, effectiveDays: null, skus });
      continue;
    }
    const fsdMs = new Date(firstSaleDay).setHours(0, 0, 0, 0);
    const daysElapsed = Math.floor((todayMs - fsdMs) / 86400000);
    const isNew = daysElapsed <= NEW_THRESHOLD_DAYS;
    const cohortWeek = cohortWeekOf(firstSaleDay);

    const endFullMs = fsdMs + 27 * 86400000;
    const units4w = skusUnitsInWindow(skus, fsdMs, endFullMs);

    const unitsActual = isNew ? skusUnitsInWindow(skus, fsdMs, todayMs) : units4w;
    const effectiveDays = isNew ? Math.max(daysElapsed, 1) : 28;
    const projectedUnits = isNew ? Math.round((unitsActual / effectiveDays) * 28) : units4w;

    interim.push({ styleCode, firstSaleDay, cohortWeek, isNew, units4w, projectedUnits, effectiveDays, skus });
  }

  // Cohort full-28-day stats (completed products only), per cohortWeek.
  const cohortFull = new Map();
  for (const p of interim) {
    if (!p.cohortWeek || p.isNew) continue;
    if (!cohortFull.has(p.cohortWeek)) cohortFull.set(p.cohortWeek, { sum: 0, count: 0 });
    const stats = cohortFull.get(p.cohortWeek);
    stats.sum += p.units4w;
    stats.count += 1;
  }

  // For new products: cohort average using first N days of ALL peers
  // (completed + new) in the same cohort week, excluding self.
  function cohortNDayAvg(cohortWeek, nDays, excludeStyleCode) {
    const peers = interim.filter((p) => p.cohortWeek === cohortWeek && p.firstSaleDay && p.styleCode !== excludeStyleCode);
    let sum = 0;
    let count = 0;
    for (const peer of peers) {
      const fsdMs = new Date(peer.firstSaleDay).setHours(0, 0, 0, 0);
      const windowEndMs = fsdMs + (nDays - 1) * 86400000;
      const peerUnits = skusUnitsInWindow(peer.skus, fsdMs, windowEndMs);
      const peerProjected = Math.round((peerUnits / Math.max(nDays, 1)) * 28);
      sum += peerProjected;
      count += 1;
    }
    return count > 0 ? sum / count : 0;
  }

  const tiers = new Map(); // style_code -> { tier, indexScore }
  for (const p of interim) {
    let indexScore = 0;
    if (p.cohortWeek) {
      if (p.isNew) {
        const cohortAvg = cohortNDayAvg(p.cohortWeek, p.effectiveDays, p.styleCode);
        indexScore = cohortAvg > 0 ? Math.round((p.projectedUnits / cohortAvg) * 100) : 0;
      } else {
        const stats = cohortFull.get(p.cohortWeek);
        const avg = stats && stats.count > 0 ? stats.sum / stats.count : 0;
        indexScore = avg > 0 ? Math.round((p.units4w / avg) * 100) : 0;
      }
    }
    const tier = getPerfTier(indexScore, !p.firstSaleDay);
    tiers.set(p.styleCode, { tier, indexScore });
  }
  return tiers;
}

async function getStyleTiers() {
  return getCached('pipelineStyleTiers', TIER_TTL, buildStyleTiersUncached);
}

// "This month to date vs the same days last year" per category -- the exact
// comparison demand-v2's own Sales Cadence view highlights (its "LY MTD vs
// THIS MTD" column), just without the full 12-month grid. Computed fresh
// from the already-cached getSalesRows() (cheap: a filter + sum), so this
// carries no cache of its own -- the expensive download+parse is shared with
// the tier computation via getSalesRows()'s own TTL.
function clampToMonth(year, month, day) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, daysInMonth));
}

// How many trailing months (including the current, partial one) each
// category's cadence carries -- the small monthly strip Core's own page
// shows next to the MTD box, ported in miniature from demand-v2's full
// 12-month Sales Cadence grid (see coreCategoryTrendInfo in app.js).
const CADENCE_MONTHS_BACK = 3;

async function buildCategorySalesCadence() {
  const rows = await getSalesRows();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const thisStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const thisEnd = today;
  const lastYearStart = new Date(today.getFullYear() - 1, today.getMonth(), 1);
  const lastYearEnd = clampToMonth(today.getFullYear() - 1, today.getMonth(), today.getDate());

  function inWindow(day, start, end) {
    const t = new Date(day).setHours(0, 0, 0, 0);
    return t >= start.getTime() && t <= end.getTime();
  }

  // Month windows, most-recent-first: index 0 is the current month
  // (partial, up to today, so it lines up with the MTD figures above),
  // the rest are complete prior calendar months. Each also carries its
  // own same-month-last-year window, so every monthly figure gets the
  // same YoY colour treatment as the MTD box rather than an arbitrary
  // month-over-month comparison.
  const monthDefs = [];
  for (let i = 0; i < CADENCE_MONTHS_BACK; i++) {
    const monthStart = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const isCurrent = i === 0;
    const monthEnd = isCurrent ? today : new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
    const lyMonthStart = new Date(monthStart.getFullYear() - 1, monthStart.getMonth(), 1);
    const lyMonthEnd = isCurrent
      ? clampToMonth(lyMonthStart.getFullYear(), lyMonthStart.getMonth(), today.getDate())
      : new Date(lyMonthStart.getFullYear(), lyMonthStart.getMonth() + 1, 0);
    monthDefs.push({
      label: monthStart.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }).toUpperCase(),
      start: monthStart, end: monthEnd, lyStart: lyMonthStart, lyEnd: lyMonthEnd,
    });
  }

  const totals = new Map(); // category -> { thisPeriod, lastYear, months: [{units, lyUnits}, ...] }
  for (const r of rows) {
    if (!totals.has(r.category)) {
      totals.set(r.category, { thisPeriod: 0, lastYear: 0, months: monthDefs.map(() => ({ units: 0, lyUnits: 0 })) });
    }
    const entry = totals.get(r.category);
    if (inWindow(r.day, thisStart, thisEnd)) entry.thisPeriod += r.qty;
    if (inWindow(r.day, lastYearStart, lastYearEnd)) entry.lastYear += r.qty;
    monthDefs.forEach((m, idx) => {
      if (inWindow(r.day, m.start, m.end)) entry.months[idx].units += r.qty;
      if (inWindow(r.day, m.lyStart, m.lyEnd)) entry.months[idx].lyUnits += r.qty;
    });
  }

  const categories = [...totals.entries()]
    .filter(([category]) => category) // drop rows with no Product type set
    .map(([category, { thisPeriod, lastYear, months }]) => ({
      category,
      this_period_units: Math.round(thisPeriod),
      last_year_units: Math.round(lastYear),
      pct_change: lastYear > 0 ? Math.round(((thisPeriod - lastYear) / lastYear) * 100) : (thisPeriod > 0 ? null : 0),
      months: months.map((m, idx) => {
        const units = Math.round(m.units);
        const lyUnits = Math.round(m.lyUnits);
        return {
          label: monthDefs[idx].label,
          units,
          pct_change: lyUnits > 0 ? Math.round(((units - lyUnits) / lyUnits) * 100) : (units > 0 ? null : 0),
        };
      }),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));

  const totalThis = categories.reduce((sum, c) => sum + c.this_period_units, 0);
  const totalLastYear = categories.reduce((sum, c) => sum + c.last_year_units, 0);

  return {
    as_of: today.toISOString().slice(0, 10),
    period_start: thisStart.toISOString().slice(0, 10),
    categories,
    total: {
      this_period_units: totalThis,
      last_year_units: totalLastYear,
      pct_change: totalLastYear > 0 ? Math.round(((totalThis - totalLastYear) / totalLastYear) * 100) : (totalThis > 0 ? null : 0),
    },
  };
}

async function getCategorySalesCadence() {
  return buildCategorySalesCadence();
}

function warmPipelineCache() {
  if (!configured()) return;
  getStyleTiers().catch((err) => {
    console.error('Report Pipeline cache warm-up failed (will retry on first real request):', err.message);
  });
}

function getPipelineCacheStatus() {
  return { styleTiers: cacheStatus('pipelineStyleTiers') };
}

module.exports = { configured, getStyleTiers, getCategorySalesCadence, warmPipelineCache, getPipelineCacheStatus };
