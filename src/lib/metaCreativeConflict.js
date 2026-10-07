// Creative conflict detail + explicit resolution (see the section comment below). Kept apart from
// metaCreativeIdentity.js on purpose: that module is the automatic, machine-owned inheritance path and must stay free of
// ad-name reads and of confirmation stamps; this one is the deliberate human exception.
// Local database only (no Meta call, no ApparelMagic call).
const { pool } = require('../db');
const { evaluateGroup, eligibleSql } = require('./metaCreativeIdentity');

// ── Conflict resolution (explicit, human) ───────────────────────────────
// Everything above PROTECTS human decisions: automatic inheritance never touches a person's work, and a
// disagreement between people on one creative is only ever surfaced. This is the deliberate exception: a
// person looks at the competing decisions for ONE exact meta_creative_id, picks the authoritative one, and
// the other person-confirmed ads of that same creative are brought into line with it (audited). It never
// looks at ad names; it never reaches ads of any other creative.
const DECISION_COLS = `m.meta_ad_id, m.ad_name, m.effective_status, m.match_confirmed_at, m.match_confirmed_by_user_id,
       c.not_product_specific, c.concept_type_id, c.concept_label, c.creative_style_id, c.creator_name, c.media_type,
       cs.name AS creative_style_name, u.name AS confirmed_by_name,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('product_code', p.product_code, 'product_name', p.product_name) ORDER BY p.product_code)
                   FROM meta_ad_products p WHERE p.meta_ad_id = m.meta_ad_id), '[]'::jsonb) AS products`;

function decisionKey(r) {
  return JSON.stringify([!!r.not_product_specific, (r.products || []).map((p) => p.product_code), r.concept_type_id || null, String(r.concept_label || '').trim().toLowerCase(),
    String(r.creator_name || '').trim().toLowerCase(), r.media_type || null, r.creative_style_id || null]);
}

// Every competing person-confirmed decision for one exact creative, grouped (ads that decided the same way share a
// card), with enough context for a person to choose: names, product(s), concept, creator, style, ad count, and the
// ad to use for the preview. Read-only.
async function getConflictDetail(creativeId, { humanOwnedSql }, db = pool) {
  if (!creativeId) return null;
  const { rows } = await db.query(
    `SELECT ${DECISION_COLS}
       FROM meta_ads m JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id
       LEFT JOIN creative_styles cs ON cs.id = c.creative_style_id
       LEFT JOIN users u ON u.id = m.match_confirmed_by_user_id
      WHERE m.meta_creative_id = $1 AND m.match_status = 'confirmed' AND NOT COALESCE(c.excluded_from_intelligence, false)
      ORDER BY m.match_confirmed_at DESC NULLS LAST, m.meta_ad_id`,
    [creativeId]
  );
  const group = evaluateGroup(rows.map((r) => ({ ...r, codes: (r.products || []).map((p) => p.product_code) })));
  const byKey = new Map();
  for (const r of rows) {
    const k = decisionKey(r);
    if (!byKey.has(k)) {
      byKey.set(k, {
        key: Buffer.from(k).toString('base64').slice(0, 24) + byKey.size,
        representative_ad_id: r.meta_ad_id, representative_ad_name: r.ad_name,
        products: (r.products || []).map((p) => ({ product_code: p.product_code, product_name: p.product_name })),
        not_product_specific: !!r.not_product_specific,
        concept: r.concept_label || null, creator: r.creator_name || null, media_type: r.media_type || null,
        creative_style: r.creative_style_name || null, confirmed_by: r.confirmed_by_name || null,
        confirmed_at: r.match_confirmed_at ? new Date(r.match_confirmed_at).toISOString() : null,
        ad_count: 0, ads: [],
      });
    }
    const d = byKey.get(k);
    d.ad_count += 1;
    if (d.ads.length < 20) d.ads.push({ meta_ad_id: r.meta_ad_id, ad_name: r.ad_name });
  }
  const eligible = eligibleSql(humanOwnedSql);
  const copies = await db.query(
    `SELECT count(*) FILTER (WHERE ${eligible})::int AS eligible, count(*)::int AS outstanding
       FROM meta_ads m LEFT JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id
      WHERE m.meta_creative_id = $1 AND m.match_status IN ('unmatched', 'suggested', 'auto_matched') AND NOT COALESCE(c.excluded_from_intelligence, false)`,
    [creativeId]
  );
  return {
    meta_creative_id: creativeId,
    state: group.state, // 'conflict' | 'source' (already agreed) | 'none'
    conflict_on: group.conflict_on || [],
    total_ads_in_creative: (await db.query('SELECT count(*)::int AS n FROM meta_ads WHERE meta_creative_id = $1', [creativeId])).rows[0].n,
    decisions: [...byKey.values()].sort((a, b) => b.ad_count - a.ad_count),
    unclassified_copies: copies.rows[0].outstanding,
    copies_that_would_inherit: copies.rows[0].eligible,
  };
}

// Make one person's decision authoritative for the creative. Only person-confirmed ads of THIS creative id are
// rewritten (their product(s) / concept / creator / media / style / not-product-specific flag become the chosen
// ad's); their confirmation stays 'confirmed', stamped with the resolver. Ad-instance specifics (Ad Setup link,
// skipped / excluded flags, names) are untouched. One transaction, one audit row with each ad's previous state.
async function resolveConflict(creativeId, chooseAdId, userId, db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT meta_ad_id FROM meta_ads WHERE meta_creative_id = $1 ORDER BY meta_ad_id FOR UPDATE', [creativeId]);
    const { rows } = await client.query(
      `SELECT ${DECISION_COLS}
         FROM meta_ads m JOIN meta_ad_classifications c ON c.meta_ad_id = m.meta_ad_id
         LEFT JOIN creative_styles cs ON cs.id = c.creative_style_id
         LEFT JOIN users u ON u.id = m.match_confirmed_by_user_id
        WHERE m.meta_creative_id = $1 AND m.match_status = 'confirmed' AND NOT COALESCE(c.excluded_from_intelligence, false)`,
      [creativeId]
    );
    const group = evaluateGroup(rows.map((r) => ({ ...r, codes: (r.products || []).map((p) => p.product_code) })));
    if (group.state !== 'conflict') {
      const err = new Error(group.state === 'source' ? 'This creative no longer has a conflict.' : 'This creative has no person-confirmed decisions.');
      err.code = 'NOT_IN_CONFLICT'; throw err;
    }
    const chosen = rows.find((r) => r.meta_ad_id === chooseAdId);
    if (!chosen) { const err = new Error('The chosen ad is not one of this creative\'s person-confirmed decisions.'); err.code = 'BAD_CHOICE'; throw err; }
    const chosenKey = decisionKey(chosen);
    const changes = [];
    for (const r of rows) {
      if (r.meta_ad_id === chosen.meta_ad_id || decisionKey(r) === chosenKey) continue;
      changes.push({
        meta_ad_id: r.meta_ad_id,
        before: { not_product_specific: !!r.not_product_specific, products: r.products, concept_type_id: r.concept_type_id, concept_label: r.concept_label, creative_style_id: r.creative_style_id, creator_name: r.creator_name, media_type: r.media_type },
      });
      await client.query(
        `UPDATE meta_ad_classifications SET not_product_specific = $2, concept_type_id = $3, concept_label = $4, creative_style_id = $5,
                creator_name = $6, media_type = $7, auto_fields = NULL, skipped_at = NULL, classified_by_user_id = $8, updated_at = now()
          WHERE meta_ad_id = $1`,
        [r.meta_ad_id, !!chosen.not_product_specific, chosen.concept_type_id, chosen.concept_label, chosen.creative_style_id, chosen.creator_name, chosen.media_type, userId || null]
      );
      await client.query('DELETE FROM meta_ad_products WHERE meta_ad_id = $1', [r.meta_ad_id]);
      for (const p of chosen.products) {
        await client.query('INSERT INTO meta_ad_products (meta_ad_id, product_code, product_name) VALUES ($1,$2,$3)', [r.meta_ad_id, p.product_code, p.product_name]);
      }
      await client.query('UPDATE meta_ads SET match_confirmed_at = now(), match_confirmed_by_user_id = $2 WHERE meta_ad_id = $1', [r.meta_ad_id, userId || null]);
    }
    await client.query(
      'INSERT INTO meta_conflict_resolutions (meta_creative_id, chosen_ad_id, resolved_by_user_id, changes) VALUES ($1,$2,$3,$4)',
      [creativeId, chosen.meta_ad_id, userId || null, JSON.stringify(changes)]
    );
    await client.query('COMMIT');
    return { meta_creative_id: creativeId, chosen_ad_id: chosen.meta_ad_id, ads_updated: changes.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getConflictDetail, resolveConflict };
