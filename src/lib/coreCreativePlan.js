// Core creative plan -- "For our CORE products, what creative should we make next, and why?"
//
// One simple planning/intelligence engine for EXISTING CORE apparel (new drops stay in
// Upcoming Drops; this never plans them). It folds together:
//   ApparelMagic      live CORE membership (group), stock + size availability, sales + tiers
//   Meta (local DB)   trusted ads only -- confirmed + auto-matched; creative recency, running
//                     creative, concept evidence, performance (numbers admin-only)
// and reuses the proven Creative Opportunities building blocks (seller tiers, per-product
// signals, concept analysis, test-this-concept rules) rather than a second copy of them.
//
// Rules (provisional thresholds: coreCreativePlanConfig.js)
//   CORE        AM product group is CORE and the style is not an accessory; colourways are one
//               product family; season codes with the same canonical product name are ONE family
//               (so history carries over). Nothing is hardcoded by name.
//   STOCK GATE  < 30 sellable units across the whole family (or stock unknown) => NEVER a shoot
//               recommendation. The product still contributes history / concept learnings.
//   SIZES       broken / limited size availability is a WARNING only, never a gate.
//   strong seller + no/stale creative (or too few running)  -> Shoot fresh creative
//   strong seller + enough fresh creative                    -> no action
//   weak seller + stale / insufficient testing               -> Test new creative
//   weak seller despite plenty of recent new creative        -> Hold off (do NOT shoot more)
//   proven concept on other CORE products, not tried here    -> Try <concept> on <product>
//
// HISTORY HONESTY: daily Meta insights only go back to when syncing started, so spend-based
// facts are limited. Creative recency uses the ad's own Meta creation date per distinct creative
// id, and is only called reliable inside HISTORY.reliable_days (the period every ad was matched);
// older creative is counted only where an ad was matched, and says so.
const { pool } = require('../db');
const cfg = require('./coreCreativePlanConfig');
const coCfg = require('./creativeOpportunitiesConfig');
const co = require('./creativeOpportunities');
const apparelmagic = require('./apparelmagic');
const { canonicalKey } = require('./metaMatchingCatalogue');
const { MEDIA_LABEL } = require('./metaNameParsing');
const { ymdInZone, addDays, REPORTING_TIMEZONE } = require('./metaPerformance');
const creativeActivity = require('./metaCreativeActivity');

const num = (v) => Number(v) || 0;
const round = (v, d = 1) => (v === null || v === undefined ? null : Number(Number(v).toFixed(d)));
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
const ageText = (days) => (days >= 60 ? `${Math.round(days / 30)} months` : plural(days, 'day'));
const money = (v) => `$${Math.round(num(v)).toLocaleString('en-AU')}`;

// ── CORE families (pure) ────────────────────────────────────────────────
// amDetails: Map(style_code -> { productName, category, isCore, imageUrl, ... }) from ApparelMagic.
function buildCoreFamilies(amDetails) {
  const groups = new Map();
  for (const [styleCode, d] of amDetails.entries()) {
    if (!apparelmagic.isWndrrStyleCode(styleCode)) continue;
    const key = canonicalKey(d.productName);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ styleCode, productCode: apparelmagic.deriveProductCode(styleCode), d });
  }
  const families = [];
  groups.forEach((styles) => {
    const core = styles.filter((s) => s.d.isCore && !apparelmagic.isAdExcludedCategory(s.d));
    if (!core.length) return; // not CORE (or only accessories): not part of this plan
    const perCode = new Map();
    core.forEach((s) => perCode.set(s.productCode, (perCode.get(s.productCode) || 0) + 1));
    const rep = [...perCode.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    const first = core.filter((s) => s.productCode === rep).sort((a, b) => a.styleCode.localeCompare(b.styleCode))[0];
    families.push({
      key: rep, product_code: rep, name: first.d.productName, category: first.d.category || null, image_url: first.d.imageUrl || null,
      // every picture ApparelMagic holds for the representative colourway (front / back chosen by apparelmagic.pickFrontBack)
      images: apparelmagic.pickFrontBack((first.d.images && first.d.images.length ? first.d.images : (core.find((x) => x.d.images && x.d.images.length) || { d: {} }).d.images) || []),
      codes: [...new Set(styles.map((s) => s.productCode))].sort(),
      core_codes: [...perCode.keys()].sort(),
      style_codes: styles.map((s) => s.styleCode).sort(),
      size_range_style: first.styleCode,
    });
  });
  families.sort((a, b) => a.name.localeCompare(b.name));
  const codeToFamily = new Map();
  families.forEach((f) => f.codes.forEach((c) => codeToFamily.set(c, f)));
  return { families, codeToFamily };
}

// ── stock + size availability (pure) ────────────────────────────────────
const ALPHA_ORDER = ['XXXS', '3XS', 'XXS', '2XS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', 'XXXL', '3XL', '4XL'];
function orderSizes(entries, preferred) {
  const pref = (preferred || []).map((s) => String(s).toUpperCase());
  const rank = (s) => {
    const i = pref.indexOf(s);
    if (i >= 0) return [0, i, s];
    const a = ALPHA_ORDER.indexOf(s);
    if (a >= 0) return [1, a, s];
    if (/^\d+$/.test(s)) return [2, Number(s), s];
    return [3, 0, s];
  };
  return [...entries].sort((x, y) => {
    const a = rank(x[0]); const b = rank(y[0]);
    return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]);
  }).map(([size, qty]) => ({ size, qty: Math.max(0, Math.round(qty)) }));
}

// Warning-only judgement of a product's size run: [{ size, qty }] in size order.
function sizeHealth(run, z = cfg.SIZE) {
  if (!run || run.length < z.min_sizes_to_judge) return { available: false, level: null, warning: null, run: run || [] };
  const n = run.length;
  const low = run.filter((r) => r.qty < z.min_units_per_size);
  const trim = n >= 5 ? Math.floor(n * z.core_trim) : 0;
  const middle = run.slice(trim, n - trim);
  const middleLow = middle.filter((r) => r.qty < z.min_units_per_size);
  const share = (n - low.length) / n;
  let level = 'ok';
  if (middleLow.length >= 2 || share < z.broken_share) level = 'broken';
  else if (middleLow.length >= 1 || share < z.limited_share) level = 'limited';
  const names = low.map((r) => r.size).join(', ');
  const warning = level === 'ok' ? null : `${level === 'broken' ? 'Broken' : 'Limited'} sizes: ${names} low or sold out (${n - low.length} of ${n} sizes available)`;
  return { available: true, level, warning, run, available_sizes: n - low.length, total_sizes: n };
}

// stock: Map(style -> qty) | null (unknown); sizesByStyle: Map(style -> Map(size -> qty)) | null
// Stock is UNAVAILABLE (known:false) when the stock data hasn't loaded, or when ApparelMagic has no
// inventory record at all for any of the family's styles -- that is a data problem, not "0 units", and
// is reported separately from genuine low stock (units < the minimum).
function familyStock(f, stock, sizesByStyle, preferredSizes) {
  const noSize = { available: false, level: null, warning: null, run: [] };
  if (!stock) return { known: false, units: null, pass: false, reason: 'stock_not_loaded', size: noSize };
  if (!f.style_codes.some((sc) => stock.has(sc))) return { known: false, units: null, pass: false, reason: 'no_stock_record', size: noSize };
  let units = 0;
  const sizeMap = new Map();
  f.style_codes.forEach((sc) => {
    units += Math.max(0, num(stock.get(sc)));
    const sm = sizesByStyle && sizesByStyle.get(sc);
    if (sm) sm.forEach((q, s) => sizeMap.set(s, (sizeMap.get(s) || 0) + Math.max(0, num(q))));
  });
  units = Math.round(units);
  return { known: true, units, pass: units >= cfg.STOCK.min_sellable_units, size: sizeHealth(orderSizes(sizeMap.entries(), preferredSizes)) };
}

// ── history folding: Creative Opportunities snapshot/demand -> CORE families (pure) ─────
// Only ads linked to at least one CORE family are kept; an ad's products become the distinct
// families (old season codes collapse into the family, never double counted).
function foldSnapshot(snapshot, codeToFamily) {
  const ads = [];
  snapshot.ads.forEach((ad) => {
    const seen = new Map();
    ad.products.forEach((p) => {
      const f = codeToFamily.get(p.code);
      if (f && !seen.has(f.key)) seen.set(f.key, { code: f.key, name: f.name });
    });
    if (seen.size) ads.push({ ...ad, products: [...seen.values()] });
  });
  const families = new Map();
  new Set(codeToFamily.values()).forEach((f) => families.set(f.key, f.name));
  const later = (a, b) => (a && b ? (a > b ? a : b) : (a || b));
  const wndrr = new Map();
  snapshot.wndrr.forEach((v, code) => {
    const f = codeToFamily.get(code);
    if (!f) return;
    const cur = wndrr.get(f.key) || { live: null, approved: null, created: null };
    wndrr.set(f.key, { live: later(cur.live, v.live), approved: later(cur.approved, v.approved), created: later(cur.created, v.created) });
  });
  return { ...snapshot, ads, families, wndrr };
}

const TIER_ORDER = ['platinum', 'rocket', 'surfer', 'dog', 'egg'];
function foldDemand(demand, codeToFamily) {
  if (!demand || !demand.available) return demand || { available: false, reason: 'Sales data unavailable', byProduct: new Map() };
  const byProduct = new Map();
  for (const [code, d] of demand.byProduct.entries()) {
    const f = codeToFamily.get(code);
    if (!f) continue;
    const cur = byProduct.get(f.key) || { units_7d: 0, units_30d: 0, units_365d: 0, tier: null };
    cur.units_7d += num(d.units_7d); cur.units_30d += num(d.units_30d); cur.units_365d += num(d.units_365d);
    if (d.tier && (cur.tier === null || TIER_ORDER.indexOf(d.tier) < TIER_ORDER.indexOf(cur.tier))) cur.tier = d.tier;
    byProduct.set(f.key, cur);
  }
  return { ...demand, byProduct };
}

// ── creative facts for one family (pure) ────────────────────────────────
// A "creative" is a distinct Meta creative id (exact identity; never a name). WNDRR duplicates the same creative into many
// campaigns / ad sets, so everything that drives Planning counts UNIQUE creatives:
//   * first_created  the earliest creation date of ANY ad that uses the creative (a duplicate re-uses its creative, so is
//                    not "new"). With `activity` this looks at every ad of the exact creative id, classified or not.
//   * active         at least one ad of the creative is delivering / newly live (see metaCreativeActivity.verdict). Without
//                    `activity` (pure tests, no database) the older rule applies: an included ad is ACTIVE or has recent spend.
// The number of ads behind the active creatives (`active_ads`) is context only.
// `activity` = { byCreative: Map(id -> row), insights_last_day } from metaCreativeActivity.loadCreativeActivity.
function creativeFacts(ps, today, wndrr, activity) {
  const days = co.daysBetween; // (fromYmd, toYmd) -> whole days
  const by = new Map();
  ps.entries.forEach(({ ad }) => {
    const c = by.get(ad.creative_key) || { key: ad.creative_key, first_created: null, ads: [], running: false, unidentified: ad.creative_key === ad.id };
    if (ad.created && (!c.first_created || ad.created < c.first_created)) c.first_created = ad.created;
    c.ads.push(ad);
    if (ad.effective_status === 'ACTIVE' || num(ad.w.m.spend) > 0) c.running = true;
    by.set(ad.creative_key, c);
  });
  const creatives = [...by.values()];
  let activeAds = 0;
  creatives.forEach((c) => {
    const act = activity && !c.unidentified ? activity.byCreative.get(c.key) : null;
    if (act) {
      // exact creative identity: the facts cover every ad that shares this creative id, not just the ones matched to this product
      if (act.first_created && (!c.first_created || act.first_created < c.first_created)) c.first_created = act.first_created;
      c.ads_total = act.ads_total;
      const v = creativeActivity.verdict(act, { today, insights_last_day: activity.insights_last_day });
      c.running = v.active; c.active_ads = v.active_ads; c.active_basis = v.basis; c.last_delivery = act.last_delivery || null;
    } else {
      c.ads_total = c.ads.length;
      c.active_ads = c.running ? c.ads.filter((a) => a.effective_status === 'ACTIVE' || num(a.w.m.spend) > 0).length : 0;
      c.active_basis = 'matched_ads_only';
    }
    if (c.running) activeAds += c.active_ads;
  });
  const dated = creatives.filter((c) => c.first_created);
  const newestMeta = dated.length ? dated.map((c) => c.first_created).sort().pop() : null;
  const w = (wndrr && wndrr.get(ps.code)) || { live: null };
  const cands = [newestMeta ? { date: newestMeta, source: 'Earliest Meta ad created with that exact creative' } : null, w.live ? { date: w.live, source: 'WNDRR creative went live' } : null]
    .filter(Boolean).sort((a, b) => (a.date < b.date ? 1 : -1));
  const newest = cands[0] || null;
  const since = addDays(today, -cfg.HISTORY.reliable_days);
  const running = creatives.filter((c) => c.running);
  const runAges = running.map((c) => (c.first_created ? days(c.first_created, today) : null)).filter((x) => x !== null);
  return {
    creatives,
    creatives_total: creatives.length,
    // the number that drives Planning: UNIQUE creatives with an ad delivering now. `running_creatives` is the legacy name.
    active_unique_creatives: running.length,
    running_creatives: running.length,
    active_ads: activeAds,
    historical_unique_creatives: creatives.length - running.length,
    unidentified_creatives: creatives.filter((c) => c.unidentified).length, // ads with no creative id: each can only count as itself
    active_basis: !activity ? 'matched_ads_only' : (running.some((c) => c.active_basis === 'status_only') ? 'status_only' : 'delivery'),
    new_creatives_90d: dated.filter((c) => c.first_created >= since).length,
    last_new_creative: newest ? { date: newest.date, source: newest.source, days_ago: Math.max(0, days(newest.date, today)) } : null,
    // inside the reliable window a gap is real; beyond it, "none" only means none that we matched
    recency_basis: newest && newest.date >= since ? 'known' : newest ? 'older_than_window' : 'none_found',
    newest_running_days: runAges.length ? Math.min(...runAges) : null,
    oldest_running_days: runAges.length ? Math.max(...runAges) : null,
  };
}

function freshnessBandOf(daysAgo) {
  const f = coCfg.FRESHNESS;
  if (daysAgo === null || daysAgo === undefined) return 'very_stale';
  if (daysAgo < f.fresh_lt) return 'fresh';
  if (daysAgo < f.aging_lt) return 'aging';
  if (daysAgo < f.stale_lt) return 'stale';
  return 'very_stale';
}

const SALES_LABEL = { strong: 'Selling strongly', weak: 'Selling slowly', neutral: 'Selling steadily' };

// Qualitative Meta label (numbers stay admin-only).
function metaLabel(e, benchmarkCpa) {
  const M = cfg.META_LABEL;
  const spend = num(e.spend); const purch = num(e.purchases);
  if (spend < M.min_spend_for_judgement) return 'limited data';
  if (purch === 0) return spend >= M.weak_min_spend_no_purchases ? 'weak' : 'limited data';
  const cpa = spend / purch;
  if (benchmarkCpa) {
    if (cpa <= benchmarkCpa * M.strong_cpa_ratio) return 'strong';
    if (cpa >= benchmarkCpa * M.weak_cpa_ratio) return 'weak';
  }
  return 'average';
}

function cardBase({ type, family, ps, facts, stock, priority, severity, headline, why, benchmarkCpa, strength }) {
  const sales = ps && ps.sales ? ps.sales : null;
  const score = (coCfg.PRIORITY_BASE[priority] || 0) + Math.max(0, Math.min(100, Math.round(strength || 0)));
  return {
    key: `core:${type}:${family.key}`,
    type, headline, why, priority, severity, score,
    product: { product_code: family.product_code, product_name: family.name, category: family.category, image_url: family.image_url, images: family.images || { front: null, back: null, count: 0 } },
    sales_status: sales ? { label: SALES_LABEL[sales.seller_class] || 'Selling steadily', seller_class: sales.seller_class, tier: sales.tier_label, trend: sales.trend ? sales.trend.direction : null } : null,
    stock: { units: stock.units, size_warning: stock.size.warning, size_level: stock.size.level },
    creative: {
      last_new_creative: facts.last_new_creative, recency_basis: facts.recency_basis, running_creatives: facts.running_creatives,
      active_unique_creatives: facts.active_unique_creatives, active_ads: facts.active_ads, historical_unique_creatives: facts.historical_unique_creatives,
      active_basis: facts.active_basis,
      creatives_total: facts.creatives_total, new_creatives_90d: facts.new_creatives_90d,
      newest_running_days: facts.newest_running_days, oldest_running_days: facts.oldest_running_days,
    },
    meta_status: ps ? metaLabel(ps.e, benchmarkCpa) : 'limited data',
  };
}

// The recommendation for one family IGNORING the stock gate (the gate is applied by the caller so
// we can also report what a low-stock product would otherwise have been recommended).
function recommendFamily({ family, ps, facts, stock, benchmarkCpa, salesAvailable }) {
  if (!salesAvailable || !ps || !ps.sales) return null; // no sales signal -> no seller-based recommendation
  const cls = ps.sales.seller_class;
  const band = freshnessBandOf(facts.last_new_creative ? facts.last_new_creative.days_ago : null);
  const days = facts.last_new_creative ? facts.last_new_creative.days_ago : null;
  const fresh = band === 'fresh' || band === 'aging';
  const enough = facts.active_unique_creatives >= cfg.USABLE_MIN_CREATIVES;
  const vel = ps.sales.vel30 || 0;
  const salesBasis = `${ps.sales.tier_label ? `${ps.sales.tier_label} tier` : 'strong recent sales'}${ps.sales.trend && ps.sales.trend.direction === 'up' ? ', sales rising' : ''}`;
  const common = { family, ps, facts, stock, benchmarkCpa };

  if (cls === 'strong') {
    if (fresh && enough) return null; // strong + enough fresh creative: no action
    const veryStale = band === 'very_stale';
    let why;
    if (days === null) why = `${family.name} is selling strongly (${salesBasis}) and we have no creative on record for it.`;
    else if (!fresh) why = `${family.name} is selling strongly (${salesBasis}) but its newest creative is ${ageText(days)} old.`;
    else why = `${family.name} is selling strongly (${salesBasis}) and its creative is recent, but only ${plural(facts.active_unique_creatives, 'unique creative')} ${facts.active_unique_creatives === 1 ? 'is' : 'are'} active${facts.active_ads > facts.active_unique_creatives ? ` (across ${plural(facts.active_ads, 'ad')})` : ''} (we want ${cfg.USABLE_MIN_CREATIVES}+ distinct creatives).`;
    return cardBase({ ...common, type: 'shoot_fresh', priority: veryStale ? 'Critical' : 'High', severity: days === null ? 99 : Math.floor(days / 60), headline: 'Shoot fresh creative', why,
      strength: (days === null ? 60 : Math.min(60, days / 2)) + Math.min(25, vel) + (ps.sales.trend && ps.sales.trend.direction === 'up' ? 15 : 0) });
  }
  if (cls === 'weak') {
    if (facts.new_creatives_90d >= cfg.HOLD.min_new_creatives_90d) {
      return cardBase({ ...common, type: 'hold', priority: 'Info', severity: 0, headline: 'Hold off on more creative',
        why: `Sales are soft even though ${plural(facts.new_creatives_90d, 'new creative')} ${facts.new_creatives_90d === 1 ? 'was' : 'were'} tested in the last ${cfg.HISTORY.reliable_days} days. More creative is unlikely to be the fix: review whether to keep investing in ${family.name} before shooting more.`,
        strength: 0 });
    }
    const why = days === null
      ? `Sales are soft and ${family.name} has no creative on record, so it hasn't had a fair test.`
      : !fresh
        ? `Sales are soft and ${family.name} hasn't had new creative for ${ageText(days)}: try a fresh angle before deciding whether to drop it.`
        : `Sales are soft and ${family.name} has had only ${plural(facts.new_creatives_90d, 'new creative')} in the last ${cfg.HISTORY.reliable_days} days: not enough testing to judge it fairly.`;
    return cardBase({ ...common, type: 'test_new', priority: days === null || days >= 240 ? 'High' : 'Medium', severity: days === null ? 99 : Math.floor(days / 60), headline: 'Test new creative', why,
      strength: (days === null ? 50 : Math.min(50, days / 4)) + Math.min(30, (ps.sales.units_365d || 0) / 10) });
  }
  // steady seller: only flag one with no creative at all
  if (facts.creatives_total === 0 && (ps.sales.units_30d || 0) >= coCfg.RELEVANCE.min_units_30d) {
    return cardBase({ ...common, type: 'test_new', priority: 'Medium', severity: 99, headline: 'Test new creative',
      why: `${family.name} sells steadily but we have no creative on record for it.`, strength: Math.min(40, vel) });
  }
  return null;
}

// ── the plan (pure core; orchestration below feeds it) ──────────────────
function buildPlan({ families, codeToFamily, snapshot, demand, stock, sizesByStyle, sizeOrderFor, now = new Date(), stateRows = [], salesAvailable, activity }) {
  const folded = foldSnapshot(snapshot, codeToFamily);
  const foldedDemand = foldDemand(demand, codeToFamily);
  const sellers = co.classifySellers(foldedDemand);
  const signals = co.buildProductSignals(folded, sellers);
  const concepts = co.analyseConcepts(folded);
  const today = snapshot.win.today;
  const benchmarkCpa = concepts.benchmark.cpa;

  const heldLowStock = [];
  const stockUnavailable = [];
  const noAction = [];
  const cards = [];
  const stockByFamily = new Map();
  const factsByFamily = new Map();
  families.forEach((f) => {
    const st = familyStock(f, stock, sizesByStyle, sizeOrderFor ? sizeOrderFor(f.size_range_style) : []);
    stockByFamily.set(f.key, st);
    const ps = signals.get(f.key) || null;
    const facts = creativeFacts(ps || { entries: [], code: f.key }, today, folded.wndrr, activity);
    factsByFamily.set(f.key, facts);
    const rec = recommendFamily({ family: f, ps, facts, stock: st, benchmarkCpa, salesAvailable });
    if (!rec) { noAction.push(f.name); return; }
    if (rec.type === 'hold') { cards.push(rec); return; } // a "do not shoot" insight: not a shoot recommendation, so the gate doesn't apply
    // Only a KNOWN count under the minimum is "low stock"; no count at all is "stock unavailable".
    if (!st.known) { stockUnavailable.push({ product_code: f.product_code, product_name: f.name, reason: st.reason, would_have_been: rec.headline }); return; }
    if (!st.pass) { heldLowStock.push({ product_code: f.product_code, product_name: f.name, units: st.units, known: true, would_have_been: rec.headline }); return; }
    cards.push(rec);
  });

  // "Try this concept on X": concepts proven on CORE products, only for products that pass the gate and aren't on hold
  const holdKeys = new Set(cards.filter((c) => c.type === 'hold').map((c) => c.product.product_code));
  const eligible = new Map([...signals.entries()].filter(([key]) => {
    const st = stockByFamily.get(key);
    return st && st.pass && !holdKeys.has(key);
  }));
  const tries = salesAvailable ? co.recTestConcepts(eligible, concepts, folded).slice(0, cfg.LIMITS.max_try_concept_total) : [];
  const familyByKey = new Map(families.map((f) => [f.key, f]));
  tries.forEach((o) => {
    const f = familyByKey.get(o.products[0].product_code);
    const ps = signals.get(f.key);
    const facts = factsByFamily.get(f.key);
    const c = concepts.concepts.find((x) => x.key === o.recommended_concept.key);
    const examples = c.products.slice(0, cfg.LIMITS.concept_example_products).map((p) => p.name).join(', ');
    const card = cardBase({
      type: 'try_concept', family: f, ps, facts, stock: stockByFamily.get(f.key), benchmarkCpa,
      priority: o.priority, severity: o.severity, strength: o.rank.strength,
      headline: `Try ${c.label} on ${f.name}`,
      why: `${c.label} is working well on ${examples}${c.products_used_on > cfg.LIMITS.concept_example_products ? ' and others' : ''}. ${f.name} hasn't tried it yet.`,
    });
    card.key = `core:try_concept:${f.key}:${c.key}`;
    card.concept = { key: c.key, label: c.label, media: o.recommended_media ? o.recommended_media.label : null, products_used_on: c.products_used_on };
    card._concept_ads = folded.ads.filter((a) => a.concept_key === c.key && num(a.w.e.spend) > 0).sort((a, b) => num(b.w.e.spend) - num(a.w.e.spend)).slice(0, cfg.LIMITS.concept_evidence_ads);
    cards.push(card);
  });

  // evidence (admin-only money lives under .admin so it can be stripped server-side)
  cards.forEach((card) => {
    const f = familyByKey.get(card.product.product_code);
    const ps = signals.get(f.key);
    const facts = factsByFamily.get(f.key);
    card.evidence = buildEvidence({ card, family: f, ps, facts, stock: stockByFamily.get(f.key), today });
    delete card._concept_ads;
  });

  const split = co.applyStates(cards, stateRows, now);
  const sortFn = (a, b) => b.score - a.score || a.product.product_name.localeCompare(b.product.product_name);
  const active = split.active.sort(sortFn);
  const stockKnown = !!stock;
  return {
    recommendations: active.filter((c) => c.type !== 'hold'),
    hold: active.filter((c) => c.type === 'hold'),
    dismissed: split.dismissed.sort(sortFn),
    acted_on: split.acted_on.sort(sortFn),
    held_low_stock: heldLowStock.sort((a, b) => (b.units || 0) - (a.units || 0) || a.product_name.localeCompare(b.product_name)),
    stock_unavailable: stockUnavailable.sort((a, b) => a.product_name.localeCompare(b.product_name)),
    no_action: noAction.sort(),
    counts: {
      core_products: families.length,
      eligible: families.filter((f) => stockByFamily.get(f.key) && stockByFamily.get(f.key).pass).length,
      held_low_stock: heldLowStock.length,
      stock_unavailable: stockUnavailable.length,
      recommendations: active.filter((c) => c.type !== 'hold').length,
      hold: active.filter((c) => c.type === 'hold').length,
      no_action: noAction.length,
      stock_known: stockKnown,
    },
    concepts: { proven: concepts.concepts.filter((c) => c.status === 'proven').length, benchmark_cpa: benchmarkCpa },
    folded_ads: folded.ads.length,
  };
}

function buildEvidence({ card, family, ps, facts, stock, today }) {
  const sales = ps && ps.sales ? ps.sales : null;
  const creatives = facts.creatives
    .map((c) => {
      const ads = [...c.ads].sort((a, b) => num(b.w.e.spend) - num(a.w.e.spend));
      const rep = ads[0];
      const spend = c.ads.reduce((s, a) => s + num(a.w.e.spend), 0);
      const purchases = c.ads.reduce((s, a) => s + num(a.w.e.purchases), 0);
      return {
        meta_ad_id: rep.id, ad_name: rep.name, first_created: c.first_created, running: c.running, concept: rep.concept_label || null,
        media: rep.media_key ? MEDIA_LABEL[rep.media_key] || rep.media_key : null, ads_using: c.ads_total || c.ads.length, active_ads: c.active_ads || 0,
        last_delivery: c.last_delivery || null,
        admin: { spend: round(spend, 2), purchases: round(purchases, 1), cpa: purchases > 0 ? round(spend / purchases, 2) : null },
      };
    })
    .sort((a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || String(b.first_created || '').localeCompare(String(a.first_created || '')))
    .slice(0, cfg.LIMITS.evidence_creatives);
  const m = ps ? ps.e : null;
  return {
    sales: sales ? { available: true, label: SALES_LABEL[sales.seller_class] || 'Selling steadily', tier: sales.tier_label, trend: sales.trend ? sales.trend.display : null, units_7d: sales.units_7d, units_30d: sales.units_30d, units_365d: sales.units_365d } : { available: false },
    stock: { units: stock.units, minimum: cfg.STOCK.min_sellable_units, sizes: stock.size.available ? stock.size.run : null, size_warning: stock.size.warning },
    creative: {
      last_new_creative: facts.last_new_creative, recency_basis: facts.recency_basis, running_creatives: facts.running_creatives, creatives_total: facts.creatives_total,
      active_unique_creatives: facts.active_unique_creatives, active_ads: facts.active_ads, historical_unique_creatives: facts.historical_unique_creatives,
      unidentified_creatives: facts.unidentified_creatives, active_basis: facts.active_basis,
      new_creatives_90d: facts.new_creatives_90d, newest_running_days: facts.newest_running_days, oldest_running_days: facts.oldest_running_days,
      reliable_since: addDays(today, -cfg.HISTORY.reliable_days),
    },
    meta: { label: card.meta_status, admin: m ? { spend_90d: round(m.spend, 2), purchases_90d: round(m.purchases, 1), cpa_90d: m.purchases > 0 ? round(m.spend / m.purchases, 2) : null, spend_30d: round(ps.m.spend, 2) } : null },
    creatives,
    concept: card.concept ? {
      ...card.concept,
      ads: (card._concept_ads || []).map((a) => ({ meta_ad_id: a.id, ad_name: a.name, products: a.products.map((p) => p.name), created: a.created, media: a.media_key ? MEDIA_LABEL[a.media_key] || a.media_key : null, admin: { spend: round(a.w.e.spend, 2), purchases: round(a.w.e.purchases, 1) } })),
    } : null,
    attribution: 'Based on confirmed and auto-matched ads only. A creative is a distinct Meta creative; its date is when the first ad using it was created.',
  };
}

// Strip money (spend / purchases / CPA) for non-admins. Done on the server, not hidden in the UI.
function sanitizeForUser(plan, isAdmin) {
  if (isAdmin) return plan;
  const strip = (c) => {
    const ev = c.evidence;
    return {
      ...c,
      evidence: {
        ...ev,
        meta: { label: ev.meta.label },
        creatives: ev.creatives.map(({ admin, ...rest }) => rest),
        concept: ev.concept ? { ...ev.concept, ads: ev.concept.ads.map(({ admin, ...rest }) => rest) } : null,
      },
    };
  };
  const out = { ...plan };
  ['recommendations', 'hold', 'dismissed', 'acted_on'].forEach((k) => { out[k] = plan[k].map(strip); });
  out.concepts = { proven: plan.concepts.proven };
  return out;
}

// ── orchestration ───────────────────────────────────────────────────────
// deps: injectable sources for tests (amDetails, stock, sizesByStyle, sizeRanges, demand, snapshot, stateRows, amStatus).
async function computePlan({ now = new Date(), isAdmin = false } = {}, deps = {}) {
  if (!apparelmagic.configured() && !deps.amDetails) {
    return { available: false, reason: 'ApparelMagic is not configured, so the CORE product list cannot be loaded.', data_status: { catalogue: false } };
  }
  const status = deps.amStatus || apparelmagic.getAmCacheStatus();
  if (!deps.amDetails && !status.catalogue.hasData) {
    return { available: false, loading: true, reason: 'The ApparelMagic product catalogue is still loading. Try again in a few minutes.', data_status: { catalogue: false } };
  }
  const amDetails = deps.amDetails || await apparelmagic.getStyleCatalogue();
  const stockReady = deps.stock !== undefined ? !!deps.stock : !!status.stock.hasData;
  const [stockObj, sizeRanges] = await Promise.all([
    deps.stock !== undefined ? Promise.resolve(deps.stock) : (stockReady ? apparelmagic.getStockByStyle() : Promise.resolve(null)),
    // size ranges only order the size run: never block on a cold crawl for them
    deps.sizeRanges !== undefined ? Promise.resolve(deps.sizeRanges) : (apparelmagic.configured() && status.sizeRanges && status.sizeRanges.hasData ? apparelmagic.getSizeRanges().catch(() => null) : Promise.resolve(null)),
  ]);
  const { families, codeToFamily } = buildCoreFamilies(amDetails);
  const sizeOrderFor = (styleCode) => {
    try { return apparelmagic.resolveStyleSizing(amDetails, sizeRanges, styleCode).sizes || []; } catch (e) { return []; }
  };

  const [snapshot, demand, stateRes, quality] = await Promise.all([
    deps.snapshot ? Promise.resolve(deps.snapshot) : co.loadSnapshot(now),
    deps.demand !== undefined ? Promise.resolve(deps.demand) : co.providers.demand().catch((err) => ({ available: false, reason: `Sales data unavailable (${err.message})`, byProduct: new Map() })),
    deps.stateRows ? Promise.resolve({ rows: deps.stateRows }) : pool.query("SELECT * FROM creative_opportunity_states WHERE opportunity_key LIKE 'core:%'"),
    deps.quality ? Promise.resolve(deps.quality) : dataQuality(now),
  ]);
  const salesAvailable = !!(demand && demand.available);
  // Unique-creative activity over EVERY ad that shares an included creative's exact id (classified or not). One set-based read.
  const activity = deps.activity !== undefined ? deps.activity : await creativeActivity.loadCreativeActivity(
    snapshot.ads.filter((a) => a.creative_key !== a.id).map((a) => a.creative_key),
    { today: snapshot.win.today, recentDays: coCfg.WINDOWS.recent_days }
  );
  const plan = buildPlan({
    families, codeToFamily, snapshot, demand, stock: stockObj || null, sizesByStyle: stockObj ? stockObj.sizes : null,
    sizeOrderFor, now, stateRows: stateRes.rows, salesAvailable, activity,
  });
  const sizeField = stockObj ? stockObj.sizeField : null;
  const out = {
    available: true,
    generated_at: new Date().toISOString(),
    config_version: cfg.VERSION,
    stock_minimum: cfg.STOCK.min_sellable_units,
    ...plan,
    data_status: {
      catalogue: true,
      stock: { available: !!stockObj, note: stockObj ? null : 'Stock has not loaded yet: recommendations are withheld until it does.', unavailable_products: plan.stock_unavailable.length },
      sizes: { available: !!stockObj && !!sizeField, note: stockObj && !sizeField ? 'ApparelMagic did not expose stock by size, so size warnings are off.' : null },
      sales: { available: salesAvailable, note: salesAvailable ? null : `${(demand && demand.reason) || 'Sales data unavailable'}: sales-based recommendations are paused.` },
      meta: {
        history_first_day: snapshot.coverage.first_day, history_last_day: snapshot.coverage.last_day,
        note: 'Daily Meta performance is only stored from the first synced day, so spend and CPA cover a short period. Creative dates come from each ad\'s own Meta creation date.',
        creative_activity: activity ? { basis: activity.insights_last_day && activity.insights_last_day >= addDays(snapshot.win.today, -creativeActivity.INSIGHTS_STALE_DAYS) ? 'delivery' : 'status_only', insights_last_day: activity.insights_last_day } : null,
      },
      matching: { trusted_ads_used: snapshot.ads.length, unreviewed_recent_ads: quality.unreviewed_recent_ads, reliable_days: cfg.HISTORY.reliable_days, ads_included: 'confirmed + auto-matched only' },
    },
  };
  return sanitizeForUser(out, isAdmin);
}

// Ads created inside the reliable window that are NOT confirmed / auto-matched: they are invisible to the
// plan, so a high number means "creative recency may be understated".
async function dataQuality(now = new Date()) {
  const since = addDays(ymdInZone(now, REPORTING_TIMEZONE), -cfg.HISTORY.reliable_days);
  const r = await pool.query(
    "SELECT count(*)::int AS n FROM meta_ads WHERE created_time >= $1::date AND match_status NOT IN ('confirmed', 'auto_matched')",
    [since]
  );
  return { unreviewed_recent_ads: r.rows[0].n };
}

// Dismiss / mark acted-on / reopen one card (any Planning user). Re-derives nothing: the key is
// the contract and the stored fingerprint is the card as the person saw it.
async function setState({ key, state, note, userId, card }) {
  if (!key || typeof key !== 'string' || !key.startsWith('core:') || key.length > 300) throw Object.assign(new Error('Invalid key'), { status: 400 });
  if (!['dismissed', 'acted_on', 'open'].includes(state)) throw Object.assign(new Error('state must be dismissed, acted_on or open'), { status: 400 });
  if (state === 'open') {
    await pool.query('DELETE FROM creative_opportunity_states WHERE opportunity_key = $1', [key]);
    return { key, state: 'open' };
  }
  const type = key.split(':')[1];
  const code = key.split(':')[2];
  await pool.query(
    `INSERT INTO creative_opportunity_states (opportunity_key, rec_type, product_code, state, priority, severity, snapshot, note, acted_by_user_id, acted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (opportunity_key) DO UPDATE SET state = EXCLUDED.state, priority = EXCLUDED.priority, severity = EXCLUDED.severity,
       snapshot = EXCLUDED.snapshot, note = EXCLUDED.note, acted_by_user_id = EXCLUDED.acted_by_user_id, acted_at = now()`,
    [key, type, code, state, (card && card.priority) || null, (card && card.severity) || 0, JSON.stringify({ headline: card && card.headline, why: card && card.why }), note ? String(note).slice(0, 500) : null, userId || null]
  );
  return { key, state };
}

module.exports = {
  buildCoreFamilies, orderSizes, sizeHealth, familyStock, foldSnapshot, foldDemand, creativeFacts, freshnessBandOf, metaLabel,
  recommendFamily, buildPlan, buildEvidence, sanitizeForUser, computePlan, dataQuality, setState,
};
