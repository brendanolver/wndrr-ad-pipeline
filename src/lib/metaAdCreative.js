// Ad creative preview: video / image / carousel + Meta's own share/preview link.
//
// READ-ONLY against Meta (GETs only), fetched LAZILY when a person opens a
// preview and cached per ad in meta_ad_creatives -- the bulk inventory/insights
// sync is never widened, and a list/page view never calls Meta.
//
// What is asked for (all documented Marketing API reads with the existing
// ads_read token):
//   GET /{creative_id}   id,object_type,thumbnail_url,image_url,video_id,
//                        effective_object_story_id,instagram_permalink_url,
//                        object_story_spec,asset_feed_spec (+ thumbnail_width/height)
//   GET /{ad_id}         preview_shareable_link      -> "Open in Meta"
//   GET /{ad_id}/previews?ad_format=MOBILE_FEED_STANDARD -> signed preview_iframe URL
//   GET /{video_id}      source,picture,length,permalink_url (playable mp4)
//   GET /act_<id>/adimages?hashes=[..]  hash,url (carousel cards given only an image hash)
//
// Each step fails independently (diagnostics record which worked) so a missing
// permission or an unsupported placement degrades to "what we could get" -- e.g.
// thumbnail + Meta preview -- instead of an error.
//
// Safety: Meta's media URLs are signed CDN links that EXPIRE (their `oe` query
// param); expires_at drives a refetch. Only https URLs on Meta/Instagram hosts are
// ever kept, and any URL containing an access token is dropped. The account id is
// never put in a link: "Open in Meta" is Meta's own preview_shareable_link (or the
// signed preview URL), not an Ads Manager URL built from the account id.
const { pool } = require('../db');
const metaAds = require('./metaAds');
const { HttpError } = require('./metaPerformance');

const MAX_VIDEOS = 12;
const MAX_HASHES = 12;
const DEFAULT_TTL_MS = 3 * 60 * 60 * 1000;
const MIN_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 6 * 60 * 60 * 1000;
const HOST_OK = /(^|\.)(fbcdn\.net|facebook\.com|fb\.com|fb\.me|instagram\.com|cdninstagram\.com|fbsbx\.com)$/i;
const IFRAME_HOST_OK = /^(business|www)\.facebook\.com$/i;

// https + Meta/Instagram host + no credential. Anything else is dropped (null).
function safeUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  let url;
  try { url = new URL(u); } catch (e) { return null; }
  if (url.protocol !== 'https:' || !HOST_OK.test(url.hostname)) return null;
  if (/access_token/i.test(u)) return null;
  return url.toString();
}

// Meta's signed CDN URLs carry their expiry as `oe=<hex epoch seconds>`.
function expiryOf(u) {
  try {
    const oe = new URL(u).searchParams.get('oe');
    return oe && /^[0-9a-f]{6,10}$/i.test(oe) ? parseInt(oe, 16) * 1000 : null;
  } catch (e) { return null; }
}

function expiresAtFor(urls, now = Date.now()) {
  const exps = urls.map(expiryOf).filter(Boolean);
  const soonest = exps.length ? Math.min(...exps) - 5 * 60 * 1000 : now + DEFAULT_TTL_MS;
  return new Date(Math.min(now + MAX_TTL_MS, Math.max(now + MIN_TTL_MS, soonest)));
}

function iframeSrcFrom(body) {
  const m = /\bsrc="([^"]+)"/.exec(String(body || ''));
  if (!m) return null;
  const src = m[1].replace(/&amp;/g, '&');
  try {
    const u = new URL(src);
    if (u.protocol !== 'https:' || !IFRAME_HOST_OK.test(u.hostname) || !/^\/ads\/api\/preview_iframe\.php/.test(u.pathname)) return null;
    return /access_token/i.test(src) ? null : u.toString();
  } catch (e) { return null; }
}

const diag = (err) => (err && err.rateLimited ? 'rate_limited' : err && err.metaCode ? `meta_${err.metaCode}` : 'error');

// Pure: raw Meta pieces -> the normalised payload the UI renders.
function normalise({ creative, shareLink, previewBody, videos, imageUrls }) {
  const c = creative || {};
  const spec = c.object_story_spec || {};
  const link = spec.link_data || {};
  const cards = [];
  const addCard = (card) => { if (card.image_url || card.video_url || card.video_id) cards.push(card); };

  (link.child_attachments || []).forEach((ch) => {
    addCard({
      type: ch.video_id ? 'video' : 'image', video_id: ch.video_id || null, title: ch.name || null,
      image_url: safeUrl(ch.picture) || safeUrl(imageUrls[ch.image_hash]) || null,
    });
  });
  const feed = c.asset_feed_spec || {};
  (feed.videos || []).forEach((v) => addCard({ type: 'video', video_id: v.video_id || null, image_url: safeUrl(v.thumbnail_url) }));
  (feed.images || []).forEach((im) => addCard({ type: 'image', image_url: safeUrl(im.url) || safeUrl(imageUrls[im.hash]) || null }));
  const vd = spec.video_data || {};
  const singleVideoId = c.video_id || vd.video_id || null;
  const singleImage = safeUrl(c.image_url) || safeUrl(vd.image_url) || safeUrl((spec.photo_data || {}).url) || safeUrl(link.picture) || safeUrl(imageUrls[link.image_hash]) || null;

  // attach playable sources
  const withVideo = (card) => {
    const v = card.video_id ? videos[card.video_id] : null;
    return {
      type: card.type, title: card.title || null, image_url: card.image_url || (v && safeUrl(v.picture)) || null,
      video_url: v ? safeUrl(v.source) : null, poster_url: (v && safeUrl(v.picture)) || card.image_url || null, length: v && v.length ? Number(v.length) : null,
    };
  };
  const outCards = cards.map(withVideo);
  const thumb = safeUrl(c.thumbnail_url);
  let kind = 'unknown';
  let main = null;
  if (outCards.length > 1) kind = 'carousel';
  else if (singleVideoId || (outCards.length === 1 && outCards[0].type === 'video')) {
    kind = 'video';
    main = withVideo({ type: 'video', video_id: singleVideoId || cards[0].video_id, image_url: singleImage || (cards[0] && cards[0].image_url) || thumb });
  } else if (singleImage || (outCards.length === 1 && outCards[0].image_url)) {
    kind = 'image';
    main = { type: 'image', image_url: singleImage || outCards[0].image_url, video_url: null, poster_url: null, length: null };
  } else if (thumb) {
    kind = 'image';
    main = { type: 'image', image_url: thumb, video_url: null, poster_url: null, length: null };
  }
  const urls = [thumb, main && main.image_url, main && main.video_url, main && main.poster_url]
    .concat(outCards.flatMap((x) => [x.image_url, x.video_url, x.poster_url])).filter(Boolean);
  return {
    kind,
    object_type: c.object_type || null,
    thumbnail_url: thumb,
    main,
    cards: kind === 'carousel' ? outCards : [],
    share_link: safeUrl(shareLink),
    preview_iframe_src: iframeSrcFrom(previewBody),
    urls,
  };
}

// The Meta fetch. deps.metaGet / deps.accountPath are injectable for tests.
//   opts.knownShareLink  an already-stored preview_shareable_link for this ad: reused, so that call is skipped
//   opts.base            the normalised creative-level payload (kind / main / cards / thumbnail) of ANOTHER ad that uses the
//                        exact same meta_creative_id: those pieces are identical for every copy, so the creative + video +
//                        image-hash calls are skipped and only the ad-specific preview (the Meta-native iframe) is fetched.
// The independent calls run concurrently (they used to run one after another), and each step's time is recorded so the
// real bottleneck is visible in the response (`timings_ms`).
async function fetchFromMeta(adId, creativeId, deps = {}, opts = {}) {
  const get = deps.metaGet || metaAds.metaGet;
  const accountPath = deps.accountPath || metaAds.accountPath;
  const diagnostics = {};
  const timings = {};
  let firstErr = null;
  const ok = async (step, fn) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      if (r.status !== 200) throw metaAds.buildMetaApiError(r, `Meta ${step}`);
      diagnostics[step] = 'ok';
      return r.data || {};
    } catch (e) {
      if (!firstErr) firstErr = e;
      diagnostics[step] = diag(e);
      if (e && e.rateLimited && step === 'creative') throw e; // nothing else will work either
      return null;
    } finally {
      timings[step] = Date.now() - t0;
    }
  };

  const shareStep = opts.knownShareLink
    ? Promise.resolve({ preview_shareable_link: opts.knownShareLink })
    : ok('share_link', () => get(`/${encodeURIComponent(adId)}`, { fields: 'preview_shareable_link' }));
  if (opts.knownShareLink) diagnostics.share_link = 'reused';
  const previewStep = ok('preview', () => get(`/${encodeURIComponent(adId)}/previews`, { ad_format: 'MOBILE_FEED_STANDARD' }));

  if (opts.base) {
    // creative-level pieces come from a sibling ad of the exact same creative; only the ad-specific preview is fetched
    const [adNode, previews] = await Promise.all([shareStep, previewStep]);
    if (!Object.values(diagnostics).some((v) => v === 'ok' || v === 'reused')) throw firstErr || new Error('Meta returned nothing');
    const b = opts.base;
    return {
      kind: b.kind, object_type: b.object_type || null, thumbnail_url: b.thumbnail_url || null, main: b.main || null, cards: b.cards || [],
      share_link: safeUrl(adNode && adNode.preview_shareable_link),
      preview_iframe_src: iframeSrcFrom(previews && previews.data && previews.data[0] && previews.data[0].body),
      urls: [b.thumbnail_url, b.main && b.main.image_url, b.main && b.main.video_url, b.main && b.main.poster_url]
        .concat((b.cards || []).flatMap((x) => [x.image_url, x.video_url, x.poster_url])).filter(Boolean),
      diagnostics, timings_ms: timings, source: 'meta_sibling',
    };
  }

  const creativeStep = creativeId ? ok('creative', () => get(`/${encodeURIComponent(creativeId)}`, {
    fields: 'id,object_type,thumbnail_url,image_url,video_id,effective_object_story_id,instagram_permalink_url,object_story_spec,asset_feed_spec',
    thumbnail_width: '600', thumbnail_height: '600',
  })) : Promise.resolve(null);
  const [creative, adNode, previews] = await Promise.all([creativeStep, shareStep, previewStep]);

  // every video this creative can play (single, story video_data, carousel cards, dynamic feed) -- fetched concurrently
  const spec = (creative && creative.object_story_spec) || {};
  const vids = new Set();
  if (creative && creative.video_id) vids.add(String(creative.video_id));
  if ((spec.video_data || {}).video_id) vids.add(String(spec.video_data.video_id));
  ((spec.link_data || {}).child_attachments || []).forEach((ch) => { if (ch.video_id) vids.add(String(ch.video_id)); });
  (((creative && creative.asset_feed_spec) || {}).videos || []).forEach((v) => { if (v.video_id) vids.add(String(v.video_id)); });
  const videos = {};
  // carousel cards that carry only an image hash
  const hashes = new Set();
  ((spec.link_data || {}).child_attachments || []).forEach((ch) => { if (!ch.picture && ch.image_hash) hashes.add(ch.image_hash); });
  if ((spec.link_data || {}).image_hash && !(creative && creative.image_url)) hashes.add(spec.link_data.image_hash);
  (((creative && creative.asset_feed_spec) || {}).images || []).forEach((im) => { if (!im.url && im.hash) hashes.add(im.hash); });
  const imageUrls = {};
  await Promise.all([
    ...[...vids].slice(0, MAX_VIDEOS).map(async (vid) => {
      const v = await ok(`video_${vid}`, () => get(`/${encodeURIComponent(vid)}`, { fields: 'source,picture,length,permalink_url' }));
      if (v) videos[vid] = v;
    }),
    (async () => {
      if (!hashes.size) return;
      const imgs = await ok('image_hashes', () => get(`${accountPath()}/adimages`, { hashes: JSON.stringify([...hashes].slice(0, MAX_HASHES)), fields: 'hash,url' }));
      ((imgs && imgs.data) || []).forEach((i) => { if (i.hash && i.url) imageUrls[i.hash] = i.url; });
    })(),
  ]);

  // Every step failed: that is an outage / permission problem, not "this ad has no creative" --
  // surface it so a saved copy is kept instead of being replaced by an empty one.
  if (!Object.values(diagnostics).some((v) => v === 'ok' || v === 'reused')) throw firstErr || new Error('Meta returned nothing');
  const norm = normalise({
    creative, shareLink: adNode && adNode.preview_shareable_link,
    previewBody: previews && previews.data && previews.data[0] && previews.data[0].body, videos, imageUrls,
  });
  return { ...norm, diagnostics, timings_ms: timings, source: 'meta' };
}

// Ad + the context shown beside the creative (product/concept; money is added by the caller for admins only).
async function adContext(adId, db = pool) {
  const r = await db.query(
    `SELECT m.meta_ad_id, m.ad_name, m.meta_creative_id, m.effective_status, m.match_status,
            c.concept_label, c.creator_name, c.media_type,
            COALESCE((SELECT json_agg(p.product_name ORDER BY p.product_code) FROM meta_ad_products p WHERE p.meta_ad_id = m.meta_ad_id), '[]') AS products
       FROM meta_ads m LEFT JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id WHERE m.meta_ad_id = $1`,
    [adId]
  );
  return r.rows[0] || null;
}

const SHARE_LINK_REUSE_MS = 7 * 24 * 60 * 60 * 1000;
const inflight = new Map(); // adId -> Promise: simultaneous requests (hover prefetch + click) share ONE Meta fetch

// Cached creative for one ad. Fetches from Meta only when there is no usable cache (or refresh).
//   opts.prefetch  a hover/focus warm-up: serves the cache, and only reaches Meta when automatic Meta refresh is allowed
//                  (the same META_AUTO_SYNC switch as everything else that runs without a click); otherwise returns null.
async function getCreative(adId, { refresh = false, prefetch = false, now = Date.now() } = {}, deps = {}) {
  const db = deps.db || pool;
  const t0 = Date.now();
  const ad = await adContext(adId, db);
  if (!ad) throw new HttpError(404, 'Ad not found');
  const cached = (await db.query('SELECT * FROM meta_ad_creatives WHERE meta_ad_id = $1', [adId])).rows[0] || null;
  const usable = cached && cached.payload && cached.payload.kind && cached.expires_at && new Date(cached.expires_at).getTime() > now;
  const respond = (payload, extra = {}) => ({
    ad: {
      meta_ad_id: ad.meta_ad_id, ad_name: ad.ad_name, effective_status: ad.effective_status, match_status: ad.match_status,
      products: ad.products || [], concept: ad.concept_label || null, creator: ad.creator_name || null, media_type: ad.media_type || null,
    },
    creative: payload,
    ...extra,
    timings_ms: { total: Date.now() - t0, ...(extra.timings_ms || {}) },
  });
  if (usable && !refresh) return respond({ ...cached.payload, fetched_at: new Date(cached.fetched_at).toISOString(), cached: true }, { source: 'cache' });

  const configured = deps.configured ? deps.configured() : metaAds.configured();
  if (prefetch) {
    const autoOn = deps.autoEnabled ? deps.autoEnabled() : require('./metaAutoSync').enabled();
    if (!configured || !autoOn) return null; // a warm-up never starts Meta traffic the operator switched off
  }
  if (!configured) {
    if (cached && cached.payload && cached.payload.kind) return respond({ ...cached.payload, fetched_at: new Date(cached.fetched_at).toISOString(), cached: true, stale: true }, { warning: 'Meta is not configured here; showing the last saved preview, which may have expired.' });
    throw new HttpError(409, 'Meta is not configured in this environment, so the creative cannot be loaded.');
  }
  let fresh;
  try {
    if (!inflight.has(adId)) {
      const job = (async () => {
        // already-fetched pieces are reused instead of asked for again:
        //   * a stored preview link for this ad (meta_ad_share_links, e.g. from an Inspiration lookup or an earlier open)
        //   * the creative-level payload of another ad that uses the exact same meta_creative_id and is still unexpired
        const [link, sibling] = await Promise.all([
          db.query('SELECT share_link, fetched_at FROM meta_ad_share_links WHERE meta_ad_id = $1 AND share_link IS NOT NULL', [adId]),
          ad.meta_creative_id && !refresh ? db.query(
            `SELECT payload FROM meta_ad_creatives WHERE meta_creative_id = $1 AND meta_ad_id <> $2 AND expires_at > $3 AND payload ? 'kind' AND payload->>'kind' <> 'unknown'
              ORDER BY fetched_at DESC LIMIT 1`, [ad.meta_creative_id, adId, new Date(now + 5 * 60 * 1000)]) : Promise.resolve({ rows: [] }),
        ]);
        const known = link.rows[0] && now - new Date(link.rows[0].fetched_at).getTime() < SHARE_LINK_REUSE_MS && !refresh ? link.rows[0].share_link : null;
        return fetchFromMeta(adId, ad.meta_creative_id, deps, { knownShareLink: known, base: sibling.rows[0] ? sibling.rows[0].payload : null });
      })();
      inflight.set(adId, job);
      job.finally(() => inflight.delete(adId)).catch(() => {});
    }
    fresh = await inflight.get(adId);
  } catch (err) {
    if (cached && cached.payload && cached.payload.kind) return respond({ ...cached.payload, fetched_at: new Date(cached.fetched_at).toISOString(), cached: true, stale: true }, { warning: 'Could not refresh from Meta; showing the last saved preview.' });
    const rate = err && err.rateLimited;
    throw new HttpError(rate ? 429 : 502, rate ? 'Meta rate limit reached. Try again shortly.' : 'Could not load the creative from Meta.');
  }
  if (fresh.kind === 'unknown' && cached && cached.payload && cached.payload.kind && cached.payload.kind !== 'unknown') {
    // a refresh that found LESS than we already have (e.g. the creative read failed) never replaces the saved copy
    return respond({ ...cached.payload, fetched_at: new Date(cached.fetched_at).toISOString(), cached: true, stale: true }, { warning: 'Could not refresh the creative from Meta; showing the last saved preview.' });
  }
  const { urls, timings_ms: stepTimings, source, diagnostics, ...payload } = fresh;
  const expires = expiresAtFor(urls, now);
  await db.query(
    `INSERT INTO meta_ad_creatives (meta_ad_id, meta_creative_id, kind, payload, expires_at, fetched_at, error_code, error_message)
     VALUES ($1, $2, $3, $4, $5, now(), NULL, NULL)
     ON CONFLICT (meta_ad_id) DO UPDATE SET meta_creative_id = EXCLUDED.meta_creative_id, kind = EXCLUDED.kind, payload = EXCLUDED.payload,
            expires_at = EXCLUDED.expires_at, fetched_at = now(), error_code = NULL, error_message = NULL`,
    [adId, ad.meta_creative_id, payload.kind, JSON.stringify({ ...payload, diagnostics }), expires]
  );
  // remember the preview link so the Inspiration recovery (and the next open) never has to ask Meta for it again
  if (payload.share_link) {
    await db.query(
      `INSERT INTO meta_ad_share_links (meta_ad_id, share_link, fetched_at) VALUES ($1,$2, now())
       ON CONFLICT (meta_ad_id) DO UPDATE SET share_link = EXCLUDED.share_link, fetched_at = now()`, [adId, payload.share_link]).catch(() => {});
  }
  return respond({ ...payload, diagnostics, fetched_at: new Date().toISOString(), cached: false }, { source, timings_ms: stepTimings });
}

module.exports = { getCreative, fetchFromMeta, normalise, safeUrl, expiryOf, expiresAtFor, iframeSrcFrom, adContext };
