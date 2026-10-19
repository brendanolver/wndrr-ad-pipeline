'use strict';
// Core Shoot Planning (Core Catalogue): the category row's Creative Attention / Creative Freshness / This Week's Shoot badges. The functions are taken straight from app.js; the counts they
// read (needs / review / stale / assessed / latestDays / oldestDays) are the existing engine results, so only the display rules are tested here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const pl = fs.readFileSync(path.join(__dirname, '..', 'public', 'planning.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const block = app.slice(app.indexOf('const CORE_BADGE_ICON'), app.indexOf('function coreShootCategoryRowHtml'));
const escapeHtml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const { attention, freshness, selected } = new Function('escapeHtml', `${block}; return { attention: coreCategoryAttentionHtml, freshness: coreCategoryFreshnessHtml, selected: coreSelectedHtml };`)(escapeHtml);
const text = (h) => h.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const eng = (o) => ({ matched: 3, needs: 0, high: 0, review: 0, stale: 0, assessed: 3, latestDays: 12, oldestDays: 49, ...o });

test('Creative Attention: red "N need creative", green "Covered", awaiting review as muted secondary text', () => {
  const need = attention({ eng: eng({ needs: 5, review: 1, high: 2 }) });
  assert.equal(text(need), '5 need creative 1 awaiting review'); assert.match(need, /data-tone="red"/); assert.match(need, /core-cell-sub">1 awaiting review/); assert.match(need, /title="2 High priority"/);
  const cov = attention({ eng: eng() }); assert.equal(text(cov), 'Covered'); assert.match(cov, /data-tone="green"/);
  const covReview = attention({ eng: eng({ review: 1 }) }); assert.equal(text(covReview), 'Covered 1 awaiting review');
  assert.equal(text(attention({ eng: eng({ matched: 2, review: 2 }) })), 'Awaiting review', 'when nothing is assessed it is not "Covered"');
  assert.match(attention({ eng: eng({ matched: 0 }) }), /Not assessed/);
  assert.equal(text(attention({ eng: null, needsAttention: 3 })), '3 need creative', 'the older flag count while the Core table is not loaded');
  assert.equal(attention({ eng: null, needsAttention: 0 }), '');
});

test('Creative Freshness: amber "N Need Refresh" with the oldest product\'s age; green "Up to Date" only when every product is assessed and none needs refreshing; otherwise neutral "Not Assessed"', () => {
  const stale = freshness({ total: 6, eng: eng({ stale: 2, oldestDays: 49, assessed: 6 }) });
  assert.equal(text(stale), '2 Need Refresh Oldest product: 49 days'); assert.doesNotMatch(stale, /stale/i, 'the word Stale is replaced'); assert.match(stale, /data-tone="amber"/);
  const ok = freshness({ total: 3, eng: eng({ stale: 0, assessed: 3, latestDays: 12 }) });
  assert.equal(text(ok), 'Up to Date Latest creative: 12 days ago'); assert.match(ok, /data-tone="green"/);
  const partial = freshness({ total: 5, eng: eng({ stale: 0, assessed: 3 }) });
  assert.equal(text(partial), 'Not Assessed 3 of 5 products assessed'); assert.match(partial, /data-tone="neutral"/); assert.doesNotMatch(partial, /Up to Date/, 'too little data is never "Up to Date"');
  const none = freshness({ total: 2, eng: eng({ stale: 0, assessed: 0, latestDays: null }) });
  assert.equal(text(none), 'Not Assessed'); assert.doesNotMatch(none, /Up to Date/);
  assert.equal(text(freshness({ total: 1, eng: eng({ stale: 0, assessed: 1, latestDays: 0 }) })), 'Up to Date Latest creative: today');
  assert.equal(text(freshness({ total: 1, eng: eng({ stale: 1, oldestDays: 1, assessed: 1 }) })), '1 Need Refresh Oldest product: 1 day');
  assert.equal(text(freshness({ total: 1, eng: eng({ stale: 1, oldestDays: null, assessed: 1 }) })), '1 Need Refresh', 'no secondary line without a reliable date');
  assert.equal(text(freshness({ eng: null, stale: 2 })), '2 Need Refresh');
});

test('Attention and Freshness are independent: a Covered category can hold stale creative', () => {
  const e = eng({ needs: 0, stale: 2, assessed: 3, oldestDays: 71 });
  assert.equal(text(attention({ eng: e })), 'Covered'); assert.equal(text(freshness({ total: 3, eng: e })), '2 Need Refresh Oldest product: 71 days');
});

test("This Week's Shoot: a green \"N Selected\" badge, else a grey dash", () => {
  assert.equal(text(selected(1)), '1 Selected'); assert.match(selected(2), /data-tone="green"/);
  assert.match(selected(0), /core-dash/); assert.equal(text(selected(0)), '&mdash;');
});

test('the existing counts and thresholds are untouched; only extra counters were added to the category stats', () => {
  const stats = pl.slice(pl.indexOf('function plCatalogueStats'), pl.indexOf('function plCatalogueAttentionHtml'));
  assert.match(stats, /info\.cat === 'needs'/); assert.match(stats, /info\.band\.key === 'stale'/); assert.match(stats, /seen\.has\(info\.it\.key\)/);
  assert.match(stats, /out\.assessed \+= 1/); assert.match(stats, /info\.cov\.latestKnown/);
  assert.doesNotMatch(block, /recent_creative_days|stale_creative_days|>= *90|< *30/, 'no new freshness thresholds');
});

test('header and styling', () => {
  const head = html.slice(html.indexOf('core-shoot-category-header'), html.indexOf('id="core-shoot-planning-list"'));
  assert.match(head, /This Week's/); assert.equal((head.match(/class="core-info"/g) || []).length, 3, 'tooltip icons on the three right-hand columns');
  assert.match(css, /\.core-badge\[data-tone="red"\]\{background:#fdeceb/); assert.match(css, /\.core-badge\[data-tone="green"\]\{background:#e8f5ee/); assert.match(css, /\.core-badge\[data-tone="amber"\]\{background:#fff3df/);
  assert.match(css, /\.core-cell-sub\{[^}]*font-size:11\.5px[^}]*color:var\(--text-muted\)/, 'secondary information is smaller and muted');
  assert.doesNotMatch(app.slice(app.indexOf('function coreShootCategoryRowHtml'), app.indexOf('function renderCoreStepFooter')), /background/, 'rows are not highlighted');
});

test('wording never claims "new concept": freshness is the age of the newest creative, shown as such', () => {
  const fresh = block.slice(block.indexOf('function coreCategoryFreshnessHtml'), block.indexOf('const coreSelectedHtml'));
  assert.doesNotMatch(fresh, /concept/i);
  assert.match(fresh, /Oldest product: /); assert.match(fresh, /Latest creative: /);
  const band = pl.slice(pl.indexOf('function plFreshBand'), pl.indexOf('function plCatalogueMap'));
  assert.match(band, /label: 'Needs refresh'/, 'the product-level chip says Needs refresh as well');
  assert.doesNotMatch(band, /label: 'Stale'/);
});
