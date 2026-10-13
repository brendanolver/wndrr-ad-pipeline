// Reference Library previews: a best-effort thumbnail for a saved reference URL, plus the cover-image handling around it.
// Nothing here may ever stop a reference being saved: every failure ends as "no preview" and the card keeps its platform placeholder.
//   - YouTube: the static thumbnail for the video id.
//   - TikTok: the public oEmbed endpoint.
//   - Instagram and everything else: the page's own og:image / twitter:image, read with a link-preview user agent. Instagram and TikTok often refuse
//     this (login walls, bot checks), so a miss is normal and is recorded as "none" rather than an error.
// The image itself is downloaded and stored (platform CDN links expire), after checking the bytes really are an image. Fetching only ever goes to public
// addresses (every connection, every redirect hop, is checked), with a short timeout and a size cap.
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const { sniffType } = require('./updateRequests');

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_HTML_BYTES = 600 * 1024;
const MAX_REDIRECTS = 4;
const STEP_TIMEOUT_MS = 6000;
const UA = 'Mozilla/5.0 (compatible; WNDRRReferencePreview/1.0; +link-preview) facebookexternalhit/1.1';

// ── only public addresses ──
function isPrivateAddress(addr) {
  if (!addr) return true;
  let a = String(addr).toLowerCase();
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) a = mapped[1];
  if (net.isIPv4(a)) {
    const [p, q] = a.split('.').map(Number);
    return p === 0 || p === 10 || p === 127 || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127) || p >= 224;
  }
  if (net.isIPv6(a)) return a === '::' || a === '::1' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb') || a.startsWith('ff');
  return true;
}
function publicUrl(raw) {
  let u; try { u = new URL(String(raw).trim()); } catch (_) { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return null;
  if (net.isIP(host) && isPrivateAddress(host)) return null;
  return u;
}
// resolved here and checked, and the connection is made to that exact address, so a name cannot answer "public" to the check and "private" to the connection
function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = (addrs || []).filter((x) => !isPrivateAddress(x.address));
    if (!ok.length || ok.length !== addrs.length) return cb(new Error('blocked address'));
    if (options && options.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

// GET with manual redirects, a hard size cap and a timeout -> { status, headers, body: Buffer, url }
function httpGet(rawUrl, { maxBytes, accept } = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    const u = publicUrl(rawUrl);
    if (!u) return reject(new Error('url not allowed'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET', lookup: safeLookup, timeout: STEP_TIMEOUT_MS, headers: { 'User-Agent': UA, Accept: accept || '*/*', 'Accept-Language': 'en' } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hops >= MAX_REDIRECTS) return reject(new Error('too many redirects'));
        let next; try { next = new URL(res.headers.location, u).toString(); } catch (e) { return reject(new Error('bad redirect')); }
        return resolve(httpGet(next, { maxBytes, accept }, hops + 1));
      }
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > maxBytes) { req.destroy(new Error('too large')); } else chunks.push(c); });
      res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks), url: u.toString() }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// ── what to look for ──
function youtubeId(url) {
  const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{6,15})/i);
  return m ? m[1] : null;
}
function platformOf(url) {
  const l = String(url || '').toLowerCase();
  if (l.includes('instagram.com')) return 'instagram';
  if (l.includes('tiktok.com')) return 'tiktok';
  if (youtubeId(url)) return 'youtube';
  return 'other';
}
const decodeEntities = (s) => String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&#x2F;/gi, '/').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
// the preview image URLs named in a page's <head>, best first
function imageUrlsFromHtml(html, baseUrl) {
  const out = [];
  const tags = String(html).match(/<meta\b[^>]*>/gi) || [];
  const want = ['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'];
  for (const tag of tags) {
    const key = (tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const val = (tag.match(/content\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (key && val && want.includes(key.toLowerCase())) out.push({ rank: want.indexOf(key.toLowerCase()), url: decodeEntities(val.trim()) });
  }
  return out.sort((a, b) => a.rank - b.rank).map((x) => { try { return new URL(x.url, baseUrl).toString(); } catch (_) { return null; } }).filter(Boolean);
}

async function downloadImage(url, get) {
  const r = await get(url, { maxBytes: MAX_IMAGE_BYTES, accept: 'image/*' });
  if (r.status !== 200) return null;
  const type = sniffType(r.body);
  return type && IMAGE_TYPES.includes(type) ? { buf: r.body, type } : null;
}

// -> { buf, type, source } or null. Never throws.
async function fetchPreview(url, { get = httpGet } = {}) {
  const u = publicUrl(url);
  if (!u) return null;
  const attempt = async (source, fn) => { try { const img = await fn(); return img ? { ...img, source } : null; } catch (_) { return null; } };
  const platform = platformOf(url);
  let hit = null;
  if (platform === 'youtube') {
    const id = youtubeId(url);
    let small = null;
    for (const name of ['maxresdefault', 'hqdefault']) {
      const h = await attempt('youtube', () => downloadImage(`https://img.youtube.com/vi/${id}/${name}.jpg`, get));
      if (h && h.buf.length > 2500) { hit = h; break; } // a missing maxres comes back as a tiny grey placeholder
      small = small || h;
    }
    hit = hit || small;
    if (hit) return hit;
  }
  if (platform === 'tiktok') {
    hit = await attempt('tiktok', async () => {
      const r = await get(`https://www.tiktok.com/oembed?url=${encodeURIComponent(u.toString())}`, { maxBytes: 200 * 1024, accept: 'application/json' });
      if (r.status !== 200) return null;
      const t = JSON.parse(r.body.toString('utf8')).thumbnail_url;
      return t ? downloadImage(t, get) : null;
    });
    if (hit) return hit;
  }
  return attempt('page', async () => {
    const r = await get(u.toString(), { maxBytes: MAX_HTML_BYTES, accept: 'text/html,application/xhtml+xml' });
    if (r.status !== 200 || !/html/i.test(String(r.headers['content-type'] || 'text/html'))) return null;
    for (const img of imageUrlsFromHtml(r.body.toString('utf8'), r.url).slice(0, 3)) {
      const got = await downloadImage(img, get).catch(() => null);
      if (got) return got;
    }
    return null;
  });
}

// ── a cover image uploaded by a person ──
function decodeCover(c) {
  if (c === undefined || c === null) return { none: true };
  const raw = String((c && c.data) || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return { error: 'The cover image could not be read' };
  if (raw.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) return { error: 'The cover image must be under 5 MB' };
  const buf = Buffer.from(raw, 'base64');
  if (buf.length > MAX_IMAGE_BYTES) return { error: 'The cover image must be under 5 MB' };
  const type = sniffType(buf);
  if (!type || !IMAGE_TYPES.includes(type)) return { error: 'The cover must be a PNG, JPG, GIF or WebP image' };
  const name = String((c && c.name) || 'cover').split(/[\\/]/).pop().replace(/[\u0000-\u001f"<>|:*?]/g, '').trim().slice(0, 120) || 'cover';
  return { file: { name, type, size: buf.length, buf } };
}

// ── storing + the background work ──
const AUTO_ENABLED = () => process.env.REFERENCE_AUTO_PREVIEW !== '0';

async function storeAuto(pool, id, link, deps) {
  let img = null;
  try { img = await fetchPreview(link, deps); } catch (_) { img = null; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // the link may have changed while this was running -- only record the result if it is still the same link
    const cur = (await client.query('SELECT link FROM reference_library WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur || cur.link !== link) { await client.query('ROLLBACK'); return null; }
    if (img) {
      await client.query(`INSERT INTO reference_library_images (reference_id, kind, mime_type, file_name, size_bytes, data) VALUES ($1,'auto',$2,$3,$4,$5)
        ON CONFLICT (reference_id, kind) DO UPDATE SET mime_type = EXCLUDED.mime_type, file_name = EXCLUDED.file_name, size_bytes = EXCLUDED.size_bytes, data = EXCLUDED.data, created_at = now()`, [id, img.type, `${img.source}-preview`, img.buf.length, img.buf]);
    }
    await client.query("UPDATE reference_library SET preview_status = $2, preview_source = $3, preview_checked_at = now(), thumb_version = thumb_version + 1 WHERE id = $1", [id, img ? 'ok' : 'none', img ? img.source : null]);
    await client.query('COMMIT');
    return img ? img.source : null;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); return null; } finally { client.release(); }
}

// Queue a reference for an automatic preview (fire and forget, one at a time).
const queue = []; let draining = false;
function enqueue(pool, id, link, deps) {
  if (!AUTO_ENABLED()) return;
  queue.push({ pool, id, link, deps });
  if (draining) return;
  draining = true;
  (async () => { while (queue.length) { const j = queue.shift(); await storeAuto(j.pool, j.id, j.link, j.deps).catch(() => {}); } draining = false; })();
}

// A reference whose link has just been saved (or changed): clear the old automatic preview, mark pending, queue the fetch. A write to the preview columns only.
async function requestPreview(pool, id, link, deps) {
  if (!AUTO_ENABLED()) return;
  await pool.query("DELETE FROM reference_library_images WHERE reference_id = $1 AND kind = 'auto'", [id]);
  await pool.query("UPDATE reference_library SET preview_status = 'pending', preview_source = NULL, thumb_version = thumb_version + 1 WHERE id = $1", [id]);
  enqueue(pool, id, link, deps);
}

// Existing references that have never been tried (or whose attempt died part-way, or a miss older than a week) get a go, a few at a time.
async function backfill(pool, { limit = 20, deps } = {}) {
  if (!AUTO_ENABLED() || draining) return 0;
  const rows = (await pool.query(`SELECT id, link FROM reference_library
    WHERE preview_status IS NULL OR (preview_status = 'pending' AND COALESCE(preview_checked_at, updated_at) < now() - interval '10 minutes')
       OR (preview_status = 'none' AND preview_checked_at < now() - interval '7 days')
    ORDER BY created_at DESC LIMIT $1`, [limit])).rows;
  for (const r of rows) {
    await pool.query("UPDATE reference_library SET preview_status = 'pending', preview_checked_at = now() WHERE id = $1", [r.id]);
    enqueue(pool, r.id, r.link, deps);
  }
  return rows.length;
}

module.exports = { isPrivateAddress, publicUrl, httpGet, youtubeId, platformOf, imageUrlsFromHtml, fetchPreview, decodeCover, storeAuto, enqueue, requestPreview, backfill, MAX_IMAGE_BYTES, IMAGE_TYPES };
