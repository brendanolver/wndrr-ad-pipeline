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
async function fetchFromMeta(adId, creativeId, deps = {}) {
  const get = deps.metaGet || metaAds.metaGet;
  const accountPath = deps.accountPath || metaAds.accountPath;
  const diagnostics = {};
  let firstErr = null;
  const ok = async (step, fn) => {
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
    }
  };

  const creative = creativeId ? await ok('creative', () => get(`/${encodeURIComponent(creativeId)}`, {
    fields: 'id,object_type,thumbnail_url,image_url,video_id,effective_object_story_id,instagram_permalink_url,object_story_spec,asset_feed_spec',
    thumbnail_width: '600', thumbnail_height: '600',
  })) : null;
  const adNode = await ok('share_link', () => get(`/${encodeURIComponent(adId)}`, { fields: 'preview_shareable_link' }));
  const previews = await ok('preview', () => get(`/${encodeURIComponent(adId)}/previews`, { ad_format: 'MOBILE_FEED_STANDARD' }));

  // every video this creative can play (single, story video_data, carousel cards, dynamic feed)
  const spec = (creative && creative.object_story_spec) || {};
  const vids = new Set();
  if (creative && creative.video_id) vids.add(String(creative.video_id));
  if ((spec.video_data || {}).video_id) vids.add(String(spec.video_data.video_id));
  ((spec.link_data || {}).child_attachments || []).forEach((ch) => { if (ch.video_id) vids.add(String(ch.video_id)); });
  (((creative && creative.asset_feed_spec) || {}).videos || []).forEach((v) => { if (v.video_id) vids.add(String(v.video_id)); });
  const videos = {};
  for (const vid of [...vids].slice(0, MAX_VIDEOS)) {
    const v = await ok(`video_${vid}`, () => get(`/${encodeURIComponent(vid)}`, { fields: 'source,picture,length,permalink_url' }));
    if (v) videos[vid] = v;
  }
  // carousel cards that carry only an image hash
  const hashes = new Set();
  ((spec.link_data || {}).child_attachments || []).forEach((ch) => { if (!ch.picture && ch.image_hash) hashes.add(ch.image_hash); });
  if ((spec.link_data || {}).image_hash && !(creative && creative.image_url)) hashes.add(spec.link_data.image_hash);
  (((creative && creative.asset_feed_spec) || {}).images || []).forEach((im) => { if (!im.url && im.hash) hashes.add(im.hash); });
  const imageUrls = {};
  if (hashes.size) {
    const imgs = await ok('image_hashes', () => get(`${accountPath()}/adimages`, { hashes: JSON.stringify([...hashes].slice(0, MAX_HASHES)), fields: 'hash,url' }));
    ((imgs && imgs.data) || []).forEach((i) => { if (i.hash && i.url) imageUrls[i.hash] = i.url; });
  }

  // Every step failed: that is an outage / permission problem, not "this ad has no creative" --
  // surface it so a saved copy is kept instead of being replaced by an empty one.
  if (!Object.values(diagnostics).some((v) => v === 'ok')) throw firstErr || new Error('Meta returned nothing');
  const norm = normalise({
    creative, shareLink: adNode && adNode.preview_shareable_link,
    previewBody: previews && previews.data && previews.data[0] && previews.data[0].body, videos, imageUrls,
  });
  return { ...norm, diagnostics };
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

// Cached creative for one ad. Fetches from Meta only when there is no usable cache (or refresh).
async function getCreative(adId, { refresh = false, now = Date.now() } = {}, deps = {}) {
  const db = deps.db || pool;
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
  });
  if (usable && !refresh) return respond({ ...cached.payload, fetched_at: new Date(cached.fetched_at).toISOString(), cached: true });

  const configured = deps.configured ? deps.configured() : metaAds.configured();
  if (!configured) {
    if (cached && cached.payload && cached.payload.kind) return respond({ ...cached.payload, fetched_at: new Date(cached.fetched_at).toISOString(), cached: true, stale: true }, { warning: 'Meta is not configured here; showing the last saved preview, which may have expired.' });
    throw new HttpError(409, 'Meta is not configured in this environment, so the creative cannot be loaded.');
  }
  let fresh;
  try {
    fresh = await fetchFromMeta(adId, ad.meta_creative_id, deps);
  } catch (err) {
    if (cached && cached.payload && cached.payload.kind) return respond({ ...cached.payload, fetched_at: new Date(cached.fetched_at).toISOString(), cached: true, stale: true }, { warning: 'Could not refresh from Meta; showing the last saved preview.' });
    const rate = err && err.rateLimited;
    throw new HttpError(rate ? 429 : 502, rate ? 'Meta rate limit reached. Try again shortly.' : 'Could not load the creative from Meta.');
  }
  if (fresh.kind === 'unknown' && cached && cached.payload && cached.payload.kind && cached.payload.kind !== 'unknown') {
    // a refresh that found LESS than we already have (e.g. the creative read failed) never replaces the saved copy
    return respond({ ...cached.payload, fetched_at: new Date(cached.fetched_at).toISOString(), cached: true, stale: true }, { warning: 'Could not refresh the creative from Meta; showing the last saved preview.' });
  }
  const { urls, ...payload } = fresh;
  const expires = expiresAtFor(urls, now);
  await db.query(
    `INSERT INTO meta_ad_creatives (meta_ad_id, meta_creative_id, kind, payload, expires_at, fetched_at, error_code, error_message)
     VALUES ($1, $2, $3, $4, $5, now(), NULL, NULL)
     ON CONFLICT (meta_ad_id) DO UPDATE SET meta_creative_id = EXCLUDED.meta_creative_id, kind = EXCLUDED.kind, payload = EXCLUDED.payload,
            expires_at = EXCLUDED.expires_at, fetched_at = now(), error_code = NULL, error_message = NULL`,
    [adId, ad.meta_creative_id, payload.kind, JSON.stringify(payload), expires]
  );
  return respond({ ...payload, fetched_at: new Date().toISOString(), cached: false });
}

module.exports = { getCreative, fetchFromMeta, normalise, safeUrl, expiryOf, expiresAtFor, iframeSrcFrom, adContext };
