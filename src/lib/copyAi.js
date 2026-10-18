// WNDRR AI Copy Assistant: Primary Text generation and refinement for Meta ads.
//
// Headline, Description and CTA are NOT written here (see lib/adCopyRules.js). This module only produces Primary Text options, from
//   * facts the application actually holds (product, category, campaign, stage, concept, format, verified offer), and
//   * reference examples + statistics from the WNDRR copy library (lib/copyLibrary.js), used as references, never to be copied verbatim.
// Every generated option is checked against those facts: discounts, prices, specifications, GSM, fabric, stock, shipping and deadlines that
// are not in the facts are rejected. If the provider is not configured, or the library has never been read, nothing is generated.
//
// Configuration: ANTHROPIC_API_KEY (required), COPY_AI_MODEL (optional, default below). ANTHROPIC_API_BASE exists for tests only.

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const MAX_PRIMARY_TEXT = 2200;

class AiError extends Error {
  // `detail` is for the server log only (sanitised provider diagnostics); it is never sent to the browser.
  constructor(code, message, status, detail) { super(message); this.code = code; this.status = status || null; this.detail = detail || null; }
}

// Provider diagnostics that are safe to log: the HTTP status, the provider's error type, its (credential-scrubbed, truncated) message and its request id.
// The message is NEVER returned to the browser: it can quote parts of the request. Any key-shaped token, and the configured key itself, is removed.
function scrub(text, key) {
  let t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (key) t = t.split(key).join('[redacted]');
  return t.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]').replace(/(x-api-key|authorization|bearer)\s*[:=]?\s*\S+/gi, '$1 [redacted]').slice(0, 400);
}
async function providerDetail(res, key, model) {
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  const err = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : {};
  const header = (n) => { try { return res.headers && res.headers.get ? res.headers.get(n) : null; } catch (e) { return null; } };
  return {
    status: res.status, type: typeof err.type === 'string' ? err.type.slice(0, 60) : null, message: scrub(err.message, key),
    request_id: scrub((body && body.request_id) || header('request-id') || header('x-request-id') || '', key) || null, model,
  };
}
function logProviderError(detail) {
  // one line, no credentials: status, error type, scrubbed provider message, request id, model
  console.error(`[copy-ai] provider error status=${detail.status} type=${detail.type || 'unknown'} model=${detail.model} request_id=${detail.request_id || 'n/a'} message="${detail.message}"`);
}

// The key is read from the server environment at request time (never cached, never sent to the browser). Surrounding quotes and whitespace that
// are easy to paste in by accident are ignored. When it is missing the reason names exactly what the process can see (variable NAMES only, never values),
// so a misnamed variable, an empty value or a service that was not redeployed after adding it can be told apart.
function aiConfig(env = process.env) {
  const rawValue = env.ANTHROPIC_API_KEY;
  const key = String(rawValue === undefined ? '' : rawValue).trim().replace(/^["']+|["']+$/g, '').trim();
  const model = (env.COPY_AI_MODEL || DEFAULT_MODEL).trim();
  if (key) return { configured: true, model, key, reason: null };
  const near = Object.keys(env).filter((k) => /anthropic|claude/i.test(k) && k !== 'ANTHROPIC_API_KEY');
  let reason;
  if (rawValue !== undefined) reason = 'ANTHROPIC_API_KEY exists on the server but its value is empty. Set the key as the variable value and redeploy.';
  else if (near.length) reason = `ANTHROPIC_API_KEY is not set on this server. Variables with similar names were found (${near.join(', ')}); the assistant only reads ANTHROPIC_API_KEY.`;
  else reason = 'ANTHROPIC_API_KEY is not set on this server. Add it to the Railway service that runs the app (not another service or a different environment) and let it redeploy.';
  return { configured: false, model, key: null, reason };
}

// No sampling parameters (temperature / top_p / top_k) are sent. The current Claude models reject a non-default value with HTTP 400 and default to adaptive thinking, whose tokens
// count toward max_tokens -- so the default limit leaves room for the reasoning as well as three Primary Text options. Variety between options comes from the prompt (one angle each).
async function callModel({ system, messages, maxTokens = 8000, env = process.env, fetchImpl = fetch }) {
  const cfg = aiConfig(env);
  if (!cfg.configured) throw new AiError('not_configured', cfg.reason);
  const base = env.ANTHROPIC_API_BASE || 'https://api.anthropic.com';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let res;
  try {
    res = await fetchImpl(`${base}/v1/messages`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, system, messages }),
    });
  } catch (e) {
    throw new AiError('network', e.name === 'AbortError' ? 'The AI provider took too long to answer. Try again.' : `Could not reach the AI provider: ${e.message}`);
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    const detail = await providerDetail(res, cfg.key, cfg.model);
    logProviderError(detail);
    const ref = detail.request_id ? ` Reference: ${detail.request_id}.` : '';
    if (res.status === 401 || res.status === 403) throw new AiError('auth_failed', 'The AI provider rejected the API key.', res.status, detail);
    if (res.status === 429) throw new AiError('rate_limited', 'The AI provider is rate limiting requests. Try again shortly.', 429, detail);
    if (res.status === 400) throw new AiError('bad_request', `The AI provider rejected the request (400${detail.type ? ` ${detail.type}` : ''}). The cause is recorded in the server log.${ref}`, 400, detail);
    if (res.status === 404) throw new AiError('model_not_found', `The AI provider does not know the configured model (${cfg.model}). Check COPY_AI_MODEL.${ref}`, 404, detail);
    throw new AiError('api_error', `The AI provider returned an error (${res.status}).${ref}`, res.status, detail);
  }
  const json = await res.json();
  if (json.stop_reason === 'refusal') throw new AiError('rejected', 'The AI provider declined to write this copy. Try again, or write it yourself.');
  if (json.stop_reason === 'max_tokens') throw new AiError('truncated', 'The AI answer was cut off before it finished. Try again.');
  const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) throw new AiError('empty', 'The AI provider returned no text.');
  return { text, model: json.model || cfg.model };
}

// ── facts guard ─────────────────────────────────────────────────────────────────────────────────────────────────────
const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday|tonight|tomorrow|midnight|weekend';
const RULES = [
  { code: 'discount', re: /\b\d{1,3}(?:\.\d+)?\s?(?:%|percent)/gi, numeric: true, label: 'a percentage' },
  { code: 'price', re: /(?:[$€£]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:aud|usd|dollars?|bucks)\b)/gi, numeric: true, label: 'a price' },
  { code: 'gsm', re: /\b\d{2,4}\s?gsm\b/gi, numeric: true, label: 'a fabric weight (GSM)' },
  { code: 'fabric', re: /\b(?:cotton|polyester|nylon|linen|wool|fleece|terry|denim|viscose|elastane|spandex|rayon|merino|organic cotton|heavyweight|lightweight|breathable|moisture[- ]wicking|water[- ]resistant|waterproof)\b/gi, label: 'a fabric or performance claim' },
  { code: 'stock', re: /\b(?:selling fast|almost gone|nearly sold out|sold out|low stock|limited stock|few (?:left|remaining)|last few|while (?:stocks?|supplies) last|back in stock|only \d+ left|limited quantities|in stock)\b/gi, label: 'a stock-availability claim' },
  { code: 'shipping', re: /\b(?:free (?:shipping|delivery|returns?)|express (?:shipping|delivery)|next[- ]day (?:delivery|shipping)|worldwide shipping|fast shipping|ships? (?:today|free|worldwide))\b/gi, label: 'a shipping claim' },
  { code: 'deadline', re: new RegExp(`\\b(?:ends? (?:in|on|at)?\\s?(?:${DAYS})|until (?:${DAYS})|\\d+\\s?(?:hours?|days?|mins?|minutes?) left|today only|tonight only|this weekend(?: only)?|all weekend|ends? soon|ends? tonight|this week only|(?:\\d{1,2}(?:st|nd|rd|th)?\\s(?:${MONTHS}))\\b|(?:${MONTHS})\\s\\d{1,2}(?:st|nd|rd|th)?)`, 'gi'), label: 'a deadline or date' },
  { code: 'offer_terms', re: /\b(?:discount|clearance|bogo|buy \d+|free gift|gift with purchase|gwp|bundle (?:and|&) save|save \$?\d+|deal)\b/gi, label: 'promotional terms' },
  { code: 'sale_word', re: /\b(?:sale|on sale|\d+% off|% off|markdown)\b/gi, label: 'sale wording', onlyWhen: (facts) => !facts.isPromotion },
];

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ');

// facts: { text: <everything the model was allowed to know, as one string>, isPromotion }
// Returns [{ code, match, label }] for each claim that is not supported by the facts.
function findUnsupportedClaims(text, facts) {
  const allowed = norm(facts.text);
  const out = [];
  for (const rule of RULES) {
    if (rule.onlyWhen && !rule.onlyWhen(facts)) continue;
    const matches = String(text).match(rule.re) || [];
    for (const m of matches) {
      const needle = norm(m);
      const supported = rule.numeric ? allowed.includes(needle.replace(/\s+/g, '')) || allowed.replace(/\s+/g, '').includes(needle.replace(/\s+/g, '')) : allowed.includes(needle);
      if (!supported) out.push({ code: rule.code, match: m.trim(), label: rule.label });
    }
  }
  const seen = new Set();
  return out.filter((c) => { const k = `${c.code}:${c.match.toLowerCase()}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

const words = (t) => new Set(norm(t).replace(/[^a-z0-9\s']/g, ' ').split(' ').filter((w) => w.length > 3));
function overlap(a, b) { const A = words(a); const B = words(b); if (!A.size || !B.size) return 0; let n = 0; A.forEach((w) => { if (B.has(w)) n += 1; }); return n / Math.min(A.size, B.size); }

// ── prompt ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const ANGLES = {
  standard: ['product-led', 'feature-led', 'styling or lifestyle-led'],
  hype: ['teaser-led', 'anticipation-led', 'sign-up-led'],
  sale_live: ['offer-led', 'product-in-the-sale-led', 'lifestyle-led'],
  mid_sale: ['offer-led', 'product-in-the-sale-led', 'lifestyle-led'],
  last_chance: ['urgency-led', 'offer-led', 'product-led'],
};

const SYSTEM = `You write the Primary Text for WNDRR's Meta (Facebook/Instagram) ads, in WNDRR's own voice.
You are given FACTS (the only things you may state about the product or campaign), WNDRR STYLE NOTES measured from real WNDRR copy, and REFERENCE EXAMPLES of real WNDRR copy.
Hard rules:
- Use the examples for voice, rhythm and structure only. Never copy a sentence from them. Never reuse another product's details.
- State only what the FACTS support. Do NOT invent or imply: discounts, percentages, prices, product specifications, fabric or composition, GSM, features, stock levels or availability, shipping offers, deadlines, dates or campaign terms. If a detail is not in the FACTS, leave it out.
- No discount or offer wording unless a verified offer is in the FACTS. If the ad is a sale ad without a verified offer, write copy that does not mention any offer.
- Do not write the headline, description or call-to-action button; write the Primary Text only.
- Return ONLY JSON, no commentary, in exactly this shape: {"options":[{"angle":"...","text":"..."}]}. Use real line breaks inside "text" as \\n.`;

function factsToText(facts) {
  const lines = [];
  const add = (k, v) => { if (v !== undefined && v !== null && String(v).trim() !== '') lines.push(`${k}: ${v}`); };
  add('Product name', facts.productName); add('Product category', facts.productCategory); add('Products covered', (facts.productNames || []).join(', '));
  add('Ad type', facts.adCategoryLabel); add('Campaign', facts.promotionName); add('Campaign stage', facts.stageLabel);
  add('Verified offer', facts.offer); add('Campaign dates (from the promotion record)', facts.campaignDates);
  add('Creative concept', facts.conceptName); add('Concept type', facts.conceptType); add('Hook', facts.hook); add('Concept idea', facts.angle);
  add('Audience note', facts.audience); add('Creative format', facts.format); add('Product note from planning', facts.productNote);
  return lines.join('\n');
}

function buildMessages({ mode, facts, guidelines, examples, instruction, baseText, history, ruleKey, previousTexts }) {
  const angles = ANGLES[ruleKey] || ANGLES.standard;
  const factText = factsToText(facts);
  const exampleText = examples.map((e, i) => `Example ${i + 1}${e.label ? ` (${e.label})` : ''}:\n${e.body}`).join('\n\n');
  const context = `FACTS (the only things you may state):\n${factText}\n\nWNDRR STYLE NOTES (measured from real WNDRR copy):\n${guidelines || '(none)'}\n\nREFERENCE EXAMPLES (voice only, do not copy):\n${exampleText || '(none)'}`;
  const messages = [];
  (history || []).forEach((h) => {
    messages.push({ role: 'user', content: h.instruction ? `Request: ${h.instruction}` : 'Write three Primary Text options.' });
    messages.push({ role: 'assistant', content: JSON.stringify({ options: (h.options || []).map((o) => ({ angle: o.angle, text: o.text })) }) });
  });
  let ask;
  if (mode === 'refine') {
    ask = `Rewrite this Primary Text following the request, keeping the same facts and WNDRR voice. Return exactly one option.\n\nCurrent text:\n${baseText}\n\nRequest: ${instruction}`;
  } else if (mode === 'more') {
    ask = `Write three NEW Primary Text options, clearly different in approach from these earlier ones:\n${(previousTexts || []).map((t, i) => `${i + 1}. ${t}`).join('\n')}\n${instruction ? `\nAdditional request: ${instruction}` : ''}\nAngles to use: ${angles.join('; ')}.`;
  } else {
    ask = `Write three Primary Text options that are meaningfully different from each other, one per angle: ${angles.join('; ')}.${instruction ? `\nAdditional request: ${instruction}` : ''}`;
  }
  messages.push({ role: 'user', content: `${context}\n\n${ask}` });
  return { system: SYSTEM, messages };
}

function parseOptions(text) {
  let body = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const a = body.indexOf('{'); const b = body.lastIndexOf('}');
  if (a < 0 || b < a) throw new AiError('bad_output', 'The AI answer was not in the expected format.');
  let json;
  try { json = JSON.parse(body.slice(a, b + 1)); } catch (e) { throw new AiError('bad_output', 'The AI answer could not be read.'); }
  const options = (Array.isArray(json.options) ? json.options : []).map((o) => ({ angle: String((o && o.angle) || '').slice(0, 60), text: String((o && o.text) || '').trim() })).filter((o) => o.text);
  if (!options.length) throw new AiError('bad_output', 'The AI answer contained no options.');
  return options;
}

// Orchestrates one request. `call` is callModel (injectable). Returns { options, dropped, model, attempts }.
async function generate({ mode = 'generate', facts, guidelines, examples, instruction, baseText, history, ruleKey, previousTexts, call = callModel }) {
  const factGuard = { text: `${factsToText(facts)}\n${instruction || ''}\n${baseText || ''}`, isPromotion: !!facts.isPromotion };
  const want = mode === 'refine' ? 1 : 3;
  let model = null;
  let problems = [];
  let kept = [];
  const dropped = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const built = buildMessages({ mode, facts, guidelines, examples, instruction, baseText, history, ruleKey, previousTexts });
    if (attempt > 1) built.messages[built.messages.length - 1].content += `\n\nYour previous answer was rejected: ${problems.join(' ')} Write it again and fix this.`;
    const out = await call({ system: built.system, messages: built.messages });
    model = out.model;
    let options;
    try { options = parseOptions(out.text); } catch (e) { if (attempt === 2) throw e; problems = ['The answer was not valid JSON in the required shape.']; continue; }
    problems = [];
    const checked = options.slice(0, want).map((o) => {
      const unsupported = findUnsupportedClaims(o.text, factGuard);
      const tooLong = o.text.length > MAX_PRIMARY_TEXT;
      return { ...o, unsupported, tooLong };
    });
    kept = [];
    checked.forEach((o, i) => {
      if (o.unsupported.length) { problems.push(`Option ${i + 1} stated things not in the FACTS: ${o.unsupported.map((u) => `"${u.match}" (${u.label})`).join(', ')}.`); return; }
      if (o.tooLong) { problems.push(`Option ${i + 1} is too long.`); return; }
      kept.push({ angle: o.angle, text: o.text });
    });
    if (mode !== 'refine') {
      for (let i = 0; i < kept.length; i += 1) for (let j = i + 1; j < kept.length; j += 1) {
        if (overlap(kept[i].text, kept[j].text) > 0.7) problems.push(`Options ${i + 1} and ${j + 1} are too similar; make them genuinely different.`);
      }
    }
    if (kept.length === want && !problems.length) { checked.forEach(() => {}); return { options: kept, dropped, model, attempts: attempt }; }
    if (attempt === 2) checked.forEach((o) => { if (o.unsupported.length || o.tooLong) dropped.push({ text: o.text, reasons: o.unsupported.map((u) => `${u.label}: "${u.match}"`).concat(o.tooLong ? ['too long'] : []) }); });
  }
  if (!kept.length) throw new AiError('rejected', 'The AI wrote copy that stated things we have no record of (for example a discount or a specification), so nothing was kept. Try again, or write the copy yourself.');
  return { options: kept, dropped, model, attempts: 2 };
}

module.exports = { aiConfig, callModel, scrub, generate, buildMessages, parseOptions, findUnsupportedClaims, factsToText, AiError, DEFAULT_MODEL, MAX_PRIMARY_TEXT, ANGLES, overlap };
