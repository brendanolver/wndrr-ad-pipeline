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


// compact weekly strip (Core / High Stocks): concepts planned vs target, kept distinct from products selected and from concepts carried over from earlier weeks
function renderProductionHeader() {
  const el = document.getElementById('planning-production-header');
  if (!el) return;
  const w = PE.weeklySummary(state.conceptProgress, (state.shootPlan || []).length, state.planningSettings && state.planningSettings.weekly_new_concept_target);
  if (!w.loaded) { el.innerHTML = `<span class="pl-week-label">This week's Shoot Plan</span><span class="pl-week-muted">Concept progress is loading.</span>`; return; }
  const bits = [`${plPlural(w.products, 'product')} selected`];
  if (w.carried) bits.push(`${w.carried} carried over from earlier weeks`);
  el.innerHTML = `<span class="pl-week-label">${plReadOnly() ? 'That week\'s Shoot Plan' : 'This week\'s Shoot Plan'}</span>
    <span class="pl-week-fig"><b>${w.planned}</b> ${w.planned === 1 ? 'concept' : 'concepts'} planned${w.target ? ` / ${w.target} target` : ''}</span>
    ${w.remaining !== null && w.target ? `<span class="pl-week-sep">&mdash;</span><span class="pl-week-fig">${w.remaining} ${w.remaining === 1 ? 'concept' : 'concepts'} remaining</span>` : ''}
    <span class="pl-week-muted">${plEsc(bits.join(' \u00b7 '))}</span>
    <button type="button" class="link-btn pl-week-link" onclick="setPlanningStep('shoot-plan')">View Shoot Plan &rarr;</button>`;
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

function plAgeText(days) { return days === null || days === undefined ? 'none found' : days === 0 ? 'today' : days >= 60 ? `${Math.round(days / 30)} months ago` : `${plPlural(days, 'day')} ago`; }
const plNone = '<span class="pt-na">&ndash;</span>';
const plCfg = () => (state.opportunities && state.opportunities.config) || {};
const plMin = () => plCfg().min_performing_creatives || 3;
const plData = (mode) => (mode === 'core' ? state.opportunities.core : state.opportunities.high_stocks);
const plMomentum = (mode) => PE.momentumItemsFor(mode, plData(mode), state.opportunities.momentum);

// ── cells ──
function plProductCell(it) {
  const thumb = it.image_url ? `<img src="${plEsc(it.image_url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
  const notCore = it.mode === 'momentum' && !it.is_core ? '<small class="pt-class">Not Core: recent launch</small>' : '';
  const prod = PE.productionActivity(it, PL_STAGE_LABEL);
  const inProd = prod.active ? `<small class="pt-prod" title="${plEsc(prod.text)}">In production</small>` : '';
  return `<td class="pt-product"><div class="pt-pwrap"><span class="pt-chev" aria-hidden="true"></span><span class="pt-thumb">${thumb}</span><span class="pt-name"><b>${plEsc(it.name)}</b><small>${plEsc(it.category || '')}</small>${notCore}${inProd}</span></div></td>`;
}
function plWhyCell(it) {
  const text = PE.reasonFor(it, plCfg());
  const type = PE.categoryOf(it) === 'needs' ? PE.typeLabelOf(it) : null;
  const tag = type === 'Protect Momentum' || type === 'Revive momentum' ? `<small class="pt-why-tag">${plEsc(type)}</small>` : '';
  return `<td class="pt-why"><span class="pt-why-text">${plEsc(text)}</span>${tag}</td>`;
}
function plStockCell(it) {
  const f = it.facts || {};
  if (f.stock_units === null || f.stock_units === undefined) return `<td class="pt-num" title="Stock has not loaded">${plNone}</td>`;
  const warn = PE.stockWarning(it);
  return `<td class="pt-num" title="${plEsc(it.stock && it.stock.notes ? it.stock.notes.join(' ') : '')}"><b>${plNum(f.stock_units)}</b>${warn ? `<small class="pt-warn">${plEsc(warn)}</small>` : ''}</td>`;
}
function plSalesCell(it) {
  const f = it.facts || {};
  if (f.units30 === null || f.units30 === undefined) return `<td class="pt-num" title="Sales have not loaded">${plNone}</td>`;
  const partial = f.demand_basis === 'since_launch' && f.days_on_sale ? `<small>${f.days_on_sale}d on sale</small>` : '';
  return `<td class="pt-num" title="${plEsc(((it.demand && it.demand.evidence) || []).join(' '))}"><b>${plNum(f.units30)}</b>${partial}</td>`;
}
function plPrioCell(it) {
  return `<td class="pt-prio">${it.actionable && it.priority ? `<span class="opp-priority" data-priority="${plEsc(it.priority)}" title="Score ${it.score} of 100">${plEsc(it.priority)}</span>` : plNone}</td>`;
}

const PL_COLS = [
  { key: 'product', label: () => 'Product', w: 'pt-w-product', cell: plProductCell, sort: (i) => String(i.name).toLowerCase() },
  { key: 'why', label: (cat) => (cat === 'needs' ? 'Why it needs creative' : 'Assessment'), w: 'pt-w-why', cell: plWhyCell },
  { key: 'stock', label: () => 'Stock', w: 'pt-w-num', cell: plStockCell, sort: (i) => (i.facts || {}).stock_units },
  { key: 'u30', label: () => 'Sales 30d', w: 'pt-w-num', cell: plSalesCell, sort: (i) => (i.facts || {}).units30 },
  { key: 'priority', label: () => 'Priority', w: 'pt-w-prio', cell: plPrioCell, sort: (i) => (i.actionable ? PL_PRIO_ORDER[i.priority] * 1000 + i.score : -1) },
];

// ── expandable details: A recommendation, B key facts, C suggested direction, D production, E detailed evidence (collapsed), F action ──
function plSection(title, body) { return body ? `<section class="pt-sec"><h5>${plEsc(title)}</h5>${body}</section>` : ''; }
const plList = (arr) => `<ul>${arr.filter(Boolean).map((x) => `<li>${plEsc(x)}</li>`).join('')}</ul>`;
function plPipelineLine(it) {
  const p = it.pipeline;
  if (!p || !p.planned) return '';
  const st = p.by_stage || {};
  const parts = PL_STAGE_ORDER.filter((k) => st[k]).map((k) => `${st[k]} ${PL_STAGE_LABEL[k].toLowerCase()}`);
  return `In the Shoot Plan pipeline: ${parts.join(', ') || `${p.planned} in progress`}.${p.uploaded_recent ? ` ${plPlural(p.uploaded_recent, 'concept')} uploaded recently.` : ''}`;
}
function plAgeStamp(iso) {
  const t = Date.parse(iso); if (!Number.isFinite(t)) return 'unknown';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago`;
}
// the evidence the recommendation rests on (kept intact from Batch 27; only moved behind "View detailed evidence")
function plEvidenceHtml(it) {
  const act = it.actionable; const f = it.facts || {}; const dq = it.data_quality || {};
  const why = (it.why || []);
  const byKey = (k) => (why.find((w) => w.k === k) || {}).text;
  const engine = plList([byKey('summary') || it.headline, byKey('gap'), byKey('performing'), byKey('recent'), it.other_explanations && it.other_explanations.length ? `Other possible reasons for a sales change: ${it.other_explanations.join(' ')}` : '']);
  const sales = plList([...(it.demand && it.demand.evidence ? it.demand.evidence : []), f.units7 !== null && f.units7 !== undefined ? `Units: ${plNum(f.units7)} in 7 days${f.units14 !== null && f.units14 !== undefined ? `, ${plNum(f.units14)} in 14 days` : ''}, ${plNum(f.units30)} in 30 days (ApparelMagic online sales; each window includes today, a part day).` : '', it.revival ? `Launch pace: ${plNum(it.revival.initial28)} units in the first 28 days, ${plNum(it.revival.recent28)} in the latest 28 (${it.revival.ratio_pct === null ? 'no baseline' : `${it.revival.ratio_pct}% of launch pace`}), from the Shopify export (Demand Planning). A drop in sales is not automatically creative fatigue.` : '', ...(dq.sales_notes || []), dq.discrepancy ? `Sources: ${dq.discrepancy.text}.` : ''].filter(Boolean));
  const stock = plList(it.stock && it.stock.notes ? it.stock.notes : []);
  const seas = it.season ? plList([...(it.season.reasons || []), `Source: ${it.season.source === 'sales_pattern' ? 'its own monthly sales pattern' : it.season.source === 'category_prior' ? "WNDRR's Australian category rule (not measured sales)" : 'no seasonal rule applies'}.`]) : '';
  const cre = (it.creatives || []).length
    ? `<table class="pt-mini"><thead><tr><th>Creative / ad</th><th>Condition</th><th>Funnel</th><th>Started</th><th>Last delivery</th><th class="num">Spend (${plCfg().window_days || 14}d)</th><th class="num">Lifetime</th><th class="num">CPA</th><th>Why</th></tr></thead><tbody>${it.creatives.slice(0, 12).map((c) => `<tr><td>${plEsc(c.concept || 'unclassified')}${c.ad_ids && c.ad_ids[0] ? ` <small title="Meta ad id">${plEsc(String(c.ad_ids[0]))}${c.ads > 1 ? ` +${c.ads - 1}` : ''}</small>` : ''}</td><td>${plEsc(c.label)}</td><td>${plEsc(c.funnel || (c.mixed_funnels ? 'several' : 'unknown'))}</td><td>${c.started ? `${plEsc(PE.longDate(c.started))}<small>${c.started_basis === 'first_delivery' ? 'first delivery' : c.started_basis === 'created' ? 'ad created' : 'history starts here'}</small>` : plNone}</td><td>${c.last_delivery ? plEsc(PE.longDate(c.last_delivery)) : plNone}</td><td class="num">${c.spend ? `$${plNum(Math.round(c.spend))}` : plNone}</td><td class="num">${c.lifetime_spend ? `$${plNum(Math.round(c.lifetime_spend))}` : plNone}</td><td class="num">${c.cpa ? `$${plNum(Math.round(c.cpa))}` : plNone}</td><td>${plEsc((c.reasons || [])[0] || '')}</td></tr>`).join('')}</tbody></table>`
    : '<p class="hint">No active creative with delivery for this product (confirmed ads only).</p>';
  const creative = `${cre}${it.evidence && it.evidence.notes && it.evidence.notes.length ? plList(it.evidence.notes) : ''}<p class="hint">Judged against the approved Meta Performance benchmarks only (Meta-reported CPA; Triple Whale is not connected and is never substituted). DPAs are not counted. A relative worsening within the benchmark is "softening", not fatigue. Creatives with no approved benchmark for their funnel are shown as unrated, never as good or bad.</p>`;
  const matching = plList([byKey('matching'), f.matching === 'uncertain' ? `${f.matching_pending} suggested ad(s) are awaiting review in Ad Matching, so a creative gap cannot be confirmed yet.` : '']);
  const other = plList([it.also_qualifies && it.also_qualifies.length ? `Also qualifies as: ${it.also_qualifies.map((a) => `${a.label} (${a.priority || '-'}, score ${a.score})`).join('; ')}. One primary recommendation is shown.` : '', it.classification ? `Classification: ${it.classification}.` : '', `Engine status: ${it.status_label}.`]);
  const score = act && it.score_parts ? `<table class="pt-mini"><tbody>${it.score_parts.map((p) => `<tr><td>${plEsc(p.label)}</td><td class="num">${p.points >= 0 ? '+' : ''}${p.points}${p.max ? `<small> / ${p.max}</small>` : ''}</td></tr>`).join('')}<tr class="pt-total"><td>Score</td><td class="num">${it.score} / 100</td></tr></tbody></table>${(it.caps || []).length ? plList(it.caps) : ''}<p class="hint">High ${plCfg().priority_high_min || 65}+, Medium ${plCfg().priority_medium_min || 45}+. High needs strong or steady demand and complete data.</p>` : '';
  const elig = (it.eligibility || []).length ? `<ul class="pt-elig">${it.eligibility.map((e) => `<li class="${e.ok ? 'ok' : 'no'}"><b>${e.ok ? 'Met' : 'Not met'}</b> ${plEsc(e.text)}</li>`).join('')}</ul>` : '';
  const q = state.opportunities && state.opportunities.data && state.opportunities.data.quality;
  const fresh = q ? plList([`Recent sales: ${q.recent_sales.source}. Read ${q.recent_sales.fetched_at ? plAgeStamp(q.recent_sales.fetched_at) : 'not yet'}${q.recent_sales.failed_requests ? `; ${q.recent_sales.failed_requests} daily requests failed` : ''}.`, `Launch pace and tier: ${q.launch_pace.source}. ${q.launch_pace.fetched_at ? `Read ${plAgeStamp(q.launch_pace.fetched_at)}.` : 'Not loaded.'}`, `Meta: last successful sync ${q.meta.last_successful_sync ? plAgeStamp(q.meta.last_successful_sync) : 'unknown'}; ad status as of ${q.meta.ads_status_as_of ? plAgeStamp(q.meta.ads_status_as_of) : 'unknown'}.`]) : '';
  return `<div class="pt-detail pl-evidence-grid">
    ${plSection('How the engine reached this', engine)}${plSection('Sales evidence', sales)}${plSection('Stock evidence', stock)}${plSection('Seasonal assessment', seas)}
    ${plSection('Creative performance', creative)}${plSection('Matching confidence', matching)}${plSection('Score breakdown', score)}${plSection('Eligibility rules', elig)}${plSection('Other classifications', other)}${plSection('Data freshness', fresh)}
  </div>`;
}
// which colourways can be shot now (active, enough AVAILABLE stock, a usable size run), with what stops the others. Nothing is guessed: where size data is not available it says so.
function plColourwaysHtml(it) {
  const cws = it.colourways || [];
  if (!cws.length) return '';
  const ro = plReadOnly();
  const row = (c) => {
    const sizes = c.sizes ? `${c.sizes.available_sizes} of ${c.sizes.total_sizes} sizes in stock${c.sizes.low && c.sizes.low.length ? ` (low or sold out: ${c.sizes.low.join(', ')})` : ''}` : 'Size data not available';
    const thumb = c.image_url ? `<img src="${plEsc(c.image_url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
    return `<li class="pl-cw${c.viable ? '' : ' pl-cw-off'}"><span class="pt-thumb pl-cw-thumb">${thumb}</span><span class="pl-cw-name"><b>${plEsc(c.colour_label || c.style_code)}</b><small>${plEsc(c.style_code)}</small></span><span class="pl-cw-stock"><b>${plNum(c.soh)}</b> available<small>${plEsc(sizes)}</small></span><span class="pl-cw-state">${c.viable ? '<span class="pl-cw-ok">Can be shot now</span>' : `<span class="pl-cw-no">${plEsc(c.restriction || 'Not shootable')}</span>`}</span>${c.viable && !ro && !PL_BLOCKED.includes(it.status) ? `<button type="button" class="link-btn" data-opp-plan="${plEsc(it.key)}" data-opp-colour="${plEsc(c.style_code)}">Plan this colourway</button>` : '<span></span>'}</li>`;
  };
  const viable = cws.filter((c) => c.viable).length;
  return `<section class="pl-d-sec pl-d-cw"><h5>Colourways <span class="pl-cw-count">${viable} of ${cws.length} can be shot now</span></h5><ul class="pl-cw-list">${cws.map(row).join('')}</ul></section>`;
}
const PL_BLOCKED = ['not_launched', 'launch_unknown', 'unavailable'];
function plInThisWeeksPlan(it) {
  const codes = new Set((it.codes || []).concat(it.product_code ? [it.product_code] : []));
  return (state.shootPlan || []).some((s) => codes.has(s.product_code));
}
function plActionHtml(it) {
  if (plReadOnly()) return '<span class="hint">Past weeks are read-only.</span>';
  if (PL_BLOCKED.includes(it.status)) return `<span class="hint">This product cannot be planned yet: ${plEsc(PE.reasonFor(it, plCfg()))}</span>`;
  const prod = PE.productionActivity(it, PL_STAGE_LABEL);
  const inPlan = plInThisWeeksPlan(it);
  const notes = [inPlan ? "This product is already in this week's Shoot Plan, so adding it again updates that same entry rather than creating a duplicate." : '', prod.active ? `${prod.text} Planning another concept adds to it, so check you do not need a duplicate.` : ''].filter(Boolean);
  const needs = PE.categoryOf(it) === 'needs';
  const label = needs ? (prod.active || inPlan ? 'Add another concept' : 'Add to Shoot Plan') : 'Plan anyway';
  const btn = `<button type="button" class="btn ${needs ? 'btn-primary' : 'btn-ghost'} btn-sm" data-opp-plan="${plEsc(it.key)}"${needs ? '' : ` title="Not a current recommendation. It is planned only if you choose to."`}>${label}</button>`;
  return `${notes.map((n) => `<p class="pl-d-note">${plEsc(n)}</p>`).join('')}<div class="pl-d-actions">${btn}</div>`;
}
function plDetailHtml(it, mode, ncols) {
  const cfg = plCfg();
  const reason = PE.reasonFor(it, cfg);
  const nums = PE.whyWithNumbers(it);
  const pic = PE.conditionsSummary(it);
  const facts = PE.keyFacts(it).map(([k, v]) => `<div><dt>${plEsc(k)}</dt><dd>${plEsc(v)}</dd></div>`).join('');
  const dir = PE.directionFor(it);
  const prod = PE.productionActivity(it, PL_STAGE_LABEL);
  const open = !!state.oppEvidence[`${mode}:${it.key}`];
  return `<tr class="pt-detail-row"><td colspan="${ncols}"><div class="pl-detail">
    <section class="pl-d-sec pl-d-reco"><h5>Recommendation</h5><p class="pl-d-main">${plEsc(PE.recommendationFor(it))}</p><p class="pl-d-why"><b>Why:</b> ${plEsc(reason)}${nums ? ` ${plEsc(nums)}` : ''}</p>${pic ? `<p class="pl-d-why"><b>Creative picture:</b> ${plEsc(pic)}</p>` : ''}</section>
    <section class="pl-d-sec"><h5>Key facts</h5><dl class="pl-facts">${facts}</dl></section>
    ${plColourwaysHtml(it)}
    ${dir.length ? `<section class="pl-d-sec"><h5>Suggested creative direction</h5>${plList(dir)}</section>` : ''}
    <section class="pl-d-sec"><h5>Existing production activity</h5><p class="pl-d-text">${plEsc(prod.text)}</p></section>
    <details class="pl-d-evidence" data-opp-evidence="${mode}:${plEsc(it.key)}"${open ? ' open' : ''}><summary>View detailed evidence</summary>${plEvidenceHtml(it)}</details>
    <div class="pl-d-action">${plActionHtml(it)}</div>
  </div></td></tr>`;
}

// ── filters, sort, rendering ──
// source for a page: the engine's own list, or (Opportunity = Protect Momentum) the recent-launch list that belongs on this page; then search / priority / opportunity filters
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
    const col = PL_COLS.find((c) => c.key === sort.key);
    if (col && col.sort) items = items.slice().sort((a, b) => { const x = col.sort(a); const y = col.sort(b); const nx = x === null || x === undefined; const ny = y === null || y === undefined; if (nx && ny) return 0; if (nx) return 1; if (ny) return -1; const r = x < y ? -1 : x > y ? 1 : 0; return sort.dir === 'asc' ? r : -r; });
  }
  return { base, items, cat };
}
function plSummaryHtml(mode) {
  const o = state.opportunities; const data = plData(mode);
  const c = PE.summaryCounts(mode, data, o.momentum);
  const parts = [`<span class="pl-sum-lead"><b>${c.needs}</b> ${c.needs === 1 ? 'product needs' : 'products need'} creative</span>`];
  if (c.protect) parts.push(`<span>${c.protect} Protect Momentum ${c.protect === 1 ? 'opportunity' : 'opportunities'}</span>`);
  if (c.review) parts.push(`<span>${c.review} ${c.review === 1 ? 'needs' : 'need'} review</span>`);
  const q = o.data && o.data.quality;
  const flags = q ? [q.recent_sales.complete === false ? '<span class="pt-flag" title="Some daily ApparelMagic sales requests failed, so recent sales may be under-counted. No High priority is given on incomplete sales.">Sales may be incomplete</span>' : '', q.families_with_disagreeing_sources ? `<span class="pt-flag" title="ApparelMagic online sales and the Shopify export differ a lot for these products; they are held at Medium.">${q.families_with_disagreeing_sources} with disagreeing sales sources</span>` : ''].join('') : '';
  const step = mode === 'core' ? 'core' : 'high-stocks'; const field = mode === 'core' ? 'core_reviewed' : 'high_stock_reviewed';
  const reviewed = Boolean((state.weeklyPlanningProgress || {})[field]);
  return `<div class="pl-summary">${parts.join('<span class="pl-sum-sep">&middot;</span>')}${flags}<span class="pl-sum-actions"><button type="button" class="btn btn-ghost btn-sm" data-opp-refresh title="Recalculate from the latest sales, stock and Meta data">Refresh</button><button type="button" class="planning-review-btn${reviewed ? ' planning-review-btn-done' : ''}" id="${mode === 'core' ? 'core-review-btn' : 'high-stocks-review-btn'}" data-pl-step="${step}" onclick="toggleWeeklyProgress('${field}')"${plReadOnly() ? ' disabled' : ''}>${reviewed ? '&#10003; Reviewed' : '&#10003; Mark as Reviewed'}</button></span></div>`;
}
function plFilterPanelHtml(mode, base) {
  const fl = state.oppFilter[mode]; const cur = state.oppView[mode];
  // counts follow the search / priority / opportunity filters, so a tab never promises rows that are filtered out
  const counts = {}; PE.CATEGORY_ORDER.forEach((k) => { counts[k] = 0; }); base.forEach((i) => { counts[PE.categoryOf(i)] += 1; });
  const types = new Set(); plData(mode).items.forEach((i) => { if (PE.categoryOf(i) === 'needs') { const t = PE.typeLabelOf(i); if (t) types.add(t); } });
  if (plMomentum(mode).length) types.add('Protect Momentum');
  const typeList = [...types].sort();
  const tabs = PE.CATEGORY_ORDER.map((k) => `<button type="button" role="tab" class="pl-cat${k === cur ? ' active' : ''}" data-opp-view="${mode}:${k}" aria-selected="${k === cur}">${plEsc(PE.CATEGORY[k].tab)} <b>${counts[k]}</b></button>`).join('');
  return `<div class="mp-table-toolbar pl-filters">
    <div class="pl-cats" role="tablist" aria-label="${PL_MODE_NAME[mode]} status">${tabs}</div>
    <div class="pl-fields">
      <label class="pl-f"><span>Opportunity</span><select data-opp-filter="${mode}:type"><option value="">All</option>${typeList.map((t) => `<option value="${plEsc(t)}"${fl.type === t ? ' selected' : ''}>${plEsc(t)}</option>`).join('')}</select></label>
      <label class="pl-f"><span>Priority</span><select data-opp-filter="${mode}:priority"><option value="">All</option>${['High', 'Medium', 'Low'].filter((p) => p !== 'Low' || plData(mode).items.some((i) => i.actionable && i.priority === 'Low')).map((p) => `<option value="${p}"${fl.priority === p ? ' selected' : ''}>${p}</option>`).join('')}</select></label>
      <input type="search" class="opp-search mp-search-box" data-opp-search="${mode}" placeholder="Search products" value="${plEsc(state.oppQuery[mode])}" aria-label="Search products">
      ${fl.priority || fl.type || state.oppSort[mode] || state.oppQuery[mode] ? `<button type="button" class="link-btn" data-opp-reset="${mode}">Clear</button>` : ''}
    </div></div>`;
}
function plTableHtml(mode, items, cat) {
  const sort = state.oppSort[mode];
  const head = PL_COLS.map((c) => `<th class="${c.w || ''}${c.sort ? ' pt-sortable' : ''}${sort && sort.key === c.key ? ' sorted' : ''}"${c.sort ? ` data-opp-sort="${mode}:${c.key}" role="button" tabindex="0" aria-sort="${sort && sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"` : ''}>${plEsc(c.label(cat))}${sort && sort.key === c.key ? `<span class="pt-arrow">${sort.dir === 'asc' ? '&uarr;' : '&darr;'}</span>` : ''}</th>`).join('');
  const limit = state.oppLimit[mode] || PL_PAGE;
  const body = items.slice(0, limit).map((it) => {
    const open = !!state.oppOpen[`${mode}:${it.key}`];
    return `<tr class="pt-row${open ? ' open' : ''}${cat === 'needs' ? '' : ' pt-quiet'}" data-opp-row="${mode}:${plEsc(it.key)}" data-status="${plEsc(it.status)}" data-category="${plEsc(cat)}" tabindex="0" aria-expanded="${open}">${PL_COLS.map((c) => c.cell(it, mode)).join('')}</tr>${open ? plDetailHtml(it, mode, PL_COLS.length) : ''}`;
  }).join('');
  return `<div class="pt-wrap"><table class="pt-table pl-table pt-${plEsc(mode)}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${items.length > limit ? `<div class="pt-more"><button type="button" class="btn btn-ghost btn-sm" data-opp-more="${mode}">Show ${Math.min(PL_PAGE, items.length - limit)} more (${items.length - limit} not shown)</button></div>` : ''}`;
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
  return plTableHtml(mode, items, cat);
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
  const base = plBase(mode);
  return `<div class="opp-panel pl-page" data-opp-panel="${mode}">${extra}${plSummaryHtml(mode)}${plFilterPanelHtml(mode, base)}${plListHtml(mode)}</div>`;
}
function plRenderCore() {
  const host = document.getElementById('core-plan');
  if (!host) return;
  const o = state.opportunities;
  if (!o || !o.available) { host.innerHTML = plUnavailableHtml(); return; }
  host.innerHTML = plPageHtml('core');
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
  const view = ev.target.closest('[data-opp-view]');
  if (view) { const [mode, key] = view.dataset.oppView.split(':'); state.oppView[mode] = key; state.oppLimit[mode] = PL_PAGE; plRerender(mode); return; }
  if (ev.target.closest('[data-opp-refresh]')) { plLoadOpportunities(true); return; }
  const plan = ev.target.closest('[data-opp-plan]');
  if (plan) { plPlan(plan.dataset.oppPlan, plan.dataset.oppColour || null); return; }
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

// ── choosing a product: the explicit step into the Shoot Plan (via the existing modal) ──
async function plPlan(key, colourCode = null) {
  if (plReadOnly()) return;
  const it = plFindItem(key);
  const prod = it ? PE.productionActivity(it, PL_STAGE_LABEL) : { active: false };
  if (prod.active && !(await confirmDialog(`${it.name} already has production activity. ${prod.text} Plan another concept anyway?`, { okLabel: 'Plan another concept' }))) return;
  try {
    const prep = await api('/opportunities/prepare-shoot', { method: 'POST', body: JSON.stringify({ key }) });
    if (!prep.product_code) return toast('This product has no product code, so it cannot be planned here', true);
    openShootPlanModal({
      productCode: prep.product_code, productName: prep.product_name, category: prep.category, colours: prep.colours, source: prep.source,
      opp: { headline: prep.headline, snapshot: prep.snapshot, kinds: prep.kinds, tags: prep.tags, status: prep.status, pipeline: prep.pipeline },
      preselectStyleCodes: colourCode ? [colourCode] : null,
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

// the Shoot Plan section's production progress (moved here from the top of Planning): concepts against the target, what still needs organising, and every stage
function plRenderShootPlanProgress() {
  const host = document.getElementById('shoot-plan-progress');
  if (!host) return;
  const p = state.conceptProgress;
  if (!p) { host.innerHTML = ''; return; }
  const sf = state.opportunities && state.opportunities.shortfall;
  const noConcept = (state.shootPlan || []).filter((i) => !plConceptsFor(i.id).filter((c) => !c.killed).length).length;
  const carry = p.carryover && p.carryover.count ? `<details class="opp-more"><summary>${plPlural(p.carryover.count, 'unfinished concept')} from earlier weeks</summary><ul class="pl-concept-list">${p.carryover.concepts.slice(0, 40).map((c) => `<li class="pl-concept"><span class="pl-concept-name">${plEsc(c.name)}</span><span class="pl-stage-tag" data-stage="${plEsc(c.stage)}">${plEsc(c.stage_label)}</span><span class="hint">${plEsc(c.product_name || '')} &middot; week of ${plEsc(c.week_start)}</span></li>`).join('')}</ul><div class="hint">Nothing is reset or removed when a new week starts; these stay in their real stage and are not counted toward this week's target.</div></details>` : '';
  host.innerHTML = `<div class="pl-progress-card"><div class="pl-progress-head"><b>${p.planned} of ${p.target}</b> new concepts planned this week &middot; ${p.remaining} remaining${noConcept ? ` <span class="pl-sp-muted">&middot; ${plPlural(noConcept, 'product')} still need${noConcept === 1 ? 's' : ''} a concept</span>` : ''}</div>
    <div class="pl-sp-label">Production progress</div><div class="pl-stages">${plStageChips(p.counts)}</div>
    ${sf && p.remaining > 0 ? `<div class="pl-shortfall">${plEsc(sf.text)}</div>` : ''}${carry}
    <details class="opp-more"><summary>How concepts are counted</summary><div class="hint">${plEsc(p.definition)}</div></details></div>`;
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
    ${li('Covered / monitoring.', 'Passes the checks and has enough effective creative, brand-new creative still in its first days of delivery, or concepts already in the Shoot Plan.')}
    ${li('Needs review.', 'Passes the checks but something specific stops the creative picture being assessed: ad matches awaiting review, ads with no approved benchmark for their funnel, too little delivery, or no Meta data. The sentence says which.')}
    ${li('Stock restrictions.', `Only available sellable stock counts (never incoming stock). A product needs ${n('opp_min_stock_units', 40)}+ available units, at least one active colourway with ${n('opp_min_stock_units', 40)}+ available units and a usable size run, and enough cover at its current sales pace (${n('stock_min_cover_weeks', 4)}+ weeks). Products that fail are not shown, are re-checked on every refresh, and return by themselves when stock recovers. Work already planned is never removed: it gets a stock warning.`)}
    ${li('Demand qualification.', `A Platinum or Rocket product (Stock Demand Planning) qualifies while it is still selling. Any other product needs steady selling (${n('demand_steady_units', 20)}+ units in 30 days); a recent launch needs strong demand (${n('demand_strong_units', 50)}+ per 30 days, normalised for the days on sale) or Platinum / Rocket.`)}
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
