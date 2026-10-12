// Shopify online-store sales history for Creative Planning's SEASONALITY (server side only).
//
// WHY THIS EXISTS: seasonal demand is best read from what customers actually bought on the store the ads send them to, net of refunds, cancelled
// and test orders, bucketed in the store's own calendar days. This module reads it straight from the Shopify Admin API with a token held ONLY in
// this server's environment. It deliberately does NOT call the Demand Planning app's public sales-data function (that endpoint has no
// authentication, so depending on it would make Planning depend on an open URL), and it exposes no route of its own: nothing here is reachable from
// a browser, and the token never reaches the front end.
//
// CONFIGURATION (environment, set in Railway; never in code or the browser):
//   SHOPIFY_SHOP_DOMAIN    e.g. thewndrr.myshopify.com
//   SHOPIFY_ADMIN_TOKEN    a READ-ONLY custom-app token with read_orders (+ read_all_orders to see beyond 60 days)
//   SHOPIFY_SALES_LOOKBACK_DAYS  optional, default 730 (two seasons, so a second year can confirm a pattern repeats)
//   SHOPIFY_API_VERSION    optional, default 2025-10
//
// WHAT IS COUNTED: LineItem.currentQuantity (units still standing after refunds and order edits), on the order's creation day in the shop's own time
// zone. Cancelled orders (cancelledAt set) and test orders are left out entirely. Non-product lines (order protection, returns cover, gift cards
// with no SKU) are left out. A SKU is attached to a style by the LONGEST known style code it starts with (the catalogue is the source of truth, so a
// size suffix is never guessed at); units that match no known style are counted and reported, never silently dropped.
//
// SAME DEFINITIONS AS DEMAND PLANNING (its Shopify sales feed + Sales Cadence screen), checked against its code:
//   units      LineItem.currentQuantity on the order's creation day in the shop's own time zone; monthly totals are the sum of those days by calendar month
//   SKU->style the 11-character modern style code (W + 2-digit year + 2 letters + 3 digits + 3-letter colour), exactly Demand Planning's rule for modern SKUs;
//              a longer/older SKU is attached to the longest KNOWN style code it starts with instead of guessing at a size suffix
//   category   Shopify's own Product type, upper-cased (the category the Cadence screen groups by); the RETURN product type (returns cover) is excluded
//   refunds    currentQuantity already excludes refunded / removed units, attributed to the original order day (so a later return never moves a month)
// ONE DELIBERATE DIFFERENCE: Demand Planning does not filter on cancellation (it relies on currentQuantity), this module also leaves out orders with
// cancelledAt set and test orders. The two agree whenever a cancelled order was refunded. The units on cancelled / test orders are COUNTED and reported
// (stats.cancelled_units / test_units) so the difference is visible and reconcilable, never hidden.
//
// WHAT IT CANNOT KNOW: stock-outs and promotions are not in an order feed. Those are handled downstream (seasonality.js leaves out a month that looks
// like a stock-out and divides a store-wide promotion surge out), and this module says so in its result rather than claiming otherwise.
//
// Network access is injected (gql / openLines) so every path is testable with fixtures; nothing runs at import time.
const { Readable } = require('stream');
const readline = require('readline');

const DEFAULT_API_VERSION = '2025-10';
const DEFAULT_LOOKBACK_DAYS = 730;
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_WAIT_MS = 12 * 60 * 1000;
const NON_PRODUCT_SKUS = new Set(['ORDPRO', 'OS']);
const MODERN_STYLE_RE = /^W\d{2}[A-Z]{2}\d{3}[A-Z]{3}/; // same pattern as Demand Planning's styleFromSku()
const EXCLUDED_CATEGORIES = new Set(['RETURN']); // service lines (returns cover), not products
const DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

function envConfig(env = process.env) {
  const domain = String(env.SHOPIFY_SHOP_DOMAIN || '').trim();
  const token = String(env.SHOPIFY_ADMIN_TOKEN || '').trim();
  const lookback = Number.parseInt(env.SHOPIFY_SALES_LOOKBACK_DAYS, 10);
  return {
    domain, token, apiVersion: String(env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION).trim(),
    lookbackDays: Number.isFinite(lookback) && lookback >= 90 && lookback <= 1500 ? lookback : DEFAULT_LOOKBACK_DAYS,
    ok: DOMAIN_RE.test(domain) && token.length >= 20,
  };
}
const configured = (env) => envConfig(env).ok;

// ── pure helpers ──────────────────────────────────────────────────────────
function makeDayOf(tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' });
  return (iso) => f.format(new Date(iso)); // en-CA => YYYY-MM-DD
}
function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const toUtcMs = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const daysBetweenInclusive = (a, b) => Math.round((toUtcMs(b) - toUtcMs(a)) / 86400000) + 1;

// The longest known style code that the SKU starts with (so a size or a colour that ends in a size letter can never confuse the match).
function makeStyleMapper(knownStyles) {
  const known = knownStyles instanceof Set ? knownStyles : new Set(knownStyles || []);
  const memo = new Map();
  return (rawSku) => {
    const sku = String(rawSku || '').trim().toUpperCase();
    if (!sku) return null;
    if (memo.has(sku)) return memo.get(sku);
    let hit = null;
    for (let len = Math.min(sku.length, 16); len >= 8; len -= 1) { const c = sku.slice(0, len); if (known.has(c)) { hit = c; break; } }
    // not in the catalogue (retired / pre-release): Demand Planning's rule for a modern SKU, so store-wide totals still agree with it
    if (!hit && sku.length >= 11 && MODERN_STYLE_RE.test(sku)) hit = sku.slice(0, 11);
    memo.set(sku, hit);
    return hit;
  };
}

// The bulk query: only what is needed (no customer, address, price or discount fields are ever requested).
function bulkQuery(sinceDay) {
  return `mutation {
    bulkOperationRunQuery(query: """
      { orders(query: "created_at:>='${sinceDay}'") { edges { node {
          id createdAt cancelledAt test
          lineItems { edges { node { sku currentQuantity product { productType } } } }
      } } } }
    """) { bulkOperation { id status } userErrors { field message } }
  }`;
}

// Bulk results may only be fetched from Shopify's own Google Cloud Storage hosts (a signed URL Shopify hands back): never an arbitrary URL.
function isAllowedDownloadUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.protocol === 'https:' && /(^|\.)googleapis\.com$/.test(u.hostname);
  } catch (e) { return false; }
}

// Aggregate NDJSON lines (an async iterable of strings) in TWO streaming passes. Shopify does not guarantee a parent order row precedes its line-item
// rows, so pass 1 learns every order's store-local day (and whether it counts); pass 2 adds up the line items. Neither pass holds the file in memory.
async function aggregate({ pass1, pass2, dayOf, mapStyle, sinceDay }) {
  const orderDay = new Map(); // order id -> store-local day, or 'cancelled' / 'test' when the order does not count
  const stats = {
    orders: 0, cancelled_orders: 0, test_orders: 0, lines: 0, unresolved_lines: 0, kept_units: 0, non_product_units: 0, excluded_category_units: 0,
    cancelled_units: 0, test_units: 0, unmapped_units: 0, unmapped_skus: 0, refunded_or_removed_lines: 0,
  };
  for await (const line of pass1()) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch (e) { continue; }
    if (r.__parentId || !r.id || !r.createdAt) continue;
    stats.orders += 1;
    if (r.cancelledAt) { stats.cancelled_orders += 1; orderDay.set(r.id, 'cancelled'); continue; }
    if (r.test) { stats.test_orders += 1; orderDay.set(r.id, 'test'); continue; }
    orderDay.set(r.id, dayOf(r.createdAt));
  }
  const byStyle = new Map(); // style -> { 'YYYY-MM-DD': units }
  const catUnits = new Map(); // style -> Map(PRODUCT TYPE -> units)
  const unmapped = new Map();
  let firstDay = null; let lastDay = null;
  for await (const line of pass2()) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch (e) { continue; }
    if (!r.__parentId) continue;
    stats.lines += 1;
    if (!orderDay.has(r.__parentId)) { stats.unresolved_lines += 1; continue; }
    const day = orderDay.get(r.__parentId);
    const qty = Number(r.currentQuantity) || 0;
    if (day === 'cancelled' || day === 'test') { if (qty > 0) stats[day === 'cancelled' ? 'cancelled_units' : 'test_units'] += qty; continue; }
    if (!day || day < sinceDay) continue; // the padding days before the window
    if (qty <= 0) { stats.refunded_or_removed_lines += 1; continue; }
    const sku = String(r.sku || '').trim().toUpperCase();
    if (!sku || NON_PRODUCT_SKUS.has(sku)) { stats.non_product_units += qty; continue; }
    const ptype = String((r.product && r.product.productType) || '').trim().toUpperCase();
    if (EXCLUDED_CATEGORIES.has(ptype)) { stats.excluded_category_units += qty; continue; }
    const style = mapStyle(sku);
    if (!style) { stats.unmapped_units += qty; unmapped.set(sku, (unmapped.get(sku) || 0) + qty); continue; }
    if (!byStyle.has(style)) byStyle.set(style, {});
    const d = byStyle.get(style); d[day] = (d[day] || 0) + qty;
    if (ptype) { if (!catUnits.has(style)) catUnits.set(style, new Map()); const cm = catUnits.get(style); cm.set(ptype, (cm.get(ptype) || 0) + qty); }
    stats.kept_units += qty;
    if (!firstDay || day < firstDay) firstDay = day;
    if (!lastDay || day > lastDay) lastDay = day;
  }
  stats.unmapped_skus = unmapped.size;
  stats.top_unmapped = [...unmapped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  // each style's category = the Shopify product type that carried most of its units
  const categories = new Map();
  catUnits.forEach((cm, style) => { categories.set(style, [...cm.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0]); });
  return { byStyle, categories, stats, firstDay, lastDay };
}

// Turn per-day units into the shape Planning already uses: style -> { qty7, qty30, qty365, months }, plus the window the data really covers.
function toSalesByStyle(byStyle, { today, sinceDay, firstDay, tz, stats, categories = new Map(), source = 'shopify' }) {
  const out = new Map();
  const d7 = addDays(today, -6); const d30 = addDays(today, -29); const d365 = addDays(today, -364);
  byStyle.forEach((days, style) => {
    const e = { qty7: 0, qty30: 0, qty365: 0, months: {} };
    Object.entries(days).forEach(([day, q]) => {
      if (day >= d7) e.qty7 += q;
      if (day >= d30) e.qty30 += q;
      if (day >= d365) e.qty365 += q;
      const ym = day.slice(0, 7); e.months[ym] = (e.months[ym] || 0) + q;
    });
    out.set(style, e);
  });
  // The window starts where orders really start. If the token cannot see back as far as asked (no read_all_orders: 60 days), the window is short and
  // seasonality will say "insufficient data" rather than reading missing history as weak sales.
  const from = firstDay && firstDay > sinceDay ? firstDay : sinceDay;
  out.categories = categories; // style -> Shopify product type (the category Demand Planning's Sales Cadence groups by)
  out.window = { from, to: today, days: daysBetweenInclusive(from, today), source, requested_from: sinceDay, tz, stats };
  return out;
}

// ── Shopify Admin API client (token only ever leaves this process toward the shop's own host) ──
function makeClient({ domain, token, apiVersion = DEFAULT_API_VERSION, fetchImpl = fetch }) {
  if (!DOMAIN_RE.test(domain || '')) throw new Error('SHOPIFY_SHOP_DOMAIN must be a *.myshopify.com domain');
  async function gql(query, variables) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const r = await fetchImpl(`https://${domain}/admin/api/${apiVersion}/graphql.json`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables: variables || {} }),
      });
      const d = await r.json().catch(() => ({}));
      const throttled = d.errors && d.errors.some((e) => /throttl/i.test(e.message || '') || (e.extensions && e.extensions.code === 'THROTTLED'));
      if (throttled) { await new Promise((res) => setTimeout(res, 2000 * (attempt + 1))); continue; }
      if (r.status === 401 || r.status === 403) throw new Error(`Shopify refused the token (HTTP ${r.status}); check SHOPIFY_ADMIN_TOKEN and its read_orders scope`);
      if (d.errors) throw new Error(`Shopify: ${d.errors.map((e) => e.message).join('; ').slice(0, 300)}`);
      if (!r.ok) throw new Error(`Shopify HTTP ${r.status}`);
      return d.data;
    }
    throw new Error('Shopify: throttled repeatedly');
  }
  // a fresh streaming read of the bulk result file, line by line
  function openLines(url) {
    if (!isAllowedDownloadUrl(url)) throw new Error('Shopify returned a result URL on an unexpected host; refusing to download it');
    return (async function* lines() {
      const r = await fetchImpl(url);
      if (!r.ok || !r.body) throw new Error(`bulk result download failed: HTTP ${r.status}`);
      const rl = readline.createInterface({ input: Readable.fromWeb(r.body), crlfDelay: Infinity });
      for await (const l of rl) yield l;
    }());
  }
  return { gql, openLines };
}

async function runBulk({ gql, sinceDay, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxWaitMs = MAX_WAIT_MS }) {
  const cur = (await gql('{ currentBulkOperation(type: QUERY) { id status } }')).currentBulkOperation;
  if (cur && ['CREATED', 'RUNNING', 'CANCELING'].includes(cur.status)) throw new Error('another Shopify bulk export is already running; will retry later');
  const submit = (await gql(bulkQuery(addDays(sinceDay, -2)))).bulkOperationRunQuery; // padded: trimmed by store-local day afterwards
  if (submit.userErrors && submit.userErrors.length) throw new Error(`bulk submit: ${submit.userErrors.map((e) => e.message).join('; ').slice(0, 200)}`);
  const opId = submit.bulkOperation.id;
  const start = Date.now();
  for (;;) {
    if (Date.now() - start > maxWaitMs) throw new Error(`Shopify bulk export did not finish within ${Math.round(maxWaitMs / 60000)} minutes`);
    const op = (await gql('{ currentBulkOperation(type: QUERY) { id status errorCode objectCount url } }')).currentBulkOperation;
    if (!op) throw new Error('no bulk operation found');
    if (op.id !== opId) throw new Error('the bulk export was replaced by another');
    if (op.status === 'COMPLETED') return op.url || null;
    if (['FAILED', 'CANCELED', 'EXPIRED'].includes(op.status)) throw new Error(`Shopify bulk export ${op.status}${op.errorCode ? ` (${op.errorCode})` : ''}`);
    await sleep(3000);
  }
}

// MAIN: fetch the whole window and return Map<style, {qty7,qty30,qty365,months}> + .window (with data-quality stats). Throws on any failure
// (the caller falls back to ApparelMagic and says so); it never returns a half-built result as if it were complete.
async function fetchSalesByStyle({ client, knownStyles, tz = 'Australia/Melbourne', now = new Date(), lookbackDays = DEFAULT_LOOKBACK_DAYS, sleep, maxWaitMs }) {
  const dayOf = makeDayOf(tz);
  const today = dayOf(now);
  const sinceDay = addDays(today, -(lookbackDays - 1));
  const url = await runBulk({ gql: client.gql, sinceDay, sleep, maxWaitMs });
  if (!url) return toSalesByStyle(new Map(), { today, sinceDay, firstDay: null, tz, stats: { orders: 0, kept_units: 0 } });
  const agg = await aggregate({ pass1: () => client.openLines(url), pass2: () => client.openLines(url), dayOf, mapStyle: makeStyleMapper(knownStyles), sinceDay });
  if (agg.stats.orders > 0 && agg.stats.unresolved_lines / Math.max(1, agg.stats.lines) > 0.02) throw new Error('too many Shopify line items could not be matched to their orders; refusing to use this export');
  return toSalesByStyle(agg.byStyle, { today, sinceDay, firstDay: agg.firstDay, tz, stats: agg.stats, categories: agg.categories });
}

// Read the shop's own time zone (one tiny query).
async function shopTimeZone(client) {
  try { return ((await client.gql('{ shop { ianaTimezone } }')).shop || {}).ianaTimezone || 'Australia/Melbourne'; } catch (e) { return 'Australia/Melbourne'; }
}

// Month-by-month comparison of two sales sources for the same styles (used by scripts/compare-seasonal-sources.js, an explicit approved run).
function compareMonthly(a, b) {
  const tot = (m) => { const t = {}; m.forEach((v) => Object.entries(v.months || {}).forEach(([k, q]) => { t[k] = (t[k] || 0) + q; })); return t; };
  const ta = tot(a); const tb = tot(b);
  const months = [...new Set([...Object.keys(ta), ...Object.keys(tb)])].sort();
  return months.map((m) => ({ month: m, a: ta[m] || 0, b: tb[m] || 0, diff: (tb[m] || 0) - (ta[m] || 0), pct: ta[m] ? Math.round(((tb[m] || 0) - ta[m]) / ta[m] * 1000) / 10 : null }));
}

module.exports = {
  DEFAULT_API_VERSION, DEFAULT_LOOKBACK_DAYS, DEFAULT_TTL_MS, NON_PRODUCT_SKUS, envConfig, configured, makeDayOf, addDays, makeStyleMapper, bulkQuery, isAllowedDownloadUrl,
  aggregate, toSalesByStyle, makeClient, runBulk, fetchSalesByStyle, shopTimeZone, compareMonthly,
};
