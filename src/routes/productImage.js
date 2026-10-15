// GET /api/product-image?u=<url>: a same-origin copy of a product picture the app already knows about.
//
// Why: the Planning / Upcoming Drops thumbnails centre the garment by measuring the picture's pixels, and a browser will not let a page read the pixels of a picture served from
// another site (no CORS headers). The picture itself is still displayed from its own URL; this route is only used to MEASURE it. It is read-only and never stores anything.
//
// Safety (this is a server-side fetch, so it must not become an open proxy): only https URLs that are ALREADY in the application's own data are served -- an image URL
// ApparelMagic returned for a style, or one saved on a Shoot Plan item. Anything else is refused (404) without being fetched. The response must be an image and is capped in size.
const express = require('express');

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const KNOWN_TTL_MS = 10 * 60 * 1000;

function createRouter(deps = {}) {
  const router = express.Router();
  const fetchImpl = deps.fetchImpl || ((...a) => fetch(...a));
  let knownCache = { at: 0, urls: null };

  // every image URL the application itself holds from ApparelMagic (cached for a few minutes)
  async function amUrls() {
    if (knownCache.urls && Date.now() - knownCache.at < KNOWN_TTL_MS) return knownCache.urls;
    const urls = new Set();
    try {
      const am = deps.amData ? await deps.amData() : await require('../lib/planningData').fetchAmData();
      if (am && am.amDetails) for (const d of am.amDetails.values()) {
        if (d.imageUrl) urls.add(d.imageUrl);
        for (const i of d.images || []) if (i && i.url) urls.add(i.url);
      }
    } catch (e) { /* AM unavailable: only Shoot Plan pictures are known */ }
    knownCache = { at: Date.now(), urls };
    return urls;
  }
  async function isKnown(url) {
    if ((await amUrls()).has(url)) return true;
    const db = deps.pool || require('../db').pool;
    const r = await db.query('SELECT 1 FROM shoot_plan_items WHERE image_url = $1 LIMIT 1', [url]);
    return r.rows.length > 0;
  }

  router.get('/', async (req, res, next) => {
    try {
      const raw = String(req.query.u || '');
      let u;
      try { u = new URL(raw); } catch (e) { return res.status(400).json({ error: 'u must be a URL' }); }
      if (u.protocol !== 'https:') return res.status(400).json({ error: 'Only https pictures are served' });
      if (!(await isKnown(raw))) return res.status(404).json({ error: 'Unknown picture' });
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      let upstream;
      try { upstream = await fetchImpl(raw, { signal: ctl.signal, redirect: 'follow', headers: { accept: 'image/*' } }); } finally { clearTimeout(timer); }
      if (!upstream.ok) return res.status(502).json({ error: `The picture could not be fetched (${upstream.status})` });
      const type = String(upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!/^image\/(png|jpe?g|webp|gif|svg\+xml|avif)$/.test(type)) return res.status(502).json({ error: 'That address did not return a picture' });
      const len = Number(upstream.headers.get('content-length') || 0);
      if (len > MAX_BYTES) return res.status(502).json({ error: 'The picture is too large' });
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (buf.length > MAX_BYTES) return res.status(502).json({ error: 'The picture is too large' });
      res.set('Content-Type', type);
      res.set('Cache-Control', 'private, max-age=86400');
      res.set('X-Content-Type-Options', 'nosniff');
      if (type === 'image/svg+xml') res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      res.send(buf);
    } catch (err) {
      if (err && err.name === 'AbortError') return res.status(504).json({ error: 'The picture took too long to fetch' });
      next(err);
    }
  });
  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
