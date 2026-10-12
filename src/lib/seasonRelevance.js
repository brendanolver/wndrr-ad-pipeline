// Seasonal RELEVANCE for creative planning: is this product worth making creative for in the selling period we are in (Australian calendar)?
//
// Two pieces of evidence are combined and BOTH are reported:
//   1. a CATEGORY PRIOR: WNDRR's own stated rule for the approach to Australian summer (Batch 14 brief): tees, shorts, swimwear and lightweight shirts are
//      relevant; winter trackpants and heavy fleece are not; jeans and long pants are NOT blanket-banned (neutral). The words that decide the class are in
//      CLASSES below. This is a business assumption supplied by WNDRR, not a measured fact, so it is labelled as such everywhere it is shown and it is easy to
//      change in one place. A product that matches no word is "neutral": it is never penalised for not being recognised.
//   2. the DATA-DRIVEN read from lib/seasonality.js (the product's / category's own sales by month; ONE observed year, so it is real evidence, not proof).
// COMBINING (strongest signal wins, and the reason is always stated):
//   * data says out_of_season  -> out (a measured pattern)
//   * data says in_season / coming_into_season -> in
//   * otherwise the category prior decides (in / shoulder / out / neutral)
//   * a neutral prior with no data stays neutral
// EXCEPTION: an out-of-season product is NOT excluded when its CURRENT sales are strong (the caller passes `strongSellingNow`): the evidence of demand outranks
// the calendar. The exception is reported ("selling strongly now despite being out of season") so the team can see why it is on the list.
// Pure: no database, no clock (month is passed in).

// word -> class. Matching is on whole words (or the leading letters of a word: TRACKPANT matches TRACKPANTS) of the category + product name, upper-cased.
const CLASSES = {
  summer: ['TEE', 'TEES', 'T-SHIRT', 'T SHIRT', 'TSHIRT', 'SHORT', 'SHORTS', 'BOARDSHORT', 'BOARDSHORTS', 'SWIM', 'SWIMWEAR', 'TRUNK', 'TRUNKS', 'SINGLET', 'SINGLETS', 'TANK', 'TANKS', 'POLO', 'POLOS', 'LINEN', 'CUBAN', 'SHORT SLEEVE', 'LIGHTWEIGHT', 'RASHIE', 'THONG', 'SANDAL', 'SANDALS', 'SLIDE', 'SLIDES', 'CAP', 'CAPS', 'BUCKET HAT'],
  winter: ['FLEECE', 'HOOD', 'HOODIE', 'HOODIES', 'HOOD SWEAT', 'SWEAT', 'SWEATS', 'SWEATER', 'SWEATERS', 'CREW SWEAT', 'JUMPER', 'JUMPERS', 'KNIT', 'KNITS', 'KNITWEAR', 'JACKET', 'JACKETS', 'PUFFER', 'COAT', 'COATS', 'BEANIE', 'BEANIES', 'TRACKPANT', 'TRACKPANTS', 'TRACK PANT', 'TRACK PANTS', 'TRACKSUIT', 'THERMAL', 'FLANNEL', 'QUARTER ZIP', 'ZIP THROUGH', 'SCARF', 'GLOVES'],
};
// a name that contains one of these is a SUMMER item even if a winter word also appears ("Heavy Weight Tee" has no winter word, but "Fleece Short" is a short)
const SUMMER_OVERRIDES = ['SHORT', 'SHORTS', 'TEE', 'TEES', 'SINGLET', 'TANK', 'SWIM', 'BOARDSHORT'];
// neutral long-bottoms: named only so the report can say "no blanket ban" (they match no class, so they are neutral anyway)
const NEUTRAL_WORDS = ['JEAN', 'JEANS', 'PANT', 'PANTS', 'CARGO', 'CARGOS', 'DENIM', 'TROUSER', 'TROUSERS', 'CHINO', 'CHINOS'];

// calendar month (1-12) -> relevance for each class (Australian seasons: summer Dec-Feb, autumn Mar-May, winter Jun-Aug, spring Sep-Nov)
const MONTHS = {
  summer: { in: [10, 11, 12, 1, 2, 3], shoulder: [4, 9], out: [5, 6, 7, 8] },
  winter: { in: [5, 6, 7, 8], shoulder: [4, 9], out: [10, 11, 12, 1, 2, 3] },
};
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const norm = (s) => ` ${String(s || '').toUpperCase().replace(/[^A-Z0-9 -]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
const hasWord = (text, word) => text.includes(` ${word} `) || text.includes(` ${word}S `) || (word.length >= 5 && text.includes(` ${word}`));

// pure: the category prior for a product. → { class: 'summer'|'winter'|'neutral', matched: 'TEE'|null }
function classify({ category = null, name = null } = {}) {
  const text = norm(`${category || ''} ${name || ''}`);
  if (SUMMER_OVERRIDES.some((w) => hasWord(text, w))) {
    const m = SUMMER_OVERRIDES.find((w) => hasWord(text, w));
    return { class: 'summer', matched: m };
  }
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

// input: { category, name, month (1-12), data: seasonality status string | null, strongSellingNow: boolean }
// → { state: 'in_season'|'out_of_season'|'shoulder'|'neutral', relevant: bool, exception: bool, source, class, matched, reasons[], label }
function assess({ category = null, name = null, month, data = null, strongSellingNow = false } = {}) {
  const cls = classify({ category, name });
  const prior = priorFor(cls.class, month);
  const monthName = MONTH_NAMES[(month || 1) - 1];
  const reasons = [];
  let state; let source;
  const dataKnown = data && !['insufficient_data', 'unavailable', 'year_round'].includes(data);
  if (data === 'out_of_season') { state = 'out_of_season'; source = 'sales_pattern'; reasons.push('Its own sales pattern shows it is out of season now (sales are well below its usual level for this time of year).'); }
  else if (data === 'in_season' || data === 'coming_into_season') { state = 'in_season'; source = 'sales_pattern'; reasons.push(data === 'in_season' ? 'Its own sales pattern shows it is in season now.' : 'Its own sales pattern shows it is coming into season.'); }
  else if (cls.class !== 'neutral') {
    source = 'category_prior';
    state = prior === 'in' ? 'in_season' : prior === 'out' ? 'out_of_season' : 'shoulder';
    reasons.push(`${cls.class === 'summer' ? 'Summer' : 'Winter'} item (${cls.matched.toLowerCase()}): ${prior === 'in' ? 'in season' : prior === 'out' ? 'out of season' : 'shoulder season'} in ${monthName} for Australia (WNDRR's seasonal rule, not measured sales).`);
  } else {
    source = dataKnown || data === 'year_round' ? 'sales_pattern' : 'none'; state = 'neutral';
    reasons.push(data === 'year_round' ? 'Its own sales pattern is year-round.' : `Not a clearly summer or winter item${cls.matched ? ` (${cls.matched.toLowerCase()}: no seasonal rule applies)` : ''}, so season does not exclude it.`);
  }
  // a measured pattern and the category rule can disagree: say so rather than hide it
  if (source === 'sales_pattern' && cls.class !== 'neutral' && ((state === 'out_of_season' && prior === 'in') || (state === 'in_season' && prior === 'out'))) {
    reasons.push(`The category rule would say the opposite (${cls.class} item in ${monthName}); the measured sales pattern is used.`);
  }
  let exception = false;
  let relevant = state !== 'out_of_season';
  if (state === 'out_of_season' && strongSellingNow) {
    exception = true; relevant = true;
    reasons.push('Exception: it is selling strongly right now despite being out of season, so current sales outrank the calendar.');
  }
  return { state, relevant, exception, source, class: cls.class, matched: cls.matched, prior, reasons, label: state === 'in_season' ? 'In season' : state === 'out_of_season' ? (exception ? 'Out of season (selling strongly)' : 'Out of season') : state === 'shoulder' ? 'Shoulder season' : 'Not seasonal' };
}

module.exports = { CLASSES, MONTHS, classify, priorFor, assess };
