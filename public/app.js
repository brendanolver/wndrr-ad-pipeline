const STATUSES = ['not_started', 'awaiting_proven_concept', 'awaiting_concept_development', 'concept_script', 'filming', 'editing', 'qc', 'uploaded_live'];
const STATUS_LABELS = {
  not_started: 'Not Started',
  awaiting_proven_concept: 'Awaiting Proven Concept',
  awaiting_concept_development: 'Awaiting Concept Development',
  concept_script: 'Concept/Script',
  filming: 'Filming',
  editing: 'Editing',
  qc: 'QC',
  uploaded_live: 'Uploaded/Live',
};
const TIER_LABELS = { core_proven: 'Core/Proven', new_drop: 'New Drop' };
const CLASSIFICATION_LABELS = { tested_proven: 'Tested/Proven', new_experimental: 'New/Experimental' };
// Who's responsible for developing a Required Concept -- see the
// concept_assignee column comment in schema.sql for why this is separate
// from strategy_owner/filming_owner/etc. and from content_creators.
const CONCEPT_ASSIGNEES = ['Mark', 'Shez', 'Til'];

let state = {
  currentUser: null,
  restrictedModules: [],
  usersAccess: null,
  styles: [], categories: [], board: null, dashboard: null, drops: [], provenWinners: [],
  coreProducts: [], planningSettings: null, coreView: 'priority', coreAllProductsOpen: false,
  coreExpandedCategories: new Set(), coreExpandedProducts: new Set(),
  coreShootExpandedCategories: new Set(),
  shootPlan: [], coverageImageIndex: new Map(),
  contentCreators: [],
  conceptDevLocations: [],
  conceptTypes: [],
  highStockProducts: [], highStockExpandedProducts: new Set(),
  // Monday Planning's 3-step guided workflow (Core/High Stocks/Shoot Plan)
  // -- always starts at Core on load (not persisted to localStorage): this
  // is a recurring weekly ritual, not a session to resume, so a stale
  // mid-flow step from a prior visit would only confuse.
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
  conceptDev: { weekOffset: 0, data: null, view: 'list', currentItemId: null, filter: 'all', standaloneItemId: null },
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
  shooting: { view: 'week', weekOffset: 0, data: null, todayData: null, historyData: null, ownerFilter: 'all', briefScheduleId: null, dragScheduleId: null, briefChecklistItems: [], briefChecklistChecked: {}, briefData: null },
  // Editing -- same independent-weekOffset pattern as conceptDev/
  // tuesdayReview/shooting above. data is Week's own GET /editing response
  // (Concepts already nested with their Final Edits); activeConceptAssetId/
  // activeFinalEditId track which modal is currently open so save handlers
  // know what they're writing to.
  editing: { view: 'week', weekOffset: 0, data: null, todayData: null, historyData: null, dragScheduleId: null, editorFilter: 'all', activeConceptAssetId: null, activeFinalEditId: null, finalEditSubmitMode: false },
  // Final Approval -- a flat queue (no week-nav, no filters), same "one
  // shared source of truth on the server" pattern as Editing: data is
  // GET /final-approval's rows as-is. activeCreativeAssetId tracks which
  // review modal is open; showFeedbackForm toggles the inline Request
  // Changes textarea within it.
  finalApproval: { data: [], activeCreativeAssetId: null, showFeedbackForm: false },
  // Ad Setup (Part C) -- board is GET /ad-setup/board's two lists as-is;
  // activeSubtab drives which of the 3 Final Approval sub-panels shows.
  // draft/editingId hold the Ad Setup detail modal's working copy while
  // it's open (see openAdSetupModal/saveAdSetupDraft).
  adSetup: { board: { ad_setup: [], approved: [] }, activeSubtab: 'ready', editingId: null, draft: null },
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
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status; // lets a caller distinguish "you're not allowed" (403) from a real failure
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

// For a module-gated route inside loadAll()'s big initial Promise.all: a
// 403 there is an ordinary, expected outcome for a restricted user (e.g.
// Mark loading the app) -- not a real error -- so it resolves to `fallback`
// instead of rejecting. Any other failure (500, network) still rejects and
// surfaces the same way api() always has, since that IS still worth
// stopping on. Production-readiness audit fix: before this, a single
// blocked module inside that one big Promise.all aborted the ENTIRE
// initial load for a restricted user -- every tab, not just the one they
// don't have access to (confirmed live: Mark's first load failed outright
// once Round 11 started gating /api/board, /api/planning-settings, etc.).
async function apiAllowedOr(path, fallback) {
  try {
    return await api(path);
  } catch (e) {
    if (e.status === 403) return fallback;
    throw e;
  }
}

// ── Auth ─────────────────────────────────────────────
async function login() {
  const email = document.getElementById('pw-email').value;
  const password = document.getElementById('pw-input').value;
  const errEl = document.getElementById('pw-error');
  try {
    const { user, restricted_modules } = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    errEl.classList.remove('show');
    state.currentUser = user;
    state.restrictedModules = restricted_modules || [];
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

// Round 11: hides every sidebar item (and, for a group whose entire
// contents are hidden, the group header too) the current user's
// restricted_modules covers -- see schema.sql's user_module_restrictions
// (deny-list: absence of a row means visible, so an empty array here, true
// for every account today, hides nothing). This is the navigation half of
// module access; requireModuleAccess in server.js is the route/API half --
// see the Round 11 report for which module routes that actually covers.
function applySidebarModuleAccess() {
  const restricted = new Set(state.restrictedModules || []);
  document.querySelectorAll('.tab-btn[data-tab]').forEach((btn) => {
    btn.style.display = restricted.has(btn.dataset.tab) ? 'none' : '';
  });
  document.querySelectorAll('.sidebar-group').forEach((group) => {
    const items = group.querySelectorAll('.tab-btn[data-tab]');
    const allHidden = items.length > 0 && Array.from(items).every((btn) => restricted.has(btn.dataset.tab));
    group.style.display = allHidden ? 'none' : '';
  });
  const usersTabBtn = document.getElementById('settings-users-tab-btn');
  if (usersTabBtn) usersTabBtn.style.display = state.currentUser && state.currentUser.role === 'admin' ? '' : 'none';
}

// Production follow-up pass, round 2: the static index.html already ships
// Create & Review / Production with the `expanded` class baked in (and
// Library without it) -- verified correct in isolation, so this is not
// covering an actual bug in that markup or in toggleSidebarGroup. It exists
// because showApp() is the one moment "the app has just loaded/signed in"
// actually happens in this SPA (called from both login() and
// checkSession()'s session-restore path, and only ever once per page load,
// never again afterward, so it can never fight a user's own toggle click
// mid-session) -- asserting the intended default here too means the
// default no longer depends solely on the served HTML's class attribute
// surviving whatever sits between deploy and browser (a proxy/CDN cache, an
// old service worker, etc.), the same way applySidebarModuleAccess right
// below it already re-asserts visibility here rather than trusting the
// static markup alone.
function applySidebarGroupDefaults() {
  const defaults = { 'create-review': true, production: true, library: false };
  Object.entries(defaults).forEach(([name, shouldBeExpanded]) => {
    const group = document.querySelector(`.sidebar-group[data-group="${name}"]`);
    if (!group) return;
    group.classList.toggle('expanded', shouldBeExpanded);
    const toggleBtn = group.querySelector('.sidebar-group-toggle');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', String(shouldBeExpanded));
  });
}

function showApp() {
  document.getElementById('password-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  renderSidebarUser();
  applySidebarGroupDefaults();
  applySidebarModuleAccess();
  loadAll();
  // Opens straight into the right sidebar tab for a deep link present at
  // load time (e.g. #drops/5, or a pre-restructure #planning/drop/5) --
  // doesn't need to wait on loadAll(), switchTab itself has no data
  // dependency.
  handleHashRoute();
}

async function checkSession() {
  try {
    const { authenticated, user, restricted_modules } = await api('/auth/session');
    if (authenticated) {
      state.currentUser = user;
      state.restrictedModules = restricted_modules || [];
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
// Round 11 sidebar restructure: which collapsible group (if any) each
// grouped tab lives under -- Dashboard/Planning/Upcoming Drops/Promotions/
// Settings stay standalone top-level items, never in a group (see the
// sidebar brief: "Promotions/Upcoming Drops should remain standalone").
const SIDEBAR_GROUP_TABS = {
  'create-review': ['concept-dev', 'tuesday-review'],
  production: ['shooting', 'editing', 'final-approval'],
  library: ['board', 'admin', 'reference-library'],
};

function toggleSidebarGroup(name) {
  const group = document.querySelector(`.sidebar-group[data-group="${name}"]`);
  if (!group) return;
  const expanded = group.classList.toggle('expanded');
  const toggleBtn = group.querySelector('.sidebar-group-toggle');
  if (toggleBtn) toggleBtn.setAttribute('aria-expanded', String(expanded));
}

// Auto-expand (never auto-collapse another group -- a user who deliberately
// opened Library while browsing Production shouldn't have it yanked shut)
// whichever group contains the tab just switched to, so its own nav item is
// never hidden behind a collapsed header on direct navigation.
function autoExpandSidebarGroupForTab(name) {
  const groupName = Object.keys(SIDEBAR_GROUP_TABS).find((g) => SIDEBAR_GROUP_TABS[g].includes(name));
  if (!groupName) return;
  const group = document.querySelector(`.sidebar-group[data-group="${groupName}"]`);
  if (!group || group.classList.contains('expanded')) return;
  group.classList.add('expanded');
  const toggleBtn = group.querySelector('.sidebar-group-toggle');
  if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
}

function switchTab(name) {
  // Defense in depth alongside applySidebarModuleAccess hiding the sidebar
  // button itself -- a restricted user directly manipulating a hash link or
  // browser history could otherwise still land on a panel their own module
  // routes will 403 against anyway (see server.js's requireModuleAccess).
  if ((state.restrictedModules || []).includes(name)) {
    toast("You don't have access to this module.", true);
    return;
  }
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  autoExpandSidebarGroupForTab(name);
  // Shooting is the direct downstream consumer of an action just taken on
  // Tuesday Review (Approve for Shooting) -- unlike every other tab, it
  // needs a fresh fetch on every visit so a concept approved a moment ago
  // reliably shows up without a full page reload.
  if (name === 'shooting') refreshCurrentShootingView();
  if (name === 'reference-library') loadReferenceLibraryPage();
  // Same reasoning as Shooting above -- Editing is the direct downstream
  // consumer of Shooting's Mark as Shot action, so it needs a fresh fetch
  // on every visit too.
  if (name === 'editing') refreshCurrentEditingView();
  // Final Approval is the direct downstream consumer of Editing's Mark as
  // Edited action, so it needs a fresh fetch on every visit too. Loads
  // whichever of its 3 sub-tabs is currently active (see
  // switchFinalApprovalSubtab) -- always Ready for Approval the first time.
  if (name === 'final-approval') loadFinalApprovalActiveSubtab();
  // Upcoming Drops/Promotions are hash-routed within their own tab (list vs
  // drop/product or promotion/stage sub-views -- see renderDropsRoute/
  // renderPromotionsRoute). Arriving here via a plain sidebar click (not a
  // hash navigation) leaves no history entry for the list itself, so
  // browser Back from a drop/promotion detail would skip straight past the
  // list to whatever was on-screen before this tab was ever opened. Only
  // pushes the list hash when not already somewhere in that tab's hash
  // space, so this never fires (or double-pushes) when handleHashRoute
  // itself calls switchTab while routing an already-set #drops/... or
  // #promotions/... hash.
  if (name === 'drops' && !window.location.hash.startsWith('#drops')) window.location.hash = '#drops';
  if (name === 'promotions' && !window.location.hash.startsWith('#promotions')) window.location.hash = '#promotions';
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
  // Round 11: admin-only User Access panel -- loaded lazily on first visit
  // (same reasoning as every other Settings panel: nothing here is needed
  // until an admin actually opens this tab), refetched on every visit so a
  // change made elsewhere (or by another admin) isn't shown stale.
  if (name === 'users') loadUsersAccessPanel();
}

document.querySelectorAll('.settings-subnav-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchSettingsPanel(btn.dataset.settingsPanel));
});

// ── User Access (Settings) ────────────────────────────
// Round 12 redesign: a scannable table (was a wide card per user with 13
// raw checkboxes always on screen) -- Edit opens #user-access-modal, the
// one place that still shows the full module list, now framed positively
// ("can access" instead of "is restricted", see saveUserAccessModal's one
// inversion back to the deny-list the server actually stores).
const MODULE_LABELS = {
  dashboard: 'Dashboard', planning: 'Planning', 'concept-dev': 'Concept Dev',
  'tuesday-review': 'Tuesday Review', shooting: 'Shooting', editing: 'Editing',
  'final-approval': 'Final Approval', board: 'Board', admin: 'Styles & Categories',
  'reference-library': 'Reference Library', drops: 'Upcoming Drops', promotions: 'Promotions',
  settings: 'Settings',
};
// Only the three roles the brief actually wants offered going forward --
// every current account already holds one of these three (see the Round 11
// role migration in schema.sql), so this is never missing an option for a
// real row. The server's own PATCH validation still accepts the legacy
// marketing/creative/viewer values too, purely so it never rejects a role
// this UI didn't itself set -- this dropdown just never offers them.
const USER_ROLES = ['admin', 'lead', 'member'];
const ROLE_LABELS = { admin: 'Admin', lead: 'Lead', member: 'Member' };
// Short column headers for the Module Access matrix (13 modules across is
// too wide for the full MODULE_LABELS text) -- title attribute on each <th>
// carries the full name for anyone who hovers.
const MODULE_SHORT_LABELS = {
  dashboard: 'Dash', planning: 'Plan', 'concept-dev': 'CD', 'tuesday-review': 'TR',
  shooting: 'Shoot', editing: 'Edit', 'final-approval': 'FA', board: 'Board',
  admin: 'Styles', 'reference-library': 'RefLib', drops: 'Drops', promotions: 'Promo',
  settings: 'Sett.',
};

async function loadUsersAccessPanel() {
  const el = document.getElementById('users-access-list');
  try {
    state.usersAccess = await api('/users/manage');
    renderUsersAccessList();
    renderUsersAccessMatrix();
  } catch (e) {
    el.innerHTML = `<tr><td colspan="6" class="empty-state">${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderUsersAccessList() {
  const el = document.getElementById('users-access-list');
  const data = state.usersAccess;
  if (!data) return;
  el.innerHTML = data.users.map((u) => {
    const restrictedCount = u.restricted_modules.length;
    const accessChip = restrictedCount === 0
      ? `<span class="users-access-chip users-access-chip-full">Full Access</span>`
      : `<span class="users-access-chip users-access-chip-restricted">Restricted &middot; ${restrictedCount} module${restrictedCount === 1 ? '' : 's'}</span>`;
    const passwordChip = u.has_password
      ? `<span class="users-access-chip users-access-chip-password-set">Set</span>`
      : `<span class="users-access-chip users-access-chip-password-needed">Needs Setup</span>`;
    return `
      <tr>
        <td>${escapeHtml(u.name)}</td>
        <td class="users-access-email">${escapeHtml(u.email)}</td>
        <td>${ROLE_LABELS[u.role] || escapeHtml(u.role)}</td>
        <td>${accessChip}</td>
        <td>${passwordChip}</td>
        <td><button type="button" class="link-btn" onclick="openUserAccessModal(${u.id})">Edit</button></td>
      </tr>`;
  }).join('');
}

// The Module Access matrix -- users down the left, modules across the top,
// same positive framing as the Edit modal's checkbox list (checked = can
// access) but scannable across everyone at once, per the Round 13 brief.
// Edits here save immediately per checkbox (toggleMatrixAccess below)
// rather than needing an explicit Save, since there's no natural place for
// one row's Save button in a matrix this wide.
function renderUsersAccessMatrix() {
  const el = document.getElementById('users-matrix-table');
  const data = state.usersAccess;
  if (!data) return;
  const headerCells = data.module_keys.map((key) => `<th title="${escapeHtml(MODULE_LABELS[key] || key)}">${escapeHtml(MODULE_SHORT_LABELS[key] || key)}</th>`).join('');
  const rows = data.users.map((u) => {
    const restricted = new Set(u.restricted_modules);
    const cells = data.module_keys.map((key) => `
      <td><input type="checkbox" data-module-key="${key}" ${restricted.has(key) ? '' : 'checked'} onchange="toggleMatrixAccess(${u.id})"></td>`).join('');
    return `<tr data-matrix-user-id="${u.id}"><td class="users-matrix-name">${escapeHtml(u.name)}</td>${cells}</tr>`;
  }).join('');
  el.innerHTML = `<thead><tr><th></th>${headerCells}</tr></thead><tbody>${rows}</tbody>`;
}

// Reads the row's own checkbox states directly (rather than trusting
// state.usersAccess, which could be stale if the admin clicks two boxes
// before the first save round-trips) so a fast run of clicks can never lose
// one of them -- what's on screen for that row is always exactly what gets
// sent. Same PATCH the Edit modal's Save button uses, role omitted so it's
// never touched from here.
async function toggleMatrixAccess(userId) {
  const row = document.querySelector(`tr[data-matrix-user-id="${userId}"]`);
  if (!row) return;
  const checkboxes = row.querySelectorAll('input[type=checkbox]');
  const restrictedModules = Array.from(checkboxes).filter((c) => !c.checked).map((c) => c.dataset.moduleKey);
  try {
    await api(`/users/${userId}/access`, {
      method: 'PATCH',
      body: JSON.stringify({ restricted_modules: restrictedModules }),
    });
    const u = state.usersAccess.users.find((x) => x.id === userId);
    if (u) u.restricted_modules = restrictedModules;
    renderUsersAccessList(); // refresh the Access chip in the main table; leaves the matrix's own checkboxes untouched
    if (state.currentUser && state.currentUser.id === userId) {
      state.restrictedModules = restrictedModules;
      applySidebarModuleAccess();
    }
    toast('Access updated');
  } catch (e) {
    toast(e.message, true);
    await loadUsersAccessPanel(); // resync with the server's actual state after a failed save
  }
}

// Opens with the module list framed POSITIVELY -- checked means this
// person CAN access it, the inverse of restricted_modules (what the server
// actually stores, see schema.sql's user_module_restrictions). This
// function does the one translation; saveUserAccessModal below does it in
// reverse on the way back out, so nothing else in the app ever has to
// reason about the deny-list.
function openUserAccessModal(userId) {
  const data = state.usersAccess;
  const u = data && data.users.find((x) => x.id === userId);
  if (!u) return;
  const restricted = new Set(u.restricted_modules);
  document.getElementById('user-access-id').value = u.id;
  document.getElementById('user-access-modal-title').textContent = `Edit User — ${u.name}`;
  document.getElementById('user-access-modal-name').textContent = u.name;
  document.getElementById('user-access-modal-email').textContent = u.email;
  document.getElementById('user-access-role').value = USER_ROLES.includes(u.role) ? u.role : 'member';
  document.getElementById('user-access-password-status').textContent = u.has_password ? 'Set' : 'Needs Setup';
  document.getElementById('user-access-password-reveal').style.display = 'none';
  document.getElementById('user-access-new-password').value = '';
  document.getElementById('user-access-modules').innerHTML = data.module_keys.map((key) => `
    <label class="user-access-module">
      <input type="checkbox" data-module-key="${key}" ${restricted.has(key) ? '' : 'checked'}>
      ${escapeHtml(MODULE_LABELS[key] || key)}
    </label>`).join('');
  openModal('user-access-modal');
}

// Reveals/hides the new-password input inside the Edit User modal -- kept
// collapsed by default so the modal doesn't invite an accidental reset;
// the actual password is never fetched or displayed, only this empty input.
function toggleUserAccessPasswordReset() {
  const el = document.getElementById('user-access-password-reveal');
  const showing = el.style.display !== 'none';
  el.style.display = showing ? 'none' : 'flex';
  if (!showing) document.getElementById('user-access-new-password').focus();
}

// Separate PATCH from saveUserAccessModal below (role/module access) --
// a password reset is a distinct, higher-stakes action, submitted
// immediately on its own rather than bundled into the next Save click,
// so it can't be accidentally sent (or skipped) by editing something else.
async function submitUserAccessPasswordReset() {
  const userId = Number(document.getElementById('user-access-id').value);
  const input = document.getElementById('user-access-new-password');
  const newPassword = input.value;
  if (!newPassword || newPassword.length < 4) {
    toast('Password must be at least 4 characters', true);
    return;
  }
  try {
    await api(`/users/${userId}/password`, { method: 'PATCH', body: JSON.stringify({ new_password: newPassword }) });
    input.value = '';
    document.getElementById('user-access-password-reveal').style.display = 'none';
    toast('Password updated');
  } catch (e) {
    toast(e.message, true);
  }
}

async function saveUserAccessModal() {
  const userId = Number(document.getElementById('user-access-id').value);
  const role = document.getElementById('user-access-role').value;
  const checkboxes = document.querySelectorAll('#user-access-modules input[type=checkbox]');
  // Invert back to the deny-list the server stores: unchecked ("cannot
  // access") is what actually gets sent as a restriction.
  const restrictedModules = Array.from(checkboxes).filter((c) => !c.checked).map((c) => c.dataset.moduleKey);
  try {
    await api(`/users/${userId}/access`, {
      method: 'PATCH',
      body: JSON.stringify({ role, restricted_modules: restrictedModules }),
    });
    closeModal('user-access-modal');
    toast('Access updated');
    await loadUsersAccessPanel();
    // If the admin just edited their OWN access, the sidebar/settings-tab
    // visibility they're looking at right now needs to reflect it
    // immediately, not just on next reload.
    if (state.currentUser && state.currentUser.id === userId) {
      state.restrictedModules = restrictedModules;
      state.currentUser.role = role;
      applySidebarModuleAccess();
      renderSidebarUser();
    }
  } catch (e) {
    toast(e.message, true);
  }
}

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
    // The routes below marked apiAllowedOr are module-gated (Planning/
    // Board/Styles & Categories) -- a restricted user's 403 on any ONE of
    // them is an expected, normal outcome of viewing the app at all (this
    // Promise.all runs on every login, before the user has chosen a tab),
    // not a real failure, so it resolves to a safe empty fallback instead
    // of rejecting the whole batch. Without this, one blocked module used
    // to abort loadAll() entirely -- see apiAllowedOr's comment.
    const [board, styles, categories, dashboard, dropsRes, provenWinners, coreRes, planningSettings, shootPlan, contentCreators, highStockRes, promotions, weeklyConfirmation, weeklyPlanningProgress, salesCadence, metaProductMappings, metaProductFamilies, conceptDev, creativeResources, customerAvatars, tuesdayReview, shootingWeek, editingWeek, conceptDevLocations, conceptTypes] = await Promise.all([
      apiAllowedOr('/board', null),
      apiAllowedOr('/styles', []),
      apiAllowedOr('/categories', []),
      api(`/dashboard?weekOffset=${dashboardWeekOffset}`),
      api('/drops'),
      apiAllowedOr('/proven-winners', []),
      apiAllowedOr('/core-products', { products: [], weekly_target: 0, weekly_planned: 0, weekly_remaining: 0 }),
      apiAllowedOr('/planning-settings', null),
      apiAllowedOr(`/shoot-plan?week_start=${weekStart}`, []),
      api('/content-creators'),
      apiAllowedOr('/high-stock-products', { products: [] }),
      api('/promotions'),
      apiAllowedOr(`/weekly-shoot-plan-confirmation?week_start=${weekStart}`, null),
      apiAllowedOr(`/weekly-planning-progress?week_start=${weekStart}`, { core_reviewed: false, high_stock_reviewed: false, drops_reviewed: false, promotions_reviewed: false }),
      apiAllowedOr('/sales-cadence', null),
      api('/meta-product-mappings'),
      api('/meta-product-mappings/product-families'),
      api(`/concept-development?week_start=${conceptDevWeekStart()}`),
      api('/creative-resources'),
      api('/customer-avatars'),
      api(`/concept-development?week_start=${tuesdayReviewWeekStart()}`),
      api(`/shooting?week_start=${shootingWeekStart()}`),
      api(`/editing?week_start=${editingWeekStart()}`),
      api('/concept-development/locations'),
      api('/concept-types'),
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
    state.conceptDevLocations = conceptDevLocations;
    state.conceptTypes = conceptTypes;
    // Each render step runs independently -- a module a restricted user
    // can't see (e.g. Board/Core/Planning Settings for Mark, now resolved
    // to an empty/null fallback above) can make ITS OWN render step a
    // no-op or throw on incompatible data, but that must never stop every
    // render AFTER it in this list from running too. Before this, all ~24
    // of these shared one try/catch, so one incompatible shape anywhere in
    // the list silently blanked every tab that comes after it, including
    // ones the user IS allowed to use (Concept Dev, Shooting, Editing...).
    [
      renderBoard, renderMissingAd, renderStylesTable, renderCategoriesTable, populateStyleSelect, populateCategorySelect,
      renderDashboard, renderPlanning, renderProvenWinners, renderCreativeResourcesSettings, renderCustomerAvatarsSettings,
      renderCoreProducts, renderPlanningSettingsForm, renderContentCreators, renderMetaProductMappings, renderHighStockProducts,
      renderPromotionsRow, renderDropsRoute, renderPromotionsRoute, renderPlanningShootSummary, renderConceptDevWeekHeader,
      renderConceptDevList, renderTuesdayReviewWeekHeader, renderTuesdayReviewList, populateShootingOwnerFilters,
      renderShootingWeekHeader, renderShootingWeekView, populateEditingEditorFilter, renderEditingWeekHeader, renderEditingList,
    ].forEach((renderStep) => {
      try {
        renderStep();
      } catch (e) {
        console.error(`loadAll: ${renderStep.name} failed`, e);
      }
    });
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
  // state.board is null when this account doesn't have Board access (see
  // apiAllowedOr in loadAll()) -- the Board tab itself is already hidden
  // for them, so there's nothing to render.
  if (!state.board) return;
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';
  state.board.columns.forEach((col) => {
    const colEl = document.createElement('div');
    colEl.className = 'column';
    // Lets the Dashboard's "Creative Library" card (item 12) scroll straight
    // to where approved work actually lands, instead of just dumping the
    // user at the top of the unfiltered board -- see scrollToApprovedCreative.
    colEl.dataset.status = col.status;
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
    <div class="card-style">${card.style_code ? escapeHtml(card.style_code) + (card.category_name ? ' · ' + escapeHtml(card.category_name) : '') : (card.concept_type ? escapeHtml(card.concept_type) : 'No products required')}</div>
    <div class="card-concept">${escapeHtml(card.concept_name)}</div>
    <div class="card-badges">
      ${card.style_tier ? `<span class="badge badge-tier-${card.style_tier}">${TIER_LABELS[card.style_tier]}</span>` : ''}
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
  if (!state.board) return; // no Board access -- see renderBoard's same guard
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

document.getElementById('action-pipeline').addEventListener('click', () => switchTab('board'));
// Item 12 (production follow-up pass): audited where approved creative
// currently goes -- Final Approval's Approve action sets creative_assets.
// status to 'qc' (src/routes/finalApproval.js), and the Board/Kanban tab
// already shows every asset grouped by that same status with no filter, so
// approved work was never actually inaccessible -- it just wasn't obvious
// this card led there. Rather than building a second storage/filtered view,
// this still opens the existing Board, now scrolled straight to the QC
// column (where Approve lands a concept) so the two "action cards" read
// differently for the same destination instead of behaving identically.
document.getElementById('action-library').addEventListener('click', () => scrollToApprovedCreative());

function scrollToApprovedCreative() {
  switchTab('board');
  requestAnimationFrame(() => {
    const col = document.querySelector('#board .column[data-status="qc"]') || document.querySelector('#board .column[data-status="uploaded_live"]');
    if (col) col.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  });
}
document.getElementById('action-brief-builder').addEventListener('click', () => {
  openBriefBuilderModal();
});

// ── Planning ─────────────────────────────────────────

// Human-readable everywhere a date is displayed (Upcoming Drops' launch
// date/Creative Due, Promotions' date ranges/stage due dates) -- see the
// Shoot Week/Scheduling brief, item 13: raw ISO ("2026-09-24") mixed with
// already-readable dates ("Mon 21 Sep") in the same header. Display only --
// every caller still stores/sends the underlying YYYY-MM-DD string
// unchanged; this never feeds a date input or a comparison, only text.
function formatDate(value) {
  if (!value) return null;
  const dateOnly = String(value).slice(0, 10);
  const [y, m, d] = dateOnly.split('-').map(Number);
  if (!y || !m || !d) return dateOnly;
  const date = new Date(y, m - 1, d);
  const weekday = date.toLocaleDateString('en-AU', { weekday: 'short' });
  const month = date.toLocaleDateString('en-AU', { month: 'short' });
  return `${weekday} ${d} ${month}`;
}

function renderPlanning() {
  renderPlanningWeekHeader();
  renderPlanningStepNav();
  renderDropsRow();
  loadDropSuggestions();
  renderShootPlanStep();
  renderPlanningShootPlanSummary();
}

// ── Planning steps (Monday's guided workflow) ────────
// Core -> High Stocks -> Shoot Plan: one step visible at a time, freely
// clickable forward/backward. No refetch on switch -- everything's already
// loaded by loadAll(). Upcoming Drops and Promotions used to be steps 3
// and 4 here -- they're now their own sidebar tabs (#tab-drops /
// #tab-promotions), so this workflow is Core/High Stocks/Shoot Plan only.
const PLANNING_STEPS = ['core', 'high-stocks', 'shoot-plan'];
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

// ── Upcoming Drops sub-navigation (list / drop / product) ────────────
// Own sidebar tab (#tab-drops), hash-routed so a drop or product is a
// genuinely separate view (not an inline expand), with working
// back/forward. Scheme:
//   #drops
//   #drops/<id>
//   #drops/<id>/product/<productCode>
// Was #planning/drop/... before Upcoming Drops moved out of Planning's
// step flow -- see handleHashRoute below for the redirect that keeps old
// links working.
function parseDropsHash() {
  // renderDropsRoute() (below) runs on EVERY loadAll() refresh regardless
  // of which tab is actually active (see its own comment) -- without this
  // guard, a hash belonging to a different tab entirely (e.g. "#promotions/5"
  // while saving a Promotion concept) falls through the replace() as a
  // no-op and gets misread as dropId = Number("#promotions") = NaN,
  // firing a spurious GET /api/drops/NaN. Caught via live QA on the
  // Promotion New Concept flow (Issue 4), not specific to it.
  if (!window.location.hash.startsWith('#drops')) return { view: 'list' };
  const parts = window.location.hash.replace(/^#drops\/?/, '').split('/').filter(Boolean);
  if (parts[0] && parts[1] === 'product' && parts[2]) {
    return { view: 'product', dropId: Number(parts[0]), productCode: decodeURIComponent(parts[2]) };
  }
  if (parts[0]) return { view: 'drop', dropId: Number(parts[0]) };
  return { view: 'list' };
}

function goToDropsList() {
  window.location.hash = '#drops';
}

// Safe to call on every loadAll() refresh (mirrors renderDropsRow/
// renderPromotionsRow above) -- it only ever touches elements inside
// #tab-drops, never switches which sidebar tab is active, so it can't
// yank someone away from whatever tab they're actually looking at.
// Switching to #tab-drops itself only happens from an actual hashchange
// event or the initial page load -- see handleHashRoute.
function renderDropsRoute() {
  const route = parseDropsHash();
  document.getElementById('drops-list-view').style.display = route.view === 'list' ? 'block' : 'none';
  document.getElementById('planning-drop-view').style.display = route.view === 'drop' ? 'block' : 'none';
  document.getElementById('planning-product-view').style.display = route.view === 'product' ? 'block' : 'none';

  if (route.view === 'drop') {
    loadDropView(route.dropId);
  } else if (route.view === 'product') {
    document.getElementById('product-view-back').onclick = () => { window.location.hash = `#drops/${route.dropId}`; };
    loadProductView(route.dropId, route.productCode);
  }
}

// ── Promotions sub-navigation (list / promotion / stage) ─────────────
// Own sidebar tab (#tab-promotions). Same pattern as Upcoming Drops above.
// Scheme:
//   #promotions
//   #promotions/<id>
//   #promotions/<id>/stage/<stageId>
// Was #planning/promotion/... before Promotions moved out of Planning's
// step flow -- see handleHashRoute below for the redirect.
function parsePromotionsHash() {
  // Same guard as parseDropsHash above, same reason -- renderPromotionsRoute
  // also runs on every loadAll() refresh regardless of active tab.
  if (!window.location.hash.startsWith('#promotions')) return { view: 'list' };
  const parts = window.location.hash.replace(/^#promotions\/?/, '').split('/').filter(Boolean);
  if (parts[0] && parts[1] === 'stage' && parts[2]) {
    return { view: 'promotion-stage', promotionId: Number(parts[0]), stageId: Number(parts[2]) };
  }
  if (parts[0]) return { view: 'promotion', promotionId: Number(parts[0]) };
  return { view: 'list' };
}

function goToPromotionsList() {
  window.location.hash = '#promotions';
}

function renderPromotionsRoute() {
  const route = parsePromotionsHash();
  document.getElementById('promotions-list-view').style.display = route.view === 'list' ? 'block' : 'none';
  document.getElementById('planning-promotion-view').style.display = route.view === 'promotion' ? 'block' : 'none';
  document.getElementById('planning-promotion-stage-view').style.display = route.view === 'promotion-stage' ? 'block' : 'none';

  if (route.view === 'promotion') {
    loadPromotionView(route.promotionId);
  } else if (route.view === 'promotion-stage') {
    document.getElementById('promotion-stage-view-back').onclick = () => { window.location.hash = `#promotions/${route.promotionId}`; };
    loadPromotionStageView(route.promotionId, route.stageId);
  }
}

// ── Hash routing entry point ──────────────────────────────────────────
// Keeps the active sidebar tab in sync with real navigation events (a
// drop/promotion card click, a back-link, browser back/forward, a fresh
// page load on a deep link) -- unlike renderDropsRoute/renderPromotionsRoute
// above, this DOES switch tabs, so it must only ever run from an actual
// hashchange (or once at startup), never from the loadAll() refresh path.
// Also transparently upgrades pre-restructure #planning/drop and
// #planning/promotion links (Upcoming Drops/Promotions used to be Planning
// steps) to their new homes, so old bookmarks/shares keep working.
function handleHashRoute() {
  const hash = window.location.hash;
  if (hash.startsWith('#planning/drop')) {
    window.location.hash = hash.replace('#planning/drop', '#drops');
    return;
  }
  if (hash.startsWith('#planning/promotion')) {
    window.location.hash = hash.replace('#planning/promotion', '#promotions');
    return;
  }
  if (hash.startsWith('#drops')) {
    switchTab('drops');
    renderDropsRoute();
  } else if (hash.startsWith('#promotions')) {
    switchTab('promotions');
    renderPromotionsRoute();
  }
}
window.addEventListener('hashchange', handleHashRoute);

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

// What to Shoot's quick-add picker behaves like a normal dismissible
// popover -- click outside it or press Escape to back out without
// selecting a shot (see closeConceptDevShotQuickAdd; dismissing never
// touches conceptDevModalShots). The "+ Add Shot" trigger itself lives
// inside .cd-shot-quickadd-wrap alongside the menu, so a click on it is
// excluded here -- toggleConceptDevShotQuickAdd's own onclick already
// handles opening/closing that case.
document.addEventListener('click', (e) => {
  const menu = document.getElementById('cd-modal-shot-quickadd-menu');
  if (!menu || menu.style.display === 'none') return;
  if (e.target.closest('.cd-shot-quickadd-wrap')) return;
  closeConceptDevShotQuickAdd();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const menu = document.getElementById('cd-modal-shot-quickadd-menu');
  if (!menu || menu.style.display === 'none') return;
  closeConceptDevShotQuickAdd();
});

// References' "+ Add Reference" menu is the same dismissible popover --
// click outside it or press Escape to close without picking Paste Link or
// Choose From Reference Library (closing never touches conceptDevModalReferences).
// The trigger button lives inside .cd-reference-add-wrap alongside the menu,
// so a click on it is excluded here -- toggleConceptDevReferenceAddMenu's own
// onclick already handles opening/closing that case.
document.addEventListener('click', (e) => {
  const menu = document.getElementById('cd-modal-reference-add-menu');
  if (!menu || menu.style.display === 'none') return;
  if (e.target.closest('.cd-reference-add-wrap')) return;
  closeConceptDevReferenceAddMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const menu = document.getElementById('cd-modal-reference-add-menu');
  if (!menu || menu.style.display === 'none') return;
  closeConceptDevReferenceAddMenu();
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
// drops/promotions stay in these two maps even though they're no longer
// .planning-step-btn steps (that loop below only ever finds the 3 buttons
// that still exist) -- their Mark as Reviewed buttons are still real,
// relocated to #tab-drops/#tab-promotions, and still painted from here.
const PLANNING_STEP_REVIEW_FIELD = { core: 'core_reviewed', 'high-stocks': 'high_stock_reviewed', drops: 'drops_reviewed', promotions: 'promotions_reviewed' };
const PLANNING_STEP_LABELS = { core: '1 Core', 'high-stocks': '2 High Stocks', 'shoot-plan': '3 Shoot Plan' };
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

// What's launching, not just "are we on track" -- the landing page's job is
// primarily "what products are launching and when" (see renderDropsByMonth
// below), so each card leads with a compact product strip built from the
// same per-product data GET /drops/:id already computes for the Drop
// detail page's own coverage grid (see GET /drops in drops.js -- products
// is the lean code/name/image projection of that same coverage array, not
// a second computation). Creative progress/urgency stays, just demoted
// below the products as a secondary line rather than the card's headline.
const DROP_CARD_MAX_PRODUCTS = 4;
function dropCardProductsHtml(products) {
  if (!products || !products.length) {
    return '<div class="drop-card-products-empty">No styles assigned yet</div>';
  }
  const shown = products.slice(0, DROP_CARD_MAX_PRODUCTS);
  const extra = products.length - shown.length;
  // 2-column visual grid (image + name + code per tile) rather than the
  // old cramped single-column text list -- each product's name gets its
  // own line-clamped block instead of being squeezed onto one truncated
  // line next to its code. Still one tile per product_code (already
  // colourway-collapsed upstream by GET /drops), never per colourway.
  const tiles = shown.map((p) => `
    <div class="drop-card-product-tile">
      ${p.image_url ? `<img src="${p.image_url}" alt="">` : '<span class="drop-card-product-noimg">🖼</span>'}
      <span class="drop-card-product-name">${escapeHtml(p.product_name)}</span>
      <span class="drop-card-product-code">${escapeHtml(p.product_code)}</span>
    </div>`).join('');
  const more = extra > 0 ? `<div class="drop-card-product-more">+${extra} more product${extra === 1 ? '' : 's'}</div>` : '';
  return `<div class="drop-card-products">${tiles}${more}</div>`;
}

function dropCardHtml(d) {
  const pct = d.summary.overallPct;
  // Hierarchy fix: the muted/italic treatment is for a genuinely nameless
  // drop only (no manual name AND no fallback could be computed, which in
  // practice never happens once every drop has a launch_date) -- a drop
  // showing its "{Month} Drop {N}" fallback display_name is still a real,
  // useful title and must read exactly as strong as a manually-set one.
  const displayName = d.display_name || d.name || 'Untitled';
  const isPlaceholder = displayName === 'Untitled';
  return `
    <div class="drop-card" data-drop-id="${d.id}">
      <div class="drop-card-header">
        <div class="drop-card-name ${isPlaceholder ? 'untitled' : ''}" data-drop-id="${d.id}" title="Click to rename">${escapeHtml(displayName)}</div>
        <button type="button" class="drop-card-edit-btn" data-drop-id="${d.id}" title="Edit launch date / notes">Edit</button>
      </div>
      <div class="drop-card-date">${formatDate(d.launch_date)} · ${d.days_until_launch >= 0 ? d.days_until_launch + ' days to launch' : 'Launched'}</div>
      ${dropCardProductsHtml(d.products)}
      <div class="drop-card-secondary">
        <span class="drop-card-counts">
          <span class="green">🟢 ${d.summary.green}</span>
          <span class="amber">🟠 ${d.summary.amber}</span>
          <span class="red">🔴 ${d.summary.red}</span>
        </span>
        <span class="drop-card-pct">${d.summary.totalCovered}/${d.summary.totalTarget}${pct !== null ? ' — ' + pct + '%' : ''}</span>
      </div>
      <div class="drop-card-view-link">View Drop &rarr;</div>
    </div>`;
}

// Landing page organisation: "what's launching and when" reads best grouped
// by calendar month, most-imminent first -- state.drops already arrives
// sorted by launch_date ASC (see GET /drops in drops.js), so this is a
// single pass building contiguous same-month runs, not a re-sort. Same
// month-key/month-label pattern as Reference Library's own month grouping
// (referenceLibraryMonthKey/Label) -- kept as its own small pair here
// rather than sharing, since the two features' grouping has no other
// relationship and shouldn't be coupled just because the date math matches.
function dropsMonthKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}`;
}
function dropsMonthLabel(iso) {
  return new Date(iso).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }).toUpperCase();
}
function renderDropsByMonth(drops) {
  const groups = [];
  let current = null;
  for (const d of drops) {
    const key = dropsMonthKey(d.launch_date);
    if (!current || current.key !== key) {
      current = { key, label: dropsMonthLabel(d.launch_date), drops: [] };
      groups.push(current);
    }
    current.drops.push(d);
  }
  return groups.map((g) => `
    <div class="drops-month-group">
      <div class="drops-month-heading">${g.label} <span class="drops-month-count">&middot; ${g.drops.length} drop${g.drops.length === 1 ? '' : 's'}</span></div>
      <div class="drops-row">${g.drops.map(dropCardHtml).join('')}</div>
    </div>`).join('');
}

function wireDropCardRow(row) {
  row.querySelectorAll('.drop-card').forEach((card) => {
    card.addEventListener('click', () => { window.location.hash = `#drops/${card.dataset.dropId}`; });
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
    ? renderDropsByMonth(upcoming)
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
  input.placeholder = (drop && drop.display_name) || 'Untitled';
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
        // A full refetch (not a local patch) so a cleared name picks up its
        // recomputed month-position fallback -- and so every OTHER unnamed
        // drop in the same month re-numbers correctly too, same as the
        // server already does for a fresh page load.
        await api(`/drops/${dropId}`, { method: 'PUT', body: JSON.stringify({ name: newValue }) });
        await refreshDropsRow();
        return;
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
    titleEl.textContent = drop.display_name || drop.name || 'Untitled';
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
    const creativeDue = dropCreativeDueInfo(drop);
    document.getElementById('drop-view-summary').innerHTML = `
      <div><strong>${formatDate(drop.launch_date)}</strong><br>Launch date</div>
      <div><strong>${drop.days_until_launch >= 0 ? drop.days_until_launch : 0}</strong><br>Days to launch</div>
      <div class="${creativeDue.overdue ? 'drop-view-summary-overdue' : ''}"><strong>${creativeDue.text}</strong><br>Creative Due</div>
      <div><strong>${drop.summary.productCount}</strong><br>Products (${drop.summary.styleCount} colourways)</div>
      <div><strong>${drop.summary.totalCovered} / ${drop.summary.totalTarget}</strong><br>Creatives${drop.summary.overallPct !== null ? ' — ' + drop.summary.overallPct + '%' : ''}</div>
    `;
    renderCoverageGrid(drop.coverage);
  } catch (e) {
    toast(e.message, true);
  }
}

// Business rule: all Drop creative should be ready by the Monday
// immediately before launch. For Tue-Sun launches that's the Monday within
// the same calendar week (already strictly before the launch). A Monday
// launch is the one exception -- that same-week Monday IS the launch day,
// not "before" it, so it needs the Monday a full 7 days earlier instead.
// Reuses mondayOfWeek (the same Monday-of-week math Concept Dev's week nav
// already relies on) rather than a second implementation, and launch_date
// is the only input -- no new manually-maintained date anywhere (see the
// follow-up spec's Creative Due ask).
function dropCreativeDueDate(launchDateStr) {
  const launch = new Date(launchDateStr);
  const sameWeekMonday = mondayOfWeek(0, launch);
  const launchIsMonday = isoDateStr(sameWeekMonday) === isoDateStr(launch);
  return launchIsMonday ? mondayOfWeek(-1, launch) : sameWeekMonday;
}

// Only warns when there's something real and measurable to warn about: a
// Drop whose target isn't known yet (AM stock unavailable) can't be judged
// overdue, and a Drop whose required creative is already fully covered
// never reads as alarming just because its date has passed -- see A6's
// same "complete" convention (current_coverage only counts uploaded_live)
// reused here rather than inventing a second definition of "done".
function dropCreativeDueInfo(drop) {
  const due = dropCreativeDueDate(drop.launch_date);
  const dateLabel = due.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysLeft = Math.round((due.getTime() - today.getTime()) / 86400000);
  const target = drop.summary.totalTarget;
  const complete = target > 0 && drop.summary.totalCovered >= target;
  const overdue = daysLeft < 0 && target > 0 && !complete;

  let countdown;
  if (overdue) countdown = 'Creative overdue';
  else if (daysLeft > 0) countdown = `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`;
  else if (daysLeft === 0) countdown = 'due today';
  else countdown = null; // passed, but complete or target unknown -- stay quiet, not alarming

  return {
    text: `${dateLabel}${countdown ? ' · ' + countdown : ''}`,
    overdue,
  };
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
    // Colourway identity (style_code, and colour_label when ApparelMagic
    // resolves one) is local `styles` table data, always known regardless
    // of AM being configured -- only the SOH/On Order figures depend on AM,
    // and colourStatsLine already degrades those to "SOH --" on its own. So
    // this always lists every colourway, rather than the previous all-or-
    // nothing "Stock unavailable" block that hid the colourway list itself
    // whenever AM wasn't connected.
    const colourwayLines = c.styles.map((s) => {
      const label = s.colour_label ? `${escapeHtml(s.style_code)} — ${escapeHtml(s.colour_label)}` : escapeHtml(s.style_code);
      return `<div>${label} · ${colourStatsLine(s)}</div>`;
    }).join('');

    return `
    <div class="coverage-card" data-product-code="${c.product_code}">
      <div class="coverage-card-imgrow">${images}</div>
      <div class="coverage-card-body">
        <div class="coverage-card-name">${escapeHtml(c.product_name)}</div>
        <div class="coverage-card-code">${c.product_code} · ${c.styles.length} colour${c.styles.length === 1 ? '' : 's'}</div>
        <div class="coverage-card-stats-stack">${colourwayLines}</div>
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
      window.location.hash = `#drops/${state.currentDropId}/product/${encodeURIComponent(card.dataset.productCode)}`;
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
  awaiting_concept_development: ['var(--purple-light)', 'var(--purple)'],
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
      window.location.hash = `#drops/${dropId}`;
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
    // Drop planning is oriented around executing the Required Concepts list
    // (tested/proven concepts), not the generic legacy New Creative Asset
    // workflow -- "+ Plan Creative" now opens the exact same simple Add
    // Concept form Required Concepts' own "+ Add New Concept" button does,
    // rather than a second, disconnected way to create a concept (see A3).
    planBtn.onclick = () => {
      showAddNewConceptForm();
      document.getElementById('product-plan-add-new-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    const styleIds = group.styles.map((s) => s.style_id).join(',');
    const assets = await api(`/creative-assets?style_ids=${styleIds}`);
    state.currentProductAssets = assets;
    // Every asset already linked to a Required Concept slot has its own row
    // there -- this section is only for whatever's left (a legacy asset
    // from before Required Concepts existed, or one whose slot was later
    // removed), so a concept is never shown twice on this page (see A7).
    const linkedAssetIds = new Set((currentProductPlan.slots || []).filter((s) => s.asset_id).map((s) => s.asset_id));
    renderProductConcepts(assets.filter((a) => !linkedAssetIds.has(a.id)));
    // Re-render now that state.currentProductAssets is fresh (it feeds the
    // fallback "Link existing" list on any still-unfulfilled slot).
    renderRequiredConcepts(currentProductPlan);
  } catch (e) {
    toast(e.message, true);
  }
}

function renderProductConcepts(assets) {
  const section = document.getElementById('product-view-other-concepts-section');
  const grid = document.getElementById('product-view-concepts');
  // Nothing outside Required Concepts for this product -- hide the whole
  // section rather than show an empty/misleading state (see A7).
  section.style.display = assets.length ? '' : 'none';
  if (!assets.length) {
    grid.innerHTML = '';
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
      openAssetModal(asset, { dropContext: true });
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
  const header = document.getElementById('product-plan-slots-header');
  const note = document.getElementById('product-plan-shortfall-note');
  const addBtn = document.getElementById('product-plan-add-new-btn');

  if (data.target == null) {
    list.innerHTML = '<div class="attention-empty">Stock unavailable — Required Concepts can\'t be generated until SOH is known.</div>';
    header.style.display = 'none';
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
    header.style.display = 'none';
    return;
  }
  header.style.display = 'grid';

  list.innerHTML = data.slots.map((s) => {
    const fulfilled = !!s.asset_id;
    // "Proven" (sourced from a Proven Winner) is the only sourcing badge
    // shown here -- a manually-added slot (source === 'new') gets no badge
    // rather than the old "New/Test" label, which read as the New/
    // Experimental classification language Upcoming Drops planning
    // deliberately never surfaces (see A2 -- this is a tested/proven-concept
    // workflow, not a trial one; the underlying `source` column is untouched,
    // still used below for the Remove action).
    const sourceBadge = s.source === 'proven' ? '<span class="badge badge-tested_proven">Proven</span>' : '';
    const progress = fulfilled ? conceptProgressChecksHtml(s.asset_id, s.asset_status, s.asset_format) : '<span class="pw-slot-progress-empty">—</span>';
    const complete = fulfilled && s.asset_status === 'uploaded_live';
    // Only a fulfilled slot has an asset row to attach a person to -- an
    // open/unfulfilled slot has nowhere to persist Assigned To/Editing yet.
    // Empty (rather than omitted) placeholders in both cases keep every
    // row on the same grid -- see A5.
    const assigneeControl = fulfilled ? `
        <select class="pw-slot-assignee-select" data-asset-id="${s.asset_id}" title="Assigned To">
          <option value=""${!s.asset_concept_assignee ? ' selected' : ''}>Unassigned</option>
          ${CONCEPT_ASSIGNEES.map((name) => `<option value="${name}"${s.asset_concept_assignee === name ? ' selected' : ''}>${name}</option>`).join('')}
        </select>
      ` : '<span class="pw-slot-control-empty">—</span>';
    const editingControl = fulfilled ? `
        <select class="pw-slot-editing-select" data-asset-id="${s.asset_id}" title="Editing">
          <option value=""${!s.asset_editing_owner ? ' selected' : ''}>Unassigned</option>
          ${CONCEPT_ASSIGNEES.map((name) => `<option value="${name}"${s.asset_editing_owner === name ? ' selected' : ''}>${name}</option>`).join('')}
        </select>
      ` : '<span class="pw-slot-control-empty">—</span>';
    // A slot's asset is created automatically the moment the slot exists
    // (Settings already decided the concept name/format/classification),
    // so the normal path is just editing it -- style/target date, or
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
    <div class="pw-slot-row${complete ? ' pw-slot-row-complete' : ''}">
      <span class="pw-slot-rank">${s.slot_rank}</span>
      <span class="pw-slot-name">${escapeHtml(s.concept_name)}</span>
      <span class="pw-slot-col-badge">${sourceBadge}</span>
      <span class="pw-slot-col-assignee">${assigneeControl}</span>
      <span class="pw-slot-col-editing">${editingControl}</span>
      <span class="pw-slot-col-progress">${progress}</span>
      <span class="pw-slot-col-actions">${actions}</span>
    </div>`;
  }).join('');

  list.querySelectorAll('.pw-slot-link-select').forEach((sel) => {
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      linkExistingAsset(Number(sel.dataset.slotId), Number(sel.value));
    });
  });

  list.querySelectorAll('.pw-slot-assignee-select').forEach((sel) => {
    sel.addEventListener('change', () => updateConceptAssignee(Number(sel.dataset.assetId), sel.value || null));
  });

  list.querySelectorAll('.pw-slot-editing-select').forEach((sel) => {
    sel.addEventListener('change', () => updateConceptEditingOwner(Number(sel.dataset.assetId), sel.value || null));
  });

  list.querySelectorAll('.pw-slot-progress-check').forEach((cb) => {
    cb.addEventListener('change', () => toggleConceptProgressStage(Number(cb.dataset.assetId), cb.dataset.stage, cb.checked));
  });
}

// Filmed / Edited / Uploaded to Meta -- three compact checkpoints along the
// concept's own canonical `status` (STATUSES), not three independent
// booleans: Drop concepts never flow through Concept Development/Tuesday
// Review/Shooting/Editing the way Core/Promotion ones do (no
// shoot_plan_item_id, no shoot_schedule row -- see conceptDevelopment.js),
// so `status` is the only production-progress state that exists for one,
// and this is a more granular version of the same direct status toggle
// toggleConceptDone already used (a single "mark done" checkbox). Each
// check reads "has status reached at least this point": Filmed/Shot once
// status is filming or later, Edited once it's passed editing into qc or
// later (qc is real WIP the existing pipeline tracks -- collapsing it into
// "Edited: done, not yet uploaded" rather than adding a 4th check keeps
// this a clean 3-way read of the same 8-stage enum Board already uses).
// key/atLeast/revertTo (the canonical status mapping) are format-agnostic
// and untouched -- only the first stage's user-facing label changes with
// the concept's own `format` (already on creative_assets/FORMATS, not a
// new field): "Shot" reads correctly for a static/photo concept the same
// way "Filmed" does for video. `label` is the fallback for `format` values
// this app doesn't otherwise expect -- FORMATS is a strict ['video',
// 'static'] enum enforced at the API, so in practice every real asset row
// hits one of the two branches below and this default is unreachable.
const CONCEPT_PROGRESS_STAGES = [
  { key: 'filmed', label: 'Filmed', atLeast: 'filming', revertTo: 'concept_script' },
  { key: 'edited', label: 'Edited', atLeast: 'qc', revertTo: 'filming' },
  { key: 'uploaded', label: 'Uploaded to Meta', atLeast: 'uploaded_live', revertTo: 'qc' },
];

function conceptProgressStageLabel(stage, format) {
  if (stage.key === 'filmed') return format === 'static' ? 'Shot' : 'Filmed';
  return stage.label;
}

function conceptProgressChecksHtml(assetId, status, format) {
  const currentIndex = STATUSES.indexOf(status);
  return CONCEPT_PROGRESS_STAGES.map((stage) => {
    const checked = currentIndex >= STATUSES.indexOf(stage.atLeast);
    const label = conceptProgressStageLabel(stage, format);
    return `
      <label class="pw-slot-progress-item" title="${label}">
        <input type="checkbox" class="pw-slot-progress-check" data-asset-id="${assetId}" data-stage="${stage.key}" ${checked ? 'checked' : ''}>
        <span>${label}</span>
      </label>`;
  }).join('');
}

// Reuses the exact same PATCH /creative-assets/:id/status endpoint
// toggleConceptDone (Board's own drag-and-drop) already writes to, so Board
// and this row always agree on where a concept actually sits.
// Unlike updateConceptAssignee/updateConceptEditingOwner (which only ever
// touch Required Concepts rows, since who's assigned never changes how
// many creatives are covered), a status change here CAN move the product's
// own coverage count -- current_coverage only counts 'uploaded_live'
// assets (see coverage.js), so completing/un-completing a concept changes
// the exact number the product summary ("0/10 creatives", "10 more
// required") is built from. loadProductPlan()+renderRequiredConcepts()
// alone never touched that summary at all (#product-view-overview), which
// is why a fully-completed concept used to visually dim/strike through
// while the product summary above it silently stayed at 0/10 (see A3).
// loadProductView() already re-fetches the drop and recomputes that
// summary from the same current_coverage/creative_target the rest of the
// app reads (Planning's Drops row, the Drop detail page) -- reusing it
// here is the same "one canonical refresh path" saveAsset/deleteAsset
// already rely on via refreshProductViewIfOpen(), not a second counter.
async function toggleConceptProgressStage(assetId, stageKey, checked) {
  const stage = CONCEPT_PROGRESS_STAGES.find((s) => s.key === stageKey);
  if (!stage) return;
  const nextStatus = checked ? stage.atLeast : stage.revertTo;
  try {
    await api(`/creative-assets/${assetId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: nextStatus }),
    });
    await loadProductView(state.currentDropId, state.currentProduct.product_code);
    refreshDropsRow();
  } catch (e) {
    toast(e.message, true);
  }
}

async function updateConceptEditingOwner(assetId, editingOwner) {
  try {
    await api(`/creative-assets/${assetId}/assignee`, {
      method: 'PATCH',
      body: JSON.stringify({ editing_owner: editingOwner }),
    });
    const data = await loadProductPlan(state.currentDropId, state.currentProduct.product_code);
    renderRequiredConcepts(data);
  } catch (e) {
    toast(e.message, true);
  }
}

// Saves immediately on change (no separate Save button) -- re-renders from
// the response so the row's visible name and the dropdown's selection stay
// in sync with what's actually persisted. Only this one asset changes;
// every other Required Concept row/slot is untouched.
async function updateConceptAssignee(assetId, conceptAssignee) {
  try {
    await api(`/creative-assets/${assetId}/assignee`, {
      method: 'PATCH',
      body: JSON.stringify({ concept_assignee: conceptAssignee }),
    });
    const data = await loadProductPlan(state.currentDropId, state.currentProduct.product_code);
    renderRequiredConcepts(data);
  } catch (e) {
    toast(e.message, true);
  }
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
    dropContext: true,
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
    openAssetModal(asset, { dropContext: true });
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
  document.getElementById('drop-name').placeholder = (drop && drop.display_name) || 'e.g. Kingswood Cargo Short';
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
  sel.innerHTML = '<option value="">— none —</option>' + state.drops.map((d) => `<option value="${d.id}" ${d.id === selectedId ? 'selected' : ''}>${escapeHtml(d.display_name || d.name || 'Untitled')}</option>`).join('');
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

document.getElementById('new-style-btn').addEventListener('click', () => openStyleModal(null));
document.getElementById('new-category-btn').addEventListener('click', () => {
  document.getElementById('category-name').value = '';
  document.getElementById('category-campaign-id').value = '';
  document.getElementById('category-adset-id').value = '';
  document.getElementById('category-notes').value = '';
  openModal('category-modal');
});

// Opened from an Upcoming Drop (Required Concepts / Other Concepts), this
// modal's fields are entirely oriented around executing tested/proven
// concepts -- the old Kanban Board vocabulary (Concept Classification,
// deliberate-trial, Strategy/Filming/QC owner) doesn't apply and shouldn't
// be shown there (see A2). Board itself, and Core's "+ Plan Creative",
// still need all of it, so the fields are hidden per-open rather than
// removed.
function applyAssetModalDropContext(isDropContext) {
  const display = isDropContext ? 'none' : '';
  document.getElementById('asset-modal-classification-field').style.display = display;
  document.getElementById('asset-modal-trial-field').style.display = display;
  document.getElementById('asset-modal-strategy-filming-row').style.display = display;
  document.getElementById('asset-modal-editing-qc-row').style.display = display;
  // Sidebar-aware centering (see A8) applies only for this Drop-context
  // open, not Board's -- see the matching CSS comment on #asset-modal.
  document.getElementById('asset-modal').classList.toggle('modal-drop-context', isDropContext);
}

function openAssetModal(card, presets = {}) {
  document.getElementById('asset-modal-title').textContent = card ? 'Edit Creative Asset' : 'New Creative Asset';
  applyAssetModalDropContext(!!presets.dropContext);
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

// Promotion intake's own version of the above -- same content_creators
// list/default logic, a separate select since it lives in a different
// modal (see F's "Filming" field).
function populatePromotionShootFilmingSelect(selectId = 'promotion-shoot-filming') {
  const sel = document.getElementById(selectId);
  sel.innerHTML = CONCEPT_ASSIGNEES.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  sel.value = CONCEPT_ASSIGNEES[0];
}

// Shoot Week options for Promotion intake (see the Shoot Week brief) -- "This
// Week"/"Next Week" for the two closest, then "W/C Mon DD Mon" for a dozen
// weeks further out, reusing the same mondayOfWeek/isoDateStr/formatWeekRange
// helpers every other week-nav in the app already builds its own picker from
// (Shooting/Planning/Tuesday Review), not a new date-math implementation.
// Defaults to the current week -- creating a concept never silently commits
// to a future week the team hasn't actually chosen.
function populatePromotionShootWeekOptions() {
  const options = [];
  for (let offset = 0; offset <= 12; offset++) {
    const monday = mondayOfWeek(offset);
    const value = isoDateStr(monday);
    // Same isoWeekNumber() every other week-nav in the app already computes
    // its own "Week N" label from (Shooting/Planning/Tuesday Review/Concept
    // Dev) -- WK NN here is that same number, just formatted for a compact
    // dropdown option rather than a page heading.
    const wk = `WK ${isoWeekNumber(monday)}`;
    let label;
    if (offset === 0) label = `This Week — ${wk}`;
    else if (offset === 1) label = `Next Week — ${wk}`;
    else label = `${wk} — W/C ${monday.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}`;
    options.push({ value, label });
  }
  return options;
}

function populatePromotionShootWeekSelect(selectedValue, selectId = 'promotion-shoot-week') {
  const sel = document.getElementById(selectId);
  const options = populatePromotionShootWeekOptions();
  sel.innerHTML = options.map((o) => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join('');
  sel.value = selectedValue || isoDateStr(mondayOfWeek(0));
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
// 'future' is the neutral state for a stage/promotion with a genuine gap
// that's still comfortably far from launch (see B1/URGENCY_LAUNCH_WINDOW_DAYS
// in promotions.js) -- distinct from 'on_track' (nothing left to do) so it
// never reads as either "handled" or "urgent".
function promotionUrgencyColor(u) { return u === 'at_risk' ? 'red' : u === 'needs_attention' ? 'amber' : u === 'future' ? 'grey' : 'green'; }
// A label for 'at_risk'/'needs_attention'/'on_track' only -- 'future' has
// no label because it gets no badge at all (see promotionUrgencyBadgeHtml
// below). Kept as a separate function anyway, rather than folding the
// blank case in here, since promotionUrgencyLabel is also used directly
// for on_track/needs_attention/at_risk text in a couple of places that
// never see 'future' to begin with.
function promotionUrgencyLabel(u) { return u === 'at_risk' ? 'At Risk' : u === 'needs_attention' ? 'Needs Attention' : 'On Track'; }
// .drop-card-status's classes are named on/needs/at- rather than matching
// the raw color keywords the other status pills use directly as classes.
function dropCardStatusClass(color) { return color === 'green' ? 'on-track' : color === 'amber' ? 'needs-attention' : 'at-risk'; }
// A far-future promotion/stage (outside the ~60-day action window; see B1's
// stageUrgency in promotions.js) gets NO badge at all, not a "Planned"/
// "Upcoming" label -- the record existing isn't the same as anything being
// organised yet, and a real future "genuinely planned" state is explicitly
// out of scope for this pass (see B1's spec). Every consumer of urgency
// badges (landing cards, overview, Campaign Stage cards, stage detail)
// goes through this one helper so "no badge for future" only has to be
// true in one place. The reserved header/card height that already exists
// for alignment (e.g. #promotions-list .drop-card-header{min-height:34px})
// keeps the layout steady with an empty badge area, same as before.
function promotionUrgencyBadgeHtml(urgency) {
  if (urgency === 'future') return '';
  const color = promotionUrgencyColor(urgency);
  return `<div class="drop-card-status ${dropCardStatusClass(color)}">${promotionUrgencyLabel(urgency)}</div>`;
}

// Recurring-series grouping (round 7, item 2): production promotion names
// follow a "{Series Name} {Year}" convention (Black Friday 2026/2027, Boxing
// Day 2026/2027, ...) -- stripping a trailing 4-digit year gives a stable
// series key with no new schema/column needed. A promotion with no trailing
// year is its own one-promotion "series" and is unaffected. Purely a
// display grouping: every record (including future years) stays in the
// database and the API response untouched -- see promotionsFilterToEarliestPerSeries.
function promotionSeriesKey(name) {
  return (name || '').trim().replace(/\s+\d{4}$/, '').trim().toLowerCase() || name;
}

// Keeps only the earliest (soonest-starting) not-yet-past promotion per
// series -- e.g. while Black Friday 2026 is upcoming, Black Friday 2027 is
// hidden from Coming Up/Current Focus; the moment 2026 moves into Past
// Promotions (see promotionsSplitPastUpcoming), 2027 becomes the series'
// earliest remaining record and starts appearing on its own. Input is
// already sorted by start_date ASC (API order), so "first seen per key"
// is already "earliest per key".
function promotionsFilterToEarliestPerSeries(promotions) {
  const seen = new Set();
  const result = [];
  for (const p of promotions) {
    const key = promotionSeriesKey(p.name);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(p);
  }
  return result;
}

// A promotion is "past" once its own end_date has passed (see days_until_end
// in promotions.js -- a promotion with no end_date is never past). Nothing
// is deleted or hidden from the API; this is purely which section of the
// landing page a record renders in (round 7, item 3).
function promotionsSplitPastUpcoming(promotions) {
  const upcoming = [];
  const past = [];
  for (const p of promotions) {
    if (p.days_until_end !== null && p.days_until_end < 0) past.push(p);
    else upcoming.push(p);
  }
  return { upcoming, past };
}

// Current Focus (Issue 3): the promotion actually needing attention right
// now, not just the chronologically-nearest one -- first upcoming
// promotion whose status isn't the neutral 'future' state (same rank
// promotions.js already computes: worst-stage urgency, see summarizePromotion),
// falling back to the nearest-launching one if every upcoming promotion is
// still comfortably far off. Already-sorted-by-start_date input (API order),
// so the fallback is naturally "soonest" too.
function promotionsPickCurrentFocus(allUpcoming) {
  if (!allUpcoming.length) return null;
  return allUpcoming.find((p) => p.status !== 'future') || allUpcoming[0];
}

// One stage's Ready/Target as a compact tile -- same numbers the detail
// page's own Campaign Stage cards show (ca.status via READY_STATUSES,
// summarizeStage in promotions.js), just condensed to fit four across the
// hero instead of a full stage card each.
function promotionFocusStageHtml(stage) {
  return `
    <div class="promo-focus-stage">
      <div class="promo-focus-stage-name">${escapeHtml(stage.name)}</div>
      <div class="promo-focus-stage-count">${stage.ready} / ${stage.target}</div>
    </div>`;
}

function promotionCurrentFocusHtml(p) {
  const color = promotionUrgencyColor(p.status);
  const dateRange = p.end_date ? `${formatDate(p.start_date)} – ${formatDate(p.end_date)}` : formatDate(p.start_date);
  const pct = p.summary.overall_pct;
  const countdownHtml = p.days_until_launch >= 0 ? `${p.days_until_launch} days to launch` : 'Launched';
  return `
    <div class="promo-focus-card" data-promotion-id="${p.id}">
      <div class="promo-focus-eyebrow">🔥 Current Focus</div>
      <div class="promo-focus-header">
        <div class="promo-focus-name">${escapeHtml(p.name)}</div>
        ${promotionUrgencyBadgeHtml(p.status)}
      </div>
      <div class="promo-focus-meta">${dateRange} · ${countdownHtml}</div>
      <div class="promo-focus-ready"><strong>${p.summary.total_ready} / ${p.summary.total_required}</strong> creatives ready${pct !== null ? ` — ${pct}%` : ''}</div>
      ${pct !== null ? `<div class="coverage-progress-track promo-focus-progress"><div class="coverage-progress-fill ${color}" style="width:${Math.min(100, pct)}%;"></div></div>` : ''}
      ${p.stages.length ? `<div class="promo-focus-stages">${p.stages.map(promotionFocusStageHtml).join('')}</div>` : ''}
      <button type="button" class="btn btn-primary promo-focus-cta" data-promotion-id="${p.id}">Continue Planning &rarr;</button>
    </div>`;
}

// Everything else on the rolling major-sales calendar (a promotion counts
// as "active/upcoming" until its own end date passes, not its start date --
// see days_until_end in promotions.js) -- deliberately quiet: no progress
// bar, no stage breakdown, just enough to recognise it and jump in.
function promotionComingUpCardHtml(p) {
  const dateRange = p.end_date ? `${formatDate(p.start_date)} – ${formatDate(p.end_date)}` : formatDate(p.start_date);
  const countdownHtml = p.days_until_launch >= 0 ? `${p.days_until_launch}d to launch` : 'Launched';
  const pct = p.summary.overall_pct;
  return `
    <div class="promo-coming-up-card" data-promotion-id="${p.id}">
      <div class="promo-coming-up-name">${escapeHtml(p.name)}</div>
      <div class="promo-coming-up-meta">${dateRange} · ${countdownHtml}</div>
      ${pct !== null ? `<div class="promo-coming-up-pct">${p.summary.total_ready}/${p.summary.total_required} ready — ${pct}%</div>` : ''}
    </div>`;
}

// Quiet archive treatment (round 7, item 3) -- same data shape as the
// Coming Up card, deliberately without even the ready% line, so a long
// history list never competes visually with Current Focus/Coming Up above
// it. Still fully clickable through to the same Promotion detail page --
// stages/concepts/final creative are all still there to reference.
function promotionPastCardHtml(p) {
  const dateRange = p.end_date ? `${formatDate(p.start_date)} – ${formatDate(p.end_date)}` : formatDate(p.start_date);
  return `
    <div class="promo-past-card" data-promotion-id="${p.id}">
      <div class="promo-past-name">${escapeHtml(p.name)}</div>
      <div class="promo-past-meta">${dateRange}</div>
    </div>`;
}

function wirePromotionsClicks(container) {
  container.querySelectorAll('[data-promotion-id]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      window.location.hash = `#promotions/${el.dataset.promotionId}`;
    });
  });
}

// Collapsed by default (see index.html's promo-past-toggle) -- this just
// flips the disclosure state; renderPromotionsRow doesn't need to re-run
// since the archive list is already rendered, only hidden.
function togglePastPromotions() {
  const body = document.getElementById('promotions-past-body');
  const toggle = document.getElementById('promotions-past-toggle');
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : '';
  toggle.classList.toggle('open', !isOpen);
}

function renderPromotionsRow() {
  const focusEl = document.getElementById('promotions-current-focus');
  if (!focusEl) return; // guards a load race before index.html's panel exists
  const comingUpSection = document.getElementById('promotions-coming-up-section');
  const comingUpList = document.getElementById('promotions-coming-up-list');
  const emptyEl = document.getElementById('promotions-empty-state');
  const pastSection = document.getElementById('promotions-past-section');
  const pastList = document.getElementById('promotions-past-list');
  const pastCount = document.getElementById('promotions-past-count');

  // Every stored promotion still comes back from the API (see
  // promotionsSplitPastUpcoming/promotionsFilterToEarliestPerSeries above) --
  // nothing here ever deletes or hides a record from the database, only
  // which section of the landing page it renders in.
  const { upcoming, past } = promotionsSplitPastUpcoming(state.promotions);
  const eligible = promotionsFilterToEarliestPerSeries(upcoming);

  if (past.length) {
    pastSection.style.display = '';
    pastCount.textContent = `${past.length} past promotion${past.length === 1 ? '' : 's'}`;
    pastList.innerHTML = past.map(promotionPastCardHtml).join('');
    wirePromotionsClicks(pastList);
  } else {
    pastSection.style.display = 'none';
  }

  if (!eligible.length) {
    focusEl.innerHTML = '';
    comingUpSection.style.display = 'none';
    emptyEl.style.display = '';
    return;
  }
  emptyEl.style.display = 'none';

  const focus = promotionsPickCurrentFocus(eligible);
  const rest = eligible.filter((p) => p.id !== focus.id);

  focusEl.innerHTML = promotionCurrentFocusHtml(focus);
  wirePromotionsClicks(focusEl);

  if (rest.length) {
    comingUpSection.style.display = '';
    comingUpList.innerHTML = rest.map(promotionComingUpCardHtml).join('');
    wirePromotionsClicks(comingUpList);
  } else {
    comingUpSection.style.display = 'none';
  }
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
      window.location.hash = `#promotions/${created.id}`;
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
    goToPromotionsList();
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
        ${promotionUrgencyBadgeHtml(p.status)}
      </div>
      <div class="promo-overview-pct-row">
        <div class="promo-overview-pct">${pct !== null ? pct + '%' : '—'}</div>
        <div class="promo-overview-pct-sub">${s.total_ready} / ${s.total_required} Ready · ${p.days_until_launch >= 0 ? p.days_until_launch + ' days to launch' : 'Launched'}</div>
      </div>
      <div class="promo-overview-progress-track"><div class="promo-overview-progress-fill ${color}" style="width:${pct !== null ? Math.min(100, pct) : 0}%;"></div></div>
      <div class="promo-overview-pills">
        <span class="promo-pill promo-pill-target">${s.total_required} Target</span>
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
  const icon = s.urgency === 'at_risk' ? '🔴' : s.urgency === 'needs_attention' ? '🟠' : s.urgency === 'future' ? '⚪' : '🟢';
  return `${icon} ${s.still_required} still required`;
}

// Primary identifier is the concept itself (concept_name, +Concept Type in
// the secondary line), not spi.product_name (a Promotion item has no
// product, so this was empty) or spi.creator (always the silently-defaulted
// Content Creator from savePromotionShootItem, not the real Assigned To --
// see C1's investigation). concept_assignee is the actual Assigned To.
// Final Creative (round 7, item 4): surfaces the SAME final_edits row the
// Editing -> Final Approval workflow already owns (see promotions.js's
// LATERAL join) -- read-only here, no second upload, no media hosting.
// External links (CapCut exports, Drive/Frame.io shares, ...) can't be
// safely embedded as an <img>/<video> without risking a broken tile or
// leaking a referrer to an arbitrary host, so this is deliberately the
// "clean block" fallback the spec calls out rather than attempting a
// preview -- a plain, unambiguous "this concept has a finished cut" signal
// that stays visible once the Promotion moves into Past Promotions too,
// since it's driven by the same read that already renders on the live page.
function promotionStageItemFinalCreativeHtml(item) {
  if (!item.final_edit_link) return '';
  return `
    <div class="promotion-stage-item-final-creative">
      <span class="promotion-stage-item-final-badge">&check; Final Creative</span>
      <a href="${escapeHtml(item.final_edit_link)}" target="_blank" rel="noopener" class="link-btn" onclick="event.stopPropagation()">View Final Creative &rarr;</a>
    </div>`;
}

function promotionStageItemRowHtml(item) {
  const title = item.concept_name || item.product_name || 'Untitled concept';
  const metaParts = [item.concept_type, item.concept_assignee || 'Unassigned', item.asset_status_label || '—'].filter(Boolean);
  return `
    <div class="promotion-stage-item-row">
      <div class="promotion-stage-item-info">
        <div class="promotion-stage-item-name">${escapeHtml(title)}</div>
        <div class="promotion-stage-item-meta">${escapeHtml(metaParts.join(' · '))}</div>
        ${promotionStageItemFinalCreativeHtml(item)}
      </div>
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
        ${stage.urgency === 'future' ? '' : `<div class="promotion-stage-urgency-badge ${color}">${promotionUrgencyLabel(stage.urgency)}</div>`}
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
        <button type="button" class="btn btn-primary btn-sm coverage-card-shoot-btn" onclick="openPromotionAddConceptChooser(${stage.id})">+ Add Concept</button>
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
      window.location.hash = `#promotions/${state.currentPromotionId}/stage/${card.dataset.stageId}`;
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
  const urgencyEl = document.getElementById('promotion-stage-view-urgency');
  if (stage.urgency === 'future') {
    urgencyEl.style.display = 'none';
  } else {
    const color = promotionUrgencyColor(stage.urgency);
    urgencyEl.textContent = promotionUrgencyLabel(stage.urgency);
    urgencyEl.className = `drop-card-status ${dropCardStatusClass(color)}`;
    urgencyEl.style.display = '';
  }

  const dueLabel = stage.due_date ? formatDate(stage.due_date) : 'Not set';
  document.getElementById('promotion-stage-view-summary').innerHTML = `
    <div><strong>${stage.target}</strong><br>Target</div>
    <div><strong>${stage.ready}</strong><br>Ready</div>
    <div><strong>${stage.planned}</strong><br>Planned</div>
    <div><strong>${stage.still_required}</strong><br>Still Required</div>
    <div><strong>${dueLabel}</strong><br>Due date</div>
  `;
  document.getElementById('promotion-stage-view-shoot-btn').onclick = () => openPromotionAddConceptChooser(stage.id);

  const items = stage.items || [];
  const grid = document.getElementById('promotion-stage-view-items');
  if (!items.length) {
    grid.innerHTML = '<div class="attention-empty">Nothing planned for this stage yet — click "+ Add Concept" to send the first requirement into Concept Development.</div>';
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
      const productLabel = asset.style_name || asset.style_code || 'No products required';
      return `
      <div class="job-card" data-asset-id="${asset.id}">
        <div class="job-card-concept">${escapeHtml(productLabel)}</div>
        <div class="job-card-products">${asset.concept_type ? escapeHtml(asset.concept_type) + ' · ' : ''}Concept: ${escapeHtml(asset.concept_name)} · ${asset.format}</div>
        <div class="job-status-row">
          <span class="job-status-pill" style="background:${bg};color:${fg};">${STATUS_LABELS[asset.status]}</span>
          <span class="badge badge-${asset.concept_classification}">${CLASSIFICATION_LABELS[asset.concept_classification]}</span>
        </div>
      </div>`;
    }).join('');
    const itemsByAssetId = new Map(items.map((i) => [i.asset_id, i]));
    grid.querySelectorAll('.job-card').forEach((card) => {
      card.addEventListener('click', () => openPromotionConceptFromStageView(Number(card.dataset.assetId), itemsByAssetId));
    });
  } catch (e) {
    toast(e.message, true);
  }
}

// Every concept in this grid is Promotion-sourced (this view only ever
// renders for a Promotion Campaign Stage), so it always opens the
// Promotion Concept Development modal (see #210) -- never the legacy
// generic Edit Creative Asset modal every other job-card in the app still
// uses. Deliberately never calls switchTab or touches state.conceptDev --
// #planning-promotion-stage-view stays rendered underneath, so closing the
// modal reveals the same Campaign Stage with What We Have still visible.
// promoConceptDevOpenedFromStageView lets the save path refresh this exact
// view afterward instead of the (hidden) Concept Dev tab -- see
// refreshConceptDevAfterChange.
let promoConceptDevOpenedFromStageView = false;

async function openPromotionConceptFromStageView(assetId, itemsByAssetId) {
  const item = itemsByAssetId.get(assetId);
  if (!item) return;
  try {
    const product = await api(`/concept-development/item/${item.id}`);
    const concept = product.concepts.find((c) => c.id === assetId);
    if (!concept) return;
    openPromotionConceptDevModal(concept, product, true);
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

// New vs Existing Concept -- Video only (see schema.sql's comment on
// creative_assets.concept_origin). Reset on every modal open; Static always
// saves null, so this only ever matters when format === 'video'.
let promotionShootConceptOrigin = null;

// Concept Type is reusable vocabulary (state.conceptTypes) classified by an
// optional format ('video'/'static'/NULL=Either, see schema.sql's comment on
// concept_types.format) -- this filters the dropdown to only the types that
// actually apply to the format currently selected, purely client-side (no
// server-side enforcement, no admin UI to classify a type from).
function conceptTypesForFormat(format) {
  return state.conceptTypes.filter((t) => !t.format || t.format === format).map((t) => t.name);
}

// A previously-picked real Concept Type that no longer applies once Format
// changes (e.g. "Flatlay Photo" while switching to Video) gets cleared, not
// silently carried over as bogus "Other" custom text -- but a genuinely
// typed-in custom value (never a real Concept Type name to begin with) has
// nothing to do with Format, so it's left alone. See B4.
function nextConceptTypeValueForFormat(currentValue, format) {
  const validTypes = conceptTypesForFormat(format);
  const isKnownType = state.conceptTypes.some((t) => t.name === currentValue);
  return (!isKnownType || validTypes.includes(currentValue)) ? currentValue : '';
}

// Round 8: "+ Add Concept" opens this small chooser first -- New Concept vs
// Existing Concept, nothing else -- before any form appears at all. Only
// once a card is picked does shootThisWeekForPromotionStage open the actual
// intake modal, already knowing which of the two flows it's collecting for.
let promotionAddConceptChooserStageId = null;

function openPromotionAddConceptChooser(stageId) {
  promotionAddConceptChooserStageId = stageId;
  openModal('promo-add-concept-chooser-modal');
}

function choosePromotionAddConceptOrigin(origin) {
  const stageId = promotionAddConceptChooserStageId;
  closeModal('promo-add-concept-chooser-modal');
  if (stageId == null) return;
  // Production follow-up pass, item 3: New Concept goes straight into the
  // full canonical Concept Development modal (#promo-concept-dev-modal, the
  // SAME entity/endpoints Core/High Stock/Drop already use) in ONE step --
  // no more #promotion-shoot-modal context-collection step that then closed
  // itself and opened a SECOND modal (the old savePromotionShootItem
  // dispatch, see openPromotionConceptDevModalForNewConcept below).
  // Existing Concept is untouched -- it still uses #promotion-shoot-modal's
  // own lightweight inline execution brief, which bypasses Concept
  // Development/Tuesday Review entirely by design (see item 4/
  // isPromotionShootExistingBrief).
  if (origin === 'existing') {
    shootThisWeekForPromotionStage(stageId, 'existing');
  } else {
    openPromotionConceptDevModalForNewConcept(stageId);
  }
}

// Builds the minimal synthetic "product" context openPromotionConceptDevModal
// needs (promotion/stage name+notes for its read-only context rows) when
// there's no real product/shoot_plan_item yet at all -- exactly the two
// pieces of context #promotion-shoot-modal used to show before this pass,
// nothing else invented.
function openPromotionConceptDevModalForNewConcept(stageId) {
  const promotion = state.currentPromotion;
  const stage = ((promotion && promotion.stages) || []).find((s) => s.id === stageId);
  if (!stage) return;
  const syntheticProduct = {
    shoot_plan_item_id: null,
    product_name: null,
    image_url: null,
    creator: null,
    colourways: [],
    promotion_name: promotion.name,
    promotion_notes: promotion.notes,
    promotion_stage_name: stage.name,
  };
  openPromotionConceptDevModal(null, syntheticProduct, false, stageId);
}

// origin ('new'/'existing') is decided up front by the chooser above (round
// 8) -- this modal no longer asks the question itself, it just collects
// whatever each path still needs. New Concept: Format/Concept Name/Filming/
// Editing/Shoot Week only, then straight into the full canonical Concept
// Development modal (see savePromotionShootItem). Existing Concept: the
// same context plus the lightweight execution brief further down.
function shootThisWeekForPromotionStage(stageId, origin) {
  const promotion = state.currentPromotion;
  const stage = ((promotion && promotion.stages) || []).find((s) => s.id === stageId);
  if (!stage) return;
  promotionShootContext = { stageId };
  document.getElementById('promotion-shoot-modal-title').textContent = origin === 'existing' ? 'Existing Concept' : 'New Concept';
  document.getElementById('promotion-shoot-context-promotion').textContent = promotion.name;
  document.getElementById('promotion-shoot-context-stage').textContent = stage.name;
  document.getElementById('promotion-shoot-editing-owner').value = '';
  document.getElementById('promotion-shoot-concept-name').value = '';
  document.getElementById('promotion-shoot-format').value = 'video';
  // Same dropdown/default-selection logic as Core's own
  // populateShootPlanCreatorSelect -- kept as its own small function since
  // the two modals' selects have different ids, not because the logic
  // differs.
  populatePromotionShootFilmingSelect();
  populatePromotionShootWeekSelect();
  fillConceptDevSelectWithOther('promotion-shoot-concept-type-select', 'promotion-shoot-concept-type-custom', conceptTypesForFormat('video'), '');
  promotionShootConceptOrigin = origin === 'existing' ? 'existing' : 'new';
  resetPromotionShootBrief();
  updatePromotionShootConceptTypeVisibility();
  updatePromotionShootBriefVisibility();
  updatePromotionShootFooterButton();
  openModal('promotion-shoot-modal');
}

// Existing Concept's lightweight execution-brief fields, staged locally
// (not persisted) until Save -- same reasoning as the modal-open reset
// everywhere else in this file (e.g. shoot-plan-modal's own defaults):
// reopening this modal for a fresh concept must never carry over the last
// concept's brief.
let promotionShootAltHooks = [];
let promotionShootReferences = [];
let promotionShootBriefStyles = [];

function resetPromotionShootBrief() {
  promotionShootAltHooks = [];
  promotionShootReferences = [];
  promotionShootBriefStyles = [];
  document.getElementById('promotion-shoot-hook-primary').value = '';
  document.getElementById('promotion-shoot-execution').value = '';
  document.getElementById('promotion-shoot-script').value = '';
  document.getElementById('promotion-shoot-location').value = '';
  document.getElementById('promotion-shoot-style-search').value = '';
  document.getElementById('promotion-shoot-style-results').style.display = 'none';
  document.getElementById('promotion-shoot-reference-url').value = '';
  document.getElementById('promotion-shoot-script-field').style.display = 'none';
  document.getElementById('promotion-shoot-script-toggle-wrap').style.display = '';
  renderPromotionShootAltHooks();
  renderPromotionShootReferences();
  renderPromotionShootBriefStyleChips();
}

function togglePromotionShootScript() {
  document.getElementById('promotion-shoot-script-toggle-wrap').style.display = 'none';
  document.getElementById('promotion-shoot-script-field').style.display = '';
}

function addPromotionShootAltHook() {
  promotionShootAltHooks.push('');
  renderPromotionShootAltHooks();
}

function updatePromotionShootAltHook(idx, value) {
  promotionShootAltHooks[idx] = value;
}

function removePromotionShootAltHook(idx) {
  promotionShootAltHooks.splice(idx, 1);
  renderPromotionShootAltHooks();
}

function renderPromotionShootAltHooks() {
  const el = document.getElementById('promotion-shoot-hooks-alt-list');
  if (!el) return;
  el.innerHTML = promotionShootAltHooks.map((text, idx) => `
    <div class="promo-shoot-alt-hook-row">
      <input type="text" value="${escapeHtml(text)}" placeholder="Alternative hook" oninput="updatePromotionShootAltHook(${idx}, this.value)">
      <button type="button" class="cd-style-chip-remove" onclick="removePromotionShootAltHook(${idx})" title="Remove">&times;</button>
    </div>`).join('');
}

function addPromotionShootReference() {
  const input = document.getElementById('promotion-shoot-reference-url');
  const url = input.value.trim();
  if (!url) return;
  promotionShootReferences.push({ url, note: '' });
  input.value = '';
  renderPromotionShootReferences();
}

function removePromotionShootReference(idx) {
  promotionShootReferences.splice(idx, 1);
  renderPromotionShootReferences();
}

function renderPromotionShootReferences() {
  const el = document.getElementById('promotion-shoot-reference-list');
  if (!el) return;
  el.innerHTML = promotionShootReferences.map((r, idx) => `
    <div class="promo-shoot-reference-row">
      <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(truncateText(r.url, 50))}</a>
      <button type="button" class="cd-style-chip-remove" onclick="removePromotionShootReference(${idx})" title="Remove">&times;</button>
    </div>`).join('');
}

function removePromotionShootBriefStyle(styleId) {
  promotionShootBriefStyles = promotionShootBriefStyles.filter((s) => s.style_id !== styleId);
  renderPromotionShootBriefStyleChips();
}

function renderPromotionShootBriefStyleChips() {
  const el = document.getElementById('promotion-shoot-style-chips');
  if (!el) return;
  el.innerHTML = promotionShootBriefStyles.map((s) => `
    <span class="cd-style-chip">${escapeHtml(s.style_code)}${s.name ? ` <span class="cd-style-chip-code">${escapeHtml(s.name)}</span>` : ''}
      <button type="button" class="cd-style-chip-remove" onclick="removePromotionShootBriefStyle(${s.style_id})" title="Remove">&times;</button>
    </span>`).join('');
}

// Whether the current Format/Concept Approach combination is the Existing
// Concept bypass -- the one branch point every visibility toggle and the
// save handler itself all key off, kept in one place so they can never
// disagree with each other. Concept Approach is decided by the chooser
// modal (round 8) before this modal ever opens, not by an in-modal toggle.
function isPromotionShootExistingBrief() {
  const format = document.getElementById('promotion-shoot-format').value;
  return format === 'video' && promotionShootConceptOrigin === 'existing';
}

// Concept Type: hidden for Video + New Concept (still needs developing --
// asking for a Concept Type before the idea itself is even shaped is
// premature; it can be chosen later in Concept Development). Shown for
// Video + Existing Concept (selecting an established execution) and for
// Static (no New/Existing distinction applies there at all -- unchanged
// from before this pass).
function updatePromotionShootConceptTypeVisibility() {
  const format = document.getElementById('promotion-shoot-format').value;
  const show = format !== 'video' || promotionShootConceptOrigin === 'existing';
  document.getElementById('promotion-shoot-concept-type-wrap').style.display = show ? '' : 'none';
}

// Round 8: the execution brief (Hook/What to Shoot/Styles/References/
// Script/Shoot Setup) is Existing Concept only again -- New Concept has no
// inline field set here at all any more, it goes straight into the full
// canonical Concept Development modal instead (see savePromotionShootItem).
function updatePromotionShootBriefVisibility() {
  const isExisting = isPromotionShootExistingBrief();
  document.getElementById('promotion-shoot-brief-wrap').style.display = isExisting ? '' : 'none';
  document.getElementById('promotion-shoot-style-section').style.display = isExisting ? '' : 'none';
}

// New Concept and Static both continue into the full Concept Development
// modal (see savePromotionShootItem's fallback) -- same CTA either way,
// this is just a context-collection step before that modal opens.
function updatePromotionShootFooterButton() {
  const btn = document.getElementById('promotion-shoot-save-btn');
  btn.textContent = isPromotionShootExistingBrief() ? 'Add to Shoot Plan →' : 'Develop Promotion Concept →';
}

// Re-filters the Concept Type dropdown when Format changes, keeping
// whatever was already picked/typed if it's still valid for the new format.
// Concept Approach (New/Existing) only ever applies to Video -- switching to
// Static clears the choice so it can never be silently carried over and
// saved against a Static concept (which always persists concept_origin =
// NULL, see schema.sql).
function onPromotionShootFormatChange() {
  const currentValue = conceptDevSelectWithOtherValue('promotion-shoot-concept-type-select', 'promotion-shoot-concept-type-custom');
  const format = document.getElementById('promotion-shoot-format').value;
  const nextValue = nextConceptTypeValueForFormat(currentValue, format);
  fillConceptDevSelectWithOther('promotion-shoot-concept-type-select', 'promotion-shoot-concept-type-custom', conceptTypesForFormat(format), nextValue);
  if (format !== 'video') promotionShootConceptOrigin = null;
  updatePromotionShootConceptTypeVisibility();
  updatePromotionShootBriefVisibility();
  updatePromotionShootFooterButton();
}

// Searchable product/style picker -- SKU or name, partial, case-insensitive
// -- reusing the same "SKU — Product Name" display convention already used
// everywhere else styles are listed (e.g. the old giant <select>), just
// filtered as you type instead of scrolled through. Shared by every modal
// that needs to pick an arbitrary tracked style with no pre-known product
// context (Promotion's "+ Shoot This Week" below, Brief Builder's "Start
// Concept") -- one search implementation, not a copy per modal.
function renderStyleSearchResults(inputId, resultsId, onSelect) {
  const query = document.getElementById(inputId).value.trim().toLowerCase();
  const results = document.getElementById(resultsId);
  if (!query) { results.style.display = 'none'; results.innerHTML = ''; return; }
  const matches = state.styles.filter((s) =>
    (s.style_code && s.style_code.toLowerCase().includes(query)) ||
    (s.name && s.name.toLowerCase().includes(query))
  ).slice(0, 20);
  if (!matches.length) {
    results.innerHTML = '<div class="promo-shoot-search-empty">No matching product / style</div>';
    results.style.display = '';
    return;
  }
  results.innerHTML = matches.map((s) =>
    `<div class="promo-shoot-search-result" data-style-id="${s.id}">${escapeHtml(s.style_code)} — ${escapeHtml(s.name)}</div>`
  ).join('');
  results.style.display = '';
  results.querySelectorAll('.promo-shoot-search-result').forEach((row) => {
    row.addEventListener('click', () => onSelect(Number(row.dataset.styleId)));
  });
}

// Existing Concept's execution-brief Styles/Products search -- multi-select,
// staged in promotionShootBriefStyles (not persisted) until Save, since the
// shoot_plan_item this needs to attach to doesn't exist yet while the modal
// is still open. Persisted via the same POST /shoot-plan/:id/styles Concept
// Development's own picker already uses, once savePromotionShootItem has an
// item id to attach them to.
function filterPromotionShootStyles() {
  renderStyleSearchResults('promotion-shoot-style-search', 'promotion-shoot-style-results', selectPromotionShootStyle);
}

function selectPromotionShootStyle(styleId) {
  const style = state.styles.find((s) => s.id === styleId);
  if (!style || promotionShootBriefStyles.some((s) => s.style_id === styleId)) return;
  promotionShootBriefStyles.push({ style_id: styleId, style_code: style.style_code, name: style.name });
  renderPromotionShootBriefStyleChips();
  document.getElementById('promotion-shoot-style-search').value = '';
  document.getElementById('promotion-shoot-style-results').style.display = 'none';
}

async function savePromotionShootItem() {
  if (!promotionShootContext) return;
  const conceptName = document.getElementById('promotion-shoot-concept-name').value.trim();
  if (!conceptName) return toast('Concept Name / Idea is required', true);
  const conceptType = conceptDevSelectWithOtherValue('promotion-shoot-concept-type-select', 'promotion-shoot-concept-type-custom');
  const editingOwner = document.getElementById('promotion-shoot-editing-owner').value || null;
  const format = document.getElementById('promotion-shoot-format').value;
  // Concept Approach is a required choice for Video only -- Static always
  // saves concept_origin = NULL (see schema.sql's comment on the column).
  if (format === 'video' && !promotionShootConceptOrigin) {
    return toast('Choose New Concept or Existing Concept', true);
  }
  const isExistingBrief = isPromotionShootExistingBrief();

  // No product is picked here at all -- the concept-first flow (see the
  // file-header comment above) never requires one; product_code/product_name
  // are simply omitted, leaving shoot_plan_item_styles empty ("No products
  // required") unless the Existing Concept brief's own Styles/Products
  // search below adds some. Sample status isn't asked for. Filming
  // (creator) is a real, required choice sourced from CONCEPT_ASSIGNEES
  // (see populatePromotionShootFilmingSelect), never silently defaulted.
  const filming = document.getElementById('promotion-shoot-filming').value || CONCEPT_ASSIGNEES[0];

  // "Other / New Type" persists to concept_types immediately, same
  // reasoning as saveConceptDevModal -- it becomes reusable right away,
  // even before the concept's own workspace is opened.
  if (conceptType && !state.conceptTypes.some((t) => t.name.toLowerCase() === conceptType.toLowerCase())) {
    try {
      const created = await api('/concept-types', { method: 'POST', body: JSON.stringify({ name: conceptType }) });
      state.conceptTypes.push(created);
    } catch (e) { /* non-fatal */ }
  }

  try {
    const item = await api('/shoot-plan', {
      method: 'POST',
      body: JSON.stringify({
        concept_name: conceptName,
        concept_type: conceptType || null,
        concept_assignee: null,
        editing_owner: editingOwner,
        creator: filming,
        format,
        source: 'promotion',
        promotion_stage_id: promotionShootContext.stageId,
        week_start: document.getElementById('promotion-shoot-week').value,
      }),
    });
    // Concept Approach isn't part of POST /shoot-plan's payload (that
    // endpoint is shared with Core/High Stock/Drop) -- persist it with an
    // immediate follow-up PATCH, same create-then-PATCH pattern
    // savePromotionConceptDevModal's own create path already uses.
    //
    // Existing Concept goes further in that same PATCH: concept_dev_status
    // is set straight to 'approved' plus the execution-brief fields, which
    // (see conceptDevelopment.js's ensureShootScheduleForApprovedConcept)
    // creates the concept's shoot_schedule row server-side in the same
    // request -- bypassing Concept Development/Tuesday Review entirely and
    // landing it Unscheduled in Shooting's selected Shoot Week. Styles
    // staged in the brief are attached afterward via the same
    // POST /shoot-plan/:id/styles Concept Development's own picker uses.
    if (isExistingBrief) {
      const hookVariations = [];
      const primaryHook = document.getElementById('promotion-shoot-hook-primary').value.trim();
      if (primaryHook) hookVariations.push({ text: primaryHook });
      promotionShootAltHooks.forEach((text) => {
        const trimmed = (text || '').trim();
        if (trimmed) hookVariations.push({ text: trimmed });
      });
      const execution = document.getElementById('promotion-shoot-execution').value.trim();
      const scriptNotes = document.getElementById('promotion-shoot-script').value.trim();
      const location = document.getElementById('promotion-shoot-location').value.trim();
      await api(`/concept-development/concepts/${item.asset_id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          concept_origin: 'existing',
          concept_dev_status: 'approved',
          hook_variations: hookVariations,
          execution: execution || null,
          script_notes: scriptNotes || null,
          location: location || null,
          reference_items: promotionShootReferences,
        }),
      });
      for (const s of promotionShootBriefStyles) {
        try {
          await api(`/shoot-plan/${item.id}/styles`, {
            method: 'POST',
            body: JSON.stringify({ style_id: s.style_id, colour_label: null, size: null }),
          });
        } catch (e) { /* non-fatal -- concept is already scheduled either way */ }
      }
    }
    closeModal('promotion-shoot-modal');
    toast(isExistingBrief ? 'Added to Shoot Plan' : 'Added to Concept Development');
    await refreshCurrentPromotion();
    if (document.getElementById('planning-promotion-stage-view').style.display !== 'none') {
      renderPromotionStageDetailView();
    }
    await loadAll();
    // Existing Concept finishes entirely inline, in this one modal -- it
    // never opens a second modal. Everything else (New Concept, round 8;
    // Static, unchanged from before) continues into the SAME full canonical
    // Concept Development modal normal Concept Development uses -- this
    // modal was only ever collecting the context (Format/Name/Filming/
    // Editing/Shoot Week) that modal doesn't itself ask for.
    if (isExistingBrief) return;
    const product = await api(`/concept-development/item/${item.id}`);
    const seedConcept = product.concepts && product.concepts[0];
    if (seedConcept) openPromotionConceptDevModal(seedConcept, product);
  } catch (e) {
    toast(e.message, true);
  }
}

// ── Dashboard -- Brief Builder: Select Product -> Concept Development ────
// The entry point for starting a normal product creative brief. No
// pre-known product context (unlike a Core product row's own "Shoot This
// Week"), so this reuses the exact same searchable style picker as
// Promotion's "+ Shoot This Week" above (renderStyleSearchResults). Feeds
// the exact same Concept Development pipeline via POST /shoot-plan (source:
// 'core' -- fresh creative for an existing product, not drop/high_stock/
// promotion) -- one normal concept entity, no separate Brief Builder record
// type.
let briefBuilderContext = null;

function openBriefBuilderModal() {
  briefBuilderContext = { styleId: null };
  document.getElementById('brief-builder-style-search').value = '';
  document.getElementById('brief-builder-style-id').value = '';
  document.getElementById('brief-builder-style-results').style.display = 'none';
  document.getElementById('brief-builder-format').value = 'video';
  openModal('brief-builder-modal');
}

function filterBriefBuilderStyles() {
  renderStyleSearchResults('brief-builder-style-search', 'brief-builder-style-results', selectBriefBuilderStyle);
}

function selectBriefBuilderStyle(styleId) {
  const style = state.styles.find((s) => s.id === styleId);
  if (!style) return;
  briefBuilderContext.styleId = styleId;
  document.getElementById('brief-builder-style-id').value = styleId;
  document.getElementById('brief-builder-style-search').value = `${style.style_code} — ${style.name}`;
  document.getElementById('brief-builder-style-results').style.display = 'none';
}

async function startBriefBuilderConcept() {
  if (!briefBuilderContext) return;
  const styleId = Number(document.getElementById('brief-builder-style-id').value);
  const style = state.styles.find((s) => s.id === styleId);
  if (!style) return toast('Select a product / style', true);
  const format = document.getElementById('brief-builder-format').value;

  // Same silent-default reasoning as Promotion's savePromotionShootItem
  // above -- stock status/size/creator aren't asked for here, shoot-plan.js
  // still needs sensible values for every item regardless of source.
  const defaultCreator = state.contentCreators.find((c) => c.is_default) || state.contentCreators[0];

  // Always today's actual current week, independent of whatever week
  // Planning's or Concept Dev's own navigation might currently be scrolled
  // to -- Brief Builder is a Dashboard shortcut, not a Planning action, so
  // it shouldn't inherit either tab's transient nav state.
  const weekStart = isoDateStr(mondayOfWeek(0));

  try {
    const item = await api('/shoot-plan', {
      method: 'POST',
      body: JSON.stringify({
        product_code: style.style_code,
        product_name: style.name,
        colourways: [{ style_id: style.id, size: null, colour_label: null }],
        stock_status: 'needs_to_be_brought_in',
        creator: defaultCreator ? defaultCreator.name : DEFAULT_CREATOR,
        format,
        source: 'core',
        week_start: weekStart,
      }),
    });
    closeModal('brief-builder-modal');

    // Concept Development only lists a week once its Shoot Plan has been
    // confirmed (see weeklyShootPlanConfirmation.js and GET / in
    // conceptDevelopment.js) -- but starting a concept and confirming the
    // whole week's Shoot Plan are different actions, and Brief Builder must
    // never silently do the latter (that would also expose everyone else's
    // still-in-progress picks for the week). So this opens the new item
    // standalone instead, via GET /concept-development/item/:id -- a
    // narrow, additive read that returns this one item's own Concept
    // Development data independent of its week's confirmation state. The
    // week's confirmation is left completely untouched.
    switchTab('concept-dev');
    await openConceptDevProductStandalone(item.id);
    toast('Concept started');
  } catch (e) {
    toast(e.message, true);
  }
}

// ── Concept Development -- "+ New Concept" (production follow-up pass,
// item 2): a spontaneous/ad-hoc concept a creator can start directly from
// Concept Development itself, with no Planning product/week prerequisite.
// Product/style linking is OPTIONAL and multi-select (unlike Brief
// Builder's single required style) -- reuses the same renderStyleSearchResults
// picker and staged-array-until-save pattern as Promotion's Existing Concept
// brief (promotionShootBriefStyles). Feeds the exact same POST /shoot-plan +
// canonical #concept-dev-modal pipeline every other source uses, with
// source: 'manual' so it reaches Tuesday Review without waiting on Planning
// to confirm that week's Shoot Plan (see conceptDevelopment.js's GET /
// bypass, extended to cover 'manual' the same way it already covers
// 'promotion'). No second concept system, no new entity.
let adHocConceptStyles = [];

function openAdHocConceptModal() {
  adHocConceptStyles = [];
  document.getElementById('adhoc-concept-name').value = '';
  document.getElementById('adhoc-concept-format').value = 'video';
  document.getElementById('adhoc-concept-style-search').value = '';
  document.getElementById('adhoc-concept-style-results').style.display = 'none';
  renderAdHocConceptStyleChips();
  openModal('adhoc-concept-modal');
}

function filterAdHocConceptStyles() {
  renderStyleSearchResults('adhoc-concept-style-search', 'adhoc-concept-style-results', selectAdHocConceptStyle);
}

function selectAdHocConceptStyle(styleId) {
  const style = state.styles.find((s) => s.id === styleId);
  if (!style || adHocConceptStyles.some((s) => s.style_id === styleId)) return;
  adHocConceptStyles.push({ style_id: styleId, style_code: style.style_code, name: style.name });
  renderAdHocConceptStyleChips();
  document.getElementById('adhoc-concept-style-search').value = '';
  document.getElementById('adhoc-concept-style-results').style.display = 'none';
}

function removeAdHocConceptStyle(styleId) {
  adHocConceptStyles = adHocConceptStyles.filter((s) => s.style_id !== styleId);
  renderAdHocConceptStyleChips();
}

function renderAdHocConceptStyleChips() {
  const el = document.getElementById('adhoc-concept-style-chips');
  if (!el) return;
  el.innerHTML = adHocConceptStyles.map((s) => `
    <span class="cd-style-chip">${escapeHtml(s.style_code)}${s.name ? ` <span class="cd-style-chip-code">${escapeHtml(s.name)}</span>` : ''}
      <button type="button" class="cd-style-chip-remove" onclick="removeAdHocConceptStyle(${s.style_id})" title="Remove">&times;</button>
    </span>`).join('');
}

async function saveAdHocConcept() {
  const conceptName = document.getElementById('adhoc-concept-name').value.trim();
  if (!conceptName) return toast('Concept Name is required', true);
  const format = document.getElementById('adhoc-concept-format').value;
  const defaultCreator = state.contentCreators.find((c) => c.is_default) || state.contentCreators[0];
  const weekStart = isoDateStr(mondayOfWeek(0));

  try {
    const item = await api('/shoot-plan', {
      method: 'POST',
      body: JSON.stringify({
        concept_name: conceptName,
        colourways: adHocConceptStyles.map((s) => ({ style_id: s.style_id, size: null, colour_label: null })),
        creator: defaultCreator ? defaultCreator.name : DEFAULT_CREATOR,
        format,
        source: 'manual',
        week_start: weekStart,
      }),
    });
    closeModal('adhoc-concept-modal');
    switchTab('concept-dev');
    await openConceptDevProductStandalone(item.id);
    toast('Concept started');
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
  state.conceptDev.standaloneItemId = null;
  conceptDevStandaloneProduct = null;
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
const CONCEPT_DEV_SOURCE_LABELS = { core: 'Core', high_stock: 'High Stock', drop: 'Upcoming Drop', promotion: 'Promotion', manual: 'Ad-hoc' };
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

// A single item's own Concept Development workspace, fetched independent
// of its week's Shoot Plan confirmation (see GET /concept-development/item/
// :id) -- used only by Dashboard -> Brief Builder's "Start Concept", which
// creates a fresh core-sourced item on demand and must never silently
// confirm the whole week's Shoot Plan just to open it. Every other entry
// point into a product's workspace goes through the normal weekly list
// (openConceptDevProduct above), untouched.
let conceptDevStandaloneProduct = null;

async function openConceptDevProductStandalone(itemId) {
  try {
    conceptDevStandaloneProduct = await api(`/concept-development/item/${itemId}`);
    state.conceptDev.view = 'product';
    state.conceptDev.currentItemId = itemId;
    state.conceptDev.standaloneItemId = itemId;
    renderConceptDevList();
  } catch (e) {
    toast(e.message, true);
  }
}

// Re-renders whatever product workspace is currently open after a save or
// delete -- standalone items refetch via their own item endpoint (never
// the week-scoped one, which would come back empty for an unconfirmed
// week), everything else keeps the existing weekly reload unchanged.
async function refreshConceptDevAfterChange() {
  if (state.conceptDev.standaloneItemId != null) {
    await openConceptDevProductStandalone(state.conceptDev.standaloneItemId);
  } else {
    loadConceptDevWeek();
  }
}

function closeConceptDevProduct() {
  state.conceptDev.view = 'list';
  state.conceptDev.currentItemId = null;
  state.conceptDev.standaloneItemId = null;
  conceptDevStandaloneProduct = null;
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
  // Promotion-sourced products need the Promotion name front and centre --
  // the pathway badge below only carries the Campaign Stage name, so
  // someone opening this workspace cold (e.g. from a Concept Development
  // link, not having come from the Promotion page) wouldn't otherwise know
  // WHY this concept exists. Scoped to source === 'promotion' only, so
  // Core/High Stock/Drop workspaces are unaffected.
  const promoOrigin = product.source === 'promotion' && product.promotion_name
    ? `<div class="cd-workspace-promo-origin">Promotion: <strong>${escapeHtml(product.promotion_name)}</strong> — ${escapeHtml(product.promotion_stage_name || '')}</div>`
    : '';
  // Shoot Week -- Promotion only (see the Shoot Week brief, section 2:
  // "Promotion Concept Dev cards should retain useful context... planned
  // Shoot Week"). Editable in place until Tuesday Review approves it (the
  // PATCH itself 409s once a shoot_schedule row exists, at which point
  // Shooting's own move/reschedule is the correct place to change it) --
  // see editConceptDevShootWeek.
  const shootWeekHtml = product.source === 'promotion'
    ? `<span id="cd-shoot-week-display-${product.shoot_plan_item_id}">Shoot Week: ${escapeHtml(conceptDevShootWeekLabel(product.shoot_week))} <button type="button" class="link-btn" onclick="editConceptDevShootWeek(${product.shoot_plan_item_id}, '${product.shoot_week}')">Change</button></span>`
    : '';
  return `
    <div class="cd-workspace-header">
      ${thumb}
      <div class="cd-workspace-header-info">
        ${promoOrigin}
        <div class="cd-workspace-header-name">${escapeHtml(product.product_name)}</div>
        <div class="cd-workspace-header-meta">
          <span>${escapeHtml(sourceLabel)}</span>
          <span>&middot;</span>
          <span>${escapeHtml(conceptDevPathwayBadgeLabel(product))}</span>
          <span>&middot;</span>
          <span>Owner: ${escapeHtml(product.creator || '—')}</span>
          <span>&middot;</span>
          <span>${count} New Concept${count === 1 ? '' : 's'}</span>
          ${shootWeekHtml ? `<span>&middot;</span>${shootWeekHtml}` : ''}
        </div>
        <div class="shoot-plan-style-chips">${chips}</div>
        ${product.initial_idea ? `<div class="shoot-plan-idea">💡 ${escapeHtml(product.initial_idea)}</div>` : ''}
      </div>
    </div>`;
}

// "This Week" / "Next Week" / "W/C Mon DD Mon" -- same labelling as the
// intake modal's Shoot Week select (populatePromotionShootWeekOptions),
// computed fresh here since the product payload only carries the raw date.
function conceptDevShootWeekLabel(weekStartStr) {
  if (!weekStartStr) return '—';
  const monday = mondayOfWeek(0);
  const thisWeek = isoDateStr(monday);
  const nextWeek = isoDateStr(mondayOfWeek(1));
  if (weekStartStr === thisWeek) return 'This Week';
  if (weekStartStr === nextWeek) return 'Next Week';
  const [y, m, d] = weekStartStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return `W/C ${date.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}`;
}

async function editConceptDevShootWeek(shootPlanItemId, currentValue) {
  const display = document.getElementById(`cd-shoot-week-display-${shootPlanItemId}`);
  if (!display) return;
  const options = populatePromotionShootWeekOptions();
  display.innerHTML = `<select onchange="saveConceptDevShootWeek(${shootPlanItemId}, this.value)">${
    options.map((o) => `<option value="${o.value}" ${o.value === currentValue ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')
  }</select>`;
}

async function saveConceptDevShootWeek(shootPlanItemId, weekStart) {
  try {
    await api(`/shoot-plan/${shootPlanItemId}/week`, { method: 'PATCH', body: JSON.stringify({ week_start: weekStart }) });
    toast('Shoot Week updated');
    if (conceptDevStandaloneProduct && conceptDevStandaloneProduct.shoot_plan_item_id === shootPlanItemId) {
      await openConceptDevProductStandalone(shootPlanItemId);
    } else {
      await loadConceptDevWeek();
    }
  } catch (e) {
    toast(e.message, true);
  }
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

  // A standalone product (see openConceptDevProductStandalone) renders
  // straight from its own fetched data, bypassing the weekly confirmation
  // gate below entirely -- its week's Shoot Plan may not be confirmed at
  // all, deliberately.
  if (state.conceptDev.view === 'product' && state.conceptDev.standaloneItemId === state.conceptDev.currentItemId && conceptDevStandaloneProduct) {
    list.innerHTML = renderConceptDevProductWorkspace(conceptDevStandaloneProduct);
    return;
  }

  const data = state.conceptDev.data;
  // Promotion New Concepts ride along in `products` regardless of this
  // week's own confirmation state (see conceptDevelopment.js's GET / --
  // their development timing is independent of the Shoot Plan ceremony),
  // so the "not confirmed" wall only applies when there's truly nothing to
  // show -- a confirmed-but-empty week and an unconfirmed week carrying
  // only pending Promotion concepts both fall through to the normal list.
  if (!data || (!data.confirmed && !data.products.length)) {
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
  // Standalone product checked first (see openConceptDevProductStandalone)
  // -- it never appears in state.conceptDev.data.products, since its week
  // may not be confirmed at all.
  if (conceptDevStandaloneProduct) {
    const c = conceptDevStandaloneProduct.concepts.find((c) => c.id === conceptId);
    if (c) return { concept: c, product: conceptDevStandaloneProduct };
  }
  for (const p of (state.conceptDev.data && state.conceptDev.data.products) || []) {
    const c = p.concepts.find((c) => c.id === conceptId);
    if (c) return { concept: c, product: p };
  }
  return null;
}

let conceptDevModalConceptId = null;
let conceptDevModalProduct = null;
let conceptDevModalReferences = [];
// Which reference the compact paste form is editing (null = adding a new
// one) -- see startConceptDevReferencePaste/editConceptDevReference/
// saveConceptDevReferencePaste.
let conceptDevReferenceEditIndex = null;
let conceptDevModalHooks = [];
let conceptDevModalShots = [];
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
        <textarea ${i === 0 ? 'id="cd-modal-hook-primary"' : ''} rows="2" oninput="conceptDevModalHooks[${i}].text=this.value" placeholder="${i === 0 ? 'Describe the opening — dialogue, on-screen text, visual moment, action, reveal, etc.' : 'A different opening for the same concept'}">${escapeHtml(h.text)}</textarea>
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

// What to Shoot -- the literal footage list, deliberately separate from
// Hooks (openings) and the legacy Execution field. Each Shot is a name
// (usually a quick-add chip label, see addConceptDevQuickShot) + an
// optional short detail + a Location -- no timestamps/camera/duration/etc,
// and Detail is never required (only Shot Name and Location count towards
// a "complete" Shot -- see the Ready for Review validation in
// saveConceptDevModal). Freely addable/removable/reorderable, no minimum
// enforced here.
//
// Location is a fixed WNDRR Office / WNDRR Warehouse pick (no typing for
// the common case) plus a "Custom Location" option that progressively
// reveals a "Where?" text field -- see onConceptDevShotLocationChange.
// The shot's own `location` field always holds the final resolved value
// (either "WNDRR Office"/"WNDRR Warehouse", or the free-typed custom
// place), so re-showing an existing Shot just needs to check whether its
// location matches one of the two fixed options -- anything else (custom
// text, or blank) falls through to the Custom Location state.
const CD_SHOT_FIXED_LOCATIONS = ['WNDRR Office', 'WNDRR Warehouse'];

function renderConceptDevModalShots() {
  document.getElementById('cd-modal-shots-list').innerHTML = conceptDevModalShots.map((s, i) => {
    const loc = s.location || '';
    const isCustomLoc = Boolean(loc) && !CD_SHOT_FIXED_LOCATIONS.includes(loc);
    const selectValue = isCustomLoc ? '__custom__' : loc;
    return `
    <div class="cd-shot-item">
      <div class="cd-shot-item-header">
        <input type="text" class="cd-shot-name-input" value="${escapeHtml(s.name)}" oninput="conceptDevModalShots[${i}].name=this.value" placeholder="Shot name">
        <div class="cd-shot-item-actions">
          <button type="button" class="cd-shot-move" onclick="moveConceptDevShot(${i}, -1)" ${i === 0 ? 'disabled' : ''} aria-label="Move shot up">&uarr;</button>
          <button type="button" class="cd-shot-move" onclick="moveConceptDevShot(${i}, 1)" ${i === conceptDevModalShots.length - 1 ? 'disabled' : ''} aria-label="Move shot down">&darr;</button>
          <button type="button" class="link-btn cd-shot-remove" onclick="removeConceptDevShot(${i})">Remove</button>
        </div>
      </div>
      <input type="text" class="cd-shot-detail-input" value="${escapeHtml(s.capture)}" oninput="conceptDevModalShots[${i}].capture=this.value" placeholder="What should be captured in this shot?">
      <div class="cd-shot-location-row">
        <label class="cd-shot-location-field">Location
          <select class="cd-shot-location-select" onchange="onConceptDevShotLocationChange(${i}, this)">
            <option value="" ${selectValue === '' ? 'selected' : ''}>Select location…</option>
            <option value="WNDRR Office" ${selectValue === 'WNDRR Office' ? 'selected' : ''}>WNDRR Office</option>
            <option value="WNDRR Warehouse" ${selectValue === 'WNDRR Warehouse' ? 'selected' : ''}>WNDRR Warehouse</option>
            <option value="__custom__" ${selectValue === '__custom__' ? 'selected' : ''}>Custom Location</option>
          </select>
        </label>
        <input type="text" class="cd-shot-location-custom" value="${isCustomLoc ? escapeHtml(loc) : ''}" placeholder="Enter location…" style="display:${isCustomLoc ? '' : 'none'};" oninput="conceptDevModalShots[${i}].location=this.value">
      </div>
    </div>`;
  }).join('');
}

// Picking a fixed option sets the Shot's location directly and hides/clears
// the custom field; picking "Custom Location" clears location back to
// blank (nothing chosen yet) and reveals the custom text field, focused
// ready to type -- exactly the progressive-disclosure pattern used
// elsewhere in this modal (e.g. Talent's select+other). Direct DOM update,
// not a full re-render, so it doesn't disturb anything else being typed
// in the list.
function onConceptDevShotLocationChange(index, selectEl) {
  const shot = conceptDevModalShots[index];
  if (!shot) return;
  const isCustom = selectEl.value === '__custom__';
  const item = selectEl.closest('.cd-shot-item');
  const customInput = item.querySelector('.cd-shot-location-custom');
  if (isCustom) {
    shot.location = '';
    customInput.style.display = '';
    customInput.value = '';
    customInput.focus();
  } else {
    shot.location = selectEl.value;
    customInput.style.display = 'none';
    customInput.value = '';
  }
}

// Common shot types a creator would otherwise retype every time -- clicking
// one adds it to the list immediately with that name pre-filled, so typing
// is only ever needed for the optional Detail line or a genuinely custom
// shot. Deliberately a fixed, small, non-configurable list (not backed by
// any table) -- these are generic film-set vocabulary, not app data.
const CONCEPT_DEV_QUICK_SHOT_TYPES = [
  'Full Body', 'Front', 'Back', 'Side', 'Close-up / Detail', 'Product Detail',
  'Movement / Walking', 'Talking to Camera', 'Outfit / Styling', 'Transition',
];

function toggleConceptDevShotQuickAdd() {
  const menu = document.getElementById('cd-modal-shot-quickadd-menu');
  const opening = menu.style.display === 'none';
  if (opening) {
    menu.innerHTML = CONCEPT_DEV_QUICK_SHOT_TYPES.map((label) => `<button type="button" class="cd-shot-quickadd-chip" onclick="addConceptDevQuickShot('${label}')">${escapeHtml(label)}</button>`).join('')
      + `<button type="button" class="cd-shot-quickadd-chip cd-shot-quickadd-chip-custom" onclick="addConceptDevQuickShot('')">Custom Shot</button>`;
  }
  menu.style.display = opening ? '' : 'none';
}

// Dismissing the picker (click outside, Escape, or "+ Add Shot" again)
// only ever hides the menu -- it never touches conceptDevModalShots, so
// changing your mind costs nothing.
function closeConceptDevShotQuickAdd() {
  document.getElementById('cd-modal-shot-quickadd-menu').style.display = 'none';
}

// name === '' is the "Custom Shot" chip -- adds a blank Shot and focuses
// its Name input for typing, instead of a pre-filled Detail line.
function addConceptDevQuickShot(name) {
  conceptDevModalShots.push({ name, capture: '', location: '' });
  closeConceptDevShotQuickAdd();
  renderConceptDevModalShots();
  const items = document.querySelectorAll('#cd-modal-shots-list .cd-shot-item');
  const last = items[items.length - 1];
  if (last) {
    const focusTarget = name ? last.querySelector('.cd-shot-detail-input') : last.querySelector('.cd-shot-name-input');
    if (focusTarget) focusTarget.focus();
  }
}

function removeConceptDevShot(index) {
  conceptDevModalShots.splice(index, 1);
  renderConceptDevModalShots();
}

function moveConceptDevShot(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= conceptDevModalShots.length) return;
  [conceptDevModalShots[index], conceptDevModalShots[target]] = [conceptDevModalShots[target], conceptDevModalShots[index]];
  renderConceptDevModalShots();
}

// References render as compact cards (label + truncated note) rather than
// permanently-visible URL/note text fields -- editing happens through the
// same paste form used to add one (see editConceptDevReference), not
// inline in the card itself.
function conceptDevReferenceCardHtml(r, i) {
  const label = referenceLabelFromUrl(r.url);
  const note = r.note && r.note.trim();
  return `
    <div class="cd-reference-card">
      <div class="cd-reference-card-main">
        <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener" class="cd-reference-card-label">${r.library_reference_id ? '📚 ' : ''}${escapeHtml(label)}</a>
        ${note ? `<div class="cd-reference-card-note">${escapeHtml(note)}</div>` : ''}
      </div>
      <div class="cd-reference-card-actions">
        <button type="button" class="link-btn" onclick="editConceptDevReference(${i})">Edit</button>
        <button type="button" class="link-btn" onclick="removeConceptDevReference(${i})">Remove</button>
      </div>
    </div>`;
}

function renderConceptDevModalReferences() {
  document.getElementById('cd-modal-references-list').innerHTML = conceptDevModalReferences
    .map((r, i) => conceptDevReferenceCardHtml(r, i)).join('');
}

function removeConceptDevReference(index) {
  conceptDevModalReferences.splice(index, 1);
  renderConceptDevModalReferences();
}

// "+ Add Reference" opens a small menu (Paste Link / Choose From Reference
// Library) instead of two permanently-visible actions -- see the brief.
function toggleConceptDevReferenceAddMenu() {
  const menu = document.getElementById('cd-modal-reference-add-menu');
  menu.style.display = menu.style.display === 'none' ? '' : 'none';
}

function closeConceptDevReferenceAddMenu() {
  document.getElementById('cd-modal-reference-add-menu').style.display = 'none';
}

function chooseConceptDevReferenceFromLibrary() {
  document.getElementById('cd-modal-reference-add-menu').style.display = 'none';
  referencePickerTarget = 'normal';
  openReferenceLibraryPicker();
}

// The same compact paste form handles both adding a new reference and
// editing an existing one -- conceptDevReferenceEditIndex tracks which
// (null while adding). See saveConceptDevReferencePaste.
function startConceptDevReferencePaste() {
  conceptDevReferenceEditIndex = null;
  document.getElementById('cd-modal-reference-add-menu').style.display = 'none';
  document.getElementById('cd-modal-reference-paste-url').value = '';
  document.getElementById('cd-modal-reference-paste-note').value = '';
  document.getElementById('cd-modal-reference-paste-save-btn').textContent = 'Add Reference';
  document.getElementById('cd-modal-reference-paste-form').style.display = '';
  document.getElementById('cd-modal-reference-paste-url').focus();
}

function editConceptDevReference(index) {
  const r = conceptDevModalReferences[index];
  if (!r) return;
  conceptDevReferenceEditIndex = index;
  document.getElementById('cd-modal-reference-add-menu').style.display = 'none';
  document.getElementById('cd-modal-reference-paste-url').value = r.url;
  document.getElementById('cd-modal-reference-paste-note').value = r.note;
  document.getElementById('cd-modal-reference-paste-save-btn').textContent = 'Save Reference';
  document.getElementById('cd-modal-reference-paste-form').style.display = '';
  document.getElementById('cd-modal-reference-paste-url').focus();
}

function cancelConceptDevReferencePaste() {
  conceptDevReferenceEditIndex = null;
  document.getElementById('cd-modal-reference-paste-form').style.display = 'none';
}

function saveConceptDevReferencePaste() {
  const url = document.getElementById('cd-modal-reference-paste-url').value.trim();
  const note = document.getElementById('cd-modal-reference-paste-note').value.trim();
  if (!url) { toast('A reference link is required', true); return; }
  if (conceptDevReferenceEditIndex !== null) {
    conceptDevModalReferences[conceptDevReferenceEditIndex] = { ...conceptDevModalReferences[conceptDevReferenceEditIndex], url, note };
  } else {
    conceptDevModalReferences.push({ url, note });
  }
  conceptDevReferenceEditIndex = null;
  document.getElementById('cd-modal-reference-paste-form').style.display = 'none';
  renderConceptDevModalReferences();
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
    `<strong>${escapeHtml(product.product_name || 'No products required')}</strong>`,
    escapeHtml(sourceLabel),
    escapeHtml(pathwayLabel),
    `Owner: ${escapeHtml(product.creator || '—')}`,
    escapeHtml(skuInfo),
  ].filter(Boolean).join(' &middot; ');
  // Promotion Message/Offer -- surfaces the Promotion's own notes field
  // read-only as the offer reference, per the brief: reuse the existing
  // Promotion-level notes rather than duplicating offer text onto each
  // creative_asset.
  const promoNotes = product.source === 'promotion' && product.promotion_notes && product.promotion_notes.trim()
    ? `<div class="cd-modal-context-idea">🏷️ Promotion Message/Offer: ${escapeHtml(product.promotion_notes.trim())}</div>`
    : '';
  return `
    ${thumb}
    <div class="cd-modal-context-lines">
      <div class="cd-modal-context-line">${line}</div>
      ${product.initial_idea ? `<div class="cd-modal-context-idea">💡 ${escapeHtml(product.initial_idea)}</div>` : ''}
      ${promoNotes}
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

// Toggles "Who are you targeting?" -- one shared "Why will they care?"
// field either way (see the HTML comment on cd-modal-audience-section),
// never two parallel "why care" fields to keep in sync. Its placeholder is
// fixed in the HTML and doesn't vary by avatar mode.
function onConceptDevAvatarChange() {
  const select = document.getElementById('cd-modal-avatar-select');
  const isOther = select.value === '__other__';
  document.getElementById('cd-modal-avatar-custom-wrap').style.display = isOther ? '' : 'none';
  select.classList.remove('cd-field-invalid');
  document.getElementById('cd-modal-avatar-custom-desc').classList.remove('cd-field-invalid');
  hideConceptDevFieldError('cd-modal-avatar-select-error');
  hideConceptDevFieldError('cd-modal-avatar-custom-desc-error');
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

// A dropdown of options the app already has (Talent/Model from
// state.contentCreators, Location from state.conceptDevLocations) plus an
// "Other / custom" fallback -- same sentinel pattern as the Customer
// Avatar select above, reused here rather than inventing a second one.
// Never hard-codes a list: options come entirely from real existing data.
function fillConceptDevSelectWithOther(selectId, customId, options, currentValue, placeholderLabel) {
  const select = document.getElementById(selectId);
  const custom = document.getElementById(customId);
  select.innerHTML = [`<option value="">${escapeHtml(placeholderLabel || 'Select…')}</option>`]
    .concat(options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`))
    .concat(['<option value="__other__">Other / custom…</option>'])
    .join('');
  const value = (currentValue || '').trim();
  if (value && options.includes(value)) {
    select.value = value;
    custom.style.display = 'none';
    custom.value = '';
  } else if (value) {
    select.value = '__other__';
    custom.style.display = '';
    custom.value = value;
  } else {
    select.value = '';
    custom.style.display = 'none';
    custom.value = '';
  }
}

function onConceptDevSelectWithOtherChange(selectId, customId) {
  const select = document.getElementById(selectId);
  const custom = document.getElementById(customId);
  custom.style.display = select.value === '__other__' ? '' : 'none';
  if (select.value === '__other__') custom.focus();
}

function conceptDevSelectWithOtherValue(selectId, customId) {
  const select = document.getElementById(selectId);
  return select.value === '__other__' ? document.getElementById(customId).value.trim() : select.value;
}

// Shared by both the create ("+ Add Concept") and edit (click a concept
// card) paths -- concept is null in create mode, so every field just starts
// blank. Status is no longer an editable field here (see saveConceptDevModal)
// -- this just shows where the concept currently sits, read-only, in the
// header badge.
function fillConceptDevModalFields(concept) {
  document.getElementById('cd-modal-angle').value = concept ? (concept.angle || '') : '';
  document.getElementById('cd-modal-script').value = concept ? (concept.script_notes || '') : '';
  document.getElementById('cd-modal-props').value = concept ? (concept.props_notes || '') : '';
  fillConceptDevSelectWithOther('cd-modal-talent-select', 'cd-modal-talent-custom', state.contentCreators.map((c) => c.name), concept ? concept.talent_requirement : '', 'No Talent Required');

  // Concept Type -- reusable vocabulary from state.conceptTypes, same
  // select+other pattern as Talent/Location. Kept separate from Concept
  // Name/Idea above (see schema.sql's concept_types comment).
  fillConceptDevSelectWithOther('cd-modal-concept-type-select', 'cd-modal-concept-type-custom', state.conceptTypes.map((t) => t.name), concept ? concept.concept_type : '');
  document.getElementById('cd-modal-assignee-select').value = concept ? (concept.concept_assignee || '') : '';

  // Execution / Shot Plan is legacy -- superseded by structured What to
  // Shoot. Never shown for a new concept and never required; only surfaced
  // (still editable, still saved) when reopening a concept that already
  // has this data from before Shots existed, so nothing already written is
  // hidden or silently dropped on the next save.
  const executionField = document.getElementById('cd-modal-execution');
  const executionSection = document.getElementById('cd-modal-execution-legacy-section');
  const hasLegacyExecution = Boolean(concept && concept.execution && concept.execution.trim());
  executionField.value = hasLegacyExecution ? concept.execution : '';
  executionSection.style.display = hasLegacyExecution ? '' : 'none';

  renderConceptDevModalStylesNeeded();
  document.getElementById('cd-modal-styles-search').value = '';
  document.getElementById('cd-modal-styles-results').style.display = 'none';

  conceptDevReferenceEditIndex = null;
  document.getElementById('cd-modal-reference-paste-form').style.display = 'none';
  document.getElementById('cd-modal-reference-add-menu').style.display = 'none';
  conceptDevModalReferences = concept
    ? (concept.reference_items || []).map((r) => ({ url: r.url || '', note: r.note || '', library_reference_id: r.library_reference_id || null }))
    : [];
  renderConceptDevModalReferences();

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
  // "Why will they care?" is no longer asked for new concepts (see the
  // HTML comment on cd-modal-avatar-why-care-wrap) -- hidden and blank by
  // default, only shown (still editable, still saved) when reopening a
  // concept that already has this data from before it became optional,
  // exactly the same pattern as legacy Execution above.
  const whyCareField = document.getElementById('cd-modal-avatar-why-care');
  const whyCareWrap = document.getElementById('cd-modal-avatar-why-care-wrap');
  const hasLegacyWhyCare = Boolean(concept && concept.avatar_why_care && concept.avatar_why_care.trim());
  whyCareField.value = hasLegacyWhyCare ? concept.avatar_why_care : '';
  whyCareWrap.style.display = hasLegacyWhyCare ? '' : 'none';
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

  // What to Shoot -- unlike Hooks, no default blank slot: an existing
  // Concept with no structured Shots yet (every Concept before this
  // feature shipped) should open showing genuinely zero rows, not one
  // pre-created empty one, so it's obvious nothing's been added rather
  // than looking like a half-filled-in Shot.
  conceptDevModalShots = concept && Array.isArray(concept.shots)
    ? concept.shots.map((s) => ({ name: s.name || '', capture: s.capture || '', location: s.location || '' }))
    : [];
  renderConceptDevModalShots();

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
  // Location no longer has a field here (see the removed overall Location
  // in Shoot Setup, now per-Shot) -- only Talent/Props decide whether this
  // auto-expands, so it never opens to show nothing new.
  setConceptDevShootRequirementsExpanded(Boolean(
    concept && (concept.talent_requirement || concept.props_notes)
  ));

  hideConceptDevValidation();
}

// Styles Needed -- optional, zero/one/many products for the concept's
// shoot_plan_item (shared across every concept on that item, same as
// Planning's own colourway picker). Persisted immediately per add/remove
// (via POST/DELETE /shoot-plan/:itemId/styles) rather than staged with the
// rest of the form, since it's execution data that other concepts on the
// same item may already depend on. An empty list is exactly "No products
// required" -- never a dummy/sentinel row (see schema.sql).
function renderConceptDevModalStylesNeeded() {
  const list = document.getElementById('cd-modal-styles-list');
  const product = conceptDevModalProduct;
  const colourways = (product && product.colourways) || [];
  if (!colourways.length) {
    list.innerHTML = '<div class="hint">No products required</div>';
    return;
  }
  list.innerHTML = colourways.map((c) => `
    <span class="cd-style-chip">
      ${escapeHtml(c.colour_label || c.style_code)}${c.colour_label ? ` <span class="cd-style-chip-code">${escapeHtml(c.style_code)}</span>` : ''}${c.size ? ` · ${escapeHtml(c.size)}` : ''}
      <button type="button" class="cd-style-chip-remove" onclick="removeConceptDevStyle(${c.style_id})" title="Remove">&times;</button>
    </span>`).join('');
}

function filterConceptDevStyles() {
  renderStyleSearchResults('cd-modal-styles-search', 'cd-modal-styles-results', selectConceptDevStyle);
}

async function selectConceptDevStyle(styleId) {
  const product = conceptDevModalProduct;
  if (!product) return;
  const style = state.styles.find((s) => s.id === styleId);
  if (!style) return;
  try {
    await api(`/shoot-plan/${product.shoot_plan_item_id}/styles`, {
      method: 'POST',
      body: JSON.stringify({ style_id: styleId, colour_label: null, size: null }),
    });
    product.colourways = product.colourways || [];
    product.colourways.push({ style_id: styleId, style_code: style.style_code, colour_label: null, size: null });
    renderConceptDevModalStylesNeeded();
    document.getElementById('cd-modal-styles-search').value = '';
    document.getElementById('cd-modal-styles-results').style.display = 'none';
  } catch (e) {
    toast(e.message, true);
  }
}

async function removeConceptDevStyle(styleId) {
  const product = conceptDevModalProduct;
  if (!product) return;
  try {
    await api(`/shoot-plan/${product.shoot_plan_item_id}/styles/${styleId}`, { method: 'DELETE' });
    product.colourways = (product.colourways || []).filter((c) => c.style_id !== styleId);
    renderConceptDevModalStylesNeeded();
  } catch (e) {
    toast(e.message, true);
  }
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
  document.getElementById('cd-modal-talent-select').focus();
}

// Required-field ids Ready for Review validates -- kept as one list so the
// clear-all-errors path, the field-order walked to focus the first missing
// one, and the individual error-message ids below all stay in sync.
const CD_REQUIRED_FIELD_IDS = [
  'cd-modal-name', 'cd-modal-angle', 'cd-modal-avatar-select',
  'cd-modal-avatar-custom-desc', 'cd-modal-hook-primary',
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
  hideConceptDevFieldError('cd-modal-shots-error');
}

// concept_name is locked to a read-only label for a Drop's Proven Winner
// concept (name_locked) -- the creator preps execution for the assigned
// concept rather than inventing the name again, per the brief.
function openConceptDevModal(conceptId) {
  const found = findConceptDevConcept(conceptId);
  if (!found) return;
  const { concept, product } = found;

  // Promotion-sourced concepts get their own, separate UI (see the
  // Promotion Concept Development section below) -- everything else
  // (Core/High Stock/Drop) falls through to this modal completely
  // unchanged.
  if (product.source === 'promotion') {
    openPromotionConceptDevModal(concept, product);
    return;
  }

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
  const product = (conceptDevStandaloneProduct && conceptDevStandaloneProduct.shoot_plan_item_id === shootPlanItemId && conceptDevStandaloneProduct)
    || (data && data.products.find((p) => p.shoot_plan_item_id === shootPlanItemId));
  if (!product) return;

  // Promotion-sourced concepts get their own, separate UI -- see the
  // Promotion Concept Development section below.
  if (product.source === 'promotion') {
    openPromotionConceptDevModal(null, product);
    return;
  }

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

  // The modal body is a single reused scrollable element, so without this
  // a fresh New Concept form can open still scrolled to wherever the
  // previously viewed concept happened to leave it. Always start at the
  // top -- header + THE IDEA fields visible -- regardless of that.
  const modalBody = document.querySelector('#concept-dev-modal .modal-body');
  if (modalBody) modalBody.scrollTop = 0;
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
    refreshConceptDevAfterChange();
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
    refreshConceptDevAfterChange();
  } catch (e) {
    toast(e.message, true);
  }
}

// Status is no longer a field the creator sets directly -- it's driven by
// which footer action they click. targetStatus is 'in_development' (Save
// Draft) or 'ready_for_review' (Ready for Review); a concept that's never
// been saved stays Not Started (see schema.sql's concept_dev_status
// default) until one of these two actions actually moves it.
async function saveConceptDevModal(targetStatus) {
  const product = conceptDevModalProduct;
  if (!product) return;
  const found = conceptDevModalConceptId ? findConceptDevConcept(conceptDevModalConceptId) : null;
  const nameLocked = Boolean(found && found.concept.name_locked);
  const nameInput = document.getElementById('cd-modal-name');
  const name = nameLocked ? found.concept.concept_name : nameInput.value.trim();
  const angleInput = document.getElementById('cd-modal-angle');
  const angle = angleInput.value.trim();
  // Execution / Shot Plan is legacy (see fillConceptDevModalFields) -- its
  // section only ever renders for a concept that already had this data,
  // so reading its current value here (blank for every new concept, since
  // the field is never shown/touched) never wipes or requires anything.
  const execution = document.getElementById('cd-modal-execution').value.trim();

  const avatarSelect = document.getElementById('cd-modal-avatar-select');
  const isOtherAvatar = avatarSelect.value === '__other__';
  const customerAvatarId = avatarSelect.value && !isOtherAvatar ? Number(avatarSelect.value) : null;
  const customDescInput = document.getElementById('cd-modal-avatar-custom-desc');
  const customAvatarDescription = isOtherAvatar ? customDescInput.value.trim() : '';
  const whyCareInput = document.getElementById('cd-modal-avatar-why-care');
  const avatarWhyCare = whyCareInput.value.trim();
  const hasAvatar = Boolean(customerAvatarId) || Boolean(customAvatarDescription);

  const conceptType = conceptDevSelectWithOtherValue('cd-modal-concept-type-select', 'cd-modal-concept-type-custom');
  const conceptAssignee = document.getElementById('cd-modal-assignee-select').value || null;

  const body = {
    angle,
    execution,
    concept_type: conceptType,
    customer_avatar_id: customerAvatarId,
    custom_avatar_description: customAvatarDescription,
    avatar_why_care: avatarWhyCare,
    script_notes: document.getElementById('cd-modal-script').value.trim(),
    hook_variations: conceptDevModalHooks
      .map((h) => ({ text: h.text.trim() }))
      .filter((h) => h.text),
    // Detail ("What to Capture") is an optional short customisation, not a
    // requirement -- only Shot Name has to be filled in for a Shot to
    // count (see the hasCompleteShot check below). Location is required
    // per-Shot once a Shot has a name (see the missingShotLocation check
    // below) -- different shots in the same concept can need different
    // places, so location now lives here instead of once on the whole
    // concept (see the removed cd-modal-location-input in Shoot Setup).
    shots: conceptDevModalShots
      .map((s) => ({ name: s.name.trim(), capture: s.capture.trim(), location: (s.location || '').trim() }))
      .filter((s) => s.name),
    reference_items: conceptDevModalReferences
      .map((r) => (r.library_reference_id
        ? { url: r.url.trim(), note: r.note.trim(), library_reference_id: r.library_reference_id }
        : { url: r.url.trim(), note: r.note.trim() }))
      .filter((r) => r.url),
    talent_requirement: conceptDevSelectWithOtherValue('cd-modal-talent-select', 'cd-modal-talent-custom'),
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
  // focused/scrolled to. Required: Concept Name, The Idea, Customer Avatar,
  // Primary Hook, at least one What to Shoot item, and a Location on every
  // named Shot -- everything else (Why will they care?, Script, References,
  // Shoot Setup, legacy Execution) is optional and never blocks submission.
  if (targetStatus === 'ready_for_review') {
    const missing = [];
    if (!nameLocked && !name) missing.push({ field: nameInput, errorId: 'cd-modal-name-error', message: 'Concept Name is required' });
    if (!angle) missing.push({ field: angleInput, errorId: 'cd-modal-angle-error', message: 'Add The Idea' });
    if (!hasAvatar) {
      if (isOtherAvatar) missing.push({ field: customDescInput, errorId: 'cd-modal-avatar-custom-desc-error', message: 'Describe who you\'re targeting' });
      else missing.push({ field: avatarSelect, errorId: 'cd-modal-avatar-select-error', message: 'Customer Avatar is required' });
    }
    const primaryHookInput = document.getElementById('cd-modal-hook-primary');
    const primaryHookText = ((conceptDevModalHooks[0] && conceptDevModalHooks[0].text) || '').trim();
    if (!primaryHookText) missing.push({ field: primaryHookInput, errorId: 'cd-modal-hook-primary-error', message: 'Add a Primary Hook / Opening' });

    if (missing.length) {
      for (const m of missing) showConceptDevFieldError(m.field.id, m.errorId, m.message);
      missing[0].field.focus();
      missing[0].field.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    // What to Shoot needs at least one Shot with a name before Ready for
    // Review -- same bar as the fields above, just anchored to the list
    // itself rather than a single input since a Shot has no fixed field id
    // to flag invalid. Detail is optional (see the body.shots filter
    // above). This only ever fires when someone actively submits/
    // resubmits a concept -- an existing concept already sitting in Ready
    // for Review/Approved/etc from before this requirement existed is
    // never re-validated just for having no structured Shots (see
    // schema.sql's comment on the shots column).
    const namedShots = conceptDevModalShots.filter((s) => s.name.trim());
    if (!namedShots.length) {
      const shotsError = document.getElementById('cd-modal-shots-error');
      shotsError.textContent = 'Add at least one Shot';
      shotsError.classList.add('show');
      document.getElementById('cd-modal-shots-list').scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    // Every named Shot also needs its own Location -- different shots in
    // the same concept can need different places, so this is now as
    // required as the Shot Name itself (see the removed overall Location
    // field in Shoot Setup).
    if (namedShots.some((s) => !(s.location || '').trim())) {
      const shotsError = document.getElementById('cd-modal-shots-error');
      shotsError.textContent = 'Add a Location for every Shot';
      shotsError.classList.add('show');
      document.getElementById('cd-modal-shots-list').scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
  }

  // "Other / New Type" persists to concept_types so it's reusable for
  // future concepts -- idempotent by name (see conceptTypes.js POST), same
  // reasoning as Talent's Other/custom staying a one-off unless it matches
  // an existing option.
  if (conceptType && !state.conceptTypes.some((t) => t.name.toLowerCase() === conceptType.toLowerCase())) {
    try {
      const created = await api('/concept-types', { method: 'POST', body: JSON.stringify({ name: conceptType }) });
      state.conceptTypes.push(created);
    } catch (e) { /* non-fatal -- the concept itself still saves with the typed value */ }
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
      await api(`/creative-assets/${conceptDevModalConceptId}/assignee`, {
        method: 'PATCH',
        body: JSON.stringify({ concept_assignee: conceptAssignee }),
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
      if (conceptAssignee) {
        await api(`/creative-assets/${assetId}/assignee`, {
          method: 'PATCH',
          body: JSON.stringify({ concept_assignee: conceptAssignee }),
        });
      }
      closeModal('concept-dev-modal');
      toast(savedToast);
    }
    refreshConceptDevAfterChange();
  } catch (e) {
    toast(e.message, true);
  }
}

// ── Promotion Concept Development ─────────────────────
// A separate UI for Promotion-sourced concepts (product.source === 'promotion'),
// dispatched to automatically from openConceptDevModal/openAddConceptModal
// above -- deliberately its own promo-modal-* ids and its own state/
// functions throughout (Option A: duplicate, don't parameterize the normal
// modal's widgets), so nothing here can ever regress Core/High Stock/Drop
// Concept Development. It still writes the exact same creative_assets row
// via the same PATCH /concept-development/concepts/:id endpoint used
// everywhere else -- a different UI over the same record and lifecycle, not
// a new entity. One modal element covers both Static and Video (see
// applyPromotionConceptDevFormat), since format is fixed at creation
// forever, exactly like the normal modal has no editable format field.
let promoConceptDevModalConceptId = null;
let promoConceptDevModalProduct = null;
// Production follow-up pass, item 3: set (to { stageId }) only when this
// modal was opened directly from Promotion -> Add Concept -> New Concept,
// with no product/shoot_plan_item created yet at all -- see
// openPromotionConceptDevModal's bootstrapStageId param and
// savePromotionConceptDevModal, which mints the shoot_plan_item itself
// (via POST /shoot-plan) before its normal PATCH logic when this is set.
// null for every other entry point (add-another-concept-to-an-existing-
// product, or opening an already-saved concept), which are unaffected.
let promoConceptDevBootstrapContext = null;
let promoConceptDevModalReferences = [];
let promoConceptDevReferenceEditIndex = null;
let promoConceptDevModalHooks = [];
let promoConceptDevModalShots = [];
let promoConceptDevModalReadOnly = false;
let promoConceptDevModalFormat = 'video';

function renderPromotionConceptDevModalHooks() {
  document.getElementById('promo-modal-hooks-list').innerHTML = promoConceptDevModalHooks.map((h, i) => `
    <div class="cd-hook-item">
      <label>${i === 0 ? 'Primary Hook / Opening' : `Alternative Hook ${i + 1}`}
        <textarea rows="2" oninput="promoConceptDevModalHooks[${i}].text=this.value" placeholder="${i === 0 ? 'Describe the opening — dialogue, on-screen text, visual moment, action, reveal, etc.' : 'A different opening for the same concept'}">${escapeHtml(h.text)}</textarea>
      </label>
      ${i > 0 ? `<button type="button" class="link-btn cd-hook-remove" onclick="removePromotionConceptDevHook(${i})">Remove</button>` : ''}
    </div>`).join('');
}

function addPromotionConceptDevHook() {
  promoConceptDevModalHooks.push({ text: '' });
  renderPromotionConceptDevModalHooks();
  const textareas = document.querySelectorAll('#promo-modal-hooks-list textarea');
  if (textareas.length) textareas[textareas.length - 1].focus();
}

function removePromotionConceptDevHook(index) {
  promoConceptDevModalHooks.splice(index, 1);
  renderPromotionConceptDevModalHooks();
}

// What to Shoot -- same fixed WNDRR Office/WNDRR Warehouse/Custom Location
// pattern as the normal modal, reusing its CD_SHOT_FIXED_LOCATIONS/
// CONCEPT_DEV_QUICK_SHOT_TYPES data constants directly (generic vocabulary,
// not concept-dev-modal-specific state -- safe to share, see those
// constants' own comments).
function renderPromotionConceptDevModalShots() {
  document.getElementById('promo-modal-shots-list').innerHTML = promoConceptDevModalShots.map((s, i) => {
    const loc = s.location || '';
    const isCustomLoc = Boolean(loc) && !CD_SHOT_FIXED_LOCATIONS.includes(loc);
    const selectValue = isCustomLoc ? '__custom__' : loc;
    return `
    <div class="cd-shot-item">
      <div class="cd-shot-item-header">
        <input type="text" class="cd-shot-name-input" value="${escapeHtml(s.name)}" oninput="promoConceptDevModalShots[${i}].name=this.value" placeholder="Shot name">
        <div class="cd-shot-item-actions">
          <button type="button" class="cd-shot-move" onclick="movePromotionConceptDevShot(${i}, -1)" ${i === 0 ? 'disabled' : ''} aria-label="Move shot up">&uarr;</button>
          <button type="button" class="cd-shot-move" onclick="movePromotionConceptDevShot(${i}, 1)" ${i === promoConceptDevModalShots.length - 1 ? 'disabled' : ''} aria-label="Move shot down">&darr;</button>
          <button type="button" class="link-btn cd-shot-remove" onclick="removePromotionConceptDevShot(${i})">Remove</button>
        </div>
      </div>
      <input type="text" class="cd-shot-detail-input" value="${escapeHtml(s.capture)}" oninput="promoConceptDevModalShots[${i}].capture=this.value" placeholder="What should be captured in this shot?">
      <div class="cd-shot-location-row">
        <label class="cd-shot-location-field">Location
          <select class="cd-shot-location-select" onchange="onPromotionConceptDevShotLocationChange(${i}, this)">
            <option value="" ${selectValue === '' ? 'selected' : ''}>Select location…</option>
            <option value="WNDRR Office" ${selectValue === 'WNDRR Office' ? 'selected' : ''}>WNDRR Office</option>
            <option value="WNDRR Warehouse" ${selectValue === 'WNDRR Warehouse' ? 'selected' : ''}>WNDRR Warehouse</option>
            <option value="__custom__" ${selectValue === '__custom__' ? 'selected' : ''}>Custom Location</option>
          </select>
        </label>
        <input type="text" class="cd-shot-location-custom" value="${isCustomLoc ? escapeHtml(loc) : ''}" placeholder="Enter location…" style="display:${isCustomLoc ? '' : 'none'};" oninput="promoConceptDevModalShots[${i}].location=this.value">
      </div>
    </div>`;
  }).join('');
}

function onPromotionConceptDevShotLocationChange(index, selectEl) {
  const shot = promoConceptDevModalShots[index];
  if (!shot) return;
  const isCustom = selectEl.value === '__custom__';
  const item = selectEl.closest('.cd-shot-item');
  const customInput = item.querySelector('.cd-shot-location-custom');
  if (isCustom) {
    shot.location = '';
    customInput.style.display = '';
    customInput.value = '';
    customInput.focus();
  } else {
    shot.location = selectEl.value;
    customInput.style.display = 'none';
    customInput.value = '';
  }
}

function togglePromotionConceptDevShotQuickAdd() {
  const menu = document.getElementById('promo-modal-shot-quickadd-menu');
  const opening = menu.style.display === 'none';
  if (opening) {
    menu.innerHTML = CONCEPT_DEV_QUICK_SHOT_TYPES.map((label) => `<button type="button" class="cd-shot-quickadd-chip" onclick="addPromotionConceptDevQuickShot('${label}')">${escapeHtml(label)}</button>`).join('')
      + `<button type="button" class="cd-shot-quickadd-chip cd-shot-quickadd-chip-custom" onclick="addPromotionConceptDevQuickShot('')">Custom Shot</button>`;
  }
  menu.style.display = opening ? '' : 'none';
}

function closePromotionConceptDevShotQuickAdd() {
  document.getElementById('promo-modal-shot-quickadd-menu').style.display = 'none';
}

function addPromotionConceptDevQuickShot(name) {
  promoConceptDevModalShots.push({ name, capture: '', location: '' });
  closePromotionConceptDevShotQuickAdd();
  renderPromotionConceptDevModalShots();
  const items = document.querySelectorAll('#promo-modal-shots-list .cd-shot-item');
  const last = items[items.length - 1];
  if (last) {
    const focusTarget = name ? last.querySelector('.cd-shot-detail-input') : last.querySelector('.cd-shot-name-input');
    if (focusTarget) focusTarget.focus();
  }
}

function removePromotionConceptDevShot(index) {
  promoConceptDevModalShots.splice(index, 1);
  renderPromotionConceptDevModalShots();
}

function movePromotionConceptDevShot(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= promoConceptDevModalShots.length) return;
  [promoConceptDevModalShots[index], promoConceptDevModalShots[target]] = [promoConceptDevModalShots[target], promoConceptDevModalShots[index]];
  renderPromotionConceptDevModalShots();
}

function promotionConceptDevReferenceCardHtml(r, i) {
  const label = referenceLabelFromUrl(r.url);
  const note = r.note && r.note.trim();
  return `
    <div class="cd-reference-card">
      <div class="cd-reference-card-main">
        <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener" class="cd-reference-card-label">${r.library_reference_id ? '📚 ' : ''}${escapeHtml(label)}</a>
        ${note ? `<div class="cd-reference-card-note">${escapeHtml(note)}</div>` : ''}
      </div>
      <div class="cd-reference-card-actions">
        <button type="button" class="link-btn" onclick="editPromotionConceptDevReference(${i})">Edit</button>
        <button type="button" class="link-btn" onclick="removePromotionConceptDevReference(${i})">Remove</button>
      </div>
    </div>`;
}

function renderPromotionConceptDevModalReferences() {
  document.getElementById('promo-modal-references-list').innerHTML = promoConceptDevModalReferences
    .map((r, i) => promotionConceptDevReferenceCardHtml(r, i)).join('');
}

function removePromotionConceptDevReference(index) {
  promoConceptDevModalReferences.splice(index, 1);
  renderPromotionConceptDevModalReferences();
}

function togglePromotionConceptDevReferenceAddMenu() {
  const menu = document.getElementById('promo-modal-reference-add-menu');
  menu.style.display = menu.style.display === 'none' ? '' : 'none';
}

function closePromotionConceptDevReferenceAddMenu() {
  document.getElementById('promo-modal-reference-add-menu').style.display = 'none';
}

// referencePickerTarget (see pickReferenceLibraryItem) is the one small
// shared touch-point with the Reference Library picker -- there is only one
// such picker in the whole app, already reused by multiple call sites, so
// this just tells its single "add to concept" callback which of the two
// (fully separate) reference arrays to push into.
function choosePromotionConceptDevReferenceFromLibrary() {
  document.getElementById('promo-modal-reference-add-menu').style.display = 'none';
  referencePickerTarget = 'promo';
  openReferenceLibraryPicker();
}

function startPromotionConceptDevReferencePaste() {
  promoConceptDevReferenceEditIndex = null;
  document.getElementById('promo-modal-reference-add-menu').style.display = 'none';
  document.getElementById('promo-modal-reference-paste-url').value = '';
  document.getElementById('promo-modal-reference-paste-note').value = '';
  document.getElementById('promo-modal-reference-paste-save-btn').textContent = 'Add Reference';
  document.getElementById('promo-modal-reference-paste-form').style.display = '';
  document.getElementById('promo-modal-reference-paste-url').focus();
}

function editPromotionConceptDevReference(index) {
  const r = promoConceptDevModalReferences[index];
  if (!r) return;
  promoConceptDevReferenceEditIndex = index;
  document.getElementById('promo-modal-reference-add-menu').style.display = 'none';
  document.getElementById('promo-modal-reference-paste-url').value = r.url;
  document.getElementById('promo-modal-reference-paste-note').value = r.note;
  document.getElementById('promo-modal-reference-paste-save-btn').textContent = 'Save Reference';
  document.getElementById('promo-modal-reference-paste-form').style.display = '';
  document.getElementById('promo-modal-reference-paste-url').focus();
}

function cancelPromotionConceptDevReferencePaste() {
  promoConceptDevReferenceEditIndex = null;
  document.getElementById('promo-modal-reference-paste-form').style.display = 'none';
}

function savePromotionConceptDevReferencePaste() {
  const url = document.getElementById('promo-modal-reference-paste-url').value.trim();
  const note = document.getElementById('promo-modal-reference-paste-note').value.trim();
  if (!url) { toast('A reference link is required', true); return; }
  if (promoConceptDevReferenceEditIndex !== null) {
    promoConceptDevModalReferences[promoConceptDevReferenceEditIndex] = { ...promoConceptDevModalReferences[promoConceptDevReferenceEditIndex], url, note };
  } else {
    promoConceptDevModalReferences.push({ url, note });
  }
  promoConceptDevReferenceEditIndex = null;
  document.getElementById('promo-modal-reference-paste-form').style.display = 'none';
  renderPromotionConceptDevModalReferences();
}

function renderPromotionConceptDevAvatarOptions(selectedAvatarId) {
  const select = document.getElementById('promo-modal-avatar-select');
  const options = state.customerAvatars.filter((a) => a.enabled || a.id === selectedAvatarId);
  select.innerHTML = [
    '<option value="">Select an avatar…</option>',
    ...options.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}${a.enabled ? '' : ' (disabled)'}</option>`),
    '<option value="__other__">+ Other / New Avatar</option>',
  ].join('');
}

function onPromotionConceptDevAvatarChange() {
  const select = document.getElementById('promo-modal-avatar-select');
  const isOther = select.value === '__other__';
  document.getElementById('promo-modal-avatar-custom-wrap').style.display = isOther ? '' : 'none';
}

// Styles Needed -- optional, zero/one/many products, persisted immediately
// per add/remove exactly like the normal modal's equivalent, but operating
// on its own promoConceptDevModalProduct so it never shares state with
// conceptDevModalProduct.
function renderPromotionConceptDevModalStylesNeeded() {
  const list = document.getElementById('promo-modal-styles-list');
  const product = promoConceptDevModalProduct;
  const colourways = (product && product.colourways) || [];
  if (!colourways.length) {
    list.innerHTML = '<div class="hint">No products required</div>';
    return;
  }
  list.innerHTML = colourways.map((c) => `
    <span class="cd-style-chip">
      ${escapeHtml(c.colour_label || c.style_code)}${c.colour_label ? ` <span class="cd-style-chip-code">${escapeHtml(c.style_code)}</span>` : ''}${c.size ? ` · ${escapeHtml(c.size)}` : ''}
      <button type="button" class="cd-style-chip-remove" onclick="removePromotionConceptDevStyle(${c.style_id})" title="Remove">&times;</button>
    </span>`).join('');
}

function filterPromotionConceptDevStyles() {
  renderStyleSearchResults('promo-modal-styles-search', 'promo-modal-styles-results', selectPromotionConceptDevStyle);
}

async function selectPromotionConceptDevStyle(styleId) {
  const product = promoConceptDevModalProduct;
  if (!product) return;
  const style = state.styles.find((s) => s.id === styleId);
  if (!style) return;
  try {
    await api(`/shoot-plan/${product.shoot_plan_item_id}/styles`, {
      method: 'POST',
      body: JSON.stringify({ style_id: styleId, colour_label: null, size: null }),
    });
    product.colourways = product.colourways || [];
    product.colourways.push({ style_id: styleId, style_code: style.style_code, colour_label: null, size: null });
    renderPromotionConceptDevModalStylesNeeded();
    document.getElementById('promo-modal-styles-search').value = '';
    document.getElementById('promo-modal-styles-results').style.display = 'none';
  } catch (e) {
    toast(e.message, true);
  }
}

async function removePromotionConceptDevStyle(styleId) {
  const product = promoConceptDevModalProduct;
  if (!product) return;
  try {
    await api(`/shoot-plan/${product.shoot_plan_item_id}/styles/${styleId}`, { method: 'DELETE' });
    product.colourways = (product.colourways || []).filter((c) => c.style_id !== styleId);
    renderPromotionConceptDevModalStylesNeeded();
  } catch (e) {
    toast(e.message, true);
  }
}

// Toggles the modal body between Static and Video sections (see the
// .promo-section-video-only/.promo-section-static-only HTML comment on
// #promo-concept-dev-modal), swaps the shared top section's title/helper/
// label text, and re-filters the Concept Type dropdown to this format (see
// conceptTypesForFormat).
function applyPromotionConceptDevFormat(format) {
  promoConceptDevModalFormat = format === 'static' ? 'static' : 'video';
  document.querySelectorAll('.promo-section-video-only').forEach((el) => { el.style.display = promoConceptDevModalFormat === 'video' ? '' : 'none'; });
  document.querySelectorAll('.promo-section-static-only').forEach((el) => { el.style.display = promoConceptDevModalFormat === 'static' ? '' : 'none'; });
  // Origin toggle only makes sense when this modal itself is offering the
  // New/Existing choice -- opened via Add Concept -> New Concept (bootstrap
  // mode), that choice was already made in the chooser, so it stays hidden.
  document.getElementById('promo-modal-origin-wrap').style.display = (promoConceptDevModalFormat === 'video' && !promoConceptDevBootstrapContext) ? '' : 'none';
  applyPromotionConceptDevOriginVisibility();

  if (promoConceptDevModalFormat === 'static') {
    document.getElementById('promo-modal-top-title').textContent = 'The Brief';
    document.getElementById('promo-modal-angle-label').textContent = 'What needs to be made?';
    document.getElementById('promo-modal-promo-context-title').textContent = 'Promotion / Offer Context';
    document.getElementById('promo-modal-references-title').textContent = 'References';
    document.getElementById('promo-modal-references-helper').textContent = 'Add inspiration or examples for this concept.';
  } else {
    document.getElementById('promo-modal-top-title').textContent = 'The Idea';
    document.getElementById('promo-modal-angle-label').textContent = 'The Idea';
    document.getElementById('promo-modal-promo-context-title').textContent = 'Promotion Message / Offer';
    // Available for both New and Existing Video (gated on format alone, not
    // origin) -- a previous WNDRR ad or an external TikTok/Instagram/Meta/
    // YouTube video Max wants to recreate, reusing the exact same
    // References data/component (multiple refs, Reference Library picker)
    // as every other format -- just retitled so it reads as the ask.
    document.getElementById('promo-modal-references-title').textContent = 'Reference Video';
    document.getElementById('promo-modal-references-helper').textContent = 'A previous WNDRR video or external inspiration (TikTok/Instagram/Meta/YouTube) to recreate.';
  }

  const currentType = conceptDevSelectWithOtherValue('promo-modal-concept-type-select', 'promo-modal-concept-type-custom');
  const nextType = nextConceptTypeValueForFormat(currentType, promoConceptDevModalFormat);
  fillConceptDevSelectWithOther('promo-modal-concept-type-select', 'promo-modal-concept-type-custom', conceptTypesForFormat(promoConceptDevModalFormat), nextType);
}

// New vs Existing Concept -- Video only (see schema.sql's comment on
// creative_assets.concept_origin). .promo-section-new-only tags the two
// strategic-development pieces (The Idea, Who's It For?) that an Existing
// Concept skips -- same conditional-class pattern applyPromotionConceptDevFormat
// already uses for Static/Video, extended rather than duplicated.
let promoConceptDevModalOrigin = null;

function applyPromotionConceptDevOriginVisibility() {
  // Static always shows its own Idea/Brief field regardless of
  // concept_origin (which stays NULL for Static, see schema.sql) -- only a
  // Video concept explicitly marked Existing hides the New-only sections.
  // An unset/legacy origin (null, e.g. a concept created before this
  // feature) defaults to showing everything, never silently hiding fields
  // nobody chose to hide.
  const hideNewOnly = promoConceptDevModalFormat === 'video' && promoConceptDevModalOrigin === 'existing';
  document.querySelectorAll('.promo-section-new-only').forEach((el) => {
    // Audience carries both promo-section-video-only and promo-section-new-only
    // -- for Static, applyPromotionConceptDevFormat's own video-only pass
    // already hid it and must win; unconditionally showing every new-only
    // element here would re-reveal it. Only the pure new-only elements (the
    // Idea/Brief label, which Static needs visible too) get decided below.
    if (el.classList.contains('promo-section-video-only') && promoConceptDevModalFormat !== 'video') return;
    el.style.display = hideNewOnly ? 'none' : '';
  });

  // The shared top section's title/helper (set by applyPromotionConceptDevFormat
  // to "The Idea" for every Video concept) asks a question the hidden Idea
  // field would have answered -- for Existing Video it becomes a plain
  // "Concept" block (Concept Name/Type/Assigned only), same as the section
  // Existing Video Concept Development's spec calls "CONCEPT". Static is
  // untouched (its own title/helper stays whatever applyPromotionConceptDevFormat set).
  if (promoConceptDevModalFormat === 'video') {
    document.getElementById('promo-modal-top-title').textContent = hideNewOnly ? 'Concept' : 'The Idea';
    document.getElementById('promo-modal-top-helper').style.display = hideNewOnly ? 'none' : '';
  }
}

function applyPromotionConceptDevOrigin(origin) {
  promoConceptDevModalOrigin = origin === 'existing' ? 'existing' : 'new';
  document.getElementById('promo-modal-origin-new-btn').classList.toggle('active', promoConceptDevModalOrigin === 'new');
  document.getElementById('promo-modal-origin-existing-btn').classList.toggle('active', promoConceptDevModalOrigin === 'existing');
  applyPromotionConceptDevOriginVisibility();
}

// Read-only Planning-handoff context, same reasoning as
// conceptDevModalContextHtml but without the Creative Tools trigger (not in
// the Promotion modal's spec).
function promotionConceptDevModalContextHtml(product) {
  const thumb = product.image_url
    ? `<img class="cd-modal-context-thumb" src="${product.image_url}" alt="">`
    : '<span class="cd-modal-context-thumb cd-modal-context-noimg">🖼</span>';
  const skuInfo = (product.colourways || [])
    .map((c) => `${c.style_code || c.colour_label}${c.size ? `-${c.size}` : ''}`)
    .join(', ');
  const line = [
    `<strong>${escapeHtml(product.product_name || 'No products required')}</strong>`,
    'Promotion',
    `Owner: ${escapeHtml(product.creator || '—')}`,
    escapeHtml(skuInfo),
  ].filter(Boolean).join(' &middot; ');
  return `
    ${thumb}
    <div class="cd-modal-context-lines">
      <div class="cd-modal-context-line">${line}</div>
    </div>`;
}

// Promotion/Offer Context -- read-only, reuses the same promotion_name/
// promotion_stage_name/promotion_notes data the Concept Development GET
// already returns for the product, never duplicated onto the creative
// asset itself. `promotion_notes` is promotions.notes -- a single
// general-purpose free-text field, not a dedicated offer/message column
// (there isn't one) -- so it genuinely can hold a real offer/message once
// someone edits a promotion and adds one; for a promotion nobody has
// annotated yet (e.g. Black Friday 2026, whose notes previously held an
// internal seed-setup note -- now cleared, see schema.sql) it has nothing
// useful to say, so the restrained empty state is shown instead rather
// than fabricating or hiding the row.
function promotionConceptDevPromoContextHtml(product) {
  const notes = product.promotion_notes && product.promotion_notes.trim();
  const rows = [
    ['Promotion', product.promotion_name || '—'],
    ['Stage', product.promotion_stage_name || '—'],
  ];
  const offerRow = `<span class="promo-context-label">Offer / Message</span><span class="promo-context-value${notes ? '' : ' promo-context-empty'}">${notes ? escapeHtml(notes) : 'No promotion message added yet'}</span>`;
  return rows.map(([label, value]) => `<div class="promo-context-row"><span class="promo-context-label">${label}</span><span class="promo-context-value">${escapeHtml(value)}</span></div>`).join('')
    + `<div class="promo-context-row">${offerRow}</div>`;
}

// Shared by both the create ("+ New Concept") and edit (click a concept
// card) paths -- concept is null in create mode, so every field starts
// blank.
function fillPromotionConceptDevModalFields(concept) {
  // New vs Existing Concept -- reopening a concept restores whichever
  // approach it was created with; a legacy/never-set concept (created
  // before this feature, or any non-Video concept) defaults to showing the
  // fuller flow rather than silently hiding fields. A brand-new create
  // (concept === null) starts on New Concept, matching the create-mode
  // toggle's default active state.
  promoConceptDevModalOrigin = concept && concept.concept_origin === 'existing' ? 'existing' : 'new';
  document.getElementById('promo-modal-origin-new-btn').classList.toggle('active', promoConceptDevModalOrigin === 'new');
  document.getElementById('promo-modal-origin-existing-btn').classList.toggle('active', promoConceptDevModalOrigin === 'existing');
  applyPromotionConceptDevOriginVisibility();

  document.getElementById('promo-modal-angle').value = concept ? (concept.angle || '') : '';
  document.getElementById('promo-modal-headline').value = concept ? (concept.headline || '') : '';
  document.getElementById('promo-modal-supporting-copy').value = concept ? (concept.supporting_copy || '') : '';
  document.getElementById('promo-modal-cta').value = concept ? (concept.cta_text || '') : '';
  document.getElementById('promo-modal-script').value = concept ? (concept.script_notes || '') : '';
  document.getElementById('promo-modal-props').value = concept ? (concept.props_notes || '') : '';
  fillConceptDevSelectWithOther('promo-modal-talent-select', 'promo-modal-talent-custom', state.contentCreators.map((c) => c.name), concept ? concept.talent_requirement : '', 'No Talent Required');
  fillConceptDevSelectWithOther('promo-modal-concept-type-select', 'promo-modal-concept-type-custom', conceptTypesForFormat(promoConceptDevModalFormat), concept ? concept.concept_type : '');
  document.getElementById('promo-modal-assignee-select').value = concept ? (concept.concept_assignee || '') : '';
  document.getElementById('promo-modal-editing-owner-select').value = concept ? (concept.editing_owner || '') : '';

  renderPromotionConceptDevModalStylesNeeded();
  document.getElementById('promo-modal-styles-search').value = '';
  document.getElementById('promo-modal-styles-results').style.display = 'none';

  promoConceptDevReferenceEditIndex = null;
  document.getElementById('promo-modal-reference-paste-form').style.display = 'none';
  document.getElementById('promo-modal-reference-add-menu').style.display = 'none';
  promoConceptDevModalReferences = concept
    ? (concept.reference_items || []).map((r) => ({ url: r.url || '', note: r.note || '', library_reference_id: r.library_reference_id || null }))
    : [];
  renderPromotionConceptDevModalReferences();

  renderPromotionConceptDevAvatarOptions(concept ? concept.customer_avatar_id : null);
  const avatarSelect = document.getElementById('promo-modal-avatar-select');
  if (concept && concept.customer_avatar_id) {
    avatarSelect.value = String(concept.customer_avatar_id);
  } else if (concept && concept.custom_avatar_description) {
    avatarSelect.value = '__other__';
  } else {
    avatarSelect.value = '';
  }
  document.getElementById('promo-modal-avatar-custom-desc').value = concept ? (concept.custom_avatar_description || '') : '';
  onPromotionConceptDevAvatarChange();

  const existingHooks = concept && Array.isArray(concept.hook_variations) ? concept.hook_variations : [];
  promoConceptDevModalHooks = existingHooks.length
    ? existingHooks.map((h) => ({ text: h.text || '' }))
    : [{ text: '' }];
  renderPromotionConceptDevModalHooks();

  promoConceptDevModalShots = concept && Array.isArray(concept.shots)
    ? concept.shots.map((s) => ({ name: s.name || '', capture: s.capture || '', location: s.location || '' }))
    : [];
  renderPromotionConceptDevModalShots();

  const status = concept ? concept.concept_dev_status : 'not_started';
  const badge = document.getElementById('promo-modal-status-badge');
  badge.className = `cd-concept-status-pill ${CONCEPT_DEV_STATUS_CLASS[status] || ''}`;
  badge.textContent = CONCEPT_DEV_STATUS_LABELS[status] || status;

  const feedbackBanner = document.getElementById('promo-modal-changes-required-banner');
  if (status === 'changes_required' && concept && concept.review_feedback) {
    feedbackBanner.style.display = '';
    document.getElementById('promo-modal-changes-required-text').textContent = concept.review_feedback;
  } else {
    feedbackBanner.style.display = 'none';
  }

  setPromotionConceptDevModalReadOnly(status === 'approved');
}

// Approved concepts default to read-only, same reasoning as the normal
// modal's conceptDevModalReadOnly.
function setPromotionConceptDevModalReadOnly(readOnly) {
  promoConceptDevModalReadOnly = readOnly;
  const modalEl = document.querySelector('#promo-concept-dev-modal .modal');
  modalEl.classList.toggle('cd-readonly', readOnly);
  modalEl.querySelectorAll('.modal-body input, .modal-body textarea, .modal-body select').forEach((el) => {
    el.disabled = readOnly;
  });
  document.getElementById('promo-modal-approved-banner').style.display = readOnly ? '' : 'none';
  if (readOnly) {
    document.getElementById('promo-modal-save-draft-btn').style.display = 'none';
    document.getElementById('promo-modal-save-changes-btn').style.display = 'none';
    document.getElementById('promo-modal-submit-btn').style.display = 'none';
  } else if (promoConceptDevModalConceptId) {
    const found = findConceptDevConcept(promoConceptDevModalConceptId);
    if (found) updatePromotionConceptDevFooterButtons(found.concept.concept_dev_status);
  }
}

async function confirmEditApprovedPromotionConcept() {
  const confirmed = await confirmDialog(
    'This concept has already been approved for shooting. Editing the concept may change the brief that was approved during Tuesday Review.',
    { okLabel: 'Edit Anyway' }
  );
  if (!confirmed) return;
  setPromotionConceptDevModalReadOnly(false);
}

function updatePromotionConceptDevFooterButtons(status) {
  const draftBtn = document.getElementById('promo-modal-save-draft-btn');
  const changesBtn = document.getElementById('promo-modal-save-changes-btn');
  const submitBtn = document.getElementById('promo-modal-submit-btn');
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
    submitBtn.textContent = 'Save & Send to Tuesday Review →';
  }
}

// concept is null for a brand-new Promotion concept (create mode, reached
// via either a Promotion product's own "+ New Concept" workspace button, or
// -- bootstrapStageId set -- directly from Promotion -> Add Concept -> New
// Concept, see choosePromotionAddConceptOrigin) -- only concept === null
// ever shows #promo-modal-format-section, since format is permanent from
// creation onward everywhere else in this app.
//
// bootstrapStageId (production follow-up pass, item 3): set only for the
// Add Concept -> New Concept entry point, where there's no product/
// shoot_plan_item yet at all -- promoConceptDevBootstrapContext then also
// reveals Filming/Shoot Week (the only context #promotion-shoot-modal used
// to collect before handing off to this modal as a SECOND popup) so the
// whole flow now happens in this one modal, and tells
// savePromotionConceptDevModal to mint the shoot_plan_item itself on save.
function openPromotionConceptDevModal(concept, product, openedFromStageView = false, bootstrapStageId = null) {
  promoConceptDevOpenedFromStageView = openedFromStageView;
  promoConceptDevBootstrapContext = bootstrapStageId != null ? { stageId: bootstrapStageId } : null;
  promoConceptDevModalConceptId = concept ? concept.id : null;
  promoConceptDevModalProduct = product;
  promoConceptDevModalFormat = concept ? (concept.format || 'video') : 'video';

  document.getElementById('promo-modal-context').innerHTML = promotionConceptDevModalContextHtml(product);
  document.getElementById('promo-modal-promo-context').innerHTML = promotionConceptDevPromoContextHtml(product);
  document.getElementById('promo-modal-title').textContent = concept ? concept.concept_name : 'New Promotion Concept';

  document.getElementById('promo-modal-name').value = concept ? concept.concept_name : '';

  const formatSection = document.getElementById('promo-modal-format-section');
  if (!concept) {
    formatSection.style.display = '';
    document.getElementById('promo-modal-format-select').value = 'video';
  } else {
    formatSection.style.display = 'none';
  }

  document.getElementById('promo-modal-bootstrap-fields').style.display = promoConceptDevBootstrapContext ? '' : 'none';
  if (promoConceptDevBootstrapContext) {
    populatePromotionShootFilmingSelect('promo-modal-filming-select');
    populatePromotionShootWeekSelect(null, 'promo-modal-week-select');
  }

  applyPromotionConceptDevFormat(promoConceptDevModalFormat);
  updatePromotionConceptDevFooterButtons(concept ? concept.concept_dev_status : null);
  // Only an existing concept has anything to delete -- create mode (concept
  // === null) hides it, same as Core's own cd-modal-delete-btn (see E1).
  document.getElementById('promo-modal-delete-btn').style.display = concept ? '' : 'none';
  fillPromotionConceptDevModalFields(concept);
  openModal('promo-concept-dev-modal');

  const modalBody = document.querySelector('#promo-concept-dev-modal .modal-body');
  if (modalBody) modalBody.scrollTop = 0;
}

// Status is driven by which footer action was clicked, same as the normal
// modal's saveConceptDevModal -- targetStatus is 'in_development' (Save
// Draft), 'ready_for_review' (Ready for Review), or null (Save Changes on
// an already-submitted concept, leaving concept_dev_status untouched via
// the PATCH route's COALESCE). Deliberately minimal validation (just
// Concept Name) -- per the brief, this modal doesn't carry the normal
// modal's stricter Ready for Review gate.
async function savePromotionConceptDevModal(targetStatus) {
  const product = promoConceptDevModalProduct;
  if (!product) return;
  const name = document.getElementById('promo-modal-name').value.trim();
  if (!name) { toast('Concept name is required', true); return; }

  const avatarSelect = document.getElementById('promo-modal-avatar-select');
  const isOtherAvatar = avatarSelect.value === '__other__';
  const customerAvatarId = avatarSelect.value && !isOtherAvatar ? Number(avatarSelect.value) : null;
  const customAvatarDescription = isOtherAvatar ? document.getElementById('promo-modal-avatar-custom-desc').value.trim() : '';

  const conceptType = conceptDevSelectWithOtherValue('promo-modal-concept-type-select', 'promo-modal-concept-type-custom');
  const conceptAssignee = document.getElementById('promo-modal-assignee-select').value || null;
  const editingOwner = document.getElementById('promo-modal-editing-owner-select').value || null;

  const body = {
    concept_name: name,
    angle: document.getElementById('promo-modal-angle').value.trim(),
    concept_type: conceptType,
    customer_avatar_id: customerAvatarId,
    custom_avatar_description: customAvatarDescription,
    headline: document.getElementById('promo-modal-headline').value.trim(),
    supporting_copy: document.getElementById('promo-modal-supporting-copy').value.trim(),
    cta_text: document.getElementById('promo-modal-cta').value.trim(),
    script_notes: document.getElementById('promo-modal-script').value.trim(),
    hook_variations: promoConceptDevModalHooks
      .map((h) => ({ text: h.text.trim() }))
      .filter((h) => h.text),
    shots: promoConceptDevModalShots
      .map((s) => ({ name: s.name.trim(), capture: s.capture.trim(), location: (s.location || '').trim() }))
      .filter((s) => s.name),
    reference_items: promoConceptDevModalReferences
      .map((r) => (r.library_reference_id
        ? { url: r.url.trim(), note: r.note.trim(), library_reference_id: r.library_reference_id }
        : { url: r.url.trim(), note: r.note.trim() }))
      .filter((r) => r.url),
    talent_requirement: conceptDevSelectWithOtherValue('promo-modal-talent-select', 'promo-modal-talent-custom'),
    props_notes: document.getElementById('promo-modal-props').value.trim(),
    // New vs Existing is a one-time choice made at creation (same
    // immutability as Format -- neither toggle is ever shown again once the
    // concept exists), always NULL for Static. Resending the already-set
    // value on every save of an existing concept is a harmless no-op.
    concept_origin: promoConceptDevModalFormat === 'video' ? promoConceptDevModalOrigin : null,
  };
  if (targetStatus) body.concept_dev_status = targetStatus;
  const savedToast = targetStatus === 'ready_for_review' ? 'Marked Ready for Review' : (targetStatus ? 'Draft saved' : 'Changes saved');

  // "Other / New Type" persists to concept_types so it's reusable for
  // future concepts, same as the normal modal and the Promotion "Shoot This
  // Week" create form.
  if (conceptType && !state.conceptTypes.some((t) => t.name.toLowerCase() === conceptType.toLowerCase())) {
    try {
      const created = await api('/concept-types', { method: 'POST', body: JSON.stringify({ name: conceptType }) });
      state.conceptTypes.push(created);
    } catch (e) { /* non-fatal -- the concept itself still saves with the typed value */ }
  }

  try {
    if (promoConceptDevModalConceptId) {
      await api(`/concept-development/concepts/${promoConceptDevModalConceptId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      await api(`/creative-assets/${promoConceptDevModalConceptId}/assignee`, {
        method: 'PATCH',
        body: JSON.stringify({ concept_assignee: conceptAssignee, editing_owner: editingOwner }),
      });
    } else if (promoConceptDevBootstrapContext) {
      // Add Concept -> New Concept (item 3): no shoot_plan_item exists at
      // all yet -- mint one now via the exact same POST /shoot-plan every
      // other source uses, using the Filming/Shoot Week this bootstrap-only
      // section collected, then fall straight into the same PATCH the
      // "concept already exists" branch above uses. One user action, one
      // network round trip's worth of modal, zero second popups.
      const format = document.getElementById('promo-modal-format-select').value;
      const filming = document.getElementById('promo-modal-filming-select').value || CONCEPT_ASSIGNEES[0];
      const weekStart = document.getElementById('promo-modal-week-select').value;
      const item = await api('/shoot-plan', {
        method: 'POST',
        body: JSON.stringify({
          concept_name: name,
          format,
          creator: filming,
          editing_owner: editingOwner,
          source: 'promotion',
          promotion_stage_id: promoConceptDevBootstrapContext.stageId,
          week_start: weekStart,
        }),
      });
      await api(`/concept-development/concepts/${item.asset_id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      if (conceptAssignee) {
        await api(`/creative-assets/${item.asset_id}/assignee`, {
          method: 'PATCH',
          body: JSON.stringify({ concept_assignee: conceptAssignee, editing_owner: editingOwner }),
        });
      }
    } else {
      const format = document.getElementById('promo-modal-format-select').value;
      const asset = await api('/concept-development/concepts', {
        method: 'POST',
        body: JSON.stringify({ shoot_plan_item_id: product.shoot_plan_item_id, concept_name: name, format }),
      });
      await api(`/concept-development/concepts/${asset.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      if (conceptAssignee || editingOwner) {
        await api(`/creative-assets/${asset.id}/assignee`, {
          method: 'PATCH',
          body: JSON.stringify({ concept_assignee: conceptAssignee, editing_owner: editingOwner }),
        });
      }
    }
    closeModal('promo-concept-dev-modal');
    const bootstrapping = !!promoConceptDevBootstrapContext;
    promoConceptDevBootstrapContext = null;
    toast(bootstrapping && targetStatus === 'ready_for_review' ? 'Sent to Tuesday Review' : savedToast);
    // Opened from What We Have (Promotion Campaign Stage), or just minted
    // from Add Concept -> New Concept (item 3, same page) -- either way
    // refresh that page's card list in place instead of the (hidden)
    // Concept Dev tab, so the concept just saved never looks stale. Never
    // navigates the user away -- same refresh call savePromotionShootItem
    // already uses.
    if (promoConceptDevOpenedFromStageView || bootstrapping) {
      await refreshCurrentPromotion();
      if (document.getElementById('planning-promotion-stage-view').style.display !== 'none') {
        renderPromotionStageDetailView();
      }
    } else {
      refreshConceptDevAfterChange();
    }
  } catch (e) {
    toast(e.message, true);
  }
}

// Delete Concept (see E1) -- calls the Promotion-specific DELETE endpoint
// (conceptDevelopment.js), which removes both the creative_asset and its
// linked shoot_plan_item in one transaction, so the stage's Planned/Still
// Required numbers are correct the moment this returns (no separate
// recompute needed here -- refreshCurrentPromotion() re-fetches them from
// the same summarizeStage/summarizePromotion logic every other Promotion
// view already uses).
async function deletePromotionConceptDevConcept() {
  if (!promoConceptDevModalConceptId) return;
  if (!(await confirmDialog('Delete this concept? This will remove it from the promotion.'))) return;
  try {
    await api(`/concept-development/concepts/${promoConceptDevModalConceptId}`, { method: 'DELETE' });
    closeModal('promo-concept-dev-modal');
    toast('Concept deleted');
    if (promoConceptDevOpenedFromStageView) {
      await refreshCurrentPromotion();
      if (document.getElementById('planning-promotion-stage-view').style.display !== 'none') {
        renderPromotionStageDetailView();
      }
    } else {
      refreshConceptDevAfterChange();
    }
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

// One ad per Hook/Opening a concept has -- shared by the per-concept
// summary line and the week-level "Ads to Film" total below.
function tuesdayReviewHookCount(concept) {
  return (Array.isArray(concept.hook_variations) ? concept.hook_variations : []).filter((h) => h && h.text && h.text.trim()).length;
}

// The production question this page exists to answer isn't "how many
// concepts" -- it's "how many ads do we actually need to shoot this week."
// Each Hook/Opening on a concept becomes its own filmed ad, so the total is
// hooks summed across every concept still in play. Killed concepts are
// excluded -- they were explicitly decided not to be made, so counting
// their hooks would overstate the week's real shoot list. Approved,
// Ready for Review, and Changes Required all stay in (nothing's been ruled
// out yet), so this reads as the week's full scope going into the meeting
// and shrinks live as concepts get killed during review.
function tuesdayReviewAdsToFilmCount() {
  return tuesdayReviewAllConcepts()
    .filter((x) => x.concept.concept_dev_status !== 'killed')
    .reduce((sum, x) => sum + tuesdayReviewHookCount(x.concept), 0);
}

function renderTuesdayReviewSummary() {
  const activeConcepts = tuesdayReviewAllConcepts().filter((x) => x.concept.concept_dev_status !== 'killed').length;
  const adsCount = tuesdayReviewAdsToFilmCount();
  const el = document.getElementById('tr-summary');
  if (!el) return;
  el.textContent = `${activeConcepts} Concept${activeConcepts === 1 ? '' : 's'} · ${adsCount} Ad${adsCount === 1 ? '' : 's'} to Film This Week`;
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

// Concept Overview's single compact metadata line -- Product / Customer
// Avatar / Number of Hooks, joined into one small line under the concept
// name rather than the old three separate header/context/summary rows.
// Status is deliberately left out here -- the status pill right next to
// the title already shows it, so repeating it in text would just be the
// same fact twice. Omits any part with no data rather than a placeholder.
function tuesdayReviewOverviewMetaText(concept, product) {
  const hookCount = tuesdayReviewHookCount(concept);
  return [
    product.product_name || null,
    tuesdayReviewAvatarLabel(concept),
    hookCount ? `${hookCount} Hook${hookCount === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
}

// Compact tile, not an agenda card -- name/avatar/status only. The overview
// is a visual board for "see the Style -> see its concepts -> see who
// they're for -> see the status -> click one to review it," not a place to
// read Idea/Opening previews (that's the whole modal's job). A <button>
// (not a div+onclick) so the entire tile is a single native, keyboard-
// reachable control -- no separate "Review Concept ->" text needed.
function tuesdayReviewConceptTileHtml(concept) {
  const avatarLabel = tuesdayReviewAvatarLabel(concept);
  return `
    <button type="button" class="tr-concept-tile" onclick="openTuesdayReviewConcept(${concept.id})">
      <div class="tr-concept-tile-name">${escapeHtml(concept.concept_name)}</div>
      ${avatarLabel ? `<div class="tr-concept-tile-avatar">${escapeHtml(avatarLabel)}</div>` : ''}
      <span class="cd-concept-status-pill ${CONCEPT_DEV_STATUS_CLASS[concept.concept_dev_status] || ''}">${CONCEPT_DEV_STATUS_LABELS[concept.concept_dev_status] || concept.concept_dev_status}</span>
    </button>`;
}

function renderTuesdayReviewList() {
  renderTuesdayReviewFilters();
  renderTuesdayReviewSummary();
  const list = document.getElementById('tr-list');
  const data = state.tuesdayReview.data;
  // Same reasoning as renderConceptDevList: a Promotion New Concept can be
  // ready for review well before its own week's Shoot Plan is confirmed.
  if (!data || (!data.confirmed && !data.products.length)) {
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
        <div class="tr-product-name">${escapeHtml(g.product.product_name || 'No products required')}</div>
        <div class="tr-product-meta">${escapeHtml(tuesdayReviewProductMetaText(g.product))}</div>
      </div>
      <div class="tr-concept-list">${g.concepts.map((c) => tuesdayReviewConceptTileHtml(c)).join('')}</div>
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

// Best-effort platform detection for a Tuesday Review reference card --
// purely cosmetic (icon + label), independent of whether a thumbnail can
// be fetched, so it always resolves even for an unrecognized domain.
function tuesdayReviewReferenceInfo(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host.includes('tiktok')) return { icon: '🎵', platform: 'TikTok' };
    if (host.includes('instagram')) return { icon: '📸', platform: 'Instagram' };
    if (host.includes('youtube') || host.includes('youtu.be')) return { icon: '▶️', platform: 'YouTube' };
    if (host.includes('pinterest')) return { icon: '📌', platform: 'Pinterest' };
    return { icon: '🔗', platform: host };
  } catch {
    return { icon: '🔗', platform: 'Website' };
  }
}

// YouTube's still-image thumbnail is a plain, dependency-free <img src> --
// no embed SDK, no API key, no CORS/CSP risk -- so it's the one platform
// safe to show a real preview for. Every other platform (notably TikTok
// and Instagram, whose previews need an embed/API that can silently break)
// intentionally gets no thumbnail attempt at all -- the fallback card
// below already satisfies "get to the reference immediately."
function youTubeThumbnailUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1);
    else if (host.includes('youtube')) {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else if (u.pathname.startsWith('/shorts/')) id = u.pathname.split('/')[2];
      else if (u.pathname.startsWith('/embed/')) id = u.pathname.split('/')[2];
    }
    return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : null;
  } catch {
    return null;
  }
}

// One card per Tuesday Review reference -- platform + note + a big, obvious
// Open action that's always present regardless of whether a thumbnail
// loads. A thumbnail (YouTube only, see youTubeThumbnailUrl) sits on top
// when available; onerror removes it and the card still works the same
// without one -- nothing here ever depends on it.
function tuesdayReviewReferenceCardHtml(r) {
  const info = tuesdayReviewReferenceInfo(r.url);
  const thumb = youTubeThumbnailUrl(r.url);
  const note = r.note && r.note.trim();
  return `
    <div class="tr-reference-card">
      ${thumb ? `<img class="tr-reference-thumb" src="${escapeHtml(thumb)}" alt="" onerror="this.remove()">` : ''}
      <div class="tr-reference-platform">${info.icon} ${escapeHtml(info.platform)}</div>
      ${note ? `<div class="tr-reference-note">${escapeHtml(note)}</div>` : ''}
      <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener" class="tr-reference-open">Open Reference &#8599;</a>
    </div>`;
}

function formatTuesdayReviewDate(iso) {
  return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

// Read-only row per hook -- ALL hooks belonging to an approved concept get
// filmed (the backend/body of the video can be shared, with each hook shot
// as its own opening variation), so Tuesday Review is not a "pick the one
// winning hook" decision. Primary / Alt 01 / Alt 02 remain as organising
// labels only -- every row displays neutrally, with no highlight/selection
// state and no click action. See the Shoot Brief (renderShootingBriefStructured
// in this file), which already renders every hook as its own "Film All"
// capture item regardless of any legacy `selected` flag.
function tuesdayReviewHookRowHtml(h, index) {
  const tag = index === 0 ? 'Primary' : `Alt ${String(index).padStart(2, '0')}`;
  return `
    <div class="tr-hook-row">
      <span class="tr-hook-tag">${tag}</span>
      <div class="tr-hook-text">&ldquo;${escapeHtml(h.text.trim())}&rdquo;</div>
    </div>`;
}

// One compact label/value row per populated Shoot Setup field -- only
// fields that actually contain information ever get a row.
function tuesdayReviewShootSetupRowHtml(label, value) {
  return `<div class="tr-shoot-setup-row"><span class="tr-shoot-setup-label">${escapeHtml(label)}</span><div class="tr-shoot-setup-value">${escapeHtml(value)}</div></div>`;
}

// One compact card per Shot -- type and location sit on the same visual
// level (what + where, glanceable together), with the capture direction
// as secondary text underneath. Location is only ever the actual saved
// per-shot value (fixed option or free-typed custom text) -- there is no
// separate "Custom Location" label to accidentally display.
function tuesdayReviewShotCardHtml(s) {
  const hasLocation = Boolean(s.location && s.location.trim());
  const hasCapture = Boolean(s.capture && s.capture.trim());
  return `
    <div class="tr-shot-card">
      <div class="tr-shot-card-top">
        <span class="tr-shot-type">${escapeHtml(s.name.trim())}</span>
        ${hasLocation ? `<span class="tr-shot-pin">📍 ${escapeHtml(s.location.trim())}</span>` : ''}
      </div>
      ${hasCapture ? `<div class="tr-shot-detail">${escapeHtml(s.capture.trim())}</div>` : ''}
    </div>`;
}

// Order deliberately follows the brief: Idea -> Audience -> Hooks -> What
// to Shoot -> References (if provided) -> Script (if provided) -> Shoot
// Setup (if provided). Legacy Execution (superseded by structured Shots)
// sits right after What to Shoot, but only ever renders for an older
// concept that actually has that data -- a new-format concept never shows
// it. Everything is plain text, no inputs.
function renderTuesdayReviewConcept() {
  const entry = state.tuesdayReview.queue[state.tuesdayReview.queueIndex];
  if (!entry) return;
  const { concept, product } = entry;

  document.getElementById('tr-review-position').textContent = `${state.tuesdayReview.queueIndex + 1} of ${state.tuesdayReview.queue.length}`;
  document.getElementById('tr-review-prev-btn').disabled = state.tuesdayReview.queueIndex === 0;
  document.getElementById('tr-review-next-btn').disabled = state.tuesdayReview.queueIndex === state.tuesdayReview.queue.length - 1;

  document.getElementById('tr-review-move-back-btn').style.display = state.currentUser && state.currentUser.role === 'admin' ? '' : 'none';
  document.getElementById('tr-review-title').textContent = concept.concept_name;
  const statusPill = document.getElementById('tr-review-status-pill');
  statusPill.className = `cd-concept-status-pill ${CONCEPT_DEV_STATUS_CLASS[concept.concept_dev_status] || ''}`;
  statusPill.textContent = CONCEPT_DEV_STATUS_LABELS[concept.concept_dev_status] || concept.concept_dev_status;

  document.getElementById('tr-review-overview-meta').textContent = tuesdayReviewOverviewMetaText(concept, product);

  document.getElementById('tr-review-angle').textContent = concept.angle && concept.angle.trim() ? concept.angle.trim() : 'No Angle / Idea provided';

  // Promotion/Stage: only rendered for Promotion-sourced concepts -- reuses
  // the same read-only promotion_name/promotion_stage_name/promotion_notes
  // data already shown in the Promotion Concept Development modal. Hidden
  // entirely for every Core/High Stock/Drop concept.
  const promoSection = document.getElementById('tr-review-promotion-section');
  if (product.source === 'promotion') {
    promoSection.style.display = '';
    document.getElementById('tr-review-promotion').textContent = [
      product.promotion_name,
      product.promotion_stage_name,
      product.promotion_notes && product.promotion_notes.trim(),
    ].filter(Boolean).join(' · ');
  } else {
    promoSection.style.display = 'none';
  }

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
  // "Why should they care?" is no longer asked for new concepts -- hidden
  // entirely here unless an older concept actually has this answer on
  // record (same backwards-compatible show-only-if-present treatment as
  // legacy Execution below).
  const whyCareWrap = document.getElementById('tr-review-why-care-wrap');
  const hasWhyCare = Boolean(concept.avatar_why_care && concept.avatar_why_care.trim());
  whyCareWrap.style.display = hasWhyCare ? '' : 'none';
  if (hasWhyCare) document.getElementById('tr-review-why-care').textContent = concept.avatar_why_care.trim();

  // Every hook belonging to this concept gets filmed if the concept is
  // approved -- Tuesday Review is not choosing a single winning hook here,
  // just displaying them (see tuesdayReviewHookRowHtml).
  const hooks = (Array.isArray(concept.hook_variations) ? concept.hook_variations : []).filter((h) => h && h.text && h.text.trim());
  const hooksEl = document.getElementById('tr-review-hooks');
  hooksEl.innerHTML = hooks.length
    ? hooks.map((h, i) => tuesdayReviewHookRowHtml(h, i)).join('')
    : '<div class="tr-review-subtle">No specific Hook / Opening provided</div>';

  // Copy/Message: only rendered when a Static Promotion concept actually has
  // at least one of headline/supporting_copy/cta_text set (see schema.sql's
  // comment on those columns) -- hidden entirely for every Video concept and
  // every Core/High Stock/Drop concept, which never set these fields.
  const copySection = document.getElementById('tr-review-copy-section');
  const hasCopy = Boolean(
    (concept.headline && concept.headline.trim())
    || (concept.supporting_copy && concept.supporting_copy.trim())
    || (concept.cta_text && concept.cta_text.trim())
  );
  if (!hasCopy) {
    copySection.style.display = 'none';
  } else {
    copySection.style.display = '';
    document.getElementById('tr-review-copy').innerHTML = [
      concept.headline && concept.headline.trim() ? `<div><span class="tr-avatar-detail-label">Headline / Main Copy</span>${escapeHtml(concept.headline.trim())}</div>` : '',
      concept.supporting_copy && concept.supporting_copy.trim() ? `<div><span class="tr-avatar-detail-label">Supporting Copy</span>${escapeHtml(concept.supporting_copy.trim())}</div>` : '',
      concept.cta_text && concept.cta_text.trim() ? `<div><span class="tr-avatar-detail-label">CTA</span>${escapeHtml(concept.cta_text.trim())}</div>` : '',
    ].join('');
  }

  // Structured Shots: read-only here -- Tuesday Review only needs to
  // confirm it's clear what to shoot (and where), not to edit it. Legacy
  // Concepts with no structured Shots simply never show this section (no
  // error/empty-required state), and keep showing their Execution text
  // below instead, as they always have. Each shot renders as a compact
  // visual card via tuesdayReviewShotCardHtml -- type + location together,
  // capture direction secondary underneath.
  const shots = (Array.isArray(concept.shots) ? concept.shots : []).filter((s) => s && s.name && s.name.trim());
  const shotsSection = document.getElementById('tr-review-shots-section');
  if (!shots.length) {
    shotsSection.style.display = 'none';
  } else {
    shotsSection.style.display = '';
    document.getElementById('tr-review-shots').innerHTML = shots.map((s) => tuesdayReviewShotCardHtml(s)).join('');
  }

  // Execution / Shot Plan is legacy, superseded by structured Shots above
  // -- entirely hidden (never "No Execution / Shot Plan provided", which
  // would misleadingly make a new-format concept look incomplete) unless
  // an older concept actually has this data on record.
  const executionSection = document.getElementById('tr-review-execution-section');
  const hasExecution = Boolean(concept.execution && concept.execution.trim());
  executionSection.style.display = hasExecution ? '' : 'none';
  if (hasExecution) document.getElementById('tr-review-execution').textContent = concept.execution.trim();

  const scriptSection = document.getElementById('tr-review-script-section');
  const hasScript = Boolean(concept.script_notes && concept.script_notes.trim());
  scriptSection.style.display = hasScript ? '' : 'none';
  if (hasScript) document.getElementById('tr-review-script').textContent = concept.script_notes;

  const refs = (Array.isArray(concept.reference_items) ? concept.reference_items : []).filter((r) => r && r.url);
  const refsSection = document.getElementById('tr-review-references-section');
  if (!refs.length) {
    refsSection.style.display = 'none';
  } else {
    refsSection.style.display = '';
    document.getElementById('tr-review-references').innerHTML = refs.map((r) => tuesdayReviewReferenceCardHtml(r)).join('');
  }

  // Shown immediately, no expand/collapse -- Tuesday Review is where the
  // team needs to catch production requirements before approving, so
  // burying Props behind a click defeats the point. `location` here is the
  // legacy overall-location field only (new-format concepts never set it --
  // their location lives per-Shot, see What to Shoot above), so this never
  // duplicates it for a new-format concept.
  // Styles Needed: only rendered when the product actually has colourways
  // attached (product.colourways.length > 0) -- a Static Promotion concept
  // with "No products required" simply never shows this section, reusing
  // the same read-only per-colourway data every other section here reads
  // from `product`.
  const stylesSection = document.getElementById('tr-review-styles-section');
  const colourways = product.colourways || [];
  if (!colourways.length) {
    stylesSection.style.display = 'none';
  } else {
    stylesSection.style.display = '';
    document.getElementById('tr-review-styles').innerHTML = colourways.map((c) => `
      <div class="tr-shot-card">
        <div class="tr-shot-card-top">
          <span class="tr-shot-type">${escapeHtml(c.colour_label || c.style_code)}</span>
        </div>
        ${c.size ? `<div class="tr-shot-detail">${escapeHtml(c.size)}</div>` : ''}
      </div>`).join('');
  }

  const shootReqSection = document.getElementById('tr-review-shoot-req-section');
  const hasTalent = Boolean(concept.talent_requirement && concept.talent_requirement.trim());
  const hasLegacyLocation = Boolean(concept.location && concept.location.trim());
  const hasProps = Boolean(concept.props_notes && concept.props_notes.trim());
  if (!hasTalent && !hasLegacyLocation && !hasProps) {
    shootReqSection.style.display = 'none';
  } else {
    shootReqSection.style.display = '';
    document.getElementById('tr-review-shoot-setup').innerHTML = [
      hasTalent ? tuesdayReviewShootSetupRowHtml('Talent / Model', concept.talent_requirement.trim()) : '',
      hasLegacyLocation ? tuesdayReviewShootSetupRowHtml('Location', concept.location.trim()) : '',
      hasProps ? tuesdayReviewShootSetupRowHtml('Props / Requirements', concept.props_notes.trim()) : '',
    ].join('');
  }

  updateTuesdayReviewDecisionBar(concept);
}

function toggleTuesdayReviewAvatarDetail() {
  const el = document.getElementById('tr-review-avatar-detail');
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

// Approving moves the whole concept -- every one of its hooks included --
// into Shooting as a single unit. There is no per-hook decision here: all
// hooks the concept has get filmed (the shared backend/body footage can be
// reused across each hook's opening), so nothing about hook_variations
// needs to be sent or validated on approval.
async function approveTuesdayReviewConcept() {
  const entry = state.tuesdayReview.queue[state.tuesdayReview.queueIndex];
  if (!entry) return;
  await submitTuesdayReviewDecision(entry.concept.id, 'approved', {});
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

function prevWeekStartFrom(weekStartStr) {
  const d = parseDateStr(weekStartStr);
  d.setDate(d.getDate() - 7);
  return isoDateStr(d);
}

// Move Week (task: Shooting/Editing week rescheduling) -- "a specific
// available week" list for the card-level "Move to week..." menu item.
// Same "This Week/Next Week/WK NN — W/C ..." label convention Promotion
// intake's Shoot Week dropdown already established (populatePromotionShootWeekOptions),
// just widened to include a few recent past weeks too (that dropdown is
// forward-only, built for scheduling a brand-new shoot -- this is for moving
// already-existing unfinished work, which can reasonably move a little
// backward as well as forward).
function moveWeekOptions() {
  const options = [];
  for (let offset = -4; offset <= 8; offset++) {
    const monday = mondayOfWeek(offset);
    const value = isoDateStr(monday);
    const wk = `WK ${isoWeekNumber(monday)}`;
    let label;
    if (offset === 0) label = `This Week — ${wk}`;
    else if (offset === 1) label = `Next Week — ${wk}`;
    else if (offset === -1) label = `Last Week — ${wk}`;
    else label = `${wk} — W/C ${monday.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}`;
    options.push({ value, label });
  }
  return options;
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

// Filming-person filter -- sourced from CONCEPT_ASSIGNEES (Mark/Shez/Til),
// the app's one small "real production people" roster, NOT
// state.contentCreators (every app user who can run Shoot Plan intake --
// Brendan, Lucy, Max, Sheridan, Steve, etc.). Showing the full user list
// here was the "All Owners" problem the brief called out. "Other" is its
// own explicit bucket (rather than folding into "All") so historical/
// outside-roster work (e.g. an older Sami assignment) stays reachable and
// visible instead of only ever showing up mixed into the unfiltered "All"
// view -- see isOtherFilmingPerson/shootingOwnerMatches below. Rendered as
// buttons (not a <select>) into the .person-filter containers, shared
// client-side across Week/Today, no refetch needed on change since both
// views already have the full week's data in hand.
function populateShootingOwnerFilters() {
  const names = ['all', ...CONCEPT_ASSIGNEES, 'other'];
  const buttonsHtml = names.map((name) => {
    const label = name === 'all' ? 'All' : name === 'other' ? 'Other' : escapeHtml(name);
    const active = state.shooting.ownerFilter === name ? ' person-filter-btn-active' : '';
    return `<button type="button" class="person-filter-btn${active}" data-value="${escapeHtml(name)}" onclick="setShootingOwnerFilter('${escapeHtml(name)}')">${label}</button>`;
  }).join('');
  ['shoot-week-owner-filter', 'shoot-today-owner-filter'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = buttonsHtml;
  });
}

// True for anyone outside the Mark/Shez/Til operational roster -- including
// nobody assigned at all. Shared by Shooting's "Other" filter and Editing's
// (see editingVisibleConcepts) so both buckets mean the same thing.
function isOutsideConceptAssigneeRoster(name) {
  return !name || !CONCEPT_ASSIGNEES.includes(name);
}

// The one place a person name maps to a colour-accent key -- backs the
// person-accent-* CSS classes (see :root's --person-mark/shez/til/other in
// styles.css). Shared by every card that surfaces a Filming/Editing
// assignment so the same person always gets the same colour, never a
// per-view remap. No accent for "nobody assigned" -- an unassigned card
// stays visually neutral (the default card border), not falsely bucketed
// into "Other".
function personAccentKey(name) {
  if (!name) return '';
  return CONCEPT_ASSIGNEES.includes(name) ? name.toLowerCase() : 'other';
}

function setShootingOwnerFilter(value) {
  state.shooting.ownerFilter = value;
  document.querySelectorAll('#shoot-week-owner-filter, #shoot-today-owner-filter').forEach((container) => {
    container.querySelectorAll('.person-filter-btn').forEach((btn) => {
      btn.classList.toggle('person-filter-btn-active', btn.dataset.value === value);
    });
  });
  if (state.shooting.view === 'week') renderShootingWeekView();
  else if (state.shooting.view === 'today') renderShootingTodayView();
}

function shootingOwnerMatches(item) {
  if (state.shooting.ownerFilter === 'all') return true;
  if (state.shooting.ownerFilter === 'other') return isOutsideConceptAssigneeRoster(item.owner);
  return item.owner === state.shooting.ownerFilter;
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
  // Move Week: previous/next week (same reschedule pattern as the day items
  // above, just changing scheduled_week_start instead of scheduled_day) plus
  // a "pick a specific week" list -- see moveWeekOptions/showShootWeekPicker.
  // "Scheduled"/"In Progress" both keep their status: moveShootingCard sends
  // the same PATCH /shooting/:id this menu already used for day moves, whose
  // status CASE only ever forces 'unscheduled' when scheduled_day becomes
  // null -- never touched here.
  const prevWeekItem = `<button type="button" class="shoot-card-menu-item" onclick="moveShootingCard(${item.id}, 'carry_prev_week', '${item.scheduled_week_start}'); closeAllShootCardMenus();">&larr; Move to previous week</button>`;
  const carryItem = `<button type="button" class="shoot-card-menu-item shoot-card-menu-item-carry" onclick="moveShootingCard(${item.id}, 'carry_next_week', '${item.scheduled_week_start}'); closeAllShootCardMenus();">Carry to next week &rarr;</button>`;
  const pickWeekItem = `<button type="button" class="shoot-card-menu-item" onclick="showShootWeekPicker(${item.id}, '${item.scheduled_week_start}')">Move to week&hellip;</button>`;
  return `<div class="shoot-card-menu-label">Move to</div>${dayItems}${unscheduledItem}${prevWeekItem}${carryItem}${pickWeekItem}`;
}

// "Move to week..." replaces the same dropdown's contents in place with the
// week list (see moveWeekOptions) -- no second modal, no page navigation.
// Clicking a week or clicking outside both close it via the existing
// closeAllShootCardMenus/document click-away handler.
function showShootWeekPicker(scheduleId, currentWeekStart) {
  const menu = document.getElementById(`shoot-card-menu-${scheduleId}`);
  if (!menu) return;
  const rows = moveWeekOptions()
    .map((o) => `<button type="button" class="shoot-card-menu-item" onclick="moveShootingCard(${scheduleId}, 'week:${o.value}', '${currentWeekStart}'); closeAllShootCardMenus();">${escapeHtml(o.label)}</button>`)
    .join('');
  menu.innerHTML = `<div class="shoot-card-menu-label">Move to week</div>${rows}`;
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
    const isWeekPick = typeof value === 'string' && value.startsWith('week:');
    const body = value === 'unscheduled' ? { scheduled_day: null }
      : value === 'carry_next_week' ? { scheduled_day: null, scheduled_week_start: nextWeekStartFrom(currentWeekStart) }
      : value === 'carry_prev_week' ? { scheduled_day: null, scheduled_week_start: prevWeekStartFrom(currentWeekStart) }
      : isWeekPick ? { scheduled_day: null, scheduled_week_start: value.slice(5) }
      : { scheduled_day: value };
    await api(`/shooting/${scheduleId}`, { method: 'PATCH', body: JSON.stringify(body) });
    toast(value === 'carry_next_week' ? 'Carried to next week'
      : value === 'carry_prev_week' ? 'Moved to previous week'
      : isWeekPick ? 'Moved to selected week'
      : 'Moved');
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
// Round 11: Shot/Filmed is the one reversal worth protecting -- completing
// it may have already made the Concept eligible for Editing (ready_for_editing),
// so an accidental undo here has a bigger blast radius than Scheduled<->In
// Progress. A confirm step is all that changes; the actual revert is still
// the same tested unmark-shot endpoint (back to Scheduled, not a new
// "in_progress" landing state), which already clears ready_for_editing on
// the SAME shoot_schedule row -- no new rows, nothing duplicated -- and only
// rolls the canonical creative_assets.status back if Editing hasn't already
// moved it past 'filming' (see the backend's syncDropStatusRevert).
async function unmarkShootingShot(scheduleId) {
  if (!(await confirmDialog('Move this back to In Progress? This will make it active in Shooting again.', { okLabel: 'Move Back' }))) return;
  try {
    await api(`/shooting/${scheduleId}/unmark-shot`, { method: 'POST' });
    toast('Unmarked as Shot');
    refreshCurrentShootingView();
  } catch (e) {
    toast(e.message, true);
  }
}

// Scheduled -> In Progress (see the Scheduling brief, item 7) -- and its
// undo. Never touches ready_for_editing -- only markShootingShot does, so
// starting a shoot can never leak the concept into Editing.
async function startShooting(scheduleId) {
  try {
    await api(`/shooting/${scheduleId}/start`, { method: 'POST' });
    toast('Marked as In Progress');
    refreshCurrentShootingView();
  } catch (e) {
    toast(e.message, true);
  }
}

async function unstartShooting(scheduleId) {
  try {
    await api(`/shooting/${scheduleId}/unstart`, { method: 'POST' });
    toast('Reverted to Scheduled');
    refreshCurrentShootingView();
  } catch (e) {
    toast(e.message, true);
  }
}

// "Shot" for a static/photo concept, "Filmed" for video -- same format-aware
// labelling convention Upcoming Drops' own progress checkboxes already use
// (see conceptProgressStageLabel), reused here rather than a second mapping.
function shootingProductionLabel(format) {
  return format === 'static' ? 'Shot' : 'Filmed';
}

// The obvious, explicit production-status control the brief calls for --
// three labelled segments (Scheduled / In Progress / Shot·Filmed), not a
// single passive-looking badge someone has to discover is clickable.
// Deliberately linear: only the segment immediately after the current one
// (advance) or the current one itself, if there's somewhere to undo back to
// (revert), is ever clickable -- matches exactly the two small transitions
// each backend endpoint supports (start/unstart, mark-shot/unmark-shot), no
// arbitrary jumping between states.
function shootingStatusControlHtml(item) {
  const stages = ['scheduled', 'in_progress', 'shot'];
  const labels = { scheduled: 'Scheduled', in_progress: 'In Progress', shot: shootingProductionLabel(item.format) };
  const currentIndex = stages.indexOf(item.status);
  return `<div class="shoot-status-control" onclick="event.stopPropagation()">${stages.map((stage, i) => {
    const isCurrent = i === currentIndex;
    const isNext = i === currentIndex + 1;
    let onclick = null;
    if (isNext) onclick = stage === 'in_progress' ? `startShooting(${item.id})` : `markShootingShot(${item.id})`;
    else if (isCurrent && i > 0) onclick = stage === 'in_progress' ? `unstartShooting(${item.id})` : `unmarkShootingShot(${item.id})`;
    const title = isNext ? `Mark as ${labels[stage]}` : (onclick ? `Undo -- revert to ${labels[stages[i - 1]]}` : '');
    return `<button type="button" class="shoot-status-segment${isCurrent ? ' shoot-status-segment-active' : ''}" ${onclick ? `onclick="${onclick}"` : 'disabled'} title="${title}">${labels[stage]}</button>`;
  }).join('')}</div>`;
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
  const carriedBadge = item.carried_over ? `<span class="shoot-carried-badge">From W${isoWeekNumber(parseDateStr(item.original_week_start))}</span>` : '';
  const statusHtml = shootingStatusControlHtml(item);
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
  // Drop context badge -- source/drop_name only ever populate for a Drop
  // Required Concept's card (see shooting.js's SUMMARY_SELECT), so Mark/Shez
  // can tell what they're shooting without a second Drop-only Shooting page
  // (see the Drop -> Shooting brief, item 8).
  const dropBadge = item.source === 'drop' && item.drop_name
    ? `<span class="shoot-card-drop-badge">${escapeHtml(item.drop_name)}</span>` : '';
  // Filming person -- deliberately its own labelled line (see the
  // Scheduling brief, item 6: "the person's name is visually buried"),
  // never lumped into the same meta line as Location the way "Owner" used
  // to be. The person-accent-* class on the card (left-edge colour) and the
  // small pill next to the name are purely supplementary scanning aids for
  // the All view -- the written "Filming: Name" label stays as the actual
  // source of truth, never colour alone (see personAccentKey).
  const personKey = personAccentKey(item.owner);
  // The pill is redundant noise once a single person is already the active
  // filter (every visible card is already theirs) -- it only earns its
  // place in the "All" view, where distinguishing cards at a glance is the
  // actual problem being solved. The left-edge accent stays in every view
  // regardless -- it's subtle enough not to add noise on its own.
  const personPill = item.owner && state.shooting.ownerFilter === 'all' ? `<span class="shoot-card-person-pill person-accent-${personKey}">${escapeHtml(item.owner)}</span>` : '';
  const filmingHtml = item.owner ? `<div class="shoot-card-filming">Filming: <strong>${escapeHtml(item.owner)}</strong></div>` : '';
  const metaParts = [item.location].filter(Boolean);
  return `
    <div class="shoot-card ${personKey ? `person-accent-${personKey}` : ''} ${isShot ? 'shoot-card-shot' : ''}" ${isShot ? '' : 'draggable="true"'} ondragstart="onShootCardDragStart(event, ${item.id})" onclick="openShootingBrief(${item.id})">
      <div class="shoot-card-name">${dragHandle}${escapeHtml(item.concept_name)}${personPill}</div>
      <div class="shoot-card-product">${escapeHtml(item.product_name || '—')}${dropBadge}</div>
      ${filmingHtml}
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
  const dropBadge = item.source === 'drop' && item.drop_name
    ? `<span class="shoot-card-drop-badge">${escapeHtml(item.drop_name)}</span>` : '';
  const filmingHtml = item.owner ? `<div class="shoot-card-filming">Filming: <strong>${escapeHtml(item.owner)}</strong></div>` : '';
  return `
    <div class="shoot-today-item ${isShot ? 'shoot-card-shot' : ''}">
      <div class="shoot-today-item-main">
        <div class="shoot-card-name">${escapeHtml(item.concept_name)}</div>
        <div class="shoot-card-product">${escapeHtml(item.product_name || '—')}${dropBadge}</div>
        ${filmingHtml}
        ${metaParts.length ? `<div class="shoot-card-meta">${escapeHtml(metaParts.join(' · '))}</div>` : ''}
        ${hookPreview ? `<div class="shoot-today-hook">&ldquo;${escapeHtml(hookPreview)}&rdquo;</div>` : ''}
      </div>
      <div class="shoot-today-item-actions">
        ${shootingStatusControlHtml(item)}
        <button type="button" class="link-btn" onclick="openShootingBrief(${item.id})">View Shoot Brief &rarr;</button>
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
    state.shooting.briefData = brief;
    document.getElementById('shoot-brief-move-back-btn').style.display = state.currentUser && state.currentUser.role === 'admin' ? '' : 'none';
    renderShootingBrief(brief);
    openModal('shoot-brief-modal');
  } catch (e) {
    toast(e.message, true);
  }
}

// Purely mechanical text layout -- none of these functions rewrite,
// reorder, or invent a single word of the approved Execution/Hook text
// (see the brief: "Do not change or rewrite the underlying approved
// Concept / Execution / Shot Plan data"). They only decide how the
// existing text is grouped and labelled on screen.

// Splits the Execution/Shot Plan into its natural shoot beats using the
// creator's OWN line/paragraph breaks -- never the old forced sentence
// splitting that produced an arbitrary "01 02 03" numbered wall of text.
// A single unbroken block of prose stays as one beat rather than being
// chopped up into fragments that don't map to anything you'd actually
// shoot.
function shootingExecutionBeats(text) {
  if (!text || !text.trim()) return [];
  const trimmed = text.trim();
  const paragraphs = trimmed.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length > 1) return paragraphs;
  const lines = trimmed.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  if (lines.length > 1) return lines;
  return [trimmed];
}

// A heading reads as a short tag or timing cue -- mostly capitals,
// digits, and light punctuation (a dash is fine INSIDE a label, e.g.
// "3-5 SEC -- Pick Your Rotation") -- never a lowercase sentence, and
// never containing its own colon (that would actually be a "Label:
// instruction" line -- see shootingLabeledLine -- not a whole heading).
function shootingLooksLikeShootLabel(text) {
  const t = text.trim();
  if (!t || t.length > 56 || t.includes(':')) return false;
  return /\d/.test(t) || /^[A-Z0-9 /&'.,+—–-]+$/.test(t);
}

// A beat/Hook's heading can show up in two shapes the creator might
// actually write, and this only ever recognises them -- never invents
// one that isn't there:
//   (A) "LABEL: rest of the beat" run together on one line/paragraph,
//       e.g. "0-2 SEC: Wardrobe Problem. James stands at his wardrobe...".
//       Colon/middle-dot only as the separator -- never a bare hyphen,
//       since hyphens already appear inside timing ranges like "0-2".
//   (B) the heading is its own whole line -- e.g. "3-5 SEC -- Pick Your
//       Rotation" or "FIT DETAILS" -- with the actual direction starting
//       fresh on the next line. No timestamp is required for this shape.
function shootingBeatHeading(beat) {
  const inline = beat.match(/^([^\n:·]{1,48})[:·]\s+(\S[\s\S]*)$/);
  if (inline && shootingLooksLikeShootLabel(inline[1])) {
    return { heading: inline[1].trim(), body: inline[2].trim() };
  }
  const nlIndex = beat.indexOf('\n');
  if (nlIndex > -1) {
    const firstLine = beat.slice(0, nlIndex).trim();
    const rest = beat.slice(nlIndex + 1).trim();
    if (rest && shootingLooksLikeShootLabel(firstLine)) {
      return { heading: firstLine, body: rest };
    }
  }
  return { heading: null, body: beat };
}

// A supporting line the creator already wrote as "Label: the actual
// instruction" -- e.g. "Shot: Overhead flatlay...", "Text / VO: \"3 tees.
// $130.\"", "Transition: ...", "Direction: ...". Only the label gets
// bolded (Level 3); the instruction itself is never touched. The label
// must stay short (at most 4 words) so an ordinary sentence that happens
// to contain a colon is never mistaken for one.
function shootingLabeledLine(line) {
  const m = line.match(/^([A-Za-z][A-Za-z0-9 /&'-]{0,26}):\s+(\S[\s\S]*)$/);
  if (!m) return null;
  const [, label, value] = m;
  if (label.trim().split(/\s+/).length > 4) return null;
  return { label: label.trim(), value: value.trim() };
}

// Renders a beat/Hook's body one line at a time -- any line already
// written as "Label: value" gets its label bolded (Level 3, see
// shootingLabeledLine); every other line stays a plain paragraph. Wording
// is never rewritten either way, only how it's grouped on screen.
function shootingRenderBeatBody(body) {
  const lines = body.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  return lines.map((line) => {
    const labeled = shootingLabeledLine(line);
    return labeled
      ? `<div class="shoot-brief-line"><span class="shoot-brief-line-label">${escapeHtml(labeled.label)}:</span> ${escapeHtml(labeled.value)}</div>`
      : `<div class="shoot-brief-text">${escapeHtml(line)}</div>`;
  }).join('');
}

function shootingChecklistStorageKey(scheduleId) {
  return `wndrr-shoot-checklist-${scheduleId}`;
}

function shootingChecklistLoad(scheduleId) {
  try {
    const raw = localStorage.getItem(shootingChecklistStorageKey(scheduleId));
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function shootingChecklistSave(scheduleId, checked) {
  try {
    localStorage.setItem(shootingChecklistStorageKey(scheduleId), JSON.stringify(checked));
  } catch (e) { /* private-browsing / storage full -- checklist just won't persist */ }
}

// Major footage groups only (item 5) -- one item per Hook plus one for the
// shared Backend, never one per sentence/instruction. Adapts to whatever
// the Concept actually has: a single Hook reads as "Opening", not "Hook 1".
function shootingChecklistItems(hooks, beats) {
  const items = hooks.length > 1
    ? hooks.map((h, i) => ({ key: `hook-${i + 1}`, label: `Hook ${i + 1}` }))
    : hooks.length === 1 ? [{ key: 'hook-1', label: 'Opening' }] : [];
  if (beats.length) items.push({ key: 'backend', label: 'Backend' });
  return items;
}

function renderShootingChecklist() {
  const items = state.shooting.briefChecklistItems;
  const checked = state.shooting.briefChecklistChecked;
  const section = document.getElementById('shoot-brief-checklist-section');
  if (!items.length) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  const doneCount = items.filter((it) => checked[it.key]).length;
  document.getElementById('shoot-brief-checklist-count').textContent = `${doneCount}/${items.length} captured`;
  document.getElementById('shoot-brief-checklist').innerHTML = items.map((it) => `
    <label class="shoot-brief-checklist-item ${checked[it.key] ? 'is-checked' : ''}">
      <input type="checkbox" ${checked[it.key] ? 'checked' : ''} onchange="toggleShootingChecklistItem('${it.key}')">
      <span>${escapeHtml(it.label)}</span>
    </label>`).join('');
}

function toggleShootingChecklistItem(key) {
  const scheduleId = state.shooting.briefScheduleId;
  if (!scheduleId) return;
  state.shooting.briefChecklistChecked[key] = !state.shooting.briefChecklistChecked[key];
  shootingChecklistSave(scheduleId, state.shooting.briefChecklistChecked);
  renderShootingChecklist();
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
    brief.drop_name ? `Drop: ${brief.drop_name}` : null,
    brief.owner ? `Filming: ${brief.owner}` : null,
    skuInfo,
  ].filter(Boolean).join(' &middot; ');
  document.getElementById('shoot-brief-context').innerHTML = `
    ${brief.image_url ? `<img class="cd-modal-context-thumb" src="${brief.image_url}" alt="">` : '<span class="cd-modal-context-thumb cd-modal-context-noimg">🖼</span>'}
    <div class="cd-modal-context-lines"><div class="cd-modal-context-line">${contextLine}</div></div>`;

  const hooks = Array.isArray(brief.hook_variations) ? brief.hook_variations.filter((h) => h.text && h.text.trim()) : [];

  // Structured What to Shoot (items 8-11): once a Concept has real, named
  // Shot records, the Shoot Brief stops reverse-engineering a shot list
  // from Execution prose and instead renders OPENINGS + SHOTS directly
  // from that structured data, each individually checkable. A legacy
  // Concept that never had structured Shots keeps using the exact
  // beats-from-Execution rendering below, completely untouched -- this is
  // the only thing that decides which mode runs.
  const shots = Array.isArray(brief.shots) ? brief.shots.filter((s) => s && s.name && s.name.trim()) : [];
  const usingStructuredShots = shots.length > 0;

  if (usingStructuredShots) {
    renderShootingBriefStructured(brief, hooks, shots);
  } else {
    renderShootingBriefLegacy(brief, hooks);
  }

  document.getElementById('shoot-brief-mark-shot-btn').style.display = isShot ? 'none' : '';
  document.getElementById('shoot-brief-unmark-shot-btn').style.display = isShot ? '' : 'none';
}

// Legacy Shoot Brief rendering (items 7/11) -- byte-for-byte the same
// behaviour that shipped before structured What to Shoot existed. Also
// resets every structured-mode-only element to hidden, since the modal's
// DOM is reused across Concepts and a previous open might have been a
// structured-mode one.
function renderShootingBriefLegacy(brief, hooks) {
  document.getElementById('shoot-brief-shots-section').style.display = 'none';
  document.getElementById('shoot-brief-execution-collapsible').style.display = 'none';
  document.getElementById('shoot-brief-requirements-collapsible').style.display = 'none';
  document.getElementById('shoot-brief-overall-progress').style.display = 'none';
  document.getElementById('shoot-brief-openings-progress').textContent = '';

  // OPENINGS -- every Hook Variation gets equal visual weight as its own
  // compact block (item 2), not a single highlighted "Primary" plus a
  // buried list of others: on set, each one is a separate thing to film.
  // "Film All N" only appears once there's actually a choice to make. A
  // Hook that's just its literal opening line (the common case) renders
  // as quoted copy; a Hook the creator wrote with its own multi-line
  // structure (a label plus Shot/Text-VO/Transition-style lines) gets the
  // same heading + labelled-line treatment as a Backend beat, since that
  // structure is already there in the approved text -- never fabricated.
  const openingsSection = document.getElementById('shoot-brief-openings-section');
  if (hooks.length) {
    openingsSection.style.display = '';
    document.getElementById('shoot-brief-openings-badge').innerHTML = hooks.length > 1
      ? `<span class="shoot-brief-film-badge shoot-brief-film-badge-all">Film All ${hooks.length}</span>` : '';
    document.getElementById('shoot-brief-hooks').innerHTML = hooks.map((h, i) => {
      const text = h.text.trim();
      const hookNum = hooks.length > 1 ? `Hook ${i + 1}` : '';
      if (!text.includes('\n')) {
        return `<div class="shoot-brief-hook-block">
          ${hookNum ? `<div class="shoot-brief-hook-label">${escapeHtml(hookNum)}</div>` : ''}
          <div class="shoot-brief-hook-text">&ldquo;${escapeHtml(text)}&rdquo;</div>
        </div>`;
      }
      const { heading, body } = shootingBeatHeading(text);
      const label = [hookNum, heading].filter(Boolean).join(' — ');
      return `<div class="shoot-brief-hook-block">
        ${label ? `<div class="shoot-brief-hook-label">${escapeHtml(label)}</div>` : ''}
        ${shootingRenderBeatBody(body)}
      </div>`;
    }).join('');
  } else {
    openingsSection.style.display = 'none';
  }

  // BACKEND -- the shared Execution/Shot Plan, captured once regardless of
  // how many Openings lead into it (item 3/4). Broken into whatever beats
  // the creator's own writing already contains (shootingExecutionBeats),
  // never re-flowed into an artificial numbered list. Each beat's own
  // heading (if any) and labelled lines (Shot/Direction/Production
  // Note/etc.) come from shootingBeatHeading/shootingRenderBeatBody --
  // the same structure-detection Hooks above use, applied here to the
  // shared footage instead.
  const beats = shootingExecutionBeats(brief.execution);
  const backendSection = document.getElementById('shoot-brief-backend-section');
  if (beats.length) {
    backendSection.style.display = '';
    document.getElementById('shoot-brief-backend').innerHTML = beats.map((beat) => {
      const { heading, body } = shootingBeatHeading(beat);
      return `<div class="shoot-brief-beat">
        ${heading ? `<div class="shoot-brief-beat-heading">${escapeHtml(heading)}</div>` : ''}
        ${shootingRenderBeatBody(body)}
      </div>`;
    }).join('');
  } else {
    backendSection.style.display = 'none';
  }

  const scriptSection = document.getElementById('shoot-brief-script-section');
  if (brief.script_notes && brief.script_notes.trim()) {
    scriptSection.style.display = '';
    document.getElementById('shoot-brief-script').textContent = brief.script_notes;
  } else {
    scriptSection.style.display = 'none';
  }

  // Requirements -- one compact section, entirely hidden (not shown with
  // "—" placeholders) unless at least one of Talent/Location/Props was
  // actually recorded (item 9).
  const reqSection = document.getElementById('shoot-brief-requirements-section');
  const reqCells = [];
  if (brief.talent_requirement && brief.talent_requirement.trim()) reqCells.push(`<div><span class="cd-field-label">Talent</span><div class="shoot-brief-text">${escapeHtml(brief.talent_requirement)}</div></div>`);
  if (brief.location && brief.location.trim()) reqCells.push(`<div><span class="cd-field-label">Location</span><div class="shoot-brief-text">${escapeHtml(brief.location)}</div></div>`);
  const hasProps = brief.props_notes && brief.props_notes.trim();
  if (reqCells.length || hasProps) {
    reqSection.style.display = '';
    document.getElementById('shoot-brief-req-row').innerHTML = reqCells.join('');
    document.getElementById('shoot-brief-req-row').style.display = reqCells.length ? '' : 'none';
    const propsWrap = document.getElementById('shoot-brief-props-wrap');
    if (hasProps) {
      propsWrap.style.display = '';
      document.getElementById('shoot-brief-props').textContent = brief.props_notes;
    } else {
      propsWrap.style.display = 'none';
    }
  } else {
    reqSection.style.display = 'none';
  }

  renderShootingBriefSharedContext(brief);

  // CHECK -- compact completion tracker for the major footage groups only
  // (item 5), persisted per shoot-schedule entry so it survives an
  // accidental close mid-shoot.
  state.shooting.briefChecklistItems = shootingChecklistItems(hooks, beats);
  state.shooting.briefChecklistChecked = shootingChecklistLoad(state.shooting.briefScheduleId);
  renderShootingChecklist();
}

// References + Customer Avatar/Audience context render identically
// regardless of which mode is active -- neither depends on Execution or
// structured Shots, so there's nothing to branch on.
function renderShootingBriefSharedContext(brief) {
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
}

// A single checkable footage block shared by structured OPENINGS and
// SHOTS rows (item 9: the brief itself is the checklist, not a separate
// section underneath). `label` is the heading line (Hook N / Opening /
// the Shot Name), `body` is pre-rendered inner HTML for the capture text.
function shootingCaptureBlockHtml(key, label, bodyHtml, checked) {
  return `<label class="shoot-brief-capture-item ${checked ? 'is-checked' : ''}">
    <input type="checkbox" class="shoot-brief-capture-checkbox" ${checked ? 'checked' : ''} onchange="toggleShootingStructuredCapture('${key}')">
    <div class="shoot-brief-capture-body">
      ${label ? `<div class="shoot-brief-hook-label">${escapeHtml(label)}</div>` : ''}
      ${bodyHtml}
    </div>
  </label>`;
}

// Structured Shoot Brief rendering (items 8-11): OPENINGS and SHOTS come
// straight from Primary/Alternative Hooks and the Concept's own What to
// Shoot records -- never parsed or guessed from Execution prose. Execution,
// Requirements, Audience and References all step back into secondary,
// collapsed-by-default context, since OPENINGS + SHOTS now carry the actual
// shot-day instructions. Hidden entirely for legacy Concepts (item 11).
function renderShootingBriefStructured(brief, hooks, shots) {
  document.getElementById('shoot-brief-backend-section').style.display = 'none';
  document.getElementById('shoot-brief-requirements-section').style.display = 'none';
  document.getElementById('shoot-brief-checklist-section').style.display = 'none';

  const openingItems = hooks.map((h, i) => ({ key: `opening-${i + 1}`, label: hooks.length > 1 ? `Hook ${i + 1}` : 'Opening' }));
  const shotItems = shots.map((s, i) => ({ key: `shot-${i + 1}`, label: s.name.trim() }));
  state.shooting.briefChecklistItems = [...openingItems, ...shotItems];
  state.shooting.briefChecklistChecked = shootingChecklistLoad(state.shooting.briefScheduleId);
  const checked = state.shooting.briefChecklistChecked;

  // OPENINGS -- same equal-weight-per-Hook treatment as the legacy
  // rendering (quoted copy for a plain one-line Hook, heading + labelled
  // lines for one the creator wrote with its own structure), just made
  // individually checkable and with the fixed "Film All" badge (item 8)
  // instead of a conditional count.
  const openingsSection = document.getElementById('shoot-brief-openings-section');
  if (hooks.length) {
    openingsSection.style.display = '';
    document.getElementById('shoot-brief-openings-badge').innerHTML = '<span class="shoot-brief-film-badge shoot-brief-film-badge-all">Film All</span>';
    document.getElementById('shoot-brief-hooks').innerHTML = hooks.map((h, i) => {
      const text = h.text.trim();
      const item = openingItems[i];
      let bodyHtml;
      if (!text.includes('\n')) {
        bodyHtml = `<div class="shoot-brief-hook-text">&ldquo;${escapeHtml(text)}&rdquo;</div>`;
        return shootingCaptureBlockHtml(item.key, item.label, bodyHtml, checked[item.key]);
      }
      const { heading, body } = shootingBeatHeading(text);
      const label = [item.label, heading].filter(Boolean).join(' — ');
      bodyHtml = shootingRenderBeatBody(body);
      return shootingCaptureBlockHtml(item.key, label, bodyHtml, checked[item.key]);
    }).join('');
  } else {
    openingsSection.style.display = 'none';
  }

  // SHOTS -- populated directly from structured What to Shoot records
  // (Shot Name + What to Capture only, item 2/3), each its own checkable
  // block with the fixed "Capture All" badge.
  const shotsSection = document.getElementById('shoot-brief-shots-section');
  shotsSection.style.display = '';
  document.getElementById('shoot-brief-shots').innerHTML = shots.map((s, i) => {
    const item = shotItems[i];
    const capture = s.capture && s.capture.trim();
    const bodyHtml = capture ? `<div class="shoot-brief-text">${escapeHtml(capture)}</div>` : '';
    return shootingCaptureBlockHtml(item.key, item.label, bodyHtml, checked[item.key]);
  }).join('');

  const scriptSection = document.getElementById('shoot-brief-script-section');
  if (brief.script_notes && brief.script_notes.trim()) {
    scriptSection.style.display = '';
    document.getElementById('shoot-brief-script').textContent = brief.script_notes;
  } else {
    scriptSection.style.display = 'none';
  }

  // Creative Direction / Execution -- supporting context only now (item
  // 10), shown exactly as written, collapsed by default, entirely hidden
  // when there's no Execution text at all.
  const executionCollapsible = document.getElementById('shoot-brief-execution-collapsible');
  if (brief.execution && brief.execution.trim()) {
    executionCollapsible.style.display = '';
    document.getElementById('shoot-brief-execution-text').textContent = brief.execution.trim();
  } else {
    executionCollapsible.style.display = 'none';
  }

  // Requirements -- same content as the legacy section, moved into the
  // collapsed secondary area (item 10).
  const reqCollapsible = document.getElementById('shoot-brief-requirements-collapsible');
  const reqCells = [];
  if (brief.talent_requirement && brief.talent_requirement.trim()) reqCells.push(`<div><span class="cd-field-label">Talent</span><div class="shoot-brief-text">${escapeHtml(brief.talent_requirement)}</div></div>`);
  if (brief.location && brief.location.trim()) reqCells.push(`<div><span class="cd-field-label">Location</span><div class="shoot-brief-text">${escapeHtml(brief.location)}</div></div>`);
  const hasProps = brief.props_notes && brief.props_notes.trim();
  if (reqCells.length || hasProps) {
    reqCollapsible.style.display = '';
    document.getElementById('shoot-brief-req-row-structured').innerHTML = reqCells.join('');
    document.getElementById('shoot-brief-req-row-structured').style.display = reqCells.length ? '' : 'none';
    const propsWrap = document.getElementById('shoot-brief-props-wrap-structured');
    if (hasProps) {
      propsWrap.style.display = '';
      document.getElementById('shoot-brief-props-structured').textContent = brief.props_notes;
    } else {
      propsWrap.style.display = 'none';
    }
  } else {
    reqCollapsible.style.display = 'none';
  }

  renderShootingBriefSharedContext(brief);
  renderShootingStructuredProgress();
}

// Progress display for structured mode (item 9): per-section "X/Y
// captured" next to OPENINGS/SHOTS, plus an overall count in the footer
// that reads "captured" until everything is done, then flips to a
// checkmark -- the Shoot Brief itself is the checklist, so this is the
// only completion tracker shown (no separate Shoot Checklist section).
function renderShootingStructuredProgress() {
  const items = state.shooting.briefChecklistItems;
  const checked = state.shooting.briefChecklistChecked;
  const openingItems = items.filter((it) => it.key.startsWith('opening-'));
  const shotItems = items.filter((it) => it.key.startsWith('shot-'));
  const countDone = (list) => list.filter((it) => checked[it.key]).length;

  const openingsProgress = document.getElementById('shoot-brief-openings-progress');
  openingsProgress.textContent = openingItems.length ? `${countDone(openingItems)}/${openingItems.length} captured` : '';
  const shotsProgress = document.getElementById('shoot-brief-shots-progress');
  shotsProgress.textContent = shotItems.length ? `${countDone(shotItems)}/${shotItems.length} captured` : '';

  const overall = document.getElementById('shoot-brief-overall-progress');
  if (items.length) {
    overall.style.display = '';
    const done = countDone(items);
    overall.textContent = done === items.length ? `✓ ${done}/${items.length} captured` : `${done}/${items.length} captured`;
    overall.classList.toggle('is-complete', done === items.length);
  } else {
    overall.style.display = 'none';
  }
}

function toggleShootingStructuredCapture(key) {
  const scheduleId = state.shooting.briefScheduleId;
  if (!scheduleId) return;
  state.shooting.briefChecklistChecked[key] = !state.shooting.briefChecklistChecked[key];
  shootingChecklistSave(scheduleId, state.shooting.briefChecklistChecked);
  renderShootingStructuredProgress();
  const input = document.querySelector(`.shoot-brief-capture-checkbox[onchange="toggleShootingStructuredCapture('${key}')"]`);
  if (input) input.closest('.shoot-brief-capture-item').classList.toggle('is-checked', !!state.shooting.briefChecklistChecked[key]);
}

// Mark as Shot stays the primary, un-blocked action (item 6) -- an
// incomplete checklist only earns a single lightweight confirmation, never
// a hard block.
async function markShootingShotFromBrief() {
  if (!state.shooting.briefScheduleId) return;
  const incomplete = state.shooting.briefChecklistItems.some((it) => !state.shooting.briefChecklistChecked[it.key]);
  if (incomplete) {
    const ok = await confirmDialog("Some shoot sections haven't been checked off. Mark as Shot anyway?", { okLabel: 'Mark as Shot' });
    if (!ok) return;
  }
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

// Week/Today/History switcher, same pattern as Shooting's setShootingView --
// always refetches whatever view is now active. The week-nav only makes
// sense in Week view (Today always shows the real current week regardless
// of week-nav position; History has its own past weeks), and the shared
// person filter (see editingActiveConcepts) doesn't apply to History's
// aggregated per-week numbers, so both are hidden there.
function setEditingView(view) {
  state.editing.view = view;
  document.querySelectorAll('#editing-subnav .shoot-subnav-btn').forEach((b) => b.classList.toggle('active', b.dataset.editingView === view));
  document.querySelectorAll('#editing-view-week, #editing-view-today, #editing-view-history').forEach((p) => p.classList.toggle('active', p.id === `editing-view-${view}`));
  document.getElementById('editing-week-nav').style.display = view === 'week' ? '' : 'none';
  document.getElementById('editing-controls-row').style.display = view === 'history' ? 'none' : '';
  document.getElementById('editing-summary').style.display = view === 'history' ? 'none' : '';
  refreshCurrentEditingView();
}

function refreshCurrentEditingView() {
  if (state.editing.view === 'today') return loadEditingToday();
  if (state.editing.view === 'history') return loadEditingHistory();
  return loadEditingWeek();
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

// Editing happens externally (CapCut) -- WNDRR isn't pretending to be an
// editing app, just tracking the handoff. One Final Edit per Concept now
// (editor/format/link/notes -- see #final-edit-modal, unchanged by this
// simplification), not a checklist of individually-matched Hook Variations.
// A Concept can technically still carry more than one final_edits row (nothing
// deletes older ones), but the simplified workflow only ever creates/reads
// the first -- see editingConceptFinalEdit.
function editingConceptFinalEdit(concept) {
  const edits = concept.final_edits || [];
  return edits.length ? edits[0] : null;
}

// Four plain states, no completion fraction: To Edit (nothing started,
// Unscheduled), Scheduled (round 9 -- placed onto a calendar day, but
// editing hasn't actually started yet), In Progress (editing_started_at is
// set -- editor working in CapCut, link may not be pasted back yet), Edited
// (the Concept has actually been submitted -- see submitEditingConceptReady,
// which requires the link first). Round 8 keyed the started/not-started
// split off the explicit editing_started_at signal rather than "a
// final_edits row happens to exist"; round 9 adds Scheduled the same
// deliberate way -- derived from editing_day (already the exact "has this
// been placed on a calendar day" signal PATCH /editing/schedule/:id sets/
// clears, see routes/editing.js), not a new column, since that field is
// already reliable and genuinely independent of editing_started_at. Once
// editing_started_at is set it always wins over editing_day, so moving an
// In Progress concept to a different day -- or back to Unscheduled --
// never regresses it to Scheduled or To Edit (see editingStatusControlHtml
// and moveEditingCard, which still never touches either field).
function editingConceptStatus(concept) {
  if (concept.editing_submitted_at) return 'ready_for_approval';
  if (concept.editing_started_at) return 'editing';
  return concept.editing_day ? 'scheduled' : 'to_edit';
}

// The Final Edit workspace's default Editor suggestion -- the planning-time
// Editing assignment (Upcoming Drops/Promotion intake), available from the
// moment a Concept reaches Editing, before any Final Edit even exists yet.
function editingConceptEditorLabel(concept) {
  return concept.editing_owner || null;
}

const EDITING_STATUS_LABELS = { to_edit: 'To Edit', scheduled: 'Scheduled', editing: 'In Progress', ready_for_approval: 'Edited' };
const EDITING_STATUS_CLASS = { to_edit: 'editing-status-to-edit', scheduled: 'editing-status-scheduled', editing: 'editing-status-editing', ready_for_approval: 'editing-status-ready' };

// The same segmented production-status control Shooting cards already use
// (shootingStatusControlHtml, reusing its exact .shoot-status-control/
// .shoot-status-segment CSS). Round 9: Scheduled is a passive,
// calendar-derived stage for FORWARD entry -- it's only ever reached by
// dragging a card onto a day, never by clicking this control. Round 11
// makes the two non-final stages ("Scheduled", "To Edit") clickable
// BACKWARD targets from In Progress, matching Shooting's own reversibility
// (accidental clicks must be correctable) without changing that forward
// rule: Scheduled never gains a *forward* click. From In Progress, exactly
// one of the two earlier segments is ever the live backward target --
// "Scheduled" when the Concept still has an editing_day (revert clears only
// editing_started_at, the day/assignment/schedule row are all untouched),
// "To Edit" when it doesn't (same clear, worded for the Unscheduled case).
// From Scheduled, "To Edit" is also a live backward target -- clicking it
// unschedules the Concept via the existing PATCH .../schedule/:id route
// (least-surprising choice over a "you must drag it off first" error, see
// revertEditingToToEdit). "Edited" is deliberately never a backward target
// here at all: once a Final Edit exists, "Remove Final Edit" inside the
// workspace is the closest undo (which also clears editing_started_at if it
// was the Concept's last one); once actually submitted, Final Approval owns
// the Concept and its own Request Changes -- a decision with feedback
// attached, not a silent card click -- is the only way back (see
// renderEditingConceptModal's submitted-lock). Both new backward actions
// are themselves guarded server-side against a submitted Concept, so this
// never needs to special-case "ready_for_approval" here.
function editingStatusControlHtml(concept) {
  const stages = ['to_edit', 'scheduled', 'editing', 'ready_for_approval'];
  const status = editingConceptStatus(concept);
  const hasDay = !!concept.editing_day;
  return `<div class="shoot-status-control" onclick="event.stopPropagation()">${stages.map((stage) => {
    const isCurrent = stage === status;
    let onclick = null;
    let title = '';
    if (stage === 'editing' && (status === 'to_edit' || status === 'scheduled')) {
      onclick = `advanceEditingToInProgress(${concept.creative_asset_id})`;
      title = 'Mark as In Progress';
    } else if (stage === 'ready_for_approval' && status === 'editing') {
      onclick = `advanceEditingToEdited(${concept.creative_asset_id})`;
      title = 'Mark as Edited';
    } else if (stage === 'scheduled' && status === 'editing' && hasDay) {
      onclick = `revertEditingToScheduled(${concept.creative_asset_id})`;
      title = 'Undo -- revert to Scheduled';
    } else if (stage === 'to_edit' && status === 'editing' && !hasDay) {
      onclick = `revertEditingToToEdit(${concept.creative_asset_id})`;
      title = 'Undo -- revert to To Edit';
    } else if (stage === 'to_edit' && status === 'scheduled') {
      onclick = `revertEditingToToEdit(${concept.creative_asset_id})`;
      title = 'Undo -- unschedule back to To Edit';
    }
    return `<button type="button" class="shoot-status-segment${isCurrent ? ' shoot-status-segment-active' : ''}" ${onclick ? `onclick="${onclick}"` : 'disabled'} title="${title}">${EDITING_STATUS_LABELS[stage]}</button>`;
  }).join('')}</div>`;
}

// Round 11 backward action 1: In Progress + still has an editing_day ->
// Scheduled. Clears ONLY editing_started_at (see POST .../unstart) --
// editing_day, editing_owner, and any existing final_edits row are all left
// exactly as they are, so this is a pure status revert, never a data change.
async function revertEditingToScheduled(conceptAssetId) {
  try {
    await api(`/editing/concepts/${conceptAssetId}/unstart`, { method: 'POST' });
    await refreshCurrentEditingView();
    toast('Reverted to Scheduled');
  } catch (e) {
    toast(e.message, true);
  }
}

// Round 11 backward action 2: covers both "In Progress with no editing_day"
// (clear editing_started_at, same as revertEditingToScheduled above -- the
// Concept just lands on To Edit instead of Scheduled because there's no day
// to revert to) and "Scheduled -> To Edit" (unschedule it). Looks the
// Concept up fresh to decide which of the two applies, same
// editingFindConcept pattern every other card action here already uses.
async function revertEditingToToEdit(conceptAssetId) {
  const concept = editingFindConcept(conceptAssetId);
  if (!concept) return;
  try {
    if (editingConceptStatus(concept) === 'editing') {
      await api(`/editing/concepts/${conceptAssetId}/unstart`, { method: 'POST' });
    } else {
      await api(`/editing/schedule/${concept.shoot_schedule_id}`, { method: 'PATCH', body: JSON.stringify({ editing_day: null }) });
    }
    await refreshCurrentEditingView();
    toast('Reverted to To Edit');
  } catch (e) {
    toast(e.message, true);
  }
}

// Card-level "In Progress" segment -- a pure status transition (fixes the
// live-QA bug where this used to also create a Final Edit and open its
// modal, see POST /editing/concepts/:id/start). It's simply "I have started
// editing this": sets editing_started_at and nothing else -- no final_edits
// row, no modal, no submission. The card stays put in Editing with "In
// Progress" selected; the Final Edit modal is now reached only by clicking
// "Edited" below.
async function advanceEditingToInProgress(conceptAssetId) {
  const concept = editingFindConcept(conceptAssetId);
  if (!concept) return;
  try {
    await api(`/editing/concepts/${conceptAssetId}/start`, { method: 'POST' });
    await refreshCurrentEditingView();
    toast('Marked as In Progress');
  } catch (e) {
    toast(e.message, true);
  }
}

// Clicking "Edited" must never silently advance the status -- the whole
// point of this segment is that Final Approval can't be reached without a
// real Final Edit link attached. Since "In Progress" no longer guarantees a
// final_edits row exists (see advanceEditingToInProgress above), this
// creates one first if the Concept doesn't already have one -- the same
// creation call "In Progress" used to make, now made here instead, so
// there's still ever only one final_edits row per Concept -- then opens the
// SAME Final Edit modal, flagged into submit mode so the modal's own footer
// becomes "Submit for Approval ->" (see submitFinalEditAndAdvance).
// Cancel/close/backdrop-click on that modal are all plain closeModal() with
// no side effect, so the concept simply stays In Progress until the form is
// actually submitted.
async function advanceEditingToEdited(conceptAssetId) {
  const concept = editingFindConcept(conceptAssetId);
  if (!concept) return;
  let finalEdit = editingConceptFinalEdit(concept);
  if (!finalEdit) {
    try {
      const created = await api(`/editing/concepts/${conceptAssetId}/final-edits`, {
        method: 'POST',
        body: JSON.stringify({ assets: finalEditAssetsFromConceptHooks(concept) }),
      });
      await refreshCurrentEditingView();
      finalEdit = created[0];
    } catch (e) {
      toast(e.message, true);
      return;
    }
  }
  openFinalEditModal(finalEdit.id, { submitMode: true });
}

// Editor filter -- the one remaining filter dimension (see the Round 12
// brief, item 1: the old workflow-state filter tabs are gone), and the
// first real reader of editing_owner (see G's investigation): an
// assignment made once in Upcoming Drops/Promotion intake now surfaces the
// right person's queue here with nothing re-entered. Sourced from
// CONCEPT_ASSIGNEES (same compact roster Shooting's Filming filter now
// uses too) -- editing_owner is written only through the "Editing" select
// in Upcoming Drops/Promotion intake (index.html) and
// updateConceptEditingOwner above, both of which already only ever offer
// Mark/Shez/Til. Populating this from state.contentCreators (every app
// user who can run Shoot Plan intake) would silently show editors who can
// never actually be an editing_owner, and would risk the reverse too if
// Mark/Shez/Til aren't all present in content_creators.
function populateEditingEditorFilter() {
  const el = document.getElementById('editing-editor-filter');
  if (!el) return;
  const names = ['all', ...CONCEPT_ASSIGNEES, 'other'];
  el.innerHTML = names.map((name) => {
    const label = name === 'all' ? 'All' : name === 'other' ? 'Other' : escapeHtml(name);
    const active = state.editing.editorFilter === name ? ' person-filter-btn-active' : '';
    return `<button type="button" class="person-filter-btn${active}" data-value="${escapeHtml(name)}" onclick="setEditingEditorFilter('${escapeHtml(name)}')">${label}</button>`;
  }).join('');
}

function setEditingEditorFilter(value) {
  state.editing.editorFilter = value;
  const el = document.getElementById('editing-editor-filter');
  if (el) {
    el.querySelectorAll('.person-filter-btn').forEach((btn) => {
      btn.classList.toggle('person-filter-btn-active', btn.dataset.value === value);
    });
  }
  renderEditingList();
}

// Whichever view is currently active supplies the working concept list --
// Week reads state.editing.data (the week-nav-browsed week), Today reads
// its own separately-fetched state.editing.todayData (always the REAL
// current week, independent of week-nav position, same as Shooting's
// todayData). Routing every downstream computation through this one
// function is what makes the shared summary above the subnav automatically
// reflect whichever of Week/Today is showing.
function editingActiveConcepts() {
  const source = state.editing.view === 'today' ? state.editing.todayData : state.editing.data;
  return (source && source.concepts) || [];
}

// The set of Concepts the editor filter currently allows -- every other
// computation (the summary counts, the visible list) reads through this one
// helper so "All Editors" (the default) is mathematically identical to no
// filter at all, and nothing computes off the active concept list directly
// and forgets it.
function editingVisibleConcepts() {
  const concepts = editingActiveConcepts();
  if (state.editing.editorFilter === 'all') return concepts;
  if (state.editing.editorFilter === 'other') return concepts.filter((c) => isOutsideConceptAssigneeRoster(c.editing_owner));
  return concepts.filter((c) => c.editing_owner === state.editing.editorFilter);
}

// Aggregates across the whole week's Concepts -- backs the summary line,
// computed once per render from the same per-Concept helpers the cards
// themselves use.
function editingComputeSummary() {
  const concepts = editingVisibleConcepts();
  let toEdit = 0, scheduled = 0, editingCount = 0, ready = 0;
  for (const c of concepts) {
    const status = editingConceptStatus(c);
    if (status === 'to_edit') toEdit += 1;
    else if (status === 'scheduled') scheduled += 1;
    else if (status === 'editing') editingCount += 1;
    else ready += 1;
  }
  return { concepts: concepts.length, to_edit: toEdit, scheduled, editing: editingCount, ready_for_approval: ready };
}

// Compact and Concept-first (item 8): concept count, the overall Final Edit
// completion fraction, then Ready for Approval only when there's actually
// one waiting -- individual Final Edit counts belong inside each Concept's
// own card/workspace, not up here.
function renderEditingSummary() {
  const s = editingComputeSummary();
  const parts = [`${s.concepts} Concept${s.concepts === 1 ? '' : 's'}`, `${s.to_edit} To Edit`, `${s.scheduled} Scheduled`, `${s.editing} In Progress`];
  if (s.ready_for_approval > 0) parts.push(`${s.ready_for_approval} Edited`);
  document.getElementById('editing-summary').textContent = parts.join(' · ');
}

// Same compact 3-across card grid as Concept Development (.cd-card /
// .cd-product-grid / .high-stock-thumb), not a bespoke card system -- so
// Editing feels like the same product rather than an admin screen bolted
// on (see the landing-page brief). Each card is one Concept: product image
// + name, the Concept name as the strong title, a plain status pill (no
// completion fraction any more -- see the Editing-simplification brief,
// item 9), the single Editor if one's assigned, and one contextual CTA.
function editingConceptCtaLabel(status) {
  if (status === 'ready_for_approval') return 'View Editing';
  return status === 'to_edit' ? 'Start Editing' : 'Open Editing';
}

function editingConceptCardHtml(concept) {
  const status = editingConceptStatus(concept);
  const isReady = status === 'ready_for_approval';
  const thumb = concept.image_url
    ? `<img class="high-stock-thumb" src="${concept.image_url}" alt="">`
    : '<span class="high-stock-thumb high-stock-noimg">🖼</span>';
  // Same person-accent convention as Shooting (see personAccentKey) --
  // consistent colour identification anywhere an assignment is surfaced.
  const personKey = personAccentKey(concept.editing_owner);
  return `
    <div class="cd-card editing-concept-card ${personKey ? `person-accent-${personKey}` : ''} ${isReady ? 'editing-concept-card-ready' : ''}" onclick="openEditingConcept(${concept.creative_asset_id})">
      <div class="cd-card-top">
        ${thumb}
        <div class="editing-concept-product">${escapeHtml(concept.product_name || '—')}</div>
      </div>
      <div class="editing-concept-name">${escapeHtml(concept.concept_name)}</div>
      ${editingStatusControlHtml(concept)}
      <div class="cd-card-meta">Editing: <strong>${concept.editing_owner ? escapeHtml(concept.editing_owner) : 'Unassigned'}</strong></div>
      <div class="cd-card-action">${editingConceptCtaLabel(status)} &rarr;</div>
    </div>`;
}

// Renders whichever calendar view is currently active -- Week (day-grouped
// calendar) or Today -- on top of the same shared summary line, same
// dispatch pattern as Shooting's refreshCurrentShootingView. History has
// its own separate load/render pair (loadEditingHistory/
// renderEditingHistoryView) since it doesn't share the person filter at all.
function renderEditingList() {
  renderEditingSummary();
  if (state.editing.view === 'today') renderEditingTodayView();
  else renderEditingWeekView();
}

// Searches both concept lists (Week's browsed-week data and Today's own
// current-week data) rather than just whichever is currently active -- a
// concept opened from Today must still be found if the user had earlier
// browsed Week to a different week (and vice versa), since both views share
// the same modal/action code.
function editingFindConcept(creativeAssetId) {
  const weekConcepts = (state.editing.data && state.editing.data.concepts) || [];
  const todayConcepts = (state.editing.todayData && state.editing.todayData.concepts) || [];
  return weekConcepts.find((c) => c.creative_asset_id === creativeAssetId) || todayConcepts.find((c) => c.creative_asset_id === creativeAssetId);
}

function editingFindFinalEdit(finalEditId) {
  const weekConcepts = (state.editing.data && state.editing.data.concepts) || [];
  const todayConcepts = (state.editing.todayData && state.editing.todayData.concepts) || [];
  for (const concept of [...weekConcepts, ...todayConcepts]) {
    const found = concept.final_edits.find((fe) => fe.id === finalEditId);
    if (found) return { finalEdit: found, concept };
  }
  return null;
}

// ── Editing calendar (Week/Today/History) ──────────────
// Reuses Shooting's own SHOOT_DAY_KEYS/LABELS (the weekday domain is the
// same) and its .shoot-day-column/.shoot-card/.shoot-card-menu/
// .shoot-unscheduled CSS wholesale -- this is a second calendar of the same
// shape, not a new visual language (item 8: "using existing Shooting UX
// patterns, not an unrelated interface").
function editingDayHeaderLabel(day) {
  const monday = mondayOfWeek(state.editing.weekOffset);
  const d = new Date(monday);
  d.setDate(monday.getDate() + SHOOT_DAY_KEYS.indexOf(day));
  const month = d.toLocaleDateString('en-AU', { month: 'short' }).toUpperCase().slice(0, 3);
  return `${SHOOT_DAY_SHORT_LABELS[day]} ${d.getDate()} ${month}`;
}

function editingIsCurrentDay(day) {
  return state.editing.weekOffset === 0 && day === shootingTodayInfo().dayKey;
}

// Per-day "X/Y Ready" -- Ready for Approval is Editing's own equivalent of
// Shooting's "Shot" (the concept has nothing left to do on this day), so
// this mirrors shootingDayHeaderHtml exactly, just counting a different
// status.
function editingDayHeaderHtml(day, items, isToday) {
  const label = `<span class="shoot-day-date-group"><span class="shoot-day-date">${editingDayHeaderLabel(day)}</span>${isToday ? '<span class="shoot-day-today-badge">Today</span>' : ''}</span>`;
  if (!items.length) return `<div class="shoot-day-header-top">${label}</div>`;
  const readyCount = items.filter((c) => editingConceptStatus(c) === 'ready_for_approval').length;
  const total = items.length;
  const complete = readyCount === total;
  const pct = Math.round((readyCount / total) * 100);
  return `
    <div class="shoot-day-header-top">
      ${label}
      <span class="shoot-day-progress-count${complete ? ' shoot-day-progress-complete' : ''}">${complete ? '&check; ' : ''}${readyCount}/${total} Ready</span>
    </div>
    <div class="shoot-day-progress-bar"><div class="shoot-day-progress-fill${complete ? ' shoot-day-progress-fill-complete' : ''}" style="width:${pct}%"></div></div>`;
}

// Every card's accessible alternative to drag-and-drop, same convention as
// shootingMoveMenuItemsHtml -- item 12 asks for the same rescheduling
// (Unscheduled<->weekday, weekday<->weekday, this week->future week) with
// an explicit Move action alongside drag/drop, not instead of it. Never
// locked by workflow state (item 9: calendar and workflow progress are
// independent) -- a Ready for Approval concept can still be moved, unlike
// Shooting's Shot cards which lock in place.
function editingMoveMenuItemsHtml(concept) {
  const dayItems = SHOOT_DAY_KEYS
    .filter((day) => day !== concept.editing_day)
    .map((day) => `<button type="button" class="shoot-card-menu-item" onclick="moveEditingCard(${concept.shoot_schedule_id}, '${day}', '${concept.editing_week_start}'); closeAllEditingCardMenus();">${SHOOT_DAY_LABELS[day]}</button>`)
    .join('');
  const unscheduledItem = concept.editing_day
    ? `<button type="button" class="shoot-card-menu-item" onclick="moveEditingCard(${concept.shoot_schedule_id}, 'unscheduled', '${concept.editing_week_start}'); closeAllEditingCardMenus();">Unscheduled</button>`
    : '';
  const prevWeekItem = `<button type="button" class="shoot-card-menu-item" onclick="moveEditingCard(${concept.shoot_schedule_id}, 'carry_prev_week', '${concept.editing_week_start}'); closeAllEditingCardMenus();">&larr; Move to previous week</button>`;
  const carryItem = `<button type="button" class="shoot-card-menu-item shoot-card-menu-item-carry" onclick="moveEditingCard(${concept.shoot_schedule_id}, 'carry_next_week', '${concept.editing_week_start}'); closeAllEditingCardMenus();">Carry to next week &rarr;</button>`;
  const pickWeekItem = `<button type="button" class="shoot-card-menu-item" onclick="showEditingWeekPicker(${concept.shoot_schedule_id}, '${concept.editing_week_start}')">Move to week&hellip;</button>`;
  return `<div class="shoot-card-menu-label">Move to</div>${dayItems}${unscheduledItem}${prevWeekItem}${carryItem}${pickWeekItem}`;
}

function showEditingWeekPicker(scheduleId, currentWeekStart) {
  const menu = document.getElementById(`editing-card-menu-${scheduleId}`);
  if (!menu) return;
  const rows = moveWeekOptions()
    .map((o) => `<button type="button" class="shoot-card-menu-item" onclick="moveEditingCard(${scheduleId}, 'week:${o.value}', '${currentWeekStart}'); closeAllEditingCardMenus();">${escapeHtml(o.label)}</button>`)
    .join('');
  menu.innerHTML = `<div class="shoot-card-menu-label">Move to week</div>${rows}`;
}

function toggleEditingCardMenu(scheduleId) {
  const dropdown = document.getElementById(`editing-card-menu-${scheduleId}`);
  if (!dropdown) return;
  const isOpen = dropdown.classList.contains('open');
  closeAllEditingCardMenus();
  if (!isOpen) dropdown.classList.add('open');
}

function closeAllEditingCardMenus() {
  document.querySelectorAll('#editing-week-grid .shoot-card-menu-dropdown.open, #editing-unscheduled .shoot-card-menu-dropdown.open').forEach((el) => el.classList.remove('open'));
}

document.addEventListener('click', (e) => {
  if (e.target.closest('.shoot-card-menu')) return;
  closeAllEditingCardMenus();
});

// One reschedule action for every way an Editing card moves (menu item or
// drag/drop) -- mirrors moveShootingCard exactly, just against the Editing
// calendar's own PATCH /editing/schedule/:id (see routes/editing.js), which
// never touches editing_owner or any workflow-state field.
async function moveEditingCard(scheduleId, value, currentWeekStart) {
  try {
    const isWeekPick = typeof value === 'string' && value.startsWith('week:');
    const body = value === 'unscheduled' ? { editing_day: null }
      : value === 'carry_next_week' ? { editing_day: null, editing_week_start: nextWeekStartFrom(currentWeekStart) }
      : value === 'carry_prev_week' ? { editing_day: null, editing_week_start: prevWeekStartFrom(currentWeekStart) }
      : isWeekPick ? { editing_day: null, editing_week_start: value.slice(5) }
      : { editing_day: value };
    await api(`/editing/schedule/${scheduleId}`, { method: 'PATCH', body: JSON.stringify(body) });
    toast(value === 'carry_next_week' ? 'Carried to next week'
      : value === 'carry_prev_week' ? 'Moved to previous week'
      : isWeekPick ? 'Moved to selected week'
      : 'Moved');
    await refreshCurrentEditingView();
  } catch (e) {
    toast(e.message, true);
  }
}

function onEditingCardDragStart(e, scheduleId) {
  state.editing.dragScheduleId = scheduleId;
  e.dataTransfer.setData('text/plain', String(scheduleId));
  e.dataTransfer.effectAllowed = 'move';
}

function onEditingColumnDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
}

function onEditingColumnDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

function onEditingColumnDrop(e, day) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const scheduleId = state.editing.dragScheduleId || Number(e.dataTransfer.getData('text/plain'));
  state.editing.dragScheduleId = null;
  if (!scheduleId) return;
  moveEditingCard(scheduleId, day || 'unscheduled', null);
}

// Compact calendar card for Week's Unscheduled strip/day columns -- reuses
// Shooting's .shoot-card shape (item 11: "Editing: Mark" gets its own
// labelled line, same as Shooting's "Filming: Mark", never lumped into a
// meta line) rather than the roomier .cd-card grid (that stays for Today,
// where columns aren't narrow).
function editingDayCardHtml(concept, isUnscheduled = false) {
  const status = editingConceptStatus(concept);
  const isReady = status === 'ready_for_approval';
  const carriedBadge = concept.carried_over
    ? `<span class="shoot-carried-badge">From W${isoWeekNumber(parseDateStr(concept.editing_original_week_start))}</span>` : '';
  const dragHandle = isUnscheduled ? '<span class="shoot-card-drag-handle" title="Drag onto a day to schedule">⠿</span>' : '';
  const editingHtml = `<div class="shoot-card-filming">Editing: <strong>${concept.editing_owner ? escapeHtml(concept.editing_owner) : 'Unassigned'}</strong></div>`;
  // Same person-accent convention as Shooting/Editing's grid card -- see
  // personAccentKey.
  const personKey = personAccentKey(concept.editing_owner);
  return `
    <div class="shoot-card ${personKey ? `person-accent-${personKey}` : ''} ${isReady ? 'shoot-card-shot' : ''}" draggable="true" ondragstart="onEditingCardDragStart(event, ${concept.shoot_schedule_id})" onclick="openEditingConcept(${concept.creative_asset_id})">
      <div class="shoot-card-name">${dragHandle}${escapeHtml(concept.concept_name)}</div>
      <div class="shoot-card-product">${escapeHtml(concept.product_name || '—')}</div>
      ${editingHtml}
      <div class="shoot-card-footer">
        ${editingStatusControlHtml(concept)}
        ${carriedBadge}
      </div>
      <div class="shoot-card-actions">
        <button type="button" class="link-btn" onclick="event.stopPropagation(); openEditingConcept(${concept.creative_asset_id})">${editingConceptCtaLabel(status)} &rarr;</button>
        <div class="shoot-card-menu" onclick="event.stopPropagation()">
          <button type="button" class="shoot-card-menu-btn" onclick="toggleEditingCardMenu(${concept.shoot_schedule_id})" aria-label="Move concept">&bull;&bull;&bull;</button>
          <div class="shoot-card-menu-dropdown" id="editing-card-menu-${concept.shoot_schedule_id}">${editingMoveMenuItemsHtml(concept)}</div>
        </div>
      </div>
    </div>`;
}

// Unscheduled + Mon-Fri, built from editingVisibleConcepts (editor filter --
// the only filter left; see the Round 12 brief, item 1: the old
// workflow-state filter tabs made a card vanish the moment its own
// segmented-control click changed its status, which read as a bug rather
// than a filter. The calendar now always shows every visible Concept for
// the week regardless of status -- the segmented control on each card is
// the one source of truth for where it's at).
function renderEditingWeekView() {
  const filtered = editingVisibleConcepts();

  const unscheduled = filtered.filter((c) => !c.editing_day);
  const dayItems = {};
  SHOOT_DAY_KEYS.forEach((day) => {
    dayItems[day] = filtered.filter((c) => c.editing_day === day);
  });

  const unscheduledEl = document.getElementById('editing-unscheduled');
  unscheduledEl.classList.toggle('shoot-unscheduled-compact', unscheduled.length === 0);
  unscheduledEl.classList.toggle('shoot-unscheduled-active', unscheduled.length > 0);
  unscheduledEl.innerHTML = unscheduled.length ? `
    <div class="shoot-unscheduled-header">Unscheduled <span class="shoot-unscheduled-count">${unscheduled.length}</span><span class="shoot-unscheduled-hint">Needs scheduling</span><span class="shoot-unscheduled-drag-hint">Drag concepts onto a day to schedule</span></div>
    <div class="shoot-unscheduled-list">${unscheduled.map((c) => editingDayCardHtml(c, true)).join('')}</div>`
    : `<div class="shoot-unscheduled-header">Unscheduled <span class="shoot-unscheduled-count">0</span></div>`;

  document.getElementById('editing-week-grid').innerHTML = SHOOT_DAY_KEYS.map((day) => {
    const items = dayItems[day];
    const isToday = editingIsCurrentDay(day);
    return `
      <div class="shoot-day-column${isToday ? ' shoot-day-column-today' : ''}" ondragover="onEditingColumnDragOver(event)" ondragleave="onEditingColumnDragLeave(event)" ondrop="onEditingColumnDrop(event, '${day}')">
        <div class="shoot-day-header">${editingDayHeaderHtml(day, items, isToday)}</div>
        <div class="shoot-day-cards">
          ${items.length ? items.map((c) => editingDayCardHtml(c)).join('') : '<div class="shoot-day-empty">—</div>'}
        </div>
      </div>`;
  }).join('');
}

// Today always shows the REAL current weekday's Editing queue, independent
// of whatever week Week view happens to be browsing -- same reasoning as
// shootingTodayInfo/loadShootingToday. Reuses the roomier editingConceptCardHtml
// (.cd-card grid) rather than the compact day-card, since Today isn't
// squeezed into a 5-column grid.
async function loadEditingToday() {
  try {
    state.editing.todayData = await api(`/editing?week_start=${isoDateStr(mondayOfWeek(0))}`);
    renderEditingList();
  } catch (e) {
    toast(e.message, true);
  }
}

function renderEditingTodayView() {
  const { date, dayKey } = shootingTodayInfo();
  const dayLabel = date.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
  document.getElementById('editing-today-title').textContent = `Today — ${dayLabel.toUpperCase()}`;

  const list = document.getElementById('editing-today-list');
  if (!dayKey) {
    list.innerHTML = '<div class="attention-empty">No editing is scheduled on weekends.</div>';
    return;
  }
  const filtered = editingVisibleConcepts().filter((c) => c.editing_day === dayKey);
  list.innerHTML = filtered.length ? filtered.map(editingConceptCardHtml).join('') : '<div class="attention-empty">Nothing scheduled for editing today.</div>';
}

async function loadEditingHistory() {
  try {
    state.editing.historyData = await api('/editing/history');
    renderEditingHistoryView();
  } catch (e) {
    toast(e.message, true);
  }
}

// Same Not Completed/Carried Over bucketing convention as
// shootingHistoryStatusLabel, just against Editing's own "submitted" marker.
function editingHistoryStatusLabel(w) {
  const parts = [];
  if (w.not_completed > 0 || w.carried_over === 0) parts.push(`${w.not_completed} Not Completed`);
  if (w.carried_over > 0) parts.push(`${w.carried_over} Carried Over`);
  return parts.join(' · ');
}

function renderEditingHistoryView() {
  const weeks = (state.editing.historyData && state.editing.historyData.weeks) || [];
  const list = document.getElementById('editing-history-list');
  if (!weeks.length) {
    list.innerHTML = '<div class="attention-empty">No Editing history yet.</div>';
    return;
  }
  list.innerHTML = weeks.map((w) => {
    const monday = parseDateStr(w.week_start);
    const completionRate = w.planned > 0 ? Math.round((w.submitted / w.planned) * 100) : 0;
    return `
      <div class="shoot-history-row">
        <div class="shoot-history-row-main">
          <div class="shoot-history-week-name">Week ${isoWeekNumber(monday)}</div>
          <div class="shoot-history-range">${formatWeekRange(monday)}</div>
          <div class="shoot-history-stats">${w.planned} Planned · ${w.submitted} Submitted · ${editingHistoryStatusLabel(w)}</div>
        </div>
        <div class="shoot-history-row-side">
          <div class="shoot-history-rate">${completionRate}% completed</div>
          <button type="button" class="link-btn" onclick="jumpToEditingWeekFromHistory('${w.week_start}')">View Week &rarr;</button>
        </div>
      </div>`;
  }).join('');
}

function jumpToEditingWeekFromHistory(weekStartStr) {
  const targetMonday = parseDateStr(weekStartStr);
  const diffWeeks = Math.round((targetMonday - mondayOfWeek(0)) / (7 * 86400000));
  state.editing.weekOffset = diffWeeks;
  setEditingView('week');
}

// The Concept workspace: "Open Concept -> Start Editing -> paste the Final
// Edit link back -> Mark as Edited" -- a plain handoff, not a checklist.
function openEditingConcept(creativeAssetId) {
  const concept = editingFindConcept(creativeAssetId);
  if (!concept) return;
  state.editing.activeConceptAssetId = creativeAssetId;
  document.getElementById('editing-concept-move-back-btn').style.display = state.currentUser && state.currentUser.role === 'admin' ? '' : 'none';
  renderEditingConceptModal();
  openModal('editing-concept-modal');
}

function openEditingConceptBrief() {
  const concept = editingFindConcept(state.editing.activeConceptAssetId);
  if (!concept) return;
  closeModal('editing-concept-modal');
  openShootingBrief(concept.shoot_schedule_id);
}

// One obvious primary action per row (item 4): a complete row's only
// permanent action is View Final Edit -> ; Replace/Delete move into a
// "•••" overflow menu (same pattern as Reference Library's card menu)
// instead of sitting permanently beside it. An incomplete row keeps its
// single Add Final Edit -> action, unchanged.
// Editing is a handoff, not a checklist any more (see the Editing-
// simplification brief, item 9): one Final Edit per Concept, reusing the
// exact same #final-edit-modal workspace (editor/format/link/notes)
// untouched -- this function just decides whether to show "nothing started
// yet", the existing Final Edit's summary, or (once submitted) a locked
// read-only view.
function renderEditingConceptModal() {
  const concept = editingFindConcept(state.editing.activeConceptAssetId);
  if (!concept) return;
  const submitted = !!concept.editing_submitted_at;
  const finalEdit = editingConceptFinalEdit(concept);
  const status = editingConceptStatus(concept);
  const isReady = status === 'ready_for_approval';

  fillConceptDevSelectWithOther('editing-concept-editor-select', 'editing-concept-editor-custom', CONCEPT_ASSIGNEES, concept.editing_owner, 'Unassigned');
  document.getElementById('editing-concept-editor-select').disabled = submitted;
  document.getElementById('editing-concept-editor-custom').disabled = submitted;

  document.getElementById('editing-concept-modal-title').textContent = concept.concept_name;
  document.getElementById('editing-concept-modal-subtitle').textContent = concept.product_name || '';
  const statusPill = document.getElementById('editing-concept-modal-status-pill');
  statusPill.className = `cd-concept-status-pill ${EDITING_STATUS_CLASS[status]}`;
  statusPill.innerHTML = `${isReady ? '&check; ' : ''}${EDITING_STATUS_LABELS[status]}`;

  const hasLink = !!(finalEdit && finalEdit.final_edit_link);
  const summary = document.getElementById('editing-final-edit-summary');
  // Request Changes from Final Approval clears editing_submitted_at (see
  // finalApproval.js) so the Concept just reappears in the normal Editing
  // queue with its SAME final_edits row -- this banner is the only thing
  // that surfaces WHY it's back, until the next submit resets the status.
  const changesBanner = concept.final_approval_status === 'changes_required'
    ? `<div class="editing-changes-required-banner">
        <div class="editing-changes-required-title">Changes requested at Final Approval</div>
        <div class="editing-changes-required-feedback">${escapeHtml(concept.final_approval_feedback || '')}</div>
      </div>`
    : '';
  if (!finalEdit) {
    summary.innerHTML = `
      ${changesBanner}
      <div class="editing-final-edit-empty">Editing hasn't started yet.</div>
      <button type="button" class="btn btn-primary" onclick="startEditingFinalEdit()">Start Editing &rarr;</button>`;
  } else {
    // One row per Final Edit -- a concept with N confirmed Tuesday Review
    // hooks gets N Final Edits here (see startEditingFinalEdit), each still
    // independently editable/linkable/removable. A concept with just one
    // (no recorded hooks, or a single confirmed hook) renders exactly the
    // same single row this always showed.
    const allFinalEdits = concept.final_edits || [];
    const rowsHtml = allFinalEdits.map((fe) => {
      const feHasLink = !!fe.final_edit_link;
      return `
      <div class="editing-final-edit-row">
        ${fe.variation_text ? `<div class="editing-final-edit-hook-preview">&ldquo;${escapeHtml(fe.variation_text)}&rdquo;</div>` : ''}
        ${fe.editor ? `<div class="editing-final-edit-field"><span class="editing-final-edit-field-label">Editor</span>${escapeHtml(fe.editor)}</div>` : ''}
        ${feHasLink
          ? `<a href="${escapeHtml(fe.final_edit_link)}" target="_blank" rel="noopener" class="link-btn">View Final Edit &rarr;</a>`
          : '<div class="editing-final-edit-empty">No link pasted back yet.</div>'}
        ${fe.editor_notes ? `<div class="editing-final-edit-notes">${escapeHtml(fe.editor_notes)}</div>` : ''}
        ${submitted ? '' : `<button type="button" class="link-btn" onclick="openFinalEditModal(${fe.id})">${feHasLink ? 'Edit Details' : 'Add Final Edit Link'} &rarr;</button>`}
        ${submitted ? '' : `<button type="button" class="link-btn editing-final-edit-remove" onclick="deleteFinalEditFlow(${fe.id})">Remove</button>`}
      </div>`;
    }).join('');
    summary.innerHTML = `${changesBanner}${rowsHtml}`;
  }

  // The footer is where "what's needed before this can move to Final
  // Approval" lives -- just "paste the link back", nothing else to track.
  const footerStatus = document.getElementById('editing-concept-footer-status');
  if (submitted) {
    footerStatus.style.display = 'none';
  } else {
    footerStatus.style.display = '';
    footerStatus.classList.toggle('editing-concept-footer-status-done', hasLink);
    footerStatus.innerHTML = hasLink ? '&check; Ready to mark as Edited' : 'Add the Final Edit link before marking as Edited';
  }

  const readyBtn = document.getElementById('editing-concept-ready-btn');
  readyBtn.style.display = submitted ? 'none' : '';
  readyBtn.disabled = !hasLink;
  document.getElementById('editing-concept-close-btn').style.display = submitted ? '' : 'none';
}

// Round 9: save-on-change for the Editing modal's own Editing-owner select
// -- same canonical PATCH /creative-assets/:id/assignee endpoint (editing_owner
// only, concept_assignee left untouched) every other Editing assignment
// control already writes to, so this is a second entry point onto the same
// field, not a new assignment system. Locked while submitted, same reasoning
// as everything else in this modal once a Concept has gone to Final Approval.
async function saveEditingConceptEditor() {
  const concept = editingFindConcept(state.editing.activeConceptAssetId);
  if (!concept || concept.editing_submitted_at) return;
  const value = conceptDevSelectWithOtherValue('editing-concept-editor-select', 'editing-concept-editor-custom');
  if (value === (concept.editing_owner || '')) return;
  try {
    await api(`/creative-assets/${concept.creative_asset_id}/assignee`, {
      method: 'PATCH',
      body: JSON.stringify({ editing_owner: value || null }),
    });
    await refreshCurrentEditingView();
    renderEditingConceptModal();
  } catch (e) {
    toast(e.message, true);
  }
}

function editingDefaultFormat() {
  const concept = editingFindConcept(state.editing.activeConceptAssetId);
  return (concept && FINAL_EDIT_FORMATS.includes(concept.concept_format)) ? concept.concept_format : 'video';
}

// Creates the Concept's one Final Edit and immediately opens its workspace
// to fill in the link/editor/notes -- one continuous motion, same as
// before this simplification, just never asking which Hook it's for.
// One Final Edit per CONFIRMED Tuesday Review hook (see the Ad Setup
// naming brief, item 2: "1 concept + 1 shoot + N confirmed hooks = N
// downstream hook variations"). concept.hook_variations is exactly what
// Tuesday Review approved along with the rest of the concept (see
// conceptDevelopment.js's PATCH .../review -- approval never touches
// hook_variations, it's approved as-is), so every entry on it at the
// moment editing starts is a confirmed hook. Each Final Edit keeps its
// own variation_text (the full confirmed hook, read-only source of truth
// -- see openFinalEditModal's opening-text display) so Ad Setup can later
// derive its own Short Meta Hook per variation without inventing one. A
// concept with no recorded hooks (legacy data, or a Static concept that
// never used hook_variations) still gets exactly one blank Final Edit,
// same as before this change.
function finalEditAssetsFromConceptHooks(concept) {
  const hooks = (Array.isArray(concept.hook_variations) ? concept.hook_variations : [])
    .filter((h) => h && h.text && h.text.trim());
  const format = editingDefaultFormat();
  if (!hooks.length) return [{ asset_name: 'Final Edit', format }];
  return hooks.map((h, i) => ({
    asset_name: `Hook ${i + 1} — ${h.text.trim().slice(0, 40)}`,
    format,
    variation_text: h.text.trim(),
  }));
}

async function startEditingFinalEdit() {
  const conceptAssetId = state.editing.activeConceptAssetId;
  if (conceptAssetId == null) return;
  const concept = editingFindConcept(conceptAssetId);
  if (!concept) return;
  try {
    const created = await api(`/editing/concepts/${conceptAssetId}/final-edits`, {
      method: 'POST',
      body: JSON.stringify({ assets: finalEditAssetsFromConceptHooks(concept) }),
    });
    await refreshCurrentEditingView();
    openFinalEditModal(created[0].id);
  } catch (e) {
    toast(e.message, true);
  }
}

function populateFinalEditEditorSelect() {
  const sel = document.getElementById('final-edit-editor');
  sel.innerHTML = '<option value="">— unassigned —</option>' +
    state.contentCreators.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
}

function openFinalEditModal(finalEditId, options) {
  const found = editingFindFinalEdit(finalEditId);
  if (!found) return;
  const { finalEdit, concept } = found;
  state.editing.activeFinalEditId = finalEditId;
  // Set on every open (not just cleared on close) so whichever path got us
  // here -- the workspace's "Edit Details", "In Progress" segment, or the
  // "Edited" segment's submit-mode open -- always leaves the footer in the
  // right state, with no stale flag surviving from a previous open.
  state.editing.finalEditSubmitMode = !!(options && options.submitMode);
  // Always opened from inside the Concept workspace now -- close it so the
  // two full-screen overlays never stack.
  closeModal('editing-concept-modal');

  document.getElementById('final-edit-modal-title').textContent = finalEdit.asset_name;
  document.getElementById('final-edit-modal-subtitle').textContent = `${concept.product_name || '—'} · ${concept.concept_name}`;

  // The actual hook text it's cutting, read-only -- already known, never
  // re-asked (item 1), shown as plain quoted text rather than an
  // input-styled box.
  const openingWrap = document.getElementById('final-edit-opening-wrap');
  if (finalEdit.variation_text) {
    openingWrap.style.display = '';
    document.getElementById('final-edit-opening-text').textContent = `“${finalEdit.variation_text}”`;
  } else {
    openingWrap.style.display = 'none';
  }

  // Final Edit is a single always-editable field now -- Replace/View live in
  // the parent checklist row's "..." menu, so there's no separate view/input
  // toggle to manage here (item 2).
  document.getElementById('final-edit-link-input').value = finalEdit.final_edit_link || '';

  // Inherit the Concept's Editor when one is already known (this Final
  // Edit's own, or the single unambiguous editor across the Concept's other
  // Final Edits) rather than re-asking every time -- shown locked with a
  // "Change" toggle to reassign (item 3).
  populateFinalEditEditorSelect();
  const effectiveEditor = finalEdit.editor || editingConceptEditorLabel(concept);
  document.getElementById('final-edit-editor').value = effectiveEditor || '';
  const locked = !!effectiveEditor;
  document.getElementById('final-edit-editor-locked-name').textContent = effectiveEditor || '';
  document.getElementById('final-edit-editor-locked').style.display = locked ? '' : 'none';
  document.getElementById('final-edit-editor').style.display = locked ? 'none' : '';

  document.getElementById('final-edit-notes').value = finalEdit.editor_notes || '';

  updateFinalEditModalFooter();
  openModal('final-edit-modal');
}

// Locked entirely once the Concept has been submitted -- Final Approval
// owns it from here (item 6/11), so there's no per-asset Ready for Approval
// button and no way to edit a submitted Concept's Final Edits from here.
function updateFinalEditModalFooter() {
  const found = editingFindFinalEdit(state.editing.activeFinalEditId);
  if (!found) return;
  const submitted = !!found.concept.editing_submitted_at;
  const submitMode = state.editing.finalEditSubmitMode;

  document.getElementById('final-edit-ready-badge').style.display = submitted ? '' : 'none';
  document.getElementById('final-edit-cancel-btn').style.display = submitted ? 'none' : '';
  const saveBtn = document.getElementById('final-edit-save-btn');
  saveBtn.style.display = submitted ? 'none' : '';
  saveBtn.textContent = submitMode ? 'Submit for Approval →' : 'Save Final Edit';
  saveBtn.onclick = submitMode ? submitFinalEditAndAdvance : saveFinalEdit;
  document.getElementById('final-edit-close-btn').style.display = submitted ? '' : 'none';

  document.getElementById('final-edit-link-input').disabled = submitted;
  document.getElementById('final-edit-editor').disabled = submitted;
  document.getElementById('final-edit-notes').readOnly = submitted;
  document.querySelector('#final-edit-editor-locked .link-btn').style.display = submitted ? 'none' : '';
}

// Reveals the Editor <select> in place of the locked "[Name] Change" view,
// for the rare case the inherited/known editor needs reassigning (item 3).
function showFinalEditEditorSelect() {
  document.getElementById('final-edit-editor-locked').style.display = 'none';
  const sel = document.getElementById('final-edit-editor');
  sel.style.display = '';
  sel.focus();
}

// After saving, return to the Concept workspace (not the landing page) so
// the checklist visibly ticks off and the editor can move straight on to
// the next Hook -- matches the "Open Concept -> complete each edit" mental
// model (item 12) rather than dropping them back out each time.
async function saveFinalEdit() {
  const found = editingFindFinalEdit(state.editing.activeFinalEditId);
  if (!found) return;
  const conceptAssetId = found.concept.creative_asset_id;

  const payload = {
    final_edit_link: document.getElementById('final-edit-link-input').value.trim(),
    editor: document.getElementById('final-edit-editor').value || null,
    editor_notes: document.getElementById('final-edit-notes').value.trim(),
  };

  try {
    await api(`/editing/final-edits/${state.editing.activeFinalEditId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    toast('Saved');
    await refreshCurrentEditingView();
    closeModal('final-edit-modal');
    openEditingConcept(conceptAssetId);
  } catch (e) {
    toast(e.message, true);
  }
}

// The "Edited" segment's actual submit action (see advanceEditingToEdited):
// saves whatever's in the form, THEN -- only on that save succeeding --
// calls ready-for-approval, which itself re-validates a link is present
// server-side. Either call failing leaves the concept exactly where it was
// (In Progress, same final_edits row, nothing duplicated) with the modal
// still open so the error is visible and the link can be fixed in place.
async function submitFinalEditAndAdvance() {
  const found = editingFindFinalEdit(state.editing.activeFinalEditId);
  if (!found) return;
  const conceptAssetId = found.concept.creative_asset_id;

  const payload = {
    final_edit_link: document.getElementById('final-edit-link-input').value.trim(),
    editor: document.getElementById('final-edit-editor').value || null,
    editor_notes: document.getElementById('final-edit-notes').value.trim(),
  };
  if (!payload.final_edit_link) {
    toast('Add the Final Edit link before submitting for approval', true);
    return;
  }

  try {
    await api(`/editing/final-edits/${state.editing.activeFinalEditId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    await api(`/editing/concepts/${conceptAssetId}/ready-for-approval`, { method: 'POST' });
    toast('Marked as Edited — sent for Approval');
    state.editing.finalEditSubmitMode = false;
    await refreshCurrentEditingView();
    closeModal('final-edit-modal');
  } catch (e) {
    toast(e.message, true);
  }
}

// "Remove Final Edit" in the Concept workspace (see renderEditingConceptModal)
// -- undoes an accidental Start Editing, or lets an editor start over.
async function deleteFinalEditFlow(finalEditId) {
  const found = editingFindFinalEdit(finalEditId);
  if (!found) return;
  const conceptAssetId = found.concept.creative_asset_id;
  const ok = await confirmDialog(`Delete "${found.finalEdit.asset_name}"? This can't be undone.`, { okLabel: 'Delete' });
  if (!ok) return;
  try {
    await api(`/editing/final-edits/${finalEditId}`, { method: 'DELETE' });
    toast('Final Edit deleted');
    await refreshCurrentEditingView();
    openEditingConcept(conceptAssetId);
  } catch (e) {
    toast(e.message, true);
  }
}

// The important workflow change (item 6): Ready for Approval submits the
// whole Concept -- its complete set of Final Edits -- as one unit to Final
// Approval, rather than each Final Edit going individually. Re-checked
// server-side, so this can't succeed against a stale/incomplete client view.
async function submitEditingConceptReady() {
  const conceptAssetId = state.editing.activeConceptAssetId;
  if (conceptAssetId == null) return;
  try {
    await api(`/editing/concepts/${conceptAssetId}/ready-for-approval`, { method: 'POST' });
    toast('Sent for Approval');
    await refreshCurrentEditingView();
    renderEditingConceptModal();
  } catch (e) {
    toast(e.message, true);
  }
}

// ── Final Approval ────────────────────────────────────
// The stage after Editing (see Issue 11/12): a flat queue of every Concept
// Editing has submitted (editing_submitted_at set) and not yet approved --
// no week-nav, no filters, just a queue. Reviewer opens a Concept, checks
// the Final Edit link + concept/shoot context, and either Approves
// (advances status toward the existing 'qc' stage) or Request Changes
// (sends it back into Editing's normal queue with feedback -- same
// Concept/final_edits row, never duplicated; see finalApproval.js).
async function loadFinalApproval() {
  try {
    const result = await api('/final-approval');
    state.finalApproval.data = result.concepts || [];
    renderFinalApprovalList();
  } catch (e) {
    toast(e.message, true);
  }
}

function finalApprovalCardHtml(c) {
  const hasLink = !!c.final_edit_link;
  return `
    <div class="cd-card" onclick="openFinalApprovalModal(${c.creative_asset_id})">
      <div class="cd-card-top"><div class="cd-card-name">${escapeHtml(c.product_name || c.concept_name)}</div></div>
      <div class="cd-card-meta">${escapeHtml(c.concept_name)}</div>
      ${c.final_approval_status === 'changes_required' ? '<span class="cd-concept-status-pill editing-status-to-edit">Resubmitted</span>' : ''}
      ${hasLink ? '' : '<div class="editing-final-edit-empty">No Final Edit link yet</div>'}
    </div>`;
}

function renderFinalApprovalList() {
  const count = state.finalApproval.data.length;
  document.getElementById('final-approval-summary').textContent =
    count ? `${count} concept${count === 1 ? '' : 's'} awaiting Final Approval` : 'Nothing awaiting Final Approval';

  const list = document.getElementById('final-approval-list');
  list.innerHTML = count
    ? state.finalApproval.data.map(finalApprovalCardHtml).join('')
    : '<div class="attention-empty">Nothing awaiting Final Approval right now.</div>';
}

function finalApprovalFindConcept(creativeAssetId) {
  return state.finalApproval.data.find((c) => c.creative_asset_id === creativeAssetId) || null;
}

function openFinalApprovalModal(creativeAssetId) {
  const concept = finalApprovalFindConcept(creativeAssetId);
  if (!concept) return;
  state.finalApproval.activeCreativeAssetId = creativeAssetId;
  state.finalApproval.showFeedbackForm = false;
  document.getElementById('final-approval-move-back-btn').style.display = state.currentUser && state.currentUser.role === 'admin' ? '' : 'none';
  renderFinalApprovalModal();
  openModal('final-approval-modal');
}

function openFinalApprovalBrief() {
  const concept = finalApprovalFindConcept(state.finalApproval.activeCreativeAssetId);
  if (!concept || !concept.shoot_schedule_id) return;
  closeModal('final-approval-modal');
  openShootingBrief(concept.shoot_schedule_id);
}

function renderFinalApprovalModal() {
  const concept = finalApprovalFindConcept(state.finalApproval.activeCreativeAssetId);
  if (!concept) return;

  document.getElementById('final-approval-modal-title').textContent = concept.concept_name;
  document.getElementById('final-approval-modal-subtitle').textContent = concept.product_name || '';

  const hasLink = !!concept.final_edit_link;
  document.getElementById('final-approval-modal-body').innerHTML = `
    <div class="editing-final-edit-row">
      ${concept.editor ? `<div class="editing-final-edit-field"><span class="editing-final-edit-field-label">Editor</span>${escapeHtml(concept.editor)}</div>` : ''}
      ${hasLink
        ? `<a href="${escapeHtml(concept.final_edit_link)}" target="_blank" rel="noopener" class="link-btn">View Final Edit &rarr;</a>`
        : '<div class="editing-final-edit-empty">No link pasted back yet.</div>'}
      ${concept.editor_notes ? `<div class="editing-final-edit-notes">${escapeHtml(concept.editor_notes)}</div>` : ''}
    </div>
    ${concept.shoot_schedule_id ? `<button type="button" class="link-btn" onclick="openFinalApprovalBrief()">View Shoot Brief &rarr;</button>` : ''}`;

  const showForm = state.finalApproval.showFeedbackForm;
  const feedbackSection = document.getElementById('final-approval-feedback-section');
  feedbackSection.style.display = showForm ? '' : 'none';
  if (!showForm) document.getElementById('final-approval-feedback-input').value = '';

  document.getElementById('final-approval-approve-btn').style.display = showForm ? 'none' : '';
  document.getElementById('final-approval-close-btn').style.display = showForm ? 'none' : '';
  const requestBtn = document.getElementById('final-approval-request-changes-btn');
  requestBtn.textContent = showForm ? 'Send Back' : 'Request Changes';
  requestBtn.onclick = showForm ? submitFinalApprovalRequestChanges : toggleFinalApprovalFeedback;
}

function toggleFinalApprovalFeedback() {
  state.finalApproval.showFeedbackForm = !state.finalApproval.showFeedbackForm;
  renderFinalApprovalModal();
}

async function submitFinalApprovalApprove() {
  const id = state.finalApproval.activeCreativeAssetId;
  if (id == null) return;
  try {
    await api(`/final-approval/concepts/${id}/approve`, { method: 'POST' });
    // Moves Ready for Approval -> Ad Setup -- never just vanishes: it
    // reappears in the Ad Setup sub-tab (see finalApproval.js's approve
    // route, which auto-creates one ad_setups row per Final Edit here).
    toast('Approved -- now in Ad Setup');
    closeModal('final-approval-modal');
    await loadFinalApproval();
    await loadAdSetupBoard();
    switchFinalApprovalSubtab('ad-setup');
  } catch (e) {
    toast(e.message, true);
  }
}

async function submitFinalApprovalRequestChanges() {
  const id = state.finalApproval.activeCreativeAssetId;
  if (id == null) return;
  const feedback = document.getElementById('final-approval-feedback-input').value.trim();
  if (!feedback) {
    toast('Feedback is required to request changes', true);
    return;
  }
  try {
    await api(`/final-approval/concepts/${id}/request-changes`, { method: 'POST', body: JSON.stringify({ feedback }) });
    toast('Sent back to Editing');
    closeModal('final-approval-modal');
    await loadFinalApproval();
  } catch (e) {
    toast(e.message, true);
  }
}

// ── Ad Setup (Part C: Final Approval -> Ad Setup -> Approved) ──────────
// Purely structural Meta ad prep -- naming fields, copy drafts, CTA,
// destination. Never calls Meta and never publishes anything; the backend
// (routes/adSetup.js) is explicit that "Create in Meta ->" is future work
// this data model is meant to support, not built here.

const AD_CATEGORY_LABELS = { new_drop: 'New Drop/Product Launch', core: 'Core', promotion: 'Promotion/Sale', organic_first: 'Organic-first' };
const URL_LINK_PAGE_LABELS = { product: 'Product', category: 'Category', new_arrivals: 'New Arrivals', home: 'Home Page', sale_bundle: 'Sale/Bundle Page', other: 'Other' };
const CTA_LABELS = { shop_now: 'Shop Now', sign_up: 'Sign Up', learn_more: 'Learn More', shop_the_sale: 'Shop the Sale' };
const STAGE_TAGS = { hype: 'HYPE', sale_live: 'LIVE', mid_sale: 'MID SALE', last_chance: 'LAST CHANCE' };

function switchFinalApprovalSubtab(name) {
  state.adSetup.activeSubtab = name;
  document.querySelectorAll('.fa-subtab').forEach((el) => el.classList.toggle('active', el.dataset.faSubtab === name));
  document.getElementById('fa-panel-ready').style.display = name === 'ready' ? '' : 'none';
  document.getElementById('fa-panel-ad-setup').style.display = name === 'ad-setup' ? '' : 'none';
  document.getElementById('fa-panel-approved').style.display = name === 'approved' ? '' : 'none';
  loadFinalApprovalActiveSubtab();
}

function loadFinalApprovalActiveSubtab() {
  if (state.adSetup.activeSubtab === 'ready') return loadFinalApproval();
  return loadAdSetupBoard();
}

async function loadAdSetupBoard() {
  try {
    const result = await api('/ad-setup/board');
    state.adSetup.board = result;
    renderAdSetupSubtabCounts();
    renderAdSetupList();
    renderAdSetupApprovedList();
  } catch (e) {
    toast(e.message, true);
  }
}

function renderAdSetupSubtabCounts() {
  document.getElementById('fa-count-ready').textContent = state.finalApproval.data.length ? `(${state.finalApproval.data.length})` : '';
  document.getElementById('fa-count-ad-setup').textContent = state.adSetup.board.ad_setup.length ? `(${state.adSetup.board.ad_setup.length})` : '';
  document.getElementById('fa-count-approved').textContent = state.adSetup.board.approved.length ? `(${state.adSetup.board.approved.length})` : '';
}

function adSetupCardHtml(item) {
  const batch = item.batch_number ? `<div class="as-card-batch">#${item.batch_number}</div>` : '';
  return `
    <div class="cd-card" onclick="openAdSetupModal(${item.id})">
      ${batch}
      <div class="cd-card-top"><div class="cd-card-name">${escapeHtml(item.product_label || item.concept_name)}</div></div>
      <div class="cd-card-meta">${escapeHtml(item.concept_name)} &middot; ${escapeHtml(AD_CATEGORY_LABELS[item.ad_category] || item.ad_category)}</div>
    </div>`;
}

function renderAdSetupList() {
  const items = state.adSetup.board.ad_setup;
  document.getElementById('ad-setup-summary').textContent = items.length
    ? `${items.length} creative${items.length === 1 ? '' : 's'} in Ad Setup` : 'Nothing in Ad Setup right now.';
  document.getElementById('ad-setup-list').innerHTML = items.length
    ? items.map(adSetupCardHtml).join('')
    : '<div class="attention-empty">Nothing in Ad Setup right now.</div>';
}

function adSetupApprovedCardHtml(item) {
  const batch = item.batch_number ? `<div class="as-card-batch">#${item.batch_number}</div>` : '';
  return `
    <div class="cd-card" onclick="openAdSetupApprovedModal(${item.id})">
      ${batch}
      <div class="cd-card-top"><div class="cd-card-name">${escapeHtml(item.product_label || item.concept_name)}</div></div>
      <div class="cd-card-meta">${escapeHtml(item.concept_name)}</div>
    </div>`;
}

function renderAdSetupApprovedList() {
  const items = state.adSetup.board.approved;
  document.getElementById('ad-setup-approved-summary').textContent = items.length
    ? `${items.length} approved ad${items.length === 1 ? '' : 's'}` : 'Nothing approved yet.';
  document.getElementById('ad-setup-approved-list').innerHTML = items.length
    ? items.map(adSetupApprovedCardHtml).join('')
    : '<div class="attention-empty">Nothing approved yet.</div>';
}

// Client-side mirror of lib/adSetupNaming.js's buildMetaAdName, so the
// Generated Meta Ad Name preview updates live as fields are edited without
// a round trip -- Save Draft still persists through the server, which is
// the single source of truth once saved.
function formatDateDDMMClient(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
// Order: [Sale stage/sequence prefix, if Promotion] Batch, Week, Date,
// Product Name, Product Category, Short Hook, Media, Ad Type, Creator,
// Concept, URL Link Page -- must match lib/adSetupNaming.js's
// buildMetaAdName exactly (server is the source of truth once saved; this
// is only for the live-typing preview before Save Draft round-trips).
function buildMetaAdNamePreviewClient(d) {
  const segs = [];
  if (d.ad_category === 'promotion' && d.stage_type && STAGE_TAGS[d.stage_type]) {
    segs.push(`${STAGE_TAGS[d.stage_type]}${d.sale_sequence_number ? ` ${d.sale_sequence_number}` : ''}`);
  }
  segs.push(d.batch_number ? `#${d.batch_number}` : '#—');
  if (d.week_no) segs.push(d.week_no);
  if (d.ad_date) segs.push(formatDateDDMMClient(d.ad_date));
  segs.push(d.product_label ? d.product_label.toUpperCase() : '*');
  segs.push(d.product_type ? d.product_type.toUpperCase() : '*');
  segs.push(d.hook_short || '*');
  segs.push(d.media_type === 'video' ? 'Video' : d.media_type === 'image' ? 'Image' : '*');
  segs.push(d.ad_type === 'carousel' ? 'Carousel' : 'Single');
  segs.push(d.creator_name ? d.creator_name.toUpperCase() : '*');
  segs.push(d.concept_label ? d.concept_label.toUpperCase() : '*');
  segs.push(d.url_link_page ? (URL_LINK_PAGE_LABELS[d.url_link_page] || d.url_link_page) : '*');
  return segs.join('_');
}

async function openAdSetupModal(id) {
  try {
    const detail = await api(`/ad-setup/${id}`);
    state.adSetup.editingId = id;
    state.adSetup.draft = { ...detail };
    document.getElementById('ad-setup-modal-title').textContent = detail.concept_name;
    document.getElementById('ad-setup-move-back-btn').style.display = state.currentUser && state.currentUser.role === 'admin' ? '' : 'none';
    renderAdSetupModal();
    openModal('ad-setup-modal');
  } catch (e) {
    toast(e.message, true);
  }
}

function adSetupSet(field, value) {
  state.adSetup.draft[field] = value;
  renderAdSetupNamePreview();
}

function renderAdSetupNamePreview() {
  const d = state.adSetup.draft;
  const el = document.getElementById('as-name-preview-text');
  if (el) el.textContent = buildMetaAdNamePreviewClient({
    ad_category: d.ad_category, stage_type: d.promotion_stage_name ? detectStageTypeClient(d.promotion_stage_name) : null,
    sale_sequence_number: d.sale_sequence_number, batch_number: d.batch_number, week_no: d.week_no, ad_date: d.ad_date,
    product_label: d.product_label, product_type: d.product_type,
    hook_short: d.hook_short, creator_name: d.creator_name, concept_label: d.concept_label,
    media_type: d.media_type, ad_type: d.ad_type, url_link_page: d.url_link_page,
  });
  renderAdSetupReadiness();
}

function detectStageTypeClient(stageName) {
  const n = (stageName || '').toLowerCase();
  if (n.includes('hype')) return 'hype';
  if (n.includes('mid')) return 'mid_sale';
  if (n.includes('last chance') || n.includes('final') || n.includes('ending')) return 'last_chance';
  if (n.includes('live')) return 'sale_live';
  return null;
}

function renderAdSetupReadiness() {
  const d = state.adSetup.draft;
  const hasCopy = !!(d.copy_set_id || (d.selected_primary_text && d.selected_headline));
  const items = [
    { label: 'Meta Ad Name (Hook)', ready: !!d.hook_short },
    { label: 'Creative', ready: !!d.final_edit_link },
    { label: 'Primary Text / Headline', ready: hasCopy },
    { label: 'CTA', ready: !!d.cta },
    { label: 'Destination', ready: !!(d.url_link_page && d.destination_url) },
  ];
  const el = document.getElementById('as-readiness-list');
  if (!el) return;
  el.innerHTML = items.map((it) => `<li class="as-readiness-item ${it.ready ? 'ready' : 'missing'}">${it.ready ? '&#10003;' : '&#9675;'} ${escapeHtml(it.label)}</li>`).join('');
  const approveBtn = document.getElementById('ad-setup-approve-btn');
  if (approveBtn) approveBtn.disabled = !items.every((it) => it.ready) || state.adSetup.draft.status === 'approved';
}

function renderAdSetupModal() {
  const d = state.adSetup.draft;
  const originLine = [
    d.promotion_name ? `Promotion: ${d.promotion_name}${d.promotion_stage_name ? ` (${d.promotion_stage_name})` : ''}` : null,
  ].filter(Boolean).join(' &middot; ');

  const optionSelect = (field, labelMap, current) => Object.entries(labelMap)
    .map(([val, label]) => `<option value="${val}" ${val === current ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');

  const batchOptions = (d.batches || []).map((b) => `<option value="${b.id}" ${b.id === d.ad_batch_id ? 'selected' : ''}>#${b.batch_number} ${escapeHtml(b.name || '')}</option>`).join('');

  const copySetOptions = (d.copy_sets || []).map((cs) => `<option value="${cs.id}" ${cs.id === d.copy_set_id ? 'selected' : ''}>${escapeHtml(cs.name)}</option>`).join('');

  const primaryOptions = (d.primary_text_options || []).map((t, i) => `
    <div class="as-copy-option ${d.selected_primary_text === t ? 'selected' : ''}" onclick="selectAdSetupCopy('primary', ${i})">
      <div class="as-copy-option-label">Option ${i + 1}</div>${escapeHtml(t)}
    </div>`).join('') || '<div class="hint">No drafts yet -- click Regenerate.</div>';

  const headlineOptions = (d.headline_options || []).map((t, i) => `
    <div class="as-copy-option ${d.selected_headline === t ? 'selected' : ''}" onclick="selectAdSetupCopy('headline', ${i})">
      <div class="as-copy-option-label">Option ${i + 1}</div>${escapeHtml(t)}
    </div>`).join('') || '<div class="hint">No drafts yet -- click Regenerate.</div>';

  const usingCopySet = !!d.copy_set_id;

  document.getElementById('ad-setup-modal-body').innerHTML = `
    <div class="as-section">
      <div class="as-section-title">Ad Details</div>
      ${originLine ? `<div class="hint" style="margin-bottom:10px;">${originLine}</div>` : ''}
      <div class="as-grid">
        <label>Ad Category
          <select onchange="adSetupSet('ad_category', this.value)">${optionSelect('ad_category', AD_CATEGORY_LABELS, d.ad_category)}</select>
        </label>
        <label>Batch
          <select onchange="onAdSetupBatchChange(this.value)">
            <option value="">-- None --</option>
            ${batchOptions}
            <option value="__new__">+ New Batch&hellip;</option>
          </select>
        </label>
        <label>Week No.
          <input type="text" value="${escapeHtml(d.week_no || '')}" oninput="adSetupSet('week_no', this.value)">
        </label>
        <label>Date
          <input type="date" value="${d.ad_date ? String(d.ad_date).slice(0, 10) : ''}" oninput="adSetupSet('ad_date', this.value)">
        </label>
      </div>
    </div>

    <div class="as-section">
      <div class="as-section-title">Naming</div>
      <div class="hint" style="margin-bottom:10px;">Product Name/Category here are how this ad is named in Meta only -- editing them never changes the linked WNDRR/ApparelMagic product record.</div>
      <div class="as-grid">
        <label>Product Name
          <input type="text" value="${escapeHtml(d.product_label || '')}" oninput="adSetupSet('product_label', this.value)">
        </label>
        <label>Product Category
          <input type="text" value="${escapeHtml(d.product_type || '')}" oninput="adSetupSet('product_type', this.value)">
        </label>
        <label>Hook (short)
          <input type="text" value="${escapeHtml(d.hook_short || '')}" oninput="adSetupSet('hook_short', this.value)">
        </label>
        <label>Media
          <select onchange="adSetupSet('media_type', this.value)">
            <option value="video" ${d.media_type === 'video' ? 'selected' : ''}>Video</option>
            <option value="image" ${d.media_type === 'image' ? 'selected' : ''}>Image</option>
          </select>
        </label>
        <label>Ad Type
          <select onchange="adSetupSet('ad_type', this.value)">
            <option value="single" ${d.ad_type === 'single' ? 'selected' : ''}>Single</option>
            <option value="carousel" ${d.ad_type === 'carousel' ? 'selected' : ''}>Carousel</option>
          </select>
        </label>
        <label>Creator
          <input type="text" value="${escapeHtml(d.creator_name || '')}" placeholder="n/a" oninput="adSetupSet('creator_name', this.value)">
        </label>
        <label>Concept
          <input type="text" value="${escapeHtml(d.concept_label || '')}" oninput="adSetupSet('concept_label', this.value)">
        </label>
        <label>URL Link Page
          <select onchange="adSetupSet('url_link_page', this.value)">${optionSelect('url_link_page', URL_LINK_PAGE_LABELS, d.url_link_page)}</select>
        </label>
      </div>
      <div class="as-name-preview" style="margin-top:12px;">
        <span id="as-name-preview-text">${escapeHtml(buildMetaAdNamePreviewClient({
          ad_category: d.ad_category, stage_type: d.promotion_stage_name ? detectStageTypeClient(d.promotion_stage_name) : null,
          sale_sequence_number: d.sale_sequence_number, batch_number: d.batch_number, week_no: d.week_no, ad_date: d.ad_date,
          product_label: d.product_label, product_type: d.product_type,
          hook_short: d.hook_short, creator_name: d.creator_name, concept_label: d.concept_label,
          media_type: d.media_type, ad_type: d.ad_type, url_link_page: d.url_link_page,
        }))}</span>
        <button type="button" class="btn btn-ghost" style="flex-shrink:0;" onclick="copyAdSetupName()">Copy Name</button>
      </div>
    </div>

    <div class="as-section">
      <div class="as-section-title">Creative</div>
      ${d.final_edit_link
        ? `<a href="${escapeHtml(d.final_edit_link)}" target="_blank" rel="noopener" class="link-btn">View Creative &rarr;</a> <span class="hint">${escapeHtml(d.final_edit_asset_name || '')}</span>`
        : '<div class="editing-final-edit-empty">No final creative link on record.</div>'}
    </div>

    <div class="as-section">
      <div class="as-section-title">Copy</div>
      <label>Copy Set
        <select onchange="onAdSetupCopySetChange(this.value)">
          <option value="">-- Use this ad's own copy --</option>
          ${copySetOptions}
        </select>
      </label>
      ${usingCopySet
        ? `<div class="hint" style="margin:8px 0;">Using shared Copy Set: sharing Primary Text/Headline/CTA with every other ad in this set.</div>`
        : `<div style="display:flex;gap:16px;margin-top:10px;flex-wrap:wrap;">
             <div style="flex:1;min-width:240px;">
               <div class="admin-note" style="margin-bottom:6px;">Primary Text</div>
               ${primaryOptions}
             </div>
             <div style="flex:1;min-width:240px;">
               <div class="admin-note" style="margin-bottom:6px;">Headline</div>
               ${headlineOptions}
             </div>
           </div>
           <button type="button" class="btn btn-ghost" style="margin-top:8px;" onclick="regenerateAdSetupCopy()">Regenerate</button>
           <button type="button" class="btn btn-ghost" style="margin-top:8px;" onclick="createAdSetupCopySetFromCurrent()">Save as New Copy Set</button>`}
      <label style="margin-top:12px;">CTA
        <select onchange="adSetupSet('cta', this.value)">${optionSelect('cta', CTA_LABELS, d.cta)}</select>
      </label>
    </div>

    <div class="as-section">
      <div class="as-section-title">Destination</div>
      <div class="as-grid">
        <label>Destination URL
          <input type="text" value="${escapeHtml(d.destination_url || '')}" placeholder="https://" oninput="adSetupSet('destination_url', this.value)">
        </label>
      </div>
    </div>

    <div class="as-section">
      <div class="as-section-title">Final Check</div>
      <ul class="as-readiness-list" id="as-readiness-list"></ul>
    </div>
  `;
  renderAdSetupReadiness();
  const approveBtn = document.getElementById('ad-setup-approve-btn');
  if (approveBtn) approveBtn.style.display = d.status === 'approved' ? 'none' : '';
  const saveBtn = document.getElementById('ad-setup-save-btn');
  if (saveBtn) saveBtn.style.display = d.status === 'approved' ? 'none' : '';
}

function selectAdSetupCopy(kind, index) {
  const d = state.adSetup.draft;
  if (kind === 'primary') d.selected_primary_text = d.primary_text_options[index];
  else d.selected_headline = d.headline_options[index];
  renderAdSetupModal();
}

async function regenerateAdSetupCopy() {
  try {
    const updated = await api(`/ad-setup/${state.adSetup.editingId}/regenerate-copy`, { method: 'POST' });
    state.adSetup.draft = { ...state.adSetup.draft, ...updated };
    toast('Copy drafts regenerated');
    renderAdSetupModal();
  } catch (e) {
    toast(e.message, true);
  }
}

async function onAdSetupBatchChange(value) {
  if (value === '__new__') return createAdSetupBatchAndAssign();
  try {
    const updated = await api(`/ad-setup/${state.adSetup.editingId}`, { method: 'PATCH', body: JSON.stringify({ ad_batch_id: value ? Number(value) : null }) });
    state.adSetup.draft = { ...state.adSetup.draft, ...updated };
    toast('Batch assigned');
    renderAdSetupModal();
    loadAdSetupBoard();
  } catch (e) {
    toast(e.message, true);
  }
}

async function createAdSetupBatchAndAssign() {
  const name = prompt('Name for this new batch (optional):', '');
  try {
    const batch = await api('/ad-setup/batches', { method: 'POST', body: JSON.stringify({ name: name || undefined }) });
    const updated = await api(`/ad-setup/${state.adSetup.editingId}`, { method: 'PATCH', body: JSON.stringify({ ad_batch_id: batch.id }) });
    state.adSetup.draft = { ...state.adSetup.draft, ...updated, batches: [...(state.adSetup.draft.batches || []), batch] };
    toast(`Batch #${batch.batch_number} created and assigned`);
    renderAdSetupModal();
    loadAdSetupBoard();
  } catch (e) {
    toast(e.message, true);
  }
}

async function onAdSetupCopySetChange(value) {
  try {
    const updated = await api(`/ad-setup/${state.adSetup.editingId}`, { method: 'PATCH', body: JSON.stringify({ copy_set_id: value ? Number(value) : null }) });
    state.adSetup.draft = { ...state.adSetup.draft, ...updated };
    renderAdSetupModal();
  } catch (e) {
    toast(e.message, true);
  }
}

async function createAdSetupCopySetFromCurrent() {
  const d = state.adSetup.draft;
  if (!d.selected_primary_text || !d.selected_headline) {
    toast('Select a Primary Text and Headline first', true);
    return;
  }
  const name = prompt('Name this Copy Set (e.g. "CLEAN FIT — HALO SWEAT SET"):', d.product_label || '');
  if (!name) return;
  try {
    const copySet = await api('/ad-setup/copy-sets', { method: 'POST', body: JSON.stringify({ name, primary_text: d.selected_primary_text, headline: d.selected_headline, cta: d.cta }) });
    const updated = await api(`/ad-setup/${state.adSetup.editingId}`, { method: 'PATCH', body: JSON.stringify({ copy_set_id: copySet.id }) });
    state.adSetup.draft = { ...state.adSetup.draft, ...updated, copy_sets: [...(state.adSetup.draft.copy_sets || []), copySet] };
    toast('Copy Set created and applied');
    renderAdSetupModal();
  } catch (e) {
    toast(e.message, true);
  }
}

function copyAdSetupName() {
  const text = document.getElementById('as-name-preview-text').textContent;
  navigator.clipboard.writeText(text).then(() => toast('Copied')).catch(() => toast('Could not copy', true));
}

async function saveAdSetupDraft() {
  const d = state.adSetup.draft;
  const fields = [
    'ad_category', 'week_no', 'ad_date', 'product_label', 'product_type', 'hook_short',
    'media_type', 'ad_type', 'creator_name', 'concept_label', 'url_link_page', 'destination_url',
    'selected_primary_text', 'selected_headline', 'cta',
  ];
  const body = {};
  fields.forEach((f) => { body[f] = d[f]; });
  try {
    const updated = await api(`/ad-setup/${state.adSetup.editingId}`, { method: 'PATCH', body: JSON.stringify(body) });
    state.adSetup.draft = { ...state.adSetup.draft, ...updated };
    toast('Draft saved');
    loadAdSetupBoard();
  } catch (e) {
    toast(e.message, true);
  }
}

async function approveAdSetup() {
  await saveAdSetupDraft();
  try {
    await api(`/ad-setup/${state.adSetup.editingId}/approve`, { method: 'POST' });
    toast('Ad Setup approved');
    closeModal('ad-setup-modal');
    await loadAdSetupBoard();
    switchFinalApprovalSubtab('approved');
  } catch (e) {
    toast(e.message, true);
  }
}

async function openAdSetupApprovedModal(id) {
  try {
    const d = await api(`/ad-setup/${id}`);
    state.adSetup.approvedDetail = d;
    document.getElementById('ad-setup-approved-move-back-btn').style.display = state.currentUser && state.currentUser.role === 'admin' ? '' : 'none';
    document.getElementById('ad-setup-approved-modal-title').textContent = d.concept_name;
    const originLine = [
      d.promotion_name ? `Promotion: ${d.promotion_name}${d.promotion_stage_name ? ` (${d.promotion_stage_name})` : ''}` : (AD_CATEGORY_LABELS[d.ad_category] || d.ad_category),
    ].join('');
    const copyPrimary = d.copy_set_id ? (d.copy_sets.find((cs) => cs.id === d.copy_set_id) || {}).primary_text : d.selected_primary_text;
    const copyHeadline = d.copy_set_id ? (d.copy_sets.find((cs) => cs.id === d.copy_set_id) || {}).headline : d.selected_headline;
    document.getElementById('ad-setup-approved-modal-body').innerHTML = `
      <div class="as-section">
        ${d.batch_number ? `<div class="as-card-batch">#${d.batch_number}</div>` : ''}
        <div class="hint">${escapeHtml(originLine)}</div>
      </div>
      <div class="as-section">
        <div class="as-section-title">Final Creative</div>
        ${d.final_edit_link ? `<a href="${escapeHtml(d.final_edit_link)}" target="_blank" rel="noopener" class="link-btn">View Creative &rarr;</a>` : '<div class="hint">No link on record.</div>'}
      </div>
      <div class="as-section">
        <div class="as-section-title">Meta Ad Name</div>
        <div class="as-name-preview"><span>${escapeHtml(d.generated_meta_ad_name)}</span></div>
      </div>
      <div class="as-section">
        <div class="as-section-title">Product(s)</div>
        <div>${d.products.map((p) => escapeHtml(p.name)).join(', ') || '&mdash;'}</div>
      </div>
      <div class="as-section">
        <div class="as-section-title">Copy</div>
        <div style="margin-bottom:8px;"><strong>Primary Text:</strong> ${escapeHtml(copyPrimary || '—')}</div>
        <div style="margin-bottom:8px;"><strong>Headline:</strong> ${escapeHtml(copyHeadline || '—')}</div>
        <div><strong>CTA:</strong> ${escapeHtml(CTA_LABELS[d.cta] || d.cta)}</div>
      </div>
      <div class="as-section">
        <div class="as-section-title">Destination</div>
        <div>${escapeHtml(URL_LINK_PAGE_LABELS[d.url_link_page] || d.url_link_page)} &mdash; ${escapeHtml(d.destination_url || '')}</div>
      </div>
    `;
    openModal('ad-setup-approved-modal');
  } catch (e) {
    toast(e.message, true);
  }
}

// ── Move Back (QA/testing + workflow correction, admin only) ───────────
// One shared confirmation modal + pair of calls, reused from every stage's
// own "<- Move Back" button (Tuesday Review's decision bar, Shooting's
// brief, Editing's concept modal, Final Approval, Ad Setup, Approved). The
// backend always detects the concept's real current stage itself (see
// routes/moveBack.js) -- this never guesses or hardcodes which stage a
// given button "means", so the confirmation text always names the actual
// stage the concept will land in.
let moveBackConceptId = null;

async function openMoveBackModal(creativeAssetId) {
  if (creativeAssetId == null) return;
  try {
    const preview = await api(`/move-back/${creativeAssetId}/preview`);
    moveBackConceptId = creativeAssetId;
    document.getElementById('move-back-modal-question').textContent =
      `Move "${preview.concept_name}" back to ${preview.target_stage_label}?`;
    openModal('move-back-modal');
  } catch (e) {
    toast(e.message, true);
  }
}

async function confirmMoveBack() {
  if (moveBackConceptId == null) return;
  try {
    const result = await api(`/move-back/${moveBackConceptId}`, { method: 'POST' });
    closeModal('move-back-modal');
    // Close whichever stage modal was open -- the concept just left that
    // stage, so nothing in it is still valid to look at.
    ['tuesday-review-modal', 'shoot-brief-modal', 'editing-concept-modal', 'final-approval-modal', 'ad-setup-modal', 'ad-setup-approved-modal']
      .forEach((id) => closeModal(id));
    toast(`Moved back to ${STAGE_LABELS_CLIENT[result.to_stage] || result.to_stage}`);
    // Refresh every screen the concept could now be sitting on -- cheap,
    // and simpler/safer than tracking exactly which one it landed in.
    // Wrapped defensively: some of these (refreshCurrentShootingView/
    // refreshCurrentEditingView) are plain, not async, functions that
    // return undefined rather than a Promise, so calling .catch() directly
    // on their result throws -- safeMoveBackRefresh handles both cases.
    await Promise.all([
      safeMoveBackRefresh(loadTuesdayReviewWeek),
      safeMoveBackRefresh(loadConceptDevWeek),
      safeMoveBackRefresh(refreshCurrentShootingView),
      safeMoveBackRefresh(refreshCurrentEditingView),
      safeMoveBackRefresh(loadFinalApproval),
      safeMoveBackRefresh(loadAdSetupBoard),
    ]);
  } catch (e) {
    toast(e.message, true);
  }
}

function safeMoveBackRefresh(fn) {
  try {
    return Promise.resolve(fn()).catch(() => {});
  } catch (e) {
    return Promise.resolve();
  }
}

const STAGE_LABELS_CLIENT = {
  'concept-dev': 'Concept Dev',
  'tuesday-review': 'Tuesday Review',
  shooting: 'Shooting',
  editing: 'Editing',
  'final-approval': 'Final Approval',
  'ad-setup': 'Ad Setup',
  approved: 'Approved',
};

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

// Which Concept Dev modal opened the picker (see chooseConceptDevReferenceFromLibrary/
// choosePromotionConceptDevReferenceFromLibrary) -- this is the one small
// shared touch-point with the (fully separate) Promotion Concept Dev modal,
// since there is only one Reference Library picker in the whole app,
// already reused by multiple call sites.
let referencePickerTarget = 'normal';

function pickReferenceLibraryItem(id) {
  const item = state.referenceLibrary.find((r) => r.id === id);
  if (!item) return;
  if (referencePickerTarget === 'promo') {
    promoConceptDevModalReferences.push({ url: item.link, note: '', library_reference_id: item.id });
    renderPromotionConceptDevModalReferences();
  } else {
    conceptDevModalReferences.push({ url: item.link, note: '', library_reference_id: item.id });
    renderConceptDevModalReferences();
  }
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
