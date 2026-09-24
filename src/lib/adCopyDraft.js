// Automatic starting-point copy drafts for Ad Setup.
//
// IMPORTANT: this is a rule/template-based generator, not a call to an
// external AI/LLM service -- this Node backend has no generative-AI API
// wired in. It fills WNDRR's own stage-behaviour templates (see below)
// with real context already known about the creative (Product, Product
// Type, Concept, Hook, Avatar, Promotion stage, Offer, Destination), so it
// never invents facts the context doesn't support: a field that's missing
// is simply left out of a given template variant rather than guessed.
// The output is always a starting draft -- selectable, editable, and
// regenerable, never auto-published as-is.
//
// Source of truth for tone/structure is the stage behaviour the brief
// itself specifies (Hype/Sale Live/Mid Sale/Last Chance), since no real
// WNDRR Primary Text/Headline Meta ad copy examples were recoverable from
// Drive in this pass (only Klaviyo/email copy was found, and that's
// deliberately NOT used as a stand-in for Meta ad copy).

function firstSentence(text) {
  if (!text) return '';
  return String(text).split(/[.!?\n]/)[0].trim();
}

function productPhrase(ctx) {
  if (ctx.productLabel) return ctx.productLabel;
  if (ctx.productType) return `our ${ctx.productType.toLowerCase()}`;
  return 'this piece';
}

// Non-sale (Core / New Drop / Organic-first) copy: built from Concept/Hook/
// Avatar context, no sale-stage urgency language.
function buildEvergreenCopy(ctx) {
  const hook = firstSentence(ctx.hook);
  const product = productPhrase(ctx);
  const avatar = ctx.avatarWhyCare ? firstSentence(ctx.avatarWhyCare) : '';

  const primary = [];
  if (hook) primary.push(`${hook}. Meet ${product}.`);
  else primary.push(`Meet ${product}.`);
  if (avatar) primary.push(`${avatar} ${product} is built for exactly that.`);
  else primary.push(`${product}, made to work as hard as you do.`);
  primary.push(`${product} — designed with WNDRR's usual attention to detail, made to last.`);

  const headline = [
    ctx.conceptLabel ? `${ctx.conceptLabel}` : `${product}`,
    hook ? hook.slice(0, 60) : `Discover ${product}`,
    `${product} — Shop Now`,
  ];

  return { primary, headline };
}

// Sale/Promotion copy: stage-specific behaviour per the brief. Never
// repeats Sale Live copy for Mid Sale, never fabricates an offer/GWP/date
// that ctx.offer/ctx.saleDates doesn't actually provide.
function buildSaleCopy(ctx) {
  const product = productPhrase(ctx);
  const offer = ctx.offer || null;
  const saleDates = ctx.saleDates || null;
  const stage = ctx.stageType;

  if (stage === 'hype') {
    const primary = [
      saleDates ? `Something's coming — ${saleDates}.` : `Something's coming soon.`,
      offer ? `Get ready: ${offer}. Sign up now so you don't miss it.` : `Get ready — sign up now so you don't miss it.`,
      `${product} is part of what's launching${saleDates ? `, ${saleDates}` : ''}. Be the first to know.`,
    ];
    const headline = [
      saleDates ? `Coming ${saleDates}` : 'Coming Soon',
      offer ? `${offer} — Be Notified` : 'Be the First to Know',
      `Get Ready`,
    ];
    return { primary, headline };
  }

  if (stage === 'sale_live') {
    const primary = [
      offer ? `Live now: ${offer}.` : `It's live now.`,
      `${product} is included — shop it while it's on.`,
      offer ? `${offer}, live now. Don't wait.` : `On now. Don't wait.`,
    ];
    const headline = [
      offer ? `${offer} — Live Now` : 'Live Now',
      `Shop the Sale`,
      `On Now`,
    ];
    return { primary, headline };
  }

  if (stage === 'mid_sale') {
    const primary = [
      offer ? `Still going — and there's more: ${offer}.` : `Still going, with something extra added.`,
      `${product} is still in the mix — don't miss it this time round.`,
      offer ? `New reason to shop: ${offer}. ${product} included.` : `A fresh reason to shop ${product} today.`,
    ];
    const headline = [
      offer ? `${offer} — Now Added` : 'More Just Added',
      `Still On`,
      `Shop ${product}`,
    ];
    return { primary, headline };
  }

  if (stage === 'last_chance') {
    const primary = [
      `Final hours — ${offer || 'the sale'} ends soon.`,
      `Last chance to shop ${product} before this one wraps up.`,
      offer ? `${offer} ends soon. Don't miss ${product}.` : `Ends soon. Don't miss ${product}.`,
    ];
    const headline = [
      `Final Hours`,
      `Ends Soon`,
      `Last Chance`,
    ];
    return { primary, headline };
  }

  // Promotion category without a detected stage (admin hasn't linked a
  // stage yet) -- fall back to the evergreen template rather than
  // fabricating stage-specific urgency it can't support.
  return buildEvergreenCopy(ctx);
}

// ctx: { hook, conceptLabel, productLabel, productType, avatarWhyCare,
//        adCategory, stageType, offer, saleDates }
// Returns { primaryTextOptions: string[3], headlineOptions: string[3] }.
function generateCopyDrafts(ctx) {
  const { primary, headline } = ctx.adCategory === 'promotion' ? buildSaleCopy(ctx) : buildEvergreenCopy(ctx);
  return {
    primaryTextOptions: primary.slice(0, 3),
    headlineOptions: headline.slice(0, 3),
  };
}

// Core -> Shop Now, Sale/Launch -> Sign Up is the current working rule per
// the brief, explicitly NOT confirmed as universal -- this is a starting
// default only, always editable on the Ad Setup record.
function defaultCta(adCategory, stageType) {
  if (adCategory === 'promotion') return stageType === 'hype' ? 'sign_up' : 'shop_the_sale';
  if (adCategory === 'new_drop') return 'sign_up';
  return 'shop_now';
}

module.exports = { generateCopyDrafts, defaultCta };
