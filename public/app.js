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
  currentUser: null,
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
  // Tuesday Review's own week nav -- independent from conceptDev's, same
  // reasoning as above. data is the exact same GET /concept-development
  // payload Concept Dev uses (products -> concepts); filter is the landing
  // page's status filter (defaults to ready_for_review, the actual meeting
  // queue). queue/queueIndex track the flat, filter-scoped concept list the
  // review modal's Previous/Next and auto-advance walk through -- see
  // buildTuesdayReviewQueue in app.js.
  tuesdayReview: { weekOffset: 0, data: null, filter: 'ready_for_review', queue: [], queueIndex: -1 },
  // Settings' configurable link-out resources (Meta Ad Library etc, seeded
  // by default) -- see the Creative Toolkit section below. The ChatGPT
  // Develop/Improve and Proven Winners cards are NOT in this list; they
  // have real app logic (context-aware prompts, an internal view) a plain
  // name/url resource can't represent, so they stay fixed toolkit cards.
  creativeResources: [],
  // Which product/concept the context-aware Creative Tools modal was
  // opened from -- drives the ChatGPT prompts and which of the two action
  // sets (product-level vs. concept-level) is shown. Unused by the global
  // Creative Toolkit drawer, which never needs a product/concept in view.
  creativeToolkit: { shootPlanItemId: null, conceptId: null },
  // Reference Library -- the shared reference_library table, lazy-loaded
  // like creativeResources above (see ensureReferenceLibraryLoaded). filter
  // is the All/BAU/Sale tab; pickerMode is true when the modal was opened
  // from a Concept's own References section (openReferenceLibraryPicker)
  // instead of from a Creative Toolkit/Tools card -- same list, but cards
  // offer "Use This Reference" instead of the ••• edit/delete menu.
  referenceLibrary: [], referenceLibraryLoaded: false, referenceLibraryFilter: 'all', referencePickerFilter: 'all',
  referenceLibraryCategories: [], referenceLibraryCategoriesLoaded: false, referenceLibrarySort: 'newest',
  // Settings' reusable Customer Avatar library -- who Concept Development's
  // "The Audience" section picks a Primary Customer Avatar from. See
  // schema.sql's comment on customer_avatars/customer_avatar_id.
  customerAvatars: [],
  // Shooting's own week nav, independent of every other tab's for the same
  // reason as conceptDev/tuesdayReview above. view is which of the three
  // (Week/Today/History) is showing; data is Week's own GET /shooting
  // response; todayData is a SEPARATE fetch of whatever week today's real
  // calendar date falls in (never the same as the week being browsed in
  // Week view); historyData is History's own GET /shooting/history.
  // ownerFilter is shared across Week/Today (client-side only, no refetch).
  shooting: { view: 'week', weekOffset: 0, data: null, todayData: null, historyData: null, ownerFilter: 'all', briefScheduleId: null, dragScheduleId: null },
  // Editing -- same independent-weekOffset pattern as conceptDev/
  // tuesdayReview/shooting above. data is Week's own GET /editing response
  // (Concepts already nested with their Final Edits); activeConceptAssetId/
  // activeFinalEditId track which modal is currently open so save handlers
  // know what they're writing to; createRows is the "+ Add Another Asset"
  // custom rows in the Create Final Edits flow, reset each time that modal
  // opens.
  editing: { weekOffset: 0, data: null, filter: 'all', activeConceptAssetId: null, activeFinalEditId: null, createRows: [] },
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
  const email = document.getElementById('pw-email').value;
  const password = document.getElementById('pw-input').value;
  const errEl = document.getElementById('pw-error');
  try {
    const { user } = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    errEl.classList.remove('show');
    state.currentUser = user;
    showApp();
  } catch (e) {
    errEl.classList.add('show');
  }
}

async function logout() {
  await api('/auth/logout', { method: 'POST' });
  state.currentUser = null;
  showPasswordScreen();
}

function showPasswordScreen() {
  document.getElementById('password-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  document.getElementById('pw-input').value = '';
}

function renderSidebarUser() {
  const el = document.getElementById('sidebar-user');
  if (!el) return;
  el.innerHTML = state.currentUser
    ? `${escapeHtml(state.currentUser.name)} <span class="sidebar-user-role">· ${escapeHtml(state.currentUser.role)}</span>`
    : '';
}

function showApp() {
  document.getElementById('password-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  renderSidebarUser();
  loadAll();
}

async function checkSession() {
  try {
    const { authenticated, user } = await api('/auth/session');
    if (authenticated) {
      state.currentUser = user;
      showApp();
    } else {
      showPasswordScreen();
    }
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
  // Shooting is the direct downstream consumer of an action just taken on
  // Tuesday Review (Approve for Shooting) -- unlike every other tab, it
  // needs a fresh fetch on every visit so a concept approved a moment ago
  // reliably shows up without a full page reload.
  if (name === 'shooting') refreshCurrentShootingView();
  if (name === 'reference-library') loadReferenceLibraryPage();
  // Same reasoning as Shooting above -- Editing is the direct downstream
  // consumer of Shooting's Mark as Shot action, so it needs a fresh fetch
  // on every visit too.
  if (name === 'editing') loadEditingWeek();
}

// [data-tab] guard: the sidebar also holds non-tab .tab-btn entries (styled
// the same, but opening a modal via their own onclick instead of switching
// a panel -- see the Reference Library link in index.html), which must not
// get wired into switchTab.
document.querySelectorAll('.tab-btn[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// Settings sub-nav: the same switch-a-panel pattern as the top-level tabs
// above, just nested one level -- Settings had grown to 8 sections on one
// long scroll, so they're grouped into 4 themed panels instead.
function switchSettingsPanel(name) {
  document.querySelectorAll('.settings-subnav-btn').forEach((b) => b.classList.toggle('active', b.dataset.settingsPanel === name));
  document.querySelectorAll('.settings-panel').forEach((p) => p.classList.toggle('active', p.id === `settings-panel-${name}`));
}

document.querySelectorAll('.settings-subnav-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchSettingsPanel(btn.dataset.settingsPanel));
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
    const [board, styles, categories, dashboard, dropsRes, provenWinners, coreRes, planningSettings, shootPlan, contentCreators, highStockRes, promotions, weeklyConfirmation, weeklyPlanningProgress, salesCadence, metaProductMappings, metaProductFamilies, conceptDev, creativeResources, customerAvatars, tuesdayReview, shootingWeek, editingWeek] = await Promise.all([
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
      api('/creative-resources'),
      api('/customer-avatars'),
      api(`/concept-development?week_start=${tuesdayReviewWeekStart()}`),
      api(`/shooting?week_start=${shootingWeekStart()}`),
      api(`/editing?week_start=${editingWeekStart()}`),
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
    state.creativeResources = creativeResources;
    state.customerAvatars = customerAvatars;
    state.tuesdayReview.data = tuesdayReview;
    state.tuesdayReview.filter = tuesdayReviewDefaultFilter();
    state.shooting.data = shootingWeek;
    state.editing.data = editingWeek;
    renderBoard();
    renderMissingAd();
    renderStylesTable();
    renderCategoriesTable();
    populateStyleSelect();
    populateCategorySelect();
    renderDashboard();
    renderPlanning();
    renderProvenWinners();
    renderCreativeResourcesSettings();
    renderCustomerAvatarsSettings();
    renderCoreProducts();
    renderPlanningSettingsForm();
    renderContentCreators();
    renderMetaProductMappings();
    renderHighStockProducts();
    renderPromotionsRow();
    renderPlanningShootSummary();
    renderConceptDevWeekHeader();
    renderConceptDevList();
    renderTuesdayReviewWeekHeader();
    renderTuesdayReviewList();
    populateShootingOwnerFilters();
    renderShootingWeekHeader();
    renderShootingWeekView();
    renderEditingWeekHeader();
    renderEditingList();
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
            <div class="core-weekly-label">Weekly Creative Target</div>
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
      <div class="core-weekly-footer">Counts new concepts approved for shooting in Tuesday Review — Proven Winner concepts don't count</div>`;
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
  killed: 'Killed',
};
const CONCEPT_DEV_STATUS_CLASS = {
  not_started: 'cd-status-not-started',
  in_development: 'cd-status-in-development',
  ready_for_review: 'cd-status-ready-for-review',
  changes_required: 'cd-status-changes-required',
  approved: 'cd-status-approved',
  killed: 'cd-status-killed',
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

// Only non-zero statuses are worth a pill -- a "0 Ready for Review" chip
// on a product with nothing started yet is noise, not information. Order
// is fixed (matches CONCEPT_DEV_STATUS_LABELS' rough workflow order) so
// cards with the same mix of statuses always read the same left-to-right.
const CONCEPT_DEV_STATUS_ORDER = ['not_started', 'in_development', 'changes_required', 'ready_for_review', 'approved', 'killed'];
function conceptDevStatusBreakdown(concepts) {
  return CONCEPT_DEV_STATUS_ORDER
    .map((status) => ({ status, count: concepts.filter((c) => c.concept_dev_status === status).length }))
    .filter((s) => s.count > 0);
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

// A Drop product's pathway badge shows its already-assigned Proven
// coverage instead of the generic "Proven Concepts Assigned" phrase, so
// the distinction from the New Concepts below it is explicit rather than
// implied: Proven Coverage is existing creative that already exists,
// Concept Development is for genuinely new ideas. Every other source keeps
// its normal pathway label, untouched.
function conceptDevPathwayBadgeLabel(product) {
  if (product.source === 'drop') return `Proven Coverage: ${product.proven_coverage_count || 0}`;
  return CONCEPT_DEV_PATHWAY_LABELS[product.source] || shootPlanRequirementLabel(product);
}

// State-aware CTA -- the same "Develop Concepts" label on every card told
// the creator nothing about what they'd find behind it. This mirrors
// conceptDevProductBucket's own three-way read of a product's concepts.
function conceptDevProductCtaLabel(product) {
  if (!product.concepts.length) return 'Develop First Concept';
  return conceptDevProductBucket(product) === 'needs_development' ? 'Open Concepts' : 'View Concepts';
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
  const count = product.concepts.length;
  const breakdown = conceptDevStatusBreakdown(product.concepts);
  return `
    <div class="cd-card" onclick="openConceptDevProduct(${product.shoot_plan_item_id})">
      <div class="cd-card-top">
        ${thumb}
        <div class="cd-card-name">${escapeHtml(product.product_name)}</div>
      </div>
      <div class="cd-card-badges">
        <span class="cd-badge">${escapeHtml(sourceLabel)}</span>
        <span class="cd-badge cd-badge-pathway">${escapeHtml(conceptDevPathwayBadgeLabel(product))}</span>
      </div>
      <div class="cd-card-count">${count ? `${count} New Concept${count === 1 ? '' : 's'}` : 'No new concepts yet'}</div>
      ${breakdown.length ? `<div class="cd-card-status-row">${breakdown.map((s) => `<span class="cd-concept-status-pill ${CONCEPT_DEV_STATUS_CLASS[s.status] || ''}">${s.count} ${CONCEPT_DEV_STATUS_LABELS[s.status] || s.status}</span>`).join('')}</div>` : ''}
      <div class="cd-card-meta">${product.colourways.length} Colourway${product.colourways.length === 1 ? '' : 's'} &middot; Owner: ${escapeHtml(product.creator || '—')}</div>
      <div class="cd-card-action">${conceptDevProductCtaLabel(product)} &rarr;</div>
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

// No "Approved" tab here -- Concept Development is the active workspace
// for concepts still being developed or submitted; an approved concept has
// already moved past this stage (Tuesday Review is where approval
// happens), so it doesn't need its own primary filter. It's still counted
// in "All" for context/history, and the status itself is unchanged.
const CONCEPT_DEV_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'needs_development', label: 'Needs Development' },
  { key: 'ready_for_review', label: 'Ready for Review' },
];

// Same quiet tab-bar language as Tuesday Review's status filters -- these
// are product-bucket navigation, not primary actions, so no teal fill.
function conceptDevFilterCounts(data) {
  const buckets = data.products.map((p) => conceptDevProductBucket(p));
  return {
    all: buckets.length,
    needs_development: buckets.filter((b) => b === 'needs_development').length,
    ready_for_review: buckets.filter((b) => b === 'ready_for_review').length,
    approved: buckets.filter((b) => b === 'approved').length,
  };
}

function conceptDevFiltersHtml(data) {
  const counts = conceptDevFilterCounts(data);
  return `
    <div class="filter-tabs">
      ${CONCEPT_DEV_FILTERS.map((f) => `
        <button type="button" class="filter-tab ${state.conceptDev.filter === f.key ? 'active' : ''}" onclick="setConceptDevFilter('${f.key}')">${escapeHtml(f.label)} <span class="filter-tab-count">${counts[f.key]}</span></button>`).join('')}
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
          <span>${escapeHtml(conceptDevPathwayBadgeLabel(product))}</span>
          <span>&middot;</span>
          <span>Owner: ${escapeHtml(product.creator || '—')}</span>
          <span>&middot;</span>
          <span>${count} New Concept${count === 1 ? '' : 's'}</span>
        </div>
        <div class="shoot-plan-style-chips">${chips}</div>
        ${product.initial_idea ? `<div class="shoot-plan-idea">💡 ${escapeHtml(product.initial_idea)}</div>` : ''}
      </div>
    </div>`;
}

// State-aware so the card tells the creator what clicking it will actually
// do: still-being-developed concepts get "Continue", Changes Required gets
// "Update" (there's specific feedback waiting), anything already decided
// (Ready for Review, Approved, Killed) is read-only from here on out, so
// it's "View" -- deliberately never "Open" for Approved, which would imply
// it's still active work rather than a finished, handed-off brief.
function conceptDevConceptCtaLabel(status) {
  if (status === 'changes_required') return 'Update Concept';
  if (status === 'ready_for_review' || status === 'approved' || status === 'killed') return 'View Concept';
  return 'Continue Concept';
}

// Compact card, not a thin row -- shows just enough to decide what to open
// next: name/locked-tag/status, plus whether a Hook and a Reference have
// already been added (the two fields that most determine "is this actually
// ready to shoot", so they're worth surfacing without opening the concept).
// The top-right X is a quick-delete shortcut for the same deletable-here
// concepts the modal's own Delete button covers (see deleteConceptDevConcept)
// -- hidden for a Drop's Required Concept slots, same reasoning as there.
function conceptDevConceptCardHtml(concept, productSource) {
  const hasHook = Array.isArray(concept.hook_variations) && concept.hook_variations.some((h) => h.text && h.text.trim());
  const hasReference = Array.isArray(concept.reference_items) && concept.reference_items.length > 0;
  const removeBtn = productSource !== 'drop'
    ? `<button type="button" class="cd-concept-card-remove" onclick="event.stopPropagation(); deleteConceptDevConceptCard(${concept.id})" aria-label="Delete concept" title="Delete concept">&times;</button>`
    : '';
  return `
    <div class="cd-concept-card" onclick="openConceptDevModal(${concept.id})">
      ${removeBtn}
      <div class="cd-concept-card-top">
        <span class="cd-concept-card-name">${escapeHtml(concept.concept_name)}</span>
        ${concept.name_locked ? '<span class="cd-locked-tag">Proven</span>' : ''}
      </div>
      <span class="cd-concept-status-pill ${CONCEPT_DEV_STATUS_CLASS[concept.concept_dev_status] || ''}">${CONCEPT_DEV_STATUS_LABELS[concept.concept_dev_status] || concept.concept_dev_status}</span>
      <div class="cd-concept-card-flags">
        <span class="${hasHook ? 'cd-concept-flag-on' : 'cd-concept-flag-off'}">${hasHook ? '✓' : '—'} Hook</span>
        <span class="${hasReference ? 'cd-concept-flag-on' : 'cd-concept-flag-off'}">${hasReference ? '✓' : '—'} Reference</span>
      </div>
      <div class="cd-concept-card-action">${conceptDevConceptCtaLabel(concept.concept_dev_status)} &rarr;</div>
    </div>`;
}

// "What NEW concepts do I need to develop for this product?" -- concept
// cards stay compact (name/locked-tag/status/hook+reference flags only);
// the full Concept Details/References/Shoot Requirements form only appears
// once one is opened (openConceptDevModal). For an Upcoming Drop, this
// workspace only ever holds concepts genuinely being developed here (the
// backend already excludes assigned Proven Winner slots entirely -- see
// GET /concept-development) -- their existing Proven creative coverage
// stays exactly where it's tracked (the drop's own Required Concepts
// plan/Planning product page), it's just not duplicated into this list.
// "+ New Concept" is the same primary action for every source now. The
// toolbar row leads with a plain "New Concepts" heading so this workspace
// reads unambiguously as the new-concepts view -- Creative Tools is
// supporting/reference functionality, so it stays a quiet secondary link
// even though it now sits alongside the primary button instead of on its
// own line above it (where it was reading as if it were the section title).
function renderConceptDevProductWorkspace(product) {
  return `
    <button type="button" class="link-btn cd-back-link" onclick="closeConceptDevProduct()">&larr; Back to Products</button>
    ${conceptDevWorkspaceHeaderHtml(product)}
    <div class="cd-workspace-toolbar">
      <div class="cd-workspace-toolbar-heading">New Concepts</div>
      <div class="cd-workspace-toolbar-actions">
        <button type="button" class="link-btn cd-need-inspiration" onclick="openCreativeTools(${product.shoot_plan_item_id})">Creative Tools &#9662;</button>
        <button type="button" class="btn btn-primary btn-sm cd-new-concept-btn" onclick="openAddConceptModal(${product.shoot_plan_item_id})">+ New Concept</button>
      </div>
    </div>
    <div class="cd-concept-grid">
      ${product.concepts.length ? product.concepts.map((c) => conceptDevConceptCardHtml(c, product.source)).join('') : '<div class="attention-empty">No new concepts yet</div>'}
    </div>
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
    ${conceptDevFiltersHtml(data)}
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
// Once a concept has been Approved in Tuesday Review, it's the final brief
// moving into production -- the modal opens read-only by default so it
// can't be edited by accident, with "Edit Approved Concept" (behind a
// confirmation) as the deliberate, subtle way back into editing. Reset by
// every fillConceptDevModalFields call, so it never leaks between concepts.
let conceptDevModalReadOnly = false;

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
      <label>${i === 0 ? 'Primary Hook / Opening' : `Alternative Hook ${i + 1}`}
        <textarea rows="2" oninput="conceptDevModalHooks[${i}].text=this.value" placeholder="${i === 0 ? 'Describe the opening — dialogue, on-screen text, visual moment, action, reveal, etc.' : 'A different opening for the same concept'}">${escapeHtml(h.text)}</textarea>
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
  document.getElementById('cd-modal-references-list').innerHTML = conceptDevModalReferences.map((r, i) => `
    <div class="cd-reference-item">
      <div class="cd-reference-item-row">
        ${r.library_reference_id ? '<span class="cd-reference-library-tag">📚 From Library</span>' : ''}
        <input type="text" value="${escapeHtml(r.url)}" oninput="conceptDevModalReferences[${i}].url=this.value" placeholder="Reference link">
        <button type="button" class="cd-reference-remove" onclick="removeConceptDevReference(${i})" aria-label="Remove reference">&times;</button>
      </div>
      <textarea rows="2" oninput="conceptDevModalReferences[${i}].note=this.value" placeholder="What do we like about it?">${escapeHtml(r.note)}</textarea>
    </div>`).join('');
}

// References defaults to the same compact collapsed state as Script/Shoot
// Requirements -- an empty optional field shouldn't carry a big grey card's
// worth of visual weight. Unlike those two it's a repeatable list, so both
// the collapsed and expanded "+ Add Reference" triggers call the same
// addConceptDevReference(), and removing the last reference collapses the
// section back down rather than leaving an empty expanded list showing.
function setConceptDevReferencesExpanded(expanded) {
  document.getElementById('cd-modal-references-toggle-wrap').style.display = expanded ? 'none' : '';
  document.getElementById('cd-modal-references-list').style.display = expanded ? '' : 'none';
  document.getElementById('cd-modal-references-actions').style.display = expanded ? '' : 'none';
}

function addConceptDevReference() {
  conceptDevModalReferences.push({ url: '', note: '' });
  renderConceptDevModalReferences();
  setConceptDevReferencesExpanded(true);
  const inputs = document.querySelectorAll('#cd-modal-references-list .cd-reference-item-row input');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function removeConceptDevReference(index) {
  conceptDevModalReferences.splice(index, 1);
  renderConceptDevModalReferences();
  if (!conceptDevModalReferences.length) setConceptDevReferencesExpanded(false);
}

// Read-only Planning-handoff context shown at the top of the workspace --
// product/source/pathway/owner/colourways -- so the creator always has
// what they need to prep execution without leaving the modal or
// re-entering anything. Deliberately compact (one line, two if there's an
// initial idea from Planning) -- the creative-development fields are the
// point of this workspace, not the context banner, so it shouldn't
// compete for vertical space with them.
function conceptDevModalContextHtml(product) {
  const thumb = product.image_url
    ? `<img class="cd-modal-context-thumb" src="${product.image_url}" alt="">`
    : '<span class="cd-modal-context-thumb cd-modal-context-noimg">🖼</span>';
  const sourceLabel = CONCEPT_DEV_SOURCE_LABELS[product.source] || product.source || '—';
  const pathwayLabel = conceptDevPathwayBadgeLabel(product);
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

// The Audience's Customer Avatar dropdown -- rebuilt fresh every time the
// concept modal opens (and after "Save as new Customer Avatar" adds one)
// from state.customerAvatars, plus the fixed trailing "+ Other / New
// Avatar" option. selectedAvatarId keeps a disabled-but-still-selected
// avatar's option in the list (rather than having it silently vanish)
// so an existing concept never loses track of what it's actually set to.
function renderConceptDevAvatarOptions(selectedAvatarId) {
  const select = document.getElementById('cd-modal-avatar-select');
  const options = state.customerAvatars.filter((a) => a.enabled || a.id === selectedAvatarId);
  select.innerHTML = [
    '<option value="">Select an avatar…</option>',
    ...options.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}${a.enabled ? '' : ' (disabled)'}</option>`),
    '<option value="__other__">+ Other / New Avatar</option>',
  ].join('');
}

// Toggles "Who are you targeting?" and swaps the "Why will they care?"
// placeholder between the two modes -- one shared field either way (see
// the HTML comment on cd-modal-audience-section), never two parallel
// "why care" fields to keep in sync.
function onConceptDevAvatarChange() {
  const select = document.getElementById('cd-modal-avatar-select');
  const isOther = select.value === '__other__';
  document.getElementById('cd-modal-avatar-custom-wrap').style.display = isOther ? '' : 'none';
  document.getElementById('cd-modal-avatar-why-care').placeholder = isOther
    ? 'Why should this person care about this product or creative idea?'
    : 'What makes this product or concept relevant to this person?';
  select.classList.remove('cd-field-invalid');
  document.getElementById('cd-modal-avatar-custom-desc').classList.remove('cd-field-invalid');
  hideConceptDevFieldError('cd-modal-avatar-select-error');
  hideConceptDevFieldError('cd-modal-avatar-custom-desc-error');
  updateReviewPromptGate();
}

// Called after "Save as new Customer Avatar" (see openSaveAvatarFromConceptModal
// and saveCa's caModalReturnToConceptDev handling) creates the avatar --
// switches the concept modal straight over from "+ Other / New Avatar" to
// the newly-saved avatar, already selected.
function selectConceptDevAvatar(avatarId) {
  const select = document.getElementById('cd-modal-avatar-select');
  if (!select) return;
  renderConceptDevAvatarOptions(avatarId);
  select.value = String(avatarId);
  onConceptDevAvatarChange();
}

// The "+ Other / New Avatar" description is a one-off by default (per the
// brief, never auto-added to the library) -- this is the opt-in path,
// reusing the same Settings ca-modal rather than a third form surface.
// Pre-fills "Who are they?" from what's already been typed as a starting
// point; the creator still has to name it and fill in the rest themselves.
function openSaveAvatarFromConceptModal() {
  const description = document.getElementById('cd-modal-avatar-custom-desc').value.trim();
  openCaModal(null, { who: description });
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
  setConceptDevReferencesExpanded(conceptDevModalReferences.length > 0);

  // The Audience: exactly one of customer_avatar_id / custom_avatar_description
  // is ever set (see schema.sql's comment) -- the select reflects whichever
  // one this concept actually has, or blank for a brand-new concept.
  renderConceptDevAvatarOptions(concept ? concept.customer_avatar_id : null);
  const avatarSelect = document.getElementById('cd-modal-avatar-select');
  if (concept && concept.customer_avatar_id) {
    avatarSelect.value = String(concept.customer_avatar_id);
  } else if (concept && concept.custom_avatar_description) {
    avatarSelect.value = '__other__';
  } else {
    avatarSelect.value = '';
  }
  document.getElementById('cd-modal-avatar-why-care').value = concept ? (concept.avatar_why_care || '') : '';
  document.getElementById('cd-modal-avatar-custom-desc').value = concept ? (concept.custom_avatar_description || '') : '';
  onConceptDevAvatarChange();

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

  const feedbackBanner = document.getElementById('cd-changes-required-banner');
  if (status === 'changes_required' && concept && concept.review_feedback) {
    feedbackBanner.style.display = '';
    document.getElementById('cd-changes-required-text').textContent = concept.review_feedback;
  } else {
    feedbackBanner.style.display = 'none';
  }

  // Approved concepts default to read-only -- see conceptDevModalReadOnly's
  // own comment. A brand-new concept (concept === null) is never Approved,
  // so this only ever engages when reopening an already-decided one.
  setConceptDevModalReadOnly(status === 'approved');

  // Progressive disclosure: Script and Shoot Requirements stay collapsed
  // behind a toggle for the common case (a simple concept doesn't need
  // either), but open automatically if the concept already has content
  // there -- a creator revisiting it should never have to go hunting for
  // information that's already been entered.
  setConceptDevScriptExpanded(Boolean(concept && concept.script_notes));
  setConceptDevShootRequirementsExpanded(Boolean(
    concept && (concept.talent_requirement || concept.location || concept.props_notes)
  ));

  updateReviewPromptGate();
  hideConceptDevValidation();
}

// Toggles the modal between its normal editable state and the read-only
// view an Approved concept opens into. Disables every real input (so
// nothing can be typed into by accident, keyboard tab included) and hides
// every action that mutates the concept -- Save Draft/Save Changes/Ready
// for Review/Resubmit, Delete, and the hook/reference add-remove controls
// (hidden via the .cd-readonly CSS, since those are re-rendered fresh on
// every open and wouldn't otherwise pick up a one-off disabled flag).
// Creative Tools stays available either way -- browsing references or
// running the AI Creative Review doesn't edit the concept.
function setConceptDevModalReadOnly(readOnly) {
  conceptDevModalReadOnly = readOnly;
  const modalEl = document.querySelector('#concept-dev-modal .modal');
  modalEl.classList.toggle('cd-readonly', readOnly);
  modalEl.querySelectorAll('.modal-body input, .modal-body textarea, .modal-body select').forEach((el) => {
    el.disabled = readOnly;
  });
  document.getElementById('cd-approved-banner').style.display = readOnly ? '' : 'none';
  if (readOnly) {
    document.getElementById('cd-modal-save-draft-btn').style.display = 'none';
    document.getElementById('cd-modal-save-changes-btn').style.display = 'none';
    document.getElementById('cd-modal-submit-btn').style.display = 'none';
    document.getElementById('cd-modal-delete-btn').style.display = 'none';
  } else if (conceptDevModalConceptId) {
    // Restore the footer/delete state that actually applies to this
    // concept's status/source -- covers both a normal (never-locked) open
    // and unlocking edit on a previously read-only Approved concept.
    const found = findConceptDevConcept(conceptDevModalConceptId);
    if (found) {
      updateConceptDevFooterButtons(found.concept.concept_dev_status);
      document.getElementById('cd-modal-delete-btn').style.display = found.product.source === 'drop' ? 'none' : '';
    }
  }
}

// The one deliberate way back into editing an Approved concept -- a plain
// confirmation, not another status change (see the brief: approval logic
// itself is untouched here, this only ever toggles the read-only view).
async function confirmEditApprovedConcept() {
  const confirmed = await confirmDialog(
    'This concept has already been approved for shooting. Editing the concept may change the brief that was approved during Tuesday Review.',
    { okLabel: 'Edit Anyway' }
  );
  if (!confirmed) return;
  setConceptDevModalReadOnly(false);
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

// Required-field ids Ready for Review validates -- kept as one list so the
// clear-all-errors path, the field-order walked to focus the first missing
// one, and the individual error-message ids below all stay in sync.
const CD_REQUIRED_FIELD_IDS = [
  'cd-modal-name', 'cd-modal-angle', 'cd-modal-avatar-select',
  'cd-modal-avatar-custom-desc', 'cd-modal-avatar-why-care', 'cd-modal-execution',
];

function hideConceptDevFieldError(errorId) {
  const el = document.getElementById(errorId);
  if (!el) return;
  el.classList.remove('show');
  el.textContent = '';
}

function showConceptDevFieldError(fieldId, errorId, message) {
  document.getElementById(fieldId).classList.add('cd-field-invalid');
  const el = document.getElementById(errorId);
  el.textContent = message;
  el.classList.add('show');
}

function hideConceptDevValidation() {
  for (const fieldId of CD_REQUIRED_FIELD_IDS) {
    document.getElementById(fieldId).classList.remove('cd-field-invalid');
    hideConceptDevFieldError(`${fieldId}-error`);
  }
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

  // Delete only offered for a concept that's actually deletable this way:
  // a Drop's concepts are Required Concept slots (Proven Winner or a
  // manually-added "new" one) -- deleting the underlying creative_asset
  // here would just null out the slot's fulfilled_by_asset_id and leave an
  // orphaned, invisible slot behind, not remove the concept the creator
  // sees. Those get removed via Planning's own Required Concepts section
  // (deleteConceptSlot), which drops the whole slot correctly.
  document.getElementById('cd-modal-delete-btn').style.display = product.source === 'drop' ? 'none' : '';

  updateConceptDevFooterButtons(concept.concept_dev_status);
  fillConceptDevModalFields(concept);
  openModal('concept-dev-modal');
}

// Which footer action(s) make sense depends on how far along the concept
// already is: not yet submitted -> Save Draft + Ready for Review; sent back
// with feedback -> Save Draft (stays Changes Required) + Resubmit for
// Review; already submitted/decided (Ready for Review, Approved, or
// Killed) -> a single Save Changes that edits the concept in place without
// moving concept_dev_status at all (see the targetStatus===null branch of
// saveConceptDevModal) -- this is the fix for the "still shows Ready for
// Review after it's already submitted" bug.
function updateConceptDevFooterButtons(status) {
  const draftBtn = document.getElementById('cd-modal-save-draft-btn');
  const changesBtn = document.getElementById('cd-modal-save-changes-btn');
  const submitBtn = document.getElementById('cd-modal-submit-btn');
  if (status === 'ready_for_review' || status === 'approved' || status === 'killed') {
    draftBtn.style.display = 'none';
    changesBtn.style.display = '';
    submitBtn.style.display = 'none';
  } else if (status === 'changes_required') {
    draftBtn.style.display = '';
    changesBtn.style.display = 'none';
    submitBtn.style.display = '';
    submitBtn.textContent = 'Resubmit for Review →';
  } else {
    draftBtn.style.display = '';
    changesBtn.style.display = 'none';
    submitBtn.style.display = '';
    submitBtn.textContent = 'Ready for Review →';
  }
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

  updateConceptDevFooterButtons(null);

  // Nothing to delete yet -- this concept doesn't exist server-side until
  // Save Draft/Ready for Review creates it.
  document.getElementById('cd-modal-delete-btn').style.display = 'none';

  fillConceptDevModalFields(null);
  openModal('concept-dev-modal');
}

// Only reachable for a Core/High Stock/Promotion concept (see the
// product.source === 'drop' gate in openConceptDevModal) -- those are
// plain creative_assets rows scoped via shoot_plan_item_id, so deleting
// the row is a clean, complete removal (status_history cascades, and the
// original seed-asset link on shoot_plan_items.asset_id, if this happened
// to be it, just goes to NULL -- Concept Development doesn't read that
// column, it lists concepts via the reverse shoot_plan_item_id link).
async function deleteConceptDevConcept() {
  if (!conceptDevModalConceptId) return;
  if (!(await confirmDialog('Delete this concept? This cannot be undone.'))) return;
  try {
    await api(`/creative-assets/${conceptDevModalConceptId}`, { method: 'DELETE' });
    closeModal('concept-dev-modal');
    toast('Concept deleted');
    loadConceptDevWeek();
  } catch (e) {
    toast(e.message, true);
  }
}

// The concept card's own top-right X -- same deletable-here concepts as
// deleteConceptDevConcept above (see conceptDevConceptCardHtml's
// productSource gate), just reachable without opening the concept first.
async function deleteConceptDevConceptCard(conceptId) {
  if (!(await confirmDialog('Delete this concept? This cannot be undone.'))) return;
  try {
    await api(`/creative-assets/${conceptId}`, { method: 'DELETE' });
    toast('Concept deleted');
    loadConceptDevWeek();
  } catch (e) {
    toast(e.message, true);
  }
}

// Status is no longer a field the creator sets directly -- it's driven by
// which footer action they click. targetStatus is 'in_development' (Save
// Draft) or 'ready_for_review' (Ready for Review); a concept that's never
// been saved stays Not Started (see schema.sql's concept_dev_status
// default) until one of these two actions actually moves it.
// Opens the lightweight Hook / Opening nudge (see #cd-hook-nudge-modal) and
// resolves true if the creator picked "Continue Without" (proceed to save
// Ready for Review anyway) or false for "Add Opening" (cancel the save and
// focus the Primary Hook field instead) -- mirrors confirmDialog's
// promise-based pattern but deliberately its own modal, since this is a
// thinking prompt, not a warning.
function showConceptDevHookNudge() {
  return new Promise((resolve) => {
    const continueBtn = document.getElementById('cd-hook-nudge-continue-btn');
    const addBtn = document.getElementById('cd-hook-nudge-add-btn');
    const cleanup = (result) => {
      continueBtn.removeEventListener('click', onContinue);
      addBtn.removeEventListener('click', onAdd);
      closeModal('cd-hook-nudge-modal');
      resolve(result);
    };
    const onContinue = () => cleanup(true);
    const onAdd = () => {
      cleanup(false);
      const textareas = document.querySelectorAll('#cd-modal-hooks-list textarea');
      if (textareas.length) {
        textareas[0].focus();
        textareas[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    };
    continueBtn.addEventListener('click', onContinue);
    addBtn.addEventListener('click', onAdd);
    openModal('cd-hook-nudge-modal');
  });
}

async function saveConceptDevModal(targetStatus) {
  const product = conceptDevModalProduct;
  if (!product) return;
  const found = conceptDevModalConceptId ? findConceptDevConcept(conceptDevModalConceptId) : null;
  const nameLocked = Boolean(found && found.concept.name_locked);
  const nameInput = document.getElementById('cd-modal-name');
  const name = nameLocked ? found.concept.concept_name : nameInput.value.trim();
  const angleInput = document.getElementById('cd-modal-angle');
  const angle = angleInput.value.trim();
  const executionInput = document.getElementById('cd-modal-execution');
  const execution = executionInput.value.trim();

  const avatarSelect = document.getElementById('cd-modal-avatar-select');
  const isOtherAvatar = avatarSelect.value === '__other__';
  const customerAvatarId = avatarSelect.value && !isOtherAvatar ? Number(avatarSelect.value) : null;
  const customDescInput = document.getElementById('cd-modal-avatar-custom-desc');
  const customAvatarDescription = isOtherAvatar ? customDescInput.value.trim() : '';
  const whyCareInput = document.getElementById('cd-modal-avatar-why-care');
  const avatarWhyCare = whyCareInput.value.trim();
  const hasAvatar = Boolean(customerAvatarId) || Boolean(customAvatarDescription);

  const body = {
    angle,
    execution,
    customer_avatar_id: customerAvatarId,
    custom_avatar_description: customAvatarDescription,
    avatar_why_care: avatarWhyCare,
    script_notes: document.getElementById('cd-modal-script').value.trim(),
    hook_variations: conceptDevModalHooks
      .map((h) => ({ text: h.text.trim() }))
      .filter((h) => h.text),
    reference_items: conceptDevModalReferences
      .map((r) => (r.library_reference_id
        ? { url: r.url.trim(), note: r.note.trim(), library_reference_id: r.library_reference_id }
        : { url: r.url.trim(), note: r.note.trim() }))
      .filter((r) => r.url),
    talent_requirement: document.getElementById('cd-modal-talent').value.trim(),
    location: document.getElementById('cd-modal-location').value.trim(),
    props_notes: document.getElementById('cd-modal-props').value.trim(),
  };
  // targetStatus is null for "Save Changes" on an already-submitted concept
  // (ready_for_review/approved/killed) -- omitting the key entirely (rather
  // than sending null, which the backend's CONCEPT_DEV_STATUSES check would
  // reject) leaves concept_dev_status untouched via the PATCH route's
  // COALESCE, so a minor edit never silently bounces the concept back to
  // Draft/In Development.
  if (targetStatus) body.concept_dev_status = targetStatus;
  const savedToast = targetStatus === 'ready_for_review' ? 'Marked Ready for Review' : (targetStatus ? 'Draft saved' : 'Changes saved');

  hideConceptDevValidation();

  // Ready for Review is the only action with real required fields --
  // Save Draft stays deliberately permissive (just a name) so a creator
  // can jot down an idea and come back later. Each missing field gets its
  // own concise message directly beneath it (never a combined "please
  // complete all required fields" banner), and the first missing field is
  // focused/scrolled to -- every concept needs a specific person on the
  // other side of it (a Customer Avatar or a completed Other/New Avatar,
  // plus why THIS concept matters to them) before it's ready, same bar as
  // Angle/Execution.
  if (targetStatus === 'ready_for_review') {
    const missing = [];
    if (!nameLocked && !name) missing.push({ field: nameInput, errorId: 'cd-modal-name-error', message: 'Concept Name is required' });
    if (!angle) missing.push({ field: angleInput, errorId: 'cd-modal-angle-error', message: 'Add an Angle / Idea' });
    if (!hasAvatar) {
      if (isOtherAvatar) missing.push({ field: customDescInput, errorId: 'cd-modal-avatar-custom-desc-error', message: 'Describe who you\'re targeting' });
      else missing.push({ field: avatarSelect, errorId: 'cd-modal-avatar-select-error', message: 'Customer Avatar is required' });
    }
    if (!avatarWhyCare) missing.push({ field: whyCareInput, errorId: 'cd-modal-avatar-why-care-error', message: 'Explain why this audience should care' });
    if (!execution) missing.push({ field: executionInput, errorId: 'cd-modal-execution-error', message: 'Add an Execution / Shot Plan' });

    if (missing.length) {
      for (const m of missing) showConceptDevFieldError(m.field.id, m.errorId, m.message);
      missing[0].field.focus();
      missing[0].field.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    // All five core fields are complete -- Hook / Opening is a creative
    // thinking nudge, not a requirement (per the brief), so pause once to
    // ask rather than silently letting a concept through with nobody
    // having considered the opening at all.
    const primaryHookText = ((conceptDevModalHooks[0] && conceptDevModalHooks[0].text) || '').trim();
    if (!primaryHookText) {
      const continueWithout = await showConceptDevHookNudge();
      if (!continueWithout) return;
    }
  }

  try {
    if (conceptDevModalConceptId) {
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
          body: JSON.stringify({ concept_name: name, shoot_plan_item_id: product.shoot_plan_item_id }),
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

// ── Tuesday Creative Review ────────────────────────────
// The human quality gate right after Concept Development -- reads the exact
// same GET /concept-development payload Concept Dev already fetches (a
// concept is "in Tuesday Review" purely by virtue of concept_dev_status
// being ready_for_review/approved/changes_required/killed, no separate
// backend surface needed). Deliberately read-only and its own tr-* visual
// language throughout -- this is a decision room, not another editable
// form. Week nav mirrors Concept Dev's own (independent weekOffset, same
// reasoning as conceptDev vs planningWeekOffset).
function tuesdayReviewWeekStart() {
  return isoDateStr(mondayOfWeek(state.tuesdayReview.weekOffset));
}
function tuesdayReviewWeekNumber() {
  return isoWeekNumber(mondayOfWeek(state.tuesdayReview.weekOffset));
}

async function loadTuesdayReviewWeek() {
  try {
    state.tuesdayReview.data = await api(`/concept-development?week_start=${tuesdayReviewWeekStart()}`);
    state.tuesdayReview.filter = tuesdayReviewDefaultFilter();
    renderTuesdayReviewWeekHeader();
    renderTuesdayReviewList();
  } catch (e) {
    toast(e.message, true);
  }
}

function changeTuesdayReviewWeek(delta) {
  state.tuesdayReview.weekOffset += delta;
  onTuesdayReviewWeekChanged();
}

function goToCurrentTuesdayReviewWeek() {
  state.tuesdayReview.weekOffset = 0;
  onTuesdayReviewWeekChanged();
}

function jumpToTuesdayReviewWeek(offset) {
  state.tuesdayReview.weekOffset = offset;
  onTuesdayReviewWeekChanged();
}

function onTuesdayReviewWeekChanged() {
  closeTuesdayReviewWeekPicker();
  loadTuesdayReviewWeek();
}

function toggleTuesdayReviewWeekPicker() {
  const el = document.getElementById('tr-week-picker');
  const opening = el.style.display === 'none';
  if (opening) renderTuesdayReviewWeekPicker();
  el.style.display = opening ? '' : 'none';
}

function closeTuesdayReviewWeekPicker() {
  document.getElementById('tr-week-picker').style.display = 'none';
}

function renderTuesdayReviewWeekPicker() {
  const rows = [];
  for (let offset = 8; offset >= -12; offset--) {
    const monday = mondayOfWeek(offset);
    rows.push({ offset, number: isoWeekNumber(monday), range: formatWeekRange(monday) });
  }
  document.getElementById('tr-week-picker').innerHTML = rows.map((r) => `
    <button type="button" class="planning-week-picker-row ${r.offset === state.tuesdayReview.weekOffset ? 'active' : ''}" onclick="jumpToTuesdayReviewWeek(${r.offset})">
      <span>Week ${r.number}${r.offset === 0 ? ' · Current' : ''}</span>
      <span class="admin-note">${r.range}</span>
    </button>`).join('');
}

document.addEventListener('click', (e) => {
  const picker = document.getElementById('tr-week-picker');
  if (!picker || picker.style.display === 'none') return;
  if (e.target.closest('#tr-week-picker') || e.target.id === 'tr-week-label') return;
  picker.style.display = 'none';
});

function renderTuesdayReviewWeekHeader() {
  document.getElementById('tr-week-label').textContent = `Week ${tuesdayReviewWeekNumber()}`;
  document.getElementById('tr-this-week-btn').style.display = state.tuesdayReview.weekOffset === 0 ? 'none' : '';
}

function tuesdayReviewAllConcepts() {
  const products = (state.tuesdayReview.data && state.tuesdayReview.data.products) || [];
  const out = [];
  for (const product of products) {
    for (const concept of product.concepts) out.push({ concept, product });
  }
  return out;
}

function tuesdayReviewCounts() {
  const statuses = tuesdayReviewAllConcepts().map((x) => x.concept.concept_dev_status);
  return {
    all: statuses.length,
    readyForReview: statuses.filter((s) => s === 'ready_for_review').length,
    approved: statuses.filter((s) => s === 'approved').length,
    changesRequired: statuses.filter((s) => s === 'changes_required').length,
    killed: statuses.filter((s) => s === 'killed').length,
  };
}

// While the meeting is still working through the queue, landing on Ready
// is the point (that's the whole agenda); once it's empty, staying on
// Ready would land the team on a confusing "nothing here" empty state
// right after they just finished deciding on everything -- so the default
// falls back to All, which still shows what was just decided.
function tuesdayReviewDefaultFilter() {
  return tuesdayReviewCounts().readyForReview > 0 ? 'ready_for_review' : 'all';
}

// Status filters, not CTAs -- a quiet tab bar with the count baked into
// each label (counts double as the at-a-glance summary this used to need
// a separate chip row for) rather than teal-filled pill buttons.
const TUESDAY_REVIEW_FILTERS = [
  { value: 'all', label: 'All', countKey: 'all' },
  { value: 'ready_for_review', label: 'Ready', countKey: 'readyForReview' },
  { value: 'approved', label: 'Approved', countKey: 'approved' },
  { value: 'changes_required', label: 'Changes Required', countKey: 'changesRequired' },
  { value: 'killed', label: 'Killed', countKey: 'killed' },
];

function renderTuesdayReviewFilters() {
  const c = tuesdayReviewCounts();
  document.getElementById('tr-filters').innerHTML = TUESDAY_REVIEW_FILTERS.map((f) => `
    <button type="button" class="filter-tab ${state.tuesdayReview.filter === f.value ? 'active' : ''}" onclick="setTuesdayReviewFilter('${f.value}')">${f.label} <span class="filter-tab-count">${c[f.countKey]}</span></button>`).join('');
}

function setTuesdayReviewFilter(filter) {
  state.tuesdayReview.filter = filter;
  renderTuesdayReviewList();
}

function tuesdayReviewProductMetaText(product) {
  const sourceLabel = CONCEPT_DEV_SOURCE_LABELS[product.source] || product.source;
  const pathwayLabel = CONCEPT_DEV_PATHWAY_LABELS[product.source] || '';
  return [sourceLabel, pathwayLabel, product.creator ? `Owner: ${product.creator}` : null].filter(Boolean).join(' · ');
}

function truncateText(text, maxLen) {
  if (!text) return '';
  const trimmed = text.trim();
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen).trim()}…` : trimmed;
}

function tuesdayReviewAvatarLabel(concept) {
  if (concept.customer_avatar_id) {
    const avatar = state.customerAvatars.find((a) => a.id === concept.customer_avatar_id);
    return avatar ? avatar.name : null;
  }
  if (concept.custom_avatar_description) return truncateText(concept.custom_avatar_description, 60);
  return null;
}

// One-line "before you scroll" briefing for the review modal -- pulls
// together the pieces of context otherwise scattered across the sections
// below (Audience, Hook count, Reference count, Talent, Location) so the
// team has quick orientation before reviewing the detail. Deliberately
// skips anything already shown in the product context line right above it
// (product/source/pathway/Owner), and omits any part with no data rather
// than showing a placeholder.
function tuesdayReviewSummaryLineText(concept) {
  const hookCount = (Array.isArray(concept.hook_variations) ? concept.hook_variations : []).filter((h) => h && h.text && h.text.trim()).length;
  const refCount = (Array.isArray(concept.reference_items) ? concept.reference_items : []).filter((r) => r && r.url).length;
  return [
    tuesdayReviewAvatarLabel(concept),
    hookCount ? `${hookCount} Hook${hookCount === 1 ? '' : 's'}` : null,
    refCount ? `${refCount} Reference${refCount === 1 ? '' : 's'}` : null,
    concept.talent_requirement || null,
    concept.location || null,
  ].filter(Boolean).join(' · ');
}

// Agenda-card, not a brief -- name/avatar/idea preview/opening/status only,
// per the brief. Full detail only appears once "Review Concept" is clicked.
function tuesdayReviewConceptCardHtml(concept) {
  const avatarLabel = tuesdayReviewAvatarLabel(concept);
  const primaryHookText = ((concept.hook_variations && concept.hook_variations[0] && concept.hook_variations[0].text) || '').trim();
  return `
    <div class="tr-concept-card" onclick="openTuesdayReviewConcept(${concept.id})">
      <div class="tr-concept-card-name">${escapeHtml(concept.concept_name)}</div>
      ${avatarLabel ? `<div class="tr-concept-card-avatar">${escapeHtml(avatarLabel)}</div>` : ''}
      ${concept.angle && concept.angle.trim() ? `<div class="tr-concept-card-field"><span class="tr-concept-card-label">Idea</span>${escapeHtml(truncateText(concept.angle, 140))}</div>` : ''}
      ${primaryHookText ? `<div class="tr-concept-card-field"><span class="tr-concept-card-label">Opening</span>&ldquo;${escapeHtml(truncateText(primaryHookText, 100))}&rdquo;</div>` : ''}
      <div class="tr-concept-card-footer">
        <span class="cd-concept-status-pill ${CONCEPT_DEV_STATUS_CLASS[concept.concept_dev_status] || ''}">${CONCEPT_DEV_STATUS_LABELS[concept.concept_dev_status] || concept.concept_dev_status}</span>
        <span class="tr-concept-card-cta">Review Concept &rarr;</span>
      </div>
    </div>`;
}

function renderTuesdayReviewList() {
  renderTuesdayReviewFilters();
  const list = document.getElementById('tr-list');
  const data = state.tuesdayReview.data;
  if (!data || !data.confirmed) {
    list.innerHTML = `<div class="attention-empty">Shoot Plan for Week ${tuesdayReviewWeekNumber()} hasn't been confirmed yet — nothing to review.</div>`;
    return;
  }
  const filter = state.tuesdayReview.filter;
  const groups = (data.products || [])
    .map((product) => ({ product, concepts: product.concepts.filter((c) => filter === 'all' || c.concept_dev_status === filter) }))
    .filter((g) => g.concepts.length > 0);

  if (!groups.length) {
    if (filter === 'all') {
      list.innerHTML = '<div class="attention-empty">No concepts submitted for Tuesday Review yet.</div>';
      return;
    }
    const filterLabel = (TUESDAY_REVIEW_FILTERS.find((f) => f.value === filter) || {}).label || filter;
    list.innerHTML = `<div class="attention-empty">No concepts are currently ${filterLabel}.</div>`;
    return;
  }

  list.innerHTML = groups.map((g) => `
    <div class="tr-product-group">
      <div class="tr-product-header">
        <div class="tr-product-name">${escapeHtml(g.product.product_name)}</div>
        <div class="tr-product-meta">${escapeHtml(tuesdayReviewProductMetaText(g.product))}</div>
      </div>
      <div class="tr-concept-list">${g.concepts.map((c) => tuesdayReviewConceptCardHtml(c)).join('')}</div>
    </div>`).join('');
}

// The review queue Previous/Next walks -- scoped to the currently active
// filter (per the brief: "represent the relevant review queue for that
// week/filter"), rebuilt fresh each time a concept is opened so it always
// reflects the latest data.
function buildTuesdayReviewQueue() {
  const data = state.tuesdayReview.data;
  const queue = [];
  for (const product of (data && data.products) || []) {
    for (const concept of product.concepts) {
      if (state.tuesdayReview.filter === 'all' || concept.concept_dev_status === state.tuesdayReview.filter) queue.push({ concept, product });
    }
  }
  return queue;
}

function openTuesdayReviewConcept(conceptId) {
  state.tuesdayReview.queue = buildTuesdayReviewQueue();
  const index = state.tuesdayReview.queue.findIndex((x) => x.concept.id === conceptId);
  if (index === -1) return;
  state.tuesdayReview.queueIndex = index;
  renderTuesdayReviewConcept();
  openModal('tuesday-review-modal');
}

function tuesdayReviewNav(delta) {
  const nextIndex = state.tuesdayReview.queueIndex + delta;
  if (nextIndex < 0 || nextIndex >= state.tuesdayReview.queue.length) return;
  state.tuesdayReview.queueIndex = nextIndex;
  renderTuesdayReviewConcept();
}

function closeTuesdayReviewModal() {
  closeModal('tuesday-review-modal');
  renderTuesdayReviewList();
}

function referenceLabelFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host.includes('instagram')) return 'Instagram Reference';
    if (host.includes('tiktok')) return 'TikTok Reference';
    if (host.includes('youtube') || host.includes('youtu.be')) return 'YouTube Reference';
    if (host.includes('pinterest')) return 'Pinterest Reference';
    return `${host} Reference`;
  } catch {
    return 'Reference';
  }
}

function formatTuesdayReviewDate(iso) {
  return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

// Order deliberately follows the brief, NOT Concept Development's own order
// -- Hook/Opening comes before Execution here, so the team judges attention
// before production detail. Everything is plain text, no inputs.
function renderTuesdayReviewConcept() {
  const entry = state.tuesdayReview.queue[state.tuesdayReview.queueIndex];
  if (!entry) return;
  const { concept, product } = entry;

  document.getElementById('tr-review-position').textContent = `${state.tuesdayReview.queueIndex + 1} of ${state.tuesdayReview.queue.length}`;
  document.getElementById('tr-review-prev-btn').disabled = state.tuesdayReview.queueIndex === 0;
  document.getElementById('tr-review-next-btn').disabled = state.tuesdayReview.queueIndex === state.tuesdayReview.queue.length - 1;

  document.getElementById('tr-review-title').textContent = concept.concept_name;
  const statusPill = document.getElementById('tr-review-status-pill');
  statusPill.className = `cd-concept-status-pill ${CONCEPT_DEV_STATUS_CLASS[concept.concept_dev_status] || ''}`;
  statusPill.textContent = CONCEPT_DEV_STATUS_LABELS[concept.concept_dev_status] || concept.concept_dev_status;

  document.getElementById('tr-review-product-context').textContent = [product.product_name, tuesdayReviewProductMetaText(product)].filter(Boolean).join(' · ');
  const summaryLineEl = document.getElementById('tr-review-summary-line');
  const summaryLineText = tuesdayReviewSummaryLineText(concept);
  summaryLineEl.textContent = summaryLineText;
  summaryLineEl.style.display = summaryLineText ? '' : 'none';

  document.getElementById('tr-review-angle').textContent = concept.angle && concept.angle.trim() ? concept.angle.trim() : 'No Angle / Idea provided';

  const avatarNameBtn = document.getElementById('tr-review-avatar-name');
  const avatarDetail = document.getElementById('tr-review-avatar-detail');
  avatarDetail.style.display = 'none';
  avatarDetail.innerHTML = '';
  if (concept.customer_avatar_id) {
    const avatar = state.customerAvatars.find((a) => a.id === concept.customer_avatar_id);
    avatarNameBtn.textContent = avatar ? `${avatar.name} ▾` : 'Customer Avatar';
    avatarNameBtn.disabled = !avatar;
    if (avatar) {
      avatarDetail.innerHTML = [
        avatar.who_they_are ? `<div><span class="tr-avatar-detail-label">Who they are</span>${escapeHtml(avatar.who_they_are)}</div>` : '',
        avatar.what_they_care_about ? `<div><span class="tr-avatar-detail-label">What they care about</span>${escapeHtml(avatar.what_they_care_about)}</div>` : '',
        avatar.what_stops_buying ? `<div><span class="tr-avatar-detail-label">What stops them buying</span>${escapeHtml(avatar.what_stops_buying)}</div>` : '',
        avatar.what_resonates ? `<div><span class="tr-avatar-detail-label">What tends to resonate</span>${escapeHtml(avatar.what_resonates)}</div>` : '',
      ].join('');
    }
  } else if (concept.custom_avatar_description) {
    // A one-off audience has no separate saved profile to expand -- the
    // description IS the name/label, so it shows directly rather than
    // being hidden behind a (disabled, unreachable) toggle.
    avatarNameBtn.textContent = concept.custom_avatar_description;
    avatarNameBtn.disabled = true;
  } else {
    avatarNameBtn.textContent = 'No Customer Avatar selected';
    avatarNameBtn.disabled = true;
  }
  document.getElementById('tr-review-why-care').textContent = concept.avatar_why_care && concept.avatar_why_care.trim() ? concept.avatar_why_care.trim() : '—';

  const hooks = (Array.isArray(concept.hook_variations) ? concept.hook_variations : []).filter((h) => h && h.text && h.text.trim());
  const hooksEl = document.getElementById('tr-review-hooks');
  hooksEl.innerHTML = hooks.length
    ? [
        `<div class="tr-hook-item"><span class="tr-hook-label">Primary</span><div class="tr-hook-text">&ldquo;${escapeHtml(hooks[0].text.trim())}&rdquo;</div></div>`,
        ...hooks.slice(1).map((h, i) => `<div class="tr-hook-item"><span class="tr-hook-label">Alt ${String(i + 1).padStart(2, '0')}</span><div class="tr-hook-text">&ldquo;${escapeHtml(h.text.trim())}&rdquo;</div></div>`),
      ].join('')
    : '<div class="tr-review-subtle">No specific Hook / Opening provided</div>';

  document.getElementById('tr-review-execution').textContent = concept.execution && concept.execution.trim() ? concept.execution.trim() : 'No Execution / Shot Plan provided';
  const scriptToggle = document.getElementById('tr-review-script-toggle');
  const scriptEl = document.getElementById('tr-review-script');
  scriptEl.style.display = 'none';
  scriptEl.textContent = concept.script_notes || '';
  scriptToggle.style.display = concept.script_notes && concept.script_notes.trim() ? '' : 'none';

  const refs = (Array.isArray(concept.reference_items) ? concept.reference_items : []).filter((r) => r && r.url);
  const refsSection = document.getElementById('tr-review-references-section');
  if (!refs.length) {
    refsSection.style.display = 'none';
  } else {
    refsSection.style.display = '';
    document.getElementById('tr-review-references').innerHTML = refs.map((r) => `
      <div class="tr-reference-item">
        <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener" class="tr-reference-link">${escapeHtml(referenceLabelFromUrl(r.url))} &#8599;</a>
        ${r.note ? `<div class="tr-reference-note"><span class="tr-reference-note-label">What we like about it</span>${escapeHtml(r.note)}</div>` : ''}
      </div>`).join('');
  }

  const shootReqSection = document.getElementById('tr-review-shoot-req-section');
  const hasShootReq = concept.talent_requirement || concept.location || (concept.props_notes && concept.props_notes.trim());
  if (!hasShootReq) {
    shootReqSection.style.display = 'none';
  } else {
    shootReqSection.style.display = '';
    const inlineParts = [
      concept.talent_requirement ? `Talent: ${concept.talent_requirement}` : null,
      concept.location ? `Location: ${concept.location}` : null,
    ].filter(Boolean);
    document.getElementById('tr-review-shoot-req-inline').textContent = inlineParts.length ? inlineParts.join(' · ') : '—';
    const propsToggle = document.getElementById('tr-review-props-toggle');
    const propsEl = document.getElementById('tr-review-props');
    propsEl.style.display = 'none';
    propsEl.textContent = concept.props_notes || '';
    propsToggle.style.display = concept.props_notes && concept.props_notes.trim() ? '' : 'none';
  }

  updateTuesdayReviewDecisionBar(concept);
}

function toggleTuesdayReviewAvatarDetail() {
  const el = document.getElementById('tr-review-avatar-detail');
  el.style.display = el.style.display === 'none' ? '' : 'none';
}
function toggleTuesdayReviewScript() {
  const el = document.getElementById('tr-review-script');
  el.style.display = el.style.display === 'none' ? '' : 'none';
}
function toggleTuesdayReviewProps() {
  const el = document.getElementById('tr-review-props');
  el.style.display = el.style.display === 'none' ? '' : 'none';
}

// The three live decisions only ever apply to a concept still awaiting
// Tuesday Review -- anything opened from another filter shows what was
// already decided instead (feedback/kill reason/approved date), never a
// re-decide affordance.
function updateTuesdayReviewDecisionBar(concept) {
  const bar = document.getElementById('tr-decision-bar');
  const note = document.getElementById('tr-review-decided-note');
  if (concept.concept_dev_status === 'ready_for_review') {
    bar.style.display = '';
    note.style.display = 'none';
    note.textContent = '';
    return;
  }
  bar.style.display = 'none';
  note.style.display = '';
  if (concept.concept_dev_status === 'approved') {
    note.textContent = `Approved for Shooting${concept.reviewed_at ? ' on ' + formatTuesdayReviewDate(concept.reviewed_at) : ''}.`;
  } else if (concept.concept_dev_status === 'changes_required') {
    note.textContent = `Feedback from Tuesday Review: ${concept.review_feedback || '—'}`;
  } else if (concept.concept_dev_status === 'killed') {
    const parts = [concept.kill_reason, concept.kill_note].filter(Boolean);
    note.textContent = `Killed${parts.length ? ' — ' + parts.join(': ') : ''}.`;
  } else {
    note.textContent = 'This concept has not been submitted for Tuesday Review yet.';
  }
}

async function submitTuesdayReviewDecision(conceptId, decision, extra) {
  try {
    await api(`/concept-development/concepts/${conceptId}/review`, {
      method: 'PATCH',
      body: JSON.stringify({ decision, ...extra }),
    });
    await loadTuesdayReviewWeek();
    tuesdayReviewAdvanceAfterDecision();
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  }
}

// After a decision, move straight to the next Concept still awaiting
// Tuesday Review -- the queue actually being worked through live in the
// meeting -- rather than making the team close, find and reopen the next
// card by hand. Closes the modal and shows the completion state once none
// remain.
function tuesdayReviewAdvanceAfterDecision() {
  const remaining = tuesdayReviewAllConcepts().filter((x) => x.concept.concept_dev_status === 'ready_for_review');
  if (!remaining.length) {
    closeModal('tuesday-review-modal');
    renderTuesdayReviewList();
    return;
  }
  state.tuesdayReview.queue = buildTuesdayReviewQueue();
  state.tuesdayReview.queueIndex = 0;
  renderTuesdayReviewConcept();
  renderTuesdayReviewList();
}

async function approveTuesdayReviewConcept() {
  const entry = state.tuesdayReview.queue[state.tuesdayReview.queueIndex];
  if (!entry) return;
  await submitTuesdayReviewDecision(entry.concept.id, 'approved');
}

function openTuesdayReviewChangesModal() {
  document.getElementById('tr-changes-feedback').value = '';
  document.getElementById('tr-changes-feedback').classList.remove('cd-field-invalid');
  hideConceptDevFieldError('tr-changes-feedback-error');
  openModal('tr-changes-modal');
}

async function submitTuesdayReviewChanges() {
  const entry = state.tuesdayReview.queue[state.tuesdayReview.queueIndex];
  if (!entry) return;
  const feedback = document.getElementById('tr-changes-feedback').value.trim();
  if (!feedback) {
    showConceptDevFieldError('tr-changes-feedback', 'tr-changes-feedback-error', 'Explain what needs changing');
    return;
  }
  const ok = await submitTuesdayReviewDecision(entry.concept.id, 'changes_required', { feedback });
  if (ok) closeModal('tr-changes-modal');
}

const TUESDAY_REVIEW_KILL_REASONS = [
  'Weak Angle', 'Too Similar to Existing Creative', 'Not Right for Product',
  'Execution Too Difficult', 'No Longer Relevant', 'Other',
];
let tuesdayReviewKillReason = null;

function renderTuesdayReviewKillReasonChips() {
  document.getElementById('tr-kill-reason-chips').innerHTML = TUESDAY_REVIEW_KILL_REASONS.map((r) => `
    <button type="button" class="cd-filter-btn ${tuesdayReviewKillReason === r ? 'active' : ''}" onclick="selectTuesdayReviewKillReason('${r.replace(/'/g, "\\'")}')">${r}</button>`).join('');
}

function selectTuesdayReviewKillReason(reason) {
  tuesdayReviewKillReason = tuesdayReviewKillReason === reason ? null : reason;
  renderTuesdayReviewKillReasonChips();
}

function openTuesdayReviewKillModal() {
  tuesdayReviewKillReason = null;
  document.getElementById('tr-kill-note').value = '';
  renderTuesdayReviewKillReasonChips();
  openModal('tr-kill-modal');
}

async function submitTuesdayReviewKill() {
  const entry = state.tuesdayReview.queue[state.tuesdayReview.queueIndex];
  if (!entry) return;
  const kill_note = document.getElementById('tr-kill-note').value.trim();
  const ok = await submitTuesdayReviewDecision(entry.concept.id, 'killed', {
    kill_reason: tuesdayReviewKillReason || undefined,
    kill_note: kill_note || undefined,
  });
  if (ok) closeModal('tr-kill-modal');
}

// ── Shooting ───────────────────────────────────────────
// A lightweight weekly calendar / task tracker, not another production
// database (per the brief). Week is the primary planning view; Today is the
// content creator's own worklist; History is the manager's week-by-week
// rollup. All three read the SAME underlying shoot_schedule rows (via
// GET /shooting and GET /shooting/history) -- nothing here ever creates a
// second copy of a Concept, only where/when it gets shot. Week nav mirrors
// Concept Dev/Tuesday Review's own (independent weekOffset, same reasoning
// as those two: navigating one page's week must never move another's).
const SHOOT_DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const SHOOT_DAY_LABELS = { monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday', friday: 'Friday' };
const SHOOT_DAY_SHORT_LABELS = { monday: 'MON', tuesday: 'TUE', wednesday: 'WED', thursday: 'THU', friday: 'FRI' };

// "MON 31 AUG" -- computed from the week actually being browsed (not
// "today"), so this stays correct when a manager navigates to a past or
// future week rather than only ever labelling the current one.
function shootingDayHeaderLabel(day) {
  const monday = mondayOfWeek(state.shooting.weekOffset);
  const d = new Date(monday);
  d.setDate(monday.getDate() + SHOOT_DAY_KEYS.indexOf(day));
  const month = d.toLocaleDateString('en-AU', { month: 'short' }).toUpperCase().slice(0, 3);
  return `${SHOOT_DAY_SHORT_LABELS[day]} ${d.getDate()} ${month}`;
}

// True only when the Week view is actually showing the real current week
// (weekOffset 0) AND this is the real current weekday -- browsing to a past
// or future week, or a weekend with no matching day key, never lights this
// up. Reuses shootingTodayInfo's own real-world "now", the same source
// Today's tab already trusts, so there's no second definition of "today".
function shootingIsCurrentDay(day) {
  return state.shooting.weekOffset === 0 && day === shootingTodayInfo().dayKey;
}

function shootingWeekStart() {
  return isoDateStr(mondayOfWeek(state.shooting.weekOffset));
}
function shootingWeekNumber() {
  return isoWeekNumber(mondayOfWeek(state.shooting.weekOffset));
}

// Parses a plain YYYY-MM-DD string the same way every other date in this
// app is built (local Y/M/D field arithmetic, never new Date(isoString) --
// that parses as UTC and can land on the wrong local day). History renders
// real past weeks rather than an offset from today, so this is the one
// place the frontend actually needs to turn a returned date string back
// into a Date for isoWeekNumber/formatWeekRange.
function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function nextWeekStartFrom(weekStartStr) {
  const d = parseDateStr(weekStartStr);
  d.setDate(d.getDate() + 7);
  return isoDateStr(d);
}

async function loadShootingWeek() {
  try {
    state.shooting.data = await api(`/shooting?week_start=${shootingWeekStart()}`);
    renderShootingWeekHeader();
    renderShootingWeekView();
  } catch (e) {
    toast(e.message, true);
  }
}

function changeShootingWeek(delta) {
  state.shooting.weekOffset += delta;
  onShootingWeekChanged();
}

function goToCurrentShootingWeek() {
  state.shooting.weekOffset = 0;
  onShootingWeekChanged();
}

function jumpToShootingWeek(offset) {
  state.shooting.weekOffset = offset;
  onShootingWeekChanged();
}

function onShootingWeekChanged() {
  closeShootingWeekPicker();
  loadShootingWeek();
}

function toggleShootingWeekPicker() {
  const el = document.getElementById('shoot-week-picker');
  const opening = el.style.display === 'none';
  if (opening) renderShootingWeekPicker();
  el.style.display = opening ? '' : 'none';
}

function closeShootingWeekPicker() {
  document.getElementById('shoot-week-picker').style.display = 'none';
}

function renderShootingWeekPicker() {
  const rows = [];
  for (let offset = 8; offset >= -12; offset--) {
    const monday = mondayOfWeek(offset);
    rows.push({ offset, number: isoWeekNumber(monday), range: formatWeekRange(monday) });
  }
  document.getElementById('shoot-week-picker').innerHTML = rows.map((r) => `
    <button type="button" class="planning-week-picker-row ${r.offset === state.shooting.weekOffset ? 'active' : ''}" onclick="jumpToShootingWeek(${r.offset})">
      <span>Week ${r.number}${r.offset === 0 ? ' · Current' : ''}</span>
      <span class="admin-note">${r.range}</span>
    </button>`).join('');
}

document.addEventListener('click', (e) => {
  const picker = document.getElementById('shoot-week-picker');
  if (!picker || picker.style.display === 'none') return;
  if (e.target.closest('#shoot-week-picker') || e.target.id === 'shoot-week-label') return;
  picker.style.display = 'none';
});

function renderShootingWeekHeader() {
  document.getElementById('shoot-week-label').textContent = `Week ${shootingWeekNumber()}`;
  document.getElementById('shoot-this-week-btn').style.display = state.shooting.weekOffset === 0 ? 'none' : '';
}

// Week/Today/History switcher -- always refetches whatever view is now
// active (see refreshCurrentShootingView), since Shooting is the direct
// downstream consumer of an action just taken on Tuesday Review.
function setShootingView(view) {
  state.shooting.view = view;
  document.querySelectorAll('#shoot-subnav .shoot-subnav-btn').forEach((b) => b.classList.toggle('active', b.dataset.shootView === view));
  document.querySelectorAll('.shoot-panel').forEach((p) => p.classList.toggle('active', p.id === `shoot-view-${view}`));
  refreshCurrentShootingView();
}

function refreshCurrentShootingView() {
  if (state.shooting.view === 'week') loadShootingWeek();
  else if (state.shooting.view === 'today') loadShootingToday();
  else loadShootingHistory();
}

// Owner filter -- populated from content_creators (see the brief: "Do not
// hard-code these names"), shared client-side across Week/Today, no
// refetch needed on change since both views already have the full week's
// data in hand.
function populateShootingOwnerFilters() {
  const optionsHtml = `<option value="all">All Owners</option>` +
    state.contentCreators.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
  ['shoot-week-owner-filter', 'shoot-today-owner-filter'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = optionsHtml;
    el.value = state.shooting.ownerFilter;
  });
}

function setShootingOwnerFilter(value) {
  state.shooting.ownerFilter = value;
  document.querySelectorAll('.shoot-owner-filter').forEach((el) => { el.value = value; });
  if (state.shooting.view === 'week') renderShootingWeekView();
  else if (state.shooting.view === 'today') renderShootingTodayView();
}

function shootingOwnerMatches(item) {
  return state.shooting.ownerFilter === 'all' || item.owner === state.shooting.ownerFilter;
}

function shootingHookPreview(item) {
  const hooks = Array.isArray(item.hook_variations) ? item.hook_variations : [];
  const primary = ((hooks[0] && hooks[0].text) || '').trim();
  return primary ? truncateText(primary, 90) : '';
}

// Every non-Shot card's accessible alternative to drag-and-drop -- see the
// brief: "drag-and-drop must NOT be the only way". Carry to next week is
// listed for every card, not just ones sitting unfinished in a past week --
// V1 keeps this a deliberate team decision rather than date-gating it.
// Rendered into the "•••" overflow menu (see shootingCardHtml) rather than
// a permanently-visible dropdown, so the card footer stays quiet until
// someone actually wants to move something.
function shootingMoveMenuItemsHtml(item) {
  const dayItems = SHOOT_DAY_KEYS
    .filter((day) => day !== item.scheduled_day)
    .map((day) => `<button type="button" class="shoot-card-menu-item" onclick="moveShootingCard(${item.id}, '${day}', '${item.scheduled_week_start}'); closeAllShootCardMenus();">${SHOOT_DAY_LABELS[day]}</button>`)
    .join('');
  const unscheduledItem = item.scheduled_day
    ? `<button type="button" class="shoot-card-menu-item" onclick="moveShootingCard(${item.id}, 'unscheduled', '${item.scheduled_week_start}'); closeAllShootCardMenus();">Unscheduled</button>`
    : '';
  const carryItem = `<button type="button" class="shoot-card-menu-item shoot-card-menu-item-carry" onclick="moveShootingCard(${item.id}, 'carry_next_week', '${item.scheduled_week_start}'); closeAllShootCardMenus();">Carry to next week &rarr;</button>`;
  return `<div class="shoot-card-menu-label">Move to</div>${dayItems}${unscheduledItem}${carryItem}`;
}

function toggleShootCardMenu(id) {
  const dropdown = document.getElementById(`shoot-card-menu-${id}`);
  if (!dropdown) return;
  const isOpen = dropdown.classList.contains('open');
  closeAllShootCardMenus();
  if (!isOpen) dropdown.classList.add('open');
}

function closeAllShootCardMenus() {
  document.querySelectorAll('.shoot-card-menu-dropdown.open').forEach((el) => el.classList.remove('open'));
}

document.addEventListener('click', (e) => {
  if (e.target.closest('.shoot-card-menu')) return;
  closeAllShootCardMenus();
});

async function moveShootingCard(scheduleId, value, currentWeekStart) {
  try {
    const body = value === 'unscheduled' ? { scheduled_day: null }
      : value === 'carry_next_week' ? { scheduled_day: null, scheduled_week_start: nextWeekStartFrom(currentWeekStart) }
      : { scheduled_day: value };
    await api(`/shooting/${scheduleId}`, { method: 'PATCH', body: JSON.stringify(body) });
    toast(value === 'carry_next_week' ? 'Carried to next week' : 'Moved');
    refreshCurrentShootingView();
  } catch (e) {
    toast(e.message, true);
  }
}

// Drag-and-drop is the OTHER way to move a card (same-week only -- there's
// no "next week" drop target visible while browsing one week at a time, so
// Carry Over stays a Move-to… option instead). dragScheduleId is a fallback
// for browsers/situations where the dataTransfer payload doesn't survive
// the drop (Safari has been inconsistent about this historically).
function onShootCardDragStart(e, scheduleId) {
  state.shooting.dragScheduleId = scheduleId;
  e.dataTransfer.setData('text/plain', String(scheduleId));
  e.dataTransfer.effectAllowed = 'move';
}

// Rings the column/Unscheduled strip the dragged card is currently over
// (same .drag-over convention used for reorderable rows elsewhere in the
// app), so it's obvious exactly where a drop will land -- dragover fires
// continuously while hovering, so re-adding the class here every time is
// cheap and self-correcting even if a dragleave over a child element
// briefly clears it.
function onShootColumnDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
}

function onShootColumnDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

function onShootColumnDrop(e, day) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const scheduleId = state.shooting.dragScheduleId || Number(e.dataTransfer.getData('text/plain'));
  state.shooting.dragScheduleId = null;
  if (!scheduleId) return;
  moveShootingCard(scheduleId, day || 'unscheduled', null);
}

async function markShootingShot(scheduleId) {
  try {
    await api(`/shooting/${scheduleId}/mark-shot`, { method: 'POST' });
    toast('Marked as Shot');
    refreshCurrentShootingView();
  } catch (e) {
    toast(e.message, true);
  }
}

// The reverse of markShootingShot -- for an accidental click, not a second
// production status. Returns the Concept to Scheduled/draggable.
async function unmarkShootingShot(scheduleId) {
  try {
    await api(`/shooting/${scheduleId}/unmark-shot`, { method: 'POST' });
    toast('Unmarked as Shot');
    refreshCurrentShootingView();
  } catch (e) {
    toast(e.message, true);
  }
}

// Week grid card -- compact by design (per the brief: "Do NOT display the
// entire Concept description..."). Shot cards stay visible and undraggable
// (see the backend's status != 'shot' guard) so the calendar always shows
// what was actually produced, not just outstanding work. The whole card
// opens the Brief on click (draggable cards still drag as normal -- a plain
// click and a drag are already distinct browser gestures); the status pill
// and the "•••" menu each stop that click from bubbling so they act on
// themselves instead of also opening the Brief underneath them.
// Status label is display-only -- item.status is still just 'planned'/'shot'
// underneath (see markShootingShot/unmarkShootingShot), this just reads
// scheduled_day to say something more specific than "Planned" for where the
// concept actually sits in the Shooting workflow.
function shootingCardHtml(item, isUnscheduled = false) {
  const isShot = item.status === 'shot';
  const metaParts = [item.owner, item.location].filter(Boolean);
  const carriedBadge = item.carried_over ? `<span class="shoot-carried-badge">From W${isoWeekNumber(parseDateStr(item.original_week_start))}</span>` : '';
  const plannedLabel = isUnscheduled ? 'Needs Scheduling' : 'Scheduled';
  const statusHtml = isShot
    ? `<button type="button" class="shoot-status-pill shoot-status-pill-shot shoot-status-pill-toggle" onclick="event.stopPropagation(); unmarkShootingShot(${item.id})" title="Undo -- mark as not Shot">&check; Shot</button>`
    : `<button type="button" class="shoot-status-pill shoot-status-pill-toggle" onclick="event.stopPropagation(); markShootingShot(${item.id})" title="Mark as Shot">&#9675; ${plannedLabel}</button>`;
  const menuHtml = isShot ? '' : `
        <div class="shoot-card-menu" onclick="event.stopPropagation()">
          <button type="button" class="shoot-card-menu-btn" onclick="toggleShootCardMenu(${item.id})" aria-label="Move concept">&bull;&bull;&bull;</button>
          <div class="shoot-card-menu-dropdown" id="shoot-card-menu-${item.id}">${shootingMoveMenuItemsHtml(item)}</div>
        </div>`;
  // The drag handle is only shown on Unscheduled cards -- everywhere else
  // (a day column) the card is already sitting somewhere, so what needs
  // surfacing is specifically "this one still needs to be dragged onto a
  // day", not that dragging exists at all.
  const dragHandle = isUnscheduled && !isShot ? '<span class="shoot-card-drag-handle" title="Drag onto a day to schedule">⠿</span>' : '';
  return `
    <div class="shoot-card ${isShot ? 'shoot-card-shot' : ''}" ${isShot ? '' : 'draggable="true"'} ondragstart="onShootCardDragStart(event, ${item.id})" onclick="openShootingBrief(${item.id})">
      <div class="shoot-card-name">${dragHandle}${escapeHtml(item.concept_name)}</div>
      <div class="shoot-card-product">${escapeHtml(item.product_name || '—')}</div>
      ${metaParts.length ? `<div class="shoot-card-meta">${escapeHtml(metaParts.join(' · '))}</div>` : ''}
      <div class="shoot-card-footer">
        ${statusHtml}
        ${carriedBadge}
      </div>
      <div class="shoot-card-actions">
        <button type="button" class="link-btn" onclick="event.stopPropagation(); openShootingBrief(${item.id})">View Brief &rarr;</button>
        ${menuHtml}
      </div>
    </div>`;
}

// Summary + Unscheduled + calendar are all derived from the SAME
// owner-filtered item lists here, rather than the server's unfiltered
// data.summary -- so switching the Owner filter updates the Planned/Shot/
// Remaining counts too, not just which cards are visible.
// Day header: date label plus, only once the day actually has something
// scheduled, a compact "X/Y Shot" count (the count is the primary signal,
// per the brief -- the thin bar underneath is purely a secondary visual) and
// a "✓" once every Concept for that day is Shot. An empty day shows just
// the date, never a "0/0" -- see the brief: "keeps empty days visually
// clean". Unscheduled Concepts never reach this function at all, since it
// only ever receives a single weekday's already-bucketed items.
function shootingDayHeaderHtml(day, items, isToday) {
  const label = `<span class="shoot-day-date-group"><span class="shoot-day-date">${shootingDayHeaderLabel(day)}</span>${isToday ? '<span class="shoot-day-today-badge">Today</span>' : ''}</span>`;
  if (!items.length) return `<div class="shoot-day-header-top">${label}</div>`;
  const shotCount = items.filter((i) => i.status === 'shot').length;
  const total = items.length;
  const complete = shotCount === total;
  const pct = Math.round((shotCount / total) * 100);
  return `
    <div class="shoot-day-header-top">
      ${label}
      <span class="shoot-day-progress-count${complete ? ' shoot-day-progress-complete' : ''}">${complete ? '&check; ' : ''}${shotCount}/${total} Shot</span>
    </div>
    <div class="shoot-day-progress-bar"><div class="shoot-day-progress-fill${complete ? ' shoot-day-progress-fill-complete' : ''}" style="width:${pct}%"></div></div>`;
}

// Planned/Shot/Remaining/Complete% here are computed purely from the
// Mon-Fri day buckets (never Unscheduled -- see the brief: "have not been
// allocated to a day"), and only from whatever the Owner filter currently
// lets through, so switching owners updates every number here and every
// day header's own X/Y Shot in one re-render -- no separate fetch, no page
// reload (see markShootingShot -> refreshCurrentShootingView).
function renderShootingWeekView() {
  const data = state.shooting.data;
  if (!data) return;

  const unscheduled = (data.unscheduled || []).filter(shootingOwnerMatches);
  const dayItems = {};
  let planned = 0;
  let shot = 0;
  SHOOT_DAY_KEYS.forEach((day) => {
    const items = ((data.days && data.days[day]) || []).filter(shootingOwnerMatches);
    dayItems[day] = items;
    planned += items.length;
    shot += items.filter((i) => i.status === 'shot').length;
  });
  const completionPct = planned > 0 ? Math.round((shot / planned) * 100) : null;

  document.getElementById('shoot-week-summary').innerHTML = `
    <span class="shoot-summary-stat"><strong>${planned}</strong> Scheduled</span>
    <span class="shoot-summary-stat"><strong>${shot}</strong> Shot</span>
    <span class="shoot-summary-stat"><strong>${planned - shot}</strong> Remaining</span>
    ${completionPct !== null ? `<span class="shoot-summary-stat"><strong>${completionPct}%</strong> Complete</span>` : ''}`;

  const weekProgressBar = document.getElementById('shoot-week-progress-bar');
  weekProgressBar.style.display = completionPct !== null ? '' : 'none';
  if (completionPct !== null) document.getElementById('shoot-week-progress-fill').style.width = `${completionPct}%`;

  const unscheduledEl = document.getElementById('shoot-unscheduled');
  unscheduledEl.classList.toggle('shoot-unscheduled-compact', unscheduled.length === 0);
  unscheduledEl.classList.toggle('shoot-unscheduled-active', unscheduled.length > 0);
  unscheduledEl.innerHTML = unscheduled.length ? `
    <div class="shoot-unscheduled-header">Unscheduled <span class="shoot-unscheduled-count">${unscheduled.length}</span><span class="shoot-unscheduled-hint">Needs scheduling</span><span class="shoot-unscheduled-drag-hint">Drag concepts onto a day to schedule</span></div>
    <div class="shoot-unscheduled-list">${unscheduled.map((item) => shootingCardHtml(item, true)).join('')}</div>`
    : `<div class="shoot-unscheduled-header">Unscheduled <span class="shoot-unscheduled-count">0</span></div>`;

  document.getElementById('shoot-week-grid').innerHTML = SHOOT_DAY_KEYS.map((day) => {
    const items = dayItems[day];
    const isToday = shootingIsCurrentDay(day);
    return `
      <div class="shoot-day-column${isToday ? ' shoot-day-column-today' : ''}" ondragover="onShootColumnDragOver(event)" ondragleave="onShootColumnDragLeave(event)" ondrop="onShootColumnDrop(event, '${day}')">
        <div class="shoot-day-header">${shootingDayHeaderHtml(day, items, isToday)}</div>
        <div class="shoot-day-cards">
          ${items.length ? items.map((item) => shootingCardHtml(item)).join('') : '<div class="shoot-day-empty">—</div>'}
        </div>
      </div>`;
  }).join('');
}

// Today always shows the REAL current weekday, independent of whatever
// week Week view happens to be browsing -- see state.shooting.todayData.
function shootingTodayInfo() {
  const now = new Date();
  const dayKeyByIndex = { 1: 'monday', 2: 'tuesday', 3: 'wednesday', 4: 'thursday', 5: 'friday' };
  return { date: now, dayKey: dayKeyByIndex[now.getDay()] || null };
}

async function loadShootingToday() {
  try {
    state.shooting.todayData = await api(`/shooting?week_start=${isoDateStr(mondayOfWeek(0))}`);
    renderShootingTodayView();
  } catch (e) {
    toast(e.message, true);
  }
}

function shootingTodayItemHtml(item) {
  const isShot = item.status === 'shot';
  const hookPreview = shootingHookPreview(item);
  const metaParts = [item.location].filter(Boolean);
  return `
    <div class="shoot-today-item ${isShot ? 'shoot-card-shot' : ''}">
      <div class="shoot-today-item-main">
        <div class="shoot-card-name">${escapeHtml(item.concept_name)}</div>
        <div class="shoot-card-product">${escapeHtml(item.product_name || '—')}</div>
        ${metaParts.length ? `<div class="shoot-card-meta">${escapeHtml(metaParts.join(' · '))}</div>` : ''}
        ${hookPreview ? `<div class="shoot-today-hook">&ldquo;${escapeHtml(hookPreview)}&rdquo;</div>` : ''}
      </div>
      <div class="shoot-today-item-actions">
        <span class="shoot-card-status ${isShot ? 'shoot-card-status-shot' : ''}">${isShot ? '&check; Shot' : 'Planned'}</span>
        <button type="button" class="link-btn" onclick="openShootingBrief(${item.id})">View Shoot Brief &rarr;</button>
        ${isShot ? '' : `<button type="button" class="btn btn-primary btn-sm" onclick="markShootingShot(${item.id})">&check; Mark as Shot</button>`}
      </div>
    </div>`;
}

function renderShootingTodayView() {
  const { date, dayKey } = shootingTodayInfo();
  const dayLabel = date.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
  document.getElementById('shoot-today-title').textContent = `Today — ${dayLabel.toUpperCase()}`;

  const list = document.getElementById('shoot-today-list');
  if (!dayKey) {
    document.getElementById('shoot-today-summary').textContent = '';
    list.innerHTML = '<div class="attention-empty">No shoots are scheduled on weekends.</div>';
    return;
  }
  const data = state.shooting.todayData;
  if (!data) return;
  const items = ((data.days && data.days[dayKey]) || []).filter(shootingOwnerMatches);
  const shotCount = items.filter((i) => i.status === 'shot').length;
  document.getElementById('shoot-today-summary').textContent = `${items.length} Planned · ${shotCount} Shot · ${items.length - shotCount} Remaining`;
  list.innerHTML = items.length ? items.map((item) => shootingTodayItemHtml(item)).join('') : '<div class="attention-empty">Nothing scheduled for today.</div>';
}

async function loadShootingHistory() {
  try {
    state.shooting.historyData = await api('/shooting/history');
    renderShootingHistoryView();
  } catch (e) {
    toast(e.message, true);
  }
}

// Not Completed vs Carried Over: a week that still has unfinished work
// sitting in place shows "Not Completed" (final disposition still pending);
// once that work has actually been moved into a later week, it shows
// "Carried Over" instead -- both can appear together if some of each kind
// exist for the same week. See shooting.js's GET /history for the bucketing
// logic itself (purely derived from current state, no separate flag).
function shootingHistoryStatusLabel(w) {
  const parts = [];
  if (w.not_completed > 0 || w.carried_over === 0) parts.push(`${w.not_completed} Not Completed`);
  if (w.carried_over > 0) parts.push(`${w.carried_over} Carried Over`);
  return parts.join(' · ');
}

function renderShootingHistoryView() {
  const weeks = (state.shooting.historyData && state.shooting.historyData.weeks) || [];
  const list = document.getElementById('shoot-history-list');
  if (!weeks.length) {
    list.innerHTML = '<div class="attention-empty">No Shooting history yet.</div>';
    return;
  }
  list.innerHTML = weeks.map((w) => {
    const monday = parseDateStr(w.week_start);
    const completionRate = w.planned > 0 ? Math.round((w.shot / w.planned) * 100) : 0;
    return `
      <div class="shoot-history-row">
        <div class="shoot-history-row-main">
          <div class="shoot-history-week-name">Week ${isoWeekNumber(monday)}</div>
          <div class="shoot-history-range">${formatWeekRange(monday)}</div>
          <div class="shoot-history-stats">${w.planned} Planned · ${w.shot} Shot · ${shootingHistoryStatusLabel(w)}</div>
        </div>
        <div class="shoot-history-row-side">
          <div class="shoot-history-rate">${completionRate}% completed</div>
          <button type="button" class="link-btn" onclick="jumpToShootingWeekFromHistory('${w.week_start}')">View Week &rarr;</button>
        </div>
      </div>`;
  }).join('');
}

function jumpToShootingWeekFromHistory(weekStartStr) {
  const targetMonday = parseDateStr(weekStartStr);
  const diffWeeks = Math.round((targetMonday - mondayOfWeek(0)) / (7 * 86400000));
  state.shooting.weekOffset = diffWeeks;
  setShootingView('week');
}

// Read-only Shoot Brief -- reuses the approved Concept's own data (see
// GET /shooting/:id/brief), never another editable form.
async function openShootingBrief(scheduleId) {
  try {
    const brief = await api(`/shooting/${scheduleId}/brief`);
    state.shooting.briefScheduleId = scheduleId;
    renderShootingBrief(brief);
    openModal('shoot-brief-modal');
  } catch (e) {
    toast(e.message, true);
  }
}

// Purely mechanical: splits the ORIGINAL Execution text on sentence
// boundaries so it can render as a scannable numbered sequence, without
// rewriting, reordering, or inventing a single word of it -- see the
// brief: "Do NOT alter or overwrite the original Execution / Shot Plan".
// Returns null (render the plain paragraph instead) whenever that split
// wouldn't actually read as a sensible step list -- a single sentence, or
// text that's already short, gains nothing from being forced into "01 ...".
function shootingExecutionSteps(text) {
  if (!text || !text.trim()) return null;
  const sentences = text.trim().split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length < 2) return null;
  return sentences;
}

function renderShootingBrief(brief) {
  document.getElementById('shoot-brief-title').textContent = brief.concept_name;
  const isShot = brief.status === 'shot';
  const badge = document.getElementById('shoot-brief-status-badge');
  badge.className = `cd-concept-status-pill ${isShot ? 'cd-status-approved' : 'cd-status-ready-for-review'}`;
  badge.textContent = isShot ? 'Shot' : 'Planned';

  const skuInfo = (brief.colourways || []).map((c) => `${c.colour_label || c.style_code}${c.size ? ` · ${c.size}` : ''}`).join(', ');
  const contextLine = [
    brief.product_name,
    CONCEPT_DEV_SOURCE_LABELS[brief.source] || brief.source,
    brief.owner ? `Owner: ${brief.owner}` : null,
    skuInfo,
  ].filter(Boolean).join(' &middot; ');
  document.getElementById('shoot-brief-context').innerHTML = `
    ${brief.image_url ? `<img class="cd-modal-context-thumb" src="${brief.image_url}" alt="">` : '<span class="cd-modal-context-thumb cd-modal-context-noimg">🖼</span>'}
    <div class="cd-modal-context-lines"><div class="cd-modal-context-line">${contextLine}</div></div>`;

  // Opening: the Primary hook is the one the creator actually needs to
  // capture, so it gets the visual weight; everything after it is
  // secondary-but-actionable "also get these if you can" coverage.
  const hooks = Array.isArray(brief.hook_variations) ? brief.hook_variations.filter((h) => h.text && h.text.trim()) : [];
  const [primaryHook, ...otherHooks] = hooks;
  let hooksHtml = primaryHook
    ? `<div class="shoot-brief-primary-hook"><span class="shoot-brief-primary-badge">Primary</span><div class="shoot-brief-primary-text">&ldquo;${escapeHtml(primaryHook.text)}&rdquo;</div></div>`
    : '<div class="shoot-brief-text hint">No hook recorded.</div>';
  if (otherHooks.length) {
    hooksHtml += `<div class="shoot-brief-other-hooks-label">Other Hooks to Capture</div>` +
      otherHooks.map((h, i) => `<div class="shoot-brief-other-hook"><span class="shoot-brief-other-hook-num">${String(i + 1).padStart(2, '0')}</span><span>${escapeHtml(h.text)}</span></div>`).join('');
  }
  document.getElementById('shoot-brief-hooks').innerHTML = hooksHtml;

  const execEl = document.getElementById('shoot-brief-execution');
  const steps = shootingExecutionSteps(brief.execution);
  execEl.innerHTML = steps
    ? `<ol class="shoot-brief-steps">${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`
    : `<div class="shoot-brief-text">${escapeHtml(brief.execution || '—')}</div>`;

  const scriptSection = document.getElementById('shoot-brief-script-section');
  if (brief.script_notes && brief.script_notes.trim()) {
    scriptSection.style.display = '';
    document.getElementById('shoot-brief-script').textContent = brief.script_notes;
  } else {
    scriptSection.style.display = 'none';
  }

  const refs = Array.isArray(brief.reference_items) ? brief.reference_items.filter((r) => r.url) : [];
  const refSection = document.getElementById('shoot-brief-references-section');
  if (refs.length) {
    refSection.style.display = '';
    document.getElementById('shoot-brief-references').innerHTML = refs.map((r) => `
      <div class="cd-reference-item">
        <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.url)}</a>
        ${r.note ? `<div class="shoot-brief-text">${escapeHtml(r.note)}</div>` : ''}
      </div>`).join('');
  } else {
    refSection.style.display = 'none';
  }

  document.getElementById('shoot-brief-talent').textContent = brief.talent_requirement || '—';
  document.getElementById('shoot-brief-location').textContent = brief.location || '—';
  const propsWrap = document.getElementById('shoot-brief-props-wrap');
  if (brief.props_notes && brief.props_notes.trim()) {
    propsWrap.style.display = '';
    document.getElementById('shoot-brief-props').textContent = brief.props_notes;
  } else {
    propsWrap.style.display = 'none';
  }

  const audienceParts = [];
  if (brief.avatar_name) audienceParts.push(brief.avatar_name);
  else if (brief.custom_avatar_description) audienceParts.push(brief.custom_avatar_description);
  if (brief.avatar_why_care) audienceParts.push(brief.avatar_why_care);
  const audienceWrap = document.getElementById('shoot-brief-audience-wrap');
  if (audienceParts.length) {
    audienceWrap.style.display = '';
    document.getElementById('shoot-brief-audience').textContent = audienceParts.join(' — ');
  } else {
    audienceWrap.style.display = 'none';
  }

  document.getElementById('shoot-brief-mark-shot-btn').style.display = isShot ? 'none' : '';
  document.getElementById('shoot-brief-unmark-shot-btn').style.display = isShot ? '' : 'none';
}

async function markShootingShotFromBrief() {
  if (!state.shooting.briefScheduleId) return;
  await markShootingShot(state.shooting.briefScheduleId);
  closeModal('shoot-brief-modal');
}

async function unmarkShootingShotFromBrief() {
  if (!state.shooting.briefScheduleId) return;
  await unmarkShootingShot(state.shooting.briefScheduleId);
  closeModal('shoot-brief-modal');
}

// ── Creative Toolkit / Creative Tools ─────────────────
// Two deliberately separate surfaces:
//  - Creative Toolkit (creative-toolkit-modal, openCreativeToolkit()) is
//    the GLOBAL resource drawer off the Concept Development landing
//    header -- only ever configurable external links + Proven Winners,
//    nothing that needs a product/concept in view.
//  - Creative Tools (creative-tools-modal, openCreativeTools()) is
//    CONTEXT-AWARE: opened from a product workspace or from inside a
//    concept, it shows a different action set depending on which. Neither
//    surface writes anything back into Concept Development itself --
//    Copy Prompt only puts text on the clipboard, and the creator brings
//    back whatever's actually worth developing by hand. See
//    creativeToolkitContext.js for how the prompts themselves get built
//    server-side from Planning's own data.
async function ensureCreativeResourcesLoaded() {
  if (state.creativeResources.length) return;
  try {
    state.creativeResources = await api('/creative-resources');
  } catch (e) {
    toast(e.message, true);
  }
}

function findConfiguredResource(name) {
  const target = name.trim().toLowerCase();
  return state.creativeResources.find((r) => r.enabled && r.name.trim().toLowerCase() === target);
}

function renderCreativeToolkitModal() {
  const list = document.getElementById('ct-resources-list');
  const enabled = state.creativeResources.filter((r) => r.enabled);
  list.innerHTML = enabled.length
    ? enabled.map((r) => `
        <div class="ct-card">
          <div class="ct-card-name">${escapeHtml(r.name)}</div>
          ${r.resource_type ? `<div class="ct-card-sub">${escapeHtml(r.resource_type)}</div>` : ''}
          ${r.description ? `<div class="ct-card-helper">${escapeHtml(r.description)}</div>` : ''}
          <div class="ct-card-actions">
            <a class="btn btn-ghost btn-sm" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.cta_label)}</a>
          </div>
        </div>`).join('')
    : '';
}

async function openCreativeToolkit() {
  await ensureCreativeResourcesLoaded();
  renderCreativeToolkitModal();
  openModal('creative-toolkit-modal');
}

// Exactly one of the two action sets is shown, chosen by whether a
// specific Concept (not just a product) is currently open -- and an AI
// prompt card is only ever shown once the id it actually needs is
// available, rather than shown disabled.
function renderCreativeToolsModal() {
  const { shootPlanItemId, conceptId } = state.creativeToolkit;
  const showConceptLevel = Boolean(conceptId);
  document.getElementById('ctx-product-level').style.display = showConceptLevel ? 'none' : '';
  document.getElementById('ctx-concept-level').style.display = showConceptLevel ? '' : 'none';
  document.getElementById('ctx-develop-card').style.display = !showConceptLevel && shootPlanItemId ? '' : 'none';
  document.getElementById('ctx-improve-card').style.display = showConceptLevel ? '' : 'none';

  const metaAdLibrary = findConfiguredResource('Meta Ad Library');

  const adLibraryCard = document.getElementById('ctx-adlibrary-card');
  if (!showConceptLevel && metaAdLibrary) {
    adLibraryCard.style.display = '';
    document.getElementById('ctx-adlibrary-link').href = metaAdLibrary.url;
  } else {
    adLibraryCard.style.display = 'none';
  }

  const conceptAdLibraryCard = document.getElementById('ctx-concept-adlibrary-card');
  if (showConceptLevel && metaAdLibrary) {
    conceptAdLibraryCard.style.display = '';
    document.getElementById('ctx-concept-adlibrary-link').href = metaAdLibrary.url;
  } else {
    conceptAdLibraryCard.style.display = 'none';
  }
}

// shootPlanItemId is required (every entry point knows which product it's
// for); conceptId is only set when opened from inside a specific concept
// (openCreativeToolsFromConceptModal), which switches the panel over to
// the concept-level action set.
async function openCreativeTools(shootPlanItemId, conceptId = null) {
  state.creativeToolkit = { shootPlanItemId, conceptId };
  await ensureCreativeResourcesLoaded();
  renderCreativeToolsModal();
  openModal('creative-tools-modal');
}

function openCreativeToolsFromConceptModal() {
  if (!conceptDevModalProduct) return;
  openCreativeTools(conceptDevModalProduct.shoot_plan_item_id, conceptDevModalConceptId);
}

async function copyToolkitPrompt(type) {
  const { shootPlanItemId, conceptId } = state.creativeToolkit;
  if (!shootPlanItemId) return;
  try {
    const query = type === 'improve' && conceptId
      ? `shoot_plan_item_id=${shootPlanItemId}&concept_id=${conceptId}`
      : `shoot_plan_item_id=${shootPlanItemId}`;
    const { prompt } = await api(`/creative-toolkit/prompt?${query}`);
    await navigator.clipboard.writeText(prompt);
    toast('Prompt copied — paste it into ChatGPT');
  } catch (e) {
    toast(e.message, true);
  }
}

function openChatGpt() {
  window.open('https://chat.openai.com/', '_blank', 'noopener');
}

function viewProvenWinnersFromToolkit() {
  closeModal('creative-toolkit-modal');
  closeModal('creative-tools-modal');
  switchTab('settings');
  document.getElementById('pw-list').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Editing ────────────────────────────────────────────
// Turns a Shot Concept into one or more trackable Final Edits. Reads
// GET /editing (Concepts already nested with their Final Edits, see
// routes/editing.js) -- same independent-weekOffset week-nav pattern as
// Concept Dev/Tuesday Review/Shooting above.
function editingWeekStart() {
  return isoDateStr(mondayOfWeek(state.editing.weekOffset));
}
function editingWeekNumber() {
  return isoWeekNumber(mondayOfWeek(state.editing.weekOffset));
}

async function loadEditingWeek() {
  try {
    state.editing.data = await api(`/editing?week_start=${editingWeekStart()}`);
    renderEditingWeekHeader();
    renderEditingList();
  } catch (e) {
    toast(e.message, true);
  }
}

function changeEditingWeek(delta) {
  state.editing.weekOffset += delta;
  onEditingWeekChanged();
}

function goToCurrentEditingWeek() {
  state.editing.weekOffset = 0;
  onEditingWeekChanged();
}

function jumpToEditingWeek(offset) {
  state.editing.weekOffset = offset;
  onEditingWeekChanged();
}

function onEditingWeekChanged() {
  closeEditingWeekPicker();
  loadEditingWeek();
}

function toggleEditingWeekPicker() {
  const el = document.getElementById('editing-week-picker');
  const opening = el.style.display === 'none';
  if (opening) renderEditingWeekPicker();
  el.style.display = opening ? '' : 'none';
}

function closeEditingWeekPicker() {
  document.getElementById('editing-week-picker').style.display = 'none';
}

function renderEditingWeekPicker() {
  const rows = [];
  for (let offset = 8; offset >= -12; offset--) {
    const monday = mondayOfWeek(offset);
    rows.push({ offset, number: isoWeekNumber(monday), range: formatWeekRange(monday) });
  }
  document.getElementById('editing-week-picker').innerHTML = rows.map((r) => `
    <button type="button" class="planning-week-picker-row ${r.offset === state.editing.weekOffset ? 'active' : ''}" onclick="jumpToEditingWeek(${r.offset})">
      <span>Week ${r.number}${r.offset === 0 ? ' · Current' : ''}</span>
      <span class="admin-note">${r.range}</span>
    </button>`).join('');
}

document.addEventListener('click', (e) => {
  const picker = document.getElementById('editing-week-picker');
  if (!picker || picker.style.display === 'none') return;
  if (e.target.closest('#editing-week-picker') || e.target.id === 'editing-week-label') return;
  picker.style.display = 'none';
});

function renderEditingWeekHeader() {
  document.getElementById('editing-week-label').textContent = `Week ${editingWeekNumber()}`;
  document.getElementById('editing-this-week-btn').style.display = state.editing.weekOffset === 0 ? 'none' : '';
}

const FINAL_EDIT_FORMATS = ['video', 'static', 'carousel'];

function editingAllFinalEdits() {
  const concepts = (state.editing.data && state.editing.data.concepts) || [];
  const out = [];
  for (const concept of concepts) {
    for (const finalEdit of concept.final_edits) out.push({ finalEdit, concept });
  }
  return out;
}

const EDITING_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'to_edit', label: 'To Edit' },
  { value: 'editing', label: 'Editing' },
  { value: 'ready_for_approval', label: 'Ready for Approval' },
];

// Counts ride on every tab, same convention as Concept Dev/Tuesday Review's
// filter-tab-count -- Ready for Approval also gets a subtle attention style
// when it actually has something waiting, since that's the state easiest to
// miss on a quick scan (see the brief, item 2).
function renderEditingFilters() {
  const s = (state.editing.data && state.editing.data.summary) || { final_edits: 0, to_edit: 0, editing: 0, ready_for_approval: 0 };
  const counts = { all: s.final_edits, to_edit: s.to_edit, editing: s.editing, ready_for_approval: s.ready_for_approval };
  document.getElementById('editing-filters').innerHTML = EDITING_FILTERS.map((f) => {
    const attention = f.value === 'ready_for_approval' && counts[f.value] > 0;
    return `
    <button type="button" class="filter-tab ${state.editing.filter === f.value ? 'active' : ''} ${attention ? 'filter-tab-attention' : ''}" onclick="setEditingFilter('${f.value}')">${f.label} <span class="filter-tab-count">${counts[f.value]}</span></button>`;
  }).join('');
}

function setEditingFilter(filter) {
  state.editing.filter = filter;
  renderEditingList();
}

// Operational, not exhaustive (see the brief, item 3): leads with the total,
// then only the statuses that actually have something in them -- a "0
// Editing" tells nobody anything, and the tabs above already carry the full
// breakdown including the zeros.
function renderEditingSummary() {
  const s = (state.editing.data && state.editing.data.summary) || { final_edits: 0, to_edit: 0, editing: 0, ready_for_approval: 0 };
  const parts = [`${s.final_edits} Final Edit${s.final_edits === 1 ? '' : 's'}`];
  if (s.to_edit > 0) parts.push(`${s.to_edit} To Edit`);
  if (s.editing > 0) parts.push(`${s.editing} Editing`);
  if (s.ready_for_approval > 0) parts.push(`${s.ready_for_approval} Ready for Approval`);
  document.getElementById('editing-summary').textContent = parts.join(' · ');
}

function editingConceptMetaText(concept) {
  return ['Shot', concept.owner ? `Owner: ${concept.owner}` : null].filter(Boolean).join(' · ');
}

// State-aware action wording -- see the brief, item 8: what to do next is
// derived entirely from status + whether a link exists, never a status word
// on its own.
function editingFinalEditActionLabel(finalEdit) {
  if (finalEdit.status === 'ready_for_approval') return 'View Final Edit &rarr;';
  if (finalEdit.status === 'editing') return finalEdit.final_edit_link ? 'Review Edit &rarr;' : 'Open Edit &rarr;';
  return 'Add Final Edit &rarr;';
}

// Whether the actual creative file has landed, independent of who's
// assigned -- "Final Edit Added" tracks the link, not the editor, since an
// editor can be assigned before any work is submitted.
function editingFinalEditStatusLine(finalEdit) {
  if (!finalEdit.final_edit_link) return 'No final edit added';
  return finalEdit.editor ? `Final Edit Added · ${finalEdit.editor}` : 'Final Edit Added';
}

function editingFinalEditRowHtml(finalEdit) {
  const isReady = finalEdit.status === 'ready_for_approval';
  return `
    <button type="button" class="editing-asset-row ${isReady ? 'editing-asset-row-ready' : ''}" onclick="openFinalEditModal(${finalEdit.id})">
      <span class="editing-asset-row-main">
        <span class="editing-asset-row-name">${escapeHtml(finalEdit.asset_name)}</span>
        ${finalEdit.variation_text ? `<span class="editing-asset-row-hook">&ldquo;${escapeHtml(finalEdit.variation_text)}&rdquo;</span>` : ''}
        <span class="editing-asset-row-status">${escapeHtml(editingFinalEditStatusLine(finalEdit))}</span>
      </span>
      <span class="editing-asset-row-action">
        ${isReady ? '<span class="cd-concept-status-pill editing-status-ready">&check; Ready for Approval</span>' : ''}
        <span class="editing-asset-row-verb">${editingFinalEditActionLabel(finalEdit)}</span>
      </span>
    </button>`;
}

// Grouped by Concept, never one flat list -- see the brief, item 3. A status
// filter narrows to matching Final Edits and hides any Concept left with
// none, same "scope the group, don't flatten it" pattern as the Reference
// Library's month grouping. Final Edits render directly on the card -- no
// "Open Editing ->" intermediate hop once at least one exists (item 2) -- and
// "View Shoot Brief" sits right here too (item 10), so the per-Concept modal
// is only ever needed for adding more assets.
function renderEditingList() {
  renderEditingSummary();
  renderEditingFilters();
  const concepts = (state.editing.data && state.editing.data.concepts) || [];
  const filter = state.editing.filter;
  const shaped = concepts
    .map((concept) => ({
      concept,
      finalEdits: filter === 'all' ? concept.final_edits : concept.final_edits.filter((fe) => fe.status === filter),
    }))
    .filter((g) => filter === 'all' || g.finalEdits.length > 0);

  document.getElementById('editing-empty').style.display = concepts.length ? 'none' : '';
  document.getElementById('editing-list').innerHTML = shaped.map(({ concept, finalEdits }) => `
    <div class="editing-concept-card">
      <div class="editing-concept-card-head">
        <div>
          <div class="editing-concept-product">${escapeHtml(concept.product_name || '—')}</div>
          <div class="editing-concept-name">${escapeHtml(concept.concept_name)}</div>
          <div class="hint">${escapeHtml(editingConceptMetaText(concept))}</div>
        </div>
        <button type="button" class="link-btn" onclick="openShootingBrief(${concept.shoot_schedule_id})">View Shoot Brief &#8599;</button>
      </div>
      ${concept.final_edits.length ? `
        <div class="cd-field-label" style="margin-top:10px;">Final Edits ${concept.final_edits.length}</div>
        <div class="editing-asset-list">${finalEdits.map(editingFinalEditRowHtml).join('')}</div>
        <button type="button" class="link-btn" style="margin-top:8px;" onclick="openEditingConcept(${concept.creative_asset_id})">+ Add Another Final Edit</button>
      ` : `
        <button type="button" class="link-btn" style="margin-top:8px;" onclick="openEditingConcept(${concept.creative_asset_id})">Create Final Edits &rarr;</button>
      `}
    </div>`).join('');
}

function editingFindConcept(creativeAssetId) {
  const concepts = (state.editing.data && state.editing.data.concepts) || [];
  return concepts.find((c) => c.creative_asset_id === creativeAssetId);
}

function editingFindFinalEdit(finalEditId) {
  for (const concept of (state.editing.data && state.editing.data.concepts) || []) {
    const found = concept.final_edits.find((fe) => fe.id === finalEditId);
    if (found) return { finalEdit: found, concept };
  }
  return null;
}

// The "Create Final Edits" flow: Hook Variations already on the Concept are
// offered as suggestions only -- matched by exact text against existing
// Final Edits' variation_text, never auto-created (see the brief, item 5:
// "Do NOT automatically assume every Hook Variation was successfully
// filmed"). Existing Final Edits themselves now render straight on the
// landing-page card (see renderEditingList), so this modal is purely for
// adding more.
function openEditingConcept(creativeAssetId) {
  const concept = editingFindConcept(creativeAssetId);
  if (!concept) return;
  state.editing.activeConceptAssetId = creativeAssetId;
  state.editing.createRows = [];
  renderEditingConceptModal();
  openModal('editing-concept-modal');
}

function renderEditingConceptModal() {
  const concept = editingFindConcept(state.editing.activeConceptAssetId);
  if (!concept) return;
  document.getElementById('editing-concept-modal-subtitle').textContent = `${concept.product_name || '—'} · ${concept.concept_name}`;

  const hooks = (Array.isArray(concept.hook_variations) ? concept.hook_variations : []).filter((h) => h && h.text && h.text.trim());
  const existingTexts = new Set(concept.final_edits.map((fe) => (fe.variation_text || '').trim()).filter(Boolean));
  const suggestions = hooks
    .map((h, i) => ({ label: i === 0 ? 'Primary Hook' : `Alternative Hook ${String(i).padStart(2, '0')}`, text: h.text.trim() }))
    .filter((s) => !existingTexts.has(s.text));

  // Left-aligned, with the actual hook text shown beneath each suggestion
  // (item 7) -- not just the Primary/Alternative label.
  document.getElementById('editing-create-suggestions').innerHTML = suggestions.map((s, i) => `
    <label class="editing-suggestion-row">
      <input type="checkbox" checked data-suggestion-index="${i}" onchange="updateEditingCreateButtonState()">
      <span class="editing-suggestion-text">
        <span class="editing-suggestion-label">${escapeHtml(s.label)}</span>
        <span class="editing-suggestion-hook">&ldquo;${escapeHtml(s.text)}&rdquo;</span>
      </span>
    </label>`).join('');
  document.getElementById('editing-create-suggestions').dataset.suggestions = JSON.stringify(suggestions);

  renderEditingCustomAssetRows();
  updateEditingCreateButtonState();
}

function editingDefaultFormat() {
  const concept = editingFindConcept(state.editing.activeConceptAssetId);
  return (concept && FINAL_EDIT_FORMATS.includes(concept.concept_format)) ? concept.concept_format : 'video';
}

// Format is only ever asked for here, at creation, and only for a custom row
// -- suggestions silently inherit the Concept's own format (item 6).
function addEditingCustomAssetRow() {
  state.editing.createRows.push({ name: '', format: editingDefaultFormat() });
  renderEditingCustomAssetRows();
  updateEditingCreateButtonState();
  const inputs = document.querySelectorAll('.editing-custom-row-input');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function removeEditingCustomAssetRow(index) {
  state.editing.createRows.splice(index, 1);
  renderEditingCustomAssetRows();
  updateEditingCreateButtonState();
}

function renderEditingCustomAssetRows() {
  document.getElementById('editing-create-custom-rows').innerHTML = state.editing.createRows.map((row, i) => `
    <div class="editing-custom-row">
      <input type="text" class="editing-custom-row-input" placeholder="Asset name" value="${escapeHtml(row.name)}"
        oninput="state.editing.createRows[${i}].name = this.value; updateEditingCreateButtonState();">
      <select class="editing-custom-row-format" onchange="state.editing.createRows[${i}].format = this.value;">
        ${FINAL_EDIT_FORMATS.map((f) => `<option value="${f}" ${row.format === f ? 'selected' : ''}>${f[0].toUpperCase()}${f.slice(1)}</option>`).join('')}
      </select>
      <button type="button" class="link-btn" onclick="removeEditingCustomAssetRow(${i})">Remove</button>
    </div>`).join('');
}

function editingSelectedCreateAssets() {
  const defaultFormat = editingDefaultFormat();
  const suggestions = JSON.parse(document.getElementById('editing-create-suggestions').dataset.suggestions || '[]');
  const checked = [...document.querySelectorAll('#editing-create-suggestions input[type="checkbox"]:checked')]
    .map((el) => suggestions[Number(el.dataset.suggestionIndex)])
    .filter(Boolean)
    .map((s) => ({ asset_name: s.label, variation_text: s.text, format: defaultFormat }));
  const custom = state.editing.createRows
    .filter((r) => r.name.trim())
    .map((r) => ({ asset_name: r.name.trim(), format: r.format || defaultFormat }));
  return [...checked, ...custom];
}

function updateEditingCreateButtonState() {
  const count = editingSelectedCreateAssets().length;
  const btn = document.getElementById('editing-create-btn');
  btn.disabled = count === 0;
  btn.textContent = count ? `Create ${count} Final Edit${count === 1 ? '' : 's'}` : 'Create Final Edits';
}

async function createEditingFinalEdits() {
  const assets = editingSelectedCreateAssets();
  if (!assets.length) return;
  try {
    await api(`/editing/concepts/${state.editing.activeConceptAssetId}/final-edits`, {
      method: 'POST',
      body: JSON.stringify({ assets }),
    });
    toast('Final Edits created');
    await loadEditingWeek();
    closeModal('editing-concept-modal');
  } catch (e) {
    toast(e.message, true);
  }
}

function populateFinalEditEditorSelect() {
  const sel = document.getElementById('final-edit-editor');
  sel.innerHTML = '<option value="">— unassigned —</option>' +
    state.contentCreators.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
}

function openFinalEditModal(finalEditId) {
  const found = editingFindFinalEdit(finalEditId);
  if (!found) return;
  const { finalEdit, concept } = found;
  state.editing.activeFinalEditId = finalEditId;
  // Opened either from the main landing list or from inside the per-Concept
  // modal -- close the latter so the two full-screen overlays never stack.
  closeModal('editing-concept-modal');

  document.getElementById('final-edit-modal-title').textContent = finalEdit.asset_name;
  document.getElementById('final-edit-modal-subtitle').textContent = `${concept.product_name || '—'} · ${concept.concept_name}`;

  // The actual hook text it's cutting, read-only -- already known, never
  // re-asked (item 5).
  const openingWrap = document.getElementById('final-edit-opening-wrap');
  if (finalEdit.variation_text) {
    openingWrap.style.display = '';
    document.getElementById('final-edit-opening-text').textContent = finalEdit.variation_text;
  } else {
    openingWrap.style.display = 'none';
  }

  populateFinalEditEditorSelect();
  document.getElementById('final-edit-editor').value = finalEdit.editor || '';

  if (finalEdit.final_edit_link) {
    document.getElementById('final-edit-link-view').style.display = '';
    document.getElementById('final-edit-link-input-wrap').style.display = 'none';
    document.getElementById('final-edit-link-open').href = finalEdit.final_edit_link;
  } else {
    document.getElementById('final-edit-link-view').style.display = 'none';
    document.getElementById('final-edit-link-input-wrap').style.display = '';
    document.getElementById('final-edit-link-input').value = '';
  }
  document.getElementById('final-edit-notes').value = finalEdit.editor_notes || '';

  updateFinalEditModalFooter();
  openModal('final-edit-modal');
}

// Once a Final Edit is Ready for Approval there's nothing left to do here --
// Final Approval owns the actual review (see the brief, item 4) -- so the
// footer collapses to just Close and the "Ready for Approval ->" button
// never reappears. Replacing the link is the one exception: it briefly
// brings Save/Cancel back so that correction can still be persisted.
function updateFinalEditModalFooter() {
  const found = editingFindFinalEdit(state.editing.activeFinalEditId);
  if (!found) return;
  const isReady = found.finalEdit.status === 'ready_for_approval';
  const isEditingLink = document.getElementById('final-edit-link-input-wrap').style.display !== 'none';
  const showWorkingFooter = !isReady || isEditingLink;

  document.getElementById('final-edit-ready-badge').style.display = isReady ? '' : 'none';
  document.getElementById('final-edit-delete-btn').style.display = isReady ? 'none' : '';
  document.getElementById('final-edit-cancel-btn').style.display = showWorkingFooter ? '' : 'none';
  document.getElementById('final-edit-save-btn').style.display = showWorkingFooter ? '' : 'none';
  document.getElementById('final-edit-ready-btn').style.display = isReady ? 'none' : '';
  document.getElementById('final-edit-close-btn').style.display = (isReady && !isEditingLink) ? '' : 'none';

  document.getElementById('final-edit-editor').disabled = isReady;
  document.getElementById('final-edit-notes').readOnly = isReady;
}

function showFinalEditLinkInput() {
  document.getElementById('final-edit-link-view').style.display = 'none';
  document.getElementById('final-edit-link-input-wrap').style.display = '';
  document.getElementById('final-edit-link-input').value = '';
  document.getElementById('final-edit-link-input').focus();
  updateFinalEditModalFooter();
}

async function saveFinalEdit(markReadyForApproval = false) {
  const found = editingFindFinalEdit(state.editing.activeFinalEditId);
  if (!found) return;
  const linkInputVisible = document.getElementById('final-edit-link-input-wrap').style.display !== 'none';
  const linkValue = linkInputVisible ? document.getElementById('final-edit-link-input').value.trim() : undefined;

  if (markReadyForApproval && !linkValue && !found.finalEdit.final_edit_link) {
    return toast('Add a Final Edit link before sending for approval', true);
  }

  // Status is never sent directly except this one terminal transition --
  // 'to_edit' -> 'editing' is derived server-side from the editor/link a
  // plain Save just set (see routes/editing.js), so there's no status field
  // here to submit (item 4).
  const payload = {
    editor: document.getElementById('final-edit-editor').value || null,
    editor_notes: document.getElementById('final-edit-notes').value.trim(),
  };
  if (markReadyForApproval) payload.status = 'ready_for_approval';
  if (linkValue !== undefined) payload.final_edit_link = linkValue;

  try {
    await api(`/editing/final-edits/${state.editing.activeFinalEditId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    toast(markReadyForApproval ? 'Sent for Approval' : 'Saved');
    await loadEditingWeek();
    closeModal('final-edit-modal');
  } catch (e) {
    toast(e.message, true);
  }
}

async function confirmDeleteFinalEdit() {
  const found = editingFindFinalEdit(state.editing.activeFinalEditId);
  if (!found) return;
  const ok = await confirmDialog(`Delete "${found.finalEdit.asset_name}"? This can't be undone.`, { okLabel: 'Delete' });
  if (!ok) return;
  try {
    await api(`/editing/final-edits/${state.editing.activeFinalEditId}`, { method: 'DELETE' });
    toast('Final Edit deleted');
    await loadEditingWeek();
    closeModal('final-edit-modal');
  } catch (e) {
    toast(e.message, true);
  }
}

// ── Reference Library ─────────────────────────────────
// A single shared reference_library table with two different surfaces:
//  - A real page (#tab-reference-library), reached from the sidebar and
//    from both Creative Toolkit surfaces (openReferenceLibraryFromToolkit)
//    -- browsing, search, and full CRUD via the ••• menu.
//  - A small picker MODAL (#reference-picker-modal, openReferenceLibraryPicker),
//    opened only from inside a Concept's own References section to attach
//    an existing reference -- same underlying state.referenceLibrary data,
//    never a second copy, but its own simpler card set (Use This Reference
//    only, no edit/delete).
// "Added by" is stamped server-side from the logged-in session (see
// referenceLibrary.js POST) now that real per-user login exists -- never
// entered by hand, and never a client-side identity prompt either.
let referenceAddEditId = null;
let referenceAddType = 'bau';

async function ensureReferenceLibraryLoaded(force = false) {
  if (state.referenceLibraryLoaded && !force) return;
  try {
    state.referenceLibrary = await api('/reference-library');
    state.referenceLibraryLoaded = true;
  } catch (e) {
    toast(e.message, true);
  }
}

// The live ApparelMagic category list (same one Core Shoot Planning groups
// by), not the app's own `categories` table -- see referenceLibrary.js's
// GET /categories. Loaded once, lazily, alongside the library itself.
async function ensureReferenceLibraryCategoriesLoaded() {
  if (state.referenceLibraryCategoriesLoaded) return;
  try {
    state.referenceLibraryCategories = await api('/reference-library/categories');
    state.referenceLibraryCategoriesLoaded = true;
  } catch (e) {
    toast(e.message, true);
  }
}

function formatReferenceLibraryDate(iso) {
  return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

// Best-effort platform detection from the saved URL -- purely client-side,
// never asked of the user. Drives the small "BAU · Instagram" meta line and,
// when no thumbnail is available, the placeholder card's label.
function detectReferencePlatform(url) {
  const lower = String(url || '').toLowerCase();
  if (lower.includes('instagram.com')) {
    return { label: 'Instagram', placeholder: lower.includes('/reel') ? 'Instagram Reel' : 'Instagram', icon: '📷' };
  }
  if (lower.includes('tiktok.com')) return { label: 'TikTok', placeholder: 'TikTok', icon: '🎵' };
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return { label: 'YouTube', placeholder: 'YouTube', icon: '▶' };
  if (lower.includes('facebook.com/ads/library')) return { label: 'Meta Ad', placeholder: 'Meta Ad', icon: '📣' };
  return { label: 'External', placeholder: 'External Reference', icon: '🔗' };
}

// YouTube is the one platform with a reliable, key-free, CORS-free
// thumbnail: img.youtube.com serves a static JPG straight from the video
// id, no API call needed. Every other platform (Instagram, TikTok, Meta Ad
// Library) would need either an authenticated API or a server-side fetch
// that can silently fail or get rate-limited -- deliberately not built for
// V1 (see the brief: "do not make automatic thumbnail generation a
// blocker"), so those always get a clean placeholder instead.
function youtubeThumbnailUrl(url) {
  const match = String(url || '').match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/i);
  return match ? `https://img.youtube.com/vi/${match[1]}/hqdefault.jpg` : null;
}

function referencePlaceholderHtml(platform) {
  return `<div class="ref-card-placeholder"><span class="ref-card-placeholder-icon">${platform.icon}</span><span class="ref-card-placeholder-label">${escapeHtml(platform.placeholder)}</span></div>`;
}

function referenceVisualHtml(item, platform) {
  const thumb = platform.label === 'YouTube' ? youtubeThumbnailUrl(item.link) : null;
  if (!thumb) return referencePlaceholderHtml(platform);
  const safeLabel = escapeHtml(platform.placeholder).replace(/'/g, '&#39;');
  return `<img class="ref-card-thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy" onerror="handleReferenceThumbError(this, '${platform.icon}', '${safeLabel}')">`;
}

// A YouTube thumbnail URL can still 404 (private/deleted video) -- falls
// back to the same clean placeholder every other platform already uses,
// rather than a broken-image icon.
function handleReferenceThumbError(imgEl, icon, label) {
  const placeholder = document.createElement('div');
  placeholder.className = 'ref-card-placeholder';
  placeholder.innerHTML = `<span class="ref-card-placeholder-icon">${icon}</span><span class="ref-card-placeholder-label">${label}</span>`;
  imgEl.replaceWith(placeholder);
}

function updateReferenceLibraryCounts() {
  document.getElementById('ref-lib-count-all').textContent = state.referenceLibrary.length;
  document.getElementById('ref-lib-count-bau').textContent = state.referenceLibrary.filter((r) => r.idea_type === 'bau').length;
  document.getElementById('ref-lib-count-sale').textContent = state.referenceLibrary.filter((r) => r.idea_type === 'sale').length;
}

function referenceLibraryCategoryOptionsHtml() {
  if (!state.referenceLibraryCategories.length) {
    return '<option value="">— none — (no live product categories found)</option>';
  }
  return '<option value="">— none —</option>' + state.referenceLibraryCategories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
}

// Shared by the page and the picker modal -- everything downstream (card
// markup, container ids) differs by surface, but "which references match
// the current type filter + search text" doesn't.
function referenceLibraryFilteredList(filterValue, searchValue) {
  const search = searchValue.trim().toLowerCase();
  return state.referenceLibrary.filter((r) => {
    if (filterValue !== 'all' && r.idea_type !== filterValue) return false;
    if (!search) return true;
    const haystack = [r.comment, r.category].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(search);
  });
}

async function loadReferenceLibraryPage() {
  await ensureReferenceLibraryLoaded();
  renderReferenceLibraryList();
}

function openReferenceLibraryFromToolkit() {
  closeModal('creative-toolkit-modal');
  closeModal('creative-tools-modal');
  switchTab('reference-library');
}

function setReferenceLibraryFilter(filter) {
  state.referenceLibraryFilter = filter;
  document.getElementById('ref-lib-tab-all').classList.toggle('active', filter === 'all');
  document.getElementById('ref-lib-tab-bau').classList.toggle('active', filter === 'bau');
  document.getElementById('ref-lib-tab-sale').classList.toggle('active', filter === 'sale');
  renderReferenceLibraryList();
}

// One shared card builder for both surfaces -- the page (mode 'browse':
// visual, ••• Edit/Delete menu, whole card opens the link) and the picker
// modal (mode 'picker': same visual/comment/context, but "Use This
// Reference" instead of a menu, and the card itself doesn't navigate away).
function referenceCardHtml(item, mode) {
  const isPicker = mode === 'picker';
  const platform = detectReferencePlatform(item.link);
  const typeLabel = item.idea_type === 'sale' ? 'SALE' : 'BAU';
  const contextParts = [platform.label];
  if (item.category) contextParts.push(item.category);
  const added = `${escapeHtml(item.added_by)} · ${formatReferenceLibraryDate(item.created_at)}`;
  const safeLink = escapeHtml(item.link).replace(/'/g, '&#39;');

  const menuHtml = isPicker ? '' : `
      <div class="ref-card-menu" onclick="event.stopPropagation()">
        <button type="button" class="ref-card-menu-btn" onclick="toggleReferenceCardMenu(${item.id}, event)" aria-label="More actions">&bull;&bull;&bull;</button>
        <div class="ref-card-menu-dropdown" id="ref-card-menu-${item.id}">
          <button type="button" class="ref-card-menu-item" onclick="closeAllReferenceCardMenus();openReferenceEditModal(${item.id})">Edit</button>
          <button type="button" class="ref-card-menu-item ref-card-menu-item-danger" onclick="closeAllReferenceCardMenus();confirmDeleteReferenceLibraryItem(${item.id})">Delete</button>
        </div>
      </div>`;

  const footerInner = isPicker
    ? `<button type="button" class="btn btn-primary btn-sm ref-card-pick-btn" onclick="event.stopPropagation();pickReferenceLibraryItem(${item.id})">Use This Reference</button>`
    : `<span class="ref-card-added">${added}</span>
       <span class="ref-card-footer-actions">
         <button type="button" class="ref-card-edit-btn" onclick="event.stopPropagation();openReferenceEditModal(${item.id})">Edit</button>
         <span class="ref-card-open-hint">Open &#8599;</span>
       </span>`;

  const clickAttr = isPicker ? '' : ` onclick="window.open('${safeLink}', '_blank', 'noopener')"`;

  return `
    <div class="ref-card"${clickAttr}>
      <div class="ref-card-visual">
        ${referenceVisualHtml(item, platform)}
        ${menuHtml}
      </div>
      <div class="ref-card-body">
        <div class="ref-card-meta">
          <span class="ref-card-type ref-card-type-${item.idea_type}">${typeLabel}</span>
          <span class="ref-card-context">${contextParts.map(escapeHtml).join(' · ')}</span>
        </div>
        <div class="ref-card-comment">${escapeHtml(item.comment)}</div>
        <div class="ref-card-footer">${footerInner}</div>
      </div>
    </div>`;
}

function referenceLibraryCardHtml(item) {
  return referenceCardHtml(item, 'browse');
}

// Newest/Oldest is the only sort control (V1, deliberately -- see the
// brief: no alphabetical/category/platform/etc). Sorts by created_at, not
// array order, so it's correct regardless of how items landed in
// state.referenceLibrary (API's default order, a local prepend on add, an
// in-place replace on edit).
function referenceLibrarySortedList(list, sort) {
  const sorted = [...list].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return sort === 'oldest' ? sorted : sorted.reverse();
}

function referenceLibraryMonthKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}`;
}

function referenceLibraryMonthLabel(iso) {
  return new Date(iso).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }).toUpperCase();
}

// Chronological structure only -- no month filter/accordion/timeline (see
// the brief). A sorted list groups into contiguous same-month runs by
// definition, so a single pass building "start a new group when the month
// key changes" is enough; it also means Newest/Oldest naturally reorders
// both the months and the references within each one, with no separate
// reversal step needed here.
function referenceLibraryGroupedHtml(sortedList) {
  const groups = [];
  let current = null;
  for (const item of sortedList) {
    const key = referenceLibraryMonthKey(item.created_at);
    if (!current || current.key !== key) {
      current = { key, label: referenceLibraryMonthLabel(item.created_at), items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups.map((g) => `
    <div class="ref-lib-month-group">
      <div class="ref-lib-month-heading">${escapeHtml(g.label)} <span class="ref-lib-month-count">${g.items.length} reference${g.items.length === 1 ? '' : 's'}</span></div>
      <div class="ref-lib-grid">${g.items.map(referenceLibraryCardHtml).join('')}</div>
    </div>`).join('');
}

function setReferenceLibrarySort(sort) {
  state.referenceLibrarySort = sort;
  renderReferenceLibraryList();
}

function renderReferenceLibraryList() {
  const search = document.getElementById('ref-lib-search').value;
  const filtered = referenceLibraryFilteredList(state.referenceLibraryFilter, search);
  const sorted = referenceLibrarySortedList(filtered, state.referenceLibrarySort);
  document.getElementById('ref-lib-list').innerHTML = referenceLibraryGroupedHtml(sorted);
  document.getElementById('ref-lib-empty').style.display = sorted.length ? 'none' : '';
  document.getElementById('ref-lib-empty').textContent = state.referenceLibrary.length
    ? 'No references match your filters.'
    : 'No references yet — be the first to add one.';
  updateReferenceLibraryCounts();
}

function closeAllReferenceCardMenus() {
  document.querySelectorAll('.ref-card-menu-dropdown.show').forEach((el) => el.classList.remove('show'));
}

function toggleReferenceCardMenu(id, event) {
  event.stopPropagation();
  const dropdown = document.getElementById(`ref-card-menu-${id}`);
  const isOpen = dropdown.classList.contains('show');
  closeAllReferenceCardMenus();
  if (!isOpen) dropdown.classList.add('show');
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.ref-card-menu')) closeAllReferenceCardMenus();
});

// ── Reference Library picker (attach to a Concept) ────
async function openReferenceLibraryPicker() {
  await ensureReferenceLibraryLoaded();
  document.getElementById('ref-picker-search').value = '';
  setReferencePickerFilter('all');
  openModal('reference-picker-modal');
}

function setReferencePickerFilter(filter) {
  state.referencePickerFilter = filter;
  document.getElementById('ref-picker-tab-all').classList.toggle('active', filter === 'all');
  document.getElementById('ref-picker-tab-bau').classList.toggle('active', filter === 'bau');
  document.getElementById('ref-picker-tab-sale').classList.toggle('active', filter === 'sale');
  renderReferencePickerList();
}

function referencePickerCardHtml(item) {
  return referenceCardHtml(item, 'picker');
}

function renderReferencePickerList() {
  const search = document.getElementById('ref-picker-search').value;
  const filtered = referenceLibraryFilteredList(state.referencePickerFilter, search);
  document.getElementById('ref-picker-list').innerHTML = filtered.map(referencePickerCardHtml).join('');
  document.getElementById('ref-picker-empty').style.display = filtered.length ? 'none' : '';
  document.getElementById('ref-picker-empty').textContent = state.referenceLibrary.length
    ? 'No references match your filters.'
    : 'No references yet — be the first to add one.';
}

function pickReferenceLibraryItem(id) {
  const item = state.referenceLibrary.find((r) => r.id === id);
  if (!item) return;
  conceptDevModalReferences.push({ url: item.link, note: '', library_reference_id: item.id });
  renderConceptDevModalReferences();
  setConceptDevReferencesExpanded(true);
  closeModal('reference-picker-modal');
  toast('Reference added');
}

function setReferenceAddType(type) {
  referenceAddType = type;
  document.getElementById('ref-add-type-bau').classList.toggle('active', type === 'bau');
  document.getElementById('ref-add-type-sale').classList.toggle('active', type === 'sale');
}

async function openReferenceAddModal() {
  referenceAddEditId = null;
  document.getElementById('reference-add-modal-title').textContent = 'Add Reference';
  document.getElementById('ref-add-link').value = '';
  document.getElementById('ref-add-comment').value = '';
  await ensureReferenceLibraryCategoriesLoaded();
  document.getElementById('ref-add-category').innerHTML = referenceLibraryCategoryOptionsHtml();
  document.getElementById('ref-add-category').value = '';
  setReferenceAddType('bau');
  document.getElementById('ref-add-delete-btn').style.display = 'none';
  openModal('reference-add-modal');
}

async function openReferenceEditModal(id) {
  const item = state.referenceLibrary.find((r) => r.id === id);
  if (!item) return;
  referenceAddEditId = id;
  document.getElementById('reference-add-modal-title').textContent = 'Edit Reference';
  document.getElementById('ref-add-link').value = item.link;
  document.getElementById('ref-add-comment').value = item.comment;
  await ensureReferenceLibraryCategoriesLoaded();
  document.getElementById('ref-add-category').innerHTML = referenceLibraryCategoryOptionsHtml();
  document.getElementById('ref-add-category').value = item.category || '';
  setReferenceAddType(item.idea_type);
  document.getElementById('ref-add-delete-btn').style.display = '';
  openModal('reference-add-modal');
}

async function saveReferenceAdd() {
  const link = document.getElementById('ref-add-link').value.trim();
  const comment = document.getElementById('ref-add-comment').value.trim();
  const category = document.getElementById('ref-add-category').value;
  if (!link) return toast('A reference link is required', true);
  if (!comment) return toast('Add a quick note on what you like about it', true);

  const payload = { link, comment, idea_type: referenceAddType, category: category || null };
  try {
    if (referenceAddEditId) {
      const updated = await api(`/reference-library/${referenceAddEditId}`, { method: 'PUT', body: JSON.stringify(payload) });
      state.referenceLibrary = state.referenceLibrary.map((r) => (r.id === updated.id ? updated : r));
    } else {
      const created = await api('/reference-library', { method: 'POST', body: JSON.stringify(payload) });
      state.referenceLibrary = [created, ...state.referenceLibrary];
    }
    closeModal('reference-add-modal');
    renderReferenceLibraryList();
    toast('Reference saved');
  } catch (e) {
    toast(e.message, true);
  }
}

async function confirmDeleteReferenceLibraryItem(id) {
  if (!(await confirmDialog('Delete this reference? This cannot be undone.'))) return;
  try {
    await api(`/reference-library/${id}`, { method: 'DELETE' });
    state.referenceLibrary = state.referenceLibrary.filter((r) => r.id !== id);
    renderReferenceLibraryList();
    toast('Reference deleted');
  } catch (e) {
    toast(e.message, true);
  }
}

async function deleteReferenceLibraryItem() {
  if (!referenceAddEditId) return;
  if (!(await confirmDialog('Delete this reference? This cannot be undone.'))) return;
  try {
    await api(`/reference-library/${referenceAddEditId}`, { method: 'DELETE' });
    state.referenceLibrary = state.referenceLibrary.filter((r) => r.id !== referenceAddEditId);
    closeModal('reference-add-modal');
    renderReferenceLibraryList();
    toast('Reference deleted');
  } catch (e) {
    toast(e.message, true);
  }
}

// ── AI Creative Review ────────────────────────────────
// A small, optional quality-control pass at the bottom of an individual
// concept's own workspace -- distinct from both the global Creative
// Toolkit and the context-aware Creative Tools modal above (neither of
// which is scoped to "is THIS specific, already-saved concept actually
// ready for Tuesday?"). Only shown once the concept exists server-side
// (a brand-new "+ Add Concept" has no id yet to build a review prompt
// from); even then, Copy Review Prompt itself stays disabled until there
// is enough substance to critique.
function updateReviewPromptGate() {
  const section = document.getElementById('cd-ai-review-section');
  if (!section) return;
  const hasConcept = Boolean(conceptDevModalConceptId);
  section.style.display = hasConcept ? '' : 'none';
  if (!hasConcept) return;

  const nameInput = document.getElementById('cd-modal-name');
  const name = nameInput.style.display !== 'none'
    ? nameInput.value
    : document.getElementById('cd-modal-name-locked').textContent;
  const angle = document.getElementById('cd-modal-angle').value;
  const execution = document.getElementById('cd-modal-execution').value;

  const avatarSelect = document.getElementById('cd-modal-avatar-select');
  const isOtherAvatar = avatarSelect.value === '__other__';
  const hasAvatar = isOtherAvatar
    ? Boolean(document.getElementById('cd-modal-avatar-custom-desc').value.trim())
    : Boolean(avatarSelect.value);
  const avatarWhyCare = document.getElementById('cd-modal-avatar-why-care').value;

  // Same five-field minimum Ready for Review itself requires -- there's
  // nothing meaningful to pressure-test before a concept has its strategic
  // foundation: who it's for, why they'd care, and how it's executed.
  const ready = Boolean(name.trim() && angle.trim() && execution.trim() && hasAvatar && avatarWhyCare.trim());
  document.getElementById('cd-review-copy-btn').disabled = !ready;
  document.getElementById('cd-review-chatgpt-btn').disabled = !ready;
  document.getElementById('cd-ai-review-helper').textContent = ready
    ? 'Want a second opinion before sending this to Tuesday review?'
    : 'Complete the core concept fields to unlock AI Review.';
}

// Builds from the modal's current field values (not a re-fetch of the
// last-saved row) so the review always reflects exactly what's on screen,
// including anything typed since the last Save Draft/Ready for Review.
async function copyReviewPrompt() {
  if (!conceptDevModalProduct || !conceptDevModalConceptId) return;
  const nameInput = document.getElementById('cd-modal-name');
  const conceptName = nameInput.style.display !== 'none'
    ? nameInput.value.trim()
    : document.getElementById('cd-modal-name-locked').textContent;
  const avatarSelect = document.getElementById('cd-modal-avatar-select');
  const isOtherAvatar = avatarSelect.value === '__other__';
  const concept = {
    concept_name: conceptName,
    angle: document.getElementById('cd-modal-angle').value.trim(),
    execution: document.getElementById('cd-modal-execution').value.trim(),
    customer_avatar_id: avatarSelect.value && !isOtherAvatar ? Number(avatarSelect.value) : null,
    custom_avatar_description: isOtherAvatar ? document.getElementById('cd-modal-avatar-custom-desc').value.trim() : '',
    avatar_why_care: document.getElementById('cd-modal-avatar-why-care').value.trim(),
    script_notes: document.getElementById('cd-modal-script').value.trim(),
    hook_variations: conceptDevModalHooks.map((h) => ({ text: h.text.trim() })).filter((h) => h.text),
    reference_items: conceptDevModalReferences.map((r) => ({ url: r.url.trim(), note: r.note.trim() })).filter((r) => r.url),
    talent_requirement: document.getElementById('cd-modal-talent').value.trim(),
    location: document.getElementById('cd-modal-location').value.trim(),
    props_notes: document.getElementById('cd-modal-props').value.trim(),
  };
  try {
    const { prompt } = await api('/creative-toolkit/review-prompt', {
      method: 'POST',
      body: JSON.stringify({ shoot_plan_item_id: conceptDevModalProduct.shoot_plan_item_id, concept }),
    });
    await navigator.clipboard.writeText(prompt);
    toast('Review prompt copied — paste it into ChatGPT');
  } catch (e) {
    toast(e.message, true);
  }
}

// ── Settings: Creative Resources ─────────────────────
// Same rank/reorder/edit-modal pattern as Proven Winners just above --
// see that section's comments for the reasoning, unchanged here.
let crDragId = null;

function renderCreativeResourcesSettings() {
  const list = document.getElementById('cr-list');
  if (!state.creativeResources.length) {
    list.innerHTML = '<div class="attention-empty">No Creative Resources yet — add your first below.</div>';
    return;
  }
  list.innerHTML = state.creativeResources.map((r, i) => `
    <div class="pw-row" draggable="true" data-id="${r.id}">
      <span class="pw-drag-handle" title="Drag to reorder">⠿</span>
      <span class="pw-name ${r.enabled ? '' : 'inactive'}">${escapeHtml(r.name)}</span>
      <span class="badge ${r.enabled ? 'badge-tested_proven' : 'badge-format'}">${r.enabled ? 'Enabled' : 'Disabled'}</span>
      <button type="button" class="btn btn-ghost btn-sm" ${i === 0 ? 'disabled' : ''} onclick="moveCr(${r.id}, -1)" title="Move up">&uarr;</button>
      <button type="button" class="btn btn-ghost btn-sm" ${i === state.creativeResources.length - 1 ? 'disabled' : ''} onclick="moveCr(${r.id}, 1)" title="Move down">&darr;</button>
      <button type="button" class="btn btn-ghost btn-sm" onclick="openCrModal(${r.id})">Edit</button>
    </div>
  `).join('');
  wireCrDragEvents();
}

function wireCrDragEvents() {
  document.querySelectorAll('#cr-list .pw-row').forEach((row) => {
    row.addEventListener('dragstart', () => {
      crDragId = Number(row.dataset.id);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      document.querySelectorAll('#cr-list .pw-row').forEach((r) => r.classList.remove('drag-over'));
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
      if (crDragId == null || crDragId === targetId) return;
      const ids = state.creativeResources.map((r) => r.id);
      const fromIdx = ids.indexOf(crDragId);
      const toIdx = ids.indexOf(targetId);
      if (fromIdx === -1 || toIdx === -1) return;
      ids.splice(fromIdx, 1);
      ids.splice(toIdx, 0, crDragId);
      submitCrReorder(ids);
    });
  });
}

function moveCr(id, delta) {
  const ids = state.creativeResources.map((r) => r.id);
  const idx = ids.indexOf(id);
  const swapWith = idx + delta;
  if (idx === -1 || swapWith < 0 || swapWith >= ids.length) return;
  [ids[idx], ids[swapWith]] = [ids[swapWith], ids[idx]];
  submitCrReorder(ids);
}

async function submitCrReorder(orderedIds) {
  try {
    state.creativeResources = await api('/creative-resources/reorder', {
      method: 'PUT',
      body: JSON.stringify({ ordered_ids: orderedIds }),
    });
    renderCreativeResourcesSettings();
  } catch (e) {
    toast(e.message, true);
  }
}

function openCrModal(id) {
  const r = id ? state.creativeResources.find((x) => x.id === id) : null;
  document.getElementById('cr-modal-title').textContent = r ? 'Edit Creative Resource' : 'New Creative Resource';
  document.getElementById('cr-id').value = r ? r.id : '';
  document.getElementById('cr-name').value = r ? r.name : '';
  document.getElementById('cr-description').value = (r && r.description) || '';
  document.getElementById('cr-url').value = r ? r.url : '';
  document.getElementById('cr-type').value = (r && r.resource_type) || '';
  document.getElementById('cr-cta-label').value = (r && r.cta_label) || 'Open ↗';
  document.getElementById('cr-enabled-row').style.display = r ? 'flex' : 'none';
  document.getElementById('cr-enabled').checked = r ? r.enabled : true;
  document.getElementById('cr-delete-btn').style.display = r ? 'inline-block' : 'none';
  openModal('cr-modal');
}

async function refreshCreativeResources() {
  state.creativeResources = await api('/creative-resources');
  renderCreativeResourcesSettings();
}

async function saveCr() {
  const id = document.getElementById('cr-id').value;
  const name = document.getElementById('cr-name').value;
  const description = document.getElementById('cr-description').value || null;
  const url = document.getElementById('cr-url').value;
  const resource_type = document.getElementById('cr-type').value || null;
  const cta_label = document.getElementById('cr-cta-label').value || null;
  if (!name.trim()) return toast('Name is required', true);
  if (!url.trim()) return toast('URL is required', true);

  try {
    if (id) {
      await api(`/creative-resources/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ name, description, url, resource_type, cta_label, enabled: document.getElementById('cr-enabled').checked }),
      });
    } else {
      await api('/creative-resources', {
        method: 'POST',
        body: JSON.stringify({ name, description, url, resource_type, cta_label }),
      });
    }
    closeModal('cr-modal');
    toast('Creative Resource saved');
    refreshCreativeResources();
  } catch (e) {
    toast(e.message, true);
  }
}

async function deleteCr() {
  const id = document.getElementById('cr-id').value;
  if (!id) return;
  if (!(await confirmDialog('Delete this Creative Resource?'))) return;
  try {
    await api(`/creative-resources/${id}`, { method: 'DELETE' });
    closeModal('cr-modal');
    toast('Creative Resource deleted');
    refreshCreativeResources();
  } catch (e) {
    toast(e.message, true);
  }
}

// ── Settings: Customer Avatars ────────────────────────
// Same rank/reorder/edit-modal pattern as Creative Resources just above --
// see that section's comments for the reasoning, unchanged here. The one
// difference: this modal can also be opened mid-concept via "Save as new
// Customer Avatar" (openSaveAvatarFromConceptModal), which is what
// caModalReturnToConceptDev/prefill below are for.
let caDragId = null;
let caModalReturnToConceptDev = false;

function renderCustomerAvatarsSettings() {
  const list = document.getElementById('ca-list');
  if (!state.customerAvatars.length) {
    list.innerHTML = '<div class="attention-empty">No Customer Avatars yet — add your first below.</div>';
    return;
  }
  list.innerHTML = state.customerAvatars.map((a, i) => `
    <div class="pw-row" draggable="true" data-id="${a.id}">
      <span class="pw-drag-handle" title="Drag to reorder">⠿</span>
      <span class="pw-name ${a.enabled ? '' : 'inactive'}">${escapeHtml(a.name)}</span>
      <span class="badge ${a.enabled ? 'badge-tested_proven' : 'badge-format'}">${a.enabled ? 'Enabled' : 'Disabled'}</span>
      <button type="button" class="btn btn-ghost btn-sm" ${i === 0 ? 'disabled' : ''} onclick="moveCa(${a.id}, -1)" title="Move up">&uarr;</button>
      <button type="button" class="btn btn-ghost btn-sm" ${i === state.customerAvatars.length - 1 ? 'disabled' : ''} onclick="moveCa(${a.id}, 1)" title="Move down">&darr;</button>
      <button type="button" class="btn btn-ghost btn-sm" onclick="openCaModal(${a.id})">Edit</button>
    </div>
  `).join('');
  wireCaDragEvents();
}

function wireCaDragEvents() {
  document.querySelectorAll('#ca-list .pw-row').forEach((row) => {
    row.addEventListener('dragstart', () => {
      caDragId = Number(row.dataset.id);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      document.querySelectorAll('#ca-list .pw-row').forEach((r) => r.classList.remove('drag-over'));
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
      if (caDragId == null || caDragId === targetId) return;
      const ids = state.customerAvatars.map((a) => a.id);
      const fromIdx = ids.indexOf(caDragId);
      const toIdx = ids.indexOf(targetId);
      if (fromIdx === -1 || toIdx === -1) return;
      ids.splice(fromIdx, 1);
      ids.splice(toIdx, 0, caDragId);
      submitCaReorder(ids);
    });
  });
}

function moveCa(id, delta) {
  const ids = state.customerAvatars.map((a) => a.id);
  const idx = ids.indexOf(id);
  const swapWith = idx + delta;
  if (idx === -1 || swapWith < 0 || swapWith >= ids.length) return;
  [ids[idx], ids[swapWith]] = [ids[swapWith], ids[idx]];
  submitCaReorder(ids);
}

async function submitCaReorder(orderedIds) {
  try {
    state.customerAvatars = await api('/customer-avatars/reorder', {
      method: 'PUT',
      body: JSON.stringify({ ordered_ids: orderedIds }),
    });
    renderCustomerAvatarsSettings();
  } catch (e) {
    toast(e.message, true);
  }
}

// prefill (only passed by openSaveAvatarFromConceptModal) pre-populates
// "Who are they?" from the one-off description already typed in the
// concept modal, and marks the modal so saveCa() selects the newly-saved
// avatar back in the concept modal rather than just refreshing Settings.
function openCaModal(id, prefill) {
  const a = id ? state.customerAvatars.find((x) => x.id === id) : null;
  caModalReturnToConceptDev = Boolean(prefill);
  document.getElementById('ca-modal-title').textContent = a ? 'Edit Customer Avatar' : 'New Customer Avatar';
  document.getElementById('ca-id').value = a ? a.id : '';
  document.getElementById('ca-name').value = a ? a.name : '';
  document.getElementById('ca-who').value = (a && a.who_they_are) || (prefill && prefill.who) || '';
  document.getElementById('ca-cares').value = (a && a.what_they_care_about) || '';
  document.getElementById('ca-stops').value = (a && a.what_stops_buying) || '';
  document.getElementById('ca-resonates').value = (a && a.what_resonates) || '';
  document.getElementById('ca-enabled-row').style.display = a ? 'flex' : 'none';
  document.getElementById('ca-enabled').checked = a ? a.enabled : true;
  document.getElementById('ca-delete-btn').style.display = a ? 'inline-block' : 'none';
  openModal('ca-modal');
}

async function refreshCustomerAvatars() {
  state.customerAvatars = await api('/customer-avatars');
  renderCustomerAvatarsSettings();
}

async function saveCa() {
  const id = document.getElementById('ca-id').value;
  const name = document.getElementById('ca-name').value;
  const who_they_are = document.getElementById('ca-who').value || null;
  const what_they_care_about = document.getElementById('ca-cares').value || null;
  const what_stops_buying = document.getElementById('ca-stops').value || null;
  const what_resonates = document.getElementById('ca-resonates').value || null;
  if (!name.trim()) return toast('Avatar Name is required', true);

  try {
    const saved = id
      ? await api(`/customer-avatars/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ name, who_they_are, what_they_care_about, what_stops_buying, what_resonates, enabled: document.getElementById('ca-enabled').checked }),
        })
      : await api('/customer-avatars', {
          method: 'POST',
          body: JSON.stringify({ name, who_they_are, what_they_care_about, what_stops_buying, what_resonates }),
        });
    closeModal('ca-modal');
    await refreshCustomerAvatars();

    if (caModalReturnToConceptDev) {
      caModalReturnToConceptDev = false;
      selectConceptDevAvatar(saved.id);
      toast('Customer Avatar saved and selected');
    } else {
      toast('Customer Avatar saved');
    }
  } catch (e) {
    toast(e.message, true);
  }
}

async function deleteCa() {
  const id = document.getElementById('ca-id').value;
  if (!id) return;
  if (!(await confirmDialog('Delete this Customer Avatar?'))) return;
  try {
    await api(`/customer-avatars/${id}`, { method: 'DELETE' });
    closeModal('ca-modal');
    toast('Customer Avatar deleted');
    refreshCustomerAvatars();
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
document.getElementById('cr-add-btn').addEventListener('click', () => openCrModal(null));
document.getElementById('ca-add-btn').addEventListener('click', () => openCaModal(null));
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
