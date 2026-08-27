// ApparelMagic API client.
//
// Reuses the integration pattern already proven in aminventory/server.js and
// adcreationworkflow/src/apparelmagic.js: signed GET requests to
// https://{subdomain}.app.apparelmagic.com/api/json/{endpoint} with a `time`
// (unix seconds) + `token` query param. Same cursor-based pagination
// (filtering on the last id seen, not page-number) confirmed live against
// this account in adcreationworkflow.
//
// Credentials come from AM_SUBDOMAIN / AM_TOKEN env vars, unset by default —
// configured() lets callers degrade gracefully instead of crashing when
// Planning is opened before these are set up.

const https = require('https');
const { getCached, cacheStatus } = require('./amCache');

// TTLs match the values already proven in production (demandplanning):
// stock/on-order need to be fresher, the full catalogue (launch dates, CORE
// group, images) barely changes so it can go longer between crawls.
const STOCK_TTL = 45 * 60 * 1000;
const ON_ORDER_TTL = 45 * 60 * 1000;
const CATALOGUE_TTL = 6 * 60 * 60 * 1000;
const SIZE_RANGES_TTL = 24 * 60 * 60 * 1000; // size ranges essentially never change

const AM_SUBDOMAIN = process.env.AM_SUBDOMAIN;
const AM_TOKEN = process.env.AM_TOKEN;
const WAREHOUSE_IDS = (process.env.AM_WAREHOUSE_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function configured() {
  return Boolean(AM_SUBDOMAIN && AM_TOKEN);
}

function amRequest(method, endpoint, params = {}) {
  if (!configured()) {
    return Promise.reject(new Error('ApparelMagic is not configured (AM_SUBDOMAIN / AM_TOKEN missing)'));
  }
  const t = Math.floor(Date.now() / 1000);
  const qs = new URLSearchParams({ time: t, token: AM_TOKEN, ...params }).toString();
  const url = `https://${AM_SUBDOMAIN}.app.apparelmagic.com/api/json/${endpoint}/?${qs}`;

  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers: { 'User-Agent': 'WNDRR-Ad-Pipeline/1.0' } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, data: raw });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const ID_FIELD_CANDIDATES = ['product_id', 'sku_id', 'id'];

async function fetchAllPages(endpoint, params, maxPages = 500) {
  const pageSize = 200;
  const rows = [];
  let afterId = null;
  let idField = null;

  for (let i = 0; i < maxPages; i++) {
    const requestParams = { 'pagination[page_size]': pageSize, ...params };
    if (idField != null && afterId != null) {
      requestParams['parameters[0][field]'] = idField;
      requestParams['parameters[0][operator]'] = '>';
      requestParams['parameters[0][value]'] = afterId;
    }

    const result = await amRequest('GET', endpoint, requestParams);
    if (result.status !== 200) {
      throw new Error(`ApparelMagic ${endpoint} returned status ${result.status}: ${JSON.stringify(result.data)}`);
    }
    const batch = result.data?.response || [];
    rows.push(...batch);
    if (!batch.length) break;

    if (idField == null) {
      idField = ID_FIELD_CANDIDATES.find((f) => batch[0][f] !== undefined) || null;
      if (idField == null) break;
    }

    afterId = batch[batch.length - 1][idField];
    if (batch.length < pageSize) break;
  }
  return rows;
}

// Total Stock On Hand per style, summed across configured warehouses (or all
// warehouses if AM_WAREHOUSE_IDS is unset). Style-level only, per the
// Planning brief -- never size/SKU-level.
//
// Field is `qty_avail_sell` from /sku_warehouse, not `qty_inventory` --
// verified in production (demandplanning's V2 branch, AM data migration):
// AM's plain /inventory endpoint has no warehouse dimension at all (a
// company-wide blend across every warehouse), and /sku_warehouse's
// `qty_avail_sell` is the field that actually matches what AM's own UI shows
// filtered to a specific warehouse. warehouse_id 1002 is confirmed (via
// /warehouses) to be "Shopify Online Store" -- the natural default for
// AM_WAREHOUSE_IDS here, same warehouse aminventory/adcreationworkflow used.
async function getStockByStyle() {
  return getCached('stock', STOCK_TTL, fetchStockByStyleUncached);
}

async function fetchStockByStyleUncached() {
  const skuRows = await fetchAllPages('inventory', {});
  const styleBySku = new Map();
  for (const row of skuRows) {
    if (row.sku_id != null && row.style_number) {
      styleBySku.set(String(row.sku_id), row.style_number);
    }
  }

  const whParams = WAREHOUSE_IDS.length === 1 ? { warehouse_id: WAREHOUSE_IDS[0] } : {};
  const whRows = await fetchAllPages('sku_warehouse', whParams);

  const stockByStyle = new Map();
  for (const row of whRows) {
    if (WAREHOUSE_IDS.length > 1 && !WAREHOUSE_IDS.includes(String(row.warehouse_id))) continue;
    const style = styleBySku.get(String(row.sku_id));
    if (!style) continue;
    const qty = parseFloat(row.qty_avail_sell) || 0;
    stockByStyle.set(style, (stockByStyle.get(style) || 0) + qty);
  }
  return stockByStyle; // Map<style_code, total SOH>
}

// Units currently on order from suppliers (open purchase orders, not yet
// received) -- account 1068 is WNDRR's purchase-order account in AM,
// confirmed in production (demandplanning's fetchAMOrdersFromAPI). With
// is_open=1, AM embeds order_items directly in each order.
async function getOnOrderByStyle() {
  return getCached('onOrder', ON_ORDER_TTL, fetchOnOrderByStyleUncached);
}

async function fetchOnOrderByStyleUncached() {
  const orders = await fetchAllPages('orders', { account_number: '1068', is_open: 1 });
  const onOrderByStyle = new Map();
  for (const order of orders) {
    for (const item of order.order_items || []) {
      const qty = parseFloat(item.qty_open || 0);
      if (qty <= 0) continue;
      const style = (item.style_number || '').trim();
      if (!style) continue;
      onOrderByStyle.set(style, (onOrderByStyle.get(style) || 0) + qty);
    }
  }
  return onOrderByStyle; // Map<style_code, qty on order>
}

// Online sales channel customer accounts in AM -- confirmed live in
// production (demandplanning V2's syncAMSales). AM's /orders endpoint has
// no date-RANGE filter, only an exact-date one, so a rolling window means
// one request per (day, customer) pair -- 365 days x 2 customers -- run
// with bounded concurrency below rather than serially.
const AM_ONLINE_CUSTOMERS = ['ONLINE SALES', 'ICONIC ONLINE SALES'];
const SALES_WINDOW_DAYS = 365;
const SALES_TTL = 12 * 60 * 60 * 1000; // ~730-request crawl -- twice a day, not per request
const SALES_CONCURRENCY = 10;
// Same prefix pattern confirmed live in demandplanning V2 (AM_PRODUCT_STYLE_RE)
// -- order_items[].style_number sometimes carries a trailing size/service
// suffix, so this is a prefix match, not deriveProductCode's stricter one.
const AM_STYLE_PREFIX_RE = /^[A-Z]\d{2}[A-Z]{2}\d{3}[A-Z]{3}/;

async function runWithConcurrency(items, limit, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Trailing-year rolling sales, summed straight into the three windows this
// app surfaces (7D/30D/365D) rather than kept as a per-day breakdown like
// demandplanning's salesBySkuDay -- nothing here needs a day-by-day trend.
// Style-level only (this pipeline has no per-size SKU breakdown), so unlike
// demandplanning no sku_id->SKU lookup is needed: AM's order_items already
// carry style_number directly.
async function getSalesByStyle() {
  return getCached('sales', SALES_TTL, fetchSalesByStyleUncached);
}

async function fetchSalesByStyleUncached() {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const jobs = [];
  for (let daysAgo = 0; daysAgo < SALES_WINDOW_DAYS; daysAgo++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - daysAgo);
    const usDate = `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
    for (const customer of AM_ONLINE_CUSTOMERS) {
      jobs.push({ daysAgo, customer, usDate });
    }
  }

  const salesByStyle = new Map(); // style_code -> { qty7, qty30, qty365 }
  function addQty(style, daysAgo, qty) {
    if (qty <= 0) return;
    let entry = salesByStyle.get(style);
    if (!entry) {
      entry = { qty7: 0, qty30: 0, qty365: 0 };
      salesByStyle.set(style, entry);
    }
    if (daysAgo < 7) entry.qty7 += qty;
    if (daysAgo < 30) entry.qty30 += qty;
    entry.qty365 += qty;
  }

  await runWithConcurrency(jobs, SALES_CONCURRENCY, async ({ daysAgo, customer, usDate }) => {
    let result;
    try {
      result = await amRequest('GET', 'orders', { customer_name: customer, date: usDate });
    } catch {
      return; // one bad day/customer combo shouldn't fail the whole crawl
    }
    if (result.status !== 200) return;
    const orders = result.data?.response || [];
    for (const order of orders) {
      if ((order.credit_status || '') !== 'Approved') continue;
      for (const item of order.order_items || []) {
        const style = (item.style_number || '').trim().toUpperCase();
        if (!AM_STYLE_PREFIX_RE.test(style)) continue;
        const qty = (parseFloat(item.qty) || 0) - (parseFloat(item.qty_cxl) || 0);
        addQty(style, daysAgo, qty);
      }
    }
  });

  return salesByStyle; // Map<style_code, { qty7, qty30, qty365 }>
}

// WNDRR's modern style codes are a fixed 11 characters: W + 2-digit year +
// 2-letter collection code + 3-digit number + 3-letter colour (e.g.
// "W26IA004NAV"), confirmed in production (demandplanning's styleFromSku
// pattern). The base product -- what coverage/creative targets should group
// by, since colourways of the same product share one creative need -- is
// the first 8 characters; the colour is the last 3. Older/non-standard
// codes that don't match fall back to being their own group of one.
function deriveProductCode(styleCode) {
  const code = (styleCode || '').toUpperCase().trim();
  if (/^W\d{2}[A-Z]{2}\d{3}[A-Z]{3}$/.test(code)) return code.slice(0, 8);
  return code;
}

// Confirmed live (GET /api/debug/am/product/<code>): the image is NOT a flat
// field on the product record -- `images` is an array of picture objects,
// each with an `img` URL and an `is_catalog_image` flag. Prefer the one
// flagged as the catalog image; fall back to the first if none is flagged.
function extractImage(row) {
  const images = Array.isArray(row.images) ? row.images : [];
  if (!images.length) return null;
  const catalogImage = images.find((img) => img.is_catalog_image === '1' || img.is_catalog_image === 1);
  return (catalogImage || images[0]).img || null;
}

// WNDRR's AM account repurposes mid_code as Launch Date per style, and CORE
// membership is the AM product group -- both confirmed in production
// (demandplanning V2). '0' in mid_code means empty, not a real date.
const CORE_GROUPS = new Set(['AA CORE STYLES', 'ACCESSORIES CURRENT']);
function normGroupName(g) {
  return String(g || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

// The team doesn't run ads for Accessories -- checked against AM's own
// `category` field (distinct from `group`, used for isCore/CORE_GROUPS
// above). Shared by Core Creative Testing and Upcoming/Past Drops so the
// exclusion rule lives in exactly one place.
const AD_EXCLUDED_CATEGORY = 'ACCESSORIES';
function isAdExcludedCategory(details) {
  return details?.category === AD_EXCLUDED_CATEGORY;
}

// AU day-first date parsing ("30-07-26", "30/07/2026"), also accepts ISO.
// Returns a Date or null if unparseable.
function parseLaunchDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return new Date(y, Number(m[2]) - 1, Number(m[1]));
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

// One catalogue crawl of /products, returning everything Planning needs per
// style: display name/image (from `description`, "PRODUCT NAME - COLOUR"),
// launch date (`mid_code`), and CORE/Proven status (`group`).
async function getStyleCatalogue() {
  return getCached('catalogue', CATALOGUE_TTL, fetchStyleCatalogueUncached);
}

async function fetchStyleCatalogueUncached() {
  const rows = await fetchAllPages('products', {});
  const map = new Map();
  for (const row of rows) {
    const style = (row.style_number || '').trim();
    if (!style) continue;
    const description = (row.description || '').trim();
    const dashIdx = description.lastIndexOf(' - ');
    const productName = (dashIdx >= 0 ? description.slice(0, dashIdx) : description).trim() || null;
    // The segment after the last " - " in description is conventionally the
    // colourway name (e.g. "Pulse Heavy Weight Tee - Faded Black") -- kept
    // separate from productName rather than re-parsed by every caller.
    const colourNameFromDescription = dashIdx >= 0 ? description.slice(dashIdx + 3).trim() || null : null;
    const midCode = (row.mid_code || '').trim();
    const launchDateRaw = midCode && midCode !== '0' ? midCode : null;

    map.set(style, {
      productName,
      imageUrl: extractImage(row),
      launchDateRaw,
      launchDate: parseLaunchDate(launchDateRaw),
      isCore: CORE_GROUPS.has(normGroupName(row.group)),
      // AM's own `category` field -- confirmed live in production
      // (demandplanning's per-style AM product lookup) -- distinct from
      // `group` (used for isCore above). '' when AM has no category set.
      category: (row.category || '').trim().toUpperCase(),
      // Unverified against live WNDRR AM data (see resolveColourLabel/
      // resolveStyleSizing) -- read defensively, never assumed present.
      colorCode: row.color_code != null ? String(row.color_code).trim() || null : null,
      sizeRangeId: row.size_range_id != null ? String(row.size_range_id).trim() || null : null,
      colourNameFromDescription,
    });
  }
  return map; // Map<style_code, { productName, imageUrl, launchDateRaw, launchDate, isCore, category, colorCode, sizeRangeId, colourNameFromDescription }>
}

// Resolves a display-friendly colour name for a style, falling back to null
// (caller shows the raw style code instead) when AM has neither a
// description-derived colour segment nor a color_code. Unverified field
// names -- see the module-level caveat on fetchStyleCatalogueUncached.
function resolveColourLabel(amDetails, styleCode) {
  const details = amDetails ? amDetails.get(styleCode) : null;
  if (!details) return null;
  return details.colourNameFromDescription || details.colorCode || null;
}

// Resolves the sizes selectable for a style, plus whether they read as a
// waist-measurement range (every value parses as a plain integer, e.g.
// "28","30","32") or an alpha range (e.g. "S","M","L") -- computed purely
// from the observed size strings rather than a hardcoded assumption, so it
// degrades safely for any product/account where size_range_id isn't
// resolvable. Returns { sizes: [], system: null } when nothing resolves.
function resolveStyleSizing(amDetails, sizeRanges, styleCode) {
  const details = amDetails ? amDetails.get(styleCode) : null;
  const rangeId = details ? details.sizeRangeId : null;
  const range = rangeId && sizeRanges ? sizeRanges.get(rangeId) : null;
  const sizes = range ? range.sizes : [];
  if (!sizes.length) return { sizes: [], system: null };
  const system = sizes.every((s) => /^\d+$/.test(s)) ? 'waist' : 'alpha';
  return { sizes, system };
}

// Dedicated size-range entity -- not currently called anywhere else in this
// codebase. Each row is one named size range (e.g. "Mens Alpha", "Waist
// 28-40") with its ordered size slots in size_01..size_16 (unused slots are
// empty strings, filtered out here). Unverified field names -- see the
// module-level caveat on fetchStyleCatalogueUncached.
async function getSizeRanges() {
  return getCached('sizeRanges', SIZE_RANGES_TTL, fetchSizeRangesUncached);
}

async function fetchSizeRangesUncached() {
  const rows = await fetchAllPages('size_ranges', {});
  const map = new Map();
  for (const row of rows) {
    const id = row.id != null ? String(row.id).trim() : null;
    if (!id) continue;
    const sizes = [];
    for (let i = 1; i <= 16; i++) {
      const key = `size_${String(i).padStart(2, '0')}`;
      const val = (row[key] || '').trim();
      if (val) sizes.push(val);
    }
    map.set(id, { name: (row.name || '').trim() || null, sizes });
  }
  return map; // Map<size_range_id, { name, sizes: string[] }>
}

// Exposed only for the debug route -- lets us see a raw response shape
// (e.g. to find the real image field) without guessing.
async function rawRequest(endpoint, params) {
  return amRequest('GET', endpoint, params);
}

// Fire off all four crawls once at server boot (not awaited by the
// caller) so the cache is warm by the time a real request arrives, instead
// of the first Planning page load after every deploy blocking for however
// long a cold full-catalogue crawl takes. Safe no-op if AM isn't configured.
// getSalesByStyle is by far the most expensive (~730 requests) -- Core
// Creative Testing degrades gracefully (null velocity) while it's still
// warming rather than blocking on it.
function warmAmCache() {
  if (!configured()) return;
  Promise.all([getStockByStyle(), getStyleCatalogue(), getOnOrderByStyle(), getSalesByStyle(), getSizeRanges()]).catch((err) => {
    console.error('ApparelMagic cache warm-up failed (will retry on first real request):', err.message);
  });
}

function getAmCacheStatus() {
  return {
    stock: cacheStatus('stock'),
    catalogue: cacheStatus('catalogue'),
    onOrder: cacheStatus('onOrder'),
    sales: cacheStatus('sales'),
    sizeRanges: cacheStatus('sizeRanges'),
  };
}

module.exports = {
  configured,
  getStockByStyle,
  getStyleCatalogue,
  getOnOrderByStyle,
  getSalesByStyle,
  getSizeRanges,
  resolveColourLabel,
  resolveStyleSizing,
  deriveProductCode,
  parseLaunchDate,
  rawRequest,
  warmAmCache,
  getAmCacheStatus,
  AD_EXCLUDED_CATEGORY,
  isAdExcludedCategory,
};
