'use strict';
// Planning (Batch 14, redesigned in Batch 28): Core -> High Stocks -> Shoot Plan (chosen from the sidebar), with a weekly CONCEPT target.
//   * Core and High Stocks list OPPORTUNITIES: products that genuinely need new creative this week, each with the reason, the numbers behind it and the creative
//     already tested / planned (data: GET /api/opportunities, see src/lib/planningOpportunities.js). They recommend; they commit nothing.
//   * The Shoot Plan is where the team commits: choosing a product opens the existing "Shoot This Week" modal with the reason preserved, and the concepts started
//     become ordinary Concept Development records.
//   * The concept progress strip counts DISTINCT concepts planned / awaiting production / filmed / edited / approved / uploaded against the weekly target
//     (GET /api/shoot-plan/progress). A concept adapted for several products counts once.
// Loaded after app.js (shares its globals: state, api, apiAllowedOr, toast, escapeHtml, openShootPlanModal, openModal ...). Nothing here writes a production record
// by itself: only the modal's own Save does.


state.opportunities = null;
state.opportunitiesError = null;
state.conceptProgress = null;
// which category tab each page shows (needs | covered | review): the engine's statuses are grouped into three visible categories, the rest are hidden, see planningExplain.js
state.oppView = { core: 'needs', high: 'needs' };
state.oppOpen = {};
state.oppEvidence = {};
state.oppQuery = { core: '', high: '' };
const PE = window.PlanningExplain; // wording + status categories (pure, unit-tested): public/planningExplain.js

const plEsc = (v) => escapeHtml(v === null || v === undefined ? '' : String(v));
const plPlural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
const plNum = (v) => Number(v || 0).toLocaleString('en-AU');
const plReadOnly = () => state.planningWeekOffset < 0;
const wpEsc = plEsc; // (the settings code below keeps its older helper name)

let plSeq = 0;
async function plLoadOpportunities(fresh) {
  const seq = ++plSeq;
  try {
    const data = await apiAllowedOr(`/opportunities${fresh ? '?fresh=1' : ''}`, null);
    if (seq !== plSeq) return;
    state.opportunities = data;
    state.opportunitiesError = null;
  } catch (e) {
    if (seq !== plSeq) return;
    state.opportunitiesError = e.message;
  }
  try { plRenderCore(); plRenderHighStocks(); } catch (e) { console.error('opportunity render failed', e); }
  try { if (typeof renderCoreShootPlanning === 'function' && Array.isArray(state.coreProducts)) renderCoreShootPlanning(); } catch (e) { console.error('core catalogue render failed', e); } // its Attention / Freshness come from the same results
  try { plRenderSettingsInfo(); } catch (e) { console.error('planning settings info failed', e); }
  try { if (typeof renderShootPlanStep === 'function' && Array.isArray(state.shootPlan)) renderShootPlanStep(); } catch (e) { console.error('shoot plan stock warnings failed', e); } // the stock warnings on planned work follow the latest assessment
  try { renderProductionHeader(); } catch (e) { /* header is optional */ }
}

let plProgSeq = 0;
async function plLoadProgress() {
  const seq = ++plProgSeq;
  try {
    const p = await apiAllowedOr(`/shoot-plan/progress?week_start=${planningWeekStart()}`, null);
    if (seq !== plProgSeq) return;
    state.conceptProgress = p;
  } catch (e) { if (seq !== plProgSeq) return; state.conceptProgress = null; }
  try { renderProductionHeader(); if (typeof renderShootPlanStep === 'function') renderShootPlanStep(); } catch (e) { console.error('progress render failed', e); }
}
// the old name the rest of the app calls after any change: refresh both
function loadWeeklyVideoPlan(fresh) { plLoadProgress(); plLoadOpportunities(!!fresh); }

// ── concept progress strip (top of Planning) ─────────────────────────────────────────
const PL_STAGE_ORDER = ['planned', 'awaiting_production', 'filmed', 'edited', 'approved', 'uploaded'];
const PL_STAGE_LABEL = { planned: 'Planned', awaiting_production: 'Awaiting production', filmed: 'Filmed', edited: 'Edited', approved: 'Approved', uploaded: 'Uploaded' };

function plStageChips(counts, { compact } = {}) {
  return PL_STAGE_ORDER.map((k) => `<span class="pl-stage" data-stage="${k}" title="${plEsc(PL_STAGE_LABEL[k])}"><b>${counts ? (counts[k] || 0) : 0}</b><span>${plEsc(PL_STAGE_LABEL[k])}</span></span>`).join('');
}


// ── Batch 37: the Shoot Plan selection tray ─────────────────────────────────────────────────────────────────────────
// Products a person explicitly added to THIS planning week's Shoot Plan (shoot_plan_items; entries a Drops assignment created for Shooting are not selections).
// The tray sits directly under the Planning tabs on Core / High Stocks / Creative Insights, stays put while the page scrolls, and is hidden when nothing is selected.
// It replaces the old "This Week's Shoot Plan" panel (target bar, counters, carry-over line).
const plSelected = () => (state.shootPlan || []).filter((i) => !i.auto_linked);
const PL_TRAY_KEY = 'wndrr.planning.trayCollapsed';
const plTrayCollapsed = () => { try { return localStorage.getItem(PL_TRAY_KEY) === '1'; } catch (e) { return false; } };
function plToggleTray() { try { localStorage.setItem(PL_TRAY_KEY, plTrayCollapsed() ? '0' : '1'); } catch (e) { /* storage unavailable: the choice just is not remembered */ } renderProductionHeader(); }
const PL_TRAY_MAX = 5;
document.addEventListener('click', (ev) => {
  const x = ev.target.closest && ev.target.closest('[data-pl-tray-remove]');
  if (!x) return;
  ev.preventDefault(); ev.stopPropagation();
  removeShootPlanItem(Number(x.dataset.plTrayRemove));
});
const PL_CAMERA = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/></svg>';
function plTrayThumb(i) {
  // the same single-view picture logic as the Shoot Plan tiles (UX.garmentImgHtml): a labelled front picture, else the front half of the catalogue composite
  const img = i.image_url || ((i.styles || []).find((s) => s.image_url) || {}).image_url || '';
  // each thumbnail carries its own remove control (visible on hover / keyboard focus, always visible on touch screens); it uses the Shoot Plan's normal removal, so a product
  // whose concepts have work on them stays in the plan and the dialog says why (removeShootPlanItem)
  const nm = plEsc(i.product_name || 'this product');
  return `<span class="pl-tray-item"><span class="pl-tray-th" title="${nm}" data-pl-tray-item="${i.id}">${UX.garmentImgHtml({ url: img, front: i.front_image_url, category: i.category || i.product_name })}<span class="pl-tray-th-none" aria-hidden="true">${PL_NOIMG}</span><button type="button" class="pl-tray-x" data-pl-tray-remove="${i.id}" aria-label="Remove ${nm} from this week's Shoot Plan" title="Remove from plan"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></span><small class="pl-tray-cap" title="${nm}">${nm}</small></span>`;
}
function renderProductionHeader() {
  const el = document.getElementById('planning-production-header');
  if (!el) return;
  const items = plSelected();
  if (!items.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const collapsed = plTrayCollapsed();
  const more = items.length - PL_TRAY_MAX;
  const label = `${plPlural(items.length, 'product')} selected`;
  el.innerHTML = `<div class="pl-tray${collapsed ? ' collapsed' : ''}" role="region" aria-label="Shoot Plan selection" data-pl-tray data-count="${items.length}">
    <div class="pl-tray-id"><span class="pl-tray-ic">${PL_CAMERA}</span><span class="pl-tray-txt"><b>Shoot Plan</b><small data-pl-tray-count>${label}</small></span></div>
    ${collapsed ? '' : `<div class="pl-tray-thumbs" aria-label="Selected products">${items.slice(0, PL_TRAY_MAX).map(plTrayThumb).join('')}${more > 0 ? `<span class="pl-tray-more" title="${plEsc(items.slice(PL_TRAY_MAX).map((i) => i.product_name).filter(Boolean).join(', '))}">+${more}</span>` : ''}</div>`}
    <button type="button" class="btn btn-primary pl-tray-go" onclick="setPlanningStep('shoot-plan')">View Shoot Plan &rarr;</button>
    <button type="button" class="pl-tray-toggle" onclick="plToggleTray()" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${collapsed ? 'Expand' : 'Collapse'} the Shoot Plan selection" title="${collapsed ? 'Show products' : 'Hide products'}">${PL_ICON.chev}</button>
  </div>`;
}

// ── opportunity tables: Core and High Stocks share ONE interface (summary, compact filters, prioritised table, expandable explanation, Add to Shoot Plan) ──────────────
// One row per product, one primary recommendation each (the server picks it: src/lib/planningPrimary.js). The page shows five columns; everything else (Meta metrics, scoring,
// matching confidence, data sources) lives one click down under "View detailed evidence". Wording comes from PlanningExplain (pure, tested), never from a hardcoded list.
state.oppSort = { core: null, high: null };
state.oppFilter = { core: { priority: '', type: '' }, high: { priority: '', type: '' } };
state.oppLimit = { core: 50, high: 50 };
const PL_PAGE = 50;
const PL_MODE_NAME = { core: 'Core', high: 'High Stocks' };
const PL_PRIO_ORDER = { High: 3, Medium: 2, Low: 1 };
const plChip = (text, cls, title) => `<span class="pl-chip${cls ? ` ${cls}` : ''}"${title ? ` title="${plEsc(title)}"` : ''}>${plEsc(text)}</span>`;

function plAgeStamp(iso) {
  const t = Date.parse(iso); if (!Number.isFinite(t)) return 'unknown';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago`;
}
const plFn = (f) => ({ multiple: 'Mixed', unknown: 'Unknown' }[f] || f || 'Unknown'); // campaign taxonomy labels: TOF / TOM / MOF, 'multiple' (several tokens) and 'unknown' (none) exactly as Meta Performance reports them
const plStateWord = (s) => ({ performing: 'performing', underperforming: 'over the approved limit', declining: 'fatigue', unrated: 'no approved benchmark', insufficient: 'insufficient delivery', unavailable: 'no delivery' }[s] || s || '');
const plNone = '<span class="pt-na">&ndash;</span>';
const plCfg = () => (state.opportunities && state.opportunities.config) || {};
const plData = (mode) => (mode === 'core' ? state.opportunities.core : state.opportunities.high_stocks);
const plMomentum = (mode) => PE.momentumItemsFor(mode, plData(mode), state.opportunities.momentum);

// ── rows (Batch 32): PRODUCT | KEY METRICS | CREATIVE STATUS | PRIORITY | ACTION ──
// Wording comes from PlanningExplain.creativeStatus (the engine's own result, never a new classification); the numbers are the existing facts.
const plThumb = (url, cls = '') => (url ? `<img${cls ? ` class="${cls}"` : ''} src="${plEsc(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : '');
function plPrioTitle(it) {
  // the SAME evidence the engine scored: the biggest score parts, then every cap that held the priority back (so a badge and its tooltip can never disagree)
  const parts = (it.score_parts || []).filter((p) => p.points > 0).sort((a, b) => b.points - a.points).slice(0, 3).map((p) => `${p.label} (+${p.points})`);
  return `Score ${it.score} of 100.${parts.length ? ` Main reasons: ${parts.join('; ')}.` : ''}${(it.caps || []).length ? ` ${it.caps.join(' ')}` : ''}`;
}
function plPrioCell(it) {
  return `<td class="pt-prio">${it.actionable && it.priority ? `<span class="opp-priority" data-priority="${plEsc(it.priority)}" title="${plEsc(plPrioTitle(it))}">${plEsc(it.priority)}</span>` : plNone}</td>`;
}
// sorting (the header buttons and the Sort menu use these): the table shows one KEY METRICS column, so the metrics sort from the menu
const PL_SORTS = {
  product: { label: 'Product (A to Z)', get: (i) => String(i.name).toLowerCase(), dir: 'asc' },
  priority: { label: 'Priority', get: (i) => (i.actionable ? PL_PRIO_ORDER[i.priority] * 1000 + i.score : -1), only: 'needs', dir: 'desc' },
  u30: { label: 'Sales 30D', get: (i) => (i.facts || {}).units30, dir: 'desc' },
  stock: { label: 'Stock on hand', get: (i) => (i.facts || {}).stock_units, dir: 'desc' },
  live: { label: 'Live ads', get: (i) => { const n = (i.facts || {}).live_creatives; return n === null || n === undefined ? -1 : n; }, dir: 'desc' },
};
const plSortsFor = (cat) => Object.entries(PL_SORTS).filter(([, v]) => !v.only || v.only === cat);

const plList = (arr) => `<ul>${arr.filter(Boolean).map((x) => `<li>${plEsc(x)}</li>`).join('')}</ul>`;
// every distinct live creative of the product (one row per creative, however many campaigns run it)
// the original creative date written in the ad name (a creative made earlier and duplicated into another campaign keeps its original date); the first-delivery date is shown separately
function plCreativeDate(c) {
  const d = PE.creativeDate(c);
  return d.known ? `<b>${plEsc(d.long)}</b>${d.note ? `<small>${plEsc(d.note)}</small>` : ''}` : `${plNone}${d.note ? `<small>${plEsc(d.note)}</small>` : ''}`;
}
const PL_BLOCKED = ['not_launched', 'launch_unknown', 'unavailable'];
function plInThisWeeksPlan(it) {
  const codes = new Set((it.codes || []).concat(it.product_code ? [it.product_code] : []));
  return plSelected().some((s) => codes.has(s.product_code));
}

// ── filters, sort, rendering ──
// source for a page: the engine's own list, or (Opportunity = Protect Momentum) the recent-launch list that belongs on this page; then search / priority / opportunity filters

// ═══ Planning -> Core: a prioritised creative to-do list (table + a short decision panel). High Stocks keeps the layout above. Everything shown comes from the engine's own output. ═══
state.oppPick = {}; // product key -> the colourway style codes ticked for the Shoot Plan (absent = every colourway that can be shot)
const PL_SVG = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const PL_ICON = {
  target: PL_SVG('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>'),
  chart: PL_SVG('<path d="M5 20V11M12 20V5M19 20v-7"/>'),
  cube: PL_SVG('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>'),
  video: PL_SVG('<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10.5l5-3v9l-5-3"/>'),
  cal: PL_SVG('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>'),
  chev: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
};
const plPickedFor = (key) => (Array.isArray(state.oppPick[key]) ? state.oppPick[key] : null);
function plPickedCodes(it) {
  const viable = (it.colourways || []).filter((c) => c.viable).map((c) => c.style_code);
  const own = plPickedFor(it.key);
  return own ? own.filter((c) => viable.includes(c)) : viable;
}
function plCoreProductCell(it) {
  const notCore = it.mode === 'momentum' && !it.is_core ? '<small class="pt-class">Not Core: recent launch</small>' : '';
  const prod = PE.productionActivity(it, PL_STAGE_LABEL);
  const inProd = prod.active ? `<small class="pt-prod" title="${plEsc(prod.text)}">In production</small>` : '';
  return `<td class="pt-product"><div class="pt-pwrap"><span class="pt-thumb">${plThumb(it.image_url) || `<span class="pt-thumb-none">${PL_NOIMG}</span>`}</span><span class="pt-name"><b>${plEsc(it.name)}</b><small>${plEsc(it.category || '')}</small>${plCoreActiveAdsLine(it)}${notCore}${inProd}</span></div></td>`;
}
// the trend is shown the same way in the row and in the panel: colour only for rising / falling
function plTrendHtml(it, long) {
  const tr = PE.salesTrend(it);
  const k = tr.kind === 'up' || tr.kind === 'down' || tr.pct === 0;
  return `<span class="pl-trend" data-trend="${tr.kind}" title="${plEsc(tr.title)}">${tr.arrow ? `<i aria-hidden="true">${tr.arrow}</i> ` : ''}${plEsc(tr.text)}${k ? ` <span class="pl-trend-k">${long ? 'vs previous 7 days' : '7D'}</span>` : ''}</span>`;
}
function plCoreSalesCell(it) {
  const f = it.facts || {};
  const partial = f.demand_basis === 'since_launch' && f.days_on_sale ? ` <em>${f.days_on_sale}d on sale</em>` : '';
  return `<td class="pt-num pt-sales" title="${plEsc(((it.demand && it.demand.evidence) || []).join(' '))}"><b>${f.units30 === null || f.units30 === undefined ? plNone : plNum(f.units30)}</b><small>Sales 30D${partial}</small>${plTrendHtml(it, false)}</td>`;
}
function plCoreStockCell(it) {
  const f = it.facts || {}; const warn = PE.stockWarning(it);
  const cover = f.cover_weeks !== null && f.cover_weeks !== undefined ? `<small>${plEsc(f.cover_weeks)} weeks</small>` : '';
  return `<td class="pt-num pt-stock" title="${plEsc(it.stock && it.stock.notes ? it.stock.notes.join(' ') : 'Available sellable stock')}"><b>${f.stock_units === null || f.stock_units === undefined ? plNone : plNum(f.stock_units)}</b><small>In stock</small>${cover}${warn ? `<small class="pt-warn">${plEsc(warn)}</small>` : ''}</td>`;
}
// "Latest creative" column: the newest creative date written in the ad names (bold) and how long ago that was. Active Ads now sit under the product name (plCoreActiveAdsLine).
const plAgo = (d) => (d === null || d === undefined ? '' : d === 0 ? 'today' : `${d} ${d === 1 ? 'day' : 'days'} ago`);
function plCoreCoverageCell(it) {
  const c = PE.coverage(it, ((state.opportunities || {}).today || '').slice(0, 4));
  if (!c.known || c.latest === null) return `<td class="pt-num pt-cov" title="${plEsc(c.title)}"><b>${plNone}</b></td>`;
  const warn = c.uncertain ? ' <em class="pt-warn" aria-label="A creative without a valid date may be newer">?</em>' : '';
  const age = c.latestKnown && c.days !== null ? `<small>${plEsc(plAgo(c.days))}${warn}</small>` : (warn ? `<small>${warn}</small>` : '');
  return `<td class="pt-num pt-cov" title="${plEsc(c.title)}"><b class="pt-cov-d${c.latestKnown ? '' : ' none'}">${plEsc(c.latest)}</b>${age}</td>`;
}
// "N Active Ads" under the product name
function plCoreActiveAdsLine(it) {
  const c = PE.coverage(it, ((state.opportunities || {}).today || '').slice(0, 4));
  if (!c.known) return '';
  return `<small class="pt-active" title="${plEsc(c.title)}">${c.activeKnown ? plNum(c.active) : plNone} Active ${c.activeKnown && c.active === 1 ? 'Ad' : 'Ads'}</small>`;
}
// ── "Browse the full Core catalogue": the SAME engine results as the Core table above, per product and per category ───────────────────────────────────────────────────────────────
// Attention = the table's own status / category (needs creative | covered | needs review) and priority; Freshness = the table's "Latest creative" date, banded with the engine's own
// windows (recent_creative_days / stale_creative_days from the Planning settings); nothing here classifies a product itself. The catalogue (app.js) is keyed by product_code.
function plFreshBand(cov, cfg) {
  if (!cov || !cov.known || cov.latest === null) return null;
  if (!cov.latestKnown) return cov.latest === 'None' ? { key: 'stale', label: 'No creative' } : null; // "Unknown": creatives exist but no reliable date, so no band
  if (cov.days === null || cov.days === undefined) return null;
  const recent = Number(cfg.recent_creative_days) || 30; const stale = Number(cfg.stale_creative_days) || 90;
  return cov.days < recent ? { key: 'fresh', label: 'Recent' } : cov.days < stale ? { key: 'aging', label: 'Ageing' } : { key: 'stale', label: 'Stale' };
}
function plCatalogueMap() {
  const o = state.opportunities;
  if (!o || !o.available || !o.core || !Array.isArray(o.core.items)) return null;
  const cfg = plCfg(); const year = String(o.today || '').slice(0, 4); const m = new Map();
  for (const it of o.core.items) {
    const cov = PE.coverage(it, year);
    const info = { it, cat: PE.categoryOf(it), st: PE.coreStatus(it, cfg), cov, band: plFreshBand(cov, cfg), high: it.priority === 'high' && PE.categoryOf(it) === 'needs' };
    for (const code of [it.product_code, ...(it.codes || [])]) if (code && !m.has(code)) m.set(code, info);
  }
  return m;
}
// the two category-level numbers: how many products need creative attention (and how many of those are High priority), and how many have stale (or no) creative
function plCatalogueStats(products, map) {
  const seen = new Set(); const out = { matched: 0, needs: 0, high: 0, review: 0, stale: 0 };
  for (const p of products) {
    const info = map.get(p.product_code); if (!info || seen.has(info.it.key)) continue; seen.add(info.it.key);
    out.matched += 1;
    if (info.cat === 'needs') { out.needs += 1; if (info.high) out.high += 1; } else if (info.cat === 'review') out.review += 1;
    if (info.band && info.band.key === 'stale') out.stale += 1;
  }
  return out;
}
function plCatalogueAttentionHtml(info) {
  if (!info) return '<span class="core-cat-none">Not assessed</span>';
  const st = info.st; const pr = info.it.actionable && info.it.priority ? `<span class="opp-priority" data-priority="${plEsc(info.it.priority)}">${plEsc(info.it.priority)}</span>` : '';
  const ads = info.cov.activeKnown ? `<small class="core-cat-ads">${plNum(info.cov.active)} Active ${info.cov.active === 1 ? 'Ad' : 'Ads'}</small>` : '';
  return `<div class="core-cat-attn"><div class="core-cat-attn-top"><span class="pl-status" data-tone="${plEsc(st.tone)}"><i aria-hidden="true"></i>${plEsc(st.label)}</span>${pr}</div><span class="core-cat-why">${plEsc(st.text)}</span>${ads}</div>`;
}
function plCatalogueFreshnessHtml(info) {
  if (!info || !info.cov.known || info.cov.latest === null) return '<span class="core-cat-none">&mdash;</span>';
  const c = info.cov; const b = info.band;
  const date = `<b class="core-cat-date${c.latestKnown ? '' : ' none'}">${plEsc(c.latest)}</b>`;
  const age = c.latestKnown && c.days !== null && c.days !== undefined ? `<small>${plEsc(plAgo(c.days))}</small>` : '';
  const chip = b ? `<span class="core-fresh-chip" data-band="${b.key}">${plEsc(b.label)}</span>` : '';
  return `<div class="core-cat-fresh" title="${plEsc(c.title)}">${date}${age}${chip}</div>`;
}
function plCoreStatusCell(it) {
  const st = PE.coreStatus(it, plCfg());
  const type = PE.categoryOf(it) === 'needs' ? PE.typeLabelOf(it) : null;
  const tag = type === 'Protect Momentum' || type === 'Revive momentum' ? `<small class="pt-why-tag">${plEsc(type)}</small>` : '';
  return `<td class="pt-status"><span class="pl-status" data-tone="${plEsc(st.tone)}"><i aria-hidden="true"></i>${plEsc(st.label)}</span><span class="pt-why-text">${plEsc(st.text)}</span>${tag}</td>`;
}
// ONE add button, the same in the row and in the panel: purple for products that need creative, a quieter outline for the others (Core never pushes a shoot on a covered product).
// One click adds the product to this week's Shoot Plan (plQuickAdd); once it is in the plan the button says "Added" and does nothing (more concepts are added from the Shoot Plan tile).
function plCoreAddBtn(it, cls = '') {
  if (plReadOnly() || PL_BLOCKED.includes(it.status)) return '';
  const needs = PE.categoryOf(it) === 'needs'; const inPlan = plInThisWeeksPlan(it); const k = plEsc(it.key);
  if (inPlan) return `<button type="button" class="btn btn-sm pl-act pl-act-planned ${cls}" data-opp-added="${k}" aria-pressed="true" title="Already in this week's Shoot Plan" aria-label="${plEsc(it.name)} has been added to the Shoot Plan">${PL_ICON.check} Added</button>`;
  return `<button type="button" class="btn btn-sm pl-act ${needs ? 'pl-act-add' : 'pl-act-soft'} ${cls}" data-opp-add="${k}" title="Add this product to this week's Shoot Plan" aria-label="Add ${plEsc(it.name)} to the Shoot Plan">Add to Shoot</button>`;
}
function plCoreActionCell(it, mode) {
  const open = !!state.oppOpen[`${mode}:${it.key}`];
  return `<td class="pt-act"><div class="pl-actions">${plCoreAddBtn(it)}<button type="button" class="pl-expand${open ? ' open' : ''}" data-opp-toggle="${mode}:${plEsc(it.key)}" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${plEsc(it.name)}">${PL_ICON.chev}</button></div></td>`;
}
// The product pictures reuse the Upcoming Drops components: the same ApparelMagic catalogue image URL, shown whole on the surface-grey panel (coverage-card-imgrow, contain) for the main picture
// and cropped to fill (drop-card-product-tile, cover) for the colourway thumbnails, with the same image icon when a style has no picture.
const PL_NOIMG = '<svg class=ic aria-hidden=true focusable=false><use href=#i-image></use></svg>';
const plMainImg = (url) => `<div class="coverage-card-imgrow pl-cx-img">${url ? `<img src="${plEsc(url)}" alt="">` : `<span class="coverage-card-noimg">${PL_NOIMG}</span>`}</div>`;
const plTileImg = (url) => `<span class="drop-card-product-tile pl-cc-tile">${url ? `<img src="${plEsc(url)}" alt="">` : `<span class="drop-card-product-noimg">${PL_NOIMG}</span>`}</span>`;
// colourway cards: a tick, the Drops-style thumbnail, name (else SKU), units, size availability and whether it can be shot. A colourway that can be shot is ticked by default; one that cannot says why and
// cannot be ticked here (the Shoot Plan modal asks before a restricted one is included).
function plCoreColourCards(it) {
  const cws = it.colourways || [];
  if (!cws.length) return '';
  const picked = new Set(plPickedCodes(it)); const viableN = cws.filter((c) => c.viable).length;
  const card = (c) => {
    const sizes = c.sizes ? `${c.sizes.available_sizes} of ${c.sizes.total_sizes} sizes` : 'Sizes not available';
    const low = c.sizes && c.sizes.low && c.sizes.low.length ? ` title="Low or sold out: ${plEsc(c.sizes.low.join(', '))}"` : '';
    const stock = c.soh > 0 ? `${plNum(c.soh)} units` : 'Out of stock';
    const status = c.viable ? `<span class="pl-cc-ready">${PL_ICON.check} Ready to shoot</span>` : `<span class="pl-cc-off" title="${plEsc(c.restriction || '')}">Can't shoot now</span>${c.restriction ? `<small>${plEsc(c.restriction)}</small>` : ''}`;
    const box = `<input type="checkbox" class="pl-cc-box" data-opp-pick="${plEsc(it.key)}" data-style="${plEsc(c.style_code)}"${picked.has(c.style_code) ? ' checked' : ''}${c.viable && !plReadOnly() ? '' : ' disabled'} aria-label="Include ${plEsc(c.colour_label || c.style_code)} in the Shoot Plan">`;
    return `<li class="pl-cc${c.viable ? ' ok' : ' off'}" title="${plEsc(c.style_code)}">${box}${plTileImg(c.image_url)}<span class="pl-cc-body"><b>${plEsc(c.colour_label || c.style_code)}</b><span class="pl-cc-stock">${stock}</span><span class="pl-cc-sizes"${low}>${plEsc(sizes)}</span>${status}</span></li>`;
  };
  return `<section class="pl-cx-cws"><div class="pl-cx-cws-h"><h5>Available colourways</h5><span class="pl-cx-count">${viableN} of ${cws.length} can be shot now &middot; <span data-opp-count="${plEsc(it.key)}">${picked.size} selected</span></span></div><ul class="pl-cc-grid">${cws.map(card).join('')}</ul></section>`;
}
// three metric cards: Sales 30D with its 7-day trend, Stock on hand with weeks of cover, Active / effective creatives
function plCoreMetrics(it) {
  const f = it.facts || {};
  const cover = f.cover_weeks !== null && f.cover_weeks !== undefined ? `${f.cover_weeks} weeks of cover` : '';
  // Creative Performance card (display only; the counts are the engine's, see PE.creativeCard). Headline = effective active creatives of all active creatives. With no active creative the
  // headline says so instead of "0 of 0". Only the non-zero categories are listed: underperforming (subtle red, confirmed over the approved limit) and awaiting data (muted grey: still
  // testing, not enough delivery, no approved benchmark yet). A creative with no approved benchmark is never counted as underperforming.
  const cc = PE.creativeCard(it);
  const part = (n, text, cls) => `<span class="${cls}">${plNum(n)} ${text}</span>`;
  let eff; let effLabel; let effSub = ''; let effCls = '';
  if (cc.kind === 'unknown') { eff = '&ndash;'; effLabel = 'Creative data unavailable'; }
  else if (cc.kind === 'none') { eff = 'No Active Creative'; effCls = 'pl-cm-none'; effLabel = 'No ads currently running for this product'; }
  else {
    eff = `${plNum(cc.performing)} of ${plNum(cc.total)}`; effLabel = 'Active creatives performing';
    const bits = [cc.underperforming ? part(cc.underperforming, 'underperforming', 'pl-cm-bad') : '', cc.declining ? part(cc.declining, 'declining', 'pl-cm-wait') : '', cc.awaiting ? part(cc.awaiting, 'awaiting data', 'pl-cm-wait') : ''].filter(Boolean);
    effSub = bits.length ? bits.join(' &middot; ') : 'All performing';
  }
  const hist = cc.history;
  const histLine = hist ? `<small class="pl-cm-hist" title="Unique creatives matched to this product (any status, a creative run in several campaigns counts once) that are not on an active ad now. Only ads in the synced Meta data that are matched to this product are counted.">${hist.earlier > 0 ? `${plNum(hist.earlier)} past ${hist.earlier === 1 ? 'creative' : 'creatives'}` : 'No past creatives'}</small>` : '';
  const card = (icon, tone, value, label, sub, extra = '', { head = '', valCls = '' } = {}) => `<div class="pl-cm">${head ? `<span class="pl-cm-h">${head}</span>` : ''}<span class="pl-cm-ic" data-tone="${tone}">${icon}</span><b${valCls ? ` class="${valCls}"` : ''}>${value}</b><span class="pl-cm-l">${label}</span>${sub ? `<small>${sub}</small>` : ''}${extra}</div>`;
  return `<div class="pl-cx-metrics">
    ${card(PL_ICON.chart, 'green', f.units30 === null || f.units30 === undefined ? '&ndash;' : plNum(f.units30), 'Sales (30D)', plTrendHtml(it, true))}
    ${card(PL_ICON.cube, 'purple', f.stock_units === null || f.stock_units === undefined ? '&ndash;' : plNum(f.stock_units), 'Stock on hand', plEsc(cover))}
    ${card(PL_ICON.video, 'purple', eff, effLabel, effSub, histLine, { head: 'Creative Performance', valCls: effCls })}
  </div>`;
}
function plHasMetaAds(it) { const f = it.facts || {}; return (f.live_creatives || 0) > 0 || (f.active_ads || 0) > 0 || !!(it.last_creative && it.last_creative.creatives_total > 0); }
// View Meta Ads: one button. It opens Meta Performance with the Ad Performance table scoped to this product through the product-to-ad matching (the family's style codes), every funnel and
// status, each Meta ad as its own row (mpOpenProduct in app.js). Shown only when the product has matched ads.
function plViewMetaAds(key) {
  const it = plFindItem(key); if (!it || typeof mpOpenProduct !== 'function') return;
  const codes = [...new Set([...(it.codes || []), it.product_code].filter(Boolean))];
  mpOpenProduct({ codes, label: it.name, key: it.key, from: state.planningStep || 'core' });
}
const plMetaBtn = (it) => (plHasMetaAds(it) ? `<div class="pl-cx-foot"><button type="button" class="btn btn-sm pl-metalink" data-opp-meta="${plEsc(it.key)}">View Meta Ads &rarr;</button></div>` : '');
// colourway pictures under the main one (click to look at one)
function plCoreThumbs(it) {
  const seen = new Set([it.image_url]);
  const list = (it.colourways || []).filter((c) => c.image_url && !seen.has(c.image_url) && seen.add(c.image_url)).slice(0, 6);
  const all = it.image_url ? [{ image_url: it.image_url, colour_label: 'Main' }, ...list] : list;
  if (all.length < 2) return '';
  return `<span class="pl-cx-thumbs">${all.map((c) => `<button type="button" class="pl-cx-th" data-opp-swap="${plEsc(c.image_url)}" title="${plEsc(c.colour_label || c.style_code || '')}"><img src="${plEsc(c.image_url)}" alt=""></button>`).join('')}</span>`;
}
// The expanded product, following the mockup: picture, name / priority / action, one-sentence reason, three metric cards, colourways, then one collapsed View Meta Ads. The engine's evidence,
// scoring and rules stay in the backend (and in High Stocks).
function plCoreDetailHtml(it, mode, ncols) {
  const cfg = plCfg(); const st = PE.coreStatus(it, cfg); const cat = PE.categoryOf(it);
  const prio = it.actionable && it.priority ? `<span class="opp-priority" data-priority="${plEsc(it.priority)}" title="${plEsc(plPrioTitle(it))}">${plEsc(it.priority)} priority</span>` : '';
  const heading = cat === 'needs' ? 'Why shoot this product?' : cat === 'review' ? 'Why this needs review' : 'Why no new creative is needed';
  return `<tr class="pt-detail-row"><td colspan="${ncols}"><div class="pl-cx">
    <div class="pl-cx-top">
      <div class="pl-cx-pic">${plMainImg(it.image_url)}${plCoreThumbs(it)}</div>
      <div class="pl-cx-main">
        <div class="pl-cx-head"><div class="pl-cx-id"><h4>${plEsc(it.name)}</h4>${prio}<span class="pl-x-cat">${plEsc(it.category || '')}</span></div><span class="pl-cx-add">${plReadOnly() || PL_BLOCKED.includes(it.status) ? '' : `<button type="button" class="link-btn pl-more-opts" data-opp-plan="${plEsc(it.key)}" title="Open the full Shoot This Week form: colourways, sizes, concept type, how many concepts">${plInThisWeeksPlan(it) ? 'Add another concept\u2026' : 'More options\u2026'}</button>`}${PL_BLOCKED.includes(it.status) ? '<span class="hint">This product cannot be planned yet.</span>' : ''}${plReadOnly() ? '<span class="hint">Past weeks are read-only.</span>' : ''}</span></div>
        <div class="pl-cx-why" data-tone="${plEsc(st.tone)}"><span class="pl-cx-why-ic">${PL_ICON.target}</span><div><b>${heading}</b><p>${plEsc(PE.whyShoot(it, cfg))}</p></div></div>
        ${plCoreMetrics(it)}
        ${plCoreColourCards(it)}
      </div>
    </div>
    ${plMetaBtn(it)}
  </div></td></tr>`;
}
function plCoreTableHtml(mode, items, cat) {
  const sort = state.oppSort[mode];
  const th = (label, cls, key) => { const def = key && PL_SORTS[key] && (!PL_SORTS[key].only || PL_SORTS[key].only === cat) ? key : null; const on = def && sort && sort.key === def; return `<th class="${cls}${def ? ' pt-sortable' : ''}${on ? ' sorted' : ''}"${def ? ` data-opp-sort="${mode}:${def}" role="button" tabindex="0" aria-sort="${on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"` : ''}>${plEsc(label)}${on ? (sort.dir === 'asc' ? ' &uarr;' : ' &darr;') : ''}</th>`; };
  const needs = cat === 'needs'; const ncols = needs ? 8 : 6;
  const head = `${needs ? '<th class="pt-w-rank">#</th>' : ''}${th('Product', 'pt-w-product', 'product')}${th('Sales (30D)', 'pt-w-sales', 'u30')}${th('Stock', 'pt-w-stockc', 'stock')}${th('Latest creative', 'pt-w-cov', null)}${th(needs ? 'Creative gap' : 'Creative status', 'pt-w-gap', null)}${needs ? th('Priority', 'pt-w-prio', 'priority') : ''}${th('Action', 'pt-w-act', null)}`;
  const limit = state.oppLimit[mode] || PL_PAGE;
  const body = items.slice(0, limit).map((it, n) => {
    const open = !!state.oppOpen[`${mode}:${it.key}`];
    return `<tr class="pt-row${open ? ' open' : ''}${needs ? '' : ' pt-quiet'}" data-opp-row="${mode}:${plEsc(it.key)}" data-status="${plEsc(it.status)}" data-category="${plEsc(cat)}" tabindex="0" aria-expanded="${open}">${needs ? `<td class="pt-rank">${n + 1}</td>` : ''}${plCoreProductCell(it)}${plCoreSalesCell(it)}${plCoreStockCell(it)}${plCoreCoverageCell(it)}${plCoreStatusCell(it)}${needs ? plPrioCell(it) : ''}${plCoreActionCell(it, mode)}</tr>${open ? plCoreDetailHtml(it, mode, ncols) : ''}`;
  }).join('');
  return `<div class="pt-wrap"><table class="pt-table pl-table pl-table-core pt-${plEsc(mode)}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${items.length > limit ? `<div class="pt-more"><button type="button" class="btn btn-ghost btn-sm" data-opp-more="${mode}">Show ${Math.min(PL_PAGE, items.length - limit)} more</button></div>` : ''}`;
}
const PL_CORE_TITLE = {
  core: {
    needs: ['Core Creative Opportunities', 'Products that need creative attention, ranked by priority.'],
    covered: ['Covered & Monitoring', 'Enough effective creative, new creative being tested, or a concept already in production.'],
    review: ['Needs Review', 'Products without enough information for a confident recommendation.'],
  },
  high: {
    needs: ['High Stocks Opportunities', 'Proven sellers with plenty of stock that need creative attention, ranked by priority.'],
    covered: ['Covered & Monitoring', 'Enough effective creative, new creative being tested, or a concept already in production.'],
    review: ['Needs Review', 'Products without enough information for a confident recommendation.'],
  },
};
// the card: title + priority summary on the left, search and filters on the right, then the three tabs and the list
function plCoreCardHtml(mode) {
  const { base, items, cat } = plItemsFor(mode); const fl = state.oppFilter[mode]; const cur = state.oppView[mode];
  const counts = {}; PE.CATEGORY_ORDER.forEach((k) => { counts[k] = 0; }); base.forEach((i) => { counts[PE.categoryOf(i)] += 1; });
  const types = new Set(); plData(mode).items.forEach((i) => { if (PE.categoryOf(i) === 'needs') { const t = PE.typeLabelOf(i); if (t) types.add(t); } });
  if (plMomentum(mode).length) types.add('Protect Momentum');
  const typeList = [...types].sort();
  const tabs = PE.CATEGORY_ORDER.map((k) => `<button type="button" role="tab" class="pl-cat${k === cur ? ' active' : ''}" data-cat="${k}" data-opp-view="${mode}:${k}" aria-selected="${k === cur}">${plEsc(PE.CATEGORY[k].tab.replace('Covered / monitoring', 'Covered & monitoring'))} <b>${counts[k]}</b></button>`).join('');
  const nBy = (p) => items.filter((i) => i.actionable && i.priority === p).length;
  const pills = cur === 'needs' ? `${['High', 'Medium', 'Low'].filter((p) => nBy(p) > 0).map((p) => `<span class="pl-sumpill"><i data-priority="${p}" aria-hidden="true"></i>${nBy(p)} ${p}</span>`).join('')}<span class="pl-sumcount">${plPlural(items.length, 'product')}</span>` : `<span class="pl-sumcount">${plPlural(items.length, 'product')}</span>`;
  const [title, subtitle] = PL_CORE_TITLE[mode][cur];
  const clear = fl.priority || fl.type || state.oppSort[mode] || state.oppQuery[mode];
  const sorts = plSortsFor(cur).filter(([key]) => key !== 'live');
  return `<div class="pl-core-card">
    <div class="pl-core-head">
      <div class="pl-core-title"><h3>${title}</h3><p>${subtitle}</p><div class="pl-core-pills">${pills}</div></div>
      <div class="pl-core-filters">
        <input type="search" class="opp-search mp-search-box" data-opp-search="${mode}" placeholder="Search products..." value="${plEsc(state.oppQuery[mode])}" aria-label="Search products">
        <label class="pl-f"><span>Opportunity</span><select data-opp-filter="${mode}:type"><option value="">All</option>${typeList.map((t) => `<option value="${plEsc(t)}"${fl.type === t ? ' selected' : ''}>${plEsc(t)}</option>`).join('')}</select></label>
        ${cur === 'needs' ? `<label class="pl-f"><span>Priority</span><select data-opp-filter="${mode}:priority"><option value="">All</option>${['High', 'Medium', 'Low'].filter((p) => p !== 'Low' || plData(mode).items.some((i) => i.actionable && i.priority === 'Low')).map((p) => `<option value="${p}"${fl.priority === p ? ' selected' : ''}>${p}</option>`).join('')}</select></label>` : ''}
        <label class="pl-f"><span>Sort</span><select data-opp-sort-select="${mode}"><option value="">Recommended order</option>${sorts.map(([key, v]) => `<option value="${key}"${state.oppSort[mode] && state.oppSort[mode].key === key ? ' selected' : ''}>${plEsc(v.label)}</option>`).join('')}</select></label>
        ${clear ? `<button type="button" class="link-btn" data-opp-reset="${mode}">Clear</button>` : ''}
      </div>
    </div>
    <div class="pl-cats pl-core-tabs" role="tablist" aria-label="${PL_MODE_NAME[mode]} status">${tabs}</div>
    ${plListHtml(mode)}
  </div>`;
}

function plBase(mode) {
  const fl = state.oppFilter[mode];
  const src = fl.type === 'Protect Momentum' ? plMomentum(mode) : plData(mode).items;
  const q = state.oppQuery[mode].trim().toLowerCase();
  return src.filter((i) => PE.isVisible(i) && (!q || String(i.name).toLowerCase().includes(q) || String(i.category || '').toLowerCase().includes(q))
    && (!fl.priority || i.priority === fl.priority)
    && (!fl.type || fl.type === 'Protect Momentum' || PE.typeLabelOf(i) === fl.type));
}
function plItemsFor(mode) {
  const base = plBase(mode);
  const cat = state.oppView[mode];
  let items = base.filter((i) => PE.categoryOf(i) === cat);
  const sort = state.oppSort[mode];
  if (sort) {
    const def = PL_SORTS[sort.key]; const col = def && (!def.only || def.only === cat) ? { sort: def.get } : null;
    if (col && col.sort) items = items.slice().sort((a, b) => { const x = col.sort(a); const y = col.sort(b); const nx = x === null || x === undefined; const ny = y === null || y === undefined; if (nx && ny) return 0; if (nx) return 1; if (ny) return -1; const r = x < y ? -1 : x > y ? 1 : 0; return sort.dir === 'asc' ? r : -r; });
  }
  return { base, items, cat };
}
function plSummaryHtml(mode, { slim = false } = {}) {
  const o = state.opportunities; const data = plData(mode);
  const c = PE.summaryCounts(mode, data, o.momentum);
  const parts = [`<span class="pl-sum-lead"><b>${c.needs}</b> ${c.needs === 1 ? 'product needs' : 'products need'} creative</span>`];
  if (c.protect) parts.push(`<span>${c.protect} Protect Momentum ${c.protect === 1 ? 'opportunity' : 'opportunities'}</span>`);
  if (c.review) parts.push(`<span>${c.review} ${c.review === 1 ? 'needs' : 'need'} review</span>`);
  const q = o.data && o.data.quality;
  const flags = q ? [q.recent_sales.complete === false ? '<span class="pt-flag" title="Some daily ApparelMagic sales requests failed, so recent sales may be under-counted. No High priority is given on incomplete sales.">Sales may be incomplete</span>' : '', q.families_with_disagreeing_sources ? `<span class="pt-flag" title="ApparelMagic online sales and the Shopify export differ a lot for these products; they are held at Medium.">${q.families_with_disagreeing_sources} with disagreeing sales sources</span>` : ''].join('') : '';
  const step = mode === 'core' ? 'core' : 'high-stocks'; const field = mode === 'core' ? 'core_reviewed' : 'high_stock_reviewed';
  const reviewed = Boolean((state.weeklyPlanningProgress || {})[field]);
  return `<div class="pl-summary${slim ? ' pl-summary-slim' : ''}">${slim ? '' : parts.join('<span class="pl-sum-sep">&middot;</span>')}${flags}<span class="pl-sum-actions"><button type="button" class="btn btn-ghost btn-sm" data-opp-refresh title="Recalculate from the latest sales, stock and Meta data">Refresh</button><button type="button" class="planning-review-btn${reviewed ? ' planning-review-btn-done' : ''}" id="${mode === 'core' ? 'core-review-btn' : 'high-stocks-review-btn'}" data-pl-step="${step}" onclick="toggleWeeklyProgress('${field}')"${plReadOnly() ? ' disabled' : ''}>${reviewed ? '&#10003; Reviewed' : '&#10003; Mark as Reviewed'}</button></span></div>`;
}
const PL_EMPTY = {
  needs: (mode, sf) => `No ${PL_MODE_NAME[mode]} product currently needs new creative that can be shot now.${sf ? ` ${sf.text}` : ''}`,
  covered: () => 'Nothing here: no product with these filters is covered or being monitored.',
  review: () => 'Nothing needs review: every product that could be shot has an assessable creative picture.',
};
function plListHtml(mode) {
  const { base, items, cat } = plItemsFor(mode);
  if (!items.length) {
    const sf = state.opportunities && state.opportunities.shortfall;
    const filtered = base.length && !items.length ? (plData(mode).items.length ? 'No product matches these filters.' : '') : '';
    return `<div class="attention-empty opp-empty">${plEsc(filtered && cat !== 'needs' ? filtered : PL_EMPTY[cat](mode, sf))}</div>`;
  }
  return plCoreTableHtml(mode, items, cat);
}
function plNotesHtml() {
  const o = state.opportunities;
  if (!o || !o.data || !o.data.notes || !o.data.notes.length) return '';
  return `<details class="opp-notes"><summary>Data and rules (${o.data.notes.length})</summary><ul>${o.data.notes.map((n) => `<li>${plEsc(n)}</li>`).join('')}</ul></details>`;
}
function plUnavailableHtml() {
  const o = state.opportunities;
  return `<div class="co-empty">${plEsc(state.opportunitiesError || (o && o.reason) || 'Opportunities are loading…')}</div>`;
}
function plPageHtml(mode, extra = '') {
  return `<div class="opp-panel pl-page pl-core" data-opp-panel="${mode}">${extra}${plSummaryHtml(mode, { slim: true })}${plCoreCardHtml(mode)}</div>`;
}
// ── Core page: one tab bar, not two stacked sections: "Creative Opportunities" (the recommendations table) | "Core Catalogue" (every category and product) ────────────────────────────────
// Only the selected view shows. The choice is kept for the session; the counts come from the same results the views show.
const PL_CORE_TABS = ['opportunities', 'catalogue'];
function plCoreTab() { try { const v = sessionStorage.getItem('wndrr.coreTab'); if (PL_CORE_TABS.includes(v)) return v; } catch (e) { /* storage unavailable: the default is fine */ } return state.coreTab && PL_CORE_TABS.includes(state.coreTab) ? state.coreTab : 'opportunities'; }
function plApplyCoreTab() {
  const tab = plCoreTab(); state.coreTab = tab;
  document.querySelectorAll('#core-tabs .core-tab').forEach((b) => { const on = b.dataset.coreTab === tab; b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; });
  const opp = document.getElementById('core-plan'); const cat = document.getElementById('core-view-catalogue');
  if (opp) opp.hidden = tab !== 'opportunities';
  if (cat) cat.hidden = tab !== 'catalogue';
  const o = state.opportunities; const a = document.getElementById('core-tab-count-opportunities'); const c = document.getElementById('core-tab-count-catalogue');
  if (a) a.textContent = o && o.available && o.core && o.core.actionable !== undefined ? String(o.core.actionable) : '';
  if (c) c.textContent = Array.isArray(state.coreProducts) && state.coreProducts.length ? String(state.coreProducts.length) : '';
}
function plSetCoreTab(tab, focus) {
  if (!PL_CORE_TABS.includes(tab)) return;
  try { sessionStorage.setItem('wndrr.coreTab', tab); } catch (e) { /* kept for this page view only */ }
  state.coreTab = tab; plApplyCoreTab();
  if (focus) { const b = document.getElementById(`core-tab-${tab}`); if (b) b.focus(); }
}
document.addEventListener('click', (ev) => { const b = ev.target.closest('#core-tabs [data-core-tab]'); if (b) plSetCoreTab(b.dataset.coreTab); });
document.addEventListener('keydown', (ev) => {
  const b = ev.target.closest && ev.target.closest('#core-tabs [data-core-tab]'); if (!b) return;
  const i = PL_CORE_TABS.indexOf(b.dataset.coreTab);
  if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') { ev.preventDefault(); plSetCoreTab(PL_CORE_TABS[(i + (ev.key === 'ArrowRight' ? 1 : PL_CORE_TABS.length - 1)) % PL_CORE_TABS.length], true); }
  else if (ev.key === 'Home') { ev.preventDefault(); plSetCoreTab(PL_CORE_TABS[0], true); } else if (ev.key === 'End') { ev.preventDefault(); plSetCoreTab(PL_CORE_TABS[PL_CORE_TABS.length - 1], true); }
});

function plRenderCore() {
  const host = document.getElementById('core-plan');
  if (!host) return;
  const o = state.opportunities;
  if (!o || !o.available) { host.innerHTML = plUnavailableHtml(); plApplyCoreTab(); return; }
  host.innerHTML = plPageHtml('core');
  plApplyCoreTab();
  if (typeof renderPlanningStepNav === 'function') renderPlanningStepNav();
}


function plRenderHighStocks() {
  const host = document.getElementById('high-stock-list');
  if (!host) return;
  const o = state.opportunities;
  if (!o || !o.available) { host.innerHTML = plUnavailableHtml(); return; }
  const hs = o.high_stocks;
  const tierNote = hs.tier_state !== 'ok' ? `<div class="opp-tier-note" role="note">${plEsc(hs.tier_note || 'The Platinum / Rocket classification is unavailable.')} High Stocks cannot recommend a product without it.</div>` : '';
  host.innerHTML = plPageHtml('high', tierNote);
  if (typeof renderPlanningStepNav === 'function') renderPlanningStepNav();
}


function plLaunchReviewHtml(lr) {
  if (!lr || (!lr.relevant_count && !lr.excluded_unlaunched_count)) return '';
  const ro = plReadOnly();
  const rows = (lr.relevant || []).map((v) => `<li class="lr-row"><div><b>${plEsc(v.name)}</b> <span class="hint">${plNum(v.soh_total)} in stock, ${plNum(v.units_30d)} sold in 30 days</span><div class="hint">${plEsc(v.detail)}</div></div>${ro || !v.product_code ? '' : `<div class="lr-actions"><button type="button" class="btn btn-primary btn-sm" onclick="plConfirmLaunch('${plEsc(v.product_code)}', '${plEsc(v.name).replace(/'/g, '&#39;')}')">Confirm launched</button><button type="button" class="btn btn-ghost btn-sm" onclick="plMarkUnlaunched('${plEsc(v.product_code)}', '${plEsc(v.name).replace(/'/g, '&#39;')}')">Not launched</button></div>`}</li>`).join('');
  const un = (lr.excluded_unlaunched || []).map((v) => `<li>${plEsc(v.name)} <span class="hint">${plEsc(v.detail)}</span></li>`).join('');
  return `<details class="opp-launch-review"><summary>Launch checks: ${lr.relevant_count} to confirm, ${lr.excluded_unlaunched_count} not yet launched</summary>
    <div class="hint">Only products that matter today (stock, an open order or recent sales) are listed. ${plEsc(lr.note || '')}</div>
    ${rows ? `<h4>Launch date missing or unreadable</h4><ul class="lr-list">${rows}</ul>${lr.relevant_count > (lr.relevant || []).length ? `<div class="hint">Showing the ${(lr.relevant || []).length} with the most stock of ${lr.relevant_count}.</div>` : ''}` : ''}
    ${un ? `<h4>Official launch date is still ahead (excluded)</h4><ul class="lr-list lr-plain">${un}</ul>` : ''}</details>`;
}


// ── launch confirmation (a note in this pipeline only; nothing changes in Shopify or ApparelMagic) ──
async function plMarkUnlaunched(code, name) {
  if (!(await confirmDialog(`Mark ${name} as not launched? It will be left out of recommendations. This is a note in this pipeline only; nothing changes in Shopify or ApparelMagic.`, { okLabel: 'Mark not launched' }))) return;
  try {
    await api('/weekly-video-plan/launch-overrides', { method: 'POST', body: JSON.stringify({ product_code: code, status: 'unlaunched', note: 'Marked from the launch checks' }) });
    toast(`${name} marked as not launched`);
    await plLoadOpportunities(true);
  } catch (e) { toast(e.message, true); }
}
async function plConfirmLaunch(code, name) {
  if (!code) return toast('This product has no product code to confirm', true);
  if (!(await confirmDialog(`Confirm that ${name} has launched? This is a note in this pipeline only; nothing changes in Shopify or ApparelMagic.`, { okLabel: 'Confirm launched' }))) return;
  try {
    await api('/weekly-video-plan/launch-overrides', { method: 'POST', body: JSON.stringify({ product_code: code, status: 'launched', note: 'Confirmed from the launch checks' }) });
    toast(`${name} marked as launched`);
    await plLoadOpportunities(true);
  } catch (e) { toast(e.message, true); }
}


// ── interactions ─────────────────────────────────────────────────────────────────────
const plRerender = (mode) => { if (mode === 'core') plRenderCore(); else plRenderHighStocks(); };
const plFindItem = (key) => { const o = state.opportunities; return o && o.available ? [...o.core.items, ...o.high_stocks.items, ...((o.momentum && o.momentum.items) || [])].find((i) => i.key === key) : null; };
document.addEventListener('click', (ev) => {
  // the row "..." menu: one open at a time, closed by any other click
  const menuBtn = ev.target.closest('[data-opp-menu]');
  document.querySelectorAll('.pl-menu-pop:not([hidden])').forEach((pop) => { if (!menuBtn || pop !== menuBtn.nextElementSibling) pop.hidden = true; });
  if (menuBtn) { const pop = menuBtn.nextElementSibling; pop.hidden = !pop.hidden; menuBtn.setAttribute('aria-expanded', pop.hidden ? 'false' : 'true'); return; }
  const tog = ev.target.closest('[data-opp-toggle]');
  if (tog) { const id = tog.dataset.oppToggle; state.oppOpen[id] = !state.oppOpen[id]; plRerender(id.split(':')[0]); return; }
  const view = ev.target.closest('[data-opp-view]');
  if (view) { const [mode, key] = view.dataset.oppView.split(':'); state.oppView[mode] = key; state.oppLimit[mode] = PL_PAGE; plRerender(mode); return; }
  if (ev.target.closest('[data-opp-refresh]')) { plLoadOpportunities(true); return; }
  const plan = ev.target.closest('[data-opp-plan]');
  if (plan) { plPlan(plan.dataset.oppPlan, plan.dataset.oppColour || null, plan.dataset.oppColour ? {} : { styleCodes: plPickedFor(plan.dataset.oppPlan) }); return; }
  const swap = ev.target.closest('[data-opp-swap]');
  if (swap) { const box = swap.closest('.pl-cx') && swap.closest('.pl-cx').querySelector('.pl-cx-img'); if (box) box.innerHTML = `<img src="${plEsc(swap.dataset.oppSwap)}" alt="">`; return; }
  const meta = ev.target.closest('[data-opp-meta]');
  if (meta) { plViewMetaAds(meta.dataset.oppMeta); return; }
  const quick = ev.target.closest('[data-opp-add]');
  if (quick) { plQuickAdd(quick.dataset.oppAdd, { styleCodes: plPickedFor(quick.dataset.oppAdd) }); return; }
  if (ev.target.closest('[data-opp-added]')) return;
  const ins = ev.target.closest('[data-ins-add]');
  if (ins) { plInsightAdd(ins.dataset.insAdd, ins.dataset.insConcept); return; }
  const insRow = ev.target.closest('[data-ins-row]');
  if (insRow && !ev.target.closest('button, a, input, select')) { const k = insRow.dataset.insRow; const st = plInsState(); st.open[k] = !st.open[k]; plRenderInsights(); return; }
  if (ev.target.closest('[data-ins-refresh]')) { plLoadInsights(true); return; }
  const sort = ev.target.closest('[data-opp-sort]');
  if (sort) { const [mode, key] = sort.dataset.oppSort.split(':'); const cur = state.oppSort[mode]; state.oppSort[mode] = !cur || cur.key !== key ? { key, dir: 'desc' } : cur.dir === 'desc' ? { key, dir: 'asc' } : null; plRerender(mode); return; }
  const reset = ev.target.closest('[data-opp-reset]');
  if (reset) { const mode = reset.dataset.oppReset; state.oppSort[mode] = null; state.oppQuery[mode] = ''; state.oppFilter[mode] = { priority: '', type: '' }; plRerender(mode); return; }
  const more = ev.target.closest('[data-opp-more]');
  if (more) { const mode = more.dataset.oppMore; state.oppLimit[mode] = (state.oppLimit[mode] || PL_PAGE) + PL_PAGE; plRerender(mode); return; }
  const row = ev.target.closest('[data-opp-row]');
  if (row && !ev.target.closest('button, a, input, select')) { const id = row.dataset.oppRow; state.oppOpen[id] = !state.oppOpen[id]; plRerender(id.split(':')[0]); }
});
document.addEventListener('keydown', (ev) => {
  const t = ev.target;
  if (!t || !t.dataset) return;
  if ((ev.key === 'Enter' || ev.key === ' ') && t.dataset.oppSort) { ev.preventDefault(); t.click(); }
  else if (ev.key === 'Enter' && t.dataset.oppRow && ev.target === t) { ev.preventDefault(); t.click(); }
});
// the "View detailed evidence" disclosure stays open across re-renders (a sort, a search, a refresh)
document.addEventListener('toggle', (ev) => {
  const d = ev.target;
  if (d && d.dataset && d.dataset.oppEvidence) state.oppEvidence[d.dataset.oppEvidence] = d.open;
}, true);
document.addEventListener('change', (ev) => {
  const pick = ev.target.closest && ev.target.closest('[data-opp-pick]');
  if (pick) {
    const key = pick.dataset.oppPick; const it = plFindItem(key); if (!it) return;
    const set = new Set(plPickedCodes(it)); if (pick.checked) set.add(pick.dataset.style); else set.delete(pick.dataset.style);
    state.oppPick[key] = [...set];
    const n = document.querySelector(`[data-opp-count="${CSS.escape(key)}"]`); if (n) n.textContent = `${set.size} selected`;
    return;
  }
  const ss = ev.target.closest && ev.target.closest('[data-opp-sort-select]');
  if (ss) { const mode = ss.dataset.oppSortSelect; state.oppSort[mode] = ss.value && PL_SORTS[ss.value] ? { key: ss.value, dir: PL_SORTS[ss.value].dir } : null; plRerender(mode); return; }
  const f = ev.target.closest && ev.target.closest('[data-opp-filter]');
  if (!f) return;
  const [mode, field] = f.dataset.oppFilter.split(':'); state.oppFilter[mode][field] = f.value; state.oppLimit[mode] = PL_PAGE; plRerender(mode);
});
document.addEventListener('input', (ev) => {
  const s = ev.target.closest && ev.target.closest('[data-opp-search]');
  if (!s) return;
  const mode = s.dataset.oppSearch; state.oppQuery[mode] = s.value;
  const pos = s.selectionStart;
  plRerender(mode);
  const again = document.querySelector(`[data-opp-search="${mode}"]`); if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) { /* not supported */ } }
});

// ── sidebar: the Planning sub-menu (Core / High Stocks / Shoot Plan), same pattern as Meta Performance's ──
const PL_REVIEW_FIELD = { core: 'core_reviewed', 'high-stocks': 'high_stock_reviewed' };
function plSyncChrome() {
  const tab = document.getElementById('tab-planning');
  if (!tab) return;
  const open = tab.classList.contains('active');
  const subs = document.getElementById('sidebar-planning-subnav'); if (subs) subs.style.display = open ? '' : 'none';
  const past = state.planningWeekOffset < 0; const progress = state.weeklyPlanningProgress || {};
  document.querySelectorAll('[data-pl-nav]').forEach((b) => {
    const step = b.dataset.plNav;
    const active = open && state.planningStep === step;
    b.classList.toggle('active', active);
    if (b.getAttribute('role') === 'tab') b.setAttribute('aria-selected', active ? 'true' : 'false');
    if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    const disabled = past && step !== 'shoot-plan';
    b.disabled = disabled; b.title = disabled ? 'Past weeks only show the Shoot Plan (a historical record).' : '';
    const done = step === 'shoot-plan' ? Boolean(state.weeklyShootPlanConfirmation) : Boolean(progress[PL_REVIEW_FIELD[step]]);
    const tick = b.querySelector('.pl-nav-tick');
    if (done && !tick) { const t = document.createElement('span'); t.className = 'pl-nav-tick'; t.setAttribute('aria-label', step === 'shoot-plan' ? 'Confirmed' : 'Reviewed'); t.innerHTML = '&#10003;'; b.appendChild(t); }
    if (!done && tick) tick.remove();
  });
  const main = document.getElementById('sidebar-planning');
  if (main) { main.classList.toggle('mp-open', open); main.setAttribute('aria-expanded', open ? 'true' : 'false'); }
}

// ── choosing a product: ONE click adds it to this week's Shoot Plan (Batch 37) ──
// Uses the same prepare step and the same POST /shoot-plan the "Shoot This Week" form uses, so the production record, its Concept Development concept, colourways and the
// duplicate rule are exactly the existing ones. The colourways that can be shot now (or the ones ticked in the expanded row) are included with the default sizes from
// Settings, the default content creator owns it, and one concept is started. Everything can be changed afterwards from the Shoot Plan tile / Concept Development.
// If no colourway can be shot right now the full form opens instead (it asks before including a restricted one).
const PL_ADDING = new Set();
function plSetBusy(key, on) { document.querySelectorAll(`[data-opp-add="${CSS.escape(key)}"]`).forEach((b) => { b.disabled = !!on; b.classList.toggle('is-busy', !!on); }); }
async function plRefreshSelection() {
  const w = planningWeekStart();
  const [items, progress] = await Promise.all([api(`/shoot-plan?week_start=${w}`), apiAllowedOr(`/shoot-plan/progress?week_start=${w}`, null)]);
  state.shootPlan = items;
  if (progress) state.conceptProgress = progress;
  for (const fn of [plRenderCore, plRenderHighStocks, renderProductionHeader, renderShootPlanStep, renderPlanningShootSummary, plSyncChrome]) { try { fn(); } catch (e) { console.error('selection refresh failed', e); } }
  try { if (state.insights && state.insights.data && state.planningStep === 'creative-insights') plRenderInsights(); } catch (e) { /* insights optional */ }
}
async function plQuickAdd(key, extra = {}) {
  if (plReadOnly() || PL_ADDING.has(key)) return;
  const it = plFindItem(key);
  if (it && plInThisWeeksPlan(it)) return; // already selected this week: never a second record
  if (Array.isArray(extra.styleCodes) && !extra.styleCodes.length && it && (it.colourways || []).some((c) => c.viable)) return toast('Select at least one colourway to include in the Shoot Plan', true);
  PL_ADDING.add(key); plSetBusy(key, true);
  try {
    const prep = await api('/opportunities/prepare-shoot', { method: 'POST', body: JSON.stringify({ key }) });
    if (!prep.product_code) return toast('This product has no product code, so it cannot be planned here', true);
    if (plSelected().some((i) => i.product_code === prep.product_code && !i.promotion_stage_id)) { await plRefreshSelection(); return; }
    const colours = prep.colours || [];
    const wanted = Array.isArray(extra.styleCodes) && extra.styleCodes.length ? new Set(extra.styleCodes) : null;
    const chosen = colours.filter((c) => c.viable !== false && (!wanted || wanted.has(c.style_code)));
    if (!chosen.length) { PL_ADDING.delete(key); plSetBusy(key, false); return plPlan(key, null, extra); } // nothing shootable: the full form, which asks before overriding
    const garment = classifyGarmentType(prep.category);
    const snapshot = extra.reason ? { ...(prep.snapshot || {}), reason: extra.reason, why: [extra.reason, ...(((prep.snapshot || {}).why) || [])], concept: extra.concept || null } : prep.snapshot;
    const creatorEntry = (state.contentCreators || []).find((c) => c.is_default) || (state.contentCreators || [])[0];
    const payload = {
      product_code: prep.product_code, product_name: prep.product_name, source: prep.source || null, week_start: planningWeekStart(), concepts: 1,
      stock_status: 'needs_to_be_brought_in', creator: creatorEntry ? creatorEntry.name : DEFAULT_CREATOR,
      image_url: (colours.find((c) => c.image_url) || {}).image_url || null,
      colourways: chosen.map((c) => ({ style_id: c.style_id, size: defaultSizeForColourway(garment, c.sizing_system, c.sizes) || null, colour_label: c.colour_label || null })),
    };
    if (extra.concept) payload.concept_type = extra.concept;
    if (snapshot) payload.recommendation_snapshot = snapshot;
    await createShootPlanSelection(payload); // app.js: the same POST /shoot-plan the Shoot This Week form uses
    toast(`${prep.product_name || 'Product'} added to the Shoot Plan`);
    await plRefreshSelection();
    plLoadOpportunities(false); // the recommendation engine now sees the planned work (nothing about how it scores changes)
  } catch (e) { toast(e.message, true); }
  finally { PL_ADDING.delete(key); plSetBusy(key, false); }
}

// ── choosing a product: the explicit step into the Shoot Plan (via the existing modal) ──
async function plPlan(key, colourCode = null, extra = {}) {
  if (plReadOnly()) return;
  const it = plFindItem(key);
  const prod = it ? PE.productionActivity(it, PL_STAGE_LABEL) : { active: false };
  try {
    if (Array.isArray(extra.styleCodes) && !extra.styleCodes.length && it && (it.colourways || []).some((c) => c.viable)) return toast('Select at least one colourway to include in the Shoot Plan', true);
    const prep = await api('/opportunities/prepare-shoot', { method: 'POST', body: JSON.stringify({ key }) });
    if (!prep.product_code) return toast('This product has no product code, so it cannot be planned here', true);
    // a product already in THIS week's Shoot Plan gets the new concept added to its record (never a duplicate product or concept)
    const additional = (state.shootPlan || []).some((i) => i.product_code === prep.product_code && !i.promotion_stage_id);
    const snapshot = extra.reason ? { ...(prep.snapshot || {}), reason: extra.reason, why: [extra.reason, ...(((prep.snapshot || {}).why) || [])], concept: extra.concept || null } : prep.snapshot;
    openShootPlanModal({
      productCode: prep.product_code, productName: prep.product_name, category: prep.category, colours: prep.colours, source: prep.source,
      opp: { headline: extra.reason || prep.headline, snapshot, kinds: prep.kinds, tags: prep.tags, status: prep.status, pipeline: prep.pipeline },
      preselectStyleCodes: colourCode ? [colourCode] : (Array.isArray(extra.styleCodes) && extra.styleCodes.length ? extra.styleCodes : null), // otherwise every colourway that can be shot is ticked; restricted ones are listed, unticked, with the reason
      concept: extra.concept || null, additional,
      notes: [additional ? "This product is already in this week's Shoot Plan: the concept you add goes on that record (no duplicate product or concept)." : null, prod.active ? prod.text : null].filter(Boolean),
    });
  } catch (e) { toast(e.message, true); }
}



// the modal: number of concepts + the reason this product was recommended
function wpPrepareShootModal(preset) {
  const reco = document.getElementById('shoot-plan-recommendation');
  const input = document.getElementById('shoot-plan-videos');
  const mixEl = document.getElementById('shoot-plan-mix');
  if (mixEl) { mixEl.style.display = 'none'; mixEl.innerHTML = ''; }
  if (!input) return;
  input.value = '1';
  const o = preset.opp || null;
  const notes = (preset.notes || []).map((n) => `<div class="hint">${plEsc(n)}</div>`).join('');
  if (!o) { reco.style.display = notes ? '' : 'none'; reco.innerHTML = notes; return; }
  reco.style.display = '';
  const why = (o.snapshot && o.snapshot.why) || [];
  reco.innerHTML = `<div class="pl-reco-head"><b>${plEsc(o.status === 'act' ? 'Recommended' : 'Planning anyway')}</b> ${(o.tags || []).map((t) => plChip(t)).join('')}</div><div>${plEsc(o.headline || '')}</div>
    ${why.length ? `<details class="opp-more"><summary>Why</summary><ul class="opp-why">${why.map((w) => `<li>${plEsc(w)}</li>`).join('')}</ul></details>` : ''}
    ${notes}<div class="hint">This reason is saved with the production record. Choose how many distinct concepts to start; each is its own Concept Development record.</div>`;
}

function wpShootPayloadExtras(ctx) {
  const input = document.getElementById('shoot-plan-videos');
  const n = Number(input ? input.value : 1);
  if (!Number.isInteger(n) || n < 1 || n > 10) return { error: 'Concepts must be a whole number from 1 to 10' };
  const fields = { concepts: n };
  const o = ctx && ctx.opp;
  if (o && o.snapshot) fields.recommendation_snapshot = o.snapshot;
  return { fields };
}

// ── Shoot Plan: concepts per product, their stage, and adapting a concept for another product ──
function wpVideosStatHtml() {
  const p = state.conceptProgress;
  return `<span><strong>${p ? p.planned : 0}</strong> Concept${p && p.planned === 1 ? '' : 's'}</span>`;
}

function plConceptsFor(itemId) { return ((state.conceptProgress && state.conceptProgress.concepts) || []).filter((c) => c.item_id === itemId); }

function wpShootPlanVideosHtml(item, readOnly) {
  const cs = plConceptsFor(item.id).filter((c) => !c.killed);
  const rows = cs.map((c) => {
    const others = (c.products || []).filter((p) => !p.primary).map((p) => p.product_name || p.product_code);
    return `<li class="pl-concept" data-concept-id="${c.id}"><span class="pl-concept-name">${plEsc(c.name)}</span><span class="pl-stage-tag" data-stage="${plEsc(c.stage)}">${plEsc(c.stage_label)}</span>${others.length ? `<span class="pl-also" title="One concept adapted for these products; it counts once">also for ${plEsc(others.join(', '))}</span>` : ''}${readOnly ? '' : `<button type="button" class="link-btn pl-adapt-link" title="Adapt this concept for another product" data-pl-adapt="${c.id}" data-pl-adapt-name="${plEsc(c.name)}">Adapt</button>`}</li>`;
  }).join('');
  return `<div class="pl-concepts" data-shoot-plan-videos="${item.id}"><div class="pl-concepts-head"><b>${cs.length}</b> concept${cs.length === 1 ? '' : 's'}</div>${rows ? `<ul class="pl-concept-list">${rows}</ul>` : '<div class="hint">No concepts yet. Add one to start development.</div>'}</div>`;
}

// Shoot Plan card -> that product's workspace in Concept Development, for the week being planned.
async function plOpenConceptFromShootPlan(itemId) {
  state.conceptDev.weekOffset = state.planningWeekOffset || 0;
  state.conceptDev.view = 'list';
  switchTab('concept-dev');
  // Concept Development lists a week's products once its Shoot Plan has been sent; before that the product's own workspace is opened directly (read from the same records).
  if (!state.weeklyShootPlanConfirmation) { await openConceptDevProductStandalone(itemId); return; }
  await loadConceptDevWeek();
  openConceptDevProduct(itemId);
}

async function plAddConcepts(itemId, name) {
  const v = window.prompt(`How many more concepts for ${name}? (1 to 10)`, '1');
  if (v === null) return;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 10) return toast('Enter a whole number from 1 to 10', true);
  try {
    await api(`/shoot-plan/${itemId}/concepts`, { method: 'POST', body: JSON.stringify({ count: n }) });
    toast(`${plPlural(n, 'concept')} added`);
    await loadAll();
    plLoadProgress();
  } catch (e) { toast(e.message, true); }
}

const PL_ADAPT = { assetId: null, timer: null, pick: null };
function plOpenAdapt(assetId, name) {
  PL_ADAPT.assetId = assetId; PL_ADAPT.pick = null;
  document.getElementById('pl-adapt-concept').textContent = name;
  document.getElementById('pl-adapt-q').value = '';
  document.getElementById('pl-adapt-results').innerHTML = '';
  openModal('pl-adapt-modal');
  document.getElementById('pl-adapt-q').focus();
}
async function plAdaptSearch() {
  const q = document.getElementById('pl-adapt-q').value.trim();
  const host = document.getElementById('pl-adapt-results');
  PL_ADAPT.pick = null;
  if (q.length < 2) { host.innerHTML = ''; return; }
  try {
    const res = await api(`/creative-priority-overrides/products?q=${encodeURIComponent(q)}`);
    host.innerHTML = res.available && res.products.length
      ? res.products.map((p) => `<button type="button" class="po-match" data-pl-adapt-pick="${plEsc(p.product_code)}" data-pl-adapt-pname="${plEsc(p.product_name)}">${plEsc(p.product_name)} <span class="hint">${plEsc(p.product_code)}</span></button>`).join('')
      : '<span class="hint">No product matches.</span>';
  } catch (e) { host.innerHTML = `<span class="hint">${plEsc(e.message)}</span>`; }
}
async function plAdaptSave() {
  if (!PL_ADAPT.pick) return toast('Search for a product and choose it first', true);
  try {
    await api(`/shoot-plan/concepts/${PL_ADAPT.assetId}/products`, { method: 'POST', body: JSON.stringify({ product_code: PL_ADAPT.pick.code, product_name: PL_ADAPT.pick.name }) });
    closeModal('pl-adapt-modal');
    toast(`Concept adapted for ${PL_ADAPT.pick.name}. It still counts once.`);
    await plLoadProgress();
    plLoadOpportunities(true);
  } catch (e) { toast(e.message, true); }
}
document.addEventListener('click', (ev) => {
  const a = ev.target.closest('[data-pl-adapt]');
  if (a) { plOpenAdapt(Number(a.dataset.plAdapt), a.dataset.plAdaptName); return; }
  const pick = ev.target.closest('[data-pl-adapt-pick]');
  if (pick) { PL_ADAPT.pick = { code: pick.dataset.plAdaptPick, name: pick.dataset.plAdaptPname }; document.getElementById('pl-adapt-q').value = PL_ADAPT.pick.name; document.getElementById('pl-adapt-results').innerHTML = `<span class="hint">Selected: <b>${plEsc(PL_ADAPT.pick.name)}</b></span>`; }
});
(function wireAdapt() {
  const q = document.getElementById('pl-adapt-q'); if (q) q.addEventListener('input', () => { clearTimeout(PL_ADAPT.timer); PL_ADAPT.timer = setTimeout(plAdaptSearch, 250); });
  const s = document.getElementById('pl-adapt-save'); if (s) s.addEventListener('click', plAdaptSave);
})();

// ── Settings → Planning ───────────────────────────────
const WPS = { config: null, pick: null, timer: null, overrides: [] };

function renderWeeklyPlanSettings() {
  const st = state.planningSettings;
  if (!st) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('season-immediate-days-input', st.season_immediate_days ?? 7);
  set('season-secondary-days-input', st.season_secondary_days ?? 14);
  loadWeeklyPlanConfig();
  loadLaunchOverrides();
}

async function saveSeasonDays() {
  const imm = Number(document.getElementById('season-immediate-days-input').value);
  const sec = Number(document.getElementById('season-secondary-days-input').value);
  if (!Number.isInteger(imm) || !Number.isInteger(sec) || imm < 1 || sec <= imm) return toast('The secondary window must be longer than the immediate window', true);
  try {
    state.planningSettings = await api('/planning-settings', { method: 'PUT', body: JSON.stringify({ season_immediate_days: imm, season_secondary_days: sec }) });
    toast('Seasonal look-ahead saved');
    plLoadOpportunities(true);
  } catch (e) { toast(e.message, true); }
}

async function loadWeeklyPlanConfig() {
  const host = document.getElementById('wpc-groups');
  if (!host) return;
  try {
    const res = await api('/weekly-video-plan/config');
    WPS.config = res;
    const wasOpen = !!(document.getElementById('wpc-advanced') && document.getElementById('wpc-advanced').open);
    const field = (f) => {
      const yesNo = { launch_sales_confirms: ['No: a person confirms', 'Yes: sustained sales count'], launch_date_verified: ['No: treat as unverified', 'Yes: confirmed by WNDRR'], stock_require_viable_colourway: ['No: family stock is enough', 'Yes: a shootable colourway is needed'], stock_block_broken_sizes: ['No: broken sizes only lower the score', 'Yes: broken sizes mean not recommended'], demand_tier_qualifies: ['No: Platinum / Rocket needs steady sales too', 'Yes: Platinum / Rocket qualifies'], launch_requires_strong_demand: ['No: steady demand is enough', 'Yes: a launch needs strong demand or Platinum / Rocket'], momentum_high_requires_strong: ['No', 'Yes'] }[f.key];
      const input = yesNo
        ? `<select id="wpc-${wpEsc(f.key)}" data-wpc-key="${wpEsc(f.key)}" aria-describedby="wpc-${wpEsc(f.key)}-hint"><option value="0" ${Number(f.value) === 0 ? 'selected' : ''}>${yesNo[0]}</option><option value="1" ${Number(f.value) === 1 ? 'selected' : ''}>${yesNo[1]}</option></select>`
        : `<input type="number" id="wpc-${wpEsc(f.key)}" data-wpc-key="${wpEsc(f.key)}" min="${f.min}" max="${f.max}" step="any" value="${f.value}" aria-describedby="wpc-${wpEsc(f.key)}-hint">`;
      return `<div class="wpc-field"><label for="wpc-${wpEsc(f.key)}">${wpEsc(f.label)}</label>${input}<span class="hint" id="wpc-${wpEsc(f.key)}-hint">${Number(f.value) !== Number(f.default) ? '<b>changed</b> &middot; ' : ''}default ${f.default} &middot; ${f.min}&ndash;${f.max}</span></div>`;
    };
    const group = (g) => `<fieldset class="wpc-group" data-wpc-group="${wpEsc(g.key)}"><legend>${wpEsc(g.title)}</legend>${g.help ? `<div class="hint wpc-help">${wpEsc(g.help)}</div>` : ''}${g.fields.map(field).join('')}</fieldset>`;
    const everyday = res.groups.filter((g) => !g.advanced);
    const advanced = res.groups.filter((g) => g.advanced);
    host.innerHTML = everyday.map(group).join('') + (advanced.length ? `<details class="wpc-advanced" id="wpc-advanced"${wasOpen ? ' open' : ''}><summary>Advanced</summary>${advanced.map(group).join('')}</details>` : '');
    const status = document.getElementById('wpc-status');
    if (status) status.textContent = Object.keys(res.stored || {}).length ? `${Object.keys(res.stored).length} setting(s) changed from the defaults` : 'All settings are at their defaults';
  } catch (e) { host.innerHTML = `<div class="attention-empty">${wpEsc(e.message)}</div>`; }
}

async function saveWeeklyPlanConfig() {
  const config = {};
  document.querySelectorAll('#wpc-groups [data-wpc-key]').forEach((el) => { config[el.dataset.wpcKey] = Number(el.value); });
  try {
    await api('/weekly-video-plan/config', { method: 'PUT', body: JSON.stringify({ config }) });
    toast('Recommendation settings saved');
    await loadWeeklyPlanConfig();
    plLoadOpportunities(true);
  } catch (e) { toast(e.message, true); }
}

async function resetWeeklyPlanConfig() {
  if (!(await confirmDialog('Reset every recommendation setting to its default?', { okLabel: 'Reset' }))) return;
  try {
    await api('/weekly-video-plan/config', { method: 'PUT', body: JSON.stringify({ reset: true }) });
    toast('Recommendation settings reset');
    await loadWeeklyPlanConfig();
    plLoadOpportunities(true);
  } catch (e) { toast(e.message, true); }
}

async function loadLaunchOverrides() {
  const host = document.getElementById('lo-list');
  if (!host) return;
  try {
    const res = await api('/weekly-video-plan/launch-overrides');
    WPS.overrides = res.overrides || [];
    host.innerHTML = WPS.overrides.length
      ? WPS.overrides.map((o) => `<div class="po-row"><b>${wpEsc(o.product_code)}</b> <span class="plan-chip plan-exception">${wpEsc(({ launched: 'Launched', unlaunched: 'Not launched', discontinued: 'Discontinued' })[o.status] || o.status)}</span>${o.note ? ` <span class="hint">${wpEsc(o.note)}</span>` : ''}<button type="button" class="btn btn-ghost btn-sm" data-lo-remove="${o.id}">Remove</button></div>`).join('')
      : '<div class="attention-empty">No manual launch statuses. Launch status comes from sales, stock, launch dates and Upcoming Drops.</div>';
  } catch (e) { host.innerHTML = `<div class="attention-empty">${wpEsc(e.message)}</div>`; }
}

async function loSearch() {
  const q = document.getElementById('lo-product-q').value.trim();
  const host = document.getElementById('lo-matches');
  WPS.pick = null;
  if (q.length < 2) { host.innerHTML = ''; return; }
  try {
    const res = await api(`/creative-priority-overrides/products?q=${encodeURIComponent(q)}`);
    host.innerHTML = res.available
      ? (res.products.length ? res.products.map((p) => `<button type="button" class="po-match" data-lo-pick="${wpEsc(p.product_code)}" data-lo-name="${wpEsc(p.product_name)}">${wpEsc(p.product_name)} <span class="hint">${wpEsc(p.product_code)}</span></button>`).join('') : '<span class="hint">No matching product.</span>')
      : '<span class="hint">The product catalogue is not loaded, so products cannot be searched yet.</span>';
  } catch (e) { host.innerHTML = `<span class="hint">${wpEsc(e.message)}</span>`; }
}

async function loAdd() {
  if (!WPS.pick) return toast('Search for a product and choose it first', true);
  try {
    await api('/weekly-video-plan/launch-overrides', { method: 'POST', body: JSON.stringify({ product_code: WPS.pick, status: document.getElementById('lo-status').value, note: document.getElementById('lo-note').value }) });
    WPS.pick = null;
    ['lo-product-q', 'lo-note'].forEach((id) => { document.getElementById(id).value = ''; });
    document.getElementById('lo-matches').innerHTML = '';
    toast('Launch status saved');
    await loadLaunchOverrides();
    plLoadOpportunities(true);
  } catch (e) { toast(e.message, true); }
}

(function wireWeeklyPlanSettings() {
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
  on('season-days-save-btn', 'click', saveSeasonDays);
  on('wpc-save-btn', 'click', saveWeeklyPlanConfig);
  on('wpc-reset-btn', 'click', resetWeeklyPlanConfig);
  on('lo-add-btn', 'click', loAdd);
  on('lo-product-q', 'input', () => { clearTimeout(WPS.timer); WPS.timer = setTimeout(loSearch, 250); });
  on('lo-matches', 'click', (ev) => {
    const b = ev.target.closest('[data-lo-pick]');
    if (!b) return;
    WPS.pick = b.dataset.loPick;
    document.getElementById('lo-product-q').value = b.dataset.loName;
    document.getElementById('lo-matches').innerHTML = `<span class="hint">Selected: <b>${wpEsc(b.dataset.loName)}</b></span>`;
  });
  on('lo-list', 'click', async (ev) => {
    const b = ev.target.closest('[data-lo-remove]');
    if (!b) return;
    try {
      await api(`/weekly-video-plan/launch-overrides/${b.dataset.loRemove}`, { method: 'DELETE' });
      toast('Launch status removed');
      await loadLaunchOverrides();
      plLoadOpportunities(true);
    } catch (e) { toast(e.message, true); }
  });
})();

// ── Launch evidence lookup (read-only): what the launch decision saw for a product ──
async function leLookup() {
  const q = document.getElementById('le-q').value.trim();
  const out = document.getElementById('le-result');
  if (q.length < 3) { out.innerHTML = '<span class="hint">Type at least 3 letters of a product name or code.</span>'; return; }
  out.innerHTML = '<span class="hint">Checking&hellip;</span>';
  try {
    const raw = document.getElementById('le-raw').checked ? '&raw=1' : '';
    const res = await api(`/weekly-video-plan/launch-evidence?q=${encodeURIComponent(q)}${raw}`);
    if (!res.products.length) { out.innerHTML = '<span class="hint">No product matches.</span>'; return; }
    out.innerHTML = `<div class="hint">${wpEsc(res.note)} Thresholds: sales count as evidence from ${res.thresholds.sales_launch_units} units${res.thresholds.sales_confirms_launch ? ' and are allowed to confirm a launch' : ' but never confirm a launch on their own'}; ${res.thresholds.settle_days > 0 ? `a date that passed under ${res.thresholds.settle_days} days ago with no sales is verified` : 'a launch date that has passed means launched'}.</div>` + res.products.map((p) => `
      <div class="le-product" data-le-product="${wpEsc(p.key)}"><div class="le-head"><b>${wpEsc(p.name)}</b> <span class="wp-badge ${p.status === 'launched' || p.status === 'upcoming_restock' ? 'wp-cat-shoot' : p.status === 'unknown' ? 'wp-cat-verify' : 'wp-cat-none'}">${wpEsc(p.status)}</span> <span class="hint">${wpEsc(p.detail)}</span></div>
        <div class="table-scroll"><table class="admin-table le-table"><thead><tr><th>Colourway</th><th>AM launch date (as recorded)</th><th>Readable</th><th>Core group</th><th>Stock</th><th>Sold 30d / 365d</th><th>First sale</th><th>Drop</th><th>Override</th><th>Decision</th></tr></thead><tbody>
        ${p.colourways.map((c) => `<tr><td>${wpEsc(c.colour || c.style_code)}<div class="hint">${wpEsc(c.style_code)}</div></td><td>${c.am_launch_date_raw ? wpEsc(c.am_launch_date_raw) : '<span class="hint">none</span>'}${c.am_launch_date ? `<div class="hint">${wpEsc(c.am_launch_date)}</div>` : ''}</td><td>${c.am_launch_date_readable === null ? '&mdash;' : c.am_launch_date_readable ? 'yes' : '<b>no</b>'}</td><td>${c.core_group ? 'yes' : 'no'}</td><td class="num">${c.stock}</td><td class="num">${c.units_sold_30d === null ? '&mdash;' : c.units_sold_30d} / ${c.units_sold_365d === null ? '&mdash;' : c.units_sold_365d}</td><td>${wpEsc(c.first_sale_month || '')}</td><td>${c.drop ? wpEsc(`${c.drop.name || 'drop'} ${c.drop.launch_date || ''}`) : ''}</td><td>${c.manual_override ? wpEsc(c.manual_override.status) : ''}</td><td><b>${wpEsc(c.status)}</b> <span class="hint">${wpEsc(c.basis)} · ${wpEsc(c.confidence)}</span><div class="hint">${wpEsc(c.detail)}</div>${c.raw ? `<details class="wp-score-detail"><summary>Raw ApparelMagic fields</summary><div class="hint">${wpEsc(JSON.stringify(c.raw.date_or_status_fields || c.raw))}</div><div class="hint">All fields: ${wpEsc((c.raw.field_names || []).join(', '))}</div></details>` : ''}</td></tr>`).join('')}
        </tbody></table></div></div>`).join('');
  } catch (e) { out.innerHTML = `<span class="hint">${wpEsc(e.message)}</span>`; }
}
(function wireLaunchEvidence() {
  const b = document.getElementById('le-btn'); if (b) b.addEventListener('click', leLookup);
  const i = document.getElementById('le-q'); if (i) i.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') leLookup(); });
})();


// Shoot Plan: a stock WARNING on work that is already planned. A product that becomes stock-restricted after it was planned is never removed or changed: the team sees why and decides.
function plShootPlanWarning(item) {
  const o = state.opportunities;
  if (!o || !o.available || !item || !item.product_code) return '';
  const all = [...o.core.items, ...o.high_stocks.items, ...((o.momentum && o.momentum.items) || [])];
  const opp = all.find((i) => (i.codes || []).includes(item.product_code) || i.product_code === item.product_code);
  if (!opp) return '';
  const bits = [];
  const r = PE.stockRestriction(opp);
  if (r.restricted) bits.push(r.text);
  (item.styles || []).forEach((s) => {
    const cw = (opp.colourways || []).find((c) => c.style_code === s.style_code);
    if (cw && !cw.viable && cw.restriction && !r.restricted) bits.push(`${cw.colour_label || cw.style_code}: ${cw.restriction.toLowerCase()}`);
  });
  return bits.length ? `<div class="pl-stockwarn" role="note">Stock warning: ${plEsc(bits.map((b) => String(b).replace(/\.\s*$/, '')).join('. '))}. This plan has not been changed.</div>` : '';
}

// ── Settings > Planning: data sources, how recommendations work, launch and data quality (moved here from the Planning pages) ─────────────────────────────────────────────────────────
function plRenderSettingsInfo() {
  const src = document.getElementById('pl-set-sources'); const how = document.getElementById('pl-set-how'); const qual = document.getElementById('pl-set-quality');
  if (!src || !how || !qual) return;
  const o = state.opportunities;
  if (!o || !o.available) { const m = `<div class="co-empty">${plEsc(state.opportunitiesError || (o && o.reason) || 'Planning data is loading…')}</div>`; src.innerHTML = m; qual.innerHTML = m; how.innerHTML = plHowHtml(null); return; }
  const q = (o.data && o.data.quality) || {}; const rel = o.data && o.data.coverage_reliability;
  const all = [...o.core.items, ...o.high_stocks.items, ...((o.momentum && o.momentum.items) || [])];
  const uncertain = all.filter((i) => (i.facts || {}).matching === 'uncertain').length;
  const stamp = (iso) => (iso ? plAgeStamp(iso) : 'not read yet');
  const row = (name, what, when, note) => `<tr><th scope="row">${plEsc(name)}</th><td>${plEsc(what)}</td><td>${plEsc(when)}</td><td>${note ? plEsc(note) : ''}</td></tr>`;
  src.innerHTML = `<table class="pl-set-table"><thead><tr><th>Source</th><th>What Planning uses it for</th><th>Last read</th><th>Notes</th></tr></thead><tbody>
    ${row('ApparelMagic: sales', 'Units sold in 7, 14 and 30 days and since launch (online sales)', stamp(q.recent_sales && q.recent_sales.fetched_at), q.recent_sales && q.recent_sales.complete === false ? 'Some daily requests failed: recent sales may be under-counted' : '')}
    ${row('ApparelMagic: stock', 'Available sellable units by colourway and size (incoming stock is never counted)', stamp(q.stock && q.stock.fetched_at), q.stock ? q.stock.size_data : '')}
    ${row('ApparelMagic: launch dates', 'The official launch date (mid_code), Core group and colourway status', 'with the catalogue', '')}
    ${row('Shopify', 'Read through Stock Demand Planning (launch pace); not queried separately', stamp(q.launch_pace && q.launch_pace.fetched_at), '')}
    ${row('Stock Demand Planning', 'The Platinum / Rocket classification, by colourway (style code); read, never recreated', stamp(q.launch_pace && q.launch_pace.fetched_at), q.launch_pace && q.launch_pace.available === false ? 'Unavailable: High Stocks cannot recommend without it' : 'Refreshed about every 3 hours')}
    ${row('Meta', 'Delivery, spend and results of confirmed ads against the approved benchmarks (DPAs excluded)', stamp(q.meta && q.meta.last_successful_sync), q.meta && q.meta.unresolved_ad_identities ? `${q.meta.unresolved_ad_identities} recent ads could not be identified` : '')}
    ${row('Ad Matching', 'Which Meta ads belong to which product', 'live', rel ? `${rel.awaiting_review} of ${rel.active_ads} active ads are awaiting review` : '')}
    ${row('Uncertain product mappings', 'Products whose creative count could change once suggested ad matches are reviewed', 'live', `${uncertain} product${uncertain === 1 ? '' : 's'}`)}
    ${row('Recommendations', 'Rebuilt from all of the above', stamp(o.generated_at), 'Refresh on the Planning page recalculates now')}
  </tbody></table>`;
  how.innerHTML = plHowHtml(plCfg());
  qual.innerHTML = `${plLaunchReviewHtml(o.launch_review) || '<div class="hint">No launch checks are waiting.</div>'}${plNotesHtml()}`;
}

function plHowHtml(c) {
  const n = (k, d) => (c && c[k] !== undefined && c[k] !== null ? c[k] : d);
  const li = (t, b) => `<li><b>${plEsc(t)}</b> ${plEsc(b)}</li>`;
  return `<ul class="pl-how">
    ${li('Core.', 'Official ApparelMagic Core styles (group AA CORE STYLES). The classification is never inferred from sales, stock or age.')}
    ${li('High Stocks.', "Non-Core products that Stock Demand Planning classes as Platinum or Rocket and that have lost momentum against their own launch pace but still sell.")}
    ${li('Protect Momentum.', `A recent launch (within ${n('momentum_window_days', 60)} days of its official launch date) with strong demand or a Platinum / Rocket classification and too little effective creative. It is a type of opportunity inside Core and High Stocks, not a page.`)}
    ${li('Needs creative.', 'Passes every check below AND has a genuine creative need. A creative gap alone never qualifies a product.')}
    ${li('Covered / monitoring.', 'Passes the checks and enough creatives are in play: performing ones, ones that cannot be benchmarked yet (no approved benchmark for their funnel) and ones in their first days. Concepts already in the Shoot Plan also count.')}
    ${li('Needs review.', 'Passes the checks but something specific stops the creative picture being assessed: ad matches awaiting review, insufficient delivery on every creative, ads that are not delivering, or no Meta data. The sentence says which.')}
    ${li('Stock restrictions.', `Only available sellable stock counts (never incoming stock). A product needs ${n('opp_min_stock_units', 40)}+ available units, at least one active colourway with ${n('opp_min_stock_units', 40)}+ available units and a usable size run, and enough cover at its current sales pace (${n('stock_min_cover_weeks', 4)}+ weeks). Products that fail are not shown, are re-checked on every refresh, and return by themselves when stock recovers. Work already planned is never removed: it gets a stock warning.`)}
    ${li('Demand qualification.', `A Platinum or Rocket product (Stock Demand Planning) qualifies while it is still selling. Any other product needs steady selling (${n('demand_steady_units', 20)}+ units in 30 days); a recent launch needs strong demand (${n('demand_strong_units', 50)}+ per 30 days, normalised for the days on sale) or Platinum / Rocket.`)}
    ${li('Creative age.', `A creative is early testing for its first ${n('new_creative_days', 4)} days of delivery unless there is already enough evidence to judge it. From the next day it is assessed; if it still has too little spend or impressions the assessment says insufficient delivery. Every unique creative is assessed on its own, in its own funnel, and one new or unbenchmarked creative never overrides the rest.`)}
    ${li('Live ads.', `The number of unique creatives (duplicates across campaigns count once) that are active in Meta and delivered within the last ${n('live_delivery_days', 7)} days.`)}
    ${li('Creative effectiveness.', 'Judged only against the approved Meta benchmarks (Settings > Meta Performance). A creative with no approved benchmark for its funnel is unrated: it is never called good or bad. Overall product sales are product demand, not evidence that Meta creative works.')}
    ${li('Fixed rules.', 'Season follows the Australian calendar; launch dates come from ApparelMagic (mid_code); Meta results are Meta-reported (Triple Whale is not substituted). These are not editable here.')}
  </ul>`;
}

document.addEventListener('click', (ev) => {
  const t = ev.target.closest && ev.target.closest('[data-plset]');
  if (!t) return;
  const key = t.dataset.plset;
  document.querySelectorAll('.pl-set-tab').forEach((b) => b.classList.toggle('active', b.dataset.plset === key));
  document.querySelectorAll('[data-plset-group]').forEach((g) => { g.style.display = g.dataset.plsetGroup === key ? '' : 'none'; });
  if (key !== 'rules') plRenderSettingsInfo();
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// CREATIVE INSIGHTS (Batch 30): which creative concepts work across products, and which products could test them.
// Data: GET /api/opportunities/insights (this application's own database; no Meta call). Verdicts come only from the approved benchmarks; TOF / TOM show numbers without a verdict.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const PL_INS_STATUS = { established: 'Established winner', promising: 'Promising test', mixed: 'Mixed performance', weak: 'Underperforming', insufficient: 'Insufficient evidence' };
function plInsState() { if (!state.insights) state.insights = { loading: false, error: null, data: null, query: '', status: '', open: {} }; return state.insights; }
async function plLoadInsights(force = false) {
  const host = document.getElementById('creative-insights');
  if (!host) return;
  const st = plInsState();
  if (st.data && !force) { plRenderInsights(); return; }
  if (st.loading) return;
  st.loading = true; st.error = null; plRenderInsights();
  try { st.data = await api(`/opportunities/insights${force ? '?fresh=1' : ''}`); } catch (e) { st.error = e.message; }
  st.loading = false; plRenderInsights();
}
const plInsMoney = (v) => (v === null || v === undefined ? plNone : `$${plNum(Math.round(v))}`);
function plInsRequirementsHtml(c) {
  const f = (c.funnels || []).filter((x) => x.benchmarked && x.requirements).sort((a, b) => (b.performing + b.underperforming) - (a.performing + a.underperforming))[0];
  if (!f) return '';
  const r = f.requirements; const li = (ok, text) => `<li class="${ok ? 'ok' : 'no'}"><b>${ok ? 'Met' : 'Not met'}</b> ${plEsc(text)}</li>`;
  return `<ul class="pt-elig">${li(r.creatives.ok, `${r.creatives.need}+ unique creatives performing in ${f.funnel} (${r.creatives.have})`)}${li(r.products.ok, `Performing on ${r.products.need}+ products (${r.products.have})`)}${li(r.spend.ok, `$${plNum(r.spend.need)}+ spent (${plInsMoney(r.spend.have)})`)}${li(r.purchases.ok, `${r.purchases.need}+ purchases (${plNum(r.purchases.have)})`)}${li(r.consistent.ok, `More performing than underperforming creatives (${r.consistent.have})`)}${li(r.dominance.ok, `No single product carries ${r.dominance.limit_pct}% or more of the performing purchases (top: ${r.dominance.top_pct}%)`)}</ul>`;
}
function plInsDetailHtml(c, d) {
  const req = d.requirements || {};
  const evidence = plList(c.evidence || []);
  const funnels = `<table class="pt-mini"><thead><tr><th>Funnel</th><th class="num">Creatives</th><th class="num">Performing</th><th class="num">Over limit</th><th class="num">Spend</th><th class="num">Purchases</th><th class="num">CPA</th><th>Verdict</th></tr></thead><tbody>${(c.funnels || []).map((f) => `<tr><td>${plEsc(plFn(f.funnel))}</td><td class="num">${f.creatives}</td><td class="num">${f.benchmarked ? f.performing : plNone}</td><td class="num">${f.benchmarked ? f.underperforming : plNone}</td><td class="num">${plInsMoney(f.spend)}</td><td class="num">${plNum(f.purchases)}</td><td class="num">${plInsMoney(f.cpa)}</td><td>${f.benchmarked ? plEsc(PL_INS_STATUS[f.status] || 'No creative judged yet') : 'No approved benchmark'}</td></tr>`).join('')}</tbody></table>`;
  const prods = `<table class="pt-mini"><thead><tr><th>Product</th><th class="num">Creatives</th><th class="num">Spend</th><th class="num">Purchases</th></tr></thead><tbody>${(c.products || []).slice(0, 12).map((p) => `<tr><td>${plEsc(p.name || p.code)}</td><td class="num">${p.creatives}</td><td class="num">${plInsMoney(p.spend)}</td><td class="num">${plNum(p.purchases)}</td></tr>`).join('')}</tbody></table>${(c.products || []).length > 12 ? `<p class="hint">${c.products.length - 12} more not shown.</p>` : ''}`;
  const cre = `<table class="pt-mini pl-live-table"><thead><tr><th>Creative</th><th>Format</th><th>Funnel</th><th>Delivery</th><th>Performance</th></tr></thead><tbody>${(c.creatives || []).slice(0, 12).map((x) => `<tr class="${x.live_status === 'delivering' ? 'pl-live-on' : 'pl-live-off'}"><td>${plEsc(x.name || 'Unnamed creative')}<small>${plEsc((x.products || []).slice(0, 3).join(', '))}</small></td><td>${plEsc(x.format || 'Unknown')}</td><td>${plEsc(String(x.funnel || 'unknown').split(' / ').map(plFn).join(' / '))}</td><td>${plEsc({ delivering: 'Delivering', starting: 'Just launched', stalled: 'Not delivering', no_delivery: 'No delivery recorded', unknown: 'Unknown' }[x.live_status] || '')}${x.last_delivery ? `<small>last delivery ${plEsc(PE.longDate(x.last_delivery))}</small>` : ''}</td><td>${(x.funnel_results || []).map((f) => `<small style="display:block">${plEsc(plFn(f.funnel))}: ${plEsc(plStateWord(f.state))}, ${plInsMoney(f.spend)}${f.cpa ? `, CPA ${plInsMoney(f.cpa)}` : ''}</small>`).join('')}</td></tr>`).join('')}</tbody></table>${(c.creatives || []).length > 12 ? `<p class="hint">${c.creatives.length - 12} more not shown.</p>` : ''}`;
  const sg = c.suggestions || [];
  const ro = plReadOnly();
  const sugg = sg.length
    ? `<ul class="pl-ins-sugg">${sg.map((s) => `<li class="pl-ins-s"><span class="pt-thumb">${s.image_url ? `<img src="${plEsc(s.image_url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span><span class="pl-ins-s-body"><b>${plEsc(s.product_name)}</b><small>${plEsc(s.category || '')}${s.planning_status === 'act' ? ' · needs creative' : ' · covered'}</small><span class="pl-ins-s-why">${plEsc(s.reason)}</span>${s.caveat ? `<small class="pl-ins-caveat">${plEsc(s.caveat)}</small>` : ''}</span>${ro ? '' : `<button type="button" class="btn btn-ghost btn-sm pl-add-btn" data-ins-add="${plEsc(s.item_key)}" data-ins-concept="${plEsc(s.concept_label)}" aria-label="Add ${plEsc(c.label)} for ${plEsc(s.product_name)} to the Shoot Plan">+ Add</button>`}</li>`).join('')}</ul>${c.suggestions_total > sg.length ? `<p class="hint">${c.suggestions_total - sg.length} more suitable products not shown.</p>` : ''}`
    : `<p class="hint">${['established', 'promising'].includes(c.status) ? 'No product currently qualifies: every suitable product has already tested this concept, has it in production, or is held back by stock, demand or season.' : 'Products are only suggested for an established winner or a promising test.'}</p>`;
  return `<tr class="pt-detail-row"><td colspan="5"><div class="pl-detail pl-ins-detail">
    <section class="pl-d-sec pl-d-reco"><h5>Why ${plEsc(PL_INS_STATUS[c.status] || c.status)}</h5>${evidence || '<p class="pl-d-text">No creative of this concept has been judged yet.</p>'}${plInsRequirementsHtml(c)}</section>
    <section class="pl-d-sec"><h5>By funnel</h5>${funnels}<p class="hint">Each funnel is judged on its own. CPA is never averaged across funnels, and a creative that ran in two funnels is one creative judged in each.</p></section>
    <section class="pl-d-sec"><h5>Products tested</h5>${prods}</section>
    <section class="pl-d-sec pl-live"><h5>Creatives</h5>${cre}</section>
    <section class="pl-d-sec pl-live pl-ins-suggest"><h5>Suitable products to test <span class="pl-cw-count">${c.suggestions_total || 0}</span></h5>${sugg}</section>
  </div></td></tr>`;
}
function plRenderInsights() {
  const host = document.getElementById('creative-insights');
  if (!host) return;
  const st = plInsState(); const d = st.data;
  if (st.loading && !d) { host.innerHTML = '<p class="hint pl-loading">Analysing creative across the account&hellip;</p>'; return; }
  if (st.error) { host.innerHTML = `<div class="opp-tier-note" role="note">Creative Insights could not be loaded: ${plEsc(st.error)} <button type="button" class="btn btn-ghost btn-sm" data-ins-refresh>Try again</button></div>`; return; }
  if (!d) { host.innerHTML = ''; return; }
  if (!d.available) { host.innerHTML = `<div class="opp-tier-note" role="note">${plEsc(d.reason || 'Creative Insights are not available yet.')}</div>`; return; }
  const q = st.query.trim().toLowerCase();
  const list = (d.concepts || []).filter((c) => (!st.status || c.status === st.status) && (!q || String(c.label).toLowerCase().includes(q)));
  const cov = d.coverage || {};
  const bench = (d.funnels || []).map((f) => `${f.funnel} ${f.benchmarked ? `CPA (approved limit ${plInsMoney(f.approved_cpa_limit)})` : 'no approved benchmark'}`).join(' · ');
  const counts = {}; (d.concepts || []).forEach((c) => { counts[c.status] = (counts[c.status] || 0) + 1; });
  const req = d.requirements || {};
  const head = `<div class="pl-section-head"><h3 class="pl-section-title">Creative Insights</h3><span class="pl-section-sub">Which creative concepts are working across products, and where to test them next. Analysed from ${plPlural(cov.creatives || 0, 'unique creative')} over the last ${d.window ? d.window.days : 90} days.</span></div>
    <div class="pl-summary"><span class="pl-sum-lead"><b>${counts.established || 0}</b> established ${(counts.established || 0) === 1 ? 'winner' : 'winners'}</span><span class="pl-sum-sep">&middot;</span><span>${counts.promising || 0} promising</span><span class="pl-sum-sep">&middot;</span><span>${(d.concepts || []).length} concepts</span>${cov.classified_spend_pct !== null && cov.classified_spend_pct !== undefined ? `<span class="pt-flag" title="Concepts come only from the Ad Matching classifications a person confirmed. Creative with no concept recorded (${plPlural(cov.unclassified_creatives || 0, 'creative')}) is not part of any concept below.">${cov.classified_spend_pct}% of spend has a concept recorded</span>` : ''}<span class="pl-sum-actions"><button type="button" class="btn btn-ghost btn-sm" data-ins-refresh title="Recalculate from the stored Meta data">Refresh</button></span></div>
    <p class="hint pl-ins-note">Judged against the approved benchmarks only: ${plEsc(bench)}. TOF and TOM creative is shown with its numbers but never called good or bad. Duplicated ads count once. Nothing here is a Meta sync.</p>`;
  const tabs = `<div class="mp-table-toolbar pl-filters"><div class="pl-fields">
      <label class="pl-f"><span>Performance</span><select data-ins-status><option value="">All</option>${Object.keys(PL_INS_STATUS).map((k) => `<option value="${k}"${st.status === k ? ' selected' : ''}>${PL_INS_STATUS[k]} (${counts[k] || 0})</option>`).join('')}</select></label>
      <input type="search" class="opp-search mp-search-box" data-ins-search placeholder="Search concepts" value="${plEsc(st.query)}" aria-label="Search concepts"></div></div>`;
  const rows = list.map((c) => {
    const open = !!st.open[c.key];
    const best = (c.funnels || []).filter((f) => f.benchmarked && f.performing + f.underperforming > 0).sort((a, b) => b.creatives - a.creatives)[0];
    const sub = best && best.cpa ? `${best.funnel} CPA ${plInsMoney(best.cpa)}` : '';
    const opp = c.suggestions_total ? `<b>${c.suggestions_total}</b> suitable ${c.suggestions_total === 1 ? 'product' : 'products'} to test` : plNone;
    return `<tr class="pt-row${open ? ' open' : ''}${['established', 'promising'].includes(c.status) ? '' : ' pt-quiet'}" data-ins-row="${plEsc(c.key)}" tabindex="0" aria-expanded="${open}"><td class="pt-product"><div class="pt-pwrap"><span class="pt-chev" aria-hidden="true"></span><span class="pt-name"><b>${plEsc(c.label)}</b>${c.legacy ? '<small class="pt-class">Free-text label</small>' : ''}</span></div></td><td class="pt-num"><b>${c.products_tested}</b></td><td class="pt-num"><b>${c.unique_creatives}</b></td><td><span class="pl-ins-st" data-status="${plEsc(c.status)}">${plEsc(PL_INS_STATUS[c.status] || c.status)}</span>${sub ? `<small class="pl-ins-sub">${plEsc(sub)}</small>` : ''}</td><td class="pl-ins-opp">${opp}</td></tr>${open ? plInsDetailHtml(c, d) : ''}`;
  }).join('');
  const table = list.length ? `<div class="pt-wrap"><table class="pt-table pl-table pl-ins-table"><thead><tr><th class="pt-w-ins-c">Concept</th><th class="pt-w-num">Products tested</th><th class="pt-w-num">Unique creatives</th><th class="pt-w-ins-p">Performance</th><th class="pt-w-ins-o">Opportunity</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="hint">${(d.concepts || []).length ? 'No concept matches this filter.' : 'No creative concepts to analyse yet: concepts come from Ad Matching classifications, and none has been confirmed with delivery in this period.'}</p>`;
  const foot = `<details class="co-how"><summary>How a concept is rated</summary><ul class="pl-how">
      <li><b>Established winner.</b> In a benchmarked funnel: ${req.min_creatives}+ unique creatives performing, on ${req.min_products}+ products (each with $${plNum(req.min_product_spend)}+ of spend), $${plNum(req.min_spend)}+ spent, ${req.min_purchases}+ purchases, more performing than underperforming creatives, and no single product carrying ${req.dominance_pct}% or more of the performing purchases.</li>
      <li><b>Promising test.</b> At least one creative performing and more performing than underperforming, but below those requirements. Suggested only for similar (same-category) products.</li>
      <li><b>Mixed performance.</b> Performing and underperforming creatives both present, the underperforming as many or more.</li>
      <li><b>Underperforming.</b> No creative performing and at least two over the approved CPA limit.</li>
      <li><b>Insufficient evidence.</b> Nothing could be rated: too little delivery, or the funnel has no approved benchmark.</li>
      <li>A suggested product has passed Planning's own stock, colourway, size, demand and season checks, has not tested the concept, and has it neither planned nor in production. These are the Creative Opportunities evidence rules; they are provisional starting points.</li></ul></details>`;
  host.innerHTML = `${head}${tabs}${table}${foot}`;
}
async function plInsightAdd(itemKey, conceptLabel) {
  const d = plInsState().data; const c = d && (d.concepts || []).find((x) => x.label === conceptLabel);
  const s = c && (c.suggestions || []).find((x) => x.item_key === itemKey);
  await plQuickAdd(itemKey, { concept: conceptLabel, reason: s ? s.reason : null });
}
document.addEventListener('change', (ev) => { const f = ev.target.closest && ev.target.closest('[data-ins-status]'); if (f) { plInsState().status = f.value; plRenderInsights(); } });
document.addEventListener('input', (ev) => {
  const s = ev.target.closest && ev.target.closest('[data-ins-search]'); if (!s) return;
  plInsState().query = s.value; const pos = s.selectionStart; plRenderInsights();
  const again = document.querySelector('[data-ins-search]'); if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) { /* not supported */ } }
});
document.addEventListener('keydown', (ev) => { const t = ev.target; if (t && t.dataset && t.dataset.insRow && ev.key === 'Enter' && ev.target === t) { ev.preventDefault(); t.click(); } });
