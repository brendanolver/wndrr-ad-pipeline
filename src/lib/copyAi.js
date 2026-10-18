// WNDRR AI Copy Assistant: Primary Text generation and refinement for Meta ads.
//
// Headline, Description and CTA are NOT written here (see lib/adCopyRules.js). This module only produces Primary Text options, from
//   * facts the application actually holds (product, category, campaign, stage, concept, format, verified offer), and
//   * reference examples + statistics from the WNDRR copy library (lib/copyLibrary.js), used as references, never to be copied verbatim.
// Every generated option is checked against those facts: discounts, prices, specifications, GSM, fabric, stock, shipping and deadlines that
// are not in the facts are rejected. If the provider is not configured, or the library has never been read, nothing is generated.
//
// Reference examples teach TONE, STRUCTURE and FORMATTING only. They are shown with another product's details removed (lib/copyClaims.js maskClaims), the writer is told they are
// not facts, and every generated option is checked against the VERIFIED FACTS the application holds (creative concept / hook / angle are creative direction, not facts).
//
// Configuration: ANTHROPIC_API_KEY (required), COPY_AI_MODEL (optional, default below). ANTHROPIC_API_BASE exists for tests only.

const { findUnsupportedClaims } = require('./copyClaims');
const { similarity, contentWords, plain } = require('./copyText');
const copyTypes = require('./copyTypes');

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

// ── prompt ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// Angles are different ways in. None of them asks for product features: the application holds no verified features, so a "feature-led" option is only offered when
// facts.verifiedFeatures lists some.
const ANGLES = {
  standard: ['product-led (name the product, one confident reason to click, verified facts only)', 'idea-led (build on the creative direction without stating product facts)', 'occasion-led (when or where it gets worn, no product claims)'],
  hype: ['teaser-led', 'anticipation-led', 'sign-up-led'],
  sale_live: ['offer-led', 'product-in-the-sale-led', 'lifestyle-led'],
  mid_sale: ['offer-led', 'product-in-the-sale-led', 'lifestyle-led'],
  last_chance: ['urgency-led', 'offer-led', 'product-led'],
};
const TYPE_ANGLES = {
  new_range: ['launch-led (the range or drop is the news)', 'product-led (name the product, verified facts only)', 'idea-led (build on the creative direction)'],
  new_colourways: ['colour-news-led (new colours are in; do not name or count them)', 'product-led (name the product, verified facts only)', 'idea-led (build on the creative direction)'],
  bundle: ['build-your-set-led (the mix-and-match idea, no prices or quantities)', 'product-led (name the products, verified facts only)', 'occasion-led (when or where the set gets worn)'],
  usa_bundle: ['build-your-set-led (the mix-and-match idea, no prices or quantities)', 'product-led (name the products, verified facts only)', 'occasion-led (when or where the set gets worn)'],
};
function anglesFor(ruleKey, copyType, facts) {
  let list = copyType && copyType !== 'sale' && TYPE_ANGLES[copyType] ? TYPE_ANGLES[copyType] : (ANGLES[ruleKey] || ANGLES.standard);
  if (facts && Array.isArray(facts.verifiedFeatures) && facts.verifiedFeatures.length) list = [...list, 'feature-led (use ONLY the verified features listed)'];
  return list;
}

const SYSTEM = `You write the Primary Text for WNDRR's Meta (Facebook/Instagram) ads, in WNDRR's own voice.
You are given: the COPY TYPE, VERIFIED FACTS, CREATIVE DIRECTION, STYLE NOTES and STYLE REFERENCES.
Hard rules:
- VERIFIED FACTS are the only things you may state about the product or campaign. CREATIVE DIRECTION (concept, hook, idea, audience) is a brief for mood and angle; it is NOT a fact about the product, so never state it as one.
- STYLE REFERENCES are real WNDRR ads for OTHER products. Take their voice, rhythm, sentence structure, line breaks, emoji use, calls to action and formatting only. Square-bracket placeholders such as [PRODUCT], [COUNT] or [DETAIL] mark details that were removed on purpose: never fill them in and never carry over anything about those products.
- Never copy a sentence from a reference. Never reuse another product's details.
- Do NOT invent or imply anything that is not in the VERIFIED FACTS: discounts, percentages, prices, specifications, fabric or composition, GSM, features, fit variations, how many fits, colours or ways to wear it, best-seller or popularity claims, reviews, "new" or launch wording (unless the COPY TYPE allows it), availability, stock levels, shipping, deadlines, dates or campaign terms. If a detail is not in the facts, leave it out.
- No discount or offer wording unless a verified offer is in the VERIFIED FACTS.
- Do not write the headline, description or call-to-action button; write the Primary Text only.
- The options must be genuinely different from each other: a different opening line, a different structure and a different angle. 
- Return ONLY JSON, no commentary, in exactly this shape: {"options":[{"angle":"...","text":"..."}]}. Use real line breaks inside "text" as \\n.`;

// Everything the writer may state (and nothing else): the facts the application actually holds.
function factsToText(facts) {
  const lines = [];
  const add = (k, v) => { if (v !== undefined && v !== null && String(v).trim() !== '') lines.push(`${k}: ${v}`); };
  add('Product name', facts.productName); add('Product category', facts.productCategory); add('Products covered', (facts.productNames || []).join(', '));
  add('Ad type', facts.adCategoryLabel); add('Copy type', facts.copyTypeLabel); add('Campaign', facts.promotionName); add('Campaign stage', facts.stageLabel);
  add('Verified offer', facts.offer); add('Campaign dates (from the promotion record)', facts.campaignDates);
  add('Drop', facts.dropName); add('Drop launch date', facts.dropLaunch);
  add('Creative format', facts.format);
  (facts.verifiedFeatures || []).forEach((f) => add('Verified feature', f));
  return lines.join('\n');
}

// The creative brief: direction for the writer, never evidence for a claim.
function directionToText(facts) {
  const lines = [];
  const add = (k, v) => { if (v !== undefined && v !== null && String(v).trim() !== '') lines.push(`${k}: ${v}`); };
  add('Creative concept', facts.conceptName); add('Concept type', facts.conceptType); add('Hook', facts.hook); add('Concept idea', facts.angle);
  add('Audience note', facts.audience); add('Note from planning', facts.productNote);
  return lines.join('\n');
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ');
const words = (t) => new Set(norm(t).replace(/[^a-z0-9\s']/g, ' ').split(' ').filter((w) => w.length > 3));
function overlap(a, b) { const A = words(a); const B = words(b); if (!A.size || !B.size) return 0; let n = 0; A.forEach((w) => { if (B.has(w)) n += 1; }); return n / Math.min(A.size, B.size); }
const opener = (t) => contentWords(plain(t).split(' ').slice(0, 6).join(' ')).slice(0, 2).join(' ');

// Longest run of consecutive words a text shares with any reference (copying guard).
function longestSharedRun(text, refs) {
  const t = plain(text).split(' ').filter(Boolean);
  let best = 0;
  for (const r of refs) {
    const rw = plain(r).split(' ').filter(Boolean);
    const at = new Map(); rw.forEach((w, i) => { if (!at.has(w)) at.set(w, []); at.get(w).push(i); });
    for (let i = 0; i < t.length; i += 1) for (const j of at.get(t[i]) || []) { let k = 0; while (i + k < t.length && j + k < rw.length && t[i + k] === rw[j + k]) k += 1; if (k > best) best = k; }
  }
  return best;
}
const MAX_COPIED_RUN = 8;

function buildMessages({ mode, facts, guidelines, examples, instruction, baseText, history, ruleKey, previousTexts, copyType, wanted }) {
  const type = copyTypes.isCopyType(copyType) ? copyType : (facts.copyType || null);
  const angles = anglesFor(ruleKey, type, facts);
  const factText = factsToText(facts);
  const directionText = directionToText(facts);
  const exampleText = examples.map((e, i) => `Reference ${i + 1}${e.tab ? ` (${e.tab}${e.label ? `, ${e.label}` : ''})` : (e.label ? ` (${e.label})` : '')}:\n${e.body}`).join('\n\n');
  const typeBlock = type ? `COPY TYPE: ${copyTypes.LABELS[type]}\n${copyTypes.GUIDANCE[type]}` : '';
  const context = [
    typeBlock,
    `VERIFIED FACTS (the only things you may state):\n${factText || '(none)'}`,
    `CREATIVE DIRECTION (mood and angle only, NOT facts about the product):\n${directionText || '(none)'}`,
    `STYLE NOTES (measured from real WNDRR copy; style only):\n${guidelines || '(none)'}`,
    `STYLE REFERENCES (other products' ads with their details removed; voice, structure and formatting only):\n${exampleText || '(none)'}`,
  ].filter(Boolean).join('\n\n');
  const messages = [];
  (history || []).forEach((h) => {
    messages.push({ role: 'user', content: h.instruction ? `Request: ${h.instruction}` : 'Write three Primary Text options.' });
    messages.push({ role: 'assistant', content: JSON.stringify({ options: (h.options || []).map((o) => ({ angle: o.angle, text: o.text })) }) });
  });
  let ask;
  if (mode === 'refine') {
    ask = `Rewrite this Primary Text following the request, keeping the same facts and WNDRR voice. Return ${wanted || 1} version${(wanted || 1) > 1 ? 's' : ''}, best first.\n\nCurrent text:\n${baseText}\n\nRequest: ${instruction}`;
  } else if (mode === 'more') {
    ask = `Write ${wanted || 3} NEW Primary Text options, clearly different in approach from these earlier ones:\n${(previousTexts || []).map((t, i) => `${i + 1}. ${t}`).join('\n')}\n${instruction ? `\nAdditional request: ${instruction}` : ''}\nAngles to use: ${angles.join('; ')}.`;
  } else {
    ask = `Write ${wanted || 3} Primary Text options that are meaningfully different from each other (opening line, structure and angle), spread across these angles: ${angles.join('; ')}.${instruction ? `\nAdditional request: ${instruction}` : ''}`;
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
// The model is asked for extra candidates (5 for "three options", 2 for a refinement): the ones that pass the facts guard and are genuinely different are kept, best first.
async function generate({ mode = 'generate', facts, guidelines, examples, instruction, baseText, history, ruleKey, previousTexts, copyType, referenceTexts, call = callModel }) {
  const type = copyTypes.isCopyType(copyType) ? copyType : (facts.copyType || null);
  // What the writer may state: verified facts + what the person typed in this request. Creative direction is deliberately not included.
  const factGuard = {
    text: `${factsToText(facts)}\n${instruction || ''}\n${baseText || ''}`,
    isPromotion: !!facts.isPromotion,
    newnessAllowed: facts.newnessAllowed !== undefined ? !!facts.newnessAllowed : (type === 'new_range' || type === 'new_colourways'),
  };
  const refTexts = referenceTexts || examples.map((e) => e.body);
  const want = mode === 'refine' ? 1 : 3;
  const candidates = mode === 'refine' ? 2 : 5;
  let model = null;
  let problems = [];
  let kept = [];
  let dropped = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const built = buildMessages({ mode, facts, guidelines, examples, instruction, baseText, history, ruleKey, previousTexts, copyType: type, wanted: candidates });
    if (attempt > 1) built.messages[built.messages.length - 1].content += `\n\nYour previous answer was rejected: ${problems.join(' ')} Write it again and fix this.`;
    const out = await call({ system: built.system, messages: built.messages });
    model = out.model;
    let options;
    try { options = parseOptions(out.text); } catch (e) { if (attempt === 2) throw e; problems = ['The answer was not valid JSON in the required shape.']; continue; }
    problems = []; kept = []; dropped = [];
    options.forEach((o, i) => {
      const unsupported = findUnsupportedClaims(o.text, factGuard);
      if (unsupported.length) { problems.push(`Option ${i + 1} stated things not in the VERIFIED FACTS: ${unsupported.map((u) => `"${u.match}" (${u.label})`).join(', ')}.`); dropped.push({ text: o.text, reasons: unsupported.map((u) => `${u.label}: "${u.match}"`) }); return; }
      if (o.text.length > MAX_PRIMARY_TEXT) { problems.push(`Option ${i + 1} is too long.`); dropped.push({ text: o.text, reasons: ['too long'] }); return; }
      if (longestSharedRun(o.text, refTexts) >= MAX_COPIED_RUN) { problems.push(`Option ${i + 1} copies wording from a style reference; write it fresh.`); dropped.push({ text: o.text, reasons: ['copies a reference'] }); return; }
      if (mode !== 'refine') {
        const twin = kept.findIndex((k) => overlap(k.text, o.text) > 0.7 || (opener(k.text) && opener(k.text) === opener(o.text)));
        if (twin >= 0) { problems.push(`Option ${i + 1} is too similar to another option; make each genuinely different.`); return; }
      }
      kept.push({ angle: o.angle, text: o.text });
    });
    kept = kept.slice(0, want);
    if (kept.length === want) return { options: kept, dropped: dropped.slice(0, 6), model, attempts: attempt };
  }
  if (!kept.length) throw new AiError('rejected', 'The AI wrote copy that stated things we have no record of (for example a discount, a specification or a number of fits), so nothing was kept. Try again, or write the copy yourself.');
  return { options: kept, dropped: dropped.slice(0, 6), model, attempts: 2 };
}

module.exports = { aiConfig, callModel, scrub, generate, buildMessages, parseOptions, findUnsupportedClaims, factsToText, directionToText, AiError, DEFAULT_MODEL, MAX_PRIMARY_TEXT, ANGLES, TYPE_ANGLES, anglesFor, overlap, longestSharedRun };
