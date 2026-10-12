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
  { key: 'other', label: 'Not a creative priority', statuses: ['weak_demand', 'low_stock', 'too_new', 'no_proven_demand', 'not_launched', 'launch_unknown'], hint: 'Not selling, low stock, too new, or not launched.' },
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

// ── opportunity cards ────────────────────────────────────────────────────────────────
const plChip = (text, cls, title) => `<span class="pl-chip${cls ? ` ${cls}` : ''}"${title ? ` title="${plEsc(title)}"` : ''}>${plEsc(text)}</span>`;
function plAgeText(days) { return days === null || days === undefined ? 'none found' : days === 0 ? 'today' : days >= 60 ? `${Math.round(days / 30)} months ago` : `${plPlural(days, 'day')} ago`; }

function plFacts(it) {
  const f = it.facts || {};
  const bits = [];
  if (f.stock_units !== null && f.stock_units !== undefined) bits.push(`<span>Stock <b>${plNum(f.stock_units)}</b>${f.cover_weeks ? ` <i>(${f.cover_weeks}w)</i>` : ''}</span>`);
  if (f.units30 !== null && f.units30 !== undefined) bits.push(`<span>Sold 30d <b>${plNum(f.units30)}</b></span>`);
  if (f.initial28 !== null && f.initial28 !== undefined && f.recent28 !== null && f.recent28 !== undefined) bits.push(`<span>Launch 28d <b>${plNum(f.initial28)}</b> &rarr; now <b>${plNum(f.recent28)}</b></span>`);
  bits.push(`<span>Creatives <b>${f.unique_creatives}</b>${f.unique_creatives ? ` <i>(${f.performing} performing${f.declining ? `, ${f.declining} declining` : ''}${f.weak ? `, ${f.weak} weak` : ''}${f.testing ? `, ${f.testing} testing` : ''})</i>` : ''}</span>`);
  bits.push(`<span>Last new <b>${plEsc(plAgeText(f.newest_creative_days))}</b></span>`);
  return `<div class="opp-facts">${bits.join('')}</div>`;
}

function plPipelineLine(it) {
  const p = it.pipeline;
  if (!p || !p.planned) return '';
  const st = p.by_stage || {};
  const parts = PL_STAGE_ORDER.filter((k) => st[k]).map((k) => `${st[k]} ${PL_STAGE_LABEL[k].toLowerCase()}`);
  return `<div class="opp-pipeline">In the Shoot Plan pipeline: ${plEsc(parts.join(', ') || `${p.planned} in progress`)}</div>`;
}

function plCardHtml(it, mode) {
  const open = !!state.oppOpen[`${mode}:${it.key}`];
  const act = it.actionable;
  const ro = plReadOnly();
  const blocked = ['not_launched', 'launch_unknown', 'unavailable'].includes(it.status);
  const button = ro || blocked ? '' : act
    ? `<button type="button" class="btn btn-primary btn-sm" data-opp-plan="${plEsc(it.key)}">Add to Shoot Plan</button>`
    : `<button type="button" class="btn btn-ghost btn-sm" data-opp-plan="${plEsc(it.key)}" title="This product is not a current recommendation (${plEsc(it.status_label)}). It is planned only if you choose to.">Plan anyway</button>`;
  const tags = (it.tags || []).map((t) => plChip(t, t === 'Platinum' ? 'pl-chip-plat' : t === 'Rocket' ? 'pl-chip-rocket' : '')).join('');
  const why = act ? `<ul class="opp-why">${(it.why || []).map((w) => `<li data-why="${plEsc(w.k)}">${plEsc(w.text)}</li>`).join('')}</ul>` : '';
  const dir = act ? `<div class="opp-direction">${it.direction ? `<b>Creative direction</b> ${plEsc(it.direction.text)}` : '<span class="hint">No creative direction is supported by this product\'s own data yet.</span>'}</div>` : '';
  const other = act && it.other_explanations && it.other_explanations.length ? `<div class="opp-other"><b>Other possible reasons for the sales change</b><ul>${it.other_explanations.map((x) => `<li>${plEsc(x)}</li>`).join('')}</ul></div>` : '';
  const cre = it.creatives && it.creatives.length ? `<div class="opp-creatives"><b>Creatives</b><ul>${it.creatives.slice(0, 8).map((c) => `<li>${plEsc(c.label)}${c.concept ? ` &middot; ${plEsc(c.concept)}` : ''}${c.age_days !== null && c.age_days !== undefined ? ` &middot; ${plEsc(plAgeText(c.age_days))}` : ''}${c.cpa ? ` &middot; $${Math.round(c.cpa)} CPA` : ''}</li>`).join('')}</ul></div>` : '';
  const reason = !act ? `<div class="opp-reason">${plEsc(it.reason || '')}</div>` : '';
  const thumb = it.image_url ? `<img src="${plEsc(it.image_url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
  return `<article class="opp-card" data-opp-key="${plEsc(it.key)}" data-status="${plEsc(it.status)}">
    <div class="opp-thumb" aria-hidden="true">${thumb}</div>
    <div class="opp-body">
      <div class="opp-title"><span class="opp-name">${plEsc(it.name)}</span>${it.category ? `<span class="opp-cat">${plEsc(it.category)}</span>` : ''}${tags}${act && it.priority ? `<span class="opp-priority" data-priority="${plEsc(it.priority)}" title="Priority ${plEsc(it.priority)} (score ${it.score})">${plEsc(it.priority)}</span>` : `<span class="opp-status">${plEsc(it.status_label)}</span>`}</div>
      ${act ? `<div class="opp-headline">${plEsc(it.headline)}</div>` : reason}
      ${plFacts(it)}${plPipelineLine(it)}
      <details class="opp-more" data-opp-details="${plEsc(mode)}:${plEsc(it.key)}"${open ? ' open' : ''}><summary>${act ? 'Why this product' : 'Evidence'}</summary>${act ? why + dir + other : ''}${cre}</details>
    </div>
    <div class="opp-action">${button}</div>
  </article>`;
}

function plToolbarHtml(mode, data) {
  const counts = data.counts || {};
  const n = (v) => v.statuses.reduce((s, k) => s + (counts[k] || 0), 0);
  const cur = state.oppView[mode];
  return `<div class="opp-toolbar" role="tablist" aria-label="${mode === 'core' ? 'Core' : 'High Stocks'} views">
    ${PL_VIEWS.map((v) => `<button type="button" role="tab" class="opp-view${v.key === cur ? ' active' : ''}" data-opp-view="${mode}:${v.key}" aria-selected="${v.key === cur}" title="${plEsc(v.hint)}">${plEsc(v.label)} <b>${n(v)}</b></button>`).join('')}
    <input type="search" class="opp-search" data-opp-search="${mode}" placeholder="Search products" value="${plEsc(state.oppQuery[mode])}" aria-label="Search products">
  </div>`;
}

function plListHtml(mode, data) {
  const view = PL_VIEWS.find((v) => v.key === state.oppView[mode]) || PL_VIEWS[0];
  const q = state.oppQuery[mode].trim().toLowerCase();
  const items = data.items.filter((i) => view.statuses.includes(i.status) && (!q || String(i.name).toLowerCase().includes(q) || String(i.category || '').toLowerCase().includes(q)));
  if (!items.length) {
    const empty = view.key === 'act'
      ? `No ${mode === 'core' ? 'Core' : 'High Stocks'} product currently needs new creative.${state.opportunities && state.opportunities.shortfall ? ` ${plEsc(state.opportunities.shortfall.text)}` : ''}`
      : `Nothing here. ${view.hint}`;
    return `<div class="attention-empty opp-empty">${empty}</div>`;
  }
  return `<div class="opp-list">${items.map((i) => plCardHtml(i, mode)).join('')}</div>`;
}

function plBannerHtml(data, mode) {
  const sf = state.opportunities && state.opportunities.shortfall;
  const act = data.actionable;
  const line = `<b>${act}</b> ${mode === 'core' ? 'Core' : 'High Stocks'} product${act === 1 ? '' : 's'} need${act === 1 ? 's' : ''} new creative now.`;
  return `<div class="opp-summary"><span>${line}</span>${sf ? `<span class="hint">${plEsc(sf.text)}</span>` : ''}<button type="button" class="btn btn-ghost btn-sm" data-opp-refresh title="Recalculate from the latest sales, stock and Meta data">Refresh</button></div>`;
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
    <div class="opp-intro">Previously successful (Platinum or Rocket) products that have lost momentum and still have the stock to justify fresh creative. Stock alone is never a reason.</div>
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
document.addEventListener('click', (ev) => {
  const view = ev.target.closest('[data-opp-view]');
  if (view) { const [mode, key] = view.dataset.oppView.split(':'); state.oppView[mode] = key; if (mode === 'core') plRenderCore(); else plRenderHighStocks(); return; }
  if (ev.target.closest('[data-opp-refresh]')) { plLoadOpportunities(true); return; }
  const plan = ev.target.closest('[data-opp-plan]');
  if (plan) { plPlan(plan.dataset.oppPlan); return; }
});
document.addEventListener('toggle', (ev) => {
  const d = ev.target;
  if (d && d.dataset && d.dataset.oppDetails) state.oppOpen[d.dataset.oppDetails] = d.open;
}, true);
document.addEventListener('input', (ev) => {
  const s = ev.target.closest && ev.target.closest('[data-opp-search]');
  if (!s) return;
  const mode = s.dataset.oppSearch; state.oppQuery[mode] = s.value;
  const pos = s.selectionStart;
  if (mode === 'core') plRenderCore(); else plRenderHighStocks();
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

