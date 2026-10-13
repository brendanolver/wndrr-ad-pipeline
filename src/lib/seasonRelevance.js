// Seasonal RELEVANCE for creative planning: is this product worth making creative for in the selling period we are in (Australian calendar)?
//
// Two pieces of evidence are combined and BOTH are reported:
//   1. a CATEGORY PRIOR: WNDRR's own stated rule for the Australian year (Batch 14 brief, refined in Batch 27). Four classes:
//        summer        tees, shorts, swim, singlets, short-sleeve (S/S) shirts, polos, linen ...     in Oct-Mar, shoulder Apr / Sep, out May-Aug
//        winter        heavy fleece: hoods, sweats, crew sweats, trackpants, jackets, knits, beanies   in May-Aug, shoulder Apr / Sep, out Oct-Mar
//        transitional  1/4 (quarter) zips and long sleeves: layering pieces, in season Mar-Sep, shoulder the rest of the year (NEVER out of season)
//        neutral       jeans, pants, cargos, carpenters, denim, trousers and anything unrecognised: season does not exclude or boost them
//      Names are normalised first ("1/4" = QUARTER, "S/S" = SHORT SLEEVE, "L/S" = LONG SLEEVE) so common WNDRR naming is recognised.
//      This is a business assumption supplied by WNDRR, not a measured fact, so it is labelled as such everywhere it is shown and it is easy to change in one place.
//   2. the DATA-DRIVEN read from lib/seasonality.js (the product's / category's own sales by month; ONE observed year, so it is real evidence, not proof).
// COMBINING (the reason is always stated):
//   * data says out_of_season                                  -> out (a measured pattern)
//   * data says in_season                                      -> in, BUT a measured "in season" only overrules a category rule that says OUT when its index is at least
//                                                                 `patternIndex` (default 125% of the product's usual month): one year of data at 112% is not enough to overrule the calendar
//   * data says coming_into_season                             -> in, UNLESS the "coming" months are only the promotional ones (Black Friday / Christmas: Nov-Dec). A promotion
//                                                                 spike is not a season: it is ignored with the reason stated and the category rule decides
//   * otherwise the category prior decides (in / shoulder / out / neutral)
// EXCEPTION: an out-of-season product is not excluded when CURRENT demand justifies it. The caller decides that with absolute evidence (units sold plus creative
// evidence: see planningOpportunities.js) and passes `exceptionGranted`; the exception is reported so the team can see why it is on the list.
// Pure: no database, no clock (month is passed in).

const norm0 = (s) => String(s || '').toUpperCase();
// "1/4 Zip" -> "QUARTER ZIP"; "S/S" -> "SHORT SLEEVE"; "L/S" -> "LONG SLEEVE"; "1/2 zip" -> "HALF ZIP"; any other "/" or punctuation -> space
function normalise(s) {
  return ` ${norm0(s)
    .replace(/\b1\s*\/\s*4\b|\b1\s*-\s*4\b|\bQTR\b|\bQ\s*\/\s*ZIP\b/g, ' QUARTER ')
    .replace(/\b1\s*\/\s*2\b/g, ' HALF ')
    .replace(/\bS\s*\/\s*S\b|\bSS\b/g, ' SHORT SLEEVE ')
    .replace(/\bL\s*\/\s*S\b|\bLS\b/g, ' LONG SLEEVE ')
    .replace(/[^A-Z0-9 -]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

const CLASSES = {
  summer: ['TEE', 'TEES', 'T-SHIRT', 'T SHIRT', 'TSHIRT', 'SHORT', 'SHORTS', 'BOARDSHORT', 'BOARDSHORTS', 'SWIM', 'SWIMWEAR', 'TRUNK', 'TRUNKS', 'SINGLET', 'SINGLETS', 'TANK', 'TANKS', 'POLO', 'POLOS', 'LINEN', 'CUBAN', 'SHORT SLEEVE', 'LIGHTWEIGHT', 'RASHIE', 'THONG', 'SANDAL', 'SANDALS', 'SLIDE', 'SLIDES', 'CAP', 'CAPS', 'BUCKET HAT', 'BEACH'],
  winter: ['FLEECE', 'HOOD', 'HOODIE', 'HOODIES', 'HOOD SWEAT', 'SWEAT', 'SWEATS', 'SWEATER', 'SWEATERS', 'CREW SWEAT', 'JUMPER', 'JUMPERS', 'KNIT', 'KNITS', 'KNITWEAR', 'JACKET', 'JACKETS', 'PUFFER', 'COAT', 'COATS', 'BEANIE', 'BEANIES', 'TRACKPANT', 'TRACKPANTS', 'TRACK PANT', 'TRACK PANTS', 'TRACKSUIT', 'THERMAL', 'FLANNEL', 'ZIP THROUGH', 'SCARF', 'GLOVES'],
  transitional: ['QUARTER ZIP', 'HALF ZIP', 'LONG SLEEVE'],
};
// a name that contains one of these is a SUMMER item even if a winter word also appears ("Fleece Short" is a short; "Short Sleeve Shirt" is a summer shirt)
const SUMMER_OVERRIDES = ['SHORT', 'SHORTS', 'TEE', 'TEES', 'SINGLET', 'TANK', 'SWIM', 'BOARDSHORT', 'SHORT SLEEVE'];
// long bottoms and other all-year items: named so the report can say "no blanket ban" (they match no class, so they are neutral anyway)
const NEUTRAL_WORDS = ['JEAN', 'JEANS', 'PANT', 'PANTS', 'CARGO', 'CARGOS', 'DENIM', 'TROUSER', 'TROUSERS', 'CHINO', 'CHINOS', 'CARPENTER', 'CARPENTERS', 'SHIRT', 'SHIRTS'];

// calendar month (1-12) -> relevance for each class (Australian seasons: summer Dec-Feb, autumn Mar-May, winter Jun-Aug, spring Sep-Nov)
const MONTHS = {
  summer: { in: [10, 11, 12, 1, 2, 3], shoulder: [4, 9], out: [5, 6, 7, 8] },
  winter: { in: [5, 6, 7, 8], shoulder: [4, 9], out: [10, 11, 12, 1, 2, 3] },
  transitional: { in: [3, 4, 5, 6, 7, 8, 9], shoulder: [10, 11, 12, 1, 2], out: [] },
};
const PROMO_MONTHS = [11, 12]; // Black Friday and Christmas: store-wide promotional peaks, never read as a product's own season
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const hasWord = (text, word) => text.includes(` ${word} `) || text.includes(` ${word}S `) || (word.length >= 5 && text.includes(` ${word}`));

// pure: the category prior for a product. → { class: 'summer'|'winter'|'transitional'|'neutral', matched: 'TEE'|null }
function classify({ category = null, name = null } = {}) {
  const text = normalise(`${category || ''} ${name || ''}`);
  const sm = SUMMER_OVERRIDES.find((w) => hasWord(text, w));
  if (sm) return { class: 'summer', matched: sm };
  const tr = CLASSES.transitional.find((w) => hasWord(text, w));
  if (tr) return { class: 'transitional', matched: tr };
  const winter = CLASSES.winter.find((w) => hasWord(text, w));
  if (winter) return { class: 'winter', matched: winter };
  const summer = CLASSES.summer.find((w) => hasWord(text, w));
  if (summer) return { class: 'summer', matched: summer };
  const neutral = NEUTRAL_WORDS.find((w) => hasWord(text, w));
  return { class: 'neutral', matched: neutral || null };
}

// pure: what the category prior says for a calendar month → 'in' | 'shoulder' | 'out' | 'neutral'
function priorFor(cls, month) {
  if (!MONTHS[cls]) return 'neutral';
  const t = MONTHS[cls];
  return t.in.includes(month) ? 'in' : t.shoulder.includes(month) ? 'shoulder' : t.out.includes(month) ? 'out' : 'neutral';
}

// the months a sales pattern is "coming into season" for, from seasonality.js evidence ('YYYY-MM' list) -> month numbers
const monthsOf = (list) => (list || []).map((m) => Number(String(m).slice(5, 7))).filter((n) => n >= 1 && n <= 12);
const peakMonthNums = (peaks) => (peaks || []).map((p) => (typeof p === 'object' && p ? MON3.indexOf(String(p.month).slice(0, 3)) + 1 : 0)).filter((n) => n > 0);

// input: { category, name, month (1-12), data: seasonality status string | null, dataEvidence: { current_index, horizon_months, peaks, confidence } | null,
//          patternIndex (percent, default 125), strongSellingNow (legacy: grants the exception), exceptionGranted }
// → { state: 'in_season'|'out_of_season'|'shoulder'|'neutral', relevant, exception, source, class, matched, prior, weight, reasons[], label, pattern_note }
function assess({ category = null, name = null, month, data = null, dataEvidence = null, patternIndex = 125, strongSellingNow = false, exceptionGranted = false } = {}) {
  const cls = classify({ category, name });
  const prior = priorFor(cls.class, month);
  const monthName = MONTH_NAMES[(month || 1) - 1];
  const reasons = [];
  let patternNote = null;
  let state; let source;
  const classWord = cls.class === 'summer' ? 'Summer' : cls.class === 'winter' ? 'Winter' : cls.class === 'transitional' ? 'Layering (1/4 zip / long sleeve)' : null;
  const dataKnown = data && !['insufficient_data', 'unavailable', 'year_round'].includes(data);

  // a sales pattern can be set aside, with the reason (never silently)
  let usable = data;
  if (data === 'coming_into_season') {
    const hm = monthsOf(dataEvidence && dataEvidence.horizon_months);
    if (hm.length && hm.every((m) => PROMO_MONTHS.includes(m))) {
      usable = null; patternNote = `Its sales pattern shows a lift in ${hm.map((m) => MONTH_NAMES[m - 1]).join(' and ')}, which are Black Friday / Christmas promotion months. A promotional peak is not a season, so it is ignored and the Australian category rule decides.`;
    }
  }
  if (data === 'in_season' && cls.class !== 'neutral' && prior === 'out') {
    const idx = dataEvidence && Number.isFinite(Number(dataEvidence.current_index)) ? Number(dataEvidence.current_index) * 100 : null;
    if (idx === null || idx < patternIndex) {
      usable = null; patternNote = `Its sales pattern reads "in season" (${idx === null ? 'index unknown' : `${Math.round(idx)}% of its usual month`}), but with one year of data that is below the ${patternIndex}% needed to overrule the Australian rule for ${classWord ? classWord.toLowerCase() : 'this'} items in ${monthName}.`;
    }
  }
  if (data === 'in_season' && cls.class !== 'neutral' && prior === 'out' && usable === 'in_season') {
    const pk = peakMonthNums(dataEvidence && dataEvidence.peaks);
    if (pk.length && pk.every((m) => PROMO_MONTHS.includes(m)) && !PROMO_MONTHS.includes(month)) {
      usable = null; patternNote = 'Its only sales peaks are Black Friday / Christmas months, so its pattern is a promotion effect, not a season: the category rule decides.';
    }
  }

  if (usable === 'out_of_season') { state = 'out_of_season'; source = 'sales_pattern'; reasons.push('Its own sales pattern shows it is out of season now (sales are well below its usual level for this time of year).'); }
  else if (usable === 'in_season' || usable === 'coming_into_season') { state = 'in_season'; source = 'sales_pattern'; reasons.push(usable === 'in_season' ? 'Its own sales pattern shows it is in season now.' : 'Its own sales pattern shows it is coming into season.'); }
  else if (cls.class !== 'neutral') {
    source = 'category_prior';
    state = prior === 'in' ? 'in_season' : prior === 'out' ? 'out_of_season' : 'shoulder';
    reasons.push(`${classWord} item (${String(cls.matched).toLowerCase()}): ${prior === 'in' ? 'in season' : prior === 'out' ? 'out of season' : 'shoulder season'} in ${monthName} for Australia (WNDRR's seasonal rule, not measured sales).`);
  } else {
    source = dataKnown || data === 'year_round' ? 'sales_pattern' : 'none'; state = 'neutral';
    reasons.push(data === 'year_round' ? 'Its own sales pattern is year-round.' : `Not a clearly summer or winter item${cls.matched ? ` (${String(cls.matched).toLowerCase()}: no seasonal rule applies)` : ''}, so season neither excludes nor boosts it.`);
  }
  if (patternNote) reasons.push(patternNote);
  // a measured pattern and the category rule can disagree: say so rather than hide it
  if (source === 'sales_pattern' && cls.class !== 'neutral' && ((state === 'out_of_season' && prior === 'in') || (state === 'in_season' && prior === 'out'))) {
    reasons.push(`The category rule would say the opposite (${cls.class} item in ${monthName}); the measured sales pattern is used.`);
  }
  let exception = false;
  let relevant = state !== 'out_of_season';
  if (state === 'out_of_season' && (strongSellingNow || exceptionGranted)) {
    exception = true; relevant = true;
    reasons.push('Exception: current demand outranks the calendar (see the demand and creative evidence).');
  }
  // weight: how much season supports a shoot this week (used for points and shown in the details)
  const weight = state === 'in_season' ? 1 : state === 'shoulder' ? 0.5 : state === 'neutral' ? 0.4 : exception ? 0.2 : 0;
  return {
    state, relevant, exception, source, class: cls.class, matched: cls.matched, prior, weight, reasons, pattern_note: patternNote,
    label: state === 'in_season' ? 'In season' : state === 'out_of_season' ? (exception ? 'Out of season (exception)' : 'Out of season') : state === 'shoulder' ? 'Shoulder season' : 'Not seasonal',
  };
}

module.exports = { CLASSES, MONTHS, PROMO_MONTHS, normalise, classify, priorFor, assess };
