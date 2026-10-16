/* Shared UI building blocks for the creative production workflow (Batch 34).
 *
 * One small set of markup helpers so every production page (Dashboard,
 * Concept Development, Tuesday Review, Shooting, Editing, Final Approval)
 * renders the same header, summary tiles, status badges, empty states and
 * creative thumbnails. Pure string builders + a pure media classifier; no DOM
 * access at load time, so the classifier is unit-testable in Node (UMD).
 *
 * Creative thumbnails: the app stores no media file for a Final Edit, only
 * the link the editor pasted back (final_edits.final_edit_link). So the
 * thumbnail is derived from THAT link and nothing else:
 *   - YouTube link   -> YouTube's own still of that video
 *   - direct video   -> the browser's first decoded frame of the file itself
 *   - direct image   -> the image itself
 *   - anything else (Drive, Frame.io, Dropbox, Vimeo, ...) -> a neutral
 *     placeholder naming the format/platform. Never a product image.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UX = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const VIDEO_EXT = /\.(mp4|mov|m4v|webm|ogv)(\?|#|$)/i;
  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif)(\?|#|$)/i;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  function platformLabel(host) {
    if (!host) return '';
    if (host.includes('youtube') || host === 'youtu.be') return 'YouTube';
    if (host.includes('vimeo')) return 'Vimeo';
    if (host.includes('frame.io')) return 'Frame.io';
    if (host.includes('drive.google') || host.includes('docs.google')) return 'Google Drive';
    if (host.includes('dropbox')) return 'Dropbox';
    if (host.includes('wetransfer') || host.includes('we.tl')) return 'WeTransfer';
    if (host.includes('loom')) return 'Loom';
    if (host.includes('canva')) return 'Canva';
    if (host.includes('instagram')) return 'Instagram';
    if (host.includes('tiktok')) return 'TikTok';
    return host;
  }

  function youTubeId(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '');
      if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
      if (host.includes('youtube')) {
        if (u.pathname === '/watch') return u.searchParams.get('v');
        const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/);
        if (m) return m[1];
      }
    } catch (e) { /* not a URL */ }
    return null;
  }

  // Google Drive file id from /file/d/<id>/..., ?id=<id> or /open?id=<id>. Folders and anything else give null.
  function driveFileId(url) {
    try {
      const u = new URL(url);
      if (!/(^|\.)drive\.google\.com$/.test(u.hostname) && !/(^|\.)docs\.google\.com$/.test(u.hostname)) return null;
      const m = u.pathname.match(/\/file\/d\/([\w-]{10,})/);
      if (m) return m[1];
      if (/^\/(open|uc|thumbnail)$/.test(u.pathname)) return u.searchParams.get('id');
    } catch (e) { /* not a URL */ }
    return null;
  }

  // classifyMedia(link, format) -> how the creative behind a link can be shown.
  //   kind:     'youtube' | 'video-file' | 'image-file' | 'link' | 'none'
  //   thumbUrl: an image URL that IS the creative (youtube / image-file), else null
  //   videoUrl: a direct file URL whose first frame can be shown (video-file), else null
  //   isVideo:  whether to overlay the small play icon
  //   format:   'video' | 'static' | 'carousel' (the Final Edit's own declared format)
  //   platform: human label for the placeholder caption
  function classifyMedia(link, format) {
    const fmt = format === 'static' || format === 'carousel' ? format : 'video';
    const url = typeof link === 'string' ? link.trim() : '';
    const base = { kind: 'none', thumbUrl: null, videoUrl: null, isVideo: fmt === 'video', format: fmt, platform: '' };
    if (!url || !/^https?:\/\//i.test(url)) return base;
    const host = hostOf(url);
    const platform = platformLabel(host);
    const yt = youTubeId(url);
    if (yt) {
      return { ...base, kind: 'youtube', thumbUrl: `https://img.youtube.com/vi/${yt}/hqdefault.jpg`, isVideo: true, platform: 'YouTube' };
    }
    // Drive: a thumbnail exists WITHOUT any sign-in only for files shared as "anyone with the link". For private files Google answers with a
    // sign-in page, the image fails to load and the placeholder (which still names Drive) is shown instead. No Drive credentials are used.
    const driveId = driveFileId(url);
    if (driveId) return { ...base, kind: 'drive', thumbUrl: `https://drive.google.com/thumbnail?id=${encodeURIComponent(driveId)}&sz=w480`, platform: 'Google Drive' };
    if (VIDEO_EXT.test(url)) return { ...base, kind: 'video-file', videoUrl: url, isVideo: true, platform };
    if (IMAGE_EXT.test(url)) return { ...base, kind: 'image-file', thumbUrl: url, isVideo: false, platform };
    return { ...base, kind: 'link', platform };
  }

  const ICON = {
    video: '<svg class="ic" aria-hidden="true" focusable="false"><use href="#i-film"></use></svg>',
    image: '<svg class="ic" aria-hidden="true" focusable="false"><use href="#i-image"></use></svg>',
    carousel: '<svg class="ic" aria-hidden="true" focusable="false"><use href="#i-layers"></use></svg>',
  };
  const PLAY = '<span class="ux-play" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg></span>';
  const FORMAT_WORD = { video: 'Video', static: 'Static', carousel: 'Carousel' };

  function placeholderHtml(m) {
    const word = FORMAT_WORD[m.format] || 'Creative';
    const caption = m.kind === 'none' ? `${word} · no link yet` : (m.kind === 'link' || m.kind === 'drive' ? `${m.platform ? m.platform + ' · ' : ''}preview unavailable` : (m.platform ? `${word} · ${m.platform}` : word));
    return `<span class="ux-media-ph">${m.format === 'carousel' ? ICON.carousel : (m.isVideo ? ICON.video : ICON.image)}<span class="ux-media-ph-text">${esc(caption)}</span></span>`;
  }

  // mediaThumbHtml(link, format, opts) -> a fixed-ratio creative thumbnail.
  // opts: { label (aria), size: 'sm'|'md'|'lg' }
  function mediaThumbHtml(link, format, opts) {
    const o = opts || {};
    const m = classifyMedia(link, format);
    const size = o.size === 'sm' || o.size === 'lg' ? o.size : 'md';
    const label = esc(o.label || 'Creative preview');
    let inner;
    if (m.thumbUrl) {
      inner = `<img src="${esc(m.thumbUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="UX.mediaFailed(this)">${m.isVideo ? PLAY : ''}`;
    } else if (m.videoUrl) {
      // #t=0.1 asks for the first frame; preload=metadata keeps it cheap, no autoplay.
      inner = `<video src="${esc(m.videoUrl)}#t=0.1" preload="metadata" muted playsinline tabindex="-1" onerror="UX.mediaFailed(this)"></video>${PLAY}`;
    } else {
      inner = placeholderHtml(m);
    }
    return `<span class="ux-media ux-media-${size} ux-media-${m.kind}" data-media-kind="${m.kind}" data-media-format="${m.format}" data-media-platform="${esc(m.platform)}"${o.fallbackImage ? ` data-fallback-image="${esc(o.fallbackImage)}"` : ''} role="img" aria-label="${label}">${inner}</span>`;
  }

  // Creative preview with an honest fallback. Priority: the actual creative (video still, static image, YouTube thumbnail) ->
  // the linked product image (clearly tagged "Product image", never presented as the finished video) -> a neutral placeholder.
  // A creative thumbnail that fails to load (for example a private Drive file) falls back the same way.
  function creativeThumbHtml(link, format, productImage, opts) {
    const o = opts || {};
    const m = classifyMedia(link, format);
    if ((m.kind === 'none' || m.kind === 'link') && productImage) return productFallbackHtml(productImage, o);
    return mediaThumbHtml(link, format, { ...o, fallbackImage: productImage || '' });
  }

  // The finished (final edited) creative itself, for Final Approval / Ad Setup. Unlike creativeThumbHtml it NEVER falls back to the product catalogue picture: a creative
  // that cannot be previewed shows a neutral placeholder that says so (missing, or a link the browser cannot preview) and the link is still opened by "View creative".
  function finalCreativeHtml(link, format, opts) {
    const o = opts || {};
    const m = classifyMedia(link, format);
    if (m.kind === 'none') {
      const size = o.size === 'sm' || o.size === 'lg' ? o.size : 'md';
      return `<span class="ux-media ux-media-${size} ux-media-none ux-media-missing" data-media-kind="missing" data-media-format="${m.format}" role="img" aria-label="Final creative missing"><span class="ux-media-ph">${m.format === 'carousel' ? ICON.carousel : (m.isVideo ? ICON.video : ICON.image)}<span class="ux-media-ph-text">Final creative missing</span></span></span>`;
    }
    return mediaThumbHtml(link, format, { ...o, fallbackImage: '' });
  }

  function productFallbackHtml(url, o) {
    const size = o && (o.size === 'sm' || o.size === 'lg') ? o.size : 'md';
    return `<span class="ux-media ux-media-${size} ux-media-product ux-media-fallback" data-media-kind="product-fallback" role="img" aria-label="Product image (no creative preview available)"><img src="${esc(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()"><span class="ux-media-tag">Product image</span></span>`;
  }

  // A thumbnail that fails to load becomes the same neutral placeholder.
  function mediaFailed(el) {
    const box = el && el.closest ? el.closest('.ux-media') : null;
    if (!box) return;
    const fmt = box.getAttribute('data-media-format') || 'video';
    const fb = box.getAttribute('data-fallback-image');
    if (fb) {
      box.setAttribute('data-media-kind', 'product-fallback');
      box.classList.add('ux-media-product', 'ux-media-fallback');
      box.innerHTML = `<img src="${esc(fb)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()"><span class="ux-media-tag">Product image</span>`;
      return;
    }
    box.setAttribute('data-media-kind', 'link');
    box.classList.add('ux-media-link');
    box.innerHTML = placeholderHtml({ kind: 'link', platform: box.getAttribute('data-media-platform') || '', format: fmt, isVideo: fmt === 'video' });
  }

  // Product/catalogue thumbnail (Concept Development, Tuesday Review cards). NOT used for Final Approval,
  // where the thumbnail must be the creative itself (see mediaThumbHtml).
  function productThumbHtml(url, size) {
    const sz = size === 'lg' || size === 'md' ? size : 'sm';
    const inner = url
      ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">`
      : '';
    return `<span class="ux-media ux-media-${sz} ux-media-product">${inner}<span class="ux-media-ph ux-media-ph-icon">${ICON.image}</span></span>`;
  }

  // Garment images (Planning tray, Shoot Plan tiles, Upcoming Drops): ONE complete, centred garment in a small box; the whole picture in a large one.
  // WNDRR's normal ApparelMagic catalogue picture is a single composite with the front and back views side by side, so a small thumbnail of it shows two squeezed garments
  // (and object-fit: cover just crops through the middle of both). Rules for a SMALL thumbnail, in order:
  //   1. a separate picture that ApparelMagic labels as the FRONT is used (`front`), never split;
  //   2. otherwise, if the loaded picture is wide enough to be two views side by side, only the FRONT half is used (the left half: the catalogue puts the front first);
  //   3. a picture that is already one view is used whole.
  // Then the garment itself is CENTRED: the picture is measured (bounding box of the non-background pixels inside the chosen view, see garmentBBox) and the thumbnail shows exactly
  // that box plus even padding, scaled to fit (never stretched, never clipped). The measuring reads the picture through the app's own same-origin /api/product-image, because
  // the browser will not let a page read the pixels of a picture from another site. Until (or unless) it can be measured, the whole chosen view is shown, centred in the box.
  // "Wide enough" depends on the garment: two tall bottoms (jeans, pants) side by side are only about square, two tops or shorts are clearly landscape.
  // A LARGE preview does not use any of this: it shows the whole picture, front and back included (productImgFullHtml).
  const GT_PAIR_MIN = 1.45; const GT_PAIR_MIN_LONG_BOTTOM = 1.0;
  const GT_LONG_BOTTOM = /JEAN|PANT|TROUSER|JOGGER/i; const GT_SHORT = /SHORT/i;
  const GT_PAD = 0.08; // even padding around the measured garment, as a share of its longer side
  const GT_PROXY = '/api/product-image?u=';
  function garmentPairMin(category) { const c = String(category || ''); return GT_LONG_BOTTOM.test(c) && !GT_SHORT.test(c) ? GT_PAIR_MIN_LONG_BOTTOM : GT_PAIR_MIN; }
  const round2 = (n) => Math.round(n * 100) / 100;
  // pure: which pixels of `region` are the garment? Background = transparent, or the colour of the region's corners. -> { x0, y0, x1, y1, isFg(x, y), count } | null
  function garmentFg(data, w, h, region) {
    const r = region || { x0: 0, y0: 0, x1: w, y1: h };
    const x0 = Math.max(0, Math.floor(r.x0)); const y0 = Math.max(0, Math.floor(r.y0)); const x1 = Math.min(w, Math.ceil(r.x1)); const y1 = Math.min(h, Math.ceil(r.y1));
    const rw = x1 - x0; const rh = y1 - y0;
    if (rw < 4 || rh < 4 || !data || data.length < w * h * 4) return null;
    const px = (x, y) => { const k = (y * w + x) * 4; return [data[k], data[k + 1], data[k + 2], data[k + 3]]; };
    const corners = []; const cs = Math.max(1, Math.min(3, Math.floor(Math.min(rw, rh) / 8)));
    for (const [cx, cy] of [[x0, y0], [x1 - cs, y0], [x0, y1 - cs], [x1 - cs, y1 - cs]]) for (let j = 0; j < cs; j++) for (let i = 0; i < cs; i++) corners.push(px(cx + i, cy + j));
    const med = (k) => { const v = corners.map((c) => c[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
    const bg = [med(0), med(1), med(2), med(3)]; const transparentBg = bg[3] < 20;
    const isFg = (x, y) => {
      if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
      const k = (y * w + x) * 4; const A = data[k + 3];
      return transparentBg ? A >= 40 : (A >= 40 && Math.max(Math.abs(data[k] - bg[0]), Math.abs(data[k + 1] - bg[1]), Math.abs(data[k + 2] - bg[2])) > 30);
    };
    let count = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (isFg(x, y)) count += 1;
    return { x0, y0, x1, y1, isFg, count };
  }
  // pure: bounding box of the garment inside `region` ({x0,y0,x1,y1} in pixels of an RGBA array w x h).
  // A row / column only counts when it holds at least two garment pixels, so a speck or a compression artefact cannot stretch the box. null when nothing garment-like is found.
  function garmentBBox(data, w, h, region) {
    const f = garmentFg(data, w, h, region);
    if (!f) return null;
    const rw = f.x1 - f.x0; const rh = f.y1 - f.y0;
    if (f.count < rw * rh * 0.005) return null;
    const cols = new Array(rw).fill(0); const rows = new Array(rh).fill(0);
    for (let y = f.y0; y < f.y1; y++) for (let x = f.x0; x < f.x1; x++) if (f.isFg(x, y)) { cols[x - f.x0] += 1; rows[y - f.y0] += 1; }
    const first = (a) => a.findIndex((n) => n >= 2); const last = (a) => { for (let i = a.length - 1; i >= 0; i--) if (a[i] >= 2) return i; return -1; };
    const bx0 = first(cols); const bx1 = last(cols); const by0 = first(rows); const by1 = last(rows);
    if (bx0 < 0 || by0 < 0 || bx1 <= bx0 || by1 <= by0) return null;
    return { x0: f.x0 + bx0, y0: f.y0 + by0, x1: f.x0 + bx1 + 1, y1: f.y0 + by1 + 1 };
  }
  // pure: how far is the garment tilted? A front view of a garment is (nearly) left-right symmetric about an upright axis, so the tilt is the rotation that makes its silhouette
  // most symmetric. Returns the rotation in degrees to APPLY (CSS rotate, clockwise positive) to level it, or 0 when it is already level, when the picture is not clear enough, or
  // when the best answer is not clearly better than leaving it alone. Small tilts only (+-GT_TILT_MAX): a bigger "tilt" is more likely a pose or design than a crooked picture, and
  // an answer at the edge of the search range is not trusted. Nothing is ever stretched: this only chooses an angle.
  const GT_TILT_MAX = 5; const GT_TILT_STEP = 0.25; const GT_TILT_MIN = 0.6; const GT_TILT_GAIN = 0.012;
  function garmentTilt(data, w, h, region) {
    const f = garmentFg(data, w, h, region);
    if (!f || f.count < (f.x1 - f.x0) * (f.y1 - f.y0) * 0.02) return 0;
    let sx = 0; let sy = 0;
    for (let y = f.y0; y < f.y1; y++) for (let x = f.x0; x < f.x1; x++) if (f.isFg(x, y)) { sx += x; sy += y; }
    const cx = sx / f.count; const cy = sy / f.count;
    // work on a grid covering the garment plus a margin for the rotation
    const bb = garmentBBox(data, w, h, region); if (!bb) return 0;
    const gw = bb.x1 - bb.x0; const gh = bb.y1 - bb.y0; const m = Math.ceil(Math.max(gw, gh) * 0.12);
    const gx0 = bb.x0 - m; const gy0 = bb.y0 - m; const GW = gw + 2 * m; const GH = gh + 2 * m;
    const sym = (deg) => {
      const t = deg * Math.PI / 180; const c = Math.cos(t); const sn = Math.sin(t);
      const M = new Uint8Array(GW * GH);
      for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
        const x = gx0 + i; const y = gy0 + j; // the rotated picture's pixel (x, y) shows the source pixel one rotation back
        const srcX = Math.round(cx + (x - cx) * c + (y - cy) * sn); const srcY = Math.round(cy - (x - cx) * sn + (y - cy) * c);
        if (f.isFg(srcX, srcY)) M[j * GW + i] = 1;
      }
      let inter = 0; let uni = 0;
      for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
        const mi = Math.round(2 * (cx - gx0) - i);
        const a = M[j * GW + i]; const b = mi >= 0 && mi < GW ? M[j * GW + mi] : 0;
        if (a & b) inter += 1; if (a | b) uni += 1;
      }
      return uni ? inter / uni : 0;
    };
    const base = sym(0); let best = 0; let bestScore = base;
    for (let d = -GT_TILT_MAX; d <= GT_TILT_MAX + 1e-9; d += GT_TILT_STEP) {
      if (Math.abs(d) < 1e-9) continue;
      const sc = sym(d); if (sc > bestScore + 1e-9) { bestScore = sc; best = d; }
    }
    if (Math.abs(best) < GT_TILT_MIN || Math.abs(best) >= GT_TILT_MAX - 1e-9) return 0;
    if (bestScore - base < GT_TILT_GAIN) return 0;
    return round2(best);
  }
  // pure: show the rectangle `rect` ({x0,y0,x1,y1} in the picture's own pixels) centred in a bw x bh box, scaled to fit (never stretched). Returns percentages of the BOX for
  // the picture element (left / top / width / height) and of the PICTURE for the clip that hides everything outside the rectangle (so the other view cannot show beside it).
  function garmentRectGeometry(nw, nh, rect, bw, bh) {
    const rw = rect.x1 - rect.x0; const rh = rect.y1 - rect.y0;
    const s = Math.min(bw / rw, bh / rh);
    const W = nw * s; const H = nh * s;
    const left = (bw - rw * s) / 2 - rect.x0 * s; const top = (bh - rh * s) / 2 - rect.y0 * s;
    return { left: round2(left / bw * 100), top: round2(top / bh * 100), width: round2(W / bw * 100), height: round2(H / bh * 100),
      clip: { t: round2(rect.y0 / nh * 100), r: round2((nw - rect.x1) / nw * 100), b: round2((nh - rect.y1) / nh * 100), l: round2(rect.x0 / nw * 100) } };
  }
  // pure: the view for one picture. `measured` = the garment's box inside the chosen view when it has been measured (picture pixels), else null.
  // view: 'front-crop' (the front half of a composite) | 'centred' (one view, measured and centred) | 'whole' (nothing known yet: shown whole, centred by the box)
  function garmentFitGeometry(nw, nh, bw, bh, category, single, measured) {
    const A = nh ? nw / nh : 0;
    if (!nw || !nh || !bw || !bh) return { view: 'whole' };
    const pair = !single && A >= garmentPairMin(category);
    const region = pair ? { x0: 0, y0: 0, x1: nw / 2, y1: nh } : { x0: 0, y0: 0, x1: nw, y1: nh };
    let rect = null;
    if (measured && measured.x1 > measured.x0 && measured.y1 > measured.y0) {
      const side = Math.max(measured.x1 - measured.x0, measured.y1 - measured.y0); const pad = side * GT_PAD;
      rect = { x0: Math.max(region.x0, measured.x0 - pad), y0: Math.max(region.y0, measured.y0 - pad), x1: Math.min(region.x1, measured.x1 + pad), y1: Math.min(region.y1, measured.y1 + pad) };
    } else if (pair) rect = region;
    if (!rect) return { view: 'whole' };
    const tilt = measured && Number(measured.tilt) ? Number(measured.tilt) : 0;
    const origin = measured ? { x: round2((measured.x0 + measured.x1) / 2 / nw * 100), y: round2((measured.y0 + measured.y1) / 2 / nh * 100) } : null;
    return { view: pair ? 'front-crop' : 'centred', pair, region, tilt, origin, ...garmentRectGeometry(nw, nh, rect, bw, bh) };
  }
  const gtCache = new Map(); // `${url}|${pair}` -> measured box in picture pixels | false (could not be measured)
  const gtPending = new Set();
  function gtKey(url, pair) { return `${url}|${pair ? 1 : 0}`; }
  function gtStored(key) { try { const v = sessionStorage.getItem('gt2:' + key); return v ? JSON.parse(v) : undefined; } catch (e) { return undefined; } }
  function gtStore(key, v) { try { sessionStorage.setItem('gt2:' + key, JSON.stringify(v)); } catch (e) { /* storage unavailable: just measured again next time */ } }
  // measure the picture once (through the same-origin proxy so its pixels are readable), then place every thumbnail of it again
  function gtMeasure(img, url, pair, nw, nh) {
    const key = gtKey(url, pair);
    if (gtCache.has(key) || gtPending.has(key)) return;
    const stored = gtStored(key); if (stored !== undefined) { gtCache.set(key, stored); return; }
    gtPending.add(key);
    const probe = new Image();
    probe.onload = () => {
      let result = false;
      try {
        const scale = Math.min(1, 360 / Math.max(probe.naturalWidth, probe.naturalHeight));
        const cw = Math.max(8, Math.round(probe.naturalWidth * scale)); const ch = Math.max(8, Math.round(probe.naturalHeight * scale));
        const c = document.createElement('canvas'); c.width = cw; c.height = ch; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(probe, 0, 0, cw, ch);
        const data = g.getImageData(0, 0, cw, ch).data;
        const bb = garmentBBox(data, cw, ch, pair ? { x0: 0, y0: 0, x1: cw / 2, y1: ch } : null);
        const regW = pair ? cw / 2 : cw;
        // a box that is tiny compared with its view is a white garment on a white page (or noise): do not trust it
        if (bb && (bb.x1 - bb.x0) >= regW * 0.2 && (bb.y1 - bb.y0) >= ch * 0.2) { const sx = nw / cw; const sy = nh / ch; result = { x0: bb.x0 * sx, y0: bb.y0 * sy, x1: bb.x1 * sx, y1: bb.y1 * sy, tilt: garmentTilt(data, cw, ch, pair ? { x0: 0, y0: 0, x1: cw / 2, y1: ch } : null) }; } // canvas pixels -> the picture's own pixels; tilt = the small rotation (degrees) that levels it, or 0
      } catch (e) { result = false; }
      gtCache.set(key, result); gtPending.delete(key); if (result) gtStore(key, result);
      document.querySelectorAll('img.gt-img').forEach((i) => { if (i.getAttribute('data-gt-key') === key) garmentFit(i); });
    };
    probe.onerror = () => { gtCache.set(key, false); gtPending.delete(key); };
    probe.src = GT_PROXY + encodeURIComponent(url);
  }
  function garmentFit(img) {
    if (!img || !img.naturalWidth) return;
    const box = img.parentElement; // percentages are of the box's inner (padding) area, which is what an absolutely positioned picture is placed in
    const bw = (box && box.clientWidth) || 1; const bh = (box && box.clientHeight) || 1; // (a box that is not laid out yet is treated as square; the placement is in percentages so it stays right)
    const url = img.getAttribute('data-gt-url') || img.currentSrc || img.src; const single = img.getAttribute('data-gt-single') === '1'; const cat = img.getAttribute('data-gt-cat');
    const first = garmentFitGeometry(img.naturalWidth, img.naturalHeight, bw, bh, cat, single, null);
    const pair = !!first.pair || (!single && img.naturalHeight && img.naturalWidth / img.naturalHeight >= garmentPairMin(cat));
    const key = gtKey(url, pair); img.setAttribute('data-gt-key', key);
    const measured = gtCache.get(key) || null;
    const g = measured ? garmentFitGeometry(img.naturalWidth, img.naturalHeight, bw, bh, cat, single, measured) : first;
    img.setAttribute('data-gt-view', g.view);
    img.setAttribute('data-gt-measured', measured ? '1' : '0');
    if (g.view === 'whole') img.style.cssText = ''; else img.style.cssText = `left:${g.left}%;top:${g.top}%;width:${g.width}%;height:${g.height}%;object-fit:fill;clip-path:inset(${g.clip.t}% ${g.clip.r}% ${g.clip.b}% ${g.clip.l}%);${g.tilt && g.origin ? `transform:rotate(${g.tilt}deg);transform-origin:${g.origin.x}% ${g.origin.y}%;` : ''}`;
    img.setAttribute('data-gt-tilt', g.tilt ? String(g.tilt) : '0');
    if (!measured && !gtCache.has(key) && typeof document !== 'undefined' && document.createElement) gtMeasure(img, url, pair, img.naturalWidth, img.naturalHeight);
  }
  function garmentFitAll(root) { (root || document).querySelectorAll('img.gt-img').forEach((i) => { if (i.complete) garmentFit(i); }); }
  // the <img> only: the caller keeps its own box (position: relative; overflow: hidden) so spacing, size and styling are unchanged
  function garmentImgHtml(o) {
    const opt = o || {}; const url = opt.front || opt.url;
    if (!url) return '';
    return `<img class="gt-img" src="${esc(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-gt-url="${esc(url)}" data-gt-cat="${esc(opt.category || '')}"${opt.front ? ' data-gt-single="1"' : ''} onload="UX.garmentFit(this)" onerror="this.remove()">`;
  }
  // a LARGE preview: the whole picture (front and back where the picture holds both), never cropped, centred, in proportion. A missing or broken picture leaves the box's placeholder.
  function productImgFullHtml(o) {
    const opt = o || {}; const url = opt.url;
    if (!url) return '';
    return `<img class="gt-full" src="${esc(url)}" alt="${esc(opt.alt || '')}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">`;
  }

  // Page header: title, one-line description, optional right-aligned actions.
  function pageHeaderHtml(title, description, actionsHtml) {
    return `<div class="ux-page-header"><div class="ux-page-header-text"><h1 class="ux-page-title">${esc(title)}</h1>${description ? `<p class="ux-page-desc">${esc(description)}</p>` : ''}</div>${actionsHtml ? `<div class="ux-page-header-actions">${actionsHtml}</div>` : ''}</div>`;
  }

  // Compact stat tiles: [{label, value, tone?}] -> one row, no repeated figures.
  function statTilesHtml(items) {
    return `<div class="ux-stats">${items.map((s) => `<div class="ux-stat${s.tone ? ` ux-stat-${s.tone}` : ''}"><div class="ux-stat-value">${esc(s.value)}</div><div class="ux-stat-label">${esc(s.label)}</div></div>`).join('')}</div>`;
  }

  // Status badge. tone: neutral | purple | green | amber | red
  function badgeHtml(text, tone) {
    return `<span class="ux-badge ux-badge-${tone || 'neutral'}">${esc(text)}</span>`;
  }

  function emptyStateHtml(title, hint) {
    return `<div class="ux-empty"><div class="ux-empty-title">${esc(title)}</div>${hint ? `<div class="ux-empty-hint">${esc(hint)}</div>` : ''}</div>`;
  }

  function progressBarHtml(pct, tone) {
    const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    return `<div class="ux-progress${tone ? ` ux-progress-${tone}` : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}"><div class="ux-progress-fill" style="width:${p}%"></div></div>`;
  }

  return { garmentImgHtml, productImgFullHtml, garmentFit, garmentFitAll, garmentFitGeometry, garmentRectGeometry, garmentBBox, garmentFg, garmentTilt, garmentPairMin, classifyMedia, mediaThumbHtml, creativeThumbHtml, finalCreativeHtml, productFallbackHtml, productThumbHtml, mediaFailed, placeholderHtml, pageHeaderHtml, statTilesHtml, badgeHtml, emptyStateHtml, progressBarHtml, esc };
}));
