'use strict';
// Planning (Batch 14): Core -> High Stocks -> Shoot Plan, with a weekly CONCEPT target.
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
state.oppView = { core: 'act', high: 'act' };
state.oppOpen = {};
state.oppQuery = { core: '', high: '' };

const plEsc = (v) => escapeHtml(v === null || v === undefined ? '' : String(v));
const plPlural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
const plNum = (v) => Number(v || 0).toLocaleString('en-AU');
const plReadOnly = () => state.planningWeekOffset < 0;
const wpEsc = plEsc; // (the settings code below keeps its older helper name)

// the order and wording of the views: what the team acts on first, and why every other product is where it is
const PL_VIEWS = [
  { key: 'act', label: 'Needs creative now', statuses: ['act'], hint: 'Products the team can act on this week.' },
  { key: 'testing', label: 'Testing', statuses: ['testing'], hint: 'New creative is still gathering data; re-assessed when the test period ends.' },
  { key: 'in_production', label: 'In production', statuses: ['in_production'], hint: 'Concepts already in the Shoot Plan pipeline.' },
  { key: 'covered', label: 'Working', statuses: ['covered', 'momentum_ok'], hint: 'Enough creative is performing, or sales have not lost momentum.' },
  { key: 'data', label: 'Not enough data', statuses: ['insufficient_data', 'unavailable'], hint: 'Matching or Meta data cannot confirm a gap, so no shoot is recommended.' },
  { key: 'season', label: 'Out of season', statuses: ['out_of_season'], hint: 'Not relevant to the current selling period.' },
  { key: 'other', label: 'Not a creative priority', statuses: ['weak_demand', 'low_stock', 'too_new', 'no_proven_demand', 'not_recent', 'not_launched', 'launch_unknown'], hint: 'Not selling enough, low or excess stock, too new, or not launched.' },
];

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
  try { renderProductionHeader(); plRenderShootPlanProgress(); if (typeof renderShootPlanStep === 'function') renderShootPlanStep(); } catch (e) { console.error('progress render failed', e); }
}
// the old name the rest of the app calls after any change: refresh both
function loadWeeklyVideoPlan(fresh) { plLoadProgress(); plLoadOpportunities(!!fresh); }

// ── concept progress strip (top of Planning) ─────────────────────────────────────────
const PL_STAGE_ORDER = ['planned', 'awaiting_production', 'filmed', 'edited', 'approved', 'uploaded'];
const PL_STAGE_LABEL = { planned: 'Planned', awaiting_production: 'Awaiting production', filmed: 'Filmed', edited: 'Edited', approved: 'Approved', uploaded: 'Uploaded' };

function plStageChips(counts, { compact } = {}) {
  return PL_STAGE_ORDER.map((k) => `<span class="pl-stage" data-stage="${k}" title="${plEsc(PL_STAGE_LABEL[k])}"><b>${counts ? (counts[k] || 0) : 0}</b><span>${plEsc(PL_STAGE_LABEL[k])}</span></span>`).join('');
}

function renderProductionHeader() {
  const el = document.getElementById('planning-production-header');
  if (!el) return;
  const p = state.conceptProgress;
  const monday = mondayOfWeek(state.planningWeekOffset);
  const target = p ? p.target : Number((state.planningSettings && state.planningSettings.weekly_new_concept_target) || 15);
  const planned = p ? p.planned : 0;
  const pct = target > 0 ? Math.min(100, Math.round((planned / target) * 100)) : 0;
  const carry = p && p.carryover ? p.carryover.count : 0;
  el.innerHTML = `
    <div class="prod-header-top">
      <div>
        <h2 class="prod-title">Weekly concept target</h2>
        <div class="prod-range">${plEsc(formatWeekRange(monday))}${plReadOnly() ? ' &middot; past week, read-only' : ''}</div>
      </div>
      <div class="prod-target" role="status" aria-label="Concepts planned against the weekly target">
        <span class="prod-target-num"><b>${planned}</b> of ${target}</span><span class="prod-target-label">concepts planned</span>
      </div>
    </div>
    <div class="prod-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${target}" aria-valuenow="${Math.min(planned, target)}"><span style="width:${pct}%"></span></div>
    <div class="pl-stages" role="list">${plStageChips(p ? p.counts : null)}</div>
    <div class="prod-note">${p ? (p.remaining > 0 ? `${p.remaining} more concept${p.remaining === 1 ? '' : 's'} needed to reach ${target}.` : `Target of ${target} concepts reached.`) : 'Concept progress is loading.'}${carry ? ` ${plPlural(carry, 'unfinished concept')} carried over from earlier weeks (not counted as new).` : ''}</div>`;
}

// ── opportunity tables (Core, High Stocks and Protect momentum share one compact layout) ─────────────────────────────
// One row per product, one primary recommendation each (the server picks it: src/lib/planningPrimary.js). Row cells use the same subtle tints as Meta Performance
// (green = healthy, orange = needs attention, red = a CONFIRMED problem or gap, none = neutral or not enough data: missing data is never red). A row opens to the full evidence.
state.oppSort = { core: null, high: null };
state.oppFilter = { core: { priority: '', type: '' }, high: { priority: '', type: '' } };
state.oppLimit = { core: 50, high: 50 };
const PL_PAGE = 50;
const plChip = (text, cls, title) => `<span class="pl-chip${cls ? ` ${cls}` : ''}"${title ? ` title="${plEsc(title)}"` : ''}>${plEsc(text)}</span>`;
const PL_TREND_LABEL = { improving: 'Improving', weakening: 'Weakening', stable: 'Stable', unknown: 'n/a' };
const PL_TREND_ORDER = { improving: 3, stable: 2, weakening: 1, unknown: 0 };
const PL_PRIO_ORDER = { High: 3, Medium: 2, Low: 1 };

function plAgeText(days) { return days === null || days === undefined ? 'none found' : days === 0 ? 'today' : days >= 60 ? `${Math.round(days / 30)} months ago` : `${plPlural(days, 'day')} ago`; }
const plCell = (cls, html, title) => `<td class="pt-num${cls ? ` pt-${cls}` : ''}"${title ? ` title="${plEsc(title)}"` : ''}>${html}</td>`;
const plNone = '<span class="pt-na">&ndash;</span>';
const plMin = () => (state.opportunities && state.opportunities.config && state.opportunities.config.min_performing_creatives) || 3;

// ── cell logic (colour only where the evidence is sufficient) ──
function plStockCell(it) {
  const f = it.facts || {};
  if (f.stock_units === null || f.stock_units === undefined) return plCell('', plNone, 'Stock has not loaded');
  const band = f.stock_band;
  const cls = band === 'healthy' ? 'green' : ['short', 'short_restock', 'slow'].includes(band) ? 'orange' : '';
  const title = it.stock && it.stock.notes ? it.stock.notes.join(' ') : '';
  return plCell(cls, `<b>${plNum(f.stock_units)}</b>${f.cover_weeks !== null && f.cover_weeks !== undefined ? `<small>${f.cover_weeks}w cover</small>` : ''}`, title);
}
function plSalesCell(it, key) {
  const f = it.facts || {}; const v = key === 'u7' ? f.units7 : f.units30;
  if (v === null || v === undefined) return plCell('', plNone, 'Sales have not loaded');
  let cls = '';
  if (key === 'u30') cls = f.demand_level === 'strong' ? 'green' : f.demand_level === 'weak' || f.demand_level === 'very_weak' ? 'orange' : '';
  const partial = key === 'u30' && f.demand_basis === 'since_launch' ? `<small>${f.days_on_sale}d on sale</small>` : '';
  return plCell(cls, `<b>${plNum(v)}</b>${partial}`, key === 'u30' ? ((it.demand && it.demand.evidence) || []).join(' ') : 'Last 7 days including today (ApparelMagic online sales)');
}
function plTrendCell(it) {
  const t = (it.facts || {}).sales_trend || 'unknown';
  const cls = t === 'improving' ? 'green' : t === 'weakening' ? 'orange' : '';
  const arrow = t === 'improving' ? '&uarr; ' : t === 'weakening' ? '&darr; ' : '';
  return plCell(cls, `${arrow}${PL_TREND_LABEL[t]}`, ((it.demand && it.demand.evidence) || []).filter((x) => /Last 7 days/.test(x)).join(' ') || 'Not enough days or units to judge direction');
}
function plActiveCell(it) {
  const f = it.facts || {};
  if (f.active_ads === null || f.active_ads === undefined) return plCell('', plNone, 'Meta ad data is unavailable');
  const uncertain = f.matching === 'uncertain';
  const cls = f.unique_creatives === 0 && !uncertain ? 'red' : '';
  return plCell(cls, `<b>${f.unique_creatives}</b><small>${plPlural(f.active_ads, 'ad')}${uncertain ? ` +${f.matching_pending} unreviewed` : ''}</small>`, uncertain ? `${f.matching_pending} active ad(s) awaiting review are suggested for this product, so this count may be incomplete` : 'Distinct creatives running (confirmed or auto-matched ads, DPAs excluded)');
}
function plEffectiveCell(it) {
  const f = it.facts || {}; const min = plMin();
  if (f.active_ads === null || f.active_ads === undefined) return plCell('', plNone, 'Meta ad data is unavailable');
  let cls = '';
  if (f.performing >= min) cls = 'green';
  else if (f.performing > 0) cls = 'orange';
  else if (f.unique_creatives > 0 && (f.weak > 0 || f.declining > 0)) cls = 'red';
  else if (f.unique_creatives === 0 && f.matching !== 'uncertain') cls = 'red';
  const extra = [f.declining ? `${f.declining} fatigued` : '', f.testing ? `${f.testing} testing` : '', f.unrated ? `${f.unrated} unrated` : ''].filter(Boolean).join(', ');
  return plCell(cls, `<b>${f.performing}</b>/${f.unique_creatives}${extra ? `<small>${plEsc(extra)}</small>` : ''}`, `Performing against the approved benchmark, of the creatives running (${min} wanted). Unrated = no approved benchmark for the funnel; never counted as good or bad.`);
}
function plLastCell(it) {
  const d = (it.facts || {}).newest_creative_days;
  const cls = d === null || d === undefined ? '' : d >= 90 ? 'orange' : d <= 30 ? 'green' : '';
  return plCell(cls, d === null || d === undefined ? '<span class="pt-na">none found</span>' : plEsc(plAgeText(d)), d === null || d === undefined ? 'No matched Meta ad or upload record' : `Newest creative: ${(it.facts || {}).newest_creative_source === 'production' ? "WNDRR's production record" : 'Meta ad creation date'}`);
}
function plOppCell(it) {
  const act = it.actionable;
  const label = act ? it.opportunity_label : it.status_label;
  return `<td class="pt-opp${act ? '' : ' pt-opp-quiet'}"><span class="pt-opp-label">${plEsc(label)}</span>${it.also_qualifies && it.also_qualifies.length ? `<small>also: ${plEsc(it.also_qualifies.map((a) => a.label).join(', '))}</small>` : ''}</td>`;
}
function plPrioCell(it) {
  return `<td class="pt-prio">${it.actionable && it.priority ? `<span class="opp-priority" data-priority="${plEsc(it.priority)}" title="Score ${it.score} of 100">${plEsc(it.priority)}</span>` : plNone}</td>`;
}
function plActionCell(it) {
  const ro = plReadOnly();
  const blocked = ['not_launched', 'launch_unknown', 'unavailable'].includes(it.status);
  if (ro || blocked) return '<td class="pt-action"></td>';
  return `<td class="pt-action">${it.actionable
    ? `<button type="button" class="btn btn-primary btn-sm" data-opp-plan="${plEsc(it.key)}">Add to Shoot Plan</button>`
    : `<button type="button" class="btn btn-ghost btn-sm" data-opp-plan="${plEsc(it.key)}" title="Not a current recommendation (${plEsc(it.status_label)}). It is planned only if you choose to.">Plan anyway</button>`}</td>`;
}
function plProductCell(it, view) {
  const tags = (it.tags || []).map((t) => plChip(t, t === 'Platinum' ? 'pl-chip-plat' : t === 'Rocket' ? 'pl-chip-rocket' : '')).join('');
  const thumb = it.image_url ? `<img src="${plEsc(it.image_url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
  const cls = view === 'momentum' && !it.is_core ? '<small class="pt-class">Not Core: recent launch</small>' : '';
  return `<td class="pt-product"><div class="pt-pwrap"><span class="pt-chev" aria-hidden="true"></span><span class="pt-thumb">${thumb}</span><span class="pt-name"><b>${plEsc(it.name)}</b><small>${plEsc(it.category || '')}</small>${cls}<span class="pt-tags">${tags}</span></span></div></td>`;
}
function plTierCell(it) {
  const t = (it.facts || {}).tier;
  return `<td class="pt-tier">${t ? plChip(t === 'platinum' ? 'Platinum' : t === 'rocket' ? 'Rocket' : t, t === 'platinum' ? 'pl-chip-plat' : t === 'rocket' ? 'pl-chip-rocket' : '', `Demand Planning classification (index ${(it.facts || {}).tier_index})`) : plNone}</td>`;
}
function plPaceCell(it) {
  const rv = it.revival; const f = it.facts || {};
  if (!rv && (f.initial28 === null || f.initial28 === undefined)) return plCell('', plNone, 'Its first 28 days of selling cannot be read (older than the sales export, or too little history)');
  const a = rv ? rv.initial28 : f.initial28; const b = rv ? rv.recent28 : f.recent28; const pct = rv ? rv.ratio_pct : (a > 0 ? Math.round((b / a) * 100) : null);
  const cls = pct === null ? '' : pct >= 50 ? 'green' : pct >= 10 ? 'orange' : '';
  return plCell(cls, `<b>${plNum(a)}</b> &rarr; <b>${plNum(b)}</b><small>${pct === null ? 'no baseline' : `First 28d &rarr; latest 28d &middot; current pace ${pct}%`}</small>`, `First 28 days of selling: ${plNum(a)} units. Latest 28 days: ${plNum(b)} units${pct === null ? '' : `. Current pace is ${pct}% of the initial launch pace`}. Shopify export (Demand Planning). This is a sales comparison only: it does not mean the creative has worn out.`);
}
function plSeasonCell(it) {
  const s = it.season; if (!s) return plCell('', plNone, 'Season not assessed');
  const cls = s.state === 'in_season' ? 'green' : s.state === 'out_of_season' ? 'orange' : '';
  return plCell(cls, plEsc(s.label), (s.reasons || []).join(' '));
}
const plShortDate = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d)); return m ? `${Number(m[3])} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m[2]) - 1]} ${m[1]}` : String(d); };
function plLaunchedCell(it) {
  const d = it.launch_date; const a = it.launch_age_days;
  return plCell('', d ? `<b>${plEsc(plShortDate(d))}</b><small>${plPlural(a, 'day')} ago</small>` : plNone, 'Official launch date: ApparelMagic mid_code');
}
function plSinceCell(it) {
  const f = it.facts || {};
  if (f.since_launch_units === null || f.since_launch_units === undefined) return plCell('', plNone, 'Sales since launch are not available');
  const avg = f.days_on_sale ? Math.round((f.since_launch_units / f.days_on_sale) * 10) / 10 : null;
  const cls = f.demand_level === 'strong' ? 'green' : f.demand_level === 'weak' || f.demand_level === 'very_weak' ? 'orange' : '';
  return plCell(cls, `<b>${plNum(f.since_launch_units)}</b><small>${avg === null ? '' : `${avg}/day`}</small>`, `Units since the official launch date (${f.days_on_sale} days on sale; a part period is normalised per day, never compared with a full month)`);
}

// column sets: label, key (sort + header), cell builder
const PL_COLS = {
  core: [
    { key: 'product', label: 'Product', w: 'pt-w-product', cell: plProductCell, sort: (i) => String(i.name).toLowerCase() },
    { key: 'stock', label: 'Available stock', cell: (i) => plStockCell(i), sort: (i) => (i.facts || {}).stock_units },
    { key: 'u7', label: 'Sales 7d', cell: (i) => plSalesCell(i, 'u7'), sort: (i) => (i.facts || {}).units7 },
    { key: 'u30', label: 'Sales 30d', cell: (i) => plSalesCell(i, 'u30'), sort: (i) => (i.facts || {}).units30 },
    { key: 'trend', label: 'Sales trend', cell: plTrendCell, sort: (i) => PL_TREND_ORDER[(i.facts || {}).sales_trend || 'unknown'] },
    { key: 'active', label: 'Active creatives', cell: plActiveCell, sort: (i) => (i.facts || {}).unique_creatives },
    { key: 'effective', label: 'Effective creatives', cell: plEffectiveCell, sort: (i) => (i.facts || {}).performing },
    { key: 'last', label: 'Last new creative', w: 'pt-w-last', cell: plLastCell, sort: (i) => (i.facts || {}).newest_creative_days },
    { key: 'opp', label: 'Opportunity type', w: 'pt-w-opp', cell: plOppCell, sort: (i) => String(i.actionable ? i.opportunity_label : i.status_label) },
    { key: 'priority', label: 'Priority', w: 'pt-w-prio', cell: plPrioCell, sort: (i) => (i.actionable ? PL_PRIO_ORDER[i.priority] * 1000 + i.score : -1) },
    { key: 'action', label: 'Action', w: 'pt-w-action', cell: plActionCell },
  ],
  high: [
    { key: 'product', label: 'Product', w: 'pt-w-product', cell: plProductCell, sort: (i) => String(i.name).toLowerCase() },
    { key: 'tier', label: 'Demand tier', cell: plTierCell, sort: (i) => (i.facts || {}).tier_index },
    { key: 'stock', label: 'Available stock', cell: (i) => plStockCell(i), sort: (i) => (i.facts || {}).stock_units },
    { key: 'u30', label: 'Sales 30d', cell: (i) => plSalesCell(i, 'u30'), sort: (i) => (i.facts || {}).units30 },
    { key: 'pace', label: 'Launch pace vs now', cell: plPaceCell, sort: (i) => (i.revival ? i.revival.ratio_pct : null) },
    { key: 'season', label: 'Seasonality', w: 'pt-w-season', cell: plSeasonCell, sort: (i) => (i.season ? i.season.weight : null) },
    { key: 'effective', label: 'Effective creatives', cell: plEffectiveCell, sort: (i) => (i.facts || {}).performing },
    { key: 'opp', label: 'Opportunity type', w: 'pt-w-opp', cell: plOppCell, sort: (i) => String(i.actionable ? i.opportunity_label : i.status_label) },
    { key: 'priority', label: 'Priority', w: 'pt-w-prio', cell: plPrioCell, sort: (i) => (i.actionable ? PL_PRIO_ORDER[i.priority] * 1000 + i.score : -1) },
    { key: 'action', label: 'Action', w: 'pt-w-action', cell: plActionCell },
  ],
  momentum: [
    { key: 'product', label: 'Product', w: 'pt-w-product', cell: (i) => plProductCell(i, 'momentum'), sort: (i) => String(i.name).toLowerCase() },
    { key: 'launched', label: 'Official launch', cell: plLaunchedCell, sort: (i) => i.launch_age_days },
    { key: 'stock', label: 'Available stock', cell: (i) => plStockCell(i), sort: (i) => (i.facts || {}).stock_units },
    { key: 'since', label: 'Sold since launch', cell: plSinceCell, sort: (i) => (i.facts || {}).since_launch_units },
    { key: 'u7', label: 'Sales 7d', cell: (i) => plSalesCell(i, 'u7'), sort: (i) => (i.facts || {}).units7 },
    { key: 'trend', label: 'Sales trend', cell: plTrendCell, sort: (i) => PL_TREND_ORDER[(i.facts || {}).sales_trend || 'unknown'] },
    { key: 'active', label: 'Active creatives', cell: plActiveCell, sort: (i) => (i.facts || {}).unique_creatives },
    { key: 'effective', label: 'Effective creatives', cell: plEffectiveCell, sort: (i) => (i.facts || {}).performing },
    { key: 'opp', label: 'Opportunity type', w: 'pt-w-opp', cell: plOppCell, sort: (i) => String(i.actionable ? i.opportunity_label : i.status_label) },
    { key: 'priority', label: 'Priority', w: 'pt-w-prio', cell: plPrioCell, sort: (i) => (i.actionable ? PL_PRIO_ORDER[i.priority] * 1000 + i.score : -1) },
    { key: 'action', label: 'Action', w: 'pt-w-action', cell: plActionCell },
  ],
};
const plColsFor = (mode) => (mode === 'core' && state.oppView.core === 'momentum' ? PL_COLS.momentum : PL_COLS[mode]);

// ── expandable evidence ──
function plSection(title, body) { return body ? `<section class="pt-sec"><h5>${plEsc(title)}</h5>${body}</section>` : ''; }
const plList = (arr) => `<ul>${arr.filter(Boolean).map((x) => `<li>${plEsc(x)}</li>`).join('')}</ul>`;
function plPipelineLine(it) {
  const p = it.pipeline;
  if (!p || !p.planned) return '';
  const st = p.by_stage || {};
  const parts = PL_STAGE_ORDER.filter((k) => st[k]).map((k) => `${st[k]} ${PL_STAGE_LABEL[k].toLowerCase()}`);
  return `In the Shoot Plan pipeline: ${parts.join(', ') || `${p.planned} in progress`}.${p.uploaded_recent ? ` ${plPlural(p.uploaded_recent, 'concept')} uploaded recently.` : ''}`;
}
function plDetailHtml(it, mode, cols) {
  const act = it.actionable; const f = it.facts || {}; const dq = it.data_quality || {};
  const why = (it.why || []);
  const byKey = (k) => (why.find((w) => w.k === k) || {}).text;
  const reco = act
    ? `<p class="pt-summary">${plEsc(byKey('summary') || it.headline)}</p>${plList([byKey('gap'), byKey('performing'), byKey('recent'), it.direction ? `Creative direction: ${it.direction.text}` : 'No creative direction is supported by this product\'s own data yet.'])}${it.other_explanations && it.other_explanations.length ? `<p class="pt-sub">Other possible reasons for a sales change</p>${plList(it.other_explanations)}` : ''}`
    : `<p class="pt-summary">${plEsc(it.reason || '')}</p>`;
  const sales = plList([...(it.demand && it.demand.evidence ? it.demand.evidence : []), f.units7 !== null && f.units7 !== undefined ? `Units: ${plNum(f.units7)} in 7 days${f.units14 !== null && f.units14 !== undefined ? `, ${plNum(f.units14)} in 14 days` : ''}, ${plNum(f.units30)} in 30 days (ApparelMagic online sales; each window includes today, a part day).` : '', it.revival ? `Launch pace: ${plNum(it.revival.initial28)} units in the first 28 days, ${plNum(it.revival.recent28)} in the latest 28 (${it.revival.ratio_pct === null ? 'no baseline' : `${it.revival.ratio_pct}% of launch pace`}), from the Shopify export (Demand Planning). A drop in sales is not automatically creative fatigue.` : '', ...(dq.sales_notes || []), dq.discrepancy ? `Sources: ${dq.discrepancy.text}.` : ''].filter(Boolean));
  const stock = plList(it.stock && it.stock.notes ? it.stock.notes : []);
  const seas = it.season ? plList([...(it.season.reasons || []), `Source: ${it.season.source === 'sales_pattern' ? 'its own monthly sales pattern' : it.season.source === 'category_prior' ? "WNDRR's Australian category rule (not measured sales)" : 'no seasonal rule applies'}.`]) : '';
  const cre = (it.creatives || []).length
    ? `<table class="pt-mini"><thead><tr><th>Creative</th><th>Phase</th><th>Age</th><th class="num">Spend</th><th class="num">CPA</th><th>Detail</th></tr></thead><tbody>${it.creatives.slice(0, 10).map((c) => `<tr><td>${plEsc(c.concept || 'unclassified')}${c.ads > 1 ? ` <small>${c.ads} ads</small>` : ''}</td><td>${plEsc(c.label)}</td><td>${plEsc(plAgeText(c.age_days))}</td><td class="num">${c.spend ? `$${plNum(Math.round(c.spend))}` : plNone}</td><td class="num">${c.cpa ? `$${plNum(Math.round(c.cpa))}` : plNone}</td><td>${plEsc((c.reasons || [])[0] || '')}</td></tr>`).join('')}</tbody></table>`
    : '<p class="hint">No active creative with delivery for this product (confirmed ads only).</p>';
  const creative = `${cre}${it.evidence && it.evidence.notes && it.evidence.notes.length ? plList(it.evidence.notes) : ''}<p class="hint">Judged against the approved Meta Performance benchmarks only (Meta-reported CPA; Triple Whale is not connected and is never substituted). DPAs are not counted. A relative worsening within the benchmark is "softening", not fatigue.</p>`;
  const matching = plList([byKey('matching'), f.matching === 'uncertain' ? `${f.matching_pending} suggested ad(s) are awaiting review in Ad Matching, so a creative gap cannot be confirmed yet.` : '']);
  const production = plList([plPipelineLine(it), it.also_qualifies && it.also_qualifies.length ? `Also qualifies as: ${it.also_qualifies.map((a) => `${a.label} (${a.priority || '-'}, score ${a.score})`).join('; ')}. One primary recommendation is shown.` : '', it.classification ? `Classification: ${it.classification}.` : '']);
  const score = act && it.score_parts ? `<table class="pt-mini"><tbody>${it.score_parts.map((p) => `<tr><td>${plEsc(p.label)}</td><td class="num">${p.points >= 0 ? '+' : ''}${p.points}${p.max ? `<small> / ${p.max}</small>` : ''}</td></tr>`).join('')}<tr class="pt-total"><td>Score</td><td class="num">${it.score} / 100</td></tr></tbody></table>${(it.caps || []).length ? plList(it.caps) : ''}<p class="hint">High ${(state.opportunities.config || {}).priority_high_min || 65}+, Medium ${(state.opportunities.config || {}).priority_medium_min || 45}+. High needs strong or steady demand and complete data.</p>` : '';
  const elig = (it.eligibility || []).length ? `<ul class="pt-elig">${it.eligibility.map((e) => `<li class="${e.ok ? 'ok' : 'no'}"><b>${e.ok ? 'Met' : 'Not met'}</b> ${plEsc(e.text)}</li>`).join('')}</ul>` : '';
  const q = state.opportunities && state.opportunities.data && state.opportunities.data.quality;
  const fresh = q ? plList([`Recent sales: ${q.recent_sales.source}. Read ${q.recent_sales.fetched_at ? plAgeStamp(q.recent_sales.fetched_at) : 'not yet'}${q.recent_sales.failed_requests ? `; ${q.recent_sales.failed_requests} daily requests failed` : ''}.`, `Launch pace and tier: ${q.launch_pace.source}. ${q.launch_pace.fetched_at ? `Read ${plAgeStamp(q.launch_pace.fetched_at)}.` : 'Not loaded.'}`, `Meta: last successful sync ${q.meta.last_successful_sync ? plAgeStamp(q.meta.last_successful_sync) : 'unknown'}; ad status as of ${q.meta.ads_status_as_of ? plAgeStamp(q.meta.ads_status_as_of) : 'unknown'}.`]) : '';
  return `<tr class="pt-detail-row"><td colspan="${cols.length}"><div class="pt-detail">
    ${plSection(act ? 'Why it is recommended' : 'Why it is not recommended', reco)}${plSection('Sales evidence', sales)}${plSection('Stock evidence', stock)}${plSection('Seasonal assessment', seas)}
    ${plSection('Creative performance', creative)}${plSection('Matching confidence', matching)}${plSection('Existing production', production)}${plSection('Score breakdown', score)}${plSection('Eligibility rules', elig)}${plSection('Data freshness', fresh)}
  </div></td></tr>`;
}
function plAgeStamp(iso) {
  const t = Date.parse(iso); if (!Number.isFinite(t)) return 'unknown';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago`;
}

// ── filters, sort, rendering ──
const PL_VIEWS_CORE_EXTRA = { key: 'momentum', label: 'Protect momentum', source: 'momentum', hint: 'Recent launches (official ApparelMagic launch date) selling well with too little effective creative. They are not official Core products.' };
function plViewsFor(mode) { return mode === 'core' ? [PL_VIEWS[0], PL_VIEWS_CORE_EXTRA, ...PL_VIEWS.slice(1)] : PL_VIEWS; }
function plItemsFor(mode, data) {
  const view = plViewsFor(mode).find((v) => v.key === state.oppView[mode]) || PL_VIEWS[0];
  const src = view.source === 'momentum' ? ((state.opportunities.momentum && state.opportunities.momentum.items) || []) : data.items.filter((i) => view.statuses.includes(i.status));
  const q = state.oppQuery[mode].trim().toLowerCase(); const fl = state.oppFilter[mode];
  let items = src.filter((i) => (!q || String(i.name).toLowerCase().includes(q) || String(i.category || '').toLowerCase().includes(q)) && (!fl.priority || i.priority === fl.priority) && (!fl.type || (i.actionable ? i.opportunity_label : i.status_label) === fl.type));
  const sort = state.oppSort[mode];
  if (sort) {
    const col = plColsFor(mode).find((c) => c.key === sort.key);
    if (col && col.sort) items = items.slice().sort((a, b) => { const x = col.sort(a); const y = col.sort(b); const nx = x === null || x === undefined; const ny = y === null || y === undefined; if (nx && ny) return 0; if (nx) return 1; if (ny) return -1; return (typeof x === 'string' ? x.localeCompare(y) : x - y) * (sort.dir === 'asc' ? 1 : -1); });
  }
  return { view, items, src };
}
function plToolbarHtml(mode, data) {
  const counts = data.counts || {};
  const n = (v) => (v.source === 'momentum' ? ((state.opportunities.momentum && state.opportunities.momentum.actionable) || 0) : v.statuses.reduce((s, k) => s + (counts[k] || 0), 0));
  const cur = state.oppView[mode];
  return `<div class="opp-toolbar" role="tablist" aria-label="${mode === 'core' ? 'Core' : 'High Stocks'} views">
    ${plViewsFor(mode).map((v) => `<button type="button" role="tab" class="opp-view${v.key === cur ? ' active' : ''}" data-opp-view="${mode}:${v.key}" aria-selected="${v.key === cur}" title="${plEsc(v.hint)}">${plEsc(v.label)} <b>${n(v)}</b></button>`).join('')}
    <input type="search" class="opp-search" data-opp-search="${mode}" placeholder="Search products" value="${plEsc(state.oppQuery[mode])}" aria-label="Search products">
  </div>`;
}
function plFilterBar(mode, src) {
  const fl = state.oppFilter[mode];
  const types = [...new Set(src.map((i) => (i.actionable ? i.opportunity_label : i.status_label)).filter(Boolean))].sort();
  return `<div class="pt-filters"><label>Priority <select data-opp-filter="${mode}:priority"><option value="">All</option>${['High', 'Medium', 'Low'].map((p) => `<option value="${p}"${fl.priority === p ? ' selected' : ''}>${p}</option>`).join('')}</select></label>
    <label>Opportunity <select data-opp-filter="${mode}:type"><option value="">All</option>${types.map((t) => `<option value="${plEsc(t)}"${fl.type === t ? ' selected' : ''}>${plEsc(t)}</option>`).join('')}</select></label>
    ${fl.priority || fl.type || state.oppSort[mode] ? `<button type="button" class="link-btn" data-opp-reset="${mode}">Clear filters and sort</button>` : ''}</div>`;
}
function plTableHtml(mode, items, cols) {
  const sort = state.oppSort[mode];
  const head = cols.map((c) => `<th class="${c.w || ''}${c.sort ? ' pt-sortable' : ''}${sort && sort.key === c.key ? ' sorted' : ''}"${c.sort ? ` data-opp-sort="${mode}:${c.key}" role="button" tabindex="0" aria-sort="${sort && sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"` : ''}>${plEsc(c.label)}${sort && sort.key === c.key ? `<span class="pt-arrow">${sort.dir === 'asc' ? '&uarr;' : '&darr;'}</span>` : ''}</th>`).join('');
  const limit = state.oppLimit[mode] || PL_PAGE;
  const body = items.slice(0, limit).map((it) => {
    const open = !!state.oppOpen[`${mode}:${it.key}`];
    return `<tr class="pt-row${open ? ' open' : ''}${it.actionable ? '' : ' pt-quiet'}" data-opp-row="${mode}:${plEsc(it.key)}" data-status="${plEsc(it.status)}">${cols.map((c) => c.cell(it)).join('')}</tr>${open ? plDetailHtml(it, mode, cols) : ''}`;
  }).join('');
  return `<div class="pt-wrap"><table class="pt-table pt-${plEsc(mode)}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${items.length > limit ? `<div class="pt-more"><button type="button" class="btn btn-ghost btn-sm" data-opp-more="${mode}">Show ${Math.min(PL_PAGE, items.length - limit)} more (${items.length - limit} hidden)</button></div>` : ''}<div class="pt-count">${items.length} product${items.length === 1 ? '' : 's'}</div>`;
}
function plListHtml(mode, data) {
  const { view, items, src } = plItemsFor(mode, data);
  if (!src.length || !items.length) {
    const empty = view.key === 'act'
      ? `No ${mode === 'core' ? 'Core' : 'High Stocks'} product currently needs new creative.${state.opportunities && state.opportunities.shortfall ? ` ${plEsc(state.opportunities.shortfall.text)}` : ''}`
      : src.length ? 'No product matches the filters.' : `Nothing here. ${view.hint}`;
    return `${src.length ? plFilterBar(mode, src) : ''}<div class="attention-empty opp-empty">${empty}</div>`;
  }
  return `${view.key === 'momentum' ? `<div class="opp-intro">${plEsc(view.hint)} Age comes from the official ApparelMagic launch date; sales are normalised per day on sale, so a part-period is never compared with a full month. These are labelled "Not Core" and are never relabelled as Core products.</div>` : ''}${plFilterBar(mode, src)}${plTableHtml(mode, items, plColsFor(mode))}`;
}
function plBannerHtml(data, mode) {
  const sf = state.opportunities && state.opportunities.shortfall;
  const act = data.actionable;
  const line = `<b>${act}</b> ${mode === 'core' ? 'Core' : 'High Stocks'} product${act === 1 ? '' : 's'} need${act === 1 ? 's' : ''} new creative now.`;
  const q = state.opportunities && state.opportunities.data && state.opportunities.data.quality;
  const flags = q ? [q.recent_sales.complete === false ? `<span class="pt-flag" title="Some daily ApparelMagic sales requests failed, so recent sales may be under-counted. No High priority is given on incomplete sales.">Sales may be incomplete</span>` : '', q.families_with_disagreeing_sources ? `<span class="pt-flag" title="ApparelMagic online sales and the Shopify export differ a lot for these products; they are held at Medium.">${q.families_with_disagreeing_sources} with disagreeing sales sources</span>` : ''].join('') : '';
  return `<div class="opp-summary"><span>${line}</span>${flags}${sf ? `<span class="hint">${plEsc(sf.text)}</span>` : ''}<button type="button" class="btn btn-ghost btn-sm" data-opp-refresh title="Recalculate from the latest sales, stock and Meta data">Refresh</button></div>`;
}
function plNotesHtml() {
  const o = state.opportunities;
  if (!o || !o.data || !o.data.notes || !o.data.notes.length) return '';
  return `<details class="opp-notes"><summary>Data and rules (${o.data.notes.length})</summary><ul>${o.data.notes.map((n) => `<li>${plEsc(n)}</li>`).join('')}</ul></details>`;
}
function plUnavailableHtml(mode) {
  const o = state.opportunities;
  return `<div class="co-empty">${plEsc(state.opportunitiesError || (o && o.reason) || 'Opportunities are loading…')}</div>`;
}
function plRenderCore() {
  const host = document.getElementById('core-plan');
  if (!host) return;
  const o = state.opportunities;
  if (!o || !o.available) { host.innerHTML = plUnavailableHtml('core'); return; }
  host.innerHTML = `<div class="opp-panel" data-opp-panel="core">${plBannerHtml(o.core, 'core')}${plToolbarHtml('core', o.core)}${plListHtml('core', o.core)}${plNotesHtml()}</div>`;
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

function plRenderHighStocks() {
  const host = document.getElementById('high-stock-list');
  if (!host) return;
  const o = state.opportunities;
  if (!o || !o.available) { host.innerHTML = plUnavailableHtml('high'); return; }
  const hs = o.high_stocks;
  const tierNote = hs.tier_state !== 'ok' ? `<div class="opp-tier-note" role="note">${plEsc(hs.tier_note || 'The Platinum / Rocket classification is unavailable.')} High Stocks cannot recommend a product without it.</div>` : '';
  host.innerHTML = `<div class="opp-panel" data-opp-panel="high">
    <div class="opp-intro">Previously successful (Platinum or Rocket) products that have lost momentum, still sell enough to be revived, and have the stock to justify fresh creative. A product that has almost stopped selling is not a revival, and a bigger drop is not a stronger case. Past success and stock alone are never a reason.</div>
    ${tierNote}${plBannerHtml(hs, 'high')}${plToolbarHtml('high', hs)}${plListHtml('high', hs)}${plLaunchReviewHtml(o.launch_review)}${plNotesHtml()}</div>`;
  const f = document.getElementById('high-stock-step-footer-count');
  if (f) f.textContent = `${hs.actionable} product${hs.actionable === 1 ? '' : 's'} need creative`;
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
document.addEventListener('click', (ev) => {
  const view = ev.target.closest('[data-opp-view]');
  if (view) { const [mode, key] = view.dataset.oppView.split(':'); state.oppView[mode] = key; state.oppSort[mode] = null; state.oppLimit[mode] = PL_PAGE; state.oppFilter[mode] = { priority: '', type: '' }; plRerender(mode); return; }
  if (ev.target.closest('[data-opp-refresh]')) { plLoadOpportunities(true); return; }
  const plan = ev.target.closest('[data-opp-plan]');
  if (plan) { plPlan(plan.dataset.oppPlan); return; }
  const sort = ev.target.closest('[data-opp-sort]');
  if (sort) { const [mode, key] = sort.dataset.oppSort.split(':'); const cur = state.oppSort[mode]; state.oppSort[mode] = !cur || cur.key !== key ? { key, dir: 'desc' } : cur.dir === 'desc' ? { key, dir: 'asc' } : null; plRerender(mode); return; }
  const reset = ev.target.closest('[data-opp-reset]');
  if (reset) { const mode = reset.dataset.oppReset; state.oppSort[mode] = null; state.oppFilter[mode] = { priority: '', type: '' }; plRerender(mode); return; }
  const more = ev.target.closest('[data-opp-more]');
  if (more) { const mode = more.dataset.oppMore; state.oppLimit[mode] = (state.oppLimit[mode] || PL_PAGE) + PL_PAGE; plRerender(mode); return; }
  const row = ev.target.closest('[data-opp-row]');
  if (row && !ev.target.closest('button, a, input, select')) { const id = row.dataset.oppRow; state.oppOpen[id] = !state.oppOpen[id]; plRerender(id.split(':')[0]); }
});
document.addEventListener('keydown', (ev) => {
  const t = ev.target;
  if ((ev.key === 'Enter' || ev.key === ' ') && t && t.dataset && t.dataset.oppSort) { ev.preventDefault(); t.click(); }
});
document.addEventListener('change', (ev) => {
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

// ── choosing a product: the explicit step into the Shoot Plan (via the existing modal) ──
async function plPlan(key) {
  if (plReadOnly()) return;
  try {
    const prep = await api('/opportunities/prepare-shoot', { method: 'POST', body: JSON.stringify({ key }) });
    if (!prep.product_code) return toast('This product has no product code, so it cannot be planned here', true);
    openShootPlanModal({
      productCode: prep.product_code, productName: prep.product_name, category: prep.category, colours: prep.colours, source: prep.source,
      opp: { headline: prep.headline, snapshot: prep.snapshot, kinds: prep.kinds, tags: prep.tags, status: prep.status, pipeline: prep.pipeline },
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
  if (!o) { reco.style.display = 'none'; reco.innerHTML = ''; return; }
  reco.style.display = '';
  const why = (o.snapshot && o.snapshot.why) || [];
  reco.innerHTML = `<div class="pl-reco-head"><b>${plEsc(o.status === 'act' ? 'Recommended' : 'Planning anyway')}</b> ${(o.tags || []).map((t) => plChip(t)).join('')}</div><div>${plEsc(o.headline || '')}</div>
    ${why.length ? `<details class="opp-more"><summary>Why</summary><ul class="opp-why">${why.map((w) => `<li>${plEsc(w)}</li>`).join('')}</ul></details>` : ''}
    <div class="hint">This reason is saved with the production record. Choose how many distinct concepts to start; each is its own Concept Development record.</div>`;
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
    return `<li class="pl-concept" data-concept-id="${c.id}"><span class="pl-concept-name">${plEsc(c.name)}</span><span class="pl-stage-tag" data-stage="${plEsc(c.stage)}">${plEsc(c.stage_label)}</span>${others.length ? `<span class="pl-also" title="One concept adapted for these products; it counts once">also for ${plEsc(others.join(', '))}</span>` : ''}${readOnly ? '' : `<button type="button" class="link-btn" data-pl-adapt="${c.id}" data-pl-adapt-name="${plEsc(c.name)}">Adapt for another product</button>`}</li>`;
  }).join('');
  const add = readOnly ? '' : `<button type="button" class="link-btn" onclick="plAddConcepts(${item.id}, '${plEsc(item.product_name || '').replace(/'/g, '&#39;')}')">Add concepts</button>`;
  return `<div class="pl-concepts" data-shoot-plan-videos="${item.id}"><div class="pl-concepts-head"><b>${cs.length}</b> concept${cs.length === 1 ? '' : 's'} ${add}</div>${rows ? `<ul class="pl-concept-list">${rows}</ul>` : '<div class="hint">No concepts yet.</div>'}</div>`;
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

// the Shoot Plan step's own progress panel (same data as the header, with the stages explained)
function plRenderShootPlanProgress() {
  const host = document.getElementById('shoot-plan-progress');
  if (!host) return;
  const p = state.conceptProgress;
  if (!p) { host.innerHTML = ''; return; }
  const sf = state.opportunities && state.opportunities.shortfall;
  const carry = p.carryover && p.carryover.count ? `<details class="opp-more"><summary>${plPlural(p.carryover.count, 'unfinished concept')} from earlier weeks</summary><ul class="pl-concept-list">${p.carryover.concepts.slice(0, 40).map((c) => `<li class="pl-concept"><span class="pl-concept-name">${plEsc(c.name)}</span><span class="pl-stage-tag" data-stage="${plEsc(c.stage)}">${plEsc(c.stage_label)}</span><span class="hint">${plEsc(c.product_name || '')} &middot; week of ${plEsc(c.week_start)}</span></li>`).join('')}</ul><div class="hint">Nothing is reset or removed when a new week starts; these stay in their real stage and are not counted toward this week's target.</div></details>` : '';
  host.innerHTML = `<div class="pl-progress-card"><div class="pl-progress-head"><b>${p.planned} of ${p.target}</b> new concepts planned this week &middot; ${p.remaining} remaining</div><div class="pl-stages">${plStageChips(p.counts)}</div>
    <div class="hint">${plEsc(p.definition)}</div>${sf && p.remaining > 0 ? `<div class="pl-shortfall">${plEsc(sf.text)}</div>` : ''}${carry}</div>`;
}


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
      const yesNo = { launch_sales_confirms: ['No: a person confirms', 'Yes: sustained sales count'], launch_date_verified: ['No: treat as unverified', 'Yes: confirmed by WNDRR'] }[f.key];
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

