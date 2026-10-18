const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ai = require('../src/lib/copyAi');
const library = require('../src/lib/copyLibrary');

// A fake of the Anthropic Messages endpoint that behaves like the current Sonnet models: a non-default sampling parameter is an HTTP 400.
function strictProvider(script) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    const json = (obj) => async () => obj;
    if ((body.temperature !== undefined && body.temperature !== 1) || body.top_p !== undefined || body.top_k !== undefined) {
      return { ok: false, status: 400, headers: { get: (n) => (n === 'request-id' ? 'req_unit400' : null) }, json: async () => ({ type: 'error', error: { type: 'invalid_request_error', message: '`temperature` may only be set to 1 for this model' } }) };
    }
    const next = script.shift();
    if (next && next.status) return { ok: false, status: next.status, headers: { get: () => null }, json: async () => next.body || {} };
    if (next && next.stop) return { ok: true, status: 200, json: json({ model: body.model, stop_reason: next.stop, content: [{ type: 'text', text: '{"options":[' }] }) };
    return { ok: true, status: 200, json: json({ model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ options: next.map((t, i) => ({ angle: `a${i}`, text: t })) }) }] }) };
  };
  return { calls, fetchImpl };
}
const ENV = { ANTHROPIC_API_KEY: 'sk-ant-unit-secret-0123456789', ANTHROPIC_API_BASE: 'http://mock' };
const FACTS = { productName: 'ASSET RAGLAN BOX FIT TEE', productNames: ['ASSET RAGLAN BOX FIT TEE'], productCategory: 'Box Fit Tee', adCategoryLabel: 'Product', isPromotion: false, conceptName: 'Three ways', hook: 'Stop scrolling' };
const EXAMPLES = [{ id: 1, tab: 'CORE', label: 'Asset Raglan Tee', body: 'Your new favourite tee.\nBoxy fit, soft feel, made to be worn on repeat.' }];
const THREE = ['Boxy fit that sits right on the body.', 'Pair it back with relaxed cargos and clean sneakers.', 'One tee, three easy ways to wear it all week.'];
const call = (strict) => (req) => ai.callModel({ ...req, env: ENV, fetchImpl: strict.fetchImpl });

test('HTTP 400 root cause: the request no longer carries temperature / top_p / top_k', async () => {
  const p = strictProvider([THREE]);
  const out = await ai.generate({ facts: FACTS, guidelines: '', examples: EXAMPLES, ruleKey: 'standard', call: call(p) });
  assert.equal(out.options.length, 3);
  assert.equal(p.calls.length, 1);
  for (const b of p.calls) { assert.equal(b.temperature, undefined); assert.equal(b.top_p, undefined); assert.equal(b.top_k, undefined); }
});

test('the request leaves room for adaptive thinking and uses the configured model', async () => {
  const p = strictProvider([THREE]);
  await ai.generate({ facts: FACTS, guidelines: '', examples: EXAMPLES, ruleKey: 'standard', call: (req) => ai.callModel({ ...req, env: { ...ENV, COPY_AI_MODEL: 'claude-sonnet-5-5' }, fetchImpl: p.fetchImpl }) });
  assert.ok(p.calls[0].max_tokens >= 4000);
  assert.equal(p.calls[0].model, 'claude-sonnet-5-5');
  assert.equal(ai.DEFAULT_MODEL, 'claude-sonnet-5-5');
});

test('the Copy Library examples are part of the request; three options come back; refinement stays functional', async () => {
  const p = strictProvider([THREE, ['Boxy fit, easy to style.']]);
  const out = await ai.generate({ facts: FACTS, guidelines: 'Short sentences.', examples: EXAMPLES, ruleKey: 'standard', call: call(p) });
  assert.equal(out.options.length, 3);
  const sent = JSON.stringify(p.calls[0].messages);
  assert.match(sent, /Boxy fit, soft feel, made to be worn on repeat/);
  assert.match(sent, /Short sentences/);
  assert.match(sent, /ASSET RAGLAN BOX FIT TEE/);
  const ref = await ai.generate({ mode: 'refine', facts: FACTS, guidelines: '', examples: EXAMPLES, ruleKey: 'standard', instruction: 'shorter', baseText: THREE[0], call: call(p) });
  assert.equal(ref.options.length, 1);
  assert.match(JSON.stringify(p.calls[1].messages), /shorter/);
});

test('unsupported product claims are still blocked', async () => {
  const bad = ['Now 30% off the tee!', 'Free shipping on every order.', 'Only $20 today.'];
  const p = strictProvider([bad, bad]);
  await assert.rejects(() => ai.generate({ facts: FACTS, guidelines: '', examples: EXAMPLES, ruleKey: 'standard', call: call(p) }), (e) => e.code === 'rejected');
  assert.equal(p.calls.length, 2, 'one retry, then rejected');
});

test('library example selection is unchanged (same families and ordering rules)', () => {
  const all = [{ id: 1, family: 'core', body: 'x', label: 'Asset Raglan Tee' }, { id: 2, family: 'sales', body: 'y', label: 'Black Friday' }];
  const picked = library.selectExamples(all, { adCategory: 'core', productName: 'ASSET RAGLAN BOX FIT TEE', productCategory: 'Box Fit Tee' });
  assert.deepEqual(picked.map((e) => e.id), [1]);
});

test('a provider 400 is reported with status, type and reference only; the provider message and key never reach the user', async () => {
  const logged = [];
  const orig = console.error; console.error = (...a) => logged.push(a.join(' '));
  try {
    const secretMsg = 'odd value in messages.0 sk-ant-unit-secret-0123456789 and sk-ant-other-abcdefghijkl';
    const fetchImpl = async () => ({ ok: false, status: 400, headers: { get: () => null }, json: async () => ({ type: 'error', error: { type: 'invalid_request_error', message: secretMsg }, request_id: 'req_abc123' }) });
    await assert.rejects(() => ai.callModel({ system: 's', messages: [], env: ENV, fetchImpl }), (e) => {
      assert.equal(e.code, 'bad_request'); assert.equal(e.status, 400);
      assert.match(e.message, /400 invalid_request_error/); assert.match(e.message, /req_abc123/);
      assert.doesNotMatch(e.message, /odd value|sk-ant/);
      assert.doesNotMatch(JSON.stringify(e.detail), /sk-ant-unit-secret|sk-ant-other/);
      return true;
    });
    assert.equal(logged.length, 1);
    assert.match(logged[0], /\[copy-ai\] provider error status=400 type=invalid_request_error model=claude-sonnet-5-5 request_id=req_abc123/);
    assert.match(logged[0], /odd value in messages\.0/);
    assert.doesNotMatch(logged[0], /sk-ant/);
  } finally { console.error = orig; }
});

test('other provider failures keep their codes; unknown model, truncation and refusal are told apart', async () => {
  const quiet = console.error; console.error = () => {};
  try {
    for (const [status, code] of [[401, 'auth_failed'], [403, 'auth_failed'], [404, 'model_not_found'], [429, 'rate_limited'], [500, 'api_error'], [529, 'api_error']]) {
      const p = strictProvider([{ status, body: {} }]);
      await assert.rejects(() => ai.callModel({ system: 's', messages: [], env: ENV, fetchImpl: p.fetchImpl }), (e) => e.code === code && !/sk-ant/.test(e.message));
    }
  } finally { console.error = quiet; }
  await assert.rejects(() => ai.callModel({ system: 's', messages: [], env: ENV, fetchImpl: strictProvider([{ stop: 'max_tokens' }]).fetchImpl }), (e) => e.code === 'truncated');
  await assert.rejects(() => ai.callModel({ system: 's', messages: [], env: ENV, fetchImpl: strictProvider([{ stop: 'refusal' }]).fetchImpl }), (e) => e.code === 'rejected');
});

test('scrub removes the configured key, key-shaped tokens and auth headers, and bounds the length', () => {
  const out = ai.scrub('key sk-ant-api03-ABCDEFGHIJ and mine-12345 x-api-key: abc123 Bearer tok', 'mine-12345');
  assert.doesNotMatch(out, /sk-ant|mine-12345|abc123|tok$/);
  assert.ok(ai.scrub('a'.repeat(5000)).length <= 400);
});

test('wiring: no caller sets a sampling parameter, and the new error codes are mapped to a status', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'copyAssistant.js'), 'utf8');
  assert.doesNotMatch(src, /temperature|top_p|top_k/);
  assert.match(src, /bad_request: 502/); assert.match(src, /model_not_found: 502/); assert.match(src, /truncated: 502/);
  const lib = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'copyAi.js'), 'utf8');
  assert.doesNotMatch(lib.replace(/\/\/.*$/gm, ''), /temperature|top_p|top_k/);
});
