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

// Security fix (Meta Insights validation round): Graph API list responses
// carry paging.next/paging.previous -- full URLs with access_token=... as
// a query param, Meta's own doing, not something any caller here ever
// builds. Stripped at this single lowest level so EVERY caller, present
// and future, is covered automatically -- not just the one diagnostic
// probe that leaked it. paging.cursors (before/after) are kept: those are
// opaque cursor tokens, never the credential, and existing pagination
// (fetchAllLiveAdNames below, and metaSync.js) reads only cursors.after,
// never .next/.previous.
function stripPagingUrls(data) {
  if (data && typeof data === 'object' && data.paging && typeof data.paging === 'object') {
    data.paging = data.paging.cursors ? { cursors: data.paging.cursors } : undefined;
    if (data.paging === undefined) delete data.paging;
  }
  return data;
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
          resolve({ status: res.statusCode, data: stripPagingUrls(JSON.parse(raw)) });
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

// Generic authenticated read -- for the Insights validation round's
// diagnostic endpoint (debug.js), and any other future read that isn't the
// live-ad-name list above. `params` is a plain object of query params and
// must NEVER include access_token -- that's appended here, the one place
// outside this module's own top-level consts the token is ever touched.
// Callers only ever see { status, data }, exactly as metaRequest returns it
// -- Meta's own error bodies don't echo back the request URL/params, so
// this can never leak the token into a caller's error handling either.
function metaGet(path, params = {}) {
  if (!configured()) {
    return Promise.reject(new Error('Meta Ads is not configured (META_AD_ACCOUNT_ID / META_ACCESS_TOKEN missing)'));
  }
  const query = new URLSearchParams({ ...params, access_token: META_ACCESS_TOKEN });
  // Defense in depth: metaRequest only ever rejects on a network-level
  // error (DNS/connection failure, never a Meta error response -- those
  // resolve normally with a non-200 status), and Node's own https error
  // messages don't echo the request URL back today -- but a thrown error
  // is exactly the kind of thing that ends up in a log line someone pastes
  // into a ticket, so the token is stripped from the message here too,
  // not just trusted to never appear.
  return metaRequest(`${path}?${query.toString()}`).catch((err) => {
    throw new Error(String(err.message || err).split(META_ACCESS_TOKEN).join('[REDACTED]'));
  });
}

// "/act_<id>" with the "act_" prefix normalised exactly once, same as
// fetchAllLiveAdNames above -- every other caller building a path off the
// account should use this rather than re-deriving it.
function accountPath() {
  return `/act_${String(META_AD_ACCOUNT_ID || '').replace(/^act_/, '')}`;
}

// Generic cursor-pagination follower for metaSync.js -- a second one
// alongside fetchAllLiveAdNames' own inline loop rather than refactoring
// that existing, already-production function (live-ad-coverage behaviour
// must stay exactly as it is). Follows paging.cursors.after only -- never
// paging.next -- so this can never touch a credential-bearing URL even
// before stripPagingUrls runs; it would work identically if Meta stopped
// sending .next/.previous altogether. Calls `onPage(rows)` per page so a
// caller can upsert as it goes rather than holding the whole result set
// in memory. maxPages is a hard stop against a runaway loop, not an
// expected limit for any real call this app makes.
async function metaGetAllPages(path, params, onPage, maxPages = 200) {
  let after = null;
  for (let i = 0; i < maxPages; i += 1) {
    const pageParams = after ? { ...params, after } : { ...params };
    const result = await metaGet(path, pageParams);
    if (result.status !== 200) {
      const err = new Error(`Meta Graph API returned status ${result.status}: ${JSON.stringify(result.data)}`);
      err.status = result.status;
      err.metaError = result.data;
      throw err;
    }
    const rows = result.data?.data || [];
    await onPage(rows);
    after = result.data?.paging?.cursors?.after || null;
    if (!after || !rows.length) break;
  }
}

module.exports = {
  configured,
  getLiveAdCoverage,
  warmMetaAdsCache,
  getMetaAdsCacheStatus,
  metaGet,
  accountPath,
  metaGetAllPages,
};
