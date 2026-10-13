// Shared protection for Meta Graph API reads. In-process, memory only (a restart clears it; the real limit lives on Meta's side and is re-detected on the next call).
//
//   1. ONE rate-limit cooldown for every Meta caller (reporting sync, thumbnails, share links, previews): once Meta says "wait", nobody sends more until it has passed.
//   2. PRIORITY: the reporting sync (and the other explicit sync jobs) always wins. While one is running, lower-priority reads (thumbnails, share links) do not call
//      Meta at all, so a page full of covers can never starve or rate-limit the sync that Meta Performance depends on.
//   3. A per-minute BUDGET for lower-priority lookups, so a burst of page views cannot turn into an unbounded number of single-object requests
//      (the multi-id request this replaced counted as one HTTP call; every object is now its own call). Default 120 a minute, META_LOW_PRIORITY_LOOKUPS_PER_MINUTE to change.
//   4. NEGATIVE CACHING for lookups that failed: short-lived and in memory only, never written to the database, so a persistent failure is not retried on every
//      page load, and a failure is never stored as if the object were gone. Transient failures are remembered briefly, ambiguous access failures a little longer, and a failure that
//      keeps happening backs off further each time (1 min, 5, 15, then 1 hour).
//
// Nothing here changes what is asked of Meta or what is returned: it only decides WHETHER to ask now.
const DEFAULT_COOLDOWN_SECONDS = 300; // used only when Meta gave no retry hint with a rate-limit response
const DEFAULT_PER_MINUTE = 120;
// how long a failed read is not asked again, by how many times in a row it has failed (the last value repeats): a persistent failure backs off instead of being retried every minute
const NEG_TTL_MS = { error: [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000], inaccessible: [10 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000] };

const state = { rateLimitedUntil: 0, priority: 0, budgetWindowStart: 0, budgetUsed: 0, negative: new Map() };

const perMinute = () => {
  const n = parseInt(process.env.META_LOW_PRIORITY_LOOKUPS_PER_MINUTE, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PER_MINUTE;
};

// err: a MetaApiError (rateLimited, retryAfterSeconds)
function noteRateLimit(err, now = Date.now()) {
  if (err && err.rateLimited) {
    const seconds = err.retryAfterSeconds || DEFAULT_COOLDOWN_SECONDS;
    state.rateLimitedUntil = Math.max(state.rateLimitedUntil, now + seconds * 1000);
    return true;
  }
  return false;
}
const cooldownSecondsLeft = (now = Date.now()) => Math.max(0, Math.ceil((state.rateLimitedUntil - now) / 1000));
const isCoolingDown = (now = Date.now()) => cooldownSecondsLeft(now) > 0;

// the reporting sync and the explicit sync jobs bracket their work with these
function beginPriority() { state.priority += 1; }
function endPriority() { state.priority = Math.max(0, state.priority - 1); }
const priorityActive = () => state.priority > 0;

// Why a LOWER-priority read must not call Meta right now (null = it may).
function lowPriorityBlock(now = Date.now()) {
  if (isCoolingDown(now)) return { reason: 'cooldown', seconds: cooldownSecondsLeft(now), text: `Meta asked us to wait (${cooldownSecondsLeft(now)} s left); lookups resume afterwards` };
  if (priorityActive()) return { reason: 'sync', seconds: null, text: 'a Meta sync is running; cover lookups resume when it finishes' };
  return null;
}

// How many of `want` lower-priority lookups may go out now (a per-minute window).
function takeBudget(want, now = Date.now(), limit = perMinute()) {
  if (now - state.budgetWindowStart >= 60 * 1000) { state.budgetWindowStart = now; state.budgetUsed = 0; }
  const granted = Math.max(0, Math.min(want, limit - state.budgetUsed));
  state.budgetUsed += granted;
  return granted;
}

// namespace: 'thumb' | 'thumb_large' | 'share' (an id can be asked for under several)
const negKey = (ns, id) => `${ns}:${id}`;
function negativeGet(ns, id, now = Date.now()) {
  const k = negKey(ns, id); const e = state.negative.get(k);
  if (!e) return null;
  if (e.until <= now) return null; // expired: kept (not deleted) so the next failure continues the back-off
  return e;
}
function negativeSet(ns, id, kind, now = Date.now()) {
  if (state.negative.size > 5000) { for (const [k, e] of state.negative) if (e.until + 3600 * 1000 <= now) state.negative.delete(k); if (state.negative.size > 5000) state.negative.clear(); }
  const ladder = NEG_TTL_MS[kind] || NEG_TTL_MS.error;
  const prev = state.negative.get(negKey(ns, id));
  const count = prev && prev.until + 3600 * 1000 > now ? prev.count + 1 : 1; // an old failure (over an hour past its back-off) starts again from the first step
  state.negative.set(negKey(ns, id), { kind, until: now + ladder[Math.min(count, ladder.length) - 1], count });
}
// a success clears the history so the next failure starts from the first step
const negativeClear = (ns, id) => state.negative.delete(negKey(ns, id));

function reset() { state.rateLimitedUntil = 0; state.priority = 0; state.budgetWindowStart = 0; state.budgetUsed = 0; state.negative.clear(); }

module.exports = { noteRateLimit, cooldownSecondsLeft, isCoolingDown, beginPriority, endPriority, priorityActive, lowPriorityBlock, takeBudget, negativeGet, negativeSet, negativeClear, reset, DEFAULT_COOLDOWN_SECONDS, DEFAULT_PER_MINUTE, NEG_TTL_MS };
