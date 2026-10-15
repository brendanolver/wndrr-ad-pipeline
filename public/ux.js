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
    const caption = m.kind === 'none' ? `${word} · no link yet` : (m.platform ? `${word} · ${m.platform}` : word);
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

  // Garment thumbnails (Planning tray + Shoot Plan tiles): ONE clear view of the garment.
  // WNDRR's normal ApparelMagic catalogue picture is a single composite with the front and back views side by side, so a small thumbnail of it shows two squeezed garments
  // (and object-fit: cover just crops through the middle of both). Rules, in order:
  //   1. a separate picture that ApparelMagic labels as the FRONT is used whole (`front`), nothing is cropped;
  //   2. otherwise, if the loaded picture is wide enough to be two views side by side, only the FRONT half is shown (the left half: the catalogue puts the front first),
  //      scaled to fit the thumbnail and centred, not stretched;
  //   3. a picture that is already one view (portrait / square) is shown whole, centred.
  // "Wide enough" depends on the garment: two tall bottoms (jeans, pants) side by side are only about square, two tops or shorts are clearly landscape.
  // The decision uses the picture's own size once it has loaded, so it needs no image data from the server and works for every product.
  const GT_PAIR_MIN = 1.45; const GT_PAIR_MIN_LONG_BOTTOM = 1.0;
  const GT_LONG_BOTTOM = /JEAN|PANT|TROUSER|JOGGER/i; const GT_SHORT = /SHORT/i;
  function garmentPairMin(category) { const c = String(category || ''); return GT_LONG_BOTTOM.test(c) && !GT_SHORT.test(c) ? GT_PAIR_MIN_LONG_BOTTOM : GT_PAIR_MIN; }
  // pure: where the picture goes inside a thumbnail box. Returns { view: 'front-crop' | 'whole', left, top, width, height } as percentages of the box.
  function garmentFitGeometry(nw, nh, bw, bh, category, single) {
    const A = nh ? nw / nh : 0;
    if (!nw || !nh || !bw || !bh || single || A < garmentPairMin(category)) return { view: 'whole' };
    const regionAspect = A / 2; const boxAspect = bw / bh; // the front half: nw/2 by nh
    const rw = regionAspect >= boxAspect ? bw : bh * regionAspect;
    const rh = regionAspect >= boxAspect ? bw / regionAspect : bh;
    const round = (n) => Math.round(n * 100) / 100;
    return { view: 'front-crop', left: round((bw - rw) / 2 / bw * 100), top: round((bh - rh) / 2 / bh * 100), width: round(rw * 2 / bw * 100), height: round(rh / bh * 100) };
  }
  function garmentFit(img) {
    if (!img || !img.naturalWidth) return;
    const box = img.parentElement; // percentages are of the box's inner (padding) area, which is what an absolutely positioned picture is placed in
    const g = garmentFitGeometry(img.naturalWidth, img.naturalHeight, (box && box.clientWidth) || 1, (box && box.clientHeight) || 1, img.getAttribute('data-gt-cat'), img.getAttribute('data-gt-single') === '1');
    img.setAttribute('data-gt-view', g.view);
    if (g.view === 'front-crop') { img.style.cssText = `left:${g.left}%;top:${g.top}%;width:${g.width}%;height:${g.height}%;object-fit:fill;clip-path:inset(0 50% 0 0);`; } else { img.style.cssText = ''; }
  }
  function garmentFitAll(root) { (root || document).querySelectorAll('img.gt-img').forEach((i) => { if (i.complete) garmentFit(i); }); }
  // (a box that is not laid out yet, e.g. a tile on a page that is not showing, is treated as square, which every thumbnail box is; the placement is in percentages so it stays right)
  // the clip hides the BACK half of the picture itself, so nothing of it can show in the margin beside the centred front view
  // the <img> only: the caller keeps its own box (position: relative; overflow: hidden) so spacing, size and styling are unchanged
  function garmentImgHtml(o) {
    const opt = o || {}; const url = opt.front || opt.url;
    if (!url) return '';
    return `<img class="gt-img" src="${esc(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-gt-cat="${esc(opt.category || '')}"${opt.front ? ' data-gt-single="1"' : ''} onload="UX.garmentFit(this)" onerror="this.remove()">`;
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

  return { garmentImgHtml, garmentFit, garmentFitAll, garmentFitGeometry, garmentPairMin, classifyMedia, mediaThumbHtml, creativeThumbHtml, productFallbackHtml, productThumbHtml, mediaFailed, placeholderHtml, pageHeaderHtml, statTilesHtml, badgeHtml, emptyStateHtml, progressBarHtml, esc };
}));
