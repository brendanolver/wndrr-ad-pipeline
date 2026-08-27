const express = require('express');
const { pool } = require('../db');
const { insertCreativeAsset } = require('../lib/assets');
const { STATUS_LABELS } = require('../lib/statuses');

const router = express.Router();

const STOCK_STATUSES = ['in_office', 'needs_to_be_brought_in'];
const SOURCES = ['core', 'high_stock', 'drop', 'promotion'];

router.get('/', async (req, res, next) => {
  try {
    const itemsResult = await pool.query(
      `SELECT spi.*, ca.status AS asset_status
       FROM shoot_plan_items spi
       LEFT JOIN creative_assets ca ON ca.id = spi.asset_id
       WHERE spi.created_at >= date_trunc('week', now())
       ORDER BY spi.created_at ASC`
    );
    const items = itemsResult.rows;

    const stylesResult = items.length
      ? await pool.query(
          `SELECT spis.shoot_plan_item_id, s.id AS style_id, s.style_code, spis.size, spis.colour_label
           FROM shoot_plan_item_styles spis
           JOIN styles s ON s.id = spis.style_id
           WHERE spis.shoot_plan_item_id = ANY($1::int[])`,
          [items.map((i) => i.id)]
        )
      : { rows: [] };
    const stylesByItem = new Map();
    for (const row of stylesResult.rows) {
      if (!stylesByItem.has(row.shoot_plan_item_id)) stylesByItem.set(row.shoot_plan_item_id, []);
      stylesByItem.get(row.shoot_plan_item_id).push({ style_id: row.style_id, style_code: row.style_code, size: row.size, colour_label: row.colour_label });
    }

    res.json(items.map((i) => ({
      id: i.id,
      product_code: i.product_code,
      product_name: i.product_name,
      stock_status: i.stock_status,
      creator: i.creator,
      quick_note: i.initial_idea,
      created_at: i.created_at,
      asset_id: i.asset_id,
      asset_status: i.asset_status,
      asset_status_label: i.asset_status ? (STATUS_LABELS[i.asset_status] || i.asset_status) : null,
      source: i.source,
      image_url: i.image_url,
      styles: stylesByItem.get(i.id) || [],
    })));
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const { product_code, product_name, colourways, stock_status, creator, quick_note, source, image_url } = req.body || {};

  if (!product_code || !product_name) {
    return res.status(400).json({ error: 'product_code and product_name are required' });
  }
  if (!Array.isArray(colourways) || !colourways.length || !colourways.every((c) => c && Number.isFinite(Number(c.style_id)))) {
    return res.status(400).json({ error: 'At least one colourway must be selected' });
  }
  if (!STOCK_STATUSES.includes(stock_status)) {
    return res.status(400).json({ error: 'stock_status must be in_office or needs_to_be_brought_in' });
  }
  if (!creator || !creator.trim()) {
    return res.status(400).json({ error: 'Content creator is required' });
  }
  if (source !== undefined && source !== null && !SOURCES.includes(source)) {
    return res.status(400).json({ error: `source must be one of ${SOURCES.join(', ')}` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const trimmedCreator = creator.trim();
    const trimmedNote = quick_note && quick_note.trim() ? quick_note.trim() : null;

    const asset = await insertCreativeAsset(client, {
      style_id: Number(colourways[0].style_id),
      concept_name: trimmedNote || `New Concept — ${product_name}`,
      concept_classification: 'new_experimental',
      format: 'video',
      strategy_owner: trimmedCreator,
      status: 'awaiting_concept_development',
    });

    const itemResult = await client.query(
      `INSERT INTO shoot_plan_items (product_code, product_name, stock_status, creator, initial_idea, asset_id, source, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [product_code, product_name, stock_status, trimmedCreator, trimmedNote, asset.id, source || null, image_url || null]
    );
    const item = itemResult.rows[0];

    for (const c of colourways) {
      await client.query(
        `INSERT INTO shoot_plan_item_styles (shoot_plan_item_id, style_id, size, colour_label) VALUES ($1, $2, $3, $4)`,
        [item.id, Number(c.style_id), c.size && String(c.size).trim() ? String(c.size).trim() : null, c.colour_label || null]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({
      ...item,
      quick_note: item.initial_idea,
      asset_status: asset.status,
      asset_status_label: STATUS_LABELS[asset.status] || asset.status,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM shoot_plan_items WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Shoot plan item not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
