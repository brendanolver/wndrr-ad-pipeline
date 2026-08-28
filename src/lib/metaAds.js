// Meta Marketing API client -- live ad counts for Drop coverage cards.
//
// Scope is deliberately narrow: this only counts currently-ACTIVE ads per
// internal product family, as a "Live on Meta" figure shown *alongside*
// (never replacing) the existing creative_assets-based coverage count --
// those measure different things (concepts produced vs. ads actually live).
// It does not attempt per-concept/per-ad traceability (see the discussion
// that led here: the "PRODUCT + PRODUCT TYPE + BATCH" ad-naming convention
// only carries product attribution, not a link back to a specific
// creative_asset row).
//
// Credentials come from META_AD_ACCOUNT_ID / META_ACCESS_TOKEN env vars
// (a Meta System User token with ads_read on that account), unset by
// default -- configured() lets callers degrade gracefully, same convention
// as apparelmagic.js.

const https = require('https');
const { getCached, cacheStatus } = require('./amCache');
const { parseMetaAdName, resolveMetaProduct } = require('./metaProductMapping');

const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const GRAPH_API_VERSION = 'v21.0';

// Live ad counts don't need to be second-fresh -- 45m matches the TTL
// apparelmagic.js already uses for stock/on-order.
const LIVE_ADS_TTL = 45 * 60 * 1000;

function configured() {
  return Boolean(META_AD_ACCOUNT_ID && META_ACCESS_TOKEN);
}

function metaRequest(pathAndQuery) {
  if (!configured()) {
    return Promise.reject(new Error('Meta Ads is not configured (META_AD_ACCOUNT_ID / META_ACCESS_TOKEN missing)'));
  }
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}${pathAndQuery}`;

  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'WNDRR-Ad-Pipeline/1.0' } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, data: raw });
        }
      });
    }).on('error', reject);
  });
}

// Every currently-ACTIVE ad's name on the account, paginated via the Graph
// API's cursor-based paging (same shape apparelmagic.js's fetchAllPages
// follows for AM's own cursor pagination, just Meta's field names).
async function fetchAllLiveAdNames(maxPages = 200) {
  const accountId = String(META_AD_ACCOUNT_ID).replace(/^act_/, '');
  const filtering = JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE'] }]);
  const names = [];
  let after = null;

  for (let i = 0; i < maxPages; i++) {
    const params = new URLSearchParams({
      access_token: META_ACCESS_TOKEN,
      fields: 'name',
      filtering,
      limit: '500',
    });
    if (after) params.set('after', after);

    const result = await metaRequest(`/act_${accountId}/ads?${params.toString()}`);
    if (result.status !== 200) {
      throw new Error(`Meta Ads API returned status ${result.status}: ${JSON.stringify(result.data)}`);
    }
    const batch = result.data?.data || [];
    for (const row of batch) {
      if (row.name) names.push(row.name);
    }
    after = result.data?.paging?.cursors?.after || null;
    if (!after || !batch.length) break;
  }
  return names;
}

// Groups live ad names by their Product + Product Type before hitting the
// mapping table -- many live ads typically share one combination, so this
// keeps resolveMetaProduct calls proportional to distinct combinations
// rather than total live ad count. Any combination seen for the first time
// here is recorded (via resolveMetaProduct) as Unmapped, exactly like the
// manual "Check Mapping" flow -- this live sync is what actually feeds real
// ad names into Settings -> Meta Product Mapping going forward.
async function buildLiveAdCoverageUncached() {
  const adNames = await fetchAllLiveAdNames();

  const grouped = new Map(); // "PRODUCT||TYPE" -> { product, productType, count }
  let unparsed = 0;
  for (const name of adNames) {
    const parsed = parseMetaAdName(name);
    if (!parsed) {
      unparsed += 1;
      continue;
    }
    const key = `${parsed.product.toUpperCase()}||${parsed.productType.toUpperCase()}`;
    const entry = grouped.get(key) || { product: parsed.product, productType: parsed.productType, count: 0 };
    entry.count += 1;
    grouped.set(key, entry);
  }

  const counts = new Map(); // product_code -> live ad count
  let unmapped = 0;
  for (const { product, productType, count } of grouped.values()) {
    const mapping = await resolveMetaProduct(product, productType);
    if (mapping.product_code) {
      counts.set(mapping.product_code, (counts.get(mapping.product_code) || 0) + count);
    } else {
      unmapped += count;
    }
  }

  return { counts, totalLiveAds: adNames.length, unmapped, unparsed };
}

function getLiveAdCoverage() {
  return getCached('metaLiveAdCoverage', LIVE_ADS_TTL, buildLiveAdCoverageUncached);
}

function warmMetaAdsCache() {
  if (!configured()) return;
  getLiveAdCoverage().catch((err) => {
    console.error('Meta Ads cache warm-up failed (will retry on first real request):', err.message);
  });
}

function getMetaAdsCacheStatus() {
  return cacheStatus('metaLiveAdCoverage');
}

module.exports = {
  configured,
  getLiveAdCoverage,
  warmMetaAdsCache,
  getMetaAdsCacheStatus,
};
