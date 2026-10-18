// AI providers for the Ad Setup AI Copy Assistant: Claude (Anthropic) and OpenAI, side by side for a controlled comparison.
//
// Only the TRANSPORT differs. Everything that decides what is written (copy type, reference selection, verified facts, brand instructions, the facts guard) lives in
// lib/copyAi.js and the route and is identical for both: `generate()` builds one { system, messages } and hands it to whichever provider call is injected.
//
// Anthropic is unchanged (copyAi.callModel). OpenAI uses the Responses API (POST /v1/responses), OpenAI's recommended text API for new work.
//
// Request settings, all documented for the GPT-6 models on the Responses API: `instructions` + `input`; `text.format` json_schema (strict) for the JSON answer; `reasoning.effort`
// (low by default: copywriting needs little reasoning); `max_output_tokens` (counts reasoning as well as the visible answer; minimum 16); `store: false` (stateless: nothing kept by OpenAI).
// temperature / top_p are NOT sent: they are rejected whenever reasoning is active.
//
// Configuration (server environment only; never in code, the browser, logs or responses):
//   ANTHROPIC_API_KEY, COPY_AI_MODEL                 Claude (existing)
//   OPENAI_API_KEY                                   OpenAI. API usage is billed separately from any ChatGPT subscription.
//   OPENAI_COPY_MODEL      optional, default below
//   OPENAI_COPY_REASONING  optional, default "low" (none | low | medium | high | xhigh; use "off" to send no reasoning setting)
//   OPENAI_API_BASE        tests only
const copyAi = require('./copyAi');

const { AiError, scrub } = copyAi;

const PROVIDERS = {
  anthropic: { id: 'anthropic', label: 'Claude' },
  openai: { id: 'openai', label: 'OpenAI' },
};
const DEFAULT_PROVIDER = 'anthropic';
// Default model: `gpt-6.1-sol`, as chosen for release (v1.4.6). OpenAI's own model pages list it on the Responses API (/v1/responses) with structured outputs, at $2 / $10 per 1M input / output tokens
// (cached input $0.10). It takes reasoning effort `low` and above only (no `none` / `minimal`), which is why the default effort is `low`. `gpt-6-sol` (verified the same way) remains selectable with
// OPENAI_COPY_MODEL, no code change needed. Any other model id can be set the same way.
const OPENAI_DEFAULT_MODEL = 'gpt-6.1-sol';
const OPENAI_TIMEOUT_MS = 90000;
const OPENAI_MAX_OUTPUT_TOKENS = 8000; // reasoning tokens count toward this limit as well as the visible answer

const isProvider = (p) => Object.prototype.hasOwnProperty.call(PROVIDERS, p);
// A row saved before providers existed has no provider: it was Claude.
const providerOf = (p) => (isProvider(p) ? p : DEFAULT_PROVIDER);
const providerLabel = (p) => PROVIDERS[providerOf(p)].label;

function openaiConfig(env = process.env) {
  const rawValue = env.OPENAI_API_KEY;
  const key = String(rawValue === undefined ? '' : rawValue).trim().replace(/^["']+|["']+$/g, '').trim();
  const model = String(env.OPENAI_COPY_MODEL || OPENAI_DEFAULT_MODEL).trim();
  const reasoning = String(env.OPENAI_COPY_REASONING || 'low').trim().toLowerCase();
  if (key) return { configured: true, model, key, reasoning, reason: null };
  const near = Object.keys(env).filter((k) => /openai/i.test(k) && k !== 'OPENAI_API_KEY' && k !== 'OPENAI_COPY_MODEL' && k !== 'OPENAI_COPY_REASONING' && k !== 'OPENAI_API_BASE');
  let reason;
  if (rawValue !== undefined) reason = 'OPENAI_API_KEY exists on the server but its value is empty. Set the key as the variable value and redeploy.';
  else if (near.length) reason = `OPENAI_API_KEY is not set on this server. Variables with similar names were found (${near.join(', ')}); only OPENAI_API_KEY is read.`;
  else reason = 'OPENAI_API_KEY is not set on this server. Add an OpenAI API key (API billing is separate from a ChatGPT subscription) to the Railway service that runs the app and let it redeploy.';
  return { configured: false, model, key: null, reasoning, reason };
}

// → { id, label, configured, model, reason } (never the key)
function providerConfig(provider, env = process.env) {
  if (provider === 'openai') { const c = openaiConfig(env); return { id: 'openai', label: 'OpenAI', configured: c.configured, model: c.model, reason: c.reason }; }
  const c = copyAi.aiConfig(env);
  return { id: 'anthropic', label: 'Claude', configured: c.configured, model: c.model, reason: c.reason };
}
const allProviders = (env = process.env) => Object.keys(PROVIDERS).map((p) => providerConfig(p, env));

// ── OpenAI (Responses API) ─────────────────────────────────────────────────────────────────────────────────────────────
// The answer is requested as JSON in exactly the shape the assistant already parses ({ options: [{ angle, text }] }).
const OPTIONS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['options'],
  properties: { options: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['angle', 'text'], properties: { angle: { type: 'string' }, text: { type: 'string' } } } } },
};

function openaiBody(cfg, { system, messages, maxTokens }, { minimal = false } = {}) {
  const body = {
    model: cfg.model,
    instructions: system,
    input: messages.map((m) => ({ role: m.role, content: m.content })),
    max_output_tokens: maxTokens || OPENAI_MAX_OUTPUT_TOKENS,
    store: false, // the request is not kept in OpenAI's response store
  };
  if (!minimal) {
    body.text = { format: { type: 'json_schema', name: 'primary_text_options', strict: true, schema: OPTIONS_SCHEMA } };
    if (cfg.reasoning && cfg.reasoning !== 'off') body.reasoning = { effort: cfg.reasoning };
  }
  return body;
}

async function openaiDetail(res, key, model) {
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  const err = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : {};
  const header = (n) => { try { return res.headers && res.headers.get ? res.headers.get(n) : null; } catch (e) { return null; } };
  return {
    status: res.status, type: typeof err.type === 'string' ? err.type.slice(0, 60) : null, code: typeof err.code === 'string' ? err.code.slice(0, 60) : null,
    message: scrub(err.message, key), request_id: scrub(header('x-request-id') || header('request-id') || '', key) || null, model,
  };
}
function logOpenAiError(d) {
  // one line, no credentials: status, error type / code, scrubbed provider message, request id, model
  console.error(`[copy-ai] openai error status=${d.status} type=${d.type || 'unknown'} code=${d.code || 'n/a'} model=${d.model} request_id=${d.request_id || 'n/a'} message="${d.message}"`);
}

// A model that does not take a setting we send (reasoning effort, structured output) answers 400 naming it: retry once with only the essentials.
const SETTING_REJECTED = /reasoning|text\.format|json_schema|response_format|unsupported (?:parameter|value)|not supported with this model/i;

async function callOpenAI({ system, messages, maxTokens, env = process.env, fetchImpl = fetch }) {
  const cfg = openaiConfig(env);
  if (!cfg.configured) throw new AiError('not_configured', cfg.reason);
  const base = env.OPENAI_API_BASE || 'https://api.openai.com';
  const send = async (body) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
    try {
      return await fetchImpl(`${base}/v1/responses`, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new AiError('network', e.name === 'AbortError' ? 'OpenAI took too long to answer. Try again.' : `Could not reach OpenAI: ${e.message}`);
    } finally { clearTimeout(timer); }
  };
  let res = await send(openaiBody(cfg, { system, messages, maxTokens }));
  let detail = null;
  if (res.status === 400) {
    detail = await openaiDetail(res, cfg.key, cfg.model);
    if (SETTING_REJECTED.test(`${detail.message} ${detail.code || ''}`)) { res = await send(openaiBody(cfg, { system, messages, maxTokens }, { minimal: true })); detail = null; }
  }
  if (!res.ok) {
    detail = detail || await openaiDetail(res, cfg.key, cfg.model);
    logOpenAiError(detail);
    const ref = detail.request_id ? ` Reference: ${detail.request_id}.` : '';
    if (res.status === 401) throw new AiError('auth_failed', 'OpenAI rejected the API key.', 401, detail);
    if (res.status === 403) throw new AiError('auth_failed', `OpenAI refused access (403${detail.code ? ` ${detail.code}` : ''}). Check that the key's project may use this model.${ref}`, 403, detail);
    if (res.status === 429 && detail.code === 'insufficient_quota') throw new AiError('billing', 'OpenAI reports no API credit or quota for this key. OpenAI API usage is billed separately from a ChatGPT subscription: add credit in the OpenAI platform billing settings.', 402, detail);
    if (res.status === 429) throw new AiError('rate_limited', 'OpenAI is rate limiting requests. Try again shortly.', 429, detail);
    if (res.status === 404 || detail.code === 'model_not_found') throw new AiError('model_not_found', `OpenAI does not know the configured model (${cfg.model}) for this key. Check OPENAI_COPY_MODEL.${ref}`, res.status, detail);
    if (res.status === 400) throw new AiError('bad_request', `OpenAI rejected the request (400${detail.type ? ` ${detail.type}` : ''}). The cause is recorded in the server log.${ref}`, 400, detail);
    throw new AiError('api_error', `OpenAI returned an error (${res.status}).${ref}`, res.status, detail);
  }
  const json = await res.json();
  if (json.status === 'incomplete') {
    const why = json.incomplete_details && json.incomplete_details.reason;
    throw new AiError(why === 'content_filter' ? 'rejected' : 'truncated', why === 'content_filter' ? 'OpenAI declined to write this copy. Try again, or write it yourself.' : 'The OpenAI answer was cut off before it finished. Try again.');
  }
  if (json.status === 'failed') throw new AiError('api_error', 'OpenAI could not complete the request. Try again.', 502, { status: 502, type: json.error && json.error.type, message: scrub(json.error && json.error.message, cfg.key), model: cfg.model });
  const parts = (json.output || []).filter((o) => o && o.type === 'message').flatMap((o) => (Array.isArray(o.content) ? o.content : []));
  if (parts.some((c) => c.type === 'refusal')) throw new AiError('rejected', 'OpenAI declined to write this copy. Try again, or write it yourself.');
  const text = parts.filter((c) => c.type === 'output_text').map((c) => c.text).join('\n').trim();
  if (!text) throw new AiError('empty', 'OpenAI returned no text.');
  return { text, model: json.model || cfg.model };
}

// One entry point for both providers. `req` is exactly what generate() builds: { system, messages, ... }.
function callProvider(provider, req) {
  return provider === 'openai' ? callOpenAI(req) : copyAi.callModel(req);
}

module.exports = {
  PROVIDERS, DEFAULT_PROVIDER, OPENAI_DEFAULT_MODEL, isProvider, providerOf, providerLabel, providerConfig, allProviders, openaiConfig, callOpenAI, callProvider, openaiBody, OPTIONS_SCHEMA,
};
