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
  const f = fam([{ style_code: 'W26DD001BLK', launchDate: d('2026-03-01'), qty: 0 }]);
  assert.equal(f.status, 'launched'); assert.equal(f.basis, 'launch_date'); assert.equal(f.confidence, 'date_only');
  assert.equal(fam([{ style_code: 'W26DD001BLK', launchDate: d('2026-03-01'), qty: 12 }]).confidence, 'confirmed', 'a past date with sales is the strongest signal');
});
test('a planned date that passed only days ago with nothing sold is NOT assumed live: unknown, to be verified', () => {
  const f = fam([{ style_code: 'W26DE001BLK', launchDate: d('2026-10-08'), qty: 0, months: {} }]);
  assert.equal(f.status, 'unknown'); assert.equal(f.needs_check, true); assert.match(f.detail, /does not prove it went live/);
  assert.equal(fam([{ style_code: 'W26DE001BLK', launchDate: d('2026-10-08'), qty: 5, months: { '2026-10': 5 } }]).status, 'launched', 'but once it has sold it is plainly on sale');
  assert.equal(fam([{ style_code: 'W26DE001BLK', launchDate: d('2026-10-08'), qty: 0, months: {} }], {}, L.fromConfig({ launch_settle_days: 0 })).status, 'launched', 'the settle window is configurable');
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
  const f = fam([{ style_code: 'W26EE001BLK', launchDate: d('2026-01-01'), qty: 500, drop }]);
  assert.equal(f.status, 'unlaunched'); assert.equal(f.in_upcoming_drop, true); assert.match(f.detail, /Upcoming Drops/);
  assert.equal(fam([{ style_code: 'W26EE001BLK', launchDate: null, qty: 0, drop: { launch_date: '2026-06-01' } }]).status, 'launched', 'a past drop = launched');
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
  const f = fam([{ style_code: 'W26GG001BLK', launchDate: d('2026-02-01') }, { style_code: 'W26GG001WHT', launchDate: d('2026-12-01') }]);
  assert.equal(f.status, 'launched'); assert.match(f.detail, /1 colourway\(s\) have not launched/);
  assert.equal(f.by_style.find((x) => x.style_code === 'W26GG001WHT').status, 'unlaunched');
  const all = fam([{ style_code: 'W26GH001BLK', launchDate: d('2026-12-01') }, { style_code: 'W26GH001WHT', launchDate: d('2026-12-01') }]);
  assert.equal(all.status, 'unlaunched');
});
test('upcoming restock: launched, out or low, with a real order on the way', () => {
  const base = [{ style_code: 'W26HH001BLK', launchDate: d('2026-01-01') }];
  const f = fam(base, { stock: { known: true, units: 5 }, onOrder: 120 });
  assert.equal(f.status, 'upcoming_restock'); assert.equal(f.eligible, true); assert.equal(f.restock, true);
  assert.equal(fam(base, { stock: { known: true, units: 5 }, onOrder: 10 }).status, 'launched');
  assert.equal(fam(base, { stock: { known: true, units: 500 }, onOrder: 500 }).status, 'launched');
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
