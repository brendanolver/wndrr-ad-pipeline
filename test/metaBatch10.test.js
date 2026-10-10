// Pure tests for batch 10: name-copy duplicate recognition, giveaway / non-product wording, the simplified Ad Matching page, and the
// percentage-based performance colours. (The database behaviour and the browser flows are covered by the sandbox suites b10-db / b10-ui.)
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const NC = require('../src/lib/metaNameCopies');
const parsing = require('../src/lib/metaNameParsing');
const health = require('../src/lib/metaFunnelHealth');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const code = (f) => read(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ── Part 1: name normalisation ───────────────────────────────────────────
test('copy suffixes: only a recognised TRAILING " - Copy [N]" is removed (hyphen / en dash / em dash, any case or spacing)', () => {
  const b = (n) => NC.normaliseAdName(n).base;
  for (const n of ['Hero - Copy', 'Hero - Copy 2', 'Hero – Copy', 'Hero – Copy 3', 'Hero — copy', 'Hero  -  COPY  12', 'Hero \t- Copy', 'Hero - Copy 2', 'Hero − Copy', 'Hero - Copy2']) assert.equal(b(n), 'Hero', JSON.stringify(n));
  assert.equal(b('  Hero - Copy  '), 'Hero', 'surrounding whitespace is trimmed');
  assert.equal(NC.normaliseAdName('Hero - Copy - Copy 2').stripped, 2);
  assert.equal(b('Hero - Copy - Copy 2'), 'Hero', 'repeated suffixes are all removed');
});
test('copy suffixes: anything that is not that exact trailing pattern is left alone', () => {
  const same = ['Hero Copy', 'Hero-Copy', 'Hero -Copy', 'Hero- Copy', 'Copy of Hero', 'Hero (Copy)', 'Hero - Copy of A', 'Hero - Copy 2 final', 'Hero - Copy 1234', 'Hero - Copyright', 'Hero - Copies', 'Hero_Copy', 'Hero - Copy v2', '- Copy', ' - Copy', 'Copy'];
  for (const n of same) assert.equal(NC.normaliseAdName(n).base, n.trim(), JSON.stringify(n));
  assert.equal(NC.normaliseAdName(null).base, '');
  assert.equal(NC.normaliseAdName(undefined).stripped, 0);
});
test('name matching is EXACT after the suffix: case, internal spacing, extra characters and similar names all matter', () => {
  const same = (a, b) => NC.baseOf(a) === NC.baseOf(b);
  assert.ok(same('Hero A', 'Hero A - Copy') && same('Hero A - Copy', 'Hero A – Copy 3') && same('Hero A - Copy 2', 'Hero A'));
  for (const other of ['hero a', 'Hero  A', 'Hero A2', 'Hero', 'Hero A!', 'Hero A copy x', 'Hero B', 'Hero Aa - Copy']) assert.ok(!same('Hero A - Copy', other), other);
  assert.ok(!same('Summer Hoodie Video', 'Summer Hoodie Videos - Copy'), 'similar product names never match');
  assert.ok(!same('Core Everyday Hoodie - Alt Angle', 'Core Everyday Hoodie'), 'a shared product prefix is not a match');
});
test('the module is exact string logic only: no similarity, no Meta, no ApparelMagic', () => {
  const src = code('src/lib/metaNameCopies.js');
  assert.doesNotMatch(src, /jaccard|levenshtein|similarity|ILIKE|metaAds|graph\.facebook|fetch\(|apparelmagic/i);
});

// ── Part 1: grouping logic (pure) ────────────────────────────────────────
const ad = (id, name, creative, o = {}) => ({ meta_ad_id: id, ad_name: name, meta_creative_id: creative, match_status: o.status || 'suggested', eligible: o.eligible !== undefined ? o.eligible : true, ineligible_reason: o.why || null, nps: !!o.nps, codes: o.codes || '', concept_key: o.concept || '' });
const src = (key, sig = 'p|P1', concept = '', hasSuffix = false) => ({ key, hasSuffix, decision: { state: 'source', sig, concept } });
test('classifyCopies: unclassified copies are eligible, one per creative; the source creative is never re-offered', () => {
  const ads = [ad('o', 'X', 'c0', { status: 'confirmed', eligible: false }), ad('o2', 'X - Copy 9', 'c0'), ad('a', 'X - Copy', 'c1'), ad('b', 'X – Copy 2', 'c2'), ad('b2', 'X – Copy 2', 'c2')];
  const r = NC.classifyCopies(ads, new Map(), src('c0'));
  assert.deepEqual(r.eligible.map((g) => g.rep).sort(), ['a', 'b']);
  assert.equal(r.eligible.find((g) => g.rep === 'b').ads_total, 2, 'a creative with two ads is ONE copy');
  assert.equal(r.eligible.find((g) => g.rep === 'b').ads_eligible, 2);
});
test('classifyCopies: copies a person already decided are not offered; different decisions are surfaced as conflicts', () => {
  const ads = [ad('same', 'X - Copy', 'c1', { status: 'confirmed', eligible: false }), ad('diff', 'X - Copy 2', 'c2', { status: 'confirmed', eligible: false }), ad('conf', 'X - Copy 3', 'c3'), ad('free', 'X - Copy 4', 'c4')];
  const human = new Map([['c1', NC.humanState([{ nps: false, codes: 'P1', concept_key: '' }])], ['c2', NC.humanState([{ nps: false, codes: 'P2', concept_key: '' }])], ['c3', { state: 'conflict' }]]);
  const r = NC.classifyCopies(ads, human, src('c0'));
  assert.deepEqual(r.eligible.map((g) => g.rep), ['free']);
  assert.deepEqual(r.already_same.map((g) => g.key), ['c1']);
  assert.deepEqual(r.conflicts.map((g) => g.key).sort(), ['c2', 'c3']);
  assert.equal(r.eligible.length + r.already_same.length + r.conflicts.length, 4, 'every copy is accounted for exactly once');
});
test('classifyCopies: protected copies (skipped / excluded / rejected / linked) are never eligible; a creative with a person-decided ad is decided as a whole', () => {
  const ads = [ad('s', 'X - Copy', 'c1', { eligible: false, why: 'skipped' }), ad('e', 'X - Copy 2', 'c2', { eligible: false, why: 'excluded' }), ad('mixed1', 'X - Copy 3', 'c3', { eligible: false, why: 'skipped' }), ad('mixed2', 'X - Copy 3', 'c3')];
  const r = NC.classifyCopies(ads, new Map(), src('c0'));
  assert.deepEqual(r.protected.map((g) => g.reason).sort(), ['excluded', 'skipped']);
  assert.deepEqual(r.eligible.map((g) => g.rep), ['mixed2'], 'a creative with at least one unowned ad is offered through that ad (its own skipped ad is not touched)');
});
test('classifyCopies: a machine auto-match that agrees needs nothing; one that disagrees is a conflict, never overwritten', () => {
  const ads = [ad('ok', 'X - Copy', 'c1', { status: 'auto_matched', codes: 'P1' }), ad('bad', 'X - Copy 2', 'c2', { status: 'auto_matched', codes: 'P2' })];
  const r = NC.classifyCopies(ads, new Map(), src('c0', 'p|P1'));
  assert.deepEqual(r.already_same.map((g) => g.key), ['c1']);
  assert.deepEqual(r.conflicts.map((g) => g.key), ['c2']);
  assert.equal(r.eligible.length, 0);
});
test('classifyCopies: ads without a creative id are each their own creative', () => {
  const ads = [ad('n1', 'X - Copy', null), ad('n2', 'X - Copy 2', null), ad('n0', 'X', null, { status: 'confirmed', eligible: false })];
  const r = NC.classifyCopies(ads, new Map(), src('ad:n0'));
  assert.deepEqual(r.eligible.map((g) => g.rep).sort(), ['n1', 'n2']);
});
test('an ACTUAL copy suffix is required: identically named ads with no Copy suffix are never grouped by name', () => {
  assert.equal(NC.hasCopySuffix('X - Copy'), true); assert.equal(NC.hasCopySuffix('X – Copy 3'), true);
  for (const n of ['X', 'X Copy', 'X-Copy', 'Copy of X', 'X (Copy)']) assert.equal(NC.hasCopySuffix(n), false, n);
  // two plain, identically named ads: nothing is offered, not even as already-same / conflict / protected
  const ads = [ad('o', 'X', 'c0', { status: 'confirmed', eligible: false }), ad('same1', 'X', 'c1'), ad('same2', 'X', 'c2'), ad('prot', 'X', 'c3', { eligible: false, why: 'skipped' })];
  const r = NC.classifyCopies(ads, new Map([['c3', NC.humanState([{ nps: false, codes: 'P9' }])]]), src('c0', 'p|P1', '', false));
  assert.deepEqual([r.eligible.length, r.already_same.length, r.conflicts.length, r.protected.length], [0, 0, 0, 0]);
});
test('the suffix rule is per pair: a copy of the source is offered, an identically named plain ad next to it is not', () => {
  const ads = [ad('o', 'X', 'c0', { status: 'confirmed', eligible: false }), ad('plain', 'X', 'c1'), ad('copy', 'X - Copy', 'c2')];
  const r = NC.classifyCopies(ads, new Map(), src('c0', 'p|P1', '', false));
  assert.deepEqual(r.eligible.map((g) => g.rep), ['copy']);
  // when the SOURCE is the copy, the plain original (and an identically named plain twin) are its candidates
  const r2 = NC.classifyCopies([ad('s', 'X - Copy', 'c0', { status: 'confirmed', eligible: false }), ad('p1', 'X', 'c1'), ad('p2', 'X', 'c2')], new Map(), src('c0', 'p|P1', '', true));
  assert.deepEqual(r2.eligible.map((g) => g.rep).sort(), ['p1', 'p2']);
  // a creative with several ads qualifies when ANY of its name-matching ads carries the suffix
  const r3 = NC.classifyCopies([ad('o', 'X', 'c0', { status: 'confirmed', eligible: false }), ad('a', 'X', 'c1'), ad('b', 'X - Copy 2', 'c1')], new Map(), src('c0', 'p|P1', '', false));
  assert.deepEqual(r3.eligible.map((g) => g.rep), ['a']);
});
test('suffix rule is applied in the live offer, the pre-fill and the preview (static)', () => {
  const m = code('src/lib/metaNameCopies.js');
  assert.match(m, /if \(!source\.hasSuffix && !group\.some\(\(a\) => hasCopySuffix\(a\.ad_name\)\)\) continue;/);
  assert.match(m, /const hasSuffix = ads\.some\(\(a\) => hasCopySuffix\(a\.ad_name\)\);\s*if \(!hasSuffix\) continue;/);
  assert.match(m, /meCopy \|\| ads\.some\(\(x\) => creativeKey\(x\) === creativeKey\(a\) && hasCopySuffix\(x\.ad_name\)\)/, 'pre-fill uses the same rule');
});

test('human decisions: concepts only conflict when BOTH are set and differ; product / Not-product-specific must match', () => {
  const a = { sig: 'p|P1', concept: 'styling' };
  assert.ok(NC.sameDecision(a, { sig: 'p|P1', concept: '' }) && NC.sameDecision({ sig: 'p|P1', concept: '' }, a) && NC.sameDecision(a, a));
  assert.ok(!NC.sameDecision(a, { sig: 'p|P1', concept: 'try on' }));
  assert.ok(!NC.sameDecision(a, { sig: 'p|P2', concept: 'styling' }));
  assert.ok(!NC.sameDecision(a, { sig: 'nps|', concept: 'styling' }));
  assert.equal(NC.humanState([]).state, 'none');
  assert.equal(NC.humanState([{ nps: false, codes: 'P1' }, { nps: false, codes: 'P2' }]).state, 'conflict');
  assert.equal(NC.humanState([{ nps: false, codes: 'P1', concept_key: 'a' }, { nps: false, codes: 'P1', concept_key: 'b' }]).state, 'conflict');
});
test('the offer summary carries only what the prompt needs and never more than a handful of names', () => {
  const found = { base: 'X', eligible: Array.from({ length: 9 }, (_, i) => ({ rep: `r${i}`, rep_name: `X - Copy ${i}`, ads_total: 1, ads_eligible: 1 })), already_same: [1], conflicts: [{ ads: [{ meta_ad_id: 'c', ad_name: 'X - Copy 99' }], why: 'w' }], protected: [] };
  const s = NC.offerSummary(found);
  assert.equal(s.eligible_creatives, 9); assert.equal(s.copy_ids.length, 9); assert.equal(s.copies.length, 6); assert.equal(s.conflict_count, 1);
  assert.equal(NC.offerSummary(null), null);
});

// ── Part 1: wiring / safety (static) ─────────────────────────────────────
test('confirm path: the guarded options exist, the offer is opt-in, and a normal confirmation is unchanged', () => {
  const lib = code('src/lib/metaAdMatching.js');
  const fn = lib.slice(lib.indexOf('async function confirmMapping('), lib.indexOf('async function confirmWithCopyOffer'));
  assert.match(fn, /async function confirmMapping\(metaAdId, body, userId, opts = \{\}\)/);
  assert.match(fn, /if \(opts\.requireEligible\) \{[\s\S]*?creativeIdentity\.eligibleSql\(HUMAN_OWNED_SQL\)[\s\S]*?not_eligible/, 'eligibility re-checked under the row lock');
  assert.match(fn, /creative_decided/, 'a creative a person already decided is protected');
  assert.match(fn, /typeof opts\.afterWrite === 'function'\) await opts\.afterWrite\(client\);\s*await client\.query\('COMMIT'\)/, 'the audit row is written in the same transaction');
  assert.match(lib, /body && body\.offer_name_copies === true/, 'the offer is only computed when asked for');
  const route = code('src/routes/metaAdMatching.js');
  assert.match(route, /router\.use\(requireAdmin\)/);
  assert.match(route, /confirmWithCopyOffer\(adId\(req\)/);
  assert.match(route, /apply-name-copies/);
  assert.match(route, /name-copies\/preview/);
});
test('applying needs an explicit list of copies and re-derives eligibility server-side; the source classification is read from the database', () => {
  const src2 = code('src/lib/metaNameCopies.js');
  assert.match(src2, /Choose the copies to apply the classification to/);
  assert.match(src2, /eligibleByRep\.get\(id\)/, 'only copies that are CURRENTLY eligible AND were sent are applied');
  assert.match(src2, /pg_advisory_lock/, 'serialised per name');
  assert.match(src2, /ad_setup_id: null/, 'the instance-specific Ad Setup link is never copied');
  assert.match(src2, /rapid: true/, 'the existing rapid confirm path (no trusted-pair re-evaluation)');
  assert.match(src2, /sourcePayload\(pool, sourceAdId\)/, 'the classification comes from the stored source, not from the client');
});
test('schema: one additive audit table, no drops / deletes / alters of anything existing', () => {
  const sql = read('db/schema.sql');
  const block = sql.slice(sql.indexOf('-- Name-copy duplicates (Ad Matching)'), sql.indexOf('-- Approved Ad Matching concepts'));
  assert.match(block, /CREATE TABLE IF NOT EXISTS meta_name_copy_applications/);
  assert.doesNotMatch(block, /\b(DROP|DELETE FROM|TRUNCATE|UPDATE |ALTER TABLE)/i);
  assert.match(block, /CREATE INDEX IF NOT EXISTS/);
});
test('review modal: the offer is a separate, explicit step -- Enter / Space never decide it, A / S do, and a held key is ignored', () => {
  const app = code('public/app.js');
  assert.match(app, /payload\.offer_name_copies = true/);
  assert.match(app, /if \(offer && offer\.eligible_creatives > 0 && !s\.resolvedBases\.has\(offer\.base\)\) \{ mmSessOfferShow\(id, offer\); return ok; \}/, 'no offer -> straight to the next creative, exactly as before');
  const kb = app.slice(app.indexOf("document.addEventListener('keydown', (e) => {\n  const s = mmRv.sess;"));
  const offerBranch = kb.slice(0, kb.indexOf('if (!s || !s.ctx || e.key'));
  assert.match(offerBranch, /e\.repeat/);
  assert.match(offerBranch, /e\.key === 'a' \|\| e\.key === 'A'/);
  assert.match(offerBranch, /e\.key === 's' \|\| e\.key === 'S'/);
  assert.match(offerBranch, /else if \(e\.key === 'Enter'\) e\.preventDefault\(\)/, 'Enter is swallowed');
  assert.doesNotMatch(offerBranch, /mmSessConfirm/, 'the offer branch can never confirm a creative');
  const apply = app.slice(app.indexOf('async function mmSessOfferApply'), app.indexOf('async function mmSessOfferDecline'));
  assert.match(apply, /s\.offer\.busy \|\| mmRv\.busy\) return/, 'double submission guard');
  assert.match(apply, /keys\.forEach\(\(k\) => s\.seen\.add\(k\)\)/, 'applied copies leave the queue');
  assert.match(apply, /s\.resolvedBases\.add\(offer\.base\)/, 'a resolved name is not offered again this session');
  assert.match(apply, /mmRv\.left = Math\.max\(0, mmRv\.left - res\.applied_creatives\)/, 'the remaining counter drops by the copies applied');
  assert.match(app, /const handled = s\.done \+ s\.skipped \+ s\.copied/, 'progress counts the copies');
});

// ── Part 2: the simplified page ──────────────────────────────────────────
test('Ad Matching page: title, search, status dropdown, actions and count on the main page; technical panels collapsed in Advanced settings', () => {
  const html = read('public/index.html');
  const view = html.slice(html.indexOf('<div id="mp-view-matching"'), html.indexOf('<table class="mp-table mm-table">'));
  assert.match(view, /<h3 class="mm-title">Ad Matching<\/h3>/);
  for (const id of ['mm-remaining', 'mm-search', 'mm-filter', 'mm-scope', 'mm-refresh-suggestions', 'mm-rv-start', 'mm-open-inventory']) assert.match(view, new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(view, /mm-intro|mm-chips|mm-rv-keys|mm-rv-prog|Opens each creative in the full editor with reliable suggestions filled in — <kbd>/);
  const adv = view.slice(view.indexOf('<details class="mm-advanced"'));
  assert.doesNotMatch(view.slice(0, view.indexOf('<details class="mm-advanced"')), /id="mm-(catalogue|backlog|workload|archive|relevance-note)"/, 'no technical panel outside Advanced settings');
  for (const id of ['mm-catalogue', 'mm-backlog', 'mm-workload', 'mm-archive', 'mm-relevance-note', 'mm-namecopies-preview']) assert.match(adv, new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(view.slice(view.indexOf('<details class="mm-advanced"'), view.indexOf('<details class="mm-advanced"') + 40), /\bopen\b/, 'collapsed by default');
});
test('Ad Matching page: every existing status stays available, Needs review is the default and is not overridden by a saved view', () => {
  const app = code('public/app.js');
  const filters = [...app.matchAll(/\['([a-z_]+)', '([^']+)', '([a-z_]+)', '(creatives|ads)'\]/g)].map((m) => m[1]);
  assert.deepEqual(filters.sort(), ['all', 'archived', 'conflict', 'excluded', 'historical', 'inherit', 'matched', 'needs', 'not_product_specific', 'suggested', 'unmatched']);
  assert.match(app, /filter: 'needs'/);
  assert.doesNotMatch(app.slice(app.indexOf('(function mmRestoreView'), app.indexOf("document.getElementById('mm-scope').addEventListener")), /mmState\.filter\s*=/, 'the saved view restores only the time window');
  assert.match(app, /document\.getElementById\('mm-filter'\)\.addEventListener\('change'/);
  assert.match(app, /creatives? to review/);
});
test('Ad Matching page: the cleanup removes no loader, endpoint or safeguard (panels are still rendered by their own functions)', () => {
  const app = code('public/app.js');
  for (const fn of ['mmLoadCatalogue', 'mmLoadBacklog', 'mmLoadWorkload', 'mmRenderArchivePanel', 'mmRenderCatalogue', 'mmRenderBacklog']) assert.match(app, new RegExp(`function ${fn}\\b`), fn);
  assert.match(app, /mm-archive-check/);
  assert.match(app, /reprocess-backlog\/preview/);
});

// ── Part 3: giveaway wording ─────────────────────────────────────────────
test('giveaway wording is recognised narrowly (GIVEAWAY / GIVE AWAY / GIVE-AWAY), never "giving", "forgive", "away" or a bare gift card', () => {
  const g = parsing.giveawayLanguage;
  for (const t of ['$5K CASH GIVEAWAY', 'GIFT CARD GIVEAWAY', 'cash giveaway', 'Giveaway', 'GIVEAWAYS', 'WNDRR $1000 GIFT CARD GIVEAWAY VIDEO', 'x_CASH GIVEAWAY_y', '5K GIVE AWAY', 'give-away']) assert.ok(g(t), t);
  for (const t of ['Giving away', 'FORGIVE ME', 'AWAY GAME', 'GIFT CARD', 'GIVEAWAYS2', 'xGIVEAWAYx', 'Core Everyday Hoodie', '', null]) assert.equal(g(t), null, String(t));
  assert.equal(g('$5K CASH GIVEAWAY'), 'CASH GIVEAWAY');
});
test('a giveaway phrase is a promotional (non-product) phrase; one real product word keeps it a product phrase', () => {
  const p = parsing.isPromoPhrase;
  for (const t of ['$5K CASH GIVEAWAY', 'GIFT CARD GIVEAWAY', 'CASH GIVEAWAY', '$1000 GIVEAWAY', '5K GIVE AWAY', 'GIVEAWAY', 'WIN $500 GIVEAWAY']) assert.equal(p(t), true, t);
  for (const t of ['HAVOK HOODIE GIVEAWAY', 'Core Everyday Hoodie', 'CASH', 'GIFT CARD', 'GIVE', '$5K', 'ASSET RAGLAN TEE GIVEAWAY']) assert.equal(p(t), false, t);
  for (const t of ['SALE', 'HYPE', 'FLASH SALE', 'GIFT BOX']) assert.equal(p(t), true, `existing promo phrases unchanged: ${t}`);
  assert.equal(p('MID SALE'), false, 'existing behaviour for unlisted words is unchanged');
});
test('suggestions: a giveaway only ever SUGGESTS Not product-specific (pre-ticked, never confirmed) and only when NO product candidate exists', () => {
  const lib = code('src/lib/metaAdMatching.js');
  assert.match(lib, /const noProductCandidate = !out\.some\(\(x\) => x\.field === 'product'\);/, 'ANY product candidate, however weak, suppresses it');
  assert.match(lib, /if \(giveaway && noProductCandidate\) \{\s*add\(\{ field: 'scope'[^}]*confidence: 0\.85/);
  assert.match(lib, /ad\.match_status !== 'confirmed' && !suggestions\.scope\.length/, 'a confirmed ad gets no overlay');
  assert.match(lib, /x\.field === 'scope' && x\.source === 'name_giveaway'/);
  const app = code('public/app.js');
  assert.match(app, /if \(!c\.productPicker\.get\(\)\.length && !c\.nps\.checked && good\(scope\)\) \{ c\.apply\('scope', scope\)/, 'a pre-ticked box, not a saved decision');
  const af = app.slice(app.indexOf('function mmAutofill'), app.indexOf('async function mmSessNext'));
  assert.doesNotMatch(af, /api\(|fetch\(|confirm/, 'autofill never calls the server');
});
test('SALE / HYPE / other promotional wording gets NO Not-product-specific suggestion at all (only the giveaway improvement remains)', () => {
  const lib = code('src/lib/metaAdMatching.js');
  assert.doesNotMatch(lib, /name_promo|productIsPromo|promotional \/ not product-specific/, 'the promo-slot suggestion logic is gone');
  // the only sources of a not_product_specific suggestion are DPA (0.5, pre-existing) and the giveaway wording
  const adds = [...lib.matchAll(/value_key: 'not_product_specific'[\s\S]{0,330}?source: '([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(adds.sort(), ['name_giveaway', 'name_keyword']);
});

// ── Refinement: pre-fill from a previously confirmed copy ───────────────────
test('pre-fill: the lookup is read-only, needs an eligible ad, skips decided creatives, and any disagreement means no pre-fill', () => {
  const m = code('src/lib/metaNameCopies.js');
  const fn = m.slice(m.indexOf('async function findConfirmedMatch'), m.indexOf('function offerSummary'));
  assert.doesNotMatch(fn, /\b(INSERT|UPDATE|DELETE)\b/i, 'read-only');
  assert.match(fn, /if \(!me \|\| !me\.eligible\) return null/);
  assert.match(fn, /mine\.state !== 'none'\) return null/, 'an ad whose own creative a person already decided is left to exact-creative inheritance');
  assert.match(fn, /if \(sigs\.size > 1\) return \{ state: 'conflict'/);
  const sig = NC.fullSig;
  const row = { not_product_specific: false, codes: 'P1', concept_label: 'Styling', creator_name: 'Mark', media_type: 'video', creative_style_id: null };
  assert.equal(sig(row), sig({ ...row, concept_label: ' STYLING ', creator_name: 'mark' }), 'case / spacing do not make a conflict');
  for (const diff of [{ codes: 'P2' }, { not_product_specific: true }, { concept_label: 'Try On' }, { creator_name: 'James' }, { media_type: 'image' }, { creative_style_id: 3 }]) assert.notEqual(sig(row), sig({ ...row, ...diff }), JSON.stringify(diff));
});
test('pre-fill (modal): applied like suggestions, labelled as coming from a confirmed ad, conflicts pre-fill nothing, Enter safeguards untouched', () => {
  const app = code('public/app.js');
  assert.match(app, /const filled = hasValues \? \[\] : fromCopy \? mmPrefillFromCopy\(pf, sess\.ctx\) : copyConflict \? \[\] : mmAutofill\(ws, sess\.ctx\);/, 'copy > suggestions; a conflict pre-fills nothing, not even suggestions');
  assert.match(app, /from a previously confirmed ad/);
  assert.match(app, /Matching copies were classified differently/);
  assert.match(app, /Nothing is saved until you confirm/);
  const fn = app.slice(app.indexOf('function mmPrefillFromCopy'), app.indexOf('function mmAutofill'));
  assert.doesNotMatch(fn, /api\(|fetch\(|confirm|POST/, 'pre-filling never calls the server');
  // the pre-fill goes through the same applier as suggestions, so the SAME confirm path / guards run when the reviewer presses Enter
  assert.match(fn, /c\.apply\('product'/);
  const lib = code('src/lib/metaAdMatching.js');
  assert.match(lib, /ad\.match_status !== 'confirmed' && !ad\.excluded\) \{\s*try \{ namePrefill = await buildNamePrefill/);
  assert.match(lib, /name_copy_prefill: namePrefill/);
  const kb = app.slice(app.indexOf("document.addEventListener('keydown', (e) => {\n  const s = mmRv.sess;"));
  assert.match(kb, /typing/); assert.match(kb, /e\.repeat/); assert.match(kb, /enterBlockedUntil/);
});
test('pre-fill (unit): fields are applied from the confirmed ad; nothing for a conflict, an empty or missing pre-fill', () => {
  const applied = [];
  const c = { apply: (f, x) => applied.push([f, x && (x.value_label || x.value_key || '')]) };
  const fn = new Function(`${frontEnd('mmPrefillFromCopy')}; return mmPrefillFromCopy;`)();
  const pf = { state: 'ready', matches: 2, from: { ad_name: 'X' }, classification: { products: [{ value_key: 'P1', value_label: 'Tee' }], not_product_specific: false, concept: { value_label: 'STYLING' }, creator: 'Mark', media_type: { value_key: 'video', value_label: 'Video' }, creative_style: null } };
  assert.deepEqual(fn(pf, c), ['Product', 'Concept', 'Media', 'Creator']);
  assert.deepEqual(applied.map((a) => a[0]), ['product', 'concept', 'media_type', 'creator']);
  applied.length = 0;
  assert.deepEqual(fn({ ...pf, classification: { ...pf.classification, products: [], not_product_specific: true, concept: null, creator: null, media_type: null } }, c), ['Not product-specific']);
  assert.deepEqual(applied.map((a) => a[0]), ['scope']);
  applied.length = 0;
  for (const bad of [null, undefined, { state: 'conflict', matches: 2 }, { state: 'ready' }]) assert.deepEqual(fn(bad, c), []);
  assert.equal(applied.length, 0);
});
function frontEnd(name) {
  const app = read('public/app.js');
  const i = app.indexOf(`function ${name}(`);
  let depth = 0; let j = app.indexOf('{', i);
  for (let k = j; k < app.length; k++) { if (app[k] === '{') depth++; else if (app[k] === '}') { depth--; if (!depth) { j = k; break; } } }
  return app.slice(i, j + 1);
}

// ── Part 4: percentage-based colours ─────────────────────────────────────
test('percentRule: lower-is-better and higher-is-better rules, boundary handling, tolerance', () => {
  assert.deepEqual(health.percentRule({ direction: 'lower', target: 60, inclusive: true }), { period: null, green: { lte: 60 }, orange: { gt: 60, lte: 72 }, red: { gt: 72 } });
  assert.deepEqual(health.percentRule({ direction: 'lower', target: 2, inclusive: false, period: 'approx_4_days' }), { period: 'approx_4_days', green: { lt: 2 }, orange: { gte: 2, lte: 2.4 }, red: { gt: 2.4 } });
  assert.deepEqual(health.percentRule({ direction: 'higher', target: 50000, inclusive: true }), { period: null, green: { gte: 50000 }, orange: { lt: 50000, gte: 40000 }, red: { lt: 40000 } });
  assert.deepEqual(health.percentRule({ direction: 'higher', target: 100, inclusive: false, pct: 10 }).orange, { lte: 100, gte: 90 });
  assert.throws(() => health.percentRule({ direction: 'sideways', target: 1 }));
  assert.throws(() => health.percentRule({ direction: 'lower', target: NaN }));
  assert.equal(health.TOLERANCE_PCT, 20);
});
test('approved colours: MOF CPA and TOF Frequency use the stated ranges; every other metric is neutral; the 3-5 day rule holds', () => {
  const c = (f, m, v, days) => health.classify(f, m, v, { days }, { rules: health.RULES });
  const seq = (f, m, vals, days) => vals.map((v) => c(f, m, v, days)).join(',');
  assert.equal(seq('MOF', 'cpa', [10, 39.99, 40, 60, 60.01, 72, 72.01, 200], 30), 'green,green,green,green,orange,orange,red,red');
  assert.equal(seq('TOF', 'frequency', [0.5, 1.99, 2, 2.4, 2.41, 6], 4), 'green,green,orange,orange,red,red');
  for (const days of [1, 2, 6, 7, 14, 30, null, undefined]) assert.equal(seq('TOF', 'frequency', [1, 2.2, 3], days), ',,', `${days} days: not judged`);
  for (const days of [3, 4, 5]) assert.equal(c('TOF', 'frequency', 3, days), 'red');
  for (const [f, m] of [['TOF', 'reach'], ['TOM', 'cpa'], ['TOM', 'reach'], ['MOF', 'reach'], ['TOF', 'cpa'], ['TOM', 'frequency'], ['MOF', 'frequency']]) for (const v of [0, 1, 50, 61, 80, 5000]) assert.equal(c(f, m, v), null, `${f} ${m} ${v}`);
  for (const f of ['unknown', 'multiple', null]) assert.equal(c(f, 'cpa', 65), null);
});
test('Meta Performance colour guide: one collapsed control generated from the active rules; Triple Whale is not touched', () => {
  const app = code('public/app.js');
  assert.match(app, /<details class="mp-health-guide"><summary title="What the colour dots mean">ⓘ Colour guide<\/summary>/);
  assert.match(app, /CPA is Meta-reported \(Triple Whale is not connected yet\)/);
  assert.doesNotMatch(app.slice(app.indexOf('<details class="mp-health-guide">') - 200, app.indexOf('<details class="mp-health-guide">') + 1800), /Colour dots are used on/, 'the long paragraph is gone');
  assert.match(app, /Meeting the approved target/);
  assert.match(app, /Missing the approved target by up to 20%/);
  assert.match(app, /Missing the approved target by more than 20%/);
  const files = fs.readdirSync(path.join(__dirname, '..', 'src', 'lib')).concat(fs.readdirSync(path.join(__dirname, '..', 'src', 'routes')));
  assert.ok(!files.some((f) => /triple|whale/i.test(f)), 'no Triple Whale integration exists in this batch');
  assert.doesNotMatch(code('src/lib/metaFunnelHealth.js'), /triple|whale|TRIPLEWHALE/i);
  // Batch 9 columns unchanged
  assert.match(app, /\{ key: 'roas', label: 'ROAS', fmt: 'roas', better: 'up' \}/);
  assert.match(read('public/index.html'), /data-sort="purchase_value"[\s\S]{0,200}data-sort="roas"/);
});
