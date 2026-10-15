// Planning > Shoot Plan: what removing a product from the plan may do, and what "Confirm & Send" will hand to Concept Development.
//
// A Shoot Plan selection is a shoot_plan_items row plus the Concept Development records (creative_assets) started with it. Removing a selection is only
// straightforward while every one of those concepts is still an untouched draft. As soon as anyone has saved work on a concept, or it has moved on (reviewed,
// scheduled for shooting, edited, approved, published, matched to an Ad Setup), the selection stays and the answer says exactly which concept is in the way
// and where to deal with it (Kill Concept / Move Back in that stage). Nothing here ever deletes a concept: untouched drafts are archived (history kept,
// restorable) and the product record itself (ApparelMagic / catalogue) is never touched.
const { stageOf } = require('./shootPlanProgress');

// An entry a Drops assignment created so Shooting can pick a Required Concept up (never a Planning selection). New rows carry auto_linked; rows from before the column
// existed are recognised by the same rule: a Drop entry whose concept fulfils a Required Concept slot. `alias` is the shoot_plan_items alias in the query.
const autoLinkedSql = (alias = 'spi') => `(${alias}.auto_linked OR (${alias}.source = 'drop' AND ${alias}.asset_id IS NOT NULL AND EXISTS (SELECT 1 FROM drop_product_plan_slots dps WHERE dps.fulfilled_by_asset_id = ${alias}.asset_id)))`;

const STAGE_WHERE = { planned: 'Concept Development', awaiting_production: 'Shooting', filmed: 'Editing', edited: 'Final Approval', approved: 'Ad Setup', uploaded: 'published' };

// pure: has a person put work into this concept, or has it moved beyond the first draft?
// r: the concept row as loaded by CONCEPTS_SQL below
function conceptWork(r) {
  const reasons = [];
  if (r.concept_dev_status && r.concept_dev_status !== 'not_started') reasons.push('it has moved on from a first draft in Concept Development');
  if (r.status && r.status !== 'awaiting_concept_development') reasons.push(`it is already at "${r.status}"`);
  if (r.has_shoot) reasons.push('it is scheduled for shooting');
  if (r.editing_submitted_at) reasons.push('it has been submitted from Editing');
  if (r.final_approval_status && r.final_approval_status !== 'pending') reasons.push('it has a Final Approval decision');
  if (Number(r.final_edits) > 0) reasons.push('it has edit records');
  if (Number(r.ad_setups) > 0) reasons.push('it has an Ad Setup');
  if (r.has_content) reasons.push('someone has saved concept details');
  return reasons;
}

const CONCEPTS_SQL = `
  SELECT ca.id, ca.concept_name, ca.status, ca.concept_dev_status, ca.final_approval_status, ca.editing_submitted_at, ca.shoot_plan_item_id,
         ss.status AS shoot_status, (ss.id IS NOT NULL) AS has_shoot,
         (SELECT count(*)::int FROM final_edits fe WHERE fe.creative_asset_id = ca.id) AS final_edits,
         (SELECT count(*)::int FROM ad_setups au WHERE au.creative_asset_id = ca.id) AS ad_setups,
         (COALESCE(NULLIF(btrim(ca.angle), ''), NULLIF(btrim(ca.execution), ''), NULLIF(btrim(ca.script_notes), ''), NULLIF(btrim(ca.talent_requirement), ''),
                   NULLIF(btrim(ca.location), ''), NULLIF(btrim(ca.props_notes), ''), NULLIF(btrim(ca.headline), ''), NULLIF(btrim(ca.supporting_copy), ''),
                   NULLIF(btrim(ca.cta_text), ''), NULLIF(btrim(ca.custom_avatar_description), ''), NULLIF(btrim(ca.avatar_why_care), '')) IS NOT NULL
          OR ca.customer_avatar_id IS NOT NULL
          OR jsonb_array_length(ca.hook_variations) > 0 OR jsonb_array_length(ca.shots) > 0 OR jsonb_array_length(ca.reference_items) > 0) AS has_content
    FROM creative_assets ca
    LEFT JOIN shoot_schedule ss ON ss.creative_asset_id = ca.id
   WHERE ca.shoot_plan_item_id = $1 AND ca.archived_at IS NULL AND ca.concept_dev_status <> 'killed'
   ORDER BY ca.id`;

// → what removing this selection would do (read-only)
async function assessRemoval(db, itemId) {
  const item = (await db.query(`SELECT spi.id, spi.product_name, spi.source, ${autoLinkedSql('spi')} AS auto_linked, spi.week_start FROM shoot_plan_items spi WHERE spi.id = $1`, [itemId])).rows[0];
  if (!item) return null;
  const rows = (await db.query(CONCEPTS_SQL, [itemId])).rows;
  const concepts = rows.map((r) => {
    const reasons = conceptWork(r);
    const stage = stageOf({ ...r, shoot_status: r.shoot_status });
    return { id: r.id, name: r.concept_name, stage, where: reasons.length ? (STAGE_WHERE[stage] || 'Concept Development') : null, worked_on: reasons.length > 0, reasons };
  });
  const blocking = concepts.filter((c) => c.worked_on);
  return { item, concepts, blocking, removable: !item.auto_linked && blocking.length === 0 };
}

class RemovalError extends Error { constructor(status, message, extra) { super(message); this.status = status; Object.assign(this, extra || {}); } }

function blockingMessage(a) {
  const c = a.blocking;
  const names = c.slice(0, 3).map((x) => `"${x.name}"`).join(', ') + (c.length > 3 ? ` and ${c.length - 3} more` : '');
  const first = c[0];
  return `${a.item.product_name || 'This product'} cannot be removed from the plan because work has started on ${names} (${first.reasons[0]}). `
    + `Use Kill Concept${first.where && first.where !== 'Concept Development' ? ` or Move Back in ${first.where}` : ' in Concept Development'} to close that concept first; its history is kept. The product itself is not affected.`;
}

// Removes the selection: untouched draft concepts are archived (never deleted), then the plan entry goes. Refuses (409) when any concept has work on it.
// `archive(conceptId, reason)` is injected so this stays testable; the route passes the lifecycle "archive" action.
async function removeSelection(db, itemId, archive) {
  const a = await assessRemoval(db, itemId);
  if (!a) throw new RemovalError(404, 'Shoot plan item not found');
  if (a.item.auto_linked) throw new RemovalError(409, 'This entry was created by an Upcoming Drops assignment and is managed there, so it is not part of the Planning selection.');
  if (a.blocking.length) throw new RemovalError(409, blockingMessage(a), { blocking: a.blocking.map((c) => ({ id: c.id, name: c.name, stage: c.stage, where: c.where })) });
  // a Drop item's concept is a Required Concept that existed before this plan entry; it is detached, never archived
  const archivable = a.item.source === 'drop' ? [] : a.concepts;
  for (const c of archivable) await archive(c.id, 'Removed from the Shoot Plan before any work started');
  await db.query('DELETE FROM shoot_plan_items WHERE id = $1', [itemId]);
  return { removed: true, archived_concepts: archivable.length };
}

// → what Confirm & Send Shoot Plan will do for the week, with anything worth knowing first. Read-only.
async function confirmationPreview(db, weekStart) {
  const items = (await db.query(
    `SELECT spi.id, spi.product_code, spi.product_name, spi.source, spi.creator, spi.stock_status, spi.image_url,
            (SELECT count(*)::int FROM shoot_plan_item_styles s WHERE s.shoot_plan_item_id = spi.id) AS colourways,
            (SELECT count(*)::int FROM shoot_plan_item_styles s WHERE s.shoot_plan_item_id = spi.id AND (s.size IS NULL OR btrim(s.size) = '')) AS colourways_without_size
       FROM shoot_plan_items spi
      WHERE spi.week_start = $1::date AND NOT ${autoLinkedSql('spi')}
      ORDER BY spi.created_at, spi.id`, [weekStart])).rows;
  const concepts = items.length
    ? (await db.query(
      `SELECT ca.id, ca.concept_name, ca.shoot_plan_item_id, ca.concept_dev_status
         FROM creative_assets ca WHERE ca.shoot_plan_item_id = ANY($1::int[]) AND ca.archived_at IS NULL AND ca.concept_dev_status <> 'killed' ORDER BY ca.id`, [items.map((i) => i.id)])).rows
    : [];
  const confirmed = (await db.query('SELECT confirmed_at FROM weekly_shoot_plan_confirmations WHERE week_start = $1::date', [weekStart])).rows[0] || null;
  const products = items.map((i) => {
    const cs = concepts.filter((c) => c.shoot_plan_item_id === i.id);
    const notes = [];
    if (!cs.length) notes.push('No concept yet: add one so there is something to develop.');
    if (!i.colourways && i.product_code) notes.push('No colourways selected.');
    if (i.stock_status === 'needs_to_be_brought_in' && i.colourways_without_size > 0) notes.push(`${i.colourways_without_size} colourway${i.colourways_without_size === 1 ? '' : 's'} still need a sample size for the warehouse pull list.`);
    return { id: i.id, product_name: i.product_name, source: i.source, owner: i.creator, image_url: i.image_url, colourways: i.colourways, concepts: cs.map((c) => ({ id: c.id, name: c.concept_name })), notes };
  });
  const blockers = products.length ? [] : ['Add at least one product to the Shoot Plan first.'];
  return {
    week_start: weekStart, already_confirmed: !!confirmed, confirmed_at: confirmed ? confirmed.confirmed_at : null,
    product_count: products.length, concept_count: concepts.length, products, blockers,
    notes_count: products.reduce((n, p) => n + p.notes.length, 0),
    // what confirming does, in plain words, so the dialog never over- or under-promises
    effect: 'Sends the plan to Concept Development. The concepts already exist and are reused (nothing is duplicated). Nothing is submitted for Tuesday Review: each concept must still be completed and marked Ready for Review.',
  };
}

module.exports = { autoLinkedSql, conceptWork, assessRemoval, removeSelection, confirmationPreview, blockingMessage, RemovalError };
