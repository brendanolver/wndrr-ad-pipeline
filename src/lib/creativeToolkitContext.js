// Creative Toolkit: builds the automatic PRODUCT CONTEXT / PLANNING CONTEXT
// / PLANNING NOTES blocks a ChatGPT prompt needs from a shoot_plan_item, and
// assembles the two prompt templates (Develop Concepts / Improve This
// Concept) around them. The whole point of this module is "don't make the
// creator re-type what the system already knows" -- every field here is
// read from data Planning already captured (or from the exact same live
// SOH/sales computation Core/High Stock Planning already run), never
// invented, and a field with no real data is omitted rather than printed as
// N/A/undefined/0-that-isn't-really-zero.
const { pool } = require('../db');
const { fetchAmData } = require('./planningData');
const { isoWeekNumber } = require('./week');
const { computeCoreProducts } = require('../routes/coreProducts');
const { computeHighStockProducts } = require('../routes/highStockProducts');
const { generateOrTopUpPlan } = require('../routes/dropProductPlans');

const SOURCE_LABELS = { core: 'Core', high_stock: 'High Stock', drop: 'Upcoming Drop', promotion: 'Promotion' };
const PATHWAY_LABELS = { core: 'Develop New Concepts', high_stock: 'Creative Refresh', drop: 'Proven Concepts Assigned', promotion: 'Cover Requirement' };

function titleCase(s) {
  return s.split(' ').filter(Boolean).map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
}

// "a, b and c." -- the exact narrative shape the High Stock reason sentence
// below needs; never a semicolon-separated list of chip fragments.
function naturalJoin(parts) {
  if (!parts.length) return '';
  const capped = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  if (parts.length === 1) return `${capped}.`;
  return `${capped}${parts.length > 2 ? ', ' + parts.slice(1, -1).join(', ') : ''} and ${parts[parts.length - 1]}.`;
}

function formatDate(d) {
  if (!d) return null;
  return new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Core priorities per the brief: SOH, On Order, 7D sales, MTD vs LY, Weeks
// Cover, historical tier, creative freshness, reason selected -- Core
// products are proven/evergreen, so the framing is "continued testing /
// refreshing demand", carried by the reason text buildAttention already
// writes (coreProducts.js), reused verbatim here.
async function coreMetrics(productCode) {
  const { products } = await computeCoreProducts();
  const p = products.find((x) => x.product_code === productCode);
  if (!p) return { lines: [], reason: null };

  const lines = [];
  if (p.soh != null) lines.push(['SOH', `${p.soh} units`]);
  if (p.on_order != null) lines.push(['On Order', `${p.on_order}`]);
  lines.push(['7D Sales', `${p.vel7}`]);
  if (p.cadence && p.cadence.has_data) {
    const sign = p.cadence.pct_change > 0 ? '+' : '';
    lines.push(['This Month vs Last Year', `${p.cadence.this_period_units} vs ${p.cadence.last_year_units} units (${sign}${p.cadence.pct_change}%)`]);
  }
  if (p.weeks_cover != null) lines.push(['Weeks Cover', `${p.weeks_cover} weeks`]);
  const tierLabel = { high: 'Top Performer', standard: 'Standard', low: 'Lower Volume' }[p.tier];
  if (tierLabel) lines.push(['Historical Tier', tierLabel]);
  lines.push(['Last New Concept', p.days_since_last_new_concept != null ? `${p.days_since_last_new_concept} days ago` : 'Never']);

  return { lines, reason: p.reason || null };
}

// High Stock priorities per the brief: SOH, On Order, 7D sell-through, 7D
// units, 30D performance, tier, last creative, last new concept, existing
// creative assets, reason selected -- framed as "needs thoughtful creative
// intervention", not discount-led advertising, so the reason sentence below
// deliberately narrates the qualitative story (inventory/sell-through/
// freshness) rather than repeating the numbers already shown above it.
async function highStockMetrics(productCode) {
  const { products } = await computeHighStockProducts();
  const p = products.find((x) => x.product_code === productCode);
  if (!p) return { lines: [], reason: null };

  const lines = [];
  lines.push(['SOH', `${p.soh} units`]);
  if (p.on_order != null) lines.push(['On Order', `${p.on_order}`]);
  lines.push(['7D Sell-Through', `${p.sell_through_7d_pct}%`]);
  lines.push(['7D Units Sold', `${p.vel7}`]);
  lines.push(['30D Units Sold', `${p.units_sold_30d}`]);
  lines.push(['Last Creative', p.days_since_last_creative != null ? `${p.days_since_last_creative} days ago` : 'Never']);
  lines.push(['Last New Concept', p.days_since_last_new_concept != null ? `${p.days_since_last_new_concept} days ago` : 'Never']);
  if (p.creative_assets && p.creative_assets.length) {
    lines.push(['Existing Creative Assets', p.creative_assets.map((a) => a.concept_name).join(', ')]);
  }

  const reasonParts = [];
  if (p.soh > 0) reasonParts.push('high inventory');
  if (p.sell_through_7d_pct != null && p.sell_through_7d_pct < 10) reasonParts.push('low recent sell-through');
  if (p.days_since_last_creative == null || p.days_since_last_creative > 21) reasonParts.push('no recent creative');
  const reason = reasonParts.length ? naturalJoin(reasonParts) : null;

  return { lines, reason };
}

// Drop priorities per the brief: Drop, Launch date, Product, Colourways,
// Assigned Proven Concepts, Planning notes, product story/details. Product/
// Colourways/Planning notes are already covered by the shared context
// blocks, so this only adds what's specific to the Drop itself. No "reason
// selected" for Drops -- there's no computed attention signal like Core/
// High Stock have, and the brief's own Drop priority list doesn't ask for
// one; inventing one would misrepresent the data.
async function dropMetrics(item, styles) {
  const dropId = styles.map((s) => s.drop_id).find((id) => id != null);
  if (!dropId) return { lines: [], reason: null };

  const lines = [];
  const dropResult = await pool.query('SELECT * FROM drops WHERE id = $1', [dropId]);
  const drop = dropResult.rows[0];
  if (drop) {
    if (drop.name) lines.push(['Drop', drop.name]);
    if (drop.launch_date) lines.push(['Launch Date', formatDate(drop.launch_date)]);
  }

  // Same auto-generate/top-up server logic Concept Development's own GET /
  // uses, so "already assigned" holds true here too even if nobody has
  // opened this product's Concept Development page yet.
  const planResult = await generateOrTopUpPlan(dropId, item.product_code);
  if (!planResult.notFound && planResult.plan) {
    const slotsResult = await pool.query(
      `SELECT dpps.proven_winner_id, ca.concept_name
       FROM drop_product_plan_slots dpps
       JOIN creative_assets ca ON ca.id = dpps.fulfilled_by_asset_id
       WHERE dpps.plan_id = $1 ORDER BY dpps.slot_rank ASC`,
      [planResult.plan.id]
    );
    const provenNames = slotsResult.rows.filter((r) => r.proven_winner_id != null).map((r) => r.concept_name);
    if (provenNames.length) lines.push(['Assigned Proven Concepts', provenNames.join(', ')]);
  }

  return { lines, reason: null };
}

// Promotion priorities per the brief: Promotion, Offer, Campaign stage,
// Required creative, Due date, Product(s), existing planned concepts.
// Product is covered by the shared PRODUCT CONTEXT block; "Offer" maps to
// the promotion's own notes field (the closest thing to an offer
// description this app currently captures).
async function promotionMetrics(item) {
  if (!item.promotion_stage_id) return { lines: [], reason: null };
  const stageResult = await pool.query(
    `SELECT ps.name, ps.required_count, ps.due_date, p.name AS promotion_name, p.notes AS promotion_notes
     FROM promotion_stages ps JOIN promotions p ON p.id = ps.promotion_id
     WHERE ps.id = $1`,
    [item.promotion_stage_id]
  );
  const stage = stageResult.rows[0];
  if (!stage) return { lines: [], reason: null };

  const lines = [];
  if (stage.promotion_name) lines.push(['Promotion', stage.promotion_name]);
  if (stage.promotion_notes) lines.push(['Offer', stage.promotion_notes]);
  if (stage.name) lines.push(['Campaign Stage', stage.name]);
  if (stage.required_count != null) lines.push(['Required Creative', `${stage.required_count}`]);
  if (stage.due_date) lines.push(['Due Date', formatDate(stage.due_date)]);

  return { lines, reason: null };
}

// The one entry point every prompt builder starts from -- everything a
// creator would otherwise have to type by hand (product identity, source,
// pathway, owner, week, Planning's own note, and the source-specific
// metrics that explain WHY this product was selected) resolved from data
// Planning already captured.
async function buildContext(shootPlanItemId) {
  const itemResult = await pool.query('SELECT * FROM shoot_plan_items WHERE id = $1', [shootPlanItemId]);
  const item = itemResult.rows[0];
  if (!item) return null;

  const stylesResult = await pool.query(
    `SELECT spis.colour_label, s.style_code, s.drop_id
     FROM shoot_plan_item_styles spis JOIN styles s ON s.id = spis.style_id
     WHERE spis.shoot_plan_item_id = $1`,
    [item.id]
  );
  const styles = stylesResult.rows;

  const am = await fetchAmData();
  let productType = null;
  if (am.amDetails && styles.length) {
    const details = am.amDetails.get(styles[0].style_code);
    if (details && details.category) productType = titleCase(details.category);
  }

  const colourLabels = styles.map((s) => s.colour_label || s.style_code).filter(Boolean);

  let metrics = { lines: [], reason: null };
  if (item.source === 'core') metrics = await coreMetrics(item.product_code);
  else if (item.source === 'high_stock') metrics = await highStockMetrics(item.product_code);
  else if (item.source === 'drop') metrics = await dropMetrics(item, styles);
  else if (item.source === 'promotion') metrics = await promotionMetrics(item);

  return {
    product_name: item.product_name,
    product_type: productType,
    colourway_label: colourLabels.length ? colourLabels.join(', ') : null,
    colourway_count: colourLabels.length,
    source: item.source,
    source_label: SOURCE_LABELS[item.source] || item.source,
    pathway_label: PATHWAY_LABELS[item.source] || null,
    owner: item.creator || null,
    week_number: item.week_start ? isoWeekNumber(new Date(item.week_start)) : null,
    initial_idea: item.initial_idea && item.initial_idea.trim() ? item.initial_idea.trim() : null,
    metrics,
  };
}

function formatProductContextBlock(ctx) {
  const lines = [`Product: ${ctx.product_name}`];
  if (ctx.product_type) lines.push(`Product Type: ${ctx.product_type}`);
  if (ctx.colourway_label) lines.push(`Colourway${ctx.colourway_count === 1 ? '' : 's'}: ${ctx.colourway_label}`);
  if (ctx.source_label) lines.push(`Planning Source: ${ctx.source_label}`);
  if (ctx.pathway_label) lines.push(`Creative Pathway: ${ctx.pathway_label}`);
  if (ctx.owner) lines.push(`Owner: ${ctx.owner}`);
  if (ctx.week_number) lines.push(`Week: ${ctx.week_number}`);
  return `PRODUCT CONTEXT\n\n${lines.join('\n')}`;
}

function formatPlanningContextBlock(ctx) {
  const { lines, reason } = ctx.metrics;
  if (!lines.length && !reason) return null;
  let block = 'PLANNING CONTEXT\n\n' + lines.map(([label, value]) => `${label}: ${value}`).join('\n');
  if (reason) block += `${lines.length ? '\n\n' : ''}Reason Selected:\n${reason}`;
  return block;
}

function formatPlanningNotesBlock(ctx) {
  if (!ctx.initial_idea) return null;
  return `PLANNING NOTES\n\n${ctx.initial_idea}`;
}

// Verbatim per the brief -- only the three bracketed context sections are
// substituted. This is the one prompt where a specific, given wording was
// asked for, so it's reproduced exactly rather than re-composed.
function buildDevelopConceptsPrompt(ctx) {
  const contextBlocks = [
    formatProductContextBlock(ctx),
    formatPlanningContextBlock(ctx),
    formatPlanningNotesBlock(ctx),
  ].filter(Boolean).join('\n\n');

  return `You are acting as a senior paid-social creative strategist for WNDRR, an Australian men's streetwear brand.

Your job is NOT to generate a large volume of generic ad ideas.

Your job is to help me develop a small number of genuinely strong, differentiated paid-social creative concepts that are worth spending time producing and putting real Meta media spend behind.

QUALITY OF THINKING IS MORE IMPORTANT THAN QUANTITY OF OUTPUT.

Here is the context already captured in our creative planning system:

${contextBlocks}

Use this information as strategic context. Do not simply repeat these metrics back to me.

Think about what the data means for the creative problem we are trying to solve.

Before recommending anything, think critically about:

- Why would our target customer actually care about this product?
- What does the customer need to see, understand or feel for this product to become desirable?
- What product details or benefits should be demonstrated rather than simply stated?
- Is there a customer behaviour, tension, desire, objection, identity or situation we can build the creative around?
- What would make someone stop scrolling?
- What would make the creative feel native to Instagram/Meta rather than like a traditional advertisement?
- Could styling, demonstration, comparison, social proof, humour, curiosity, aspiration, objection handling, product detail or storytelling create a stronger idea?
- Does this product need a new creative concept, or would a proven format executed better be more appropriate?

Most importantly:

DO NOT confuse a new hook with a new concept.

If the underlying idea and backend execution are essentially the same and only the first few seconds change, those are Hook Variations of ONE Concept.

Do not inflate the number of concepts by presenting minor variations as different ideas.

YOUR TASK:

Develop 3–5 genuinely different creative directions.

If only 2–3 ideas meet the standard, give me 2–3. Do not manufacture weak ideas just to reach a number.

For each concept provide:

CONCEPT NAME
A short internal name that makes the concept easy to identify.

THE INSIGHT
What customer behaviour, desire, problem, tension or observation makes this idea potentially effective?

ANGLE / IDEA
What is the actual advertising idea and what are we trying to communicate?

WHY IT COULD WORK
Why might someone stop, watch, care and ultimately consider purchasing?

EXECUTION / SHOT PLAN
Explain specifically how the ad could be made so a content creator can visualise shooting it.

PRIMARY HOOK / OPENING
Give me the strongest opening you would test first. This can be visual, spoken or text-based.

ALTERNATIVE HOOKS
Only suggest alternatives where there is a genuinely worthwhile opening to test.
These remain variations of the SAME concept.

WHAT MUST BE SHOWN
Identify the product details, fit, styling, proof or visual moments essential to making the concept work.

FORMAT
Recommend the best format for the idea.

PRODUCTION REQUIREMENTS
Identify any talent, location, props or special requirements.

RISK / WATCH-OUT
Explain what could make this concept generic, forced or ineffective and how you would avoid that.

CREATIVE STANDARD:

Reject generic ideas yourself before presenting them.

Do not recommend things like:

- Show the product with trending audio
- Model wearing the product
- Lifestyle montage
- Show different outfits
- Generic UGC testimonial

unless there is a specific strategic insight, structure or executional twist that makes the idea distinctive.

Don't use marketing jargon for the sake of it.

Don't make every idea a talking-head ad.

Don't assume louder or more clickbait hooks are automatically better.

Don't recommend something simply because it is easy to produce.

Think like someone responsible for deciding:

"Is this idea genuinely good enough that I would spend WNDRR's time producing it and then put real Meta spend behind it?"

If the answer is no, don't recommend it.

Finally:

Rank the concepts from strongest to weakest.

Explain briefly why you ranked them that way.

Then tell me:

WHICH CONCEPT WOULD YOU PRODUCE FIRST AND WHY?`;
}

// A concept's already-captured Concept Development content -- Concept
// Name/Angle/Execution/Primary Hook/Alternative Hooks/Script/References/
// Reference Notes/Shoot Requirements, per the brief -- omitting anything
// blank. References and their notes are kept paired (one line each) rather
// than split into two flat lists, since a note only makes sense next to the
// link it's about.
function formatExistingConceptBlock(concept) {
  const lines = [];
  if (concept.concept_name) lines.push(`Concept Name: ${concept.concept_name}`);
  if (concept.angle) lines.push(`Angle / Idea: ${concept.angle}`);
  if (concept.execution) lines.push(`Execution / Shot Plan: ${concept.execution}`);

  const hooks = (Array.isArray(concept.hook_variations) ? concept.hook_variations : [])
    .map((h) => (h && h.text ? h.text.trim() : ''))
    .filter(Boolean);
  if (hooks.length) {
    lines.push(`Primary Hook: ${hooks[0]}`);
    if (hooks.length > 1) {
      lines.push('Alternative Hooks:');
      for (const h of hooks.slice(1)) lines.push(`- ${h}`);
    }
  }

  if (concept.script_notes) lines.push(`Script / Talking Points: ${concept.script_notes}`);

  const refs = (Array.isArray(concept.reference_items) ? concept.reference_items : [])
    .filter((r) => r && r.url);
  if (refs.length) {
    lines.push('References:');
    for (const r of refs) lines.push(`- ${r.url}${r.note ? ` — ${r.note}` : ''}`);
  }

  const shootReq = [];
  if (concept.talent_requirement) shootReq.push(`Talent / Model: ${concept.talent_requirement}`);
  if (concept.location) shootReq.push(`Location: ${concept.location}`);
  if (concept.props_notes) shootReq.push(`Props / Special Requirements: ${concept.props_notes}`);
  if (shootReq.length) {
    lines.push('Shoot Requirements:');
    lines.push(...shootReq);
  }

  return lines.length ? `EXISTING CONCEPT\n\n${lines.join('\n')}` : null;
}

// A critical reviewer, not a second idea-generator -- per the brief, this
// must be comfortable saying a concept isn't strong enough yet rather than
// always validating it. Structure follows the brief's 8-step review order.
function buildImproveConceptPrompt(ctx, concept) {
  const contextBlocks = [
    formatProductContextBlock(ctx),
    formatPlanningContextBlock(ctx),
    formatPlanningNotesBlock(ctx),
    formatExistingConceptBlock(concept),
  ].filter(Boolean).join('\n\n');

  return `You are acting as a senior paid-social creative strategist and critical creative reviewer for WNDRR, an Australian men's streetwear brand.

Your job is NOT to immediately generate new ideas.

Your job is to pressure-test an existing creative concept that has already been captured in our creative planning system, and help make it as strong as possible before we spend time producing it and putting real Meta media spend behind it.

Here is the context already captured in our creative planning system:

${contextBlocks}

Use this information as context for your review. Do not simply repeat it back to me.

Work through the concept in this order:

1. Understand the product and Planning context.
2. Review the underlying concept.
3. Identify what is strong.
4. Identify what is weak, generic or unclear.
5. Decide whether the concept itself needs improving, or whether only the execution or hook needs improving.
6. Recommend specific improvements.
7. Suggest alternative hooks only where they represent a genuinely worthwhile test -- these remain variations of the SAME concept, not new concepts.
8. Clearly distinguish between a new concept and a variation of the existing concept.

Be honest, not encouraging for its own sake. You should be completely comfortable saying:

"This concept isn't strong enough yet."

rather than always trying to validate the idea as-is.

Structure your response as:

WHAT'S STRONG

WHAT'S WEAK, GENERIC OR UNCLEAR

CONCEPT-LEVEL OR EXECUTION-LEVEL?
Is the underlying idea the problem, or just how it's currently planned to be executed or opened?

RECOMMENDED IMPROVEMENTS
Specific, actionable changes -- not generic advice.

HOOK ASSESSMENT
Is the Primary Hook strong? Only suggest an alternative hook to test if there's a genuine, specific reason to -- it remains a variation of this same concept, not a new one.

OVERALL VERDICT
Is this concept, as it stands, worth producing and putting real Meta spend behind? If not, what needs to change first?`;
}

module.exports = { buildContext, buildDevelopConceptsPrompt, buildImproveConceptPrompt };
