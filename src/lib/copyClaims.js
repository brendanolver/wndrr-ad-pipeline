// Product / campaign claims in advertising copy: detection, the facts guard for generated copy, and masking of reference examples.
//
// Why: historical WNDRR ads are about OTHER products ("Available in 8 colourways", "Heavy weight cotton fleece", "3 fits for summer", "our best-selling trackpant").
// They are used for tone, structure and formatting only. A generated line may state a claim about THIS product only when the application holds that fact (the "verified facts").
// The same rule list is used twice:
//   findUnsupportedClaims(text, facts)  rejects generated copy that states a claim the verified facts do not contain
//   maskClaims(text)                    removes such details from a reference example BEFORE the model sees it, leaving a placeholder such as [COUNT]
//
// `facts.text` is everything the writer may state (verified facts + what the person typed in the request); creative direction (concept, hook, angle) is NOT part of it.
// `facts.newnessAllowed` is true only when the ad's copy type is a New Range or New Colourways (launch wording is supported by evidence or by a person's choice).
const { normalizeUnicode } = require('./copyText');

const NUM = '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday|tonight|tomorrow|midnight|weekend';
const COLOURS = 'black|white|grey|gray|charcoal|navy|blue|green|red|brown|cream|ecru|stone|sand|olive|khaki|pink|purple|yellow|orange|camo|burgundy|maroon|oyster|ink|cement|moss|dune|bone|slate|taupe|tan|lilac|forest|cherry';

// code, label, regex, placeholder (null = style wording, never masked), numeric (whitespace-insensitive support check), onlyWhen(facts)
const RULES = [
  { code: 'discount', re: /\b\d{1,3}(?:\.\d+)?\s?(?:%|percent)/gi, numeric: true, label: 'a percentage', mask: '[DISCOUNT]' },
  { code: 'price', re: /(?:[$€£]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:aud|usd|dollars?|bucks)\b)/gi, numeric: true, label: 'a price', mask: '[PRICE]' },
  { code: 'gsm', re: /\b\d{2,4}\s?gsm\b/gi, numeric: true, label: 'a fabric weight (GSM)', mask: '[MATERIAL]' },
  { code: 'fabric', re: /\b(?:cotton|polyester|nylon|linen|wool|fleece|terry|denim|viscose|elastane|spandex|rayon|merino|jersey|canvas|suede|leather|organic cotton|heavy[- ]?weight|light[- ]?weight|mid[- ]?weight|brushed|combed|breathable|moisture[- ]wicking|water[- ]resistant|waterproof)\b/gi, label: 'a fabric or performance claim', mask: '[MATERIAL]' },
  { code: 'quality', re: /\b(?:soft(?:er|est)?|super[- ]soft|premium|high[- ]quality|top[- ]quality|quality|durable|luxur(?:y|ious)|luxe|thick|sturdy|comfortable|comfy|stretch(?:y)?|cosy|cozy)\b/gi, label: 'a quality or feel claim', mask: '[MATERIAL]' },
  {
    code: 'feature', label: 'a design or construction feature', mask: '[FEATURE]',
    re: /\b(?:(?:boxy|oversized|relaxed|slim|tapered|baggy|loose|cropped|longline|fitted|athletic|straight|wide|dropped?)[- ](?:fit|cut|leg|silhouette|shoulders?|hem|length)|boxy|oversized|ribbed|elasticised|elasticized|drawstring|zip(?:per|ped)?|pockets?|hooded|embroider(?:ed|y)|logo patch|waistband|cuffs?|collar|neckline|sleeves?|raglan|stitch(?:ed|ing)|lined|velcro|push studs?)\b/gi,
  },
  {
    // a number (or "different / various / every / all") attached to something a product comes in: "three completely different fits", "8 colourways", "3 ways to wear it"
    code: 'count', label: 'a count of fits, colours, sizes or ways to wear it', mask: '[COUNT]',
    re: new RegExp(`\\b(?:${NUM}|a couple of|several|multiple|many|both|countless)\\s+(?:(?:completely|totally|entirely|genuinely|truly|really|very|brand|new|different|distinct|separate|unique|great|colou?rful)\\s+){0,2}(?:fits?|colou?rways?|colou?rs?|ways?|sizes?|styles?|looks?|cuts?|lengths?|silhouettes?|options?|variations?|versions?|shades?|pockets?|designs?|graphics?|prints?|layers?|outfits?)\\b`, 'gi'),
  },
  { code: 'variants', label: 'different fits, colours or sizes', mask: '[COUNT]', re: /\b(?:different|various|multiple|every|all|several)\s+(?:\w+\s+)?(?:fits?|cuts?|colou?rways?|colou?rs?|sizes?|silhouettes?|lengths?|styles?)\b/gi },
  {
    code: 'popularity', label: 'a popularity or reputation claim', mask: '[CLAIM]',
    re: /\b(?:best[- ]?sell(?:er|ers|ing)|top[- ]sell(?:er|ers|ing)|fan[- ]fav(?:ou?rites?)?|customer[- ]fav(?:ou?rites?)?|crowd[- ]pleaser|most popular|so popular|sold out|sells? out|iconic|cult(?: classic| fav(?:ou?rite)?)?|award[- ]winning|viral|trending|number one|#1|everyone(?:'s| is)? (?:wearing|obsessed|talking)|loved by|tried and tested)\b/gi,
  },
  { code: 'superlative', label: 'a "best" or superlative claim', mask: '[CLAIM]', re: /\b(?:best|greatest|ultimate|finest|unbeatable|unmatched)\b/gi },
  {
    code: 'newness', label: 'launch or "new" wording', mask: null, onlyWhen: (facts) => !facts.newnessAllowed,
    re: /\b(?:brand[- ]new|just (?:dropped|landed|launched|arrived|hit)|newly (?:launched|released|dropped|arrived)|new (?:arrivals?|releases?|drops?|colou?rs?|colou?rways?|season|range)|introducing|fresh (?:drop|off)|latest (?:drop|release)|new in|hot off)\b/gi,
  },
  { code: 'availability', label: 'an availability claim', mask: '[AVAILABILITY]', re: /\b(?:now )?available(?: now| online| today)?\b|\blimited (?:run|edition|release|time|quantities)\b|\bexclusive(?:ly)?\b|\bone[- ]off\b/gi },
  { code: 'colour', label: 'a colour the product comes in', mask: '[COLOUR]', re: new RegExp(`\\b(?:comes in|available in|now in|new in|in)\\s+(?:washed\\s+|faded\\s+|dark\\s+|light\\s+|pale\\s+)?(?:${COLOURS})\\b`, 'gi') },
  { code: 'stock', re: /\b(?:selling fast|almost gone|nearly sold out|sold out|low stock|limited stock|few (?:left|remaining)|last few|while (?:stocks?|supplies) last|back in stock|only \d+ left|limited quantities|in stock)\b/gi, label: 'a stock-availability claim', mask: '[STOCK]' },
  { code: 'shipping', re: /\b(?:free (?:shipping|delivery|returns?)|express (?:shipping|delivery)|next[- ]day (?:delivery|shipping)|worldwide shipping|fast shipping|ships? (?:today|free|worldwide))\b/gi, label: 'a shipping claim', mask: '[SHIPPING]' },
  {
    code: 'deadline', label: 'a deadline or date', mask: '[DATE]',
    re: new RegExp(`\\b(?:ends? (?:in|on|at)?\\s?(?:${DAYS})|until (?:${DAYS})|\\d+\\s?(?:hours?|days?|mins?|minutes?) left|today only|tonight only|this weekend(?: only)?|all weekend|ends? soon|ends? tonight|this week only|(?:\\d{1,2}(?:st|nd|rd|th)?\\s(?:${MONTHS}))\\b|(?:${MONTHS})\\s\\d{1,2}(?:st|nd|rd|th)?)`, 'gi'),
  },
  { code: 'offer_terms', re: /\b(?:discount|clearance|bogo|buy \d+|free gift|gift with purchase|gwp|bundle (?:and|&) save|save \$?\d+|deal)\b/gi, label: 'promotional terms', mask: '[OFFER]' },
  { code: 'sale_word', re: /\b(?:sale|on sale|\d+% off|% off|markdown)\b/gi, label: 'sale wording', mask: null, onlyWhen: (facts) => !facts.isPromotion },
];

// Comparison form used for "is this claim in the facts?": lower case, decorative lettering resolved, "boxy" and "box" treated as the same word.
const compare = (s) => normalizeUnicode(s).toLowerCase().replace(/\s+/g, ' ').replace(/\bboxy\b/g, 'box');

// facts: { text, isPromotion, newnessAllowed } → [{ code, match, label }] for each claim that is not supported by the facts.
function findUnsupportedClaims(text, facts) {
  const allowed = compare(facts.text);
  const allowedTight = allowed.replace(/\s+/g, '');
  const source = normalizeUnicode(text);
  const out = [];
  for (const rule of RULES) {
    if (rule.onlyWhen && !rule.onlyWhen(facts)) continue;
    const matches = source.match(rule.re) || [];
    for (const m of matches) {
      const needle = compare(m);
      const supported = rule.numeric ? allowedTight.includes(needle.replace(/\s+/g, '')) : allowed.includes(needle);
      if (!supported) out.push({ code: rule.code, match: m.trim(), label: rule.label });
    }
  }
  const seen = new Set();
  return out.filter((c) => { const k = `${c.code}:${c.match.toLowerCase()}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

const BULLET_LINE = /^(\s*)([-•*+→✔✅✓☑]️?)\s+(.*)$/u;
// Placeholders are written with private-use sentinels while masking, so a later rule can never match inside an earlier placeholder ("[DISCOUNT]" contains the word discount).
// (digits, not the name itself, so the placeholder holds no word a rule could match)
const PH_NAMES = ['DETAIL', 'PRODUCT', 'DISCOUNT', 'PRICE', 'MATERIAL', 'FEATURE', 'COUNT', 'CLAIM', 'AVAILABILITY', 'COLOUR', 'STOCK', 'SHIPPING', 'DATE', 'OFFER'];
const ph = (name) => `\uE000${PH_NAMES.indexOf(name)}\uE001`;

// Reference example -> the same text with product details replaced by placeholders (tone, structure and layout stay). Decorative lettering becomes plain text.
// `names`: product / range names to hide (the reference is about another product, so its name is not information for this one).
function maskClaims(text, names = []) {
  let t = normalizeUnicode(text);
  // bullet lines are product detail lists: keep the layout, drop the content
  t = t.split('\n').map((line) => { const m = line.match(BULLET_LINE); return m ? `${m[1]}${m[2]} ${ph('DETAIL')}` : line; }).join('\n');
  for (const name of names) {
    const words = normalizeUnicode(name).replace(/[^\w\s'-]/g, ' ').split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 8) continue;
    // every word may carry a plural s ("Cargo Short" and "Cargo Shorts" are the same product)
    const body = words.map((w) => `${w.replace(/s$/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?`).join('\\s+');
    t = t.replace(new RegExp(`(?:\\bthe\\s+)?\\b${body}\\b`, 'gi'), ph('PRODUCT'));
  }
  for (const rule of RULES) {
    if (!rule.mask) continue;
    t = t.replace(rule.re, ph(rule.mask.slice(1, -1)));
  }
  // colour names (a list of colours is a product detail wherever it appears)
  t = t.replace(new RegExp(`\\b(?:(?:washed|faded|dark|light|pale)\\s+)?(?:${COLOURS})\\b`, 'gi'), ph('COLOUR'));
  t = t.replace(/\uE000(\d+)\uE001/g, (_, i) => `[${PH_NAMES[Number(i)]}]`);
  return t.replace(/(\[[A-Z]+\])(?:\s*[,/&]?\s*(?:and\s+)?\1)+/g, '$1');
}

module.exports = { RULES, findUnsupportedClaims, maskClaims, compare };
