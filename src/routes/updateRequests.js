// Update Requests API. Any signed-in user can read and raise requests (it is a shared board); changing one is limited to its author or an admin.
const express = require('express');
const { pool } = require('../db');
const ur = require('../lib/updateRequests');

const router = express.Router();
const ID_RE = /^\d{1,9}$/;

const view = (r, atts, user) => ({
  id: r.id, body: r.body, priority: r.priority, priority_label: ur.PRIORITIES[r.priority] || r.priority, status: r.status,
  requested_by: r.created_by_name || 'Unknown', created_at: r.created_at, resolved_at: r.resolved_at, resolved_by: r.resolved_by_name || null,
  can_modify: ur.canModify(user, r),
  attachments: (atts || []).map((a) => ({ id: a.id, name: a.file_name, type: a.mime_type, size: a.size_bytes, url: `/api/update-requests/${r.id}/attachments/${a.id}` })),
});

async function loadOne(id, user) {
  const r = (await pool.query('SELECT * FROM update_requests WHERE id = $1', [id])).rows[0];
  if (!r) return null;
  const atts = (await pool.query('SELECT id, file_name, mime_type, size_bytes FROM update_request_attachments WHERE request_id = $1 ORDER BY id', [id])).rows;
  return view(r, atts, user);
}

// GET /api/update-requests?status=open|resolved|all -> by priority, then newest first
router.get('/', async (req, res, next) => {
  try {
    const status = ['open', 'resolved', 'all'].includes(req.query.status) ? req.query.status : 'open';
    const where = status === 'all' ? '' : 'WHERE status = $1';
    const rows = (await pool.query(`SELECT * FROM update_requests ${where} ORDER BY ${status === 'resolved' ? 'resolved_at DESC NULLS LAST,' : ''} priority, created_at DESC, id DESC`, status === 'all' ? [] : [status])).rows;
    const atts = rows.length ? (await pool.query('SELECT id, request_id, file_name, mime_type, size_bytes FROM update_request_attachments WHERE request_id = ANY($1) ORDER BY id', [rows.map((r) => r.id)])).rows : [];
    const counts = (await pool.query("SELECT status, COUNT(*)::int n FROM update_requests GROUP BY status")).rows;
    res.json({
      priorities: Object.entries(ur.PRIORITIES).map(([key, label]) => ({ key, label })),
      limits: { max_files: ur.MAX_FILES_PER_REQUEST, max_file_bytes: ur.MAX_FILE_BYTES, max_body: ur.MAX_BODY },
      counts: { open: (counts.find((c) => c.status === 'open') || {}).n || 0, resolved: (counts.find((c) => c.status === 'resolved') || {}).n || 0 },
      requests: rows.map((r) => view(r, atts.filter((a) => a.request_id === r.id), req.user)),
    });
  } catch (err) { next(err); }
});

// GET /api/update-requests/:id/attachments/:aid -> the file itself (images and PDFs only, served with their sniffed type)
router.get('/:id/attachments/:aid', async (req, res, next) => {
  try {
    if (!ID_RE.test(req.params.id) || !ID_RE.test(req.params.aid)) return res.status(404).json({ error: 'Not found' });
    const a = (await pool.query('SELECT file_name, mime_type, data FROM update_request_attachments WHERE id = $1 AND request_id = $2', [Number(req.params.aid), Number(req.params.id)])).rows[0];
    if (!a) return res.status(404).json({ error: 'Not found' });
    res.set({ 'Content-Type': a.mime_type, 'Content-Disposition': `inline; filename="${a.file_name.replace(/[^\x20-\x7e]/g, '_')}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
    res.send(a.data);
  } catch (err) { next(err); }
});

// POST /api/update-requests { body, priority?, attachments?: [{ name, data(base64) }] }
router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    const body = ur.cleanBody(b.body); if (body.error) return res.status(400).json({ error: body.error });
    const priority = ur.cleanPriority(b.priority); if (!priority) return res.status(400).json({ error: 'priority must be P1, P2, P3 or P4' });
    const dec = ur.decodeAttachments(b.attachments); if (dec.error) return res.status(400).json({ error: dec.error });
    await client.query('BEGIN');
    const r = (await client.query('INSERT INTO update_requests (body, priority, created_by_user_id, created_by_name) VALUES ($1,$2,$3,$4) RETURNING id', [body.value, priority, req.user.id, req.user.name])).rows[0];
    for (const f of dec.files) await client.query('INSERT INTO update_request_attachments (request_id, file_name, mime_type, size_bytes, data) VALUES ($1,$2,$3,$4,$5)', [r.id, f.name, f.type, f.size, f.buf]);
    await client.query('COMMIT');
    res.status(201).json(await loadOne(r.id, req.user));
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); next(err); } finally { client.release(); }
});

// PATCH /api/update-requests/:id { body?, priority?, status?: open|resolved, add_attachments?, remove_attachment_ids? } -- author or admin
router.patch('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const id = Number(req.params.id);
    const cur = (await client.query('SELECT * FROM update_requests WHERE id = $1', [id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    if (!ur.canModify(req.user, cur)) return res.status(403).json({ error: 'Only the person who raised a request, or an admin, can change it.' });
    const b = req.body || {};
    const sets = []; const vals = [];
    const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.body !== undefined) { const body = ur.cleanBody(b.body); if (body.error) return res.status(400).json({ error: body.error }); set('body', body.value); }
    if (b.priority !== undefined) { const p = ur.cleanPriority(b.priority); if (!p) return res.status(400).json({ error: 'priority must be P1, P2, P3 or P4' }); set('priority', p); }
    if (b.status !== undefined) {
      if (!['open', 'resolved'].includes(b.status)) return res.status(400).json({ error: "status must be 'open' or 'resolved'" });
      set('status', b.status);
      if (b.status === 'resolved' && cur.status !== 'resolved') { set('resolved_at', new Date()); set('resolved_by_user_id', req.user.id); set('resolved_by_name', req.user.name); }
      if (b.status === 'open') { sets.push('resolved_at = NULL', 'resolved_by_user_id = NULL', 'resolved_by_name = NULL'); }
    }
    const removeIds = Array.isArray(b.remove_attachment_ids) ? b.remove_attachment_ids.filter((x) => ID_RE.test(String(x))).map(Number) : [];
    const keep = Number((await client.query('SELECT COUNT(*)::int n FROM update_request_attachments WHERE request_id = $1 AND NOT (id = ANY($2))', [id, removeIds])).rows[0].n);
    const dec = ur.decodeAttachments(b.add_attachments, { existing: keep }); if (dec.error) return res.status(400).json({ error: dec.error });
    await client.query('BEGIN');
    if (sets.length) { sets.push('updated_at = now()'); vals.push(id); await client.query(`UPDATE update_requests SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals); }
    if (removeIds.length) await client.query('DELETE FROM update_request_attachments WHERE request_id = $1 AND id = ANY($2)', [id, removeIds]);
    for (const f of dec.files) await client.query('INSERT INTO update_request_attachments (request_id, file_name, mime_type, size_bytes, data) VALUES ($1,$2,$3,$4,$5)', [id, f.name, f.type, f.size, f.buf]);
    await client.query('COMMIT');
    res.json(await loadOne(id, req.user));
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); next(err); } finally { client.release(); }
});

// DELETE /api/update-requests/:id -- author or admin (the attachments go with it)
router.delete('/:id', async (req, res, next) => {
  try {
    if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const cur = (await pool.query('SELECT id, created_by_user_id FROM update_requests WHERE id = $1', [Number(req.params.id)])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    if (!ur.canModify(req.user, cur)) return res.status(403).json({ error: 'Only the person who raised a request, or an admin, can delete it.' });
    await pool.query('DELETE FROM update_requests WHERE id = $1', [cur.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
