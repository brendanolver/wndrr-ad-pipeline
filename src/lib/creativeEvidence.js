// How a product's running creative is DISTRIBUTED, as opposed to how each ad performs: concentration in one ad, and concept diversity. Pure.
//
// Inputs are the per-creative verdicts from productAdPerformance (each carries the creative's spend and purchases over the evidence window, its concept label and its ad count).
//   concentration  one creative carries at least concentration_share_pct of the product's spend (and, when there are enough purchases, of its purchases) once the
//                  product has spent at least concentration_min_spend. A product with a single creative is the extreme case: it depends on one ad.
//   diversity      the creatives with MEANINGFUL delivery (at least meaningful_share_pct of the spend and the minimum spend to judge) span fewer than min_distinct_concepts
//                  concepts. Judged only when enough of that spend is on creatives whose concept is recorded (concept_known_pct): an unclassified ad is "unknown", never "the same".
// Neither depends on a CPA benchmark, so they still work where a funnel has no approved benchmark. Nothing here says an ad is good or bad.
const num = (v) => Number(v) || 0;
const pct = (x) => Math.round(x * 1000) / 10;

function distribution(creatives, cfg) {
  const list = (creatives || []).filter((c) => num(c.spend) > 0);
  const totalSpend = list.reduce((s, c) => s + num(c.spend), 0);
  const totalPurch = list.reduce((s, c) => s + num(c.purchases), 0);
  const out = {
    total_spend: Math.round(totalSpend), total_purchases: Math.round(totalPurch), creatives_with_delivery: list.length,
    top: null, top_spend_share: null, top_purchase_share: null, meaningful: 0, distinct_concepts: 0, concept_known_share: null,
    concentrated: false, concentration_basis: null, low_diversity: false, diversity_known: false, notes: [],
  };
  if (!list.length || totalSpend <= 0) return out;
  const sorted = list.slice().sort((a, b) => num(b.spend) - num(a.spend));
  const top = sorted[0];
  out.top = { key: top.key, concept: top.concept || null, spend: Math.round(num(top.spend)), purchases: Math.round(num(top.purchases)), state: top.state, ads: top.ad_count || 1 };
  out.top_spend_share = pct(num(top.spend) / totalSpend);
  out.top_purchase_share = totalPurch > 0 ? pct(num(top.purchases) / totalPurch) : null;

  const minShare = cfg.meaningful_share_pct / 100;
  const meaningful = list.filter((c) => num(c.spend) >= Math.max(cfg.min_spend, minShare * totalSpend));
  out.meaningful = meaningful.length;
  const mSpend = meaningful.reduce((s, c) => s + num(c.spend), 0);
  const known = meaningful.filter((c) => c.concept);
  out.concept_known_share = mSpend > 0 ? pct(known.reduce((s, c) => s + num(c.spend), 0) / mSpend) : null;
  out.distinct_concepts = new Set(known.map((c) => String(c.concept).toUpperCase())).size;

  // concentration
  const shareLimit = cfg.concentration_share_pct;
  if (totalSpend >= cfg.concentration_min_spend) {
    const spendHeavy = out.top_spend_share >= shareLimit;
    const purchaseOk = totalPurch < 5 || (out.top_purchase_share !== null && out.top_purchase_share >= shareLimit - 10);
    if (spendHeavy && purchaseOk) {
      out.concentrated = true;
      out.concentration_basis = list.length === 1 ? 'single_creative' : 'share';
      out.notes.push(list.length === 1
        ? `The product has only one creative with delivery (${Math.round(totalSpend)} spent): it depends on a single ad.`
        : `One creative carries ${out.top_spend_share}% of the spend${out.top_purchase_share !== null ? ` and ${out.top_purchase_share}% of the purchases` : ''} (the limit is ${shareLimit}% of spend, once at least ${cfg.concentration_min_spend} has been spent).`);
    } else if (spendHeavy) {
      out.notes.push(`One creative carries ${out.top_spend_share}% of the spend but purchases are spread more evenly (${out.top_purchase_share}%), so it is not called concentrated.`);
    }
  } else {
    out.notes.push(`Only ${Math.round(totalSpend)} spent in the window (less than ${cfg.concentration_min_spend}): delivery shares are too small to judge concentration.`);
  }

  // diversity
  out.diversity_known = meaningful.length >= 2 && out.concept_known_share !== null && out.concept_known_share >= cfg.concept_known_pct;
  if (meaningful.length >= 2) {
    if (!out.diversity_known) out.notes.push(`Concept diversity cannot be judged: only ${out.concept_known_share === null ? 0 : out.concept_known_share}% of the meaningful spend is on creatives with a concept recorded (${cfg.concept_known_pct}% needed).`);
    else if (out.distinct_concepts < cfg.min_distinct_concepts) {
      out.low_diversity = true;
      out.notes.push(`${meaningful.length} creatives receive meaningful delivery but they share ${out.distinct_concepts} concept${out.distinct_concepts === 1 ? '' : 's'} (${cfg.min_distinct_concepts} distinct concepts wanted).`);
    } else out.notes.push(`${out.distinct_concepts} distinct concepts across ${meaningful.length} creatives with meaningful delivery.`);
  }
  return out;
}

module.exports = { distribution };
