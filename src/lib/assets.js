// Shared "create one Creative Asset" write path: the plain create flow
// (creativeAssets.js) and auto-creation when a Required Concept slot is
// generated (dropProductPlans.js) both need the exact same two inserts
// (the asset row + its opening status_history row), so there's only ever
// one definition of what "creating a creative asset" means.
async function insertCreativeAsset(db, {
  style_id,
  concept_name,
  concept_classification = 'new_experimental',
  format,
  is_deliberate_trial = false,
  target_date = null,
  strategy_owner = null,
  filming_owner = null,
  editing_owner = null,
  qc_owner = null,
  status = 'not_started',
}) {
  const result = await db.query(
    `INSERT INTO creative_assets
      (style_id, concept_name, concept_classification, format, is_deliberate_trial, target_date,
       strategy_owner, filming_owner, editing_owner, qc_owner, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [
      style_id,
      concept_name,
      concept_classification,
      format,
      !!is_deliberate_trial,
      target_date,
      strategy_owner,
      filming_owner,
      editing_owner,
      qc_owner,
      status,
    ]
  );
  const asset = result.rows[0];
  await db.query(
    `INSERT INTO status_history (creative_asset_id, from_status, to_status, changed_by) VALUES ($1, NULL, $2, $3)`,
    [asset.id, asset.status, strategy_owner]
  );
  return asset;
}

module.exports = { insertCreativeAsset };
