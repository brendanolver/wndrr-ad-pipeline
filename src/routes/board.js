const express = require('express');
const { pool } = require('../db');
const { STATUSES, STATUS_LABELS, STATUS_OWNER_FIELD } = require('../lib/statuses');

const router = express.Router();

// One row per creative asset (= one Kanban card), with the style it
// belongs to, its category, and when it last entered its current status
// (so the UI can surface "how long has this been sitting here").
const CARD_QUERY = `
  SELECT
    ca.*,
    s.style_code, s.name AS style_name, s.tier AS style_tier,
    c.name AS category_name,
    (
      SELECT sh.changed_at FROM status_history sh
      WHERE sh.creative_asset_id = ca.id AND sh.to_status = ca.status
      ORDER BY sh.changed_at DESC LIMIT 1
    ) AS stage_entered_at
  FROM creative_assets ca
  JOIN styles s ON s.id = ca.style_id
  LEFT JOIN categories c ON c.id = s.category_id
  ORDER BY ca.target_date NULLS LAST, ca.id
`;

router.get('/', async (req, res, next) => {
  try {
    const cardsResult = await pool.query(CARD_QUERY);
    const columns = STATUSES.map((status) => ({ status, label: STATUS_LABELS[status], cards: [] }));
    const columnByStatus = Object.fromEntries(columns.map((col) => [col.status, col]));

    for (const row of cardsResult.rows) {
      const ownerField = STATUS_OWNER_FIELD[row.status];
      const card = {
        ...row,
        current_owner: row[ownerField] || null,
        days_in_stage: row.stage_entered_at
          ? Math.floor((Date.now() - new Date(row.stage_entered_at).getTime()) / (1000 * 60 * 60 * 24))
          : null,
      };
      columnByStatus[row.status].cards.push(card);
    }

    const stylesResult = await pool.query(`
      SELECT s.id, s.style_code, s.name, s.tier,
        EXISTS(SELECT 1 FROM creative_assets ca WHERE ca.style_id = s.id AND ca.status = 'uploaded_live') AS has_live_asset,
        EXISTS(SELECT 1 FROM creative_assets ca WHERE ca.style_id = s.id AND ca.status IN ('awaiting_proven_concept', 'awaiting_concept_development')) AS has_awaiting_hold
      FROM styles s
    `);
    const missingAdStyles = stylesResult.rows
      .filter((s) => !s.has_live_asset && !s.has_awaiting_hold)
      .map(({ has_live_asset, has_awaiting_hold, ...rest }) => rest);

    res.json({ columns, missing_ad_styles: missingAdStyles });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
