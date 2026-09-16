const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// A reusable, editable vocabulary of ad/concept formats (e.g. "Green Screen
// Video", "POV") -- deliberately separate from proven_winners (see
// schema.sql's comment on this table). Only active rows are relevant to
// pickers; sort_order lets the team curate the list's order over time.
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM concept_types WHERE active = true ORDER BY sort_order ASC, name ASC`
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// "Other / New Type" always resolves to exactly one row per name -- an
// existing type (case-insensitive match) is returned as-is rather than
// duplicated, so the same typed-in name reuses the same row every time.
router.post('/', async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    const trimmedName = name.trim();

    const existing = await pool.query(
      `SELECT * FROM concept_types WHERE LOWER(name) = LOWER($1)`,
      [trimmedName]
    );
    if (existing.rows.length) return res.status(200).json(existing.rows[0]);

    const result = await pool.query(
      `INSERT INTO concept_types (name) VALUES ($1) RETURNING *`,
      [trimmedName]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      const existing = await pool.query(`SELECT * FROM concept_types WHERE LOWER(name) = LOWER($1)`, [(req.body.name || '').trim()]);
      if (existing.rows.length) return res.status(200).json(existing.rows[0]);
    }
    next(err);
  }
});

module.exports = router;
