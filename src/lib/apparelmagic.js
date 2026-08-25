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
    const qty = parseFloat(row.qty_inventory) || 0;
    stockByStyle.set(style, (stockByStyle.get(style) || 0) + qty);
  }
  return stockByStyle; // Map<style_code, total SOH>
}

// Product name + image per style, straight from ApparelMagic's own
// `products` record where available. Image field name is unconfirmed
// against a live account (like adcreationworkflow's order_items caveat) --
// tries plausible variants and degrades to null rather than throwing, since
// the brief marks the image as "if available", not required.
const IMAGE_FIELD_CANDIDATES = ['image_url', 'photo_url', 'main_image_url', 'image', 'photo'];

async function getStyleDetails() {
  const rows = await fetchAllPages('products', {});
  const map = new Map();
  for (const row of rows) {
    const style = (row.style_number || '').trim();
    if (!style) continue;
    const description = (row.description || '').trim();
    const dashIdx = description.lastIndexOf(' - ');
    const productName = (dashIdx >= 0 ? description.slice(0, dashIdx) : description).trim() || null;
    const imageField = IMAGE_FIELD_CANDIDATES.find((f) => row[f]);
    map.set(style, { productName, imageUrl: imageField ? row[imageField] : null });
  }
  return map; // Map<style_code, { productName, imageUrl }>
}

module.exports = { configured, getStockByStyle, getStyleDetails };
