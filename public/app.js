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

let state = { styles: [], categories: [], board: null, dashboard: null };
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
    const [board, styles, categories, dashboard] = await Promise.all([
      api('/board'),
      api('/styles'),
      api('/categories'),
      api(`/dashboard?weekOffset=${dashboardWeekOffset}`),
    ]);
    state.board = board;
    state.styles = styles;
    state.categories = categories;
    state.dashboard = dashboard;
    renderBoard();
    renderMissingAd();
    renderStylesTable();
    renderCategoriesTable();
    populateStyleSelect();
    populateCategorySelect();
    renderDashboard();
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

// ── Styles/categories tables ─────────────────────────
function renderStylesTable() {
  const tbody = document.querySelector('#styles-table tbody');
  tbody.innerHTML = state.styles
    .map(
      (s) => `
      <tr>
        <td>${s.style_code}</td>
        <td>${escapeHtml(s.name)}</td>
        <td><span class="badge badge-tier-${s.tier}">${TIER_LABELS[s.tier]}</span></td>
        <td>${s.category_name || '—'}</td>
        <td>${s.creative_asset_count}</td>
        <td>${s.missing_ad ? '<span class="badge" style="background:var(--amber-light);color:var(--amber);">Missing Ad</span>' : ''}</td>
      </tr>`
    )
    .join('');
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

function populateStyleSelect() {
  const sel = document.getElementById('asset-style-id');
  sel.innerHTML = state.styles.map((s) => `<option value="${s.id}">${s.style_code} — ${escapeHtml(s.name)}</option>`).join('');
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
document.getElementById('new-style-btn').addEventListener('click', () => {
  document.getElementById('style-code').value = '';
  document.getElementById('style-name').value = '';
  document.getElementById('style-tier').value = 'core_proven';
  document.getElementById('style-category-id').value = '';
  openModal('style-modal');
});
document.getElementById('new-category-btn').addEventListener('click', () => {
  document.getElementById('category-name').value = '';
  document.getElementById('category-campaign-id').value = '';
  document.getElementById('category-adset-id').value = '';
  document.getElementById('category-notes').value = '';
  openModal('category-modal');
});

function openAssetModal(card) {
  document.getElementById('asset-modal-title').textContent = card ? 'Edit Creative Asset' : 'New Creative Asset';
  document.getElementById('asset-id').value = card ? card.id : '';
  document.getElementById('asset-style-id').value = card ? card.style_id : (state.styles[0] ? state.styles[0].id : '');
  document.getElementById('asset-concept-name').value = card ? card.concept_name : '';
  document.getElementById('asset-format').value = card ? card.format : 'video';
  document.getElementById('asset-classification').value = card ? card.concept_classification : 'new_experimental';
  document.getElementById('asset-deliberate-trial').checked = card ? !!card.is_deliberate_trial : false;
  document.getElementById('asset-target-date').value = card && card.target_date ? card.target_date.slice(0, 10) : '';
  document.getElementById('asset-strategy-owner').value = (card && card.strategy_owner) || '';
  document.getElementById('asset-filming-owner').value = (card && card.filming_owner) || '';
  document.getElementById('asset-editing-owner').value = (card && card.editing_owner) || '';
  document.getElementById('asset-qc-owner').value = (card && card.qc_owner) || '';
  document.getElementById('asset-delete-btn').style.display = card ? 'inline-block' : 'none';
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
  } catch (e) {
    toast(e.message, true);
  }
}

async function saveStyle() {
  const payload = {
    style_code: document.getElementById('style-code').value,
    name: document.getElementById('style-name').value,
    tier: document.getElementById('style-tier').value,
    category_id: document.getElementById('style-category-id').value || null,
  };
  if (!payload.style_code.trim() || !payload.name.trim()) return toast('Style code and name are required', true);
  try {
    await api('/styles', { method: 'POST', body: JSON.stringify(payload) });
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

checkSession();
