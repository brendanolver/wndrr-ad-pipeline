// Creative Classification management (Settings): the options Ad Matching offers for Concept, Creator and Creative Style, and the safe way to
// add, rename, merge, hide (deactivate) or bring one back.
//
// The three fields do NOT share a data model, so each is handled on its own terms:
//   concept   an option is a row of meta_matching_vocab (kind 'concept'); a classification stores the concept's TEXT (concept_label) and, when
//             the concept has a concept_types twin, its id. Historical spellings map to an option through meta_matching_concept_aliases.
//   creator   an option is the filming roster (content_creators, owned by Shooting), a row of meta_matching_vocab (kind 'creator') or a name
//             already used by a classification; a classification stores the creator's TEXT (creator_name).
//   style     an option is a creative_styles row (shared with Promotions, which refers to it by id AND, for the built-in ones, by name); a
//             classification stores creative_style_id.
//
// RULES (every change goes through them):
//   * A change that rewrites existing classifications (rename / merge) is PREVIEWED first (read-only: counts, a sample, consequences) and applied
//     only with an explicit confirmation carrying the preview's fingerprint. Apply re-derives the plan under a lock; if the affected records
//     changed since the preview it refuses and asks for a new preview.
//   * Apply is ONE transaction: the classifications are rewritten (ONLY the one field), the old option is retired, the audit rows are written. If
//     any step fails nothing changes.
//   * Nothing else on a classification changes: not the product, media, the other fields, the status, who confirmed it or when. Machine-made and
//     person-made classifications are rewritten the same way (the label is a spelling, not a decision), and each rewritten row is recorded
//     (old value / new value) in meta_classification_option_change_items.
//   * An option is never deleted. Retiring keeps the row (active = false), so the seed that runs at boot cannot bring it back.
//   * A built-in creative style (used by Promotions by name) can be hidden or merged in Ad Matching but never renamed; a filming-roster creator can
//     be hidden or merged INTO, never merged away or renamed here.
//   * Local database only. No Meta, ApparelMagic or Promotions data is written.
const crypto = require('crypto');
const { pool } = require('../db');
const vocab = require('./metaMatchingVocab');
const { HttpError } = require('./metaPerformance');

const KINDS = ['concept', 'creator', 'style'];
const ACTIONS = ['rename', 'merge', 'deactivate', 'reactivate'];
const SAMPLE_ROWS = 25;
// Seeded by db/schema.sql and referred to by NAME by Promotions planning; they are never renamed from here.
const BUILTIN_STYLE_NAMES = new Set([
  'Graphic tile', 'GWP/Giveaway - Graphic', 'GWP/Giveaway - Video', 'GIF', 'PNG frame (flat lay, e-comm) - single/carousel', 'Product Focused Video', 'DPA',
  'Price Strikethrough', 'Founder Video', 'EGC Video', 'UGC Video', 'BAU Video', 'Campaign Video', 'Other Video (eg. Humour, TikTok)',
]);
const NORM = (col) => `lower(btrim(regexp_replace(${col}, '\\s+', ' ', 'g')))`;
const { cleanName, keyOf, MAX_NAME } = vocab;
const ucKind = (k) => (k === 'style' ? 'creative style' : k);

function assertKind(kind) { if (!KINDS.includes(kind)) throw new HttpError(400, 'Unknown option type'); }

// ── reading ──────────────────────────────────────────────────────────────

async function loadConceptModel(db) {
  const rows = (await db.query(
    `SELECT id, name, name_key, group_name, group_order, sort_order, active, merged_into_id, retired_at
       FROM meta_matching_vocab WHERE kind = 'concept' ORDER BY group_order NULLS LAST, sort_order NULLS LAST, name`)).rows;
  const aliases = (await db.query('SELECT alias, alias_key, approved_name, removed FROM meta_matching_concept_aliases')).rows;
  const types = (await db.query('SELECT id, name FROM concept_types WHERE active')).rows;
  const typeByKey = new Map(); types.forEach((t) => { const k = keyOf(t.name); if (k && !typeByKey.has(k)) typeByKey.set(k, t); });
  const byKey = new Map(rows.map((r) => [r.name_key, r]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const aliasKeysOf = (nameKey) => aliases.filter((a) => !a.removed && a.approved_name && keyOf(a.approved_name) === nameKey).map((a) => a.alias_key);
  return { rows, aliases, byKey, byId, typeByKey, aliasKeysOf };
}
const conceptTypeId = (model, name) => { const t = model.typeByKey.get(keyOf(name)); return t ? t.id : null; };

// ONE query: the number of creatives / ads using each option, counting every spelling that maps to it (its own name + its aliases)
async function conceptUsage(db, items) {
  const keys = []; const ids = [];
  items.forEach((i) => i.keys.forEach((k) => { keys.push(k); ids.push(String(i.id)); }));
  const out = new Map();
  if (keys.length) {
    const r = await db.query(
      `WITH map(k, item) AS (SELECT * FROM unnest($1::text[], $2::text[])),
            uses AS (SELECT ${NORM('c.concept_label')} AS k, COALESCE(m.meta_creative_id, m.meta_ad_id) AS unit, m.meta_ad_id, m.match_status
                       FROM meta_ad_classifications c JOIN meta_ads m ON m.meta_ad_id = c.meta_ad_id WHERE c.concept_label IS NOT NULL AND btrim(c.concept_label) <> '')
       SELECT map.item, count(DISTINCT u.unit)::int AS creatives, count(DISTINCT u.meta_ad_id)::int AS ads, count(DISTINCT u.meta_ad_id) FILTER (WHERE u.match_status = 'confirmed')::int AS confirmed_ads
         FROM map JOIN uses u ON u.k = map.k GROUP BY map.item`, [keys, ids]);
    r.rows.forEach((x) => out.set(x.item, { creatives: x.creatives, ads: x.ads, confirmed_ads: x.confirmed_ads }));
  }
  return out;
}

async function listConcepts(db = pool) {
  const model = await loadConceptModel(db);
  const items = model.rows.map((r) => ({ id: r.id, row: r, keys: [r.name_key, ...model.aliasKeysOf(r.name_key)] }));
  const usage = await conceptUsage(db, items);
  const known = new Set(); items.forEach((i) => i.keys.forEach((k) => known.add(k)));
  model.aliases.forEach((a) => known.add(a.alias_key));
  const inUse = (await db.query(
    `SELECT ${NORM('c.concept_label')} AS k, mode() WITHIN GROUP (ORDER BY c.concept_label) AS label, count(DISTINCT COALESCE(m.meta_creative_id, m.meta_ad_id))::int AS creatives, count(DISTINCT m.meta_ad_id)::int AS ads
       FROM meta_ad_classifications c JOIN meta_ads m ON m.meta_ad_id = c.meta_ad_id WHERE c.concept_label IS NOT NULL AND btrim(c.concept_label) <> '' GROUP BY 1`)).rows;
  return {
    kind: 'concept',
    items: model.rows.map((r) => {
      const u = usage.get(String(r.id)) || { creatives: 0, ads: 0, confirmed_ads: 0 };
      const merged = r.merged_into_id ? model.byId.get(r.merged_into_id) : null;
      return {
        id: r.id, name: r.name, status: r.active ? 'active' : (merged ? 'merged' : 'hidden'), merged_into: merged ? merged.name : null,
        group: r.group_name || null, approved: r.group_order != null, aliases: model.aliases.filter((a) => !a.removed && a.approved_name && keyOf(a.approved_name) === r.name_key).map((a) => a.alias),
        creatives: u.creatives, ads: u.ads, confirmed_ads: u.confirmed_ads,
      };
    }),
    // text stored on classifications that is not on the list at all (typed free text, an old spelling that is no longer mapped): can be merged into an option
    unlisted: inUse.filter((x) => !known.has(x.k)).map((x) => ({ name: x.label, key: x.k, creatives: x.creatives, ads: x.ads })).sort((a, b) => b.ads - a.ads || a.name.localeCompare(b.name)),
  };
}

async function listCreators(db = pool) {
  const roster = (await db.query('SELECT name FROM content_creators ORDER BY name')).rows;
  const vrows = (await db.query("SELECT id, name, name_key, active, merged_into_id FROM meta_matching_vocab WHERE kind = 'creator' ORDER BY name")).rows;
  const used = (await db.query(
    `SELECT ${NORM('c.creator_name')} AS k, mode() WITHIN GROUP (ORDER BY btrim(c.creator_name)) AS label, count(DISTINCT COALESCE(m.meta_creative_id, m.meta_ad_id))::int AS creatives, count(DISTINCT m.meta_ad_id)::int AS ads,
            count(DISTINCT m.meta_ad_id) FILTER (WHERE m.match_status = 'confirmed')::int AS confirmed_ads
       FROM meta_ad_classifications c JOIN meta_ads m ON m.meta_ad_id = c.meta_ad_id WHERE c.creator_name IS NOT NULL AND btrim(c.creator_name) <> '' GROUP BY 1`)).rows;
  const usedBy = new Map(used.map((u) => [u.k, u]));
  const vById = new Map(vrows.map((v) => [v.id, v]));
  const items = new Map();
  const put = (name, patch) => { const k = keyOf(name); if (!k) return; const cur = items.get(k) || { key: k, name: cleanName(name), roster: false, added: false, status: 'active', merged_into: null, vocab_id: null }; items.set(k, { ...cur, ...patch }); };
  roster.forEach((r) => put(r.name, { roster: true }));
  vrows.forEach((v) => put(v.name, { added: true, vocab_id: v.id, status: v.active ? 'active' : (v.merged_into_id ? 'merged' : 'hidden'), merged_into: v.merged_into_id && vById.get(v.merged_into_id) ? vById.get(v.merged_into_id).name : null }));
  used.forEach((u) => { if (!items.has(u.k)) put(u.label, {}); });
  return {
    kind: 'creator',
    items: [...items.values()].map((i) => {
      const u = usedBy.get(i.key) || { creatives: 0, ads: 0, confirmed_ads: 0 };
      return { ...i, source: i.roster ? 'roster' : i.added ? 'added' : 'in_use', creatives: u.creatives, ads: u.ads, confirmed_ads: u.confirmed_ads };
    }).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function listStyles(db = pool) {
  const rows = (await db.query(
    `SELECT s.id, s.name, s.media_type, s.sort_order, s.ad_matching_active,
            (SELECT count(DISTINCT c.meta_ad_id)::int FROM meta_ad_classifications c WHERE c.creative_style_id = s.id) AS ads,
            (SELECT count(DISTINCT COALESCE(m.meta_creative_id, m.meta_ad_id))::int FROM meta_ad_classifications c JOIN meta_ads m ON m.meta_ad_id = c.meta_ad_id WHERE c.creative_style_id = s.id) AS creatives,
            (SELECT count(*)::int FROM meta_ad_classifications c JOIN meta_ads m ON m.meta_ad_id = c.meta_ad_id WHERE c.creative_style_id = s.id AND m.match_status = 'confirmed') AS confirmed_ads,
            (SELECT count(*)::int FROM promotion_creative_targets t WHERE t.creative_style_id = s.id)
              + (SELECT count(*)::int FROM promotion_creative_ideas i WHERE i.creative_style_id = s.id)
              + (SELECT count(*)::int FROM promotion_creative_idea_executions e WHERE e.creative_style_id = s.id) AS promotion_uses
       FROM creative_styles s ORDER BY s.sort_order, s.name`)).rows;
  return {
    kind: 'style',
    items: rows.map((r) => ({
      id: r.id, name: r.name, media_type: r.media_type, status: r.ad_matching_active ? 'active' : 'hidden', builtin: BUILTIN_STYLE_NAMES.has(r.name),
      creatives: r.creatives, ads: r.ads, confirmed_ads: r.confirmed_ads, promotion_uses: r.promotion_uses,
    })),
  };
}

async function listOptions(kind, db = pool) {
  assertKind(kind);
  if (kind === 'concept') return listConcepts(db);
  if (kind === 'creator') return listCreators(db);
  return listStyles(db);
}

// ── adding ───────────────────────────────────────────────────────────────

async function recordChange(db, { kind, action, source, target, ads, creatives, details, userId }) {
  const r = await db.query(
    `INSERT INTO meta_classification_option_changes (kind, action, source_name, target_name, affected_ads, affected_creatives, details, applied_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [kind, action, source || null, target || null, ads || 0, creatives || 0, details ? JSON.stringify(details) : null, userId || null]);
  return r.rows[0].id;
}

async function addOption(kind, body, userId) {
  assertKind(kind);
  const name = cleanName(body && body.name);
  if (!name) throw new HttpError(400, `Type a ${ucKind(kind)} name to add`);
  if (name.length > MAX_NAME) throw new HttpError(400, `A ${ucKind(kind)} name can be at most ${MAX_NAME} characters`);
  if (kind === 'style') {
    const media = String(body.media_type || '').toLowerCase();
    if (!['graphic', 'video'].includes(media)) throw new HttpError(400, 'Choose whether the creative style is a graphic or a video');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['meta_classification_options:style']);
      const dup = await client.query('SELECT id, name FROM creative_styles WHERE lower(btrim(name)) = $1', [keyOf(name)]);
      if (dup.rows.length) throw new HttpError(409, `“${dup.rows[0].name}” already exists`);
      const next = (await client.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM creative_styles')).rows[0].n;
      const ins = await client.query('INSERT INTO creative_styles (name, media_type, sort_order, ad_matching_active) VALUES ($1,$2,$3,true) RETURNING id, name', [name, media, next]);
      await recordChange(client, { kind, action: 'add', target: name, userId, details: { media_type: media, style_id: ins.rows[0].id } });
      await client.query('COMMIT');
      return { kind, created: true, id: ins.rows[0].id, name };
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
  }
  const res = await vocab.addName(kind, name, userId);
  if (res.created) await recordChange(pool, { kind, action: res.reactivated ? 'reactivate' : 'add', target: res.name, userId });
  return res;
}

// ── plans (preview and apply share this) ──────────────────────────────────

const fingerprintOf = (plan) => crypto.createHash('sha1').update(JSON.stringify({
  k: plan.kind, a: plan.action, s: plan.source && plan.source.key, t: plan.target && plan.target.key, n: plan.new_key || null,
  ads: plan.affected.map((x) => x.meta_ad_id).sort(), sg: plan.suggestions, al: (plan.aliases || []).slice().sort(),
})).digest('hex');

function emptyPlan(kind, action) {
  return { kind, action, source: null, target: null, new_name: null, new_key: null, affected: [], suggestions: 0, aliases: [], blockers: [], notes: [], effects: [], other_uses: null };
}

const sampleOf = (plan) => plan.affected.slice(0, SAMPLE_ROWS).map((a) => ({ meta_ad_id: a.meta_ad_id, ad_name: a.ad_name, match_status: a.match_status, from: a.from, to: a.to }));

function finishPlan(plan) {
  const creatives = new Set(plan.affected.map((a) => a.creative_key));
  const confirmed = plan.affected.filter((a) => a.match_status === 'confirmed').length;
  plan.counts = { ads: plan.affected.length, creatives: creatives.size, confirmed_ads: confirmed, auto_or_other_ads: plan.affected.length - confirmed, suggestions: plan.suggestions, aliases: plan.aliases.length };
  plan.sample = sampleOf(plan);
  plan.fingerprint = fingerprintOf(plan);
  plan.allowed = plan.blockers.length === 0;
  plan.changes_classifications = plan.affected.length > 0;
  return plan;
}

// ----- concept
async function conceptAffected(db, keys, toName, toTypeId) {
  if (!keys.length) return { rows: [], suggestions: 0 };
  const r = await db.query(
    `SELECT m.meta_ad_id, m.ad_name, COALESCE(m.meta_creative_id, m.meta_ad_id) AS creative_key, m.match_status, c.concept_label, c.concept_type_id
       FROM meta_ad_classifications c JOIN meta_ads m ON m.meta_ad_id = c.meta_ad_id
      WHERE ${NORM('c.concept_label')} = ANY($1::text[]) ORDER BY m.meta_ad_id`, [keys]);
  const sg = await db.query(`SELECT count(*)::int AS n FROM meta_ad_suggestions WHERE field = 'concept' AND ${NORM('value_label')} = ANY($1::text[])`, [keys]);
  return {
    rows: r.rows.map((x) => ({ meta_ad_id: x.meta_ad_id, ad_name: x.ad_name, creative_key: x.creative_key, match_status: x.match_status, from: x.concept_label, to: toName, from_type_id: x.concept_type_id, to_type_id: toTypeId })),
    suggestions: sg.rows[0].n,
  };
}

async function planConcept(db, input) {
  const { action } = input;
  const plan = emptyPlan('concept', action);
  const model = await loadConceptModel(db);
  const srcName = cleanName(input.source);
  if (!srcName) { plan.blockers.push('Choose the concept to change'); return finishPlan(plan); }
  const srcKey = keyOf(srcName);
  const srcRow = model.byKey.get(srcKey) || null;
  const aliasHit = !srcRow ? model.aliases.find((a) => a.alias_key === srcKey) : null;
  plan.source = { name: srcRow ? srcRow.name : srcName, key: srcKey, id: srcRow ? srcRow.id : null, listed: !!srcRow, active: srcRow ? srcRow.active : null };
  if (srcRow && !srcRow.active && srcRow.merged_into_id && (action === 'merge' || action === 'rename')) {
    const into = model.byId.get(srcRow.merged_into_id);
    plan.blockers.push(`“${srcRow.name}” was already merged into ${into ? `“${into.name}”` : 'another concept'} and is no longer a concept of its own; nothing to change`);
    return finishPlan(plan);
  }
  if (aliasHit) { plan.blockers.push(`“${srcName}” is already a recorded spelling of ${aliasHit.approved_name ? `“${aliasHit.approved_name}”` : 'a removed concept'}; nothing to change`); return finishPlan(plan); }
  const ownKeys = srcRow ? [srcKey, ...model.aliasKeysOf(srcKey)] : [srcKey];

  if (action === 'deactivate' || action === 'reactivate') {
    if (!srcRow) { plan.blockers.push('Only a concept on the list can be hidden or restored; merge a free-text spelling into one instead'); return finishPlan(plan); }
    const using = await conceptAffected(db, ownKeys, null, null);
    plan.using = { ads: using.rows.length, creatives: new Set(using.rows.map((x) => x.creative_key)).size };
    if (action === 'deactivate') {
      if (!srcRow.active) plan.blockers.push('It is already hidden');
      plan.effects.push('It is removed from the Concept picker everywhere. Nothing is deleted.');
      if (using.rows.length) plan.effects.push(`${using.rows.length} ad${using.rows.length === 1 ? '' : 's'} still carry it: they keep their stored value (shown as legacy) and nothing about them changes. Merge it into another concept instead if you want them to use that one.`);
    } else {
      if (srcRow.active) plan.blockers.push('It is already active');
      if (srcRow.merged_into_id) plan.blockers.push('It was merged into another concept; add the concept again if you need it back');
      plan.effects.push('It is offered in the Concept picker again.');
    }
    return finishPlan(plan);
  }

  let target;
  if (action === 'merge') {
    const tName = cleanName(input.target);
    if (!tName) { plan.blockers.push('Choose the concept to merge it into'); return finishPlan(plan); }
    const tRow = model.byKey.get(keyOf(tName));
    if (!tRow || !tRow.active) { plan.blockers.push(`“${tName}” is not an active concept on the list`); return finishPlan(plan); }
    if (tRow.name_key === srcKey) { plan.blockers.push('A concept cannot be merged into itself'); return finishPlan(plan); }
    target = { name: tRow.name, key: tRow.name_key, id: tRow.id, concept_type_id: conceptTypeId(model, tRow.name) };
  } else if (action === 'rename') {
    const nn = cleanName(input.new_name);
    if (!nn) { plan.blockers.push('Type the new name'); return finishPlan(plan); }
    if (nn.length > MAX_NAME) { plan.blockers.push(`A concept name can be at most ${MAX_NAME} characters`); return finishPlan(plan); }
    if (!srcRow) { plan.blockers.push('Only a concept on the list can be renamed; merge a free-text spelling into one instead'); return finishPlan(plan); }
    if (!srcRow.active) { plan.blockers.push('Restore it before renaming it'); return finishPlan(plan); }
    plan.new_name = nn; plan.new_key = keyOf(nn);
    if (plan.new_key === srcKey) {
      if (nn === srcRow.name) { plan.blockers.push('That is already its name'); return finishPlan(plan); }
      // a respelling (capitalisation / spacing): the same option, shown differently
      target = { name: nn, key: srcKey, id: srcRow.id, concept_type_id: conceptTypeId(model, nn), respell: true };
    } else {
      const clash = model.byKey.get(plan.new_key) || model.aliases.find((a) => a.alias_key === plan.new_key);
      if (clash) { plan.blockers.push(`“${nn}” already exists${clash.name ? '' : ' as a recorded spelling'}. Use Merge to move this concept into it.`); return finishPlan(plan); }
      target = { name: nn, key: plan.new_key, id: null, concept_type_id: conceptTypeId(model, nn), create: true };
    }
  } else { plan.blockers.push('Unknown action'); return finishPlan(plan); }

  plan.target = target;
  const aff = await conceptAffected(db, ownKeys, target.name, target.concept_type_id);
  // a respelling only rewrites labels whose text is actually different
  plan.affected = target.respell ? aff.rows.filter((x) => x.from !== target.name) : aff.rows;
  plan.suggestions = aff.suggestions;
  plan.aliases = srcRow ? model.aliasKeysOf(srcKey) : [];
  plan.effects.push(`Concept on ${plan.affected.length} classification${plan.affected.length === 1 ? '' : 's'} changes from “${plan.source.name}” to “${target.name}”; no other field changes.`);
  if (!target.respell) {
    plan.effects.push(`“${plan.source.name}” is removed from the Concept picker${srcRow ? ' (kept, retired)' : ''} and recorded as a spelling of “${target.name}”, so it is never offered or suggested again.`);
    if (plan.aliases.length) plan.effects.push(`${plan.aliases.length} existing historical spelling${plan.aliases.length === 1 ? '' : 's'} of it now point to “${target.name}”.`);
    if (plan.suggestions) plan.effects.push(`${plan.suggestions} stored suggestion${plan.suggestions === 1 ? '' : 's'} are relabelled.`);
  }
  if (srcRow && srcRow.group_order != null && !target.respell) plan.notes.push('This is one of the approved concepts; the approved list loses it.');
  return finishPlan(plan);
}

async function execConcept(client, plan, userId, changeId) {
  const t = plan.target; const s = plan.source;
  const model = await loadConceptModel(client);
  if (plan.action === 'deactivate') {
    await client.query('UPDATE meta_matching_vocab SET active = false, retired_at = now() WHERE id = $1', [s.id]);
    return;
  }
  if (plan.action === 'reactivate') {
    await client.query('UPDATE meta_matching_vocab SET active = true, retired_at = NULL WHERE id = $1', [s.id]);
    return;
  }
  let targetId = t.id;
  if (t.respell) {
    await client.query('UPDATE meta_matching_vocab SET name = $2 WHERE id = $1', [t.id, t.name]);
  } else if (t.create) {
    const src = model.byId.get(s.id);
    const ins = await client.query(
      `INSERT INTO meta_matching_vocab (kind, name, name_key, group_name, group_order, sort_order, created_by_user_id) VALUES ('concept',$1,$2,$3,$4,$5,$6) RETURNING id`,
      [t.name, t.key, src ? src.group_name : null, src ? src.group_order : null, src ? src.sort_order : null, userId || null]);
    targetId = ins.rows[0].id;
  }
  const ids = plan.affected.map((a) => a.meta_ad_id);
  if (ids.length) {
    await client.query('SELECT 1 FROM meta_ad_classifications WHERE meta_ad_id = ANY($1::text[]) FOR UPDATE', [ids]);
    await client.query('UPDATE meta_ad_classifications SET concept_label = $2, concept_type_id = $3, updated_at = now() WHERE meta_ad_id = ANY($1::text[])', [ids, t.name, t.concept_type_id]);
    for (const a of plan.affected) {
      await client.query('INSERT INTO meta_classification_option_change_items (change_id, meta_ad_id, field, old_value, new_value) VALUES ($1,$2,$3,$4,$5)', [changeId, a.meta_ad_id, 'concept_label', a.from, t.name]);
      if ((a.from_type_id || null) !== (t.concept_type_id || null)) {
        await client.query('INSERT INTO meta_classification_option_change_items (change_id, meta_ad_id, field, old_value, new_value) VALUES ($1,$2,$3,$4,$5)', [changeId, a.meta_ad_id, 'concept_type_id', a.from_type_id == null ? null : String(a.from_type_id), t.concept_type_id == null ? null : String(t.concept_type_id)]);
      }
    }
  }
  if (t.respell) return;
  // stored suggestions (disposable, derived): relabel when that creates no duplicate, otherwise drop the now-duplicate row
  const keys = [s.key, ...plan.aliases];
  await client.query(
    `UPDATE meta_ad_suggestions sg SET value_label = $2, value_key = $3, value_ref = $4
      WHERE sg.field = 'concept' AND ${NORM('sg.value_label')} = ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM meta_ad_suggestions o WHERE o.meta_ad_id = sg.meta_ad_id AND o.field = 'concept' AND o.value_key = $3 AND o.id <> sg.id)`,
    [keys, t.name, t.key, t.concept_type_id]);
  await client.query(`DELETE FROM meta_ad_suggestions WHERE field = 'concept' AND ${NORM('value_label')} = ANY($1::text[])`, [keys]);
  // historical spellings of the old option now mean the new one, and the old option's own spelling is recorded as one
  await client.query(`UPDATE meta_matching_concept_aliases SET approved_name = $2 WHERE NOT removed AND lower(btrim(approved_name)) = $1`, [s.key, t.name]);
  await client.query(
    `INSERT INTO meta_matching_concept_aliases (alias, alias_key, approved_name, removed) VALUES ($1,$2,$3,false)
     ON CONFLICT (alias_key) DO UPDATE SET approved_name = EXCLUDED.approved_name, removed = false`, [s.name, s.key, t.name]);
  if (s.id) await client.query('UPDATE meta_matching_vocab SET active = false, merged_into_id = $2, retired_at = now() WHERE id = $1', [s.id, targetId]);
}

// ----- creator
async function creatorModel(db) {
  const list = await listCreators(db);
  const byKey = new Map(list.items.map((i) => [i.key, i]));
  return { list, byKey };
}
async function creatorAffected(db, key, toName) {
  const r = await db.query(
    `SELECT m.meta_ad_id, m.ad_name, COALESCE(m.meta_creative_id, m.meta_ad_id) AS creative_key, m.match_status, c.creator_name
       FROM meta_ad_classifications c JOIN meta_ads m ON m.meta_ad_id = c.meta_ad_id WHERE ${NORM('c.creator_name')} = $1 ORDER BY m.meta_ad_id`, [key]);
  const sg = await db.query(`SELECT count(*)::int AS n FROM meta_ad_suggestions WHERE field = 'creator' AND ${NORM('value_label')} = $1`, [key]);
  return { rows: r.rows.map((x) => ({ meta_ad_id: x.meta_ad_id, ad_name: x.ad_name, creative_key: x.creative_key, match_status: x.match_status, from: x.creator_name, to: toName })), suggestions: sg.rows[0].n };
}

async function planCreator(db, input) {
  const { action } = input;
  const plan = emptyPlan('creator', action);
  const { byKey } = await creatorModel(db);
  const srcName = cleanName(input.source);
  if (!srcName) { plan.blockers.push('Choose the creator to change'); return finishPlan(plan); }
  const src = byKey.get(keyOf(srcName));
  if (!src) { plan.blockers.push(`“${srcName}” is not a creator on the list or in use`); return finishPlan(plan); }
  plan.source = { name: src.name, key: src.key, id: src.vocab_id, listed: true, roster: src.roster, status: src.status };

  if (action === 'deactivate' || action === 'reactivate') {
    const using = await creatorAffected(db, src.key, null);
    plan.using = { ads: using.rows.length, creatives: new Set(using.rows.map((x) => x.creative_key)).size };
    if (action === 'deactivate') {
      if (src.status !== 'active') plan.blockers.push('It is already hidden');
      plan.effects.push('It is removed from the Creator picker in Ad Matching. Nothing is deleted' + (src.roster ? ' and the filming roster (Shooting) is not affected.' : '.'));
      if (using.rows.length) plan.effects.push(`${using.rows.length} ad${using.rows.length === 1 ? '' : 's'} still carry it and keep their stored value. Merge it into another creator instead if you want them to use that one.`);
    } else {
      if (src.status === 'active') plan.blockers.push('It is already active');
      if (src.status === 'merged') plan.blockers.push('It was merged into another creator; add the creator again if you need it back');
      plan.effects.push('It is offered in the Creator picker again.');
    }
    return finishPlan(plan);
  }

  if (src.roster) { plan.blockers.push(`“${src.name}” is on the filming roster (used by Shooting), so it cannot be ${action === 'merge' ? 'merged away' : 'renamed'} here. You can hide it from Ad Matching, or merge other spellings into it.`); return finishPlan(plan); }
  if (src.status !== 'active') { plan.blockers.push('Restore it first'); return finishPlan(plan); }
  let target;
  if (action === 'merge') {
    const tName = cleanName(input.target);
    const t = tName ? byKey.get(keyOf(tName)) : null;
    if (!t || t.status !== 'active') { plan.blockers.push(tName ? `“${tName}” is not an active creator` : 'Choose the creator to merge it into'); return finishPlan(plan); }
    if (t.key === src.key) { plan.blockers.push('A creator cannot be merged into itself'); return finishPlan(plan); }
    target = { name: t.name, key: t.key, id: t.vocab_id, create: !t.vocab_id };
  } else if (action === 'rename') {
    const nn = cleanName(input.new_name);
    if (!nn) { plan.blockers.push('Type the new name'); return finishPlan(plan); }
    if (nn.length > MAX_NAME) { plan.blockers.push(`A creator name can be at most ${MAX_NAME} characters`); return finishPlan(plan); }
    plan.new_name = nn; plan.new_key = keyOf(nn);
    if (plan.new_key === src.key) {
      if (nn === src.name) { plan.blockers.push('That is already its name'); return finishPlan(plan); }
      target = { name: nn, key: src.key, id: src.vocab_id, respell: true, create: !src.vocab_id };
    } else {
      if (byKey.has(plan.new_key)) { plan.blockers.push(`“${byKey.get(plan.new_key).name}” already exists. Use Merge to move this creator into it.`); return finishPlan(plan); }
      target = { name: nn, key: plan.new_key, id: null, create: true, created_new: true };
    }
  } else { plan.blockers.push('Unknown action'); return finishPlan(plan); }
  plan.target = target;
  const aff = await creatorAffected(db, src.key, target.name);
  plan.affected = target.respell ? aff.rows.filter((x) => x.from !== target.name) : aff.rows;
  plan.suggestions = aff.suggestions;
  plan.effects.push(`Creator on ${plan.affected.length} classification${plan.affected.length === 1 ? '' : 's'} changes from “${plan.source.name}” to “${target.name}”; no other field changes.`);
  if (!target.respell) plan.effects.push(`“${plan.source.name}” is removed from the Creator picker and anything typed as that spelling resolves to “${target.name}”.`);
  return finishPlan(plan);
}

async function execCreator(client, plan, userId, changeId) {
  const t = plan.target; const s = plan.source;
  if (plan.action === 'deactivate' || plan.action === 'reactivate') {
    const on = plan.action === 'reactivate';
    if (s.id) await client.query('UPDATE meta_matching_vocab SET active = $2, retired_at = CASE WHEN $2 THEN NULL ELSE now() END WHERE id = $1', [s.id, on]);
    else if (!on) await client.query(`INSERT INTO meta_matching_vocab (kind, name, name_key, active, retired_at, created_by_user_id) VALUES ('creator',$1,$2,false,now(),$3) ON CONFLICT (kind, name_key) DO UPDATE SET active = false, retired_at = now()`, [s.name, s.key, userId || null]);
    return;
  }
  // the target needs a vocabulary row to point at when the old spelling is retired (an in-use or roster name has none yet)
  let targetId = t.id;
  if (!targetId) {
    const ins = await client.query(`INSERT INTO meta_matching_vocab (kind, name, name_key, created_by_user_id) VALUES ('creator',$1,$2,$3) ON CONFLICT (kind, name_key) DO UPDATE SET active = true, retired_at = NULL RETURNING id`, [t.name, t.key, userId || null]);
    targetId = ins.rows[0].id;
  }
  if (t.respell) {
    if (s.id) await client.query('UPDATE meta_matching_vocab SET name = $2 WHERE id = $1', [s.id, t.name]);
    else await client.query('UPDATE meta_matching_vocab SET name = $2 WHERE id = $1', [targetId, t.name]);
  }
  const ids = plan.affected.map((a) => a.meta_ad_id);
  if (ids.length) {
    await client.query('SELECT 1 FROM meta_ad_classifications WHERE meta_ad_id = ANY($1::text[]) FOR UPDATE', [ids]);
    await client.query('UPDATE meta_ad_classifications SET creator_name = $2, updated_at = now() WHERE meta_ad_id = ANY($1::text[])', [ids, t.name]);
    for (const a of plan.affected) await client.query('INSERT INTO meta_classification_option_change_items (change_id, meta_ad_id, field, old_value, new_value) VALUES ($1,$2,$3,$4,$5)', [changeId, a.meta_ad_id, 'creator_name', a.from, t.name]);
  }
  if (t.respell) return;
  await client.query(
    `UPDATE meta_ad_suggestions sg SET value_label = $2, value_key = $3 WHERE sg.field = 'creator' AND ${NORM('sg.value_label')} = $1
        AND NOT EXISTS (SELECT 1 FROM meta_ad_suggestions o WHERE o.meta_ad_id = sg.meta_ad_id AND o.field = 'creator' AND o.value_key = $3 AND o.id <> sg.id)`, [s.key, t.name, t.key]);
  await client.query(`DELETE FROM meta_ad_suggestions WHERE field = 'creator' AND ${NORM('value_label')} = $1`, [s.key]);
  // retire the old spelling and point it at the new one
  await client.query(
    `INSERT INTO meta_matching_vocab (kind, name, name_key, active, merged_into_id, retired_at, created_by_user_id) VALUES ('creator',$1,$2,false,$3,now(),$4)
     ON CONFLICT (kind, name_key) DO UPDATE SET active = false, merged_into_id = EXCLUDED.merged_into_id, retired_at = now()`, [s.name, s.key, targetId, userId || null]);
}

// ----- creative style
async function planStyle(db, input) {
  const { action } = input;
  const plan = emptyPlan('style', action);
  const list = (await listStyles(db)).items;
  const byName = (n) => list.find((x) => keyOf(x.name) === keyOf(n));
  const src = input.source_id ? list.find((x) => x.id === Number(input.source_id)) : byName(input.source);
  if (!src) { plan.blockers.push('Choose the creative style to change'); return finishPlan(plan); }
  plan.source = { name: src.name, key: keyOf(src.name), id: src.id, listed: true, builtin: src.builtin, status: src.status };
  plan.other_uses = { promotions: src.promotion_uses };
  if (action === 'deactivate' || action === 'reactivate') {
    const aff = await db.query('SELECT count(*)::int AS n FROM meta_ad_classifications WHERE creative_style_id = $1', [src.id]);
    plan.using = { ads: aff.rows[0].n, creatives: src.creatives };
    if (action === 'deactivate') {
      if (src.status !== 'active') plan.blockers.push('It is already hidden in Ad Matching');
      plan.effects.push('It is removed from the Creative Style picker in Ad Matching only. Promotions planning is not affected and nothing is deleted.');
      if (aff.rows[0].n) plan.effects.push(`${aff.rows[0].n} ad${aff.rows[0].n === 1 ? '' : 's'} still carry it and keep it. Merge it into another style instead if you want them to use that one.`);
    } else {
      if (src.status === 'active') plan.blockers.push('It is already shown in Ad Matching');
      plan.effects.push('It is offered in the Creative Style picker again.');
    }
    return finishPlan(plan);
  }
  let target;
  if (action === 'merge') {
    const t = input.target_id ? list.find((x) => x.id === Number(input.target_id)) : byName(input.target);
    if (!t || t.status !== 'active') { plan.blockers.push(t ? `“${t.name}” is hidden in Ad Matching` : 'Choose the creative style to merge it into'); return finishPlan(plan); }
    if (t.id === src.id) { plan.blockers.push('A creative style cannot be merged into itself'); return finishPlan(plan); }
    if (src.status !== 'active') { plan.blockers.push('Restore it before merging it'); return finishPlan(plan); }
    target = { name: t.name, key: keyOf(t.name), id: t.id };
  } else if (action === 'rename') {
    const nn = cleanName(input.new_name);
    if (src.builtin) { plan.blockers.push(`“${src.name}” is a built-in style that Promotions planning uses by name, so it cannot be renamed. Hide it in Ad Matching or merge it into another style instead.`); return finishPlan(plan); }
    if (!nn) { plan.blockers.push('Type the new name'); return finishPlan(plan); }
    if (nn.length > MAX_NAME) { plan.blockers.push(`A creative style name can be at most ${MAX_NAME} characters`); return finishPlan(plan); }
    const clash = list.find((x) => keyOf(x.name) === keyOf(nn) && x.id !== src.id);
    if (clash) { plan.blockers.push(`“${clash.name}” already exists. Use Merge to move this style into it.`); return finishPlan(plan); }
    if (nn === src.name) { plan.blockers.push('That is already its name'); return finishPlan(plan); }
    plan.new_name = nn; plan.new_key = keyOf(nn);
    target = { name: nn, key: keyOf(nn), id: src.id, respell: true };
    plan.effects.push(`The style is renamed from “${src.name}” to “${nn}” everywhere it appears (${src.ads} ad${src.ads === 1 ? '' : 's'} in Ad Matching${src.promotion_uses ? `, ${src.promotion_uses} Promotions record${src.promotion_uses === 1 ? '' : 's'}` : ''}). No classification changes: they point at the same style.`);
    plan.target = target;
    return finishPlan(plan);
  } else { plan.blockers.push('Unknown action'); return finishPlan(plan); }
  plan.target = target;
  const aff = await db.query(
    `SELECT m.meta_ad_id, m.ad_name, COALESCE(m.meta_creative_id, m.meta_ad_id) AS creative_key, m.match_status
       FROM meta_ad_classifications c JOIN meta_ads m ON m.meta_ad_id = c.meta_ad_id WHERE c.creative_style_id = $1 ORDER BY m.meta_ad_id`, [src.id]);
  plan.affected = aff.rows.map((x) => ({ meta_ad_id: x.meta_ad_id, ad_name: x.ad_name, creative_key: x.creative_key, match_status: x.match_status, from: src.name, to: target.name, from_id: src.id, to_id: target.id }));
  const sg = await db.query(`SELECT count(*)::int AS n FROM meta_ad_suggestions WHERE field = 'creative_style' AND value_ref = $1`, [src.id]);
  plan.suggestions = sg.rows[0].n;
  plan.effects.push(`Creative style on ${plan.affected.length} classification${plan.affected.length === 1 ? '' : 's'} changes from “${src.name}” to “${target.name}”; no other field changes.`);
  plan.effects.push(`“${src.name}” is hidden from the Creative Style picker in Ad Matching only. Promotions planning keeps it${src.promotion_uses ? ` (${src.promotion_uses} Promotions record${src.promotion_uses === 1 ? '' : 's'} are not touched)` : ''}.`);
  return finishPlan(plan);
}

async function execStyle(client, plan, userId, changeId) {
  const t = plan.target; const s = plan.source;
  if (plan.action === 'deactivate' || plan.action === 'reactivate') { await client.query('UPDATE creative_styles SET ad_matching_active = $2 WHERE id = $1', [s.id, plan.action === 'reactivate']); return; }
  if (plan.action === 'rename') { await client.query('UPDATE creative_styles SET name = $2 WHERE id = $1', [s.id, t.name]); return; }
  const ids = plan.affected.map((a) => a.meta_ad_id);
  if (ids.length) {
    await client.query('SELECT 1 FROM meta_ad_classifications WHERE meta_ad_id = ANY($1::text[]) FOR UPDATE', [ids]);
    await client.query('UPDATE meta_ad_classifications SET creative_style_id = $2, updated_at = now() WHERE meta_ad_id = ANY($1::text[])', [ids, t.id]);
    for (const a of plan.affected) await client.query('INSERT INTO meta_classification_option_change_items (change_id, meta_ad_id, field, old_value, new_value) VALUES ($1,$2,$3,$4,$5)', [changeId, a.meta_ad_id, 'creative_style_id', String(s.id), String(t.id)]);
  }
  await client.query(
    `UPDATE meta_ad_suggestions sg SET value_ref = $2, value_label = $3, value_key = $4 WHERE sg.field = 'creative_style' AND sg.value_ref = $1
        AND NOT EXISTS (SELECT 1 FROM meta_ad_suggestions o WHERE o.meta_ad_id = sg.meta_ad_id AND o.field = 'creative_style' AND o.value_key = $4 AND o.id <> sg.id)`, [s.id, t.id, t.name, String(t.id)]);
  await client.query(`DELETE FROM meta_ad_suggestions WHERE field = 'creative_style' AND value_ref = $1`, [s.id]);
  await client.query('UPDATE creative_styles SET ad_matching_active = false WHERE id = $1', [s.id]);
}

// ── preview / apply ───────────────────────────────────────────────────────
const PLANNERS = { concept: planConcept, creator: planCreator, style: planStyle };
const EXECUTORS = { concept: execConcept, creator: execCreator, style: execStyle };

function cleanInput(kind, body) {
  assertKind(kind);
  const b = body || {};
  const action = String(b.action || '');
  if (!ACTIONS.includes(action)) throw new HttpError(400, 'Choose rename, merge, hide or restore');
  return { kind, action, source: b.source, target: b.target, new_name: b.new_name, source_id: b.source_id, target_id: b.target_id };
}

const publicPlan = (plan) => ({
  kind: plan.kind, action: plan.action, allowed: plan.allowed, blockers: plan.blockers, notes: plan.notes, effects: plan.effects,
  source: plan.source && { name: plan.source.name, listed: plan.source.listed, builtin: !!plan.source.builtin, roster: !!plan.source.roster },
  target: plan.target && { name: plan.target.name }, new_name: plan.new_name, counts: plan.counts, sample: plan.sample, using: plan.using || null, other_uses: plan.other_uses,
  changes_classifications: plan.changes_classifications, fingerprint: plan.fingerprint,
  sample_truncated: plan.affected.length > SAMPLE_ROWS,
});

// READ-ONLY: what would change. Writes nothing.
async function preview(kind, body) {
  const input = cleanInput(kind, body);
  return publicPlan(await PLANNERS[kind](pool, input));
}

// Applies one change in ONE transaction, after the person confirmed the exact preview they saw.
async function apply(kind, body, userId) {
  const input = cleanInput(kind, body);
  if (!body || body.confirm !== true) throw new HttpError(400, 'This changes records: confirm the preview first');
  if (!body.fingerprint) throw new HttpError(400, 'Preview the change first');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`meta_classification_options:${kind}`]);
    const plan = await PLANNERS[kind](client, input); // re-derived under the lock from what is stored NOW
    if (!plan.allowed) throw Object.assign(new HttpError(409, plan.blockers.join('; ')), { code: 'blocked' });
    if (plan.fingerprint !== String(body.fingerprint)) throw Object.assign(new HttpError(409, 'The affected records changed since the preview. Preview again before applying.'), { code: 'stale_preview' });
    const changeId = await recordChange(client, {
      kind, action: input.action, source: plan.source && plan.source.name, target: plan.target && plan.target.name,
      ads: plan.counts.ads, creatives: plan.counts.creatives,
      details: { counts: plan.counts, effects: plan.effects, fingerprint: plan.fingerprint, new_name: plan.new_name || null }, userId,
    });
    await EXECUTORS[kind](client, plan, userId, changeId);
    await client.query('COMMIT');
    return { applied: true, change_id: changeId, counts: plan.counts, effects: plan.effects };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

async function history(limit = 40, db = pool) {
  const r = await db.query(
    `SELECT h.id, h.kind, h.action, h.source_name, h.target_name, h.affected_ads, h.affected_creatives, h.applied_at, u.name AS user_name
       FROM meta_classification_option_changes h LEFT JOIN users u ON u.id = h.applied_by_user_id ORDER BY h.id DESC LIMIT $1`, [Math.min(200, Math.max(1, limit))]);
  return r.rows.map((x) => ({ ...x, applied_at: new Date(x.applied_at).toISOString() }));
}

module.exports = { KINDS, ACTIONS, BUILTIN_STYLE_NAMES, listOptions, addOption, preview, apply, history, planConcept, planCreator, planStyle };
