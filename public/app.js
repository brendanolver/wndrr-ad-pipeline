const STATUSES = ['not_started', 'awaiting_proven_concept', 'concept_script', 'filming', 'editing', 'qc', 'uploaded_live'];
const STATUS_LABELS = {
  not_started: 'Not Started',
  awaiting_proven_concept: 'Awaiting Proven Concept',
  concept_script: 'Concept/Script',
  filming: 'Filming',
  editing: 'Editing',
  qc: 'QC',
  uploaded_live: 'Uploaded/Live',
};
const TIER_LABELS = { core_proven: 'Core/Proven', new_drop: 'New Drop' };
const CLASSIFICATION_LABELS = { tested_proven: 'Tested/Proven', new_experimental: 'New/Experimental' };

let state = {
  styles: [], categories: [], board: null, dashboard: null, drops: [], provenWinners: [],
  coreProducts: [], planningSettings: null, coreView: 'priority', coreAllProductsOpen: false,
  coreExpandedCategories: new Set(), coreExpandedProducts: new Set(),
  coreShootExpandedCategories: new Set(),
  shootPlan: [], coverageImageIndex: new Map(),
  contentCreators: [],
  highStockProducts: [], highStockExpandedProducts: new Set(),
  // Monday Planning's 5-step guided workflow -- always starts at Core on
  // load (not persisted to localStorage): this is a recurring weekly
  // ritual, not a session to resume, so a stale mid-flow step from a prior
  // visit would only confuse. The one place it's overridden is entering
  // the drop/product/promotion drill-in (see renderPlanningRoute), so "Back
  // to Planning" always returns to the Drops step, not Core.
  planningStep: 'core',
  promotions: [], currentPromotionId: null, currentPromotion: null,
  weeklyShootPlanConfirmation: null,
  // Set by "Edit Plan" on the confirmed handoff card -- lets the team keep
  // adjusting a shoot plan after it's been sent, without a backend
  // "unconfirm" (the weekly confirmation record itself is untouched and
  // stays idempotent; this only decides whether the CTA or the confirmed
  // card is showing).
  shootPlanEditMode: false,
  salesCadence: null,
  metaProductMappings: [], metaProductFamilies: [],
  // Planning's own week nav -- deliberately separate from dashboardWeekOffset
  // (the Weekly Creative Dashboard's own, unrelated week nav) since the two
  // tabs are viewed independently. 0 = current week, -1 = last week, etc.
  planningWeekOffset: 0,
  weeklyPlanningProgress: { core_reviewed: false, high_stock_reviewed: false, drops_reviewed: false, promotions_reviewed: false },
  // Concept Development's own week nav -- deliberately separate from
  // planningWeekOffset, same reasoning as dashboardWeekOffset above: viewed
  // independently, so navigating one page's week must never move another's.
  // view/currentItemId drive the landing-page <-> product-workspace
  // navigation (see renderConceptDevList); filter is the landing page's
  // own client-side status filter, applied over the same week's data with
  // no extra API call.
  conceptDev: { weekOffset: 0, data: null, view: 'list', currentItemId: null, filter: 'all' },
};
let dashboardWeekOffset = 0;

// ── API helpers ──────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
  });
  if (res.status === 401) {
    showPasswordScreen();
    throw new Error('Not authenticated');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── Auth ─────────────────────────────────────────────
async function login() {
  const password = document.getElementById('pw-input').value;
  const errEl = document.getElementById('pw-error');
  try {
    await api('/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
    errEl.classList.remove('show');
    showApp();
  } catch (e) {
    errEl.classList.add('show');
  }
}

async function logout() {
  await api('/auth/logout', { method: 'POST' });
  showPasswordScreen();
}

function showPasswordScreen() {
  document.getElementById('password-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

function showApp() {
  document.getElementById('password-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  loadAll();
}

async function checkSession() {
  try {
    const { authenticated } = await api('/auth/session');
    if (authenticated) showApp();
    else showPasswordScreen();
  } catch (e) {
    showPasswordScreen();
  }
}

// ── Toast ────────────────────────────────────────────
function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3500);
}

// ── Tabs ─────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ── Week math (Monday-start ISO weeks, mirrors src/lib/week.js) ──────
// Client-side port so Planning's week nav doesn't need a round trip just
// to know which Monday it's looking at or what to call it.
function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function mondayOfWeek(offsetWeeks, base = new Date()) {
  const today = new Date(base);
  today.setHours(0, 0, 0, 0);
  const day = today.getDay(); // 0 = Sun .. 6 = Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(today);
  monday.setDate(today.getDate() + diffToMonday + offsetWeeks * 7);
  return monday;
}

function isoDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatWeekRange(monday) {
  const end = new Date(monday);
  end.setDate(monday.getDate() + 6);
  const fmt = (d) => d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  return `${fmt(monday)} – ${fmt(end)}, ${end.getFullYear()}`;
}

function planningWeekStart() {
  return isoDateStr(mondayOfWeek(state.planningWeekOffset));
}

function planningWeekNumber() {
  return isoWeekNumber(mondayOfWeek(state.planningWeekOffset));
}

function conceptDevWeekStart() {
  return isoDateStr(mondayOfWeek(state.conceptDev.weekOffset));
}

function conceptDevWeekNumber() {
  return isoWeekNumber(mondayOfWeek(state.conceptDev.weekOffset));
}

// ── Load & render ────────────────────────────────────
async function loadAll() {
  try {
    const weekStart = planningWeekStart();
    const [board, styles, categories, dashboard, dropsRes, provenWinners, coreRes, planningSettings, shootPlan, contentCreators, highStockRes, promotions, weeklyConfirmation, weeklyPlanningProgress, salesCadence, metaProductMappings, metaProductFamilies, conceptDev] = await Promise.all([
      api('/board'),
      api('/styles'),
      api('/categories'),
      api(`/dashboard?weekOffset=${dashboardWeekOffset}`),
      api('/drops'),
      api('/proven-winners'),
      api('/core-products'),
      api('/planning-settings'),
      api(`/shoot-plan?week_start=${weekStart}`),
      api('/content-creators'),
      api('/high-stock-products'),
      api('/promotions'),
      api(`/weekly-shoot-plan-confirmation?week_start=${weekStart}`),
      api(`/weekly-planning-progress?week_start=${weekStart}`),
      api('/sales-cadence'),
      api('/meta-product-mappings'),
      api('/meta-product-mappings/product-families'),
      api(`/concept-development?week_start=${conceptDevWeekStart()}`),
    ]);
    state.board = board;
    state.styles = styles;
    state.categories = categories;
    state.dashboard = dashboard;
    state.drops = dropsRes.drops;
    state.amConfigured = dropsRes.apparelmagic.configured;
    state.amError = dropsRes.apparelmagic.error;
    state.provenWinners = provenWinners;
    state.coreProducts = coreRes.products;
    state.coreWeekly = { target: coreRes.weekly_target, planned: coreRes.weekly_planned, remaining: coreRes.weekly_remaining };
    state.planningSettings = planningSettings;
    state.shootPlan = shootPlan;
    state.contentCreators = contentCreators;
    state.highStockProducts = highStockRes.products;
    state.promotions = promotions;
    state.weeklyShootPlanConfirmation = weeklyConfirmation;
    state.weeklyPlanningProgress = weeklyPlanningProgress;
    state.salesCadence = salesCadence;
    state.metaProductMappings = metaProductMappings;
    state.metaProductFamilies = metaProductFamilies;
    state.conceptDev.data = conceptDev;
    renderBoard();
    renderMissingAd();
    renderStylesTable();
    renderCategoriesTable();
    populateStyleSelect();
    populateCategorySelect();
    renderDashboard();
    renderPlanning();
    renderProvenWinners();
    renderCoreProducts();
    renderPlanningSettingsForm();
    renderContentCreators();
    renderMetaProductMappings();
    renderHighStockProducts();
    renderPromotionsRow();
    renderPlanningShootSummary();
    renderConceptDevWeekHeader();
    renderConceptDevList();
  } catch (e) {
    toast(e.message, true);
  }
}

// Refetches just the week-scoped Planning data (Shoot Plan items, weekly
// confirmation, Monday checklist progress) instead of a full loadAll() --
// Core/High Stock/Upcoming Drops/Promotions are always live/current-data
// views regardless of which week is being browsed, so there's nothing
// week-specific in them to refetch.
async function loadPlanningWeek() {
  try {
    const weekStart = planningWeekStart();
    const [shootPlan, weeklyConfirmation, weeklyPlanningProgress] = await Promise.all([
      api(`/shoot-plan?week_start=${weekStart}`),
      api(`/weekly-shoot-plan-confirmation?week_start=${weekStart}`),
      api(`/weekly-planning-progress?week_start=${weekStart}`),
    ]);
    state.shootPlan = shootPlan;
    state.weeklyShootPlanConfirmation = weeklyConfirmation;
    state.weeklyPlanningProgress = weeklyPlanningProgress;
    state.shootPlanEditMode = false;
    renderPlanning();
    renderPlanningShootSummary();
  } catch (e) {
    toast(e.message, true);
  }
}

async function loadDashboard() {
  try {
    state.dashboard = await api(`/dashboard?weekOffset=${dashboardWeekOffset}`);
    renderDashboard();
  } catch (e) {
    toast(e.message, true);
  }
}

function daysLabel(days) {
  if (days === null || days === undefined) return '';
  if (days === 0) return 'entered today';
  if (days === 1) return '1 day in stage';
  return `${days} days in stage`;
}

function renderBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';
  state.board.columns.forEach((col) => {
    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.innerHTML = `<div class="column-header"><span>${col.label}</span><span class="column-count">${col.cards.length}</span></div>`;
    col.cards.forEach((card) => colEl.appendChild(renderCard(card)));
    boardEl.appendChild(colEl);
  });
}

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  const stale = card.days_in_stage !== null && card.days_in_stage >= 7;
  el.innerHTML = `
    <div class="card-style">${card.style_code} ${card.category_name ? '· ' + card.category_name : ''}</div>
    <div class="card-concept">${escapeHtml(card.concept_name)}</div>
    <div class="card-badges">
      <span class="badge badge-tier-${card.style_tier}">${TIER_LABELS[card.style_tier]}</span>
      <span class="badge badge-${card.concept_classification}">${CLASSIFICATION_LABELS[card.concept_classification]}</span>
      <span class="badge badge-format">${card.format}</span>
      ${card.is_deliberate_trial ? '<span class="badge badge-trial">Deliberate Trial</span>' : ''}
    </div>
    <div class="card-meta">
      <span class="card-owner">${card.current_owner ? '👤 ' + escapeHtml(card.current_owner) : '👤 unassigned'}</span>
      <span class="card-days ${stale ? 'stale' : ''}">${daysLabel(card.days_in_stage)}</span>
      ${card.target_date ? `<span>Target: ${card.target_date}</span>` : ''}
    </div>
    <div class="card-status-row">
      <select data-id="${card.id}">
        ${STATUSES.map((s) => `<option value="${s}" ${s === card.status ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
      </select>
    </div>
  `;
  el.querySelector('.card-status-row select').addEventListener('click', (e) => e.stopPropagation());
  el.querySelector('.card-status-row select').addEventListener('change', (e) => {
    changeStatus(card.id, e.target.value, e.target);
  });
  el.addEventListener('click', () => openAssetModal(card));
  return el;
}

function renderMissingAd() {
  const panel = document.getElementById('missing-ad-panel');
  const list = document.getElementById('missing-ad-list');
  const count = document.getElementById('missing-ad-count');
  const styles = state.board.missing_ad_styles;
  if (!styles.length) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  count.textContent = styles.length;
  list.innerHTML = styles
    .map(
      (s) =>
        `<span class="missing-ad-chip">${s.style_code} — ${escapeHtml(s.name)}<span class="badge badge-tier-${s.tier}">${TIER_LABELS[s.tier]}</span></span>`
    )
    .join('');
}

async function changeStatus(id, status, selectEl) {
  const previous = state.board.columns.flatMap((c) => c.cards).find((c) => c.id === id)?.status;
  try {
    await api(`/creative-assets/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    toast('Status updated');
    loadAll();
  } catch (e) {
    toast(e.message, true);
    if (selectEl && previous) selectEl.value = previous;
  }
}

// ── Dashboard ────────────────────────────────────────
const STATUS_LABEL_TEXT = { on_track: 'On Track', at_risk: 'At Risk', off_track: 'Off Track' };

const KPI_CARDS = [
  { key: 'planned', icon: '▤', label: 'Planned', defaultSub: 'Committed for this week' },
  { key: 'briefing', icon: '✎', label: 'Briefing', defaultSub: 'Currently being briefed' },
  { key: 'in_production', icon: '●', label: 'In Production', defaultSub: 'Being shot / designed' },
  { key: 'editing', icon: '✂', label: 'Editing', defaultSub: 'Currently being edited' },
  { key: 'awaiting_review', icon: '⏳', label: 'Awaiting Review', defaultSub: 'Waiting for approval' },
  { key: 'changes', icon: '↺', label: 'Changes', defaultSub: 'Changes requested' },
  { key: 'approved', icon: '✓', label: 'Approved', defaultSub: 'Approved, not yet uploaded' },
  { key: 'shipped', icon: '🚀', label: 'Shipped', defaultSub: 'Uploaded to Meta this week' },
];

function renderDashboard() {
  const d = state.dashboard;
  if (!d) return;

  document.getElementById('hero-week-title').textContent = `Week ${d.week.number}`;
  document.getElementById('hero-week-dates').textContent = d.week.label;
  document.getElementById('hero-pct').textContent = `${d.current.completionPct}%`;
  document.getElementById('hero-pct-sub').textContent = `${d.current.shipped} / ${d.current.planned} shipped`;
  document.getElementById('hero-progress-fill').style.width = `${Math.min(100, d.current.completionPct)}%`;
  document.getElementById('hero-shipped').textContent = d.current.shipped;
  document.getElementById('hero-remaining').textContent = d.current.remaining;
  document.getElementById('hero-planned').innerHTML = `${d.current.planned} <span class="sample-tag">sample</span>`;
  document.getElementById('hero-days-remaining').textContent = d.week.daysRemaining;

  const badge = document.getElementById('hero-status-badge');
  badge.textContent = STATUS_LABEL_TEXT[d.current.status];
  badge.className = `hero-status-badge ${d.current.status}`;

  document.getElementById('pipeline-live-note').style.display = d.week.offset !== 0 ? 'block' : 'none';

  const kpiGrid = document.getElementById('pipeline-kpi-grid');
  kpiGrid.innerHTML = KPI_CARDS.map((cfg) => {
    const v = d.pipeline[cfg.key] || {};
    const numHtml =
      v.count === null || v.count === undefined
        ? '<span class="kpi-num muted">—</span>'
        : `<span class="kpi-num">${v.count}</span>${v.sample ? ' <span class="sample-tag">sample</span>' : ''}`;
    const sub = v.staleNote || v.note || cfg.defaultSub;
    const subClass = v.staleNote ? 'kpi-sub warn' : 'kpi-sub';
    return `
      <button class="kpi-card" data-kpi="${cfg.key}">
        <span class="kpi-icon">${cfg.icon}</span>
        ${numHtml}
        <span class="kpi-label">${cfg.label}</span>
        <span class="${subClass}">${sub}</span>
      </button>`;
  }).join('');
  kpiGrid.querySelectorAll('.kpi-card').forEach((btn) => {
    btn.addEventListener('click', () => switchTab('board'));
  });

  const h = d.health;
  const healthGrid = document.getElementById('health-grid');
  healthGrid.innerHTML = `
    <div class="health-card">
      <span class="health-num ${h.overdue > 0 ? 'danger' : ''}">${h.overdue}</span>
      <div class="health-label">Overdue</div>
      <div class="health-sub ${h.overdue > 0 ? 'warn' : ''}">${h.overdue > 0 ? 'Requires attention' : 'All on schedule'}</div>
    </div>
    <div class="health-card">
      <span class="health-num">${h.avgProductionDays !== null ? h.avgProductionDays.toFixed(1) + 'd' : '—'}</span>
      <div class="health-label">Avg. Production Time</div>
      <div class="health-sub">Brief &rarr; Shipped</div>
    </div>
    <div class="health-card">
      <span class="health-num">${h.newConcepts.actual} / ${h.newConcepts.target} <span class="sample-tag">sample</span></span>
      <div class="health-label">New Concepts</div>
      <div class="health-sub">Weekly target</div>
    </div>
    <div class="health-card">
      <span class="health-num">${h.adVariations.actual} / ${h.adVariations.target}${h.adVariations.targetIsSample ? ' <span class="sample-tag">sample target</span>' : ''}</span>
      <div class="health-label">Ad Variations</div>
      <div class="health-sub">Weekly target</div>
    </div>`;
}

document.getElementById('week-prev').addEventListener('click', () => {
  dashboardWeekOffset -= 1;
  loadDashboard();
});
document.getElementById('week-next').addEventListener('click', () => {
  dashboardWeekOffset += 1;
  loadDashboard();
});
document.getElementById('week-current').addEventListener('click', () => {
  dashboardWeekOffset = 0;
  loadDashboard();
});

document.getElementById('action-new-creative').addEventListener('click', () => openAssetModal(null));
document.getElementById('action-pipeline').addEventListener('click', () => switchTab('board'));
document.getElementById('action-library').addEventListener('click', () => switchTab('board'));
document.getElementById('action-brief-builder').addEventListener('click', () => {
  toast("Brief Builder isn't built yet — coming in a future phase.");
});

// ── Planning ─────────────────────────────────────────

function formatDate(value) {
  return value ? String(value).slice(0, 10) : null;
}

function renderPlanning() {
  renderPlanningWeekHeader();
  renderPlanningStepNav();
  renderDropsRow();
  loadDropSuggestions();
  renderPlanningRoute();
  renderShootPlanStep();
  renderPlanningShootPlanSummary();
}

// ── Planning steps (Monday's guided workflow) ────────
// Core -> High Stocks -> Upcoming Drops -> Promotions -> Shoot Plan: one
// step visible at a time (mutually exclusive, unlike the accordion pattern
// still used for the independent Past Drops section below), freely
// clickable forward/backward. No refetch on switch -- everything's already
// loaded by loadAll().
const PLANNING_STEPS = ['core', 'high-stocks', 'drops', 'promotions', 'shoot-plan'];
function setPlanningStep(key) {
  state.planningStep = key;
  document.querySelectorAll('.planning-step-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.step === key));
  document.querySelectorAll('.planning-step-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.step === key));
  // The persistent "This Week's Shoot Plan" summary is redundant on the
  // Shoot Plan step itself -- that step already is this summary, in full.
  document.getElementById('planning-shoot-plan-summary-block').style.display = key === 'shoot-plan' ? 'none' : '';
}
document.querySelectorAll('.planning-step-btn').forEach((btn) => {
  btn.addEventListener('click', () => setPlanningStep(btn.dataset.step));
});

// Same "samples required" definition as the Shoot Plan step's own stat --
// only "Bring from Warehouse" colourway+size rows count, so this header
// line never disagrees with the number the step itself shows.
function renderPlanningShootSummary() {
  const samplesRequired = shootPlanWarehouseRows().length;
  document.getElementById('planning-shoot-summary').textContent =
    `${state.shootPlan.length} product${state.shootPlan.length === 1 ? '' : 's'} selected · ${samplesRequired} sample${samplesRequired === 1 ? '' : 's'} required`;
}

// ── Planning sub-navigation (list / drop / product / promotion / stage) ──
// Hash-routed so a drop, product, promotion, or stage is a genuinely
// separate view (not an inline expand), with working back/forward. Scheme:
//   #planning/drop/<id>
//   #planning/drop/<id>/product/<productCode>
//   #planning/promotion/<id>
//   #planning/promotion/<id>/stage/<stageId>
function parsePlanningHash() {
  const parts = window.location.hash.replace(/^#planning\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'drop' && parts[1]) {
    if (parts[2] === 'product' && parts[3]) {
      return { view: 'product', dropId: Number(parts[1]), productCode: decodeURIComponent(parts[3]) };
    }
    return { view: 'drop', dropId: Number(parts[1]) };
  }
  if (parts[0] === 'promotion' && parts[1]) {
    if (parts[2] === 'stage' && parts[3]) {
      return { view: 'promotion-stage', promotionId: Number(parts[1]), stageId: Number(parts[3]) };
    }
    return { view: 'promotion', promotionId: Number(parts[1]) };
  }
  return { view: 'list' };
}

function goToPlanningList() {
  window.location.hash = '#planning';
}

function renderPlanningRoute() {
  const route = parsePlanningHash();
  document.getElementById('planning-list-view').style.display = route.view === 'list' ? 'block' : 'none';
  document.getElementById('planning-drop-view').style.display = route.view === 'drop' ? 'block' : 'none';
  document.getElementById('planning-product-view').style.display = route.view === 'product' ? 'block' : 'none';
  document.getElementById('planning-promotion-view').style.display = route.view === 'promotion' ? 'block' : 'none';
  document.getElementById('planning-promotion-stage-view').style.display = route.view === 'promotion-stage' ? 'block' : 'none';

  if (route.view === 'drop' || route.view === 'product') {
    // So "Back to Planning" always lands on the Drops step, not Core --
    // covers both clicking into a drop from Step 3 and a direct page
    // reload on a #planning/drop/<id> hash (state.planningStep resets to
    // 'core' on every fresh load otherwise).
    setPlanningStep('drops');
  } else if (route.view === 'promotion' || route.view === 'promotion-stage') {
    setPlanningStep('promotions');
  }

  if (route.view === 'drop') {
    loadDropView(route.dropId);
  } else if (route.view === 'product') {
    document.getElementById('product-view-back').onclick = () => { window.location.hash = `#planning/drop/${route.dropId}`; };
    loadProductView(route.dropId, route.productCode);
  } else if (route.view === 'promotion') {
    loadPromotionView(route.promotionId);
  } else if (route.view === 'promotion-stage') {
    document.getElementById('promotion-stage-view-back').onclick = () => { window.location.hash = `#planning/promotion/${route.promotionId}`; };
    loadPromotionStageView(route.promotionId, route.stageId);
  }
}
window.addEventListener('hashchange', renderPlanningRoute);

// Every ApparelMagic launch date -- upcoming AND already-launched within the
// Past Drops window -- should already have a Drop card on the Planning page
// without anyone clicking "+ New Drop" -- name is left blank ("Untitled",
// see renderDropsRow/loadDropView) for the team to fill in later via Edit.
// POST /from-suggestion is idempotent per launch_date (reuses an existing
// drop for that date rather than duplicating it), and once a cluster's
// styles are assigned they drop out of future /suggestions results -- so
// calling this on every Planning load is safe and naturally stops doing
// anything once the list is caught up.
async function loadDropSuggestions() {
  try {
    const { suggestions } = await api(`/drops/suggestions?pastDays=${PAST_DROPS_WINDOW_DAYS}`);
    if (suggestions.length) {
      for (const s of suggestions) {
        await api('/drops/from-suggestion', {
          method: 'POST',
          body: JSON.stringify({ launch_date: s.launch_date, styles: s.styles }),
        });
      }
      loadAll();
      return;
    }
    state.dropSuggestions = suggestions;
  } catch (e) {
    state.dropSuggestions = [];
  }
}

function suggestionForDate(dateStr) {
  return (state.dropSuggestions || []).find((s) => s.launch_date === dateStr);
}

function renderDropQuickpicks(selectedDate) {
  const row = document.getElementById('drop-date-quickpicks');
  const suggestions = state.dropSuggestions || [];
  if (!suggestions.length) {
    row.innerHTML = '';
    return;
  }
  row.innerHTML = suggestions.map((s) => `
    <button type="button" class="quickpick-chip ${s.launch_date === selectedDate ? 'active' : ''}" data-date="${s.launch_date}">
      ${formatDate(s.launch_date)} (${s.styles.length})
    </button>`).join('');
  row.querySelectorAll('.quickpick-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.getElementById('drop-launch-date').value = chip.dataset.date;
      onDropDateChange();
    });
  });
}

function onDropDateChange() {
  // Editing an existing drop doesn't re-cluster ApparelMagic styles for a
  // changed date -- the quickpicks/note are a create-time convenience only.
  if (document.getElementById('drop-id').value) return;
  const date = document.getElementById('drop-launch-date').value;
  renderDropQuickpicks(date);
  const note = document.getElementById('drop-date-note');
  if (!date) {
    note.textContent = '';
    return;
  }
  const suggestion = suggestionForDate(date);
  note.textContent = suggestion && suggestion.styles.length
    ? `${suggestion.styles.length} style${suggestion.styles.length === 1 ? '' : 's'} launching this date will be auto-included from ApparelMagic.`
    : 'No ApparelMagic styles found for this date — the drop will be created without any styles pre-assigned. Add styles manually afterwards from Styles & Categories.';
}
document.getElementById('drop-launch-date').addEventListener('change', onDropDateChange);

// ── Planning: week navigation ─────────────────────────
// Four statuses only -- Upcoming for any future week, then Planning in
// Progress / Shoot Plan Confirmed / Completed depending on whether this
// specific week's confirmation exists and whether it's the current week.
function planningWeekStatus() {
  if (state.planningWeekOffset > 0) return { label: 'Upcoming', cls: 'upcoming' };
  const confirmed = Boolean(state.weeklyShootPlanConfirmation);
  if (!confirmed) return { label: 'Planning in Progress', cls: 'in-progress' };
  return state.planningWeekOffset === 0
    ? { label: '✓ Week Confirmed', cls: 'confirmed' }
    : { label: '✓ Completed', cls: 'completed' };
}

function renderPlanningWeekHeader() {
  document.getElementById('planning-week-label').textContent = `Week ${planningWeekNumber()}`;
  document.getElementById('planning-this-week-btn').style.display = state.planningWeekOffset === 0 ? 'none' : '';
  const status = planningWeekStatus();
  const statusEl = document.getElementById('planning-week-status');
  statusEl.textContent = status.label;
  statusEl.className = `planning-week-status planning-week-status-${status.cls}`;
}

function changePlanningWeek(delta) {
  state.planningWeekOffset += delta;
  onPlanningWeekChanged();
}

function goToCurrentPlanningWeek() {
  state.planningWeekOffset = 0;
  onPlanningWeekChanged();
}

function jumpToPlanningWeek(offset) {
  state.planningWeekOffset = offset;
  onPlanningWeekChanged();
}

function onPlanningWeekChanged() {
  closePlanningWeekPicker();
  // Past weeks only have the Shoot Plan step (a historical record) to show
  // -- Core/High Stock/Upcoming Drops/Promotions are always live/current-
  // data views, so land straight on Shoot Plan rather than a step whose
  // tab is about to become disabled.
  if (state.planningWeekOffset < 0) setPlanningStep('shoot-plan');
  loadPlanningWeek();
}

function togglePlanningWeekPicker() {
  const el = document.getElementById('planning-week-picker');
  const opening = el.style.display === 'none';
  if (opening) renderPlanningWeekPicker();
  el.style.display = opening ? '' : 'none';
}

function closePlanningWeekPicker() {
  document.getElementById('planning-week-picker').style.display = 'none';
}

// Jump list: 8 weeks ahead through 12 weeks back, newest first -- "further
// backwards/forwards" without an unbounded (and mostly useless) list.
function renderPlanningWeekPicker() {
  const rows = [];
  for (let offset = 8; offset >= -12; offset--) {
    const monday = mondayOfWeek(offset);
    rows.push({ offset, number: isoWeekNumber(monday), range: formatWeekRange(monday) });
  }
  document.getElementById('planning-week-picker').innerHTML = rows.map((r) => `
    <button type="button" class="planning-week-picker-row ${r.offset === state.planningWeekOffset ? 'active' : ''}" onclick="jumpToPlanningWeek(${r.offset})">
      <span>Week ${r.number}${r.offset === 0 ? ' · Current' : ''}</span>
      <span class="admin-note">${r.range}</span>
    </button>`).join('');
}

document.addEventListener('click', (e) => {
  const picker = document.getElementById('planning-week-picker');
  if (!picker || picker.style.display === 'none') return;
  if (e.target.closest('#planning-week-picker') || e.target.id === 'planning-week-label') return;
  picker.style.display = 'none';
});

// ── Planning: step nav doubles as the Monday meeting checklist ───────
// The 5 nav tabs themselves answer "where are we / what's reviewed / what's
// left" -- no separate checklist row. First four sections are manually
// marked reviewed via the "Mark as Reviewed" button beside each step's
// Continue button (never auto-set just by opening the tab); Shoot Plan
// ticks itself once Confirm & Send Shoot Plan completes.
async function toggleWeeklyProgress(field) {
  if (state.planningWeekOffset < 0) return; // past weeks are read-only
  const current = Boolean(state.weeklyPlanningProgress && state.weeklyPlanningProgress[field]);
  try {
    const updated = await api('/weekly-planning-progress', {
      method: 'PUT',
      body: JSON.stringify({ week_start: planningWeekStart(), field, value: !current }),
    });
    state.weeklyPlanningProgress = updated;
    renderPlanningStepNav();
  } catch (e) {
    toast(e.message, true);
  }
}

// Reflects review/confirmation state on the step tabs (a small tick, not a
// redesign) and disables the four recommendation tabs for past weeks --
// they're always live/current-data views, so there's nothing truthful to
// show "as it was" for a past week on them; Shoot Plan (the actual
// historical record) stays open. Also repaints each step's own "Mark as
// Reviewed" button so both surfaces always agree.
const PLANNING_STEP_REVIEW_FIELD = { core: 'core_reviewed', 'high-stocks': 'high_stock_reviewed', drops: 'drops_reviewed', promotions: 'promotions_reviewed' };
const PLANNING_STEP_LABELS = { core: '1 Core', 'high-stocks': '2 High Stocks', drops: '3 Upcoming Drops', promotions: '4 Promotions', 'shoot-plan': '5 Shoot Plan' };
const PLANNING_REVIEW_BTN_IDS = { core: 'core-review-btn', 'high-stocks': 'high-stocks-review-btn', drops: 'drops-review-btn', promotions: 'promotions-review-btn' };

function renderPlanningStepNav() {
  const readOnlyPast = state.planningWeekOffset < 0;
  const progress = state.weeklyPlanningProgress || {};
  document.querySelectorAll('.planning-step-btn').forEach((btn) => {
    const step = btn.dataset.step;
    const field = PLANNING_STEP_REVIEW_FIELD[step];
    const reviewed = step === 'shoot-plan' ? Boolean(state.weeklyShootPlanConfirmation) : Boolean(field && progress[field]);
    btn.innerHTML = reviewed
      ? `<span class="planning-step-tick">&#10003;</span> ${PLANNING_STEP_LABELS[step]}`
      : PLANNING_STEP_LABELS[step];
    const disabled = readOnlyPast && step !== 'shoot-plan';
    btn.disabled = disabled;
    btn.classList.toggle('planning-step-btn-disabled', disabled);
  });

  Object.entries(PLANNING_REVIEW_BTN_IDS).forEach(([step, elId]) => {
    const btn = document.getElementById(elId);
    if (!btn) return;
    const reviewed = Boolean(progress[PLANNING_STEP_REVIEW_FIELD[step]]);
    btn.textContent = reviewed ? '✓ Reviewed' : '✓ Mark as Reviewed';
    btn.classList.toggle('planning-review-btn-done', reviewed);
    btn.disabled = readOnlyPast;
  });
}

// Compact, exception-based card for Step 3 (Upcoming Drops): "are we on
// track?" not a per-product worksheet. Derived purely from the already-
// computed d.summary (red/amber counts) -- never recomputes or re-sums
// coverage, just conditionally renders less of the same server data when
// nothing needs attention.
function dropCardHtml(d) {
  const pct = d.summary.overallPct;
  // Same green/amber/red bracket coverageStatus() uses server-side --
  // there's no single overall status field, so it's derived from the
  // already-computed overallPct rather than re-summing per-product statuses.
  const barStatus = pct === null ? '' : (pct >= 100 ? 'green' : pct >= 50 ? 'amber' : 'red');
  return `
    <div class="drop-card" data-drop-id="${d.id}">
      <div class="drop-card-header">
        <div class="drop-card-name ${d.name ? '' : 'untitled'}" data-drop-id="${d.id}" title="Click to rename">${d.name ? escapeHtml(d.name) : 'Untitled'}</div>
        <button type="button" class="drop-card-edit-btn" data-drop-id="${d.id}" title="Edit launch date / notes">Edit</button>
      </div>
      <div class="drop-card-date">${formatDate(d.launch_date)} · ${d.days_until_launch >= 0 ? d.days_until_launch + ' days to launch' : 'Launched'}</div>
      <div class="drop-card-counts">
        <span class="green">🟢 ${d.summary.green}</span>
        <span class="amber">🟠 ${d.summary.amber}</span>
        <span class="red">🔴 ${d.summary.red}</span>
      </div>
      <div class="drop-card-pct">${d.summary.totalCovered} / ${d.summary.totalTarget} creatives${pct !== null ? ' — ' + pct + '%' : ''}</div>
      ${pct !== null ? `<div class="coverage-progress-track"><div class="coverage-progress-fill ${barStatus}" style="width:${Math.min(100, pct)}%;"></div></div>` : ''}
      ${d.most_urgent[0] ? `<div class="drop-card-urgent">Most urgent: ${escapeHtml(d.most_urgent[0].product_name)} (${d.most_urgent[0].current_coverage}/${d.most_urgent[0].creative_target ?? '—'})</div>` : ''}
    </div>`;
}

function wireDropCardRow(row) {
  row.querySelectorAll('.drop-card').forEach((card) => {
    card.addEventListener('click', () => { window.location.hash = `#planning/drop/${card.dataset.dropId}`; });
  });
  row.querySelectorAll('.drop-card-edit-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const drop = state.drops.find((d) => d.id === Number(btn.dataset.dropId));
      openDropModal(drop);
    });
  });
  row.querySelectorAll('.drop-card-name').forEach((nameEl) => {
    nameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      startInlineDropRename(nameEl);
    });
  });
}

// Split by launch date -- a drop moves itself from Upcoming to Past the
// moment its launch date passes, no manual housekeeping needed. Past Drops
// only looks back 60 days -- anything older isn't relevant to day-to-day
// planning and would just be clutter to scroll past.
const PAST_DROPS_WINDOW_DAYS = 60;

function renderDropsRow() {
  const upcoming = state.drops.filter((d) => d.days_until_launch >= 0);
  const past = state.drops.filter((d) => d.days_until_launch < 0 && d.days_until_launch >= -PAST_DROPS_WINDOW_DAYS);

  const upcomingRow = document.getElementById('drops-row-upcoming');
  upcomingRow.innerHTML = upcoming.length
    ? upcoming.map(dropCardHtml).join('')
    : '<div class="attention-empty">No upcoming drops yet — add one to start planning creative coverage.</div>';
  wireDropCardRow(upcomingRow);

  const pastRow = document.getElementById('drops-row-past');
  pastRow.innerHTML = past.length
    ? past.map(dropCardHtml).join('')
    : `<div class="attention-empty">No drops launched in the past ${PAST_DROPS_WINDOW_DAYS} days.</div>`;
  wireDropCardRow(pastRow);

  document.getElementById('drops-step-footer-count').textContent = `${upcoming.length} upcoming drop${upcoming.length === 1 ? '' : 's'}`;
}

// Refreshes just the Upcoming/Past Drops cards' summary numbers -- used
// after a Required Concepts tickbox change inside a Product view, so the
// drop-level progress bar/"X more required" line is already current by the
// time someone navigates back, without a full loadAll() resetting the rest
// of the page's state.
async function refreshDropsRow() {
  try {
    const dropsRes = await api('/drops');
    state.drops = dropsRes.drops;
    renderDropsRow();
  } catch (e) {
    // Non-critical -- the drops row will pick up the change on next full load.
  }
}

function togglePlanningSection(key) {
  const body = document.getElementById(`section-body-${key}`);
  const btn = document.querySelector(`.accordion-toggle[data-section="${key}"]`);
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : '';
  btn.classList.toggle('open', !isOpen);
}

document.querySelectorAll('.accordion-toggle').forEach((btn) => {
  btn.addEventListener('click', () => togglePlanningSection(btn.dataset.section));
});

// Click-to-edit right on the Planning home page's drop card -- no modal,
// since renaming is the one thing an auto-created "Untitled" drop always
// needs. The Edit button/modal is still there for launch date and notes.
function startInlineDropRename(nameEl) {
  const dropId = Number(nameEl.dataset.dropId);
  const drop = state.drops.find((d) => d.id === dropId);
  const original = (drop && drop.name) || '';

  nameEl.textContent = '';
  nameEl.classList.remove('untitled');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'drop-card-name-input';
  input.value = original;
  input.placeholder = 'Untitled';
  nameEl.appendChild(input);
  input.focus();
  input.select();
  input.addEventListener('click', (e) => e.stopPropagation());

  let settled = false;
  const finish = async (save) => {
    if (settled) return;
    settled = true;
    const newValue = input.value.trim();
    if (save && newValue !== original) {
      try {
        const updated = await api(`/drops/${dropId}`, { method: 'PUT', body: JSON.stringify({ name: newValue }) });
        const idx = state.drops.findIndex((d) => d.id === dropId);
        if (idx !== -1) state.drops[idx] = { ...state.drops[idx], name: updated.name };
      } catch (e) {
        toast(e.message, true);
      }
    }
    renderDropsRow();
  };

  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
}

// One SOH/On Order figure per colour -- never blended, so two colours never
// read as if they share (or double) the same pool of stock.
function colourStatsLine(s) {
  const parts = [];
  parts.push(s.soh != null ? `SOH ${s.soh}` : 'SOH —');
  parts.push(s.on_order != null ? `On Order ${s.on_order}` : null);
  return parts.filter(Boolean).join(' · ');
}

async function loadDropView(dropId) {
  state.currentDropId = dropId;
  try {
    const drop = await api(`/drops/${dropId}`);
    state.currentDrop = drop;
    const titleEl = document.getElementById('drop-view-title');
    titleEl.textContent = drop.name || 'Untitled';
    titleEl.classList.toggle('untitled', !drop.name);
    document.getElementById('drop-view-edit-btn').onclick = () => openDropModal(drop);
    const amNote = document.getElementById('drop-view-am-note');
    if (!drop.apparelmagic.configured) {
      amNote.textContent = 'ApparelMagic is not connected — SOH, targets and gaps will show once AM_SUBDOMAIN / AM_TOKEN are set.';
    } else if (drop.apparelmagic.error) {
      amNote.textContent = `ApparelMagic error: ${drop.apparelmagic.error}`;
    } else {
      amNote.textContent = '';
    }
    // Meta Ads is an optional enhancement (the "live on Meta" figure next to
    // each product's coverage) -- unlike ApparelMagic it's not central to
    // this page, so stay silent when it's simply not configured and only
    // speak up if it's configured but erroring.
    const metaAdsNote = document.getElementById('drop-view-meta-ads-note');
    metaAdsNote.textContent = drop.meta_ads.configured && drop.meta_ads.error
      ? `Meta Ads error: ${drop.meta_ads.error}`
      : '';
    document.getElementById('drop-view-summary').innerHTML = `
      <div><strong>${formatDate(drop.launch_date)}</strong><br>Launch date</div>
      <div><strong>${drop.days_until_launch >= 0 ? drop.days_until_launch : 0}</strong><br>Days to launch</div>
      <div><strong>${drop.summary.productCount}</strong><br>Products (${drop.summary.styleCount} colourways)</div>
      <div><strong>${drop.summary.totalCovered} / ${drop.summary.totalTarget}</strong><br>Creatives${drop.summary.overallPct !== null ? ' — ' + drop.summary.overallPct + '%' : ''}</div>
    `;
    renderCoverageGrid(drop.coverage);
  } catch (e) {
    toast(e.message, true);
  }
}

function coverageGapLabel(c) {
  if (c.status === 'green') return '🟢 COVERAGE COMPLETE';
  const icon = c.status === 'amber' ? '🟠' : '🔴';
  return `${icon} ${c.creative_gap} more required`;
}

// Coverage cards here are compact and mostly navigational -- click one to
// open its Product view (per-colour breakdown + existing concepts) -- with
// one action of their own: deciding this product needs shooting this week.
function renderCoverageGrid(coverage) {
  const grid = document.getElementById('coverage-grid');
  if (!coverage.length) {
    grid.innerHTML = '<div class="attention-empty">No styles assigned to this drop yet — assign styles to it from Styles &amp; Categories.</div>';
    return;
  }
  grid.innerHTML = coverage.map((c) => {
    let images;
    if (c.images.length) {
      const idx = (state.coverageImageIndex.get(c.product_code) || 0) % c.images.length;
      const nav = c.images.length > 1 ? `
        <button type="button" class="coverage-card-img-nav coverage-card-img-prev" onclick="event.stopPropagation(); cycleCoverageImage('${c.product_code}', -1)">&#8249;</button>
        <button type="button" class="coverage-card-img-nav coverage-card-img-next" onclick="event.stopPropagation(); cycleCoverageImage('${c.product_code}', 1)">&#8250;</button>
        <span class="coverage-card-img-count">${idx + 1} / ${c.images.length}</span>` : '';
      images = `<img src="${c.images[idx]}" alt="">${nav}`;
    } else {
      images = '<span class="coverage-card-noimg">🖼</span>';
    }
    const pct = c.creative_target ? Math.min(100, Math.round((c.current_coverage / c.creative_target) * 100)) : 0;
    const stockLines = c.soh !== null
      ? c.styles.map((s) => `<div>${c.styles.length > 1 ? s.style_code + ': ' : ''}${colourStatsLine(s)}</div>`).join('')
      : '<div class="coverage-card-unavailable">Stock unavailable</div>';

    return `
    <div class="coverage-card" data-product-code="${c.product_code}">
      <div class="coverage-card-imgrow">${images}</div>
      <div class="coverage-card-body">
        <div class="coverage-card-name">${escapeHtml(c.product_name)}</div>
        <div class="coverage-card-code">${c.product_code} · ${c.styles.length} colour${c.styles.length === 1 ? '' : 's'}</div>
        <div class="coverage-card-stats-stack">${stockLines}</div>
        ${c.soh !== null ? `
          <div class="coverage-card-ratio">${c.current_coverage} / ${c.creative_target}</div>
          <div class="coverage-progress-track"><div class="coverage-progress-fill ${c.status}" style="width:${pct}%;"></div></div>
          <div class="coverage-card-gap ${c.status}">${coverageGapLabel(c)}</div>` : ''}
        ${c.live_meta_ads !== null ? `<div class="coverage-card-live-meta">📡 ${c.live_meta_ads} live on Meta</div>` : ''}
        <button type="button" class="btn btn-primary btn-sm coverage-card-shoot-btn" onclick="event.stopPropagation(); shootThisWeekForCoverage('${c.product_code}')">+ Shoot This Week</button>
      </div>
    </div>`;
  }).join('');
  grid.querySelectorAll('.coverage-card').forEach((card) => {
    card.addEventListener('click', () => {
      window.location.hash = `#planning/drop/${state.currentDropId}/product/${encodeURIComponent(card.dataset.productCode)}`;
    });
  });
}

// Coverage cards show one colourway image at a time (not all of them
// squeezed into one row) with prev/next arrows to step through the rest --
// selection is remembered per product_code so it survives a re-render.
function cycleCoverageImage(productCode, delta) {
  const c = (state.currentDrop && state.currentDrop.coverage || []).find((x) => x.product_code === productCode);
  if (!c || c.images.length < 2) return;
  const current = state.coverageImageIndex.get(productCode) || 0;
  const next = (current + delta + c.images.length) % c.images.length;
  state.coverageImageIndex.set(productCode, next);
  renderCoverageGrid(state.currentDrop.coverage);
}

// ── Product view: per-colour breakdown + existing concepts ──
const ASSET_STATUS_COLORS = {
  not_started: ['var(--surface2)', 'var(--text-muted)'],
  awaiting_proven_concept: ['var(--purple-light)', 'var(--purple)'],
  concept_script: ['var(--blue-light)', 'var(--blue)'],
  filming: ['var(--amber-light)', 'var(--amber)'],
  editing: ['var(--amber-light)', 'var(--amber)'],
  qc: ['var(--teal-light)', 'var(--teal-dark)'],
  uploaded_live: ['var(--green-light)', 'var(--green)'],
};

async function loadProductView(dropId, productCode) {
  try {
    state.currentDropId = dropId;
    // Generating/topping-up the plan can create real Creative Assets (see
    // loadProductPlan) -- run it before fetching the drop, always fresh
    // (never the drop-view's cache), so current_coverage below is never
    // one step behind assets this same view just created.
    await loadProductPlan(dropId, productCode);

    const drop = await api(`/drops/${dropId}`);
    state.currentDrop = drop;
    const group = drop.coverage.find((c) => c.product_code === productCode);
    if (!group) {
      toast('Product not found in this drop', true);
      window.location.hash = `#planning/drop/${dropId}`;
      return;
    }
    state.currentProduct = group;

    document.getElementById('product-view-name').textContent = group.product_name;
    document.getElementById('product-view-code').textContent = `${group.product_code} · ${group.styles.length} colour${group.styles.length === 1 ? '' : 's'}`;
    document.getElementById('product-view-images').innerHTML = group.images.length
      ? group.images.slice(0, 4).map((url) => `<img src="${url}" alt="">`).join('')
      : '<span class="no-img">🖼</span>';

    document.getElementById('product-view-colours').innerHTML = group.styles.map((s) => `
      <div class="product-view-colour-card">
        ${s.image_url ? `<img src="${s.image_url}" alt="">` : '<span class="no-img">🖼</span>'}
        <div>
          <div class="product-view-colour-code">${s.style_code}</div>
          <div class="product-view-colour-stats">${colourStatsLine(s)}</div>
        </div>
      </div>`).join('');

    const pct = group.creative_target ? Math.min(100, Math.round((group.current_coverage / group.creative_target) * 100)) : 0;
    const liveMetaLine = group.live_meta_ads !== null ? `<div class="coverage-card-live-meta">📡 ${group.live_meta_ads} live on Meta</div>` : '';
    document.getElementById('product-view-overview').innerHTML = group.soh !== null ? `
      <div class="coverage-card-ratio">${group.current_coverage} / ${group.creative_target} creatives</div>
      <div class="coverage-progress-track"><div class="coverage-progress-fill ${group.status}" style="width:${pct}%;"></div></div>
      <div class="coverage-card-gap ${group.status}">${coverageGapLabel(group)}</div>
      ${liveMetaLine}
    ` : `<div class="coverage-card-unavailable">Stock unavailable</div>${liveMetaLine}`;

    const planBtn = document.getElementById('product-view-plan-btn');
    planBtn.style.display = group.creative_gap > 0 || group.creative_gap === null ? 'inline-block' : 'none';
    planBtn.onclick = () => openAssetModal(null, { presetStyleIds: group.styles.map((s) => s.style_id) });

    const styleIds = group.styles.map((s) => s.style_id).join(',');
    const assets = await api(`/creative-assets?style_ids=${styleIds}`);
    state.currentProductAssets = assets;
    renderProductConcepts(assets);
    // Re-render now that state.currentProductAssets is fresh (it feeds the
    // fallback "Link existing" list on any still-unfulfilled slot).
    renderRequiredConcepts(currentProductPlan);
  } catch (e) {
    toast(e.message, true);
  }
}

function renderProductConcepts(assets) {
  const grid = document.getElementById('product-view-concepts');
  if (!assets.length) {
    grid.innerHTML = '<div class="attention-empty">No creative work started for this product yet.</div>';
    return;
  }
  grid.innerHTML = assets.map((a) => {
    const [bg, fg] = ASSET_STATUS_COLORS[a.status] || ASSET_STATUS_COLORS.not_started;
    return `
    <div class="job-card" data-asset-id="${a.id}">
      <div class="job-card-concept">${escapeHtml(a.concept_name)}</div>
      <div class="job-card-products">${a.style_code} · ${a.format}</div>
      <div class="job-status-row">
        <span class="job-status-pill" style="background:${bg};color:${fg};">${STATUS_LABELS[a.status]}</span>
        <span class="badge badge-${a.concept_classification}">${CLASSIFICATION_LABELS[a.concept_classification]}</span>
        ${a.fulfills_slot_rank ? `<span class="badge badge-tested_proven">Required Concept #${a.fulfills_slot_rank}</span>` : ''}
      </div>
    </div>`;
  }).join('');
  grid.querySelectorAll('.job-card').forEach((card) => {
    card.addEventListener('click', () => {
      const asset = assets.find((a) => a.id === Number(card.dataset.assetId));
      openAssetModal(asset);
    });
  });
}

// ── Product view: Required Concepts (Proven Winners feature) ────────────
// Lazily generates-or-tops-up the product's concept plan on every view (the
// server-side POST is idempotent -- it only ever appends new proven slots
// up to the live target, never rewrites existing ones), so "SOH 327 -> 8
// slots already there" is true with no manual click.
let currentProductPlan = null;

// Fetches and returns the plan only -- does not render (renderRequiredConcepts
// depends on state.currentProductAssets, which isn't fetched yet at this
// point in loadProductView; the caller renders once everything is ready).
async function loadProductPlan(dropId, productCode) {
  try {
    let data = await api(`/drop-product-plans?drop_id=${dropId}&product_code=${encodeURIComponent(productCode)}`);
    if (data.target != null && (data.plan === null || data.shortfall > 0)) {
      data = await api('/drop-product-plans', {
        method: 'POST',
        body: JSON.stringify({ drop_id: dropId, product_code: productCode }),
      });
    }
    currentProductPlan = data;
    return data;
  } catch (e) {
    toast(e.message, true);
  }
}

function renderRequiredConcepts(data) {
  const list = document.getElementById('product-plan-slots');
  const note = document.getElementById('product-plan-shortfall-note');
  const addBtn = document.getElementById('product-plan-add-new-btn');

  if (data.target == null) {
    list.innerHTML = '<div class="attention-empty">Stock unavailable — Required Concepts can\'t be generated until SOH is known.</div>';
    note.textContent = '';
    addBtn.style.display = 'none';
    return;
  }

  note.textContent = `${data.slots.length} / ${data.target} Concepts Assigned`
    + (data.shortfall > 0 ? ` · ${data.shortfall} Additional Concept${data.shortfall === 1 ? '' : 's'} Required` : '');
  addBtn.style.display = 'inline-block';

  const linkedAssetIds = new Set(data.slots.filter((s) => s.asset_id).map((s) => s.asset_id));
  const eligibleAssets = (state.currentProductAssets || []).filter((a) => !linkedAssetIds.has(a.id));

  if (!data.slots.length) {
    list.innerHTML = '<div class="attention-empty">No required concepts yet.</div>';
    return;
  }

  list.innerHTML = data.slots.map((s) => {
    const fulfilled = !!s.asset_id;
    const sourceBadge = s.source === 'proven'
      ? '<span class="badge badge-tested_proven">Proven</span>'
      : '<span class="badge badge-new_experimental">New/Test</span>';
    // Fulfilled rows get an actual tickbox (not just a static ✓) -- checking
    // it marks the concept done, unchecking reverts it. See toggleConceptDone.
    const statusIcon = fulfilled
      ? `<input type="checkbox" class="pw-slot-done-checkbox" data-asset-id="${s.asset_id}" ${s.asset_status === 'uploaded_live' ? 'checked' : ''} title="Mark this concept done">`
      : '<span class="pw-slot-status unfulfilled">○</span>';
    const fulfilledLine = fulfilled
      ? `<span class="job-status-pill">${assetStatusLabel(s.asset_status)}</span>`
      : '';
    // A slot's asset is created automatically the moment the slot exists
    // (Settings already decided the concept name/format/classification),
    // so the normal path is just editing it -- style/target date/owner, or
    // moving it through the pipeline. "+ Create Asset" only resurfaces as a
    // fallback for a slot that somehow has no asset (e.g. its asset was
    // deleted, or a slot generated before this behavior shipped).
    const actions = fulfilled ? `
        <button type="button" class="btn btn-ghost btn-sm" onclick="editConceptAsset(${s.asset_id})">Edit</button>
      ` : `
        <button type="button" class="btn btn-ghost btn-sm" onclick="fulfillWithNewAsset(${s.id}, '${escapeHtml(s.concept_name).replace(/'/g, "\\'")}', '${s.source}', '${s.default_format || ''}', '${s.default_classification || ''}')">+ Create Asset</button>
        ${eligibleAssets.length ? `
          <select class="pw-slot-link-select" data-slot-id="${s.id}">
            <option value="">Link existing…</option>
            ${eligibleAssets.map((a) => `<option value="${a.id}">${a.style_code} — ${escapeHtml(a.concept_name)}</option>`).join('')}
          </select>
        ` : ''}
        ${s.source === 'new' ? `<button type="button" class="btn btn-ghost btn-sm" onclick="deleteConceptSlot(${s.id})">Remove</button>` : ''}
      `;
    return `
    <div class="pw-slot-row">
      ${statusIcon}
      <span class="pw-slot-rank">${s.slot_rank}</span>
      <span class="pw-slot-name">${escapeHtml(s.concept_name)}</span>
      ${sourceBadge}
      ${fulfilledLine}
      ${actions}
    </div>`;
  }).join('');

  list.querySelectorAll('.pw-slot-link-select').forEach((sel) => {
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      linkExistingAsset(Number(sel.dataset.slotId), Number(sel.value));
    });
  });

  list.querySelectorAll('.pw-slot-done-checkbox').forEach((cb) => {
    cb.addEventListener('change', () => toggleConceptDone(Number(cb.dataset.assetId), cb.checked));
  });
}

// Fast "mark done" shortcut straight to the Board's final Kanban status --
// reuses the same status field/endpoint the Board's drag-and-drop uses, so
// Board and Planning always agree, and current_coverage (this product's
// progress bar, plus the Drop card back in Upcoming/Past Drops) picks it up
// automatically since it now only counts 'uploaded_live' assets, not just an
// asset row existing. Unticking reverts to 'not_started' -- same as dragging
// a Board card backwards; nothing is lost since status_history is append-only.
async function toggleConceptDone(assetId, done) {
  try {
    await api(`/creative-assets/${assetId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: done ? 'uploaded_live' : 'not_started' }),
    });
    await loadProductView(state.currentDropId, state.currentProduct.product_code);
    await refreshDropsRow();
  } catch (e) {
    toast(e.message, true);
  }
}

function assetStatusLabel(status) {
  return STATUS_LABELS[status] || status;
}


// Proven slots snapshot their Format/Classification from the Proven Winner
// at generation time (Settings), so there's nothing to re-pick -- those two
// fields are locked to the preset. A New/Test slot has no preset, so they
// stay fully editable, same as creating any other asset.
function fulfillWithNewAsset(slotId, conceptName, source, defaultFormat, defaultClassification) {
  const group = state.currentProduct;
  openAssetModal(null, {
    presetConceptName: conceptName,
    presetStyleIds: group.styles.map((s) => s.style_id),
    presetFormat: defaultFormat || 'video',
    defaultClassification: defaultClassification || (source === 'proven' ? 'tested_proven' : 'new_experimental'),
    fulfillsSlotId: slotId,
    lockFormatClassification: source === 'proven',
  });
}

// Link/unlink/remove all reload the whole product view (drop + plan +
// existing-concepts) rather than hand-patching local state -- matches this
// app's established pattern of a full reload after any mutation (saveAsset,
// etc.), and keeps the "Required Concept #N" badge on the linked asset's
// Existing Concepts card in sync too.
async function linkExistingAsset(slotId, assetId) {
  try {
    await api(`/drop-product-plans/${currentProductPlan.plan.id}/slots/${slotId}/fulfill`, {
      method: 'PATCH',
      body: JSON.stringify({ asset_id: assetId }),
    });
    loadProductView(state.currentDropId, state.currentProduct.product_code);
  } catch (e) {
    toast(e.message, true);
  }
}

// Fulfilled rows only ever show "Edit" -- deleting the asset from there
// (the modal's existing Delete button) unlinks the slot automatically
// (fulfilled_by_asset_id is ON DELETE SET NULL), so there's no separate
// "Unlink" action to expose.
async function editConceptAsset(assetId) {
  try {
    const asset = await api(`/creative-assets/${assetId}`);
    openAssetModal(asset);
  } catch (e) {
    toast(e.message, true);
  }
}

async function deleteConceptSlot(slotId) {
  if (!(await confirmDialog('Remove this concept slot? This only works for manually-added New/Test slots with no linked asset.'))) return;
  try {
    await api(`/drop-product-plans/${currentProductPlan.plan.id}/slots/${slotId}`, { method: 'DELETE' });
    loadProductView(state.currentDropId, state.currentProduct.product_code);
  } catch (e) {
    toast(e.message, true);
  }
}

function showAddNewConceptForm() {
  document.getElementById('product-plan-add-new-form').style.display = 'flex';
}

function hideAddNewConceptForm() {
  document.getElementById('product-plan-add-new-form').style.display = 'none';
}

async function addNewConceptSlot() {
  const name = document.getElementById('new-concept-name').value;
  const format = document.getElementById('new-concept-format').value;
  const description = document.getElementById('new-concept-description').value || null;
  if (!name.trim()) return toast('Concept name is required', true);
  try {
    // Creates the slot AND its Creative Asset together, so a full reload
    // (rather than local state patching) picks up both the new Required
    // Concepts row and the new Existing Concepts card in one go.
    await api(`/drop-product-plans/${currentProductPlan.plan.id}/slots`, {
      method: 'POST',
      body: JSON.stringify({ concept_name: name, format, description }),
    });
    document.getElementById('new-concept-name').value = '';
    document.getElementById('new-concept-description').value = '';
    hideAddNewConceptForm();
    toast('Concept added');
    loadProductView(state.currentDropId, state.currentProduct.product_code);
  } catch (e) {
    toast(e.message, true);
  }
}

document.getElementById('product-plan-add-new-btn').addEventListener('click', showAddNewConceptForm);

document.getElementById('new-drop-btn').addEventListener('click', () => openDropModal(null));

// drop=null for a fresh manual drop (name optional -- most drops now arrive
// already-created via loadDropSuggestions' auto-create pass, so this is
// mainly for a custom/off-catalogue drop); drop=existing to rename/edit one
// (most commonly, giving an auto-created "Untitled" drop its real name).
function openDropModal(drop) {
  document.getElementById('drop-modal-title').textContent = drop ? 'Edit Drop' : 'New Drop';
  document.getElementById('drop-id').value = drop ? drop.id : '';
  document.getElementById('drop-name').value = (drop && drop.name) || '';
  document.getElementById('drop-launch-date').value = drop ? drop.launch_date.slice(0, 10) : '';
  document.getElementById('drop-notes').value = (drop && drop.notes) || '';
  document.getElementById('drop-date-note').textContent = '';
  document.getElementById('drop-save-btn').textContent = drop ? 'Save' : 'Add';
  document.getElementById('drop-delete-btn').style.display = drop ? 'inline-block' : 'none';
  // Quickpicks/auto-style-population are a create-time convenience only --
  // editing an existing drop doesn't re-cluster ApparelMagic styles.
  document.getElementById('drop-date-quickpicks').style.display = drop ? 'none' : 'flex';
  if (!drop) renderDropQuickpicks(null);
  openModal('drop-modal');
}

async function deleteDrop() {
  const id = document.getElementById('drop-id').value;
  if (!id) return;
  if (!(await confirmDialog('Delete this drop? Its styles are unassigned, not deleted, and can be added to another drop later.'))) return;
  try {
    await api(`/drops/${id}`, { method: 'DELETE' });
    closeModal('drop-modal');
    toast('Drop deleted');
    loadAll();
  } catch (e) {
    toast(e.message, true);
  }
}

async function saveDrop() {
  const id = document.getElementById('drop-id').value;
  const name = document.getElementById('drop-name').value || null;
  const launch_date = document.getElementById('drop-launch-date').value;
  const notes = document.getElementById('drop-notes').value || null;
  if (!launch_date) return toast('Launch date is required', true);

  try {
    if (id) {
      await api(`/drops/${id}`, { method: 'PUT', body: JSON.stringify({ name, launch_date, notes }) });
    } else {
      // Any ApparelMagic styles launching this exact date are auto-included
      // -- no manual review step, per how this flow is meant to work.
      const suggestion = suggestionForDate(launch_date);
      const styles = suggestion ? suggestion.styles : [];
      if (styles.length) {
        await api('/drops/from-suggestion', { method: 'POST', body: JSON.stringify({ name, launch_date, notes, styles }) });
      } else {
        await api('/drops', { method: 'POST', body: JSON.stringify({ name, launch_date, notes }) });
      }
    }
    closeModal('drop-modal');
    toast('Drop saved');
    loadAll();
  } catch (e) {
    toast(e.message, true);
  }
}

// ── Styles/categories tables ─────────────────────────
function renderStylesTable() {
  const tbody = document.querySelector('#styles-table tbody');
  tbody.innerHTML = state.styles
    .map(
      (s) => `
      <tr data-style-id="${s.id}" style="cursor:pointer;">
        <td>${s.style_code}</td>
        <td>${escapeHtml(s.name)}</td>
        <td><span class="badge badge-tier-${s.tier}">${TIER_LABELS[s.tier]}</span></td>
        <td>${s.category_name || '—'}</td>
        <td>${s.drop_name || '—'}</td>
        <td>${s.creative_asset_count}</td>
        <td>${s.missing_ad ? '<span class="badge" style="background:var(--amber-light);color:var(--amber);">Missing Ad</span>' : ''}</td>
      </tr>`
    )
    .join('');
  tbody.querySelectorAll('tr').forEach((row) => {
    row.addEventListener('click', () => openStyleModal(state.styles.find((s) => s.id === Number(row.dataset.styleId))));
  });
}

function populateStyleDropSelect(selectedId) {
  const sel = document.getElementById('style-drop-id');
  sel.innerHTML = '<option value="">— none —</option>' + state.drops.map((d) => `<option value="${d.id}" ${d.id === selectedId ? 'selected' : ''}>${escapeHtml(d.name || 'Untitled')}</option>`).join('');
}

function openStyleModal(style) {
  document.getElementById('style-id').value = style ? style.id : '';
  document.getElementById('style-code').value = style ? style.style_code : '';
  document.getElementById('style-name').value = style ? style.name : '';
  document.getElementById('style-tier').value = style ? style.tier : 'core_proven';
  document.getElementById('style-category-id').value = style ? style.category_id || '' : '';
  populateStyleDropSelect(style ? style.drop_id : null);
  openModal('style-modal');
}

function renderCategoriesTable() {
  const tbody = document.querySelector('#categories-table tbody');
  tbody.innerHTML = state.categories
    .map(
      (c) => `
      <tr>
        <td>${escapeHtml(c.name)}</td>
        <td>${c.meta_campaign_id || '—'}</td>
        <td>${c.meta_ad_set_id || '—'}</td>
        <td></td>
      </tr>`
    )
    .join('');
}

function populateStyleSelect(filterIds) {
  const sel = document.getElementById('asset-style-id');
  const styles = filterIds ? state.styles.filter((s) => filterIds.includes(s.id)) : state.styles;
  sel.innerHTML = styles.map((s) => `<option value="${s.id}">${s.style_code} — ${escapeHtml(s.name)}</option>`).join('');
}

function populateCategorySelect() {
  const sel = document.getElementById('style-category-id');
  sel.innerHTML = '<option value="">— none —</option>' + state.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

// ── Modals ───────────────────────────────────────────
function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}
function openModal(id) {
  document.getElementById(id).classList.add('show');
}

// In-app replacement for the browser's native confirm() -- resolves true/false.
function confirmDialog(message, opts) {
  const okLabel = (opts && opts.okLabel) || 'Delete';
  return new Promise((resolve) => {
    document.getElementById('confirm-message').textContent = message;
    const okBtn = document.getElementById('confirm-ok-btn');
    const cancelBtn = document.getElementById('confirm-cancel-btn');
    okBtn.textContent = okLabel;
    const cleanup = (result) => {
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      closeModal('confirm-modal');
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    openModal('confirm-modal');
  });
}

document.getElementById('new-asset-btn').addEventListener('click', () => openAssetModal(null));
document.getElementById('new-style-btn').addEventListener('click', () => openStyleModal(null));
document.getElementById('new-category-btn').addEventListener('click', () => {
  document.getElementById('category-name').value = '';
  document.getElementById('category-campaign-id').value = '';
  document.getElementById('category-adset-id').value = '';
  document.getElementById('category-notes').value = '';
  openModal('category-modal');
});

function openAssetModal(card, presets = {}) {
  document.getElementById('asset-modal-title').textContent = card ? 'Edit Creative Asset' : 'New Creative Asset';
  document.getElementById('asset-id').value = card ? card.id : '';
  populateStyleSelect(presets.presetStyleIds);
  document.getElementById('asset-style-id').value = card ? card.style_id : (presets.presetStyleIds ? presets.presetStyleIds[0] : (state.styles[0] ? state.styles[0].id : ''));
  document.getElementById('asset-concept-name').value = card ? card.concept_name : (presets.presetConceptName || '');
  document.getElementById('asset-format').value = card ? card.format : (presets.presetFormat || 'video');
  document.getElementById('asset-classification').value = card ? card.concept_classification : (presets.defaultClassification || 'new_experimental');
  const lockPresets = !card && !!presets.lockFormatClassification;
  document.getElementById('asset-format').disabled = lockPresets;
  document.getElementById('asset-classification').disabled = lockPresets;
  document.getElementById('asset-format-locked-hint').style.display = lockPresets ? 'block' : 'none';
  document.getElementById('asset-deliberate-trial').checked = card ? !!card.is_deliberate_trial : false;
  document.getElementById('asset-target-date').value = card && card.target_date ? card.target_date.slice(0, 10) : '';
  document.getElementById('asset-strategy-owner').value = (card && card.strategy_owner) || '';
  document.getElementById('asset-filming-owner').value = (card && card.filming_owner) || '';
  document.getElementById('asset-editing-owner').value = (card && card.editing_owner) || '';
  document.getElementById('asset-qc-owner').value = (card && card.qc_owner) || '';
  document.getElementById('asset-delete-btn').style.display = card ? 'inline-block' : 'none';
  document.getElementById('asset-fulfills-slot-id').value = card ? '' : (presets.fulfillsSlotId || '');
  openModal('asset-modal');
}

async function saveAsset() {
  const id = document.getElementById('asset-id').value;
  const payload = {
    style_id: Number(document.getElementById('asset-style-id').value),
    concept_name: document.getElementById('asset-concept-name').value,
    format: document.getElementById('asset-format').value,
    concept_classification: document.getElementById('asset-classification').value,
    is_deliberate_trial: document.getElementById('asset-deliberate-trial').checked,
    target_date: document.getElementById('asset-target-date').value || null,
    strategy_owner: document.getElementById('asset-strategy-owner').value || null,
    filming_owner: document.getElementById('asset-filming-owner').value || null,
    editing_owner: document.getElementById('asset-editing-owner').value || null,
    qc_owner: document.getElementById('asset-qc-owner').value || null,
  };
  const fulfillsSlotId = document.getElementById('asset-fulfills-slot-id').value;
  if (!id && fulfillsSlotId) payload.fulfills_slot_id = Number(fulfillsSlotId);
  if (!payload.concept_name.trim()) return toast('Concept name is required', true);
  if (!payload.style_id) return toast('Select a style', true);

  try {
    if (id) {
      await api(`/creative-assets/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api('/creative-assets', { method: 'POST', body: JSON.stringify(payload) });
    }
    closeModal('asset-modal');
    toast('Creative asset saved');
    loadAll();
    refreshProductViewIfOpen();
  } catch (e) {
    toast(e.message, true);
  }
}

async function deleteAsset() {
  const id = document.getElementById('asset-id').value;
  if (!id) return;
  if (!(await confirmDialog('Delete this creative asset? This cannot be undone.'))) return;
  try {
    await api(`/creative-assets/${id}`, { method: 'DELETE' });
    closeModal('asset-modal');
    toast('Creative asset deleted');
    loadAll();
    refreshProductViewIfOpen();
  } catch (e) {
    toast(e.message, true);
  }
}

// Saving/deleting an asset changes the product's raw creative_assets count
// (current_coverage), which loadAll() doesn't know how to refresh (it isn't
// part of loadAll's fetch set -- see loadProductView).
function refreshProductViewIfOpen() {
  if (document.getElementById('planning-product-view').style.display !== 'none' && state.currentProduct) {
    loadProductView(state.currentDropId, state.currentProduct.product_code);
  }
}

async function saveStyle() {
  const id = document.getElementById('style-id').value;
  const payload = {
    style_code: document.getElementById('style-code').value,
    name: document.getElementById('style-name').value,
    tier: document.getElementById('style-tier').value,
    category_id: document.getElementById('style-category-id').value || null,
    drop_id: document.getElementById('style-drop-id').value || null,
  };
  if (!payload.style_code.trim() || !payload.name.trim()) return toast('Style code and name are required', true);
  try {
    if (id) {
      await api(`/styles/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api('/styles', { method: 'POST', body: JSON.stringify(payload) });
    }
    closeModal('style-modal');
    toast('Style saved');
    loadAll();
  } catch (e) {
    toast(e.message, true);
  }
}

async function saveCategory() {
  const payload = {
    name: document.getElementById('category-name').value,
    meta_campaign_id: document.getElementById('category-campaign-id').value || null,
    meta_ad_set_id: document.getElementById('category-adset-id').value || null,
    notes: document.getElementById('category-notes').value || null,
  };
  if (!payload.name.trim()) return toast('Category name is required', true);
  try {
    await api('/categories', { method: 'POST', body: JSON.stringify(payload) });
    closeModal('category-modal');
    toast('Category saved');
    loadAll();
  } catch (e) {
    toast(e.message, true);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : str;
  return div.innerHTML;
}

// ── Planning: Core Creative Testing ──────────────────
// A weekly decision dashboard: a prominent weekly-target progress card up
// top, then Priority (default) -- a compact decision table, ~one row per
// product, so 15-20 Core products can be scanned on one screen -- or By
// Category (secondary, for browsing). Expand state is tracked here (not
// just in the DOM) so it survives a full re-render -- e.g. saving a
// "+ Plan New Concept" job triggers loadAll(), which would otherwise
// collapse everything the team had just opened.
//
// Nothing here recomputes or overrides the server's attention flag/reason
// or any commercial metric -- state.coreProducts already arrives sorted
// Red -> Orange -> Green -> Review, and every value rendered below (soh,
// weeks_cover, on_order, vel7/30/365, days_since_last_new_concept, reason,
// reason_chips) is read straight from the API response.
const CORE_ATTENTION_BADGE_CLASS = {
  needs_attention: 'core-attention-red',
  opportunity: 'core-attention-amber',
  healthy: 'core-attention-green',
  product_review: 'core-attention-review',
};

// Presentational-only sales-trend read from the same vel7/vel30 fields the
// server already returns -- its own human-readable thresholds, purely for
// a quick glance in the compact row. Never feeds back into the attention
// flag/reason, which are decided entirely server-side.
function coreTrendInfo(p) {
  if (!(p.vel30 > 0)) return { label: 'No recent sales', cls: 'core-trend-flat', arrow: '·' };
  const ratio = p.vel7 / p.vel30;
  if (ratio < 0.85) return { label: 'Declining', cls: 'core-trend-down', arrow: '▼' };
  if (ratio > 1.15) return { label: 'Rising', cls: 'core-trend-up', arrow: '▲' };
  return { label: 'Steady', cls: 'core-trend-flat', arrow: '▬' };
}

function toggleCoreCategory(cat) {
  if (state.coreExpandedCategories.has(cat)) state.coreExpandedCategories.delete(cat);
  else state.coreExpandedCategories.add(cat);
  renderCoreProducts();
}

function toggleCoreProduct(productCode) {
  if (state.coreExpandedProducts.has(productCode)) state.coreExpandedProducts.delete(productCode);
  else state.coreExpandedProducts.add(productCode);
  renderCoreProducts();
}

function setCoreView(view) {
  state.coreView = view;
  renderCoreProducts();
}

function coreColoursTableHtml(product) {
  return `
    <table class="core-colours-inner-table">
      <thead><tr><th>Colour</th><th>SOH</th><th>On Order</th></tr></thead>
      <tbody>
        ${product.colours.map((c) => `<tr><td>${escapeHtml(c.style_code)}</td><td>${c.soh != null ? c.soh : '—'}</td><td>${c.on_order != null ? c.on_order : '—'}</td></tr>`).join('')}
      </tbody>
    </table>`;
}

// Supporting metric strip -- SOH / On Order / 7D / 30D / 365D velocity --
// shown only in the expanded detail (Weeks Cover and Last New Concept
// already appear in the compact row, so they aren't repeated here).
function coreMetricRowHtml(p) {
  const metrics = [
    ['SOH', p.soh != null ? p.soh : '—'],
    ['On Order', p.on_order != null ? p.on_order : '—'],
    ['7D Velocity', `${p.vel7}/wk`],
    ['30D Velocity', `${p.vel30}/wk`],
    ['365D Avg', `${p.vel365}/wk`],
  ];
  return `
    <div class="core-metric-row">
      ${metrics.map(([label, value]) => `<div class="core-metric-col"><div class="core-metric-value">${value}</div><div class="core-metric-label">${label}</div></div>`).join('')}
    </div>`;
}

// Expanded detail: SOH/On Order/velocity strip, colourways, and the full
// reasoning sentences (the compact row above only shows short chips).
function corePriorityDetailHtml(p) {
  return `
    <div class="core-priority-detail">
      ${coreMetricRowHtml(p)}
      <div class="core-priority-reasoning"><strong>Why:</strong> ${escapeHtml(p.reason)}</div>
      ${coreColoursTableHtml(p)}
    </div>`;
}

// Compact table row -- Product | Weeks Cover | Sales Trend | Last New
// Concept | Key Reasons | + Plan -- roughly one row per product so 15-20
// Core products scan on one screen. Clicking the row expands it in place.
function corePriorityRowHtml(p, opts = {}) {
  const isOpen = state.coreExpandedProducts.has(p.product_code);
  const trend = coreTrendInfo(p);
  const emoji = p.label.split(' ')[0];
  const categoryTag = opts.showCategory ? `<span class="core-priority-category-tag">${escapeHtml(p.category)}</span>` : '';
  const chips = (p.reason_chips || []).map((c) => `<span class="core-reason-chip">${escapeHtml(c)}</span>`).join('');
  return `
    <div class="core-priority-row ${isOpen ? 'open' : ''}" data-product-code="${p.product_code}">
      <div class="core-priority-row-grid" onclick="toggleCoreProduct('${p.product_code}')">
        <div class="core-priority-col-product">
          <span class="accordion-arrow">&#9656;</span>
          <span class="core-priority-emoji">${emoji}</span>
          <span class="core-product-name">${escapeHtml(p.product_name)}</span>
          ${categoryTag}
        </div>
        <div class="core-priority-col">${p.weeks_cover != null ? `${p.weeks_cover} wks` : '—'}</div>
        <div class="core-priority-col core-trend ${trend.cls}">${trend.arrow} ${trend.label}</div>
        <div class="core-priority-col">${p.days_since_last_new_concept != null ? `${p.days_since_last_new_concept}d` : 'Never'}</div>
        <div class="core-priority-col-chips">${chips}</div>
        <div class="core-priority-col-action">
          <button type="button" class="btn btn-primary btn-sm" onclick="event.stopPropagation(); shootThisWeekForCore('${p.product_code}')">+ Shoot</button>
          <button type="button" class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); planNewConceptForCore('${p.product_code}')">+ Plan</button>
        </div>
      </div>
      ${isOpen ? corePriorityDetailHtml(p) : ''}
    </div>`;
}

function corePriorityHeaderHtml() {
  return `
    <div class="core-priority-row-grid core-priority-header-grid">
      <div class="core-priority-col-product">Product</div>
      <div class="core-priority-col">Weeks Cover</div>
      <div class="core-priority-col">Sales Trend</div>
      <div class="core-priority-col">Last New Concept</div>
      <div class="core-priority-col-chips">Key Reasons</div>
      <div class="core-priority-col-action"></div>
    </div>`;
}

function wireCoreCategoryToggles(container) {
  container.querySelectorAll('.core-category-toggle').forEach((btn) => {
    btn.addEventListener('click', () => toggleCoreCategory(btn.dataset.category));
  });
}

// Rendered on both Dashboard and Planning -- it's the shared basis for
// both views, not a Planning-only stat -- so this updates every instance
// on the page rather than a single hardcoded element.
function renderCoreWeeklyCard() {
  const w = state.coreWeekly || { planned: 0, target: 0, remaining: 0 };
  const pct = w.target > 0 ? Math.min(100, Math.round((w.planned / w.target) * 100)) : 0;
  const met = w.target > 0 && w.planned >= w.target;
  document.querySelectorAll('.core-weekly-card').forEach((card) => {
    card.className = `core-weekly-card ${met ? 'core-weekly-met' : ''}`;
    card.innerHTML = `
      <div class="core-weekly-top">
        <div class="core-weekly-left">
          <div class="core-weekly-icon">🎯</div>
          <div>
            <div class="core-weekly-label">Weekly Core Creative Target</div>
            <div class="core-weekly-title">New Concepts Planned</div>
          </div>
        </div>
        <div class="core-weekly-pct-block">
          <div class="core-weekly-pct">${pct}%</div>
          <div class="core-weekly-pct-sub">${w.planned} / ${w.target} planned</div>
        </div>
      </div>
      <div class="core-weekly-progress-track">
        <div class="core-weekly-progress-fill" style="width:${pct}%;"></div>
      </div>
      <div class="core-weekly-pills">
        <span class="core-weekly-pill core-weekly-pill-planned">${w.planned} Planned</span>
        <span class="core-weekly-pill core-weekly-pill-remaining">${w.remaining} Remaining</span>
      </div>
      <div class="core-weekly-footer">Counts genuinely new Core concepts only — Proven Winner concepts on Upcoming Drops don't count</div>`;
  });
}

function renderCoreViewToggle() {
  document.querySelectorAll('.core-view-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === state.coreView);
  });
}

function renderCoreProductsPriority() {
  return corePriorityHeaderHtml() + state.coreProducts.map((p) => corePriorityRowHtml(p, { showCategory: true })).join('');
}

function renderCoreProductsByCategory() {
  // Each group keeps the existing urgency order -- state.coreProducts
  // already arrives sorted Red -> Orange -> Green -> Review from the server.
  const byCategory = new Map();
  for (const p of state.coreProducts) {
    if (!byCategory.has(p.category)) byCategory.set(p.category, []);
    byCategory.get(p.category).push(p);
  }
  const sortedCategories = [...byCategory.keys()].sort();

  return sortedCategories.map((cat) => {
    const products = byCategory.get(cat);
    const isOpen = state.coreExpandedCategories.has(cat);
    return `
      <div class="core-category-group">
        <button type="button" class="core-category-toggle ${isOpen ? 'open' : ''}" data-category="${escapeHtml(cat)}">
          <span class="accordion-arrow">&#9656;</span>
          <span class="core-category-name">${escapeHtml(cat)}</span>
          <span class="core-category-count">${products.length}</span>
        </button>
        ${isOpen ? `<div class="core-category-body">${corePriorityHeaderHtml()}${products.map((p) => corePriorityRowHtml(p)).join('')}</div>` : ''}
      </div>`;
  }).join('');
}

// Core Shoot Planning (default view): category-first, so a Monday meeting
// sees which categories need attention before drilling into individual
// products -- Category -> Problem Products -> Select for Shoot. Collapsed
// rows show only aggregate counts, never per-product metrics; expanding a
// category surfaces just its problem products (needs_attention/opportunity)
// using the same compact row format as before. The full Priority/By
// Category views (unchanged, every product, full metrics) stay reachable
// via "View All Core Products".
const CORE_STALE_DAYS = 14; // mirrors coreProducts.js's STALE_DAYS_OPPORTUNITY -- display aggregate only, doesn't touch the server's own flag decision

// Static "✓ Shooting" badge once a product is already in this week's Shoot
// Plan -- shared by Core and High Stock rows so both read the same way.
// selectedCodes is built once per render pass (not per row) by the caller.
function shootActionHtml(productCode, onclickFn, selectedCodes) {
  if (selectedCodes.has(productCode)) return '<span class="core-shoot-selected-badge">✓ Shooting</span>';
  return `<button type="button" class="btn btn-primary btn-sm" onclick="${onclickFn}('${productCode}')">+ Shoot</button>`;
}

// Full column header for the product rows below -- the category header
// above (index.html's .core-shoot-category-header) uses a different, wider
// grid than .core-shoot-review-row, so its labels don't line up with these
// rows once a category is expanded. .core-product-row overrides just the
// shared .core-shoot-review-row/-header grid template (see styles.css) --
// that class is also used by High Stock's row with a different column
// count, so the base rule itself is left alone.
function coreProblemProductsHeaderHtml() {
  return `
    <div class="core-shoot-review-header core-product-row">
      <span></span>
      <span>Inventory</span>
      <span>7D Sales</span>
      <span>MTD vs LY</span>
      <span>Creative Attention</span>
      <span>This Week</span>
    </div>`;
}

// buildAttention (coreProducts.js) still includes a "+N Incoming" chip in
// the shared reason_chips list when On Order is large relative to
// velocity -- the Priority table keeps showing that chip as-is, but this
// row now has its own Inventory column, so on-order pressure surfaces
// there instead (as the quieter "High Incoming" label) rather than
// duplicating the number in both places.
function coreHasHighIncoming(p) {
  return (p.reason_chips || []).some((c) => / Incoming$/.test(c));
}

// "Never tested" / "31.9 wks cover" (buildAttention's own chip strings,
// written for the Priority table's running sentence) read as sentence
// fragments; title-cased into standalone chips they scan as labels instead
// -- e.g. "Never Tested", "31.9 Wks Cover". Numbers/symbols are untouched
// since \b\w only matches the first letter of each word.
function coreTitleCaseChip(text) {
  return text.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function coreInventoryCellHtml(p) {
  const highIncoming = coreHasHighIncoming(p);
  return `
    <div class="core-inv-row"><span class="core-inv-value">${p.soh != null ? p.soh : '—'}</span><span class="core-inv-label">SOH</span></div>
    <div class="core-inv-row"><span class="core-inv-value">${p.on_order != null ? p.on_order : '—'}</span><span class="core-inv-label">On Order</span></div>
    ${highIncoming ? '<span class="core-inv-flag">High Incoming</span>' : ''}`;
}

function coreAttentionChipsHtml(p) {
  const chips = (p.reason_chips || []).filter((c) => !/ Incoming$/.test(c));
  return chips.map((c) => `<span class="core-reason-chip">${escapeHtml(coreTitleCaseChip(c))}</span>`).join('');
}

function coreProblemProductRowHtml(p, selectedCodes) {
  const badge = p.flag === 'needs_attention' ? '🔴' : p.flag === 'opportunity' ? '🟠' : '';
  const isSelected = selectedCodes.has(p.product_code);
  const trend = coreProductTrendInfo(p);
  return `
    <div class="core-shoot-review-row core-product-row${isSelected ? ' core-row-selected' : ''}">
      <div class="core-shoot-review-col-product">${badge ? badge + ' ' : ''}<span class="core-shoot-review-name">${escapeHtml(p.product_name)}</span></div>
      <div class="core-shoot-review-col-inventory">${coreInventoryCellHtml(p)}</div>
      <div class="core-shoot-review-col-7d">${core7dCellHtml(trend)}</div>
      <div class="core-shoot-review-col-cadence">${coreCadenceBoxHtml(trend)}</div>
      <div class="core-shoot-review-col-reasons">${coreAttentionChipsHtml(p)}</div>
      <div class="core-shoot-review-col-action">${shootActionHtml(p.product_code, 'shootThisWeekForCore', selectedCodes)}</div>
    </div>`;
}

function toggleCoreShootCategory(cat) {
  if (state.coreShootExpandedCategories.has(cat)) state.coreShootExpandedCategories.delete(cat);
  else state.coreShootExpandedCategories.add(cat);
  renderCoreShootPlanning();
}

// How many of this week's already-selected Shoot Plan items belong to each
// Core category -- cross-referenced via product_code, since shoot_plan_items
// doesn't store category itself (a Shoot Plan entry from Upcoming Drops
// simply won't match any Core product_code here, which is correct).
function coreShootPlanCountsByCategory() {
  const productCodeToCategory = new Map(state.coreProducts.map((p) => [p.product_code, p.category]));
  const counts = new Map();
  for (const item of state.shootPlan) {
    const cat = productCodeToCategory.get(item.product_code);
    if (!cat) continue;
    counts.set(cat, (counts.get(cat) || 0) + 1);
  }
  return counts;
}

// Category-level "this month to date vs the same days last year" -- ported
// from demand-v2's own Sales Cadence view (its "LY MTD vs THIS MTD" box,
// plus a miniature trailing-3-months strip standing in for that page's
// full 12-month grid). Every figure (the MTD box and each month) is
// coloured by its own YoY change, matching how demand-v2 colours its
// monthly cells -- no deadzone, since a non-zero change is always shown.
function pctClass(pct) {
  if (pct == null || pct > 0) return 'up';
  if (pct < 0) return 'down';
  return 'flat';
}

function coreCategoryTrendInfo(categoryName) {
  const cadence = state.salesCadence;
  const row = cadence && cadence.categories
    ? cadence.categories.find((c) => c.category === (categoryName || '').toUpperCase())
    : null;
  if (!row) {
    return { hasData: false, title: 'No Sales Cadence data for this category' };
  }
  const title = `LY MTD: ${row.last_year_units} · This MTD: ${row.this_period_units}`;
  const pctLabel = row.pct_change == null ? 'New' : `${row.pct_change > 0 ? '+' : ''}${row.pct_change}%`;
  return {
    hasData: true,
    title,
    // The box's headline number is LAST year's MTD units (matching the "LY
    // MTD" header above it) with this year's % change below it (the "vs
    // This MTD" half of that header) -- deliberately NOT this year's MTD
    // units, which would just duplicate the current-month column right next
    // to it (both cover the exact same Aug 1 -> today window).
    boxValue: row.last_year_units,
    boxPctLabel: pctLabel,
    boxCls: pctClass(row.pct_change),
    last7dUnits: row.last_7d_units,
    last7dPctChange: row.last_7d_pct_change,
    months: (row.months || []).map((m) => ({
      label: m.label,
      value: m.units,
      cls: pctClass(m.pct_change),
      title: `${m.label}: ${m.units} unit${m.units === 1 ? '' : 's'}${m.pct_change != null ? ` (${m.pct_change > 0 ? '+' : ''}${m.pct_change}% vs last year)` : ' (new)'}`,
    })),
  };
}

function coreCadenceCellHtml(trend) {
  if (!trend.hasData) {
    return `<span class="core-cadence-empty" title="${escapeHtml(trend.title)}">—</span>`;
  }
  return `
    <div class="core-cadence-box core-trend-${trend.boxCls}" title="${escapeHtml(trend.title)}">
      <span class="core-cadence-box-value">${trend.boxValue}</span>
      <span class="core-cadence-box-pct">${trend.boxPctLabel}</span>
    </div>
    <div class="core-cadence-months">
      ${trend.months.map((m) => `
        <div class="core-cadence-month" title="${escapeHtml(m.title)}">
          <span class="core-cadence-month-value core-trend-${m.cls}">${m.value}</span>
          <span class="core-cadence-month-label">${escapeHtml(m.label)}</span>
        </div>`).join('')}
    </div>`;
}

// Same LY-MTD-vs-This-MTD/last-7D shape coreCategoryTrendInfo returns, read
// from a product's own p.cadence (coreProducts.js, keyed by product_code
// instead of category) -- lets core7dCellHtml/coreCadenceBoxHtml below run
// unmodified against either level. No .months here: the per-product row is
// a compact single line, not the category header's wider strip.
function coreProductTrendInfo(p) {
  const c = p.cadence;
  if (!c || !c.has_data) {
    return { hasData: false, title: 'No Sales Cadence data for this product' };
  }
  const title = `LY MTD: ${c.last_year_units} · This MTD: ${c.this_period_units}`;
  const pctLabel = c.pct_change == null ? 'New' : `${c.pct_change > 0 ? '+' : ''}${c.pct_change}%`;
  return {
    hasData: true,
    title,
    boxValue: c.last_year_units,
    boxPctLabel: pctLabel,
    boxCls: pctClass(c.pct_change),
    last7dUnits: c.last_7d_units,
    last7dPctChange: c.last_7d_pct_change,
  };
}

// Just the MTD box portion of coreCadenceCellHtml, with no months strip --
// a per-product row is one compact line, not the category header's wider
// glance area.
function coreCadenceBoxHtml(trend) {
  if (!trend.hasData) {
    return `<span class="core-cadence-empty" title="${escapeHtml(trend.title)}">—</span>`;
  }
  return `
    <div class="core-cadence-box core-trend-${trend.boxCls}" title="${escapeHtml(trend.title)}">
      <span class="core-cadence-box-value">${trend.boxValue}</span>
      <span class="core-cadence-box-pct">${trend.boxPctLabel}</span>
    </div>`;
}

// Click-and-drag horizontal scroll for the Sales Cadence months strip.
// Delegated once at the document level rather than wired per-element on
// every render -- Core's category list re-renders on every state change
// (a toggle, a shoot-plan edit, a full loadAll), and a listener attached
// per .core-cadence-months element on each render would leak a new
// mousemove/mouseup pair every time without ever being removed.
(function setupCadenceDragScroll() {
  let dragEl = null;
  let startX = 0;
  let startScrollLeft = 0;
  let dragged = false;

  document.addEventListener('mousedown', (e) => {
    const el = e.target.closest('.core-cadence-months');
    if (!el) return;
    dragEl = el;
    dragged = false;
    startX = e.pageX;
    startScrollLeft = el.scrollLeft;
    el.classList.add('dragging');
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragEl) return;
    const dx = e.pageX - startX;
    if (Math.abs(dx) > 4) dragged = true;
    dragEl.scrollLeft = startScrollLeft - dx;
  });

  document.addEventListener('mouseup', () => {
    if (!dragEl) return;
    dragEl.classList.remove('dragging');
    // A real drag (not just a click) shouldn't also toggle the category
    // row open/closed when the mouse happens to release back inside the
    // same <button> -- swallow exactly the next click there.
    if (dragged) dragEl.addEventListener('click', (e) => e.stopPropagation(), { once: true });
    dragEl = null;
  });
})();

// "How much have we actually sold lately" -- a plain rolling total (today
// and the 6 days before it), deliberately not coloured/compared like the
// cadence box/months above -- this column just answers "how much," not
// "how does that compare."
function core7dCellHtml(trend) {
  if (!trend.hasData || trend.last7dUnits == null) return '<span class="core-cadence-empty">—</span>';
  const pct = trend.last7dPctChange;
  const cls = pctClass(pct);
  const arrow = cls === 'up' ? '↑' : cls === 'down' ? '↓' : '→';
  const trendText = pct == null ? 'New' : `${arrow} ${Math.abs(pct)}% vs last week`;
  const title = pct == null
    ? 'No sales in the prior 7 days to compare against'
    : `This week: ${trend.last7dUnits} units, ${arrow} ${Math.abs(pct)}% vs the prior 7 days`;
  return `
    <div class="core-shoot-7d-cell">
      <div class="core-shoot-7d-row">
        <span class="core-shoot-7d-value">${trend.last7dUnits}</span>
        <span class="core-shoot-7d-label">units</span>
      </div>
      <span class="core-shoot-7d-trend core-trend-${cls}" title="${escapeHtml(title)}">${trendText}</span>
    </div>`;
}

function coreShootCategoryRowHtml(cat, selectedCodes) {
  const isOpen = state.coreShootExpandedCategories.has(cat.name);
  const trend = coreCategoryTrendInfo(cat.name);
  return `
    <div class="core-shoot-category-group">
      <button type="button" class="core-shoot-category-toggle ${isOpen ? 'open' : ''}" data-category="${escapeHtml(cat.name)}">
        <span class="accordion-arrow">&#9656;</span>
        <span class="core-shoot-category-namecol">
          <span class="core-shoot-category-name">${escapeHtml(cat.name)}</span>
          <span class="core-shoot-category-count">${cat.total} product${cat.total === 1 ? '' : 's'}</span>
        </span>
        <span class="core-shoot-stat-col">
          ${core7dCellHtml(trend)}
        </span>
        <span class="core-shoot-stat-col core-cadence-col">
          ${coreCadenceCellHtml(trend)}
        </span>
        <span class="core-shoot-stat-col">
          ${cat.needsAttention ? `<span class="core-shoot-stat">🔴 <span class="core-shoot-stat-count core-shoot-count-red">${cat.needsAttention}</span> needing attention</span>` : ''}
        </span>
        <span class="core-shoot-stat-col">
          ${cat.stale ? `<span class="core-shoot-stat">${cat.stale} stale/untested</span>` : ''}
        </span>
        <span class="core-shoot-stat-col">
          ${cat.selectedCount ? `<span class="core-shoot-stat core-shoot-stat-selected">✓ ${cat.selectedCount} selected this week</span>` : ''}
        </span>
      </button>
      ${isOpen ? `<div class="core-shoot-category-body">
        ${cat.problemProducts.length
          ? coreProblemProductsHeaderHtml() + cat.problemProducts.map((p) => coreProblemProductRowHtml(p, selectedCodes)).join('')
          : '<div class="attention-empty">No problem products in this category right now.</div>'}
      </div>` : ''}
    </div>`;
}

// Bottom-of-step count for the "X Core products selected · Continue to
// High Stocks →" footer -- same product_code cross-reference pattern
// coreShootPlanCountsByCategory() already uses, just totaled for the
// whole step instead of per-category.
function renderCoreStepFooter() {
  const coreCodes = new Set(state.coreProducts.map((p) => p.product_code));
  const count = state.shootPlan.filter((i) => coreCodes.has(i.product_code)).length;
  document.getElementById('core-step-footer-count').textContent = `${count} Core product${count === 1 ? '' : 's'} selected`;
}

function renderCoreShootPlanning() {
  const list = document.getElementById('core-shoot-planning-list');
  renderCoreStepFooter();
  if (!state.coreProducts.length) {
    list.innerHTML = '<div class="attention-empty">No Core products found yet.</div>';
    return;
  }

  const selectedCounts = coreShootPlanCountsByCategory();
  const selectedCodes = new Set(state.shootPlan.map((i) => i.product_code));
  const byCategory = new Map();
  for (const p of state.coreProducts) {
    if (!byCategory.has(p.category)) byCategory.set(p.category, []);
    byCategory.get(p.category).push(p);
  }

  const categories = [...byCategory.entries()].map(([name, products]) => ({
    name,
    total: products.length,
    needsAttention: products.filter((p) => p.flag === 'needs_attention').length,
    opportunity: products.filter((p) => p.flag === 'opportunity').length,
    stale: products.filter((p) => p.days_since_last_new_concept == null || p.days_since_last_new_concept > CORE_STALE_DAYS).length,
    selectedCount: selectedCounts.get(name) || 0,
    problemProducts: products.filter((p) => p.flag === 'needs_attention' || p.flag === 'opportunity'),
  }));

  // Rank by how much creative attention each category currently needs.
  categories.sort((a, b) => {
    if (b.needsAttention !== a.needsAttention) return b.needsAttention - a.needsAttention;
    if (b.opportunity !== a.opportunity) return b.opportunity - a.opportunity;
    if (b.stale !== a.stale) return b.stale - a.stale;
    return a.name.localeCompare(b.name);
  });

  list.innerHTML = categories.map((cat) => coreShootCategoryRowHtml(cat, selectedCodes)).join('');
  list.querySelectorAll('.core-shoot-category-toggle').forEach((btn) => {
    btn.addEventListener('click', () => toggleCoreShootCategory(btn.dataset.category));
  });
}

function toggleCoreAllProducts() {
  state.coreAllProductsOpen = !state.coreAllProductsOpen;
  document.getElementById('core-all-products-section').style.display = state.coreAllProductsOpen ? '' : 'none';
  document.getElementById('core-view-all-btn').classList.toggle('open', state.coreAllProductsOpen);
}

function renderCoreProducts() {
  renderCoreWeeklyCard();
  renderCoreShootPlanning();
  renderCoreViewToggle();
  document.getElementById('core-all-products-section').style.display = state.coreAllProductsOpen ? '' : 'none';
  document.getElementById('core-view-all-btn').classList.toggle('open', state.coreAllProductsOpen);

  const list = document.getElementById('core-products-list');
  if (!state.coreProducts.length) {
    list.innerHTML = '<div class="attention-empty">No Core products found yet.</div>';
    return;
  }

  list.innerHTML = state.coreView === 'category' ? renderCoreProductsByCategory() : renderCoreProductsPriority();
  wireCoreCategoryToggles(list);
}

// ── Planning: High Stocks ─────────────────────────────
// Platinum/Rocket-tier (per the "demand planning v2" cohort-based sales
// index), non-Core, over the SOH threshold with under 10% sell-through in
// the last 7 days -- a flat eligibility gate, not a ranked heuristic, so
// every matching colourway shows (no Top-5 cap), sorted SOH descending by
// the backend. One row per colourway (style_code), matching the reference
// report this was built from -- not rolled up by product family.
// Collapsed row = "should we look at this?" (fixed glance: Tier, SOH, 7D
// Sell-Through, Creative Status). Clicking the row (anywhere but the action
// button) expands a detail panel answering "why is it being recommended?"
// -- the button itself always means "we've decided to action it," so its
// click never toggles the row (event.stopPropagation()).
function toggleHighStockProduct(styleCode) {
  if (state.highStockExpandedProducts.has(styleCode)) state.highStockExpandedProducts.delete(styleCode);
  else state.highStockExpandedProducts.add(styleCode);
  renderHighStockProducts();
}

// Column header above the collapsed rows -- gives the SOH/7D Sell-Through/
// Last Creative/Tier figures context, same reasoning as Core's own row
// header. .high-stock-row overrides just the shared .core-shoot-review-row/
// -header grid template (see styles.css), same modifier-class pattern
// Core's .core-product-row already uses, so neither touches the other.
function highStockHeaderHtml() {
  return `
    <div class="core-shoot-review-header high-stock-row">
      <span></span>
      <span>SOH</span>
      <span>7D Sell-Through</span>
      <span>Last Creative</span>
      <span>Tier</span>
      <span>This Week</span>
    </div>`;
}

// Shared by the collapsed row and the expanded detail's Creative column so
// there's exactly one definition of "how stale is this colourway's live
// creative" -- 'Never' when nothing has ever gone live for it.
function highStockLastCreativeText(p) {
  return p.days_since_last_creative != null ? `${p.days_since_last_creative}d ago` : 'Never';
}

// One-line recommendation up top ("Stock problem"), a compact 3-column
// Inventory | Sales | Creative breakdown ("Sales problem" / "Creative gap"),
// then a single "Planned" line at the bottom if a concept is already in
// flight ("Shoot decision"). The per-asset "Existing creative" list used to
// sit above this and largely repeated the same information (the in-flight
// concept's name/status) -- collapsed into the one Planned line instead, so
// there's exactly one place answering "is something already planned?".
// Index Score / historical weekly avg / 30D weekly avg / detailed Sales
// Trend (and the raw recommendation_reasons the backend still returns)
// live in the collapsed "More data" <details> so they don't compete with
// the 3 primary metrics. Weeks Cover is deliberately never shown, per the brief.
function highStockDetailHtml(p, selectedCodes) {
  const reasons = (p.recommendation_reasons || []).join(' · ');
  const lastNewConceptText = p.days_since_last_new_concept != null ? `${p.days_since_last_new_concept}d ago` : 'Never';
  const trend = p.sales_trend || { display: '—', cls: 'core-trend-flat' };
  const assets = p.creative_assets || [];

  // Platinum is the top merchandising tier, so it reads as the higher-
  // urgency call; every other qualifying tier (Rocket, today) is still a
  // real recommendation, just not the loudest one.
  const priority = p.tier === 'platinum' ? 'High priority' : 'Priority';
  const creativePhrase = p.creative_status_label === 'Recent Creative' ? 'recent creative in place' : 'no recent creative';
  const recommendation = `${p.soh} units on hand, only ${p.sell_through_7d_pct}% 7D sell-through, with ${creativePhrase}.`;

  // "Planned" means a concept already exists and isn't live yet -- assets
  // arrive sorted newest-first, so the first non-live one is the current
  // plan for this colourway.
  const planned = assets.find((a) => a.status !== 'uploaded_live');
  const plannedClassification = planned && planned.concept_classification === 'tested_proven' ? 'Proven Winner' : 'New Concept';
  const isSelected = selectedCodes.has(p.product_code);

  return `
    <div class="high-stock-detail">
      <div class="high-stock-detail-recommendation"><span class="high-stock-detail-priority">${escapeHtml(priority)}:</span> ${escapeHtml(recommendation)}</div>
      <div class="high-stock-detail-grid">
        <div class="high-stock-detail-col">
          <div class="high-stock-detail-col-title">Inventory</div>
          <div class="high-stock-detail-metric"><span class="high-stock-detail-metric-label">SOH</span><span class="high-stock-detail-metric-value">${p.soh}</span></div>
          <div class="high-stock-detail-row"><span>On Order</span><span>${p.on_order != null ? p.on_order : '—'}</span></div>
          <div class="high-stock-detail-row"><span>Tier</span><span>${p.tier_emoji} ${escapeHtml(p.tier_label)}</span></div>
        </div>
        <div class="high-stock-detail-col">
          <div class="high-stock-detail-col-title">Sales</div>
          <div class="high-stock-detail-metric"><span class="high-stock-detail-metric-label">7D Sell-Through</span><span class="high-stock-detail-metric-value">${p.sell_through_7d_pct}%</span></div>
          <div class="high-stock-detail-row"><span>7D Units Sold</span><span>${p.vel7}</span></div>
          <div class="high-stock-detail-row"><span>30D Sell-Through</span><span>${p.units_sold_30d} units / ${p.sell_through_pct}%</span></div>
        </div>
        <div class="high-stock-detail-col">
          <div class="high-stock-detail-col-title">Creative</div>
          <div class="high-stock-detail-metric"><span class="high-stock-detail-metric-label">Last Creative</span><span class="high-stock-detail-metric-value">${highStockLastCreativeText(p)}</span></div>
          <div class="high-stock-detail-row"><span>Last New Concept</span><span>${lastNewConceptText}</span></div>
          <div class="high-stock-detail-row"><span>Creative Assets</span><span>${p.current_coverage}</span></div>
        </div>
      </div>

      <details class="high-stock-more-data">
        <summary>More data</summary>
        <div class="high-stock-detail-row"><span>Index Score</span><span>${p.index_score}</span></div>
        <div class="high-stock-detail-row"><span>Historical weekly avg</span><span>${p.vel365}/wk</span></div>
        <div class="high-stock-detail-row"><span>30D weekly avg</span><span>${p.vel30}/wk</span></div>
        <div class="high-stock-detail-row"><span>Sales Trend</span><span class="${trend.cls}">${escapeHtml(trend.display)}</span></div>
        ${reasons ? `<div class="high-stock-detail-row"><span>Why it's recommended</span><span>${escapeHtml(reasons)}</span></div>` : ''}
      </details>

      ${planned || isSelected ? `
      <div class="high-stock-detail-planned">
        <div class="high-stock-detail-col-title">Planned</div>
        <div class="high-stock-detail-planned-value">
          ${planned
            ? `<span class="high-stock-planned-name">${escapeHtml(plannedClassification)}</span><span class="high-stock-planned-status">${escapeHtml(planned.status_label)}</span>`
            : '<span class="high-stock-planned-name">Not yet planned</span>'}
          ${isSelected ? '<span class="high-stock-detail-planned-selected">&#10003; Shooting This Week</span>' : ''}
        </div>
      </div>` : ''}
    </div>`;
}

// Deliberately its own copy rather than the shared shootActionHtml() Core
// also uses -- High Stock's fuller "✓ Shooting This Week" wording makes it
// unambiguous this specific recommendation has already been actioned,
// without changing Core's own "✓ Shooting" badge.
function highStockActionHtml(p, selectedCodes) {
  if (selectedCodes.has(p.product_code)) return '<span class="core-shoot-selected-badge">✓ Shooting This Week</span>';
  return `<button type="button" class="btn btn-primary btn-sm" onclick="shootThisWeekForHighStock('${p.style_code}')">+ Shoot</button>`;
}

function highStockProductRowHtml(p, selectedCodes) {
  const thumb = p.image_url
    ? `<img class="high-stock-thumb" src="${p.image_url}" alt="">`
    : '<span class="high-stock-thumb high-stock-noimg">🖼</span>';
  const isOpen = state.highStockExpandedProducts.has(p.style_code);
  const displayName = `${p.product_name}${p.colour_label ? ` — ${p.colour_label}` : ''}`;
  return `
    <div class="high-stock-row-wrap${isOpen ? ' open' : ''}">
      <div class="core-shoot-review-row high-stock-row high-stock-clickable-row" onclick="toggleHighStockProduct('${p.style_code}')">
        <div class="core-shoot-review-col-product">
          <span class="accordion-arrow ${isOpen ? 'open' : ''}">&#9656;</span>
          ${thumb}
          <span class="core-shoot-review-name">${escapeHtml(displayName)}</span>
        </div>
        <div class="high-stock-row-value">${p.soh}</div>
        <div class="high-stock-row-value">${p.sell_through_7d_pct}%</div>
        <div class="high-stock-row-value">${escapeHtml(highStockLastCreativeText(p))}</div>
        <div class="high-stock-row-col-tier"><span class="high-stock-tier-badge">${p.tier_emoji} ${escapeHtml(p.tier_label)}</span></div>
        <div class="core-shoot-review-col-action" onclick="event.stopPropagation()">${highStockActionHtml(p, selectedCodes)}</div>
      </div>
      ${isOpen ? highStockDetailHtml(p, selectedCodes) : ''}
    </div>`;
}

// Bottom-of-step count for "X High Stock products selected · Continue to
// Upcoming Drops →", same cross-reference pattern as the Core step footer.
function renderHighStockStepFooter() {
  const hsCodes = new Set(state.highStockProducts.map((p) => p.product_code));
  const count = state.shootPlan.filter((i) => hsCodes.has(i.product_code)).length;
  document.getElementById('high-stock-step-footer-count').textContent = `${count} High Stock product${count === 1 ? '' : 's'} selected`;
}

function renderHighStockProducts() {
  const selectedCodes = new Set(state.shootPlan.map((i) => i.product_code));

  const list = document.getElementById('high-stock-list');
  list.innerHTML = state.highStockProducts.length
    ? highStockHeaderHtml() + state.highStockProducts.map((p) => highStockProductRowHtml(p, selectedCodes)).join('')
    : '<div class="attention-empty">No Platinum/Rocket products currently meet the High Stock threshold.</div>';

  renderHighStockStepFooter();
}

function shootThisWeekForHighStock(styleCode) {
  const product = state.highStockProducts.find((p) => p.style_code === styleCode);
  if (!product) return;
  openShootPlanModal({
    productCode: product.product_code,
    productName: product.product_name,
    category: product.category,
    // High Stock's shoot modal scopes to just this one colourway -- no
    // sibling-colourway picker, unlike Core's whole-family modal.
    colours: [{
      style_id: product.style_id,
      style_code: product.style_code,
      colour_label: product.colour_label,
      image_url: product.image_url,
      soh: product.soh,
      on_order: product.on_order,
      sizes: product.sizes,
      sizing_system: product.sizing_system,
    }],
    source: 'high_stock',
  });
}

function planNewConceptForCore(productCode) {
  const product = state.coreProducts.find((p) => p.product_code === productCode);
  if (!product) return;
  openAssetModal(null, {
    presetStyleIds: product.colours.map((c) => c.style_id),
    presetConceptName: `New Concept — ${product.product_name}`,
    defaultClassification: 'new_experimental',
  });
}

// ── Monday Planning: This Week's Shoot Plan ──────────
// Fast path for deciding WHAT gets shot this week -- no talent/location/
// props/scripts here, that's the existing Creative Job flow, for later
// once the content creator has developed a concept.
let shootPlanModalContext = null;

// Fallback only -- the actual default creator is Settings-managed
// (state.contentCreators' is_default row, populated into the dropdown by
// populateShootPlanCreatorSelect below). This constant is just what a
// brand-new install with no content_creators rows falls back to.
const DEFAULT_CREATOR = 'Mark';

// Simple keyword heuristic -- unrecognised categories get no default applied
// rather than guessing wrong.
function classifyGarmentType(category) {
  const c = (category || '').toUpperCase();
  if (/JEAN|PANT|SHORT|TROUSER|SKIRT/.test(c)) return 'bottom';
  if (/TEE|SHIRT|HOODIE|JUMPER|JACKET|SWEAT|OUTERWEAR/.test(c)) return 'top';
  return null;
}

// One shared default per garment shape (Settings -> Default Shoot Sizes),
// not per Content Creator -- returns '' only when this colourway has no
// resolved size list at all or its category doesn't classify as a garment
// shape. When Settings' configured label isn't literally one of this
// colourway's own size options, falls back to the first size rather than
// leaving the field blank -- still a genuine default, just not an exact
// label match (e.g. Settings says "S" but this range only offers "Small").
function defaultSizeForColourway(garmentType, sizingSystem, sizes) {
  if (!sizes || !sizes.length || !garmentType) return '';
  const settings = state.planningSettings;
  if (!settings) return '';
  const label = garmentType === 'top'
    ? settings.default_shoot_top_size
    : (sizingSystem === 'waist' ? settings.default_shoot_bottom_waist_size : settings.default_shoot_bottom_alpha_size);
  if (!label) return '';
  const match = sizes.find((s) => s.toLowerCase() === String(label).toLowerCase());
  return match || sizes[0];
}

function shootThisWeekForCore(productCode) {
  const product = state.coreProducts.find((p) => p.product_code === productCode);
  if (!product) return;
  openShootPlanModal({
    productCode: product.product_code,
    productName: product.product_name,
    category: product.category,
    colours: product.colours,
    source: 'core',
  });
}

function shootThisWeekForCoverage(productCode) {
  const c = (state.currentDrop && state.currentDrop.coverage || []).find((x) => x.product_code === productCode);
  if (!c) return;
  openShootPlanModal({
    productCode: c.product_code,
    productName: c.product_name,
    category: c.category,
    colours: c.styles,
    source: 'drop',
  });
}

function openShootPlanModal(preset) {
  shootPlanModalContext = preset;
  document.getElementById('shoot-plan-product-name').textContent = preset.productName;
  document.getElementById('shoot-plan-product-code').textContent = preset.productCode;
  const categoryEl = document.getElementById('shoot-plan-product-category');
  categoryEl.textContent = preset.category || '';
  categoryEl.style.display = preset.category ? '' : 'none';

  const headerImage = preset.colours.find((c) => c.image_url);
  document.getElementById('shoot-plan-product-image').innerHTML = headerImage
    ? `<img src="${headerImage.image_url}" alt="">`
    : '<span class="shoot-plan-noimg">🖼</span>';

  document.getElementById('shoot-plan-colours').innerHTML = preset.colours.map((c) => {
    const sizeControl = c.sizes && c.sizes.length
      ? `<select class="shoot-plan-colour-size" data-style-id="${c.style_id}">${c.sizes.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}</select>`
      : `<input type="text" class="shoot-plan-colour-size" data-style-id="${c.style_id}" placeholder="Size">`;
    return `
    <div class="shoot-plan-colour-row">
      ${c.image_url ? `<img class="shoot-plan-colour-thumb" src="${c.image_url}" alt="">` : '<span class="shoot-plan-colour-thumb shoot-plan-noimg">🖼</span>'}
      <label class="checkbox-label shoot-plan-colour-check">
        <input type="checkbox" class="shoot-plan-colour-required" value="${c.style_id}" checked>
        <span class="shoot-plan-colour-names">
          <span class="shoot-plan-colour-name">${escapeHtml(c.colour_label || c.style_code)}</span>
          ${c.colour_label ? `<span class="shoot-plan-colour-code">${escapeHtml(c.style_code)}</span>` : ''}
        </span>
      </label>
      ${sizeControl}
    </div>`;
  }).join('');

  // Bring from Warehouse is the default -- most shoots need something
  // pulled, and defaulting here means the size fields the warehouse pull
  // list depends on are visible unless someone actively says otherwise.
  document.getElementById('shoot-plan-stock-status').value = 'needs_to_be_brought_in';
  populateShootPlanCreatorSelect();
  document.getElementById('shoot-plan-initial-idea').value = '';
  applyShootPlanSizeDefaults();
  updateShootPlanSampleStatusVisibility();
  openModal('shoot-plan-modal');
}

// Populates the Content Creator dropdown from the Settings-managed list
// (state.contentCreators) and selects whichever is flagged is_default --
// falling back to DEFAULT_CREATOR, then the first creator, if the list is
// missing a default for some reason (e.g. a brand-new install before the
// seed row lands).
function populateShootPlanCreatorSelect() {
  const sel = document.getElementById('shoot-plan-creator');
  sel.innerHTML = state.contentCreators.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
  const defaultEntry = state.contentCreators.find((c) => c.is_default) || state.contentCreators[0];
  sel.value = defaultEntry ? defaultEntry.name : DEFAULT_CREATOR;
}

// Sizes only matter when something has to be picked and brought in -- if
// it's already in the office, hide the size controls entirely (colourway
// checkboxes stay, since which colours are being shot is still recorded).
function updateShootPlanSampleStatusVisibility() {
  const bringingFromWarehouse = document.getElementById('shoot-plan-stock-status').value === 'needs_to_be_brought_in';
  document.getElementById('shoot-plan-colours').classList.toggle('hide-sizes', !bringingFromWarehouse);
}

// Select All / Clear All -- a many-colourway product otherwise means
// clicking every single checkbox just to shoot the whole family.
function selectAllShootPlanColours(checked) {
  document.querySelectorAll('#shoot-plan-colours .shoot-plan-colour-required').forEach((el) => { el.checked = checked; });
}

// Pre-fills every still-required colourway's size from Settings -> Default
// Shoot Sizes -- called once when the modal opens. Purely a starting point:
// each <select> stays a normal control the user can change by hand, and
// nothing re-runs this afterward (Select All/Clear All only toggle which
// colourways are required, they never touch an already-set size).
function applyShootPlanSizeDefaults() {
  if (!shootPlanModalContext) return;
  const garmentType = classifyGarmentType(shootPlanModalContext.category);
  document.querySelectorAll('#shoot-plan-colours .shoot-plan-colour-size').forEach((el) => {
    const styleId = Number(el.dataset.styleId);
    const checkbox = document.querySelector(`#shoot-plan-colours .shoot-plan-colour-required[value="${styleId}"]`);
    if (!checkbox || !checkbox.checked) return;
    const colour = shootPlanModalContext.colours.find((c) => c.style_id === styleId);
    if (!colour) return;
    el.value = defaultSizeForColourway(garmentType, colour.sizing_system, colour.sizes);
  });
}

async function saveShootPlanItem() {
  // Size is only meaningful when something needs to be picked and brought
  // in -- if it's already in the office, nobody needs a size on a pull
  // list that doesn't exist for this shoot.
  const bringingFromWarehouse = document.getElementById('shoot-plan-stock-status').value === 'needs_to_be_brought_in';
  const colourways = [];
  for (const row of document.querySelectorAll('#shoot-plan-colours .shoot-plan-colour-row')) {
    const checkbox = row.querySelector('.shoot-plan-colour-required');
    if (!checkbox.checked) continue;
    const size = row.querySelector('.shoot-plan-colour-size').value.trim();
    if (bringingFromWarehouse && !size) return toast('Select a size for every required colourway', true);
    const styleId = Number(checkbox.value);
    const colour = shootPlanModalContext.colours.find((c) => c.style_id === styleId);
    colourways.push({ style_id: styleId, size: bringingFromWarehouse ? size : null, colour_label: colour?.colour_label || null });
  }
  const creator = document.getElementById('shoot-plan-creator').value.trim();
  if (!colourways.length) return toast('Select at least one colourway', true);
  if (!creator) return toast('Content creator is required', true);

  // Same find-first-truthy pattern the modal's own header image uses
  // (colours[0] isn't guaranteed to have an image) -- snapshotted here so
  // the Shoot Plan step can show a product thumbnail without re-resolving
  // it from whichever source list happens to still be loaded.
  const headerImage = shootPlanModalContext.colours.find((c) => c.image_url);

  const payload = {
    product_code: shootPlanModalContext.productCode,
    product_name: shootPlanModalContext.productName,
    colourways,
    stock_status: document.getElementById('shoot-plan-stock-status').value,
    creator,
    quick_note: document.getElementById('shoot-plan-initial-idea').value.trim() || null,
    source: shootPlanModalContext.source || null,
    image_url: headerImage?.image_url || null,
    week_start: planningWeekStart(),
  };
  try {
    await api('/shoot-plan', { method: 'POST', body: JSON.stringify(payload) });
    closeModal('shoot-plan-modal');
    toast('Added to Shoot Plan');
    loadAll();
  } catch (e) {
    toast(e.message, true);
  }
}

async function removeShootPlanItem(id) {
  if (state.planningWeekOffset < 0) return; // past weeks are read-only
  if (!(await confirmDialog("Remove this product from this week's shoot plan? The creator's in-progress concept work is not affected."))) return;
  try {
    await api(`/shoot-plan/${id}`, { method: 'DELETE' });
    toast('Removed from shoot plan');
    loadAll();
  } catch (e) {
    toast(e.message, true);
  }
}

// ── Planning: Step 4 -- Promotions ────────────────────
// "Are upcoming promotions creatively covered, and what is still missing?"
// -- deliberately built to feel like Upcoming Drops rather than a separate
// UI: same card grid/status pill on the landing list, same coverage-card/
// progress-bar treatment for the detail page's requirements, same
// exception-based "On Track needs nothing, Needs Attention names the gap"
// philosophy. The one structural difference is what stands in for a Drop's
// Products: a Promotion isn't one product (it may cover several, a bundle,
// a GWP, or nothing SKU-specific at all -- see promotion_stages in
// schema.sql), so its requirement unit is a fully custom-per-promotion
// Campaign Stage instead.
// Ready/Planned/Missing urgency -> the same green/amber/red tokens used
// everywhere else in this app (coverage-progress-fill, coverage-card-gap,
// drop-card-status), so Promotions reads as the same visual language as
// Drops/Core/High Stock rather than inventing its own palette.
function promotionUrgencyColor(u) { return u === 'at_risk' ? 'red' : u === 'needs_attention' ? 'amber' : 'green'; }
function promotionUrgencyLabel(u) { return u === 'at_risk' ? 'At Risk' : u === 'needs_attention' ? 'Needs Attention' : 'On Track'; }

function promotionCardHtml(p) {
  const color = promotionUrgencyColor(p.status);
  const dateRange = p.end_date ? `${formatDate(p.start_date)} – ${formatDate(p.end_date)}` : formatDate(p.start_date);
  const pct = p.summary.overall_pct;
  return `
    <div class="drop-card" data-promotion-id="${p.id}">
      <div class="drop-card-header">
        <div class="drop-card-name">${escapeHtml(p.name)}</div>
        <div class="drop-card-status ${color === 'green' ? 'on-track' : color === 'amber' ? 'needs-attention' : 'at-risk'}">${promotionUrgencyLabel(p.status)}</div>
      </div>
      <div class="drop-card-date">${dateRange} · ${p.days_until_launch >= 0 ? p.days_until_launch + ' days to launch' : 'Launched'}</div>
      <div class="drop-card-pct">${p.summary.total_ready} / ${p.summary.total_required} Ready${pct !== null ? ' — ' + pct + '%' : ''}</div>
      ${pct !== null ? `<div class="coverage-progress-track"><div class="coverage-progress-fill ${color}" style="width:${Math.min(100, pct)}%;"></div></div>` : ''}
      ${p.most_urgent_stage ? `<div class="drop-card-urgent">Next priority: ${escapeHtml(p.most_urgent_stage.name)} — ${p.most_urgent_stage.still_required} missing</div>` : ''}
    </div>`;
}

function wirePromotionCardRow(row) {
  row.querySelectorAll('.drop-card').forEach((card) => {
    card.addEventListener('click', () => { window.location.hash = `#planning/promotion/${card.dataset.promotionId}`; });
  });
}

function renderPromotionsRow() {
  const list = document.getElementById('promotions-list');
  if (!list) return; // guards a load race before index.html's panel exists
  const upcoming = state.promotions.filter((p) => p.days_until_launch >= 0);
  list.innerHTML = upcoming.length
    ? upcoming.map(promotionCardHtml).join('')
    : '<div class="attention-empty">No upcoming promotions yet — add one to start planning creative coverage.</div>';
  wirePromotionCardRow(list);

  document.getElementById('promotions-step-footer-count').textContent = `${upcoming.length} upcoming promotion${upcoming.length === 1 ? '' : 's'}`;
}

document.getElementById('new-promotion-btn').addEventListener('click', () => openPromotionModal(null));

function openPromotionModal(promotion) {
  document.getElementById('promotion-modal-title').textContent = promotion ? 'Edit Promotion' : 'New Promotion';
  document.getElementById('promotion-id').value = promotion ? promotion.id : '';
  document.getElementById('promotion-name').value = (promotion && promotion.name) || '';
  document.getElementById('promotion-start-date').value = promotion ? promotion.start_date.slice(0, 10) : '';
  document.getElementById('promotion-end-date').value = promotion && promotion.end_date ? promotion.end_date.slice(0, 10) : '';
  document.getElementById('promotion-notes').value = (promotion && promotion.notes) || '';
  document.getElementById('promotion-save-btn').textContent = promotion ? 'Save' : 'Add';
  document.getElementById('promotion-delete-btn').style.display = promotion ? 'inline-block' : 'none';
  openModal('promotion-modal');
}

async function savePromotion() {
  const id = document.getElementById('promotion-id').value;
  const name = document.getElementById('promotion-name').value;
  const start_date = document.getElementById('promotion-start-date').value;
  const end_date = document.getElementById('promotion-end-date').value || null;
  const notes = document.getElementById('promotion-notes').value || null;
  if (!name.trim()) return toast('Promotion name is required', true);
  if (!start_date) return toast('Start date is required', true);

  try {
    if (id) {
      await api(`/promotions/${id}`, { method: 'PUT', body: JSON.stringify({ name, start_date, end_date, notes }) });
      closeModal('promotion-modal');
      toast('Promotion saved');
      loadAll();
    } else {
      const created = await api('/promotions', { method: 'POST', body: JSON.stringify({ name, start_date, end_date, notes }) });
      closeModal('promotion-modal');
      toast('Promotion added');
      await loadAll();
      // Straight into the new promotion's detail page -- that's where
      // Campaign Stages get added, and there's nothing else to do on the
      // landing card yet.
      window.location.hash = `#planning/promotion/${created.id}`;
    }
  } catch (e) {
    toast(e.message, true);
  }
}

async function deletePromotion() {
  const id = document.getElementById('promotion-id').value;
  if (!id) return;
  if (!(await confirmDialog('Delete this promotion? Its Campaign Stages go with it -- any Shoot Plan items already linked to them stay in the Shoot Plan, just unlinked.'))) return;
  try {
    await api(`/promotions/${id}`, { method: 'DELETE' });
    closeModal('promotion-modal');
    toast('Promotion deleted');
    goToPlanningList();
    loadAll();
  } catch (e) {
    toast(e.message, true);
  }
}

// ── Promotion detail page: Campaign Stages ───────────
async function loadPromotionView(id) {
  state.currentPromotionId = id;
  try {
    state.currentPromotion = await api(`/promotions/${id}`);
    renderPromotionView();
  } catch (e) {
    toast(e.message, true);
  }
}

// The prominent progress card at the top of a promotion's detail page --
// same visual language as the Core weekly card (big %, thick progress bar,
// pill breakdown) so Promotions reads as one of "the other WNDRR internal
// dashboards" rather than a bespoke layout. Ready/Planned/Missing pills sum
// to Total Required by construction (see summarizePromotion's total_planned
// comment in promotions.js).
function promotionOverviewHtml(p) {
  const color = promotionUrgencyColor(p.status);
  const dateRange = p.end_date ? `${formatDate(p.start_date)} – ${formatDate(p.end_date)}` : formatDate(p.start_date);
  const s = p.summary;
  const pct = s.overall_pct;
  return `
    <div class="promo-overview-card">
      <div class="promo-overview-top">
        <div>
          <div class="promo-overview-label">PROMOTION OVERVIEW</div>
          <div class="promo-overview-dates">${dateRange}</div>
        </div>
        <div class="drop-card-status ${color === 'green' ? 'on-track' : color === 'amber' ? 'needs-attention' : 'at-risk'}">${promotionUrgencyLabel(p.status)}</div>
      </div>
      <div class="promo-overview-pct-row">
        <div class="promo-overview-pct">${pct !== null ? pct + '%' : '—'}</div>
        <div class="promo-overview-pct-sub">${s.total_ready} / ${s.total_required} Ready · ${p.days_until_launch >= 0 ? p.days_until_launch + ' days to launch' : 'Launched'}</div>
      </div>
      <div class="promo-overview-progress-track"><div class="promo-overview-progress-fill ${color}" style="width:${pct !== null ? Math.min(100, pct) : 0}%;"></div></div>
      <div class="promo-overview-pills">
        <span class="promo-pill promo-pill-ready">${s.total_ready} Ready</span>
        <span class="promo-pill promo-pill-planned">${s.total_planned} Planned</span>
        <span class="promo-pill promo-pill-missing">${s.total_missing} Missing</span>
      </div>
    </div>`;
}

function renderPromotionView() {
  const p = state.currentPromotion;
  if (!p) return;
  document.getElementById('promotion-view-title').textContent = p.name;
  document.getElementById('promotion-view-edit-btn').onclick = () => openPromotionModal(p);
  document.getElementById('promotion-view-summary').innerHTML = promotionOverviewHtml(p);
  renderPromotionStageGrid();
}

// Re-fetches just this promotion (not a full loadAll()) so stage add/
// rename/reorder/delete feel immediate -- the landing card grid (which
// does need refreshing, since its own coverage summary just changed too)
// is patched separately by whichever caller needs it.
async function refreshCurrentPromotion() {
  if (!state.currentPromotionId) return;
  try {
    const promotion = await api(`/promotions/${state.currentPromotionId}`);
    state.currentPromotion = promotion;
    const idx = state.promotions.findIndex((p) => p.id === promotion.id);
    if (idx !== -1) state.promotions[idx] = promotion;
    renderPromotionView();
  } catch (e) {
    toast(e.message, true);
  }
}

function promotionStageGapLabel(s) {
  if (s.still_required <= 0) return '🟢 COVERAGE COMPLETE';
  const icon = s.urgency === 'at_risk' ? '🔴' : s.urgency === 'needs_attention' ? '🟠' : '🟢';
  return `${icon} ${s.still_required} still required`;
}

function promotionStageItemRowHtml(item) {
  return `
    <div class="promotion-stage-item-row">
      <span class="promotion-stage-item-name">${escapeHtml(item.product_name)}</span>
      <span class="admin-note">${escapeHtml(item.creator)} · ${escapeHtml(item.asset_status_label || '—')}</span>
      <button type="button" class="btn btn-ghost btn-sm" onclick="removeShootPlanItem(${item.id})">Remove</button>
    </div>`;
}

// Each stage card doubles as both the coverage display (target/planned/
// ready/still-required/urgency, same visual language as a Drop product's
// coverage card) and its own editor (rename/reorder/delete/required-count/
// due-date) -- no separate edit mode, so customising a promotion's
// structure never needs more than one click.
function promotionStageCardHtml(stage, index, total) {
  const color = promotionUrgencyColor(stage.urgency);
  const items = stage.items || [];
  const dueLabel = stage.due_date ? `Due ${formatDate(stage.due_date)}` : 'No due date set';
  return `
    <div class="coverage-card promotion-stage-card" data-stage-id="${stage.id}" draggable="true">
      <div class="coverage-card-body">
        <div class="promotion-stage-head">
          <span class="pw-drag-handle" title="Drag to reorder">⠿</span>
          <input type="text" class="promotion-stage-name-input" value="${escapeHtml(stage.name)}" onchange="renamePromotionStage(${stage.id}, this.value)">
          <button type="button" class="btn btn-ghost btn-sm" ${index === 0 ? 'disabled' : ''} onclick="movePromotionStage(${stage.id}, -1)" title="Move up">&uarr;</button>
          <button type="button" class="btn btn-ghost btn-sm" ${index === total - 1 ? 'disabled' : ''} onclick="movePromotionStage(${stage.id}, 1)" title="Move down">&darr;</button>
          <button type="button" class="btn btn-ghost btn-sm" onclick="deletePromotionStage(${stage.id})" title="Delete stage">&times;</button>
        </div>
        <div class="promotion-stage-urgency-badge ${color}">${promotionUrgencyLabel(stage.urgency)}</div>
        <div class="promotion-stage-due-row">
          <span>${dueLabel}</span>
          <input type="date" class="promotion-stage-due-input" value="${stage.due_date ? stage.due_date.slice(0, 10) : ''}" onchange="savePromotionStageDueDate(${stage.id}, this.value)">
        </div>
        <div class="coverage-card-ratio">${stage.ready} / ${stage.target} Ready</div>
        <div class="coverage-progress-track"><div class="coverage-progress-fill ${color}" style="width:${stage.coverage_pct}%;"></div></div>
        <div class="promotion-stage-stats-row">
          <span>Planned: ${stage.planned}</span>
          <span>Ready: ${stage.ready}</span>
        </div>
        <div class="coverage-card-gap ${color}">${promotionStageGapLabel(stage)}</div>
        <label class="promotion-stage-required-row">Target
          <input type="number" min="0" class="promotion-stage-count-input" value="${stage.target}" onchange="savePromotionStageCount(${stage.id}, this.value)">
        </label>
        ${items.length ? `<div class="promotion-stage-item-list">${items.map(promotionStageItemRowHtml).join('')}</div>` : ''}
        <button type="button" class="btn btn-primary btn-sm coverage-card-shoot-btn" onclick="shootThisWeekForPromotionStage(${stage.id})">+ Shoot This Week</button>
      </div>
    </div>`;
}

function renderPromotionStageGrid() {
  const grid = document.getElementById('promotion-stage-grid');
  const stages = (state.currentPromotion && state.currentPromotion.stages) || [];
  grid.innerHTML = stages.length
    ? stages.map((s, i) => promotionStageCardHtml(s, i, stages.length)).join('')
    : '<div class="attention-empty">No Campaign Stages yet — click "+ Add Stage" above (e.g. Hype / Tease, Launch Ads, Mid-Sale / Offer, Last Chance). Different promotions can use completely different stages.</div>';
  wirePromotionStageDragEvents();
}

let promotionStageDragId = null;

function wirePromotionStageDragEvents() {
  document.querySelectorAll('#promotion-stage-grid .promotion-stage-card').forEach((card) => {
    // The card is its own inline editor (rename/reorder/delete/required-
    // count/due-date all live directly on it), so a click only navigates
    // to the stage's own planning page when it didn't land on one of those
    // controls -- every one of them is an <input> or <button>.
    card.addEventListener('click', (e) => {
      if (e.target.closest('input, button')) return;
      window.location.hash = `#planning/promotion/${state.currentPromotionId}/stage/${card.dataset.stageId}`;
    });
    card.addEventListener('dragstart', () => {
      promotionStageDragId = Number(card.dataset.stageId);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      document.querySelectorAll('#promotion-stage-grid .promotion-stage-card').forEach((c) => c.classList.remove('drag-over'));
    });
    card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drag-over'); });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const targetId = Number(card.dataset.stageId);
      if (promotionStageDragId == null || promotionStageDragId === targetId) return;
      const ids = state.currentPromotion.stages.map((s) => s.id);
      const fromIdx = ids.indexOf(promotionStageDragId);
      const toIdx = ids.indexOf(targetId);
      if (fromIdx === -1 || toIdx === -1) return;
      ids.splice(fromIdx, 1);
      ids.splice(toIdx, 0, promotionStageDragId);
      submitPromotionStageReorder(ids);
    });
  });
}

function movePromotionStage(id, delta) {
  const ids = state.currentPromotion.stages.map((s) => s.id);
  const idx = ids.indexOf(id);
  const swapWith = idx + delta;
  if (idx === -1 || swapWith < 0 || swapWith >= ids.length) return;
  [ids[idx], ids[swapWith]] = [ids[swapWith], ids[idx]];
  submitPromotionStageReorder(ids);
}

async function submitPromotionStageReorder(orderedIds) {
  try {
    await api('/promotions/stages/reorder', { method: 'PUT', body: JSON.stringify({ ordered_ids: orderedIds }) });
    await refreshCurrentPromotion();
  } catch (e) {
    toast(e.message, true);
  }
}

function openNewStageModal() {
  document.getElementById('new-stage-name').value = '';
  document.getElementById('new-stage-count').value = '1';
  document.getElementById('new-stage-due-date').value = '';
  openModal('promotion-stage-modal');
}
document.getElementById('new-stage-btn').addEventListener('click', openNewStageModal);

async function addPromotionStage() {
  const nameEl = document.getElementById('new-stage-name');
  const countEl = document.getElementById('new-stage-count');
  const dueEl = document.getElementById('new-stage-due-date');
  const name = nameEl.value.trim();
  if (!name) return toast('Stage name is required', true);
  try {
    await api(`/promotions/${state.currentPromotionId}/stages`, {
      method: 'POST',
      body: JSON.stringify({ name, required_count: Number(countEl.value) || 0, due_date: dueEl.value || null }),
    });
    closeModal('promotion-stage-modal');
    toast('Stage added');
    await refreshCurrentPromotion();
    renderPromotionsRow();
  } catch (e) {
    toast(e.message, true);
  }
}

async function renamePromotionStage(id, name) {
  if (!name || !name.trim()) return toast('Stage name is required', true);
  try {
    await api(`/promotions/stages/${id}`, { method: 'PUT', body: JSON.stringify({ name: name.trim() }) });
    await refreshCurrentPromotion();
  } catch (e) {
    toast(e.message, true);
  }
}

async function savePromotionStageCount(id, value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) return toast('Required count must be 0 or more', true);
  try {
    await api(`/promotions/stages/${id}`, { method: 'PUT', body: JSON.stringify({ required_count: count }) });
    await refreshCurrentPromotion();
    renderPromotionsRow();
  } catch (e) {
    toast(e.message, true);
  }
}

async function savePromotionStageDueDate(id, value) {
  try {
    await api(`/promotions/stages/${id}`, { method: 'PUT', body: JSON.stringify({ due_date: value || null }) });
    await refreshCurrentPromotion();
    renderPromotionsRow();
  } catch (e) {
    toast(e.message, true);
  }
}

async function deletePromotionStage(id) {
  if (!(await confirmDialog('Delete this Campaign Stage? Any Shoot Plan items already linked to it stay in the Shoot Plan, just unlinked.'))) return;
  try {
    await api(`/promotions/stages/${id}`, { method: 'DELETE' });
    toast('Stage deleted');
    await refreshCurrentPromotion();
    renderPromotionsRow();
  } catch (e) {
    toast(e.message, true);
  }
}

// ── Campaign Stage detail page ("what we have") ──────────────────────
// The card on the promotion page is its own compact editor; this is the
// planning page you land on by clicking it -- same Target/Ready/Planned/
// Still-Required numbers at a glance, plus every creative shot against
// this stage rendered as the same clickable job-card the Product Detail
// page uses, so a click opens the exact same asset editor already used
// everywhere else (no separate stage-scoped editing UI).
async function loadPromotionStageView(promotionId, stageId) {
  state.currentPromotionId = promotionId;
  state.currentPromotionStageId = stageId;
  try {
    const promotion = await api(`/promotions/${promotionId}`);
    state.currentPromotion = promotion;
    const idx = state.promotions.findIndex((p) => p.id === promotion.id);
    if (idx !== -1) state.promotions[idx] = promotion;
    await renderPromotionStageDetailView();
  } catch (e) {
    toast(e.message, true);
  }
}

async function renderPromotionStageDetailView() {
  const promotion = state.currentPromotion;
  const stage = promotion && promotion.stages.find((s) => s.id === state.currentPromotionStageId);
  if (!stage) return;

  document.getElementById('promotion-stage-view-title').textContent = stage.name;
  const color = promotionUrgencyColor(stage.urgency);
  const urgencyEl = document.getElementById('promotion-stage-view-urgency');
  urgencyEl.textContent = promotionUrgencyLabel(stage.urgency);
  urgencyEl.className = `drop-card-status ${color === 'green' ? 'on-track' : color === 'amber' ? 'needs-attention' : 'at-risk'}`;

  const dueLabel = stage.due_date ? formatDate(stage.due_date) : 'Not set';
  document.getElementById('promotion-stage-view-summary').innerHTML = `
    <div><strong>${stage.target}</strong><br>Target</div>
    <div><strong>${stage.ready}</strong><br>Ready</div>
    <div><strong>${stage.planned}</strong><br>Planned</div>
    <div><strong>${stage.still_required}</strong><br>Still Required</div>
    <div><strong>${dueLabel}</strong><br>Due date</div>
  `;
  document.getElementById('promotion-stage-view-shoot-btn').onclick = () => shootThisWeekForPromotionStage(stage.id);

  const items = stage.items || [];
  const grid = document.getElementById('promotion-stage-view-items');
  if (!items.length) {
    grid.innerHTML = '<div class="attention-empty">Nothing shot for this stage yet — click "+ Shoot This Week" to send the first requirement into Concept Development.</div>';
    return;
  }

  try {
    const assetIds = items.map((i) => i.asset_id).filter(Boolean);
    const assets = assetIds.length ? await api(`/creative-assets?ids=${assetIds.join(',')}`) : [];
    const assetsById = new Map(assets.map((a) => [a.id, a]));
    grid.innerHTML = items.map((item) => {
      const asset = assetsById.get(item.asset_id);
      if (!asset) return '';
      const [bg, fg] = ASSET_STATUS_COLORS[asset.status] || ASSET_STATUS_COLORS.not_started;
      return `
      <div class="job-card" data-asset-id="${asset.id}">
        <div class="job-card-concept">${escapeHtml(asset.concept_name)}</div>
        <div class="job-card-products">${escapeHtml(asset.style_code)} · ${asset.format}</div>
        <div class="job-status-row">
          <span class="job-status-pill" style="background:${bg};color:${fg};">${STATUS_LABELS[asset.status]}</span>
          <span class="badge badge-${asset.concept_classification}">${CLASSIFICATION_LABELS[asset.concept_classification]}</span>
        </div>
      </div>`;
    }).join('');
    grid.querySelectorAll('.job-card').forEach((card) => {
      card.addEventListener('click', () => {
        const asset = assetsById.get(Number(card.dataset.assetId));
        if (asset) openAssetModal(asset);
      });
    });
  } catch (e) {
    toast(e.message, true);
  }
}

// Covering a Campaign Stage requirement means picking a product to shoot
// (same as Core/High Stock/Drops), but a promotion has no single known
// product to launch the modal from -- so this picks any tracked style
// directly rather than a pre-resolved colours/sizes list, and feeds the
// same Concept Development pipeline via POST /shoot-plan.
let promotionShootContext = null;

function shootThisWeekForPromotionStage(stageId) {
  const stage = ((state.currentPromotion && state.currentPromotion.stages) || []).find((s) => s.id === stageId);
  if (!stage) return;
  promotionShootContext = { stageId };
  document.getElementById('promotion-shoot-modal-title').textContent = `Cover Requirement — ${stage.name}`;
  populatePromotionShootStyleSelect();
  populatePromotionShootCreatorSelect();
  document.getElementById('promotion-shoot-stock-status').value = 'needs_to_be_brought_in';
  document.getElementById('promotion-shoot-size').value = '';
  document.getElementById('promotion-shoot-note').value = '';
  updatePromotionShootSizeVisibility();
  openModal('promotion-shoot-modal');
}

function populatePromotionShootStyleSelect() {
  const sel = document.getElementById('promotion-shoot-style');
  sel.innerHTML = state.styles.map((s) => `<option value="${s.id}">${escapeHtml(s.style_code)} — ${escapeHtml(s.name)}</option>`).join('');
}

function populatePromotionShootCreatorSelect() {
  const sel = document.getElementById('promotion-shoot-creator');
  sel.innerHTML = state.contentCreators.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
  const defaultEntry = state.contentCreators.find((c) => c.is_default) || state.contentCreators[0];
  sel.value = defaultEntry ? defaultEntry.name : DEFAULT_CREATOR;
}

function updatePromotionShootSizeVisibility() {
  const bringingFromWarehouse = document.getElementById('promotion-shoot-stock-status').value === 'needs_to_be_brought_in';
  document.getElementById('promotion-shoot-size-row').style.display = bringingFromWarehouse ? '' : 'none';
}

async function savePromotionShootItem() {
  if (!promotionShootContext) return;
  const styleId = Number(document.getElementById('promotion-shoot-style').value);
  const style = state.styles.find((s) => s.id === styleId);
  if (!style) return toast('Select a product / style', true);
  const stockStatus = document.getElementById('promotion-shoot-stock-status').value;
  const size = document.getElementById('promotion-shoot-size').value.trim();
  const creator = document.getElementById('promotion-shoot-creator').value.trim();
  if (!creator) return toast('Content creator is required', true);
  const note = document.getElementById('promotion-shoot-note').value.trim();

  try {
    await api('/shoot-plan', {
      method: 'POST',
      body: JSON.stringify({
        product_code: style.style_code,
        product_name: style.name,
        colourways: [{ style_id: style.id, size: size || null, colour_label: null }],
        stock_status: stockStatus,
        creator,
        quick_note: note,
        source: 'promotion',
        promotion_stage_id: promotionShootContext.stageId,
        week_start: planningWeekStart(),
      }),
    });
    closeModal('promotion-shoot-modal');
    toast('Sent to Concept Development');
    await refreshCurrentPromotion();
    if (document.getElementById('planning-promotion-stage-view').style.display !== 'none') {
      renderPromotionStageDetailView();
    }
    loadAll();
  } catch (e) {
    toast(e.message, true);
  }
}

// ── Planning: Step 5 -- This Week's Shoot Plan ───────
// The Monday handoff, not another planning dashboard: a compact top summary
// (Selected / Samples Required / Sent to Content, plus the Apparel Magic
// CSV as a small secondary utility), one row per product grouped by where
// it came from, and one clear primary action -- Confirm & Send Shoot Plan
// -- which is the actual Content handoff. The CSV is operational (getting
// warehouse stock pulled), not the handoff itself, so it never competes
// with that button for attention.
// 'other' catches any pre-migration item whose source is NULL, so it never
// silently vanishes from the total.
const SHOOT_PLAN_SOURCE_LABELS = { core: 'CORE', high_stock: 'HIGH STOCK', drop: 'UPCOMING DROPS', promotion: 'PROMOTIONS', other: 'OTHER' };
const SHOOT_PLAN_SOURCE_ORDER = ['core', 'high_stock', 'drop', 'promotion', 'other'];

// The creative pathway a product's source implies -- fixed copy for
// Core/Drops per the brief, "Cover Requirement" reused verbatim from the
// Promotions shoot modal since that's the only existing precedent string.
function shootPlanRequirementLabel(item) {
  switch (item.source) {
    case 'core': return 'Develop New Concepts';
    case 'drop': return 'Proven Concepts Already Assigned';
    case 'high_stock': return 'Creative Refresh (High Stock)';
    case 'promotion': return item.promotion_stage_name ? `Cover Requirement — ${item.promotion_stage_name}` : 'Cover Requirement';
    default: return '—';
  }
}

// Size only matters (and so is only editable) for colourways being pulled
// from the warehouse -- an "in office" sample doesn't have a pull-list
// size to get wrong. Past weeks stay read-only, same as Remove.
// Opens a small modal listing every colourway on this product with an
// editable size field, rather than an inline per-chip edit -- one clear
// "Edit Sizes" action on the card, same footing as "Remove".
let shootPlanEditSizesItemId = null;

// Same select-when-known/text-when-not fallback the "Shoot This Week"
// modal itself uses -- a real dropdown of valid sizes when AM resolves a
// size range for the style, otherwise free text.
function shootPlanEditSizeControlHtml(s) {
  if (s.sizes && s.sizes.length) {
    const options = s.sizes
      .map((sz) => `<option value="${escapeHtml(sz)}" ${sz === s.size ? 'selected' : ''}>${escapeHtml(sz)}</option>`)
      .join('');
    return `<select class="shoot-plan-edit-size-input" data-style-id="${s.style_id}">${options}</select>`;
  }
  return `<input type="text" class="shoot-plan-edit-size-input" data-style-id="${s.style_id}" value="${escapeHtml(s.size || '')}" placeholder="Size">`;
}

function openShootPlanEditSizesModal(itemId) {
  const item = state.shootPlan.find((i) => i.id === itemId);
  if (!item) return;
  shootPlanEditSizesItemId = itemId;
  document.getElementById('shoot-plan-edit-sizes-title').textContent = `Edit Sizes — ${item.product_name}`;
  document.getElementById('shoot-plan-edit-sizes-list').innerHTML = item.styles.map((s) => `
    <div class="shoot-plan-edit-size-row">
      <span>${escapeHtml(s.colour_label || s.style_code)}</span>
      ${shootPlanEditSizeControlHtml(s)}
    </div>`).join('');
  openModal('shoot-plan-edit-sizes-modal');
}

async function saveShootPlanEditSizes() {
  const itemId = shootPlanEditSizesItemId;
  if (!itemId) return;
  const inputs = document.querySelectorAll('#shoot-plan-edit-sizes-list .shoot-plan-edit-size-input');
  try {
    await Promise.all(Array.from(inputs).map((input) =>
      api(`/shoot-plan/${itemId}/styles/${input.dataset.styleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ size: input.value.trim() }),
      })
    ));
    closeModal('shoot-plan-edit-sizes-modal');
    toast('Sizes updated');
    loadAll();
  } catch (e) {
    toast(e.message, true);
  }
}

function shootPlanProductRowHtml(item) {
  const thumb = item.image_url
    ? `<img class="high-stock-thumb" src="${item.image_url}" alt="">`
    : '<span class="high-stock-thumb high-stock-noimg">🖼</span>';
  const ready = item.stock_status === 'in_office';
  const chips = item.styles
    .map((s) => `<span class="shoot-plan-style-chip">${escapeHtml(s.colour_label || s.style_code)}${s.size ? ` · ${escapeHtml(s.size)}` : ''}</span>`)
    .join('');
  // Past weeks are a read-only historical record -- no editing what
  // already happened. Sizes only matter for colourways being pulled from
  // the warehouse -- an "in office" sample has nothing to correct.
  const readOnly = state.planningWeekOffset < 0;
  const editSizesBtn = !ready && !readOnly
    ? `<button type="button" class="btn btn-ghost btn-sm" onclick="openShootPlanEditSizesModal(${item.id})">Edit Sizes</button>`
    : '';
  const removeBtn = readOnly
    ? ''
    : `<button type="button" class="btn btn-ghost btn-sm" onclick="removeShootPlanItem(${item.id})">Remove</button>`;
  return `
    <div class="shoot-plan-product-row">
      ${thumb}
      <div class="shoot-plan-product-main">
        <div class="shoot-plan-product-top">
          <span class="shoot-plan-product-name">${escapeHtml(item.product_name)}</span>
          <span class="shoot-plan-stock-badge ${ready ? 'shoot-plan-stock-ready' : 'shoot-plan-stock-warehouse'}">${ready ? 'Ready' : 'Bring from Warehouse'}</span>
        </div>
        <div class="shoot-plan-product-meta">
          <span class="shoot-plan-owner">Owner: ${escapeHtml(item.creator)}</span>
          <span class="shoot-plan-pathway-chip">${escapeHtml(shootPlanRequirementLabel(item))}</span>
        </div>
        <div class="shoot-plan-style-chips">${chips}</div>
        ${item.quick_note ? `<div class="shoot-plan-idea">💡 ${escapeHtml(item.quick_note)}</div>` : ''}
      </div>
      <div class="shoot-plan-row-actions">${editSizesBtn}${removeBtn}</div>
    </div>`;
}

function shootPlanGroupedHtml(emptyMessage) {
  if (!state.shootPlan.length) {
    return `<div class="attention-empty">${emptyMessage}</div>`;
  }
  const bySource = new Map();
  for (const item of state.shootPlan) {
    const key = SHOOT_PLAN_SOURCE_ORDER.includes(item.source) ? item.source : 'other';
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(item);
  }
  return SHOOT_PLAN_SOURCE_ORDER
    .filter((key) => bySource.has(key))
    .map((key) => `
      <div class="shoot-plan-source-group">
        <div class="shoot-plan-source-label">${SHOOT_PLAN_SOURCE_LABELS[key]}</div>
        ${bySource.get(key).map(shootPlanProductRowHtml).join('')}
      </div>`)
    .join('');
}

// Same grouped row list Shoot Plan itself uses -- so while working through
// Core/High Stock/Upcoming Drops/Promotions, you can see exactly what's
// been selected so far without switching tabs. "Go to Shoot Plan" still
// jumps to the full step for the stat bar, Confirm & Send, and CSV export.
function renderPlanningShootPlanSummary() {
  const count = state.shootPlan.length;
  document.getElementById('planning-shoot-plan-summary-count').textContent =
    count ? `${count} product${count === 1 ? '' : 's'} selected this week` : 'Nothing selected yet this week';
  document.getElementById('planning-shoot-plan-summary-link').style.display = count ? '' : 'none';
  document.getElementById('planning-shoot-plan-summary-list').innerHTML =
    shootPlanGroupedHtml('Nothing selected yet this week — use + Shoot This Week on a Core, High Stock, Upcoming Drop, or Promotion product to add one.');
}

// Colourway+size rows across every "Bring from Warehouse" selection --
// the raw material for both the Samples Required stat and the AM CSV.
function shootPlanWarehouseRows() {
  return state.shootPlan
    .filter((i) => i.stock_status === 'needs_to_be_brought_in')
    .flatMap((i) => i.styles.map((s) => ({ product_name: i.product_name, style_code: s.style_code, colour: s.colour_label, size: s.size })));
}

function renderShootPlanStep() {
  const total = state.shootPlan.length;
  const samplesRequired = shootPlanWarehouseRows().length;
  // Once confirmed, the products/samples counts stay the headline -- "Sent
  // to Content" collapses to a plain checkmark rather than a duplicate
  // count, so this bar stays a glance-length summary, not another stat row.
  const confirmedActive = Boolean(state.weeklyShootPlanConfirmation) && !state.shootPlanEditMode;
  document.getElementById('shoot-plan-summary-stats').innerHTML = confirmedActive
    ? `<span><strong>${total}</strong> Product${total === 1 ? '' : 's'}</span><span class="shoot-plan-summary-sep">&middot;</span><span><strong>${samplesRequired}</strong> Sample${samplesRequired === 1 ? '' : 's'}</span><span class="shoot-plan-summary-sep">&middot;</span><span class="shoot-plan-summary-sent">&#10003; Sent to Content</span>`
    : `<span><strong>${total}</strong> Product${total === 1 ? '' : 's'} Selected</span><span class="shoot-plan-summary-sep">&middot;</span><span><strong>${samplesRequired}</strong> Sample${samplesRequired === 1 ? '' : 's'} Required</span><span class="shoot-plan-summary-sep">&middot;</span><span><strong>0</strong> Sent to Content</span>`;

  document.getElementById('shoot-plan-grouped').innerHTML =
    shootPlanGroupedHtml('Nothing planned yet this week — use + Shoot This Week on a Core, High Stock, Upcoming Drop, or Promotion product to add one.');

  document.getElementById('shoot-plan-samples-required-count').textContent =
    `${samplesRequired} sample${samplesRequired === 1 ? '' : 's'} required`;
  document.getElementById('shoot-plan-csv-btn').disabled = !samplesRequired;

  document.getElementById('shoot-plan-confirm-subtext').textContent =
    `${total} product${total === 1 ? '' : 's'} will be added to the content workflow.`;

  renderWeeklyShootPlanConfirmation();
}

// Formats a confirmation timestamp with both date and time, since "sent
// Monday morning" vs "sent Monday evening" is exactly the kind of thing
// this handoff moment should make unambiguous.
function formatDateTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  });
}

function renderWeeklyShootPlanConfirmation() {
  const cta = document.getElementById('shoot-plan-confirm-cta');
  const confirmed = document.getElementById('shoot-plan-confirmed-state');
  const btn = document.getElementById('shoot-plan-confirm-btn');
  const editBtn = document.getElementById('shoot-plan-edit-plan-btn');
  const readOnly = state.planningWeekOffset < 0;

  if (state.weeklyShootPlanConfirmation && !state.shootPlanEditMode) {
    cta.style.display = 'none';
    confirmed.style.display = '';
    document.getElementById('shoot-plan-confirmed-timestamp').textContent =
      formatDateTime(state.weeklyShootPlanConfirmation.confirmed_at);
    // No editing a past week's already-confirmed plan.
    editBtn.style.display = readOnly ? 'none' : '';
  } else {
    cta.style.display = '';
    confirmed.style.display = 'none';
    btn.disabled = !state.shootPlan.length || readOnly;
  }
}

// "Edit Plan" doesn't undo the weekly confirmation record (it's idempotent
// by design -- re-confirming just returns the existing row) -- it only
// re-reveals the CTA so the team can keep adjusting the plan without the
// confirmed card sitting in the way. Confirming again from here is a no-op
// against the backend and simply returns to the confirmed view.
function editShootPlan() {
  state.shootPlanEditMode = true;
  // The top summary's "Sent to Content" checkmark also depends on edit
  // mode now, so this needs the full step repaint, not just the
  // confirmation row.
  renderShootPlanStep();
}

async function confirmWeeklyShootPlan() {
  try {
    state.weeklyShootPlanConfirmation = await api('/weekly-shoot-plan-confirmation', {
      method: 'POST',
      body: JSON.stringify({ week_start: planningWeekStart() }),
    });
    state.shootPlanEditMode = false;
    renderShootPlanStep();
    // The "5 Shoot Plan" nav tick and the week-header badge both derive
    // from this same confirmation, so they need their own repaint here.
    renderPlanningStepNav();
    renderPlanningWeekHeader();
    toast('Shoot plan sent to Concept Development');
  } catch (e) {
    toast(e.message, true);
  }
}

// Mirrors the Mystery Box Builder's "Apparel Magic order export" CSV
// exactly (customer_po, customer_name, sku_alt, qty, date_due, date,
// unit_price, date_start), quoted fields with doubled internal quotes.
// sku_alt is the colourway's style_code with the size code appended
// (e.g. "W26BA004DBEXXS"), same as the Mystery Box export, so Warehouse
// can pull the exact size without matching it against style_code by hand.
function downloadApparelMagicCsv() {
  const rows = shootPlanWarehouseRows();
  if (!rows.length) return;

  const today = new Date().toISOString().slice(0, 10);
  const po = `CONTENT SHOOT ${today}`;
  const headers = ['customer_po', 'customer_name', 'sku_alt', 'qty', 'date_due', 'date', 'unit_price', 'date_start'];
  const csvRows = rows.map((r) => [po, 'WNDRR Promo', `${r.style_code}${r.size || ''}`, '1', today, today, '0.00', today]);
  const csv = [headers, ...csvRows]
    .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `apparel-magic-shoot-plan-${today}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Concept Development ──────────────────────────────
// The content creator's workspace for turning a CONFIRMED weekly Shoot Plan
// into concepts ready for the Tuesday review meeting. Product/colourways/
// owner/source/pathway/initial idea all come straight from the Planning
// handoff (state.conceptDev.data, from GET /concept-development) -- nothing
// here lets the creator re-enter any of that, only develop/track concepts.
// Week nav mirrors Planning's own (same mondayOfWeek/isoWeekNumber/
// formatWeekRange helpers, same picker markup) via its own weekOffset, kept
// independent for the same reason dashboardWeekOffset is independent of
// planningWeekOffset.
const CONCEPT_DEV_STATUS_LABELS = {
  not_started: 'Not Started',
  in_development: 'In Development',
  ready_for_review: 'Ready for Review',
  changes_required: 'Changes Required',
  approved: 'Approved',
};
const CONCEPT_DEV_STATUS_CLASS = {
  not_started: 'cd-status-not-started',
  in_development: 'cd-status-in-development',
  ready_for_review: 'cd-status-ready-for-review',
  changes_required: 'cd-status-changes-required',
  approved: 'cd-status-approved',
};

async function loadConceptDevWeek() {
  try {
    state.conceptDev.data = await api(`/concept-development?week_start=${conceptDevWeekStart()}`);
    renderConceptDevWeekHeader();
    renderConceptDevList();
  } catch (e) {
    toast(e.message, true);
  }
}

function changeConceptDevWeek(delta) {
  state.conceptDev.weekOffset += delta;
  onConceptDevWeekChanged();
}

function goToCurrentConceptDevWeek() {
  state.conceptDev.weekOffset = 0;
  onConceptDevWeekChanged();
}

function jumpToConceptDevWeek(offset) {
  state.conceptDev.weekOffset = offset;
  onConceptDevWeekChanged();
}

function onConceptDevWeekChanged() {
  closeConceptDevWeekPicker();
  state.conceptDev.view = 'list';
  state.conceptDev.currentItemId = null;
  loadConceptDevWeek();
}

function toggleConceptDevWeekPicker() {
  const el = document.getElementById('cd-week-picker');
  const opening = el.style.display === 'none';
  if (opening) renderConceptDevWeekPicker();
  el.style.display = opening ? '' : 'none';
}

function closeConceptDevWeekPicker() {
  document.getElementById('cd-week-picker').style.display = 'none';
}

function renderConceptDevWeekPicker() {
  const rows = [];
  for (let offset = 8; offset >= -12; offset--) {
    const monday = mondayOfWeek(offset);
    rows.push({ offset, number: isoWeekNumber(monday), range: formatWeekRange(monday) });
  }
  document.getElementById('cd-week-picker').innerHTML = rows.map((r) => `
    <button type="button" class="planning-week-picker-row ${r.offset === state.conceptDev.weekOffset ? 'active' : ''}" onclick="jumpToConceptDevWeek(${r.offset})">
      <span>Week ${r.number}${r.offset === 0 ? ' · Current' : ''}</span>
      <span class="admin-note">${r.range}</span>
    </button>`).join('');
}

document.addEventListener('click', (e) => {
  const picker = document.getElementById('cd-week-picker');
  if (!picker || picker.style.display === 'none') return;
  if (e.target.closest('#cd-week-picker') || e.target.id === 'cd-week-label') return;
  picker.style.display = 'none';
});

function renderConceptDevWeekHeader() {
  document.getElementById('cd-week-label').textContent = `Week ${conceptDevWeekNumber()}`;
  document.getElementById('cd-this-week-btn').style.display = state.conceptDev.weekOffset === 0 ? 'none' : '';
  const confirmed = Boolean(state.conceptDev.data && state.conceptDev.data.confirmed);
  const statusEl = document.getElementById('cd-week-status');
  statusEl.textContent = confirmed ? '✓ Confirmed' : 'Not Confirmed Yet';
  statusEl.className = `planning-week-status ${confirmed ? 'planning-week-status-confirmed' : ''}`;
}

// Compact wording for the landing-page card -- deliberately shorter than
// shootPlanRequirementLabel() (which the Product Workspace header below
// still uses in full): the card already shows the source badge, so
// repeating "(High Stock)"/"Already" in the pathway badge next to it would
// just be the same fact twice on a tile meant to be scanned in a glance.
const CONCEPT_DEV_SOURCE_LABELS = { core: 'Core', high_stock: 'High Stock', drop: 'Upcoming Drop', promotion: 'Promotion' };
const CONCEPT_DEV_PATHWAY_LABELS = { core: 'Develop New Concepts', high_stock: 'Creative Refresh', drop: 'Proven Concepts Assigned', promotion: 'Cover Requirement' };

// Not Started / Ready for Review are always shown, even at 0 -- a fixed,
// predictable pair (what still needs starting vs. what's ready to check
// off) rather than a variable-length list of every non-zero status, so
// every card reads the same shape at a glance.
function conceptDevStatusCounts(concepts) {
  return {
    notStarted: concepts.filter((c) => c.concept_dev_status === 'not_started').length,
    readyForReview: concepts.filter((c) => c.concept_dev_status === 'ready_for_review').length,
  };
}

// Buckets a product into the landing page's own filter groups. A product
// still needs development the moment ANY of its concepts aren't ready
// (including changes_required -- that's more work, not a review state);
// it only counts as fully approved once EVERY concept is. A product with
// no concepts yet (shouldn't normally happen, given the seed-asset
// guarantee) defensively falls into needs_development too.
function conceptDevProductBucket(product) {
  const statuses = product.concepts.map((c) => c.concept_dev_status);
  if (!statuses.length) return 'needs_development';
  if (statuses.some((s) => s === 'not_started' || s === 'in_development' || s === 'changes_required')) return 'needs_development';
  if (statuses.some((s) => s === 'ready_for_review')) return 'ready_for_review';
  return 'approved';
}

function conceptDevFilteredProducts(data) {
  if (state.conceptDev.filter === 'all') return data.products;
  return data.products.filter((p) => conceptDevProductBucket(p) === state.conceptDev.filter);
}

// "What products do I need to prepare for Tuesday?" -- one compact card
// per product, no concept-level detail (that's the Product Workspace's
// job). Reuses .high-stock-thumb for the image, same as everywhere else a
// product thumbnail appears in Planning.
function conceptDevProductCardHtml(product) {
  const thumb = product.image_url
    ? `<img class="high-stock-thumb" src="${product.image_url}" alt="">`
    : '<span class="high-stock-thumb high-stock-noimg">🖼</span>';
  const sourceLabel = CONCEPT_DEV_SOURCE_LABELS[product.source] || product.source || '—';
  const pathwayLabel = CONCEPT_DEV_PATHWAY_LABELS[product.source] || shootPlanRequirementLabel(product);
  const count = product.concepts.length;
  const { notStarted, readyForReview } = conceptDevStatusCounts(product.concepts);
  // A Drop's concepts are already-assigned Proven Winners -- the creator is
  // opening what exists, not developing something new, so the action reads
  // differently even though the click target is identical.
  const actionLabel = product.source === 'drop' ? 'Open Concepts' : 'Develop Concepts';
  return `
    <div class="cd-card" onclick="openConceptDevProduct(${product.shoot_plan_item_id})">
      <div class="cd-card-top">
        ${thumb}
        <div class="cd-card-name">${escapeHtml(product.product_name)}</div>
      </div>
      <div class="cd-card-badges">
        <span class="cd-badge">${escapeHtml(sourceLabel)}</span>
        <span class="cd-badge cd-badge-pathway">${escapeHtml(pathwayLabel)}</span>
      </div>
      <div class="cd-card-count">${count} Concept${count === 1 ? '' : 's'}</div>
      <div class="cd-card-status-row">
        <span class="cd-concept-status-pill cd-pill-neutral">${notStarted} Not Started</span>
        <span class="cd-concept-status-pill ${readyForReview > 0 ? 'cd-status-ready-for-review' : 'cd-pill-neutral'}">${readyForReview} Ready for Review</span>
      </div>
      <div class="cd-card-meta">${product.colourways.length} Colourway${product.colourways.length === 1 ? '' : 's'} &middot; Owner: ${escapeHtml(product.creator || '—')}</div>
      <div class="cd-card-action">${actionLabel} &rarr;</div>
    </div>`;
}

// Understated by design ("do not make this header oversized or dashboard-
// heavy") -- one small line of plain counts, not a coloured summary card.
function conceptDevWeekSummaryLineHtml(data) {
  const totalConcepts = data.products.reduce((sum, p) => sum + p.concepts.length, 0);
  const readyForReview = data.products.reduce(
    (sum, p) => sum + p.concepts.filter((c) => c.concept_dev_status === 'ready_for_review').length, 0
  );
  return `<div class="cd-week-summary-line">${data.products.length} Product${data.products.length === 1 ? '' : 's'} &middot; ${totalConcepts} Concept${totalConcepts === 1 ? '' : 's'} &middot; ${readyForReview} Ready for Review</div>`;
}

const CONCEPT_DEV_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'needs_development', label: 'Needs Development' },
  { key: 'ready_for_review', label: 'Ready for Review' },
  { key: 'approved', label: 'Approved' },
];

function conceptDevFiltersHtml() {
  return `
    <div class="cd-filters">
      ${CONCEPT_DEV_FILTERS.map((f) => `
        <button type="button" class="cd-filter-btn ${state.conceptDev.filter === f.key ? 'active' : ''}" onclick="setConceptDevFilter('${f.key}')">${escapeHtml(f.label)}</button>`).join('')}
    </div>`;
}

function setConceptDevFilter(filter) {
  state.conceptDev.filter = filter;
  renderConceptDevList();
}

function openConceptDevProduct(itemId) {
  state.conceptDev.view = 'product';
  state.conceptDev.currentItemId = itemId;
  renderConceptDevList();
}

function closeConceptDevProduct() {
  state.conceptDev.view = 'list';
  state.conceptDev.currentItemId = null;
  renderConceptDevList();
}

// The Product Workspace's own header -- everything inherited from Planning
// (image/name/source/full pathway text/owner/colourways+sizes/concept
// count), read-only, so the creator never re-enters what's already there.
function conceptDevWorkspaceHeaderHtml(product) {
  const thumb = product.image_url
    ? `<img class="high-stock-thumb" src="${product.image_url}" alt="">`
    : '<span class="high-stock-thumb high-stock-noimg">🖼</span>';
  const sourceLabel = CONCEPT_DEV_SOURCE_LABELS[product.source] || product.source || '—';
  const chips = product.colourways
    .map((c) => `<span class="shoot-plan-style-chip">${escapeHtml(c.colour_label || c.style_code)}${c.size ? ` · ${escapeHtml(c.size)}` : ''}</span>`)
    .join('');
  const count = product.concepts.length;
  return `
    <div class="cd-workspace-header">
      ${thumb}
      <div class="cd-workspace-header-info">
        <div class="cd-workspace-header-name">${escapeHtml(product.product_name)}</div>
        <div class="cd-workspace-header-meta">
          <span>${escapeHtml(sourceLabel)}</span>
          <span>&middot;</span>
          <span>${escapeHtml(shootPlanRequirementLabel(product))}</span>
          <span>&middot;</span>
          <span>Owner: ${escapeHtml(product.creator || '—')}</span>
          <span>&middot;</span>
          <span>${count} Concept${count === 1 ? '' : 's'}</span>
        </div>
        <div class="shoot-plan-style-chips">${chips}</div>
        ${product.initial_idea ? `<div class="shoot-plan-idea">💡 ${escapeHtml(product.initial_idea)}</div>` : ''}
      </div>
    </div>`;
}

// Compact card, not a thin row -- shows just enough to decide what to open
// next: name/locked-tag/status, plus whether a Hook and a Reference have
// already been added (the two fields that most determine "is this actually
// ready to shoot", so they're worth surfacing without opening the concept).
function conceptDevConceptCardHtml(concept) {
  const hasHook = Array.isArray(concept.hook_variations) && concept.hook_variations.some((h) => h.text && h.text.trim());
  const hasReference = Array.isArray(concept.reference_items) && concept.reference_items.length > 0;
  return `
    <div class="cd-concept-card" onclick="openConceptDevModal(${concept.id})">
      <div class="cd-concept-card-top">
        <span class="cd-concept-card-name">${escapeHtml(concept.concept_name)}</span>
        ${concept.name_locked ? '<span class="cd-locked-tag">Proven</span>' : ''}
      </div>
      <span class="cd-concept-status-pill ${CONCEPT_DEV_STATUS_CLASS[concept.concept_dev_status] || ''}">${CONCEPT_DEV_STATUS_LABELS[concept.concept_dev_status] || concept.concept_dev_status}</span>
      <div class="cd-concept-card-flags">
        <span class="${hasHook ? 'cd-concept-flag-on' : 'cd-concept-flag-off'}">${hasHook ? '✓' : '—'} Hook</span>
        <span class="${hasReference ? 'cd-concept-flag-on' : 'cd-concept-flag-off'}">${hasReference ? '✓' : '—'} Reference</span>
      </div>
      <div class="cd-concept-card-action">Open Concept &rarr;</div>
    </div>`;
}

// "What concepts do I need to prepare for this product?" -- concept cards
// stay compact (name/locked-tag/status/hook+reference flags only); the full
// Concept Details/References/Shoot Requirements form only appears once one
// is opened (openConceptDevModal). A Drop's concepts are already-decided
// Proven Winners, so "+ New Concept" is deliberately NOT the prominent
// action there -- the creator's job is opening each one and preparing its
// execution, not inventing another. Core/High Stock/Promotion have no such
// pre-assigned concepts, so "+ New Concept" is the primary action instead.
function renderConceptDevProductWorkspace(product) {
  const isProvenAssigned = product.source === 'drop';
  return `
    <button type="button" class="link-btn cd-back-link" onclick="closeConceptDevProduct()">&larr; Back to Products</button>
    ${conceptDevWorkspaceHeaderHtml(product)}
    ${!isProvenAssigned ? `<button type="button" class="btn btn-primary btn-sm cd-new-concept-btn" onclick="openAddConceptModal(${product.shoot_plan_item_id})">+ New Concept</button>` : ''}
    <div class="cd-concept-grid">
      ${product.concepts.length ? product.concepts.map(conceptDevConceptCardHtml).join('') : '<div class="attention-empty">No concepts yet.</div>'}
    </div>
    ${isProvenAssigned ? `<button type="button" class="link-btn cd-add-concept-subtle" onclick="openAddConceptModal(${product.shoot_plan_item_id})">+ Add another concept</button>` : ''}
  `;
}

// Dispatches between the two "pages" this tab now has -- the landing grid
// ("what products?") and a single product's workspace ("what concepts?") --
// both rendered into the same #concept-dev-list target, driven by
// state.conceptDev.view/currentItemId (see openConceptDevProduct/
// closeConceptDevProduct). Falls back to the landing grid if the current
// product no longer exists in a freshly (re)loaded week -- e.g. the week
// was changed while a product workspace was open.
function renderConceptDevList() {
  const list = document.getElementById('concept-dev-list');
  const data = state.conceptDev.data;
  if (!data || !data.confirmed) {
    state.conceptDev.view = 'list';
    list.innerHTML = `<div class="attention-empty">Shoot Plan for Week ${conceptDevWeekNumber()} hasn't been confirmed yet — nothing to prepare. <button type="button" class="link-btn" onclick="switchTab('planning')">Go to Planning &rarr;</button></div>`;
    return;
  }
  if (!data.products.length) {
    state.conceptDev.view = 'list';
    list.innerHTML = '<div class="attention-empty">Nothing was in this week\'s Shoot Plan.</div>';
    return;
  }

  if (state.conceptDev.view === 'product') {
    const product = data.products.find((p) => p.shoot_plan_item_id === state.conceptDev.currentItemId);
    if (product) {
      list.innerHTML = renderConceptDevProductWorkspace(product);
      return;
    }
    state.conceptDev.view = 'list';
  }

  const filtered = conceptDevFilteredProducts(data);
  list.innerHTML = `
    ${conceptDevWeekSummaryLineHtml(data)}
    ${conceptDevFiltersHtml()}
    <div class="cd-product-grid">
      ${filtered.length ? filtered.map(conceptDevProductCardHtml).join('') : '<div class="attention-empty">No products match this filter.</div>'}
    </div>`;
}

function findConceptDevConcept(conceptId) {
  for (const p of (state.conceptDev.data && state.conceptDev.data.products) || []) {
    const c = p.concepts.find((c) => c.id === conceptId);
    if (c) return { concept: c, product: p };
  }
  return null;
}

let conceptDevModalConceptId = null;
let conceptDevModalProduct = null;
let conceptDevModalReferences = [];
let conceptDevModalHooks = [];

// A concept's hook variations -- the first entry is always the Primary
// Hook (never removable, unlike a reference or an alternative hook: a
// concept always has exactly one primary opening slot, even if it's still
// blank), any further entries are Alternative Hooks. There's deliberately
// no minimum enforced here or at save time -- one strong hook is a
// complete concept, per the brief; this only ever adds a slot when the
// creator asks for one.
function renderConceptDevModalHooks() {
  document.getElementById('cd-modal-hooks-list').innerHTML = conceptDevModalHooks.map((h, i) => `
    <div class="cd-hook-item">
      <label>${i === 0 ? 'Primary Hook' : `Alternative Hook ${i + 1}`}
        <textarea rows="2" oninput="conceptDevModalHooks[${i}].text=this.value" placeholder="${i === 0 ? 'e.g. 5 tees. $200. Here\'s what you actually get.' : 'A different opening for the same concept'}">${escapeHtml(h.text)}</textarea>
      </label>
      ${i > 0 ? `<button type="button" class="link-btn cd-hook-remove" onclick="removeConceptDevHook(${i})">Remove</button>` : ''}
    </div>`).join('');
}

function addConceptDevHook() {
  conceptDevModalHooks.push({ text: '' });
  renderConceptDevModalHooks();
  const textareas = document.querySelectorAll('#cd-modal-hooks-list textarea');
  if (textareas.length) textareas[textareas.length - 1].focus();
}

function removeConceptDevHook(index) {
  conceptDevModalHooks.splice(index, 1);
  renderConceptDevModalHooks();
}

function renderConceptDevModalReferences() {
  document.getElementById('cd-modal-references-list').innerHTML = conceptDevModalReferences.length
    ? conceptDevModalReferences.map((r, i) => `
        <div class="cd-reference-item">
          <div class="cd-reference-item-row">
            <input type="text" value="${escapeHtml(r.url)}" oninput="conceptDevModalReferences[${i}].url=this.value" placeholder="Reference link">
            <button type="button" class="cd-reference-remove" onclick="removeConceptDevReference(${i})" aria-label="Remove reference">&times;</button>
          </div>
          <textarea rows="2" oninput="conceptDevModalReferences[${i}].note=this.value" placeholder="What do we like about it?">${escapeHtml(r.note)}</textarea>
        </div>`).join('')
    : '<span class="hint">Add inspiration or examples for this concept.</span>';
}

function addConceptDevReference() {
  conceptDevModalReferences.push({ url: '', note: '' });
  renderConceptDevModalReferences();
  const inputs = document.querySelectorAll('#cd-modal-references-list .cd-reference-item-row input');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function removeConceptDevReference(index) {
  conceptDevModalReferences.splice(index, 1);
  renderConceptDevModalReferences();
}

// Read-only Planning-handoff context shown at the top of the workspace --
// product/source/pathway/owner/colourways -- so the creator (especially on
// a Drop's already-assigned Proven Winner concept) always has what they
// need to prep execution without leaving the modal or re-entering
// anything. Deliberately compact (one line, two if there's an initial
// idea from Planning) -- the creative-development fields are the point of
// this workspace, not the context banner, so it shouldn't compete for
// vertical space with them.
function conceptDevModalContextHtml(product) {
  const thumb = product.image_url
    ? `<img class="cd-modal-context-thumb" src="${product.image_url}" alt="">`
    : '<span class="cd-modal-context-thumb cd-modal-context-noimg">🖼</span>';
  const sourceLabel = CONCEPT_DEV_SOURCE_LABELS[product.source] || product.source || '—';
  const pathwayLabel = CONCEPT_DEV_PATHWAY_LABELS[product.source] || shootPlanRequirementLabel(product);
  const skuInfo = product.colourways
    .map((c) => `${c.style_code || c.colour_label}${c.size ? `-${c.size}` : ''}`)
    .join(', ');
  const line = [
    `<strong>${escapeHtml(product.product_name)}</strong>`,
    escapeHtml(sourceLabel),
    escapeHtml(pathwayLabel),
    `Owner: ${escapeHtml(product.creator || '—')}`,
    escapeHtml(skuInfo),
  ].filter(Boolean).join(' &middot; ');
  return `
    ${thumb}
    <div class="cd-modal-context-lines">
      <div class="cd-modal-context-line">${line}</div>
      ${product.initial_idea ? `<div class="cd-modal-context-idea">💡 ${escapeHtml(product.initial_idea)}</div>` : ''}
    </div>`;
}

// Shared by both the create ("+ Add Concept") and edit (click a concept
// card) paths -- concept is null in create mode, so every field just starts
// blank. Status is no longer an editable field here (see saveConceptDevModal)
// -- this just shows where the concept currently sits, read-only, in the
// header badge.
function fillConceptDevModalFields(concept) {
  document.getElementById('cd-modal-angle').value = concept ? (concept.angle || '') : '';
  document.getElementById('cd-modal-execution').value = concept ? (concept.execution || '') : '';
  document.getElementById('cd-modal-script').value = concept ? (concept.script_notes || '') : '';
  document.getElementById('cd-modal-talent').value = concept ? (concept.talent_requirement || '') : '';
  document.getElementById('cd-modal-location').value = concept ? (concept.location || '') : '';
  document.getElementById('cd-modal-props').value = concept ? (concept.props_notes || '') : '';
  conceptDevModalReferences = concept
    ? (concept.reference_items || []).map((r) => ({ url: r.url || '', note: r.note || '' }))
    : [];
  renderConceptDevModalReferences();

  // Always at least a Primary Hook slot -- even blank, it's the one
  // opening every concept has room for; Alternative Hooks only appear if
  // the concept actually has them.
  const existingHooks = concept && Array.isArray(concept.hook_variations) ? concept.hook_variations : [];
  conceptDevModalHooks = existingHooks.length
    ? existingHooks.map((h) => ({ text: h.text || '' }))
    : [{ text: '' }];
  renderConceptDevModalHooks();

  const status = concept ? concept.concept_dev_status : 'not_started';
  const badge = document.getElementById('cd-modal-status-badge');
  badge.className = `cd-concept-status-pill ${CONCEPT_DEV_STATUS_CLASS[status] || ''}`;
  badge.textContent = CONCEPT_DEV_STATUS_LABELS[status] || status;

  // Progressive disclosure: Script and Shoot Requirements stay collapsed
  // behind a toggle for the common case (a simple concept doesn't need
  // either), but open automatically if the concept already has content
  // there -- a creator revisiting it should never have to go hunting for
  // information that's already been entered.
  setConceptDevScriptExpanded(Boolean(concept && concept.script_notes));
  setConceptDevShootRequirementsExpanded(Boolean(
    concept && (concept.talent_requirement || concept.location || concept.props_notes)
  ));

  hideConceptDevValidation();
}

function setConceptDevScriptExpanded(expanded) {
  document.getElementById('cd-modal-script-toggle-wrap').style.display = expanded ? 'none' : '';
  document.getElementById('cd-modal-script-field').style.display = expanded ? '' : 'none';
}

function toggleConceptDevScript() {
  setConceptDevScriptExpanded(true);
  document.getElementById('cd-modal-script').focus();
}

function setConceptDevShootRequirementsExpanded(expanded) {
  document.getElementById('cd-modal-shoot-req-toggle-wrap').style.display = expanded ? 'none' : '';
  document.getElementById('cd-modal-shoot-req-fields').style.display = expanded ? '' : 'none';
}

function toggleConceptDevShootRequirements() {
  setConceptDevShootRequirementsExpanded(true);
  document.getElementById('cd-modal-talent').focus();
}

function hideConceptDevValidation() {
  const el = document.getElementById('cd-modal-validation');
  el.style.display = 'none';
  el.textContent = '';
  document.getElementById('cd-modal-angle').classList.remove('cd-field-invalid');
  document.getElementById('cd-modal-execution').classList.remove('cd-field-invalid');
}

// concept_name is locked to a read-only label for a Drop's Proven Winner
// concept (name_locked) -- the creator preps execution for the assigned
// concept rather than inventing the name again, per the brief.
function openConceptDevModal(conceptId) {
  const found = findConceptDevConcept(conceptId);
  if (!found) return;
  const { concept, product } = found;
  conceptDevModalConceptId = conceptId;
  conceptDevModalProduct = product;

  document.getElementById('cd-modal-context').innerHTML = conceptDevModalContextHtml(product);
  document.getElementById('cd-modal-title').textContent = concept.concept_name;

  const nameInput = document.getElementById('cd-modal-name');
  const nameLocked = document.getElementById('cd-modal-name-locked');
  if (concept.name_locked) {
    nameInput.style.display = 'none';
    nameLocked.style.display = '';
    nameLocked.textContent = `${concept.concept_name} — Proven Winner name, locked`;
  } else {
    nameInput.style.display = '';
    nameLocked.style.display = 'none';
    nameInput.value = concept.concept_name;
  }

  fillConceptDevModalFields(concept);
  openModal('concept-dev-modal');
}

// "+ Add Concept" opens this exact same workspace instead of a bare
// name-only prompt -- the creator can fill in everything (references,
// execution, talent/location/props) before the concept even exists
// server-side. Save Draft/Ready for Review creates it, then immediately
// PATCHes the rest in.
function openAddConceptModal(shootPlanItemId) {
  const data = state.conceptDev.data;
  const product = data && data.products.find((p) => p.shoot_plan_item_id === shootPlanItemId);
  if (!product) return;
  conceptDevModalConceptId = null;
  conceptDevModalProduct = product;

  document.getElementById('cd-modal-context').innerHTML = conceptDevModalContextHtml(product);
  document.getElementById('cd-modal-title').textContent = 'New Concept';

  const nameInput = document.getElementById('cd-modal-name');
  nameInput.style.display = '';
  nameInput.value = '';
  document.getElementById('cd-modal-name-locked').style.display = 'none';

  fillConceptDevModalFields(null);
  openModal('concept-dev-modal');
}

// Status is no longer a field the creator sets directly -- it's driven by
// which footer action they click. targetStatus is 'in_development' (Save
// Draft) or 'ready_for_review' (Ready for Review); a concept that's never
// been saved stays Not Started (see schema.sql's concept_dev_status
// default) until one of these two actions actually moves it.
async function saveConceptDevModal(targetStatus) {
  const product = conceptDevModalProduct;
  if (!product) return;
  const name = document.getElementById('cd-modal-name').value.trim();
  const angle = document.getElementById('cd-modal-angle').value.trim();
  const execution = document.getElementById('cd-modal-execution').value.trim();

  const body = {
    concept_dev_status: targetStatus,
    angle,
    execution,
    script_notes: document.getElementById('cd-modal-script').value.trim(),
    hook_variations: conceptDevModalHooks
      .map((h) => ({ text: h.text.trim() }))
      .filter((h) => h.text),
    reference_items: conceptDevModalReferences
      .map((r) => ({ url: r.url.trim(), note: r.note.trim() }))
      .filter((r) => r.url),
    talent_requirement: document.getElementById('cd-modal-talent').value.trim(),
    location: document.getElementById('cd-modal-location').value.trim(),
    props_notes: document.getElementById('cd-modal-props').value.trim(),
  };
  const savedToast = targetStatus === 'ready_for_review' ? 'Marked Ready for Review' : 'Draft saved';

  // Ready for Review is the only action with real required fields --
  // Save Draft stays deliberately permissive (just a name) so a creator
  // can jot down an idea and come back later. Missing fields get a clear
  // inline message rather than a generic toast, per the brief.
  if (targetStatus === 'ready_for_review') {
    const missing = [];
    if (!angle) missing.push('Angle / Idea');
    if (!execution) missing.push('Execution / Shot Plan');
    if (missing.length) {
      const el = document.getElementById('cd-modal-validation');
      el.textContent = `Before marking Ready for Review, add: ${missing.join(', ')}.`;
      el.style.display = '';
      document.getElementById('cd-modal-angle').classList.toggle('cd-field-invalid', !angle);
      document.getElementById('cd-modal-execution').classList.toggle('cd-field-invalid', !execution);
      el.scrollIntoView({ block: 'nearest' });
      return;
    }
  }
  hideConceptDevValidation();

  try {
    if (conceptDevModalConceptId) {
      const found = findConceptDevConcept(conceptDevModalConceptId);
      const nameLocked = found && found.concept.name_locked;
      if (!nameLocked) {
        if (!name) { toast('Concept name is required', true); return; }
        body.concept_name = name;
      }
      await api(`/concept-development/concepts/${conceptDevModalConceptId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      closeModal('concept-dev-modal');
      toast(savedToast);
    } else {
      if (!name) { toast('Concept name is required', true); return; }

      // Create the bare concept first (name only, matching both existing
      // creation endpoints), then PATCH the rest of the workspace into it --
      // no backend change needed for "create with everything filled in".
      let assetId;
      if (product.source === 'drop') {
        if (!product.drop_plan_id) {
          toast('This product\'s Required Concept plan is still being generated — try again in a moment.', true);
          return;
        }
        const data = await api(`/drop-product-plans/${product.drop_plan_id}/slots`, {
          method: 'POST',
          body: JSON.stringify({ concept_name: name }),
        });
        assetId = data.slots[data.slots.length - 1].asset_id;
      } else {
        const asset = await api('/concept-development/concepts', {
          method: 'POST',
          body: JSON.stringify({ shoot_plan_item_id: product.shoot_plan_item_id, concept_name: name }),
        });
        assetId = asset.id;
      }
      await api(`/concept-development/concepts/${assetId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      closeModal('concept-dev-modal');
      toast(savedToast);
    }
    loadConceptDevWeek();
  } catch (e) {
    toast(e.message, true);
  }
}

// ── Settings: Weekly New Concept Target ──────────────
function renderPlanningSettingsForm() {
  if (!state.planningSettings) return;
  document.getElementById('weekly-target-input').value = state.planningSettings.weekly_new_concept_target;
  document.getElementById('high-stock-min-soh-input').value = state.planningSettings.high_stock_min_soh;
  document.getElementById('default-shoot-top-size-input').value = state.planningSettings.default_shoot_top_size;
  document.getElementById('default-shoot-bottom-alpha-size-input').value = state.planningSettings.default_shoot_bottom_alpha_size;
  document.getElementById('default-shoot-bottom-waist-size-input').value = state.planningSettings.default_shoot_bottom_waist_size;
}

async function saveWeeklyTarget() {
  const value = document.getElementById('weekly-target-input').value;
  try {
    const updated = await api('/planning-settings', { method: 'PUT', body: JSON.stringify({ weekly_new_concept_target: Number(value) }) });
    state.planningSettings = updated;
    toast('Weekly target saved');
    const coreRes = await api('/core-products');
    state.coreProducts = coreRes.products;
    state.coreWeekly = { target: coreRes.weekly_target, planned: coreRes.weekly_planned, remaining: coreRes.weekly_remaining };
    renderCoreProducts();
  } catch (e) {
    toast(e.message, true);
  }
}

async function saveHighStockMinSoh() {
  const value = document.getElementById('high-stock-min-soh-input').value;
  try {
    const updated = await api('/planning-settings', { method: 'PUT', body: JSON.stringify({ high_stock_min_soh: Number(value) }) });
    state.planningSettings = updated;
    toast('High Stock Minimum SOH saved');
    const res = await api('/high-stock-products');
    state.highStockProducts = res.products;
    renderHighStockProducts();
  } catch (e) {
    toast(e.message, true);
  }
}

// ── Settings: Default Shoot Sizes ────────────────────
// One shared default per garment shape (not per Content Creator) --
// pre-fills a colourway's size when Shoot This Week opens. Three
// independent fields, each with its own Save button, same convention as
// every other Settings field on this form.
const DEFAULT_SHOOT_SIZE_FIELDS = {
  top: { field: 'default_shoot_top_size', inputId: 'default-shoot-top-size-input', label: 'Tops' },
  bottom_alpha: { field: 'default_shoot_bottom_alpha_size', inputId: 'default-shoot-bottom-alpha-size-input', label: 'Bottoms (Alpha)' },
  bottom_waist: { field: 'default_shoot_bottom_waist_size', inputId: 'default-shoot-bottom-waist-size-input', label: 'Bottoms (Waist)' },
};

async function saveDefaultShootSize(key) {
  const { field, inputId, label } = DEFAULT_SHOOT_SIZE_FIELDS[key];
  const value = document.getElementById(inputId).value.trim();
  if (!value) return toast(`${label} default size is required`, true);
  try {
    const updated = await api('/planning-settings', { method: 'PUT', body: JSON.stringify({ [field]: value }) });
    state.planningSettings = updated;
    toast(`${label} default size saved`);
  } catch (e) {
    toast(e.message, true);
  }
}

// ── Settings: Proven Winners ─────────────────────────
// Rank order is the single source of truth for priority; every reorder path
// (drag or up/down buttons) funnels into one PUT /proven-winners/reorder
// call so the server's full-list rank rewrite is the only place order ever
// actually changes.
let pwDragId = null;

function renderProvenWinners() {
  const list = document.getElementById('pw-list');
  if (!state.provenWinners.length) {
    list.innerHTML = '<div class="attention-empty">No Proven Winners yet — add your first concept below.</div>';
    return;
  }
  list.innerHTML = state.provenWinners.map((pw, i) => `
    <div class="pw-row" draggable="true" data-id="${pw.id}">
      <span class="pw-drag-handle" title="Drag to reorder">⠿</span>
      <span class="pw-rank">${pw.rank}</span>
      <span class="pw-name ${pw.active ? '' : 'inactive'}">${escapeHtml(pw.name)}</span>
      <span class="badge ${pw.active ? 'badge-tested_proven' : 'badge-format'}">${pw.active ? 'Active' : 'Inactive'}</span>
      <button type="button" class="btn btn-ghost btn-sm" ${i === 0 ? 'disabled' : ''} onclick="movePw(${pw.id}, -1)" title="Move up">&uarr;</button>
      <button type="button" class="btn btn-ghost btn-sm" ${i === state.provenWinners.length - 1 ? 'disabled' : ''} onclick="movePw(${pw.id}, 1)" title="Move down">&darr;</button>
      <button type="button" class="btn btn-ghost btn-sm" onclick="openPwModal(${pw.id})">Edit</button>
    </div>
  `).join('');
  wirePwDragEvents();
}

function wirePwDragEvents() {
  document.querySelectorAll('#pw-list .pw-row').forEach((row) => {
    row.addEventListener('dragstart', () => {
      pwDragId = Number(row.dataset.id);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      document.querySelectorAll('#pw-list .pw-row').forEach((r) => r.classList.remove('drag-over'));
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const targetId = Number(row.dataset.id);
      if (pwDragId == null || pwDragId === targetId) return;
      const ids = state.provenWinners.map((pw) => pw.id);
      const fromIdx = ids.indexOf(pwDragId);
      const toIdx = ids.indexOf(targetId);
      if (fromIdx === -1 || toIdx === -1) return;
      ids.splice(fromIdx, 1);
      ids.splice(toIdx, 0, pwDragId);
      submitPwReorder(ids);
    });
  });
}

function movePw(id, delta) {
  const ids = state.provenWinners.map((pw) => pw.id);
  const idx = ids.indexOf(id);
  const swapWith = idx + delta;
  if (idx === -1 || swapWith < 0 || swapWith >= ids.length) return;
  [ids[idx], ids[swapWith]] = [ids[swapWith], ids[idx]];
  submitPwReorder(ids);
}

async function submitPwReorder(orderedIds) {
  try {
    state.provenWinners = await api('/proven-winners/reorder', {
      method: 'PUT',
      body: JSON.stringify({ ordered_ids: orderedIds }),
    });
    renderProvenWinners();
  } catch (e) {
    toast(e.message, true);
  }
}

function openPwModal(id) {
  const pw = id ? state.provenWinners.find((p) => p.id === id) : null;
  document.getElementById('pw-modal-title').textContent = pw ? 'Edit Proven Winner' : 'New Proven Winner';
  document.getElementById('pw-id').value = pw ? pw.id : '';
  document.getElementById('pw-name').value = pw ? pw.name : '';
  document.getElementById('pw-description').value = (pw && pw.description) || '';
  document.getElementById('pw-format').value = pw ? pw.default_format : 'video';
  document.getElementById('pw-classification').value = pw ? pw.default_classification : 'tested_proven';
  document.getElementById('pw-position-row').style.display = pw ? 'none' : 'flex';
  document.getElementById('pw-position').value = '';
  document.getElementById('pw-active-row').style.display = pw ? 'flex' : 'none';
  document.getElementById('pw-active').checked = pw ? pw.active : true;
  document.getElementById('pw-delete-btn').style.display = pw ? 'inline-block' : 'none';
  openModal('pw-modal');
}

async function refreshProvenWinners() {
  state.provenWinners = await api('/proven-winners');
  renderProvenWinners();
}

async function savePw() {
  const id = document.getElementById('pw-id').value;
  const name = document.getElementById('pw-name').value;
  const description = document.getElementById('pw-description').value || null;
  const default_format = document.getElementById('pw-format').value;
  const default_classification = document.getElementById('pw-classification').value;
  if (!name.trim()) return toast('Concept name is required', true);

  try {
    if (id) {
      await api(`/proven-winners/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ name, description, default_format, default_classification }),
      });
      await api(`/proven-winners/${id}/active`, {
        method: 'PATCH',
        body: JSON.stringify({ active: document.getElementById('pw-active').checked }),
      });
    } else {
      const position = document.getElementById('pw-position').value;
      await api('/proven-winners', {
        method: 'POST',
        body: JSON.stringify({
          name, description, default_format, default_classification,
          position: position ? Number(position) : undefined,
        }),
      });
    }
    closeModal('pw-modal');
    toast('Proven Winner saved');
    refreshProvenWinners();
  } catch (e) {
    toast(e.message, true);
  }
}

async function deletePw() {
  const id = document.getElementById('pw-id').value;
  if (!id) return;
  if (!(await confirmDialog('Delete this Proven Winner? Concepts already used in drop plans keep their name/history and are not affected.'))) return;
  try {
    await api(`/proven-winners/${id}`, { method: 'DELETE' });
    closeModal('pw-modal');
    toast('Proven Winner deleted');
    refreshProvenWinners();
  } catch (e) {
    toast(e.message, true);
  }
}

document.getElementById('pw-add-btn').addEventListener('click', () => openPwModal(null));
document.getElementById('weekly-target-save-btn').addEventListener('click', saveWeeklyTarget);
document.getElementById('high-stock-min-soh-save-btn').addEventListener('click', saveHighStockMinSoh);
document.getElementById('default-shoot-top-size-save-btn').addEventListener('click', () => saveDefaultShootSize('top'));
document.getElementById('default-shoot-bottom-alpha-size-save-btn').addEventListener('click', () => saveDefaultShootSize('bottom_alpha'));
document.getElementById('default-shoot-bottom-waist-size-save-btn').addEventListener('click', () => saveDefaultShootSize('bottom_waist'));

// ── Settings: Content Creators ───────────────────────
// Fixed scales rather than free text -- keeps entries consistent and
// matches the case-insensitive comparison defaultSizeForColourway runs
// against each colourway's own resolved AM size list.
const TOP_SIZE_OPTIONS = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
const BOTTOM_ALPHA_SIZE_OPTIONS = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
const BOTTOM_WAIST_SIZE_OPTIONS = ['28', '30', '32', '34', '36', '38', '40'];

function sizeSelectHtml(id, options, currentValue) {
  const opts = ['<option value="">— none —</option>']
    .concat(options.map((s) => `<option value="${escapeHtml(s)}" ${s === currentValue ? 'selected' : ''}>${escapeHtml(s)}</option>`));
  return `<select class="cc-size-input" id="${id}">${opts.join('')}</select>`;
}

// Which creator rows currently have their sizes in edit mode -- rows
// default to a compact read-only summary + Edit button, matching the rest
// of this list's at-rest density; only the row being edited shows the 3
// dropdowns + Save Sizes.
let ccSizeEditIds = new Set();

function toggleContentCreatorSizeEdit(id) {
  if (ccSizeEditIds.has(id)) ccSizeEditIds.delete(id);
  else ccSizeEditIds.add(id);
  renderContentCreators();
}

function contentCreatorSizesSummaryHtml(c) {
  const parts = [
    ['Top', c.default_top_size],
    ['Bottom (Alpha)', c.default_bottom_alpha_size],
    ['Bottom (Waist)', c.default_bottom_waist_size],
  ];
  if (!parts.some(([, v]) => v)) return '<span class="cc-sizes-summary hint">No sizes set</span>';
  return `<span class="cc-sizes-summary">${parts.map(([label, v]) => `${label}: ${v ? escapeHtml(v) : '—'}`).join(' · ')}</span>`;
}

function renderContentCreators() {
  const list = document.getElementById('cc-list');
  if (!state.contentCreators.length) {
    list.innerHTML = '<div class="attention-empty">No content creators yet — add one below.</div>';
    return;
  }
  list.innerHTML = state.contentCreators.map((c) => `
    <div class="cc-row">
      <div class="cc-row-main">
        <span class="cc-name">${escapeHtml(c.name)}</span>
        ${c.is_default
          ? '<span class="badge badge-tested_proven">Default</span>'
          : `<button type="button" class="btn btn-ghost btn-sm" onclick="setDefaultContentCreator(${c.id})">Set Default</button>`}
        <button type="button" class="btn btn-ghost btn-sm" onclick="deleteContentCreator(${c.id})">Remove</button>
      </div>
      <div class="cc-row-sizes">
        ${ccSizeEditIds.has(c.id) ? `
          <label>Top ${sizeSelectHtml(`cc-size-top-${c.id}`, TOP_SIZE_OPTIONS, c.default_top_size)}</label>
          <label>Bottom (Alpha) ${sizeSelectHtml(`cc-size-bottom-alpha-${c.id}`, BOTTOM_ALPHA_SIZE_OPTIONS, c.default_bottom_alpha_size)}</label>
          <label>Bottom (Waist) ${sizeSelectHtml(`cc-size-bottom-waist-${c.id}`, BOTTOM_WAIST_SIZE_OPTIONS, c.default_bottom_waist_size)}</label>
          <button type="button" class="btn btn-primary btn-sm" onclick="saveContentCreatorSizes(${c.id})">Save Sizes</button>
        ` : `
          ${contentCreatorSizesSummaryHtml(c)}
          <button type="button" class="btn btn-ghost btn-sm" onclick="toggleContentCreatorSizeEdit(${c.id})">Edit</button>
        `}
      </div>
    </div>
  `).join('');
}

async function refreshContentCreators() {
  state.contentCreators = await api('/content-creators');
  renderContentCreators();
}

async function addContentCreator() {
  const input = document.getElementById('cc-new-name');
  const name = input.value.trim();
  if (!name) return toast('Name is required', true);
  try {
    await api('/content-creators', { method: 'POST', body: JSON.stringify({ name }) });
    input.value = '';
    toast('Content creator added');
    refreshContentCreators();
  } catch (e) {
    toast(e.message, true);
  }
}

async function setDefaultContentCreator(id) {
  try {
    state.contentCreators = await api(`/content-creators/${id}/default`, { method: 'PUT' });
    renderContentCreators();
  } catch (e) {
    toast(e.message, true);
  }
}

async function saveContentCreatorSizes(id) {
  const payload = {
    default_top_size: document.getElementById(`cc-size-top-${id}`).value.trim() || null,
    default_bottom_alpha_size: document.getElementById(`cc-size-bottom-alpha-${id}`).value.trim() || null,
    default_bottom_waist_size: document.getElementById(`cc-size-bottom-waist-${id}`).value.trim() || null,
  };
  try {
    const updated = await api(`/content-creators/${id}/sizes`, { method: 'PUT', body: JSON.stringify(payload) });
    state.contentCreators = state.contentCreators.map((c) => (c.id === id ? updated : c));
    ccSizeEditIds.delete(id);
    renderContentCreators();
    toast('Sizes saved');
  } catch (e) {
    toast(e.message, true);
  }
}

async function deleteContentCreator(id) {
  if (!(await confirmDialog('Remove this content creator? This does not affect any past Shoot This Week items already recorded with their name.'))) return;
  try {
    await api(`/content-creators/${id}`, { method: 'DELETE' });
    toast('Content creator removed');
    refreshContentCreators();
  } catch (e) {
    toast(e.message, true);
  }
}

document.getElementById('cc-add-btn').addEventListener('click', addContentCreator);
document.getElementById('cc-new-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addContentCreator();
});

// ── Settings: Meta Product Mapping ───────────────────
// Meta's ad names (Product + Product Type) don't always match the
// ApparelMagic/internal product name -- see schema.sql's comment on
// meta_product_mappings for the full rationale. This is the admin side of
// that lookup: review what's already mapped, resolve anything still
// Unmapped by picking its internal product family, and a "Check Mapping"
// tool to try a raw ad name (or an already-split Product + Product Type)
// against it directly -- which also records a brand-new combination as
// Unmapped so it shows up in the list below rather than only existing
// transiently in the check result.
function mpmStatusBadge(m) {
  return m.product_code
    ? `<span class="badge badge-tested_proven">Mapped &rarr; ${escapeHtml(m.product_name)}</span>`
    : '<span class="badge badge-unmapped">Unmapped</span>';
}

function metaProductMappingRowHtml(m) {
  const familyOptions = state.metaProductFamilies
    .map((f) => `<option value="${escapeHtml(f.product_code)}">${escapeHtml(f.product_name)}</option>`)
    .join('');
  return `
    <div class="mpm-row">
      <div class="mpm-row-main">
        <span class="mpm-combo">${escapeHtml(m.meta_product)} <span class="mpm-combo-sep">+</span> ${escapeHtml(m.meta_product_type)}</span>
        ${mpmStatusBadge(m)}
        <button type="button" class="btn btn-ghost btn-sm" onclick="deleteMetaProductMapping(${m.id})">Remove</button>
      </div>
      ${!m.product_code ? `
        <div class="mpm-resolve-row">
          <select id="mpm-resolve-${m.id}">
            <option value="">— select internal product family —</option>
            ${familyOptions}
          </select>
          <button type="button" class="btn btn-primary btn-sm" onclick="resolveMetaProductMapping(${m.id})">Map</button>
        </div>` : ''}
    </div>`;
}

function renderMetaProductMappings() {
  const list = document.getElementById('mpm-list');
  list.innerHTML = state.metaProductMappings.length
    ? state.metaProductMappings.map(metaProductMappingRowHtml).join('')
    : '<div class="attention-empty">No Meta Product Mappings yet — use "Check Mapping" above to look up your first ad name.</div>';
}

async function refreshMetaProductMappings() {
  state.metaProductMappings = await api('/meta-product-mappings');
  renderMetaProductMappings();
}

function renderMpmCheckResult(mapping, batchNo) {
  const el = document.getElementById('mpm-check-result');
  if (!mapping) { el.innerHTML = ''; return; }
  const batchLine = batchNo ? `<span class="admin-note">Batch No. ${escapeHtml(batchNo)} (metadata only — not used for attribution)</span>` : '';
  const statusLine = mapping.product_code
    ? mpmStatusBadge(mapping)
    : '<span class="badge badge-unmapped">Unmapped — resolve it in the list below</span>';
  el.innerHTML = `
    <div class="mpm-check-result-card">
      <span class="mpm-combo">${escapeHtml(mapping.meta_product)} <span class="mpm-combo-sep">+</span> ${escapeHtml(mapping.meta_product_type)}</span>
      ${statusLine}
      ${batchLine}
    </div>`;
}

async function checkMetaProductMapping() {
  const input = document.getElementById('mpm-check-input');
  const adName = input.value.trim();
  if (!adName) return toast('Enter a Meta ad name to check', true);
  try {
    const { mapping, batch_no } = await api('/meta-product-mappings/check', {
      method: 'POST',
      body: JSON.stringify({ ad_name: adName }),
    });
    renderMpmCheckResult(mapping, batch_no);
    await refreshMetaProductMappings();
  } catch (e) {
    toast(e.message, true);
  }
}

async function resolveMetaProductMapping(id) {
  const sel = document.getElementById(`mpm-resolve-${id}`);
  const productCode = sel.value;
  if (!productCode) return toast('Select which internal product family this maps to', true);
  const family = state.metaProductFamilies.find((f) => f.product_code === productCode);
  try {
    await api(`/meta-product-mappings/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ product_code: productCode, product_name: family ? family.product_name : productCode }),
    });
    toast('Mapping saved');
    renderMpmCheckResult(null);
    await refreshMetaProductMappings();
  } catch (e) {
    toast(e.message, true);
  }
}

async function deleteMetaProductMapping(id) {
  if (!(await confirmDialog('Remove this mapping? A future ad with this exact Product + Product Type will show as Unmapped again.'))) return;
  try {
    await api(`/meta-product-mappings/${id}`, { method: 'DELETE' });
    toast('Mapping removed');
    renderMpmCheckResult(null);
    await refreshMetaProductMappings();
  } catch (e) {
    toast(e.message, true);
  }
}

document.getElementById('mpm-check-btn').addEventListener('click', checkMetaProductMapping);
document.getElementById('mpm-check-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') checkMetaProductMapping();
});

document.querySelectorAll('.core-view-btn').forEach((btn) => {
  btn.addEventListener('click', () => setCoreView(btn.dataset.view));
});
document.getElementById('core-view-all-btn').addEventListener('click', toggleCoreAllProducts);

checkSession();
