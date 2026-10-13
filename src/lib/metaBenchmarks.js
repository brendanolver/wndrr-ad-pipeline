// Meta Performance benchmarks stored in Settings (table meta_performance_benchmarks): the editable targets behind the colour dots.
//
// A row stores only a TARGET for one funnel + metric + reporting window; the colour bands are always derived by the same percentage rule
// (metaFunnelHealth.percentRule): green meets the target, orange misses it by up to tolerance_pct, red by more. Nothing is inferred: a
// funnel + metric with no row has no benchmark, and a row with a window is judged only for periods inside that window.
//
// Reading is cheap and cached for a few seconds; any change clears the cache. If the table cannot be read the built-in approved defaults
// of metaFunnelHealth are used, so the dashboard never breaks. Local database only.
const { pool } = require('../db');
const health = require('./metaFunnelHealth');
const { HttpError } = require('./metaPerformance');

const FUNNELS = health.JUDGED_FUNNELS;
const METRICS = health.METRICS;
// which side of the target is better (frequency may also be given an acceptable range, see target_min)
const DIRECTION = { cpa: 'lower', roas: 'higher', outbound_ctr: 'higher', cpm: 'lower', reach: 'higher', frequency: 'lower' };
const UNIT = { cpa: '$ AUD', roas: '×', outbound_ctr: '%', cpm: '$ AUD', reach: 'people', frequency: '×' };
const CACHE_MS = 5000;
let cache = null;

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const intOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
};

function publicRow(r) {
  return {
    id: r.id, funnel: r.funnel, metric: r.metric, min_days: r.min_days, max_days: r.max_days, target: num(r.target), target_min: num(r.target_min), inclusive: !!r.inclusive,
    tolerance_pct: num(r.tolerance_pct), active: !!r.active, note: r.note || null, direction: DIRECTION[r.metric], unit: UNIT[r.metric],
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null, updated_by_user_id: r.updated_by_user_id || null,
  };
}

// one stored row -> the rule object metaFunnelHealth.classify understands
function ruleOf(row) {
  const min = num(row.target_min);
  // Frequency with a lower bound is an acceptable RANGE [target_min, target]; every other benchmark is one target with a good side
  const rule = row.metric === 'frequency' && min !== null
    ? health.rangeRule({ min, max: Number(row.target), inclusive: !!row.inclusive, pct: Number(row.tolerance_pct) })
    : health.percentRule({ direction: DIRECTION[row.metric], target: Number(row.target), inclusive: !!row.inclusive, pct: Number(row.tolerance_pct) });
  rule.window = (row.min_days || row.max_days) ? { min_days: row.min_days || null, max_days: row.max_days || null } : null;
  return rule;
}

// rows -> { rules, coded } in the shape classify() / status() take. Only ACTIVE rows count; a metric with an active row is colour-coded.
function compile(rows) {
  const rules = {}; const coded = {};
  FUNNELS.forEach((f) => { rules[f] = {}; coded[f] = []; });
  for (const row of rows) {
    if (!row.active || !FUNNELS.includes(row.funnel) || !METRICS.includes(row.metric)) continue;
    let rule;
    try { rule = ruleOf(row); } catch (e) { continue; } // a malformed row is skipped, never guessed
    (rules[row.funnel][row.metric] = rules[row.funnel][row.metric] || []).push(rule);
    if (!coded[row.funnel].includes(row.metric)) coded[row.funnel].push(row.metric);
  }
  return { rules, coded };
}

async function listRows(db = pool) {
  return (await db.query('SELECT * FROM meta_performance_benchmarks ORDER BY funnel, metric, COALESCE(min_days, 0), COALESCE(max_days, 0), id')).rows;
}

// The rules in force: { rules, coded, source }. 'settings' = read from the table; 'default' = the built-in approved rules (table unreadable).
async function getEffective({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value;
  try {
    const rows = await listRows();
    value = { ...compile(rows), source: 'settings', rows: rows.length };
  } catch (e) {
    value = { rules: health.effectiveRules(), coded: health.COLOUR_CODED, source: 'default', rows: 0, error: e.message };
  }
  cache = { at: Date.now(), value };
  return value;
}
const clearCache = () => { cache = null; };

// ── validation ────────────────────────────────────────────────────────────
function cleanInput(body, { partial = false } = {}) {
  const b = body || {};
  const out = {};
  if (!partial || b.funnel !== undefined) {
    const f = String(b.funnel || '').toUpperCase();
    if (!FUNNELS.includes(f)) throw new HttpError(400, 'Funnel must be TOF, TOM or MOF');
    out.funnel = f;
  }
  if (!partial || b.metric !== undefined) {
    const m = String(b.metric || '').toLowerCase();
    if (!METRICS.includes(m)) throw new HttpError(400, 'Metric must be CPA, ROAS, Outbound CTR, CPM, Reach or Frequency');
    out.metric = m;
  }
  if (!partial || b.target !== undefined) {
    const t = num(b.target);
    // a target of 0 would colour every ad red (lower is better) or green (higher is better), which is never what is meant: a benchmark is optional, so leave the measure unset instead
    if (t === null || !Number.isFinite(t) || t <= 0 || t > 1e9) throw new HttpError(400, 'Enter a target above 0, or leave this measure unset (a benchmark is optional)');
    out.target = t;
  }
  if (b.target_min !== undefined) {
    const lo = num(b.target_min);
    if (lo !== null) {
      if (!Number.isFinite(lo) || lo < 0 || lo > 1e9) throw new HttpError(400, 'The lowest acceptable value must be 0 or more');
      if ((out.metric || String(b.metric || '').toLowerCase()) !== 'frequency' && b.metric !== undefined) throw new HttpError(400, 'An acceptable range is only available for Frequency');
      if (out.target !== undefined && lo > out.target) throw new HttpError(400, 'The lowest acceptable value cannot be above the highest');
    }
    out.target_min = lo;
  }
  if (!partial || b.min_days !== undefined || b.max_days !== undefined) {
    const lo = intOrNull(b.min_days); const hi = intOrNull(b.max_days);
    if (Number.isNaN(lo) || Number.isNaN(hi) || (lo !== null && (lo < 1 || lo > 3650)) || (hi !== null && (hi < 1 || hi > 3650))) throw new HttpError(400, 'Reporting window days must be whole numbers of 1 or more');
    if (lo !== null && hi !== null && lo > hi) throw new HttpError(400, 'The window’s first day count cannot be larger than its last');
    out.min_days = lo; out.max_days = hi;
  }
  if (!partial || b.inclusive !== undefined) out.inclusive = b.inclusive === undefined ? true : !!b.inclusive;
  if (!partial || b.tolerance_pct !== undefined) {
    const tol = b.tolerance_pct === undefined || b.tolerance_pct === null || b.tolerance_pct === '' ? 20 : Number(b.tolerance_pct);
    if (!Number.isFinite(tol) || tol < 0 || tol > 100) throw new HttpError(400, 'Tolerance must be between 0 and 100 percent');
    out.tolerance_pct = tol;
  }
  if (b.active !== undefined) out.active = !!b.active;
  if (b.note !== undefined) out.note = b.note === null ? null : String(b.note).slice(0, 500);
  return out;
}

async function record(client, id, action, before, after, userId) {
  await client.query('INSERT INTO meta_performance_benchmark_history (benchmark_id, action, before_value, after_value, user_id) VALUES ($1,$2,$3,$4,$5)',
    [id, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, userId || null]);
}

async function create(body, userId) {
  const v = cleanInput(body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO meta_performance_benchmarks (funnel, metric, min_days, max_days, target, target_min, inclusive, tolerance_pct, active, note, created_by_user_id, updated_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$11,$6,$7,$8,$9,$10,$10) RETURNING *`,
      [v.funnel, v.metric, v.min_days, v.max_days, v.target, v.inclusive, v.tolerance_pct, v.active === undefined ? true : v.active, v.note || null, userId || null, v.target_min === undefined ? null : v.target_min]
    );
    await record(client, r.rows[0].id, 'create', null, r.rows[0], userId);
    await client.query('COMMIT');
    clearCache();
    return publicRow(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') throw new HttpError(409, 'A benchmark for that funnel, metric and reporting window already exists — edit it instead');
    throw err;
  } finally { client.release(); }
}

async function update(id, body, userId) {
  const v = cleanInput(body, { partial: true });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query('SELECT * FROM meta_performance_benchmarks WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'Benchmark not found');
    const next = { ...cur, ...v };
    if (num(next.target_min) !== null && (next.metric !== 'frequency' || num(next.target_min) > Number(next.target))) throw new HttpError(400, next.metric !== 'frequency' ? 'An acceptable range is only available for Frequency' : 'The lowest acceptable value cannot be above the highest');
    if (next.min_days !== null && next.max_days !== null && next.min_days > next.max_days) throw new HttpError(400, 'The window’s first day count cannot be larger than its last');
    const r = await client.query(
      `UPDATE meta_performance_benchmarks SET funnel=$2, metric=$3, min_days=$4, max_days=$5, target=$6, inclusive=$7, tolerance_pct=$8, active=$9, note=$10, updated_by_user_id=$11, target_min=$12, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [id, next.funnel, next.metric, next.min_days, next.max_days, next.target, next.inclusive, next.tolerance_pct, next.active, next.note, userId || null, num(next.target_min)]
    );
    await record(client, id, 'update', cur, r.rows[0], userId);
    await client.query('COMMIT');
    clearCache();
    return publicRow(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') throw new HttpError(409, 'A benchmark for that funnel, metric and reporting window already exists');
    throw err;
  } finally { client.release(); }
}

async function remove(id, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query('SELECT * FROM meta_performance_benchmarks WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'Benchmark not found');
    await client.query('DELETE FROM meta_performance_benchmarks WHERE id = $1', [id]);
    await record(client, id, 'delete', cur, null, userId);
    await client.query('COMMIT');
    clearCache();
    return { id, deleted: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

// The Settings view: every configured row, the funnel x metric grid (with the plain-language state of each cell) and the recent history.
async function getSettings() {
  const rows = await listRows();
  const eff = { ...compile(rows), source: 'settings' };
  const st = health.status({ rules: eff.rules, coded: eff.coded, source: 'settings' });
  const hist = (await pool.query(
    `SELECT h.id, h.benchmark_id, h.action, h.before_value, h.after_value, h.at, u.name AS user_name
       FROM meta_performance_benchmark_history h LEFT JOIN users u ON u.id = h.user_id ORDER BY h.id DESC LIMIT 25`
  )).rows;
  return {
    funnels: FUNNELS, metrics: METRICS.map((m) => ({ key: m, label: health.METRIC_LABEL[m], direction: DIRECTION[m], unit: UNIT[m] })),
    tolerance_default: health.TOLERANCE_PCT,
    benchmarks: rows.map(publicRow),
    cells: Object.fromEntries(FUNNELS.map((f) => [f, Object.fromEntries(METRICS.map((m) => [m, st.matrix[f][m]]))])),
    history: hist.map((h) => ({ id: h.id, benchmark_id: h.benchmark_id, action: h.action, before: h.before_value, after: h.after_value, at: new Date(h.at).toISOString(), user: h.user_name || null })),
    note: 'CPA is Meta-reported (Triple Whale is not connected). A benchmark with a reporting window is judged only for periods inside that window and is never scaled to another length.',
  };
}

module.exports = { FUNNELS, METRICS, DIRECTION, compile, ruleOf, listRows, getEffective, clearCache, cleanInput, create, update, remove, getSettings, publicRow };
