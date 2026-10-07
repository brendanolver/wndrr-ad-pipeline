// Creative-level activity ("Last active") and the Pre-2026 archive.
//
// Everything here is keyed on the EXACT creative identity: a "unit" is meta_creative_id (an ad without one is its own unit).
// No name similarity of any kind. Nothing is deleted or rewritten: the archive is a computed state, not a data change.
//
// The rule (business): a unique creative that provably has NOT delivered at any point since ARCHIVE_CUTOFF does not need a
// person to classify it. "Provably" is the whole point -- the absence of a stored 2026 Insights row is NOT proof, because the
// stored history may simply not reach back that far. So a creative is archived only when ALL of these hold:
//   1. PROOF OF COVERAGE  our evidence of "who delivered" spans the whole period [cutoff .. recently]:
//        a. local: successful Insights syncs cover every day from <= cutoff up to within PROOF_MAX_STALE_DAYS of today, or
//        b. a completed explicit Meta activity pull (meta_activity_pulls) whose period starts <= cutoff, extended by any local
//           syncs that follow it, reaching within PROOF_MAX_STALE_DAYS of today.
//   2. NO ad of the creative is ACTIVE now;
//   3. EVERY ad of the creative has a known created_time before the cutoff (an ad created in 2026, or with an unknown
//      creation date, keeps the creative);
//   4. NO ad of the creative delivered (spend or impressions) on or after the cutoff -- in the stored Insights OR in Meta's
//      answer to the activity pull. A 2025 original with a 2026 duplicate is therefore NOT archived.
// If proof of coverage is missing, nothing is archived (arch is empty) and the screen says exactly why.
const { pool } = require('../db');
const { ymdInZone, addDays, REPORTING_TIMEZONE } = require('./metaPerformance');

const ARCHIVE_CUTOFF = '2026-01-01';
const PROOF_MAX_STALE_DAYS = 14;

// ── proof of coverage (pure) ───────────────────────────────────────────
// runs: [{ since:'YYYY-MM-DD', until:'YYYY-MM-DD' }] successful Insights syncs. Returns the contiguous block that ends latest.
function contiguousBlock(runs) {
  const rs = (runs || []).filter((r) => r && r.since && r.until && r.since <= r.until).sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0));
  if (!rs.length) return null;
  const blocks = [];
  for (const r of rs) {
    const last = blocks[blocks.length - 1];
    if (last && r.since <= addDays(last.until, 1)) { if (r.until > last.until) last.until = r.until; } else blocks.push({ since: r.since, until: r.until });
  }
  return blocks.sort((a, b) => (a.until < b.until ? -1 : 1)).pop();
}

function computeProof({ runs, pull, today, cutoff = ARCHIVE_CUTOFF, staleDays = PROOF_MAX_STALE_DAYS }) {
  const block = contiguousBlock(runs);
  const fresh = (d) => !!d && d >= addDays(today, -staleDays);
  const out = {
    cutoff, today, proven: false, basis: null, proof_from: null, proof_to: null, pull_id: null,
    local: block ? { covered_from: block.since, covered_to: block.until } : null,
    pull: pull ? { id: pull.id, since: pull.since, until: pull.until, finished_at: pull.finished_at || null, ads_with_delivery: pull.ads_with_delivery ?? null } : null,
    reason: null,
  };
  // the pull's delivery list is evidence whenever it is complete and starts at/before the cutoff
  const pullOk = !!(pull && pull.since <= cutoff);
  if (pullOk) out.pull_id = pull.id;
  if (block && block.since <= cutoff && fresh(block.until)) {
    out.proven = true; out.basis = 'local_insights'; out.proof_from = block.since; out.proof_to = block.until;
    return out;
  }
  if (pullOk) {
    let to = pull.until;
    if (block && block.since <= addDays(pull.until, 1) && block.until > to) to = block.until;
    if (fresh(to)) { out.proven = true; out.basis = 'activity_pull'; out.proof_from = pull.since; out.proof_to = to; return out; }
    out.reason = `The Meta activity check covers ${pull.since} to ${pull.until}, which is older than ${staleDays} days. Refresh Insights (or run the check again) so the proof reaches today.`;
    return out;
  }
  if (!block) out.reason = 'No Insights have been synced, and no Meta activity check has been run.';
  else if (block.since > cutoff) out.reason = `Stored Insights only reach back to ${block.since}, which is after ${cutoff}. Absence of a 2026 row before then proves nothing. Run the Meta activity check to establish activity since ${cutoff}.`;
  else out.reason = `Stored Insights end on ${block.until}, more than ${staleDays} days ago. Refresh Insights so the proof reaches today.`;
  return out;
}

async function loadProofInputs(db = pool) {
  const [runs, pull] = await Promise.all([
    db.query(`SELECT to_char(range_since, 'YYYY-MM-DD') AS since, to_char(range_until, 'YYYY-MM-DD') AS until
                FROM meta_sync_runs WHERE status = 'success' AND run_type IN ('default', 'backfill') AND finished_at IS NOT NULL`),
    db.query(`SELECT id, to_char(since_date, 'YYYY-MM-DD') AS since, to_char(until_date, 'YYYY-MM-DD') AS until, finished_at, ads_with_delivery
                FROM meta_activity_pulls WHERE state = 'completed' AND since_date <= $1::date ORDER BY id DESC LIMIT 1`, [ARCHIVE_CUTOFF]),
  ]);
  return { runs: runs.rows, pull: pull.rows[0] || null };
}

// Two tiny queries (a handful of sync-run rows and the newest completed activity check): cheap enough to read fresh on every
// request, so a new sync or a finished Meta check is reflected immediately and the proof is never stale.
async function getProof({ now = new Date(), db = pool } = {}) {
  const inputs = await loadProofInputs(db);
  return computeProof({ ...inputs, today: ymdInZone(now) });
}
function resetProofMemo() { /* kept for callers; nothing is cached any more */ }

// A proof that assumes coverage is established -- ONLY for the "what would change" preview; never used to hide work.
const ASSUMED_PROOF = { proven: true, assumed: true, basis: 'assumed_for_preview', pull_id: null, cutoff: ARCHIVE_CUTOFF };
const NO_PROOF = { proven: false, pull_id: null, cutoff: ARCHIVE_CUTOFF };

// ── SQL: per-unit activity facts + the archive set, as TEMP tables (same two statements for queue and workload) ─────────
// cfacts: one row per unit that has an outstanding (unmatched / suggested) ad -- facts over ALL ads of that exact creative.
// arch:   the units that satisfy the rule above (empty unless coverage is proven).
function setupStatements(proof) {
  const p = proof || NO_PROOF;
  const cutoff = p.cutoff || ARCHIVE_CUTOFF;
  const cutoffTs = `($1::date)::timestamp AT TIME ZONE '${REPORTING_TIMEZONE}'`;
  return [
    [`CREATE TEMP TABLE cfacts (unit varchar(64) PRIMARY KEY, ads_total int, ads_active int, first_created timestamptz, created_unknown int,
        created_since_cutoff int, last_delivery date, pulled_delivery boolean) ON COMMIT DROP`],
    [`INSERT INTO cfacts
      SELECT u.unit, count(*)::int, count(*) FILTER (WHERE m.effective_status = 'ACTIVE')::int, min(m.created_time),
             count(*) FILTER (WHERE m.created_time IS NULL)::int, count(*) FILTER (WHERE m.created_time >= ${cutoffTs})::int,
             max(dl.last_delivery), COALESCE(bool_or(pd.meta_ad_id IS NOT NULL), false)
        FROM (SELECT DISTINCT COALESCE(meta_creative_id, meta_ad_id) AS unit FROM meta_ads WHERE match_status IN ('unmatched', 'suggested')) u
        JOIN meta_ads m ON COALESCE(m.meta_creative_id, m.meta_ad_id) = u.unit
        LEFT JOIN (SELECT meta_ad_id, max(insight_date) FILTER (WHERE spend > 0 OR impressions > 0) AS last_delivery
                     FROM meta_ad_insights_daily GROUP BY meta_ad_id) dl ON dl.meta_ad_id = m.meta_ad_id
        LEFT JOIN meta_ad_delivery_since pd ON pd.pull_id = $2::int AND pd.meta_ad_id = m.meta_ad_id
       GROUP BY u.unit`, [cutoff, p.pull_id || null]],
    ['CREATE TEMP TABLE arch (unit varchar(64) PRIMARY KEY) ON COMMIT DROP'],
    p.proven
      ? [`INSERT INTO arch SELECT unit FROM cfacts
           WHERE ads_active = 0 AND created_unknown = 0 AND created_since_cutoff = 0
             AND (last_delivery IS NULL OR last_delivery < $1::date) AND NOT pulled_delivery`, [cutoff]]
      : ['SELECT 1'],
    ['ANALYZE cfacts'],
  ];
}

// Pure mirror of the SQL rule (documentation + tests): facts for ONE unit -> archived?
function isArchived(f, proof, cutoff = ARCHIVE_CUTOFF) {
  if (!proof || !proof.proven) return false;
  if (f.ads_active > 0) return false;
  if (f.created_unknown > 0 || f.created_since_cutoff > 0) return false;
  if (f.last_delivery && f.last_delivery >= cutoff) return false;
  if (f.pulled_delivery) return false;
  return true;
}

// ── what the archive evidence looks like right now (read-only; for the admin panel and the report) ─────
async function getStatus({ now = new Date(), db = pool } = {}) {
  const today = ymdInZone(now);
  const [proof, depth, pullRows] = await Promise.all([
    getProof({ now, db }),
    db.query(`SELECT to_char(min(insight_date), 'YYYY-MM-DD') AS first_day, to_char(max(insight_date), 'YYYY-MM-DD') AS last_day, count(*)::bigint AS rows FROM meta_ad_insights_daily`),
    db.query(`SELECT id, state, to_char(since_date, 'YYYY-MM-DD') AS since, to_char(until_date, 'YYYY-MM-DD') AS until, ads_with_delivery, calls, error_message, started_at, finished_at
                FROM meta_activity_pulls ORDER BY id DESC LIMIT 3`),
  ]);
  const ads = await db.query(`SELECT count(*)::int AS ads, count(created_time)::int AS with_created, min(created_time) AS oldest_created, min(first_seen_at) AS first_seen FROM meta_ads`);
  return {
    cutoff: ARCHIVE_CUTOFF, today, proof,
    insights_depth: { first_day: depth.rows[0].first_day, last_day: depth.rows[0].last_day, rows: Number(depth.rows[0].rows) },
    ads: { total: ads.rows[0].ads, with_created_time: ads.rows[0].with_created, oldest_created: ads.rows[0].oldest_created, first_seen: ads.rows[0].first_seen },
    recent_pulls: pullRows.rows,
  };
}

module.exports = {
  ARCHIVE_CUTOFF, PROOF_MAX_STALE_DAYS, ASSUMED_PROOF, NO_PROOF,
  contiguousBlock, computeProof, loadProofInputs, getProof, resetProofMemo, setupStatements, isArchived, getStatus,
};
