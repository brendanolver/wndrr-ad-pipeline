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
    return `<span class="ux-media ux-media-${size} ux-media-${m.kind}" data-media-kind="${m.kind}" data-media-format="${m.format}" role="img" aria-label="${label}">${inner}</span>`;
  }

  // A thumbnail that fails to load becomes the same neutral placeholder.
  function mediaFailed(el) {
    const box = el && el.closest ? el.closest('.ux-media') : null;
    if (!box) return;
    const fmt = box.getAttribute('data-media-format') || 'video';
    box.setAttribute('data-media-kind', 'link');
    box.classList.add('ux-media-link');
    box.innerHTML = placeholderHtml({ kind: 'link', platform: '', format: fmt, isVideo: fmt === 'video' });
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

  return { classifyMedia, mediaThumbHtml, productThumbHtml, mediaFailed, placeholderHtml, pageHeaderHtml, statTilesHtml, badgeHtml, emptyStateHtml, progressBarHtml, esc };
}));
