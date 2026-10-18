// Batch 35: Tuesday Review eligibility, concept lifecycle rules, deterministic Meta copy rules, read-only Google Sheets client,
// copy library parsing / tone analysis / selection, and the AI Copy Assistant guard rails. Pure functions + injected fetch mocks:
// no network, no database, no credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const rules = require('../src/lib/adCopyRules');
const sheets = require('../src/lib/googleSheets');
const lib = require('../src/lib/copyLibrary');
const ai = require('../src/lib/copyAi');
const { evaluateLifecycle } = require('../src/lib/conceptLifecycle');
const cdRouter = require('../src/lib/tuesdayReview');

// ── Tuesday Review eligibility ──────────────────────────────────────────────────────────────────────────────────
test('Tuesday Review: only concepts explicitly submitted via Ready for Review (or already decided) enter review', () => {
  const inReview = cdRouter.isInTuesdayReview;
  assert.equal(inReview({ concept_dev_status: 'ready_for_review' }), true);
  assert.equal(inReview({ concept_dev_status: 'changes_required' }), true);
  assert.equal(inReview({ concept_dev_status: 'approved' }), true);
  assert.equal(inReview({ concept_dev_status: 'not_started' }), false);
  assert.equal(inReview({ concept_dev_status: 'in_development' }), false);
  assert.equal(inReview({ concept_dev_status: null }), false);
  assert.equal(inReview(null), false);
});

test('Tuesday Review: a killed draft never appears; a killed concept that was reviewed keeps its history', () => {
  const inReview = cdRouter.isInTuesdayReview;
  assert.equal(inReview({ concept_dev_status: 'killed' }), false);
  assert.equal(inReview({ concept_dev_status: 'killed', submitted_for_review_at: '2026-01-01' }), true);
  assert.equal(inReview({ concept_dev_status: 'killed', reviewed_at: '2026-01-01' }), true);
});

// ── concept lifecycle rules ─────────────────────────────────────────────────────────────────────────────────────
const facts = (over = {}) => ({ id: 1, name: 'Test', stage: 'concept-dev', archived: false, killed: false, published: false, approvedAdSetup: false, metaLinked: false, counts: {}, ...over });
const action = (r, key) => r.actions.find((a) => a.key === key);

test('lifecycle: an ordinary concept can be archived, killed and (admin only) removed', () => {
  const member = evaluateLifecycle(facts(), { isAdmin: false });
  assert.equal(action(member, 'archive').allowed, true);
  assert.equal(action(member, 'kill').allowed, true);
  assert.equal(action(member, 'remove_test').allowed, false);
  assert.match(action(member, 'remove_test').reason, /admin/i);
  const admin = evaluateLifecycle(facts(), { isAdmin: true });
  assert.equal(action(admin, 'remove_test').allowed, true);
  assert.equal(action(admin, 'remove_test').destructive, true);
});

test('lifecycle: published and Meta-linked concepts can only be archived; an approved Ad Setup alone does not block Kill', () => {
  for (const f of [{ published: true }, { metaLinked: true }]) {
    const r = evaluateLifecycle(facts(f), { isAdmin: true });
    assert.equal(r.protected, true);
    assert.equal(action(r, 'archive').allowed, true);
    assert.equal(action(r, 'kill').allowed, false);
    assert.equal(action(r, 'remove_test').allowed, false);
    assert.ok(r.protected_reason);
  }
});

test('lifecycle: an approved Ad Setup that was never published can be killed, and the consequence says what happens', () => {
  const r = evaluateLifecycle(facts({ stage: 'approved', approvedAdSetup: true }), { isAdmin: false });
  assert.equal(r.protected, false);
  assert.equal(action(r, 'kill').allowed, true);
  assert.ok(r.consequences.some((c) => /approved Ad Setup leaves the Approved list/.test(c)));
});

test('lifecycle: archived concepts offer restore, not archive; killed concepts cannot be killed twice', () => {
  const archived = evaluateLifecycle(facts({ archived: true }), { isAdmin: true });
  assert.equal(action(archived, 'unarchive').allowed, true);
  assert.equal(action(archived, 'archive'), undefined);
  const killed = evaluateLifecycle(facts({ killed: true }), { isAdmin: false });
  assert.equal(action(killed, 'kill').allowed, false);
  assert.match(action(killed, 'kill').reason, /already/i);
});

test('lifecycle: consequences explain scheduled / filmed / edit / ad setup effects, without claiming files are deleted', () => {
  const r = evaluateLifecycle(facts({ stage: 'shooting', counts: { shoot: true, shot: false, finalEdits: 0, adSetups: 0 } }), {});
  assert.ok(r.consequences.some((c) => /scheduled for shooting/i.test(c)));
  const later = evaluateLifecycle(facts({ stage: 'ad-setup', counts: { shoot: true, shot: true, finalEdits: 2, adSetups: 1 } }), {});
  assert.ok(later.consequences.some((c) => /Filming is already marked done; the footage itself is not touched/.test(c)));
  assert.ok(later.consequences.some((c) => /2 final edit records \(links only, no files\)/.test(c)));
  assert.ok(later.consequences.some((c) => /1 Ad Setup draft leave/.test(c)));
});

// ── deterministic Meta copy rules ───────────────────────────────────────────────────────────────────────────────
const std = (extra = {}) => rules.deriveCopyRule({ adCategory: 'core', productNames: ['Asset Raglan Tee'], ...extra });

test('copy rules: standard product / new drop / restock', () => {
  for (const adCategory of ['core', 'new_drop', 'organic_first']) {
    const r = rules.deriveCopyRule({ adCategory, productNames: ['Asset Raglan Box Fit Tee'] });
    assert.equal(r.ruleKey, 'standard');
    assert.equal(r.headline, 'ASSET RAGLAN BOX FIT TEE');
    assert.equal(r.description, 'Elevate your everyday');
    assert.equal(r.cta, 'shop_now');
    assert.deepEqual(r.flags, []);
  }
});

test('copy rules: standard headline is flagged, never invented, when the product is missing or ambiguous', () => {
  const none = rules.deriveCopyRule({ adCategory: 'core', productNames: [] });
  assert.equal(none.headline, null);
  assert.equal(none.flags[0].code, 'product_missing');
  assert.equal(none.description, 'Elevate your everyday');
  const many = rules.deriveCopyRule({ adCategory: 'core', productNames: ['A Tee', 'B Tee'] });
  assert.equal(many.headline, null);
  assert.equal(many.flags[0].code, 'multiple_products');
  const dup = rules.deriveCopyRule({ adCategory: 'core', productNames: ['A Tee', ' A  Tee '] });
  assert.equal(dup.headline, 'A TEE');
});

const promo = (stageType, offer, extra = {}) => rules.deriveCopyRule({ adCategory: 'promotion', stageType, offer, promotionName: 'Black Friday 2026', ...extra });

test('copy rules: Sale hype / teaser', () => {
  const r = promo('hype', '20-50% off everything');
  assert.equal(r.ruleKey, 'hype');
  assert.equal(r.headline, 'SIGN UP TO BE NOTIFIED');
  assert.equal(r.description, '20-50% off everything sale');
  assert.equal(r.cta, 'sign_up');
  assert.deepEqual(r.flags, []);
  assert.equal(promo('hype', '20-50% off everything sale').description, '20-50% off everything sale');
  assert.equal(promo('hype', '20-50% off everything', { offerTeaser: 'Up to 50% off sitewide' }).description, 'Up to 50% off sitewide');
});

test('copy rules: Sale live and Mid sale use the same rules', () => {
  const live = promo('sale_live', '20-50% off everything');
  assert.equal(live.headline, '20-50% OFF EVERYTHING');
  assert.equal(live.description, 'Limited time only!');
  assert.equal(live.cta, 'shop_now');
  const mid = promo('mid_sale', '20-50% off everything');
  assert.equal(mid.ruleKey, 'mid_sale');
  assert.equal(mid.headline, live.headline);
  assert.equal(mid.description, live.description);
  assert.equal(mid.cta, live.cta);
});

test('copy rules: Last chance', () => {
  const r = promo('last_chance', '20-50% off everything');
  assert.equal(r.headline, 'LAST CHANCE 20-50% OFF EVERYTHING');
  assert.equal(r.description, "Don't miss out!");
  assert.equal(r.cta, 'shop_now');
});

test('copy rules: a missing or placeholder offer is never invented; the fixed parts still apply and a flag is raised', () => {
  for (const offer of [null, '', '   ', 'TBC', 'n/a', 'sale']) {
    for (const stage of ['hype', 'sale_live', 'mid_sale', 'last_chance']) {
      const r = promo(stage, offer);
      assert.ok(r.flags.some((f) => /^offer_/.test(f.code)), `${stage}/${offer}`);
      if (stage === 'hype') { assert.equal(r.headline, 'SIGN UP TO BE NOTIFIED'); assert.equal(r.description, null); } else { assert.equal(r.headline, null); assert.ok(r.description); }
    }
  }
});

test('copy rules: unknown promotion stage applies no rule', () => {
  const r = promo('weird', '20% off');
  assert.equal(r.ruleKey, null);
  assert.equal(r.headline, null);
  assert.equal(r.flags[0].code, 'stage_unknown');
});

test('copy rules: offer validation', () => {
  assert.equal(rules.validateOffer('20-50% off everything').ok, true);
  assert.equal(rules.validateOffer('x'.repeat(121)).ok, false);
  assert.equal(rules.validateOffer('<b>50% off</b>').ok, false);
  assert.equal(rules.validateOffer('---').ok, false);
  assert.equal(rules.validateOffer(undefined).problem, 'missing');
});

test('copy rules: manually edited or approved copy is never auto-overwritten', () => {
  assert.equal(rules.mayAutoApply({ copy_fields_manual: false, status: 'draft' }), true);
  assert.equal(rules.mayAutoApply({ copy_fields_manual: true, status: 'draft' }), false);
  assert.equal(rules.mayAutoApply({ copy_fields_manual: false, status: 'approved' }), false);
});

test('copy rules: deterministic (same input, same output)', () => {
  assert.deepEqual(promo('sale_live', '30% off'), promo('sale_live', '30% off'));
  assert.deepEqual(std(), std());
});

// ── Google Sheets client (read-only) ────────────────────────────────────────────────────────────────────────────
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const SA = { client_email: 'copy-reader@wndrr.iam.gserviceaccount.com', private_key: pem };
const env = (extra = {}) => ({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(SA), WNDRR_COPY_SHEET_ID: 'SHEET123', ...extra });

test('sheets: reports a missing or malformed configuration without throwing', () => {
  assert.equal(sheets.readCredentials({}).configured, false);
  assert.match(sheets.readCredentials({}).reason, /GOOGLE_SERVICE_ACCOUNT_JSON/);
  assert.equal(sheets.readCredentials({ GOOGLE_SERVICE_ACCOUNT_JSON: '{nope' }).configured, false);
  assert.equal(sheets.readCredentials({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'a@b' }) }).configured, false);
  assert.equal(sheets.readCredentials(env()).configured, true);
  const b64 = Buffer.from(JSON.stringify(SA)).toString('base64');
  assert.equal(sheets.readCredentials({ GOOGLE_SERVICE_ACCOUNT_JSON: b64 }).configured, true);
});

test('sheets: only the read-only scope is requested and the JWT verifies with the public key', () => {
  assert.match(sheets.SCOPE, /spreadsheets\.readonly$/);
  const jwt = sheets.signJwt(SA, 1700000000, {});
  const [h, c, s] = jwt.split('.');
  const claim = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claim.scope, sheets.SCOPE);
  assert.equal(claim.iss, SA.client_email);
  assert.equal(JSON.parse(Buffer.from(h, 'base64url').toString()).alg, 'RS256');
  const v = crypto.createVerify('RSA-SHA256'); v.update(`${h}.${c}`);
  assert.equal(v.verify(publicKey, Buffer.from(s, 'base64url')), true);
});

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('sheets: reads tabs and values with GET only, and the bearer token never leaves the request header', async () => {
  sheets.resetTokenCache();
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET' });
    if (/token/.test(url)) return res(200, { access_token: 'tok', expires_in: 3600 });
    if (/values/.test(url)) return res(200, { values: [['Product', 'Primary Text'], ['Tee', 'A real line of copy for the tee.']] });
    return res(200, { sheets: [{ properties: { title: 'CORE', gridProperties: { rowCount: 5, columnCount: 3 } } }] });
  };
  const e = env({ GOOGLE_TOKEN_URL: 'http://mock/token', GOOGLE_SHEETS_API_BASE: 'http://mock/v4' });
  const tabs = await sheets.listTabs({ fetchImpl, env: e });
  assert.deepEqual(tabs.map((t) => t.title), ['CORE']);
  const rows = await sheets.readTab("O'Neil", { fetchImpl, env: e });
  assert.equal(rows.length, 2);
  assert.ok(calls.some((c) => /SHEET123/.test(c.url)));
  assert.ok(calls.filter((c) => !/token/.test(c.url)).every((c) => c.method === 'GET'), 'sheet calls are GET only');
  assert.equal(calls.filter((c) => /token/.test(c.url)).length, 1, 'access token is cached');
  assert.ok(calls.some((c) => c.url.includes(encodeURIComponent("'O''Neil'"))), 'tab titles are quoted safely');
});

test('sheets: failure modes are typed with actionable messages', async () => {
  const e = env({ GOOGLE_TOKEN_URL: 'http://mock/token', GOOGLE_SHEETS_API_BASE: 'http://mock/v4' });
  const mk = (status) => async (url) => (/token/.test(url) ? res(200, { access_token: 't', expires_in: 3600 }) : res(status, {}));
  for (const [status, code, text] of [[403, 'forbidden', /Share it/], [404, 'not_found', /WNDRR_COPY_SHEET_ID/], [429, 'rate_limited', /rate/i], [500, 'api_error', /500/]]) {
    sheets.resetTokenCache();
    await assert.rejects(() => sheets.listTabs({ fetchImpl: mk(status), env: e }), (err) => err.code === code && text.test(err.message), `${status}`);
  }
  sheets.resetTokenCache();
  await assert.rejects(() => sheets.listTabs({ fetchImpl: async () => res(401, {}), env: e }), (err) => err.code === 'auth_failed');
  sheets.resetTokenCache();
  await assert.rejects(() => sheets.listTabs({ fetchImpl: async () => { throw new Error('ECONNRESET'); }, env: e }), (err) => err.code === 'network');
  await assert.rejects(() => sheets.listTabs({ env: {} }), (err) => err.code === 'not_configured');
});

// ── copy library: parsing, tone, selection ──────────────────────────────────────────────────────────────────────
const CORE_ROWS = [
  ['Product', 'Headline', 'Primary Text'],
  ['Asset Raglan Tee', 'ASSET RAGLAN TEE', 'Your new favourite tee.\nBoxy fit, soft feel, made to be worn on repeat.'],
  ['Asset Raglan Tee', '', 'Your new favourite tee.\nBoxy fit, soft feel, made to be worn on repeat.'],
  ['Cargo Pant', 'CARGO PANT', 'Built for everyday movement.\nA relaxed cut that works with everything.'],
  ['Short one', '', 'too short'],
];

test('library: parses the copy column, headline and label, de-duplicates and skips short cells', () => {
  const p = lib.parseTab(CORE_ROWS, { title: 'CORE' });
  assert.equal(p.header_found, true);
  assert.equal(p.examples.length, 2);
  assert.equal(p.examples[0].label, 'Asset Raglan Tee');
  assert.equal(p.examples[0].headline, 'ASSET RAGLAN TEE');
  assert.equal(p.examples[0].row_number, 2);
});

test('library: falls back to the column with the most text, with a warning, when no header names it', () => {
  const p = lib.parseTab([['x', 'Hello there, this is a long enough bit of copy for the library.'], ['y', 'Another long enough line of copy for the reference library.']], {});
  assert.equal(p.examples.length, 2);
  assert.ok(p.warnings.some((w) => /most text/.test(w)));
  const empty = lib.parseTab([], {});
  assert.equal(empty.examples.length, 0);
  assert.ok(empty.warnings.length);
});

test('library: tab matching is case/space-insensitive and reports missing tabs', () => {
  const m = lib.matchTabs(['core', 'CORE 26', ' sales ']);
  assert.equal(m.find((t) => t.title === 'CORE').actual, 'core');
  assert.equal(m.find((t) => t.title === 'SALES').actual, ' sales ');
  assert.equal(m.find((t) => t.title === 'PINTEREST').actual, null);
  assert.equal(lib.EXPECTED_TABS.length, 11);
});

test('library: tone statistics are computed from the examples only (deterministic, nothing assumed)', () => {
  const ex = [
    { family: 'core', body: 'Your new favourite tee. Boxy fit, soft feel! Shop now' },
    { family: 'core', body: 'Built for everyday. Shop now and wear it on repeat' },
    { family: 'sales', body: 'LIMITED TIME ONLY. 20% off everything. Don\'t miss out' },
  ];
  const a = lib.analyseTone(ex);
  assert.equal(a.examples, 3);
  assert.equal(a.families.core.examples, 2);
  assert.equal(a.families.sales.examples, 1);
  assert.equal(a.families.bundles, undefined);
  assert.equal(a.overall.shares.exclamation, 33.3);
  assert.equal(a.overall.shares.emoji, 0);
  assert.ok(a.overall.cta_phrases.some((c) => c.text === 'shop now' && c.count === 2));
  assert.deepEqual(lib.analyseTone(ex).overall, a.overall);
  assert.equal(lib.guidelinesText(null), '');
  assert.match(lib.guidelinesText(a, null, ['core']), /CORE examples \(2\)/);
});

test('library: examples are selected by ad type; sales ads only ever get sales copy', () => {
  const all = [
    { id: 1, family: 'core', label: 'Asset Raglan Tee', body: 'core tee copy', year: 2025 },
    { id: 2, family: 'core', label: 'Cargo Pant', body: 'core pant copy', year: 2026 },
    { id: 3, family: 'sales', label: 'Black Friday last chance', body: 'sales copy ends tonight', year: 2025 },
    { id: 4, family: 'bundles', label: 'Mystery Bundle', body: 'bundle copy', year: 2026 },
    { id: 5, family: 'ranges', label: 'Range', body: 'range copy', year: 2026 },
  ];
  const sales = lib.selectExamples(all, { adCategory: 'promotion', stageType: 'last_chance', productName: '' });
  assert.deepEqual(sales.map((e) => e.family), ['sales']);
  const core = lib.selectExamples(all, { adCategory: 'core', productName: 'Asset Raglan Tee' });
  assert.equal(core[0].id, 1, 'product-word overlap ranks first');
  assert.ok(core.every((e) => ['core', 'ranges'].includes(e.family)));
  assert.deepEqual(lib.familiesFor({ adCategory: 'promotion' }), ['sales']);
  assert.ok(lib.familiesFor({ adCategory: 'core', productName: 'Mystery Pack Bundle' }).includes('bundles'));
  assert.deepEqual(lib.selectExamples(all, { adCategory: 'core', productName: 'Asset Raglan Tee' }).map((e) => e.id), lib.selectExamples(all, { adCategory: 'core', productName: 'Asset Raglan Tee' }).map((e) => e.id));
});

// ── AI copy assistant ───────────────────────────────────────────────────────────────────────────────────────────
const FACTS = { productName: 'Asset Raglan Box Fit Tee', productCategory: 'Box Fit Tee', productNames: ['Asset Raglan Box Fit Tee'], adCategoryLabel: 'Core product', conceptName: '3 Ways to Style', isPromotion: false };

test('ai: configuration is reported, never assumed', () => {
  assert.equal(ai.aiConfig({}).configured, false);
  assert.match(ai.aiConfig({}).reason, /ANTHROPIC_API_KEY/);
  assert.equal(ai.aiConfig({ ANTHROPIC_API_KEY: 'k' }).model, ai.DEFAULT_MODEL);
  assert.equal(ai.aiConfig({ ANTHROPIC_API_KEY: 'k', COPY_AI_MODEL: 'm' }).model, 'm');
  return assert.rejects(() => ai.callModel({ system: 's', messages: [], env: {} }), (e) => e.code === 'not_configured');
});

test('ai: calls the provider server-side with the key in a header and maps error statuses', async () => {
  const seen = [];
  const mk = (status, body) => async (url, opts) => { seen.push({ url, opts }); return { ok: status === 200, status, json: async () => body }; };
  const e = { ANTHROPIC_API_KEY: ' sk-test ', ANTHROPIC_API_BASE: 'http://mock' };
  const out = await ai.callModel({ system: 's', messages: [{ role: 'user', content: 'x' }], env: e, fetchImpl: mk(200, { model: 'm1', content: [{ type: 'text', text: 'hello' }] }) });
  assert.equal(out.text, 'hello');
  assert.equal(seen[0].url, 'http://mock/v1/messages');
  assert.equal(seen[0].opts.headers['x-api-key'], 'sk-test');
  assert.ok(!seen[0].opts.body.includes('sk-test'), 'the key is not in the request body');
  for (const [status, code] of [[401, 'auth_failed'], [429, 'rate_limited'], [500, 'api_error']]) {
    await assert.rejects(() => ai.callModel({ system: 's', messages: [], env: e, fetchImpl: mk(status, {}) }), (err) => err.code === code);
  }
  await assert.rejects(() => ai.callModel({ system: 's', messages: [], env: e, fetchImpl: mk(200, { content: [] }) }), (err) => err.code === 'empty');
  await assert.rejects(() => ai.callModel({ system: 's', messages: [], env: e, fetchImpl: async () => { throw new Error('boom'); } }), (err) => err.code === 'network');
});

test('ai: facts guard rejects invented discounts, prices, specs, GSM, stock, shipping and deadlines', () => {
  const bad = {
    discount: 'Now 30% off the Asset Raglan Tee.', price: 'Only $49 for the Asset Raglan Tee.', gsm: 'A 280gsm heavyweight tee.', fabric: 'Soft organic cotton.',
    stock: 'Selling fast, only 5 left.', shipping: 'Free shipping on every order.', deadline: 'Ends Sunday.', terms: 'A great deal.',
  };
  for (const [k, text] of Object.entries(bad)) assert.ok(ai.findUnsupportedClaims(text, { text: ai.factsToText(FACTS), isPromotion: false }).length > 0, k);
  // the product name supports "box fit"; a count of ways to style it comes from the creative concept, which is direction and not a verified fact (v1.4.5)
  assert.deepEqual(ai.findUnsupportedClaims('Boxy fit, easy to style.', { text: ai.factsToText(FACTS), isPromotion: false }), []);
  assert.ok(ai.findUnsupportedClaims('Boxy fit, easy to style three ways.', { text: ai.factsToText(FACTS), isPromotion: false }).some((c) => c.code === 'count'));
});

test('ai: a verified offer in the facts permits that offer and nothing else', () => {
  const f = { ...FACTS, isPromotion: true, offer: '20-50% off everything', promotionName: 'Black Friday' };
  const g = { text: ai.factsToText(f), isPromotion: true };
  assert.deepEqual(ai.findUnsupportedClaims('20-50% off everything this weekend', g).map((c) => c.code), ['deadline']);
  assert.ok(ai.findUnsupportedClaims('Now 70% off', g).some((c) => c.code === 'discount'));
  assert.ok(ai.findUnsupportedClaims('The sale is on', { text: ai.factsToText(FACTS), isPromotion: false }).some((c) => c.code === 'sale_word'));
});

const answer = (...texts) => JSON.stringify({ options: texts.map((t, i) => ({ angle: `a${i}`, text: t })) });
const THREE = answer('Boxy fit that sits right.\nMade to be worn on repeat.', 'One tee for the gym, the street and everything in between.', 'Pair it back with relaxed cargos and clean sneakers.');

test('ai: generate returns three distinct, fact-safe options', async () => {
  const out = await ai.generate({ facts: FACTS, guidelines: 'g', examples: [], ruleKey: 'standard', call: async () => ({ text: THREE, model: 'm' }) });
  assert.equal(out.options.length, 3);
  assert.equal(out.attempts, 1);
});

test('ai: unsupported claims trigger one retry; a clean retry is accepted', async () => {
  let n = 0;
  const calls = [];
  const out = await ai.generate({ facts: FACTS, guidelines: '', examples: [], ruleKey: 'standard', call: async (a) => { n += 1; calls.push(a.messages[a.messages.length - 1].content); return { text: n === 1 ? answer('Now 30% off!', 'Second distinct option about the fit.', 'Third distinct option about styling cargos.') : THREE, model: 'm' }; } });
  assert.equal(n, 2);
  assert.equal(out.attempts, 2);
  assert.match(calls[1], /rejected/);
  assert.equal(out.options.length, 3);
});

test('ai: when claims persist the offending options are dropped, and if nothing is clean the request fails', async () => {
  const dirty = answer('Free shipping on this tee.', 'Now 30% off the tee.', 'Only $20 right now.');
  await assert.rejects(() => ai.generate({ facts: FACTS, guidelines: '', examples: [], ruleKey: 'standard', call: async () => ({ text: dirty, model: 'm' }) }), (e) => e.code === 'rejected');
  const mixed = answer('Free shipping on this tee.', 'Boxy fit that sits right on the body.', 'Pair it back with relaxed cargos and clean sneakers.');
  const out = await ai.generate({ facts: FACTS, guidelines: '', examples: [], ruleKey: 'standard', call: async () => ({ text: mixed, model: 'm' }) });
  assert.equal(out.options.length, 2);
  assert.equal(out.dropped.length, 1);
});

test('ai: unparseable output is retried once then reported', async () => {
  await assert.rejects(() => ai.generate({ facts: FACTS, guidelines: '', examples: [], ruleKey: 'standard', call: async () => ({ text: 'not json', model: 'm' }) }), (e) => e.code === 'bad_output');
  assert.deepEqual(ai.parseOptions('```json\n{"options":[{"angle":"a","text":"hello world"}]}\n```'), [{ angle: 'a', text: 'hello world' }]);
});

test('ai: refinement returns one option and still passes through the facts guard', async () => {
  const out = await ai.generate({ mode: 'refine', facts: FACTS, guidelines: '', examples: [], baseText: 'Boxy fit.', instruction: 'shorter', ruleKey: 'standard', call: async () => ({ text: answer('Boxy fit, easy style.'), model: 'm' }) });
  assert.equal(out.options.length, 1);
  await assert.rejects(() => ai.generate({ mode: 'refine', facts: FACTS, guidelines: '', examples: [], baseText: 'Boxy fit.', instruction: 'make it urgent', ruleKey: 'standard', call: async () => ({ text: answer('Hurry, only 3 left!'), model: 'm' }) }), (e) => e.code === 'rejected');
});

test('ai: the prompt gives sales ads sales angles and forbids copying or inventing', () => {
  const sale = ai.buildMessages({ mode: 'generate', facts: { ...FACTS, isPromotion: true, offer: '20% off' }, guidelines: 'g', examples: [{ label: 'x', body: 'ref copy' }], ruleKey: 'last_chance' });
  const last = sale.messages[sale.messages.length - 1].content;
  assert.match(last, /urgency-led/);
  assert.match(sale.system, /Never copy a sentence/);
  assert.match(sale.system, /Do NOT invent/);
  const std2 = ai.buildMessages({ mode: 'generate', facts: FACTS, guidelines: '', examples: [], ruleKey: 'standard' });
  assert.match(std2.messages[0].content, /product-led/);
  assert.match(std2.messages[0].content, /idea-led/);
  assert.match(std2.messages[0].content, /occasion-led/);
  assert.doesNotMatch(std2.messages[0].content, /feature-led/, 'no feature-led option without verified features (v1.4.5)');
});
