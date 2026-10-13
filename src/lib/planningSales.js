// A product family's RECENT SALES for Planning, with an honest statement of how complete they are. Pure: no database, no network, no clock.
//
// SOURCES (never silently mixed; each figure says where it comes from):
//   recent sales (7 / 14 / 30 days, since launch)   ApparelMagic online sales: orders for the two online customer records (ONLINE SALES, ICONIC ONLINE SALES), approved
//                                                   orders only, net of cancelled quantity. It has per-day detail and records which days could not be read.
//   launch pace and tiers (first 28 / latest 28)    the Shopify export through Demand Planning's own logic (lib/reportPipeline.js). Unchanged by Planning.
// The two are different measures (ApparelMagic includes ICONIC online sales, Shopify does not), so they are compared, not blended: when their latest-28-day figures
// differ by sales_discrepancy_pct AND sales_discrepancy_min_units the item says so and is not given High priority.
//
// COMPLETENESS: the ApparelMagic crawl is one request per day and customer; a request that fails under-counts that day. Any failed day inside the last 30 days
// makes the recent figures "incomplete" (reported, and no High priority is given on them). Today is a part day in every window (daysAgo 0), a small, known, conservative bias.
const DAY = 86400000;
const num = (v) => Number(v) || 0;
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

// style_codes: every colourway of the family; salesByStyle: Map(style -> { qty7, qty14, qty30, qty365, daily }) | null; window: salesByStyle.window
// launchDate: the family's official (mid_code) launch date 'YYYY-MM-DD' | null (earliest launched colourway); tierSales: { recent28, initial28, age_days } | null (Shopify)
function familySales({ style_codes = [], salesByStyle = null, window = null, launchDate = null, today, tierSales = null, cfg }) {
  if (!salesByStyle) return { sales: { available: false }, quality: { sales_complete: null, sales_notes: ['ApparelMagic sales have not loaded yet.'], discrepancy: null } };
  const t = { available: true, units7: 0, units14: 0, units30: 0, units365: 0, daily: {} };
  style_codes.forEach((c) => {
    const e = salesByStyle.get(c); if (!e) return;
    t.units7 += e.qty7 || 0; t.units14 += e.qty14 || 0; t.units30 += e.qty30 || 0; t.units365 += e.qty365 || 0;
    Object.entries(e.daily || {}).forEach(([d, q]) => { t.daily[d] = (t.daily[d] || 0) + q; });
  });
  const dailySum = (fromDay, toDay) => { let s = 0; for (let d = fromDay; d <= toDay; d += 1) s += t.daily[d] || 0; return s; };
  const hasDaily = Object.keys(t.daily).length > 0 || (window && window.fetched_at);
  const launchAge = launchDate ? daysBetween(launchDate, today) : null;
  const out = { available: true, units7: t.units7, units14: salesByStyle.size ? t.units14 : null, units30: t.units30, units365: t.units365, days_live: null, since_launch: null, avg_daily_since_launch: null, am_units28: hasDaily ? dailySum(0, 27) : null };
  // an established product is judged on the 30-day figures; only a recent launch (on sale fewer than 120 days, the per-day history kept) gets a since-launch figure
  if (launchAge !== null && launchAge >= 0) {
    out.days_live = launchAge + 1;
    if (launchAge < 120 && hasDaily) {
      out.since_launch = dailySum(0, launchAge);
      out.avg_daily_since_launch = Math.round((out.since_launch / out.days_live) * 100) / 100;
    }
  }
  // Shopify figures for the same family (Demand Planning's own windows): carried through unchanged
  if (tierSales) { out.initial28 = tierSales.initial28; out.recent28 = tierSales.recent28; out.age_days = tierSales.age_days; out.prior28 = tierSales.prior28; }

  // completeness: failed daily requests inside the windows used
  const failed = (window && Array.isArray(window.failed_days)) ? window.failed_days : null;
  const notes = [];
  let complete = true;
  if (window && window.failed_requests > 0 && failed === null) { complete = null; notes.push(`${window.failed_requests} daily ApparelMagic requests failed (which days is not recorded), so recent sales may be under-counted.`); }
  if (failed) {
    const recent = failed.filter((d) => d < 30);
    if (recent.length) { complete = false; notes.push(`${recent.length} of the last 30 days could not be read from ApparelMagic (${recent.slice(0, 5).map((d) => (d === 0 ? 'today' : `${d} day${d === 1 ? '' : 's'} ago`)).join(', ')}${recent.length > 5 ? ' ...' : ''}), so recent sales may be under-counted.`); }
  }

  // two sources for the latest 28 days: ApparelMagic online sales vs the Shopify export
  let discrepancy = null;
  if (out.am_units28 !== null && tierSales && tierSales.recent28 !== null && tierSales.recent28 !== undefined) {
    const am = out.am_units28; const sh = num(tierSales.recent28);
    const diff = Math.abs(am - sh); const base = Math.max(am, sh);
    const pct = base > 0 ? Math.round((diff / base) * 100) : 0;
    const flag = pct >= cfg.sales_discrepancy_pct && diff >= cfg.sales_discrepancy_min_units;
    discrepancy = { am28: Math.round(am), shopify28: Math.round(sh), diff_units: Math.round(diff), diff_pct: pct, flag, text: `ApparelMagic online sales ${Math.round(am)} against Shopify ${Math.round(sh)} units in the latest 28 days${flag ? '' : ' (consistent)'}; ApparelMagic also includes ICONIC online sales, so some difference is normal` };
  }
  return { sales: out, quality: { sales_complete: complete, sales_notes: notes, discrepancy } };
}

// the family's official launch date: the earliest readable mid_code among its LAUNCHED colourways, as 'YYYY-MM-DD' (null = none readable)
function familyLaunchDate(launchAssessment, amDetails) {
  const dates = ((launchAssessment && launchAssessment.by_style) || [])
    .filter((x) => x.status === 'launched')
    .map((x) => { const d = amDetails && amDetails.get(x.style_code); return d && d.launchDate ? ymd(d.launchDate) : null; })
    .filter(Boolean).sort();
  return dates.length ? dates[0] : null;
}

module.exports = { familySales, familyLaunchDate, daysBetween };
