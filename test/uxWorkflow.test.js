'use strict';
// Batch 34: production-workflow UI. Pure helpers (public/ux.js), the Dashboard's additive workflow counts, and static guarantees about the markup:
// Final Approval thumbnails are the creative itself (never a product image), every id the handlers rely on survived the redesign, and the naming
// logic / calculations were not touched.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const UX = require('../public/ux');
const { loadWorkflowCounts, localDateStr } = require('../src/lib/dashboardWorkflow');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('public/app.js');
const html = read('public/index.html');
const css = read('public/styles.css');

// ── creative media classification ─────────────────────────────────────────────
test('classifyMedia: a YouTube link yields YouTube\'s own still of that video and counts as video', () => {
  for (const url of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/shorts/dQw4w9WgXcQ', 'https://youtube.com/embed/dQw4w9WgXcQ']) {
    const m = UX.classifyMedia(url, 'video');
    assert.equal(m.kind, 'youtube', url);
    assert.equal(m.thumbUrl, 'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    assert.equal(m.isVideo, true);
  }
});

test('classifyMedia: a direct video file is previewed from the file itself; a direct image is the image', () => {
  for (const url of ['https://cdn.x.com/a.mp4', 'https://cdn.x.com/a.MOV?token=1', 'https://cdn.x.com/a.webm#t=3']) {
    const m = UX.classifyMedia(url, 'video');
    assert.equal(m.kind, 'video-file', url);
    assert.equal(m.videoUrl, url);
    assert.equal(m.thumbUrl, null);
  }
  for (const url of ['https://cdn.x.com/a.png', 'https://cdn.x.com/a.JPG?x=1', 'https://cdn.x.com/a.webp']) {
    const m = UX.classifyMedia(url, 'static');
    assert.equal(m.kind, 'image-file', url);
    assert.equal(m.thumbUrl, url);
    assert.equal(m.isVideo, false, 'a static creative never gets a play icon');
  }
});

test('classifyMedia: links we cannot preview, empty values and unsafe schemes never produce a thumbnail', () => {
  const drive = UX.classifyMedia('https://drive.google.com/file/d/1/view', 'video');
  assert.equal(drive.kind, 'link'); assert.equal(drive.platform, 'Google Drive'); assert.equal(drive.thumbUrl, null); assert.equal(drive.videoUrl, null);
  assert.equal(UX.classifyMedia('https://app.frame.io/reviews/x', 'video').platform, 'Frame.io');
  for (const v of ['', '   ', null, undefined, 'javascript:alert(1)', 'data:text/html,hi', '/relative/a.mp4', 'ftp://x/a.mp4']) {
    const m = UX.classifyMedia(v, 'video');
    assert.equal(m.kind, 'none', String(v)); assert.equal(m.thumbUrl, null); assert.equal(m.videoUrl, null);
  }
});

test('classifyMedia: the Final Edit\'s own format decides the icon and play overlay for placeholders', () => {
  assert.equal(UX.classifyMedia('', 'static').format, 'static');
  assert.equal(UX.classifyMedia('', 'carousel').format, 'carousel');
  assert.equal(UX.classifyMedia('', 'anything-else').format, 'video');
  assert.equal(UX.classifyMedia('https://drive.google.com/x', 'static').isVideo, false);
});

// ── markup helpers ─────────────────────────────────────────────────────────────
test('mediaThumbHtml: renders an <img>/<video>/placeholder per kind, and escapes hostile links', () => {
  assert.match(UX.mediaThumbHtml('https://youtu.be/dQw4w9WgXcQ', 'video'), /<img src="https:\/\/img\.youtube\.com\/vi\/dQw4w9WgXcQ\/hqdefault\.jpg"[^>]*>.*ux-play/s);
  const vid = UX.mediaThumbHtml('https://cdn.x.com/a.mp4', 'video');
  assert.match(vid, /<video src="https:\/\/cdn\.x\.com\/a\.mp4#t=0\.1" preload="metadata" muted/); assert.match(vid, /ux-play/);
  assert.doesNotMatch(vid, /autoplay/, 'previews never autoplay');
  const still = UX.mediaThumbHtml('https://cdn.x.com/a.png', 'static');
  assert.match(still, /<img src="https:\/\/cdn\.x\.com\/a\.png"/); assert.doesNotMatch(still, /ux-play/);
  const none = UX.mediaThumbHtml('', 'video');
  assert.doesNotMatch(none, /<img|<video/); assert.match(none, /no link yet/); assert.match(none, /data-media-kind="none"/);
  const drive = UX.mediaThumbHtml('https://drive.google.com/file/d/1', 'video');
  assert.doesNotMatch(drive, /<img|<video/); assert.match(drive, /Google Drive/);
  const evil = UX.mediaThumbHtml('https://cdn.x.com/a.png?"><script>alert(1)</script>', 'static', { label: '"><b>x' });
  assert.doesNotMatch(evil, /<script>|<b>x/); assert.match(evil, /&quot;&gt;&lt;script&gt;/);
});

test('mediaThumbHtml: sizes are limited to sm/md/lg and a failed load falls back to the placeholder', () => {
  assert.match(UX.mediaThumbHtml('', 'video', { size: 'lg' }), /ux-media-lg/);
  assert.match(UX.mediaThumbHtml('', 'video', { size: 'huge' }), /ux-media-md/);
  assert.match(UX.mediaThumbHtml('https://youtu.be/dQw4w9WgXcQ', 'video'), /onerror="UX\.mediaFailed\(this\)"/);
});

test('productThumbHtml / statTilesHtml / badgeHtml / emptyStateHtml / pageHeaderHtml escape their content', () => {
  assert.match(UX.productThumbHtml('https://x.com/p.jpg"><i>'), /&quot;&gt;&lt;i&gt;/);
  assert.match(UX.productThumbHtml(null), /ux-media-ph-icon/); assert.doesNotMatch(UX.productThumbHtml(null), /<img/);
  assert.match(UX.statTilesHtml([{ label: '<b>L</b>', value: 3, tone: 'green' }]), /&lt;b&gt;L&lt;\/b&gt;.*|ux-stat-green/s);
  assert.match(UX.badgeHtml('<x>', 'purple'), /ux-badge-purple">&lt;x&gt;/);
  assert.match(UX.emptyStateHtml('Nothing', 'hint'), /ux-empty-title">Nothing<.*ux-empty-hint">hint/s);
  assert.match(UX.pageHeaderHtml('T', 'D', '<button>a</button>'), /<h1 class="ux-page-title">T<\/h1><p class="ux-page-desc">D<\/p>.*<button>a<\/button>/s);
  assert.match(UX.progressBarHtml(250), /aria-valuenow="100"/); assert.match(UX.progressBarHtml(-5), /aria-valuenow="0"/);
});

// ── dashboard workflow counts ──────────────────────────────────────────────────
test('loadWorkflowCounts maps the stage queries to the dashboard shape without touching any other data', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (/GROUP BY ca\.concept_dev_status/.test(sql)) return { rows: [{ s: 'not_started', n: 2 }, { s: 'in_development', n: 1 }, { s: 'changes_required', n: 1 }, { s: 'ready_for_review', n: 4 }] };
    if (/status IN \('unscheduled', 'scheduled'\)/.test(sql) && /COUNT\(\*\)::int AS n FROM shoot_schedule ss\s+JOIN/.test(sql) && !/scheduled_day IS NOT NULL/.test(sql)) return { rows: [{ n: 5 }] };
    if (/scheduled_day IS NOT NULL/.test(sql)) return { rows: [{ n: 2 }] };
    return { rows: [{ editing: 6, editing_stale: 3, approval: 4, approval_stale: 1 }] };
  } };
  const out = await loadWorkflowCounts(pool, '2026-10-12', '2026-10-14');
  assert.deepEqual(out, {
    week_start: '2026-10-12', concept_development: 4, tuesday_review: 4, shooting: 5, editing: 6, final_approval: 4,
    attention: { concepts_awaiting_review: 4, overdue_shoots: 2, editing_backlog: 3, editing_backlog_days: 2, awaiting_approval: 4, awaiting_approval_stale: 1 },
  });
  assert.ok(calls.every((c) => /^\s*SELECT/i.test(c.sql)), 'read-only: SELECT statements only');
  assert.ok(!calls.some((c) => /\b(INSERT|UPDATE|DELETE)\b/i.test(c.sql)));
  assert.ok(calls.some((c) => c.params && c.params.includes('2026-10-14')), 'overdue is measured against today');
});

test('localDateStr formats a local date as YYYY-MM-DD', () => {
  assert.equal(localDateStr(new Date(2026, 9, 5)), '2026-10-05');
});

test('the dashboard route keeps every legacy block and adds only the workflow block', () => {
  const route = read('src/routes/dashboard.js');
  for (const k of ['current:', 'pipeline:', 'health:', 'week:', 'workflow']) assert.ok(route.includes(k), k);
  assert.match(route, /const WEEKLY_TARGET = 30;/, 'sample target constants untouched');
  assert.match(route, /require\('\.\.\/lib\/dashboardWorkflow'\)/);
});

// dashboardAttentionItems is plain JS in app.js; evaluate just that function.
function attentionFn() {
  const src = app.slice(app.indexOf('function dashPlural'), app.indexOf('function renderDashboardWeekCard'));
  return new Function(`${src}; return dashboardAttentionItems;`)();
}
test('Needs Attention only returns the alerts that currently apply', () => {
  const f = attentionFn();
  assert.deepEqual(f({ attention: { concepts_awaiting_review: 0, overdue_shoots: 0, editing_backlog: 0, awaiting_approval: 0 } }), []);
  assert.deepEqual(f(undefined), []);
  const all = f({ attention: { concepts_awaiting_review: 1, overdue_shoots: 2, editing_backlog: 3, editing_backlog_days: 2, awaiting_approval: 4, awaiting_approval_stale: 1 } });
  assert.deepEqual(all.map((a) => a.tab), ['tuesday-review', 'shooting', 'editing', 'final-approval']);
  assert.match(all[0].text, /^1 concept waiting for review$/);
  assert.match(all[1].text, /^2 shoots past the scheduled day$/);
  assert.match(all[2].text, /^3 shot concepts waiting over 2 days for editing$/);
  assert.match(all[3].text, /^4 creatives awaiting final approval \(1 waiting over 24h\)$/);
  assert.deepEqual(f({ attention: { overdue_shoots: 1 } }).map((a) => a.tab), ['shooting']);
});

// ── static guarantees ──────────────────────────────────────────────────────────
function fnSource(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  let depth = 0; let i = app.indexOf('{', start);
  for (; i < app.length; i++) { if (app[i] === '{') depth++; else if (app[i] === '}') { depth--; if (!depth) break; } }
  return app.slice(start, i + 1);
}

test('Final Approval and Ad Setup thumbnails prefer the Final Edit creative; a product image is only a labelled fallback (never the other way round)', () => {
  for (const fn of ['finalApprovalVersions', 'finalApprovalMediaStripHtml', 'finalApprovalCardHtml', 'adSetupMediaHtml', 'adSetupCardHtml', 'adSetupApprovedCardHtml']) {
    const body = fnSource(fn);
    assert.doesNotMatch(body, /productThumbHtml|high-stock-thumb/, `${fn} must not render the product catalogue image as the creative`);
  }
  assert.match(fnSource('finalApprovalMediaStripHtml'), /UX\.creativeThumbHtml\(v\.final_edit_link, v\.format, productImage/);
  assert.match(fnSource('adSetupMediaHtml'), /UX\.creativeThumbHtml\(item\.final_edit_link/);
  const modal = fnSource('renderFinalApprovalModal');
  assert.match(modal, /UX\.mediaThumbHtml/); assert.doesNotMatch(modal, /image_url/);
  // the helper itself: creative first, tagged product fallback, neutral placeholder
  const uxSrc = read('public/ux.js');
  assert.match(uxSrc, /function creativeThumbHtml/);
  assert.match(uxSrc, /Product image/);
});

test('the Final Approval queue returns every active version, additively', () => {
  const route = read('src/routes/finalApproval.js');
  assert.match(route, /attachFinalEdits/); assert.match(route, /is_active = true ORDER BY created_at ASC, id ASC/);
  assert.match(route, /fe\.final_edit_link, fe\.editor/, 'the original single-edit fields are still selected');
});

test('every id the production-page handlers and earlier journeys rely on survived the redesign', () => {
  const ids = [
    'cd-week-prev', 'cd-week-label', 'cd-week-next', 'cd-week-status', 'cd-this-week-btn', 'cd-week-picker', 'concept-dev-list',
    'tr-week-prev', 'tr-week-label', 'tr-week-next', 'tr-this-week-btn', 'tr-week-picker', 'tr-summary', 'tr-filters', 'tr-list',
    'shoot-subnav', 'shoot-week-prev', 'shoot-week-label', 'shoot-week-next', 'shoot-this-week-btn', 'shoot-week-picker', 'shoot-week-owner-filter', 'shoot-week-summary', 'shoot-week-progress-bar', 'shoot-week-progress-fill', 'shoot-unscheduled', 'shoot-week-grid', 'shoot-today-title', 'shoot-today-owner-filter', 'shoot-today-summary', 'shoot-today-list', 'shoot-history-list',
    'editing-subnav', 'editing-controls-row', 'editing-week-nav', 'editing-week-prev', 'editing-week-label', 'editing-week-next', 'editing-this-week-btn', 'editing-week-picker', 'editing-editor-filter', 'editing-summary', 'editing-unscheduled', 'editing-week-grid', 'editing-today-title', 'editing-today-list', 'editing-history-list',
    'fa-count-ready', 'fa-count-ad-setup', 'fa-count-approved', 'fa-panel-ready', 'fa-panel-ad-setup', 'fa-panel-approved', 'final-approval-summary', 'final-approval-list', 'ad-setup-summary', 'ad-setup-list', 'ad-setup-approved-summary', 'ad-setup-approved-list',
    'final-approval-modal-body', 'final-approval-feedback-input', 'final-approval-request-changes-btn', 'final-approval-approve-btn', 'final-approval-close-btn', 'final-approval-move-back-btn',
    'ad-setup-modal-body', 'ad-setup-move-back-btn', 'ad-setup-save-btn', 'ad-setup-approve-btn',
    'adhoc-concept-name', 'adhoc-concept-style-search', 'adhoc-concept-style-results', 'adhoc-concept-style-chips', 'adhoc-concept-format',
    'week-prev', 'week-current', 'week-next', 'hero-week-title', 'hero-week-dates', 'pipeline-live-note', 'action-pipeline', 'action-brief-builder', 'action-library',
    'planning-week-prev', 'planning-week-label', 'planning-week-next', 'planning-week-status', 'planning-this-week-btn', 'planning-week-picker', 'shoot-plan-progress', 'shoot-plan-grouped', 'shoot-plan-confirm-btn',
  ];
  const missing = ids.filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
  // the concept editor keeps every field it had
  const editorFields = ['cd-modal-name', 'cd-modal-angle', 'cd-modal-concept-type-select', 'cd-modal-assignee-select', 'cd-modal-avatar-select', 'cd-modal-avatar-custom-desc', 'cd-modal-hooks-list', 'cd-modal-styles-search', 'cd-modal-shots-list', 'cd-modal-script', 'cd-modal-execution', 'cd-modal-references-list', 'cd-modal-reference-paste-url', 'cd-modal-talent-select', 'cd-modal-props', 'cd-modal-delete-btn', 'cd-modal-save-draft-btn', 'cd-modal-save-changes-btn', 'cd-modal-submit-btn'];
  assert.deepEqual(editorFields.filter((id) => !html.includes(`id="${id}"`)), []);
});

test('Concept editor sections follow the requested order and the footer keeps its actions', () => {
  const modal = html.slice(html.indexOf('<div id="concept-dev-modal"'), html.indexOf('<div id="promo-concept-dev-modal"'));
  const order = ['>The Idea<', '>Audience<', '>The Hook<', '>Production Requirements<', '>References<', '>Shoot Setup<'].map((t) => modal.indexOf(`class="cd-modal-section-title">${t.slice(1)}`.replace('<', '<')));
  const idx = ['The Idea', 'Audience', 'The Hook', 'Production Requirements', 'References', 'Shoot Setup'].map((t) => modal.indexOf(`cd-modal-section-title">${t}`));
  assert.ok(idx.every((i) => i > 0), JSON.stringify(idx));
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'sections are in the requested order');
  const footer = modal.slice(modal.indexOf('<div class="modal-footer">'));
  const labels = [...footer.matchAll(/<button[^>]*>([^<]*)</g)].map((m) => m[1].trim());
  assert.deepEqual(labels.slice(0, 4), ['Delete', 'Cancel', 'Save Draft', 'Save Changes']);
  assert.match(css, /\.cd-modal-workspace \.modal-footer\{position:sticky;bottom:0/);
  void order;
});

test('Ad Setup: sections, footer order and the naming logic are as specified (the generated-name panel is gone, the logic is not)', () => {
  const body = fnSource('renderAdSetupModal');
  const titles = [...body.matchAll(/as-section-title">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(titles.slice(0, 2), ['Ad details', 'Creative naming']);
  assert.ok(!titles.includes('Generated Meta name'), 'the large Generated Meta name panel is removed');
  assert.match(fnSource('copyAdSetupName'), /buildMetaAdNamePreviewClient/, 'the name can still be copied');
  const footer = html.slice(html.indexOf('id="ad-setup-modal-footer"'));
  const labels = [...footer.slice(0, footer.indexOf('</div>')).matchAll(/<button[^>]*>([^<]*)</g)].map((m) => m[1].replace(/&[a-z]+;/g, '').trim());
  assert.deepEqual(labels, ['Move Back', 'Close', 'Save Draft', 'Approve Ad Setup']);
  const naming = read('src/lib/adSetupNaming.js');
  assert.match(fnSource('buildMetaAdNamePreviewClient'), /segs\.push\(d\.url_link_page \? \(URL_LINK_PAGE_LABELS\[d\.url_link_page\] \|\| d\.url_link_page\) : '\*'\)/);
  assert.ok(naming.includes('buildMetaAdName'));
});

test('no blue accent is introduced by the new design system block', () => {
  const block = css.slice(css.indexOf('Batch 34: shared production-workflow design system'));
  assert.doesNotMatch(block, /var\(--blue|#2563eb|#3b82f6|#1d4ed8|#dbeafe/i);
});

test('the version history records this change as one release', () => {
  const v = JSON.parse(read('version-history.json'));
  const entry = v.entries.find((e) => e.version === '1.2.8');
  assert.ok(entry, '1.2.8 is recorded');
  assert.match(entry.title, /Production workflow redesign/);
  // package.json agreeing with the newest history entry is asserted by test/version.test.js
});
