// Claude / OpenAI comparison for the AI Copy Assistant (v1.4.6): provider configuration, the OpenAI Responses API call, safe error handling, equal inputs for both providers,
// the shared claim guard, and the wiring (provider choice, per-provider results, nothing replaced). Pure functions and fake fetches only: no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ai = require('../src/lib/copyAi');
const providers = require('../src/lib/aiProviders');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const OPENAI_KEY = 'sk-proj-openai-unit-secret-0123456789';
const ANTHROPIC_KEY = 'sk-ant-unit-secret-0123456789';
const ENV = { OPENAI_API_KEY: OPENAI_KEY, OPENAI_API_BASE: 'http://openai-mock', ANTHROPIC_API_KEY: ANTHROPIC_KEY, ANTHROPIC_API_BASE: 'http://anthropic-mock' };
const answerJson = (...t) => JSON.stringify({ options: t.map((x, i) => ({ angle: `a${i}`, text: x })) });
const respOk = (text, model = 'gpt-6.1-sol-2026-09-22') => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 'resp_1', status: 'completed', model, output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] }) });
const respErr = (status, error, reqId = 'req_oa1') => ({ ok: false, status, headers: { get: (n) => (n === 'x-request-id' ? reqId : null) }, json: async () => ({ error }) });

// ── 1. configuration ───────────────────────────────────────────────────────────────────────────────────────────────
test('providers: Claude is the default; each provider reports its own configuration and never its key', () => {
  assert.equal(providers.DEFAULT_PROVIDER, 'anthropic');
  assert.deepEqual(Object.keys(providers.PROVIDERS), ['anthropic', 'openai']);
  assert.equal(providers.providerLabel('anthropic'), 'Claude'); assert.equal(providers.providerLabel('openai'), 'OpenAI');
  assert.equal(providers.providerOf(null), 'anthropic', 'a generation from before providers existed was Claude');
  assert.equal(providers.providerOf('nonsense'), 'anthropic');
  assert.equal(providers.isProvider('openai'), true); assert.equal(providers.isProvider('gemini'), false); assert.equal(providers.isProvider('__proto__'), false);
  const both = providers.allProviders(ENV);
  assert.deepEqual(both.map((p) => [p.id, p.label, p.configured]), [['anthropic', 'Claude', true], ['openai', 'OpenAI', true]]);
  assert.equal(both[0].model, ai.DEFAULT_MODEL); assert.equal(both[1].model, providers.OPENAI_DEFAULT_MODEL);
  assert.doesNotMatch(JSON.stringify(both), /sk-proj|sk-ant|unit-secret/);
});

test('openai config: key and model come from the environment; the reason says what is wrong using names only', () => {
  assert.equal(providers.OPENAI_DEFAULT_MODEL, 'gpt-6.1-sol', 'the release default: GPT-6.1 Sol');
  assert.equal(providers.openaiConfig({ OPENAI_API_KEY: 'k' }).model, 'gpt-6.1-sol', 'with no OPENAI_COPY_MODEL the default is used');
  assert.equal(providers.openaiConfig({ OPENAI_API_KEY: '  "sk-x-123"  ' }).key, 'sk-x-123');
  assert.equal(providers.openaiConfig({ OPENAI_API_KEY: 'k', OPENAI_COPY_MODEL: 'gpt-6-sol' }).model, 'gpt-6-sol', 'OPENAI_COPY_MODEL overrides the default');
  assert.equal(providers.openaiConfig({ OPENAI_API_KEY: 'k' }).reasoning, 'low');
  const missing = providers.openaiConfig({});
  assert.equal(missing.configured, false); assert.match(missing.reason, /OPENAI_API_KEY is not set/); assert.match(missing.reason, /billing is separate from a ChatGPT subscription/);
  assert.match(providers.openaiConfig({ OPENAI_API_KEY: '  ' }).reason, /value is empty/);
  const near = providers.openaiConfig({ OPENAI_KEY: 'sk-should-not-appear' });
  assert.match(near.reason, /OPENAI_KEY/); assert.doesNotMatch(near.reason, /should-not-appear/);
  assert.equal(providers.providerConfig('openai', {}).configured, false);
  assert.equal(providers.providerConfig('anthropic', { OPENAI_API_KEY: 'k' }).configured, false, 'one provider being set up does not configure the other');
});

// ── 2. the OpenAI call ─────────────────────────────────────────────────────────────────────────────────────────────
test('openai call: Responses API, bearer key in a header only, no sampling settings, JSON answer requested, store off', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push({ url, opts, body: JSON.parse(opts.body) }); return respOk(answerJson('One.', 'Two.')); };
  const out = await providers.callOpenAI({ system: 'SYS', messages: [{ role: 'user', content: 'U1' }, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'U2' }], env: ENV, fetchImpl });
  assert.equal(seen[0].url, 'http://openai-mock/v1/responses');
  assert.equal(seen[0].opts.method, 'POST');
  assert.equal(seen[0].opts.headers.authorization, `Bearer ${OPENAI_KEY}`);
  const b = seen[0].body;
  assert.equal(b.model, 'gpt-6.1-sol'); assert.equal(b.instructions, 'SYS');
  assert.deepEqual(b.reasoning, { effort: 'low' }, 'reasoning effort low'); assert.equal(b.store, false, 'store: false');
  assert.equal(b.text.format.type, 'json_schema', 'structured JSON output'); assert.equal(b.text.format.strict, true);
  assert.equal(b.temperature, undefined); assert.equal(b.top_p, undefined);
  assert.deepEqual(b.input, [{ role: 'user', content: 'U1' }, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'U2' }]);
  assert.ok(b.max_output_tokens >= 4000); assert.equal(b.store, false);
  assert.equal(b.temperature, undefined); assert.equal(b.top_p, undefined);
  assert.deepEqual(b.reasoning, { effort: 'low' });
  assert.equal(b.text.format.type, 'json_schema'); assert.equal(b.text.format.strict, true); assert.deepEqual(b.text.format.schema.required, ['options']);
  assert.ok(!seen[0].opts.body.includes(OPENAI_KEY), 'the key is not in the request body');
  assert.deepEqual(ai.parseOptions(out.text).map((o) => o.text), ['One.', 'Two.']);
  assert.equal(out.model, 'gpt-6.1-sol-2026-09-22', 'the model OpenAI actually served is the one recorded');
  await providers.callOpenAI({ system: 's', messages: [], env: { ...ENV, OPENAI_COPY_REASONING: 'off', OPENAI_COPY_MODEL: 'gpt-6-sol' }, fetchImpl: async (u, o) => { seen.push({ body: JSON.parse(o.body) }); return respOk('{"options":[{"angle":"a","text":"t"}]}'); } });
  assert.equal(seen[seen.length - 1].body.model, 'gpt-6-sol', 'an override model is the one sent'); assert.equal(seen[seen.length - 1].body.reasoning, undefined, '"off" sends no reasoning setting');
  await assert.rejects(() => providers.callOpenAI({ system: 's', messages: [], env: {} }), (e) => e.code === 'not_configured');
});

test('openai model settings: the same documented request works for gpt-6-sol and gpt-6.1-sol; settings the model does not take are dropped, never guessed', async () => {
  for (const model of ['gpt-6-sol', 'gpt-6.1-sol']) {
    let body;
    await providers.callOpenAI({ system: 's', messages: [{ role: 'user', content: 'x' }], env: { ...ENV, OPENAI_COPY_MODEL: model }, fetchImpl: async (u, o) => { body = JSON.parse(o.body); return respOk(answerJson('Ok.'), `${model}-snap`); } });
    assert.equal(body.model, model);
    assert.deepEqual(body.reasoning, { effort: 'low' }, `${model}: low effort is supported (gpt-6.1-sol does not take none, so none is never the default)`);
    assert.equal(body.store, false); assert.equal(body.max_output_tokens, 8000); assert.ok(body.max_output_tokens >= 16);
    assert.equal(body.text.format.strict, true); assert.equal(body.temperature, undefined); assert.equal(body.top_p, undefined);
  }
  // "none" is not a model-specific guess: a model that rejects it answers 400 naming reasoning, and the request is retried without it
  const calls = [];
  const out = await providers.callOpenAI({ system: 's', messages: [], env: { ...ENV, OPENAI_COPY_MODEL: 'gpt-6.1-sol', OPENAI_COPY_REASONING: 'none' }, fetchImpl: async (u, o) => { const b = JSON.parse(o.body); calls.push(b); return b.reasoning ? respErr(400, { type: 'invalid_request_error', message: "Unsupported value: 'none' is not supported with the 'gpt-6.1-sol' model for reasoning.effort." }) : respOk(answerJson('Ok.')); } });
  assert.equal(calls.length, 2); assert.equal(calls[1].reasoning, undefined); assert.match(out.text, /Ok/);
});

test('openai call: a model that refuses a setting is retried once with only the essentials', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body); calls.push(body);
    if (body.reasoning || body.text) return respErr(400, { type: 'invalid_request_error', message: "Unsupported parameter: 'reasoning.effort' is not supported with this model." });
    return respOk(answerJson('Fine.'));
  };
  const out = await providers.callOpenAI({ system: 's', messages: [{ role: 'user', content: 'x' }], env: ENV, fetchImpl });
  assert.equal(calls.length, 2); assert.equal(calls[1].reasoning, undefined); assert.equal(calls[1].text, undefined);
  assert.equal(calls[1].instructions, 's'); assert.deepEqual(calls[1].input, [{ role: 'user', content: 'x' }]);
  assert.match(out.text, /Fine/);
  // an unrelated 400 is not retried
  const n = []; await assert.rejects(() => providers.callOpenAI({ system: 's', messages: [], env: ENV, fetchImpl: async () => { n.push(1); return respErr(400, { type: 'invalid_request_error', message: 'Invalid value in input[0].content' }); } }), (e) => e.code === 'bad_request');
  assert.equal(n.length, 1);
});

test('openai errors: each failure has a plain message and a code; nothing sensitive reaches the user; the log has the details', async () => {
  const logged = []; const orig = console.error; console.error = (...a) => logged.push(a.join(' '));
  try {
    const run = (status, error) => providers.callOpenAI({ system: 's', messages: [], env: ENV, fetchImpl: async () => respErr(status, error) });
    const expect = async (status, error, code, rx) => assert.rejects(() => run(status, error), (e) => { assert.equal(e.code, code, `${status} ${code}`); if (rx) assert.match(e.message, rx); assert.doesNotMatch(e.message, /sk-|unit-secret/); return true; });
    await expect(401, { type: 'invalid_request_error', code: 'invalid_api_key', message: `Incorrect API key provided: ${OPENAI_KEY}` }, 'auth_failed', /rejected the API key/);
    await expect(403, { type: 'invalid_request_error', code: 'unsupported_country_region_territory', message: 'blocked' }, 'auth_failed', /refused access/);
    await expect(429, { type: 'insufficient_quota', code: 'insufficient_quota', message: 'You exceeded your current quota' }, 'billing', /billed separately from a ChatGPT subscription/);
    await expect(429, { type: 'rate_limit_error', code: 'rate_limit_exceeded', message: 'slow down' }, 'rate_limited', /rate limiting/);
    await expect(404, { type: 'invalid_request_error', code: 'model_not_found', message: 'The model `gpt-9` does not exist' }, 'model_not_found', /OPENAI_COPY_MODEL/);
    await expect(400, { type: 'invalid_request_error', message: `odd value ${OPENAI_KEY} in input` }, 'bad_request', /400 invalid_request_error.*req_oa1/);
    await expect(500, { type: 'server_error', message: 'boom' }, 'api_error', /returned an error \(500\)/);
    await assert.rejects(() => providers.callOpenAI({ system: 's', messages: [], env: ENV, fetchImpl: async () => { throw new Error('ECONNRESET'); } }), (e) => e.code === 'network');
    const bad = await run(400, { type: 'invalid_request_error', message: `odd value ${OPENAI_KEY} in input` }).catch((e) => e);
    assert.doesNotMatch(JSON.stringify(bad.detail), /unit-secret/); assert.equal(bad.status, 400);
    assert.ok(logged.length >= 7 && logged.every((l) => /^\[copy-ai\] openai error status=\d+ type=\S+ code=\S+ model=gpt-6.1-sol request_id=\S+ message=/.test(l)));
    assert.ok(logged.every((l) => !l.includes(OPENAI_KEY) && !/unit-secret/.test(l)), 'the key never reaches the log');
  } finally { console.error = orig; }
});

test('openai results: incomplete, refused and empty answers are reported, not shown as copy', async () => {
  const mk = (json) => async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => json });
  const call = (json) => providers.callOpenAI({ system: 's', messages: [], env: ENV, fetchImpl: mk(json) });
  await assert.rejects(() => call({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }), (e) => e.code === 'truncated');
  await assert.rejects(() => call({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] }), (e) => e.code === 'rejected');
  await assert.rejects(() => call({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }), (e) => e.code === 'rejected');
  await assert.rejects(() => call({ status: 'completed', output: [{ type: 'reasoning' }] }), (e) => e.code === 'empty');
  await assert.rejects(() => call({ status: 'failed', error: { type: 'server_error', message: `bad ${OPENAI_KEY}` }, output: [] }), (e) => e.code === 'api_error' && !/unit-secret/.test(JSON.stringify(e.detail)));
});

// ── 3. both providers receive the same inputs and go through the same guard ──────────────────────────────────────────
const FACTS = { productName: 'ASSET RAGLAN BOX FIT TEE', productCategory: 'BOX FIT TEE', productNames: ['ASSET RAGLAN BOX FIT TEE'], adCategoryLabel: 'Core', copyType: 'core', copyTypeLabel: 'Core / Evergreen', newnessAllowed: false, isPromotion: false, format: 'video', conceptName: 'One tee three fits', hook: 'Stop scrolling' };
const EXAMPLES = [{ id: 1, tab: 'CORE', label: null, body: '[PRODUCT] \u{1F525}\n\n[DETAIL]\n\nwww.wndrr.com' }, { id: 2, tab: 'CORE 26', label: null, body: 'Meet [PRODUCT]. Cop yours \u{1F447}' }];
const GOOD = ['Clean lines, easy to wear, made for every day.', 'Cop the ASSET RAGLAN BOX FIT TEE and keep it simple.', 'Weekend plans sorted. Pick up the ASSET RAGLAN BOX FIT TEE.'];

function recordingProviders() {
  const claude = []; const gpt = [];
  const fetchClaude = async (url, opts) => { claude.push(JSON.parse(opts.body)); return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: answerJson(...GOOD) }] }) }; };
  const fetchGpt = async (url, opts) => { gpt.push(JSON.parse(opts.body)); return respOk(answerJson(...GOOD)); };
  return { claude, gpt, callClaude: (req) => providers.callProvider('anthropic', { ...req, env: ENV, fetchImpl: fetchClaude }), callGpt: (req) => providers.callProvider('openai', { ...req, env: ENV, fetchImpl: fetchGpt }) };
}

test('equal inputs: the same prompt, references and history reach both providers; only the transport differs', async () => {
  const r = recordingProviders();
  const args = { facts: FACTS, guidelines: 'Short sentences.', examples: EXAMPLES, referenceTexts: ['x'], instruction: '', ruleKey: 'standard', copyType: 'core', history: [{ kind: 'generate', instruction: null, options: [{ angle: 'a', text: 'earlier answer' }] }], previousTexts: ['earlier answer'] };
  for (const mode of ['generate', 'more']) {
    r.claude.length = 0; r.gpt.length = 0;
    const a = await ai.generate({ ...args, mode, call: r.callClaude });
    const b = await ai.generate({ ...args, mode, call: r.callGpt });
    assert.equal(r.claude.length, 1); assert.equal(r.gpt.length, 1);
    assert.equal(r.claude[0].system, r.gpt[0].instructions, `${mode}: identical brand instructions`);
    assert.deepEqual(r.claude[0].messages, r.gpt[0].input, `${mode}: identical messages (facts, creative direction, copy type, masked references, history)`);
    assert.deepEqual(a.options, b.options);
  }
  const prompt = r.gpt[0].input[r.gpt[0].input.length - 1].content;
  assert.match(prompt, /COPY TYPE: Core/); assert.match(prompt, /Reference 2 \(CORE 26\)/); assert.match(prompt, /CREATIVE DIRECTION/);
});

test('copy type overrides reach both providers the same way', async () => {
  const r = recordingProviders();
  for (const type of ['bundle', 'new_range', 'sale']) {
    r.claude.length = 0; r.gpt.length = 0;
    const facts = { ...FACTS, copyType: type };
    await ai.generate({ facts, guidelines: '', examples: EXAMPLES, ruleKey: 'standard', copyType: type, call: r.callClaude });
    await ai.generate({ facts, guidelines: '', examples: EXAMPLES, ruleKey: 'standard', copyType: type, call: r.callGpt });
    const label = require('../src/lib/copyTypes').LABELS[type];
    assert.match(r.claude[0].messages[0].content, new RegExp(`COPY TYPE: ${label.replace(/[/]/g, '\\/')}`));
    assert.deepEqual(r.claude[0].messages, r.gpt[0].input);
  }
});

test('the factual safeguards apply to OpenAI answers exactly as to Claude answers', async () => {
  const bad = ['One tee, three completely different fits.', 'Our best-selling tee, now in 8 colourways.', 'Heavy weight cotton, soft feel.'];
  for (const p of ['anthropic', 'openai']) {
    const fetchImpl = async () => (p === 'openai' ? respOk(answerJson(...bad, ...GOOD)) : { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: answerJson(...bad, ...GOOD) }] }) });
    const out = await ai.generate({ facts: FACTS, guidelines: '', examples: EXAMPLES, ruleKey: 'standard', copyType: 'core', call: (req) => providers.callProvider(p, { ...req, env: ENV, fetchImpl }) });
    assert.equal(out.options.length, 3, p);
    assert.ok(out.options.every((o) => !/three completely different fits|best-selling|colourways|cotton/i.test(o.text)), `${p}: unsupported claims are dropped`);
    assert.equal(out.dropped.length, 3, p);
    const allBad = await ai.generate({ facts: FACTS, guidelines: '', examples: EXAMPLES, ruleKey: 'standard', copyType: 'core', call: async () => ({ text: answerJson(...bad), model: 'm' }) }).catch((e) => e);
    assert.equal(allBad.code, 'rejected');
  }
});

test('claude: the request is unchanged by the provider work', async () => {
  let seen;
  await providers.callProvider('anthropic', { system: 's', messages: [{ role: 'user', content: 'x' }], env: ENV, fetchImpl: async (u, o) => { seen = { u, o, b: JSON.parse(o.body) }; return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ model: 'm', content: [{ type: 'text', text: 'hi' }] }) }; } });
  assert.equal(seen.u, 'http://anthropic-mock/v1/messages');
  assert.deepEqual(Object.keys(seen.b).sort(), ['max_tokens', 'messages', 'model', 'system']);
  assert.equal(seen.o.headers['x-api-key'], ANTHROPIC_KEY); assert.equal(seen.b.model, ai.DEFAULT_MODEL);
  assert.ok(!seen.o.headers.authorization);
});

// ── 4. wiring ──────────────────────────────────────────────────────────────────────────────────────────────────────
test('wiring (server): provider choice, per-provider history, saved provider and model, results of both kept, approval untouched', () => {
  const route = read('src/routes/copyAssistant.js');
  assert.match(route, /body\.provider === undefined/); assert.match(route, /providers\.DEFAULT_PROVIDER/);
  assert.match(route, /provider must be one of/);
  assert.match(route, /call: \(request\) => providers\.callProvider\(provider, request\)/);
  assert.match(route, /COALESCE\(provider, 'anthropic'\) = \$2/, "a provider's history holds only its own answers");
  assert.match(route, /copy_type, copy_type_source, provider\)/); assert.match(route, /out\.model, JSON\.stringify\(examples\.map/);
  assert.match(route, /async function loadResults/); assert.match(route, /DISTINCT ON \(COALESCE\(provider, 'anthropic'\)/);
  assert.match(route, /billing: 402/);
  assert.doesNotMatch(route, /OPENAI_API_KEY/, 'the route never reads a key');
  assert.match(route, /ai_draft_options = \$1::jsonb/, 'the existing "latest suggestions" bookkeeping is unchanged');
  const adSetup = read('src/routes/adSetup.js');
  assert.match(adSetup, /router\.post\('\/:id\/approve-primary-text'/);
  assert.doesNotMatch(adSetup, /provider/i, 'approval does not depend on, or record, a provider choice');
  const schema = read('db/schema.sql');
  assert.match(schema, /ALTER TABLE ad_copy_generations ADD COLUMN IF NOT EXISTS provider VARCHAR\(12\)/);
  assert.match(schema, /provider IS NULL OR provider IN \('anthropic', 'openai'\)/);
});

test('wiring (browser): selector, labelled per-provider results, both-provider button, nothing replaced on switching, no credentials', () => {
  const app = read('public/app.js');
  for (const fn of ['setAdSetupProvider', 'runAdSetupProvider', 'generateAdSetupCopyBoth']) assert.match(app, new RegExp(`function ${fn}\\(`));
  assert.match(app, /provider: 'anthropic', sets: \{ anthropic: null, openai: null \}/, 'Claude is the default');
  assert.match(app, /Generate with both/); assert.match(app, /Give me another three/); assert.match(app, /Approve Primary Text/); assert.match(app, /refineAdSetupCopy/);
  assert.match(app, /as-prov-tag as-prov-tag-\$\{p\}/, 'every option is tagged with its provider');
  const sw = app.slice(app.indexOf('function setAdSetupProvider'), app.indexOf('// One request to one provider'));
  assert.doesNotMatch(sw, /selected_primary_text|asAi\.sets\s*=|primary_text_approved/, 'switching providers touches no results and no Primary Text');
  const run = app.slice(app.indexOf('async function runAdSetupProvider'), app.indexOf('async function generateAdSetupCopy('));
  assert.match(run, /asAi\.sets\[provider\] = apply === 'revision'/, "a result replaces only that provider's own entry");
  assert.doesNotMatch(app, /OPENAI_API_KEY\s*[:=]|sk-proj|Bearer /, 'no credential handling in the browser code');
  assert.doesNotMatch(read('src/routes/copyAssistant.js'), /\.json\(\{[^}]*key[^}]*\}\)/i);
});
