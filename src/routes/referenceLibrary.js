const express = require('express');
const { pool } = require('../db');
const apparelmagic = require('../lib/apparelmagic');
const preview = require('../lib/referencePreview');

const router = express.Router();

const IDEA_TYPES = ['bau', 'sale'];

// Image bytes never travel with the list: just whether there is a cover / automatic preview, and the version that busts the browser cache.
const LIST_QUERY = `SELECT rl.id, rl.link, rl.comment, rl.idea_type, rl.category, rl.added_by, rl.added_by_user_id, rl.created_at, rl.updated_at,
  rl.preview_status, rl.preview_source, rl.thumb_version,
  EXISTS (SELECT 1 FROM reference_library_images i WHERE i.reference_id = rl.id AND i.kind = 'cover') AS has_cover,
  EXISTS (SELECT 1 FROM reference_library_images i WHERE i.reference_id = rl.id AND i.kind = 'auto') AS has_auto
  FROM reference_library rl`;
const ID_RE = /^\d{1,9}$/;
const view = (r) => ({ ...r, thumb_url: r.has_cover || r.has_auto ? `/api/reference-library/${r.id}/thumb?v=${r.thumb_version || 0}` : null, thumb_kind: r.has_cover ? 'cover' : r.has_auto ? 'auto' : null });
const getOne = async (id) => { const r = await pool.query(`${LIST_QUERY} WHERE rl.id = $1`, [id]); return r.rows[0] ? view(r.rows[0]) : null; };
const saveCover = (client, id, f) => client.query(`INSERT INTO reference_library_images (reference_id, kind, mime_type, file_name, size_bytes, data) VALUES ($1,'cover',$2,$3,$4,$5)
  ON CONFLICT (reference_id, kind) DO UPDATE SET mime_type = EXCLUDED.mime_type, file_name = EXCLUDED.file_name, size_bytes = EXCLUDED.size_bytes, data = EXCLUDED.data, created_at = now()`, [id, f.type, f.name, f.size, f.buf]);

// Categories offered on the Add/Edit Reference form -- the live AM category
// list (e.g. "BOX FIT TEES", "HEAVY WEIGHT TEES"), the same one Core Shoot
// Planning/High Stocks group products by, not the app's own `categories`
// table (that's a separate Meta campaign/ad-set mapping used by Styles
// admin). No DB round trip: same AD_EXCLUDED_CATEGORY convention as Core
// (the team doesn't run ads for Accessories).
router.get('/categories', async (req, res, next) => {
  try {
    if (!apparelmagic.configured()) return res.json([]);
    const amDetails = await apparelmagic.getStyleCatalogue();
    const categories = new Set();
    for (const details of amDetails.values()) {
      if (!details.category || apparelmagic.isAdExcludedCategory(details)) continue;
      categories.add(details.category);
    }
    res.json([...categories].sort());
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { idea_type, q } = req.query;
    const clauses = [];
    const params = [];

    if (idea_type) {
      if (!IDEA_TYPES.includes(idea_type)) return res.status(400).json({ error: 'idea_type must be bau or sale' });
      params.push(idea_type);
      clauses.push(`rl.idea_type = $${params.length}`);
    }

    if (q && q.trim()) {
      params.push(`%${q.trim().toLowerCase()}%`);
      clauses.push(`(LOWER(rl.comment) LIKE $${params.length} OR LOWER(rl.category) LIKE $${params.length})`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await pool.query(`${LIST_QUERY} ${where} ORDER BY rl.created_at DESC`, params);
    res.json(result.rows.map(view));
    // existing references that have never had a preview attempt get one in the background (a few at a time, preview columns only)
    preview.backfill(pool).catch(() => {});
  } catch (err) {
    next(err);
  }
});

// GET /api/reference-library/:id -> one reference (the page polls this while an automatic preview is being fetched)
router.get('/:id(\\d+)', async (req, res, next) => {
  try {
    const row = await getOne(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Reference not found' });
    res.json(row);
  } catch (err) { next(err); }
});

// GET /api/reference-library/:id/thumb -> the person's own cover if there is one, otherwise the automatic preview
router.get('/:id(\\d+)/thumb', async (req, res, next) => {
  try {
    const img = (await pool.query(`SELECT mime_type, data FROM reference_library_images WHERE reference_id = $1 ORDER BY (kind = 'cover') DESC LIMIT 1`, [Number(req.params.id)])).rows[0];
    if (!img) return res.status(404).json({ error: 'No preview' });
    res.set({ 'Content-Type': img.mime_type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    res.send(img.data);
  } catch (err) { next(err); }
});

// POST /api/reference-library/:id/refresh-preview -> try the automatic preview again (a miss is normal for Instagram / TikTok)
router.post('/:id(\\d+)/refresh-preview', async (req, res, next) => {
  try {
    const cur = (await pool.query('SELECT id, link FROM reference_library WHERE id = $1', [Number(req.params.id)])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Reference not found' });
    await preview.requestPreview(pool, cur.id, cur.link);
    res.json(await getOne(cur.id));
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { link, comment, idea_type, category, cover } = req.body || {};
    if (!link || !link.trim()) return res.status(400).json({ error: 'link is required' });
    if (!comment || !comment.trim()) return res.status(400).json({ error: 'comment is required' });
    if (!IDEA_TYPES.includes(idea_type)) return res.status(400).json({ error: 'idea_type must be bau or sale' });
    // a cover image is optional, but one that is sent has to be a real image -- that is the only thing about the preview that can refuse a save
    const cov = preview.decodeCover(cover); if (cov.error) return res.status(400).json({ error: cov.error });

    // Added-by is always the logged-in user now -- never taken from the
    // client (see the brief: "never manually entered"). This also retires
    // the old client-side one-time "who am I" localStorage prompt, which is
    // genuinely redundant once every request already carries a real
    // identity via requireAuth.
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO reference_library (link, comment, idea_type, category, added_by, added_by_user_id, thumb_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [link.trim(), comment.trim(), idea_type, category && category.trim() ? category.trim() : null, req.user.name, req.user.id, cov.file ? 1 : 0]
    );
    const id = inserted.rows[0].id;
    if (cov.file) await saveCover(client, id, cov.file);
    await client.query('COMMIT');
    // the automatic preview is fetched in the background AFTER the save has succeeded: whatever happens to it, the reference is already saved
    await preview.requestPreview(pool, id, link.trim()).catch(() => {}); // only marks it pending and queues the fetch; the fetch itself runs after the response
    res.status(201).json(await getOne(id));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
});

router.put('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { link, comment, idea_type, category, added_by, cover, remove_cover } = req.body || {};
    if (link != null && !link.trim()) return res.status(400).json({ error: 'link cannot be blank' });
    if (comment != null && !comment.trim()) return res.status(400).json({ error: 'comment cannot be blank' });
    if (idea_type != null && !IDEA_TYPES.includes(idea_type)) return res.status(400).json({ error: 'idea_type must be bau or sale' });
    if (added_by != null && !added_by.trim()) return res.status(400).json({ error: 'added_by cannot be blank' });
    const cov = preview.decodeCover(cover); if (cov.error) return res.status(400).json({ error: cov.error });
    if (!ID_RE.test(String(req.params.id))) return res.status(404).json({ error: 'Reference not found' });

    await client.query('BEGIN');
    const before = (await client.query('SELECT link FROM reference_library WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!before) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Reference not found' }); }
    await client.query(
      `UPDATE reference_library SET
         link = COALESCE($1, link),
         comment = COALESCE($2, comment),
         idea_type = COALESCE($3, idea_type),
         category = $4,
         added_by = COALESCE($5, added_by),
         updated_at = now()
       WHERE id = $6`,
      [
        link ? link.trim() : null,
        comment ? comment.trim() : null,
        idea_type || null,
        category && category.trim() ? category.trim() : null,
        added_by ? added_by.trim() : null,
        req.params.id,
      ]
    );
    let coverChanged = false;
    if (cov.file) { await saveCover(client, req.params.id, cov.file); coverChanged = true; }
    else if (remove_cover) { coverChanged = (await client.query("DELETE FROM reference_library_images WHERE reference_id = $1 AND kind = 'cover'", [req.params.id])).rowCount > 0; }
    if (coverChanged) await client.query('UPDATE reference_library SET thumb_version = thumb_version + 1 WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    // a different link means the automatic preview belongs to the old one -- fetch the new one (a person's own cover is kept)
    if (link && link.trim() !== before.link) await preview.requestPreview(pool, Number(req.params.id), link.trim()).catch(() => {});
    res.json(await getOne(Number(req.params.id)));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await pool.query('DELETE FROM reference_library WHERE id = $1 RETURNING id', [req.params.id]);
    if (deleted.rows.length === 0) return res.status(404).json({ error: 'Reference not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
