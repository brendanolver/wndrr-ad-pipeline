// Deterministic Meta ad copy rules for Ad Setup: Headline, Description and CTA. No AI, no randomness; the same inputs always give the same
// output. Primary Text is NOT handled here (that is the AI Copy Assistant). Nothing is ever invented: an offer comes only from a value a
// person typed into the Promotion's verified offer; when it is missing the field is left empty and a flag asks for confirmation.
//
//   Standard product / New Drop / Restock   headline  PRODUCT NAME (catalogue name, uppercase)   description  Elevate your everyday   CTA Shop Now
//   Sale hype / teaser                      headline  SIGN UP TO BE NOTIFIED                       description  <offer, teaser form>      CTA Sign Up
//   Sale live                               headline  <OFFER UPPERCASE>                            description  Limited time only!        CTA Shop Now
//   Mid sale                                exactly as Sale live
//   Last chance                             headline  LAST CHANCE <OFFER UPPERCASE>               description  Don't miss out!            CTA Shop Now

const RULE_KEYS = ['standard', 'hype', 'sale_live', 'mid_sale', 'last_chance'];
const STANDARD_DESCRIPTION = 'Elevate your everyday';
const LIVE_DESCRIPTION = 'Limited time only!';
const LAST_CHANCE_DESCRIPTION = "Don't miss out!";
const HYPE_HEADLINE = 'SIGN UP TO BE NOTIFIED';

const PLACEHOLDER_OFFERS = new Set(['tbc', 'tba', 'tbd', 'n/a', 'na', 'none', 'xx', 'xxx', 'todo', '-', '?', 'offer', 'sale']);

// → { ok, value, problem }. A verified offer must be a real phrase a person typed: short, printable, containing a letter or a number.
function validateOffer(raw) {
  if (raw === undefined || raw === null) return { ok: false, value: null, problem: 'missing' };
  const value = String(raw).replace(/\s+/g, ' ').trim();
  if (!value) return { ok: false, value: null, problem: 'missing' };
  if (value.length > 120) return { ok: false, value: null, problem: 'The offer is too long for a Meta headline (120 characters max).' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>]/.test(value)) return { ok: false, value: null, problem: 'The offer contains characters that are not allowed.' };
  if (!/[a-z0-9]/i.test(value)) return { ok: false, value: null, problem: 'The offer must contain words or numbers.' };
  if (PLACEHOLDER_OFFERS.has(value.toLowerCase())) return { ok: false, value: null, problem: 'The offer is still a placeholder.' };
  return { ok: true, value, problem: null };
}

// "20-50% off everything" -> "20-50% off everything sale" unless a teaser form was typed or it already ends with "sale".
function teaserForm(offer, override) {
  const o = validateOffer(override);
  if (o.ok) return o.value;
  return /\bsale$/i.test(offer) ? offer : `${offer} sale`;
}

function flag(code, message) { return { code, message }; }

// input: { adCategory, stageType, productNames: [catalogue names], offer, offerTeaser, promotionName }
// → { ruleKey, headline, description, cta, flags: [{code, message}] }
function deriveCopyRule(input) {
  const { adCategory, stageType } = input;
  const flags = [];
  const out = { ruleKey: null, headline: null, description: null, cta: null, flags };

  if (adCategory === 'promotion') {
    const key = { hype: 'hype', sale_live: 'sale_live', mid_sale: 'mid_sale', last_chance: 'last_chance' }[stageType];
    if (!key) {
      flags.push(flag('stage_unknown', 'The campaign stage is not recognised (Hype, Live, Mid Sale or Last Chance), so no copy rule was applied. Choose the copy yourself.'));
      return out;
    }
    out.ruleKey = key;
    const offer = validateOffer(input.offer);
    if (!offer.ok) {
      flags.push(flag(offer.problem === 'missing' ? 'offer_missing' : 'offer_invalid',
        offer.problem === 'missing'
          ? `No verified offer is recorded for ${input.promotionName ? `"${input.promotionName}"` : 'this promotion'}. Add it on the Promotion (Verified offer); it is never guessed.`
          : `The verified offer is not usable: ${offer.problem}`));
    }
    if (key === 'hype') {
      out.headline = HYPE_HEADLINE;
      out.description = offer.ok ? teaserForm(offer.value, input.offerTeaser) : null;
      out.cta = 'sign_up';
    } else if (key === 'last_chance') {
      out.headline = offer.ok ? `LAST CHANCE ${offer.value.toUpperCase()}` : null;
      out.description = LAST_CHANCE_DESCRIPTION;
      out.cta = 'shop_now';
    } else {
      out.headline = offer.ok ? offer.value.toUpperCase() : null;
      out.description = LIVE_DESCRIPTION;
      out.cta = 'shop_now';
    }
    return out;
  }

  // Standard product / New Drop / Restock (core, new_drop, organic_first)
  out.ruleKey = 'standard';
  const names = [...new Set((input.productNames || []).map((n) => String(n || '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
  if (names.length === 1) out.headline = names[0].toUpperCase();
  else if (names.length > 1) flags.push(flag('multiple_products', 'This ad covers several products, so no single product name can be used as the headline. Enter the headline yourself.'));
  else flags.push(flag('product_missing', 'No catalogue product is linked to this ad, so the headline could not be set. Link a product or enter the headline yourself.'));
  out.description = STANDARD_DESCRIPTION;
  out.cta = 'shop_now';
  return out;
}

// Whether a row's copy fields may be (re)written by the rules: only while no person has edited them.
function mayAutoApply(row) {
  return !row.copy_fields_manual && row.status !== 'approved';
}

module.exports = { deriveCopyRule, validateOffer, teaserForm, mayAutoApply, RULE_KEYS, STANDARD_DESCRIPTION, LIVE_DESCRIPTION, LAST_CHANCE_DESCRIPTION, HYPE_HEADLINE };
