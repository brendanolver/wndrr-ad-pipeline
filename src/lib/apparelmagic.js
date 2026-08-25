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

const IMAGE_FIELD_CANDIDATES = ['image_url', 'photo_url', 'main_image_url', 'image', 'photo'];
// WNDRR's AM account repurposes mid_code as Launch Date per style, and CORE
// membership is the AM product group -- both confirmed in production
// (demandplanning V2). '0' in mid_code means empty, not a real date.
const CORE_GROUPS = new Set(['AA CORE STYLES', 'ACCESSORIES CURRENT']);
function normGroupName(g) {
  return String(g || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
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
  const rows = await fetchAllPages('products', {});
  const map = new Map();
  for (const row of rows) {
    const style = (row.style_number || '').trim();
    if (!style) continue;
    const description = (row.description || '').trim();
    const dashIdx = description.lastIndexOf(' - ');
    const productName = (dashIdx >= 0 ? description.slice(0, dashIdx) : description).trim() || null;
    const imageField = IMAGE_FIELD_CANDIDATES.find((f) => row[f]);
    const midCode = (row.mid_code || '').trim();
    const launchDateRaw = midCode && midCode !== '0' ? midCode : null;

    map.set(style, {
      productName,
      imageUrl: imageField ? row[imageField] : null,
      launchDateRaw,
      launchDate: parseLaunchDate(launchDateRaw),
      isCore: CORE_GROUPS.has(normGroupName(row.group)),
    });
  }
  return map; // Map<style_code, { productName, imageUrl, launchDateRaw, launchDate, isCore }>
}

// Exposed only for the debug route -- lets us see a raw response shape
// (e.g. to find the real image field) without guessing.
async function rawRequest(endpoint, params) {
  return amRequest('GET', endpoint, params);
}

module.exports = { configured, getStockByStyle, getStyleCatalogue, parseLaunchDate, rawRequest };
