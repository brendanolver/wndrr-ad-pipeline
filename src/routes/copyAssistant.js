// AI Copy Assistant routes + copy library routes. The library is read-only (Google Sheets -> database cache); the assistant writes Primary Text
// OPTIONS only. Nothing generated is ever treated as approved copy: approval is the explicit POST /api/ad-setup/:id/approve-primary-text.
const express = require('express');
const { pool } = require('../db');
const { requireAdmin } = require('../lib/permissions');
const sheets = require('../lib/googleSheets');
const library = require('../lib/copyLibrary');
const { parseCsv } = require('../lib/csvParse');
const ai = require('../lib/copyAi');
const providers = require('../lib/aiProviders');
const { detectPromotionStageType, AD_CATEGORY_LABELS } = require('../lib/adSetupNaming');
const copyTypes = require('../lib/copyTypes');
const { normalizeUnicode } = require('../lib/copyText');
const { deriveProductCode } = require('../lib/apparelmagic');

const libraryRouter = express.Router();
const adRouter = express.Router();

// ── library ─────────────────────────────────────────────────────────────────────────────────────────────────────
libraryRouter.get('/status', async (req, res, next) => {
  try { res.json({ ...(await library.status(pool, sheets, ai.aiConfig().configured)), providers: providers.allProviders() }); } catch (err) { next(err); }
});

libraryRouter.get('/guidelines', async (req, res, next) => {
  try {
    const g = await library.loadGuidelines(pool);
    if (!g) return res.status(404).json({ error: 'The reference library has not been read yet, so there are no guidelines to show.' });
    res.json({ generated_at: g.created_at, synced_at: g.synced_at, analysis: g.analysis, ai_summary: g.ai_summary });
  } catch (err) { next(err); }
});

// Reads the spreadsheet again. Admin only; never writes to the spreadsheet.
libraryRouter.post('/refresh', requireAdmin, async (req, res, next) => {
  try {
    const body = req.body || {};
    const dryRun = !!body.dry_run;
    const running = await pool.query("SELECT 1 FROM copy_reference_syncs WHERE status = 'running' AND started_at > now() - interval '5 minutes' LIMIT 1");
    if (running.rows.length && !dryRun) return res.status(409).json({ error: 'A refresh is already running. Give it a minute.' });
    const cfg = sheets.readCredentials();
    if (!cfg.configured) return res.status(503).json({ code: 'sheets_not_configured', error: cfg.reason });
    // dry_run: read, parse and validate the spreadsheet and report what a refresh WOULD do. Nothing is written to the database (or to the spreadsheet, which is never written).
    if (dryRun) return res.json(await library.syncLibrary({ db: pool, sheets, userId: req.user.id, dryRun: true, acceptSmaller: !!body.accept_smaller }));
    const out = await library.syncLibrary({ db: pool, sheets, userId: req.user.id, acceptSmaller: !!body.accept_smaller });
    if (!out.ok) return res.status(out.code === 'not_configured' ? 503 : 502).json({ code: out.code, error: out.error });
    // Optional plain-language summary of the measured statistics, when an AI provider is configured. Failure never fails the refresh.
    let summary = null;
    if (ai.aiConfig().configured) {
      try { summary = await summariseStyle(out.sync_id); } catch (e) { summary = { error: e.message }; }
    }
    res.json({ ok: true, examples: out.examples, excluded: out.excluded, warnings: out.warnings, tabs: out.tabs, ai_summary: summary && !summary.error ? 'written' : (summary ? `not written: ${summary.error}` : 'not configured') });
  } catch (err) { next(err); }
});

// Import path when direct Google Sheets access is not configured: the tabs downloaded from the sheet as CSV (File > Download > .csv), one file per tab.
// Replaces the library with exactly the files sent (same parsing, tone statistics and failure handling as a Sheets refresh). Admin only.
libraryRouter.post('/import', requireAdmin, async (req, res, next) => {
  try {
    const files = Array.isArray((req.body || {}).files) ? req.body.files : [];
    if (!files.length) return res.status(400).json({ error: 'Choose at least one CSV file.' });
    if (files.length > 20) return res.status(400).json({ error: 'Import at most 20 tabs at once.' });
    const byKey = new Map(library.EXPECTED_TABS.map((t) => [t.title.toLowerCase(), t.title]));
    const tabs = new Map();
    for (const f of files) {
      const title = byKey.get(String((f && f.tab) || '').trim().toLowerCase());
      if (!title) return res.status(400).json({ error: `"${(f && f.tab) || ''}" is not one of the copy tabs (${library.EXPECTED_TABS.map((t) => t.title).join(', ')}).` });
      const text = String((f && f.text) || '');
      if (!text.trim()) return res.status(400).json({ error: `The file for ${title} is empty.` });
      if (text.length > 3 * 1024 * 1024) return res.status(400).json({ error: `The file for ${title} is too large (3 MB max).` });
      if (tabs.has(title)) return res.status(400).json({ error: `${title} was chosen more than once.` });
      tabs.set(title, parseCsv(text));
    }
    const dryRun = !!(req.body || {}).dry_run;
    const running = await pool.query("SELECT 1 FROM copy_reference_syncs WHERE status = 'running' AND started_at > now() - interval '5 minutes' LIMIT 1");
    if (running.rows.length && !dryRun) return res.status(409).json({ error: 'A refresh or import is already running. Give it a minute.' });
    const fake = {
      listTabs: async () => [...tabs.keys()].map((title) => ({ title })),
      readTab: async (title) => tabs.get(title) || [],
      readCredentials: sheets.readCredentials, sheetId: sheets.sheetId,
    };
    if (dryRun) return res.json(await library.syncLibrary({ db: pool, sheets: fake, userId: req.user.id, source: 'import', dryRun: true }));
    const out = await library.syncLibrary({ db: pool, sheets: fake, userId: req.user.id, source: 'import' });
    if (!out.ok) return res.status(422).json({ code: out.code, error: out.error });
    let summary = null;
    if (ai.aiConfig().configured) { try { summary = await summariseStyle(out.sync_id); } catch (e) { summary = { error: e.message }; } }
    res.json({ ok: true, source: 'import', examples: out.examples, tabs: out.tabs, ai_summary: summary && !summary.error ? 'written' : (summary ? `not written: ${summary.error}` : 'not configured') });
  } catch (err) { next(err); }
});

async function summariseStyle(syncId) {
  const g = (await pool.query('SELECT id, analysis FROM copy_tone_guidelines WHERE sync_id = $1 ORDER BY id DESC LIMIT 1', [syncId])).rows[0];
  if (!g) return null;
  const sample = (await pool.query('SELECT family, label, body FROM copy_reference_examples WHERE sync_id = $1 ORDER BY (id * 7919) % 101, id LIMIT 24', [syncId])).rows;
  const stats = library.guidelinesText(g.analysis, null, []);
  const out = await ai.callModel({
    system: 'You describe the house writing style of a brand from measured statistics and real examples. Be concrete and brief (under 220 words, plain bullet points). Describe only patterns visible in the material provided; do not invent rules. Describe voice, structure and formatting only: never mention specific products, materials, features, colours, counts, prices or offers. Cover: sentence length and structure, how products are introduced, typical phrasing, differences between the copy families, how urgency / calls to action are used, typical length, and things the examples avoid.',
    messages: [{ role: 'user', content: `Measured statistics:\n${stats}\n\nSample examples:\n${sample.map((s, i) => `${i + 1}. [${s.family}] ${s.body}`).join('\n\n')}` }],
    maxTokens: 3000,
  });
  await pool.query('UPDATE copy_tone_guidelines SET ai_summary = $1 WHERE id = $2', [out.text, g.id]);
  return { ok: true };
}

// ── per-ad assistant ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Everything the application already knows about the ad, split into
//   * evidence for the automatic Copy Type (planning source, promotion stage, linked products and their drops, the creative brief), and
//   * VERIFIED FACTS (product name / category, promotion, verified offer, drop launch date, creative format) that the writer may state.
// The creative concept, hook and angle are carried separately as creative direction: they shape the mood of the copy but are never evidence for a product claim.
async function loadAdFacts(adSetupId) {
  const r = await pool.query(
    `SELECT au.*, ca.concept_name, ca.concept_type, ca.angle, ca.hook, ca.hook_variations, ca.customer_avatar_id,
            fe.variation_text, fe.format AS fe_format,
            ps.name AS promotion_stage_name, p.name AS promotion_name, p.verified_offer, p.start_date, p.end_date,
            av.name AS avatar_name,
            spi.source AS spi_source, spi.product_name AS spi_product_name, spi.initial_idea AS spi_initial_idea, spi.recommendation_snapshot AS spi_snapshot
     FROM ad_setups au
     JOIN creative_assets ca ON ca.id = au.creative_asset_id
     JOIN final_edits fe ON fe.id = au.final_edit_id
     LEFT JOIN promotion_stages ps ON ps.id = au.promotion_stage_id
     LEFT JOIN promotions p ON p.id = ps.promotion_id
     LEFT JOIN customer_avatars av ON av.id = ca.customer_avatar_id
     LEFT JOIN shoot_plan_items spi ON spi.id = ca.shoot_plan_item_id
     WHERE au.id = $1`, [adSetupId]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const products = (await pool.query(
    `SELECT s.id AS style_id, s.style_code, s.name, s.tier, c.name AS category_name, d.name AS drop_name, d.launch_date AS drop_launch_date
     FROM ad_setup_products asp JOIN styles s ON s.id = asp.style_id
     LEFT JOIN categories c ON c.id = s.category_id LEFT JOIN drops d ON d.id = s.drop_id
     WHERE asp.ad_setup_id = $1 ORDER BY s.id`, [adSetupId])).rows;
  // the same product launched earlier in other colourways (only when the catalogue's own drops say so)
  let siblingColourwaysEarlier = false;
  if (products.length) {
    const sib = await pool.query(
      `SELECT 1 FROM styles s1 JOIN drops d1 ON d1.id = s1.drop_id
         JOIN styles s2 ON left(s2.style_code, 8) = left(s1.style_code, 8) AND s2.id <> s1.id JOIN drops d2 ON d2.id = s2.drop_id
        WHERE s1.id = ANY($1::int[]) AND s1.style_code ~ '^W[0-9]{2}[A-Z]{2}[0-9]{3}' AND d2.launch_date < d1.launch_date - interval '30 days'
          AND d1.launch_date >= CURRENT_DATE - interval '120 days' AND NOT (s2.id = ANY($1::int[])) LIMIT 1`, [products.map((x) => x.style_id)]);
    siblingColourwaysEarlier = sib.rows.length > 0;
  }
  const stageType = row.promotion_stage_name ? detectPromotionStageType(row.promotion_stage_name) : null;
  const fmtDate = (d) => new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'long' });
  const hook = row.variation_text || (Array.isArray(row.hook_variations) && row.hook_variations.find((h) => h && h.text) && row.hook_variations.find((h) => h && h.text).text) || row.hook || null;
  const codes = new Set(products.map((x) => deriveProductCode(x.style_code)).filter(Boolean));
  const oneProduct = codes.size === 1 || products.length === 1;

  const planningReason = row.spi_snapshot && typeof row.spi_snapshot === 'object' && typeof row.spi_snapshot.reason === 'string' ? row.spi_snapshot.reason : null;
  const evidence = {
    adCategory: row.ad_category, stageType, promotionStageName: row.promotion_stage_name || null, promotionName: row.promotion_name || null,
    shootPlanSource: row.spi_source || null, planningReason, productCount: codes.size || products.length,
    styles: products.map((x) => ({ style_code: x.style_code, name: x.name, tier: x.tier, drop_name: x.drop_name, drop_launch_date: x.drop_launch_date })),
    siblingColourwaysEarlier,
    texts: { conceptName: row.concept_name, hook, angle: row.angle, productLabel: row.product_label, initialIdea: row.spi_initial_idea, promotionName: row.promotion_name },
  };
  const auto = copyTypes.classifyCopyType(evidence);
  const eff = copyTypes.effectiveCopyType(row.copy_type_override, auto);
  const isPromotion = eff.type === 'sale';
  const dropStyle = products.find((x) => x.drop_name || x.drop_launch_date);
  const facts = {
    productName: oneProduct ? (row.spi_product_name || (products[0] && products[0].name) || null) : null,
    productNames: products.map((x) => x.name),
    productCategory: [...new Set(products.map((x) => x.category_name).filter(Boolean))].join(', ') || row.product_type || null,
    adCategoryLabel: AD_CATEGORY_LABELS[row.ad_category] || row.ad_category,
    copyType: eff.type, copyTypeLabel: eff.label, newnessAllowed: eff.newnessAllowed,
    promotionName: isPromotion ? row.promotion_name : null,
    stageLabel: isPromotion ? row.promotion_stage_name : null,
    offer: isPromotion ? row.verified_offer : null,
    campaignDates: isPromotion && row.start_date ? `${fmtDate(row.start_date)}${row.end_date ? ` to ${fmtDate(row.end_date)}` : ''}` : null,
    dropName: dropStyle ? dropStyle.drop_name : null,
    dropLaunch: dropStyle && dropStyle.drop_launch_date ? String(dropStyle.drop_launch_date).slice(0, 10) : null,
    format: row.fe_format || row.media_type,
    verifiedFeatures: [], // the application holds no verified product features today; when it does they are listed here and only then may copy state them
    // creative direction (never evidence for a claim)
    conceptName: row.concept_name, conceptType: row.concept_type, hook, angle: row.angle, audience: row.avatar_name, productNote: row.spi_initial_idea,
    isPromotion,
  };
  const ruleKey = isPromotion ? ({ hype: 'hype', sale_live: 'sale_live', mid_sale: 'mid_sale', last_chance: 'last_chance' }[stageType] || 'standard') : 'standard';
  return { row, facts, stageType, ruleKey, products, auto, eff };
}

// What the assistant panel shows and what the person can change.
function copyTypeInfo(loaded) {
  const { auto, eff, row } = loaded;
  return {
    auto: { type: auto.type, label: auto.label, confidence: auto.confidence, fallback: auto.fallback, reasons: auto.reasons },
    override: row.copy_type_override || null,
    effective: { type: eff.type, label: eff.label, source: eff.source },
    options: copyTypes.COPY_TYPES.map((t) => ({ value: t.value, label: t.label, hint: t.hint })),
  };
}

// What the person sees under "References used": where the example came from and how it starts. Never the prompt, never credentials.
function referenceSummary(e) {
  const first = normalizeUnicode(String(e.body || '').split('\n').find((l) => l.trim()) || '').trim();
  return { id: e.id, tab: e.tab, family: e.family, kind: e.kind, label: e.subject || e.label || null, range: e.label && e.subject && e.label !== e.subject ? e.label : null, snippet: first.length > 140 ? `${first.slice(0, 137)}...` : first };
}

async function preflight(res, provider) {
  const cfg = providers.providerConfig(provider);
  if (!cfg.configured) { res.status(503).json({ code: 'ai_not_configured', provider, error: cfg.reason }); return null; }
  const { sync, examples } = await library.loadExamples(pool);
  if (!sync || !examples.length) {
    const sc = sheets.readCredentials();
    res.status(409).json({ code: 'library_unavailable', error: sc.configured ? 'The WNDRR copy library has not been read yet. Ask an admin to refresh it (Settings > Copy Library).' : 'The WNDRR copy library has not been loaded yet. An admin can import the copy tabs as CSV files in Settings > Copy Library (or connect Google Sheets there).' });
    return null;
  }
  return { examples, sync };
}

async function run(req, res, next, mode) {
  try {
    const id = Number(req.params.id);
    const loaded = await loadAdFacts(id);
    if (!loaded) return res.status(404).json({ error: 'Ad Setup not found' });
    if (loaded.row.status === 'approved') return res.status(409).json({ error: 'This Ad Setup has already been approved.' });
    const body = req.body || {};
    // Which AI writes this request. Claude is the default; the choice only decides who is asked, never what they are given.
    const provider = body.provider === undefined || body.provider === null || body.provider === '' ? providers.DEFAULT_PROVIDER : body.provider;
    if (!providers.isProvider(provider)) return res.status(400).json({ error: `provider must be one of: ${Object.keys(providers.PROVIDERS).join(', ')}.` });
    const pre = await preflight(res, provider);
    if (!pre) return;
    const instruction = typeof body.instruction === 'string' ? body.instruction.trim().slice(0, 500) : '';
    const baseText = typeof body.base_text === 'string' ? body.base_text.trim() : '';
    if (mode === 'refine' && (!instruction || !baseText)) return res.status(400).json({ error: 'Say what to change and which text to change.' });

    // A provider's conversation (earlier requests, "another three") only ever contains its OWN earlier answers, so both providers are given equivalent inputs.
    const history = (await pool.query("SELECT kind, instruction, options FROM ad_copy_generations WHERE ad_setup_id = $1 AND COALESCE(provider, 'anthropic') = $2 ORDER BY id DESC LIMIT 4", [id, provider])).rows.reverse();
    const previousTexts = history.flatMap((h) => (h.options || []).map((o) => o.text)).slice(-9);
    const g = await library.loadGuidelines(pool);
    const copyType = loaded.eff.type;
    // Style references for THIS copy type (a person's override has already been applied in loadAdFacts). They are shown to the model with another product's details removed.
    const examples = library.selectExamples(pre.examples, {
      copyType, stageType: loaded.stageType, productName: loaded.facts.productName, productCategory: loaded.facts.productCategory, limit: 6,
    });
    const plan = copyTypes.TAB_PLAN[copyType];
    const families = [...new Set([...plan.families.primary, ...plan.families.secondary])];
    const guidelines = library.guidelinesText(g && g.analysis, g && g.ai_summary, families);

    const out = await ai.generate({
      mode, facts: loaded.facts, guidelines, examples: examples.map(library.promptExample), referenceTexts: examples.map((e) => e.body),
      instruction, baseText, history, ruleKey: loaded.ruleKey, previousTexts, copyType,
      call: (request) => providers.callProvider(provider, request),
    });
    const kind = mode === 'more' ? 'more' : mode;
    const saved = await pool.query(
      `INSERT INTO ad_copy_generations (ad_setup_id, kind, instruction, base_text, options, model, reference_ids, created_by_user_id, copy_type, copy_type_source, provider)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10,$11) RETURNING id, created_at`,
      [id, kind, instruction || null, baseText || null, JSON.stringify(out.options), out.model, JSON.stringify(examples.map((e) => e.id)), req.user.id, copyType, loaded.eff.source, provider]
    );
    // Remember the latest suggestions on the ad (clearly unapproved) so a reload does not lose them.
    await pool.query('UPDATE ad_setups SET ai_draft_options = $1::jsonb, updated_at = now() WHERE id = $2', [JSON.stringify(out.options), id]);
    res.json({
      generation_id: saved.rows[0].id, options: out.options, model: out.model, dropped: out.dropped.length,
      provider, provider_label: providers.providerLabel(provider), kind, created_at: saved.rows[0].created_at,
      copy_type: copyTypeInfo(loaded),
      references: examples.map(referenceSummary), approved: false,
      notes: out.dropped.length ? [`${out.dropped.length} suggestion(s) were discarded because they stated details we have no record of.`] : [],
      missing: loaded.facts.isPromotion && !loaded.facts.offer ? ['No verified offer is recorded for this promotion, so the copy does not mention one.'] : [],
    });
  } catch (err) {
    if (err instanceof ai.AiError) {
      const status = { not_configured: 503, auth_failed: 502, rate_limited: 429, network: 502, rejected: 422, bad_output: 502, empty: 502, api_error: 502, bad_request: 502, model_not_found: 502, truncated: 502, billing: 402 }[err.code] || 502;
      return res.status(status).json({ code: err.code, error: err.message });
    }
    next(err);
  }
}

adRouter.post('/:id/copy-ai/generate', (req, res, next) => run(req, res, next, (req.body || {}).more ? 'more' : 'generate'));
adRouter.post('/:id/copy-ai/refine', (req, res, next) => run(req, res, next, 'refine'));

// The saved results of both providers for one Ad Setup: for each provider its latest "three options" set (generate / another three) and, if newer, its latest revision.
// Nothing is ever replaced: every generation stays in ad_copy_generations; this only picks what to show.
async function loadResults(id) {
  const rows = (await pool.query(
    `SELECT DISTINCT ON (COALESCE(provider, 'anthropic'), (kind = 'refine')) id, kind, options, model, provider, copy_type, copy_type_source, created_at
       FROM ad_copy_generations WHERE ad_setup_id = $1 ORDER BY COALESCE(provider, 'anthropic'), (kind = 'refine'), id DESC`, [id])).rows;
  const out = {};
  for (const p of Object.keys(providers.PROVIDERS)) {
    const set = rows.find((r) => providers.providerOf(r.provider) === p && r.kind !== 'refine') || null;
    const rev = rows.find((r) => providers.providerOf(r.provider) === p && r.kind === 'refine') || null;
    const shape = (r) => (r ? { generation_id: r.id, kind: r.kind, options: r.options || [], model: r.model, provider: p, provider_label: providers.providerLabel(p), copy_type: r.copy_type, created_at: r.created_at } : null);
    out[p] = { set: shape(set), revision: rev && (!set || rev.id > set.id) ? shape(rev) : null };
  }
  return out;
}

adRouter.get('/:id/copy-ai', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const loaded = await loadAdFacts(id);
    if (!loaded) return res.status(404).json({ error: 'Ad Setup not found' });
    const row = loaded.row;
    const generations = (await pool.query('SELECT id, kind, instruction, options, model, provider, reference_ids, copy_type, copy_type_source, created_at FROM ad_copy_generations WHERE ad_setup_id = $1 ORDER BY id DESC LIMIT 20', [id])).rows;
    const st = await library.status(pool, sheets, ai.aiConfig().configured);
    const list = providers.allProviders();
    // the references behind the latest generation, so a reload still shows them
    let lastReferences = [];
    const latest = generations[0];
    if (latest && Array.isArray(latest.reference_ids) && latest.reference_ids.length && st.library) {
      const { examples } = await library.loadExamples(pool);
      const byId = new Map(examples.map((e) => [e.id, e]));
      lastReferences = latest.reference_ids.map((rid) => byId.get(rid)).filter(Boolean).map(referenceSummary);
    }
    res.json({
      // ai_configured: at least one provider can write (the panel opens); each provider's own state is in `providers`
      ai_configured: list.some((p) => p.configured), ai_reason: ai.aiConfig().reason, providers: list, default_provider: providers.DEFAULT_PROVIDER,
      library: st.library, sheets: st.sheets, draft_options: row.ai_draft_options || [], approved: row.primary_text_approved,
      results: await loadResults(id),
      generations: generations.map(({ reference_ids: _ids, ...g }) => ({ ...g, provider: providers.providerOf(g.provider) })), copy_type: copyTypeInfo(loaded), last_references: lastReferences, status: row.status,
    });
  } catch (err) { next(err); }
});

// Set or clear the Copy Type override for this Ad Setup. copy_type: one of the types, or null / "auto" to go back to automatic detection.
// The choice is stored on the Ad Setup, so it applies to every later generation until it is reset. An approved Ad Setup is never changed.
adRouter.put('/:id/copy-type', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = (await pool.query('SELECT id, status FROM ad_setups WHERE id = $1', [id])).rows[0];
    if (!existing) return res.status(404).json({ error: 'Ad Setup not found' });
    if (existing.status === 'approved') return res.status(409).json({ error: 'This Ad Setup has already been approved.' });
    const raw = (req.body || {}).copy_type;
    const value = raw === null || raw === undefined || raw === '' || raw === 'auto' ? null : raw;
    if (value !== null && !copyTypes.isCopyType(value)) return res.status(400).json({ error: `copy_type must be one of: ${copyTypes.VALUES.join(', ')}, or null for automatic.` });
    await pool.query("UPDATE ad_setups SET copy_type_override = $1 WHERE id = $2 AND status = 'draft'", [value, id]);
    const loaded = await loadAdFacts(id);
    res.json({ copy_type: copyTypeInfo(loaded) });
  } catch (err) { next(err); }
});

module.exports = { libraryRouter, adRouter, loadAdFacts, copyTypeInfo, referenceSummary };
