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
// The snapshot keeps one row per product CODE (traceability, fingerprint). For
// MATCHING, codes whose canonical product name is identical are one LOGICAL family
// (see collapseFamilies): the same WNDRR product sold under several season codes is
// not "ambiguous". Genuinely different names that the ad phrase cannot tell apart
// still tie and stay in Needs Review. There is no newest-year / newest-code tie-break.
const crypto = require('crypto');
const { pool } = require('../db');
const { HttpError } = require('./metaPerformance');
const apparelmagic = require('./apparelmagic');
const { listProductFamilies } = require('./metaProductMapping');
const { canonTokens } = require('./metaNameParsing');

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

// Canonical product-family name: the matcher's own word canonicalisation (case,
// punctuation, 1/4 = QUARTER, TEES = TEE ...), keeping word ORDER and every word.
// Two codes are the same logical family only when this is identical.
const canonicalKey = (name) => canonTokens(name).join(' ');

// ── pure: collapse same-canonical-name product codes into LOGICAL families ──
// families: [{ product_code, product_name, colourways, source, in_local }]
// Returns one entry per canonical name, ordered by representative code:
//   { product_code (representative), product_name, colourways (sum), source, in_local,
//     member_codes (ALL underlying codes, sorted), name_variants? }
// The representative is the code the app already knows (local style) first, then the
// most colourways, then the lowest code -- deterministic, and NOT a "newest year wins"
// guess. Every member code stays resolvable (aliases) for traceability.
function collapseFamilies(families) {
  const groups = new Map();
  (families || []).forEach((f) => {
    const k = canonicalKey(f.product_name) || `~${f.product_code}`; // an unnameable code is never grouped
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  });
  const out = [];
  groups.forEach((members) => {
    const sorted = [...members].sort((a, b) => (b.in_local ? 1 : 0) - (a.in_local ? 1 : 0) || (b.colourways || 0) - (a.colourways || 0) || String(a.product_code).localeCompare(String(b.product_code)));
    const rep = sorted[0];
    const variants = [...new Set(sorted.map((m) => m.product_name))].sort();
    const fam = {
      product_code: rep.product_code, product_name: rep.product_name, colourways: sorted.reduce((n, m) => n + (m.colourways || 0), 0),
      source: rep.source, in_local: sorted.some((m) => m.in_local), member_codes: sorted.map((m) => m.product_code).sort(),
    };
    if (variants.length > 1) fam.name_variants = variants;
    out.push(fam);
  });
  return out.sort((a, b) => a.product_code.localeCompare(b.product_code));
}

// ── pure: build a catalogue from the AM style map + local style rows ────
// amCatalogue: Map(style_code -> { productName, ... }) | null
// localStyles: [{ style_code, name }]
function buildCatalogue({ amCatalogue, localStyles = [] }) {
  const stats = {
    am_style_rows: 0, am_style_rows_excluded: 0, am_excluded_examples: [], am_unnamed_rows: 0,
    am_families: 0, local_families: 0, local_only_families: 0, am_only_families: 0,
    duplicate_name_groups: 0, duplicate_name_codes: 0, families_by_season: {},
    logical_families: 0, collapsed_groups: 0, collapsed_codes: 0, collapsed_groups_top: [], name_variant_groups: 0,
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
    families.set(code, { product_code: code, product_name: name, colourways: g.colourways, source: 'apparelmagic', in_local: false });
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
    if (families.has(code)) { families.get(code).in_local = true; return; } // ApparelMagic's name wins for a code in both
    families.set(code, { product_code: code, product_name: String(l.name || code).trim(), colourways: l.colourways, source: 'local', in_local: true });
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
  // what the matcher will see: one logical family per canonical name
  const logical = collapseFamilies(list);
  stats.logical_families = logical.length;
  const multi = logical.filter((f) => f.member_codes.length > 1);
  stats.collapsed_groups = multi.length;
  stats.collapsed_codes = multi.reduce((n, f) => n + f.member_codes.length, 0);
  stats.name_variant_groups = logical.filter((f) => f.name_variants).length;
  stats.collapsed_groups_top = multi.sort((a, b) => b.member_codes.length - a.member_codes.length || a.product_name.localeCompare(b.product_name)).slice(0, 25)
    .map((f) => ({ name: f.product_name, representative: f.product_code, codes: f.member_codes.slice(0, 12), code_count: f.member_codes.length, name_variants: f.name_variants || undefined }));
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
  const r = await db.query('SELECT product_code, product_name, colourways, source, in_local FROM meta_catalogue_families WHERE snapshot_id = $1 ORDER BY product_code', [snapshotId]);
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
  const rows = await loadSnapshotFamilies(snap.id, db);
  const families = collapseFamilies(rows); // logical families; every underlying code stays an alias (member_codes)
  return { families, rulesVersion: 4, catalogue: { source: 'snapshot', snapshot_id: snap.id, fingerprint: snap.fingerprint, family_count: families.length, code_count: rows.length } };
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
      `INSERT INTO meta_catalogue_families (snapshot_id, product_code, product_name, colourways, source, in_local)
       SELECT $1::int, * FROM unnest($2::text[], $3::text[], $4::int[], $5::text[], $6::boolean[])`,
      [id, candidate.families.map((f) => f.product_code), candidate.families.map((f) => f.product_name), candidate.families.map((f) => f.colourways), candidate.families.map((f) => f.source), candidate.families.map((f) => !!f.in_local)]
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
  buildCatalogue, collapseFamilies, canonicalKey, fingerprintOf, validateCatalogue,
  amState, readCachedAmCatalogue, startAmCatalogueLoad, buildLiveCatalogue,
  getActiveSnapshot, loadSnapshotFamilies, loadMatchingFamilies, loadLocalFamilies, loadPickerFamilies,
  saveAndActivate, deactivateSnapshot, listSnapshots,
};
