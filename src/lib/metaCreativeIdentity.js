// Creative-level identity for Ad Matching: ONE creative -> ONE classification,
// inherited by every ad instance that uses that exact creative.
//
// Identity is deterministic and exact: two ads are the same creative only when
// they carry the same non-null meta_creative_id (Meta's own id for the creative
// object). No name similarity, no fuzzy matching, no heuristic of any kind.
//
// What propagates, and from where
//   SOURCE  = a HUMAN decision: ads in the group with match_status = 'confirmed'
//             (and not excluded). Machine matches never propagate.
//   TARGET  = a sibling ad that no person owns (per the matcher's own
//             HUMAN_OWNED_SQL: not confirmed / excluded / skipped / manually
//             classified / linked to an Ad Setup), that no person has ever
//             rejected (auto_match_blocked_at), and whose status is unmatched /
//             suggested / auto_matched.
//   A target is written exactly the way the matcher's own auto-match writes: as
//   match_status 'auto_matched' (machine-owned, usable by the intelligence layer,
//   always overridable by a human), match_method 'creative_inherited', with
//   auto_fields recording which ad it came from. Nothing about a human-owned ad
//   is ever touched.
//
// Conflicts: if the human-confirmed ads of one creative disagree (different
// product set / "not product-specific" decision, or two different concepts), the
// group is a CONFLICT. Nothing is chosen silently: nothing is propagated, any
// previously inherited sibling is returned to normal evaluation, and the group
// is surfaced in the queue.
//
// What is NOT inherited: the ad-instance-specific Ad Setup link, the
// excluded / skipped flags, and creative_style_id (the matcher's own auto path
// never sets it either, and a style would make the inherited ad look
// human-classified).
//
// Everything here is local-database only (no Meta call, no ApparelMagic call).
const crypto = require('crypto');
const { pool } = require('../db');

const METHOD = 'creative_inherited';
const ELIGIBLE_STATUSES = ['unmatched', 'suggested', 'auto_matched'];
const STATUS_LIST_SQL = ELIGIBLE_STATUSES.map((x) => `'${x}'`).join(', ');

// THE inheritance-eligibility rule -- the single definition used by the Apply action (applyToAd /
// previewGroup), the Review workload panel and the queue counts, so they can never disagree about which
// ads will take a creative's classification. Aliases: m = meta_ads, c = meta_ad_classifications (LEFT JOIN).
// An ad is eligible when its status is unmatched / suggested / auto_matched AND no person owns it (the
// matcher's HUMAN_OWNED_SQL: confirmed, excluded, manually confirmed, linked to an Ad Setup, skipped,
// human-classified incl. a creative style or partial values) AND no person has rejected/cleared it.
function eligibleSql(humanOwnedSql) {
  return `(m.match_status IN (${STATUS_LIST_SQL}) AND (${humanOwnedSql}) IS NULL AND c.auto_match_blocked_at IS NULL)`;
}
// Why an ad is NOT eligible (NULL when it is).
function ineligibleReasonSql(humanOwnedSql) {
  return `(CASE WHEN m.match_status NOT IN (${STATUS_LIST_SQL}) THEN 'confirmed'
                WHEN (${humanOwnedSql}) IS NOT NULL THEN (${humanOwnedSql})
                WHEN c.auto_match_blocked_at IS NOT NULL THEN 'rejected_by_person' END)`;
}

// Creatives whose HUMAN-confirmed ads disagree (product set / "not product-specific" decision / concept).
// SQL twin of evaluateGroup's conflict test (kept side by side so they cannot drift; the suites check parity).
const CONFLICT_SELECT = `
    SELECT m.meta_creative_id,
           count(DISTINCT (COALESCE(c.not_product_specific, false)::text || '|' ||
                           COALESCE((SELECT string_agg(p.product_code, ',' ORDER BY p.product_code) FROM meta_ad_products p WHERE p.meta_ad_id = m.meta_ad_id), ''))) AS psigs,
           count(DISTINCT NULLIF(lower(btrim(COALESCE(c.concept_label, ''))), '')) AS csigs
      FROM meta_ads m JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id
     WHERE m.meta_creative_id IS NOT NULL AND m.match_status = 'confirmed' AND NOT COALESCE(c.excluded_from_intelligence, false)
     GROUP BY m.meta_creative_id`;

// Pure: what Apply does with one sibling row carrying { eligible, ineligible_reason, match_method, auto_fields }.
function decide(row, group) {
  if (!row.eligible) return { action: 'skip', reason: row.ineligible_reason || 'confirmed' };
  const s = group.source;
  const prior = row.auto_fields && row.auto_fields.inherited;
  if (row.match_method === METHOD && prior && prior.signature === s.signature && prior.from_meta_ad_id === s.from_meta_ad_id) return { action: 'unchanged' };
  return { action: 'apply' };
}

const conceptKey = (row) => String(row.concept_label || '').trim().toLowerCase();

// Pure: the human-confirmed rows of ONE creative -> { state, source?, ... }.
// rows are ordered most-recently-confirmed first.
function evaluateGroup(rows) {
  if (!rows.length) return { state: 'none', human_ads: 0 };
  const productSigs = new Set(rows.map((r) => `${r.not_product_specific ? 'nps' : 'p'}|${(r.codes || []).join(',')}`));
  const conceptSigs = new Set(rows.map(conceptKey).filter(Boolean));
  if (productSigs.size > 1 || conceptSigs.size > 1) {
    return {
      state: 'conflict', human_ads: rows.length,
      conflict_on: [productSigs.size > 1 ? 'product' : null, conceptSigs.size > 1 ? 'concept' : null].filter(Boolean),
      ad_ids: rows.map((r) => r.meta_ad_id),
    };
  }
  const first = rows[0];
  const pick = (k) => { const hit = rows.find((r) => r[k] !== null && r[k] !== undefined && r[k] !== ''); return hit ? hit[k] : null; };
  const source = {
    from_meta_ad_id: first.meta_ad_id,
    not_product_specific: !!first.not_product_specific,
    concept_type_id: pick('concept_type_id'),
    concept_label: pick('concept_label'),
    creator_name: pick('creator_name'),
    media_type: pick('media_type'),
    products: first.products || [],
  };
  const signature = crypto.createHash('sha1').update(JSON.stringify([source.not_product_specific, source.concept_type_id, source.concept_label, source.creator_name, source.media_type, source.products])).digest('hex').slice(0, 16);
  return { state: 'source', human_ads: rows.length, source: { ...source, signature } };
}

async function humanRows(db, creativeId) {
  const { rows } = await db.query(
    `SELECT m.meta_ad_id, m.match_confirmed_at, c.not_product_specific, c.concept_type_id, c.concept_label, c.creator_name, c.media_type,
            COALESCE((SELECT array_agg(p.product_code ORDER BY p.product_code) FROM meta_ad_products p WHERE p.meta_ad_id = m.meta_ad_id), '{}') AS codes,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('product_code', p.product_code, 'product_name', p.product_name) ORDER BY p.product_code)
                        FROM meta_ad_products p WHERE p.meta_ad_id = m.meta_ad_id), '[]'::jsonb) AS products
       FROM meta_ads m JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id
      WHERE m.meta_creative_id = $1 AND m.match_status = 'confirmed' AND NOT COALESCE(c.excluded_from_intelligence, false)
      ORDER BY m.match_confirmed_at DESC NULLS LAST, m.meta_ad_id`,
    [creativeId]
  );
  return rows;
}

async function resolveGroup(db, creativeId) {
  if (!creativeId) return { state: 'none', human_ads: 0 };
  return evaluateGroup(await humanRows(db, creativeId));
}

// Writes the inherited classification onto ONE sibling. The caller holds (or
// this takes) the row lock; every protection is re-checked under it.
async function applyToAd(client, adId, creativeId, group, { humanOwnedSql, rulesVersion }) {
  const locked = await client.query(
    `SELECT m.match_method, c.auto_fields, ${eligibleSql(humanOwnedSql)} AS eligible, ${ineligibleReasonSql(humanOwnedSql)} AS ineligible_reason
       FROM meta_ads m LEFT JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id
      WHERE m.meta_ad_id = $1 AND m.meta_creative_id = $2 FOR UPDATE OF m`,
    [adId, creativeId]
  );
  if (!locked.rows.length) return { skipped: 'missing' };
  const decision = decide(locked.rows[0], group);
  if (decision.action === 'skip') return { skipped: decision.reason };
  const s = group.source;
  if (decision.action === 'unchanged') {
    // Same decision: nothing to rewrite, but keep the version stamp current.
    await client.query('UPDATE meta_ads SET match_rules_version = $2 WHERE meta_ad_id = $1 AND COALESCE(match_rules_version, 0) < $2', [adId, rulesVersion]);
    return { unchanged: true };
  }

  const autoFields = {
    inherited: { basis: 'meta_creative_id', meta_creative_id: creativeId, from_meta_ad_id: s.from_meta_ad_id, signature: s.signature },
    product: { basis: 'creative_inherited', confidence: 1 },
    ...(s.concept_label ? { concept: { basis: 'creative_inherited' } } : {}),
  };
  await client.query(
    `INSERT INTO meta_ad_classifications (meta_ad_id, not_product_specific, concept_type_id, concept_label, creator_name, media_type, auto_fields)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (meta_ad_id) DO UPDATE SET
       not_product_specific = EXCLUDED.not_product_specific, concept_type_id = EXCLUDED.concept_type_id, concept_label = EXCLUDED.concept_label,
       creator_name = EXCLUDED.creator_name, media_type = EXCLUDED.media_type, auto_fields = EXCLUDED.auto_fields, updated_at = now()`,
    [adId, s.not_product_specific, s.concept_type_id, s.concept_label, s.creator_name, s.media_type, JSON.stringify(autoFields)]
  );
  await client.query('DELETE FROM meta_ad_products WHERE meta_ad_id = $1', [adId]);
  for (const p of s.products) {
    await client.query('INSERT INTO meta_ad_products (meta_ad_id, product_code, product_name) VALUES ($1,$2,$3)', [adId, p.product_code, p.product_name]);
  }
  await client.query(
    `UPDATE meta_ads SET match_status = 'auto_matched', match_method = $2, match_confidence = 1, match_suggestions_at = now(), match_rules_version = $3
      WHERE meta_ad_id = $1 AND match_status IN ('unmatched', 'suggested', 'auto_matched')`,
    [adId, METHOD, rulesVersion]
  );
  return { applied: true };
}

// Undoes ONLY an inherited write (never a human or a name-based machine match):
// the ad goes back to a clean, pending-evaluation state and the normal matcher
// takes it from there.
async function revertAd(client, adId) {
  const r = await client.query(
    `UPDATE meta_ads SET match_status = 'unmatched', match_method = NULL, match_confidence = NULL, match_suggestions_at = NULL, match_rules_version = NULL
      WHERE meta_ad_id = $1 AND match_status = 'auto_matched' AND match_method = $2 RETURNING meta_ad_id`,
    [adId, METHOD]
  );
  if (!r.rows.length) return false;
  await client.query('DELETE FROM meta_ad_products WHERE meta_ad_id = $1', [adId]);
  await client.query(
    `UPDATE meta_ad_classifications SET not_product_specific = false, concept_type_id = NULL, concept_label = NULL,
            creator_name = NULL, media_type = NULL, auto_fields = NULL, updated_at = now() WHERE meta_ad_id = $1`,
    [adId]
  );
  return true;
}

// Whole-database dry run of the Apply action. Set-based (a few queries, whatever the size of the backlog) and
// exact: it applies the same eligibility rule and the same decide() Apply uses.
//   * eligible siblings (not yet inherited) of a creative that has a person's decision and no conflict -> would apply
//   * siblings already inherited -> re-checked one creative at a time with decide() (only creatives Apply has touched)
//   * inherited siblings of a creative with no usable decision any more (conflict / cleared) -> would be released
async function previewAll({ humanOwnedSql }, db = pool) {
  const eligible = eligibleSql(humanOwnedSql);
  const why = ineligibleReasonSql(humanOwnedSql);
  const base = `
    WITH conf AS (SELECT meta_creative_id FROM (${CONFLICT_SELECT}) g WHERE g.psigs > 1 OR g.csigs > 1),
    src AS (
      SELECT DISTINCT m.meta_creative_id FROM meta_ads m JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id
       WHERE m.meta_creative_id IS NOT NULL AND m.match_status = 'confirmed' AND NOT COALESCE(c.excluded_from_intelligence, false)
         AND m.meta_creative_id NOT IN (SELECT meta_creative_id FROM conf)
    ),
    sib AS (
      SELECT m.meta_ad_id, m.meta_creative_id, m.match_method, c.auto_fields, ${eligible} AS eligible, ${why} AS reason,
             (m.meta_creative_id IN (SELECT meta_creative_id FROM src)) AS has_source
        FROM meta_ads m LEFT JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id
       WHERE m.meta_creative_id IS NOT NULL AND m.match_status IN (${STATUS_LIST_SQL})
    )`;
  const [tot, skipped, inherited] = await Promise.all([
    db.query(`${base} SELECT
        count(*) FILTER (WHERE has_source AND eligible AND match_method IS DISTINCT FROM '${METHOD}')::int AS would_apply_new,
        count(*) FILTER (WHERE NOT has_source AND match_method = '${METHOD}')::int AS would_release,
        count(DISTINCT meta_creative_id) FILTER (WHERE has_source)::int AS creatives_with_a_decision
      FROM sib`),
    db.query(`${base} SELECT reason, count(*)::int AS n FROM sib WHERE has_source AND NOT eligible GROUP BY reason`),
    db.query(`${base} SELECT meta_ad_id, meta_creative_id, match_method, auto_fields, eligible FROM sib WHERE has_source AND eligible AND match_method = '${METHOD}'`),
  ]);
  const out = { creatives: tot.rows[0].creatives_with_a_decision, would_apply: tot.rows[0].would_apply_new, unchanged: 0, would_release: tot.rows[0].would_release, skipped: {}, complete: true };
  skipped.rows.forEach((r) => { out.skipped[r.reason] = r.n; });
  const groups = new Map();
  for (const r of inherited.rows) {
    if (!groups.has(r.meta_creative_id)) groups.set(r.meta_creative_id, await resolveGroup(db, r.meta_creative_id));
    const d = decide({ eligible: r.eligible, match_method: r.match_method, auto_fields: r.auto_fields }, groups.get(r.meta_creative_id));
    if (d.action === 'apply') out.would_apply += 1; else out.unchanged += 1;
  }
  return out;
}

// Used inside the matcher's per-ad evaluation (already in a transaction with the
// ad's row locked). 'applied' = this ad now carries the creative's classification;
// 'reverted' = it had an inherited one that no longer stands (now pending again).
async function inheritForAd(client, adId, opts) {
  const own = await client.query('SELECT meta_creative_id FROM meta_ads WHERE meta_ad_id = $1', [adId]);
  const creativeId = own.rows[0] && own.rows[0].meta_creative_id;
  if (!creativeId) return { none: true };
  const group = await resolveGroup(client, creativeId);
  if (group.state === 'source') {
    const r = await applyToAd(client, adId, creativeId, group, opts);
    if (r.applied || r.unchanged) return { applied: true };
    return { none: true, skipped: r.skipped };
  }
  const reverted = await revertAd(client, adId);
  return reverted ? { reverted: true } : { none: true, state: group.state };
}

// After a human action on one ad: bring every sibling of that creative into line
// with the group's CURRENT state (inherit / revert). One transaction per sibling.
async function syncCreativeGroup(creativeId, opts, db = pool) {
  const out = { creative_id: creativeId, state: 'none', applied: 0, reverted: 0, skipped: 0 };
  if (!creativeId) return out;
  const group = await resolveGroup(db, creativeId);
  out.state = group.state;
  const sibs = await db.query(
    `SELECT meta_ad_id FROM meta_ads WHERE meta_creative_id = $1 AND match_status = ANY($2::text[]) ORDER BY meta_ad_id`,
    [creativeId, ELIGIBLE_STATUSES]
  );
  for (const sib of sibs.rows) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      if (group.state === 'source') {
        const r = await applyToAd(client, sib.meta_ad_id, creativeId, group, opts);
        if (r.applied) out.applied += 1; else if (!r.unchanged) out.skipped += 1;
      } else if (await revertAd(client, sib.meta_ad_id)) {
        out.reverted += 1;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return out;
}

// Explicit admin action: sync every creative that has at least one human-confirmed
// ad AND at least one eligible sibling. Idempotent; bounded by `limit` creatives per
// call (call again with `after` = the returned next_after to continue). Local database only.
async function applyAllGroups(opts, { limit = 2000, after = '' } = {}, db = pool) {
  const cap = Math.min(10000, Math.max(1, parseInt(limit, 10) || 2000));
  const ids = await db.query(
    `SELECT m.meta_creative_id FROM meta_ads m
      WHERE m.meta_creative_id IS NOT NULL AND m.meta_creative_id > $3
      GROUP BY m.meta_creative_id
     HAVING bool_or(m.match_status = 'confirmed') AND bool_or(m.match_status = ANY($1::text[]))
      ORDER BY m.meta_creative_id LIMIT $2`,
    [ELIGIBLE_STATUSES, cap, String(after || '')]
  );
  const total = {
    creatives: ids.rows.length, applied: 0, reverted: 0, skipped: 0, conflicts: 0,
    next_after: ids.rows.length === cap ? ids.rows[ids.rows.length - 1].meta_creative_id : null,
  };
  for (const row of ids.rows) {
    const r = await syncCreativeGroup(row.meta_creative_id, opts, db);
    total.applied += r.applied; total.reverted += r.reverted; total.skipped += r.skipped;
    if (r.state === 'conflict') total.conflicts += 1;
  }
  return total;
}

module.exports = { METHOD, ELIGIBLE_STATUSES, CONFLICT_SELECT, eligibleSql, ineligibleReasonSql, decide, evaluateGroup, resolveGroup, applyToAd, revertAd, previewAll, inheritForAd, syncCreativeGroup, applyAllGroups };
