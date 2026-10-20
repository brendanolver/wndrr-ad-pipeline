const express = require('express');
const { pool } = require('../db');
const { FORMATS, CONCEPT_CLASSIFICATIONS, CONCEPT_ASSIGNEES } = require('../lib/statuses');
const preview = require('../lib/referencePreview');
const { applyPlaybookAssignee } = require('./dropProductPlans');

const router = express.Router();

function validateDefaults(body, res) {
  if (body.default_format && !FORMATS.includes(body.default_format)) {
    res.status(400).json({ error: `default_format must be one of: ${FORMATS.join(', ')}` });
    return false;
  }
  if (body.default_classification && !CONCEPT_CLASSIFICATIONS.includes(body.default_classification)) {
    res.status(400).json({ error: `default_classification must be one of: ${CONCEPT_CLASSIFICATIONS.join(', ')}` });
    return false;
  }
  if (body.default_assignee && !CONCEPT_ASSIGNEES.includes(body.default_assignee)) {
    res.status(400).json({ error: `default_assignee must be one of: ${CONCEPT_ASSIGNEES.join(', ')}, or blank` });
    return false;
  }
  if (body.reference_link && !preview.publicUrl(String(body.reference_link).trim())) {
    res.status(400).json({ error: 'Enter a full web link (https://...) to the reference video or example' });
    return false;
  }
  return true;
}

// The Playbook entry's reference is ONE Reference Library record that the entry links to (never a copy), so every Upcoming Drop concept from this entry shows it. A new link updates that record in place; a cleared
// link only removes the entry's link (the library record itself is left alone). Returns true when a picture needs fetching.
async function saveReference(client, pwId, link, user) {
  const cur = (await client.query('SELECT name, reference_id FROM proven_winners WHERE id = $1', [pwId])).rows[0];
  if (!cur) return null;
  const next = String(link || '').trim();
  if (!next) { if (cur.reference_id) await client.query('UPDATE proven_winners SET reference_id = NULL WHERE id = $1', [pwId]); return null; }
  if (cur.reference_id) {
    const before = (await client.query('SELECT link FROM reference_library WHERE id = $1', [cur.reference_id])).rows[0];
    if (before && before.link === next) return null;
    await client.query('UPDATE reference_library SET link = $1, updated_at = now() WHERE id = $2', [next, cur.reference_id]);
    return { id: cur.reference_id, link: next };
  }
  const inserted = await client.query(
    `INSERT INTO reference_library (link, comment, idea_type, added_by, added_by_user_id) VALUES ($1, $2, 'bau', $3, $4) RETURNING id`,
    [next, `${cur.name} (Creative Playbook reference)`, user && user.name, user && user.id]);
  await client.query('UPDATE proven_winners SET reference_id = $1 WHERE id = $2', [inserted.rows[0].id, pwId]);
  return { id: inserted.rows[0].id, link: next };
}

const FULL_QUERY = `SELECT pw.*, rl.link AS reference_link FROM proven_winners pw LEFT JOIN reference_library rl ON rl.id = pw.reference_id`;

// Rank is a plain integer column; every order-changing mutation rewrites
// the full list's ranks (1..N) inside a transaction rather than juggling
// unique-constraint swaps -- this is also what makes "auto-renumber after
// reorder" literally true.
async function rewriteRanks(client, orderedIds) {
  for (let i = 0; i < orderedIds.length; i += 1) {
    await client.query('UPDATE proven_winners SET rank = $1, updated_at = now() WHERE id = $2', [i + 1, orderedIds[i]]);
  }
}

router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(`${FULL_QUERY} ORDER BY pw.rank ASC`);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { name, description, position, default_format, default_classification, default_assignee, reference_link } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!validateDefaults(req.body || {}, res)) return;

    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM proven_winners ORDER BY rank ASC');
    const existingIds = existing.rows.map((r) => r.id);

    const inserted = await client.query(
      `INSERT INTO proven_winners (name, description, rank, default_format, default_classification, default_assignee)
       VALUES ($1, $2, $3, COALESCE($4, 'video'), COALESCE($5, 'tested_proven'), $6) RETURNING id`,
      [name.trim(), description || null, existingIds.length + 1, default_format || null, default_classification || null, default_assignee || null]
    );
    const newId = inserted.rows[0].id;

    let pos = Number.isInteger(position) ? position : Number.parseInt(position, 10);
    if (!Number.isInteger(pos) || pos < 1) pos = existingIds.length + 1;
    pos = Math.min(pos, existingIds.length + 1);
    existingIds.splice(pos - 1, 0, newId);

    await rewriteRanks(client, existingIds);
    const fetchRef = reference_link ? await saveReference(client, newId, reference_link, req.user) : null;
    await client.query('COMMIT');
    if (fetchRef) await preview.requestPreview(pool, fetchRef.id, fetchRef.link).catch(() => {}); // the picture is fetched in the background after the save

    const full = await pool.query(`${FULL_QUERY} WHERE pw.id = $1`, [newId]);
    res.status(201).json(full.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// Registered before PUT /:id so "/reorder" isn't shadowed as an :id param
// (same convention drops.js follows for GET /suggestions vs GET /:id).
router.put('/reorder', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { ordered_ids } = req.body || {};
    if (!Array.isArray(ordered_ids) || !ordered_ids.length) {
      return res.status(400).json({ error: 'ordered_ids is required' });
    }

    const current = await pool.query('SELECT id FROM proven_winners');
    const currentSet = new Set(current.rows.map((r) => r.id));
    const requestedSet = new Set(ordered_ids.map(Number));
    const sameSize = currentSet.size === requestedSet.size;
    const sameMembers = sameSize && [...currentSet].every((id) => requestedSet.has(id));
    if (!sameMembers) {
      return res.status(400).json({ error: 'ordered_ids must contain exactly the current set of Proven Winner ids' });
    }

    await client.query('BEGIN');
    await rewriteRanks(client, ordered_ids.map(Number));
    await client.query('COMMIT');

    const result = await pool.query('SELECT * FROM proven_winners ORDER BY rank ASC');
    res.json(result.rows);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.put('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { name, description, default_format, default_classification } = req.body || {};
    const body = req.body || {};
    if (name != null && !name.trim()) return res.status(400).json({ error: 'name cannot be blank' });
    if (!validateDefaults(body, res)) return;
    // reference_link / default_assignee: absent = leave as is; blank = clear
    const hasAssignee = Object.prototype.hasOwnProperty.call(body, 'default_assignee');
    const hasReference = Object.prototype.hasOwnProperty.call(body, 'reference_link');

    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE proven_winners SET
         name = COALESCE($1, name), description = $2,
         default_format = COALESCE($3, default_format), default_classification = COALESCE($4, default_classification),
         default_assignee = CASE WHEN $6 THEN $7 ELSE default_assignee END,
         updated_at = now()
       WHERE id = $5 RETURNING id`,
      [name ? name.trim() : null, description || null, default_format || null, default_classification || null, req.params.id, hasAssignee, body.default_assignee || null]
    );
    if (result.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Proven Winner not found' }); }
    const fetchRef = hasReference ? await saveReference(client, req.params.id, body.reference_link, req.user) : null;
    // the Playbook person flows to this concept on every drop (unassigned ones, and ones previously filled from here); saving the entry again is safe and re-applies it
    const applied = await applyPlaybookAssignee(client, Number(req.params.id));
    await client.query('COMMIT');
    if (fetchRef) await preview.requestPreview(pool, fetchRef.id, fetchRef.link).catch(() => {});

    const full = await pool.query(`${FULL_QUERY} WHERE pw.id = $1`, [req.params.id]);
    res.json({ ...full.rows[0], assignee_applied: applied });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
});

router.patch('/:id/active', async (req, res, next) => {
  try {
    const { active } = req.body || {};
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'active must be a boolean' });

    const result = await pool.query(
      `UPDATE proven_winners SET active = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [active, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Proven Winner not found' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deleted = await client.query('DELETE FROM proven_winners WHERE id = $1 RETURNING id', [req.params.id]);
    if (deleted.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Proven Winner not found' });
    }
    const remaining = await client.query('SELECT id FROM proven_winners ORDER BY rank ASC');
    await rewriteRanks(client, remaining.rows.map((r) => r.id));
    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
