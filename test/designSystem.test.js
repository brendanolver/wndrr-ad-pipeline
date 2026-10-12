// Batch 12 DESIGN checks that need no browser: the token layer, no teal, the shared components, the Meta Performance metric cells, and the wiring of the
// Weekly Plan script. (The rendered result, contrast and overflow are covered by the browser suite b12-design; the behaviour by b12-ui.)
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const css = read('public/styles.css');
const html = read('public/index.html');
const app = read('public/app.js');
const wp = read('public/weekly-plan.js');

test('design tokens: one :root layer for colour, spacing, type, radius, elevation and focus', () => {
  const root = css.slice(css.indexOf(':root {'), css.indexOf('*{margin:0'));
  for (const t of ['--sidebar', '--primary', '--primary-hover', '--accent', '--accent-soft', '--accent-text', '--bg', '--surface', '--border', '--text', '--focus-ring', '--sp-1', '--sp-4', '--fs-md', '--r', '--r-lg', '--shadow']) {
    assert.ok(root.includes(`${t}:`), `${t} is defined`);
  }
  assert.match(root, /--sidebar: var\(--ds-navy-900\)/, 'dark navy sidebar');
  assert.match(root, /--primary: var\(--ds-navy-800\)/, 'navy primary');
  assert.match(root, /--bg: #f7f7fa/i, 'off-white page');
  assert.match(root, /--surface: #ffffff/i, 'white cards');
});

test('teal is gone: no teal token, no teal class, no teal reference in styles, scripts or markup', () => {
  assert.doesNotMatch(css, /var\(--teal|--teal[a-z-]*:/);
  assert.doesNotMatch(css, /#0ea5a0|#0c8f8a|#e6f7f7/i);
  assert.doesNotMatch(html, /action-teal/);
  assert.doesNotMatch(app, /var\(--teal/);
  assert.doesNotMatch(wp, /teal/i);
});

test('active states are soft purple tints, not heavy solid fills (tabs, pills, steps, sidebar)', () => {
  const ds = css.slice(css.indexOf('WNDRR DESIGN SYSTEM -- shared components'));
  assert.match(ds, /\.planning-step-btn\.active[^{]*\{[^}]*background:var\(--accent-soft\)[^}]*color:var\(--accent-text\)/);
  assert.match(ds, /\.sidebar-nav \.tab-btn\.active[^{]*\{background:var\(--sidebar-active\)/);
  assert.match(ds, /:focus-visible\{[^}]*box-shadow:var\(--focus-ring\)/, 'a visible keyboard focus ring');
  assert.match(ds, /\.btn-primary\{background:var\(--primary\)/);
});

test('Meta Performance: coloured RECTANGLES replace the dots in the table, with symbol + spoken text, and the benchmark logic is untouched', () => {
  const fn = app.slice(app.indexOf('function mpRenderAds'), app.indexOf('async function loadMetaPerformanceAds'));
  assert.match(fn, /mp-metric mp-metric-\$\{escapeHtml\(h\)\}/);
  assert.match(fn, /data-band=/);
  assert.doesNotMatch(fn, /class="mp-health/, 'no dot in the rows');
  assert.match(fn, /metric\(a\.cpa_health, mpFmt\(a\.cpa, 'money'\)\)/);
  assert.match(fn, /metric\(a\.frequency_health/);
  assert.match(fn, /metric\(a\.reach_health/);
  assert.match(css, /\.mp-metric\[data-health\]::before/);
  assert.match(css, /\.mp-metric\[data-band\]::after\{content:' \(' attr\(data-band\) '\)'/, 'meaning is announced by screen readers');
  // the colour bands themselves still come from the server (metaFunnelHealth); nothing in the front end recomputes a benchmark
  assert.doesNotMatch(fn, /<= ?60|<= ?72|> ?2\.4/);
  const guide = app.slice(app.indexOf('mp-health-guide'), app.indexOf('mp-health-guide') + 400);
  assert.match(guide, /What the colours mean/);
});

test('Weekly Plan wiring: script loaded after app.js, first planning step, modal fields, settings fields, shoot plan hooks', () => {
  assert.ok(html.indexOf('<script src="app.js"></script>') < html.indexOf('<script src="weekly-plan.js"></script>'));
  assert.match(html, /<button type="button" class="planning-step-btn active" data-step="weekly">Weekly Plan<\/button>/);
  for (const id of ['planning-production-header', 'planning-step-weekly', 'weekly-plan', 'shoot-plan-videos', 'shoot-plan-mix', 'shoot-plan-recommendation', 'shoot-plan-videos-modal', 'weekly-video-target-input', 'season-immediate-days-input', 'season-secondary-days-input', 'wpc-groups', 'lo-list', 'po-videos']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} exists`);
  }
  assert.match(app, /const PLANNING_STEPS = \['weekly', 'core', 'high-stocks', 'shoot-plan'\]/);
  assert.match(app, /wpPrepareShootModal\(preset\)/);
  assert.match(app, /wpShootPayloadExtras\(shootPlanModalContext\)/);
  assert.match(app, /wpShootPlanVideosHtml\(item, readOnly\)/);
  assert.match(app, /loadWeeklyVideoPlan\(\)/);
  assert.match(app, /cpHeadlineBadgeHtml\(c, priority\)/, 'Core cards show ONE headline priority');
  assert.doesNotMatch(app.slice(app.indexOf('function cpCardHtml'), app.indexOf('// The full card (explanation')), /planLevelBadge/, 'the competing "n priority" label is no longer on the card');
});

test('the Weekly Plan only creates production records through the existing explicit Shoot Plan action', () => {
  // the Weekly Plan script never POSTs a shoot plan item itself: it opens the modal, whose Save button is the existing explicit action
  assert.doesNotMatch(wp, /api\('\/shoot-plan', \{ method: 'POST'/);
  assert.match(wp, /openShootPlanModal\(/);
  assert.doesNotMatch(wp, /weekly-shoot-plan-confirmation/, 'it never confirms (sends) the Monday plan');
});
