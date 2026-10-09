// Ad Matching vocabulary: the creator and concept names offered by the Ad Matching pickers, and the one way a person adds a new one.
//
//   creators  = content_creators (the filming roster)  +  meta_matching_vocab 'creator' rows (added here, JAMES seeded)
//               +  creator names already used by existing classifications (computed, never copied anywhere)
//   concepts  = the APPROVED concept list: meta_matching_vocab 'concept' rows (the people-approved concepts, seeded, plus any a person
//               adds later). concept_types rows that are not approved are NOT offered. Historical spellings map to an approved concept
//               through meta_matching_concept_aliases, applied only when a suggestion / inventory row is READ (nothing is rewritten).
//
// Names are compared case-insensitively on trimmed, whitespace-collapsed text, so "james", " James " and "JAMES" are one name. The
// first spelling offered wins (roster, then names added here, then names already in use). Adding a name writes ONE
// row to meta_matching_vocab; it never edits a classification, never merges or renames anything, and never touches content_creators
// or concept_types. Local database only.
const { pool } = require('../db');
const { HttpError } = require('./metaPerformance');

const MAX_NAME = 100;
const KINDS = ['creator', 'concept'];

// trim + collapse inner whitespace; null when there is nothing left
function cleanName(raw) {
  const s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s || null;
}
const keyOf = (name) => (cleanName(name) || '').toLowerCase();

// first spelling per key wins; items: [{ name, ... }] in priority order
function dedupe(items) {
  const seen = new Map();
  for (const it of items) {
    const k = keyOf(it.name);
    if (k && !seen.has(k)) seen.set(k, it);
  }
  return [...seen.values()];
}

async function listCreators(db = pool) {
  // sequential on purpose: `db` may be a single transaction client, which must not run queries concurrently
  const roster = await db.query('SELECT name FROM content_creators ORDER BY name');
  const added = await db.query("SELECT name FROM meta_matching_vocab WHERE kind = 'creator' ORDER BY name");
  const used = await db.query("SELECT DISTINCT btrim(creator_name) AS name FROM meta_ad_classifications WHERE creator_name IS NOT NULL AND btrim(creator_name) <> '' ORDER BY 1");
  return dedupe([
    ...roster.rows.map((r) => ({ name: cleanName(r.name), source: 'roster' })),
    ...added.rows.map((r) => ({ name: cleanName(r.name), source: 'added' })),
    ...used.rows.map((r) => ({ name: cleanName(r.name), source: 'in_use' })),
  ]);
}

// The concept list Ad Matching OFFERS is the approved vocabulary (meta_matching_vocab, kind 'concept': the people-approved concepts plus
// any a person adds later). When an approved concept has the same name (any capitalisation) as an active concept_types row it carries
// that row's id, so a classification made from it stays in the same concept as the app's existing concept record; concept_types rows
// that are not approved are NOT offered here.
async function listConcepts(db = pool) {
  // approved baseline first, in the approved group + position order; concepts a person added later (no group) follow, alphabetically
  const added = await db.query("SELECT id, name, group_name, group_order, sort_order FROM meta_matching_vocab WHERE kind = 'concept' ORDER BY group_order NULLS LAST, sort_order NULLS LAST, name");
  const types = await db.query('SELECT id, name, format FROM concept_types WHERE active ORDER BY sort_order, id');
  const typeByKey = new Map();
  for (const t of types.rows) { const k = keyOf(t.name); if (k && !typeByKey.has(k)) typeByKey.set(k, t); }
  return dedupe(added.rows.map((r) => {
    const t = typeByKey.get(keyOf(r.name));
    return { name: cleanName(r.name), source: 'approved', vocab_id: r.id, concept_type_id: t ? t.id : null, format: t ? t.format : null, group: r.group_name || null, group_order: r.group_order || null };
  }));
}

// Historical spelling -> approved concept. Pure lookup built once per request; never writes. status:
//   approved  the text IS an approved concept (any capitalisation)       alias     a known historical spelling of one
//   removed   a historical concept that was deliberately dropped         unlisted  anything else (stays legacy text, never guessed)
// approved concept key -> its known historical spellings (for SEARCH only: typing a historical spelling finds the approved concept)
async function listConceptAliases(db = pool) {
  const rows = (await db.query('SELECT alias, approved_name FROM meta_matching_concept_aliases WHERE NOT removed ORDER BY alias')).rows;
  const out = new Map();
  for (const r of rows) { const k = keyOf(r.approved_name); if (!out.has(k)) out.set(k, []); out.get(k).push(r.alias); }
  return out;
}

function makeConceptResolver(approved, aliasRows) {
  const byKey = new Map(approved.map((c) => [keyOf(c.name), c]));
  const aliases = new Map(aliasRows.map((a) => [a.alias_key, a]));
  const ids = (c) => ({ name: c.name, concept_type_id: c.concept_type_id || null, vocab_id: c.vocab_id || null });
  const resolve = (label) => {
    const k = keyOf(label);
    if (!k) return { status: 'empty', name: null, concept_type_id: null, vocab_id: null };
    const hit = byKey.get(k);
    if (hit) return { status: 'approved', ...ids(hit) };
    const al = aliases.get(k);
    if (al && al.removed) return { status: 'removed', name: null, concept_type_id: null, vocab_id: null };
    if (al) { const t = byKey.get(keyOf(al.approved_name)); if (t) return { status: 'alias', from: cleanName(label), ...ids(t) }; }
    return { status: 'unlisted', name: cleanName(label), concept_type_id: null, vocab_id: null };
  };
  resolve.approved = approved;
  return resolve;
}
async function loadConceptResolver(db = pool) {
  const approved = await listConcepts(db);
  const aliasRows = (await db.query('SELECT alias, alias_key, approved_name, removed FROM meta_matching_concept_aliases')).rows;
  return makeConceptResolver(approved, aliasRows);
}

// Add a name (or return the one that already exists under any capitalisation). Never throws for a duplicate: it reports
// created:false with the canonical spelling so the caller just selects it.
async function addName(kind, raw, userId, db = pool) {
  if (!KINDS.includes(kind)) throw new HttpError(400, 'Unknown vocabulary');
  const name = cleanName(raw);
  if (!name) throw new HttpError(400, `Type a ${kind} name to add`);
  if (name.length > MAX_NAME) throw new HttpError(400, `A ${kind} name can be at most ${MAX_NAME} characters`);
  const key = name.toLowerCase();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // serialise adds of one kind so two people adding "x" and "X" at once cannot both pass the existence check
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`meta_matching_vocab:${kind}`]);
    const list = kind === 'creator' ? await listCreators(client) : await listConcepts(client);
    const existing = list.find((x) => keyOf(x.name) === key);
    if (existing) {
      await client.query('COMMIT');
      return { kind, created: false, name: existing.name, source: existing.source, concept_type_id: existing.concept_type_id || null, vocab_id: existing.vocab_id || null };
    }
    if (kind === 'concept') {
      // a known historical spelling of an approved concept resolves to that concept; a removed one is not silently re-added
      const al = await client.query('SELECT alias, approved_name, removed FROM meta_matching_concept_aliases WHERE alias_key = $1', [key]);
      if (al.rows.length && al.rows[0].removed) throw new HttpError(409, `“${al.rows[0].alias}” was removed from the approved concept list, so it can't be added again here.`);
      if (al.rows.length) {
        const target = list.find((x) => keyOf(x.name) === keyOf(al.rows[0].approved_name));
        if (target) {
          await client.query('COMMIT');
          return { kind, created: false, name: target.name, source: target.source, concept_type_id: target.concept_type_id || null, vocab_id: target.vocab_id || null, alias_of: al.rows[0].approved_name };
        }
      }
    }
    const ins = await client.query(
      `INSERT INTO meta_matching_vocab (kind, name, name_key, created_by_user_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (kind, name_key) DO NOTHING RETURNING id, name`,
      [kind, name, key, userId || null]
    );
    await client.query('COMMIT');
    if (!ins.rows.length) {
      const again = await db.query('SELECT id, name FROM meta_matching_vocab WHERE kind = $1 AND name_key = $2', [kind, key]);
      return { kind, created: false, name: again.rows[0].name, source: 'added', concept_type_id: null, vocab_id: again.rows[0].id };
    }
    return { kind, created: true, name: ins.rows[0].name, source: 'added', concept_type_id: null, vocab_id: ins.rows[0].id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// the offered spelling of a creator typed in any capitalisation (null = not in the vocabulary)
async function canonicalCreator(raw, db = pool) {
  const key = keyOf(raw);
  if (!key) return null;
  const hit = (await listCreators(db)).find((x) => keyOf(x.name) === key);
  return hit ? hit.name : null;
}
// the offered concept for a typed label: { name, concept_type_id|null, vocab_id|null } or null
async function canonicalConcept(raw, db = pool) {
  const key = keyOf(raw);
  if (!key) return null;
  const hit = (await listConcepts(db)).find((x) => keyOf(x.name) === key);
  return hit ? { name: hit.name, concept_type_id: hit.concept_type_id || null, vocab_id: hit.vocab_id || null } : null;
}

module.exports = { MAX_NAME, KINDS, cleanName, keyOf, dedupe, listCreators, listConcepts, listConceptAliases, makeConceptResolver, loadConceptResolver, addName, canonicalCreator, canonicalConcept };
