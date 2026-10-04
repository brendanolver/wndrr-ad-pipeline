// The ONE place every Meta reporting choice lives -- which Meta action_type
// counts as a "Purchase" / "Add to Cart" / purchase value, and which
// attribution window the sync explicitly requests. Nothing else in the app
// hard-codes any of these (metaSync.js and the routes only ever read them
// from here), so changing a choice is a one-line edit below -- or an env
// var, no code change at all -- never a schema change.
//
// CONVERSION ACTION TYPES: VERIFIED against Meta Ads Manager (first real
// production sync, 2-4 Oct 2026, same attribution window):
//   Purchases        Ads Manager 299          stored omni_purchase 299
//   Adds to Cart     Ads Manager 3,441        stored omni_add_to_cart 3,441
//   Purchase value   Ads Manager ~$50,578.57  stored omni_purchase $50,578.57
// So omni_purchase / omni_add_to_cart (and omni_purchase in action_values
// for value) are WNDRR's canonical conversion actions, not provisional
// defaults. They stay overridable via env for the same reason any other
// reporting choice would be (see below) -- but the defaults are now settled.
//
// ATTRIBUTION WINDOW: still PROVISIONAL (see DEFAULT_ATTRIBUTION_WINDOWS
// below) until attribution behaviour is separately verified.
//
// The real WNDRR account returns overlapping aliases for the same real
// event, for example: purchase, omni_purchase,
// offsite_conversion.fb_pixel_purchase, onsite_web_purchase (and equivalent
// add-to-cart variants). They must never be summed together -- exactly one
// action_type per metric is selected, matched by exact string.
//
// Changing a choice later needs no schema change and no Meta call:
// meta_ad_insights_daily keeps the full raw action breakdown for every
// ad/day (raw_actions / raw_action_values), and metaSync.rederiveConversions
// recomputes the derived purchases / add_to_cart / purchase_value columns
// from that stored raw JSON using whatever this file currently says.

const DEFAULT_CONVERSION_ACTION_TYPES = {
  // Verified against Ads Manager for 2-4 Oct 2026 (see the note at the top
  // of this file): Meta's deduplicated cross-source total.
  purchase: 'omni_purchase',
  purchaseValue: 'omni_purchase',
  addToCart: 'omni_add_to_cart',
};

// Provisional, NOT confirmed as the WNDRR ad account's own default -- Meta
// doesn't expose that cleanly (use_account_attribution_setting is not a
// valid Insights field; Meta returned error #100 in the validation round,
// and nothing here ever requests it). 7d_click + 1d_view is requested
// explicitly on every pull purely so results are deterministic; whether it
// matches what Ads Manager shows is verified during production QA before
// attribution behaviour is finalised.
const DEFAULT_ATTRIBUTION_WINDOWS = ['7d_click', '1d_view'];

function envString(name) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

// Env overrides are read on every call (not cached at require time) so a
// test -- or a redeploy with a changed variable -- always sees the current
// value. Unset/blank means "use the default above".
function getConversionConfig() {
  return {
    purchase: envString('META_PURCHASE_ACTION_TYPE') || DEFAULT_CONVERSION_ACTION_TYPES.purchase,
    purchaseValue: envString('META_PURCHASE_VALUE_ACTION_TYPE')
      || envString('META_PURCHASE_ACTION_TYPE')
      || DEFAULT_CONVERSION_ACTION_TYPES.purchaseValue,
    addToCart: envString('META_ADD_TO_CART_ACTION_TYPE') || DEFAULT_CONVERSION_ACTION_TYPES.addToCart,
  };
}

function getAttributionWindows() {
  const override = envString('META_ATTRIBUTION_WINDOWS');
  if (!override) return DEFAULT_ATTRIBUTION_WINDOWS;
  const windows = override.split(',').map((w) => w.trim()).filter(Boolean);
  return windows.length ? windows : DEFAULT_ATTRIBUTION_WINDOWS;
}

// Stored on every daily row: exactly what WE requested for that pull, never
// presented as a value Meta confirmed as the account setting.
function getAttributionLabel() {
  return `${getAttributionWindows().join(',')} (provisional, explicitly requested)`;
}

// Exact-match extraction -- never falls back to a different action_type. A
// row with no matching entry is 0, not a guess from a similar-looking alias.
function exactValue(arr, actionType) {
  if (!Array.isArray(arr)) return 0;
  const match = arr.find((a) => a && a.action_type === actionType);
  return match ? Number(match.value) || 0 : 0;
}

// The single derivation used by BOTH the live sync (metaSync.mapInsightsRow)
// and the stored-data re-derive (metaSync.rederiveConversions), so the two
// can never disagree about what "a purchase" means.
function deriveConversions(actions, actionValues, config = getConversionConfig()) {
  return {
    purchases: Math.round(exactValue(actions, config.purchase)),
    add_to_cart: Math.round(exactValue(actions, config.addToCart)),
    purchase_value: exactValue(actionValues, config.purchaseValue),
  };
}

module.exports = {
  DEFAULT_CONVERSION_ACTION_TYPES,
  DEFAULT_ATTRIBUTION_WINDOWS,
  getConversionConfig,
  getAttributionWindows,
  getAttributionLabel,
  deriveConversions,
};
