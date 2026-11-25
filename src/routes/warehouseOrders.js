'use strict';
// Planning > Shoot Plan > Warehouse Order (v1.9.5). The page asks this route; this route reads the week's samples from the database and asks Tuesday, which places
// the ApparelMagic order (see src/lib/warehouseOrders.js). Nothing here talks to ApparelMagic.
//
//   GET  /api/warehouse-orders?week_start=YYYY-MM-DD[&due_date=YYYY-MM-DD]   what would be ordered now, the week's orders, stock, and whether sending is on
//   POST /api/warehouse-orders/place    { week_start, due_date, fingerprint }  "Send to warehouse": places exactly what the page was shown
//   POST /api/warehouse-orders/check    { week_start, order_id }               looks in ApparelMagic for an order whose outcome wasn't clear
//   POST /api/warehouse-orders/release  { week_start, order_id }               clears one ApparelMagic holds nothing for, so the week can be sent again

const express = require('express');
const wo = require('../lib/warehouseOrders');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeRouter(deps = {}) {
  const router = express.Router();
  // The app's own database, looked up on first use (so tests can pass their own and never need DATABASE_URL).
  const db = deps.db || { query: (...a) => require('../db').pool.query(...a) };
  const call = (action, body) => wo.callTuesday(action, body, deps);
  const who = (req) => (req.user && (req.user.name || req.user.username || req.user.email)) || null;

  // A week that has finished is a read-only record on the page, so it can't be ordered for here either.
  async function weekHasPassed(weekStart) {
    const { rows } = await db.query("SELECT $1::date < date_trunc('week', now())::date AS past", [weekStart]);
    return !!(rows[0] && rows[0].past);
  }

  router.get('/', async (req, res, next) => {
    try {
      const weekStart = req.query.week_start;
      const dueDate = req.query.due_date || null;
      if (!wo.validWeek(weekStart)) return res.status(400).json({ error: 'week_start must be YYYY-MM-DD' });
      if (dueDate && !wo.validDate(dueDate)) return res.status(400).json({ error: 'due_date must be YYYY-MM-DD' });
      const items = await wo.weekItems(db, weekStart);
      const answer = await call('review', { weekStart, items, dueDate });
      res.json({ ...answer, configured: !answer.notConfigured, samples: items.length, week_passed: await weekHasPassed(weekStart) });
    } catch (err) {
      if (err instanceof wo.TuesdayUnreachable) return res.json({ ok: false, configured: true, error: `${err.message}, so the warehouse order can't be shown right now. Try again in a minute.` });
      next(err);
    }
  });

  router.post('/place', async (req, res, next) => {
    const { week_start: weekStart, due_date: dueDate, fingerprint } = req.body || {};
    if (!wo.validWeek(weekStart) || !wo.validDate(dueDate) || typeof fingerprint !== 'string' || !fingerprint) {
      return res.status(400).json({ ok: false, error: 'Choose the needed-by date, then try again.' });
    }
    try {
      if (await weekHasPassed(weekStart)) return res.json({ ok: false, error: 'This week has finished, so nothing more can be ordered for it.' });
      const items = await wo.weekItems(db, weekStart);
      const answer = await call('place', { weekStart, items, dueDate, fingerprint, requestedBy: who(req) });
      res.json(answer);
    } catch (err) {
      // The order may or may not have been placed. Never say "nothing happened": reloading shows what Tuesday recorded.
      if (err instanceof wo.TuesdayUnreachable) return res.json({ ok: false, unknown: true, error: `${err.message}. The order may still have gone through, so don't send it again: reload the page in a minute to see what happened.` });
      next(err);
    }
  });

  for (const action of ['check', 'release']) {
    router.post(`/${action}`, async (req, res, next) => {
      const { week_start: weekStart, order_id: orderId } = req.body || {};
      if (!wo.validWeek(weekStart) || typeof orderId !== 'string' || !UUID_RE.test(orderId)) return res.status(400).json({ ok: false, error: 'Reload the page and try again.' });
      try {
        const body = action === 'release' ? { weekStart, orderId, requestedBy: who(req) } : { weekStart, orderId };
        res.json(await call(action, body));
      } catch (err) {
        if (err instanceof wo.TuesdayUnreachable) return res.json({ ok: false, error: `${err.message}. Nothing was changed. Try again in a minute.` });
        next(err);
      }
    });
  }

  return router;
}

module.exports = makeRouter();
module.exports.makeRouter = makeRouter;
