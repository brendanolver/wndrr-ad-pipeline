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
  const title = plReadOnly() ? "That week's Shoot Plan" : "This Week's Shoot Plan";
  if (!w.loaded) { el.innerHTML = `<div class="pl-week-row"><span class="pl-week-label">${title}</span><span class="pl-week-muted">Concept progress is loading.</span></div>`; return; }
  const bits = [`${plPlural(w.products, 'product')} selected`];
  if (w.carried) bits.push(`${w.carried} carried over from earlier weeks`);
  const pct = w.target ? Math.max(0, Math.min(100, Math.round((w.planned / w.target) * 100))) : 0;
  el.innerHTML = `<div class="pl-week-row"><span class="pl-week-label">${title}</span>
    <span class="pl-week-fig"><b>${w.planned}</b> ${w.planned === 1 ? 'concept' : 'concepts'} planned${w.target ? ` / ${w.target} target` : ''}</span>
    ${w.remaining !== null && w.target ? `<span class="pl-week-sep">&mdash;</span><span class="pl-week-fig">${w.remaining} ${w.remaining === 1 ? 'concept' : 'concepts'} remaining</span>` : ''}
    <span class="pl-week-muted">${plEsc(bits.join(' · '))}</span>
    <button type="button" class="btn btn-sm pl-week-link" onclick="setPlanningStep('shoot-plan')">View Shoot Plan &rarr;</button></div>
    ${w.target ? `<div class="pl-week-goal"><span>Weekly creative goal</span><span class="pl-goal-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${w.target}" aria-valuenow="${w.planned}" aria-label="Concepts planned against the weekly target"><i style="width:${pct}%"></i></span><span class="pl-goal-fig">${w.planned} / ${w.target} concepts</span></div>` : ''}`;
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

// ── rows (Batch 32): PRODUCT | KEY METRICS | CREATIVE STATUS | PRIORITY | ACTION ──
// Wording comes from PlanningExplain.creativeStatus (the engine's own result, never a new classification); the numbers are the existing facts.
const plThumb = (url, cls = '') => (url ? `<img${cls ? ` class="${cls}"` : ''} src="${plEsc(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : '');
function plProductCell(it, mode) {
  const open = !!state.oppOpen[`${mode}:${it.key}`];
  const notCore = it.mode === 'momentum' && !it.is_core ? '<small class="pt-class">Not Core: recent launch</small>' : '';
  const prod = PE.productionActivity(it, PL_STAGE_LABEL);
  const inProd = prod.active ? `<small class="pt-prod" title="${plEsc(prod.text)}">In production</small>` : '';
  return `<td class="pt-product"><div class="pt-pwrap"><span class="pt-chev" aria-hidden="true"></span><span class="pt-thumb">${plThumb(it.image_url)}</span><span class="pt-name"><b>${plEsc(it.name)}</b><small>${plEsc(it.category || '')}</small>${notCore}${inProd}</span></div></td>`;
}
function plMetricsCell(it) {
  const f = it.facts || {}; const lv = PE.liveAds(it); const lc = PE.lastCreative(it);
  const sales = f.units30 === null || f.units30 === undefined ? plNone : `<b>${plNum(f.units30)}</b>`;
  const partial = f.demand_basis === 'since_launch' && f.days_on_sale ? `<em>${f.days_on_sale}d on sale</em>` : '';
  const stock = f.stock_units === null || f.stock_units === undefined ? plNone : `<b>${plNum(f.stock_units)}</b>`;
  const warn = PE.stockWarning(it);
  const live = lv.known ? `<b>${plNum(lv.count)}</b>` : plNone;
  return `<td class="pt-metrics"><div class="pl-metrics">
    <span class="pl-m" title="${plEsc(((it.demand && it.demand.evidence) || []).join(' '))}">${sales}<small>Sales 30D${partial ? ` ${partial}` : ''}</small></span>
    <span class="pl-m" title="${plEsc(it.stock && it.stock.notes ? it.stock.notes.join(' ') : 'Available sellable stock')}">${stock}<small>Stock on hand${warn ? ` <em class="pt-warn">${plEsc(warn)}</em>` : ''}</small></span>
    <span class="pl-m pt-live" title="${plEsc(lv.title)}">${live}<small>Live ads</small></span>
    <span class="pl-m pt-last" title="${plEsc(lc.title)}">${lc.known ? `<b>${plEsc(lc.day)}</b><em class="pl-m-year">${plEsc(lc.year)}</em>` : plNone}<small>Last creative${lc.uncertain ? ' <em class="pt-warn" aria-label="A creative without a valid date may be newer">?</em>' : ''}</small></span></div></td>`;
}
function plStatusCell(it) {
  const st = PE.creativeStatus(it, plCfg());
  const type = PE.categoryOf(it) === 'needs' ? PE.typeLabelOf(it) : null;
  const tag = type === 'Protect Momentum' || type === 'Revive momentum' ? `<small class="pt-why-tag">${plEsc(type)}</small>` : '';
  return `<td class="pt-status"><span class="pl-status" data-tone="${plEsc(st.tone)}"><i aria-hidden="true"></i>${plEsc(st.label)}</span><span class="pt-why-text">${plEsc(st.text)}</span>${tag}</td>`;
}
function plPrioTitle(it) {
  // the SAME evidence the engine scored: the biggest score parts, then every cap that held the priority back (so a badge and its tooltip can never disagree)
  const parts = (it.score_parts || []).filter((p) => p.points > 0).sort((a, b) => b.points - a.points).slice(0, 3).map((p) => `${p.label} (+${p.points})`);
  return `Score ${it.score} of 100.${parts.length ? ` Main reasons: ${parts.join('; ')}.` : ''}${(it.caps || []).length ? ` ${it.caps.join(' ')}` : ''}`;
}
function plPrioCell(it) {
  return `<td class="pt-prio">${it.actionable && it.priority ? `<span class="opp-priority" data-priority="${plEsc(it.priority)}" title="${plEsc(plPrioTitle(it))}">${plEsc(it.priority)}</span>` : plNone}</td>`;
}
// ACTION: "+ Add to Shoot Plan" for products that need creative (becomes "In Shoot Plan" once planned), a subtle View / Review for the others. Every row also has a ... menu with the manual add, so a
// person can always plan a product (never disabled because something is in production; stock restrictions are decided inside the Shoot Plan modal, never bypassed silently).
function plActionCell(it, mode) {
  const cat = PE.categoryOf(it);
  const blocked = plReadOnly() || PL_BLOCKED.includes(it.status);
  const inPlan = plInThisWeeksPlan(it);
  const k = plEsc(it.key);
  let main = '';
  if (cat === 'needs') {
    if (!blocked) main = inPlan
      ? `<button type="button" class="btn btn-sm pl-act pl-act-planned" data-opp-add="${k}" title="Already in this week's Shoot Plan. Click to add another concept." aria-label="${plEsc(it.name)} is in the Shoot Plan. Add another concept">&#10003; In Shoot Plan</button>`
      : `<button type="button" class="btn btn-sm pl-act pl-act-add" data-opp-add="${k}" title="Add this product to this week's Shoot Plan" aria-label="Add ${plEsc(it.name)} to the Shoot Plan">+ Add to Shoot Plan</button>`;
  } else {
    main = `<button type="button" class="btn btn-sm pl-act pl-act-view" data-opp-toggle="${mode}:${k}" aria-label="${cat === 'review' ? 'Review' : 'View'} ${plEsc(it.name)}">${cat === 'review' ? 'Review' : 'View'}</button>`;
  }
  const items = [!blocked && cat !== 'needs' ? `<button type="button" role="menuitem" data-opp-add="${k}">${inPlan ? 'Add another concept' : 'Add to Shoot Plan'}</button>` : '', !blocked && cat === 'needs' && inPlan ? '' : '', `<button type="button" role="menuitem" data-opp-toggle="${mode}:${k}">View details</button>`].filter(Boolean).join('');
  return `<td class="pt-act"><div class="pl-actions">${main}<span class="pl-menu"><button type="button" class="pl-more" data-opp-menu="${k}" aria-haspopup="menu" aria-label="More actions for ${plEsc(it.name)}">&#8943;</button><div class="pl-menu-pop" role="menu" hidden>${items}</div></span></div></td>`;
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
function plEvidenceParts(it) {
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
  return { engine, sales, stock, seas, creative, matching, other, score, elig, fresh };
}
// every distinct live creative of the product (one row per creative, however many campaigns run it)
// the original creative date written in the ad name (a creative made earlier and duplicated into another campaign keeps its original date); the first-delivery date is shown separately
function plCreativeDate(c) {
  const d = PE.creativeDate(c);
  return d.known ? `<b>${plEsc(d.long)}</b>${d.note ? `<small>${plEsc(d.note)}</small>` : ''}` : `${plNone}${d.note ? `<small>${plEsc(d.note)}</small>` : ''}`;
}
function plLiveAdsHtml(it) {
  const lv = PE.liveAds(it);
  const rows = (it.creatives || []).slice().sort((a, b) => (a.live_status === 'delivering' ? 0 : 1) - (b.live_status === 'delivering' ? 0 : 1) || (b.spend || 0) - (a.spend || 0));
  const head = lv.known ? `<p class="pl-d-text"><b>${plNum(lv.count)}</b> unique ${lv.count === 1 ? 'creative' : 'creatives'} delivering in the last ${plPlural(lv.window, 'day')}. Duplicates of the same creative across campaigns are counted once.${lv.pending ? ` ${plPlural(lv.pending, 'active ad')} awaiting review may belong to this product, so this may be incomplete.` : ''}</p>` : `<p class="pl-d-text">${plEsc(lv.title)}${lv.pending ? ` ${plPlural(lv.pending, 'active ad')} awaiting review may belong to this product.` : ''}</p>`;
  if (!rows.length) return `<section class="pl-d-sec pl-live"><h5>Live ads</h5>${head}<p class="hint">No active, matched ads for this product (DPAs are not counted).</p></section>`;
  const perf = (c) => {
    const fr = (c.funnel_results || []).filter((f) => f.spend);
    const per = fr.length > 1 ? fr.map((f) => `<small>${plEsc(plFn(f.funnel))}: ${plEsc(plStateWord(f.state))}, $${plNum(Math.round(f.spend))}${f.cpa ? `, CPA $${plNum(Math.round(f.cpa))}` : ''}</small>`).join('') : `${c.spend ? `<small>$${plNum(Math.round(c.spend))} spend${c.cpa ? `, CPA $${plNum(Math.round(c.cpa))}` : ''} (${plCfg().window_days || 14}d)</small>` : ''}`;
    return `${plEsc(c.label || '')}${per}`;
  };
  return `<section class="pl-d-sec pl-live"><h5>Live ads</h5>${head}<table class="pt-mini pl-live-table"><thead><tr><th>Creative</th><th>Creative date</th><th>Format</th><th>Funnel</th><th>Delivery</th><th>Performance</th></tr></thead><tbody>${rows.slice(0, 15).map((c) => `<tr class="${c.live_status === 'delivering' ? 'pl-live-on' : 'pl-live-off'}"><td>${plEsc(c.name || c.concept || 'Unnamed creative')}${c.concept && c.name ? `<small>${plEsc(c.concept)}</small>` : ''}</td><td class="pl-live-cdate">${plCreativeDate(c)}</td><td>${plEsc(c.format || 'Unknown')}</td><td>${plEsc(c.funnel || (c.mixed_funnels ? 'Several' : 'Unknown'))}</td><td>${plEsc(c.live_label || '')}${c.first_delivery ? `<small>first delivery ${plEsc(PE.longDate(c.first_delivery))}${c.started_from_other_ad ? ' (earlier copy)' : ''}</small>` : ''}${c.last_delivery ? `<small>last delivery ${plEsc(PE.longDate(c.last_delivery))}</small>` : ''}</td><td>${perf(c)}</td></tr>`).join('')}</tbody></table>${rows.length > 15 ? `<p class="hint">${rows.length - 15} more not shown.</p>` : ''}</section>`;
}
const plFn = (f) => ({ multiple: 'Mixed', unknown: 'Unknown' }[f] || f || 'Unknown'); // campaign taxonomy labels: TOF / TOM / MOF, 'multiple' (several tokens) and 'unknown' (none) exactly as Meta Performance reports them
const plStateWord = (s) => ({ performing: 'performing', underperforming: 'over the approved limit', declining: 'fatigue', unrated: 'no approved benchmark', insufficient: 'insufficient delivery', unavailable: 'no delivery' }[s] || s || '');
// which colourways can be shot now (active, enough AVAILABLE stock, a usable size run) as a compact visual grid; what stops the others is stated. Nothing is guessed: where size data is not
// available it says so. (The colourways to include are chosen in the Shoot Plan modal, which preselects every one that can be shot and asks before including a restricted one.)
function plColourwaysHtml(it) {
  const cws = it.colourways || [];
  if (!cws.length) return '';
  const tile = (c) => {
    const sizes = c.sizes ? `${c.sizes.available_sizes} of ${c.sizes.total_sizes} sizes` : 'Sizes not available';
    const low = c.sizes && c.sizes.low && c.sizes.low.length ? ` title="Low or sold out: ${plEsc(c.sizes.low.join(', '))}"` : '';
    return `<li class="pl-cwt${c.viable ? ' ok' : ' off'}"><span class="pl-cwt-img">${plThumb(c.image_url)}</span><span class="pl-cwt-body"><b>${plEsc(c.style_code)}</b><small>${plEsc(c.colour_label || '')}</small><span class="pl-cwt-stock"><b>${plNum(c.soh)}</b> available</span><span class="pl-cwt-sizes"${low}>${plEsc(sizes)}</span><span class="pl-cwt-state ${c.viable ? 'ok' : 'no'}">${c.viable ? '&#10003; Can be shot' : `&#8856; ${plEsc(c.restriction || 'Not shootable')}`}</span></span></li>`;
  };
  const viable = cws.filter((c) => c.viable).length;
  return `<section class="pl-x-cw"><h5>Available colourways <span class="pl-cw-count">${viable} of ${cws.length} can be shot now</span></h5><ul class="pl-cwt-grid">${cws.map(tile).join('')}</ul></section>`;
}
const PL_BLOCKED = ['not_launched', 'launch_unknown', 'unavailable'];
function plInThisWeeksPlan(it) {
  const codes = new Set((it.codes || []).concat(it.product_code ? [it.product_code] : []));
  return (state.shootPlan || []).some((s) => codes.has(s.product_code));
}
function plMetricCards(it) {
  const f = it.facts || {}; const lv = PE.liveAds(it);
  const sub7 = f.units7 !== null && f.units7 !== undefined ? `${plNum(f.units7)} in the last 7 days` : '';
  const cover = f.cover_weeks !== null && f.cover_weeks !== undefined ? `${f.cover_weeks} weeks of cover` : 'Cover not available';
  const eff = f.active_ads === null || f.active_ads === undefined ? 'Creative data unavailable' : `${plNum(f.performing || 0)} effective`;
  return `<div class="pl-x-metrics">
    <div class="pl-xm"><b>${f.units30 === null || f.units30 === undefined ? plNone : plNum(f.units30)}</b><span>Sales (30 days)</span><small>${plEsc(sub7)}</small></div>
    <div class="pl-xm"><b>${f.stock_units === null || f.stock_units === undefined ? plNone : plNum(f.stock_units)}</b><span>Stock on hand</span><small>${plEsc(cover)}</small></div>
    <div class="pl-xm"><b>${lv.known ? plNum(lv.count) : plNone}</b><span>Active creatives</span><small>${plEsc(eff)}</small></div></div>`;
}
function plDetailHtml(it, mode, ncols) {
  const cfg = plCfg(); const cat = PE.categoryOf(it);
  const st = PE.creativeStatus(it, cfg);
  const prod = PE.productionActivity(it, PL_STAGE_LABEL);
  const inPlan = plInThisWeeksPlan(it);
  const blocked = plReadOnly() || PL_BLOCKED.includes(it.status);
  const ev = plEvidenceParts(it);
  const dir = PE.directionFor(it);
  const pic = PE.conditionsSummary(it);
  const facts = PE.keyFacts(it).map(([k, v]) => `<div><dt>${plEsc(k)}</dt><dd>${plEsc(v)}</dd></div>`).join('');
  const nums = PE.whyWithNumbers(it);
  const k = (n) => `${mode}:${it.key}:${n}`;
  const op = (n) => (state.oppEvidence[k(n)] ? ' open' : '');
  const lv = PE.liveAds(it);
  const planBtn = blocked ? '' : (cat === 'needs'
    ? `<button type="button" class="btn pl-act ${inPlan ? 'pl-act-planned' : 'pl-act-add'}" data-opp-add="${plEsc(it.key)}">${inPlan ? '&#10003; In Shoot Plan: add another concept' : '+ Add to Shoot Plan'}</button>`
    : `<button type="button" class="btn btn-ghost pl-act-plain" data-opp-add="${plEsc(it.key)}" title="Not a current recommendation. It is planned only if you choose to.">${inPlan ? 'Add another concept' : 'Plan anyway'}</button>`);
  const lcd = PE.lastCreative(it);
  const notes = [inPlan ? "In this week's Shoot Plan already: adding again puts the new concept on the same entry." : '', prod.active ? prod.text : ''].filter(Boolean);
  const prio = it.actionable && it.priority ? `<span class="opp-priority" data-priority="${plEsc(it.priority)}" title="${plEsc(plPrioTitle(it))}">${plEsc(it.priority)} priority</span>` : '';
  const sec = (title, body) => (body ? `<section class="pt-sec"><h5>${plEsc(title)}</h5>${body}</section>` : '');
  const whyBody = `${sec('How the engine reached this', ev.engine)}${nums ? sec('In numbers', `<p class="pl-d-text">${plEsc(nums)}</p>`) : ''}${sec('Sales evidence', ev.sales)}${sec('Stock evidence', ev.stock)}${sec('Seasonal assessment', ev.seas)}${sec('Creative performance', ev.creative)}${dir.length ? sec('Suggested creative direction', plList(dir)) : ''}`;
  const adsBody = `${pic ? `<p class="pl-d-why"><b>Creative picture:</b> ${plEsc(pic)}</p>` : ''}${plLiveAdsHtml(it).replace(/<h5>Live ads<\/h5>/, '')}`;
  const moreBody = `<div class="pl-x-more"><section class="pt-sec"><h5>Key facts</h5><dl class="pl-facts">${facts}</dl></section>${sec('Existing production activity', `<p class="pl-d-text">${plEsc(prod.text)}</p>`)}${sec('Other classifications', ev.other)}${sec('Matching confidence', ev.matching)}${sec('Score breakdown', ev.score)}${sec('Eligibility rules', ev.elig)}${sec('Data freshness', ev.fresh)}</div>`;
  return `<tr class="pt-detail-row"><td colspan="${ncols}"><div class="pl-x">
    <div class="pl-x-head">
      <div class="pl-x-img">${plThumb(it.image_url) || '<span class="pl-x-noimg"></span>'}</div>
      <div class="pl-x-main">
        <div class="pl-x-title"><h4>${plEsc(it.name)}</h4><span class="pl-x-cat">${plEsc(it.category || '')}</span>${prio}${prod.active ? '<span class="pt-prod">In production</span>' : ''}</div>
        <div class="pl-x-reco" data-tone="${plEsc(st.tone)}"><span class="pl-x-reco-k">${cat === 'needs' ? 'Recommendation' : cat === 'review' ? 'To resolve' : 'Assessment'}</span><b>${plEsc(PE.recommendationFor(it))}</b><span>${plEsc(PE.reasonFor(it, cfg))}</span></div>
        <p class="pl-x-last" title="${plEsc(lcd.title)}"><span>Last Creative Uploaded</span> <b>${lcd.known ? plEsc(lcd.long) : 'Not available'}</b>${lcd.caveat ? ` <small>${plEsc(lcd.caveat)}</small>` : ''}</p>
        ${notes.length ? `<p class="pl-d-note">${plEsc(notes.join(' '))}</p>` : ''}
      </div>
      <div class="pl-x-act">${planBtn}${PL_BLOCKED.includes(it.status) ? `<span class="hint">This product cannot be planned yet.</span>` : ''}${plReadOnly() ? '<span class="hint">Past weeks are read-only.</span>' : ''}</div>
    </div>
    ${plMetricCards(it)}
    ${plColourwaysHtml(it)}
    <details class="pl-x-d" data-opp-evidence="${k('why')}"${op('why')}><summary><b>Why was this product recommended?</b><span>Sales, stock, creative matching, seasonality and scoring breakdown</span></summary><div class="pl-x-body pl-evidence-grid">${whyBody}</div></details>
    <details class="pl-x-d" data-opp-evidence="${k('ads')}"${op('ads')}><summary><b>Recent live ads (${lv.known ? lv.count : '?'})</b><span>${lv.known && lv.count ? 'Matched Meta creatives, delivery and performance' : 'No active, matched ads for this product (DPAs are not counted)'}</span></summary><div class="pl-x-body">${adsBody}</div></details>
    <details class="pl-x-d" data-opp-evidence="${k('more')}"${op('more')}><summary><b>Additional details</b><span>Classification, data freshness, eligibility rules and more</span></summary><div class="pl-x-body">${moreBody}</div></details>
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
    const def = PL_SORTS[sort.key]; const col = def && (!def.only || def.only === cat) ? { sort: def.get } : null;
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
  const tabs = PE.CATEGORY_ORDER.map((k) => `<button type="button" role="tab" class="pl-cat${k === cur ? ' active' : ''}" data-cat="${k}" data-opp-view="${mode}:${k}" aria-selected="${k === cur}">${plEsc(PE.CATEGORY[k].tab)} <b>${counts[k]}</b></button>`).join('');
  return `<div class="mp-table-toolbar pl-filters">
    <div class="pl-cats" role="tablist" aria-label="${PL_MODE_NAME[mode]} status">${tabs}</div>
    <div class="pl-fields">
      <label class="pl-f"><span>Opportunity</span><select data-opp-filter="${mode}:type"><option value="">All</option>${typeList.map((t) => `<option value="${plEsc(t)}"${fl.type === t ? ' selected' : ''}>${plEsc(t)}</option>`).join('')}</select></label>
      ${cur === 'needs' ? `<label class="pl-f"><span>Priority</span><select data-opp-filter="${mode}:priority"><option value="">All</option>${['High', 'Medium', 'Low'].filter((p) => p !== 'Low' || plData(mode).items.some((i) => i.actionable && i.priority === 'Low')).map((p) => `<option value="${p}"${fl.priority === p ? ' selected' : ''}>${p}</option>`).join('')}</select></label>` : ''}
      <label class="pl-f"><span>Sort</span><select data-opp-sort-select="${mode}"><option value="">Recommended order</option>${plSortsFor(cur).map(([key, v]) => `<option value="${key}"${state.oppSort[mode] && state.oppSort[mode].key === key ? ' selected' : ''}>${plEsc(v.label)}</option>`).join('')}</select></label>
      <input type="search" class="opp-search mp-search-box" data-opp-search="${mode}" placeholder="Search products" value="${plEsc(state.oppQuery[mode])}" aria-label="Search products">
      ${fl.priority || fl.type || state.oppSort[mode] || state.oppQuery[mode] ? `<button type="button" class="link-btn" data-opp-reset="${mode}">Clear</button>` : ''}
    </div></div>`;
}
function plTableHtml(mode, items, cat) {
  const sort = state.oppSort[mode];
  const th = (label, cls, key) => { const def = key && PL_SORTS[key] && (!PL_SORTS[key].only || PL_SORTS[key].only === cat) ? key : null; const on = def && sort && sort.key === def; return `<th class="${cls}${def ? ' pt-sortable' : ''}${on ? ' sorted' : ''}"${def ? ` data-opp-sort="${mode}:${def}" role="button" tabindex="0" aria-sort="${on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"` : ''}>${plEsc(label)}${on ? `<span class="pt-arrow">${sort.dir === 'asc' ? '&uarr;' : '&darr;'}</span>` : ''}</th>`; };
  const showPrio = cat === 'needs';
  const ncols = showPrio ? 5 : 4;
  const head = `${th('Product', 'pt-w-product', 'product')}${th('Key metrics', 'pt-w-metrics', null)}${th('Creative status', 'pt-w-status', null)}${showPrio ? th('Priority', 'pt-w-prio', 'priority') : ''}${th('Action', 'pt-w-act', null)}`;
  const limit = state.oppLimit[mode] || PL_PAGE;
  const body = items.slice(0, limit).map((it) => {
    const open = !!state.oppOpen[`${mode}:${it.key}`];
    return `<tr class="pt-row${open ? ' open' : ''}${cat === 'needs' ? '' : ' pt-quiet'}" data-opp-row="${mode}:${plEsc(it.key)}" data-status="${plEsc(it.status)}" data-category="${plEsc(cat)}" tabindex="0" aria-expanded="${open}">${plProductCell(it, mode)}${plMetricsCell(it)}${plStatusCell(it)}${showPrio ? plPrioCell(it) : ''}${plActionCell(it, mode)}</tr>${open ? plDetailHtml(it, mode, ncols) : ''}`;
  }).join('');
  return `<div class="pt-wrap"><table class="pt-table pl-table pl-table-v2 pt-${plEsc(mode)}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${items.length > limit ? `<div class="pt-more"><button type="button" class="btn btn-ghost btn-sm" data-opp-more="${mode}">Show ${Math.min(PL_PAGE, items.length - limit)} more</button></div>` : ''}`;
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
  if (plan) { plPlan(plan.dataset.oppPlan, plan.dataset.oppColour || null); return; }
  const quick = ev.target.closest('[data-opp-add]');
  if (quick) { plPlan(quick.dataset.oppAdd, null, { noConfirm: false }); return; }
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

// ── choosing a product: the explicit step into the Shoot Plan (via the existing modal) ──
async function plPlan(key, colourCode = null, extra = {}) {
  if (plReadOnly()) return;
  const it = plFindItem(key);
  const prod = it ? PE.productionActivity(it, PL_STAGE_LABEL) : { active: false };
  try {
    const prep = await api('/opportunities/prepare-shoot', { method: 'POST', body: JSON.stringify({ key }) });
    if (!prep.product_code) return toast('This product has no product code, so it cannot be planned here', true);
    // a product already in THIS week's Shoot Plan gets the new concept added to its record (never a duplicate product or concept)
    const additional = (state.shootPlan || []).some((i) => i.product_code === prep.product_code && !i.promotion_stage_id);
    const snapshot = extra.reason ? { ...(prep.snapshot || {}), reason: extra.reason, why: [extra.reason, ...(((prep.snapshot || {}).why) || [])], concept: extra.concept || null } : prep.snapshot;
    openShootPlanModal({
      productCode: prep.product_code, productName: prep.product_name, category: prep.category, colours: prep.colours, source: prep.source,
      opp: { headline: extra.reason || prep.headline, snapshot, kinds: prep.kinds, tags: prep.tags, status: prep.status, pipeline: prep.pipeline },
      preselectStyleCodes: colourCode ? [colourCode] : null, // otherwise every colourway that can be shot is ticked; restricted ones are listed, unticked, with the reason
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
  await plPlan(itemKey, null, { concept: conceptLabel, reason: s ? s.reason : null, noConfirm: true });
}
document.addEventListener('change', (ev) => { const f = ev.target.closest && ev.target.closest('[data-ins-status]'); if (f) { plInsState().status = f.value; plRenderInsights(); } });
document.addEventListener('input', (ev) => {
  const s = ev.target.closest && ev.target.closest('[data-ins-search]'); if (!s) return;
  plInsState().query = s.value; const pos = s.selectionStart; plRenderInsights();
  const again = document.querySelector('[data-ins-search]'); if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) { /* not supported */ } }
});
document.addEventListener('keydown', (ev) => { const t = ev.target; if (t && t.dataset && t.dataset.insRow && ev.key === 'Enter' && ev.target === t) { ev.preventDefault(); t.click(); } });
