// Weekly CONCEPT progress for the Shoot Plan, built entirely from the production records the app already keeps (no parallel tracking system).
//
// WHAT IS COUNTED: one CONCEPT = one creative_assets row. The team's weekly goal (planning_settings.weekly_new_concept_target, 15) is a number of distinct
// concepts, not products and not video exports:
//   * a concept adapted for several products is still ONE row; its extra products live in concept_product_links and never add to the count
//   * the several products of one Shoot Plan item do not multiply concepts; several concepts for one product are counted separately
//   * Final Edits (Primary Hook, Alt Hook ...) are variations of a concept and are never counted
//   * a concept the Tuesday review KILLED is not counted as planned (it is reported separately)
// WHICH WEEK: the week of the Shoot Plan item the concept was planned in (shoot_plan_items.week_start).
// STAGE (each concept sits in exactly ONE, derived from fields the existing Concept Development / Shooting / Editing / Final Approval / Kanban screens set):
//   uploaded            status = 'uploaded_live'
//   approved            Final Approval = approved (and not yet uploaded)
//   edited              Editing submitted the concept for approval (editing_submitted_at)
//   filmed              Shooting marked it shot (shoot_schedule.status = 'shot')
//   awaiting_production approved at Tuesday review (concept_dev_status = 'approved'), not yet shot
//   planned             anything earlier: still being developed or awaiting review
// CARRYOVER: unfinished concepts from earlier weeks are NEVER reset, hidden or auto-completed when a new week begins. They are listed separately, still in their
// real stage, and do not count toward the new week's 15 (they are not NEW this week).
const STAGES = ['planned', 'awaiting_production', 'filmed', 'edited', 'approved', 'uploaded'];
const STAGE_LABEL = { planned: 'Planned', awaiting_production: 'Awaiting production', filmed: 'Filmed', edited: 'Edited', approved: 'Approved', uploaded: 'Uploaded' };

// pure: ONE concept row → its stage (see above)
function stageOf(r) {
  if (r.status === 'uploaded_live') return 'uploaded';
  if (r.final_approval_status === 'approved') return 'approved';
  if (r.editing_submitted_at) return 'edited';
  if (r.shoot_status === 'shot') return 'filmed';
  if (r.concept_dev_status === 'approved') return 'awaiting_production';
  return 'planned';
}
const isKilled = (r) => r.concept_dev_status === 'killed';
const emptyCounts = () => STAGES.reduce((o, s) => { o[s] = 0; return o; }, {});
const ymd = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : d ? String(d).slice(0, 10) : null);

const CONCEPT_SQL = `
  SELECT ca.id, ca.concept_name, ca.status, ca.concept_dev_status, ca.final_approval_status, ca.editing_submitted_at, ca.format, ca.created_at,
         ss.status AS shoot_status, ss.shot_at,
         spi.id AS item_id, spi.product_code, spi.product_name, spi.week_start, spi.source, spi.image_url, spi.recommendation_snapshot,
         (SELECT MAX(sh.changed_at) FROM status_history sh WHERE sh.creative_asset_id = ca.id AND sh.to_status = 'uploaded_live') AS uploaded_at,
         (SELECT json_agg(json_build_object('product_code', l.product_code, 'product_name', l.product_name, 'shoot_plan_item_id', l.shoot_plan_item_id) ORDER BY l.id)
            FROM concept_product_links l WHERE l.creative_asset_id = ca.id) AS links
    FROM creative_assets ca
    JOIN shoot_plan_items spi ON spi.id = ca.shoot_plan_item_id
    LEFT JOIN shoot_schedule ss ON ss.creative_asset_id = ca.id`;

const shape = (r) => ({
  id: r.id, name: r.concept_name, stage: stageOf(r), stage_label: STAGE_LABEL[stageOf(r)], killed: isKilled(r), format: r.format,
  item_id: r.item_id, product_code: r.product_code, product_name: r.product_name, source: r.source, week_start: ymd(r.week_start), image_url: r.image_url || null,
  uploaded_at: r.uploaded_at || null, products: [{ product_code: r.product_code, product_name: r.product_name, primary: true }, ...((r.links || []).map((l) => ({ product_code: l.product_code, product_name: l.product_name, primary: false })))].filter((p) => p.product_code || p.product_name),
  reason: r.recommendation_snapshot && r.recommendation_snapshot.reason ? r.recommendation_snapshot.reason : null,
});

// → the week's progress against the target, plus the unfinished work carried over from earlier weeks
async function loadWeeklyProgress(db, weekStart, { target = 15, carryWeeks = 26 } = {}) {
  const week = (await db.query(`${CONCEPT_SQL} WHERE spi.week_start = $1::date ORDER BY ca.created_at, ca.id`, [weekStart])).rows.map(shape);
  const carried = (await db.query(`${CONCEPT_SQL} WHERE spi.week_start < $1::date AND spi.week_start >= ($1::date - ($2::int * 7)) ORDER BY spi.week_start, ca.id`, [weekStart, carryWeeks])).rows.map(shape)
    .filter((c) => !c.killed && c.stage !== 'uploaded');
  const live = week.filter((c) => !c.killed);
  const counts = emptyCounts(); live.forEach((c) => { counts[c.stage] += 1; });
  const carryCounts = emptyCounts(); carried.forEach((c) => { carryCounts[c.stage] += 1; });
  const bySource = {}; live.forEach((c) => { const k = c.source || 'manual'; bySource[k] = (bySource[k] || 0) + 1; });
  const planned = live.length;
  const multi = live.filter((c) => c.products.length > 1).length;
  return {
    week_start: weekStart, target, planned, remaining: Math.max(0, target - planned), reached: planned >= target,
    counts, uploaded: counts.uploaded, awaiting_production: counts.awaiting_production, killed: week.length - live.length, by_source: bySource, multi_product_concepts: multi,
    concepts: week, carryover: { count: carried.length, by_stage: carryCounts, concepts: carried },
    stage_labels: STAGE_LABEL, stages: STAGES,
    definition: 'Counts distinct concepts (one per Concept Development record). A concept adapted for several products counts once; Final Edits and product assignments are not counted; killed concepts are excluded.',
  };
}

// → Map(product_code -> { in_flight, by_stage, uploaded: [{ date, concept }], this_week }): what already exists for each product (as the concept's own product or as an
//   adapted product), so recommendations never ask for creative that is already planned, being made, or just uploaded.
async function loadProductPipeline(db, weekStart, { lookbackWeeks = 12, uploadedDays = 60 } = {}) {
  const rows = (await db.query(
    `${CONCEPT_SQL} WHERE spi.week_start >= ($1::date - ($2::int * 7))`, [weekStart, lookbackWeeks])).rows;
  const out = new Map();
  const touch = (code) => { if (!out.has(code)) out.set(code, { in_flight: 0, by_stage: emptyCounts(), uploaded: [], this_week: 0, concepts: [] }); return out.get(code); };
  const cutoff = Date.parse(`${weekStart}T00:00:00Z`) - uploadedDays * 86400000;
  rows.forEach((r) => {
    if (isKilled(r)) return;
    const st = stageOf(r);
    const codes = new Set([r.product_code, ...((r.links || []).map((l) => l.product_code))].filter(Boolean));
    codes.forEach((code) => {
      const e = touch(code);
      if (st === 'uploaded') {
        const when = r.uploaded_at ? new Date(r.uploaded_at) : null;
        if (when && when.getTime() >= cutoff) e.uploaded.push({ date: when.toISOString().slice(0, 10), concept: r.concept_name });
      } else { e.in_flight += 1; e.by_stage[st] += 1; }
      if (ymd(r.week_start) === weekStart) e.this_week += 1;
      e.concepts.push({ id: r.id, name: r.concept_name, stage: st });
    });
  });
  return out;
}

// Adds the product a concept is ADAPTED for. The concept stays one row (and one count); this only records the extra product (and, optionally, the Shoot Plan item that
// holds that product's colourways / samples).
async function linkConceptToProduct(db, { assetId, productCode, productName, shootPlanItemId = null, reason = null, userId = null }) {
  const a = (await db.query('SELECT ca.id, spi.product_code FROM creative_assets ca LEFT JOIN shoot_plan_items spi ON spi.id = ca.shoot_plan_item_id WHERE ca.id = $1', [assetId])).rows[0];
  if (!a) { const e = new Error('Concept not found'); e.status = 404; throw e; }
  if (!productCode) { const e = new Error('product_code is required'); e.status = 400; throw e; }
  if (a.product_code && a.product_code === productCode) { const e = new Error('That is already this concept\'s own product'); e.status = 409; throw e; }
  const r = await db.query(
    `INSERT INTO concept_product_links (creative_asset_id, product_code, product_name, shoot_plan_item_id, reason_snapshot, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (creative_asset_id, product_code) DO UPDATE SET product_name = COALESCE(EXCLUDED.product_name, concept_product_links.product_name), shoot_plan_item_id = COALESCE(EXCLUDED.shoot_plan_item_id, concept_product_links.shoot_plan_item_id)
     RETURNING *`,
    [assetId, productCode, productName || null, shootPlanItemId, reason ? JSON.stringify(reason) : null, userId]);
  return r.rows[0];
}
async function unlinkConceptProduct(db, { assetId, productCode }) {
  const r = await db.query('DELETE FROM concept_product_links WHERE creative_asset_id = $1 AND product_code = $2 RETURNING id', [assetId, productCode]);
  return r.rowCount;
}

module.exports = { STAGES, STAGE_LABEL, stageOf, isKilled, loadWeeklyProgress, loadProductPipeline, linkConceptToProduct, unlinkConceptProduct };
