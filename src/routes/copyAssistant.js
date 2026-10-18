// AI Copy Assistant routes + copy library routes. The library is read-only (Google Sheets -> database cache); the assistant writes Primary Text
// OPTIONS only. Nothing generated is ever treated as approved copy: approval is the explicit POST /api/ad-setup/:id/approve-primary-text.
const express = require('express');
const { pool } = require('../db');
const { requireAdmin } = require('../lib/permissions');
const sheets = require('../lib/googleSheets');
const library = require('../lib/copyLibrary');
const { parseCsv } = require('../lib/csvParse');
const ai = require('../lib/copyAi');
const { detectPromotionStageType, AD_CATEGORY_LABELS } = require('../lib/adSetupNaming');

const libraryRouter = express.Router();
const adRouter = express.Router();

// ── library ─────────────────────────────────────────────────────────────────────────────────────────────────────
libraryRouter.get('/status', async (req, res, next) => {
  try { res.json(await library.status(pool, sheets, ai.aiConfig().configured)); } catch (err) { next(err); }
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
    const running = await pool.query("SELECT 1 FROM copy_reference_syncs WHERE status = 'running' AND started_at > now() - interval '5 minutes' LIMIT 1");
    if (running.rows.length) return res.status(409).json({ error: 'A refresh is already running. Give it a minute.' });
    const cfg = sheets.readCredentials();
    if (!cfg.configured) return res.status(503).json({ code: 'sheets_not_configured', error: cfg.reason });
    const out = await library.syncLibrary({ db: pool, sheets, userId: req.user.id });
    if (!out.ok) return res.status(out.code === 'not_configured' ? 503 : 502).json({ code: out.code, error: out.error });
    // Optional plain-language summary of the measured statistics, when an AI provider is configured. Failure never fails the refresh.
    let summary = null;
    if (ai.aiConfig().configured) {
      try { summary = await summariseStyle(out.sync_id); } catch (e) { summary = { error: e.message }; }
    }
    res.json({ ok: true, examples: out.examples, tabs: out.tabs, ai_summary: summary && !summary.error ? 'written' : (summary ? `not written: ${summary.error}` : 'not configured') });
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
    const running = await pool.query("SELECT 1 FROM copy_reference_syncs WHERE status = 'running' AND started_at > now() - interval '5 minutes' LIMIT 1");
    if (running.rows.length) return res.status(409).json({ error: 'A refresh or import is already running. Give it a minute.' });
    const fake = {
      listTabs: async () => [...tabs.keys()].map((title) => ({ title })),
      readTab: async (title) => tabs.get(title) || [],
      readCredentials: sheets.readCredentials, sheetId: sheets.sheetId,
    };
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
    system: 'You describe the house writing style of a brand from measured statistics and real examples. Be concrete and brief (under 220 words, plain bullet points). Describe only patterns visible in the material provided; do not invent rules. Cover: sentence length and structure, how products are introduced, typical phrasing, differences between the copy families, how urgency / calls to action are used, typical length, and things the examples avoid.',
    messages: [{ role: 'user', content: `Measured statistics:\n${stats}\n\nSample examples:\n${sample.map((s, i) => `${i + 1}. [${s.family}] ${s.body}`).join('\n\n')}` }],
    maxTokens: 3000,
  });
  await pool.query('UPDATE copy_tone_guidelines SET ai_summary = $1 WHERE id = $2', [out.text, g.id]);
  return { ok: true };
}

// ── per-ad assistant ─────────────────────────────────────────────────────────────────────────────────────────────
async function loadAdFacts(adSetupId) {
  const r = await pool.query(
    `SELECT au.*, ca.concept_name, ca.concept_type, ca.angle, ca.hook, ca.hook_variations, ca.customer_avatar_id,
            fe.variation_text, fe.format AS fe_format,
            ps.name AS promotion_stage_name, p.name AS promotion_name, p.verified_offer, p.start_date, p.end_date,
            av.name AS avatar_name
     FROM ad_setups au
     JOIN creative_assets ca ON ca.id = au.creative_asset_id
     JOIN final_edits fe ON fe.id = au.final_edit_id
     LEFT JOIN promotion_stages ps ON ps.id = au.promotion_stage_id
     LEFT JOIN promotions p ON p.id = ps.promotion_id
     LEFT JOIN customer_avatars av ON av.id = ca.customer_avatar_id
     WHERE au.id = $1`, [adSetupId]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const products = (await pool.query(
    `SELECT s.name, c.name AS category_name FROM ad_setup_products asp JOIN styles s ON s.id = asp.style_id LEFT JOIN categories c ON c.id = s.category_id WHERE asp.ad_setup_id = $1`, [adSetupId])).rows;
  const stageType = row.promotion_stage_name ? detectPromotionStageType(row.promotion_stage_name) : null;
  const isPromotion = row.ad_category === 'promotion';
  const fmtDate = (d) => new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'long' });
  const hook = row.variation_text || (Array.isArray(row.hook_variations) && row.hook_variations.find((h) => h && h.text) && row.hook_variations.find((h) => h && h.text).text) || row.hook || null;
  const facts = {
    productName: products.length === 1 ? products[0].name : null,
    productNames: products.map((p) => p.name),
    productCategory: [...new Set(products.map((p) => p.category_name).filter(Boolean))].join(', ') || row.product_type || null,
    adCategoryLabel: AD_CATEGORY_LABELS[row.ad_category] || row.ad_category,
    promotionName: isPromotion ? row.promotion_name : null,
    stageLabel: isPromotion ? row.promotion_stage_name : null,
    offer: isPromotion ? row.verified_offer : null,
    campaignDates: isPromotion && row.start_date ? `${fmtDate(row.start_date)}${row.end_date ? ` to ${fmtDate(row.end_date)}` : ''}` : null,
    conceptName: row.concept_name, conceptType: row.concept_type, hook, angle: row.angle,
    audience: row.avatar_name, format: row.fe_format || row.media_type,
    isPromotion,
  };
  const ruleKey = isPromotion ? ({ hype: 'hype', sale_live: 'sale_live', mid_sale: 'mid_sale', last_chance: 'last_chance' }[stageType] || 'standard') : 'standard';
  return { row, facts, stageType, ruleKey, products };
}

async function preflight(res) {
  const cfg = ai.aiConfig();
  if (!cfg.configured) { res.status(503).json({ code: 'ai_not_configured', error: cfg.reason }); return null; }
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
    const pre = await preflight(res);
    if (!pre) return;
    const body = req.body || {};
    const instruction = typeof body.instruction === 'string' ? body.instruction.trim().slice(0, 500) : '';
    const baseText = typeof body.base_text === 'string' ? body.base_text.trim() : '';
    if (mode === 'refine' && (!instruction || !baseText)) return res.status(400).json({ error: 'Say what to change and which text to change.' });

    const history = (await pool.query('SELECT kind, instruction, options FROM ad_copy_generations WHERE ad_setup_id = $1 ORDER BY id DESC LIMIT 4', [id])).rows.reverse();
    const previousTexts = history.flatMap((h) => (h.options || []).map((o) => o.text)).slice(-9);
    const g = await library.loadGuidelines(pool);
    const examples = library.selectExamples(pre.examples, {
      adCategory: loaded.row.ad_category, stageType: loaded.stageType, productName: loaded.facts.productName, productCategory: loaded.facts.productCategory, limit: 6,
    });
    const guidelines = library.guidelinesText(g && g.analysis, g && g.ai_summary, library.familiesFor({ adCategory: loaded.row.ad_category, productName: loaded.facts.productName, productCategory: loaded.facts.productCategory }));

    const out = await ai.generate({
      mode, facts: loaded.facts, guidelines, examples, instruction, baseText, history, ruleKey: loaded.ruleKey, previousTexts,
    });
    const kind = mode === 'more' ? 'more' : mode;
    const saved = await pool.query(
      `INSERT INTO ad_copy_generations (ad_setup_id, kind, instruction, base_text, options, model, reference_ids, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8) RETURNING id, created_at`,
      [id, kind, instruction || null, baseText || null, JSON.stringify(out.options), out.model, JSON.stringify(examples.map((e) => e.id)), req.user.id]
    );
    // Remember the latest suggestions on the ad (clearly unapproved) so a reload does not lose them.
    await pool.query('UPDATE ad_setups SET ai_draft_options = $1::jsonb, updated_at = now() WHERE id = $2', [JSON.stringify(out.options), id]);
    res.json({
      generation_id: saved.rows[0].id, options: out.options, model: out.model, dropped: out.dropped.length,
      references: examples.map((e) => ({ id: e.id, tab: e.tab, label: e.label })), approved: false,
      notes: out.dropped.length ? [`${out.dropped.length} suggestion(s) were discarded because they stated details we have no record of.`] : [],
      missing: loaded.facts.isPromotion && !loaded.facts.offer ? ['No verified offer is recorded for this promotion, so the copy does not mention one.'] : [],
    });
  } catch (err) {
    if (err instanceof ai.AiError) {
      const status = { not_configured: 503, auth_failed: 502, rate_limited: 429, network: 502, rejected: 422, bad_output: 502, empty: 502, api_error: 502, bad_request: 502, model_not_found: 502, truncated: 502 }[err.code] || 502;
      return res.status(status).json({ code: err.code, error: err.message });
    }
    next(err);
  }
}

adRouter.post('/:id/copy-ai/generate', (req, res, next) => run(req, res, next, (req.body || {}).more ? 'more' : 'generate'));
adRouter.post('/:id/copy-ai/refine', (req, res, next) => run(req, res, next, 'refine'));

adRouter.get('/:id/copy-ai', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = (await pool.query('SELECT id, ai_draft_options, primary_text_approved, primary_text_source FROM ad_setups WHERE id = $1', [id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Ad Setup not found' });
    const generations = (await pool.query('SELECT id, kind, instruction, options, model, created_at FROM ad_copy_generations WHERE ad_setup_id = $1 ORDER BY id DESC LIMIT 10', [id])).rows;
    const st = await library.status(pool, sheets, ai.aiConfig().configured);
    res.json({ ai_configured: st.ai.configured, ai_reason: ai.aiConfig().reason, library: st.library, sheets: st.sheets, draft_options: row.ai_draft_options || [], approved: row.primary_text_approved, generations });
  } catch (err) { next(err); }
});

module.exports = { libraryRouter, adRouter, loadAdFacts };
