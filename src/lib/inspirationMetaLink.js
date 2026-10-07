// Inspiration Library -> Meta ad: DETERMINISTIC links only.
//
// Many references hold a Meta share link (https://fb.me/adspreview/facebook/<token>) -- the very link Meta returns as an
// ad's `preview_shareable_link`. So when the SAME exact URL is known for exactly one stored ad, that is an identity, not a
// guess. Rules, strongest first:
//   share_link_exact  the reference URL equals (after trimming) an ad's stored preview_shareable_link
//   ad_id_in_url      the URL carries an explicit  ad_id=<digits>  that is a stored meta_ad_id
// Never used: titles, concept / campaign names, creators, or any similarity. A reference with no URL, or a URL that matches
// no ad (or more than one), stays unlinked. Linking only ever fills an empty meta_ad_id; an existing link is never replaced.
//
// Share links are known for ads whose preview was opened (meta_ad_creatives.payload.share_link) plus ads looked up by the
// explicit lookup action below (read-only Meta GET, 50 ads per call, rate-limit aware).
const { pool } = require('../db');
const metaAds = require('./metaAds');

const norm = (u) => String(u || '').trim();
function urlsOf(row) {
  return [row.video_url, ...String(row.additional_urls || '').split('\n')].map(norm).filter(Boolean);
}
function adIdInUrl(u) {
  const m = /[?&]ad_id=([0-9]{6,32})(?:&|$)/.exec(u);
  return m ? m[1] : null;
}
const isMetaShare = (u) => /^https:\/\/fb\.me\/adspreview\//i.test(u);

// share link -> [ad ids] from every source we hold.
async function shareLinkIndex(db = pool) {
  const idx = new Map();
  const add = (link, adId) => { const k = norm(link); if (!k) return; if (!idx.has(k)) idx.set(k, new Set()); idx.get(k).add(adId); };
  (await db.query('SELECT meta_ad_id, share_link FROM meta_ad_share_links WHERE share_link IS NOT NULL')).rows.forEach((r) => add(r.share_link, r.meta_ad_id));
  (await db.query("SELECT meta_ad_id, payload->>'share_link' AS share_link FROM meta_ad_creatives WHERE payload->>'share_link' IS NOT NULL")).rows.forEach((r) => add(r.share_link, r.meta_ad_id));
  return idx;
}

// Pure: classify every reference. rows = creative_inspiration rows; idx = shareLinkIndex; adIds = Set of stored meta_ad_ids.
function classifyAll(rows, idx, adIds) {
  return rows.map((r) => {
    const urls = urlsOf(r);
    const base = { id: r.id, title: r.title, has_url: urls.length > 0, already_linked: !!r.meta_ad_id, meta_ad_id: r.meta_ad_id || null };
    if (r.meta_ad_id) return { ...base, state: 'linked' };
    if (!urls.length) return { ...base, state: 'no_url' };
    const hits = new Map(); // adId -> basis
    for (const u of urls) {
      (idx.get(u) ? [...idx.get(u)] : []).forEach((a) => hits.set(a, 'share_link_exact'));
      const id = adIdInUrl(u);
      if (id && adIds.has(id) && !hits.has(id)) hits.set(id, 'ad_id_in_url');
    }
    if (hits.size === 1) { const [adId, basis] = [...hits.entries()][0]; return { ...base, state: 'recoverable', candidate_ad_id: adId, basis }; }
    if (hits.size > 1) return { ...base, state: 'ambiguous', candidates: hits.size };
    return { ...base, state: urls.some(isMetaShare) ? 'meta_link_not_yet_matched' : 'other_link', };
  });
}

async function report(db = pool) {
  const rows = (await db.query('SELECT id, title, video_url, additional_urls, meta_ad_id FROM creative_inspiration ORDER BY id')).rows;
  const idx = await shareLinkIndex(db);
  const adIds = new Set((await db.query('SELECT meta_ad_id FROM meta_ads')).rows.map((r) => r.meta_ad_id));
  const classified = classifyAll(rows, idx, adIds);
  const count = (st) => classified.filter((c) => c.state === st).length;
  const known = (await db.query('SELECT count(*)::int AS n FROM meta_ad_share_links')).rows[0].n;
  const candidates = (await db.query(
    `SELECT count(*)::int AS n FROM meta_ads a WHERE NOT EXISTS (SELECT 1 FROM meta_ad_share_links s WHERE s.meta_ad_id = a.meta_ad_id)
        AND EXISTS (SELECT 1 FROM meta_ad_insights_daily d WHERE d.meta_ad_id = a.meta_ad_id AND d.spend > 0)`)).rows[0].n;
  return {
    total_references: rows.length,
    with_a_link: classified.filter((c) => c.has_url).length,
    without_a_link: count('no_url'),
    already_linked_to_a_meta_ad: count('linked'),
    recoverable_now: count('recoverable'),
    meta_share_link_not_yet_matched: count('meta_link_not_yet_matched'),
    other_link_type: count('other_link'),
    ambiguous: count('ambiguous'),
    // Honest bottom line: a reference with no URL has nothing to match on (names are never used), so it cannot be recovered.
    cannot_be_recovered_without_a_link: count('no_url'),
    share_links_known: known,
    ads_whose_share_link_could_be_looked_up: candidates,
    rules: ['share_link_exact', 'ad_id_in_url'],
    records: classified,
  };
}

// EXPLICIT admin action: read each candidate ad's preview_shareable_link from Meta (read-only), 50 per call, and store it.
// Highest-spend ads first; `limit` caps one press (default 500 ads = 10 calls). Resumable: ads already looked up are skipped.
async function lookupShareLinks({ limit = 500 } = {}, deps = {}) {
  const db = deps.db || pool;
  const configured = deps.configured ? deps.configured() : metaAds.configured();
  if (!configured) { const e = new Error('Meta is not configured in this environment.'); e.status = 409; throw e; }
  const getByIds = deps.metaGetByIds || metaAds.metaGetByIds;
  const cap = Math.min(2000, Math.max(1, parseInt(limit, 10) || 500));
  const cands = (await db.query(
    `SELECT a.meta_ad_id FROM meta_ads a
      WHERE NOT EXISTS (SELECT 1 FROM meta_ad_share_links s WHERE s.meta_ad_id = a.meta_ad_id)
        AND EXISTS (SELECT 1 FROM meta_ad_insights_daily d WHERE d.meta_ad_id = a.meta_ad_id AND d.spend > 0)
      ORDER BY (SELECT COALESCE(sum(d.spend), 0) FROM meta_ad_insights_daily d WHERE d.meta_ad_id = a.meta_ad_id) DESC, a.meta_ad_id
      LIMIT $1`, [cap])).rows.map((r) => r.meta_ad_id);
  const out = { asked: 0, stored: 0, without_link: 0, calls: 0, rate_limited: false };
  for (let i = 0; i < cands.length; i += 50) {
    const batch = cands.slice(i, i + 50);
    let data;
    try { out.calls += 1; data = await getByIds(batch, 'preview_shareable_link'); } catch (err) { if (err && err.rateLimited) { out.rate_limited = true; break; } continue; }
    for (const id of batch) {
      out.asked += 1;
      const link = data && data[id] && data[id].preview_shareable_link;
      if (link) {
        await db.query('INSERT INTO meta_ad_share_links (meta_ad_id, share_link, fetched_at) VALUES ($1,$2, now()) ON CONFLICT (meta_ad_id) DO UPDATE SET share_link = EXCLUDED.share_link, fetched_at = now()', [id, link]);
        out.stored += 1;
      } else out.without_link += 1;
    }
  }
  return out;
}

// EXPLICIT admin action: write the deterministic links. Idempotent; fills only empty meta_ad_id; never touches anything else.
async function applyLinks(db = pool) {
  const rep = await report(db);
  let linked = 0;
  for (const r of rep.records.filter((x) => x.state === 'recoverable')) {
    const res = await db.query(
      'UPDATE creative_inspiration SET meta_ad_id = $2, meta_link_basis = $3, meta_linked_at = now() WHERE id = $1 AND meta_ad_id IS NULL RETURNING id',
      [r.id, r.candidate_ad_id, r.basis]
    );
    linked += res.rows.length;
  }
  return { linked, skipped_ambiguous: rep.ambiguous, still_unlinked: rep.total_references - rep.already_linked_to_a_meta_ad - linked };
}

// ── the references that still show "No link yet": exactly what is stored and whether an exact Meta match can be recovered ──
// Deterministic only. A reference with no URL, no explicit ad id and no Meta identifier has nothing to match on; the title,
// promotion, stage and creator are NOT identifiers (matching on them would be a name guess), so such a record stays unlinked.
async function unlinkedDetail(db = pool) {
  const rows = (await db.query(
    `SELECT id, title, campaign_name, sale_stage_note, creator, media_type, source_key, source_label, video_url, additional_urls, notes, created_at
       FROM creative_inspiration WHERE meta_ad_id IS NULL AND btrim(COALESCE(video_url, '')) = '' ORDER BY id`)).rows;
  const adIds = new Set((await db.query('SELECT meta_ad_id FROM meta_ads')).rows.map((r) => r.meta_ad_id));
  const idx = await shareLinkIndex(db);
  return rows.map((r) => {
    const urls = urlsOf(r);
    const noteLinks = (String(r.notes || '').match(/https?:\/\/[^\s)]+/g) || []).map(norm);
    const noteHits = noteLinks.flatMap((u) => [...(idx.get(u) || [])].concat(adIdInUrl(u) && adIds.has(adIdInUrl(u)) ? [adIdInUrl(u)] : []));
    const identifiers = {
      video_url: !!norm(r.video_url), additional_urls: urls.length > (norm(r.video_url) ? 1 : 0), links_in_notes: noteLinks.length,
      internal_source_key: r.source_key || null, // a row label from the planning sheet, not a Meta identifier
    };
    let recoverable = false; let reason;
    if (new Set(noteHits).size === 1) { recoverable = true; reason = 'A link in the notes matches exactly one stored ad (move it into the URL field, then Apply).'; }
    else if (urls.length || noteLinks.length) reason = 'It carries a link, but none that matches a stored ad exactly.';
    else reason = 'No URL, no ad id and no Meta identifier is stored. The only other fields are the title, promotion, stage and creator, and matching on those would be a name guess, so it is left unlinked. Use "Link to Meta creative" to choose the right one yourself.';
    return {
      id: r.id, title: r.title, promotion: r.campaign_name, stage: r.sale_stage_note, creator: r.creator, media_type: r.media_type,
      source: r.source_label, identifiers, exact_match_recoverable: recoverable, reason,
    };
  });
}

module.exports = { report, lookupShareLinks, applyLinks, classifyAll, urlsOf, adIdInUrl, shareLinkIndex, unlinkedDetail };
