// Chooses the sales history that seasonality is read from, and says which one was used and why.
//
//   SEASONAL_SALES_SOURCE = auto (default) | shopify | apparelmagic
//   auto          Shopify when it is configured and has loaded; otherwise ApparelMagic online sales, with the reason stated.
//   shopify       Shopify only: if it is not ready, seasonality is "unavailable" (no silent substitute).
//   apparelmagic  the previous behaviour.
//
// Why Shopify is preferred (see the Batch 11 follow-up report for the full comparison): it is the demand the ads actually drive, net of refunds,
// cancelled and test orders, in store-local days, cheap to refresh, and able to reach back two seasons. ApparelMagic remains the fallback and still
// supplies stock, catalogue, launch dates and open purchase orders.
//
// Loading Shopify takes minutes (a bulk export), so it NEVER blocks a Planning request: a cold start begins the load in the background and the plan
// uses ApparelMagic (or says "unavailable") until it lands. A failed load is remembered for 15 minutes so a bad token cannot trigger a call per page view.
const amCache = require('./amCache');
const shopify = require('./shopifySales');
const apparelmagic = require('./apparelmagic');

const KEY = 'shopifySales';
const RETRY_AFTER_ERROR_MS = 15 * 60 * 1000;
const state = { lastError: null, lastErrorAt: 0 };

function sourceMode(env = process.env) {
  const m = String(env.SEASONAL_SALES_SOURCE || 'auto').trim().toLowerCase();
  return ['auto', 'shopify', 'apparelmagic'].includes(m) ? m : 'auto';
}

async function fetchShopify({ knownStyles, env, fetchImpl }) {
  const cfg = shopify.envConfig(env);
  const client = shopify.makeClient({ domain: cfg.domain, token: cfg.token, apiVersion: cfg.apiVersion, fetchImpl });
  const tz = await shopify.shopTimeZone(client);
  return shopify.fetchSalesByStyle({ client, knownStyles, tz, lookbackDays: cfg.lookbackDays });
}

// Start (or reuse) the Shopify load without waiting for it. Returns the cached data when present.
function shopifyData({ knownStyles, env, deps }) {
  const st = amCache.cacheStatus(KEY);
  const run = deps.fetchShopify || (() => fetchShopify({ knownStyles, env, fetchImpl: deps.fetchImpl }));
  const recentError = state.lastError && Date.now() - state.lastErrorAt < RETRY_AFTER_ERROR_MS;
  if (!st.hasData && recentError) return { data: null, loading: false, error: state.lastError };
  const p = amCache.getCached(KEY, shopify.DEFAULT_TTL_MS, run)
    .then((d) => { state.lastError = null; return d; })
    .catch((e) => { state.lastError = e.message; state.lastErrorAt = Date.now(); return null; });
  if (st.hasData) return p.then((data) => ({ data, loading: false, error: null }));
  return Promise.resolve({ data: null, loading: true, error: null, pending: p });
}

// → { sales: Map|null, source: 'shopify'|'apparelmagic'|null, label, notes: [], reason }
async function load({ amDetails, deps = {}, env = process.env } = {}) {
  const mode = sourceMode(env);
  const notes = [];
  const am = async () => {
    const st = apparelmagic.getAmCacheStatus();
    return apparelmagic.configured() && st.sales && st.sales.hasData ? apparelmagic.getSalesByStyle() : null;
  };
  if (deps.salesByStyle !== undefined) { // injected (tests / callers that already hold the data)
    const s = deps.salesByStyle;
    return { sales: s, source: s ? ((s.window && s.window.source) || 'apparelmagic') : null, label: s && s.window && s.window.source === 'shopify' ? 'Shopify online orders' : 'ApparelMagic online sales', notes, reason: s ? null : 'Monthly sales history has not loaded yet' };
  }

  if (mode !== 'apparelmagic') {
    if (shopify.configured(env) || deps.fetchShopify) {
      const knownStyles = amDetails ? new Set(amDetails.keys()) : new Set();
      const r = await shopifyData({ knownStyles, env, deps });
      if (r.data) return { sales: r.data, source: 'shopify', label: 'Shopify online orders', notes, reason: null };
      const why = r.error ? `Shopify sales history could not be loaded (${r.error})` : 'Shopify sales history is still loading';
      if (mode === 'shopify') return { sales: null, source: null, label: null, notes, reason: `${why}; SEASONAL_SALES_SOURCE is set to Shopify only` };
      notes.push(`${why}; ApparelMagic online sales are used meanwhile.`);
    } else if (mode === 'shopify') {
      return { sales: null, source: null, label: null, notes, reason: 'Shopify is not configured (SHOPIFY_SHOP_DOMAIN / SHOPIFY_ADMIN_TOKEN); SEASONAL_SALES_SOURCE is set to Shopify only' };
    } else notes.push('Shopify is not configured, so ApparelMagic online sales are used.');
  }
  const s = await am();
  return { sales: s, source: s ? 'apparelmagic' : null, label: s ? 'ApparelMagic online sales' : null, notes, reason: s ? null : 'Monthly sales history has not loaded yet' };
}

const _resetForTests = () => { state.lastError = null; state.lastErrorAt = 0; };
module.exports = { load, sourceMode, _resetForTests };
