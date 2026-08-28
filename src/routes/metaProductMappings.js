const express = require('express');
const { pool } = require('../db');
const { parseMetaAdName, resolveMetaProduct, listProductFamilies } = require('../lib/metaProductMapping');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    // Unmapped first -- that's the actionable list; already-mapped combos
    // are just for reference/re-mapping.
    const result = await pool.query(
      `SELECT * FROM meta_product_mappings
       ORDER BY (product_code IS NULL) DESC, meta_product ASC, meta_product_type ASC`
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.get('/product-families', async (req, res, next) => {
  try {
    res.json(await listProductFamilies());
  } catch (err) {
    next(err);
  }
});

// The "Check Mapping" step of the eventual Meta Ad Name -> Parse -> Check
// Mapping -> Internal Product Family -> Attribute Creative Coverage flow.
// Accepts either a raw ad name (parsed here) or an already-split Product +
// Product Type pair. Never guesses: an unrecognised combination is
// recorded (and returned) as Unmapped rather than matched to anything.
router.post('/check', async (req, res, next) => {
  try {
    const { ad_name, meta_product, meta_product_type } = req.body || {};
    let product = meta_product;
    let productType = meta_product_type;
    let batchNo = null;

    if (ad_name && (!product || !productType)) {
      const parsed = parseMetaAdName(ad_name);
      if (!parsed) {
        return res.status(400).json({ error: 'Could not parse a Product + Product Type from that ad name — expected "Product + Product Type" (e.g. "HALO SWEAT SET + SWEATS")' });
      }
      product = parsed.product;
      productType = parsed.productType;
      batchNo = parsed.batchNo;
    }

    if (!product || !productType) {
      return res.status(400).json({ error: 'ad_name, or both meta_product and meta_product_type, is required' });
    }

    const mapping = await resolveMetaProduct(product, productType);
    res.json({ mapping, batch_no: batchNo });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { product_code, product_name } = req.body || {};
    if (!product_code || !product_name) {
      return res.status(400).json({ error: 'product_code and product_name are required' });
    }
    // The picker is always sourced from real tracked families -- re-check
    // against the live list rather than trusting the client, so a mapping
    // can never point at a family that doesn't (or no longer) exists.
    const families = await listProductFamilies();
    if (!families.some((f) => f.product_code === product_code)) {
      return res.status(400).json({ error: 'product_code does not match a known internal product family' });
    }

    const result = await pool.query(
      `UPDATE meta_product_mappings SET product_code = $1, product_name = $2, mapped_at = now(), updated_at = now()
       WHERE id = $3 RETURNING *`,
      [product_code, product_name, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Mapping not found' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM meta_product_mappings WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Mapping not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
