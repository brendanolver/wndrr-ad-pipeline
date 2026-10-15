// The public Shopify product page for ONE product, for Ad Setup's Destination. Read-only and never invented.
//
// Where a URL may come from, in order:
//   1. Shopify itself: a read-only Admin API lookup of the product's variants by SKU prefix (the ApparelMagic product code, e.g. W26JA004), returning each product's own
//      `onlineStoreUrl` -- the address Shopify publishes the page at. Needs the same SHOPIFY_SHOP_DOMAIN / SHOPIFY_ADMIN_TOKEN as the sales feed, with the read_products scope.
//      Exactly one published product must match; zero, several (ambiguous) or an unpublished product give no URL.
//   2. The Destination URL a person already saved on an earlier Ad Setup of the same product with "Product" as its link page (their own, real address).
// Nothing is built from a name or a guessed handle. When neither source yields a URL the answer is { url: null, reason, message } and Ad Setup flags the destination as needing attention.
// Nothing here writes to Shopify, and the token never leaves this server.
const shopifySales = require('./shopifySales');

const HIT_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 6000;

const VARIANTS_QUERY = `query ProductPageByProductCode($q: String!) {
  productVariants(first: 25, query: $q) { nodes { sku product { id status onlineStoreUrl } } }
}`;

const isHttpUrl = (u) => { try { const x = new URL(String(u || '').trim()); return x.protocol === 'https:' || x.protocol === 'http:'; } catch (e) { return false; } };

// pure: the answer for one product from the variants Shopify returned
function pickFromVariants(nodes, productCode) {
  const code = String(productCode || '').toUpperCase();
  const products = new Map();
  for (const n of nodes || []) {
    if (!n || !n.product || !String(n.sku || '').toUpperCase().startsWith(code)) continue; // the search is a prefix wildcard: keep only this product's own SKUs
    products.set(n.product.id, n.product);
  }
  if (!products.size) return { url: null, reason: 'not_found', message: 'Shopify has no product with this product code.' };
  if (products.size > 1) return { url: null, reason: 'ambiguous', message: 'More than one Shopify product matches this product code.' };
  const p = [...products.values()][0];
  if (!p.onlineStoreUrl || (p.status && p.status !== 'ACTIVE')) return { url: null, reason: 'not_published', message: 'The Shopify product exists but has no published online store page.' };
  if (!isHttpUrl(p.onlineStoreUrl)) return { url: null, reason: 'not_found', message: 'Shopify returned an unusable address.' };
  return { url: p.onlineStoreUrl, reason: null, message: null };
}

const cache = new Map(); // product code -> { at, ttl, value }

async function fromShopify(productCode, deps = {}) {
  const env = deps.env || process.env;
  const cfg = shopifySales.envConfig(env);
  if (!deps.gql && !cfg.ok) return { url: null, reason: 'shopify_not_configured', message: 'Shopify is not connected to this app, so the product page could not be looked up.' };
  const key = String(productCode).toUpperCase();
  const now = (deps.now || Date.now)();
  const hit = cache.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.value;
  let value;
  try {
    const gql = deps.gql || shopifySales.makeClient({ domain: cfg.domain, token: cfg.token, apiVersion: cfg.apiVersion }).gql;
    const data = await Promise.race([
      gql(VARIANTS_QUERY, { q: `sku:${key}*` }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Shopify did not answer in time')), deps.timeoutMs || LOOKUP_TIMEOUT_MS)),
    ]);
    value = pickFromVariants(data && data.productVariants && data.productVariants.nodes, key);
  } catch (e) {
    // an error is never cached for long and never becomes a URL
    value = { url: null, reason: 'shopify_error', message: /scope|access|refused|403|401|read_products/i.test(e.message || '') ? 'Shopify did not allow the product lookup (the app token needs the read_products scope).' : 'Shopify could not be reached to look up the product page.' };
    cache.set(key, { at: now, ttl: 60 * 1000, value });
    return value;
  }
  cache.set(key, { at: now, ttl: value.url ? HIT_TTL_MS : MISS_TTL_MS, value });
  return value;
}

// the address a person already saved for this product's product page on an earlier Ad Setup
async function fromEarlierAdSetup(productCode, db) {
  const like = `${String(productCode).toUpperCase().replace(/[%_\\]/g, '')}%`;
  const r = await db.query(
    `SELECT au.destination_url
       FROM ad_setups au
       JOIN ad_setup_products asp ON asp.ad_setup_id = au.id
       JOIN styles s ON s.id = asp.style_id
      WHERE s.style_code LIKE $1 AND au.url_link_page = 'product' AND au.destination_url ~* '^https?://'
      ORDER BY au.updated_at DESC LIMIT 1`, [like]);
  return r.rows.length ? r.rows[0].destination_url.trim() : null;
}

// → { url, source: 'shopify' | 'earlier_ad_setup' | null, reason, message }
async function resolveProductPageUrl(productCode, deps = {}) {
  if (!productCode) return { url: null, source: null, reason: 'no_product', message: 'This ad is not linked to one specific product.' };
  const shop = await fromShopify(productCode, deps);
  if (shop.url) return { url: shop.url, source: 'shopify', reason: null, message: null };
  let earlier = null;
  if (deps.db) { try { earlier = await fromEarlierAdSetup(productCode, deps.db); } catch (e) { earlier = null; } }
  if (earlier) return { url: earlier, source: 'earlier_ad_setup', reason: null, message: null };
  return { url: null, source: null, reason: shop.reason, message: shop.message };
}

module.exports = { resolveProductPageUrl, pickFromVariants, fromShopify, fromEarlierAdSetup, isHttpUrl, _cache: cache };
