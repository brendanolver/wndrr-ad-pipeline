// Meta Marketing API client.
//
// Stage 1 (Meta Ads data foundation): every sync now fetches a broadened set
// of per-ad fields (id, adset_id/name, campaign_id/name, creative id,
// effective_status) instead of just `name`, and durably upserts one row per
// real Meta ad into the `meta_ads` table (see db/schema.sql's comment on
// that table, and metaAdNameTemplate.js for the real underscore-delimited
// naming template parser). This is foundation only -- it does not attempt
// to map an ad to a WNDRR style/product; that stays exactly as it was.
//
// getLiveAdCoverage()'s existing behavior is UNCHANGED on purpose: it still
// derives its aggregate "Live on Meta per product family" counts only from
// currently-ACTIVE ads, via the original "+"-delimited parseMetaAdName /
// resolveMetaProduct flow (metaProductMapping.js), so every existing caller
// (Drop coverage cards, /api/debug/meta-ads/status) keeps working exactly as
// before. It's just now sourced from the same broadened fetch that also
// feeds the new durable storage, rather than a second separate API call --
// same 45-minute cache cadence as before, no extra Meta API traffic.
//
// Credentials come from META_AD_ACCOUNT_ID / META_ACCESS_TOKEN env vars
// (a Meta System User token with ads_read on that account), unset by
// default -- configured() lets callers degrade gracefully, same convention
// as apparelmagic.js.

const https = require('https');
const { pool } = require('../db');
const { getCached, cacheStatus } = require('./amCache');
const { parseMetaAdName, resolveMetaProduct } = require('./metaProductMapping');
const { parseAdNameTemplate, normalizeAdName } = require('./metaAdNameTemplate');

const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const GRAPH_API_VERSION = 'v21.0';

// Live ad counts don't need to be second-fresh -- 45m matches the TTL
// apparelmagic.js already uses for stock/on-order.
const LIVE_ADS_TTL = 45 * 60 * 1000;

// Broadened beyond the original ACTIVE-only filter so Stage 1 can recover
// useful historical Creative Library data (per the brief: "as much
// historical...data as is reasonably available", not a reckless full
// backfill). Deliberately excludes DELETED: Meta does not reliably serve
// deleted ad objects back through this edge at all (they fall out of the
// API after a retention window), so including it would add filter overhead
// for no real recovery -- this is the documented remaining history gap (see
// Stage 1 report). Every other effective_status Meta defines for an ad is
// included, so paused/archived/under-review Creative Library ads are all
// captured going forward.
const SYNCED_EFFECTIVE_STATUSES = [
  'ACTIVE', 'PAUSED', 'ARCHIVED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED',
  'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO',
  'IN_PROCESS', 'WITH_ISSUES',
];

// Batch number is also often present in the Creative Library ad set's own
// name (e.g. "2026-I September #315 Drop 1 Creatives") -- extracted here as
// a second, independent signal, stored separately from the ad name's own
// parsed Batch No. field (see schema.sql: never silently merged).
const ADSET_BATCH_NO_RE = /#\d+/;

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

// Every ad on the account matching SYNCED_EFFECTIVE_STATUSES, with the
// per-ad fields Stage 1 needs -- paginated via the Graph API's cursor-based
// paging (same shape apparelmagic.js's fetchAllPages follows for AM's own
// cursor pagination, just Meta's field names). Deliberately does NOT
// request insights/performance data -- this stage is about identity/naming
// data only, kept as light as the old name-only fetch was.
async function fetchAllAdRecords(maxPages = 500) {
  const accountId = String(META_AD_ACCOUNT_ID).replace(/^act_/, '');
  const filtering = JSON.stringify([{ field: 'effective_status', operator: 'IN', value: SYNCED_EFFECTIVE_STATUSES }]);
  const fields = 'id,name,effective_status,adset_id,campaign_id,creative{id},adset{name},campaign{name}';
  const ads = [];
  let after = null;

  for (let i = 0; i < maxPages; i++) {
    const params = new URLSearchParams({
      access_token: META_ACCESS_TOKEN,
      fields,
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
      if (!row.id || !row.name) continue;
      ads.push({
        id: row.id,
        name: row.name,
        effectiveStatus: row.effective_status || null,
        adsetId: row.adset_id || row.adset?.id || null,
        adsetName: row.adset?.name || null,
        campaignId: row.campaign_id || row.campaign?.id || null,
        campaignName: row.campaign?.name || null,
        creativeId: row.creative?.id || null,
      });
    }
    after = result.data?.paging?.cursors?.after || null;
    if (!after || !batch.length) break;
  }
  return ads;
}

// Idempotent upsert of every fetched ad into `meta_ads`: existing rows
// (matched on meta_ad_id) update in place and keep their original
// first_seen_at; new ads insert with first_seen_at = last_seen_at = now.
// A single malformed/unparseable ad name never aborts the batch -- parsing
// failure just yields parse_status='unparsed' for that row (still stored in
// full), per the brief's "fail gracefully" requirement.
async function syncMetaAdsToDb(adRecords) {
  let synced = 0;
  let parsed = 0;
  let partial = 0;
  let unparsed = 0;
  let failed = 0;

  for (const ad of adRecords) {
    try {
      const normalizedAdName = normalizeAdName(ad.name);
      const { parseStatus, parseError, fields } = parseAdNameTemplate(ad.name);
      const adsetBatchMatch = ad.adsetName ? ad.adsetName.match(ADSET_BATCH_NO_RE) : null;

      await pool.query(
        `INSERT INTO meta_ads (
           meta_ad_id, meta_ad_set_id, meta_campaign_id, meta_creative_id,
           raw_ad_name, raw_ad_set_name, raw_campaign_name, normalized_ad_name,
           effective_status, parse_status, parse_error,
           parsed_batch_no, parsed_week_no, parsed_date, parsed_product_raw,
           parsed_product_type_raw, parsed_hook, parsed_media, parsed_ad_type,
           parsed_creator, parsed_concept, parsed_url_link_page, adset_batch_no,
           first_seen_at, last_seen_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
           $16, $17, $18, $19, $20, $21, $22, $23, now(), now()
         )
         ON CONFLICT (meta_ad_id) DO UPDATE SET
           meta_ad_set_id = EXCLUDED.meta_ad_set_id,
           meta_campaign_id = EXCLUDED.meta_campaign_id,
           meta_creative_id = EXCLUDED.meta_creative_id,
           raw_ad_name = EXCLUDED.raw_ad_name,
           raw_ad_set_name = EXCLUDED.raw_ad_set_name,
           raw_campaign_name = EXCLUDED.raw_campaign_name,
           normalized_ad_name = EXCLUDED.normalized_ad_name,
           effective_status = EXCLUDED.effective_status,
           parse_status = EXCLUDED.parse_status,
           parse_error = EXCLUDED.parse_error,
           parsed_batch_no = EXCLUDED.parsed_batch_no,
           parsed_week_no = EXCLUDED.parsed_week_no,
           parsed_date = EXCLUDED.parsed_date,
           parsed_product_raw = EXCLUDED.parsed_product_raw,
           parsed_product_type_raw = EXCLUDED.parsed_product_type_raw,
           parsed_hook = EXCLUDED.parsed_hook,
           parsed_media = EXCLUDED.parsed_media,
           parsed_ad_type = EXCLUDED.parsed_ad_type,
           parsed_creator = EXCLUDED.parsed_creator,
           parsed_concept = EXCLUDED.parsed_concept,
           parsed_url_link_page = EXCLUDED.parsed_url_link_page,
           adset_batch_no = EXCLUDED.adset_batch_no,
           last_seen_at = now(),
           updated_at = now()`,
        [
          ad.id, ad.adsetId, ad.campaignId, ad.creativeId,
          ad.name, ad.adsetName, ad.campaignName, normalizedAdName,
          ad.effectiveStatus, parseStatus, parseError,
          fields.batchNo, fields.weekNo, fields.date, fields.productRaw,
          fields.productTypeRaw, fields.hook, fields.media, fields.adType,
          fields.creator, fields.concept, fields.urlLinkPage,
          adsetBatchMatch ? adsetBatchMatch[0] : null,
        ]
      );
      synced += 1;
      if (parseStatus === 'parsed') parsed += 1;
      else if (parseStatus === 'partial') partial += 1;
      else unparsed += 1;
    } catch (err) {
      // A single bad row (unexpected DB error, oversized field, etc.) must
      // never take down the rest of the sync -- log and keep going.
      failed += 1;
      console.error(`Meta Ads sync: failed to upsert ad ${ad.id}:`, err.message);
    }
  }

  return { synced, parsed, partial, unparsed, failed };
}

// Groups live (ACTIVE) ad names by their Product + Product Type before
// hitting the mapping table -- many live ads typically share one
// combination, so this keeps resolveMetaProduct calls proportional to
// distinct combinations rather than total live ad count. Any combination
// seen for the first time here is recorded (via resolveMetaProduct) as
// Unmapped, exactly like the manual "Check Mapping" flow -- this live sync
// is what actually feeds real ad names into Settings -> Meta Product
// Mapping going forward. Unchanged from before Stage 1 -- still uses the
// original "+"-delimited parseMetaAdName, not the new template parser.
function buildLiveAdCoverageFromActive(activeAdNames) {
  const grouped = new Map(); // "PRODUCT||TYPE" -> { product, productType, count }
  let unparsed = 0;
  for (const name of activeAdNames) {
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
  return { grouped, unparsed };
}

async function buildLiveAdCoverageUncached() {
  const allAds = await fetchAllAdRecords();

  // Durable storage as a side effect of the same cache-refresh cadence --
  // no extra Meta API traffic versus the old name-only fetch. A sync
  // failure here must not break the existing coverage-count behavior below,
  // so it's caught and logged rather than propagated.
  try {
    await syncMetaAdsToDb(allAds);
  } catch (err) {
    console.error('Meta Ads: syncMetaAdsToDb failed (coverage counts still computed):', err.message);
  }

  // Everything below this line reproduces the pre-Stage-1 behavior exactly,
  // just filtered down to ACTIVE from the broader fetch instead of a
  // separate ACTIVE-only API call.
  const activeAdNames = allAds.filter((ad) => ad.effectiveStatus === 'ACTIVE').map((ad) => ad.name);
  const { grouped, unparsed } = buildLiveAdCoverageFromActive(activeAdNames);

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

  return { counts, totalLiveAds: activeAdNames.length, unmapped, unparsed };
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
  SYNCED_EFFECTIVE_STATUSES,
};
