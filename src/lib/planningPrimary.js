// ONE primary recommendation per product. A product may be evaluated for several opportunity types internally (core, revival = High Stocks, momentum = Protect
// Momentum); the page shows exactly one row for it, says which type it is, and lists any other type it also qualifies for. Pure.
//
// RULES (official classifications are never changed by a recommendation):
//   * An OFFICIAL CORE product (ApparelMagic group AA CORE STYLES) always stays in Core. Its own Core evaluation decides its status. If that is not an action but it qualifies for
//     Protect Momentum (a genuinely recent launch with real demand) the row stays in Core with the opportunity type "Protect momentum". A High Stocks result NEVER replaces
//     a Core result (it used to: a Core product that failed the Core demand check could reappear as a "revival"); it is only listed as "also qualifies".
//   * A non-Core product is a High Stocks revival (Platinum / Rocket, 56+ days of history) OR a Protect Momentum recent launch, never both: the higher score wins
//     (ties go to the revival), and when neither is an action the more informative status is shown.
//   * Protect Momentum products that are not Core are listed in their own view inside the Core step labelled "Not Core: recent launch"; they are never relabelled as Core.
const RANK = { act: 0, testing: 1, in_production: 2, insufficient_data: 3, covered: 4, momentum_ok: 4, out_of_season: 5, weak_demand: 6, low_stock: 7, too_new: 8, no_proven_demand: 9, not_recent: 10, unavailable: 11, launch_unknown: 12, not_launched: 13 };
const rank = (e) => (e && RANK[e.status] !== undefined ? RANK[e.status] : 99);
const MODE_LABEL = { core: 'Core', revival: 'High Stocks revival', momentum: 'Protect momentum' };

// evals: { core, revival, momentum } (any may be null/undefined = not evaluated)
function choosePrimary({ is_core = false, core = null, revival = null, momentum = null } = {}) {
  const acts = (e) => !!(e && e.actionable);
  let primary; let placement;
  if (is_core) {
    placement = 'core';
    if (core && (acts(core) || !acts(momentum))) primary = core;
    else primary = momentum; // Core did not qualify but it is a genuine recent launch: still a Core product, opportunity type Protect momentum
    if (!primary) primary = core || momentum || revival;
  } else if (acts(revival) && acts(momentum)) {
    primary = revival.score >= momentum.score ? revival : momentum;
  } else if (acts(revival)) primary = revival;
  else if (acts(momentum)) primary = momentum;
  else primary = [revival, momentum].filter(Boolean).sort((a, b) => rank(a) - rank(b) || (a.mode === 'revival' ? -1 : 1))[0] || null;
  if (!is_core) placement = primary && primary.mode === 'momentum' ? 'momentum' : 'high_stocks';
  const also = [core, revival, momentum].filter((e) => e && e !== primary && acts(e)).map((e) => ({ mode: e.mode, label: MODE_LABEL[e.mode], priority: e.priority, score: e.score, headline: e.headline }));
  const evaluated = [['core', core], ['revival', revival], ['momentum', momentum]].filter(([, e]) => e).map(([m]) => m);
  return { primary, placement, also, evaluated };
}

module.exports = { choosePrimary, RANK, MODE_LABEL };
