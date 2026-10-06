// Ad Matching V4 -- the matching-only product catalogue.
//
// The matcher used to compare Meta product phrases against the local `styles`
// table only (a few hundred product codes). ApparelMagic holds the full
// historical catalogue. This module turns the ApparelMagic catalogue (already
// crawled and cached by apparelmagic.getStyleCatalogue) plus local-only styles
// into FAMILIES (one per 8-character product code), fingerprints them, and
// persists them as an immutable SNAPSHOT that the matcher reads.
//
//   * No snapshot active  -> the matcher uses local styles exactly as V3 did
//                            (effective rules version 3).
//   * A snapshot active   -> the matcher uses the snapshot (effective rules
//                            version 4). Activation is an explicit admin step.
//   * Refresh is MANUAL: nothing here runs on boot, on sync or on a timer.
//   * Matching never calls ApparelMagic: only the explicit build / preview /
//     activate actions read the (already cached) AM catalogue, and they refuse
//     rather than block on a cold cache.
//
// One entry per product CODE is kept even when two codes share a name: such
// same-name entries tie in the matcher and stay in Needs Review (no tie-break).
const crypto = require('crypto');
const { pool } = require('../db');
const { HttpError } = require('./metaPerformance');
const apparelmagic = require('./apparelmagic');
const { listProductFamilies } = require('./metaProductMapping');

// Modern WNDRR style codes (any season letter): letter + 2-digit year + 2-letter
// collection + 3-digit number + 3-letter colour. Product code = first 8 chars.
// Anything else in AM (shipping protection add-ons, odd legacy SKUs) is excluded
// and reported, never silently matched.
const STYLE_CODE_RE = /^[A-Z]\d{2}[A-Z]{2}\d{3}[A-Z]{3}$/;

// Validation thresholds for a snapshot build.
const MIN_FAMILIES = 200; // below this the AM crawl is treated as incomplete
const MIN_RATIO_OF_PREVIOUS = 0.8; // an AM family count below 80% of the previous snapshot's looks truncated
const MAX_UNNAMED_RATIO = 0.05;

class CatalogueError extends HttpError {
  constructor(code, message, status = 409) {
    super(status, message);
    this.code = code;
  }
}

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

// ── pure: build a catalogue from the AM style map + local style rows ────
// amCatalogue: Map(style_code -> { productName, ... }) | null
// localStyles: [{ style_code, name }]
function buildCatalogue({ amCatalogue, localStyles = [] }) {
  const stats = {
    am_style_rows: 0, am_style_rows_excluded: 0, am_excluded_examples: [], am_unnamed_rows: 0,
    am_families: 0, local_families: 0, local_only_families: 0, am_only_families: 0,
    duplicate_name_groups: 0, duplicate_name_codes: 0, families_by_season: {},
  };
  const amGroups = new Map(); // code8 -> { names: Map(name->n), colourways }
  if (amCatalogue) {
    for (const [style, d] of amCatalogue.entries()) {
      stats.am_style_rows += 1;
      const code = String(style || '').toUpperCase().trim();
      if (!STYLE_CODE_RE.test(code)) {
        stats.am_style_rows_excluded += 1;
        if (stats.am_excluded_examples.length < 8) stats.am_excluded_examples.push(`${code} — ${(d && d.productName) || ''}`);
        continue;
      }
      const name = String((d && d.productName) || '').trim();
      if (!name) { stats.am_unnamed_rows += 1; continue; }
      const key = code.slice(0, 8);
      if (!amGroups.has(key)) amGroups.set(key, { names: new Map(), colourways: 0 });
      const g = amGroups.get(key);
      g.colourways += 1;
      g.names.set(name, (g.names.get(name) || 0) + 1);
    }
  }
  const families = new Map(); // code -> { product_code, product_name, colourways, source }
  amGroups.forEach((g, code) => {
    // the most common name across the colourways (ties -> alphabetical, so the result is deterministic)
    const name = [...g.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    families.set(code, { product_code: code, product_name: name, colourways: g.colourways, source: 'apparelmagic' });
  });
  stats.am_families = families.size;

  // local styles: same grouping the app already uses (first style name per product code)
  const localByCode = new Map();
  [...localStyles].sort((a, b) => String(a.style_code).localeCompare(String(b.style_code))).forEach((r) => {
    const code = apparelmagic.deriveProductCode(r.style_code);
    if (!localByCode.has(code)) localByCode.set(code, { name: r.name, colourways: 0 });
    localByCode.get(code).colourways += 1;
  });
  stats.local_families = localByCode.size;
  localByCode.forEach((l, code) => {
    if (families.has(code)) return; // ApparelMagic's name wins for a code in both
    families.set(code, { product_code: code, product_name: String(l.name || code).trim(), colourways: l.colourways, source: 'local' });
    stats.local_only_families += 1;
  });
  stats.am_only_families = [...families.values()].filter((f) => f.source === 'apparelmagic' && !localByCode.has(f.product_code)).length;

  const list = [...families.values()].sort((a, b) => a.product_code.localeCompare(b.product_code));
  const byName = new Map();
  list.forEach((f) => {
    const k = norm(f.product_name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(f.product_code);
    const y = /^[A-Z](\d{2})/.exec(f.product_code);
    const season = y ? `20${y[1]}` : 'other';
    stats.families_by_season[season] = (stats.families_by_season[season] || 0) + 1;
  });
  byName.forEach((codes) => { if (codes.length > 1) { stats.duplicate_name_groups += 1; stats.duplicate_name_codes += codes.length; } });
  stats.families_by_season = Object.fromEntries(Object.entries(stats.families_by_season).sort());
  stats.family_count = list.length;
  return { families: list, stats, fingerprint: fingerprintOf(list) };
}

// Content fingerprint: sha256 over the sorted (code, name) pairs.
function fingerprintOf(families) {
  const h = crypto.createHash('sha256');
  families.map((f) => `${f.product_code}\t${f.product_name}`).sort().forEach((line) => h.update(`${line}\n`));
  return h.digest('hex');
}

// Rejects a catalogue that looks incomplete rather than writing a partial snapshot.
function validateCatalogue(candidate, { previous = null, minFamilies = MIN_FAMILIES } = {}) {
  const problems = [];
  const s = candidate.stats;
  if (s.am_families === 0) problems.push('ApparelMagic returned no usable product families');
  if (candidate.families.length < minFamilies) problems.push(`Only ${candidate.families.length} families (minimum ${minFamilies}) — the ApparelMagic crawl looks incomplete`);
  const named = s.am_style_rows - s.am_style_rows_excluded;
  if (named > 0 && s.am_unnamed_rows / named > MAX_UNNAMED_RATIO) problems.push(`${s.am_unnamed_rows} of ${named} ApparelMagic styles have no product name`);
  if (previous && previous.am_family_count > 0 && s.am_families < previous.am_family_count * MIN_RATIO_OF_PREVIOUS) {
    problems.push(`ApparelMagic family count dropped from ${previous.am_family_count} to ${s.am_families} (> ${Math.round((1 - MIN_RATIO_OF_PREVIOUS) * 100)}% fewer) — looks truncated`);
  }
  return { ok: problems.length === 0, problems };
}

// ── ApparelMagic cache access (never blocks on a cold crawl) ────────────
function amState() {
  const configured = apparelmagic.configured();
  const st = configured ? apparelmagic.getAmCacheStatus().catalogue : { hasData: false, fetching: false };
  return { configured, has_data: !!st.hasData, fetching: !!st.fetching, fetched_at: st.fetchedAt ? new Date(st.fetchedAt).toISOString() : null };
}

// Returns the cached AM catalogue Map, or throws a CatalogueError saying why not.
async function readCachedAmCatalogue() {
  const st = amState();
  if (!st.configured) throw new CatalogueError('am_not_configured', 'ApparelMagic is not configured in this environment, so the catalogue cannot be built.');
  if (!st.has_data) {
    throw new CatalogueError('am_cold', st.fetching
      ? 'The ApparelMagic catalogue is still loading — try again in a few minutes.'
      : 'The ApparelMagic catalogue has not been loaded yet. Use "Load ApparelMagic catalogue" first (it can take several minutes).');
  }
  return apparelmagic.getStyleCatalogue(); // cached -> returns immediately (stale-while-revalidate)
}

// Explicit, non-blocking: starts the (slow) AM crawl in the background.
function startAmCatalogueLoad() {
  const st = amState();
  if (!st.configured) throw new CatalogueError('am_not_configured', 'ApparelMagic is not configured in this environment.');
  if (!st.has_data && !st.fetching) {
    apparelmagic.getStyleCatalogue().catch((err) => console.error('ApparelMagic catalogue load failed:', err.message));
  }
  return amState();
}

async function buildLiveCatalogue(db = pool) {
  const am = await readCachedAmCatalogue();
  const local = await db.query('SELECT style_code, name FROM styles');
  return buildCatalogue({ amCatalogue: am, localStyles: local.rows });
}

// ── persistence ─────────────────────────────────────────────────────────
async function getActiveSnapshot(db = pool) {
  const r = await db.query(
    `SELECT id, created_at, fingerprint, family_count, am_family_count, local_only_count, stats, activated_at
       FROM meta_catalogue_snapshots WHERE active LIMIT 1`
  );
  return r.rows[0] || null;
}

const snapshotFamilyCache = new Map(); // snapshot id -> families (immutable once written)
async function loadSnapshotFamilies(snapshotId, db = pool) {
  if (snapshotFamilyCache.has(snapshotId)) return snapshotFamilyCache.get(snapshotId);
  const r = await db.query('SELECT product_code, product_name, colourways, source FROM meta_catalogue_families WHERE snapshot_id = $1 ORDER BY product_code', [snapshotId]);
  if (snapshotFamilyCache.size > 3) snapshotFamilyCache.clear();
  snapshotFamilyCache.set(snapshotId, r.rows);
  return r.rows;
}

// The families the MATCHER compares against: the active snapshot, or (none
// active) the local styles exactly as V3. Never touches ApparelMagic.
const loadLocalFamilies = (db = pool) => listProductFamilies(db);

async function loadMatchingFamilies(db = pool) {
  const snap = await getActiveSnapshot(db);
  if (!snap) {
    const families = await listProductFamilies(db);
    return { families, rulesVersion: 3, catalogue: { source: 'local_styles', snapshot_id: null, fingerprint: null, family_count: families.length } };
  }
  const families = await loadSnapshotFamilies(snap.id, db);
  return { families, rulesVersion: 4, catalogue: { source: 'snapshot', snapshot_id: snap.id, fingerprint: snap.fingerprint, family_count: snap.family_count } };
}

// Families offered for HUMAN choice (product picker + confirm validation):
// the active snapshot plus any local style added since; local-only when no
// snapshot is active. A broader set than the matcher's, because a person may
// legitimately pick a product the matcher wouldn't auto-link.
async function loadPickerFamilies(db = pool) {
  const local = await listProductFamilies(db);
  const snap = await getActiveSnapshot(db);
  if (!snap) return local;
  const fams = await loadSnapshotFamilies(snap.id, db);
  const seen = new Set(fams.map((f) => f.product_code));
  return [...fams.map((f) => ({ product_code: f.product_code, product_name: f.product_name })), ...local.filter((f) => !seen.has(f.product_code))]
    .sort((a, b) => a.product_name.localeCompare(b.product_name));
}

async function saveAndActivate(candidate, userId, db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("UPDATE meta_catalogue_snapshots SET active = false, deactivated_at = now() WHERE active");
    const ins = await client.query(
      `INSERT INTO meta_catalogue_snapshots (created_by_user_id, fingerprint, family_count, am_family_count, local_only_count, stats, active, activated_at, activated_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,true,now(),$1) RETURNING id, created_at, activated_at`,
      [userId || null, candidate.fingerprint, candidate.families.length, candidate.stats.am_families, candidate.stats.local_only_families, JSON.stringify(candidate.stats)]
    );
    const id = ins.rows[0].id;
    await client.query(
      `INSERT INTO meta_catalogue_families (snapshot_id, product_code, product_name, colourways, source)
       SELECT $1::int, * FROM unnest($2::text[], $3::text[], $4::int[], $5::text[])`,
      [id, candidate.families.map((f) => f.product_code), candidate.families.map((f) => f.product_name), candidate.families.map((f) => f.colourways), candidate.families.map((f) => f.source)]
    );
    await client.query('COMMIT');
    return { id, fingerprint: candidate.fingerprint, family_count: candidate.families.length, activated_at: ins.rows[0].activated_at };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function deactivateSnapshot(db = pool) {
  const r = await db.query("UPDATE meta_catalogue_snapshots SET active = false, deactivated_at = now() WHERE active RETURNING id, fingerprint");
  return r.rows[0] || null;
}

async function listSnapshots(limit = 10, db = pool) {
  const r = await db.query(
    `SELECT id, created_at, fingerprint, family_count, am_family_count, local_only_count, active, activated_at, deactivated_at
       FROM meta_catalogue_snapshots ORDER BY id DESC LIMIT $1`, [limit]
  );
  return r.rows;
}

module.exports = {
  STYLE_CODE_RE, MIN_FAMILIES, CatalogueError,
  buildCatalogue, fingerprintOf, validateCatalogue,
  amState, readCachedAmCatalogue, startAmCatalogueLoad, buildLiveCatalogue,
  getActiveSnapshot, loadSnapshotFamilies, loadMatchingFamilies, loadLocalFamilies, loadPickerFamilies,
  saveAndActivate, deactivateSnapshot, listSnapshots,
};
