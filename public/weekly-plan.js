'use strict';
// Weekly Plan (Batch 12): the video-based weekly production view.
//   * the production header ("WEEK 42 - CREATIVE PRODUCTION"): target, recommended, planned, sent, in production, completed, remaining
//   * the Weekly Plan step: ranked recommendations in four categories, each with its reasons, effective coverage, season outlook and creative mix
//   * the quantity + mix fields of the "Shoot This Week" modal, and the per-product video quantities on the Shoot Plan
// Nothing here creates production records on its own: a recommendation only becomes a Shoot Plan entry when a person chooses "Plan N videos" and confirms
// the modal. Loaded after app.js (shares its globals: state, api, apiAllowedOr, toast, escapeHtml, openShootPlanModal ...).

state.weeklyVideoPlan = null;
state.weeklyVideoPlanError = null;
state.weeklyPlanTab = 'SHOOT_NOW';
state.weeklyPlanOpen = {};

const WP_CATEGORIES = [
  { key: 'SHOOT_NOW', label: 'Shoot now', cls: 'wp-cat-shoot', hint: 'Needs new creative this week.' },
  { key: 'COMING_UP', label: 'Coming up', cls: 'wp-cat-coming', hint: 'Worth preparing, not urgent this week.' },
  { key: 'MONITOR', label: 'Monitor', cls: 'wp-cat-monitor', hint: 'No new creative needed yet.' },
  { key: 'NO_ACTION', label: 'No action', cls: 'wp-cat-none', hint: 'No worthwhile creative opportunity right now.' },
];
const WP_CAT_BY_KEY = Object.fromEntries(WP_CATEGORIES.map((c) => [c.key, c]));
const WP_BASIS_LABEL = { evidence: 'Evidence-based', gap: 'Fills a gap', exploratory: 'Exploratory' };
const WP_PERF_LABEL = {
  healthy: 'Healthy creative', mixed: 'Mixed results', thin: 'Thin effective coverage', unclear: 'Unclear', no_creative: 'No creative running',
};
const WP_PERF_CLASS = { healthy: 'wp-ok', mixed: 'wp-warn', thin: 'wp-bad', unclear: 'wp-muted', no_creative: 'wp-bad' };

const wpEsc = (v) => escapeHtml(v === null || v === undefined ? '' : String(v));
const wpPlural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;

let wpLoadSeq = 0;
async function loadWeeklyVideoPlan(fresh) {
  const seq = ++wpLoadSeq;
  try {
    const plan = await apiAllowedOr(`/weekly-video-plan?week_start=${planningWeekStart()}${fresh ? '&fresh=1' : ''}`, null);
    if (seq !== wpLoadSeq) return; // a newer request (another week, or a newer change) supersedes this one
    state.weeklyVideoPlan = plan;
    state.weeklyVideoPlanError = null;
  } catch (e) {
    if (seq !== wpLoadSeq) return;
    state.weeklyVideoPlanError = e.message;
  }
  try { renderWeeklyPlan(); } catch (e) { console.error('renderWeeklyPlan failed', e); }
}

// ── production header ─────────────────────────────────
// Planned / sent / in production / completed come from the Shoot Plan the page already shows, so this header can never disagree with the list below it;
// only "recommended" needs the engine.
function wpWeekTotals() {
  const items = Array.isArray(state.shootPlan) ? state.shootPlan : [];
  const sum = (f) => items.reduce((s, i) => s + (Number(f(i)) || 0), 0);
  const planned = sum((i) => i.planned_videos || 1);
  const confirmed = Boolean(state.weeklyShootPlanConfirmation);
  return {
    planned, sent: confirmed ? planned : 0, inProduction: sum((i) => i.videos_in_production), completed: sum((i) => i.videos_completed), confirmed,
  };
}

function wpVideosStatHtml() {
  const t = wpWeekTotals();
  return `<span><strong>${t.planned}</strong> Video${t.planned === 1 ? '' : 's'}</span>`;
}

function renderProductionHeader() {
  const el = document.getElementById('planning-production-header');
  if (!el) return;
  const plan = state.weeklyVideoPlan;
  const settings = state.planningSettings || {};
  const target = Number((plan && plan.production && plan.production.target) || settings.weekly_video_target || 25);
  const t = wpWeekTotals();
  const recommended = plan && plan.available && plan.production ? plan.production.recommended : null;
  const remaining = Math.max(0, target - t.planned);
  const pct = target > 0 ? Math.min(100, Math.round((t.planned / target) * 100)) : 0;
  const over = t.planned > target;
  const monday = mondayOfWeek(state.planningWeekOffset);
  const readOnly = state.planningWeekOffset < 0;
  const cell = (key, label, value, hint, cls) => `<div class="prod-stat ${cls || ''}" role="listitem" data-stat="${key}"><div class="prod-stat-value">${value}</div><div class="prod-stat-label">${label}</div><div class="prod-stat-hint">${hint}</div></div>`;
  el.innerHTML = `
    <div class="prod-header-top">
      <div>
        <h2 class="prod-title">WEEK ${planningWeekNumber()} &mdash; CREATIVE PRODUCTION</h2>
        <div class="prod-range">${wpEsc(formatWeekRange(monday))}</div>
      </div>
      <div class="prod-target">
        <label for="wp-target-input">Weekly video target</label>
        <input type="number" id="wp-target-input" min="20" max="30" step="1" value="${target}" aria-describedby="wp-target-hint">
        <button type="button" class="btn btn-ghost btn-sm" id="wp-target-save" onclick="wpSaveTarget()">Save</button>
        <span class="hint" id="wp-target-hint">20&ndash;30 videos</span>
      </div>
    </div>
    <div class="prod-stats" role="list" aria-label="Videos this week">
      ${cell('target', 'Target', target, 'videos for the week')}
      ${cell('recommended', 'Recommended', recommended === null ? '&mdash;' : recommended, recommended === null ? 'plan not available' : 'worthwhile videos found')}
      ${cell('planned', 'Planned', t.planned, 'in this Shoot Plan', over ? 'prod-stat-over' : '')}
      ${cell('sent', 'Sent to production', t.sent, t.confirmed ? 'Shoot Plan confirmed' : 'not confirmed yet')}
      ${cell('in-production', 'In production', t.inProduction, 'filming, editing or QC')}
      ${cell('completed', 'Completed', t.completed, 'live')}
      ${cell('remaining', 'Remaining capacity', remaining, over ? `${t.planned - target} over target` : 'before the target')}
    </div>
    <div class="prod-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${target}" aria-valuenow="${Math.min(t.planned, target)}" aria-label="Videos planned against the weekly target"><span style="width:${pct}%"></span></div>
    ${plan && plan.available && plan.summary ? `<div class="prod-note" id="wp-explanation">${wpEsc(plan.summary.explanation)}</div>` : ''}
    ${readOnly ? '<div class="prod-note">This is a past week: the record is read-only.</div>' : ''}`;
}

async function wpSaveTarget() {
  const input = document.getElementById('wp-target-input');
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < 20 || value > 30) return toast('The weekly video target must be a whole number from 20 to 30', true);
  try {
    state.planningSettings = await api('/planning-settings', { method: 'PUT', body: JSON.stringify({ weekly_video_target: value }) });
    toast(`Weekly video target set to ${value}`);
    await loadWeeklyVideoPlan(true);
  } catch (e) { toast(e.message, true); }
}

// ── Weekly Plan step ──────────────────────────────────
function renderWeeklyPlan() {
  renderProductionHeader();
  const el = document.getElementById('weekly-plan');
  if (!el) return;
  const plan = state.weeklyVideoPlan;
  if (!plan) {
    el.innerHTML = state.weeklyVideoPlanError
      ? `<div class="attention-empty wp-empty" role="alert">The weekly plan could not be loaded: ${wpEsc(state.weeklyVideoPlanError)} <button type="button" class="btn btn-ghost btn-sm" onclick="loadWeeklyVideoPlan(true)">Try again</button></div>`
      : '<div class="attention-empty wp-empty">Building the weekly plan&hellip;</div>';
    return;
  }
  if (!plan.available) {
    el.innerHTML = `<div class="attention-empty wp-empty">${wpEsc(plan.reason || 'The weekly plan is not available.')} Core and High Stocks can still be used to plan the week by hand.</div>`;
    return;
  }
  const counts = plan.counts || {};
  const tab = state.weeklyPlanTab;
  const tabs = WP_CATEGORIES.map((c) => `<button type="button" role="tab" class="wp-tab ${c.cls} ${tab === c.key ? 'active' : ''}" aria-selected="${tab === c.key}" data-wp-tab="${c.key}" onclick="wpSetTab('${c.key}')">${c.label} <span class="wp-tab-count">${counts[c.key] || 0}</span></button>`).join('')
    + `<button type="button" role="tab" class="wp-tab wp-cat-excluded ${tab === 'EXCLUDED' ? 'active' : ''}" aria-selected="${tab === 'EXCLUDED'}" data-wp-tab="EXCLUDED" onclick="wpSetTab('EXCLUDED')">Not launched <span class="wp-tab-count">${(plan.excluded || []).length}</span></button>`
    + `<button type="button" role="tab" class="wp-tab wp-cat-verify ${tab === 'VERIFY' ? 'active' : ''}" aria-selected="${tab === 'VERIFY'}" data-wp-tab="VERIFY" onclick="wpSetTab('VERIFY')">Needs verification <span class="wp-tab-count">${(plan.verification || []).length}</span></button>`;
  const body = tab === 'EXCLUDED' ? wpExcludedHtml(plan) : tab === 'VERIFY' ? wpVerificationHtml(plan.verification || []) : wpListHtml(plan, tab);
  const check = (plan.verification || []).length && tab !== 'VERIFY'
    ? `<div class="wp-banner wp-banner-warn" role="status">${wpPlural(plan.verification.length, 'product')} could not be confirmed as launched and ${plan.verification.length === 1 ? 'is' : 'are'} left out of the recommendations. <button type="button" class="link-btn" onclick="wpSetTab('VERIFY')">Review them</button></div>` : '';
  const issues = (plan.config_issues || []).length ? `<div class="wp-banner wp-banner-warn" role="status">Some recommendation settings were out of range and defaults are being used: ${wpEsc(plan.config_issues.join('; '))}</div>` : '';
  const data = plan.data || {};
  const unavailable = [];
  if (data.sales === false) unavailable.push('sales');
  if (data.seasonality && data.seasonality.available === false) unavailable.push('seasonality');
  if (data.coverage && data.coverage.available === false) unavailable.push('Meta ad coverage');
  const dataNote = unavailable.length ? `<div class="wp-banner wp-banner-warn" role="status">Not available right now: ${wpEsc(unavailable.join(', '))}. Those signals are not weighed, and the products affected say so.</div>` : '';
  el.innerHTML = `${dataNote}${issues}${check}
    <div class="wp-tabs" role="tablist" aria-label="Recommendation categories">${tabs}</div>
    <div class="wp-tab-hint">${tab === 'EXCLUDED' ? 'Products that have not launched are never recommended for creative. Upcoming Drops plans them.' : tab === 'VERIFY' ? 'There is not enough proof that these have gone on sale, so they are not recommended. Confirm each one (or mark it not launched).' : wpEsc((WP_CAT_BY_KEY[tab] || {}).hint || '')}</div>
    <div class="wp-list" role="tabpanel">${body}</div>`;
}

function wpSetTab(key) {
  state.weeklyPlanTab = key;
  renderWeeklyPlan();
}

function wpToggle(key) {
  state.weeklyPlanOpen[key] = !state.weeklyPlanOpen[key];
  renderWeeklyPlan();
}

function wpListHtml(plan, cat) {
  const rows = (plan.products || []).filter((p) => p.category === cat);
  if (!rows.length) {
    const msg = cat === 'SHOOT_NOW'
      ? 'Nothing needs a new shoot right now. Unused capacity is deliberately not filled with weak recommendations.'
      : 'No products in this category.';
    return `<div class="attention-empty wp-empty">${msg}</div>`;
  }
  return rows.map(wpRowHtml).join('');
}

function wpChip(text, cls, title) {
  return `<span class="wp-chip ${cls || ''}"${title ? ` title="${wpEsc(title)}"` : ''}>${text}</span>`;
}

function wpRowHtml(p) {
  const cat = WP_CAT_BY_KEY[p.category] || WP_CATEGORIES[3];
  const open = Boolean(state.weeklyPlanOpen[p.key]);
  const readOnly = state.planningWeekOffset < 0;
  const thumb = p.image_url ? `<img class="wp-thumb" src="${wpEsc(p.image_url)}" alt="">` : '<span class="wp-thumb wp-noimg" aria-hidden="true">&#9635;</span>';
  const planned = (p.planned && p.planned.this_week) || 0;
  const rec = p.recommended_videos || 0;
  const chips = [];
  const st = p.stock || {};
  if (st.band && st.band !== 'unknown') chips.push(wpChip(`${Number(st.units || 0).toLocaleString('en-AU')} in stock`, st.band === 'out' || st.band === 'low' ? 'wp-warn' : '', 'Stock across all colourways, counted once'));
  if (p.sales && p.sales.band && p.sales.band !== 'unknown') chips.push(wpChip(`${Number(p.sales.units30 || 0).toLocaleString('en-AU')} sold / 30d`, p.sales.band === 'strong' ? 'wp-ok' : p.sales.band === 'weak' ? 'wp-warn' : '', p.sales.text));
  const perf = p.performance;
  if (perf && perf.unique_creatives > 0) chips.push(wpChip(`${perf.unique_creatives} unique creative${perf.unique_creatives === 1 ? '' : 's'}`, WP_PERF_CLASS[perf.assessment] || '', perf.text));
  else if (p.coverage && p.coverage.known) chips.push(wpChip(`${p.coverage.active_ads} confirmed active ad${p.coverage.active_ads === 1 ? '' : 's'}`, p.coverage.active_ads < p.coverage.min ? 'wp-warn' : ''));
  if (p.coverage && p.coverage.known && p.coverage.uncertain) chips.push(wpChip('ads awaiting review', 'wp-muted', 'Some active ads are unmatched or pending, so the true coverage may be higher.'));
  if (p.season && p.season.label) chips.push(wpChip(wpEsc(p.season.label), p.season.outlook && p.season.outlook.boost !== 'none' ? 'wp-ok' : 'wp-muted', p.season.outlook && p.season.outlook.text));
  if ((p.colourways || []).length > 1) chips.push(wpChip(`${p.colourways.length} colourways`, 'wp-muted'));
  const qty = p.category === 'SHOOT_NOW'
    ? `<div class="wp-qty" aria-label="Video quantities"><div><b>${rec}</b><span>recommended</span></div><div><b>${planned}</b><span>planned</span></div><div><b>${p.remaining}</b><span>remaining</span></div></div>`
    : (planned ? `<div class="wp-qty"><div><b>${planned}</b><span>planned</span></div></div>` : '');
  const canPlan = !readOnly && !(p.launch && (p.launch.status === 'unlaunched' || p.launch.status === 'discontinued'));
  let action = '';
  if (canPlan && p.category === 'SHOOT_NOW' && p.remaining > 0) {
    const n = p.allocated > 0 ? p.allocated : p.remaining;
    action = `<button type="button" class="btn btn-primary btn-sm" data-wp-plan="${wpEsc(p.key)}" onclick="wpPlan('${wpEsc(p.key)}', ${n})">Plan ${wpPlural(n, 'video')}</button>`;
    if (p.deferred > 0) action += `<div class="wp-deferred">${p.deferred} more deferred &mdash; over the weekly target</div>`;
  } else if (canPlan && p.category === 'SHOOT_NOW') {
    action = '<span class="wp-done">Fully planned</span>';
  } else if (canPlan) {
    action = `<button type="button" class="btn btn-ghost btn-sm" data-wp-plan="${wpEsc(p.key)}" onclick="wpPlan('${wpEsc(p.key)}', 1)" title="Not recommended this week. Plan it anyway.">Plan anyway</button>`;
  }
  return `
    <article class="wp-row ${cat.cls}" data-wp-key="${wpEsc(p.key)}" data-wp-category="${p.category}">
      ${thumb}
      <div class="wp-main">
        <div class="wp-title">
          <span class="wp-name">${wpEsc(p.name)}</span>
          <span class="wp-badge ${cat.cls}" data-wp-badge>${cat.label}</span>
          ${p.manual_videos || (p.exceptions || []).length ? '<span class="wp-badge wp-badge-manual" title="A manual priority applies">Manual</span>' : ''}
          ${wpRoleChip(p)}
          ${p.category_name ? `<span class="wp-catname">${wpEsc(p.category_name)}</span>` : ''}
        </div>
        <div class="wp-headline">${wpEsc(p.headline)}</div>
        <div class="wp-chips">${chips.join('')}</div>
        <button type="button" class="link-btn wp-why-btn" aria-expanded="${open}" onclick="wpToggle('${wpEsc(p.key)}')">${open ? 'Hide' : 'Why'} this recommendation</button>
        ${open ? wpDetailHtml(p) : ''}
      </div>
      ${qty}
      <div class="wp-action">${action}</div>
    </article>`;
}

function wpRoleChip(p) {
  const r = p.role || (p.roles && p.roles[0]);
  if (!r) return '';
  const all = (p.roles || [r]).map((x) => `${x.label}: ${x.basis}`).join('; ');
  return `<span class="wp-role wp-role-${wpEsc(r.key)}" data-wp-role="${wpEsc(r.key)}" title="Role in the range (not a priority): ${wpEsc(all)}">${wpEsc(r.label)}</span>`;
}

// "Why this recommendation": priority, the data behind it, the creative picture, how the number of videos was reached, what is already planned.
function wpDetailHtml(p) {
  const e = p.explain;
  if (!e) return wpDetailLegacyHtml(p);
  const data = (e.data || []).map((d) => `<li><b>${wpEsc(d.label)}</b> &mdash; ${wpEsc(d.text)}</li>`).join('');
  const steps = ((e.quantity && e.quantity.steps) || []).map((x) => `<li><span class="wp-pts">${x.videos}</span> ${wpEsc(x.text)}</li>`).join('');
  const c = e.creative && e.creative.counts;
  const cells = c ? `<div class="wp-perf-grid">
      <span class="wp-perf-cell">${c.unique} unique creative${c.unique === 1 ? '' : 's'}</span>
      <span class="wp-perf-cell wp-ok">${c.performing} performing</span><span class="wp-perf-cell wp-warn">${c.weak} weak or fading</span>
      <span class="wp-perf-cell wp-muted">${c.insufficient} not enough data</span>${c.unrated ? `<span class="wp-perf-cell wp-muted">${c.unrated} no benchmark</span>` : ''}${c.pending_review_ads ? `<span class="wp-perf-cell wp-muted">${c.pending_review_ads} ads awaiting review</span>` : ''}</div>` : '';
  const caps = (p.caps || []).map((x) => `<li>${wpEsc(x)}</li>`).join('');
  const exc = (p.exceptions || []).map((x) => `<li>${wpEsc(x.source === 'manual' ? 'Manual priority' : 'Rule')}: ${wpEsc(x.kind)} &mdash; ${wpEsc(x.effect)}${x.note ? ` (${wpEsc(x.note)})` : ''}</li>`).join('');
  const season = p.season && p.season.outlook ? `<div class="hint"><b>Season:</b> ${wpEsc(p.season.outlook.text || p.season.label)}</div>` : '';
  const mix = p.mix && p.mix.slots && p.mix.slots.length
    ? `<div class="wp-sub"><b>Suggested creative mix</b> <span class="hint">${wpEsc(p.mix.note || '')} Editable when you plan it.</span></div>
       <ol class="wp-mix-list">${p.mix.slots.map((s2) => `<li><span class="wp-basis wp-basis-${s2.basis}">${WP_BASIS_LABEL[s2.basis] || s2.basis}</span> ${wpEsc(s2.concept || 'New concept')} <span class="hint">${wpEsc(s2.reason)}</span></li>`).join('')}</ol>` : '';
  const cw = (p.colourways || []).length ? `<div class="hint"><b>Colourways</b> (stock counted once for the product): ${p.colourways.map((x) => `${wpEsc(x.colour_label || x.style_code)} ${Number(x.soh || 0).toLocaleString('en-AU')}`).join(' · ')}</div>` : '';
  const reasons = (p.reasons || []).map((r) => `<li><span class="wp-pts ${r.points > 0 ? 'wp-pts-up' : r.points < 0 ? 'wp-pts-down' : ''}">${r.points > 0 ? '+' : ''}${r.points}</span> <b>${wpEsc(r.label)}</b> &mdash; ${wpEsc(r.text)}</li>`).join('');
  return `<div class="wp-detail" data-wp-explain>
    <div class="wp-sub"><b>Why it is prioritised</b></div><p class="wp-explain-line">${wpEsc(e.priority)}</p>
    <div class="wp-sub"><b>The data behind it</b></div><ul class="wp-reasons">${data}</ul>
    <div class="wp-sub"><b>The creative picture</b> <span class="hint">unique creatives, confirmed or auto-matched ads only; copies and bundle ads are not counted twice</span></div>${cells}<p class="wp-explain-line">${wpEsc(e.creative.text)}</p>
    <div class="wp-sub"><b>Why this many videos</b></div><ul class="wp-reasons">${steps}</ul>${e.quantity && e.quantity.text && !steps ? `<p>${wpEsc(e.quantity.text)}</p>` : ''}
    <div class="wp-sub"><b>Already planned</b></div><p class="wp-explain-line">${wpEsc(e.planned.text)}</p>
    ${caps ? `<div class="wp-sub"><b>Why it is not higher</b></div><ul class="wp-caps">${caps}</ul>` : ''}
    ${exc ? `<div class="wp-sub"><b>Manual or rule exceptions</b></div><ul class="wp-caps">${exc}</ul>` : ''}
    ${(e.cautions || []).map((x) => `<div class="hint wp-caution">${wpEsc(x)}</div>`).join('')}
    ${season}${cw}${mix}
    <details class="wp-score-detail"><summary>Score breakdown (${p.score} = need ${p.need_points} + worth ${p.worth_points})</summary><ul class="wp-reasons">${reasons}</ul></details>
  </div>`;
}

function wpDetailLegacyHtml(p) {
  const reasons = (p.reasons || []).map((r) => `<li><b>${wpEsc(r.label)}</b> &mdash; ${wpEsc(r.text)}</li>`).join('');
  return `<div class="wp-detail"><div class="wp-score">Score ${p.score}</div><ul class="wp-reasons">${reasons}</ul></div>`;
}

function wpExcludedHtml(plan) {
  const ex = plan.excluded || [];
  if (!ex.length) return '<div class="attention-empty wp-empty">Every product in the plan has launched.</div>';
  return ex.map((e) => `
    <article class="wp-row wp-cat-excluded" data-wp-key="${wpEsc(e.key)}">
      <span class="wp-thumb wp-noimg" aria-hidden="true">&#9635;</span>
      <div class="wp-main">
        <div class="wp-title"><span class="wp-name">${wpEsc(e.name)}</span><span class="wp-badge wp-cat-excluded">${e.launch && e.launch.status === 'discontinued' ? 'Discontinued' : 'Not launched'}</span>${e.in_upcoming_drop ? '<span class="wp-badge wp-badge-manual">Upcoming Drop</span>' : ''}</div>
        <div class="wp-headline">${wpEsc(e.reason || 'Has not launched, so no creative is recommended for it.')}</div>
      </div>
    </article>`).join('');
}

function wpVerificationHtml(list) {
  if (!list.length) return '<div class="attention-empty wp-empty">Every product in the plan has enough proof of launch.</div>';
  const readOnly = state.planningWeekOffset < 0;
  return list.map((v) => {
    const ev = ((v.launch && v.launch.by_style && v.launch.by_style[0] && v.launch.by_style[0].evidence) || []).map((e) => `<li><b>${wpEsc(e.source.replace(/_/g, ' '))}</b> &mdash; ${wpEsc(e.text)}</li>`).join('');
    const code = (v.codes || [])[0] || '';
    const btns = readOnly || !code ? '' : `<button type="button" class="btn btn-primary btn-sm" data-wp-verify-launched="${wpEsc(code)}" onclick="wpConfirmLaunch('${wpEsc(code)}', '${wpEsc(v.name)}')">Confirm launched</button><button type="button" class="btn btn-ghost btn-sm" onclick="wpMarkUnlaunched('${wpEsc(code)}', '${wpEsc(v.name)}')">Not launched</button>`;
    return `<article class="wp-row wp-cat-verify" data-wp-key="${wpEsc(v.key)}"><span class="wp-thumb wp-noimg" aria-hidden="true">&#9635;</span>
      <div class="wp-main"><div class="wp-title"><span class="wp-name">${wpEsc(v.name)}</span><span class="wp-badge wp-cat-verify">Verify launch</span>${wpRoleChip(v)}</div>
      <div class="wp-headline">${wpEsc(v.reason || '')}</div>
      <div class="wp-chips">${v.stock && v.stock.known ? wpChip(`${Number(v.stock.units || 0).toLocaleString('en-AU')} in stock`) : ''}${v.sales && v.sales.available ? wpChip(`${Number(v.sales.units365 || 0).toLocaleString('en-AU')} sold / 365d`, 'wp-muted') : ''}</div>
      ${ev ? `<details class="wp-score-detail"><summary>What was checked</summary><ul class="wp-reasons">${ev}</ul></details>` : ''}</div>
      <div class="wp-qty"></div><div class="wp-action">${btns}</div></article>`;
  }).join('');
}

async function wpMarkUnlaunched(code, name) {
  if (!(await confirmDialog(`Mark ${name} as not launched? It will be left out of recommendations. This is a note in this pipeline only; nothing changes in Shopify or ApparelMagic.`, { okLabel: 'Mark not launched' }))) return;
  try {
    await api('/weekly-video-plan/launch-overrides', { method: 'POST', body: JSON.stringify({ product_code: code, status: 'unlaunched', note: 'Marked from the Weekly Plan verification list' }) });
    toast(`${name} marked as not launched`);
    await loadWeeklyVideoPlan(true);
    if (typeof loadAll === 'function') loadAll();
  } catch (e) { toast(e.message, true); }
}

async function wpConfirmLaunch(code, name) {
  if (!code) return toast('This product has no product code to confirm', true);
  if (!(await confirmDialog(`Confirm that ${name} has launched? This is a note in this pipeline only; nothing changes in Shopify or ApparelMagic.`, { okLabel: 'Confirm launched' }))) return;
  try {
    await api('/weekly-video-plan/launch-overrides', { method: 'POST', body: JSON.stringify({ product_code: code, status: 'launched', note: 'Confirmed from the Weekly Plan' }) });
    toast(`${name} marked as launched`);
    await loadWeeklyVideoPlan(true);
    if (typeof loadAll === 'function') loadAll();
  } catch (e) { toast(e.message, true); }
}

// ── turning a recommendation into a Shoot Plan entry (explicit, via the existing modal) ──
async function wpPlan(key, videos) {
  if (state.planningWeekOffset < 0) return;
  try {
    const prep = await api('/weekly-video-plan/prepare-shoot', { method: 'POST', body: JSON.stringify({ key, week_start: planningWeekStart() }) });
    if (!prep.product_code) return toast('This product has no product code, so it cannot be planned here', true);
    openShootPlanModal({
      productCode: prep.product_code,
      productName: prep.product_name,
      category: prep.category,
      colours: prep.colours,
      source: 'manual',
      weekly: { key: prep.key, videos, recommended: prep.recommended_videos, remaining: prep.remaining, headline: prep.headline, categoryLabel: prep.category_label, mix: prep.mix, snapshot: prep.snapshot },
    });
  } catch (e) { toast(e.message, true); }
}

function wpPrepareShootModal(preset) {
  const reco = document.getElementById('shoot-plan-recommendation');
  const mixEl = document.getElementById('shoot-plan-mix');
  const input = document.getElementById('shoot-plan-videos');
  if (!input) return;
  const w = preset.weekly || null;
  input.value = Math.max(1, Math.min(50, Number(w ? w.videos : preset.videosDefault) || 1));
  if (!w) {
    reco.style.display = 'none'; reco.innerHTML = '';
    mixEl.style.display = 'none'; mixEl.innerHTML = '';
    return;
  }
  reco.style.display = '';
  reco.innerHTML = `<b>${wpEsc(w.categoryLabel || 'Recommendation')}</b> &mdash; ${wpEsc(w.headline || '')} <span class="hint">You can change the number of videos or the mix; the recommendation itself is kept as a record.</span>`;
  wpRenderMix(w.mix && w.mix.slots ? w.mix.slots : []);
  input.oninput = () => wpResizeMix(Number(input.value) || 1);
}

function wpRenderMix(slots) {
  const mixEl = document.getElementById('shoot-plan-mix');
  state.wpMixSlots = slots.map((s) => ({ ...s }));
  if (!slots.length) { mixEl.style.display = 'none'; mixEl.innerHTML = ''; return; }
  mixEl.style.display = '';
  const list = (state.conceptTypes || []).map((t) => `<option value="${wpEsc(t.name)}"></option>`).join('');
  mixEl.innerHTML = `
    <div class="wp-sub"><b>Creative mix</b> <span class="hint">Suggested from what is already classified. Change any concept; nothing is created from this list.</span></div>
    <datalist id="wp-mix-concepts">${list}</datalist>
    ${state.wpMixSlots.map((s, i) => `
      <div class="wp-mix-row" data-mix-index="${i}">
        <span class="wp-basis wp-basis-${s.basis}">${WP_BASIS_LABEL[s.basis] || s.basis}</span>
        <input type="text" class="wp-mix-concept" list="wp-mix-concepts" value="${wpEsc(s.concept || '')}" placeholder="New concept" aria-label="Concept for video ${i + 1}" onchange="wpMixEdited(${i}, this.value)">
        <span class="hint">${wpEsc(s.reason || '')}</span>
      </div>`).join('')}`;
}

function wpMixEdited(i, value) {
  const s = state.wpMixSlots[i];
  if (!s) return;
  const v = String(value || '').trim();
  if (v !== (s.concept || '')) { s.concept = v || null; s.basis = 'exploratory'; s.edited = true; s.reason = 'Set by hand.'; }
  wpRenderMix(state.wpMixSlots);
}

// the quantity field drives the length of the mix list: extra slots are open exploratory ones, removed slots are the last ones
function wpResizeMix(n) {
  if (!state.wpMixSlots || !state.wpMixSlots.length) return;
  const target = Math.max(1, Math.min(50, n));
  while (state.wpMixSlots.length < target) state.wpMixSlots.push({ kind: 'new_concept', concept: null, basis: 'exploratory', reason: 'An open slot added by hand.' });
  if (state.wpMixSlots.length > target) state.wpMixSlots.length = target;
  wpRenderMix(state.wpMixSlots);
}

// → { error } | { fields } merged into the POST /shoot-plan payload
function wpShootPayloadExtras(ctx) {
  const input = document.getElementById('shoot-plan-videos');
  const videos = Number(input ? input.value : 1);
  if (!Number.isInteger(videos) || videos < 1 || videos > 50) return { error: 'Videos must be a whole number from 1 to 50' };
  const fields = { videos };
  const w = ctx && ctx.weekly;
  if (w) {
    fields.recommended_videos = Number.isInteger(w.recommended) ? w.recommended : undefined;
    fields.recommendation_snapshot = w.snapshot || undefined;
    const slots = (state.wpMixSlots || []).slice(0, videos);
    if (slots.length) fields.video_mix = slots.map((s) => ({ kind: s.kind || 'new_concept', concept: s.concept || null, basis: s.basis, edited: Boolean(s.edited) }));
  }
  return { fields };
}

// ── Shoot Plan rows: videos per product ───────────────
function wpShootPlanVideosHtml(item, readOnly) {
  const planned = item.planned_videos || 1;
  const parts = [`<span class="wp-vid-count"><b>${planned}</b> video${planned === 1 ? '' : 's'}</span>`];
  if (item.recommended_videos !== null && item.recommended_videos !== undefined) parts.push(`<span class="wp-vid-sub">recommended ${item.recommended_videos}</span>`);
  if (item.videos_in_production) parts.push(`<span class="wp-vid-sub">${item.videos_in_production} in production</span>`);
  if (item.videos_completed) parts.push(`<span class="wp-vid-sub">${item.videos_completed} completed</span>`);
  const mix = Array.isArray(item.video_mix) && item.video_mix.length
    ? `<div class="wp-vid-mix hint">Mix: ${item.video_mix.map((s) => wpEsc(s.concept || 'New concept')).join(' · ')}</div>` : '';
  const edit = readOnly ? '' : `<button type="button" class="link-btn" onclick="wpEditVideos(${item.id}, ${planned}, ${Number(item.video_assets) || 0})">Change quantity</button>`;
  return `<div class="wp-vid" data-shoot-plan-videos="${item.id}">${parts.join('')}${edit}${mix}</div>`;
}

let wpEditingItem = null;
function wpEditVideos(id, current, minimum) {
  wpEditingItem = { id, minimum };
  const input = document.getElementById('shoot-plan-videos-edit');
  input.min = String(Math.max(1, minimum || 1));
  input.value = String(current);
  document.getElementById('shoot-plan-videos-edit-hint').textContent = minimum
    ? `At least ${minimum}: ${wpPlural(minimum, 'concept')} already exist for this product and are not cancelled by lowering the number.`
    : 'One video = one concept. Whole number from 1 to 50.';
  openModal('shoot-plan-videos-modal');
  input.focus();
}

async function wpSaveVideos() {
  if (!wpEditingItem) return;
  const n = Number(document.getElementById('shoot-plan-videos-edit').value);
  if (!Number.isInteger(n) || n < 1 || n > 50) return toast('Videos must be a whole number from 1 to 50', true);
  try {
    await api(`/shoot-plan/${wpEditingItem.id}/videos`, { method: 'PATCH', body: JSON.stringify({ videos: n }) });
    closeModal('shoot-plan-videos-modal');
    toast('Video quantity updated');
    wpEditingItem = null;
    await loadAll();
    loadWeeklyVideoPlan(true);
  } catch (e) { toast(e.message, true); }
}

// ── Settings → Planning ───────────────────────────────
const WPS = { config: null, pick: null, timer: null, overrides: [] };

function renderWeeklyPlanSettings() {
  const st = state.planningSettings;
  if (!st) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('weekly-video-target-input', st.weekly_video_target ?? 25);
  set('season-immediate-days-input', st.season_immediate_days ?? 7);
  set('season-secondary-days-input', st.season_secondary_days ?? 14);
  loadWeeklyPlanConfig();
  loadLaunchOverrides();
}

async function saveWeeklyVideoTarget() {
  const value = Number(document.getElementById('weekly-video-target-input').value);
  if (!Number.isInteger(value) || value < 20 || value > 30) return toast('The weekly video target must be a whole number from 20 to 30', true);
  try {
    state.planningSettings = await api('/planning-settings', { method: 'PUT', body: JSON.stringify({ weekly_video_target: value }) });
    toast('Weekly video target saved');
    loadWeeklyVideoPlan(true);
  } catch (e) { toast(e.message, true); }
}

async function saveSeasonDays() {
  const imm = Number(document.getElementById('season-immediate-days-input').value);
  const sec = Number(document.getElementById('season-secondary-days-input').value);
  if (!Number.isInteger(imm) || !Number.isInteger(sec) || imm < 1 || sec <= imm) return toast('The secondary window must be longer than the immediate window', true);
  try {
    state.planningSettings = await api('/planning-settings', { method: 'PUT', body: JSON.stringify({ season_immediate_days: imm, season_secondary_days: sec }) });
    toast('Seasonal look-ahead saved');
    loadWeeklyVideoPlan(true);
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
      const input = f.key === 'launch_sales_confirms'
        ? `<select id="wpc-${wpEsc(f.key)}" data-wpc-key="${wpEsc(f.key)}" aria-describedby="wpc-${wpEsc(f.key)}-hint"><option value="0" ${Number(f.value) === 0 ? 'selected' : ''}>No: a person confirms</option><option value="1" ${Number(f.value) === 1 ? 'selected' : ''}>Yes: sustained sales count</option></select>`
        : `<input type="number" id="wpc-${wpEsc(f.key)}" data-wpc-key="${wpEsc(f.key)}" min="${f.min}" max="${f.max}" step="any" value="${f.value}" aria-describedby="wpc-${wpEsc(f.key)}-hint">`;
      return `<div class="wpc-field"><label for="wpc-${wpEsc(f.key)}">${wpEsc(f.label)}</label>${input}<span class="hint" id="wpc-${wpEsc(f.key)}-hint">${Number(f.value) !== Number(f.default) ? '<b>changed</b> &middot; ' : ''}default ${f.default} &middot; ${f.min}&ndash;${f.max}</span></div>`;
    };
    const group = (g) => `<fieldset class="wpc-group" data-wpc-group="${wpEsc(g.key)}"><legend>${wpEsc(g.title)}</legend>${g.help ? `<div class="hint wpc-help">${wpEsc(g.help)}</div>` : ''}${g.fields.map(field).join('')}</fieldset>`;
    const everyday = res.groups.filter((g) => !g.advanced);
    const advanced = res.groups.filter((g) => g.advanced);
    host.innerHTML = everyday.map(group).join('') + (advanced.length ? `<details class="wpc-advanced" id="wpc-advanced"${wasOpen ? ' open' : ''}><summary>Advanced: how products are scored and sized</summary>${advanced.map(group).join('')}</details>` : '');
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
    loadWeeklyVideoPlan(true);
  } catch (e) { toast(e.message, true); }
}

async function resetWeeklyPlanConfig() {
  if (!(await confirmDialog('Reset every recommendation setting to its default?', { okLabel: 'Reset' }))) return;
  try {
    await api('/weekly-video-plan/config', { method: 'PUT', body: JSON.stringify({ reset: true }) });
    toast('Recommendation settings reset');
    await loadWeeklyPlanConfig();
    loadWeeklyVideoPlan(true);
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
    loadWeeklyVideoPlan(true);
  } catch (e) { toast(e.message, true); }
}

(function wireWeeklyPlanSettings() {
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
  on('weekly-video-target-save-btn', 'click', saveWeeklyVideoTarget);
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
      loadWeeklyVideoPlan(true);
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
    out.innerHTML = `<div class="hint">${wpEsc(res.note)} Thresholds: sales count as evidence from ${res.thresholds.sales_launch_units} units${res.thresholds.sales_confirms_launch ? ' and are allowed to confirm a launch' : ' but never confirm a launch on their own'}; a date that passed under ${res.thresholds.settle_days} days ago with no sales is verified.</div>` + res.products.map((p) => `
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
