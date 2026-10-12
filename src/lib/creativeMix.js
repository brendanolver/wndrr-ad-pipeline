// WHAT to make: a suggested mix of approaches for the videos recommended for a product, from WNDRR's own classification vocabulary (the approved concept list)
// and from how its existing creative has actually done. Every slot says whether it is
//   evidence      the concept has a track record (judged creatives within the approved benchmark), cited with its counts, or a new hook on a concept already
//                 performing for this product
//   gap           the product has no running creative using it, and nothing says it fails (a genuine gap, not a result)
//   exploratory   no performance evidence either way: a test
// No performance is ever invented for a concept: with no judged creatives it is "exploratory", full stop. The mix is only a suggestion; the person editing the
// plan can change it. Pure: the vocabulary and the evidence are passed in.
const key = (s) => String(s || '').trim().toLowerCase();

// conceptEvidence: Map(conceptKey -> { concept, judged, performing, weak, spend, creatives })   (pooled over WNDRR's judged creatives)
function conceptStanding(ev, min = 3) {
  if (!ev || ev.judged < min) return 'unknown';
  const share = ev.performing / ev.judged; const weakShare = ev.weak / ev.judged;
  if (ev.performing >= 2 && share >= 0.5 && weakShare <= 0.25) return 'strong';
  if (weakShare >= 0.5) return 'weak';
  return 'mixed';
}

function suggestMix({ videos, creatives = [], vocab = { concepts: [], creators: [] }, conceptEvidence = new Map(), minEvidence = 3 } = {}) {
  const n = Math.max(0, Math.floor(videos || 0));
  if (!n) return { slots: [], summary: { evidence: 0, gap: 0, exploratory: 0 }, note: null };
  const present = new Map(); // conceptKey -> creatives using it on this product
  creatives.forEach((c) => { const k = key(c.concept); if (!k) return; if (!present.has(k)) present.set(k, []); present.get(k).push(c); });
  const creators = new Set(creatives.map((c) => key(c.creator)).filter(Boolean));
  const unclassified = creatives.filter((c) => !key(c.concept)).length;
  const slots = [];
  const used = new Set();
  const add = (s) => { slots.push(s); if (s.concept) used.add(key(s.concept)); };

  // A. a new hook / variation on a concept that is performing for THIS product (the strongest evidence: it already works here)
  const ownPerforming = [...present.entries()].filter(([, cs]) => cs.some((c) => c.state === 'performing')).map(([k, cs]) => ({ k, concept: cs[0].concept, n: cs.filter((c) => c.state === 'performing').length }));
  ownPerforming.sort((a, b) => b.n - a.n);
  const hookCap = ownPerforming.length ? Math.min(ownPerforming.length * 1, Math.max(1, Math.ceil(n * 0.4))) : 0;
  for (let i = 0; i < hookCap && slots.length < n; i += 1) {
    const p = ownPerforming[i];
    add({ kind: 'new_hook', concept: p.concept, basis: 'evidence', reason: `${p.concept} is performing on this product (${p.n} creative${p.n === 1 ? '' : 's'} within the approved benchmark): test a new hook or variation on it.` });
  }
  // B. concepts with a store-wide track record that this product is not using
  const proven = vocab.concepts.map((c) => ({ c, ev: conceptEvidence.get(key(c)) })).filter((x) => conceptStanding(x.ev, minEvidence) === 'strong' && !used.has(key(x.c)) && !present.has(key(x.c)));
  proven.sort((a, b) => b.ev.performing - a.ev.performing || a.c.localeCompare(b.c));
  for (const x of proven) {
    if (slots.length >= n) break;
    add({ kind: 'new_concept', concept: x.c, basis: 'evidence', reason: `${x.c} has performed within the approved benchmark on ${x.ev.performing} of ${x.ev.judged} judged creatives across WNDRR, and this product is not running it.` });
  }
  // C. genuine gaps: approved concepts this product has not tried and that nothing says fail; ordered by how widely WNDRR already uses them (a neutral signal)
  const gaps = vocab.concepts.filter((c) => !used.has(key(c)) && !present.has(key(c)) && conceptStanding(conceptEvidence.get(key(c)), minEvidence) !== 'weak')
    .map((c) => ({ c, used: (conceptEvidence.get(key(c)) || {}).creatives || 0 })).sort((a, b) => b.used - a.used || a.c.localeCompare(b.c));
  for (const g of gaps) {
    if (slots.length >= n) break;
    add({ kind: 'new_concept', concept: g.c, basis: g.used ? 'gap' : 'exploratory', reason: g.used
      ? `No running creative for this product uses ${g.c} (WNDRR has ${g.used} creative${g.used === 1 ? '' : 's'} using it, without enough judged results either way): a genuine gap, so a test.`
      : `${g.c} has not been tried on this product and there are no results for it: exploratory.` });
  }
  while (slots.length < n) slots.push({ kind: 'new_concept', concept: null, basis: 'exploratory', reason: 'An open slot for a new concept: no further approved concept stands out as a gap, so this one is exploratory.' });
  // D. creator variety
  if (creatives.length >= 3 && creators.size <= 1 && slots.length) {
    const s = slots[slots.length - 1];
    s.creator_hint = 'a different creator'; s.reason += ' Every running creative uses the same creator, so try a different one.';
  }
  const summary = { evidence: slots.filter((s) => s.basis === 'evidence').length, gap: slots.filter((s) => s.basis === 'gap').length, exploratory: slots.filter((s) => s.basis === 'exploratory').length };
  const parts = [];
  if (summary.evidence) parts.push(`${summary.evidence} evidence-based`);
  if (summary.gap) parts.push(`${summary.gap} filling a gap`);
  if (summary.exploratory) parts.push(`${summary.exploratory} exploratory`);
  return { slots, summary, note: `${parts.join(', ')}.${unclassified ? ` ${unclassified} running creative${unclassified === 1 ? ' has' : 's have'} no concept recorded, so gaps may be overstated.` : ''}` };
}

// pool judged creatives (all products) into per-concept evidence. creatives: [{ concept, state }]
function poolConceptEvidence(creatives) {
  const m = new Map();
  creatives.forEach((c) => {
    const k = key(c.concept); if (!k) return;
    if (!m.has(k)) m.set(k, { concept: c.concept, creatives: 0, judged: 0, performing: 0, weak: 0, spend: 0 });
    const e = m.get(k); e.creatives += 1; e.spend += Number(c.spend) || 0;
    if (c.state === 'performing') { e.judged += 1; e.performing += 1; } else if (c.state === 'underperforming' || c.state === 'declining') { e.judged += 1; e.weak += 1; }
  });
  return m;
}

module.exports = { suggestMix, conceptStanding, poolConceptEvidence };
