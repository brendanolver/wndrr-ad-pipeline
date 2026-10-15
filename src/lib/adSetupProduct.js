// Which product(s) an Ad Setup is about, and the Meta-naming defaults that follow from it. Pure (no database); used by routes/adSetup.js.
const { splitProductName } = require('./adSetupNaming');
const { deriveProductCode } = require('./apparelmagic');

// Is this ad about ONE specific product? A product (ApparelMagic product code) usually has several colourway styles, so counting style rows would call every multi-colour
// product a multi-product ad. The product code of each linked style decides; a shoot plan item's own code is the fallback when no style is linked.
function productScope(ctx) {
  const codes = new Set(ctx.styles.map((x) => deriveProductCode(x.style_code)).filter(Boolean));
  if (!codes.size && ctx.shootPlanItem && ctx.shootPlanItem.product_code) codes.add(String(ctx.shootPlanItem.product_code).toUpperCase());
  return { single: codes.size === 1, code: codes.size === 1 ? [...codes][0] : null };
}

// Product Name + Product Category. One product: split its real name via splitProductName using the product's structured category when it has one (the canonical
// product/style ID stays exactly as already linked -- this only changes how the name is REPRESENTED for Meta naming, never the underlying record). Several products
// (a Drop / multi-product concept): there is no single garment name to split, so Name stays the collective Drop/Promotion label and Category the distinct-category union (or OTHER).
function deriveProductNameAndCategory(styles, dropName, promotion, shootPlanItem) {
  const codes = new Set(styles.map((x) => deriveProductCode(x.style_code)).filter(Boolean));
  if (styles.length === 1) {
    return splitProductName(styles[0].name, styles[0].category_name);
  }
  if (styles.length > 1 && codes.size === 1) { // several colourways of one product
    const cats = [...new Set(styles.map((x) => x.category_name).filter(Boolean))];
    return splitProductName((shootPlanItem && shootPlanItem.product_name) || styles[0].name, cats.length === 1 ? cats[0] : null);
  }
  const name = dropName || (promotion ? promotion.name : null) || (styles.length > 1 ? `${styles.length} Products` : null);
  const distinctCategories = [...new Set(styles.map((s) => s.category_name).filter(Boolean))];
  const category = distinctCategories.length === 1 ? distinctCategories[0] : (distinctCategories.length > 1 ? 'OTHER' : null);
  return { name, category };
}

// URL link page suggestion (all values stay editable):
//   one specific product (any number of colourways)   Product page
//   Sale Hype                                         Sign Up page
//   Sale Live / Mid Sale / Last Chance                left UNSELECTED for the team to choose (null)
//   everything else (no product, or several products)  New Arrivals
function deriveUrlLinkPage(adCategory, scope, stageType) {
  if (adCategory === 'promotion') return stageType === 'hype' ? 'sign_up' : null;
  return scope && scope.single ? 'product' : 'new_arrivals';
}


module.exports = { productScope, deriveProductNameAndCategory, deriveUrlLinkPage };
