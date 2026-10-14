'use strict';
// "Last Creative Uploaded" (Planning, Core and High Stocks): the date of the newest GENUINELY NEW creative made for a product.
//
// IMPORTANT: this is NOT a verified Meta upload event. It is the creative date the team writes into the ad name:
//   #CREATIVEID_YY-WKXX_DD-MM_...      e.g.  #306_26-WK38_18-09_SUMMER SHORTS_...   ->  18 September 2026
// The year comes from YY, the day and month from DD-MM. WKXX is only a consistency check (it must agree with the date, give or take one week for
// Sunday/Monday week conventions). Historical ads do not all follow the convention; those are "unavailable", never guessed.
//
// A unique creative is the account's existing definition (productAdPerformance.creativeGroupKey: an identical Meta creative id, or a "- Copy" by name). The
// same creative duplicated into other campaigns is ONE creative, and its date is the ORIGINAL ad's: the instance Meta created first. The creation / first
// delivery date of a newer duplicate is never used, and the latest date among copies is never silently picked: if copies disagree the original wins and the
// disagreement is reported (`conflicts`); if the original cannot be dated the creative is unavailable.
//
// Read-only: it reads local tables only (meta_ads, meta_ad_products, classifications, campaigns). No Meta call, no writes.
const perf = require('./productAdPerformance');
const dpaLib = require('./metaDpa');
const nameCopies = require('./metaNameCopies');

const NAME_RE = /^\s*#?\s*(\d+)\s*_\s*(\d{2})\s*-\s*WK\s*(\d{1,2})\s*_\s*(\d{1,2})\s*-\s*(\d{1,2})\s*(?:_|$)/i;
const MIN_YEAR = 2018;
const CREATED_TOLERANCE_DAYS = 14; // a creative date may not be later than the ad's own creation in Meta (allowing a little slack for how teams date their files)
const FUTURE_TOLERANCE_DAYS = 1;

const pad = (n) => String(n).padStart(2, '0');
const utc = (y, m, d) => Date.UTC(y, m - 1, d);
const ymdOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayNo = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return Math.floor(utc(y, m, d) / 86400000); };
function isoWeek(y, m, d) {
  const t = new Date(utc(y, m, d)); t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); // the Thursday of this ISO week decides its year
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
}

// → { ok, date: 'YYYY-MM-DD'|null, creative_no, reason }   reason: null | 'no_pattern' | 'invalid_date' | 'week_mismatch' | 'future' | 'implausible_year'
function parseCreativeDate(name, { today = null } = {}) {
  const m = NAME_RE.exec(String(name == null ? '' : name));
  if (!m) return { ok: false, date: null, creative_no: null, reason: 'no_pattern' };
  const [, no, yy, wk, dd, mm] = m; const y = 2000 + Number(yy); const mo = Number(mm); const d = Number(dd); const w = Number(wk);
  const bad = (reason) => ({ ok: false, date: null, creative_no: no, reason });
  if (y < MIN_YEAR) return bad('implausible_year');
  const dt = new Date(utc(y, mo, d));
  if (mo < 1 || mo > 12 || d < 1 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return bad('invalid_date'); // e.g. 31-09, 29-02 in a non-leap year
  if (w < 1 || w > 53) return bad('week_mismatch');
  const diff = Math.abs(isoWeek(y, mo, d) - w); // week 52/53 and week 1 are neighbours across New Year
  if (diff > 1 && diff < 51) return bad('week_mismatch');
  const date = `${y}-${pad(mo)}-${pad(d)}`;
  if (today && dayNo(date) > dayNo(today) + FUTURE_TOLERANCE_DAYS) return bad('future');
  return { ok: true, date, creative_no: no, reason: null };
}

const createdDay = (t) => { if (!t) return null; const d = new Date(t); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };

// One unique creative from ALL its Meta instances (any status, any match state).
// instances: [{ id, name, created_time }]  →  { date, source, reason, original_id, original_name, conflicts: [{ id, name, date }], instances }
function resolveCreativeDate(instances, { today = null } = {}) {
  const rows = (instances || []).map((i) => {
    const p = parseCreativeDate(i.name, { today }); const cd = createdDay(i.created_time);
    let ok = p.ok; let reason = p.reason;
    // the creative date cannot be later than the ad that carries it was created in Meta
    if (ok && cd && dayNo(p.date) > dayNo(cd) + CREATED_TOLERANCE_DAYS) { ok = false; reason = 'after_ad_created'; }
    return { id: i.id, name: i.name || null, created: cd, ms: i.created_time ? new Date(i.created_time).getTime() : null, date: ok ? p.date : null, reason };
  });
  const base = { date: null, source: null, reason: null, original_id: null, original_name: null, conflicts: [], instances: rows.length };
  if (!rows.length) return { ...base, reason: 'no_instances' };
  // the ORIGINAL is the instance Meta created first; ties (or no creation times at all) are only acceptable when they agree
  const dated = rows.filter((r) => r.ms !== null && !Number.isNaN(r.ms));
  const firstMs = dated.length ? Math.min(...dated.map((r) => r.ms)) : null;
  const originals = firstMs === null ? rows : dated.filter((r) => r.ms === firstMs);
  const origDates = [...new Set(originals.map((r) => r.date).filter(Boolean))];
  const first = originals.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  const out = { ...base, original_id: first.id, original_name: first.name };
  const others = rows.filter((r) => r.date);
  if (origDates.length === 1 && originals.every((r) => r.date === origDates[0])) {
    out.date = origDates[0]; out.source = 'original_ad_name';
    out.conflicts = others.filter((r) => r.date !== out.date).map((r) => ({ id: r.id, name: r.name, date: r.date }));
    return out;
  }
  if (origDates.length > 1) return { ...out, reason: 'conflicting_dates', conflicts: others.map((r) => ({ id: r.id, name: r.name, date: r.date })) };
  // the original carries no usable date. A copy that does is a re-dated duplicate (or the original is unknown), so its date is NOT the creative's: unavailable.
  if (others.length) return { ...out, reason: 'original_undated', conflicts: others.map((r) => ({ id: r.id, name: r.name, date: r.date })) };
  const why = originals.map((r) => r.reason).find((r) => r && r !== 'no_pattern') || 'no_pattern';
  return { ...out, reason: why };
}

// One product: its unique creatives (each already resolved) → the newest valid date.
// creatives: [{ key, name, date, reason, created, conflicts }]
function summarizeProduct(creatives) {
  const list = creatives || [];
  const dated = list.filter((c) => c.date);
  const latest = dated.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0] || null;
  const undated = list.filter((c) => !c.date);
  // an undated creative that Meta created AFTER the latest dated creative may be newer: the date shown could be too old, and says so
  const maybeNewer = latest ? undated.some((c) => c.created && c.created > latest.date) : false;
  return {
    last_creative_uploaded_date: latest ? latest.date : null,
    creative_name: latest ? latest.name : null,
    creatives_total: list.length, creatives_dated: dated.length, creatives_undated: undated.length,
    possibly_newer_undated: maybeNewer,
    has_conflicts: dated.some((c) => (c.conflicts || []).length > 0),
    unavailable_reason: latest ? null : (list.length ? 'no_dated_creative' : 'no_creative'),
  };
}

// whole days from the creative date to today (null when there is no date or no today)
const withDaysSince = (sum, today) => ({ ...sum, days_since: sum.last_creative_uploaded_date && today ? Math.max(0, dayNo(today) - dayNo(sum.last_creative_uploaded_date)) : null });

const likeEscape = (s) => String(s).replace(/[\\%_]/g, (m) => `\\${m}`);

// → { byFamily: Map(familyKey -> summary), byAd: Map(meta_ad_id -> { date, reason, conflicts }) }
// Reliable matches only (confirmed / auto matched; excluded-from-intelligence and Dynamic Product Ads left out), ANY delivery status (paused and archived creative counts).
async function loadLastCreativeDates(families, { db, today = null } = {}) {
  const byFamily = new Map(); const byAd = new Map();
  const codeToFamily = new Map();
  (families || []).forEach((f) => (f.codes || [f.key]).forEach((c) => codeToFamily.set(c, f.key)));
  const codes = [...codeToFamily.keys()];
  (families || []).forEach((f) => byFamily.set(f.key, summarizeProduct([])));
  if (!codes.length) return { byFamily, byAd };
  const rows = (await db.query(
    `/* last-creative */ SELECT m.meta_ad_id, m.ad_name, m.meta_creative_id, m.effective_status, m.created_time,
            (SELECT array_agg(DISTINCT p.product_code) FROM meta_ad_products p WHERE p.meta_ad_id = m.meta_ad_id) AS product_codes
       FROM meta_ads m
       LEFT JOIN meta_ad_classifications cl ON cl.meta_ad_id = m.meta_ad_id
       LEFT JOIN meta_campaigns c ON c.meta_campaign_id = m.meta_campaign_id
      WHERE m.match_status IN ('confirmed', 'auto_matched') AND NOT COALESCE(cl.excluded_from_intelligence, false)
        AND NOT COALESCE((${dpaLib.dpaPredicate('m', 'c')}), false)
        AND EXISTS (SELECT 1 FROM meta_ad_products p WHERE p.meta_ad_id = m.meta_ad_id AND p.product_code = ANY($1::text[]))`, [codes])).rows;

  // unique creatives per product: the SAME identity code Planning uses
  const per = new Map();
  rows.forEach((r) => {
    const fams = [...new Set((r.product_codes || []).map((c) => codeToFamily.get(c)).filter(Boolean))];
    fams.forEach((fk) => {
      if (!per.has(fk)) per.set(fk, new Map());
      const g = per.get(fk); const key = perf.creativeGroupKey(r, nameCopies);
      if (!g.has(key)) g.set(key, perf.newGroup(key));
      perf.addRowToGroup(g.get(key), { ...r, delivery_rows: 0 });
    });
  });
  per.forEach((g) => perf.mergeNameCopies(g, nameCopies));

  // every other instance of the same creative (any status, matched or not) so the ORIGINAL ad is found even when it is paused or not yet reviewed
  const ids = new Set(); const pats = new Set(); const groups = [];
  per.forEach((g) => g.forEach((x) => {
    groups.push(x);
    x.ads.forEach((a) => {
      if (a.creative_id) ids.add(String(a.creative_id));
      if (a.name && nameCopies.hasCopySuffix(a.name)) pats.add(`${likeEscape(nameCopies.baseOf(a.name))}%`);
    });
  }));
  let extra = [];
  if (ids.size || pats.size) {
    try {
      extra = (await db.query(`/* last-creative-origins */ SELECT m.meta_ad_id, m.meta_creative_id, m.ad_name, m.created_time FROM meta_ads m WHERE m.meta_creative_id = ANY($1::text[]) OR m.ad_name ILIKE ANY($2::text[])`, [[...ids], [...pats]])).rows;
    } catch (e) { extra = []; } // without it the matched instances alone are used
  }
  const createdOf = new Map(rows.map((r) => [r.meta_ad_id, r.created_time]));
  per.forEach((g, fk) => {
    const list = [];
    g.forEach((x) => {
      const gids = new Set(x.ads.map((a) => a.creative_id).filter(Boolean).map(String));
      const hasCopy = x.ads.some((a) => a.name && nameCopies.hasCopySuffix(a.name));
      const bases = new Set(hasCopy ? x.ads.map((a) => nameCopies.baseOf(a.name)) : []);
      const inst = new Map(x.ads.map((a) => [a.id, { id: a.id, name: a.name, created_time: createdOf.get(a.id) || null }]));
      extra.forEach((c) => {
        if ((c.meta_creative_id && gids.has(String(c.meta_creative_id))) || (hasCopy && bases.has(nameCopies.baseOf(c.ad_name)))) inst.set(c.meta_ad_id, { id: c.meta_ad_id, name: c.ad_name, created_time: c.created_time });
      });
      const res = resolveCreativeDate([...inst.values()], { today });
      const earliest = [...inst.values()].map((i) => createdDay(i.created_time)).filter(Boolean).sort()[0] || null;
      list.push({ key: x.key, name: res.original_name || (x.ads[0] && x.ads[0].name) || null, date: res.date, reason: res.reason, conflicts: res.conflicts, created: earliest });
      x.ads.forEach((a) => { if (!byAd.has(a.id)) byAd.set(a.id, { date: res.date, reason: res.reason, conflicts: res.conflicts }); });
    });
    byFamily.set(fk, withDaysSince(summarizeProduct(list), today));
  });
  return { byFamily, byAd };
}

module.exports = { parseCreativeDate, resolveCreativeDate, summarizeProduct, loadLastCreativeDates, NAME_RE, CREATED_TOLERANCE_DAYS };
