// Has a product LAUNCHED? Creative Planning must not recommend a shoot for something that has not gone on sale (it belongs to Upcoming Drops, which has its
// own creative workflow), and must not assume a product has launched just because the warehouse holds stock of it.
//
// EVIDENCE USED, strongest first (a product is judged from what is KNOWN, never from what is missing):
//   1. a manual launch-status override (product_launch_overrides), set by a person
//   2. an Upcoming Drop the product belongs to (styles.drop_id -> drops.launch_date): a future drop date = unlaunched; a past one = launched
//   3. ApparelMagic's launch date for the colourway (`mid_code`): a future date = unlaunched; a past date = launched
//   4. positive sales: units actually sold in the sales history prove it is on sale (not "no sales" - zero sales proves nothing)
// NEVER used on their own: stock quantity, zero sales, or "last creative = never". With no evidence either way the status is UNKNOWN, which is
// flagged for a person to confirm rather than assumed to be launched.
//
// There is no Shopify publication check here: Shopify credentials are deliberately not configured in production yet, and ApparelMagic exposes no product
// status field, so "discontinued / inactive" can only come from a manual override (or ApparelMagic's excluded categories, which families already drop).
//
// Pure: no database, no clock (today is passed in). Colourways are judged one by one so a family can have launched and unlaunched colours.
const STATUSES = ['launched', 'unlaunched', 'upcoming_restock', 'discontinued', 'unknown'];
const DEFAULTS = { sales_launch_units: 10, restock_min_on_order: 30, low_stock_units: 30 };
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

// ONE colourway. input: { launchDate (Date|string|null), drop: { launch_date, name }|null, qty: units sold in the sales history (number|null), override: { status, note }|null }
function assessStyle({ launchDate = null, drop = null, qty = null, override = null }, today, cfg = DEFAULTS) {
  const t = ymd(today);
  if (override && ['launched', 'unlaunched', 'discontinued'].includes(override.status)) {
    return { status: override.status, basis: 'manual', detail: `Set by a person${override.note ? `: ${override.note}` : ''}.` };
  }
  const dropDate = drop && drop.launch_date ? ymd(drop.launch_date) : null;
  if (dropDate && dropDate >= t) return { status: 'unlaunched', basis: 'upcoming_drop', detail: `Part of the upcoming drop${drop.name ? ` "${drop.name}"` : ''} launching ${dropDate}; its creative is handled in Upcoming Drops.`, drop };
  const ld = ymd(launchDate);
  if (ld && ld > t) return { status: 'unlaunched', basis: 'launch_date', detail: `ApparelMagic launch date ${ld} is still ahead.` };
  if (ld && ld <= t) return { status: 'launched', basis: 'launch_date', detail: `ApparelMagic launch date ${ld} has passed.` };
  if (dropDate && dropDate < t) return { status: 'launched', basis: 'past_drop', detail: `Its drop launched ${dropDate}.` };
  if (qty !== null && qty >= cfg.sales_launch_units) return { status: 'launched', basis: 'sales', detail: `${Math.round(qty)} units sold, so it is on sale.` };
  return { status: 'unknown', basis: 'none', detail: 'No launch date, drop or sales history to confirm it has launched. Stock alone does not prove it.' };
}

// A product FAMILY from its colourways. styles: [{ style_code, launchDate, drop, qty, override }]; family-level override applies to every colourway without its own.
function assessFamily({ styles = [], familyOverride = null, stock = null, onOrder = null }, today, cfg = DEFAULTS) {
  const per = styles.map((s) => ({ style_code: s.style_code, ...assessStyle({ ...s, override: s.override || familyOverride }, today, cfg) }));
  const by = (st) => per.filter((x) => x.status === st);
  let status; let basis; let detail;
  if (!per.length) { status = 'unknown'; basis = 'none'; detail = 'No colourways found.'; }
  else if (by('discontinued').length === per.length) { status = 'discontinued'; basis = 'manual'; detail = by('discontinued')[0].detail; }
  else if (by('launched').length) {
    status = 'launched'; basis = by('launched')[0].basis;
    detail = by('launched')[0].detail + (by('unlaunched').length ? ` ${by('unlaunched').length} colourway(s) have not launched and are left out.` : '');
  } else if (by('unlaunched').length) { status = 'unlaunched'; basis = by('unlaunched')[0].basis; detail = by('unlaunched')[0].detail; }
  else { status = 'unknown'; basis = 'none'; detail = per[0].detail; }
  // a launched product that is out / low with a real order on the way is an upcoming restock: eligible where demand justifies it
  const units = stock && stock.known ? Math.max(0, Number(stock.units) || 0) : null;
  const oo = Math.max(0, Number(onOrder) || 0);
  const restock = status === 'launched' && units !== null && units <= cfg.low_stock_units && oo >= cfg.restock_min_on_order;
  if (restock) { status = 'upcoming_restock'; detail += ` ${oo} units are on order.`; }
  const inDrop = per.find((x) => x.basis === 'upcoming_drop');
  return { status, basis, detail, eligible: status === 'launched' || status === 'upcoming_restock', needs_check: status === 'unknown', in_upcoming_drop: !!inDrop, drop: inDrop ? inDrop.drop : null, by_style: per, restock, on_order: oo };
}

module.exports = { STATUSES, DEFAULTS, assessStyle, assessFamily };
