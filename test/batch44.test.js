// AI Copy Assistant v2 (v1.4.5): automatic Copy Type, the library importer's "What" column and exclusions, reference selection, and product-claim safeguards.
// Pure functions and a fake database only: no network, no real database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const lib = require('../src/lib/copyLibrary');
const ai = require('../src/lib/copyAi');
const types = require('../src/lib/copyTypes');
const claims = require('../src/lib/copyClaims');
const text = require('../src/lib/copyText');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// ── a library shaped exactly like the WNDRR - AD COPY sheet (title row, "Range | What | Copy" header, merged Range cells) ──────────────────
const HDR = (title) => [[title], ['Range', 'What', 'Copy']];
const TABS = {
  CORE: [...HDR('CORE COPY'),
    ['High Summer Del. 1.0', 'Hijack Cargo Shorts', 'Introducing the 𝐇𝐢𝐣𝐚𝐜𝐤 𝐂𝐚𝐫𝐠𝐨 𝐒𝐡𝐨𝐫𝐭 🔥\n\nYour new favourite shorts feature:\n- Premium construction cotton\n- Twin cargo pockets with push studs and velcro closures\n\nAvailable now in 2 colourways: 𝐛𝐥𝐚𝐜𝐤 𝐚𝐧𝐝 𝐝𝐚𝐫𝐤 𝐠𝐫𝐞𝐞𝐧\n\nwww.wndrr.com'],
    ['', 'Offcut Tech Trackshort', 'The 𝐎𝐟𝐟𝐜𝐮𝐭 𝐓𝐞𝐜𝐡 𝐓𝐫𝐚𝐜𝐤𝐬𝐡𝐨𝐫𝐭 🔥\n\nThe perfect trackshort features:\n- Heavy weight cotton fleece\n- Relaxed fit\n\nAvailable in 6 colourways.\n\nwww.wndrr.com'],
    ['', 'Rothman Sport Short', 'The 𝐑𝐨𝐭𝐡𝐦𝐚𝐧 𝐒𝐩𝐨𝐫𝐭 𝐒𝐡𝐨𝐫𝐭 🏃‍♂️\n\nThe best-selling sport short features:\n- Light weight\n- Twin side pockets with zip closure\n\nAvailable in 5 colourways.\n\nwww.wndrr.com'],
    ['Core tees', 'Soho Club Tee', 'The 𝐒𝐨𝐡𝐨 𝐂𝐥𝐮𝐛 𝐓𝐞𝐞 is the tee you reach for first.\n\nSimple, clean, easy to style every day.\n\nCop yours 👇🏼\n\nwww.wndrr.com'],
    ['Core tees', 'Decade Box Fit Tee', 'Your go-to box fit tee is here 🔥\n\nWear it with anything. Cop yours 👇🏼\n\nwww.wndrr.com']],
  'CORE 26': [...HDR('CORE COPY'),
    ['Jan 2026', 'The World Sport Trackpant', '🚨New colour alert | The World Sport Trackpant 🔥\n\nOur best-selling trackpant from 2025 is BACK and now available in cement grey.\n\nCop yours now before it\'s gone 👇🏼\n\nwww.wndrr.com'],
    ['January 2026', 'Content Creative Specialist - Ad', 'We’re hiring a 𝐂𝐨𝐧𝐭𝐞𝐧𝐭 𝐂𝐫𝐞𝐚𝐭𝐢𝐯𝐞 𝐒𝐩𝐞𝐜𝐢𝐚𝐥𝐢𝐬𝐭.\n\nThis isn’t a “learn streetwear” role. WNDRR is built on streetwear, sport & music culture. You’ll be concepting, shooting, styling, editing.'],
    ['March 2026', 'Asset Tee', 'Meet the Asset tee. Clean lines, easy to wear, made for every day 🔥\n\nCop yours 👇🏼\n\nwww.wndrr.com']],
  SALES: [['SALES COPY'], ['Sale', 'What', 'Copy'],
    ['BIRTHDAY SALE', 'PRE-HYPE', '𝐁𝐢𝐫𝐭𝐡𝐝𝐚𝐲 𝐒𝐚𝐥𝐞 incoming... Starts Tuesday 18.03.25 🎉\n\n30% off sitewide! Sign up to be notified ↓\n\nhttps://www.wndrr.com/pages/birthday-sale-signup'],
    ['', '', 'Just a heads up that we will be launching our much anticipated 𝐁𝐢𝐫𝐭𝐡𝐝𝐚𝐲 𝐒𝐚𝐥𝐞! 30% off sitewide, no exclusions!\n\nSign up to be notified ↓\n\nhttps://www.wndrr.com/pages/birthday-sale-signup'],
    ['', 'LIVE', 'The 𝐁𝐢𝐫𝐭𝐡𝐝𝐚𝐲 𝐒𝐚𝐥𝐞 is LIVE 🎉\n\n30% off sitewide. Shop now ↓\n\nwww.wndrr.com']],
  BUNDLES: [...HDR('BUNDLES COPY'),
    ['December 2024', 'SOHO TEES 3 FOR $130', '𝐒𝐎𝐇𝐎 𝐂𝐋𝐔𝐁 𝐓𝐄𝐄𝐒 𝟑 𝐅𝐎𝐑 $𝟏𝟑𝟎 𝐀𝐔𝐃 🔥\n\nPick any 3 Soho Club Tees for $130 AUD!\nFeaturing:\n- 230 GSM heavy weight combed cotton\n- Boxy fit with drop shoulder\n\nwww.wndrr.com']],
  'BUNDLES 26': [...HDR('BUNDLES COPY'),
    ['January 2026', '3 for $150 Graphic Tees', '3 for $150 Graphic Tees 🔥\n\nLooking to refresh your summer wardrobe? We\'ve got you covered.\n\n✔️ Mix & match our curated selection\n✔️ 3 for $150 bundle\n\nCop your new summer staples now 👇🏼\n\nwww.wndrr.com'],
    ['February 2026', 'SOHO TEES 3 FOR $130 - Review', '"An upgrade you\'ll feel immediately." - Mark H.\n\nIntroducing the 𝐒𝐎𝐇𝐎 𝐂𝐋𝐔𝐁 𝐓𝐄𝐄 🔥\n\nPick any 3 Soho Club Tees for $130 AUD!\n\nwww.wndrr.com']],
  'USA - BUNDLES 26': [...HDR('USA BUNDLES COPY'),
    ['May 2026', '3 for $120 USD Shorts', 'Ready to elevate your shorts rotation? 🔥\n\n3 for $120 shorts are live now 👇🏼\n\n✔️ Mix & match trackshorts, sport and beach shorts\n✔️ Designed in Melbourne, Australia 🇦🇺\n\nCop your new shorts refresh today.\n\nwww.wndrr.com']],
  '2024 RANGES': [...HDR('RANGE RELEASE COPY'),
    ['Spring Del. 3.0', 'Product', 'SPRING DEL. 3.0 | The Junkyard Box Fit Tee 🥊\n\nAvailable in washed grey.\n\nwww.wndrr.com']],
  '2025 RANGES': [...HDR('RANGE RELEASE COPY'),
    ['Summer Del. 1.2', 'Range layout + grid', 'SUMMER DEL. 1.2 🏝️\n\nNew graphic tees, muscle tops and trackpants.\n\nwww.wndrr.com'],
    ['Summer Del. 1.2', 'Product', 'SUMMER DEL. 1.2 | The Fiend Box Fit Tee 🔥\n\nAvailable in washed grey.\n\nwww.wndrr.com']],
  '2026 RANGES': [...HDR('RANGE RELEASE COPY'),
    ['High Summer Del. 2.0', 'Product', 'HIGH SUMMER DEL. 2.0 | The Brushback Heavy Weight Tee 🔥\n\nAvailable in charcoal and black.\n\nwww.wndrr.com'],
    ['High Summer Del. 2.0', 'Shodo tee - try on', 'Build a summer fit with Akido ☀️\n\nFt. Shodo Box Fit Tee & Booster Denim Short\n\nwww.wndrr.com'],
    ['High Summer Del. 2.0', '3 fits for summer', '3 fits for summer ☀️\n\nLevel up your wardrobe by adding:\n✔️ Statement tees - minimal is out\n✔️ Colour - sorry black and white doesn\'t cut it anymore\n✔️ Relaxed shorts - to move with you wherever you go\n\nwww.wndrr.com']],
  PINTEREST: [['PINTEREST DESCRIPTIONS'], ['Product/Range', 'Description'], ['Halo Sweats', 'The perfect basic sweat sets. Heavy weight cotton, embroidered branding, 7+ colourways. Cop your elevated everyday fit today.']],
};
const FAMILY = { CORE: 'core', 'CORE 26': 'core', SALES: 'sales', '2026 SALES': 'sales', BUNDLES: 'bundles', 'BUNDLES 26': 'bundles', 'USA - BUNDLES 26': 'bundles', '2024 RANGES': 'ranges', '2025 RANGES': 'ranges', '2026 RANGES': 'ranges', PINTEREST: 'pinterest' };
const YEAR = { 'CORE 26': 2026, '2026 SALES': 2026, 'BUNDLES 26': 2026, 'USA - BUNDLES 26': 2026, '2024 RANGES': 2024, '2025 RANGES': 2025, '2026 RANGES': 2026 };
function library() {
  let id = 1; const all = [];
  for (const [tab, rows] of Object.entries(TABS)) {
    const parsed = lib.parseTab(rows, { title: tab, family: FAMILY[tab] });
    parsed.examples.forEach((e) => all.push({ ...e, ...lib.enrichExample({ ...e, tab, family: FAMILY[tab] }), id: id++, tab, family: FAMILY[tab], year: YEAR[tab] || null }));
  }
  return all;
}
const byTab = (list) => list.map((e) => e.tab);

// ── 1. Copy Type classification ────────────────────────────────────────────────────────────────────────────────────
const base = { adCategory: 'organic_first', styles: [], productCount: 1, texts: {}, today: new Date('2026-10-18') };

test('classification: a Promotion stage means Sale / Promotion', () => {
  const c = types.classifyCopyType({ ...base, adCategory: 'promotion', promotionStageName: 'Live', promotionName: 'Black Friday' });
  assert.equal(c.type, 'sale'); assert.equal(c.confidence, 'high'); assert.match(c.reasons.join(' '), /Black Friday/);
});

test('classification: Core planning source -> Core; Upcoming Drops -> New Range; nothing is claimed as new for Core', () => {
  const core = types.classifyCopyType({ ...base, adCategory: 'core', shootPlanSource: 'core' });
  assert.equal(core.type, 'core'); assert.equal(core.newnessAllowed, false);
  const drop = types.classifyCopyType({ ...base, adCategory: 'new_drop', shootPlanSource: 'drop', styles: [{ tier: 'new_drop', drop_name: 'High Summer 2.0' }] });
  assert.equal(drop.type, 'new_range'); assert.equal(drop.newnessAllowed, true); assert.match(drop.reasons.join(' '), /High Summer 2\.0/);
});

test('classification: bundle and USA bundle come from the brief, never from the number of products alone', () => {
  assert.notEqual(types.classifyCopyType({ ...base, adCategory: 'core', productCount: 3 }).type, 'bundle');
  assert.equal(types.classifyCopyType({ ...base, productCount: 3, texts: { conceptName: 'Summer tees bundle' } }).type, 'bundle');
  assert.equal(types.classifyCopyType({ ...base, texts: { productLabel: '3 for $150 graphic tees' } }).type, 'bundle');
  assert.equal(types.classifyCopyType({ ...base, productCount: 3, texts: { conceptName: 'USA shorts bundle' } }).type, 'usa_bundle');
  assert.equal(types.classifyCopyType({ ...base, productCount: 2, texts: { angle: '2 for $120 USD trackpants' } }).type, 'usa_bundle');
  // USA with no bundle in the brief is not a USA bundle
  assert.notEqual(types.classifyCopyType({ ...base, adCategory: 'core', texts: { conceptName: 'USA launch teaser' } }).type, 'usa_bundle');
});

test('classification: new colourways only with evidence (brief, planning reason or an earlier launch of the same product)', () => {
  assert.equal(types.classifyCopyType({ ...base, adCategory: 'core', texts: { hook: 'New colour alert' } }).type, 'new_colourways');
  assert.equal(types.classifyCopyType({ ...base, adCategory: 'core', planningReason: 'New colourways just landed' }).type, 'new_colourways');
  assert.equal(types.classifyCopyType({ ...base, adCategory: 'core', siblingColourwaysEarlier: true }).type, 'new_colourways');
  assert.equal(types.classifyCopyType({ ...base, adCategory: 'core' }).type, 'core', 'no evidence, no colourway claim');
});

test('classification: a drop only counts as new while it is recent or upcoming', () => {
  const recent = types.classifyCopyType({ ...base, adCategory: 'core', styles: [{ tier: 'new_drop', drop_name: 'D', drop_launch_date: '2026-09-20' }] });
  assert.equal(recent.type, 'new_range'); assert.equal(recent.confidence, 'medium');
  const old = types.classifyCopyType({ ...base, adCategory: 'core', styles: [{ tier: 'new_drop', drop_name: 'D', drop_launch_date: '2025-06-01' }] });
  assert.equal(old.type, 'core');
  const undated = types.classifyCopyType({ ...base, styles: [{ tier: 'new_drop' }] });
  assert.equal(undated.type, 'general', 'a new-drop tier with no drop date is not evidence of a launch');
});

test('classification: not enough evidence falls back to general product copy and says so', () => {
  const c = types.classifyCopyType(base);
  assert.equal(c.type, 'general'); assert.equal(c.fallback, true); assert.equal(c.confidence, 'low'); assert.match(c.reasons.join(' '), /Not enough information/);
  assert.equal(c.newnessAllowed, false);
  assert.equal(types.classifyCopyType(undefined).type, 'general');
  assert.deepEqual(types.COPY_TYPES.map((t) => t.value), ['core', 'new_range', 'new_colourways', 'bundle', 'usa_bundle', 'sale', 'general']);
});

test('classification is deterministic', () => {
  const ev = { ...base, adCategory: 'core', texts: { hook: 'New colour alert' }, styles: [{ tier: 'core_proven' }] };
  assert.deepEqual(types.classifyCopyType(ev), types.classifyCopyType(ev));
});

// ── 2. Overrides ───────────────────────────────────────────────────────────────────────────────────────────────────
test('override: a manual Copy Type always beats automatic detection; clearing it returns to automatic', () => {
  const auto = types.classifyCopyType({ ...base, adCategory: 'core' });
  assert.equal(auto.type, 'core');
  const manual = types.effectiveCopyType('bundle', auto);
  assert.deepEqual([manual.type, manual.source], ['bundle', 'manual']);
  const reset = types.effectiveCopyType(null, auto);
  assert.deepEqual([reset.type, reset.source], ['core', 'auto']);
  assert.equal(types.effectiveCopyType('not-a-type', auto).source, 'auto', 'an invalid stored value is ignored, not trusted');
  assert.equal(types.effectiveCopyType('new_range', auto).newnessAllowed, true);
  assert.equal(types.effectiveCopyType('core', types.classifyCopyType({ ...base, adCategory: 'promotion', promotionStageName: 'Live' })).type, 'core', 'a person can override even a Sale detection');
});

test('override wiring: stored on the Ad Setup, set / reset through its own endpoint, never on an approved Ad Setup', () => {
  const schema = read('db/schema.sql'); const route = read('src/routes/copyAssistant.js'); const adSetup = read('src/routes/adSetup.js');
  assert.match(schema, /ALTER TABLE ad_setups ADD COLUMN IF NOT EXISTS copy_type_override VARCHAR\(20\)/);
  assert.match(schema, /copy_type_override IS NULL OR copy_type_override IN \('core', 'new_range', 'new_colourways', 'bundle', 'usa_bundle', 'sale', 'general'\)/);
  assert.match(route, /adRouter\.put\('\/:id\/copy-type'/);
  assert.match(route, /existing\.status === 'approved'\) return res\.status\(409\)/);
  assert.match(route, /UPDATE ad_setups SET copy_type_override = \$1 WHERE id = \$2 AND status = 'draft'/);
  assert.match(route, /raw === 'auto'/, 'null / "auto" clears the override');
  assert.doesNotMatch(adSetup, /copy_type_override/, 'the general Ad Setup PATCH cannot change it, and approval does not read it');
  assert.match(route, /effectiveCopyType\(row\.copy_type_override, auto\)/, 'every generation reads the stored override');
});

// ── 3. Importer ────────────────────────────────────────────────────────────────────────────────────────────────────
test('importer: the "What" column is the product / subject and the Range is the label; merged cells are carried down', () => {
  const p = lib.parseTab(TABS.CORE, { title: 'CORE', family: 'core' });
  assert.equal(p.header_found, true);
  assert.equal(p.columns.subject, 1); assert.equal(p.columns.label, 0); assert.deepEqual(p.columns.body, [2]);
  assert.equal(p.examples[0].subject, 'Hijack Cargo Shorts'); assert.equal(p.examples[0].label, 'High Summer Del. 1.0');
  assert.equal(p.examples[1].subject, 'Offcut Tech Trackshort');
  assert.equal(p.examples[1].label, 'High Summer Del. 1.0', 'a blank (merged) Range cell takes the Range above');
  assert.ok(p.filled_down >= 2);
  const sales = lib.parseTab(TABS.SALES, { title: 'SALES', family: 'sales' });
  assert.deepEqual(sales.examples.map((e) => e.subject), ['PRE-HYPE', 'PRE-HYPE', 'LIVE'], 'on the sales tabs the merged stage is carried down too');
  assert.deepEqual(sales.examples.map((e) => e.label), ['BIRTHDAY SALE', 'BIRTHDAY SALE', 'BIRTHDAY SALE']);
  const merged = lib.parseTab([['[merged] CORE COPY'], ['[merged] Range', 'What', 'Copy'], ['[merged] R1', 'Soho Club Tee', 'The Soho Club Tee is the tee you reach for first. Cop yours today.']], { family: 'core' });
  assert.equal(merged.examples[0].label, 'R1');
  assert.equal(lib.parseTab([['Product', 'Headline', 'Primary Text'], ['Asset Raglan Tee', 'ASSET RAGLAN TEE', 'Your new favourite tee.\nBoxy fit, soft feel, made to wear on repeat.']], {}).examples[0].subject, 'Asset Raglan Tee');
});

test('importer: ranges tabs carry the product in the copy, not in the What column', () => {
  const e = lib.parseTab(TABS['2024 RANGES'], { family: 'ranges' }).examples[0];
  const en = lib.enrichExample({ ...e, tab: '2024 RANGES', family: 'ranges' });
  assert.equal(en.subject, 'Junkyard Box Fit Tee'); assert.equal(en.kind, 'product');
  const grid = lib.parseTab(TABS['2025 RANGES'], { family: 'ranges' }).examples[0];
  assert.equal(lib.enrichExample({ ...grid, family: 'ranges' }).kind, 'range_layout');
  const lifestyle = lib.parseTab(TABS['2026 RANGES'], { family: 'ranges' }).examples.find((x) => x.subject === '3 fits for summer');
  assert.equal(lib.enrichExample({ ...lifestyle, family: 'ranges' }).kind, 'lifestyle');
});

test('importer: recruitment, testimonials and non-ad rows are kept but flagged, and never used as references', () => {
  const all = library();
  const hiring = all.find((e) => /hiring/.test(e.body));
  assert.deepEqual([hiring.kind, hiring.excluded, hiring.exclude_reason], ['recruitment', true, 'recruitment']);
  const review = all.find((e) => /upgrade you'll feel/.test(e.body));
  assert.deepEqual([review.kind, review.excluded], ['testimonial', true]);
  const pin = all.find((e) => e.tab === 'PINTEREST');
  assert.deepEqual([pin.kind, pin.excluded], ['pinterest', true]);
  assert.equal(all.find((e) => e.subject === 'Soho Club Tee').excluded, false);
  for (const t of types.VALUES) {
    const picked = lib.selectExamples(all, { copyType: t, productName: 'Asset Raglan Box Fit Tee', productCategory: 'Box Fit Tee', stageType: 'sale_live' });
    assert.ok(picked.every((e) => !e.excluded), `${t}: no excluded example is ever selected`);
  }
  assert.deepEqual(lib.analyseTone(all).examples, all.filter((e) => !e.excluded).length, 'tone statistics ignore them too');
});

test('importer: rows imported before the new columns existed are enriched when read', () => {
  const old = { id: 1, tab: 'CORE', family: 'core', label: 'High Summer Del. 1.0', body: 'The Hijack Cargo Short is here.', meta: { What: 'Hijack Cargo Shorts', year: null } };
  const en = lib.enrichExample(old);
  assert.equal(en.subject, 'Hijack Cargo Shorts'); assert.equal(en.kind, 'product');
});

test('importer: a library imported by an earlier version is read with the Range and sales stage carried down', async () => {
  const rows = [
    { id: 1, tab: 'SALES', family: 'sales', label: 'BIRTHDAY SALE', body: 'a', meta: { What: 'PRE-HYPE' } }, { id: 2, tab: 'SALES', family: 'sales', label: null, body: 'b', meta: {} },
    { id: 3, tab: 'SALES', family: 'sales', label: null, body: 'c', meta: { What: 'LIVE' } }, { id: 4, tab: 'CORE', family: 'core', label: 'High Summer', body: 'd', meta: { What: 'Hijack Cargo Shorts' } }, { id: 5, tab: 'CORE', family: 'core', label: null, body: 'e', meta: { What: 'Offcut Tech Trackshort' } },
  ];
  const db = { query: async (sql) => (/FROM copy_reference_syncs/.test(sql) ? { rows: [{ id: 7, finished_at: new Date() }] } : { rows }) };
  const { examples } = await lib.loadExamples(db);
  assert.deepEqual(examples.map((e) => e.label), ['BIRTHDAY SALE', 'BIRTHDAY SALE', 'BIRTHDAY SALE', 'High Summer', 'High Summer']);
  assert.deepEqual(examples.map((e) => e.subject), ['PRE-HYPE', 'PRE-HYPE', 'LIVE', 'Hijack Cargo Shorts', 'Offcut Tech Trackshort']);
  assert.equal(examples[3].kind, 'product');
});

test('unicode: decorative lettering is resolved before matching', () => {
  assert.equal(text.normalizeUnicode('𝐇𝐢𝐣𝐚𝐜𝐤 𝐂𝐚𝐫𝐠𝐨 𝟑 𝐅𝐎𝐑 $𝟏𝟓𝟎'), 'Hijack Cargo 3 FOR $150');
  assert.ok(text.hasPhrase('Introducing the 𝐇𝐢𝐣𝐚𝐜𝐤 𝐂𝐚𝐫𝐠𝐨 𝐒𝐡𝐨𝐫𝐭', 'hijack cargo shorts'));
  assert.ok(text.similarity('𝐒𝐎𝐇𝐎 𝐂𝐋𝐔𝐁 𝐓𝐄𝐄', 'Soho Club Tee') === 1);
  assert.ok(text.hasWord('three tees', 'tee') && !text.hasWord('boxy fit', 'box') && !text.hasWord('an outfit', 'fit') && text.hasWord('3 fits', 'fit'));
});

// a fake database that records every statement
function fakeDb({ previous = null } = {}) {
  const log = [];
  const client = { query: async (sql) => { log.push(sql); return { rows: [] }; }, release() {} };
  return {
    log,
    query: async (sql, params) => {
      log.push(sql);
      if (/FROM copy_reference_syncs WHERE status = 'success' ORDER BY id DESC LIMIT 1/.test(sql)) return { rows: previous ? [previous] : [] };
      if (/INSERT INTO copy_reference_syncs/.test(sql)) return { rows: [{ id: 99 }] };
      return { rows: [] };
    },
    connect: async () => client,
  };
}
const sheetsFrom = (tabs) => ({ listTabs: async () => Object.keys(tabs).map((title) => ({ title })), readTab: async (t) => tabs[t] || [] });

test('validated import: a dry run reads and checks everything and writes nothing', async () => {
  const db = fakeDb({ previous: { example_count: 20, finished_at: new Date() } });
  const out = await lib.syncLibrary({ db, sheets: sheetsFrom(TABS), dryRun: true });
  assert.equal(out.ok, true); assert.equal(out.dry_run, true);
  assert.equal(out.tabs.length, 11); assert.ok(out.tabs.find((t) => t.title === 'CORE').with_subject >= 3);
  assert.ok(out.excluded >= 3); assert.equal(out.current.examples, 20);
  assert.ok(db.log.every((q) => /^SELECT/.test(q)), 'only reads: no insert, no update');
});

test('validated import: a result that would shrink the library sharply is rejected and the current library stays active', async () => {
  const db = fakeDb({ previous: { example_count: 547, finished_at: new Date() } });
  const out = await lib.syncLibrary({ db, sheets: sheetsFrom(TABS) });
  assert.equal(out.ok, false); assert.equal(out.code, 'shrunk');
  assert.ok(!db.log.some((q) => /INSERT INTO copy_reference_examples|DELETE FROM copy_reference_syncs/.test(q)), 'nothing was written to or removed from the library');
  assert.ok(db.log.some((q) => /status = 'failed'/.test(q)), 'the attempt is recorded as failed');
  const accepted = await lib.syncLibrary({ db: fakeDb({ previous: { example_count: 547, finished_at: new Date() } }), sheets: sheetsFrom(TABS), acceptSmaller: true });
  assert.equal(accepted.ok, true);
  const fresh = await lib.syncLibrary({ db: fakeDb(), sheets: sheetsFrom(TABS) });
  assert.equal(fresh.ok, true); assert.equal(fresh.examples, library().length);
  const empty = await lib.syncLibrary({ db: fakeDb(), sheets: sheetsFrom({ CORE: [] }) });
  assert.equal(empty.ok, false); assert.equal(empty.code, 'no_examples');
});

test('validated import: the new columns are stored, and the spreadsheet is only ever read', () => {
  const src = read('src/lib/copyLibrary.js');
  assert.match(src, /INSERT INTO copy_reference_examples \(sync_id, tab, family, row_number, label, body, headline, meta, subject, kind, excluded, exclude_reason\)/);
  assert.doesNotMatch(read('src/lib/googleSheets.js'), /method: '(?:PUT|POST|PATCH|DELETE)'.*spreadsheets/, 'no write call to the sheet');
  const schema = read('db/schema.sql');
  for (const col of ['subject TEXT', 'kind VARCHAR\\(20\\)', 'excluded BOOLEAN NOT NULL DEFAULT false', 'exclude_reason VARCHAR\\(30\\)']) assert.match(schema, new RegExp(`ALTER TABLE copy_reference_examples ADD COLUMN IF NOT EXISTS ${col}`));
});

// ── 4. Reference selection ─────────────────────────────────────────────────────────────────────────────────────────
const q = { productName: 'Asset Raglan Box Fit Tee', productCategory: 'Box Fit Tee' };

test('selection: each Copy Type draws on its own spreadsheet tabs', () => {
  const all = library();
  const tabsFor = (copyType, extra = {}) => new Set(byTab(lib.selectExamples(all, { copyType, ...q, ...extra })));
  const within = (set, allowed) => [...set].every((t) => allowed.includes(t));
  assert.ok(within(tabsFor('core'), ['CORE', 'CORE 26', '2026 RANGES', '2025 RANGES']), [...tabsFor('core')].join());
  assert.ok(byTab(lib.selectExamples(all, { copyType: 'core', ...q })).slice(0, 4).every((t) => ['CORE', 'CORE 26'].includes(t)), 'core: CORE / CORE 26 come first');
  assert.ok(within(tabsFor('new_range'), ['2026 RANGES', '2025 RANGES', '2024 RANGES', 'CORE 26', 'CORE']));
  assert.ok(byTab(lib.selectExamples(all, { copyType: 'new_range', ...q })).slice(0, 4).every((t) => /RANGES/.test(t)), 'new range: RANGES tabs come first');
  assert.ok(within(tabsFor('bundle'), ['BUNDLES', 'BUNDLES 26']) && !tabsFor('bundle').has('USA - BUNDLES 26'), 'bundle: BUNDLES and BUNDLES 26 only');
  assert.equal(byTab(lib.selectExamples(all, { copyType: 'usa_bundle', ...q }))[0], 'USA - BUNDLES 26', 'USA bundle: the USA tab first');
  assert.ok(within(tabsFor('sale', { stageType: 'sale_live' }), ['SALES', '2026 SALES']), 'sale: sales tabs only');
  assert.ok(within(tabsFor('new_colourways'), ['CORE', 'CORE 26', '2026 RANGES', '2025 RANGES', '2024 RANGES']), 'new colourways: CORE and RANGES');
  assert.ok(!tabsFor('general').has('SALES') && !tabsFor('general').has('PINTEREST'));
  assert.ok(![...tabsFor('core')].some((t) => /SALES|BUNDLES|PINTEREST/.test(t)));
});

test('selection: the right product type, whole words only, decorative lettering understood', () => {
  const all = library();
  const tee = lib.selectExamples(all, { copyType: 'core', ...q });
  assert.ok(/tee/i.test(lib.enrichExample(tee[0]).subject || tee[0].body), 'a tee product is matched with tee references first');
  const shortsFirst = lib.selectExamples(all, { copyType: 'core', productName: 'Hijack Cargo Short', productCategory: 'Cargo Short' });
  assert.equal(shortsFirst[0].subject, 'Hijack Cargo Shorts', 'the reference written in decorative letters still matches the product');
  const sc = lib.relevanceScore;
  const qq = lib.productQuery({ productName: 'Asset Raglan Box Fit Tee', productCategory: 'Box Fit Tee' });
  assert.equal(sc({ subject: null, label: null, body: 'a boxy outfit, three fits' }, { ...qq, typePhrase: null, head: null, distinct: [], group: -1 }), 0);
  assert.ok(sc({ subject: 'Soho Club Tee', label: null, body: 'x' }, qq) > sc({ subject: 'Rothman Sport Short', label: null, body: 'x' }, qq));
});

test('selection: near-identical references are not both chosen, and the set has variety', () => {
  const all = library();
  all.push({ ...all.find((e) => e.subject === 'Soho Club Tee'), id: 900, row_number: 90, body: 'The Soho Club Tee is the tee you reach for first.\n\nSimple, clean, easy to style every day.\n\nCop yours today 👇🏼\n\nwww.wndrr.com' });
  const picked = lib.selectExamples(all, { copyType: 'core', ...q, limit: 6 });
  const soho = picked.filter((e) => e.subject === 'Soho Club Tee');
  assert.equal(soho.length, 1, 'one of two near-duplicates');
  const bodies = picked.map((e) => e.body);
  for (let i = 0; i < bodies.length; i += 1) for (let j = i + 1; j < bodies.length; j += 1) assert.ok(text.similarity(bodies[i], bodies[j]) < 0.55);
  const many = [];
  for (let i = 0; i < 12; i += 1) many.push({ id: 1000 + i, tab: 'CORE', family: 'core', subject: `Tee ${i}`, label: null, kind: 'product', year: null, body: `Unique line number ${i} about thing ${i * 7} and word${i}x for variety ${'abcdefghijkl'[i]}${i}` });
  many.push({ id: 2000, tab: 'CORE 26', family: 'core', subject: 'Tee Z', kind: 'product', year: 2026, body: 'A fresh take on the everyday tee, nothing like the others here.' });
  const spread = lib.selectExamples(many, { copyType: 'core', productName: 'Tee', productCategory: 'Tee', limit: 6 });
  assert.ok(spread.filter((e) => e.tab === 'CORE').length <= 3, 'no single tab fills the set');
});

test('selection: deterministic, and the older call style (ad category, no tabs) still works', () => {
  const all = library();
  assert.deepEqual(lib.selectExamples(all, { copyType: 'core', ...q }).map((e) => e.id), lib.selectExamples(all, { copyType: 'core', ...q }).map((e) => e.id));
  const legacy = lib.selectExamples([{ id: 1, family: 'core', label: 'Asset Raglan Tee', body: 'core tee copy', year: 2025 }, { id: 3, family: 'sales', label: 'x', body: 'sales copy ends tonight', year: 2025 }], { adCategory: 'core', productName: 'Asset Raglan Tee' });
  assert.deepEqual(legacy.map((e) => e.id), [1]);
});

// ── 5. Product-claim safeguards ────────────────────────────────────────────────────────────────────────────────────
const VERIFIED = { productName: 'ASSET RAGLAN BOX FIT TEE', productCategory: 'BOX FIT TEE', productNames: ['ASSET RAGLAN BOX FIT TEE'], adCategoryLabel: 'Core', copyType: 'core', copyTypeLabel: 'Core / Evergreen', newnessAllowed: false, isPromotion: false, format: 'video' };
const guard = (f = VERIFIED, extra = '') => ({ text: `${ai.factsToText(f)}\n${extra}`, isPromotion: !!f.isPromotion, newnessAllowed: !!f.newnessAllowed });
const unsupported = (t, f, extra) => claims.findUnsupportedClaims(t, guard(f, extra)).map((c) => c.code);

test('claims: "One tee, three completely different fits" is rejected when no verified evidence supports it', () => {
  assert.ok(unsupported('One tee, three completely different fits.').includes('count'));
  // the creative concept is direction, not evidence: even a concept called "3 ways to style" does not support it
  const withConcept = { ...VERIFIED, conceptName: 'One tee, three completely different fits', hook: 'three fits' };
  assert.ok(unsupported('One tee, three completely different fits.', withConcept).includes('count'));
  assert.ok(!ai.factsToText(withConcept).includes('three'), 'creative direction is not part of the verified facts');
  assert.match(ai.directionToText(withConcept), /three completely different fits/, 'it is still given to the writer as direction');
});

test('claims: features, fabric, counts, fits, popularity, offers, availability and newness are blocked unless verified', () => {
  const bad = {
    feature: 'Twin side pockets with zip closure.', fabric: 'Heavy weight cotton fleece.', quality: 'Soft, premium and durable.', count: 'Available in 8 colourways.', variants: 'Choose from different fits.',
    popularity: 'Our best-selling tee is back.', superlative: 'The best tee in the game.', discount: 'Now 30% off.', price: 'Just $49.', availability: 'Available now.', colour: 'Comes in washed grey.', stock: 'Selling fast.',
    newness: 'Just dropped: the new tee.', ways: 'Three ways to wear one tee.', gsm: 'A 230 GSM tee.',
  };
  for (const [code, t] of Object.entries(bad)) assert.ok(claims.findUnsupportedClaims(t, guard()).length > 0, `${code}: ${t}`);
  // what the product name itself supports, and plain style, still passes
  assert.deepEqual(unsupported('Your new favourite box fit tee. Cop the ASSET RAGLAN BOX FIT TEE 👇🏼'), []);
  assert.deepEqual(unsupported('Raglan shape, boxy fit.'), [], 'the verified product name contains raglan and box fit');
  assert.deepEqual(unsupported('Easy to wear every day. Cop yours.'), []);
});

test('claims: launch wording is allowed only when the Copy Type supports it', () => {
  assert.ok(unsupported('Introducing the Asset Raglan Box Fit Tee.').includes('newness'));
  assert.deepEqual(unsupported('Introducing the Asset Raglan Box Fit Tee.', { ...VERIFIED, newnessAllowed: true }), []);
  const t = types.effectiveCopyType('new_range', { type: 'core' });
  assert.equal(t.newnessAllowed, true);
});

test('claims: what a person types into the request is a statement of fact they own', () => {
  assert.deepEqual(unsupported('Heavy weight cotton fleece.', VERIFIED, 'mention it is heavy weight cotton fleece'), []);
  assert.ok(unsupported('Heavy weight cotton fleece.').length > 0);
});

test('claims: reference examples are masked before the model sees them', () => {
  const ex = library().find((e) => e.subject === 'Hijack Cargo Shorts');
  const masked = lib.promptExample(ex).body;
  assert.doesNotMatch(masked, /Hijack|cotton|pockets|velcro|studs|black|green/i);
  assert.doesNotMatch(masked, /[\u{1D400}-\u{1D7FF}]/u, 'decorative lettering becomes plain text');
  assert.match(masked, /\[PRODUCT\]/); assert.match(masked, /\[DETAIL\]/); assert.match(masked, /🔥/, 'emoji and layout stay');
  const rm = lib.promptExample(library().find((e) => /3 fits for summer/.test(e.body) && e.tab === '2026 RANGES')).body;
  assert.doesNotMatch(rm, /3 fits/); assert.match(rm, /\[COUNT\]/);
  const sale = lib.promptExample(library().find((e) => e.tab === 'SALES')).body;
  assert.doesNotMatch(sale, /30%/); assert.match(sale, /\[DISCOUNT\]/);
  assert.match(claims.maskClaims('Available in 8 colourways.\nwww.wndrr.com'), /www\.wndrr\.com/, 'links (a call to action) are kept');
});

test('prompt: facts, creative direction, copy type and masked references are separate sections; no forced feature-led option', () => {
  const facts = { ...VERIFIED, conceptName: 'Three fits one tee', hook: 'Stop scrolling', angle: 'one tee, many looks' };
  const m = ai.buildMessages({ mode: 'generate', facts, guidelines: 'Short sentences.', examples: [{ tab: 'CORE', label: null, body: '[PRODUCT] 🔥\n\n[DETAIL]' }], ruleKey: 'standard', copyType: 'core' });
  const u = m.messages[m.messages.length - 1].content;
  const section = (name) => u.slice(u.indexOf(name));
  assert.match(u, /COPY TYPE: Core \/ Evergreen/);
  const verified = u.slice(u.indexOf('VERIFIED FACTS'), u.indexOf('CREATIVE DIRECTION'));
  assert.match(verified, /ASSET RAGLAN BOX FIT TEE/); assert.doesNotMatch(verified, /Three fits|Stop scrolling|many looks/);
  assert.match(section('CREATIVE DIRECTION'), /Three fits one tee/);
  assert.match(m.system, /NOT a fact about the product/); assert.match(m.system, /OTHER products/); assert.match(m.system, /\[PRODUCT\]/);
  assert.doesNotMatch(u, /feature-led/);
  const withFeatures = ai.buildMessages({ mode: 'generate', facts: { ...facts, verifiedFeatures: ['Ribbed neck'] }, guidelines: '', examples: [], ruleKey: 'standard', copyType: 'core' });
  assert.match(withFeatures.messages[0].content, /feature-led \(use ONLY the verified features/);
  for (const t of ['new_range', 'new_colourways', 'bundle', 'usa_bundle']) assert.ok(ai.anglesFor('standard', t, facts).length >= 3, t);
  assert.ok(ai.anglesFor('hype', 'sale', facts)[0] === 'teaser-led');
});

test('generation: three distinct options come back; unsupported claims and copied wording are dropped', async () => {
  const answer = (...t) => JSON.stringify({ options: t.map((x, i) => ({ angle: `a${i}`, text: x })) });
  const good = ['Clean lines, easy to wear, made for every day.', 'Cop the ASSET RAGLAN BOX FIT TEE and keep it simple.', 'Weekend plans sorted. Pick up the ASSET RAGLAN BOX FIT TEE 👇🏼'];
  const out = await ai.generate({ facts: VERIFIED, guidelines: '', examples: [], ruleKey: 'standard', copyType: 'core', call: async () => ({ text: answer('One tee, three completely different fits.', ...good, 'Our best-selling tee, now in 8 colourways.'), model: 'm' }) });
  assert.equal(out.options.length, 3);
  assert.ok(out.options.every((o) => !/three completely different fits|best-selling|colourways/i.test(o.text)));
  assert.equal(out.attempts, 1);
  assert.ok(out.dropped.length >= 2);
  // every candidate unsupported -> nothing is kept
  await assert.rejects(() => ai.generate({ facts: VERIFIED, guidelines: '', examples: [], ruleKey: 'standard', copyType: 'core', call: async () => ({ text: answer('One tee, three completely different fits.', 'Two fits, three colourways.', 'Heavy weight cotton, soft feel.'), model: 'm' }) }), (e) => e.code === 'rejected');
  // copying a reference
  const ref = 'Level up your wardrobe by adding statement tees and relaxed shorts to move with you wherever you go';
  const copied = await ai.generate({ facts: VERIFIED, guidelines: '', examples: [{ body: ref }], referenceTexts: [ref], ruleKey: 'standard', copyType: 'core', call: async () => ({ text: answer(`${ref}.`, ...good), model: 'm' }) });
  assert.equal(copied.options.length, 3); assert.ok(copied.options.every((o) => !o.text.startsWith('Level up')));
  // options that open the same way are not all shown
  const same = await ai.generate({ facts: VERIFIED, guidelines: '', examples: [], ruleKey: 'standard', copyType: 'core', call: async () => ({ text: answer('Cop the tee today and keep it simple always.', 'Cop the tee for the weekend, something else entirely.', 'Cop the tee with anything you own.', 'Wear it open over a plain white singlet.', 'Easy shape, easy day, easy to wear.'), model: 'm' }) });
  assert.equal(new Set(same.options.map((o) => text.contentWords(o.text).slice(0, 2).join(' '))).size, same.options.length);
  assert.equal(same.options.length, 3);
});

test('generation: refinement still returns one option through the same guard', async () => {
  const answer = (...t) => JSON.stringify({ options: t.map((x, i) => ({ angle: `a${i}`, text: x })) });
  const out = await ai.generate({ mode: 'refine', facts: VERIFIED, guidelines: '', examples: [], baseText: 'Keep it simple.', instruction: 'shorter', ruleKey: 'standard', copyType: 'core', call: async () => ({ text: answer('Simple. Easy.', 'Keep it simple.'), model: 'm' }) });
  assert.equal(out.options.length, 1);
  await assert.rejects(() => ai.generate({ mode: 'refine', facts: VERIFIED, guidelines: '', examples: [], baseText: 'x', instruction: 'make it special', ruleKey: 'standard', copyType: 'core', call: async () => ({ text: answer('Three completely different fits.', 'Two colourways only.'), model: 'm' }) }), (e) => e.code === 'rejected');
});

test('style notes: recurring phrases that state product details are left out of the prompt', () => {
  const analysis = lib.analyseTone([
    { family: 'core', body: 'Heavy weight cotton fleece. Cop yours today. Cop yours today' }, { family: 'core', body: 'Heavy weight cotton fleece, cop yours today.' },
    { family: 'core', body: 'Heavy weight cotton fleece. Cop yours today, shop now.' }, { family: 'core', body: 'Available in 8 colourways. Cop yours today' },
  ]);
  const t = lib.guidelinesText(analysis, null, ['core']);
  assert.doesNotMatch(t, /cotton|fleece|heavy weight|colourways/i);
  assert.match(t, /cop yours/i);
});

// ── 6. Wiring: approval behaviour and existing features ───────────────────────────────────────────────────────────
test('wiring: generation uses the effective copy type, saves it with the generation, and leaves approval alone', () => {
  const route = read('src/routes/copyAssistant.js');
  assert.match(route, /library\.selectExamples\(pre\.examples, \{\s*copyType,/);
  assert.match(route, /examples: examples\.map\(library\.promptExample\)/);
  assert.match(route, /copy_type, copy_type_source/);
  assert.match(route, /if \(loaded\.row\.status === 'approved'\) return res\.status\(409\)/);
  assert.match(route, /approve-primary-text|ai_draft_options/);
  const adSetup = read('src/routes/adSetup.js');
  assert.match(adSetup, /router\.post\('\/:id\/approve-primary-text'/); // untouched
  assert.match(adSetup, /primaryOk = !!row\.copy_set_id \|\| \(row\.selected_primary_text && \(row\.primary_text_approved \|\| !row\.primary_text_source\)\)/);
  const rules = read('src/lib/adCopyRules.js');
  assert.match(rules, /STANDARD_DESCRIPTION = 'Elevate your everyday'/);
});

test('UI: the Copy Type selector, reset, References used and the library check exist', () => {
  const app = read('public/app.js');
  for (const name of ['adSetupCopyTypeHtml', 'adSetupReferencesHtml', 'setAdSetupCopyType', 'checkCopyLibrary']) assert.match(app, new RegExp(`function ${name}\\(`));
  assert.match(app, /Reset to automatic/); assert.match(app, /References used \(/); assert.match(app, /Automatic \(\$\{escapeHtml\(ct\.auto\.label\)\}\)/);
  assert.match(app, /method: 'PUT', body: JSON\.stringify\(\{ copy_type: value \|\| null \}\)/);
  assert.match(app, /Give me another three/); assert.match(app, /refineAdSetupCopy/); assert.match(app, /Approve Primary Text/);
  assert.doesNotMatch(app.slice(app.indexOf('function adSetupReferencesHtml'), app.indexOf('async function setAdSetupCopyType')), /prompt|system|api[_-]?key/i, 'the References panel never shows prompts or credentials');
});
