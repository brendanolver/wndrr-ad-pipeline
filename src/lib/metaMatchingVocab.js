// Ad Matching vocabulary: the creator and concept names offered by the Ad Matching pickers, and the one way a person adds a new one.
//
//   creators  = content_creators (the filming roster)  +  meta_matching_vocab 'creator' rows (added here, JAMES seeded)
//               +  creator names already used by existing classifications (computed, never copied anywhere)
//   concepts  = concept_types (active)                 +  meta_matching_vocab 'concept' rows (added here)
//               Historical concept text is deliberately NOT offered: the approved list is decided by a person.
//
// Names are compared case-insensitively on trimmed, whitespace-collapsed text, so "james", " James " and "JAMES" are one name. The
// first spelling offered wins (roster / concept_types, then names added here, then names already in use). Adding a name writes ONE
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

// concepts keep their ids: concept_types rows carry concept_type_id; added ones carry vocab_id (their label is saved on the classification)
async function listConcepts(db = pool) {
  const types = await db.query('SELECT id, name, format FROM concept_types WHERE active ORDER BY sort_order, name');
  const added = await db.query("SELECT id, name FROM meta_matching_vocab WHERE kind = 'concept' ORDER BY name");
  return dedupe([
    ...types.rows.map((r) => ({ name: cleanName(r.name), source: 'concept_types', concept_type_id: r.id, format: r.format })),
    ...added.rows.map((r) => ({ name: cleanName(r.name), source: 'added', vocab_id: r.id })),
  ]);
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
      // an INACTIVE concept_types row of that name is still a taken name: never create a second spelling beside it
      const inactive = await client.query('SELECT name FROM concept_types WHERE NOT active AND lower(btrim(name)) = $1', [key]);
      if (inactive.rows.length) throw new HttpError(409, `“${inactive.rows[0].name}” already exists as an inactive concept, so it can't be added again here.`);
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

module.exports = { MAX_NAME, KINDS, cleanName, keyOf, dedupe, listCreators, listConcepts, addName, canonicalCreator, canonicalConcept };
