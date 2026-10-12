// Has a product LAUNCHED? Creative Planning must not recommend a shoot for something that has not gone on sale (it belongs to Upcoming Drops, which has its
// own creative workflow), and must not assume a product has launched just because the warehouse holds stock of it.
//
// WHAT IS KNOWN ABOUT WNDRR'S DATA (verified in the code that reads it; see docs/launch-status.md):
//   * ApparelMagic has NO product-status or release-date field that this app reads. The style's `mid_code` is a free-text date that WNDRR is believed to repurpose
//     as a launch date (a claim inherited from the Demand Planning integration; NOT verified, and it may be a planned delivery or buy date rather than the official
//     launch). It is held PER STYLE (= per colourway); '0' / blank mean "none". Until the team verifies it (setting launch_date_verified), a FUTURE date still keeps a
//     product out (the safe direction) but a PASSED date is not proof of launch. An inventory receipt, purchase order date or warehouse arrival date is NOT a launch date.
//   * Upcoming Drops live in this database (styles.drop_id -> drops.launch_date).
//   * Shopify (status / publication) is the only direct evidence a product is on sale, but its credentials are not configured in production, so it is an OPTIONAL
//     input here (`shopify`), used only when a caller supplies it.
//
// EVIDENCE USED, strongest first (a product is judged from what is KNOWN, never from what is missing):
//   1. a manual launch-status override (product_launch_overrides), set by a person
//   2. Shopify, when supplied: DRAFT = not launched, ARCHIVED = discontinued, ACTIVE and published = on sale (corroborates; it never overrides a future date)
//   3. an Upcoming Drop the product belongs to: a future drop date = not launched
//   4. ApparelMagic's date (mid_code) for the colourway: a future date = not launched (always); a PASSED date counts as launched ONLY once launch_date_verified is on; a date that cannot be read = UNKNOWN (never guessed)
//      a past date = launched, unless it passed only a few days ago with no sales yet (a planned date passing does not prove the product went live: UNKNOWN)
//   5. the CORE product group in ApparelMagic (an established evergreen range) with no future date
//   6. a past Upcoming Drop (while the date field is unverified only a NAMED drop counts: unnamed drops are auto-created from the date field itself)
//   7. sustained sales, ONLY when the sales setting allows it. Sales alone are not proof: they can include pre-launch, staff, gifting or seeding orders.
// NEVER used on their own: stock quantity, zero sales, "last creative = never", or stock arriving at the warehouse. With no usable evidence the status is
// UNKNOWN: flagged for a person to verify, never recommended, never silently treated as launched.
//
// Pure: no database, no clock (today is passed in). Colourways are judged one by one so a family can have launched and unlaunched colours.
const STATUSES = ['launched', 'unlaunched', 'upcoming_restock', 'discontinued', 'unknown'];
const DEFAULTS = {
  sales_launch_units: 10, // units sold before sales count as (weak) evidence
  date_verified: false, // the team has confirmed the ApparelMagic date field IS the official launch date; until then a PASSED date is not proof (a future date still excludes)
  sales_confirms_launch: false, // sales alone confirm a launch only when this is on
  settle_days: 21, // a launch date this recent with no sales is verified rather than assumed
  restock_min_on_order: 30, low_stock_units: 30,
};
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const ymOf = (t) => t.slice(0, 7);

// settings (creative_planning_config keys) -> the thresholds this file uses
function fromConfig(c = {}) {
  return {
    ...DEFAULTS,
    ...(c.launch_sales_min_units !== undefined ? { sales_launch_units: Number(c.launch_sales_min_units) } : {}),
    ...(c.launch_date_verified !== undefined ? { date_verified: Number(c.launch_date_verified) === 1 } : {}),
    ...(c.launch_sales_confirms !== undefined ? { sales_confirms_launch: Number(c.launch_sales_confirms) === 1 } : {}),
    ...(c.launch_settle_days !== undefined ? { settle_days: Number(c.launch_settle_days) } : {}),
  };
}

// units sold on or after a date, from the monthly sales history ({ 'YYYY-MM': units }): a month counts when it starts on/after the date's month (coarse on purpose)
const unitsSince = (months, date) => (months ? Object.entries(months).filter(([ym]) => ym >= ymOf(date)).reduce((s, [, u]) => s + (Number(u) || 0), 0) : null);
const firstSaleMonth = (months) => { const k = months ? Object.entries(months).filter(([, u]) => Number(u) > 0).map(([ym]) => ym).sort() : []; return k.length ? k[0] : null; };

// ONE colourway. input: { launchDate (Date|string|null), launchDateRaw, launchDateReadable (false = a value is recorded but unreadable), drop: { launch_date, name }|null,
//   qty (units sold in the history), months ({YYYY-MM: units}), isCore, override: { status, note }|null, shopify: { status, published_at }|null }
// → { status, basis, detail, confidence, evidence: [{ source, text, verdict }] } (evidence is the full picture, for the diagnostics)
function assessStyle(input, today, cfg = DEFAULTS) {
  const { launchDate = null, launchDateRaw = null, launchDateReadable = null, drop = null, qty = null, months = null, isCore = false, override = null, shopify = null } = input;
  const t = ymd(today);
  const c = { ...DEFAULTS, ...cfg };
  const ev = [];
  const add = (source, text, verdict) => ev.push({ source, text, verdict });
  const dropDate = drop && drop.launch_date ? ymd(drop.launch_date) : null;
  const ld = ymd(launchDate);
  const sold = qty === null ? null : Math.round(qty);
  const first = firstSaleMonth(months);

  // gather the evidence first so the diagnostics always show all of it, whichever rule decides
  if (override && ['launched', 'unlaunched', 'discontinued'].includes(override.status)) add('manual', `A person marked it ${override.status}${override.note ? `: ${override.note}` : ''}.`, override.status);
  if (shopify) add('shopify', `Shopify status ${shopify.status}${shopify.published_at ? `, published ${ymd(shopify.published_at)}` : ', not published'}.`, shopify.status === 'ARCHIVED' ? 'discontinued' : shopify.status === 'DRAFT' ? 'unlaunched' : shopify.published_at && ymd(shopify.published_at) <= t ? 'launched' : 'unknown');
  if (dropDate) add('drop', `Upcoming Drop${drop.name ? ` "${drop.name}"` : ''} dated ${dropDate}.`, dropDate >= t ? 'unlaunched' : 'launched');
  if (launchDateRaw && launchDateReadable === false) add('apparelmagic_date', `ApparelMagic launch date "${launchDateRaw}" could not be read as a date.`, 'unknown');
  else if (ld) add('apparelmagic_date', `ApparelMagic mid_code holds ${ld}${ld > t ? ' (still ahead)' : ' (has passed)'}${c.date_verified ? '' : '. That field is NOT verified as the official launch date, so a passed date is not treated as proof'}.`, ld > t ? 'unlaunched' : c.date_verified ? 'launched' : 'unverified');
  else add('apparelmagic_date', 'ApparelMagic has no launch date for this colourway.', 'none');
  if (isCore) add('core_group', 'In the ApparelMagic CORE product group (an established range).', 'launched');
  if (sold !== null) add('sales', sold > 0 ? `${sold} units sold in the sales history${first ? `, first in ${first}` : ''}. Sales can include pre-launch, staff or seeding orders.` : 'No sales in the sales history (this proves nothing either way).', sold >= c.sales_launch_units ? 'sales_only' : 'none');

  const done = (status, basis, detail, confidence) => ({ status, basis, detail, confidence, evidence: ev });
  if (override && ['launched', 'unlaunched', 'discontinued'].includes(override.status)) return done(override.status, 'manual', `Set by a person${override.note ? `: ${override.note}` : ''}.`, 'confirmed');
  if (shopify && shopify.status === 'ARCHIVED') return done('discontinued', 'shopify', 'Archived in Shopify.', 'confirmed');
  if (shopify && shopify.status === 'DRAFT') return done('unlaunched', 'shopify', 'A draft in Shopify, so it is not on sale.', 'confirmed');
  if (dropDate && dropDate >= t) return { ...done('unlaunched', 'upcoming_drop', `Part of the upcoming drop${drop.name ? ` "${drop.name}"` : ''} launching ${dropDate}; its creative is handled in Upcoming Drops.`, 'confirmed'), drop };
  if (ld && ld > t) return done('unlaunched', 'launch_date', `ApparelMagic launch date ${ld} is still ahead.`, 'confirmed');
  if (launchDateRaw && launchDateReadable === false) return done('unknown', 'unreadable_date', `ApparelMagic holds a launch date ("${launchDateRaw}") that cannot be read, so it is not assumed to have passed. Please confirm.`, 'none');
  if (ld && ld <= t && !c.date_verified) {
    // the field's meaning is unverified: it may be a planned delivery or buy date, not the day the product officially launched. Fall through to the other evidence.
  } else if (ld && ld <= t) {
    const age = daysBetween(ld, t);
    const since = unitsSince(months, ld);
    if (age < c.settle_days && (since === null ? sold === 0 : since === 0)) return done('unknown', 'date_just_passed', `ApparelMagic launch date ${ld} passed ${age} day${age === 1 ? '' : 's'} ago and nothing has sold yet. A planned date passing does not prove it went live. Please confirm.`, 'low');
    if (shopify && shopify.published_at && ymd(shopify.published_at) <= t) return done('launched', 'launch_date', `ApparelMagic launch date ${ld} has passed and Shopify has it published.`, 'confirmed');
    return done('launched', 'launch_date', `ApparelMagic launch date ${ld} has passed.`, since > 0 || sold > 0 ? 'confirmed' : 'date_only');
  }
  if (shopify && shopify.status === 'ACTIVE' && shopify.published_at && ymd(shopify.published_at) <= t) return done('launched', 'shopify', `Active in Shopify since ${ymd(shopify.published_at)}.`, 'confirmed');
  if (isCore) return done('launched', 'core_group', 'In the ApparelMagic CORE product group, an established range with no future launch date.', 'group');
  if (dropDate && dropDate < t && (c.date_verified || (drop && drop.name))) return done('launched', 'past_drop', `Its drop launched ${dropDate}.`, 'date_only');
  if (sold !== null && sold >= c.sales_launch_units) {
    if (c.sales_confirms_launch) return done('launched', 'sales', `${sold} units sold and sales are allowed to confirm a launch, so it is treated as on sale.`, 'sales_only');
    if (!(ld && ld <= t)) return done('unknown', 'sales_only', `No launch date is recorded. ${sold} units have sold${first ? ` since ${first}` : ''}, but sales alone do not prove a launch (they can include pre-launch, staff or seeding orders). Please confirm.`, 'sales_only');
  }
  if (ld && ld <= t) return done('unknown', 'unverified_date', `ApparelMagic's mid_code holds ${ld}, but that field has not been verified as the official launch date (it may be a planned delivery or buy date), so a passed date is not proof${sold ? ` and ${sold} units sold does not prove a launch either (early availability looks the same)` : ''}. Please confirm.`, 'unverified');
  if (dropDate && dropDate < t) return done('unknown', 'unverified_date', `Its unnamed drop (${dropDate}) was created from the ApparelMagic date field, which is not verified as the official launch date. Please confirm.`, 'unverified');
  return done('unknown', 'none', 'No launch date, drop or sustained sales to confirm it has launched. Stock alone does not prove it.', 'none');
}

// A product FAMILY from its colourways. styles: [{ style_code, launchDate, ..., override }]; a family-level override applies to every colourway without its own.
function assessFamily({ styles = [], familyOverride = null, stock = null, onOrder = null }, today, cfg = DEFAULTS) {
  const per = styles.map((s) => ({ style_code: s.style_code, ...assessStyle({ ...s, override: s.override || familyOverride }, today, cfg) }));
  const by = (st) => per.filter((x) => x.status === st);
  let status; let basis; let detail; let confidence;
  if (!per.length) { status = 'unknown'; basis = 'none'; detail = 'No colourways found.'; confidence = 'none'; }
  else if (by('discontinued').length === per.length) { status = 'discontinued'; basis = by('discontinued')[0].basis; detail = by('discontinued')[0].detail; confidence = by('discontinued')[0].confidence; }
  else if (by('launched').length) {
    status = 'launched'; basis = by('launched')[0].basis; confidence = by('launched')[0].confidence;
    detail = by('launched')[0].detail + (by('unlaunched').length ? ` ${by('unlaunched').length} colourway(s) have not launched and are left out.` : '') + (by('unknown').length ? ` ${by('unknown').length} colourway(s) need checking.` : '');
  } else if (by('unlaunched').length) { status = 'unlaunched'; basis = by('unlaunched')[0].basis; detail = by('unlaunched')[0].detail; confidence = by('unlaunched')[0].confidence; }
  else { status = 'unknown'; basis = per[0].basis; detail = per[0].detail; confidence = per[0].confidence; }
  // a launched product that is out / low with a real order on the way is an upcoming restock: eligible where demand justifies it
  const units = stock && stock.known ? Math.max(0, Number(stock.units) || 0) : null;
  const oo = Math.max(0, Number(onOrder) || 0);
  const lowStock = (cfg && cfg.low_stock_units) !== undefined ? cfg.low_stock_units : DEFAULTS.low_stock_units;
  const minOrder = (cfg && cfg.restock_min_on_order) !== undefined ? cfg.restock_min_on_order : DEFAULTS.restock_min_on_order;
  const restock = status === 'launched' && units !== null && units <= lowStock && oo >= minOrder;
  if (restock) { status = 'upcoming_restock'; detail += ` ${oo} units are on order.`; }
  const inDrop = per.find((x) => x.basis === 'upcoming_drop');
  return { status, basis, detail, confidence, eligible: status === 'launched' || status === 'upcoming_restock', needs_check: status === 'unknown', in_upcoming_drop: !!inDrop, drop: inDrop ? inDrop.drop : null, by_style: per, restock, on_order: oo };
}

module.exports = { STATUSES, DEFAULTS, fromConfig, assessStyle, assessFamily };
