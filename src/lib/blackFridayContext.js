const { pool } = require('../db');

// Finds the Black Friday (or any Promotion-with-master-ideas) idea a
// creative asset's production job came from, purely by reversing the
// existing linked_creative_asset_id relationship (promotionCreative.js's
// send-to-pipeline routes are the only writers of that column) -- an
// execution's own deliberate override is checked first, falling back to the
// master idea's shared asset, mirroring loadIdeasForPromotion's
// effective_creative_asset_id resolution exactly so this never disagrees
// with what the Black Friday tab itself shows. Also returns every OTHER
// stage execution of the same master idea that resolves to this SAME asset
// (e.g. Hype + Live sharing one shoot) so callers can show that
// shared-footage relationship rather than naming only one stage. Returns
// null for any shoot/concept that didn't come from this system (the normal
// case for Core/High Stock/Drop/manual, and for a Promotion concept created
// before this master-idea model existed).
//
// Shared by Shooting's own Shoot Brief (GET /shooting/:id/brief) and
// Concept Development's product list (GET /concept-development) -- one
// definition of "what Black Friday idea is this production record for",
// never two disagreeing copies of the same reverse lookup.
async function loadBlackFridayShootContext(creativeAssetId) {
  if (!creativeAssetId) return null;
  const ownerResult = await pool.query(
    `SELECT pci.id AS idea_id
     FROM promotion_creative_idea_executions pcie
     JOIN promotion_creative_ideas pci ON pci.id = pcie.promotion_creative_idea_id
     WHERE pcie.linked_creative_asset_id = $1
     UNION
     SELECT pci.id AS idea_id
     FROM promotion_creative_ideas pci
     WHERE pci.linked_creative_asset_id = $1
     LIMIT 1`,
    [creativeAssetId]
  );
  if (!ownerResult.rows.length) return null;
  const ideaId = ownerResult.rows[0].idea_id;

  const ideaResult = await pool.query(
    `SELECT pci.id, pci.title, pci.who, pci.where_text, pci.concept_script, pci.need_text,
            pci.linked_creative_asset_id, p.name AS promotion_name
     FROM promotion_creative_ideas pci
     JOIN promotions p ON p.id = pci.promotion_id
     WHERE pci.id = $1`,
    [ideaId]
  );
  if (!ideaResult.rows.length) return null;
  const idea = ideaResult.rows[0];

  const executionsResult = await pool.query(
    `SELECT pcie.linked_creative_asset_id, ps.name AS stage_name, ps.sort_order AS stage_sort_order,
            cs.name AS style_name
     FROM promotion_creative_idea_executions pcie
     JOIN promotion_stages ps ON ps.id = pcie.promotion_stage_id
     LEFT JOIN creative_styles cs ON cs.id = pcie.creative_style_id
     WHERE pcie.promotion_creative_idea_id = $1
     ORDER BY ps.sort_order ASC`,
    [ideaId]
  );
  const sharedStages = executionsResult.rows
    .filter((ex) => (ex.linked_creative_asset_id || idea.linked_creative_asset_id) === creativeAssetId)
    .map((ex) => ({ stage_name: ex.stage_name, style_name: ex.style_name }));

  const inspirationResult = await pool.query(
    `SELECT ci.title, ci.campaign_name, ci.video_url, ci.additional_urls, ci.creator, ci.sale_stage_note
     FROM promotion_creative_idea_inspirations pcii
     JOIN creative_inspiration ci ON ci.id = pcii.creative_inspiration_id
     WHERE pcii.promotion_creative_idea_id = $1`,
    [ideaId]
  );

  return {
    idea_id: idea.id,
    promotion_name: idea.promotion_name,
    idea_title: idea.title,
    who: idea.who,
    where_text: idea.where_text,
    concept_script: idea.concept_script,
    need_text: idea.need_text,
    stages: sharedStages,
    inspiration: inspirationResult.rows,
  };
}

module.exports = { loadBlackFridayShootContext };
