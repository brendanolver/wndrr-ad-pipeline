// Meta Product Mapping: turns a raw Meta ad name into the internal product
// family it should be attributed to, without ever guessing. See
// schema.sql's comment on meta_product_mappings for the full rationale.
//
// Flow this module implements (the "Check Mapping" half of the eventual
// Meta Ad Name -> Parse -> Check Mapping -> Internal Product Family ->
// Attribute Creative Coverage pipeline):
//   parseMetaAdName(adName) -> { product, productType, batchNo }
//   resolveMetaProduct(db, product, productType) -> the mapping row,
//     inserting it as Unmapped (product_code NULL) the first time this
//     exact combination is seen, rather than picking a guess.

const { pool } = require('../db');
const { deriveProductCode } = require('./apparelmagic');

// Meta's naming convention concatenates Product, Product Type, and
// (optionally) a Batch No, joined by " + " -- e.g. "HALO SWEAT SET +
// SWEATS" or "HALO SWEAT SET + SWEATS + B12". Only the first two segments
// ever feed the mapping key; a third segment is Batch No and is returned
// separately, purely as metadata -- never used for attribution, since one
// batch can span multiple products or an entire drop.
function parseMetaAdName(adName) {
  const parts = String(adName || '').split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const [product, productType, batchNo] = parts;
  return { product, productType, batchNo: batchNo || null };
}

// Looks up (or, the first time this exact combination is seen, records as
// Unmapped) the mapping for a Product + Product Type pair. Matching is
// case-insensitive (Meta ad names aren't guaranteed consistent casing) but
// otherwise exact -- no fuzzy/partial matching, so a combination that
// isn't a confident match always surfaces as Unmapped for a human to
// resolve, per the brief.
async function resolveMetaProduct(metaProduct, metaProductType, db = pool) {
  const product = String(metaProduct || '').trim();
  const productType = String(metaProductType || '').trim();
  if (!product || !productType) return null;

  const existing = await db.query(
    `SELECT * FROM meta_product_mappings WHERE UPPER(meta_product) = UPPER($1) AND UPPER(meta_product_type) = UPPER($2)`,
    [product, productType]
  );
  if (existing.rows.length) return existing.rows[0];

  const inserted = await db.query(
    `INSERT INTO meta_product_mappings (meta_product, meta_product_type)
     VALUES ($1, $2)
     ON CONFLICT (UPPER(meta_product), UPPER(meta_product_type)) DO NOTHING
     RETURNING *`,
    [product, productType]
  );
  if (inserted.rows.length) return inserted.rows[0];

  // Lost a race with a concurrent insert of the exact same combination --
  // the row now exists, just re-select it.
  const reSelected = await db.query(
    `SELECT * FROM meta_product_mappings WHERE UPPER(meta_product) = UPPER($1) AND UPPER(meta_product_type) = UPPER($2)`,
    [product, productType]
  );
  return reSelected.rows[0] || null;
}

// The picker source for "which internal product family does this map to" --
// every locally-tracked style (Core, Drop-assigned, etc.), grouped by the
// same product_code family key coverage.js/coreProducts.js already group
// by, so a mapping's target is always one of these already-real families,
// never a free-typed name.
async function listProductFamilies(db = pool) {
  const result = await db.query('SELECT style_code, name FROM styles ORDER BY style_code ASC');
  const byCode = new Map();
  for (const row of result.rows) {
    const code = deriveProductCode(row.style_code);
    if (!byCode.has(code)) byCode.set(code, { product_code: code, product_name: row.name });
  }
  return [...byCode.values()].sort((a, b) => a.product_name.localeCompare(b.product_name));
}

module.exports = { parseMetaAdName, resolveMetaProduct, listProductFamilies };
