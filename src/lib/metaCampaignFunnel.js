// Campaign / funnel context for Meta Performance.
//
// WNDRR's campaign names carry a funnel position (TOF / TOM / MOF) and numbered structures (028, 081, ...). Only the
// LITERAL funnel tokens are interpreted here, and only when unambiguous:
//   exactly one distinct recognised token in the name  -> that funnel ('TOF' | 'TOM' | 'MOF')
//   two or more different recognised tokens            -> 'multiple'  (e.g. "TOF + MOF test": we don't pick one)
//   none                                               -> 'unknown'   (never guessed from anything else)
// The numbered structures are NOT mapped to anything -- their literal digits are surfaced (numeric_tokens) so the real
// WNDRR meaning can be defined afterwards. Bump FUNNEL_RULE_VERSION when the recognised tokens change; stored funnels
// from an older version are recomputed from the stored names.
const FUNNEL_RULE_VERSION = 1;
const FUNNEL_TOKENS = ['TOF', 'TOM', 'MOF'];

function tokens(name) {
  return String(name || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
}

function classify(name) {
  const found = [...new Set(tokens(name).filter((t) => FUNNEL_TOKENS.includes(t)))];
  const funnel = found.length === 1 ? found[0] : found.length > 1 ? 'multiple' : 'unknown';
  // standalone numeric tokens, exactly as written (leading zeros kept): surfaced, never interpreted
  const numeric = tokens(name).filter((t) => /^[0-9]{2,4}$/.test(t));
  return { funnel, funnel_tokens: found, numeric_tokens: [...new Set(numeric)] };
}

const FUNNEL_LABEL = { TOF: 'TOF', TOM: 'TOM', MOF: 'MOF', multiple: 'Mixed', unknown: 'Unknown' };

// Census of the stored names, for defining the real mapping: how the names are built, not what they mean.
function census(rows) {
  const funnels = { TOF: 0, TOM: 0, MOF: 0, multiple: 0, unknown: 0 };
  const tokenFreq = new Map();
  const numericFreq = new Map();
  const samples = { TOF: [], TOM: [], MOF: [], multiple: [], unknown: [] };
  for (const r of rows) {
    const c = classify(r.name);
    funnels[c.funnel] += 1;
    if (samples[c.funnel].length < 8) samples[c.funnel].push(r.name);
    new Set(tokens(r.name)).forEach((t) => tokenFreq.set(t, (tokenFreq.get(t) || 0) + 1));
    c.numeric_tokens.forEach((t) => numericFreq.set(t, (numericFreq.get(t) || 0) + 1));
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([token, campaigns]) => ({ token, campaigns }));
  return { campaigns: rows.length, by_funnel: funnels, recognised_tokens: FUNNEL_TOKENS, common_tokens: top(tokenFreq, 40), numeric_tokens: top(numericFreq, 40), samples };
}

module.exports = { FUNNEL_RULE_VERSION, FUNNEL_TOKENS, FUNNEL_LABEL, classify, census, tokens };
