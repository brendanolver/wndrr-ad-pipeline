// A full ApparelMagic catalogue crawl is genuinely slow -- confirmed in
// production (demandplanning's migration notes): ~3,800 products / 39 pages,
// several minutes for a full sweep. Fetching that live on every Planning
// request would time out or make every page load unusably slow. This is a
// simple in-memory stale-while-revalidate cache, server-side (this app is a
// long-running Node process, unlike demandplanning's static frontend which
// caches in localStorage): once data exists, a stale entry is served
// immediately while a background refresh happens; only a genuinely cold
// cache (nothing fetched yet since this server started) blocks the request.
// Concurrent requests during a cold start or a refresh share the same
// in-flight fetch rather than each starting their own crawl.

const entries = new Map(); // key -> { data, fetchedAt, inFlight }

function getCached(key, ttlMs, fetchFn) {
  const entry = entries.get(key);
  const now = Date.now();

  if (entry && entry.data && now - entry.fetchedAt < ttlMs) {
    return Promise.resolve(entry.data);
  }

  if (entry && entry.inFlight) {
    // A fetch is already running (cold start, or a prior stale-triggered
    // refresh) -- if we have data, don't wait on it; otherwise we must.
    return entry.data ? Promise.resolve(entry.data) : entry.inFlight;
  }

  const fetchPromise = fetchFn()
    .then((data) => {
      entries.set(key, { data, fetchedAt: Date.now(), inFlight: null });
      return data;
    })
    .catch((err) => {
      const current = entries.get(key);
      if (current && current.data) {
        // Keep serving the old data; just drop the failed in-flight marker.
        entries.set(key, { ...current, inFlight: null });
      } else {
        entries.delete(key);
      }
      throw err;
    });

  entries.set(key, { data: entry?.data ?? null, fetchedAt: entry?.fetchedAt ?? 0, inFlight: fetchPromise });
  return entry?.data ? Promise.resolve(entry.data) : fetchPromise;
}

function cacheStatus(key) {
  const entry = entries.get(key);
  if (!entry) return { hasData: false, fetching: false };
  return { hasData: Boolean(entry.data), fetching: Boolean(entry.inFlight), fetchedAt: entry.fetchedAt || null };
}

module.exports = { getCached, cacheStatus };
