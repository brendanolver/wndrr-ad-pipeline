#!/usr/bin/env node
// Compares the two sales histories Creative Planning can read seasonality from -- Shopify online orders and ApparelMagic online sales -- month by month.
// READ-ONLY, but it connects to PRODUCTION Shopify and ApparelMagic, so it refuses to run unless you pass --i-approve-production-read.
// It writes nothing, and prints no credentials or customer data (only monthly unit totals and data-quality counts).
//   node scripts/compare-seasonal-sources.js --i-approve-production-read
require('dotenv').config();
const shopify = require('../src/lib/shopifySales');

async function main() {
  if (!process.argv.includes('--i-approve-production-read')) {
    console.error('This reads production Shopify and ApparelMagic data. Re-run with --i-approve-production-read once that is approved.');
    process.exit(2);
  }
  const apparelmagic = require('../src/lib/apparelmagic');
  if (!shopify.configured()) throw new Error('SHOPIFY_SHOP_DOMAIN / SHOPIFY_ADMIN_TOKEN are not set');
  if (!apparelmagic.configured()) throw new Error('ApparelMagic is not configured');
  const details = await apparelmagic.getStyleCatalogue();
  const known = new Set(details.keys());
  const cfg = shopify.envConfig();
  const client = shopify.makeClient({ domain: cfg.domain, token: cfg.token, apiVersion: cfg.apiVersion });
  const tz = await shopify.shopTimeZone(client);
  console.log('Fetching Shopify orders (a bulk export; this can take several minutes)...');
  const sh = await shopify.fetchSalesByStyle({ client, knownStyles: known, tz, lookbackDays: 365 });
  console.log('Fetching ApparelMagic online sales (about 730 requests)...');
  const am = await apparelmagic.getSalesByStyle();
  console.log(`\nShopify window ${sh.window.from} .. ${sh.window.to}; ApparelMagic window ${am.window.from} .. ${am.window.to} (failed AM requests: ${am.window.failed_requests}/${am.window.total_requests})`);
  console.log('Shopify data quality:', JSON.stringify({ ...sh.window.stats, top_unmapped: undefined }));
  console.log('\nmonth      ApparelMagic   Shopify    diff   diff%');
  shopify.compareMonthly(am, sh).forEach((r) => console.log(`${r.month}  ${String(r.a).padStart(12)} ${String(r.b).padStart(9)} ${String(r.diff).padStart(7)} ${r.pct === null ? '    n/a' : `${r.pct}%`.padStart(7)}`));
  const styles = new Set([...am.keys(), ...sh.keys()]);
  let onlyAm = 0; let onlySh = 0; styles.forEach((s) => { if (!sh.has(s)) onlyAm += 1; if (!am.has(s)) onlySh += 1; });
  console.log(`\nstyles with sales: ${styles.size} (only in ApparelMagic: ${onlyAm}, only in Shopify: ${onlySh})`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
