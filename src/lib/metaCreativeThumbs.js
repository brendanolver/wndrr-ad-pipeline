// Table thumbnails: a small cover per ad, cheap enough to show next to hundreds of ads.
//
// Strategy (never one Meta call per row):
//   1. an ad's cover comes, in order, from: a full preview already cached for that ad (meta_ad_creatives), then the
//      per-CREATIVE thumbnail cache (meta_creative_thumbs -- ads that reuse a creative share one entry);
//   2. only creatives with neither are asked of Meta, in ONE multi-id read per 50 creatives
//      (GET /?ids=...&fields=thumbnail_url,object_type,video_id,...), read-only;
//   3. results are stored with an expiry (Meta's signed CDN links expire); a creative Meta could not answer for is
//      remembered as 'unavailable' for a short while so it is not asked again on every page view.
// The browser asks for the ads it is showing (one request per table page) and renders <img loading="lazy">; nothing
// autoplays. The Meta lookups run only while automatic Meta refresh is allowed (META_AUTO_SYNC is not 'off') and
// META_THUMBNAILS is not 'off'; cached covers are always served. A Meta rate-limit answer stops the lookup at once and the
// cached covers are served as they are.
const { pool } = require('../db');
const metaAds = require('./metaAds');
const autoSync = require('./metaAutoSync');
const { safeUrl, expiresAtFor } = require('./metaAdCreative');

const BATCH = 50;
const MAX_ADS = 100;
const UNAVAILABLE_TTL_MS = 10 * 60 * 1000;
const FIELDS = 'id,object_type,thumbnail_url,video_id,object_story_spec,asset_feed_spec';
// Meta's default creative thumbnail is 64x64, which is soft at table size on a high-density screen: ask for a larger one (same single multi-id read, no extra call).
const THUMB_PARAMS = { thumbnail_width: '256', thumbnail_height: '256' };

function enabled() {
  return String(process.env.META_THUMBNAILS || 'on').toLowerCase() !== 'off';
}

// Pure: one creative object from Meta -> { kind, thumb_url }. Never guesses: no cover URL -> null thumb.
function summarise(c) {
  if (!c || typeof c !== 'object') return { kind: null, thumb_url: null };
  const spec = c.object_story_spec || {};
  const children = ((spec.link_data || {}).child_attachments || []).length;
  const feed = c.asset_feed_spec || {};
  const hasVideo = !!(c.video_id || (spec.video_data || {}).video_id || (feed.videos || []).length);
  let kind = 'image';
  if (children > 1) kind = 'carousel';
  else if ((feed.videos || []).length + (feed.images || []).length > 1) kind = 'dynamic';
  else if (hasVideo) kind = 'video';
  const thumb = safeUrl(c.thumbnail_url) || safeUrl((spec.video_data || {}).image_url) || safeUrl(((spec.link_data || {}).child_attachments || [])[0] && spec.link_data.child_attachments[0].picture) || null;
  return { kind, thumb_url: thumb, object_type: c.object_type || null };
}

async function getThumbs(adIds, { now = Date.now() } = {}, deps = {}) {
  const db = deps.db || pool;
  const ids = [...new Set((adIds || []).map(String))].slice(0, MAX_ADS);
  const out = {};
  const stats = { requested: ids.length, from_preview_cache: 0, from_thumb_cache: 0, meta_calls: 0, creatives_asked: 0, rate_limited: false };
  if (!ids.length) return { thumbs: out, stats };

  const adRows = (await db.query('SELECT meta_ad_id, meta_creative_id FROM meta_ads WHERE meta_ad_id = ANY($1::text[])', [ids])).rows;
  const creativeOf = new Map(adRows.map((r) => [r.meta_ad_id, r.meta_creative_id]));
  const previews = (await db.query(
    `SELECT meta_ad_id, kind, payload FROM meta_ad_creatives WHERE meta_ad_id = ANY($1::text[]) AND payload ? 'kind' AND expires_at > $2`, [ids, new Date(now)]
  )).rows;
  const previewOf = new Map(previews.map((r) => [r.meta_ad_id, r]));
  const creativeIds = [...new Set(adRows.map((r) => r.meta_creative_id).filter(Boolean))];
  const cached = creativeIds.length ? (await db.query('SELECT * FROM meta_creative_thumbs WHERE meta_creative_id = ANY($1::text[])', [creativeIds])).rows : [];
  const cacheOf = new Map(cached.map((r) => [r.meta_creative_id, r]));
  const fresh = (r) => r && (r.state === 'ok' ? r.expires_at && new Date(r.expires_at).getTime() > now : now - new Date(r.fetched_at).getTime() < UNAVAILABLE_TTL_MS);

  const need = creativeIds.filter((cid) => {
    // an ad that already has a usable full preview needs no lookup for its creative
    const adsOfCreative = adRows.filter((r) => r.meta_creative_id === cid).map((r) => r.meta_ad_id);
    if (adsOfCreative.some((a) => previewOf.has(a) && (previewOf.get(a).payload.thumbnail_url || (previewOf.get(a).payload.main && previewOf.get(a).payload.main.image_url)))) return false;
    return !fresh(cacheOf.get(cid));
  });

  const configured = deps.configured ? deps.configured() : metaAds.configured();
  // A page view must not start Meta traffic the operator switched off: lookups follow META_AUTO_SYNC (the same master switch
  // as the scheduler and the page's automatic refresh) as well as META_THUMBNAILS. Covers already cached are still served,
  // and opening a preview (an explicit click) still fetches and caches that ad's creative.
  const autoOn = deps.autoEnabled ? deps.autoEnabled() : autoSync.enabled();
  if (need.length && configured && (!enabled() || !autoOn)) stats.paused = !autoOn ? 'automatic Meta refresh is off (META_AUTO_SYNC)' : 'thumbnail lookups are off (META_THUMBNAILS)';
  if (need.length && configured && enabled() && autoOn) {
    const getByIds = deps.metaGetByIds || metaAds.metaGetByIds;
    for (let i = 0; i < need.length; i += BATCH) {
      const batch = need.slice(i, i + BATCH);
      let data;
      try {
        stats.meta_calls += batch.length; stats.creatives_asked += batch.length;
        data = await getByIds(batch, FIELDS, THUMB_PARAMS);
      } catch (err) {
        if (err && err.rateLimited) { stats.rate_limited = true; break; }
        data = null; // this batch failed: remember nothing, serve what we have
      }
      if (!data) continue;
      const failures = data[metaAds.metaGetByIds.FAILURES] || {};
      for (const cid of batch) {
        // a creative whose read FAILED (not "does not exist") is unknown: remember nothing, so it is asked for again rather than cached as unavailable
        if (failures[cid] && failures[cid].kind === 'error') continue;
        const s = summarise(data[cid]);
        const ok = !!s.thumb_url;
        const exp = ok ? expiresAtFor([s.thumb_url], now) : null;
        await db.query(
          `INSERT INTO meta_creative_thumbs (meta_creative_id, kind, thumb_url, object_type, state, expires_at, fetched_at)
           VALUES ($1,$2,$3,$4,$5,$6, now())
           ON CONFLICT (meta_creative_id) DO UPDATE SET kind = EXCLUDED.kind, thumb_url = EXCLUDED.thumb_url, object_type = EXCLUDED.object_type,
                  state = EXCLUDED.state, expires_at = EXCLUDED.expires_at, fetched_at = now()`,
          [cid, s.kind, s.thumb_url, s.object_type || null, ok ? 'ok' : 'unavailable', exp]
        );
        cacheOf.set(cid, { meta_creative_id: cid, kind: s.kind, thumb_url: s.thumb_url, state: ok ? 'ok' : 'unavailable', expires_at: exp, fetched_at: new Date(now) });
      }
    }
  }

  for (const id of ids) {
    const cid = creativeOf.get(id);
    const pv = previewOf.get(id);
    const pvThumb = pv && (pv.payload.thumbnail_url || (pv.payload.main && pv.payload.main.image_url));
    if (pvThumb) { out[id] = { state: 'ok', kind: pv.payload.kind, thumb_url: pvThumb }; stats.from_preview_cache += 1; continue; }
    const c = cid ? cacheOf.get(cid) : null;
    if (c && c.state === 'ok' && c.thumb_url && c.expires_at && new Date(c.expires_at).getTime() > now) { out[id] = { state: 'ok', kind: c.kind, thumb_url: c.thumb_url }; stats.from_thumb_cache += 1; continue; }
    // no cover to show, but the format is still reported when Meta told us (the table shows it on the placeholder)
    out[id] = { state: c && c.state === 'unavailable' ? 'unavailable' : 'pending', kind: (c && c.kind) || (pv && pv.payload && pv.payload.kind && pv.payload.kind !== 'unknown' ? pv.payload.kind : null), thumb_url: null };
  }
  return { thumbs: out, stats };
}


// ── Larger covers for the Best Ads gallery ───────────────────────────────────────────────────────────────────────────────────────
// Same rules as getThumbs (cache first, ONE multi-id Meta read per 50 creatives, only while automatic refresh is allowed, rate limits stop the lookup), but the creative is asked
// for at 600px and cached in its own columns (large_url / large_expires_at), so the table's light 256px covers are never replaced. A playable file is returned only when a FULL preview
// for that ad is already cached (meta_ad_creatives): nothing extra is fetched just to offer playback, and the gallery never loads video until a person asks for it.
const LARGE_PARAMS = { thumbnail_width: '600', thumbnail_height: '600' };
async function getLargeThumbs(adIds, { now = Date.now() } = {}, deps = {}) {
  const db = deps.db || pool;
  const ids = [...new Set((adIds || []).map(String))].slice(0, MAX_ADS);
  const out = {};
  const stats = { requested: ids.length, from_preview_cache: 0, from_thumb_cache: 0, meta_calls: 0, creatives_asked: 0, rate_limited: false };
  if (!ids.length) return { thumbs: out, stats };
  const adRows = (await db.query('SELECT meta_ad_id, meta_creative_id FROM meta_ads WHERE meta_ad_id = ANY($1::text[])', [ids])).rows;
  const creativeOf = new Map(adRows.map((r) => [r.meta_ad_id, r.meta_creative_id]));
  const previews = (await db.query(
    `SELECT meta_ad_id, payload FROM meta_ad_creatives WHERE meta_ad_id = ANY($1::text[]) AND payload ? 'kind' AND expires_at > $2`, [ids, new Date(now)])).rows;
  const previewOf = new Map(previews.map((r) => [r.meta_ad_id, r.payload]));
  const creativeIds = [...new Set(adRows.map((r) => r.meta_creative_id).filter(Boolean))];
  const cached = creativeIds.length ? (await db.query('SELECT * FROM meta_creative_thumbs WHERE meta_creative_id = ANY($1::text[])', [creativeIds])).rows : [];
  const cacheOf = new Map(cached.map((r) => [r.meta_creative_id, r]));
  const bestOfPreview = (pl) => (pl && (pl.thumbnail_url || (pl.main && (pl.main.image_url || pl.main.poster_url)) || ((pl.cards || [])[0] || {}).image_url)) || null;
  const largeFresh = (r) => r && r.large_url && r.large_expires_at && new Date(r.large_expires_at).getTime() > now;
  const unavailableFresh = (r) => r && r.state === 'unavailable' && now - new Date(r.fetched_at).getTime() < UNAVAILABLE_TTL_MS;
  const need = creativeIds.filter((cid) => {
    const adsOf = adRows.filter((r) => r.meta_creative_id === cid).map((r) => r.meta_ad_id);
    if (adsOf.some((a) => bestOfPreview(previewOf.get(a)))) return false;
    const c = cacheOf.get(cid);
    return !(largeFresh(c) || unavailableFresh(c));
  });
  const configured = deps.configured ? deps.configured() : metaAds.configured();
  const autoOn = deps.autoEnabled ? deps.autoEnabled() : autoSync.enabled();
  if (need.length && configured && (!enabled() || !autoOn)) stats.paused = !autoOn ? 'automatic Meta refresh is off (META_AUTO_SYNC)' : 'thumbnail lookups are off (META_THUMBNAILS)';
  if (need.length && configured && enabled() && autoOn) {
    const getByIds = deps.metaGetByIds || metaAds.metaGetByIds;
    for (let i = 0; i < need.length; i += BATCH) {
      const batch = need.slice(i, i + BATCH);
      let data;
      try { stats.meta_calls += batch.length; stats.creatives_asked += batch.length; data = await getByIds(batch, FIELDS, LARGE_PARAMS); } catch (err) { if (err && err.rateLimited) { stats.rate_limited = true; break; } data = null; }
      if (!data) continue;
      const failures = data[metaAds.metaGetByIds.FAILURES] || {};
      for (const cid of batch) {
        if (failures[cid] && failures[cid].kind === 'error') continue; // read failed: unknown, not "unavailable"
        const s = summarise(data[cid]);
        const exp = s.thumb_url ? expiresAtFor([s.thumb_url], now) : null;
        await db.query(
          `INSERT INTO meta_creative_thumbs (meta_creative_id, kind, thumb_url, object_type, state, expires_at, fetched_at, large_url, large_expires_at)
           VALUES ($1,$2,$3,$4,$5,$6, now(), $3, $6)
           ON CONFLICT (meta_creative_id) DO UPDATE SET kind = EXCLUDED.kind, object_type = EXCLUDED.object_type, state = EXCLUDED.state, fetched_at = now(),
                  large_url = EXCLUDED.large_url, large_expires_at = EXCLUDED.large_expires_at,
                  -- the small table cover is only filled in when it has none (never replaced by the larger one)
                  thumb_url = COALESCE(meta_creative_thumbs.thumb_url, EXCLUDED.thumb_url), expires_at = COALESCE(meta_creative_thumbs.expires_at, EXCLUDED.expires_at)`,
          [cid, s.kind, s.thumb_url, s.object_type || null, s.thumb_url ? 'ok' : 'unavailable', exp]);
        cacheOf.set(cid, { meta_creative_id: cid, kind: s.kind, state: s.thumb_url ? 'ok' : 'unavailable', large_url: s.thumb_url, large_expires_at: exp, thumb_url: s.thumb_url, expires_at: exp, fetched_at: new Date(now) });
      }
    }
  }
  for (const id of ids) {
    const cid = creativeOf.get(id);
    const pl = previewOf.get(id);
    const pv = bestOfPreview(pl);
    if (pv) { out[id] = { state: 'ok', kind: pl.kind, thumb_url: pv, video_url: (pl.main && pl.main.video_url) || null }; stats.from_preview_cache += 1; continue; }
    const c = cid ? cacheOf.get(cid) : null;
    if (c && largeFresh(c)) { out[id] = { state: 'ok', kind: c.kind, thumb_url: c.large_url, video_url: null }; stats.from_thumb_cache += 1; continue; }
    out[id] = { state: c && c.state === 'unavailable' ? 'unavailable' : 'pending', kind: (c && c.kind) || null, thumb_url: null, video_url: null };
  }
  return { thumbs: out, stats };
}

module.exports = { getLargeThumbs, LARGE_PARAMS, getThumbs, summarise, enabled, BATCH, MAX_ADS, FIELDS, THUMB_PARAMS };
