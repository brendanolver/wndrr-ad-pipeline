// Batch 12 + 13: launch status. Unlaunched products stay out of Core / High Stocks; stock, zero sales, sales alone, a passing planned date or "never had creative" never
// prove a launch. Every input is a fixture; nothing here is live data.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/lib/launchStatus');
const AM = require('../src/lib/apparelmagic');
const LI = require('../src/lib/launchInputs');
const TODAY = '2026-10-12';
const fam = (styles, extra = {}, cfg) => L.assessFamily({ styles, ...extra }, TODAY, cfg);
const V = (o = {}) => L.fromConfig({ launch_date_verified: 1, ...o }); // WNDRR has confirmed mid_code is the official launch date (the default)
const U = (o = {}) => L.fromConfig({ launch_date_verified: 0, ...o }); // the confirmation withdrawn: the date field treated as unverified
const d = (s) => new Date(`${s}T00:00:00Z`);

// ── ApparelMagic launch dates: reading the field ──────────────────────────────────────
test('launch date parsing is strict: only real calendar dates in known formats; untidy values are UNREADABLE, never guessed (no invented year)', () => {
  const iso = (v) => { const x = AM.parseLaunchDate(v); return x ? `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}` : null; };
  assert.equal(iso('30-07-26'), '2026-07-30'); assert.equal(iso('30/07/2026'), '2026-07-30'); assert.equal(iso('2026-11-01'), '2026-11-01'); assert.equal(iso('1 Nov 2026'), '2026-11-01');
  assert.equal(iso('01-Nov-26'), '2026-11-01'); assert.equal(iso('Nov 1, 2026'), '2026-11-01');
  for (const bad of ['1 Nov', 'Nov 2026', '31/02/2026', '2001-01-01', 'TBC', 'soon', '0', '', null, undefined]) assert.equal(AM.parseLaunchDate(bad), null, `${bad} is unreadable`);
});

test('a future ApparelMagic launch date = unlaunched (excluded), even with lots of stock', () => {
  const f = fam([{ style_code: 'W26AA001BLK', launchDate: d('2026-11-01'), qty: 0 }], { stock: { known: true, units: 400 } });
  assert.equal(f.status, 'unlaunched'); assert.equal(f.eligible, false); assert.match(f.detail, /still ahead/); assert.equal(f.confidence, 'confirmed');
});
test('a PAST launch date = launched, and zero sales do not change that once the date has settled', () => {
  const f = fam([{ style_code: 'W26DD001BLK', launchDate: d('2026-03-01'), qty: 0 }], {}, V());
  assert.equal(f.status, 'launched'); assert.equal(f.basis, 'launch_date'); assert.equal(f.confidence, 'date_only');
  assert.equal(fam([{ style_code: 'W26DD001BLK', launchDate: d('2026-03-01'), qty: 12 }], {}, V()).confidence, 'confirmed', 'a past date with sales is the strongest signal');
});
test('OPTIONAL settle check (off by default): when switched on, a date that passed only days ago with nothing sold is NOT assumed live: unknown, to be verified', () => {
  const f = fam([{ style_code: 'W26DE001BLK', launchDate: d('2026-10-08'), qty: 0, months: {} }], {}, V({ launch_settle_days: 21 }));
  assert.equal(f.status, 'unknown'); assert.equal(f.needs_check, true); assert.match(f.detail, /does not prove it went live/);
  assert.equal(fam([{ style_code: 'W26DE001BLK', launchDate: d('2026-10-08'), qty: 5, months: { '2026-10': 5 } }], {}, V()).status, 'launched', 'but once it has sold it is plainly on sale');
  assert.equal(fam([{ style_code: 'W26DE001BLK', launchDate: d('2026-10-08'), qty: 0, months: {} }]).status, 'launched', 'by default (settle check off) an official date that has passed means launched');
});
test('an unreadable launch date is UNKNOWN (flagged), never treated as past or future', () => {
  const f = fam([{ style_code: 'W26DF001BLK', launchDate: null, launchDateRaw: '1 Nov', launchDateReadable: false, qty: 300 }]);
  assert.equal(f.status, 'unknown'); assert.equal(f.basis, 'unreadable_date'); assert.match(f.detail, /cannot be read/);
});

// ── no date: sales / stock / zero sales are not proof ─────────────────────────────────
test('stock alone proves nothing: no date, no drop, no sales -> UNKNOWN and flagged', () => {
  const f = fam([{ style_code: 'W26BB001BLK', launchDate: null, qty: null }], { stock: { known: true, units: 900 } });
  assert.equal(f.status, 'unknown'); assert.equal(f.needs_check, true); assert.equal(f.eligible, false); assert.match(f.detail, /Stock alone does not prove it/);
  assert.equal(fam([{ style_code: 'W26BB001BLK', launchDate: null, qty: 0 }]).status, 'unknown', 'zero sales is not evidence of "unlaunched" either');
});
test('Batch 13: SALES ALONE no longer confirm a launch (pre-launch, staff and seeding orders look the same): unknown until a person confirms or the setting allows it', () => {
  const sold = [{ style_code: 'W26CC001BLK', launchDate: null, qty: 160, months: { '2026-08': 60, '2026-09': 100 } }];
  const f = fam(sold);
  assert.equal(f.status, 'unknown'); assert.equal(f.basis, 'sales_only'); assert.equal(f.eligible, false); assert.match(f.detail, /160 units have sold since 2026-08/); assert.match(f.detail, /do not prove a launch/);
  assert.equal(fam(sold, {}, L.fromConfig({ launch_sales_confirms: 1 })).status, 'launched', 'allowed by the setting: sustained sales then count');
  assert.equal(fam([{ style_code: 'W26CC001BLK', launchDate: null, qty: 3 }], {}, L.fromConfig({ launch_sales_confirms: 1 })).status, 'unknown', 'a handful of units is never enough');
});
test('a product in the ApparelMagic CORE group is an established range: launched unless a date or drop says otherwise', () => {
  assert.equal(fam([{ style_code: 'W26CO001BLK', launchDate: null, qty: 0, isCore: true }]).status, 'launched');
  assert.equal(fam([{ style_code: 'W26CO001BLK', launchDate: d('2026-12-01'), qty: 0, isCore: true }]).status, 'unlaunched', 'a future date still wins');
});

// ── Upcoming Drops, conflicts, overrides ───────────────────────────────────────────────
test('an upcoming drop wins over a past ApparelMagic date and sales: unlaunched, "handled in Upcoming Drops"', () => {
  const drop = { launch_date: '2026-10-20', name: 'Drop 24' };
  const f = fam([{ style_code: 'W26EE001BLK', launchDate: d('2026-01-01'), qty: 500, drop }], {}, V());
  assert.equal(f.status, 'unlaunched'); assert.equal(f.in_upcoming_drop, true); assert.match(f.detail, /Upcoming Drops/);
  assert.equal(fam([{ style_code: 'W26EE001BLK', launchDate: null, qty: 0, drop: { launch_date: '2026-06-01', name: 'Drop 20' } }]).status, 'launched', 'a past NAMED drop (made by a person) = launched');
});
test('conflicting signals: a future ApparelMagic date beats sales; a manual override beats everything; Shopify DRAFT beats a past date', () => {
  assert.equal(fam([{ style_code: 'W26CF001BLK', launchDate: d('2026-12-01'), qty: 900, months: { '2026-09': 900 } }]).status, 'unlaunched');
  const o = fam([{ style_code: 'W26CF002BLK', launchDate: d('2026-12-01'), qty: 0, override: { status: 'launched', note: 'soft launch to VIPs' } }]);
  assert.equal(o.status, 'launched'); assert.equal(o.basis, 'manual'); assert.match(o.detail, /soft launch to VIPs/);
  assert.equal(fam([{ style_code: 'W26CF003BLK', launchDate: d('2026-03-01'), qty: 20, shopify: { status: 'DRAFT', published_at: null } }]).status, 'unlaunched');
  assert.equal(fam([{ style_code: 'W26CF004BLK', launchDate: d('2026-03-01'), qty: 20, shopify: { status: 'ARCHIVED', published_at: '2026-04-01' } }]).status, 'discontinued');
});
test('Shopify (when supplied) corroborates but never overrides a future date; an ACTIVE published listing confirms a product with no date', () => {
  const live = { status: 'ACTIVE', published_at: '2026-08-24T23:01:58Z' };
  assert.equal(fam([{ style_code: 'W26SH001BLK', launchDate: null, qty: 0, shopify: live }]).status, 'launched');
  assert.equal(fam([{ style_code: 'W26SH002BLK', launchDate: d('2026-12-01'), qty: 0, shopify: live }]).status, 'unlaunched', 'a future ApparelMagic date still wins');
});
test('manual override wins and is explained; discontinued is excluded', () => {
  const d1 = fam([{ style_code: 'W26FF001BLK', qty: 90 }], { familyOverride: { status: 'discontinued' } });
  assert.equal(d1.status, 'discontinued'); assert.equal(d1.eligible, false);
});

// ── colourways, restock, evidence ──────────────────────────────────────────────────────
test('colourways are judged one by one: launched + unlaunched colour = launched, the unlaunched colour is noted and left out', () => {
  const f = fam([{ style_code: 'W26GG001BLK', launchDate: d('2026-02-01') }, { style_code: 'W26GG001WHT', launchDate: d('2026-12-01') }], {}, V());
  assert.equal(f.status, 'launched'); assert.match(f.detail, /1 colourway\(s\) have not launched/);
  assert.equal(f.by_style.find((x) => x.style_code === 'W26GG001WHT').status, 'unlaunched');
  const all = fam([{ style_code: 'W26GH001BLK', launchDate: d('2026-12-01') }, { style_code: 'W26GH001WHT', launchDate: d('2026-12-01') }]);
  assert.equal(all.status, 'unlaunched');
});
test('upcoming restock: launched, out or low, with a real order on the way', () => {
  const base = [{ style_code: 'W26HH001BLK', launchDate: d('2026-01-01') }];
  const f = fam(base, { stock: { known: true, units: 5 }, onOrder: 120 }, V());
  assert.equal(f.status, 'upcoming_restock'); assert.equal(f.eligible, true); assert.equal(f.restock, true);
  assert.equal(fam(base, { stock: { known: true, units: 5 }, onOrder: 10 }, V()).status, 'launched');
  assert.equal(fam(base, { stock: { known: true, units: 500 }, onOrder: 500 }, V()).status, 'launched');
});
test('no colourways -> unknown; and every verdict carries the full evidence list (what was found, including what was missing)', () => {
  assert.equal(fam([]).status, 'unknown');
  const f = fam([{ style_code: 'W26EV001BLK', launchDate: null, qty: 40, months: { '2026-09': 40 }, drop: null }]);
  const ev = f.by_style[0].evidence;
  assert.ok(ev.some((e) => e.source === 'apparelmagic_date' && /no launch date/.test(e.text)) && ev.some((e) => e.source === 'sales' && /pre-launch, staff or seeding/.test(e.text)), 'the diagnostics can show every signal');
});
test('launchInputs builds the same evidence from the catalogue for every caller (readable flag, months, CORE, drop, override)', () => {
  const amDetails = new Map([['W26IN001BLK', { launchDate: null, launchDateRaw: '1 Nov', isCore: false }], ['W26IN002BLK', { launchDate: d('2026-03-01'), launchDateRaw: '01-03-26', launchDateReadable: true, isCore: true }]]);
  const salesByStyle = new Map([['W26IN002BLK', { qty365: 50, months: { '2026-04': 50 } }]]);
  const a = LI.forStyle('W26IN001BLK', { amDetails, salesByStyle, drops: new Map(), overrides: new Map() });
  assert.equal(a.launchDateReadable, false); assert.equal(a.qty, 0);
  const b = LI.forStyle('W26IN002BLK', { amDetails, salesByStyle, drops: new Map([['W26IN002BLK', { launch_date: '2026-11-01' }]]), overrides: new Map([['W26IN002BLK', { status: 'launched' }]]) });
  assert.equal(b.isCore, true); assert.equal(b.qty, 50); assert.deepEqual(b.months, { '2026-04': 50 }); assert.equal(b.drop.launch_date, '2026-11-01'); assert.equal(b.override.status, 'launched');
  assert.equal(LI.forStyle('W26IN001BLK', { amDetails, salesByStyle: null }).qty, null, 'sales unavailable = unknown, not zero');
});

// ── the confirmation withdrawn: ApparelMagic date field treated as unverified (setting launch_date_verified = 0, NOT the default) ──────
test('IF the confirmation is withdrawn (launch_date_verified = 0): a PASSED ApparelMagic date is NOT proof of launch (the field may be a planned delivery / buy date): unknown, sent to verification, never recommended', () => {
  const f = fam([{ style_code: 'W26IA006BLK', launchDate: d('2026-08-24'), launchDateRaw: '24-08-26', launchDateReadable: true, qty: 57, months: { '2026-08': 20, '2026-09': 37 } }], {}, U());
  assert.equal(f.status, 'unknown'); assert.equal(f.basis, 'unverified_date'); assert.equal(f.eligible, false); assert.equal(f.needs_check, true);
  assert.match(f.detail, /not been verified as the official launch date/); assert.match(f.detail, /early availability looks the same/);
  const ev = f.by_style[0].evidence.find((e) => e.source === 'apparelmagic_date');
  assert.equal(ev.verdict, 'unverified'); assert.match(ev.text, /NOT verified/);
});
test('IF withdrawn: a FUTURE ApparelMagic date still keeps the product out (the safe direction), and sales never override it', () => {
  const f = fam([{ style_code: 'W26KA901BLK', launchDate: d('2026-11-15'), qty: 300, months: { '2026-09': 300 } }], {}, U());
  assert.equal(f.status, 'unlaunched'); assert.equal(f.eligible, false);
});
test('IF withdrawn: other evidence still works without the date field: manual status, Shopify published, CORE group, a NAMED past drop; an UNNAMED drop (auto-made from the date field) does not', () => {
  assert.equal(fam([{ style_code: 'W26IA006BLK', launchDate: d('2026-08-24'), override: { status: 'launched' } }], {}, U()).status, 'launched');
  assert.equal(fam([{ style_code: 'W26IA006BLK', launchDate: d('2026-08-24'), shopify: { status: 'ACTIVE', published_at: '2026-08-24T23:02:00Z' } }], {}, U()).status, 'launched');
  assert.equal(fam([{ style_code: 'W26CO001BLK', launchDate: d('2026-01-01'), isCore: true }], {}, U()).status, 'launched');
  assert.equal(fam([{ style_code: 'W26ND001BLK', launchDate: null, drop: { launch_date: '2026-06-01', name: 'Summer Drop' } }], {}, U()).status, 'launched');
  const unnamed = fam([{ style_code: 'W26UD001BLK', launchDate: null, drop: { launch_date: '2026-06-01', name: null } }], {}, U());
  assert.equal(unnamed.status, 'unknown'); assert.match(unnamed.detail, /unnamed drop/);
});
test('the setting is registered, bounded and ON by default (WNDRR confirmed mid_code is the official launch date); withdrawing it turns date-based launches back into verification', () => {
  const C = require('../src/lib/creativePlanningConfig');
  assert.equal(C.DEFAULTS.launch_date_verified, 1); assert.deepEqual(C.LIMITS.launch_date_verified, [0, 1]); assert.match(C.LABEL.launch_date_verified, /OFFICIAL launch date/);
  assert.equal(C.DEFAULTS.launch_settle_days, 0, 'the optional settle check is off by default');
  assert.equal(L.fromConfig({}).date_verified, true); assert.equal(L.fromConfig({ launch_date_verified: 0 }).date_verified, false);
  assert.equal(L.fromConfig({}).settle_days, 0);
  assert.equal(fam([{ style_code: 'W26VV001BLK', launchDate: d('2026-03-01'), qty: 20 }]).status, 'launched', 'default config: a passed official date = launched');
  assert.equal(fam([{ style_code: 'W26VV001BLK', launchDate: d('2026-03-01'), qty: 20 }], {}, U()).status, 'unknown');
  // a stored production setting is respected exactly as stored (nothing is rewritten): an explicit 0 stays 0
  assert.equal(C.resolve({ launch_date_verified: 0, launch_settle_days: 14 }).config.launch_date_verified, 0);
  assert.equal(C.resolve({ launch_settle_days: 14 }).config.launch_settle_days, 14);
  assert.equal(C.resolve({}).config.launch_date_verified, 1);
});

// ── the five products (Loan Shark, Revival, Slammed, Hexed, Faction) ───────────────────
// FIXTURES, NOT LIVE DATA. Style codes, colourways, Shopify publish dates and sales are the real ones read from Shopify on 12 Oct 2026; the ApparelMagic mid_code values are
// HYPOTHETICAL stand-ins (the real values are not readable from this environment). They prove the RULE: with an official future date, neither a published Shopify listing nor sales
// history can bring the product back, whatever the date turns out to be; with a past date it is launched; missing/invalid goes to verification.
const FIVE = [
  ['LOAN SHARK BOX FIT TEE', [['W26IA006BLK', '2026-08-24T23:02:00Z', 40], ['W26IA006WHI', '2026-08-24T23:01:58Z', 14]]],
  ['REVIVAL HEAVY WEIGHT TEE', [['W26HA009FBK', '2026-08-10T01:24:38Z', 90], ['W26HA009MOG', '2026-08-10T01:24:36Z', 72]]],
  ['SLAMMED BOX FIT TEE', [['W26HA002BLK', '2026-08-10T01:24:27Z', 104], ['W26HA002WHI', '2026-08-10T01:24:25Z', 48]]],
  ['HEXED BOX FIT TEE', [['W26IA004NAV', '2026-08-24T23:01:53Z', 51], ['W26IA004WHI', '2026-08-24T23:01:50Z', 69]]],
  ['FACTION BOX FIT TEE', [['W26IA020FBK', '2026-08-31T00:36:51Z', 34]]],
];
const five = (dateFor, extra = {}) => FIVE.map(([name, cws]) => [name, fam(cws.map(([code, pub, units]) => ({
  style_code: code, launchDate: dateFor(code), launchDateRaw: dateFor(code) ? 'x' : null, launchDateReadable: dateFor(code) ? true : null, qty: units, months: { '2026-08': Math.round(units / 3), '2026-09': Math.round(units * 2 / 3) },
  shopify: { status: 'ACTIVE', published_at: pub }, ...extra })), { stock: { known: true, units: 200 } })]);
test('FIVE PRODUCTS, official date in the FUTURE: all excluded even though Shopify has them published and ACTIVE and they have sold (Shopify and sales never override the official date)', () => {
  for (const [name, f] of five(() => d('2026-11-02'))) {
    assert.equal(f.status, 'unlaunched', name); assert.equal(f.eligible, false, name); assert.equal(f.basis, 'launch_date', name); assert.match(f.detail, /still ahead/, name);
    assert.ok(f.by_style.every((s) => s.status === 'unlaunched'), `${name}: every colourway`);
  }
});
test('FIVE PRODUCTS, official date has PASSED: launched, eligible for recommendations', () => {
  for (const [name, f] of five(() => d('2026-08-10'))) { assert.equal(f.status, 'launched', name); assert.equal(f.eligible, true, name); assert.equal(f.basis, 'launch_date', name); }
});
test('FIVE PRODUCTS, official date MISSING: sales and a published Shopify listing do not prove it (Shopify ACTIVE corroborates only where supplied); with no Shopify input they go to verification', () => {
  for (const [name, f] of five(() => null, { shopify: null })) { assert.equal(f.status, 'unknown', name); assert.equal(f.needs_check, true, name); assert.equal(f.eligible, false, name); }
});
test('FIVE PRODUCTS, date INVALID text: verification workflow, never guessed', () => {
  const inv = FIVE.map(([name, cws]) => [name, fam(cws.map(([code, pub, units]) => ({ style_code: code, launchDate: null, launchDateRaw: 'TBC', launchDateReadable: false, qty: units, shopify: { status: 'ACTIVE', published_at: pub } })))]);
  for (const [name, f] of inv) { assert.equal(f.status, 'unknown', name); assert.equal(f.basis, 'unreadable_date', name); assert.match(f.detail, /cannot be read/, name); }
});
test('FIVE PRODUCTS, COLOURWAY level: one colourway future (e.g. Hexed Navy later than White) and one passed: the product is launched, the future colourway is left out and named', () => {
  const f = fam([
    { style_code: 'W26IA004WHI', launchDate: d('2026-08-24'), qty: 69, shopify: { status: 'ACTIVE', published_at: '2026-08-24T23:01:50Z' } },
    { style_code: 'W26IA004NAV', launchDate: d('2026-11-02'), qty: 51, shopify: { status: 'ACTIVE', published_at: '2026-08-24T23:01:53Z' } },
  ]);
  assert.equal(f.status, 'launched'); assert.equal(f.by_style.find((x) => x.style_code === 'W26IA004NAV').status, 'unlaunched'); assert.equal(f.by_style.find((x) => x.style_code === 'W26IA004WHI').status, 'launched'); assert.match(f.detail, /1 colourway\(s\) have not launched/);
});
test('manual overrides still win over the official date, both ways ("subject to existing manual overrides")', () => {
  assert.equal(fam([{ style_code: 'W26IA006BLK', launchDate: d('2026-11-02'), override: { status: 'launched', note: 'on sale early' } }]).status, 'launched');
  assert.equal(fam([{ style_code: 'W26IA006BLK', launchDate: d('2026-08-24'), override: { status: 'unlaunched', note: 'held back' } }]).status, 'unlaunched');
});
