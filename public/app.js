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

let state = { styles: [], categories: [], board: null, dashboard: null, drops: [], jobs: [], provenWinners: [] };
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
  document.getElementById('app').style.display = 'block';
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

// ── Load & render ────────────────────────────────────
async function loadAll() {
  try {
    const [board, styles, categories, dashboard, dropsRes, jobs, provenWinners] = await Promise.all([
      api('/board'),
      api('/styles'),
      api('/categories'),
      api(`/dashboard?weekOffset=${dashboardWeekOffset}`),
      api('/drops'),
      api('/creative-jobs'),
      api('/proven-winners'),
    ]);
    state.board = board;
    state.styles = styles;
    state.categories = categories;
    state.dashboard = dashboard;
    state.drops = dropsRes.drops;
    state.amConfigured = dropsRes.apparelmagic.configured;
    state.amError = dropsRes.apparelmagic.error;
    state.jobs = jobs;
    state.provenWinners = provenWinners;
    renderBoard();
    renderMissingAd();
    renderStylesTable();
    renderCategoriesTable();
    populateStyleSelect();
    populateCategorySelect();
    renderDashboard();
    renderPlanning();
    renderProvenWinners();
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
const CONCEPT_TYPE_LABELS = {
  proven_concept: 'Proven Concept', new_concept: 'New Concept', winning_concept_iteration: 'Winning Concept Iteration',
  product_content: 'Product Content', ugc_creator: 'UGC / Creator', static: 'Static',
  existing_content_variation: 'Existing Content Variation', other: 'Other',
};
const PLANNING_STATUS_LABELS = { not_started: 'Not Started', organising: 'Organising', blocked: 'Blocked', ready_for_briefing: 'Ready for Briefing' };
const STOCK_RESOLVED = ['not_required', 'available'];
const TALENT_RESOLVED = ['not_required', 'internal_team', 'confirmed'];
const LOCATION_RESOLVED = ['not_required', 'office', 'warehouse', 'studio', 'external_location', 'confirmed'];
const PROPS_RESOLVED = ['not_required', 'organised'];

function formatDate(value) {
  return value ? String(value).slice(0, 10) : null;
}

function renderPlanning() {
  renderPlanningSummary();
  renderDropsRow();
  renderJobsGrid();
  populateJobDropSelect();
  loadDropSuggestions();
  renderPlanningRoute();
}

// ── Planning sub-navigation (list / drop / product) ──
// Hash-routed so a drop or product is a genuinely separate view (not an
// inline expand), with working back/forward. Scheme:
//   #planning/drop/<id>
//   #planning/drop/<id>/product/<productCode>
function parsePlanningHash() {
  const parts = window.location.hash.replace(/^#planning\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'drop' && parts[1]) {
    if (parts[2] === 'product' && parts[3]) {
      return { view: 'product', dropId: Number(parts[1]), productCode: decodeURIComponent(parts[3]) };
    }
    return { view: 'drop', dropId: Number(parts[1]) };
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

  if (route.view === 'drop') {
    loadDropView(route.dropId);
  } else if (route.view === 'product') {
    document.getElementById('product-view-back').onclick = () => { window.location.hash = `#planning/drop/${route.dropId}`; };
    loadProductView(route.dropId, route.productCode);
  }
}
window.addEventListener('hashchange', renderPlanningRoute);

// Every upcoming ApparelMagic launch date should already have a Drop card
// on the Planning page without anyone clicking "+ New Drop" -- name is left
// blank ("Untitled", see renderDropsRow/loadDropView) for the team to fill
// in later via Edit. POST /from-suggestion is idempotent per launch_date
// (reuses an existing drop for that date rather than duplicating it), and
// once a cluster's styles are assigned they drop out of future /suggestions
// results -- so calling this on every Planning load is safe and naturally
// stops doing anything once the list is caught up.
async function loadDropSuggestions() {
  try {
    const { suggestions } = await api('/drops/suggestions');
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

function renderPlanningSummary() {
  const jobs = state.jobs;
  const counts = {
    ready: jobs.filter((j) => j.planning_status === 'ready_for_briefing').length,
    blocked: jobs.filter((j) => j.planning_status === 'blocked').length,
    organising: jobs.filter((j) => j.planning_status === 'organising').length,
    not_started: jobs.filter((j) => j.planning_status === 'not_started').length,
  };
  document.getElementById('planning-week-title').textContent = state.dashboard ? `Planning — Week ${state.dashboard.week.number}` : 'Planning';
  document.getElementById('planning-job-summary').textContent =
    `${jobs.length} Creative Jobs — ${counts.ready} Ready for Briefing, ${counts.blocked} Blocked, ${counts.organising} Organising, ${counts.not_started} Not Started`;

  const blocked = jobs.filter((j) => j.planning_status === 'blocked');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const upcoming = jobs.filter((j) => {
    if (!j.production_date) return false;
    const d = new Date(j.production_date);
    return d >= today && d <= tomorrow;
  });

  const panel = document.getElementById('planning-attention');
  panel.style.display = blocked.length || upcoming.length ? 'grid' : 'none';

  document.getElementById('attention-blocked-list').innerHTML = blocked.length
    ? blocked.map((j) => `<div class="attention-row"><span class="attention-main">${escapeHtml(j.high_level_concept)}</span><br><span class="attention-sub">${escapeHtml(j.blocker_reason || '')}</span></div>`).join('')
    : '<div class="attention-empty">No blocked jobs</div>';

  document.getElementById('attention-upcoming-list').innerHTML = upcoming.length
    ? upcoming.map((j) => `<div class="attention-row"><span class="attention-main">${escapeHtml(j.high_level_concept)}</span> — ${formatDate(j.production_date)}<br><span class="attention-sub">${j.readiness.ready ? 'Ready' : 'Not yet ready'}</span></div>`).join('')
    : '<div class="attention-empty">Nothing scheduled today or tomorrow</div>';
}

function dropCardHtml(d) {
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
      <div class="drop-card-pct">${d.summary.totalCovered} / ${d.summary.totalTarget} creatives${d.summary.overallPct !== null ? ' — ' + d.summary.overallPct + '%' : ''}</div>
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

// Coverage cards here are compact and purely navigational -- click one to
// open its Product view (per-colour breakdown + existing concepts).
function renderCoverageGrid(coverage) {
  const grid = document.getElementById('coverage-grid');
  if (!coverage.length) {
    grid.innerHTML = '<div class="attention-empty">No styles assigned to this drop yet — assign styles to it from Styles &amp; Categories.</div>';
    return;
  }
  grid.innerHTML = coverage.map((c) => {
    const images = c.images.length
      ? c.images.slice(0, 4).map((url) => `<img src="${url}" alt="">`).join('')
      : '<span class="coverage-card-noimg">🖼</span>';
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
      </div>
    </div>`;
  }).join('');
  grid.querySelectorAll('.coverage-card').forEach((card) => {
    card.addEventListener('click', () => {
      window.location.hash = `#planning/drop/${state.currentDropId}/product/${encodeURIComponent(card.dataset.productCode)}`;
    });
  });
}

function checklistLine(label, resolved, statusText, notes) {
  const icon = resolved ? '<span class="ok">✓</span>' : '<span class="warn">⚠</span>';
  const detail = notes ? `${statusText} — ${notes}` : statusText;
  return `<div>${icon} ${label}: ${escapeHtml(detail)}</div>`;
}

function renderJobsGrid() {
  const grid = document.getElementById('jobs-grid');
  if (!state.jobs.length) {
    grid.innerHTML = '<div class="attention-empty">No creative jobs yet. Plan one from a drop\'s coverage gap, or create one directly.</div>';
    return;
  }
  grid.innerHTML = state.jobs.map((j) => {
    const products = j.products.map((p) => p.style_code).join(', ') || 'No product linked';
    return `
    <div class="job-card" data-job-id="${j.id}">
      <div class="job-card-concept">${escapeHtml(j.high_level_concept)}</div>
      <div class="job-card-products">${escapeHtml(products)} · ${CONCEPT_TYPE_LABELS[j.concept_type]}</div>
      <div class="job-card-meta">
        <span>Owner: ${escapeHtml(j.owner || '—')}</span>
        <span>Production: ${formatDate(j.production_date) || '—'}</span>
        <span>Expected output: ${j.expected_ad_variations ?? '—'} ad variations</span>
      </div>
      <div class="job-checklist">
        ${checklistLine('Stock', STOCK_RESOLVED.includes(j.stock_status), j.stock_status.replace(/_/g, ' '), j.stock_notes)}
        ${checklistLine('Talent', TALENT_RESOLVED.includes(j.talent_status), j.talent_status.replace(/_/g, ' '), j.talent_assignee)}
        ${checklistLine('Location', LOCATION_RESOLVED.includes(j.location_status), j.location_status.replace(/_/g, ' '), j.location_notes)}
        ${checklistLine('Props', PROPS_RESOLVED.includes(j.props_status), j.props_status.replace(/_/g, ' '), j.props_notes)}
      </div>
      <div class="job-status-row">
        <span class="job-status-pill ${j.planning_status}">${PLANNING_STATUS_LABELS[j.planning_status]}</span>
      </div>
      ${j.blocker_reason ? `<div class="job-blocker-line">Blocker: ${escapeHtml(j.blocker_reason)}</div>` : ''}
    </div>`;
  }).join('');
  grid.querySelectorAll('.job-card').forEach((card) => {
    card.addEventListener('click', () => openJobModal(state.jobs.find((j) => j.id === Number(card.dataset.jobId))));
  });
}

function populateJobDropSelect() {
  const sel = document.getElementById('job-drop-id');
  sel.innerHTML = '<option value="">— none —</option>' + state.drops.map((d) => `<option value="${d.id}">${escapeHtml(d.name || 'Untitled')}</option>`).join('');
}

function populateJobStyleSelect(selectedIds = []) {
  const sel = document.getElementById('job-style-ids');
  sel.innerHTML = state.styles.map((s) => `<option value="${s.id}" ${selectedIds.includes(s.id) ? 'selected' : ''}>${s.style_code} — ${escapeHtml(s.name)}</option>`).join('');
}

let jobModalJob = null;

function openJobModal(job = null, preset = {}) {
  jobModalJob = job;
  document.getElementById('job-modal-title').textContent = job ? 'Edit Creative Job' : 'New Creative Job';
  document.getElementById('job-id').value = job ? job.id : '';
  populateJobStyleSelect(job ? job.products.map((p) => p.style_id) : preset.styleIds || []);
  populateStockRequestStyleSelect(job);
  renderStockRequests(job ? job.stock_requests : []);
  hideAddStockRequestRow();
  document.getElementById('job-drop-id').value = job ? job.drop_id || '' : preset.dropId || '';
  document.getElementById('job-concept').value = job ? job.high_level_concept : '';
  document.getElementById('job-status-quick').value = job && ['not_started', 'organising'].includes(job.planning_status) ? job.planning_status : 'not_started';
  document.getElementById('job-concept-type').value = job ? job.concept_type : 'other';
  document.getElementById('job-expected-variations').value = job && job.expected_ad_variations != null ? job.expected_ad_variations : '';
  document.getElementById('job-deliverables').value = (job && job.expected_deliverables) || '';
  document.getElementById('job-owner').value = (job && job.owner) || '';
  document.getElementById('job-production-date').value = job && job.production_date ? job.production_date.slice(0, 10) : '';
  document.getElementById('job-production-session').value = (job && job.production_session) || '';
  document.getElementById('job-ship-by-date').value = job && job.ship_by_date ? job.ship_by_date.slice(0, 10) : '';
  document.getElementById('job-stock-status').value = job ? job.stock_status : 'not_required';
  document.getElementById('job-stock-notes').value = (job && job.stock_notes) || '';
  document.getElementById('job-talent-status').value = job ? job.talent_status : 'not_required';
  document.getElementById('job-talent-assignee').value = (job && job.talent_assignee) || '';
  document.getElementById('job-location-status').value = job ? job.location_status : 'not_required';
  document.getElementById('job-location-notes').value = (job && job.location_notes) || '';
  document.getElementById('job-props-status').value = job ? job.props_status : 'not_required';
  document.getElementById('job-props-notes').value = (job && job.props_notes) || '';
  document.getElementById('job-equipment').value = job && job.equipment_needed ? job.equipment_needed.join(', ') : '';
  document.getElementById('job-logistics-notes').value = (job && job.logistics_notes) || '';
  document.getElementById('job-is-blocked').checked = Boolean(job && job.blocker_reason);
  document.getElementById('job-blocker-reason').value = (job && job.blocker_reason) || '';
  document.getElementById('job-blocker-owner').value = (job && job.blocker_owner) || '';
  document.getElementById('job-blocker-resolution').value = job && job.blocker_expected_resolution ? job.blocker_expected_resolution.slice(0, 10) : '';
  document.getElementById('job-delete-btn').style.display = job ? 'inline-block' : 'none';

  applyJobReadiness(job);

  openModal('job-modal');
}

function applyJobReadiness(job) {
  const readyBtn = document.getElementById('job-ready-btn');
  const note = document.getElementById('job-readiness-note');
  if (job && job.planning_status !== 'ready_for_briefing') {
    readyBtn.style.display = job.readiness.ready ? 'inline-block' : 'none';
    const failed = Object.entries(job.readiness.checks).filter(([, v]) => !v).map(([k]) => k.replace(/_/g, ' '));
    note.textContent = job.readiness.ready ? '' : `Not ready for Briefing yet — unresolved: ${failed.join(', ')}`;
  } else {
    readyBtn.style.display = 'none';
    note.textContent = job && job.planning_status === 'ready_for_briefing' ? '✓ Ready for Briefing' : '';
  }
}

function populateStockRequestStyleSelect(job) {
  const sel = document.getElementById('stock-request-style');
  const products = job ? job.products : [];
  sel.innerHTML = products.map((p) => `<option value="${p.style_id}">${p.style_code} — ${escapeHtml(p.name)}</option>`).join('');
}

function renderStockRequests(requests = []) {
  const list = document.getElementById('job-stock-requests-list');
  if (!requests.length) {
    list.innerHTML = '<div class="stock-request-empty">No stock needs added yet.</div>';
    return;
  }
  list.innerHTML = requests.map((r) => `
    <div class="stock-request-row ${r.status === 'pulled' ? 'is-pulled' : ''}">
      <label class="checkbox-label">
        <input type="checkbox" ${r.status === 'pulled' ? 'checked' : ''} onchange="toggleStockRequestPulled(${r.id}, this.checked)">
      </label>
      <span class="stock-request-desc">${escapeHtml(r.style_code)} · ${escapeHtml(r.size)} × ${r.quantity}${r.notes ? ` — ${escapeHtml(r.notes)}` : ''}</span>
      <button type="button" class="stock-request-remove" onclick="deleteStockRequest(${r.id})" title="Remove">&times;</button>
    </div>
  `).join('');
}

function showAddStockRequestRow() {
  if (!jobModalJob) return toast('Save the job first before adding stock needs', true);
  if (!jobModalJob.products.length) return toast('Add at least one product to this job first', true);
  document.getElementById('job-stock-request-form').style.display = 'flex';
}

function hideAddStockRequestRow() {
  const form = document.getElementById('job-stock-request-form');
  if (form) form.style.display = 'none';
}

function applyStockRequestUpdate(updated) {
  jobModalJob = updated;
  renderStockRequests(updated.stock_requests);
  document.getElementById('job-stock-status').value = updated.stock_status;
  applyJobReadiness(updated);
  const idx = state.jobs.findIndex((j) => j.id === updated.id);
  if (idx !== -1) state.jobs[idx] = updated;
  renderJobsGrid();
}

async function addStockRequest() {
  const jobId = jobModalJob.id;
  const styleId = Number(document.getElementById('stock-request-style').value);
  const size = document.getElementById('stock-request-size').value;
  const quantity = Number(document.getElementById('stock-request-qty').value) || 1;
  const notes = document.getElementById('stock-request-notes').value || null;
  if (!styleId) return toast('Add at least one product to this job first', true);
  try {
    const updated = await api(`/creative-jobs/${jobId}/stock-requests`, {
      method: 'POST',
      body: JSON.stringify({ style_id: styleId, size, quantity, notes }),
    });
    applyStockRequestUpdate(updated);
    document.getElementById('stock-request-notes').value = '';
    document.getElementById('stock-request-qty').value = '1';
    hideAddStockRequestRow();
    toast('Stock need added');
  } catch (e) {
    toast(e.message, true);
  }
}

async function toggleStockRequestPulled(reqId, checked) {
  const jobId = jobModalJob.id;
  try {
    const updated = await api(`/creative-jobs/${jobId}/stock-requests/${reqId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: checked ? 'pulled' : 'needed' }),
    });
    applyStockRequestUpdate(updated);
  } catch (e) {
    toast(e.message, true);
  }
}

async function deleteStockRequest(reqId) {
  const jobId = jobModalJob.id;
  try {
    const updated = await api(`/creative-jobs/${jobId}/stock-requests/${reqId}`, { method: 'DELETE' });
    applyStockRequestUpdate(updated);
  } catch (e) {
    toast(e.message, true);
  }
}

async function saveJob() {
  const id = document.getElementById('job-id').value;
  const styleIds = Array.from(document.getElementById('job-style-ids').selectedOptions).map((o) => Number(o.value));
  const equipment = document.getElementById('job-equipment').value.split(',').map((s) => s.trim()).filter(Boolean);
  const payload = {
    drop_id: document.getElementById('job-drop-id').value || null,
    style_ids: styleIds,
    high_level_concept: document.getElementById('job-concept').value,
    concept_type: document.getElementById('job-concept-type').value,
    expected_ad_variations: document.getElementById('job-expected-variations').value || null,
    expected_deliverables: document.getElementById('job-deliverables').value || null,
    owner: document.getElementById('job-owner').value || null,
    production_date: document.getElementById('job-production-date').value || null,
    production_session: document.getElementById('job-production-session').value || null,
    ship_by_date: document.getElementById('job-ship-by-date').value || null,
    stock_status: document.getElementById('job-stock-status').value,
    stock_notes: document.getElementById('job-stock-notes').value || null,
    talent_status: document.getElementById('job-talent-status').value,
    talent_assignee: document.getElementById('job-talent-assignee').value || null,
    location_status: document.getElementById('job-location-status').value,
    location_notes: document.getElementById('job-location-notes').value || null,
    props_status: document.getElementById('job-props-status').value,
    props_notes: document.getElementById('job-props-notes').value || null,
    equipment_needed: equipment,
    logistics_notes: document.getElementById('job-logistics-notes').value || null,
  };
  if (!payload.high_level_concept.trim()) return toast('High-level concept is required', true);

  try {
    let jobId = id;
    if (id) {
      await api(`/creative-jobs/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      const created = await api('/creative-jobs', { method: 'POST', body: JSON.stringify(payload) });
      jobId = created.id;
    }
    const quickStatus = document.getElementById('job-status-quick').value;
    const current = state.jobs.find((j) => j.id === Number(jobId));
    if (!current || (current.planning_status !== quickStatus && ['not_started', 'organising'].includes(current.planning_status || 'not_started'))) {
      await api(`/creative-jobs/${jobId}/status`, { method: 'PATCH', body: JSON.stringify({ status: quickStatus }) }).catch(() => {});
    }
    closeModal('job-modal');
    toast('Creative job saved');
    loadAll();
  } catch (e) {
    toast(e.message, true);
  }
}

async function saveJobBlocker() {
  const id = document.getElementById('job-id').value;
  if (!id) return toast('Save the job first before setting a blocker', true);
  const isBlocked = document.getElementById('job-is-blocked').checked;
  const payload = {
    blocker_reason: isBlocked ? document.getElementById('job-blocker-reason').value : null,
    blocker_owner: isBlocked ? document.getElementById('job-blocker-owner').value : null,
    blocker_expected_resolution: isBlocked ? document.getElementById('job-blocker-resolution').value || null : null,
  };
  if (isBlocked && !payload.blocker_reason.trim()) return toast('Blocker reason is required', true);
  try {
    await api(`/creative-jobs/${id}/blocker`, { method: 'PATCH', body: JSON.stringify(payload) });
    closeModal('job-modal');
    toast('Blocker updated');
    loadAll();
  } catch (e) {
    toast(e.message, true);
  }
}

async function markJobReadyForBriefing() {
  const id = document.getElementById('job-id').value;
  try {
    await api(`/creative-jobs/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'ready_for_briefing' }) });
    closeModal('job-modal');
    toast('Marked Ready for Briefing');
    loadAll();
  } catch (e) {
    toast(e.message, true);
  }
}

async function deleteJob() {
  const id = document.getElementById('job-id').value;
  if (!id) return;
  if (!confirm('Delete this creative job? This cannot be undone.')) return;
  try {
    await api(`/creative-jobs/${id}`, { method: 'DELETE' });
    closeModal('job-modal');
    toast('Creative job deleted');
    loadAll();
  } catch (e) {
    toast(e.message, true);
  }
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
    document.getElementById('product-view-overview').innerHTML = group.soh !== null ? `
      <div class="coverage-card-ratio">${group.current_coverage} / ${group.creative_target} creatives</div>
      <div class="coverage-progress-track"><div class="coverage-progress-fill ${group.status}" style="width:${pct}%;"></div></div>
      <div class="coverage-card-gap ${group.status}">${coverageGapLabel(group)}</div>
    ` : '<div class="coverage-card-unavailable">Stock unavailable</div>';

    const planBtn = document.getElementById('product-view-plan-btn');
    planBtn.style.display = group.creative_gap > 0 || group.creative_gap === null ? 'inline-block' : 'none';
    planBtn.onclick = () => openJobModal(null, { styleIds: group.styles.map((s) => s.style_id), dropId });

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
    const statusIcon = fulfilled
      ? '<span class="pw-slot-status fulfilled">✓</span>'
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
// saveJob, etc.), and keeps the "Required Concept #N" badge on the linked
// asset's Existing Concepts card in sync too.
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
  if (!confirm('Remove this concept slot? This only works for manually-added New/Test slots with no linked asset.')) return;
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

document.getElementById('new-job-btn').addEventListener('click', () => openJobModal(null));
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
  // Quickpicks/auto-style-population are a create-time convenience only --
  // editing an existing drop doesn't re-cluster ApparelMagic styles.
  document.getElementById('drop-date-quickpicks').style.display = drop ? 'none' : 'flex';
  if (!drop) renderDropQuickpicks(null);
  openModal('drop-modal');
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
  if (!confirm('Delete this creative asset? This cannot be undone.')) return;
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
  if (!confirm('Delete this Proven Winner? Concepts already used in drop plans keep their name/history and are not affected.')) return;
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

checkSession();
